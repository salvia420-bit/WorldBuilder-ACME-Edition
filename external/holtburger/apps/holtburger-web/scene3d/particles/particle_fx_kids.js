// scene3d/particles/particle_fx_kids.js — tier 1 `?fxKids` (2026-10-10): GPU
// child particles.
//
// Retail emitters are sparse (half cap at 15 particles, most textures are
// 32-64 px). Every retail particle whose profile row carries `kids` > 0 gets up
// to 8 procedural children, computed ENTIRELY in the vertex shader from the
// parent's position, velocity, age, opacity, row and seed plus the shared FX
// clock — stateless, so they cost no simulation, no allocation and no
// per-child JS:
//
//   1 ember    born along the parent's recent path, rising and drifting,
//              cooling white-gold → orange → red (flames, braziers, fire bolts)
//   2 glitter  orbiting four-point glints that twinkle (orbs, stars, runes,
//              enchantment columns, magic mist)
//   3 spark    ballistic sparks under gravity, stretched along their velocity
//              (impacts, fire bursts, tendril bursts, streaks)
//   4 drip     droplets falling off the parent (waterfalls, spouts)
//   5 inflow   motes spiralling into the parent's centre (portals, implosions)
//   6 crackle  brief bright flecks hopping round the parent (lightning)
//
// ONE DRAW per (manager, render layer): an InstancedBufferGeometry whose
// per-parent attributes use `meshPerAttribute = 8` (one record feeds eight
// instances; the child index is gl_InstanceID % 8 and children past the row's
// count collapse off-screen). The manager appends a record per eligible
// particle in `_appendInstances` (the same walk that fills its buckets) and
// publishes in `_finalizeInstBuckets`. Records live in the manager's `_scene`
// local space, like the buckets, so the mesh sits at identity under `_scene`.
//
// VFX invariant: reads parent state + profile row + clock, writes only its own
// render attributes; one constant program; no light.

import * as THREE from "three";

import { FX_UNIFORMS, particleFxTable, particleFxTier1 } from "./particle_fx.js";

export const KIDS_PER_RECORD = 8;
const MIN_CAP = 64;

const VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform highp sampler2D uFxTable;
uniform float uFxTime;
uniform float uFxAddCal;
uniform vec3 uKidUp;
attribute vec4 aKidPos;   // parent position (local), parent age
attribute vec4 aKidVel;   // parent velocity (local, m/s), parent opacity
attribute vec2 aKidRow;   // profile row, seed
varying vec3 vKidCol;
varying float vKidA;
varying vec2 vKidUv;
varying float vKidKind;
float hbKidHash( float p ) {
	p = fract( p * 0.1031 );
	p *= p + 33.33;
	p *= p + p;
	return fract( p );
}
void main() {
	int row = int( aKidRow.x + 0.5 );
	float seed = aKidRow.y;
	vec4 t0 = texelFetch( uFxTable, ivec2( 0, row ), 0 ); // gain, core, sat, tintCurve
	vec4 t1 = texelFetch( uFxTable, ivec2( 1, row ), 0 ); // tint0
	vec4 t2 = texelFetch( uFxTable, ivec2( 2, row ), 0 ); // tint1
	vec4 t6 = texelFetch( uFxTable, ivec2( 6, row ), 0 ); // glow, kids, kidKind, kidSize
	vec4 t7 = texelFetch( uFxTable, ivec2( 7, row ), 0 ); // kidLife, kidSpread, kidGain, rim
	float k = float( gl_InstanceID - ( gl_InstanceID / ${KIDS_PER_RECORD} ) * ${KIDS_PER_RECORD} );
	vKidKind = t6.z;
	vKidUv = position.xy * 2.0;
	if ( k >= t6.y - 0.5 || aKidVel.w <= 0.0 ) {
		vKidCol = vec3( 0.0 ); vKidA = 0.0;
		gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );
		return;
	}
	float kind = t6.z;
	float life = max( t7.x, 0.05 );
	float spread = t7.y;
	float size = t6.w;
	float h1 = hbKidHash( seed * 13.1 + k * 7.7 );
	float h2 = hbKidHash( seed * 5.3 + k * 3.1 + 0.37 );
	float h3 = hbKidHash( seed * 9.7 + k * 1.9 + 0.71 );
	float ph = fract( uFxTime / life + h1 );
	vec3 P = aKidPos.xyz;
	vec3 V = aKidVel.xyz;
	vec3 up = normalize( uKidUp );
	vec3 side = normalize( cross( up, abs( up.x ) < 0.9 ? vec3( 1.0, 0.0, 0.0 ) : vec3( 0.0, 1.0, 0.0 ) ) );
	vec3 fwd = cross( up, side );
	float ang = 6.2831853 * h2;
	vec3 radial = side * cos( ang ) + fwd * sin( ang );
	vec3 c = P;
	vec3 vel = vec3( 0.0 );
	float alpha = 1.0;
	float hot = 1.0;
	float stretchK = 0.35;
	if ( kind < 1.5 ) {
		// ember: emitted from where the parent was, rising, drifting, cooling
		float t = ph * life;
		c = P - V * t * 0.85 + up * ( 0.35 + 0.65 * h3 ) * spread * ph * 1.4
			+ radial * spread * 0.35 * ph * ( 0.5 + h2 )
			+ side * sin( uFxTime * 2.3 + h1 * 20.0 ) * 0.06 * spread * ph;
		vel = up * spread * 1.4 / life;
		alpha = smoothstep( 0.0, 0.08, ph ) * ( 1.0 - smoothstep( 0.55, 1.0, ph ) );
		hot = 1.0 - ph;
		size *= 1.0 - 0.5 * ph;
	} else if ( kind < 2.5 ) {
		// glitter: orbit and twinkle
		float r = spread * ( 0.35 + 0.65 * h3 );
		float a2 = ang + uFxTime * ( 0.6 + 1.2 * h1 ) * ( h2 < 0.5 ? -1.0 : 1.0 );
		c = P + ( side * cos( a2 ) + fwd * sin( a2 ) ) * r + up * ( h1 - 0.5 ) * spread * 0.8
			+ up * sin( uFxTime * 1.3 + h3 * 6.2831853 ) * 0.08 * spread;
		float tw = pow( max( sin( 6.2831853 * ph ), 0.0 ), 6.0 );
		alpha = 0.25 + 0.75 * tw;
		size *= 0.6 + 0.8 * tw;
	} else if ( kind < 3.5 ) {
		// spark: ballistic, gravity, stretched along its velocity
		float t = ph * life;
		vec3 v0 = radial * spread * ( 1.5 + 2.0 * h3 ) / life + up * spread * ( 1.0 + 1.5 * h1 ) / life + V * 0.5;
		vec3 g = -up * 5.9;
		c = P + v0 * t + 0.5 * g * t * t;
		vel = v0 + g * t;
		alpha = 1.0 - smoothstep( 0.4, 1.0, ph );
		hot = 1.0 - ph * 0.7;
		stretchK = 1.0;
	} else if ( kind < 4.5 ) {
		// drip: falls off the parent
		float t = ph * life;
		c = P + radial * spread * 0.2 * h3 + V * t * 0.3 - up * 4.9 * t * t;
		vel = -up * 9.8 * t + V * 0.3;
		alpha = smoothstep( 0.0, 0.1, ph ) * ( 1.0 - smoothstep( 0.6, 1.0, ph ) );
		stretchK = 1.0;
	} else if ( kind < 5.5 ) {
		// inflow: spiral into the centre
		float r = spread * ( 1.0 - ph ) * ( 0.6 + 0.4 * h3 );
		float a2 = ang + ph * 6.2831853 * ( 1.0 + h1 );
		vec3 rd = side * cos( a2 ) + fwd * sin( a2 );
		c = P + rd * r + up * ( h2 - 0.5 ) * spread * 0.6 * ( 1.0 - ph );
		vel = -rd * spread / life;
		alpha = smoothstep( 0.0, 0.25, ph ) * ( 1.0 - smoothstep( 0.85, 1.0, ph ) );
	} else {
		// crackle: bright flecks hopping round the parent
		float cyc = uFxTime / life * 3.0 + h1 * 7.0;
		float hop = floor( cyc );
		float j1 = hbKidHash( hop + seed * 31.0 + k * 3.7 );
		float j2 = hbKidHash( hop * 1.7 + k * 9.1 + 0.13 );
		float j3 = hbKidHash( hop * 2.3 + seed * 7.0 + 0.57 );
		c = P + ( side * ( j1 - 0.5 ) + fwd * ( j2 - 0.5 ) + up * ( j3 - 0.5 ) ) * spread * 1.4;
		vel = ( side * ( j2 - 0.5 ) + up * ( j1 - 0.5 ) ) * 6.0;
		alpha = step( 0.45, hbKidHash( hop * 3.1 + k ) ) * ( 1.0 - fract( cyc ) );
		stretchK = 1.0;
	}
	alpha *= clamp( aKidVel.w, 0.0, 1.0 );
	vec3 tint = mix( t1.rgb, t2.rgb, clamp( aKidPos.w, 0.0, 1.0 ) ) * t0.x;
	vec3 col = tint;
	if ( kind < 1.5 || ( kind > 2.5 && kind < 3.5 && t1.r > t1.b ) ) {
		// hot matter: blackbody-ish ramp, a hint of the parent's tint
		col = mix( vec3( 1.0, 0.28, 0.06 ), vec3( 1.0, 0.85, 0.55 ), hot ) * mix( vec3( 1.0 ), tint, 0.25 ) * 1.6;
	} else if ( kind > 5.5 ) {
		col = mix( tint, vec3( 1.0 ), 0.55 ) * 1.8;
	}
	vKidCol = col * max( t7.z, 0.0 ) * uFxAddCal;
	vKidA = alpha;
	vec4 mv = modelViewMatrix * vec4( c, 1.0 );
	vec3 vv = ( modelViewMatrix * vec4( vel, 0.0 ) ).xyz;
	float sp = length( vv.xy );
	vec2 dir = sp > 1e-4 ? vv.xy / sp : vec2( 0.0, 1.0 );
	float stretch = 1.0 + min( sp * 0.04 / max( size, 1e-3 ), 6.0 ) * stretchK;
	// (perp, dir) must be a ROTATION of the view axes (det +1): a reflected
	// basis flips the quad's winding and front-face culling drops every child
	mv.xy += dir * position.y * size * stretch + vec2( dir.y, -dir.x ) * position.x * size;
	gl_Position = projectionMatrix * mv;
	#include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vKidCol;
varying float vKidA;
varying vec2 vKidUv;
varying float vKidKind;
void main() {
	#include <logdepthbuf_fragment>
	float r2 = dot( vKidUv, vKidUv );
	if ( r2 > 1.0 || vKidA <= 0.0 ) discard;
	float a = exp( -r2 * 6.0 );
	if ( vKidKind > 1.5 && vKidKind < 2.5 ) {
		// glitter: four-point star
		float star = exp( -abs( vKidUv.x ) * 14.0 ) + exp( -abs( vKidUv.y ) * 14.0 );
		a = max( a, star * 0.6 * ( 1.0 - r2 ) );
	}
	a *= vKidA;
	if ( a < 0.002 ) discard;
	gl_FragColor = vec4( vKidCol, a );
}
`;

let _material = null;
const _kidUp = { value: new THREE.Vector3(0, 0, 1) };
/** The shared kids material (one program for every manager and layer). */
export function particleFxKidsMaterial() {
  if (_material) return _material;
  if (!FX_UNIFORMS.uFxTable.value) FX_UNIFORMS.uFxTable.value = particleFxTable();
  _material = new THREE.ShaderMaterial({
    name: "particle-fx-kids",
    uniforms: {
      uFxTable: FX_UNIFORMS.uFxTable,
      uFxTime: FX_UNIFORMS.uFxTime,
      uFxAddCal: FX_UNIFORMS.uFxAddCal,
      uKidUp: _kidUp,
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  _material.userData = { __cacheOwned: true, __particleFxKids: true };
  return _material;
}

/** Shader sources (tests). */
export const PARTICLE_FX_KIDS_GLSL = Object.freeze({ vertex: VERT, fragment: FRAG });

function _quadGeometry(cap) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const mk = (n) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n, false, KIDS_PER_RECORD);
    a.setUsage(THREE.DynamicDrawUsage);
    return a;
  };
  g.setAttribute("aKidPos", mk(4));
  g.setAttribute("aKidVel", mk(4));
  g.setAttribute("aKidRow", mk(2));
  g.instanceCount = 0;
  // Bounds are meaningless here (children are placed in the vertex stage).
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

/**
 * One manager's children for one render layer. `begin` / `push` / `finish`
 * per tick; the mesh lives at identity under the manager's `_scene`.
 */
export class ParticleFxKidsLayer {
  constructor(scene, layer = 0) {
    this.scene = scene;
    this.layer = layer | 0;
    this.cap = MIN_CAP;
    this.n = 0;
    this.idle = 0;
    this.mesh = new THREE.Mesh(_quadGeometry(this.cap), particleFxKidsMaterial());
    this.mesh.name = `particle-fx-kids${this.layer ? `-L${this.layer}` : ""}`;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.mesh.renderOrder = 1;
    // `isParticleInstanced`: statics.js cullStaticsGroup skips particle draws
    // (RP6 owns their visibility) — the static manager parents this under
    // staticsGroup like its buckets.
    this.mesh.userData = { isParticleFxKids: true, isParticleInstanced: true, renderLayer: this.layer };
    if (this.layer > 0) this.mesh.layers.set(this.layer);
    this.mesh.visible = false;
    if (scene) scene.add(this.mesh);
  }

  begin() { this.n = 0; }

  _grow(need) {
    let cap = this.cap;
    while (cap < need) cap *= 2;
    const old = this.mesh.geometry;
    const g = _quadGeometry(cap);
    for (const name of ["aKidPos", "aKidVel", "aKidRow"]) {
      g.getAttribute(name).array.set(old.getAttribute(name).array.subarray(0, this.n * old.getAttribute(name).itemSize));
    }
    this.mesh.geometry = g;
    old.dispose();
    this.cap = cap;
  }

  /** Append one parent record (local position / velocity). */
  push(x, y, z, age, vx, vy, vz, opacity, row, seed) {
    if (this.n >= this.cap) this._grow(this.n + 1);
    const g = this.mesh.geometry;
    const i = this.n++;
    const p = g.attributes.aKidPos.array, v = g.attributes.aKidVel.array, r = g.attributes.aKidRow.array;
    p[i * 4] = x; p[i * 4 + 1] = y; p[i * 4 + 2] = z; p[i * 4 + 3] = age;
    v[i * 4] = vx; v[i * 4 + 1] = vy; v[i * 4 + 2] = vz; v[i * 4 + 3] = opacity;
    r[i * 2] = row; r[i * 2 + 1] = seed;
  }

  /** Publish this tick's records. Returns true when the layer has been idle long enough to drop. */
  finish() {
    const g = this.mesh.geometry;
    g.instanceCount = this.n * KIDS_PER_RECORD;
    this.mesh.visible = this.n > 0;
    if (this.n > 0) {
      this.idle = 0;
      for (const name of ["aKidPos", "aKidVel", "aKidRow"]) {
        const a = g.attributes[name];
        a.clearUpdateRanges();
        a.addUpdateRange(0, this.n * a.itemSize);
        a.needsUpdate = true;
      }
      return false;
    }
    this.idle++;
    return this.idle > 180;
  }

  dispose() {
    try { this.mesh.parent?.remove(this.mesh); } catch (_) { /* detached */ }
    try { this.mesh.geometry.dispose(); } catch (_) { /* gone */ }
  }
}

/**
 * Per-manager children: one layer object per render layer, plus the per-slot
 * previous-position cache that gives each parent its velocity.
 */
export class ParticleFxKids {
  constructor(scene) {
    this.scene = scene;
    /** @type {Map<number, ParticleFxKidsLayer>} */
    this.layers = new Map();
    this.records = 0;
  }

  begin() {
    for (const l of this.layers.values()) l.begin();
    this.records = 0;
  }

  layer(layer) {
    let l = this.layers.get(layer | 0);
    if (!l) {
      l = new ParticleFxKidsLayer(this.scene, layer | 0);
      this.layers.set(layer | 0, l);
    }
    return l;
  }

  /**
   * Append ONE parent record (called from the manager's `_appendInstances`
   * walk, which already has the slot matrix, age, opacity and FX seed). The
   * per-slot previous position gives the parent's velocity; a changed seed
   * (the slot respawned) resets it.
   * @param {object} emitter
   * @param {number} i slot index
   * @param {ArrayLike<number>} e the slot mesh's local matrix elements
   * @param {number} age [0,1]
   * @param {number} opacity
   * @param {number} row profile row
   * @param {number} seed FX seed [0,1)
   * @param {number} nowSec physics clock
   */
  pushParticle(emitter, i, e, age, opacity, row, seed, nowSec) {
    const n = emitter.parts ? emitter.parts.length : 0;
    let prev = emitter._kidPrev;
    if (!prev || prev.length < n * 5) {
      const np = new Float32Array(Math.max(n, 1) * 5).fill(NaN);
      if (prev) np.set(prev.subarray(0, Math.min(prev.length, np.length)));
      emitter._kidPrev = prev = np;
    }
    const x = e[12], y = e[13], z = e[14];
    let vx = 0, vy = 0, vz = 0;
    const o = i * 5;
    if (prev[o + 4] === seed && Number.isFinite(prev[o + 3])) {
      const dt = nowSec - prev[o + 3];
      if (dt > 1e-4 && dt < 0.5) {
        vx = (x - prev[o]) / dt; vy = (y - prev[o + 1]) / dt; vz = (z - prev[o + 2]) / dt;
        // a teleporting parent (slot reuse within a tick) must not fling embers
        if (vx * vx + vy * vy + vz * vz > 400) { vx = 0; vy = 0; vz = 0; }
      }
    }
    prev[o] = x; prev[o + 1] = y; prev[o + 2] = z; prev[o + 3] = nowSec; prev[o + 4] = seed;
    this.layer(emitter.renderLayer | 0).push(x, y, z, age, vx, vy, vz, opacity, row, seed);
    this.records++;
  }

  /** True when this row spawns children. */
  static rowHasKids(row) {
    return (row | 0) > 0 && particleFxTier1(row).kids > 0;
  }

  /** Publish; reap layers idle for ~3 s. Also refreshes the local-space up. */
  finish() {
    for (const [k, l] of this.layers) {
      if (l.finish()) { l.dispose(); this.layers.delete(k); }
    }
    if (this.scene && typeof this.scene.getWorldQuaternion === "function") {
      try {
        this.scene.getWorldQuaternion(_q).invert();
        _kidUp.value.set(0, 1, 0).applyQuaternion(_q).normalize();
      } catch (_) { /* keep the last up */ }
    }
  }

  /** Live meshes (for the late particle pass). */
  collect(out) {
    for (const l of this.layers.values()) if (l.n > 0) out.push(l.mesh);
  }

  dispose() {
    for (const l of this.layers.values()) l.dispose();
    this.layers.clear();
  }
}
const _q = new THREE.Quaternion();
