// scene3d/terrain_hole_audit.js — 1 Hz self-heal for terrain holes (bug 5,
// 2026-10-07). Pure apart from the scene3d facade calls it is handed.
//
// Retail never shows a hole: `LScape::update_loadpoint` (acclient.c:308283)
// rescans EVERY slot of its fixed grid and rebuilds any that is NULL. HB's
// streaming is event-driven (ring sweep on landblock crossings, LRU reclaim,
// LOD re-bakes), so a block can fall between the cracks: parked by the LRU,
// refused by the bake guard (cooldown / cap) or left with a baked mark but no
// mesh. This audit is the retail rescan: once a second, every landblock inside
// the effective draw ring must have terrain; anything that does not is
// re-requested through the normal guarded loader (which unparks a parked
// block on its fast path, and rate-limits failures with its cooldown).

export const TERRAIN_AUDIT_INTERVAL_MS = 1000;

/**
 * @param {object} s scene3d facade: terrainBakedLbs, terrainGroup,
 *   landblockLru, _pvsEffectiveRingRadius, _streamGuardState,
 *   loadTerrainForLandblock
 * @param {number} centerLbKey current player landblock key (lbX<<24|lbY<<16)
 * @param {number} nowMs
 * @returns {null|{checked:number,parked:number,unbaked:number,markNoMesh:number}}
 *   null when skipped (cadence / no inputs)
 */
export function auditTerrainRing(s, centerLbKey, nowMs) {
  if (!s || centerLbKey == null || typeof s.loadTerrainForLandblock !== "function") return null;
  if (nowMs < (s._terrainAuditAtMs || 0)) return null;
  s._terrainAuditAtMs = nowMs + TERRAIN_AUDIT_INTERVAL_MS;
  const baked = s.terrainBakedLbs instanceof Set ? s.terrainBakedLbs : null;
  if (!baked) return null;
  // The sweep publishes 0 inside a sealed dungeon (the outdoor ring is
  // deliberately purged) and when the slot grid owns residency — the audit
  // must not fight either, so it only checks what the sweep wants drawn.
  const r = Number.isFinite(s._pvsEffectiveRingRadius) ? (s._pvsEffectiveRingRadius | 0) : 1;
  if (r <= 0 || s._sealedEvictLbKey) return null;
  const lru = s.landblockLru || null;
  const inFlight = s._streamGuardState?.inFlight instanceof Set ? s._streamGuardState.inFlight : null;
  // Landblocks with a terrain mesh in the scene graph (the per-LB proxy stays
  // in terrainGroup under ?terrainBatch too).
  const withMesh = new Set();
  const kids = s.terrainGroup?.children || [];
  for (const c of kids) {
    const ud = c && c.userData;
    if (ud && typeof ud.lbX === "number" && typeof ud.lbY === "number") {
      withMesh.add((((ud.lbX & 0xff) << 24) | ((ud.lbY & 0xff) << 16)) >>> 0);
    }
  }
  const cx = (centerLbKey >>> 24) & 0xff;
  const cy = (centerLbKey >>> 16) & 0xff;
  const out = { checked: 0, parked: 0, unbaked: 0, markNoMesh: 0 };
  for (let dx = -r; dx <= r; dx += 1) {
    for (let dy = -r; dy <= r; dy += 1) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x > 0xff || y < 0 || y > 0xff) continue;
      const k = ((x << 24) | (y << 16)) >>> 0;
      out.checked += 1;
      let parked = false;
      try { parked = !!lru?.isParked?.(k); } catch (_) { parked = false; }
      let fire = false;
      if (parked) {
        out.parked += 1;
        fire = true;
      } else if (!baked.has(k)) {
        if (inFlight && inFlight.has(`terrain:${k}`)) continue; // still loading
        out.unbaked += 1;
        fire = true;
      } else if (!withMesh.has(k)) {
        out.markNoMesh += 1;
        baked.delete(k); // stale mark: let the loader re-bake
        fire = true;
      }
      if (fire) {
        try {
          const p = s.loadTerrainForLandblock(x, y);
          if (p && typeof p.catch === "function") p.catch(() => {});
        } catch (_) { /* the guard / next audit retries */ }
      }
    }
  }
  return out;
}
