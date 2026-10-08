// scene3d/particles/additive_fog.js — additive particles vs the distance fog
// (2026-10-07, `?additiveFogBlack`, DEFAULT ON).
//
// THE BUG. Particle materials are three.js materials with `fog: true`
// (MeshBasicMaterial from materials.js `getParticleUnlit`, MeshStandard under
// `?particleUnlit=off`). three's fog_fragment ends with
//   gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
// For an ADDITIVE draw (THREE.AdditiveBlending = SRC_ALPHA/ONE) that writes
// `(1 - f) * rgb + f * fogColor` into the ADD term, i.e. it adds
// `f * fogColor * srcAlpha` across the whole quad, black texels included. A
// fire, spark, portal or lifestone glow inside the fog band (loop.js
// `computeFogBand`, ~475 -> 1003 m by day, much nearer in foggy DayGroups)
// becomes a pale fog-coloured rectangle with straight edges. Found while fixing
// the sky wedges (sky_glow.js, point 2 of its WHY note).
//
// RETAIL (acclient.c, 2013 PDB decomp). `D3DPolyRender::SetSurface`
// (acclient.c:454385) ends its blend setup with
//     if ( !RenderDeviceD3D::GetFFFogEnable(v4) || Render::curr_surface_type & 0x10000 )
//       RenderDeviceD3D::SetFFFogAlphaDisabled(v4, 1);       // :454551-454553
//     else
//       RenderDeviceD3D::SetFFFogAlphaDisabled(v4, 0);       // :454558
// and `SetFFFogAlphaDisabled` (:460295) is ONE device call:
//     m_pDirect3DDevice->vfptr[19].QueryInterface(dev, 28, _bValue == 0)
// `vfptr[19].QueryInterface` is IDirect3DDevice9 vtable slot 57 =
// SetRenderState (cross-check: `vfptr[17].Release` = slot 53 = LightEnable in
// SetFFLightEnable :460372), and render state 28 is D3DRS_FOGENABLE (the same
// helper writes 34/36/37 = FOGCOLOR/FOGSTART/FOGEND in SetFFFogProperties
// :460308). So EVERY surface with the Additive bit (0x10000) is drawn with
// fixed-function fog DISABLED: the additive term is never pulled toward the fog
// colour, it is simply not fogged. It is a fog SKIP, not a fog-colour swap to
// black. Particles take exactly this path: CPhysicsPart::Draw (:314587) ->
// RenderDeviceD3D::DrawMeshInternal (:456960) -> D3DPolyRender::DrawMesh
// (:455294 -> :455154) -> SetSurface (:454676). The A10-M3b note in
// materials.js `applySurfaceRenderState` read the same lines independently
// (its `?surfaceParityV2` arm covers NON-particle surfaces only, default off).
//
// THE FIX. Applied by particle_manager.js to every ADDITIVE particle material
// (the per-slot clones, the instanced `particle-inst-*` additive buckets, the
// pooled clones). Normal-blended (alpha) particles keep the stock fog toward
// fogColor, which is correct for them. Sky-glow materials (sky_glow.js) are
// already unfogged and are never touched.
//   retail (DEFAULT)  `fog = false`: no fog term at all, exactly D3DRS_FOGENABLE
//                     = FALSE. No shader patch and no program key: it is three's
//                     stock no-fog program, shared by every additive particle.
//   fade              keep fog, but the fog chunk scales the colour toward ZERO,
//                     `gl_FragColor.rgb *= ( 1.0 - fogFactor )` (same fogFactor
//                     as three's chunk, linear and exp2), so distant glows fade
//                     OUT. NOT retail; kept for the GPU-box eye test. ONE
//                     constant program key for every fade material.
//   off               stock three (mix toward fogColor): the pre-fix pale sheets.
// Light count, blending, depth state and per-particle opacity are unchanged in
// every mode.
//
// RESIDUAL. `material.fog` only exempts from `scene.fog` (the linear THREE.Fog
// the default path keeps via `?fogLerp`/`terrainFog`, or wireframe's FogExp2).
// The Bruneton AerialPerspective post pass is screen-space and fogs whatever
// the depth buffer holds behind the (depth-write-off) particle; that is a
// per-pixel transmittance/inscatter, not a fog-coloured quad.
//
// FLAG
//   ?additiveFogBlack            retail (default; also on/1/true/yes/retail)
//   ?additiveFogBlack=fade       fade the additive term to black with fog
//                                (also "black")
//   ?additiveFogBlack=off        stock three fog (also 0/false/no)
// Live: `window.__additiveFogBlack(mode?)` (installed by particle_manager.js):
// no arg = state + counts; "retail" | "fade" | "off" re-applies every live,
// pooled and bucket material in place (one program re-resolve, no reload).

import * as THREE from "three";

export const ADDITIVE_FOG_DEFAULT = "retail";
export const ADDITIVE_FOG_MODES = Object.freeze(["retail", "fade", "off"]);
/** The one program-cache key every `fade` material shares. */
export const ADDITIVE_FOG_FADE_KEY = "hbAddFogFade1";

/** three r184's last fog_fragment statement (the line the fade mode replaces). */
export const STOCK_FOG_MIX_LINE = "gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );";
/** The fade replacement: the additive term goes to 0 as fogFactor goes to 1. */
export const ADDITIVE_FOG_FADE_LINE = "gl_FragColor.rgb *= ( 1.0 - fogFactor );";

/**
 * Parse `?additiveFogBlack`. Returns "retail" | "fade" | "off". Pure (test seam).
 * Absent, empty, on-forms and garbage are all "retail" (never a silent off).
 * @param {string} [search]
 */
export function parseAdditiveFogBlack(search) {
  let raw = null;
  try {
    raw = new URLSearchParams(typeof search === "string" ? search : "").get("additiveFogBlack");
  } catch (_) { raw = null; }
  if (raw == null) return ADDITIVE_FOG_DEFAULT;
  const t = String(raw).trim().toLowerCase();
  if (t === "off" || t === "0" || t === "false" || t === "no") return "off";
  if (t === "fade" || t === "black") return "fade";
  return ADDITIVE_FOG_DEFAULT;
}

const _state = (() => {
  let s = "";
  try { s = globalThis.location?.search || ""; } catch (_) { s = ""; }
  return { mode: parseAdditiveFogBlack(s) };
})();

/** Current mode ("retail" | "fade" | "off"). */
export function additiveFogMode() {
  return _state.mode;
}

/**
 * Set the module mode (does NOT touch existing materials — particle_manager.js
 * `setAdditiveFogBlack` walks them). Accepts the URL spellings too.
 * @returns {string} the mode now in force
 */
export function setAdditiveFogMode(v) {
  const t = String(v ?? "").trim().toLowerCase();
  _state.mode = ADDITIVE_FOG_MODES.includes(t) ? t : parseAdditiveFogBlack(`additiveFogBlack=${encodeURIComponent(t)}`);
  return _state.mode;
}

/**
 * JS mirror of the per-channel GLSL (test seam). `rgb` is the fragment colour
 * BEFORE the fog chunk, `f` the fogFactor. Returns the colour handed to the
 * blend stage, whose additive contribution is `out * srcAlpha`.
 */
export function additiveFogChannel(rgb, f, fogColor, mode = _state.mode) {
  if (mode === "retail") return rgb;
  if (mode === "fade") return rgb * (1 - f);
  return rgb + (fogColor - rgb) * f; // three's mix()
}

/** three's fog chunk with the final mix swapped for the fade, or null if the chunk changed shape. */
export function additiveFogFadeChunk(chunk = THREE.ShaderChunk.fog_fragment) {
  if (typeof chunk !== "string" || !chunk.includes(STOCK_FOG_MIX_LINE)) return null;
  return chunk.replace(STOCK_FOG_MIX_LINE, ADDITIVE_FOG_FADE_LINE);
}

let _fadeChunkWarned = false;
/**
 * Rewrite a material shader object in place for the `fade` mode (test seam).
 * Only the fog chunk changes; everything before it (map, opacity, vColor) and
 * after it (premultiplied alpha, dithering) is three's.
 */
export function patchAdditiveFogShader(shader) {
  if (!shader || typeof shader.fragmentShader !== "string") return false;
  if (!shader.fragmentShader.includes("#include <fog_fragment>")) return false;
  const chunk = additiveFogFadeChunk();
  if (!chunk) {
    if (!_fadeChunkWarned) {
      _fadeChunkWarned = true;
      // eslint-disable-next-line no-console
      console.warn("[additive_fog] three's fog_fragment no longer ends in the stock mix(); ?additiveFogBlack=fade left the stock fog in place.");
    }
    return false;
  }
  shader.fragmentShader = shader.fragmentShader.replace("#include <fog_fragment>", chunk);
  return true;
}

/**
 * The materials this file owns: additive particle materials that are not sky
 * glows (those are unfogged far-depth sheets, sky_glow.js).
 */
export function isAdditiveParticleMaterial(mat) {
  return !!mat && mat.blending === THREE.AdditiveBlending && !(mat.userData && mat.userData.__skyGlow === true);
}

// mat -> { fog, ownObc, obc, ownKey, key, mode } — the pre-patch state, captured
// on first touch. A WeakMap (not userData) because clone() copies userData but
// NOT onBeforeCompile, so a clone must capture its own hooks.
const _orig = new WeakMap();
const _hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function _installFadeHook(mat, o) {
  const prevObc = o.ownObc ? o.obc : null;
  const prevKey = o.ownKey ? o.key : null;
  mat.onBeforeCompile = function hbAdditiveFogFade(shader, renderer) {
    if (typeof prevObc === "function") prevObc.call(this, shader, renderer);
    patchAdditiveFogShader(shader);
  };
  // Constant per base key: a pre-existing hook keeps its own key in front, so
  // the fade never merges two different programs and never makes one per mesh.
  mat.customProgramCacheKey = function () {
    const base = prevKey ? prevKey.call(this) : (prevObc ? prevObc.toString() : "");
    return base ? `${base}|${ADDITIVE_FOG_FADE_KEY}` : ADDITIVE_FOG_FADE_KEY;
  };
}

function _restoreHooks(mat, o) {
  if (o.ownObc) mat.onBeforeCompile = o.obc;
  else delete mat.onBeforeCompile;
  if (o.ownKey) mat.customProgramCacheKey = o.key;
  else delete mat.customProgramCacheKey;
}

/**
 * Put one additive particle material into `mode` (default: the current mode).
 * Idempotent: a pooled clone re-entering the same mode costs nothing (no
 * needsUpdate). `off` on a never-touched material is a no-op, so `=off` is
 * byte-identical to the pre-fix path.
 * @returns {boolean} true if the material is (now) managed by this file
 */
export function applyAdditiveParticleFog(mat, mode = _state.mode) {
  if (!isAdditiveParticleMaterial(mat)) return false;
  let o = _orig.get(mat);
  const ud = mat.userData || (mat.userData = {});
  if (!o) {
    if (mode === "off" && typeof ud.__hbAddFogOrig !== "boolean") return false;
    // The un-patched `fog` rides userData so a clone of a patched material (the
    // runtime instancing toggle clones a per-slot material) restores the
    // authored value, not the patched one it was copied with.
    if (typeof ud.__hbAddFogOrig !== "boolean") ud.__hbAddFogOrig = mat.fog === true;
    o = {
      fog: ud.__hbAddFogOrig,
      ownObc: _hasOwn(mat, "onBeforeCompile"),
      obc: mat.onBeforeCompile,
      ownKey: _hasOwn(mat, "customProgramCacheKey"),
      key: mat.customProgramCacheKey,
      mode: null,
    };
    _orig.set(mat, o);
  }
  if (o.mode === mode) return true;
  const fogBefore = mat.fog;
  const hookBefore = o.mode === "fade";
  if (hookBefore) _restoreHooks(mat, o);
  mat.fog = mode === "retail" ? false : o.fog;
  // An authored-unfogged material has nothing to fade: no hook, fog stays off.
  const hookAfter = mode === "fade" && o.fog;
  if (hookAfter) _installFadeHook(mat, o);
  o.mode = mode;
  // `fog` and the hook are program state (three.module.js:7686 useFog, :7752 key).
  if (mat.fog !== fogBefore || hookBefore || hookAfter) mat.needsUpdate = true;
  return true;
}

/** The mode a material was last put into by this file, or null if untouched. */
export function additiveFogStateOf(mat) {
  const o = mat ? _orig.get(mat) : null;
  return o ? o.mode : null;
}
