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
// `?cloudsMainPass=on` (2026-10-05, opt-in): atmosphere_pipeline.js puts
// the CloudsEffect into its one post-chain EffectPass ahead of
// AerialPerspective and calls adoptMainPass(); the private composer and the
// sky-scene quad are then retired, the raymarch reads the main composer's
// scene depth, and AerialPerspective composites the clouds before
// ToneMapping. Until a pipeline adopts it (pre-bake window, ?atmosphere=off)
// the legacy path below runs unchanged.
//
// Visible-clouds eye-test requires a real GPU. Headless swiftshader
// silently zero-bakes 3D textures (see Clouds-D-mini memory for
// the diagnosis). CI / smoke runs can only validate plumbing.

import * as THREE from 'three';
import { CloudVolume } from './cloud_volume.js';
import { applyCloudLook, cloudLayersMatchLook } from './cloud_storm_look.js';
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
 * @property {boolean} [proceduralTextures=false] — when true, generate the
 *   four noise textures (LocalWeather, CloudShape, CloudShapeDetail,
 *   Turbulence) on the GPU at boot. When false (DEFAULT), load takram's
 *   pre-baked `.bin`/`.png` assets instead — this skips the four GPU noise-
 *   bake shader programs that otherwise compile + run on the first cold
 *   frame (tens of seconds of D3D11 shader link; see
 *   docs/HANDOFF-perf-followups-3-levers Lever A). Identical output; lower
 *   cold-load cost. `?cloudProcedural=on` opts back into the procedural path,
 *   and a prebake load failure auto-falls-back to it.
 * @property {string} [assetsBaseUrl] — override the prebaked-asset base URL
 *   (default: `../assets/clouds/` relative to this module). For testing.
 * @property {string} [search] — query string the `?cloudsBootOrder` /
 *   `?cloudsMainPass` reads use instead of the page URL. For testing.
 */

// `?cloudsBootOrder` (2026-10-17, DEBUG KNOB, default OFF) — pin the clouds'
// boot order for an A/B.
//
// With `?cloudsMainPass` (default on) the CloudsEffect ends up in the main
// composer, but until the atmosphere pipeline exists (it waits for the LUTs)
// the legacy path marches it through this overlay's private composer whenever
// the sky pass runs, so a session's first raymarch is either legacy-first or
// main-first, by timing. The 1070 A/B of 2026-10-17 first read the bright/dark
// sky split as that race; the live follow-up found the switch is the STORM
// LOOK (cloud_volume.js tick / CloudOverlay.adoptMainPass), so nothing is
// forced by default any more. The knob stays for pinning an order:
//   absent / anything else / `off|0|false|no`  nothing pinned (today's boot);
//   `legacy`  a session that would boot main-first gets ONE legacy march first
//             (primeLegacyMarch, called by the pipeline before it builds its
//             composer);
//   `prime`   legacy marches suppressed until adoption, the prime always runs;
//   `main`    legacy marches suppressed, no prime: always main-first.
// Inert without the main pass (`?cloudsMainPass=off`). Diag:
// `window.__cloudStateDiag()` (`bootOrder`, `timeline.primed/firstMarch/adopted`).
export function cloudsBootOrder(search) {
  let v = null;
  try {
    const s = search ?? (typeof window !== 'undefined' && window.location ? window.location.search : '');
    v = new URLSearchParams(s ?? '').get('cloudsBootOrder');
  } catch (_) {
    v = null;
  }
  const t = v == null ? '' : String(v).trim().toLowerCase();
  if (t === 'legacy' || t === 'main' || t === 'prime') return t;
  return 'off';
}

/** Mirrors atmosphere_pipeline.js::cloudsMainPassEnabled (`!== "off"`). */
function _mainPassExpected(search) {
  try {
    const s = search ?? (typeof window !== 'undefined' && window.location ? window.location.search : '');
    return new URLSearchParams(s ?? '').get('cloudsMainPass') !== 'off';
  } catch (_) {
    return true;
  }
}

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
      proceduralTextures = false,
    } = opts || {};
    if (!camera) throw new Error('CloudOverlay: opts.camera is required');

    this.camera = camera;
    this.sessionHandleAccessor =
      typeof sessionHandleAccessor === 'function'
        ? sessionHandleAccessor
        : () => null;
    // sceneAccessor: returns the main world scene (terrain + buildings +
    // entities). Stored but currently UNUSED: the cloud composer's
    // RenderPass draws the empty `_fallbackScene` (see preRender), and
    // land/player occlusion comes from draw order (overlay in the sky
    // pass, world pass after it), not from this scene's depth.
    this.sceneAccessor =
      typeof sceneAccessor === 'function' ? sceneAccessor : () => null;

    // The bridge. Owns the CloudsEffect + the 5 DayGroup uniforms.
    // CloudVolume's constructor sets the load-bearing ECEF transform
    // (worldToECEFMatrix translates world +Y by bottomRadius so the
    // player's world position lands at Earth's surface) — without it,
    // rays miss the cloud volume entirely.
    this.volume = new CloudVolume({ camera, cloudOptions });

    // Noise textures (localWeather/shape/shapeDetail/turbulence) come from
    // ONE of two sources that produce identical sampling:
    //   - prebaked (DEFAULT): fetch takram's canonical .bin/.png assets and
    //     assign plain Texture/Data3DTexture. This SKIPS the four GPU noise-
    //     bake shader programs that otherwise compile + run on the first cold
    //     frame (tens of seconds of D3D11 shader link — see
    //     docs/HANDOFF-perf-followups-3-levers Lever A). The assets are
    //     takram's noise for this vendored `ref`, so byte-equivalent output.
    //   - procedural (`?cloudProcedural=on`, or on a prebake-load failure):
    //     the original path — generate the four noise textures on the GPU.
    // All four are one-shot — Procedural*Base sets `needsRender=false` after
    // the first bake and nothing resets it — so the static prebaked textures
    // are behaviour-identical, NOT a quality change.
    this._proceduralTextures = proceduralTextures;
    this._prebakedLoaded = false;
    // `window.__cloudStateDiag()` boot timeline (performance.now() ms; null =
    // never happened). Read-only bookkeeping, see cloudStateSnapshot.
    this._diagStamps = {
      created: _diagNow(), prebaked: null, prebakeFailed: null, procedural: null,
      adopted: null, firstMarch: null, primed: null,
    };
    // `?cloudsBootOrder` (see cloudsBootOrder above). URL-immutable, read once.
    this._bootOrder = cloudsBootOrder(opts && opts.search);
    this._suppressLegacy = _mainPassExpected(opts && opts.search) &&
      (this._bootOrder === 'main' || this._bootOrder === 'prime');
    this._priming = false;
    if (proceduralTextures) {
      this._installProceduralNoise();
    } else {
      this._loadPrebakedNoise(opts && opts.assetsBaseUrl).catch((err) => {
        this.lastError = 'prebake load failed: ' + String(err);
        this._diagStamps.prebakeFailed = _diagNow();
        // eslint-disable-next-line no-console
        console.warn('[clouds] prebaked noise load failed → procedural fallback:', err);
        try { this._installProceduralNoise(); } catch (_) {}
      });
    }

    // Fair-weather baseline layers + coverage — independent of the noise
    // SOURCE, so they apply to BOTH paths. Single source of truth is
    // cloud_storm_look.js (2026-08-01): the alto-deck/0.5-coverage config
    // that used to live inline here is its FAIR look, and cloud_volume
    // switches to the STORM look on the real DayGroup storm signal. This
    // construct-time call is what `?cloudWeather=off` freezes.
    applyCloudLook(this.volume.effect, false);

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
    // bake doesn't interfere with the main scene render. Its RenderPass
    // renders the EMPTY `_fallbackScene` (see preRender — rendering the
    // main scene there made clouds uniformly dark), so the main world
    // scene is NOT rendered a second time: the composer's depth is a
    // plain far-plane clear, and the raymarch itself is not occluded.
    //
    // Clouds still never paint over land: the overlay quad is attached
    // to the SKY scene (attachToSkyScene, renderOrder 999), so it is
    // composited during the sky pass, BEFORE the world pass, which then
    // overdraws it wherever geometry is. The optional depth-texture
    // discard (setSceneDepthTexture / setDepthDiscardEnabled) is a
    // second, opt-in layer on top of that draw order.
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
            #ifdef USE_REVERSED_DEPTH_BUFFER
            // ?reversedZ=on: cleared (sky) is 0, any geometry is > 0.
            if (d > 0.0) discard;
            #else
            if (d < sceneDepthThreshold) discard;
            #endif
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
    // The vertex shader above writes clip space directly, so this mesh has no
    // world position: any renderer that is not the main camera pass (the IBL
    // PMREM / CubeCamera bake, a probe) must hide it or it fills the frame.
    // `ibl_environment.refresh` keys off this tag.
    this.overlayMesh.userData = {
      ...(this.overlayMesh.userData || {}),
      __clipSpaceOverlay: true,
    };
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
    this._cloudsBufferUniform = null;

    // `?cloudsMainPass=on` state (see adoptMainPass). False = legacy path.
    this._mainPass = false;
    this._mainPassArmed = false;
  }

  /**
   * `?cloudsMainPass=on` (2026-10-05, opt-in) — hand the CloudsEffect to the
   * MAIN atmosphere composer instead of running it in this overlay's private
   * EffectComposer + sky-scene quad. Called by atmosphere_pipeline.js AFTER it
   * has put `this.volume.effect` into its one post-chain EffectPass, ahead of
   * AerialPerspective.
   *
   * This is takram's documented integration (vendor/takram-three-clouds
   * README: "Place Clouds inside EffectComposer before AerialPerspective";
   * r3f/Clouds.tsx hands `effect.atmosphereOverlay` / `atmosphereShadowLength`
   * to AerialPerspective). Consequences vs the legacy path:
   *   - no private composer: its RenderPass clear + full-res EffectPass
   *     composite (whose output nobody read) + its two ping-pong RTs are gone;
   *   - the raymarch reads the main composer's REAL scene depth (log-depth
   *     aware: CloudsMaterial sets USE_LOGARITHMIC_DEPTH_BUFFER from the
   *     camera), so clouds stop behind terrain/buildings instead of relying on
   *     draw order;
   *   - AerialPerspective composites the clouds (skipRendering stays true, the
   *     takram default), so clouds get aerial perspective and then go through
   *     Bloom/Vignette/ToneMapping/Dithering with everything else.
   *
   * Indoor / sky-blocked frames: index.js only calls preRender() while the sky
   * is visible, so preRender ARMS one raymarch; an unarmed frame skips the
   * raymarch entirely and points AerialPerspective's overlay + shadow-length
   * maps at a 1x1 transparent texture (composite = identity). The proxy
   * objects keep a constant identity so the HAS_OVERLAY / HAS_SHADOW_LENGTH
   * defines never flip — no compound-shader recompile on door crossings.
   *
   * @param {{ aerialPerspective: object }} target the pipeline's AP effect
   * @returns {boolean} true if adopted
   */
  adoptMainPass({ aerialPerspective } = {}) {
    const effect = this.volume?.effect;
    if (this._mainPass || !effect || !aerialPerspective) return false;

    // 1. Private composer down (single-owner rule: detach the EffectPass so
    //    composer.dispose() never disposes the CloudsEffect — see dispose()).
    if (this.composer) {
      try {
        if (this._cloudEffectPass) this.composer.removePass(this._cloudEffectPass);
        this.composer.dispose?.();
      } catch (_) { /* tear-down */ }
    }
    this.composer = null;
    this._renderPass = null;
    this._cloudEffectPass = null;
    this._composerSized = false;

    // 2. The sky-scene quad would now double-composite: take it out.
    this._skySceneBeforeMainPass = this._attachedToSkyScene ?? null;
    this.detachFromSkyScene();

    // 3. Stable proxies for AerialPerspective.
    const blank = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
    blank.needsUpdate = true;
    this._mainPassBlank = blank;
    const overlay = { map: blank };
    const shadowLength = { map: blank };
    this._apOverlay = overlay;
    this._apShadowLength = shadowLength;
    this._mainPassAP = aerialPerspective;
    aerialPerspective.overlay = overlay;
    aerialPerspective.shadowLength = shadowLength;
    effect.skipRendering = true; // AerialPerspective composites (takram default)

    // 4. Gate the raymarch on preRender's arm.
    const ownUpdate = Object.prototype.hasOwnProperty.call(effect, 'update')
      ? effect.update
      : undefined;
    const origUpdate = effect.update;
    this._mainPassOwnUpdate = ownUpdate;
    effect.update = (renderer, inputBuffer, deltaTime) => {
      const armed = this._mainPassArmed;
      this._mainPassArmed = false;
      if (!armed) {
        overlay.map = blank;
        shadowLength.map = blank;
        return;
      }
      origUpdate.call(effect, renderer, inputBuffer, deltaTime);
      if (this._diagStamps && this._diagStamps.firstMarch === null) this._diagStamps.firstMarch = _diagNow();
      overlay.map = effect.cloudsPass?.outputBuffer ?? blank;
      shadowLength.map = effect.cloudsPass?.shadowLengthBuffer ?? blank;
    };

    this._mainPass = true;
    if (this._diagStamps) this._diagStamps.adopted = _diagNow();
    // The storm/fair look is edge-applied by the volume tick; re-assert it
    // after the hand-over (cloud_volume.js tick, 2026-10-17 storm-look loss).
    this.volume.invalidateCloudLook?.('adopted');
    return true;
  }

  /**
   * Undo adoptMainPass (the main pipeline is being disposed). The legacy
   * private composer is lazily rebuilt by the next preRender().
   */
  releaseMainPass() {
    if (!this._mainPass) return;
    const effect = this.volume?.effect;
    if (effect) {
      if (this._mainPassOwnUpdate !== undefined) effect.update = this._mainPassOwnUpdate;
      else delete effect.update;
    }
    if (this._mainPassAP) {
      if (this._mainPassAP.overlay === this._apOverlay) this._mainPassAP.overlay = null;
      if (this._mainPassAP.shadowLength === this._apShadowLength) this._mainPassAP.shadowLength = null;
    }
    this._mainPassBlank?.dispose?.();
    this._mainPassBlank = null;
    this._apOverlay = null;
    this._apShadowLength = null;
    this._mainPassAP = null;
    this._mainPass = false;
    this._mainPassArmed = false;
    this.volume?.invalidateCloudLook?.('released');
    if (this._skySceneBeforeMainPass) this.attachToSkyScene(this._skySceneBeforeMainPass);
    this._skySceneBeforeMainPass = null;
  }

  /** True while the CloudsEffect runs inside the main composer. */
  get mainPassActive() {
    return this._mainPass;
  }

  /**
   * `?cloudsBootOrder` (default "legacy", see cloudsBootOrder): give a session
   * that would boot main-first the legacy first raymarch it is missing. The
   * atmosphere pipeline calls this before it builds its composer — the moment a
   * legacy-first session's own first march happened before. Exactly the legacy
   * preRender (private composer, one march), nothing else; adoption then retires
   * that composer as usual. Returns true when it marched.
   */
  primeLegacyMarch(renderer, camera) {
    if (this._bootOrder !== 'legacy' && this._bootOrder !== 'prime') return false;
    if (this._mainPass || !renderer || !this.volume || !this.volume.effect) return false;
    if (this._diagStamps.firstMarch !== null) return false; // already legacy-first
    this._priming = true;
    try {
      this.preRender(renderer, 0, camera ?? this.camera);
    } finally {
      this._priming = false;
    }
    const ok = this._diagStamps.firstMarch !== null;
    this._diagStamps.primed = ok ? _diagNow() : null;
    return ok;
  }

  /** `window.__cloudStateDiag()` — see cloudStateSnapshot (read-only). */
  diagSnapshot(renderer, opts) {
    return cloudStateSnapshot(this, renderer, opts);
  }

  /**
   * Original path: generate the four noise textures on the GPU at boot.
   * Assigning a Procedural*Texture (not a plain Texture) routes through the
   * CloudsEffect setters' procedural branch, so CloudsEffect.update() bakes
   * them on the first frame (the 4 noise-bake shader programs). Also used as
   * the fallback when prebaked-asset loading fails.
   */
  _installProceduralNoise() {
    const effect = this.volume.effect;
    effect.localWeatherTexture = new LocalWeather();
    effect.shapeTexture = new CloudShape();
    effect.shapeDetailTexture = new CloudShapeDetail();
    effect.turbulenceTexture = new Turbulence();
    this._proceduralTextures = true;
    if (this._diagStamps) this._diagStamps.procedural = _diagNow();
  }

  /**
   * Default path: load takram's pre-baked noise assets and assign them as
   * plain Texture/Data3DTexture. Assigning a plain texture routes through the
   * setters' NON-procedural branch (`value instanceof Data3DTexture`), so the
   * four GPU noise-bake programs are never compiled or run — that's the cold-
   * load win. Async (fetch + image decode); clouds render empty for the brief
   * window until the textures land, same as the procedural path's first bake.
   *
   * @param {string} [assetsBaseUrl] override base URL (default: the committed
   *   `../assets/clouds/` relative to this module, resolved via import.meta).
   */
  async _loadPrebakedNoise(assetsBaseUrl) {
    const base = assetsBaseUrl
      ? new URL(assetsBaseUrl, window.location.href)
      : new URL('../assets/clouds/', import.meta.url);
    const url = (name) => new URL(name, base).href;

    // 3D R8 noise volumes — raw bytes (size^3), RedFormat, linear, repeat.
    // Matches Procedural3DTextureBase's texture config exactly.
    const load3D = async (name, size) => {
      const res = await fetch(url(name));
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      const data = new Uint8Array(await res.arrayBuffer());
      if (data.length !== size * size * size) {
        throw new Error(`${name}: ${data.length} bytes, expected ${size * size * size}`);
      }
      const tex = new THREE.Data3DTexture(data, size, size, size);
      tex.format = THREE.RedFormat;
      tex.type = THREE.UnsignedByteType;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.wrapR = THREE.RepeatWrapping;
      tex.colorSpace = THREE.NoColorSpace;
      tex.generateMipmaps = false;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      return tex;
    };
    // 2D RGBA noise maps — mipmapped, linear, repeat. Matches
    // ProceduralTextureBase's texture config.
    const load2D = async (name) => {
      const tex = await new THREE.TextureLoader().loadAsync(url(name));
      tex.minFilter = THREE.LinearMipMapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.NoColorSpace;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      return tex;
    };

    // Non-cubic 3D R8 volume loader — for the STBN blue-noise (128×128×64,
    // NOT cubic). NearestFilter per takram's own STBNLoader: blue noise must
    // NOT be interpolated or it loses the spectral properties that make it
    // blue. (The synchronous placeholder synthesises WHITE noise with
    // LinearFilter — both wrong; this replaces it with the real asset.)
    const load3DWHD = async (name, w, h, d) => {
      const res = await fetch(url(name));
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      const data = new Uint8Array(await res.arrayBuffer());
      if (data.length !== w * h * d) {
        throw new Error(`${name}: ${data.length} bytes, expected ${w * h * d}`);
      }
      const tex = new THREE.Data3DTexture(data, w, h, d);
      tex.format = THREE.RedFormat;
      tex.type = THREE.UnsignedByteType;
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.wrapR = THREE.RepeatWrapping;
      tex.colorSpace = THREE.NoColorSpace;
      tex.generateMipmaps = false;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      return tex;
    };

    // `?wxMap=nasa` (2026-08-01) — swap the local-weather map for the NASA
    // Blue Marble-derived one (assets/clouds/local_weather_nasa.png: real
    // frontal systems; A channel = actual storm cores for the Cb layer;
    // built by scratchpad make_weather.py from public-domain cloud_combined
    // imagery, the same source Skybolt uses). STRICT opt-in; any failure
    // falls back to takram's default map so the flag can never cost the
    // prebaked cold-load path. The noise .bins and atmosphere EXRs are
    // untouched either way.
    // `nasa` = organic Blue Marble crop (not world-anchored; gets linear
    // drift). `dereth` = biome-anchored map built from the retail terrain
    // codes (desert clear, marsh/volcano stormy, snow overcast, sea
    // maritime — scratchpad make_weather_dereth.py over a full
    // get-terrain-layers dump); world-anchored, so it gets the wobble
    // drift instead (see cloud_volume.js).
    let wxMapName = 'local_weather.png';
    try {
      const wx = new URLSearchParams(window.location.search).get('wxMap');
      if (wx === 'nasa') wxMapName = 'local_weather_nasa.png';
      else if (wx === 'dereth') wxMapName = 'local_weather_dereth.png';
    } catch (_) {}
    const [localWeather, turbulence, shape, shapeDetail, stbn] = await Promise.all([
      load2D(wxMapName).catch((e) => {
        if (wxMapName === 'local_weather.png') throw e;
        // eslint-disable-next-line no-console
        console.warn('[clouds] wxMap=nasa load failed → default weather map:', e);
        return load2D('local_weather.png');
      }),
      load2D('turbulence.png'),
      load3D('shape.bin', 128),
      load3D('shape_detail.bin', 32),
      // takram's canonical spatio-temporal blue-noise (128×128×64). Its own
      // failure keeps the white-noise placeholder rather than dropping the
      // whole prebaked set back to procedural.
      load3DWHD('stbn.bin', 128, 128, 64).catch((e) => {
        // eslint-disable-next-line no-console
        console.warn('[clouds] STBN blue-noise load failed → keeping white-noise fallback:', e);
        return null;
      }),
    ]);

    // The overlay may have been disposed during the async load.
    if (!this.volume || !this.volume.effect) {
      [localWeather, turbulence, shape, shapeDetail, stbn].forEach((t) => t && t.dispose && t.dispose());
      return;
    }
    const effect = this.volume.effect;
    effect.localWeatherTexture = localWeather;
    effect.turbulenceTexture = turbulence;
    effect.shapeTexture = shape;
    effect.shapeDetailTexture = shapeDetail;
    // Swap the synchronous white-noise STBN placeholder for real blue noise.
    // The white noise made the shader's deterministic `frame % 64` STBN-slice
    // cycle VISIBLE — a ~3s "video loop" at low fps (64 frames / ~20fps) —
    // because its low-frequency energy never converged under the temporal
    // resolve (temporalAlpha 0.1). True blue noise converges, so the cycle
    // averages out, and the sun forward-scatter rings the white noise was
    // masking stay suppressed too.
    if (stbn) {
      const oldStbn = effect.stbnTexture;
      effect.stbnTexture = stbn;
      if (oldStbn && oldStbn !== stbn && oldStbn.dispose) oldStbn.dispose();
      this._stbnTex = stbn;
    }
    this._prebakedLoaded = true;
    if (this._diagStamps) this._diagStamps.prebaked = _diagNow();
  }

  /**
   * 2026-05-16 -- wire a scene-depth texture (from the atmosphere
   * composer's internal RT) so the overlay shader can discard cloud
   * fragments behind world geometry. Call once after both the cloud
   * overlay and the atmosphere pipeline are constructed. Passing null
   * (or never calling this) leaves the shader without the discard --
   * the quad then paints unconditionally over what the SKY pass drew,
   * and the world pass that follows still overdraws it at geometry.
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
    if (this._mainPass) {
      // Main-pass mode composites via AerialPerspective; remember the scene
      // so releaseMainPass() can restore the legacy quad.
      this._skySceneBeforeMainPass = skyScene;
      return;
    }
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
  tick(stateOverride) {
    // Wave 3 / O1 fix (2026-05-28) — `handle.getSkyState()` returns a
    // wasm-bindgen handle that owns Rust-side memory; without an explicit
    // `.free()` every rAF leaks ~100 B of wasm linear memory (~22 MB/min
    // at 60 fps). Only free state we obtained ourselves — `stateOverride`
    // is the caller's handle and not ours to drop.
    let ownedState = null;
    try {
      const handle = this.sessionHandleAccessor();
      if (this.camera?.position) {
        wxUpdateFromPosition(this.camera.position.x, this.camera.position.z);
      }
      let state = stateOverride;
      if (state == null && handle && typeof handle.getSkyState === 'function') {
        state = handle.getSkyState();
        ownedState = state;
      }
      if (state) this.volume.tick(state, null);
    } catch (err) {
      this.lastError = String(err);
    } finally {
      if (ownedState && typeof ownedState.free === 'function') {
        try { ownedState.free(); } catch (_) {}
      }
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
    // 2026-10-07 — ?cloudNight night floor is solved in DISPLAY terms
    // (exposure × AgX); hand the volume the live exposure (`?exposure`,
    // `__setExposure`). A number compare per frame; re-solves only on change.
    this.volume?.setDisplayExposure?.(renderer.toneMappingExposure);
    if (this._mainPass) {
      // `?cloudsMainPass=on`: the main composer's fxPass runs the raymarch
      // (CloudsEffect.update) with the real scene depth; arm exactly one
      // update for this frame. Camera swaps reach the effect through
      // pipeline.setCamera/render -> fxPass.mainCamera fan-out.
      this._mainPassArmed = true;
      this._mainPassCam = activeCam ?? this.camera;
      // Cloud shadows on terrain: the raymarch now runs AFTER the world pass
      // (it is in the post chain), so this pushes LAST frame's cascades — a
      // one-frame lag the legacy pre-world bake did not have. Eye-test item.
      try { this.volume._pushCloudShadowsToTerrain(); } catch (_) {}
      this.frameCount++;
      return;
    }
    // `?cloudsBootOrder=main|prime`: no legacy raymarch before adoption (the
    // prime below is the one exception).
    if (this._suppressLegacy && !this._priming) return;
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
      if (!this._composerSized) {
        // ⚠ CSS PIXELS, NOT DRAWING-BUFFER PIXELS. pmndrs
        // `EffectComposer.setSize` forwards its args straight to
        // `renderer.setSize(w, h, updateStyle)` (postprocessing 6.39.1,
        // build/index.js:1311-1322) and only THEN sizes its own buffers to
        // `getDrawingBufferSize()`. This used to pass `renderer.domElement
        // .width/height` — the DRAWING BUFFER — so on any session with
        // pixelRatio != 1 (HiDPI, or the adaptive render-scale controller,
        // which drives it below 1 routinely) the first cloud frame RESIZED
        // THE CANVAS by the pixel ratio: 2x CSS box + 4x backing store at
        // DPR 2, or a 25% shrink at renderScale 0.75, until the next window
        // resize undid it. Handing it the renderer's own current size makes
        // the identity compare inside setSize skip `renderer.setSize`
        // entirely, while the ping-pong buffers still land at the correct
        // drawing-buffer resolution.
        const s = renderer.getSize(new THREE.Vector2());
        this.composer.setSize(s.x, s.y);
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
      if (this._diagStamps && this._diagStamps.firstMarch === null) this._diagStamps.firstMarch = _diagNow();

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
      if (!this._cloudsBufferUniform) {
        this._cloudsBufferUniform =
          this.volume.effect.uniforms?.get?.('cloudsBuffer') ?? null;
      }
      const tex = this._cloudsBufferUniform?.value ?? null;
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
    if (this._mainPass) {
      // Runs after the main composer: same post-bake cameraHeight patch the
      // legacy preRender applies after its private composer.render.
      try {
        const matUniforms = this.volume?.effect?.cloudsPass?.currentMaterial?.uniforms;
        if (matUniforms?.cameraHeight) {
          matUniforms.cameraHeight.value = Math.max(0, this._mainPassCam?.position?.y ?? 0);
        }
      } catch (_) {}
      return; // AerialPerspective already composited the clouds.
    }
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
        // Bug 11 (2026-10-07): same stale-depth-storage hazard as the main
        // composer (atmosphere_pipeline.js setSize) — free pmndrs' own depth
        // texture so it re-allocates at the new size.
        try { this.composer.depthTexture?.dispose?.(); } catch (_) {}
        // Latch ONLY when a composer actually got sized — setting it with a
        // null composer made preRender skip the lazy-init sizing entirely.
        this._composerSized = true;
      }
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
      this._skySceneBeforeMainPass = null; // tear-down: do not re-attach the quad
      this.releaseMainPass();
      this.overlayMesh.geometry.dispose();
      this.overlayMaterial.dispose();
      this._stbnTex?.dispose?.();
      // Single-owner cloud teardown: detach the cloud EffectPass from
      // the composer BEFORE composer.dispose() so EffectComposer does
      // not dispose the wrapped CloudsEffect. CloudVolume.dispose() is
      // the sole owner that frees the effect's GPU resources.
      if (this.composer && this._cloudEffectPass) {
        this.composer.removePass(this._cloudEffectPass);
      }
      this.composer?.dispose?.();
      this.volume.dispose();
    } catch (err) {
      this.lastError = String(err);
    }
  }
}

// ---------------------------------------------------------------------------
// `window.__cloudStateDiag(opts)` (2026-10-17, read-only, both depth modes).
//
// The 1070 A/B found the open sky BIMODAL PER SESSION (log and reversed-Z
// alike): a "dark" session's cloud buffer reads alpha 1.0 / rgb ~0.092 where a
// "bright" one reads alpha ~0.65-0.83 / rgb ~0.075, with the CloudsEffect and
// AerialPerspective uniform VALUES identical. Cloud alpha is set by the march's
// extinction alone (takram clouds.frag: marchClouds' transmittance, plus the
// haze term) — never by the atmosphere LUTs — so with equal uniforms the state
// has to live in what the march SAMPLES (the four noise textures, STBN, the
// scene depth), in the program actually linked, or in the boot order that put
// them there. This snapshot reports each of those, so one dark and one bright
// session diff to the mechanism:
//   noise     source (prebaked / procedural), the boot stamps, and per noise
//             sampler the bound texture's identity (kind, size, id, flipY) —
//             a different kind or id = a different texture set;
//   uniforms  a digest of every non-camera uniform value (same digest = the
//             coordinator's "identical"), plus the texture uniforms by name;
//   programs  the linked program per cloud material (id + cache-key hash) vs
//             the material's defines — a define not in the program = a stale
//             program;
//   probe     the RAW low-res march (colour + frontDepth) and the resolved
//             buffer at one pixel — frontDepth shows whether the ray stopped
//             at a cloud or at scene depth;
//   lut / look / camera / timeline — LUT source + plan + bandwidth tier, the
//             storm/fair look and its flag, cameraHeight, and when the
//             prebake / adoption / first march / in-world happened.
// `opts`: { x, y } probe position in 0..1 (default 0.5, 0.85 — upper sky),
// `atmosphereRuntime`, `full: true` adds every uniform value. Synchronous
// readbacks: console use only.
// ---------------------------------------------------------------------------

function _diagNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? Math.round(performance.now())
    : Date.now();
}

function _fnv(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

function _half(h) {
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

/** Identity + shape of a bound texture (null-safe). */
export function diagTextureInfo(t) {
  if (!t) return null;
  const img = t.image || {};
  // Render-target first: a GPU-generated (procedural) noise volume is a
  // Data3DTexture too, the prebaked one is not a render-target texture.
  const kind = t.isDepthTexture ? 'depth'
    : t.isRenderTargetTexture ? 'rt'
    : t.isData3DTexture ? 'data3d'
    : t.isDataArrayTexture ? 'array'
    : t.isDataTexture ? 'data'
    : 'image';
  const out = {
    kind, id: t.id ?? null, name: t.name || '', w: img.width ?? null, h: img.height ?? null,
    d: img.depth ?? null, type: t.type ?? null, format: t.format ?? null,
    flipY: t.flipY === true, mipmaps: t.generateMipmaps === true, version: t.version ?? null,
  };
  if (typeof img.src === 'string') out.src = img.src.split('/').pop();
  return out;
}

// Uniforms that move with the camera / frame (excluded from the digest).
const DIAG_CAMERA_UNIFORMS = new Set([
  'projectionMatrix', 'inverseProjectionMatrix', 'viewMatrix', 'inverseViewMatrix',
  'reprojectionMatrix', 'viewReprojectionMatrix', 'cameraPosition', 'temporalJitter',
  'frame', 'jitterOffset', 'moonDirection', 'cameraNear', 'cameraFar',
]);

function _uniformValueKey(v) {
  if (v == null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(+(+v).toPrecision(7));
  // Texture by kind + size, NOT id: ids count textures created before it, so
  // they differ between sessions and would make every cross-session digest
  // differ (identities are reported per sampler in `textures`).
  if (v.isTexture) {
    const i = diagTextureInfo(v);
    return `T:${i.kind}:${i.w}x${i.h}x${i.d}`;
  }
  if (Array.isArray(v)) return '[' + v.map(_uniformValueKey).join(',') + ']';
  if (v.elements) return 'M' + Array.from(v.elements, (x) => +x.toPrecision(7)).join(',');
  if (typeof v.toArray === 'function') return 'V' + v.toArray().map((x) => +(+x).toPrecision(7)).join(',');
  if (typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => k + ':' + _uniformValueKey(v[k])).join(',') + '}';
  }
  return String(v);
}

function _materialDiag(renderer, m, full) {
  if (!m) return null;
  const u = m.uniforms || {};
  const keys = Object.keys(u).sort();
  const textures = {};
  const parts = [];
  const values = full ? {} : undefined;
  for (const k of keys) {
    const v = u[k] && u[k].value;
    if (v && v.isTexture) textures[k] = diagTextureInfo(v);
    if (full) values[k] = _uniformValueKey(v);
    if (!DIAG_CAMERA_UNIFORMS.has(k)) parts.push(k + '=' + _uniformValueKey(v));
  }
  const defines = Object.keys(m.defines || {}).sort().map((k) => `${k}=${m.defines[k]}`);
  let program = null;
  try {
    const p = renderer && renderer.properties && renderer.properties.get(m).currentProgram;
    if (p) {
      const key = typeof p.cacheKey === 'string' ? p.cacheKey : '';
      program = {
        id: p.id ?? null,
        keyHash: _fnv(key),
        // A material define the linked program's key does not carry.
        definesNotInProgram: key ? Object.keys(m.defines || {}).filter((d) => key.indexOf(d) < 0) : null,
      };
    }
  } catch (_) { /* diag */ }
  return {
    uniformsDigest: _fnv(parts.join(';')), textures, defines, definesHash: _fnv(defines.join(';')),
    version: m.version ?? null, program, values,
  };
}

function _readTexel(renderer, rt, u, v, textureIndex = 0) {
  if (!renderer || !rt || typeof renderer.readRenderTargetPixels !== 'function') return null;
  try {
    const tex = (rt.textures && rt.textures[textureIndex]) || rt.texture;
    const x = Math.min(rt.width - 1, Math.max(0, Math.floor(u * rt.width)));
    const y = Math.min(rt.height - 1, Math.max(0, Math.floor(v * rt.height)));
    const half = tex && tex.type === THREE.HalfFloatType;
    const flt = tex && tex.type === THREE.FloatType;
    const buf = half ? new Uint16Array(4) : flt ? new Float32Array(4) : new Uint8Array(4);
    if (half) buf.fill(0xffff); // binary16 NaN sentinel: an unreadable target stays NaN
    renderer.readRenderTargetPixels(rt, x, y, 1, 1, buf, undefined, textureIndex);
    const vals = Array.from(buf, (b) => (half ? _half(b) : flt ? b : b / 255));
    return vals.map((n) => (Number.isFinite(n) ? +n.toFixed(4) : n));
  } catch (e) {
    return String(e && e.message || e);
  }
}

/**
 * The cloud-state snapshot behind `window.__cloudStateDiag()` (see the block
 * comment above). Duck-typed and read-only: nothing is toggled or written.
 * @param {CloudOverlay} overlay
 * @param {THREE.WebGLRenderer|null} renderer
 * @param {{x?:number, y?:number, atmosphereRuntime?:object, full?:boolean}} [opts]
 */
export function cloudStateSnapshot(overlay, renderer, opts = {}) {
  const o = opts || {};
  const px = Number.isFinite(o.x) ? o.x : 0.5;
  const py = Number.isFinite(o.y) ? o.y : 0.85;
  const vol = overlay && overlay.volume;
  const eff = vol && vol.effect;
  const cp = eff && eff.cloudsPass;
  const sp = eff && eff.shadowPass;
  const cm = cp && cp.currentMaterial;
  const out = { t: _diagNow() };

  out.noise = {
    source: overlay && overlay._proceduralTextures ? 'procedural' : 'prebaked',
    prebakedLoaded: !!(overlay && overlay._prebakedLoaded),
    lastError: (overlay && overlay.lastError) ?? null,
    procedural: eff ? {
      localWeather: eff.proceduralLocalWeather ? { needsRender: eff.proceduralLocalWeather.needsRender === true } : null,
      shape: eff.proceduralShape ? { needsRender: eff.proceduralShape.needsRender === true } : null,
      shapeDetail: eff.proceduralShapeDetail ? { needsRender: eff.proceduralShapeDetail.needsRender === true } : null,
      turbulence: eff.proceduralTurbulence ? { needsRender: eff.proceduralTurbulence.needsRender === true } : null,
    } : null,
  };
  out.timeline = overlay && overlay._diagStamps ? { ...overlay._diagStamps } : null;
  out.bootOrder = overlay ? overlay._bootOrder ?? null : null;
  try {
    const hist = typeof window !== 'undefined' && Array.isArray(window.__bootStateHistory) ? window.__bootStateHistory : [];
    const inWorld = hist.find((h) => h && h.state === 'in-world');
    if (out.timeline) out.timeline.inWorld = inWorld ?? null;
  } catch (_) { /* diag */ }

  const rt = o.atmosphereRuntime ?? null;
  out.lut = rt ? {
    ready: rt.ready === true, source: rt.source ?? null, plan: rt.plan ?? null,
    loadTimedOut: rt.loadTimedOut === true, loadMs: rt.loadMs ?? null, bakeMs: rt.bakeMs ?? null,
    error: rt.error ? String(rt.error && rt.error.message || rt.error) : null,
  } : null;
  try {
    out.bandwidth = typeof window !== 'undefined' && typeof window.__bandwidthTier === 'function'
      ? window.__bandwidthTier() : null;
  } catch (_) { out.bandwidth = null; }

  if (eff) {
    out.look = {
      stormLookApplied: vol._stormLookApplied ?? null,
      // Do the layers carry the applied look right now? (false = reset after it)
      layersMatch: typeof vol._stormLookApplied === 'boolean' ? cloudLayersMatchLook(eff, vol._stormLookApplied) : null,
      applies: vol._lookApplies ?? null,
      driftReapplies: vol._lookDriftReapplies ?? null,
      log: Array.isArray(vol._lookLog) ? vol._lookLog.slice() : null,
      wxFlags: vol._wxFlags ? { ...vol._wxFlags } : null,
      coverage: typeof eff.coverage === 'number' ? eff.coverage : null,
      haze: eff.haze ?? null,
      hazeDensityScale: eff.clouds && 'hazeDensityScale' in eff.clouds ? eff.clouds.hazeDensityScale : null,
      layers: Array.isArray(eff.cloudLayers)
        ? eff.cloudLayers.map((l) => [l.channel, l.altitude, l.height, l.densityScale, l.coverageFilterWidth])
        : null,
    };
    out.camera = {
      cameraHeightUniform: cm && cm.uniforms && cm.uniforms.cameraHeight ? cm.uniforms.cameraHeight.value : null,
      cameraWorldY: eff.camera && eff.camera.position ? eff.camera.position.y : null,
      near: eff.camera ? eff.camera.near : null, far: eff.camera ? eff.camera.far : null,
      fov: eff.camera ? eff.camera.fov ?? null : null,
      reversedDepth: eff.camera ? eff.camera.reversedDepth === true : null,
    };
    out.mainPass = overlay.mainPassActive === true;
    out.frame = eff.frame ?? null;
    // 2026-10-20 (gpu-shading-4): ?cloudShadowEvery — the cloud-shadow march
    // cadence in force (every, installed, runs/skips/forced, own march frame).
    out.shadowCadence = typeof vol.shadowCadenceDiag === 'function' ? vol.shadowCadenceDiag() : null;
    out.stbn = diagTextureInfo(cm && cm.uniforms && cm.uniforms.stbnTexture && cm.uniforms.stbnTexture.value);
    out.depth = diagTextureInfo(cm && cm.uniforms && cm.uniforms.depthBuffer && cm.uniforms.depthBuffer.value);
    out.resolution = cm && cm.uniforms && cm.uniforms.resolution ? cm.uniforms.resolution.value.toArray() : null;
    try {
      out.pixelRatio = renderer && typeof renderer.getPixelRatio === 'function' ? renderer.getPixelRatio() : null;
    } catch (_) { out.pixelRatio = null; }
    out.materials = {
      clouds: _materialDiag(renderer, cm, o.full),
      cloudsResolve: _materialDiag(renderer, cp && cp.resolveMaterial, o.full),
      shadow: _materialDiag(renderer, sp && sp.currentMaterial, o.full),
      shadowResolve: _materialDiag(renderer, sp && sp.resolveMaterial, o.full),
    };
    out.probe = cp ? {
      at: [px, py],
      // Low-res raw march: rgba, then depthVelocity (r = frontDepth in m).
      march: _readTexel(renderer, cp.currentRenderTarget, px, py, 0),
      marchDepthVelocity: _readTexel(renderer, cp.currentRenderTarget, px, py, 1),
      // Resolved (temporal) buffer = AerialPerspective's overlay map.
      resolved: _readTexel(renderer, cp.historyRenderTarget, px, py, 0),
    } : null;
  }
  return out;
}
