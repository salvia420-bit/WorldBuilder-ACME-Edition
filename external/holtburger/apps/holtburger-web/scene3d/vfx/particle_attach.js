// VFX particle-effect attach — descriptor → particle "plan" + the attach driver
// (Visual-Behavior Suite, Phase 3 / P3.1, 2026-06-24). The MECH:"particle"
// sibling of frag_attach.js.
//
// Split of responsibility (mirrors the frag seam, scene3d/vfx/frag_attach.js):
//   • THIS module (descriptor level): given a DID, read its catalog descriptor
//     (vfx_catalog.vfxDescriptorFor) → select the descriptor's REGISTERED
//     mech:"particle" components → merge the descriptor's config{} onto each
//     component's defaults → return a deterministic, FAMILY_ORDER-sorted "plan"
//     ({ entries, ids }). Pure + THREE-free: reads only the offline-baked
//     descriptor + the live registry + the per-effect flag router; never a
//     server/wire/replicated field.
//   • particle_attach.attachParticleEmitters (THIS module, attach level): for
//     each peeled placement, build a PURE emit-ctx, call comp.emit(ctx) → a plan
//     of synthesized emitterInfo POJO specs, and turn each spec into a
//     ParticleManager.addEmitter(...) call routed through the owner registry so
//     LB-eviction / entity-despawn teardown is FREE. The THREE-touching pieces
//     (the ParticleManager instance + the per-placement parent anchor) are
//     INJECTED by the host seam (statics / entities, wired by P3.4 / agent 07),
//     exactly like frag_install gets installComponentPatch from its host — so
//     this module stays THREE-free at module-eval and unit-testable under plain
//     node.
//   • statics.js / entities.js (the wiring, P3.4): peel particle placements next
//     to the windBend peel (descriptorMechs(d).has("particle")) and call
//     attachParticleEmitters next to attachWindTrees, owner "static:<lb>" for
//     statics and the entity guid for entities.
//
// Off / no descriptor / no registered particle component / effect-flag OFF ⇒
// particlePlanForDid returns null ⇒ the seam attaches NO emitter ⇒ byte-identical
// frozen render (particles are the FIRST effect that adds draw calls, so the
// default-OFF gate here is intentionally airtight — see particleEntriesForDescriptor).
//
// THE FIREWALL (spec §1.2, design §8): a particle component READS only
// static/derived inputs (DAT geometry/bbox, weenie props, server pose/part-frames,
// a deterministic hash01) + the client wall-clock + derived weather/season, and
// WRITES only the synthesized client-local additive billboard emitter ("emitter"
// cap) — NEVER the wire value, physics/collision, replicated state, or light
// COUNT. emit() is a PURE planner (POJO in, POJO specs out): it never touches the
// live scene graph or reads parent.partFrames; runtime anchoring (the
// WORLD→scene-local part-frame conversion) is done by
// particle_emitter._resolveAnchorFrame at tick time — components MUST NOT
// pre-rotate/convert frames (see task01 contract §3). Deterministic variety rides
// hash01 + clock, NEVER Math.random.
//
// Import-cycle-safe: at module-eval imports ONLY THREE-free modules —
// vfx_catalog.js (imports nothing from the scene graph), registry.js (the
// component contract), vfx_flags.js (the per-effect gate router), and
// particles/owner_registry.js (plain Maps, no THREE). The ParticleManager runtime
// + per-placement THREE anchors are supplied by the host seam at call time, so
// this module + its test stand alone under node.

import { vfxDescriptorFor } from "../vfx_catalog.js";
import { getComponent, FAMILY_ORDER } from "./registry.js";
import { vfxEffectEnabled } from "../vfx_flags.js";
import { ownerRegistry as defaultOwnerRegistry } from "../particles/owner_registry.js";

/** The registry mech this attach path owns (registry.js MECHS includes it). */
export const PARTICLE_MECH = "particle";

// ---------------------------------------------------------------------------
// Plan selection (pure, THREE-free) — mirrors frag_attach.fragEntriesForDescriptor.
// ---------------------------------------------------------------------------

// The chain-composition order (spec §2.3): particle composes LAST
// (FAMILY_ORDER.particle = 9). A particle plan is sorted by (FAMILY_ORDER, id) so
// the emit order is deterministic across components (e.g. brazier embers before
// smoke if their ids order that way). Pure. Mirrors frag_attach._orderKey.
function _orderKey(comp) {
  const fam = FAMILY_ORDER[comp.family];
  return (fam == null ? 99 : fam) * 1000 + 0; // family-major; id breaks ties (string compare)
}

// Split a descriptor's flat config{} into per-component override buckets + a
// shared scalar bucket. Precedence (low→high): comp.defaults < shared < byId[id].
// Byte-for-byte the frag_attach._splitConfig idiom (replicated, not imported, so
// this module is self-contained and node-testable in isolation — the "mirror
// frag_attach" instruction). Pure.
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
 * Merge a descriptor's config onto one particle component's defaults (pure).
 * @param {object} comp  a registered particle VisualComponent (`.defaults`, `.id`)
 * @param {{shared:object, byId:object}} split  from _splitConfig
 * @returns {object} the per-component config handed to emit(ctx) as ctx.config.
 */
export function mergeComponentConfig(comp, split) {
  return { ...(comp.defaults || {}), ...split.shared, ...(split.byId[comp.id] || {}) };
}

/**
 * Is this particle component's effect live? The default-OFF gate. Hardened vs
 * frag_attach (which admits a component lacking an `enabled` fn): because
 * particles are the FIRST effect that adds draw calls, an un-flagged particle
 * component must NEVER render. So:
 *   • if the component defines `enabled` (the tipFlex idiom), trust it;
 *   • otherwise fall back to the canonical per-effect router vfxEffectEnabled(id)
 *     — which is OFF unless ?visual AND the component's per-effect flag (or
 *     ?visual=all) are on. An id with no registered flag therefore stays OFF
 *     until P3.3+/agent-03 wires `?gemSparkle` into vfx_flags.VFX_EFFECT_FLAGS.
 * Pure (reads only URL flags via the flag readers). Master-OFF ⇒ always false.
 * @param {object} comp
 * @returns {boolean}
 */
function _particleEffectEnabled(comp) {
  if (typeof comp.enabled === "function") {
    try { return !!comp.enabled(); } catch (_) { return false; }
  }
  try { return !!vfxEffectEnabled(comp.id); } catch (_) { return false; }
}

/**
 * The registered PARTICLE components a DID's descriptor carries, as FAMILY_ORDER-
 * sorted {comp, config} entries. Selection rules (all fail-soft → []):
 *   • the component id must resolve in the live registry (getComponent), AND
 *   • its registered mech must be "particle" (the registry is authoritative — the
 *     catalog's COMPONENT_MECH is only the offline router), AND
 *   • the default-OFF effect gate (_particleEffectEnabled) must be live.
 * @param {object|null} descriptor  vfxDescriptorFor(did) result
 * @returns {Array<{comp:object, config:object}>}  sorted; [] when none
 */
export function particleEntriesForDescriptor(descriptor) {
  const ids = descriptor && descriptor.componentIds;
  if (!ids || typeof ids.forEach !== "function") return [];
  const split = _splitConfig(descriptor.config);
  const out = [];
  ids.forEach((id) => {
    const comp = getComponent(id);
    if (!comp || comp.mech !== PARTICLE_MECH) return; // not a particle comp (frag/A/B/light) — wrong path
    if (!_particleEffectEnabled(comp)) return;        // default-OFF per-effect gate (airtight)
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
 * The particle "plan" for a DID, or null when there's nothing to attach.
 * Computed ONCE per placement at the attach seam. Does NOT itself read the
 * ?visual master flag — the seam gates with visualEnabled() (mirroring the
 * windBend peel idiom `visualEnabled() && hasWindBend(...)`), and an un-ensured
 * catalog is empty so this returns null anyway. The per-effect gate IS applied
 * here (via particleEntriesForDescriptor) so an OFF effect yields null → no emitter.
 * @param {number} did  the object/SetupModel DID (placement.modelId)
 * @returns {{entries:Array<{comp,config}>, ids:string[]}|null}
 */
export function particlePlanForDid(did) {
  const entries = particleEntriesForDescriptor(vfxDescriptorFor(did));
  if (entries.length === 0) return null;
  return { entries, ids: entries.map((e) => e.comp.id) };
}

/** True if a DID's descriptor carries ≥1 LIVE registered particle component
 *  (diagnostics parity with vfx_catalog.hasWindBend; e.g. for the gauge/stats and
 *  for the statics/entities divert check). Honors the default-OFF gate. */
export function isParticleDid(did) {
  return particleEntriesForDescriptor(vfxDescriptorFor(did)).length > 0;
}

// ---------------------------------------------------------------------------
// Deterministic per-placement seed (THREE-free) — mirrors wind_rig.hash01 (FNV-1a)
// so a placement's particle phase matches its wind/other-effect phase. NO
// Math.random / no Date.now.
// ---------------------------------------------------------------------------

/** FNV-1a over a string → uint32 (same constants as wind_rig.hash01). Pure. */
function _fnv32(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** A stable per-placement key for the deterministic seed. Prefers an explicit
 *  placementKey, else composes did + landblock + local coords (rounded to the mm
 *  so float wobble can't reseed). Pure. */
function _defaultSeedKey(p, did) {
  if (p && (typeof p.placementKey === "string" || typeof p.placementKey === "number")) {
    return `${did}:${p.placementKey}`;
  }
  const lb = ((p && (p.landblockId ?? p.objCellId)) >>> 0) || 0;
  const rx = Math.round((+(p && p.x) || 0) * 1000);
  const ry = Math.round((+(p && p.y) || 0) * 1000);
  const rz = Math.round((+(p && p.z) || 0) * 1000);
  return `${did}:${lb.toString(16)}:${rx}:${ry}:${rz}`;
}

/** The static owner key for a landblock (task01 contract §4.1 — Phase-3 statics
 *  register under "static:<lb>" so ONE destroyAllForOwner reaps the whole LB).
 *  THE single source of truth for the static owner key (D7): the attach seam AND
 *  the LRU teardown BOTH call this so the strings can never drift. Accepts either
 *  a full 32-bit landblockId (0xXXYY####) or an already-masked lb-key
 *  (0xXXYY0000 == lbSetKey == (lbX<<24)|(lbY<<16)); both normalize to the same
 *  decimal of (landblockId & 0xffff0000), matching statics.js `lbSetKey` and the
 *  `_evictStaticParticlesForLb(lbKey & 0xffff0000)` teardown char-for-char. */
export function staticOwnerKeyForLb(landblockId) {
  return `static:${((landblockId >>> 0) & 0xffff0000) >>> 0}`;
}

// ---------------------------------------------------------------------------
// The attach driver. THREE-touching deps (manager + parent) are INJECTED.
// ---------------------------------------------------------------------------

let _warnedNoManager = false;

/** Normalize comp.emit(ctx)'s return into a flat array of specs (accepts a single
 *  spec object, an array, or null/undefined). Drops non-objects. Pure. */
function _normalizeSpecs(ret) {
  if (!ret) return [];
  const arr = Array.isArray(ret) ? ret : [ret];
  return arr.filter((s) => s && typeof s === "object" && s.emitterInfo);
}

/**
 * Attach synthesized particle emitters for a set of peeled placements.
 *
 * For each placement it: resolves the particle plan, builds a PURE emit-ctx (the
 * task01/agent02 ctx shape), calls each component's emit(ctx) → emitter specs,
 * and routes every spec through `ParticleManager.addEmitter` (via the owner
 * registry) parented to the placement's anchor, registering the returned id under
 * the owner key so LB-eviction / entity-despawn teardown is a single
 * `ownerRegistry.destroyAllForOwner(ownerKey)` call (wired by P3.4 / agent 07).
 *
 * Fail-soft everywhere (mirrors attachStaticDefaultScripts / attachWindTrees): a
 * missing manager, a null parent, an emit() throw, a 0-id (hwGfxObjId:0) — each is
 * logged/skipped, never thrown. Off / empty plan ⇒ zero emitters ⇒ byte-identical.
 *
 * @param {object} scene3d
 * @param {Array<object>} placements  the peeled particle placements (statics) or
 *        a single-element list for an entity spawn.
 * @param {object} wasmExports
 * @param {(placement:object, index:number)=>(number|string)} ownerKeyFn  REQUIRED:
 *        the owner key per placement — entity guid (number) or "static:<lb>"
 *        (string, e.g. staticOwnerKeyForLb(p.landblockId)).
 * @param {object} [opts]
 * @param {object}   [opts.manager]        a prebuilt ParticleManager (statics:
 *        scene3d._staticParticleManager; entities: _worldParticleManager).
 * @param {(scene3d:object, wasmExports:object)=>Promise<object|null>} [opts.ensureManager]
 *        async manager resolver if `manager` is not passed (the statics seam
 *        injects _ensureStaticParticleManager). One of manager|ensureManager is
 *        REQUIRED — without either this no-ops (fail-soft), like frag_install's
 *        missing-installer → null.
 * @param {(placement:object, index:number)=>(object|null)} [opts.buildParent]
 *        REQUIRED: build the per-placement THREE anchor
 *        ({position, quaternion, partFrames?}) — statics build a THREE.Group at the
 *        world transform (mirror attachStaticDefaultScripts); entities pass
 *        `() => inst.root`. Returning null skips the placement.
 * @param {(placement:object)=>number} [opts.didFor]  default: (modelId>>>0)||0.
 * @param {(placement:object, index:number)=>{numParts:number, partBoxes:object[], rig:(object|null)}} [opts.geometryFor]
 *        per-placement geometry for the emit-ctx anchor-part pick (P3.6). Default:
 *        root-only `{numParts:1, partBoxes:[], rig:null}` — exactly what the
 *        gemSparkle minimal slice (partIndex -1) needs.
 * @param {(placement:object, index:number)=>string} [opts.seedFor]  stable seed
 *        key override; default _defaultSeedKey (did+lb+coords).
 * @param {()=>number} [opts.clockNow]  attach-time wall clock (ctx.tSec, phase
 *        seed only); default () => scene3d?.frameTime?.tsSec ?? 0.
 * @param {(placement:object)=>(object|null)} [opts.weatherFor]  derived season/
 *        time/region gate object for foliage/breath (P3.7); default null.
 * @param {object}  [opts.ownerRegistry]  the owner registry (test injects a fake);
 *        default the shared singleton.
 * @param {boolean} [opts.useOwnerRegistry]  route creates through the owner
 *        registry. DEFAULT true — synthesized persistent (totalSeconds:0) emitters
 *        MUST be owner-scoped or they leak; the registry works regardless of the
 *        ?particleOwner flag (that flag only governs the LEGACY DAT paths), so
 *        agent 07 must call destroyAllForOwner unconditionally on teardown. Set
 *        false only for a bare-manager diagnostic.
 * @returns {Promise<{placementCount:number, emitterCount:number, ids:number[]}>}
 */
/**
 * P3.7 — resolve a part-anchor from the component config's anchor ROLE
 * (canopy/head/…) against the per-part bboxes (wind_rig.partBBox shape:
 * {minX..maxZ, cx,cy,cz}). Foliage/breath read ctx.anchor for partIndex + a
 * spawn-volume centre/radius. role "root" (or no partBoxes) ⇒ root anchor (-1).
 * Pure (no THREE). A future `vfx anchor-parts` bake can replace the heuristic
 * (topmost-centroid-Z part) with an authored per-DID partIndex.
 */
function _resolveAnchor(config, partBoxes) {
  const role = (config && config.anchor) || "root";
  if (role !== "root" && Array.isArray(partBoxes) && partBoxes.length > 0) {
    let bi = 0, bestZ = -Infinity;
    for (let k = 0; k < partBoxes.length; k += 1) {
      const b = partBoxes[k];
      if (!b) continue;
      const cz = Number.isFinite(b.cz) ? b.cz : 0;
      if (cz > bestZ) { bestZ = cz; bi = k; }
    }
    const b = partBoxes[bi];
    if (b) {
      const radius = Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ) * 0.5;
      return {
        partIndex: bi,
        center: { x: b.cx || 0, y: b.cy || 0, z: b.cz || 0 },
        radius: radius > 0 ? radius : 1,
      };
    }
  }
  const r = config && Number.isFinite(+config.maxOffset) ? +config.maxOffset : 1;
  return { partIndex: -1, center: { x: 0, y: 0, z: 0 }, radius: r };
}

export async function attachParticleEmitters(scene3d, placements, wasmExports, ownerKeyFn, opts = {}) {
  const RESULT = { placementCount: 0, emitterCount: 0, ids: [] };
  if (!scene3d || !Array.isArray(placements) || placements.length === 0) return RESULT;
  if (typeof opts.buildParent !== "function") {
    // No way to anchor an emitter — fail-soft (host seam must supply buildParent).
    if (!_warnedNoManager) {
      _warnedNoManager = true;
      // eslint-disable-next-line no-console
      console.warn("[vfx] attachParticleEmitters: no opts.buildParent supplied; particle path inert (no emitters)");
    }
    return RESULT;
  }

  // Resolve the ParticleManager ONCE (mirror attachStaticDefaultScripts) — a
  // prebuilt instance or the injected async resolver.
  let manager = opts.manager || null;
  if (!manager && typeof opts.ensureManager === "function") {
    try { manager = await opts.ensureManager(scene3d, wasmExports); } catch (_) { manager = null; }
  }
  if (!manager || typeof manager.addEmitter !== "function") {
    if (!_warnedNoManager) {
      _warnedNoManager = true;
      // eslint-disable-next-line no-console
      console.warn("[vfx] attachParticleEmitters: no ParticleManager (manager/ensureManager); particle path inert");
    }
    return RESULT;
  }

  const reg = opts.ownerRegistry || defaultOwnerRegistry;
  const useReg = opts.useOwnerRegistry !== false; // default ON (never leak persistent emitters)
  const didFor = typeof opts.didFor === "function" ? opts.didFor : (p) => (p?.modelId >>> 0) || 0;
  const geometryFor = typeof opts.geometryFor === "function"
    ? opts.geometryFor
    : () => ({ numParts: 1, partBoxes: [], rig: null });
  const seedFor = typeof opts.seedFor === "function" ? opts.seedFor : null;
  const weatherFor = typeof opts.weatherFor === "function" ? opts.weatherFor : () => null;
  const clockNow = typeof opts.clockNow === "function"
    ? opts.clockNow
    : () => (scene3d.frameTime && scene3d.frameTime.tsSec) || 0;
  // P3.7 — the derived day/weather/season snapshot (readParticleEnv), computed ONCE
  // per attach call by the seam and forwarded as ctx.env. null when the seam doesn't
  // supply it (gemSparkle/brazier ignore env; foliage/breath gates fail-soft to calm).
  const env = opts.env || null;

  for (let i = 0; i < placements.length; i += 1) {
    const p = placements[i];
    const did = didFor(p) >>> 0;
    const plan = particlePlanForDid(did);
    if (!plan) continue; // off / no particle component / gated off → byte-identical

    const parent = opts.buildParent(p, i);
    if (!parent) continue; // anchor build failed → skip (fail-soft)

    const ownerKey = ownerKeyFn ? ownerKeyFn(p, i) : staticOwnerKeyForLb((p && p.landblockId) >>> 0);

    // PURE emit-ctx (the agent02 stub shape) — static/derived inputs only.
    const seed = _fnv32(seedFor ? seedFor(p, i) : _defaultSeedKey(p, did));
    const hash01 = seed / 4294967296;
    const tSec = +clockNow() || 0;
    const weather = weatherFor(p);
    let geom;
    try { geom = geometryFor(p, i) || {}; } catch (_) { geom = {}; }
    const numParts = (geom.numParts | 0) || 1;
    const partBoxes = Array.isArray(geom.partBoxes) ? geom.partBoxes : [];
    const rig = geom.rig || null;

    RESULT.placementCount += 1;

    for (const { comp, config } of plan.entries) {
      // D6 — the canonical emit-ctx (agent 15/02 contract): the wall-clock field is
      // `clock`; `tSec` is kept as a back-compat alias so neither the agent-15
      // components (read `clock`) nor the agent-05 install test (asserts `tSec`)
      // diverge. Sprites are intentionally NOT in ctx (components import
      // particle_sprites.js / take config.hwGfxObjId) — keeps ctx DAT-lookup-free.
      // P3.7 — derived env (day/weather/season, for the foliage/breath gates) +
      // resolved anchor (part bbox picked by config.anchor role). gemSparkle/brazier
      // ignore both (they bake partIndex/offset in their own emit); foliage/breath read them.
      const anchor = _resolveAnchor(config, partBoxes);
      const ctx = { did, numParts, partBoxes, rig, hash01, seed, clock: tSec, tSec, weather, env, anchor, config };
      let specs;
      try {
        specs = _normalizeSpecs(comp.emit ? comp.emit(ctx) : null);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[vfx] particle emit() threw for ${comp.id} (did 0x${did.toString(16)}):`, e);
        continue;
      }
      for (const spec of specs) {
        const info = spec.emitterInfo;
        // hwGfxObjId:0 ⇒ addEmitter returns 0 (task01 §1.2 dominant failure); skip
        // early so we don't churn the manager for a guaranteed-0 create.
        if (!info || ((info.hwGfxObjId >>> 0) === 0)) continue;
        const req = {
          emitterInfo: info,
          parent,
          partIndex: Number.isFinite(spec.partIndex) ? spec.partIndex : -1,
          parentOffset: spec.parentOffset || null,
          emitterId: (spec.emitterId >>> 0) || 0, // Phase-3 ambient: anonymous (0)
          blocking: spec.blocking === true,        // Phase-3 ambient: false
        };
        let id = 0;
        try {
          // eslint-disable-next-line no-await-in-loop
          id = useReg
            ? await reg.addEmitter(ownerKey, manager, req)
            : await manager.addEmitter(req);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[vfx] addEmitter failed for ${comp.id} (did 0x${did.toString(16)}):`, e);
          id = 0;
        }
        if ((id >>> 0) !== 0) { RESULT.ids.push(id >>> 0); RESULT.emitterCount += 1; }
      }
    }
  }

  if (RESULT.emitterCount > 0) {
    // eslint-disable-next-line no-console
    console.log(`[vfx] attachParticleEmitters: ${RESULT.emitterCount} emitters across ${RESULT.placementCount} placements`);
  }
  return RESULT;
}

/** Test-only: reset the one-shot warn latch. */
export function _resetParticleAttach() { _warnedNoManager = false; }
