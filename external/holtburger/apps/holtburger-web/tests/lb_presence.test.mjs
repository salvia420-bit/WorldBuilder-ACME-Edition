// 2026-11-01 — ?lbFade (scene3d/lb_presence.js): the per-landblock presence field of the flight-experience
// Phase 1. The state machine (snap on first sight, timed fades, instant terrain drop, fade-out completion
// callbacks, window relayout), the chunk patch (idempotent, fail-closed, three r184's real chunks) and the
// material helper (define + shared uniforms + chained hooks).
//
// Run:
//   cd apps/holtburger-web/
//   node tests/lb_presence.test.mjs

import * as THREE from "three";
import {
  LbPresence, CH_OBJ, CH_TER, FADE_IN_MS, FADE_OUT_MS, lbFadeEnabled, lbKeyXY, patchLbFadeChunks,
  LB_FADE_DEFINE, __setLbFadeForTest, __setObjFadeForTest, objFadeEnabled, installLbFadeChunks, applyLbFade, lbFadeState, tickLbPresence,
  getLbPresence, lbFadeUniforms, flushLbPresence, noteObjectsAttached, objectsAttached, ATTACH_WAIT_MS,
} from "../scene3d/lb_presence.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

console.log("-- P1 flag grammar ---------------------------------------------------");
check("absent -> ON (implied by the default-ON ?flightView)", lbFadeEnabled("") === true && lbFadeEnabled("?x=1") === true);
check("absent + ?flightView=off -> OFF", lbFadeEnabled("?flightView=off") === false && lbFadeEnabled("?flightView=off&lbFade=on") === true);
check("on/1/true/yes -> ON", ["on", "1", "true", "yes", " ON "].every((v) => lbFadeEnabled(`?lbFade=${encodeURIComponent(v)}`)));
check("off/0/no/false -> OFF", ["off", "0", "no", "false"].every((v) => !lbFadeEnabled(`?lbFade=${v}`)));
check("garbage -> the ?flightView default", lbFadeEnabled("?lbFade=maybe") === true && lbFadeEnabled("?lbFade=maybe&flightView=off") === false);

console.log("-- P2 state machine ---------------------------------------------------");
{
  const p = new LbPresence();
  p.setCentre(100, 100);
  check("window origin centred (64 wide)", p.ox === 68 && p.oy === 68, `${p.ox},${p.oy}`);
  const k = lbKeyXY(101, 100);
  p.setTarget(k, CH_OBJ, 1, { snap: true });
  check("snap sets the value at once", p.value(k, CH_OBJ) === 1 && !p.fading(k));
  const k2 = lbKeyXY(104, 100);
  p.setTarget(k2, CH_OBJ, 0, { snap: true });
  p.setTarget(k2, CH_OBJ, 1);
  // advance in 16 ms frames (one tick is clamped to 250 ms so a hitch never jumps a fade)
  let now = 0;
  const run = (ms) => { const end = now + ms; p.tick(now); while (now < end) { now = Math.min(end, now + 16); p.tick(now); } };
  p.tick(0);
  run(FADE_IN_MS / 2);
  check("fade in: half way at half the time", near(p.value(k2, CH_OBJ), 0.5, 0.03), String(p.value(k2, CH_OBJ)));
  run(FADE_IN_MS);
  check("fade in completes", p.value(k2, CH_OBJ) === 1 && !p.fading(k2));
  const done = [];
  p.onFadeOutDone((key, ch) => done.push([key, ch]));
  p.setTarget(k2, CH_OBJ, 0);
  run(FADE_OUT_MS / 2);
  check("fade out: half way", near(p.value(k2, CH_OBJ), 0.5, 0.04) && done.length === 0, String(p.value(k2, CH_OBJ)));
  // a cancel mid-fade turns around from the current value
  const mid = p.value(k2, CH_OBJ);
  p.setTarget(k2, CH_OBJ, 1);
  check("cancel counted", p.stats.cancels === 1);
  run(100);
  check("turned around from mid-fade upward", p.value(k2, CH_OBJ) > mid);
  p.setTarget(k2, CH_OBJ, 0);
  run(FADE_OUT_MS * 2);
  check("fade out completes and fires the callback once", p.value(k2, CH_OBJ) === 0 && done.length === 1 && done[0][0] === k2 && done[0][1] === CH_OBJ, JSON.stringify(done));
  // terrain drops instantly, rises with the fade
  const k3 = lbKeyXY(99, 99);
  p.setTarget(k3, CH_TER, 1, { snap: true });
  p.setTarget(k3, CH_TER, 0);
  run(16);
  check("terrain presence drops in one tick", p.value(k3, CH_TER) === 0);
  // texture bytes: R = object, G = terrain, at (x - ox, y - oy)
  const i = ((100 - p.oy) * p.win + (101 - p.ox)) * 2;
  check("bytes carry the object value", p.bytes[i] === 255, String(p.bytes[i]));
  const i3 = ((99 - p.oy) * p.win + (99 - p.ox)) * 2;
  check("bytes carry the terrain value", p.bytes[i3 + 1] === 0, String(p.bytes[i3 + 1]));
  check("untouched landblocks: objects absent (R 0 — impostors draw), near terrain absent (G 0 — the far ring draws)", p.bytes[0] === 0 && p.bytes[1] === 0);
  // recentre: small drift keeps the layout, a big one relays it out with the values preserved
  check("small drift keeps the window", p.setCentre(105, 100) === false);
  check("big drift relays out", p.setCentre(120, 100) === true && p.ox === 88);
  const j = ((100 - p.oy) * p.win + (101 - p.ox)) * 2;
  check("values survive the relayout", p.bytes[j] === 255 && p.value(k, CH_OBJ) === 1);
  check("window clamps at the map edge", (() => { const q = new LbPresence(); q.setCentre(2, 250); return q.ox === 0 && q.oy === 192; })());
}

console.log("-- P3 the frame driver ------------------------------------------------");
{
  __setLbFadeForTest(true);
  const p = getLbPresence();
  const objs = new Set([lbKeyXY(50, 50), lbKeyXY(51, 50)]);
  const ter = new Set([lbKeyXY(50, 50), lbKeyXY(51, 50), lbKeyXY(52, 50)]);
  const drive = (now) => tickLbPresence({ centreLb: lbKeyXY(50, 50), nowMs: now, objWanted: (k) => objs.has(k), terDrawn: (k) => ter.has(k) });
  drive(1000);
  check("first sight snaps drawn objects on", p.value(lbKeyXY(51, 50), CH_OBJ) === 1);
  check("first sight of an empty landblock is 0", p.value(lbKeyXY(52, 50), CH_OBJ) === 0 && p.value(lbKeyXY(52, 50), CH_TER) === 1);
  objs.add(lbKeyXY(52, 50)); // its statics bake lands
  drive(1100); drive(1100 + FADE_IN_MS / 2);
  const v = p.value(lbKeyXY(52, 50), CH_OBJ);
  check("a late bake fades in (not a pop)", v > 0.3 && v < 0.8, String(v));
  objs.delete(lbKeyXY(51, 50)); // the window wants it hidden
  drive(1100 + FADE_IN_MS / 2 + 100);
  check("a hide fades out", p.value(lbKeyXY(51, 50), CH_OBJ) < 1 && p.value(lbKeyXY(51, 50), CH_OBJ) > 0);
  __setLbFadeForTest(undefined);
}

console.log("-- P3b objects attached (not merely baked) -------------------------------");
{
  const sc = { staticsBakedLbs: new Set(), buildingsBakedLbs: new Set() };
  const k = lbKeyXY(70, 70);
  sc.staticsBakedLbs.add(k); sc.buildingsBakedLbs.add(k);
  check("baked marks alone are not attached", objectsAttached(sc, k, 0) === false);
  noteObjectsAttached(sc, k, "s");
  const t1 = sc._objAttach.get(k).s;
  check("one kind attached: wait for the other", objectsAttached(sc, k, t1 + 10) === false);
  check("...but not forever (the other is late or failed)", objectsAttached(sc, k, t1 + ATTACH_WAIT_MS + 1) === true);
  noteObjectsAttached(sc, k, "b");
  check("both attached", objectsAttached(sc, k, t1 + 11) === true);
  sc.staticsBakedLbs.delete(k); sc.buildingsBakedLbs.delete(k);
  check("evicted (marks gone): false and the entry is dropped", objectsAttached(sc, k, t1 + 12) === false && !sc._objAttach.has(k));
}

console.log("-- P4 chunk patch on three r184's real chunks ---------------------------");
{
  const src = { common: THREE.ShaderChunk.common, project_vertex: THREE.ShaderChunk.project_vertex, clipping_planes_fragment: THREE.ShaderChunk.clipping_planes_fragment };
  const a = patchLbFadeChunks(src);
  const b = patchLbFadeChunks(a);
  check("idempotent", a.common === b.common && a.project_vertex === b.project_vertex && a.clipping_planes_fragment === b.clipping_planes_fragment);
  check("everything sits behind the define", [a.common, a.project_vertex, a.clipping_planes_fragment].every((c) => c.includes(`#ifdef ${LB_FADE_DEFINE}`)));
  check("stock text kept verbatim", a.common.startsWith(src.common) && a.project_vertex.startsWith(src.project_vertex) && a.clipping_planes_fragment.endsWith(src.clipping_planes_fragment));
  check("no backticks in the GLSL", ![a.common, a.project_vertex, a.clipping_planes_fragment].some((c) => c.includes("`")));
  let threw = false;
  try { patchLbFadeChunks({ common: "", project_vertex: "x" }); } catch (_) { threw = true; }
  check("missing chunk -> throws (fail closed)", threw);
  // the vertex chunk only uses names three's stock vertex shaders have in scope at project_vertex
  check("vertex code uses transformed / modelMatrix / batchingMatrix / instanceMatrix",
    /transformed/.test(a.project_vertex) && /modelMatrix \* hbO/.test(a.project_vertex) && /batchingMatrix \* hbO/.test(a.project_vertex));
}

console.log("-- P5 install + material helper ---------------------------------------");
{
  check("?objFade grammar: DEV opt-in", objFadeEnabled("") === false && objFadeEnabled("?objFade=on") === true && objFadeEnabled("?objFade=off") === false);
  __setLbFadeForTest(false);
  __setObjFadeForTest(false);
  const before = THREE.ShaderChunk.common;
  check("flag off: install is a no-op", installLbFadeChunks(THREE) === false && THREE.ShaderChunk.common === before);
  const m0 = new THREE.MeshStandardMaterial();
  applyLbFade(m0, THREE);
  check("flag off: material untouched", !m0.defines?.[LB_FADE_DEFINE] && m0.userData.__hbLbFade !== true);
  __setLbFadeForTest(true);
  __setObjFadeForTest(true);
  const saved = { common: THREE.ShaderChunk.common, project_vertex: THREE.ShaderChunk.project_vertex, clipping_planes_fragment: THREE.ShaderChunk.clipping_planes_fragment };
  check("flag on: install patches the chunks", installLbFadeChunks(THREE) === true && lbFadeState.installed && THREE.ShaderChunk.common.includes(LB_FADE_DEFINE));
  const m = new THREE.MeshStandardMaterial();
  let prevRan = 0;
  m.onBeforeCompile = () => { prevRan += 1; };
  m.customProgramCacheKey = () => "orig";
  applyLbFade(m, THREE);
  applyLbFade(m, THREE); // idempotent
  check("define set", m.defines[LB_FADE_DEFINE] === "");
  const shader = { uniforms: {}, vertexShader: "", fragmentShader: "" };
  m.onBeforeCompile(shader, null);
  check("chained onBeforeCompile ran once and added the shared uniforms",
    prevRan === 1 && shader.uniforms.hbLbPresence === lbFadeUniforms(THREE).hbLbPresence && shader.uniforms.hbLbPresenceOrigin === lbFadeUniforms(THREE).hbLbPresenceOrigin);
  check("cache key untouched (the define keys the program)", m.customProgramCacheKey() === "orig");
  // a later chain (materials.js _chainBeforeCompile style) keeps the injection: it wraps the faded hook
  const prevHook = m.onBeforeCompile;
  let chainRan = 0;
  m.onBeforeCompile = function (sh, r) { prevHook.call(this, sh, r); chainRan += 1; };
  const sh3 = { uniforms: {} };
  m.onBeforeCompile(sh3, null);
  check("a later chain runs the original hook, the injection and its own step", chainRan === 1 && prevRan === 2 && sh3.uniforms.hbLbFadeOn);
  // a clone can be faded on its own
  const mc = m.clone();
  applyLbFade(mc, THREE);
  check("a clone gets its own fade", mc.defines[LB_FADE_DEFINE] === "");
  const m2 = new THREE.MeshLambertMaterial();
  applyLbFade(m2, THREE);
  check("a second material shares the same uniform objects", (() => { const s2 = { uniforms: {} }; m2.onBeforeCompile(s2, null); return s2.uniforms.hbLbPresence === shader.uniforms.hbLbPresence; })());
  const tex = lbFadeUniforms(THREE).hbLbPresence.value;
  check("texture: RG8 64x64, nearest, no mips", tex.image.width === 64 && tex.format === THREE.RGFormat && tex.minFilter === THREE.NearestFilter && tex.generateMipmaps === false);
  const v0 = tex.version;
  getLbPresence().dirty = true;
  check("flush bumps the texture version only when dirty", flushLbPresence() === true && tex.version === v0 + 1 && flushLbPresence() === false);
  Object.assign(THREE.ShaderChunk, saved);
  __setLbFadeForTest(undefined);
  __setObjFadeForTest(undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
