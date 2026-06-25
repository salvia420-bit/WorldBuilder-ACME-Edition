// scene3d/vfx/config_merge.js
// Phase-4 (P4.1a) — the ONE descriptor config-split + per-component merge, extracted
// byte-for-byte from the formerly-duplicated copies in frag_attach.js + particle_attach.js
// (they were intentionally replicated for node-isolation; this module imports NOTHING from
// the scene graph, so it stays node-testable in isolation). Pure.

// Split a descriptor's flat config{} into:
//   • byId   — per-component override buckets: a top-level key whose value is a plain
//              (non-array) object (e.g. "emissive.glint": { strength: 0.9 }), keyed by component id.
//   • shared — every scalar/array top-level key (e.g. age: 0.4), applied to ALL components.
// Precedence (low→high): comp.defaults < shared < byId[comp.id].
export function splitConfig(descriptorConfig) {
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
 * Merge a descriptor's config onto one component's defaults (pure). The result is the
 * per-component config handed to declareUniforms (frag, uniform VALUES) / emit ctx.config
 * (particle) + the heap-dedup configKey — NEVER the program-cache key.
 * @param {object} comp  a registered VisualComponent (`.defaults`, `.id`)
 * @param {{shared:object, byId:object}} split  from splitConfig
 */
export function mergeComponentConfig(comp, split) {
  return { ...(comp.defaults || {}), ...split.shared, ...(split.byId[comp.id] || {}) };
}
