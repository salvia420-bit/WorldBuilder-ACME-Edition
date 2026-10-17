// scene3d/terrain_far_simplify.js — TERRAIN FAR SIMPLIFY (`?terrainFarSimplify`,
// 2026-10-17, DEFAULT ON, `=off` escape). Shading/sampling only: no geometry,
// no new sampler, no new program key beyond the session-constant flag.
//
// WHY. The terrain is ONE draw (the batched ring) and on the 1070 it is the
// second-biggest GPU item of an outdoor frame: 6.1 ms at quality=ultra
// (per-draw timer census 2026-10-17, /mnt/wbterminal1/tmp/fps-agent/). Turning
// single shader features off one at a time measured: texture merge -1.5 ms,
// detail normal -1.1, vertex lighting -0.9, shadow sampling -0.85, detail
// texture -0.4, macro -0.3, parallax -0.27 (they overlap). The recommendation:
// fade the expensive ones out with view distance so the GPU skips them on the
// far ground, behind a smooth band, with the near field unchanged.
//
// WHAT EACH ONE ACTUALLY DID AT DISTANCE (read from the shader, 2026-10-17) and
// what this module changes:
//
//  1. TEXTURE MERGE (the retail TexMerge composite: per-cell base + up to 3
//     masked overlays + 2 road slots, splat noise on the borders). It ran on
//     EVERY terrain fragment at EVERY distance, and so did the 4-tap bilinear
//     corner blend in front of it — whose result the composite then threw away
//     (`result = merged;`), so the bilinear taps were dead work wherever the
//     composite ran. Now:
//       Distances are CAMERA DISTANCE (length(vWorldPos - cameraPosition)),
//       not plane depth, so the band does not slide when the camera turns.
//       - nearer than uFarSimplify.x (240 m): the composite alone; the dead
//         bilinear taps are skipped. Byte-identical output.
//       - beyond uFarSimplify.y (300 m): the bilinear blend alone (the
//         composite's own fallback path — what an LB without merge data has
//         always drawn), plus the road lane the composite's road slots would
//         have painted (same atlas road layer, analytic 5 m lane; the far
//         harmonize then treats it exactly as it treats the slot road).
//       - in between: both, crossfaded with a smoothstep on distance, and the
//         far-harmonize mean twin crossfaded with them.
//     The per-LB merge-validity gate of the batched ring is honoured: the
//     decision is taken INSIDE the anchored `if (uTexMergeEnabled > 0.5)`
//     block that terrain_batch.js rewrites, so nothing new needs a batch
//     anchor.
//  2. DETAIL TEXTURE (retail landscape detail crossfade). Its weight is
//     exactly 0 past uDetailTexFadeEnd (50 m) — but the texture fetch ran on
//     every fragment anyway. It is now skipped past the fade end. Byte-identical
//     (amtA == 0 there: the gamma branch skips, the linear / percode forms are
//     exact identities).
//  3. DETAIL NORMAL. In a default session (`?terrainGouraud` on) the detail
//     normal array only shades through `?terrainMicro`, which already stops at
//     75 m (`microNear`) — nothing left to skip at distance. In the
//     `?terrainGouraud=off` path the detail-normal NdotL ran at every distance;
//     there it now fades toward the FLAT detail normal over the band (exactly
//     what the RNM yields for a flat tile: N = (0,0,1)) and the 1-3 taps are
//     skipped beyond it.
//  4. SHADOW SAMPLING (CSM). Already skipped beyond 300 m before this change:
//     csmShadowFactor returns 1.0 past uCsmFar = the last cascade split (300 m,
//     csm.js), and the statics' CSM patch cuts at the same distance. Left as is
//     (the shadows lane owns the splits; a terrain-only fade would disagree
//     with the statics' own cut).
//
// THE FAR COMPOSITE RING. Its bake renders this same material from 1000 m up,
// so every distance ramp resolves to its far value (terrain.js uBakeAlbedo
// note) — the bake now takes the far path too, which is exactly what the near
// ring draws at the seam. `=off` restores the old bake with everything else.
//
// Live tuning (every registered terrain material, per-LB and the batch):
//   window.__terrainFarSimplify.set({ startM, endM })   .live()   .config
// URL: `?terrainFarSimplify=off` | `=on` | `=START,END` | `=END` (start 0.8 END).
//
// NOTE: no backticks inside the GLSL template literals below (they would end
// the string and take the boot down).

/** Defaults — the numbers the url-flags.md row documents. */
export const TERRAIN_FAR_SIMPLIFY_DEFAULTS = Object.freeze({
  startM: 240,
  endM: 300,
});

function _search(search) {
  if (typeof search === "string") return search;
  try {
    return (typeof window !== "undefined" && window.location && window.location.search) || "";
  } catch (_) {
    return "";
  }
}

function _finite(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Clamp a band to sane metres: 0 <= start, end >= start + 1. */
function _band(startM, endM) {
  const s = Math.min(100000, Math.max(0, startM));
  let e = Math.min(100001, Math.max(0, endM));
  if (!(e >= s + 1)) e = s + 1;
  return [s, e];
}

/**
 * Resolve the config from a query string (default: the page URL).
 * Absent / `on` / garbage -> on with the default band; `off`/`0`/`false`/`no`
 * -> off (the legacy program, byte-identical); `A,B` -> band A..B metres;
 * a single number B -> band 0.8 B .. B.
 * @param {string} [search]
 */
export function readTerrainFarSimplifyConfig(search) {
  const D = TERRAIN_FAR_SIMPLIFY_DEFAULTS;
  let raw = null;
  try {
    raw = new URLSearchParams(_search(search)).get("terrainFarSimplify");
  } catch (_) {
    raw = null;
  }
  let on = true;
  let startM = D.startM;
  let endM = D.endM;
  if (typeof raw === "string" && raw !== "") {
    const v = raw.toLowerCase().trim();
    if (v === "off" || v === "0" || v === "false" || v === "no") {
      on = false;
    } else if (v !== "on") {
      const parts = v.split(",").map((p) => _finite(p.trim()));
      if (parts.length >= 2 && parts[0] != null && parts[1] != null) {
        [startM, endM] = _band(parts[0], parts[1]);
      } else if (parts.length === 1 && parts[0] != null && parts[0] > 0) {
        [startM, endM] = _band(parts[0] * 0.8, parts[0]);
      }
    }
  }
  return { on, startM, endM, source: typeof raw === "string" ? raw : null };
}

/** The session config (module load, like every sibling terrain flag). */
export const TERRAIN_FAR_SIMPLIFY = readTerrainFarSimplifyConfig();

/** JS mirror of the shader's fsKeep: 1 nearer than start, smoothstep to 0 at end. */
export function farKeepAt(depthM, startM, endM) {
  const t = Math.min(1, Math.max(0, (depthM - startM) / (endM - startM)));
  return 1 - t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// GLSL (spliced into scene3d/terrain.js only when the flag is on)
// ---------------------------------------------------------------------------

/**
 * Global scope, after the sampling helpers (terrainAtlasTex) and the road
 * helpers (vertexRoadAt, distToSegment), which it calls.
 */
export const TERRAIN_FAR_SIMPLIFY_FRAG_GLSL = `
// 2026-10-17 (?terrainFarSimplify, scene3d/terrain_far_simplify.js) — camera-
// distance band of the far path: full features nearer than x, the far path
// beyond y (metres), a smoothstep crossfade between.
uniform vec2 uFarSimplify;
// The road lane the TexMerge road slots would have painted, for the far path:
// the same weight the analytic lane painter computes further down (both of its
// modes), so the far road is the 5 m retail lane on the road-flagged vertices.
float terrainFarRoadLane(int iu, int iv, vec2 cellUv, float w00, float w10, float w01, float w11) {
  float r00 = vertexRoadAt(iu,     iv    );
  float r10 = vertexRoadAt(iu + 1, iv    );
  float r01 = vertexRoadAt(iu,     iv + 1);
  float r11 = vertexRoadAt(iu + 1, iv + 1);
  if (uRoadPaintLegacy > 0.5) {
    return smoothstep(0.85, 0.95, r00 * w00 + r10 * w10 + r01 * w01 + r11 * w11);
  }
  if (r00 + r10 + r01 + r11 < 0.5) return 0.0;
  vec2 p = cellUv * 24.0;
  vec2 k00 = vec2(0.0, 0.0);
  vec2 k10 = vec2(24.0, 0.0);
  vec2 k01 = vec2(0.0, 24.0);
  vec2 k11 = vec2(24.0, 24.0);
  float d = 1e9;
  if (r00 > 0.5 && r10 > 0.5) d = min(d, distToSegment(p, k00, k10));
  if (r01 > 0.5 && r11 > 0.5) d = min(d, distToSegment(p, k01, k11));
  if (r00 > 0.5 && r01 > 0.5) d = min(d, distToSegment(p, k00, k01));
  if (r10 > 0.5 && r11 > 0.5) d = min(d, distToSegment(p, k10, k11));
  if (r00 > 0.5 && r11 > 0.5) d = min(d, distToSegment(p, k00, k11));
  if (r10 > 0.5 && r01 > 0.5) d = min(d, distToSegment(p, k10, k01));
  if (r00 > 0.5) d = min(d, length(p - k00));
  if (r10 > 0.5) d = min(d, length(p - k10));
  if (r01 > 0.5) d = min(d, length(p - k01));
  if (r11 > 0.5) d = min(d, length(p - k11));
  return 1.0 - smoothstep(2.0, 3.0, d);
}
// The far path's mean-colour twin for the far harmonize: the bilinear corner
// means, with the far road lane composited exactly as the composite's road
// slot composites terrainTypeMean(32).
vec3 terrainFarBilinTwin(vec3 m00, vec3 m10, vec3 m01, vec3 m11,
                         float w00, float w10, float w01, float w11, float roadW) {
  vec3 tw = m00 * w00 + m10 * w10 + m01 * w01 + m11 * w11;
  return roadW > 0.0 ? mix(tw, terrainTypeMean(32), roadW) : tw;
}
`;

/** main(): replaces the legacy `vec3 result;` + bilinear blend site. */
export const TERRAIN_FAR_SIMPLIFY_DECL_GLSL = `  // 2026-10-17 (?terrainFarSimplify) — fsKeep: 1 nearer than uFarSimplify.x,
  // 0 beyond .y. The TexMerge composite below runs only while fsKeep > 0, and
  // the bilinear blend (its far stand-in, and until now its dead twin) only
  // where the composite does not own the whole pixel (after the composite).
  // CAMERA DISTANCE, not vViewDepth: the plane depth of a ground point changes
  // as the camera merely turns (about 30 pct shorter at a 16:9 screen edge), so
  // a depth band would slide the mask shapes in and out while looking around.
  float fsKeep = 1.0 - smoothstep(uFarSimplify.x, uFarSimplify.y, length(vWorldPos - cameraPosition));
  bool fsMergeGate = false;   // the composite is live for this landblock
  float fsMergeMix = 0.0;     // the composite's weight in this pixel
  float fsRoadW = 0.0;        // far road lane painted by the far path
  vec3 result = vec3(0.0);`;

/** Inside the merge gate, right after its anchored first statement. */
export const TERRAIN_FAR_SIMPLIFY_MERGE_OPEN_GLSL = `
    fsMergeGate = true;
    if (fsKeep > 0.0) {`;

/** End of the merge gate (closes the fsKeep test). */
export const TERRAIN_FAR_SIMPLIFY_MERGE_CLOSE_GLSL = `
    fsMergeMix = fsKeep;
    }`;

/**
 * After the merge gate: the bilinear blend where the composite is not the
 * whole answer. `tapsGlsl` declares c00..c11; `blendGlsl` declares and fills
 * fsBilin (terrain.js builds both from the same text as the legacy site).
 */
export function terrainFarSimplifyBilinearGlsl(tapsGlsl, blendGlsl) {
  return `
  // 2026-10-17 (?terrainFarSimplify) — the bilinear corner blend, only where
  // the TexMerge composite above did not run or is fading out.
  if (!fsMergeGate || fsMergeMix < 1.0) {
${tapsGlsl}
${blendGlsl}
    if (fsMergeGate && uRoadSlotsEnabled > 0.5) {
      // The composite's road slots stood down with it: paint their lane.
      fsRoadW = terrainFarRoadLane(iu, iv, cellUv, w00, w10, w01, w11);
      if (fsRoadW > 0.0) fsBilin = mix(fsBilin, terrainAtlasTex(32, cellUv).rgb, fsRoadW);
    }
    result = fsMergeMix > 0.0 ? mix(fsBilin, result, fsMergeMix) : fsBilin;
  }`;
}

/** Far harmonize: the twin when the composite ran (crossfaded in the band). */
export const TERRAIN_FAR_SIMPLIFY_HARM_MERGED_GLSL =
  "(fsMergeMix < 1.0 ? mix(terrainFarBilinTwin(hm00, hm10, hm01, hm11, w00, w10, w01, w11, fsRoadW), harmSharpMean, fsMergeMix) : harmSharpMean)";
/** Far harmonize: the twin when it did not. */
export const TERRAIN_FAR_SIMPLIFY_HARM_BILIN_GLSL =
  "terrainFarBilinTwin(hm00, hm10, hm01, hm11, w00, w10, w01, w11, fsRoadW)";

/** Detail texture: the fetch is skipped where its weight is exactly 0. */
export const TERRAIN_FAR_SIMPLIFY_DETAIL_TEX_COND_GLSL =
  " && vViewDepth < max(uDetailTexFadeEnd, uDetailTexFadeStart + 1.0e-3)";

/** Detail normal (Gouraud-off path): sample only while fsKeep > 0 ... */
export const TERRAIN_FAR_SIMPLIFY_DETAIL_NORMAL_COND_GLSL = " && fsKeep > 0.0";
/** ... fade toward the flat detail normal over the band ... */
export const TERRAIN_FAR_SIMPLIFY_DETAIL_NORMAL_FADE_GLSL =
  "      if (fsKeep < 1.0) detailEncoded = mix(vec3(0.5, 0.5, 1.0), detailEncoded, fsKeep);\n";
/** ... and light with the flat normal beyond it (what the RNM yields for it). */
export const TERRAIN_FAR_SIMPLIFY_DETAIL_NORMAL_FAR_GLSL =
  " else if (slice < 5) {\n      ndotl = terrainSunNdotl(vec3(0.0, 0.0, 1.0), sunDir);\n    }";

// ---------------------------------------------------------------------------
// Live uniforms
// ---------------------------------------------------------------------------

const _live = {
  startM: TERRAIN_FAR_SIMPLIFY.startM,
  endM: TERRAIN_FAR_SIMPLIFY.endM,
};

/**
 * Uniform entries for a NEW terrain ShaderMaterial (spread into its
 * `uniforms`; cloned into the batch material like every other uniform).
 * Empty when the flag is off (the legacy program declares no such uniform).
 */
export function terrainFarSimplifyUniforms(THREE, cfg = TERRAIN_FAR_SIMPLIFY) {
  if (!cfg || !cfg.on || !THREE || typeof THREE.Vector2 !== "function") return {};
  return { uFarSimplify: { value: new THREE.Vector2(_live.startM, _live.endM) } };
}

/**
 * Live tuning without a reload. Applies to every registered terrain material
 * (per-LB and the terrain batch) and to materials baked later.
 */
export function setTerrainFarSimplifyLive(scene3d, patch = {}) {
  let s = Number.isFinite(patch.startM) ? patch.startM : _live.startM;
  let e = Number.isFinite(patch.endM) ? patch.endM : _live.endM;
  [s, e] = _band(s, e);
  _live.startM = s;
  _live.endM = e;
  let touched = 0;
  const seen = new Set();
  const lists = [scene3d && scene3d.terrainMaterials];
  try {
    const liveS = typeof window !== "undefined" ? window.liveScene3d : null;
    if (liveS && liveS !== scene3d) lists.push(liveS.terrainMaterials);
  } catch (_) { /* fail-soft */ }
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      const u = m.uniforms && m.uniforms.uFarSimplify;
      if (!u || !u.value) continue;
      if (typeof u.value.set === "function") u.value.set(s, e);
      else { u.value.x = s; u.value.y = e; }
      touched += 1;
    }
  }
  return { ..._live, materials: touched };
}

/** Install `window.__terrainFarSimplify` (idempotent; browser only). */
export function installTerrainFarSimplifyDiag(scene3d) {
  if (typeof window === "undefined") return null;
  const api = {
    config: TERRAIN_FAR_SIMPLIFY,
    live: () => ({ ..._live }),
    set: (patch) => setTerrainFarSimplifyLive(scene3d, patch),
    /** First registered material's band (what the GPU sees). */
    state: () => {
      const u = (scene3d?.terrainMaterials ?? [])[0]?.uniforms?.uFarSimplify;
      return u && u.value ? { startM: u.value.x, endM: u.value.y } : null;
    },
  };
  try { window.__terrainFarSimplify = api; } catch (_) { /* fail-soft */ }
  return api;
}
