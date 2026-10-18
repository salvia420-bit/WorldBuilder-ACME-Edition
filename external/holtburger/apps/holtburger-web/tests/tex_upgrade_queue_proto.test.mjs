// tests/tex_upgrade_queue_proto.test.mjs — the TexUpgradeQueue's DEFAULT
// HTTP-version probe (scene3d/tex_upgrade_queue.js `_defaultProtocol`, used
// whenever no `protocol` is injected — the production singleton).
//
// STREAM-TERRAIN-4 (2026-10-18 review): the probe only scanned the page's
// resource entries for /shards/ or /suite/. The shard records are fetched in
// the shard-fetch / bake workers (their own timelines) and index.html's
// modulepreloads fill the page's 250-entry resource buffer first, so it never
// found one: h2/h3 origins ran the HTTP/1.1 caps (3 in flight, 2 big) instead
// of 6/4. The navigation entry carries the same origin's protocol.
//
//   P1  full buffer, no shard/suite entry, h2 navigation → h2 caps (6 in flight)
//   P2  h3 navigation → h3; http/1.1 navigation → h1 caps (3 in flight)
//   P3  a shard/suite resource entry still wins over the navigation entry
//   P4  no protocol anywhere (empty nextHopProtocol) → the h1 default
//
// Run: node tests/tex_upgrade_queue_proto.test.mjs   (exits; no live timers)

import assert from "node:assert/strict";

globalThis.location = { search: "" };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.window = globalThis;

const { TexUpgradeQueue } = await import("../scene3d/tex_upgrade_queue.js");

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${(e && e.stack) || e}`); }
}
const flush = async (n = 40) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

// The page timeline the probe reads: `resource` entries + one navigation entry.
const realPerf = Object.getOwnPropertyDescriptor(globalThis, "performance");
const realNow = performance.now.bind(performance);
function stubTimeline({ resources = [], navProto = "" } = {}) {
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    writable: true,
    value: {
      now: realNow,
      getEntriesByType: (type) => {
        if (type === "resource") return resources.slice();
        if (type === "navigation") return [{ name: "http://game.test/index.html", nextHopProtocol: navProto }];
        return [];
      },
    },
  });
}
// 250 boot entries (the modulepreload block) — none under /shards/ or /suite/.
const BOOT = Array.from({ length: 250 }, (_, i) => ({ name: `http://game.test/scene3d/m${i}.js`, nextHopProtocol: "h2" }));

const ident = (x, y, z) => ({ elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1] });
const IDS = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => 0x06000100 + i);
function makeScene() {
  const meshes = IDS.map((rs, i) => ({
    isMesh: true,
    material: { userData: { __texRsId: rs } },
    geometry: { boundingSphere: { center: { x: 0, y: 0, z: 0 }, radius: 1 } },
    matrixWorld: ident(i + 1, 0, 0),
    children: [],
  }));
  const cell = { visible: true, userData: { cellId: 0x00070100 }, children: [{ name: "mesh-x", children: meshes }] };
  return {
    camera: { matrixWorld: ident(0, 0, 0) },
    cellContainers3d: new Map([[0x00070100, cell]]),
    cellsGroup: { visible: true },
    staticsGroup: { visible: true, children: [] },
    buildingsGroup: { visible: true, children: [] },
    entityManager: { entityMap: new Map() },
    envCellLoadedLbs: new Set(),
    sessionHandle: { isCurrentCellIndoor: () => false },
    _sealedEvictLbKey: 0,
  };
}

/** Admit 8 small near full-tier jobs through a queue with NO injected
 *  protocol; return [in flight, the proto it settled on]. */
async function run() {
  let now = 1_000_000;
  const scene = makeScene();
  const q = new TexUpgradeQueue({
    now: () => now,
    schedule: () => 0,
    cancel: () => {},
    sceneProvider: () => scene,
    linkBps: () => 20e6,
    paused: () => false,
    workerDepth: () => 0,
    pendingProbe: () => false,
    fullM: 32,
    bgShare: 0.3,
  });
  q.armed = true;
  for (const id of IDS) q.admit("full", id, { did: 0x08000000, rs: 0, w: 64, h: 64, live: () => true });
  await flush();
  const s = q.stats();
  q._resetForTest();
  return [s.inflight.all, s.link.proto];
}

try {
  await t("P1 full buffer without a shard/suite entry: the h2 navigation entry → 6 in flight", async () => {
    stubTimeline({ resources: BOOT, navProto: "h2" });
    assert.deepEqual(await run(), [6, "h2"]);
  });

  await t("P2 h3 navigation → h3; http/1.1 navigation → 3 in flight", async () => {
    stubTimeline({ resources: BOOT, navProto: "h3" });
    assert.deepEqual(await run(), [6, "h3"]);
    stubTimeline({ resources: BOOT, navProto: "http/1.1" });
    assert.deepEqual(await run(), [3, "h1"]);
  });

  await t("P3 a shard/suite resource entry wins over the navigation entry", async () => {
    stubTimeline({
      resources: [...BOOT.slice(0, 200), { name: "http://game.test/dist/suite/texchan/a.bin", nextHopProtocol: "http/1.1" }],
      navProto: "h2",
    });
    assert.deepEqual(await run(), [3, "h1"]);
  });

  await t("P4 no protocol anywhere → the h1 default", async () => {
    stubTimeline({ resources: [], navProto: "" });
    assert.deepEqual(await run(), [3, "h1(default)"]);
  });
} finally {
  if (realPerf) Object.defineProperty(globalThis, "performance", realPerf);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
