// VFX MECH-B vertex-displacement SEAM HELPER — Visual-Behavior Suite, Phase 2 /
// P2.1 (2026-06-24). JS-ONLY (no wasm; pure string surgery).
//
// WHY THIS IS A HELPER, NOT A SECOND CLONE (the ONE-PROGRAM proof):
// A MECH-B component (e.g. deformation.tipFlex) is selected into the SAME
// frag_attach plan as its frag set-mate (emissive.glint) — frag_attach.js now
// admits mech "B" into the entries list — and built by the SAME
// frag_install.buildFragVariant call. That single
// materials.getCachedVariant(surfaceDid, setKey, configKey) clone stamps ONE
// userData.__vfxSetKey spanning BOTH components and runs ONE _chainBeforeCompile
// chain. Each component's inject() then patches ITS OWN shader stage:
//   • emissive.glint  → shader.fragmentShader (its emissivemap_fragment seam)
//   • deformation.tipFlex → shader.vertexShader (the begin_vertex seam, via THIS
//     helper).
// Same clone → same __vfxSetKey → same customProgramCacheKey (materials.js
// _patchSetCacheKey reads "|v"+__vfxSetKey) → ONE compiled WebGLProgram for the
// combined SET. This module NEVER references getCachedVariant /
// customProgramCacheKey / __vfxSetKey / shader.uniforms, so it cannot fork the
// program: program count stays O(distinct SETs), never O(DIDs|instances)
// (spec §2.4 firewall).
//
// COMPOSES ON THE CHAIN (precedent: per_instance.ensureVfxHashVarying ALSO
// patches `#include <begin_vertex>`). The shared vVfxHash prelude and every
// MECH-B body splice after the SAME anchor; each chained installer re-finds the
// (still-present) anchor and prepends its block right after it. `transformed`
// writes are order-independent — each `transformed += …` accumulates, and
// vVfxHash reads only the per-instance matrix translation — so chain order never
// changes the rendered result.
//
// THE FIREWALL (spec §1.2): a MECH-B body WRITES only `transformed` — a render-
// time vertex transform on a cloned, cache-owned material three re-uploads each
// frame and the server neither stores nor replicates (entities.js setPose copy()
// stomps any render-frame write every server tick; the collision BSP is
// untouched). It READS only uniforms/varyings the component bound from static/
// derived inputs (DAT geometry/Setup, server pose/heading, deterministic hash01)
// + the client clock. No wire value, no physics/collision, no per-instance
// program key, no light-count change.
//
// THREE-free + import-cycle-safe: imports nothing. The component owns the GLSL;
// this module only splices it idempotently — mirroring per_instance.js so it
// stays node-testable (no THREE, no DOM).

// The MeshStandard vertex chunk that defines `vec3 transformed = vec3( position );`
// — every MECH-B displacement appends after it so `transformed` is in scope.
export const VERTEX_BEGIN_SEAM = "#include <begin_vertex>";
// Global-scope insertion point for uniform/varying/helper declarations (before
// main()), matching per_instance.js + the POM/CSM vertex patches in materials.js.
export const VERTEX_PARS_SEAM = "#include <common>";

// Insert ONE single-line shared declaration (e.g. "uniform float uTime;") after
// the pars seam, only if it is not already present anywhere in the vertex source.
// Collision-safe for declarations SHARED across MECH-B components in one SET — a
// GLSL redeclaration is a compile error, and uTime is the single shared VFX clock
// (VFX_GLOBALS.uTime), declared by every component that animates. Mirrors
// glint._ensureUniformDecl, line-exact. Pure. `decl` MUST be a single line with
// no backtick (a backtick would close the JS literal in a caller's block).
function _ensureSharedDecl(vs, decl) {
  if (!decl || vs.includes(decl)) return vs;
  if (!vs.includes(VERTEX_PARS_SEAM)) return vs; // non-standard shader → inert
  return vs.replace(VERTEX_PARS_SEAM, VERTEX_PARS_SEAM + "\n" + decl);
}

/**
 * Idempotently splice a MECH-B vertex-displacement into a three onBeforeCompile
 * `shader` object: declare the component's own `parsVertex` (uniforms/varyings/
 * helpers) + any `sharedUniforms` (deduped) at global scope, then append `body`
 * (which modifies `transformed`) after `#include <begin_vertex>`.
 *
 * COLOR-pass material only — the depth/shadow pass uses a SEPARATE, unpatched
 * material (getCachedVariant tags the clone __vfxColorPassOnly; scene3d/vfx/
 * shadow_guard.js keeps three's internal _depthMaterial off our onBeforeCompile),
 * so a vertex displacement never perturbs the shadow silhouette unless a later
 * slice explicitly mirrors it.
 *
 * Recompile/collision-safe:
 *   • `marker` — a unique substring the caller embeds in `body`; if already in
 *     the vertex source, the whole injection is skipped (three calls
 *     onBeforeCompile once, but a material may be re-needsUpdate'd).
 *   • `parsVertex` is injected ATOMICALLY (whole block, once) — guarded by the
 *     same `marker`, so coincidental shared lines (`}`/braces) are never dropped.
 *   • `sharedUniforms` are deduped INDIVIDUALLY (one-line decls) so a uniform a
 *     sibling MECH-B component in the SET already declared is not redeclared.
 *
 * ORDERING / `afterBlock` (read-vVfxHash-safe): by default `body` is appended
 * right after `#include <begin_vertex>`. But the shared per-instance prelude
 * (per_instance.VFX_HASH_ASSIGN_VERTEX) installs FIRST in the chain and ALSO
 * splices after `#include <begin_vertex>`, so a later body anchored on the same
 * seam lands BEFORE the `vVfxHash = …` assignment (chain installers prepend at
 * the anchor). A component that READS vVfxHash in the VERTEX stage (e.g. tipFlex
 * phase variety) must pass `afterBlock: VFX_HASH_ASSIGN_VERTEX` (imported from
 * per_instance.js): when that block is present we anchor AFTER it so the hash is
 * written first; absent (prelude not installed) → fall back to begin_vertex. This
 * generalizes the component-owned pattern in components/tipFlex.js.
 *
 * Seam-absent (non-standard material) → returns the shader untouched (byte-
 * identical), exactly like glint's missing-seam guard.
 *
 * Pure string surgery: no THREE import, NO `shader.uniforms` write (the
 * component's declareUniforms owns uniform binding), NO customProgramCacheKey /
 * __vfxSetKey touch — this NEVER forks the program (the firewall).
 *
 * @param {{vertexShader?:string}} shader  three onBeforeCompile shader object
 * @param {{marker:string, parsVertex?:string, body:string, sharedUniforms?:string[], afterBlock?:string}} spec
 * @returns {object} the same `shader` (for chaining)
 */
export function injectBeginVertex(shader, spec = {}) {
  if (!shader || typeof shader.vertexShader !== "string") return shader;
  const { marker, parsVertex = "", body = "", sharedUniforms = [], afterBlock = "" } = spec;
  let vs = shader.vertexShader;
  if (marker && vs.includes(marker)) return shader;   // already patched (recompile)
  if (!vs.includes(VERTEX_BEGIN_SEAM)) return shader; // non-standard material → inert
  // Shared single-line uniform decls first (deduped across the SET), then this
  // component's own pars block (atomic, marker-guarded), then the body.
  for (const decl of sharedUniforms) vs = _ensureSharedDecl(vs, decl);
  if (parsVertex && vs.includes(VERTEX_PARS_SEAM)) {
    vs = vs.replace(VERTEX_PARS_SEAM, VERTEX_PARS_SEAM + "\n" + parsVertex);
  }
  if (body) {
    // Anchor AFTER the per-instance hash-assign block when the caller asks for it
    // and it is present (vVfxHash readable); else after begin_vertex.
    const anchor = afterBlock && vs.includes(afterBlock) ? afterBlock : VERTEX_BEGIN_SEAM;
    vs = vs.replace(anchor, anchor + "\n" + body);
  }
  shader.vertexShader = vs;
  return shader;
}

/** True if `shader`'s vertex stage already carries the `marker` patch. */
export function hasBeginVertexPatch(shader, marker) {
  return !!shader && typeof shader.vertexShader === "string" && !!marker &&
    shader.vertexShader.includes(marker);
}
