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
  let s3d = liveScene3d === undefined ? s3dBase : liveScene3d;
  let localGuid = LOCAL_GUID;
  const deps = {
    calls,
    sets,
    s3dBase,
    // (x) 2026-08-03: lets a test model the real boot ordering — packets
    // drain while `window.liveScene3d` is still null, then init3D lands.
    setLiveScene3d: (v) => { s3d = v; },
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
  check("(iii) three wasm-bake ensure* called once each",
    count("ensureTerrainAroundLandblock") === 1 &&
    count("ensureBuildingAabbsAroundLandblock") === 1 &&
    count("ensureLandblockObjectsForLandblock") === 1);
  // s13 indoor 2D-gate, mirrored into world_stream.js 2026-08-03 (round 10).
  // With the renderer UP this call is pure duplicated decode: it is discarded
  // at ensureCellContainersForLandblock's own `!app` gate under ?renderer=3d,
  // and cells.js re-fetches the same EnvCells via loadEnvCellsForLandblock —
  // which is what actually queues the cell physics. Skipping it here does NOT
  // skip the collision data; (vii) below pins the case where it still must run.
  check("(iii) renderer UP ⇒ ensureCellContainersForLandblock SKIPPED (no 2x decode)",
    count("ensureCellContainersForLandblock") === 0,
    `called ${count("ensureCellContainersForLandblock")}x`);
  check("(iii) …and the EnvCell fetch that DOES queue cell physics still fires",
    count("loadEnvCellsForLandblock") === 1);
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
    // "ensureCellContainersForLandblock" is absent by design with the
    // renderer UP (round-10 s13 gate mirror) — its slot in the order is the
    // loadEnvCellsForLandblock call below, which performs the same wasm
    // fetch. The (vii) null-renderer case still pins it present.
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
  // PHY-25 effect (B) `?loadPointShiftOnly` (default ON, 2026-07-27): the
  // per-update 3D loaders no longer re-fire either — retail's
  // `LScape::update_loadpoint` rebuilds only on a real block shift
  // (acclient.c:308340). `?loadPointShiftOnly=off` restores the legacy
  // per-packet re-fire (arm (ix) below).
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
  check("(iv) heartbeat → outdoor ring NOT re-evaluated (PHY-25 effect B)",
    !names2.includes("loadTerrainRing") &&
    !names2.includes("loadBuildingsForLandblock") &&
    !names2.includes("loadStaticsForLandblock") &&
    !names2.includes("loadSpawnsForLandblock"),
    names2.join(","));
  check("(iv) heartbeat → indoor content hook still fires every packet",
    names2.includes("loadEnvCellsForLandblock"));
  check("(iv) heartbeat counted as a shift-skip, not a gate hold",
    ws._debugState().shiftSkippedRingEvals === 1 &&
    ws._debugState().heldRingEvals === 0,
    JSON.stringify(ws._debugState()));

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
// (viii)/(ix) PHY-25 dungeon stream gate (P0.1, 2026-07-27)
//
// The flags are read ONCE at module load, so each arm re-imports
// world_stream.js under a cache-busting query with a stubbed
// `globalThis.location`. Cell low word >= 0x100 == indoors
// (CellManager::UpdateLoadPoint, acclient.c:146439).
// ---------------------------------------------------------------------
console.log("");
console.log("PART 1a-bis: PHY-25 dungeon stream gate");

const OUTDOOR = 0xa9b40021; // cell 0x0021 → outdoor
const INDOOR = 0xa9b40105;  // cell 0x0105 → EnvCell (dungeon / interior)

async function loadStreamerArm(search, tag) {
  const prev = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    value: { search },
    configurable: true,
    writable: true,
  });
  try {
    return (await import(`./scene3d/world_stream.js?arm=${tag}`)).createWorldStreamer;
  } finally {
    if (prev) Object.defineProperty(globalThis, "location", prev);
    else delete globalThis.location;
  }
}

// (viii) gate ON (the shipped default) — indoors admits nothing outdoor.
{
  const make = await loadStreamerArm("?", "default");
  const deps = makeDeps();
  const ws = make(deps);
  // Arrive outdoors: full ring.
  ws.onPositionUpdate(posUpd(LOCAL_GUID, OUTDOOR));
  const outNames = deps.calls.map((c) => c[0]);
  check("(viii) gate ON, outdoors → full outdoor ring fires",
    outNames.includes("loadTerrainRing") &&
    outNames.includes("loadStaticsForLandblock") &&
    outNames.includes("loadSpawnsForLandblock"));

  // Now indoors in a DIFFERENT LB (a dungeon teleport) — a real block shift,
  // so effect (B) would allow it; only the indoor gate can stop it.
  deps.calls.length = 0;
  ws.onPositionUpdate(posUpd(LOCAL_GUID, 0xa9c40105));
  const inNames = deps.calls.map((c) => c[0]);
  check("(viii) gate ON, indoors → ZERO outdoor render admissions",
    !inNames.includes("loadTerrainRing") &&
    !inNames.includes("loadTerrainForLandblock") &&
    !inNames.includes("loadBuildingsForLandblock") &&
    !inNames.includes("loadStaticsForLandblock") &&
    !inNames.includes("loadSpawnsForLandblock") &&
    !inNames.includes("ensureLandblockObjectsForLandblock"),
    inNames.join(","));
  check("(viii) gate ON, indoors → wasm collision bakes STILL fire (invariant 2)",
    inNames.includes("ensureTerrainAroundLandblock") &&
    inNames.includes("ensureBuildingAabbsAroundLandblock"));
  // Cell collision is NOT dropped by the round-10 gate — with the renderer up
  // it arrives through loadEnvCellsForLandblock (asserted immediately below),
  // which calls the same wasm fetchEnvCellsInLandblock that queues
  // CELL_PHYSICS_PENDING / CELL_BSP_PENDING. The invariant is "indoor cell
  // collision still gets queued", not "this particular function was called".
  check("(viii) gate ON, indoors → cell collision still queued via the EnvCell fetch",
    inNames.includes("loadEnvCellsForLandblock"));
  check("(viii) gate ON, indoors → EnvCell (interior) load still fires",
    inNames.includes("loadEnvCellsForLandblock"));
  check("(viii) gate ON, indoors → landblockChanged still emitted",
    inNames.includes("emitLandblockChanged"));

  // 20 more indoor heartbeats: still flat.
  deps.calls.length = 0;
  for (let i = 0; i < 20; i += 1) ws.onPositionUpdate(posUpd(LOCAL_GUID, 0xa9c40105 + i));
  check("(viii) gate ON, 20 indoor heartbeats → still zero outdoor admissions",
    deps.calls.filter((c) => c[0].startsWith("load") && c[0] !== "loadEnvCellsForLandblock")
      .length === 0);
  const st = ws._debugState();
  check("(viii) counters: heldRingEvals == 21, indoorPackets == 21",
    st.heldRingEvals === 21 && st.indoorPackets === 21, JSON.stringify(st));

  // Leaving the dungeon out its own LB is NOT an `lbId` change but IS a real
  // load-point shift — the ring must fire or the player stands in a void.
  deps.calls.length = 0;
  ws.onPositionUpdate(posUpd(LOCAL_GUID, 0xa9c40021)); // same LB, outdoor cell
  const exitNames = deps.calls.map((c) => c[0]);
  check("(viii) exit to outdoors in the SAME LB → ring resumes (lastRingLb, not lastLb)",
    exitNames.includes("loadTerrainRing") &&
    exitNames.includes("loadStaticsForLandblock"),
    exitNames.join(","));

  // Round trip A → dungeon B → A. The live probe (2026-07-27) hit exactly
  // this: without the indoor load-point invalidation the return leg is
  // `lbId === lastRingLb` and gets shift-skipped, while the sealed purge may
  // have parked A's whole ring during the dwell.
  const deps2 = makeDeps();
  const ws2 = make(deps2);
  ws2.onPositionUpdate(posUpd(LOCAL_GUID, OUTDOOR));            // A, outdoors
  ws2.onPositionUpdate(posUpd(LOCAL_GUID, 0x00070143));         // dungeon B
  ws2.onPositionUpdate(posUpd(LOCAL_GUID, 0x00070144));         // dwell
  deps2.calls.length = 0;
  ws2.onPositionUpdate(posUpd(LOCAL_GUID, OUTDOOR));            // back to A
  const rtNames = deps2.calls.map((c) => c[0]);
  check("(viii) round trip A→dungeon→A → ring re-evaluated on return to A",
    rtNames.includes("loadTerrainRing") &&
    rtNames.includes("loadStaticsForLandblock") &&
    rtNames.includes("loadBuildingsForLandblock"),
    rtNames.join(","));
  check("(viii) indoor dwell invalidates the load point (lastRingLb cleared)",
    ws2._debugState().ringEvals === 2, JSON.stringify(ws2._debugState()));
}

// (ix) `?dungeonStreamGate=off` + `?loadPointShiftOnly=off` — legacy behavior.
{
  const make = await loadStreamerArm("?dungeonStreamGate=off&loadPointShiftOnly=off", "off");
  const deps = makeDeps();
  const ws = make(deps);
  ws.onPositionUpdate(posUpd(LOCAL_GUID, INDOOR));
  const n1 = deps.calls.map((c) => c[0]);
  check("(ix) gate OFF, indoors → outdoor ring fires (legacy)",
    n1.includes("loadTerrainRing") && n1.includes("loadSpawnsForLandblock"));
  deps.calls.length = 0;
  ws.onPositionUpdate(posUpd(LOCAL_GUID, INDOOR + 1));
  const n2 = deps.calls.map((c) => c[0]);
  check("(ix) shiftOnly OFF → same-LB heartbeat re-fires the ring (legacy parity)",
    n2.filter((x) => x === "loadTerrainRing").length === 1 &&
    n2.includes("loadSpawnsForLandblock"));
  const st = ws._debugState();
  check("(ix) control arm still counts wouldHoldRingEvals for A/B comparison",
    st.gateOn === false && st.wouldHoldRingEvals === 2 && st.heldRingEvals === 0,
    JSON.stringify(st));
}

// (x) `?eagerDungeons=on` wins over the default-on gate (capture-script arm).
{
  const make = await loadStreamerArm("?eagerDungeons=on", "eager");
  const deps = makeDeps();
  const ws = make(deps);
  ws.onPositionUpdate(posUpd(LOCAL_GUID, INDOOR));
  const n = deps.calls.map((c) => c[0]);
  check("(x) ?eagerDungeons=on → indoor gate disabled, ring fires",
    n.includes("loadTerrainRing") && n.includes("loadStaticsForLandblock"),
    n.join(","));
  check("(x) ?eagerDungeons=on → gateOn reported false",
    ws._debugState().gateOn === false);
}

// (xi) an explicit `?dungeonStreamGate=on` beats `?eagerDungeons=on`? No —
// documented precedence is eagerDungeons wins; pin it so it can't drift.
{
  const make = await loadStreamerArm("?dungeonStreamGate=garbage", "garbage");
  const deps = makeDeps();
  const ws = make(deps);
  ws.onPositionUpdate(posUpd(LOCAL_GUID, INDOOR));
  check("(xi) unrecognised ?dungeonStreamGate value → still ON (default-on contract)",
    ws._debugState().gateOn === true &&
    !deps.calls.map((c) => c[0]).includes("loadTerrainRing"));
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

// ---------------------------------------------------------------------
// (x) PHY-25 effect (B) — the pre-init3D load-point latch (2026-08-03 F4)
//
// The net pump starts BEFORE the renderer: index.html runs
// `requestAnimationFrame(drainEvents)` and only then `await renderHoltburg()`
// → `await init3D(...)`, and `getLiveScene3d()` reads `window.liveScene3d`,
// which index.js assigns at the END of init3D. Position packets in that
// window must NOT claim the load point — if they do, every later packet in
// the same LB is shift-skipped and the spawn landblock never streams.
{
  const deps = makeDeps({ liveScene3d: null });
  const ws = createWorldStreamer(deps);
  // 1. Packets during init3D (renderer null).
  ws.onPositionUpdate(posUpd(LOCAL_GUID, 0xa9b40021));
  ws.onPositionUpdate(posUpd(LOCAL_GUID, 0xa9b40021));
  const pre = ws._debugState();
  check("(x) pre-init3D packets do not claim the load point",
    pre.lastRingLb === 0 && pre.ringEvals === 0 && pre.preRendererRingEvals === 2,
    JSON.stringify(pre));

  // 2. init3D finishes — the renderer appears, same landblock, no movement.
  deps.setLiveScene3d(deps.s3dBase);
  deps.calls.length = 0;
  ws.onPositionUpdate(posUpd(LOCAL_GUID, 0xa9b40021));
  const names = deps.calls.map((c) => c[0]);
  check("(x) first post-init3D packet streams the spawn LB",
    names.includes("loadTerrainRing") &&
    names.includes("loadBuildingsForLandblock") &&
    names.includes("loadStaticsForLandblock") &&
    names.includes("loadSpawnsForLandblock"),
    names.join(","));
  check("(x) and it claims the load point exactly once",
    ws._debugState().ringEvals === 1 &&
    ws._debugState().lastRingLb === 0xa9b40000,
    JSON.stringify(ws._debugState()));

  // 3. Steady state is unchanged — later same-LB packets still shift-skip.
  deps.calls.length = 0;
  ws.onPositionUpdate(posUpd(LOCAL_GUID, 0xa9b40021));
  check("(x) subsequent same-LB packets still shift-skip (effect B intact)",
    !deps.calls.map((c) => c[0]).includes("loadTerrainRing") &&
    ws._debugState().shiftSkippedRingEvals === 1,
    JSON.stringify(ws._debugState()));
}

const urlFlags = readFileSync(joinPath(__dirname, "docs", "url-flags.md"), "utf8");
check("docs/url-flags.md documents unifiedDispatch",
  urlFlags.includes("unifiedDispatch"));

console.log("");
console.log(`A15-Q4 renderer-neutral core: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
