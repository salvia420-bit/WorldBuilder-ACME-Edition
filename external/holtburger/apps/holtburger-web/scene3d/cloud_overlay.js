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
import { updateFromPosition as wxUpdateFromPosition } from './weather_state.js';
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

      // Bump default coverage from takram's 0.3 → 0.5 so there's more
      // cloud overhead in the default ?clouds=on view. Live tune via
      // `__setCloudCoverage(v)` in devtools (already exposed).
      if (effect.clouds && 'coverage' in effect.clouds) {
        effect.clouds.coverage = 0.5;
      }
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
        // 2026-05-16 cloud z-order fix — when present, the fragment
        // shader samples this DepthTexture (the composer's world
        // depth) and discards cloud fragments where world geometry
        // beats the sky-distance threshold. Set via
        // `setSceneDepthTexture(...)`; null leaves the shader on the
        // legacy "no-depth-test" path (used in the direct-render path
        // pre-atmosphere-K.2).
        sceneDepthTex: { value: null },
        // Threshold sentinel. 0.0 = "no depth provided, render
        // unconditionally" (matches `setSceneDepthTexture(null)`).
        // setSceneDepthTexture(validTexture) upgrades this to 0.9999
        // for depth-aware discard. Starting at 0.0 is load-bearing:
        // a default of 0.9999 with sceneDepthTex=null causes the
        // shader to sample an unbound texture (returns 0 in WebGL2),
        // compare 0 < 0.9999, and discard every fragment — clouds
        // vanish entirely until setSceneDepthTexture() lands. The
        // 2026-05-18 cloud loop-fix: visible-over-everything is the
        // SAFE failure mode for the depth wire, not invisible.
        sceneDepthThreshold: { value: 0.0 },
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
        uniform sampler2D sceneDepthTex;
        uniform float sceneDepthThreshold;
        void main() {
          // 2026-05-16 -- depth-aware discard. Sample the composer's
          // world depth at this fragment's screen pos. Depth ~1.0 means
          // far plane (sky); depth less than threshold means world
          // geometry was drawn here, so the cloud must NOT paint over it.
          // When sceneDepthTex is null (legacy direct-render path), the
          // shader skips the discard via the sentinel-value branch:
          // a texture sample of an unbound sampler returns 0.0 in WebGL2
          // which would always trip the threshold check, so we
          // explicitly fall back to "always pass" when the threshold
          // is 0 (set by the JS side when no depth texture is wired).
          if (sceneDepthThreshold > 0.0) {
            float d = texture2D(sceneDepthTex, vUv).r;
            if (d < sceneDepthThreshold) discard;
          }
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

    // Track which camera the cloud raymarch was last set up for, so
    // preRender can swap the RenderPass + EffectPass + CloudsEffect
    // camera references on activeCamera switches (C-key cycle:
    // follow/orbit use persp, topDown uses ortho).
    this._lastActiveCam = null;

    // Telemetry — populated by tick/preRender/renderOverlay so
    // capture scripts can introspect.
    this.frameCount = 0;
    this.lastError = null;
  }

  /**
   * 2026-05-16 -- wire a scene-depth texture (from the atmosphere
   * composer's internal RT) so the overlay shader can discard cloud
   * fragments behind world geometry. Call once after both the cloud
   * overlay and the atmosphere pipeline are constructed. Passing null
   * (or never calling this) leaves the shader on the legacy depth-
   * unaware path -- cloud paints unconditionally over the framebuffer.
   *
   * The depth texture identity may change at runtime (the atmosphere
   * pipeline rebuilds it on resize). Callers should re-call this on
   * resize OR pass an accessor and have the overlay pull-through each
   * frame -- we wire the simple set-once path here; the live-handle
   * pull-through is a follow-on if a resize bug surfaces.
   */
  setSceneDepthTexture(depthTexture) {
    if (!this.overlayMaterial) return;
    this.overlayMaterial.uniforms.sceneDepthTex.value = depthTexture ?? null;
    // 2026-05-18 — keep threshold at the no-discard sentinel even
    // when a depth texture is wired. The depth-aware discard
    // (`if (d < 0.9999) discard`) wipes clouds entirely on the
    // AMD R9 290 — diag logs showed cloudTex populated and
    // sceneDepthTex wired, every fragment discarded. Suspected
    // cause: `texture2D(sceneDepthTex, vUv).r` returning unexpected
    // values for THREE.DepthFormat+UnsignedIntType under that
    // driver (WebGL warning in log: "Depth texture comparison
    // requests LINEAR Filtering, behavior implementation-defined").
    // Accept "clouds paint over geometry" (historical state) as
    // the visible default. Opt back into depth-correct discard via
    // `liveScene3d.cloudOverlay.setDepthDiscardEnabled(true)`.
    this.overlayMaterial.uniforms.sceneDepthThreshold.value =
      this._depthDiscardOptedIn && depthTexture ? 0.9999 : 0.0;
  }

  /**
   * Opt-in toggle for the depth-aware cloud discard. Default off
   * (clouds visible over geometry). Toggle on when the AMD-driver
   * depth-sampling quirk is resolved.
   *
   * @param {boolean} enabled
   */
  setDepthDiscardEnabled(enabled) {
    this._depthDiscardOptedIn = !!enabled;
    if (this.overlayMaterial?.uniforms?.sceneDepthThreshold) {
      const hasTex = !!this.overlayMaterial.uniforms.sceneDepthTex.value;
      this.overlayMaterial.uniforms.sceneDepthThreshold.value =
        this._depthDiscardOptedIn && hasTex ? 0.9999 : 0.0;
    }
  }

  /**
   * 2026-05-18 — attach the overlay quad to a foreign scene (the sky
   * scene) so it's rendered as part of that scene's render pass. This
   * gives us depth-correct cloud-vs-world compositing for FREE,
   * without depending on `texture2D(sceneDepthTex, ...).r` working
   * correctly per-vendor.
   *
   * How it works:
   *   1. Sky pass renders sky dome + this overlay quad → color buffer
   *      ends up with sky color, then cloud color blended on top.
   *   2. World render pass runs with `clear=false, clearDepth=true`:
   *      sky+cloud color preserved, depth wiped. World geometry
   *      writes color (overpainting cloud at world pixels) and depth.
   *   3. Net: sky pixels keep the cloud color; world pixels show
   *      world. No depth-texture sampling needed.
   *
   * The renderOverlay() call becomes a no-op once attached so we don't
   * double-render. Caller's responsibility to dispose / detach if the
   * sky scene goes away.
   *
   * @param {THREE.Scene} skyScene
   * @param {number} [renderOrder=999] Higher = renders later in scene.
   *   We want clouds AFTER sky dome but otherwise don't care.
   */
  attachToSkyScene(skyScene, renderOrder = 999) {
    if (!skyScene || !this.overlayMesh) return;
    if (this.overlayMesh.parent === skyScene) return;
    if (this.overlayMesh.parent) {
      this.overlayMesh.parent.remove(this.overlayMesh);
    }
    this.overlayMesh.renderOrder = renderOrder;
    skyScene.add(this.overlayMesh);
    this._attachedToSkyScene = skyScene;
  }

  /**
   * Detach the overlay quad from the foreign scene. Used during
   * disposal or if we need to revert to the separate-renderOverlay
   * path.
   */
  detachFromSkyScene() {
    if (!this._attachedToSkyScene || !this.overlayMesh) return;
    this._attachedToSkyScene.remove(this.overlayMesh);
    this._attachedToSkyScene = null;
    // Re-attach to our own overlayScene so renderOverlay still works.
    if (this.overlayScene) this.overlayScene.add(this.overlayMesh);
  }

  /**
   * Pull a fresh SkyState from the session handle and apply it to the
   * cloud volume's uniforms. No-op when there's no session yet.
   * Called from SkyDome.tick (per-rAF).
   *
   * Also updates the shared weather_state with the camera's current
   * world XZ so latitude-dependent étage ranges stay current. The
   * camera ref is the persp (stale in topDown), but the XZ component
   * is approximately the player's XZ either way; weather doesn't need
   * 60 Hz position precision.
   */
  tick() {
    try {
      const handle = this.sessionHandleAccessor();
      if (!handle) return;
      if (this.camera?.position) {
        wxUpdateFromPosition(this.camera.position.x, this.camera.position.z);
      }
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
   * fresh cloud buffer. Called from SkyDome.renderSkyPass (direct
   * path) and from scene3d/index.js's tick (atmosphere path).
   *
   * Saves + restores the renderer's render-target binding so the
   * caller doesn't get surprised by side-effects.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {number} [dt=0] Wall-clock seconds since last frame,
   *   threaded from `scene3d.frameTime.dt` (capped at 100ms). Drives
   *   the cloud effect's TAA temporal jitter. Default 0 for callers
   *   that lack a dt (TAA simply doesn't advance that frame, which is
   *   harmless).
   * @param {THREE.Camera|null} [activeCam=null] The camera the world
   *   is being rendered with this frame. In follow/orbit modes this
   *   is the same persp passed at construction; in topDown it's the
   *   ortho camera. The cloud raymarch's view-rays + cameraHeight
   *   must match the world render's POV or the cloud texture is
   *   composited at the wrong screen positions. Passing null falls
   *   back to the constructor-time camera.
   */
  preRender(renderer, dt = 0, activeCam = null) {
    if (!renderer) return;
    try {
      const cam = activeCam ?? this.camera;
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
        this._renderPass = new RenderPass(this._fallbackScene, cam);
        this.composer.addPass(this._renderPass);
        this._cloudEffectPass = new EffectPass(cam, this.volume.effect);
        this.composer.addPass(this._cloudEffectPass);
        this._lastActiveCam = cam;
      }
      if (!this._composerSized && renderer.domElement) {
        const w = renderer.domElement.width;
        const h = renderer.domElement.height;
        this.composer.setSize(w, h);
        this._composerSized = true;
      }

      // C-key cycle support: when activeCam differs from the camera
      // the composer was set up for, swap the RenderPass, EffectPass,
      // and CloudsEffect camera references. takram's CloudsEffect
      // exposes a `mainCamera` setter that propagates to shadowPass +
      // cloudsPass; pmndrs' EffectPass likewise. RenderPass.camera is
      // a plain assignable property.
      if (cam !== this._lastActiveCam) {
        if (this._renderPass) this._renderPass.camera = cam;
        if (this._cloudEffectPass) this._cloudEffectPass.mainCamera = cam;
        if (this.volume?.effect) this.volume.effect.mainCamera = cam;
        this._lastActiveCam = cam;
      }

      // Render the cloud pipeline. RenderPass clears the empty scene
      // (depth → 1.0 far plane). EffectPass picks up that depth and
      // runs the cloud raymarch with proper MRT wiring. Output lands
      // in composer.outputBuffer.
      this.composer.render(dt);

      // Patch cameraHeight uniform AFTER the composer ran (which calls
      // CloudsMaterial.copyCameraSettings, which sets cameraHeight via
      // WGS-84 geodetic → wrong for our spherical setup). Override
      // with the actual world Y (clamped ≥ 0) of the ACTIVE camera so
      // topDown's elevated ortho POV is reflected in the raymarch
      // origin. Takes effect on the NEXT frame's bake.
      const camWorldY = cam?.position?.y ?? 0;
      const matUniforms = this.volume.effect.cloudsPass.currentMaterial?.uniforms;
      if (matUniforms?.cameraHeight) {
        matUniforms.cameraHeight.value = Math.max(0, camWorldY);
      }

      // Cloud-shadow push to terrain materials. Moved here from
      // CloudVolume.tick so it runs AFTER composer.render has filled
      // the cascade shadow buffer + matrices for THIS frame — the
      // terrain pass reads them right after this preRender returns.
      // Pushing in tick() copied last-frame's matrices into the
      // terrain uniform, producing a one-frame lag visible as shadow
      // drift on fast time-of-day changes.
      try {
        this.volume._pushCloudShadowsToTerrain();
      } catch (_) {
        // Cloud-shadow push must not block the cloud render.
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
    // 2026-05-18 — if the overlay quad is attached to the sky scene
    // (cf. attachToSkyScene), the sky pass renders it; calling
    // renderOverlay here would double-paint. No-op cleanly.
    if (this._attachedToSkyScene) return;
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
