// scene3d/atmosphere_pipeline.js — Sky-K.2 main-scene composer.
//
// Wraps the main world render in a pmndrs `EffectComposer` and inserts
// takram's `AerialPerspectiveEffect` + a `DitheringEffect` between the
// world RenderPass and the canvas output. Uses pmndrs' postprocessing
// package (AerialPerspectiveEffect extends pmndrs' Effect, not three's).
//
// Composer order:
//   1. (optional) sky RenderPass — paints sky scene with its own camera.
//      `enabled` flips per-frame via `preFrameSkySync` to match the
//      indoor short-circuit (SkyDome._lastIsIndoor).
//   2. world RenderPass — `clear=false, clearDepth=true` when sky pass
//      is present (mirrors the direct path's autoClear gymnastics).
//   3. EffectPass(AerialPerspectiveEffect, DitheringEffect) —
//      - AerialPerspective tints world pixels by distance using the
//        Bruneton lookup tables from AtmosphereRuntime
//      - Dithering kills banding in the resulting gradients
//
// Cloud overlay coexistence: cloud overlay's `preRender` runs BEFORE
// `composer.render`, and `renderOverlay` AFTER. Clouds appear
// depth-UNAWARE relative to world geometry on this path (overlay
// quad draws after the composer's final pass); depth-correct cloud
// occlusion is a follow-on cleanup.
//
// ECEF setup: takram defaults to WGS-84 ellipsoid + `correctAltitude=true`
// which doesn't match our spherical (bottomRadius=6.36M) setup — the
// altitude-correction offset pushes the camera 18 km "underground" each
// frame. Apply the same fix CloudVolume already uses:
//   worldToECEFMatrix = translate(0, bottomRadius, 0)
//   correctAltitude   = false

import * as THREE from "three";
import {
  BloomEffect,
  ClearPass,
  Effect,
  EffectAttribute,
  EffectComposer,
  EffectPass,
  Pass,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  VignetteTechnique,
} from "postprocessing";
import { AerialPerspectiveEffect, AtmosphereParameters } from "@takram/three-atmosphere";
import { DitheringEffect, LensFlareEffect } from "@takram/three-geospatial-effects";
import { PortalStencilPass } from "./portal_stencil.js";
import { PortalPunchPass } from "./portal_punch.js";
import { createHeatHazeEffect, installHeatHazeHandle } from "./vfx/heat_haze_effect.js";

// Phase 5 PView render-order fix (2026-05-25) — layer-mask constants.
// Mirrors `scene3d/index.js` (RENDER_LAYER_WORLD/RENDER_LAYER_INDOOR).
// Layer 0 = terrain + outdoor buildings + outdoor statics.
// Layer 1 = EnvCells + entities. Both layers enabled for outdoor;
// layer 0 then layer 1 (with a depth-clear between) for indoor.
const CAM_LAYER_MASK_BOTH = (1 << 0) | (1 << 1);
const CAM_LAYER_MASK_WORLD_ONLY = (1 << 0);
const CAM_LAYER_MASK_INDOOR_ONLY = (1 << 1);

/**
 * Tiny pmndrs Pass subclass that sets the camera's layer mask before the
 * next downstream RenderPass executes. Holds no GPU state — just mutates
 * the shared camera reference. needsSwap=false so the composer keeps using
 * the same input/output buffers across the mask switch.
 *
 * Used to split a single indoor frame into:
 *   1. world pass  (mask = WORLD_ONLY)  → terrain/buildings/statics
 *   2. depth clear pass                 → wipe terrain Z so cottage floors
 *                                          don't Z-fight terrain underneath
 *   3. cells pass  (mask = INDOOR_ONLY) → EnvCells + entities
 * Mirrors `WB.GameScene.cs:1610`'s `gl.Clear(ClearBufferMask.DepthBufferBit)`
 * between RenderTerrain and EnvCellManager.Render.
 */
class CameraLayerMaskPass extends Pass {
  constructor(camera, mask, label = "CameraLayerMask") {
    super(label);
    this.camera = camera;
    this.mask = mask;
    this.needsSwap = false;
  }
  // Empty render — the visible effect is the side-effect on the camera.
  render(_renderer, _inputBuffer, _outputBuffer, _deltaTime, _stencilTest) {
    if (this.camera && this.camera.layers) {
      this.camera.layers.mask = this.mask;
    }
  }
  setCamera(cam) {
    if (cam) this.camera = cam;
  }
}

// Job A — horizon edge-dissolve band, in AC metres of eye-forward distance.
// The terrain stream ring is ~radius-6 (6 LB × 192 m ≈ 1152 m) so geometry is
// fully dissolved into the sky by END; START keeps the inner ~4-LB view crisp
// (the user wants to still "see far", just not the hard ring edge). Tunable
// live on the 1070 via `window.__horizonFade.{start,end}` (no rebuild).
const HORIZON_DISSOLVE_START_M = 820;
const HORIZON_DISSOLVE_END_M = 1150;

// ---------------------------------------------------------------------------
// AERIAL DEPTH (2026-08-02, ?aerialDepth — DEFAULT ON, escape ?aerialDepth=off)
// ---------------------------------------------------------------------------
// WHY THIS IS NOT ALREADY HAPPENING. `AerialPerspectiveEffect` (takram/Bruneton)
// IS in the chain with `transmittance`/`inscatter` on — but it is a PHYSICAL
// Earth atmosphere, and physical Rayleigh scattering over the ~1 km that is the
// entire visible extent of Dereth is very close to nothing. Worse, its
// `sunDirection` is never written by anything in this repo (`setSunDirection`
// below has exactly zero call sites), so it has no time-of-day term either.
// Measured on the 1070 at a 900 m sightline: distant terrain came back with the
// same saturation and the same value as terrain 30 m from the camera. That flat
// read is half of what makes far Dereth look painted rather than distant.
//
// This is therefore a deliberate ART aerial perspective layered on top: past
// AERIAL_START_M the frame loses chroma and washes toward the captured physical
// sky in its own view direction, on a gamma curve, saturating at AERIAL_MAX so
// distant terrain is always still READ as terrain. The horizon dissolve above
// then takes the last few hundred metres to 1.0 as before.
//
// Blending toward the CAPTURED SKY rather than a fog colour is what keeps this
// honest at every hour: at noon it is a cool blue-grey wash, at dusk it warms
// on its own, and at night it goes deep blue — no authored fog ramp to maintain
// and no seam against the real sky.
// 1070-tuned 2026-08-02 against the Holtburg north sightline (`GRID-AE2-*`):
// swept aerialEnd 1000/600/450/350 and max 0.55/0.70. 1000 m was almost
// invisible — Dereth's whole visible extent is ~1 km, so a ramp sized for an
// Earth horizon has nothing to work with. 480 m puts the far shore (~350-450 m
// from the Holtburg overlook) at a real haze weight while leaving the town
// itself untouched; 350 m started greying the near-field grass.
const AERIAL_START_M = 80;
const AERIAL_END_M = 480;
/** Ceiling on the sky blend before the dissolve takes over.
 *
 * 2026-08-02 FAR-TERRAIN S1 — **0.62 -> 0.0, i.e. NUMERICALLY INERT.**
 * The shipped desaturate-and-cool wash is user-rejected, and the ground-truth
 * measurements explain why it could never have worked: its strength is INVERTED
 * with distance (per-row MAD on/off at four vantages: 0.00-2.46 on the FARTHEST
 * terrain rows vs 15.7-27.7 on the mid-field), because the ramp saturates at
 * `AERIAL_END_M` 480 m and the pass cannot reach past 833.4 m at all (the
 * `depth >= 0.9999` guard with near 0.1 / far 5000). So it greyed the mid-ground
 * while the horizon silhouette kept full chroma — the exact opposite of aerial
 * perspective. It was also tuned against frames whose "distance" was the takram
 * sky's dark planet GROUND standing in for absent landblocks, not Dereth.
 *
 * The replacement is retail's own mechanism: authored linear RANGE FOG out of
 * the DAT, monotone in distance by construction, in world space with real depth
 * (scene3d/terrain_shared_glsl.js + loop.js::tickDistanceFogColor).
 *
 * The code, the `?aerialDebug` harness and the sweep knobs all stay. Getting
 * the old look back for an A/B is
 *   `?aerialDepth=on&aerialMax=0.62&aerialDesat=0.72`.
 */
const AERIAL_MAX = 0.0;
/** >1 keeps the near-mid field crisp and loads the effect into the far field. */
const AERIAL_CURVE = 1.15;
/** Extra chroma loss on top of the sky blend. Real aerial perspective kills
 *  saturation faster than it kills luminance contrast; without this the
 *  distance just gets paler rather than hazier.
 *
 *  2026-08-02 FAR-TERRAIN S1 — **0.72 -> 0.0, inert.** Same verdict as
 *  AERIAL_MAX above, plus one specific defect: nothing in the term was
 *  surface-aware, so it desaturated WATER as hard as land — the Holtburg river
 *  went from bright cyan to murky grey-green. Retail's fog desaturates nothing
 *  selectively. `?aerialDesat=0.72` restores it for an A/B. */
const AERIAL_DESAT = 0.0;
/** Screen-UV lift of the sky sample toward the horizon band. See hbSkyLift. */
const AERIAL_SKY_LIFT = 0.05;

// pmndrs Effect fragment. Runs inside fxPass in HDR (before ToneMapping) so the
// blend is in the same radiance space as the captured sky. Depth arrives RAW
// from the logarithmicDepthBuffer (index.js:768) — decoded to metres here;
// treating it as linear would place the band at a wildly wrong distance.
const HORIZON_DISSOLVE_FRAG = /* glsl */ `
uniform sampler2D hbSkyBuffer;
uniform float hbDissolveStart;
uniform float hbDissolveEnd;
uniform float hbEnabled;
uniform float hbAerialStart;
uniform float hbAerialEnd;
uniform float hbAerialMax;
uniform float hbAerialCurve;
uniform float hbAerialDesat;
// ?aerialDebug=on / window.__aerial.debug = 1 — write the DECODED eye-forward
// distance into the frame as a 1 km-per-unit ramp (R = dist/1000). Kept in the
// shipped shader on purpose: the 2026-07-06 horizon dissolve was left OFF for a
// month with "the log-depth decode is unvalidated on a real GPU" as the stated
// reason, and there was no way to check it. Now there is: screenshot with the
// flag on and read the red channel.
uniform float hbDebugDist;
// Screen-space upward lift applied to the sky sample, in UV. The takram sky
// pass renders the planet GROUND below the horizon (ground=true), which is dark
// -- but the correct haze colour for a near-horizontal sightline is the
// in-scattered HORIZON sky, which is bright. Sampling the pixel's own direction
// therefore washed distant terrain toward a dark band instead of a luminous
// haze. Lifting the sample toward the horizon band fixes that for one add.
uniform float hbSkyLift;

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  // === DEPTH SANITY HARNESS (fix round 2026-08-03, validator defect 6) =====
  // FIRST, before every other branch, so the harness answers even indoors and
  // never depends on the dissolve/aerial terms being enabled (both ship inert).
  // It is a BINARY read, not a gradient to eyeball:
  //   BLACK       = the pixel has NO world depth. It is sky / cleared far.
  //   B channel   = 0.08 constant marker. Non-black blue means WORLD GEOMETRY,
  //                 which is the whole question for the far composite ring.
  //   R channel   = 0.16 * clamp(eye-forward distance / 2000 m).
  //   G channel   = 100 m banding, for reading distance off the frame by eye.
  // The 0.16 amplitude is deliberate: the composer applies exposure 5 then AGX,
  // so a 0..0.8 ramp would land almost entirely in AGX's shoulder (measured:
  // 0.1 -> 174/255, 0.7 -> 237/255, i.e. 63 levels for 1200 m). 0.16 keeps the
  // whole ramp in AGX's responsive range and well under the BloomEffect
  // luminanceThreshold of 0.85, so bloom does not smear it either.
  if (hbDebugDist > 0.5) {
    // CALIBRATION WEDGE. Everything downstream (exposure, AGX, bloom) is a
    // monotone per-channel transfer, so a harness can invert it EXACTLY if the
    // frame carries known inputs. The top 1.5 % of the frame is a linear
    // 0.0 -> 0.16 ramp in uv.x, the same range the distance ramp below uses, so
    // reading that strip turns the R channel back into METRES instead of
    // "a redder pixel is farther away" - and it stays correct under a changed
    // ?exposure or a future tone-curve swap, with nothing to re-derive.
    if (uv.y > 0.985) {
      outputColor = vec4(vec3(0.16 * uv.x), 1.0);
      return;
    }
    if (depth >= 0.9999) {
      outputColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    float dbgDist = -getViewZ(depth);
    outputColor = vec4(
      0.16 * clamp(dbgDist / 2000.0, 0.0, 1.0),
      0.16 * fract(dbgDist / 100.0),
      0.08,
      1.0);
    return;
  }
  // Gated OFF indoors (set by preFrameSkySync): the sky pass is disabled and
  // the world pass clears colour, so there is no visible sky to dissolve into.
  if (hbEnabled < 0.5) {
    outputColor = inputColor;
    return;
  }
  // Cleared-far / sky pixels (depth == 1.0 under the log buffer) are left
  // EXACTLY as the aerial-perspective pass produced them. We only dissolve
  // real geometry into the sky behind it, never re-touch the sky itself.
  if (depth >= 0.9999) {
    outputColor = inputColor;
    return;
  }
  // Decode three.js logarithmic depth → eye-forward distance (metres):
  // forward is gl_FragDepth = log2(1.0 + (-viewZ)) * logDepthBufFC * 0.5, so
  // the inverse recovers (-viewZ) directly. Verified: depth==1.0 ⇒ dist==far.
  // 2026-08-02 — THE BUG THAT KEPT ?horizonFade OFF FOR A MONTH. This used to
  // hand-decode the logarithmic depth buffer:
  //     dist = exp2(2.0 * depth / hbLogDepthFC) - 1.0
  // pmndrs postprocessing ALREADY does that decode for us. Its EffectMaterial
  // readDepth() (postprocessing/build/index.js, effect.frag) contains
  //     #if defined(USE_LOGARITHMIC_DEPTH_BUFFER) || defined(LOG_DEPTH)
  //       float d = pow(2.0, depth*log2(cameraFar+1.0)) - 1.0;
  //       float a = cameraFar/(cameraFar-cameraNear);
  //       float b = cameraFar*cameraNear/(cameraNear-cameraFar);
  //       depth = a + b/d;
  //     #endif
  // so depth arrives as ORDINARY non-linear perspective depth. Decoding it a
  // second time as if it were still log-encoded turned 40 m of geometry into
  // ~4900 m: on the 1070 the dissolve therefore evaluated to 1.0 across the
  // whole frame and replaced the entire town with sky. Measured, not inferred
  // (?aerialDebug=on). getViewZ() is pmndrs' own helper, injected into every
  // Effect shader, and is correct for both camera types.
  float dist = -getViewZ(depth);
  float dissolve = smoothstep(hbDissolveStart, hbDissolveEnd, dist);
  // AERIAL DEPTH (2026-08-02). Gamma-curved, ceilinged ramp that starts far
  // closer than the dissolve so the whole mid-to-far field gains depth, not
  // just the stream-ring edge. hbAerialMax 0 makes this term a strict no-op
  // and the effect degenerates to the original dissolve exactly.
  float aerial = clamp((dist - hbAerialStart)
                       / max(hbAerialEnd - hbAerialStart, 1.0), 0.0, 1.0);
  aerial = pow(aerial, hbAerialCurve) * hbAerialMax;
  float f = max(dissolve, aerial);
  if (f <= 0.0) {
    outputColor = inputColor;
    return;
  }
  // hbSkyBuffer holds the physical sky rendered behind everything, so the
  // sample at this uv IS the sky in this pixel's exact view direction —
  // seam-free, no fog colour, time-of-day-correct for free. Distant geometry
  // is by construction near the horizon in screen space, so this is also very
  // close to the physically right haze colour for that sightline.
  vec2 skyUv = vec2(uv.x, min(uv.y + hbSkyLift * f, 1.0));
  vec3 skyColor = texture2D(hbSkyBuffer, skyUv).rgb;
  // Chroma loss first, then the sky blend. Doing it in this order means a
  // distant hillside desaturates toward its OWN luminance before it washes
  // toward the sky, which reads as atmosphere; blending straight to sky at the
  // same weight reads as a cross-fade to a flat colour.
  vec3 col = inputColor.rgb;
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(lum), clamp(f * hbAerialDesat, 0.0, 1.0));
  outputColor = vec4(mix(col, skyColor, f), inputColor.a);
}
`;

/**
 * Job A — horizon edge-dissolve (2026-07-06). Fades distant geometry into the
 * captured physical takram sky so the terrain stream ring stops silhouetting
 * against the horizon ("walking toward the ocean"). NOT AC fog: there is no
 * authored fog colour — the dissolve target is the real sky. `?horizonFade=off`
 * removes the effect (and its capture pass) entirely.
 */
class HorizonDissolveEffect extends Effect {
  constructor({
    skyTexture, cameraFar, start, end,
    aerialStart = AERIAL_START_M,
    aerialEnd = AERIAL_END_M,
    aerialMax = AERIAL_MAX,
    aerialCurve = AERIAL_CURVE,
    aerialDesat = AERIAL_DESAT,
    skyLift = AERIAL_SKY_LIFT,
  }) {
    super("HorizonDissolveEffect", HORIZON_DISSOLVE_FRAG, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map([
        ["hbSkyBuffer", new THREE.Uniform(skyTexture ?? null)],
        ["hbDissolveStart", new THREE.Uniform(start)],
        ["hbDissolveEnd", new THREE.Uniform(end)],
        ["hbEnabled", new THREE.Uniform(1.0)],
        ["hbAerialStart", new THREE.Uniform(aerialStart)],
        ["hbAerialEnd", new THREE.Uniform(aerialEnd)],
        ["hbAerialMax", new THREE.Uniform(aerialMax)],
        ["hbAerialCurve", new THREE.Uniform(aerialCurve)],
        ["hbAerialDesat", new THREE.Uniform(aerialDesat)],
        ["hbDebugDist", new THREE.Uniform(0.0)],
        ["hbSkyLift", new THREE.Uniform(skyLift)],
      ]),
    });
  }
  /**
   * Retained for call-site compatibility. The distance decode now comes from
   * pmndrs' own `getViewZ` (which reads `cameraNear`/`cameraFar` uniforms the
   * EffectPass maintains itself), so there is nothing left for this to set and
   * a stale `camera.far` can no longer silently mis-place the band.
   */
  setCameraFar(_far) {}
  setEnabled(on) {
    this.uniforms.get("hbEnabled").value = on ? 1.0 : 0.0;
  }
  get start() { return this.uniforms.get("hbDissolveStart").value; }
  set start(v) { this.uniforms.get("hbDissolveStart").value = v; }
  get end() { return this.uniforms.get("hbDissolveEnd").value; }
  set end(v) { this.uniforms.get("hbDissolveEnd").value = v; }
  get aerialStart() { return this.uniforms.get("hbAerialStart").value; }
  set aerialStart(v) { this.uniforms.get("hbAerialStart").value = v; }
  get aerialEnd() { return this.uniforms.get("hbAerialEnd").value; }
  set aerialEnd(v) { this.uniforms.get("hbAerialEnd").value = v; }
  get aerialMax() { return this.uniforms.get("hbAerialMax").value; }
  set aerialMax(v) { this.uniforms.get("hbAerialMax").value = v; }
  get aerialCurve() { return this.uniforms.get("hbAerialCurve").value; }
  set aerialCurve(v) { this.uniforms.get("hbAerialCurve").value = v; }
  get aerialDesat() { return this.uniforms.get("hbAerialDesat").value; }
  set aerialDesat(v) { this.uniforms.get("hbAerialDesat").value = v; }
  get skyLift() { return this.uniforms.get("hbSkyLift").value; }
  set skyLift(v) { this.uniforms.get("hbSkyLift").value = v; }
  get debug() { return this.uniforms.get("hbDebugDist").value; }
  set debug(v) { this.uniforms.get("hbDebugDist").value = v ? 1.0 : 0.0; }
}

/**
 * Re-renders the (single fullscreen-plane) sky scene into a private HDR target
 * so HorizonDissolveEffect can sample the sky behind opaque geometry.
 * needsSwap=false — it never touches the composer's ping-pong buffers, so it
 * is robust against buffer-swap timing (no CopyPass assumptions). Cost is one
 * extra fullscreen sky draw; negligible, and we have GPU headroom. `setSize`
 * is driven automatically by `composer.setSize`; `dispose` by the composer's
 * pass sweep.
 */
class SkyCapturePass extends Pass {
  constructor(skyScene, skyCamera, renderTarget) {
    super("SkyCapturePass");
    this.needsSwap = false;
    this.skyScene = skyScene;
    this.skyCamera = skyCamera;
    this.renderTarget = renderTarget;
  }
  render(renderer, _inputBuffer, _outputBuffer) {
    if (!this.skyScene || !this.skyCamera || !this.renderTarget) return;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.setRenderTarget(this.renderTarget);
    renderer.autoClear = true;
    renderer.render(this.skyScene, this.skyCamera);
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }
  setSize(width, height) {
    this.renderTarget?.setSize(width, height);
  }
  dispose() {
    this.renderTarget?.dispose();
  }
}

/**
 * Construct an atmosphere-enabled composer over the existing renderer.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {{
 *   skyScene?: THREE.Scene,
 *   skyCamera?: THREE.Camera,
 *   atmosphereRuntime: import('./atmosphere_runtime.js').AtmosphereRuntime,
 *   atmosphereParams?: AtmosphereParameters,
 *   correctGeometricError?: boolean,
 *   width?: number,
 *   height?: number,
 * }} opts
 */
export function createAtmospherePipeline(renderer, scene, camera, opts) {
  const {
    skyScene,
    skyCamera,
    atmosphereRuntime,
    atmosphereParams,
    correctGeometricError = true,
    width: optW,
    height: optH,
    bloom: bloomOpt = true,
    vignette: vignetteOpt = false,
    lensFlare: lensFlareOpt = false,
    portalStencil = false,
    portalPunch = false,
  } = opts ?? {};
  if (!atmosphereRuntime) {
    throw new Error("createAtmospherePipeline: atmosphereRuntime is required");
  }

  // Job A — horizon edge-dissolve toggle. Default OFF; `?horizonFade=on`
  // enables it. Reverted from default-ON (2026-07-06): it inserts
  // HorizonDissolveEffect into the shared fxPass and is UNVALIDATED on a real
  // GPU — if its log-depth decode diverges from the pmndrs depth on the R9 290
  // the dissolve band lands on near geometry and fades the world to sky, and a
  // shader-link failure takes the whole post-frame blank. Off = composer pass
  // list + fxPass byte-identical to the pre-feature pipeline. `opts.horizonFade`
  // (boolean) overrides the URL so headless tests can force either state.
  //
  // 2026-08-02 — DEFAULT FLIPPED TO ON, and the pass now carries the AERIAL
  // DEPTH term as well (see the AERIAL_* block above). The "unvalidated on a
  // real GPU" reservation quoted above was discharged this session: the log-
  // depth decode was checked on the 1070 (GTX 1070 / ANGLE D3D11) at a pinned
  // 19:00 across a 900 m Holtburg sightline and lands where it should. Both
  // `?horizonFade=off` and `?aerialDepth=off` remove the effect AND its
  // capture pass entirely, restoring the byte-identical pre-feature pipeline.
  //
  // === 2026-08-02 FAR-TERRAIN S1 — DEFAULT FLIPPED BACK TO **OFF**. ========
  // The horizon dissolve is KILLED as the shipping horizon mechanism, not
  // re-tuned. It is structurally dead past 833.4 m — `HorizonDissolveEffect`
  // opens with `depth >= 0.9999 -> passthrough`, which with the live
  // near 0.1 / far 5000 is a hard cutoff at 833 m (measured 831-901 m). Only
  // 820->833 m of the shipped 820->1150 m band was ever alive; whole-frame MAD
  // for dissolve-only vs off measured 0.56-2.04, i.e. noise. Re-deriving
  // START/END from a larger ring radius would put 100% of the band inside the
  // dead zone — strictly worse. Its haze target is also a screen-space sample
  // of the takram sky's dark planet GROUND, in exactly the direction distant
  // terrain lies, which is why `aerialSkyLift` had to exist.
  //
  // Retail closed its horizon with authored linear RANGE FOG (SkyDesc::
  // GetWorldFog), in world space, with real depth, reaching the full far plane.
  // That is now live on terrain, statics and models (terrain_shared_glsl.js).
  //
  // Default-off restores the byte-identical pre-feature pipeline AND drops a
  // full-res sky capture + blit per frame. The pass and the whole `?aerialDebug`
  // distance-write harness are kept for archaeology and A/B:
  //   ?horizonDissolve=on | ?horizonFade=on | ?aerialDepth=on | ?aerialDebug=on
  // Even when re-enabled the wash is inert unless aerialMax/aerialDesat are
  // given explicit values (both constants are now 0.0).
  const horizonFadeEnabled = (() => {
    if (typeof opts?.horizonFade === "boolean") return opts.horizonFade;
    try {
      if (typeof window === "undefined" || !window.location?.search) return false;
      const q = new URLSearchParams(window.location.search);
      // `?aerialDebug=on` must still build the pass — it IS the harness.
      if (q.get("aerialDebug") === "on") return true;
      for (const name of ["horizonDissolve", "horizonFade", "aerialDepth"]) {
        const v = q.get(name);
        if (typeof v !== "string") continue;
        const t = v.toLowerCase();
        if (t === "on" || t === "1" || t === "true" || t === "yes") return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  })();

  /** `?<name>=<float>` override for an aerial/dissolve tunable, else `dflt`. */
  const _aerialNum = (name, dflt) => {
    try {
      if (typeof window === "undefined" || !window.location?.search) return dflt;
      const raw = new URLSearchParams(window.location.search).get(name);
      if (raw == null || raw === "") return dflt;
      const v = Number(raw);
      return Number.isFinite(v) ? v : dflt;
    } catch (_) {
      return dflt;
    }
  };

  const atm = atmosphereParams ?? AtmosphereParameters.DEFAULT;
  const size = renderer.getSize(new THREE.Vector2());
  const width = optW ?? size.x;
  const height = optH ?? size.y;

  // HalfFloat buffers preserve HDR radiance through the chain until
  // ToneMappingEffect maps it to sRGB at the end. Without HalfFloat,
  // takram's SunDirectionalLight (which emits W/m²/sr-scale values)
  // saturates to 1.0 immediately and tone mapping has nothing to
  // recover. Takram's vanilla example uses HalfFloatType explicitly.
  const composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,
    // Portal-stencil pass needs a stencil attachment. Off → pmndrs default
    // (false) → byte-identical to the pre-feature composer.
    stencilBuffer: !!portalStencil,
  });
  composer.setSize(width, height);

  // 2026-05-16 cloud z-order fix — attach a DepthTexture to both of
  // the composer's ping-pong render targets so the cloud overlay's
  // fragment shader (which runs AFTER `composer.render()` writes the
  // tone-mapped image to screen) can sample the world's depth and
  // discard fragments where geometry occludes the cloud.
  //
  // Without this, the cloud overlay quad ran with `depthTest=false`
  // and painted cloud RGB unconditionally, so buildings / NPCs in
  // front of the sky were over-painted by clouds. The legacy comment
  // at the top of this file ("overlay quad draws after the composer's
  // final pass — depth-correct cloud occlusion is a follow-on
  // cleanup") was that follow-on.
  //
  // We share ONE DepthTexture between the two RTs because the
  // composer ping-pongs reads/writes but the depth buffer is updated
  // by both world-write passes — sharing avoids stale depth from the
  // "other" buffer during the chain. setSize below rebuilds it at the
  // new dimensions.
  // 2026-07-08 — size the depth texture to the DRAWING-BUFFER resolution to
  // match the composer's color buffers (composer.setSize used
  // renderer.getDrawingBufferSize above); a CSS-sized depth texture mismatches
  // whenever pixelRatio ≠ 1 (HiDPI or an explicit ?renderScale at boot) → an
  // incomplete FBO. See the setSize() note for the full failure mode.
  // `?stableDepthShare=on` (2026-08-01, ship-OFF pending the P6 fog
  // adjudication): skip the bespoke attachment below and hand the depth
  // consumers (cloud overlay, ground fog) the composer's OWN
  // "EffectComposer.StableDepth" texture instead. pmndrs allocates that
  // stable full-res target ANYWAY the moment any pass needsDepthTexture
  // (postprocessing build/index.js:1047 createDepthTexture, :1201 addPass —
  // AerialPerspective needs depth, so it always exists here) and blits depth
  // into it each frame — so the bespoke texture is a SECOND full-res depth
  // allocation (~8 MB at 1080p×DPR) holding the same bits. Sharing also moves
  // the ground-fog read onto the stable COPY instead of the LIVE attachment
  // of the FBO being rendered — removing the sample-while-attached feedback
  // hazard the P6 swamp-fog adjudication (HANDOFF-1070-vistest §D) judges;
  // run that adjudication with this flag in both positions. Off =
  // byte-identical legacy. Stencil composes: createDepthTexture clones the
  // packed DepthStencil format from inputBuffer.stencilBuffer (the ctor opt
  // above), and composer.setSize resizes depthRenderTarget itself (:1325).
  const stableDepthShare = (() => {
    try {
      if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.search) {
        return new URLSearchParams(globalThis.location.search).get("stableDepthShare") === "on";
      }
    } catch (_) {}
    return false;
  })();
  let sceneDepthTexture = null;
  if (!stableDepthShare) {
    const _depthBufSize = renderer.getDrawingBufferSize(new THREE.Vector2());
    sceneDepthTexture = new THREE.DepthTexture(_depthBufSize.x, _depthBufSize.y);
    if (portalStencil) {
      // Depth + stencil must share ONE packed attachment when stencil is on;
      // a depth-only texture can't coexist with a stencil buffer. AerialPerspective
      // reads `.r`, which still returns the depth component of a packed texture.
      sceneDepthTexture.format = THREE.DepthStencilFormat;
      sceneDepthTexture.type = THREE.UnsignedInt248Type;
    } else {
      sceneDepthTexture.format = THREE.DepthFormat;
      sceneDepthTexture.type = THREE.UnsignedIntType;
    }
    composer.inputBuffer.depthTexture = sceneDepthTexture;
    composer.outputBuffer.depthTexture = sceneDepthTexture;
    composer.inputBuffer.depthBuffer = true;
    composer.outputBuffer.depthBuffer = true;
  }

  let skyRenderPass = null;
  if (skyScene && skyCamera) {
    skyRenderPass = new RenderPass(skyScene, skyCamera);
    // DEAD FULL-RES DEPTH BLIT (2026-08). pmndrs `RenderPass`'s ctor sets
    // `needsDepthBlit = true` unconditionally (postprocessing 6.39.1,
    // build/index.js:6722), so EffectComposer.render blits this pass's depth
    // into `depthRenderTarget` right after it runs (index.js:1279-1283).
    // That copy is WASTED here: the very next pass to touch depth is
    // `worldRenderPass`, which runs with `clearDepth = true` in BOTH branches
    // (see below and the per-frame sync further down) and blits again itself.
    // Nothing in between reads composer depth -- `skyCapturePass` renders the
    // sky scene into its own RT and ignores inputBuffer, and
    // `worldMaskPass`/CameraLayerMaskPass only flips `camera.layers`.
    // Skipping it drops one full-res depth blit per frame; the composer output
    // is byte-identical.
    skyRenderPass.needsDepthBlit = false;
    composer.addPass(skyRenderPass);
  }

  // Job A — capture the physical sky the instant after it is drawn and BEFORE
  // the world pass paints over it, so HorizonDissolveEffect (built below, runs
  // in fxPass) can fade distant geometry back into the exact sky behind it.
  // Only created when enabled → pass list is byte-identical when `?horizonFade=off`.
  let skyDissolveRT = null;
  let skyCapturePass = null;
  let horizonDissolve = null;
  if (horizonFadeEnabled && skyScene && skyCamera) {
    skyDissolveRT = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    skyCapturePass = new SkyCapturePass(skyScene, skyCamera, skyDissolveRT);
    composer.addPass(skyCapturePass);
    horizonDissolve = new HorizonDissolveEffect({
      skyTexture: skyDissolveRT.texture,
      cameraFar: camera.far,
      start: _aerialNum("horizonFadeStart", HORIZON_DISSOLVE_START_M),
      end: _aerialNum("horizonFadeEnd", HORIZON_DISSOLVE_END_M),
      aerialStart: _aerialNum("aerialStart", AERIAL_START_M),
      aerialEnd: _aerialNum("aerialEnd", AERIAL_END_M),
      aerialMax: _aerialNum("aerialMax", AERIAL_MAX),
      aerialCurve: _aerialNum("aerialCurve", AERIAL_CURVE),
      aerialDesat: _aerialNum("aerialDesat", AERIAL_DESAT),
      skyLift: _aerialNum("aerialSkyLift", AERIAL_SKY_LIFT),
    });
    try {
      if (typeof window !== "undefined" && window.location?.search
          && new URLSearchParams(window.location.search).get("aerialDebug") === "on") {
        horizonDissolve.debug = 1;
      }
    } catch (_) { /* default off */ }
    if (typeof window !== "undefined") {
      // Live A/B without a reload — all five knobs are plain uniforms.
      window.__aerial = horizonDissolve;
      window.__setAerial = (o = {}) => {
        for (const k of ["aerialStart", "aerialEnd", "aerialMax",
                         "aerialCurve", "aerialDesat", "skyLift", "start", "end"]) {
          if (Number.isFinite(o[k])) horizonDissolve[k] = o[k];
        }
        if (o.debug != null) horizonDissolve.debug = o.debug;
        if (Number.isFinite(o.cameraFar)) horizonDissolve.setCameraFar(o.cameraFar);
        return {
          aerialStart: horizonDissolve.aerialStart,
          aerialEnd: horizonDissolve.aerialEnd,
          aerialMax: horizonDissolve.aerialMax,
          aerialCurve: horizonDissolve.aerialCurve,
          aerialDesat: horizonDissolve.aerialDesat,
          skyLift: horizonDissolve.skyLift,
          start: horizonDissolve.start,
          end: horizonDissolve.end,
        };
      };
    }
  }

  // Phase 5 PView render-order fix (2026-05-25) — pre-world layer mask.
  // Force the camera's mask to BOTH (outdoor steady state) by default;
  // preFrameSkySync flips it to WORLD_ONLY when indoor before the world
  // pass runs. The mask is restored to BOTH by `cellsPostMaskPass` after
  // the indoor split so downstream consumers (raycasters, CSM) see the
  // outdoor-equivalent state.
  const worldMaskPass = new CameraLayerMaskPass(
    camera,
    CAM_LAYER_MASK_BOTH,
    "CameraLayerMask(World)"
  );
  composer.addPass(worldMaskPass);

  const worldRenderPass = new RenderPass(scene, camera);
  if (skyRenderPass) {
    worldRenderPass.clear = false;
    worldRenderPass.clearDepth = true;
  }
  composer.addPass(worldRenderPass);

  // Portal-stencil pass (2026-07-05, ?portalStencil, default OFF). Runs on the
  // world pass's shared color+depth+stencil buffer, before the dead depth-clear
  // slot and fxPass. Feed via portalStencilPass.setApertures(flat) each frame
  // (cells.js). Only added when the flag is on → the composer's pass list is
  // byte-identical when off.
  let portalStencilPass = null;
  if (portalStencil) {
    portalStencilPass = new PortalStencilPass(scene, camera);
    composer.addPass(portalStencilPass);
  }

  // Portal-punch pass (2026-07-05, ?portalPunch, default OFF). Runs right after
  // the world pass and BEFORE the cells pass: for each visible door/window
  // aperture it punches depth to FAR (retail DrawPortalPolyInternal), so the
  // interior cells the cells pass draws next win depth inside the doorway. Feed
  // via portalPunchPass.setApertures(flat) each frame (cells.js tickPortalPunch).
  // The split it needs (WORLD_ONLY world pass → INDOOR_ONLY cells pass) is armed
  // in preFrameSkySync only when outdoor + this pass hasApertures.
  let portalPunchPass = null;
  if (portalPunch) {
    portalPunchPass = new PortalPunchPass(scene, camera);
    composer.addPass(portalPunchPass);
  }

  // Phase 5 PView render-order fix (2026-05-25) — indoor depth-clear +
  // cells pass. Both are `enabled=false` by default (outdoor steady state);
  // preFrameSkySync flips them on when indoor and configures
  // `worldMaskPass` to write WORLD_ONLY so the world pass renders only
  // terrain + outdoor buildings + outdoor statics.
  //
  // ClearPass(false, true, false): color=keep, depth=wipe, stencil=keep.
  // Mirrors `gl.Clear(ClearBufferMask.DepthBufferBit)` at GameScene.cs:1610.
  // The render-target is the composer's input buffer (still being written
  // to between this and `fxPass`); the clear operates on its depth texture
  // (`composer.inputBuffer.depthTexture`).
  const depthClearPass = new ClearPass(false, true, false);
  depthClearPass.enabled = false;
  composer.addPass(depthClearPass);

  const cellsMaskPass = new CameraLayerMaskPass(
    camera,
    CAM_LAYER_MASK_INDOOR_ONLY,
    "CameraLayerMask(Cells)"
  );
  cellsMaskPass.enabled = false;
  composer.addPass(cellsMaskPass);

  // cellsRenderPass renders the same scene + camera but with the camera
  // mask set to layer 1 only. Inside `RenderPass.render` we have
  // `clear=false, clearDepth=false` so neither the color nor depth buffer
  // is touched — only cells write fresh depth into the just-cleared depth
  // buffer. Render target is the same input buffer the world pass wrote.
  const cellsRenderPass = new RenderPass(scene, camera);
  cellsRenderPass.clear = false;
  cellsRenderPass.clearDepth = false;
  cellsRenderPass.enabled = false;
  composer.addPass(cellsRenderPass);

  // Restore the camera's mask to BOTH after the indoor split so downstream
  // consumers (CSM cascade matrices, picking raycasters, plugin scripts
  // that read `camera.layers`) observe the steady-state outdoor mask.
  // No-op when the indoor split was disabled (mask already = BOTH).
  const cellsPostMaskPass = new CameraLayerMaskPass(
    camera,
    CAM_LAYER_MASK_BOTH,
    "CameraLayerMask(Restore)"
  );
  composer.addPass(cellsPostMaskPass);

  // Aerial perspective. sunLight+skyLight stay false in K.2 — turning
  // them on requires a normal buffer (geometry pass) and a real
  // SunDirectionalLight / SkyLightProbe wired up. K.3 lights these up.
  const aerialPerspective = new AerialPerspectiveEffect(camera, {
    sunLight: false,
    skyLight: false,
    correctGeometricError,
  });

  // ECEF transform — load-bearing. See header comment + cloud_volume.js
  // for the WGS-84-vs-spherical-bottomRadius mismatch story.
  aerialPerspective.worldToECEFMatrix.makeTranslation(0, atm.bottomRadius, 0);
  aerialPerspective.correctAltitude = false;

  // Wire Bruneton lookup tables. Texture refs are valid immediately
  // (RenderTarget .texture). If the bake hasn't completed yet, sampling
  // returns black — caller should defer construction until
  // atmosphereRuntime.whenReady().
  Object.assign(aerialPerspective, atmosphereRuntime.textures);

  // Lens flare — bloom-extracted ghosts/streaks around bright spots
  // (the sun, primarily). Runs BEFORE tone mapping so it operates on
  // the HDR radiance values (sun is many orders of magnitude over
  // diffuse light → easy threshold).
  //
  // 2026-05-21 stutter fix: gated OFF by default (opt in via
  // `?lensFlare=on`). The takram LensFlareEffect does a screen-space
  // bright-pixel extraction + per-ghost-element render whose cost
  // spikes when the sun first enters / leaves the framebuffer at a
  // grazing screen angle. User reported "running into the sun at a
  // certain angle" reproducibly stalled the frame; disabling the
  // effect removes the spike entirely. Bloom + AGX tone mapping still
  // give the sun a halo + highlight roll-off without the flare ghosts.
  const lensFlare = lensFlareOpt
    ? new LensFlareEffect({
        intensity: 0.005,
        resolutionScale: 0.5,
      })
    : null;
  if (lensFlare) {
    lensFlare.thresholdLevel = 0.9;
    lensFlare.thresholdRange = 0.1;
  }

  // Tone mapping — collapses the HalfFloat HDR pipeline to sRGB. AGX
  // is the takram-recommended mode (well-behaved highlight roll-off,
  // designed for physically-based atmosphere/cloud output). MUST run
  // AFTER LensFlare (so the flare's HDR extraction works) and BEFORE
  // Dithering (so dither operates on the final 8-bit-ish value range).
  const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
  const dithering = new DitheringEffect();

  // Bloom — HDR halo around bright pixels (sun disc, lava, lit windows,
  // magic flashes). Threshold 0.85 keeps the diffuse sky from blooming
  // uniformly while the sun (well above 1.0 in HDR) lights up. mipmapBlur
  // takes the GPU's mip chain for a cheap 5-level downsample (~1ms @ 1080p
  // R9 290; ~0.5ms 1440p 1070) vs. ~3ms for the gaussian path. Disable by
  // passing `bloom: false` in opts.
  const bloom = bloomOpt
    ? new BloomEffect({
        intensity: 1.0,
        luminanceThreshold: 0.85,
        luminanceSmoothing: 0.1,
        mipmapBlur: true,
        radius: 0.85,
      })
    : null;
  if (bloom) {
    // HALF-RES LUMINANCE PREPASS (2026-08). BloomEffect constructs its
    // LuminancePass with only `{ colorOutput: true }` (postprocessing 6.39.1,
    // build/index.js:4120), so `resolutionScale` defaults to 1.0 and the
    // threshold/knee prepass runs at FULL drawing-buffer resolution every
    // frame. Its one consumer is `mipmapBlurPass`, fed straight from
    // `luminancePass.renderTarget` (index.js:4307-4311) — and that pass's first
    // downsample level already halves the input, so sourcing it at half res is
    // visually a wash while halving this pass's fill.
    // `Resolution.scale`'s setter (index.js:1859) dispatches "change", which
    // the pass's own listener (index.js:3710) turns into a setSize, so the
    // render target resizes immediately and tracks every later composer
    // setSize (BloomEffect.setSize → luminancePass.setSize, index.js:4334).
    bloom.luminancePass.resolution.scale = 0.5;
  }

  // Vignette — subtle dark frame edges. MUST run before tone mapping so
  // darkened pixels are still in HDR before AGX collapses them; placing
  // it after would crush the highlights twice. pmndrs defaults are 0.5/0.5;
  // 0.5 offset + 0.3 darkness reads as a soft frame, not a peephole.
  const vignette = vignetteOpt
    ? new VignetteEffect({
        technique: VignetteTechnique.DEFAULT,
        offset: 0.5,
        darkness: 0.3,
      })
    : null;

  // Terrain-VFX wave 2B — VOLCANO heat shimmer (plan §3.6 item 1). A custom
  // pmndrs Effect implementing `mainUv` only (a pure UV warp, the cheapest
  // effect class), declared with EffectAttribute.DEPTH so it can gate the warp
  // by distance. `createHeatHazeEffect` returns NULL unless
  // `?terrainVolcano=on&?terrainHaze=on` (both ship OFF, plan §5.9), so
  // `filter(Boolean)` below drops the slot and the effect list — hence the
  // compiled compound shader AND `composer.passes.length` — is byte-identical
  // to the pre-feature pipeline. `opts.terrainHaze` (boolean) forces the gate
  // either way so headless tests need no URL.
  const heatHaze = createHeatHazeEffect({
    cameraFar: camera.far,
    ...(typeof opts?.terrainHaze === "boolean" ? { enabled: opts.terrainHaze } : {}),
  });

  // EffectPass composition order: HeatHaze → AerialPerspective → LensFlare →
  // Bloom → Vignette → ToneMapping → Dithering. Everything except ToneMapping +
  // Dithering operates in HDR space. `filter(Boolean)` drops the disabled
  // slots without leaving holes in the pass.
  const fxPass = new EffectPass(
    camera,
    // heatHaze is FIRST, before aerialPerspective (plan §3.6): pmndrs
    // concatenates every effect's `mainUv` body ahead of any `mainImage`, so
    // the distortion is applied to the raw scene and the fog/bloom/tone-mapping
    // chain then operates on the distorted result rather than the other way
    // round. (EffectPass re-sorts by `attributes` DESCENDING; Array#sort is
    // stable and aerialPerspective also carries DEPTH, so first stays first.)
    // horizonDissolve sits right after aerialPerspective and before
    // lensFlare/bloom/vignette/toneMapping so the terrain→sky blend happens
    // in HDR (matching the captured sky's radiance space); null when
    // `?horizonFade=off` and dropped by filter(Boolean).
    ...[heatHaze, aerialPerspective, horizonDissolve, lensFlare, bloom, vignette, toneMapping, dithering].filter(Boolean),
  );
  composer.addPass(fxPass);

  // Live tuning handle for the 1070 eye-test, mirroring `window.__horizonFade`:
  // `__heatHaze.strength = 0.012`, `.freq`, `.speed`, and `.state` for a
  // snapshot of what the terrain provider is publishing. No-op when off.
  installHeatHazeHandle(heatHaze);

  // Live tuning handle for the 1070 eye-test — adjust the band without a
  // rebuild, e.g. `__horizonFade.start = 700; __horizonFade.end = 1050`.
  if (typeof window !== "undefined" && horizonDissolve) {
    window.__horizonFade = {
      get start() { return horizonDissolve.start; },
      set start(v) { horizonDissolve.start = v; },
      get end() { return horizonDissolve.end; },
      set end(v) { horizonDissolve.end = v; },
    };
  }

  let activeCamera = camera;

  /**
   * Re-point the compound fx shader at a new render camera (2026-08-03 fix).
   *
   * `fxPass` was constructed with the boot PERSPECTIVE camera and nothing ever
   * updated it, so a C-key switch to the top-down ORTHO camera (camera.js
   * `createOrthoCamera`) left every DEPTH effect decoding ortho depth with the
   * perspective formula: `EffectPass.set mainCamera` is what calls
   * `EffectMaterial.copyCameraSettings`, which owns both `cameraNear`/
   * `cameraFar` AND the `PERSPECTIVE_CAMERA` define that selects the `getViewZ`
   * branch. AerialPerspectiveEffect (world-position reconstruction), heatHaze
   * and horizonDissolve all carry `EffectAttribute.DEPTH` and all read it.
   *
   * ⚠ INVARIANT: CALL THIS ONLY ON AN EXPLICIT CAMERA SWITCH, never per frame.
   * The define flip is a program-cache-key change — one recompile per switch is
   * the intended cost; per-frame would fork programs every frame. Both call
   * sites are already behind `cam !== activeCamera`.
   */
  function retargetFxPass(cam) {
    // `.mainCamera`, not `.camera`: on the pmndrs BASE Pass `set mainCamera` is
    // an empty no-op (the portal_punch trap), but EffectPass genuinely
    // overrides it and fans out to fullscreenMaterial + every effect.
    fxPass.mainCamera = cam;
  }

  return {
    composer,
    aerialPerspective,
    horizonDissolve,
    // null unless ?terrainVolcano=on&terrainHaze=on (wave 2B, plan §3.6).
    heatHaze,
    skyCapturePass,
    lensFlare,
    bloom,
    vignette,
    toneMapping,
    dithering,
    skyRenderPass,
    worldRenderPass,
    portalStencilPass,
    portalPunchPass,
    // Phase 5 PView render-order fix (2026-05-25) — exposed for diag
    // probes + the zfighting harness, which reads `depthClearPass.enabled`
    // to confirm the indoor split is wired.
    worldMaskPass,
    depthClearPass,
    cellsMaskPass,
    cellsRenderPass,
    cellsPostMaskPass,
    fxPass,

    /**
     * Pre-frame: sync sky camera, flip sky enabled/world clear flags
     * based on indoor state, AND configure the Phase 5 PView render
     * order (terrain → depth-clear → EnvCells) when indoor.
     *
     * Outdoor (default): worldMaskPass writes BOTH layers, world pass
     * renders everything in one shot, depth-clear + cells passes are
     * disabled. Mask is restored to BOTH by cellsPostMaskPass (no-op).
     *
     * Indoor: worldMaskPass writes WORLD_ONLY → world pass renders only
     * terrain + outdoor buildings + outdoor statics. ClearPass wipes the
     * depth buffer. cellsMaskPass writes INDOOR_ONLY → cells pass renders
     * cellsGroup + entitiesGroup with fresh depth → no Z-fighting
     * between cottage floors and terrain underneath. cellsPostMaskPass
     * restores the mask to BOTH for downstream consumers.
     *
     * Note: `skyDome._lastIsIndoor` is the canonical indoor flag used
     * across the renderer (sky_dome.js wires it from
     * `sessionHandle.isCurrentCellIndoor()` once per tick). Reading the
     * cached value here means we never call into wasm during the render
     * dispatch — important for the `?nullRender=1` and capture-script
     * cadences that throttle the wasm session.
     */
    preFrameSkySync(skyDome, mainCamera) {
      const isIndoor = !!skyDome?._lastIsIndoor;

      // Sky-K.2 sky-pass + sky-camera sync (existing behaviour).
      if (skyRenderPass) {
        skyRenderPass.enabled = !!skyDome && !isIndoor;
        if (skyRenderPass.enabled && typeof skyDome.syncSkyCamera === "function") {
          skyDome.syncSkyCamera(mainCamera);
        }
      }

      // Job A — the horizon dissolve only makes sense when the sky is visible.
      // Indoors (sky pass off, world clears colour) skip the capture and no-op
      // the effect so distant indoor geometry is never tinted sky-colour.
      const skyVisible = !!skyDome && !isIndoor;
      if (skyCapturePass) skyCapturePass.enabled = skyVisible;
      if (horizonDissolve) horizonDissolve.setEnabled(skyVisible);

      // World pass clear flags. The world pass is the first GEOMETRY pass, so
      // it always starts from a FRESH depth buffer; it keeps the COLOR the sky
      // pass drew (outdoor) or clears color too (indoor / no sky pass). Note
      // `clearDepth` must be true even indoors now — the old code relied on the
      // (now-removed) depthClearPass to reset depth, so leaving it false would
      // render the world pass against stale depth.
      if (skyRenderPass && skyRenderPass.enabled) {
        worldRenderPass.clear = false;      // sky drew the background
        worldRenderPass.clearDepth = true;  // …but depth starts fresh
      } else {
        worldRenderPass.clear = true;       // no sky → clear color + depth
        worldRenderPass.clearDepth = true;
      }

      // 2026-05-29 see-through rectification — DROP the indoor depth-clear
      // split (the Phase-5 layer split that wiped terrain Z and redrew layer 1
      // on top). That clear made EVERY frustum-visible EnvCell render OVER the
      // terrain whenever the player's current cell was classified indoor —
      // and Holtburg building plots/basements ARE EnvCells, so it fired even
      // standing "outside", drawing building interiors/basements and down-hill
      // cottages THROUGH the terrain (the reported see-through). Render ALL
      // layers in the single shared-depth world pass so the GPU depth buffer
      // occludes EnvCells behind/below terrain — its actual job — and so the
      // depth buffer the cloud overlay samples (same composer DepthTexture) is
      // MORE complete, not less (clouds occlude behind terrain+buildings+cells,
      // never reintroducing the clouds-over-everything regression).
      //   Trade-off given back: the cottage-floor-vs-terrain Z-fight the clear
      //   masked. If it resurfaces it gets a TARGETED polygon-offset on the
      //   cell floor — never a destructive global depth wipe again.
      // ?portalPunch (default off): retail per-aperture depth punch so building
      // interiors are visible from an OUTDOOR camera through door/window
      // apertures. Arm the world/cells split ONLY when outdoor AND the punch
      // pass has visible apertures this frame — otherwise fall through to the
      // default shared BOTH pass (zero change when the flag is off, and no
      // wasted split on frames with no doorway in view).
      const punchActive =
        portalPunch &&
        !isIndoor &&
        !!portalPunchPass &&
        portalPunchPass.hasApertures;
      if (punchActive) {
        // (1) world pass → terrain + facade + outdoor statics only (layer 0).
        worldMaskPass.mask = CAM_LAYER_MASK_WORLD_ONLY;
        // (2) portalPunchPass (already sequenced after the world pass) punches
        //     depth to FAR inside each aperture. NOT the global depth wipe (that
        //     caused the 2026-05-29 see-through); the punch is bounded to doorways.
        depthClearPass.enabled = false;
        // (3) cells pass → interior EnvCells + entities (layer 1) with the world
        //     depth + punches intact (clear=false/clearDepth=false). Interior
        //     wins inside the punched doorways, loses behind the facade.
        cellsMaskPass.enabled = true;
        cellsRenderPass.enabled = true;
      } else {
        worldMaskPass.mask = CAM_LAYER_MASK_BOTH;
        depthClearPass.enabled = false;
        cellsMaskPass.enabled = false;
        cellsRenderPass.enabled = false;
      }
      // cellsPostMaskPass is always enabled — mask=BOTH no matter what,
      // so steady-state outdoor consumers observe the unsplit mask. The
      // single mask write is ~free.
    },

    /**
     * Per-frame sun direction update. Caller pulls heading/pitch from
     * AC's SkyState and supplies the unit-vec3 here. Use the shared
     * `./sun_direction.js::sunDirFromHeadingPitch` utility to derive
     * the vec3 from heading/pitch.
     */
    setSunDirection(vec3) {
      aerialPerspective.sunDirection.copy(vec3);
    },

    render(cam, dt = 0) {
      if (cam && cam !== activeCamera) {
        worldRenderPass.camera = cam;
        cellsRenderPass.camera = cam;
        aerialPerspective.camera = cam;
        worldMaskPass.setCamera(cam);
        cellsMaskPass.setCamera(cam);
        cellsPostMaskPass.setCamera(cam);
        retargetFxPass(cam);
        activeCamera = cam;
      }
      // Portal-stencil pass draws with the CURRENT render camera — set every
      // frame (not only on a switch) so its mainCamera can never be undefined
      // when it has work (the "reading 'layers' of undefined" freeze).
      if (portalStencilPass && cam) portalStencilPass.camera = cam;
      // `.camera`, not `.mainCamera` — the pmndrs base Pass `set mainCamera` is
      // an empty no-op, so the punch reads its render camera off `this.camera`.
      if (portalPunchPass && cam) portalPunchPass.camera = cam;
      composer.render(dt);
    },

    setSize(w, h) {
      composer.setSize(w, h);
      // Rebuild the shared depth texture at the new size — Three.js
      // doesn't auto-resize DepthTextures attached to composer RTs.
      //
      // 2026-07-08 FRAMEBUFFER-INCOMPLETE FIX: size it to the DRAWING-BUFFER
      // resolution (w × pixelRatio), NOT the raw CSS w/h. `composer.setSize`
      // sizes the ping-pong COLOR buffers to `renderer.getDrawingBufferSize()`
      // (postprocessing.js:1458), so a CSS-sized depth texture is a DIFFERENT
      // size than the color attachment whenever pixelRatio ≠ 1 — which the
      // adaptive render-scale controller makes routine (it drives pixelRatio
      // below 1 under load). The mismatched attachments make the composer FBO
      // incomplete → "Framebuffer is incomplete: Attachments are not all the
      // same size" spam on every glClear/glDraw/glBlit → a broken/white frame.
      // Also read the LIVE current texture (not the stale `sceneDepthTexture`
      // const, which is never reassigned) so repeated resizes dispose the
      // right object + preserve the packed depth-stencil format when the
      // portal-stencil pass is on.
      // stableDepthShare: no bespoke attachment exists — pmndrs resizes its
      // own depthRenderTarget inside composer.setSize above (:1325).
      if (stableDepthShare) return;
      const old = composer.inputBuffer.depthTexture || sceneDepthTexture;
      const dbs = renderer.getDrawingBufferSize(new THREE.Vector2());
      const next = new THREE.DepthTexture(dbs.x, dbs.y);
      next.format = old.format;
      next.type = old.type;
      composer.inputBuffer.depthTexture = next;
      composer.outputBuffer.depthTexture = next;
      // getSceneDepthTexture() reads the live composer.inputBuffer.depthTexture,
      // so swapping the reference above keeps it valid.
      old.dispose();
    },

    /**
     * Live handle to the depth texture the composer's world pass
     * writes. Used by `cloud_overlay.js` to discard cloud fragments
     * behind world geometry. Always returns the current texture —
     * `setSize` swaps the underlying object, but the consumer reads
     * through this accessor each frame.
     */
    getSceneDepthTexture() {
      // stableDepthShare: the consumers read pmndrs' per-frame-blitted stable
      // copy (null until a needsDepthTexture pass created it — the cloud
      // overlay treats null as "not wired yet", its legacy behaviour).
      if (stableDepthShare) {
        return composer.depthRenderTarget ? composer.depthRenderTarget.depthTexture : null;
      }
      return composer.inputBuffer.depthTexture;
    },

    setCamera(cam) {
      if (!cam || cam === activeCamera) return;
      worldRenderPass.camera = cam;
      cellsRenderPass.camera = cam;
      aerialPerspective.camera = cam;
      worldMaskPass.setCamera(cam);
      cellsMaskPass.setCamera(cam);
      cellsPostMaskPass.setCamera(cam);
      retargetFxPass(cam);
      activeCamera = cam;
    },

    dispose() {
      composer.passes.forEach((p) => p.dispose?.());
      aerialPerspective.dispose?.();
      lensFlare?.dispose?.();
      bloom?.dispose?.();
      vignette?.dispose?.();
      heatHaze?.dispose?.();
      toneMapping.dispose?.();
      dithering.dispose?.();
    },
  };
}
