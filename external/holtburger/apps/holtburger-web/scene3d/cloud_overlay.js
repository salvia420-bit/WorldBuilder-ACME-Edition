// scene3d/cloud_overlay.js — Clouds-D fullscreen overlay integration.
//
// Owns a CloudVolume + the procedural texture chain + a fullscreen
// quad that samples the cloud render target. The takram `CloudsEffect`
// is a pmndrs postprocessing Effect (extends `Effect`, not a Three
// Object3D), so it can't be `.add()`ed to a Scene Group. Instead we:
//
//   1. Per frame, call `cloudVolume.effect.update(renderer, null, dt)`
//      — this bakes the procedural noise (under real GPU; silent zero
//      under swiftshader) and ray-marches the cloud volume into the
//      internal `cloudsPass.outputBuffer` render target.
//
//   2. Right after the sky scene is rendered (and before the world
//      pass), draw a fullscreen quad that samples
//      `cloudsPass.outputBuffer.texture` and composites it over the
//      already-painted sky pixels.
//
// The "wired" lifetime: when `?renderer=3d&clouds=on` is set,
// `scene3d/index.js` constructs a CloudOverlay alongside SkyDome and
// hands the SkyDome a reference. SkyDome calls `tick()` (during its
// per-rAF tick) and `preRender()` + `renderOverlay()` (during its
// renderSkyPass — pre runs before, overlay runs after).
//
// Indoor flip is automatic: SkyDome's `renderSkyPass` already
// short-circuits when `_lastIsIndoor === true`. Since cloud rendering
// is invoked from inside renderSkyPass, dungeon cells skip clouds
// for free.
//
// Visible-clouds eye-test requires a real GPU. Headless swiftshader
// silently zero-bakes 3D textures (see Clouds-D-mini memory for
// the diagnosis). CI / smoke runs can only validate plumbing.

import * as THREE from 'three';
import { CloudVolume } from './cloud_volume.js';
import {
  CloudShape, CloudShapeDetail, LocalWeather, Turbulence,
} from '@takram/three-clouds';
import { EffectComposer, EffectPass, RenderPass } from 'postprocessing';

/**
 * @typedef {Object} CloudOverlayOptions
 * @property {THREE.PerspectiveCamera} camera — the active main camera;
 *   CloudsEffect needs this for view ray + frustum split math.
 * @property {Function} [sessionHandleAccessor] — `() => SessionHandle |
 *   null`. Read each tick; if non-null, we call `.getSkyState()` and
 *   feed the result to CloudVolume.tick.
 * @property {Object} [cloudOptions] — passthrough to CloudsEffect
 *   options (qualityPreset, coverage, resolutionScale, …).
 * @property {boolean} [proceduralTextures=true] — instantiate +
 *   wire the four procedural textures (LocalWeather, CloudShape,
 *   CloudShapeDetail, Turbulence). Disable to load pre-baked .bin
 *   textures instead (Clouds-D-extended; future swiftshader-friendly
 *   path).
 */

export class CloudOverlay {
  /**
   * @param {CloudOverlayOptions} opts
   */
  constructor(opts) {
    const {
      camera,
      sessionHandleAccessor,
      sceneAccessor,
      cloudOptions,
      proceduralTextures = true,
    } = opts || {};
    if (!camera) throw new Error('CloudOverlay: opts.camera is required');

    this.camera = camera;
    this.sessionHandleAccessor =
      typeof sessionHandleAccessor === 'function'
        ? sessionHandleAccessor
        : () => null;
    // sceneAccessor: returns the main world scene (terrain + buildings +
    // entities). Used as the RenderPass scene so the composer's input
    // buffer gets a real depth attachment → cloud raymarch clips at
    // terrain depth instead of painting over land/player.
    this.sceneAccessor =
      typeof sceneAccessor === 'function' ? sceneAccessor : () => null;

    // The bridge. Owns the CloudsEffect + the 5 DayGroup uniforms.
    // CloudVolume's constructor sets the load-bearing ECEF transform
    // (worldToECEFMatrix translates world +Y by bottomRadius so the
    // player's world position lands at Earth's surface) — without it,
    // rays miss the cloud volume entirely.
    this.volume = new CloudVolume({ camera, cloudOptions });

    // Procedural textures need a one-time bake (or per-frame for the
    // animated weather map). CloudsEffect.update() calls each
    // procedural's .render() with `needsRender=true`; the
    // Procedural*Base implementation sets `needsRender=false` after
    // the first bake. So the bake amortises across subsequent frames.
    if (proceduralTextures) {
      const effect = this.volume.effect;
      effect.localWeatherTexture = new LocalWeather();
      effect.shapeTexture = new CloudShape();
      effect.shapeDetailTexture = new CloudShapeDetail();
      effect.turbulenceTexture = new Turbulence();

      // Add an altocumulus middle-étage layer. takram defaults only ship
      // 3 channels (R/G cumulus 750-2200m, B cirrus 7500-8000m), leaving
      // channel A unused — meteorologically, the middle étage (2-7km mid-
      // lat) is missing. Use channel A as a thin alto deck at ~3500m
      // with cirrus-class density (preserves transparency, no rings).
      const A = effect.cloudLayers[3];
      A.channel = 'a';
      A.altitude = 3500;
      A.height = 600;
      A.densityScale = 0.004;
      A.shapeAmount = 0.5;
      A.shapeDetailAmount = 0;
      A.weatherExponent = 1.0;
      A.shapeAlteringBias = 0.35;
      A.coverageFilterWidth = 0.5;
    }

    // STBN (Spatial Temporal Blue Noise) substitute. The cloud shader's
    // `getSTBN()` samples a 3D blue-noise texture to jitter ray samples
    // — without it, every ray's samples land on the same grid and we
    // get concentric-ring artifacts around the sun (forward-scattering
    // banding) and rings on the cloud layer. takram's DEFAULT_STBN_URL
    // points at an external blob not bundled with the package; we
    // synthesize a 64³ random-noise R8 Data3DTexture instead. White
    // noise has worse perceptual quality than true blue noise but
    // completely eliminates the structured ring patterns.
    const STBN_SIZE = 64;
    const stbnData = new Uint8Array(STBN_SIZE * STBN_SIZE * STBN_SIZE);
    for (let i = 0; i < stbnData.length; i++) stbnData[i] = Math.floor(Math.random() * 256);
    const stbnTex = new THREE.Data3DTexture(stbnData, STBN_SIZE, STBN_SIZE, STBN_SIZE);
    stbnTex.format = THREE.RedFormat;
    stbnTex.type = THREE.UnsignedByteType;
    stbnTex.minFilter = THREE.LinearFilter;
    stbnTex.magFilter = THREE.LinearFilter;
    stbnTex.wrapS = THREE.RepeatWrapping;
    stbnTex.wrapT = THREE.RepeatWrapping;
    stbnTex.wrapR = THREE.RepeatWrapping;
    stbnTex.colorSpace = THREE.NoColorSpace;
    stbnTex.generateMipmaps = false;
    stbnTex.unpackAlignment = 1;
    stbnTex.needsUpdate = true;
    this.volume.effect.stbnTexture = stbnTex;
    this._stbnTex = stbnTex;

    // Size the cloud effect's internal RTs to the camera's render area.
    // CloudsEffect defaults to 1x1 until `setSize` lands — without this
    // call, the cloud RT stays 1x1, the overlay quad samples one pixel,
    // and you get a uniform-colored sky overlay regardless of the rest.
    // Pull initial size from the camera's drawing surface; resize tracker
    // in scene3d/index.js's onResize keeps it current.
    const w = (typeof window !== "undefined" && window.innerWidth) || 1280;
    const h = (typeof window !== "undefined" && window.innerHeight) || 720;
    this.volume.effect.setSize(w, h);

    // Per-frame dt source. The pmndrs Effect.update() contract wants
    // a deltaTime; we don't need exact accuracy (it drives temporal
    // jitter for TAA, not physics) so an internal clock is fine.
    this.clock = new THREE.Clock();

    // === EffectComposer pipeline =====================================
    //
    // The takram CloudsEffect is designed to be driven by a pmndrs
    // EffectPass inside an EffectComposer — not by calling
    // effect.update() directly. EffectPass auto-wires:
    //   - inputBuffer.depthTexture → effect.setDepthTexture(...)
    //   - inputBuffer texture → input uniforms
    //   - proper MRT draw-buffer setup for the cloud pass
    // Without that wiring, the cloud pass's MRT draw call throws
    // GL_INVALID_OPERATION on real GPU; the cloud RT stays at the
    // renderer's clearColor and nothing visible renders.
    //
    // We create a SEPARATE composer with its own RTs so the cloud
    // bake doesn't interfere with the main scene render. The
    // RenderPass renders the MAIN world scene (terrain + buildings +
    // entities) so the composer's input buffer gets a real depth
    // attachment — that depth then occludes cloud rays in the
    // EffectPass(CloudsEffect), so clouds don't paint over land.
    //
    // Cost: scene rendered twice per frame (once for composer's depth,
    // once for the main canvas). Cheaper option (depth-only pass) is
    // Clouds-G polish; this MVP doubles render work but is correct.
    //
    // Fallback to empty scene if sceneAccessor returns null (e.g.,
    // pre-init). Empty scene → depth=1.0 → clouds paint everywhere
    // (the pre-Clouds-E.4 behavior).
    this._fallbackScene = new THREE.Scene();
    this.composer = null;
    this._composerSized = false;

    // === Fullscreen overlay scene ====================================
    //
    // OrthographicCamera + a unit plane covering [-1,1] in clip space.
    // Renders the cloud buffer as a flat 2D composite over whatever's
    // currently in the framebuffer. Transparency = cloud alpha; RGB =
    // lit cloud color (pre-multiplied per the cloud shader).
    this.overlayScene = new THREE.Scene();
    this.overlayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.overlayMaterial = new THREE.ShaderMaterial({
      uniforms: {
        cloudTex: { value: null },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D cloudTex;
        void main() {
          vec4 c = texture2D(cloudTex, vUv);
          // Discard pixels that aren't a real cloud contribution. The
          // takram raymarch's haze pass fills the RT with uniform near-
          // zero RGB at full alpha when no rays hit cloud volume —
          // which would tint the sky uniformly black/dark. A real
          // cloud pixel has both reasonable alpha AND non-trivial RGB.
          float lum = max(c.r, max(c.g, c.b));
          if (c.a < 0.05 || lum < 0.02) discard;
          gl_FragColor = c;
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      premultipliedAlpha: true,
    });

    const plane = new THREE.PlaneGeometry(2, 2);
    this.overlayMesh = new THREE.Mesh(plane, this.overlayMaterial);
    this.overlayMesh.frustumCulled = false;
    this.overlayScene.add(this.overlayMesh);

    // Cloud texture pointer wired in preRender (after first composer
    // render lands a real outputBuffer). Composer's outputBuffer is a
    // WebGLRenderTarget; we sample `.texture`.
    this.overlayMaterial.uniforms.cloudTex.value = null;

    // Telemetry — populated by tick/preRender/renderOverlay so
    // capture scripts can introspect.
    this.frameCount = 0;
    this.lastError = null;
  }

  /**
   * Pull a fresh SkyState from the session handle and apply it to the
   * cloud volume's uniforms. No-op when there's no session yet.
   * Called from SkyDome.tick (per-rAF).
   */
  tick() {
    try {
      const handle = this.sessionHandleAccessor();
      if (!handle) return;
      const state = typeof handle.getSkyState === 'function'
        ? handle.getSkyState()
        : null;
      if (state) this.volume.tick(state, null);
    } catch (err) {
      this.lastError = String(err);
    }
  }

  /**
   * Run the cloud effect's raymarch into its internal render targets.
   * MUST be called before `renderOverlay()` so the overlay samples a
   * fresh cloud buffer. Called from SkyDome.renderSkyPass, before the
   * sky scene's render call.
   *
   * Saves + restores the renderer's render-target binding so the
   * caller doesn't get surprised by side-effects.
   *
   * @param {THREE.WebGLRenderer} renderer
   */
  preRender(renderer) {
    if (!renderer) return;
    try {
      const dt = this.clock.getDelta();
      const prevTarget = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;

      // Lazy-init composer once we have the renderer (CloudOverlay
      // is built in scene3d/index.js BEFORE the renderer reference
      // is fully plumbed to preRender).
      //
      // Use the empty fallback scene as the RenderPass scene. The
      // alternative (rendering the main scene for depth) broke
      // visual blending and made clouds uniformly dark — clouds
      // self-clip below horizon naturally because cloud rays going
      // down don't hit the cloud layer above. Depth-aware occlusion
      // for foreground geometry is a Clouds-G polish item.
      if (!this.composer) {
        this.composer = new EffectComposer(renderer);
        this._renderPass = new RenderPass(this._fallbackScene, this.camera);
        this.composer.addPass(this._renderPass);
        this._cloudEffectPass = new EffectPass(this.camera, this.volume.effect);
        this.composer.addPass(this._cloudEffectPass);
      }
      if (!this._composerSized && renderer.domElement) {
        const w = renderer.domElement.width;
        const h = renderer.domElement.height;
        this.composer.setSize(w, h);
        this._composerSized = true;
      }

      // Render the cloud pipeline. RenderPass clears the empty scene
      // (depth → 1.0 far plane). EffectPass picks up that depth and
      // runs the cloud raymarch with proper MRT wiring. Output lands
      // in composer.outputBuffer.
      this.composer.render(dt);

      // Patch cameraHeight uniform AFTER the composer ran (which calls
      // CloudsMaterial.copyCameraSettings, which sets cameraHeight via
      // WGS-84 geodetic → wrong for our spherical setup). Override
      // with the actual world Y (clamped ≥ 0). Takes effect on the
      // NEXT frame's bake.
      const camWorldY = this.camera?.position?.y ?? 0;
      const matUniforms = this.volume.effect.cloudsPass.currentMaterial?.uniforms;
      if (matUniforms?.cameraHeight) {
        matUniforms.cameraHeight.value = Math.max(0, camWorldY);
      }

      // Restore renderer state (composer leaves it on its last RT).
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;

      // Wire the cloud effect's `cloudsBuffer` uniform value to our
      // overlay — that's the texture takram populates with the actual
      // cloud raymarch output. (`composer.outputBuffer` is the
      // EffectPass's fullscreen composition output which can drop
      // alpha/RGB through its blend chain; sampling cloudsBuffer
      // directly preserves the volumetric raymarch values.)
      const tex = this.volume.effect.uniforms?.get?.('cloudsBuffer')?.value ?? null;
      if (tex !== this.overlayMaterial.uniforms.cloudTex.value) {
        this.overlayMaterial.uniforms.cloudTex.value = tex;
      }
      this.frameCount++;
    } catch (err) {
      this.lastError = String(err);
    }
  }

  /**
   * Draw the fullscreen overlay over the current framebuffer (which
   * holds the just-painted sky scene). Uses transparent blending so
   * cloud-free pixels keep the underlying sky color.
   *
   * Must run AFTER the sky pass `renderer.render(skyScene, skyCamera)`
   * and BEFORE the world clearDepth + render. Called from
   * SkyDome.renderSkyPass right after the sky-scene draw call.
   *
   * @param {THREE.WebGLRenderer} renderer
   */
  renderOverlay(renderer) {
    if (!renderer) return;
    if (!this.overlayMaterial.uniforms.cloudTex.value) return;
    try {
      const prevAutoClear = renderer.autoClear;
      const prevTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(null);
      renderer.autoClear = false;
      renderer.render(this.overlayScene, this.overlayCamera);
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    } catch (err) {
      this.lastError = String(err);
    }
  }

  /**
   * Resize the cloud effect's internal buffers when the canvas
   * changes. Mirrors the existing camera/renderer.setSize calls in
   * scene3d/index.js's resize handler.
   *
   * @param {number} width
   * @param {number} height
   */
  setSize(width, height) {
    try {
      this.volume.effect.setSize(width, height);
      if (this.composer) {
        this.composer.setSize(width, height);
      }
      this._composerSized = true;
    } catch (err) {
      this.lastError = String(err);
    }
  }

  /**
   * Tear down all GPU resources. Called when the 3D renderer is
   * disposed.
   */
  dispose() {
    try {
      this.overlayMesh.geometry.dispose();
      this.overlayMaterial.dispose();
      this._stbnTex?.dispose?.();
      this.composer?.dispose?.();
      this.volume.dispose();
    } catch (err) {
      this.lastError = String(err);
    }
  }
}
