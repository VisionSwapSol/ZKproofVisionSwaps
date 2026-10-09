import { test } from "node:test";
import assert from "node:assert/strict";
import { rpcFetchWithFallback } from "../src/chain.ts";

test("when the main RPC says 'too many requests' and the fallback refuses, the 429 is handed back so the client waits and retries", async () => {
  const real = globalThis.fetch;
  const answers: Record<string, number> = { "https://main.example": 429, "https://fallback.example": 403 };
  globalThis.fetch = (async (url: string) => new Response("{}", { status: answers[url] })) as typeof fetch;
  try {
    const f = rpcFetchWithFallback("https://main.example", "https://fallback.example");
    assert.equal((await f("x", { method: "POST", body: "{}" })).status, 429);
    answers["https://main.example"] = 500;
    assert.equal((await f("x", { method: "POST", body: "{}" })).status, 403, "with no 429 the last answer stands");
    answers["https://fallback.example"] = 200;
    assert.equal((await f("x", { method: "POST", body: "{}" })).status, 200, "a working fallback is used");
  } finally {
    globalThis.fetch = real;
  }
});
