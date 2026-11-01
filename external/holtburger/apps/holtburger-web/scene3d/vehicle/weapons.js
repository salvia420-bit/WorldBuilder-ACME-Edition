// scene3d/vehicle/weapons.js — tracer bolts from VehicleFire (vehicles DESIGN §4.7 / §6.2 effects).
//
// The server owns the gun (rate, spread, ammo, hits); a VehicleFire tells capable clients that `count` rounds left
// mount `mount` at step `step` along `dir`, with the burst's spread seed. Each bolt's spread is replayed with the SAME
// xorshift32 stream the server used (ACE Vehicles/VehicleWeapons.cs SpreadOffset), so every client draws the same
// bolts. Hits are not drawn here — they arrive as the standard damage messages (splatter, health, death).
// Rendering: one LineSegments under liveScene3d.worldRoot (AC frame), a pooled position buffer, no per-bolt objects.

import { orientation, rotate, toGlobal } from "./flight_model.js";

export const TRACER_SPEED = 320; // m/s (visual)
export const TRACER_LENGTH = 7; // m
export const MAX_TRACERS = 256;

export function xorshift32(s) {
  s = (s ^ (s << 13)) >>> 0;
  s = (s ^ (s >>> 17)) >>> 0;
  s = (s ^ (s << 5)) >>> 0;
  return s;
}

/** The server's SpreadOffset sequence: returns [{dRight, dUp}] for `count` bolts of a burst. */
export function spreadOffsets(seed, count, spread) {
  let rng = seed >>> 0;
  const out = [];
  for (let i = 0; i < count; i++) {
    rng = xorshift32(rng);
    const u1 = (rng >>> 8) * (1.0 / 16777216.0);
    rng = xorshift32(rng);
    const u2 = (rng >>> 8) * (1.0 / 16777216.0);
    const r = spread * Math.sqrt(u1);
    const a = 2.0 * Math.PI * u2;
    out.push({ dRight: r * Math.cos(a), dUp: r * Math.sin(a) });
  }
  return out;
}

export function createTracers(deps = {}) {
  const live = deps.liveScene3d ?? null;
  const THREE = deps.THREE ?? null;
  const bolts = []; // {o:[x,y,z], d:[x,y,z], t, life}
  let geom = null;
  let lines = null;
  let added = 0;

  function ensure() {
    if (lines || !THREE || !live || !live.worldRoot) return;
    geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_TRACERS * 6), 3));
    geom.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({ color: 0xffb040, transparent: true, opacity: 0.95, depthWrite: false });
    lines = new THREE.LineSegments(geom, mat);
    lines.name = "vehicle-tracers";
    lines.frustumCulled = false;
    lines.renderOrder = 5;
    live.worldRoot.add(lines);
  }

  return {
    /**
     * @param {object} m a "fire" inbox message
     * @param {object|undefined} v the vehicle record (profile + last state) for the spread frame
     * @param {number[]} [originOverride] AC world muzzle (the pilot's predicted muzzle)
     * @param {object} [poseOverride] {heading, pitch, bank} for the spread frame
     */
    add(m, v, originOverride, poseOverride) {
      const spread = v?.profile?.weapons?.[m.mount]?.spread ?? 0.026;
      const range = v?.profile?.weapons?.[m.mount]?.range ?? 120;
      const pose = poseOverride ?? (v?.last ? { heading: v.last.heading, pitch: v.last.pitch, bank: v.last.bank } : null);
      const q = pose ? orientation(pose.heading, pose.pitch, pose.bank) : [1, 0, 0, 0];
      const fwd = [m.dir[0], m.dir[1], m.dir[2]];
      const right = rotate(q, [1, 0, 0]);
      const up = rotate(q, [0, 0, 1]);
      const o = originOverride ?? toGlobal(m.cell, m.x, m.y, m.z);
      for (const { dRight, dUp } of spreadOffsets(m.seed, m.count, spread)) {
        const tr = Math.tan(dRight), tu = Math.tan(dUp);
        let d = [fwd[0] + right[0] * tr + up[0] * tu, fwd[1] + right[1] * tr + up[1] * tu, fwd[2] + right[2] * tr + up[2] * tu];
        const l = Math.hypot(d[0], d[1], d[2]) || 1;
        d = [d[0] / l, d[1] / l, d[2] / l];
        if (bolts.length >= MAX_TRACERS) bolts.shift();
        bolts.push({ o: o.slice(), d, t: 0, life: range / TRACER_SPEED });
        added++;
      }
    },
    tick(dt) {
      if (!bolts.length) {
        if (geom) geom.setDrawRange(0, 0);
        return;
      }
      ensure();
      if (!geom) return;
      const pos = geom.attributes.position.array;
      let n = 0;
      for (let i = bolts.length - 1; i >= 0; i--) {
        const b = bolts[i];
        b.t += dt;
        if (b.t > b.life) bolts.splice(i, 1);
      }
      for (const b of bolts) {
        const head = b.t * TRACER_SPEED;
        const tail = Math.max(0, head - TRACER_LENGTH);
        pos[n++] = b.o[0] + b.d[0] * tail; pos[n++] = b.o[1] + b.d[1] * tail; pos[n++] = b.o[2] + b.d[2] * tail;
        pos[n++] = b.o[0] + b.d[0] * head; pos[n++] = b.o[1] + b.d[1] * head; pos[n++] = b.o[2] + b.d[2] * head;
      }
      geom.attributes.position.needsUpdate = true;
      geom.setDrawRange(0, n / 3);
    },
    stats: () => ({ live: bolts.length, added }),
    dispose() {
      try { lines?.parent?.remove(lines); geom?.dispose(); lines?.material?.dispose(); } catch (_) { /* gone */ }
      lines = null;
      geom = null;
      bolts.length = 0;
    },
  };
}
