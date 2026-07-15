// three_batchedmesh_colortexture_fix — work around an UPSTREAM three.js r184 bug
// that makes EVERY BatchedMesh re-resolve its shader program EVERY frame.
//
// UPSTREAM: reported as mrdoob/three.js#34054 (2026-07-15).
//   https://github.com/mrdoob/three.js/issues/34054
// Introduced by three PR #28255 ("BatchedMesh: add getColorAt and setColorAt"),
// which added `object.colorTexture` in these two branches and the CORRECT
// `object._colorsTexture` for the uniform, in the same file. Still present on
// `dev` and in r185.1 as of 2026-07-15. ⇒ RETIRE THIS FILE once the upstream fix
// ships and we bump three: `applyBatchedMeshColorTextureFix` already no-ops when
// three defines the property itself, so the retirement is safe but the module,
// its flag, and its test should go.
//
// THE BUG (three r184; present in the bundled build AND in the unbundled source,
// so it is genuine upstream, not a build artifact):
//
//   three.module.js:18340  (== src/renderers/WebGLRenderer.js:2400)
//     } else if ( object.isBatchedMesh && materialProperties.batchingColor === true
//                 && object.colorTexture === null ) { needsProgramChange = true; }
//   three.module.js:18344  (== src/renderers/WebGLRenderer.js:2404)
//     } else if ( object.isBatchedMesh && materialProperties.batchingColor === false
//                 && object.colorTexture !== null ) { needsProgramChange = true; }
//
// `BatchedMesh` HAS NO `colorTexture` PROPERTY. Its field is `_colorsTexture`
// (three.core.js:25975; serialized as `colorsTexture` — plural). `colorTexture`
// appears nowhere else in the renderer. The InstancedMesh twins of these two
// branches read `object.instanceColor`, which IS a real property — so this pair
// was evidently written by analogy and got the name wrong.
//
// Consequence, for a BatchedMesh with no per-instance colours (all of ours):
//   materialProperties.batchingColor === false        (correct: _colorsTexture is null)
//   object.colorTexture                 === undefined (the property does not exist)
//   undefined !== null                  === TRUE      -> branch :18344 fires
// => `needsProgramChange = true` on EVERY BatchedMesh EVERY frame -> `getProgram`
//    -> `getParameters` + a program-cache-key STRING BUILD — to arrive back at
//    the identical program it already had (the early-out at :18127 is only
//    reached AFTER that work is done). Branch :18340 can never fire at all.
//
// MEASURED (1070, settled Holtburg, net-review/npc-counter-probe.mjs, which
// counts the branches inside three's own source; A/B/A/B/A in ONE page load):
//   branch :18344   179/frame -> 0/frame
//   getProgram      258/frame -> 78/frame   (-70%)
//   renderCPU       28.29ms   -> 24.95ms    (-3.35ms, -11.8%; A spread 1.70ms)
//
// THE FIX is the getter three clearly meant to read. Do NOT just assign
// `colorTexture = null`: that silences :18344 today but INVERTS the bug the
// moment anything calls `setColorAt()` — `_colorsTexture` becomes non-null,
// `batchingColor` flips to true, and then :18340 (`colorTexture === null`) would
// fire every frame instead. Aliasing the real field is correct in both states:
//   no colours: colorTexture === null  -> :18340 needs batchingColor===true (it is false) -> inert
//                                      -> :18344 needs colorTexture!==null (it is null)  -> inert
//   colours:    colorTexture === tex   -> :18340 needs colorTexture===null  -> inert
//                                      -> :18344 needs batchingColor===false (it is true) -> inert
//
// Patching the PROTOTYPE once covers every BatchedMesh in the app (static_batch_x
// chunk buckets, statics per-LB batches, static_atlas buckets, terrain_batch)
// without touching four creation sites — and it self-retires: if three ever fixes
// the name, `'colorTexture' in prototype` becomes true and this becomes a no-op.
//
// NO VISUAL SURFACE: `colorTexture` is read at exactly those two branches and
// nowhere else, and both only decide whether to RE-DERIVE a program that is
// identical either way. This changes how often three recomputes, never what it
// draws. `?bmColorTextureFix=off` escapes.
let _applied = false;

export function bmColorTextureFixEnabled() {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      const v = (new URLSearchParams(globalThis.location.search).get("bmColorTextureFix") || "").toLowerCase();
      if (v === "off" || v === "0" || v === "false" || v === "no") return false;
    }
  } catch (_) { /* fail-soft: keep the fix on */ }
  return true;
}

/**
 * Define `BatchedMesh.prototype.colorTexture` as an alias of the real
 * `_colorsTexture` field, so three's two BatchedMesh colour branches compare a
 * property that actually exists. Idempotent; a no-op if three ever ships the
 * property itself. Returns true if the alias is now in place.
 */
export function applyBatchedMeshColorTextureFix(THREE) {
  if (_applied) return true;
  if (!bmColorTextureFixEnabled()) return false;
  try {
    const proto = THREE?.BatchedMesh?.prototype;
    if (!proto) return false;
    // Already present (either three fixed it, or we ran twice) -> nothing to do.
    if ("colorTexture" in proto) { _applied = true; return true; }
    Object.defineProperty(proto, "colorTexture", {
      configurable: true,
      enumerable: false,
      get() { return this._colorsTexture ?? null; },
    });
    _applied = true;
    return true;
  } catch (_) {
    return false; // fail-soft: worst case we keep three's per-frame re-resolve
  }
}

// Test seam.
export function __resetBmColorTextureFixForTest() { _applied = false; }
