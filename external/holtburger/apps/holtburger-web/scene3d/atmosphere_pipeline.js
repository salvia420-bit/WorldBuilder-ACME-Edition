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
//      With `?cloudsMainPass` + `?particlesOverClouds` (both default on) this
//      pass is split in two around a late particle draw so particles sit IN
//      FRONT of the cloud composite: [HeatHaze, Clouds, AerialPerspective] →
//      ParticlesOverClouds → [Bloom, Vignette, ToneMapping, Dithering]. See
//      ParticlesOverCloudsPass below and particles_over_clouds.js.
//
// Cloud overlay coexistence (`?cloudsMainPass=on` instead puts the
// CloudsEffect into fxPass ahead of AerialPerspective; see
// cloudsMainPassEnabled below). Legacy: cloud overlay's `preRender` runs BEFORE
// `composer.render`. Its overlay quad is attached to the SKY scene
// (SkyDome.setCloudOverlay → attachToSkyScene), so it is composited by
// the sky RenderPass BEFORE the world pass, which then overdraws it at
// world geometry — clouds are occluded by draw order (`renderOverlay`
// is a no-op while attached). See cloud_overlay.js.
//
// ECEF setup: takram defaults to WGS-84 ellipsoid + `correctAltitude=true`
// which doesn't match our spherical (bottomRadius=6.36M) setup — the
// altitude-correction offset pushes the camera 18 km "underground" each
// frame. Apply the same fix CloudVolume already uses:
//   worldToECEFMatrix = translate(0, bottomRadius, 0)
//   correctAltitude   = false

import * as THREE from "three";
import {
  BlendFunction,
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
import { setDrawSortPhase } from "./draw_sort_program.js";
import {
  PortalPunchPass,
  SealRemainderPass,
  SealDepthSavePass,
  SealDepthRestorePass,
} from "./portal_punch.js";
import { createHeatHazeEffect, installHeatHazeHandle } from "./vfx/heat_haze_effect.js";
import { particlesOverCloudsEnabled, collectLateFx } from "./particles_over_clouds.js";
import { toneCurveName, toneMappingModeFor } from "./tone_curve.js";
import { createColorGradeEffect, installColorGradeHandle } from "./color_grade.js";
import { SsaoPass, SsaoCompositeEffect, installSsaoHandle } from "./ssao.js";
// 2026-10-08 — ?layerHaze: painterly distance + altitude haze over all geometry.
import { LayeredHazePass, layerHazeStrength, installLayerHazeHandle } from "./layered_haze.js";
import { SSAO_GRASS_MARKER } from "./ssao_marker.js";

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
// (2026-10-07: now written every frame from the sky's sun — `?aerialSun`,
// syncAerialSun below.)
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

// ---------------------------------------------------------------------------
// `?particlesOverClouds` (2026-10-07, DEFAULT ON, `=off` escape)
// ---------------------------------------------------------------------------
// Owner, 1070: "clouds are over particle effect shouldnt be". With the clouds
// in the post chain (`?cloudsMainPass`) AerialPerspective lays the cloud over
// every sky pixel the world pass left at far depth — including pixels that
// already hold an additive (depthWrite:false) particle. See
// particles_over_clouds.js for the whole story. The post chain is split so the
// particles land between the cloud composite and bloom:
//
//   ... CameraLayerMask(Restore), EffectPass[NanScrub],
//   EffectPass[HeatHaze?, Clouds, AerialPerspective]   -> late target T
//   ParticlesOverClouds  (the particle draw objects)   -> T
//   EffectPass[Bloom, Vignette?, ToneMapping, Dithering]  reads T -> screen
//
// WHY A PRIVATE TARGET AND NOT A RenderPass ON THE PING-PONG BUFFERS. The
// composer's buffers are MSAA (`?msaa`, default 2): a RenderPass's depth test
// runs against the multisampled depth RENDERBUFFER of the buffer it draws into,
// and only the buffer the world pass drew into holds the scene depth there.
// Which buffer a mid-chain pass gets depends on how many swapping passes ran
// before it (`?nanScrub=off` flips it). T is single-sample and borrows the
// composer's own depth texture (`composer.depthTexture` — the attachment the
// world pass resolves its depth into every frame), so the depth test is right
// whatever the parity and whatever the MSAA count, with no depth copy and no
// extra resolve. Cost: one extra full-screen HDR write+read (T), the moved
// particle draws, and T's colour (RGBA16F at drawing-buffer size).
//
// WHY THE PARTICLES ARE HIDDEN RATHER THAN RE-LAYERED. Re-layering every
// particle onto a new camera layer would have to be mirrored by every OTHER
// render of the main scene (the direct fallback path in index.js, wireframe,
// `?atmosphere=off`, the seal remainder). Instead the pipeline collects the
// particle draw objects each frame, sets `visible = false` for the composer
// only (pipeline.render → composer.render), draws exactly those objects into T
// from a private Scene, and restores them. The private Scene matters: three
// keys light state by scene, and drawing the main scene with a particle-only
// mask would flip its light hash twice a frame and send every lit material
// through getProgram (the reason lights sit on layer 1 too, see
// atmosphere_lights.js). The late Scene shares the main scene's Fog OBJECT, so
// fogged particles keep their fog and their program.
//
// Split frames (the indoor `?indoorDepthSplit` and the `?punchRetail=off`
// world/cells split) skip the late draw and leave the particles in their
// legacy passes: the doorway seal relies on the world pass drawing outdoor
// particles before the depth wipe, and nothing there is against the sky.

/**
 * First half of the split post chain: renders into the late target instead of
 * the composer's output buffer, and never swaps the ping-pong buffers.
 */
class PostChainTargetPass extends EffectPass {
  constructor(camera, latePass, ...effects) {
    super(camera, ...effects);
    // Functions, not Pass/RenderTarget own properties: pmndrs Pass.dispose
    // disposes every own property that is a Pass or a render target.
    this._latePass = () => latePass;
  }
  // EffectPass.updateMaterial re-derives needsSwap on every recompile.
  get needsSwap() { return false; }
  set needsSwap(_v) { /* pinned false: output is the late target */ }
  render(renderer, inputBuffer, _outputBuffer, deltaTime, stencilTest) {
    const late = this._latePass();
    late.attachSceneDepth();
    super.render(renderer, inputBuffer, late.renderTarget, deltaTime, stencilTest);
  }
}

/**
 * Reads the late target instead of the composer's input buffer. With
 * `?nanScrub` on, that is the late NanScrub pass and the post half (built with
 * `latePass = null`) reads the composer input the scrub wrote; with it off, the
 * post half reads the late target itself.
 */
class PostChainSourcePass extends EffectPass {
  constructor(camera, latePass, ...effects) {
    super(camera, ...effects);
    this._latePass = () => latePass;
  }
  render(renderer, inputBuffer, outputBuffer, deltaTime, stencilTest) {
    const late = this._latePass();
    // NO DEPTH RESOLVE (2026-10-07, 1070 vis-test of b8819698). These passes
    // are full-screen effect quads: they write colour only. But the buffer the
    // late NanScrub writes is a multisampled composer buffer carrying the
    // shared scene depth texture, and three resolves an MSAA target with ONE
    // blitFramebuffer(COLOR | DEPTH): on the 1070 (ANGLE D3D11) that blit
    // raised GL_INVALID_OPERATION every frame (its depth attachment does not
    // match the target's multisample depth renderbuffer), and a rejected blit
    // resolves NOTHING — the colour was lost too, so the post half read the
    // raw world pass and the whole [Clouds, AerialPerspective] composite never
    // reached the screen (no clouds, no aerial perspective, measured: buffer
    // unchanged across the pass, gl.getError() 1282; with depth resolve off
    // the pass writes T exactly and the error is 0). The depth texture keeps
    // what the world pass resolved into it, which is all any later reader wants.
    const restore = outputBuffer && outputBuffer.resolveDepthBuffer === true;
    if (restore) outputBuffer.resolveDepthBuffer = false;
    try {
      super.render(renderer, late ? late.renderTarget : inputBuffer, outputBuffer, deltaTime, stencilTest);
    } finally {
      if (restore) outputBuffer.resolveDepthBuffer = true;
    }
  }
}

const _lateNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * The late draw. Owns the late target T. `beginFrame` (before composer.render)
 * collects and hides the particle draw objects; `render` (in the chain, after
 * the cloud + aerial composite) restores them and draws exactly them into T,
 * depth-tested against the scene depth; `endFrame` (after composer.render,
 * always) restores anything still hidden.
 */
class ParticlesOverCloudsPass extends Pass {
  constructor(worldScene, camera, { stencil = false, depthSource = () => null } = {}) {
    const lateScene = new THREE.Scene();
    super("ParticlesOverClouds", lateScene, camera);
    lateScene.name = "ParticlesOverClouds.Scene";
    // No graph walk of its own: `children` is handed the collected objects for
    // the one render call. They keep their real parents and the matrixWorld the
    // world pass's updateMatrixWorld computed this frame.
    lateScene.matrixWorldAutoUpdate = false;
    this.worldScene = worldScene;
    this.needsSwap = false;
    this.needsDepthBlit = false;
    this._depthSource = depthSource;
    this.renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    // Mirrors the composer buffers (a packed depth-stencil texture when
    // `?punchOcclusion` / `?portalStencil` allocate stencil). Assigned, not
    // passed as an option: tests/portal_punch_occlusion_flag anchors on the
    // composer's own stencil option being the file's first one.
    this.renderTarget.stencilBuffer = !!stencil;
    this.renderTarget.texture.name = "ParticlesOverClouds.Target";
    this.renderTarget.texture.generateMipmaps = false;
    this.objects = [];
    this._noChildren = lateScene.children;
    this._hidden = false;
    this._mask = CAM_LAYER_MASK_BOTH;
    this.stats = {
      frames: 0, drawnFrames: 0, skippedNoDepth: 0,
      objects: 0, maxObjects: 0, buckets: 0, meshes: 0,
      candidates: 0, rejectedLit: 0, sourceErrors: 0,
      collectMs: 0, drawMs: 0, cpuMsAvg: 0,
    };
  }

  /** Attach the composer's scene depth texture to T (the depth test source). */
  attachSceneDepth() {
    const d = this._depthSource();
    if (d && this.renderTarget.depthTexture !== d) this.renderTarget.depthTexture = d;
    return !!d;
  }

  /**
   * Before composer.render: collect this frame's particle draw objects and hide
   * them from the world pass. Returns true when `endFrame` must run.
   */
  beginFrame(layerMask) {
    const t0 = _lateNow();
    const s = this.stats;
    s.frames++;
    this._mask = layerMask;
    // No scene depth to test against ⇒ leave everything where it was.
    if (!this._depthSource()) { s.skippedNoDepth++; this.objects.length = 0; return false; }
    collectLateFx(this.objects, this.worldScene, layerMask, s);
    const objs = this.objects;
    let buckets = 0;
    for (let i = 0; i < objs.length; i++) {
      objs[i].visible = false;
      if (objs[i].isInstancedMesh) buckets++;
    }
    this._hidden = objs.length > 0;
    s.objects = objs.length;
    if (objs.length > s.maxObjects) s.maxObjects = objs.length;
    s.buckets = buckets;
    s.meshes = objs.length - buckets;
    s.collectMs = _lateNow() - t0;
    return true;
  }

  _show() {
    if (!this._hidden) return;
    const objs = this.objects;
    for (let i = 0; i < objs.length; i++) objs[i].visible = true;
    this._hidden = false;
  }

  render(renderer, _inputBuffer, _outputBuffer) {
    const t0 = _lateNow();
    this._show();
    const objs = this.objects;
    if (objs.length === 0 || !this.camera || !this.attachSceneDepth()) {
      this.stats.drawMs = 0;
      return;
    }
    const scene = this.scene;
    const cam = this.camera;
    // The SAME Fog object as the world pass ⇒ fogged particle programs keep
    // their fog and see no `materialProperties.fog !== fog` program change.
    scene.fog = this.worldScene?.fog ?? null;
    scene.children = objs;
    const prevMask = cam.layers.mask;
    const prevTarget = renderer.getRenderTarget();
    cam.layers.mask = this._mask;
    try {
      renderer.setRenderTarget(this.renderTarget);
      renderer.render(scene, cam);
      this.stats.drawnFrames++;
    } finally {
      scene.children = this._noChildren;
      cam.layers.mask = prevMask;
      renderer.setRenderTarget(prevTarget);
    }
    const s = this.stats;
    s.drawMs = _lateNow() - t0;
    const total = s.collectMs + s.drawMs;
    s.cpuMsAvg = s.cpuMsAvg === 0 ? total : s.cpuMsAvg * 0.95 + total * 0.05;
  }

  /** After composer.render, always: nothing stays hidden past the composer. */
  endFrame() {
    this._show();
    this.objects.length = 0;
  }

  setSize(width, height) {
    this.renderTarget.setSize(width, height);
  }

  dispose() {
    // T borrows the composer's depth texture; three disposes an attached
    // depth texture with its render target.
    this.renderTarget.depthTexture = null;
    super.dispose();
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
// ?punchRetail draw-order phase of a render item's object: 0 = terrain family
// and anything untagged, 1 = the doorway punch, 2 = shells / statics / interior
// cells / entities (tagged on their top-level groups in index.js). Cached on
// the object once it is attached under a tagged group or the scene, so the
// per-frame sort is a property read.
function _punchPhase(obj) {
  const cached = obj.__hbPunchPhase;
  if (cached !== undefined) return cached;
  let p = 0;
  let attached = false;
  for (let o = obj; o; o = o.parent) {
    const tag = o.userData?.__punchPhase;
    if (tag !== undefined) { p = tag; attached = true; break; }
    if (!o.parent) { attached = o.isScene === true; break; }
  }
  if (attached) obj.__hbPunchPhase = p;
  return p;
}

// three r184 `painterSortStable`, with the punch phase as the primary key.
function punchPhaseOpaqueSort(a, b) {
  const pa = _punchPhase(a.object);
  const pb = _punchPhase(b.object);
  if (pa !== pb) return pa - pb;
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
  if (a.material.id !== b.material.id) return a.material.id - b.material.id;
  if (a.materialVariant !== b.materialVariant) return a.materialVariant - b.materialVariant;
  if (a.z !== b.z) return a.z - b.z;
  return a.id - b.id;
}

// `?cloudsMainPass=on` (2026-10-05, DEFAULT OFF, strict `=== "on"`) — run the
// volumetric CloudsEffect (`?clouds=on`) inside THIS composer's post-chain
// EffectPass, ahead of AerialPerspective, instead of in cloud_overlay.js's
// private EffectComposer + sky-scene quad. takram's documented integration
// (vendor/takram-three-clouds/README.md); see CloudOverlay.adoptMainPass.
// Default ON since 2026-10-05 (owner policy: new behaviour ships on and is
// switched off on report); `?cloudsMainPass=off` restores the private composer.
export function cloudsMainPassEnabled() {
  try {
    return new URLSearchParams(globalThis.location?.search || "").get("cloudsMainPass") !== "off";
  } catch (_) {
    return true;
  }
}

// 2026-10-07 — `?cloudsFullOpacity` (DEFAULT ON, `=off` escape). The AC-fog
// path (index.js, `?fogLerp`) knocks AerialPerspectiveEffect's blend opacity to
// 0.6 so the physical inscatter and the authored range fog do not double up on
// TERRAIN (2026-05-28 "double-fog" knob). Since 2026-10-05 `cloudsMainPass`
// composites the volumetric clouds INSIDE that same effect (takram's
// `overlay`, aerialPerspectiveEffect.frag: `rgb * (1 - overlay.a) +
// overlay.rgb`, and an early `outputColor = overlay` for opaque cloud), and
// pmndrs blends the effect's whole output with that one opacity — so every
// cloud pixel has been drawn at 60 % with 40 % of the bare sky showing
// through it. Owner, 2026-10-07: the haze "interferes with the visibility of
// the takram clouds". With the clouds in the main pass the default is 1.0
// (the terrain inscatter it un-knocks is physical Rayleigh over ~1 km, i.e.
// small — the measured whole-band MAD was 1.8-3.3); without them it stays 0.6.
// `?aerialOpacity=N` still pins it outright; `=off` restores the 0.6 knock.
export const AERIAL_OPACITY_AC_FOG = 0.6;
export function cloudsFullOpacityEnabled(search) {
  try {
    const s = typeof search === "string" ? search : (globalThis.location?.search || "");
    const v = new URLSearchParams(s).get("cloudsFullOpacity");
    if (v == null) return true;
    const t = String(v).toLowerCase();
    return !(t === "off" || t === "0" || t === "false" || t === "no");
  } catch (_) {
    return true;
  }
}
/**
 * The AerialPerspectiveEffect blend opacity on the AC-fog path.
 * @param {boolean} cloudsInMainPass `pipeline.cloudsMainPass` (adopted)
 * @param {string} [search] test seam; defaults to location.search
 * @returns {number} in [0, 1]
 */
export function aerialBlendOpacity(cloudsInMainPass, search) {
  let v = (cloudsInMainPass && cloudsFullOpacityEnabled(search)) ? 1.0 : AERIAL_OPACITY_AC_FOG;
  try {
    const s = typeof search === "string" ? search : (globalThis.location?.search || "");
    const raw = new URLSearchParams(s).get("aerialOpacity");
    if (raw != null && raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n)) v = Math.min(1, Math.max(0, n));
    }
  } catch (_) { /* no location in the Node harness */ }
  return v;
}

// 2026-10-07 — `?aerialSun` (DEFAULT ON, `=off` escape). AerialPerspective's
// `sunDirection` was never written (`setSunDirection` below had zero call
// sites; measured live on the 1070: (0,0,0) while the sky and the clouds held
// (0.94, 0.342, 0)). In Bruneton's lookups a zero sun gives mu_s = nu = 0 — a
// sun parked ON the horizon at 90 deg to every view ray — so terrain inscatter
// was a fixed twilight term at noon and at midnight alike. It now copies the
// SKY's sun (atmosphere_sky.js tick: the night-ramped art elevation, the same
// vector the clouds use since ?cloudNight), so the haze on distant terrain
// matches the sky behind it. A zero source vector (sky not ticked yet) is
// ignored rather than copied.
export function aerialSunEnabled(search) {
  try {
    const s = typeof search === "string" ? search : (globalThis.location?.search || "");
    const v = new URLSearchParams(s).get("aerialSun");
    if (v == null) return true;
    const t = String(v).toLowerCase();
    return !(t === "off" || t === "0" || t === "false" || t === "no");
  } catch (_) {
    return true;
  }
}
/**
 * Copy the sky material's sun (and moon) direction onto AerialPerspective.
 * @param {{sunDirection: THREE.Vector3, moonDirection?: THREE.Vector3}} ap
 * @param {{skyMaterial?: {sunDirection?: THREE.Vector3, moonDirection?: THREE.Vector3}}|null} atmosphereSky
 * @returns {boolean} true if the sun was copied
 */
export function syncAerialSun(ap, atmosphereSky) {
  const src = atmosphereSky?.skyMaterial?.sunDirection;
  if (!ap?.sunDirection || !src || !(src.lengthSq() > 1e-12)) return false;
  if (!ap.sunDirection.equals(src)) ap.sunDirection.copy(src);
  const moon = atmosphereSky.skyMaterial.moonDirection;
  if (ap.moonDirection && moon && moon.lengthSq() > 1e-12 && !ap.moonDirection.equals(moon)) {
    ap.moonDirection.copy(moon);
  }
  return true;
}

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
    ssao: ssaoOpt = false,
    lensFlare: lensFlareOpt = false,
    portalStencil = false,
    portalPunch = false,
    punchOcclusion = false,
    punchRetail = false,
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
  // 2026-08-05 — MSAA belongs HERE, not on the canvas: world geometry renders
  // into these ping-pong buffers, so this is the only surface with geometric
  // edges to antialias (scene3d/index.js `_msaaSamples` derives the count and
  // gates it on the quality preset; `?msaa=0` disables). 0 ⇒ pmndrs default ⇒
  // byte-identical to the pre-08-05 composer. `setSize` below preserves
  // `samples` (it resizes the existing targets rather than rebuilding them).
  const msaaSamples = Number.isFinite(opts?.msaa) ? Math.max(0, Math.min(8, opts.msaa | 0)) : 0;
  const composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,
    // Portal-stencil pass needs a stencil attachment; ?portalPunch's occlusion
    // gate (portal_punch.js) needs one too, but it does NOT get to ask for it
    // by default.
    //
    // MEASURED ON THE 1070, 2026-08-13 — allocating stencil here flips the
    // shared scene depth texture to the packed DepthStencilFormat /
    // UnsignedInt248Type pair below, and SOME depth consumer downstream cannot
    // read it: distant town views go BLACK (mean luma 2.3 vs 60-112 correct) in
    // a stable, camera-reproducible way, while close views are unaffected. The
    // punch pass is NOT the proximate cause — disabling it entirely with the
    // allocation still in place leaves the frame black, and booting the same
    // build with ?portalPunch=off (which skips the allocation) renders
    // correctly. The offending consumer was not identified; until it is, the
    // default must not pay this.
    //
    // So the gate rides a flag, and NOT the default. Two flags reach it:
    //
    //   ?punchOcclusion=on  — 2026-08-14, LANE A. The gate's OWN flag: allocate
    //     the stencil attachment, arm PortalPunchPass's MARK/PUNCH pair, and
    //     change NOTHING else. This is the arm to measure.
    //   ?portalStencil=on   — the historical spelling, kept working. It also
    //     instantiates the RETIRED PortalStencilPass, which is why it could
    //     never exercise the gate (see the `portalStencilPass` block below).
    //
    // Both absent (the default) → no stencil attachment, plain DepthFormat,
    // legacy unconditional punch: byte-identical to the pre-gate pipeline.
    stencilBuffer: !!portalStencil || !!punchOcclusion,
    multisampling: msaaSamples,
  });
  composer.setSize(width, height);
  if (msaaSamples > 0) {
    // Loud once, like the BC7 probe: a boot that spends the multisample store
    // must say so, and `composer.multisampling` reads back the buffer's ACTUAL
    // sample count — 0 here would mean the request was dropped (WebGL 1, or a
    // driver that refused the sample count).
    // eslint-disable-next-line no-console
    console.log(`[msaa] composer multisampling=${composer.multisampling} (requested ${msaaSamples})`);
  }

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
    if (portalStencil || punchOcclusion) {
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
  //
  // 2026-08-14 (LANE A) — WHY THIS PASS COULD NEVER TEST THE PUNCH GATE. Until
  // today `?portalStencil=on` was the only way to get a stencil attachment, so
  // it was also the only way to arm PortalPunchPass's occlusion gate — and it
  // arms this scaffold in the same breath. The scaffold's `tickPortalStencil`
  // (cells.js) PARKS every visible interior cell container on
  // RENDER_LAYER_PORTAL_CELL (layer 2) and draws them itself, flat-shaded,
  // through its own MARK/RESET punch. The punch's mechanism is the world/cells
  // layer split (`preFrameSkySync` `punchActive`), whose cells pass renders
  // INDOOR_ONLY = layer 1 — which the scaffold has just emptied. So with
  // `?portalStencil=on` the punch pass could arm, feed and draw and still
  // change nothing anyone could see: its consumer had no geometry left.
  // That is the "gate is reachable but does nothing" of HANDOFF-2026-08-13 O-P1.
  // `?punchOcclusion=on` is the separation: stencil attachment + gate, no
  // scaffold, cells stay on layer 1.
  let portalStencilPass = null;
  if (portalStencil) {
    portalStencilPass = new PortalStencilPass(scene, camera);
    composer.addPass(portalStencilPass);
    if (portalPunch) {
      // eslint-disable-next-line no-console
      console.warn(
        "[portalStencil] the retired stencil scaffold is ON: it moves interior " +
          "cells to layer 2, so ?portalPunch's cells pass (layer 1) has nothing " +
          "to draw and the punch cannot be judged in this arm. Use " +
          "?punchOcclusion=on to exercise the punch occlusion gate.",
      );
    }
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
    // Arm the occlusion gate ONLY if the composer really got a stencil
    // attachment. Read it back off the buffer rather than trusting the ctor
    // option: with the gate armed against a missing stencil the MARK draw
    // writes nowhere, the punch's EQUAL test fails everywhere and every
    // interior disappears — the exact 2026-08-12 regression shape. False here
    // degrades to the legacy unconditional punch (leak, but visible).
    const _punchStencil = composer.inputBuffer?.stencilBuffer === true;
    if (!_punchStencil) {
      // Expected on a default boot (see the stencilBuffer note above) — info,
      // not a warning, or every boot would cry wolf.
      // eslint-disable-next-line no-console
      console.log(
        "[portalPunch] occlusion gate OFF (no stencil attachment; add " +
          "?portalStencil=on to arm it) — unconditional punch, portals can " +
          "show through walls.",
      );
    }
    if (punchRetail) {
      // ?punchRetail (2026-10-05) — RETAIL DRAW ORDER. Retail punches a
      // building's doorways and then draws everything nearer AFTER the punch
      // (RenderDeviceD3D::DrawBuilding acclient.c:456933: portals, reached
      // cells, then the shell; OpenAC RetailFrameWalk.DrawBuilding), so a
      // nearer wall/tree/building overwrites any leak. Here the punch mesh
      // joins the MAIN scene and the opaque sort orders the single world pass
      // terrain family → punch → shells/statics/cells/entities. The punch
      // therefore only ever erases TERRAIN depth (the thing that covers a
      // below-grade interior), and every occluder is depth-tested normally:
      // no world/cells split, no union scissor (the MSAA black box), no
      // stencil occlusion gate. The pass object stays as the aperture
      // container `tickPortalPunch` feeds; it is never added to the composer.
      portalPunchPass = new PortalPunchPass(scene, camera, "punch", { stencil: false });
      portalPunchPass.enabled = false;
      portalPunchPass.inScene = true;
      portalPunchPass.apertureGroup.userData.__punchPhase = 1;
      scene.add(portalPunchPass.apertureGroup);
      // The phase is the program sort's PRIMARY key (draw_sort_program.js), not
      // a replacement for it; punchPhaseOpaqueSort only serves the
      // ?drawSortProgram=off arm.
      setDrawSortPhase(renderer, _punchPhase, punchPhaseOpaqueSort);
    } else {
      portalPunchPass = new PortalPunchPass(scene, camera, "punch", {
        stencil: _punchStencil,
      });
      composer.addPass(portalPunchPass);
    }
  }

  // ?indoorDepthSplit (2026-08-04). Published once per tick by cells.js
  // `tickCellVisibility3D` via `setIndoorSplitArmed`; read by
  // `preFrameSkySync`. Stays `false` forever when the flag is off (cells.js
  // never arms), so the off-state costs one already-false boolean read and the
  // composer's pass list is untouched — the split reuses the depthClearPass /
  // cellsMaskPass / cellsRenderPass slots that have existed (disabled) since
  // the Phase 5 PView work.
  let indoorSplitArmed = false;

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
  // Live only when ?indoorDepthSplit is engaged (see the PORTAL SEAL note
  // below); hoisted above the wipe because two of the seal's slots must run
  // BEFORE it.
  const indoorDepthSplitFlag = (() => {
    try {
      const v = new URLSearchParams(globalThis.location?.search || "").get("indoorDepthSplit");
      return v !== "off"; // DEFAULT-ON (2026-08-04); "on"/"retail"/"strict"/absent all construct the seal slot
    } catch (_) { return false; }
  })();
  const portalSealPass = indoorDepthSplitFlag ? new PortalPunchPass(scene, camera, "seal") : null;

  // SEAL round 3 (2026-10-05) — the two seal slots that precede the wipe,
  // retail PView::DrawCells order (acclient.c:461480-461484):
  //   sealRemainderPass — the OUTDOOR REMAINDER (player-landblock shells and
  //     statics cells.js relayered onto layer 1, plus outdoor entities) drawn
  //     against the WORLD depth, so terrain / other-landblock houses occlude it
  //     exactly as LScape::draw depth-tests all outdoor content together. Round
  //     2 drew it after the wipe, against nothing.
  //   sealDepthSavePass — copies that outdoor depth aside; sealDepthRestorePass
  //     (after the cells pass) puts it back under the sealed pixels.
  // All three are disabled unless the seal is live this frame (preFrameSkySync).
  let sealRemainderPass = null;
  let sealDepthSavePass = null;
  let sealDepthRestorePass = null;
  if (portalSealPass) {
    sealRemainderPass = new SealRemainderPass(portalSealPass);
    sealRemainderPass.enabled = false;
    composer.addPass(sealRemainderPass);
    sealDepthSavePass = new SealDepthSavePass(portalSealPass);
    sealDepthSavePass.enabled = false;
    composer.addPass(sealDepthSavePass);
  }

  const depthClearPass = new ClearPass(false, true, false);
  depthClearPass.enabled = false;
  composer.addPass(depthClearPass);

  // PORTAL SEAL (2026-08-04 round 6) — retail's step 3 between the Z wipe and
  // the cell draws (`DrawPortalPolyInternal(portal, zClear=0)`,
  // acclient.c:461536). Re-stamps each outdoor-facing aperture at its TRUE
  // depth so interior geometry beyond the doorway plane is depth-rejected and
  // the world pass's colour seen through the doorway survives. Only added when
  // the indoor-split flag is live, so the composer pass list is byte-identical
  // otherwise. Ordering is load-bearing: AFTER depthClearPass, BEFORE the cells
  // mask/render pair.
  // Live only when ?indoorDepthSplit is engaged. Read (above) rather than
  // plumbed through options so the pipeline cannot be constructed in a state
  // where the seal slot is missing while cells.js is arming the split.
  // `off`/absent => the pass is never constructed and the composer list is
  // byte-identical.
  if (portalSealPass) {
    portalSealPass.enabled = false;
    composer.addPass(portalSealPass);
  }

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

  // SEAL round 3 — depth restore, right after the cells pass (see above).
  if (portalSealPass) {
    sealDepthRestorePass = new SealDepthRestorePass(portalSealPass);
    sealDepthRestorePass.enabled = false;
    composer.addPass(sealDepthRestorePass);
  }

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
  // 2026-10-07 `?aerialSun` — read once; preFrameSkySync copies the sky's sun.
  const aerialSunOn = typeof opts?.aerialSun === "boolean" ? opts.aerialSun : aerialSunEnabled();

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

  // Tone mapping — collapses the HalfFloat HDR pipeline to sRGB. MUST run
  // AFTER LensFlare (so the flare's HDR extraction works) and BEFORE
  // Dithering (so dither operates on the final 8-bit-ish value range).
  // 2026-10-07: the curve is `?tone=` (tone_curve.js) — Khronos PBR Neutral
  // by default (owner's pick on the 1070: AC's painted albedo reaches the
  // screen instead of AGX's desaturated mid-range); `?tone=agx` restores the
  // previous takram-recommended AGX look exactly.
  const toneMapping = new ToneMappingEffect({ mode: toneMappingModeFor(toneCurveName(), ToneMappingMode) });
  // Display-referred look (contrast / warmth / night tint), merged into the
  // same pass right after the curve; null under `?grade=off` (color_grade.js).
  const colorGrade = createColorGradeEffect();
  // Screen-space AO (ssao.js): its own half-res pass before the atmosphere
  // pass, composited as the FIRST effect of that pass so aerial perspective
  // (and the clouds) apply on top — distant haze is never darkened.
  const ssaoPass = ssaoOpt ? new SsaoPass(camera) : null;
  // 2026-10-08 — ?layerHaze (default 0.4): after the clouds / aerial
  // perspective pass, before bloom + tone mapping (see layered_haze.js).
  const layerHazeStr = layerHazeStrength();
  const layeredHaze = layerHazeStr > 0
    ? new LayeredHazePass(camera, {
      strength: layerHazeStr,
      getFogColor: () => (scene && scene.fog && scene.fog.color) || null,
      isSkyBlocked: () => {
        const sd = globalThis.window?.liveScene3d?.skyDome;
        return !!(sd?._lastSkyBlocked ?? sd?._lastIsIndoor);
      },
    })
    : null;
  const ssaoComposite = ssaoPass ? new SsaoCompositeEffect(ssaoPass) : null;
  // The composite restores the grass marker's alpha, so only mark while it exists.
  SSAO_GRASS_MARKER.value = ssaoComposite ? 1 : 0;
  const dithering = new DitheringEffect();

  // Bloom — HDR halo around bright pixels (sun disc, lava, lit windows,
  // magic flashes). Threshold 0.85 keeps the diffuse sky from blooming
  // uniformly while the sun (well above 1.0 in HDR) lights up. mipmapBlur
  // takes the GPU's mip chain for a cheap 5-level downsample (~1ms @ 1080p
  // R9 290; ~0.5ms 1440p 1070) vs. ~3ms for the gaussian path. Disable by
  // passing `bloom: false` in opts.
  // 2026-10-07 (1070 look pass, Neutral tone curve): 1.0 / 0.85 was tuned
  // under AGX, whose shoulder compressed the halo; through Neutral the low sun
  // bloomed into an orange wash over the whole lower frame at dusk and dawn
  // (live A/B at 21:20 game time: 0.55 / 1.1 keeps a crisp disc + glow, the
  // ground and cloud detail, and still lets fires / lanterns / spells bloom).
  const bloom = bloomOpt
    ? new BloomEffect({
        intensity: 0.55,
        luminanceThreshold: 1.1,
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

  // Clouds in the main pass (`?cloudsMainPass=on`). The CloudOverlay is built
  // by index.js before this pipeline (its `?clouds=on` block runs first);
  // `opts.cloudOverlay` wins, else the live scene handle. null → the slot is
  // dropped by filter(Boolean) and the pass is byte-identical to before.
  const cloudOverlayForMain = cloudsMainPassEnabled()
    ? (opts?.cloudOverlay ?? globalThis.window?.liveScene3d?.cloudOverlay ?? null)
    : null;
  const cloudsMain =
    cloudOverlayForMain && typeof cloudOverlayForMain.adoptMainPass === "function"
      ? (cloudOverlayForMain.volume?.effect ?? null)
      : null;

  // `?particlesOverClouds` (2026-10-07, DEFAULT ON) — split the post chain
  // around a late particle draw (see ParticlesOverCloudsPass). Only when the
  // clouds ARE in this chain: without them (`?cloudsMainPass=off`, no
  // `?clouds=on`) the cloud quad is drawn by the sky pass, before the world,
  // and the single legacy fxPass below is kept byte-identical.
  // `opts.particlesOverClouds` (boolean) overrides the URL for tests.
  const particlesOverCloudsFlag = typeof opts?.particlesOverClouds === "boolean"
    ? opts.particlesOverClouds
    : particlesOverCloudsEnabled();
  // NaN/Inf scrub (2026-10-05, `?nanScrub=off` escape). One non-finite pixel
  // in the HDR scene buffer is smeared across the screen by the bloom mip-blur
  // (and propagates through aerial perspective) — the recurring "black patch"
  // shape. Bloom blurs the RAW input buffer in its own update, before the
  // effects merged into fxPass run, so the scrub must be its OWN pass ahead of
  // fxPass, not an effect inside it. Worst case a bad shader now costs single
  // black pixels instead of patches. One cheap fullscreen pass.
  const nanScrubOn = (() => {
    try {
      return new URLSearchParams(globalThis.location?.search || "").get("nanScrub")?.toLowerCase() !== "off";
    } catch (_) { return true; }
  })();
  // 2026-10-06 — the 10-05 scrub never worked: an Effect's default blend is
  // NORMAL, `mix(dst, src, opacity)`, and `NaN * 0.0` is NaN, so every scrubbed
  // pixel got its NaN mixed straight back in (1070 readback: the buffer entering
  // fxPass held the same 2 NaN pixels as the one entering the scrub, and bloom
  // blacked the WHOLE frame at Holtburg). SRC blend returns the scrubbed colour
  // alone. The non-finite test reads the exponent bits so a fast-math HLSL
  // compile cannot fold it away, and negative radiance (same bad pixels, -0.19)
  // is clamped — bloom would otherwise spread it as a dark smear.
  const makeNanScrub = () => new Effect(
    "NanScrub",
    /* glsl */ `
    bool hbNonFinite(const in vec4 c) {
      uvec4 e = floatBitsToUint(c) & uvec4(0x7f800000u);
      return any(equal(e, uvec4(0x7f800000u)));
    }
    void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
      outputColor = hbNonFinite(inputColor) ? vec4(0.0, 0.0, 0.0, 1.0) : max(inputColor, vec4(0.0));
    }`,
    { blendFunction: BlendFunction.SRC },
  );
  // 2026-10-07 (later) — the late target T is written AFTER the scrub above, and
  // bloom blurs T: the 1070 readback found persistent negative-radiance pixels
  // in T (rows ~720 / ~792, 13 of 583 sampled strips) and the owner saw the
  // black flashing come back with the split. So the split chain scrubs T again,
  // as its own pass (bloom reads its INPUT buffer in update(), before any merged
  // effect runs): T -> late NanScrub -> composer buffer -> post half.
  let lateScrubPass = null;
  let particlesOverCloudsPass = null;
  let fxPostPass = null;
  let fxPass;
  if (particlesOverCloudsFlag && cloudsMain) {
    particlesOverCloudsPass = new ParticlesOverCloudsPass(scene, camera, {
      stencil: composer.inputBuffer.stencilBuffer === true,
      // The texture the world pass's depth lands in (pmndrs re-attaches it to
      // the input buffer before every pass; MSAA resolves into it).
      depthSource: () => composer.depthTexture,
    });
    // Same slot order as the legacy list below, cut after the cloud/aerial
    // composite: HeatHaze → Clouds → AerialPerspective → [HorizonDissolve]
    // | particles | LensFlare → Bloom → Vignette → ToneMapping → ColorGrade
    // → Dithering.
    const atmosEffects = [heatHaze, ssaoComposite, cloudsMain, aerialPerspective, horizonDissolve].filter(Boolean);
    const postEffects = [lensFlare, bloom, vignette, toneMapping, colorGrade, dithering].filter(Boolean);
    fxPass = new PostChainTargetPass(camera, particlesOverCloudsPass, ...atmosEffects);
    if (nanScrubOn) {
      lateScrubPass = new PostChainSourcePass(camera, particlesOverCloudsPass, makeNanScrub());
      fxPostPass = new PostChainSourcePass(camera, null, ...postEffects);
    } else {
      fxPostPass = new PostChainSourcePass(camera, particlesOverCloudsPass, ...postEffects);
    }
  } else {
    // EffectPass composition order: HeatHaze → [Clouds] → AerialPerspective → LensFlare →
    // Bloom → Vignette → ToneMapping → Dithering. Everything except ToneMapping +
    // Dithering operates in HDR space. `filter(Boolean)` drops the disabled
    // slots without leaving holes in the pass.
    fxPass = new EffectPass(
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
      // cloudsMain (null unless `?cloudsMainPass=on` + `?clouds=on`) sits
      // between heatHaze and aerialPerspective: its update() must raymarch
      // before AerialPerspective's update() reads the overlay map it produces
      // (pmndrs updates effects in list order; all three carry DEPTH so the
      // stable attribute sort keeps this order).
      ...[heatHaze, ssaoComposite, cloudsMain, aerialPerspective, horizonDissolve, lensFlare, bloom, vignette, toneMapping, colorGrade, dithering].filter(Boolean),
    );
  }
  if (nanScrubOn) {
    const scrub = makeNanScrub();
    composer.addPass(new EffectPass(camera, scrub));
  }
  // AO reads the composer's stable depth copy (needsDepthTexture), so it must
  // run after the world pass and before the pass that composites it.
  if (ssaoPass) composer.addPass(ssaoPass);
  // Unsplit chain: fxPass also tone-maps, so the haze has to go in front of it.
  if (layeredHaze && !particlesOverCloudsPass) composer.addPass(layeredHaze);
  composer.addPass(fxPass);
  if (particlesOverCloudsPass) {
    composer.addPass(particlesOverCloudsPass);
    if (lateScrubPass) composer.addPass(lateScrubPass);
    // Split chain: after clouds + aerial perspective + late particles, before
    // the bloom / tone-mapping pass — haze in HDR over the finished scene.
    if (layeredHaze) composer.addPass(layeredHaze);
    composer.addPass(fxPostPass);
  }
  // Hand the clouds over only once the pass that now owns them exists: the
  // overlay retires its private composer + sky quad and points
  // AerialPerspective's overlay/shadowLength at the cloud buffers.
  const cloudsMainAdopted = !!(cloudsMain && cloudOverlayForMain.adoptMainPass({ aerialPerspective }));
  // 2026-10-07 (1070 vis-test of b8819698): the adoption NULLS the shared
  // CloudsEffect's scene depth. Retiring the overlay's private composer calls
  // pmndrs `removePass(privatePass)`, and when no remaining pass needs depth
  // removePass runs `privatePass.setDepthTexture(null)` (postprocessing
  // build/index.js removePass) — which forwards to every effect of that pass,
  // i.e. the CloudsEffect this composer's fxPass now owns. Measured live:
  // cloudsPass depthBuffer = null, so every cloud ray marched to infinity and
  // the overlay painted cloud over hills, trees and the town. Re-hand the
  // fxPass's depth (the composer's stable depth copy) to its effects.
  if (cloudsMainAdopted && typeof fxPass.getDepthTexture === "function" && fxPass.getDepthTexture()) {
    fxPass.setDepthTexture(fxPass.getDepthTexture(), fxPass.fullscreenMaterial?.depthPacking);
  }

  // Live tuning handle for the 1070 eye-test, mirroring `window.__horizonFade`:
  // `__heatHaze.strength = 0.012`, `.freq`, `.speed`, and `.state` for a
  // snapshot of what the terrain provider is publishing. No-op when off.
  installHeatHazeHandle(heatHaze);
  installColorGradeHandle(colorGrade);
  installSsaoHandle(ssaoPass);
  installLayerHazeHandle(layeredHaze);

  // `?particlesOverClouds` runtime state. `lateArmed` is the no-reload A/B
  // seam (`__particlesOverClouds.set(false)` puts the particles back in the
  // world pass, under the clouds; the split chain itself stays). preFrameSkySync
  // decides `lateThisFrame` (false on split frames).
  let lateArmed = true;
  let lateThisFrame = !!particlesOverCloudsPass;
  let lateSkippedSplit = 0;
  let lateSkippedDisarmed = 0;
  if (typeof window !== "undefined") {
    const describe = (p) => p.name +
      (Array.isArray(p.effects) ? `[${p.effects.map((e) => e.name).join(", ")}]` : "") +
      (p.enabled === false ? " (disabled)" : "");
    window.__particlesOverClouds = {
      /** URL flag at boot (`?particlesOverClouds`, default on). */
      get flag() { return particlesOverCloudsFlag; },
      /** The split chain exists (needs the clouds in the main pass). */
      get built() { return !!particlesOverCloudsPass; },
      get armed() { return lateArmed; },
      get activeThisFrame() { return lateThisFrame; },
      /** A/B without a reload: false = particles drawn in the world pass again. */
      set(on) {
        lateArmed = !!on;
        if (!lateArmed && particlesOverCloudsPass) {
          lateThisFrame = false;
          particlesOverCloudsPass.enabled = false;
        }
        return this.stats();
      },
      stats() {
        const p = particlesOverCloudsPass;
        const rt = p?.renderTarget;
        return {
          flag: particlesOverCloudsFlag,
          built: !!p,
          why: p ? "split chain" : (!particlesOverCloudsFlag ? "flag off" : "clouds not in the main pass (legacy overlay is already behind the world)"),
          armed: lateArmed,
          activeThisFrame: lateThisFrame,
          skippedSplitFrames: lateSkippedSplit,
          skippedDisarmedFrames: lateSkippedDisarmed,
          ...(p ? p.stats : {}),
          target: rt ? `${rt.width}x${rt.height} RGBA16F, depth=${rt.depthTexture ? (rt.depthTexture === composer.depthTexture ? "composer.depthTexture" : "OTHER") : "none"}` : null,
        };
      },
      passes() { return composer.passes.map(describe); },
      reset() {
        lateSkippedSplit = 0;
        lateSkippedDisarmed = 0;
        if (particlesOverCloudsPass) {
          const s = particlesOverCloudsPass.stats;
          for (const k of Object.keys(s)) s[k] = 0;
        }
        return this.stats();
      },
    };
  }

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

  // Seal round 3 slots follow the seal: the remainder pre-draw when the seal
  // has a remainder to draw, the depth save/restore when the wall is live.
  function _setSealSlots(sealOn) {
    if (sealRemainderPass) sealRemainderPass.enabled = sealOn && portalSealPass.wantsRemainder;
    const restore = sealOn && portalSealPass.wantsDepthRestore;
    if (sealDepthSavePass) sealDepthSavePass.enabled = restore;
    if (sealDepthRestorePass) sealDepthRestorePass.enabled = restore;
  }

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
    if (fxPostPass) fxPostPass.mainCamera = cam;
    // `.camera`: ParticlesOverCloudsPass is a base Pass (no-op mainCamera).
    if (particlesOverCloudsPass) particlesOverCloudsPass.camera = cam;
  }

  // Bug 11 diag: one line per resize (rate-limited) — correlate any
  // "[.WebGL] GL_INVALID_FRAMEBUFFER_OPERATION" with the resize that preceded it.
  let _lastResizeLogMs = -1e9;
  function _logResize(w, h) {
    try {
      const now = (typeof performance !== "undefined") ? performance.now() : 0;
      if (now - _lastResizeLogMs < 2000) return;
      _lastResizeLogMs = now;
      const dbs = renderer.getDrawingBufferSize(new THREE.Vector2());
      // eslint-disable-next-line no-console
      console.info(`[resize] composer css=${Math.round(w)}x${Math.round(h)} dbs=${dbs.x}x${dbs.y} pmDepth=${composer.depthTexture ? "disposed→realloc" : "none"}`);
    } catch (_) { /* diag only */ }
  }

  return {
    composer,
    aerialPerspective,
    // true when `?cloudsMainPass=on` moved the CloudsEffect into fxPass.
    cloudsMainPass: cloudsMainAdopted,
    horizonDissolve,
    // null unless ?terrainVolcano=on&terrainHaze=on (wave 2B, plan §3.6).
    heatHaze,
    skyCapturePass,
    lensFlare,
    bloom,
    vignette,
    toneMapping,
    // null under `?grade=off`; live handle `window.__grade`.
    colorGrade,
    // null unless the preset / `?ssao=on`; live handle `window.__ssao`.
    ssaoPass,
    // null under `?layerHaze=off`; live handle `window.__layerHaze`.
    layeredHaze,
    dithering,
    skyRenderPass,
    worldRenderPass,
    portalStencilPass,
    portalPunchPass,
    portalSealPass,
    sealRemainderPass,
    sealDepthSavePass,
    sealDepthRestorePass,
    // Phase 5 PView render-order fix (2026-05-25) — exposed for diag
    // probes + the zfighting harness, which reads `depthClearPass.enabled`
    // to confirm the indoor split is wired.
    worldMaskPass,
    depthClearPass,
    cellsMaskPass,
    cellsRenderPass,
    cellsPostMaskPass,
    // With `?particlesOverClouds` built: fxPass = [HeatHaze?, Clouds,
    // AerialPerspective] into the late target, fxPostPass = [Bloom, …,
    // Dithering] from it. Otherwise fxPass is the single legacy pass and both
    // others are null.
    fxPass,
    fxPostPass,
    particlesOverCloudsPass,

    /**
     * ?indoorDepthSplit (2026-08-04) — arm/disarm retail's indoor
     * `PView::DrawCells` structure for the NEXT frame. Called once per tick by
     * cells.js `tickCellVisibility3D`, which owns the (indoor && camera-below-
     * terrain) decision AND the matching restriction of the cells pass to the
     * portal set. Split here rather than computed in `preFrameSkySync` for the
     * same reason `_lastIsIndoor` is: the render dispatch must never call into
     * wasm (`?nullRender=1` / capture cadences throttle the session).
     *
     * @param {boolean} armed
     */
    setIndoorSplitArmed(armed) {
      indoorSplitArmed = !!armed;
    },

    /** Diag read-back for `__diag` / the zfighting harness. */
    isIndoorSplitArmed() {
      return indoorSplitArmed;
    },

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
    preFrameSkySync(skyDome, mainCamera, atmosphereSky = null) {
      // 2026-10-07 `?aerialSun` — AerialPerspective lights its inscatter with
      // the sky's sun (it was (0,0,0); see aerialSunEnabled). Two vec3 compares.
      if (aerialSunOn && atmosphereSky) syncAerialSun(aerialPerspective, atmosphereSky);
      const isIndoor = !!skyDome?._lastIsIndoor;
      // SKY-SEEN-OUTSIDE (2026-08-04): the SKY gates read the composite flag
      // (indoor AND not SeenOutside — sky_dome.js tick) so a cottage interior
      // keeps its sky behind the doorway/window view; dungeon cells (never
      // SeenOutside) black out exactly as before. Everything else in this
      // method (punch split, layer masks) still keys off `isIndoor`.
      const skyBlocked = !!(skyDome?._lastSkyBlocked ?? isIndoor);

      // Sky-K.2 sky-pass + sky-camera sync (existing behaviour).
      if (skyRenderPass) {
        skyRenderPass.enabled = !!skyDome && !skyBlocked;
        if (skyRenderPass.enabled && typeof skyDome.syncSkyCamera === "function") {
          skyDome.syncSkyCamera(mainCamera);
        }
      }

      // Job A — the horizon dissolve only makes sense when the sky is visible.
      // Indoors (sky pass off, world clears colour) skip the capture and no-op
      // the effect so distant indoor geometry is never tinted sky-colour.
      // ?indoorDepthSplit (2026-08-04 round 3) — mark which renderer drove this
      // frame, so "armed but nothing changed" can be told apart from "armed and
      // the split ran" without a screenshot. The direct-render fallback in
      // index.js stamps "direct"; reaching here means the composer ran.
      if (skyDome) skyDome._indoorSplitPath = "composer";

      const skyVisible = !!skyDome && !skyBlocked;
      if (skyCapturePass) skyCapturePass.enabled = skyVisible;
      // DEPTH-CONSUMER GUARD. The armed split deliberately leaves TERRAIN at
      // far depth (its depth is wiped and only layer-1 geometry rewrites it),
      // and the horizon dissolve blends any pixel past HORIZON_DISSOLVE_END_M
      // (1150 m) fully into the sky. Far depth reads as "beyond the end", so
      // leaving it on would dissolve every terrain pixel — the whole view out
      // the doorway — to flat sky colour. Retail draws no atmosphere at all
      // from inside a cell (`PView::DrawCells` has no aerial/fog stage), so
      // switching it off while armed is both the fix and the faithful choice.
      if (horizonDissolve) {
        horizonDissolve.setEnabled(skyVisible && !(indoorSplitArmed && isIndoor));
      }

      // World pass clear flags. The world pass is the first GEOMETRY pass, so
      // it always starts from a FRESH depth buffer; it keeps the COLOR the sky
      // pass drew (outdoor) or clears color too (indoor / no sky pass). Note
      // `clearDepth` must be true even indoors now — the old code relied on
      // depthClearPass to reset depth, and that pass (still in the composer)
      // now only runs between the world and cells passes of the armed
      // ?indoorDepthSplit indoor split, never BEFORE the world pass — so leaving
      // it false would render the world pass against stale depth.
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
        !punchRetail && // retail order punches inside the single world pass
        !isIndoor &&
        !!portalPunchPass &&
        portalPunchPass.hasApertures;
      //
      // ?indoorDepthSplit (2026-08-04) — THE CAMERA-INSIDE HALF, and the
      // rectification of the rectification above. The 2026-05-29 note is right
      // that the OLD split caused the see-through, and wrong that the split
      // itself is the sin: retail's indoor frame IS this split.
      // `SmartBox::RenderNormalMode` (acclient.c:144889) sends any EnvCell
      // viewer to `DrawInside` → `PView::DrawCells(pview, 0)`
      // (acclient.c:461450), which draws the landscape (portal-clipped),
      // then `Clear(4 /*Z only*/, …, 1.0f)` — a FULL-SCREEN depth wipe,
      // acclient.c:461484 + :457577 — then re-stamps the exterior portal planes
      // at true depth, then draws `cell_draw_list` with a normal LESS test.
      // There is NO terrain-vs-building exclusion anywhere in retail; the Z
      // wipe is the entire mechanism, which is why terrain can never occlude an
      // interior there and does here.
      //
      // What actually regressed in 2026-05-29 was the pair (trigger, content):
      // the trigger fired while the camera was visually outside, and the second
      // pass drew the AABB-frustum/stablist union instead of retail's
      // portal-clipped `cell_draw_list`. cells.js fixes BOTH before setting
      // this flag — it arms only when the camera is genuinely below the terrain
      // surface (or `=retail` for the A/B), and it narrows the cell set to the
      // portal walk in the same tick. This branch therefore does only what
      // retail does, and never fires unless cells.js says the camera is inside.
      //
      // Ordering: the punch (outdoor) wins if both somehow ask, because
      // `punchActive` requires `!isIndoor` and the split requires indoor —
      // they are mutually exclusive by construction, and the `else if` makes
      // that structural rather than incidental.
      //
      // 2026-10-05: the punch pass was added unconditionally and never
      // disabled, so it stamped far-Z into doorways on frames whose cells
      // pass does NOT run to refill them (stale skyDome._lastIsIndoor vs the
      // per-frame punch feed, or the indoor-split branch). Retail punches
      // only inside the building pass that then draws the reached cells.
      if (portalPunchPass) portalPunchPass.enabled = punchActive;
      if (punchActive) {
        // (1) world pass → terrain + facade + outdoor statics only (layer 0).
        worldMaskPass.mask = CAM_LAYER_MASK_WORLD_ONLY;
        // (2) portalPunchPass (already sequenced after the world pass) punches
        //     depth to FAR inside each aperture. NOT the global depth wipe (that
        //     caused the 2026-05-29 see-through); the punch is bounded to doorways.
        depthClearPass.enabled = false;
        if (portalSealPass) portalSealPass.enabled = false;
        _setSealSlots(false);
        // (3) cells pass → interior EnvCells + entities (layer 1) with the world
        //     depth + punches intact (clear=false/clearDepth=false). Interior
        //     wins inside the punched doorways, loses behind the facade.
        cellsMaskPass.enabled = true;
        cellsRenderPass.enabled = true;
      } else if (indoorSplitArmed && isIndoor) {
        // ROUND 2 (2026-08-04), after live verification. The masks below are
        // UNCHANGED from round 1 — what changed is what the two layers MEAN,
        // and that is done entirely in cells.js. Round 1 assumed layer 1 held
        // the interior; at the Holtburg meeting hall `cellContainers3d` was
        // empty and the room VANISHED, because the walls you see from inside a
        // town building are the BUILDING MODEL (buildingsGroup, layer 0 —
        // index.js:1319, never stamped), not EnvCell surfaces. So while armed,
        // cells.js moves the player's-landblock buildingsGroup + staticsGroup
        // onto layer 1 (see SPLIT_RELAYER_GROUPS there). The split then reads:
        //
        // (1) world pass, layer 0 → TERRAIN (plus other landblocks' buildings,
        //     which stay on layer 0 on purpose and so keep terrain occlusion).
        //     Retail's `LScape::draw` at :461480.
        worldMaskPass.mask = CAM_LAYER_MASK_WORLD_ONLY;
        // (2) full depth wipe, colour kept — retail's `Clear(4, …, 1.0f)` at
        //     :461484. `ClearPass(false, true, false)` is exactly that.
        depthClearPass.enabled = true;
        // (3) cells pass, layer 1 → the room SHELL + its props + the portal-set
        //     EnvCells + entities, against the fresh depth, so terrain can no
        //     longer occlude the room the camera is standing in. Retail's
        //     `DrawBuilding` + `DrawEnvCell` loop at :461606.
        //
        // (2b) retail step 3 — seal the doorway planes at TRUE depth so the
        //      cells pass cannot overpaint the world-pass colour (terrain AND
        //      the layer-0 outdoor particles drawn with it) that is legitimately
        //      visible through the aperture. With `?sealLogDepth` (default on)
        //      three more slots follow the seal (round 3, see where they are
        //      added): sealRemainderPass draws the player-landblock outdoor
        //      remainder BEFORE the wipe against the world depth (retail
        //      LScape::draw order, acclient.c:461480-461484), and
        //      sealDepthSavePass / sealDepthRestorePass put the outdoor depth
        //      back under the sealed pixels after the cells pass, so the
        //      depth-reading post effects (aerial perspective, heat haze, the
        //      cloud overlay; horizonDissolve is off while armed) see the
        //      terrain's real distance through a doorway instead of the wall.
        //      Retail draws no atmosphere indoors; the bar is "the doorway view
        //      looks like the same view outdoors". Fed by cells.js
        //      tickPortalSeal from the PView walk's outside view.
        if (portalSealPass) portalSealPass.enabled = portalSealPass.hasApertures;
        _setSealSlots(!!portalSealPass && portalSealPass.enabled);
        cellsMaskPass.enabled = true;
        cellsRenderPass.enabled = true;
      } else {
        if (portalSealPass) portalSealPass.enabled = false;
        _setSealSlots(false);
        worldMaskPass.mask = CAM_LAYER_MASK_BOTH;
        depthClearPass.enabled = false;
        cellsMaskPass.enabled = false;
        cellsRenderPass.enabled = false;
      }
      // cellsPostMaskPass is always enabled — mask=BOTH no matter what,
      // so steady-state outdoor consumers observe the unsplit mask. The
      // single mask write is ~free.

      // `?particlesOverClouds` — the late particle draw runs on unsplit frames
      // only. On a split frame (punch or indoor) the particles stay in their
      // legacy world/cells passes: the doorway seal keeps the layer-0 outdoor
      // particles the world pass drew before the depth wipe, and nothing in a
      // split frame is against the sky.
      if (particlesOverCloudsPass) {
        const split = punchActive || (indoorSplitArmed && isIndoor);
        lateThisFrame = lateArmed && !split;
        if (!lateArmed) lateSkippedDisarmed++;
        else if (split) lateSkippedSplit++;
        particlesOverCloudsPass.enabled = lateThisFrame;
      }
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
      if (portalSealPass && cam) portalSealPass.camera = cam;
      // `?particlesOverClouds` — hide this frame's particle draw objects from
      // the world pass (the world pass draws with mask BOTH on an unsplit
      // frame), draw them in the late pass, and restore them whatever happens.
      let lateOpen = false;
      if (particlesOverCloudsPass && lateThisFrame && particlesOverCloudsPass.enabled) {
        particlesOverCloudsPass.camera = activeCamera;
        lateOpen = particlesOverCloudsPass.beginFrame(CAM_LAYER_MASK_BOTH);
      }
      try {
        composer.render(dt);
      } finally {
        if (lateOpen) particlesOverCloudsPass.endFrame();
      }
    },

    setSize(w, h) {
      composer.setSize(w, h);
      // Bug 11 (2026-10-07, black flicker + 256× "glBlitFramebuffer:
      // Framebuffer is incomplete: Attachments are not all the same size").
      // pmndrs re-attaches ITS OWN depth texture (`composer.depthTexture`) to
      // `inputBuffer` before every pass (postprocessing 6.39.1
      // EffectComposer.render: `inputBuffer.depthTexture = this.depthTexture`).
      // three only frees a render target's depth texture when that target is
      // resized WHILE the texture is attached to it (deallocateRenderTarget),
      // and never re-allocates the immutable storage of a live depth texture
      // (WebGLTextures upload: `allocateMemory` only when __version is unset).
      // The bespoke swap below detaches pmndrs' texture from both buffers, so
      // a second resize before the next render (adaptive render scale +
      // window resize in one frame, Options apply, …) left it at the OLD
      // size: the next render attached old-size depth to new-size colour →
      // incomplete FBO → black frames until some later resize freed it.
      // Disposing it here is always safe: three re-creates it at the size of
      // the target it is next attached to.
      const pmDepth = composer.depthTexture;
      if (pmDepth) {
        try { pmDepth.dispose(); } catch (_) { /* re-created on next attach */ }
      }
      _logResize(w, h);
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
      ssaoPass?.setCamera?.(cam);
      layeredHaze?.setCamera?.(cam);
      worldMaskPass.setCamera(cam);
      cellsMaskPass.setCamera(cam);
      cellsPostMaskPass.setCamera(cam);
      retargetFxPass(cam);
      activeCamera = cam;
    },

    dispose() {
      // CloudVolume is the SOLE owner of the CloudsEffect (see
      // test_cloud_overlay_dispose): hand it back and keep fxPass.dispose()
      // from freeing it.
      if (cloudsMainAdopted) {
        try { cloudOverlayForMain.releaseMainPass?.(); } catch (_) {}
        const hadOwn = Object.prototype.hasOwnProperty.call(cloudsMain, "dispose");
        const effDispose = cloudsMain.dispose;
        cloudsMain.dispose = () => {};
        try {
          composer.passes.forEach((p) => p.dispose?.());
        } finally {
          if (hadOwn) cloudsMain.dispose = effDispose;
          else delete cloudsMain.dispose;
        }
      } else {
        composer.passes.forEach((p) => p.dispose?.());
      }
      aerialPerspective.dispose?.();
      lensFlare?.dispose?.();
      bloom?.dispose?.();
      vignette?.dispose?.();
      heatHaze?.dispose?.();
      toneMapping.dispose?.();
      colorGrade?.dispose?.();
      if (ssaoComposite) SSAO_GRASS_MARKER.value = 0;
      if (layeredHaze) installLayerHazeHandle(null);
      dithering.dispose?.();
    },
  };
}
