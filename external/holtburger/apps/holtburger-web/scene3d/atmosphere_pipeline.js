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
  } = opts ?? {};
  if (!atmosphereRuntime) {
    throw new Error("createAtmospherePipeline: atmosphereRuntime is required");
  }

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
  sceneDepthTexture.format = THREE.DepthFormat;
  sceneDepthTexture.type = THREE.UnsignedIntType;
  composer.inputBuffer.depthTexture = sceneDepthTexture;
  composer.outputBuffer.depthTexture = sceneDepthTexture;
  composer.inputBuffer.depthBuffer = true;
  composer.outputBuffer.depthBuffer = true;

  let skyRenderPass = null;
  if (skyScene && skyCamera) {
    skyRenderPass = new RenderPass(skyScene, skyCamera);
    composer.addPass(skyRenderPass);
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
    ...[aerialPerspective, lensFlare, bloom, vignette, toneMapping, dithering].filter(Boolean),
  );
  composer.addPass(fxPass);

  let activeCamera = camera;

  return {
    composer,
    aerialPerspective,
    lensFlare,
    bloom,
    vignette,
    toneMapping,
    dithering,
    skyRenderPass,
    worldRenderPass,
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

      // World pass clear flags (existing behaviour).
      if (isIndoor || !skyRenderPass) {
        worldRenderPass.clear = isIndoor || !skyRenderPass;
        worldRenderPass.clearDepth = false;
      } else {
        worldRenderPass.clear = false;
        worldRenderPass.clearDepth = true;
      }

      // Phase 5 PView render-order fix (2026-05-25). Mirrors WB
      // GameScene.cs:1610. When indoor:
      //   1. World pass renders layer 0 (terrain/buildings/statics).
      //   2. Depth-clear wipes terrain Z so cottage floors don't fight.
      //   3. Cells pass renders layer 1 (EnvCells + entities) on top.
      // When outdoor: single world pass renders both layers in one shot,
      // matching the pre-fix behaviour (no perf cost outdoors).
      worldMaskPass.mask = isIndoor ? CAM_LAYER_MASK_WORLD_ONLY : CAM_LAYER_MASK_BOTH;
      depthClearPass.enabled = isIndoor;
      cellsMaskPass.enabled = isIndoor;
      cellsRenderPass.enabled = isIndoor;
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
      lensFlare.dispose?.();
      bloom?.dispose?.();
      vignette?.dispose?.();
      toneMapping.dispose?.();
      dithering.dispose?.();
    },
  };
}
