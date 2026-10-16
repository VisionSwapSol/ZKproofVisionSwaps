/**
 * Features built but switched off until the owner turns them on, at build time. Off by default, and
 * nothing public mentions a feature while it is off: its code isn't even in the build then.
 *
 *   VITE_RECEIPTS=1   payment receipts ("proof of source", P1-1): Your records can prove where one
 *                     payment came from, and /verify checks receipts. Waits for the circuit and program
 *                     owner's sign-off on the receipt's soundness (owner decision D12), and for the
 *                     server's /api/pool/txs index.
 *
 * The build writes the switch in as a constant, __VS_RECEIPTS__ (web/vite.config.ts and
 * extension/scripts/build.mjs). Code behind it tests `typeof __VS_RECEIPTS__ === "boolean" &&
 * __VS_RECEIPTS__` where it stands, so the bundler drops it when the switch is off; anything that runs
 * without the build's constant (the node tests) reads it as off.
 */
declare global {
  /** true only in a build made with VITE_RECEIPTS=1 */
  const __VS_RECEIPTS__: boolean | undefined;
}

export const RECEIPTS_ENABLED: boolean = typeof __VS_RECEIPTS__ === "boolean" && __VS_RECEIPTS__;
