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
  EffectComposer,
  EffectPass,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
} from "postprocessing";
import { AerialPerspectiveEffect, AtmosphereParameters } from "@takram/three-atmosphere";
import { DitheringEffect, LensFlareEffect } from "@takram/three-geospatial-effects";

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

  const worldRenderPass = new RenderPass(scene, camera);
  if (skyRenderPass) {
    worldRenderPass.clear = false;
    worldRenderPass.clearDepth = true;
  }
  composer.addPass(worldRenderPass);

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
  const lensFlare = new LensFlareEffect({
    intensity: 0.005,
    resolutionScale: 0.5,
  });
  lensFlare.thresholdLevel = 0.9;
  lensFlare.thresholdRange = 0.1;

  // Tone mapping — collapses the HalfFloat HDR pipeline to sRGB. AGX
  // is the takram-recommended mode (well-behaved highlight roll-off,
  // designed for physically-based atmosphere/cloud output). MUST run
  // AFTER LensFlare (so the flare's HDR extraction works) and BEFORE
  // Dithering (so dither operates on the final 8-bit-ish value range).
  const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
  const dithering = new DitheringEffect();

  const fxPass = new EffectPass(camera, aerialPerspective, lensFlare, toneMapping, dithering);
  composer.addPass(fxPass);

  let activeCamera = camera;

  return {
    composer,
    aerialPerspective,
    lensFlare,
    toneMapping,
    dithering,
    skyRenderPass,
    worldRenderPass,
    fxPass,

    /**
     * Pre-frame: sync sky camera, flip sky enabled/world clear flags
     * based on indoor state.
     */
    preFrameSkySync(skyDome, mainCamera) {
      if (!skyRenderPass) return;
      if (!skyDome) {
        skyRenderPass.enabled = false;
        return;
      }
      const isIndoor = !!skyDome._lastIsIndoor;
      skyRenderPass.enabled = !isIndoor;
      if (!isIndoor && typeof skyDome.syncSkyCamera === "function") {
        skyDome.syncSkyCamera(mainCamera);
      }
      if (isIndoor) {
        worldRenderPass.clear = true;
        worldRenderPass.clearDepth = false;
      } else {
        worldRenderPass.clear = false;
        worldRenderPass.clearDepth = true;
      }
    },

    /**
     * Per-frame sun direction update. Caller pulls heading/pitch from
     * AC's SkyState and supplies the unit-vec3 here. Same conversion
     * as cloud_volume.js's sunDirFromHeadingPitch.
     */
    setSunDirection(vec3) {
      aerialPerspective.sunDirection.copy(vec3);
    },

    render(cam, dt = 0) {
      if (cam && cam !== activeCamera) {
        worldRenderPass.camera = cam;
        aerialPerspective.camera = cam;
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
      aerialPerspective.camera = cam;
      activeCamera = cam;
    },

    dispose() {
      composer.passes.forEach((p) => p.dispose?.());
      aerialPerspective.dispose?.();
      lensFlare.dispose?.();
      toneMapping.dispose?.();
      dithering.dispose?.();
    },
  };
}
