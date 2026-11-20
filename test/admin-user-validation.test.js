import assert from "node:assert/strict";
import test from "node:test";

import { validateAdminUserRole } from "../lib/admin-user-validation.js";

const userId = "507f1f77bcf86cd799439011";

test("accepts student and tutor role updates with valid IDs", () => {
  assert.deepEqual(validateAdminUserRole(userId, { role: "student" }), {
    data: { id: userId, role: "student" },
  });
  assert.deepEqual(validateAdminUserRole(userId, { role: "tutor" }), {
    data: { id: userId, role: "tutor" },
  });
});

test("rejects malformed IDs, bodies, and admin role assignments", () => {
  assert.match(
    validateAdminUserRole("not-an-id", { role: "student" }).error,
    /user ID/,
  );
  assert.match(validateAdminUserRole(userId, null).error, /role is required/);
  assert.match(
    validateAdminUserRole(userId, { role: "admin" }).error,
    /student or tutor/,
  );
});
