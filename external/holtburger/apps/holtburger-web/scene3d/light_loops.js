// scene3d/light_loops.js — ?lightLoops: three's point / spot light loops stay real loops
// (2026-10-06, 1070 first-turn hitch).
//
// WHY. three r184 unrolls every light loop in <lights_fragment_begin> (`#pragma
// unroll_loop_start`) so that shadow-map and spot-light-map SAMPLER arrays can be indexed by
// a constant. This client hands every lit material a fixed pool of 16 point lights + 2 spot
// lights (the count never changes — a count change relinks every program). Unrolled, each lit
// fragment shader inlines RE_Direct ~20 times (plus the default-on retail light-clamp wrapper
// around each call, materials.js `_installLightClampShaderPatch`): 89-147 k chars of GLSL.
// On the 1070 (Chrome / ANGLE / D3D11) a gpu.angle trace of the first street-level turn after
// login showed 3 programs linking, each pixel shader taking 2,858-2,966 ms in D3DCompile
// (GetPixelExecutableTask), and the GPU process stalling 244-637 ms right after each link
// finished — every WebGL frame queues behind that stall.
//
// WHAT. Point and spot lights in this client never cast shadows or carry light maps, so those
// loops never need the constant index. When a program has no point-light shadows, the point
// loop is emitted as a plain `for` — one copy of the body. Likewise the spot loop when there
// are no spot shadows and no spot light maps. The stock pragma block stays in the other #if
// branch, so a program that DOES have such shadows / maps compiles the stock unrolled code.
// Directional and hemisphere loops stay unrolled (2 + 1 copies; the CSM path shadows them);
// `?lightRangeSkip` (below) only gates the directional RE_Direct call inside its body.
//
// SAME IMAGE. The plain body is the stock body minus the shadow / light-map #if blocks the
// preprocessor already drops for these programs, and the loop runs in the unrolled order. It
// also skips RE_Direct for a light whose attenuated colour is zero (`directLight.visible`,
// set by three's getPointLightInfo / getSpotLightInfo: out of range, outside the cone): stock
// three runs the full BRDF for all 16 lights at every pixel and adds zero for those (the
// retail light clamp then caps the zero delta at zero) — skipping it is the same image minus
// that ALU, except that a NaN from a zero-colour light can no longer leak in. The RE_Direct
// call text is byte-identical, so the light-clamp wrapper still wraps it.
//
// `?lightLoops=off` keeps three's stock chunk. The patch fails closed: if the chunk text does
// not have the exact r184 shape, it is left alone and `lightLoopsPatch.reason` says why.
//
// 2026-10-20 (improvement hunt A6, building-fill-1 + building-fill-3): `?lightRangeSkip` —
// skip the work for lights that provably add nothing, still as plain shader branches (no light
// count change, so no relink; the flag is read once at boot before any program compiles).
//  1. RANGE (building-fill-1). The `directLight.visible` skip above still paid three's
//     getPointLightInfo / getSpotLightInfo for every slot: normalize + length + the distance
//     law (stock: pow, rcp, pow4 window, pow2; retail light clamp: linear saturate(1 - d/c))
//     before the colour is known to be zero. Almost every slot is out of range: the pool's idle
//     tail is parked at y = -1e5 with cutoff 1 m (lighting.js parkPoolSlot), and live DAT
//     lights reach 1.3-19.5 m. The plain point / spot bodies now test the squared distance
//     against the squared cutoff first and only call the info function (byte-identical call)
//     and RE_Direct (byte-identical call, so the light-clamp wrapper still wraps it) for a
//     light that can reach the fragment. Skipped only when cutoff > 0 and d^2 > c^2 * 1.00001:
//     there d / c >= 1 + ~5e-6, so 1 - d/c and 1 - pow4(d/c) are both negative and saturate to
//     exactly 0 — the info function would compute colour * 0 = 0 and visible = false, and the
//     body would add nothing. The margin is >= 84 float ulps on d^2: the float32 model in the
//     test stays exact with dot / mul off by 4 ulps and sqrt / div by 8 (the finder's 1.000002
//     already fails there). A cutoff <= 0 (infinite reach) or a NaN keeps the stock path (the
//     `!( ... )` form is false-safe). Nested if, no `continue`: ANGLE's loop translation is
//     unchanged.
//  2. ZERO DIRECTIONAL (building-fill-3). The legacy sun is permanently at intensity 0 on the
//     atmosphere path (index.js), both suns are 0 indoors (lighting.js pool-mode capture,
//     atmosphere_lights.js indoorMute), the ?csm cascade lights are 0 — three uploads
//     colour * intensity and getDirectionalLightInfo sets visible = true, so each paid a full
//     RE_Direct (plus the clamp wrapper) per lit pixel. RE_Direct now runs only when the
//     (shadowed) colour has a non-zero channel. Every three RE_Direct variant scales by
//     directLight.color and the clamp wrapper's delta / min / mix of zeros is zero, so a zero
//     colour adds exactly nothing (the same NaN-leak caveat as the visible skip above).
//  3. ZERO PROBE (building-fill-3). With ?ibl (default on) the SkyLightProbe is held at
//     intensity 0 ("Intensity 0, NEVER removal"), so USE_LIGHT_PROBES stays defined and every
//     lit pixel evaluated the 9-term SH of zeros. The SH is now evaluated only when the DC term
//     lightProbe[ 0 ] has a non-zero channel. Exact for any probe of non-negative radiance (its
//     DC is zero only when it is zero everywhere); for the one probe here (takram SkyLightProbe:
//     every coefficient is the sky irradiance times a constant no larger than the DC constant)
//     a zero DC means all 9 coefficients are zero.
// `?lightRangeSkip=off` (=off|0|false|no) emits exactly the previous chunk. Each gate fails
// closed on its own (`lightLoopsPatch.rangeSkipReason`); with `?lightLoops=off` none applies.
// Proven in tests/light_range_skip.test.mjs (float32 model with ulp-perturbed ops).
//
// 2026-10-20 (improvement hunt shadows-restore-3): `?csmDeadLights` — the ?csm cascade lights
// get no copy of the directional loop. csm.js setupCsm builds them as DirectionalLight
// (intensity 0, castShadow true); three sorts shadow casters first (WebGLLights
// shadowCastingAndTexturingLightsFirst), and with CSM the sun's own castShadow is never set
// (lighting.js setupSceneLighting), so the cascades are directional lights 0..2 and the only
// directional casters. Their uploaded colour is colour * intensity = 0, so their copies add
// exactly nothing — yet each lit fragment still ran their light info + zero-colour test, a
// receiveShadow fragment inside a cascade also ran three's 5-tap getShadow for each (the
// visible CSM factor is materials.js `_installCsmShaderPatch`, which ignores three's per-light
// shadow), and every lit program carried the 3 unrolled copies and 3 active
// directionalShadowMap sampler units. installCsmDeadLights wraps the directional loop BODY in
//     #if !( NUM_DIR_LIGHT_SHADOWS == 3 && UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
// three replaces NUM_DIR_LIGHT_SHADOWS before it unrolls, so the copies for the cascade
// indices preprocess away and only the non-casting directional lights are emitted: the program
// a loop starting at NUM_DIR_LIGHT_SHADOWS would give, but keyed in the GLSL on the cascade
// count, so a program with any other number of directional shadows (the ?shadows=on sun = 1,
// CSM plus a casting sun = 4, none = 0) compiles the stock loop even with the chunk patched.
// It is installed by setupCsm only (CSM owns the cascade lights; ?shadows=on without CSM never
// installs it), before any program with 3 directional shadows can exist (the cascades are made
// right there), and never undone (count-keyed, see above). No light count or castShadow
// changes. The body text is untouched, so the light-clamp split/join and the ?lightRangeSkip
// directional gate compose with it in either order. SAME IMAGE: a skipped copy added colour 0
// (times a shadow factor in [0, 1]) through RE_Direct, whose every variant scales by the
// colour, and the clamp wrapper's delta / min / mix of zeros is zero (with ?lightRangeSkip the
// gate already skipped its RE_Direct); nothing after the loop reads `directLight` or
// `directionalLight`. Same NaN-leak caveat as the visible skip above. The shadowmap_vertex
// coord loop stays stock (per vertex only; a ShadowMaterial would still read the coords).
// `?csmDeadLights=off` (=off|0|false|no) leaves the chunk as installLightLoops left it; a shape
// miss fails closed (`lightLoopsPatch.csmDeadLights.reason`). tests/csm_dead_lights.test.mjs.

const RE_DIRECT =
  "RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );";
const LOOP_END = "#pragma unroll_loop_end";

const LOOPS = [
  {
    name: "point",
    head: "#pragma unroll_loop_start\n\tfor ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {",
    // keep the stock unrolled loop when it can index a shadow sampler
    keepStock: "defined( USE_SHADOWMAP ) && NUM_POINT_LIGHT_SHADOWS > 0",
    light: "pointLight",
    body: ["pointLight = pointLights[ i ];", "getPointLightInfo( pointLight, geometryPosition, directLight );"],
  },
  {
    name: "spot",
    head: "#pragma unroll_loop_start\n\tfor ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {",
    keepStock: "( NUM_SPOT_LIGHT_MAPS > 0 ) || ( defined( USE_SHADOWMAP ) && NUM_SPOT_LIGHT_SHADOWS > 0 )",
    light: "spotLight",
    body: ["spotLight = spotLights[ i ];", "getSpotLightInfo( spotLight, geometryPosition, directLight );"],
  },
];

// ?lightRangeSkip — the squared-range margin (see header, item 1) and the zero-light gates.
const RANGE_MARGIN = "1.00001";
const rangeCondition = (light) =>
  `!( ${light}.distance > 0.0 && dot( hbRangeL, hbRangeL ) > ${light}.distance * ${light}.distance * ${RANGE_MARGIN} )`;
const DIR_HEAD = "#pragma unroll_loop_start\n\tfor ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {";
const DIR_GATE = "if ( any( notEqual( directLight.color, vec3( 0.0 ) ) ) ) {";
const PROBE_LINE = "irradiance += getLightProbeIrradiance( lightProbe, geometryNormal );";
const PROBE_GATE = "if ( any( notEqual( lightProbe[ 0 ], vec3( 0.0 ) ) ) ) {";

// The plain (one-copy) loop body. Without the range skip this is byte-for-byte the 2026-10-06
// body, so `?lightRangeSkip=off` compiles exactly the previous programs.
function plainLoop(loop, rangeSkip) {
  const head = `for ( int i = 0; i < ${loop.head.match(/i < (\w+);/)[1]}; i ++ ) {\n\n`;
  if (!rangeSkip) {
    return head + loop.body.map((l) => `\t\t${l}\n\n`).join("") +
      `\t\tif ( directLight.visible ) {\n\n\t\t\t${RE_DIRECT}\n\n\t\t}\n\n\t}`;
  }
  return head +
    `\t\t${loop.body[0]}\n\n` +
    `\t\tvec3 hbRangeL = ${loop.light}.position - geometryPosition;\n\n` +
    `\t\tif ( ${rangeCondition(loop.light)} ) {\n\n` +
    `\t\t\t${loop.body[1]}\n\n` +
    `\t\t\tif ( directLight.visible ) {\n\n\t\t\t\t${RE_DIRECT}\n\n\t\t\t}\n\n` +
    `\t\t}\n\n\t}`;
}

// Zero-colour directional / zero probe gates (header items 2 and 3). Each is applied only when
// its target has the exact r184 shape; a miss leaves that part stock and says so.
function gateZeroLights(text) {
  const gated = [];
  const misses = [];
  const start = text.indexOf(DIR_HEAD);
  const end = start < 0 ? -1 : text.indexOf(LOOP_END, start);
  const block = end < 0 ? "" : text.slice(start, end);
  if (end >= 0 && block.split(`\t\t${RE_DIRECT}`).length === 2) {
    const gatedBlock = block.replace(`\t\t${RE_DIRECT}`, `\t\t${DIR_GATE}\n\n\t\t\t${RE_DIRECT}\n\n\t\t}`);
    text = text.slice(0, start) + gatedBlock + text.slice(end);
    gated.push("dir");
  } else {
    misses.push("dir: loop shape not found");
  }
  if (text.split(PROBE_LINE).length === 2) {
    text = text.replace(PROBE_LINE, `${PROBE_GATE}\n\n\t\t\t${PROBE_LINE}\n\n\t\t}`);
    gated.push("probe");
  } else {
    misses.push("probe: line not found");
  }
  return { text, gated, reason: misses.length ? misses.join("; ") : null };
}

/**
 * Rewrite a `lights_fragment_begin` chunk so the point / spot loops are plain loops whenever
 * no shadow or light map needs the unrolled index. Pure string transform.
 * @param {string} chunk three's stock `ShaderChunk.lights_fragment_begin`
 * @param {{ rangeSkip?: boolean }} [opts] rangeSkip (default true): the ?lightRangeSkip gates
 * @returns {{ text: string, patched: string[], reason: string|null, skips: string[], skipReason: string|null }}
 */
export function patchLightLoopsChunk(chunk, opts = {}) {
  const rangeSkip = !opts || opts.rangeSkip !== false;
  const fail = (reason) => ({ text: chunk, patched: [], reason, skips: [], skipReason: null });
  if (typeof chunk !== "string") return fail("no chunk");
  if (chunk.includes("__hbLightLoops")) return fail("already patched");
  let text = chunk;
  const patched = [];
  for (const loop of LOOPS) {
    const start = text.indexOf(loop.head);
    if (start < 0) return fail(`${loop.name}: loop head not found`);
    const end = text.indexOf(LOOP_END, start);
    if (end < 0) return fail(`${loop.name}: loop end not found`);
    const block = text.slice(start, end + LOOP_END.length);
    if (block.split(RE_DIRECT).length !== 2) return fail(`${loop.name}: expected one RE_Direct call`);
    for (const line of loop.body) {
      if (!block.includes(line)) return fail(`${loop.name}: body line not found: ${line}`);
    }
    const plain = plainLoop(loop, rangeSkip);
    const repl = `// __hbLightLoops ${loop.name}\n\t#if ${loop.keepStock}\n\t${block}\n\t#else\n\t${plain}\n\t#endif`;
    text = text.slice(0, start) + repl + text.slice(end + LOOP_END.length);
    patched.push(loop.name);
  }
  if (!rangeSkip) return { text, patched, reason: null, skips: [], skipReason: null };
  const g = gateZeroLights(text);
  return { text: g.text, patched, reason: null, skips: [...patched.map((n) => `${n}-range`), ...g.gated], skipReason: g.reason };
}

/** `?lightLoops=off` restores three's stock (fully unrolled) light loops. DEFAULT ON. */
export function lightLoopsEnabled() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = (new URLSearchParams(window.location.search).get("lightLoops") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "unrolled");
  } catch (_) {
    return true;
  }
}

/**
 * `?lightRangeSkip=off` (=off|0|false|no) drops the 2026-10-20 zero-light early-outs (range
 * test, zero directional, zero probe) and keeps the previous plain loops. DEFAULT ON. Read once,
 * by installLightLoops at boot, before any program compiles.
 */
export function lightRangeSkipEnabled() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = (new URLSearchParams(window.location.search).get("lightRangeSkip") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
}

/**
 * Diag surface: what the install did (window.__lightLoops mirrors it). `rangeSkip` lists the
 * ?lightRangeSkip gates that went in ("point-range", "spot-range", "dir", "probe");
 * `rangeSkipReason` says why one did not (flag off, or a chunk shape miss).
 */
export const lightLoopsPatch = { installed: false, patched: [], reason: null, rangeSkip: [], rangeSkipReason: null };

/**
 * ?csmDeadLights diag (header, shadows-restore-3): `installed`, the cascade count the GLSL gate
 * is keyed on, and why it is not installed (flag off, chunk shape miss). Also reachable as
 * `window.__lightLoops.csmDeadLights`.
 */
export const csmDeadLightsPatch = { installed: false, cascades: 0, reason: null };
lightLoopsPatch.csmDeadLights = csmDeadLightsPatch;

/** Test seam. */
export function __resetLightLoopsForTest() {
  lightLoopsPatch.installed = false;
  lightLoopsPatch.patched = [];
  lightLoopsPatch.reason = null;
  lightLoopsPatch.rangeSkip = [];
  lightLoopsPatch.rangeSkipReason = null;
}

/**
 * Patch `THREE.ShaderChunk.lights_fragment_begin` in place. Must run before the first program
 * compiles (scene3d/index.js preInit3D, right before the WebGLRenderer is built); programs
 * compiled earlier keep the stock text. Idempotent.
 * @param {{ ShaderChunk: Record<string, string> }} three the THREE namespace
 */
export function installLightLoops(three) {
  if (lightLoopsPatch.installed) return lightLoopsPatch;
  lightLoopsPatch.rangeSkip = [];
  if (!lightLoopsEnabled()) {
    lightLoopsPatch.reason = "?lightLoops=off";
    lightLoopsPatch.rangeSkipReason = "?lightLoops=off";
  } else if (!three || !three.ShaderChunk) {
    lightLoopsPatch.reason = "no ShaderChunk";
  } else {
    // ?lightRangeSkip (2026-10-20): read once here, before any program compiles.
    const rangeSkip = lightRangeSkipEnabled();
    const r = patchLightLoopsChunk(three.ShaderChunk.lights_fragment_begin, { rangeSkip });
    lightLoopsPatch.patched = r.patched;
    lightLoopsPatch.reason = r.reason;
    lightLoopsPatch.rangeSkipReason = rangeSkip ? (r.reason || r.skipReason) : "?lightRangeSkip=off";
    if (r.patched.length) {
      three.ShaderChunk.lights_fragment_begin = r.text;
      lightLoopsPatch.installed = true;
      lightLoopsPatch.rangeSkip = r.skips;
    }
  }
  try {
    if (typeof window !== "undefined") window.__lightLoops = lightLoopsPatch;
  } catch (_) { /* fail-soft */ }
  if (lightLoopsPatch.reason && lightLoopsPatch.reason !== "?lightLoops=off") {
    try { console.warn(`[lightLoops] stock light loops kept: ${lightLoopsPatch.reason}`); } catch (_) { /* fail-soft */ }
  } else if (lightLoopsPatch.installed && lightLoopsPatch.rangeSkipReason && lightLoopsPatch.rangeSkipReason !== "?lightRangeSkip=off") {
    try { console.warn(`[lightLoops] some ?lightRangeSkip gates kept stock: ${lightLoopsPatch.rangeSkipReason}`); } catch (_) { /* fail-soft */ }
  }
  return lightLoopsPatch;
}

// ?csmDeadLights (header, shadows-restore-3) — the stock r184 directional loop, exact anchors.
const CSM_DEAD_MARK = "__hbCsmDeadLights";
const DIR_BODY_FIRST = "\n\t\tdirectionalLight = directionalLights[ i ];";
const DIR_INFO = "getDirectionalLightInfo( directionalLight, directLight );";
const DIR_SHADOW_IF = "#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )";
const DIR_TAIL = "\n\t}\n\t";

/**
 * Wrap the directional loop body of a `lights_fragment_begin` chunk (stock, or already through
 * patchLightLoopsChunk) so the unrolled copies for the first `cascades` directional lights are
 * preprocessed away when — and only when — the program has exactly `cascades` directional
 * shadows. Pure string transform; fails closed (text unchanged) on any shape miss.
 * @param {string} chunk
 * @param {number} [cascades=3] csm.js cascade light count
 * @returns {{ text: string, patched: boolean, reason: string|null }}
 */
export function patchCsmDeadLightsChunk(chunk, cascades = 3) {
  const fail = (reason) => ({ text: chunk, patched: false, reason });
  if (typeof chunk !== "string") return fail("no chunk");
  if (!Number.isInteger(cascades) || cascades < 1) return fail(`bad cascade count: ${cascades}`);
  if (chunk.includes(CSM_DEAD_MARK)) return fail("already patched");
  const start = chunk.indexOf(DIR_HEAD);
  if (start < 0) return fail("directional loop head not found");
  if (chunk.indexOf(DIR_HEAD, start + 1) >= 0) return fail("more than one directional loop head");
  const end = chunk.indexOf(LOOP_END, start);
  if (end < 0) return fail("directional loop end not found");
  const block = chunk.slice(start, end);
  if (block.indexOf("#pragma unroll_loop_start", 1) >= 0) return fail("nested unrolled loop");
  // the body's first statement is the light fetch (blank lines vary: the three build strips them)
  if (!block.slice(DIR_HEAD.length).replace(/^\n+/, "\n").startsWith(DIR_BODY_FIRST)) return fail("directional body does not start with the light fetch");
  if (!block.endsWith(DIR_TAIL)) return fail("directional loop tail not found");
  if (block.split(RE_DIRECT).length !== 2) return fail("expected one directional RE_Direct call");
  if (block.split(DIR_INFO).length !== 2) return fail("expected one getDirectionalLightInfo call");
  // the casters-first index test three's own shadow branch relies on
  if (block.split(DIR_SHADOW_IF).length !== 2) return fail("stock directional shadow branch not found");
  const body = block.slice(DIR_HEAD.length, block.length - DIR_TAIL.length);
  const cond = `!( NUM_DIR_LIGHT_SHADOWS == ${cascades} && UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )`;
  const patched =
    `// ${CSM_DEAD_MARK}: with exactly ${cascades} directional shadows (the ?csm cascade lights, intensity 0) their copies are not emitted\n\t` +
    `${DIR_HEAD}\n\t\t#if ${cond}${body}\n\t\t#endif${DIR_TAIL}`;
  return { text: chunk.slice(0, start) + patched + chunk.slice(end), patched: true, reason: null };
}

/**
 * `?csmDeadLights=off` (=off|0|false|no) keeps the cascade lights' copies of the directional
 * loop. DEFAULT ON (acts only under ?csm). Read by installCsmDeadLights, once per setupCsm.
 */
export function csmDeadLightsEnabled() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = (new URLSearchParams(window.location.search).get("csmDeadLights") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
}

/** Test seam. */
export function __resetCsmDeadLightsForTest() {
  csmDeadLightsPatch.installed = false;
  csmDeadLightsPatch.cascades = 0;
  csmDeadLightsPatch.reason = null;
}

/**
 * Patch `THREE.ShaderChunk.lights_fragment_begin` for the ?csm cascade lights. Called by csm.js
 * setupCsm (through `globalThis.__hbInstallCsmDeadLights`, below) right after it builds the
 * cascades, so no program with their shadow count exists yet. Idempotent; never undone (the
 * GLSL gate is keyed on the cascade count, see header).
 * @param {{ ShaderChunk: Record<string, string> }} three the THREE namespace
 * @param {number} [cascades=3]
 */
export function installCsmDeadLights(three, cascades = 3) {
  if (csmDeadLightsPatch.installed) return csmDeadLightsPatch;
  if (!csmDeadLightsEnabled()) {
    csmDeadLightsPatch.reason = "?csmDeadLights=off";
  } else if (!three || !three.ShaderChunk) {
    csmDeadLightsPatch.reason = "no ShaderChunk";
  } else {
    const r = patchCsmDeadLightsChunk(three.ShaderChunk.lights_fragment_begin, cascades);
    csmDeadLightsPatch.reason = r.reason;
    if (r.patched) {
      three.ShaderChunk.lights_fragment_begin = r.text;
      csmDeadLightsPatch.installed = true;
      csmDeadLightsPatch.cascades = cascades;
    }
  }
  if (csmDeadLightsPatch.reason && csmDeadLightsPatch.reason !== "?csmDeadLights=off") {
    try { console.warn(`[lightLoops] ?csmDeadLights kept the stock directional loop: ${csmDeadLightsPatch.reason}`); } catch (_) { /* fail-soft */ }
  }
  return csmDeadLightsPatch;
}

// The hook csm.js calls. A global, not an import: several legacy tests load csm.js's source into
// `new Function` with only its `three` import stripped, where an import line is a SyntaxError.
// index.js imports this module statically, so the hook exists before init3D runs setupCsm; where
// this module is not loaded, setupCsm finds no hook and the stock loop stays.
try {
  if (typeof globalThis !== "undefined") globalThis.__hbInstallCsmDeadLights = installCsmDeadLights;
} catch (_) { /* fail-soft */ }
