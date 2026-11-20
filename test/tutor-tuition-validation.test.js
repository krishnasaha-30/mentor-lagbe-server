import assert from "node:assert/strict";
import test from "node:test";

import { validateTuitionActivity } from "../lib/tutor-tuition-validation.js";

const tuitionId = "507f1f77bcf86cd799439011";

test("validates active and closed tuition states", () => {
  assert.deepEqual(validateTuitionActivity(tuitionId, { isActive: true }), {
    data: { id: tuitionId, isActive: true },
  });
  assert.deepEqual(validateTuitionActivity(tuitionId, { isActive: false }), {
    data: { id: tuitionId, isActive: false },
  });
});

test("rejects malformed IDs and non-boolean states", () => {
  assert.match(
    validateTuitionActivity("invalid", { isActive: true }).error,
    /tuition ID/,
  );
  assert.match(
    validateTuitionActivity(tuitionId, { isActive: "false" }).error,
    /boolean/,
  );
});
