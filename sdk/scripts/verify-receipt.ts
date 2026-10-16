// Checks a VisionSwap payment receipt against the chain, with any Solana RPC you choose (your own
// node is best: nothing then goes through VisionSwap).
//
//   node --import tsx sdk/scripts/verify-receipt.ts receipt.json --rpc https://your-rpc.example [--program <id>]
//
// It reads each transaction the receipt names, checks that every one succeeded and that the pool
// program's own events match the receipt, and prints what the receipt shows. Exit code 0: valid.
import { readFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { MAINNET_PROGRAM_ID } from "../src/pins.ts";
import { Pool } from "../src/program.ts";
import { receiptTxFrom, verifyReceipt } from "../src/receipt.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const rpc = flag("--rpc");
if (!file || !rpc) {
  console.error("usage: node --import tsx sdk/scripts/verify-receipt.ts receipt.json --rpc <RPC URL> [--program <program id>]");
  process.exit(2);
}
const programId = flag("--program") ?? MAINNET_PROGRAM_ID;
const conn = new Connection(rpc, "confirmed");
const receipt = JSON.parse(readFileSync(file, "utf8"));
const pool = new Pool(new PublicKey(programId));
const cfg = await conn.getAccountInfo(pool.config, "confirmed").catch(() => null);
const guard = cfg ? pool.decodeConfig(cfg.data).guard.toBase58() : undefined;
const sol = (l: bigint) => (Number(l) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 });

const check = await verifyReceipt(
  receipt,
  async (sig) => receiptTxFrom(await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 1 })),
  { programId, guard },
);
if (!check.ok) {
  console.log("NOT VALID");
  for (const p of check.problems) console.log(`  - ${p}`);
  process.exit(1);
}
const p = check.payment!;
console.log("VALID");
console.log(`  payment ${p.tx}: ${sol(p.withdraw)} SOL left the pool to ${p.recipient}`);
if (p.delivery) console.log(`  delivered: ${sol(p.delivery.lamports)} SOL to ${p.delivery.to} (${p.delivery.tx})`);
console.log(p.complete ? "  all of it came from the notes below" : "  it spent the notes below (other value may have joined: its outputs weren't opened)");
for (const s of check.sources) {
  if (s.kind === "deposit") {
    const pass = s.pass ? (s.pass.current ? "screening pass from the pool's screening key" : `screening pass signed by ${s.pass.guard}`) : "no screening pass before the deposit";
    console.log(`  - ${sol(s.amount)} SOL deposited by ${s.depositor} (${s.depositTx}, joined in ${s.settleTx}); ${pass}`);
  } else if (s.kind === "received") console.log(`  - ${sol(s.amount)} SOL received privately inside the pool (${s.tx}); the trail stops there`);
  else console.log(`  - ${sol(s.amount)} SOL from an earlier payment of the same account (${s.tx}), not opened`);
}
if (check.links) console.log(`  opens ${check.links} earlier payment${check.links === 1 ? "" : "s"} of the same account`);
if (check.bound.length) console.log(`  ownership proven for: ${check.bound.join(", ")}`);
