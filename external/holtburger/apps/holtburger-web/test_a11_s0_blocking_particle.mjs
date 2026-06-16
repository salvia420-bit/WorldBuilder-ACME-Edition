// A11-S0 (2026-06-11 unification survey, Stage S0) — CreateBlockingParticle
// retail semantics behind `?blockingParticleParity=on`, PLUS the UNGATED
// explicit-id REPLACE leak fix.
//
// Survey: docs/url-flags.md (A11-S0 row) + the four walker routing sites.
//
// Retail `CreateBlockingParticleEmitter` (acclient.c:329528-329565): a
// blocking create over an ALREADY-LIVE emitter id returns 0 and leaves the
// existing emitter running — the OPPOSITE of the non-blocking
// `CreateParticleEmitter` REPLACE path (acclient.c:329383-329393) which
// destroys + rebuilds. PhysicsScript hook type 26 (CreateBlockingParticle)
// must take the blocking path when the flag is on; type 13 (CreateParticle)
// always replaces. All three particle-script walkers (entities.js,
// statics.js, play_effect_vfx.js) route 26 → `blocking: (hookType===26) &&
// FLAG`, 13 → `blocking: false`; the actual blocking + replace semantics
// live in `ParticleManager.addEmitter` (scene3d/particles/particle_manager.js).
//
// SEPARATELY (and UNGATED): the explicit-id replace used to `particleTable
// .delete()` the old emitter, orphaning its slot meshes in the scene and
// leaking its per-slot cloned materials. The fix routes the replace through
// `destroyParticleEmitter` so slot meshes are pulled from the scene and
// `__disposable` clones are freed — a pure leak fix, no behavior change for
// the surviving (new) emitter.
//
//   PART 1 — flag parse (`?blockingParticleParity=on`), behavioral + the
//            three walkers' parse expressions pinned to source.
//   PART 2 — hook 26-vs-13 routing decision (`(hookType===26) && FLAG`),
//            the 2×2 matrix + all four walker routing sites pinned to source.
//   PART 3 — blocking semantics through the REAL ParticleManager.addEmitter:
//            26+on+id-live → 0 (no replace, original untouched); 26+off → replace;
//            13 (on/off) → replace; not-yet-live id → creates; anonymous id → never refuses.
//   PART 4 — the UNGATED leak-free replace: a non-blocking replace on a live
//            slot routes through destroyParticleEmitter → old slot mesh removed
//            from the scene AND its cloned material disposed; a blocking refuse
//            leaves the running emitter (mesh + material) intact. Plus the
//            replace-routes-through-destroyParticleEmitter wiring pinned to source.
//
// No browser / no wasm — drives the genuine ParticleManager with real THREE
// (the test_a11_s4_particle_degrade.mjs / test_particles.mjs precedent).
//
// Run from `apps/holtburger-web/`:
//   node test_a11_s0_blocking_particle.mjs

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

// Minimal window stub BEFORE importing the manager. The manager reads
// window.location.search (particleSortObjects / particleDegrade at module
// load) and window.liveScene3d (RP6 camera; we deliberately leave it absent
// so tick()'s frustum bails OPEN and never culls our test emitters).
globalThis.window = { location: { search: "" } };

const { ParticleManager } = await import(
  "./scene3d/particles/particle_manager.js"
);
const { EmitterType } = await import(
  "./scene3d/particles/particle_emitter_info.js"
);
const { ParticleType } = await import("./scene3d/particles/particle.js");
const { setCurrentTime, setRng } = await import(
  "./scene3d/particles/time_rng.js"
);

// Deterministic clock + RNG so the emit/claim path is reproducible.
let clock = 1000.0;
setCurrentTime(() => clock);
setRng(() => 0.5);

// ---------------------------------------------------------------------
// THE REAL FLAG / ROUTING LOGIC, replicated verbatim from the walkers so
// the test exercises the genuine decision (and PART 1/2 static-assert the
// replica is character-identical to every source site — it cannot drift).
// ---------------------------------------------------------------------

/** entities.js / play_effect_vfx.js BLOCKING_PARTICLE_PARITY_ON, and
 *  statics.js _blockingParticleParityOn(), all reduce to this expression. */
function parseBlockingFlag(search) {
  try {
    return (
      new URLSearchParams(search ?? "")
        .get("blockingParticleParity")
        ?.toLowerCase() === "on"
    );
  } catch (_) {
    return false;
  }
}

/** The walkers' per-hook routing decision: hook 26 = CreateBlockingParticle
 *  takes blocking semantics ONLY when the parity flag is on; hook 13 =
 *  CreateParticle always replaces (blocking:false). Mirrors all four sites
 *  (`(hookType === 26) && FLAG`). */
function routeBlocking(hookType, flagOn) {
  return ((hookType | 0) === 26) && flagOn === true;
}

const HOOK_CREATE_PARTICLE = 13;
const HOOK_CREATE_BLOCKING_PARTICLE = 26;

// ---------------------------------------------------------------------
// REAL ParticleManager harness (the genuine module under test).
// ---------------------------------------------------------------------

/** POJO with the same camelCase getters as the wasm ParticleEmitterJs
 *  (the test_particles.mjs / test_a11_s4 shape). Unbounded persistent
 *  emitter (totalSeconds 0, huge totalParticles) so the table entry
 *  survives ticks; `initialParticles:0` so InitEnd seeds nothing — a slot
 *  is only claimed when we deliberately tick after advancing the clock. */
function makeInfo(overrides = {}) {
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
      cX: 0, cY: 0, cZ: 0, minC: 1, maxC: 1,
      startScale: 1.0, finalScale: 1.0, scaleRand: 0.0,
      startTrans: 0.0, finalTrans: 0.0, transRand: 0.0,
      isParentLocal: false,
    },
    overrides,
  );
}

function makeManager() {
  return new ParticleManager({
    scene: new THREE.Object3D(),
    geometryFactory: async () => new THREE.BufferGeometry(),
    materialFactory: async () =>
      new THREE.MeshBasicMaterial({ transparent: true }),
  });
}

/** addEmitter through the genuine manager. `hookType` + `flagOn` drive the
 *  REAL routing decision (so this is the type-26-vs-13 path, not a hand-set
 *  bool). `emitterId` is the explicit per-script instance handle (0 = anon). */
function addViaWalker(mgr, { hookType, flagOn, emitterId = 0, parent }) {
  return mgr.addEmitter({
    emitterInfo: makeInfo(),
    parent:
      parent ?? {
        position: new THREE.Vector3(0, 0, 0),
        quaternion: new THREE.Quaternion(),
      },
    partIndex: -1,
    emitterId,
    blocking: routeBlocking(hookType, flagOn),
  });
}

// Source text for the static (regex-on-source) wiring assertions.
const entitiesSrc = readFileSync(
  joinPath(__dirname, "scene3d", "entities.js"),
  "utf8",
);
const staticsSrc = readFileSync(
  joinPath(__dirname, "scene3d", "statics.js"),
  "utf8",
);
const playEffectSrc = readFileSync(
  joinPath(__dirname, "scene3d", "play_effect_vfx.js"),
  "utf8",
);
const pmSrc = readFileSync(
  joinPath(__dirname, "scene3d", "particles", "particle_manager.js"),
  "utf8",
);
const urlFlagsSrc = readFileSync(
  joinPath(__dirname, "docs", "url-flags.md"),
  "utf8",
);

// =====================================================================
console.log("PART 1 — ?blockingParticleParity flag parse");
// =====================================================================

check("'on' parses true", parseBlockingFlag("?blockingParticleParity=on") === true);
check("'ON' parses true (case-fold)", parseBlockingFlag("?blockingParticleParity=ON") === true);
check("'off' parses false", parseBlockingFlag("?blockingParticleParity=off") === false);
check("absent parses false (default-OFF)", parseBlockingFlag("?foo=1") === false);
check("empty parses false", parseBlockingFlag("") === false);
check("malformed search never throws → false", parseBlockingFlag(null) === false);

// Pin the replica to source: all three walkers ship the identical
// `?blockingParticleParity` lower-cased === "on" parse.
check(
  "entities.js parses blockingParticleParity?.toLowerCase()===\"on\"",
  /\.get\("blockingParticleParity"\)\s*\?\.toLowerCase\(\)\s*===\s*"on"/.test(entitiesSrc),
);
check(
  "statics.js parses blockingParticleParity?.toLowerCase()===\"on\"",
  /\.get\("blockingParticleParity"\)\s*\?\.toLowerCase\(\)\s*===\s*"on"/.test(staticsSrc),
);
check(
  "play_effect_vfx.js parses blockingParticleParity?.toLowerCase()===\"on\"",
  /\.get\("blockingParticleParity"\)\s*\?\.toLowerCase\(\)\s*===\s*"on"/.test(playEffectSrc),
);
check(
  "url-flags.md documents the default-off ?blockingParticleParity=on row",
  /`\?blockingParticleParity=on`/.test(urlFlagsSrc),
);

// =====================================================================
console.log("PART 2 — hook 26-vs-13 routing decision ((hookType===26) && FLAG)");
// =====================================================================

// The 2×2 matrix the walkers compute before calling addEmitter.
check("hook 26 + flag ON  → blocking:true",  routeBlocking(HOOK_CREATE_BLOCKING_PARTICLE, true)  === true);
check("hook 26 + flag OFF → blocking:false (legacy replace)", routeBlocking(HOOK_CREATE_BLOCKING_PARTICLE, false) === false);
check("hook 13 + flag ON  → blocking:false (13 never blocks)", routeBlocking(HOOK_CREATE_PARTICLE, true)  === false);
check("hook 13 + flag OFF → blocking:false", routeBlocking(HOOK_CREATE_PARTICLE, false) === false);

// Pin the routing predicate to every source site.
check(
  "entities.js AnimationHook site routes ((e.hookType|0)===26) && FLAG",
  /blocking:\s*\(\(e\.hookType\s*\|\s*0\)\s*===\s*26\)\s*&&\s*BLOCKING_PARTICLE_PARITY_ON/.test(entitiesSrc),
);
check(
  "entities.js H2-chain site routes (hookType===26) && FLAG",
  /\(hookType\s*===\s*26\)\s*&&\s*BLOCKING_PARTICLE_PARITY_ON/.test(entitiesSrc),
);
check(
  "statics.js site routes ((e.hookType|0)===CREATE_BLOCKING) && parityOn()",
  /\(\(e\.hookType\s*\|\s*0\)\s*===\s*STATIC_HOOK_CREATE_BLOCKING_PARTICLE\)\s*&&\s*[\s\S]{0,40}_blockingParticleParityOn\(\)/.test(staticsSrc) &&
    /STATIC_HOOK_CREATE_BLOCKING_PARTICLE\s*=\s*26/.test(staticsSrc),
);
check(
  "play_effect_vfx.js site routes ((e.hookType|0)===26) && FLAG",
  /\(\(e\.hookType\s*\|\s*0\)\s*===\s*26\)\s*&&\s*BLOCKING_PARTICLE_PARITY_ON/.test(playEffectSrc),
);

// =====================================================================
console.log("PART 3 — blocking semantics through the REAL ParticleManager");
// =====================================================================

// --- 3a. hook 26 + flag ON, id already live → returns 0, no replace ----
{
  const mgr = makeManager();
  const HANDLE = 0x101;
  // First create the persistent emitter (legacy/non-blocking — the running
  // forge/lantern effect retail would leave alone on a re-fire).
  const id1 = await addViaWalker(mgr, {
    hookType: HOOK_CREATE_PARTICLE, flagOn: false, emitterId: HANDLE,
  });
  const e1 = mgr.particleTable.get(HANDLE);
  check("3a.first create installed under the explicit handle", id1 === HANDLE && !!e1);

  // The loop re-fires a CreateBlockingParticle (26) with the flag ON.
  const refused = await addViaWalker(mgr, {
    hookType: HOOK_CREATE_BLOCKING_PARTICLE, flagOn: true, emitterId: HANDLE,
  });
  check("3a.blocking re-fire returns 0 (retail no-replace)", refused === 0);
  check("3a.original emitter left running (NOT replaced)", mgr.particleTable.get(HANDLE) === e1);
  check("3a.exactly one emitter in the table", mgr.particleTable.size === 1);
}

// --- 3b. hook 26 + flag OFF, id live → legacy REPLACE (re-pop) ----------
{
  const mgr = makeManager();
  const HANDLE = 0x202;
  const id1 = await addViaWalker(mgr, {
    hookType: HOOK_CREATE_PARTICLE, flagOn: false, emitterId: HANDLE,
  });
  const e1 = mgr.particleTable.get(HANDLE);
  // Flag OFF: hook 26 routes blocking:false → the off-path replaces.
  const id2 = await addViaWalker(mgr, {
    hookType: HOOK_CREATE_BLOCKING_PARTICLE, flagOn: false, emitterId: HANDLE,
  });
  check("3b.flag-off hook 26 replaces (id stable)", id2 === HANDLE && id1 === HANDLE);
  check("3b.a NEW emitter took the slot (legacy re-pop)", mgr.particleTable.get(HANDLE) !== e1);
  check("3b.still exactly one emitter (replace, not add)", mgr.particleTable.size === 1);
}

// --- 3c. hook 13, id live → REPLACE regardless of flag -----------------
for (const flagOn of [false, true]) {
  const mgr = makeManager();
  const HANDLE = 0x303;
  await addViaWalker(mgr, { hookType: HOOK_CREATE_PARTICLE, flagOn, emitterId: HANDLE });
  const e1 = mgr.particleTable.get(HANDLE);
  const id2 = await addViaWalker(mgr, { hookType: HOOK_CREATE_PARTICLE, flagOn, emitterId: HANDLE });
  check(
    `3c.hook 13 (flag ${flagOn ? "on" : "off"}) destroys+replaces`,
    id2 === HANDLE && mgr.particleTable.get(HANDLE) !== e1 && mgr.particleTable.size === 1,
  );
}

// --- 3d. blocking with a NOT-yet-live id → creates normally ------------
{
  const mgr = makeManager();
  const HANDLE = 0x404;
  // Blocking only refuses when the id is ALREADY live (acclient.c:329528):
  // a first blocking create must still install.
  const id = await addViaWalker(mgr, {
    hookType: HOOK_CREATE_BLOCKING_PARTICLE, flagOn: true, emitterId: HANDLE,
  });
  check("3d.blocking first-create installs (id not yet live)", id === HANDLE && mgr.particleTable.has(HANDLE));
}

// --- 3e. anonymous id (emitterId 0) → blocking never refuses -----------
{
  const mgr = makeManager();
  // Auto-assigned ids are never "already live", so a blocking anon create
  // always succeeds — this is why blocking is observationally inert in the
  // statics / PlayEffect walkers (they auto-assign).
  const a = await addViaWalker(mgr, { hookType: HOOK_CREATE_BLOCKING_PARTICLE, flagOn: true, emitterId: 0 });
  const b = await addViaWalker(mgr, { hookType: HOOK_CREATE_BLOCKING_PARTICLE, flagOn: true, emitterId: 0 });
  check("3e.anonymous blocking creates always succeed (auto-id)", a !== 0 && b !== 0 && a !== b);
  check("3e.both anon emitters live (no cross-refuse)", mgr.particleTable.size === 2);
}

// =====================================================================
console.log("PART 4 — UNGATED leak-free replace (slot meshes + cloned materials freed)");
// =====================================================================

/** Drive the manager so the explicit-handle emitter claims slot 0 with a
 *  real Particle: advance the deterministic clock past `birthrate`, then
 *  tick once. Returns the populated emitter. */
async function spawnWithLiveSlot(mgr, HANDLE) {
  const id = await addViaWalker(mgr, {
    hookType: HOOK_CREATE_PARTICLE, flagOn: false, emitterId: HANDLE,
  });
  const e = mgr.particleTable.get(HANDLE);
  clock += 1.0; // > birthrate (0.001) so shouldEmitParticle fires
  mgr.tick();   // RP6 bails open (no liveScene3d camera) → emit + claim slot 0
  return { id, e };
}

// --- 4a. non-blocking replace frees the old slot mesh + cloned material -
{
  const mgr = makeManager();
  const HANDLE = 0x501;
  const { e: oldEmitter } = await spawnWithLiveSlot(mgr, HANDLE);
  check("4a.precondition: slot 0 claimed (real particle mesh in scene)",
    !!oldEmitter.parts[0] && oldEmitter.numParticles === 1);

  const oldSlotMesh = oldEmitter.partStorage[0];
  check("4a.precondition: slot mesh added to the scene (parent set)",
    !!oldSlotMesh && oldSlotMesh.parent === mgr._scene);
  const oldSlotMat = oldSlotMesh.material;
  // The per-slot clone is tagged disposable (NOT cache-owned) by addEmitter.
  check("4a.precondition: per-slot material is __disposable & !__cacheOwned",
    oldSlotMat.userData.__disposable === true && oldSlotMat.userData.__cacheOwned === false);

  // Spy the dispose of the OLD cloned material (real THREE fires a 'dispose'
  // event on Material.dispose()).
  let oldMatDisposed = 0;
  oldSlotMat.addEventListener("dispose", () => { oldMatDisposed += 1; });

  // The loop re-fires CreateParticle (13) → non-blocking REPLACE on the
  // same handle: the genuine addEmitter routes through destroyParticleEmitter.
  const id2 = await addViaWalker(mgr, {
    hookType: HOOK_CREATE_PARTICLE, flagOn: false, emitterId: HANDLE,
  });
  const newEmitter = mgr.particleTable.get(HANDLE);

  check("4a.replace produced a NEW emitter on the same id", id2 === HANDLE && newEmitter && newEmitter !== oldEmitter);
  check("4a.LEAK FIX: old slot mesh pulled from the scene (parent === null)", oldSlotMesh.parent === null);
  check("4a.LEAK FIX: old slot cloned material disposed", oldMatDisposed === 1);
  check("4a.table holds exactly the one surviving emitter", mgr.particleTable.size === 1);
}

// --- 4b. blocking REFUSE leaves the running emitter (mesh+material) intact
{
  const mgr = makeManager();
  const HANDLE = 0x502;
  const { e: runningEmitter } = await spawnWithLiveSlot(mgr, HANDLE);
  const slotMesh = runningEmitter.partStorage[0];
  const slotMat = slotMesh.material;
  let matDisposed = 0;
  slotMat.addEventListener("dispose", () => { matDisposed += 1; });

  // Blocking re-fire (hook 26 + flag on) over the LIVE id → refuse.
  const refused = await addViaWalker(mgr, {
    hookType: HOOK_CREATE_BLOCKING_PARTICLE, flagOn: true, emitterId: HANDLE,
  });
  check("4b.blocking re-fire returns 0", refused === 0);
  check("4b.running emitter untouched (same instance)", mgr.particleTable.get(HANDLE) === runningEmitter);
  check("4b.running emitter's slot mesh STILL in the scene", slotMesh.parent === mgr._scene);
  check("4b.running emitter's material NOT disposed (no teardown on refuse)", matDisposed === 0);
}

// --- 4c. explicit DestroyParticleEmitter also frees the slot material ---
// (The teardown path the replace now shares — proves the disposal contract
//  the leak fix routes into is the same natural-teardown path.)
{
  const mgr = makeManager();
  const HANDLE = 0x503;
  const { e } = await spawnWithLiveSlot(mgr, HANDLE);
  const slotMesh = e.partStorage[0];
  let disposed = 0;
  slotMesh.material.addEventListener("dispose", () => { disposed += 1; });
  const ok = mgr.destroyParticleEmitter(HANDLE);
  check("4c.destroyParticleEmitter returns true", ok === true);
  check("4c.slot mesh removed from scene", slotMesh.parent === null);
  check("4c.slot cloned material disposed", disposed === 1);
  check("4c.emitter dropped from the table", !mgr.particleTable.has(HANDLE));
}

// Pin the leak fix to source: the explicit-id replace routes through
// destroyParticleEmitter (NOT a bare particleTable.delete).
check(
  "4.replace routes the live old id through this.destroyParticleEmitter (not bare delete)",
  /if\s*\(emitterId\s*!==\s*0\s*&&\s*this\.particleTable\.has\(emitterId\)\)\s*\{\s*this\.destroyParticleEmitter\(emitterId\);/.test(pmSrc),
);
check(
  "4.blocking guard returns 0 BEFORE any await (no build-then-throw)",
  /if\s*\(blocking\s*&&\s*emitterId\s*!==\s*0\s*&&\s*this\.particleTable\.has\(emitterId\)\)\s*\{\s*return\s+0;/.test(pmSrc),
);
check(
  "4.destroyParticleEmitter disposes per-slot materials via _disposeMaterialIfOwned over partStorage",
  /partStorage\[i\];[\s\S]{0,80}_disposeMaterialIfOwned\(slotMesh\.material\)/.test(pmSrc),
);

// restore global hooks
setCurrentTime(null);
setRng(null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
