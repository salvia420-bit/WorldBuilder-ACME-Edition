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
// Guarded on the define, so a non-log renderer (none today) is untouched and the
// shader compiles to exactly what it was before.
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
