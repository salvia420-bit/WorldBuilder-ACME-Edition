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
//
// ── 2026-10-20 (improvement hunt open-frontier-perf-1) — `?fadeFunnelFix` ────
// DEFAULT ON; `off/0/false/no` escape (the pre-change funnel, exactly). This
// file is the ONE funnel all four fade owners pass through, and three r184
// turned every fade into extra work it could not see:
//   (a) TWO DRAWS PER FADED PART. three submits a material twice — BackSide,
//       then FrontSide, each after a `needsUpdate` program re-resolve — when
//       `transparent && side === DoubleSide && !forceSinglePass`
//       (three.module.js:18065 renderObject). Every entity material is
//       DoubleSide, and `applyRetailSinglePass` (materials.js, the
//       `?surfaceSinglePass` fix) only sets `forceSinglePass` at BUILD time on
//       materials that are transparent THEN — an opaque or ClipMap part a fade
//       made transparent never got it. So the in-head body, the near band, a
//       translucent creature and a Transparent ramp were all two-passed, at the
//       1070-measured ~66 us per extra pass (url-flags.md `surfaceSinglePass`).
//       Retail draws a part once (D3DPolyRender::DrawPolyInternal, one cull
//       mode, one DrawPrimitiveUP). A faded DoubleSide part now gets
//       `forceSinglePass` (the authored value comes back at the restore);
//       under `?surfaceSinglePass=off` it keeps three's two-pass, as every
//       other surface does there.
//   (b) DRAWN AT OPACITY 0. In first person every part of the local player and
//       its held items sits at opacity 0 and was still submitted. Retail skips
//       the part outright at translucency 1 (CPhysicsPart::SetTranslucency,
//       acclient.c:315497-315503 `draw_state |= 1`). While a faded part is at
//       opacity <= 0 under NormalBlending with no depth writes — the first
//       four clauses of materials.js `materialRendersNothing`, re-derived on
//       every owner write so the permanence clause is not needed — its
//       material is `visible = false`; it comes back when the opacity rises.
//       Pixel-identical: non-premultiplied NormalBlending with src.a = 0 leaves
//       dst RGBA unchanged. Picking reads `object.visible`, not the material's
//       (picking.js), so it is unchanged too. NOT applied while shadow maps can
//       be on (CSM or `?shadows=on`): `material.visible` also drops the part
//       from three's shadow pass (WebGLShadowMap renderObject), and whether an
//       invisible first-person body keeps its shadow is an owner look question.
//   (c) A STALE PROGRAM AFTER EVERY FADE. three keys `#define OPAQUE` on
//       `transparent` (three.module.js:7634) and never re-checks `transparent`
//       or `side` without a version bump. The two-pass churn used to hide this
//       while faded, but its LAST pass left the material on the FrontSide,
//       transparent program; the restore bumped nothing, so a restored opaque
//       part kept a program with neither DOUBLE_SIDED nor OPAQUE (back faces
//       lit as front faces) until some unrelated bump. Setting
//       `forceSinglePass` alone would have unmasked the other half: faded parts
//       drawn at alpha 1. So the funnel now publishes the faded state with one
//       `needsUpdate` when a fade starts (and again only if someone else bumped
//       the material mid-fade), and the authored state with one at the restore
//       — never one per ramp frame, and none when three's own alpha-test
//       setter already bumped in the same call.

import { DoubleSide, NormalBlending } from "three";
import { surfaceSinglePassEnabled } from "./materials.js";

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

let _funnelMemo = null;

/** `?fadeFunnelFix` — single pass, opacity-0 skip and program refresh (header). */
export function fadeFunnelFixEnabled(search) {
  if (search !== undefined) return _flagOn("fadeFunnelFix", search);
  if (_funnelMemo === null) _funnelMemo = _flagOn("fadeFunnelFix");
  return _funnelMemo;
}

// (b)'s gate: can a shadow pass see this part? The page's own answer once it
// has stamped `liveScene3d` (index.js: `shadowsEnabled || csmEnabled`, both
// fixed at boot); before that, the same rule from what preInit3D installed —
// `?shadows=on`, or the quality preset's `csm` without `?shadows=off`
// (ignoring wireframe only errs toward drawing). Nothing installed yet:
// unknown, so keep drawing. Node (tests) has no renderer and no shadow pass.
let _shadowMemo = null;
let _shadowsParam; // memoised `?shadows` value: the query does not change
function _shadowMapsMayBeOn() {
  if (_shadowMemo !== null) return _shadowMemo;
  if (typeof window === "undefined") return false;
  try {
    const live = window.liveScene3d;
    if (live && typeof live.csmEnabled === "boolean") {
      _shadowMemo = !!(live.shadowsEnabled || live.csmEnabled);
      return _shadowMemo;
    }
    const q = window.__quality;
    if (!q) return true;
    if (_shadowsParam === undefined) {
      _shadowsParam = new URLSearchParams(window.location?.search ?? "").get("shadows");
    }
    return _shadowsParam === "on" || (!!q.flags?.csm && _shadowsParam !== "off");
  } catch (_) {
    return true;
  }
}

/** Test seam: force (b)'s shadow gate (`null` re-derives it, `?shadows` too). */
export function __setFadeShadowMapsForTest(v) {
  _shadowMemo = v === null ? null : !!v;
  if (v === null) _shadowsParam = undefined;
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
    // ?fadeFunnelFix bookkeeping (same shape on every record): the authored
    // forceSinglePass / visible, whether the fade set either (`fsp`, `hid`),
    // and `pv`, the material version at which the faded state was last
    // published (-1: never; only the funnel fix stamps it).
    forceSinglePass: mat.forceSinglePass,
    visible: mat.visible,
    fsp: false,
    hid: false,
    pv: -1,
  };
  return true;
}

/**
 * ?fadeFunnelFix, the faded arm (module header (a), (b), (c)). `v0` is the
 * material version on entry to `syncFadeAlpha`: the owners' writes before the
 * sync (opacity, transparent, depthWrite) never bump it, so a version above
 * `v0` means three's alpha-test setter already published this call's state.
 */
function _funnelFaded(mat, a, v0) {
  // (a) one draw. Re-asserted on every sync: an in-place re-seat may have
  // copied the base's `false` back.
  let flipped = false;
  if (mat.side === DoubleSide && mat.forceSinglePass !== true && surfaceSinglePassEnabled()) {
    mat.forceSinglePass = true;
    a.fsp = true;
    flipped = true;
  }
  // (c) publish. First faded sync: the OPAQUE define goes when the authored
  // surface was opaque, and a part three was two-passing until now holds the
  // FrontSide program its last pass left. Later syncs: only when someone else
  // bumped the material since (a render may have resolved it unfaded).
  const stale = flipped || (a.pv < 0 ? !a.transparent : a.pv !== v0);
  if (stale && mat.version === v0) mat.needsUpdate = true;
  a.pv = mat.version;
  // (b) nothing to draw at opacity 0. `__lsCrystal` (vfx/lifestone_fx.js)
  // rewrites diffuseColor.a in its shader, so opacity 0 is not invisible there.
  if (
    mat.opacity <= 0 &&
    mat.blending === NormalBlending &&
    mat.depthWrite === false &&
    mat.userData.__lsCrystal === undefined &&
    !_shadowMapsMayBeOn()
  ) {
    if (mat.visible === true) {
      mat.visible = false;
      a.hid = true;
    }
  } else if (a.hid) {
    mat.visible = a.visible;
    a.hid = false;
  }
}

/**
 * Derive `mat`'s state flags from its authored record after an owner wrote its
 * opacity. Faded (opacity below the authored one): SetSurface's has_alpha arm —
 * an opaque or alpha-tested surface loses the test and blends SRCALPHA /
 * INVSRCALPHA (three NormalBlending), every faded surface is transparent with
 * no depth writes. Not faded: RestoreMaterial — the authored flags come back
 * and the record is dropped. Returns true while the material is faded. No-op
 * without a record or under `?fadeAlphaParity=off`. `?fadeFunnelFix` adds the
 * single pass, the opacity-0 skip and the program refresh (module header).
 */
export function syncFadeAlpha(mat, search) {
  if (!mat || !fadeAlphaParityEnabled(search)) return false;
  const ud = mat.userData;
  const a = ud && ud.__authoredAlpha;
  if (!a) return false;
  if (mat.opacity < a.opacity - FADE_EPS) {
    const v0 = mat.version;
    if (a.alphaTest > 0 || !a.transparent) {
      // three bumps `version` only when alphaTest crosses 0: one program swap
      // per fade, not one per ramp frame.
      if (mat.alphaTest !== 0) mat.alphaTest = 0;
      if (mat.blending !== NormalBlending) mat.blending = NormalBlending;
    }
    mat.transparent = true;
    mat.depthWrite = false;
    if (fadeFunnelFixEnabled(search)) _funnelFaded(mat, a, v0);
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
  const v0 = mat.version;
  mat.transparent = a.transparent;
  mat.depthWrite = a.depthWrite;
  // A fade only ever writes alphaTest 0 and NormalBlending. Anything else here
  // was written in place by the surface's own ladder during the fade — keep it.
  if (a.alphaTest > 0 && mat.alphaTest === 0) mat.alphaTest = a.alphaTest;
  if (a.blending !== NormalBlending && mat.blending === NormalBlending) mat.blending = a.blending;
  // ?fadeFunnelFix: undo what the faded arm set (`fsp` / `hid` are only ever
  // set by it), and (c) publish the authored state when the fade had flipped
  // `transparent` — the OPAQUE / DOUBLE_SIDED program its never-faded peers
  // use. Not when the alpha-test setter above already bumped; not for an
  // authored-transparent surface (same OPAQUE-less program; if it is
  // two-passed again three re-resolves it every draw anyway).
  if (a.fsp && mat.forceSinglePass === true) mat.forceSinglePass = a.forceSinglePass;
  if (a.hid) mat.visible = a.visible;
  if (a.pv >= 0 && !a.transparent && mat.version === v0) mat.needsUpdate = true;
  delete mat.userData.__authoredAlpha;
  return true;
}
