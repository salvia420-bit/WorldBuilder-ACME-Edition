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

import { vfxDescriptorFor } from "../vfx_catalog.js";
import { getComponent, FAMILY_ORDER } from "./registry.js";

// The chain-composition order (spec §2.3): deformation < texture < weathering <
// emissive < particle. A frag plan is sorted by (FAMILY_ORDER[family], id) so the
// _chainBeforeCompile order is deterministic and the derived component-SET key
// (slice 02) is stable for a given component set.
function _orderKey(comp) {
  const fam = FAMILY_ORDER[comp.family];
  return (fam == null ? 99 : fam) * 1000 + 0; // family-major; id breaks ties (string compare)
}

// Split a descriptor's flat config{} into:
//   • byId   — per-component override buckets: a top-level key whose value is a
//              plain object (e.g. "emissive.glint": { strength: 0.9 }).
//   • shared — every scalar/array top-level key (e.g. age: 0.4), applied to ALL
//              components. The classifier emits scalars for shared knobs.
// Precedence (low→high): comp.defaults < shared < byId[comp.id].
function _splitConfig(descriptorConfig) {
  const shared = {};
  const byId = {};
  const cfg = descriptorConfig || {};
  for (const k in cfg) {
    if (!Object.prototype.hasOwnProperty.call(cfg, k)) continue;
    const v = cfg[k];
    if (v && typeof v === "object" && !Array.isArray(v)) byId[k] = v;
    else shared[k] = v;
  }
  return { shared, byId };
}

/**
 * Merge a descriptor's config onto one component's defaults (pure).
 * @param {object} comp   a registered VisualComponent (has `.defaults`, `.id`)
 * @param {{shared:object, byId:object}} split  from _splitConfig
 * @returns {object} the per-component config handed to declareUniforms (uniform
 *          VALUES) + the heap-dedup configKey — NEVER the program-cache key.
 */
export function mergeComponentConfig(comp, split) {
  return { ...(comp.defaults || {}), ...split.shared, ...(split.byId[comp.id] || {}) };
}

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
