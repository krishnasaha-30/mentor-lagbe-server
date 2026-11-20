export function validateTuitionActivity(id, body) {
  if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id)) {
    return { error: "Invalid tuition ID." };
  }

  if (!body || typeof body !== "object" || typeof body.isActive !== "boolean") {
    return { error: "isActive must be a boolean." };
  }

  return {
    data: {
      id,
      isActive: body.isActive,
    },
  };
}
