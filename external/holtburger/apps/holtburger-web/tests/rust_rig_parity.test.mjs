// tests/rust_rig_parity.test.mjs — `?rustRig`: the Rust rig poser against the
// JS `poseRigAt`, through the REAL bridge (scene3d/rust/rig.js) into REAL
// three.js r184 objects; plus the `?rustEntityCull` tick gate on the REAL
// EntityManager. Lane notes: docs/2026-10-26-rust-rig.md.
//
// Part 1 (always runs; no wasm needed) — the bridge against `ModelSceneRigs`,
// a line-for-line JS model of crates/holtburger-scene/src/rig.rs:
//   F  the checked-in fixture (crates/holtburger-scene/tests/fixtures/rig.json)
//      still equals what today's poseRigAt + updateMatrix compute (a stale
//      fixture would make cargo's rig_parity "fail" the right Rust), and the
//      model reproduces it bit for bit through `pose` and `poseMatrices`;
//   C  every gen_rig case posed flag-off (JS body) and flag-on (bridge):
//      position, quaternion, and — after a scene walk — the matrix and
//      matrixWorld of every part and of a mesh under it, Object.is-equal;
//   T  writers after the pose (slerp, position-only, Euler, scale, pivot,
//      applyMatrix4, copy), non-plain parts, stubs and plain-array
//      descriptors (JS path), wasm memory growth, swapped buffers, hidden
//      parts, clones, the descriptor cap (eviction), the FinalizationRegistry
//      (under `node --expose-gc` only);
//   E  an EntityManager A/B (flag off vs on, same inputs): idle, walk
//      (exact in place), backstep, a raw one-shot with root motion, the
//      jump-pose tween and a frozen corpse pose overwriting the pose;
//   G  the ?rustEntityCull hoisted tick gate vs the per-entity gate: which
//      entities tick, and every root / ancestor matrix after every tick.
// Part 2 (after the orchestrator's wasm build) — F, C, T and E against the
//   COMPILED `SceneRigs` from `${HB_PKG || "pkg"}/`. Prints `SKIP — …` and
//   exits 0 (when Part 1 passed) if the class is absent.
//
// Run: node tests/rust_rig_parity.test.mjs   (HB_PKG=pkg-rustcore for a dev build)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

globalThis.window = { location: { search: "" } };
const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const pkgDir = process.env.HB_PKG || "pkg";

const THREE = await import("three");
const core = await import("../scene3d/rust/scene_core.js");
const rig = await import("../scene3d/rust/rig.js");
const ms = await import("../scene3d/motion/motion_sequence.js");
const gen = await import("../tools/rust_parity/gen_rig.mjs");
const { installSkipHiddenMatrix } = await import("../scene3d/skip_hidden_matrix.js");
installSkipHiddenMatrix(THREE, { force: true });

let passed = 0, failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail != null && detail !== "" ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}

// ---------------------------------------------------------------------------
// ModelSceneRigs — rig.rs in JS (same structure, same operation order), on a
// fake wasm memory whose buffer can be replaced (= memory growth: the old
// ArrayBuffer is detached, every view on it reads length 0).
// ---------------------------------------------------------------------------
function makeModelWasm() {
  const memory = { buffer: new ArrayBuffer(1 << 12) };
  let top = 64;
  function grow(minBytes) {
    const nb = new ArrayBuffer(Math.max(memory.buffer.byteLength * 2, minBytes));
    new Uint8Array(nb).set(new Uint8Array(memory.buffer));
    const old = memory.buffer;
    memory.buffer = nb;
    structuredClone(old, { transfer: [old] }); // detach like WebAssembly.Memory.grow
  }
  function alloc(bytes) {
    top = (top + 7) & ~7;
    if (top + bytes > memory.buffer.byteLength) grow(top + bytes + 64);
    const p = top;
    top += bytes;
    return p;
  }
  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const ONE = new THREE.Vector3(1, 1, 1);
  function inPlaceDisplacement(pf, pc, nf) {
    const disp = new Float32Array(nf * 3);
    let c0x = 0, c0y = 0, c0z = 0;
    for (let p = 0; p < pc; p += 1) { const b = p * 7; c0x += pf[b]; c0y += pf[b + 1]; c0z += pf[b + 2]; }
    c0x /= pc; c0y /= pc; c0z /= pc;
    for (let f = 0; f < nf; f += 1) {
      let cx = 0, cy = 0, cz = 0;
      for (let p = 0; p < pc; p += 1) { const b = (f * pc + p) * 7; cx += pf[b]; cy += pf[b + 1]; cz += pf[b + 2]; }
      disp[f * 3] = cx / pc - c0x; disp[f * 3 + 1] = cy / pc - c0y; disp[f * 3 + 2] = cz / pc - c0z;
    }
    return disp;
  }
  // pose_each: calls put(p, px, py, pz, qx, qy, qz, qw) for parts 0..n.
  function poseEach(d, frame, mode, n, put) {
    const pc = d.pc, pf = d.pf;
    const f = Math.min(frame, d.nf - 1);
    n = Math.min(n, pc);
    if (mode === 2 && d.rf) {
      const rf = d.rf, r = f * 7;
      const tx = rf[r], ty = rf[r + 1], tz = rf[r + 2];
      const iw = rf[r + 3], ix = -rf[r + 4], iy = -rf[r + 5], iz = -rf[r + 6];
      const ident = Math.abs(ix) < 1e-7 && Math.abs(iy) < 1e-7 && Math.abs(iz) < 1e-7;
      for (let p = 0; p < n; p += 1) {
        const base = (f * pc + p) * 7;
        let px = pf[base] - tx, py = pf[base + 1] - ty, pz = pf[base + 2] - tz;
        let qw = pf[base + 3], qx = pf[base + 4], qy = pf[base + 5], qz = pf[base + 6];
        if (!ident) {
          const cx = iy * pz - iz * py, cy = iz * px - ix * pz, cz = ix * py - iy * px;
          const ccx = iy * cz - iz * cy, ccy = iz * cx - ix * cz, ccz = ix * cy - iy * cx;
          px += 2 * (iw * cx + ccx); py += 2 * (iw * cy + ccy); pz += 2 * (iw * cz + ccz);
          const w2 = iw * qw - ix * qx - iy * qy - iz * qz;
          const x2 = iw * qx + ix * qw + iy * qz - iz * qy;
          const y2 = iw * qy - ix * qz + iy * qw + iz * qx;
          const z2 = iw * qz + ix * qy - iy * qx + iz * qw;
          qw = w2; qx = x2; qy = y2; qz = z2;
        }
        put(p, px, py, pz, qx, qy, qz, qw);
      }
      return n;
    }
    let rx, ry, rz;
    if (mode !== 0) {
      rx = -d.disp[f * 3]; ry = -d.disp[f * 3 + 1]; rz = -d.disp[f * 3 + 2];
    } else if (d.pos) {
      const at = (i) => (i < d.pos.length ? d.pos[i] : NaN);
      rx = at(f * 3); ry = at(f * 3 + 1); rz = at(f * 3 + 2);
    } else {
      rx = 0; ry = 0; rz = 0;
    }
    for (let p = 0; p < n; p += 1) {
      const base = (f * pc + p) * 7;
      put(p, pf[base] + rx, pf[base + 1] + ry, pf[base + 2] + rz, pf[base + 4], pf[base + 5], pf[base + 6], pf[base + 3]);
    }
    return n;
  }
  class SceneRigs {
    constructor() { this.slots = []; this.free = []; this.ptr = alloc(8); this.len = 0; this.live = 0; this.floats = 0; }
    registerDescriptor(pc, nf, pf, pos, hasPos, rf, hasRoot) {
      pc >>>= 0; nf >>>= 0;
      if (pc === 0 || nf === 0 || pf.length !== nf * pc * 7) return 0;
      const d = {
        pc, nf, pf: Float32Array.from(pf),
        pos: hasPos ? Float32Array.from(pos) : null,
        rf: hasRoot && rf.length === nf * 7 ? Float32Array.from(rf) : null,
      };
      d.disp = inPlaceDisplacement(d.pf, pc, nf);
      d.floats = d.pf.length + (d.pos ? d.pos.length : 0) + (d.rf ? d.rf.length : 0) + d.disp.length;
      if (this.len < pc * 16) { this.ptr = alloc(pc * 16 * 8); this.len = pc * 16; } // Vec realloc: new pointer
      this.floats += d.floats; this.live += 1;
      const slot = this.free.length ? this.free.pop() : this.slots.length;
      this.slots[slot] = d;
      return slot + 1;
    }
    unregister(id) {
      const d = this.slots[id - 1];
      if (!d) return false;
      this.slots[id - 1] = null; this.free.push(id - 1); this.live -= 1; this.floats -= d.floats;
      return true;
    }
    pose(id, frame, mode, n) {
      const d = this.slots[id - 1];
      if (!d || !(mode === 0 || mode === 1 || mode === 2)) return 0;
      const out = new Float64Array(memory.buffer, this.ptr, this.len);
      return poseEach(d, frame, mode, Math.min(n, Math.floor(this.len / 7)), (p, px, py, pz, qx, qy, qz, qw) => {
        const o = p * 7;
        out[o] = px; out[o + 1] = py; out[o + 2] = pz; out[o + 3] = qx; out[o + 4] = qy; out[o + 5] = qz; out[o + 6] = qw;
      });
    }
    poseMatrices(id, frame, mode, n) {
      const d = this.slots[id - 1];
      if (!d || !(mode === 0 || mode === 1 || mode === 2)) return 0;
      const out = new Float64Array(memory.buffer, this.ptr, this.len);
      return poseEach(d, frame, mode, Math.min(n, this.len / 16), (p, px, py, pz, qx, qy, qz, qw) => {
        _p.set(px, py, pz);
        _q._x = qx; _q._y = qy; _q._z = qz; _q._w = qw;
        const e = _m.compose(_p, _q, ONE).elements;
        const o = p * 16;
        out[o] = px; out[o + 1] = py; out[o + 2] = pz; out[o + 3] = qx; out[o + 4] = qy; out[o + 5] = qz; out[o + 6] = qw;
        out[o + 7] = e[0]; out[o + 8] = e[1]; out[o + 9] = e[2];
        out[o + 10] = e[4]; out[o + 11] = e[5]; out[o + 12] = e[6];
        out[o + 13] = e[8]; out[o + 14] = e[9]; out[o + 15] = e[10];
      });
    }
    outPtr() { return this.ptr; }
    outLen() { return this.len; }
    get poseStride() { return 7; }
    get matrixStride() { return 16; }
    get descriptorCount() { return this.live; }
    get floatCount() { return this.floats; }
    free() {}
  }
  return {
    ns: { sceneCoreAbi: () => core.SCENE_CORE_ABI, SceneRigs },
    memory,
    growNow: () => grow(memory.buffer.byteLength * 2),
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const descs = gen.buildRigDescriptors();
const calls = gen.buildPoseCalls(descs);
const _dv = new DataView(new ArrayBuffer(8));
function hex64(x) { _dv.setFloat64(0, x); return _dv.getBigUint64(0).toString(16).padStart(16, "0"); }
function hexToF64(h) { _dv.setBigUint64(0, BigInt("0x" + h)); return _dv.getFloat64(0); }
function hexToF32(h) { _dv.setUint32(0, parseInt(h, 16)); return _dv.getFloat32(0); }
const same = (a, b) => Object.is(a, b);
function firstDiff(a, b) {
  for (let i = 0; i < a.length; i += 1) if (!same(a[i], b[i])) return `[${i}] ${a[i]} vs ${b[i]}`;
  return a.length === b.length ? null : `length ${a.length} vs ${b.length}`;
}
function partState(g) {
  const q = g.quaternion;
  return [g.position.x, g.position.y, g.position.z, q._x, q._y, q._z, q._w];
}

// A posed rig in a scene: root (off-origin, rotated, scaled — so matrixWorld
// differs from matrix) → parts, one mesh child per part.
function makeRig(call) {
  const scene = new THREE.Scene();
  const world = new THREE.Group();
  world.rotation.x = -Math.PI / 2;
  scene.add(world);
  const root = new THREE.Group();
  root.position.set(101.25, -7.5, 3.125);
  root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.7);
  root.scale.setScalar(1.25);
  world.add(root);
  const parts = gen.makeParts(call.nParts, call.holes, root);
  for (const g of parts) {
    if (!g) continue;
    const m = new THREE.Mesh(new THREE.BufferGeometry(), null);
    m.position.set(0.01, 0, 0);
    g.add(m);
  }
  return { scene, root, parts };
}

function poseBoth(call, { offMutate, onMutate } = {}) {
  const { desc } = descs[call.desc];
  ms._setInPlaceExactForTest(call.exact);
  const A = makeRig(call);
  const B = makeRig(call);
  ms._setRustRigForTest(false);
  ms.poseRigAt(call.globalFrame, desc, A.parts, call.inPlace);
  ms._setRustRigForTest(true);
  ms.poseRigAt(call.globalFrame, desc, B.parts, call.inPlace);
  ms._setRustRigForTest(false);
  if (offMutate) offMutate(A);
  if (onMutate) onMutate(B);
  return { A, B, desc };
}

// Compare A (flag off) and B (flag on): local state, then the matrices three
// computes in a full scene walk.
function compareRigs(tag, A, B) {
  for (let p = 0; p < A.parts.length; p += 1) {
    const a = A.parts[p], b = B.parts[p];
    if (!a) continue;
    const d = firstDiff(partState(a), partState(b));
    if (d) return `${tag} part ${p} pose ${d}`;
  }
  A.scene.updateMatrixWorld();
  B.scene.updateMatrixWorld();
  for (let p = 0; p < A.parts.length; p += 1) {
    const a = A.parts[p], b = B.parts[p];
    if (!a) continue;
    let d = firstDiff(a.matrix.elements, b.matrix.elements);
    if (d) return `${tag} part ${p} matrix ${d}`;
    d = firstDiff(a.matrixWorld.elements, b.matrixWorld.elements);
    if (d) return `${tag} part ${p} matrixWorld ${d}`;
    d = firstDiff(a.children[0].matrixWorld.elements, b.children[0].matrixWorld.elements);
    if (d) return `${tag} part ${p} mesh matrixWorld ${d}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The suite, run against one SceneRigs backend.
// ---------------------------------------------------------------------------
async function runSuite(label, ns, memory, growNow) {
  console.log(`=== ${label} ===`);
  core.__setSceneWasmForTest(ns, memory);
  rig.__resetRustRigForTest();
  rig.__setRustRigForTest(true);

  // C — every gen_rig case, flag off vs on.
  {
    let bad = null, n = 0;
    const s0 = rig.rustRigStats();
    for (const call of calls) {
      const { A, B } = poseBoth(call);
      bad = compareRigs(`${descs[call.desc].name} g=${call.globalFrame} ip=${call.inPlace} ex=${call.exact}`, A, B);
      if (bad) break;
      n += 1;
    }
    const s1 = rig.rustRigStats();
    check(`C: ${calls.length} gen_rig poses — pose, matrix, matrixWorld identical`, bad === null && n === calls.length, bad ?? `${n} poses`);
    check("C: every pose went through the kernel (no JS fallback, raw writes)",
      s1.rigsPosed - s0.rigsPosed === calls.length && s1.jsFallbacks === s0.jsFallbacks && s1.partsRaw - s0.partsRaw > 1000 && s1.partsSetter === s0.partsSetter,
      `posed ${s1.rigsPosed - s0.rigsPosed}, fallbacks ${s1.jsFallbacks - s0.jsFallbacks}, raw parts ${s1.partsRaw - s0.partsRaw}`);
  }

  const call0 = calls.find((c) => descs[c.desc].name === "human-17p-run" && c.inPlace && c.exact && c.holes.length === 0 && c.nParts === 17)
    ?? calls.find((c) => c.inPlace && c.exact);
  const q90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

  // T1 — every later writer is honoured exactly like flag-off (three composes).
  const writers = [
    ["quaternion slerp (jump tween)", (R) => R.parts[3].quaternion.slerpQuaternions(R.parts[3].quaternion.clone(), q90, 0.37)],
    ["quaternion copy", (R) => R.parts[2].quaternion.copy(q90)],
    ["position-only write (ragdoll leaves)", (R) => R.parts[4].position.set(0.5, -0.25, 1.5)],
    ["position component write", (R) => { R.parts[5].position.z += 0.125; }],
    ["limp: position.set then quaternion.set", (R) => { R.parts[6].position.set(1, 2, 3); R.parts[6].quaternion.set(0, 0, 0.6, 0.8); }],
    ["full Euler write", (R) => { R.parts[7].rotation.set(0.1, 0.2, 0.3); }],
    ["scale write", (R) => R.parts[8].scale.set(1, 2, 1)],
    ["pivot set", (R) => { R.parts[9].pivot = new THREE.Vector3(0.1, 0.2, 0.3); }],
    ["applyMatrix4", (R) => R.parts[10].applyMatrix4(new THREE.Matrix4().makeTranslation(0.5, 0, 0))],
    ["Object3D.copy onto a part", (R) => R.parts[11].copy(R.parts[12], false)],
  ];
  for (const [name, w] of writers) {
    const { A, B } = poseBoth(call0, { offMutate: w, onMutate: w });
    const d = compareRigs(name, A, B);
    check(`T1: ${name} after the Rust pose → identical to flag-off`, d === null, d ?? "");
  }
  {
    // Euler of a quaternion-written part is re-synced (three's callback runs).
    const { A, B } = poseBoth(call0, { offMutate: writers[1][1], onMutate: writers[1][1] });
    const ea = A.parts[2].rotation, eb = B.parts[2].rotation;
    check("T1: Euler re-synced by a later quaternion write", same(ea.x, eb.x) && same(ea.y, eb.y) && same(ea.z, eb.z));
    const ra = A.parts[0].rotation, rb = B.parts[0].rotation;
    const stale = !(same(ra.x, rb.x) && same(ra.y, rb.y) && same(ra.z, rb.z));
    check("T1: (documented) Euler of a Rust-posed part is NOT re-derived", stale, stale ? "stale, as designed" : "unexpectedly in sync");
  }

  // T2 — parts three composes differently, stubs, plain arrays.
  {
    const call = { ...call0 };
    const { desc } = descs[call.desc];
    const prep = (R) => {
      R.parts[1].scale.set(2, 2, 2);
      R.parts[2].pivot = new THREE.Vector3(0, 0, 0.5);
      R.parts[3].matrixAutoUpdate = false;
      R.parts[3].matrix.makeTranslation(9, 9, 9); // a frozen part keeps its matrix
    };
    ms._setInPlaceExactForTest(call.exact);
    const A = makeRig(call); const B = makeRig(call);
    prep(A); prep(B);
    ms._setRustRigForTest(false); ms.poseRigAt(call.globalFrame, desc, A.parts, call.inPlace);
    ms._setRustRigForTest(true); ms.poseRigAt(call.globalFrame, desc, B.parts, call.inPlace);
    ms._setRustRigForTest(false);
    const d = compareRigs("non-plain parts", A, B);
    check("T2: scaled / pivoted / matrixAutoUpdate=false parts → identical", d === null, d ?? "");
  }
  {
    const stub = () => ({
      position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
      quaternion: { x: 0, y: 0, z: 0, w: 1, set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; } },
    });
    const { desc } = descs[call0.desc];
    const sa = Array.from({ length: 17 }, stub), sb = Array.from({ length: 17 }, stub);
    ms._setInPlaceExactForTest(true);
    const st0 = rig.rustRigStats().partsSetter;
    ms._setRustRigForTest(false); ms.poseRigAt(5, desc, sa, true);
    ms._setRustRigForTest(true); ms.poseRigAt(5, desc, sb, true);
    let bad = null;
    for (let p = 0; p < 17 && !bad; p += 1) {
      const a = sa[p], b = sb[p];
      bad = firstDiff([a.position.x, a.position.y, a.position.z, a.quaternion.x, a.quaternion.y, a.quaternion.z, a.quaternion.w],
        [b.position.x, b.position.y, b.position.z, b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w]);
    }
    check("T2: stub parts posed through the setters, same values", bad === null && rig.rustRigStats().partsSetter - st0 === 17, bad ?? "");
    const plain = { ...desc, partFrames: Array.from(desc.partFrames) };
    const fb0 = rig.rustRigStats().jsFallbacks;
    const A = makeRig({ nParts: 17, holes: [] }); const B = makeRig({ nParts: 17, holes: [] });
    ms._setRustRigForTest(false); ms.poseRigAt(5, plain, A.parts, true);
    ms._setRustRigForTest(true); ms.poseRigAt(5, plain, B.parts, true);
    ms._setRustRigForTest(false);
    const d = compareRigs("plain-array descriptor", A, B);
    check("T2: a plain-array descriptor stays on the JS path, identical", d === null && rig.rustRigStats().jsFallbacks === fb0 + 1, d ?? "");
  }

  // T3 — buffers moving: memory growth, descriptor buffers swapped.
  {
    const { desc } = descs[call0.desc];
    ms._setRustRigForTest(true);
    const B0 = makeRig({ nParts: 17, holes: [] });
    ms.poseRigAt(3, desc, B0.parts, true);
    if (growNow) growNow(); else memory.grow?.(2);
    const call = { ...call0, globalFrame: 7 };
    const { A, B } = poseBoth(call);
    const d = compareRigs("after memory growth", A, B);
    check("T3: pose after wasm memory growth (views re-created)", d === null, d ?? "");
    const swapped = { ...desc };
    const pf2 = desc.partFrames.slice();
    for (let i = 0; i < pf2.length; i += 7) pf2[i] += 0.5;
    const A2 = makeRig({ nParts: 17, holes: [] }); const B2 = makeRig({ nParts: 17, holes: [] });
    ms._setRustRigForTest(true); ms.poseRigAt(4, swapped, B2.parts, true);
    swapped.partFrames = pf2; // same descriptor object, new buffer
    const r0 = rig.rustRigStats().registered;
    ms.poseRigAt(4, swapped, B2.parts, true);
    ms._setRustRigForTest(false); ms.poseRigAt(4, swapped, A2.parts, true);
    const d2 = compareRigs("swapped buffers", A2, B2);
    check("T3: a descriptor whose buffers changed re-registers", d2 === null && rig.rustRigStats().registered === r0 + 1, d2 ?? "");
  }

  // T4 — hidden parts, clones.
  {
    const { A, B } = poseBoth(call0);
    A.parts[3].visible = false; B.parts[3].visible = false;
    let d = compareRigs("hidden part", A, B);
    A.parts[3].visible = true; B.parts[3].visible = true;
    const { desc } = descs[call0.desc];
    ms._setRustRigForTest(false); ms.poseRigAt(9, desc, A.parts, true);
    ms._setRustRigForTest(true); ms.poseRigAt(9, desc, B.parts, true);
    ms._setRustRigForTest(false);
    d = d ?? compareRigs("re-shown part", A, B);
    check("T4: hidden part skipped by the walk, exact when shown again", d === null, d ?? "");
    const ca = A.parts[5].clone(), cb = B.parts[5].clone();
    ca.updateMatrix(); cb.updateMatrix();
    const dc = firstDiff(ca.matrix.elements, cb.matrix.elements) ?? firstDiff(partState(ca), partState(cb));
    check("T4: clone of a Rust-posed part has the same pose and matrix", dc === null, dc ?? "");
  }

  // T5 — the descriptor cap: least recently posed descriptors are dropped
  // and re-register on their next use, with the same result.
  {
    rig.__setRigFloatCapForTest(20000);
    const ev0 = rig.rustRigStats().evicted;
    const reg0 = rig.rustRigStats().registered;
    const copies = descs.map(({ desc }) => ({ ...desc })); // fresh descriptor objects
    ms._setInPlaceExactForTest(true);
    for (const dc of copies) {
      const B = makeRig({ nParts: dc.partCount, holes: [] });
      ms._setRustRigForTest(true); ms.poseRigAt(0, dc, B.parts, true); ms._setRustRigForTest(false);
    }
    const st = rig.rustRigStats();
    const evicted = st.evicted - ev0;
    let d = null;
    for (const dc of copies) {
      const A = makeRig({ nParts: dc.partCount, holes: [] }); const B = makeRig({ nParts: dc.partCount, holes: [] });
      ms._setRustRigForTest(false); ms.poseRigAt(1, dc, A.parts, true);
      ms._setRustRigForTest(true); ms.poseRigAt(1, dc, B.parts, true); ms._setRustRigForTest(false);
      d = d ?? compareRigs("re-registered after eviction", A, B);
    }
    const reRegistered = rig.rustRigStats().registered - st.registered;
    check("T5: over the cap, the least recently posed descriptors are evicted", evicted > 0 && st.floats <= 20000 + 34 * 33 * 10,
      `evicted ${evicted}, floats ${st.floats}, registered ${st.registered - reg0}`);
    check("T5: evicted descriptors re-register on use, identical poses", d === null && reRegistered > 0, d ?? `re-registered ${reRegistered}`);
    rig.__setRigFloatCapForTest(undefined);
  }

  // T6 — FinalizationRegistry: a collected descriptor leaves Rust. Needs
  // `node --expose-gc`; without it the check is not run (and not counted).
  if (typeof globalThis.gc === "function" && typeof FinalizationRegistry === "function") {
    const before = rig.rustRigStats();
    (() => {
      for (let i = 0; i < 4; i += 1) {
        const d = { ...descs[i].desc };
        const B = makeRig({ nParts: d.partCount, holes: [] });
        ms._setRustRigForTest(true); ms.poseRigAt(0, d, B.parts, false); ms._setRustRigForTest(false);
      }
    })();
    const mid = rig.rustRigStats();
    for (let i = 0; i < 6; i += 1) {
      globalThis.gc();
      await new Promise((r) => setTimeout(r, 20));
    }
    const after = rig.rustRigStats();
    check("T6: collected descriptors are unregistered from Rust", after.unregistered - before.unregistered >= 1 && after.descriptors < mid.descriptors,
      `registered +${mid.registered - before.registered}, unregistered +${after.unregistered - before.unregistered}, live ${mid.descriptors} → ${after.descriptors}`);
  } else {
    console.log("  (T6 finalizer check runs under `node --expose-gc` only)");
  }

  rig.__setRustRigForTest(undefined);
}

// ---------------------------------------------------------------------------
// F — fixture freshness (JS reference only; no SceneRigs involved).
// ---------------------------------------------------------------------------
function checkFixture() {
  console.log("=== F: fixture vs today's poseRigAt + updateMatrix ===");
  let fx = null;
  try {
    fx = JSON.parse(readFileSync(join(app, "..", "..", "crates", "holtburger-scene", "tests", "fixtures", "rig.json"), "utf8"));
  } catch (e) {
    check("F: fixture present (run node tools/rust_parity/gen_rig.mjs)", false, String(e.message).slice(0, 80));
    return null;
  }
  ms._setRustRigForTest(false);
  let bad = null;
  for (let i = 0; i < fx.poses.length && !bad; i += 1) {
    const ps = fx.poses[i];
    const call = calls[i];
    const { desc } = descs[ps.desc];
    if (!call || call.desc !== ps.desc || call.globalFrame !== ps.globalFrame) { bad = `pose #${i}: case list drifted`; break; }
    ms._setInPlaceExactForTest(call.exact);
    const parts = gen.makeParts(call.nParts, call.holes);
    ms.poseRigAt(call.globalFrame, desc, parts, call.inPlace);
    for (const [p, hexes] of ps.parts) {
      parts[p].updateMatrix();
      const got = gen.partOutputs(parts[p]).map(hex64);
      const d = firstDiff(got, hexes);
      if (d) { bad = `pose #${i} part ${p}: ${d}`; break; }
    }
  }
  ms._setInPlaceExactForTest(true);
  const pfOk = fx.descs.every((d, i) => d.partFrames.length === descs[i].desc.partFrames.length &&
    d.partFrames.every((h, k) => same(hexToF32(h), descs[i].desc.partFrames[k])));
  check(`F: rig.json (${fx.poses.length} poses) == today's poseRigAt + updateMatrix`, bad === null && pfOk && fx.poses.length === calls.length,
    bad ?? (pfOk ? "" : "descriptor inputs drifted"));
  return fx;
}

// The raw kernel (model or compiled) vs the fixture, through its own API:
// `pose` (the bridge's call) = the first 7 recorded values, `poseMatrices` = all 16.
function checkKernelVsFixture(label, ns, memory, fx) {
  if (!fx) return;
  const rigs = new ns.SceneRigs();
  check(`${label}: output strides`, rigs.poseStride === 7 && rigs.matrixStride === 16, `${rigs.poseStride}/${rigs.matrixStride}`);
  const ids = fx.descs.map((d) => {
    const f32 = (a) => Float32Array.from(a, hexToF32);
    return rigs.registerDescriptor(d.partCount, d.numFrames, f32(d.partFrames),
      d.posFrames ? f32(d.posFrames) : new Float32Array(0), !!d.posFrames,
      d.rootFrames ? f32(d.rootFrames) : new Float32Array(0), !!d.rootFrames);
  });
  let bad = ids.every((id) => id > 0) ? null : "a descriptor was rejected";
  const ptr = rigs.outPtr(), len = rigs.outLen();
  for (let i = 0; i < fx.poses.length && !bad; i += 1) {
    const ps = fx.poses[i];
    for (const [stride, fn] of [[7, "pose"], [16, "poseMatrices"]]) {
      const k = rigs[fn](ids[ps.desc], ps.frame, ps.mode, ps.n);
      if (k !== ps.n) { bad = `pose #${i} ${fn}: wrote ${k} of ${ps.n}`; break; }
      const out = new Float64Array(memory.buffer, ptr, len);
      for (const [p, hexes] of ps.parts) {
        const got = Array.from(out.subarray(p * stride, p * stride + stride));
        const d = firstDiff(got, hexes.slice(0, stride).map(hexToF64));
        if (d) { bad = `pose #${i} (${fx.descs[ps.desc].name}) ${fn} part ${p}: ${d}`; break; }
      }
      if (bad) break;
    }
  }
  check(`${label}: kernel vs rig.json (pose + poseMatrices), bit for bit`, bad === null, bad ?? `${fx.poses.length} poses`);
  if (typeof rigs.free === "function") rigs.free();
}

// ---------------------------------------------------------------------------
// E / G — EntityManager A/B over real ticks.
// ---------------------------------------------------------------------------
const READY = 0x41000003, WALK = 0x45000005, ONESHOT = 0x10000058;
function entityHarness() {
  const byName = (n) => descs.find((d) => d.name === n).desc;
  const clips = {
    [READY]: byName("human-17p-identity-root"),
    [WALK]: byName("human-17p-run"),
    [ONESHOT]: { ...byName("human-17p-run"), rootFrames: null },
  };
  const partMesh = (p) => ({
    triCount: 1,
    positions: new Float32Array([p, 0, 0, p + 0.5, 0, 0, p + 0.25, 0.5, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    surfaceIndices: new Uint8Array([0]),
    surfaces: new Uint32Array([0x08001234]),
  });
  return {
    async fetchEntityAnimationKeyframes(_s, _mc, _tc, _pal, _subs, _mt, cmd, stance, fromMotion) {
      cmd >>>= 0;
      const d = fromMotion >>> 0 ? null : clips[cmd];
      const n = d ? d.numFrames : 0;
      const ft = Float32Array.from({ length: n }, (_, f) => f / 30);
      const meshes = Array.from({ length: 17 }, (_, p) => partMesh(p));
      const out = {
        partCount: 17, numFrames: n, framerate: n ? 30 : 0, duration: n / 30, frameTimes: ft,
        segmentStarts: n ? Uint32Array.of(0) : new Uint32Array(0),
        segmentCounts: n ? Uint32Array.of(n) : new Uint32Array(0),
        resolvedStance: stance || 0x3d,
        partFrames: d ? d.partFrames : new Float32Array(0),
        takePartMeshes() { return meshes.splice(0); },
        takeHooks() { return []; },
      };
      if (d && d.posFrames !== undefined) out.posFrames = d.posFrames;
      if (d && d.rootFrames) out.rootFrames = d.rootFrames;
      return out;
    },
    async fetchEntitySurfacesPixels(dids) {
      return dids.map(() => ({ pixels: new Uint8Array(16).fill(255), width: 2, height: 2 }));
    },
  };
}
function spawnMeta(guid, x, y, z) {
  return {
    guid, modelId: 0x02000001, mtableId: 0x09000001,
    landblockId: 0xa9b40001, x, y, z, qw: 1, qx: 0, qy: 0, qz: 0,
    paletteId: 0, motionCommand: READY, motionStance: 0, objScale: 1, name: "t",
    wcid: 1, itemType: 0x10, iconId: 0,
    modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0),
    subPalettes: new Uint32Array(0),
  };
}

async function runEntityAB(label) {
  console.log(`=== E: EntityManager A/B (${label}) ===`);
  ms._setInPlaceExactForTest(true);
  const { EntityManager } = await import("../scene3d/entities.js");
  const { installFakeMotionSequence } = await import("../harness/lib/fake_motion_sequence.mjs");
  installFakeMotionSequence();
  const wasmExports = entityHarness();
  const mk = async () => {
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    group.rotation.x = -Math.PI / 2;
    scene.add(group);
    const em = new EntityManager({ entitiesGroup: group, materialCache: null }, wasmExports);
    const inst = await em.spawn(spawnMeta(0x50000201, 10, 10, 0));
    return { scene, em, inst };
  };
  ms._setRustRigForTest(false);
  const A = await mk();
  ms._setRustRigForTest(true);
  const B = await mk();
  ms._setRustRigForTest(false);
  if (!A.inst || !B.inst || A.inst.parts.length !== 17) {
    check("E: spawned 17-part rigs", false, `parts ${A.inst?.parts?.length}`);
    return;
  }
  // Each manager seeds its tween clock from performance.now(): the jump-pose
  // tween fraction (now − start) would then round differently per manager.
  A.em._tweenClockMs = 1000;
  B.em._tweenClockMs = 1000;
  let bad = null, steps = 0;
  const compareEntities = (tag) => {
    for (let p = 0; p < 17; p += 1) {
      const d = firstDiff(partState(A.inst.parts[p]), partState(B.inst.parts[p]));
      if (d) return `${tag} part ${p} pose ${d}`;
    }
    A.scene.updateMatrixWorld();
    B.scene.updateMatrixWorld();
    for (let p = 0; p < 17; p += 1) {
      const a = A.inst.parts[p], b = B.inst.parts[p];
      let d = firstDiff(a.matrix.elements, b.matrix.elements) ?? firstDiff(a.matrixWorld.elements, b.matrixWorld.elements);
      if (d) return `${tag} part ${p} matrix ${d}`;
      for (let c = 0; c < a.children.length; c += 1) {
        d = firstDiff(a.children[c].matrixWorld.elements, b.children[c].matrixWorld.elements);
        if (d) return `${tag} part ${p} mesh ${c} ${d}`;
      }
    }
    return null;
  };
  const step = (tag, n, dt = 0.016) => {
    for (let i = 0; i < n && !bad; i += 1) {
      ms._setRustRigForTest(false); A.em.tick(dt);
      ms._setRustRigForTest(true); B.em.tick(dt);
      ms._setRustRigForTest(false);
      bad = compareEntities(`${tag} tick ${i}`);
      steps += 1;
    }
  };
  const both = async (fn) => { ms._setRustRigForTest(false); await fn(A); ms._setRustRigForTest(true); await fn(B); ms._setRustRigForTest(false); };
  const s0 = rig.rustRigStats();
  step("idle (exact, identity root)", 12);
  await both((X) => X.em.setMotion(X.inst.guid, WALK, 0x3d));
  step("walk (exact, stride root)", 25);
  await both((X) => { X.inst._motionSpeedSign = -1; });
  step("backstep (seekPhase path)", 10);
  await both((X) => { X.inst._motionSpeedSign = 1; });
  await both((X) => X.em._tryUnifiedCycleOneShot(X.inst.guid, 0x02000001, 0x09000001, ONESHOT, 0x3d));
  step("one-shot (raw + posFrames)", 30);
  await both((X) => X.em._applyHumanJumpPose(X.inst));
  step("jump-pose tween over the pose", 16);
  await both((X) => X.em._clearHumanJumpPose(X.inst));
  step("jump-pose landing tween", 16);
  const frozen = { n: 17, pos: new Float32Array(17 * 3).map((_, i) => (i % 7) * 0.1), quat: new Float32Array(17 * 4).map((_, i) => (i % 4 === 3 ? 1 : 0)) };
  await both((X) => { X.inst._ragdollFrozenPose = frozen; });
  step("frozen corpse pose over the pose", 6);
  await both((X) => { X.inst._ragdollFrozenPose = null; });
  step("after the corpse pose", 6);
  const s1 = rig.rustRigStats();
  check(`E: ${steps} ticks — every part + mesh world matrix identical`, bad === null, bad ?? "");
  check("E: the flag-on manager posed through the kernel", s1.rigsPosed - s0.rigsPosed >= steps - 2,
    `posed ${s1.rigsPosed - s0.rigsPosed} over ${steps} ticks`);
  A.em.dispose(); B.em.dispose();
}

// G — ?rustEntityCull: the hoisted tick gate vs `_shouldTickEntity`. Entities
// near / far / crossing the 120 m tick radius, the local player (far), one
// with a jump tween (far) and a held item under another entity's part; the
// camera inside the rotated world root. Compared after every tick, BEFORE the
// scene walk: which entities advanced, and every root's matrix / matrixWorld
// and the ancestors' (the gate's side effects); then after the walk.
async function runGateAB() {
  console.log("=== G: ?rustEntityCull hoisted tick gate vs the per-entity gate ===");
  const { EntityManager } = await import("../scene3d/entities.js");
  const { installFakeMotionSequence } = await import("../harness/lib/fake_motion_sequence.mjs");
  installFakeMotionSequence();
  const wasmExports = entityHarness();
  // 0 near the camera; 1 walks out of the radius and back; 2 far (never
  // ticks); 3 the local player (far, always ticks); 4 far with a jump tween
  // (always ticks); 5 just inside; 6 a held item under entity 0's part 3.
  const spots = [[10, 10, 0], [60, 40, 2], [250, 10, 0], [150, 150, 5], [-140, 30, 1], [118, 5, 0], [12, 14, 0]];
  const mk = async (hoist) => {
    const scene = new THREE.Scene();
    const world = new THREE.Group();
    world.rotation.x = -Math.PI / 2;
    world.position.set(0, -1.5, 0);
    scene.add(world);
    const group = new THREE.Group();
    world.add(group);
    const camera = new THREE.PerspectiveCamera();
    scene.add(camera);
    const em = new EntityManager({ entitiesGroup: group, materialCache: null, camera }, wasmExports);
    em._gateHoistOn = hoist;
    const insts = [];
    for (let i = 0; i < spots.length; i += 1) {
      insts.push(await em.spawn(spawnMeta(0x50000300 + i, spots[i][0], spots[i][1], spots[i][2])));
    }
    // Camera near the first entity, in THREE world space.
    const v = new THREE.Vector3();
    insts[0].root.getWorldPosition(v);
    camera.position.set(v.x + 3, v.y + 2, v.z - 4);
    // A held item: entity 6 hangs under entity 0's part 3.
    const held = insts[6];
    held.root.removeFromParent();
    insts[0].parts[3].add(held.root);
    held.root.position.set(0.05, 0, 0.1);
    held._attachedParentGuid = insts[0].guid >>> 0;
    insts[4]._jumpPoseTween = { startMs: 0, durationMs: 1e9, from: new Map(), to: new Map(), isLanding: false, kind: "human" };
    return { scene, world, group, em, insts };
  };
  const A = await mk(false);
  const B = await mk(true);
  A.em._tweenClockMs = 1000; B.em._tweenClockMs = 1000;
  const localGuid = 0x50000303; // the far one at (150, 150)
  globalThis.window.getLocalPlayerGuid = () => localGuid;
  const nodes = (S) => [S.scene, S.world, S.group, ...S.insts.flatMap((x) => [x.root, ...x.parts])];
  let bad = null, steps = 0, ticked = 0, skipped = 0;
  for (let t = 0; t < 40 && !bad; t += 1) {
    // Entity 1 walks out of (and later back into) the tick radius.
    const dx = t < 20 ? 4 : -4;
    for (const S of [A, B]) S.insts[1].root.position.x += dx;
    const adv = (S) => S.insts.map((x) => x._unifiedLoco?.seq?.advanced ?? -1);
    const a0 = adv(A), b0 = adv(B);
    A.em.tick(0.016); B.em.tick(0.016);
    const a1 = adv(A), b1 = adv(B);
    const da = a1.map((v, i) => v - a0[i]), db = b1.map((v, i) => v - b0[i]);
    if (firstDiff(da, db)) { bad = `tick ${t}: ticked ${da} vs ${db}`; break; }
    ticked += da.filter((v) => v > 0).length; skipped += da.filter((v) => v === 0).length;
    const na = nodes(A), nb = nodes(B);
    for (let i = 0; i < na.length && !bad; i += 1) {
      const d = firstDiff(na[i].matrix.elements, nb[i].matrix.elements) ?? firstDiff(na[i].matrixWorld.elements, nb[i].matrixWorld.elements);
      if (d) bad = `tick ${t} node ${i} (${na[i].name || na[i].type}) before the walk: ${d}`;
      else if (na[i].matrixWorldNeedsUpdate !== nb[i].matrixWorldNeedsUpdate) bad = `tick ${t} node ${i} matrixWorldNeedsUpdate`;
    }
    A.scene.updateMatrixWorld(); B.scene.updateMatrixWorld();
    for (let i = 0; i < na.length && !bad; i += 1) {
      const d = firstDiff(na[i].matrixWorld.elements, nb[i].matrixWorld.elements);
      if (d) bad = `tick ${t} node ${i} after the walk: ${d}`;
    }
    steps += 1;
  }
  delete globalThis.window.getLocalPlayerGuid;
  check(`G: ${steps} ticks — same entities ticked, every root/ancestor matrix identical before and after the walk`, bad === null, bad ?? `ticked ${ticked}, gated out ${skipped}`);
  check("G: the run exercised both gate outcomes", ticked > 0 && skipped > 0, `ticked ${ticked}, gated out ${skipped}`);
  check("G: the hoisted gate ran (per-tick state built)", !!B.em._gate && !A.em._gate);
  A.em.dispose(); B.em.dispose();
}

// ---------------------------------------------------------------------------
// Part 1: model backend. Part 2: compiled SceneRigs.
// ---------------------------------------------------------------------------
console.log("rust rig parity — ?rustRig bridge vs the JS poseRigAt");
const fx = checkFixture();
{
  const model = makeModelWasm();
  checkKernelVsFixture("F: ModelSceneRigs (rig.rs in JS)", model.ns, model.memory, fx);
  await runSuite("Part 1: bridge × ModelSceneRigs", model.ns, model.memory, model.growNow);
  core.__setSceneWasmForTest(model.ns, model.memory);
  rig.__resetRustRigForTest();
  await runEntityAB("ModelSceneRigs");
  await runGateAB();
}

let wasm = null;
let skipReason = null;
try {
  const mod = await import(join(app, pkgDir, "holtburger_web.js"));
  const out = await mod.default(readFileSync(join(app, pkgDir, "holtburger_web_bg.wasm")));
  if (typeof mod.sceneCoreAbi !== "function") skipReason = `${pkgDir}/ predates the scene core (no sceneCoreAbi)`;
  else if (typeof mod.SceneRigs !== "function") skipReason = `${pkgDir}/ has no SceneRigs export (rebuild after lane B lands)`;
  else wasm = { ns: mod, memory: out.memory };
} catch (e) {
  skipReason = `wasm pkg ${pkgDir}/ not loadable in Node: ${String(e.message).slice(0, 120)}`;
}
if (wasm) {
  checkKernelVsFixture(`Part 2: compiled SceneRigs (${pkgDir}/)`, wasm.ns, wasm.memory, fx);
  await runSuite(`Part 2: bridge × compiled SceneRigs (${pkgDir}/)`, wasm.ns, wasm.memory, null);
  core.__setSceneWasmForTest(wasm.ns, wasm.memory);
  rig.__resetRustRigForTest();
  await runEntityAB(`compiled SceneRigs (${pkgDir}/)`);
}

console.log("===========================================================");
console.log(`Result: ${passed} passed, ${failed} failed`);
console.log("===========================================================");
if (failed > 0) process.exit(1);
if (!wasm) {
  console.log(`rust rig parity: SKIP — ${skipReason}`);
}
process.exit(0);
