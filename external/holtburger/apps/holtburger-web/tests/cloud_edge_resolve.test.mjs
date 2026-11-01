// 2026-11-01 — ?cloudEdgeResolve (scene3d/cloud_edge_resolve.js): depth-aware
// temporal upscale of the takram clouds at scene-object silhouettes.
//
// What node CAN check: the flag grammar, that the patch anchors exist exactly
// once in the REAL vendored resolve shader and land where intended, that every
// identifier the injected GLSL relies on is declared by takram's source, the
// install wiring (shared depth uniform, class pass after the resolve, render
// target restored, A/B switch, packed-depth skip, dispose), and a CPU MODEL of
// takram's resolve vs the patched one on a synthetic moving balloon over noisy
// clouds. What it CANNOT check: that the GLSL compiles on a GPU (no validator on
// this box) — the 1070 capture owns that.
//
// Run:
//   cd apps/holtburger-web/
//   node tests/cloud_edge_resolve.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cloudEdgeResolveEnabled, cloudEdgeGamma, patchCloudsResolveSource, installCloudEdgeResolve,
  ANCHOR_UNIFORM, ANCHOR_FUNC, ANCHOR_CLOSEST, CLASS_FRAG, CLOUD_EDGE_GAMMA_DEFAULT,
} from "../scene3d/cloud_edge_resolve.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

console.log("-- E1 flags -------------------------------------------------------------");
check("absent -> ON (default since the 2026-11-01 flip)", cloudEdgeResolveEnabled("") === true);
check("on/1/true/yes/garbage -> ON", ["on", "1", "true", "yes", "x"].every((v) => cloudEdgeResolveEnabled(`?cloudEdgeResolve=${v}`)));
check("off/0/false/no -> OFF", ["off", "0", "false", "no"].every((v) => !cloudEdgeResolveEnabled(`?cloudEdgeResolve=${v}`)));
check("gamma default 2", cloudEdgeGamma("") === CLOUD_EDGE_GAMMA_DEFAULT && CLOUD_EDGE_GAMMA_DEFAULT === 2);
check("gamma parse + junk", cloudEdgeGamma("?cloudEdgeGamma=3.5") === 3.5 && cloudEdgeGamma("?cloudEdgeGamma=0") === 2 && cloudEdgeGamma("?cloudEdgeGamma=99") === 2);

console.log("-- E2 patch vs the vendored takram resolve shader --------------------------");
const build = readFileSync(path.join(APP, "vendor/takram-three-clouds/build/index.js"), "utf8");
const m = build.match(/var cloudsResolve_default = `([\s\S]*?)`;/);
check("found takram's cloudsResolve.frag in the vendored build", !!m);
const src = m ? m[1] : "";
const once = (s, a) => s.indexOf(a) >= 0 && s.indexOf(a) === s.lastIndexOf(a);
check("anchors exist exactly once", once(src, ANCHOR_UNIFORM) && once(src, ANCHOR_FUNC) && once(src, ANCHOR_CLOSEST));
const patched = patchCloudsResolveSource(src);
check("patch applies", typeof patched === "string" && patched.length > src.length);
if (patched) {
  const iUni = patched.indexOf("uniform sampler2D hbSceneDepth;");
  const iFn = patched.indexOf("bool hbEdgeResolve(");
  const iTU = patched.indexOf(ANCHOR_FUNC);
  const iTA = patched.indexOf("void temporalAntialiasing(");
  const iCall = patched.indexOf("if (hbEdgeResolve(lowResCoord, depthVelocity, hbColor))");
  const iClosest = patched.indexOf(ANCHOR_CLOSEST);
  const iGetClosest = patched.indexOf("vec4 getClosestFragment(");
  check("uniforms right after jitterOffset", iUni > patched.indexOf(ANCHOR_UNIFORM) && iUni < iGetClosest);
  check("helpers after getClosestFragment, before temporalUpscale", iFn > iGetClosest && iFn < iTU);
  check("call sits in temporalUpscale right after the closest fragment", iCall > iClosest && iCall > iTU && iCall < iTA);
  check("idempotent (second patch refused)", patchCloudsResolveSource(patched) === null);
  check("missing anchor -> null", patchCloudsResolveSource(src.replace(ANCHOR_CLOSEST, "")) === null && patchCloudsResolveSource(null) === null);
  // Every identifier the injection relies on is takram's.
  for (const id of ["in vec2 vUv;", "uniform sampler2D colorBuffer;", "uniform sampler2D depthVelocityBuffer;",
    "uniform sampler2D colorHistoryBuffer;", "uniform vec2 texelSize;", "uniform vec2 jitterOffset;",
    "const ivec2 neighborOffsets[9]", "vec4 currentShadowLength =", "out float outputShadowLength"]) {
    check(`takram declares ${id}`, src.includes(id));
  }
  // Balanced delimiters in the injected text (a cheap GLSL sanity check).
  const added = patched.length - src.length;
  const inj = patched.slice(iUni, iUni + 1) + patched.slice(iFn - 2000 < 0 ? 0 : patched.indexOf("bool hbIsSky("), iTU) +
    patched.slice(iClosest, patched.indexOf("vec2 velocity = depthVelocity.gb;"));
  const bal = (o, c) => inj.split(o).length === inj.split(c).length;
  check("injected GLSL: braces/parens/brackets balanced", bal("{", "}") && bal("(", ")") && bal("[", "]"), `added ${added} chars`);
  check("no backticks in injected GLSL (project rule)", !/`/.test(inj));
  check("class pass shader writes one channel from the same test", /d >= 1\.0 - 1e-7/.test(CLASS_FRAG) && /1\.0 - d/.test(CLASS_FRAG));
}

console.log("-- E3 install wiring (mock THREE + mock takram pass) ------------------------");
{
  class Uniform { constructor(v) { this.value = v; } }
  class WebGLRenderTarget {
    constructor(w, h, o) { this.width = w; this.height = h; this.opts = o; this.texture = { name: "" }; this.disposed = false; }
    setSize(w, h) { this.width = w; this.height = h; }
    dispose() { this.disposed = true; }
  }
  class RawShaderMaterial { constructor(o) { Object.assign(this, o); } dispose() {} }
  const THREE = { Uniform, WebGLRenderTarget, RawShaderMaterial, GLSL3: "300 es", UnsignedByteType: 1009, RedFormat: 1028, NearestFilter: 1003, RGBADepthPacking: 3201 };
  const log = [];
  class FakeShaderPass { constructor(mat) { this.fullscreenMaterial = mat; } render(r, i, o) { log.push(["class", o]); r._rt = o; } }
  const depthUniform = new Uniform("DEPTH");
  const cp = {
    width: 1280, height: 720,
    resolveMaterial: { fragmentShader: src, vertexShader: "VERT", uniforms: {}, needsUpdate: false },
    currentMaterial: { uniforms: { depthBuffer: depthUniform }, depthPacking: 0 },
    resolvePass: new FakeShaderPass(null),
    update(renderer, frame) { log.push(["takram", frame]); },
  };
  const effect = { cloudsPass: cp };
  const renderer = { _rt: "PREV", getRenderTarget() { return this._rt; }, setRenderTarget(t) { this._rt = t; }, state: { buffers: { depth: { getReversed: () => true } } } };
  const h = installCloudEdgeResolve(effect, THREE, { gamma: 3, warn() {} });
  check("installs", !!h);
  const u = cp.resolveMaterial.uniforms;
  check("resolve shares the clouds' depth Uniform object", u.hbSceneDepth === depthUniform);
  check("resolve source patched + needsUpdate", cp.resolveMaterial.fragmentShader.includes("hbEdgeResolve") && cp.resolveMaterial.needsUpdate === true);
  check("gamma passed through", u.hbEdgeGamma.value === 3);
  cp.update(renderer, 7);
  check("takram update runs first, then the class pass", log.length === 2 && log[0][0] === "takram" && log[1][0] === "class");
  check("render target restored after the class pass", renderer._rt === "PREV");
  check("class target sized to the clouds pass", log[1][1].width === 1280 && log[1][1].height === 720);
  check("reversed-Z mirrored from the renderer", u.hbReversedDepth.value === 1);
  h.set(false);
  log.length = 0;
  cp.update(renderer, 8);
  check("set(false): takram only, resolve patch disabled", log.length === 1 && u.hbEdgeEnable.value === 0);
  h.set(true);
  cp.currentMaterial.depthPacking = 3201;
  log.length = 0;
  cp.update(renderer, 9);
  check("packed depth: disabled (raw .r read would be wrong)", log.length === 1 && u.hbEdgeEnable.value === 0 && h.stats().packedDepthSkips === 1);
  cp.currentMaterial.depthPacking = 0;
  h.dispose();
  log.length = 0;
  cp.update(renderer, 10);
  check("dispose restores takram's update", log.length === 1 && log[0][0] === "takram");
  check("unrecognised pass shape -> null", installCloudEdgeResolve({}, THREE, { warn() {} }) === null);
}

console.log("-- E4 CPU model: takram resolve vs patched, moving balloon over noisy clouds --");
// A faithful-in-logic CPU port of cloudsResolve.frag temporalUpscale (closest
// fragment, bilinear history, variance clipping with the rgb-only clipAABB at
// this project's gamma 4) and of the injected hbEdgeResolve, on a 128x96 frame:
// clouds sweep right 0.8 px/frame, the balloon (a scene object 30 m away) drifts
// left 0.8 px/frame on screen while its texels carry takram's static-world
// velocity (wrong for an object moving with the camera); the march has
// per-sample noise like the STBN march. Error = |rgba - truth| in a 10 px band
// around the balloon, in its trail, and in rows it never crosses; frames 32..95.
{
  const W = 128, H = 96, LW = W / 4, LH = H / 4, GAMMA = 4, EDGE_GAMMA = 2;
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const slot = (f) => { const i = BAYER.indexOf(f % 16); return [i % 4, Math.floor(i / 4)]; };
  const VX = -0.8, BX = 0.8, R = 15; // clouds sweep right (banking), balloon drifts left
  const balloonAt = (f) => ({ cx: 110 - BX * f, cy: 44 });
  const isBalloon = (x, y, f) => {
    const b = balloonAt(f);
    const dx = (x + 0.5 - b.cx) / R, dy = (y + 0.5 - b.cy) / (R * 1.3);
    return dx * dx + dy * dy <= 1;
  };
  const HAZE = [0.05, 0.06, 0.08, 0.04];
  const cloud = (u, v) => {
    const a = Math.min(1, Math.max(0, 0.55 + 0.4 * Math.sin(u * 0.11 + v * 0.05)));
    const g = 0.55 + 0.25 * Math.sin(u * 0.07) * Math.cos(v * 0.13);
    return [g * a, g * a, (g + 0.05) * a, a];
  };
  const truth = (x, y, f) => (isBalloon(x, y, f) ? HAZE : cloud(x + 0.5 + VX * f, y + 0.5));
  const hash = (a, b, c) => { let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  const lowIdx = (x, y) => y * LW + x;
  const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // bilinear sample of a W'xH' rgba Float32Array image at uv (clamp-to-edge)
  const bilinear = (img, w, h, u, v) => {
    const fx = u * w - 0.5, fy = v * h - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const out = [0, 0, 0, 0];
    for (const [dx, dy, wt] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
      const xx = clampI(x0 + dx, 0, w - 1), yy = clampI(y0 + dy, 0, h - 1);
      for (let c = 0; c < 4; c++) out[c] += img[(yy * w + xx) * 4 + c] * wt;
    }
    return out;
  };
  const OFFS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 0], [0, 1], [1, -1], [1, 0], [1, 1]];
  const VOFFS = [[-1, -1], [-1, 1], [1, -1], [1, 1], [1, 0], [0, -1], [0, 1], [-1, 0]];
  function runModel(patchOn) {
    let history = new Float32Array(W * H * 4);
    // 0 = scene, 1 = sky; seeded with frame 0's classes so both arms start alike
    let prevSky = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) prevSky[y * W + x] = isBalloon(x, y, 0) ? 0 : 1;
    let errBand = 0, nBand = 0, errTrail = 0, nTrail = 0, errFar = 0, nFar = 0;
    for (let f = 0; f < 96; f++) {
      const [sx, sy] = slot(f);
      const jitter = [sx + 0.5 - 2, sy + 0.5 - 2];
      // march: one pixel per 4x4 block, noisy
      const color = new Float32Array(LW * LH * 4);
      const dv = new Float32Array(LW * LH * 3);
      for (let ly = 0; ly < LH; ly++) for (let lx = 0; lx < LW; lx++) {
        const px = lx * 4 + sx, py = ly * 4 + sy;
        const t = truth(px, py, f);
        const n = (hash(lx, ly, f) - 0.5) * 0.4;
        const ball = isBalloon(px, py, f);
        for (let c = 0; c < 4; c++) color[lowIdx(lx, ly) * 4 + c] = ball ? t[c] : Math.max(0, t[c] + n * (c === 3 ? 0.5 : 1));
        const k = lowIdx(lx, ly) * 3;
        if (ball) { dv[k] = 30; dv[k + 1] = 2.5 / W; dv[k + 2] = 1.5 / H; } // static-world velocity (wrong)
        else { dv[k] = 2000; dv[k + 1] = -VX / W; dv[k + 2] = 0; }
      }
      const isSkyPx = (x, y) => !isBalloon(clampI(x, 0, W - 1), clampI(y, 0, H - 1), f);
      const lowTex = (lx, ly) => { const i = lowIdx(clampI(lx, 0, LW - 1), clampI(ly, 0, LH - 1)) * 4; return [color[i], color[i + 1], color[i + 2], color[i + 3]]; };
      const lowDv = (lx, ly) => { const i = lowIdx(clampI(lx, 0, LW - 1), clampI(ly, 0, LH - 1)) * 3; return [dv[i], dv[i + 1], dv[i + 2]]; };
      const out = new Float32Array(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const lx = x >> 2, ly = y >> 2;
        const u = (x + 0.5) / W, v = (y + 0.5) / H;
        const cur = lowTex(lx, ly);
        let res;
        if (BAYER[(y % 4) * 4 + (x % 4)] === f % 16) {
          res = cur;
        } else {
          let closest = [1e7, 0, 0];
          for (const [ox, oy] of OFFS) { const d = lowDv(lx + ox, ly + oy); if (d[0] < closest[0]) closest = d; }
          let handled = false;
          if (patchOn) {
            // ---- hbEdgeResolve ----
            const selfSky = isSkyPx(x, y);
            const nSky = OFFS.map(([ox, oy]) => {
              const nx = clampI(lx + ox, 0, LW - 1), ny = clampI(ly + oy, 0, LH - 1);
              return isSkyPx(Math.floor(nx * 4 + 2 + jitter[0]), Math.floor(ny * 4 + 2 + jitter[1]));
            });
            const other = nSky.filter((s) => s !== selfSky).length;
            const wasSky = (pu, pv) => prevSky[clampI(Math.floor(pv * H), 0, H - 1) * W + clampI(Math.floor(pu * W), 0, W - 1)] === 1;
            if (other === 0) {
              const pu = u - closest[1], pv = v - closest[2];
              if (!(pu < 0 || pu > 1 || pv < 0 || pv > 1) && wasSky(pu, pv) !== selfSky) {
                res = bilinear(color, LW, LH, u, v); handled = true;
              }
            } else {
              const m1 = [0, 0, 0, 0], m2 = [0, 0, 0, 0]; let n = 0; let best = [1e7, 0, 0];
              OFFS.forEach(([ox, oy], i) => {
                if (nSky[i] !== selfSky) return;
                const c = lowTex(lx + ox, ly + oy);
                for (let k = 0; k < 4; k++) { m1[k] += c[k]; m2[k] += c[k] * c[k]; }
                n++;
                const d = lowDv(lx + ox, ly + oy);
                if (d[0] < best[0]) best = d;
              });
              if (n > 0) {
                const mean = m1.map((s) => s / n);
                const pu = u - best[1], pv = v - best[2];
                if (pu < 0 || pu > 1 || pv < 0 || pv > 1 || wasSky(pu, pv) !== selfSky) {
                  res = mean;
                } else {
                  const ext = mean.map((mu, k) => Math.sqrt(Math.max(m2[k] / n - mu * mu, 0)) * EDGE_GAMMA);
                  const hist = bilinear(history, W, H, pu, pv);
                  const vv = hist.map((hv, k) => hv - mean[k]);
                  const mu = Math.max(...vv.map((d, k) => Math.abs(d) / (ext[k] + 1e-7)));
                  res = mu > 1 ? mean.map((mm, k) => mm + vv[k] / mu) : hist;
                }
                handled = true;
              }
            }
          }
          if (!handled) {
            // ---- takram temporalUpscale ----
            const pu = u - closest[1], pv = v - closest[2];
            if (pu < 0 || pu > 1 || pv < 0 || pv > 1) {
              res = cur;
            } else {
              const hist = bilinear(history, W, H, pu, pv);
              const m1 = cur.slice(), m2 = cur.map((c) => c * c);
              for (const [ox, oy] of VOFFS) {
                const s = bilinear(color, LW, LH, u + ox / LW, v + oy / LH);
                for (let k = 0; k < 4; k++) { m1[k] += s[k]; m2[k] += s[k] * s[k]; }
              }
              const mean = m1.map((s) => s / 9);
              const vg = mean.map((mu, k) => Math.sqrt(Math.max(m2[k] / 9 - mu * mu, 0)) * GAMMA);
              const mn = mean.map((mu, k) => mu - vg[k]), mx = mean.map((mu, k) => mu + vg[k]);
              const cc = mean.map((mu, k) => Math.min(mx[k], Math.max(mn[k], mu)));
              // clipAABB (rgb tested, alpha carried)
              const pC = [0, 1, 2].map((k) => 0.5 * (mx[k] + mn[k]));
              const eC = [0, 1, 2].map((k) => 0.5 * (mx[k] - mn[k]) + 1e-7);
              const vC = [hist[0] - pC[0], hist[1] - pC[1], hist[2] - pC[2], hist[3] - cc[3]];
              const ma = Math.max(...[0, 1, 2].map((k) => Math.abs(vC[k] / eC[k])));
              res = ma > 1 ? [pC[0] + vC[0] / ma, pC[1] + vC[1] / ma, pC[2] + vC[2] / ma, cc[3] + vC[3] / ma] : hist;
            }
          }
        }
        for (let k = 0; k < 4; k++) out[(y * W + x) * 4 + k] = res[k];
        if (f >= 32) {
          const t = truth(x, y, f);
          const e = Math.abs(res[0] - t[0]) + Math.abs(res[1] - t[1]) + Math.abs(res[2] - t[2]) + Math.abs(res[3] - t[3]);
          const b = balloonAt(f);
          const dx = (x + 0.5 - b.cx) / R, dy = (y + 0.5 - b.cy) / (R * 1.3);
          const rr = Math.sqrt(dx * dx + dy * dy);
          if (rr > 0.6 && rr < 1.67 && Math.abs(dx) < 1.67) { errBand += e; nBand++; }
          else if (dx > 1 && dx < 4 && Math.abs(dy) < 1) { errTrail += e; nTrail++; }
          else if (Math.abs(dy) > 1.5) { errFar += e; nFar++; } // rows the balloon never crosses
        }
      }
      history = out;
      prevSky = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) prevSky[y * W + x] = isBalloon(x, y, f) ? 0 : 1;
    }
    return { band: errBand / nBand, trail: errTrail / nTrail, far: errFar / nFar };
  }
  const base = runModel(false);
  const fix = runModel(true);
  const f3 = (v) => v.toFixed(3);
  console.log(`     mean |rgba err|  band: ${f3(base.band)} -> ${f3(fix.band)}   trail: ${f3(base.trail)} -> ${f3(fix.trail)}   far sky: ${f3(base.far)} -> ${f3(fix.far)}`);
  check("model reproduces a silhouette artifact (band error >> far-sky error)", base.band > 2 * base.far, `${f3(base.band)} vs ${f3(base.far)}`);
  check("patched: silhouette band error at least halved", fix.band <= 0.5 * base.band, `${f3(base.band)} -> ${f3(fix.band)}`);
  check("patched: trail error at least 40% lower", fix.trail <= 0.6 * base.trail, `${f3(base.trail)} -> ${f3(fix.trail)}`);
  check("patched: sky the balloon never crossed is identical (takram path)", Math.abs(fix.far - base.far) <= 1e-9, `${base.far} -> ${fix.far}`);
}

console.log("-- E5 wiring + docs -------------------------------------------------------");
{
  const cv = readFileSync(path.join(APP, "scene3d/cloud_volume.js"), "utf8");
  check("cloud_volume.js installs only when the flag is on, by dynamic import",
    cv.includes("import('./cloud_edge_resolve.js')") && !/^import .*cloud_edge_resolve/m.test(cv));
  const flags = readFileSync(path.join(APP, "docs/url-flags.md"), "utf8");
  check("url-flags.md has a `cloudEdgeResolve` row", /^\| `cloudEdgeResolve` \|/m.test(flags));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
