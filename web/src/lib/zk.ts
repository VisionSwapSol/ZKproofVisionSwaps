import ZkWorker from "../workers/zk.worker.ts?worker";
import { IS_EXTENSION } from "./platform";

type Pending = { res: (v: Record<string, unknown>) => void; rej: (e: Error) => void };

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, Pending>();

function w(): Worker {
  if (worker) return worker;
  worker = new ZkWorker();
  worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; error?: string }>) => {
    const p = waiting.get(ev.data.id);
    if (!p) return;
    waiting.delete(ev.data.id);
    if (ev.data.ok) p.res(ev.data as unknown as Record<string, unknown>);
    else p.rej(new Error(ev.data.error || "proof worker error"));
  };
  worker.onerror = (e) => {
    for (const p of waiting.values()) p.rej(new Error(e.message || "proof worker crashed"));
    waiting.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function call<T>(msg: Record<string, unknown>): Promise<T> {
  const id = ++seq;
  return new Promise<T>((res, rej) => {
    waiting.set(id, { res: res as (v: Record<string, unknown>) => void, rej });
    w().postMessage({ ...msg, id });
  });
}

let manifest: { wasm: string; zkey: string } | null = null;
export async function zkFiles(): Promise<{ wasm: string; zkey: string }> {
  if (manifest) return manifest;
  // the Chrome Web Store takes only one file called manifest.json per package, so the extension's list has its own name
  const r = await fetch(IS_EXTENSION ? "/zk/proof-files.json" : "/zk/manifest.json", { cache: "no-cache" });
  const m = (await r.json()) as { wasm: string; zkey: string };
  manifest = { wasm: new URL(m.wasm, location.origin).href, zkey: new URL(m.zkey, location.origin).href };
  return manifest;
}

/**
 * Starts downloading the proving files early so the first proof is quick: the proof worker fetches
 * them and checks them against the hashes pinned in the app (VS-54), keeping the checked bytes.
 */
export async function warmUp() {
  try {
    const m = await zkFiles();
    await call({ type: "warm", wasm: m.wasm, zkey: m.zkey });
  } catch {
    /* it will be fetched (and checked) again when needed */
  }
}
