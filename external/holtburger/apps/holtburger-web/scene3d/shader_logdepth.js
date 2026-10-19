// shader_logdepth.js — one shared log-depth patch for custom ShaderMaterials.
//
// WHY: the renderer runs with `logarithmicDepthBuffer: true` (index.js). three
// defines USE_LOGARITHMIC_DEPTH_BUFFER on EVERY non-raw program, and every
// built-in material (buildings / cells / statics / terrain via its hand-rolled
// chunk) writes a LOGARITHMIC gl_FragDepth. A custom ShaderMaterial that omits
// the logdepthbuf chunks writes ordinary PERSPECTIVE gl_FragCoord.z instead — a
// different encoding — so its depth test against the world is wrong (it either
// loses everywhere or wins everywhere depending on distance) and, with
// depthWrite, it corrupts the depth buffer for everything drawn after it.
// See the "invisible blood" note in blood_decals.js and terrain.js's note.
//
// WHAT: the exact statements of three r184's logdepthbuf_{pars_,}{vertex,
// fragment} chunks, inlined rather than `#include`d because the vertex chunk's
// isPerspectiveMatrix() lives in <common> (which these shaders don't pull in).
// Guarded on the define, so a non-log renderer (`?reversedZ=on`, see REVERSED-Z
// below) compiles none of it — the rasterised depth is then already right.
//
//   * vertex:   declarations before `void main`, the vFragDepth/vIsPerspective
//               writes appended as the LAST statements of main() — i.e. after
//               gl_Position is final. (So main() must not early-`return`.)
//   * fragment: declarations before `void main`, the gl_FragDepth write as the
//               FIRST statement of main() so it is unconditional for every
//               fragment that survives a later discard.
//
// `varying` is correct for both GLSL1-style and `glslVersion: THREE.GLSL3`
// ShaderMaterials: three's non-raw prefix `#define varying out|in` in both
// cases. RawShaderMaterial gets no USE_LOGARITHMIC_DEPTH_BUFFER define from
// three at all, so this helper is a no-op there by construction.
//
// Idempotent: a source that already mentions vFragDepth is returned unchanged.

export const LOGDEPTH_GUARD =
  "#if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )";

const VERT_PARS = `${LOGDEPTH_GUARD}
varying float vFragDepth;
varying float vIsPerspective;
#endif
`;

const VERT_BODY = `
${LOGDEPTH_GUARD}
  // three r184 logdepthbuf_vertex (isPerspectiveMatrix inlined).
  vFragDepth = 1.0 + gl_Position.w;
  vIsPerspective = float( projectionMatrix[2][3] == -1.0 );
#endif
`;

const FRAG_PARS = `${LOGDEPTH_GUARD}
uniform float logDepthBufFC;
varying float vFragDepth;
varying float vIsPerspective;
#endif
`;

const FRAG_BODY = `
${LOGDEPTH_GUARD}
  // three r184 logdepthbuf_fragment.
  gl_FragDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2( vFragDepth ) * logDepthBufFC * 0.5;
#endif
`;

/** True when the GLSL source already carries log-depth handling. */
export function hasLogDepth(src) {
  return typeof src === "string" &&
    (/\bvFragDepth\b/.test(src) || /#include\s*<logdepthbuf_/.test(src));
}

const MAIN_RE = /\bvoid\s+main\s*\(\s*(?:void\s*)?\)\s*\{/;

/** Index of the `}` closing the brace opened at `open` (comment-aware). */
function _matchBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl < 0) return -1;
      i = nl;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) return -1;
      i = end + 1;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function _locateMain(src, kind) {
  const m = MAIN_RE.exec(src);
  if (!m) throw new Error(`shader_logdepth: no void main() in ${kind} shader`);
  const open = m.index + m[0].length - 1;
  const close = _matchBrace(src, open);
  if (close < 0) throw new Error(`shader_logdepth: unbalanced main() in ${kind} shader`);
  return { start: m.index, open, close };
}

/** Inject log-depth into a vertex shader (writes appended at the end of main). */
export function withLogDepthVertex(src) {
  if (hasLogDepth(src)) return src;
  const { start, close } = _locateMain(src, "vertex");
  return src.slice(0, start) + VERT_PARS + "\n" +
    src.slice(start, close) + VERT_BODY + src.slice(close);
}

/** Inject log-depth into a fragment shader (gl_FragDepth first in main). */
export function withLogDepthFragment(src) {
  if (hasLogDepth(src)) return src;
  const { start, open } = _locateMain(src, "fragment");
  return src.slice(0, start) + FRAG_PARS + "\n" +
    src.slice(start, open + 1) + FRAG_BODY + src.slice(open + 1);
}

/**
 * Patch a ShaderMaterial parameter bag in place-free style:
 *   new THREE.ShaderMaterial(withLogDepth({ vertexShader, fragmentShader, ... }))
 * Returns a shallow copy with both shader strings patched (uniforms etc. are
 * passed through BY REFERENCE — no copy of the uniform objects).
 */
export function withLogDepth(params) {
  return {
    ...params,
    vertexShader: withLogDepthVertex(params.vertexShader),
    fragmentShader: withLogDepthFragment(params.fragmentShader),
  };
}

// ===========================================================================
// REVERSED-Z (`?reversedZ=on`, OPT-IN 2026-10-17; default = the log buffer)
// ===========================================================================
//
// WHY. `logarithmicDepthBuffer` makes EVERY program write gl_FragDepth (the
// chunk above), and a shader that writes depth turns early depth rejection off
// for every opaque draw: the GPU shades each fragment before it learns that a
// nearer one already covers the pixel. Linvak Tukal (1070, 2026-10-17): the
// buildings cost 6.3 ms GPU and half resolution cut that to 2.4 ms — per-pixel
// overdraw that early-Z would reject. Reversed-Z keeps the log buffer's
// precision (a FLOAT depth buffer, 1 at the near plane, 0 at the far plane, so
// the float exponent goes where perspective depth needs it) with no
// gl_FragDepth write at all.
//
// WHAT three r184 DOES (WebGLRenderer `reversedDepthBuffer: true`, needs
// EXT_clip_control): glClipControl(LOWER_LEFT, ZERO_TO_ONE); every camera gets
// a reversed projection the first time it renders (setProgram flips
// `camera._reversedDepth` and re-runs updateProjectionMatrix); depth funcs go
// through `ReversedDepthFuncs` (LessEqual -> GreaterEqual, ...); clearDepth(1)
// clears to 0; shadow cameras are reversed, their depth textures compare with
// GreaterEqual and three's own shadow chunks shift their bias; polygon offset
// FACTOR is negated; `#define USE_REVERSED_DEPTH_BUFFER` goes into every
// non-raw program; Frustum/BatchedMesh read `camera.reversedDepth`.
//
// WHAT IT DOES NOT HANDLE (each fixed below or at its reader, all keyed off
// USE_REVERSED_DEPTH_BUFFER so the log arm compiles to exactly what it was):
//   1. ReversedDepthFuncs ALSO maps Always<->Never and Equal<->NotEqual, so a
//      `depthFunc = AlwaysDepth` material (the portal punch / seal / restore)
//      would never draw. installReversedZ pre-maps those four (self-verified
//      against GL at install).
//   2. ShaderChunk.packing's perspectiveDepthToViewZ expects RAW reversed depth
//      under the define, but pmndrs postprocessing 6.39.1 readDepth() already
//      flips reversed depth to conventional (1 - d) before calling it — a
//      double flip. installReversedZ makes the packing helpers conventional, and
//      every takram reader flips at read (vendor readDepthValue), so the whole
//      post chain sees conventional [0,1] depth (far = 1) exactly as before.
//   3. Hand-written depth: anything that writes gl_FragDepth as "far" (the
//      portal punch, the sky glow) must write 0, and every log-depth BIAS
//      (gl_FragDepth +=) needs a reversed twin — applied to gl_Position.z in
//      the vertex stage so the fragment shader still never writes depth.
//   4. Every hand decode of a depth texel (exp2(d * log2(far+1)) - 1 and the
//      `d >= 0.9999` sky tests): reversed d -> distance is
//      near * far / (d * (far - near) + near), sky is d <= 0.
//   5. CPU code that reads NDC z or hands the MVP to code written for GL clip
//      space (nameplate / bracket behind-camera tests, the wasm frustum + PView
//      walks, portal_clip): ndcBehindCamera / glClipProjection below.
//   6. Polygon offset UNITS are not negated (only the factor) — left alone: the
//      wireframe fills and the blood decals' units are tiny next to their
//      factor, and the blood decals carry their own vertex bias below.
//   7. Render-list sort keys are CLIP z, which shrinks with distance under the
//      reversed projection: opaque would sort back-to-front and transparent
//      front-to-back. installReversedZ negates the key on push.
//   8. The reversed flip in setProgram calls `camera.updateProjectionMatrix()`
//      UNGUARDED, and the base `THREE.Camera` has no such method. Every render
//      with a plain `new Camera()` therefore throws a TypeError on that
//      camera's first draw — after `_reversedDepth` is set, so the second draw
//      goes through. takram renders its GPU-generated textures exactly that
//      way: the atmosphere LUT bake (PrecomputedTexturesGenerator, the
//      `?atmosphereLut` bake / slow-download fallback) and the four cloud noise
//      textures (Procedural*TextureBase, the `?cloudProcedural` / prebaked-
//      load-failure fallback). The noise bases clear `needsRender` BEFORE the
//      throw, so on the reversed buffer those textures were never generated:
//      zero weather / shape / detail / turbulence, a cloud march with no
//      density, haze only, in every session that took the fallback (the log
//      buffer bakes them fine; they are byte-equivalent to the prebaked set).
//      NOT the per-session bright/dark sky of the 2026-10-17 1070 A/B: that
//      one flips in log sessions too.
//      The LUT bake rejected on its first draw: with a download in flight
//      (the 15 s timeout path) the runtime silently took the download, with
//      none (`?atmosphereLut=bake`, the bandwidth:low plan) it had no LUTs.
//      Either way it left three's nested render stacks one level deep and
//      renderer.autoClear false (which the pmndrs composer keeps anyway).
//      installReversedZ gives the base Camera a no-op
//      updateProjectionMatrix: a plain Camera has no parameters to rebuild
//      from, and its (identity / user-set) matrix stays as it is.

/** The preprocessor guard of every reversed-Z branch in this tree. */
export const REVERSED_Z_GUARD = "#ifdef USE_REVERSED_DEPTH_BUFFER";

/** Far plane the reversed twins of the log-depth biases are converted at (the
 *  main camera's far, scene3d/index.js). A log bias of `delta` is a factor of
 *  (far + 1)^delta on (1 + distance); the reversed twin scales reversed depth
 *  (~near / distance) by the inverse of that factor. */
export const REVERSED_BIAS_NOMINAL_FAR = 5000;

/**
 * `?reversedZ` — DEFAULT ON since 2026-10-19 (fps review: towns at ultra are
 * fill-bound on the 1070 — Linvak Tukal's buildings 6.3 ms GPU, 2.4 ms at half
 * resolution — and the log buffer turns early-Z off for every opaque draw).
 * `=off` / `0` / `false` / `no` (any case) keep the logarithmic buffer,
 * byte-identical to before. Without EXT_clip_control the log buffer stays.
 * @param {string} [search] test seam; defaults to location.search
 */
export function reversedZRequested(search) {
  try {
    const s = typeof search === "string" ? search : (globalThis.location?.search || "");
    const v = (new URLSearchParams(s).get("reversedZ") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
}

/** `?reversedZ=on` spelled out — the one case a missing EXT_clip_control is a
 *  warning rather than an info line (the default falls back quietly). */
export function reversedZExplicit(search) {
  try {
    const s = typeof search === "string" ? search : (globalThis.location?.search || "");
    return (new URLSearchParams(s).get("reversedZ") || "").toLowerCase() === "on";
  } catch (_) {
    return false;
  }
}

/**
 * The context attributes three r184's WebGLRenderer requests (WebGLRenderer.js
 * constructor: `alpha: true` always; the rest from its defaults). The probe asks
 * for exactly these, so the context it creates IS the context three's own
 * `canvas.getContext("webgl2", …)` returns (the first request on a canvas fixes
 * the attributes; later ones get the same object back).
 */
export function threeContextAttributes({ antialias = false } = {}) {
  return {
    alpha: true,
    depth: true,
    stencil: false,
    antialias: !!antialias,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: "default",
    failIfMajorPerformanceCaveat: false,
  };
}

/** Does this canvas's WebGL2 context expose EXT_clip_control? Never throws. */
export function probeClipControl(canvas, attrs) {
  try {
    const gl = canvas && typeof canvas.getContext === "function"
      ? canvas.getContext("webgl2", attrs)
      : null;
    if (!gl || typeof gl.getSupportedExtensions !== "function") return false;
    const list = gl.getSupportedExtensions() || [];
    return list.indexOf("EXT_clip_control") >= 0;
  } catch (_) {
    return false;
  }
}

/**
 * The depth-mode decision (pure). Reversed only when asked for AND the context
 * has EXT_clip_control; otherwise today's log buffer (never three's plain
 * fallback, which would be neither).
 * @param {{requested:boolean, clipControl:boolean}} o
 * @returns {{mode:"log"|"reversed", reversed:boolean, reason:string}}
 */
export function resolveDepthMode({ requested = false, clipControl = false } = {}) {
  if (!requested) return { mode: "log", reversed: false, reason: "default" };
  if (!clipControl) return { mode: "log", reversed: false, reason: "no-EXT_clip_control" };
  return { mode: "reversed", reversed: true, reason: "reversedZ=on" };
}

/** The WebGLRenderer depth parameters for a mode. The log arm is today's exact
 *  parameter (`logarithmicDepthBuffer: true`, no `reversedDepthBuffer` key). */
export function depthRendererParams(mode) {
  return mode === "reversed"
    ? { logarithmicDepthBuffer: false, reversedDepthBuffer: true }
    : { logarithmicDepthBuffer: true };
}

/** three r184 packing chunk with its reversed branches removed (conventional
 *  depth only). Returns null if the source does not have the two expected
 *  `#ifdef USE_REVERSED_DEPTH_BUFFER … #else … #endif` blocks. */
export function conventionalPackingChunk(src) {
  if (typeof src !== "string") return null;
  const re = /#ifdef USE_REVERSED_DEPTH_BUFFER[^\n]*\n[\s\S]*?#else[^\n]*\n([\s\S]*?)#endif/g;
  const hits = src.match(re);
  if (!hits || hits.length !== 2) return null;
  const out = src.replace(re, "$1");
  if (!/perspectiveDepthToViewZ/.test(out) || /USE_REVERSED_DEPTH_BUFFER/.test(out)) return null;
  return out;
}

/**
 * Install the reversed-Z fixes three r184 does not make itself (items 1, 2, 7
 * and 8 in the header). Call ONCE, right after the renderer is built and before
 * anything compiles. No-op (returns `installed: false`) unless the renderer
 * really runs a reversed depth buffer. A WebGL context restore rebuilds three's
 * state + render lists, so items 1 and 7 re-install on `webglcontextrestored`
 * (three's own listener, registered first, has rebuilt them by then).
 * @returns {{installed:boolean, depthFuncFix:boolean, packing:boolean,
 *            sortKeyFix:boolean, baseCameraFix:boolean, notes:string[]}}
 */
export function installReversedZ(THREE, renderer) {
  const res = { installed: false, depthFuncFix: false, packing: false, sortKeyFix: false, baseCameraFix: false, notes: [] };
  const depth = renderer && renderer.state && renderer.state.buffers && renderer.state.buffers.depth;
  if (!THREE || !depth || typeof depth.getReversed !== "function" || depth.getReversed() !== true) {
    res.notes.push("renderer is not reversed");
    return res;
  }
  res.installed = true;
  res.depthFuncFix = _fixReversedDepthFuncs(THREE, renderer, res.notes);
  res.sortKeyFix = _fixReversedSortKeys(renderer, res.notes);
  res.baseCameraFix = _fixBaseCameraProjection(THREE, res.notes);

  // (2) Conventional packing helpers (pmndrs readDepth already flipped).
  try {
    const next = conventionalPackingChunk(THREE.ShaderChunk && THREE.ShaderChunk.packing);
    if (next) {
      THREE.ShaderChunk.packing = next;
      res.packing = true;
    } else {
      res.notes.push("packing chunk not in the r184 shape — perspectiveDepthToViewZ left reversed");
    }
  } catch (e) {
    res.notes.push(`packing patch failed: ${e && e.message}`);
  }

  try {
    const el = renderer.domElement;
    if (el && typeof el.addEventListener === "function") {
      el.addEventListener("webglcontextrestored", () => {
        const notes = [];
        const d = renderer.state && renderer.state.buffers && renderer.state.buffers.depth;
        if (!d || d.getReversed() !== true) return;
        _fixReversedDepthFuncs(THREE, renderer, notes);
        _fixReversedSortKeys(renderer, notes);
      }, false);
    }
  } catch (_) { /* restore hook is best-effort */ }
  return res;
}

// (8) Base-Camera renders under the reversed flip (header item 8). Process-
// wide and idempotent; only ever installed on a reversed renderer.
function _fixBaseCameraProjection(THREE, notes) {
  try {
    const proto = THREE.Camera && THREE.Camera.prototype;
    if (!proto) {
      notes.push("no THREE.Camera — base-camera fix skipped");
      return false;
    }
    if (typeof proto.updateProjectionMatrix === "function") return true;
    Object.defineProperty(proto, "updateProjectionMatrix", {
      // A plain Camera has no fov / frustum to rebuild a projection from: keep
      // whatever matrix it carries (takram's fullscreen passes ignore it).
      value: function updateProjectionMatrixBaseCamera() {},
      writable: true,
      configurable: true,
    });
    return true;
  } catch (e) {
    notes.push(`base-camera fix failed: ${e && e.message}`);
    return false;
  }
}

// (1) Always/Never + Equal/NotEqual. Verified against GL rather than assumed,
// so a three that fixes its ReversedDepthFuncs table is left alone.
function _fixReversedDepthFuncs(THREE, renderer, notes) {
  try {
    const depth = renderer.state.buffers.depth;
    if (depth.__hbRevFuncFix) return true;
    const gl = renderer.getContext();
    const orig = depth.setFunc;
    orig.call(depth, THREE.AlwaysDepth);
    const buggy = gl.getParameter(gl.DEPTH_FUNC) === gl.NEVER;
    orig.call(depth, THREE.LessEqualDepth);
    if (!buggy) {
      notes.push("ReversedDepthFuncs keeps Always/Equal — no depth-func fix needed");
      return false;
    }
    const pre = new Map([
      [THREE.AlwaysDepth, THREE.NeverDepth],
      [THREE.NeverDepth, THREE.AlwaysDepth],
      [THREE.EqualDepth, THREE.NotEqualDepth],
      [THREE.NotEqualDepth, THREE.EqualDepth],
    ]);
    depth.setFunc = function setFuncReversedFixed(f) {
      return orig.call(this, this.getReversed() && pre.has(f) ? pre.get(f) : f);
    };
    depth.__hbRevFuncFix = true;
    return true;
  } catch (e) {
    notes.push(`depth-func probe failed: ${e && e.message}`);
    return false;
  }
}

// (7) Render-list sort keys. three r184 keys every render item on its CLIP z
// (WebGLRenderer projectObject: bounding-sphere centre × projScreenMatrix, no
// divide) and sorts opaque ascending / transparent descending — conventional
// clip z grows with distance, REVERSED clip z shrinks with it, so unpatched
// the opaque pass would run back-to-front (the overdraw early-Z is meant to
// save) and transparent front-to-back (wrong blending). Negating the key on
// push restores both orders for every comparator, three's and ours
// (draw_sort_program.js, the ?punchRetail phase sort). BatchedMesh sorts on
// view distance and is unaffected.
function _fixReversedSortKeys(renderer, notes) {
  try {
    const lists = renderer.renderLists;
    if (!lists || typeof lists.get !== "function") {
      notes.push("no renderer.renderLists — sort keys left reversed");
      return false;
    }
    if (lists.__hbRevSortFix) return true;
    const origGet = lists.get;
    const done = new WeakSet();
    lists.get = function getReversedSortFixed(scene, depth) {
      const list = origGet.call(this, scene, depth);
      if (list && !done.has(list) && typeof list.push === "function") {
        done.add(list);
        const push = list.push;
        const unshift = list.unshift;
        list.push = function pushReversedZ(object, geometry, material, groupOrder, z, group) {
          return push.call(this, object, geometry, material, groupOrder, -z, group);
        };
        if (typeof unshift === "function") {
          list.unshift = function unshiftReversedZ(object, geometry, material, groupOrder, z, group) {
            return unshift.call(this, object, geometry, material, groupOrder, -z, group);
          };
        }
      }
      return list;
    };
    lists.__hbRevSortFix = true;
    return true;
  } catch (e) {
    notes.push(`sort-key fix failed: ${e && e.message}`);
    return false;
  }
}

/**
 * The text a GLSL source compiles from with USE_REVERSED_DEPTH_BUFFER
 * UNDEFINED: each `#ifdef USE_REVERSED_DEPTH_BUFFER` block is dropped (its
 * `#else` body kept, its directive lines removed); every other line and
 * directive passes through untouched. Test seam: the log arm of every
 * reversed-Z patch must strip back to the pre-reversed-Z shader byte for byte.
 * @param {string} src
 * @returns {string}
 */
export function stripReversedZBranches(src) {
  if (typeof src !== "string") return src;
  const lines = src.split("\n");
  const out = [];
  // Stack of open conditionals: { rev: bool, inElse: bool }.
  const stack = [];
  const keeping = () => stack.every((f) => !f.rev || f.inElse);
  for (const line of lines) {
    const t = line.trim();
    if (/^#\s*if(?:n?def)?\b/.test(t)) {
      const rev = /^#\s*ifdef\s+USE_REVERSED_DEPTH_BUFFER\b/.test(t);
      if (!rev && keeping()) out.push(line);
      stack.push({ rev, inElse: false });
      continue;
    }
    if (/^#\s*(?:else|elif)\b/.test(t) && stack.length) {
      const top = stack[stack.length - 1];
      if (top.rev) { top.inElse = true; continue; }
      if (keeping()) out.push(line);
      continue;
    }
    if (/^#\s*endif\b/.test(t) && stack.length) {
      const top = stack.pop();
      if (!top.rev && keeping()) out.push(line);
      continue;
    }
    if (keeping()) out.push(line);
  }
  return out.join("\n");
}

/** Reversed depth texel (1 = near, 0 = far) → eye-forward distance. */
export function reversedDepthToViewDist(d, near, far) {
  return (near * far) / (d * (far - near) + near);
}

/** Eye-forward distance → reversed depth (three r184 reversed perspective). */
export function viewDistToReversedDepth(dist, near, far) {
  return (near * (far - dist)) / ((far - near) * dist);
}

/** Log depth texel → eye-forward distance (three's log write, inverted). */
export function logDepthToViewDist(d, far) {
  return Math.pow(2, d * Math.log2(far + 1)) - 1;
}

/** Eye-forward distance → log depth texel (three r184 logdepthbuf_fragment). */
export function viewDistToLogDepth(dist, far) {
  return Math.log2(1 + dist) / Math.log2(far + 1);
}

/** Conventional [0,1] perspective depth → eye-forward distance. */
export function perspectiveDepthToViewDist(d, near, far) {
  const z = d * 2 - 1;
  return (2 * near * far) / (far + near - z * (far - near));
}

/** Scale on reversed clip z equivalent to a log-depth `gl_FragDepth += delta`. */
export function reversedBiasScale(logDelta, far = REVERSED_BIAS_NOMINAL_FAR) {
  return Math.pow(far + 1, -logDelta);
}

/**
 * Vertex-stage reversed twin of a log-depth bias: a guarded
 * `gl_Position.z *= s` (s < 1 pushes away, s > 1 pulls toward the eye). Goes
 * after the last write of gl_Position. Compiles out under the log buffer.
 */
export function reversedDepthBiasVertexGlsl(scale) {
  // No trailing newline: inserted right after an `#include`, it leaves that
  // line's own newline to separate it from what follows, so the log arm strips
  // back to the original text byte for byte.
  return `\n${REVERSED_Z_GUARD}\n\tgl_Position.z *= ${Number(scale).toFixed(9)};\n#endif`;
}

/** Copy `src` (16 column-major elements) into `out` with clip row 2 rewritten
 *  from reversed [0,1] to GL [-w, w]: z_gl = w - 2 * z_rev. */
export function reversedToGLClipElements(src, out) {
  for (let i = 0; i < 16; i++) out[i] = src[i];
  for (let c = 0; c < 4; c++) out[c * 4 + 2] = src[c * 4 + 3] - 2 * src[c * 4 + 2];
  return out;
}

/**
 * The camera's projection in GL clip convention (near → z = -w, far → +w), for
 * CPU code and wasm walks written for it. Not reversed ⇒ the camera's own
 * matrix object (flag off: no copy, identical). Reversed ⇒ `scratch` (a
 * THREE.Matrix4) holding the converted copy.
 */
export function glClipProjection(camera, scratch) {
  const p = camera.projectionMatrix;
  if (camera.reversedDepth !== true || !scratch) return p;
  reversedToGLClipElements(p.elements, scratch.elements);
  return scratch;
}

/** Behind-camera test on NDC z from `Vector3.project(camera)`: GL ⇒ z > threshold
 *  (1); reversed ⇒ z < 0 (behind the eye or past the far plane both land there). */
export function ndcBehindCamera(ndcZ, camera, threshold = 1.0) {
  return camera && camera.reversedDepth === true ? ndcZ < 0 : ndcZ > threshold;
}

/**
 * `window.__reversedZDiag()` — the live state a reversed-vs-log sky A/B needs
 * to tell its mechanisms apart (the pipeline installs it; duck-typed and pure
 * so the node suite drives it). Everything is read, nothing toggled. `readRT`
 * (optional) returns the centre RGBA8 texel of a 2D render target — a
 * GPU-generated noise texture that was never rendered reads all zeros.
 * @param {{renderer?:object, camera?:object, cloudOverlay?:object,
 *          atmosphereRuntime?:object, Camera?:Function,
 *          readRT?:(rt:object)=>ArrayLike<number>|null}} deps
 */
export function reversedZDiagSnapshot(deps = {}) {
  const { renderer, camera, cloudOverlay, atmosphereRuntime, Camera, readRT } = deps;
  const depth = renderer && renderer.state && renderer.state.buffers && renderer.state.buffers.depth;
  const out = {
    reversed: !!(depth && typeof depth.getReversed === "function" && depth.getReversed() === true),
    logarithmic: !!(renderer && renderer.capabilities && renderer.capabilities.logarithmicDepthBuffer === true),
    autoClear: renderer ? renderer.autoClear : null,
    baseCameraUpdate: Camera && Camera.prototype
      ? typeof Camera.prototype.updateProjectionMatrix === "function"
      : null,
    lut: null,
    clouds: null,
  };
  if (atmosphereRuntime) {
    out.lut = {
      ready: atmosphereRuntime.ready === true,
      source: atmosphereRuntime.source ?? null,
      plan: atmosphereRuntime.plan ?? null,
      loadTimedOut: atmosphereRuntime.loadTimedOut === true,
      bakeAttempted: !!atmosphereRuntime.generator,
      error: atmosphereRuntime.error ? String(atmosphereRuntime.error && atmosphereRuntime.error.message || atmosphereRuntime.error) : null,
    };
  }
  const eff = cloudOverlay && cloudOverlay.volume && cloudOverlay.volume.effect;
  if (eff) {
    const cm = eff.cloudsPass && eff.cloudsPass.currentMaterial;
    const props = renderer && renderer.properties && typeof renderer.properties.get === "function" && cm
      ? renderer.properties.get(cm)
      : null;
    const prog = props && props.currentProgram;
    const procedural = {
      localWeather: eff.proceduralLocalWeather,
      shape: eff.proceduralShape,
      shapeDetail: eff.proceduralShapeDetail,
      turbulence: eff.proceduralTurbulence,
    };
    const proceduralState = {};
    for (const [k, p] of Object.entries(procedural)) {
      if (!p) continue;
      const s = { needsRender: p.needsRender === true, cameraFlipped: !!(p.camera && p.camera.reversedDepth === true) };
      if (typeof readRT === "function" && p.renderTarget && !p.renderTarget.isWebGL3DRenderTarget) {
        try {
          const t = readRT(p.renderTarget);
          if (t) s.centreTexel = Array.from(t);
        } catch (_) { /* diag */ }
      }
      proceduralState[k] = s;
    }
    const cam = camera || eff.camera || null;
    let cascadeNearZ = null;
    try {
      const cf = eff.shadowMaps && eff.shadowMaps.cameraFrustum;
      if (cf && cam && typeof cf.clone === "function") {
        const c = cf.clone().setFromCamera(cam, eff.shadowMaps.far || cam.far);
        cascadeNearZ = c.near[0].z;
      }
    } catch (_) { /* diag */ }
    out.clouds = {
      mainPass: cloudOverlay.mainPassActive === true,
      noise: cloudOverlay._proceduralTextures ? "procedural" : "prebaked",
      prebakedLoaded: cloudOverlay._prebakedLoaded === true,
      lastError: cloudOverlay.lastError ?? null,
      procedural: proceduralState,
      definesReversed: !!(cm && cm.defines && cm.defines.USE_REVERSED_DEPTH_BUFFER != null),
      definesLog: !!(cm && cm.defines && cm.defines.USE_LOGARITHMIC_DEPTH_BUFFER != null),
      programReversed: prog && typeof prog.cacheKey === "string" ? /USE_REVERSED_DEPTH_BUFFER/.test(prog.cacheKey) : null,
      depthBufferBound: !!(cm && cm.uniforms && cm.uniforms.depthBuffer && cm.uniforms.depthBuffer.value),
      frustumCornersReversedAware: /reversedDepth/.test(String(
        eff.shadowMaps && eff.shadowMaps.cameraFrustum && eff.shadowMaps.cameraFrustum.setFromCamera || "")),
      // −camera.near when the cloud shadow cascades start at the eye (both modes).
      cascadeNearZ,
      cameraNear: cam ? cam.near : null,
      cameraReversed: cam ? cam.reversedDepth === true : null,
      frame: eff.frame ?? null,
    };
  }
  return out;
}
