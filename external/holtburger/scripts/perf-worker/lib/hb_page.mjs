// lib/hb_page.mjs — page-side instruments of harness v2 (round 3 R3-0; 2026-10-30).
//
// Every export is a SELF-CONTAINED function: the drivers ship it into the page with
// `pg.evaluate(fn, arg)` (Playwright and lib/cdp_raw.mjs both send `fn.toString()`), so no body
// may reference anything outside itself. They are harness, never product: nothing here is
// imported by scene3d/, and each one restores what it wraps. The node suite
// (tests/hb_v2.test.mjs) runs them against fakes.
//
//   pageInstallProbe(opts)   window.__hbProbe: a renderer.render wrapper + a rAF frame sampler.
//                            Per frame: renderJs ms (sum of top-level render() calls — WebAC
//                            tools/measure-perf.ts:412-419 times its one call the same way),
//                            info.calls / triangles, render walks (top-level render() calls),
//                            world walks (scene with > 2 children, i.e. not a full-screen quad),
//                            empty walks (0 draws), camera heading (L1 heading bins),
//                            __batchedRuns.frame() batched calls / ranges asked / ranges issued,
//                            the terrain batch's multidraw range count; plus a per-pass table
//                            (scene | layer mask | render target) and a JS-heap sample every 5 s.
//                            begin(label) / end() -> one segment's data; uninstall().
//                            ROW ALIGNMENT: the sampler runs in rAF AFTER the app's render of the
//                            same frame, so info.calls / walks / heading / terrain ranges are that
//                            frame's own. __batchedRuns.frame() is the LAST COMPLETED frame (its
//                            counters roll over at the first BatchedMesh draw of the next display
//                            frame, scene3d/batched_runs.js _countFrame), so read after frame k's
//                            render it holds frame k-1: the sampler writes it into the PREVIOUS
//                            rendered row. A segment's last rendered row stays null for those three
//                            columns (its totals are readable only after the segment). A frame with
//                            render walks but no BatchedMesh draw would leave the counters un-rolled
//                            (never in-world: terrain is BatchedMesh). ALLOCATION: frame() copies one
//                            5-field object per sampled frame while a segment records (none between
//                            segments); `__batchedRuns.frameInto(out)` is used instead when present.
//   pageInstallPassTimers()  window.__hbPassTimers: whole-pass GPU TIME_ELAPSED queries around each
//                            enabled composer pass and each top-level renderer.render() outside a
//                            pass, NEVER nested (OpenAC GpuStageProfiler.cs:15-20: nested ranges read
//                            ~1/7 of the real cost). Refuses under ?vfxGauge (its whole-frame query
//                            would be a second TIME_ELAPSED in flight).
//   pageOwnerCensus(o)       draws per frame per owner row (entity part-surfaces, particle buckets,
//                            cell statics, cell surfaces, occlusion proxies, pools, ...) with 300 m /
//                            600 m distance buckets (L1; WebAC measure-perf.ts:372-408).
//   pageGlCensus(o)          N-frame GL-command census: calls per frame per WebGL2 method and per
//                            multi-draw extension method, with the ranges each multi-draw carried.
//   pageProgramKeys()        renderer.info.programs -> [{name, cacheKey, usedTimes}] (program-key diff).
//   pageServerState()        entity count + part-mesh census (server-state pin, rule V).
//   pageApplyPins(o)         the fixed DayGroup (setGameDayOverride) + read-back of every pin. The
//                            adapter is read (a throw-away WebGL2 context) only with o.adapter.
//   pageGateValue(expr)      an arm's gate expression -> true / false / "throw: ..." (hbbench, hb_boot).
//   pageGateInfo(expr)       the gateInfo expression's value, JSON-cloned.
//   pageEnsureOrbit(o)       window.__hbOrbit as booted, or set from the player pose (hbsweep attach).
//   pageMarkedWindows(o)     frame times + performance.mark per 5 s window + heap at each edge
//                            (the anatomy trace phase: hbreport.py trace-split cuts the trace by
//                            these marks for GC and CrGpuMain per window).

/** Install window.__hbProbe (idempotent). Returns {installed, reason?}. */
export function pageInstallProbe(opts) {
  const W = window;
  if (W.__hbProbe && W.__hbProbe.installed) return { installed: true, already: true };
  const L = W.liveScene3d;
  const r = L && L.renderer;
  if (!r || typeof r.render !== "function") return { installed: false, reason: "no liveScene3d.renderer" };
  const o = Object.assign({ cap: 12000, heapEveryMs: 5000 }, opts || {});
  const now = () => performance.now();
  const heading = (m8, m10) => {
    if (!Number.isFinite(m8) || !Number.isFinite(m10) || (m8 === 0 && m10 === 0)) return NaN;
    let d = (Math.atan2(-m8, m10) * 180) / Math.PI;
    if (d < 0) d += 360;
    if (d >= 360) d -= 360;
    return d === 0 ? 0 : d; // no -0
  };
  const hadOwn = Object.prototype.hasOwnProperty.call(r, "render");
  const orig = r.render;
  let active = false, depth = 0, nested = 0;
  let fCalls = 0, fTris = 0, fMs = 0, fWalks = 0, fWorld = 0, fEmpty = 0, fYaw = NaN;
  // pass slots: sceneId -> rtId -> mask -> slot (strings built once per slot)
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = (x) => { if (!x) return 0; let v = ids.get(x); if (v === undefined) { v = nextId++; ids.set(x, v); } return v; };
  const slots = [];
  const idx = new Map();
  let overflow = null; // a page that renders a fresh Scene / target object every frame must not grow the table
  const slotOf = (scene, rt, mask) => {
    if (slots.length >= 256) {
      if (overflow === null) { overflow = { key: "overflow (> 256 scene|mask|target slots)", sceneChildren: 0, calls: 0, draws: 0, ms: 0, empty: 0 }; slots.push(overflow); }
      return overflow;
    }
    const sid = idOf(scene), rid = idOf(rt);
    let a = idx.get(sid); if (a === undefined) { a = new Map(); idx.set(sid, a); }
    let b = a.get(rid); if (b === undefined) { b = new Map(); a.set(rid, b); }
    let s = b.get(mask);
    if (s === undefined) {
      const sn = scene ? (scene.name || scene.type || "scene") + "#" + sid : "none";
      const rn = rt ? ((rt.texture && rt.texture.name) || `${rt.width}x${rt.height}`) + "#" + rid : "screen";
      s = { key: `${sn}|L${mask >>> 0}|${rn}`, sceneChildren: scene && scene.children ? scene.children.length : 0, calls: 0, draws: 0, ms: 0, empty: 0 };
      b.set(mask, s); slots.push(s);
    }
    return s;
  };
  const wrapped = function hbProbeRender(scene, camera) {
    if (!active) return orig.apply(this, arguments);
    if (depth > 0) { nested++; return orig.apply(this, arguments); }
    depth = 1;
    const info = this.info;
    const ar = info.autoReset;
    const c0 = ar ? 0 : info.render.calls, tr0 = ar ? 0 : info.render.triangles;
    const rt = typeof this.getRenderTarget === "function" ? this.getRenderTarget() : null;
    const t0 = now();
    try { return orig.apply(this, arguments); }
    finally {
      const dt = now() - t0;
      depth = 0;
      const c = info.render.calls - c0, tr = info.render.triangles - tr0;
      fCalls += c; fTris += tr; fMs += dt; fWalks++;
      const kids = scene && scene.children ? scene.children.length : 0;
      if (kids > 2) fWorld++;
      if (c === 0) fEmpty++;
      if (fYaw !== fYaw && camera && camera.isPerspectiveCamera === true && camera.matrixWorld) {
        const e = camera.matrixWorld.elements; fYaw = heading(e[8], e[10]);
      }
      const s = slotOf(scene, rt, camera && camera.layers ? camera.layers.mask : 0);
      s.calls++; s.draws += c; s.ms += dt; if (c === 0) s.empty++;
    }
  };
  r.render = wrapped;
  const COLS = ["t", "calls", "tris", "ms", "walks", "world", "empty", "yaw", "bCalls", "sub", "issued", "terr"];
  let cols = null, n = 0, seg = null, heap = [], lastHeapT = 0, primed = false, terrMeshes = [];
  let pendingRow = -1; // the last rendered row whose __batchedRuns totals are not readable yet
  const brOut = { batchedCalls: 0, subDraws: 0, issued: 0, sortedSubDraws: 0, sortedIssued: 0 };
  const readBatched = () => {
    const br = W.__batchedRuns;
    if (!br) return null;
    if (typeof br.frameInto === "function") return br.frameInto(brOut) || brOut;
    return typeof br.frame === "function" ? br.frame() : null;
  };
  const heapMB = () => { try { return performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null; } catch (_) { return null; } };
  const resetFrame = () => { fCalls = 0; fTris = 0; fMs = 0; fWalks = 0; fWorld = 0; fEmpty = 0; fYaw = NaN; };
  let gen = 0; // one rAF chain per segment: a chain from an earlier begin() stops at its next frame
  const onFrame = (t) => {
    const walked = fWalks > 0;
    if (primed && walked && pendingRow >= 0) {
      // this frame's render rolled the counters over: frame() now holds the pending row's frame
      try { const f = readBatched(); if (f) { cols.bCalls[pendingRow] = f.batchedCalls | 0; cols.sub[pendingRow] = f.subDraws | 0; cols.issued[pendingRow] = f.issued | 0; } } catch (_) { /* diag only */ }
      pendingRow = -1;
    }
    if (primed && n < o.cap) {
      let terr = 0;
      for (let i = 0; i < terrMeshes.length; i++) terr += terrMeshes[i]._multiDrawCount | 0;
      cols.t[n] = t; cols.calls[n] = fCalls; cols.tris[n] = fTris; cols.ms[n] = fMs; cols.walks[n] = fWalks;
      cols.world[n] = fWorld; cols.empty[n] = fEmpty; cols.yaw[n] = fYaw; cols.terr[n] = terr;
      if (walked) { cols.bCalls[n] = NaN; cols.sub[n] = NaN; cols.issued[n] = NaN; pendingRow = n; } // filled on the next rendered frame
      else { cols.bCalls[n] = 0; cols.sub[n] = 0; cols.issued[n] = 0; } // nothing rendered: nothing drawn
      n++;
    }
    primed = true;
    if (t - lastHeapT >= o.heapEveryMs) { heap.push({ t: Math.round(t), mb: heapMB() }); lastHeapT = t; }
    resetFrame();
  };
  const api = {
    installed: true,
    begin(label) {
      if (active) api.end();
      seg = String(label || "seg");
      cols = {}; for (const c of COLS) cols[c] = new Float64Array(o.cap);
      n = 0; heap = []; lastHeapT = 0; primed = false; nested = 0; pendingRow = -1;
      for (const s of slots) { s.calls = 0; s.draws = 0; s.ms = 0; s.empty = 0; }
      terrMeshes = [];
      try { const tg = L.terrainGroup; if (tg && tg.children) for (const c of tg.children) if (c && c.isBatchedMesh === true) terrMeshes.push(c); } catch (_) { /* none */ }
      resetFrame();
      active = true;
      const my = ++gen;
      const tick = (t) => { if (!active || my !== gen) return; onFrame(t); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      return { label: seg };
    },
    end() {
      if (!active && cols === null) return null;
      active = false;
      const br = W.__batchedRuns;
      // which __batchedRuns read filled the range columns (null: no API on this page, the columns stay null)
      const rangesApi = br && typeof br.frameInto === "function" ? "frameInto" : br && typeof br.frame === "function" ? "frame" : null;
      const out = { label: seg, n, cols: {}, passes: [], heap: heap.slice(), heapEnd: heapMB(), nested, terrainMeshes: terrMeshes.length, rangesApi };
      const r2 = (x) => Math.round(x * 100) / 100;
      for (const c of COLS) {
        const a = new Array(n);
        for (let i = 0; i < n; i++) { const v = cols[c][i]; a[i] = v !== v ? null : c === "yaw" ? Math.round(v * 10) / 10 : c === "ms" || c === "t" ? r2(v) : v; }
        out.cols[c] = a;
      }
      for (const s of slots) if (s.calls > 0) out.passes.push({ key: s.key, sceneChildren: s.sceneChildren, calls: s.calls, draws: s.draws, ms: r2(s.ms), empty: s.empty });
      out.passes.sort((a, b) => b.ms - a.ms);
      cols = null; pendingRow = -1;
      return out;
    },
    uninstall() {
      active = false;
      if (r.render === wrapped) { if (hadOwn) r.render = orig; else delete r.render; delete W.__hbProbe; return { restored: true }; }
      // Someone wrapped render on top of us: stay as an inert pass-through rather than cut them off.
      delete W.__hbProbe;
      return { restored: false, inert: true };
    },
  };
  W.__hbProbe = api;
  return { installed: true };
}

/** Install window.__hbPassTimers (whole-pass GPU timer queries, never nested). */
export function pageInstallPassTimers(opts) {
  const W = window;
  if (W.__hbPassTimers && W.__hbPassTimers.installed) return { installed: true, already: true };
  const L = W.liveScene3d, r = L && L.renderer;
  if (!r) return { installed: false, reason: "no renderer" };
  const o = Object.assign({ maxPending: 512 }, opts || {});
  let gauge = false;
  try { gauge = /^(on|1|true|yes)$/i.test(new URLSearchParams(location.search).get("vfxGauge") || ""); } catch (_) { /* no location */ }
  const gl = r.getContext();
  const ext = gauge ? null : gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const restore = [];
  const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
  const wrap = (obj, k, mk) => { const had = own(obj, k), prev = obj[k]; const w = mk(prev); obj[k] = w; restore.push(() => { if (obj[k] === w) { if (had) obj[k] = prev; else delete obj[k]; } }); };
  let active = false, depth = 0, disjoint = 0, dropped = 0, frames = 0;
  const pending = [];
  const acc = new Map(); // key -> {gpu:[], cpu:[], calls}
  const rec = (k) => { let e = acc.get(k); if (!e) { e = { gpu: [], cpu: [], calls: 0 }; acc.set(k, e); } return e; };
  const ids = new WeakMap(); let nextId = 1;
  const idOf = (x) => { if (!x) return 0; let v = ids.get(x); if (v === undefined) { v = nextId++; ids.set(x, v); } return v; };
  const timed = (key, fn, self, args) => {
    if (!active || depth > 0) return fn.apply(self, args);
    depth = 1;
    let q = null;
    if (ext && pending.length < o.maxPending) { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
    const t0 = performance.now();
    try { return fn.apply(self, args); }
    finally {
      const e = rec(typeof key === "function" ? key() : key);
      e.calls++; e.cpu.push(performance.now() - t0);
      if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push({ q, e }); } else if (ext) dropped++;
      depth = 0;
    }
  };
  const poll = (force) => {
    if (!ext) return;
    const dis = gl.getParameter(ext.GPU_DISJOINT_EXT);
    if (dis) disjoint++;
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      const avail = gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE);
      if (!avail && !force) continue;
      if (avail && !dis) p.e.gpu.push(gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(p.q); pending.splice(i, 1);
    }
  };
  const ap = L.atmospherePipeline, comp = ap && ap.composer;
  if (comp && Array.isArray(comp.passes)) {
    comp.passes.forEach((p, i) => {
      if (!p || typeof p.render !== "function") return;
      const key = `${String(i).padStart(2, "0")}:${p.name || "pass"}${p.effects ? "[" + p.effects.map((e) => e && e.name).join(",") + "]" : ""}`;
      wrap(p, "render", (prev) => function hbPassTimed() { return p.enabled === false ? prev.apply(this, arguments) : timed(key, prev, this, arguments); });
    });
  }
  const co = L.cloudOverlay;
  if (co && typeof co.preRender === "function") wrap(co, "preRender", (prev) => function hbCloudPre() { return timed("cloudOverlay.preRender", prev, this, arguments); });
  if (co && typeof co.renderOverlay === "function") wrap(co, "renderOverlay", (prev) => function hbCloudOverlay() { return timed("cloudOverlay.renderOverlay", prev, this, arguments); });
  wrap(r, "render", (prev) => function hbRenderTimed(scene, camera) {
    const self = this;
    return timed(() => {
      const rt = typeof self.getRenderTarget === "function" ? self.getRenderTarget() : null;
      const sn = scene ? (scene.name || scene.type || "scene") + "#" + idOf(scene) : "none";
      const rn = rt ? ((rt.texture && rt.texture.name) || `${rt.width}x${rt.height}`) + "#" + idOf(rt) : "screen";
      return `render:${sn}|L${camera && camera.layers ? camera.layers.mask >>> 0 : 0}|${rn}`;
    }, prev, this, arguments);
  });
  let rafOn = false;
  const onFrame = () => { if (!active) { rafOn = false; return; } frames++; poll(false); requestAnimationFrame(onFrame); };
  const sum = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), n = s.length; const q = (p) => +s[Math.min(n - 1, Math.floor(p * n))].toFixed(3); return { n, mean: +(a.reduce((x, y) => x + y, 0) / n).toFixed(3), p50: q(0.5), p95: q(0.95), max: +s[n - 1].toFixed(3) }; };
  W.__hbPassTimers = {
    installed: true,
    gpu: !!ext,
    refused: gauge ? "vfxGauge on: its whole-frame TIME_ELAPSED query would nest" : ext ? null : "EXT_disjoint_timer_query_webgl2 unavailable",
    begin() { acc.clear(); disjoint = 0; dropped = 0; frames = 0; active = true; if (!rafOn) { rafOn = true; requestAnimationFrame(onFrame); } return true; },
    async end() {
      active = false;
      await new Promise((res) => setTimeout(res, 400));
      poll(true);
      const passes = [];
      let gpuPerFrame = 0, cpuPerFrame = 0;
      for (const [key, e] of acc) {
        const g = sum(e.gpu), c = sum(e.cpu);
        const perFrame = frames ? e.calls / frames : 0;
        if (g) gpuPerFrame += g.mean * perFrame;
        if (c) cpuPerFrame += c.mean * perFrame;
        passes.push({ key, callsPerFrame: +perFrame.toFixed(2), gpuMs: g, cpuMs: c });
      }
      passes.sort((a, b) => ((b.gpuMs && b.gpuMs.mean) || 0) * b.callsPerFrame - ((a.gpuMs && a.gpuMs.mean) || 0) * a.callsPerFrame);
      return { frames, disjoint, dropped, gpu: !!ext, refused: this.refused, gpuMsPerFrame: +gpuPerFrame.toFixed(3), cpuMsPerFrame: +cpuPerFrame.toFixed(3), passes };
    },
    uninstall() { active = false; for (const f of restore.reverse()) { try { f(); } catch (_) { /* best effort */ } } for (const p of pending) { try { gl.deleteQuery(p.q); } catch (_) { /* gone */ } } pending.length = 0; delete W.__hbPassTimers; return true; },
  };
  return { installed: true, gpu: !!ext, refused: W.__hbPassTimers.refused };
}

/** Draws per frame per owner row with 300 m / 600 m distance buckets. Restores renderBufferDirect. */
export async function pageOwnerCensus(opts) {
  const W = window;
  const o = Object.assign({ frames: 60, near: 300, far: 600 }, opts || {});
  const L = W.liveScene3d, r = L && L.renderer;
  if (!r) return { error: "no renderer" };
  const groups = [["terrain", L.terrainGroup], ["buildings", L.buildingsGroup], ["statics", L.staticsGroup], ["cells", L.cellsGroup], ["entities", L.entitiesGroup], ["lights", L.lightsGroup]].filter((g) => g[1]);
  const strip = (s) => String(s || "").replace(/0x[0-9a-f]+/gi, "").replace(/[0-9a-f]{6,}/gi, "").replace(/[-_.#:]+\d+$/g, "").replace(/\d+/g, "N").slice(0, 40);
  const RULES = [
    ["occlusion proxies", /occlusion/i], ["particle buckets", /particle/i], ["cell statics", /cellstatic/i],
    ["cell surfaces", /cells\|.*surface/i], ["animated scenery", /anim-inst|anim-scenery|wind-tree|wind-template/i],
    ["chunk buckets", /static-batch-c/i], ["pools", /pool/i], ["grass", /grass/i], ["entity part-surfaces", /^main\|entities\|/],
    ["terrain", /^main\|terrain\|/], ["buildings", /^main\|buildings\|/], ["statics (other)", /^main\|statics\|/],
    ["cells (other)", /^main\|cells\|/], ["other scenes / post", /^other\|/],
  ];
  const cache = new WeakMap();
  let mainScene = L.scene || null;
  const ownerOf = (object, scene) => {
    let c = cache.get(object);
    if (c && c.scene === scene) return c;
    let root = "scene", names = [];
    for (let p = object, d = 0; p && d < 14; p = p.parent, d++) {
      if (d < 3) names.push(strip(p.name || p.type));
      const g = groups.find((x) => x[1] === p);
      if (g) { root = g[0]; break; }
    }
    const sc = scene === mainScene ? "main" : "other";
    const key = `${sc}|${root}|${names.join("<")}|${object.isBatchedMesh ? "BM" : object.isInstancedMesh ? "IM" : object.isSkinnedMesh ? "SM" : object.isMesh ? "M" : object.isPoints ? "P" : "?"}`;
    const hit = RULES.find((x) => x[1].test(key));
    c = { scene, key, owner: hit ? hit[0] : "other", batched: object.isBatchedMesh === true || object.isInstancedMesh === true };
    cache.set(object, c);
    return c;
  };
  const v = { x: 0, y: 0, z: 0 };
  const centre = (object) => {
    const g = object.geometry;
    const e = object.matrixWorld && object.matrixWorld.elements;
    if (!e) return null;
    let x = 0, y = 0, z = 0;
    if (g && g.boundingSphere) { x = g.boundingSphere.center.x; y = g.boundingSphere.center.y; z = g.boundingSphere.center.z; }
    v.x = e[0] * x + e[4] * y + e[8] * z + e[12];
    v.y = e[1] * x + e[5] * y + e[9] * z + e[13];
    v.z = e[2] * x + e[6] * y + e[10] * z + e[14];
    return v;
  };
  const rows = new Map(), keys = new Map();
  const objs = new Map();
  let draws = 0;
  const inner = r.renderBufferDirect;
  const hadOwn = Object.prototype.hasOwnProperty.call(r, "renderBufferDirect");
  const census = function hbOwnerCensus(camera, scene, geometry, material, object, group) {
    try {
      if (mainScene === null && scene && scene.isScene && camera && camera.isPerspectiveCamera) mainScene = scene;
      const c = ownerOf(object, scene);
      let b = "n/a";
      if (!c.batched && camera && camera.matrixWorld) {
        const p = centre(object);
        if (p) {
          const ce = camera.matrixWorld.elements;
          const d = Math.hypot(p.x - ce[12], p.y - ce[13], p.z - ce[14]);
          b = d < o.near ? `<${o.near}m` : d < o.far ? `${o.near}-${o.far}m` : `>=${o.far}m`;
        }
      } else if (c.batched) b = "batched";
      let row = rows.get(c.owner); if (!row) { row = { owner: c.owner, draws: 0, buckets: {}, objects: 0, materials: new Set() }; rows.set(c.owner, row); }
      row.draws++; row.buckets[b] = (row.buckets[b] || 0) + 1; row.materials.add(material);
      let os = objs.get(c.owner); if (!os) { os = new Set(); objs.set(c.owner, os); } os.add(object);
      let k = keys.get(c.key); if (!k) { k = { key: c.key, owner: c.owner, draws: 0 }; keys.set(c.key, k); } k.draws++;
      draws++;
    } catch (_) { /* never break a draw */ }
    return inner.call(this, camera, scene, geometry, material, object, group);
  };
  r.renderBufferDirect = census;
  let frames = 0;
  try {
    await new Promise((res) => { const f = () => { if (++frames >= o.frames) return res(); requestAnimationFrame(f); }; requestAnimationFrame(f); });
  } finally {
    if (r.renderBufferDirect === census) { if (hadOwn) r.renderBufferDirect = inner; else delete r.renderBufferDirect; }
  }
  const pf = (x) => +(x / Math.max(1, frames)).toFixed(2);
  const out = [];
  for (const row of rows.values()) {
    const buckets = {};
    for (const [b, n] of Object.entries(row.buckets)) buckets[b] = pf(n);
    out.push({ owner: row.owner, drawsPerFrame: pf(row.draws), buckets, objects: (objs.get(row.owner) || new Set()).size, materials: row.materials.size });
  }
  out.sort((a, b) => b.drawsPerFrame - a.drawsPerFrame);
  const keyRows = [...keys.values()].sort((a, b) => b.draws - a.draws).slice(0, 80).map((k) => ({ key: k.key, owner: k.owner, drawsPerFrame: pf(k.draws) }));
  return { frames, drawsPerFrame: pf(draws), near: o.near, far: o.far, owners: out, keys: keyRows };
}

/** N-frame GL-command census (calls per frame per method; multi-draw ranges). Restores everything. */
export async function pageGlCensus(opts) {
  const W = window;
  const o = Object.assign({ frames: 60 }, opts || {});
  const L = W.liveScene3d, r = L && L.renderer;
  if (!r) return { error: "no renderer" };
  const gl = r.getContext();
  const P = Object.getPrototypeOf(gl);
  const counts = new Map(), ranges = new Map();
  const restore = [];
  const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
  let on = true;
  const wrapOn = (obj, k, label, drawcountArg) => {
    const had = own(obj, k), prev = obj[k];
    if (typeof prev !== "function") return;
    const w = function () {
      if (on) {
        counts.set(label, (counts.get(label) || 0) + 1);
        if (drawcountArg >= 0) ranges.set(label, (ranges.get(label) || 0) + (arguments[drawcountArg] | 0));
      }
      return prev.apply(this, arguments);
    };
    obj[k] = w;
    restore.push(() => { if (obj[k] === w) { if (had) obj[k] = prev; else delete obj[k]; } });
  };
  for (const k of Object.getOwnPropertyNames(P)) {
    let d; try { d = Object.getOwnPropertyDescriptor(P, k); } catch (_) { continue; }
    if (!d || typeof d.value !== "function" || k === "constructor" || k === "getError" || k === "isContextLost") continue;
    wrapOn(gl, k, k, -1);
  }
  const md = gl.getExtension("WEBGL_multi_draw");
  if (md) {
    wrapOn(md, "multiDrawElementsWEBGL", "md.multiDrawElements", 6);
    wrapOn(md, "multiDrawArraysWEBGL", "md.multiDrawArrays", 5);
    wrapOn(md, "multiDrawElementsInstancedWEBGL", "md.multiDrawElementsInstanced", 8);
    wrapOn(md, "multiDrawArraysInstancedWEBGL", "md.multiDrawArraysInstanced", 7);
  }
  let frames = -1;
  try {
    await new Promise((res) => {
      const f = () => { frames++; if (frames === 0) { counts.clear(); ranges.clear(); } if (frames >= o.frames) return res(); requestAnimationFrame(f); };
      requestAnimationFrame(f);
    });
  } finally {
    on = false;
    for (const f of restore.reverse()) { try { f(); } catch (_) { /* best effort */ } }
  }
  const n = Math.max(1, frames);
  const perFrame = {};
  for (const [k, c] of [...counts.entries()].sort((a, b) => b[1] - a[1])) perFrame[k] = +(c / n).toFixed(2);
  const rangesPerFrame = {};
  for (const [k, c] of ranges) rangesPerFrame[k] = +(c / n).toFixed(2);
  const plain = ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced", "drawRangeElements"].reduce((a, k) => a + (perFrame[k] || 0), 0);
  const mdRanges = Object.values(rangesPerFrame).reduce((a, x) => a + x, 0);
  return { frames: n, perFrame, rangesPerFrame, plainDrawsPerFrame: +plain.toFixed(2), multiDrawRangesPerFrame: +mdRanges.toFixed(2),
    realDrawsPerFrame: +(plain + mdRanges).toFixed(2), totalCallsPerFrame: +Object.values(perFrame).reduce((a, x) => a + x, 0).toFixed(1) };
}

/** renderer.info.programs -> [{name, cacheKey, usedTimes}]. */
export function pageProgramKeys() {
  const L = window.liveScene3d, r = L && L.renderer;
  const progs = (r && r.info && r.info.programs) || [];
  return progs.map((p) => ({ name: p.name || null, cacheKey: String(p.cacheKey || ""), usedTimes: p.usedTimes | 0 }));
}

/** Entity count and part-mesh census (server-state pin) + scene counters. */
export function pageServerState() {
  const W = window, L = W.liveScene3d;
  const out = { at: Math.round(performance.now()) };
  try { out.entities = L.entityManager && L.entityManager.entityMap ? L.entityManager.entityMap.size : null; } catch (_) { out.entities = null; }
  let meshes = 0, visibleMeshes = 0, nodes = 0;
  try {
    const g = L.entitiesGroup;
    if (g) g.traverse((x) => { nodes++; if (x.isMesh) { meshes++; let v = true; for (let p = x; p && v; p = p.parent) v = p.visible !== false; if (v) visibleMeshes++; } });
  } catch (_) { /* partial */ }
  out.partMeshes = meshes; out.partMeshesVisible = visibleMeshes; out.entityNodes = nodes;
  try { out.lruResident = W.__landblockLru && W.__landblockLru.entries ? W.__landblockLru.entries.size : null; } catch (_) { out.lruResident = null; }
  try { const i = L.renderer.info; out.geometries = i.memory.geometries; out.textures = i.memory.textures; out.programs = i.programs ? i.programs.length : null; } catch (_) { /* none */ }
  try { out.pose = W.__cam && W.__cam.world ? W.__cam.world() : null; } catch (_) { out.pose = null; }
  return out;
}

/**
 * Apply the fixed DayGroup (when `o.dayGroup` = {day, year, index}) and read back every pin:
 * DayGroup index, the skytime pin, the window, pixel ratio, render scale, frame cap, the wasm the
 * page loaded, and (only with `o.adapter: true`) the adapter. Retries the override while the SkyDesc
 * is still loading. setGameDayOverride is sticky (lib.rs set_game_day_override): the DayGroup then
 * holds for the session, across Dereth's 7620 s day boundaries.
 */
export async function pageApplyPins(o) {
  const W = window, L = W.liveScene3d;
  const opt = o || {};
  const out = {};
  const h = W.__sessionHandle;
  if (opt.dayGroup) {
    const dg = { wanted: opt.dayGroup.index, day: opt.dayGroup.day, year: opt.dayGroup.year, applied: false, index: null, tries: 0 };
    for (let i = 0; i < 30 && !dg.applied; i++) {
      dg.tries++;
      try { dg.applied = !!(h && typeof h.setGameDayOverride === "function" && h.setGameDayOverride(opt.dayGroup.day >>> 0, opt.dayGroup.year >>> 0) !== false); } catch (e) { dg.error = String(e && e.message || e); }
      if (!dg.applied) await new Promise((r) => setTimeout(r, 1000));
    }
    out.dayGroup = dg;
  }
  try {
    const s = h && typeof h.getSkyState === "function" ? h.getSkyState() : null;
    if (s) {
      const idx = s.dayGroupIndex >>> 0, tod = +s.timeOfDayNormalized;
      try { s.free(); } catch (_) { /* freed */ }
      if (out.dayGroup) out.dayGroup.index = idx; else out.dayGroup = { wanted: null, index: idx };
      out.timeOfDay = { normalized: +tod.toFixed(4), hours: +(tod * 24).toFixed(2) };
    }
  } catch (e) { out.skyStateError = String(e && e.message || e); }
  const pin = W.__skyTimePin;
  out.skyTimePin = typeof pin === "number" && Number.isFinite(pin) ? { normalized: +pin.toFixed(4), hours: +(pin * 24).toFixed(2) } : null;
  out.window = { inner: [W.innerWidth, W.innerHeight], outer: [W.outerWidth, W.outerHeight], dpr: W.devicePixelRatio };
  try {
    const r = L.renderer, c = r.domElement;
    out.pixelRatio = r.getPixelRatio();
    out.canvas = [c.width, c.height];
  } catch (_) { /* no renderer */ }
  try { out.renderScale = W.__adaptiveRenderScale && W.__adaptiveRenderScale._getScale ? W.__adaptiveRenderScale._getScale() : null; } catch (_) { out.renderScale = null; }
  try { out.frameCap = W.__frameCapState ? W.__frameCapState() : null; } catch (_) { out.frameCap = null; }
  try { out.gpuGovernor = W.__gpuGovernor ? (typeof W.__gpuGovernor.stats === "function" ? W.__gpuGovernor.stats() : { enabled: W.__gpuGovernor.enabled }) : null; } catch (_) { out.gpuGovernor = null; }
  if (opt.adapter === true) { // the drivers read the adapter at boot; only an attached session asks here
    try {
      const gl = document.createElement("canvas").getContext("webgl2");
      const e = gl.getExtension("WEBGL_debug_renderer_info");
      out.adapter = gl.getParameter(e.UNMASKED_RENDERER_WEBGL);
      const lose = gl.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext();
    } catch (e) { out.adapter = null; }
  }
  try {
    out.wasm = performance.getEntriesByType("resource").filter((e) => /\.wasm(\?|#|$)/.test(e.name))
      .map((e) => ({ url: e.name, encoded: e.encodedBodySize || 0, decoded: e.decodedBodySize || 0 }));
  } catch (_) { out.wasm = []; }
  return out;
}

/**
 * Frame times for `ms` (camera still, or orbiting window.__hbOrbit when `orbit`), with a
 * performance.mark `${prefix}:w<i>` at each `windowMs` edge and the JS heap at each edge.
 */
export async function pageMarkedWindows(opts) {
  const W = window;
  const o = Object.assign({ ms: 10000, windowMs: 5000, orbit: false, prefix: "hbAnat", degPerSec: null }, opts || {});
  const orb = W.__hbOrbit;
  if (o.orbit && !orb) return { prefix: o.prefix, error: "orbit requested but window.__hbOrbit is missing (boot through hbanatomy / hbsess, or set it first)", orbit: true, frames: 0, windows: [] };
  const heapMB = () => { try { return performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(2) : null; } catch (_) { return null; } };
  const frames = [];
  const windows = [];
  let w = 0;
  const t0 = performance.now();
  performance.mark(`${o.prefix}:w0`);
  windows.push({ i: 0, t: t0, heapMB: heapMB() });
  await new Promise((res) => {
    let last = null;
    const f = (now) => {
      if (last !== null) frames.push([Math.round((now - last) * 100) / 100, w]);
      last = now;
      if (o.orbit && orb) W.__cam.orbit(orb.x, orb.y, orb.z, orb.dist, orb.az + ((now - t0) / 1000) * (o.degPerSec || orb.degPerSec), orb.el);
      if (now - t0 >= (w + 1) * o.windowMs) {
        w++;
        performance.mark(`${o.prefix}:w${w}`);
        windows.push({ i: w, t: now, heapMB: heapMB() });
      }
      if (now - t0 >= o.ms) return res();
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  performance.mark(`${o.prefix}:end`);
  const rows = [];
  for (let i = 0; i < windows.length; i++) {
    const d = frames.filter((x) => x[1] === i).map((x) => x[0]).sort((a, b) => a - b);
    if (!d.length) continue;
    const q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))];
    const sum = d.reduce((a, x) => a + x, 0);
    const next = windows[i + 1];
    rows.push({ window: i, frames: d.length, fps: +(d.length / (sum / 1000)).toFixed(1), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: d[d.length - 1],
      heapStartMB: windows[i].heapMB, heapEndMB: next ? next.heapMB : heapMB(), heapDeltaMB: next && windows[i].heapMB != null && next.heapMB != null ? +(next.heapMB - windows[i].heapMB).toFixed(2) : null });
  }
  return { prefix: o.prefix, ms: o.ms, windowMs: o.windowMs, orbit: !!o.orbit, frames: frames.length, windows: rows };
}

/**
 * Live-toggle sweep step (hbsweep.mjs). `o.op`:
 *   "info"   -> {avail, current, values} for knob `o.knob`
 *   "set"    -> set knob to `o.value` (restore path), returns the value read back
 *   "window" -> set knob to `o.value`, settle `o.settleMs`, then run the camera for `o.ms` (pose
 *               "orbit": the same arc of window.__hbOrbit every window, refused when it is missing;
 *               "street": a 360 deg chase-cam sweep; "still": parked) with window.__hbProbe
 *               recording; returns the window summary, `relinkedInSettle` (programs or async links
 *               that appeared while the new value settled) and `relinked` (inside the window).
 * Knobs (all live, none needs a reload): renderScale (__setRenderScale), cloudRes (__setCloudResScale),
 * cloudQuality (__setCloudQuality), haze (__layerHaze.strength), shafts (__setLightShafts),
 * ssao (__ssao.off). Values "on"/"off" map to the knob's own on/off.
 */
export async function pageSweep(o) {
  const W = window, L = W.liveScene3d, r = L && L.renderer;
  const eff = () => (W.__cloudOverlay && W.__cloudOverlay.volume && W.__cloudOverlay.volume.effect) || null;
  const dprScale = () => Math.min(W.devicePixelRatio || 1, 2);
  const K = {
    renderScale: { values: [1, 0.5, 0.25], avail: () => typeof W.__setRenderScale === "function", get: () => +(r.getPixelRatio() / dprScale()).toFixed(4), set: (v) => W.__setRenderScale(v) },
    cloudRes: { values: [1, 0.5], avail: () => typeof W.__setCloudResScale === "function" && !!eff(), get: () => (eff() ? eff().resolutionScale : null), set: (v) => W.__setCloudResScale(v) },
    cloudQuality: { values: ["ultra", "high", "medium", "low"], avail: () => typeof W.__setCloudQuality === "function" && !!eff(), get: () => (eff() ? eff().qualityPreset : null), set: (v) => W.__setCloudQuality(v) },
    haze: { values: ["on", 0], avail: () => !!W.__layerHaze, get: () => W.__layerHaze.strength, set: (v) => { W.__layerHaze.strength = v; } },
    shafts: { values: ["on", "off"], avail: () => typeof W.__setLightShafts === "function" && !!eff(), get: () => (eff() ? !!eff().lightShafts : null), set: (v) => W.__setLightShafts(v) },
    ssao: { values: ["on", "off"], avail: () => !!W.__ssao, get: () => !W.__ssao.off, set: (v) => { W.__ssao.off = !v; } },
  };
  const k = K[o.knob];
  if (!k) return { error: `unknown knob ${o.knob}` };
  const resolve = (v) => {
    if (o.knob === "haze") return v === "on" ? (o.onValue != null ? o.onValue : 0.4) : Number(v);
    if (o.knob === "shafts" || o.knob === "ssao") return v === "on" || v === true;
    return v;
  };
  if (o.op === "info") {
    const avail = !!k.avail();
    return { knob: o.knob, avail, current: avail ? k.get() : null, values: k.values };
  }
  if (!k.avail()) return { error: `knob ${o.knob} not available on this page` };
  const orb = W.__hbOrbit;
  // No silent fallback: an orbit window without the orbit would be a still window labelled orbit.
  if (o.op === "window" && o.pose === "orbit" && !orb) return { error: "pose orbit but window.__hbOrbit is missing (hbsweep sets it from the player pose)", knob: o.knob, value: o.value };
  k.set(o.op === "set" && o.raw ? o.value : resolve(o.value));
  if (o.op === "set") return { knob: o.knob, value: k.get() };
  const progs0 = r.info.programs ? r.info.programs.length : 0;
  const al0 = W.__asyncLink && W.__asyncLink.stats ? W.__asyncLink.stats.compiled | 0 : null;
  await new Promise((res) => setTimeout(res, o.settleMs || 1500));
  const progs1 = r.info.programs ? r.info.programs.length : 0;
  const al1 = W.__asyncLink && W.__asyncLink.stats ? W.__asyncLink.stats.compiled | 0 : null;
  const probe = W.__hbProbe;
  if (probe) probe.begin(`${o.knob}=${o.value}`);
  const d = [];
  await new Promise((res) => {
    let last = null; const t0 = performance.now();
    const f = (now) => {
      if (last !== null) d.push(now - last);
      last = now;
      const u = (now - t0) / o.ms;
      if (o.pose === "orbit" && orb) W.__cam.orbit(orb.x, orb.y, orb.z, orb.dist, orb.az + ((now - t0) / 1000) * orb.degPerSec, orb.el);
      else if (o.pose === "street") W.__cam.player(8, u * 360, 12, 1.5);
      if (now - t0 >= o.ms) return res();
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  const p = probe ? probe.end() : null;
  const progs2 = r.info.programs ? r.info.programs.length : 0;
  const al2 = W.__asyncLink && W.__asyncLink.stats ? W.__asyncLink.stats.compiled | 0 : null;
  const s = [...d].sort((a, b) => a - b), n = s.length;
  const q = (x) => (n ? +s[Math.min(n - 1, Math.floor(x * n))].toFixed(2) : null);
  const mean = (a) => (a && a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null);
  const rj = p ? [...p.cols.ms].sort((a, b) => a - b) : [];
  return {
    knob: o.knob, value: o.value, read: k.get(), pose: o.pose, orbit: o.pose === "orbit" ? { az: orb.az, degPerSec: orb.degPerSec } : null, ms: o.ms, frames: n,
    fps: n ? +(n / (d.reduce((a, x) => a + x, 0) / 1000)).toFixed(1) : null, p50: q(0.5), p95: q(0.95), p99: q(0.99),
    renderJsP50: rj.length ? +rj[rj.length >> 1].toFixed(2) : null, calls: p ? mean(p.cols.calls) : null,
    relinkedInSettle: progs1 !== progs0 || (al0 !== null && al1 !== al0), relinked: progs2 !== progs1 || (al1 !== null && al2 !== al1),
    programs: [progs0, progs1, progs2], asyncCompiled: [al0, al1, al2],
  };
}

/** An arm's gate expression (indirect eval, global scope) -> true / false / "throw: <message>". */
export function pageGateValue(expr) {
  try { return !!(0, eval)(expr); } catch (e) { return `throw: ${e && e.message}`; }
}

/** An arm's gateInfo expression -> its JSON-cloned value (or "throw: <message>"). */
export function pageGateInfo(expr) {
  try { const v = (0, eval)(expr); return v === undefined ? null : JSON.parse(JSON.stringify(v)); } catch (e) { return `throw: ${e && e.message}`; }
}

/**
 * window.__hbOrbit for the orbit pose: kept when a booting tool set it ({source: "page"}), else set
 * from the player pose exactly as hbbench.mjs does (70 m out, az 45, el 22, `o.degPerSec`) and
 * reported as {source: "set"}; {error} when there is no camera API.
 */
export function pageEnsureOrbit(o) {
  const W = window;
  if (W.__hbOrbit) return { source: "page", orbit: W.__hbOrbit };
  if (!W.__cam || typeof W.__cam.world !== "function") return { error: "no window.__cam (camDebug=on?)" };
  const p = W.__cam.world();
  const orbit = { x: p.x, y: p.y, z: p.z + 1.5, dist: 70, az: 45, el: 22, degPerSec: (o && o.degPerSec) || 18 };
  W.__hbOrbit = orbit;
  W.__cam.orbit(orbit.x, orbit.y, orbit.z, orbit.dist, orbit.az, orbit.el);
  return { source: "set", orbit };
}
