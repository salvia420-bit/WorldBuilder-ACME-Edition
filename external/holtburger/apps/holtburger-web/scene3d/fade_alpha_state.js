// scene3d/fade_alpha_state.js — the render state of a FADED entity part
// (entities.js fade owners: object translucency, the camera near / in-head
// fade, Transparent(20/7) hook ramps, the `?etherealGhost` hint).
//
// `?fadeAlphaParity` (DEFAULT ON; `off/0/false/no` escape). Retail fades a part
// by giving it a private CMaterial whose alpha is below 1
// (CPhysicsPart::SetTranslucency, acclient.c:315488 → CopyMaterial +
// CMaterial::SetTranslucencySimple; `has_alpha` is CMaterial+8,
// acclient.h:31753). D3DPolyRender::SetSurface (acclient.c:454529-454550) then
// draws a part whose surface was opaque or alpha-tested (ClipMap) with the
// alpha test OFF, SRCALPHA/INVSRCALPHA blending and no depth writes; surfaces
// that already blend (Alpha, InvAlpha, Additive, Translucent) keep their own
// factors. When the translucency is back at the default, RestoreMaterial drops
// the copy and the Surface bits alone decide again.
//
// The owners only multiplied `opacity`, which left two defects:
//   1. a ClipMap part kept its 100/255 (paletted) or 200/255 (DDS) alpha-test
//      ref, and three discards `diffuseColor.a < alphaTest` with `opacity`
//      already in diffuseColor.a, so the WHOLE part vanished once the fade
//      passed the ref (22% into a fade-out for a DDS clip map);
//   2. the restores re-derived `transparent` from the opacity (`opacity < 1`,
//      hook `value > 0`), so a surface that blends at opacity 1 (Alpha 0x100,
//      InvAlpha, Translucent with T=0) came back opaque after any fade — every
//      first-person round trip on the local player.
//
// The owners still compose opacity exactly as before; only the state flags
// live here. Before an owner writes, `snapshotAuthoredAlpha` records the
// authored {opacity, transparent, depthWrite, alphaTest, blending}; after it,
// `syncFadeAlpha` derives the flags from (authored, faded?). Once nothing fades
// the material it writes the authored flags back and drops the record, so the
// next fade re-reads the authored state (a texture re-seat or a weapon-fx base
// adoption may have replaced it in place meanwhile). The record lives in
// `userData` beside the owners' own snapshot keys (`__preCamFadeOpacity` …):
// plain numbers and booleans, so a clone() of a faded material carries it
// along with them.

import { NormalBlending } from "three";

// A camera fade is quantised to 1/128 (camera.js); anything below that is
// float noise from the owners' snapshot round trips.
export const FADE_EPS = 1e-4;

function _flagOn(name, search) {
  try {
    const s = search ?? (typeof window !== "undefined" ? window.location?.search : "") ?? "";
    const v = new URLSearchParams(s).get(name);
    if (v == null) return true;
    const t = String(v).toLowerCase();
    return !(t === "off" || t === "0" || t === "false" || t === "no");
  } catch (_) {
    return true;
  }
}

// The page's answer, read once (the query does not change in a session); an
// explicit `search` (tests) is always re-read.
let _memo = null;

/** `?fadeAlphaParity` — a faded part drops its alpha test and keeps its blend. */
export function fadeAlphaParityEnabled(search) {
  if (search !== undefined) return _flagOn("fadeAlphaParity", search);
  if (_memo === null) _memo = _flagOn("fadeAlphaParity");
  return _memo;
}

/**
 * Record `mat`'s authored alpha state, unless a fade already holds a record.
 * Call it BEFORE an owner writes opacity / transparent / depthWrite. Returns
 * true when it took a new record. No-op under `?fadeAlphaParity=off`.
 */
export function snapshotAuthoredAlpha(mat, search) {
  if (!mat || !fadeAlphaParityEnabled(search)) return false;
  if (!mat.userData) mat.userData = {};
  if (mat.userData.__authoredAlpha) return false;
  mat.userData.__authoredAlpha = {
    opacity: mat.opacity,
    transparent: mat.transparent,
    depthWrite: mat.depthWrite,
    alphaTest: mat.alphaTest,
    blending: mat.blending,
  };
  return true;
}

/**
 * Derive `mat`'s state flags from its authored record after an owner wrote its
 * opacity. Faded (opacity below the authored one): SetSurface's has_alpha arm —
 * an opaque or alpha-tested surface loses the test and blends SRCALPHA /
 * INVSRCALPHA (three NormalBlending), every faded surface is transparent with
 * no depth writes. Not faded: RestoreMaterial — the authored flags come back
 * and the record is dropped. Returns true while the material is faded. No-op
 * without a record or under `?fadeAlphaParity=off`.
 */
export function syncFadeAlpha(mat, search) {
  if (!mat || !fadeAlphaParityEnabled(search)) return false;
  const ud = mat.userData;
  const a = ud && ud.__authoredAlpha;
  if (!a) return false;
  if (mat.opacity < a.opacity - FADE_EPS) {
    if (a.alphaTest > 0 || !a.transparent) {
      // three bumps `version` only when alphaTest crosses 0: one program swap
      // per fade, not one per ramp frame.
      if (mat.alphaTest !== 0) mat.alphaTest = 0;
      if (mat.blending !== NormalBlending) mat.blending = NormalBlending;
    }
    mat.transparent = true;
    mat.depthWrite = false;
    return true;
  }
  restoreAuthoredAlpha(mat);
  return false;
}

/**
 * RestoreMaterial: put the authored flags back and drop the record, whatever
 * the opacity says (`syncFadeAlpha` calls it once nothing fades the material).
 * Returns true when there was a record to restore.
 */
export function restoreAuthoredAlpha(mat) {
  const a = mat && mat.userData && mat.userData.__authoredAlpha;
  if (!a) return false;
  mat.transparent = a.transparent;
  mat.depthWrite = a.depthWrite;
  // A fade only ever writes alphaTest 0 and NormalBlending. Anything else here
  // was written in place by the surface's own ladder during the fade — keep it.
  if (a.alphaTest > 0 && mat.alphaTest === 0) mat.alphaTest = a.alphaTest;
  if (a.blending !== NormalBlending && mat.blending === NormalBlending) mat.blending = a.blending;
  delete mat.userData.__authoredAlpha;
  return true;
}
