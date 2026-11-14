// tests/clouds_terrain_occlusion.test.mjs
//
// Bug 1 regression & invariant suite: "clouds are appearing drawn over terrain
// and must appear behind hills etc."
//
// Covers all 4 shader/runtime root causes end-to-end (source invariants,
// CPU shader-logic models across broad hills, sub-4px hilltops/spires,
// foreground-cloud-in-front-of-far-peak, non-divisible-by-4 currentFrame slots,
// Reversed-Z + LogDepth decoding, AerialPerspectiveEffect depth-before-overlay
// ordering + sub-cloud bilinear upsample bleed guard, clouds.frag #ifdef HAZE
// terrain suppression, and live CloudsMaterial / CloudsPass instantiation):
//
//   T1  GLSL & runtime source invariants across cloudsResolve.frag,
//       cloud_edge_resolve.js, clouds.frag, CloudsMaterial, and
//       AerialPerspectiveEffect (vendor/takram/three-atmosphere.js).
//   T2  CPU model of cloudsResolve.frag bilateral horizon resolve (?cloudEdgeResolve=off):
//       proves the dead `<= 0.0` sky check smeared alpha -> 1.0 onto 300 m hills
//       and proves the fixed bare-terrain classifier keeps hill alpha === 0.
//   T3  CPU model of hbEdgeResolve (scene3d/cloud_edge_resolve.js):
//       (a) broad hill silhouette in BOTH Reversed-Z and LogDepth,
//       (b) sub-4px narrow hilltop / ridge crest / tree spire where all 9
//           low-res Bayer taps hit sky clouds (`n == 0` fallthrough fix),
//       (c) low cloud genuinely in front of a distant 4200 m mountain peak vs
//           occluded behind an adjacent 350 m foreground foothill,
//       (d) non-multiple-of-4 viewport (e.g. 66x50 / 1366x765 / 1440x810) where
//           `targetUvScale > 1.0` shifts `currentFrame` onto sky 1-2 px above a hill.
//   T4  CPU model + live shader inspection of AerialPerspectiveEffect:
//       depth read BEFORE `overlay.a == 1.0` return, sky fast-path preserved,
//       sub-cloud hill bilinear upsample bleed (`?cloudResScale=0.5`) zeroed,
//       high-altitude aircraft & high peak (>550 m) cloud overlays preserved,
//       northern Dereth ECEF anchor shift respected.
//   T5  clouds.frag `#ifdef HAZE` terrain suppression across upward hill hits,
//       downward valley/hillside hits (`intersectsGround`), clear sky, and cloud hits.
//   T6  Live vendored `CloudsEffect` / `CloudsMaterial` / `CloudsPass` +
//       `AerialPerspectiveEffect` instantiation: `USE_LOGARITHMIC_DEPTH_BUFFER`
//       `needsUpdate = true` on both transitions, `CloudsPass` `cameraFar` &
//       `targetUvScale` sync into `CloudsResolveMaterial`, and `installCloudEdgeResolve`
//       integration on a real `CloudsEffect`.
//
// Run:
//   cd apps/holtburger-web
//   node tests/clouds_terrain_occlusion.test.mjs

import { register } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

const VENDOR_MAP = {
  "@takram/three-clouds": pathToFileURL(path.join(APP, "vendor/takram-three-clouds/build/index.js")).href,
  "@takram/three-atmosphere": pathToFileURL(path.join(APP, "vendor/takram/three-atmosphere.js")).href,
  "@takram/three-atmosphere/shaders/bruneton": pathToFileURL(path.join(APP, "vendor/takram/three-atmosphere-shaders-bruneton.js")).href,
  "@takram/three-geospatial": pathToFileURL(path.join(APP, "vendor/takram/three-geospatial.js")).href,
  "@takram/three-geospatial/shaders": pathToFileURL(path.join(APP, "vendor/takram/three-geospatial-shaders.js")).href,
  "@takram/three-geospatial-effects": pathToFileURL(path.join(APP, "vendor/takram/three-geospatial-effects.js")).href,
};

register(
  "data:text/javascript," +
    encodeURIComponent(
      `const MAP = ${JSON.stringify(VENDOR_MAP)};
       export async function resolve(spec, ctx, next) {
         if (Object.prototype.hasOwnProperty.call(MAP, spec)) {
           return { url: MAP[spec], shortCircuit: true };
         }
         return next(spec, ctx);
       }`,
    ),
);

const THREE = await import("three");
const { CloudsEffect } = await import("@takram/three-clouds");
const { AerialPerspectiveEffect } = await import("@takram/three-atmosphere");
const {
  patchCloudsResolveSource,
  installCloudEdgeResolve,
  ANCHOR_CLOSEST,
} = await import("../scene3d/cloud_edge_resolve.js");

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  [OK] ${label}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${label}${extra ? " — " + extra : ""}`);
  }
}

const CLOUDS_BUILD = readFileSync(path.join(APP, "vendor/takram-three-clouds/build/index.js"), "utf8");
const ATMOS_BUILD = readFileSync(path.join(APP, "vendor/takram/three-atmosphere.js"), "utf8");
const EDGE_SRC = readFileSync(path.join(APP, "scene3d/cloud_edge_resolve.js"), "utf8");

const cloudsFragMatch = CLOUDS_BUILD.match(/var clouds_default = `([\s\S]*?)`;/);
const cloudsResolveMatch = CLOUDS_BUILD.match(/var cloudsResolve_default = `([\s\S]*?)`;/);
const aerialFragMatch = ATMOS_BUILD.match(/void mainImage\(const vec4 inputColor, const vec2 uv, out vec4 outputColor\) \{[\s\S]*?\n\}\n`;/);

const CLOUDS_FRAG = cloudsFragMatch ? cloudsFragMatch[1] : "";
const RESOLVE_FRAG = cloudsResolveMatch ? cloudsResolveMatch[1] : "";
const AERIAL_MAIN = aerialFragMatch ? aerialFragMatch[0] : "";

// ---------------------------------------------------------------------------
console.log("-- T1 GLSL & runtime source invariants --------------------------------------");
{
  check("extracted clouds.frag, cloudsResolve.frag, and AerialPerspectiveEffect mainImage",
    CLOUDS_FRAG.length > 1000 && RESOLVE_FRAG.length > 1000 && AERIAL_MAIN.length > 500);

  // 1. cloudsResolve.frag invariants
  check("cloudsResolve.frag has NO dead (centerFrontDepth <= 0.0) or (ncDepth <= 0.0) checks",
    !/centerFrontDepth\s*<=\s*0\.0/.test(RESOLVE_FRAG) && !/ncDepth\s*<=\s*0\.0/.test(RESOLVE_FRAG));
  check("cloudsResolve.frag declares cameraFar and targetUvScale uniforms",
    RESOLVE_FRAG.includes("uniform float cameraFar;") && RESOLVE_FRAG.includes("uniform vec2 targetUvScale;"));
  check("cloudsResolve.frag classifies bare foreground terrain vs sky/cloud using cameraFar + alpha",
    RESOLVE_FRAG.includes("bool centerBareTerrain = !centerSkyOrCloud;") &&
    RESOLVE_FRAG.includes("occludedBehindCenter"));
  check("cloudsResolve.frag computes depthVelocity BEFORE if (currentFrame)",
    RESOLVE_FRAG.indexOf(ANCHOR_CLOSEST) > 0 &&
    RESOLVE_FRAG.indexOf("if (currentFrame)") > RESOLVE_FRAG.indexOf(ANCHOR_CLOSEST));

  // 2. Patched cloudsResolve.frag + cloud_edge_resolve.js invariants
  const patched = patchCloudsResolveSource(RESOLVE_FRAG);
  check("patchCloudsResolveSource succeeds on updated cloudsResolve.frag", typeof patched === "string");
  if (patched) {
    const iHb = patched.indexOf("if (hbEdgeResolve(lowResCoord, depthVelocity, hbColor))");
    const iCur = patched.indexOf("if (currentFrame)");
    check("patched hbEdgeResolve runs BEFORE if (currentFrame)", iHb > 0 && iCur > iHb);
    check("patched shader declares hbLogDepth, hbCameraNear, hbCameraFar, hbProjScale, hbTargetUvScale",
      patched.includes("uniform float hbLogDepth;") &&
      patched.includes("uniform float hbCameraNear;") &&
      patched.includes("uniform float hbCameraFar;") &&
      patched.includes("uniform vec2 hbProjScale;") &&
      patched.includes("uniform vec2 hbTargetUvScale;"));
    check("hbEdgeResolve handles sub-4px !selfSky hilltops (n < 0.5) via selfRayDist comparison instead of falling through",
      patched.includes("float hbSceneRayDist(") &&
      /if \(n < 0\.5\) \{\s*if \(!selfSky\)/.test(patched) &&
      patched.includes("dv.r + 4.0 < selfRayDist"));
  }

  // 3. AerialPerspectiveEffect (vendor/takram/three-atmosphere.js) invariants
  const iReadDepth = AERIAL_MAIN.indexOf("float depth = readDepthValue(depthBuffer, uv);");
  const iOverlayRet = AERIAL_MAIN.indexOf("outputColor = overlay;");
  check("AerialPerspectiveEffect reads depth BEFORE any overlay.a == 1.0 early return",
    iReadDepth > 0 && iOverlayRet > iReadDepth);
  check("AerialPerspectiveEffect gates overlay.a == 1.0 early return on isSkyDepth",
    /if\s*\(\s*isSkyDepth\s*&&\s*overlay\.a\s*==\s*1\.0\s*\)/.test(AERIAL_MAIN));
  const iSubCloudGuard = AERIAL_MAIN.indexOf("if (max(hbCameraHeightM, hbSurfaceHeightM) < 550.0)");
  const iCorrectGeo = AERIAL_MAIN.indexOf("correctGeometricError(positionECEF, normalECEF);");
  const iFinalBlend = AERIAL_MAIN.lastIndexOf("outputColor.rgb = outputColor.rgb * (1.0 - overlay.a) + overlay.rgb;");
  check("AerialPerspectiveEffect computes unflattened surface altitude BEFORE correctGeometricError and zeroes sub-cloud overlay before final blend",
    iSubCloudGuard > iReadDepth && iSubCloudGuard < iCorrectGeo && iFinalBlend > iSubCloudGuard);

  // 4. clouds.frag #ifdef HAZE & depthUv clamp invariants
  check("clouds.frag clamps depthUv to min(targetUvScale, vec2(1.0))",
    CLOUDS_FRAG.includes("clamp((vUv + temporalJitter) * targetUvScale, vec2(0.0), min(targetUvScale, vec2(1.0)))"));
  check("clouds.frag gates #ifdef HAZE approximateHaze off when terrain is hit without clouds in front",
    /#ifdef HAZE\s+if \(hitClouds \|\| \(!intersectsScene && rayDistanceToScene <= 0\.0\)\)\s*\{\s*vec4 haze = approximateHaze/.test(CLOUDS_FRAG));

  // 5. CloudsMaterial.onBeforeRender USE_LOGARITHMIC_DEPTH_BUFFER needsUpdate invariant
  const logBlock = CLOUDS_BUILD.match(/if \(nextLogarithmicDepthBuffer !== prevLogarithmicDepthBuffer\) \{[\s\S]{0,320}?\n    \}/);
  check("CloudsMaterial.onBeforeRender sets this.needsUpdate = true in both if and else branches of USE_LOGARITHMIC_DEPTH_BUFFER",
    !!logBlock && (logBlock[0].match(/this\.needsUpdate = true;/g) || []).length === 2);
}

// ---------------------------------------------------------------------------
console.log("-- T2 CPU model: cloudsResolve.frag bilateral horizon (?cloudEdgeResolve=off) --");
{
  // 64x48 full-res (16x12 low-res), camera stationary or panning slowly:
  // Upper half (y >= 24) = sky with opaque clouds (rgba = [0.88, 0.90, 0.94, 1.0], frontDepth = 2400 m).
  // Lower half (y < 24)  = foreground hill (rgba = [0, 0, 0, 0], frontDepth = 300 m).
  const W = 64, H = 48, LW = 16, LH = 12, CAMERA_FAR = 5000;
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const VOFFS = [[-1, -1], [-1, 1], [1, -1], [1, 1], [1, 0], [0, -1], [0, 1], [-1, 0]];
  const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const clampF = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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

  function varianceClip(colorBuf, u, v, current, history, gamma) {
    const m1 = current.slice(), m2 = current.map((x) => x * x);
    for (const [ox, oy] of VOFFS) {
      const s = bilinear(colorBuf, LW, LH, u + ox / LW, v + oy / LH);
      for (let k = 0; k < 4; k++) { m1[k] += s[k]; m2[k] += s[k] * s[k]; }
    }
    const mean = m1.map((s) => s / 9);
    const vg = mean.map((mu, k) => Math.sqrt(Math.max(m2[k] / 9 - mu * mu, 0)) * gamma);
    const mn = mean.map((mu, k) => mu - vg[k]), mx = mean.map((mu, k) => mu + vg[k]);
    const cc = mean.map((mu, k) => clampF(mu, mn[k], mx[k]));
    const pC = [0, 1, 2].map((k) => 0.5 * (mx[k] + mn[k]));
    const eC = [0, 1, 2].map((k) => 0.5 * (mx[k] - mn[k]) + 1e-7);
    const vC = [history[0] - pC[0], history[1] - pC[1], history[2] - pC[2], history[3] - cc[3]];
    const ma = Math.max(...[0, 1, 2].map((k) => Math.abs(vC[k] / eC[k])));
    return ma > 1 ? [pC[0] + vC[0] / ma, pC[1] + vC[1] / ma, pC[2] + vC[2] / ma, cc[3] + vC[3] / ma] : history.slice();
  }

  function simulateBilateralResolve(useFixedLogic) {
    let history = new Float32Array(W * H * 4);
    // Simulate a camera vertical tilt that just brought the hill up into previously sky pixels,
    // plus ongoing horizontal pan (1.2 px/frame).
    for (let i = 0; i < W * H; i++) {
      history[i * 4 + 0] = 0.88;
      history[i * 4 + 1] = 0.90;
      history[i * 4 + 2] = 0.94;
      history[i * 4 + 3] = 1.0;
    }
    let maxHillAlpha = 0;
    let maxHillRgb = 0;
    for (let f = 0; f < 64; f++) {
      const color = new Float32Array(LW * LH * 4);
      const depthVel = new Float32Array(LW * LH * 3);
      for (let ly = 0; ly < LH; ly++) {
        for (let lx = 0; lx < LW; lx++) {
          const isSky = ly >= 6; // y >= 24 is sky cloud, y < 24 is 300 m hill
          const idx = ly * LW + lx;
          if (isSky) {
            color[idx * 4 + 0] = 0.88; color[idx * 4 + 1] = 0.90; color[idx * 4 + 2] = 0.94; color[idx * 4 + 3] = 1.0;
            depthVel[idx * 3 + 0] = 2400; // NEVER <= 0!
            depthVel[idx * 3 + 1] = 1.2 / W; depthVel[idx * 3 + 2] = 0;
          } else {
            color[idx * 4 + 0] = 0; color[idx * 4 + 1] = 0; color[idx * 4 + 2] = 0; color[idx * 4 + 3] = 0;
            depthVel[idx * 3 + 0] = 300; // -sceneViewZ > 0
            depthVel[idx * 3 + 1] = 1.2 / W; depthVel[idx * 3 + 2] = 0;
          }
        }
      }
      const nextHist = new Float32Array(W * H * 4);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const lx = x >> 2, ly = y >> 2;
          const curIdx = (ly * LW + lx) * 4;
          const currentColor = [color[curIdx], color[curIdx + 1], color[curIdx + 2], color[curIdx + 3]];
          const currentFrame = BAYER[(y % 4) * 4 + (x % 4)] === (f % 16);
          let out;
          if (currentFrame) {
            out = currentColor;
          } else {
            let closest = [1e7, 0, 0];
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const nIdx = (clampI(ly + dy, 0, LH - 1) * LW + clampI(lx + dx, 0, LW - 1)) * 3;
                if (depthVel[nIdx] < closest[0]) closest = [depthVel[nIdx], depthVel[nIdx + 1], depthVel[nIdx + 2]];
              }
            }
            const u = (x + 0.5) / W, v = (y + 0.5) / H;
            const prevU = u - closest[1], prevV = v - closest[2];
            const centerFrontDepth = depthVel[(ly * LW + lx) * 3];
            const farSkyThreshold = CAMERA_FAR * 0.995;
            const centerSkyOrCloud = (centerFrontDepth >= farSkyThreshold) || (currentColor[3] > 1e-4);
            const centerBareTerrain = !centerSkyOrCloud;

            let minN = currentColor.slice(), maxN = currentColor.slice();
            let bilSum = [0, 0, 0, 0], bilW = 0;
            let anySky = useFixedLogic ? centerSkyOrCloud : (centerFrontDepth <= 0);
            let anyScene = useFixedLogic ? centerBareTerrain : (centerFrontDepth > 0);
            let minScene = anyScene ? centerFrontDepth : 1e20;
            let maxScene = anyScene ? centerFrontDepth : 0;

            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const ncx = clampI(lx + dx, 0, LW - 1), ncy = clampI(ly + dy, 0, LH - 1);
                const cOff = (ncy * LW + ncx) * 4;
                const ncCol = [color[cOff], color[cOff + 1], color[cOff + 2], color[cOff + 3]];
                const ncDepth = depthVel[(ncy * LW + ncx) * 3];
                if (!useFixedLogic) {
                  for (let k = 0; k < 4; k++) { minN[k] = Math.min(minN[k], ncCol[k]); maxN[k] = Math.max(maxN[k], ncCol[k]); }
                  const nSky = ncDepth <= 0;
                  anySky = anySky || nSky;
                  anyScene = anyScene || !nSky;
                  if (!nSky) { minScene = Math.min(minScene, ncDepth); maxScene = Math.max(maxScene, ncDepth); }
                  const depthDiff = Math.abs(ncDepth - centerFrontDepth);
                  const depthScale = Math.max(48, 0.12 * Math.max(ncDepth, centerFrontDepth));
                  const wSpatial = (dx === 0 && dy === 0) ? 1.0 : ((dx === 0 || dy === 0) ? 0.65 : 0.4);
                  const wDepth = (nSky === (centerFrontDepth <= 0)) ? Math.exp(-depthDiff / depthScale) : 0.05;
                  const w = wSpatial * wDepth;
                  for (let k = 0; k < 4; k++) bilSum[k] += ncCol[k] * w;
                  bilW += w;
                } else {
                  const nSky = (ncDepth >= farSkyThreshold) || (ncCol[3] > 1e-4);
                  anySky = anySky || nSky;
                  anyScene = anyScene || !nSky;
                  if (!nSky) { minScene = Math.min(minScene, ncDepth); maxScene = Math.max(maxScene, ncDepth); }
                  const occludedBehindCenter = centerBareTerrain && (ncDepth > centerFrontDepth * 1.08 + 16.0);
                  if (!occludedBehindCenter) {
                    for (let k = 0; k < 4; k++) { minN[k] = Math.min(minN[k], ncCol[k]); maxN[k] = Math.max(maxN[k], ncCol[k]); }
                  }
                  const depthDiff = Math.abs(ncDepth - centerFrontDepth);
                  const depthScale = Math.max(48, 0.12 * Math.max(ncDepth, centerFrontDepth));
                  const wSpatial = (dx === 0 && dy === 0) ? 1.0 : ((dx === 0 || dy === 0) ? 0.65 : 0.4);
                  const wDepth = (!occludedBehindCenter && (nSky === centerSkyOrCloud)) ? Math.exp(-depthDiff / depthScale) : 0.0;
                  const w = wSpatial * wDepth;
                  for (let k = 0; k < 4; k++) bilSum[k] += ncCol[k] * w;
                  bilW += w;
                }
              }
            }
            const bilCol = bilW > 1e-5 ? bilSum.map((s) => s / bilW) : currentColor;
            const silEdge = (anySky && anyScene) ? 1.0 : 0.0;
            const ridgeJump = (anyScene && maxScene > minScene)
              ? clampF((maxScene - minScene) / Math.max(120, 0.30 * maxScene), 0, 1)
              : 0;
            const horizonEdge = Math.max(silEdge, ridgeJump);

            if (prevU < 0 || prevU > 1 || prevV < 0 || prevV > 1) {
              out = (useFixedLogic && centerBareTerrain)
                ? currentColor.map((c, k) => clampF(c, minN[k], maxN[k]))
                : currentColor.map((c, k) => c * (1 - 0.65 * horizonEdge) + bilCol[k] * (0.65 * horizonEdge));
            } else {
              const hist = bilinear(history, W, H, prevU, prevV);
              const localGamma = 4.0 * (1 - horizonEdge) + 0.85 * horizonEdge;
              const refCol = currentColor.map((c, k) => c * (1 - 0.75 * horizonEdge) + bilCol[k] * (0.75 * horizonEdge));
              let clipped = varianceClip(color, u, v, refCol, hist, localGamma);
              clipped[3] = clampF(hist[3], minN[3], maxN[3]);
              if (useFixedLogic && centerBareTerrain) {
                clipped = clipped.map((c, k) => clampF(c, minN[k], maxN[k]));
              } else if (horizonEdge > 0) {
                const cl = clipped.map((c, k) => clampF(c, minN[k], maxN[k]));
                clipped = clipped.map((c, k) => c * (1 - 0.85 * horizonEdge) + cl[k] * (0.85 * horizonEdge));
              }
              out = clipped;
            }
          }
          const oIdx = (y * W + x) * 4;
          for (let k = 0; k < 4; k++) nextHist[oIdx + k] = out[k];
          // Measure steady-state hill silhouette band (rows 20..23, right below sky row 24) on frames >= 16
          if (f >= 16 && y >= 20 && y < 24) {
            maxHillAlpha = Math.max(maxHillAlpha, out[3]);
            maxHillRgb = Math.max(maxHillRgb, out[0], out[1], out[2]);
          }
        }
      }
      history = nextHist;
    }
    return { maxHillAlpha, maxHillRgb };
  }

  const buggy = simulateBilateralResolve(false);
  const fixed = simulateBilateralResolve(true);
  console.log(`     hill crest steady-state max alpha: old=${buggy.maxHillAlpha.toFixed(4)} -> fixed=${fixed.maxHillAlpha.toFixed(6)}`);
  check("old `<= 0.0` sky check reproduced opaque cloud smear onto 300 m hill silhouette",
    buggy.maxHillAlpha > 0.5, `old maxHillAlpha=${buggy.maxHillAlpha}`);
  check("fixed cloudsResolve.frag bilateral logic keeps bare hill alpha === 0 and RGB === 0",
    fixed.maxHillAlpha <= 1e-6 && fixed.maxHillRgb <= 1e-6,
    `fixed alpha=${fixed.maxHillAlpha}, rgb=${fixed.maxHillRgb}`);
}

// ---------------------------------------------------------------------------
console.log("-- T3 CPU model: hbEdgeResolve across hilltops, spires & odd viewports ------");
{
  const OFFS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 0], [0, 1], [1, -1], [1, 0], [1, 1]];
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const slot = (f) => { const i = BAYER.indexOf(f % 16); return [i % 4, Math.floor(i / 4)]; };
  const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const clampF = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Exact perspective depth encoders + hbSceneRayDist port matching cloud_edge_resolve.js
  const NEAR = 0.1, FAR = 5000.0;
  const FOV_RAD = (60 * Math.PI) / 180;
  const PROJ_SCALE_Y = Math.tan(FOV_RAD * 0.5);
  const PROJ_SCALE_X = PROJ_SCALE_Y * (16 / 9);

  function encodeRawDepth(viewDist, reversedZ, logDepth) {
    if (!Number.isFinite(viewDist) || viewDist >= FAR) {
      return reversedZ ? 0.0 : 1.0;
    }
    if (logDepth && !reversedZ) {
      // Three.js logdepthbuf_fragment: gl_FragDepth = log2(vFragDepth) * Fcoef * 0.5 = log2(viewDist + 1) / log2(FAR + 1)
      return Math.log2(viewDist + 1.0) / Math.log2(FAR + 1.0);
    }
    // Standard OpenGL perspective depth in [0, 1], then 1 - d for Reversed-Z
    const ndc = (FAR + NEAR - (2.0 * NEAR * FAR) / viewDist) / (FAR - NEAR);
    const d01 = ndc * 0.5 + 0.5;
    return reversedZ ? (1.0 - d01) : d01;
  }

  function hbReadDepth01(raw, reversedZ) {
    return reversedZ ? (1.0 - raw) : raw;
  }
  function hbIsSky(raw, reversedZ) {
    return hbReadDepth01(raw, reversedZ) >= 1.0 - 1e-7;
  }
  function hbSceneRayDist(raw, u, v, reversedZ, logDepth) {
    const d = hbReadDepth01(raw, reversedZ);
    if (d >= 1.0 - 1e-7) return FAR;
    let viewDist;
    if (logDepth && !reversedZ) {
      viewDist = Math.pow(2.0, d * Math.log2(FAR + 1.0)) - 1.0;
    } else {
      const ndc = d * 2.0 - 1.0;
      viewDist = (2.0 * NEAR * FAR) / Math.max(1e-6, FAR + NEAR - ndc * (FAR - NEAR));
    }
    const nx = (u * 2.0 - 1.0) * PROJ_SCALE_X;
    const ny = (v * 2.0 - 1.0) * PROJ_SCALE_Y;
    return viewDist * Math.hypot(nx, ny, -1.0);
  }

  // 3A. Verify depth decode accuracy for Reversed-Z and LogDepth across 30 m..4200 m
  for (const [modeName, rev, logD] of [["Reversed-Z", true, false], ["LogDepth", false, true]]) {
    let maxRelErr = 0;
    for (const viewDist of [25, 150, 300, 950, 2400, 4200]) {
      const u = 0.73, v = 0.64;
      const rayFactor = Math.hypot((u * 2 - 1) * PROJ_SCALE_X, (v * 2 - 1) * PROJ_SCALE_Y, -1);
      const expectedRayDist = viewDist * rayFactor;
      const raw = encodeRawDepth(viewDist, rev, logD);
      const got = hbSceneRayDist(raw, u, v, rev, logD);
      maxRelErr = Math.max(maxRelErr, Math.abs(got - expectedRayDist) / expectedRayDist);
    }
    check(`hbSceneRayDist decodes exact scene ray distance under ${modeName}`,
      maxRelErr < 1e-5, `maxRelErr=${maxRelErr}`);
  }

  // Faithful port of hbEdgeResolve from scene3d/cloud_edge_resolve.js
  function evalHbEdgeResolve({
    x, y, W, H, LW, LH, frame, jitterOffset, uvScale,
    sampleRawDepthAtUv, samplePrevSkyAtUv, colorFetch, dvFetch, colorBilinear, historyBilinear,
    reversedZ, logDepth, edgeGamma = 2.0,
  }) {
    const u = (x + 0.5) / W, v = (y + 0.5) / H;
    const minUvX = 0.5 / W, minUvY = 0.5 / H;
    const maxUvX = 1.0 - minUvX, maxUvY = 1.0 - minUvY;
    const rawSelf = sampleRawDepthAtUv(u, v);
    const selfSky = hbIsSky(rawSelf, reversedZ);
    const selfRayDist = selfSky ? 1e7 : hbSceneRayDist(rawSelf, u, v, reversedZ, logDepth);
    const lowResX = x >> 2, lowResY = y >> 2;
    const lowUvX = clampF(u / uvScale[0], 0, 1), lowUvY = clampF(v / uvScale[1], 0, 1);
    const hbCurrent = BAYER[(y % 4) * 4 + (x % 4)] === (frame % 16);

    const nSky = new Array(9);
    let other = 0;
    let centerRaySky = false;
    for (let i = 0; i < 9; i++) {
      const ncx = clampI(lowResX + OFFS[i][0], 0, LW - 1);
      const ncy = clampI(lowResY + OFFS[i][1], 0, LH - 1);
      const lowMarchX = (ncx + 0.5 + jitterOffset[0] * 0.25) / LW;
      const lowMarchY = (ncy + 0.5 + jitterOffset[1] * 0.25) / LH;
      const marchU = clampF(lowMarchX * uvScale[0], minUvX, maxUvX);
      const marchV = clampF(lowMarchY * uvScale[1], minUvY, maxUvY);
      nSky[i] = hbIsSky(sampleRawDepthAtUv(marchU, marchV), reversedZ);
      if (i === 4) {
        centerRaySky = nSky[4];
        if (!centerRaySky && (uvScale[0] > 1.0001 || uvScale[1] > 1.0001)) {
          centerRaySky = hbIsSky(sampleRawDepthAtUv(clampF(lowMarchX, minUvX, maxUvX), clampF(lowMarchY, minUvY, maxUvY)), reversedZ);
        }
      }
      if (nSky[i] !== selfSky) other += 1;
    }

    let closest = [1e7, 0, 0];
    for (let i = 0; i < 9; i++) {
      const dv = dvFetch(clampI(lowResX + OFFS[i][0], 0, LW - 1), clampI(lowResY + OFFS[i][1], 0, LH - 1));
      if (dv[0] < closest[0]) closest = dv;
    }

    if (hbCurrent) {
      if (selfSky) {
        const cLowX = clampF((lowResX + 0.5 + jitterOffset[0] * 0.25) / LW, minUvX, maxUvX);
        const cLowY = clampF((lowResY + 0.5 + jitterOffset[1] * 0.25) / LH, minUvY, maxUvY);
        const rayAlsoSky = (uvScale[0] <= 1.0001 && uvScale[1] <= 1.0001) || hbIsSky(sampleRawDepthAtUv(cLowX, cLowY), reversedZ);
        if (nSky[4] && rayAlsoSky) return { handled: false, color: null };
      } else {
        const curCol = colorFetch(lowResX, lowResY);
        const curFront = dvFetch(lowResX, lowResY)[0];
        if (!nSky[4] && !centerRaySky && (curCol[3] <= 1e-4 || curFront <= selfRayDist + 8.0)) {
          return { handled: false, color: null };
        }
      }
    }

    if (other < 0.5 && !hbCurrent) {
      if (!selfSky) {
        const centerCol = colorFetch(lowResX, lowResY);
        const centerFront = dvFetch(lowResX, lowResY)[0];
        if (centerCol[3] > 1e-4 && centerFront > selfRayDist + 8.0) {
          return { handled: true, color: [0, 0, 0, 0] };
        }
      }
      const prevU = u - closest[1], prevV = v - closest[2];
      if (prevU < 0 || prevU > 1 || prevV < 0 || prevV > 1) return { handled: false, color: null };
      if (samplePrevSkyAtUv(prevU, prevV) === selfSky) return { handled: false, color: null };
      const c = colorBilinear(lowUvX, lowUvY);
      if (!selfSky && c[3] > 1e-4 && closest[0] > selfRayDist + 8.0) return { handled: true, color: [0, 0, 0, 0] };
      return { handled: true, color: c };
    }

    const m1 = [0, 0, 0, 0], m2 = [0, 0, 0, 0];
    let n = 0;
    let best = [1e7, 0, 0];
    for (let i = 0; i < 9; i++) {
      if (nSky[i] !== selfSky) continue;
      const ncx = clampI(lowResX + OFFS[i][0], 0, LW - 1);
      const ncy = clampI(lowResY + OFFS[i][1], 0, LH - 1);
      let c = colorFetch(ncx, ncy);
      const dv = dvFetch(ncx, ncy);
      if (!selfSky && c[3] > 1e-4 && dv[0] > selfRayDist + 8.0) c = [0, 0, 0, 0];
      for (let k = 0; k < 4; k++) { m1[k] += c[k]; m2[k] += c[k] * c[k]; }
      n += 1;
      if (dv[0] < best[0]) best = dv;
    }
    if (n < 0.5) {
      if (!selfSky) {
        const fgSum = [0, 0, 0, 0];
        let fgCount = 0;
        for (let i = 0; i < 9; i++) {
          const ncx = clampI(lowResX + OFFS[i][0], 0, LW - 1);
          const ncy = clampI(lowResY + OFFS[i][1], 0, LH - 1);
          const c = colorFetch(ncx, ncy);
          const dv = dvFetch(ncx, ncy);
          if (c[3] > 1e-4 && dv[0] + 4.0 < selfRayDist) {
            for (let k = 0; k < 4; k++) fgSum[k] += c[k];
            fgCount += 1;
          }
        }
        return { handled: true, color: fgCount > 0.5 ? fgSum.map((s) => s / fgCount) : [0, 0, 0, 0] };
      }
      return { handled: false, color: null };
    }
    const mean = m1.map((s) => s / n);
    const prevU = u - best[1], prevV = v - best[2];
    if (prevU < 0 || prevU > 1 || prevV < 0 || prevV > 1 || samplePrevSkyAtUv(prevU, prevV) !== selfSky) {
      return { handled: true, color: mean };
    }
    const ext = mean.map((mu, k) => Math.sqrt(Math.max(m2[k] / n - mu * mu, 0)) * edgeGamma);
    const hist = historyBilinear(prevU, prevV);
    const vv = hist.map((hv, k) => hv - mean[k]);
    const mu = Math.max(...vv.map((d, k) => Math.abs(d) / (ext[k] + 1e-7)));
    return { handled: true, color: mu > 1 ? mean.map((mm, k) => mm + vv[k] / mu) : hist };
  }

  // 3B. Sub-4px narrow hilltop / spire / tree branch (2 px wide at 280 m) surrounded by 2400 m clouds:
  // Even when ALL 9 low-res Bayer samples miss the 2 px spire (n == 0), !selfSky MUST output vec4(0)!
  {
    const W = 48, H = 48, LW = 12, LH = 12;
    let worstSpireAlpha = 0;
    for (let f = 0; f < 16; f++) {
      const [sx, sy] = slot(f);
      // Place a 1 px spire on a sub-pixel column that is NOT hit by this frame's Bayer slot (sx + 1) % 4
      const spireSubX = (sx + 2) % 4;
      const isSpire = (x, y) => (x === 24 + spireSubX) && (y >= 16 && y <= 32);
      const rawDepthAtUv = (u, v) => {
        const px = clampI(Math.floor(u * W), 0, W - 1);
        const py = clampI(Math.floor(v * H), 0, H - 1);
        return encodeRawDepth(isSpire(px, py) ? 280.0 : Infinity, true, false);
      };
      // Every low-res block marched at (4*lx + sx, 4*ly + sy), which NEVER hits 24 + spireSubX -> all sky cloud!
      const res = evalHbEdgeResolve({
        x: 24 + spireSubX, y: 24, W, H, LW, LH, frame: f,
        jitterOffset: [sx + 0.5 - 2, sy + 0.5 - 2],
        uvScale: [1, 1],
        sampleRawDepthAtUv: rawDepthAtUv,
        samplePrevSkyAtUv: () => true,
        colorFetch: () => [0.9, 0.92, 0.95, 0.96],
        dvFetch: () => [2400, 0, 0],
        colorBilinear: () => [0.9, 0.92, 0.95, 0.96],
        historyBilinear: () => [0.9, 0.92, 0.95, 0.96],
        reversedZ: true, logDepth: false,
      });
      const outCol = res.handled ? res.color : [0.9, 0.92, 0.95, 0.96]; // old code returned handled=false -> sky cloud!
      worstSpireAlpha = Math.max(worstSpireAlpha, outCol[3]);
    }
    check("sub-4px narrow hilltop/spire/tree-top (280 m) where all 9 Bayer taps hit 2400 m sky cloud -> alpha === 0",
      worstSpireAlpha === 0, `worstSpireAlpha=${worstSpireAlpha}`);
  }

  // 3C. Distant 4200 m high mountain peak behind a 1100 m foreground cloud vs 350 m near foothill
  {
    const W = 48, H = 48, LW = 12, LH = 12;
    const [sx, sy] = slot(3);
    const makeCase = (terrainViewDist) => evalHbEdgeResolve({
      x: 24 + ((sx + 2) % 4), y: 24, W, H, LW, LH, frame: 3,
      jitterOffset: [sx + 0.5 - 2, sy + 0.5 - 2],
      uvScale: [1, 1],
      sampleRawDepthAtUv: (u, v) => {
        const px = clampI(Math.floor(u * W), 0, W - 1), py = clampI(Math.floor(v * H), 0, H - 1);
        return (px === 24 + ((sx + 2) % 4) && py === 24)
          ? encodeRawDepth(terrainViewDist, false, true) // test LogDepth path too!
          : encodeRawDepth(Infinity, false, true);
      },
      samplePrevSkyAtUv: () => true,
      colorFetch: () => [0.72, 0.75, 0.80, 0.85],
      dvFetch: () => [1100.0, 0, 0], // foreground low cloud at 1100 m
      colorBilinear: () => [0.72, 0.75, 0.80, 0.85],
      historyBilinear: () => [0.72, 0.75, 0.80, 0.85],
      reversedZ: false, logDepth: true,
    });
    const peakBehindCloud = makeCase(4200.0);
    const foothillInFront = makeCase(350.0);
    check("foreground cloud (1100 m) genuinely IN FRONT OF distant 4200 m peak is preserved",
      peakBehindCloud.handled && Math.abs(peakBehindCloud.color[3] - 0.85) < 1e-6,
      `got=${JSON.stringify(peakBehindCloud)}`);
    check("same 1100 m cloud BEHIND a 350 m foreground foothill is strictly occluded (alpha === 0)",
      foothillInFront.handled && foothillInFront.color[3] === 0,
      `got=${JSON.stringify(foothillInFront)}`);
  }

  // 3D. Non-multiple-of-4 viewport (W=66, H=50 -> LW=17, LH=13, targetUvScale = [68/66, 52/50]):
  // On `currentFrame`, `lowMarchUv` (the unscaled ray UV in clouds.vert) sits ~1.5 px BELOW `vUv`
  // or a clamped edge tap sits on sky while `vUv` is on a 320 m hill!
  {
    const W = 66, H = 50, LW = Math.ceil(W / 4), LH = Math.ceil(H / 4);
    const uvScale = [(LW * 4) / W, (LH * 4) / H];
    // Hill covers y <= 38 (v <= 39/50 = 0.78), sky is y >= 39.
    // At y = 38 (on the 320 m hill!), test a frame where y = 38 is `currentFrame`, AND suppose
    // the low-res block marched sky cloud (alpha = 1.0, dv = 2100 m) due to 1-2 px non-div-4 offset.
    const yHill = 38, xHill = 50;
    const targetBayer = BAYER[(yHill % 4) * 4 + (xHill % 4)];
    const [sx, sy] = slot(targetBayer);
    const res = evalHbEdgeResolve({
      x: xHill, y: yHill, W, H, LW, LH, frame: targetBayer,
      jitterOffset: [sx + 0.5 - 2, sy + 0.5 - 2],
      uvScale,
      sampleRawDepthAtUv: (_u, v) => {
        const py = clampI(Math.floor(v * H), 0, H - 1);
        return encodeRawDepth(py <= 38 ? 320.0 : Infinity, true, false);
      },
      samplePrevSkyAtUv: (_u, v) => Math.floor(v * H) > 38,
      // Simulate non-div-4 ray mismatch where lowResCoord (12, 9) marched a sky cloud 1.5 px above crest:
      colorFetch: (_lx, ly) => (ly >= 9 ? [0.9, 0.92, 0.96, 1.0] : [0, 0, 0, 0]),
      dvFetch: (_lx, ly) => (ly >= 9 ? [2100.0, 0, 0] : [320.0, 0, 0]),
      colorBilinear: () => [0, 0, 0, 0],
      historyBilinear: () => [0, 0, 0, 0],
      reversedZ: true, logDepth: false,
    });
    // Because hbEdgeResolve runs BEFORE `if (currentFrame)` AND checks `curFront <= selfRayDist + 8.0`,
    // `curFront = 2100 > 320 + 8` intercepts `currentFrame` and zeroes the sky cloud on the hill!
    check("non-multiple-of-4 viewport (66x50): currentFrame sky ray mismatch on 320 m hill is intercepted -> alpha === 0",
      res.handled === true && res.color[3] === 0, `got=${JSON.stringify(res)}`);
  }
}

// ---------------------------------------------------------------------------
console.log("-- T4 AerialPerspectiveEffect depth-before-overlay & sub-cloud guard --------");
{
  // Faithful CPU port of AerialPerspectiveEffect mainImage (vendor/takram/three-atmosphere.js)
  const BOTTOM_RADIUS_KM = 6360.0;
  const METER_TO_LENGTH_UNIT = 0.001;

  function evalAerialOverlay({
    rawDepth, reversedZ, cameraWorldY, surfaceWorldY, anchorY = 0,
    terrainRadiance = [0.20, 0.26, 0.14], skyRadiance = [0.32, 0.48, 0.78],
    overlay = [0.90, 0.92, 0.96, 1.0],
  }) {
    const depth = reversedZ ? (1.0 - rawDepth) : rawDepth;
    const isSkyDepth = depth >= 1.0 - 1e-8;
    let ov = overlay.slice();

    if (isSkyDepth && ov[3] === 1.0) {
      return { earlyReturn: true, rgb: [ov[0], ov[1], ov[2]] };
    }
    if (isSkyDepth) {
      return {
        earlyReturn: false,
        rgb: skyRadiance.map((s, k) => s * (1.0 - ov[3]) + ov[k]),
      };
    }

    // Reconstruct ECEF in km using worldToECEFMatrix translation (0, bottomRadius - anchorY, 0)
    const camEcefYKm = (cameraWorldY + (6360000.0 - anchorY)) * METER_TO_LENGTH_UNIT;
    const surfEcefYKm = (surfaceWorldY + (6360000.0 - anchorY)) * METER_TO_LENGTH_UNIT;
    const hbCameraHeightM = (camEcefYKm - BOTTOM_RADIUS_KM) / METER_TO_LENGTH_UNIT;
    const hbSurfaceHeightM = (surfEcefYKm - BOTTOM_RADIUS_KM) / METER_TO_LENGTH_UNIT;

    if (Math.max(hbCameraHeightM, hbSurfaceHeightM) < 550.0) {
      ov = [0, 0, 0, 0];
    }
    return {
      earlyReturn: false,
      rgb: terrainRadiance.map((r, k) => r * (1.0 - ov[3]) + ov[k]),
    };
  }

  // 1. Sky pixel with opaque cloud (overlay.a == 1.0) still takes fast early return
  const skyOpaque = evalAerialOverlay({
    rawDepth: 0.0, reversedZ: true, cameraWorldY: 45, surfaceWorldY: 0,
    overlay: [0.91, 0.93, 0.97, 1.0],
  });
  check("sky pixel with overlay.a == 1.0 fast-returns opaque cloud colour",
    skyOpaque.earlyReturn === true && Math.abs(skyOpaque.rgb[0] - 0.91) < 1e-6);

  // 2. Sub-cloud hill (180 m) with opaque overlay.a == 1.0 bleed (old shader returned white cloud before reading depth!)
  const hillOpaqueBleed = evalAerialOverlay({
    rawDepth: 0.0004, reversedZ: true, cameraWorldY: 45, surfaceWorldY: 180,
    terrainRadiance: [0.20, 0.26, 0.14], overlay: [0.91, 0.93, 0.97, 1.0],
  });
  check("sub-cloud hill (180 m) with overlay.a == 1.0 bleed does NOT early-return and preserves 100% terrain radiance",
    hillOpaqueBleed.earlyReturn === false &&
    Math.abs(hillOpaqueBleed.rgb[0] - 0.20) < 1e-6 &&
    Math.abs(hillOpaqueBleed.rgb[1] - 0.26) < 1e-6 &&
    Math.abs(hillOpaqueBleed.rgb[2] - 0.14) < 1e-6);

  // 3. Sub-cloud hill (310 m) with ?cloudResScale=0.5 bilinear upsample fringe (overlay.a = 0.5)
  const hillBilinearBleed = evalAerialOverlay({
    rawDepth: 0.985, reversedZ: false, cameraWorldY: 60, surfaceWorldY: 310,
    terrainRadiance: [0.18, 0.22, 0.12], overlay: [0.45, 0.46, 0.48, 0.5],
  });
  check("sub-cloud hill (310 m) with ?cloudResScale=0.5 bilinear fringe (a=0.5) zeroes overlay bleed",
    Math.abs(hillBilinearBleed.rgb[0] - 0.18) < 1e-6 &&
    Math.abs(hillBilinearBleed.rgb[1] - 0.22) < 1e-6);

  // 4. High-altitude aircraft (1800 m) looking down at 40 m ground through clouds (overlay.a = 0.75 premultiplied)
  const aircraftDown = evalAerialOverlay({
    rawDepth: 0.0001, reversedZ: true, cameraWorldY: 1800, surfaceWorldY: 40,
    terrainRadiance: [0.20, 0.26, 0.14], overlay: [0.60, 0.62, 0.66, 0.75],
  });
  check("high-altitude aircraft (1800 m) looking down at 40 m ground preserves clouds below camera",
    Math.abs(aircraftDown.rgb[0] - (0.20 * 0.25 + 0.60)) < 1e-6);

  // 5. High mountain peak (920 m) viewed from 60 m with genuine foreground low cloud
  const highPeak = evalAerialOverlay({
    rawDepth: 0.00005, reversedZ: true, cameraWorldY: 60, surfaceWorldY: 920,
    terrainRadiance: [0.25, 0.25, 0.28], overlay: [0.70, 0.72, 0.76, 0.80],
  });
  check("high mountain peak (920 m >= 550 m) preserves genuine foreground low-cloud overlay",
    Math.abs(highPeak.rgb[0] - (0.25 * 0.20 + 0.70)) < 1e-6);

  // 6. Northern Dereth / Dericost plateau with anchorY = 300 m (cameraWorldY = 350 -> 50 m rel, hillWorldY = 520 -> 220 m rel)
  const dericostHill = evalAerialOverlay({
    rawDepth: 0.0003, reversedZ: true, cameraWorldY: 350, surfaceWorldY: 520, anchorY: 300,
    terrainRadiance: [0.28, 0.24, 0.19], overlay: [0.85, 0.87, 0.90, 0.95],
  });
  check("northern Dereth ECEF anchorY shift (anchorY=300 m) still zeroes sub-cloud hill bleed",
    Math.abs(dericostHill.rgb[0] - 0.28) < 1e-6);
}

// ---------------------------------------------------------------------------
console.log("-- T5 clouds.frag #ifdef HAZE terrain suppression ---------------------------");
{
  const shouldApplyCloudHaze = ({ hitClouds, intersectsScene, rayDistanceToScene }) =>
    hitClouds || (!intersectsScene && rayDistanceToScene <= 0.0);

  check("upward ray hitting 1200 m hill before cloud base (intersectsScene=true, hitClouds=false) -> NO cloud haze",
    shouldApplyCloudHaze({ hitClouds: false, intersectsScene: true, rayDistanceToScene: 1200 }) === false);
  check("downward ray hitting 900 m hillside/valley (intersectsGround=true, intersectsScene=false, rayDistanceToScene=900) -> NO cloud haze",
    shouldApplyCloudHaze({ hitClouds: false, intersectsScene: false, rayDistanceToScene: 900 }) === false);
  check("clear sky ray (hitClouds=false, intersectsScene=false, rayDistanceToScene=0) -> cloud haze preserved",
    shouldApplyCloudHaze({ hitClouds: false, intersectsScene: false, rayDistanceToScene: 0 }) === true);
  check("cloud hit ray in front of sky or distant mountain (hitClouds=true) -> cloud haze preserved",
    shouldApplyCloudHaze({ hitClouds: true, intersectsScene: false, rayDistanceToScene: 3800 }) === true);
}

// ---------------------------------------------------------------------------
console.log("-- T6 live CloudsEffect / CloudsMaterial / AerialPerspectiveEffect checks ----");
{
  const cam = new THREE.PerspectiveCamera(60, 1366 / 765, 0.1, 5000);
  cam.updateProjectionMatrix();
  const effect = new CloudsEffect(cam);
  const cp = effect.cloudsPass;
  const cm = cp.currentMaterial;
  const rm = cp.resolveMaterial;

  // 1. Verify USE_LOGARITHMIC_DEPTH_BUFFER triggers Three.js Material program recompile
  // (`this.needsUpdate = true` increments `material.version` on THREE.Material!)
  delete cm.defines.USE_LOGARITHMIC_DEPTH_BUFFER;
  const v0 = cm.version;
  cm.onBeforeRender({
    capabilities: { logarithmicDepthBuffer: true },
    state: { buffers: { depth: { getReversed: () => false } } },
  });
  const v1 = cm.version;
  check("CloudsMaterial.onBeforeRender (false -> true): sets USE_LOGARITHMIC_DEPTH_BUFFER='1' AND increments version via needsUpdate=true",
    cm.defines.USE_LOGARITHMIC_DEPTH_BUFFER === "1" && v1 > v0, `v0=${v0} -> v1=${v1}`);

  cm.onBeforeRender({
    capabilities: { logarithmicDepthBuffer: false },
    state: { buffers: { depth: { getReversed: () => false } } },
  });
  const v2 = cm.version;
  check("CloudsMaterial.onBeforeRender (true -> false): deletes USE_LOGARITHMIC_DEPTH_BUFFER AND increments version via needsUpdate=true",
    cm.defines.USE_LOGARITHMIC_DEPTH_BUFFER === undefined && v2 > v1, `v1=${v1} -> v2=${v2}`);

  // 2. Verify CloudsPass.setSize on non-multiple-of-4 viewport syncs targetUvScale to resolveMaterial
  cp.setSize(1366, 765);
  check("CloudsPass.setSize(1366, 765) syncs non-multiple-of-4 targetUvScale (1368/1366, 768/765) to resolveMaterial",
    Math.abs(rm.uniforms.targetUvScale.value.x - 1368 / 1366) < 1e-6 &&
    Math.abs(rm.uniforms.targetUvScale.value.y - 768 / 765) < 1e-6);
  check("CloudsResolveMaterial initializes cameraFar uniform",
    rm.uniforms.cameraFar && Number.isFinite(rm.uniforms.cameraFar.value));

  // 3. Verify installCloudEdgeResolve on a real CloudsEffect instance
  const dummyDepth = new THREE.DepthTexture(1366, 765);
  cp.setDepthTexture(dummyDepth, 0);
  const handle = installCloudEdgeResolve(effect, THREE);
  check("installCloudEdgeResolve succeeds on a real CloudsEffect instance", !!handle);
  check("real resolveMaterial compiled source has hbEdgeResolve BEFORE if (currentFrame)",
    rm.fragmentShader.indexOf("if (hbEdgeResolve(lowResCoord, depthVelocity, hbColor))") > 0 &&
    rm.fragmentShader.indexOf("if (currentFrame)") > rm.fragmentShader.indexOf("if (hbEdgeResolve(lowResCoord, depthVelocity, hbColor))"));

  // 4. Verify real AerialPerspectiveEffect fragmentShader carries our depth-first + sub-cloud guard
  const aerial = new AerialPerspectiveEffect(cam);
  check("real AerialPerspectiveEffect instance fragmentShader carries isSkyDepth && overlay.a == 1.0 + 550 m sub-cloud guard",
    aerial.fragmentShader.includes("if (isSkyDepth && overlay.a == 1.0)") &&
    aerial.fragmentShader.includes("if (max(hbCameraHeightM, hbSurfaceHeightM) < 550.0)"));

  handle?.dispose();
  dummyDepth.dispose();
  aerial.dispose?.();
  effect.dispose?.();
}

console.log(`\nclouds_terrain_occlusion: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
