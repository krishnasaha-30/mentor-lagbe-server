export function validateTuitionApproval(id, body) {
  if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id)) {
    return { error: "Invalid tuition ID." };
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Approval status is required." };
  }

  if (body.approvalStatus !== "approved" && body.approvalStatus !== "rejected") {
    return { error: "Approval status must be approved or rejected." };
  }

  return {
    data: {
      id,
      approvalStatus: body.approvalStatus,
    },
  };
}
