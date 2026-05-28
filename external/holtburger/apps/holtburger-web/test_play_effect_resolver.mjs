// Wave 18 / Phase 53 — `scene3d/play_effect_vfx.js` resolver regression test.
//
// Run with:
//   cd /home/wbterminal/WorldBuilder-ACME-Edition
//   node external/holtburger/apps/holtburger-web/test_play_effect_resolver.mjs
//
// Exits non-zero on any failure.
//
// ===========================================================================
// What this exercises
// ===========================================================================
//
// Phase 51 added the real-VFX resolver `_tryResolveRealVfx` (exposed via
// `__test.tryResolveRealVfx`) that walks:
//
//   getPhysicsScriptTableDid(guid)
//     → fetchPhysicsScriptTable(did)
//     → pickScriptEntry(entries, speed)
//     → wasmExports.fetchPhysicsScript(pesId)
//     → ps.takeEntries()  → CreateParticleHook (hookType 13 / 26)
//     → wasmExports.fetchParticleEmitter(emitterDid)
//     → wm.addEmitter({...})
//
// Agent AX shipped 12/12 structural trace tests + 8/8 picker tests inside the
// module itself (`__test.runPickerSelfTests`) but no end-to-end synthetic
// chain coverage — this file fills that gap. Every case runs offline; no live
// ACE-server PlayEffect needed.
//
// ===========================================================================
// Tight-coupling friction (NOT fixed; documented per mandate)
// ===========================================================================
//
// `play_effect_vfx.js` reads its dependencies from `window.*` globals directly:
//   - `window.liveScene3d.entityManager.{entityMap, getPhysicsScriptTableDid,
//      wasmExports, _worldParticleManager, materialCache}` (line 785+)
//   - `window.__pluginClient.events` (line 1553+)
//   - `window.__hbWasm` via `ui/ac_physics_script_table.js`'s
//     `(window.__hbWasm ?? window.__wasm ?? null)` (line 98)
// + a hard `import * as THREE from "three"` (line 85) — bare module specifier
//   not resolvable under stock Node without an import map / loader.
//
// We work around both without touching the source:
//   (1) A Node module-resolution hook (`_three_stub_loader.mjs`, generated as
//       a sibling and registered before module import) intercepts `"three"`
//       and serves a minimal stub with `Vector3`, `Quaternion`, and no-op
//       constructors for the constants/classes the resolver/placeholder
//       paths touch.
//   (2) Pre-seed `window.liveScene3d.entityManager._worldParticleManager`
//       with a recording stub so the resolver's lazy-ParticleManager-create
//       branch (which would `await import("./particles/index.js")` +
//       `await import("./adapter.js")` and pull in tons of three internals)
//       never fires.
//
// Future phase: factor the resolver to accept a `services` arg (entityManager,
// wasm, particleManager, plugin events) so tests can inject without globals
// or loader gymnastics. Out of scope here — mandate forbids `play_effect_vfx.js`
// edits.
// ---------------------------------------------------------------------------

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { register } from "node:module";
import { writeFileSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- Step 1: write + register a `"three"` resolution hook ----------------
//
// Node's `register()` requires the hook to be a separate module (URL). We
// drop a small loader file next to this test the first time it runs (idempotent
// — the file checks itself in via `existsSync`) and then `register()` it.
//
// The hook only handles the bare specifier `"three"`. Everything else falls
// through to `nextResolve(specifier, context, nextResolve)`.

const STUB_LOADER_PATH = resolvePath(__dirname, "_three_stub_loader.mjs");
const STUB_THREE_PATH = resolvePath(__dirname, "_three_stub.mjs");

if (!existsSync(STUB_THREE_PATH)) {
  // Minimal three.js stand-in covering only what `play_effect_vfx.js` touches.
  // The resolver path (`_tryResolveRealVfx`) needs `Vector3` + `Quaternion`
  // (see line 982+ of the source). The placeholder/burst helpers need the
  // geometry/material/mesh classes + blending constants — they're invoked
  // when `_runPlaceholderDispatch` fires (i.e. our "miss" cases). All are
  // no-op shells; we just need them to construct without throwing.
  writeFileSync(STUB_THREE_PATH, `
class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  setScalar(s) { this.x = this.y = this.z = s; return this; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
}
class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
}
class Object3D {
  constructor() {
    this.position = new Vector3();
    this.scale = new Vector3(1, 1, 1);
    this.rotation = { x: 0, y: 0, z: 0 };
    this.children = [];
    this.parent = null;
    this.name = "";
    this.renderOrder = 0;
  }
  add(child) { this.children.push(child); child.parent = this; }
  remove(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) { this.children.splice(i, 1); child.parent = null; }
  }
}
class Mesh extends Object3D {
  constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; }
}
class SphereGeometry { constructor() {} dispose() {} }
class TorusGeometry { constructor() {} dispose() {} }
class BoxGeometry { constructor() {} dispose() {} }
class MeshBasicMaterial { constructor(opts = {}) { Object.assign(this, opts); } dispose() {} }
const AdditiveBlending = 2;
const FrontSide = 0;
const DoubleSide = 2;
export {
  Vector3, Quaternion, Object3D, Mesh,
  SphereGeometry, TorusGeometry, BoxGeometry, MeshBasicMaterial,
  AdditiveBlending, FrontSide, DoubleSide,
};
`);
}

if (!existsSync(STUB_LOADER_PATH)) {
  writeFileSync(STUB_LOADER_PATH, `
import { pathToFileURL } from "node:url";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUB = pathToFileURL(resolvePath(__dirname, "_three_stub.mjs")).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "three") {
    return { url: STUB, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}
`);
}

register(pathToFileURL(STUB_LOADER_PATH).href);

// ---- Step 2: bootstrap `window` + stubs BEFORE module import -------------
//
// `play_effect_vfx.js` runs an IIFE on import (`_autoBind`) that polls for
// `window.__pluginClient`. We need the window scaffold in place by the time
// `import()` resolves so the bind succeeds first try (and doesn't spam
// console with "waiting for __pluginClient"). The auto-bind itself isn't
// load-bearing for our tests — we drive `__test.tryResolveRealVfx` directly —
// but a clean import keeps log output focused.

const bus = {
  _handlers: new Map(),
  on(name, h) {
    if (!this._handlers.has(name)) this._handlers.set(name, []);
    this._handlers.get(name).push(h);
  },
  off(name, h) {
    const arr = this._handlers.get(name);
    if (!arr) return;
    const i = arr.indexOf(h);
    if (i >= 0) arr.splice(i, 1);
  },
  emit(name, payload) {
    const arr = this._handlers.get(name) ?? [];
    // Mirror real bus's CustomEvent.detail shape so `evt?.detail` reads work.
    for (const h of arr) h({ detail: payload });
  },
};

globalThis.window = {
  __pluginClient: { events: bus },
  __playEffectVfxBound: false,
  __hbWasm: null,
  liveScene3d: null,
};

// ---- Step 3: build per-case stubs the test harness rebuilds each run ----

// Recording ParticleManager — counts `addEmitter` calls + remembers the args
// so cases can assert parent ref / partIndex / offset.
function makeRecordingParticleManager() {
  const calls = [];
  const destroyed = [];
  let nextId = 1;
  return {
    calls,
    destroyed,
    addEmitter(args) {
      const id = nextId++;
      calls.push({ id, ...args });
      return id;
    },
    destroyParticleEmitter(id) {
      destroyed.push(id);
    },
  };
}

// Wasm-export stubs. The resolver reads via `em.wasmExports.{fetchPhysicsScript,
// fetchParticleEmitter}`. The PhysicsScriptTable fetch goes through
// `window.__hbWasm.fetchPhysicsScriptTable` (the JS facade reads that path).
function makeWasmStubs({
  physicsScriptTable = null,      // JSON string or "null"
  physicsScript = null,           // object with takeEntries()
  particleEmitter = null,         // ParticleEmitterInfo-shaped
  physicsScriptByDid = null,      // Map<did, scriptObj>
} = {}) {
  return {
    fetchPhysicsScriptTable: async (_did) => {
      if (physicsScriptTable === null) return "null";
      // Returned as a JSON string per the facade's contract.
      return typeof physicsScriptTable === "string"
        ? physicsScriptTable
        : JSON.stringify(physicsScriptTable);
    },
    fetchPhysicsScript: async (did) => {
      if (physicsScriptByDid && physicsScriptByDid.has(did >>> 0)) {
        return physicsScriptByDid.get(did >>> 0);
      }
      if (physicsScript === null) {
        throw new Error(`no fixture for fetchPhysicsScript(0x${did.toString(16)})`);
      }
      return physicsScript;
    },
    fetchParticleEmitter: async (did) => {
      if (particleEmitter === null) {
        throw new Error(`no fixture for fetchParticleEmitter(0x${did.toString(16)})`);
      }
      return particleEmitter;
    },
  };
}

// Build a synthetic PhysicsScriptJs whose `takeEntries()` yields the given
// hook entries. Mirrors the real wasm-export shape — the resolver only reads
// `hookType`, `createParticleEmitterId`, `createParticleOffsetX/Y/Z`,
// `createParticleOffsetQX/Y/Z/QW`, `createParticlePartIndex`.
function makePhysicsScript(entries) {
  return {
    takeEntries: () => entries.map((e) => ({
      hookType: e.hookType ?? 13,
      createParticleEmitterId: e.emitterDid ?? 0x32000001,
      createParticleOffsetX: e.ox ?? 0,
      createParticleOffsetY: e.oy ?? 0,
      createParticleOffsetZ: e.oz ?? 0,
      createParticleOffsetQX: e.qx ?? 0,
      createParticleOffsetQY: e.qy ?? 0,
      createParticleOffsetQZ: e.qz ?? 0,
      createParticleOffsetQW: e.qw ?? 1,
      createParticlePartIndex: e.partIndex ?? -1,
    })),
  };
}

// Build a stub liveScene3d.entityManager scaffold. The `tableDid` is what
// `getPhysicsScriptTableDid` returns for the test target GUID. `wasmExports`
// lets the resolver read `fetchPhysicsScript` + `fetchParticleEmitter`.
// `_worldParticleManager` is pre-seeded so the lazy-create branch (which
// imports `./particles/index.js` + `./adapter.js`) never fires.
function setupLiveScene3d({
  tableDid = 0,
  wasmExports = makeWasmStubs(),
  particleManager = makeRecordingParticleManager(),
  targetGuid = 0xC0000001,
  hasEntity = true,
}) {
  // Lazy import the THREE stub to build a fake entity root.
  // Done synchronously: the stub is already loaded via the loader hook below
  // by the time we reach here.
  const root = {
    position: { x: 0, y: 0, z: 0 },
    parent: null,
    children: [],
    add(child) { this.children.push(child); child.parent = this; },
    remove(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); },
  };
  const inst = hasEntity ? { root } : null;
  const entityMap = new Map();
  if (inst) entityMap.set(targetGuid >>> 0, inst);

  globalThis.window.__hbWasm = wasmExports;
  globalThis.window.liveScene3d = {
    entitiesGroup: {
      add() {},
      remove() {},
    },
    entityManager: {
      entityMap,
      wasmExports,
      materialCache: null,
      _worldParticleManager: particleManager,
      getPhysicsScriptTableDid: (g) => ((g >>> 0) === (targetGuid >>> 0) ? (tableDid >>> 0) : 0),
    },
  };
  return { particleManager, wasmExports, targetGuid, root };
}

// ---- Step 4: import the resolver AFTER stubs are in place ----------------

const helperUrl = pathToFileURL(
  resolvePath(__dirname, "scene3d/play_effect_vfx.js"),
).href;

const { __test, VFX_COVERAGE, pickScriptEntry } = await import(helperUrl);

// Also pull the facade's cache-clear so each case starts from a clean slate.
const facadeUrl = pathToFileURL(
  resolvePath(__dirname, "ui/ac_physics_script_table.js"),
).href;
const { _clearPhysicsScriptTableCache } = await import(facadeUrl);

// ---- Step 5: test harness ------------------------------------------------

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1; else passed += 1;
}

// Snapshot the realVfx miss counters so each case can compare deltas instead
// of absolutes (the counters accumulate across the whole test run).
function snapshotStats() {
  return {
    attempts: VFX_COVERAGE.realVfxAttempts,
    resolved: VFX_COVERAGE.realVfxResolved,
    miss: { ...VFX_COVERAGE.realVfxMissBreakdown },
  };
}
function statsDelta(before) {
  const now = snapshotStats();
  const missDelta = {};
  for (const k of Object.keys(now.miss)) {
    missDelta[k] = now.miss[k] - before.miss[k];
  }
  return {
    attempts: now.attempts - before.attempts,
    resolved: now.resolved - before.resolved,
    miss: missDelta,
  };
}

console.log("===========================================================");
console.log("Wave 18 / Phase 53 — play_effect_vfx resolver regression");
console.log("===========================================================");

// ---- Module surface sanity -----------------------------------------------

check("__test.tryResolveRealVfx is exported", typeof __test.tryResolveRealVfx === "function");
check("__test.runPickerSelfTests is exported", typeof __test.runPickerSelfTests === "function");
check("__test.realVfxStats is exported", typeof __test.realVfxStats === "function");
check("VFX_COVERAGE.realVfxAttempts is a getter (number)", typeof VFX_COVERAGE.realVfxAttempts === "number");
check("VFX_COVERAGE.realVfxResolved is a getter (number)", typeof VFX_COVERAGE.realVfxResolved === "number");
check("pickScriptEntry is exported", typeof pickScriptEntry === "function");

// =========================================================================
// Case A — happy path: scriptId 0x04 (Launch), one entry, one CreateParticle
// hook, picker resolves, ParticleManager.addEmitter called once.
// =========================================================================
{
  _clearPhysicsScriptTableCache();
  const TARGET = 0xC0000001;
  const TABLE_DID = 0x34000004;
  const PES_DID = 0x33000100;
  const EMITTER_DID = 0x32000001;
  const wasmExports = makeWasmStubs({
    physicsScriptTable: {
      id: TABLE_DID,
      scripts: { "4": [{ mod: 1.0, scriptDid: PES_DID }] },
    },
    physicsScript: makePhysicsScript([
      { hookType: 13, emitterDid: EMITTER_DID, ox: 1.0, oy: 2.0, oz: 3.0, partIndex: 7 },
    ]),
    particleEmitter: { emitterId: EMITTER_DID, kind: "synthetic" },
  });
  const { particleManager, root } = setupLiveScene3d({
    tableDid: TABLE_DID, wasmExports, targetGuid: TARGET,
  });
  const before = snapshotStats();
  const result = await __test.tryResolveRealVfx(TARGET, 0x04, 0.5);
  const d = statsDelta(before);
  check("Case A: resolver returns true on happy path", result === true);
  check("Case A: addEmitter called exactly once", particleManager.calls.length === 1,
    `got ${particleManager.calls.length}`);
  if (particleManager.calls.length > 0) {
    const c = particleManager.calls[0];
    check("Case A: addEmitter parent is the entity root",
      c.parent === root, `parent ref mismatch`);
    check("Case A: addEmitter partIndex is the hook's value (7)",
      c.partIndex === 7, `got ${c.partIndex}`);
    check("Case A: addEmitter parentOffset.position has hook x/y/z",
      c.parentOffset?.position?.x === 1.0
      && c.parentOffset?.position?.y === 2.0
      && c.parentOffset?.position?.z === 3.0,
      `got (${c.parentOffset?.position?.x}, ${c.parentOffset?.position?.y}, ${c.parentOffset?.position?.z})`);
    check("Case A: addEmitter emitterInfo is the wasm fixture",
      c.emitterInfo?.emitterId === EMITTER_DID,
      `got ${c.emitterInfo?.emitterId}`);
  }
  check("Case A: stats.resolved bumped by 1", d.resolved === 1);
  check("Case A: stats.attempts bumped by 1", d.attempts === 1);
}

// =========================================================================
// Case B — picker selects entry[0] when speed <= first mod.
// =========================================================================
{
  _clearPhysicsScriptTableCache();
  const TARGET = 0xC0000002;
  const TABLE_DID = 0x34000005;
  const PES_DID_LOW = 0x33000200;
  const PES_DID_HIGH = 0x33000201;
  // We need both PhysicsScript fixtures so the resolver can fetch whichever
  // the picker chooses. Pick the LOW one → emitter "low".
  const psMap = new Map();
  psMap.set(PES_DID_LOW, makePhysicsScript([
    { hookType: 13, emitterDid: 0x32000010 },
  ]));
  psMap.set(PES_DID_HIGH, makePhysicsScript([
    { hookType: 13, emitterDid: 0x32000020 },
  ]));
  const wasmExports = makeWasmStubs({
    physicsScriptTable: {
      id: TABLE_DID,
      scripts: { "5": [
        { mod: 0.5, scriptDid: PES_DID_LOW },
        { mod: 1.0, scriptDid: PES_DID_HIGH },
      ] },
    },
    physicsScriptByDid: psMap,
    particleEmitter: { emitterId: 0x32000010, kind: "low" },
  });
  const { particleManager } = setupLiveScene3d({
    tableDid: TABLE_DID, wasmExports, targetGuid: TARGET,
  });
  const result = await __test.tryResolveRealVfx(TARGET, 0x05, 0.25); // below first mod
  check("Case B: resolver returns true (picker → low)", result === true);
  check("Case B: addEmitter called once", particleManager.calls.length === 1);
  check("Case B: emitterInfo is the LOW fixture (kind='low')",
    particleManager.calls[0]?.emitterInfo?.kind === "low",
    `got ${particleManager.calls[0]?.emitterInfo?.kind}`);
}

// =========================================================================
// Case C — picker clamps to last entry when speed > all mods.
// =========================================================================
{
  _clearPhysicsScriptTableCache();
  const TARGET = 0xC0000003;
  const TABLE_DID = 0x34000006;
  const PES_DID_LOW = 0x33000300;
  const PES_DID_HIGH = 0x33000301;
  const psMap = new Map();
  psMap.set(PES_DID_LOW, makePhysicsScript([{ hookType: 13, emitterDid: 0x32000030 }]));
  psMap.set(PES_DID_HIGH, makePhysicsScript([{ hookType: 13, emitterDid: 0x32000040 }]));
  const wasmExports = makeWasmStubs({
    physicsScriptTable: {
      id: TABLE_DID,
      scripts: { "4": [
        { mod: 0.5, scriptDid: PES_DID_LOW },
        { mod: 1.0, scriptDid: PES_DID_HIGH },
      ] },
    },
    physicsScriptByDid: psMap,
    particleEmitter: { emitterId: 0x32000040, kind: "high" },
  });
  const { particleManager } = setupLiveScene3d({
    tableDid: TABLE_DID, wasmExports, targetGuid: TARGET,
  });
  const result = await __test.tryResolveRealVfx(TARGET, 0x04, 5.0); // above all mods
  check("Case C: resolver returns true (picker → clamp to last)", result === true);
  check("Case C: emitterInfo is the HIGH fixture (clamp last)",
    particleManager.calls[0]?.emitterInfo?.kind === "high",
    `got ${particleManager.calls[0]?.emitterInfo?.kind}`);
}

// =========================================================================
// Case D — no table for entity (DID=0). Resolver returns false; stats
// bump `missNoTable`. (Note: the entity-resolution arm runs first, so we
// also need entity to exist + getPhysicsScriptTableDid to return 0.)
// =========================================================================
{
  _clearPhysicsScriptTableCache();
  const TARGET = 0xC0000004;
  const wasmExports = makeWasmStubs();
  setupLiveScene3d({ tableDid: 0, wasmExports, targetGuid: TARGET }); // entity exists, table=0
  const before = snapshotStats();
  const result = await __test.tryResolveRealVfx(TARGET, 0x04, 1.0);
  const d = statsDelta(before);
  check("Case D: resolver returns false on tableDid=0", result === false);
  check("Case D: missNoTable bumped by 1", d.miss.noTable === 1, `got ${d.miss.noTable}`);
  check("Case D: resolved NOT bumped", d.resolved === 0);
  check("Case D: attempts bumped (entry-point counter)", d.attempts === 1);
}

// =========================================================================
// Case E — table doesn't have the requested scriptId. Resolver returns
// false; stats bump `missNoScriptId`.
// =========================================================================
{
  _clearPhysicsScriptTableCache();
  const TARGET = 0xC0000005;
  const TABLE_DID = 0x34000007;
  const wasmExports = makeWasmStubs({
    physicsScriptTable: {
      id: TABLE_DID,
      // Only key "5" — request for "4" (Launch) won't match.
      scripts: { "5": [{ mod: 1.0, scriptDid: 0x33000400 }] },
    },
  });
  setupLiveScene3d({ tableDid: TABLE_DID, wasmExports, targetGuid: TARGET });
  const before = snapshotStats();
  const result = await __test.tryResolveRealVfx(TARGET, 0x04, 1.0);
  const d = statsDelta(before);
  check("Case E: resolver returns false when scriptId absent", result === false);
  check("Case E: missNoScriptId bumped by 1", d.miss.noScriptId === 1, `got ${d.miss.noScriptId}`);
}

// =========================================================================
// Case F — PhysicsScript has zero CreateParticle hooks. Resolver returns
// false; stats bump `missNoCreateParticleHook`. (e.g. only Sound hooks.)
// =========================================================================
{
  _clearPhysicsScriptTableCache();
  const TARGET = 0xC0000006;
  const TABLE_DID = 0x34000008;
  const PES_DID = 0x33000500;
  const wasmExports = makeWasmStubs({
    physicsScriptTable: {
      id: TABLE_DID,
      scripts: { "4": [{ mod: 1.0, scriptDid: PES_DID }] },
    },
    physicsScript: makePhysicsScript([
      // hookType 1 = Sound, 21 = SoundTweaked — neither is a particle hook.
      { hookType: 1, emitterDid: 0 },
      { hookType: 21, emitterDid: 0 },
    ]),
  });
  const { particleManager } = setupLiveScene3d({
    tableDid: TABLE_DID, wasmExports, targetGuid: TARGET,
  });
  const before = snapshotStats();
  const result = await __test.tryResolveRealVfx(TARGET, 0x04, 1.0);
  const d = statsDelta(before);
  check("Case F: resolver returns false when no CreateParticle hooks",
    result === false);
  check("Case F: missNoCreateParticleHook bumped by 1",
    d.miss.noCreateParticleHook === 1, `got ${d.miss.noCreateParticleHook}`);
  check("Case F: addEmitter NOT called", particleManager.calls.length === 0);
}

// =========================================================================
// Case G — multiple CreateParticle hooks (mix of 13 and 26). addEmitter
// called N times. Verifies the resolver iterates all qualifying hooks.
// =========================================================================
{
  _clearPhysicsScriptTableCache();
  const TARGET = 0xC0000007;
  const TABLE_DID = 0x34000009;
  const PES_DID = 0x33000600;
  const wasmExports = makeWasmStubs({
    physicsScriptTable: {
      id: TABLE_DID,
      scripts: { "4": [{ mod: 1.0, scriptDid: PES_DID }] },
    },
    physicsScript: makePhysicsScript([
      { hookType: 13, emitterDid: 0x32000700, partIndex: 0 },
      { hookType: 1,  emitterDid: 0 },                       // Sound — skipped
      { hookType: 26, emitterDid: 0x32000701, partIndex: 1 }, // CreateBlockingParticle
      { hookType: 13, emitterDid: 0x32000702, partIndex: 2 },
    ]),
    particleEmitter: { emitterId: 0x32000700, kind: "any" },
  });
  const { particleManager } = setupLiveScene3d({
    tableDid: TABLE_DID, wasmExports, targetGuid: TARGET,
  });
  const result = await __test.tryResolveRealVfx(TARGET, 0x04, 1.0);
  check("Case G: resolver returns true with multi-hook script", result === true);
  check("Case G: addEmitter called 3 times (13+26+13, Sound skipped)",
    particleManager.calls.length === 3, `got ${particleManager.calls.length}`);
  check("Case G: partIndex of call[0] is 0",
    particleManager.calls[0]?.partIndex === 0);
  check("Case G: partIndex of call[1] is 1 (from hookType 26)",
    particleManager.calls[1]?.partIndex === 1);
  check("Case G: partIndex of call[2] is 2",
    particleManager.calls[2]?.partIndex === 2);
}

// =========================================================================
// Case H — cleanup: spawned emitter scheduled for destroy after the
// ONE_SHOT_LIFETIME_MS timeout. We override `setTimeout` to capture the
// callback and fire it manually, then assert `destroyParticleEmitter` was
// called for each spawned id.
// =========================================================================
{
  _clearPhysicsScriptTableCache();
  const TARGET = 0xC0000008;
  const TABLE_DID = 0x3400000A;
  const PES_DID = 0x33000700;
  const wasmExports = makeWasmStubs({
    physicsScriptTable: {
      id: TABLE_DID,
      scripts: { "4": [{ mod: 1.0, scriptDid: PES_DID }] },
    },
    physicsScript: makePhysicsScript([
      { hookType: 13, emitterDid: 0x32000800 },
      { hookType: 26, emitterDid: 0x32000801 },
    ]),
    particleEmitter: { emitterId: 0x32000800 },
  });
  const { particleManager } = setupLiveScene3d({
    tableDid: TABLE_DID, wasmExports, targetGuid: TARGET,
  });

  // Capture the scheduled cleanup callback. The resolver calls setTimeout
  // (global, not window) — patch the global.
  let captured = null;
  let capturedDelay = 0;
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb, delay) => { captured = cb; capturedDelay = delay; return 0; };
  try {
    const result = await __test.tryResolveRealVfx(TARGET, 0x04, 1.0);
    check("Case H: resolver returns true", result === true);
    check("Case H: 2 emitters spawned", particleManager.calls.length === 2);
    check("Case H: setTimeout captured with 2500ms delay", capturedDelay === 2500,
      `got ${capturedDelay}`);
    check("Case H: cleanup callback captured", typeof captured === "function");
    // Fire the cleanup callback.
    if (captured) captured();
    check("Case H: destroyParticleEmitter called for both spawned ids",
      particleManager.destroyed.length === 2,
      `got destroyed=${particleManager.destroyed.length}`);
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
}

// =========================================================================
// Case I — entity not in entityMap. Resolver returns false; stats bump
// `missNoEntity`.
// =========================================================================
{
  _clearPhysicsScriptTableCache();
  const TARGET = 0xC0000009;
  const wasmExports = makeWasmStubs();
  setupLiveScene3d({ tableDid: 0x3400000B, wasmExports, targetGuid: TARGET, hasEntity: false });
  const before = snapshotStats();
  const result = await __test.tryResolveRealVfx(TARGET, 0x04, 1.0);
  const d = statsDelta(before);
  check("Case I: resolver returns false when entity absent", result === false);
  check("Case I: missNoEntity bumped by 1", d.miss.noEntity === 1, `got ${d.miss.noEntity}`);
}

// =========================================================================
// Case J — fetchPhysicsScript throws. Stats bump `missPhysicsScriptFetch`.
// =========================================================================
{
  _clearPhysicsScriptTableCache();
  const TARGET = 0xC000000A;
  const TABLE_DID = 0x3400000C;
  const PES_DID = 0x33000800;
  const wasmExports = {
    fetchPhysicsScriptTable: async () => JSON.stringify({
      id: TABLE_DID,
      scripts: { "4": [{ mod: 1.0, scriptDid: PES_DID }] },
    }),
    fetchPhysicsScript: async () => { throw new Error("synthetic wasm fault"); },
    fetchParticleEmitter: async () => null,
  };
  setupLiveScene3d({ tableDid: TABLE_DID, wasmExports, targetGuid: TARGET });
  const before = snapshotStats();
  const result = await __test.tryResolveRealVfx(TARGET, 0x04, 1.0);
  const d = statsDelta(before);
  check("Case J: resolver returns false on fetchPhysicsScript throw", result === false);
  check("Case J: missPhysicsScriptFetch bumped by 1",
    d.miss.physicsScriptFetch === 1, `got ${d.miss.physicsScriptFetch}`);
}

// =========================================================================
// Case K — fetchParticleEmitter throws. Stats bump `missEmitterFetch`.
// The resolver `continue`s past a failing emitter; if NO emitter spawns
// successfully the result is false.
// =========================================================================
{
  _clearPhysicsScriptTableCache();
  const TARGET = 0xC000000B;
  const TABLE_DID = 0x3400000D;
  const PES_DID = 0x33000900;
  const wasmExports = {
    fetchPhysicsScriptTable: async () => JSON.stringify({
      id: TABLE_DID,
      scripts: { "4": [{ mod: 1.0, scriptDid: PES_DID }] },
    }),
    fetchPhysicsScript: async () => makePhysicsScript([
      { hookType: 13, emitterDid: 0x32000900 },
    ]),
    fetchParticleEmitter: async () => { throw new Error("synthetic emitter fault"); },
  };
  const { particleManager } = setupLiveScene3d({
    tableDid: TABLE_DID, wasmExports, targetGuid: TARGET,
  });
  const before = snapshotStats();
  const result = await __test.tryResolveRealVfx(TARGET, 0x04, 1.0);
  const d = statsDelta(before);
  check("Case K: resolver returns false when only emitter fetch fails",
    result === false);
  check("Case K: missEmitterFetch bumped by 1",
    d.miss.emitterFetch === 1, `got ${d.miss.emitterFetch}`);
  check("Case K: addEmitter NOT called (continue past failed fetch)",
    particleManager.calls.length === 0);
}

// =========================================================================
// Case L — miss-bucket aggregate diag check. After running cases A-K
// above, the realVfxMissBreakdown should reflect every miss we triggered.
// We verify the bucket counters increased monotonically.
// =========================================================================
{
  const breakdown = VFX_COVERAGE.realVfxMissBreakdown;
  check("Case L: noTable bucket non-zero (Case D)", breakdown.noTable >= 1);
  check("Case L: noScriptId bucket non-zero (Case E)", breakdown.noScriptId >= 1);
  check("Case L: noCreateParticleHook bucket non-zero (Case F)",
    breakdown.noCreateParticleHook >= 1);
  check("Case L: noEntity bucket non-zero (Case I)", breakdown.noEntity >= 1);
  check("Case L: physicsScriptFetch bucket non-zero (Case J)",
    breakdown.physicsScriptFetch >= 1);
  check("Case L: emitterFetch bucket non-zero (Case K)", breakdown.emitterFetch >= 1);
  // Resolved counter incremented at least once per happy-path case (A/B/C/G/H).
  check("Case L: resolved counter is >= 5 (cases A, B, C, G, H)",
    VFX_COVERAGE.realVfxResolved >= 5,
    `got ${VFX_COVERAGE.realVfxResolved}`);
}

// =========================================================================
// Case M — pickScriptEntry direct unit tests (already covered by Phase 51's
// `runPickerSelfTests` but we re-execute here as part of the same harness
// so failures surface in one place).
// =========================================================================
{
  const res = __test.runPickerSelfTests();
  check("Case M: built-in picker self-tests pass",
    res.failed === 0 && res.passed === res.total,
    `${res.passed}/${res.total} pass, ${res.failed} fail`);
}

// =========================================================================
// Case N — pickScriptEntry boundary: speed === entry.mod picks that entry
// (the `<=` not `<` in the predicate). Sanity on the public export.
// =========================================================================
{
  const r = pickScriptEntry(
    [
      { mod: 0.5, scriptDid: 0x33000A01 },
      { mod: 1.0, scriptDid: 0x33000A02 },
    ],
    0.5,
  );
  check("Case N: pickScriptEntry boundary (speed === first mod) picks first",
    r?.scriptDid === 0x33000A01, `got 0x${r?.scriptDid?.toString(16)}`);
}

// =========================================================================
// Case O — Wave 2.C / Phase 55 (2026-05-28) coverage lockdown.
//
// Pre-flight check on the audit's "124 placeholders" claim found it was
// stale: 170/174 IDs have placeholder visuals; only 4 are unshipped, and
// those 4 are the ACE enum sentinels (Invalid + Test1-3). Lock that here
// so a regression in `_COVERAGE_FAMILIES` (accidentally removing a
// family arm) gets caught at test time, not in production.
// =========================================================================
{
  check("Case O: VFX_COVERAGE.shippedCount === 170 (locked by Phase 55)",
    VFX_COVERAGE.shippedCount === 170,
    `got ${VFX_COVERAGE.shippedCount} (run the agent-brief audit if this changed intentionally)`);
  check("Case O: VFX_COVERAGE.todoCount === 4 (sentinels only)",
    VFX_COVERAGE.todoCount === 4, `got ${VFX_COVERAGE.todoCount}`);
  check("Case O: VFX_COVERAGE.unshippedSentinels has exactly 4 IDs",
    Array.isArray(VFX_COVERAGE.unshippedSentinels)
      && VFX_COVERAGE.unshippedSentinels.length === 4,
    `got ${VFX_COVERAGE.unshippedSentinels?.length}`);
  // The four MUST be the ACE Invalid + Test1-3 sentinels (0x00-0x03).
  const sentinels = [...VFX_COVERAGE.unshippedSentinels].sort((a, b) => a - b);
  check("Case O: unshippedSentinels exact match [0x00, 0x01, 0x02, 0x03]",
    sentinels[0] === 0x00 && sentinels[1] === 0x01
      && sentinels[2] === 0x02 && sentinels[3] === 0x03,
    `got [${sentinels.map(s => `0x${s.toString(16)}`).join(", ")}]`);
  // Cross-verify: shipped + unshipped covers the full 0xAD enum range.
  const allCovered = new Set([...VFX_COVERAGE.shipped, ...VFX_COVERAGE.unshippedSentinels]);
  check("Case O: shipped + unshipped sentinels covers all 174 enum IDs",
    allCovered.size === 174, `got ${allCovered.size}`);
}

// =========================================================================
// Case P — Wave 2.C / Phase 55 (2026-05-28) retail-table-absent lockdown.
//
// `VFX_COVERAGE.unmappedByRetail` is the verified set of PlayScript IDs
// that NO retail PhysicsScriptTable maps to a PhysicsScript. For these
// IDs, even an entity with a `physicsScriptTableDid` will trip
// `missNoScriptId` in the resolver and fall through to placeholders.
//
// Source: `data/playscript-canonical-physics-scripts.json` generated by
// `scripts/gen-playscript-canonical-physics-scripts.cjs` (which dumps
// every 0x34 record in `client_portal.dat`). The two MUST stay in sync —
// next agent re-running the generator should re-verify this assertion.
// =========================================================================
{
  check("Case P: VFX_COVERAGE.unmappedByRetail has 27 IDs (4 sentinels + 23 ambient)",
    Array.isArray(VFX_COVERAGE.unmappedByRetail)
      && VFX_COVERAGE.unmappedByRetail.length === 27,
    `got ${VFX_COVERAGE.unmappedByRetail?.length}`);
  // The 4 sentinels MUST be a subset of unmappedByRetail (sentinels are
  // by definition unmapped). Use set membership.
  const unmappedSet = new Set(VFX_COVERAGE.unmappedByRetail);
  for (const s of VFX_COVERAGE.unshippedSentinels) {
    check(`Case P: sentinel 0x${s.toString(16)} is unmappedByRetail`,
      unmappedSet.has(s));
  }
  // PortalEntry/Exit are confirmed ambient cases (placeholder-only by
  // design in retail — the portal traversal itself is a separate visual).
  check("Case P: PortalEntry (0x52) in unmappedByRetail (placeholder-only by retail design)",
    unmappedSet.has(0x52));
  check("Case P: PortalExit (0x53) in unmappedByRetail",
    unmappedSet.has(0x53));
  // SpecialState range (0x78-0x89, 18 IDs) is all ambient HUD cues.
  let specialStateCount = 0;
  for (let id = 0x78; id <= 0x89; id++) {
    if (unmappedSet.has(id)) specialStateCount++;
  }
  check("Case P: 18 SpecialState IDs (0x78-0x89) all in unmappedByRetail",
    specialStateCount === 18, `got ${specialStateCount}`);
}

// ---- Summary -------------------------------------------------------------
console.log("");
console.log(`Cases: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log("All Wave 18 / Phase 53 + Wave 2.C / Phase 55 resolver regression tests PASS.");
}
