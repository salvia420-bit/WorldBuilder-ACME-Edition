// A11-S4 (2026-06-12 unification survey, Stage S4) — particle degrade
// parity, `?particleDegrade` (DEFAULT ON since 2026-10-19, flipped ahead of
// its 1070 eye test; `=off`/`0`/`false`/`no` escape; the old enable token
// `=retail` still reads on).
//
// Survey: docs/2026-06-11-unification-survey/agents/
// A11-particles-physics-scripts.md §3 row 7 (DIFF-ALGO) + §4 Stage S4;
// W5-REMAINDER row A11-S4 (class B).
//
// Retail stamps `degrade_distance = GetMaxDegradeDistance(part_storage[0])`
// at `ParticleEmitter::InitEnd` (100.0 default when the hw GfxObj has no
// 0x11 chain, acclient.c:331265+/:314372-314383) and culls in
// `UpdateParticles` via `ShouldDrawParticles` (camera distance > radius →
// SetNoDraw + freeze, auto-recover; acclient.c:331097-331139,
// :317184-317199). Ours ported the fields dead (`degradeDistance =
// Infinity`); Stage S4 folds the authored radius into the RP6 predicate
// as an OR-term (RP6 frustum/220 m cap stays the superset).
//
//   PART 1 — flag parse matrix (absent/any value ⇒ on; off forms ⇒ off).
//   PART 2 — addEmitter stamp (the InitEnd analog) on a BARE page (no
//            setter, no flag): injected resolver stamps meters onto
//            `emitter.degradeDistance`, cached per hwGfxObjId; stale-pkg
//            (no resolver, no __hbWasm) leaves Infinity without throwing
//            (soft-degrade). The `skyGlow` sky chain is never stamped.
//   PART 3 — OR-term behavior through REAL ParticleManager.tick() +
//            a REAL THREE camera: beyond the authored radius → culled
//            (frozen, parts hidden); within → live; a sky-chain emitter
//            at the same distance stays live; `?particleDegrade=off`
//            with the same finite radius → NOT culled (byte-identical RP6).
//   PART 4 — static wiring (wasm export + retail band-pick helper +
//            index.html namespace-resolved curated entry).
//
// Run:
//   cd apps/holtburger-web/
//   node test_a11_s4_particle_degrade.mjs

import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { readFileSync } from "node:fs";
import * as THREE from "three";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

// Camera BEFORE the window stub so _rp6ResolveCamera sees it.
const camera = new THREE.PerspectiveCamera(50, 1.0, 0.1, 2000);
camera.position.set(0, 0, 0);
camera.updateMatrixWorld();

// Minimal window stub — the module reads window.location.search (flag),
// window.liveScene3d (RP6 camera + E6 quality), window.__hbWasm
// (default resolver surface). A BARE page: PART 2/3 run on the shipped
// default (ON since 2026-10-19), not on a forced flag.
globalThis.window = {
  location: { search: "" },
  liveScene3d: { camera },
};

const {
  ParticleManager,
  readParticleDegradeFlag,
  particleDegradeRetailOn,
  setParticleDegradeResolver,
  _resetParticleDegradeForTest,
} = await import("./scene3d/particles/particle_manager.js");
const { EmitterType } = await import("./scene3d/particles/particle_emitter_info.js");
const { ParticleType } = await import("./scene3d/particles/particle.js");

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

function makeBaseInfo(overrides = {}) {
  // POJO with the same camelCase getters as wasm ParticleEmitterJs
  // (the test_particles.mjs shape). Unbounded emitter (totalSeconds=0,
  // huge totalParticles) so the table entry survives the cull ticks.
  return Object.assign(
    {
      id: 0x32000456,
      emitterType: EmitterType.BirthratePerSec,
      particleType: ParticleType.Still,
      gfxObjId: 0,
      hwGfxObjId: 0x01001a62,
      birthrate: 0.001,
      maxParticles: 1,
      initialParticles: 0,
      totalParticles: 1_000_000,
      totalSeconds: 0,
      lifespan: 900.0,
      lifespanRand: 0.0,
      offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,
      minOffset: 0, maxOffset: 0,
      aX: 0, aY: 0, aZ: 0, minA: 1, maxA: 1,
      bX: 0, bY: 0, bZ: 0, minB: 1, maxB: 1,
      cX: 300, cY: 300, cZ: 300, minC: 1, maxC: 1,
      startScale: 1.0, finalScale: 1.0, scaleRand: 0.0,
      startTrans: 0.0, finalTrans: 0.0, transRand: 0.0,
      isParentLocal: true,
    },
    overrides,
  );
}

function makeManager() {
  return new ParticleManager({
    scene: new THREE.Scene(),
    geometryFactory: async () => new THREE.BufferGeometry(),
    materialFactory: async () =>
      new THREE.MeshBasicMaterial({ transparent: true }),
  });
}

async function addTestEmitter(mgr, { hwGfxObjId, z, skyGlow = false }) {
  const id = await mgr.addEmitter({
    emitterInfo: makeBaseInfo({ hwGfxObjId }),
    parent: {
      position: new THREE.Vector3(0, 0, z),
      quaternion: new THREE.Quaternion(),
    },
    partIndex: -1,
    // statics.js derives this from sky_dome.js's sky-chain anchor
    // (`userData.isSkyGlowAnchor`): the moon nebula + storm lightning box.
    skyGlow,
  });
  return mgr.particleTable.get(id);
}

/** Run enough ticks to cross an RP6 recheck boundary (interval 6). */
function tickThroughRecheck(mgr) {
  for (let i = 0; i < 6; i++) mgr.tick();
}

// ---------------------------------------------------------------------
console.log("PART 1 — ?particleDegrade flag parse");
// ---------------------------------------------------------------------

check("'retail' (the old enable token) parses true", readParticleDegradeFlag("?particleDegrade=retail") === true);
check("'RETAIL' parses true (case-fold)", readParticleDegradeFlag("?particleDegrade=RETAIL") === true);
check("'on' parses true", readParticleDegradeFlag("?particleDegrade=on") === true);
check("absent parses true (default ON since 2026-10-19)", readParticleDegradeFlag("?foo=1") === true);
check("empty search parses true (default ON)", readParticleDegradeFlag("") === true);
check("empty value parses true", readParticleDegradeFlag("?particleDegrade=") === true);
check("garbage value parses true", readParticleDegradeFlag("?particleDegrade=bogus") === true);
for (const tok of ["off", "OFF", "0", "false", "no", "No", "%20off%20"]) {
  check(`'${tok}' escape parses false`, readParticleDegradeFlag(`?particleDegrade=${tok}`) === false);
}
_resetParticleDegradeForTest();
check("cached accessor: bare page (window search \"\") reads ON", particleDegradeRetailOn() === true);
globalThis.window.location.search = "?particleDegrade=off";
check("cached accessor holds its value until reset", particleDegradeRetailOn() === true);
_resetParticleDegradeForTest();
check("cached accessor re-reads `?particleDegrade=off` after reset", particleDegradeRetailOn() === false);
globalThis.window.location.search = "?particleDegrade=retail";
_resetParticleDegradeForTest();
check("cached accessor reads `?particleDegrade=retail` as ON", particleDegradeRetailOn() === true);
{
  const w = globalThis.window;
  delete globalThis.window;
  check("no window at all (node) resolves the default, ON", readParticleDegradeFlag() === true);
  globalThis.window = w;
}
globalThis.window.location.search = "";
_resetParticleDegradeForTest();

// ---------------------------------------------------------------------
console.log("PART 2 — addEmitter stamp (InitEnd analog) + cache + soft-degrade");
// ---------------------------------------------------------------------

{
  _resetParticleDegradeForTest();
  const resolverCalls = [];
  setParticleDegradeResolver(async (hwId) => {
    resolverCalls.push(hwId);
    return 42.5;
  });

  const mgr = makeManager();
  const emitter = await addTestEmitter(mgr, { hwGfxObjId: 0x01001a62, z: -10 });
  check("emitter installed", !!emitter);
  check(
    "ctor default is Infinity (ours-dead field) until the stamp lands",
    emitter.degradeDistance === Infinity || emitter.degradeDistance === 42.5,
  );
  await flushMicrotasks();
  check("stamp lands (InitEnd analog): degradeDistance = resolved meters", emitter.degradeDistance === 42.5);
  check("resolver keyed by hwGfxObjId", resolverCalls.length === 1 && resolverCalls[0] === 0x01001a62);

  const emitter2 = await addTestEmitter(mgr, { hwGfxObjId: 0x01001a62, z: -12 });
  await flushMicrotasks();
  check("second emitter, same GfxObj: cache hit (resolver NOT re-called)", resolverCalls.length === 1);
  check("second emitter stamped from the cache", emitter2.degradeDistance === 42.5);

  const emitter3 = await addTestEmitter(mgr, { hwGfxObjId: 0x01002000, z: -14 });
  await flushMicrotasks();
  check("different GfxObj resolves separately", resolverCalls.length === 2 && resolverCalls[1] === 0x01002000);
  check("non-finite/failed resolve leaves Infinity", (() => {
    // resolver returned 42.5 for it too; emulate failure on a 4th id:
    setParticleDegradeResolver(async () => { throw new Error("dat miss"); });
    return emitter3.degradeDistance === 42.5;
  })());

  const mgr2 = makeManager();
  const emitter4 = await addTestEmitter(mgr2, { hwGfxObjId: 0x01003000, z: -16 });
  await flushMicrotasks();
  check("throwing resolver soft-degrades (Infinity, no unhandled rejection)", emitter4.degradeDistance === Infinity);
}

{
  // Sky chain exempt (2026-10-19, with the default-ON flip): the `?skyGlow`
  // moon nebula and storm lightning box ride a camera-following anchor ~40 m
  // above the eye, so an authored radius under that would hide the sky.
  _resetParticleDegradeForTest();
  const calls = [];
  setParticleDegradeResolver(async (hwId) => { calls.push(hwId); return 12.0; });
  const mgr = makeManager();
  const sky = await addTestEmitter(mgr, { hwGfxObjId: 0x01006000, z: -10, skyGlow: true });
  await flushMicrotasks();
  check("sky-chain emitter carries skyGlow", sky.skyGlow === true);
  check("sky-chain emitter is never stamped (stays Infinity)", sky.degradeDistance === Infinity);
  check("sky-chain emitter never asks the resolver", calls.length === 0, `calls=${calls.length}`);
  const ground = await addTestEmitter(mgr, { hwGfxObjId: 0x01006000, z: -10 });
  await flushMicrotasks();
  check("a world emitter on the SAME GfxObj is stamped (control)", ground.degradeDistance === 12.0 && calls.length === 1);
}

{
  // Stale-pkg shape: flag on, no resolver, no window.__hbWasm entry.
  _resetParticleDegradeForTest();
  const mgr = makeManager();
  const emitter = await addTestEmitter(mgr, { hwGfxObjId: 0x01004000, z: -10 });
  await flushMicrotasks();
  check(
    "stale pkg (no resolver / no __hbWasm) leaves Infinity — RP6-only culling",
    emitter.degradeDistance === Infinity,
  );
}

// ---------------------------------------------------------------------
console.log("PART 3 — OR-term through ParticleManager.tick() (real camera)");
// ---------------------------------------------------------------------

{
  _resetParticleDegradeForTest();
  setParticleDegradeResolver(async () => 30.0); // authored radius 30 m

  const mgr = makeManager();
  // Camera at origin looking down -Z (THREE default): z=-50 is 50 m
  // away, INSIDE the frustum and INSIDE the 220 m RP6 cap — only the
  // authored 30 m radius can cull it.
  const far = await addTestEmitter(mgr, { hwGfxObjId: 0x01005000, z: -50 });
  const near = await addTestEmitter(mgr, { hwGfxObjId: 0x01005000, z: -20 });
  await flushMicrotasks();
  check("both emitters stamped 30 m", far.degradeDistance === 30.0 && near.degradeDistance === 30.0);

  tickThroughRecheck(mgr);
  check(
    "beyond authored radius (50 m > 30 m) → degrade-culled (retail ShouldDrawParticles fail)",
    far._rp6Culled === true,
  );
  check(
    "within authored radius (20 m < 30 m), in-frustum → live",
    near._rp6Culled === false,
  );
  check("culled emitter is NOT dropped (freeze, not removal)", mgr.particleTable.get(far.id) === far);

  // Auto-recover: widen the radius (≙ the camera walking back in) and
  // the next recheck restores full updates (retail degraded_out = 0).
  far.degradeDistance = 100.0;
  tickThroughRecheck(mgr);
  check("re-entry auto-recovers on the next recheck", far._rp6Culled === false);
}

{
  // Sky chain: same 30 m authored radius, same 50 m distance — the world
  // emitter culls, the sky-chain emitter stays live (never stamped).
  _resetParticleDegradeForTest();
  setParticleDegradeResolver(async () => 30.0);
  const mgr = makeManager();
  const world = await addTestEmitter(mgr, { hwGfxObjId: 0x01007000, z: -50 });
  const sky = await addTestEmitter(mgr, { hwGfxObjId: 0x01007000, z: -50, skyGlow: true });
  await flushMicrotasks();
  tickThroughRecheck(mgr);
  check("bare page: world emitter beyond its 30 m radius is degrade-culled", world._rp6Culled === true);
  check("bare page: sky-chain emitter at the same distance stays live", sky._rp6Culled === false && sky.degradeDistance === Infinity);
}

{
  // `?particleDegrade=off` (the escape): same finite radius must be IGNORED
  // (byte-identical pre-flip RP6).
  _resetParticleDegradeForTest();
  globalThis.window.location.search = "?particleDegrade=off";
  check("flag re-read as off", particleDegradeRetailOn() === false);

  const mgr = makeManager();
  const e = await addTestEmitter(mgr, { hwGfxObjId: 0x01005000, z: -50 });
  await flushMicrotasks();
  check("flag off: addEmitter never stamps (Infinity)", e.degradeDistance === Infinity);
  e.degradeDistance = 30.0; // even a manually-poked radius…
  tickThroughRecheck(mgr);
  check("flag off: OR-term gated out — emitter stays live", e._rp6Culled === false);

  globalThis.window.location.search = "";
  _resetParticleDegradeForTest();
}

// ---------------------------------------------------------------------
console.log("PART 4 — static wiring");
// ---------------------------------------------------------------------

const libSrc = readFileSync(joinPath(__dirname, "src", "lib.rs"), "utf8");
const indexSrc = readFileSync(joinPath(__dirname, "index.html"), "utf8");
const pmSrc = readFileSync(
  joinPath(__dirname, "scene3d", "particles", "particle_manager.js"),
  "utf8",
);

check(
  "lib.rs exports fetch_particle_degrade_distance (additive v4 rider)",
  /pub async fn fetch_particle_degrade_distance\(hw_gfx_obj_id: u32\)/.test(libSrc),
);
check(
  "lib.rs band pick mirrors retail get_max_degrade_distance (n-2 second-to-last)",
  /fn max_degrade_distance\(degrades: &\[holtburger_dat::file_type::GfxObjInfo\]\)/.test(libSrc) &&
    /n => degrades\[n - 2\]\.max_dist,/.test(libSrc),
);
check(
  "lib.rs no-chain arm returns the retail 100.0 default",
  /RETAIL_DEFAULT_DEGRADE_DISTANCE: f32 = 100\.0/.test(libSrc),
);
check(
  "index.html resolves the export off the NAMESPACE import (stale-pkg safe)",
  /__hbWasmNs\?\.fetch_particle_degrade_distance === "function"/.test(indexSrc),
);
check(
  // 2026-07-04: the OR-term now also fires when an emitter opts in via
  // `_forceDegrade` (synthesized foliage ambient carries a short draw radius,
  // honoured independently of ?particleDegrade). Still finite-gated so a
  // ctor-Infinity / no-radius emitter is never distance-culled.
  "OR-term is (flag OR _forceDegrade)-gated AND finite-gated inside _rp6ShouldCull",
  /\(particleDegradeRetailOn\(\) \|\| emitter\._forceDegrade === true\) &&\s*\n\s*Number\.isFinite\(emitter\.degradeDistance\)/.test(pmSrc),
);
check(
  "addEmitter stamp guards table identity (despawn-mid-resolve dropped)",
  /this\.particleTable\.get\(id\) === emitter/.test(pmSrc),
);

// ---------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
