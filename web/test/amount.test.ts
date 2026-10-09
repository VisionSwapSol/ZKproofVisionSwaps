import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanAmount, normAmount } from "../src/lib/amount.ts";

test("a decimal comma means the same as a decimal point", () => {
  assert.equal(normAmount("0,5"), "0.5");
  assert.equal(normAmount("1,25"), "1.25");
  assert.equal(normAmount("0,500"), "0.500");
  assert.equal(normAmount("0,0012"), "0.0012");
  assert.equal(normAmount("12"), "12");
  assert.equal(normAmount(""), "");
});

test("units, signs and spaces around a number are dropped", () => {
  assert.equal(normAmount(" 0.5 SOL"), "0.5");
  assert.equal(normAmount("$0.0008"), "0.0008");
  assert.equal(normAmount("1 000"), "1000");
});

test("text that could be read two ways is refused, never guessed", () => {
  assert.equal(normAmount("1,000.5"), null);
  assert.equal(normAmount("1.000,5"), null);
  assert.equal(normAmount("1,000,000"), null);
  assert.equal(normAmount("1.2.3"), null);
  assert.equal(normAmount("1e5"), null);
});

test("typing keeps a valid amount and ignores a keystroke that would break it", () => {
  assert.equal(cleanAmount("0,"), "0.");
  assert.equal(cleanAmount(""), "");
  assert.equal(cleanAmount("0.5,"), null);
});
