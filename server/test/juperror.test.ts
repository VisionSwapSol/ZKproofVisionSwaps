import { test } from "node:test";
import assert from "node:assert/strict";
import { jupError } from "../src/jupiter.ts";

test("a route too small for the whole amount says to try less, not that there's no route", () => {
  const big = jupError(JSON.stringify({ error: "The route plan does not consume all the amount", errorCode: "ROUTE_PLAN_DOES_NOT_CONSUME_ALL_THE_AMOUNT" }));
  assert.match(big!, /smaller amount/);
  assert.doesNotMatch(big!, /no route/i);
  assert.equal(jupError(JSON.stringify({ error: "Could not find any route", errorCode: "COULD_NOT_FIND_ANY_ROUTE" })), "No route for this pair right now.");
  assert.equal(jupError(JSON.stringify({ error: "Something else" })), "Something else");
  assert.equal(jupError("not json"), null);
});
