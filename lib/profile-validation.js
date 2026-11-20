const MAX_NAME_LENGTH = 80;
const MAX_PHONE_LENGTH = 30;
const MAX_BIO_LENGTH = 500;

function readOptionalString(body, name, maxLength) {
  const value = body[name];

  if (typeof value !== "string") {
    return { error: `${name} must be a string.` };
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length > maxLength) {
    return { error: `${name} must be at most ${maxLength} characters.` };
  }

  return { value: normalizedValue };
}

export function validateProfileUpdate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Profile details are required." };
  }

  if (typeof body.name !== "string" || !body.name.trim()) {
    return { error: "name is required." };
  }

  const name = body.name.trim();

  if (name.length > MAX_NAME_LENGTH) {
    return { error: `name must be at most ${MAX_NAME_LENGTH} characters.` };
  }

  const phone = readOptionalString(body, "phone", MAX_PHONE_LENGTH);
  const bio = readOptionalString(body, "bio", MAX_BIO_LENGTH);
  const invalidField = [phone, bio].find((field) => field.error);

  if (invalidField) {
    return { error: invalidField.error };
  }

  let image = null;

  if (body.image !== null && typeof body.image !== "string") {
    return { error: "image must be an ImgBB URL or null." };
  }

  if (typeof body.image === "string" && body.image.trim()) {
    try {
      const url = new URL(body.image);

      if (url.protocol !== "https:" || url.hostname !== "i.ibb.co") {
        return { error: "image must be an ImgBB URL." };
      }

      image = url.toString();
    } catch {
      return { error: "image must be a valid ImgBB URL." };
    }
  }

  return {
    data: {
      name,
      phone: phone.value,
      bio: bio.value,
      image,
    },
  };
}
