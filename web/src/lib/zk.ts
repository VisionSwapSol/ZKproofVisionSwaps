import ZkWorker from "../workers/zk.worker.ts?worker";

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
  const r = await fetch("/zk/manifest.json", { cache: "no-cache" });
  const m = (await r.json()) as { wasm: string; zkey: string };
  manifest = { wasm: new URL(m.wasm, location.origin).href, zkey: new URL(m.zkey, location.origin).href };
  return manifest;
}

/** Starts downloading the proving files early so the first proof is quick. */
export async function warmUp() {
  try {
    const m = await zkFiles();
    await Promise.all([fetch(m.wasm), fetch(m.zkey)]);
  } catch {
    /* it will be fetched again when needed */
  }
}
