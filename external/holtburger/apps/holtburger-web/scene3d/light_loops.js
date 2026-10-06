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
// Directional and hemisphere loops are untouched (2 + 1 copies; the CSM path shadows them).
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

const RE_DIRECT =
  "RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );";
const LOOP_END = "#pragma unroll_loop_end";

const LOOPS = [
  {
    name: "point",
    head: "#pragma unroll_loop_start\n\tfor ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {",
    // keep the stock unrolled loop when it can index a shadow sampler
    keepStock: "defined( USE_SHADOWMAP ) && NUM_POINT_LIGHT_SHADOWS > 0",
    body: ["pointLight = pointLights[ i ];", "getPointLightInfo( pointLight, geometryPosition, directLight );"],
  },
  {
    name: "spot",
    head: "#pragma unroll_loop_start\n\tfor ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {",
    keepStock: "( NUM_SPOT_LIGHT_MAPS > 0 ) || ( defined( USE_SHADOWMAP ) && NUM_SPOT_LIGHT_SHADOWS > 0 )",
    body: ["spotLight = spotLights[ i ];", "getSpotLightInfo( spotLight, geometryPosition, directLight );"],
  },
];

/**
 * Rewrite a `lights_fragment_begin` chunk so the point / spot loops are plain loops whenever
 * no shadow or light map needs the unrolled index. Pure string transform.
 * @param {string} chunk three's stock `ShaderChunk.lights_fragment_begin`
 * @returns {{ text: string, patched: string[], reason: string|null }}
 */
export function patchLightLoopsChunk(chunk) {
  if (typeof chunk !== "string") return { text: chunk, patched: [], reason: "no chunk" };
  if (chunk.includes("__hbLightLoops")) return { text: chunk, patched: [], reason: "already patched" };
  let text = chunk;
  const patched = [];
  for (const loop of LOOPS) {
    const start = text.indexOf(loop.head);
    if (start < 0) return { text: chunk, patched: [], reason: `${loop.name}: loop head not found` };
    const end = text.indexOf(LOOP_END, start);
    if (end < 0) return { text: chunk, patched: [], reason: `${loop.name}: loop end not found` };
    const block = text.slice(start, end + LOOP_END.length);
    if (block.split(RE_DIRECT).length !== 2) return { text: chunk, patched: [], reason: `${loop.name}: expected one RE_Direct call` };
    for (const line of loop.body) {
      if (!block.includes(line)) return { text: chunk, patched: [], reason: `${loop.name}: body line not found: ${line}` };
    }
    const plain =
      `for ( int i = 0; i < ${loop.head.match(/i < (\w+);/)[1]}; i ++ ) {\n\n` +
      loop.body.map((l) => `\t\t${l}\n\n`).join("") +
      `\t\tif ( directLight.visible ) {\n\n\t\t\t${RE_DIRECT}\n\n\t\t}\n\n\t}`;
    const repl = `// __hbLightLoops ${loop.name}\n\t#if ${loop.keepStock}\n\t${block}\n\t#else\n\t${plain}\n\t#endif`;
    text = text.slice(0, start) + repl + text.slice(end + LOOP_END.length);
    patched.push(loop.name);
  }
  return { text, patched, reason: null };
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

/** Diag surface: what the install did (window.__lightLoops mirrors it). */
export const lightLoopsPatch = { installed: false, patched: [], reason: null };

/** Test seam. */
export function __resetLightLoopsForTest() {
  lightLoopsPatch.installed = false;
  lightLoopsPatch.patched = [];
  lightLoopsPatch.reason = null;
}

/**
 * Patch `THREE.ShaderChunk.lights_fragment_begin` in place. Must run before the first program
 * compiles (scene3d/index.js preInit3D, right before the WebGLRenderer is built); programs
 * compiled earlier keep the stock text. Idempotent.
 * @param {{ ShaderChunk: Record<string, string> }} three the THREE namespace
 */
export function installLightLoops(three) {
  if (lightLoopsPatch.installed) return lightLoopsPatch;
  if (!lightLoopsEnabled()) {
    lightLoopsPatch.reason = "?lightLoops=off";
  } else if (!three || !three.ShaderChunk) {
    lightLoopsPatch.reason = "no ShaderChunk";
  } else {
    const r = patchLightLoopsChunk(three.ShaderChunk.lights_fragment_begin);
    lightLoopsPatch.patched = r.patched;
    lightLoopsPatch.reason = r.reason;
    if (r.patched.length) {
      three.ShaderChunk.lights_fragment_begin = r.text;
      lightLoopsPatch.installed = true;
    }
  }
  try {
    if (typeof window !== "undefined") window.__lightLoops = lightLoopsPatch;
  } catch (_) { /* fail-soft */ }
  if (lightLoopsPatch.reason && lightLoopsPatch.reason !== "?lightLoops=off") {
    try { console.warn(`[lightLoops] stock light loops kept: ${lightLoopsPatch.reason}`); } catch (_) { /* fail-soft */ }
  }
  return lightLoopsPatch;
}
