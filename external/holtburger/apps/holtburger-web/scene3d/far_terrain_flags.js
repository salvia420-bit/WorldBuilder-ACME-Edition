// scene3d/far_terrain_flags.js — URL-flag readers for the far-terrain wave.
//
// Split out of far_terrain.js with NO imports so terrain.js can read the flags
// without an import cycle (far_terrain.js imports terrain.js).
//
// FLAG-DEFAULT FOOTGUN (memory §4): a flag coded `!== "off"` reads ON when the
// param is absent, which is the opposite of a "default OFF" comment. Every
// reader below is explicit about which way it falls, and default-OFF readers
// test `=== "on"` and nothing else.
//
// Master escape for the whole wave: `?farTerrain=off`.

const _cache = new Map();

function _param(name) {
  try {
    if (typeof window === "undefined" || !window.location) return null;
    return new URLSearchParams(window.location.search || "").get(name);
  } catch (_) {
    return null;
  }
}

function _boolOn(name, dflt) {
  if (_cache.has(name)) return _cache.get(name);
  const raw = _param(name);
  let v = dflt;
  if (typeof raw === "string" && raw !== "") {
    const s = raw.toLowerCase();
    if (s === "off" || s === "0" || s === "false" || s === "no") v = false;
    else if (s === "on" || s === "1" || s === "true" || s === "yes") v = true;
  }
  _cache.set(name, v);
  return v;
}

function _num(name, dflt, lo, hi) {
  const key = `#${name}`;
  if (_cache.has(key)) return _cache.get(key);
  let v = dflt;
  const raw = _param(name);
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) v = Math.min(hi, Math.max(lo, n));
  }
  _cache.set(key, v);
  return v;
}

/** Master escape. `?farTerrain=off` makes every sub-feature inert. */
export function farTerrainEnabled() {
  return _boolOn("farTerrain", true);
}

/**
 * S1 — retail range fog in the terrain shader (+ `?fogLerp` promoted to
 * default-ON so `scene.fog` actually exists on the atmosphere path).
 * DEFAULT ON, escape `?terrainFog=off`. With it off, the terrain material sets
 * `fog: false`, `USE_FOG` is never defined and the fragment shader is
 * byte-identical to the pre-wave build.
 */
export function terrainFogEnabled() {
  return farTerrainEnabled() && _boolOn("terrainFog", true);
}

/**
 * S2/S3 — the Far Composite Ring itself (bakes + far patches).
 * Ships DEFAULT-OFF pending the validator's per-stage GPU sign-off; flip with
 * `?farRing=on`. The fog stage above is independently shippable and is ON.
 */
export function farRingEnabled() {
  return farTerrainEnabled() && _boolOn("farRing", false);
}

/** Far ring Chebyshev radius in landblocks. `?farRadius=N`, default 8 (1536 m). */
export function farRadiusLb() {
  return Math.round(_num("farRadius", 8, 1, 16));
}

/** Composite texels per landblock edge. `?farTexels=64|128|256`, default 128. */
export function farTexelsPerLb() {
  const v = Math.round(_num("farTexels", 128, 32, 512));
  // Snap to a power of two — the patch RT is 4x this and must stay mippable.
  let p = 32;
  while (p * 2 <= v) p *= 2;
  return p;
}

/**
 * Fog-before-edge invariant (CRITIQUE reconciliation (a)):
 *   fogFar = min(authored fogMax, FRAC * (R_effective + 0.5) * 192)
 * so an unbaked / off-map / absent tile is invisible and the "void read as
 * ocean" mis-tune cannot recur. `?farFogFrac=0` disables the clamp entirely.
 *
 * FIX ROUND 2026-08-03 (validator defect 2) — 0.85 * R * 192 was measured too
 * aggressive: at the MEASURED R_near = 5 it put fogFar at 816 m, i.e. the whole
 * visible world inside the ramp, and mid-valley terrain 400 m out read 201/255
 * against 134/255 with the retail-authored 2400 m band. The outermost DRAWN
 * landblock's far edge is at `(R + 0.5) * 192` (R counts LB CENTRES, the tile
 * is 192 m wide), so the old expression was clamping ~0.77 of the real edge.
 * The invariant only needs fog to be visually opaque BEFORE that edge, which
 * smoothstep reaches well before its far parameter: 0.95 * (R + 0.5) * 192
 * keeps ~5 % of margin and stops discarding usable depth.
 */
export function farFogFrac() {
  return _num("farFogFrac", 0.95, 0, 4);
}

/**
 * Absolute floor for the clamped fog far distance, in metres. Only applied
 * when the MEASURED radius says residency is healthy (>= `farFogFloorMinLb`
 * landblocks actually drawn) — during a boot fill or a governor collapse the
 * world really IS that small and the fog must still hide the true edge
 * (validator defect 4, acceptance (c)). `?farFogFloor=0` disables it.
 */
export function farFogFloorM() {
  return _num("farFogFloor", 700, 0, 20000);
}

/** Measured radius (LB) at or above which `farFogFloorM` is allowed to apply. */
export function farFogFloorMinLb() {
  return _num("farFogFloorMinLb", 3, 0, 16);
}

/**
 * S1 fix round (validator defect 1 + 3) — drive `scene.fog.color` from the
 * RENDERED SKY's horizon radiance instead of the authored sRGB hex.
 *
 * The authored DAT colour is an 8-bit DISPLAY value. `scene.fog.color` is
 * consumed as PRE-EXPOSURE SCENE RADIANCE (terrain renders into the HalfFloat
 * HDR buffer, `toneMappingExposure = 5`, AGX afterwards), so feeding it the
 * authored value made 100 %-fogged terrain 60+ levels brighter than the sky it
 * meets — a glowing band at 19:00, a grey wall against a black sky at 02:00.
 * The sky's own horizon radiance is in that space BY CONSTRUCTION, so fogged
 * terrain converges to exactly the sky behind it at every hour, for free.
 *
 * DEFAULT ON; `?farFogSky=off` falls back to the authored hex (the shipped
 * becba0d1 behaviour) for an A/B.
 */
export function farFogSkyProbeEnabled() {
  return _boolOn("farFogSky", true);
}

/** Probe elevation above the horizon, in degrees. Half-fov of the probe cone. */
export function farFogSkyElevDeg() {
  return _num("farFogSkyElev", 2.0, -10, 45);
}

/** Probe rate cap, in Hz. The readback is a GPU sync — keep it lazy. */
export function farFogSkyHz() {
  return _num("farFogSkyHz", 4, 0.1, 60);
}

/**
 * Weight of the AUTHORED DAT fog chroma blended over the sampled sky radiance,
 * preserving the sample's luminance. 0 (default) = pure sky radiance, which is
 * what the acceptance measurement ("fogged pixel within a few levels of the sky
 * above it") rewards; 1 = the authored hue at the sky's brightness. The
 * authored RANGES are never touched by any of this.
 */
export function farFogTint() {
  return _num("farFogTint", 0, 0, 1);
}

/** Numeric pin for the fog band, for A/B only. NaN = "use the AC/SkyState value". */
export function farFogNearPin() {
  const raw = _param("farFogNear");
  if (raw == null || raw === "") return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/** Numeric pin for the fog far distance, for A/B only. NaN = SkyState-driven. */
export function farFogFarPin() {
  const raw = _param("farFogFar");
  if (raw == null || raw === "") return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Depth push applied to the far ring, in log-depth units, so the opaque near
 * ring deterministically wins the ~10 m near/far handoff overlap. Applied in
 * the shader because the far shader writes gl_FragDepth, which overrides
 * material polygonOffset. `?farDepthBias=0` for an A/B of the raw seam.
 */
export function farDepthBias() {
  return _num("farDepthBias", 1e-6, 0, 1e-3);
}

/** Patch bakes allowed per frame. Measured 1.2 ms GPU per 16-LB patch @128^2. */
export function farBakeBudgetPerFrame() {
  return Math.round(_num("farBakeBudget", 1, 1, 8));
}

/** Landblock ids per `fetch_landblock_heightmaps` call. */
export function farFetchBatchSize() {
  return Math.round(_num("farFetchBatch", 16, 1, 128));
}

/** Concurrent far heightmap fetches. Hard-capped low — the near ring wins. */
export function farFetchInFlightMax() {
  return Math.round(_num("farFetchInFlight", 2, 1, 8));
}

/**
 * `?diag` assertions for the radius policy: no far LB may ever reach
 * fetch_landblock_objects/_scenery/_spawns, the terrain LRU, or a per-LB
 * ShaderMaterial. DEFAULT-ON — the checks are a few Set lookups per far LB.
 */
export function farDiagEnabled() {
  return _boolOn("farDiag", true);
}

/** Test seam: drop every memoised flag (used by unit tests only). */
export function _resetFarTerrainFlagsForTest() {
  _cache.clear();
}
