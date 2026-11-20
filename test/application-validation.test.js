import assert from "node:assert/strict";
import test from "node:test";

import {
  validateApplicationDecision,
  validateNewApplication,
} from "../lib/application-validation.js";

const tuitionId = "507f1f77bcf86cd799439011";

test("validates and normalizes a student application", () => {
  assert.deepEqual(
    validateNewApplication(tuitionId, {
      phone: "  +880 1712-345678 ",
      preferredSchedule: "  Weekday evenings ",
      note: "  I can start next week. ",
      status: "accepted",
    }),
    {
      data: {
        tuitionId,
        phone: "+880 1712-345678",
        preferredSchedule: "Weekday evenings",
        note: "I can start next week.",
      },
    },
  );
});

test("rejects malformed IDs, missing fields, and oversized notes", () => {
  assert.match(
    validateNewApplication("bad-id", {
      phone: "123456",
      preferredSchedule: "Evenings",
    }).error,
    /tuition ID/,
  );
  assert.match(
    validateNewApplication(tuitionId, {
      phone: "",
      preferredSchedule: "Evenings",
    }).error,
    /phone is required/,
  );
  assert.match(
    validateNewApplication(tuitionId, {
      phone: "123456",
      preferredSchedule: "Evenings",
      note: "x".repeat(1001),
    }).error,
    /note/,
  );
});

test("validates applicant decisions and rejects all other statuses", () => {
  assert.deepEqual(
    validateApplicationDecision(tuitionId, { status: "accepted" }),
    { data: { id: tuitionId, status: "accepted" } },
  );
  assert.deepEqual(
    validateApplicationDecision(tuitionId, { status: "rejected" }),
    { data: { id: tuitionId, status: "rejected" } },
  );
  assert.match(
    validateApplicationDecision(tuitionId, { status: "pending" }).error,
    /accepted or rejected/,
  );
});
