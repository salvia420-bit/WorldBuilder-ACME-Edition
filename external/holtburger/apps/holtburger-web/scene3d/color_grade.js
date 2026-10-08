// scene3d/color_grade.js — display-referred colour grade, after the tone curve.
//
// `?grade` (2026-10-07, DEFAULT ON; `?grade=off` escape). Owner-directed look
// pass on the GTX 1070. The tone curve (tone_curve.js, Neutral by default) only
// maps radiance to the screen; the LOOK — how much contrast the frame has, how
// warm noon is, how blue and readable night is — is this effect's job, so it
// can be tuned without touching a single light or material.
//
// Placement: inside the final EffectPass, AFTER ToneMapping and BEFORE
// Dithering. pmndrs merges every effect of a pass into ONE fragment shader, so
// this costs a handful of ALU per pixel and no extra pass, render target or
// texture fetch.
//
// Maths (all in sRGB-encoded "display" space, where the eye judges contrast):
//   1. white balance  — linear per-channel multiply (warmth / moonlight tint)
//   2. lift/gain      — ASC-CDL style: g' = g * gain + lift * (1 - g)
//   3. gamma          — per-channel mid power
//   4. contrast       — S-free linear contrast about a pivot
//   5. saturation + vibrance — vibrance boosts low-chroma pixels more than
//      already-vivid ones (so painted sky and grass lift without the cloaks
//      and spell effects turning neon)
//   6. tint — display-space multiply AFTER saturation. The night moonlight
//      cast lives here: a white-balance shift before a desaturation is
//      mostly averaged straight back out by it (measured on the 1070 — the
//      first night grade barely moved the olive ground).
// Day and night are two parameter sets blended every frame by the same night
// fraction the sky, moons and ground dim use (night_ramp.js), so the grade
// follows the clock with no new state.
//
// Live tuning: `window.__grade` — `.day` / `.night` param objects (mutate, the
// next frame picks them up), `.off = true` bypasses, `.state()` reports.

import { BlendFunction, Effect } from "postprocessing";
import * as THREE from "three";
import { nightFactorFromAuthoredPitch } from "./night_ramp.js";

/** `?grade` — default ON; `=off`/`0`/`false` disables. */
export function colorGradeEnabled(search) {
  try {
    const s = search ?? (typeof window !== "undefined" ? window.location?.search : "") ?? "";
    const v = new URLSearchParams(s).get("grade");
    if (v == null) return true;
    const lv = String(v).toLowerCase();
    return !(lv === "off" || lv === "0" || lv === "false");
  } catch (_) {
    return true;
  }
}

// Shipped looks. Tuned live on the 1070 (Holtburg, quality=ultra, Neutral).
export const GRADE_DAY = Object.freeze({
  wb: [1.03, 1.0, 0.96],
  tint: [1.0, 1.0, 1.0],
  lift: [0.0, 0.0, 0.01],
  gain: [1.0, 1.0, 1.0],
  gamma: [1.0, 1.0, 1.0],
  contrast: 1.08,
  pivot: 0.42,
  saturation: 1.04,
  vibrance: 0.18,
});
export const GRADE_NIGHT = Object.freeze({
  wb: [0.94, 0.97, 1.06],
  tint: [0.76, 0.90, 1.20],
  lift: [0.004, 0.008, 0.022],
  gain: [1.06, 1.06, 1.06],
  gamma: [1.0, 1.0, 1.0],
  contrast: 1.08,
  pivot: 0.25,
  saturation: 0.55,
  vibrance: 0.0,
});

const GRADE_FRAG = /* glsl */ `
uniform vec3 uWB;
uniform vec3 uTint;
uniform vec3 uLift;
uniform vec3 uGain;
uniform vec3 uGammaInv;
uniform float uContrast;
uniform float uPivot;
uniform float uSat;
uniform float uVib;
uniform float uMix;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 lin = max(inputColor.rgb, vec3(0.0)) * uWB;
  vec3 g = pow(lin, vec3(1.0 / 2.2));
  g = g * uGain + uLift * (1.0 - g);
  g = pow(max(g, vec3(0.0)), uGammaInv);
  g = (g - uPivot) * uContrast + uPivot;
  float luma = dot(g, vec3(0.2126, 0.7152, 0.0722));
  float chroma = max(max(g.r, g.g), g.b) - min(min(g.r, g.g), g.b);
  float s = uSat * (1.0 + uVib * (1.0 - clamp(chroma * 2.0, 0.0, 1.0)));
  g = mix(vec3(luma), g, s) * uTint;
  vec3 graded = pow(clamp(g, 0.0, 1.0), vec3(2.2));
  outputColor = vec4(mix(inputColor.rgb, graded, uMix), inputColor.a);
}
`;

const lerp = (a, b, t) => a + (b - a) * t;

/** Blend two grade param sets at night fraction `t` into plain numbers. */
export function blendGrade(day, night, t) {
  const k = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const m3 = (a, b) => [0, 1, 2].map((i) => lerp(a[i], b[i], k));
  const one = [1, 1, 1];
  return {
    wb: m3(day.wb, night.wb),
    tint: m3(day.tint ?? one, night.tint ?? one),
    lift: m3(day.lift, night.lift),
    gain: m3(day.gain, night.gain),
    gamma: m3(day.gamma, night.gamma),
    contrast: lerp(day.contrast, night.contrast, k),
    pivot: lerp(day.pivot, night.pivot, k),
    saturation: lerp(day.saturation, night.saturation, k),
    vibrance: lerp(day.vibrance, night.vibrance, k),
  };
}

export class ColorGradeEffect extends Effect {
  constructor({ day = GRADE_DAY, night = GRADE_NIGHT, nightSource = null } = {}) {
    super("ColorGradeEffect", GRADE_FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map([
        ["uWB", new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ["uTint", new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ["uLift", new THREE.Uniform(new THREE.Vector3(0, 0, 0))],
        ["uGain", new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ["uGammaInv", new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ["uContrast", new THREE.Uniform(1)],
        ["uPivot", new THREE.Uniform(0.42)],
        ["uSat", new THREE.Uniform(1)],
        ["uVib", new THREE.Uniform(0)],
        ["uMix", new THREE.Uniform(1)],
      ]),
    });
    // Mutable copies: `__grade.day.contrast = 1.1` takes effect next frame.
    this.day = structuredClone({ ...day });
    this.night = structuredClone({ ...night });
    this.off = false;
    // Night fraction source; default reads the sky controller's authored pitch
    // through the same remap the sky / moons / ground dim use.
    this._nightSource = nightSource;
    this._night = null;
  }

  _nightNow() {
    try {
      if (typeof this._nightSource === "function") return this._nightSource();
      const st = globalThis.window?.liveScene3d?.skyLightingController?._lastState;
      if (!st || !Number.isFinite(st.dirPitch)) return 0;
      return nightFactorFromAuthoredPitch(st.dirPitch);
    } catch (_) {
      return 0;
    }
  }

  update(_renderer, _inputBuffer, deltaTime) {
    const target = this._nightNow();
    // Light smoothing so a time-pin jump or the dawn ramp never pops the grade.
    if (this._night == null) this._night = target;
    else {
      const a = 1 - Math.exp(-Math.max(0, deltaTime || 0) * 4);
      this._night += (target - this._night) * a;
    }
    const p = blendGrade(this.day, this.night, this._night);
    const u = this.uniforms;
    u.get("uWB").value.fromArray(p.wb);
    u.get("uTint").value.fromArray(p.tint);
    u.get("uLift").value.fromArray(p.lift);
    u.get("uGain").value.fromArray(p.gain);
    u.get("uGammaInv").value.set(1 / Math.max(0.05, p.gamma[0]), 1 / Math.max(0.05, p.gamma[1]), 1 / Math.max(0.05, p.gamma[2]));
    u.get("uContrast").value = p.contrast;
    u.get("uPivot").value = p.pivot;
    u.get("uSat").value = p.saturation;
    u.get("uVib").value = p.vibrance;
    u.get("uMix").value = this.off ? 0 : 1;
  }

  state() {
    return { off: this.off, night: this._night, day: this.day, nightParams: this.night };
  }
}

/** The effect, or null when `?grade=off` (dropped by the caller's filter). */
export function createColorGradeEffect(opts = {}) {
  const on = typeof opts.enabled === "boolean" ? opts.enabled : colorGradeEnabled();
  if (!on) return null;
  return new ColorGradeEffect(opts);
}

/** `window.__grade` live-tuning handle. No-op without a window or effect. */
export function installColorGradeHandle(effect) {
  if (typeof window === "undefined" || !effect) return null;
  const handle = {
    get day() { return effect.day; },
    set day(v) { effect.day = { ...effect.day, ...v }; },
    get night() { return effect.night; },
    set night(v) { effect.night = { ...effect.night, ...v }; },
    get off() { return effect.off; },
    set off(v) { effect.off = !!v; },
    reset() { effect.day = structuredClone({ ...GRADE_DAY }); effect.night = structuredClone({ ...GRADE_NIGHT }); },
    state: () => effect.state(),
    effect,
  };
  window.__grade = handle;
  return handle;
}
