import assert from "node:assert/strict";
import test from "node:test";

import {
  getPlanForRole,
  isSubscriptionEntitled,
  resolveSubscriptionPlan,
  validateSubscriptionCheckout,
} from "../lib/billing-validation.js";

test("allows only role-matched Pro subscriptions", () => {
  assert.deepEqual(
    validateSubscriptionCheckout("tutor", { plan: "pro_tutor" }),
    {
      data: {
        plan: "pro_tutor",
        role: "tutor",
        priceEnv: "STRIPE_PRO_TUTOR_PRICE_ID",
      },
    },
  );
  assert.deepEqual(
    validateSubscriptionCheckout("student", { plan: "pro_student" }),
    {
      data: {
        plan: "pro_student",
        role: "student",
        priceEnv: "STRIPE_PRO_STUDENT_PRICE_ID",
      },
    },
  );
});

test("rejects malformed, unknown, and role-mismatched subscription plans", () => {
  assert.match(validateSubscriptionCheckout("student", null).error, /required/);
  assert.match(
    validateSubscriptionCheckout("student", { plan: "pro_tutor" }).error,
    /only available to tutors/,
  );
  assert.match(
    validateSubscriptionCheckout("admin", { plan: "pro_student" }).error,
    /only available to students/,
  );
  assert.match(
    validateSubscriptionCheckout("tutor", { plan: "admin" }).error,
    /valid subscription plan/,
  );
});

test("validates subscription metadata against the configured Stripe price", () => {
  const priceIds = {
    pro_tutor: "price_tutor",
    pro_student: "price_student",
  };

  assert.deepEqual(
    resolveSubscriptionPlan(
      {
        metadata: { plan: "pro_tutor", userId: "507f1f77bcf86cd799439011" },
        items: { data: [{ price: { id: "price_tutor" } }] },
      },
      priceIds,
    ),
    {
      data: {
        plan: "pro_tutor",
        role: "tutor",
        userId: "507f1f77bcf86cd799439011",
        priceId: "price_tutor",
      },
    },
  );
  assert.match(
    resolveSubscriptionPlan(
      {
        metadata: { plan: "pro_tutor", userId: "bad-id" },
        items: { data: [{ price: { id: "price_student" } }] },
      },
      priceIds,
    ).error,
    /invalid/,
  );
});

test("keeps Pro during billing retries and removes access after termination", () => {
  assert.equal(isSubscriptionEntitled("active"), true);
  assert.equal(isSubscriptionEntitled("trialing"), true);
  assert.equal(isSubscriptionEntitled("past_due"), true);
  assert.equal(isSubscriptionEntitled("unpaid"), false);
  assert.equal(isSubscriptionEntitled("canceled"), false);
});

test("keeps role-specific subscriptions from granting the other role's benefits", () => {
  assert.equal(
    getPlanForRole(
      { plan: "pro", stripeSubscriptionPlan: "pro_student" },
      "student",
    ),
    "pro",
  );
  assert.equal(
    getPlanForRole(
      { plan: "pro", stripeSubscriptionPlan: "pro_tutor" },
      "tutor",
    ),
    "pro",
  );
  assert.equal(
    getPlanForRole(
      { plan: "pro", stripeSubscriptionPlan: "pro_tutor" },
      "student",
    ),
    "free",
  );
});
