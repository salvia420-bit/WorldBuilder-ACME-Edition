// glcensus.js — page-side body of an async fn (`node hbsess.mjs eval glcensus.js`; 2026-10-06). Per-frame GL census (draw/upload/compile/sync
// only — lower overhead than v1) + UPLOAD ATTRIBUTION: every bufferData / tex*Image* source is mapped back to
// the scene object (and liveScene3d group) that owns it. Also first-draw detection per object via
// renderBufferDirect. Knobs on window: __censusMode "street"|"orbit"|"still", __censusMs, __censusPre, __censusPost
// (prepend e.g. `window.__censusMode="street";` to a copy). Analyse: `python3 glcensus.py out.json 80`.
// Untraced: the fence lag column is the GPU-side backlog; LoAF entries attribute long frames.
const MODE = window.__censusMode || "street", MS = window.__censusMs || 12000;
const PRE = window.__censusPre ?? 1500, POST = window.__censusPost ?? 2500;
const L = window.liveScene3d, R = L.renderer, gl = R.getContext(), P = WebGL2RenderingContext.prototype;
const now = () => performance.now();
const frames = [], loaf = [], unknownUp = [];
let cur = null, fi = -1;
const nf = (t) => ({ t, dt: 0, dr: 0, inst: 0, md: 0, drMs: 0, texN: 0, texB: 0, texMs: 0, bufN: 0, bufB: 0, bufMs: 0, newDraw: 0, cmp: 0, lnk: 0,
  syncMs: 0, maxMs: 0, maxName: "", rMs: 0, prog: 0, geo: 0, txc: 0, lagMs: -1, phase: "" });
// ---- ownership map: typed array / image source -> {cat, key} ------------------------------------------
const GROUPS = [["terrain", L.terrainGroup], ["buildings", L.buildingsGroup], ["statics", L.staticsGroup], ["cells", L.cellsGroup], ["entities", L.entitiesGroup], ["lights", L.lightsGroup]];
const norm = (s) => String(s || "").replace(/0x[0-9a-f]+/gi, "X").replace(/[0-9a-f]{6,}/gi, "H").replace(/\d+/g, "N").slice(0, 48);
const catCache = new WeakMap();
function catOf(o) {
  let c = catCache.get(o); if (c) return c;
  let grp = "scene", p = o, names = [];
  for (let d = 0; p && d < 12; d++, p = p.parent) {
    if (d < 3) names.push(norm(p.name || p.type));
    const g = GROUPS.find(([, G]) => G === p); if (g) { grp = g[0]; break; }
  }
  if (grp === "scene" && o.parent === null && o !== L.scene) grp = "detached";
  c = { grp, key: grp + ":" + names.join("<") }; catCache.set(o, c); return c;
}
const own = new WeakMap();
function regTex(t, info) {
  if (!t || !t.isTexture) return;
  const i = t.image; const tinfo = { ...info, tex: norm(t.name) || (t.isCompressedTexture ? "ctex" : t.isDataTexture ? "dtex" : "tex") };
  if (i) { if (i.data) own.set(i.data, tinfo); else if (typeof i === "object") own.set(i, tinfo); if (Array.isArray(i)) for (const x of i) if (x && typeof x === "object") own.set(x.data || x, tinfo); }
  if (Array.isArray(t.mipmaps)) for (const m of t.mipmaps) if (m && typeof m === "object") own.set(m.data || m, tinfo);
}
function regObj(o) {
  const c = catOf(o);
  const g = o.geometry;
  if (g && g.attributes) {
    for (const [an, a] of Object.entries(g.attributes)) { const arr = a.array || a.data?.array; if (arr) own.set(arr, { ...c, what: "attr:" + an }); }
    if (g.index?.array) own.set(g.index.array, { ...c, what: "index" });
    for (const [an, a] of Object.entries(g.morphAttributes || {})) for (const x of a) if (x?.array) own.set(x.array, { ...c, what: "morph:" + an });
  }
  if (o.instanceMatrix?.array) own.set(o.instanceMatrix.array, { ...c, what: "instanceMatrix" });
  if (o.instanceColor?.array) own.set(o.instanceColor.array, { ...c, what: "instanceColor" });
  const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
  for (const m of mats) {
    for (const k in m) { const v = m[k]; if (v && v.isTexture) regTex(v, { ...c, what: "map:" + k }); }
    if (m.uniforms) for (const [un, u] of Object.entries(m.uniforms)) { const v = u && u.value; if (v && v.isTexture) regTex(v, { ...c, what: "uni:" + un }); else if (Array.isArray(v)) for (const x of v) if (x && x.isTexture) regTex(x, { ...c, what: "uni:" + un }); }
    if (m.userData) for (const [un, u] of Object.entries(m.userData)) { const v = u && (u.value ?? u); if (v && v.isTexture) regTex(v, { ...c, what: "ud:" + un }); }
  }
  // BatchedMesh internal data textures
  for (const k of ["_matricesTexture", "_indirectTexture", "_colorsTexture", "_multiDrawStartsTexture"]) if (o[k]) regTex(o[k], { ...c, what: "batch:" + k });
}
let lastScanFi = -99, scans = 0;
function scan() { scans++; L.scene.traverse(regObj); if (L.scene.background?.isTexture) regTex(L.scene.background, { grp: "scene", key: "scene:background", what: "bg" }); if (L.scene.environment?.isTexture) regTex(L.scene.environment, { grp: "scene", key: "scene:env", what: "env" }); }
const t0scan = now(); scan(); const scanMs = now() - t0scan;
const upBy = new Map(); // key -> {bytes, n, frames:Set, firstFi, what:Set, kind}
function lookup(src) { let r = own.get(src); if (!r && fi !== lastScanFi) { lastScanFi = fi; scan(); r = own.get(src); } return r; }
function attribute(kind, src, bytes, ms) {
  const o = src && typeof src === "object" ? lookup(src) : null;
  const key = (o ? o.key : "?") + " | " + kind + ":" + (o ? (o.what.startsWith("attr") || o.what === "index" ? "geom" : o.what) : (src?.constructor?.name || typeof src));
  let e = upBy.get(key); if (!e) { e = { bytes: 0, n: 0, ms: 0, ph: {}, firstFi: fi, tex: new Set() }; upBy.set(key, e); }
  e.bytes += bytes; e.n++; e.ms += ms; e.ph[cur ? cur.phase : "?"] = (e.ph[cur ? cur.phase : "?"] || 0) + bytes; if (o && o.tex) e.tex.add(o.tex);
  if (!o && unknownUp.length < 40) unknownUp.push({ fi, kind, bytes, src: src?.constructor?.name, len: src?.length, w: src?.width, h: src?.height, s: (new Error().stack || "").split("\n").slice(3, 8).map((s) => s.trim().replace(/https?:\/\/[^/]+\//, "")).join(" < ") });
}
const bpp = (fmt, type) => {
  if (type === gl.FLOAT) return fmt === gl.RGBA ? 16 : fmt === gl.RGB ? 12 : fmt === gl.RG ? 8 : 4;
  if (type === gl.HALF_FLOAT) return fmt === gl.RGBA ? 8 : fmt === gl.RGB ? 6 : fmt === gl.RG ? 4 : 2;
  if (fmt === gl.RGBA || fmt === gl.RGBA_INTEGER) return 4; if (fmt === gl.RGB) return 3; if (fmt === gl.RG) return 2; return 1;
};
const dims = (s) => [s?.width || s?.videoWidth || s?.displayWidth || 0, s?.height || s?.videoHeight || s?.displayHeight || 0];
function texUp(n, a) {
  // returns [bytes, src]
  if (n === "texImage2D") { if (a.length >= 8) return [a[3] * a[4] * bpp(a[6], a[7]), a[8]]; const [w, h] = dims(a[5]); return [w * h * bpp(a[3], a[4]), a[5]]; }
  if (n === "texSubImage2D") { if (a.length >= 8) return [a[4] * a[5] * bpp(a[6], a[7]), a[8]]; const [w, h] = dims(a[6]); return [w * h * bpp(a[4], a[5]), a[6]]; }
  if (n === "texImage3D") return [a[3] * a[4] * a[5] * bpp(a[7], a[8]), a[9]];
  if (n === "texSubImage3D") return [a[5] * a[6] * a[7] * bpp(a[8], a[9]), a[10]];
  if (n === "compressedTexImage2D") return [a[6]?.byteLength ?? 0, a[6]];
  if (n === "compressedTexSubImage2D") return [a[7]?.byteLength ?? 0, a[7]];
  if (n === "compressedTexImage3D") return [a[7]?.byteLength ?? 0, a[7]];
  if (n === "compressedTexSubImage3D") return [a[9]?.byteLength ?? 0, a[9]];
  return [0, null];
}
const restore = [];
const wrap = (n, fn) => { const o = P[n]; if (typeof o !== "function" || Object.prototype.hasOwnProperty.call(gl, n)) return; gl[n] = fn(o); restore.push(n); };
for (const n of ["drawElements", "drawArrays", "drawRangeElements", "drawElementsInstanced", "drawArraysInstanced"]) {
  const inst = n.endsWith("Instanced");
  wrap(n, (o) => function (a, b, c, d, e, f) { const t = now(), r = o.call(gl, a, b, c, d, e, f), ms = now() - t, F = cur; if (F) { if (inst) F.inst++; else F.dr++; F.drMs += ms; if (ms > F.maxMs) { F.maxMs = ms; F.maxName = n; } } return r; });
}
for (const n of ["texImage2D", "texSubImage2D", "texImage3D", "texSubImage3D", "compressedTexImage2D", "compressedTexSubImage2D", "compressedTexImage3D", "compressedTexSubImage3D"]) {
  wrap(n, (o) => function (...a) { const t = now(), r = o.apply(gl, a), ms = now() - t, F = cur; if (F) { let b = 0, src = null; try { [b, src] = texUp(n, a); } catch (_) {} F.texN++; F.texB += b; F.texMs += ms; if (ms > F.maxMs) { F.maxMs = ms; F.maxName = n; } attribute(n.startsWith("compressed") ? "ctex" : "tex", src, b, ms); } return r; });
}
for (const n of ["bufferData", "bufferSubData"]) {
  wrap(n, (o) => function (...a) { const t = now(), r = o.apply(gl, a), ms = now() - t, F = cur; if (F) { const src = typeof a[1] === "number" && n === "bufferData" ? null : n === "bufferData" ? a[1] : a[2]; const b = n === "bufferData" ? (typeof a[1] === "number" ? a[1] : a[1]?.byteLength || 0) : (a[4] || a[2]?.byteLength || 0); F.bufN++; F.bufB += b; F.bufMs += ms; if (ms > F.maxMs) { F.maxMs = ms; F.maxName = n; } attribute(n === "bufferData" ? "bufData" : "bufSub", src, b, ms); } return r; });
}
wrap("compileShader", (o) => function (s) { const r = o.call(gl, s); if (cur) cur.cmp++; return r; });
wrap("linkProgram", (o) => function (p) { const r = o.call(gl, p); if (cur) cur.lnk++; return r; });
for (const n of ["getError", "getParameter", "getProgramParameter", "getShaderParameter", "readPixels", "getBufferSubData", "finish", "clientWaitSync", "getUniformLocation", "getAttribLocation", "getActiveUniform", "getActiveAttrib", "checkFramebufferStatus"]) {
  wrap(n, (o) => function (...a) { const t = now(), r = o.apply(gl, a), ms = now() - t, F = cur; if (F) { F.syncMs += ms; if (ms > F.maxMs) { F.maxMs = ms; F.maxName = n; } } return r; });
}
const md = gl.getExtension("WEBGL_multi_draw"), mdRestore = [];
if (md) for (const n of ["multiDrawElementsWEBGL", "multiDrawArraysWEBGL", "multiDrawElementsInstancedWEBGL", "multiDrawArraysInstancedWEBGL"]) {
  const o = md[n]; if (typeof o !== "function") continue;
  md[n] = function (...a) { const t = now(), r = o.apply(md, a), ms = now() - t, F = cur; if (F) { F.md++; F.drMs += ms; } return r; };
  mdRestore.push([n, o]);
}
// first-draw detection
const seen = new WeakSet(), newDraws = new Map();
const origRBD = R.renderBufferDirect;
R.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
  if (cur && object && !seen.has(object)) { seen.add(object); if (cur.phase !== "pre") { cur.newDraw++; const c = catOf(object); const e = newDraws.get(c.key) || { n: 0, firstFi: fi, verts: 0 }; e.n++; e.verts += geometry?.attributes?.position?.count || 0; newDraws.set(c.key, e); } }
  return origRBD.call(this, camera, scene, geometry, material, object, group);
};
const origRender = R.render;
R.render = function (...a) { const t = now(); const r = origRender.apply(this, a); if (cur) cur.rMs += now() - t; return r; };
let po = null;
try { po = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration >= 100) loaf.push({ t: Math.round(e.startTime), d: Math.round(e.duration), blk: Math.round(e.blockingDuration || 0), rs: Math.round((e.renderStart || 0) - e.startTime),
  sc: (e.scripts || []).filter((s) => s.duration >= 10).map((s) => ({ inv: s.invoker, d: Math.round(s.duration), fn: s.sourceFunctionName, src: (s.sourceURL || "").split("/").pop().split("?")[0] + ":" + s.sourceCharPosition })) }); });
  po.observe({ type: "long-animation-frame", buffered: false }); } catch (e) { loaf.push({ err: String(e) }); }
const fences = [];
let phase = "pre";
await new Promise((res) => {
  const o = window.__hbOrbit; let t0 = null, tS = null;
  const f = (t) => {
    if (cur) { cur.dt = t - cur.t; frames.push(cur); }
    for (let i = fences.length - 1; i >= 0; i--) {
      const x = fences[i];
      if (P.getSyncParameter.call(gl, x.s, gl.SYNC_STATUS) === gl.SIGNALED) { const fr = frames[x.fi]; if (fr) fr.lagMs = Math.round(t - x.t); P.deleteSync.call(gl, x.s); fences.splice(i, 1); }
    }
    if (t0 === null) t0 = t;
    if (phase === "pre" && t - t0 >= PRE) { phase = "sweep"; tS = t; if (MODE === "street") { try { window.__cam.release(); } catch (_) {} } }
    if (phase === "sweep") {
      const u = (t - tS) / MS;
      if (MODE === "street") window.__cam.player(8, u * 360, 12, 1.5);
      else if (MODE === "orbit") window.__cam.orbit(o.x, o.y, o.z, o.dist, o.az + (t - tS) / 1000 * o.degPerSec, o.el);
      if (t - tS >= MS) { phase = "post"; tS = t; }
    } else if (phase === "post" && t - tS >= POST) { cur = null; return res(); }
    fi++; cur = nf(t); cur.phase = phase;
    const info = R.info; cur.prog = info.programs?.length || 0; cur.geo = info.memory.geometries; cur.txc = info.memory.textures;
    const s = P.fenceSync.call(gl, gl.SYNC_GPU_COMMANDS_COMPLETE, 0); if (s) fences.push({ s, t, fi });
    requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
});
for (const x of fences) P.deleteSync.call(gl, x.s);
for (const n of restore) delete gl[n];
for (const [n, o] of mdRestore) md[n] = o;
R.render = origRender; R.renderBufferDirect = origRBD;
try { po && po.disconnect(); } catch (_) {}
const keys = Object.keys(frames[0] || {});
const ups = [...upBy.entries()].map(([k, e]) => ({ k, mb: +(e.bytes / 1e6).toFixed(2), n: e.n, ms: +e.ms.toFixed(1), ph: Object.fromEntries(Object.entries(e.ph).map(([p, b]) => [p, +(b / 1e6).toFixed(2)])), firstFi: e.firstFi, tex: [...e.tex].slice(0, 4) })).sort((a, b) => b.mb - a.mb);
return { mode: MODE, ms: MS, scanMs: +scanMs.toFixed(1), scans, keys, rows: frames.map((f) => keys.map((k) => (typeof f[k] === "number" ? +f[k].toFixed(2) : f[k]))),
  ups: ups.slice(0, 80), newDraws: [...newDraws.entries()].map(([k, e]) => ({ k, ...e })).sort((a, b) => b.n - a.n).slice(0, 60), unknownUp, loaf,
  asyncLink: window.__asyncLink ? { ...window.__asyncLink.stats } : null, programs: R.info.programs?.length };
