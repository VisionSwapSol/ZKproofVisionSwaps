import { PublicKey } from "@solana/web3.js";
import { fromBE } from "./field.ts";
import { META_LEN } from "./notes.ts";
import { EVENT_DISC, Reader } from "./program.ts";

export type PoolEvent =
  | { kind: "queued"; depositor: string; amount: bigint; inner: bigint; slot: bigint }
  | { kind: "settled"; index: number; leaf: bigint; amount: bigint; meta: Uint8Array; root: bigint }
  | { kind: "refunded"; depositor: string; amount: bigint; inner: bigint; byGuard: boolean }
  | {
      kind: "spent";
      index: number;
      commitments: [bigint, bigint];
      metas: [Uint8Array, Uint8Array];
      nullifiers: [bigint, bigint];
      withdraw: bigint;
      root: bigint;
    };

const same = (a: Uint8Array, b: Uint8Array) => a.length >= 8 && b.every((v, i) => a[i] === v);

export function decodeEvent(data: Uint8Array): PoolEvent | null {
  const r = new Reader(data, 8);
  try {
    if (same(data, EVENT_DISC.DepositQueued)) {
      return {
        kind: "queued",
        depositor: new PublicKey(r.bytes(32)).toBase58(),
        amount: r.u64(),
        inner: fromBE(r.bytes(32)),
        slot: r.u64(),
      };
    }
    if (same(data, EVENT_DISC.DepositSettled)) {
      return {
        kind: "settled",
        index: Number(r.u64()),
        leaf: fromBE(r.bytes(32)),
        amount: r.u64(),
        meta: r.bytes(META_LEN),
        root: fromBE(r.bytes(32)),
      };
    }
    if (same(data, EVENT_DISC.DepositRefunded)) {
      return {
        kind: "refunded",
        depositor: new PublicKey(r.bytes(32)).toBase58(),
        amount: r.u64(),
        inner: fromBE(r.bytes(32)),
        byGuard: r.bool(),
      };
    }
    if (same(data, EVENT_DISC.Spent)) {
      const index = Number(r.u64());
      const c0 = fromBE(r.bytes(32));
      const c1 = fromBE(r.bytes(32));
      const m0 = r.bytes(META_LEN);
      const m1 = r.bytes(META_LEN);
      const n0 = fromBE(r.bytes(32));
      const n1 = fromBE(r.bytes(32));
      return {
        kind: "spent",
        index,
        commitments: [c0, c1],
        metas: [m0, m1],
        nullifiers: [n0, n1],
        withdraw: r.u64(),
        root: fromBE(r.bytes(32)),
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Pulls our program's events out of a transaction's log lines. Only data
 * logged while our program is the innermost running program is accepted, so
 * another program cannot forge pool events by logging look-alike bytes.
 */
export function eventsFromLogs(logs: string[], programId: string): PoolEvent[] {
  const out: PoolEvent[] = [];
  const stack: string[] = [];
  for (const line of logs) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    if (/^Program \w+ (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    if (line.startsWith("Program data: ") && stack[stack.length - 1] === programId) {
      const bytes = Uint8Array.from(atob(line.slice(14)), (c) => c.charCodeAt(0));
      const ev = decodeEvent(bytes);
      if (ev) out.push(ev);
    }
  }
  return out;
}

/** A leaf as the client sees it: what it needs to rebuild the tree and find its notes. */
export type LeafRecord = { index: number; leaf: bigint; meta: Uint8Array };

export function leavesFromEvents(events: PoolEvent[]): LeafRecord[] {
  const out: LeafRecord[] = [];
  for (const e of events) {
    if (e.kind === "settled") out.push({ index: e.index, leaf: e.leaf, meta: e.meta });
    if (e.kind === "spent") {
      out.push({ index: e.index, leaf: e.commitments[0], meta: e.metas[0] });
      out.push({ index: e.index + 1, leaf: e.commitments[1], meta: e.metas[1] });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}
