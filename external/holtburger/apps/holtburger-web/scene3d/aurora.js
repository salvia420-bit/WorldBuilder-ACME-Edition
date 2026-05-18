// scene3d/aurora.js — Aurora borealis sky overlay.
//
// Final unshipped item from OPTICAL_EFFECTS_HANDOFF.md. The handoff
// referenced nimitz's Shadertoy "Auroras" (XtGGRt) as the visual
// target; the technique is a stack of altitude-shell intersections
// where each shell samples a fbm-style noise and contributes an
// additive emission with a green→magenta height ramp.
//
// This is a from-scratch implementation of that technique — not a
// verbatim port — so we own the GLSL and don't drag a Shadertoy
// license through master.
//
// Geometry: a camera-following inverted sphere shell (BackSide).
// Render order: 900, between the AC moon billboards (800) and the
// cloud overlay (999). depthTest off, additive blending.
//
// Polar axis: world +Y. The project's ECEF setup
// (`worldToECEFMatrix = translate(0, bottomRadius, 0)` in
// cloud_volume.js + atmosphere_pipeline.js) means ECEF Z — Earth's
// rotational axis — is just three.js +Y in world space. The aurora
// is gated to the northern half of the sky by dot(viewDir, polar).
//
// Cost: ~1–2 ms at 1080p, in line with the handoff estimate. The
// shader early-outs to alpha=0 for rays pointing south of the
// horizon, so most of the screen pays only the early branch.

import * as THREE from "three";

const VERTEX_GLSL = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vRayDir;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  // mesh.position tracks the camera each frame, so vWorldPos - mesh.position
  // is the local sphere-surface direction. Equivalently, position (the
  // raw vertex) normalized is the ray direction in world coords because
  // the sphere is unrotated.
  vRayDir = normalize(position);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

// Aurora fragment shader. Technique:
//  1. Reject rays below the horizon or away from the polar axis — those
//     fragments don't contribute and we want to early-out cheaply.
//  2. March through N "altitude shells" (parameter t along the ray).
//     Each shell sits a touch higher than the last. At each, project
//     the world-position onto the polar tangent plane and sample a 2D
//     fbm noise. Accumulate with exponential fall-off as a soft volume.
//  3. Color ramp: at low altitudes magenta/red (charged-oxygen 630 nm),
//     mid green (oxygen 557 nm), high pale violet (nitrogen). Mix by
//     normalized shell index so each ray paints a curtain top→bottom.
//  4. Modulate alpha by the angle-from-polar so curtains fade smoothly
//     around the polar cap edge; multiplied by uIntensity (URL knob).
const FRAGMENT_GLSL = /* glsl */ `
precision highp float;

varying vec3 vWorldPos;
varying vec3 vRayDir;

uniform float uTime;
uniform float uIntensity;     // 0..1 scalar, ?aurora=N override beats default
uniform vec3 uPolarAxis;      // world-space unit vector pointing to polar axis (defaults +Y)

// Hash + value noise. Same family as the terrain shader's hash21/fade
// pair (terrain.js:191-207) — kept self-contained here so aurora.js
// doesn't depend on terrain internals.
float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float fade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

float valueNoise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  float u = fade(f.x);
  float v = fade(f.y);
  return mix(mix(a, b, u), mix(c, d, u), v);
}

float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += valueNoise2D(p) * amp;
    p *= 2.07;
    amp *= 0.55;
  }
  return sum;
}

void main() {
  vec3 rd = normalize(vRayDir);

  // Cull rays not roughly pointing north + up. axisDot = 1 at zenith
  // (if polar axis is +Y), -1 at nadir. We want emission only on the
  // upper hemisphere AND biased toward the polar half — so smoothstep
  // [0.05, 0.7] gives a soft "auroral oval" edge without a hard ring.
  float axisDot = dot(rd, normalize(uPolarAxis));
  float polarMask = smoothstep(0.05, 0.7, axisDot);
  if (polarMask <= 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // Build a polar-aligned tangent frame so the noise sampling rolls
  // with the polar axis rather than the world axes. east = ray × polar
  // (any tangent will do; we just need a consistent basis).
  vec3 polar = normalize(uPolarAxis);
  vec3 east = normalize(cross(polar, vec3(0.0, 0.0, 1.0)));
  if (length(east) < 0.1) east = vec3(1.0, 0.0, 0.0);
  vec3 north = normalize(cross(east, polar));

  // March 6 shells. Each shell projects the ray onto a plane at
  // ascending "altitude" (measured in unit cosines from polar). Sample
  // the noise at the projection; accumulate with a height-based color
  // ramp and an exponential falloff so the tops of the curtains glow
  // softer than the base bands.
  const int SHELLS = 6;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < SHELLS; i++) {
    float fi = float(i);
    // shellH 0..1: 0 = lowest band (near auroral horizon), 1 = highest.
    float shellH = fi / float(SHELLS - 1);
    // Distance along the ray where this shell sits. The shell is a
    // plane perpendicular to the polar axis at \`shellAxis\` in unit
    // cosines, so t = (shellAxis - 0) / axisDot.
    float shellAxis = 0.45 + shellH * 0.45;     // shells from cos≈0.45 (~63° off polar) up to 0.9 (~26°)
    float t = shellAxis / max(axisDot, 1e-3);
    // Sample point on the shell, in tangent coords. Multiply by a few
    // because the unit-cosine space is tight; we want spatial variation
    // over multiple noise octaves.
    vec3 hit = rd * t;
    vec2 uv = vec2(dot(hit, east), dot(hit, north)) * 1.2;
    // Time drifts the noise field. Two-rate drift so curtains don't
    // appear to move rigidly — slow horizontal flow + slow vertical
    // breath.
    uv.x += uTime * 0.04;
    uv.y += uTime * 0.018 + fi * 0.13;
    float n = fbm(uv);
    // Curtain bands: low-frequency sin over the perpendicular axis
    // sharpens long vertical ribbons into the otherwise-smooth fbm.
    float curtain = 0.5 + 0.5 * sin(uv.x * 1.7 + fi * 0.7);
    float v = pow(n * curtain, 1.8);

    // Color ramp by shellH. Low = magenta/red (630 nm O charged at
    // high altitude in reality, but visually the "skirt" of the curtain
    // is the warm end); mid = green (557 nm, the dominant aurora
    // colour); high = pale violet (N2). Mix continuously so the
    // transitions blend.
    vec3 col;
    if (shellH < 0.5) {
      col = mix(vec3(0.95, 0.18, 0.55), vec3(0.10, 0.95, 0.45), shellH * 2.0);
    } else {
      col = mix(vec3(0.10, 0.95, 0.45), vec3(0.55, 0.45, 0.95), (shellH - 0.5) * 2.0);
    }

    // Exponential falloff so high shells emit softer (the tops of the
    // curtains are tenuous, not a hard mid-shell band).
    float falloff = exp(-fi * 0.25);
    acc.rgb += col * v * falloff;
    acc.a   += v * falloff * 0.6;
  }

  // Polar mask gates the whole accumulation. Square it so the edges
  // are softer than a linear taper.
  float edge = polarMask * polarMask;
  vec3 rgb = acc.rgb * edge * uIntensity;
  float alpha = clamp(acc.a * edge * uIntensity, 0.0, 1.0);

  gl_FragColor = vec4(rgb, alpha);
}
`;

/**
 * Build the aurora overlay mesh.
 *
 * @param {Object} opts
 * @param {THREE.Camera} opts.camera — the active world camera. The
 *   mesh tracks this camera's position each frame so the polar dome
 *   appears infinite (typical sky-overlay trick).
 * @param {number} [opts.intensity=1.0] — multiplier on the final
 *   emission. URL-knob `?aurora=N` overrides.
 * @param {{x:number,y:number,z:number}} [opts.polarAxis] — world-space
 *   unit vector pointing to Earth's celestial pole. Defaults to +Y to
 *   match the project's ECEF setup
 *   (`worldToECEFMatrix = translate(0, bottomRadius, 0)`).
 * @returns {{
 *   mesh: THREE.Mesh,
 *   tick: (dt: number, camera?: THREE.Camera) => void,
 *   setIntensity: (v: number) => number,
 *   setPolarAxis: (x: number, y: number, z: number) => void,
 *   dispose: () => void
 * }}
 */
export function createAurora(opts = {}) {
  const camera = opts.camera;
  if (!camera) throw new Error("createAurora: opts.camera is required");
  const intensity = Number.isFinite(opts.intensity) ? opts.intensity : 1.0;
  const polarAxis = opts.polarAxis ?? { x: 0, y: 1, z: 0 };

  const uniforms = {
    uTime: { value: 0.0 },
    uIntensity: { value: intensity },
    uPolarAxis: { value: new THREE.Vector3(polarAxis.x, polarAxis.y, polarAxis.z).normalize() },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_GLSL,
    fragmentShader: FRAGMENT_GLSL,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
  });

  // Sphere shell sized to clear the cloud overlay and any future
  // sky-scene geometry; the radius doesn't matter for the visual since
  // we early-out by view direction, but it must be large enough that
  // the back face isn't clipped by the sky camera's far plane.
  const geom = new THREE.SphereGeometry(5000, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.55);
  geom.computeBoundingSphere();
  const mesh = new THREE.Mesh(geom, material);
  mesh.name = "aurora";
  mesh.frustumCulled = false;
  mesh.renderOrder = 900;
  // Initial position so the first frame isn't centered on origin
  // before tick() runs.
  mesh.position.copy(camera.position);

  let activeCamera = camera;

  return {
    mesh,

    tick(dt = 0, camOverride = null) {
      uniforms.uTime.value += dt;
      const cam = camOverride ?? activeCamera;
      if (cam?.position) {
        mesh.position.copy(cam.position);
      }
      if (cam && cam !== activeCamera) {
        activeCamera = cam;
      }
    },

    setIntensity(v) {
      const n = Math.max(0, Math.min(4, +v));
      uniforms.uIntensity.value = n;
      return n;
    },

    setPolarAxis(x, y, z) {
      uniforms.uPolarAxis.value.set(x, y, z).normalize();
    },

    dispose() {
      geom.dispose();
      material.dispose();
    },
  };
}
