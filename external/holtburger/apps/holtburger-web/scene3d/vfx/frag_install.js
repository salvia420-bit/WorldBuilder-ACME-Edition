// VFX frag-component attach path (Visual-Behavior Suite, Phase 1 / slice 02,
// 2026-06-23).
//
// Given a DID's descriptor + the surface DID of a static node, resolve the
// fragment-family material VARIANT: a CLONE of the surface's base material
// (materials.js getCachedVariant — shares textures) whose onBeforeCompile chain
// carries every frag component's declareUniforms + inject, composed in
// (FAMILY_ORDER, id) order under ONE __vfxSetKey. statics.js swaps
// `materialCache.getCached(surfaceDid)` -> `resolveFragMaterial(...)` at its
// material-assignment sites when ?visual && the descriptor carries frag
// components; off ⇒ returns null ⇒ caller keeps the base ⇒ byte-identical.
//
// THE FIREWALL (spec §2.4): the program-cache key is per component-SET (the
// single __vfxSetKey read by materials.js _patchSetCacheKey). componentSetKey()
// encodes ONLY the set membership + each component's linkVariant() bits — NEVER
// config scalars or per-instance hashes. Config flows through uniforms; the
// per-instance float is a varying (slice 03). So program count ≈ distinct
// component SETs (~a handful), never ~10k DIDs. The (surfaceDid|setKey|configKey)
// clone key dedups material OBJECTS on the heap (configKey), but two clones with
// the same setKey share ONE compiled program.
//
// Import-cycle-safe + THREE-free: this module imports nothing from the THREE
// world. The host (statics bake) injects `globals` (VFX_GLOBALS) and
// `installComponentPatch` (materials.js installVfxComponentPatch) so the firewall
// material surgery stays inside materials.js and this module stays node-testable.

import { FAMILY_ORDER, getComponent } from "./registry.js";
import { COMPONENT_MECH, vfxDescriptorFor, visualEnabled } from "../vfx_catalog.js";

// The mechs whose components attach on the getCachedVariant clone under ONE
// __vfxSetKey. "frag" = fragment-seam patch (Phase 1); "B" = MECH-B vertex
// displacement at #include <begin_vertex> (Phase 2, deformation.tipFlex) — it
// reuses the SAME getCachedVariant chain + __vfxSetKey, so it joins this set. The
// installer (installVfxComponentPatch) dispatches each entry to its seam by mech.
export const PATCH_MECHS = Object.freeze(new Set(["frag", "B"]));

/** Composition order: family bucket (FAMILY_ORDER) then id ascending. The chain
 *  runs hooks in this order; matches the seam composition every frag component
 *  documents (e.g. enchantShimmer sorts before magicGlow ⇒ shimmer multiply runs
 *  AFTER the glow add). Pure. */
function _orderComparator(a, b) {
  const fa = FAMILY_ORDER[a.family] ?? 99;
  const fb = FAMILY_ORDER[b.family] ?? 99;
  if (fa !== fb) return fa - fb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Deterministic key-sorted serialization (no Date.now/Math.random). Used only
 *  for the heap-dedup configKey, never the program key. */
function _stableStr(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(_stableStr).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + _stableStr(v[k])).join(",") + "}";
}

/** Per-component config slice from the descriptor config. Supports a
 *  namespaced shape ({ "emissive.glint": {...} }) and falls back to the flat
 *  descriptor config for a single-component effect. Each component still merges
 *  its own `defaults` internally (see magicGlow/enchantShimmer), so this only
 *  has to deliver the overrides. Pure. (Slice 13 owns the richer mapping.) */
export function configForComponent(comp, descriptorConfig) {
  const c = descriptorConfig || {};
  const named = c[comp.id];
  return named && typeof named === "object" ? named : c;
}

/**
 * The ordered list of registered frag (patch-mech) components a descriptor
 * carries. Unregistered ids (barrel not imported / unknown) and non-patch
 * mechs (MECH-A windBend, light.*) are skipped. Sorted by (FAMILY_ORDER, id).
 * Pure — drives both the setKey and the install order.
 * @param {{componentIds?:Set<string>}|null} descriptor
 * @param {Set<string>} [patchMechs]
 * @returns {object[]} VisualComponent objects, ordered
 */
export function fragComponentsForDescriptor(descriptor, patchMechs = PATCH_MECHS) {
  if (!descriptor || !descriptor.componentIds) return [];
  const out = [];
  for (const id of descriptor.componentIds) {
    const comp = getComponent(id);
    if (!comp) continue; // not registered yet (component barrel not imported)
    const mech = comp.mech || COMPONENT_MECH[id];
    if (!patchMechs.has(mech)) continue; // MECH-A / light / particle: not this path
    out.push(comp);
  }
  out.sort(_orderComparator);
  return out;
}

/**
 * The component-SET key (drives the program cache key, spec §2.4). Encodes the
 * ordered set membership + each component's linkVariant() bits ONLY — NEVER
 * config scalars or per-instance hashes. Order-independent in INPUT (callers may
 * pass any order; we treat `comps` as the already-ordered list from
 * fragComponentsForDescriptor, so identical sets ⇒ identical key). Pure.
 * @param {object[]} comps  ordered frag components
 * @param {object} [descriptorConfig]
 * @returns {string}
 */
export function componentSetKey(comps, descriptorConfig) {
  return comps
    .map((c) => {
      let v = "";
      try { v = c.linkVariant ? c.linkVariant(configForComponent(c, descriptorConfig)) || "" : ""; }
      catch (_) { v = ""; }
      return v ? `${c.id}:${v}` : c.id;
    })
    .join("+");
}

/**
 * The link-IRRELEVANT config hash (spec §2.6) — dedups material CLONES on the
 * heap (two DIDs, same SET + same config ⇒ one clone) but does NOT enter the
 * program key. Pure.
 * @param {object[]} comps  ordered frag components
 * @param {object} [descriptorConfig]
 * @returns {string}
 */
export function fragConfigKey(comps, descriptorConfig) {
  const parts = comps.map((c) => c.id + "=" + _stableStr(configForComponent(c, descriptorConfig)));
  return parts.join("&") || "default";
}

let _warnedNoInstaller = false;

/**
 * Resolve the frag-variant material for a (surfaceDid, descriptor) pair, or null
 * when the VFX path is off / the descriptor carries no frag components / no
 * installer was supplied. Returning null lets the caller keep the base material —
 * the byte-identical-when-off guarantee.
 *
 * @param {object}   o
 * @param {object}   o.materialCache          MaterialCache (has getCachedVariant)
 * @param {number}   o.surfaceDid             the surface DID for the material
 * @param {{componentIds?:Set<string>,config?:object}|null} o.descriptor  the DID's descriptor
 * @param {object}   o.globals                VFX_GLOBALS (shared {value} objects, bound by reference)
 * @param {(material:object, comp:object, cfg:object, globals:object)=>void} o.installComponentPatch
 *        materials.js installVfxComponentPatch — chains declareUniforms + inject via _chainBeforeCompile
 * @param {object} [o.sharedPrelude]  an optional component-shaped object
 *        ({declareUniforms?, inject}) installed FIRST in the chain so it runs
 *        before every component inject — slice 03 plugs the per-instance-hash
 *        `vVfxHash` varying in here once for the whole SET (no-op if absent).
 * @param {Set<string>} [o.patchMechs]
 * @returns {object|null} the cloned variant material, or null
 */
export function resolveFragMaterial({ materialCache, surfaceDid, descriptor, globals, installComponentPatch, sharedPrelude, patchMechs = PATCH_MECHS }) {
  if (!visualEnabled()) return null;
  if (!materialCache || typeof materialCache.getCachedVariant !== "function") return null;
  if (typeof installComponentPatch !== "function") {
    if (!_warnedNoInstaller) {
      _warnedNoInstaller = true;
      // eslint-disable-next-line no-console
      console.warn("[vfx] resolveFragMaterial: no installComponentPatch supplied; frag path inert (base material kept)");
    }
    return null;
  }
  const comps = fragComponentsForDescriptor(descriptor, patchMechs);
  if (comps.length === 0) return null;

  const cfg = (descriptor && descriptor.config) || {};
  const setKey = componentSetKey(comps, cfg);   // program-cache key bits (link only)
  const configKey = fragConfigKey(comps, cfg);  // heap-dedup only (NOT in program key)

  // getCachedVariant sets userData.__vfxSetKey = setKey BEFORE this builder runs,
  // so the lazily-read _patchSetCacheKey already reflects this SET. We then chain
  // each component's patch in (FAMILY_ORDER, id) order under that one key.
  return materialCache.getCachedVariant(surfaceDid, setKey, configKey, (material) => {
    // Shared prelude FIRST (slice 03's vVfxHash varying) so component injects
    // that read the per-instance hash see it already declared. It carries NO
    // config and rides no link bit — it never affects setKey (firewall intact).
    if (sharedPrelude) installComponentPatch(material, sharedPrelude, undefined, globals);
    for (const comp of comps) {
      installComponentPatch(material, comp, configForComponent(comp, cfg), globals);
    }
  });
}

/** Convenience for the statics sites: resolve by DID via the catalog. Returns
 *  the frag variant or null (caller falls back to base). Pure-routing wrapper. */
export function resolveFragMaterialForDid({ materialCache, surfaceDid, did, globals, installComponentPatch, patchMechs }) {
  if (!visualEnabled()) return null;
  return resolveFragMaterial({
    materialCache,
    surfaceDid,
    descriptor: vfxDescriptorFor(did),
    globals,
    installComponentPatch,
    patchMechs,
  });
}

/**
 * Build (or cache-fetch) the frag-variant material from a frag_attach PLAN's
 * entries — the bridge the P1.14 statics activation seam (kit §7 EDIT C/D/E) and
 * frag_attach.js reference by name. `entries` is Array<{comp, config}>, already
 * FAMILY_ORDER-sorted with per-component config merged (defaults < shared < byId)
 * by frag_attach.fragEntriesForDescriptor.
 *
 * Same FIREWALL as resolveFragMaterial but driven by pre-resolved entries: the
 * program-cache key (setKey) encodes ONLY the ordered component ids + each
 * linkVariant() token — NEVER config scalars / per-instance state. Per-component
 * config rides uniforms + the heap-dedup configKey. Two (surfaceDid) clones with
 * the same SET share ONE compiled program (program count = O(distinct SETs)).
 *
 * `deps` keeps this module THREE-free (mirrors resolveFragMaterial — frag_install
 * imports nothing from the THREE world): the host (statics.js) injects
 * { globals: VFX_GLOBALS, installComponentPatch: installVfxComponentPatch,
 *   sharedPrelude?: the slice-03 vVfxHash prelude }. No installer ⇒ null
 * (fail-soft) ⇒ caller keeps the base material (byte-identical).
 *
 * @param {object} materialCache  MaterialCache (has getCachedVariant)
 * @param {number} surfaceDid
 * @param {Array<{comp:object, config:object}>} entries  frag_attach plan.entries
 * @param {{globals?:object, installComponentPatch?:Function, sharedPrelude?:object}} [deps]
 * @returns {object|null} the cloned variant material, or null
 */
export function buildFragVariant(materialCache, surfaceDid, entries, deps) {
  if (!materialCache || typeof materialCache.getCachedVariant !== "function") return null;
  if (!entries || entries.length === 0) return null;
  const d = deps || {};
  const installComponentPatch = d.installComponentPatch;
  if (typeof installComponentPatch !== "function") {
    if (!_warnedNoInstaller) {
      _warnedNoInstaller = true;
      // eslint-disable-next-line no-console
      console.warn("[vfx] buildFragVariant: no installComponentPatch supplied; frag path inert (base material kept)");
    }
    return null;
  }
  const globals = d.globals;
  const sharedPrelude = d.sharedPrelude;
  // setKey: ordered ids + each linkVariant() token ONLY (the program-cache
  // discriminator). entries are pre-sorted (FAMILY_ORDER, id) by frag_attach, so
  // identical SETs ⇒ identical key regardless of config (all Phase-1 frag comps
  // have linkVariant()==="" — config rides uniforms, never the program).
  const setKey = entries
    .map((e) => {
      let v = "";
      try { v = e.comp && e.comp.linkVariant ? e.comp.linkVariant(e.config) || "" : ""; }
      catch (_) { v = ""; }
      return v ? `${e.comp.id}:${v}` : e.comp.id;
    })
    .join("+");
  // configKey: heap-dedup only (two DIDs same SET + same config ⇒ one clone) —
  // NOT in the program key.
  const configKey = entries.map((e) => e.comp.id + "=" + _stableStr(e.config)).join("&") || "default";
  return materialCache.getCachedVariant(surfaceDid, setKey, configKey, (material) => {
    // Shared prelude FIRST (slice-03 vVfxHash varying) so component injects that
    // read the per-instance hash see it declared; it rides no link bit (setKey
    // intact). Then each entry in FAMILY_ORDER under the one __vfxSetKey.
    if (sharedPrelude) installComponentPatch(material, sharedPrelude, undefined, globals);
    for (const e of entries) installComponentPatch(material, e.comp, e.config, globals);
  });
}

/** Test-only: reset the one-shot warn latch. */
export function _resetFragInstall() { _warnedNoInstaller = false; }
