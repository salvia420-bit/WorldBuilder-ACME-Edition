// scene3d/vfx/heat_haze_glsl.js — the heat-shimmer / mirage fragment GLSL,
// split out of heat_haze_effect.js (2026-10-23) so the browser smoke
// (harness/glsl_smoke/heat_haze_smoke.mjs) can compile the SHIPPED text without
// importing the app (materials.js pulls in the texture stack). No imports.
// The header of heat_haze_effect.js documents the terms and the traps.

// No backticks anywhere in this GLSL, including comments (a stray backtick
// closes the JS template literal — it has bitten terrain.js).
export const HEAT_HAZE_FRAG = /* glsl */ `
uniform float uTime;          // VFX_GLOBALS.uTime, bound BY IDENTITY (plan 5.6)
uniform vec2  uHeatScreen;    // projected heat centre, uv
uniform float uHeatScreenRadius; // mask radius, uv (v units; x corrected by aspect)
uniform float uHeatRadius;    // heat radius in METRES; 0 => no volcanic LB resident
uniform float uHeatNear;      // depth band, metres
uniform float uHeatFar;
uniform float uHeatFeather;
uniform float uStrength;      // amplitude multiplier (?terrainHazeStrength x tier)
uniform float uFreq;
uniform float uSpeed;
uniform float uLogDepthFC;    // 2.0 / log2(cameraFar + 1.0)
// 2026-10-23 desert arm (terrain_desert_haze.js). uGround is the ground
// shimmer amplitude in uv units (0 = off); it ramps in from uGroundNear to
// uGroundFull and fades out by uGroundFar. uMirage is the mirage lift in uv
// units (0 = off), ramping in from uMirageStart over uMirageFeather.
uniform float uGround;
uniform float uGroundNear;
uniform float uGroundFull;
uniform float uGroundFar;
uniform float uMirage;
uniform float uMirageStart;
uniform float uMirageFeather;

// Eye-forward distance in metres for this pixel, or -1.0 for sky / cleared far.
// Reads the RAW depth texel on purpose -- see the trap-T4 note in the header.
float hbHeatDistanceM(const in vec2 uv) {
  float d = texture2D(depthBuffer, uv).r;
#ifdef USE_REVERSED_DEPTH_BUFFER
  // ?reversedZ=on: raw reversed depth (1 near, 0 far / cleared); pmndrs keeps
  // cameraNear / cameraFar on every effect material.
  if (d <= 0.0) return -1.0;
  return (cameraNear * cameraFar) / (d * (cameraFar - cameraNear) + cameraNear);
#else
  if (d >= 0.9999) return -1.0;
  return exp2(2.0 * d / uLogDepthFC) - 1.0;
#endif
}

void mainUv(inout vec2 uv) {
  // STRICT NO-OP. The disc is off when uHeatRadius is 0 (no volcanic landblock
  // resident) or uStrength is 0; the ground and mirage terms are off at 0 (no
  // desert around the player, night, rain) -- so the whole body costs a few
  // compares on those frames.
  bool disc = uHeatRadius > 0.0 && uStrength > 0.0 && uHeatScreenRadius > 0.0;
  if (!disc && uGround <= 0.0 && uMirage <= 0.0) return;

  float dist = hbHeatDistanceM(uv);
  if (dist < 0.0) return;                  // sky: never warp

  float a = 0.0;
  if (disc) {
    // Screen mask: a disc around the projected heat centre, circular in SCREEN
    // space (x scaled by the built-in aspect uniform, not by texel size).
    vec2 d2 = vec2((uv.x - uHeatScreen.x) * aspect, uv.y - uHeatScreen.y);
    float m = 1.0 - smoothstep(uHeatScreenRadius * 0.35, uHeatScreenRadius, length(d2));
    // Depth gate: only geometry inside the heat volume's depth band shimmers, so
    // a tree between the eye and the lava field stays crisp.
    m *= smoothstep(uHeatNear, uHeatNear + uHeatFeather, dist);
    m *= 1.0 - smoothstep(max(uHeatFar - uHeatFeather, uHeatNear + uHeatFeather), uHeatFar, dist);
    a = uStrength * max(m, 0.0);
  }
  if (uGround > 0.0) {
    // Ground shimmer: the hot air between the eye and the far ground thickens
    // with distance, so the warp grows with depth (crisp underfoot, wobbling
    // dunes, a swimming horizon) and fades where the fog has the frame.
    float g = smoothstep(uGroundNear, max(uGroundFull, uGroundNear + 1.0), dist);
    g *= 1.0 - smoothstep(uGroundFar * 0.7, max(uGroundFar, 1.0), dist);
    a = max(a, uGround * g);
  }

  if (a > 0.0) {
    // Rising columnar shimmer: two incommensurate vertical sines (so the
    // pattern never reads as one clean wave) plus a weaker horizontal one.
    // Deterministic in (uv, uTime) alone.
    float w  = sin(uv.y * uFreq + uTime * uSpeed) * 0.6
             + sin(uv.y * uFreq * 1.87 - uTime * uSpeed * 0.73) * 0.4;
    float w2 = sin(uv.x * uFreq * 0.61 + uTime * uSpeed * 0.41);
    uv.x += w * a;
    uv.y += w2 * a * 0.35;
  }

  if (uMirage > 0.0) {
    // Inferior mirage: light grazing the hot ground bends up, so far ground
    // shows the sky just above it. Sampling from ABOVE (uv.y up) puts a thin
    // band of sky on the far ground under every crest, in patches that drift
    // along the horizon (two slow incommensurate sines in x), and the band
    // thickens with distance. A pixel whose lifted sample lands on the sky
    // shows the sky -- that is the mirage.
    float r = smoothstep(uMirageStart, uMirageStart + max(uMirageFeather, 1.0), dist);
    // Only ground that RECEDES up the screen lifts (2026-10-23, owner: building
    // tops were eaten from outside a town): flat or rising ground is farther
    // than the pixel 2 px below it; a wall or a roof face is not. The sky below
    // a pixel (a crest seen from above) counts as receding.
    if (r > 0.0) {
      float dBelow = hbHeatDistanceM(uv - vec2(0.0, 2.0 * texelSize.y));
      r *= dBelow < 0.0 ? 1.0 : smoothstep(1.002, 1.02, dist / max(dBelow, 0.01));
    }
    if (r > 0.0) {
      float n = 0.5 + 0.5 * sin(uv.x * uFreq * 1.3 + uTime * uSpeed * 0.6)
                          * sin(uv.x * uFreq * 0.37 - uTime * uSpeed * 0.23 + 1.7);
      uv.y += uMirage * r * (0.3 + 0.7 * n);
    }
  }
}
`;
