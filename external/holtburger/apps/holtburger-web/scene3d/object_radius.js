// scene3d/object_radius.js — ?objRadius=N: a near radius for OBJECTS (statics +
// buildings), separate from the terrain ring (perf T7, OpenAC comparison
// 2026-10-04, docs/openac-comparison-2026-10-04/5-perf.md).
//
// WHY. One residency radius (`RESIDENCY_RADIUS_LB` = 5, an 11x11 ring) drives
// terrain, statics and buildings alike. OpenAC splits it in two: objects use a
// NEAR radius and terrain alone a FAR one (presets Low 2/5, Med 3/8, High 4/12,
// Ultra 5/15 — QualityPreset.cs:22-26; the far tier is "heightmap only, no
// entity layer"). Resident object population scales with ring AREA: radius 4
// keeps 81/121 = 67% of it, radius 3 keeps 49/121 = 40%, and so do the
// per-instance walk terms and the bake churn per landblock crossing.
//
// FIDELITY (corrected 2026-10-30, round-3 plan R3-2 / lessons L4; checked in
// acclient.c by symbol). Retail builds statics, buildings and scenery ONLY on
// the 3x3 full-detail ring around the viewer's landblock (9 landblocks),
// whatever the landscape radius (LScape::SetMidRadius; the graphics presets
// use mid_radius 3..15, the LScape constructor 5 = an 11x11 grid):
//   * LScape::get_block_orient gives a block size 1 (8x8 cells, full detail)
//     only at Chebyshev distance <= 1 from the grid centre; 2 at distance 2,
//     4 at 3..4 and 8 beyond, which are terrain-only.
//   * LScape::grab_visible_cells calls CLandBlock::init_buildings and
//     CLandBlock::init_static_objs on every block of the grid, and each does
//     nothing unless `side_cell_count == 8` (8 / size, so size 1). The
//     procedural scenery (CLandBlock::get_land_scenes, under
//     `use_scene_files`) is built inside init_static_objs's gate.
//   * LScape::update_block calls CLandBlock::notify_change_size when a block
//     with side_cell_count 8 gets a size other than 1, and that releases its
//     land cells' objects and destroys its static objects and buildings
//     (release_objs, destroy_static_objects, destroy_buildings).
// So `?objRadius=1` bakes the retail ring (its hide hysteresis keeps a
// landblock that drifts to d=2 visible until d=3, which retail does not). The
// default of 4 (81 landblocks) is a BEYOND-RETAIL horizon copied from OpenAC's
// High near tier (OpenAC goes past retail on purpose, ObjectRingLimit = 4).
// `?objRadius=off` puts objects on the whole residency ring (11x11 by default,
// ?pvsRingRadius), which is not retail either; then every function here is a
// no-op and the ring behaves exactly as before this module. The default stays
// 4 until the owner rules on the M1 objRadius arms (round-3 plan decision (g)).
//
// WHAT IT DOES (Chebyshev landblock distance d to the player's landblock[s]):
//   * BAKE GATE — cells.js fires the statics and buildings hooks only for
//     d <= N. Terrain still fills the whole ring, so the far band is
//     terrain-only and never pays an object bake at all.
//   * HIDE with spatial hysteresis — an object-baked landblock that falls to
//     d > N + 1 has its objects hidden; it shows again at d <= N (OpenAC
//     unloads at radius + 2 for the same reason: a player pacing a landblock
//     line must not flip it every few seconds). Hidden means:
//       - its top-level staticsGroup / buildingsGroup nodes get visible=false
//         (only nodes WE hid are flagged and restored, so a node something
//         else hid stays hidden);
//       - its instances in the shared ?statBatchChunk buckets and the
//         cross-LB atlas are hidden through the same setVisibleAt seams that
//         warm-park uses (membership kept, nothing deleted);
//       - animated scenery collapses an instanced prop whose anchor is hidden
//         (animated_scenery.js reads the anchor's visible chain).
//     Memory for a hidden landblock's objects is released only when the
//     whole landblock is evicted, as before — per-kind eviction would mean
//     splitting the LRU's mixed disposables lists; out of scope here.
//   * CONSISTENCY — a late bake landing for a landblock that should be hidden
//     is hidden on arrival (index.js loader wrappers call `afterObjectBake`),
//     and warm-park's unpark, which re-shows bucket/atlas instances, is
//     followed by `afterUnpark`, which re-hides them if the landblock is
//     still outside the radius.

const OBJ_RADIUS_MIN = 1;   // the player's neighbours always keep their objects (= retail's 3x3)
const OBJ_RADIUS_MAX = 12;  // matches ?pvsRingRadius's ceiling
const OBJ_RADIUS_DEFAULT = 4; // beyond retail (see FIDELITY); unchanged until decision (g)
export const DEFAULT_OBJ_RADIUS = OBJ_RADIUS_DEFAULT;
export const DEFAULT_BLD_RADIUS = 5; // 960–1152 m for buildings (full 6×6 SlotGrid / 11×11 ring)

let _setting; // undefined = unread, null = off, else N
let _testOverride; // undefined = none, else test value
let _bldTestOverride; // undefined = none, else test value
/**
 * `?objRadius=N` (integer 1..12) ⇒ N; `off`/`0`/`false`/`no` ⇒ null (objects on
 * the whole residency ring); absent or anything else ⇒ 4 (the default).
 */
export function objRadiusSetting() {
  if (_testOverride !== undefined) return _testOverride;
  if (_setting !== undefined) return _setting;
  let n = OBJ_RADIUS_DEFAULT;
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      const raw = (new URLSearchParams(globalThis.location.search).get("objRadius") || "").trim().toLowerCase();
      if (raw === "off" || raw === "0" || raw === "false" || raw === "no") n = null;
      else if (/^[0-9]+$/.test(raw)) {
        const v = Number(raw);
        if (v >= OBJ_RADIUS_MIN && v <= OBJ_RADIUS_MAX) n = v;
      }
    }
  } catch (_) { n = OBJ_RADIUS_DEFAULT; }
  _setting = n;
  return n;
}
/** Test seam: a number arms it, null disarms, undefined re-reads the URL. */
export function __setObjRadiusForTest(v) { _testOverride = v; _setting = v; }
export function __setBldRadiusForTest(v) { _bldTestOverride = v; }

// ?flightView (altitude_policy.js, flight experience Phase 3): the window narrows with altitude (from 1.5 km up a
// tree is a few pixels and the far-forest impostors carry it). A policy radius never WIDENS the page's setting and
// never applies when the setting is off (null). Setting it forces one re-evaluation on the next tick.
let _policyRadius = null;
let _policyBldRadius = null;
export function setObjRadiusPolicy(n, scene3d = null) {
  const v = Number.isFinite(n) ? Math.max(OBJ_RADIUS_MIN, Math.min(OBJ_RADIUS_MAX, n | 0)) : null;
  if (v === _policyRadius) return false;
  _policyRadius = v;
  if (scene3d?._objRadius) scene3d._objRadius.sig = null;
  return true;
}
export function setBldRadiusPolicy(n, scene3d = null) {
  const v = Number.isFinite(n) ? Math.max(OBJ_RADIUS_MIN, Math.min(OBJ_RADIUS_MAX, n | 0)) : null;
  if (v === _policyBldRadius) return false;
  _policyBldRadius = v;
  if (scene3d?._objRadius) {
    scene3d._objRadius.policyBldRadius = v;
    scene3d._objRadius.sig = null;
  }
  return true;
}
export function bldRadiusSetting() {
  if (_bldTestOverride !== undefined) {
    if (_bldTestOverride == null) return null;
    return _policyBldRadius == null ? _bldTestOverride : Math.min(_bldTestOverride, _policyBldRadius);
  }
  if (_testOverride !== undefined) {
    if (_testOverride == null) return null;
    return _policyBldRadius == null ? _testOverride : Math.min(_testOverride, _policyBldRadius);
  }
  let n = DEFAULT_BLD_RADIUS;
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      const ps = new URLSearchParams(globalThis.location.search);
      const rawBld = (ps.get("bldRadius") || "").trim().toLowerCase();
      const rawObj = (ps.get("objRadius") || "").trim().toLowerCase();
      const raw = rawBld || rawObj;
      if (raw === "off" || raw === "0" || raw === "false" || raw === "no") n = null;
      else if (/^[0-9]+$/.test(raw)) {
        const v = Number(raw);
        if (v >= OBJ_RADIUS_MIN && v <= OBJ_RADIUS_MAX) n = v;
      }
    }
  } catch (_) { n = DEFAULT_BLD_RADIUS; }
  if (n == null) return null;
  return _policyBldRadius == null ? n : Math.min(n, _policyBldRadius);
}
function _effectiveRadius() {
  const n = objRadiusSetting();
  if (n == null) return null;
  return _policyRadius == null ? n : Math.min(n, _policyRadius);
}
function _effectiveBldRadius() {
  return bldRadiusSetting();
}

const _stats = { hides: 0, shows: 0, nodesHidden: 0, nodesShown: 0, lateHides: 0, unparkRehides: 0, forgets: 0,
  fadeHides: 0, fadeCancels: 0, fadeCommits: 0 };

// ?lbFade (flight experience Phase 1, scene3d/lb_presence.js): with the presence fade armed, a hide at the
// window edge is DEFERRED — the landblock goes to `pendingHide`, its object presence fades to 0 over ~0.5 s,
// and only then does the presence field call `objRadiusCommitHide`, which runs the real hide below. A
// landblock that comes back to d <= N while fading is simply taken off `pendingHide` (it fades back in). Off:
// every hide is the immediate toggle it always was.
let _fadeDeferred = false;
/** index.js arms this once when `?lbFade` is on. */
export function setObjRadiusFadeDeferred(on) { _fadeDeferred = !!on; }

function _lbKey(id) { return ((id >>> 0) & 0xffff0000) >>> 0; }
function _cheb(a, b) {
  return Math.max(Math.abs(((a >>> 24) & 0xff) - ((b >>> 24) & 0xff)),
    Math.abs(((a >>> 16) & 0xff) - ((b >>> 16) & 0xff)));
}

function _state(scene3d) {
  let st = scene3d._objRadius;
  if (!st) {
    st = { hidden: new Set(), hiddenBld: new Set(), pendingHide: new Set(), centers: [], sig: null, policyBldRadius: _policyBldRadius };
    scene3d._objRadius = st;
  } else if (!(st.hiddenBld instanceof Set)) {
    st.hiddenBld = new Set();
  }
  return st;
}

/** Distance from `lbKey` to the nearest current centre landblock (Infinity if none). */
function _dist(st, lbKey) {
  let best = Infinity;
  for (const c of st.centers) {
    const d = _cheb(c, lbKey);
    if (d < best) best = d;
  }
  return best;
}

function _bakeAllowedWithRadius(n, a, b) {
  if (n == null) return true;
  if (a == null || b == null) return true;
  if (typeof a === "number" && typeof b === "number") {
    if (a === 0 || b === 0) return true;
    return _cheb(a, b) <= n;
  }
  if (typeof a === "number" && typeof b[Symbol.iterator] === "function") {
    for (const c of b) if (_cheb(c, a) <= n) return true;
    return false;
  }
  if (typeof b === "number" && typeof a[Symbol.iterator] === "function") {
    for (const c of a) if (_cheb(c, b) <= n) return true;
    return false;
  }
  return true;
}

/**
 * Bake gate for cells.js / index.js: may the statics hooks fire for `lbKey`,
 * given the player landblock set `seen` (or `(lbKey, centerLbKey)`)? Always true when the flag is off.
 */
export function objectBakeAllowed(a, b) {
  return _bakeAllowedWithRadius(_effectiveRadius(), a, b);
}

/**
 * Decoupled bake gate for buildings (`DEFAULT_BLD_RADIUS = 5`, narrowed at high altitude via `bldRadiusForAgl`).
 * Accepts either `(seen, lbKey)` or `(lbKey, centerLbKey)`.
 */
export function buildingBakeAllowed(a, b) {
  return _bakeAllowedWithRadius(_effectiveBldRadius(), a, b);
}

function _forEachGroupNode(grp, lbKey, fn) {
  const kids = grp?.children;
  if (!kids) return;
  for (const c of kids) {
    const lb = c.userData?.landblockId;
    if (lb != null && _lbKey(lb) === lbKey) fn(c);
  }
}

function _isParked(scene3d, lbKey) {
  try { return scene3d.landblockLru?.isParked?.(lbKey) === true; } catch (_) { return false; }
}

function _hide(scene3d, st, lbKey) {
  let n = 0;
  _forEachGroupNode(scene3d.staticsGroup, lbKey, (c) => {
    if (c.visible) { c.visible = false; c.userData.__objRadiusHidden = true; n += 1; }
  });
  try { scene3d._parkStaticBatchXForLb?.(lbKey); } catch (_) { /* fail-soft */ }
  try { scene3d._parkStaticAtlasForLb?.(lbKey); } catch (_) { /* fail-soft */ }
  // 2026-10-25: draw pools hold members of many landblocks per tile; the
  // registry keeps a sticky per-landblock hide (pool_registry.js hideLb).
  try { scene3d._poolHideLb?.(lbKey); } catch (_) { /* fail-soft */ }
  if (!st.hidden.has(lbKey)) { st.hidden.add(lbKey); _stats.hides += 1; }
  _stats.nodesHidden += n;
  globalThis.__hbRustWorld?.objrHide(scene3d, lbKey); // ?rustWorld shadow (scene3d/rust/world.js)
}

function _show(scene3d, st, lbKey) {
  let n = 0;
  _forEachGroupNode(scene3d.staticsGroup, lbKey, (c) => {
    if (c.userData.__objRadiusHidden) { c.visible = true; delete c.userData.__objRadiusHidden; n += 1; }
  });
  // Pools: the registry's sticky hide lifts here; it re-shows only instances
  // of LIVE tiles outside the cell PVS's hidden set (tile parking stays its own).
  try { scene3d._poolShowLb?.(lbKey); } catch (_) { /* fail-soft */ }
  // A parked landblock's bucket/atlas instances stay hidden: park owns them,
  // and its unpark shows them (then `afterUnpark` consults us again).
  if (!_isParked(scene3d, lbKey)) {
    try { scene3d._unparkStaticBatchXForLb?.(lbKey); } catch (_) { /* fail-soft */ }
    try { scene3d._unparkStaticAtlasForLb?.(lbKey); } catch (_) { /* fail-soft */ }
  }
  st.hidden.delete(lbKey);
  _stats.shows += 1;
  _stats.nodesShown += n;
  globalThis.__hbRustWorld?.objrShow(scene3d, lbKey); // ?rustWorld
}

function _hideBld(scene3d, st, lbKey) {
  let n = 0;
  _forEachGroupNode(scene3d.buildingsGroup, lbKey, (c) => {
    if (c.visible) { c.visible = false; c.userData.__objRadiusHidden = true; n += 1; }
  });
  st.hiddenBld.add(lbKey);
  _stats.nodesHidden += n;
}

function _showBld(scene3d, st, lbKey) {
  let n = 0;
  _forEachGroupNode(scene3d.buildingsGroup, lbKey, (c) => {
    if (c.userData.__objRadiusHidden) { c.visible = true; delete c.userData.__objRadiusHidden; n += 1; }
  });
  st.hiddenBld.delete(lbKey);
  _stats.nodesShown += n;
}

// An evicted landblock left both baked sets: drop it from the hidden set (its
// nodes are gone) AND lift the pool registry's own sticky copy of the hide.
// 2026-10-29 (lane W review r2): the forget used to drop only `st.hidden`, and
// `showLb` is the registry's only way out of `_hiddenLbs`, so a landblock
// hidden for distance, released and re-baked inside the radius committed its
// pooled members hidden for good (`_show` never ran: `st.hidden` no longer had
// it). Safe on the grid path: a landblock leaves the baked sets only through a
// grid release of a PARKED tile, so `showLb` finds the tile parked (live=false)
// or gone and flips nothing; it only drops the stale mark (and posts
// POOL_SHOW_LB, which keeps the ?rustWorld mirror in step). No registry (chain
// off): `_poolShowLb` returns 0. `st.hidden` is cleared FIRST (as before).
function _forget(scene3d, st, lbKey) {
  st.hidden.delete(lbKey);
  st.hiddenBld?.delete(lbKey);
  st.pendingHide?.delete(lbKey);
  try { scene3d._poolShowLb?.(lbKey); } catch (_) { /* fail-soft */ }
  _stats.forgets += 1;
  globalThis.__hbRustWorld?.objrForget(scene3d, lbKey); // ?rustWorld
}

/**
 * Re-evaluate every object-baked landblock against the player's centre set.
 * Cheap to call every frame: it returns at once unless the centre set (the
 * landblock-crossing signal) or effective radii changed.
 */
export function tickObjectRadius(scene3d, seen) {
  const n = _effectiveRadius();
  const nb = _effectiveBldRadius();
  if ((n == null && nb == null) || !scene3d) return;
  const st = _state(scene3d);
  const iter = typeof seen === "number" ? [seen >>> 0] : seen;
  let sig = `${n},${nb}:`;
  for (const k of iter) sig += k + ",";
  if (sig === st.sig) return;
  st.sig = sig;
  st.centers = [...iter];
  const keys = new Set();
  if (scene3d.staticsBakedLbs instanceof Set) for (const k of scene3d.staticsBakedLbs) keys.add(k >>> 0);
  if (scene3d.buildingsBakedLbs instanceof Set) for (const k of scene3d.buildingsBakedLbs) keys.add(k >>> 0);
  // Evicted landblocks leave both baked sets; forget them (their nodes are gone,
  // and the pool registry's copy of the hide lifts with them: `_forget`).
  for (const k of st.hidden) if (!keys.has(k)) _forget(scene3d, st, k);
  for (const k of st.hiddenBld) if (!keys.has(k)) st.hiddenBld.delete(k);
  for (const k of st.pendingHide) if (!keys.has(k)) st.pendingHide.delete(k);
  for (const k of keys) {
    const d = _dist(st, k);
    if (n != null) {
      if (d > n + 1) {
        if (!st.hidden.has(k)) {
          if (_fadeDeferred) {
            if (!st.pendingHide.has(k)) { st.pendingHide.add(k); _stats.fadeHides += 1; }
          } else {
            _hide(scene3d, st, k);
          }
        }
      } else if (d <= n) {
        if (st.pendingHide.has(k)) {
          st.pendingHide.delete(k);
          _stats.fadeCancels += 1;
        } else if (st.hidden.has(k)) {
          _show(scene3d, st, k);
        }
      }
    }
    if (nb != null) {
      if (d > nb + 1) {
        if (!st.hiddenBld.has(k)) _hideBld(scene3d, st, k);
      } else if (d <= nb) {
        if (st.hiddenBld.has(k)) _showBld(scene3d, st, k);
      }
    }
  }
}
export const tickObjectRadiusVisibility = tickObjectRadius;

/**
 * ?lbFade: the presence fade-out of `lbKey`'s objects reached 0 — run the deferred hide now (no-op unless the
 * landblock is still pending; a cancel or an eviction already took it off the list).
 */
export function objRadiusCommitHide(scene3d, lbKey) {
  const st = scene3d?._objRadius;
  if (!st || !st.pendingHide) return false;
  const k = _lbKey(lbKey);
  if (!st.pendingHide.has(k)) return false;
  st.pendingHide.delete(k);
  if (!st.hidden.has(k)) _hide(scene3d, st, k);
  _stats.fadeCommits += 1;
  return true;
}

/** ?lbFade: does the window want `lbKey`'s objects gone (hidden, or fading out toward the deferred hide)? */
export function objectRadiusWantsHidden(scene3d, lbKey) {
  const st = scene3d?._objRadius;
  if (!st) return false;
  const k = _lbKey(lbKey);
  return st.hidden.has(k) || (st.pendingHide ? st.pendingHide.has(k) : false);
}

/** A statics/buildings bake for `lbKey` just attached its nodes. */
export function afterObjectBake(scene3d, lbKey) {
  const n = _effectiveRadius();
  const nb = _effectiveBldRadius();
  if ((n == null && nb == null) || !scene3d) return;
  const st = _state(scene3d);
  const k = _lbKey(lbKey);
  if (st.centers.length === 0) return;
  const d = _dist(st, k);
  // Hide on arrival when outside the band, and re-hide a hidden landblock so
  // the nodes this bake added are covered too (idempotent per node/instance).
  if (n != null && (d > n + 1 || st.hidden.has(k))) {
    _hide(scene3d, st, k);
    _stats.lateHides += 1;
  }
  if (nb != null && (d > nb + 1 || st.hiddenBld.has(k))) {
    _hideBld(scene3d, st, k);
  }
}

/** Warm-park just re-showed `lbKey`'s bucket/atlas instances. */
export function afterUnpark(scene3d, lbKey) {
  if ((objRadiusSetting() == null && bldRadiusSetting() == null) || !scene3d) return;
  const st = _state(scene3d);
  const k = _lbKey(lbKey);
  if (!st.hidden.has(k)) {
    // Shown while it was parked: its detached nodes missed the restore.
    _forEachGroupNode(scene3d.staticsGroup, k, (c) => {
      if (c.userData.__objRadiusHidden) { c.visible = true; delete c.userData.__objRadiusHidden; _stats.nodesShown += 1; }
    });
  } else {
    // Park detached the nodes, so a hide while parked could not reach them, and
    // unpark re-showed the bucket/atlas instances: hide everything again.
    _hide(scene3d, st, k);
    _stats.unparkRehides += 1;
  }
  if (!st.hiddenBld.has(k)) {
    _forEachGroupNode(scene3d.buildingsGroup, k, (c) => {
      if (c.userData.__objRadiusHidden) { c.visible = true; delete c.userData.__objRadiusHidden; _stats.nodesShown += 1; }
    });
  } else {
    _hideBld(scene3d, st, k);
  }
}

/** Is `lbKey`'s object set currently hidden by the near radius? */
export function objectRadiusHides(a, b) {
  if (a && typeof a === "object") {
    const st = a._objRadius;
    return !!st && st.hidden.has(_lbKey(b));
  }
  if (b && typeof b === "object") {
    const st = b._objRadius;
    return !!st && st.hidden.has(_lbKey(a));
  }
  if (typeof a === "number" && typeof b === "number") {
    if (b === 0) return false;
    const n = _effectiveRadius();
    if (n == null) return false;
    return _cheb(a, b) > n + 1;
  }
  return false;
}

/** Is `lbKey`'s building set currently hidden by the building radius? */
export function buildingRadiusHides(a, b) {
  if (a && typeof a === "object") {
    const st = a._objRadius;
    return !!st && st.hiddenBld instanceof Set && st.hiddenBld.has(_lbKey(b));
  }
  if (b && typeof b === "object") {
    const st = b._objRadius;
    return !!st && st.hiddenBld instanceof Set && st.hiddenBld.has(_lbKey(a));
  }
  if (typeof a === "number" && typeof b === "number") {
    if (b === 0) return false;
    const nb = _effectiveBldRadius();
    if (nb == null) return false;
    return _cheb(a, b) > nb + 1;
  }
  return false;
}

export function getObjectRadiusStats(scene3d) {
  const st = scene3d?._objRadius;
  return {
    radius: objRadiusSetting(),
    bldRadius: bldRadiusSetting(),
    policyRadius: _policyRadius,
    policyBldRadius: _policyBldRadius,
    hiddenLbs: st ? st.hidden.size : 0,
    hiddenBldLbs: st?.hiddenBld ? st.hiddenBld.size : 0,
    pendingHideLbs: st?.pendingHide ? st.pendingHide.size : 0,
    fadeDeferred: _fadeDeferred,
    ..._stats,
  };
}
export function __resetObjectRadiusStatsForTest() {
  for (const k in _stats) _stats[k] = 0;
}
