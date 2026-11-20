export function validateAdminUserRole(id, body) {
  if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id)) {
    return { error: "Invalid user ID." };
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "User role is required." };
  }

  if (body.role !== "student" && body.role !== "tutor") {
    return { error: "User role must be student or tutor." };
  }

  return {
    data: {
      id,
      role: body.role,
    },
  };
}
