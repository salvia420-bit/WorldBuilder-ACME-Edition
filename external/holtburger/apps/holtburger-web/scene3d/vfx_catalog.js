// VFX descriptor catalog — client fetch + descriptor-by-mech router
// (Visual-Behavior Suite, Phase 0 / commit 3, 2026-06-23).
//
// Loads the per-DID visual-behavior descriptors the WorldBuilder.Terminal
// classifier emits (visual_descriptors.jsonl, same JSONL shape as the C#
// VisualDescriptorIndex), and routes each DID's components to the right runtime
// mechanism. Gated by ?visual (default OFF); when off OR the catalog is absent,
// nothing is consulted → byte-identical frozen render. ?treeWind keeps its own
// hardcoded path; the two coexist (statics.js peels a placement to the wind
// player if EITHER selects it).
//
// Import-cycle-safe: imports nothing from the scene3d graph.

function _strFlag(name) {
  try {
    if (typeof window !== "undefined" && window.location) {
      return new URLSearchParams(window.location.search).get(name);
    }
  } catch (_) { /* default */ }
  return null;
}

let _flag;
/** ?visual enables the descriptor-catalog-driven VFX path. DEFAULT-OFF.
 *  Accepts on|1|true|yes or a non-"off" value (e.g. ?visual=archetypes). */
export function visualEnabled() {
  if (_flag !== undefined) return _flag;
  let on = false;
  const v = _strFlag("visual");
  if (v != null) {
    const s = v.toLowerCase();
    on = s !== "off" && s !== "0" && s !== "false" && s !== "no" && s !== "";
  }
  return (_flag = on);
}

// Component-id → runtime mechanism (the router). MECH-A = the animated_scenery
// shared-mixer keyframe player; B = GPU begin_vertex displacement; frag =
// fragment material patch; particle = synthesized emitter. Extended per commit.
export const COMPONENT_MECH = {
  "deformation.windBend": "A",
  "deformation.tipFlex": "B",
  "emissive.glint": "frag",
  "emissive.magicGlow": "frag",          // + slice 06 (P1.7)
  "emissive.enchantShimmer": "frag",     // + slice 07 (P1.8)
  "weathering.tarnish": "frag",
  "weathering.wetness": "frag",          // + slice 09 (P1.10)
  "weathering.frost": "frag",            // + slice 10 (P1.11)
  "particle.gemSparkle": "particle",     // + Phase 3 (P3.3) synthesized additive emitter
  "particle.brazierEmbers": "particle",  // + Phase 3 (P3.6) embers+smoke flame-bowl
  "particle.foliagePollen": "particle",  // + Phase 3 (P3.7) daytime motes
  "particle.foliageFireflies": "particle", // + Phase 3 (P3.7) dusk additive swarm
  "particle.foliageLeaves": "particle",  // + Phase 3 (P3.7) canopy falling leaves
  "particle.breathFog": "particle",      // + Phase 3 (P3.7) creature head cold-breath
};

const DEFAULT_CATALOG_URL = "../../dist/vfx/visual_descriptors.jsonl";
let _catalogUrl = DEFAULT_CATALOG_URL;
let _catalog = new Map(); // didNum -> { archetype, componentIds:Set<string>, config, raw }
let _loadPromise = null;

/** Override the catalog URL (runtime wiring); call before the first bake. */
export function initVfxCatalogUrl(url) {
  if (typeof url === "string" && url) _catalogUrl = url;
}

function _didToNum(d) {
  if (typeof d === "number") return d >>> 0;
  if (typeof d === "string") return (parseInt(d, d.startsWith("0x") || d.startsWith("0X") ? 16 : 10) >>> 0);
  return 0;
}

/**
 * Parse a visual_descriptors.jsonl text into a Map(didNum -> descriptor).
 * Tolerant of the C# emit shape: `did` may be a hex string ("0x02001063") or a
 * number; `components` may be an array of id-strings OR of {id} objects. Pure.
 */
export function parseDescriptorsJsonl(text) {
  const map = new Map();
  if (typeof text !== "string") return map;
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s || s[0] === "#") continue;
    let o;
    try { o = JSON.parse(s); } catch (_) { continue; }
    const did = _didToNum(o.did);
    if (!did) continue;
    const componentIds = new Set();
    const comps = o.components;
    if (Array.isArray(comps)) {
      for (const c of comps) {
        if (typeof c === "string") componentIds.add(c);
        else if (c && typeof c.id === "string") componentIds.add(c.id);
      }
    }
    map.set(did, { archetype: o.archetype || "", componentIds, config: o.config || {}, raw: o });
  }
  return map;
}

/** Test/runtime hook: install a pre-built catalog Map (skips fetch). */
export function setVfxCatalog(map) { _catalog = map instanceof Map ? map : new Map(); _loadPromise = Promise.resolve(_catalog); }

/** Reset (tests). */
export function _resetVfxCatalog() { _catalog = new Map(); _loadPromise = null; _flag = undefined; }

/**
 * Fetch + parse the catalog ONCE (cached promise). Fail-soft: a missing/unreadable
 * catalog leaves an empty Map → the VFX path selects nothing → byte-identical
 * frozen. Safe to await from the (async) statics bake.
 */
export function ensureVfxCatalog() {
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      if (typeof fetch !== "function") return _catalog;
      const res = await fetch(_catalogUrl);
      if (!res || !res.ok) return _catalog;
      _catalog = parseDescriptorsJsonl(await res.text());
      // eslint-disable-next-line no-console
      console.log(`[vfx] loaded ${_catalog.size} descriptors from ${_catalogUrl}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[vfx] catalog load failed (${_catalogUrl}); VFX path inert:`, e?.message || e);
    }
    return _catalog;
  })();
  return _loadPromise;
}

/** The descriptor for a DID, or null. */
export function vfxDescriptorFor(did) {
  return _catalog.get((did >>> 0)) || null;
}

/** The set of runtime mechanisms a descriptor's components need (the router). */
export function descriptorMechs(descriptor) {
  const out = new Set();
  if (descriptor?.componentIds) {
    for (const id of descriptor.componentIds) {
      const m = COMPONENT_MECH[id];
      if (m) out.add(m);
    }
  }
  return out;
}

/** True if the descriptor carries the MECH-A deformation.windBend component
 *  (the only one wired to the animated_scenery player in Phase 0). */
export function hasWindBend(descriptor) {
  return !!descriptor?.componentIds?.has("deformation.windBend");
}
