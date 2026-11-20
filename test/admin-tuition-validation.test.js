import assert from "node:assert/strict";
import test from "node:test";

import { validateTuitionApproval } from "../lib/admin-tuition-validation.js";

const tuitionId = "507f1f77bcf86cd799439011";

test("accepts only valid approval decisions and tuition IDs", () => {
  assert.deepEqual(
    validateTuitionApproval(tuitionId, { approvalStatus: "approved" }),
    { data: { id: tuitionId, approvalStatus: "approved" } },
  );
  assert.deepEqual(
    validateTuitionApproval(tuitionId, { approvalStatus: "rejected" }),
    { data: { id: tuitionId, approvalStatus: "rejected" } },
  );
});

test("rejects malformed IDs, bodies, and approval decisions", () => {
  assert.match(
    validateTuitionApproval("not-an-id", { approvalStatus: "approved" }).error,
    /tuition ID/,
  );
  assert.match(
    validateTuitionApproval(tuitionId, null).error,
    /status is required/,
  );
  assert.match(
    validateTuitionApproval(tuitionId, { approvalStatus: "pending" }).error,
    /approved or rejected/,
  );
});
