import { test } from "node:test";
import assert from "node:assert/strict";
import { CU_ALERT_SHARE, SETTLE_CU, TRANSACT_CU, TRANSACT_FEE_CU, cuNearLimit } from "../src/program.ts";

// the largest measured (VS-53): every mainnet transact up to October 2026 (254) used at most 214,975 units and every settle
// (81) at most 40,449; the upgrade rehearsal measured transact_v2 at up to 209,993 and its settles at up to 44,483
const TRANSACT_MEASURED_MAX = 214_975;
const SETTLE_MEASURED = 44_483;

test("a spend asks for what it uses plus a margin, not twice as much", () => {
  assert.ok(TRANSACT_CU >= TRANSACT_MEASURED_MAX * 1.3, "at least 30% over the largest measured spend");
  assert.ok(TRANSACT_CU <= TRANSACT_MEASURED_MAX * 1.5, "no more than half again");
  // the largest measured spend sits under the alert line, so normal spends never raise it
  assert.ok(!cuNearLimit(TRANSACT_MEASURED_MAX, TRANSACT_CU));
  assert.ok(cuNearLimit(Math.ceil(TRANSACT_CU * CU_ALERT_SHARE) + 1, TRANSACT_CU));
});

test("a settle asks for what it uses plus a margin", () => {
  assert.ok(SETTLE_CU >= SETTLE_MEASURED * 1.3 && SETTLE_CU < 60_000);
  assert.ok(!cuNearLimit(SETTLE_MEASURED, SETTLE_CU));
});

test("the relayer's published fee is still worked out from the earlier request, so it doesn't move", () => {
  assert.equal(TRANSACT_FEE_CU, 450_000);
  assert.ok(TRANSACT_FEE_CU >= TRANSACT_CU, "the fee covers the priority the smaller request pays");
});

test("an unknown measurement raises nothing", () => {
  assert.equal(cuNearLimit(undefined, TRANSACT_CU), false);
  assert.equal(cuNearLimit(null, TRANSACT_CU), false);
  assert.equal(cuNearLimit(Number.NaN, TRANSACT_CU), false);
});
