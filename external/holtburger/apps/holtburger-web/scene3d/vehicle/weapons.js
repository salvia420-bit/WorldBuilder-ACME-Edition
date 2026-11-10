// scene3d/vehicle/weapons.js — what the vehicle's armament looks like on a capable client (vehicles DESIGN §4.7, HBV1 v2).
//
// The server owns every round, rail, bomb and hit (ACE Vehicles/VehicleWeapons.cs, VehicleOrdnance.cs). This draws them:
//   * QUARRELS — a VehicleFire for the gun group (Mount = the first gun, MountCount guns, Count quarrels each) is
//     replayed with the SAME xorshift32 stream the server used (mount-major, round-minor; SpreadOffset), each gun from its
//     own muzzle toward the boresight point `convergence` m ahead (gunDirLocal = the server's GunDirLocal). Each quarrel
//     is the retail quarrel model (Deadly Armor Piercing Quarrel, Setup 0x0200012A; instanced) with a short golden
//     streak, flying at the message's ground speed. Hits arrive as the standard damage messages when the quarrel lands.
//   * LIGHTNING RAILS — a VehicleFire for a missile mount: a flash at its wand. The bolt itself is a real ACE spell
//     projectile (Lightning Bolt) every client draws through the ordinary object path.
//   * BOMBS — a BombRelease event: the station's own ordnance meshes (the airframe's steel keg + fins) fly the bomb twin
//     (fall_model.js stepBomb = the server's VehicleOrdnance.Step) nose along the velocity; at the ground (or at the
//     server's Explosion event, whichever comes first) they burst: fireball, flash, shock ring, smoke column, and a
//     camera shake for nearby pilots. No lights are added (a light-count change relinks every lit program).
// Rendering: under liveScene3d.worldRoot (AC frame); pooled; every material and geometry here is owned and disposed.

import { orientation, rotate, toGlobal, DT } from "./flight_model.js";
import { stepBomb } from "./fall_model.js";
import { decodeModel } from "./airframe.js";
import { prewarmSubtree } from "../bake_prewarm.js";

export const QUARREL_SETUP = 0x0200012a;
export const QUARREL_SCALE = 1.8;
export const STREAK_LENGTH = 6; // m
export const MAX_QUARRELS = 192;
export const MAX_EXPLOSIONS = 6;
export const MAX_BOMBS = 12;
/** Fallbacks for a v1 server (no WeaponExt / speed): the old tracer speed. */
export const DEFAULT_SPEED = 220;
export const KIND = Object.freeze({ GUN: 1, MISSILE: 2, BOMB: 3 });
/** Explosion look per bomb size (lb): fireball radius, shake amplitude (m), ring reach. */
// sized to read from a few hundred metres up (the 1070 stills, 2026-11-02: 16 / 11 m read as a small disc from 260 m)
/** Sprite size per sphere radius of the old effect: a sprite's scale is its diameter, and the soft falloff fades the edge. */
const SOFT = 2.4;

/** A small RGBA DataTexture (no DOM: works in node tests) white with alpha = profile(r), r = 0 at the centre, 1 at the edge. */
function radialTexture(THREE, profile, n = 64) {
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n * 2 - 1, y = (j + 0.5) / n * 2 - 1;
      const a = Math.max(0, Math.min(1, profile(Math.hypot(x, y))));
      const k = (j * n + i) * 4;
      data[k] = data[k + 1] = data[k + 2] = 255;
      data[k + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export const BLAST = Object.freeze({ fireball2000: 24, fireball1000: 16, shake2000: 1.1, shake1000: 0.7, shakeRange: 700 });

export function xorshift32(s) {
  s = (s ^ (s << 13)) >>> 0;
  s = (s ^ (s >>> 17)) >>> 0;
  s = (s ^ (s << 5)) >>> 0;
  return s;
}

/** The server's SpreadOffset sequence, continuing `rng`: [{dRight, dUp}] for `count` rounds; returns the new rng too. */
export function spreadOffsetsFrom(rng, count, spread) {
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
  return { offsets: out, rng };
}

/** The first burst of a seed (v1 compatibility helper). */
export function spreadOffsets(seed, count, spread) {
  return spreadOffsetsFrom(seed >>> 0, count, spread).offsets;
}

/** A gun's aim in the vehicle frame (the server's VehicleWeapons.GunDirLocal): toward the boresight point `conv` m ahead. */
export function gunDirLocal(muzzle, convergence) {
  if (!(convergence > 0)) return [0, 1, 0];
  const x = -muzzle[0], y = convergence;
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l, 0];
}

/**
 * Every quarrel of a gun salvo, replayed: [{o: [x,y,z] AC world, d: unit dir, mount}] — `origin0` the first gun's
 * world muzzle, `q` the vehicle orientation [w,x,y,z] the spread frame was taken in.
 */
export function salvoRounds(profile, m, origin0, q) {
  const weapons = profile?.weapons || [];
  const ext = profile?.weaponExt || [];
  const first = m.mount | 0;
  const nMounts = Math.max(1, m.mountCount | 0 || 1);
  const right = rotate(q, [1, 0, 0]);
  const up = rotate(q, [0, 0, 1]);
  const m0 = weapons[first]?.muzzle ?? [0, 0, 0];
  let rng = (m.seed >>> 0) || 0x9e3779b9;
  const out = [];
  for (let k = 0; k < nMounts; k++) {
    const wi = first + k;
    const w = weapons[wi];
    if (!w) break;
    const mz = w.muzzle ?? m0;
    const rel = rotate(q, [mz[0] - m0[0], mz[1] - m0[1], mz[2] - m0[2]]);
    const o = [origin0[0] + rel[0], origin0[1] + rel[1], origin0[2] + rel[2]];
    const base = rotate(q, gunDirLocal(mz, ext[wi]?.convergence ?? 0));
    const r = spreadOffsetsFrom(rng, m.count | 0, w.spread ?? 0.02);
    rng = r.rng;
    for (const { dRight, dUp } of r.offsets) {
      const tr = Math.tan(dRight), tu = Math.tan(dUp);
      const d = [base[0] + right[0] * tr + up[0] * tu, base[1] + right[1] * tr + up[1] * tu, base[2] + right[2] * tr + up[2] * tu];
      const l = Math.hypot(d[0], d[1], d[2]) || 1;
      out.push({ o, d: [d[0] / l, d[1] / l, d[2] / l], mount: wi });
    }
  }
  return out;
}

/**
 * The bomb's impact point from a release state {x, y, z, vx, vy, vz, terminal}: {x, y, z, t} or null — the twin at the
 * server's own step (DT), so the pipper is where the server's bomb lands (but for the terrain under the step). The
 * terrain is sampled every `sparse` steps while the bomb is well above the last sample (the walk from 5 km is ~1,200
 * steps; the pilot solves it at 10 Hz).
 */
export function predictImpact(start, ground, dt = DT, maxSec = 90, sparse = 6) {
  const b = { ...start };
  let px = b.x, py = b.y, pz = b.z;
  let lastG = ground(b.x, b.y);
  let since = 0;
  const steps = Math.ceil(maxSec / dt);
  for (let i = 0; i < steps; i++) {
    px = b.x; py = b.y; pz = b.z;
    stepBomb(b, dt);
    since++;
    // far above the last sampled ground (the bomb falls < 300 m/s: 6 steps ≈ 60 m at most), skip the sample
    if (Number.isFinite(lastG) && b.z - lastG > 80 && since < sparse) continue;
    since = 0;
    const g = ground(b.x, b.y);
    if (!Number.isFinite(g)) continue;
    lastG = g;
    if (b.z <= g) {
      const g0 = ground(px, py);
      const h0 = Number.isFinite(g0) ? pz - g0 : 0, h1 = b.z - g;
      const f = h0 > 0 && h0 - h1 > 1e-9 ? h0 / (h0 - h1) : 1;
      const x = px + (b.x - px) * f, y = py + (b.y - py) * f;
      const gz = ground(x, y);
      return { x, y, z: Number.isFinite(gz) ? gz : g, t: (i + f) * dt };
    }
  }
  return null;
}

export function createWeaponsFx(deps = {}) {
  const live = deps.liveScene3d ?? null;
  const THREE = deps.THREE ?? null;
  const ground = deps.ground ?? (() => NaN);
  const quarrels = []; // {o, d, t, life, speed}
  const flashes = []; // {mesh, t, life, r0, r1}
  const flashPool = []; // reusable THREE.Sprite pool (avoids per-shot clone + dispose)
  const bombs = []; // {key, x,y,z,vx,vy,vz, terminal, group, lb, vehicle, station, exploded}
  const explosions = []; // {meshes..., t, at, lb}
  const recent = []; // recently exploded {key, at, t} (dedupe the server's Explosion against our twin's)
  const stats = { quarrels: 0, salvos: 0, flashes: 0, bombs: 0, explosions: 0, eventExplosions: 0, deduped: 0, model: "none" };
  let root = null, streakGeom = null, streakLines = null, streakMat = null;
  let quarrelMeshes = null; // [InstancedMesh] once the quarrel model decoded
  let quarrelLoad = null;
  let sphereGeom = null, ringGeom = null, fireMat = null, flashMat = null, smokeMat = null, ringMat = null, dirtMat = null;
  let softTex = null, ringTex = null;
  const dummy = THREE ? new THREE.Object3D() : null;
  const yAxis = THREE ? new THREE.Vector3(0, 1, 0) : null;
  const tmpV = THREE ? new THREE.Vector3() : null;

  function ensure() {
    if (root || !THREE || !live || !live.worldRoot) return !!root;
    root = new THREE.Group();
    root.name = "vehicle-weapons-fx";
    live.worldRoot.add(root);
    streakGeom = new THREE.BufferGeometry();
    streakGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_QUARRELS * 6), 3));
    streakGeom.setDrawRange(0, 0);
    streakMat = new THREE.LineBasicMaterial({ color: 0xf0c060, transparent: true, opacity: 0.85, depthWrite: false });
    streakLines = new THREE.LineSegments(streakGeom, streakMat);
    streakLines.frustumCulled = false;
    streakLines.renderOrder = 5;
    root.add(streakLines);
    sphereGeom = new THREE.SphereGeometry(1, 16, 12);
    // fire / flash / smoke are camera-facing sprites with a soft radial falloff and the blast's dust skirt a flat quad with a
    // soft ring profile: the 1070 stills (1070-look-c, 2026-11-02) showed hard-edged spheres (a peach ball, a brown ball)
    // and an opaque sand-coloured ring band 150 m across, clipped by the terrain
    softTex = radialTexture(THREE, (r) => Math.pow(Math.max(0, 1 - r), 1.6));
    ringTex = radialTexture(THREE, (r) => (r >= 1 ? 0 : Math.exp(-(((r - 0.72) / 0.16) ** 2)) * Math.min(1, (1 - r) * 8)));
    ringGeom = new THREE.PlaneGeometry(2, 2);
    fireMat = new THREE.SpriteMaterial({ map: softTex, color: 0xff8a2a, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending });
    flashMat = new THREE.SpriteMaterial({ map: softTex, color: 0xfff2c0, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending });
    smokeMat = new THREE.SpriteMaterial({ map: softTex, color: 0x2c2722, transparent: true, opacity: 0.7, depthWrite: false });
    ringMat = new THREE.MeshBasicMaterial({ map: ringTex, color: 0x8c7a5c, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide });
    dirtMat = new THREE.MeshBasicMaterial({ color: 0x2e2216, transparent: true, opacity: 0.9, depthWrite: false });
    // pre-populate reusable muzzle flash sprites so gunfire never clones/disposes materials mid-frame
    for (let i = 0; i < 24; i++) {
      const s = new THREE.Sprite(flashMat.clone());
      s.renderOrder = 6;
      s.visible = false;
      root.add(s);
      flashPool.push(s);
    }
    // link the effect programs off the frame (against live.scene + HalfFloat composer target via prewarmSubtree)
    prewarm([fireMat, flashMat, smokeMat, ringMat, dirtMat]);
    loadQuarrel();
    return true;
  }

  function prewarm(mats) {
    try {
      const grp = new THREE.Group();
      if (streakGeom && streakMat) grp.add(new THREE.LineSegments(streakGeom, streakMat));
      for (const m of mats) {
        if (!m) continue;
        grp.add(m.isSpriteMaterial ? new THREE.Sprite(m) : new THREE.Mesh(m === ringMat ? ringGeom : sphereGeom, m));
      }
      prewarmSubtree(live, grp).catch(() => {});
    } catch (_) { /* best effort */ }
  }

  function loadQuarrel() {
    if (quarrelLoad) return;
    quarrelLoad = decodeModel(live, THREE, QUARREL_SETUP).then((pieces) => {
      if (!root || !pieces.length) { stats.model = "none"; return; }
      quarrelMeshes = pieces.map((p) => {
        const im = new THREE.InstancedMesh(p.geometry, p.material, MAX_QUARRELS);
        im.count = 0;
        im.frustumCulled = false;
        im.castShadow = false;
        im.visible = false; // until its instanced program has linked off the frame
        root.add(im);
        return im;
      });
      stats.model = "loading-program";
      try {
        const grp = new THREE.Group();
        for (const im of quarrelMeshes) grp.add(new THREE.InstancedMesh(im.geometry, im.material, 1));
        prewarmSubtree(live, grp).then(() => {
          for (const im of quarrelMeshes || []) im.visible = true;
          stats.model = "ready";
        }).catch(() => {
          for (const im of quarrelMeshes || []) im.visible = true;
          stats.model = "ready";
        });
      } catch (_) {
        for (const im of quarrelMeshes) im.visible = true;
        stats.model = "ready";
      }
    }).catch(() => { stats.model = "failed"; });
  }

  /** A short additive flash at a muzzle, carried along at `vel` (the aircraft's velocity: a flash left hanging in the air
   *  read as a flat pale disc behind the aircraft on the 1070). */
  function addFlash(pos, r0, r1, life, vel) {
    if (!ensure()) return;
    let mesh;
    if (flashes.length >= 48) {
      mesh = flashes.shift().mesh;
    } else if (flashPool.length > 0) {
      mesh = flashPool.pop();
    } else {
      mesh = new THREE.Sprite(flashMat.clone());
      mesh.renderOrder = 6;
      root.add(mesh);
    }
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.scale.setScalar(SOFT * r0);
    mesh.material.opacity = 1;
    mesh.visible = true;
    flashes.push({ mesh, t: 0, life, r0, r1, vel: Array.isArray(vel) ? vel : null });
    stats.flashes++;
  }

  // ------------------------------------------------------------------ explosions

  function explode(at, lb) {
    try { deps.onExplode?.(at, lb); } catch (_) {}
    if (!ensure()) return;
    stats.explosions++;
    while (explosions.length >= MAX_EXPLOSIONS) disposeExplosion(explosions.shift());
    const big = (lb || 1000) >= 1500;
    const R = big ? BLAST.fireball2000 : BLAST.fireball1000;
    const rnd = (a, b) => a + Math.random() * (b - a);
    const add = (geom, mat, order) => { const m = geom ? new THREE.Mesh(geom, mat) : new THREE.Sprite(mat); m.renderOrder = order; root.add(m); return m; };
    // the fireball: lobes of different heat (yellow core → orange → red rim), staggered, each swelling and rising, so the
    // additive overlap reads as billowing fire instead of one flat disc (the 1070 look, 2026-11-02)
    const FIRE = [0xffe070, 0xffb040, 0xff8a2a, 0xff6a20, 0xe04818, 0xb83010];
    const lobes = [];
    const nLobes = big ? 11 : 8;
    for (let i = 0; i < nLobes; i++) {
      const mat = fireMat.clone();
      mat.color.setHex(FIRE[Math.min(FIRE.length - 1, Math.floor((i / nLobes) * FIRE.length))]);
      const a = rnd(0, Math.PI * 2), rr = i === 0 ? 0 : rnd(0.15, 0.55) * R;
      const m = add(null, mat, 6);
      m.position.set(at[0] + Math.cos(a) * rr, at[1] + Math.sin(a) * rr, at[2] + rnd(0.1, 0.45) * R);
      m.userData = { delay: i === 0 ? 0 : rnd(0, 0.18), size: i === 0 ? 0.55 : rnd(0.32, 0.5), vz: rnd(2, 7), life: rnd(1.1, 1.8) };
      m.scale.setScalar(0.01);
      lobes.push(m);
    }
    const flash = add(null, flashMat.clone(), 7);
    flash.position.set(at[0], at[1], at[2] + R * 0.3);
    const ring = add(ringGeom, ringMat.clone(), 6);
    ring.position.set(at[0], at[1], at[2] + 1.5);
    // thrown dirt: clods flung up and falling back under gravity
    const dirt = [];
    for (let i = 0; i < (big ? 10 : 6); i++) {
      const m = add(sphereGeom, dirtMat.clone(), 5);
      const a = rnd(0, Math.PI * 2), sp = rnd(8, 22) * (big ? 1.2 : 1);
      m.position.set(at[0], at[1], at[2] + 1);
      m.userData = { v: [Math.cos(a) * sp, Math.sin(a) * sp, rnd(18, 36) * (big ? 1.15 : 1)], size: rnd(0.5, 1.3) };
      m.scale.setScalar(m.userData.size);
      dirt.push(m);
    }
    // the smoke column: dark puffs rising and spreading, many seconds
    const smoke = [];
    const puffs = big ? 14 : 9;
    for (let i = 0; i < puffs; i++) {
      const mat = smokeMat.clone();
      mat.color.setHex(i % 3 === 0 ? 0x2a241e : i % 3 === 1 ? 0x1c1915 : 0x3a3129);
      const s = add(null, mat, 5);
      const a = rnd(0, Math.PI * 2), rr = rnd(0, 0.45) * R;
      s.position.set(at[0] + Math.cos(a) * rr, at[1] + Math.sin(a) * rr, at[2] + rnd(0.2, 0.6) * R);
      s.userData = { vz: rnd(6, 14), drift: [Math.cos(a) * rnd(0.6, 2.5), Math.sin(a) * rnd(0.6, 2.5)], grow: rnd(0.12, 0.22), delay: rnd(0.2, 1.0), size0: rnd(0.4, 0.65) };
      s.scale.setScalar(0.01);
      smoke.push(s);
    }
    explosions.push({ at, R, t: 0, lobes, flash, ring, dirt, smoke, shake: big ? BLAST.shake2000 : BLAST.shake1000 });
  }

  function disposeExplosion(e) {
    for (const m of [...e.lobes, e.flash, e.ring, ...e.dirt, ...e.smoke]) { try { m.parent?.remove(m); m.material.dispose(); } catch (_) {} }
  }

  function tickExplosions(dt) {
    for (let i = explosions.length - 1; i >= 0; i--) {
      const e = explosions[i];
      e.t += dt;
      const t = e.t;
      for (const m of e.lobes) {
        const u = m.userData, tl = t - u.delay;
        if (tl <= 0) { m.visible = false; continue; }
        const g = Math.min(1, tl / 0.5);
        m.scale.setScalar(SOFT * e.R * u.size * (0.3 + 0.7 * (1 - (1 - g) * (1 - g))) * (1 + 0.25 * tl));
        m.position.z += u.vz * dt;
        m.material.opacity = Math.max(0, 1 - Math.max(0, tl - 0.25) / u.life);
        m.visible = m.material.opacity > 0.01;
      }
      for (const m of e.dirt) {
        const v = m.userData.v;
        v[2] -= 9.8 * dt;
        m.position.x += v[0] * dt; m.position.y += v[1] * dt; m.position.z += v[2] * dt;
        if (m.position.z < e.at[2]) { m.visible = false; v[0] = v[1] = v[2] = 0; m.position.z = e.at[2] - 1; }
      }
      e.flash.scale.setScalar(SOFT * e.R * (0.3 + 0.8 * Math.min(1, t / 0.12)));
      e.flash.material.opacity = Math.max(0, 1 - t / 0.25);
      e.flash.visible = e.flash.material.opacity > 0.01;
      // the dust skirt: out to ~3 R (72 m for the 2,000 lb) in 0.8 s, faint and gone by then
      const rg = Math.min(1, t / 0.8);
      e.ring.scale.setScalar(e.R * (0.6 + 2.4 * (1 - (1 - rg) * (1 - rg))));
      e.ring.material.opacity = Math.max(0, 0.4 * (1 - t / 0.8));
      e.ring.visible = e.ring.material.opacity > 0.01;
      for (const s of e.smoke) {
        const u = s.userData, ts = t - u.delay;
        if (ts <= 0) { s.visible = false; continue; }
        s.position.z += u.vz * dt * Math.max(0.3, 1 - ts / 10);
        s.position.x += u.drift[0] * dt;
        s.position.y += u.drift[1] * dt;
        s.scale.setScalar(SOFT * e.R * (u.size0 + u.grow * ts));
        s.material.opacity = Math.max(0, 0.85 * Math.min(1, ts / 0.6) * (1 - ts / 10));
        s.visible = s.material.opacity > 0.01;
      }
      if (t > 11) { disposeExplosion(e); explosions.splice(i, 1); }
    }
  }

  // ------------------------------------------------------------------ bombs

  function bombKey(vehicle, station) { return `${vehicle >>> 0}:${station | 0}`; }

  function noteExploded(key, at) {
    recent.push({ key, at, t: (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000 });
    if (recent.length > 16) recent.shift();
  }

  /**
   * A BombRelease: fly the station's own meshes from the event's state. `meshes` = the airframe's ordnance meshes of the
   * station (vehicle frame), `muzzle` = the station point, `advanceSteps` = steps to run at once (the pilot's lead).
   */
  function releaseBomb(ev, opts) {
    if (!ensure()) return;
    while (bombs.length >= MAX_BOMBS) removeBomb(bombs.shift());
    const [x, y, z] = toGlobal(ev.cell, ev.x, ev.y, ev.z);
    const vel = Array.isArray(ev.vel) ? ev.vel : [0, 0, 0];
    const group = new THREE.Group();
    const mz = opts.muzzle ?? [0, 0, 0];
    for (const mesh of opts.meshes || []) {
      const c = new THREE.Mesh(mesh.geometry, mesh.material); // shared template geometry / material (not owned)
      c.position.set(-mz[0], -mz[1], -mz[2]);
      c.castShadow = mesh.castShadow;
      group.add(c);
    }
    root.add(group);
    const b = { key: bombKey(ev.vehicle, ev.aux), x, y, z, vx: vel[0], vy: vel[1], vz: vel[2], terminal: opts.terminal || 280,
      group, lb: ev.value || 1000, acc: 0, delay: Math.max(0, opts.delaySec || 0), px: x, py: y, pz: z };
    group.visible = b.delay <= 0;
    for (let i = 0; i < (opts.advanceSteps | 0) && i < 60; i++) { b.px = b.x; b.py = b.y; b.pz = b.z; stepBomb(b, DT); }
    bombs.push(b);
    stats.bombs++;
    poseBomb(b, 0);
  }

  function poseBomb(b, alpha) {
    const x = b.px + (b.x - b.px) * alpha, y = b.py + (b.y - b.py) * alpha, z = b.pz + (b.z - b.pz) * alpha;
    b.group.position.set(x, y, z);
    tmpV.set(b.vx, b.vy, b.vz);
    if (tmpV.lengthSq() > 1e-6) b.group.quaternion.setFromUnitVectors(yAxis, tmpV.normalize());
  }

  function removeBomb(b) {
    try { b.group.parent?.remove(b.group); } catch (_) { /* gone */ }
  }

  function tickBombs(dt) {
    for (let i = bombs.length - 1; i >= 0; i--) {
      const b = bombs[i];
      if (b.delay > 0) {
        b.delay -= dt;
        if (b.delay > 0) continue;
        b.group.visible = true;
      }
      b.acc += Math.min(0.5, dt);
      let hit = null;
      while (b.acc >= DT && !hit) {
        b.acc -= DT;
        b.px = b.x; b.py = b.y; b.pz = b.z;
        stepBomb(b, DT);
        const g = ground(b.x, b.y);
        if (Number.isFinite(g) && b.z <= g) hit = [b.x, b.y, g];
        else if (b.z < -2000) hit = [b.x, b.y, b.z];
      }
      if (hit) {
        removeBomb(b);
        bombs.splice(i, 1);
        explode(hit, b.lb);
        noteExploded(b.key, hit);
        continue;
      }
      poseBomb(b, Math.min(1, b.acc / DT));
    }
  }

  // ------------------------------------------------------------------ quarrels

  function addSalvo(rounds, speed, range) {
    if (!ensure()) return;
    stats.salvos++;
    const sp = Number.isFinite(speed) && speed > 1 ? speed : DEFAULT_SPEED;
    for (const r of rounds) {
      if (quarrels.length >= MAX_QUARRELS) quarrels.shift();
      quarrels.push({ o: r.o, d: r.d, t: 0, life: range / sp, speed: sp });
      stats.quarrels++;
    }
  }

  function tickQuarrels(dt) {
    if (!streakGeom) return;
    for (let i = quarrels.length - 1; i >= 0; i--) {
      const q = quarrels[i];
      q.t += dt;
      if (q.t > q.life) quarrels.splice(i, 1);
    }
    const pos = streakGeom.attributes.position.array;
    let n = 0;
    let k = 0;
    for (const q of quarrels) {
      const head = q.t * q.speed;
      const tail = Math.max(0, head - STREAK_LENGTH);
      pos[n++] = q.o[0] + q.d[0] * tail; pos[n++] = q.o[1] + q.d[1] * tail; pos[n++] = q.o[2] + q.d[2] * tail;
      pos[n++] = q.o[0] + q.d[0] * head; pos[n++] = q.o[1] + q.d[1] * head; pos[n++] = q.o[2] + q.d[2] * head;
      if (quarrelMeshes) {
        dummy.position.set(q.o[0] + q.d[0] * head, q.o[1] + q.d[1] * head, q.o[2] + q.d[2] * head);
        tmpV.set(q.d[0], q.d[1], q.d[2]);
        dummy.quaternion.setFromUnitVectors(yAxis, tmpV);
        dummy.scale.setScalar(QUARREL_SCALE);
        dummy.updateMatrix();
        for (const im of quarrelMeshes) im.setMatrixAt(k, dummy.matrix);
        k++;
      }
    }
    streakGeom.attributes.position.needsUpdate = n > 0 || streakGeom.drawRange.count > 0;
    streakGeom.setDrawRange(0, n / 3);
    if (quarrelMeshes) {
      for (const im of quarrelMeshes) {
        im.count = k;
        if (k) im.instanceMatrix.needsUpdate = true;
      }
    }
  }

  function tickFlashes(dt) {
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i];
      f.t += dt;
      const u = f.t / f.life;
      if (u >= 1) {
        f.mesh.visible = false;
        flashPool.push(f.mesh);
        flashes.splice(i, 1);
        continue;
      }
      if (f.vel) { f.mesh.position.x += f.vel[0] * dt; f.mesh.position.y += f.vel[1] * dt; f.mesh.position.z += f.vel[2] * dt; }
      f.mesh.scale.setScalar(SOFT * (f.r0 + (f.r1 - f.r0) * u));
      f.mesh.material.opacity = (1 - u) * (1 - u);
    }
  }

  return {
    /** Pre-warm weapon meshes and shaders ahead of combat so the first salvo/bomb never compiles on the frame. */
    warm() { ensure(); },
    /**
     * A "fire" inbox message. v = the vehicle record; pose = the pose the spread frame is taken in ({heading, pitch,
     * bank}); origin0 = the first mount's world muzzle (the pilot's predicted one), else the message's.
     */
    fire(m, v, pose, origin0, vel) {
      const profile = v?.profile;
      const w = profile?.weapons?.[m.mount];
      const q = pose ? orientation(pose.heading, pose.pitch, pose.bank) : [1, 0, 0, 0];
      const o0 = origin0 ?? toGlobal(m.cell, m.x, m.y, m.z);
      const kind = w?.kind ?? KIND.GUN;
      if (kind === KIND.MISSILE) {
        addFlash(o0, 0.3, 1.3, 0.14, vel);
        return;
      }
      if (kind === KIND.BOMB) return;
      const rounds = profile ? salvoRounds(profile, m, o0, q) : [];
      addSalvo(rounds, m.speed, w?.range ?? 140);
      // muzzle flashes, one per gun (tiny, short)
      const seen = new Set();
      for (const r of rounds) if (!seen.has(r.mount)) { seen.add(r.mount); addFlash(r.o, 0.12, 0.35, 0.06, vel); }
    },
    releaseBomb,
    /** The server's Explosion event: drawn unless our own twin already burst there. */
    explosionEvent(ev) {
      const at = toGlobal(ev.cell, ev.x, ev.y, ev.z);
      const key = bombKey(ev.vehicle, ev.aux);
      const now = (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
      const r = recent.find((e) => e.key === key && now - e.t < 5 && Math.hypot(e.at[0] - at[0], e.at[1] - at[1]) < 60);
      if (r) { stats.deduped++; return; }
      // our twin still falling (it lags the server by up to the observer delay): burst it at the server's point
      const i = bombs.findIndex((b) => b.key === key);
      if (i >= 0) { removeBomb(bombs[i]); bombs.splice(i, 1); }
      stats.eventExplosions++;
      explode(at, ev.value);
      noteExploded(key, at);
    },
    /** Camera shake (m) at an eye position: recent explosions within range. */
    shakeAt(eye) {
      let a = 0;
      for (const e of explosions) {
        const d = Math.hypot(eye[0] - e.at[0], eye[1] - e.at[1], eye[2] - e.at[2]);
        if (d > BLAST.shakeRange) continue;
        a += e.shake * Math.exp(-e.t / 0.45) * (1 - d / BLAST.shakeRange);
      }
      return a;
    },
    tick(dt) {
      if (!root) return;
      tickQuarrels(dt);
      tickFlashes(dt);
      tickBombs(dt);
      tickExplosions(dt);
    },
    stats: () => ({ ...stats, liveQuarrels: quarrels.length, liveBombs: bombs.length, liveExplosions: explosions.length, liveFlashes: flashes.length }),
    /** Bench / debug: an explosion now at an AC world point. */
    debugExplode(at, lb) { explode(at, lb); },
    dispose() {
      for (const b of bombs) removeBomb(b);
      bombs.length = 0;
      for (const e of explosions) disposeExplosion(e);
      explosions.length = 0;
      for (const f of flashes) { try { f.mesh.parent?.remove(f.mesh); f.mesh.material.dispose(); } catch (_) {} }
      flashes.length = 0;
      for (const s of flashPool) { try { s.parent?.remove(s); s.material.dispose(); } catch (_) {} }
      flashPool.length = 0;
      quarrels.length = 0;
      try {
        for (const im of quarrelMeshes || []) { im.parent?.remove(im); im.geometry.dispose(); im.dispose?.(); }
        root?.parent?.remove(root);
        streakGeom?.dispose(); streakMat?.dispose();
        sphereGeom?.dispose(); ringGeom?.dispose();
        fireMat?.dispose(); flashMat?.dispose(); smokeMat?.dispose(); ringMat?.dispose(); dirtMat?.dispose();
        softTex?.dispose(); ringTex?.dispose();
      } catch (_) { /* gone */ }
      quarrelMeshes = null;
      root = null; streakGeom = null; streakLines = null;
    },
  };
}

/** v1 API kept for the tests / benches that import it: a tracer pool over createWeaponsFx. */
export function createTracers(deps = {}) {
  const fx = createWeaponsFx(deps);
  return {
    add(m, v, originOverride, poseOverride) {
      const pose = poseOverride ?? (v?.last ? { heading: v.last.heading, pitch: v.last.pitch, bank: v.last.bank } : null);
      fx.fire(m, v, pose, originOverride);
    },
    tick: (dt) => fx.tick(dt),
    stats: () => { const s = fx.stats(); return { live: s.liveQuarrels, added: s.quarrels }; },
    dispose: () => fx.dispose(),
  };
}
