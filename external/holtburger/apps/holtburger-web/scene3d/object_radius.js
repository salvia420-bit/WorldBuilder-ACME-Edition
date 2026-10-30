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

let _setting; // undefined = unread, null = off, else N
/**
 * `?objRadius=N` (integer 1..12) ⇒ N; `off`/`0`/`false`/`no` ⇒ null (objects on
 * the whole residency ring); absent or anything else ⇒ 4 (the default).
 */
export function objRadiusSetting() {
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
export function __setObjRadiusForTest(v) { _setting = v; }

const _stats = { hides: 0, shows: 0, nodesHidden: 0, nodesShown: 0, lateHides: 0, unparkRehides: 0, forgets: 0 };

function _lbKey(id) { return ((id >>> 0) & 0xffff0000) >>> 0; }
function _cheb(a, b) {
  return Math.max(Math.abs(((a >>> 24) & 0xff) - ((b >>> 24) & 0xff)),
    Math.abs(((a >>> 16) & 0xff) - ((b >>> 16) & 0xff)));
}

function _state(scene3d) {
  let st = scene3d._objRadius;
  if (!st) {
    st = { hidden: new Set(), centers: [], sig: null };
    scene3d._objRadius = st;
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

/**
 * Bake gate for cells.js: may the statics/buildings hooks fire for `lbKey`,
 * given the player landblock set `seen`? Always true when the flag is off.
 */
export function objectBakeAllowed(seen, lbKey) {
  const n = objRadiusSetting();
  if (n == null) return true;
  for (const c of seen) if (_cheb(c, lbKey) <= n) return true;
  return false;
}

function _forEachTopNode(scene3d, lbKey, fn) {
  for (const grp of [scene3d.staticsGroup, scene3d.buildingsGroup]) {
    const kids = grp?.children;
    if (!kids) continue;
    for (const c of kids) {
      const lb = c.userData?.landblockId;
      if (lb != null && _lbKey(lb) === lbKey) fn(c);
    }
  }
}

function _isParked(scene3d, lbKey) {
  try { return scene3d.landblockLru?.isParked?.(lbKey) === true; } catch (_) { return false; }
}

function _hide(scene3d, st, lbKey) {
  let n = 0;
  _forEachTopNode(scene3d, lbKey, (c) => {
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
  _forEachTopNode(scene3d, lbKey, (c) => {
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
  try { scene3d._poolShowLb?.(lbKey); } catch (_) { /* fail-soft */ }
  _stats.forgets += 1;
  globalThis.__hbRustWorld?.objrForget(scene3d, lbKey); // ?rustWorld
}

/**
 * Re-evaluate every object-baked landblock against the player's centre set.
 * Cheap to call every frame: it returns at once unless the centre set (the
 * landblock-crossing signal) changed.
 */
export function tickObjectRadius(scene3d, seen) {
  const n = objRadiusSetting();
  if (n == null || !scene3d) return;
  const st = _state(scene3d);
  let sig = "";
  for (const k of seen) sig += k + ",";
  if (sig === st.sig) return;
  st.sig = sig;
  st.centers = [...seen];
  const keys = new Set();
  if (scene3d.staticsBakedLbs instanceof Set) for (const k of scene3d.staticsBakedLbs) keys.add(k >>> 0);
  if (scene3d.buildingsBakedLbs instanceof Set) for (const k of scene3d.buildingsBakedLbs) keys.add(k >>> 0);
  // Evicted landblocks leave both baked sets; forget them (their nodes are gone,
  // and the pool registry's copy of the hide lifts with them: `_forget`).
  for (const k of st.hidden) if (!keys.has(k)) _forget(scene3d, st, k);
  for (const k of keys) {
    const d = _dist(st, k);
    if (d > n + 1) {
      if (!st.hidden.has(k)) _hide(scene3d, st, k);
    } else if (d <= n && st.hidden.has(k)) {
      _show(scene3d, st, k);
    }
  }
}

/** A statics/buildings bake for `lbKey` just attached its nodes. */
export function afterObjectBake(scene3d, lbKey) {
  const n = objRadiusSetting();
  if (n == null || !scene3d) return;
  const st = _state(scene3d);
  const k = _lbKey(lbKey);
  if (st.centers.length === 0) return;
  const d = _dist(st, k);
  // Hide on arrival when outside the band, and re-hide a hidden landblock so
  // the nodes this bake added are covered too (idempotent per node/instance).
  if (d > n + 1 || st.hidden.has(k)) {
    _hide(scene3d, st, k);
    _stats.lateHides += 1;
  }
}

/** Warm-park just re-showed `lbKey`'s bucket/atlas instances. */
export function afterUnpark(scene3d, lbKey) {
  if (objRadiusSetting() == null || !scene3d) return;
  const st = _state(scene3d);
  const k = _lbKey(lbKey);
  if (!st.hidden.has(k)) {
    // Shown while it was parked: its detached nodes missed the restore.
    _forEachTopNode(scene3d, k, (c) => {
      if (c.userData.__objRadiusHidden) { c.visible = true; delete c.userData.__objRadiusHidden; _stats.nodesShown += 1; }
    });
    return;
  }
  // Park detached the nodes, so a hide while parked could not reach them, and
  // unpark re-showed the bucket/atlas instances: hide everything again.
  _hide(scene3d, st, k);
  _stats.unparkRehides += 1;
}

/** Is `lbKey`'s object set currently hidden by the near radius? */
export function objectRadiusHides(scene3d, lbKey) {
  const st = scene3d?._objRadius;
  return !!st && st.hidden.has(_lbKey(lbKey));
}

export function getObjectRadiusStats(scene3d) {
  const st = scene3d?._objRadius;
  return { radius: objRadiusSetting(), hiddenLbs: st ? st.hidden.size : 0, ..._stats };
}
export function __resetObjectRadiusStatsForTest() {
  for (const k in _stats) _stats[k] = 0;
}
