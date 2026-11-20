import express from "express";
import cors from "cors";
import { ObjectId } from "mongodb";
import Stripe from "stripe";

import {
  applications,
  payments,
  stripeEvents,
  tuitions,
  users,
} from "./db.js";
import {
  verifyStudent,
  verifyToken,
  verifyAdmin,
  verifyTutor,
} from "./middleware/auth.js";
import { parseTuitionsQuery } from "./lib/tuitions-query.js";
import { validateAdminUserRole } from "./lib/admin-user-validation.js";
import { validateTuitionApproval } from "./lib/admin-tuition-validation.js";
import { validateProfileUpdate } from "./lib/profile-validation.js";
import {
  validateApplicationDecision,
  validateNewApplication,
} from "./lib/application-validation.js";
import { validateTuitionActivity } from "./lib/tutor-tuition-validation.js";
import {
  getTutorPostUsage,
  validateNewTuition,
} from "./lib/tuition-validation.js";
import {
  getPlanForRole,
  isSubscriptionEntitled,
  resolveSubscriptionPlan,
  validateSubscriptionCheckout,
} from "./lib/billing-validation.js";
import { prioritizeProStudentApplications } from "./lib/application-priority.js";
import { validatePaidInvoice } from "./lib/payment-validation.js";

const app = express();
const PORT = process.env.PORT || 5000;

function toObjectId(value) {
  if (value instanceof ObjectId) {
    return value;
  }

  if (typeof value !== "string" || !ObjectId.isValid(value)) {
    return null;
  }

  return new ObjectId(value);
}

let stripeClient;
let stripeClientKey;

function getStripeClient() {
  const key = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY;

  if (!key) {
    return null;
  }

  if (!stripeClient || stripeClientKey !== key) {
    stripeClient = new Stripe(key);
    stripeClientKey = key;
  }

  return stripeClient;
}

function getStripeErrorDetails(error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  const key = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY;

  return key ? message.split(key).join("[redacted]") : message;
}

function getStripeReferenceId(value) {
  if (typeof value === "string") {
    return value;
  }

  return typeof value?.id === "string" ? value.id : null;
}

async function syncSubscriptionToUser(stripe, event) {
  const subscriptionId = event.data.object?.id;

  if (typeof subscriptionId !== "string") {
    console.error(
      "Ignoring Stripe subscription event without a subscription ID.",
    );
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  return syncSubscriptionRecord(subscription, event.created);
}

async function syncSubscriptionRecord(subscription, eventCreated) {
  const plan = subscription.metadata?.plan;
  const userIdValue = subscription.metadata?.userId;

  if (
    (plan !== "pro_tutor" && plan !== "pro_student") ||
    typeof userIdValue !== "string"
  ) {
    console.warn(
      "Ignoring a Stripe subscription without MentorLagbe metadata.",
    );
    return;
  }

  const priceIds = {
    pro_tutor: process.env.STRIPE_PRO_TUTOR_PRICE_ID,
    pro_student: process.env.STRIPE_PRO_STUDENT_PRICE_ID,
  };

  if (typeof priceIds[plan] !== "string") {
    throw new Error(`Stripe price is not configured for plan "${plan}".`);
  }

  const result = resolveSubscriptionPlan(subscription, priceIds);

  if (result.error) {
    throw new Error(`Stripe price does not match plan "${plan}".`);
  }

  const userId = toObjectId(result.data.userId);
  const customerId = getStripeReferenceId(subscription.customer);

  if (!userId || typeof customerId !== "string") {
    console.error(
      "Ignoring Stripe subscription with invalid user or customer ID.",
    );
    return;
  }

  const user = await users.findOne(
    { _id: userId },
    {
      projection: {
        role: 1,
        stripeSubscriptionId: 1,
        stripeSubscriptionStatus: 1,
        stripeSubscriptionEventCreated: 1,
      },
    },
  );

  if (!user) {
    console.error(
      "Ignoring Stripe subscription for a user that no longer exists.",
    );
    return;
  }

  if (typeof eventCreated !== "number") {
    throw new Error("Stripe subscription event has no creation timestamp.");
  }

  const hasNewerEvent =
    typeof user.stripeSubscriptionEventCreated === "number" &&
    user.stripeSubscriptionEventCreated > eventCreated;
  const hasDifferentActiveSubscription =
    user.stripeSubscriptionId &&
    user.stripeSubscriptionId !== subscription.id &&
    isSubscriptionEntitled(user.stripeSubscriptionStatus);

  if (hasNewerEvent || hasDifferentActiveSubscription) {
    return false;
  }

  const entitled =
    user.role === result.data.role &&
    isSubscriptionEntitled(subscription.status);
  const updateResult = await users.updateOne(
    {
      _id: userId,
      $and: [
        {
          $or: [
            { stripeSubscriptionId: subscription.id },
            {
              stripeSubscriptionStatus: {
                $nin: ["active", "trialing", "past_due"],
              },
            },
            { stripeSubscriptionId: { $exists: false } },
          ],
        },
        {
          $or: [
            { stripeSubscriptionEventCreated: { $lte: eventCreated } },
            { stripeSubscriptionEventCreated: { $exists: false } },
          ],
        },
      ],
    },
    {
      $set: {
        plan: entitled ? "pro" : "free",
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscription.id,
        stripeSubscriptionPlan: result.data.plan,
        stripeSubscriptionStatus: subscription.status,
        stripeSubscriptionEventCreated: eventCreated,
        updatedAt: new Date(),
      },
    },
  );

  if (updateResult.matchedCount === 0) {
    console.warn("Skipped an outdated Stripe subscription update.");
  }

  return updateResult.matchedCount > 0 && entitled;
}

async function recordPaidInvoice(stripe, invoice, eventCreated) {
  const validation = validatePaidInvoice(invoice);

  if (validation.error) {
    throw new Error(validation.error);
  }

  if (!validation.data) {
    return;
  }

  const subscriptionId =
    getStripeReferenceId(invoice.parent?.subscription_details?.subscription) ||
    getStripeReferenceId(invoice.subscription);

  if (!subscriptionId) {
    console.warn("Ignoring a paid Stripe invoice without a subscription.");
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const plan = subscription.metadata?.plan;
  const userId = toObjectId(subscription.metadata?.userId);
  const customerId = getStripeReferenceId(invoice.customer);
  const subscriptionCustomerId = getStripeReferenceId(subscription.customer);
  const priceIds = {
    pro_tutor: process.env.STRIPE_PRO_TUTOR_PRICE_ID,
    pro_student: process.env.STRIPE_PRO_STUDENT_PRICE_ID,
  };

  if (plan !== "pro_tutor" && plan !== "pro_student") {
    console.warn("Ignoring a paid Stripe invoice without MentorLagbe plan metadata.");
    return;
  }

  if (typeof priceIds[plan] !== "string") {
    throw new Error(`Stripe price is not configured for plan "${plan}".`);
  }

  const resolvedPlan = resolveSubscriptionPlan(subscription, priceIds);

  if (resolvedPlan.error) {
    throw new Error(`Stripe price does not match plan "${plan}".`);
  }

  if (
    !userId ||
    !customerId ||
    customerId !== subscriptionCustomerId ||
    resolvedPlan.data.userId !== userId.toString()
  ) {
    console.warn("Ignoring a paid Stripe invoice with mismatched account details.");
    return;
  }

  const user = await users.findOne(
    { _id: userId, stripeCustomerId: customerId },
    { projection: { _id: 1 } },
  );

  if (!user) {
    console.warn("Ignoring a paid Stripe invoice for an unknown MentorLagbe account.");
    return;
  }

  await syncSubscriptionRecord(subscription, eventCreated);

  const paidAt = invoice.status_transitions?.paid_at ?? eventCreated;

  if (typeof paidAt !== "number") {
    throw new Error("Stripe paid invoice has no payment timestamp.");
  }

  await payments.updateOne(
    { _id: validation.data.invoiceId },
    {
      $setOnInsert: {
        _id: validation.data.invoiceId,
        userId,
        plan,
        subscriptionId,
        customerId,
        amountMinor: validation.data.amountMinor,
        currency: validation.data.currency,
        status: "paid",
        invoiceUrl: invoice.hosted_invoice_url ?? null,
        createdAt: new Date(paidAt * 1000),
      },
    },
    { upsert: true },
  );
}

async function handleStripeWebhook(req, res) {
  const stripe = getStripeClient();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = req.headers["stripe-signature"];

  if (!stripe || !webhookSecret) {
    return res
      .status(503)
      .send({ message: "Stripe webhooks are not configured on the server." });
  }

  if (!Buffer.isBuffer(req.body) || typeof signature !== "string") {
    return res.status(400).send({ message: "Invalid Stripe webhook request." });
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch {
    return res
      .status(400)
      .send({ message: "Invalid Stripe webhook signature." });
  }

  try {
    const existingEvent = await stripeEvents.findOne({ _id: event.id });

    if (existingEvent?.status === "processed") {
      return res.send({ received: true });
    }

    if (!existingEvent) {
      await stripeEvents.insertOne({
        _id: event.id,
        status: "processing",
        createdAt: new Date(),
      });
    }
  } catch (error) {
    if (error?.code === 11000) {
      return res
        .status(500)
        .send({ message: "Stripe webhook processing is still in progress." });
    }

    console.error(
      "Failed to record Stripe webhook:",
      getStripeErrorDetails(error),
    );
    return res
      .status(500)
      .send({ message: "Unable to process the Stripe webhook." });
  }

  try {
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      await syncSubscriptionToUser(stripe, event);
    } else if (event.type === "invoice.paid") {
      await recordPaidInvoice(stripe, event.data.object, event.created);
    }

    await stripeEvents.updateOne(
      { _id: event.id },
      { $set: { status: "processed", processedAt: new Date() } },
    );

    return res.send({ received: true });
  } catch (error) {
    try {
      await stripeEvents.deleteOne({ _id: event.id, status: "processing" });
    } catch (cleanupError) {
      console.error(
        "Failed to clean up Stripe webhook state:",
        getStripeErrorDetails(cleanupError),
      );
    }

    console.error(
      "Failed to process Stripe webhook:",
      getStripeErrorDetails(error),
    );
    return res
      .status(500)
      .send({ message: "Unable to process the Stripe webhook." });
  }
}

// middleware
app.use(cors());
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  handleStripeWebhook,
);
app.use(express.json());

app.get("/", (req, res) => {
  res.send("MentorLagbe API is running");
});

app.get("/api/health", (req, res) => {
  res.send({ status: "ok" });
});

app.get("/api/public/stats", async (req, res) => {
  try {
    const activeTuitionFilter = {
      approvalStatus: "approved",
      isActive: true,
    };
    const [tutors, activeTuitions, subjectNames, acceptedApplications] =
      await Promise.all([
        users.countDocuments({ role: "tutor" }),
        tuitions.countDocuments(activeTuitionFilter),
        tuitions.distinct("subject", activeTuitionFilter),
        applications.countDocuments({ status: "accepted" }),
      ]);

    return res.send({
      tutors,
      activeTuitions,
      subjects: subjectNames.length,
      acceptedApplications,
    });
  } catch (error) {
    console.error("Failed to fetch public platform statistics:", error);
    return res
      .status(500)
      .send({ message: "Unable to load platform statistics." });
  }
});

app.post("/api/billing/checkout", verifyToken, async (req, res) => {
  const { data, error, status } = validateSubscriptionCheckout(
    req.user.role,
    req.body,
  );

  if (error) {
    return res.status(status || 400).send({ message: error });
  }

  if (req.user.plan === "pro") {
    return res.status(409).send({
      message: "You already have Pro. Use the billing portal to manage it.",
    });
  }

  const stripe = getStripeClient();
  const priceId = process.env[data.priceEnv];

  if (!stripe || !priceId) {
    return res.status(503).send({
      message: "Stripe subscriptions are not configured on the server.",
    });
  }

  try {
    let customerId = req.user.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create(
        {
          email: req.user.email,
          name: req.user.name,
          metadata: { userId: req.user._id.toString() },
        },
        { idempotencyKey: `mentorlagbe-customer-${req.user._id}` },
      );
      customerId = customer.id;
      await users.updateOne(
        { _id: req.user._id },
        { $set: { stripeCustomerId: customerId } },
      );
    }

    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
    });
    const hasCurrentSubscription = subscriptions.data.some((subscription) =>
      isSubscriptionEntitled(subscription.status),
    );

    if (hasCurrentSubscription) {
      return res.status(409).send({
        message: "You already have an active subscription to manage.",
      });
    }

    const clientUrl = (
      process.env.CLIENT_URL || "http://localhost:3000"
    ).replace(/\/+$/, "");
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: req.user._id.toString(),
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        plan: data.plan,
        userId: req.user._id.toString(),
      },
      subscription_data: {
        metadata: {
          plan: data.plan,
          userId: req.user._id.toString(),
        },
      },
      success_url: `${clientUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/payment/cancel`,
    });

    if (!session.url) {
      return res
        .status(502)
        .send({ message: "Stripe did not return a checkout URL." });
    }

    return res.send({ url: session.url });
  } catch (error) {
    console.error(
      "Failed to create Stripe Checkout session:",
      getStripeErrorDetails(error),
    );
    return res
      .status(502)
      .send({ message: "Unable to start checkout. Please try again." });
  }
});

app.post("/api/billing/checkout/verify", verifyToken, async (req, res) => {
  const sessionId = req.body?.sessionId;

  if (typeof sessionId !== "string" || !sessionId.startsWith("cs_")) {
    return res.status(400).send({ message: "A valid Checkout Session is required." });
  }

  const stripe = getStripeClient();

  if (!stripe) {
    return res.status(503).send({
      message: "Stripe subscriptions are not configured on the server.",
    });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const userId = req.user._id.toString();
    const customerId = getStripeReferenceId(session.customer);
    const subscriptionId = getStripeReferenceId(session.subscription);

    if (
      session.client_reference_id !== userId ||
      session.metadata?.userId !== userId ||
      !req.user.stripeCustomerId ||
      customerId !== req.user.stripeCustomerId
    ) {
      return res.status(404).send({ message: "Checkout Session not found." });
    }

    if (session.status !== "complete" || session.payment_status !== "paid") {
      return res.status(409).send({
        message: "Stripe has not confirmed this payment yet. Please try again.",
      });
    }

    if (!subscriptionId) {
      return res.status(409).send({
        message: "The subscription is not available yet. Please try again.",
      });
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const expectedPlan = session.metadata?.plan;
    const subscriptionCustomerId = getStripeReferenceId(subscription.customer);

    if (
      subscription.metadata?.userId !== userId ||
      subscription.metadata?.plan !== expectedPlan ||
      customerId !== subscriptionCustomerId
    ) {
      return res.status(404).send({ message: "Checkout Session not found." });
    }

    const priceIds = {
      pro_tutor: process.env.STRIPE_PRO_TUTOR_PRICE_ID,
      pro_student: process.env.STRIPE_PRO_STUDENT_PRICE_ID,
    };

    if (expectedPlan !== "pro_tutor" && expectedPlan !== "pro_student") {
      return res.status(404).send({ message: "Checkout Session not found." });
    }

    if (typeof priceIds[expectedPlan] !== "string") {
      throw new Error(`Stripe price is not configured for plan "${expectedPlan}".`);
    }

    const resolvedPlan = resolveSubscriptionPlan(subscription, priceIds);

    if (
      resolvedPlan.error ||
      resolvedPlan.data.userId !== userId ||
      resolvedPlan.data.plan !== expectedPlan
    ) {
      return res.status(404).send({ message: "Checkout Session not found." });
    }

    const synced = await syncSubscriptionRecord(
      subscription,
      Math.floor(Date.now() / 1000),
    );

    if (!synced) {
      return res.status(409).send({
        message: "The subscription could not be activated. Please contact support.",
      });
    }

    const invoiceId =
      getStripeReferenceId(session.invoice) ||
      getStripeReferenceId(subscription.latest_invoice);

    if (!invoiceId) {
      return res.status(409).send({
        message: "Payment is confirmed; the invoice is still being prepared.",
      });
    }

    const invoice = await stripe.invoices.retrieve(invoiceId);

    if (invoice.status !== "paid") {
      return res.status(409).send({
        message: "Stripe has not confirmed the invoice yet. Please try again.",
      });
    }

    await recordPaidInvoice(stripe, invoice, Math.floor(Date.now() / 1000));

    return res.send({ verified: true, plan: expectedPlan });
  } catch (error) {
    console.error(
      "Failed to verify Stripe Checkout session:",
      getStripeErrorDetails(error),
    );
    return res
      .status(502)
      .send({ message: "Unable to verify payment. Please try again." });
  }
});

app.post("/api/billing/portal", verifyToken, async (req, res) => {
  const stripe = getStripeClient();

  if (!stripe) {
    return res.status(503).send({
      message: "Stripe subscriptions are not configured on the server.",
    });
  }

  if (!req.user.stripeCustomerId) {
    return res
      .status(409)
      .send({ message: "No Stripe subscription is linked to this account." });
  }

  try {
    const clientUrl = (
      process.env.CLIENT_URL || "http://localhost:3000"
    ).replace(/\/+$/, "");
    const portal = await stripe.billingPortal.sessions.create({
      customer: req.user.stripeCustomerId,
      return_url: `${clientUrl}/dashboard`,
    });

    return res.send({ url: portal.url });
  } catch (error) {
    console.error(
      "Failed to create Stripe billing portal session:",
      getStripeErrorDetails(error),
    );
    return res
      .status(502)
      .send({ message: "Unable to open billing settings. Please try again." });
  }
});

app.get("/api/admin/users", verifyToken, verifyAdmin, async (req, res) => {
    try {
      const userRows = await users
        .find(
          { role: { $in: ["student", "tutor"] } },
          {
            projection: {
              _id: 1,
              name: 1,
              email: 1,
              role: 1,
              plan: 1,
            stripeSubscriptionPlan: 1,
              image: 1,
            },
          },
        )
        .sort({ name: 1, _id: 1 })
        .toArray();

      return res.send({
        users: userRows.map((user) => ({
          id: user._id.toString(),
          name: user.name,
          email: user.email,
          role: user.role,
        plan: getPlanForRole(user, user.role),
          image: user.image ?? null,
        })),
      });
    } catch (error) {
      console.error("Failed to fetch admin users:", error);
      return res.status(500).send({ message: "Unable to load users." });
    }
});

app.patch(
  "/api/admin/users/:id/role",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const { data, error } = validateAdminUserRole(req.params.id, req.body);

    if (error) {
      return res.status(400).send({ message: error });
    }

    try {
      const userId = new ObjectId(data.id);
        const user = await users.findOne(
          { _id: userId },
        {
          projection: {
            role: 1,
            stripeSubscriptionPlan: 1,
            stripeSubscriptionStatus: 1,
          },
        },
        );

        if (!user) {
          return res.status(404).send({ message: "User not found." });
        }

      if (user.role === "admin") {
        return res
          .status(409)
          .send({ message: "Admin account roles cannot be changed." });
      }

      const newRolePlan = data.role === "tutor" ? "pro_tutor" : "pro_student";

      if (
        isSubscriptionEntitled(user.stripeSubscriptionStatus) &&
        user.stripeSubscriptionPlan !== newRolePlan
      ) {
        return res.status(409).send({
          message:
            "Cancel the current subscription before changing this account's role.",
        });
      }

      const result = await users.updateOne(
        {
          _id: userId,
          role: { $in: ["student", "tutor"] },
          $or: [
            {
              stripeSubscriptionStatus: {
                $nin: ["active", "trialing", "past_due"],
              },
            },
            { stripeSubscriptionPlan: newRolePlan },
          ],
        },
        { $set: { role: data.role, updatedAt: new Date() } },
      );

      if (result.matchedCount === 0) {
        return res.status(409).send({
          message:
            "The account changed before the role update. Please try again.",
        });
      }

      return res.send({ id: data.id, role: data.role });
    } catch (error) {
      console.error("Failed to update admin user role:", error);
      return res.status(500).send({ message: "Unable to update user role." });
    }
  },
);

app.get("/api/admin/dashboard", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [
      totalUsers,
      totalTutors,
      pendingTuitions,
      approvedTuitions,
      revenue,
    ] = await Promise.all([
      users.countDocuments({}),
      users.countDocuments({ role: "tutor" }),
      tuitions.countDocuments({ approvalStatus: "pending" }),
      tuitions.countDocuments({ approvalStatus: "approved" }),
      payments
        .aggregate([
          { $match: { status: "paid" } },
          {
            $group: {
              _id: "$currency",
              amountMinor: { $sum: "$amountMinor" },
              paymentCount: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray(),
    ]);

    return res.send({
      totalUsers,
      totalTutors,
      pendingTuitions,
      approvedTuitions,
      revenue: revenue.map((total) => ({
        currency: total._id,
        amountMinor: total.amountMinor,
        paymentCount: total.paymentCount,
      })),
    });
  } catch (error) {
    console.error("Failed to fetch admin dashboard summary:", error);
    return res
      .status(500)
      .send({ message: "Unable to load admin dashboard statistics." });
  }
});

app.get(
  "/api/admin/transactions",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const paymentRows = await payments
        .find(
          { status: "paid" },
          {
            projection: {
              _id: 1,
              userId: 1,
              plan: 1,
              amountMinor: 1,
              currency: 1,
              createdAt: 1,
              invoiceUrl: 1,
            },
          },
        )
        .sort({ createdAt: -1, _id: -1 })
        .limit(100)
        .toArray();
      const userIds = paymentRows
        .map((payment) => toObjectId(payment.userId))
        .filter(Boolean);
      const customerRows = userIds.length
        ? await users
            .find(
              { _id: { $in: userIds } },
              { projection: { _id: 1, name: 1, email: 1 } },
            )
            .toArray()
        : [];
      const customersById = new Map(
        customerRows.map((customer) => [customer._id.toString(), customer]),
      );

      return res.send({
        transactions: paymentRows.map((payment) => {
          const userId = toObjectId(payment.userId)?.toString();
          const customer = userId ? customersById.get(userId) : undefined;

          return {
            id: payment._id,
            plan: payment.plan,
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            status: "paid",
            createdAt: payment.createdAt.toISOString(),
            invoiceUrl: payment.invoiceUrl ?? null,
            customer: customer
              ? { name: customer.name ?? null, email: customer.email ?? null }
              : null,
          };
        }),
      });
    } catch (error) {
      console.error("Failed to fetch admin transactions:", error);
      return res
        .status(500)
        .send({ message: "Unable to load transactions." });
    }
  },
);

app.get(
  "/api/applications/mine",
  verifyToken,
  verifyStudent,
  async (req, res) => {
    try {
      const applicationRows = await applications
        .find(
          { studentId: req.user._id },
          {
            projection: {
              _id: 1,
              tuitionId: 1,
              status: 1,
              phone: 1,
              preferredSchedule: 1,
              note: 1,
              createdAt: 1,
            },
          },
        )
        .sort({ createdAt: -1, _id: -1 })
        .toArray();
      const tuitionIds = [
        ...new Map(
          applicationRows
            .map((application) => toObjectId(application.tuitionId))
            .filter(Boolean)
            .map((id) => [id.toString(), id]),
        ).values(),
      ];
      const tuitionRows = tuitionIds.length
        ? await tuitions
            .find(
              { _id: { $in: tuitionIds } },
              {
                projection: {
                  _id: 1,
                  title: 1,
                  subject: 1,
                  classLevel: 1,
                  monthlyFee: 1,
                  tutorId: 1,
                  approvalStatus: 1,
                  isActive: 1,
                },
              },
            )
            .toArray()
        : [];
      const tutorIds = tuitionRows
        .map((tuition) => toObjectId(tuition.tutorId))
        .filter(Boolean);
      const tutorRows = tutorIds.length
        ? await users
            .find(
              { _id: { $in: tutorIds }, role: "tutor" },
              { projection: { _id: 1, name: 1, image: 1 } },
            )
            .toArray()
        : [];
      const tutorsById = new Map(
        tutorRows.map((tutor) => [tutor._id.toString(), tutor]),
      );
      const tuitionsById = new Map(
        tuitionRows.map((tuition) => {
          const tutorId = toObjectId(tuition.tutorId)?.toString();
          const tutor = tutorId ? tutorsById.get(tutorId) : undefined;

          return [
            tuition._id.toString(),
            {
              id: tuition._id.toString(),
              title: tuition.title,
              subject: tuition.subject,
              classLevel: tuition.classLevel,
              monthlyFee: tuition.monthlyFee,
              isPublic:
                tuition.approvalStatus === "approved" && tuition.isActive,
              tutor: tutor
                ? { name: tutor.name, image: tutor.image ?? null }
                : null,
            },
          ];
        }),
      );

      return res.send({
        applications: applicationRows.map((application) => {
          const tuitionId = toObjectId(application.tuitionId)?.toString();
          const createdAt = new Date(application.createdAt);

          return {
            id: application._id.toString(),
            status: application.status,
            phone: application.phone,
            preferredSchedule: application.preferredSchedule,
            note: application.note ?? "",
            createdAt: createdAt.toISOString(),
            tuition: tuitionId ? (tuitionsById.get(tuitionId) ?? null) : null,
          };
        }),
      });
    } catch (error) {
      console.error("Failed to fetch student applications:", error);
      return res
        .status(500)
        .send({ message: "Unable to load your applications." });
    }
  },
);

app.delete(
  "/api/applications/:id",
  verifyToken,
  verifyStudent,
  async (req, res) => {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
      return res.status(400).send({ message: "Invalid application ID." });
    }

    const applicationId = new ObjectId(req.params.id);

    try {
      const result = await applications.deleteOne({
        _id: applicationId,
        studentId: req.user._id,
        status: "pending",
      });

      if (result.deletedCount === 0) {
        const application = await applications.findOne(
          { _id: applicationId, studentId: req.user._id },
          { projection: { status: 1 } },
        );

        if (!application) {
          return res.status(404).send({ message: "Application not found." });
        }

        return res.status(409).send({
          message: "Only pending applications can be cancelled.",
        });
      }

      return res.send({ id: req.params.id, cancelled: true });
    } catch (error) {
      console.error("Failed to cancel student application:", error);
      return res
        .status(500)
        .send({ message: "Unable to cancel this application." });
    }
  },
);

app.patch(
  "/api/applications/:id/status",
  verifyToken,
  verifyTutor,
  async (req, res) => {
    const { data, error } = validateApplicationDecision(
      req.params.id,
      req.body,
    );

    if (error) {
      return res.status(400).send({ message: error });
    }

    try {
      const tutorTuitions = await tuitions
        .find({ tutorId: req.user._id }, { projection: { _id: 1 } })
        .toArray();
      const tuitionIds = tutorTuitions.map((tuition) => tuition._id);

      if (tuitionIds.length === 0) {
        return res.status(404).send({ message: "Application not found." });
      }

      const ownershipFilter = {
        _id: new ObjectId(data.id),
        tuitionId: { $in: tuitionIds },
      };
      const result = await applications.updateOne(
        { ...ownershipFilter, status: "pending" },
        { $set: { status: data.status, updatedAt: new Date() } },
      );

      if (result.matchedCount === 0) {
        const application = await applications.findOne(ownershipFilter, {
          projection: { status: 1 },
        });

        if (!application) {
          return res.status(404).send({ message: "Application not found." });
        }

        return res
          .status(409)
          .send({ message: "Only pending applications can be reviewed." });
      }

      return res.send({ id: data.id, status: data.status });
    } catch (error) {
      console.error("Failed to update applicant status:", error);
      return res
        .status(500)
        .send({ message: "Unable to update this applicant." });
    }
  },
);

app.get("/api/tutor/dashboard", verifyToken, verifyTutor, async (req, res) => {
    try {
      const tuitionRows = await tuitions
        .find(
          { tutorId: req.user._id },
          {
            projection: {
              _id: 1,
              title: 1,
              approvalStatus: 1,
              isActive: 1,
            },
          },
        )
        .toArray();
      const tuitionIds = tuitionRows.map((tuition) => tuition._id);
      const applicantsCount = tuitionIds.length
        ? await applications.countDocuments({
            tuitionId: { $in: tuitionIds },
          })
        : 0;
      const latestApplications = tuitionIds.length
        ? await applications
          .aggregate([
            { $match: { tuitionId: { $in: tuitionIds } } },
              {
              $lookup: {
                from: "user",
                localField: "studentId",
                foreignField: "_id",
                as: "student",
              },
            },
            {
              $unwind: {
                path: "$student",
                preserveNullAndEmptyArrays: true,
              },
            },
            {
              $addFields: {
                studentPlanPriority: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ["$student.plan", "pro"] },
                        {
                          $eq: [
                            "$student.stripeSubscriptionPlan",
                            "pro_student",
                          ],
                        },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
            {
              $sort: {
                studentPlanPriority: -1,
                createdAt: -1,
                _id: -1,
              },
            },
            { $limit: 3 },
            {
              $project: {
                  _id: 1,
                  tuitionId: 1,
                  status: 1,
                student: {
                  name: "$student.name",
                  image: "$student.image",
                  plan: "$student.plan",
                  stripeSubscriptionPlan: "$student.stripeSubscriptionPlan",
                },
              },
            },
          ])
            .toArray()
        : [];
      const tuitionsById = new Map(
        tuitionRows.map((tuition) => [tuition._id.toString(), tuition]),
      );

      return res.send({
        tuitionsPosted: tuitionRows.length,
        activeApproved: tuitionRows.filter(
          (tuition) =>
            tuition.approvalStatus === "approved" && tuition.isActive === true,
        ).length,
        applicantsCount,
        latestApplicants: latestApplications.map((application) => {
          const tuitionId = toObjectId(application.tuitionId)?.toString();
        const tuition = tuitionId ? tuitionsById.get(tuitionId) : undefined;

          return {
            id: application._id.toString(),
          student: application.student?.name
            ? {
                name: application.student.name,
                image: application.student.image ?? null,
                plan: getPlanForRole(application.student, "student"),
              }
              : null,
            tuitionTitle: tuition?.title ?? "Tuition unavailable",
            status: application.status,
          };
        }),
      });
    } catch (error) {
      console.error("Failed to fetch tutor dashboard summary:", error);
      return res
        .status(500)
        .send({ message: "Unable to load your tutor dashboard." });
    }
});

app.get(
  "/api/tuitions/mine/usage",
  verifyToken,
  verifyTutor,
  async (req, res) => {
    try {
      const postsUsed = await tuitions.countDocuments({
        tutorId: req.user._id,
      });

      return res.send(
        getTutorPostUsage(getPlanForRole(req.user, "tutor"), postsUsed),
      );
    } catch (error) {
      console.error("Failed to get tutor tuition usage:", error);
      return res
        .status(500)
        .send({ message: "Unable to load your tuition posting limit." });
    }
  },
);

app.get(
  "/api/tutor/applications",
  verifyToken,
  verifyTutor,
  async (req, res) => {
    try {
      const tuitionRows = await tuitions
        .find(
          { tutorId: req.user._id },
          { projection: { _id: 1, title: 1, subject: 1 } },
        )
        .toArray();
      const tuitionIds = tuitionRows.map((tuition) => tuition._id);
      const applicationRows = tuitionIds.length
        ? await applications
            .find(
              { tuitionId: { $in: tuitionIds } },
              {
                projection: {
                  _id: 1,
                  tuitionId: 1,
                  studentId: 1,
                  status: 1,
                  phone: 1,
                  preferredSchedule: 1,
                  note: 1,
                  createdAt: 1,
                },
              },
            )
            .sort({ createdAt: -1, _id: -1 })
            .toArray()
        : [];
      const studentIds = applicationRows
        .map((application) => toObjectId(application.studentId))
        .filter(Boolean);
      const studentRows = studentIds.length
        ? await users
            .find(
              { _id: { $in: studentIds }, role: "student" },
              {
                projection: {
                  _id: 1,
                  name: 1,
                  email: 1,
                  image: 1,
                  plan: 1,
                  stripeSubscriptionPlan: 1,
                },
              },
            )
            .toArray()
        : [];
      const studentsById = new Map(
        studentRows.map((student) => [student._id.toString(), student]),
      );
      const tuitionsById = new Map(
        tuitionRows.map((tuition) => [tuition._id.toString(), tuition]),
      );

      const formattedApplications = applicationRows.map((application) => {
          const studentId = toObjectId(application.studentId)?.toString();
        const student = studentId ? studentsById.get(studentId) : undefined;
          const tuitionId = toObjectId(application.tuitionId)?.toString();
        const tuition = tuitionId ? tuitionsById.get(tuitionId) : undefined;

          return {
            id: application._id.toString(),
            status: application.status,
            phone: application.phone,
            preferredSchedule: application.preferredSchedule,
            note: application.note ?? "",
            createdAt: new Date(application.createdAt).toISOString(),
            student: student
              ? {
                  name: student.name,
                  email: student.email,
                  image: student.image ?? null,
                plan: getPlanForRole(student, "student"),
                }
              : null,
            tuition: tuition
              ? {
                  id: tuition._id.toString(),
                  title: tuition.title,
                  subject: tuition.subject,
                }
              : null,
          };
      });

      return res.send({
        applications: prioritizeProStudentApplications(formattedApplications),
      });
    } catch (error) {
      console.error("Failed to fetch tutor applications:", error);
      return res
        .status(500)
        .send({ message: "Unable to load your applicants." });
    }
  },
);

app.get("/api/tuitions/mine", verifyToken, verifyTutor, async (req, res) => {
  try {
    const tuitionRows = await tuitions
      .find(
        { tutorId: req.user._id },
        {
          projection: {
            _id: 1,
            title: 1,
            subject: 1,
            classLevel: 1,
            mode: 1,
            location: 1,
            monthlyFee: 1,
            daysPerWeek: 1,
            description: 1,
            bannerImage: 1,
            approvalStatus: 1,
            isActive: 1,
            createdAt: 1,
          },
        },
      )
      .sort({ createdAt: -1, _id: -1 })
      .toArray();

    return res.send({
      tuitions: tuitionRows.map((tuition) => ({
        id: tuition._id.toString(),
        title: tuition.title,
        subject: tuition.subject,
        classLevel: tuition.classLevel,
        mode: tuition.mode,
        location: tuition.location,
        monthlyFee: tuition.monthlyFee,
        daysPerWeek: tuition.daysPerWeek,
        description: tuition.description,
        bannerImage: tuition.bannerImage ?? null,
        approvalStatus: tuition.approvalStatus,
        isActive: tuition.isActive === true,
        createdAt: new Date(tuition.createdAt).toISOString(),
      })),
    });
  } catch (error) {
    console.error("Failed to fetch tutor tuitions:", error);
    return res.status(500).send({ message: "Unable to load your tuitions." });
  }
});

// Public listings only include approved, active tuitions.
app.get("/api/tuitions", async (req, res) => {
  const parsedQuery = parseTuitionsQuery(req.query);

  if (parsedQuery.error) {
    return res.status(400).send({ message: parsedQuery.error });
  }

  try {
    const totalItems = await tuitions.countDocuments(parsedQuery.filter);
    const totalPages = Math.ceil(totalItems / parsedQuery.pageSize);
    const currentPage =
      totalPages === 0 ? 1 : Math.min(parsedQuery.page, totalPages);
    const skip =
      currentPage === parsedQuery.page
        ? parsedQuery.skip
        : (currentPage - 1) * parsedQuery.pageSize;

    const tuitionRows = await tuitions
      .find(parsedQuery.filter, {
        projection: {
          _id: 1,
          title: 1,
          subject: 1,
          classLevel: 1,
          mode: 1,
          location: 1,
          monthlyFee: 1,
          daysPerWeek: 1,
          bannerImage: 1,
          tutorId: 1,
          createdAt: 1,
        },
      })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(parsedQuery.pageSize)
      .toArray();

    const tutorIds = tuitionRows
      .map((tuition) => toObjectId(tuition.tutorId))
      .filter(Boolean);

    const tutors = tutorIds.length
      ? await users
          .find(
            { _id: { $in: tutorIds }, role: "tutor" },
            { projection: { _id: 1, name: 1, image: 1, plan: 1 } },
          )
          .toArray()
      : [];
    const tutorsById = new Map(
      tutors.map((tutor) => [tutor._id.toString(), tutor]),
    );

    return res.send({
      tuitions: tuitionRows.map((tuition) => {
        const tutorId =
          toObjectId(tuition.tutorId)?.toString() ?? tuition.tutorId;
        const tutor =
          typeof tutorId === "string" ? tutorsById.get(tutorId) : undefined;

        return {
          id: tuition._id.toString(),
          title: tuition.title,
          subject: tuition.subject,
          classLevel: tuition.classLevel,
          mode: tuition.mode,
          location: tuition.location,
          monthlyFee: tuition.monthlyFee,
          daysPerWeek: tuition.daysPerWeek,
          bannerImage: tuition.bannerImage ?? null,
          createdAt: tuition.createdAt,
          tutor: tutor
            ? {
                name: tutor.name,
                image: tutor.image ?? null,
                plan: tutor.plan,
              }
            : null,
        };
      }),
      pagination: {
        currentPage,
        pageSize: parsedQuery.pageSize,
        totalItems,
        totalPages,
      },
    });
  } catch (error) {
    console.error("Failed to fetch public tuitions:", error);
    return res.status(500).send({ message: "Unable to load public tuitions." });
  }
});

app.get("/api/tuitions/:id", async (req, res) => {
  const tuitionId = toObjectId(req.params.id);

  if (!tuitionId || !/^[a-f\d]{24}$/i.test(req.params.id)) {
    return res.status(404).send({ message: "Tuition not found." });
  }

  try {
    const tuition = await tuitions.findOne({
      _id: tuitionId,
      approvalStatus: "approved",
      isActive: true,
    });

    if (!tuition) {
      return res.status(404).send({ message: "Tuition not found." });
    }

    const tutorId = toObjectId(tuition.tutorId);
    const tutor = tutorId
      ? await users.findOne(
          { _id: tutorId, role: "tutor" },
          { projection: { _id: 1, name: 1, image: 1, plan: 1 } },
        )
      : null;

    return res.send({
      id: tuition._id.toString(),
      title: tuition.title,
      subject: tuition.subject,
      classLevel: tuition.classLevel,
      mode: tuition.mode,
      location: tuition.location,
      monthlyFee: tuition.monthlyFee,
      daysPerWeek: tuition.daysPerWeek,
      description: tuition.description,
      bannerImage: tuition.bannerImage ?? null,
      createdAt: tuition.createdAt,
      tutor: tutor
        ? {
            name: tutor.name,
            image: tutor.image ?? null,
            plan: tutor.plan === "pro" ? "pro" : "free",
          }
        : null,
    });
  } catch (error) {
    console.error("Failed to fetch tuition details:", error);
    return res.status(500).send({ message: "Unable to load tuition details." });
  }
});

app.post(
  "/api/tuitions/:id/applications",
  verifyToken,
  verifyStudent,
  async (req, res) => {
    const { data, error } = validateNewApplication(req.params.id, req.body);

    if (error) {
      return res.status(400).send({ message: error });
    }

    try {
      const tuitionId = new ObjectId(data.tuitionId);
      const tuition = await tuitions.findOne({
        _id: tuitionId,
        approvalStatus: "approved",
        isActive: true,
      });

      if (!tuition) {
        return res.status(404).send({ message: "Tuition not found." });
      }

      const existingApplication = await applications.findOne({
        tuitionId,
        studentId: req.user._id,
      });

      if (existingApplication) {
        return res
          .status(409)
          .send({ message: "You have already applied to this tuition." });
      }

      const now = new Date();
      const application = {
        ...data,
        tuitionId,
        studentId: req.user._id,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      const result = await applications.insertOne(application);

      return res.status(201).send({
        id: result.insertedId.toString(),
        tuitionId: tuitionId.toString(),
        status: application.status,
        createdAt: now,
      });
    } catch (error) {
      console.error("Failed to submit tuition application:", error);
      return res
        .status(500)
        .send({ message: "Unable to submit your application." });
    }
  },
);

app.get(
  "/api/admin/tuitions/pending",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const tuitionRows = await tuitions
        .find(
          { approvalStatus: "pending" },
          {
            projection: {
              _id: 1,
              title: 1,
              subject: 1,
              classLevel: 1,
              mode: 1,
              location: 1,
              monthlyFee: 1,
              daysPerWeek: 1,
              description: 1,
              bannerImage: 1,
              tutorId: 1,
              createdAt: 1,
            },
          },
        )
        .sort({ createdAt: 1, _id: 1 })
        .toArray();

      const tutorIds = tuitionRows
        .map((tuition) => toObjectId(tuition.tutorId))
        .filter(Boolean);
      const tutors = tutorIds.length
        ? await users
            .find(
              { _id: { $in: tutorIds }, role: "tutor" },
              { projection: { _id: 1, name: 1, email: 1, image: 1 } },
            )
            .toArray()
        : [];
      const tutorsById = new Map(
        tutors.map((tutor) => [tutor._id.toString(), tutor]),
      );

      return res.send({
        tuitions: tuitionRows.map((tuition) => {
          const tutorId = toObjectId(tuition.tutorId)?.toString();
          const tutor = tutorId ? tutorsById.get(tutorId) : undefined;

          return {
            id: tuition._id.toString(),
            title: tuition.title,
            subject: tuition.subject,
            classLevel: tuition.classLevel,
            mode: tuition.mode,
            location: tuition.location,
            monthlyFee: tuition.monthlyFee,
            daysPerWeek: tuition.daysPerWeek,
            description: tuition.description,
            bannerImage: tuition.bannerImage ?? null,
            createdAt: tuition.createdAt,
            tutor: tutor
              ? {
                  name: tutor.name,
                  email: tutor.email,
                  image: tutor.image ?? null,
                }
              : null,
          };
        }),
      });
    } catch (error) {
      console.error("Failed to fetch pending tuition approvals:", error);
      return res
        .status(500)
        .send({ message: "Unable to load pending tuition approvals." });
    }
  },
);

app.patch(
  "/api/admin/tuitions/:id/approval",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const { data, error } = validateTuitionApproval(req.params.id, req.body);

    if (error) {
      return res.status(400).send({ message: error });
    }

    try {
      const result = await tuitions.updateOne(
        { _id: new ObjectId(data.id), approvalStatus: "pending" },
        {
          $set: {
            approvalStatus: data.approvalStatus,
            updatedAt: new Date(),
          },
        },
      );

      if (result.matchedCount === 0) {
        const tuition = await tuitions.findOne(
          { _id: new ObjectId(data.id) },
          { projection: { approvalStatus: 1 } },
        );

        if (!tuition) {
          return res.status(404).send({ message: "Tuition not found." });
        }

        return res
          .status(409)
          .send({ message: "This tuition has already been reviewed." });
      }

      return res.send({
        id: data.id,
        approvalStatus: data.approvalStatus,
      });
    } catch (error) {
      console.error("Failed to update tuition approval:", error);
      return res
        .status(500)
        .send({ message: "Unable to update this tuition approval." });
    }
  },
);

app.patch(
  "/api/tuitions/:id/activity",
  verifyToken,
  verifyTutor,
  async (req, res) => {
    const { data, error } = validateTuitionActivity(req.params.id, req.body);

    if (error) {
      return res.status(400).send({ message: error });
    }

    try {
      const result = await tuitions.updateOne(
        { _id: new ObjectId(data.id), tutorId: req.user._id },
        { $set: { isActive: data.isActive, updatedAt: new Date() } },
      );

      if (result.matchedCount === 0) {
        return res.status(404).send({ message: "Tuition not found." });
      }

      return res.send({ id: data.id, isActive: data.isActive });
    } catch (error) {
      console.error("Failed to update tuition activity:", error);
      return res
        .status(500)
        .send({ message: "Unable to update tuition status." });
    }
  },
);

app.patch("/api/tuitions/:id", verifyToken, verifyTutor, async (req, res) => {
    const { data, error } = validateNewTuition(req.body);

    if (error) {
      return res.status(400).send({ message: error });
    }

    if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
      return res.status(400).send({ message: "Invalid tuition ID." });
    }

    try {
      const result = await tuitions.updateOne(
        { _id: new ObjectId(req.params.id), tutorId: req.user._id },
        {
          $set: {
            ...data,
            approvalStatus: "pending",
            updatedAt: new Date(),
          },
        },
      );

      if (result.matchedCount === 0) {
        return res.status(404).send({ message: "Tuition not found." });
      }

      return res.send({
        id: req.params.id,
        approvalStatus: "pending",
      });
    } catch (error) {
      console.error("Failed to update tutor tuition:", error);
      return res.status(500).send({ message: "Unable to update this tuition." });
    }
});

app.delete("/api/tuitions/:id", verifyToken, verifyTutor, async (req, res) => {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
      return res.status(400).send({ message: "Invalid tuition ID." });
    }

    try {
      const result = await tuitions.deleteOne({
        _id: new ObjectId(req.params.id),
        tutorId: req.user._id,
      });

      if (result.deletedCount === 0) {
        return res.status(404).send({ message: "Tuition not found." });
      }

      return res.send({ id: req.params.id, deleted: true });
    } catch (error) {
      console.error("Failed to delete tutor tuition:", error);
      return res.status(500).send({ message: "Unable to delete this tuition." });
    }
});

const parseBannerImage = express.raw({
  type: ["image/png", "image/jpeg"],
  limit: "2mb",
});

function handleBannerImageBody(req, res, next) {
  parseBannerImage(req, res, (error) => {
    if (!error) {
      return next();
    }

    if (error.type === "entity.too.large") {
      return res
        .status(413)
        .send({ message: "Image must be 2 MB or smaller." });
    }

    return res.status(400).send({ message: "Invalid image upload." });
  });
}

function hasValidImageSignature(buffer, contentType) {
  if (contentType === "image/png") {
    return buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }

  return (
    contentType === "image/jpeg" &&
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  );
}

async function uploadImageToImgBB(buffer, contentType, filename) {
  const apiKey = process.env.IMGBB_API_KEY;

  if (!apiKey) {
    return {
      error: {
        status: 503,
        message: "Image uploads are not configured on the server.",
      },
    };
  }

  const imageForm = new FormData();
  imageForm.set("image", new Blob([buffer], { type: contentType }), filename);

  try {
    const url = new URL("https://api.imgbb.com/1/upload");
    url.searchParams.set("key", apiKey);

    const uploadResponse = await fetch(url, {
      method: "POST",
      body: imageForm,
    });

    const uploadResult = await uploadResponse.json();

    if (
      !uploadResponse.ok ||
      uploadResult.success !== true ||
      typeof uploadResult.data?.url !== "string"
    ) {
      return {
        error: {
          status: 502,
          message: "The image service could not upload this file.",
        },
      };
    }

    return { url: uploadResult.data.url };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.replace(apiKey, "[redacted]")
        : "Unknown error";
    console.error("ImgBB upload failed:", message);
    return {
      error: {
        status: 502,
        message: "The image service could not upload this file.",
      },
    };
  }
}

app.post(
  "/api/tuitions/banner",
  verifyToken,
  verifyTutor,
  handleBannerImageBody,
  async (req, res) => {
    const apiKey = process.env.IMGBB_API_KEY;

    if (!apiKey) {
      return res
        .status(503)
        .send({ message: "Image uploads are not configured on the server." });
    }

    const contentType = req.headers["content-type"]?.split(";")[0];

    if (
      !Buffer.isBuffer(req.body) ||
      req.body.length === 0 ||
      !hasValidImageSignature(req.body, contentType)
    ) {
      return res
        .status(400)
        .send({ message: "Choose a valid JPG or PNG image." });
    }

    const tuitionIdForEdit = req.headers["x-tuition-id"];

    if (tuitionIdForEdit !== undefined) {
      if (
        typeof tuitionIdForEdit !== "string" ||
        !/^[a-f\d]{24}$/i.test(tuitionIdForEdit)
      ) {
        return res.status(400).send({ message: "Invalid tuition ID." });
      }

      try {
        const tuition = await tuitions.findOne({
          _id: new ObjectId(tuitionIdForEdit),
          tutorId: req.user._id,
        });

        if (!tuition) {
          return res.status(404).send({ message: "Tuition not found." });
        }
      } catch (error) {
        console.error("Failed to verify tuition banner ownership:", error);
        return res
          .status(500)
          .send({ message: "Unable to verify tuition ownership." });
      }
    } else {
      let postsUsed;

      try {
        postsUsed = await tuitions.countDocuments({
          tutorId: req.user._id,
        });
      } catch (error) {
        console.error("Failed to check tutor tuition usage:", error);
        return res
          .status(500)
          .send({ message: "Unable to check your tuition posting limit." });
      }

      if (
        !getTutorPostUsage(getPlanForRole(req.user, "tutor"), postsUsed)
          .canCreate
      ) {
        return res.status(403).send({
          message:
            "Free tutors can post up to 2 tuitions. Upgrade to Pro to post more.",
        });
      }
    }

    const fileExtension = contentType === "image/png" ? "png" : "jpg";
    const result = await uploadImageToImgBB(
      req.body,
      contentType,
      `tuition-banner.${fileExtension}`,
    );

    if (result.error) {
      return res.status(result.error.status).send({
        message: result.error.message,
      });
    }

    return res.send({ url: result.url });
  },
);

app.post(
  "/api/me/image",
  verifyToken,
  handleBannerImageBody,
  async (req, res) => {
    const contentType = req.headers["content-type"]?.split(";")[0];

    if (
      !Buffer.isBuffer(req.body) ||
      req.body.length === 0 ||
      !hasValidImageSignature(req.body, contentType)
    ) {
      return res
        .status(400)
        .send({ message: "Choose a valid JPG or PNG image." });
    }

    const fileExtension = contentType === "image/png" ? "png" : "jpg";
    const result = await uploadImageToImgBB(
      req.body,
      contentType,
      `profile-photo.${fileExtension}`,
    );

    if (result.error) {
      return res.status(result.error.status).send({
        message: result.error.message,
      });
    }

    return res.send({ url: result.url });
  },
);

app.post("/api/tuitions", verifyToken, verifyTutor, async (req, res) => {
  const { data, error } = validateNewTuition(req.body);

  if (error) {
    return res.status(400).send({ message: error });
  }

  try {
    const postsUsed = await tuitions.countDocuments({
      tutorId: req.user._id,
    });
    const usage = getTutorPostUsage(
      getPlanForRole(req.user, "tutor"),
      postsUsed,
    );

    if (!usage.canCreate) {
      return res.status(403).send({
        message:
          "Free tutors can post up to 2 tuitions. Upgrade to Pro to post more.",
        usage,
      });
    }

    const now = new Date();
    const tuition = {
      ...data,
      tutorId: req.user._id,
      approvalStatus: "pending",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    const result = await tuitions.insertOne(tuition);

    return res.status(201).send({
      id: result.insertedId.toString(),
      ...tuition,
      tutorId: req.user._id.toString(),
      usage: getTutorPostUsage(
        getPlanForRole(req.user, "tutor"),
        postsUsed + 1,
      ),
    });
  } catch (error) {
    console.error("Failed to create tuition:", error);
    return res.status(500).send({ message: "Unable to submit this tuition." });
  }
});

// Shared: the signed-in user's own profile.
app.get("/api/me", verifyToken, (req, res) => {
  const { _id, name, email, role, plan, image, phone, bio } = req.user;
  res.send({
    _id: _id.toString(),
    id: _id.toString(),
    name,
    email,
    role,
    plan,
    image: image ?? null,
    phone: phone ?? "",
    bio: bio ?? "",
  });
});

app.patch("/api/me/profile", verifyToken, async (req, res) => {
  const { data, error } = validateProfileUpdate(req.body);

  if (error) {
    return res.status(400).send({ message: error });
  }

  try {
    const result = await users.updateOne(
      { _id: req.user._id },
      { $set: { ...data, updatedAt: new Date() } },
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "User not found." });
    }

    return res.send({
      id: req.user._id.toString(),
      ...data,
      email: req.user.email,
      role: req.user.role,
    });
  } catch (error) {
    console.error("Failed to update user profile:", error);
    return res.status(500).send({ message: "Unable to update your profile." });
  }
});

app.listen(PORT, () => {
  console.log(`MentorLagbe API is running on http://localhost:${PORT}`);
});
