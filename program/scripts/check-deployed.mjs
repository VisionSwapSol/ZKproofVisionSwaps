// Read-only: compares the program deployed on-chain with program/RELEASES.json.
//   node program/scripts/check-deployed.mjs [--rpc https://api.mainnet-beta.solana.com] [--program <id>]
//
// Prints the deployed code's executable hash (sha256 without trailing zeros, the
// number `solana-verify get-program-hash` prints), the slot of the last deploy and
// the upgrade authority, and which RELEASES.json entry those bytes are. Exits 1
// when the deployed code is not the entry marked "deployed". Sends nothing and
// signs nothing; it only reads two accounts.
import { MAINNET, executableHash, readReleases } from "./releases.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const RPC = arg("--rpc", "https://api.mainnet-beta.solana.com");
const PROGRAM = arg("--program", "VSwJY1r9S7nNUyvBzWYr1rBkEMyTAjDFGtixxLGpmt6");
const CLUSTER = arg("--cluster", MAINNET);

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(buf) {
  let x = BigInt("0x" + (Buffer.from(buf).toString("hex") || "0"));
  let s = "";
  while (x > 0n) {
    s = B58[Number(x % 58n)] + s;
    x /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

async function account(address) {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64", commitment: "confirmed" }] }),
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      continue;
    }
    const j = await res.json();
    if (j.error) throw new Error(JSON.stringify(j.error));
    return j.result.value;
  }
  throw new Error("the RPC keeps saying it is busy; try again or pass --rpc");
}

const prog = await account(PROGRAM);
if (!prog?.executable) throw new Error(`${PROGRAM} is not a deployed program on this cluster`);
if (prog.owner !== "BPFLoaderUpgradeab1e11111111111111111111111") throw new Error(`unexpected loader ${prog.owner}`);
const programData = b58(Buffer.from(prog.data[0], "base64").subarray(4, 36));
const pd = Buffer.from((await account(programData)).data[0], "base64");
const slot = Number(pd.readBigUInt64LE(4));
const authority = pd[12] === 1 ? b58(pd.subarray(13, 45)) : null;
const hash = executableHash(pd.subarray(45));

const doc = readReleases();
const entry = doc.releases.find((r) => r.programId === PROGRAM && r.cluster === CLUSTER && r.executableHash === hash);
console.log(`
  Program           ${PROGRAM}
  Program data      ${programData}
  Last deployed     slot ${slot}
  Upgrade authority ${authority ?? "none (the program is permanent)"}
  Executable hash   ${hash}
  RELEASES.json     ${entry ? `version ${entry.version}, status "${entry.status}"${entry.deployedSlot === slot ? `, deployedSlot ${slot} matches` : `, but its deployedSlot is ${entry.deployedSlot}`}` : "NOT LISTED: the deployed code is not a recorded release"}
`);
process.exitCode = entry && entry.status === "deployed" && entry.deployedSlot === slot ? 0 : 1;
