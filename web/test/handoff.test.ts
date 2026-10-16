import { test } from "node:test";
import assert from "node:assert/strict";
import { afterHandoff, handoffDefer, WALLET_HANDOFF_MS, type Timers, type VisibilityDoc } from "../src/lib/handoff.ts";

/** A page whose visibility the test changes, and timers the test runs by hand. */
function setup(visibility = "visible") {
  const listeners = new Set<() => void>();
  const doc: VisibilityDoc & { show(v: string): void; listeners: Set<() => void> } = {
    visibilityState: visibility,
    addEventListener: (_t, fn) => void listeners.add(fn),
    removeEventListener: (_t, fn) => void listeners.delete(fn),
    show(v: string) {
      this.visibilityState = v;
      for (const fn of [...listeners]) fn();
    },
    listeners,
  };
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const timers: Timers & { fire(): void; pending: typeof pending } = {
    setTimeout: (fn, ms) => {
      pending.set(next, { fn, ms });
      return next++;
    },
    clearTimeout: (id) => void pending.delete(id as number),
    fire() {
      for (const [id, t] of [...pending]) {
        pending.delete(id);
        t.fn();
      }
    },
    pending,
  };
  let runs = 0;
  const start = () => void runs++;
  return { doc, timers, start, runs: () => runs };
}

test("only Android holds the work back, and for longer than Chrome's 5-second tap window", () => {
  assert.ok(WALLET_HANDOFF_MS > 5000);
  assert.equal(handoffDefer("Mozilla/5.0 (Linux; Android 16; Pixel) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36"), WALLET_HANDOFF_MS);
  assert.equal(handoffDefer("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36"), 0);
  assert.equal(handoffDefer("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"), 0);
  assert.equal(handoffDefer(undefined), 0);
  assert.equal(handoffDefer(null), 0);
});

test("no hold: the work starts at once, as before", () => {
  const s = setup();
  afterHandoff(s.start, 0, s.doc, s.timers);
  assert.equal(s.runs(), 1);
  assert.equal(s.timers.pending.size, 0);
  assert.equal(s.doc.listeners.size, 0);
});

test("the wallet opened: the work waits while the page is hidden and starts when it is back on screen", () => {
  const s = setup();
  afterHandoff(s.start, WALLET_HANDOFF_MS, s.doc, s.timers);
  assert.equal(s.runs(), 0);
  s.doc.show("hidden");
  assert.equal(s.runs(), 0);
  s.timers.fire(); // the hold runs out while the wallet is still in front
  assert.equal(s.runs(), 0);
  s.doc.show("visible");
  assert.equal(s.runs(), 1);
  // once only, and nothing left behind
  s.doc.show("hidden");
  s.doc.show("visible");
  s.timers.fire();
  assert.equal(s.runs(), 1);
  assert.equal(s.doc.listeners.size, 0);
});

test("back on screen before the hold ran out: the work starts then, and the timer is cleared", () => {
  const s = setup();
  afterHandoff(s.start, WALLET_HANDOFF_MS, s.doc, s.timers);
  s.doc.show("hidden");
  s.doc.show("visible");
  assert.equal(s.runs(), 1);
  assert.equal(s.timers.pending.size, 0);
  s.timers.fire();
  assert.equal(s.runs(), 1);
});

test("no wallet opened: the work starts when the hold runs out", () => {
  const s = setup();
  afterHandoff(s.start, WALLET_HANDOFF_MS, s.doc, s.timers);
  assert.equal([...s.timers.pending.values()][0].ms, WALLET_HANDOFF_MS);
  s.timers.fire();
  assert.equal(s.runs(), 1);
  assert.equal(s.doc.listeners.size, 0);
});

test("cancelled (the overlay closed first): the work never starts", () => {
  const s = setup();
  const cancel = afterHandoff(s.start, WALLET_HANDOFF_MS, s.doc, s.timers);
  s.doc.show("hidden");
  cancel();
  s.doc.show("visible");
  s.timers.fire();
  assert.equal(s.runs(), 0);
  assert.equal(s.doc.listeners.size, 0);
  assert.equal(s.timers.pending.size, 0);
});

test("a page that starts hidden waits for the screen, even after the hold", () => {
  const s = setup("hidden");
  afterHandoff(s.start, WALLET_HANDOFF_MS, s.doc, s.timers);
  s.timers.fire();
  assert.equal(s.runs(), 0);
  s.doc.show("visible");
  assert.equal(s.runs(), 1);
});
