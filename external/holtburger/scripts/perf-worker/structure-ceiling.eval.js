// scripts/perf-worker/structure-ceiling.eval.js — the R3-1 STRUCTURE-CEILING PROBE (round 3, rule R8).
// Page-side; written 2026-10-30 (lane H); never run on the laptop by an agent, never ships.
//
// WHY. Plan docs/2026-10-29-round3-gpu-driven.md §3 R3-1 / §5 R8: before L-sized batching work (R3-4
// entity batch, R3-5 interior batch) the 1070 must show that collapsing today's plain-mesh draws
// actually cuts main-thread world-render ms AND CrGpuMain WEBGL ms by >= 40%. "Draws removed x µs per
// draw" has mispredicted ms three times (plan §1.3 / §6), so this measures it on our own content.
//
// WHAT. At the bench pose, with the app's loop idle (boot with ?renderOnDemand=1&netDrainHz=30), this
// script runs its OWN rAF loop in four variants, `secPerVariant` s each, rotated per round (ABAB):
//   V0  today's world scene, one direct renderer.render(scene, camera) per frame, no composer;
//   V1  V0 with every visible PLAIN mesh replaced by one merged mesh per (existing material, layer
//       mask, attribute set) — world-space vertices, so the merged mesh draws with identity matrices;
//   V2  V0 with the same population merged per BLEND CLASS (opaque / alpha-test / translucent /
//       additive x side) under one flat MeshBasicMaterial per class;
//   V3  V0 plus the full composer (liveScene3d.atmospherePipeline.render, cloud overlay around it).
// Per frame: main render ms (performance.now around the render call(s)), GPU ms (one
// EXT_disjoint_timer_query_webgl2 TIME_ELAPSED around the frame's submission, refused under ?vfxGauge).
// CrGpuMain WEBGL ms needs the browser-wide trace the driver takes around this script
// (`hbanatomy.mjs --attach --eval structure-ceiling.eval.js --trace OUT`): every measured window
// starts with performance.mark `hbSC:<variant>:r<round>` and ends with `hbSC:gap`, and
// `hbreport.py trace-split OUT --marks hbSC:` + `hbreport.py ceiling` read it.
// LIMITATION (plan): merging cannot cover BatchedMesh, InstancedMesh, grass, row-driven or skinned
// content, so V1 / V2 cover the plain-mesh populations only — entity parts, cell props, fused cells,
// occlusion proxies — which is exactly what R3-4 / R3-5 target. Visual correctness of V1 / V2 is
// irrelevant (per-object uniforms are lost); this is a structure-cost probe.
// RESTORES EVERYTHING: merged meshes removed and disposed, original visibility, camera layer mask,
// render target and autoClear; then one __renderOnce() so the page shows its normal frame.
//
// FORMAT: the BODY of an async function (hbsess.mjs eval / hbanatomy.mjs --attach --eval wrap it).
// Options: window.__hbEvalOpts (hbanatomy --opts JSON) or window.__structureCeilingOpts:
//   {secPerVariant: 10, rounds: 2, warmSec: 2, variants: ["V0","V1","V2","V3"], mask: 3, force: false,
//    selfTest: false}
// `selfTest: true` touches nothing: it runs the merge / classification helpers on synthetic data and
// returns the results (the node suite reads them; tests/hb_v2.test.mjs).

const W = typeof window !== "undefined" ? window : globalThis;
const OPTS = Object.assign({ secPerVariant: 10, rounds: 2, warmSec: 2, variants: ["V0", "V1", "V2", "V3"], mask: 3, force: false, selfTest: false },
  W.__structureCeilingOpts || {}, W.__hbEvalOpts || {});
const SCHEMA = "hb-structure-ceiling-v1";

// ---- pure helpers (selfTest exercises them) ----------------------------------------------------
const ADDITIVE = 2; // THREE.AdditiveBlending
const SIDE = ["front", "back", "double"];
function blendClass(m) {
  if (!m) return "opaque";
  if (m.blending === ADDITIVE) return "additive";
  if (m.transparent === true) return "translucent";
  if ((m.alphaTest || 0) > 0) return "alpha-test";
  return "opaque";
}
/** Why a drawn (object, material) cannot join the merge (null = it can). */
function refusal(o, m, g) {
  if (!o || o.isMesh !== true) return "not a Mesh";
  if (o.isInstancedMesh) return "InstancedMesh";
  if (o.isBatchedMesh) return "BatchedMesh";
  if (o.isSkinnedMesh) return "SkinnedMesh";
  if (!g || g.isBufferGeometry !== true) return "no BufferGeometry";
  if (g.isInstancedBufferGeometry) return "InstancedBufferGeometry";
  const p = g.attributes && g.attributes.position;
  if (!p || p.itemSize !== 3) return "no xyz position";
  if (g.morphAttributes && g.morphAttributes.position && g.morphAttributes.position.length) return "morph targets";
  if (!m) return "no material";
  if (m.isShaderMaterial || m.isRawShaderMaterial) return "ShaderMaterial";
  if (m.isPointsMaterial || m.isLineBasicMaterial || m.isSpriteMaterial) return "points/lines/sprites";
  if (m.wireframe) return "wireframe";
  if (o.children && o.children.some((c) => c && c.visible !== false && (c.isMesh || (c.children && c.children.length)))) return "has visible children";
  return null;
}
/** 3x3 normal matrix (inverse transpose of the upper 3x3 of a column-major 4x4). */
function normalMatrix(e) {
  const a = e[0], b = e[1], c = e[2], d = e[4], f = e[5], g = e[6], h = e[8], i = e[9], j = e[10];
  const A = f * j - g * i, B = -(d * j - g * h), C = d * i - f * h;
  const det = a * A + b * B + c * C;
  if (!det) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const k = 1 / det;
  // (M^-1)^T = cofactor(M) / det, returned column-major: [C00, C10, C20, C01, C11, C21, C02, C12, C22] / det
  return [A * k, B * k, C * k, -(b * j - c * i) * k, (a * j - c * h) * k, -(a * i - b * h) * k, (b * g - c * f) * k, -(a * g - c * d) * k, (a * f - b * d) * k];
}
/** Attribute names (sorted, with item size) a merge bucket is keyed on; position/normal handled. */
function attrSig(g) {
  return Object.keys(g.attributes).sort().map((k) => `${k}:${g.attributes[k].itemSize}`).join(",");
}
/**
 * Merge entries [{geometry, matrix (16, column-major), start, count}] (triangle index ranges) into
 * world-space typed arrays: {attrs: {name: {itemSize, array}}, index: Uint32Array, vertices, triangles}.
 * Every vertex of each source geometry is copied once per entry (indices offset), positions by the
 * matrix, normals by its normal matrix (renormalised), other attributes verbatim (getX..getW, so
 * normalized / interleaved attributes come out as plain floats).
 */
function mergeEntries(entries, onlyPosition) {
  let nv = 0, ni = 0;
  const names = onlyPosition ? ["position"] : Object.keys(entries[0].geometry.attributes).sort();
  for (const e of entries) { nv += e.geometry.attributes.position.count; ni += e.count; }
  const attrs = {};
  for (const n of names) attrs[n] = { itemSize: entries[0].geometry.attributes[n].itemSize, array: new Float32Array(nv * entries[0].geometry.attributes[n].itemSize) };
  const index = new Uint32Array(ni);
  let vb = 0, ib = 0;
  const get = (a, i, c) => (c === 0 ? a.getX(i) : c === 1 ? a.getY(i) : c === 2 ? a.getZ(i) : a.getW(i));
  for (const e of entries) {
    const g = e.geometry, m = e.matrix, cnt = g.attributes.position.count;
    const nm = normalMatrix(m);
    for (const n of names) {
      const src = g.attributes[n], dst = attrs[n].array, s = attrs[n].itemSize;
      for (let v = 0; v < cnt; v++) {
        const o = (vb + v) * s;
        if (n === "position") {
          const x = src.getX(v), y = src.getY(v), z = src.getZ(v);
          dst[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
          dst[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          dst[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        } else if (n === "normal" && s === 3) {
          const x = src.getX(v), y = src.getY(v), z = src.getZ(v);
          let X = nm[0] * x + nm[3] * y + nm[6] * z, Y = nm[1] * x + nm[4] * y + nm[7] * z, Z = nm[2] * x + nm[5] * y + nm[8] * z;
          const l = Math.hypot(X, Y, Z) || 1; X /= l; Y /= l; Z /= l;
          dst[o] = X; dst[o + 1] = Y; dst[o + 2] = Z;
        } else {
          for (let c = 0; c < s; c++) dst[o + c] = get(src, v, c);
        }
      }
    }
    const idx = g.index;
    for (let k = 0; k < e.count; k++) index[ib + k] = vb + (idx ? idx.getX(e.start + k) : e.start + k);
    vb += cnt; ib += e.count;
  }
  return { attrs, index, vertices: nv, triangles: ni / 3 };
}

if (OPTS.selfTest) {
  const attr = (arr, s) => ({ itemSize: s, count: arr.length / s, getX: (i) => arr[i * s], getY: (i) => arr[i * s + 1], getZ: (i) => arr[i * s + 2], getW: (i) => arr[i * s + 3] });
  const geo = { isBufferGeometry: true, attributes: { position: attr([0, 0, 0, 1, 0, 0, 0, 1, 0], 3), normal: attr([0, 0, 1, 0, 0, 1, 0, 0, 1], 3), uv: attr([0, 0, 1, 0, 0, 1], 2) },
    index: { getX: (i) => [0, 1, 2][i] }, morphAttributes: {} };
  // translate (10, 20, 30), scale x by 2 (normal stays +z)
  const M = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1];
  const merged = mergeEntries([{ geometry: geo, matrix: M, start: 0, count: 3 }, { geometry: geo, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], start: 0, count: 3 }]);
  // a 90 deg rotation about y: normal +z -> +x
  const R = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
  const rot = mergeEntries([{ geometry: geo, matrix: R, start: 0, count: 3 }]);
  return {
    schema: SCHEMA, selfTest: true,
    position: Array.from(merged.attrs.position.array), normal: Array.from(merged.attrs.normal.array), uv: Array.from(merged.attrs.uv.array),
    index: Array.from(merged.index), vertices: merged.vertices, triangles: merged.triangles, rotNormal: Array.from(rot.attrs.normal.array.slice(0, 3)).map((x) => +x.toFixed(6)),
    classes: [blendClass({ blending: 1 }), blendClass({ blending: 1, alphaTest: 0.5 }), blendClass({ blending: 1, transparent: true }), blendClass({ blending: 2, transparent: true })],
    refusals: [refusal({ isMesh: true, isInstancedMesh: true }, {}, geo), refusal({ isMesh: true, children: [] }, { isShaderMaterial: true }, geo),
      refusal({ isMesh: true, children: [] }, {}, geo), refusal({ isMesh: true, children: [{ isMesh: true }] }, {}, geo)],
    sig: attrSig(geo),
    nmScale: normalMatrix([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]).map((x) => +x.toFixed(6)),
    nmShear: normalMatrix([1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]).map((x) => +x.toFixed(6)),
  };
}

// ---- the probe ------------------------------------------------------------------------------------
const L = W.liveScene3d;
if (!L || !L.renderer || !L.scene) return { schema: SCHEMA, error: "no liveScene3d (not booted?)" };
const ondemand = new URLSearchParams(location.search).get("renderOnDemand") === "1";
if (!ondemand && !OPTS.force) return { schema: SCHEMA, error: "boot with ?renderOnDemand=1 (the app's own loop would render every frame next to the probe's); opts.force to override" };
const r = L.renderer, scene = L.scene;
const cam = (L.cameraSwitcher && L.cameraSwitcher.activeCamera) || L.camera;
let THREE = null;
try { THREE = await import("three"); } catch (e) { THREE = null; }
const gl = r.getContext();
const gauge = /^(on|1|true|yes)$/i.test(new URLSearchParams(location.search).get("vfxGauge") || "");
const tq = gauge ? null : gl.getExtension("EXT_disjoint_timer_query_webgl2");
const out = { schema: SCHEMA, opts: OPTS, at: new Date().toISOString(), three: THREE ? THREE.REVISION : null, gpuTimer: !!tq, gpuTimerRefused: gauge ? "vfxGauge on" : tq ? null : "EXT_disjoint_timer_query_webgl2 unavailable",
  population: null, V1: null, V2: null, windows: [], restored: null };

const saved = { mask: cam.layers.mask, autoClear: r.autoClear, rt: r.getRenderTarget(), visible: new Map() };
const added = [];
const disposeLater = [];
try {
  cam.layers.mask = OPTS.mask;
  // 1. capture what V0 draws (one direct render with a renderBufferDirect tap)
  const drawn = [];
  const inner = r.renderBufferDirect;
  const hadOwnRbd = Object.prototype.hasOwnProperty.call(r, "renderBufferDirect");
  const tap = function (camera, sc, geometry, material, object, group) { drawn.push([object, material, group, geometry]); return inner.call(this, camera, sc, geometry, material, object, group); };
  r.renderBufferDirect = tap;
  try { r.setRenderTarget(null); r.render(scene, cam); } finally { if (r.renderBufferDirect === tap) { if (hadOwnRbd) r.renderBufferDirect = inner; else delete r.renderBufferDirect; } }
  // 2. population: an object joins only if EVERY entry it drew qualifies
  const reasons = {};
  const byObj = new Map();
  for (const [o, m, g, geo] of drawn) {
    let e = byObj.get(o);
    if (!e) { e = { entries: [], bad: null }; byObj.set(o, e); }
    const why = refusal(o, m, geo);
    if (why && !e.bad) e.bad = why;
    e.entries.push({ m, g, geo });
  }
  const plain = [];
  for (const [o, e] of byObj) {
    if (e.bad) { reasons[e.bad] = (reasons[e.bad] || 0) + e.entries.length; continue; }
    plain.push([o, e.entries]);
  }
  out.population = { drawsV0: drawn.length, objectsV0: byObj.size, plainObjects: plain.length, plainDraws: plain.reduce((a, [, es]) => a + es.length, 0), refused: reasons };
  if (!THREE) throw new Error("could not import three in the page (import map); V1/V2 need it");
  // 3. buckets
  const v1 = new Map(), v2 = new Map();
  for (const [o, es] of plain) {
    o.updateMatrixWorld(false);
    const M = o.matrixWorld.elements;
    for (const { m, g, geo } of es) {
      const idxCount = geo.index ? geo.index.count : geo.attributes.position.count;
      let start = g ? g.start : geo.drawRange.start, count = g ? g.count : geo.drawRange.count;
      if (!Number.isFinite(count) || count === Infinity) count = idxCount - start;
      count = Math.max(0, Math.min(count, idxCount - start));
      count -= count % 3;
      if (count <= 0) continue;
      const mask = o.layers.mask >>> 0;
      const k1 = `${m.uuid}|${mask}|${attrSig(geo)}`;
      let b1 = v1.get(k1); if (!b1) { b1 = { material: m, mask, entries: [] }; v1.set(k1, b1); }
      b1.entries.push({ geometry: geo, matrix: M, start, count });
      const cls = blendClass(m);
      const k2 = `${cls}|${SIDE[m.side] || m.side}|${mask}|${m.depthWrite !== false}`;
      let b2 = v2.get(k2); if (!b2) { b2 = { cls, side: m.side, mask, depthWrite: m.depthWrite !== false, blending: m.blending, entries: [] }; v2.set(k2, b2); }
      b2.entries.push({ geometry: geo, matrix: M, start, count });
    }
  }
  const build = (merged, material, mask, name) => {
    const g = new THREE.BufferGeometry();
    for (const [n, a] of Object.entries(merged.attrs)) g.setAttribute(n, new THREE.BufferAttribute(a.array, a.itemSize));
    g.setIndex(new THREE.BufferAttribute(merged.index, 1));
    const mesh = new THREE.Mesh(g, material);
    mesh.name = name; mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; mesh.matrixWorldAutoUpdate = false;
    mesh.layers.mask = mask; mesh.visible = false;
    scene.add(mesh); added.push(mesh); disposeLater.push(g);
    return mesh;
  };
  const v1Meshes = [], v2Meshes = [];
  let v1v = 0, v1t = 0;
  for (const b of v1.values()) { const mg = mergeEntries(b.entries, false); v1v += mg.vertices; v1t += mg.triangles; v1Meshes.push(build(mg, b.material, b.mask, "hbSC-V1")); }
  let v2v = 0, v2t = 0;
  for (const b of v2.values()) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: b.side, transparent: b.cls === "translucent" || b.cls === "additive", blending: b.blending, depthWrite: b.depthWrite });
    disposeLater.push(mat);
    const mg = mergeEntries(b.entries, true); v2v += mg.vertices; v2t += mg.triangles;
    v2Meshes.push(build(mg, mat, b.mask, "hbSC-V2"));
  }
  out.V1 = { meshes: v1Meshes.length, vertices: v1v, triangles: v1t };
  out.V2 = { meshes: v2Meshes.length, vertices: v2v, triangles: v2t, classes: [...v2.keys()] };
  for (const [o] of plain) saved.visible.set(o, o.visible);
  const setVariant = (v) => {
    const merged1 = v === "V1", merged2 = v === "V2";
    for (const [o] of plain) o.visible = merged1 || merged2 ? false : saved.visible.get(o);
    for (const m of v1Meshes) m.visible = merged1;
    for (const m of v2Meshes) m.visible = merged2;
  };
  const ap = L.atmospherePipeline, co = L.cloudOverlay;
  const renderVariant = (v, dt) => {
    if (v === "V3") {
      if (!ap) return false;
      const cloud = co && !(L.skyDome && L.skyDome._lastIsIndoor);
      if (cloud) co.preRender(r, dt, cam);
      ap.render(cam, dt);
      if (cloud) co.renderOverlay(r);
      return true;
    }
    cam.layers.mask = OPTS.mask;
    r.setRenderTarget(null);
    r.render(scene, cam);
    return true;
  };
  const pending = [];
  const poll = (force) => {
    if (!tq) return;
    const dis = gl.getParameter(tq.GPU_DISJOINT_EXT);
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      const av = gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE);
      if (!av && !force) continue;
      if (av && !dis) p.win.gpu.push(gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(p.q); pending.splice(i, 1);
    }
  };
  const runWindow = (v, ms, win) => new Promise((done) => {
    setVariant(v);
    let last = null; const t0 = performance.now();
    const f = (now) => {
      poll(false);
      if (last !== null) win.dt.push(now - last);
      const dt = last === null ? 0 : (now - last) / 1000;
      last = now;
      let q = null;
      if (tq && pending.length < 256) { q = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, q); }
      const a = performance.now();
      const ok = renderVariant(v, dt);
      win.render.push(performance.now() - a);
      if (q) { gl.endQuery(tq.TIME_ELAPSED_EXT); pending.push({ q, win }); }
      if (!ok) { win.skipped = "no atmosphere pipeline (wireframe / atmosphere off)"; return done(); }
      if (now - t0 >= ms) return done();
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? +s[s.length >> 1].toFixed(3) : null; };
  const avg = (a) => { const s = a.filter(Number.isFinite); return s.length ? +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(3) : null; };
  for (const v of OPTS.variants) { const w = { dt: [], render: [], gpu: [] }; await runWindow(v, OPTS.warmSec * 1000, w); }
  for (let round = 1; round <= OPTS.rounds; round++) {
    const order = OPTS.variants.map((_, i) => OPTS.variants[(i + round - 1) % OPTS.variants.length]);
    for (const v of order) {
      const w = { dt: [], render: [], gpu: [] };
      performance.mark(`hbSC:${v}:r${round}`);
      await runWindow(v, OPTS.secPerVariant * 1000, w);
      performance.mark("hbSC:gap");
      await new Promise((res) => setTimeout(res, 300));
      poll(false);
      const n = w.dt.length, sum = w.dt.reduce((a, x) => a + x, 0);
      out.windows.push({ variant: v, round, frames: n, fps: n ? +(n / (sum / 1000)).toFixed(1) : null, frameP50: med(w.dt), renderMs: avg(w.render), renderP50: med(w.render),
        gpuMs: avg(w.gpu), gpuP50: med(w.gpu), gpuSamples: w.gpu.length, skipped: w.skipped || null });
    }
  }
  await new Promise((res) => setTimeout(res, 400));
  poll(true);
  const per = {};
  for (const v of OPTS.variants) {
    const ws = out.windows.filter((w) => w.variant === v && !w.skipped);
    per[v] = { windows: ws.length, renderMs: med(ws.map((w) => w.renderMs)), gpuMs: med(ws.map((w) => w.gpuMs)), fps: med(ws.map((w) => w.fps)) };
  }
  out.perVariant = per;
  if (per.V0 && per.V0.renderMs) {
    for (const v of ["V1", "V2"]) if (per[v] && per[v].renderMs != null) per[v].renderCut = +(1 - per[v].renderMs / per.V0.renderMs).toFixed(3);
  }
} catch (e) {
  out.error = String((e && e.stack) || e).slice(0, 600);
} finally {
  for (const m of added) { try { scene.remove(m); } catch (_) { /* gone */ } }
  for (const d of disposeLater) { try { d.dispose(); } catch (_) { /* gone */ } }
  for (const [o, v] of saved.visible) o.visible = v;
  cam.layers.mask = saved.mask;
  r.autoClear = saved.autoClear;
  try { r.setRenderTarget(saved.rt); } catch (_) { /* gone */ }
  out.restored = { mask: cam.layers.mask === saved.mask, mergedLeft: added.filter((m) => m.parent).length, visibility: [...saved.visible].every(([o, v]) => o.visible === v) };
  try { if (typeof W.__renderOnce === "function") W.__renderOnce(); } catch (_) { /* best effort */ }
}
return out;
