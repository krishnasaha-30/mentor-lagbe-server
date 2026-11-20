function readRequiredString(body, name, maxLength) {
  const value = body[name];

  if (typeof value !== "string" || !value.trim()) {
    return { error: `${name} is required.` };
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length > maxLength) {
    return { error: `${name} must be at most ${maxLength} characters.` };
  }

  return { value: normalizedValue };
}

export function validateNewApplication(id, body) {
  if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id)) {
    return { error: "Invalid tuition ID." };
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Application details are required." };
  }

  const phone = readRequiredString(body, "phone", 30);
  const preferredSchedule = readRequiredString(
    body,
    "preferredSchedule",
    200,
  );
  const invalidField = [phone, preferredSchedule].find((field) => field.error);

  if (invalidField) {
    return { error: invalidField.error };
  }

  if (
    body.note !== undefined &&
    (typeof body.note !== "string" || body.note.trim().length > 1000)
  ) {
    return { error: "note must be at most 1000 characters." };
  }

  return {
    data: {
      tuitionId: id,
      phone: phone.value,
      preferredSchedule: preferredSchedule.value,
      note: typeof body.note === "string" ? body.note.trim() : "",
    },
  };
}

export function validateApplicationDecision(id, body) {
  if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id)) {
    return { error: "Invalid application ID." };
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    (body.status !== "accepted" && body.status !== "rejected")
  ) {
    return { error: "Application status must be accepted or rejected." };
  }

  return {
    data: {
      id,
      status: body.status,
    },
  };
}
