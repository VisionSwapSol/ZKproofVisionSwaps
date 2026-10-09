/** Tiny IndexedDB key-value store for the pool cache. Fails soft: no cache, no problem. */
const DB = "visionswap";
const STORE = "kv";

// one connection, opened on first use and kept
let db: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  db ??= new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => {
      // closed by the browser (storage cleared, another tab upgrading): open again next time
      r.result.onclose = () => (db = null);
      r.result.onversionchange = () => {
        r.result.close();
        db = null;
      };
      res(r.result);
    };
    r.onerror = () => rej(r.error);
  }).catch((e) => {
    db = null;
    throw e;
  });
  return db;
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await open();
    return await new Promise<T | undefined>((res, rej) => {
      const t = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      t.onsuccess = () => res(t.result as T | undefined);
      t.onerror = () => rej(t.error);
    });
  } catch {
    return undefined;
  }
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((res, rej) => {
      const t = db.transaction(STORE, "readwrite").objectStore(STORE).put(value, key);
      t.onsuccess = () => res();
      t.onerror = () => rej(t.error);
    });
  } catch {
    /* private mode or storage blocked */
  }
}

export async function idbDel(key: string): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((res) => {
      const t = db.transaction(STORE, "readwrite").objectStore(STORE).delete(key);
      t.onsuccess = () => res();
      t.onerror = () => res();
    });
  } catch {
    /* ignore */
  }
}

/** Like idbGet, but a storage error throws instead of reading as "not there". */
export async function idbRead<T>(key: string): Promise<T | undefined> {
  const db = await open();
  return new Promise<T | undefined>((res, rej) => {
    const t = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    t.onsuccess = () => res(t.result as T | undefined);
    t.onerror = () => rej(t.error);
  });
}

export const ls = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(k);
      return v ? (JSON.parse(v) as T) : d;
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  },
};
