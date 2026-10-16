import assert from "node:assert/strict";
import { test } from "node:test";
import { RELEASE_AT, RELEASE_DATE, getReleaseCountdown } from "../src/lib/release-countdown";

test("release is noon PST on October 15, 2026, regardless of browser timezone", () => {
  assert.equal(RELEASE_DATE, "2026-10-15T12:00:00-08:00");
  assert.equal(new Date(RELEASE_AT).toISOString(), "2026-10-15T20:00:00.000Z");
});

test("shows total hours, minutes and seconds without a days counter", () => {
  const now = RELEASE_AT - (49 * 3600 + 12 * 60 + 34) * 1000;
  assert.deepEqual(getReleaseCountdown(now), { hours: 49, minutes: 12, seconds: 34, complete: false });
});

test("counts down each second across minute and hour boundaries", () => {
  assert.deepEqual(getReleaseCountdown(RELEASE_AT - 3600_000), { hours: 1, minutes: 0, seconds: 0, complete: false });
  assert.deepEqual(getReleaseCountdown(RELEASE_AT - 3599_000), { hours: 0, minutes: 59, seconds: 59, complete: false });
  assert.deepEqual(getReleaseCountdown(RELEASE_AT - 60_000), { hours: 0, minutes: 1, seconds: 0, complete: false });
  assert.deepEqual(getReleaseCountdown(RELEASE_AT - 59_000), { hours: 0, minutes: 0, seconds: 59, complete: false });
});

test("resumes from actual time after a tab has been inactive", () => {
  assert.equal(getReleaseCountdown(RELEASE_AT - 7200_000).hours, 2);
  assert.deepEqual(getReleaseCountdown(RELEASE_AT - 35_000), { hours: 0, minutes: 0, seconds: 35, complete: false });
});

test("does not show zero before the scheduled time", () => {
  assert.equal(getReleaseCountdown(RELEASE_AT - 1).seconds, 1);
  assert.equal(getReleaseCountdown(RELEASE_AT - 1).complete, false);
});

test("clamps to zero at and after the deadline", () => {
  for (const now of [RELEASE_AT, RELEASE_AT + 1, RELEASE_AT + 86400_000]) {
    assert.deepEqual(getReleaseCountdown(now), { hours: 0, minutes: 0, seconds: 0, complete: true });
  }
});
