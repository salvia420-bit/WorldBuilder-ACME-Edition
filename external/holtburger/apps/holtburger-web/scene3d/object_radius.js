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
// FIDELITY. Retail draws objects across the whole `mid_width = 11` grid, so
// this is an OPT-IN knob for weaker machines, not a default. Absent ⇒ every
// function here is a no-op and the ring behaves exactly as before.
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

const OBJ_RADIUS_MIN = 1;   // the player's neighbours always keep their objects
const OBJ_RADIUS_MAX = 12;  // matches ?pvsRingRadius's ceiling

let _setting; // undefined = unread, null = off, else N
/** `?objRadius=N` (integer 1..12) ⇒ N; anything else ⇒ null (off, the default). */
export function objRadiusSetting() {
  if (_setting !== undefined) return _setting;
  let n = null;
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      const raw = new URLSearchParams(globalThis.location.search).get("objRadius") || "";
      if (/^[0-9]+$/.test(raw)) {
        const v = Number(raw);
        if (v >= OBJ_RADIUS_MIN && v <= OBJ_RADIUS_MAX) n = v;
      }
    }
  } catch (_) { n = null; }
  _setting = n;
  return n;
}
/** Test seam: a number arms it, null disarms, undefined re-reads the URL. */
export function __setObjRadiusForTest(v) { _setting = v; }

const _stats = { hides: 0, shows: 0, nodesHidden: 0, nodesShown: 0, lateHides: 0, unparkRehides: 0 };

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
  if (!st.hidden.has(lbKey)) { st.hidden.add(lbKey); _stats.hides += 1; }
  _stats.nodesHidden += n;
}

function _show(scene3d, st, lbKey) {
  let n = 0;
  _forEachTopNode(scene3d, lbKey, (c) => {
    if (c.userData.__objRadiusHidden) { c.visible = true; delete c.userData.__objRadiusHidden; n += 1; }
  });
  // A parked landblock's bucket/atlas instances stay hidden: park owns them,
  // and its unpark shows them (then `afterUnpark` consults us again).
  if (!_isParked(scene3d, lbKey)) {
    try { scene3d._unparkStaticBatchXForLb?.(lbKey); } catch (_) { /* fail-soft */ }
    try { scene3d._unparkStaticAtlasForLb?.(lbKey); } catch (_) { /* fail-soft */ }
  }
  st.hidden.delete(lbKey);
  _stats.shows += 1;
  _stats.nodesShown += n;
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
  // Evicted landblocks leave both baked sets; forget them (their nodes are gone).
  for (const k of st.hidden) if (!keys.has(k)) st.hidden.delete(k);
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
