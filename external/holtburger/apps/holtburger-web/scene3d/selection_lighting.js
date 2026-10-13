// scene3d/selection_lighting.js — retail's on-object click feedback: the object
// a mouse find lands on flashes fullbright / dim twice (lighting-materials-6).
//
// `?selectionFlash=on` (DEFAULT OFF, exact `=on` opt-in: a new look, pending the
// 1070 eye-test). Off, nothing here is constructed and picking.js never calls in.
//
// Retail (acclient.c):
//   UIElement_SmartBoxWrapper::RecvNotice_SmartBoxObjectFound (:275631) — a
//     find of any object other than the one still blinking restores that one
//     (`m_cFlipCount` non-zero → CPhysicsObj::RestoreLighting). A find whose
//     m_SearchReason is sr_Select (2) or above then SetLighting(0.99, 1.0) on the
//     found object, m_cFlipCount = 1, m_timeNextFlip = cur_time + 0.2, and —
//     unless the reason is sr_Drop (5) or sr_TargetedUse (7) — SetSelectedObject.
//   UIElement_SmartBoxWrapper::Global_Loop (:275388) — once cur_time reaches
//     m_timeNextFlip: ++m_cFlipCount; below 5 re-arm +0.2 s with odd = HIGH and
//     even = LOW; at 5 the count resets and the mode is restore. A select is
//     therefore HIGH → LOW → HIGH → LOW → restore, 0.2 s apart (0.8 s).
//   UIElement_SmartBoxWrapper::ApplyLighting (:275174) — LM_LOW_LIGHTING =
//     SetLighting(0.0, 0.35), LM_HIGH_LIGHTING = SetLighting(0.99, 1.0),
//     LM_RESTORE_LIGHTING = RestoreLighting.
//   CPhysicsPart::SetLighting (:315325) gives the part a private material copy
//     and writes CMaterial::SetLuminositySimple (Emissive) and SetDiffuseSimple
//     (Diffuse, :360627). The fixed-function stage draws
//     texel × saturate(emissive + lighting), so 0.99 is a fullbright texel and
//     LOW is the lit texel at 35 %.
//
// SearchReason (acclient.h `UIElement_SmartBoxWrapper::SearchReason`) as the
// mouse handlers set it: a left press → sr_Select, or sr_TargetedUse while a
// target mode is armed, and the double-click → sr_Use (MouseDown :275444); a
// right release → sr_Examine (MouseUp :275483); an inventory drop → sr_Drop
// (HandleDropRelease :275263); a world drag → sr_Drag. Keyboard target cycling
// and scripted selection run no find, so they never blink — picking.js is the
// only caller, never `setSelectedTarget` / `selectionChanged`.
//
// three: HIGH draws `color 0` and `emissive 0.99` with the part's own `map` as
// its emissiveMap — 0.99 × texel whatever the PBR lights do (retail's saturate
// clamp, without bloom overshoot). LOW draws `color 0.35 × authored` (linear,
// the convention of the Diffuse hook and the Surface diffuse tint) and no
// emissive. The emissiveMap goes on at the first HIGH and stays until the
// restore, so the USE_EMISSIVEMAP define flips twice per flash, not four times.
// Surfaces with a luminosity of their own are skipped: retail draws them with
// `surface->luminosity` swapped into Emissive (D3DPolyRender::RenderMeshSubset
// :454688), so HIGH never reaches them. The authored values live in a WeakMap,
// never on the material (three JSON-copies userData into clones, and a Texture
// there would be serialised).
//
// After WebAC packages/renderer/src/world/SelectionLighting.ts, AGPL-3.0.

/** `UIElement_SmartBoxWrapper::SearchReason` (acclient.h). */
export const SEARCH_REASON = Object.freeze({
  None: 0,
  MouseOver: 1,
  Select: 2,
  Examine: 3,
  Use: 4,
  Drop: 5,
  Drag: 6,
  TargetedUse: 7,
});

/** `LightingMode` (acclient.h): what `ApplyLighting` switches on. */
export const LIGHTING_MODE = Object.freeze({ RESTORE: 0, LOW: 1, HIGH: 2 });

/** SetLighting(luminosity, diffuse) pairs from `ApplyLighting`. */
export const LIGHT_LOW = Object.freeze({ luminosity: 0.0, diffuse: 0.35 });
export const LIGHT_HIGH = Object.freeze({ luminosity: 0.99, diffuse: 1.0 });
/** `Global_Loop`'s re-arm, seconds. */
export const SELECTION_FLIP_TIME = 0.2;
/** `Global_Loop`: the count at which the blink ends (`count < 5` re-arms). */
export const SELECTION_FLIP_END = 5;
// A re-armed deadline is `now + 0.2` in floating point (0.4 + 0.2 =
// 0.6000000000000001); a frame landing on the nominal step still flips.
const FLIP_EPS = 1e-6;

let _memo = null;

/**
 * `?selectionFlash=on` — exact opt-in. Read once per page (the query does not
 * change in a session); an explicit `search` (tests) is always re-read.
 */
export function selectionFlashEnabled(search) {
  const read = (s) => {
    try {
      const q = s ?? (typeof window !== "undefined" ? window.location?.search : "") ?? "";
      return new URLSearchParams(q).get("selectionFlash") === "on";
    } catch (_) {
      return false;
    }
  };
  if (search !== undefined) return read(search);
  if (_memo === null) _memo = read();
  return _memo;
}

/** Tests: pin (true/false) or re-read (null) the page answer. */
export function _setSelectionFlashEnabledForTest(on) {
  _memo = on == null ? null : !!on;
}

/** Seconds on the same clock for the find and the per-frame tick. */
export function selectionFlashNow() {
  return ((typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now()) / 1000;
}

/** RecvNotice_SmartBoxObjectFound's `m_SearchReason >= 2` gate. */
export function searchReasonLights(reason) {
  return reason >= SEARCH_REASON.Select;
}

/** RecvNotice_SmartBoxObjectFound: Drop and TargetedUse light but do not select. */
export function searchReasonSelects(reason) {
  return searchReasonLights(reason) &&
    reason !== SEARCH_REASON.Drop && reason !== SEARCH_REASON.TargetedUse;
}

/**
 * One due `Global_Loop` step for a non-zero flip count: `++count`; below 5 the
 * timer re-arms, odd = HIGH / even = LOW; at 5 the count resets and restores.
 */
export function selectionFlipStep(flipCount) {
  const next = flipCount + 1;
  if (next < SELECTION_FLIP_END) {
    return { flipCount: next, mode: (next & 1) !== 0 ? LIGHTING_MODE.HIGH : LIGHTING_MODE.LOW, rearm: true };
  }
  return { flipCount: 0, mode: LIGHTING_MODE.RESTORE, rearm: false };
}

/**
 * The wrapper's flash fields (`m_iidSelectedObject` as far as the blink goes,
 * `m_cFlipCount`, `m_timeNextFlip`) and the two entry points that touch them.
 * `apply(guid, mode)` is `ApplyLighting`'s target; times are seconds.
 */
export class SelectionLighting {
  constructor(apply) {
    this._apply = typeof apply === "function" ? apply : () => {};
    this.litGuid = 0;
    this.flipCount = 0;
    this.timeNextFlip = 0;
  }

  /** A blink is running. */
  get active() {
    return this.flipCount !== 0;
  }

  /**
   * `RecvNotice_SmartBoxObjectFound(guid)` for a find made with `reason`
   * (guid 0 = the find hit nothing). Returns true when retail would also
   * `SetSelectedObject` — the caller keeps its own selection bookkeeping.
   */
  objectFound(guid, reason, now) {
    const g = (guid >>> 0) || 0;
    if (this.flipCount !== 0 && this.litGuid !== g) {
      const old = this.litGuid;
      this.flipCount = 0;
      this.litGuid = 0;
      this._apply(old, LIGHTING_MODE.RESTORE);
    }
    if (g === 0 || !searchReasonLights(reason)) return false;
    this.litGuid = g;
    this.flipCount = 1;
    this.timeNextFlip = now + SELECTION_FLIP_TIME;
    this._apply(g, LIGHTING_MODE.HIGH);
    return searchReasonSelects(reason);
  }

  /** `Global_Loop`'s flip bookkeeping — call once per frame. */
  tick(now) {
    if (this.flipCount === 0 || now + FLIP_EPS < this.timeNextFlip) return;
    const step = selectionFlipStep(this.flipCount);
    const g = this.litGuid;
    this.flipCount = step.flipCount;
    if (step.rearm) this.timeNextFlip = now + SELECTION_FLIP_TIME;
    else this.litGuid = 0;
    this._apply(g, step.mode);
  }

  /** Restore whatever is blinking and go idle. */
  clear() {
    if (this.flipCount === 0) return;
    const g = this.litGuid;
    this.flipCount = 0;
    this.litGuid = 0;
    this._apply(g, LIGHTING_MODE.RESTORE);
  }
}

// --- CPhysicsPart::SetLighting / RestoreLighting on a three material --------

// material -> its colour / emissive / emissiveIntensity / emissiveMap before
// the flash first wrote it.
const _authored = new WeakMap();

/**
 * A lit material (MeshStandard / Lambert: `color` + `emissive`) without a
 * luminosity of its own. Unlit MeshBasic (wireframe mode) and luminous
 * surfaces are left alone.
 */
export function selectionLightable(mat) {
  return !!(mat && mat.color && mat.emissive && !(mat.userData?.__surfaceLuminosity > 0));
}

/** The material is carrying a flash level right now. */
export function selectionLit(mat) {
  return !!mat && _authored.has(mat);
}

/**
 * Write a flash level (HIGH / LOW) onto `mat`, recording its authored values
 * on the first write; RESTORE puts them back. Bumps `needsUpdate` only when the
 * emissiveMap appears or disappears. Returns true when `mat` took the level.
 */
export function applySelectionLighting(mat, mode) {
  if (mode === LIGHTING_MODE.RESTORE) return restoreSelectionLighting(mat);
  if (!selectionLightable(mat)) return false;
  let a = _authored.get(mat);
  if (!a) {
    a = {
      cr: mat.color.r, cg: mat.color.g, cb: mat.color.b,
      er: mat.emissive.r, eg: mat.emissive.g, eb: mat.emissive.b,
      ei: mat.emissiveIntensity,
      emap: mat.emissiveMap ?? null,
    };
    _authored.set(mat, a);
  }
  if (mode === LIGHTING_MODE.HIGH) {
    const lum = LIGHT_HIGH.luminosity;
    mat.color.setRGB(0, 0, 0);
    if (mat.map) {
      // 0.99 × texel: the part's own texture modulates the emissive.
      mat.emissive.setRGB(lum, lum, lum);
      if (mat.emissiveMap !== mat.map) {
        const had = !!mat.emissiveMap;
        mat.emissiveMap = mat.map;
        if (!had) mat.needsUpdate = true;
      }
    } else {
      // An untextured surface: its colour IS the texel.
      mat.emissive.setRGB(a.cr * lum, a.cg * lum, a.cb * lum);
    }
    mat.emissiveIntensity = 1;
  } else {
    const d = LIGHT_LOW.diffuse;
    mat.color.setRGB(a.cr * d, a.cg * d, a.cb * d);
    mat.emissive.setRGB(0, 0, 0);
  }
  return true;
}

/**
 * RestoreLighting: the authored colour, emissive, emissiveIntensity and
 * emissiveMap come back and the record is dropped. Returns true when there was
 * a record.
 */
export function restoreSelectionLighting(mat) {
  const a = mat ? _authored.get(mat) : undefined;
  if (!a) return false;
  _authored.delete(mat);
  if (mat.color) mat.color.setRGB(a.cr, a.cg, a.cb);
  if (mat.emissive) mat.emissive.setRGB(a.er, a.eg, a.eb);
  mat.emissiveIntensity = a.ei;
  if (mat.emissiveMap !== a.emap) {
    const had = !!mat.emissiveMap;
    mat.emissiveMap = a.emap;
    if (had !== !!a.emap) mat.needsUpdate = true;
  }
  return true;
}
