import { test } from "node:test";
import assert from "node:assert/strict";
import { askGroups, NO_ROUTE_GAP_MS, PER_ASK, PROBE_GAP_MS, probeTooSoon, sawNoRoute, sawRoute, stuckToken } from "../src/lib/tokenfacts.ts";

test("token lookups go in groups that fit the search's 600 characters", () => {
  const mints = Array.from({ length: 30 }, (_, i) => `${"M".repeat(40)}${String(i).padStart(4, "0")}`); // 44 characters, like a real mint
  const groups = askGroups(mints);
  assert.deepEqual(groups.map((g) => g.length), [PER_ASK, PER_ASK, 30 - 2 * PER_ASK]);
  assert.deepEqual(groups.flat(), mints);
  for (const g of groups) assert.ok(g.join(",").length <= 600);
  assert.deepEqual(askGroups([]), []);
});

test("a token counts as unsellable only after no route twice, minutes apart, and any route clears it", () => {
  const m = "stuck-mint";
  sawNoRoute(m, 1_000);
  assert.equal(stuckToken(m), false, "one no-route is a hiccup");
  sawNoRoute(m, 1_000 + NO_ROUTE_GAP_MS - 1);
  assert.equal(stuckToken(m), false, "too soon to tell");
  sawNoRoute(m, 1_000 + NO_ROUTE_GAP_MS);
  assert.equal(stuckToken(m), true);
  sawRoute(m);
  assert.equal(stuckToken(m), false, "a route for some amount means it sells");
  assert.equal(stuckToken("never-seen"), false);
});

test("a probe quote goes at most once per PROBE_GAP_MS per token, however often it's asked for", () => {
  const m = "probe-mint";
  assert.equal(probeTooSoon(m, 10_000), null, "the first one goes");
  assert.equal(probeTooSoon(m, 10_350), 350, "a keystroke later: skipped, 350 ms since the last");
  assert.equal(probeTooSoon("other-mint", 10_350), null, "each token on its own");
  assert.equal(probeTooSoon(m, 10_000 + PROBE_GAP_MS), null, "goes again after the gap");
  assert.equal(probeTooSoon(m, 10_000 + PROBE_GAP_MS + 1), 1);
});
