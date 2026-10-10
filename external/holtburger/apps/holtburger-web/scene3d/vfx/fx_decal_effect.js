// scene3d/vfx/fx_decal_effect.js — tier 2 `?fxDecals` (2026-10-10): ground
// marks (scorch, frost, acid, the showcase light rings) projected onto the
// scene, deferred-decal style.
//
// HOW. Each live mark (vfx/fx_decals.js) is a world-space box. In `update()`
// the effect draws every box's back faces — ONE instanced draw per pass, two
// passes — into two private targets the size of the frame:
//   MUL  cleared to white, multiply-blended: the mark's tint of the surface
//        (char darkens, rime whitens, acid stains green). A multiply keeps the
//        surface's own lighting: a scorch at night is a darker shade of the
//        night ground, not a painted black disc.
//   ADD  cleared to black, additive: what the mark emits (the scorch's cooling
//        rim and embers, frost glints, acid bubbles, the rings' light).
// Each fragment reconstructs its pixel's world position from the composer's
// scene depth (sampled, never attached — the glow effect's rule), keeps the
// up-facing surface points inside its box and paints the procedural mark,
// faded by the scene fog. The composite is `scene * MUL + ADD`.
//
// PLACEMENT (atmosphere_pipeline.js). In the atmosphere EffectPass after the
// AO composite and BEFORE the clouds / aerial perspective, so a mark is hazed
// with the ground it lies on; declared EffectAttribute.DEPTH only so the pass's
// attribute sort keeps that slot. On the split chain the particles draw after
// this pass (no burst is darkened by its own scorch); on the single chain the
// scorch's darkening grows in over 0.8 s for the same reason. Works on both.
//
// COST. Two full-size half-float targets, cleared only while marks exist; two
// instanced box draws covering the marks' screen footprint; two texture taps
// in the composite (skipped by a uniform branch when nothing is live).

import * as THREE from "three";
import { BlendFunction, Effect, EffectAttribute } from "postprocessing";
import { FX_DECAL_MAX, collectFxDecals } from "./fx_decals.js";
import { fxTier2Enabled } from "./fx_tier2.js";

// No backticks in the GLSL (template literal).
const COMPOSITE = /* glsl */ `
uniform sampler2D tDecalMul;
uniform sampler2D tDecalAdd;
uniform float uDecalOn;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  if (uDecalOn < 0.5) { outputColor = inputColor; return; }
  vec3 m = texture2D(tDecalMul, uv).rgb;
  vec3 a = texture2D(tDecalAdd, uv).rgb;
  outputColor = vec4(inputColor.rgb * m + a, inputColor.a);
}
`;

const BOX_VERT = /* glsl */ `
attribute vec4 aD0;   // centre.xyz (THREE world), radius
attribute vec4 aD1;   // half-height, yaw, kind, fade
attribute vec4 aD2;   // colour.rgb, seed
attribute vec4 aD3;   // age (s), intensity, 0, 0
varying vec4 vD0;
varying vec4 vD1;
varying vec4 vD2;
varying vec4 vD3;
void main() {
	vec3 lp = position * vec3( 2.0 * aD0.w, 2.0 * aD1.x, 2.0 * aD0.w );
	float c = cos( aD1.y );
	float s = sin( aD1.y );
	vec3 wp = aD0.xyz + vec3( c * lp.x + s * lp.z, lp.y, -s * lp.x + c * lp.z );
	vD0 = aD0; vD1 = aD1; vD2 = aD2; vD3 = aD3;
	gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
}
`;

const BOX_FRAG = /* glsl */ `
uniform highp sampler2D uDecalDepth;
uniform vec2 uDecalRes;
uniform float uDecalLogFar;
uniform float uDecalIsLog;
uniform vec2 uDecalNearFar;
uniform mat4 uDecalCamWorld;
uniform vec4 uDecalProj;     // projection P00, P11, P20, P21 (the fragment stage has no projectionMatrix)
uniform float uDecalTime;
uniform vec4 uDecalFog;      // kind (0 none, 1 linear, 2 exp2), near, far, density
uniform float uDecalAddCal;
varying vec4 vD0;
varying vec4 vD1;
varying vec4 vD2;
varying vec4 vD3;
float hbDecalHash( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
float hbDecalNoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( hbDecalHash( i ), hbDecalHash( i + vec2( 1.0, 0.0 ) ), f.x ),
		mix( hbDecalHash( i + vec2( 0.0, 1.0 ) ), hbDecalHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
float hbDecalFbm( vec2 p ) {
	float s = 0.0;
	float a = 0.5;
	for ( int i = 0; i < 4; i++ ) { s += a * hbDecalNoise( p ); p = p * 2.03 + 17.1; a *= 0.5; }
	return s / 0.9375;
}
void main() {
	vec2 suv = gl_FragCoord.xy / uDecalRes;
	float d = texture2D( uDecalDepth, suv ).x;
	if ( d >= 0.999999 ) discard;   // sky: nothing to mark
	float w;
	if ( uDecalIsLog > 0.5 ) {
		w = exp2( d * uDecalLogFar ) - 1.0;
	} else {
		float z = d * 2.0 - 1.0;
		w = ( 2.0 * uDecalNearFar.x * uDecalNearFar.y ) / ( uDecalNearFar.y + uDecalNearFar.x - z * ( uDecalNearFar.y - uDecalNearFar.x ) );
	}
	vec2 ndc = suv * 2.0 - 1.0;
	vec3 vp = vec3( ( ndc.x + uDecalProj.z ) * w / uDecalProj.x, ( ndc.y + uDecalProj.w ) * w / uDecalProj.y, -w );
	vec3 wp = ( uDecalCamWorld * vec4( vp, 1.0 ) ).xyz;
	vec3 rel = wp - vD0.xyz;
	float c = cos( vD1.y );
	float s = sin( vD1.y );
	vec2 q = vec2( c * rel.x - s * rel.z, s * rel.x + c * rel.z ) / vD0.w;   // into the box (unit disc)
	float ly = rel.y / vD1.x;
	if ( abs( ly ) > 1.0 || dot( q, q ) > 1.0 ) discard;
	// only up-facing surfaces take the mark (a wall or a creature's flank does not)
	vec3 n = cross( dFdx( wp ), dFdy( wp ) );
	float nl = length( n );
	float upF = nl > 1e-12 ? smoothstep( 0.45, 0.8, abs( n.y ) / nl ) : 0.0;
	float k = upF * ( 1.0 - smoothstep( 0.55, 1.0, abs( ly ) ) ) * vD1.w;
	if ( k <= 0.0 ) discard;
	float r = length( q );
	float kind = vD1.z;
	float age = vD3.x;
	float seed = vD2.w;
	vec3 mulC = vec3( 1.0 );
	vec3 addC = vec3( 0.0 );
	if ( kind < 1.5 ) {
		// scorch: a ragged char, mottled, its rim and embers cooling off
		float nz = hbDecalFbm( q * 2.6 + seed * 17.0 );
		float edgeR = 0.62 + 0.3 * nz;
		float ch = 1.0 - smoothstep( edgeR - 0.18, edgeR, r );
		ch *= 0.75 + 0.25 * hbDecalFbm( q * 7.0 + 3.1 );
		mulC = mix( vec3( 1.0 ), vec3( 0.16, 0.13, 0.11 ), ch * 0.92 * smoothstep( 0.0, 0.8, age ) );
		float rim = exp( -pow( ( r - edgeR * 0.92 ) / 0.07, 2.0 ) ) * exp( -age / 1.4 );
		vec2 cell = floor( q * 9.0 );
		float emb = step( 0.86, hbDecalHash( cell + seed * 31.0 ) ) * ch * exp( -age / 3.5 )
			* ( 0.6 + 0.4 * sin( uDecalTime * 7.0 + hbDecalHash( cell ) * 20.0 ) );
		addC = vD2.rgb * ( rim * 2.2 + emb * 1.6 );
	} else if ( kind < 2.5 ) {
		// frost: a whitening rime, six-fold crystal spokes, glints
		float nz = hbDecalFbm( q * 3.0 + seed * 11.0 );
		float edgeR = 0.55 + 0.35 * nz;
		float cov = ( 1.0 - smoothstep( edgeR - 0.25, edgeR, r ) ) * smoothstep( 0.0, 0.4, age );
		float th = r > 1e-4 ? atan( q.y, q.x ) : 0.0;
		float spokes = pow( abs( cos( th * 3.0 + nz * 2.0 ) ), 18.0 ) * ( 1.0 - r );
		mulC = mix( vec3( 1.0 ), vec3( 1.35, 1.5, 1.7 ), cov * ( 0.55 + 0.45 * hbDecalFbm( q * 11.0 ) ) * 0.75 );
		float glint = pow( hbDecalNoise( q * 24.0 + uDecalTime * 0.6 ), 14.0 ) * cov;
		addC = vD2.rgb * ( spokes * cov * 0.35 + glint * 1.4 );
	} else if ( kind < 3.5 ) {
		// acid: a green stain with a wet, bubbling sheen
		float nz = hbDecalFbm( q * 2.2 + seed * 13.0 );
		float edgeR = 0.45 + 0.4 * nz;
		float cov = ( 1.0 - smoothstep( edgeR - 0.2, edgeR, r ) ) * smoothstep( 0.0, 0.3, age );
		mulC = mix( vec3( 1.0 ), vec3( 0.55, 0.8, 0.32 ), cov * 0.8 );
		float bub = pow( hbDecalNoise( q * 14.0 + vec2( 0.0, uDecalTime * 0.7 ) ), 10.0 ) * cov;
		addC = vD2.rgb * ( bub * 1.2 + cov * 0.06 );
	} else {
		// ring: a breathing light ring on the ground (portal / lifestone showcase)
		float rr = abs( r - 0.82 );
		float ring = exp( -rr * rr / 0.0025 ) + 0.25 * exp( -rr * 9.0 );
		float pulse = 0.85 + 0.15 * sin( uDecalTime * 1.3 + seed * 6.2831853 );
		addC = vD2.rgb * ( ring + 0.12 * ( 1.0 - smoothstep( 0.0, 0.82, r ) ) ) * pulse;
	}
	float fogF = 0.0;
	if ( uDecalFog.x > 1.5 ) fogF = 1.0 - exp( -uDecalFog.w * uDecalFog.w * w * w );
	else if ( uDecalFog.x > 0.5 ) fogF = smoothstep( uDecalFog.y, uDecalFog.z, w );
	k *= 1.0 - fogF;
	#ifdef HB_DECAL_MUL
	gl_FragColor = vec4( mix( vec3( 1.0 ), mulC, k ), 1.0 );
	#else
	gl_FragColor = vec4( addC * k * vD3.y * uDecalAddCal, 1.0 );
	#endif
}
`;

/** Shader sources (tests). */
export const FX_DECAL_GLSL = Object.freeze({ composite: COMPOSITE, vertex: BOX_VERT, fragment: BOX_FRAG });

const ALL_LAYERS = 0xffffffff;
const ADD_CAL_K = 3.0;

export class FxDecalEffect extends Effect {
  /** @param {{camera?: THREE.Camera, depthSource?: () => (THREE.Texture|null), fog?: () => (object|null)}} [opts] */
  constructor(opts = {}) {
    super("FxDecalEffect", COMPOSITE, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map([
        ["tDecalMul", new THREE.Uniform(null)],
        ["tDecalAdd", new THREE.Uniform(null)],
        ["uDecalOn", new THREE.Uniform(0)],
      ]),
    });
    this.camera = opts.camera ?? null;
    this._depthSource = typeof opts.depthSource === "function" ? opts.depthSource : () => null;
    this._fogSource = typeof opts.fog === "function" ? opts.fog : () => null;
    const mk = (name) => {
      const t = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      });
      t.texture.name = name;
      t.texture.generateMipmaps = false;
      return t;
    };
    this.mulTarget = mk("FxDecal.Mul");
    this.addTarget = mk("FxDecal.Add");
    this.uniforms.get("tDecalMul").value = this.mulTarget.texture;
    this.uniforms.get("tDecalAdd").value = this.addTarget.texture;
    this.boxUniforms = {
      uDecalDepth: { value: null },
      uDecalRes: { value: new THREE.Vector2(1, 1) },
      uDecalLogFar: { value: 1 },
      uDecalIsLog: { value: 1 },
      uDecalNearFar: { value: new THREE.Vector2(0.1, 1000) },
      uDecalCamWorld: { value: new THREE.Matrix4() },
      uDecalProj: { value: new THREE.Vector4(1, 1, 0, 0) },
      uDecalTime: { value: 0 },
      uDecalFog: { value: new THREE.Vector4(0, 0, 1, 0) },
      uDecalAddCal: { value: 1 },
    };
    const box = new THREE.BoxGeometry(1, 1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = box.index;
    g.setAttribute("position", box.getAttribute("position"));
    const mkI = () => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(FX_DECAL_MAX * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    for (const n of ["aD0", "aD1", "aD2", "aD3"]) g.setAttribute(n, mkI());
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.boxGeometry = g;
    // Exact blend state (CustomBlending): MUL = src x dst, ADD = src + dst.
    const mat = (mul) => new THREE.ShaderMaterial({
      name: mul ? "fx-decal-mul" : "fx-decal-add",
      defines: mul ? { HB_DECAL_MUL: "" } : {},
      uniforms: this.boxUniforms,
      vertexShader: BOX_VERT,
      fragmentShader: BOX_FRAG,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: mul ? THREE.DstColorFactor : THREE.OneFactor,
      blendDst: mul ? THREE.ZeroFactor : THREE.OneFactor,
      fog: false,
    });
    this.mulMaterial = mat(true);
    this.addMaterial = mat(false);
    this.boxMesh = new THREE.Mesh(g, this.mulMaterial);
    this.boxMesh.frustumCulled = false;
    this.boxMesh.layers.mask = ALL_LAYERS;
    this.boxScene = new THREE.Scene();
    this.boxScene.name = "FxDecal.Scene";
    this.boxScene.matrixWorldAutoUpdate = false;
    this.boxScene.add(this.boxMesh);
    this._list = [];
    this._eye = new THREE.Vector3();
    this._clearColor = new THREE.Color();
    this._dirty = true;
    /** Multiplier on what the marks emit (`window.__fxDecals.addGain`, live tuning). */
    this.addGain = 1;
    this.stats = { frames: 0, drawn: 0, cpuMs: 0 };
  }

  set mainCamera(c) { if (c) this.camera = c; }
  get mainCamera() { return this.camera; }

  /** Fill the instance attributes from this frame's marks. Returns the count. */
  _fill(list) {
    const g = this.boxGeometry;
    const A0 = g.attributes.aD0.array, A1 = g.attributes.aD1.array, A2 = g.attributes.aD2.array, A3 = g.attributes.aD3.array;
    const n = Math.min(list.length, FX_DECAL_MAX);
    for (let i = 0; i < n; i++) {
      const d = list[i];
      const o = i * 4;
      A0[o] = d.x; A0[o + 1] = d.y; A0[o + 2] = d.z; A0[o + 3] = d.radius;
      A1[o] = d.height; A1[o + 1] = d.yaw; A1[o + 2] = d.kind; A1[o + 3] = d.fade;
      A2[o] = d.color[0]; A2[o + 1] = d.color[1]; A2[o + 2] = d.color[2]; A2[o + 3] = d.seed;
      A3[o] = d.ageSec || 0; A3[o + 1] = d.intensity; A3[o + 2] = 0; A3[o + 3] = 0;
    }
    for (const name of ["aD0", "aD1", "aD2", "aD3"]) {
      const a = g.attributes[name];
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * 4);
      a.needsUpdate = true;
    }
    g.instanceCount = n;
    return n;
  }

  _setFrameUniforms(renderer, cam) {
    const U = this.boxUniforms;
    U.uDecalDepth.value = this._depthSource();
    U.uDecalRes.value.set(this.mulTarget.width, this.mulTarget.height);
    const far = Number.isFinite(cam.far) && cam.far > 0 ? cam.far : 1000;
    const near = Number.isFinite(cam.near) && cam.near > 0 ? cam.near : 0.1;
    U.uDecalLogFar.value = Math.log2(far + 1);
    U.uDecalIsLog.value = renderer.capabilities?.logarithmicDepthBuffer === true ? 1 : 0;
    U.uDecalNearFar.value.set(near, far);
    U.uDecalCamWorld.value.copy(cam.matrixWorld);
    const pe = cam.projectionMatrix.elements;
    U.uDecalProj.value.set(pe[0], pe[5], pe[8], pe[9]);
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    U.uDecalTime.value = (now / 1000) % 1024;
    const fog = this._fogSource();
    if (fog && fog.isFogExp2) U.uDecalFog.value.set(2, 0, 1, fog.density || 0);
    else if (fog && fog.isFog) U.uDecalFog.value.set(1, fog.near || 0, Math.max((fog.near || 0) + 1e-3, fog.far || 1), 0);
    else U.uDecalFog.value.set(0, 0, 1, 0);
    const e = Number(renderer.toneMappingExposure);
    U.uDecalAddCal.value = (Number.isFinite(e) && e > 1 ? Math.min(1, ADD_CAL_K / Math.min(20, e)) : 1) * this.addGain;
  }

  update(renderer, _inputBuffer, _deltaTime) {
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    this.stats.frames++;
    const cam = this.camera;
    const list = this._list;
    list.length = 0;
    if (cam && fxTier2Enabled("fxDecals") && this._depthSource()) {
      cam.getWorldPosition(this._eye);
      collectFxDecals(this._eye, list);
    }
    const on = this.uniforms.get("uDecalOn");
    if (list.length === 0) {
      on.value = 0;
      this.stats.drawn = 0;
      if (this._dirty) this._clearTargets(renderer);
      return;
    }
    const n = this._fill(list);
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.getClearColor(this._clearColor);
    const prevAlpha = renderer.getClearAlpha();
    try {
      renderer.autoClear = false;
      this._setFrameUniforms(renderer, cam);
      renderer.setRenderTarget(this.mulTarget);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear(true, false, false);
      this.boxMesh.material = this.mulMaterial;
      renderer.render(this.boxScene, cam);
      renderer.setRenderTarget(this.addTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      this.boxMesh.material = this.addMaterial;
      renderer.render(this.boxScene, cam);
      on.value = 1;
      this._dirty = true;
    } finally {
      this.boxUniforms.uDecalDepth.value = null;
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(this._clearColor, prevAlpha);
      renderer.autoClear = prevAuto;
    }
    this.stats.drawn = n;
    this.stats.cpuMs = (typeof performance !== "undefined" ? performance.now() : 0) - t0;
  }

  _clearTargets(renderer) {
    const prevTarget = renderer.getRenderTarget();
    renderer.getClearColor(this._clearColor);
    const prevAlpha = renderer.getClearAlpha();
    try {
      renderer.setRenderTarget(this.mulTarget);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear(true, false, false);
      renderer.setRenderTarget(this.addTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      this._dirty = false;
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(this._clearColor, prevAlpha);
    }
  }

  setSize(width, height) {
    const w = Math.max(1, width | 0), h = Math.max(1, height | 0);
    this.mulTarget.setSize(w, h);
    this.addTarget.setSize(w, h);
    this._dirty = true;
  }

  dispose() {
    this.mulTarget.dispose();
    this.addTarget.dispose();
    this.boxGeometry.dispose();
    this.mulMaterial.dispose();
    this.addMaterial.dispose();
    super.dispose();
  }
}

/** The effect, or null when `?fxDecals` is off for this session (the pipeline drops the slot). */
export function createFxDecalEffect(opts = {}) {
  const on = typeof opts.enabled === "boolean" ? opts.enabled : fxTier2Enabled("fxDecals");
  if (!on) return null;
  return new FxDecalEffect(opts);
}

/** `window.__fxDecals` live handle. */
export function installFxDecalHandle(effect, extra = {}) {
  if (typeof window === "undefined" || !effect) return null;
  const h = {
    stats: () => ({ ...effect.stats, ...(extra.stats ? extra.stats() : {}) }),
    get addGain() { return effect.addGain; },
    set addGain(v) { if (Number.isFinite(+v)) effect.addGain = Math.max(0, +v); },
    effect,
  };
  window.__fxDecals = h;
  return h;
}
