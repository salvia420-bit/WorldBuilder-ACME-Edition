// scene3d/sky_glow.js — the moon SkyObject's sky glows (2026-10-07, `?skyGlow`).
//
// WHAT THEY ARE (real DAT bytes, ~/ac_base_dats/client_portal.dat). Region
// 0x13000000 carries the moon SkyObject (Setup 0x02000714, PES 0x330007DB,
// properties 0, begin == end == 0) in ALL 20 DayGroups. Its PhysicsScript fires
// three CreateParticle hooks:
//   0x32000455  Swarm, hw GfxObj 0x01001A61, 3 particles, life 3300 s
//   0x32000456  Swarm, hw GfxObj 0x01001A62, 3 particles, life  900 s
//   0x32000457  Swarm, hw GfxObj 0x01001A63, 3 particles, life  400 s
// each with offset 450-700 along +Z, swarm C = (300,300,300), StartScale =
// FinalScale = 7 (8 for 0x457), trans 0.8 -> 1.0 (20 % -> 0 % opacity). Each
// GfxObj is ONE quad, x -140..135, z -135..140 (275 units) with Surfaces
// 0x0800003F/40/41 = type 0x10102 (Base1Image | Alpha | Additive), luminosity 1,
// textured with a 64x64 radial nebula: blue 0x060037CA, green 0x060037CB,
// orange 0x060037CC (black corners, 1-8/255 at the edge midpoints). So: nine
// ~2 km additive glow sheets 0.5-0.7 km from the viewer. They are not birds;
// `?skyBirds` (sky_dome.js) has been attaching them since 2026-06-23.
//
// WHAT RETAIL DOES WITH THEM. `GameSky::UpdatePosition` (acclient.c:308367)
// puts every sky object at the VIEWER's origin, and `GameSky::Draw`
// (acclient.c:308475) draws the before-sky objects (property bit 0x1 clear)
// BEFORE the landscape with `SetDepthBufferMode(DEPTHTEST_ALWAYS, 0)`, zfar x 4
// and `SetFFFogEnable(LScape::m_override_enabled)` -- i.e. unfogged, writing no
// depth, and then overdrawn by every piece of world geometry. Additive into an
// LDR framebuffer, a 1-8/255 edge texel at 20 % opacity is invisible.
//
// WHY THEY WERE WEDGES HERE. They were drawn as ordinary world-pass particles:
//   1. depth-tested in WORLD space at 0.5-0.9 km, so they painted over distant
//      terrain and sea (the pale planes over the sea);
//   2. FOGGED by the AC range fog. three's fog_fragment is
//      `gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor)`, which
//      on an ADDITIVE quad adds `fogFactor * fogColor` across the WHOLE quad,
//      black texels included -- a uniform pale sheet with a hard straight edge;
//   3. added in linear HDR before exposure 5 + AgX, so even the texture's own
//      faint edge reads.
// Seen from below at a grazing angle, the sheets' straight edges converge on
// the horizon vanishing point -- the "lines through the sky".
//
// THE FIX (`?skyGlow`, DEFAULT ON). Owner direction 2026-10-07: keep them, make
// them a very subtle gaseous wash that never sits in front of the clouds and
// never has a hard edge. Patched onto exactly those particle materials (the
// sky-chain emitters, tagged by sky_dome.js's anchor -> statics.js request ->
// particle_manager.js `skyGlow`):
//   - FAR DEPTH: the fragment writes gl_FragDepth = 1.0 against the default
//     LEQUAL test, so it survives only where the depth buffer still holds the
//     clear (no geometry): retail's "drawn before the world, overdrawn by it".
//     No terrain or sea is ever tinted. Because they now live only on sky
//     pixels, AerialPerspective's cloud overlay (`rgb * (1 - a) + overlay`)
//     composites the volumetric clouds IN FRONT of them.
//   - NO FOG (retail: fog off for sky objects).
//   - RADIAL WINDOW: `1 - smoothstep(0.2, 0.8, r)` over the quad's UV (r = 1 at
//     the edge midpoints), exactly 0 well inside the boundary -- no edge can
//     survive any exposure.
//   - DISPLAY-SPACE GAIN: `strength / toneMappingExposure`, so `?skyGlow=1`
//     adds roughly what retail added to its LDR frame; default 0.5 = subtle.
// Map-less sky-chain particles (the storm DayGroups' 0x320002C2 lightning box,
// surface 0x0800006C solid colour) are NOT patched: they keep their legacy look.
//
// FLAG
//   ?skyGlow=<N>    strength multiplier, default 0.15 (1 ~ retail LDR)
//   ?skyGlow=off    hide them (also 0 / false / no) -- materials invisible
//   ?skyGlow=legacy pre-fix rendering (world-space, fogged) for an A/B
// Live: `window.__skyGlow(v)` (number | "off") returns the state.

import * as THREE from "three";

// 2026-10-07 (later): 0.5 -> 0.15. Live at night on the 1070 the black sky let
// 0.5 paint a bright green band across the top of the frame; 0.12-0.15 reads as
// the faint gaseous wash the owner asked for. `?skyGlow=N` / `__skyGlow(N)` tune.
export const SKY_GLOW_DEFAULT = 0.15;
export const SKY_GLOW_MAX = 8;
/** Inner/outer UV radius of the window (r = 1 at the quad's edge midpoints). */
export const SKY_GLOW_FALLOFF = Object.freeze([0.2, 0.8]);
export const SKY_GLOW_PROGRAM_KEY = "hbSkyGlow1";

/**
 * Parse `?skyGlow`. Returns `{ mode, strength }` where mode is "on" | "off" |
 * "legacy". Pure (test seam).
 * @param {string} [search]
 */
export function parseSkyGlow(search) {
  let raw = null;
  try {
    raw = new URLSearchParams(typeof search === "string" ? search : "").get("skyGlow");
  } catch (_) { raw = null; }
  if (raw == null || raw === "") return { mode: "on", strength: SKY_GLOW_DEFAULT };
  const t = String(raw).trim().toLowerCase();
  if (t === "legacy") return { mode: "legacy", strength: 0 };
  if (t === "off" || t === "false" || t === "no") return { mode: "off", strength: 0 };
  if (t === "on" || t === "true" || t === "yes") return { mode: "on", strength: SKY_GLOW_DEFAULT };
  const n = Number(t);
  if (!Number.isFinite(n)) return { mode: "on", strength: SKY_GLOW_DEFAULT };
  if (n <= 0) return { mode: "off", strength: 0 };
  return { mode: "on", strength: Math.min(SKY_GLOW_MAX, n) };
}

const _state = (() => {
  let s = "";
  try { s = globalThis.location?.search || ""; } catch (_) { s = ""; }
  return { ...parseSkyGlow(s), exposure: 5, skyVisible: true };
})();

/** Shared by every patched material; written once per frame by sky_dome.js. */
export const SKY_GLOW_UNIFORMS = {
  hbSkyGlowGain: { value: _state.strength / _state.exposure },
  hbSkyGlowFalloff: { value: new THREE.Vector2(SKY_GLOW_FALLOFF[0], SKY_GLOW_FALLOFF[1]) },
};

const _patched = new WeakSet();
const _live = new Set();

/** JS mirror of the GLSL window (test seam). */
export function skyGlowWindow(r, inner = SKY_GLOW_FALLOFF[0], outer = SKY_GLOW_FALLOFF[1]) {
  const t = Math.min(1, Math.max(0, (r - inner) / (outer - inner)));
  return 1 - t * t * (3 - 2 * t);
}

/** The effective gain the shader multiplies by. */
export function skyGlowGain(strength = _state.strength, exposure = _state.exposure) {
  const e = Number.isFinite(exposure) && exposure > 1e-3 ? exposure : 1;
  return (Number.isFinite(strength) && strength > 0 ? strength : 0) / e;
}

function _applyVisibility() {
  const vis = _state.mode === "on" && _state.strength > 0 && _state.skyVisible;
  for (const m of _live) m.visible = vis;
}

/** Current state (diag / live handle). */
export function skyGlowState() {
  return {
    mode: _state.mode,
    strength: _state.strength,
    exposure: _state.exposure,
    gain: SKY_GLOW_UNIFORMS.hbSkyGlowGain.value,
    skyVisible: _state.skyVisible,
    materials: _live.size,
  };
}

/** True unless `?skyGlow=legacy` (the patch is applied in every other mode). */
export function skyGlowPatchEnabled() {
  return _state.mode !== "legacy";
}

/**
 * Per-frame sync from sky_dome.js: exposure (the gain is display-space) and
 * whether the sky is visible at all (dungeon / sky-blocked frames hide them).
 * Positional args: called every frame, so no options object is allocated.
 * @param {number} [exposure] renderer.toneMappingExposure
 * @param {boolean} [skyVisible]
 */
export function updateSkyGlowFrame(exposure, skyVisible) {
  if (Number.isFinite(exposure) && exposure > 0) _state.exposure = exposure;
  const sv = skyVisible !== false;
  const visChanged = sv !== _state.skyVisible;
  _state.skyVisible = sv;
  SKY_GLOW_UNIFORMS.hbSkyGlowGain.value = skyGlowGain();
  if (visChanged) _applyVisibility();
}

/** Live strength: number (<= 0 hides), "off", or "on" (default strength). */
export function setSkyGlowStrength(v) {
  if (_state.mode === "legacy") return skyGlowState();
  const p = parseSkyGlow(`skyGlow=${encodeURIComponent(String(v))}`);
  if (p.mode !== "legacy") { _state.mode = p.mode; _state.strength = p.strength; }
  SKY_GLOW_UNIFORMS.hbSkyGlowGain.value = skyGlowGain();
  _applyVisibility();
  return skyGlowState();
}

// GLSL — plain strings, no backticks inside (the shader-comment rule).
export const SKY_GLOW_VERTEX_DECL = "\nvarying vec2 vHbSkyGlowUv;\n";
export const SKY_GLOW_VERTEX_BODY = "\n\tvHbSkyGlowUv = uv;\n";
export const SKY_GLOW_FRAGMENT_DECL =
  "\nuniform float hbSkyGlowGain;\nuniform vec2 hbSkyGlowFalloff;\nvarying vec2 vHbSkyGlowUv;\n";
export const SKY_GLOW_FRAGMENT_BODY = [
  "",
  "\t// SKY GLOW (2026-10-07): radial window to exactly 0 inside the quad edge,",
  "\t// display-space gain, then FAR depth so only sky pixels keep it.",
  "\tfloat hbSkyGlowR = length( vHbSkyGlowUv - vec2( 0.5 ) ) * 2.0;",
  "\tfloat hbSkyGlowW = 1.0 - smoothstep( hbSkyGlowFalloff.x, hbSkyGlowFalloff.y, hbSkyGlowR );",
  "\toutgoingLight *= hbSkyGlowW * hbSkyGlowGain;",
  "\t#include <opaque_fragment>",
  "\tgl_FragDepth = 1.0;",
  "",
].join("\n");

/** Rewrite a MeshBasicMaterial shader object in place (test seam). */
export function patchSkyGlowShader(shader) {
  if (!shader || typeof shader.vertexShader !== "string" || typeof shader.fragmentShader !== "string") return false;
  if (!shader.fragmentShader.includes("#include <opaque_fragment>")) return false;
  if (!shader.vertexShader.includes("#include <uv_vertex>")) return false;
  shader.uniforms = shader.uniforms || {};
  shader.uniforms.hbSkyGlowGain = SKY_GLOW_UNIFORMS.hbSkyGlowGain;
  shader.uniforms.hbSkyGlowFalloff = SKY_GLOW_UNIFORMS.hbSkyGlowFalloff;
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>" + SKY_GLOW_VERTEX_DECL)
    .replace("#include <uv_vertex>", "#include <uv_vertex>" + SKY_GLOW_VERTEX_BODY);
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", "#include <common>" + SKY_GLOW_FRAGMENT_DECL)
    .replace("#include <opaque_fragment>", SKY_GLOW_FRAGMENT_BODY);
  return true;
}

/**
 * Turn one sky-chain particle material into a sky glow. Idempotent per
 * material object (a WeakSet, not userData: `clone()` copies userData but not
 * onBeforeCompile). Map-less materials and `?skyGlow=legacy` are left alone.
 * @param {THREE.Material} mat
 * @returns {boolean} true if the material is (now) a sky glow
 */
export function applySkyGlowMaterial(mat) {
  if (!mat || !skyGlowPatchEnabled()) return false;
  if (_patched.has(mat)) return true;
  if (!mat.map) return false;
  _patched.add(mat);
  mat.fog = false;
  mat.transparent = true;
  mat.depthWrite = false;
  mat.depthTest = true;
  mat.depthFunc = THREE.LessEqualDepth;
  const prev = mat.onBeforeCompile;
  const base = THREE.Material.prototype.onBeforeCompile;
  mat.onBeforeCompile = function (shader, renderer) {
    if (typeof prev === "function" && prev !== base) prev.call(this, shader, renderer);
    patchSkyGlowShader(shader);
  };
  mat.customProgramCacheKey = () => SKY_GLOW_PROGRAM_KEY;
  mat.userData = { ...(mat.userData || {}), __skyGlow: true };
  _live.add(mat);
  mat.addEventListener("dispose", function onDispose() {
    _live.delete(mat);
    mat.removeEventListener("dispose", onDispose);
  });
  mat.visible = _state.mode === "on" && _state.strength > 0 && _state.skyVisible;
  mat.needsUpdate = true;
  return true;
}

/** Live window radii (UV radius, r = 1 at the edge midpoints). */
export function setSkyGlowFalloff(inner, outer) {
  const a = Number(inner);
  const b = Number(outer);
  if (Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b > a) {
    SKY_GLOW_UNIFORMS.hbSkyGlowFalloff.value.set(a, b);
  }
  return SKY_GLOW_UNIFORMS.hbSkyGlowFalloff.value.toArray();
}

/**
 * `window.__skyGlow(v?)` — live strength for the eye test (number | "off";
 * no arg = state); `window.__skyGlow.falloff(inner, outer)`. Idempotent.
 */
export function installSkyGlowHandle() {
  try {
    if (typeof window === "undefined" || window.__skyGlow) return;
    const h = (v) => (v === undefined ? skyGlowState() : setSkyGlowStrength(v));
    h.falloff = setSkyGlowFalloff;
    window.__skyGlow = h;
  } catch (_) { /* no window in the Node harness */ }
}
