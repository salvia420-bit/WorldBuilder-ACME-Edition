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
      cloudOptions,
      proceduralTextures = true,
    } = opts || {};
    if (!camera) throw new Error('CloudOverlay: opts.camera is required');

    this.camera = camera;
    this.sessionHandleAccessor =
      typeof sessionHandleAccessor === 'function'
        ? sessionHandleAccessor
        : () => null;

    // The bridge. Owns the CloudsEffect + the 5 DayGroup uniforms.
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
    }

    // Per-frame dt source. The pmndrs Effect.update() contract wants
    // a deltaTime; we don't need exact accuracy (it drives temporal
    // jitter for TAA, not physics) so an internal clock is fine.
    this.clock = new THREE.Clock();

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
          // pmndrs Effect compositors typically write premultiplied
          // alpha, so blend with NormalBlending + premultipliedAlpha.
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

    // Set the cloud texture pointer once — CloudsPass.outputBuffer is
    // a stable WebGLRenderTarget that's reused frame after frame, so
    // we don't have to refresh this each tick.
    this.overlayMaterial.uniforms.cloudTex.value =
      this.volume.effect.cloudsPass.outputBuffer?.texture ?? null;

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
      // The effect.update() implementation re-binds setRenderTarget
      // multiple times for each sub-pass; we don't pre-bind anything.
      this.volume.effect.update(renderer, null, dt);
      renderer.setRenderTarget(prevTarget);
      // Re-sync the texture pointer in case CloudsPass resized + swapped
      // the underlying RT (the resolution-scale machinery can do this).
      const tex = this.volume.effect.cloudsPass.outputBuffer?.texture ?? null;
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
      this.volume.dispose();
    } catch (err) {
      this.lastError = String(err);
    }
  }
}
