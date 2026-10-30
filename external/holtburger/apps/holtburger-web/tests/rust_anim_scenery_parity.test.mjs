// tests/rust_anim_scenery_parity.test.mjs — `?rustAnimScenery` (the per-DID
// template pose in Rust) and `?rustAnimSceneryGate` (the memoised per-instance
// gate) against the JS path, through the REAL bridge (scene3d/rust/
// anim_scenery.js) into the REAL animated_scenery.js / anim_scenery_gpu.js and
// three r184 objects. Lane notes: docs/2026-10-26-rust-anim-terrain.md.
//
// Part 1 (always runs; no wasm needed) — against `ModelSceneAnimScenery`, a
// line-for-line JS transcription of crates/holtburger-scene/src/anim_scenery.rs
// on a fake wasm memory that grows (detaching every view):
//   F  the checked-in fixture (crates/holtburger-scene/tests/fixtures/
//      anim_scenery.json) still equals what today's JS computes, and the model
//      replays it BIT FOR BIT (both sides on V8's fdlibm: the trig matches too);
//   C  the gen_anim_scenery module scenario (groups created, disposed and
//      re-created, parked landblocks, varying orbit rate) flag-off vs flag-on,
//      GPU rows (?animSceneryGpu on) and CPU slots (off), with and without the
//      gate: every pose-table row, every bucket's instanceMatrix / count /
//      visible, every template part and orbit — Object.is-equal, frame by frame.
//   G  the gate alone (no kernel) against the plain loop, plus its edge cases:
//      a hidden staticsGroup, an anchor re-parented to a second container
//      (attach), a hidden anchor, the LRU's bulk child removal (>= 16 kills),
//      a parent chain detached from the scene.
//   R  concurrent getOrCreateDidGroup for one DID (two attaches together, and
//      with frames between the two fetches), the DID's anchors all evicted,
//      the DID back with a second setup: kernel groups == map groups at every
//      step, rows / buckets / template parts == flag off;
//   F2 the kernel traps mid-session after memory growth + 6 registrations:
//      every group handed back to its mixer with the last advance's clocks —
//      every frame from the trap on == flag off, exactly;
//   F3 the first JS update after the trap lands on a pose equal to the mixer's
//      stale accu (the pre-play pose): still written.
// Part 2 (after the orchestrator's wasm build) — F, C, R, F2, F3 against the COMPILED
//   `SceneAnimScenery` from `${HB_PKG || "pkg"}/`: positions / clocks exact,
//   trig-derived values within 1 f32 ulp (rows, instance matrices) / 1e-15
//   (quaternions). Prints `SKIP — …` and exits 0 (when Part 1 passed) if the
//   class is absent.
//
// Run: node tests/rust_anim_scenery_parity.test.mjs   (HB_PKG=pkg-rustcore for a dev build)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const pkgDir = process.env.HB_PKG || "pkg";

const gen = await import("../tools/rust_parity/gen_anim_scenery.mjs");
const THREE = await import("three");
const AS = await import("../scene3d/animated_scenery.js");
const GPU = await import("../scene3d/anim_scenery_gpu.js");
const core = await import("../scene3d/rust/scene_core.js");
const bridge = await import("../scene3d/rust/anim_scenery.js");
const fu = await import("../tools/rust_parity/fixture_util.mjs");
const { removeChildrenBulk } = await import("../scene3d/bulk_child_remove.js");

let passed = 0, failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail != null && detail !== "" ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}

// ---------------------------------------------------------------------------
// ModelSceneAnimScenery — anim_scenery.rs in JS (same structure, same order),
// using three's Matrix4 / Quaternion where the kernel uses math.rs (pinned
// bit-exact to three r184 by math_parity.rs).
// ---------------------------------------------------------------------------
const PART_STRIDE = 7, GROUP_STRIDE = 7, ROW_FLOATS = 32;

function ppAt(pp, i) { return i >= 0 && i < pp.length ? pp[i] : undefined; }
const lt = (t, x) => (x === undefined ? false : t < x);
const ge = (t, x) => (x === undefined ? false : t >= x);

/** anim_scenery.rs `seek` → { copy: index } | { i1, t0, t1 }. */
function seek(pp, st, t) {
  const n = pp.length;
  let i1 = st.cached;
  let t1 = ppAt(pp, i1);
  let t0 = ppAt(pp, i1 - 1);
  validate_interval: {
    seek: {
      let right;
      linear_scan: {
        forward_scan: {
          if (!lt(t, t1)) {
            const giveUpAt = i1 + 2;
            for (;;) {
              if (t1 === undefined) {
                if (lt(t, t0)) break forward_scan;
                i1 = n;
                st.cached = i1;
                return { copy: Math.max(i1 - 1, 0) };
              }
              if (i1 === giveUpAt) break;
              t0 = t1;
              i1 += 1;
              t1 = ppAt(pp, i1);
              if (lt(t, t1)) break seek;
            }
            right = n;
            break linear_scan;
          }
        }
        if (!ge(t, t0)) {
          const t1global = ppAt(pp, 1);
          if (lt(t, t1global)) { i1 = 2; t0 = t1global; }
          const giveUpAt = i1 - 2;
          for (;;) {
            if (t0 === undefined) { st.cached = 0; return { copy: 0 }; }
            if (i1 === giveUpAt) break;
            t1 = t0;
            i1 -= 1;
            t0 = ppAt(pp, i1 - 1);
            if (ge(t, t0)) break seek;
          }
          right = i1;
          i1 = 0;
          break linear_scan;
        }
        break validate_interval;
      }
      while (i1 < right) {
        const mid = (i1 + right) >>> 1;
        if (t < pp[mid]) right = mid; else i1 = mid + 1;
      }
      t1 = ppAt(pp, i1);
      t0 = ppAt(pp, i1 - 1);
      if (t0 === undefined) { st.cached = 0; return { copy: 0 }; }
      if (t1 === undefined) { i1 = n; st.cached = i1; return { copy: Math.max(i1 - 1, 0) }; }
    }
    st.cached = i1;
  }
  if (t0 === undefined || t1 === undefined) return { copy: 0 };
  return { i1, t0, t1 };
}

/** anim_scenery.rs `slerp_flat` (three's slerpFlat on f32 keyframes). */
function slerpFlat(src, o0, o1, t) {
  let x0 = src[o0], y0 = src[o0 + 1], z0 = src[o0 + 2], w0 = src[o0 + 3];
  let x1 = src[o1], y1 = src[o1 + 1], z1 = src[o1 + 2], w1 = src[o1 + 3];
  if (w0 !== w1 || x0 !== x1 || y0 !== y1 || z0 !== z1) {
    let dot = x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1;
    if (dot < 0) { x1 = -x1; y1 = -y1; z1 = -z1; w1 = -w1; dot = -dot; }
    let s = 1 - t;
    if (dot < 0.9995) {
      const theta = Math.acos(dot);
      const sin = Math.sin(theta);
      s = Math.sin(s * theta) / sin;
      t = Math.sin(t * theta) / sin;
      x0 = x0 * s + x1 * t; y0 = y0 * s + y1 * t; z0 = z0 * s + z1 * t; w0 = w0 * s + w1 * t;
    } else {
      x0 = x0 * s + x1 * t; y0 = y0 * s + y1 * t; z0 = z0 * s + z1 * t; w0 = w0 * s + w1 * t;
      const f = 1 / Math.sqrt(x0 * x0 + y0 * y0 + z0 * z0 + w0 * w0);
      x0 *= f; y0 *= f; z0 *= f; w0 *= f;
    }
  }
  return [x0, y0, z0, w0];
}

/** anim_scenery.rs `Clip::build`. */
function buildClip(frames, np, nf, fps, closed) {
  if (!(np > 0) || !(nf > 0) || frames.length < np * nf * 7) return null;
  const dt = 1.0 / (fps > 0 ? fps : 30);
  const times = new Float32Array(nf);
  for (let f = 0; f < nf; f++) times[f] = f * dt;
  const pos = new Float32Array(np * nf * 3);
  const quat = new Float32Array(np * nf * 4);
  for (let p = 0; p < np; p++) {
    for (let f = 0; f < nf; f++) {
      const b = (f * np + p) * 7, po = (p * nf + f) * 3, qo = (p * nf + f) * 4;
      pos[po] = frames[b]; pos[po + 1] = frames[b + 1]; pos[po + 2] = frames[b + 2];
      quat[qo] = frames[b + 4]; quat[qo + 1] = frames[b + 5]; quat[qo + 2] = frames[b + 6]; quat[qo + 3] = frames[b + 3];
    }
  }
  const n = closed ? nf - 1 : nf;
  return { np, nf, times, pos, quat, duration: Math.max(dt, n * dt) };
}

function newGroup(key, clip, omega) {
  const np = clip.np;
  const accuQuat = new Float64Array(2 * np * 4);
  const objQuat = new Float64Array(np * 4);
  for (let p = 0; p < np; p++) { accuQuat[p * 4 + 3] = 1; accuQuat[(np + p) * 4 + 3] = 1; objQuat[p * 4 + 3] = 1; }
  return {
    key, clip, time: 0, loopCount: -1, mixerTime: 0, accuIndex: 0, st: { cached: 0 },
    accuPos: new Float64Array(2 * np * 3), accuQuat, objPos: new Float64Array(np * 3), objQuat,
    omega, orbitAngle: 0, orbitQ: new THREE.Quaternion(), partsOff: 0,
  };
}

function updateTime(g, delta) {
  const duration = g.clip.duration;
  let time = g.time + delta;
  let loopCount = g.loopCount;
  if (delta === 0) return time;
  if (loopCount === -1 && delta >= 0) loopCount = 0;
  if (time >= duration || time < 0) {
    const loopDelta = Math.floor(time / duration);
    time -= duration * loopDelta;
    loopCount += Math.abs(loopDelta);
  }
  g.loopCount = loopCount;
  g.time = time;
  return time;
}

function stepGroup(g, dt, hz) {
  const delta = dt * 1;
  g.mixerTime += delta;
  g.accuIndex ^= 1;
  const t = updateTime(g, delta * 1);
  const s = seek(g.clip.times, g.st, t);
  const { np, nf, pos, quat } = g.clip;
  const ai = g.accuIndex;
  for (let p = 0; p < np; p++) {
    let incP, incQ;
    const pb = p * nf * 3, qb = p * nf * 4;
    if (s.copy !== undefined) {
      incP = [pos[pb + s.copy * 3], pos[pb + s.copy * 3 + 1], pos[pb + s.copy * 3 + 2]];
      incQ = [quat[qb + s.copy * 4], quat[qb + s.copy * 4 + 1], quat[qb + s.copy * 4 + 2], quat[qb + s.copy * 4 + 3]];
    } else {
      const o1 = pb + s.i1 * 3, o0 = o1 - 3;
      const w1 = (t - s.t0) / (s.t1 - s.t0), w0 = 1 - w1;
      incP = [pos[o0] * w0 + pos[o1] * w1, pos[o0 + 1] * w0 + pos[o1 + 1] * w1, pos[o0 + 2] * w0 + pos[o1 + 2] * w1];
      const alpha = (t - s.t0) / (s.t1 - s.t0);
      const off = qb + s.i1 * 4;
      incQ = slerpFlat(quat, off - 4, off, alpha);
    }
    let a = (ai * np + p) * 3;
    g.accuPos.set(incP, a);
    let changed = false;
    for (let k = 0; k < 3; k++) if (g.accuPos[p * 3 + k] !== g.accuPos[(np + p) * 3 + k]) { changed = true; break; }
    if (changed) g.objPos.set(incP, p * 3);
    a = (ai * np + p) * 4;
    g.accuQuat.set(incQ, a);
    changed = false;
    for (let k = 0; k < 4; k++) if (g.accuQuat[p * 4 + k] !== g.accuQuat[(np + p) * 4 + k]) { changed = true; break; }
    if (changed) g.objQuat.set(incQ, p * 4);
  }
  if (g.omega) {
    const step = dt > 0 ? g.omega.rad * hz * dt : 0;
    g.orbitAngle = (g.orbitAngle + step) % (Math.PI * 2);
    g.orbitQ.setFromAxisAngle(g.omega.axis, g.orbitAngle);
  }
}

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _rot = new THREE.Matrix4();
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _one = new THREE.Vector3(1, 1, 1);
function writeRow(out, o, m, orbitQ) {
  const e = m.elements;
  for (let i = 0; i < 16; i++) out[o + i] = e[i];
  if (orbitQ) {
    const r = _rot.makeRotationFromQuaternion(orbitQ).elements;
    out[o + 16] = r[0]; out[o + 17] = r[1]; out[o + 18] = r[2]; out[o + 19] = 0;
    out[o + 20] = r[4]; out[o + 21] = r[5]; out[o + 22] = r[6]; out[o + 23] = 0;
    out[o + 24] = r[8]; out[o + 25] = r[9]; out[o + 26] = r[10]; out[o + 27] = 0;
  } else {
    out[o + 16] = 1; out[o + 17] = 0; out[o + 18] = 0; out[o + 19] = 0;
    out[o + 20] = 0; out[o + 21] = 1; out[o + 22] = 0; out[o + 23] = 0;
    out[o + 24] = 0; out[o + 25] = 0; out[o + 26] = 1; out[o + 27] = 0;
  }
  out[o + 28] = 0; out[o + 29] = 0; out[o + 30] = 0; out[o + 31] = 0;
}

function makeModelNamespace() {
  // Fake wasm memory: a bump allocator whose ArrayBuffer is REPLACED (and the
  // old one detached, like WebAssembly.Memory.grow) when it runs out.
  const memory = { buffer: new ArrayBuffer(256) };
  let top = 64;
  let grows = 0;
  function grow(minBytes) {
    const nb = new ArrayBuffer(Math.max(memory.buffer.byteLength * 2, minBytes));
    new Uint8Array(nb).set(new Uint8Array(memory.buffer));
    const old = memory.buffer;
    memory.buffer = nb;
    structuredClone(old, { transfer: [old] });
    grows += 1;
  }
  function alloc(bytes) {
    top = (top + 7) & ~7;
    if (top + bytes > memory.buffer.byteLength) grow(top + bytes + 64);
    const p = top;
    top += bytes;
    return p;
  }
  class ModelSceneAnimScenery {
    constructor() {
      this.nextSeq = 0;
      this.groups = []; this.freeSlots = []; this.holes = [];
      this.parts = []; this.group = []; this.rows = []; this.rowsOut = []; this.written = [];
      this.reg = { parts: [0, 0], group: [0, 0], rows: [0, 0], written: [0, 0] };
      this._sync();
    }
    _region(name, Ctor, data) {
      const r = this.reg[name];
      const bytes = data.length * Ctor.BYTES_PER_ELEMENT;
      if (bytes > r[1] || r[0] === 0) { r[0] = alloc(Math.max(bytes, 8)); r[1] = Math.max(bytes, 8); }
      new Ctor(memory.buffer, r[0], data.length).set(data);
    }
    _sync() {
      this._region("parts", Float64Array, this.parts);
      this._region("group", Float64Array, this.group);
      this._region("rows", Float32Array, this.rowsOut);
      this._region("written", Uint8Array, this.written);
    }
    _writeGroupOut(slot, g) {
      for (let p = 0; p < g.clip.np; p++) {
        const o = g.partsOff + p * PART_STRIDE;
        this.parts[o] = g.objPos[p * 3]; this.parts[o + 1] = g.objPos[p * 3 + 1]; this.parts[o + 2] = g.objPos[p * 3 + 2];
        this.parts[o + 3] = g.objQuat[p * 4]; this.parts[o + 4] = g.objQuat[p * 4 + 1];
        this.parts[o + 5] = g.objQuat[p * 4 + 2]; this.parts[o + 6] = g.objQuat[p * 4 + 3];
      }
      const o = slot * GROUP_STRIDE;
      this.group[o] = g.orbitQ.x; this.group[o + 1] = g.orbitQ.y; this.group[o + 2] = g.orbitQ.z; this.group[o + 3] = g.orbitQ.w;
      this.group[o + 4] = g.orbitAngle; this.group[o + 5] = g.mixerTime; this.group[o + 6] = g.time;
    }
    registerGroup(key, frames, np, nf, fps, closed, hasOmega, ax, ay, az, rad) {
      const clip = buildClip(Float32Array.from(frames), np, nf, fps, closed);
      if (!clip) return 0;
      const g = newGroup(key, clip, hasOmega ? { axis: new THREE.Vector3(ax, ay, az), rad } : null);
      g.regSeq = this.nextSeq++;
      const need = np * PART_STRIDE;
      const h = this.holes.findIndex(([, len]) => len === need);
      if (h >= 0) { g.partsOff = this.holes[h][0]; this.holes[h] = this.holes[this.holes.length - 1]; this.holes.pop(); }
      else { g.partsOff = this.parts.length; for (let i = 0; i < need; i++) this.parts.push(0); }
      let slot = this.freeSlots.pop();
      if (slot === undefined) { this.groups.push(null); slot = this.groups.length - 1; while (this.group.length < this.groups.length * GROUP_STRIDE) this.group.push(0); }
      this._writeGroupOut(slot, g);
      this.groups[slot] = g;
      if (key !== 0) for (const r of this.rows) if (r.key === key) r.bound = slot;
      this._sync();
      return slot + 1;
    }
    unregisterGroup(h) {
      const slot = h - 1;
      const g = this.groups[slot];
      if (!g) return false;
      this.groups[slot] = null;
      this.holes.push([g.partsOff, g.clip.np * PART_STRIDE]);
      this.freeSlots.push(slot);
      // No hand-back to another group of the key (anim_scenery.rs).
      for (const r of this.rows) if (r.bound === slot) r.bound = null;
      return true;
    }
    _latestSlotOf(key) {
      let best = -1, seq = -1;
      for (let i = 0; i < this.groups.length; i++) {
        const g = this.groups[i];
        if (g && g.key === key && g.regSeq > seq) { best = i; seq = g.regSeq; }
      }
      return best;
    }
    partsOffset(h) { const g = this.groups[h - 1]; return g ? g.partsOff : 0xffffffff; }
    slotOf(h) { return this.groups[h - 1] ? h - 1 : 0xffffffff; }
    registerRow(key, part, post, init) {
      const pm = post && post.length >= 16 ? new THREE.Matrix4().fromArray(post) : null;
      const bound = key === 0 ? -1 : this._latestSlotOf(key);
      this.rows.push({ key, part, post: pm, bound: bound >= 0 ? bound : null });
      const o = this.rowsOut.length;
      for (let i = 0; i < ROW_FLOATS; i++) this.rowsOut.push(0);
      const tmp = new Array(ROW_FLOATS).fill(0);
      writeRow(tmp, 0, init && init.length >= 16 ? new THREE.Matrix4().fromArray(init) : new THREE.Matrix4(), null);
      for (let i = 0; i < ROW_FLOATS; i++) this.rowsOut[o + i] = Math.fround(tmp[i]);
      this.written.push(0);
      this._sync();
      return this.rows.length - 1;
    }
    clearRows() { this.rows = []; this.rowsOut = []; this.written = []; this._sync(); }
    clear() { this.groups = []; this.freeSlots = []; this.holes = []; this.parts = []; this.group = []; this.clearRows(); }
    advance(dt, hz) {
      for (let slot = 0; slot < this.groups.length; slot++) {
        const g = this.groups[slot];
        if (!g) continue;
        stepGroup(g, dt, hz);
        this._writeGroupOut(slot, g);
      }
      let n = 0;
      const tmp = new Array(ROW_FLOATS);
      for (let k = 0; k < this.rows.length; k++) {
        const r = this.rows[k];
        this.written[k] = 0;
        if (r.bound === null) continue;
        const g = this.groups[r.bound];
        if (!g || r.part >= g.clip.np) continue;
        _v.set(g.objPos[r.part * 3], g.objPos[r.part * 3 + 1], g.objPos[r.part * 3 + 2]);
        _q._x = g.objQuat[r.part * 4]; _q._y = g.objQuat[r.part * 4 + 1]; _q._z = g.objQuat[r.part * 4 + 2]; _q._w = g.objQuat[r.part * 4 + 3];
        _m.compose(_v, _q, _one);
        const m = r.post ? _m2.multiplyMatrices(_m, r.post) : _m;
        writeRow(tmp, 0, m, g.omega ? g.orbitQ : null);
        for (let i = 0; i < ROW_FLOATS; i++) this.rowsOut[k * ROW_FLOATS + i] = Math.fround(tmp[i]);
        this.written[k] = 1;
        n += 1;
      }
      this._sync();
      return n;
    }
    partsPtr() { return this.reg.parts[0]; } partsLen() { return this.parts.length; }
    groupPtr() { return this.reg.group[0]; } groupLen() { return this.group.length; }
    rowsPtr() { return this.reg.rows[0]; } rowsLen() { return this.rowsOut.length; }
    rowsWrittenPtr() { return this.reg.written[0]; } rowsWrittenLen() { return this.written.length; }
    get groupCount() { return this.groups.filter(Boolean).length; }
    get rowCount() { return this.rows.length; }
    get partStride() { return PART_STRIDE; } get groupStride() { return GROUP_STRIDE; } get rowFloats() { return ROW_FLOATS; }
    free() {}
  }
  return {
    ns: { sceneCoreAbi: () => core.SCENE_CORE_ABI, SceneAnimScenery: ModelSceneAnimScenery },
    memory,
    grows: () => grows,
    /** Grow the fake memory now (every view on the old buffer detaches). */
    forceGrow: () => grow(memory.buffer.byteLength + 64),
  };
}

// ---------------------------------------------------------------------------
// Snapshots of what three.js ends up with.
// ---------------------------------------------------------------------------
function bucketsSnapshot(scene3d) {
  const out = [];
  const meshes = scene3d.staticsGroup.children.filter((o) => o.isInstancedMesh).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const b of meshes) out.push({ name: b.name, count: b.count, visible: b.visible, row: b.userData.animGpuRow, m: Array.from(b.instanceMatrix.array.subarray(0, b.count * 16)) });
  return out;
}
function anchorsSnapshot(scene3d) {
  return scene3d.staticsGroup.children.filter((o) => o.userData?.isAnimatedScenery).map((o) => [o.name, o.visible, ...o.matrix.elements]);
}

async function runScenario(flags) {
  GPU.__setAnimSceneryGpuForTest(flags.gpu);
  bridge.__setRustAnimSceneryForTest(flags.rust);
  AS.__setAnimSceneryGateForTest(flags.gate);
  bridge.__resetRustAnimSceneryForTest();
  const frames = [];
  // The collapse counters are module-wide and never reset: compare deltas.
  const c0 = AS.animatedSceneryCollapseStats();
  await gen.runModuleScenario({
    afterFrame(f, scene3d) {
      const c = AS.animatedSceneryCollapseStats();
      frames.push({
        f,
        rows: gen.rowsSnapshot(),
        groups: gen.groupsSnapshot(),
        buckets: bucketsSnapshot(scene3d),
        anchors: anchorsSnapshot(scene3d),
        collapse: { collapses: c.collapses - c0.collapses, restores: c.restores - c0.restores },
        instances: AS.animatedSceneryDiag().instances,
      });
    },
  });
  const diag = AS.animatedSceneryDiag();
  AS.disposeAnimatedScenery();
  GPU.__setAnimSceneryGpuForTest(undefined);
  bridge.__setRustAnimSceneryForTest(undefined);
  AS.__setAnimSceneryGateForTest(undefined);
  return { frames, diag };
}

/** Compare two runs. `tol`: null = Object.is everywhere; else f32 ulps for
 *  rows / instance matrices and an absolute bound for quaternions. */
function compareRuns(label, a, b, tol) {
  let bad = 0, maxUlp = 0, maxQ = 0;
  const f32ulps = (x, y) => {
    if (Object.is(x, y)) return 0;
    const fa = new Float32Array([x, y]);
    const ia = new Int32Array(fa.buffer);
    const s = (i) => (i < 0 ? -2147483648 - i : i);
    return Math.abs(s(ia[0]) - s(ia[1]));
  };
  const cmpF32 = (x, y, what) => {
    if (Object.is(x, y)) return;
    const d = f32ulps(x, y);
    maxUlp = Math.max(maxUlp, d);
    if (tol === null || d > tol.ulp) { if (bad++ < 5) console.log(`      ${label}: ${what}: ${x} vs ${y} (${d} ulp)`); }
  };
  if (a.frames.length !== b.frames.length) { check(`${label}: same frame count`, false); return; }
  for (let i = 0; i < a.frames.length; i++) {
    const fa = a.frames[i], fb = b.frames[i];
    if (fa.rows.length !== fb.rows.length) bad++;
    for (let r = 0; r < fa.rows.length; r++) for (let k = 0; k < 32; k++) cmpF32(fa.rows[r][k], fb.rows[r][k], `frame ${i} row ${r + 1}[${k}]`);
    if (fa.buckets.length !== fb.buckets.length) bad++;
    for (let j = 0; j < fa.buckets.length; j++) {
      const x = fa.buckets[j], y = fb.buckets[j];
      if (x.name !== y.name || x.count !== y.count || x.visible !== y.visible || x.row !== y.row || x.m.length !== y.m.length) {
        if (bad++ < 5) console.log(`      ${label}: frame ${i} bucket ${x.name} header differs`);
        continue;
      }
      for (let k = 0; k < x.m.length; k++) cmpF32(x.m[k], y.m[k], `frame ${i} ${x.name}[${k}]`);
    }
    if (JSON.stringify(fa.anchors) !== JSON.stringify(fb.anchors)) { if (bad++ < 5) console.log(`      ${label}: frame ${i} anchors differ`); }
    if (JSON.stringify(fa.collapse) !== JSON.stringify(fb.collapse) || fa.instances !== fb.instances) {
      if (bad++ < 5) console.log(`      ${label}: frame ${i} collapse stats / instance count differ`);
    }
    const ka = Object.keys(fa.groups).sort(), kb = Object.keys(fb.groups).sort();
    if (ka.join() !== kb.join()) { bad++; continue; }
    for (const key of ka) {
      const x = fa.groups[key], y = fb.groups[key];
      for (let k = 0; k < x.parts.length; k++) {
        const isQuat = k % 7 >= 3;
        if (Object.is(x.parts[k], y.parts[k])) continue;
        if (tol !== null && isQuat && Math.abs(x.parts[k] - y.parts[k]) <= tol.quat) { maxQ = Math.max(maxQ, Math.abs(x.parts[k] - y.parts[k])); continue; }
        if (bad++ < 5) console.log(`      ${label}: frame ${i} group ${key} part[${k}] ${x.parts[k]} vs ${y.parts[k]}`);
      }
      for (let k = 0; k < 4; k++) {
        if (Object.is(x.orbit[k], y.orbit[k])) continue;
        if (tol !== null && Math.abs(x.orbit[k] - y.orbit[k]) <= tol.quat) { maxQ = Math.max(maxQ, Math.abs(x.orbit[k] - y.orbit[k])); continue; }
        if (bad++ < 5) console.log(`      ${label}: frame ${i} group ${key} orbit[${k}] ${x.orbit[k]} vs ${y.orbit[k]}`);
      }
      if (!Object.is(x.orbitAngle, y.orbitAngle)) { if (bad++ < 5) console.log(`      ${label}: frame ${i} group ${key} orbit angle`); }
    }
  }
  check(`${label}: rows, buckets, anchors, template parts, orbits`, bad === 0,
    tol === null ? `${a.frames.length} frames, Object.is` : `${a.frames.length} frames, max ${maxUlp} f32 ulp, max |dq| ${maxQ.toExponential(2)}`);
}

// ---------------------------------------------------------------------------
// R — concurrent getOrCreateDidGroup (lane D review 2026-10-26). Two attaches
// of one DID in flight together (two bakes of one setup, or the unawaited
// cells.js attach): both miss `_didGroups`, both build a group, the map keeps
// the second. Then every anchor of the DID is evicted (its group disposed)
// and the DID comes back with a second setup (new per-setup rows). `gated`:
// frames run between the two fetches, so the two groups' clocks differ.
// ---------------------------------------------------------------------------
const S2_SETUP = 0x0200aaaa; // a second setup playing the wing DID (its own unbake rows)
const _tri = () => ({
  triCount: 1, positions: new Float32Array([0, 0, 0, 0.4, 0, 0, 0, 0.2, 0]), uvs: new Float32Array(6),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), surfaceIndices: new Uint8Array([0]), surfaces: new Uint32Array([0x08000010]),
});
// A 1-part, 5-frame clip whose LAST frame is exactly the pre-play pose
// (origin, identity): the fallback's first JS update lands on it (F3).
const ORIGIN_ANIM = 0x03000777, ORIGIN_SETUP = 0x02000777;
function originFrames() {
  const out = [];
  for (let f = 0; f < 4; f++) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.3 + 0.2 * f);
    out.push(1 + f, 2, 3, q.w, q.x, q.y, q.z);
  }
  out.push(0, 0, 0, 1, 0, 0, 0);
  return out;
}
function laneWasm(gated) {
  const base = gen.mockWasm();
  const gates = [];
  let calls = 0;
  const wasm = {
    ...base,
    async fetchBuildingPlacement(setupId) {
      const sid = setupId >>> 0;
      if (sid === ORIGIN_SETUP) {
        return { partCount: 1, takePartMeshes: () => [_tri()], takePartHingeFrames: () => [{ x: 0, y: 0, z: 0, qw: 1, qx: 0, qy: 0, qz: 0 }], free() {} };
      }
      return base.fetchBuildingPlacement(sid === S2_SETUP ? gen.DID.wing.setup : sid);
    },
    async fetchAnimation(id) {
      // Gate the first two getOrCreateDidGroup fetches only (the unbake probe
      // also calls fetchAnimation; later attaches must not wait on a gate).
      if (gated && calls < 2 && String(new Error().stack).includes("getOrCreateDidGroup")) {
        const n = calls++;
        await new Promise((res) => { gates[n] = res; });
      }
      if ((id >>> 0) === ORIGIN_ANIM) return { numParts: 1, numFrames: 5, flags: 2, frames: Float32Array.from(originFrames()), free() {} };
      return base.fetchAnimation(id);
    },
  };
  return { wasm, gates, calls: () => calls };
}
const _tick = () => new Promise((r) => setTimeout(r, 0));
function kernelCounts(rust) {
  const map = AS.__animSceneryGroupsForTest();
  const mapRust = [...map.values()].filter((g) => g._rust).length;
  const st = rust ? bridge.rustAnimSceneryStats() : null;
  const held = AS.animatedSceneryDiag().rustAnimScenery?.groupsHeld ?? null;
  return { map: map.size, mapRust, kernel: st ? st.groups : null, held };
}
async function runRace(flags, gated) {
  GPU.__setAnimSceneryGpuForTest(flags.gpu);
  bridge.__setRustAnimSceneryForTest(flags.rust);
  AS.__setAnimSceneryGateForTest(flags.gate);
  bridge.__resetRustAnimSceneryForTest();
  const scene3d = gen.makeWorld();
  const { wasm, gates, calls } = laneWasm(gated);
  let clock = 1000;
  AS.setSceneryTimeSource(() => clock);
  AS.__setAnimSceneryOmegaHzForTest(15);
  window.__landblockLru = { isParked: () => false };
  const D = gen.DID.wing.anim, S1 = gen.DID.wing.setup;
  const mk = (setup, lb, idx) => ({ objId: setup, defaultAnimationId: D, landblockId: lb, sourceObjIdx: idx,
    x: 30 + idx, y: 40 + idx, z: 50, qw: 1, qx: 0, qy: 0, qz: 0, scale: 1 });
  const frames = [];
  const counts = [];
  const step = (tag) => {
    clock += 16.667;
    const cb = gen.__takeRaf();
    if (!cb) throw new Error("rAF loop not armed");
    cb();
    frames.push({ rows: gen.rowsSnapshot(), groups: gen.groupsSnapshot(), buckets: bucketsSnapshot(scene3d),
      anchors: anchorsSnapshot(scene3d), collapse: { collapses: 0, restores: 0 }, instances: AS.animatedSceneryDiag().instances });
    counts.push({ tag, ...kernelCounts(flags.rust) });
  };
  const pa = AS.attachAnimatedScenery(scene3d, [mk(S1, 0xa9b30000, 1)], wasm, {});
  const pb = AS.attachAnimatedScenery(scene3d, [mk(S1, 0xa9b40000, 2)], wasm, {});
  if (gated) {
    for (let w = 0; w < 400 && calls() < 2; w++) await _tick();
    if (calls() < 2) throw new Error(`gated race: only ${calls()} fetches in flight`);
    gates[0]();
    await pa;
    for (let f = 0; f < 5; f++) step("between the fetches");
    gates[1]();
    await pb;
  } else {
    await Promise.all([pa, pb]);
  }
  counts.push({ tag: "after both attaches", ...kernelCounts(flags.rust) });
  for (let f = 0; f < 12; f++) step("both live");
  for (const c of [...scene3d.staticsGroup.children]) if (c.userData?.isAnimatedScenery) scene3d.staticsGroup.remove(c);
  for (let f = 0; f < 5; f++) step("evicted");
  await AS.attachAnimatedScenery(scene3d, [mk(S1, 0xa9b30000, 3), mk(S2_SETUP, 0xa9b30000, 4)], wasm, {});
  counts.push({ tag: "the DID came back with a second setup", ...kernelCounts(flags.rust) });
  for (let f = 0; f < 8; f++) step("back");
  const rowKeys = GPU.poseRows().map((r) => `${r.row}:${r.partIdx}:${r.post ? "post" : "-"}`).join(" ");
  AS.disposeAnimatedScenery();
  AS.setSceneryTimeSource(null);
  delete window.__landblockLru;
  GPU.__setAnimSceneryGpuForTest(undefined);
  bridge.__setRustAnimSceneryForTest(undefined);
  AS.__setAnimSceneryGateForTest(undefined);
  AS.__setAnimSceneryOmegaHzForTest(undefined);
  return { frames, counts, rowKeys };
}
async function raceArms(tag, tol) {
  for (const gated of [false, true]) {
    const label = gated ? "frames between the two fetches" : "two attaches together";
    const off = await runRace({ gpu: true, rust: false, gate: false }, gated);
    const on = await runRace({ gpu: true, rust: true, gate: false }, gated);
    const bad = on.counts.filter((c) => !(c.kernel === c.map && c.mapRust === c.map && c.held === c.map));
    check(`${tag} race (${label}): kernel groups == map groups at every step`, bad.length === 0,
      bad.length ? JSON.stringify(bad.slice(0, 3)) : `${on.counts.length} steps, end ${JSON.stringify(on.counts[on.counts.length - 1])}`);
    check(`${tag} race (${label}): same pose-table rows allocated`, off.rowKeys === on.rowKeys, on.rowKeys);
    compareRuns(`${tag} race (${label}) rows, buckets, anchors, template parts vs flag off`, off, on, tol);
  }
}

// ---------------------------------------------------------------------------
// F2 / F3 — the kernel fails mid-session (lane D review): every group is
// handed back to its mixer with the clocks of the last successful advance.
// F2: memory grows and more groups register between that advance and the
// failure (the old `_group` view is detached / moved) — template parts and
// rows must stay flag-off-identical. F3: the first JS update after the
// failure lands on a pose equal to the mixer's stale accu (the pre-play pose)
// — it must still be written.
// ---------------------------------------------------------------------------
function poisonable(baseNs, poison) {
  const Base = baseNs.SceneAnimScenery;
  class PoisonedSceneAnimScenery extends Base {
    advance(dt, hz) {
      if (poison.on) throw new Error("injected trap");
      return super.advance(dt, hz);
    }
  }
  return { ...baseNs, SceneAnimScenery: PoisonedSceneAnimScenery };
}
async function fallbackArms(tag, baseNs, memory, grow, tol) {
  const off = await runScenario({ gpu: true, rust: false, gate: false });
  const poison = { on: false };
  core.__setSceneWasmForTest(poisonable(baseNs, poison), memory);
  GPU.__setAnimSceneryGpuForTest(true);
  bridge.__setRustAnimSceneryForTest(true);
  AS.__setAnimSceneryGateForTest(false);
  bridge.__resetRustAnimSceneryForTest();
  const frames = [];
  const extra = [];
  let heldBefore = null, heldAfter = null;
  const c0 = AS.animatedSceneryCollapseStats();
  await gen.runModuleScenario({
    beforeFrame(f) {
      if (f === 20) {
        heldBefore = AS.animatedSceneryDiag().rustAnimScenery?.groupsHeld;
        grow();                                       // the last good advance's views detach
        for (let i = 0; i < 6; i++) {                 // and the group buffer reallocates
          const fake = { omega: null, parts: [] };
          if (bridge.rustAnimRegisterGroup(fake, 0, Float32Array.from(gen.wingFrames(6)), 2, 6, 30, false)) extra.push(fake);
        }
        for (const fake of extra) bridge.rustAnimUnregisterGroup(fake);
        grow();
        poison.on = true;                             // frame 20's advance traps
      }
    },
    afterFrame(f, scene3d) {
      const c = AS.animatedSceneryCollapseStats();
      frames.push({ f, rows: gen.rowsSnapshot(), groups: gen.groupsSnapshot(), buckets: bucketsSnapshot(scene3d), anchors: anchorsSnapshot(scene3d),
        collapse: { collapses: c.collapses - c0.collapses, restores: c.restores - c0.restores }, instances: AS.animatedSceneryDiag().instances });
      if (f === 20) heldAfter = AS.animatedSceneryDiag().rustAnimScenery?.groupsHeld;
    },
  });
  const stats = bridge.rustAnimSceneryStats();
  AS.disposeAnimatedScenery();
  GPU.__setAnimSceneryGpuForTest(undefined);
  bridge.__setRustAnimSceneryForTest(undefined);
  AS.__setAnimSceneryGateForTest(undefined);
  core.__setSceneWasmForTest(baseNs, memory);
  check(`${tag} F2 the injected trap handed every group back`, heldBefore === 4 && heldAfter === 0 && stats.broken === true && extra.length === 6,
    `held ${heldBefore} → ${heldAfter}, broken ${stats.broken}, extra groups ${extra.length}`);
  // Before the trap: the kernel's values (tol); from the trap on: the JS mixers, which must be EXACT.
  compareRuns(`${tag} F2 frames 0-19 (kernel)`, { frames: off.frames.slice(0, 20) }, { frames: frames.slice(0, 20) }, tol);
  compareRuns(`${tag} F2 frames 20-47 (handed back after growth + 6 registrations)`, { frames: off.frames.slice(20) }, { frames: frames.slice(20) }, null);

  // F3 — the stale-accu edge.
  const runOrigin = async (rust, poisonAt) => {
    const p3 = { on: false };
    core.__setSceneWasmForTest(poisonable(baseNs, p3), memory);
    GPU.__setAnimSceneryGpuForTest(true);
    bridge.__setRustAnimSceneryForTest(rust);
    bridge.__resetRustAnimSceneryForTest();
    const scene3d = gen.makeWorld();
    const { wasm } = laneWasm(false);
    let clock = 1000;
    AS.setSceneryTimeSource(() => clock);
    window.__landblockLru = { isParked: () => false };
    await AS.attachAnimatedScenery(scene3d, [{ objId: ORIGIN_SETUP, defaultAnimationId: ORIGIN_ANIM, landblockId: 0xa9b30000,
      sourceObjIdx: 9, x: 10, y: 10, z: 40, qw: 1, qx: 0, qy: 0, qz: 0, scale: 1 }], wasm, {});
    const out = [];
    const ms = [16.667, 16.667, 16.667, 100, 16.667];   // t = 0.05, then 0.15 (the held last frame = the pre-play pose)
    for (let f = 0; f < ms.length; f++) {
      if (f === poisonAt) p3.on = true;
      clock += ms[f];
      gen.__takeRaf()();
      out.push({ groups: gen.groupsSnapshot(), rows: gen.rowsSnapshot() });
    }
    AS.disposeAnimatedScenery();
    AS.setSceneryTimeSource(null);
    delete window.__landblockLru;
    GPU.__setAnimSceneryGpuForTest(undefined);
    bridge.__setRustAnimSceneryForTest(undefined);
    core.__setSceneWasmForTest(baseNs, memory);
    return out;
  };
  const o3 = await runOrigin(false, -1);
  const r3 = await runOrigin(true, 3);
  const key = String(ORIGIN_ANIM);
  const parts = (x, f) => (x[f].groups[key] ? x[f].groups[key].parts : null);
  const atOrigin = parts(o3, 3) && parts(o3, 3).every((v, i) => (i === 6 ? v === 1 : v === 0));
  let same = true;
  for (let f = 3; f < o3.length; f++) {
    if (JSON.stringify(parts(o3, f)) !== JSON.stringify(parts(r3, f)) || JSON.stringify(o3[f].rows) !== JSON.stringify(r3[f].rows)) same = false;
  }
  check(`${tag} F3 the first JS update after the trap writes a pose equal to the stale accu (flag off sits at the pre-play pose)`,
    atOrigin && same, `flag-off frame 3 at origin: ${atOrigin}; handed-back frames identical: ${same}`);
}

// ---------------------------------------------------------------------------
// F — the fixture is current, and a kernel replays it.
// ---------------------------------------------------------------------------
function replayFixture(label, K, fx, exact) {
  const hx64 = (h) => { const dv = new DataView(new ArrayBuffer(8)); dv.setBigUint64(0, BigInt("0x" + h)); return dv.getFloat64(0); };
  const hx32 = (h) => { const dv = new DataView(new ArrayBuffer(4)); dv.setUint32(0, parseInt(h, 16)); return dv.getFloat32(0); };
  const k = new K();
  const mem = core.sceneWasmMemory();
  const handles = new Map();
  let bad = 0, frames = 0, maxUlp = 0;
  const viewF64 = new core.WasmF64View(), viewF32 = new core.WasmF32View();
  // A frame is snapshotted AFTER the loop's reclaim; the groups it disposed
  // are unregistered by the "afterFrame" events that follow it. Check the
  // live set once those are applied (same rule as anim_scenery_parity.rs).
  let pendingLive = null;
  const checkLive = () => {
    if (!pendingLive) return;
    const live = [...handles.keys()].sort((a, b) => a - b).join();
    if (live !== pendingLive.keys) { bad++; if (bad < 4) console.log(`      frame ${pendingLive.f}: live ${live} want ${pendingLive.keys}`); }
    pendingLive = null;
  };
  for (const ev of fx.module.events) {
    if (ev.phase !== "afterFrame") checkLive();
    if (ev.kind === "registerGroup") {
      const om = ev.omega ? ev.omega.map(hx64) : null;
      const h = k.registerGroup(ev.key, Float32Array.from(ev.frames.map(hx32)), ev.numParts, ev.numFrames, hx64(ev.fps), ev.closedLoop,
        !!om, om ? om[0] : 0, om ? om[1] : 0, om ? om[2] : 0, om ? om[3] : 0);
      handles.set(ev.key, [h, ev.numParts]);
    } else if (ev.kind === "unregisterGroup") {
      k.unregisterGroup(handles.get(ev.key)[0]);
      handles.delete(ev.key);
    } else if (ev.kind === "registerRow") {
      const idx = k.registerRow(ev.key, ev.part, ev.post ? Float64Array.from(ev.post.map(hx64)) : new Float64Array(0),
        Float64Array.from(ev.init.map(hx64)));
      if (idx !== ev.row - 1) bad++;
    } else if (ev.kind === "frame") {
      const fr = fx.module.frames[ev.frame];
      k.advance(hx64(fr.dt), hx64(fr.omegaHz));
      frames += 1;
      const rows = viewF32.get(k.rowsPtr() >>> 0, k.rowsLen() >>> 0);
      fr.rows.forEach((r, ri) => r.forEach((h, i) => {
        const w = hx32(h), g = rows[ri * 32 + i];
        if (Object.is(g, w)) return;
        const fa = new Float32Array([g, w]); const ia = new Int32Array(fa.buffer);
        const d = Math.abs(ia[0] - ia[1]);
        maxUlp = Math.max(maxUlp, d);
        if (exact || d > 1) bad++;
      }));
      const parts = viewF64.get(k.partsPtr() >>> 0, k.partsLen() >>> 0);
      pendingLive = { f: ev.frame, keys: Object.keys(fr.groups).map(Number).sort((a, b) => a - b).join() };
      for (const [key, gv] of Object.entries(fr.groups)) {
        if (!handles.has(Number(key))) { bad++; continue; }
        const [h, np] = handles.get(Number(key));
        const off = k.partsOffset(h) >>> 0;
        gv.parts.forEach((hh, i) => {
          const w = hx64(hh), g = parts[off + i];
          if (Object.is(g, w)) return;
          if (!exact && i % 7 >= 3 && Math.abs(g - w) <= 1e-15) return;
          bad++;
        });
        void np;
      }
    }
  }
  checkLive();
  check(`F ${label}: replays the fixture's ${frames} module frames (incl. the live group set after each frame's disposals)`, bad === 0 && frames === fx.module.frames.length,
    `${exact ? "bit-exact" : `max row diff ${maxUlp} f32 ulp`}${bad ? `, ${bad} mismatches` : ""}${mem ? "" : " (no memory?)"}`);
}

// ---------------------------------------------------------------------------
// Part 1 — the model.
// ---------------------------------------------------------------------------
console.log("rust anim scenery parity — Part 1 (model kernel, no wasm)");

let fixture = null;
try {
  fixture = JSON.parse(readFileSync(join(fu.FIXTURE_DIR, "anim_scenery.json"), "utf8"));
} catch (e) {
  check("F fixture present (node tools/rust_parity/gen_anim_scenery.mjs)", false, String(e.message).slice(0, 80));
}

// Flag-off reference runs (the JS path as shipped), GPU rows and CPU slots.
const refGpu = await runScenario({ gpu: true, rust: false, gate: false });
const refCpu = await runScenario({ gpu: false, rust: false, gate: false });
{
  const last = refGpu.frames[refGpu.frames.length - 1];
  check("scenario: landblock B parks (collapse, no reclaim) and the seagulls come back",
    last.collapse.collapses >= 3 && refGpu.frames[29].instances === 6 && refGpu.frames[30].instances === 6 && last.instances === 8,
    `collapses=${last.collapse.collapses} instances@29=${refGpu.frames[29].instances} @30=${refGpu.frames[30].instances} end=${last.instances}`);
}

if (fixture) {
  // Re-derive the fixture's module frames from today's JS: the rows and
  // template parts of the flag-off GPU run must equal what is checked in.
  const fr = fixture.module.frames;
  let stale = fr.length !== refGpu.frames.length;
  for (let i = 0; !stale && i < fr.length; i++) {
    const rows = refGpu.frames[i].rows.map((r) => fu.f32arr(r));
    if (JSON.stringify(rows) !== JSON.stringify(fr[i].rows)) stale = true;
    for (const [key, g] of Object.entries(refGpu.frames[i].groups)) {
      if (!fr[i].groups[key] || JSON.stringify(fu.f64arr(g.parts)) !== JSON.stringify(fr[i].groups[key].parts)) stale = true;
    }
  }
  check("F the checked-in fixture equals today's JS (regenerate with gen_anim_scenery.mjs if not)", !stale);
}

const model = makeModelNamespace();
core.__setSceneWasmForTest(model.ns, model.memory);
if (fixture) replayFixture("model", model.ns.SceneAnimScenery, fixture, true);

for (const gate of [false, true]) {
  const onGpu = await runScenario({ gpu: true, rust: true, gate });
  check(`C model kernel held the groups (gpu, gate ${gate})`, onGpu.diag.rustAnimScenery?.groupsHeld === 4 && onGpu.diag.rustAnimScenery.rowsInLockstep === true,
    JSON.stringify(onGpu.diag.rustAnimScenery));
  compareRuns(`C gpu rows, rust on, gate ${gate}`, refGpu, onGpu, null);
  const onCpu = await runScenario({ gpu: false, rust: true, gate });
  compareRuns(`C cpu slots, rust on, gate ${gate}`, refCpu, onCpu, null);
}
check("C the fake memory grew during the runs (views re-created)", model.grows() > 0, `grows=${model.grows()}`);

// G — the gate alone, and its edge cases.
core.__setSceneWasmForTest(null, null);
{
  const g1 = await runScenario({ gpu: true, rust: false, gate: true });
  compareRuns("G gate only (gpu)", refGpu, g1, null);
  const g2 = await runScenario({ gpu: false, rust: false, gate: true });
  compareRuns("G gate only (cpu)", refCpu, g2, null);
}

let edgeLbB = null;
async function gateEdgeRun(gate) {
  edgeLbB = null;
  AS.__setAnimSceneryGateForTest(gate);
  GPU.__setAnimSceneryGpuForTest(true);
  const snaps = [];
  const c0 = AS.animatedSceneryCollapseStats();
  await gen.runModuleScenario({
    beforeFrame(f, scene3d) {
      const sg = scene3d.staticsGroup;
      const find = (setup, lb) => sg.children.find((o) => o.userData?.isAnimatedScenery
        && o.name === `anim-scenery-0x${setup.toString(16)}` && (o.userData.landblockId >>> 0) === lb);
      if (f === 3) sg.visible = false;                              // hidden ancestor
      if (f === 5) sg.visible = true;
      if (f === 7) {                                                // re-parented (attach) under a second container
        const a = find(gen.DID.wing.setup, 0xa9b30000);
        const box = new THREE.Group(); box.name = "edge-box"; scene3d.worldRoot.add(box);
        if (a) box.attach(a);
      }
      if (f === 9) { const a = find(gen.DID.creep.setup, 0xa9b30000); if (a) a.visible = false; } // hidden anchor
      if (f === 11) { const a = sg.children.find((o) => o.visible === false); if (a) a.visible = true; }
      if (f === 26) for (let i = 0; i < 16; i++) { const d = new THREE.Group(); d.name = `dummy-${i}`; sg.add(d); }
      if (f === 28) {                                               // the LRU's bulk path (>= 16 kills, same events)
        const a = find(gen.DID.still.setup, 0xa9b30000);
        const kill = sg.children.filter((o) => o.name.startsWith("dummy-"));
        if (a) kill.unshift(a);
        removeChildrenBulk(sg, kill);
      }
      if (f === 29) edgeLbB = sg.children.filter((o) => o.userData?.isAnimatedScenery && (o.userData.landblockId >>> 0) === 0xa9b40000);
      if (f === 33 && edgeLbB) for (const a of edgeLbB.slice(0, 2)) sg.add(a); // unpark: re-attached ('added')
      if (f === 35) {                                               // the pool true-disposes landblock B
        const lru = window.__landblockLru;
        window.__landblockLru = { isParked: (lb) => (((lb >>> 0) & 0xffff0000) >>> 0) !== 0xa9b40000 && lru.isParked(lb) };
      }
      if (f === 42) scene3d.worldRoot.remove(sg);                   // detached parent chain
    },
    afterFrame(f, scene3d) {
      const c = AS.animatedSceneryCollapseStats();
      snaps.push({ buckets: bucketsSnapshot(scene3d), collapses: c.collapses - c0.collapses, restores: c.restores - c0.restores,
        n: AS.animatedSceneryDiag().instances });
      if (gate) edgeGateStats = AS.animatedSceneryDiag().gate;
    },
  });
  AS.disposeAnimatedScenery();
  AS.__setAnimSceneryGateForTest(undefined);
  GPU.__setAnimSceneryGpuForTest(undefined);
  return snaps;
}
let edgeGateStats = null;
{
  const a = await gateEdgeRun(false);
  const b = await gateEdgeRun(true);
  check("G edge cases: hidden / re-parented / bulk-removed / unparked / disposed-while-parked / detached-chain anchors gate identically",
    JSON.stringify(a) === JSON.stringify(b), `${a.length} frames; restores ${a[a.length - 1].restores}, instances end ${a[a.length - 1].n}`);
  check("G the stable skip and the full passes both ran", edgeGateStats && edgeGateStats.stableSkips > 0 && edgeGateStats.fullPasses > 0,
    JSON.stringify(edgeGateStats));
}

// R / F2 / F3 on the model kernel.
core.__setSceneWasmForTest(model.ns, model.memory);
await raceArms("R model", null);
await fallbackArms("model", model.ns, model.memory, () => model.forceGrow(), null);
core.__setSceneWasmForTest(null, null);

const part1Failed = failed;

// ---------------------------------------------------------------------------
// Part 2 — the compiled kernel.
// ---------------------------------------------------------------------------
console.log("rust anim scenery parity — Part 2 (compiled SceneAnimScenery)");
let ns, out;
try {
  ns = await import(join(app, pkgDir, "holtburger_web.js"));
  out = await ns.default(readFileSync(join(app, pkgDir, "holtburger_web_bg.wasm")));
} catch (e) {
  console.log(`rust anim scenery parity: Part 1 ${passed} passed, ${failed} failed; Part 2 SKIP — wasm pkg ${pkgDir}/ not loadable in Node: ${String(e.message).slice(0, 100)}`);
  process.exit(part1Failed === 0 ? 0 : 1);
}
if (typeof ns.SceneAnimScenery !== "function" || typeof ns.sceneCoreAbi !== "function") {
  console.log(`rust anim scenery parity: Part 1 ${passed} passed, ${failed} failed; Part 2 SKIP — ${pkgDir}/ has no SceneAnimScenery (rebuild with wasm-pack)`);
  process.exit(part1Failed === 0 ? 0 : 1);
}
core.__setSceneWasmForTest(ns, out.memory);
if (fixture) replayFixture("wasm", ns.SceneAnimScenery, fixture, false);
for (const gate of [false, true]) {
  const onGpu = await runScenario({ gpu: true, rust: true, gate });
  check(`W wasm kernel held the groups (gate ${gate})`, onGpu.diag.rustAnimScenery?.groupsHeld === 4, JSON.stringify(onGpu.diag.rustAnimScenery));
  compareRuns(`W gpu rows, wasm, gate ${gate}`, refGpu, onGpu, { ulp: 1, quat: 1e-15 });
  const onCpu = await runScenario({ gpu: false, rust: true, gate });
  compareRuns(`W cpu slots, wasm, gate ${gate}`, refCpu, onCpu, { ulp: 2, quat: 1e-15 });
}
await raceArms("R wasm", { ulp: 1, quat: 1e-15 });
await fallbackArms("wasm", ns, out.memory, () => out.memory.grow(1), { ulp: 1, quat: 1e-15 });
console.log(`\nrust anim scenery parity: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
