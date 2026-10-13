// scene3d/luminous_hook.js — how a Luminous(8) / LuminousPart(9) hook value
// lands on an entity material (entities.js `_applyRampValueToMaterial`).
//
// `?surfaceLumWins` (DEFAULT ON; `off/0/false/no` escape). Retail keeps a
// part's script luminosity on the part's CMaterial (CMaterial::
// SetLuminositySimple, acclient.c:360613, writes Emissive.rgb only), and
// D3DPolyRender::RenderMeshSubset (acclient.c:454688-454719) swaps
// `surface->luminosity` into that Emissive for the draw of every surface with a
// luminosity of its own, restoring it afterwards (:454828-454845). So a hook
// never reaches a luminous surface: crystals, gems and glowing trim keep their
// authored glow through a ramp to 0, and a 0.3 surface is not pushed to 1.
// The three Surface ladders stamp the authored value as
// `userData.__surfaceLuminosity` (materials.js applyFloatLumDiffuse and
// `_materialFromFlags`, entities.js `_applyPalettedSurfaceRenderState`); three's
// Material.copy JSON-copies userData, so every per-entity clone carries it.
//
// `?lumHookTexel` (DEFAULT ON; `off/0/false/no` escape). Retail's fixed-function
// stage draws `texture × saturate(emissive + lighting)`, so a hook value lights
// the texel. three ADDS emissive and modulates it by the texture only through
// `emissiveMap`, which a surface with no luminosity of its own has not got: a
// ramp to 1 washed the part flat white. While the value is > 0 the material's
// own `map` becomes its emissiveMap (the variant luminous surfaces already
// use); at 0 the authored emissiveMap comes back. The authored one is kept in a
// WeakMap, never on the material (userData is copied into clones, and new
// material properties fork V8 shapes — see async_link_guard.js).

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

// The page's own answers, read once (the query does not change in a session);
// an explicit `search` (tests) is always re-read.
let _winsMemo = null;
let _texelMemo = null;

/** `?surfaceLumWins` — a surface's own luminosity beats a Luminous hook. */
export function surfaceLumWinsEnabled(search) {
  if (search !== undefined) return _flagOn("surfaceLumWins", search);
  if (_winsMemo === null) _winsMemo = _flagOn("surfaceLumWins");
  return _winsMemo;
}

/** `?lumHookTexel` — a Luminous hook value lights the texel, not flat white. */
export function lumHookTexelEnabled(search) {
  if (search !== undefined) return _flagOn("lumHookTexel", search);
  if (_texelMemo === null) _texelMemo = _flagOn("lumHookTexel");
  return _texelMemo;
}

// material -> the emissiveMap it had before a hook value first attached `map`.
const _authoredEmissiveMap = new WeakMap();

/**
 * Keep `mat.emissiveMap` in step with a Luminous hook value: `map` while
 * `value > 0`, the authored emissiveMap again at `value <= 0`. Bumps
 * `needsUpdate` only when the emissiveMap appears or disappears (the
 * USE_EMISSIVEMAP define), never per ramp frame. Returns true when it changed
 * the material. No-op under `?lumHookTexel=off`. `search` is for tests.
 */
export function syncLuminousHookTexel(mat, value, search) {
  if (!mat || !lumHookTexelEnabled(search)) return false;
  if (value > 0 && mat.map) {
    if (mat.emissiveMap === mat.map) return false;
    if (!_authoredEmissiveMap.has(mat)) _authoredEmissiveMap.set(mat, mat.emissiveMap ?? null);
    const had = !!mat.emissiveMap;
    mat.emissiveMap = mat.map;
    if (!had) mat.needsUpdate = true;
    return true;
  }
  if (value <= 0 && _authoredEmissiveMap.has(mat)) {
    const authored = _authoredEmissiveMap.get(mat);
    _authoredEmissiveMap.delete(mat);
    if (mat.emissiveMap === authored) return false;
    const had = !!mat.emissiveMap;
    mat.emissiveMap = authored;
    if (had !== !!authored) mat.needsUpdate = true;
    return true;
  }
  return false;
}
