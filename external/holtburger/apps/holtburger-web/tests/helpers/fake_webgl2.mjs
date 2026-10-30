// tests/helpers/fake_webgl2.mjs — a counting, state-tracking fake WebGL2
// context that three r184's real WebGLRenderer can initialise and render with
// in node (2026-10-17, fps wave 2 "binds" card).
//
// WHAT IT IS FOR. Counting the GL calls three emits for a synthetic scene, and
// proving that a renderer-side optimisation leaves what every draw SEES
// unchanged. It does not rasterise anything. It emulates exactly the state a
// draw reads that the binds/uniform work could disturb:
//   - per-program uniform values (uniform*, uniformMatrix*) by location;
//   - texture-unit bindings per (unit, target) and the active unit;
//   - the current program;
// and at every draw call it can record a SNAPSHOT: each active uniform's value,
// with sampler uniforms resolved to the texture object bound at
// (their unit, their sampler's target). Two runs whose snapshot streams are
// equal drew the same programs with the same inputs in the same order.
//
// Uniform / attribute reflection comes from the GLSL itself: on linkProgram the
// two shader sources (as three built them: includes resolved, light counts and
// unrolled loops substituted, #ifdef left to the compiler) go through a small C
// preprocessor (#define/#undef/#if/#ifdef/#ifndef/#elif/#else/#endif with
// defined(), integer arithmetic and logic) and every global `uniform`
// declaration is expanded the way a GL implementation reports it (arrays as
// `name[0]` + size, struct members as `name.field` / `name[i].field`). Unlike a
// real compiler it does NOT strip unused uniforms — a superset, which can only
// add setter calls on both sides of an A/B, never hide one.
//
// Usage:
//   import { createFakeWebGL2, fakeCanvas } from "./helpers/fake_webgl2.mjs";
//   const gl = createFakeWebGL2({ maxTextures: 16 });
//   const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
//   gl.__fake.reset(); renderer.render(scene, camera); gl.__fake.counts // {bindTexture: n, ...}

// Real enum values where three does arithmetic on them, compares them with
// literals, or where a uniform type must round-trip through getActiveUniform.
const K = {
  NO_ERROR: 0, NONE: 0, ZERO: 0, ONE: 1, INVALID_INDEX: 0xffffffff, POINTS: 0, LINES: 1, LINE_LOOP: 2, LINE_STRIP: 3,
  TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6,
  TEXTURE0: 0x84c0, TEXTURE_2D: 0x0de1, TEXTURE_CUBE_MAP: 0x8513, TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515,
  TEXTURE_2D_ARRAY: 0x8c1a, TEXTURE_3D: 0x806f,
  UNIFORM_BUFFER: 0x8a11, DYNAMIC_DRAW: 0x88e8, STATIC_DRAW: 0x88e4, ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893,
  UNIFORM_BLOCK_DATA_SIZE: 0x8a40, UNIFORM_OFFSET: 0x8a3b, UNIFORM_ARRAY_STRIDE: 0x8a3c, UNIFORM_BLOCK_INDEX: 0x8a3a,
  COLOR_ATTACHMENT0: 0x8ce0, DEPTH_ATTACHMENT: 0x8d00, STENCIL_ATTACHMENT: 0x8d20, DEPTH_STENCIL_ATTACHMENT: 0x821a,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
  BYTE: 0x1400, UNSIGNED_BYTE: 0x1401, SHORT: 0x1402, UNSIGNED_SHORT: 0x1403, INT: 0x1404,
  UNSIGNED_INT: 0x1405, FLOAT: 0x1406, HALF_FLOAT: 0x140b,
  FLOAT_VEC2: 0x8b50, FLOAT_VEC3: 0x8b51, FLOAT_VEC4: 0x8b52, INT_VEC2: 0x8b53, INT_VEC3: 0x8b54,
  INT_VEC4: 0x8b55, BOOL: 0x8b56, BOOL_VEC2: 0x8b57, BOOL_VEC3: 0x8b58, BOOL_VEC4: 0x8b59,
  FLOAT_MAT2: 0x8b5a, FLOAT_MAT3: 0x8b5b, FLOAT_MAT4: 0x8b5c,
  FLOAT_MAT2x3: 0x8b65, FLOAT_MAT2x4: 0x8b66, FLOAT_MAT3x2: 0x8b67, FLOAT_MAT3x4: 0x8b68,
  FLOAT_MAT4x2: 0x8b69, FLOAT_MAT4x3: 0x8b6a,
  UNSIGNED_INT_VEC2: 0x8dc6, UNSIGNED_INT_VEC3: 0x8dc7, UNSIGNED_INT_VEC4: 0x8dc8,
  SAMPLER_2D: 0x8b5e, SAMPLER_3D: 0x8b5f, SAMPLER_CUBE: 0x8b60, SAMPLER_2D_SHADOW: 0x8b62,
  SAMPLER_2D_ARRAY: 0x8dc1, SAMPLER_2D_ARRAY_SHADOW: 0x8dc4, SAMPLER_CUBE_SHADOW: 0x8dc5,
  INT_SAMPLER_2D: 0x8dca, INT_SAMPLER_3D: 0x8dcb, INT_SAMPLER_CUBE: 0x8dcc, INT_SAMPLER_2D_ARRAY: 0x8dcf,
  UNSIGNED_INT_SAMPLER_2D: 0x8dd2, UNSIGNED_INT_SAMPLER_3D: 0x8dd3, UNSIGNED_INT_SAMPLER_CUBE: 0x8dd4,
  UNSIGNED_INT_SAMPLER_2D_ARRAY: 0x8dd7,
};

const GLSL_TYPE = {
  float: K.FLOAT, vec2: K.FLOAT_VEC2, vec3: K.FLOAT_VEC3, vec4: K.FLOAT_VEC4,
  int: K.INT, ivec2: K.INT_VEC2, ivec3: K.INT_VEC3, ivec4: K.INT_VEC4,
  uint: K.UNSIGNED_INT, uvec2: K.UNSIGNED_INT_VEC2, uvec3: K.UNSIGNED_INT_VEC3, uvec4: K.UNSIGNED_INT_VEC4,
  bool: K.BOOL, bvec2: K.BOOL_VEC2, bvec3: K.BOOL_VEC3, bvec4: K.BOOL_VEC4,
  mat2: K.FLOAT_MAT2, mat3: K.FLOAT_MAT3, mat4: K.FLOAT_MAT4,
  mat2x3: K.FLOAT_MAT2x3, mat2x4: K.FLOAT_MAT2x4, mat3x2: K.FLOAT_MAT3x2, mat3x4: K.FLOAT_MAT3x4,
  mat4x2: K.FLOAT_MAT4x2, mat4x3: K.FLOAT_MAT4x3,
  sampler2D: K.SAMPLER_2D, sampler3D: K.SAMPLER_3D, samplerCube: K.SAMPLER_CUBE,
  sampler2DShadow: K.SAMPLER_2D_SHADOW, sampler2DArray: K.SAMPLER_2D_ARRAY,
  sampler2DArrayShadow: K.SAMPLER_2D_ARRAY_SHADOW, samplerCubeShadow: K.SAMPLER_CUBE_SHADOW,
  isampler2D: K.INT_SAMPLER_2D, isampler3D: K.INT_SAMPLER_3D, isamplerCube: K.INT_SAMPLER_CUBE,
  isampler2DArray: K.INT_SAMPLER_2D_ARRAY, usampler2D: K.UNSIGNED_INT_SAMPLER_2D,
  usampler3D: K.UNSIGNED_INT_SAMPLER_3D, usamplerCube: K.UNSIGNED_INT_SAMPLER_CUBE,
  usampler2DArray: K.UNSIGNED_INT_SAMPLER_2D_ARRAY,
};

// Sampler uniform type -> texture target it reads.
const SAMPLER_TARGET = new Map([
  [K.SAMPLER_2D, K.TEXTURE_2D], [K.SAMPLER_2D_SHADOW, K.TEXTURE_2D], [K.INT_SAMPLER_2D, K.TEXTURE_2D],
  [K.UNSIGNED_INT_SAMPLER_2D, K.TEXTURE_2D],
  [K.SAMPLER_3D, K.TEXTURE_3D], [K.INT_SAMPLER_3D, K.TEXTURE_3D], [K.UNSIGNED_INT_SAMPLER_3D, K.TEXTURE_3D],
  [K.SAMPLER_CUBE, K.TEXTURE_CUBE_MAP], [K.SAMPLER_CUBE_SHADOW, K.TEXTURE_CUBE_MAP],
  [K.INT_SAMPLER_CUBE, K.TEXTURE_CUBE_MAP], [K.UNSIGNED_INT_SAMPLER_CUBE, K.TEXTURE_CUBE_MAP],
  [K.SAMPLER_2D_ARRAY, K.TEXTURE_2D_ARRAY], [K.SAMPLER_2D_ARRAY_SHADOW, K.TEXTURE_2D_ARRAY],
  [K.INT_SAMPLER_2D_ARRAY, K.TEXTURE_2D_ARRAY], [K.UNSIGNED_INT_SAMPLER_2D_ARRAY, K.TEXTURE_2D_ARRAY],
]);

// ---------------------------------------------------------------------------
// GLSL preprocessor + reflection
// ---------------------------------------------------------------------------

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");
}

function evalIf(expr, macros) {
  let e = expr.replace(/defined\s*\(\s*(\w+)\s*\)/g, (_, n) => (macros.has(n) ? "1" : "0"));
  e = e.replace(/defined\s+(\w+)/g, (_, n) => (macros.has(n) ? "1" : "0"));
  // Expand identifiers (object-like macros) until stable; unknown => 0.
  for (let i = 0; i < 16; i++) {
    const next = e.replace(/\b[A-Za-z_]\w*\b/g, (n) => {
      if (!macros.has(n)) return "0";
      const v = macros.get(n);
      return v === "" ? "1" : `(${v})`;
    });
    if (next === e) break;
    e = next;
  }
  e = e.replace(/(\d+)u\b/g, "$1").replace(/(\d+\.\d*)f\b/g, "$1");
  if (!/^[\d\s()+\-*/%<>=!&|^~?:.]*$/.test(e)) throw new Error(`fake_webgl2: cannot evaluate #if ${expr} -> ${e}`);
  // eslint-disable-next-line no-new-func
  return !!Function(`"use strict"; return (${e});`)();
}

/** Run the preprocessor; returns the active source lines (directives removed). */
export function preprocessGlsl(src) {
  const macros = new Map();
  const out = [];
  const stack = []; // { active, taken, parentActive }
  const lines = stripComments(src).split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    while (line.endsWith("\\") && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i];
    const t = line.trim();
    const active = stack.length === 0 || stack[stack.length - 1].active;
    if (t.startsWith("#")) {
      const m = /^#\s*(\w+)\s*(.*)$/.exec(t);
      const dir = m ? m[1] : "";
      const rest = m ? m[2].trim() : "";
      if (dir === "if" || dir === "ifdef" || dir === "ifndef") {
        let cond = false;
        if (active) {
          if (dir === "ifdef") cond = macros.has(rest.split(/\s+/)[0]);
          else if (dir === "ifndef") cond = !macros.has(rest.split(/\s+/)[0]);
          else cond = evalIf(rest, macros);
        }
        stack.push({ active: active && cond, taken: cond, parentActive: active });
      } else if (dir === "elif") {
        const top = stack[stack.length - 1];
        if (top.parentActive && !top.taken && evalIf(rest, macros)) { top.active = true; top.taken = true; } else top.active = false;
      } else if (dir === "else") {
        const top = stack[stack.length - 1];
        top.active = top.parentActive && !top.taken;
        top.taken = true;
      } else if (dir === "endif") {
        stack.pop();
      } else if (active && dir === "define") {
        const d = /^(\w+)(\([^)]*\))?\s*(.*)$/.exec(rest);
        if (d && !d[2]) macros.set(d[1], d[3].trim());
        else if (d) macros.set(d[1], "__fn__");
      } else if (active && dir === "undef") {
        macros.delete(rest.split(/\s+/)[0]);
      }
      continue;
    }
    if (active) out.push(line);
  }
  return { text: out.join("\n"), macros };
}

function evalInt(expr, macros) {
  const s = String(expr).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let e = s;
  for (let i = 0; i < 16; i++) {
    const next = e.replace(/\b[A-Za-z_]\w*\b/g, (n) => (macros.has(n) ? `(${macros.get(n)})` : "0"));
    if (next === e) break;
    e = next;
  }
  e = e.replace(/(\d+)u\b/g, "$1");
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${e}) | 0;`)();
}

/** Global statements at brace depth 0. A function body ends its statement at
 *  the closing brace; struct and uniform-block bodies run on to their `;`. */
function globalStatements(text) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of text) {
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      cur += ch;
      if (depth === 0) {
        const head = cur.trim();
        if (!/^(struct\b|uniform\b|layout\b)/.test(head)) { out.push(head); cur = ""; }
      }
      continue;
    }
    if (ch === ";" && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  return out;
}

const QUALIFIERS = /\b(highp|mediump|lowp|flat|smooth|centroid|invariant|const)\b/g;

// std140 (GLSL ES 3.00 §2.12.6.4 / OpenGL 4.x rule set): [base alignment, size].
const STD140_BASE = {
  float: [4, 4], int: [4, 4], uint: [4, 4], bool: [4, 4],
  vec2: [8, 8], ivec2: [8, 8], uvec2: [8, 8], bvec2: [8, 8],
  vec3: [16, 12], ivec3: [16, 12], uvec3: [16, 12], bvec3: [16, 12],
  vec4: [16, 16], ivec4: [16, 16], uvec4: [16, 16], bvec4: [16, 16],
};
const STD140_MAT = { mat2: 2, mat3: 3, mat4: 4 };
const roundUp = (x, a) => Math.ceil(x / a) * a;

/** Lay a uniform block's members out per std140; returns { leaves, size }. */
function std140Layout(members, structs) {
  const align = (type, isArr) => {
    const st = structs.get(type);
    if (st) { let a = 0; for (const f of st) a = Math.max(a, align(f.type, f.arr > 0)); return roundUp(a, 16); }
    if (STD140_MAT[type]) return 16;
    const b = STD140_BASE[type];
    if (!b) throw new Error(`fake_webgl2 std140: unsupported block member type ${type}`);
    return isArr ? roundUp(b[0], 16) : b[0];
  };
  const leaves = [];
  // Places `m` at or after `offset`; pushes leaves when `out` is given; returns the end offset.
  const place = (m, offset, prefix, out) => {
    const isArr = m.arr > 0;
    const a = align(m.type, isArr);
    const o = roundUp(offset, a);
    const st = structs.get(m.type);
    if (st) {
      let inner = 0;
      for (const f of st) inner = place(f, inner, "", null);
      const ssize = roundUp(inner, a);
      const n = isArr ? m.arr : 1;
      for (let i = 0; i < n; i++) {
        const base = isArr ? `${prefix}${m.name}[${i}]` : `${prefix}${m.name}`;
        let fo = o + i * ssize;
        for (const f of st) fo = place(f, fo, `${base}.`, out);
      }
      return roundUp(o + n * ssize, a);
    }
    if (STD140_MAT[m.type]) {
      const cols = STD140_MAT[m.type];
      const n = isArr ? m.arr : 1;
      if (out) out.push({ name: isArr ? `${prefix}${m.name}[0]` : `${prefix}${m.name}`, glslType: m.type, size: n, offset: o, stride: cols * 16, matrixStride: 16 });
      return o + n * cols * 16;
    }
    const b = STD140_BASE[m.type];
    if (isArr) {
      const stride = roundUp(b[1], 16);
      if (out) out.push({ name: `${prefix}${m.name}[0]`, glslType: m.type, size: m.arr, offset: o, stride });
      return o + m.arr * stride;
    }
    if (out) out.push({ name: `${prefix}${m.name}`, glslType: m.type, size: 1, offset: o, stride: 0 });
    return o + b[1];
  };
  let off = 0;
  for (const m of members) off = place(m, off, "", leaves);
  return { leaves, size: roundUp(off, 16) };
}

function parseDecls(body, macros) {
  const out = [];
  for (const f of body.split(";")) {
    const d = f.replace(QUALIFIERS, " ").replace(/layout\s*\([^)]*\)/g, " ").trim();
    if (!d) continue;
    const fm = /^(\w+)\s+(.+)$/.exec(d);
    if (!fm) continue;
    for (const decl of fm[2].split(",")) {
      const dm = /^\s*(\w+)\s*(?:\[\s*([^\]]+)\s*\])?\s*$/.exec(decl);
      if (dm) out.push({ type: fm[1], name: dm[1], arr: dm[2] != null ? evalInt(dm[2], macros) : 0 });
    }
  }
  return out;
}

function reflect(vsSrc, fsSrc) {
  const uniforms = new Map(); // name -> { name, type, size, block?, offset?, stride? }
  const attributes = new Map();
  const blocks = new Map();   // block name -> { name, index, size, binding }
  for (const [stage, src] of [["vs", vsSrc], ["fs", fsSrc]]) {
    const { text, macros } = preprocessGlsl(src);
    const structs = new Map();
    // Struct definitions at global scope: `struct Name { ... }` possibly followed by a declarator.
    const structRe = /struct\s+(\w+)\s*\{([^}]*)\}/g;
    let sm;
    while ((sm = structRe.exec(text))) structs.set(sm[1], parseDecls(sm[2], macros));
    const addUniform = (name, type, arr) => {
      const st = structs.get(type);
      if (st) {
        const n = arr || 1;
        for (let i = 0; i < n; i++) {
          const base = arr ? `${name}[${i}]` : name;
          for (const f of st) addUniform(`${base}.${f.name}`, f.type, f.arr);
        }
        return;
      }
      const glType = GLSL_TYPE[type];
      if (glType === undefined) return;
      const key = arr ? `${name}[0]` : name;
      if (!uniforms.has(key)) uniforms.set(key, { name: key, type: glType, size: arr || 1 });
    };
    for (const stmt0 of globalStatements(text)) {
      let stmt = stmt0.replace(/layout\s*\([^)]*\)/g, " ").replace(QUALIFIERS, " ").replace(/\s+/g, " ").trim();
      if (stmt.startsWith("uniform ")) {
        stmt = stmt.slice(8).trim();
        const bm = /^(\w+)\s*\{(.*)\}\s*(\w+)?$/.exec(stmt);
        if (bm) {
          if (bm[3]) throw new Error("fake_webgl2: named uniform-block instances are not emulated");
          if (blocks.has(bm[1])) continue; // same block in both stages
          const { leaves, size } = std140Layout(parseDecls(bm[2], macros), structs);
          const index = blocks.size;
          blocks.set(bm[1], { name: bm[1], index, size, binding: 0 });
          for (const l of leaves) {
            uniforms.set(l.name, { name: l.name, type: GLSL_TYPE[l.glslType], size: l.size, block: index, offset: l.offset, stride: l.stride, glslType: l.glslType });
          }
          continue;
        }
        if (/\{/.test(stmt)) continue;
        const m = /^(\w+)\s+(.+)$/.exec(stmt);
        if (!m) continue;
        for (const decl of m[2].split(",")) {
          const dm = /^\s*(\w+)\s*(?:\[\s*([^\]]+)\s*\])?\s*$/.exec(decl);
          if (dm) addUniform(dm[1], m[1], dm[2] != null ? evalInt(dm[2], macros) : 0);
        }
      } else if (stage === "vs" && (stmt.startsWith("attribute ") || stmt.startsWith("in "))) {
        const m = /^(?:attribute|in) (\w+) (\w+)/.exec(stmt);
        if (m && GLSL_TYPE[m[1]] !== undefined && !attributes.has(m[2])) {
          attributes.set(m[2], { name: m[2], type: GLSL_TYPE[m[1]], size: 1 });
        }
      }
    }
  }
  return { uniforms: [...uniforms.values()], attributes: [...attributes.values()], blocks };
}

export { std140Layout };

// ---------------------------------------------------------------------------
// The context
// ---------------------------------------------------------------------------

/**
 * @param {object} [opts]
 * @param {number} [opts.maxTextures=16]       MAX_TEXTURE_IMAGE_UNITS
 * @param {number} [opts.maxCombined=32]       MAX_COMBINED_TEXTURE_IMAGE_UNITS
 * @param {boolean} [opts.multiDraw=true]      expose WEBGL_multi_draw
 * @param {number} [opts.width=800] @param {number} [opts.height=600]
 * @param {(name: string, args: IArguments) => void} [opts.onCall]
 *   (2026-10-26, draw_exec suite) called at the BOTTOM of every context and
 *   extension function — the call as it reaches the "driver", below every
 *   wrapper anyone installs on the context later (they capture the hooked
 *   function). Absent: the context is exactly as before.
 * @param {boolean} [opts.clipControl=false]   expose EXT_clip_control (reversed-Z) and
 *   answer getParameter(DEPTH_FUNC) with the last depthFunc (shader_logdepth.js's probe)
 */
export function createFakeWebGL2(opts = {}) {
  const maxTextures = opts.maxTextures ?? 16;
  const maxCombined = opts.maxCombined ?? 32;
  const width = opts.width ?? 800, height = opts.height ?? 600;
  const onCall = typeof opts.onCall === "function" ? opts.onCall : null;
  // The bottom-level call hook (opts.onCall): wraps a function once, statically.
  const logged = (name, fn) => (onCall === null ? fn : function () { onCall(name, arguments); return fn.apply(this, arguments); });

  let nextEnum = 0x100000;
  const enumByName = new Map(Object.entries(K));
  const nameByEnum = new Map();
  for (const [n, v] of enumByName) if (!nameByEnum.has(v)) nameByEnum.set(v, n);
  const enumOf = (name) => {
    let v = enumByName.get(name);
    if (v === undefined) { v = nextEnum++; enumByName.set(name, v); nameByEnum.set(v, name); }
    return v;
  };

  const counts = Object.create(null);
  let counting = true;
  const bump = (k) => { if (counting) counts[k] = (counts[k] || 0) + 1; };

  let nextObj = 1;
  const mk = (kind) => ({ __kind: kind, __id: nextObj++ });

  // Emulated state.
  const shaderSrc = new Map();      // shader -> source
  const programShaders = new Map(); // program -> [shaders]
  const programInfo = new Map();    // program -> { uniforms, attributes, values: Map(loc -> value) }
  let currentProgram = null;
  let activeUnit = 0;
  const units = new Map(); // `${unit}:${target}` -> texture object
  let snapshots = null;    // array when recording

  const params = {
    VERSION: "WebGL 2.0 (fake)",
    SHADING_LANGUAGE_VERSION: "WebGL GLSL ES 3.00 (fake)",
    MAX_TEXTURE_IMAGE_UNITS: maxTextures,
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: maxTextures,
    MAX_COMBINED_TEXTURE_IMAGE_UNITS: maxCombined,
    MAX_TEXTURE_SIZE: 8192, MAX_CUBE_MAP_TEXTURE_SIZE: 8192,
    MAX_VERTEX_ATTRIBS: 16, MAX_VERTEX_UNIFORM_VECTORS: 4096, MAX_VARYING_VECTORS: 30,
    MAX_FRAGMENT_UNIFORM_VECTORS: 4096, MAX_SAMPLES: 4, SAMPLES: 0,
    MAX_UNIFORM_BUFFER_BINDINGS: 24, MAX_UNIFORM_BLOCK_SIZE: 65536, UNIFORM_BUFFER_OFFSET_ALIGNMENT: 256,
    MAX_FRAGMENT_UNIFORM_BLOCKS: 14, MAX_VERTEX_UNIFORM_BLOCKS: 14, MAX_COMBINED_UNIFORM_BLOCKS: 28,
    IMPLEMENTATION_COLOR_READ_FORMAT: K.ONE, IMPLEMENTATION_COLOR_READ_TYPE: K.UNSIGNED_BYTE,
    UNPACK_IMAGE_HEIGHT: 0, UNPACK_ROW_LENGTH: 0, UNPACK_SKIP_IMAGES: 0, UNPACK_SKIP_PIXELS: 0, UNPACK_SKIP_ROWS: 0,
  };

  const extensions = {
    EXT_color_buffer_float: {},
    EXT_color_buffer_half_float: {},
    OES_texture_float_linear: {},
    EXT_float_blend: {},
    WEBGL_multi_draw: opts.multiDraw === false ? null : {
      multiDrawArraysWEBGL: logged("multiDrawArraysWEBGL", function multiDrawArraysWEBGL() { bump("multiDrawArraysWEBGL"); record("multiDrawArraysWEBGL"); }),
      multiDrawElementsWEBGL: logged("multiDrawElementsWEBGL", function multiDrawElementsWEBGL() { bump("multiDrawElementsWEBGL"); record("multiDrawElementsWEBGL"); }),
      multiDrawArraysInstancedWEBGL: logged("multiDrawArraysInstancedWEBGL", function multiDrawArraysInstancedWEBGL() { bump("multiDrawArraysInstancedWEBGL"); record("multiDrawArraysInstancedWEBGL"); }),
      multiDrawElementsInstancedWEBGL: logged("multiDrawElementsInstancedWEBGL", function multiDrawElementsInstancedWEBGL() { bump("multiDrawElementsInstancedWEBGL"); record("multiDrawElementsInstancedWEBGL"); }),
    },
  };
  if (opts.clipControl === true) {
    extensions.EXT_clip_control = {
      LOWER_LEFT_EXT: 0x8ca1, UPPER_LEFT_EXT: 0x8ca2, NEGATIVE_ONE_TO_ONE_EXT: 0x935e, ZERO_TO_ONE_EXT: 0x935f,
      clipControlEXT: logged("clipControlEXT", function () { bump("clipControlEXT"); }),
    };
  }
  let depthFunc = 0; // opts.clipControl: getParameter(DEPTH_FUNC) answers the last depthFunc

  function resolveUniform(info, value) {
    const target = SAMPLER_TARGET.get(info.type);
    if (target === undefined) return value;
    const vals = Array.isArray(value) ? value : [value ?? 0];
    const out = [];
    for (let i = 0; i < info.size; i++) {
      const unit = vals[i] ?? 0;
      const tex = units.get(`${unit}:${target}`);
      out.push(tex ? `tex#${tex.__id}` : "tex#null");
    }
    return info.size > 1 ? out : out[0];
  }

  // GL ES 3.0 §2.12.6: two sampler uniforms of DIFFERENT types may not name the
  // same texture unit within one program (INVALID_OPERATION at draw). Checked
  // at every draw, recording or not.
  let unitConflicts = 0;
  let checkingUnits = true;
  const conflictLog = [];
  function checkUnits() {
    const pi = currentProgram ? programInfo.get(currentProgram) : null;
    if (!pi) return;
    const typeOfUnit = new Map();
    for (const info of pi.uniforms) {
      if (!SAMPLER_TARGET.has(info.type)) continue;
      const v = pi.values.get(info.name);
      const vals = Array.isArray(v) ? v : [v ?? 0];
      for (let i = 0; i < info.size; i++) {
        const unit = vals[i] ?? 0;
        const prev = typeOfUnit.get(unit);
        if (prev !== undefined && prev.type !== info.type) {
          unitConflicts++;
          if (conflictLog.length < 20) conflictLog.push(`unit ${unit}: ${prev.name} vs ${info.name}`);
        }
        if (prev === undefined) typeOfUnit.set(unit, info);
      }
    }
  }

  function record(kind) {
    if (checkingUnits) checkUnits();
    const pi0 = currentProgram ? programInfo.get(currentProgram) : null;
    if (pi0 && pi0.blocks.size) checkBlocks(pi0);
    if (!snapshots) return;
    const pi = pi0;
    const u = {};
    if (pi) {
      for (const info of pi.uniforms) {
        if (info.block !== undefined) {
          let blk = null;
          for (const b of pi.blocks.values()) if (b.index === info.block) blk = b;
          u[info.name] = readBlockMember(info, uboBindings.get(blk.binding));
          continue;
        }
        const v = pi.values.get(info.name);
        u[info.name] = resolveUniform(info, v === undefined ? undefined : v);
      }
    }
    snapshots.push({ kind, program: currentProgram ? currentProgram.__id : null, uniforms: u });
  }

  const uniformCallsByName = Object.create(null);
  const setUniform = (kind) => function (loc, ...args) {
    bump(kind);
    if (counting && loc) uniformCallsByName[loc.name] = (uniformCallsByName[loc.name] || 0) + 1;
    if (!loc || !currentProgram) return;
    const pi = programInfo.get(currentProgram);
    if (!pi) return;
    // uniformMatrix*fv(loc, transpose, data) vs uniform*fv(loc, data) vs uniform1i(loc, x)
    // Stored the way the GPU holds it: float uniforms as float32, so a value
    // read back from a uniform buffer compares exactly.
    let v;
    if (kind.startsWith("uniformMatrix")) v = Array.from(args[1]);
    else if (kind.endsWith("v")) v = Array.from(args[0]);
    else v = args.slice();
    if (/^uniform(Matrix)?\d?f/.test(kind) || /^uniform\df/.test(kind)) v = v.map(Math.fround);
    pi.values.set(loc.name, v.length === 1 ? v[0] : v);
  };

  // --- uniform buffers (UBO) emulation --------------------------------------
  const bufferStore = new WeakMap(); // buffer -> ArrayBuffer (UNIFORM_BUFFER data only)
  const genericBinding = new Map();  // target -> buffer
  const uboBindings = new Map();     // binding point -> buffer
  let uboErrors = 0;
  const uboErrorLog = [];
  const COMPONENTS = {
    float: 1, int: 1, uint: 1, bool: 1, vec2: 2, ivec2: 2, uvec2: 2, bvec2: 2,
    vec3: 3, ivec3: 3, uvec3: 3, bvec3: 3, vec4: 4, ivec4: 4, uvec4: 4, bvec4: 4,
  };
  function readBlockMember(info, buf) {
    const ab = buf && bufferStore.get(buf);
    if (!ab) return "ubo#unbound";
    const isInt = /^(int|uint|bool|ivec|uvec|bvec)/.test(info.glslType);
    const view = isInt ? new Int32Array(ab) : new Float32Array(ab);
    const out = [];
    const mat = { mat2: 2, mat3: 3, mat4: 4 }[info.glslType];
    for (let e = 0; e < info.size; e++) {
      const base = info.offset + e * (info.stride || 0);
      if (mat) {
        for (let c = 0; c < mat; c++) for (let r = 0; r < mat; r++) out.push(view[(base + c * 16) / 4 + r]);
      } else {
        const n = COMPONENTS[info.glslType];
        for (let k = 0; k < n; k++) out.push(view[base / 4 + k]);
      }
    }
    return out.length === 1 ? out[0] : out;
  }
  function checkBlocks(pi) {
    for (const b of pi.blocks.values()) {
      const buf = uboBindings.get(b.binding);
      const ab = buf && bufferStore.get(buf);
      if (!ab || ab.byteLength < b.size) {
        uboErrors++;
        if (uboErrorLog.length < 20) uboErrorLog.push(`${b.name}: binding ${b.binding} ${ab ? `${ab.byteLength} < ${b.size} bytes` : "has no buffer"}`);
      }
    }
  }

  const impl = {
    canvas: null,
    drawingBufferWidth: width,
    drawingBufferHeight: height,
    drawingBufferColorSpace: "srgb",
    getContextAttributes() {
      return { alpha: true, antialias: false, depth: true, stencil: false, premultipliedAlpha: true,
        preserveDrawingBuffer: false, powerPreference: "default", failIfMajorPerformanceCaveat: false, desynchronized: false };
    },
    isContextLost() { return false; },
    getSupportedExtensions() { return Object.keys(extensions).filter((k) => extensions[k]); },
    getExtension(name) { bump("getExtension"); return extensions[name] || null; },
    getParameter(p) {
      bump("getParameter");
      const n = nameByEnum.get(p);
      if (n === "VIEWPORT" || n === "SCISSOR_BOX") return new Int32Array([0, 0, width, height]);
      if (n === "DEPTH_FUNC" && opts.clipControl === true) return depthFunc;
      if (n in params) return params[n];
      if (n === "MAX_TEXTURE_MAX_ANISOTROPY_EXT") return 16;
      return 0;
    },
    getShaderPrecisionFormat() { return { precision: 23, rangeMin: 127, rangeMax: 127 }; },
    getError() { return 0; },
    checkFramebufferStatus() { bump("checkFramebufferStatus"); return K.FRAMEBUFFER_COMPLETE; },

    createShader(type) { bump("createShader"); const s = mk("shader"); s.__type = type; return s; },
    shaderSource(s, src) { bump("shaderSource"); shaderSrc.set(s, src); },
    getShaderSource(s) { return shaderSrc.get(s) || ""; },
    getShaderParameter() { return true; },
    getShaderInfoLog() { return ""; },
    createProgram() { bump("createProgram"); const p = mk("program"); programShaders.set(p, []); return p; },
    attachShader(p, s) { bump("attachShader"); programShaders.get(p).push(s); },
    linkProgram(p) {
      bump("linkProgram");
      const ss = programShaders.get(p) || [];
      const vs = ss.find((s) => nameByEnum.get(s.__type) === "VERTEX_SHADER") || ss[0];
      const fs = ss.find((s) => nameByEnum.get(s.__type) === "FRAGMENT_SHADER") || ss[1];
      const r = reflect(shaderSrc.get(vs) || "", shaderSrc.get(fs) || "");
      programInfo.set(p, { ...r, values: new Map() });
    },
    getProgramParameter(p, pname) {
      const n = nameByEnum.get(pname);
      const pi = programInfo.get(p);
      if (n === "ACTIVE_UNIFORMS") return pi ? pi.uniforms.length : 0;
      if (n === "ACTIVE_ATTRIBUTES") return pi ? pi.attributes.length : 0;
      return true; // LINK_STATUS, VALIDATE_STATUS, COMPLETION_STATUS_KHR
    },
    getProgramInfoLog() { return ""; },
    getActiveUniform(p, i) { return programInfo.get(p).uniforms[i]; },
    getUniformLocation(p, name) {
      const pi = programInfo.get(p);
      const info = pi && pi.uniforms.find((u) => u.name === name);
      if (!info || info.block !== undefined) return null; // block members have no location
      return { __kind: "loc", name };
    },
    getUniformBlockIndex(p, name) {
      bump("getUniformBlockIndex");
      const b = programInfo.get(p)?.blocks.get(name);
      return b ? b.index : 0xffffffff;
    },
    uniformBlockBinding(p, index, binding) {
      bump("uniformBlockBinding");
      for (const b of programInfo.get(p)?.blocks.values() || []) if (b.index === index) b.binding = binding;
    },
    getActiveUniformBlockParameter(p, index, pname) {
      const n = nameByEnum.get(pname);
      for (const b of programInfo.get(p)?.blocks.values() || []) {
        if (b.index !== index) continue;
        if (n === "UNIFORM_BLOCK_DATA_SIZE") return b.size;
        if (n === "UNIFORM_BLOCK_BINDING") return b.binding;
      }
      return null;
    },
    getUniformIndices(p, names) {
      const us = programInfo.get(p)?.uniforms || [];
      return names.map((nm) => { const i = us.findIndex((u) => u.name === nm); return i < 0 ? 0xffffffff : i; });
    },
    getActiveUniforms(p, indices, pname) {
      const n = nameByEnum.get(pname);
      const us = programInfo.get(p)?.uniforms || [];
      return indices.map((i) => {
        const u = us[i];
        if (!u) return -1;
        if (n === "UNIFORM_OFFSET") return u.block !== undefined ? u.offset : -1;
        if (n === "UNIFORM_ARRAY_STRIDE") return u.block !== undefined ? u.stride : -1;
        if (n === "UNIFORM_BLOCK_INDEX") return u.block !== undefined ? u.block : -1;
        if (n === "UNIFORM_TYPE") return u.type;
        if (n === "UNIFORM_SIZE") return u.size;
        return 0;
      });
    },
    bindBuffer(target, buf) { bump("bindBuffer"); genericBinding.set(target, buf || null); },
    bindBufferBase(target, index, buf) {
      bump("bindBufferBase");
      if (target === enumOf("UNIFORM_BUFFER")) uboBindings.set(index, buf || null);
      genericBinding.set(target, buf || null);
    },
    bufferData(target, sizeOrData) {
      bump("bufferData");
      if (target !== enumOf("UNIFORM_BUFFER")) return;
      const buf = genericBinding.get(target);
      if (!buf) return;
      const ab = typeof sizeOrData === "number" ? new ArrayBuffer(sizeOrData)
        : sizeOrData.buffer.slice(sizeOrData.byteOffset, sizeOrData.byteOffset + sizeOrData.byteLength);
      bufferStore.set(buf, ab);
    },
    bufferSubData(target, dstByteOffset, src, srcOffset = 0, length = 0) {
      bump("bufferSubData");
      if (target !== enumOf("UNIFORM_BUFFER")) return;
      const buf = genericBinding.get(target);
      const ab = buf && bufferStore.get(buf);
      if (!ab) return;
      const bpe = src.BYTES_PER_ELEMENT || 1;
      const n = length || (src.length - srcOffset);
      const bytes = new Uint8Array(src.buffer, src.byteOffset + srcOffset * bpe, n * bpe);
      if (dstByteOffset + bytes.length > ab.byteLength) throw new Error("fake_webgl2: bufferSubData overflows the buffer");
      new Uint8Array(ab).set(bytes, dstByteOffset);
    },
    getActiveAttrib(p, i) { return programInfo.get(p).attributes[i]; },
    getAttribLocation(p, name) { const pi = programInfo.get(p); return pi ? pi.attributes.findIndex((a) => a.name === name) : -1; },
    useProgram(p) { bump("useProgram"); currentProgram = p; },
    deleteProgram(p) { bump("deleteProgram"); programInfo.delete(p); },

    activeTexture(u) { bump("activeTexture"); activeUnit = u - K.TEXTURE0; },
    bindTexture(target, tex) { bump("bindTexture"); units.set(`${activeUnit}:${target}`, tex || null); },
    createTexture() { bump("createTexture"); return mk("texture"); },

    uniform1i: setUniform("uniform1i"), uniform2i: setUniform("uniform2i"), uniform3i: setUniform("uniform3i"), uniform4i: setUniform("uniform4i"),
    uniform1ui: setUniform("uniform1ui"), uniform2ui: setUniform("uniform2ui"), uniform3ui: setUniform("uniform3ui"), uniform4ui: setUniform("uniform4ui"),
    uniform1f: setUniform("uniform1f"), uniform2f: setUniform("uniform2f"), uniform3f: setUniform("uniform3f"), uniform4f: setUniform("uniform4f"),
    uniform1iv: setUniform("uniform1iv"), uniform2iv: setUniform("uniform2iv"), uniform3iv: setUniform("uniform3iv"), uniform4iv: setUniform("uniform4iv"),
    uniform1uiv: setUniform("uniform1uiv"), uniform2uiv: setUniform("uniform2uiv"), uniform3uiv: setUniform("uniform3uiv"), uniform4uiv: setUniform("uniform4uiv"),
    uniform1fv: setUniform("uniform1fv"), uniform2fv: setUniform("uniform2fv"), uniform3fv: setUniform("uniform3fv"), uniform4fv: setUniform("uniform4fv"),
    uniformMatrix2fv: setUniform("uniformMatrix2fv"), uniformMatrix3fv: setUniform("uniformMatrix3fv"), uniformMatrix4fv: setUniform("uniformMatrix4fv"),

    depthFunc(f) { bump("depthFunc"); depthFunc = f; },

    drawArrays() { bump("drawArrays"); record("drawArrays"); },
    drawElements() { bump("drawElements"); record("drawElements"); },
    drawArraysInstanced() { bump("drawArraysInstanced"); record("drawArraysInstanced"); },
    drawElementsInstanced() { bump("drawElementsInstanced"); record("drawElementsInstanced"); },
    drawRangeElements() { bump("drawRangeElements"); record("drawRangeElements"); },

    __fake: {
      counts,
      reset() {
        for (const k of Object.keys(counts)) delete counts[k];
        for (const k of Object.keys(uniformCallsByName)) delete uniformCallsByName[k];
      },
      uniformCallsByName,
      total() { let n = 0; for (const k of Object.keys(counts)) n += counts[k]; return n; },
      pause() { counting = false; },
      resume() { counting = true; },
      startSnapshots() { snapshots = []; },
      takeSnapshots() { const s = snapshots; snapshots = null; return s; },
      programInfo,
      get unitConflicts() { return unitConflicts; },
      get uboErrors() { return uboErrors; },
      uboErrorLog,
      setCheckUnits(on) { checkingUnits = !!on; },
      conflictLog,
      reflect,
      K,
    },
  };

  const noop = (name) => function () { bump(name); return undefined; };
  const creators = /^create(Buffer|Framebuffer|Renderbuffer|VertexArray|Sampler|Query|TransformFeedback)$/;
  if (onCall !== null) {
    for (const k of Object.keys(impl)) if (typeof impl[k] === "function") impl[k] = logged(k, impl[k]);
  }
  // (2026-10-26, draw_exec bench) `__fake.plain()`: the same context as a PLAIN object — every
  // name lives as an own property (materialised on first access through a Proxy prototype), so
  // per-call JS timings are not dominated by the Proxy's get trap. Same state, same counters.
  impl.__fake.plain = () => {
    const miss = new Proxy(Object.create(null), {
      get(_t, prop, receiver) {
        const v = proxy[prop];
        if (v !== undefined && typeof prop === "string") Object.defineProperty(receiver, prop, { value: v, writable: true, configurable: true, enumerable: true });
        return v;
      },
    });
    const p = Object.create(miss);
    for (const k of Object.keys(impl)) p[k] = impl[k];
    return p;
  };
  const proxy = new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== "string") return undefined;
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return enumOf(prop);
      let fn;
      if (creators.test(prop)) fn = function () { bump(prop); return mk(prop.slice(6)); };
      else if (prop === "fenceSync") fn = function () { bump(prop); return mk("sync"); };
      else if (prop === "clientWaitSync") fn = function () { bump(prop); return enumOf("ALREADY_SIGNALED"); };
      else fn = noop(prop);
      fn = logged(prop, fn);
      target[prop] = fn; // cache so identity is stable
      return fn;
    },
  });
  return proxy;
}

/** A canvas stand-in that three's WebGLRenderer accepts with `context`. */
export function fakeCanvas(gl, width = 800, height = 600) {
  const c = {
    width, height,
    style: {},
    addEventListener() {}, removeEventListener() {},
    getContext() { return gl; },
    getBoundingClientRect() { return { left: 0, top: 0, width, height }; },
  };
  try { gl.canvas = c; } catch (_) { /* proxy set */ }
  return c;
}
