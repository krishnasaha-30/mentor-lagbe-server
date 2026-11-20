import assert from "node:assert/strict";
import test from "node:test";

import { prioritizeProStudentApplications } from "../lib/application-priority.js";

test("puts Pro student applications first while keeping recent-first order in each group", () => {
  const applications = [
    {
      id: "free-new",
      createdAt: "2026-01-03T00:00:00.000Z",
      student: { plan: "free" },
    },
    {
      id: "pro-old",
      createdAt: "2026-01-01T00:00:00.000Z",
      student: { plan: "pro" },
    },
    {
      id: "pro-new",
      createdAt: "2026-01-02T00:00:00.000Z",
      student: { plan: "pro" },
    },
    {
      id: "unknown-student",
      createdAt: "2026-01-04T00:00:00.000Z",
      student: null,
    },
  ];

  assert.deepEqual(
    prioritizeProStudentApplications(applications).map(
      (application) => application.id,
    ),
    ["pro-new", "pro-old", "unknown-student", "free-new"],
  );
  assert.equal(applications[0].id, "free-new");
});
