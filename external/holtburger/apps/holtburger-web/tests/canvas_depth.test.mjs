// 2026-10-19 — ?canvasDepth (scene3d/canvas_depth.js): `=off` creates the WebGL
// context without a depth buffer (pmndrs' recommended renderer setting); the two
// things that draw 3D straight to the canvas — the direct path and the portal
// tunnel — then draw through an offscreen target and present it.
//
// Run:
//   cd apps/holtburger-web/
//   node tests/canvas_depth.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const THREE = await import("three");
const C = await import("../scene3d/canvas_depth.js");
const Z = await import("../scene3d/shader_logdepth.js");

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const src = (rel) => readFileSync(path.join(APP, rel), "utf8");

console.log("-- C1 flag reader + decision ---------------------------------------------");
{
  const R = C.canvasDepthOffRequested;
  check("absent / on / garbage -> depth kept", R("") === false && R("?canvasDepth=on") === false && R("?canvasDepth=maybe") === false);
  check("off / 0 / false / no (any case) -> drop it", ["off", "OFF", "0", "false", "no"].every((v) => R(`?canvasDepth=${v}`) === true));
  const D = C.resolveCanvasDepth;
  check("default: depth true", D({}).depth === true && D({}).requestedOff === false && D({}).reason === "default");
  check("=off: depth false", D({ search: "?canvasDepth=off" }).depth === false && D({ search: "?canvasDepth=off" }).requestedOff === true);
  check("=off refused under ?wireframe=1 (the world draws to the canvas every frame)",
    D({ search: "?canvasDepth=off", wireframe: true }).depth === true && /wireframe/.test(D({ search: "?canvasDepth=off", wireframe: true }).reason));
  check("=off refused under ?canvasMsaa=on", D({ search: "?canvasDepth=off", canvasMsaa: true }).depth === true);
  check("the probe asks for the same depth attribute three will",
    Z.threeContextAttributes().depth === true && Z.threeContextAttributes({ depth: false }).depth === false &&
    Z.threeContextAttributes({ antialias: true, depth: true }).antialias === true);
}

function fakeRenderer({ depth = true, size = [800, 600] } = {}) {
  const calls = [];
  let target = null;
  const gl = { getContextAttributes: () => ({ depth }) };
  const r = {
    autoClear: true,
    calls,
    size,
    getContext: () => gl,
    getDrawingBufferSize: (v) => v.set(r.size[0], r.size[1]),
    getRenderTarget: () => target,
    setRenderTarget: (t) => { target = t; calls.push(["setRenderTarget", t]); },
    render: (scene, cam) => { calls.push(["render", scene, cam, target, r.autoClear, scene.children[0]?.material?.map]); },
  };
  return r;
}

console.log("-- C2 screenTarget --------------------------------------------------------");
{
  const withDepth = fakeRenderer({ depth: true });
  check("canvas with depth -> null (draw to the canvas, as today)", C.screenTarget(withDepth) === null);
  const r = fakeRenderer({ depth: false, size: [800, 600] });
  const t = C.screenTarget(r);
  check("no canvas depth -> an offscreen target at the drawing-buffer size",
    t && t.isRenderTarget === true && t.width === 800 && t.height === 600 && t.depthBuffer === true);
  check("…HalfFloat colour (linear, like the composer's buffers), float depth texture",
    t.texture.type === THREE.HalfFloatType && t.depthTexture && t.depthTexture.isDepthTexture === true && t.depthTexture.type === THREE.FloatType);
  check("the same target next frame", C.screenTarget(r) === t);
  r.size = [1024, 512];
  const t2 = C.screenTarget(r);
  check("resized with the drawing buffer (adaptive render scale / window resize)", t2 === t && t.width === 1024 && t.height === 512);
  check("no context -> null, never throws", C.screenTarget({}) === null && C.screenTarget(null) === null);
}

console.log("-- C3 presentScreenTarget -------------------------------------------------");
{
  const r = fakeRenderer({ depth: false });
  const t = C.screenTarget(r);
  r.setRenderTarget(t);
  r.autoClear = true;
  r.calls.length = 0;
  check("presents", C.presentScreenTarget(r, t) === true);
  const draw = r.calls.find((c) => c[0] === "render");
  check("one fullscreen draw to the canvas, sampling the target, no clear",
    draw && draw[3] === null && draw[4] === false && draw[5] === t.texture && r.calls.filter((c) => c[0] === "render").length === 1);
  const mat = draw[1].children[0].material;
  check("…opaque copy: no blending, no depth test or write, no fog (colour-space encode by three)",
    mat.blending === THREE.NoBlending && mat.depthTest === false && mat.depthWrite === false && mat.fog === false && mat.isMeshBasicMaterial === true);
  check("autoClear restored; the canvas stays bound (the target was the frame's)", r.autoClear === true && r.getRenderTarget() === null);
  const other = new THREE.WebGLRenderTarget(4, 4);
  r.setRenderTarget(other);
  C.presentScreenTarget(r, t);
  check("an unrelated bound target is restored", r.getRenderTarget() === other);
  check("nothing to present -> false", C.presentScreenTarget(r, null) === false);
}

console.log("-- C4 seam ---------------------------------------------------------------------");
{
  globalThis.window = {};
  const r = fakeRenderer({ depth: false });
  check("installs", C.installCanvasDepthSeam(r, C.resolveCanvasDepth({ search: "?canvasDepth=off" })) === true);
  check("reports the decision and the live context", window.__canvasDepth.requestedOff === true && window.__canvasDepth.depth === false &&
    typeof window.__canvasDepth.stats().redirects === "number");
  delete globalThis.window;
}

console.log("-- C5 wiring ----------------------------------------------------------------");
{
  const idx = src("scene3d/index.js");
  check("index.js decides before the context exists, with ?wireframe / ?canvasMsaa",
    /const _canvasDepth = resolveCanvasDepth\(\{\s*search: globalThis\.location\?\.search \|\| "",\s*wireframe: wireframeMode,\s*canvasMsaa: _canvasMsaa,\s*\}\);/.test(idx));
  check("…the reversed-Z probe creates the context with that depth attribute",
    /probeClipControl\(canvas, threeContextAttributes\(\{ antialias: _rendererAntialias, depth: _canvasDepth\.depth \}\)\)/.test(idx));
  check("…and both renderer constructions request it",
    (idx.match(/new THREE\.WebGLRenderer\(\{\s*canvas,\s*antialias: [^\n]+\n\s*depth: _canvasDepth\.depth,\s*\.\.\.depthRendererParams\(/g) || []).length === 2);
  check("direct path: binds screenTarget before the sky pass, the seal calls take it, presents before the portal fade, restores in finally",
    /const directTarget = screenTarget\(renderer\);\s*if \(directTarget\) renderer\.setRenderTarget\(directTarget\);\s*let skyRendered = false;/.test(idx) &&
    /sealPassPre\.drawOutdoorRemainder\(renderer, activeCam, directTarget\);/.test(idx) &&
    /sealPass\.render\(renderer, directTarget\);/.test(idx) &&
    /if \(directTarget\) presentScreenTarget\(renderer, directTarget\);\s*(\/\/[^\n]*\n\s*)+renderPortalSpaceOverlay\(renderer\);/.test(idx) &&
    /if \(directTarget && renderer\.getRenderTarget\(\) === directTarget\) renderer\.setRenderTarget\(null\);/.test(idx));
  check("no `null` target left in the direct path's seal calls", !/drawOutdoorRemainder\(renderer, activeCam, null\)|sealPass\.render\(renderer, null\)/.test(idx));
  const ps = src("scene3d/portal_space.js");
  check("portal tunnel: draws into screenTarget and presents it; its programs compile for that target",
    /const target = screenTarget\(renderer\);\s*try \{\s*renderer\.setRenderTarget\(target\);/.test(ps) &&
    /renderer\.render\(_tunnelScene, cam\);\s*\}\s*if \(target\) presentScreenTarget\(renderer, target\);\s*return true;/.test(ps) &&
    /renderer\.setRenderTarget\(scene === _tunnelScene \? screenTarget\(renderer\) : null\);/.test(ps));
}

console.log(`\ncanvas depth: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
