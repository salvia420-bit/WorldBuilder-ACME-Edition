// tests/helpers/gpu_particles_flag_off_digest.mjs — the flag-off identity
// digest for `?gpuParticles` (R3-7a). Runs the tools/rust_parity/gen_particles.mjs
// scenarios on the REAL particle modules with the flag absent and hashes, per
// tick, everything the flag-off contract pins:
//   - every bucket (own + shared): key, count, capacity, name, layer mask,
//     renderOrder, frustumCulled, castShadow, the instance matrix + colour bytes
//     drawn, both attributes' version (needsUpdate count), update ranges and
//     usage, the material's program key, defines and onBeforeCompile OUTPUT on
//     three's ShaderLib.basic (vertex + fragment text), its uniform names;
//   - every kids layer's attribute bytes;
//   - the RNG draws consumed and the FX seed stream state;
//   - per-tick CALL COUNTS of the per-particle and per-bucket JS work
//     (Particle.update, Object3D.updateMatrix, Matrix4.compose,
//     InstancedMesh.setMatrixAt / setColorAt, BufferAttribute.addUpdateRange,
//     ParticleEmitter._resolveAnchorFrame, the FX seed / velocity helpers);
//   - the window keys after the scenario.
// It imports nothing the pre-change tree lacks, so the same file runs on a
// scratch copy of HEAD (the golden) and on the post-change tree (the check).
//
// Golden: tests/fixtures/gpu_particles_flag_off.golden.json, generated ON THE
// PRE-CHANGE TREE with
//   node tests/gpu_particles.test.mjs --write-flag-off-golden <out.json>
// (run from a scratch copy of HEAD with this helper + the suite copied in).

import * as THREE from "three";

const FNV0 = 0x811c9dc5;
function fnvBytes(h, u8) {
  for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}
function fnvStr(h, s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h ^= c & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    h ^= c >>> 8; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
const hex = (h) => (h >>> 0).toString(16).padStart(8, "0");
function hashF32(arr) {
  const a = arr instanceof Float32Array ? arr : Float32Array.from(arr);
  return hex(fnvBytes(FNV0, new Uint8Array(a.buffer, a.byteOffset, a.byteLength)));
}

/** The material's compiled-program inputs (key, defines, obc output on ShaderLib.basic). */
export function materialSignature(mat) {
  if (!mat) return "-";
  const lib = THREE.ShaderLib.basic;
  const shader = { vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, uniforms: {} };
  let obcErr = "";
  try { mat.onBeforeCompile(shader, null); } catch (e) { obcErr = String(e && e.message || e); }
  let key = "";
  try { key = String(mat.customProgramCacheKey()); } catch (e) { key = "ERR"; }
  const parts = [
    mat.type, key, JSON.stringify(mat.defines || {}), mat.blending, mat.transparent ? 1 : 0, mat.depthWrite ? 1 : 0,
    mat.alphaTest, mat.vertexColors ? 1 : 0, mat.fog ? 1 : 0, mat.forceSinglePass ? 1 : 0, mat.opacity, mat.side,
    Object.keys(shader.uniforms).sort().join(","), obcErr,
    hex(fnvStr(FNV0, shader.vertexShader)), hex(fnvStr(FNV0, shader.fragmentShader)),
  ];
  return parts.join("|");
}

function attrSig(a) {
  if (!a) return "-";
  return [a.count, a.itemSize, a.version, a.usage, JSON.stringify(a.updateRanges || [])].join(",");
}

/** Per-tick spies (prototype wraps; `restore()` puts them back). */
export function installCallSpies(M) {
  const counts = Object.create(null);
  const wraps = [];
  const wrap = (proto, name, label) => {
    const orig = proto[name];
    if (typeof orig !== "function") return;
    counts[label] = 0;
    proto[name] = function (...args) { counts[label]++; return orig.apply(this, args); };
    wraps.push([proto, name, orig]);
  };
  wrap(M.particle.Particle.prototype, "update", "Particle.update");
  wrap(M.particle.Particle.prototype, "init", "Particle.init");
  wrap(THREE.Object3D.prototype, "updateMatrix", "Object3D.updateMatrix");
  wrap(THREE.Matrix4.prototype, "compose", "Matrix4.compose");
  wrap(THREE.Matrix4.prototype, "makeBasis", "Matrix4.makeBasis");
  wrap(THREE.Quaternion.prototype, "setFromRotationMatrix", "Quaternion.setFromRotationMatrix");
  wrap(THREE.Quaternion.prototype, "setFromUnitVectors", "Quaternion.setFromUnitVectors");
  wrap(THREE.InstancedMesh.prototype, "setMatrixAt", "InstancedMesh.setMatrixAt");
  wrap(THREE.InstancedMesh.prototype, "setColorAt", "InstancedMesh.setColorAt");
  wrap(THREE.BufferAttribute.prototype, "addUpdateRange", "BufferAttribute.addUpdateRange");
  wrap(THREE.BufferAttribute.prototype, "clearUpdateRanges", "BufferAttribute.clearUpdateRanges");
  wrap(M.pe.ParticleEmitter.prototype, "_resolveAnchorFrame", "ParticleEmitter._resolveAnchorFrame");
  wrap(M.pe.ParticleEmitter.prototype, "emitParticle", "ParticleEmitter.emitParticle");
  wrap(M.pe.ParticleEmitter.prototype, "killParticle", "ParticleEmitter.killParticle");
  wrap(M.pm.ParticleManager.prototype, "_appendInstances", "ParticleManager._appendInstances");
  wrap(M.pm.ParticleManager.prototype, "_makeBucketIm", "ParticleManager._makeBucketIm");
  return {
    counts,
    take() { const o = { ...counts }; for (const k of Object.keys(counts)) counts[k] = 0; return o; },
    restore() { for (const [p, n, o] of wraps.reverse()) p[n] = o; },
  };
}

/** One tick's digest line (buckets, kids, counters). */
export function tickDigest(M, h, snap, calls, extra = "") {
  let s = "";
  const bucket = (key, b, shared) => {
    const im = b.im;
    const n = im.count | 0;
    s += [
      shared ? "S" : "O", key, n, im.instanceMatrix.count, im.name, im.layers.mask, im.renderOrder,
      im.frustumCulled ? 1 : 0, im.castShadow ? 1 : 0, im.visible ? 1 : 0,
      hashF32(im.instanceMatrix.array.subarray(0, n * 16)),
      im.instanceColor ? hashF32(im.instanceColor.array.subarray(0, n * 3)) : "-",
      attrSig(im.instanceMatrix), attrSig(im.instanceColor),
      JSON.stringify(Object.keys(im.userData).sort()),
      materialSignature(im.material),
    ].join(";") + "\n";
  };
  h.mgrs.forEach((mgr, i) => {
    for (const [key, b] of mgr._instBuckets) bucket(`m${i}:${key}`, b, false);
    if (mgr._kids) {
      for (const [layer, l] of mgr._kids.layers) {
        const g = l.mesh.geometry;
        s += `K;m${i}:${layer};${l.n};${l.cap};${hashF32(g.attributes.aKidPos.array.subarray(0, l.n * 4))};` +
          `${hashF32(g.attributes.aKidVel.array.subarray(0, l.n * 4))};${hashF32(g.attributes.aKidRow.array.subarray(0, l.n * 2))}\n`;
      }
    }
  });
  for (const [key, b] of M.pm.sharedAlphaBuckets.buckets) bucket(key, b, true);
  s += "E;" + JSON.stringify(snap.emitters.map(([e, n, t, st, c]) => [e.id, n, t, st, c])) + "\n";
  s += "R;" + JSON.stringify(snap.removed.map((e) => (e ? e.id : null))) + ";" + JSON.stringify(snap.stats) + ";" + snap.cellHidden + ";" + snap.seed + "\n";
  s += "C;" + JSON.stringify(calls) + "\n";
  s += extra;
  return { line: hex(fnvStr(FNV0, s)), text: s };
}

/**
 * Run one scenario flag-off and return { ticks: [hash], rng, windowKeys, final }.
 * `opts.text` keeps the full per-tick text (diagnostics).
 */
export async function scenarioDigest(M, gen, recordRng, name, fn, opts = {}) {
  const recs = [];
  const h = new gen.Harness(M, {
    onManager(mgr, index, hh) {
      const rec = recordRng(0x0c0ffee + 977 * index);
      recs[index] = rec;
      hh.rngs.set(mgr, rec.rng);
    },
  });
  const spies = installCallSpies(M);
  const ticks = [];
  const texts = [];
  const orig = h.tick.bind(h);
  spies.take(); // the scenario's setup calls are not per-frame work
  h.tick = async (dt) => {
    spies.take();
    const snap = await orig(dt);
    const calls = spies.take();
    const rngNow = recs.map((r) => r.values.length).join(",");
    const d = tickDigest(M, h, snap, calls, `G;${rngNow}\n`);
    ticks.push(d.line);
    if (opts.text) texts.push(d.text);
    return snap;
  };
  try {
    await fn(h);
  } finally {
    spies.restore();
    M.time.setRng(null);
  }
  const windowKeys = Object.keys(globalThis.window).sort();
  return { scenario: name, ticks, rng: recs.map((r) => r.values.length), windowKeys, ...(opts.text ? { texts } : {}) };
}
