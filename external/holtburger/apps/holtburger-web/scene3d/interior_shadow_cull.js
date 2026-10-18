// scene3d/interior_shadow_cull.js — interior rooms cast no sun shadows while
// the camera is OUTDOORS (`?interiorShadowCull`, DEFAULT ON, `=off` escape).
// Perf 2026-10-17 (outdoor fps wave 1, card "interiors").
//
// WHY. From an outdoor camera the visibility tick draws every interior cell the
// render set admits (doorway cells, the ?stablist SeenOutside rooms the
// ?occlusionCull boxes did not reject), and every one of those meshes was built
// `castShadow = true`. So each shadow raster re-drew them into all three CSM
// cascades. MEASURED (GTX 1070, quality=ultra, LB 0xE632, player outdoors by a
// multi-storey pagoda, 2026-10-17): the interior rooms in view cost 141 world
// draws + 54 shadow draws a frame; "SHADOW / cells" was ~0.1 ms of GPU in the
// per-draw census. The raster ran on 46 % of frames at ~31 µs of main-thread
// submission per shadow draw (12.1 ms / 390 draws), so the 54 are ~1.7 ms on a
// raster frame (~0.8 ms averaged) — an ESTIMATE from those two measurements.
//
// They buy nothing out there. The building SHELL (buildings.js, castShadow per
// material) is what shadows the landscape and the interior seen through a
// doorway; an interior wall or floor sits inside that shell, so its shadow
// lands inside the shell's own. Retail has no shadow maps at all. When the
// camera goes INDOORS (the viewer cell is an EnvCell) the rooms cast again,
// exactly as built: upper floors over lower ones, furniture on floors.
//
// HOW. Lazily, per visible cell container, from the visibility tick's own
// per-frame loop: a container whose stamp (mode + direct child count) does not
// match the wanted mode has its subtree's Mesh `castShadow` set to `false`
// (outdoors) or restored to the value it was BUILT with (`userData.__baseCast`,
// captured on first touch). Hidden containers draw no shadow at all (three and
// shadow_caster_list.js skip `visible === false` subtrees), so syncing only the
// containers that are visible this frame is complete: a cell that becomes
// visible later is synced on the frame it does. The child-count half of the
// stamp catches props attached after the walls (?interiorWallsFirst staging,
// the animated-scenery builder's nodes, the re-frozen fallbacks).
//
// When a sync changed any caster, the caller forces one shadow-map raster
// (`shadowMap.needsUpdate = true`): lighting.js's RP5 static-shadow gate would
// otherwise keep showing the old casters until its next trigger (≤ 12 frames).
// Under the per-light ?shadowMoverScope gate (lighting.js
// applyMoverScopedShadowGate, default on) that flag alone rasters NOTHING:
// every managed light has `shadow.autoUpdate = false`, and three skips a light
// whose `needsUpdate` is false too. So each managed light is marked as well,
// with the STATIC reason, so ?shadowStaticCache re-rasters its cached statics
// instead of overlaying the pre-flip ones.
//
// Live A/B seam: `window.__interiorShadowCull.off = true` restores the built
// casters on the next tick (stats under `.stats`).

const FLAG = (() => {
  try {
    const v = (new URLSearchParams(globalThis.location?.search || "").get("interiorShadowCull") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
})();

const ctl = { off: false };
const stats = {
  castOn: null,     // last mode applied (true = built casters, false = none)
  syncs: 0,         // container subtree syncs (cumulative)
  meshesFlipped: 0, // Mesh castShadow writes (cumulative)
  rasters: 0,       // shadow rasters forced because a VISIBLE caster changed
};

export function interiorShadowCullEnabled() {
  return FLAG;
}

/**
 * Should interior cells cast this frame? `viewerIndoor` is the visibility
 * tick's camera-cell verdict (`isIndoor` in cells.js tickCellVisibility3D).
 */
export function interiorCastWanted(viewerIndoor) {
  if (!FLAG || ctl.off) return true;
  return !!viewerIndoor;
}

/**
 * Bring one cell container's casters to `castOn`. Returns true when any Mesh's
 * `castShadow` actually changed. O(1) when the container is already stamped.
 * @param {import("three").Object3D} container
 * @param {boolean} castOn true = the casters it was built with, false = none
 */
export function syncCellShadowCast(container, castOn) {
  const ud = container?.userData;
  if (!ud) return false;
  const n = container.children ? container.children.length : 0;
  if (ud.__castOn === castOn && ud.__castN === n) return false;
  let changed = false;
  container.traverse((o) => {
    if (!o.isMesh) return;
    const oud = o.userData || (o.userData = {});
    if (oud.__baseCast === undefined) oud.__baseCast = o.castShadow === true;
    const want = castOn ? oud.__baseCast : false;
    if (o.castShadow !== want) {
      o.castShadow = want;
      changed = true;
      stats.meshesFlipped += 1;
    }
  });
  ud.__castOn = castOn;
  ud.__castN = n;
  stats.syncs += 1;
  stats.castOn = castOn;
  return changed;
}

// shadow_caster_list.js SHADOW_REASON_STATIC (duplicated, as lighting.js does).
const SHADOW_REASON_STATIC = 2;

/**
 * One forced shadow raster, after a visible caster changed. Only touches a
 * renderer whose raster is manually driven (the RP5 gate set autoUpdate=false);
 * with three's default per-frame raster there is nothing to request.
 * `scene3d` carries the mover-scope gate's managed lights (`_shadowScope`).
 */
export function requestShadowRaster(renderer, scene3d = null) {
  const sm = renderer?.shadowMap;
  if (!sm || !sm.enabled || sm.autoUpdate !== false) return false;
  const scope = scene3d?._shadowScope;
  if (scope && scope.renderer === renderer && Array.isArray(scope.lights)) {
    for (const l of scope.lights) {
      if (!l || !l.shadow) continue;
      l.shadow.needsUpdate = true;
      l.userData.hbShadowReason = (l.userData.hbShadowReason | 0) | SHADOW_REASON_STATIC;
    }
  }
  sm.needsUpdate = true;
  stats.rasters += 1;
  return true;
}

export function getInteriorShadowCullStats() {
  return { ...stats };
}

/** Test seam. */
export function __setInteriorShadowCullOffForTest(v) { ctl.off = !!v; }

if (typeof window !== "undefined") {
  try {
    window.__interiorShadowCull = {
      enabled: FLAG,
      stats,
      get off() { return ctl.off; },
      set off(v) { ctl.off = !!v; },
    };
  } catch (_) { /* fail-soft */ }
}
