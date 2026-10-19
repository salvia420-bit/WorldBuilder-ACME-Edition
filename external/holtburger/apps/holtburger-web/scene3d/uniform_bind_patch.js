// scene3d/uniform_bind_patch.js — three exact-output trims of three r184's
// per-draw texture-bind and light-uniform churn (fps wave 2, card "binds",
// 2026-10-17). All act on each WebGLProgram's own uniform objects, the first
// time three asks for them (plus one declaration edit in a shader chunk, the
// same seam light_loops.js uses); none forks or edits three.
//
// MEASURED CONTEXT. 1070, ultra, Linvak Tukal after wave 1 (51 fps, main
// thread 99.7% busy): `setProgram` is 3.0 ms/frame (2.5 ms of it in the world
// pass, 329 draws), of which `WebGLUniforms.upload` 1.41 ms (texture setters
// 0.39, the light structs 0.30+), per-object matrices 0.60, the material
// refresh 0.35. At pagoda hill ~5,400 WebGL calls/frame, 45% texture binds
// (activeTexture + bindTexture). Chrome's GPU process decodes and validates
// every one of those calls.
//
// 1. `?texUnitPin` (DEFAULT ON, `=off|0|false|no` escape) — STABLE TEXTURE
//    UNITS FOR SCENE-WIDE SAMPLERS. three allocates texture units per draw
//    from 0 in uniform order (`textures.resetTextureUnits()` at the top of
//    setProgram, `allocateTextureUnit()` per sampler), and its bind cache
//    (`WebGLState.bindTexture`) is per unit. So a texture that EVERY lit
//    program samples — three r184's DFG LUT (`dfgLUT`, every
//    MeshStandardMaterial), the IBL PMREM (`envMap`, `?ibl` default on), the
//    detail tile (`uDetailMap`), the CSM maps, the anim-scenery pose texture —
//    lands on a different unit in each program (`map`=0/`envMap`=1/`dfgLUT`=2
//    in a plain surface program, `batchingTexture`=0/`batchingIdTexture`=1/
//    `map`=2/`envMap`=3/`dfgLUT`=4 in a BatchedMesh one, ...), and every
//    program switch rebinds it: activeTexture + bindTexture, twice per shared
//    texture. Here each such sampler gets a FIXED unit at the top of the unit
//    range (dfgLUT = maxTextures-1, envMap = maxTextures-2, ...): three's own
//    setter still runs (empty-texture fallback, shadow compare mode, texture
//    upload on version bump, the uniform1i cache), only the unit it is handed
//    is fixed, via three's public `textures.getTextureUnits/setTextureUnits`.
//    After the first frame those textures stay bound across program switches
//    and three's bind cache skips them.
//    SAFETY. A unit may not be shared by two sampler TYPES inside one program
//    (GL INVALID_OPERATION at draw). A program is pinned only when its
//    dynamically allocated units provably stay below its lowest pinned unit:
//    passes x (total sampler units - pinned) <= lowest pin, with passes = 2
//    for anything but a built-in material (three uploads a ShaderMaterial a
//    second time when `uniformsNeedUpdate` is set; nothing here sets it, the
//    margin is kept anyway). Otherwise the program is left exactly as three
//    built it. Every sampler still reads the same texture it did; only the
//    unit index differs.
//
// 2. `?lightUbo` (DEFAULT ON, `=off|0|false|no` escape) — THE LIGHT ARRAYS AS
//    UNIFORM BLOCKS. Each lit program holds its own copy of every light
//    uniform, and the view-space ones (16 point positions, 6 directional + 2
//    spot directions, ...) change whenever the camera moves, so every lit
//    program used in a frame re-sends ~26 uniform3f calls. `installLightUboChunks`
//    edits three's `lights_pars_begin` so that, under `#ifdef HB_LIGHT_UBO`,
//    `directionalLights` / `pointLights` / `spotLights` / `hemisphereLights`
//    are the only member of an instance-less std140 block each — member names
//    stay global, so no shader line that reads them changes — and the stock
//    declaration otherwise. The define is injected by THIS renderer's
//    `gl.shaderSource` only, so other renderers in the page (paperdoll, dye
//    viewports) compile the stock branch. Per program: each active block is
//    bound to a fixed binding point (top of MAX_UNIFORM_BUFFER_BINDINGS), its
//    buffer grown to UNIFORM_BLOCK_DATA_SIZE, the member offsets read from the
//    DRIVER (getActiveUniforms UNIFORM_OFFSET — no hand-written std140 table),
//    and three's StructuredUniform for the array replaced by a sentinel: when
//    three would re-walk the lights (program switch / camera change) the
//    sentinel writes the render state's light array into the shared buffer
//    once per (render() — renderer.info.render.frame, bumped by every render
//    call, nested ones included; camera — its projectionMatrix object, taken
//    from the program's projectionMatrix setter, which setProgram always runs
//    before a light re-upload; light array — per render state), one
//    bufferSubData. A nested render with other lights rewrites it and the
//    outer render's next lit draw rewrites it back (three resets its camera
//    at every render() end, so that draw always refreshes lights).
//
// 3. `?lightUploadOnce` (DEFAULT ON, `=off|0|false|no` escape) — the light
//    uniforms NOT in blocks (ambient, light probe, shadow structs; all of them
//    with `?lightUbo=off`) walked once per (program, render(), camera) instead
//    of on every program switch, same memo key. The skipped walk would have
//    issued zero GL calls. Built-in lit materials only, whose light uniforms
//    only three writes.
//
// EXACTNESS of all three is proven draw-by-draw at the GL level in
// tests/uniform_bind_patch.test.mjs: three r184's real renderer over a fake
// WebGL2 (tests/helpers/fake_webgl2.mjs) that tracks uniform values per
// program, texture bindings per unit/target and uniform buffers, resolves
// every sampler of every draw to the texture it reads and every block member
// to the value at its std140 offset in the buffer bound at its binding point
// (laid out independently of this file), and compares stock vs patched.
//
// NOT DONE HERE, and why (see docs/url-flags.md rows and the card report):
//   - the shadow-struct uniforms (directionalLightShadows etc.) and the
//     shadow matrices stay plain uniforms: with `?csm` off they are absent.
//   - merging the region static batches further: measured closed-negative
//     (`?statArrayMerge` 0.0 ms on the 1070; coarsening the 3x3 region key
//     0.00 ms, 1.1 ms worse at regionDiv=12 — url-flags.md statArrayMerge).

import * as THREE from "three";

const SAMPLER_TYPES = new Set([
  0x8b5e, 0x8b5f, 0x8b60, 0x8b62, 0x8d66, 0x8dc1, 0x8dc4, 0x8dc5,
  0x8dca, 0x8dcb, 0x8dcc, 0x8dcf, 0x8dd2, 0x8dd3, 0x8dd4, 0x8dd7,
]);

/** Sampler uniform names whose texture is one object shared by many programs,
 *  most frequent first (it gets the highest unit). */
export const PIN_NAMES = Object.freeze([
  "dfgLUT", // three r184: every MeshStandard/Physical program, one DataTexture
  "envMap", // ?ibl (default on): scene.environment PMREM, every standard program
  "uDetailMap", // materials.js detail patch: a handful of shared detail tiles
  "hbAiPoseTex", // anim_scenery_gpu.js: one shared pose texture uniform
  "uCsmShadowMap0", "uCsmShadowMap1", "uCsmShadowMap2", // ?csm receivers + terrain
]);

/** Three's light uniforms that `markUniformsLightsNeedsUpdate` toggles. */
export const LIGHT_UNIFORM_NAMES = Object.freeze([
  "ambientLightColor", "lightProbe", "directionalLights", "directionalLightShadows",
  "spotLights", "spotLightShadows", "rectAreaLights", "pointLights",
  "pointLightShadows", "hemisphereLights",
]);

const LIT_BUILTIN = new Set([
  "MeshStandardMaterial", "MeshPhysicalMaterial", "MeshLambertMaterial",
  "MeshPhongMaterial", "MeshToonMaterial",
]);
// Materials three uploads at most once per setProgram (only `isShaderMaterial`
// takes the second `uniformsNeedUpdate` upload).
const ONE_PASS = new Set([
  ...LIT_BUILTIN, "MeshBasicMaterial", "MeshMatcapMaterial", "MeshNormalMaterial",
  "MeshDepthMaterial", "MeshDistanceMaterial", "LineBasicMaterial", "LineDashedMaterial",
  "PointsMaterial", "SpriteMaterial", "ShadowMaterial",
]);

function _search(search) {
  if (search !== undefined) return search;
  try {
    return (globalThis.location && globalThis.location.search) || "";
  } catch (_) {
    return "";
  }
}

let _pinFlag, _lightFlag;
/** `?texUnitPin` — DEFAULT ON; only an explicit off-form disarms. */
export function texUnitPinEnabled(search) {
  if (search === undefined && _pinFlag !== undefined) return _pinFlag;
  let on = true;
  try {
    const v = (new URLSearchParams(_search(search)).get("texUnitPin") || "").toLowerCase();
    if (v === "off" || v === "0" || v === "false" || v === "no") on = false;
  } catch (_) { on = true; }
  if (search === undefined) _pinFlag = on;
  return on;
}
/** `?lightUploadOnce` — DEFAULT ON; only an explicit off-form disarms. */
export function lightUploadOnceEnabled(search) {
  if (search === undefined && _lightFlag !== undefined) return _lightFlag;
  let on = true;
  try {
    const v = (new URLSearchParams(_search(search)).get("lightUploadOnce") || "").toLowerCase();
    if (v === "off" || v === "0" || v === "false" || v === "no") on = false;
  } catch (_) { on = true; }
  if (search === undefined) _lightFlag = on;
  return on;
}

let _uboFlag;
/** `?lightUbo` — DEFAULT ON; only an explicit off-form disarms. */
export function lightUboEnabled(search) {
  if (search === undefined && _uboFlag !== undefined) return _uboFlag;
  let on = true;
  try {
    const v = (new URLSearchParams(_search(search)).get("lightUbo") || "").toLowerCase();
    if (v === "off" || v === "0" || v === "false" || v === "no") on = false;
  } catch (_) { on = true; }
  if (search === undefined) _uboFlag = on;
  return on;
}

// ---------------------------------------------------------------------------
// ?lightUbo — the four light-struct arrays as std140 uniform blocks
// ---------------------------------------------------------------------------

/** The light arrays moved into uniform blocks: three's field names (WebGLLights
 *  UniformsCache) with their component counts. */
export const LIGHT_BLOCKS = Object.freeze([
  { name: "directionalLights", struct: "DirectionalLight", count: "NUM_DIR_LIGHTS", block: "hbDirectionalLightsUbo",
    fields: [["direction", 3], ["color", 3]] },
  { name: "pointLights", struct: "PointLight", count: "NUM_POINT_LIGHTS", block: "hbPointLightsUbo",
    fields: [["position", 3], ["color", 3], ["distance", 1], ["decay", 1]] },
  { name: "spotLights", struct: "SpotLight", count: "NUM_SPOT_LIGHTS", block: "hbSpotLightsUbo",
    fields: [["position", 3], ["direction", 3], ["color", 3], ["distance", 1], ["decay", 1], ["coneCos", 1], ["penumbraCos", 1]] },
  { name: "hemisphereLights", struct: "HemisphereLight", count: "NUM_HEMI_LIGHTS", block: "hbHemisphereLightsUbo",
    fields: [["direction", 3], ["skyColor", 3], ["groundColor", 3]] },
]);
export const LIGHT_UBO_DEFINE = "HB_LIGHT_UBO";

/**
 * Rewrite three's `lights_pars_begin` so each light-struct array declaration
 * becomes, under `#ifdef HB_LIGHT_UBO`, the same array as the only member of an
 * instance-less std140 uniform block — member names stay global, so every
 * shader line that reads `pointLights[ i ]` is untouched — and stays the stock
 * declaration otherwise. Returns null (and nothing is patched) if the chunk
 * does not contain all four stock declarations verbatim.
 */
export function lightUboChunkText(src) {
  if (typeof src !== "string" || src.indexOf(LIGHT_UBO_DEFINE) !== -1) return null;
  let out = src;
  for (const b of LIGHT_BLOCKS) {
    const decl = `uniform ${b.struct} ${b.name}[ ${b.count} ];`;
    if (out.split(decl).length !== 2) return null;
    out = out.replace(decl,
      `#ifdef ${LIGHT_UBO_DEFINE}\n\tlayout( std140 ) uniform ${b.block} { ${b.struct} ${b.name}[ ${b.count} ]; };\n#else\n\t${decl}\n#endif`);
  }
  return out;
}

/**
 * Patch THREE.ShaderChunk.lights_pars_begin (index.js preInit3D, before any
 * compile — the same seam as light_loops.js). INERT on its own: only a context
 * whose `shaderSource` injects `#define HB_LIGHT_UBO` (installUniformBindPatch,
 * main renderer only) compiles the block branch; every other renderer in the
 * page (paperdoll / dye viewports) keeps the stock declarations.
 */
export function installLightUboChunks(THREE, opts = {}) {
  const on = opts.force !== undefined ? !!opts.force : lightUboEnabled();
  const sc = THREE && THREE.ShaderChunk;
  if (!on || !sc) return false;
  if (typeof sc.lights_pars_begin === "string" && sc.lights_pars_begin.indexOf(`#ifdef ${LIGHT_UBO_DEFINE}`) !== -1) return true;
  const t = lightUboChunkText(sc.lights_pars_begin);
  if (!t) return false;
  sc.lights_pars_begin = t;
  return true;
}

/** `#define HB_LIGHT_UBO` after the `#version` line of a source that uses it. */
export function injectLightUboDefine(src) {
  if (typeof src !== "string" || src.indexOf(`#ifdef ${LIGHT_UBO_DEFINE}`) === -1) return src;
  if (src.startsWith("#version")) {
    const nl = src.indexOf("\n");
    return `${src.slice(0, nl + 1)}#define ${LIGHT_UBO_DEFINE}\n${src.slice(nl + 1)}`;
  }
  return `#define ${LIGHT_UBO_DEFINE}\n${src}`;
}

/** Fixed unit per pinned name for a context whose three-side unit limit is
 *  `maxTextures` (renderer.capabilities.maxTextures). Names whose unit would
 *  fall below 8 are not pinned (a tiny-limit context keeps three's layout). */
export function pinUnitsFor(maxTextures, names = PIN_NAMES) {
  const m = new Map();
  const top = (maxTextures | 0) - 1;
  for (let i = 0; i < names.length; i++) {
    const u = top - i;
    if (u < 8) break;
    m.set(names[i], u);
  }
  return m;
}

function _countSamplerUnits(seq) {
  let n = 0;
  for (let i = 0; i < seq.length; i++) {
    const u = seq[i];
    if (u.seq !== undefined) n += _countSamplerUnits(u.seq);
    else if (SAMPLER_TYPES.has(u.type)) n += u.size !== undefined ? u.size : 1;
  }
  return n;
}

/**
 * Plan the pins for one program's uniforms. Pure (exported for the suite).
 * @returns {{ pins: Array<{u: object, unit: number}>, total: number, eligible: boolean, reason: string }}
 */
export function planProgramPins(uniforms, programType, pinUnits) {
  const seq = uniforms && uniforms.seq;
  if (!Array.isArray(seq)) return { pins: [], total: 0, eligible: false, reason: "no-seq" };
  const total = _countSamplerUnits(seq);
  const pins = [];
  for (let i = 0; i < seq.length; i++) {
    const u = seq[i];
    // Top-level single samplers only (an array sampler allocates a run of units).
    if (u.seq !== undefined || u.size !== undefined || !SAMPLER_TYPES.has(u.type)) continue;
    const unit = pinUnits.get(u.id);
    if (unit !== undefined) pins.push({ u, unit });
  }
  if (pins.length === 0) return { pins, total, eligible: false, reason: "none" };
  let lowest = Infinity;
  for (const p of pins) if (p.unit < lowest) lowest = p.unit;
  const passes = ONE_PASS.has(programType) ? 1 : 2;
  const dynamicUnits = passes * (total - pins.length);
  if (dynamicUnits > lowest) return { pins: [], total, eligible: false, reason: "crowded" };
  return { pins, total, eligible: true, reason: "ok" };
}

function _pinnedSetter(orig, unit) {
  return function pinnedSampler(gl, v, textures) {
    if (textures === undefined || typeof textures.setTextureUnits !== "function") {
      return orig.call(this, gl, v, textures);
    }
    const saved = textures.getTextureUnits();
    textures.setTextureUnits(unit);
    try {
      orig.call(this, gl, v, textures);
    } finally {
      textures.setTextureUnits(saved);
    }
  };
}

function _lightOnceSetter(orig, st) {
  let lastV = null;
  let lastFrame = -1;
  let lastCam = null;
  return function lightOnce(gl, v, textures) {
    const frame = st.renderer.info.render.frame; // info is replaced on context restore
    if (v === lastV && frame === lastFrame && st.cam === lastCam && v !== null && v !== undefined && !st.lightOff) {
      st.stats.lightSkips++;
      return;
    }
    orig.call(this, gl, v, textures);
    lastV = v;
    lastFrame = frame;
    lastCam = st.cam;
    st.stats.lightUploads++;
  };
}

function _camSetter(orig, st) {
  return function camTrack(gl, v, textures) {
    st.cam = v;
    return orig.call(this, gl, v, textures);
  };
}

const INVALID_INDEX = 0xffffffff;

function _uboInit(st) {
  const gl = st.gl;
  const UB = gl.UNIFORM_BUFFER, DYNAMIC_DRAW = gl.DYNAMIC_DRAW;
  const maxBp = gl.getParameter(gl.MAX_UNIFORM_BUFFER_BINDINGS) | 0;
  st.blocks = Object.create(null);
  for (let i = 0; i < LIGHT_BLOCKS.length; i++) {
    const def = LIGHT_BLOCKS[i];
    const bytes = 256;
    const buf = gl.createBuffer();
    gl.bindBuffer(UB, buf);
    gl.bufferData(UB, bytes, DYNAMIC_DRAW);
    gl.bindBufferBase(UB, maxBp - 1 - i, buf); // also sets the generic binding
    gl.bindBuffer(UB, null);
    st.blocks[def.name] = {
      def, bp: maxBp - 1 - i, buf, bytes, f32: new Float32Array(bytes / 4), layout: null,
      lastV: null, lastFrame: -1, lastCam: null, valid: false,
    };
  }
  // The define rides THIS context's shaderSource only.
  if (gl.shaderSource && gl.shaderSource.__hbLightUbo !== true) {
    const orig = gl.shaderSource;
    const wrapped = function hbLightUboShaderSource(shader, src) {
      return orig.call(this, shader, injectLightUboDefine(src));
    };
    wrapped.__hbLightUbo = true;
    gl.shaderSource = wrapped;
  }
}

function _uboEnsure(st, ub, glp, count, size) {
  const gl = st.gl;
  const UB = gl.UNIFORM_BUFFER;
  if (size > ub.bytes) {
    let bytes = ub.bytes;
    while (bytes < size) bytes *= 2;
    gl.bindBuffer(UB, ub.buf);
    gl.bufferData(UB, bytes, gl.DYNAMIC_DRAW); // contents discarded: rewritten at the next sentinel call
    gl.bindBuffer(UB, null);
    const f = new Float32Array(bytes / 4);
    f.set(ub.f32);
    ub.f32 = f;
    ub.bytes = bytes;
    ub.valid = false;
    st.stats.uboGrows++;
  }
  if (ub.layout && ub.layout.count >= count) return;
  // Offsets come from the driver (getActiveUniforms UNIFORM_OFFSET), never
  // from a hand-written std140 table.
  const def = ub.def;
  const nf = def.fields.length;
  const names = [];
  for (let i = 0; i < count; i++) for (const [f] of def.fields) names.push(`${def.name}[${i}].${f}`);
  const idx = gl.getUniformIndices(glp, names);
  const offs = gl.getActiveUniforms(glp, idx, gl.UNIFORM_OFFSET);
  const layout = { count, nf, offs: new Int32Array(count * nf), comps: def.fields.map((f) => f[1]), keys: def.fields.map((f) => f[0]), floats: 0 };
  for (let k = 0; k < names.length; k++) {
    const ok = idx[k] !== INVALID_INDEX && idx[k] !== -1 && offs[k] >= 0;
    layout.offs[k] = ok ? offs[k] >> 2 : -1;
    if (ok) layout.floats = Math.max(layout.floats, (offs[k] >> 2) + layout.comps[k % nf]);
  }
  if (ub.layout) {
    const old = ub.layout;
    for (let k = 0; k < old.offs.length; k++) if (old.offs[k] !== layout.offs[k]) { st.stats.uboLayoutMismatch++; break; }
  }
  ub.layout = layout;
  ub.valid = false;
}

function _uboWrite(st, ub, v) {
  const L = ub.layout;
  const f32 = ub.f32;
  const n = Math.min(v.length, L.count);
  const nf = L.nf;
  let floats = 0;
  for (let i = 0; i < n; i++) {
    const item = v[i];
    for (let k = 0; k < nf; k++) {
      const o = L.offs[i * nf + k];
      if (o < 0) continue;
      const val = item[L.keys[k]];
      if (L.comps[k] === 1) {
        f32[o] = val;
        if (o + 1 > floats) floats = o + 1;
      } else {
        if (val.isColor === true) { f32[o] = val.r; f32[o + 1] = val.g; f32[o + 2] = val.b; } else { f32[o] = val.x; f32[o + 1] = val.y; f32[o + 2] = val.z; }
        if (o + 3 > floats) floats = o + 3;
      }
    }
  }
  if (floats === 0) return;
  const gl = st.gl;
  gl.bindBuffer(gl.UNIFORM_BUFFER, ub.buf);
  gl.bufferSubData(gl.UNIFORM_BUFFER, 0, f32, 0, floats);
  gl.bindBuffer(gl.UNIFORM_BUFFER, null);
}

function _uboSentinel(st, ub, keyed) {
  return function hbLightUbo(gl, v) {
    if (v === null || v === undefined) return;
    const frame = st.renderer.info.render.frame;
    if (keyed && ub.valid && v === ub.lastV && frame === ub.lastFrame && st.cam === ub.lastCam) {
      st.stats.uboSkips++;
      return;
    }
    _uboWrite(st, ub, v);
    // A program without a camera key (no active projectionMatrix) always
    // writes, and leaves no memo another program could trust.
    ub.lastV = keyed ? v : null;
    ub.lastFrame = frame;
    ub.lastCam = st.cam;
    ub.valid = true;
    st.stats.uboWrites++;
  };
}

/** Bind this program's light blocks (if it declares any) and route three's
 *  light-array uniforms to the shared buffers. Returns the names handled. */
function _patchUbo(st, program, map, proj) {
  const s = st.stats;
  const gl = st.gl;
  const glp = program.program;
  const viaUbo = new Set();
  for (const def of LIGHT_BLOCKS) {
    const idx = gl.getUniformBlockIndex(glp, def.block);
    if (idx === INVALID_INDEX || idx === -1 || idx === null || idx === undefined) continue;
    const ub = st.blocks[def.name];
    gl.uniformBlockBinding(glp, idx, ub.bp);
    const size = gl.getActiveUniformBlockParameter(glp, idx, gl.UNIFORM_BLOCK_DATA_SIZE) | 0;
    const su = map[def.name];
    _uboEnsure(st, ub, glp, su && su.seq ? su.seq.length : 0, size);
    if (su) {
      su.setValue = _uboSentinel(st, ub, !!proj); // three never walks the block members
      viaUbo.add(def.name);
    } else {
      s.uboNoSentinel++;
    }
  }
  if (viaUbo.size > 0) s.programsUbo++;
  return viaUbo;
}

function _patchProgramUniforms(st, program, uniforms) {
  const s = st.stats;
  s.programsSeen++;
  const type = program.type;
  const map = uniforms.map || {};
  // The camera key rides the projectionMatrix setter, which setProgram runs
  // whenever it is about to re-upload lights (program switch or camera
  // change) — before the light uniforms in the same call.
  const proj = map.projectionMatrix;
  let viaUbo = null;
  // Blocks first and on their own: a program that declares them must have
  // them bound before it draws, whatever happens to the optional trims below.
  if (st.ubo) {
    try {
      viaUbo = _patchUbo(st, program, map, proj);
    } catch (_) {
      s.patchErrors++;
    }
  }
  if (st.pin) {
    try {
      const plan = planProgramPins(uniforms, type, st.pinUnits);
      if (plan.eligible) {
        for (const { u, unit } of plan.pins) u.setValue = _pinnedSetter(u.setValue, unit);
        s.programsPinned++;
        s.samplersPinned += plan.pins.length;
      } else if (plan.reason === "crowded") {
        s.programsCrowded++;
      }
    } catch (_) {
      s.patchErrors++;
    }
  }
  let once = 0;
  if (st.light && LIT_BUILTIN.has(type) && proj) {
    for (const name of LIGHT_UNIFORM_NAMES) {
      const u = map[name];
      if (!u || (viaUbo && viaUbo.has(name))) continue;
      // StructuredUniform's setValue is a prototype method; assigning an own
      // one is what three's Single/PureArray uniforms already carry.
      u.setValue = _lightOnceSetter(u.setValue, st);
      once++;
    }
    if (once > 0) s.programsLightOnce++;
  }
  if (proj && (once > 0 || (viaUbo && viaUbo.size > 0))) proj.setValue = _camSetter(proj.setValue, st);
  else if (viaUbo && viaUbo.size > 0) s.noCameraKey++;
}

function _hookProgram(st, program) {
  if (!program || st.hooked.has(program)) return;
  st.hooked.add(program);
  const orig = program.getUniforms;
  if (typeof orig !== "function") return;
  // three builds the uniform table lazily on first use (that is where an
  // async link completes), so patch at that moment and then hand the
  // program its own accessor back: no steady-state indirection.
  program.getUniforms = function () {
    const u = orig.call(this);
    if (u !== undefined && u !== null) {
      this.getUniforms = orig;
      try {
        _patchProgramUniforms(st, this, u);
      } catch (_) {
        st.stats.patchErrors++;
      }
    }
    return u;
  };
}

// three's context restore builds a new WebGLCapabilities whose maxTextures is
// back at MAX_TEXTURE_IMAGE_UNITS (16 on ANGLE/D3D11): put back the limit the
// pins were planned against (index.js raises it to
// MAX_COMBINED_TEXTURE_IMAGE_UNITS at boot), or every pinned sampler above it
// logs three's per-upload "Trying to use N texture units" warning (plain warn,
// not warnOnce) until reload. Never above the restored context's own combined
// limit; if that came back lower, the pins are re-planned for it (every program
// after a restore is a new one), and planned back up to the boot limit by a
// later restore that allows it.
function _reapplyUnitLimit(renderer, gl, bootMax) {
  const caps = renderer.capabilities;
  if (!caps) return bootMax;
  let max = bootMax;
  try {
    const combined = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) | 0;
    if (combined > 0 && combined < max) max = combined;
  } catch (_) { /* keep the boot limit */ }
  if ((caps.maxTextures | 0) < max) caps.maxTextures = max;
  return max;
}

function _restoreUnitLimit(st) {
  const max = _reapplyUnitLimit(st.renderer, st.gl, st.bootMaxTextures);
  if (max !== st.stats.maxTextures) {
    st.stats.maxTextures = max;
    st.pinUnits.clear();
    for (const [name, unit] of pinUnitsFor(max, st.pinNames)) st.pinUnits.set(name, unit);
  }
}

// RENDER restore gap (2026-10-18 follow-up): every restore undoes index.js's
// boot raise of maxTextures, whether or not a trim here is on. With all three
// flags off this install returned null and nothing put the limit back, so
// terrain-batch's sampler on unit 16 (index.js 2026-10-07 note; cells.js
// "CORRECTED 2026-08-12") warned on every upload again, ~80/s. This keeper only
// re-applies the boot limit: from the restore event, and from the render tail
// as a fallback.
function _installUnitLimitKeeper(renderer, gl) {
  if (!renderer || !gl || renderer.__hbUnitLimitKeeper) return;
  let caps = renderer.capabilities;
  const bootMax = (caps && caps.maxTextures) | 0;
  if (bootMax <= 0) return;
  const keep = () => {
    if (renderer.capabilities === caps) return;
    caps = renderer.capabilities;
    _reapplyUnitLimit(renderer, gl, bootMax);
  };
  try {
    Object.defineProperty(renderer, "__hbUnitLimitKeeper", { value: keep, configurable: true });
  } catch (_) {
    renderer.__hbUnitLimitKeeper = keep;
  }
  const canvas = renderer.domElement;
  if (canvas && typeof canvas.addEventListener === "function") {
    try { canvas.addEventListener("webglcontextrestored", keep, false); } catch (_) { /* render tail still keeps it */ }
  }
}

function _adoptArray(st, arr) {
  st.arr = arr;
  if (!Array.isArray(arr)) return;
  for (let i = 0; i < arr.length; i++) _hookProgram(st, arr[i]);
  if (Object.prototype.hasOwnProperty.call(arr, "push")) return;
  const push = Array.prototype.push;
  Object.defineProperty(arr, "push", {
    configurable: true,
    writable: true,
    value: function hbHookedPush(...items) {
      for (let i = 0; i < items.length; i++) _hookProgram(st, items[i]);
      return push.apply(this, items);
    },
  });
}

/**
 * Install on the main renderer, AFTER `renderer.capabilities.maxTextures` has
 * its final value (index.js raises it to MAX_COMBINED_TEXTURE_IMAGE_UNITS).
 * Never throws. Returns the api (also `window.__uniformBindPatch`), or null
 * when all three flags are off (the boot unit limit is still kept across a
 * context restore then; see _installUnitLimitKeeper).
 */
export function installUniformBindPatch(renderer, opts = {}) {
  const pin = opts.texUnitPin !== undefined ? !!opts.texUnitPin : texUnitPinEnabled();
  const light = opts.lightUploadOnce !== undefined ? !!opts.lightUploadOnce : lightUploadOnceEnabled();
  let gl = null;
  try { gl = renderer && typeof renderer.getContext === "function" ? renderer.getContext() : null; } catch (_) { gl = null; }
  // The block path needs the patched chunk (installLightUboChunks, before any
  // compile) and a WebGL2 context; otherwise it stays off and the chunk's
  // #else branch is what compiles.
  const chunk = THREE.ShaderChunk && THREE.ShaderChunk.lights_pars_begin;
  const ubo = (opts.lightUbo !== undefined ? !!opts.lightUbo : lightUboEnabled()) &&
    typeof chunk === "string" && chunk.indexOf(`#ifdef ${LIGHT_UBO_DEFINE}`) !== -1 &&
    !!gl && typeof gl.getUniformBlockIndex === "function";
  if ((!pin && !light && !ubo) || !renderer || !renderer.info) {
    try { _installUnitLimitKeeper(renderer, gl); } catch (_) { /* never throws */ }
    return null;
  }
  if (renderer.__hbUniformBindPatch) return renderer.__hbUniformBindPatch;
  const maxTextures = (renderer.capabilities && renderer.capabilities.maxTextures) | 0;
  const st = {
    pin,
    light,
    ubo,
    gl,
    blocks: null,
    lightOff: false,
    renderer,
    bootMaxTextures: maxTextures,
    pinNames: opts.pinNames || PIN_NAMES,
    pinUnits: pinUnitsFor(maxTextures, opts.pinNames || PIN_NAMES),
    cam: null,
    arr: null,
    hooked: new WeakSet(),
    stats: {
      texUnitPin: pin,
      lightUploadOnce: light,
      maxTextures,
      programsSeen: 0,
      programsPinned: 0,
      programsCrowded: 0,
      samplersPinned: 0,
      programsLightOnce: 0,
      lightUploads: 0,
      lightSkips: 0,
      lightUbo: ubo,
      programsUbo: 0,
      uboWrites: 0,
      uboSkips: 0,
      uboGrows: 0,
      uboNoSentinel: 0,
      noCameraKey: 0,
      uboLayoutMismatch: 0,
      patchErrors: 0,
      contextResets: 0,
    },
  };
  if (ubo) _uboInit(st);
  _adoptArray(st, renderer.info.programs);
  const api = {
    stats: st.stats,
    pinUnits: st.pinUnits,
    /** Re-adopt after a context restore (three swaps the array): run from the
     *  restore event and, as a fallback, every render tail. */
    tick() {
      const arr = renderer.info && renderer.info.programs;
      if (arr !== st.arr) {
        st.stats.contextResets++;
        // A restored context lost every buffer: rebuild them before the new
        // programs (hooked below) draw.
        if (st.ubo) _uboInit(st);
        _restoreUnitLimit(st);
        _adoptArray(st, arr);
      }
    },
    /** Live A/B for the light memo (pins are per program and stay). */
    setLightOnce(on) { st.lightOff = !on; return !st.lightOff; },
  };
  // Adopt the restored context before its FIRST draw, not at that frame's
  // render tail: in between, its lit programs (compiled with the define) drew
  // with no buffer at their block bindings, and every pin warned. three's own
  // restore listener was registered in its constructor, so it has already
  // swapped info / capabilities when this one runs.
  const canvas = renderer.domElement;
  if (canvas && typeof canvas.addEventListener === "function") {
    try { canvas.addEventListener("webglcontextrestored", () => api.tick(), false); } catch (_) { /* render tail still adopts */ }
  }
  try {
    Object.defineProperty(renderer, "__hbUniformBindPatch", { value: api, configurable: true });
  } catch (_) {
    renderer.__hbUniformBindPatch = api;
  }
  if (typeof window !== "undefined") {
    try { window.__uniformBindPatch = api; } catch (_) { /* diag only */ }
  }
  return api;
}

/** Render-tail hook (index.js recordRenderDiag): cheap identity compare. */
export function uniformBindPatchTick(renderer) {
  if (!renderer) return;
  const api = renderer.__hbUniformBindPatch;
  if (api) api.tick();
  else if (renderer.__hbUnitLimitKeeper) renderer.__hbUnitLimitKeeper();
}
