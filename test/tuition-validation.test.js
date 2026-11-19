import assert from "node:assert/strict";
import test from "node:test";

import {
  getTutorPostUsage,
  validateNewTuition,
} from "../lib/tuition-validation.js";

const validTuition = {
  title: "HSC Higher Math Batch",
  subject: "Math",
  classLevel: "Class 11-12",
  mode: "Online",
  location: "Dhanmondi, Dhaka",
  monthlyFee: 3500,
  daysPerWeek: 3,
  description: "Concept-first lessons and weekly mock tests.",
};

test("validates and normalizes a tuition without trusting client-owned fields", () => {
  const result = validateNewTuition({
    ...validTuition,
    mode: "online",
    tutorId: "another-user",
    approvalStatus: "approved",
    isActive: false,
  });

  assert.deepEqual(result.data, {
    ...validTuition,
    mode: "Online",
    bannerImage: null,
  });
});

test("accepts only safe ImgBB image URLs", () => {
  const valid = validateNewTuition({
    ...validTuition,
    bannerImage: "https://i.ibb.co/example/banner.png",
  });
  const invalid = validateNewTuition({
    ...validTuition,
    bannerImage: "https://example.com/banner.png",
  });

  assert.equal(valid.data.bannerImage, "https://i.ibb.co/example/banner.png");
  assert.match(invalid.error, /ImgBB/);
});

test("rejects invalid tuition amounts, schedules, and modes", () => {
  assert.match(
    validateNewTuition({ ...validTuition, monthlyFee: 0 }).error,
    /monthlyFee/,
  );
  assert.match(
    validateNewTuition({ ...validTuition, daysPerWeek: 8 }).error,
    /daysPerWeek/,
  );
  assert.match(
    validateNewTuition({ ...validTuition, mode: "Hybrid" }).error,
    /mode/,
  );
});

test("enforces the free posting limit while leaving Pro unlimited", () => {
  assert.equal(getTutorPostUsage("free", 1).canCreate, true);
  assert.equal(getTutorPostUsage("free", 2).canCreate, false);
  assert.deepEqual(getTutorPostUsage("pro", 20), {
    plan: "pro",
    postsUsed: 20,
    postsLimit: null,
    canCreate: true,
  });
});
