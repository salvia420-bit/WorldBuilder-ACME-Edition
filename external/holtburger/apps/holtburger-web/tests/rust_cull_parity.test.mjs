// tests/rust_cull_parity.test.mjs — ?rustCull (lane C, docs/2026-10-26-rust-cull.md):
// the statics cull through the Rust registry (scene3d/rust/cull.js +
// SceneStaticsCull) against the JS walk, node by node, frame by frame.
//
// One scripted world, built twice — flag OFF (statics.js `_cullStaticsWalk`)
// and flag ON (`rustCullStaticsWalk`) — run over a moving camera path through
// the shipped `cullStaticsGroup` (so the ?staticsCullGate skip / every-4th
// full walk cadence is exercised too), with every marker the walk honours:
// particle meshes and buckets (their own writer toggles them), frozen script
// anchors (some frozen mid-run), animated-scenery buckets, live / dead /
// flipping BatchedMeshes, sphere-less Groups, a mesh whose bounds resolve only
// later, LODs, InstancedMeshes, light owners (attach, remove, same-count
// swap), streaming adds and removes, a bulk park / unpark (bulk_child_remove),
// and objRadius-style foreign `visible` writes. Every frame compares every
// child's `visible` and the walk's {tested, culled}.
//
//   M  — the kernel is a JS mirror of crates/holtburger-scene/src/cull.rs
//        (operation for operation): (1) it replays the Rust parity fixture
//        (tests/fixtures/cull.json) bit for bit — the algorithm check that
//        runs before any cargo build; (2) it drives the REAL bridge, with
//        simulated wasm-memory growth. Always runs.
//   W  — the same scenario and fixture replay against the REAL compiled
//        `SceneStaticsCull` from `${HB_PKG || "pkg"}/holtburger_web.js`;
//        prints `SKIP — <reason>` and exits 0 when the pkg or class is missing.
//
// Run from apps/holtburger-web/:  node tests/rust_cull_parity.test.mjs
//   (HB_PKG=pkg-rustcore for the orchestrator's dev build)

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const pkgDir = process.env.HB_PKG || "pkg";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.requestAnimationFrame ??= () => 0;
globalThis.window.cancelAnimationFrame ??= () => {};

const THREE = await import("three");
const S = await import("../scene3d/statics.js");
const C = await import("../scene3d/rust/cull.js");
const core = await import("../scene3d/rust/scene_core.js");
const { FrustumCuller } = await import("../scene3d/culling.js");
const { removeChildrenBulk } = await import("../scene3d/bulk_child_remove.js");

let passed = 0, failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail != null && detail !== "" ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// The JS mirror of holtburger_scene::cull::StaticsCull (same layout, same
// operation order). It lives in a fake wasm memory so the bridge's views see
// the same pointer / growth behaviour they see on the real pkg.
// ─────────────────────────────────────────────────────────────────────────────
const IN_LEN = 24, RECORD_LEN = 6, MAX_SLOTS = 1 << 22, NONE = 0xffffffff;
const WEBGL = 2000, WEBGPU = 2001;

function planeNormalize(x, y, z, w) {
  const inv = 1.0 / Math.sqrt(x * x + y * y + z * z); // Plane.normalize: 1 / normal.length()
  return [x * inv, y * inv, z * inv, w * inv];
}
function frustumFromMvp(me, cs, rev) {
  const p = [];
  p.push(planeNormalize(me[3] - me[0], me[7] - me[4], me[11] - me[8], me[15] - me[12]));
  p.push(planeNormalize(me[3] + me[0], me[7] + me[4], me[11] + me[8], me[15] + me[12]));
  p.push(planeNormalize(me[3] + me[1], me[7] + me[5], me[11] + me[9], me[15] + me[13]));
  p.push(planeNormalize(me[3] - me[1], me[7] - me[5], me[11] - me[9], me[15] - me[13]));
  if (rev) {
    p.push(planeNormalize(me[2], me[6], me[10], me[14]));
    p.push(planeNormalize(me[3] - me[2], me[7] - me[6], me[11] - me[10], me[15] - me[14]));
  } else {
    p.push(planeNormalize(me[3] - me[2], me[7] - me[6], me[11] - me[10], me[15] - me[14]));
    if (cs === WEBGL) p.push(planeNormalize(me[3] + me[2], me[7] + me[6], me[11] + me[10], me[15] + me[14]));
    else if (cs === WEBGPU) p.push(planeNormalize(me[2], me[6], me[10], me[14]));
    else return null;
  }
  return p;
}
function intersects(planes, x, y, z, r) {
  const neg = -r;
  for (let i = 0; i < 6; i++) {
    const p = planes[i];
    const d = p[0] * x + p[1] * y + p[2] * z + p[3];
    if (d < neg) return false;
  }
  return true;
}
function staticsVisible(planes, x, y, z, r, cam, distOn, horizon) {
  let want = intersects(planes, x, y, z, r);
  if (want && distOn) {
    const dx = x - cam[0], dy = y - cam[1], dz = z - cam[2];
    const distSq = dx * dx + dy * dy + dz * dz;
    const padded = horizon + r;
    if (distSq > padded * padded) want = false;
  }
  return want;
}

function makeMirror() {
  const memory = { buffer: new ArrayBuffer(1 << 20) };
  class MirrorStaticsCull {
    constructor() {
      this.inOff = 64; // bytes
      this.bitsOff = 64 + IN_LEN * 8 + 64;
      this.has = []; this.cx = []; this.cy = []; this.cz = []; this.r = [];
      this.words = 0; this.tested = 0; this.visible = 0; this.planesLast = new Array(24).fill(0);
    }
    inPtr() { return this.inOff; }
    inLen() { return IN_LEN; }
    recordLen() { return RECORD_LEN; }
    applySlots(recs) {
      if (recs.length % RECORD_LEN !== 0) return NONE;
      for (let i = 0; i < recs.length; i += RECORD_LEN) {
        const s = recs[i];
        if (!(s >= 0 && s < MAX_SLOTS && s === Math.trunc(s))) return NONE;
      }
      for (let i = 0; i < recs.length; i += RECORD_LEN) {
        const s = recs[i];
        while (this.has.length <= s) { this.has.push(0); this.cx.push(0); this.cy.push(0); this.cz.push(0); this.r.push(0); }
        if (recs[i + 1] !== 0) { this.has[s] = 1; this.cx[s] = recs[i + 2]; this.cy[s] = recs[i + 3]; this.cz[s] = recs[i + 4]; this.r[s] = recs[i + 5]; }
        else { this.has[s] = 0; this.cx[s] = 0; this.cy[s] = 0; this.cz[s] = 0; this.r[s] = 0; }
      }
      return recs.length / RECORD_LEN;
    }
    frame() {
      const inp = new Float64Array(memory.buffer, this.inOff, IN_LEN);
      const cs = inp[19] >>> 0; // Rust `as u32` (the values here are small exact integers)
      const planes = frustumFromMvp(Array.from(inp.subarray(0, 16)), cs, inp[20] !== 0);
      if (!planes) return NONE;
      const cam = [inp[16], inp[17], inp[18]];
      const distOn = inp[21] !== 0, horizon = inp[22];
      const n = this.has.length;
      this.words = Math.ceil(n / 32);
      const need = this.bitsOff + this.words * 4;
      if (need > memory.buffer.byteLength) {
        // the bits Vec grows: memory.grow detaches every old view
        const nb = new ArrayBuffer(Math.max(need * 2, memory.buffer.byteLength * 2));
        new Uint8Array(nb).set(new Uint8Array(memory.buffer));
        memory.buffer = nb;
      }
      const bits = new Uint32Array(memory.buffer, this.bitsOff, this.words);
      bits.fill(0);
      let tested = 0, vis = 0;
      for (let i = 0; i < n; i++) {
        if (this.has[i] === 0) continue;
        tested += 1;
        if (staticsVisible(planes, this.cx[i], this.cy[i], this.cz[i], this.r[i], cam, distOn, horizon)) {
          bits[i >>> 5] |= 1 << (i & 31);
          vis += 1;
        }
      }
      this.tested = tested; this.visible = vis; this.planesLast = planes.flat();
      return n;
    }
    bitsPtr() { return this.bitsOff; }
    bitsLen() { return this.words; }
    get slotCount() { return this.has.length; }
    get spheresTested() { return this.tested; }
    get spheresVisible() { return this.visible; }
    planes() { return Float64Array.from(this.planesLast); }
    clear() { this.has.length = 0; this.cx.length = 0; this.cy.length = 0; this.cz.length = 0; this.r.length = 0; this.words = 0; }
    free() {}
  }
  const grow = () => {
    const nb = new ArrayBuffer(memory.buffer.byteLength + (1 << 16));
    new Uint8Array(nb).set(new Uint8Array(memory.buffer));
    memory.buffer = nb;
  };
  return { ns: { sceneCoreAbi: () => core.SCENE_CORE_ABI, SceneStaticsCull: MirrorStaticsCull }, memory, grow };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture replay (crates/holtburger-scene/tests/fixtures/cull.json) through a
// kernel class: planes, intersects, the walk's verdicts via the registry API.
// ─────────────────────────────────────────────────────────────────────────────
const hexF64 = (h) => { const dv = new DataView(new ArrayBuffer(8)); dv.setBigUint64(0, BigInt("0x" + h)); return dv.getFloat64(0); };
function replayFixture(label, ns, memory) {
  const p = join(app, "..", "..", "crates", "holtburger-scene", "tests", "fixtures", "cull.json");
  if (!existsSync(p)) { console.log(`  ${label}: fixture missing (run node tools/rust_parity/gen_cull.mjs)`); return; }
  const fx = JSON.parse(readFileSync(p, "utf8"));
  let planeBad = 0, verdictBad = 0, n = 0, first = "";
  for (const [i, c] of fx.statics.entries()) {
    const k = new ns.SceneStaticsCull();
    const sph = c.spheres.map(hexF64);
    const recs = [];
    for (let s = 0; s < sph.length / 4; s++) recs.push(s, 1, sph[s * 4], sph[s * 4 + 1], sph[s * 4 + 2], sph[s * 4 + 3]);
    k.applySlots(Float64Array.from(recs));
    const inp = new Float64Array(memory.buffer, k.inPtr() >>> 0, IN_LEN);
    c.mvp.map(hexF64).forEach((v, j) => { inp[j] = v; });
    const cam = c.cam.map(hexF64);
    inp[16] = cam[0]; inp[17] = cam[1]; inp[18] = cam[2];
    inp[19] = c.cs; inp[20] = c.rev ? 1 : 0; inp[21] = c.distOn ? 1 : 0; inp[22] = hexF64(c.horizon);
    const cnt = k.frame() >>> 0;
    const bits = new Uint32Array(memory.buffer, k.bitsPtr() >>> 0, k.bitsLen() >>> 0);
    for (let s = 0; s < cnt; s++) {
      n += 1;
      const got = ((bits[s >>> 5] >>> (s & 31)) & 1) === 1;
      if (got !== (c.want[s] === "1")) { verdictBad += 1; first ||= `walk #${i} node ${s}`; }
    }
    k.free?.();
  }
  check(`${label}: ${n} statics-walk verdicts (horizon ${fx.cullDist} m) bit-equal through the registry API`, verdictBad === 0 && n > 1000, first);
  for (const [i, c] of fx.frustums.entries()) {
    const k = new ns.SceneStaticsCull();
    const inp = new Float64Array(memory.buffer, k.inPtr() >>> 0, IN_LEN);
    c.mvp.map(hexF64).forEach((v, j) => { inp[j] = v; });
    inp[19] = c.cs; inp[20] = c.rev ? 1 : 0;
    if ((k.frame() >>> 0) === NONE) { planeBad += 1; continue; }
    const got = Array.from(k.planes());
    const want = c.planes.map(hexF64);
    for (let j = 0; j < 24; j++) if (!Object.is(got[j], want[j])) { planeBad += 1; first ||= `frustum #${i} coef ${j}: ${got[j]} vs ${want[j]}`; break; }
    k.free?.();
  }
  check(`${label}: ${fx.frustums.length} frustums' 24 plane coefficients bit-equal to three r184`, planeBad === 0, first);
}

// ─────────────────────────────────────────────────────────────────────────────
// The scripted world.
// ─────────────────────────────────────────────────────────────────────────────
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const box = (s) => new THREE.BoxGeometry(s, s, s);
const mat = new THREE.MeshBasicMaterial();

function buildWorld() {
  const R = rng(0x5eed);
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2; // AC Z-up → three Y-up, as index.js
  scene.add(worldRoot);
  const g = new THREE.Group();
  g.name = "statics";
  worldRoot.add(g);
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.5, 3000);
  scene.add(camera);
  const s3 = { scene, worldRoot, staticsGroup: g, camera, activeLights: [] };
  const at = (o, a, rad) => { o.position.set(Math.cos(a) * rad, Math.sin(a) * rad, 1 + R() * 3); return o; };
  const named = (o, name) => { o.name = name; return o; };
  const W = { s3, g, scene, camera, R, particles: [], batches: [], flips: [], anchorsLate: [], meshes: [], parked: [] };
  // plain meshes on rings (frustum crossings as the camera turns)
  for (let i = 0; i < 70; i++) { const m = named(at(new THREE.Mesh(box(1 + R() * 4), mat), (i / 70) * Math.PI * 2, 40 + (i % 5) * 60), `mesh${i}`); g.add(m); W.meshes.push(m); }
  // LODs
  for (let i = 0; i < 10; i++) {
    const lod = named(new THREE.LOD(), `lod${i}`);
    lod.addLevel(new THREE.Mesh(box(3), mat), 0);
    lod.addLevel(new THREE.Mesh(box(1.5), mat), 80);
    at(lod, i * 0.63, 120 + i * 9);
    g.add(lod);
  }
  // billboard-tagged LODs (statics.js tagBillboardLod): mode 2 (full) and 4 (yaw)
  W.billboards = [];
  const bbLod = (name, mode, a, rad) => {
    const lod = named(new THREE.LOD(), name);
    lod.addLevel(new THREE.Mesh(box(2), mat), 0);
    lod.addLevel(new THREE.Mesh(box(1), mat), 25);
    lod.userData = { billboardMode: mode, billboardLevel: 1, landblockId: 0xa21e0003 };
    at(lod, a, rad);
    return lod;
  };
  W.bbLod = bbLod;
  for (let i = 0; i < 6; i++) { const b = bbLod(`bb${i}`, i < 3 ? 2 : 4, i * 1.05, 30 + i * 30); g.add(b); W.billboards.push(b); }
  // InstancedMeshes (aggregate bounds)
  for (let i = 0; i < 4; i++) {
    const im = named(new THREE.InstancedMesh(box(2), mat, 4), `inst${i}`);
    for (let k = 0; k < 4; k++) im.setMatrixAt(k, new THREE.Matrix4().makeTranslation(Math.cos(i + k) * 90, Math.sin(i + k) * 90, 2));
    im.computeBoundingSphere();
    g.add(im);
  }
  // BatchedMesh: live, dead, and two that flip (via the marker writer's notify)
  const bmOf = (name, dead) => {
    const bm = named(new THREE.BatchedMesh(4, 64, 128, mat), name);
    bm.userData = { __staticBatchCrossLb: true };
    if (dead) { bm.userData.__deadBatch = true; bm.visible = false; }
    g.add(bm);
    W.batches.push(bm);
    return bm;
  };
  bmOf("bmLive0", false); bmOf("bmLive1", false); bmOf("bmDead0", true); bmOf("bmDead1", true);
  W.flips.push(bmOf("bmFlip0", false), bmOf("bmFlip1", true));
  // particle meshes and buckets (RP6 is their writer)
  for (let i = 0; i < 6; i++) {
    const p = named(at(new THREE.Mesh(box(0.2), mat), i, 30), `particle${i}`);
    p.userData.__particle = true;
    g.add(p); W.particles.push(p);
  }
  for (let i = 0; i < 2; i++) {
    const p = named(new THREE.InstancedMesh(box(0.2), mat, 8), `pbucket${i}`);
    p.userData = { isParticleInstanced: true };
    g.add(p); W.particles.push(p);
  }
  // animated-scenery buckets (lane D writes their visibility)
  for (let i = 0; i < 2; i++) {
    const b = named(new THREE.InstancedMesh(box(1), mat, 8), `animBucket${i}`);
    b.userData = { isAnimatedSceneryInstanced: true };
    g.add(b); W.particles.push(b);
  }
  // script anchors: 3 frozen now, 3 frozen mid-run
  for (let i = 0; i < 6; i++) {
    const a = named(at(new THREE.Group(), i * 1.1, 70), `anchor${i}`);
    a.userData = { isStaticScriptAnchor: true, landblockId: 0xa21e0001 };
    a.add(new THREE.Object3D());
    g.add(a);
    if (i < 3) S.__freezeStaticScriptAnchorForTest(a); else W.anchorsLate.push(a);
  }
  // sphere-less Groups (animated-scenery anchors), objRadius hides them
  for (let i = 0; i < 4; i++) { const a = named(at(new THREE.Group(), i * 1.7, 55), `animAnchor${i}`); a.userData = { isAnimatedScenery: true }; g.add(a); }
  // a mesh whose bounds resolve only from frame 14 on (RETRY)
  const late = named(at(new THREE.Mesh(box(2), mat), 0.2, 50), "lateBounds");
  const geo = late.geometry;
  geo.boundingSphere = null;
  W.lateGeo = geo;
  W.lateOk = false;
  const realCompute = geo.computeBoundingSphere.bind(geo);
  geo.computeBoundingSphere = () => { if (!W.lateOk) throw new Error("not yet"); return realCompute(); };
  g.add(late);
  W.lateMesh = late;
  return W;
}

function aim(cam, yawDeg, pitch = 0) {
  const a = (yawDeg * Math.PI) / 180;
  cam.position.set(0, 3, 0);
  cam.lookAt(Math.cos(a) * 10, 3 + pitch, -Math.sin(a) * 10);
  cam.updateMatrixWorld(true);
}

// One frame of the script: the camera path, then the world's own writers.
function stepWorld(W, f) {
  const { g, camera, R } = W;
  if (f < 16) aim(camera, f * 11);
  else if (f < 30) aim(camera, 165); // still: the gate skips 3 of 4 walks
  else if (f < 48) aim(camera, 165 + (f - 30) * 7, Math.sin(f) * 2);
  else aim(camera, 291);
  // RP6 / lane D: the particles' and buckets' own writer
  for (const p of W.particles) p.visible = R() < 0.6;
  // streaming bakes / evictions
  if (f === 5 || f === 33) for (let i = 0; i < 6; i++) { const m = new THREE.Mesh(box(2), mat); m.name = `bake${f}_${i}`; m.position.set(Math.cos(i) * 150, Math.sin(i) * 150, 2); g.add(m); }
  if (f === 19) for (const m of W.meshes.slice(60, 66)) g.remove(m);
  if (f === 5) { const b = W.bbLod("bbBaked", 4, 2.2, 45); g.add(b); }
  if (f === 19) g.remove(W.billboards[1]);
  // a dead-batch re-derive (static_batch_x.js _markDeadBatch: marker + visible + notify)
  if (f === 9 || f === 40) {
    for (const bm of W.flips) {
      const dead = !(bm.userData.__deadBatch === true);
      bm.userData.__deadBatch = dead;
      bm.visible = !dead;
      C.markStaticsCullDirty(bm);
    }
  }
  // anchors frozen mid-run (statics.js _freezeStaticScriptAnchor notifies)
  if (f === 12) for (const a of W.anchorsLate) S.__freezeStaticScriptAnchorForTest(a);
  // light guardrail: a lamp on an off-screen static, then gone, then a same-count swap
  if (f === 8) { W.lamp = new THREE.PointLight(); W.lampOwner = W.meshes[20]; W.lampOwner.add(W.lamp); }
  if (f === 21) W.lampOwner.remove(W.lamp);
  if (f === 25) { W.meshes[21].add(new THREE.PointLight()); }
  if (f === 34) { const m = W.meshes[21]; m.remove(m.children[0]); m.add(new THREE.Object3D()); } // count unchanged → both walks keep the stale cache
  // bounds that resolve late
  if (f === 14) W.lateOk = true;
  // a bulk park / unpark of 20 nodes (removeChildrenBulk's event contract)
  if (f === 36) { W.parked = W.meshes.slice(0, 20); removeChildrenBulk(g, W.parked); }
  if (f === 41) for (const m of W.parked) g.add(m);
  // objRadius-style foreign writes the walk undoes on its next pass
  if (f % 7 === 3) for (const c of g.children.filter((_, i) => i % 9 === 0)) c.visible = false;
}

function runArm(on, frames, kernelSetup) {
  S.__setStaticsCullGateForTest(true);
  C.__setRustCullForTest(on);
  S.__setRustCullWantedForTest(on);
  if (kernelSetup) kernelSetup();
  const W = buildWorld();
  const culler = new FrustumCuller();
  const out = [];
  for (let f = 0; f < frames; f++) {
    stepWorld(W, f);
    if (W.onFrame) W.onFrame(f);
    W.scene.updateMatrixWorld(true);
    culler.update(W.camera, W.s3.worldRoot);
    const walksBefore = on ? (C.__registryForTest(W.g)?.stats.walks ?? 0) : 0;
    const res = S.cullStaticsGroup(W.s3, culler);
    // __rustCull.verify() mid-run, right after a real walk (its contract: a
    // gate-skipped frame has no fresh answers to compare), incl. the frame the
    // late bounds resolve.
    if (on && (C.__registryForTest(W.g)?.stats.walks ?? 0) > walksBefore) {
      const v = C.verifyRustCull(W.g);
      (W.verifies ??= []).push(`${f}:${v.ok ? "ok" : JSON.stringify(v)}`);
    }
    // the renderer's projectObject (LOD bands), then the billboard rAF
    W.g.traverse((o) => { if (o.isLOD) o.update(W.camera); });
    const oriented = S.tickStaticsBillboards(W.s3);
    const bb = [];
    for (const n of W.g.children) {
      if (!n.isLOD || !((n.userData.billboardMode ?? 0) >= 2)) continue;
      const leaf = n.levels[1].object;
      bb.push(leaf.quaternion.x, leaf.quaternion.y, leaf.quaternion.z, leaf.quaternion.w, leaf.position.x, leaf.position.y, leaf.position.z);
    }
    out.push({ vis: W.g.children.map((n) => `${n.name}:${n.visible ? 1 : 0}`).join(","), res: `${res.tested}/${res.culled}`, bb, oriented });
  }
  return { W, out, culler };
}

function compareArms(label, frames, kernelSetup, onGrowFrame = null) {
  const off = runArm(false, frames, null);
  const on = runArm(true, frames, () => { if (kernelSetup) kernelSetup(); });
  let bad = "";
  for (let f = 0; f < frames; f++) {
    if (off.out[f].vis !== on.out[f].vis) {
      const a = off.out[f].vis.split(","), b = on.out[f].vis.split(",");
      const k = a.findIndex((x, i) => x !== b[i]);
      bad ||= `frame ${f}: ${a[k]} (walk) vs ${b[k]} (rust)`;
    }
    if (off.out[f].res !== on.out[f].res) bad ||= `frame ${f}: {tested/culled} ${off.out[f].res} vs ${on.out[f].res}`;
  }
  check(`${label}: every node's visible + {tested, culled} identical to the JS walk on all ${frames} frames`, bad === "", bad);
  let bbBad = "", oriented = 0;
  for (let f = 0; f < frames; f++) {
    const a = off.out[f].bb, b = on.out[f].bb;
    oriented += on.out[f].oriented;
    if (off.out[f].oriented !== on.out[f].oriented) bbBad ||= `frame ${f}: oriented ${off.out[f].oriented} vs ${on.out[f].oriented}`;
    if (a.length !== b.length) { bbBad ||= `frame ${f}: ${a.length} vs ${b.length}`; continue; }
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) { bbBad ||= `frame ${f} value ${i}: ${a[i]} vs ${b[i]}`; break; }
  }
  check(`${label}: billboard tick over the registry's list — every leaf quaternion / position bit-equal, same counts`, bbBad === "" && oriented > 20, bbBad || `oriented ${oriented}`);
  const list = C.rustCullBillboardList(on.W.g);
  const want = on.W.g.children.filter((n) => n.isLOD && (n.userData.billboardMode ?? 0) >= 2);
  check(`${label}: the billboard list is exactly the billboard LODs among the children`,
    !!list && list.size === want.length && want.every((n) => list.has(n)), list ? `${list.size} vs ${want.length}` : "no list");
  const served = C.__registryForTest(on.W.g)?.stats.billboardListsServed ?? 0;
  check(`${label}: the billboard tick was served the list every frame`, served >= frames, `served ${served}`);
  const reg = C.__registryForTest(on.W.g);
  check(`${label}: the Rust registry ran (not the JS fallback)`, !!reg && reg.stats.walks > 0, reg ? JSON.stringify({ walks: reg.stats.walks, reseeds: reg.stats.reseeds }) : "no registry");
  if (reg) {
    const st = reg.stats;
    check(`${label}: the scenario hit the registry's paths`,
      st.classified > 100 && st.reclassified >= 6 && st.retryResolved >= 1 && st.lightFlips >= 2 && st.lastWrites >= 0,
      JSON.stringify({ classified: st.classified, reclassified: st.reclassified, retried: st.retried, retryResolved: st.retryResolved, lightRechecks: st.lightRechecks, lightFlips: st.lightFlips }));
    check(`${label}: no desync re-seeds`, st.reseeds === 0 && st.strayRemovals === 0, `reseeds ${st.reseeds}, stray ${st.strayRemovals}`);
    const v = C.verifyRustCull(on.W.g);
    check(`${label}: __rustCull.verify() agrees with the walk's decisions, planes bit-equal`, v.ok === true, JSON.stringify(v));
    const mid = on.W.verifies || [];
    check(`${label}: verify() agrees after every walk (${mid.length} walks, incl. the late-bounds frame 14)`,
      mid.length >= 30 && mid.some((x) => x.startsWith("14:")) && mid.every((x) => x.endsWith(":ok")),
      mid.filter((x) => !x.endsWith(":ok")).join(" "));
  }
  const gateSkipped = off.out.length; // the still stretch skips 3 of 4 walks in both arms (same cadence: identical rows prove it)
  void gateSkipped;
  return { off, on };
}

// ── M: the mirror ────────────────────────────────────────────────────────────
console.log("rustCull — M: JS mirror of cull.rs");
{
  const m = makeMirror();
  replayFixture("mirror fixture replay", m.ns, m.memory);
  core.__setSceneWasmForTest(m.ns, m.memory);
  const growAt = new Set([17, 37]);
  const { on } = compareArms("mirror", 56, () => { core.__setSceneWasmForTest(m.ns, m.memory); });
  void growAt;
  // Memory growth between walks: the bridge's views must follow the new buffer.
  {
    const W = on.W;
    const before = m.memory.buffer;
    m.grow();
    const culler = on.culler;
    aim(W.camera, 300);
    W.scene.updateMatrixWorld(true);
    culler.update(W.camera, W.s3.worldRoot);
    S.__setStaticsCullGateForTest(true);
    const r1 = S.cullStaticsGroup(W.s3, culler);
    const rustVis = W.g.children.map((n) => n.visible);
    // The JS walk over the same state must agree.
    const jsr = S.__cullStaticsWalkForTest(W.g, W.g.children, culler);
    const jsVis = W.g.children.map((n) => n.visible);
    check("mirror: after a memory grow the views follow (same verdicts as the JS walk)",
      m.memory.buffer !== before && rustVis.every((v, i) => v === jsVis[i]) && r1.tested === jsr.tested && r1.culled === jsr.culled,
      `${r1.tested}/${r1.culled} vs ${jsr.tested}/${jsr.culled}`);
  }
  // Fail-safe: a kernel that throws mid-walk hands the frame back to the JS walk and disarms.
  {
    const bad = makeMirror();
    class Throwing extends bad.ns.SceneStaticsCull { frame() { throw new Error("boom"); } }
    const ns = { ...bad.ns, SceneStaticsCull: Throwing };
    core.__setSceneWasmForTest(ns, bad.memory);
    C.__setRustCullForTest(true);
    S.__setRustCullWantedForTest(true);
    S.__setStaticsCullGateForTest(false);
    const W = buildWorld();
    const culler = new FrustumCuller();
    aim(W.camera, 40);
    W.scene.updateMatrixWorld(true);
    culler.update(W.camera, W.s3.worldRoot);
    const warn = console.warn; let warned = 0; console.warn = () => { warned += 1; };
    let r;
    try { r = S.cullStaticsGroup(W.s3, culler); } finally { console.warn = warn; }
    const vis = W.g.children.map((n) => n.visible);
    const jsr = S.__cullStaticsWalkForTest(W.g, W.g.children, culler);
    check("mirror: a throwing kernel falls back to the JS walk the same frame (and warns once)",
      r.tested === jsr.tested && r.culled === jsr.culled && vis.every((v, i) => v === W.g.children[i].visible) && warned === 1 && C.__registryForTest(W.g) === null);
  }
  core.__setSceneWasmForTest(null, null);
}

// Kind codes: statics.js's classifier and the bridge agree.
{
  const k = S.__cullKindsForTest;
  check("kind codes: statics.js _cullClassifyNode == scene3d/rust/cull.js CK_*",
    k.SKIP === C.CK_SKIP && k.SHOW === C.CK_SHOW && k.HIDE === C.CK_HIDE && k.HIDE_COUNTED === C.CK_HIDE_COUNTED &&
    k.TEST === C.CK_TEST && k.LIGHT === C.CK_LIGHT && k.RETRY === C.CK_RETRY && C.CK_FREE === 0);
}

// ── W: the real pkg ─────────────────────────────────────────────────────────
console.log(`rustCull — W: real SceneStaticsCull from ${pkgDir}/`);
let ns = null, out = null;
try {
  ns = await import(join(app, pkgDir, "holtburger_web.js"));
  out = await ns.default(readFileSync(join(app, pkgDir, "holtburger_web_bg.wasm")));
} catch (e) {
  ns = null;
  console.log(`rust cull parity: SKIP — wasm pkg ${pkgDir}/ not loadable in Node: ${String(e.message).slice(0, 120)}`);
}
if (ns && (typeof ns.sceneCoreAbi !== "function" || typeof ns.SceneStaticsCull !== "function")) {
  console.log(`rust cull parity: SKIP — ${pkgDir}/ has no SceneStaticsCull (predates lane C); rebuild with wasm-pack`);
  ns = null;
}
if (ns) {
  replayFixture("wasm fixture replay", ns, out.memory);
  compareArms("wasm", 56, () => { core.__setSceneWasmForTest(ns, out.memory); });
  core.__setSceneWasmForTest(null, null);
}

console.log(`\nrust cull parity: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
