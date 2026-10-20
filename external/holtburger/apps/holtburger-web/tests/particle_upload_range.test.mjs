// tests/particle_upload_range.test.mjs
//
// `?particleUploadRange` (2026-10-20, improvement hunt main-thread-3 /
// gl-driver-4 / entities-fx-4; DEFAULT ON, `=off` escape). Both particle
// bucket finalize paths (SharedAlphaBuckets.finalize, _finalizeInstBuckets)
// used to flag instanceMatrix/instanceColor.needsUpdate with no update range,
// so three r184 WebGLAttributes.updateBuffer sent `bufferSubData(0, array)` —
// the bucket's whole CAPACITY (≥ 256 slots × 76 B) every frame, plus one more
// full matrix upload when a bucket parked to count 0. ON uploads [0, n) only,
// skips the park upload, and marks fresh bucket buffers DynamicDraw.
//
// The GPU side is three's REAL WebGLObjects + WebGLAttributes (node_modules/
// three/src, r184) over a fake gl that keeps a byte mirror of every buffer and
// counts the bytes each bufferData / bufferSubData moves. A "frame" calls
// objects.update(mesh) for every particle InstancedMesh in the scene — what
// WebGLRenderer.projectObject does for each visible object, count 0 included.
//
//   U1  two managers (additive buckets + one SHARED alpha bucket), mid-run
//       burst that grows a bucket mid-tick, a bucket that parks dark and
//       revives — ON and OFF arms, deterministic clock + RNG:
//       - the instance data every draw reads (GPU mirror [0, count)) equals the
//         CPU arrays every frame, in both arms, and is byte-identical ACROSS the
//         arms (counts and bytes) — the pixel-identity claim;
//       - ON moves exactly Σ count × 76 B of bufferSubData per frame, OFF
//         exactly Σ capacity × 76 B (+ capacity × 64 on a park frame) — the bug
//         trigger and the fix;
//       - a park frame uploads 0 B ON;
//       - a grown bucket's fresh buffers get ONE full bufferData of the whole
//         array (three's createBuffer), and the old buffers are deleted;
//       - fresh bucket buffers are DYNAMIC_DRAW ON, STATIC_DRAW OFF;
//       - after the frame's finalizes the shared bucket carries exactly one
//         range [0, n × itemSize) (several finalizes per frame do not stack);
//       - a glow twin sharing the attributes (fx_glow_effect.js _twin) adds no
//         upload.
//   U2  `?particleFx` buckets (own colour layout, fx shader): ON still mirrors
//       [0, count) exactly with Σ count × 76 B per frame.
//   U3  flag reader: absent / unrelated / on → ON; off/0/false/no (any case,
//       padded) → OFF; memoised until the setter clears it.
//
// Fails on the pre-change code: `setParticleUploadRangeFlag` does not exist,
// and the ON byte counts are the capacity, not the drawn count.
//
// Run: node tests/particle_upload_range.test.mjs

import * as THREE from "three";
import { WebGLAttributes } from "three/src/renderers/webgl/WebGLAttributes.js";
import { WebGLObjects } from "three/src/renderers/webgl/WebGLObjects.js";

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}

globalThis.location = { search: "" };
globalThis.window = { location: globalThis.location };
const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 10000);
cam.position.set(0, 0, 0);
cam.updateMatrixWorld(true);
window.liveScene3d = { cameraSwitcher: { activeCamera: cam }, camera: cam };

const { setCurrentTime, setRng } = await import("../scene3d/particles/time_rng.js");
const FX = await import("../scene3d/particles/particle_fx.js");
const PM = await import("../scene3d/particles/particle_manager.js");
const {
  ParticleManager,
  sharedAlphaBuckets,
  setParticleSharedAlphaFlag,
  __setSharedAlphaFrameSource,
  particleUploadRangeEnabled,
  setParticleUploadRangeFlag,
} = PM;

const GL_STATIC_DRAW = 0x88e4, GL_DYNAMIC_DRAW = 0x88e8, GL_ARRAY_BUFFER = 0x8892;
check("precondition: three's usage constants are the GL enums", THREE.StaticDrawUsage === GL_STATIC_DRAW
  && THREE.DynamicDrawUsage === GL_DYNAMIC_DRAW);

// ── fake gl: byte mirror + per-frame byte counters per buffer ─────────────────
function makeGpu() {
  const live = new Set();
  const bound = new Map();
  const totals = { sub: 0, data: 0, subCalls: 0, dataCalls: 0, deleted: 0 };
  let nextId = 1;
  const gl = {
    ARRAY_BUFFER: GL_ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER: 0x8893,
    FLOAT: 0x1406, HALF_FLOAT: 0x140b, UNSIGNED_SHORT: 0x1403, SHORT: 0x1402,
    UNSIGNED_INT: 0x1405, INT: 0x1404, BYTE: 0x1400, UNSIGNED_BYTE: 0x1401,
    createBuffer() { const b = { id: nextId++, mirror: null, usage: 0, frameSub: 0, frameData: 0, deleted: false }; live.add(b); return b; },
    bindBuffer(target, b) { bound.set(target, b); },
    bufferData(target, array, usage) {
      const b = bound.get(target);
      b.mirror = new Uint8Array(array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength));
      b.usage = usage;
      b.frameData += array.byteLength;
      totals.data += array.byteLength; totals.dataCalls += 1;
    },
    bufferSubData(target, dstByteOffset, src, srcOffset = 0, length = 0) {
      const b = bound.get(target);
      const bpe = src.BYTES_PER_ELEMENT || 1;
      const n = length || (src.length - srcOffset);
      const bytes = new Uint8Array(src.buffer, src.byteOffset + srcOffset * bpe, n * bpe);
      if (!b || !b.mirror || dstByteOffset + bytes.length > b.mirror.length) throw new Error("fake gl: bufferSubData overflow");
      b.mirror.set(bytes, dstByteOffset);
      b.frameSub += bytes.length;
      totals.sub += bytes.length; totals.subCalls += 1;
    },
    deleteBuffer(b) { b.deleted = true; live.delete(b); totals.deleted += 1; },
  };
  const attributes = new WebGLAttributes(gl);
  const info = { render: { frame: 0 } };
  // geometries/bindingStates stubs: only the instance attributes matter here.
  const geometries = { get: (_o, g) => g, update() {} };
  const bindingStates = { releaseStatesOfObject() {} };
  const objects = new WebGLObjects(gl, geometries, attributes, bindingStates, info);
  return {
    gl, attributes, objects, info, totals, live,
    beginFrame() { info.render.frame += 1; for (const b of live) { b.frameSub = 0; b.frameData = 0; } },
    buf(attr) { const d = attributes.get(attr); return d ? d.buffer : null; },
  };
}

const bytesOf = (attr, nItems) => new Uint8Array(attr.array.buffer, attr.array.byteOffset, nItems * attr.itemSize * 4);
const sameBytes = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

// ── particle scene fixture (as particle_slot_carrier.test.mjs) ────────────────
let t = 1000;
setCurrentTime(() => t);
let seed = 1;
const lcg = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
setRng(lcg);
let frameNo = 0;
__setSharedAlphaFrameSource(() => frameNo);
setParticleSharedAlphaFlag(true);

const tex = new THREE.DataTexture(new Uint8Array(4 * 4 * 4).fill(255), 4, 4);
const GFX_ADD = 0x0100c001, GFX_ALPHA = 0x0100c002, GFX_ADD_B = 0x0100c003;
function makeBases() {
  const add = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  add.blending = THREE.AdditiveBlending;
  add.userData = { __cacheOwned: true, surfaceTypeFlags: 0x10000 };
  const alpha = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
  alpha.userData = { __cacheOwned: true, surfaceTypeFlags: 0x100 };
  return new Map([[GFX_ADD, add], [GFX_ADD_B, add], [GFX_ALPHA, alpha]]);
}
const quad = new THREE.PlaneGeometry(1, 1);
const info = (hw, over = {}) => ({
  id: 0x3200fff0 + (hw & 0xf), emitterType: 1, particleType: 2, gfxObjId: 0, hwGfxObjId: hw,
  birthrate: 0.03, maxParticles: 16, initialParticles: 3, totalParticles: 0, totalSeconds: 1000,
  lifespan: 0.45, lifespanRand: 0.2, offsetDirX: 0, offsetDirY: 0, offsetDirZ: 1,
  minOffset: 0, maxOffset: 0.5, aX: 0.3, aY: 1.2, aZ: 0.1, minA: 0.5, maxA: 1.5,
  bX: 0, bY: 0, bZ: 0, cX: 0, cY: 0, cZ: 0, scaleRand: 0.2, startScale: 0.5, finalScale: 1.5,
  transRand: 0.1, startTrans: 0.1, finalTrans: 0.9, isParentLocal: false, billboard: false,
  ...over,
});
// A long-lived burst: 100 particles at t=0, none dying inside the run.
const burst = (hw) => info(hw, { maxParticles: 100, initialParticles: 100, lifespan: 60, lifespanRand: 0, birthrate: 1000 });
const flush = () => new Promise((r) => setImmediate(r));

function clearShared() {
  for (const b of sharedAlphaBuckets.buckets.values()) {
    try { b.im.parent?.remove(b.im); } catch (_) {}
    try { b.im.dispose(); } catch (_) {}
  }
  sharedAlphaBuckets.buckets.clear();
}

async function buildWorld(bases) {
  const world = new THREE.Group();
  const groupA = new THREE.Group(), groupB = new THREE.Group();
  world.add(groupA, groupB);
  const anchorA = new THREE.Object3D(); anchorA.position.set(0, 0, -10); groupA.add(anchorA);
  const anchorB = new THREE.Object3D(); anchorB.position.set(1, 0, -12); groupB.add(anchorB);
  world.updateMatrixWorld(true);
  const mk = (scene) => new ParticleManager({
    scene, instancing: true,
    geometryFactory: () => quad,
    materialFactory: (hw) => bases.get(hw >>> 0),
  });
  const A = mk(groupA), B = mk(groupB);
  const ids = {};
  ids.aAdd = await A.addEmitter({ emitterInfo: info(GFX_ADD), parent: anchorA });
  ids.aAlpha = await A.addEmitter({ emitterInfo: info(GFX_ALPHA, { billboard: true }), parent: anchorA });
  ids.bAlpha = await B.addEmitter({ emitterInfo: info(GFX_ALPHA), parent: anchorB });
  ids.bAdd = await B.addEmitter({ emitterInfo: info(GFX_ADD_B), parent: anchorB });
  return { world, groupA, groupB, anchorA, anchorB, A, B, ids };
}

const TICKS = 36;
const BURST_AT = 10, PARK_AT = 20, REVIVE_AT = 26;

/** One arm: TICKS frames of (A.tick, B.tick, render). Returns per-frame records + aggregate facts. */
async function runArm(on, { fx = false } = {}) {
  setParticleUploadRangeFlag(on);
  FX.setParticleFxFlag(fx);
  clearShared();
  t = 1000; seed = 1; frameNo = 0;
  const bases = makeBases();
  const w = await buildWorld(bases);
  const gpu = makeGpu();
  const prevCount = new WeakMap();
  const facts = {
    frames: [], perFrameBytesOk: true, perFrameBytesLog: [], mirrorOk: true, mirrorLog: [],
    parkFrames: 0, parkBytes: [], grows: 0, growLog: [], usages: new Set(), sharedRangeOk: true, sharedRangeLog: [],
    sharedSeen: 0, twinExtra: 0, twinChecks: 0, smallBucketFrames: 0, maxCap: 0, revived: false,
  };
  const twin = new THREE.InstancedMesh(quad, new THREE.MeshBasicMaterial(), 1);
  const knownBuffers = new WeakSet();
  for (let tick = 0; tick < TICKS; tick += 1) {
    if (tick === BURST_AT) {
      // Three 100-particle bursts of A's additive gfx: the bucket outgrows 256
      // MID-TICK, after A's first emitter already appended its instances.
      for (let k = 0; k < 3; k++) await w.A.addEmitter({ emitterInfo: burst(GFX_ADD), parent: w.anchorA });
    }
    if (tick === PARK_AT) w.B.destroyParticleEmitter(w.ids.bAdd); // B's additive bucket parks dark
    if (tick === REVIVE_AT) w.ids.bAdd2 = await w.B.addEmitter({ emitterInfo: info(GFX_ADD_B), parent: w.anchorB });
    t += 0.05;
    frameNo += 1;
    w.A.tick();
    w.B.tick();
    // After every finalize of the frame: the shared bucket holds ONE range.
    for (const b of sharedAlphaBuckets.buckets.values()) {
      const im = b.im;
      if (im.count === 0) continue;
      facts.sharedSeen += 1;
      const m = im.instanceMatrix.updateRanges, c = im.instanceColor.updateRanges;
      const ok = on
        ? (m.length === 1 && m[0].start === 0 && m[0].count === im.count * 16
          && c.length === 1 && c[0].start === 0 && c[0].count === im.count * 3)
        : (m.length === 0 && c.length === 0);
      if (!ok && facts.sharedRangeLog.length < 3) facts.sharedRangeLog.push(`tick ${tick}: ${JSON.stringify(m)} / ${JSON.stringify(c)} n=${im.count}`);
      facts.sharedRangeOk &&= ok;
    }
    // ── the frame ──
    gpu.beginFrame();
    const drawn = [];
    w.world.traverse((o) => { if (o.isInstancedMesh && o.userData?.isParticleInstanced) drawn.push(o); });
    for (const o of drawn) gpu.objects.update(o);
    // A glow twin sharing the first live bucket's attributes: no extra upload.
    const live = drawn.find((o) => o.count > 0);
    if (live && on) {
      twin.instanceMatrix = live.instanceMatrix; twin.instanceColor = live.instanceColor; twin.count = live.count;
      const before = gpu.totals.sub + gpu.totals.data;
      gpu.objects.update(twin);
      facts.twinExtra += gpu.totals.sub + gpu.totals.data - before;
      facts.twinChecks += 1;
    }
    let expected = 0, actual = 0;
    const rec = {};
    for (const o of drawn) {
      const key = `${o.parent === w.groupA ? "A" : "B"}:${o.name}`;
      const mA = o.instanceMatrix, cA = o.instanceColor;
      const mb = gpu.buf(mA), cb = gpu.buf(cA);
      const cap = mA.count;
      facts.maxCap = Math.max(facts.maxCap, cap);
      const fresh = !knownBuffers.has(mb);
      if (fresh) {
        knownBuffers.add(mb);
        facts.usages.add(mb.usage); facts.usages.add(cb.usage);
        // A fresh buffer: ONE full bufferData of the whole array, no sub-upload.
        const fullOk = mb.frameData === mA.array.byteLength && cb.frameData === cA.array.byteLength
          && mb.frameSub === 0 && cb.frameSub === 0;
        if (cap > 256) {
          facts.grows += 1;
          facts.growLog.push(`${key} cap ${cap} n ${o.count} data ${mb.frameData}+${cb.frameData} full=${fullOk}`);
        }
        if (!fullOk) { facts.perFrameBytesOk = false; facts.perFrameBytesLog.push(`tick ${tick} ${key}: fresh buffer not one full bufferData`); }
      } else {
        const was = prevCount.get(o) ?? 0;
        let exp = 0;
        if (o.count > 0) exp = on ? o.count * 76 : cap * 76;
        else if (was > 0) { exp = on ? 0 : cap * 64; facts.parkFrames += 1; facts.parkBytes.push(mb.frameSub + cb.frameSub); }
        expected += exp;
        actual += mb.frameSub + cb.frameSub;
        if (o.count > 0 && o.count <= 16 && cap === 256) facts.smallBucketFrames += 1;
      }
      prevCount.set(o, o.count);
      // What the draw reads: GPU [0, count) == CPU [0, count).
      if (o.count > 0) {
        const okM = sameBytes(mb.mirror.subarray(0, o.count * 64), bytesOf(mA, o.count));
        const okC = sameBytes(cb.mirror.subarray(0, o.count * 12), bytesOf(cA, o.count));
        if (!(okM && okC)) { facts.mirrorOk = false; if (facts.mirrorLog.length < 3) facts.mirrorLog.push(`tick ${tick} ${key} m=${okM} c=${okC}`); }
        rec[key] = { count: o.count, m: Array.from(mb.mirror.subarray(0, o.count * 64)), c: Array.from(cb.mirror.subarray(0, o.count * 12)) };
      } else {
        rec[key] = { count: 0 };
      }
      if (tick >= REVIVE_AT && o.parent === w.groupB && o.name.includes(GFX_ADD_B.toString(16)) && o.count > 0) facts.revived = true;
    }
    if (expected !== actual) {
      facts.perFrameBytesOk = false;
      if (facts.perFrameBytesLog.length < 3) facts.perFrameBytesLog.push(`tick ${tick}: expected ${expected} B, moved ${actual} B`);
    }
    facts.frames.push({ rec, bytes: actual });
    await flush(); // lazy slot growth settles the same way in both arms
  }
  facts.deleted = gpu.totals.deleted;
  facts.totalSub = gpu.totals.sub;
  return facts;
}

// ---------------------------------------------------------------------------
console.log("-- U1 ON vs OFF: bytes moved, identity of what draws read ---------------");
const off = await runArm(false);
const on = await runArm(true);
{
  check("precondition: a bucket grew mid-run in both arms (fresh > 256-slot buffers)",
    on.grows >= 1 && off.grows >= 1 && on.maxCap >= 512, `ON ${on.growLog.join("; ")} | OFF grows ${off.grows}`);
  check("precondition: the shared alpha bucket published (both managers feed it)", on.sharedSeen >= TICKS - 2, `${on.sharedSeen}`);
  check("precondition: a bucket parked dark (count n → 0) in both arms", on.parkFrames >= 1 && off.parkFrames >= 1,
    `ON ${on.parkFrames}, OFF ${off.parkFrames}`);
  check("precondition: the parked bucket revived", on.revived && off.revived);
  check("precondition: small buckets (n ≤ 16 in 256 slots) drew on many frames", on.smallBucketFrames > 40,
    `${on.smallBucketFrames}`);

  check("OFF (the bug): every frame moved exactly Σ capacity × 76 B (+ capacity × 64 per park)", off.perFrameBytesOk,
    off.perFrameBytesLog.join("; "));
  check("ON: every frame moved exactly Σ count × 76 B — nothing past the drawn count", on.perFrameBytesOk,
    on.perFrameBytesLog.join("; "));
  check("ON: a park frame uploads 0 B (OFF: capacity × 64)", on.parkBytes.every((b) => b === 0)
    && off.parkBytes.every((b) => b === 256 * 64), `ON ${on.parkBytes} | OFF ${off.parkBytes}`);
  const sumOn = on.frames.reduce((s, f) => s + f.bytes, 0), sumOff = off.frames.reduce((s, f) => s + f.bytes, 0);
  check("ON moves far fewer bytes over the run", sumOn * 3 < sumOff, `ON ${sumOn} B vs OFF ${sumOff} B`);

  check("OFF: GPU [0, count) equals the CPU arrays every frame", off.mirrorOk, off.mirrorLog.join("; "));
  check("ON: GPU [0, count) equals the CPU arrays every frame (incl. after growth, park, revive)", on.mirrorOk,
    on.mirrorLog.join("; "));
  let mism = [];
  for (let i = 0; i < TICKS; i++) {
    const a = off.frames[i].rec, b = on.frames[i].rec;
    const ka = Object.keys(a).sort().join(","), kb = Object.keys(b).sort().join(",");
    if (ka !== kb) { mism.push(`tick ${i}: buckets ${ka} vs ${kb}`); continue; }
    for (const k of Object.keys(a)) {
      const x = a[k], y = b[k];
      if (x.count !== y.count) { mism.push(`tick ${i} ${k}: count ${x.count} vs ${y.count}`); continue; }
      if (x.count > 0 && !(sameBytes(x.m, y.m) && sameBytes(x.c, y.c))) mism.push(`tick ${i} ${k}: instance bytes`);
    }
  }
  check("pixel-identity: what every draw reads (count + GPU [0, count)) is byte-identical across the arms, every frame",
    mism.length === 0, mism.slice(0, 4).join("; "));

  check("ON: fresh bucket buffers are DYNAMIC_DRAW", on.usages.size === 1 && on.usages.has(GL_DYNAMIC_DRAW),
    [...on.usages].map((u) => u.toString(16)).join(","));
  check("OFF: fresh bucket buffers stay STATIC_DRAW (escape restores the old call stream)",
    off.usages.size === 1 && off.usages.has(GL_STATIC_DRAW), [...off.usages].map((u) => u.toString(16)).join(","));
  check("the grown bucket's old buffers were deleted (dispose → attributes.remove)", on.deleted >= 2 && off.deleted >= 2,
    `ON ${on.deleted}, OFF ${off.deleted}`);
  check("ON: after the frame's finalizes the shared bucket holds exactly [0, n × itemSize) — no stacking",
    on.sharedRangeOk, on.sharedRangeLog.join("; "));
  check("OFF: no update ranges at all", off.sharedRangeOk, off.sharedRangeLog.join("; "));
  check("ON: a glow twin sharing the attributes adds no upload", on.twinChecks > 0 && on.twinExtra === 0,
    `${on.twinChecks} checks, ${on.twinExtra} extra B`);
}

// ---------------------------------------------------------------------------
console.log("-- U2 ?particleFx buckets ---------------------------------------------");
{
  const fx = await runArm(true, { fx: true });
  check("ON + particleFx: GPU [0, count) equals the CPU arrays every frame", fx.mirrorOk, fx.mirrorLog.join("; "));
  check("ON + particleFx: every frame moved exactly Σ count × 76 B", fx.perFrameBytesOk, fx.perFrameBytesLog.join("; "));
  check("ON + particleFx: a park frame uploads 0 B", fx.parkFrames >= 1 && fx.parkBytes.every((b) => b === 0),
    `${fx.parkBytes}`);
}
FX.setParticleFxFlag(false);
clearShared();

// ---------------------------------------------------------------------------
console.log("-- U3 flag reader ------------------------------------------------------");
{
  const savedLocation = globalThis.location;
  const readWith = (search) => {
    if (search === undefined) delete globalThis.location;
    else globalThis.location = { search };
    setParticleUploadRangeFlag(null);
    return particleUploadRangeEnabled();
  };
  check("bare page reads ON (default)", readWith("") === true);
  check("an unrelated param reads ON", readWith("?foo=1") === true);
  check("no `location` (node) falls back to ON", readWith(undefined) === true);
  for (const s of ["off", "0", "false", "no", "OFF", "No", "%20off%20"]) {
    check(`=${s} reads OFF (escape)`, readWith(`?particleUploadRange=${s}`) === false);
  }
  for (const s of ["on", "1", "true", "yes", "garbage", ""]) {
    check(`=${s} reads ON`, readWith(`?particleUploadRange=${s}`) === true);
  }
  check("memoised until the setter clears it", (() => {
    readWith("?particleUploadRange=off");
    globalThis.location = { search: "" };
    return particleUploadRangeEnabled() === false;
  })());
  globalThis.location = savedLocation;
  setParticleUploadRangeFlag(null);
}

__setSharedAlphaFrameSource(null);
console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
