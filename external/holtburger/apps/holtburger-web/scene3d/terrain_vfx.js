// scene3d/terrain_vfx.js — the per-landblock terrain-VFX spawn/despawn spine.
//
// Design plan: `docs/2026-07-31-terrain-vfx-plan.md` §2.2. Wave 0B.
//
// WHY THIS MODULE EXISTS. AC's ground is a streaming 13×13 landblock ring with
// an LRU that EVICTS *and* PARKS. The residency logic is the hard part of every
// terrain effect, and it must be written exactly once — so no family agent
// (grass, sand, snow, volcano, swamp, dirt, rock) ever touches
// `landblock_lru.js` or `fixed_grid.js`. They register a provider here.
//
// ⚠ THE PARK TRAP (plan §2.2.1, `landblock_lru.js` park()). Park stashes an
// LB's terrain mesh OUT of `terrainGroup` and disposes NOTHING, and it
// deliberately does NOT fire `_onEvictLandblock` (comment at landblock_lru.js
// :1638). Park REPLACES eviction once the LRU is at cap, so a provider hooked
// only to the evict callback leaks on almost every landblock. This spine wires
// park, unpark AND evict, and gives providers three distinct callbacks.
//
// THE FOUR SEAMS (all verified against the shipped code):
//   attach  `scene3d/index.js::loadTerrainForLandblock` calls
//           `terrainVfxNoteLandblockMesh(scene3d, lbMesh)` with the fresh mesh.
//           There is no event on `terrainGroup.add` and we do NOT monkey-patch
//           it (plan §2.2.1).
//   evict   `landblock_lru.js::evict` → `scene3d._evictTerrainBatchForLb(lbKey)`
//   park    `landblock_lru.js::park`  → `scene3d._parkTerrainBatchForLb(lbKey)`
//   unpark  `landblock_lru.js::unpark`→ `scene3d._unparkTerrainBatchForLb(lbKey, meshes)`
//
// ⚠ WE CHAIN, WE DO NOT CLOBBER. Those three property names are ALREADY owned
// by `terrain_batch.js` (`:548 _installHooksOn`), which re-installs its bare
// function on every absorb. Assigning ours would silently break the cross-LB
// terrain BatchedMesh. So we WRAP whatever is there, tag the wrapper, and
// re-check the wrapping every tick — if terrain_batch has re-installed its bare
// function since, we re-wrap it. No chain growth (the wrapper is never wrapped
// twice), no ordering assumption between the two modules' init.
// Installed on all three facades exactly like `terrain_batch.js::_installHooks`
// (`scene3d`, `scene3d.landblockLru.scene3d`, `window.liveScene3d`) — a hook on
// the wrong facade is indistinguishable from a hook that never fires.
//
// REBAKE. `terrain.js::drainOneTerrainLodRebake` calls
// `scene3d._evictTerrainBatchForLb(lbKey)` and then re-enters
// `loadTerrainForLandblock`, so a rebake arrives here as gone-then-ready for
// free. `oracle.invalidate(lbKey)` runs on the gone half (plan §2.2.1).
//
// INJECTED THREE (the `vfx/particle_attach.js` idiom). This module imports no
// three: `initTerrainVfx({THREE, ...})` takes it. That keeps
// `test_terrain_vfx_lifecycle.mjs` a pure-node test with no stub loader, and it
// is the only reason the whole lifecycle is testable at all.
//
// LATE-BOUND ORACLE. `terrain_oracle.js` is Wave 0A's file and may not exist
// yet. It is loaded by DYNAMIC import, ON DEMAND (first provider registration,
// or an explicit `ensureOracle()`), never at module scope — so a bare-default
// boot with no providers issues no request and cannot log a 404. Everything
// noted before the oracle resolves is replayed into it.
//
// INVARIANTS (plan §5). A host module, not a registered VFX component, so
// `vfx/lint_caps.js` does not sweep it and it MAY toggle `.visible` (§5.3
// explicitly parks visibility churn here rather than in components). It still
// obeys the firewall: it reads static terrain data, a server-derived position
// and the frame clock, and writes only render-time state it owns. It adds no
// light (§5.2), patches no material and varies no program cache key (§5.4).
// Placement is deterministic — no `Math.random` anywhere (§5.5).
//
// FLAGS
//   ?terrainVfx=off   master kill switch (default ON — the spine is inert
//                     without providers, and every family flag ships OFF).
//   ?wireframe=1      hard no-op (plan §8 risk 8). The guard lives HERE, once,
//                     so no family has to remember it.

import {
  terrainVfxEnabled,
  terrainTrailEnabled,
  terrainTrailResolution,
  terrainTrailRadiusM,
  terrainTrailRecoverySec,
  terrainTrailWriters,
  terrainTrailFadeSource,
} from "./vfx_flags.js";
import { FAM_COUNT, familyForCode } from "./terrain_families.js";
import { createTrailMap, resolveTrailMapConfig } from "./trail_map.js";

// ---------------------------------------------------------------------------
// Constants + tiny pure helpers.
// ---------------------------------------------------------------------------

export const METERS_PER_LANDBLOCK = 192;
export const VERTEX_GRID = 9;
export const VERTEX_SPACING_M = 24;

/** `landblock_lru.js:348 lbKeyFromXY` — the canonical residency key. */
export function lbKeyFromXY(lbX, lbY) {
  return ((((lbX | 0) & 0xff) << 24) | (((lbY | 0) & 0xff) << 16)) >>> 0;
}

/** `landblock_lru.js:352 lbKeyOf` — masks the `| 0xffff` cell form off an lbId. */
export function lbKeyOf(landblockIdOrLbKey) {
  return ((landblockIdOrLbKey >>> 0) & 0xffff0000) >>> 0;
}

/** Per-family vertex counts for one LB's 81 codes. `Uint16Array(FAM_COUNT)`. */
export function familyCoverageOf(codes) {
  const out = new Uint16Array(FAM_COUNT);
  if (!codes) return out;
  const n = Math.min(codes.length, VERTEX_GRID * VERTEX_GRID);
  for (let i = 0; i < n; i += 1) out[familyForCode(codes[i])] += 1;
  return out;
}

/** Does this LB carry any vertex in any of `families`? `null`/empty ⇒ all LBs. */
export function coverageMatches(coverage, families) {
  if (!families || families.length === 0) return true;
  if (!coverage) return true;
  for (const f of families) {
    if (coverage[f | 0] > 0) return true;
  }
  return false;
}

/**
 * `?wireframe=1` guard (plan §8 risk 8). Wireframe mode skips sky, composer,
 * CSM and shadows and swaps every material for a `MeshBasicMaterial`;
 * `terrain_batch` explicitly never batches in it. Terrain VFX must be a hard
 * no-op there. Mirrors `scene3d/index.js:698` (`=== "1"`), plus `on` so a
 * near-miss spelling still disables rather than half-enables.
 */
export function wireframeActive(search) {
  try {
    const s = typeof search === "string"
      ? search
      : (typeof window !== "undefined" && window.location ? window.location.search : "");
    const v = new URLSearchParams(s).get("wireframe");
    return v === "1" || v === "on";
  } catch (_) { return false; }
}

/** Deterministic [0,1) LCG — `Math.random` is banned (§5.5). */
export function makeSeededRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function next() {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Module state. A singleton, like `terrain_batch.js` — loop.js must be able to
// call `terrainVfxTick` with no construction, and providers register at import
// time from anywhere.
// ---------------------------------------------------------------------------

/** id → provider record. Registration is legal BEFORE init. */
const _providers = new Map();

/** lbKey → {lbX, lbY, parked, codes, heights, coverage, groups:Map<id,Group>} */
const _tracked = new Map();

let _spine = null;
let _oracle = null;
let _oracleState = "idle";   // idle | loading | ready | absent
let _oraclePromise = null;
let _trail = null;
let _disabledReason = null;  // null | "flag" | "wireframe"
let _tickWarned = false;
// Previous LIVE tick stamp (seconds), for deriving a dt that cannot freeze with
// `scene3d.frameTime`. `null` = no live tick yet, so the first one reports dt 0.
let _liveTickPrevSec = null;
// Bumped by `_resetTerrainVfx` so an in-flight oracle import from a previous
// test/session cannot land on a fresh spine.
let _epoch = 0;

const _stats = {
  inits: 0,
  attaches: 0,
  rebakes: 0,
  parks: 0,
  unparks: 0,
  gones: 0,
  ticks: 0,
  providerErrors: 0,
  hookInstalls: 0,
  hookRewraps: 0,
  replays: 0,
};

// Reusable frame-context object — the tick must not allocate (plan §2.3).
const _frameCtx = {
  scene3d: null,
  tSec: 0,
  dt: 0,
  playerPos: { x: 0, y: 0, z: 0 },
  hasPlayer: false,
  camera: null,
  quality: null,
  oracle: null,
  trail: null,
};

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

function _validateProvider(p) {
  if (!p || typeof p !== "object") throw new Error("registerTerrainVfx: provider must be an object");
  if (typeof p.id !== "string" || p.id === "") throw new Error("registerTerrainVfx: provider.id must be a non-empty string");
  const scope = p.scope || "landblock";
  if (scope !== "landblock" && scope !== "camera") {
    throw new Error(`registerTerrainVfx(${p.id}): scope must be "landblock" | "camera" (got ${JSON.stringify(scope)})`);
  }
  return scope;
}

/**
 * Register a terrain-VFX provider (plan §2.2).
 *
 * provider = {
 *   id: "terrain.grass",
 *   families: [FAM_GRASS],            // omit/[] ⇒ every landblock
 *   scope: "landblock" | "camera",
 *   enabled(): boolean,               // the ?flag reader (plan §2.4)
 *   quality(flags): object | null,    // null ⇒ disabled at this tier
 *   onLandblockReady(ctx),            // {lbKey, lbX, lbY, originX, originY,
 *                                     //  codes, heights, coverage, oracle,
 *                                     //  group, quality, trail}
 *   onLandblockPark(lbKey),
 *   onLandblockUnpark(lbKey, ctx),
 *   onLandblockGone(lbKey),
 *   update(dt, frameCtx),
 *   dispose(),
 * }
 *
 * `scope: "camera"` providers get NO landblock callbacks at all — they own a
 * fixed-size pool re-centred on the player and are immune to evict/park/rebake
 * by construction (plan §2.2). That is the correct scope for grass.
 *
 * @returns {{id:string, unregister:()=>void}}
 */
export function registerTerrainVfx(provider) {
  const scope = _validateProvider(provider);
  if (_providers.has(provider.id)) {
    throw new Error(`registerTerrainVfx: duplicate provider id ${JSON.stringify(provider.id)}`);
  }
  const rec = {
    provider,
    id: provider.id,
    scope,
    families: Array.isArray(provider.families) ? provider.families.slice() : [],
    live: new Set(),      // lbKeys this provider has been told about (landblock scope)
    errors: 0,
    lastError: null,
  };
  _providers.set(provider.id, rec);

  // Loading a provider is the trigger for the oracle: it is the first moment
  // anything actually needs terrain samples.
  ensureOracle();

  // Replay every already-resident landblock so a provider that registers after
  // the boot ring has already baked is not permanently blind to it.
  if (_spine && !_disabled() && scope === "landblock" && _providerActive(rec)) {
    for (const [lbKey, entry] of _tracked) {
      if (entry.parked) continue;
      _fireReady(rec, lbKey, entry);
      _stats.replays += 1;
    }
  }
  return {
    id: provider.id,
    unregister() { unregisterTerrainVfx(provider.id); },
  };
}

/** Drop a provider, tearing down every landblock it still holds. */
export function unregisterTerrainVfx(id) {
  const rec = _providers.get(id);
  if (!rec) return false;
  for (const lbKey of rec.live) _safe(rec, "onLandblockGone", lbKey);
  rec.live.clear();
  for (const entry of _tracked.values()) {
    const g = entry.groups.get(id);
    if (g) { _detachGroup(g); entry.groups.delete(id); }
  }
  _safe(rec, "dispose");
  _providers.delete(id);
  return true;
}

/** Test seam — drop every provider and all tracked landblocks. */
export function _resetTerrainVfx() {
  for (const id of [..._providers.keys()]) unregisterTerrainVfx(id);
  _tracked.clear();
  if (_trail) { try { _trail.dispose(); } catch (_) {} _trail = null; }
  _liveTickPrevSec = null;
  _spine = null;
  _oracle = null;
  _oracleState = "idle";
  _oraclePromise = null;
  _disabledReason = null;
  _tickWarned = false;
  _epoch += 1;
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}

// ---------------------------------------------------------------------------
// Gates.
// ---------------------------------------------------------------------------

function _disabled() {
  return _disabledReason !== null;
}

function _providerActive(rec) {
  const p = rec.provider;
  if (typeof p.enabled !== "function") return true;
  try { return p.enabled() === true; } catch (_) { return false; }
}

function _providerQuality(rec) {
  const p = rec.provider;
  if (typeof p.quality !== "function") return {};
  try { return p.quality(_qualityFlags()); } catch (e) { _noteError(rec, "quality", e); return null; }
}

function _qualityFlags() {
  // The canonical runtime read idiom (`particles/particle_emitter.js:213`).
  try {
    if (_spine?.scene3d?.quality?.flags) return _spine.scene3d.quality.flags;
    if (typeof window !== "undefined" && window.liveScene3d?.quality?.flags) {
      return window.liveScene3d.quality.flags;
    }
  } catch (_) { /* fail-soft */ }
  return null;
}

function _noteError(rec, hook, e) {
  rec.errors += 1;
  rec.lastError = `${hook}: ${e && e.message ? e.message : e}`;
  _stats.providerErrors += 1;
  if (rec.errors <= 3) {
    // eslint-disable-next-line no-console
    console.warn(`[terrainVfx] provider ${rec.id}.${hook} threw:`, e);
  }
}

function _safe(rec, hook, a, b) {
  const fn = rec.provider[hook];
  if (typeof fn !== "function") return undefined;
  try { return fn.call(rec.provider, a, b); } catch (e) { _noteError(rec, hook, e); return undefined; }
}

// ---------------------------------------------------------------------------
// Groups. A provider's per-LB container is a child of `terrainVfxGroup`, a
// SIBLING of `terrainGroup` under `worldRoot` with the SAME (identity)
// transform — so providers work in AC world coordinates directly
// (+X east, +Y north, +Z up; plan §2.1 "Coordinate frame").
//
// ⚠ It MUST be a sibling, not a child of terrainGroup: `landblock_lru.park` and
// `evict` and `terrain.js::drainOneTerrainLodRebake` all SCAN
// `terrainGroup.children` and act on anything whose userData carries our lbX/lbY.
// A VFX group parented there would be silently parked, removed and disposed by
// three different owners.
// ---------------------------------------------------------------------------

function _makeGroup(name) {
  const THREE = _spine?.THREE;
  if (!THREE || typeof THREE.Group !== "function") return null;
  const g = new THREE.Group();
  g.name = name;
  // §5.7 — added geometry is paid twice; nothing here casts a shadow.
  g.castShadow = false;
  g.receiveShadow = false;
  return g;
}

function _attachGroup(g) {
  if (!g || !_spine?.vfxGroup) return;
  try { _spine.vfxGroup.add(g); } catch (_) {}
}

function _detachGroup(g) {
  if (!g) return;
  try { g.parent?.remove(g); } catch (_) {}
}

function _groupFor(rec, lbKey, entry) {
  let g = entry.groups.get(rec.id);
  if (!g) {
    g = _makeGroup(`tvfx-${rec.id}-${lbKey.toString(16)}`);
    if (g) { entry.groups.set(rec.id, g); _attachGroup(g); }
  }
  return g;
}

function _ctxFor(rec, lbKey, entry) {
  return {
    lbKey,
    lbX: entry.lbX,
    lbY: entry.lbY,
    originX: entry.lbX * METERS_PER_LANDBLOCK,
    originY: entry.lbY * METERS_PER_LANDBLOCK,
    codes: entry.codes,
    heights: entry.heights,
    coverage: entry.coverage,
    // ⚠ GETTERS, not snapshots. The oracle is loaded ON DEMAND and the trail
    // map can be constructed after a provider has already been handed a ctx —
    // a provider that stashed `ctx.oracle` at ready time and got `null` would
    // stay blind for the whole session. (This is the same class of bug as the
    // documented `window.liveScene3d` snapshot trap.)
    get oracle() { return _oracle; },
    get trail() { return _trail; },
    group: _groupFor(rec, lbKey, entry),
    quality: _providerQuality(rec),
  };
}

function _fireReady(rec, lbKey, entry) {
  if (rec.live.has(lbKey)) return;
  if (!coverageMatches(entry.coverage, rec.families)) return;
  const ctx = _ctxFor(rec, lbKey, entry);
  if (ctx.quality === null) return; // disabled at this tier
  rec.live.add(lbKey);
  _safe(rec, "onLandblockReady", ctx);
}

// ---------------------------------------------------------------------------
// The four lifecycle entry points.
// ---------------------------------------------------------------------------

/**
 * ATTACH seam. Called from `scene3d/index.js::loadTerrainForLandblock` with the
 * mesh the baker just added to `terrainGroup` (or `null` on an idempotent
 * re-call, which is not an attach).
 *
 * Feeds the oracle FIRST (plan §2.1.1 — the oracle's own cache is what makes it
 * survive park), then fires `onLandblockReady` for every matching provider.
 * An LB we already track is a REBAKE: gone-then-ready.
 */
export function terrainVfxNoteLandblockMesh(scene3d, lbMesh) {
  if (!_spine || _disabled() || !lbMesh) return;
  const ud = lbMesh.userData;
  if (!ud || !ud.terrainCodes) return;
  // Re-assert the hook chain HERE, not only in the tick. `terrain_batch.js`
  // re-installs its BARE function on every absorb (:760) — and an absorb is
  // exactly what just happened for this mesh. The tick also re-asserts, but it
  // early-returns while the spine is inert (no providers, no trail), so
  // WITHOUT this the wrappers silently decay across a session that has not
  // registered a family yet and park/evict stop reaching us. Measured live
  // 2026-07-31: 126 attaches, 0 parks, 0 gones, all three facades reporting
  // false, before this line existed.
  installTerrainVfxHooks(scene3d || _spine.scene3d);
  const lbX = ud.lbX | 0;
  const lbY = ud.lbY | 0;
  const lbKey = lbKeyFromXY(lbX, lbY);

  if (_tracked.has(lbKey)) {
    // Rebake (`terrain.js::drainOneTerrainLodRebake` destroys then re-enters
    // the loader). Tear the old one down first so providers never see two
    // "ready" for one LB.
    _stats.rebakes += 1;
    terrainVfxLandblockGone(lbKey, "rebake");
  }

  const entry = {
    lbX,
    lbY,
    parked: false,
    codes: ud.terrainCodes,
    // Wave 0A adds `heights` to the userData literal; tolerate its absence so
    // this module works against a tree where that line has not landed.
    heights: ud.heights || null,
    coverage: familyCoverageOf(ud.terrainCodes),
    groups: new Map(),
  };
  _tracked.set(lbKey, entry);
  _stats.attaches += 1;

  // The oracle owns its own cache and keeps it across park/unpark.
  if (_oracle && typeof _oracle.noteLandblock === "function") {
    try {
      _oracle.noteLandblock(lbKey, {
        codes: entry.codes, heights: entry.heights, lbX, lbY,
      });
    } catch (_) { /* fail-soft */ }
  }

  for (const rec of _providers.values()) {
    if (rec.scope !== "landblock" || !_providerActive(rec)) continue;
    _fireReady(rec, lbKey, entry);
  }
}

/** PARK. Nothing is disposed; the LB is coming back. `onLandblockGone` MUST NOT fire. */
export function terrainVfxLandblockPark(lbKey) {
  const key = lbKeyOf(lbKey);
  const entry = _tracked.get(key);
  if (!entry || entry.parked) return;
  entry.parked = true;
  _stats.parks += 1;
  // Host-module visibility churn — §5.3 explicitly places it here rather than
  // in a registered component (which may only stop emission / zero intensity).
  for (const g of entry.groups.values()) { try { g.visible = false; } catch (_) {} }
  for (const rec of _providers.values()) {
    if (rec.scope !== "landblock" || !rec.live.has(key)) continue;
    _safe(rec, "onLandblockPark", key);
  }
}

/** UNPARK. Restore visibility; NEVER re-scatter (hash-stable placement, §5.4/§5.5). */
export function terrainVfxLandblockUnpark(lbKey) {
  const key = lbKeyOf(lbKey);
  const entry = _tracked.get(key);
  if (!entry) return;
  entry.parked = false;
  _stats.unparks += 1;
  for (const g of entry.groups.values()) { try { g.visible = true; } catch (_) {} }
  for (const rec of _providers.values()) {
    if (rec.scope !== "landblock" || !_providerActive(rec)) continue;
    if (rec.live.has(key)) {
      _safe(rec, "onLandblockUnpark", key, _ctxFor(rec, key, entry));
    } else {
      // Registered while this LB was parked — first sight is a ready.
      _fireReady(rec, key, entry);
    }
  }
}

/** EVICT / REBAKE. The LB is really gone: drop the oracle cache and the groups. */
export function terrainVfxLandblockGone(lbKey, reason) {
  const key = lbKeyOf(lbKey);
  const entry = _tracked.get(key);
  if (!entry) return;
  if (reason !== "rebake") _stats.gones += 1;
  for (const rec of _providers.values()) {
    if (!rec.live.has(key)) continue;
    rec.live.delete(key);
    _safe(rec, "onLandblockGone", key);
  }
  for (const g of entry.groups.values()) _detachGroup(g);
  entry.groups.clear();
  _tracked.delete(key);
  if (_oracle && typeof _oracle.invalidate === "function") {
    try { _oracle.invalidate(key); } catch (_) { /* fail-soft */ }
  }
}

// ---------------------------------------------------------------------------
// Facade hook install — CHAINING, not clobbering. See the header.
// ---------------------------------------------------------------------------

const HOOK_SPECS = [
  ["_evictTerrainBatchForLb", (lbKey) => terrainVfxLandblockGone(lbKey, "evict")],
  ["_parkTerrainBatchForLb", (lbKey) => terrainVfxLandblockPark(lbKey)],
  ["_unparkTerrainBatchForLb", (lbKey) => terrainVfxLandblockUnpark(lbKey)],
];

function _wrap(prop, mine, inner) {
  const wrapper = function terrainVfxHook(a, b) {
    let out;
    if (typeof inner === "function") {
      // The other owner's behaviour runs FIRST and its throw must not eat ours.
      try { out = inner.call(this, a, b); } catch (_) { /* fail-soft */ }
    }
    try { mine(a, b); } catch (_) { /* fail-soft */ }
    return out;
  };
  wrapper.__terrainVfxHook = prop;
  wrapper.__terrainVfxInner = typeof inner === "function" ? inner : null;
  return wrapper;
}

function _installHooksOn(target) {
  if (!target) return;
  for (const [prop, mine] of HOOK_SPECS) {
    try {
      const cur = target[prop];
      if (typeof cur === "function" && cur.__terrainVfxHook === prop) continue; // already ours
      target[prop] = _wrap(prop, mine, cur);
      if (cur) _stats.hookRewraps += 1;
    } catch (_) { /* fail-soft: frozen / proxied facade */ }
  }
}

/**
 * Install on EVERY facade (`terrain_batch.js:563 _installHooks` precedent, and
 * the dual-facade footgun documented there): a hook on the wrong facade is
 * indistinguishable from a hook that never fires.
 */
export function installTerrainVfxHooks(scene3d) {
  _stats.hookInstalls += 1;
  _installHooksOn(scene3d);
  try { _installHooksOn(scene3d?.landblockLru?.scene3d); } catch (_) {}
  try {
    const live = typeof window !== "undefined" ? window.liveScene3d : null;
    _installHooksOn(live);
    _installHooksOn(live?.landblockLru?.scene3d);
  } catch (_) {}
}

/** Which facades currently carry our wrapper (diag + `test_terrain_vfx_lifecycle`). */
export function terrainVfxHookReport(scene3d) {
  const facades = [
    ["scene3d", scene3d],
    ["landblockLru.scene3d", scene3d?.landblockLru?.scene3d],
    ["liveScene3d", typeof window !== "undefined" ? window.liveScene3d : null],
  ];
  const out = {};
  for (const [label, f] of facades) {
    out[label] = f
      ? HOOK_SPECS.every(([prop]) => typeof f[prop] === "function" && f[prop].__terrainVfxHook === prop)
      : null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The oracle (Wave 0A) — late-bound, on demand, never at module scope.
// ---------------------------------------------------------------------------

/**
 * Resolve `scene3d/terrain_oracle.js` if it exists. Safe to call repeatedly.
 * Returns a promise for the oracle or `null` (never rejects).
 *
 * On success every landblock already noted is REPLAYED into it, so an oracle
 * that lands mid-session immediately knows the whole resident ring.
 */
export function ensureOracle() {
  if (_oracleState === "ready" || _oracleState === "absent") return Promise.resolve(_oracle);
  if (_oraclePromise) return _oraclePromise;
  _oracleState = "loading";
  const epoch = _epoch;
  _oraclePromise = import("./terrain_oracle.js")
    .then((mod) => {
      if (epoch !== _epoch) return null;   // a reset raced us; drop the result
      const make = mod && (mod.createTerrainOracle || mod.default);
      if (typeof make !== "function") {
        _oracleState = "absent";
        return null;
      }
      _oracle = make({
        getTerrainMeshes: () => {
          try { return _spine?.scene3d?.terrainGroup?.children || []; } catch (_) { return []; }
        },
      });
      _oracleState = "ready";
      if (typeof _oracle.noteLandblock === "function") {
        for (const [lbKey, entry] of _tracked) {
          try {
            _oracle.noteLandblock(lbKey, {
              codes: entry.codes, heights: entry.heights, lbX: entry.lbX, lbY: entry.lbY,
            });
          } catch (_) { /* fail-soft */ }
        }
      }
      _frameCtx.oracle = _oracle;
      return _oracle;
    })
    .catch(() => {
      // Wave 0A has not landed. Not an error — providers see `ctx.oracle ===
      // null` and either wait or fall back.
      if (epoch === _epoch) _oracleState = "absent";
      return null;
    });
  return _oraclePromise;
}

/** The oracle, or `null` if Wave 0A has not landed / has not resolved yet. */
export function terrainVfxOracle() { return _oracle; }

// ---------------------------------------------------------------------------
// Init.
// ---------------------------------------------------------------------------

/**
 * Construct the spine. Called once from `scene3d/index.js` after
 * `window.liveScene3d` is set.
 *
 * @param {object} opts
 * @param {object} opts.THREE     the three namespace (injected — see header)
 * @param {object} opts.scene3d   the live facade
 * @param {object} [opts.parent]  Object3D to hang the VFX group off. Defaults
 *                                to `terrainGroup.parent` (worldRoot) so the
 *                                group is a SIBLING with the same transform.
 * @param {object} [opts.renderer] THREE.WebGLRenderer, for the trail map.
 * @returns {object|null} the `window.__terrainVfx` surface, or null when off.
 */
export function initTerrainVfx(opts = {}) {
  const scene3d = opts.scene3d || null;
  if (!scene3d) return null;

  // ── the two gates, evaluated ONCE, here, for every family ──────────────
  if (wireframeActive(opts.search)) {
    _disabledReason = "wireframe";
  } else if (terrainVfxEnabled() !== true) {
    _disabledReason = "flag";
  } else {
    _disabledReason = null;
  }

  _spine = {
    THREE: opts.THREE || null,
    scene3d,
    renderer: opts.renderer || null,
    vfxGroup: null,
  };
  _stats.inits += 1;

  if (_disabled()) {
    // Still expose the surface so a probe can ask WHY nothing is happening —
    // but allocate nothing and install no hooks: a bare `?wireframe=1` or
    // `?terrainVfx=off` boot must be byte-identical.
    return _installWindowSurface();
  }

  // Sibling group with terrainGroup's transform (see the _makeGroup block).
  const parent = opts.parent || scene3d.terrainGroup?.parent || null;
  if (parent && _spine.THREE) {
    const g = _makeGroup("terrainVfx");
    if (g) { try { parent.add(g); _spine.vfxGroup = g; } catch (_) {} }
  }

  // Trail map — OFF on every tier (plan §5.9). Built by `?terrainTrail=on`, by
  // a tier that promotes it, or IMPLIED by a live trail-writing effect
  // (vfx_flags.js `_trailFadeClaims`) so promoting a stamping family cannot
  // leave it silently no-oping. `?terrainTrail=off` still suppresses it.
  const trailCfg = resolveTrailMapConfig({
    enabled: terrainTrailEnabled,
    resolution: terrainTrailResolution,
    radiusM: terrainTrailRadiusM,
    recoverySec: terrainTrailRecoverySec,
  });
  if (trailCfg.enabled) {
    _trail = createTrailMap({
      THREE: _spine.THREE,
      renderer: _spine.renderer,
      resolution: trailCfg.resolution,
      radiusM: trailCfg.radiusM,
      recoverySec: trailCfg.recoverySec,
    });
    _frameCtx.trail = _trail;
  }

  installTerrainVfxHooks(scene3d);

  // Backfill: `initTerrainVfx` may run after the boot ring has already baked.
  // Only meaningful once a provider exists, but doing it here keeps the oracle
  // honest about the ring it can see.
  _backfillFromTerrainGroup(scene3d);

  return _installWindowSurface();
}

function _backfillFromTerrainGroup(scene3d) {
  const kids = scene3d?.terrainGroup?.children;
  if (!Array.isArray(kids)) return;
  for (const c of kids) {
    const ud = c && c.userData;
    if (!ud || !ud.terrainCodes) continue;
    if (_tracked.has(lbKeyFromXY(ud.lbX | 0, ud.lbY | 0))) continue;
    terrainVfxNoteLandblockMesh(scene3d, c);
  }
}

// ---------------------------------------------------------------------------
// The per-frame tick. ONE call from `loop.js`, next to `tickVfxOscillators`.
// ---------------------------------------------------------------------------

/** Largest dt a single tick may report, seconds. A long stall (tab hidden, a
 *  bake burst) must not hand a provider a 30 s step to integrate in one go. */
const MAX_TICK_DT_SEC = 0.25;

/**
 * @param {number} dt   seconds since last frame (fallback only — see liveTsSec)
 * @param {object} ctx  the scene3d facade (loop.js passes `scene3d`)
 * @param {number} [liveTsSec] LIVE monotonic seconds from the caller's own
 *   clock. STRONGLY PREFERRED over `scene3d.frameTime`, which is stamped only
 *   by the rAF tick: the `?netDrainHz=N` interval also drives `tickPerFrame`
 *   while that loop idles under `?renderOnDemand=1` / `?nullRender=1`, so both
 *   `frameTime.tsSec` and `frameTime.dt` FREEZE there. A frozen clock stops
 *   terrain_rock's 15 s retail light tick from ever expiring again and makes
 *   terrain_dirt's per-entity footfall limiter (`tSec - last < interval`)
 *   reject every step forever. When supplied, dt is derived from successive
 *   live stamps so it stays truthful too.
 */
export function terrainVfxTick(dt, ctx, liveTsSec) {
  if (!_spine || _disabled()) return;
  if (_providers.size === 0 && !_trail) return;   // inert: no providers, no map
  _stats.ticks += 1;

  const scene3d = ctx || _spine.scene3d;

  // Re-assert the hook chain. `terrain_batch.js::_installHooks` re-installs its
  // BARE function on every absorb, which would drop our wrapper; this is the
  // cheap, order-independent way to survive that (3 identity compares/facade).
  installTerrainVfxHooks(scene3d);

  // Single time source (plan §2.3) — never `performance.now()` in an effect.
  // The caller's live monotonic stamp wins when it is offered; frameTime is the
  // fallback for callers that predate the third argument (and for tests that
  // drive the tick directly).
  const hasLive = Number.isFinite(liveTsSec);
  const tSec = hasLive ? liveTsSec : (scene3d?.frameTime?.tsSec ?? _frameCtx.tSec);
  let frameDt;
  if (hasLive) {
    // Derive dt from successive LIVE stamps so it cannot freeze with frameTime.
    const prev = _liveTickPrevSec;
    _liveTickPrevSec = liveTsSec;
    const delta = prev === null ? 0 : liveTsSec - prev;
    frameDt = delta > 0 ? Math.min(delta, MAX_TICK_DT_SEC) : 0;
  } else {
    frameDt = Number.isFinite(dt) ? dt : (scene3d?.frameTime?.dt ?? 0);
  }

  _frameCtx.scene3d = scene3d;
  _frameCtx.tSec = tSec;
  _frameCtx.dt = frameDt;
  _frameCtx.oracle = _oracle;
  _frameCtx.trail = _trail;
  _frameCtx.quality = _qualityFlags();
  _frameCtx.camera = scene3d?.camera || null;
  _frameCtx.hasPlayer = _readPlayerPos(scene3d, _frameCtx.playerPos);

  if (_trail && _frameCtx.hasPlayer) {
    _trail.update(frameDt, _frameCtx.playerPos.x, _frameCtx.playerPos.y);
  }

  for (const rec of _providers.values()) {
    if (typeof rec.provider.update !== "function") continue;
    if (!_providerActive(rec)) continue;
    try { rec.provider.update(frameDt, _frameCtx); } catch (e) {
      _noteError(rec, "update", e);
      if (!_tickWarned) _tickWarned = true;
    }
  }
}

/** AC-space player position (+Z up), zero-alloc. `camera.js:2590 _safePlayerPos`. */
function _readPlayerPos(scene3d, out) {
  try {
    const cs = scene3d?.cameraSwitcher;
    const p = cs && typeof cs._safePlayerPos === "function" ? cs._safePlayerPos() : null;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      out.x = p.x; out.y = p.y; out.z = Number.isFinite(p.z) ? p.z : 0;
      return true;
    }
  } catch (_) { /* fail-soft */ }
  return false;
}

// ---------------------------------------------------------------------------
// Diagnostics — `window.__terrainVfx`.
// ---------------------------------------------------------------------------

/** The stats surface (plan §2.2 `terrainVfxStats()`). */
export function terrainVfxStats() {
  const providers = [];
  for (const rec of _providers.values()) {
    providers.push({
      id: rec.id,
      scope: rec.scope,
      families: rec.families.slice(),
      enabled: _providerActive(rec),
      liveLandblocks: rec.live.size,
      errors: rec.errors,
      lastError: rec.lastError,
    });
  }
  let resident = 0;
  let parked = 0;
  for (const e of _tracked.values()) { if (e.parked) parked += 1; else resident += 1; }
  return {
    enabled: !_disabled(),
    disabledReason: _disabledReason,
    inited: !!_spine,
    oracle: _oracleState,
    trail: _trail ? _trail.stats() : null,
    // WHY the map is (or is not) there, and which number the fade came from —
    // "the flag is off but I never typed it" is a one-line read at promotion.
    trailFlag: terrainTrailEnabled(),
    trailWriters: terrainTrailWriters(),
    trailFade: terrainTrailFadeSource(),
    tracked: _tracked.size,
    resident,
    parked,
    providers,
    counters: { ..._stats },
    hooks: terrainVfxHookReport(_spine?.scene3d),
  };
}

/**
 * THE Wave-0 exit criterion (plan §2.5). Samples N deterministic points inside
 * the resident ring and asserts `oracle.sample(x,y).height` agrees with the
 * wasm `SessionHandle.terrainHeightAt(x,y)` — the reference implementation the
 * JS split-diagonal port exists to match — within `tolerance`.
 *
 * Returns a report object; `pass` is false with a `reason` when it could not
 * run (no oracle, no session handle, no resident landblocks) so a probe can
 * tell "not ready" from "wrong".
 */
export async function terrainVfxOracleSelfTest(options = {}) {
  // The oracle is loaded ON DEMAND (see `ensureOracle`), and a session with no
  // family provider registered has never needed it — so pull it in here rather
  // than reporting "idle" at the one call site whose whole job is to prove it
  // works. Resolves to null if Wave 0A is genuinely absent.
  try { await ensureOracle(); } catch (_) { /* reported as `oracle absent` below */ }
  return terrainVfxOracleSelfTestSync(options);
}

/** The synchronous core. Assumes the oracle is already resolved. */
export function terrainVfxOracleSelfTestSync(options = {}) {
  const samples = Number.isFinite(options.samples) ? Math.max(1, options.samples | 0) : 500;
  const tolerance = Number.isFinite(options.tolerance) ? options.tolerance : 1e-3;
  const seed = Number.isFinite(options.seed) ? options.seed >>> 0 : 0xac1e5701;

  if (!_oracle) {
    return { pass: false, reason: `oracle ${_oracleState} (scene3d/terrain_oracle.js — Wave 0A)`, samples: 0 };
  }
  const sh = options.sessionHandle
    || _spine?.scene3d?.sessionHandle
    || (typeof window !== "undefined" ? window.__sessionHandle : null);
  if (!sh || typeof sh.terrainHeightAt !== "function") {
    return { pass: false, reason: "no SessionHandle.terrainHeightAt", samples: 0 };
  }
  const lbs = [];
  for (const [lbKey, e] of _tracked) if (!e.parked) lbs.push([lbKey, e]);
  if (lbs.length === 0) {
    // Fall back to the parked set — the oracle is supposed to survive park, and
    // proving that live is half the point of this check.
    for (const [lbKey, e] of _tracked) lbs.push([lbKey, e]);
  }
  if (lbs.length === 0) return { pass: false, reason: "no landblocks tracked", samples: 0 };

  const rng = makeSeededRng(seed);
  let compared = 0;
  let oracleMisses = 0;
  let wasmMisses = 0;
  let maxErr = 0;
  let failures = 0;
  const worst = [];
  for (let i = 0; i < samples; i += 1) {
    const [, e] = lbs[(rng() * lbs.length) | 0];
    // ⚠ `Math.fround` is LOAD-BEARING (0A, 2026-07-31). The wasm binding takes
    // the coords as f32, so a raw f64 sample point is silently rounded on the
    // way in — at Dereth's ~40 km coordinates one f32 ULP is ~4 mm, and on a
    // sloped cell that alone reads as |Δz| ≈ 1.95e-3, i.e. a FALSE FAILURE
    // against the plan's 1e-3 bar. Sampling both sides at the same f32 point
    // takes the max error to ~9e-6 and makes this a real test of the JS
    // split-diagonal port rather than of float width.
    const x = Math.fround(e.lbX * METERS_PER_LANDBLOCK + rng() * METERS_PER_LANDBLOCK);
    const y = Math.fround(e.lbY * METERS_PER_LANDBLOCK + rng() * METERS_PER_LANDBLOCK);
    let s = null;
    try { s = _oracle.sample(x, y); } catch (_) { s = null; }
    if (!s || !Number.isFinite(s.height)) { oracleMisses += 1; continue; }
    let ref;
    try { ref = sh.terrainHeightAt(x, y); } catch (_) { ref = undefined; }
    if (!Number.isFinite(ref)) { wasmMisses += 1; continue; }
    compared += 1;
    const err = Math.abs(s.height - ref);
    if (err > maxErr) maxErr = err;
    if (err > tolerance) {
      failures += 1;
      if (worst.length < 8) worst.push({ x, y, oracle: s.height, wasm: ref, err });
    }
  }
  return {
    pass: compared > 0 && failures === 0,
    reason: compared === 0 ? "no point resolved in BOTH the oracle and wasm" : null,
    samples,
    compared,
    failures,
    maxErr,
    tolerance,
    oracleMisses,
    wasmMisses,
    landblocks: lbs.length,
    worst,
  };
}

function _installWindowSurface() {
  const surface = {
    stats: terrainVfxStats,
    oracleSelfTest: terrainVfxOracleSelfTest,
    ensureOracle,
    get oracle() { return _oracle; },
    get trail() { return _trail; },
    get providers() { return [..._providers.keys()]; },
    hooks: () => terrainVfxHookReport(_spine?.scene3d),
    // Manual seams for a headless probe.
    noteMesh: (m) => terrainVfxNoteLandblockMesh(_spine?.scene3d, m),
    tick: (dt) => terrainVfxTick(dt, _spine?.scene3d),
  };
  try {
    if (typeof window !== "undefined") window.__terrainVfx = surface;
  } catch (_) { /* fail-soft */ }
  return surface;
}
