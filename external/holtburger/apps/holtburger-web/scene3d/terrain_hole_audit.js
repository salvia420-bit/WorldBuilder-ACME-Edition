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
//
// 2026-10-07 (false holes) — "missing" is not "neglected". Every landblock
// crossing adds a fresh edge row to the ring, and the PVS sweep
// (cells.js, nearest-first behind the stream guard's in-flight cap) drains it
// over the next seconds: those blocks are neither baked nor in flight yet, so
// the first cut logged them as `holes=11 … unbaked=11` at nearly every
// crossing — and re-asked for every one of them each second, which started
// far bakes out of the sweep's nearest-first order whenever a guard slot was
// free and inflated the guard's wait log (asks/skipCap/firstAskMs, read by
// `__diag.bakeWait()`). The audit now classifies per block:
//   - in flight            → loading, never a hole (this ALSO covers the
//                            baked-mark-before-attach window: terrain.js
//                            marks the LB, then awaits prewarmSubtree before
//                            adding the mesh — clearing the mark there made
//                            the bake discard its own finished mesh);
//   - parked               → unparked at once (the loader fast path is
//                            synchronous and takes no guard slot); a HOLE only
//                            if it is still parked GRACE later;
//   - marked, no mesh, idle → always a hole (nothing else repairs it — the
//                            sweep reads the mark as baked): clear + re-bake;
//   - unbaked, idle        → backlog until NEGLECTED: it was already missing
//                            at an earlier audit AND either the stream is idle
//                            with the sweep latched complete (nobody will
//                            start it), or the ring has made no progress for
//                            GRACE (stalled stream). Only then re-requested.
// Progress = the centre landblock changed, the guard's in-flight set changed,
// or a previously-missing ring block landed.

export const TERRAIN_AUDIT_INTERVAL_MS = 1000;
// A block missing this long with no ring progress for as long is neglected
// (> the guard's 2.5 s failure cooldown + the sweep's 0.5 s re-sweep, so the
// normal retry gets its turn first).
export const TERRAIN_AUDIT_GRACE_MS = 5000;

/** Drop the per-block clocks (audit skipped: sealed dungeon / slot grid). */
function resetAuditState(s) {
  if (s._terrainAuditState) s._terrainAuditState = null;
}

/**
 * @param {object} s scene3d facade: terrainBakedLbs, terrainGroup,
 *   landblockLru, _pvsEffectiveRingRadius, _pvsSweepIncomplete,
 *   _streamGuardState, loadTerrainForLandblock
 * @param {number} centerLbKey current player landblock key (lbX<<24|lbY<<16)
 * @param {number} nowMs
 * @returns {null|{checked:number,parked:number,unbaked:number,markNoMesh:number,pending:number}}
 *   null when skipped (cadence / no inputs). parked/unbaked/markNoMesh count
 *   GENUINE holes only; `pending` counts blocks still inside their grace
 *   (normal ring-sweep backlog, or a parked block just unparked).
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
  if (r <= 0 || s._sealedEvictLbKey) {
    resetAuditState(s);
    return null;
  }
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

  let st = s._terrainAuditState;
  if (!st) {
    st = s._terrainAuditState = {
      missingSince: new Map(), // lbKey → nowMs the audit first saw it missing
      progressMs: nowMs,
      center: centerLbKey >>> 0,
      inFlightSig: "",
    };
  }
  let progressed = false;
  if (st.center !== (centerLbKey >>> 0)) {
    st.center = centerLbKey >>> 0;
    progressed = true;
  }
  // ≤ the guard cap (6) entries — a join at 1 Hz is free.
  const inFlightSig = inFlight && inFlight.size ? [...inFlight].join(",") : "";
  if (inFlightSig !== st.inFlightSig) {
    st.inFlightSig = inFlightSig;
    progressed = true;
  }

  // Pass 1 — classify every ring block (progress must be known before any
  // block is judged neglected).
  const cx = (centerLbKey >>> 24) & 0xff;
  const cy = (centerLbKey >>> 16) & 0xff;
  const missing = [];
  const ringKeys = new Set();
  for (let dx = -r; dx <= r; dx += 1) {
    for (let dy = -r; dy <= r; dy += 1) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x > 0xff || y < 0 || y > 0xff) continue;
      const k = ((x << 24) | (y << 16)) >>> 0;
      ringKeys.add(k);
      let parked = false;
      try { parked = !!lru?.isParked?.(k); } catch (_) { parked = false; }
      let kind = null;
      if (parked) kind = "parked";
      else if (inFlight && inFlight.has(`terrain:${k}`)) kind = null; // loading
      else if (!baked.has(k)) kind = "unbaked";
      else if (!withMesh.has(k)) kind = "markNoMesh";
      if (kind) {
        missing.push({ k, x, y, kind, prevSeen: st.missingSince.has(k) });
      } else if (st.missingSince.delete(k) && (baked.has(k) && withMesh.has(k))) {
        progressed = true; // a block we were waiting on landed
      }
    }
  }
  // Blocks that left the ring are no longer the audit's business.
  for (const k of st.missingSince.keys()) {
    if (!ringKeys.has(k)) st.missingSince.delete(k);
  }
  if (progressed) st.progressMs = nowMs;

  // Pass 2 — judge + heal.
  const idleLatched = (!inFlight || inFlight.size === 0) && !s._pvsSweepIncomplete;
  const stalled = nowMs - st.progressMs >= TERRAIN_AUDIT_GRACE_MS;
  const out = { checked: ringKeys.size, parked: 0, unbaked: 0, markNoMesh: 0, pending: 0 };
  for (const m of missing) {
    let since = st.missingSince.get(m.k);
    if (since == null) {
      since = nowMs;
      st.missingSince.set(m.k, since);
    }
    const overdue = nowMs - since >= TERRAIN_AUDIT_GRACE_MS;
    let fire = false;
    let genuine = false;
    if (m.kind === "parked") {
      fire = true; // cheap synchronous unpark — no guard slot, no wait-log ask
      genuine = overdue;
    } else if (m.kind === "markNoMesh") {
      baked.delete(m.k); // stale mark: let the loader re-bake
      st.missingSince.delete(m.k); // now an ordinary unbaked block with a fresh clock
      fire = true;
      genuine = true;
    } else {
      genuine = m.prevSeen && (idleLatched || (overdue && stalled));
      fire = genuine;
    }
    if (genuine) out[m.kind] += 1;
    else out.pending += 1;
    if (fire) {
      try {
        const p = s.loadTerrainForLandblock(m.x, m.y);
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch (_) { /* the guard / next audit retries */ }
    }
  }
  return out;
}
