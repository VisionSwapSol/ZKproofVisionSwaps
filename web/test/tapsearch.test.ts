import { test } from "node:test";
import assert from "node:assert/strict";
import { claimsTap, hasTouchToSearch, NATIVE_ACTION } from "../src/lib/tapsearch.ts";

/** A stand-in for an element: `inside` lists the selectors of the ancestors it sits in. */
const el = (inside: Record<string, unknown> = {}) => ({
  closest: (s: string) => (s in inside ? inside[s] : null),
});
const tap = (target: unknown, more: { pointerType?: string; defaultPrevented?: boolean } = {}) =>
  claimsTap({ target: target as EventTarget, pointerType: "touch", defaultPrevented: false, ...more });

test("a finger tap on plain text is claimed, so Chrome doesn't hand it to Touch to Search", () => {
  assert.equal(tap(el()), true);
  // text in a label that labels nothing is plain text too
  assert.equal(tap(el({ label: { control: null } })), true);
});

test("taps on links, buttons, fields, labels of a field and summaries keep their own action", () => {
  assert.equal(tap(el({ [NATIVE_ACTION]: {} })), false);
  assert.equal(tap(el({ label: { control: {} } })), false);
  const parts = NATIVE_ACTION.split(",").map((s) => s.trim());
  for (const s of ["a[href]", "area[href]", "button", "input", "select", "textarea", "summary", "option"]) assert.ok(parts.includes(s), s);
  assert.ok(parts.some((s) => s.startsWith("[contenteditable]")));
});

test("mouse, pen and keyboard clicks, clicks already handled, and clicks on no element are left alone", () => {
  assert.equal(tap(el(), { pointerType: "mouse" }), false);
  assert.equal(tap(el(), { pointerType: "pen" }), false);
  assert.equal(tap(el(), { pointerType: "" }), false);
  assert.equal(tap(el(), { pointerType: undefined }), false);
  assert.equal(tap(el(), { defaultPrevented: true }), false);
  assert.equal(tap(null), false);
  assert.equal(tap({}), false);
});

test("only Chrome on Android (and the Android app) gets the guard", () => {
  assert.equal(hasTouchToSearch("Mozilla/5.0 (Linux; Android 16; sdk_gphone64_x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36"), true);
  assert.equal(hasTouchToSearch("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"), false);
  assert.equal(hasTouchToSearch("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), false);
  assert.equal(hasTouchToSearch(null), false);
});
