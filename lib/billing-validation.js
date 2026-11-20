const plans = {
  pro_tutor: { role: "tutor", priceEnv: "STRIPE_PRO_TUTOR_PRICE_ID" },
  pro_student: { role: "student", priceEnv: "STRIPE_PRO_STUDENT_PRICE_ID" },
};

export function validateSubscriptionCheckout(role, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Subscription plan is required." };
  }

  const plan = body.plan;
  const planDetails = plans[plan];

  if (!planDetails) {
    return { error: "Choose a valid subscription plan." };
  }

  if (role !== planDetails.role) {
    return {
      error:
        planDetails.role === "tutor"
          ? "The Pro Tutor plan is only available to tutors."
          : "The Pro Student plan is only available to students.",
      status: 403,
    };
  }

  return {
    data: {
      plan,
      role: planDetails.role,
      priceEnv: planDetails.priceEnv,
    },
  };
}

export function resolveSubscriptionPlan(subscription, priceIds) {
  const plan = subscription?.metadata?.plan;
  const planDetails = plans[plan];
  const userId = subscription?.metadata?.userId;
  const priceId = subscription?.items?.data?.[0]?.price?.id;

  if (
    !planDetails ||
    typeof userId !== "string" ||
    typeof priceIds[plan] !== "string" ||
    typeof priceId !== "string" ||
    priceId !== priceIds[plan]
  ) {
    return { error: "Subscription metadata or price is invalid." };
  }

  return {
    data: {
      plan,
      role: planDetails.role,
      userId,
      priceId,
    },
  };
}

export function isSubscriptionEntitled(status) {
  return status === "active" || status === "trialing" || status === "past_due";
}

export function getPlanForRole(user, role) {
  const expectedPlan =
    role === "tutor" ? "pro_tutor" : role === "student" ? "pro_student" : null;

  return expectedPlan !== null &&
    user?.plan === "pro" &&
    user.stripeSubscriptionPlan === expectedPlan
    ? "pro"
    : "free";
}
