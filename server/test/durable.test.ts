import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, seal, unseal, stateKey, type Remote } from "../src/durable.ts";

const key = stateKey(new Uint8Array(64).fill(7));
const otherKey = stateKey(new Uint8Array(64).fill(8));
const live = { scope: "deployment" as const };

/** An in-memory stand-in for App Storage that can be switched off, or made to hang. */
function fakeRemote() {
  const objects = new Map<string, string>();
  let mode: "up" | "down" | "hang" = "up";
  let puts = 0;
  let slow = 0;
  const gate = () => {
    if (mode === "down") throw new Error("outage");
    if (mode === "hang") return new Promise<never>(() => {});
  };
  const r: Remote & { objects: Map<string, string>; set(m: typeof mode): void; puts(): number; slowPuts(ms: number): void } = {
    name: "fake",
    objects,
    set: (m) => (mode = m),
    puts: () => puts,
    slowPuts: (ms) => (slow = ms),
    async put(k, t) {
      await gate();
      if (slow) await new Promise((r) => setTimeout(r, slow));
      puts++;
      objects.set(k, t);
    },
    async get(k) {
      await gate();
      return objects.get(k);
    },
    async del(k) {
      objects.delete(k);
    },
  };
  return r;
}

function withDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-durable-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("sealed state opens only with the same key, name and writer", () => {
  const text = JSON.stringify([{ id: "a", secret: "very secret" }]);
  const sealed = seal(key, "orders", text, "deployment", 5);
  assert.ok(!sealed.includes("very secret"), "nothing readable is stored");
  assert.deepEqual(unseal(key, "orders", sealed, "deployment"), { text, at: 5 });
  assert.throws(() => unseal(otherKey, "orders", sealed, "deployment"), /different relayer key/);
  assert.throws(() => unseal(key, "scheduled", sealed, "deployment"), /damaged/, "one slot's file can't stand in for another's");
  assert.throws(() => unseal(key, "orders", sealed, "workspace"), /deployment copy/, "the workspace's copy is never the live one");
  const env = JSON.parse(sealed);
  assert.throws(() => unseal(key, "orders", JSON.stringify({ ...env, at: 9 }), "deployment"), /damaged/, "the save time can't be changed");
  assert.throws(() => unseal(key, "orders", JSON.stringify({ ...env, scope: "workspace" }), "workspace"), /damaged/, "nor who wrote it");
  assert.throws(() => unseal(key, "orders", JSON.stringify({ ...env, data: Buffer.from("x").toString("base64") }), "deployment"), /damaged/);
  assert.throws(() => unseal(key, "orders", "{not json", "deployment"), /damaged/);
  // files from before sealing are read only when asked for (this machine's own file)
  assert.equal(unseal(key, "orders", "[]", "local", { allowLegacy: true }).text, "[]");
  assert.throws(() => unseal(key, "orders", "[]", "local"), /isn't sealed/);
});

test(
  "saves are coalesced, sealed on disk, uploaded, and come back on a fresh machine",
  withDir(async (dir) => {
    const remote = fakeRemote();
    const a = new StateStore(join(dir, "a"), key, remote, live);
    let calls = 0;
    const list = [{ id: "x", secret: "s3cret" }];
    for (let i = 0; i < 5; i++)
      a.save("orders", () => {
        calls++;
        return JSON.stringify(list);
      });
    await a.flush();
    assert.equal(calls, 1, "five saves, one serialization");
    const local = readFileSync(join(dir, "a", "orders.json"), "utf8");
    assert.ok(!local.includes("s3cret"), "the disk copy is sealed");
    assert.equal(remote.objects.get("state/orders.json"), local);

    // an unchanged save writes and uploads nothing
    const puts = remote.puts();
    a.save("orders", JSON.stringify(list));
    await a.flush();
    assert.equal(remote.puts(), puts);

    // a republish: empty disk, same bucket
    const b = new StateStore(join(dir, "b"), key, remote, live);
    assert.equal(await b.load("orders"), JSON.stringify(list));
    assert.equal(b.restored.orders, "remote");
    await b.flush();
    assert.ok(existsSync(join(dir, "b", "orders.json")), "kept locally for the next restart");
    assert.equal(await b.load("scheduled"), null);
    assert.equal(b.restored.scheduled, "none");
    assert.deepEqual(Object.keys(b.status()).sort(), ["backend", "errors", "restored", "saved"], "health shows no save times");
    assert.equal(b.status().saved, true);
  }),
);

test(
  "a published site ignores the workspace's files that came with it and keeps the live copy",
  withDir(async (dir) => {
    const remote = fakeRemote();
    remote.objects.set("state/orders.json", seal(key, "orders", '[{"id":"live"}]', "deployment", 1000));
    // the workspace's own sealed copy, newer than the live one
    writeFileSync(join(dir, "orders.json"), seal(key, "orders", "[]", "workspace", 2000));
    // and an older unsealed file
    writeFileSync(join(dir, "scheduled.json"), "[]");
    remote.objects.set("state/scheduled.json", seal(key, "scheduled", '[{"id":"job"}]', "deployment", 1000));
    const s = new StateStore(dir, key, remote, live);
    assert.equal(await s.load("orders"), '[{"id":"live"}]');
    assert.equal(await s.load("scheduled"), '[{"id":"job"}]');
    assert.equal(s.restored.orders, "remote");
    await s.flush();
    assert.equal(unseal(key, "orders", remote.objects.get("state/orders.json")!, "deployment").text, '[{"id":"live"}]', "nothing uploaded over it");
    assert.equal(unseal(key, "orders", readFileSync(join(dir, "orders.json"), "utf8"), "deployment").text, '[{"id":"live"}]');

    // even with nothing stored, an unsealed file never becomes the live list
    const t = new StateStore(join(dir, "t"), key, fakeRemote(), live);
    writeFileSync(join(dir, "t", "orders.json"), '[{"id":"stale"}]');
    assert.equal(await t.load("orders"), null);
  }),
);

test(
  "the newer of this machine's copy and the stored one wins",
  withDir(async (dir) => {
    const remote = fakeRemote();
    remote.objects.set("state/orders.json", seal(key, "orders", '["old"]', "deployment", 1000));
    writeFileSync(join(dir, "orders.json"), seal(key, "orders", '["new"]', "deployment", 2000));
    const s = new StateStore(dir, key, remote, live);
    assert.equal(await s.load("orders"), '["new"]');
    assert.equal(s.restored.orders, "local");
    await s.flush();
    assert.equal(unseal(key, "orders", remote.objects.get("state/orders.json")!, "deployment").text, '["new"]', "and is sent up");

    writeFileSync(join(dir, "scheduled.json"), seal(key, "scheduled", '["old"]', "deployment", 1000));
    remote.objects.set("state/scheduled.json", seal(key, "scheduled", '["new"]', "deployment", 2000));
    assert.equal(await s.load("scheduled"), '["new"]');
    assert.equal(s.restored.scheduled, "remote");
    await s.flush();
  }),
);

test(
  "a store that can't be read at the start is added back later, never replaced by an empty list",
  withDir(async (dir) => {
    const remote = fakeRemote();
    remote.objects.set("state/scheduled.json", seal(key, "scheduled", '[{"id":"old"}]', "deployment", 1000));
    remote.set("down");
    const s = new StateStore(dir, key, remote, { ...live, retryMs: [1], recheckMs: [20] });
    let late: string | undefined;
    const added = new Promise<void>((done) => {
      void s
        .load("scheduled", (text) => {
          late = text;
          s.save("scheduled", JSON.stringify([...JSON.parse(text), { id: "new" }]));
          done();
        })
        .then((text) => assert.equal(text, null));
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s.restored.scheduled, "unavailable");
    assert.equal(s.status().backend, "fake (unreachable)", "an outage doesn't read as a missing bucket");
    // the scheduler saves its empty list meanwhile: kept on disk, not uploaded
    s.save("scheduled", "[]");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(unseal(key, "scheduled", remote.objects.get("state/scheduled.json")!, "deployment").text, '[{"id":"old"}]');
    remote.set("up");
    await added;
    assert.equal(late, '[{"id":"old"}]');
    await s.flush();
    assert.equal(unseal(key, "scheduled", remote.objects.get("state/scheduled.json")!, "deployment").text, '[{"id":"old"},{"id":"new"}]');
    assert.equal(s.status().backend, "fake");
  }),
);

test(
  "a hanging store holds up the start only until the time limit",
  withDir(async (dir) => {
    const remote = fakeRemote();
    remote.set("hang");
    const s = new StateStore(dir, key, remote, { ...live, restoreBy: Date.now() + 100, recheckMs: [60_000] });
    const t0 = Date.now();
    assert.equal(await s.load("orders", () => {}), null);
    assert.ok(Date.now() - t0 < 2_000);
    assert.equal(s.restored.orders, "unavailable");
  }),
);

test(
  "an unsealed list in the bucket is never taken",
  withDir(async (dir) => {
    const remote = fakeRemote();
    remote.objects.set("state/orders.json", '[{"id":"planted","secret":"x"}]');
    const s = new StateStore(dir, key, remote, live);
    assert.equal(await s.load("orders"), null);
    assert.equal(s.restored.orders, "unreadable");
    assert.ok([...remote.objects.keys()].some((k) => k.startsWith("state/orders.unreadable-")));
  }),
);

test(
  "a changed key starts empty without crashing and keeps the old file aside",
  withDir(async (dir) => {
    writeFileSync(join(dir, "orders.json"), seal(otherKey, "orders", "[1]", "local", 1));
    const s = new StateStore(dir, key, null);
    assert.equal(await s.load("orders"), null);
    assert.equal(s.restored.orders, "unreadable");
    assert.ok(readdirSync(dir).some((f) => f.startsWith("orders.unreadable-")));
  }),
);

test(
  "a plain file from an older version is read, then sealed (outside a published site)",
  withDir(async (dir) => {
    writeFileSync(join(dir, "orders.json"), '[{"id":"legacy","secret":"plain"}]');
    const s = new StateStore(dir, key, null);
    assert.equal(await s.load("orders"), '[{"id":"legacy","secret":"plain"}]');
    await s.flush();
    const now = readFileSync(join(dir, "orders.json"), "utf8");
    assert.ok(!now.includes("plain"));
    assert.equal(unseal(key, "orders", now, "local").text, '[{"id":"legacy","secret":"plain"}]');
  }),
);

test(
  "saveNow is on disk when it resolves; restoring() is true until a late store has been read",
  withDir(async (dir) => {
    const remote = fakeRemote();
    remote.objects.set("state/orders.json", seal(key, "orders", '[{"id":"old"}]', "deployment", 1000));
    remote.set("down");
    const s = new StateStore(dir, key, remote, { ...live, retryMs: [1], recheckMs: [20] });
    const added = new Promise<void>((done) => void s.load("orders", () => done()));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s.restoring("orders"), true);
    await s.saveNow("orders", '[{"id":"sent"}]');
    assert.equal(unseal(key, "orders", readFileSync(join(dir, "orders.json"), "utf8"), "deployment").text, '[{"id":"sent"}]', "written before it resolved");
    remote.set("up");
    await added;
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(s.restoring("orders"), false);
  }),
);

const quick = { renewMs: 20, ttlMs: 120, pollMs: 10, holdMs: 80 };

test(
  "a new copy of the published site waits for the old one to hand over before it reads anything",
  withDir(async (dir) => {
    const remote = fakeRemote();
    const old = new StateStore(join(dir, "a"), key, remote, { ...live, lease: quick });
    assert.equal(await old.takeOver("old"), true, "nothing stored yet: taken after the short hold");
    await old.load("orders");
    old.save("orders", "[1]");
    // the new copy starts while the old one still runs (and renews)
    const fresh = new StateStore(join(dir, "b"), key, remote, { ...live, lease: quick });
    let took = false;
    const t = fresh.takeOver("new").then((ok) => (took = ok));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(took, false, "the old copy is still renewing: no limit on the wait");
    // its last save, then the hand-over
    old.save("orders", "[1,2]");
    await old.flush();
    await old.release();
    await t;
    assert.equal(took, true);
    assert.equal(await fresh.load("orders"), "[1,2]", "the new copy reads the old copy's last save");
    await fresh.release();
  }),
);

test(
  "a copy that stopped without handing over is waited for only until its lease goes quiet, and a shutdown stops the wait",
  withDir(async (dir) => {
    const remote = fakeRemote();
    const old = new StateStore(join(dir, "a"), key, remote, { ...live, lease: quick });
    await old.takeOver("old");
    old.stopRenewing(); // it crashed
    const fresh = new StateStore(join(dir, "b"), key, remote, { ...live, lease: quick });
    const t0 = Date.now();
    assert.equal(await fresh.takeOver("new"), true);
    assert.ok(Date.now() - t0 >= quick.ttlMs, "waited for the lease to go quiet");
    // a third copy shut down while it waits gives up, and takes nothing
    const third = new StateStore(join(dir, "c"), key, remote, { ...live, lease: quick });
    let stop = false;
    const t = third.takeOver("third", () => stop);
    stop = true;
    assert.equal(await t, false);
    assert.match(remote.objects.get("state/lease.json") ?? "", /"instance":"new"/);
    fresh.stopRenewing();
    // anywhere but the published site there is nothing to wait for
    const local = new StateStore(join(dir, "d"), key, remote, { lease: quick });
    assert.equal(await local.takeOver("x"), true);
  }),
);

test(
  "a moment when App Storage doesn't answer doesn't end the wait for a copy that is still renewing",
  withDir(async (dir) => {
    const remote = fakeRemote();
    const old = new StateStore(join(dir, "a"), key, remote, { ...live, lease: quick });
    await old.takeOver("old");
    const fresh = new StateStore(join(dir, "b"), key, remote, { ...live, lease: quick });
    let took = false;
    const t = fresh.takeOver("new").then((ok) => (took = ok));
    // past the short hold, storage stops answering for less than the lease's life
    await new Promise((r) => setTimeout(r, quick.holdMs + 30));
    remote.set("down");
    await new Promise((r) => setTimeout(r, quick.ttlMs / 2));
    remote.set("up");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(took, false, "the old copy renewed again: still its turn");
    assert.ok((fresh.handover().waitingSec ?? -1) >= 0, "health can see the wait");
    await old.release();
    await t;
    assert.equal(took, true);
    assert.equal(fresh.handover().waitingSec, null);
    await fresh.release();
  }),
);

test(
  "a copy that never stops is taken over after the cap; it stands down and uploads nothing more",
  withDir(async (dir) => {
    const remote = fakeRemote();
    const old = new StateStore(join(dir, "a"), key, remote, { ...live, lease: quick });
    let lost = 0;
    await old.takeOver("old", undefined, { onLost: () => lost++ });
    await old.load("orders");
    const fresh = new StateStore(join(dir, "b"), key, remote, { ...live, lease: { ...quick, capMs: 250 } });
    const t0 = Date.now();
    assert.equal(await fresh.takeOver("new"), true);
    assert.ok(Date.now() - t0 >= 250, "it waited the cap out");
    await new Promise((r) => setTimeout(r, quick.renewMs * 4));
    assert.equal(lost, 1, "the old copy saw the new lease and stood down");
    assert.equal(old.handover().lost, true);
    const before = remote.objects.get("state/orders.json");
    old.save("orders", "[9]");
    await old.flush();
    assert.equal(remote.objects.get("state/orders.json"), before, "nothing more uploaded from the old copy");
    assert.match(remote.objects.get("state/lease.json") ?? "", /"instance":"new"/, "and its renewals stopped");
    await old.release();
    assert.match(remote.objects.get("state/lease.json") ?? "", /"instance":"new"/, "its release leaves the new lease alone");
    await fresh.release();
  }),
);

test(
  "a renewal still on its way lands before the hand-over marker, never after it",
  withDir(async (dir) => {
    const remote = fakeRemote();
    const old = new StateStore(join(dir, "a"), key, remote, { ...live, lease: quick });
    await old.takeOver("old");
    remote.slowPuts(60);
    await new Promise((r) => setTimeout(r, quick.renewMs + 15));
    await old.release();
    await new Promise((r) => setTimeout(r, 150));
    assert.match(remote.objects.get("state/lease.json") ?? "", /"released":true/);
    remote.slowPuts(0);
    const fresh = new StateStore(join(dir, "b"), key, remote, { ...live, lease: quick });
    const t0 = Date.now();
    assert.equal(await fresh.takeOver("new"), true);
    assert.ok(Date.now() - t0 < quick.ttlMs, "taken over at once");
    await fresh.release();
  }),
);

/** One copy's own line to App Storage: down for that copy only while `down` says so; `onGet` sees each answer. */
function lineTo(remote: ReturnType<typeof fakeRemote>, down: () => boolean, onGet?: (k: string, v: string | undefined) => void): Remote {
  return {
    name: "fake",
    put: async (k, t) => {
      if (down()) throw new Error("outage");
      await remote.put(k, t);
    },
    get: async (k) => {
      if (down()) throw new Error("outage");
      const v = await remote.get(k);
      onGet?.(k, v);
      return v;
    },
    del: (k) => remote.del(k),
  };
}
const leaseOf = (remote: ReturnType<typeof fakeRemote>) => JSON.parse(remote.objects.get("state/lease.json") ?? "null") as { instance: string; gen: number; released?: boolean } | null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test(
  "App Storage down for a new copy at the start: it never takes over blind, and ends up holding the lease once the old copy hands over",
  withDir(async (dir) => {
    const remote = fakeRemote();
    const old = new StateStore(join(dir, "a"), key, remote, { ...live, lease: quick });
    await old.takeOver("old");
    let down = true;
    const fresh = new StateStore(join(dir, "b"), key, lineTo(remote, () => down), { ...live, lease: quick });
    let lost = 0;
    let took: boolean | null = null;
    const t = fresh.takeOver("new", undefined, { onLost: () => lost++ }).then((ok) => (took = ok));
    await wait(quick.holdMs + quick.ttlMs + 100);
    assert.equal(took, null, "unanswered looks are not 'nothing stored', and not a quiet lease either");
    assert.equal(fresh.handover().unanswered, true, "health can tell App Storage isn't answering");
    down = false;
    await wait(150);
    assert.equal(took, null, "the old copy still renews: still its turn");
    const oldGen = leaseOf(remote)!.gen;
    await old.release();
    await t;
    assert.equal(took, true);
    await wait(quick.renewMs * 5);
    const l = leaseOf(remote)!;
    assert.equal(l.instance, "new");
    assert.ok(l.gen > oldGen);
    assert.equal(fresh.handover().lost, false);
    assert.equal(lost, 0);
    await fresh.release();
  }),
);

test(
  "a stale lease is superseded, never a reason to stand down for good: at the start, and after a pause",
  withDir(async (dir) => {
    const remote = fakeRemote();
    const old = new StateStore(join(dir, "a"), key, remote, { ...live, lease: quick });
    await old.takeOver("old");
    old.stopRenewing(); // it crashed without handing over
    const oldGen = leaseOf(remote)!.gen;
    let down = true;
    const fresh = new StateStore(join(dir, "b"), key, lineTo(remote, () => down), { ...live, lease: quick });
    let lost = 0;
    let regained = 0;
    const t = fresh.takeOver("new", undefined, { onLost: () => lost++, onRegained: () => regained++ });
    await wait(200);
    down = false;
    assert.equal(await t, true, "the lease went quiet once App Storage answered");
    assert.ok(leaseOf(remote)!.gen > oldGen, "the take-over outranks the stale lease");
    // while holding: App Storage stops taking renewals here, and meanwhile a lease above this one is left behind
    down = true;
    await wait(quick.ttlMs);
    assert.equal(lost, 1, "it paused before its lease could count as quiet anywhere else");
    assert.deepEqual([fresh.handover().lost, fresh.handover().paused], [true, true]);
    const left = { instance: "zzz", gen: Number.MAX_SAFE_INTEGER - 1, at: 1 };
    remote.objects.set("state/lease.json", JSON.stringify(left));
    down = false;
    await wait(quick.ttlMs * 2 + 100);
    assert.equal(regained, 1, "the left-behind lease was replaced once it stayed unchanged for its life");
    const l = leaseOf(remote)!;
    assert.equal(l.instance, "new");
    assert.ok(l.gen > left.gen);
    assert.equal(fresh.handover().lost, false);
    await fresh.release();
  }),
);

test(
  "a copy that lost the lease takes it back once the other copy stops, and reads the state again",
  withDir(async (dir) => {
    const remote = fakeRemote();
    const old = new StateStore(join(dir, "a"), key, remote, { ...live, lease: quick });
    let lost = 0;
    let regained = 0;
    await old.takeOver("old", undefined, { onLost: () => lost++, onRegained: () => regained++ });
    await old.load("orders");
    old.save("orders", "[1]");
    await old.flush();
    // a copy that took over after the cap
    const fresh = new StateStore(join(dir, "b"), key, remote, { ...live, lease: { ...quick, capMs: 150 } });
    assert.equal(await fresh.takeOver("new"), true);
    await wait(quick.renewMs * 4);
    assert.equal(lost, 1);
    await wait(quick.ttlMs * 2);
    assert.equal(regained, 0, "a holder that keeps renewing is never taken back from");
    assert.equal(await fresh.load("orders"), "[1]");
    fresh.save("orders", "[1,2]");
    await fresh.flush();
    await fresh.release();
    // an older copy waits a little longer than a new one would, so a new copy starting now always comes first
    await wait(quick.ttlMs * 2 + quick.renewMs * 4);
    assert.equal(regained, 1, "taken back once it handed over");
    assert.equal(old.handover().lost, false);
    assert.equal(await old.load("orders"), "[1,2]", "the other copy's last save is read again");
    old.save("orders", "[1,2,3]");
    await old.flush();
    assert.equal(unseal(key, "orders", remote.objects.get("state/orders.json")!, "deployment").text, "[1,2,3]", "and it saves to App Storage again");
    assert.equal(leaseOf(remote)!.instance, "old");
    await old.release();
    assert.equal(leaseOf(remote)!.released, true);
  }),
);

test(
  "a copy that loses the lease on its first renewal never starts: takeOver says false, and it takes over later",
  withDir(async (dir) => {
    const remote = fakeRemote();
    const old = new StateStore(join(dir, "a"), key, remote, { ...live, lease: quick });
    await old.takeOver("old");
    // a third copy writes its lease right after this one saw the hand-over
    let cut = false;
    const line = lineTo(remote, () => false, (k, v) => {
      if (!cut && k === "state/lease.json" && v?.includes('"released":true')) {
        cut = true;
        remote.objects.set(k, JSON.stringify({ instance: "third", gen: Number.MAX_SAFE_INTEGER - 1, at: Date.now() }));
      }
    });
    const fresh = new StateStore(join(dir, "b"), key, line, { ...live, lease: quick });
    let lost = 0;
    let regained = 0;
    const t = fresh.takeOver("new", undefined, { onLost: () => lost++, onRegained: () => regained++ });
    await wait(50);
    await old.release();
    assert.equal(await t, false, "never starts the keeper or the scheduler");
    assert.equal(lost, 1);
    assert.equal(fresh.handover().lost, true);
    // the third copy never renews: its lease goes quiet, and this copy takes over
    await wait(quick.ttlMs + quick.renewMs * 6);
    assert.equal(regained, 1);
    assert.equal(leaseOf(remote)!.instance, "new");
    await fresh.release();
  }),
);

test(
  "the hand-over marker is tried again when App Storage misses it, within the time given",
  withDir(async (dir) => {
    const remote = fakeRemote();
    let fails = 2;
    const line: Remote = {
      name: "fake",
      put: async (k, t) => {
        if (k.endsWith("lease.json") && t.includes('"released":true') && fails-- > 0) throw new Error("outage");
        await remote.put(k, t);
      },
      get: (k) => remote.get(k),
      del: (k) => remote.del(k),
    };
    const old = new StateStore(join(dir, "a"), key, line, { ...live, lease: quick });
    await old.takeOver("old");
    await old.release(Date.now() + 5_000);
    assert.equal(leaseOf(remote)!.released, true);
  }),
);

test(
  "health flags state the next publish wouldn't find: no App Storage on the published site, or none reachable for a while",
  withDir(async (dir) => {
    const none = new StateStore(join(dir, "a"), key, null, { ...live, expectRemote: true });
    assert.equal(none.notSaved(), true, "the published site with no bucket");
    assert.equal(new StateStore(join(dir, "b"), key, null).notSaved(), false, "a plain machine keeps its disk");
    const remote = fakeRemote();
    remote.set("down");
    const s = new StateStore(join(dir, "c"), key, remote, { ...live, retryMs: [], recheckMs: [60_000], restoreBy: Date.now() + 50, unreachable: true });
    await s.load("orders");
    assert.equal(s.notSaved(), false, "a short outage right after a publish pages nobody");
    assert.equal(s.notSaved(Date.now() + 11 * 60_000), true, "ten minutes on, it does");
    assert.equal(s.status().saved, true);
  }),
);

test(
  "a copy that lost the lease never brings its own older list back: taking the lease back reads what the other copy saved",
  withDir(async (dir) => {
    const remote = fakeRemote();
    const old = new StateStore(join(dir, "a"), key, remote, { ...live, lease: quick });
    let lost = 0;
    let regained = 0;
    await old.takeOver("old", undefined, { onLost: () => lost++, onRegained: () => regained++ });
    await old.load("orders");
    old.save("orders", '["A1"]');
    await old.flush();
    const fresh = new StateStore(join(dir, "b"), key, remote, { ...live, lease: { ...quick, capMs: 150 } });
    assert.equal(await fresh.takeOver("new"), true);
    await wait(quick.renewMs * 4);
    assert.equal(lost, 1);
    assert.equal(await fresh.load("orders"), '["A1"]');
    fresh.save("orders", '["A1-filled-by-B"]');
    await fresh.flush();
    // a price arms a stop-loss on the stopped copy, after the other copy's last save
    await wait(5);
    old.save("orders", '["A1-armed-on-stale-copy"]');
    await old.flush();
    await fresh.release();
    await wait(quick.ttlMs * 2 + quick.renewMs * 4);
    assert.equal(regained, 1);
    const stored = remote.objects.get("state/orders.json");
    assert.equal(await old.load("orders"), '["A1-filled-by-B"]', "the other copy's list, not this machine's");
    await old.flush();
    assert.equal(remote.objects.get("state/orders.json"), stored, "and the stored copy is left as it was");
    assert.equal(unseal(key, "orders", readFileSync(join(dir, "a", "orders.json"), "utf8"), "deployment").text, '["A1-filled-by-B"]', "this machine's copy follows it");
    await old.release();
  }),
);

/** Like lineTo, with the first `n` writes of the lease held back for `ms`. */
function slowLease(remote: ReturnType<typeof fakeRemote>, ms: number, n = 1): Remote {
  return {
    name: "fake",
    put: async (k, t) => {
      if (k === "state/lease.json" && n-- > 0) await wait(ms);
      await remote.put(k, t);
    },
    get: (k) => remote.get(k),
    del: (k) => remote.del(k),
  };
}

test(
  "a new copy comes before a copy that lost the lease: the old one watching never takes a hand-over meant for the new one",
  withDir(async (dir) => {
    const remote = fakeRemote();
    const zombie = new StateStore(join(dir, "a"), key, remote, { ...live, lease: quick });
    let zLost = 0;
    let zBack = 0;
    await zombie.takeOver("a-zombie", undefined, { onLost: () => zLost++, onRegained: () => zBack++ });
    const b = new StateStore(join(dir, "b"), key, remote, { ...live, lease: { ...quick, capMs: 150 } });
    assert.equal(await b.takeOver("b"), true);
    await wait(quick.renewMs * 4);
    assert.equal(zLost, 1, "the zombie stood down and watches");
    // a publish starts c, and b hands over; c's first lease write is slow to land
    const c = new StateStore(join(dir, "c"), key, slowLease(remote, 80), { ...live, lease: quick });
    let took: boolean | null = null;
    const t = c.takeOver("c").then((ok) => (took = ok));
    await wait(50);
    await b.release();
    await t;
    assert.equal(took, true);
    await wait(quick.ttlMs * 3);
    assert.equal(leaseOf(remote)!.instance, "c", "the new copy holds the lease");
    assert.equal(zBack, 0, "the zombie never took it");
    assert.equal(zombie.handover().lost, true);
    await c.release();
    zombie.stopRenewing();
  }),
);

test(
  "an older copy that took the lease back from a newer one hands it to the next new copy at once",
  withDir(async (dir) => {
    const remote = fakeRemote();
    const a = new StateStore(join(dir, "a"), key, remote, { ...live, lease: quick });
    let aLost = 0;
    let aBack = 0;
    await a.takeOver("a", undefined, { onLost: () => aLost++, onRegained: () => aBack++ });
    const b = new StateStore(join(dir, "b"), key, remote, { ...live, lease: { ...quick, capMs: 150 } });
    assert.equal(await b.takeOver("b"), true);
    await wait(quick.renewMs * 4);
    assert.equal(aLost, 1);
    // b crashes and no copy replaces it for a while: a takes the lease back, held only until a newer copy comes
    b.stopRenewing();
    await wait(quick.ttlMs * 2 + quick.renewMs * 4);
    assert.equal(aBack, 1);
    assert.equal(leaseOf(remote)!.instance, "a");
    const c = new StateStore(join(dir, "c"), key, remote, { ...live, lease: quick });
    const t0 = Date.now();
    assert.equal(await c.takeOver("c"), true);
    assert.ok(Date.now() - t0 < quick.ttlMs, "taken at once, with no wait for the cap");
    await wait(quick.renewMs * 4);
    assert.equal(aLost, 2, "the older copy stood down again");
    assert.equal(leaseOf(remote)!.instance, "c");
    await c.release();
    a.stopRenewing();
  }),
);

test(
  "a holder whose renewals stop landing pauses before its lease goes quiet; the watching copy takes over, and the newer one takes the lease back once App Storage answers it",
  withDir(async (dir) => {
    const remote = fakeRemote();
    const a = new StateStore(join(dir, "a"), key, remote, { ...live, lease: quick });
    let aBack = 0;
    await a.takeOver("a", undefined, { onRegained: () => aBack++ });
    let down = false;
    const b = new StateStore(join(dir, "b"), key, lineTo(remote, () => down), { ...live, lease: { ...quick, capMs: 150 } });
    let bLost = 0;
    let bBack = 0;
    assert.equal(await b.takeOver("b", undefined, { onLost: () => bLost++, onRegained: () => bBack++ }), true);
    await wait(quick.renewMs * 4);
    assert.equal(a.handover().lost, true);
    await b.load("orders");
    b.save("orders", '["b"]');
    await b.flush();
    // b's own line to App Storage goes down
    down = true;
    b.save("orders", '["b","saved while paused"]');
    await wait(quick.ttlMs);
    assert.equal(bLost, 1, "b paused within the lease's life");
    assert.equal(b.handover().paused, true);
    assert.equal(aBack, 0, "before anyone could count its lease as quiet");
    await wait(quick.ttlMs * 2 + quick.renewMs * 4);
    assert.equal(aBack, 1, "the watching copy took over");
    assert.equal(leaseOf(remote)!.instance, "a");
    down = false;
    await wait(quick.renewMs * 6);
    assert.equal(bBack, 1, "the newer copy took it back once App Storage answered it");
    assert.equal(a.handover().lost, true);
    assert.equal(leaseOf(remote)!.instance, "b");
    await b.release();
    a.stopRenewing();
  }),
);

test(
  "a paused holder whose lease is still its own takes it back at once, and its saves from meanwhile go up",
  withDir(async (dir) => {
    const remote = fakeRemote();
    let down = false;
    const s = new StateStore(join(dir, "a"), key, lineTo(remote, () => down), { ...live, lease: quick });
    let lost = 0;
    let back = 0;
    await s.takeOver("only", undefined, { onLost: () => lost++, onRegained: () => back++ });
    await s.load("orders");
    down = true;
    await wait(quick.ttlMs);
    assert.equal(lost, 1);
    s.save("orders", '["saved while paused"]');
    await s.flush();
    down = false;
    await wait(quick.pollMs * 6);
    assert.equal(back, 1);
    assert.equal(await s.load("orders"), '["saved while paused"]', "nobody else ran: this machine's newer copy is kept");
    await s.flush();
    assert.equal(unseal(key, "orders", remote.objects.get("state/orders.json")!, "deployment").text, '["saved while paused"]');
    await s.release();
    assert.equal(leaseOf(remote)!.released, true);
  }),
);

test("a strict save resolves only once it is on disk, and refuses when it can't be (nothing may be sent then)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-strict-"));
  try {
    const s = new StateStore(dir, key, null);
    await s.saveNow("hops", "[1]", true);
    assert.ok(readdirSync(dir).includes("hops.json"));
    // the data folder turned into a file: the write fails
    const bad = join(dir, "not-a-folder");
    writeFileSync(bad, "x");
    const t = new StateStore(bad, key, null);
    await assert.rejects(t.saveNow("hops", "[2]", true), /couldn't save/);
    await t.saveNow("hops", "[3]");
    // no key to seal it with
    await assert.rejects(new StateStore(dir, null, null).saveNow("hops", "[4]", true), /couldn't save/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
