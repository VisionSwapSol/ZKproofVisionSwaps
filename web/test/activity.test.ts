import { test } from "node:test";
import assert from "node:assert/strict";
import { activityGroup, dayLabel, groupByDay, pageOf } from "../src/lib/activity.ts";

const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test("day labels: Today, Yesterday, then the date, across midnight", () => {
  const now = at(2026, 10, 15, 0, 5);
  assert.equal(dayLabel(at(2026, 10, 15, 0, 1), now), "Today");
  assert.equal(dayLabel(at(2026, 10, 14, 23, 59), now), "Yesterday");
  assert.equal(dayLabel(at(2026, 10, 14, 0, 0), now), "Yesterday");
  assert.equal(dayLabel(at(2026, 10, 13, 23, 59), now), "Tue, Oct 13");
  assert.equal(dayLabel(at(2026, 10, 12, 9), now), "Mon, Oct 12");
  // late at night, an hour ago is still today
  assert.equal(dayLabel(at(2026, 10, 15, 22), at(2026, 10, 15, 23, 30)), "Today");
});

test("grouped by day, newest first, in the order given", () => {
  const now = at(2026, 10, 15, 18);
  const items = [
    { t: at(2026, 10, 15, 17), kind: "send" as const, text: "a" },
    { t: at(2026, 10, 15, 9), kind: "buy" as const, text: "b" },
    { t: at(2026, 10, 14, 22), kind: "sweep" as const, text: "c" },
    { t: at(2026, 10, 12, 8), kind: "shield" as const, text: "d" },
  ];
  const g = groupByDay(items, now);
  assert.deepEqual(
    g.map((x) => [x.label, x.items.map((i) => i.text).join("")]),
    [
      ["Today", "ab"],
      ["Yesterday", "c"],
      ["Mon, Oct 12", "d"],
    ],
  );
  assert.deepEqual(groupByDay([], now), []);
});

test("every kind has a chip", () => {
  assert.equal(activityGroup("shield"), "moves");
  assert.equal(activityGroup("sweep"), "moves");
  assert.equal(activityGroup("merge"), "moves");
  assert.equal(activityGroup("refund"), "moves");
  assert.equal(activityGroup("buy"), "trades");
  assert.equal(activityGroup("sell"), "trades");
  assert.equal(activityGroup("send"), "sends");
});

test("a page at a time, under a filter", () => {
  const kinds = ["send", "buy", "sweep", "sell", "shield", "send"] as const;
  const items = Array.from({ length: 30 }, (_, k) => ({ t: 1000 - k, kind: kinds[k % kinds.length] }));
  assert.equal(pageOf(items, "all", 20).items.length, 20);
  assert.equal(pageOf(items, "all", 20).more, true);
  assert.equal(pageOf(items, "all", 40).more, false);
  const trades = pageOf(items, "trades", 100);
  assert.equal(trades.items.length, 10);
  assert.ok(trades.items.every((i) => i.kind === "buy" || i.kind === "sell"));
  assert.equal(pageOf(items, "sends", 3).items.length, 3);
  assert.equal(pageOf(items, "sends", 3).more, true);
  assert.equal(pageOf(items, "moves", 0).items.length, 0);
});
