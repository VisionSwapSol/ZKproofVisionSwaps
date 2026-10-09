import { test } from "node:test";
import assert from "node:assert/strict";
import { chainError, failedProgram, setPoolProgram, PRICE_MOVED } from "../src/lib/chainerr.ts";

const POOL = "VisNPoo1111111111111111111111111111111111111";
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
setPoolProgram(POOL);

const swapLogs = (inner: string[]) => [`Program ${JUP} invoke [1]`, ...inner, `Program ${JUP} failed: custom program error: 0x1773`];

test("the failing program is the first one the logs name", () => {
  assert.deepEqual(failedProgram(`Program ${PUMP} failed: custom program error: 0x1773 Program ${JUP} failed`), { program: PUMP, code: "0x1773" });
  assert.equal(failedProgram("nothing here"), null);
});

test("a market on the route refusing for price is a price move, never a pool message", () => {
  const e = chainError({
    message: "Simulation failed",
    logs: swapLogs([`Program ${PUMP} invoke [2]`, "Program log: AnchorError occurred. Error Code: TooLittleSolReceived. Error Number: 6003.", `Program ${PUMP} failed: custom program error: 0x1773`]),
  });
  assert.equal(e.message, PRICE_MOVED);
  assert.doesNotMatch(e.message, /deposit limit/);
  // the logs stay on the error for later checks
  assert.ok(((e as Error & { logs?: string[] }).logs ?? []).length > 0);
});

test("other market refusals name the market's own error, not the pool's", () => {
  const e = chainError({
    message: "",
    logs: swapLogs([`Program ${PUMP} invoke [2]`, "Program log: AnchorError occurred. Error Code: BondingCurveComplete. Error Number: 6005.", `Program ${PUMP} failed: custom program error: 0x1770`]),
  });
  assert.match(e.message, /markets on this route refused the trade \(BondingCurveComplete\)/);
  assert.doesNotMatch(e.message, /paused/);
});

test("Jupiter's own slippage error and Raydium's numbered one both read as a price move", () => {
  assert.equal(chainError({ message: "", logs: [`Program ${JUP} invoke [1]`, `Program ${JUP} failed: custom program error: 0x1771`] }).message, PRICE_MOVED);
  const ray = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
  assert.equal(chainError({ message: "", logs: swapLogs([`Program ${ray} invoke [2]`, `Program ${ray} failed: custom program error: 0x1e`]) }).message, PRICE_MOVED);
});

test("the pool's own errors still read as before when the pool failed", () => {
  assert.match(chainError({ message: "", logs: [`Program ${POOL} invoke [1]`, `Program ${POOL} failed: custom program error: 0x1770`] }).message, /Deposits are paused/);
  assert.match(chainError({ message: "Error Code: PoolFull" }).message, /deposit limit/);
  // the same number from some other program is not the pool's
  assert.doesNotMatch(chainError({ message: "", logs: [`Program ${PUMP} failed: custom program error: 0x1770`] }).message, /paused/);
});

test("running out of SOL or time reads the same everywhere", () => {
  assert.match(chainError({ message: "Transfer: insufficient lamports 4000000, need 1000000000" }).message, /doesn't have enough SOL/);
  assert.match(chainError({ message: "Blockhash not found" }).message, /expired/);
  assert.match(chainError({ message: "", logs: swapLogs(["Transfer: insufficient lamports 1, need 2"]) }).message, /enough for that trade/);
});
