const MAX_TITLE_LENGTH = 120;
const MAX_SUBJECT_LENGTH = 60;
const MAX_CLASS_LEVEL_LENGTH = 80;
const MAX_LOCATION_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2000;

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

export function validateNewTuition(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Tuition details are required." };
  }

  const title = readRequiredString(body, "title", MAX_TITLE_LENGTH);
  const subject = readRequiredString(body, "subject", MAX_SUBJECT_LENGTH);
  const classLevel = readRequiredString(
    body,
    "classLevel",
    MAX_CLASS_LEVEL_LENGTH,
  );
  const location = readRequiredString(body, "location", MAX_LOCATION_LENGTH);
  const description = readRequiredString(
    body,
    "description",
    MAX_DESCRIPTION_LENGTH,
  );

  const invalidField = [title, subject, classLevel, location, description].find(
    (field) => field.error,
  );

  if (invalidField) {
    return { error: invalidField.error };
  }

  if (typeof body.mode !== "string") {
    return { error: "mode must be Online or Offline." };
  }

  const normalizedMode = body.mode.trim().toLowerCase();

  if (normalizedMode !== "online" && normalizedMode !== "offline") {
    return { error: "mode must be Online or Offline." };
  }

  if (
    typeof body.monthlyFee !== "number" ||
    !Number.isSafeInteger(body.monthlyFee) ||
    body.monthlyFee < 1 ||
    body.monthlyFee > 1000000
  ) {
    return { error: "monthlyFee must be a whole amount between 1 and 1000000." };
  }

  if (
    typeof body.daysPerWeek !== "number" ||
    !Number.isInteger(body.daysPerWeek) ||
    body.daysPerWeek < 1 ||
    body.daysPerWeek > 7
  ) {
    return { error: "daysPerWeek must be an integer between 1 and 7." };
  }

  let bannerImage = null;

  if (body.bannerImage !== undefined && body.bannerImage !== null) {
    if (typeof body.bannerImage !== "string") {
      return { error: "bannerImage must be an ImgBB URL." };
    }

    if (body.bannerImage.trim()) {
      try {
        const url = new URL(body.bannerImage);

        if (url.protocol !== "https:" || url.hostname !== "i.ibb.co") {
          return { error: "bannerImage must be an ImgBB URL." };
        }

        bannerImage = url.toString();
      } catch {
        return { error: "bannerImage must be a valid ImgBB URL." };
      }
    }
  }

  return {
    data: {
      title: title.value,
      subject: subject.value,
      classLevel: classLevel.value,
      mode: normalizedMode === "online" ? "Online" : "Offline",
      location: location.value,
      monthlyFee: body.monthlyFee,
      daysPerWeek: body.daysPerWeek,
      description: description.value,
      bannerImage,
    },
  };
}

export function getTutorPostUsage(plan, postsUsed) {
  const normalizedPlan = plan === "pro" ? "pro" : "free";
  const postsLimit = normalizedPlan === "pro" ? null : 2;

  return {
    plan: normalizedPlan,
    postsUsed,
    postsLimit,
    canCreate: postsLimit === null || postsUsed < postsLimit,
  };
}
