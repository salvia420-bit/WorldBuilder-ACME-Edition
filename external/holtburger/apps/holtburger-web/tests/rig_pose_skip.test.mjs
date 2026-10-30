// tests/rig_pose_skip.test.mjs — `?rigPoseSkip` (round 3 R3-2; scene3d/motion/motion_sequence.js
// `poseRigSkipping`): a rig whose pose key is unchanged and whose parts nothing else wrote skips
// poseRigAt's stores. The bar is EXACTNESS against the flag-off poser, proven here A/B:
//   R  the flag reader (default OFF, `=on` opts in, read once) and the flag-off path (no record,
//      no hook, no diag object);
//   U  poseRigAt A/B over scripted sequences on three routes (JS setters; the Rust bridge over an
//      echo SceneRigs that computes with the JS poser — parity with rig.rs is
//      rust_rig_parity.test.mjs's job; the compiled pkg/ when it loads): idle, walk, speed changes,
//      mode / ?inPlaceExact / descriptor transitions, every descriptor field swapped in place, every
//      writer the app has (jump-tween slerp, limp, grip pose, Euler writes, applyMatrix4,
//      Object3D.copy, the announced ragdoll position-only write), slot replacement / growth /
//      truncation / holes / stubs, a held item attached and detached, the NaN guard and signed
//      zeros, a route switch. After EVERY call: every part's position, quaternion and Euler, then
//      after a scene walk every part / mesh / held-item matrix and matrixWorld, Object.is-equal.
//   E  the real EntityManager A/B over ticks (fake wasm): idle, walk, speed changes, backstep, a
//      raw one-shot with root motion, the jump-pose tween and its landing, a frozen corpse pose, a
//      position-only ragdoll (the tick's announcement), a held item with its grip pose, a NaN dt.
//   M  mutations: with ONE key field dropped (the module's knockout seam) the same U / E runs
//      must find a difference — every field is load-bearing.
//   B  the documented boundary: an UNANNOUNCED position-only write is not seen (the contract);
//      verify mode counts it as a violation and poses.
//   F  the key's route is the route the last pose TOOK (round 3 lane S): a kernel pose, then at the
//      SAME key a call the bridge declines (SceneRigs.pose throws / returns a short count / returns
//      0; the descriptor's registration evicted and refused on its way back) — flag-off runs the
//      JS body there, which re-derives part.rotation; the skip must too. Echo + compiled backends.
//   H  the route probe keeps the bridge's state flag-off's (round 3 lane S2): under the float
//      cap's LRU pressure, one transient decline (the JS body posed last), then a later probe on
//      another rig — the skip arm must make the bridge calls flag-off makes, so the same
//      descriptors stay registered / get evicted, and a refused re-registration declines (and
//      re-derives part.rotation) in both arms. Pose state AND bridge counters after every call.
//   G  the tick's ragdoll announcement is gated (round 3 lane S): with the flag off the ragdoll
//      block never calls invalidateRigPose (no lookup of the rig's part array), as at HEAD.
//   D  rigMeshAlias is deleted: setup_rig.js exports none of it, spawned parts walk as three's.
// Run: node tests/rig_pose_skip.test.mjs   (HB_PKG=pkg-x for another wasm build)

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
const SETUP_RIG = await import("../scene3d/setup_rig.js");
const { installSkipHiddenMatrix } = await import("../scene3d/skip_hidden_matrix.js");
installSkipHiddenMatrix(THREE, { force: true });

let passed = 0, failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail != null && detail !== "" ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}
const same = (a, b) => Object.is(a, b);
function firstDiff(a, b) {
  for (let i = 0; i < a.length; i += 1) if (!same(a[i], b[i])) return `[${i}] ${a[i]} vs ${b[i]}`;
  return a.length === b.length ? null : `length ${a.length} vs ${b.length}`;
}

// ---------------------------------------------------------------------------
// R — the flag reader and the flag-off path.
// ---------------------------------------------------------------------------
console.log("rig pose skip — ?rigPoseSkip vs the flag-off poser");
console.log("=== R: flag reader, flag-off path ===");
{
  check("R: default OFF (no URL parameter)", ms.rigPoseSkipEnabled() === false);
  const reads = [];
  for (const [search, want] of [["?rigPoseSkip=on", true], ["?rigPoseSkip=1", true], ["?rigPoseSkip=off", false], ["?rigPoseSkip=bogus", false], ["", false]]) {
    globalThis.location = { search }; // rustFlag reads globalThis.location
    core.__setRustFlagForTest("rigPoseSkip", undefined); // clear the memo, keep no override
    const m = await import(`../scene3d/motion/motion_sequence.js?reader=${encodeURIComponent(search || "none")}`);
    reads.push(`${search || "(none)"}→${m.rigPoseSkipEnabled()}`);
    if (m.rigPoseSkipEnabled() !== want) reads.push("WRONG");
  }
  delete globalThis.location;
  core.__setRustFlagForTest("rigPoseSkip", undefined);
  check("R: `=on`/`1` opt in; absent / `off` / anything else ⇒ off", !reads.includes("WRONG"), reads.join(" "));
  // Flag off: poseRigAt makes no record, installs no hook, publishes no diag object.
  ms._setRustRigForTest(false);
  const descs = gen.buildRigDescriptors();
  const d = descs.find((x) => x.name === "human-17p-run").desc;
  const parts = gen.makeParts(17, []);
  const cb0 = parts[0].quaternion._onChangeCallback;
  const s0 = ms.rigPoseSkipStats();
  for (let f = 0; f < 6; f += 1) { ms.poseRigAt(3, d, parts, true); ms.poseRigAt(f, d, parts, true); }
  const s1 = ms.rigPoseSkipStats();
  check("R: flag off — no pose recorded, skipped or hooked; three's callbacks untouched; no window.__rigPoseSkip",
    s1.posed === s0.posed && s1.skipped === s0.skipped && s1.hooked === s0.hooked &&
    parts[0].quaternion._onChangeCallback === cb0 && parts.every((g) => !/rigPoseSkip/.test(g.quaternion._onChangeCallback.name) && !/rigPoseSkip/.test(g.rotation._onChangeCallback.name)) &&
    window.__rigPoseSkip === undefined,
    `posed +${s1.posed - s0.posed}, skipped +${s1.skipped - s0.skipped}, hooked +${s1.hooked - s0.hooked}`);
  check("R: the module names exactly these key fields", ms.RIG_POSE_SKIP_KEY_FIELDS.join(",") ===
    "f,mode,desc,partFrames,posFrames,rootFrames,partCount,numFrames,route,slots,written,announced", ms.RIG_POSE_SKIP_KEY_FIELDS.join(","));
}

// ---------------------------------------------------------------------------
// Rust-route backends. The echo SceneRigs computes each pose with the JS poser
// (flag off, JS route) on the descriptor it registered — so the bridge's real
// write-back (raw stores, no Euler sync), registration and fallbacks run.
// ---------------------------------------------------------------------------
function makeEchoWasm() {
  const memory = { buffer: new ArrayBuffer(1 << 16) };
  class SceneRigs {
    constructor() { this.slots = []; this.ptr = 64; this.len = 0; }
    registerDescriptor(pc, nf, pf, pos, hasPos, rf, hasRoot) {
      pc >>>= 0; nf >>>= 0;
      if (pc === 0 || nf === 0 || pf.length !== nf * pc * 7) return 0;
      const d = {
        partFrames: Float32Array.from(pf), posFrames: hasPos ? Float32Array.from(pos) : null,
        rootFrames: hasRoot && rf.length === nf * 7 ? Float32Array.from(rf) : null, partCount: pc, numFrames: nf,
      };
      if (this.len < pc * 7) {
        this.len = pc * 7;
        if (memory.buffer.byteLength < this.ptr + this.len * 8) memory.buffer = new ArrayBuffer((this.ptr + this.len * 8) * 2);
      }
      this.slots.push(d);
      return this.slots.length;
    }
    unregister(id) { const had = !!this.slots[id - 1]; this.slots[id - 1] = null; return had; }
    pose(id, frame, mode, n) {
      const d = this.slots[id - 1];
      if (!d || !(mode === 0 || mode === 1 || mode === 2)) return 0;
      n = Math.min(n, d.partCount, Math.floor(this.len / 7));
      const out = new Float64Array(memory.buffer, this.ptr, this.len);
      const sink = [];
      for (let p = 0; p < n; p += 1) {
        const o = p * 7;
        sink.push({
          position: { set(x, y, z) { out[o] = x; out[o + 1] = y; out[o + 2] = z; } },
          quaternion: { set(x, y, z, w) { out[o + 3] = x; out[o + 4] = y; out[o + 5] = z; out[o + 6] = w; } },
        });
      }
      const skip = ms.rigPoseSkipEnabled();
      ms._setRustRigForTest(false);
      ms._setRigPoseSkipForTest(false);
      try {
        ms.poseRigAt(frame, d, sink, mode !== 0); // mode 1 vs 2: the caller's ?inPlaceExact, as the kernel
      } finally {
        ms._setRustRigForTest(true);
        ms._setRigPoseSkipForTest(skip);
      }
      return n;
    }
    outPtr() { return this.ptr; }
    outLen() { return this.len; }
    free() {}
  }
  return { ns: { sceneCoreAbi: () => core.SCENE_CORE_ABI, SceneRigs }, memory };
}
const echo = makeEchoWasm();
// The same backend with injectable faults (F): `fault.pose` = "throw" (SceneRigs.pose throws),
// "short" (one part short of the count asked), "zero" (0 parts: the kernel's answer for an id it
// does not know); `fault.register` refuses every registration (id 0). Subclassing keeps the
// backend's own registration, pose and output buffer, so the bridge's real fallbacks run.
function faultBackend(backend, fault) {
  class FaultRigs extends backend.ns.SceneRigs {
    registerDescriptor(...args) {
      return fault.register ? 0 : super.registerDescriptor(...args);
    }
    pose(id, frame, mode, n) {
      if (fault.pose === "throw") throw new Error("injected: SceneRigs.pose fault");
      const k = super.pose(id, frame, mode, n);
      if (fault.pose === "short") return k > 0 ? k - 1 : k;
      if (fault.pose === "zero") return 0;
      return k;
    }
  }
  return { ns: { ...backend.ns, SceneRigs: FaultRigs }, memory: backend.memory };
}
let compiled = null;
let compiledSkip = null;
try {
  const mod = await import(join(app, pkgDir, "holtburger_web.js"));
  const out = await mod.default({ module_or_path: readFileSync(join(app, pkgDir, "holtburger_web_bg.wasm")) });
  if (typeof mod.sceneCoreAbi !== "function" || typeof mod.SceneRigs !== "function") compiledSkip = `${pkgDir}/ has no SceneRigs`;
  else compiled = { ns: mod, memory: out.memory };
} catch (e) {
  compiledSkip = `wasm pkg ${pkgDir}/ not loadable in Node: ${String(e.message).slice(0, 100)}`;
}
// A route = how the A and B arms pose: `rust` routes through the bridge on `backend`.
function useRoute(route) {
  if (route.rust) {
    core.__setSceneWasmForTest(route.backend.ns, route.backend.memory);
    rig.__resetRustRigForTest();
    rig.__setRustRigForTest(true);
  }
  ms._setRustRigForTest(route.rust);
}
const ROUTES = [
  { name: "JS route", rust: false },
  { name: "Rust route (echo SceneRigs)", rust: true, backend: echo },
];
if (compiled) ROUTES.push({ name: `Rust route (compiled SceneRigs, ${pkgDir}/)`, rust: true, backend: compiled });

// ---------------------------------------------------------------------------
// U — poseRigAt A/B over scripted sequences.
// ---------------------------------------------------------------------------
const q90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

// A posed rig in a scene: worldRoot (−π/2) → an off-origin rotated, scaled root → parts, one
// mesh child under each part.
function makeRig(nParts) {
  const scene = new THREE.Scene();
  const world = new THREE.Group();
  world.rotation.x = -Math.PI / 2;
  scene.add(world);
  const root = new THREE.Group();
  root.position.set(101.25, -7.5, 3.125);
  root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.7);
  root.scale.setScalar(1.25);
  world.add(root);
  const parts = gen.makeParts(nParts, [], root);
  for (const g of parts) {
    const m = new THREE.Mesh(new THREE.BufferGeometry(), null);
    m.position.set(0.01, 0, 0);
    g.add(m);
  }
  return { scene, world, root, parts, held: null, stubs: [] };
}
function setterStub() {
  const s = { calls: 0 };
  s.position = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; s.calls += 1; } };
  s.quaternion = { _x: 0, _y: 0, _z: 0, _w: 1, set(x, y, z, w) { this._x = x; this._y = y; this._z = z; this._w = w; s.calls += 1; } };
  return s;
}

// A and B after a call: local state (+ Euler), then three's matrices after a walk.
function compareRigs(A, B) {
  const n = Math.max(A.parts.length, B.parts.length);
  for (let p = 0; p < n; p += 1) {
    const a = A.parts[p], b = B.parts[p];
    if (!a || !b) { if (!!a !== !!b) return `slot ${p} presence`; continue; }
    if (a.isObject3D !== true) {
      const d = firstDiff([a.position.x, a.position.y, a.position.z, a.quaternion._x, a.quaternion._y, a.quaternion._z, a.quaternion._w, a.calls],
        [b.position.x, b.position.y, b.position.z, b.quaternion._x, b.quaternion._y, b.quaternion._z, b.quaternion._w, b.calls]);
      if (d) return `stub ${p} ${d}`;
      continue;
    }
    const qa = a.quaternion, qb = b.quaternion, ea = a.rotation, eb = b.rotation;
    const d = firstDiff([a.position.x, a.position.y, a.position.z, qa._x, qa._y, qa._z, qa._w, ea._x, ea._y, ea._z, a.scale.x, a.scale.y, a.scale.z],
      [b.position.x, b.position.y, b.position.z, qb._x, qb._y, qb._z, qb._w, eb._x, eb._y, eb._z, b.scale.x, b.scale.y, b.scale.z]);
    if (d) return `part ${p} pose/Euler ${d}`;
  }
  A.scene.updateMatrixWorld();
  B.scene.updateMatrixWorld();
  for (let p = 0; p < n; p += 1) {
    const a = A.parts[p], b = B.parts[p];
    if (!a || a.isObject3D !== true) continue;
    let d = firstDiff(a.matrix.elements, b.matrix.elements) ?? firstDiff(a.matrixWorld.elements, b.matrixWorld.elements);
    if (d) return `part ${p} matrix ${d}`;
    for (let c = 0; c < a.children.length; c += 1) {
      d = firstDiff(a.children[c].matrixWorld.elements, b.children[c].matrixWorld.elements);
      if (d) return `part ${p} child ${c} matrixWorld ${d}`;
    }
  }
  return null;
}

// The scripted U sequence. `step(tag, fn)` applies fn to both arms (fn(R, side)) then nothing;
// `pose(tag, desc, f, inPlace)` poses A with the skip off and B with it on, then compares.
// Returns the first difference (or null) and how many B calls skipped.
function runScript(route, { verifyB = false, boundary = false } = {}) {
  useRoute(route);
  ms._setInPlaceExactForTest(true);
  const D = Object.fromEntries(gen.buildRigDescriptors().map((x) => [x.name, x.desc]));
  const RUN = D["human-17p-run"], IDR = D["human-17p-identity-root"], SHORT = D["creature-9p-short-pos"], SZ = D["signed-zero-3p"];
  const A = makeRig(17), B = makeRig(17);
  let bad = null, poses = 0;
  const st0 = ms.rigPoseSkipStats();
  ms.rigPoseSkipVerify(verifyB);
  const pose = (tag, desc, f, inPlace, AA = A, BB = B) => {
    if (bad) return;
    ms._setRigPoseSkipForTest(false);
    ms.poseRigAt(f, desc, AA.parts, inPlace);
    ms._setRigPoseSkipForTest(true);
    ms.poseRigAt(f, desc, BB.parts, inPlace);
    ms._setRigPoseSkipForTest(false);
    poses += 1;
    const d = compareRigs(AA, BB);
    if (d) bad = `${route.name}: ${tag} (f=${f}, inPlace=${inPlace}): ${d}`;
  };
  const both = (fn) => { fn(A, "A"); fn(B, "B"); };
  const fs = (tag, desc, frames, inPlace = true) => { for (const f of frames) pose(`${tag} f${f}`, desc, f, inPlace); };

  fs("idle", RUN, [3, 3, 3, 3]);
  fs("walk", RUN, [3, 4, 4, 5, 5, 5, 6]);
  fs("speed change", RUN, [6, 6, 6, 6, 8, 8, 10, 10, 13, 32, 32, 0, 0]);
  // mode: raw + posFrames, in place exact, mean drift
  fs("mode 0", RUN, [10, 10], false);
  fs("mode 2", RUN, [10, 10], true);
  ms._setInPlaceExactForTest(false);
  fs("mode 1 (?inPlaceExact=off)", RUN, [10, 10], true);
  ms._setInPlaceExactForTest(true);
  fs("mode 2 again", RUN, [10, 10], true);
  // descriptor transitions at one frame (a cycle swap, a link, back)
  fs("to the identity-root cycle", IDR, [10, 10]);
  fs("back to the run", RUN, [10, 10]);
  // two descriptors sharing every field but the mean-drift cache (`_inPlaceDisp` on the
  // object): D2 was posed while it held other buffers, then given the run's.
  {
    const { _inPlaceDisp: _c, ...fields } = RUN; // no copied cache: each builds its own
    const D1 = { ...fields, rootFrames: null };
    const alt = RUN.partFrames.slice();
    // a frame-dependent stride (a constant offset cancels in the mean drift)
    for (let i = 0; i < alt.length; i += 7) alt[i] += 0.375 * Math.floor(i / (RUN.partCount * 7));
    const D2 = { ...fields, rootFrames: null, partFrames: alt };
    const scratch = gen.makeParts(17, []);
    const rr = route.rust;
    ms._setRustRigForTest(false); ms.poseRigAt(5, D2, scratch, true); ms._setRustRigForTest(rr);
    D2.partFrames = RUN.partFrames; // same five fields as D1 now, its cache still from `alt`
    fs("descriptor A", D1, [5, 5]);
    fs("descriptor B, same fields, own cache", D2, [5, 5]);
  }
  // every descriptor field swapped on the SAME object at one frame
  {
    const S = { ...RUN };
    fs("swap base", S, [7, 7]);
    const pf2 = RUN.partFrames.slice();
    for (let i = 0; i < pf2.length; i += 7) pf2[i] += 0.5;
    S.partFrames = pf2;
    fs("partFrames swapped", S, [7, 7]);
    const rf2 = RUN.rootFrames.slice();
    for (let i = 0; i < rf2.length; i += 7) rf2[i] += 0.25;
    S.rootFrames = rf2;
    fs("rootFrames swapped", S, [7, 7]);
    fs("raw", S, [7, 7], false);
    const pos2 = RUN.posFrames.slice();
    for (let i = 0; i < pos2.length; i += 1) pos2[i] += 0.125;
    S.posFrames = pos2;
    fs("posFrames swapped (raw)", S, [7, 7], false);
    fs("in place again", S, [7, 7]);
    S.partCount = 16;
    fs("partCount 17 → 16", S, [7, 7]);
    S.partCount = 17;
    fs("partCount back", S, [7, 7]);
    S.numFrames = 32; // rootFrames no longer 7 x numFrames: exact falls back to mean drift
    fs("numFrames 33 → 32", S, [7, 7]);
    S.numFrames = 33;
    fs("numFrames back", S, [7, 7]);
  }
  // every writer between two same-key poses
  fs("before the writers", RUN, [9]);
  const writers = [
    ["jump-tween slerp", (R) => R.parts[3].quaternion.slerpQuaternions(R.parts[3].quaternion.clone(), q90, 0.37)],
    ["quaternion copy", (R) => R.parts[2].quaternion.copy(q90)],
    ["full Euler write", (R) => R.parts[7].rotation.set(0.1, 0.2, 0.3)],
    ["partial Euler write", (R) => { R.parts[7].rotation.x += 0.0625; }],
    ["applyMatrix4", (R) => R.parts[10].applyMatrix4(new THREE.Matrix4().makeTranslation(0.5, 0, 0))],
    ["Object3D.copy onto a part", (R) => R.parts[11].copy(R.parts[12], false)],
    ["limp (position.set + quaternion.set)", (R) => { R.parts[6].position.set(1, 2, 3); R.parts[6].quaternion.set(0, 0, 0.6, 0.8); }],
    ["limp restore with the same values", (R) => { const g = R.parts[6]; g.position.set(g.position.x, g.position.y, g.position.z); g.quaternion.set(g.quaternion.x, g.quaternion.y, g.quaternion.z, g.quaternion.w); }],
    ["grip pose (position.set + quaternion.copy)", (R) => { R.parts[1].position.set(0.05, 0, 0.1); R.parts[1].quaternion.copy(q90); }],
    ["ragdoll position-only write, announced", (R) => { R.parts[4].position.set(0.5, -0.25, 1.5); R.parts[5].position.z += 0.125; ms.invalidateRigPose(R.parts); }],
    ["scale write (not a pose input)", (R) => R.parts[8].scale.set(1, 2, 1)],
  ];
  for (const [name, w] of writers) {
    both(w);
    fs(`after ${name}`, RUN, [9, 9]);
  }
  // slots
  {
    both((R) => {
      const old = R.parts[5];
      const g = new THREE.Group();
      g.position.copy(old.position); // same position, a fresh (identity) quaternion
      g.add(new THREE.Mesh(new THREE.BufferGeometry(), null));
      R.root.remove(old); R.root.add(g); R.parts[5] = g;
    });
    fs("a slot replaced by a fresh part", RUN, [9, 9]);
    both((R) => { const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.BufferGeometry(), null)); R.root.add(g); R.parts.push(g); });
    fs("an extra part past partCount", RUN, [9, 9]);
    both((R) => { R.saved = R.parts.splice(10); });
    fs("array cut to 10 parts", RUN, [9, 9, 10]);
    both((R) => { R.parts.push(...R.saved); });
    fs("array grown back", RUN, [10, 10]);
    both((R) => { R.savedHole = R.parts[6]; R.parts[6] = null; });
    fs("a hole", RUN, [10, 10]);
    both((R) => { R.parts[6] = R.savedHole; });
    fs("the hole refilled", RUN, [10, 10]);
    both((R) => { R.savedStub = R.parts[2]; R.parts[2] = setterStub(); });
    fs("a setter stub in a slot", RUN, [10, 10, 11, 11]);
    both((R) => { R.parts[2] = R.savedStub; });
    fs("the stub replaced back", RUN, [11, 11]);
  }
  // a held item under a part, detached again
  {
    both((R) => {
      const item = new THREE.Group();
      item.position.set(0.02, 0, 0.1);
      item.add(new THREE.Mesh(new THREE.BufferGeometry(), null));
      R.parts[3].add(item);
      R.held = item;
    });
    const heldEq = (tag) => {
      if (bad) return;
      const d = firstDiff(A.held.matrixWorld.elements, B.held.matrixWorld.elements) ??
        firstDiff(A.held.children[0].matrixWorld.elements, B.held.children[0].matrixWorld.elements);
      if (d) bad = `${route.name}: ${tag}: held item ${d}`;
    };
    fs("held item attached", RUN, [11, 11, 12]);
    heldEq("held item attached");
    both((R) => { R.root.attach(R.held); });
    fs("held item moved to the root", RUN, [12, 12]);
    heldEq("held item moved");
    both((R) => { R.held.removeFromParent(); });
    fs("held item detached", RUN, [12, 12]);
  }
  // the NaN guard, clamps, NaN poses, signed zeros
  fs("NaN / negative / past-the-end frames", RUN, [NaN, NaN, 0, -5, -5, 1e9, 32, 32.75, 33]);
  {
    const A9 = makeRig(9), B9 = makeRig(9);
    for (const f of [8, 8, 9, 9, 2, 2]) pose(`short posFrames (NaN raw pose) f${f}`, SHORT, f, false, A9, B9);
    const A3 = makeRig(3), B3 = makeRig(3);
    for (const [f, ip] of [[1, false], [1, false], [2, true], [2, true], [3, false], [3, false]]) pose(`signed zeros f${f}`, SZ, f, ip, A3, B3);
  }
  // a route switch at one key (the JS route re-derives the Euler the Rust route leaves)
  {
    const A2 = makeRig(17), B2 = makeRig(17);
    if (!route.rust) useRoute(ROUTES[1]);
    pose("on the Rust route", RUN, 4, true, A2, B2);
    pose("on the Rust route again", RUN, 4, true, A2, B2);
    ms._setRustRigForTest(false);
    pose("switched to the JS route, same key", RUN, 4, true, A2, B2);
    pose("JS route again", RUN, 4, true, A2, B2);
    useRoute(route);
  }
  // the documented boundary: an unannounced position-only write
  let boundaryDiff = null;
  if (boundary) {
    fs("boundary base", RUN, [9, 9]);
    both((R) => { R.parts[4].position.z += 0.5; });
    ms._setRigPoseSkipForTest(false);
    ms.poseRigAt(9, RUN, A.parts, true);
    ms._setRigPoseSkipForTest(true);
    ms.poseRigAt(9, RUN, B.parts, true);
    ms._setRigPoseSkipForTest(false);
    boundaryDiff = compareRigs(A, B);
    // re-sync both for whatever follows
    both((R) => ms.invalidateRigPose(R.parts));
    fs("after the boundary, announced", RUN, [9]);
  }
  ms.rigPoseSkipVerify(false);
  const st1 = ms.rigPoseSkipStats();
  const delta = Object.fromEntries(Object.keys(st1).filter((k) => typeof st1[k] === "number").map((k) => [k, st1[k] - st0[k]]));
  return { bad, poses, stats: delta, boundaryDiff };
}

console.log("=== U: poseRigAt A/B (skip off vs on), every call ===");
for (const route of ROUTES) {
  const r = runScript(route);
  check(`U: ${route.name} — ${r.poses} calls, every part pose / Euler / matrix / matrixWorld / mesh / held item identical`, r.bad === null, r.bad ?? "");
  check(`U: ${route.name} — the skip engaged and every kind of re-pose happened`,
    r.stats.skipped > 40 && r.stats.keyChanged > 20 && r.stats.written >= 9 && r.stats.slotChanged >= 4 && r.stats.unhookable >= 1 && r.stats.violations === 0,
    JSON.stringify(r.stats));
}
{
  const r = runScript(ROUTES[1], { verifyB: true });
  check("U: verify mode (every would-be skip re-read) — identical, 0 violations", r.bad === null && r.stats.violations === 0 && r.stats.verified > 40,
    r.bad ?? `verified ${r.stats.verified}, violations ${r.stats.violations}`);
}

// ---------------------------------------------------------------------------
// B — the documented boundary.
// ---------------------------------------------------------------------------
console.log("=== B: the unannounced position-only write (the contract's one blind spot) ===");
{
  const r = runScript(ROUTES[1], { boundary: true });
  check("B: an unannounced position-only write is NOT seen (url-flags rigPoseSkip: such a writer must call invalidateRigPose)",
    r.bad === null && r.boundaryDiff !== null && /pose\/Euler/.test(r.boundaryDiff), r.boundaryDiff ?? "no difference");
  const v = runScript(ROUTES[1], { boundary: true, verifyB: true });
  check("B: verify mode catches it — one violation, then posed: identical", v.bad === null && v.boundaryDiff === null && v.stats.violations === 1,
    v.boundaryDiff ?? `violations ${v.stats.violations}`);
}

// ---------------------------------------------------------------------------
// F — the route the last pose TOOK (round 3 lane S). ?rustRig stays on throughout; only the
// bridge's answer changes. Before this, the key held the ?rustRig boolean, so the call the bridge
// declined (flag-off: the JS body, which re-derives part.rotation from the quaternion the kernel
// had stored raw) was skipped and the Euler stayed stale.
// ---------------------------------------------------------------------------
const FAULTS = ["throw", "short", "zero", "evicted, re-registration refused"];
// Every part's position, quaternion, Euler, matrix, matrixWorld and mesh matrixWorld (after a walk).
function rigState(R) {
  R.scene.updateMatrixWorld();
  const out = [];
  for (const g of R.parts) {
    out.push(g.position.x, g.position.y, g.position.z, g.quaternion._x, g.quaternion._y, g.quaternion._z, g.quaternion._w,
      g.rotation._x, g.rotation._y, g.rotation._z, ...g.matrix.elements, ...g.matrixWorld.elements);
    for (const c of g.children) out.push(...c.matrixWorld.elements);
  }
  return out;
}
// One arm of F, run ALONE on its own fresh bridge (the arms do not interleave, so the skip arm
// cannot lean on the flag-off arm's bridge calls having met the fault first).
function runFallbackArm(base, kind, skip) {
  const fault = { pose: null, register: false };
  useRoute({ name: base.name, rust: true, backend: faultBackend(base.backend, fault) });
  ms._setInPlaceExactForTest(true);
  const RUN = gen.buildRigDescriptors().find((x) => x.name === "human-17p-run").desc;
  const D = { ...RUN };
  const R = makeRig(17);
  const st0 = ms.rigPoseSkipStats();
  const steps = [];
  const pose = (tag, f) => {
    ms._setRigPoseSkipForTest(skip);
    ms.poseRigAt(f, D, R.parts, true);
    ms._setRigPoseSkipForTest(false);
    steps.push({ tag: `${tag} (f=${f})`, state: rigState(R) });
  };
  const eulers = () => R.parts.map((g) => [g.rotation._x, g.rotation._y, g.rotation._z]);
  pose("the kernel poses", 4);
  pose("same key, the kernel again", 4);
  const e0 = eulers();
  if (kind === "evicted, re-registration refused") {
    // A second descriptor registered under a 1-float cap evicts every other one (LRU), then every
    // registration is refused: this arm's descriptor re-registers on its next call and fails.
    rig.__setRigFloatCapForTest(1);
    ms.poseRigAt(4, { ...RUN }, makeRig(17).parts, true);
    fault.register = true;
  } else {
    fault.pose = kind;
  }
  const fb0 = rig.rustRigStats().jsFallbacks;
  pose("same key, the bridge declines (flag-off: the JS body)", 4);
  const declined = rig.rustRigStats().jsFallbacks - fb0;
  const eulerMoved = eulers().some((e, p) => e.some((v, i) => !same(v, e0[p][i])));
  pose("same key, declined again", 4);
  fault.pose = null;
  fault.register = false;
  rig.__setRigFloatCapForTest(undefined);
  pose("same key, the bridge takes it again", 4);
  pose("next frame", 5);
  pose("next frame, same key", 5);
  pose("frame 4 again", 4);
  const st1 = ms.rigPoseSkipStats();
  const stats = Object.fromEntries(Object.keys(st1).filter((k) => typeof st1[k] === "number").map((k) => [k, st1[k] - st0[k]]));
  return { steps, declined, eulerMoved, stats };
}
function runFallback(base, kind) {
  const A = runFallbackArm(base, kind, false);
  const B = runFallbackArm(base, kind, true);
  let bad = null;
  for (let i = 0; i < A.steps.length && !bad; i += 1) {
    const d = firstDiff(A.steps[i].state, B.steps[i].state);
    if (d) bad = `${base.name}, ${kind}: ${A.steps[i].tag}: state ${d}`;
  }
  return { bad, declinedA: A.declined, declinedB: B.declined, eulerMoved: A.eulerMoved, stats: B.stats };
}

console.log("=== F: the key's route is the route the last pose took (forced fallback at the same key) ===");
for (const base of ROUTES.filter((r) => r.rust)) {
  for (const kind of FAULTS) {
    const r = runFallback(base, kind);
    check(`F: ${base.name}, ${kind} — a kernel pose, then the bridge declines at the same key: every part pose / Euler / matrix identical`,
      r.bad === null, r.bad ?? "");
    // Teeth: the fault declined exactly one bridge call in EACH arm (flag-off's pose; the skip's
    // route probe, then the JS body without a second call), and the JS body's Euler differs from
    // what the kernel left, so a skip there would have shown.
    check(`F: ${base.name}, ${kind} — the fault declined one bridge call per arm, the JS body moved the Euler, the skip re-posed once`,
      r.declinedA === 1 && r.declinedB === 1 && r.eulerMoved && r.stats.routeChanged === 1 && r.stats.probed >= 2 && r.stats.skipped >= 3 && r.stats.violations === 0,
      `declined ${r.declinedA}/${r.declinedB}, euler moved ${r.eulerMoved}, ${JSON.stringify(r.stats)}`);
  }
}

// ---------------------------------------------------------------------------
// H — the route probe keeps the bridge's registrations and LRU flag-off's (round 3 lane S2). With
// ?rustRig on, flag-off asks the bridge on EVERY call, and the bridge's answer depends on its own
// state: which descriptors are registered, and the LRU order its float cap evicts by. Lane S
// probed only after a KERNEL pose, so a rig the JS body posed last (after one transient decline)
// skipped its bridge call: no re-registration, no LRU stamp. Under the cap the arms then evicted
// different descriptors, and once a re-registration was refused, flag-off's call on the other
// rig declined (the JS body: part.rotation re-derived) while the skip arm's probe was taken (the
// Euler stale). Two layouts of the cap pressure:
//   evicted    a 1-float cap: every registration evicts every other descriptor (A's call
//              re-registers A and so evicts B, or it does not happen);
//   LRU order  a cap with room for two of three equal descriptors: registering C evicts the least
//              recently posed of A and B (A's call stamps A newer than B, or it does not happen).
// Each arm runs ALONE on its own fresh bridge. After every call: all rigs' full state AND the
// bridge's counters (rustRigStats less partsRaw / partsSetter, which a probe into no part leaves
// out, and the GC-driven `unregistered`).
// ---------------------------------------------------------------------------
const DRIFT_FAULTS = ["throw", "short", "zero"];
const DRIFT_LAYOUTS = ["evicted", "LRU order"];
const BRIDGE_KEYS = ["available", "descriptors", "floats", "rigsPosed", "jsFallbacks", "registered", "rejected", "evicted"];
function bridgeState() {
  const s = rig.rustRigStats();
  return BRIDGE_KEYS.map((k) => s[k]);
}
function runBridgeDriftArm(base, kind, layout, skip) {
  const fault = { pose: null, register: false };
  useRoute({ name: base.name, rust: true, backend: faultBackend(base.backend, fault) });
  ms._setInPlaceExactForTest(true);
  const RUN = gen.buildRigDescriptors().find((x) => x.name === "human-17p-run").desc;
  // Equal descriptors (the same buffers), distinct objects: the bridge registers each on its own.
  const DA = { ...RUN }, DB = { ...RUN }, DC = { ...RUN };
  const A = makeRig(17), B = makeRig(17), C = makeRig(17);
  const st0 = ms.rigPoseSkipStats();
  const steps = [];
  const pose = (tag, D, R, f) => {
    ms._setRigPoseSkipForTest(skip);
    ms.poseRigAt(f, D, R.parts, true);
    ms._setRigPoseSkipForTest(false);
    steps.push({ tag: `${tag} (f=${f})`, state: [...rigState(A), ...rigState(B), ...rigState(C)], bridge: bridgeState() });
  };
  const eulers = (R) => R.parts.flatMap((g) => [g.rotation._x, g.rotation._y, g.rotation._z]);
  let declined = -1, eulerMoved = false;
  try {
    pose("A: the kernel poses", DA, A, 4);
    // 1 float; or room for two descriptors and not three, C's eviction stopping after one
    // (the bridge evicts down to 3/4 of the cap: 2 x floats <= 0.75 x 2.8 x floats)
    rig.__setRigFloatCapForTest(layout === "evicted" ? 1 : Math.floor(rig.rustRigStats().floats * 2.8));
    pose("B: the kernel poses", DB, B, 4);
    fault.pose = kind;
    pose("A: same key, one transient decline (the JS body)", DA, A, 4);
    fault.pose = null;
    pose("B: same key, the bridge takes it", DB, B, 4);
    pose("A: same key, the JS body posed last (flag-off: the bridge takes it)", DA, A, 4);
    if (layout === "LRU order") pose("C: the kernel poses (registering C evicts the LRU of A and B)", DC, C, 4);
    fault.register = true;
    const fb0 = rig.rustRigStats().jsFallbacks;
    const e0 = eulers(B);
    pose("B: same key, re-registration refused (flag-off: B was evicted, the bridge declines)", DB, B, 4);
    declined = rig.rustRigStats().jsFallbacks - fb0;
    eulerMoved = eulers(B).some((v, i) => !same(v, e0[i]));
    fault.register = false;
    pose("B: same key again", DB, B, 4);
    pose("A: same key again", DA, A, 4);
    if (layout === "LRU order") pose("C: same key", DC, C, 4);
    pose("A: next frame", DA, A, 5);
    pose("B: next frame", DB, B, 5);
    pose("A: next frame, same key", DA, A, 5);
    pose("B: next frame, same key", DB, B, 5);
  } finally {
    fault.pose = null;
    fault.register = false;
    rig.__setRigFloatCapForTest(undefined);
  }
  const st1 = ms.rigPoseSkipStats();
  const stats = Object.fromEntries(Object.keys(st1).filter((k) => typeof st1[k] === "number").map((k) => [k, st1[k] - st0[k]]));
  return { steps, declined, eulerMoved, stats };
}
function runBridgeDrift(base, kind, layout) {
  const X = runBridgeDriftArm(base, kind, layout, false);
  const Y = runBridgeDriftArm(base, kind, layout, true);
  let bad = null, badBridge = null;
  for (let i = 0; i < X.steps.length; i += 1) {
    if (!bad) {
      const d = firstDiff(X.steps[i].state, Y.steps[i].state);
      if (d) bad = `${X.steps[i].tag}: state ${d}`;
    }
    if (!badBridge) {
      const a = X.steps[i].bridge, b = Y.steps[i].bridge;
      const k = a.findIndex((v, j) => !same(v, b[j]));
      if (k >= 0) badBridge = `${X.steps[i].tag}: ${BRIDGE_KEYS[k]} flag-off ${a[k]} vs skip ${b[k]}`;
    }
  }
  return { bad, badBridge, X, Y };
}

console.log("=== H: the route probe keeps the bridge's registrations / LRU flag-off's (cap pressure + one transient decline + a later probe) ===");
for (const base of ROUTES.filter((r) => r.rust)) {
  for (const layout of DRIFT_LAYOUTS) {
    for (const kind of DRIFT_FAULTS) {
      const r = runBridgeDrift(base, kind, layout);
      const tag = `${base.name}, ${layout}, ${kind}`;
      check(`H: ${tag} — every part pose / Euler / matrix of every rig identical after every call`, r.bad === null, r.bad ?? "");
      check(`H: ${tag} — the bridge's registrations, evictions and LRU-driven counters identical after every call`,
        r.badBridge === null, r.badBridge ?? "");
      // Teeth: the refused re-registration declined exactly one call in EACH arm and the JS body
      // moved the Euler there; the skip arm re-posed at both declines and probed every would-be skip.
      const s = r.Y.stats;
      check(`H: ${tag} — the refusal declined one call per arm and moved the Euler; the skip re-posed at both declines`,
        r.X.declined === 1 && r.Y.declined === 1 && r.X.eulerMoved && s.routeChanged === 2 && s.probed >= 8 && s.skipped >= 6 && s.violations === 0,
        `declined ${r.X.declined}/${r.Y.declined}, euler moved ${r.X.eulerMoved}, ${JSON.stringify(s)}`);
    }
  }
}
useRoute(ROUTES[0]);

// ---------------------------------------------------------------------------
// E — EntityManager A/B over real ticks.
// ---------------------------------------------------------------------------
const READY = 0x41000003, WALK = 0x45000005, ONESHOT = 0x10000058;
function entityHarness() {
  const descs = gen.buildRigDescriptors();
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
    // the held-item grip pose (_applyChildPlacementFrames)
    async fetchSetupPlacementFrames(_sid, placement) {
      const frames = Array.from({ length: 17 }, (_, i) => ({
        partIndex: i, ox: 0.01 * i + 0.001 * placement, oy: -0.02 * i, oz: 0.05,
        qw: 0.8, qx: 0.6, qy: 0, qz: 0,
      }));
      return { takeFrames: () => frames.splice(0) };
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
let EntityManager = null;
async function runEntityAB(route) {
  if (!EntityManager) {
    ({ EntityManager } = await import("../scene3d/entities.js"));
    const { installFakeMotionSequence } = await import("../harness/lib/fake_motion_sequence.mjs");
    installFakeMotionSequence();
  }
  useRoute(route);
  ms._setInPlaceExactForTest(true);
  const wasmExports = entityHarness();
  const mk = async () => {
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    group.rotation.x = -Math.PI / 2;
    scene.add(group);
    const em = new EntityManager({ entitiesGroup: group, materialCache: null }, wasmExports);
    const inst = await em.spawn(spawnMeta(0x50000201, 10, 10, 0));
    const held = await em.spawn(spawnMeta(0x50000202, 11, 10, 0));
    em._tweenClockMs = 1000; // the jump-pose tween fraction must round the same in both
    return { scene, group, em, inst, held };
  };
  const A = await mk();
  const B = await mk();
  if (!A.inst || !B.inst || A.inst.parts.length !== 17 || !A.held || !B.held) {
    return { bad: `spawn failed (parts ${A.inst?.parts?.length})`, steps: 0, stats: {} };
  }
  let bad = null, steps = 0;
  const nodesOf = (S) => [S.inst.root, ...S.inst.parts, S.held.root, ...S.held.parts];
  const compare = (tag) => {
    const na = nodesOf(A), nb = nodesOf(B);
    for (let i = 0; i < na.length; i += 1) {
      const a = na[i], b = nb[i];
      const d = firstDiff([a.position.x, a.position.y, a.position.z, a.quaternion._x, a.quaternion._y, a.quaternion._z, a.quaternion._w, a.rotation._x, a.rotation._y, a.rotation._z],
        [b.position.x, b.position.y, b.position.z, b.quaternion._x, b.quaternion._y, b.quaternion._z, b.quaternion._w, b.rotation._x, b.rotation._y, b.rotation._z]);
      if (d) return `${tag} node ${i} (${a.name}) pose ${d}`;
    }
    A.scene.updateMatrixWorld();
    B.scene.updateMatrixWorld();
    for (let i = 0; i < na.length; i += 1) {
      const a = na[i], b = nb[i];
      let d = firstDiff(a.matrix.elements, b.matrix.elements) ?? firstDiff(a.matrixWorld.elements, b.matrixWorld.elements);
      if (d) return `${tag} node ${i} (${a.name}) matrix ${d}`;
      for (let c = 0; c < a.children.length; c += 1) {
        d = firstDiff(a.children[c].matrixWorld.elements, b.children[c].matrixWorld.elements);
        if (d) return `${tag} node ${i} (${a.name}) child ${c} ${d}`;
      }
    }
    return null;
  };
  const step = (tag, n, dt = 0.016) => {
    for (let i = 0; i < n && !bad; i += 1) {
      ms._setRigPoseSkipForTest(false); A.em.tick(dt);
      ms._setRigPoseSkipForTest(true); B.em.tick(dt);
      ms._setRigPoseSkipForTest(false);
      bad = compare(`${tag} tick ${i}`);
      steps += 1;
    }
  };
  const both = async (fn) => { await fn(A); await fn(B); };
  const st0 = ms.rigPoseSkipStats();
  step("idle (exact, identity root)", 12);
  await both((X) => X.em.setMotion(X.inst.guid, WALK, 0x3d));
  step("walk", 25);
  step("walk, slow frames", 10, 0.004);
  step("walk, fast frames", 10, 0.05);
  step("walk, mixed", 10, 0.011);
  await both((X) => { X.inst._motionSpeedSign = -1; });
  step("backstep (seekPhase path)", 10);
  await both((X) => { X.inst._motionSpeedSign = 1; });
  await both((X) => X.em._tryUnifiedCycleOneShot(X.inst.guid, 0x02000001, 0x09000001, ONESHOT, 0x3d));
  step("one-shot (raw + posFrames)", 30);
  await both((X) => X.em._applyHumanJumpPose(X.inst));
  step("jump-pose tween over the pose", 16);
  await both((X) => X.em._clearHumanJumpPose(X.inst));
  step("jump-pose landing tween", 16);
  step("after the tweens", 6, 0.004);
  const frozen = { n: 17, pos: new Float32Array(17 * 3).map((_, i) => (i % 7) * 0.1), quat: new Float32Array(17 * 4).map((_, i) => (i % 4 === 3 ? 1 : 0)) };
  await both((X) => { X.inst._ragdollFrozenPose = frozen; });
  step("frozen corpse pose over the pose", 6, 0.004);
  await both((X) => { X.inst._ragdollFrozenPose = null; });
  step("after the corpse pose", 6, 0.004);
  // A settled ragdoll with no swings: applyRagdoll moves every part by POSITION only.
  const fakeRagdoll = () => ({
    sim: { done: true, n: 17, pos: Float64Array.from({ length: 51 }, (_, i) => 0.05 * i - 0.5) },
    parentIndex: new Int32Array(17).fill(-1), boneChild: new Int32Array(17).fill(-1), restDir: new Array(17).fill(null),
    q0: [], swing: [], swingSet: new Uint8Array(17), swingOut: new Float64Array(4), swingFrozen: true, reported: true,
  });
  await both((X) => { X.inst._ragdoll = fakeRagdoll(); });
  step("position-only ragdoll over the pose", 6, 0.004);
  await both((X) => { X.inst._ragdoll = null; });
  step("after the ragdoll (pose back, same frames)", 6, 0.004);
  // the held item: under the wielder's part 3, given its grip pose, then dropped
  await both(async (X) => {
    X.held.root.removeFromParent();
    X.inst.parts[3].add(X.held.root);
    X.held.root.position.set(0.05, 0, 0.1);
    X.held._attachedParentGuid = X.inst.guid >>> 0;
    await X.em._applyChildPlacementFrames(X.held.guid, 0x02000001, 1);
  });
  step("held item with its grip pose", 8, 0.004);
  await both((X) => { X.held.root.removeFromParent(); X.group.add(X.held.root); X.held._attachedParentGuid = 0; });
  step("held item dropped", 8, 0.004);
  step("NaN dt", 2, NaN);
  step("after the NaN dt", 6);
  const st1 = ms.rigPoseSkipStats();
  const stats = Object.fromEntries(Object.keys(st1).filter((k) => typeof st1[k] === "number").map((k) => [k, st1[k] - st0[k]]));
  A.em.dispose(); B.em.dispose();
  return { bad, steps, stats };
}

console.log("=== E: EntityManager A/B over real ticks (skip off vs on) ===");
for (const route of ROUTES) {
  const r = await runEntityAB(route);
  check(`E: ${route.name} — ${r.steps} ticks, every root / part / held-item pose, Euler, matrix, matrixWorld and mesh identical`, r.bad === null && r.steps > 150, r.bad ?? "");
  check(`E: ${route.name} — skips and every re-pose kind happened`,
    r.stats.skipped > 50 && r.stats.keyChanged > 50 && r.stats.written > 10 && r.stats.violations === 0, JSON.stringify(r.stats));
}

// ---------------------------------------------------------------------------
// G — the tick's ragdoll announcement is gated on the flag (round 3 lane S). With ?rigPoseSkip off
// the ragdoll block reads the flag and stops: no invalidateRigPose call, so no lookup of the rig's
// part array in the skip's record map — call for call as at HEAD, before the skip existed. Seen
// through WeakMap.prototype.get with that part array as the key (only the skip keys a map by it).
// With the flag on, the same ticks look it up once more per tick than without the ragdoll.
// ---------------------------------------------------------------------------
async function runRagdollGate() {
  if (!EntityManager) {
    ({ EntityManager } = await import("../scene3d/entities.js"));
    const { installFakeMotionSequence } = await import("../harness/lib/fake_motion_sequence.mjs");
    installFakeMotionSequence();
  }
  useRoute(ROUTES[0]);
  ms._setInPlaceExactForTest(true);
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  group.rotation.x = -Math.PI / 2;
  scene.add(group);
  const em = new EntityManager({ entitiesGroup: group, materialCache: null }, entityHarness());
  const inst = await em.spawn(spawnMeta(0x50000401, 10, 10, 0));
  if (!inst || inst.parts.length !== 17) return { bad: `spawn failed (parts ${inst?.parts?.length})` };
  await em.setMotion(inst.guid, WALK, 0x3d);
  for (let i = 0; i < 4; i += 1) em.tick(0.016);
  // A settled ragdoll with no swings: applyRagdoll moves every part by POSITION only (as E's).
  const ragdoll = () => ({
    sim: { done: true, n: 17, pos: Float64Array.from({ length: 51 }, (_, i) => 0.05 * i - 0.5) },
    parentIndex: new Int32Array(17).fill(-1), boneChild: new Int32Array(17).fill(-1), restDir: new Array(17).fill(null),
    q0: [], swing: [], swingSet: new Uint8Array(17), swingOut: new Float64Array(4), swingFrozen: true, reported: true,
  });
  const parts = inst.parts;
  const wmGet = WeakMap.prototype.get;
  let lookups = 0;
  WeakMap.prototype.get = function (k) {
    if (k === parts) lookups += 1;
    return wmGet.call(this, k);
  };
  const run = (skip, withRagdoll, ticks) => {
    const rd = withRagdoll ? ragdoll() : null;
    inst._ragdoll = rd;
    const l0 = lookups;
    let ragdollRan = true;
    for (let i = 0; i < ticks; i += 1) {
      ms._setRigPoseSkipForTest(skip);
      em.tick(0.016);
      ms._setRigPoseSkipForTest(false);
      if (rd) ragdollRan &&= inst._ragdoll === rd && parts.every((g, p) => same(g.position.x, rd.sim.pos[p * 3]) && same(g.position.y, rd.sim.pos[p * 3 + 1]) && same(g.position.z, rd.sim.pos[p * 3 + 2]));
    }
    inst._ragdoll = null;
    return { lookups: lookups - l0, ragdollRan };
  };
  let off, onPlain, on;
  try {
    off = run(false, true, 6);
    onPlain = run(true, false, 6);
    on = run(true, true, 6);
  } finally {
    WeakMap.prototype.get = wmGet;
    ms._setRigPoseSkipForTest(false);
    em.dispose();
  }
  return { bad: null, off, onPlain, on };
}

console.log("=== G: the ragdoll block's announcement runs only under the flag ===");
{
  const g = await runRagdollGate();
  if (g.bad) {
    check("G: spawned a 17-part rig", false, g.bad);
  } else {
    check("G: flag off — the ragdoll block ran every tick and never called invalidateRigPose (0 lookups of the part array)",
      g.off.ragdollRan && g.off.lookups === 0, `ragdoll ran ${g.off.ragdollRan}, lookups ${g.off.lookups} over 6 ticks`);
    check("G: flag on — the same block announces once per tick (lookups with the ragdoll − without = 6)",
      g.on.ragdollRan && g.on.lookups - g.onPlain.lookups === 6, `ragdoll ran ${g.on.ragdollRan}, lookups ${g.on.lookups} vs ${g.onPlain.lookups} without the ragdoll`);
  }
}

// ---------------------------------------------------------------------------
// M — every key field is load-bearing.
// ---------------------------------------------------------------------------
console.log("=== M: one key field dropped → a difference ===");
for (const field of ms.RIG_POSE_SKIP_KEY_FIELDS) {
  ms._setRigPoseSkipKnockoutForTest(field);
  const found = [];
  for (const route of ROUTES.slice(0, 2)) {
    const u = runScript(route);
    if (u.bad) found.push(`U ${route.name}: ${u.bad.slice(u.bad.indexOf(":") + 2, u.bad.indexOf(":") + 70)}`);
  }
  const e = await runEntityAB(ROUTES[1]);
  if (e.bad) found.push(`E: ${e.bad.slice(0, 60)}`);
  ms._setRigPoseSkipKnockoutForTest(null);
  check(`M: without \`${field}\` the A/B fails`, found.length > 0, found[0] ?? "no difference found");
  if (field === "announced") {
    check("M: without `announced` the ENTITY run fails (the tick's ragdoll announcement is wired)", !!e.bad, e.bad ? e.bad.slice(0, 80) : "no difference");
  }
  if (field === "route") {
    // the forced fallback alone (no ?rustRig switch): F's A/B must fail for every fault
    const missed = [];
    for (const kind of FAULTS) {
      ms._setRigPoseSkipKnockoutForTest(field);
      const fr = runFallback(ROUTES[1], kind);
      ms._setRigPoseSkipKnockoutForTest(null);
      if (!fr.bad) missed.push(kind);
    }
    check("M: without `route` the forced fallback at the same key (F) fails for every fault", missed.length === 0, missed.length ? `no difference: ${missed.join(", ")}` : "");
  }
}
ms._setRigPoseSkipKnockoutForTest(null);

// ---------------------------------------------------------------------------
// D — rigMeshAlias is deleted.
// ---------------------------------------------------------------------------
console.log("=== D: rigMeshAlias deleted ===");
{
  const gone = ["rigMeshAliasEnabled", "installRigMeshAlias", "rigMeshAliasStats", "rigMeshAliased", "__setRigMeshAliasForTest"].filter((k) => k in SETUP_RIG);
  check("D: setup_rig.js exports none of the rigMeshAlias API", gone.length === 0, gone.join(", "));
  const src = readFileSync(join(app, "scene3d", "entities.js"), "utf8") + readFileSync(join(app, "scene3d", "setup_rig.js"), "utf8");
  check("D: entities.js / setup_rig.js no longer read the flag or install the walk", !/rigMeshAlias|installRigMeshAlias|__rma/.test(src));
  // The flag forced on through the scene-core reader (and, on a tree that still has the
  // module's own memo, that memo re-read): a spawned rig's parts must still walk as three's.
  core.__setRustFlagForTest("rigMeshAlias", true);
  if (typeof SETUP_RIG.__setRigMeshAliasForTest === "function") SETUP_RIG.__setRigMeshAliasForTest(undefined);
  const { EntityManager: EM } = await import("../scene3d/entities.js");
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  scene.add(group);
  const em = new EM({ entitiesGroup: group, materialCache: null }, entityHarness());
  const inst = await em.spawn(spawnMeta(0x50000301, 1, 1, 0));
  core.__setRustFlagForTest("rigMeshAlias", undefined);
  const own = inst ? inst.parts.filter((p) => Object.prototype.hasOwnProperty.call(p, "updateMatrixWorld")).length : -1;
  check("D: with rigMeshAlias forced on, a spawned rig's parts walk as three's (no own updateMatrixWorld)", own === 0, `${own} parts with an own walk`);
  em.dispose();
}

console.log("===========================================================");
console.log(`Result: ${passed} passed, ${failed} failed`);
console.log("===========================================================");
if (!compiled) console.log(`rig pose skip: compiled route SKIP — ${compiledSkip}`);
process.exit(failed > 0 ? 1 : 0);
