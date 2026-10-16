import { test } from "node:test";
import assert from "node:assert/strict";
import { durationText, measuredMsPerSlot, slotsToText } from "../src/lib/slottime.ts";

test("the waiting room is described from the measured slot time, not a fixed 0.4 s", () => {
  // 450 slots: about 3 minutes at the 0.4 s the site used to assume, about 95 seconds at today's 0.21 s
  assert.equal(slotsToText(450, 400), "about 3 minutes");
  assert.equal(slotsToText("450", 210), "about 95 seconds");
  assert.equal(slotsToText(450n, 215), "about 95 seconds");
  // the program's longest waiting room (MAX_DELAY_SLOTS): 7 days at 0.4 s, about 3.5 at 0.2 s
  assert.equal(slotsToText(1_512_000, 400), "about 7 days");
  assert.equal(slotsToText(1_512_000, 200), "about 3.5 days");
});

test("without a measured slot time there is no figure", () => {
  assert.equal(slotsToText(450, null), null);
  assert.equal(slotsToText(450, undefined), null);
  assert.equal(slotsToText(450, Number.NaN), null);
  assert.equal(slotsToText(450, 0), null);
  assert.equal(slotsToText(450, 60_000), null);
  assert.equal(slotsToText("not a number", 400), null);
  assert.equal(slotsToText(-1, 400), null);
});

test("durations read naturally at every scale", () => {
  assert.equal(durationText(0), "about 1 second");
  assert.equal(durationText(12), "about 12 seconds");
  assert.equal(durationText(97), "about 95 seconds");
  assert.equal(durationText(120), "about 2 minutes");
  assert.equal(durationText(60 * 60), "about 60 minutes");
  assert.equal(durationText(60 * 60 * 2.25), "about 2.5 hours");
  assert.equal(durationText(60 * 60 * 20), "about 20 hours");
  assert.equal(durationText(60 * 60 * 24 * 2), "about 2 days");
});

test("the docs put the waiting room in time from a measured slot time only, never the 400 ms fallback", () => {
  assert.equal(measuredMsPerSlot(205, 230, 240), 205, "the server's figure first");
  assert.equal(measuredMsPerSlot(null, 230, 240), 230, "then the network's samples");
  assert.equal(measuredMsPerSlot(undefined, null, 240), 240, "then this device's last one");
  assert.equal(measuredMsPerSlot(null, null, null), null);
  assert.equal(measuredMsPerSlot(5, 7000, null), null, "absurd figures are ignored");
  assert.equal(slotsToText(450, measuredMsPerSlot(null, null, null)), null);
  assert.equal(slotsToText(450, measuredMsPerSlot(null, 214, null)), "about 95 seconds");
});
