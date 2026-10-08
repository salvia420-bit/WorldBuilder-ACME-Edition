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
 * Shipped DEFAULT-OFF pending a GPU sign-off; flipped DEFAULT-ON 2026-10-08
 * after the owner's 1070 pass (below). `?farRing=off` restores the near ring
 * only. The fog stage above is independently shippable and is ON.
 */
export function farRingEnabled() {
  // 2026-10-08 — DEFAULT ON (`?farRing=off` escape). Owner on the 1070: distant
  // hills read "drawn with ms paint" — past ~650 m the horizon fog turned the
  // terrain into pale flat cut-outs, because the drawn edge was the near ring's
  // 1056 m. With the ring the edge is (8 + 0.5) x 192 = 1632 m and the fog band
  // re-anchors to ~1010 -> 1550 m, so the hills inside it keep shape and colour.
  // Measured on the 1070 (quality ultra, 1080p, raised coastal vantage): ring
  // visible vs hidden 51.4 / 54.4 vs 53.4 / 53.8 fps (noise), +10 draws,
  // __farTerrainState().ring.policyOk true. Owner: "keep it".
  return farTerrainEnabled() && _boolOn("farRing", true);
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
 * 2026-10-08 — minimum angle, in degrees, between the fog probe and the SKY's
 * sun (`?farFogSunAvoid=<deg>`, default 45; 0 = off). Owner on the 1070,
 * dusk at the coast facing the sunset: the whole frame went orange-white.
 * The probe looks 2 deg above the horizon in the camera's azimuth, so facing a
 * low sun it sampled the sun's aureole — raw (155, 36, 3), against a scene that
 * is otherwise 0.01-0.7 — and that single colour then painted EVERY fogged
 * pixel (all terrain past ~650 m, even 30 deg off the sun), which bloom spread
 * across the frame. The fog only has to hide the streaming edge with the
 * horizon sky's colour; the directional glow toward the sun is aerial
 * perspective's job, per pixel. See `avoidSunAzimuth`.
 */
export function farFogSunAvoidDeg() {
  const raw = _param("farFogSunAvoid");
  if (raw != null && /^(off|false|no)$/i.test(String(raw))) return 0;
  return _num("farFogSunAvoid", 45, 0, 90);
}

/**
 * 2026-10-08 — turn the fog probe's horizontal forward away from the sun until
 * the probe-to-sun angle is at least `minDeg`, keeping the camera's side of the
 * sun. Pure. Three world space (Y up): `fx, fz` is the probe's normalised
 * horizontal forward, `elevRad` its elevation, `sun` the sky's sun direction.
 * Unchanged when the sun is already that far away at ANY azimuth (high sun),
 * when `minDeg <= 0`, or without a usable sun. Writes and returns `out`.
 */
export function avoidSunAzimuth(fx, fz, elevRad, sun, minDeg, out = { x: 0, z: 0 }) {
  out.x = fx; out.z = fz;
  if (!(minDeg > 0) || !sun) return out;
  const len = Math.hypot(sun.x, sun.y, sun.z);
  if (!(len > 1e-9)) return out;
  const ux = sun.x / len, uy = sun.y / len, uz = sun.z / len;
  const sh = Math.hypot(ux, uz);
  if (sh < 1e-6) return out; // sun at the zenith: every azimuth is as far
  const sx = ux / sh, sz = uz / sh;
  const cosEp = Math.cos(elevRad), sinEp = Math.sin(elevRad);
  // cos(angle) = sinEp*sinEs + cosEp*cosEs*cos(dAz) <= cos(min)  <=>  cos(dAz) <= need
  const need = (Math.cos(minDeg * Math.PI / 180) - sinEp * uy) / (cosEp * sh);
  if (!(need < 1)) return out;
  const dMin = Math.acos(Math.max(-1, need));
  // Signed azimuth of the forward from the sun: f = R(theta) s.
  const theta = Math.atan2(sx * fz - sz * fx, sx * fx + sz * fz);
  if (Math.abs(theta) >= dMin) return out;
  const phi = theta >= 0 ? dMin : -dMin;
  out.x = sx * Math.cos(phi) - sz * Math.sin(phi);
  out.z = sx * Math.sin(phi) + sz * Math.cos(phi);
  return out;
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

/**
 * 2026-10-07 — HORIZON FOG (`?horizonFog`, DEFAULT ON, `=off` escape). Owner,
 * playtesting on the 1070: "the fog is a bit much ... i mainly want it on the
 * horizon to hide if there is nothing loaded beyond the horizon, and to provide
 * a sense of depth at distance."
 *
 * The authored DAT band is retail's and it was built for a 2000-era draw
 * distance: the live dusk DayGroup measured 85 -> 796 m, so with three's
 * smoothstep terrain 200 m out was already 7 % fogged, 400 m out 41 %, and the
 * whole loaded world (R = 5, drawn edge 1056 m) sat inside the ramp. Outdoors
 * (sky visible) the band is now anchored to the DRAWN EDGE instead:
 *
 *   far  = farFogFrac x drawnEdge   (+ farFogFloor, unchanged) — the existing
 *          fog-before-edge invariant, now ALWAYS the far end, even when the
 *          authored fogMax is shorter;
 *   near = max(authored fogMin, horizonFogNear x drawnEdge).
 *
 * So the fog hides exactly the streaming edge and adds depth over the outer
 * part of the loaded world, never the near field. Indoors (sky blocked — the
 * dungeon / EnvCell case) the authored band is applied exactly as before.
 * `?horizonFog=off` restores the authored band everywhere.
 */
export function horizonFogEnabled() {
  return farTerrainEnabled() && _boolOn("horizonFog", true);
}

/**
 * Where the horizon band STARTS, as a fraction of the drawn edge
 * `(R_effective + 0.5) * 192`. `?horizonFogNear=N`, clamp [0, 0.9].
 * 0.62 at the live R = 5 => 655 m -> 1003 m. Lower = more depth haze, higher =
 * crisper mid-field. A live sweep knob, not a retail value.
 * 2026-10-07 (later): 0.45 -> 0.62. The 0.45 tune (owner: "mainly on the
 * horizon") was made while the takram aerial perspective silently never
 * reached the screen (split post chain, see atmosphere_pipeline.js
 * PostChainSourcePass); with AP's inscatter back the two hazes stacked and
 * everything past ~475 m washed to a pale sheet at Holtburg. 0.62 keeps the
 * mid-field forest in colour and still dissolves the drawn edge.
 */
export function horizonFogNearFrac() {
  return _num("horizonFogNear", 0.62, 0, 0.9);
}

/**
 * The fog-distance math of `loop.js::tickDistanceFogColor`, pure so it can be
 * unit-tested (test_fog_band.mjs). Inputs are the AUTHORED SkyState band, the
 * MEASURED near-ring radius and the flag values; returns the band to apply.
 *
 * mode:
 *   "authored" — no usable radius / clamp disabled: the authored band verbatim.
 *   "clamped"  — legacy (indoors, or `?horizonFog=off`): far clamped to the
 *                drawn edge only when the authored fogMax is beyond it; a
 *                degenerate near (>= far, boot fill) is scaled to far * 0.1.
 *   "horizon"  — 2026-10-07 default outdoors: far = the clamped edge, near =
 *                max(authored near, horizonNear x drawnEdge).
 *
 * @param {{authoredMin:number, authoredMax:number, rEffLb:number, frac:number,
 *          floorM:number, floorMinLb:number, horizon:boolean,
 *          horizonNear:number}} p
 * @returns {{near:number, far:number, drawnEdgeM:(number|null), mode:string}}
 */
export function computeFogBand(p) {
  const authoredMin = +p.authoredMin;
  const authoredMax = +p.authoredMax;
  let near = authoredMin;
  let far = authoredMax;
  let mode = "authored";
  let drawnEdgeM = null;
  const rEff = +p.rEffLb;
  const frac = +p.frac;
  if (frac > 0 && Number.isFinite(rEff) && rEff > 0) {
    drawnEdgeM = (rEff + 0.5) * 192;
    let edge = frac * drawnEdgeM;
    const floorM = +p.floorM;
    if (floorM > 0 && rEff >= +p.floorMinLb) {
      edge = Math.max(edge, Math.min(floorM, drawnEdgeM));
    }
    if (p.horizon && edge > 0) {
      far = edge;
      const hn = Math.min(0.9, Math.max(0, +p.horizonNear || 0));
      near = Math.max(Number.isFinite(authoredMin) ? authoredMin : 0, hn * drawnEdgeM);
      // A user pin like farFogFrac=0.3 can push the edge under the start:
      // keep a real ramp rather than a step.
      if (near >= far) near = far * 0.5;
      mode = "horizon";
    } else if (edge > 0 && edge < far) {
      far = edge;
      if (near >= far) near = far * 0.1;
      mode = "clamped";
    }
  }
  return { near, far, drawnEdgeM, mode };
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
