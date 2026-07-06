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

// pmndrs Effect fragment. Runs inside fxPass in HDR (before ToneMapping) so the
// blend is in the same radiance space as the captured sky. Depth arrives RAW
// from the logarithmicDepthBuffer (index.js:768) — decoded to metres here;
// treating it as linear would place the band at a wildly wrong distance.
const HORIZON_DISSOLVE_FRAG = /* glsl */ `
uniform sampler2D hbSkyBuffer;
uniform float hbDissolveStart;
uniform float hbDissolveEnd;
uniform float hbLogDepthFC;
uniform float hbEnabled;

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
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
  float dist = exp2(2.0 * depth / hbLogDepthFC) - 1.0;
  float f = smoothstep(hbDissolveStart, hbDissolveEnd, dist);
  if (f <= 0.0) {
    outputColor = inputColor;
    return;
  }
  // hbSkyBuffer holds the physical sky rendered behind everything, so the
  // sample at this uv IS the sky in this pixel's exact view direction —
  // seam-free, no fog colour, time-of-day-correct for free.
  vec3 skyColor = texture2D(hbSkyBuffer, uv).rgb;
  outputColor = vec4(mix(inputColor.rgb, skyColor, f), inputColor.a);
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
  constructor({ skyTexture, cameraFar, start, end }) {
    super("HorizonDissolveEffect", HORIZON_DISSOLVE_FRAG, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map([
        ["hbSkyBuffer", new THREE.Uniform(skyTexture ?? null)],
        ["hbDissolveStart", new THREE.Uniform(start)],
        ["hbDissolveEnd", new THREE.Uniform(end)],
        ["hbLogDepthFC", new THREE.Uniform(2.0 / Math.log2(cameraFar + 1.0))],
        ["hbEnabled", new THREE.Uniform(1.0)],
      ]),
    });
  }
  setCameraFar(far) {
    this.uniforms.get("hbLogDepthFC").value = 2.0 / Math.log2(far + 1.0);
  }
  setEnabled(on) {
    this.uniforms.get("hbEnabled").value = on ? 1.0 : 0.0;
  }
  get start() { return this.uniforms.get("hbDissolveStart").value; }
  set start(v) { this.uniforms.get("hbDissolveStart").value = v; }
  get end() { return this.uniforms.get("hbDissolveEnd").value; }
  set end(v) { this.uniforms.get("hbDissolveEnd").value = v; }
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
  const horizonFadeEnabled = (() => {
    if (typeof opts?.horizonFade === "boolean") return opts.horizonFade;
    try {
      if (typeof window === "undefined" || !window.location?.search) return false;
      const v = new URLSearchParams(window.location.search).get("horizonFade");
      return typeof v === "string" && v.toLowerCase() === "on";
    } catch (_) {
      return false;
    }
  })();

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
  const sceneDepthTexture = new THREE.DepthTexture(width, height);
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

  let skyRenderPass = null;
  if (skyScene && skyCamera) {
    skyRenderPass = new RenderPass(skyScene, skyCamera);
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
      start: HORIZON_DISSOLVE_START_M,
      end: HORIZON_DISSOLVE_END_M,
    });
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

  // EffectPass composition order: AerialPerspective → LensFlare → Bloom →
  // Vignette → ToneMapping → Dithering. Everything except ToneMapping +
  // Dithering operates in HDR space. `filter(Boolean)` drops the disabled
  // slots without leaving holes in the pass.
  const fxPass = new EffectPass(
    camera,
    // horizonDissolve sits right after aerialPerspective and before
    // lensFlare/bloom/vignette/toneMapping so the terrain→sky blend happens
    // in HDR (matching the captured sky's radiance space); null when
    // `?horizonFade=off` and dropped by filter(Boolean).
    ...[aerialPerspective, horizonDissolve, lensFlare, bloom, vignette, toneMapping, dithering].filter(Boolean),
  );
  composer.addPass(fxPass);

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

  return {
    composer,
    aerialPerspective,
    horizonDissolve,
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
      // Dispose the old one to release GPU memory.
      const old = sceneDepthTexture;
      const next = new THREE.DepthTexture(w, h);
      next.format = THREE.DepthFormat;
      next.type = THREE.UnsignedIntType;
      composer.inputBuffer.depthTexture = next;
      composer.outputBuffer.depthTexture = next;
      // Mutate the cached reference so getSceneDepthTexture stays valid.
      // (We can't `sceneDepthTexture = next` from inside this closure
      // because it's a `const` in the enclosing scope, so the API hands
      // out the live `composer.inputBuffer.depthTexture` instead.)
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
      activeCamera = cam;
    },

    dispose() {
      composer.passes.forEach((p) => p.dispose?.());
      aerialPerspective.dispose?.();
      lensFlare?.dispose?.();
      bloom?.dispose?.();
      vignette?.dispose?.();
      toneMapping.dispose?.();
      dithering.dispose?.();
    },
  };
}
