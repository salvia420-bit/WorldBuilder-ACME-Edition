// Session 9 (2026-07-10) — bake-worker urgent-first dispatch queue tests
// (1116 §4 top item: in-run half — worker-FIFO priority for urgent requests).
//
// s8/s9 capture finding: BakeWorkerClient posted every message immediately
// and the worker runs async handlers concurrently, so under rapid teleports
// the current LB's surface decodes queued behind up to 58 stale-town
// requests. The fix adds a client-side three-lane dispatch queue with an
// in-flight cap: lane 0 = init + urgent (isNearPlayerLb-tagged fetches),
// lane 1 = normal surface/mesh, lane 2 = non-urgent entity-surface types
// + diagnostics.
// Session 10: the entity-surface ABI gained a trailing urgent arg, so
// urgent-tagged entity fetches now promote to lane 0 like surface/mesh.
// `?bakeQueue=off` restores the pre-queue post-immediately behavior;
// `?bakeQueueCap=N` tunes the in-flight cap.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_bake_worker_client_queue.mjs

// Stub the Web Worker global BEFORE the module import (node has no Worker;
// the client's `active` getter and `_ensureWorker` need one to exist).
class FakeWorker {
  constructor() {
    FakeWorker.instances.push(this);
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
  }
  postMessage(msg) {
    this.posted.push(msg);
  }
  terminate() {}
}
FakeWorker.instances = [];
globalThis.Worker = FakeWorker;

const { BakeWorkerClient, laneForBakeMessage } = await import(
  "./scene3d/bake_worker_client.js"
);

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

console.log("Session 9 — bake-worker urgent-first dispatch queue");

function makeClient({ cap = 4, enabled = true } = {}) {
  const c = new BakeWorkerClient();
  c._queueEnabled = enabled;
  c._queueCap = cap;
  c._worker = new FakeWorker();
  return c;
}
const reply = (c, id) => c._onMessage({ type: "result", id, kind: "test", payload: [] });
const postedTypes = (c) => c._worker.posted.map((m) => m.urgent === true ? m.type + ":urgent" : m.type);

// (1) lane derivation — the pure classifier.
{
  check("(1a) init → lane 0", laneForBakeMessage("init", {}) === 0);
  check("(1b) urgent surfaces → lane 0", laneForBakeMessage("fetchSurfacesPixels", { urgent: true }) === 0);
  check("(1c) urgent model meshes → lane 0", laneForBakeMessage("fetchModelMeshes", { urgent: true }) === 0);
  check("(1d) normal surfaces → lane 1", laneForBakeMessage("fetchSurfacesPixels", {}) === 1);
  check("(1e) normal model meshes → lane 1", laneForBakeMessage("fetchModelMeshes", { urgent: false }) === 1);
  check("(1f) non-urgent entity surfaces → lane 2", laneForBakeMessage("fetchEntitySurfacesPixels", {}) === 2);
  check("(1g) non-urgent entity batch → lane 2", laneForBakeMessage("fetchEntitySurfacesPixelsBatch", {}) === 2);
  check("(1h) datDecodeDiag → lane 2", laneForBakeMessage("datDecodeDiag", {}) === 2);
  // Session 10 — entity-surface urgency (decode-side priority).
  check("(1i) urgent entity surfaces → lane 0", laneForBakeMessage("fetchEntitySurfacesPixels", { urgent: true }) === 0);
  check("(1j) urgent entity batch → lane 0", laneForBakeMessage("fetchEntitySurfacesPixelsBatch", { urgent: true }) === 0);
}

// (2) in-flight cap + urgent-first dispatch across lanes.
{
  const c = makeClient({ cap: 2 });
  const swallow = (p) => p.catch(() => {});
  swallow(c._request("fetchEntitySurfacesPixels", { dids: [1] }));
  swallow(c._request("fetchEntitySurfacesPixels", { dids: [2] }));
  swallow(c._request("fetchSurfacesPixels", { dids: [3] }));
  swallow(c._request("fetchSurfacesPixels", { dids: [4], urgent: true }));
  check("(2a) cap bounds posts", c._worker.posted.length === 2,
    `posted=${c._worker.posted.length}`);
  check("(2b) queuedNow reflects backlog", c._lanes[0].length + c._lanes[1].length + c._lanes[2].length === 2);
  reply(c, c._worker.posted[0].id);
  check("(2c) freed slot goes to the URGENT lane first",
    c._worker.posted.length === 3 && c._worker.posted[2].urgent === true,
    postedTypes(c).join(","));
  reply(c, c._worker.posted[1].id);
  check("(2d) then the normal lane", c._worker.posted.length === 4 &&
    c._worker.posted[3].type === "fetchSurfacesPixels" && c._worker.posted[3].urgent !== true);
  check("(2e) inFlightPosted tracks replies", c._inFlightPosted === 2);
}

// (3) FIFO within a lane.
{
  const c = makeClient({ cap: 1 });
  const swallow = (p) => p.catch(() => {});
  swallow(c._request("fetchSurfacesPixels", { dids: [10] }));
  swallow(c._request("fetchSurfacesPixels", { dids: [11] }));
  swallow(c._request("fetchSurfacesPixels", { dids: [12] }));
  reply(c, c._worker.posted[0].id);
  reply(c, c._worker.posted[1].id);
  const order = c._worker.posted.map((m) => m.dids[0]);
  check("(3a) same-lane order is FIFO", order.join(",") === "10,11,12", order.join(","));
}

// (4) _failAll rejects BOTH posted and still-queued entries and resets state.
{
  const c = makeClient({ cap: 1 });
  const results = [];
  const p1 = c._request("fetchSurfacesPixels", { dids: [1] }).catch((e) => results.push("r1:" + e.message));
  const p2 = c._request("fetchSurfacesPixels", { dids: [2] }).catch((e) => results.push("r2:" + e.message));
  const p3 = c._request("fetchEntitySurfacesPixels", { dids: [3] }).catch((e) => results.push("r3:" + e.message));
  c._failAll(new Error("boom"));
  await Promise.all([p1, p2, p3]);
  check("(4a) all three rejected (1 posted + 2 queued)", results.length === 3, results.join("|"));
  check("(4b) lanes drained", c._lanes[0].length + c._lanes[1].length + c._lanes[2].length === 0);
  check("(4c) inFlightPosted reset", c._inFlightPosted === 0);
  check("(4d) pending cleared", c._pending.size === 0);
}

// (5) escape hatch: queue disabled → post-immediately in call order, no cap.
{
  const c = makeClient({ cap: 1, enabled: false });
  const swallow = (p) => p.catch(() => {});
  swallow(c._request("fetchEntitySurfacesPixels", { dids: [1] }));
  swallow(c._request("fetchSurfacesPixels", { dids: [2], urgent: true }));
  swallow(c._request("fetchSurfacesPixels", { dids: [3] }));
  check("(5a) all posted immediately (pre-queue behavior)", c._worker.posted.length === 3);
  check("(5b) call order preserved (no reordering)",
    postedTypes(c).join(",") ===
      "fetchEntitySurfacesPixels,fetchSurfacesPixels:urgent,fetchSurfacesPixels");
}

// (6) urgent body flag survives the queue (the worker reads msg.urgent).
{
  const c = makeClient({ cap: 4 });
  c._request("fetchSurfacesPixels", { dids: [7], urgent: true }).catch(() => {});
  const m = c._worker.posted[0];
  check("(6a) posted message carries urgent:true", m.urgent === true && m.dids[0] === 7);
  check("(6b) id assigned and pending", typeof m.id === "number" && c._pending.has(m.id));
}

// (7) stats: raw totals for windowed diffs + queue accounting.
{
  const c = makeClient({ cap: 1 });
  const p1 = c._request("fetchSurfacesPixels", { dids: [1] });
  const p2 = c._request("fetchSurfacesPixels", { dids: [2], urgent: true });
  reply(c, c._worker.posted[0].id);
  reply(c, c._worker.posted[1].id);
  await Promise.all([p1, p2]);
  const b = c._stats?.byType?.fetchSurfacesPixels;
  check("(7a) byType raw accumulators present", b && typeof b.totalMs === "number" &&
    typeof b.totalDepth === "number" && b.count === 2);
  const q = c._stats?.queue;
  check("(7b) queue.posted counts pumped messages", q && q.posted === 2, `posted=${q?.posted}`);
  check("(7c) per-lane queue accounting (urgent lane saw the 2nd req)",
    q && q.byLane[0].count === 1 && q.byLane[1].count === 1,
    q ? q.byLane.map((l) => l.count).join(",") : "no-queue");
  check("(7d) maxQueuedLen recorded", q && q.maxQueuedLen >= 1, `max=${q?.maxQueuedLen}`);
}

// (8) pump never exceeds cap even under burst + interleaved replies.
{
  const c = makeClient({ cap: 3 });
  const swallow = (p) => p.catch(() => {});
  for (let i = 0; i < 10; i++) swallow(c._request("fetchSurfacesPixels", { dids: [i] }));
  let maxInFlight = 0;
  while (c._worker.posted.length < 10) {
    const settled = c._worker.posted.length;
    const unreplied = c._worker.posted.filter((m) => c._pending.has(m.id));
    if (unreplied.length > maxInFlight) maxInFlight = unreplied.length;
    reply(c, unreplied[0].id);
    if (c._worker.posted.length === settled && unreplied.length === 1) break;
  }
  check("(8a) in-flight never exceeded cap", maxInFlight <= 3, `max=${maxInFlight}`);
  check("(8b) burst fully drained", c._worker.posted.length === 10,
    `posted=${c._worker.posted.length}`);
}

// (9) Session 10 — urgent entity-surface requests jump the storm and the
// body flag survives to the posted message (the worker forwards it as the
// trailing wasm-ABI arg).
{
  const c = makeClient({ cap: 1 });
  const swallow = (p) => p.catch(() => {});
  swallow(c._request("fetchEntitySurfacesPixels", { dids: [1] })); // posted (cap 1)
  swallow(c._request("fetchEntitySurfacesPixels", { dids: [2] })); // queued lane 2
  swallow(c._request("fetchSurfacesPixels", { dids: [3] })); // queued lane 1
  swallow(c._request("fetchEntitySurfacesPixelsBatch", { flatDids: [4], urgent: true })); // queued lane 0
  reply(c, c._worker.posted[0].id);
  check("(9a) urgent entity batch dispatches before both normal lanes",
    c._worker.posted[1].type === "fetchEntitySurfacesPixelsBatch" &&
      c._worker.posted[1].urgent === true,
    postedTypes(c).join(","));
  reply(c, c._worker.posted[1].id);
  check("(9b) then normal surface (lane 1)",
    c._worker.posted[2].type === "fetchSurfacesPixels");
  reply(c, c._worker.posted[2].id);
  check("(9c) non-urgent entity (lane 2) drains last",
    c._worker.posted[3].type === "fetchEntitySurfacesPixels" && c._worker.posted[3].dids[0] === 2);
  const c2 = makeClient({ cap: 4 });
  c2._request("fetchEntitySurfacesPixels", { dids: [9], paletteId: 5, urgent: true }).catch(() => {});
  const m = c2._worker.posted[0];
  check("(9d) urgent body flag survives the queue for entity singles",
    m.urgent === true && m.dids[0] === 9 && m.paletteId === 5);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
