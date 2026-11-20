import assert from "node:assert/strict";
import test from "node:test";

import { validateProfileUpdate } from "../lib/profile-validation.js";

test("normalizes valid profile fields and accepts an ImgBB photo", () => {
  assert.deepEqual(
    validateProfileUpdate({
      name: "  Rahim Uddin ",
      phone: "  01712345678 ",
      bio: "  Tutor and learner. ",
      image: "https://i.ibb.co/example/profile.jpg",
      role: "admin",
      email: "changed@example.com",
    }),
    {
      data: {
        name: "Rahim Uddin",
        phone: "01712345678",
        bio: "Tutor and learner.",
        image: "https://i.ibb.co/example/profile.jpg",
      },
    },
  );
});

test("rejects invalid names, fields, and non-ImgBB image URLs", () => {
  assert.match(validateProfileUpdate(null).error, /details are required/);
  assert.match(validateProfileUpdate({ name: "  " }).error, /name is required/);
  assert.match(
    validateProfileUpdate({
      name: "Rahim",
      phone: "x".repeat(31),
      bio: "",
      image: null,
    }).error,
    /phone must be at most 30 characters/,
  );
  assert.match(
    validateProfileUpdate({
      name: "Rahim",
      phone: "",
      bio: "x".repeat(501),
      image: null,
    }).error,
    /bio must be at most 500 characters/,
  );
  assert.match(
    validateProfileUpdate({
      name: "Rahim",
      phone: "",
      bio: "",
      image: "https://example.com/profile.jpg",
    }).error,
    /ImgBB URL/,
  );
});
