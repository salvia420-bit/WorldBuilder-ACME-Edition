// tools/rust_parity/gen_anim_scenery.mjs — the REAL animated_scenery.js (three
// r184 AnimationMixer, the SetOmega orbit, anim_scenery_gpu.js pose rows) as
// the reference for crates/holtburger-scene/src/anim_scenery.rs
// (tests/anim_scenery_parity.rs) and tests/rust_anim_scenery_parity.test.mjs.
// Lane notes: docs/2026-10-26-rust-anim-terrain.md.
//
// Two sections:
//   clips   — buildSceneryAnimationClip + an AnimationMixer built exactly as
//             getOrCreateDidGroup / getOrCreateWindGroup build theirs (open
//             and closed loops, several rates, dt sequences including 0, the
//             0.1 s clamp and negative steps), recording every template part's
//             position / quaternion after every update;
//   module  — attachAnimatedScenery with a mock wasm (real client_portal.dat
//             seagull frames + synthetic clips), driven through the module's
//             own rAF loop on a scripted clock: groups created, disposed
//             (their last instance reclaimed) and re-created, pose-table rows
//             with and without the ?animSceneryUnbake post matrix, the orbit
//             at varying ?animSceneryOmegaHz. Recorded per frame: the loop's
//             dt, every group's template parts / orbit / clocks, and every
//             pose-table row.
//
// Run (from apps/holtburger-web): node tools/rust_parity/gen_anim_scenery.mjs
// → crates/holtburger-scene/tests/fixtures/anim_scenery.json

import { f32arr, f64arr, f64hex, writeFixture } from "./fixture_util.mjs";

let _pendingRaf = null;
globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.requestAnimationFrame = (cb) => { _pendingRaf = cb; return 1; };
globalThis.window.cancelAnimationFrame = () => {};

const THREE = await import("three");
const AS = await import("../../scene3d/animated_scenery.js");
const GPU = await import("../../scene3d/anim_scenery_gpu.js");

/** Test seam: take the module rAF loop's pending callback (null when not armed). */
export function __takeRaf() {
  const cb = _pendingRaf;
  _pendingRaf = null;
  return cb;
}

// ---------------------------------------------------------------------------
// Clip data. Layout per (frame, part): [ox, oy, oz, qw, qx, qy, qz].
// ---------------------------------------------------------------------------

// Real client_portal.dat: Animation 0x03000751 = Setup 0x020005AC's
// default_animation (the seagull), 2 parts x 7 frames, and its frame-0
// SetOmega payload (tests/animated_scenery_omega.test.mjs).
export const SEAGULL_FRAMES = new Float32Array([
  -1.04907e-06, -12, 15, -0.706138, -0.0370071, 0.0370071, -0.706138, -1.04907e-06, -12, 15, -0.037624, -0.706105, 0.706105, -0.037624,
  -1.04907e-06, -12, 15, -0.703956, 0.0666767, -0.0666767, -0.703956, -1.04907e-06, -12, 15, 0.066432, -0.703979, 0.703979, 0.066432,
  -1.04907e-06, -12, 15, -0.694115, 0.134922, -0.134922, -0.694115, -1.04907e-06, -12, 15, 0.134922, -0.694115, 0.694115, 0.134922,
  -1.04907e-06, -12, 15, -0.701729, 0.0870441, -0.0870442, -0.701729, -1.04907e-06, -12, 15, 0.0869059, -0.701746, 0.701746, 0.0869059,
  -1.04907e-06, -12, 15, -0.706714, -0.0235722, 0.0235722, -0.706714, -1.04907e-06, -12, 15, -0.0241324, -0.706695, 0.706695, -0.0241324,
  -1.04907e-06, -12, 15, -0.692866, -0.1412, 0.1412, -0.692865, -1.04907e-06, -12, 15, -0.142198, -0.692661, 0.692661, -0.142198,
  -1.04907e-06, -12, 15, -0.679715, -0.194905, 0.194905, -0.679715, -1.04907e-06, -12, 15, -0.196092, -0.679373, 0.679373, -0.196092,
]);
export const SEAGULL_OMEGA = new Float32Array([0, 1.314281683484353e-9, -0.03839724138379097]);

function qAxis(ax, ay, az, angle) {
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(ax, ay, az).normalize(), angle);
}

/** A wing-like 2-part clip with LARGE per-frame turns (slerp branch). */
export function wingFrames(nf = 6) {
  const out = [];
  for (let f = 0; f < nf; f++) {
    const a = (f / nf) * Math.PI * 2;
    const q0 = qAxis(0.3, 0.2, 1, Math.sin(a) * 0.8);
    out.push(0.5, -12, 15, q0.w, q0.x, q0.y, q0.z);
    const q1 = qAxis(1, 0, 0, Math.cos(a) * 0.4);
    out.push(0, 0.2 * Math.sin(a), 1.5, q1.w, q1.x, q1.y, q1.z);
  }
  return new Float32Array(out);
}

/** A 3-part clip with TINY per-frame turns (lerp + normalize branch); part 0
 *  starts at the identity frame (no unbake post, hinge-seeded row). */
export function creepFrames(nf = 9) {
  const out = [];
  for (let f = 0; f < nf; f++) {
    const e = f / (nf - 1);
    const q0 = f === 0 ? new THREE.Quaternion() : qAxis(0, 0, 1, 0.004 * f);
    out.push(f === 0 ? 0 : 0.01 * e, 0, 0, q0.w, q0.x, q0.y, q0.z);
    const q1 = qAxis(0.2, 1, 0.1, 0.5 + 0.01 * f);
    out.push(1.25, -0.5 + 0.03 * e, 2.0, q1.w, q1.x, q1.y, q1.z);
    // Part 2 flips its quaternion sign between frames (dot < 0 branch).
    const q2 = qAxis(1, 1, 0, 2.6 + 0.05 * f);
    const s = f % 2 === 0 ? 1 : -1;
    out.push(-3, 4, 0.5 + 0.1 * Math.sin(e * 6), s * q2.w, s * q2.x, s * q2.y, s * q2.z);
  }
  return new Float32Array(out);
}

/** A single-frame clip (every evaluate is a sample copy). */
export function stillFrames() {
  const q = qAxis(0, 1, 0, 0.3);
  return new Float32Array([0.25, 0.5, 3, q.w, q.x, q.y, q.z]);
}

// ---------------------------------------------------------------------------
// Section 1 — clips: the mixer exactly as getOrCreate{Did,Wind}Group builds it.
// ---------------------------------------------------------------------------

function mixerFor(frames, numParts, numFrames, fps, closedLoop) {
  const clip = AS.buildSceneryAnimationClip(THREE, frames, numParts, numFrames, fps,
    closedLoop === undefined ? undefined : { closedLoop });
  if (!clip) return null;
  const template = new THREE.Group();
  const parts = [];
  for (let i = 0; i < numParts; i++) {
    const g = new THREE.Group();
    g.name = `part${i}`;
    template.add(g);
    parts.push(g);
  }
  const mixer = new THREE.AnimationMixer(template);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.play();
  return { clip, mixer, action, parts };
}

function partsSnapshot(parts) {
  const out = [];
  for (const p of parts) {
    out.push(p.position.x, p.position.y, p.position.z, p.quaternion._x, p.quaternion._y, p.quaternion._z, p.quaternion._w);
  }
  return out;
}

const CLIP_DTS = [0, 1 / 60, 1 / 60, 1 / 30, 0.1, 1 / 144, 0.05, 0, 1 / 60, 0.0333, 0.07, 1 / 45, 0.1, 0.1, 0.1,
  1 / 60, -1 / 60, -0.05, 1 / 30, 0.0125, 0.29, 1 / 60];

function clipCases() {
  const cases = [];
  const specs = [
    { name: "seagull-open-30", frames: SEAGULL_FRAMES, np: 2, nf: 7, fps: 30, closed: false },
    { name: "wing-open-30", frames: wingFrames(6), np: 2, nf: 6, fps: 30, closed: false },
    { name: "wing-closed-24", frames: wingFrames(6), np: 2, nf: 6, fps: 24, closed: true },
    { name: "creep-open-30", frames: creepFrames(9), np: 3, nf: 9, fps: 30, closed: false },
    { name: "creep-closed-default", frames: creepFrames(9), np: 3, nf: 9, fps: 12.5, closed: undefined },
    { name: "still-open-30", frames: stillFrames(), np: 1, nf: 1, fps: 30, closed: false },
    { name: "still-closed-0fps", frames: stillFrames(), np: 1, nf: 1, fps: 0, closed: true },
    // A plain-Array source (the synthetic wind clip's shape): values rounded
    // to f32 by the track arrays, exactly like Float32Array.from.
    { name: "wing-array-17", frames: Array.from(wingFrames(5), (v, i) => v + (i % 3) * 1e-9), np: 2, nf: 5, fps: 17, closed: undefined },
  ];
  for (const s of specs) {
    const m = mixerFor(s.frames, s.np, s.nf, s.fps, s.closed);
    const steps = [];
    let i = 0;
    for (const dt of CLIP_DTS.concat(CLIP_DTS, CLIP_DTS)) {
      m.mixer.update(dt);
      steps.push({ dt: f64hex(dt), parts: f64arr(partsSnapshot(m.parts)), time: f64hex(m.action.time), mixerTime: f64hex(m.mixer.time) });
      i += 1;
    }
    cases.push({
      name: s.name,
      frames: f32arr(Float32Array.from(s.frames)),
      numParts: s.np,
      numFrames: s.nf,
      fps: f64hex(s.fps),
      closedLoop: s.closed !== false,
      duration: f64hex(m.clip.duration),
      times: f32arr(m.clip.tracks[0].times),
      steps,
    });
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Section 2 — module: attachAnimatedScenery + the rAF loop on a scripted clock.
// ---------------------------------------------------------------------------

export const DID = {
  seagull: { setup: 0x020005ac, anim: 0x03000751, np: 2, nf: 7, frames: () => SEAGULL_FRAMES, omega: SEAGULL_OMEGA },
  wing: { setup: 0x02000493, anim: 0x030006cb, np: 2, nf: 6, frames: () => wingFrames(6), omega: null },
  creep: { setup: 0x02000200, anim: 0x03000200, np: 3, nf: 9, frames: () => creepFrames(9), omega: new Float32Array([0.004, -0.002, 0.012]) },
  still: { setup: 0x02000100, anim: 0x03000100, np: 1, nf: 1, frames: () => stillFrames(), omega: null },
};

function tri() {
  return {
    triCount: 1,
    positions: new Float32Array([0, 0, 0, 0.4, 0, 0, 0, 0.2, 0]),
    uvs: new Float32Array(6),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    surfaceIndices: new Uint8Array([0]),
    surfaces: new Uint32Array([0x08000010]),
  };
}

/** The mock wasm exports (fetchAnimation / fetchBuildingPlacement). */
export function mockWasm() {
  const bySetup = new Map(Object.values(DID).map((d) => [d.setup, d]));
  const byAnim = new Map(Object.values(DID).map((d) => [d.anim, d]));
  return {
    async fetchAnimation(animId) {
      const d = byAnim.get(animId >>> 0);
      const a = { numParts: d.np, numFrames: d.nf, flags: 2, frames: Float32Array.from(d.frames()), free() {} };
      if (d.omega) a.setOmega = d.omega;
      return a;
    },
    async fetchBuildingPlacement(setupId) {
      const d = bySetup.get(setupId >>> 0);
      const hinge = [];
      for (let i = 0; i < d.np; i++) hinge.push({ x: 0.1 * i, y: -0.2 * i, z: 0.3 * i, qw: 1, qx: 0, qy: 0, qz: 0 });
      return {
        partCount: d.np,
        takePartMeshes: () => Array.from({ length: d.np }, tri),
        takePartHingeFrames: () => hinge,
        free() {},
      };
    },
    fetch_surfaces_pixels: async () => [],
  };
}

const LB_A = 0xa9b30000;
const LB_B = 0xa9b40000;

/** Placements: every DID twice, tilted / scaled, in two landblocks. */
export function placements(salt = 0) {
  const out = [];
  let idx = 1 + salt * 100;
  for (const [i, d] of Object.values(DID).entries()) {
    for (let k = 0; k < 2; k++) {
      const yaw = 0.7 * i + 1.3 * k;
      const q = qAxis(0, 0, 1, yaw);
      if ((i + k) % 2 === 1) q.premultiply(qAxis(1, 0.5, 0.2, 0.4));
      out.push({
        objId: d.setup, defaultAnimationId: d.anim, landblockId: k === 0 ? LB_A : LB_B, sourceObjIdx: idx++,
        x: 20 + 30 * i + salt, y: 40 + 25 * k, z: 50 + i, qw: q.w, qx: q.x, qy: q.y, qz: q.z, scale: k === 1 ? 1.5 : 1,
      });
    }
  }
  return out;
}

/** A scene3d with a real scene graph (scene → worldRoot → staticsGroup). */
export function makeWorld() {
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2;
  scene.add(worldRoot);
  const staticsGroup = new THREE.Group();
  worldRoot.add(staticsGroup);
  const camera = new THREE.PerspectiveCamera(60, 1.5, 0.5, 3000);
  scene.add(camera);
  const scene3d = { scene, worldRoot, staticsGroup, camera, activeLights: [],
    materialCache: { get: async () => new THREE.MeshStandardMaterial() } };
  return scene3d;
}

/** The scripted frame clock (ms per frame) the module scenario walks. */
export const MODULE_FRAME_MS = [
  16.667, 16.667, 33.333, 8.333, 16.667, 120, 16.667, 16.667, 0, 16.667, 22.5, 16.667, 16.667, 41.7, 16.667, 6.944,
];

/**
 * The module scenario. `hooks.beforeFrame(f, world)` / `hooks.afterFrame(f,
 * world)` let the node test snapshot; the default records the fixture.
 * Frames: 0-23 everything live; 24 the seagull anchors are removed (their
 * group is disposed by the reclaim); 30 landblock B is parked (its anchors
 * detached, LRU says parked → collapse, groups stay); 36 the seagulls come
 * back (group re-created at time 0, its rows re-bound); omega Hz changes at
 * 12 and 40; 48 frames in all.
 */
export async function runModuleScenario(hooks = {}) {
  const scene3d = makeWorld();
  const wasm = mockWasm();
  let clockMs = 1000;
  AS.setSceneryTimeSource(() => clockMs);
  AS.__setAnimSceneryOmegaHzForTest(15);
  const parked = new Set();
  window.__landblockLru = { isParked: (lb) => parked.has(((lb >>> 0) & 0xffff0000) >>> 0) };
  const r0 = await AS.attachAnimatedScenery(scene3d, placements(0), wasm, {});
  if (r0.built !== 8) throw new Error(`setup: built ${r0.built}`);
  hooks.afterBuild?.(scene3d);
  const removed = [];
  for (let f = 0; f < 48; f++) {
    if (f === 12) AS.__setAnimSceneryOmegaHzForTest(30);
    if (f === 40) AS.__setAnimSceneryOmegaHzForTest(7.5);
    if (f === 24) {
      for (const c of [...scene3d.staticsGroup.children]) {
        if (c.userData?.isAnimatedScenery && c.name === `anim-scenery-0x${DID.seagull.setup.toString(16)}`) {
          scene3d.staticsGroup.remove(c);
          removed.push(c);
        }
      }
    }
    if (f === 30) {
      parked.add(LB_B);
      for (const c of [...scene3d.staticsGroup.children]) {
        if (c.userData?.isAnimatedScenery && (c.userData.landblockId >>> 0) === LB_B) scene3d.staticsGroup.remove(c);
      }
    }
    if (f === 36) {
      const back = placements(1).filter((p) => p.objId === DID.seagull.setup);
      const r = await AS.attachAnimatedScenery(scene3d, back, wasm, {});
      if (r.built !== back.length) throw new Error(`re-attach: built ${r.built}`);
      hooks.afterBuild?.(scene3d);
    }
    hooks.beforeFrame?.(f, scene3d);
    clockMs += MODULE_FRAME_MS[f % MODULE_FRAME_MS.length];
    if (!_pendingRaf) throw new Error("rAF loop not armed");
    const cb = _pendingRaf;
    _pendingRaf = null;
    cb();
    hooks.afterFrame?.(f, scene3d);
  }
  const out = { scene3d, removed };
  AS.setSceneryTimeSource(null);
  delete window.__landblockLru;
  return out;
}

/** Template parts, orbit and clocks of every live group, keyed by DID. */
export function groupsSnapshot() {
  const out = {};
  for (const [key, g] of AS.__animSceneryGroupsForTest()) {
    out[String(key)] = {
      parts: partsSnapshot(g.parts),
      orbit: [g.orbitQ ? g.orbitQ._x : 0, g.orbitQ ? g.orbitQ._y : 0, g.orbitQ ? g.orbitQ._z : 0, g.orbitQ ? g.orbitQ._w : 1],
      orbitAngle: g.orbitAngle ?? 0,
    };
  }
  return out;
}

/** Every allocated pose-table row (32 f32 each, row 1 first). */
export function rowsSnapshot() {
  const rows = GPU.poseRows();
  const out = [];
  for (const r of rows) out.push(GPU.__poseRowForTest(r.row));
  return out;
}

async function moduleCase() {
  GPU.__setAnimSceneryGpuForTest(true);
  const events = [];
  const frames = [];
  const known = new Map(); // key -> group object
  let rowsSeen = 0;
  const diffGroups = (phase) => {
    const live = AS.__animSceneryGroupsForTest();
    for (const [key, g] of [...known]) {
      if (live.get(key) !== g) {
        events.push({ phase, kind: "unregisterGroup", key: Number(key) });
        known.delete(key);
      }
    }
    for (const [key, g] of live) {
      if (known.get(key) === g) continue;
      const d = Object.values(DID).find((x) => x.anim === key);
      const om = g.omega;
      events.push({
        phase, kind: "registerGroup", key: Number(key), numParts: d.np, numFrames: d.nf,
        fps: f64hex(30), closedLoop: false, frames: f32arr(Float32Array.from(d.frames())),
        omega: om ? f64arr([om.axis.x, om.axis.y, om.axis.z, om.rad]) : null,
      });
      known.set(key, g);
    }
    const rows = GPU.poseRows();
    for (; rowsSeen < rows.length; rowsSeen++) {
      const r = rows[rowsSeen];
      const init = GPU.__poseRowForTest(r.row).slice(0, 16);
      events.push({
        phase, kind: "registerRow", row: r.row, key: Number(r.animId), part: r.partIdx,
        post: r.post ? f64arr(r.post.elements) : null,
        // The seed the table holds: f32(initMat) (identity when none) — exact
        // as f64, and rounds to the same f32 again in the kernel.
        init: f64arr(init),
      });
    }
  };
  await runModuleScenario({
    afterBuild() { diffGroups("beforeFrame"); },
    beforeFrame(f) { diffGroups("beforeFrame"); events.push({ phase: "frame", kind: "frame", frame: f }); },
    afterFrame(f) {
      const diag = AS.animatedSceneryDiag();
      frames.push({
        frame: f,
        dt: f64hex(diag.lastDt),
        omegaHz: f64hex(AS.animSceneryOmegaHz()),
        groups: Object.fromEntries(Object.entries(groupsSnapshot()).map(([k, v]) => [k, {
          parts: f64arr(v.parts), orbit: f64arr(v.orbit), orbitAngle: f64hex(v.orbitAngle),
        }])),
        rows: rowsSnapshot().map((r) => f32arr(r)),
      });
      // Groups disposed by this frame's reclaim leave AFTER its advance.
      diffGroups("afterFrame");
    },
  });
  AS.disposeAnimatedScenery();
  GPU.__setAnimSceneryGpuForTest(undefined);
  AS.__setAnimSceneryOmegaHzForTest(undefined);
  return { events, frames };
}

// Only write the fixture when run directly (the node test imports helpers).
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("gen_anim_scenery.mjs");
if (isMain) {
  const clips = clipCases();
  const module = await moduleCase();
  const path = writeFixture("anim_scenery", { three: THREE.REVISION, defaultFps: f64hex(30), clips, module });
  console.log(`wrote ${clips.length} clip cases, ${module.frames.length} module frames, ${module.events.length} events → ${path}`);
}
