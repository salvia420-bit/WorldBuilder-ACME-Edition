// Batch 9 — Entities lifecycle fixes (#2 spawn-race guard, #11 ReplaceObject
// geometry __disposable tag + old-children dispose, #24 CallPES timer tracked,
// em-dispose route-through-remove).
//
// Standalone node ESM test (no live ACE session). Loads scene3d/entities.js by
// hand-splicing it through `new Function` — the same self-contained trick the
// Batch-7 omega/baseScale test uses (the older 7.4b pipeline harness breaks at
// module-load because its import-stripper predates entities.js's `../ui`
// imports). The import-stripper here also drops `../` and multi-line
// `import { … }` blocks, and additionally NEUTRALIZES the two runtime
// `import("./adapter.js")` / `import("three")` statements that cannot resolve
// in a bare `new Function` context (those are test-infra-only rewrites; the
// shipped browser code resolves them relative to entities.js's own URL).
//
// Run:
//   cd apps/holtburger-web/
//   THREE_PATH=/abs/three.module.js node test_phase7_batch9_entity_lifecycle.mjs
//
// Covers (from the master fix-plan Batch 9 GATE):
//   #2  spawn() that loses the race to a concurrent remove() must NOT attach a
//       ghost rig: the in-flight _spawnImpl bails at its Step-E liveness guard,
//       routes through inst.dispose() (frees ONLY __disposable geometry — the
//       shared AnimationCache geom must survive), returns null, entityMap stays
//       empty, the root has no parent. A clean (un-raced) spawn still attaches.
//   #11 ReplaceObject geometry is tagged userData.__disposable=true; a 2nd
//       ReplaceObject disposes the prior __disposable geom + drops it from
//       inst.geometries, but never the untagged shared spawn geometry.
//   #24 a CallPES (hookType 19) entry registers its setTimeout id into
//       _soundTimeoutsForGuid[guid] (an ARRAY — get-or-create + push, never
//       .set/Set.add); remove(guid) cancels it; a pre-existing array is not
//       clobbered.
//   em-dispose  dispose() sets _disposed=true, routes per-guid through remove()
//       (so emitters/timers/activeLights are freed, not just the rig subtree),
//       then clears entityMap + _spawnGen.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

// ---- locate `three` --------------------------------------------------
function locateThree() {
  if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) {
    return process.env.THREE_PATH;
  }
  try {
    return require.resolve("three");
  } catch (_) {}
  return null;
}

const threePath = locateThree();
if (!threePath) {
  console.log("Batch 9 entity-lifecycle test: SKIP (three not located).");
  console.log("  hint: THREE_PATH=/abs/three.module.js node test_phase7_batch9_entity_lifecycle.mjs");
  process.exit(0);
}

const THREE = await import("file://" + threePath);

console.log("Batch 9 — entity lifecycle (#2 spawn-race / #11 ReplaceObject / #24 CallPES / em-dispose)");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// ---- load + splice the modules --------------------------------------
function loadModule(relPath) {
  const full = resolvePath(__dirname, relPath);
  if (!existsSync(full)) throw new Error(`module not found: ${full}`);
  let src = readFileSync(full, "utf8");
  src = src.replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "");
  src = src.replace(/^\s*import\s+\{[^{}]*\}\s+from\s+["'][^"']+["'];?\s*$/gm, "");
  src = src.replace(/^\s*import\s+\{[^{}]*\n[\s\S]*?\}\s+from\s+["'][^"']+["'];?\s*$/gm, "");
  src = src.replace(/^\s*import\s+[A-Za-z_$][\w$]*\s+from\s+["'][^"']+["'];?\s*$/gm, "");
  // Test-infra-only: neutralize runtime dynamic imports that cannot resolve in
  // a bare `new Function` context. `meshToGeometryGroups` IS already spliced in
  // (adapter.js is loaded inline below) as a top-level symbol. Collapse BOTH
  // the `import(...)` line AND the immediately-following
  // `const meshToGeometryGroups = adapter.meshToGeometryGroups;` (which would
  // otherwise re-declare a block-local const and TDZ-trap the line above).
  src = src.replace(
    /const adapter = await import\("\.\/adapter\.js"\);\s*\n\s*const meshToGeometryGroups = adapter\.meshToGeometryGroups;/g,
    "/* test: dynamic adapter import collapsed to spliced meshToGeometryGroups */",
  );
  // The lazy `THREE` re-import in the chain walker is unused beyond `void THREE`
  // (per its own comment). Drop the redeclaration entirely so the later
  // `void THREE;` simply references the in-scope (factory-param) THREE — a new
  // block-scoped `const THREE` would shadow + TDZ-trap the param.
  src = src.replace(
    /const THREE = \(await import\("three"\)\)\.default \?\? \(await import\("three"\)\);/g,
    "/* test: lazy THREE re-import removed (uses factory-param THREE) */",
  );
  return src;
}

function stripExports(src) {
  return src
    .replace(/^\s*export\s+async\s+function\s+/gm, "async function ")
    .replace(/^\s*export\s+function\s+/gm, "function ")
    .replace(/^\s*export\s+class\s+/gm, "class ")
    .replace(/^\s*export\s+const\s+/gm, "const ")
    .replace(/^\s*export\s+let\s+/gm, "let ")
    .replace(/^\s*export\s+default\s+/gm, "")
    .replace(/^\s*export\s+\{[^}]+\}[\s;]*$/gm, "");
}

const adapterSrc = loadModule("scene3d/adapter.js");
const animSrc = loadModule("scene3d/animation.js");
const entitiesSrc = loadModule("scene3d/entities.js");

// `timeRng` is a stripped import (./particles/time_rng.js); supply a
// deterministic stub so the CallPES arm computes a LARGE delay (timer won't
// fire during the test → we can assert it is tracked then cancel it).
const composite =
  "const timeRng = () => 0.999;\n" +
  "// === adapter.js ===\n" + stripExports(adapterSrc) + "\n" +
  "// === animation.js ===\n" + stripExports(animSrc) + "\n" +
  "// === entities.js ===\n" + stripExports(entitiesSrc) + "\n" +
  "; return { EntityManager, EntityInstance, AnimationCache };";

const factory = new Function("THREE", "performance", "window", composite);
const { EntityManager, EntityInstance } = factory(
  THREE,
  globalThis.performance ?? { now: () => Date.now() },
  undefined,
);

// ---- helpers ---------------------------------------------------------
function makeManager(extra = {}) {
  const scene3d = {
    scene: new THREE.Group(),
    entitiesGroup: new THREE.Group(),
    quality: { preset: "high" },
    materialCache: null,
    activeLights: [],
    ...extra,
  };
  const em = new EntityManager(scene3d, {});
  return em;
}

// Minimal animEntry that drives _spawnImpl to its Step-E commit with ZERO
// parts (empty rig) and no clip — exercises the lifecycle path without needing
// a full wasm mesh/material stack.
function emptyAnimEntry() {
  return {
    partCount: 0,
    clip: null,
    resolvedStance: 0,
    restOrigins: new Float32Array(0),
    restOrientations: new Float32Array(0),
    partGroups: [],
    hooks: [],
  };
}

const SETUP = 0x02000123;

function spawnMeta(guid) {
  return {
    guid,
    modelId: SETUP,
    x: 10, y: 20, z: 0,
    qw: 1, qx: 0, qy: 0, qz: 0,
    landblockId: 0xA9B40000,
    mtableId: 0,
    motionCommand: 0,
    motionStance: 0,
  };
}

// =====================================================================
// #2 — clean spawn attaches; a spawn raced by remove() disposes + returns null
// =====================================================================
{
  const em = makeManager();
  em.wasmExports = { fetchEntityAnimationKeyframes: () => {} };

  // --- clean (un-raced) spawn attaches normally ---
  em.animationCache.get = async () => emptyAnimEntry();
  const inst = await em.spawn(spawnMeta(0x5001));
  check("#2 clean spawn returns an instance", !!inst && inst.guid === 0x5001);
  check("#2 clean spawn registered in entityMap", em.entityMap.get(0x5001) === inst);
  check("#2 clean spawn root attached to entitiesGroup",
    !!inst && inst.root.parent === em.scene3d.entitiesGroup);
  // _spawnGen token dropped on the terminal path (Map stays bounded).
  check("#2 clean spawn dropped its _spawnGen token", !em._spawnGen.has(0x5001),
    `size=${em._spawnGen.size}`);

  // --- raced spawn: remove() runs while _spawnImpl awaits animationCache ---
  let release;
  const gate = new Promise((res) => { release = res; });
  em.animationCache.get = async () => { await gate; return emptyAnimEntry(); };
  // Track inst.dispose() to prove the stale-spawn routes through it (NOT a
  // blanket geometry.dispose()). We spy on the prototype.
  let disposeCalls = 0;
  const origDispose = EntityInstance.prototype.dispose;
  EntityInstance.prototype.dispose = function (...a) {
    disposeCalls += 1;
    return origDispose.apply(this, a);
  };

  const racedGuid = 0x5002;
  const p = em.spawn(spawnMeta(racedGuid));   // in-flight, awaiting the gate
  // Concurrent remove() before the spawn commits. entityMap has no entry yet,
  // but remove() must bump the generation so the in-flight spawn goes stale.
  em.remove(racedGuid);
  release();                                   // let _spawnImpl proceed to Step E
  const racedInst = await p;

  EntityInstance.prototype.dispose = origDispose;

  check("#2 raced spawn returns null", racedInst === null, `got=${racedInst}`);
  check("#2 raced spawn left entityMap empty for that guid",
    !em.entityMap.has(racedGuid));
  check("#2 raced spawn disposed the half-built rig (inst.dispose ran)",
    disposeCalls >= 1, `disposeCalls=${disposeCalls}`);
  check("#2 raced spawn cleared its _spawnGen token", !em._spawnGen.has(racedGuid));

  // create → delete → create still builds a fresh rig (no stale-gen lockout).
  em.animationCache.get = async () => emptyAnimEntry();
  const rebuilt = await em.spawn(spawnMeta(racedGuid));
  check("#2 re-spawn after race builds a fresh rig",
    !!rebuilt && em.entityMap.get(racedGuid) === rebuilt);
}

// =====================================================================
// #11 — ReplaceObject geometry __disposable tag + old-children dispose
// =====================================================================
// The shipped `_fireReplaceObjectHook` converts a wasm part-mesh via
// `meshToGeometryGroups(wasmMesh)`. Building a node-faithful wasm-mesh is too
// coupled, so we re-splice entities.js with ONE test-only seam: route that
// converter call through `this.__test_m2gg` when present. This leaves the real
// detach + __disposable-tag + dispose/unregister logic (the #11 fix) fully
// intact and only swaps the unmockable converter, so we exercise the SHIPPED
// block end-to-end with controlled geometries.
{
  // Re-splice entities.js with one extra test-only seam: route
  // meshToGeometryGroups(...) through this.__test_m2gg when present. This keeps
  // the real detach/tag/dispose logic intact and only swaps the (untestable in
  // node) wasm-mesh converter.
  let eSrc = loadModule("scene3d/entities.js");
  eSrc = eSrc.replace(
    /const \{ groups, surfaceDids \} = meshToGeometryGroups\(wasmMesh\);/g,
    "const { groups, surfaceDids } = (this.__test_m2gg ? this.__test_m2gg(wasmMesh) : meshToGeometryGroups(wasmMesh));",
  );
  const comp =
    "const timeRng = () => 0.999;\n" +
    "// === adapter.js ===\n" + stripExports(adapterSrc) + "\n" +
    "// === animation.js ===\n" + stripExports(animSrc) + "\n" +
    "// === entities.js ===\n" + stripExports(eSrc) + "\n" +
    "; return { EntityManager, EntityInstance, AnimationCache };";
  const f2 = new Function("THREE", "performance", "window", comp);
  const M2 = f2(THREE, globalThis.performance ?? { now: () => Date.now() }, undefined);

  const em = makeManager();
  const EM = M2.EntityManager;
  const EI = M2.EntityInstance;
  // Use the re-spliced classes for this case.
  const root = new THREE.Group();
  const part0 = new THREE.Group();
  root.add(part0);
  const inst = new EI(0x6002, root, [part0], null, spawnMeta(0x6002));
  inst.mixer = new THREE.AnimationMixer(root);

  const mgr = new EM(
    { scene: new THREE.Group(), entitiesGroup: new THREE.Group(), quality: { preset: "high" }, materialCache: null, activeLights: [] },
    {},
  );
  mgr.entityMap.set(0x6002, inst);

  // SHARED spawn geometry — untagged, must survive both replaces.
  const sharedGeom = new THREE.BufferGeometry();
  const sharedMesh = new THREE.Mesh(sharedGeom, new THREE.MeshBasicMaterial());
  part0.add(sharedMesh);
  inst.registerGeometry(sharedGeom);
  let sharedDisposed = 0;
  const sgDispose = sharedGeom.dispose.bind(sharedGeom);
  sharedGeom.dispose = () => { sharedDisposed += 1; return sgDispose(); };

  // wasm bundle stub: partCount 1, takePartMeshes -> [marker], free noop.
  mgr.wasmExports = {
    fetchBuildingPlacement: async () => ({
      partCount: 1,
      takePartMeshes: () => [{ __marker: true }],
      free: () => {},
    }),
  };
  // Test converter: each call mints a FRESH BufferGeometry (entity-owned).
  let nextGeom = null;
  mgr.__test_m2gg = () => {
    nextGeom = new THREE.BufferGeometry();
    return { groups: [{ geometry: nextGeom, surfaceDid: 0x1234, doubleSided: true }], surfaceDids: [0x1234] };
  };

  // --- 1st ReplaceObject ---
  await mgr._fireReplaceObjectHook(inst, 0, 0x01000111);
  const geomA = nextGeom;
  check("#11 ReplaceObject tags new geom __disposable===true",
    geomA && geomA.userData?.__disposable === true);
  check("#11 ReplaceObject registered new geom in inst.geometries",
    inst.geometries.indexOf(geomA) !== -1);
  check("#11 spawn shared geom NOT disposed by 1st replace", sharedDisposed === 0);
  // The shared spawn mesh was detached (untagged) but its geometry survives.
  check("#11 1st replace attached the replacement mesh",
    part0.children.some((c) => c.userData?.replaced === true));

  // spy geomA.dispose to prove the 2nd replace frees it.
  let geomADisposed = 0;
  const gaDispose = geomA.dispose.bind(geomA);
  geomA.dispose = () => { geomADisposed += 1; return gaDispose(); };

  // --- 2nd ReplaceObject ---
  await mgr._fireReplaceObjectHook(inst, 0, 0x01000222);
  const geomB = nextGeom;
  check("#11 2nd replace disposed the prior __disposable geom", geomADisposed === 1,
    `geomADisposed=${geomADisposed}`);
  check("#11 2nd replace dropped prior geom from inst.geometries",
    inst.geometries.indexOf(geomA) === -1);
  check("#11 2nd replace new geom tagged + registered",
    geomB && geomB.userData?.__disposable === true &&
    inst.geometries.indexOf(geomB) !== -1);
  check("#11 spawn shared geom STILL not disposed after 2nd replace", sharedDisposed === 0);
  check("#11 shared geom STILL registered (survives replaces)",
    inst.geometries.indexOf(sharedGeom) !== -1);

  // --- remove(guid) frees the live ReplaceObject geom (it's __disposable) ---
  let geomBDisposed = 0;
  const gbDispose = geomB.dispose.bind(geomB);
  geomB.dispose = () => { geomBDisposed += 1; return gbDispose(); };
  mgr.remove(0x6002);
  // inst.dispose() disposes __disposable geometry via BOTH its traverse
  // (`_disposeMeshChildren`) and its `inst.geometries` safety-net loop — a
  // documented two-pass design (three.js geometry.dispose is idempotent), so
  // count is >= 1. The load-bearing assertion is that the live ReplaceObject
  // geom IS freed at all (the shared geom, asserted untouched above, is not).
  check("#11 remove(guid) disposed the live ReplaceObject geom", geomBDisposed >= 1,
    `geomBDisposed=${geomBDisposed}`);
  check("#11 remove(guid) did NOT dispose the shared spawn geom", sharedDisposed === 0,
    `sharedDisposed=${sharedDisposed}`);

  void em; void f2;
}

// =====================================================================
// #24 — CallPES setTimeout id tracked in _soundTimeoutsForGuid[guid] (ARRAY)
// =====================================================================
{
  const em = makeManager();
  em._worldParticleManager = {};  // truthy -> _ensureWorldParticleManager early-returns (no dyn import)
  const guid = 0x7001;
  // Register the entity so the CallPES timer's liveness check (entityMap.has)
  // passes.
  const root = new THREE.Group();
  const inst = new EntityInstance(0x7001, root, [], null, spawnMeta(0x7001));
  em.entityMap.set(guid, inst);

  // Pre-seed the per-guid array with a sentinel id so we prove get-or-create +
  // PUSH (never .set/clobber). Use a real timer so cleanup is observable.
  const sentinelTid = setTimeout(() => {}, 1_000_000);
  em._soundTimeoutsForGuid.set(guid, [sentinelTid]);

  // CallPES (hookType 19) hookData: u32 callPesDid @0, f32 callPesPause @4.
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x33000999, true);  // sub-script DID
  dv.setFloat32(4, 100.0, true);      // pause (s) -> timeRng()=0.999 -> ~99.9s delay (won't fire)
  const callPesEntry = { hookType: 19, hookData: new Uint8Array(buf), startTime: 0 };

  em.wasmExports = {
    fetchPhysicsScript: async () => ({ takeEntries: () => [callPesEntry] }),
  };

  const before = em._soundTimeoutsForGuid.get(guid).slice();
  const result = await em._attachParticleChainForEntity(guid, root, 0x33000111);
  const after = em._soundTimeoutsForGuid.get(guid);

  check("#24 chain walk returned ok", !!result && result.ok === true);
  check("#24 _soundTimeoutsForGuid value is still an Array", Array.isArray(after));
  check("#24 sentinel id NOT clobbered (push, not .set)",
    after.indexOf(sentinelTid) !== -1, `arr.len=${after.length}`);
  check("#24 CallPES timer id was pushed in", after.length === before.length + 1,
    `before=${before.length} after=${after.length}`);

  // The newly added id is the CallPES timer.
  const pesTid = after.find((t) => t !== sentinelTid);
  check("#24 a new (CallPES) timer id is present", pesTid != null);

  // remove(guid) cancels every tracked timer + drops the map entry.
  em.remove(guid);
  check("#24 remove(guid) dropped the per-guid timeout array",
    !em._soundTimeoutsForGuid.has(guid));
  // (clearTimeout on already-fired/never-fired ids is a no-op; we just assert
  // the bookkeeping cleared. Clean up the sentinel so node can exit.)
  clearTimeout(sentinelTid);
  if (pesTid != null) clearTimeout(pesTid);
}

// =====================================================================
// em-dispose — dispose() routes per-guid through remove() (frees emitters /
// timers / activeLights) then clears entityMap + _spawnGen.
// =====================================================================
{
  const activeLights = [];
  const em = makeManager({ activeLights });
  em.wasmExports = { fetchEntityAnimationKeyframes: () => {} };
  em.animationCache.get = async () => emptyAnimEntry();

  const inst = await em.spawn(spawnMeta(0x8001));
  check("em-dispose precondition: entity spawned", !!inst && em.entityMap.size === 1);

  // Attach manager-side bookkeeping that ONLY remove() frees (bare inst.dispose
  // would leak these): a particle emitter, a sound timer, an entity light in
  // scene3d.activeLights.
  let destroyedEmitter = 0;
  em._worldParticleManager = {
    destroyParticleEmitter: () => { destroyedEmitter += 1; },
  };
  em._particleEmittersForGuid.set(0x8001, [42]);

  let clearedTimer = 0;
  const realClear = clearTimeout;
  const trackedTid = setTimeout(() => {}, 1_000_000);
  globalThis.clearTimeout = (id) => { clearedTimer += 1; return realClear(id); };
  em._soundTimeoutsForGuid.set(0x8001, [trackedTid]);

  const light = new THREE.PointLight();
  const lightHolder = new THREE.Group();
  lightHolder.add(light);
  activeLights.push(light);
  inst._setupLights = [light];
  em._entityLightCount = 1;

  em.dispose();
  globalThis.clearTimeout = realClear;

  check("em-dispose set _disposed=true", em._disposed === true);
  check("em-dispose freed the particle emitter (via remove)", destroyedEmitter === 1,
    `destroyed=${destroyedEmitter}`);
  check("em-dispose cleared the sound timer (via remove)", clearedTimer >= 1,
    `cleared=${clearedTimer}`);
  check("em-dispose spliced the entity light out of activeLights",
    activeLights.indexOf(light) === -1, `activeLights.len=${activeLights.length}`);
  check("em-dispose detached the entity light", light.parent === null);
  check("em-dispose cleared entityMap", em.entityMap.size === 0);
  check("em-dispose cleared _spawnGen", em._spawnGen.size === 0);

  // A post-dispose spawn bails at the liveness guard (_disposed) → null,
  // entityMap stays empty.
  const after = await em.spawn(spawnMeta(0x8002));
  check("em-dispose: spawn after dispose returns null (disposed guard)", after === null);
  check("em-dispose: entityMap stays empty after a post-dispose spawn",
    em.entityMap.size === 0);
}

console.log("=========================");
console.log(`Cases: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
