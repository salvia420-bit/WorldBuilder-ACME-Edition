// scene3d/vfx/weapon_fx_glsl.js — the GLSL shared by the two per-weapon VFX
// components (2026-10-10): `deformation.weaponFlex` (the inertial shaft bend)
// and `emissive.weaponAura` (the element glow + the blade-shine sweep).
//
// Both read the SAME per-weapon shaft frame, declared idempotently here so a
// SET carrying both components declares each uniform / varying exactly once
// (a second declaration is a GLSL redefinition error = a material that never
// compiles). THREE-free pure string surgery, node-testable.
//
// THE FRAME (object space of the weapon's single part, metres):
//   uWfxOrigin  a point on the shaft's centre line — the GRIP when the weapon is
//               held (the weapon root's origin is the hand), else the min end.
//   uWfxAxis    unit long axis, pointing at the LONGER side from the origin.
//   uWfxLen     (x) length from the origin to the + end, (y) to the - end.
//   uWfxFrame   1 = the frame is valid (single-part weapon), 0 = whole-object
//               mode (no bend, no blade mask).
//
// Positions are read from the `position` ATTRIBUTE (the rest pose), never from
// `transformed`, so the glow pattern sticks to the blade while it bends and the
// two components compose in either chain order.
//
// NO BACKTICKS anywhere in the GLSL below (they would close a JS literal).

export const WFX_FLEX_MARKER = "VFX_WFX_FLEX_BEGIN";
export const WFX_AXIAL_MARKER = "VFX_WFX_AXIAL_BEGIN";
export const WFX_AURA_MARKER = "VFX_WFX_AURA_BEGIN";

// Global-scope declarations, per stage.
export const WFX_VERT_FRAME_DECLS = Object.freeze([
  "uniform vec3 uWfxOrigin;",
  "uniform vec3 uWfxAxis;",
  "uniform vec2 uWfxLen;",
  "uniform float uWfxFrame;",
]);
export const WFX_VERT_FLEX_DECLS = Object.freeze([
  "uniform vec3 uWfxBendPos;",
  "uniform vec3 uWfxBendNeg;",
]);
export const WFX_VARYING_DECLS = Object.freeze([
  "varying float vWfxAxial;",
  "varying vec3 vWfxObj;",
]);
export const WFX_FRAG_DECLS = Object.freeze([
  "uniform float uTime;",
  "uniform vec3 uWfxAxis;",
  "uniform float uWfxFrame;",
  "uniform float uWfxGrip;",
  "uniform vec3 uWfxAuraColor;",
  "uniform float uWfxAuraKind;",
  "uniform float uWfxLevel;",
  "uniform vec4 uWfxShine;",
  "uniform float uWfxSeed;",
  "uniform float uWfxCal;",
]);

// Aura kinds (uWfxAuraKind). 0 = no glow (the shine can still run).
export const WFX_KIND = Object.freeze({
  none: 0,
  magic: 1,     // a soft rim pulse in the item's colour (Magical, poison, boosts)
  fire: 2,
  frost: 3,
  lightning: 4,
  acid: 5,
  nether: 6,
});

/** Insert each missing declaration right before `void main() {`. Idempotent. */
export function ensureDecls(src, decls) {
  if (typeof src !== "string" || src.indexOf("void main() {") === -1) return src;
  const missing = decls.filter((d) => src.indexOf(d) === -1);
  if (!missing.length) return src;
  return src.replace("void main() {", missing.join("\n") + "\nvoid main() {");
}

// Noise helpers for the fragment stage (global scope; guarded by their own
// marker so the aura can be installed once per program).
export const WFX_NOISE_GUARD = "wfxNoise3(";
export const WFX_FRAG_NOISE = [
  "float wfxHash13(vec3 p3) {",
  "  p3 = fract(p3 * 0.1031);",
  "  p3 += dot(p3, p3.zyx + 31.32);",
  "  return fract((p3.x + p3.y) * p3.z);",
  "}",
  "float wfxHash11(float p) {",
  "  p = fract(p * 0.1031);",
  "  p *= p + 33.33;",
  "  p *= p + p;",
  "  return fract(p);",
  "}",
  "float wfxNoise3(vec3 x) {",
  "  vec3 i = floor(x);",
  "  vec3 f = fract(x);",
  "  f = f * f * (3.0 - 2.0 * f);",
  "  float a = mix(wfxHash13(i), wfxHash13(i + vec3(1.0, 0.0, 0.0)), f.x);",
  "  float b = mix(wfxHash13(i + vec3(0.0, 1.0, 0.0)), wfxHash13(i + vec3(1.0, 1.0, 0.0)), f.x);",
  "  float c = mix(wfxHash13(i + vec3(0.0, 0.0, 1.0)), wfxHash13(i + vec3(1.0, 0.0, 1.0)), f.x);",
  "  float d = mix(wfxHash13(i + vec3(0.0, 1.0, 1.0)), wfxHash13(i + vec3(1.0, 1.0, 1.0)), f.x);",
  "  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);",
  "}",
  "float wfxFbm3(vec3 p) {",
  "  return 0.55 * wfxNoise3(p)",
  "       + 0.30 * wfxNoise3(p * 2.07 + vec3(17.1, 5.3, 9.7))",
  "       + 0.15 * wfxNoise3(p * 4.13 + vec3(3.7, 11.2, 1.9));",
  "}",
].join("\n");

// Vertex: the axial coordinate the fragment stage masks and sweeps along.
// Signed: 0 at the origin (grip), +1 at the + end, -1 at the - end.
export const WFX_AXIAL_VERTEX = [
  "  // ---- " + WFX_AXIAL_MARKER + " (emissive.weaponAura) ----",
  "  {",
  "    float _wfxS = dot(position - uWfxOrigin, uWfxAxis);",
  "    vWfxAxial = (_wfxS >= 0.0) ? _wfxS / max(uWfxLen.x, 1.0e-3) : _wfxS / max(uWfxLen.y, 1.0e-3);",
  "    vWfxObj = position;",
  "  }",
  "  // ---- VFX_WFX_AXIAL_END ----",
].join("\n");

// Vertex: the bend. Each side of the grip rotates about the grip by an angle
// that grows along the shaft on a cantilever profile, phi(x) = A * x(3-x)/2
// (zero slope at the grip, A at the end), A = |uWfxBend*| about the bend
// vector's direction. Two independent vectors (+ end, - end) give a C shape
// under translation and an S shape under rotation, as a real pole does. The
// normal turns with its vertex.
export const WFX_FLEX_VERTEX = [
  "  // ---- " + WFX_FLEX_MARKER + " (deformation.weaponFlex) ----",
  "  if (uWfxFrame > 0.5) {",
  "    float _fS = dot(position - uWfxOrigin, uWfxAxis);",
  "    vec3 _fR = (_fS >= 0.0) ? uWfxBendPos : uWfxBendNeg;",
  "    float _fAng = length(_fR);",
  "    if (_fAng > 1.0e-5) {",
  "      float _fL = (_fS >= 0.0) ? uWfxLen.x : uWfxLen.y;",
  "      float _fX = clamp(abs(_fS) / max(_fL, 1.0e-3), 0.0, 1.0);",
  "      float _fPhi = _fAng * _fX * (3.0 - _fX) * 0.5;",
  "      vec3 _fK = _fR / _fAng;",
  "      float _fC = cos(_fPhi);",
  "      float _fSn = sin(_fPhi);",
  "      vec3 _fT = transformed - uWfxOrigin;",
  "      transformed = uWfxOrigin + _fT * _fC + cross(_fK, _fT) * _fSn + _fK * dot(_fK, _fT) * (1.0 - _fC);",
  "#ifndef FLAT_SHADED",
  "      vec3 _fN = objectNormal * _fC + cross(_fK, objectNormal) * _fSn + _fK * dot(_fK, objectNormal) * (1.0 - _fC);",
  "      vNormal = normalize(normalMatrix * _fN);",
  "#endif",
  "    }",
  "  }",
  "  // ---- VFX_WFX_FLEX_END ----",
].join("\n");

// Fragment: the element glow + the shine sweep, folded into
// totalEmissiveRadiance at the emissivemap seam (normal, vViewPosition,
// diffuseColor and metalnessFactor are all resolved there). Intensities are in
// tone-mapper INPUT units: uWfxCal = K / exposure turns them into pre-exposure
// radiance, so a rim of 0.6 reads as a bright coloured edge rather than the
// white wash an uncalibrated emissive gives under the 5x composer exposure.
export const WFX_AURA_FRAGMENT = [
  "  // ---- " + WFX_AURA_MARKER + " (emissive.weaponAura) ----",
  "  {",
  "    vec3 _wN = normalize(normal);",
  "    vec3 _wV = normalize(vViewPosition);",
  "    float _wNdV = clamp(abs(dot(_wN, _wV)), 0.0, 1.0);",
  "    float _wRim = (1.0 - _wNdV) * (1.0 - _wNdV);",
  "    float _wS = vWfxAxial;",
  "    // held: the blade (far side) glows, the grip stays dark, the pommel / butt faintly",
  "    float _wBlade = (uWfxFrame > 0.5 && uWfxGrip > 0.5)",
  "        ? max(smoothstep(0.03, 0.25, _wS), 0.35 * smoothstep(0.15, 0.7, -_wS))",
  "        : 1.0;",
  "    vec3 _wP = vWfxObj;",
  "    vec3 _wAx = uWfxAxis;",
  "    float _wT = uTime;",
  "    float _wSd = uWfxSeed;",
  "    float _wK = uWfxAuraKind;",
  "    vec3 _wAdd = vec3(0.0);",
  "    if (_wK > 0.5 && _wK < 1.5) {",
  "      // magic: a slow rim pulse with a faint shimmer drifting up the blade (most loot: keep it gentle)",
  "      float _p = 0.6 + 0.4 * sin(_wT * 1.7 + _wSd * 6.2831);",
  "      float _n = wfxNoise3(_wP * 9.0 - _wAx * (_wT * 0.6));",
  "      _wAdd = uWfxAuraColor * _wBlade * (0.07 + _wRim * (0.6 * _p + 0.3 * _n));",
  "    } else if (_wK > 1.5 && _wK < 2.5) {",
  "      // fire: the blade glows red-hot, flames lick toward the tip, flickering, a hot core",
  "      float _n = wfxFbm3(_wP * 6.5 - _wAx * (_wT * 2.4) + vec3(_wSd * 13.0));",
  "      float _n2 = wfxNoise3(_wP * 15.0 - _wAx * (_wT * 4.5));",
  "      float _fl = 0.85 + 0.15 * wfxNoise3(vec3(_wT * 9.0, _wSd * 7.0, 0.5));",
  "      float _h = smoothstep(0.35, 0.9, _n + 0.25 * _n2 + _wRim * 0.3) * _fl;",
  "      vec3 _c = mix(vec3(0.85, 0.10, 0.0), vec3(1.0, 0.45, 0.06), _h);",
  "      _wAdd = _wBlade * (_c * (0.18 + _wRim * 0.9 + _h * 1.4) + vec3(1.0, 0.75, 0.35) * (_h * _h * _h) * 0.8);",
  "    } else if (_wK > 2.5 && _wK < 3.5) {",
  "      // frost: a pale frost coat on the steel, a cold breathing rim, ice glitter twinkling",
  "      float _b = 0.85 + 0.15 * sin(_wT * 0.9 + _wSd * 6.2831);",
  "      float _gr = dot(diffuseColor.rgb, vec3(0.3333));",
  "      diffuseColor.rgb = mix(diffuseColor.rgb, _gr * vec3(0.78, 0.92, 1.15), 0.45 * _wBlade);",
  "      float _hh = wfxHash13(floor(_wP * 36.0) + vec3(_wSd * 17.0));",
  "      float _tw = pow(max(0.0, sin(_wT * (1.7 + _hh * 2.9) + _hh * 40.0)), 14.0) * step(0.8, _hh);",
  "      _wAdd = _wBlade * (uWfxAuraColor * (0.12 + _wRim * 1.0) * _b + vec3(0.85, 0.95, 1.0) * _tw * 2.4);",
  "    } else if (_wK > 3.5 && _wK < 4.5) {",
  "      // lightning: arcs crawling over the blade, re-struck ~15 times a second, a blue charge",
  "      float _tq = floor(_wT * 15.0);",
  "      float _on = step(0.42, wfxHash11(_tq * 1.37 + _wSd * 91.0));",
  "      vec3 _j = vec3(wfxHash11(_tq + 3.1), wfxHash11(_tq + 7.7), wfxHash11(_tq + 1.9)) * 37.0;",
  "      float _r = wfxNoise3(_wP * 11.0 + _j);",
  "      float _arc = 1.0 - smoothstep(0.0, 0.08, abs(_r - 0.5));",
  "      _wAdd = _wBlade * (uWfxAuraColor * (0.1 + _wRim * 0.8) + vec3(0.75, 0.86, 1.0) * _arc * _on * 3.0);",
  "    } else if (_wK > 4.5 && _wK < 5.5) {",
  "      // acid: a sickly green sheen, blobs creeping down toward the grip",
  "      float _n = wfxNoise3(_wP * 10.0 + _wAx * (_wT * 0.45) + vec3(_wSd * 5.0));",
  "      float _blob = smoothstep(0.6, 0.78, _n);",
  "      float _b = 0.85 + 0.15 * sin(_wT * 2.3 + _wSd * 6.2831);",
  "      _wAdd = uWfxAuraColor * _wBlade * (0.13 + _wRim * 0.8 + _blob * 1.1) * _b;",
  "    } else if (_wK > 5.5) {",
  "      // nether: the steel blackens under drifting smoke, a violet rim",
  "      float _n = wfxFbm3(_wP * 5.0 - _wAx * (_wT * 0.5) + vec3(_wSd * 9.0));",
  "      float _sm = smoothstep(0.35, 0.8, _n);",
  "      diffuseColor.rgb *= 1.0 - 0.5 * _wBlade * _sm;",
  "      _wAdd = uWfxAuraColor * _wBlade * (0.08 + _wRim * 1.0 * (0.5 + 0.5 * _sm));",
  "    }",
  "    // the shine: a bright band running up the steel (x start, y duration, z strength)",
  "    float _shT = (uTime - uWfxShine.x) / max(uWfxShine.y, 1.0e-3);",
  "    if (uWfxShine.z > 0.0 && _shT > 0.0 && _shT < 1.0) {",
  "      float _pos = mix(-0.15, 1.15, _shT);",
  "      float _along = (uWfxFrame > 0.5) ? _wS : 0.5;",
  "      float _d = (_along - _pos) / 0.07;",
  "      float _band = exp(-_d * _d);",
  "      float _lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));",
  "      float _mx = max(max(diffuseColor.r, diffuseColor.g), diffuseColor.b);",
  "      float _mn = min(min(diffuseColor.r, diffuseColor.g), diffuseColor.b);",
  "      float _sat = (_mx - _mn) / max(_mx, 1.0e-3);",
  "      float _met = clamp(max(metalnessFactor, smoothstep(0.04, 0.22, _lum) * (1.0 - smoothstep(0.12, 0.45, _sat))), 0.0, 1.0);",
  "      float _face = 0.35 + 0.65 * pow(1.0 - _wNdV, 1.5);",
  "      _wAdd += vec3(1.0, 0.95, 0.85) * _band * _met * _face * uWfxShine.z;",
  "    }",
  "    totalEmissiveRadiance += _wAdd * uWfxLevel * uWfxCal;",
  "  }",
  "  // ---- VFX_WFX_AURA_END ----",
].join("\n");
