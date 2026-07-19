// sweep_probe.js — the cheapest perception upgrade (NavAtlas W2.5). rynth has
// never used the wasm sweep exports; this turns a blind 30 s wall-grind into an
// instant fact: "blocked at 12 m by a building at (x,y)". Perception-pure — it
// reads the same collision geometry the client renders (appendix B §2), no
// server data.
//
// Consumers (wired by the lead + Agent A): (1) BEFORE walking a straight-
// coverage leg (W1.2 loud fallback) — probe it; a hit lets the director/a
// sidestep heuristic act instead of grinding. (2) During stuck recovery —
// probe the current heading to learn where the wall is.
//
// Exports the wasm sweeps against a live CLONE of the movement scene:
//   sweepSphereAgainstStatics       — outdoor static AABBs (trees/props)
//   sweepSphereAgainstBuildingMesh  — precise building triangles (incl. basement)
//   sweepSphereAgainstCellMesh      — EnvCell triangles (dungeons/interiors)
//   terrainHeightAt                 — retail diagonal-split height
// CollisionHit = { t∈[0,1], x,y,z world hit point, normalX/Y/Z }. No object id
// is exposed by the wasm, so a hit reports its KIND + world point, not a guid.
//
// Dependency-injected (node-testable): probeSegment takes a `probe` object of
// plain functions; probeFromSession() adapts a live SessionHandle (and FREES
// each returned wasm CollisionHit — dispose discipline, no leak).

const PLAYER_RADIUS_M = 0.5; // AC player physics radius (sweep sphere)
const SWEEP_Z_OFFSET_M = 1.0; // lift the sweep off the ground (chest height) so
// it tests walls, not the floor the player stands on.

// router leg frame {lb,x,y,z} -> world-frame metres.
function worldOf(p) {
  return { x: ((p.lb >>> 24) & 0xff) * 192 + p.x, y: ((p.lb >>> 16) & 0xff) * 192 + p.y, z: p.z };
}

/** Probe one straight segment from -> to (router leg frame {lb,x,y,z}) for the
 *  earliest obstacle. Returns:
 *    { blocked, atMeters, hitKind, hitPoint, normal, segMeters }
 *  blocked=false on a clean sweep. atMeters = t × segment length (the distance
 *  the walker gets before contact). `cellIds` (Uint32Array/array) enables the
 *  EnvCell sweep for indoor legs; omit outdoors. */
export function probeSegment(probe, from, to, { radius = PLAYER_RADIUS_M, cellIds = null, zOffset = SWEEP_Z_OFFSET_M } = {}) {
  const a = worldOf(from);
  const b = worldOf(to);
  const az = a.z + zOffset;
  const bz = b.z + zOffset;
  const segMeters = Math.hypot(b.x - a.x, b.y - a.y, bz - az);
  const lb = to.lb >>> 0; // scope statics/building to the destination LB (widens to 3x3)
  const hits = [];
  const add = (kind, hit) => {
    if (hit && typeof hit.t === "number") hits.push({ kind, hit });
  };
  if (probe.sweepStatics) add("static", probe.sweepStatics(a.x, a.y, az, b.x, b.y, bz, radius, lb));
  if (probe.sweepBuilding) add("building", probe.sweepBuilding(a.x, a.y, az, b.x, b.y, bz, radius, lb));
  if (cellIds && cellIds.length && probe.sweepCell) {
    const ids = cellIds instanceof Uint32Array ? cellIds : Uint32Array.from(cellIds);
    add("cell", probe.sweepCell(a.x, a.y, az, b.x, b.y, bz, radius, ids));
  }
  if (!hits.length) {
    return { blocked: false, atMeters: null, hitKind: null, hitPoint: null, normal: null, segMeters };
  }
  hits.sort((p, q) => p.hit.t - q.hit.t); // earliest contact wins
  const { kind, hit } = hits[0];
  return {
    blocked: true,
    atMeters: hit.t * segMeters,
    hitKind: kind,
    hitPoint: { x: hit.x, y: hit.y, z: hit.z },
    normal: { x: hit.normalX ?? hit.normal_x ?? 0, y: hit.normalY ?? hit.normal_y ?? 0, z: hit.normalZ ?? hit.normal_z ?? 0 },
    segMeters,
  };
}

/** Probe every leg of a route in order; return the first blocked leg's result
 *  (with `leg` = its 0-based index) or a clean {blocked:false} if none block.
 *  Legs are router.follow() frame; portal legs are skipped (a hop crosses no
 *  ground). Pass `cellIdsForLeg(i, leg)` to enable indoor cell sweeps. */
export function probeRoute(probe, legs, { radius = PLAYER_RADIUS_M, cellIdsForLeg = null } = {}) {
  for (let i = 1; i < legs.length; i++) {
    if (legs[i].portal) continue; // hop, not walked
    const cellIds = cellIdsForLeg ? cellIdsForLeg(i, legs[i]) : null;
    const r = probeSegment(probe, legs[i - 1], legs[i], { radius, cellIds });
    if (r.blocked) return { ...r, leg: i };
  }
  return { blocked: false, leg: -1 };
}

// Read the fields of a wasm CollisionHit into a plain object and free it (the
// wasm-bindgen object owns Rust memory; dropping the JS ref does NOT free it).
function plainHit(h) {
  if (!h) return undefined;
  const o = { t: h.t, x: h.x, y: h.y, z: h.z, normalX: h.normalX, normalY: h.normalY, normalZ: h.normalZ };
  if (typeof h.free === "function") {
    try {
      h.free();
    } catch (_) {
      /* already freed */
    }
  }
  return o;
}

/** Adapt a live wasm SessionHandle to the plain-function `probe` shape. Each
 *  sweep result is copied to a plain object and the wasm CollisionHit freed. */
export function probeFromSession(sh) {
  return {
    sweepStatics: (...a) => plainHit(sh.sweepSphereAgainstStatics(...a)),
    sweepBuilding: (...a) => plainHit(sh.sweepSphereAgainstBuildingMesh(...a)),
    sweepCell: (...a) => plainHit(sh.sweepSphereAgainstCellMesh(...a)),
    terrainHeightAt: (x, y) => sh.terrainHeightAt(x, y),
  };
}

/** Sample terrain height along a segment (world frame) at N steps; returns the
 *  max upward step and max downward drop between consecutive samples — a cheap
 *  cliff/gorge detector complementing the obstacle sweep (undefined heights,
 *  i.e. unbaked LBs, are skipped). */
export function terrainProfile(probe, from, to, { steps = 8 } = {}) {
  if (!probe.terrainHeightAt) return null;
  const a = worldOf(from);
  const b = worldOf(to);
  let prev = null;
  let maxRise = 0;
  let maxDrop = 0;
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    const h = probe.terrainHeightAt(a.x + (b.x - a.x) * s, a.y + (b.y - a.y) * s);
    if (typeof h !== "number") {
      prev = null;
      continue;
    }
    if (prev != null) {
      const d = h - prev;
      if (d > maxRise) maxRise = d;
      if (-d > maxDrop) maxDrop = -d;
    }
    prev = h;
  }
  return { maxRise, maxDrop };
}

export default { probeSegment, probeRoute, probeFromSession, terrainProfile };
