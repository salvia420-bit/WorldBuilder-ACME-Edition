// test_a15_q4_renderer_neutral_core.mjs — A15-Q4 (`?unifiedDispatch`)
// headless acceptance gate (S3 spec §4; pattern: the two-part
// behavioral + static style of test_a15_q1_entity_buffer_caps.mjs).
//
//   PART 1a — behavioral: scene3d/world_stream.js imported directly as
//            ESM; fake deps (recording stubs + real Sets) driven with
//            synthetic kind-0 updates (local-gate, first-LB sequence,
//            heartbeat idempotency, transition re-emit, ring clamp,
//            liveScene3d-null wasm-bake invariant).
//   PART 1b — behavioral: scene3d/entity_dispatch.js routing table
//            (all 10 kinds, neutral-before-backend, one-time
//            accounting info, throwing-backend isolation, never-free
//            via Proxy).
//   PART 2 — static: read index.html + scene3d/loop.js +
//            world_stream.js as text; flag consts / imports /
//            instantiation present; the A15-Q4-SYNC drift guard
//            (legacy streaming block vs world_stream.js call-sequence
//            parity); loop.js KIND literals gone; `upd.free()` still
//            unconditional at the drain-loop tail.
//
// Run: node test_a15_q4_renderer_neutral_core.mjs   (no browser, no build)

import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

const { createWorldStreamer } = await import("./scene3d/world_stream.js");
const { KIND, createEntityDispatcher } = await import("./scene3d/entity_dispatch.js");

// ---------------------------------------------------------------------
// PART 1a — world_stream.js behavioral
// ---------------------------------------------------------------------
console.log("PART 1a: world_stream.js (renderer-neutral streaming core)");

const LOCAL_GUID = 0x50000001;
const REMOTE_GUID = 0x80000123;

function makeDeps({ liveScene3d = undefined, noRing = false } = {}) {
  const calls = [];
  const sets = {
    terrainPrefetchedLbs: new Set(),
    buildingAabbsPopulatedLbs: new Set(),
    cellContainersPopulatedLbs: new Set(),
    objectsRenderAddedLbs: new Set(),
  };
  // The real ensure* helpers mutate the shared Sets internally — the
  // recording stubs mimic that so the call-site fast-path gating is
  // exercised exactly as in production.
  const s3dBase = {
    loadEnvCellsForLandblock: (lb) => calls.push(["loadEnvCellsForLandblock", lb]),
    loadTerrainForLandblock: (x, y) => calls.push(["loadTerrainForLandblock", x, y]),
    loadBuildingsForLandblock: (x, y) => calls.push(["loadBuildingsForLandblock", x, y]),
    loadStaticsForLandblock: (x, y) => calls.push(["loadStaticsForLandblock", x, y]),
    loadSpawnsForLandblock: (x, y) => calls.push(["loadSpawnsForLandblock", x, y]),
  };
  // A4 (2026-07-11 s13): the batched-ring facade world_stream now prefers.
  // Omitted when `noRing` → exercises world_stream's facade-absent 9-solo
  // fallback (the older-scene3d-bundle path).
  if (!noRing) {
    s3dBase.loadTerrainRing = (x, y) => calls.push(["loadTerrainRing", x, y]);
  }
  const s3d = liveScene3d === undefined ? s3dBase : liveScene3d;
  let localGuid = LOCAL_GUID;
  const deps = {
    calls,
    sets,
    setLocalGuid: (g) => { localGuid = g; },
    getLocalPlayerGuid: () => localGuid,
    emitLandblockChanged: (prevLb, lbId) => calls.push(["emitLandblockChanged", prevLb, lbId]),
    ensureTerrainAroundLandblock: (lb) => {
      calls.push(["ensureTerrainAroundLandblock", lb]);
      sets.terrainPrefetchedLbs.add(lb);
    },
    ensureBuildingAabbsAroundLandblock: (lb) => {
      calls.push(["ensureBuildingAabbsAroundLandblock", lb]);
      sets.buildingAabbsPopulatedLbs.add(lb);
    },
    ensureCellContainersForLandblock: (lb) => {
      calls.push(["ensureCellContainersForLandblock", lb]);
      sets.cellContainersPopulatedLbs.add(lb);
    },
    ensureLandblockObjectsForLandblock: (lb) => {
      calls.push(["ensureLandblockObjectsForLandblock", lb]);
      sets.objectsRenderAddedLbs.add(lb);
    },
    getLiveScene3d: () => s3d,
    ...sets,
  };
  return deps;
}

const posUpd = (guid, landblockId) => ({ kind: 0, guid, landblockId });

// (i) non-local guid → zero dep calls
{
  const deps = makeDeps();
  const ws = createWorldStreamer(deps);
  ws.onPositionUpdate(posUpd(REMOTE_GUID, 0xa9b40021));
  check("(i) non-local guid → zero dep calls", deps.calls.length === 0,
    `calls=${deps.calls.length}`);
}

// (ii) local guid, lbId=0 → zero calls (and null guid → zero calls)
{
  const deps = makeDeps();
  const ws = createWorldStreamer(deps);
  ws.onPositionUpdate(posUpd(LOCAL_GUID, 0x00000021)); // high16 = 0 → lbId 0
  const a = deps.calls.length;
  deps.setLocalGuid(null);
  ws.onPositionUpdate(posUpd(LOCAL_GUID, 0xa9b40021));
  check("(ii) lbId=0 → zero calls; null local guid → zero calls",
    a === 0 && deps.calls.length === 0, `calls=${deps.calls.length}`);
}

// (iii) local guid, first LB → full ordered sequence
{
  const deps = makeDeps();
  const ws = createWorldStreamer(deps);
  ws.onPositionUpdate(posUpd(LOCAL_GUID, 0xa9b40021));
  const names = deps.calls.map((c) => c[0]);
  const emits = deps.calls.filter((c) => c[0] === "emitLandblockChanged");
  check("(iii) emitLandblockChanged once, 0 → 0xa9b40000",
    emits.length === 1 && emits[0][1] === 0 && emits[0][2] === 0xa9b40000,
    JSON.stringify(emits));
  const count = (n) => names.filter((x) => x === n).length;
  check("(iii) four wasm-bake ensure* called once each",
    count("ensureTerrainAroundLandblock") === 1 &&
    count("ensureBuildingAabbsAroundLandblock") === 1 &&
    count("ensureCellContainersForLandblock") === 1 &&
    count("ensureLandblockObjectsForLandblock") === 1);
  check("(iii) loadTerrainRing called exactly 1× (batched facade, NOT 9 solo)",
    count("loadTerrainRing") === 1 && count("loadTerrainForLandblock") === 0,
    `ring=${count("loadTerrainRing")} solo=${count("loadTerrainForLandblock")}`);
  check("(iii) envcells/buildings/statics/spawns 1× each",
    count("loadEnvCellsForLandblock") === 1 &&
    count("loadBuildingsForLandblock") === 1 &&
    count("loadStaticsForLandblock") === 1 &&
    count("loadSpawnsForLandblock") === 1);
  // Order: dedupe consecutive repeats (the 9 terrain calls) then compare.
  const seq = names.filter((n, i) => n !== names[i - 1]);
  const expected = [
    "emitLandblockChanged",
    "ensureTerrainAroundLandblock",
    "ensureBuildingAabbsAroundLandblock",
    "ensureCellContainersForLandblock",
    "loadEnvCellsForLandblock",
    "loadTerrainRing",
    "loadBuildingsForLandblock",
    "loadStaticsForLandblock",
    "loadSpawnsForLandblock",
    "ensureLandblockObjectsForLandblock",
  ];
  check("(iii) call ORDER matches the legacy block",
    JSON.stringify(seq) === JSON.stringify(expected), seq.join(" → "));
  check("(iii) _debugState lastLb stamped",
    ws._debugState().lastLb === 0xa9b40000);

  // (iv) same-LB heartbeat → NO emit, Set-gated ensure* not re-called;
  // the per-update (non-Set-gated) 3D loaders DO re-fire (legacy parity).
  deps.calls.length = 0;
  ws.onPositionUpdate(posUpd(LOCAL_GUID, 0xa9b40042)); // same high16
  const names2 = deps.calls.map((c) => c[0]);
  check("(iv) heartbeat → no emitLandblockChanged",
    !names2.includes("emitLandblockChanged"));
  check("(iv) heartbeat → Set-gated ensure* not re-called",
    !names2.includes("ensureTerrainAroundLandblock") &&
    !names2.includes("ensureBuildingAabbsAroundLandblock") &&
    !names2.includes("ensureCellContainersForLandblock") &&
    !names2.includes("ensureLandblockObjectsForLandblock"));
  check("(iv) heartbeat → per-update 3D loaders still fire (legacy parity)",
    names2.filter((x) => x === "loadTerrainRing").length === 1 &&
    names2.includes("loadSpawnsForLandblock"));

  // (v) LB transition → second emit(prev → new)
  deps.calls.length = 0;
  ws.onPositionUpdate(posUpd(LOCAL_GUID, 0xa9b50011));
  const emits2 = deps.calls.filter((c) => c[0] === "emitLandblockChanged");
  check("(v) transition → emitLandblockChanged(0xa9b40000 → 0xa9b50000)",
    emits2.length === 1 && emits2[0][1] === 0xa9b40000 && emits2[0][2] === 0xa9b50000,
    JSON.stringify(emits2));
}

// (vi) corner/edge LB → A4: world_stream hands the corner to the batched
// facade ONCE (clamping moved INTO the facade — proven in
// test_terrain_ring_batch.mjs). The facade-ABSENT fallback still clamps the
// 9-solo loop to 4 at the 0x00/0xff map edge (this is the flag-off / older-
// bundle arm re-proving the solo path).
{
  const deps = makeDeps();
  const ws = createWorldStreamer(deps);
  ws.onPositionUpdate(posUpd(LOCAL_GUID, 0xffff0021)); // cx=0xff, cy=0xff corner
  const ring = deps.calls.filter((c) => c[0] === "loadTerrainRing");
  check("(vi) facade present → loadTerrainRing called ONCE with corner coords",
    ring.length === 1 && ring[0][1] === 0xff && ring[0][2] === 0xff,
    JSON.stringify(ring));
  check("(vi) facade present → no solo loadTerrainForLandblock at corner",
    deps.calls.filter((c) => c[0] === "loadTerrainForLandblock").length === 0);

  // Facade ABSENT (older scene3d bundle) → world_stream's solo fallback
  // clamps the ring to 4 at the corner.
  const deps2 = makeDeps({ noRing: true });
  const ws2 = createWorldStreamer(deps2);
  ws2.onPositionUpdate(posUpd(LOCAL_GUID, 0x00ff0021)); // cx=0x00, cy=0xff corner
  const ring2 = deps2.calls.filter((c) => c[0] === "loadTerrainForLandblock");
  check("(vi) facade absent → solo fallback clamps corner ring to 4",
    ring2.length === 4 &&
      deps2.calls.filter((c) => c[0] === "loadTerrainRing").length === 0,
    `got ${ring2.length}`);
  check("(vi) clamped fallback ring stays in-range",
    ring2.every((c) => c[1] >= 0 && c[1] <= 0xff && c[2] >= 0 && c[2] <= 0xff));
}

// (vii) getLiveScene3d() null → no throw, wasm-bake deps still called
// (invariant 2 — the Workstream-G hoist: bakes keep the 3D integrator
// from freezing on the spawn cell regardless of renderer state).
{
  const deps = makeDeps({ liveScene3d: null });
  const ws = createWorldStreamer(deps);
  let threw = false;
  try { ws.onPositionUpdate(posUpd(LOCAL_GUID, 0xa9b40021)); } catch (_) { threw = true; }
  const names = deps.calls.map((c) => c[0]);
  check("(vii) null liveScene3d → no throw", !threw);
  check("(vii) null liveScene3d → wasm bakes still fire",
    names.includes("ensureTerrainAroundLandblock") &&
    names.includes("ensureBuildingAabbsAroundLandblock") &&
    names.includes("ensureCellContainersForLandblock"));
  check("(vii) null liveScene3d → no 3D loader calls",
    !names.some((n) => n.startsWith("load")));
}

// ---------------------------------------------------------------------
// PART 1b — entity_dispatch.js behavioral
// ---------------------------------------------------------------------
console.log("PART 1b: entity_dispatch.js (shared kind table + dispatcher)");

check("KIND table is the wasm ENTITY_UPDATE_KIND_* map (0..9, frozen)",
  Object.isFrozen(KIND) &&
  KIND.POSITION === 0 && KIND.SPAWN === 1 && KIND.REMOVE === 2 &&
  KIND.META_REFRESH === 3 && KIND.VELOCITY === 4 && KIND.MOTION === 5 &&
  KIND.APPEARANCE === 6 && KIND.ATTACH === 7 && KIND.MOTION_ACTION === 8 &&
  KIND.TURN === 9);

// All 10 kinds route to the right backend; neutral runs before backend.
{
  const log = [];
  const neutral = {};
  const backend = {};
  for (const [name, k] of Object.entries(KIND)) {
    neutral[k] = () => log.push(`n:${name}`);
    backend[k] = () => log.push(`b:${name}`);
  }
  const d = createEntityDispatcher({ neutral, backend, label: "test" });
  let allRouted = true;
  for (const [name, k] of Object.entries(KIND)) {
    log.length = 0;
    const ok = d.dispatch({ kind: k });
    if (!(ok === true && log[0] === `n:${name}` && log[1] === `b:${name}` && log.length === 2)) {
      allRouted = false;
      check(`kind ${name} routing`, false, JSON.stringify(log));
    }
  }
  check("all 10 KINDs route to the right backend, neutral BEFORE backend", allRouted);
}

// Missing backend → returns false + exactly ONE console.info per kind.
{
  const infos = [];
  const origInfo = console.info;
  console.info = (...a) => infos.push(a.join(" "));
  try {
    const neutralSeen = [];
    const d = createEntityDispatcher({
      neutral: { [KIND.APPEARANCE]: () => neutralSeen.push(1) },
      backend: {},
      label: "gap",
    });
    const r1 = d.dispatch({ kind: KIND.APPEARANCE });
    const r2 = d.dispatch({ kind: KIND.APPEARANCE });
    const r3 = d.dispatch({ kind: KIND.TURN });
    check("missing backend → returns false, neutral still runs",
      r1 === false && r2 === false && r3 === false && neutralSeen.length === 2);
    check("one-time accounting info per kind (2 dispatches → 1 info)",
      infos.filter((s) => s.includes("kind=6")).length === 1 &&
      infos.filter((s) => s.includes("kind=9")).length === 1,
      JSON.stringify(infos));
    check("accounting info names the quarantine policy",
      infos.every((s) => s.includes("quarantine policy")));
  } finally {
    console.info = origInfo;
  }
}

// Throwing neutral/backend doesn't break subsequent dispatches.
{
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    const seen = [];
    const d = createEntityDispatcher({
      neutral: { [KIND.SPAWN]: () => { throw new Error("neutral boom"); } },
      backend: {
        [KIND.SPAWN]: () => { throw new Error("backend boom"); },
        [KIND.REMOVE]: () => seen.push("remove"),
      },
      label: "boom",
    });
    let threw = false;
    let r1;
    try { r1 = d.dispatch({ kind: KIND.SPAWN }); } catch (_) { threw = true; }
    const r2 = d.dispatch({ kind: KIND.REMOVE });
    check("throwing neutral+backend → caught (never throws), backend counted",
      !threw && r1 === true && warns.length === 2);
    check("subsequent dispatch unaffected by prior throw",
      r2 === true && seen[0] === "remove");
  } finally {
    console.warn = origWarn;
  }
}

// Dispatcher never touches `.free` (Proxy guard — the drain owns the
// wasm-bindgen lifetime).
{
  const touched = [];
  const target = { kind: KIND.MOTION, guid: 7 };
  const proxied = new Proxy(target, {
    get(t, prop) {
      if (prop === "free") touched.push("free");
      return t[prop];
    },
  });
  const d = createEntityDispatcher({
    neutral: { [KIND.MOTION]: (u) => u.guid },
    backend: { [KIND.MOTION]: (u) => u.guid },
    label: "lifetime",
  });
  d.dispatch(proxied);
  check("dispatcher never accesses upd.free", touched.length === 0);
  check("null/undefined upd → false, no throw",
    d.dispatch(null) === false && d.dispatch(undefined) === false);
}

// ---------------------------------------------------------------------
// PART 2 — static (index.html + loop.js + modules as text)
// ---------------------------------------------------------------------
console.log("PART 2: static source checks");

const indexHtml = readFileSync(joinPath(__dirname, "index.html"), "utf8");
const loopJs = readFileSync(joinPath(__dirname, "scene3d", "loop.js"), "utf8");
const worldStreamJs = readFileSync(joinPath(__dirname, "scene3d", "world_stream.js"), "utf8");

check("index.html: __UNIFIED_DISPATCH flag const reads ?unifiedDispatch",
  indexHtml.includes("const __UNIFIED_DISPATCH") &&
  indexHtml.includes('.get("unifiedDispatch")'));
check("index.html: imports createWorldStreamer from scene3d/world_stream.js",
  /import\s*\{\s*createWorldStreamer\s*\}\s*from\s*"\.\/scene3d\/world_stream\.js"/.test(indexHtml));
check("index.html: imports KIND + createEntityDispatcher from scene3d/entity_dispatch.js",
  /import\s*\{[^}]*createEntityDispatcher[^}]*\}\s*from\s*"\.\/scene3d\/entity_dispatch\.js"/.test(indexHtml));
check("index.html: worldStreamer instantiated with the four shared Sets",
  (() => {
    const i = indexHtml.indexOf("const worldStreamer = createWorldStreamer({");
    if (i < 0) return false;
    const inst = indexHtml.slice(i, i + 1500);
    return ["terrainPrefetchedLbs", "buildingAabbsPopulatedLbs",
            "cellContainersPopulatedLbs", "objectsRenderAddedLbs"]
      .every((s) => inst.includes(s));
  })());
check("index.html: __dispatch2d built over the shared table (2d-drain)",
  indexHtml.includes("const __dispatch2d = createEntityDispatcher({") &&
  indexHtml.includes('label: "2d-drain"') &&
  indexHtml.includes("[ENTITY_KIND.POSITION]: (upd) => worldStreamer.onPositionUpdate(upd)"));

// Drift guard: ordered streaming call-name sequence must be IDENTICAL
// between the legacy A15-Q4-SYNC block (index.html) and world_stream.js.
function extractSeq(src, { emitPattern }) {
  const begin = src.indexOf("A15-Q4-SYNC: begin streaming sequence");
  const end = src.indexOf("A15-Q4-SYNC: end streaming sequence");
  if (begin < 0 || end < 0 || end <= begin) return null;
  const block = src.slice(begin, end);
  const pats = [
    ["landblockChanged", emitPattern],
    ["ensureTerrainAroundLandblock", /ensureTerrainAroundLandblock\(/g],
    ["ensureBuildingAabbsAroundLandblock", /ensureBuildingAabbsAroundLandblock\(/g],
    ["ensureCellContainersForLandblock", /ensureCellContainersForLandblock\(/g],
    ["loadEnvCellsForLandblock", /\.loadEnvCellsForLandblock\(/g],
    // A4 (2026-07-11 s13): the terrain step is now the batched
    // `.loadTerrainRing(` facade with a `.loadTerrainForLandblock(` solo
    // fallback in the same block. Match EITHER spelling → one "loadTerrain"
    // token; the consecutive-dedupe below collapses the primary+fallback pair
    // so a converted block and an un-converted (still-solo) copy both reduce
    // to a single canonical step — the drift guard stays green through the
    // coordinator's index.html conversion either way.
    ["loadTerrain", /\.loadTerrain(?:Ring|ForLandblock)\(/g],
    ["loadBuildingsForLandblock", /\.loadBuildingsForLandblock\(/g],
    ["loadStaticsForLandblock", /\.loadStaticsForLandblock\(/g],
    ["loadSpawnsForLandblock", /\.loadSpawnsForLandblock\(/g],
    ["ensureLandblockObjectsForLandblock", /ensureLandblockObjectsForLandblock\(/g],
  ];
  const hits = [];
  for (const [tok, re] of pats) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(block)) !== null) hits.push([m.index, tok]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  const ordered = hits.map((h) => h[1]);
  // Collapse consecutive duplicates (the batched-facade primary + solo-loop
  // fallback both count as the single "loadTerrain" streaming step).
  return ordered.filter((t, i) => t !== ordered[i - 1]);
}
const legacySeq = extractSeq(indexHtml, {
  emitPattern: /\.emit\("landblockChanged"/g,
});
const moduleSeq = extractSeq(worldStreamJs, {
  emitPattern: /emitLandblockChanged\(prevLb, lbId\)/g,
});
check("drift guard: A15-Q4-SYNC markers present in both copies",
  Array.isArray(legacySeq) && Array.isArray(moduleSeq));
check("drift guard: legacy block vs world_stream.js — IDENTICAL call sequence",
  JSON.stringify(legacySeq) === JSON.stringify(moduleSeq),
  `legacy=[${legacySeq?.join(",")}] module=[${moduleSeq?.join(",")}]`);
check("drift guard: sequence is the canonical 10-step streaming order",
  JSON.stringify(moduleSeq) === JSON.stringify([
    "landblockChanged",
    "ensureTerrainAroundLandblock",
    "ensureBuildingAabbsAroundLandblock",
    "ensureCellContainersForLandblock",
    "loadEnvCellsForLandblock",
    "loadTerrain",
    "loadBuildingsForLandblock",
    "loadStaticsForLandblock",
    "loadSpawnsForLandblock",
    "ensureLandblockObjectsForLandblock",
  ]));
check("drift guard: both copies keep the 3×3 ring 0x00/0xff edge clamp",
  (() => {
    const clamp = "nx < 0 || nx > 0xff || ny < 0 || ny > 0xff";
    const begin = indexHtml.indexOf("A15-Q4-SYNC: begin streaming sequence");
    const end = indexHtml.indexOf("A15-Q4-SYNC: end streaming sequence");
    return indexHtml.slice(begin, end).includes(clamp) && worldStreamJs.includes(clamp);
  })());

check("loop.js: imports KIND + createEntityDispatcher from ./entity_dispatch.js",
  /import\s*\{\s*KIND,\s*createEntityDispatcher\s*\}\s*from\s*"\.\/entity_dispatch\.js"/.test(loopJs));
check("loop.js: old KIND literals gone (aliases over the shared table)",
  !/const KIND_POSITION = 0;/.test(loopJs) && !/const KIND_TURN = 9;/.test(loopJs) &&
  loopJs.includes("const KIND_POSITION = KIND.POSITION;"));
check("loop.js: UNIFIED_DISPATCH_ON flag const reads ?unifiedDispatch",
  loopJs.includes("const UNIFIED_DISPATCH_ON") &&
  loopJs.includes('.get("unifiedDispatch")'));
check("loop.js: flag-on 3d dispatcher has EMPTY neutral table + no META_REFRESH backend",
  (() => {
    const i = loopJs.indexOf("const _dispatcher3d = UNIFIED_DISPATCH_ON");
    if (i < 0) return false;
    const block = loopJs.slice(i, loopJs.indexOf(": null;", i));
    return block.includes("neutral: {}") && !block.includes("[KIND.META_REFRESH]");
  })());
check("loop.js: all 9 _arm* backends registered in the 3d table",
  ["POSITION", "SPAWN", "REMOVE", "VELOCITY", "MOTION", "APPEARANCE",
   "ATTACH", "MOTION_ACTION", "TURN"]
    .every((k) => loopJs.includes(`[KIND.${k}]: (upd) => _arm`)));
check("loop.js: flag-off if-chain calls the same _arm* functions",
  ["_armSpawn", "_armRemove", "_armPosition", "_armVelocity", "_armMotion",
   "_armMotionAction", "_armTurn", "_armAppearance", "_armAttach", "_armMetaRefresh"]
    .every((f) => loopJs.includes(`${f}(scene3d, em, upd);`)));

// `.free()` lifetime: unconditional at the drain-loop tail (both flag
// states), and the dispatcher/named pieces never free.
check("index.html: upd.free() unconditional at the entity drain-loop tail",
  (() => {
    const loop = indexHtml.indexOf("for (const upd of entityUpdates) {");
    if (loop < 0) return false;
    const tail = indexHtml.indexOf("upd.free();", loop);
    if (tail < 0) return false;
    // The free must be the loop-tail statement: next non-empty line
    // closes the for-loop.
    const after = indexHtml.slice(tail + "upd.free();".length, tail + 200);
    return /^\s*\}/.test(after) && indexHtml.includes("__dispatch2d.dispatch(upd);");
  })());
check("index.html: dispatch2dSpawn/neutralSpawn/neutralRemove extracted, no .free in them",
  (() => {
    for (const fn of ["function dispatch2dSpawn(upd)", "function neutralSpawn(upd)", "function neutralRemove(upd)"]) {
      const i = indexHtml.indexOf(fn);
      if (i < 0) return false;
      const body = indexHtml.slice(i, indexHtml.indexOf("\n      }", i));
      if (body.includes(".free(")) return false;
    }
    return true;
  })());
check("entity_dispatch.js: factory CODE never calls upd.free (comments excluded)",
  !readFileSync(joinPath(__dirname, "scene3d", "entity_dispatch.js"), "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n")
    .includes(".free("));

const urlFlags = readFileSync(joinPath(__dirname, "docs", "url-flags.md"), "utf8");
check("docs/url-flags.md documents unifiedDispatch",
  urlFlags.includes("unifiedDispatch"));

console.log("");
console.log(`A15-Q4 renderer-neutral core: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
