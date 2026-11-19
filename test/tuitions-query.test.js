import assert from "node:assert/strict";
import test from "node:test";

import { parseTuitionsQuery } from "../lib/tuitions-query.js";

test("defaults to approved active tuitions and the first page", () => {
  const result = parseTuitionsQuery({});

  assert.deepEqual(result, {
    filter: { approvalStatus: "approved", isActive: true },
    page: 1,
    pageSize: 9,
    skip: 0,
  });
});

test("combines search, filters, and pagination", () => {
  const result = parseTuitionsQuery({
    q: "math",
    subject: "Mathematics",
    classLevel: "Class 11-12",
    mode: "Online",
    page: "3",
    limit: "12",
  });

  assert.equal(result.filter.approvalStatus, "approved");
  assert.equal(result.filter.isActive, true);
  assert.equal(result.filter.subject.test("mathematics"), true);
  assert.equal(result.filter.classLevel.test("class 11-12"), true);
  assert.equal(result.filter.mode.test("online"), true);
  assert.equal(result.filter.$or[0].title.test("HSC Math"), true);
  assert.equal(result.page, 3);
  assert.equal(result.pageSize, 12);
  assert.equal(result.skip, 24);
});

test("escapes user search text before building Mongo regular expressions", () => {
  const result = parseTuitionsQuery({ q: "[math].*" });
  const searchRegex = result.filter.$or[0].title;

  assert.equal(searchRegex.test("[math].*"), true);
  assert.equal(searchRegex.test("mathematics"), false);
});

test("rejects repeated, malformed, and oversized query values", () => {
  assert.match(parseTuitionsQuery({ page: ["1", "2"] }).error, /page/);
  assert.match(parseTuitionsQuery({ page: "0" }).error, /page/);
  assert.match(parseTuitionsQuery({ limit: "25" }).error, /limit/);
  assert.match(parseTuitionsQuery({ q: "a".repeat(101) }).error, /q/);
});
