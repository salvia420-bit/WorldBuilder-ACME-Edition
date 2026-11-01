// scene3d/vehicle/chute.js — the parachute canopy over a bailed-out body (vehicles DESIGN §4.8, EYETEST #10).
//
// Presentation only, client-drawn like the tracers (weapons.js): the server owns the fall (ACE VehicleBailout) and
// tells capable clients when a chute opens (VehicleEvent Chute) and when the body lands (Touchdown). Here a canopy is
// drawn over every body whose Chute event arrived — the local player (positioned by the fall twin) and observed
// players (positioned by their entity rig) — it blossoms open over 0.8 s, sways gently, and collapses at touchdown.
// Retail clients see the falling body only (no canopy object exists on the server).
// `?vehicleChute=off` (exact) draws none. Geometry lives under liveScene3d.worldRoot (AC frame: x east, y north, z up).

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
  const lines = [];
  for (let i = 0; i < c.lines; i++) {
    const a = (i / c.lines) * 2 * Math.PI;
    lines.push(c.radius * Math.sin(a), c.radius * Math.cos(a), c.rise, 0, 0, c.harness);
  }
  return { positions: new Float32Array(pos), colors: new Float32Array(col), lines: new Float32Array(lines) };
}

/**
 * @param {{liveScene3d: object, THREE: object, wireframe?: boolean}} deps
 */
export function createChutes(deps = {}) {
  const live = deps.liveScene3d ?? null;
  const THREE = deps.THREE ?? null;
  const canopies = new Map(); // guid → {group, t, closing, ct}
  let shared = null; // geometries + materials, built on first use
  let opened = 0;

  function ensureShared() {
    if (shared || !THREE) return shared;
    const g = canopyGeometry();
    const dome = new THREE.BufferGeometry();
    dome.setAttribute("position", new THREE.BufferAttribute(g.positions, 3));
    dome.setAttribute("color", new THREE.BufferAttribute(g.colors, 3));
    dome.computeVertexNormals();
    dome.userData.__disposable = true;
    const lines = new THREE.BufferGeometry();
    lines.setAttribute("position", new THREE.BufferAttribute(g.lines, 3));
    lines.userData.__disposable = true;
    const domeMat = deps.wireframe
      ? new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
      : new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.95, metalness: 0 });
    domeMat.userData.__disposable = true;
    const lineMat = new THREE.LineBasicMaterial({ color: 0x3a3a30 });
    lineMat.userData.__disposable = true;
    shared = { dome, lines, domeMat, lineMat };
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
    const dome = new THREE.Mesh(shared.dome, shared.domeMat);
    dome.frustumCulled = false;
    const lines = new THREE.LineSegments(shared.lines, shared.lineMat);
    lines.frustumCulled = false;
    group.add(dome, lines);
    group.visible = false; // until the first pose
    live.worldRoot.add(group);
    canopies.set(g, { group, t: 0, closing: false, ct: 0 });
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
    canopies.delete(guid >>> 0);
  }

  /**
   * @param {number} dt seconds
   * @param {(guid: number) => ({x:number,y:number,z:number,heading:number}|null)} poseOf the body's feet + heading
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
      const w = 2 * Math.PI * CANOPY.swayHz * c.t;
      c.group.position.set(p.x, p.y, p.z - sink);
      c.group.rotation.set(CANOPY.swayRad * Math.sin(w), CANOPY.swayRad * 0.6 * Math.sin(w * 1.3 + 1), -(p.heading || 0), "ZXY");
      c.group.scale.set(s, s, sz);
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
        try { shared.dome.dispose(); shared.lines.dispose(); shared.domeMat.dispose(); shared.lineMat.dispose(); } catch (_) { /* */ }
        shared = null;
      }
    },
  };
}
