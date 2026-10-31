// drawlist-census.eval.js — page-side body of an async fn (`node hbsess.mjs eval drawlist-census.eval.js`),
// 2026-10-26, for the stage-3 draw-list design (apps/holtburger-web/docs/2026-10-26-rust-draw-list-design.md §7).
// Not run yet: written on the laptop (no browser allowed there), for the next owner-run 1070 session.
//
// WHAT IT MEASURES, per draw KIND (pool / chunk bucket / atlas / building / cell static / terrain / entity
// part / particle / ...), per render PASS (the world pass vs everything else):
//   * draws/frame, BatchedMesh ranges/frame, the share of BatchedMesh draws on three's early-out;
//   * program switches, material switches and CONTINUATIONS (same program + material + camera as the draw
//     before) — the executor's fast path only exists for continuations;
//   * "record stability": the share of draws whose (program, material.version, geometry position/index
//     versions, BatchedMesh texture versions) equal the same object's previous-frame draw — the executor's
//     record hit rate on a settled frame;
//   * GL calls per draw by type (useProgram, bindVertexArray, activeTexture+bindTexture, uniform*,
//     uniformMatrix*, texture uploads, state calls, draw calls) — the floor any executor still pays;
//   * visible scene-graph nodes by owner group (an upper bound on projectObject visits).
// AND, in phase "install", it leaves TAGGED renderBufferDirect wrappers in place — one distinctly NAMED
// function per kind (`rbd_pool_opaque`, ...) — so a CPU profile taken meanwhile attributes three's per-draw
// time (setProgram, upload, setup, GL) to the kind: `node hbsess.mjs profile 8 OUT.cpuprofile` then
// `python3 -I drawlist_kind_split.py OUT.cpuprofile FPS`.
//
// Phases (window.__dlcPhase, default "all"; prepend e.g. `window.__dlcPhase="install";` to a copy):
//   "all"     install, hold __dlcFrames frames with the counters, uninstall, return the census JSON
//   "install" install the tagged wrappers only (cheap: one WeakMap lookup per draw) and return
//   "finish"  (after "install") hold the counters for __dlcFrames frames, uninstall everything, return JSON
//   "inject"  (CrGpuMain per-command cost, for the UBO decision) install, then after every real draw of a STATIC
//             kind in the world pass re-issue K redundant GL commands that change no state:
//             window.__dlcInjectSpec = { mode: "uniformM4" | "uniformM4dirty" | "vao" | "useProgram", perDraw: 4 }
//             (default uniformM4 x4: re-send the program's current modelViewMatrix value — prices the command
//             itself; whether ANGLE then re-uploads the default uniform block for an UNCHANGED value is not known.
//             "uniformM4dirty" sends a different matrix then the current one back (2 commands per injection, the
//             value the next draw sees is unchanged, so no pixel moves) — the block is dirty either way, so it also
//             prices ANGLE's per-draw default-block re-upload). Toggle live between gputrace runs with
//             `window.__dlcState.inject.mode = "off"` / `"uniformM4"`; `window.__dlcState.injected` counts calls.
//             Per-command cost = delta(WEBGL ms/present, gpu_thread_split.py) / injected calls per present.
//   "abort"   uninstall whatever is installed
// Knobs: window.__dlcFrames (240), window.__dlcOrbit (default true: orbit at window.__hbOrbit as hbsess sets it;
// false: still camera). The GL counters cost ~one increment per GL call: do NOT read fps/ms from the "all" or
// "finish" phases — time comes from the profile of the "install" phase (or from hbbench with this file unused).
// Wraps renderer.renderBufferDirect OUTSIDE every other wrapper (batched_runs, skip_empty, async_link), so a
// draw skipped by those (empty multidraw, deferred link) still counts as a submitted item, reported apart
// (`skippedByChain`). Never throws into a draw; every wrapper is restored by "finish"/"abort".

const L = window.liveScene3d, R = L && L.renderer;
if (!R) return { error: "no liveScene3d.renderer" };
const phase = window.__dlcPhase || "all";
const FRAMES = window.__dlcFrames || 240;
const ORBIT = window.__dlcOrbit !== false;
const gl = R.getContext();
const props = R.properties;
const ST = window.__dlcState || (window.__dlcState = { installed: false, counting: false });

function uninstall() {
  if (ST.rbdOrig && R.renderBufferDirect === ST.rbdTop) R.renderBufferDirect = ST.rbdOrig;
  else if (ST.rbdOrig) ST.rbdBroken = true; // someone wrapped over us: leave the chain, report it
  if (ST.renderOrig && R.render === ST.renderTop) R.render = ST.renderOrig;
  // Restore only our own wrappers: if something wrapped over one of them since, leave it (and report it) rather
  // than deleting a wrapper that is not ours.
  if (ST.glOrig) for (const [n, f, mine] of ST.glOrig) {
    if (gl[n] !== mine) { ST.glBroken = (ST.glBroken || 0) + 1; continue; }
    try { delete gl[n]; if (gl[n] !== f) gl[n] = f; } catch (_) { gl[n] = f; }
  }
  if (ST.extOrig) for (const [n, f, mine] of ST.extOrig) { if (ST.ext[n] === mine) ST.ext[n] = f; else ST.glBroken = (ST.glBroken || 0) + 1; }
  if (ST.vaoOrig) {
    if (gl.bindVertexArray === ST.vaoMine) { try { delete gl.bindVertexArray; } catch (_) { gl.bindVertexArray = ST.vaoOrig; } }
    else ST.glBroken = (ST.glBroken || 0) + 1;
    ST.vaoOrig = null; ST.vaoMine = null;
  }
  ST.inject = null; ST.afterDraw = undefined;
  ST.glOrig = null; ST.extOrig = null; ST.installed = false; ST.counting = false;
}
if (phase === "abort") { uninstall(); return { aborted: true }; }

// ---------------------------------------------------------------------------------------------- kinds
const GROUPS = [["terrain", L.terrainGroup], ["buildings", L.buildingsGroup], ["statics", L.staticsGroup],
  ["cells", L.cellsGroup], ["entities", L.entitiesGroup], ["lights", L.lightsGroup], ["world", L.worldRoot]];
function ownerOf(o) {
  for (let q = o; q; q = q.parent) {
    for (const [name, g] of GROUPS) if (g && q === g) return name;
    if (q === L.scene) return "scene";
  }
  return "detached";
}
const KINDS = ["pool_opaque", "pool_sorted", "pool_cell", "bucket_unsorted", "bucket_sorted", "atlas", "building_batch",
  "building_mesh", "cellstatic", "cell_surface", "static_mesh", "static_lod_child", "terrain_batch", "terrain_other",
  "far_terrain", "grass", "anim_inst", "entity_part", "entity_other", "particle", "nameplate", "decal", "occlusion",
  "world_other", "scene_other", "other_scene"];
const kindMemo = new WeakMap();
function kindOf(o, scene) {
  if (scene !== L.scene) return "other_scene";
  let k = kindMemo.get(o);
  if (k !== undefined) return k;
  const n = o.name || "", ud = o.userData || {}, own = ownerOf(o);
  if (ud.__drawPool) k = ud.domain === "ec" ? "pool_cell" : (o.sortObjects ? "pool_sorted" : "pool_opaque");
  else if (n.startsWith("static-batch") || ud.__staticBatch || ud.__staticBatchCrossLb) k = o.sortObjects ? "bucket_sorted" : "bucket_unsorted";
  else if (n.startsWith("stat-atlas")) k = "atlas";
  else if (n.startsWith("building-batch")) k = "building_batch";
  else if (n.startsWith("terrain-batch")) k = "terrain_batch";
  else if (n.startsWith("far-patch")) k = "far_terrain";
  else if (n.startsWith("anim-inst")) k = "anim_inst";
  else if (n.startsWith("particle-inst")) k = "particle";
  else if (n.startsWith("nameplate") || n.startsWith("buff_badge")) k = "nameplate";
  else if (n === "blood-decals" || n.startsWith("fx-")) k = "decal";
  else if (o.material && (Array.isArray(o.material) ? o.material[0] : o.material)?.name === "terrain-grass") k = "grass";
  else if (o.parent && o.parent.name === "occlusion-proxies") k = "occlusion";
  else if (own === "cells") k = (n.startsWith("cellstatic") || ud.isCellStatic) ? "cellstatic" : "cell_surface";
  else if (own === "buildings") k = "building_mesh";
  else if (own === "statics") k = (o.parent && o.parent.isLOD) ? "static_lod_child" : "static_mesh";
  else if (own === "terrain") k = "terrain_other";
  else if (own === "entities") k = n.startsWith("part_") ? "entity_part" : (n.startsWith("entity-batch") ? "entity_batch" : "entity_other");
  else if (own === "world") k = "world_other";
  else k = "scene_other";
  kindMemo.set(o, k);
  return k;
}

// ------------------------------------------------------------------------------- tagged rbd wrappers
function install() {
  if (ST.installed) return;
  const inner = R.renderBufferDirect;
  ST.rbdOrig = inner;
  ST.cur = null;          // kind of the draw in flight (GL counters attribute to it)
  ST.pass = "other";      // current render() pass tag
  // One NAMED function per kind, so the CPU profile shows `rbd_<kind>` above three's frames
  // (V8 profiles name a function by its own name; a shared closure would merge every kind).
  ST.tagged = {};
  for (const k of KINDS) {
    // eslint-disable-next-line no-new-func
    ST.tagged[k] = new Function("inner", "ST", `return function rbd_${k}(c, s, g, m, o, gr) {
      const prev = ST.cur; ST.cur = "${k}";
      try { return inner.call(this, c, s, g, m, o, gr); } finally { ST.cur = prev; } };`)(inner, ST);
  }
  const top = function rbdDrawListCensus(camera, scene, geometry, material, object, group) {
    let k;
    try { k = object ? kindOf(object, scene) : "other_scene"; } catch (_) { k = "other_scene"; }
    if (ST.counting) { try { ST.onDraw(k, camera, scene, geometry, material, object, group); } catch (_) { ST.errors = (ST.errors || 0) + 1; } }
    const before = R.info.render.calls;
    const r = ST.tagged[k].call(this, camera, scene, geometry, material, object, group);
    const drew = R.info.render.calls !== before;
    if (ST.counting && !drew) ST.onSkipped(k);
    if (drew && ST.afterDraw !== undefined && ST.inject) { try { ST.afterDraw(k, material); } catch (_) { ST.errors = (ST.errors || 0) + 1; } }
    return r;
  };
  R.renderBufferDirect = top; ST.rbdTop = top;
  const renderOrig = R.render;
  ST.renderOrig = renderOrig;
  const renderTop = function renderDrawListCensus(scene, camera) {
    const prevPass = ST.pass;
    if (scene === L.scene) {
      const first = ST.passInFrame++ === 0;
      ST.pass = first ? "world" : "world2";
      if (first && ST.counting) ST.worldFrames = (ST.worldFrames || 0) + 1;
    }
    else ST.pass = "other";
    try { return renderOrig.apply(this, arguments); } finally { ST.pass = prevPass; }
  };
  R.render = renderTop; ST.renderTop = renderTop;
  ST.passInFrame = 0;
  ST.installed = true;
  // Keep the per-frame pass tag right while installed without a hold() (profile / inject phases).
  const tick = () => { if (!ST.installed) return; ST.passInFrame = 0; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
const STATIC_KINDS = new Set(["pool_opaque", "pool_sorted", "pool_cell", "bucket_unsorted", "bucket_sorted", "atlas",
  "building_batch", "building_mesh", "cellstatic", "cell_surface", "static_mesh", "static_lod_child", "terrain_batch",
  "terrain_other", "far_terrain"]);
function armInject(spec) {
  ST.inject = { mode: (spec && spec.mode) || "uniformM4", perDraw: Math.max(1, Math.min(64, (spec && spec.perDraw) | 0 || 4)) };
  ST.injected = 0;
  if (!ST.vaoOrig) {
    const P = WebGL2RenderingContext.prototype;
    if (!Object.prototype.hasOwnProperty.call(gl, "bindVertexArray")) {
      ST.vaoOrig = P.bindVertexArray;
      ST.vaoMine = function (v) { ST.lastVao = v; return ST.vaoOrig.call(this, v); };
      gl.bindVertexArray = ST.vaoMine;
    }
  }
  ST.m4 = ST.m4 || new Float32Array(16);
  ST.afterDraw = (k, material) => {
    const I = ST.inject;
    if (!I || I.mode === "off" || ST.pass !== "world" || !STATIC_KINDS.has(k)) return;
    const mp = props.get(material), prog = mp && mp.currentProgram;
    if (!prog) return;
    const n = I.perDraw;
    if (I.mode === "uniformM4" || I.mode === "uniformM4dirty") {
      const u = prog.getUniforms().map.modelViewMatrix;
      if (!u || !u.cache || u.cache.length !== 16) return;
      ST.m4.set(u.cache);
      if (I.mode === "uniformM4dirty") {
        ST.m4alt = ST.m4alt || new Float32Array(16);
        ST.m4alt.set(ST.m4); ST.m4alt[15] = ST.m4[15] + 1; // any different value; restored right after
        for (let i = 0; i < n; i++) { gl.uniformMatrix4fv(u.addr, false, ST.m4alt); gl.uniformMatrix4fv(u.addr, false, ST.m4); }
        ST.injected += n; // two commands per injection: count both
      } else {
        for (let i = 0; i < n; i++) gl.uniformMatrix4fv(u.addr, false, ST.m4);
      }
    } else if (I.mode === "vao") {
      if (ST.lastVao === undefined) return;
      for (let i = 0; i < n; i++) gl.bindVertexArray(ST.lastVao);
    } else if (I.mode === "useProgram") {
      for (let i = 0; i < n; i++) gl.useProgram(prog.program);
    } else return;
    ST.injected += n;
  };
}

// ------------------------------------------------------------------------------------- the counters
function startCounting() {
  const C = ST.C = { byPass: {}, frames: 0 };
  ST.worldFrames = 0;
  const row = (pass, k) => {
    const P = C.byPass[pass] || (C.byPass[pass] = {});
    return P[k] || (P[k] = { draws: 0, skippedByChain: 0, ranges: 0, batched: 0, earlyOut: 0, ownHook: 0,
      progSwitch: 0, matSwitch: 0, cont: 0, stable: 0, recSeen: 0, transparent: 0, gl: {} });
  };
  const last = { prog: null, mat: null, cam: null, pass: null };
  const recs = new WeakMap(); // object -> signature of its last draw
  const texVer = (t) => (t ? t.version : -1);
  ST.onDraw = (k, camera, scene, geometry, material, object) => {
    const r = row(ST.pass, k);
    r.draws++;
    if (material && material.transparent) r.transparent++;
    if (object && object.isBatchedMesh) {
      r.batched++;
      r.ranges += object._multiDrawCount | 0;
      if (object._visibilityChanged === false && object.perObjectFrustumCulled === false && object.sortObjects === false) r.earlyOut++;
    }
    if (object && Object.prototype.hasOwnProperty.call(object, "onBeforeRender")) r.ownHook++;
    const mp = material ? props.get(material) : null;
    const prog = mp ? mp.currentProgram : null;
    if (prog !== last.prog || camera !== last.cam || ST.pass !== last.pass) r.progSwitch++;
    else if (material !== last.mat) r.matSwitch++;
    else r.cont++;
    last.prog = prog; last.mat = material; last.cam = camera; last.pass = ST.pass;
    // record stability vs this object's previous draw (one record per object; multi-material objects
    // alternate and read unstable — counted as such, conservatively)
    if (object && geometry && material) {
      const pos = geometry.attributes && geometry.attributes.position;
      const sig = `${prog ? prog.id : -1}|${material.id}|${material.version}|${geometry.id}|${pos ? pos.version : -1}|${geometry.index ? geometry.index.version : -1}|${object.isBatchedMesh ? texVer(object._matricesTexture) + ":" + texVer(object._indirectTexture) + ":" + texVer(object._colorsTexture) : ""}|${material.map ? texVer(material.map) : -1}`;
      const prev = recs.get(object);
      if (prev !== undefined) { r.recSeen++; if (prev === sig) r.stable++; }
      recs.set(object, sig);
    }
  };
  ST.onSkipped = (k) => { row(ST.pass, k).skippedByChain++; };
  // GL counters: one increment per call, attributed to the kind of the draw in flight (or "outside").
  const CAT = (n) => (n === "useProgram" ? "useProgram"
    : n === "bindVertexArray" ? "bindVertexArray"
      : n === "bindTexture" || n === "activeTexture" ? "texBind"
        : n.startsWith("uniformMatrix") ? "uniformMatrix"
          : n.startsWith("uniform") ? "uniform"
            : /^(tex|compressedTex)(Sub)?Image/.test(n) || n === "generateMipmap" ? "texUpload"
              : n === "bufferSubData" || n === "bufferData" ? "bufferUpload"
                : n === "bindBufferBase" || n === "bindBufferRange" || n === "bindBuffer" ? "bufferBind"
                  : /^draw/.test(n) ? "draw"
                    : "state");
  const NAMES = ["useProgram", "bindVertexArray", "bindTexture", "activeTexture", "uniform1f", "uniform2f", "uniform3f", "uniform4f",
    "uniform1i", "uniform2i", "uniform1fv", "uniform2fv", "uniform3fv", "uniform4fv", "uniform1iv", "uniformMatrix3fv", "uniformMatrix4fv",
    "uniformMatrix2fv", "texImage2D", "texSubImage2D", "texImage3D", "texSubImage3D", "compressedTexImage2D", "compressedTexSubImage2D",
    "compressedTexSubImage3D", "generateMipmap", "bufferSubData", "bufferData", "bindBuffer", "bindBufferBase", "bindBufferRange",
    "drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "enable", "disable", "depthFunc", "depthMask",
    "blendFuncSeparate", "blendEquationSeparate", "frontFace", "cullFace", "polygonOffset", "colorMask", "stencilFunc", "stencilOp",
    "stencilMask", "beginQuery", "endQuery", "bindFramebuffer", "viewport", "scissor"];
  ST.glOrig = [];
  const P = WebGL2RenderingContext.prototype;
  for (const n of NAMES) {
    const orig = P[n];
    if (typeof orig !== "function" || Object.prototype.hasOwnProperty.call(gl, n)) continue; // never stack on an own wrapper
    const cat = CAT(n);
    const mine = function () {
      const k = ST.cur || "outside";
      const r = row(ST.pass, k);
      r.gl[cat] = (r.gl[cat] || 0) + 1;
      return orig.apply(this, arguments);
    };
    gl[n] = mine;
    ST.glOrig.push([n, orig, mine]);
  }
  const ext = gl.getExtension("WEBGL_multi_draw");
  ST.ext = ext; ST.extOrig = [];
  if (ext) {
    for (const n of ["multiDrawArraysWEBGL", "multiDrawElementsWEBGL", "multiDrawArraysInstancedWEBGL", "multiDrawElementsInstancedWEBGL"]) {
      const orig = ext[n];
      if (typeof orig !== "function") continue;
      const mine = function () { const r = row(ST.pass, ST.cur || "outside"); r.gl.multiDraw = (r.gl.multiDraw || 0) + 1; return orig.apply(this, arguments); };
      ext[n] = mine;
      ST.extOrig.push([n, orig, mine]);
    }
  }
  ST.counting = true;
}

function visibleNodesByOwner() {
  const out = {};
  const walk = (o, owner) => {
    if (o.visible === false) return;
    let own = owner;
    for (const [name, g] of GROUPS) if (g && o === g) own = name;
    const e = out[own] || (out[own] = { nodes: 0, drawables: 0, batched: 0, lod: 0 });
    e.nodes++;
    if (o.isMesh || o.isLine || o.isPoints || o.isSprite) e.drawables++;
    if (o.isBatchedMesh) e.batched++;
    if (o.isLOD) e.lod++;
    const ch = o.children;
    for (let i = 0; i < ch.length; i++) walk(ch[i], own);
  };
  walk(L.scene, "scene");
  return out;
}

async function hold(n) {
  const o = window.__hbOrbit;
  const t0 = performance.now();
  let frames = 0;
  await new Promise((res) => {
    const f = (now) => {
      ST.passInFrame = 0;
      if (ORBIT && o && window.__cam) window.__cam.orbit(o.x, o.y, o.z, o.dist, o.az + (now - t0) / 1000 * o.degPerSec, o.el);
      if (frames++ >= n || now - t0 > 60000) return res();
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  return { frames: frames - 1, ms: performance.now() - t0 };
}

function report(held) {
  // Per-frame = per WORLD pass (the first main-scene render() of each rAF), not per hold callback.
  const f = Math.max(1, ST.worldFrames || held.frames);
  const per = (x) => +(x / f).toFixed(2);
  const out = { frames: held.frames, worldFrames: ST.worldFrames || 0, fpsUnderCounters: +(held.frames / (held.ms / 1000)).toFixed(1), passes: {} };
  for (const [pass, rows] of Object.entries(ST.C.byPass)) {
    const P = out.passes[pass] = { kinds: {}, total: { draws: 0, glCalls: 0 } };
    for (const [k, r] of Object.entries(rows)) {
      const glc = Object.values(r.gl).reduce((a, b) => a + b, 0);
      P.total.draws += r.draws; P.total.glCalls += glc;
      P.kinds[k] = {
        draws: per(r.draws), skippedByChain: per(r.skippedByChain), transparent: per(r.transparent),
        batched: per(r.batched), ranges: per(r.ranges), earlyOutShare: r.batched ? +(r.earlyOut / r.batched).toFixed(3) : null,
        ownHookShare: r.draws ? +(r.ownHook / r.draws).toFixed(3) : null,
        progSwitch: per(r.progSwitch), matSwitch: per(r.matSwitch), cont: per(r.cont),
        stableShare: r.recSeen ? +(r.stable / r.recSeen).toFixed(3) : null,
        glPerFrame: Object.fromEntries(Object.entries(r.gl).map(([c, v]) => [c, per(v)])),
        glPerDraw: r.draws ? +(glc / r.draws).toFixed(2) : null,
      };
    }
    P.total.draws = per(P.total.draws); P.total.glCalls = per(P.total.glCalls);
  }
  out.visibleNodes = visibleNodesByOwner();
  out.renderInfo = { programs: R.info.programs ? R.info.programs.length : null };
  out.flags = location.search;
  out.errors = ST.errors || 0;
  out.rbdBroken = !!ST.rbdBroken;
  out.glBroken = ST.glBroken || 0;
  return out;
}

if (phase === "inject") { install(); armInject(window.__dlcInjectSpec); return { inject: ST.inject, note: "toggle window.__dlcState.inject.mode between gputrace runs; window.__dlcPhase=\"abort\" to remove" }; }
if (phase === "install") { install(); return { installed: true, kinds: KINDS.length, note: "now: node hbsess.mjs profile 8 OUT.cpuprofile; then eval with window.__dlcPhase=\"finish\"" }; }
if (phase === "all" || phase === "finish") {
  install();
  startCounting();
  let held;
  try { held = await hold(FRAMES); } finally { ST.counting = false; }
  const out = report(held);
  uninstall();
  return out;
}
return { error: `unknown phase ${phase}` };
