// scene3d/vfx/fx_glow_effect.js — tier 1 `?fxGlow` (2026-10-10): the particle
// glow buffer.
//
// WHY. The scene bloom (atmosphere_pipeline.js, 0.55 / threshold 1.1) is tuned
// against the low sun, so it can only catch the hottest particle cores, and
// the 2026-10-09 display calibration (correctly) pulled the sprites' colour
// back to retail. One channel had to carry both "the right colour" and "the
// glow", so every emitter's gain had to stay low. This effect separates them:
// each additive FX bucket is drawn a SECOND time, with its own row's `glow`
// share of the calibrated colour (particle_fx.js HB_FX_GLOW), into a half-res
// HDR glow buffer; a mip-chain blur (pmndrs MipmapBlurPass, the bloom's own
// blur) spreads it, and the composite ADDS it to the scene before lens flare,
// bloom, vignette and tone mapping. A portal or a spell orb can carry a large
// saturated halo while the scene threshold stays where the dusk sun needs it.
//
// OCCLUSION. The glow buffer has no depth attachment (sampling the composer's
// depth texture while it is attached would be a feedback loop); the glow
// variant decodes the scene depth itself and fades a particle out behind
// whatever is in front of it (0.5 m soft edge).
//
// NO PARTICLES IMPORT. The composer chunk never imports the particles chunk:
// the buckets, their glow materials and the per-frame uniforms come through
// the provider particle_manager.js registers (particles_over_clouds.js).
// Before that chunk has loaded (no particles yet) the effect draws nothing.
//
// COST. One extra draw per visible additive bucket (~tens in a town) at half
// resolution, a 5-level mip blur at the bloom's resolution, one full-screen
// texture tap in the post pass. Off below the `high` preset (fx_tier1.js).

import * as THREE from "three";
import { BlendFunction, Effect, MipmapBlurPass } from "postprocessing";
import { fxGlowProvider } from "../particles_over_clouds.js";
import { fxTier1Enabled } from "./fx_tier1.js";

// No backticks in the GLSL (template literal).
const FRAG = /* glsl */ `
uniform sampler2D tFxGlow;
uniform float uFxGlowIntensity;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 g = max(texture2D(tFxGlow, uv).rgb, vec3(0.0)) * uFxGlowIntensity;
  outputColor = vec4(inputColor.rgb + g, inputColor.a);
}
`;

const ALL_LAYERS = 0xffffffff;

export class FxGlowEffect extends Effect {
  /**
   * @param {{camera?: THREE.Camera, depthSource?: () => (THREE.Texture|null),
   *   resolutionScale?: number, levels?: number, radius?: number,
   *   intensity?: number, strength?: number}} [opts]
   */
  constructor(opts = {}) {
    super("FxGlowEffect", FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map([
        ["tFxGlow", new THREE.Uniform(null)],
        ["uFxGlowIntensity", new THREE.Uniform(Number.isFinite(opts.intensity) ? opts.intensity : 1.0)],
      ]),
    });
    this.camera = opts.camera ?? null;
    this._depthSource = typeof opts.depthSource === "function" ? opts.depthSource : () => null;
    this.resolutionScale = Number.isFinite(opts.resolutionScale) ? opts.resolutionScale : 0.5;
    /** Per-emitter glow multiplier on top of each row's `glow` (uFxGlowScale). */
    this.strength = Number.isFinite(opts.strength) ? opts.strength : 1.0;
    this.glowTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.glowTarget.texture.name = "FxGlow.Target";
    this.glowTarget.texture.generateMipmaps = false;
    this.blurPass = new MipmapBlurPass();
    this.blurPass.levels = Number.isFinite(opts.levels) ? opts.levels : 5;
    this.blurPass.radius = Number.isFinite(opts.radius) ? opts.radius : 0.8;
    this.uniforms.get("tFxGlow").value = this.blurPass.texture;
    this.glowScene = new THREE.Scene();
    this.glowScene.name = "FxGlow.Scene";
    this.glowScene.matrixWorldAutoUpdate = false;
    /** @type {Map<object, THREE.InstancedMesh>} bucket → its glow twin */
    this._twins = new Map();
    this._list = [];
    this._seen = new Set();
    this._clearColor = new THREE.Color();
    this._dirty = true;
    this.stats = { frames: 0, buckets: 0, drawn: 0, cpuMs: 0 };
  }

  /** pmndrs EffectPass forwards its camera here (the base Effect setter is a no-op). */
  set mainCamera(c) { if (c) this.camera = c; }
  get mainCamera() { return this.camera; }

  get intensity() { return this.uniforms.get("uFxGlowIntensity").value; }
  set intensity(v) { if (Number.isFinite(+v)) this.uniforms.get("uFxGlowIntensity").value = Math.max(0, +v); }

  /** The bucket's glow twin: same geometry + instance buffers (shared GL buffers), glow material. */
  _twin(bucket, material) {
    let t = this._twins.get(bucket);
    if (t && t.material !== material) {
      this.glowScene.remove(t);
      t = null;
    }
    if (!t) {
      t = new THREE.InstancedMesh(bucket.geometry, material, 1);
      t.instanceMatrix = bucket.instanceMatrix;
      t.instanceColor = bucket.instanceColor;
      t.frustumCulled = false;
      t.matrixAutoUpdate = false;
      t.layers.mask = ALL_LAYERS;
      t.name = `${bucket.name || "bucket"}-glow`;
      this._twins.set(bucket, t);
      this.glowScene.add(t);
    }
    return t;
  }

  update(renderer, _inputBuffer, _deltaTime) {
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    this.stats.frames++;
    const prov = fxGlowProvider();
    const cam = this.camera;
    const list = this._list;
    list.length = 0;
    if (prov && cam && fxTier1Enabled("fxGlow")) {
      try { prov.collect(list); } catch (_) { list.length = 0; }
    }
    // Sync the twins with this frame's buckets.
    const seen = this._seen;
    seen.clear();
    let drawn = 0;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!b || !b.parent || !_ancestorsVisible(b)) continue;
      let mat = null;
      try { mat = prov.materialFor(b); } catch (_) { mat = null; }
      if (!mat) continue;
      const t = this._twin(b, mat);
      // instance buffers can be replaced by the manager (bucket growth makes a
      // NEW bucket object, so that case is a new twin); re-point defensively
      if (t.instanceMatrix !== b.instanceMatrix) t.instanceMatrix = b.instanceMatrix;
      if (t.instanceColor !== b.instanceColor) t.instanceColor = b.instanceColor;
      t.count = b.count;
      t.matrixWorld.copy(b.matrixWorld);
      t.visible = true;
      seen.add(b);
      drawn++;
    }
    for (const [b, t] of this._twins) {
      if (!seen.has(b)) {
        this.glowScene.remove(t);
        this._twins.delete(b);
      }
    }
    this.stats.buckets = list.length;
    this.stats.drawn = drawn;
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.getClearColor(this._clearColor);
    const prevAlpha = renderer.getClearAlpha();
    try {
      renderer.autoClear = false;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(this.glowTarget);
      if (drawn === 0) {
        // keep the blurred texture black once nothing glows (no per-frame cost after)
        if (this._dirty) {
          renderer.clear(true, false, false);
          this.blurPass.render(renderer, this.glowTarget);
          this._dirty = false;
        }
      } else {
        renderer.clear(true, false, false);
        prov.setFrame?.({
          depthTexture: this._depthSource(),
          width: this.glowTarget.width,
          height: this.glowTarget.height,
          camera: cam,
          isLog: renderer.capabilities?.logarithmicDepthBuffer === true,
          scale: this.strength,
        });
        renderer.render(this.glowScene, cam);
        this.blurPass.render(renderer, this.glowTarget);
        this._dirty = true;
      }
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(this._clearColor, prevAlpha);
      renderer.autoClear = prevAuto;
    }
    this.stats.cpuMs = (typeof performance !== "undefined" ? performance.now() : 0) - t0;
  }

  setSize(width, height) {
    const w = Math.max(1, Math.round(width * this.resolutionScale));
    const h = Math.max(1, Math.round(height * this.resolutionScale));
    this.glowTarget.setSize(w, h);
    this.blurPass.setSize(w, h);
    this._dirty = true;
  }

  initialize(renderer, alpha, frameBufferType) {
    this.blurPass.initialize(renderer, alpha, frameBufferType ?? THREE.HalfFloatType);
    if (frameBufferType !== undefined) this.glowTarget.texture.type = frameBufferType;
  }

  dispose() {
    for (const t of this._twins.values()) this.glowScene.remove(t);
    this._twins.clear();
    this.glowTarget.dispose();
    this.blurPass.dispose();
    super.dispose();
  }
}

function _ancestorsVisible(o) {
  for (let p = o.parent; p; p = p.parent) if (p.visible === false) return false;
  return true;
}

/**
 * The glow effect, or null when `?fxGlow` is off for this session (the slot
 * is dropped by the pipeline's filter(Boolean), leaving the pass unchanged).
 */
export function createFxGlowEffect(opts = {}) {
  const on = typeof opts.enabled === "boolean" ? opts.enabled : fxTier1Enabled("fxGlow");
  if (!on) return null;
  return new FxGlowEffect(opts);
}

/** `window.__fxGlow` live-tuning handle. */
export function installFxGlowHandle(effect) {
  if (typeof window === "undefined" || !effect) return null;
  const h = {
    get intensity() { return effect.intensity; },
    set intensity(v) { effect.intensity = v; },
    get strength() { return effect.strength; },
    set strength(v) { if (Number.isFinite(+v)) effect.strength = Math.max(0, +v); },
    get radius() { return effect.blurPass.radius; },
    set radius(v) { if (Number.isFinite(+v)) effect.blurPass.radius = +v; },
    stats: () => ({ ...effect.stats }),
    effect,
  };
  window.__fxGlow = h;
  return h;
}
