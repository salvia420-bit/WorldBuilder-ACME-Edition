// VFX fragment-effect attach — descriptor → frag "plan" (Visual-Behavior Suite,
// Phase 1, 2026-06-23). Slice 13: thread the archetype descriptor config into
// the frag material path so ?visual drives the RIGHT components per DID.
//
// Split of responsibility (the integration seam):
//   • THIS module (descriptor level): given a DID, read its catalog descriptor
//     (vfx_catalog.vfxDescriptorFor) → select the descriptor's REGISTERED FRAG
//     components → merge the descriptor's config{} onto each component's defaults
//     → return a deterministic, FAMILY_ORDER-sorted "plan" ({ entries, ids }).
//     Pure: reads only the offline-baked descriptor + the live registry; never a
//     server/wire/replicated field (the config is static classifier output).
//   • frag_install.js (slice 02, shader level): turn that plan into ONE cached
//     per-component-SET material variant via materials.getCachedVariant — the
//     _chainBeforeCompile composition + VFX_GLOBALS-by-reference binding.
//   • statics.js (the wiring): at the two material-assignment seams, swap
//     getCached(surfaceDid) → buildFragVariant(mc, surfaceDid, plan.entries)
//     when ?visual && fragPlanForDid(modelId) != null.
//
// Off / no descriptor / no registered frag component ⇒ fragPlanForDid returns
// null ⇒ the caller keeps the plain getCached material ⇒ byte-identical frozen.
//
// Import-cycle-safe: imports only vfx_catalog.js (imports nothing from the scene
// graph) + registry.js (the component contract). frag_install.js is imported by
// statics.js at the seam, NOT here, so this module + its test stand alone.

import { vfxDescriptorFor, windResponds } from "../vfx_catalog.js";
import { getComponent, FAMILY_ORDER } from "./registry.js";
import { splitConfig as _splitConfig, mergeComponentConfig } from "./config_merge.js";
// GPU instanced tree sway (?treeWindGpu, default-ON). tree_wind imports nothing
// from the scene graph, so this stays import-cycle-safe + node-testable.
import { windSwayGpuEnabled } from "../tree_wind.js";

// The chain-composition order (spec §2.3): deformation < texture < weathering <
// emissive < particle. A frag plan is sorted by (FAMILY_ORDER[family], id) so the
// _chainBeforeCompile order is deterministic and the derived component-SET key
// (slice 02) is stable for a given component set.
function _orderKey(comp) {
  const fam = FAMILY_ORDER[comp.family];
  return (fam == null ? 99 : fam) * 1000 + 0; // family-major; id breaks ties (string compare)
}

// _splitConfig + mergeComponentConfig moved to ./config_merge.js (P4.1a — frag_attach
// and particle_attach shared a byte-identical copy). Re-exported so any importer of
// mergeComponentConfig from this module is unaffected (the seam handed to declareUniforms
// = uniform VALUES + the heap-dedup configKey — NEVER the program-cache key).
export { mergeComponentConfig };

/**
 * The registered FRAG components a DID's descriptor carries, as FAMILY_ORDER-
 * sorted {comp, config} entries. Selection rules (all fail-soft → []):
 *   • the component id must resolve in the live registry (getComponent), AND
 *   • its registered mech must be "frag" (the registry is authoritative — the
 *     catalog's COMPONENT_MECH is only the offline router), AND
 *   • an optional per-effect gate: if comp.enabled is a function and returns a
 *     falsey value the component is skipped (lets slice 14's ?glint/?tarnish/…
 *     per-effect flags plug in without touching this module).
 * @param {object|null} descriptor  vfxDescriptorFor(did) result
 * @returns {Array<{comp:object, config:object}>}  sorted; [] when none
 */
export function fragEntriesForDescriptor(descriptor) {
  const ids = descriptor && descriptor.componentIds;
  if (!ids || typeof ids.forEach !== "function") return [];
  const split = _splitConfig(descriptor.config);
  const out = [];
  ids.forEach((id) => {
    const comp = getComponent(id);
    // P2 — admit BOTH the fragment seam ("frag") AND the MECH-B vertex seam ("B")
    // so a single descriptor SET (e.g. [deformation.tipFlex (B), emissive.glint
    // (frag)]) resolves as ONE plan -> ONE getCachedVariant -> ONE __vfxSetKey.
    // installVfxComponentPatch dispatches each entry to its own shader seam by
    // comp.mech; the comp.enabled gate below still drops a component when its
    // per-effect flag is off (tipFlex -> ?tipFlex), so widening membership never
    // forces an effect on. FAMILY_ORDER puts deformation(0) before emissive(3) ->
    // the vertex patch is installed before the frag patch on the shared chain.
    if (!comp || (comp.mech !== "frag" && comp.mech !== "B")) return; // not a patchable comp
    if (typeof comp.enabled === "function" && !comp.enabled()) return; // per-effect flag (slice 14)
    out.push({ comp, config: mergeComponentConfig(comp, split) });
  });
  // GPU instanced tree sway (?treeWindGpu, default-ON, MECH-B). The baked catalog
  // tags wind-responsive foliage with the MECH-A deformation.windBend (the keyframe
  // peel, which de-instances → 1 fps); we add the MECH-B windSwayGpu component at
  // RUNTIME (no re-bake) so the SAME windResponds() DIDs the old default-on peel
  // animated now bend in the vertex shader on the frozen INSTANCED material. The
  // component's enabled gate stands down under the CPU peel paths / ?treeWindGpu=off,
  // so this never double-bends. It's a "B" mech → the install path patches the
  // vertex shader, and FAMILY_ORDER (deformation=0) sorts it first below.
  if (windSwayGpuEnabled() && windResponds(descriptor)) {
    const ws = getComponent("deformation.windSwayGpu");
    if (ws && !out.some((e) => e.comp === ws)) {
      out.push({ comp: ws, config: mergeComponentConfig(ws, split) });
    }
  }
  // FAMILY_ORDER-major, id-minor — stable + matches the chain composition order.
  out.sort((a, b) => {
    const d = _orderKey(a.comp) - _orderKey(b.comp);
    return d !== 0 ? d : (a.comp.id < b.comp.id ? -1 : a.comp.id > b.comp.id ? 1 : 0);
  });
  return out;
}

/**
 * The frag "plan" for a DID, or null when there's nothing to attach.
 * Computed ONCE per placement / per model at the statics seam (the descriptor is
 * keyed by modelId, not surfaceDid); the resulting material is then resolved
 * per surfaceDid by frag_install.buildFragVariant. Does NOT itself read the
 * ?visual flag — the seam gates with visualEnabled() (mirroring the windBend
 * peel idiom `visualEnabled() && hasWindBend(...)`), and an un-ensured catalog is
 * empty so this returns null anyway.
 * @param {number} did  the object/model DID (placement.modelId)
 * @returns {{entries:Array<{comp,config}>, ids:string[]}|null}
 */
export function fragPlanForDid(did) {
  const entries = fragEntriesForDescriptor(vfxDescriptorFor(did));
  if (entries.length === 0) return null;
  return { entries, ids: entries.map((e) => e.comp.id) };
}

/** True if a DID's descriptor carries ≥1 registered FRAG component (diagnostics
 *  parity with vfx_catalog.hasWindBend; e.g. for the gauge / stats). */
export function isFragDid(did) {
  return fragEntriesForDescriptor(vfxDescriptorFor(did)).length > 0;
}
