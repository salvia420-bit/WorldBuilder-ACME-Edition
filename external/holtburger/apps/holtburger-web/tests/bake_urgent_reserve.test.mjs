// tests/bake_urgent_reserve.test.mjs — `?bakeUrgentReserve` (2026-10-09,
// cold-load A2 (b)).
//
// `_pump` posts lane 0 (init + urgent: the player's own Step B/C) first, but
// only into a free slot, so with the in-flight cap's 4 slots held by long
// normal jobs the interior's urgent work waited for one of them (packA1, 1070:
// Step B 16 s after "placements fetched" under `?packSource`). ON: normal lanes
// keep today's rule; a lane-0 request may also post past a full cap while
// fewer than `slots` lane-0 messages are in flight. Scope `packs` (default) =
// only while the pack controller is armed (`globalThis.__hbFetch.enabled`).
//
//   R1  flag grammar (off / packs[:N] / all[:N])
//   R2  default arm (packs mode, packs not armed) = `off`, message for message,
//       over seeded random scripts (coalescing on and off)
//   R3  packs armed: 4 normal in flight → an urgent request posts at once;
//       the next urgent waits; normal work never posts past the cap
//   R4  slots=2: Step B and Step C both post past 4 normal jobs; a third waits
//   R5  a lane-0-only backlog never runs more than `cap` messages
//   R6  invariants over seeded random scripts with the reserve on:
//       in flight ≤ cap + slots, normal posts only below the cap, lane-0
//       accounting matches the posted messages, every request settles
//   R7  `all` applies without packs; `off` never passes the cap with packs armed
//   R8  failed post / _failAll release the lane-0 count; a merged urgent post
//       holds one lane-0 count and releases it on its reply
//   R9  diag: __diag.bakeWorkerStats().queue.urgentReserve
//   R10 docs row
//
// Run: node tests/bake_urgent_reserve.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

class ManualWorker {
  constructor() {
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
    this.throwOnPost = null;
  }
  postMessage(msg) {
    if (this.throwOnPost && this.throwOnPost(msg)) throw new Error("DataCloneError (test)");
    this.posted.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
}
globalThis.Worker = ManualWorker;
globalThis.window = globalThis.window || {};

const {
  BakeWorkerClient,
  getBakeWorkerClient,
  parseBakeUrgentReserve,
  resolveBakeUrgentReserve,
  DEFAULT_BAKE_URGENT_RESERVE_SLOTS,
} = await import("../scene3d/bake_worker_client.js");

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("  ok  ", name);
  } catch (e) {
    failed += 1;
    console.log("  FAIL", name);
    console.log(e);
  }
}

const armPacks = (on) => {
  if (on) globalThis.__hbFetch = { enabled: true };
  else delete globalThis.__hbFetch;
};

function makeClient({ cap = 4, mode = "packs", slots = 1, coalesce = 0 } = {}) {
  const c = new BakeWorkerClient();
  c._queueEnabled = true;
  c._queueCap = cap;
  c.urgentReserve = { mode, slots };
  c.surfaceCoalesceMax = coalesce;
  c._worker = new ManualWorker();
  return c;
}
const swallow = (p) => p.catch(() => {});
const reply = (c, id) => c._onMessage({ type: "result", id, kind: "test", payload: [] });
/** Ids posted and not yet answered, in post order. */
const inFlightIds = (c, answered) => c._worker.posted.map((m) => m.id).filter((id) => !answered.has(id));
const sig = (m) => `${m.type}:${m.urgent === true ? "U" : "n"}:${(m.dids || m.ids || m.flatDids || []).join(".")}`;

// Seeded PRNG (mulberry32) so a failing script is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Run one random script against a client. Steps: enqueue a request (normal
 * mesh / normal surface / urgent surface / urgent mesh / entity) or answer a
 * posted message chosen by index among the unanswered ones. Logs each post
 * with its step. The surface payload is built per DID so a merged reply
 * splits cleanly.
 */
function runScript(c, seed, steps = 400) {
  const r = rng(seed);
  const answered = new Set();
  const log = [];
  let nextDid = 1;
  const seenPosts = () => c._worker.posted.length;
  let lastPosted = 0;
  // Each post is logged with the script step it happened at: the reserve
  // changes WHEN an urgent message posts, not necessarily the post order.
  const capture = (step) => {
    for (let i = lastPosted; i < seenPosts(); i += 1) {
      const m = c._worker.posted[i];
      log.push({ id: m.id, sig: `${step}:${sig(m)}`, urgent: m.urgent === true });
    }
    lastPosted = seenPosts();
  };
  const answer = (id) => {
    answered.add(id);
    const m = c._worker.posted.find((p) => p.id === id);
    const payload = Array.isArray(m?.dids) ? m.dids.map(() => ({ width: 1, height: 1, pixels: new Uint8Array(4) })) : [];
    c._onMessage({ type: "result", id, kind: "test", payload });
  };
  for (let s = 0; s < steps; s += 1) {
    const x = r();
    if (x < 0.55) {
      const k = r();
      const did = nextDid++;
      if (k < 0.3) swallow(c._request("fetchModelMeshes", { ids: [did] }));
      else if (k < 0.6) swallow(c._request("fetchSurfacesPixels", { dids: [did] }));
      else if (k < 0.75) swallow(c._request("fetchSurfacesPixels", { dids: [did], urgent: true }));
      else if (k < 0.85) swallow(c._request("fetchModelMeshes", { ids: [did], urgent: true }));
      else swallow(c._request("fetchEntitySurfacesPixels", { dids: [did], paletteId: 1 }));
    } else {
      const open = inFlightIds(c, answered);
      if (open.length) answer(open[Math.floor(r() * open.length)]);
    }
    capture(s);
  }
  // Drain.
  for (let guard = 0; guard < 10000; guard += 1) {
    const open = inFlightIds(c, answered);
    if (!open.length) break;
    answer(open[0]);
    capture(steps + guard);
  }
  return { log, answered };
}

await t("R1 flag grammar", () => {
  assert.equal(DEFAULT_BAKE_URGENT_RESERVE_SLOTS, 1);
  assert.deepEqual(parseBakeUrgentReserve(null), { mode: "packs", slots: 1 });
  assert.deepEqual(parseBakeUrgentReserve(undefined), { mode: "packs", slots: 1 });
  for (const off of ["off", "0", "false", "no", "OFF", " No "]) {
    assert.deepEqual(parseBakeUrgentReserve(off), { mode: "off", slots: 0 }, off);
  }
  for (const on of ["on", "true", "yes", "", "garbage", "-2", "1.5", "packs"]) {
    assert.deepEqual(parseBakeUrgentReserve(on), { mode: "packs", slots: 1 }, on);
  }
  assert.deepEqual(parseBakeUrgentReserve("1"), { mode: "packs", slots: 1 });
  assert.deepEqual(parseBakeUrgentReserve("2"), { mode: "packs", slots: 2 });
  assert.deepEqual(parseBakeUrgentReserve("all"), { mode: "all", slots: 1 });
  assert.deepEqual(parseBakeUrgentReserve("all:2"), { mode: "all", slots: 2 });
  assert.deepEqual(parseBakeUrgentReserve("ALL 3"), { mode: "all", slots: 3 });
  assert.deepEqual(parseBakeUrgentReserve("all:0"), { mode: "all", slots: 1 });
  assert.deepEqual(resolveBakeUrgentReserve(""), { mode: "packs", slots: 1 });
  assert.deepEqual(resolveBakeUrgentReserve("?bakeUrgentReserve=off"), { mode: "off", slots: 0 });
  assert.deepEqual(resolveBakeUrgentReserve("?bakeUrgentReserve=all"), { mode: "all", slots: 1 });
  assert.deepEqual(resolveBakeUrgentReserve("?x=1&bakeUrgentReserve=2"), { mode: "packs", slots: 2 });
  // A bare client resolves from location (none in node → the default).
  assert.deepEqual(new BakeWorkerClient().urgentReserve, { mode: "packs", slots: 1 });
});

await t("R2 default arm (packs not armed) dispatches exactly like =off", () => {
  for (const enabledFlag of [undefined, false]) {
    if (enabledFlag === undefined) armPacks(false);
    else globalThis.__hbFetch = { enabled: false };
    for (const coalesce of [0, 64]) {
      for (let seed = 1; seed <= 40; seed += 1) {
        const a = makeClient({ mode: "packs", coalesce });
        const b = makeClient({ mode: "off", coalesce });
        const ra = runScript(a, seed);
        const rb = runScript(b, seed);
        assert.deepEqual(
          ra.log.map((e) => e.sig),
          rb.log.map((e) => e.sig),
          `seed ${seed} coalesce ${coalesce}: packs-mode (unarmed) diverged from off`,
        );
        assert.equal(a._stats?.queue?.reservePosts ?? 0, 0, "no reserve post on the default arm");
      }
    }
  }
  // Teeth: the same scripts DO diverge once packs are armed (the reserve is
  // reachable by these workloads), so the equality above is not vacuous.
  armPacks(true);
  let diverged = 0;
  for (let seed = 1; seed <= 40; seed += 1) {
    const a = makeClient({ mode: "packs" });
    const b = makeClient({ mode: "off" });
    const sa = runScript(a, seed).log.map((e) => e.sig).join("|");
    const sb = runScript(b, seed).log.map((e) => e.sig).join("|");
    if (sa !== sb) diverged += 1;
  }
  assert.ok(diverged > 0, "armed packs never changed a script: the scripts never fill the cap");
  armPacks(false);
});

await t("R3 packs armed: urgent posts past 4 normal jobs; the next waits; normal never past the cap", () => {
  armPacks(true);
  const c = makeClient({ cap: 4 });
  for (let i = 0; i < 6; i += 1) swallow(c._request("fetchModelMeshes", { ids: [100 + i] }));
  assert.equal(c._worker.posted.length, 4, "cap 4 normal posts");
  swallow(c._request("fetchSurfacesPixels", { dids: [7], urgent: true }));
  assert.equal(c._worker.posted.length, 5, "urgent posted past the full cap");
  assert.equal(c._worker.posted[4].urgent, true);
  assert.equal(c._inFlightLane0, 1);
  assert.equal(c._stats.queue.reservePosts, 1);
  swallow(c._request("fetchModelMeshes", { ids: [8], urgent: true }));
  assert.equal(c._worker.posted.length, 5, "second urgent waits (one slot)");
  // A normal reply frees a cap slot: in flight is now 3 normal + 1 urgent = 4
  // = cap, and the reserve is taken, so nothing posts (today: the freed slot
  // would go to the queued urgent — same count in flight).
  reply(c, c._worker.posted[0].id);
  assert.equal(c._worker.posted.length, 5, "cap full and reserve taken: nothing posts");
  // The reserved urgent finishes: lane 0 goes first into the free slot.
  reply(c, c._worker.posted[4].id);
  assert.equal(c._worker.posted.length, 6);
  assert.equal(c._worker.posted[5].type, "fetchModelMeshes");
  assert.equal(c._worker.posted[5].urgent, true, "queued urgent takes the freed slot before normal work");
  // Normal work posts only below the cap: a normal reply leaves 2 normal + 1
  // urgent in flight, so ONE queued normal posts and the cap is full again.
  reply(c, c._worker.posted[1].id);
  assert.equal(c._worker.posted.length, 7);
  assert.equal(c._worker.posted[6].type, "fetchModelMeshes");
  assert.notEqual(c._worker.posted[6].urgent, true);
  assert.equal(c._inFlightPosted, 4, "back at the cap");
  assert.equal(c._lanes[1].length, 1, "the last normal request still waits");
  armPacks(false);
});

await t("R4 slots=2: Step B and Step C both post past 4 normal jobs; a third urgent waits", () => {
  armPacks(true);
  const c = makeClient({ cap: 4, slots: 2 });
  for (let i = 0; i < 4; i += 1) swallow(c._request("fetchSurfacesPixels", { dids: [200 + i] }));
  swallow(c._request("fetchSurfacesPixels", { dids: [1, 2, 3], urgent: true })); // Step B
  swallow(c._request("fetchModelMeshes", { ids: [9, 10], urgent: true })); // Step C
  swallow(c._request("fetchEntitySurfacesPixels", { dids: [11], urgent: true }));
  assert.equal(c._worker.posted.length, 6);
  assert.deepEqual(c._worker.posted.slice(4).map((m) => m.type), ["fetchSurfacesPixels", "fetchModelMeshes"]);
  assert.equal(c._inFlightLane0, 2);
  assert.equal(c._lanes[0].length, 1, "third urgent queued");
  armPacks(false);
});

await t("R5 a lane-0-only backlog never runs more than cap messages", () => {
  armPacks(true);
  for (const slots of [1, 2, 4]) {
    const c = makeClient({ cap: 4, slots });
    for (let i = 0; i < 10; i += 1) swallow(c._request("fetchModelMeshes", { ids: [i], urgent: true }));
    assert.equal(c._worker.posted.length, 4, `slots ${slots}: urgent-only concurrency stays at cap`);
    assert.equal(c._stats.queue.reservePosts, 0);
  }
  armPacks(false);
});

await t("R6 invariants over random scripts with the reserve on", () => {
  armPacks(true);
  let reservePosts = 0;
  for (const slots of [1, 2]) {
    for (const coalesce of [0, 64]) {
      for (let seed = 1; seed <= 40; seed += 1) {
        const cap = 1 + (seed % 4);
        const c = makeClient({ cap, slots, coalesce });
        const origPost = c._worker.postMessage.bind(c._worker);
        let violations = [];
        c._worker.postMessage = (msg) => {
          // `_inFlightPosted` already counts this post; lane-0 counts too.
          const before = c._inFlightPosted - 1;
          const urgent = msg.urgent === true;
          if (!urgent && before >= cap) violations.push(`normal post at ${before} in flight (cap ${cap})`);
          if (c._inFlightPosted > cap + slots) violations.push(`in flight ${c._inFlightPosted} > cap+slots`);
          if (urgent && before >= cap && c._inFlightLane0 - 1 >= slots) violations.push("reserve over-used");
          origPost(msg);
        };
        const { answered } = runScript(c, 1000 + seed);
        assert.deepEqual(violations, [], `seed ${seed} cap ${cap} slots ${slots} coalesce ${coalesce}`);
        assert.equal(c._inFlightPosted, 0, "drained");
        assert.equal(c._inFlightLane0, 0, "lane-0 count drained");
        assert.equal(c._postedLane0.size, 0);
        assert.equal(c._pending.size, 0, "every request settled");
        assert.equal(c._lanes[0].length + c._lanes[1].length + c._lanes[2].length, 0);
        assert.ok(answered.size > 0);
        reservePosts += c._stats?.queue?.reservePosts ?? 0;
      }
    }
  }
  assert.ok(reservePosts > 0, "the scripts exercised the reserve");
  armPacks(false);
});

await t("R7 `all` applies without packs; `off` never passes the cap even with packs armed", () => {
  armPacks(false);
  const a = makeClient({ cap: 2, mode: "all" });
  swallow(a._request("fetchModelMeshes", { ids: [1] }));
  swallow(a._request("fetchModelMeshes", { ids: [2] }));
  swallow(a._request("fetchSurfacesPixels", { dids: [3], urgent: true }));
  assert.equal(a._worker.posted.length, 3, "all: reserve works on the default arm");
  armPacks(true);
  const o = makeClient({ cap: 2, mode: "off" });
  swallow(o._request("fetchModelMeshes", { ids: [1] }));
  swallow(o._request("fetchModelMeshes", { ids: [2] }));
  swallow(o._request("fetchSurfacesPixels", { dids: [3], urgent: true }));
  assert.equal(o._worker.posted.length, 2, "off: today's pump");
  armPacks(false);
});

await t("R8 failed post / _failAll release lane-0; a merged urgent post counts once", async () => {
  armPacks(true);
  const c = makeClient({ cap: 1, coalesce: 64 });
  swallow(c._request("fetchModelMeshes", { ids: [1] }));
  c._worker.throwOnPost = (m) => m.urgent === true;
  let rejected = 0;
  c._request("fetchSurfacesPixels", { dids: [2], urgent: true }).catch(() => (rejected += 1));
  await Promise.resolve();
  assert.equal(rejected, 1, "failed reserve post rejects its caller");
  assert.equal(c._inFlightLane0, 0, "failed post releases its lane-0 count");
  assert.equal(c._inFlightPosted, 1);
  c._worker.throwOnPost = null;
  // Two queued urgent surface requests merge into one reserve post.
  // Occupy the reserve first so both queue, then free it.
  swallow(c._request("fetchModelMeshes", { ids: [5], urgent: true })); // reserve
  swallow(c._request("fetchSurfacesPixels", { dids: [3], urgent: true }));
  swallow(c._request("fetchSurfacesPixels", { dids: [4], urgent: true }));
  assert.equal(c._inFlightLane0, 1);
  const reserveId = c._worker.posted[c._worker.posted.length - 1].id;
  reply(c, reserveId);
  const merged = c._worker.posted[c._worker.posted.length - 1];
  assert.deepEqual(merged.dids, [3, 4], "the two urgent surface requests rode one post");
  assert.equal(c._inFlightLane0, 1, "a merged post holds ONE lane-0 count");
  c._onMessage({
    type: "result", id: merged.id, kind: "surfaces",
    payload: [{ width: 1, height: 1, pixels: new Uint8Array(4) }, { width: 1, height: 1, pixels: new Uint8Array(4) }],
  });
  assert.equal(c._inFlightLane0, 0, "released on the merged reply");
  swallow(c._request("fetchSurfacesPixels", { dids: [6], urgent: true }));
  assert.equal(c._inFlightLane0, 1);
  c._failAll(new Error("boom"));
  assert.equal(c._inFlightLane0, 0);
  assert.equal(c._postedLane0.size, 0);
  armPacks(false);
});

await t("R9 diag: __diag.bakeWorkerStats().queue.urgentReserve", () => {
  const s = getBakeWorkerClient();
  armPacks(false);
  let st = globalThis.window.__diag.bakeWorkerStats();
  assert.deepEqual(st.queue.urgentReserve, { mode: "packs", slots: 1, applies: false, lane0InFlight: 0, posts: 0 });
  armPacks(true);
  s._stats = { byType: {}, maxPending: 0, queue: { posted: 0, maxQueuedLen: 0, byLane: [], reservePosts: 3 } };
  st = globalThis.window.__diag.bakeWorkerStats();
  assert.equal(st.queue.urgentReserve.applies, true);
  assert.equal(st.queue.urgentReserve.posts, 3);
  s._stats = undefined;
  armPacks(false);
});

await t("R10 url-flags.md row", () => {
  const docsPath = process.env.HB_URL_FLAGS_MD || path.join(APP, "docs", "url-flags.md");
  const docs = readFileSync(docsPath, "utf8");
  const row = docs.split("\n").find((l) => l.startsWith("| `bakeUrgentReserve` |"));
  assert.ok(row, "url-flags.md row `| \\`bakeUrgentReserve\\` |` missing");
  assert.match(row, /`off`\/`0`\/`false`\/`no`/);
  assert.match(row, /bake_worker_client\.js/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
