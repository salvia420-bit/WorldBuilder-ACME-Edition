// scene3d/vehicle/chute.js — the parachute canopy over a bailed-out body (vehicles DESIGN §4.8, EYETEST #10).
//
// Presentation only, client-drawn like the tracers (weapons.js): the server owns the fall (ACE VehicleBailout) and
// tells capable clients when a chute opens (VehicleEvent Chute) and when the body lands (Touchdown). Here a canopy is
// drawn over every body whose Chute event arrived — the local player (positioned by the fall twin) and observed
// players (positioned by their entity rig) — it blossoms open over 0.8 s, sways gently, and collapses at touchdown.
// Retail clients see the falling body only (no canopy object exists on the server).
// `?vehicleChute=off` (exact) draws none. Geometry lives under liveScene3d.worldRoot (AC frame: x east, y north, z up).
//
// Fall pose (fall_pose.js, `?vehicleFallAnim`, decision 57): a body whose canopy pose is playing hands its riser
// grips to the pose (`poseOf(guid).risers` = [{grip, shoulder}] x 2, rig units): the shroud lines then run to the two
// hands and a riser strap joins each hand to its shoulder; without them the lines meet at one harness point. The whole
// canopy follows the rig's root scale (`poseOf(guid).scale`, the heritage's CharGen scale). The line ends at the body
// never shrink with the opening dome.

export const CANOPY = Object.freeze({
  radius: 3.5, // rim radius (m) — a ~7 m WW2-era canopy
  height: 2.0, // apex above the rim
  rise: 4.4, // rim height above the harness / feet
  harness: 1.5, // where the shroud lines meet, above the feet
  gores: 12,
  rings: 6,
  lines: 8,
  openSec: 0.8,
  collapseSec: 0.7,
  swayRad: 0.07,
  swayHz: 0.3,
  colors: [0x6f7340, 0xb7ae7c], // olive drab / khaki gores
});

/** `?vehicleChute=off` (exact) disables the canopy. */
export function chuteEnabled(search) {
  try { return new URLSearchParams(search || "").get("vehicleChute") !== "off"; } catch (_) { return true; }
}

/** Opening scale at t seconds after the chute opened: ease-out from 0.15 to 1. */
export function openScale(t) {
  const u = Math.min(1, Math.max(0, t / CANOPY.openSec));
  return 0.15 + 0.85 * (1 - (1 - u) ** 3);
}

/** Collapse progress at t seconds after touchdown: 0 (open) → 1 (gone). */
export function collapseProgress(t) {
  return Math.min(1, Math.max(0, t / CANOPY.collapseSec));
}

/**
 * Canopy dome (non-indexed triangles + per-vertex gore colours) and shroud-line segments, in the canopy frame:
 * origin at the feet, z up, rim at `rise`, apex at `rise + height`. Pure (no THREE): plain Float32Arrays.
 */
export function canopyGeometry(c = CANOPY) {
  const pos = [];
  const col = [];
  const rgb = c.colors.map((h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]);
  // dome: z(r) = rise + height * (1 - (r/R)^2), rings from the apex (ring 0) to the rim (ring `rings`)
  const pt = (gore, ring) => {
    const a = (gore / c.gores) * 2 * Math.PI;
    const r = (ring / c.rings) * c.radius;
    const s = r / c.radius;
    return [r * Math.sin(a), r * Math.cos(a), c.rise + c.height * (1 - s * s)];
  };
  for (let g = 0; g < c.gores; g++) {
    const k = rgb[g % 2];
    for (let ring = 0; ring < c.rings; ring++) {
      const a0 = pt(g, ring), a1 = pt(g + 1, ring), b0 = pt(g, ring + 1), b1 = pt(g + 1, ring + 1);
      const tris = ring === 0 ? [[a0, b0, b1]] : [[a0, b0, b1], [a0, b1, a1]];
      for (const tri of tris) for (const v of tri) { pos.push(v[0], v[1], v[2]); col.push(k[0], k[1], k[2]); }
    }
  }
  return { positions: new Float32Array(pos), colors: new Float32Array(col), lines: lineSegments(1, 1, null, c) };
}

/**
 * Shroud lines (+ riser straps) in the canopy frame for an opening scale (`s` horizontal, `sz` vertical: the dome's
 * current scale; the rim points scale with it, the ends at the body do not). `risers` = null → every line meets the
 * harness point (0, 0, harness); [{grip, shoulder}, {grip, shoulder}] (left, right) → the lines on each side run to
 * that hand's grip and two more segments join each grip to its shoulder. Pure.
 */
export function lineSegments(s = 1, sz = 1, risers = null, c = CANOPY) {
  const out = [];
  const two = Array.isArray(risers) && risers.length === 2 && risers.every((r) => r && Array.isArray(r.grip) && Array.isArray(r.shoulder));
  for (let i = 0; i < c.lines; i++) {
    const a = (i / c.lines) * 2 * Math.PI;
    const x = c.radius * Math.sin(a) * s, y = c.radius * Math.cos(a) * s, z = c.rise * sz;
    // left side (x < 0, and the back line) to the left grip; right side (x > 0, and the front line) to the right
    const end = two ? (Math.sin(a) < -1e-9 || (Math.abs(Math.sin(a)) <= 1e-9 && Math.cos(a) < 0) ? risers[0].grip : risers[1].grip) : [0, 0, c.harness];
    out.push(x, y, z, end[0], end[1], end[2]);
  }
  if (two) for (const r of risers) out.push(r.grip[0], r.grip[1], r.grip[2], r.shoulder[0], r.shoulder[1], r.shoulder[2]);
  return new Float32Array(out);
}

/**
 * @param {{liveScene3d: object, THREE: object, wireframe?: boolean}} deps
 */
export function createChutes(deps = {}) {
  const live = deps.liveScene3d ?? null;
  const THREE = deps.THREE ?? null;
  const canopies = new Map(); // guid → {group, dome, lines, t, closing, ct, linesKey}
  let shared = null; // the dome geometry + materials, built on first use
  let opened = 0;

  function ensureShared() {
    if (shared || !THREE) return shared;
    const g = canopyGeometry();
    const dome = new THREE.BufferGeometry();
    dome.setAttribute("position", new THREE.BufferAttribute(g.positions, 3));
    dome.setAttribute("color", new THREE.BufferAttribute(g.colors, 3));
    dome.computeVertexNormals();
    dome.userData.__disposable = true;
    const domeMat = deps.wireframe
      ? new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
      : new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.95, metalness: 0 });
    domeMat.userData.__disposable = true;
    const lineMat = new THREE.LineBasicMaterial({ color: 0x3a3a30 });
    lineMat.userData.__disposable = true;
    shared = { dome, domeMat, lineMat };
    return shared;
  }

  function open(guid) {
    const g = guid >>> 0;
    const cur = canopies.get(g);
    if (cur && !cur.closing) return;
    if (cur) remove(g);
    if (!live || !live.worldRoot || !ensureShared()) return;
    const group = new THREE.Group();
    group.name = `vehicle-chute-${g.toString(16)}`;
    const domeGroup = new THREE.Group();
    const dome = new THREE.Mesh(shared.dome, shared.domeMat);
    dome.frustumCulled = false;
    domeGroup.add(dome);
    // per-canopy lines (their body ends follow the riser grips; ≤ 10 segments, rewritten only when they move)
    const lineGeom = new THREE.BufferGeometry();
    lineGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array((CANOPY.lines + 2) * 6), 3));
    lineGeom.setDrawRange(0, CANOPY.lines * 2);
    const lines = new THREE.LineSegments(lineGeom, shared.lineMat);
    lines.frustumCulled = false;
    group.add(domeGroup, lines);
    group.visible = false; // until the first pose
    live.worldRoot.add(group);
    canopies.set(g, { group, domeGroup, lines, lineGeom, t: 0, closing: false, ct: 0, lastS: NaN, lastSz: NaN, lastRisers: undefined });
    opened++;
  }

  function close(guid) {
    const c = canopies.get(guid >>> 0);
    if (c && !c.closing) { c.closing = true; c.ct = 0; }
  }

  function remove(guid) {
    const c = canopies.get(guid >>> 0);
    if (!c) return;
    try { c.group.parent?.remove(c.group); } catch (_) { /* gone */ }
    try { c.lineGeom.dispose(); } catch (_) { /* gone */ }
    canopies.delete(guid >>> 0);
  }

  // rewritten only when the dome's scale or the riser grips (a cached array per body) change: the opening / collapse
  function writeLines(c, s, sz, risers) {
    if (s === c.lastS && sz === c.lastSz && risers === c.lastRisers) return;
    c.lastS = s; c.lastSz = sz; c.lastRisers = risers;
    const seg = lineSegments(s, sz, risers);
    const attr = c.lineGeom.getAttribute("position");
    attr.array.set(seg);
    attr.needsUpdate = true;
    c.lineGeom.setDrawRange(0, seg.length / 3);
  }

  /**
   * @param {number} dt seconds
   * @param {(guid: number) => ({x:number,y:number,z:number,heading:number,scale?:number,risers?:Array}|null)} poseOf
   *   the body's feet + heading (+ the rig's root scale and, from the fall pose, the riser grips)
   */
  function tick(dt, poseOf) {
    for (const [guid, c] of canopies) {
      const p = poseOf(guid);
      if (!p) { if (c.closing) remove(guid); else c.group.visible = false; continue; }
      c.t += dt;
      let s = openScale(c.t);
      let sz = s;
      let sink = 0;
      if (c.closing) {
        c.ct += dt;
        const k = collapseProgress(c.ct);
        if (k >= 1) { remove(guid); continue; }
        sz = s * (1 - 0.85 * k); // deflates downward
        s = s * (1 + 0.25 * k); // and spreads
        sink = 2.5 * k;
      }
      const k = Number.isFinite(p.scale) && p.scale > 0 ? p.scale : 1;
      const w = 2 * Math.PI * CANOPY.swayHz * c.t;
      c.group.position.set(p.x, p.y, p.z - sink);
      c.group.rotation.set(CANOPY.swayRad * Math.sin(w), CANOPY.swayRad * 0.6 * Math.sin(w * 1.3 + 1), -(p.heading || 0), "ZXY");
      c.group.scale.set(k, k, k);
      c.domeGroup.scale.set(s, s, sz);
      writeLines(c, s, sz, c.closing ? null : (p.risers ?? null));
      c.group.visible = true;
    }
  }

  return {
    open, close, tick, remove,
    has: (guid) => canopies.has(guid >>> 0),
    stats: () => ({ live: canopies.size, opened }),
    dispose() {
      for (const g of [...canopies.keys()]) remove(g);
      if (shared) {
        try { shared.dome.dispose(); shared.domeMat.dispose(); shared.lineMat.dispose(); } catch (_) { /* */ }
        shared = null;
      }
    },
  };
}
