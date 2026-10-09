import { Buffer } from "buffer";

// @solana/web3.js and the wallet adapters expect Node's Buffer.
const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (!g.Buffer) g.Buffer = Buffer;
