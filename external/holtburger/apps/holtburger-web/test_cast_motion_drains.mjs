// Motion side-channel drain wiring (2026-08-01) — acceptance gate for the
// `?multiAction` / `?castAxes` drains in scene3d/loop.js.
//
// ## Why this test exists
//
// `pollMotionActions` / `pollMotionAxes` are MODULE-LEVEL wasm exports
// (`#[wasm_bindgen(js_name = …)] pub fn …` — src/lib.rs:40490 / :40515 →
// `export function pollMotionActions(): Uint32Array;` at
// pkg/holtburger_web.d.ts:9290 / :9297). They are NOT `SessionHandle` methods
// (contrast `pollRemotePoses`, which IS one — d.ts:5115).
//
// Both drains used to guard on `typeof sessionHandle.pollMotionActions ===
// "function"`, which is ALWAYS false, so `drainMotionActions` /
// `drainMotionAxes` returned on their first line every frame and the two
// documented DEFAULT-ON flags had never executed in production. That silently
// dropped, among other things, every non-newest windup gesture of a PK
// ("FastTick") caster: ACE packs the whole `spell.Formula.WindupGestures` list
// into ONE UpdateMotion's `commands` vector (Player_Magic.cs:645
// `EnqueueMotionAction` → WorldObject_Networking.cs:1231-1273) and the wasm main
// path emits only the NEWEST of them as KIND_MOTION_ACTION
// (src/lib.rs:45716-45737) — every earlier windup is routed to this drain.
//
// The fix resolves the free function off `scene3d.wasmExports` (the same
// typeof-guarded namespace-rider bag every other module-level wasm export rides
// through index.html), while still preferring a `SessionHandle` method if one
// ever appears.
//
// ## What is asserted
//
//   PART 1 — the drains actually INVOKE the module-level export off
//            `scene3d.wasmExports` and route rows to the EntityManager.
//   PART 2 — a `SessionHandle` METHOD of the same name still wins (future-proof
//            for a Rust move onto the handle).
//   PART 3 — the `?multiAction=off` / `?castAxes=off` escapes still short-circuit
//            BEFORE the poll (the poll fn must never be called).
//   PART 4 — behaviour contracts preserved: local guid skipped, 15-bit stamp
//            dedup, sidestep→setSidestepLayer, turn-in-place→setMotion,
//            turn-while-forward ignored.
//   PART 5 — source guard: the dead `typeof sessionHandle.pollMotionX` guard
//            must not come back.
//
// loop.js imports three-dependent modules, so this test source-transforms it the
// same way test_a15_q3_dispatch_parity.mjs does: strip imports, stub the
// imported names, append test-only exports for the module-private drains. The
// SHIPPED module surface is unchanged.
//
// Run:
//   cd apps/holtburger-web/
//   node test_cast_motion_drains.mjs

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

// ---------------------------------------------------------------------
// Source transform (same shape as test_a15_q3_dispatch_parity.mjs).
// ---------------------------------------------------------------------
const LOOP_PATH = joinPath(__dirname, "scene3d", "loop.js");
const rawLoop = readFileSync(LOOP_PATH, "utf8");
const stripped = rawLoop.replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, "");
const stubs = `
// test stubs for stripped imports (test_cast_motion_drains.mjs)
const tickCellVisibility3D = () => {};
const tickPortalStencil = () => {};
const tickPortalPunch = () => {};
const tickPvsLoadExpansion = () => {};
const statAtlasEnabled = () => false;
const tickStatAtlasOptimize = () => {};
const statBatchChunkEnabled = () => false;
const tickStatBatchXOptimize = () => {};
const terrainBatchEnabled = () => false;
const tickTerrainBatchOptimize = () => {};
const tickLightingForCellState = () => {};
const tickFlameFlicker = () => {};
const cullTerrainGroup = () => {};
const BUILDINGS_SHADOW_RANGE_SQ_M = 0;
const STATICS_SHADOW_RANGE_SQ_M = 0;
const cullStaticsGroup = () => {};
const tickStaticParticles = () => {};
const tickLodBandDiag = () => {};
const getTerrainVisualZ = (sc, x, y, z) => z;
const tickFrustumCull = () => {};
const setCullers = () => {};
const tickEntityRenderVisibility = () => {};
const tickPortalSpace = () => {};
const cloneEntityUpdate = (u) => ({ ...u });
const weatherForState = () => null;
const wxUpdateFromDayGroup = () => {};
const createClientEventDispatcher = () => () => false;
const KIND = Object.freeze({
  POSITION: 0, SPAWN: 1, REMOVE: 2, META_REFRESH: 3, VELOCITY: 4,
  MOTION: 5, APPEARANCE: 6, ATTACH: 7, MOTION_ACTION: 8, TURN: 9,
});
const createEntityDispatcher = () => ({ dispatch: () => false });
const THREE = { Vector3: class { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } } };
const CRACK_GLOW_OSC_NAME = "crackGlow";
const VFX_GLOBALS = { uTime: 0 };
const getOscillator = () => null;
const lbChebyshev = () => 0;
const lbKeyOf = (x, y) => \`\${x},\${y}\`;
const parseRustPoseFlag = () => null;
const particleClockMode = () => "loop";
const rustPoseWorldFromPose = () => null;
const setMasterClock = () => {};
const terrainVfxTick = () => {};
const tickOscillators = () => {};
const tickWeatherInputs = () => {};
`;
const transformed =
  stubs + stripped +
  "\nexport { drainMotionActions as __testDrainActions, drainMotionAxes as __testDrainAxes };\n";

/**
 * Load a fresh copy of the transformed module with a given `?search`.
 * Flag IIFEs read window.location.search at MODULE LOAD, so each flag config
 * needs its own salted data-URL import.
 */
async function loadLoop(search, salt, localGuid = null) {
  globalThis.window = globalThis.window || {};
  globalThis.window.location = { search };
  globalThis.window.getLocalPlayerGuid =
    localGuid == null ? undefined : () => localGuid >>> 0;
  const src = `// salt:${salt}\n${transformed}`;
  const url = "data:text/javascript;base64," + Buffer.from(src).toString("base64");
  return import(url);
}

// ---------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------
function makeEm() {
  const calls = [];
  return {
    calls,
    setMotion: (...a) => calls.push(["setMotion", ...a]),
    setSidestepLayer: (...a) => calls.push(["setSidestepLayer", ...a]),
  };
}

/** scene3d stub carrying the wasmExports bag index.html builds. */
function makeScene(em, wasmExports) {
  return { entityManager: em, wasmExports };
}

const REMOTE_GUID = 0x80000123;
const LOCAL_GUID = 0x50000001;
// MagicPowerUp08Purple (0x10000132) — the level-8 scarab windup gesture. The
// wire carries the LOW-16 (MotionItem truncates: ACE MotionItem.cs:16-19), and
// entities.js `expandActionCommandLow16` re-prefixes 0x011F..0x0134 → 0x10.
const WINDUP_08_PURPLE_LOW = 0x0132;
const WINDUP_04_LOW = 0x0072; // MagicPowerUp04
const MAGIC_STANCE = 0x0049;
const SIDESTEP_RIGHT_LOW = 0x000f;
const TURN_RIGHT_LOW = 0x000d;

console.log("===========================================================");
console.log("Motion side-channel drain wiring — ?multiAction / ?castAxes");
console.log("===========================================================");

// ---------------------------------------------------------------------
// PART 1 — the module-level export off scene3d.wasmExports is invoked.
// ---------------------------------------------------------------------
console.log("\nPART 1 — module-level wasm export is resolved + invoked");
{
  const m = await loadLoop("", "p1a");
  const em = makeEm();
  let pollCalls = 0;
  // Two windups from ONE FastTick UpdateMotion `commands` list, the shape a
  // multi-scarab spell produces (src/lib.rs:45731 pushes 4 u32 per action).
  const wasmExports = {
    pollMotionActions: () => {
      pollCalls += 1;
      return Uint32Array.from([
        REMOTE_GUID, WINDUP_04_LOW, 11, MAGIC_STANCE,
        REMOTE_GUID, WINDUP_08_PURPLE_LOW, 12, MAGIC_STANCE,
      ]);
    },
  };
  // sessionHandle deliberately has NO pollMotionActions method — this is the
  // exact production shape that used to dead-return.
  m.__testDrainActions(makeScene(em, wasmExports), { notThePollFn: true });
  check("pollMotionActions (module export) was called", pollCalls === 1, `calls=${pollCalls}`);
  check(
    "both queued windups played via em.setMotion",
    em.calls.length === 2 &&
      em.calls[0][0] === "setMotion" &&
      em.calls[0][2] === WINDUP_04_LOW &&
      em.calls[1][2] === WINDUP_08_PURPLE_LOW,
    JSON.stringify(em.calls),
  );
  check(
    "stance is forwarded verbatim (Magic 0x49)",
    em.calls.every((c) => c[3] === MAGIC_STANCE),
    JSON.stringify(em.calls.map((c) => c[3])),
  );
}
{
  const m = await loadLoop("", "p1b");
  const em = makeEm();
  let pollCalls = 0;
  const wasmExports = {
    pollMotionAxes: () => {
      pollCalls += 1;
      // [guid, stance, sidestep_low, turn_low, forward_idle]
      return Uint32Array.from([REMOTE_GUID, MAGIC_STANCE, SIDESTEP_RIGHT_LOW, 0, 1]);
    },
  };
  m.__testDrainAxes(makeScene(em, wasmExports), {});
  check("pollMotionAxes (module export) was called", pollCalls === 1, `calls=${pollCalls}`);
  check(
    "sidestep row routed to setSidestepLayer",
    em.calls.length === 1 &&
      em.calls[0][0] === "setSidestepLayer" &&
      em.calls[0][2] === SIDESTEP_RIGHT_LOW &&
      em.calls[0][3] === MAGIC_STANCE,
    JSON.stringify(em.calls),
  );
}

// ---------------------------------------------------------------------
// PART 2 — a SessionHandle METHOD still wins if one exists.
// ---------------------------------------------------------------------
console.log("\nPART 2 — SessionHandle method takes precedence when present");
{
  const m = await loadLoop("", "p2");
  const em = makeEm();
  let viaHandle = 0;
  let viaModule = 0;
  const sessionHandle = {
    pollMotionActions() {
      viaHandle += 1;
      return Uint32Array.from([REMOTE_GUID, WINDUP_08_PURPLE_LOW, 5, MAGIC_STANCE]);
    },
  };
  const wasmExports = {
    pollMotionActions: () => {
      viaModule += 1;
      return Uint32Array.from([]);
    },
  };
  m.__testDrainActions(makeScene(em, wasmExports), sessionHandle);
  check("handle method used", viaHandle === 1, `handle=${viaHandle}`);
  check("module export NOT used when the method exists", viaModule === 0, `module=${viaModule}`);
  check("row still played", em.calls.length === 1, JSON.stringify(em.calls));
}

// ---------------------------------------------------------------------
// PART 3 — the documented =off escapes short-circuit BEFORE the poll.
// ---------------------------------------------------------------------
console.log("\nPART 3 — ?multiAction=off / ?castAxes=off escapes");
{
  const m = await loadLoop("?multiAction=off", "p3a");
  const em = makeEm();
  let polls = 0;
  m.__testDrainActions(
    makeScene(em, { pollMotionActions: () => { polls += 1; return Uint32Array.from([REMOTE_GUID, 1, 1, 1]); } }),
    {},
  );
  check("?multiAction=off never polls", polls === 0, `polls=${polls}`);
  check("?multiAction=off plays nothing", em.calls.length === 0, JSON.stringify(em.calls));
}
{
  const m = await loadLoop("?castAxes=off", "p3b");
  const em = makeEm();
  let polls = 0;
  m.__testDrainAxes(
    makeScene(em, { pollMotionAxes: () => { polls += 1; return Uint32Array.from([REMOTE_GUID, 1, 1, 0, 1]); } }),
    {},
  );
  check("?castAxes=off never polls", polls === 0, `polls=${polls}`);
  check("?castAxes=off plays nothing", em.calls.length === 0, JSON.stringify(em.calls));
}
{
  // Absent param = ON (the `!== "off"` reader). Guards against a future
  // default flip going unnoticed.
  const m = await loadLoop("?someOtherFlag=1", "p3c");
  const em = makeEm();
  let polls = 0;
  m.__testDrainActions(
    makeScene(em, { pollMotionActions: () => { polls += 1; return Uint32Array.from([]); } }),
    {},
  );
  check("absent ?multiAction => DEFAULT-ON (polls)", polls === 1, `polls=${polls}`);
}

// ---------------------------------------------------------------------
// PART 4 — behaviour contracts.
// ---------------------------------------------------------------------
console.log("\nPART 4 — local-guid skip, stamp dedup, axis routing");
{
  const m = await loadLoop("", "p4a", LOCAL_GUID);
  const em = makeEm();
  m.__testDrainActions(
    makeScene(em, {
      pollMotionActions: () =>
        Uint32Array.from([
          LOCAL_GUID, WINDUP_08_PURPLE_LOW, 7, MAGIC_STANCE,
          REMOTE_GUID, WINDUP_08_PURPLE_LOW, 7, MAGIC_STANCE,
        ]),
    }),
    {},
  );
  check(
    "local guid skipped (own windups are predicted by playCastSequence)",
    em.calls.length === 1 && em.calls[0][1] === REMOTE_GUID,
    JSON.stringify(em.calls),
  );
}
{
  const m = await loadLoop("", "p4b");
  const em = makeEm();
  let call = 0;
  const wasmExports = {
    pollMotionActions: () => {
      call += 1;
      // Same 15-bit sequence re-broadcast (ACE re-sends UpdateMotion on
      // unrelated state changes) — must play exactly once.
      return Uint32Array.from([REMOTE_GUID, WINDUP_08_PURPLE_LOW, 9, MAGIC_STANCE]);
    },
  };
  const scene = makeScene(em, wasmExports);
  m.__testDrainActions(scene, {});
  m.__testDrainActions(scene, {});
  check("re-broadcast of the SAME sequence plays once (stamp dedup)", em.calls.length === 1, `plays=${em.calls.length} polls=${call}`);
}
{
  const m = await loadLoop("", "p4c");
  const em = makeEm();
  m.__testDrainAxes(
    makeScene(em, {
      // turn-in-place: turn set AND forward idle => the turn cycle plays.
      pollMotionAxes: () => Uint32Array.from([REMOTE_GUID, MAGIC_STANCE, 0, TURN_RIGHT_LOW, 1]),
    }),
    {},
  );
  check(
    "turn-in-place routes to setMotion(turn cycle)",
    em.calls.length === 1 && em.calls[0][0] === "setMotion" && em.calls[0][2] === TURN_RIGHT_LOW,
    JSON.stringify(em.calls),
  );
}
{
  const m = await loadLoop("", "p4d");
  const em = makeEm();
  m.__testDrainAxes(
    makeScene(em, {
      // turn set but forward ACTIVE (forward_idle = 0) => turn ignored, the
      // forward cycle owns the legs.
      pollMotionAxes: () => Uint32Array.from([REMOTE_GUID, MAGIC_STANCE, 0, TURN_RIGHT_LOW, 0]),
    }),
    {},
  );
  check("turn ignored while a forward command is active", em.calls.length === 0, JSON.stringify(em.calls));
}
{
  const m = await loadLoop("", "p4e");
  const em = makeEm();
  // No wasmExports at all (stale pkg/ → namespace access yields undefined).
  m.__testDrainActions(makeScene(em, {}), {});
  m.__testDrainAxes(makeScene(em, undefined), {});
  m.__testDrainActions(makeScene(em, { pollMotionActions: () => { throw new Error("boom"); } }), {});
  check("stale pkg / throwing poll degrade silently (no calls, no throw)", em.calls.length === 0, JSON.stringify(em.calls));
}

// ---------------------------------------------------------------------
// PART 5 — source guard: the dead method-only guard must not return.
// ---------------------------------------------------------------------
console.log("\nPART 5 — source guard");
{
  const deadGuard =
    /typeof\s+sessionHandle\.pollMotion(Actions|Axes)\s*!==\s*"function"/.test(rawLoop);
  check(
    "loop.js no longer gates the drains on a SessionHandle METHOD",
    !deadGuard,
    deadGuard ? "the always-false guard is back — the drains are dead again" : "",
  );
  check(
    "loop.js resolves the poll fns through resolveMotionPollFn",
    /function resolveMotionPollFn\(/.test(rawLoop) &&
      /resolveMotionPollFn\(scene3d, sessionHandle, "pollMotionActions"\)/.test(rawLoop) &&
      /resolveMotionPollFn\(scene3d, sessionHandle, "pollMotionAxes"\)/.test(rawLoop),
    "",
  );
  // index.html must actually put the module exports on the wasmExports bag that
  // becomes scene3d.wasmExports — otherwise the drain resolves to null forever
  // (the classic "plumb-through trap" this repo has hit repeatedly).
  const rawIndex = readFileSync(joinPath(__dirname, "index.html"), "utf8");
  check(
    "index.html plumbs pollMotionActions/pollMotionAxes into init3D's wasmExports",
    /pollMotionActions:\s*__hbWasmNs\.pollMotionActions/.test(rawIndex) &&
      /pollMotionAxes:\s*__hbWasmNs\.pollMotionAxes/.test(rawIndex),
    "",
  );
}

console.log("");
console.log(`Cases: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Motion drain wiring FAILED.");
  process.exit(1);
}
console.log("All motion drain wiring tests PASS.");
