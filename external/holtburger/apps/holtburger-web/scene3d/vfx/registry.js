// VFX component registry — Visual-Behavior Suite, Phase 0 (2026-06-23).
//
// Per the build spec §2: a VisualComponent is a plain JS object implementing the
// contract below. Components self-register here; archetypes (later) select which
// components a DID carries. This commit lands the substrate + the first component
// (deformation.windBend) wrapping the shipped tree-wind math, so ?treeWind=on
// stays byte-identical and ?visual defaults OFF.
//
// VisualComponent contract (spec §2.2):
//   id: string                  // e.g. "deformation.windBend" (the classifier emits this)
//   family: deformation|weathering|emissive|texture|particle
//   mech: "A"|"B"|"frag"|"light"|"particle"
//   channel: string             // §14 conflict unit, e.g. "transform"
//   linkVariant(config): string // LINK-affecting bits ONLY (MECH-B/frag); "" = none
//   buildClip?(ctx, config)     // MECH-A only -> {frames,numParts,numFrames,fps}
//   inject?(shader, ctx)        // MECH-B/frag GLSL (later commits)
//   declareUniforms?(shader, config, globals)
//   tick?(dt, t)                // updates SHARED uniforms only; O(1)
//   // legacy-safety manifest (spec §1.2 / §13 lint), enforced at register time:
//   reads: string[]; writes: string[];
//   deterministic: true; lightCountDelta: 0; cacheKeyScope: "set"|"none"  // never "instance"
//   defaults: object

// Composition order on the single _chainBeforeCompile chain (spec §2.3).
export const FAMILY_ORDER = { deformation: 0, texture: 1, weathering: 2, emissive: 3, particle: 9 };

// Legacy-safety vocab (spec §1.2). READS = static/derived inputs + client clock.
// WRITES = render-time transforms / cloned-material uniforms / emitters ONLY —
// never the wire value, physics/collision, or any server-replicated field.
const READ_CAPS = new Set([
  "geometry", "surface", "setup", "weenieProps", "serverPose", "instanceHash", "clock", "drawCastSubstate", "weather",
]);
const WRITE_CAPS = new Set(["renderTransform", "partTransform", "materialUniform", "emitter"]);
const FAMILIES = new Set(["deformation", "weathering", "emissive", "texture", "particle"]);
const MECHS = new Set(["A", "B", "frag", "light", "particle"]);

const _components = new Map();

/** Returns an array of contract violations ([] = valid). Pure. */
export function validateComponent(c) {
  const errs = [];
  if (!c || typeof c.id !== "string") errs.push("missing id");
  if (!FAMILIES.has(c?.family)) errs.push(`bad family ${c?.family}`);
  if (!MECHS.has(c?.mech)) errs.push(`bad mech ${c?.mech}`);
  if (typeof c?.channel !== "string") errs.push("missing channel");
  // The two firewall corollaries the lint enforces hard (spec §1.2):
  if (c?.deterministic !== true) errs.push("deterministic must be true (no Math.random)");
  if (c?.lightCountDelta !== 0) errs.push("lightCountDelta must be 0 (never change visible light count -> relink freeze)");
  if (c?.cacheKeyScope !== "set" && c?.cacheKeyScope !== "none") {
    errs.push(`cacheKeyScope must be "set"|"none", never "instance" (shader-link explosion); got ${c?.cacheKeyScope}`);
  }
  if (!Array.isArray(c?.reads) || !c.reads.every((r) => READ_CAPS.has(r))) {
    errs.push(`reads must be a subset of [${[...READ_CAPS].join(",")}]`);
  }
  if (!Array.isArray(c?.writes) || !c.writes.every((w) => WRITE_CAPS.has(w))) {
    errs.push(`writes must be a subset of [${[...WRITE_CAPS].join(",")}]`);
  }
  return errs;
}

/** Register a component (throws on a contract violation). Returns the component. */
export function registerComponent(c) {
  const errs = validateComponent(c);
  if (errs.length) throw new Error(`[vfx] invalid component ${c?.id}: ${errs.join("; ")}`);
  _components.set(c.id, c);
  return c;
}

export function getComponent(id) { return _components.get(id); }
export function allComponents() { return [..._components.values()]; }
/** Test-only: clear the registry. */
export function _clearComponents() { _components.clear(); }
