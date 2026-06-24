// VFX Phase 3 / P3.1 — particle install/attach firewall test (authoritative).
//
// Locks the mech:"particle" SELECTION + the attach DRIVER for the first
// draw-call-adding effect family. Mirrors test_vfx_vertex_install.mjs: pure node
// (no THREE, no wasm), fake mech-particle components in the registry, a fake
// ParticleManager + fake owner-registry recording every addEmitter call, and a
// STUB emit() (POJO in, POJO specs out — never touches the scene graph).
//
// COVERS:
//   A. particleEntriesForDescriptor — the LIVE selection: admits ONLY mech
//      "particle"; drops frag/MECH-A/MECH-B/light; applies the default-OFF
//      effect gate (comp.enabled, else vfxEffectEnabled); sorts (FAMILY_ORDER,id).
//   B. particlePlanForDid / isParticleDid via the catalog → {entries,ids} | null.
//   C. attachParticleEmitters — builds the PURE emit-ctx (deterministic hash01 +
//      seed, NO Math.random), calls comp.emit(ctx), routes each spec through the
//      owner registry → manager.addEmitter parented to the injected anchor, keys
//      under "static:<lb>" (statics) vs the entity guid, skips hwGfxObjId:0, and
//      is byte-identical (no emitter) when the master/effect gate is OFF.
//   D. Source firewall — particle_attach.js contains NO Math.random / argless
//      Date.now / .visible= / wire (mirrors lint_caps.FORBIDDEN_SOURCE intent).
//
// Run from $W:  node test_vfx_particle_install.mjs

import { readFileSync } from "node:fs";
import {
  particleEntriesForDescriptor, particlePlanForDid, isParticleDid,
  attachParticleEmitters, staticOwnerKeyForLb, mergeComponentConfig,
  _resetParticleAttach, PARTICLE_MECH,
} from "./scene3d/vfx/particle_attach.js";
import { registerComponent, _clearComponents, FAMILY_ORDER } from "./scene3d/vfx/registry.js";
import { visualEnabled, _resetVfxCatalog, setVfxCatalog } from "./scene3d/vfx_catalog.js";
import { _resetVfxFlags } from "./scene3d/vfx_flags.js";
import { lintSource } from "./scene3d/vfx/lint_caps.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// ---- test-controlled per-effect toggles (compose visualEnabled like the real
// gemSparkleEnabled / flameFlickerEnabled will). -----------------------------
let GEM_ON = true, EMBER_ON = true;

// A captured-ctx sink so we can assert determinism + the emit-ctx shape.
const emitLog = [];

// ---- fake mech-particle components (valid manifests → registerComponent ok) ---
// particle.gemSparkle — emits ONE persistent additive soft-dot spec. emitterInfo
// scalars are seeded from ctx.hash01 (deterministic; NO Math.random).
const pGem = {
  id: "particle.gemSparkle", family: "particle", mech: "particle", channel: "emitter",
  linkVariant() { return ""; }, cacheKeyScope: "none", deterministic: true, lightCountDelta: 0,
  reads: ["geometry", "clock"], writes: ["emitter"], defaults: { sprite: 0x01001234 },
  enabled() { return visualEnabled() && GEM_ON; },
  emit(ctx) {
    emitLog.push({ id: "particle.gemSparkle", ctx });
    return [{
      emitterInfo: {
        id: 0x7f000001, emitterType: 1, particleType: 0,
        hwGfxObjId: (ctx.config && ctx.config.sprite) || 0x01001234,
        birthrate: 0.18 + 0.10 * ctx.hash01, // deterministic variety from the seed
        maxParticles: 4, initialParticles: 2, totalParticles: 0, totalSeconds: 0,
        lifespan: 1.4, lifespanRand: 0.4, maxOffset: 0.12,
        startScale: 0.45, finalScale: 0.08, startTrans: 0.0, finalTrans: 1.0,
      },
      partIndex: -1, parentOffset: null,
    }];
  },
};
// particle.brazierEmbers — emits TWO specs (embers + smoke) anchored to a part.
const pEmber = {
  id: "particle.brazierEmbers", family: "particle", mech: "particle", channel: "emitter",
  linkVariant() { return ""; }, cacheKeyScope: "none", deterministic: true, lightCountDelta: 0,
  reads: ["geometry", "clock"], writes: ["emitter"], defaults: {},
  enabled() { return visualEnabled() && EMBER_ON; },
  emit(ctx) {
    emitLog.push({ id: "particle.brazierEmbers", ctx });
    return [
      { emitterInfo: { hwGfxObjId: 0x01005001, emitterType: 1, birthrate: 0.1, maxParticles: 8 },
        partIndex: 2, parentOffset: { position: { x: 0, y: 0, z: 0.4 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } } },
      { emitterInfo: { hwGfxObjId: 0x01005002, emitterType: 1, birthrate: 0.3, maxParticles: 6 },
        partIndex: 2, parentOffset: null },
    ];
  },
};
// particle.disabled — a registered particle comp whose effect gate is OFF.
const pDisabled = {
  id: "particle.disabled", family: "particle", mech: "particle", channel: "emitter",
  linkVariant() { return ""; }, cacheKeyScope: "none", deterministic: true, lightCountDelta: 0,
  reads: ["geometry"], writes: ["emitter"], defaults: {},
  enabled() { return false; },
  emit() { throw new Error("disabled particle component must never emit"); },
};
// particle.unflagged — NO `enabled` → falls back to vfxEffectEnabled(id), which is
// OFF under plain ?visual (no registered flag) → must be DROPPED (airtight default).
const pUnflagged = {
  id: "particle.unflagged", family: "particle", mech: "particle", channel: "emitter",
  linkVariant() { return ""; }, cacheKeyScope: "none", deterministic: true, lightCountDelta: 0,
  reads: ["geometry"], writes: ["emitter"], defaults: {},
  emit() { return [{ emitterInfo: { hwGfxObjId: 0x09990999 }, partIndex: -1 }]; },
};
// particle.zeroSprite — emits a spec with hwGfxObjId:0 (the dominant failure) →
// attach must SKIP it (no addEmitter churn, no counted emitter).
const pZero = {
  id: "particle.zeroSprite", family: "particle", mech: "particle", channel: "emitter",
  linkVariant() { return ""; }, cacheKeyScope: "none", deterministic: true, lightCountDelta: 0,
  reads: ["geometry"], writes: ["emitter"], defaults: {},
  enabled() { return visualEnabled(); },
  emit() { return [{ emitterInfo: { hwGfxObjId: 0 }, partIndex: -1 }]; },
};
// NON-particle mechs — must be filtered out by particleEntriesForDescriptor.
const fGlint = {
  id: "emissive.glint", family: "emissive", mech: "frag", channel: "glint",
  linkVariant() { return ""; }, cacheKeyScope: "set", deterministic: true, lightCountDelta: 0,
  reads: ["surface"], writes: ["materialUniform"], defaults: {},
};
const aWind = {
  id: "deformation.windBend", family: "deformation", mech: "A", channel: "transform",
  linkVariant() { return ""; }, cacheKeyScope: "none", deterministic: true, lightCountDelta: 0,
  reads: ["geometry"], writes: ["partTransform"], defaults: {},
};
const lFlame = {
  id: "light.flameFlicker", family: "emissive", mech: "light", channel: "light",
  linkVariant() { return ""; }, cacheKeyScope: "none", deterministic: true, lightCountDelta: 0,
  reads: ["clock"], writes: ["lightIntensity"], defaults: {},
};

_clearComponents();
[pGem, pEmber, pDisabled, pUnflagged, pZero, fGlint, aWind, lFlame].forEach(registerComponent);

function desc(ids, config) { return { componentIds: new Set(ids), config: config || {} }; }

// ---- fake ParticleManager + owner registry (record every call) ---------------
function makeFakeManager() {
  let nextId = 100;
  const calls = [];
  return {
    calls,
    async addEmitter(req) { calls.push(req); return ++nextId; },
    destroyParticleEmitter() {},
  };
}
function makeFakeOwnerRegistry(manager) {
  const calls = [];
  return {
    calls,
    // Mirror the real facade: ALWAYS emitterId:0 + blocking:false to the manager.
    async addEmitter(ownerKey, mgr, req) {
      calls.push({ ownerKey, req });
      return mgr.addEmitter({ ...req, emitterId: 0, blocking: false });
    },
    destroyAllForOwner() { return 0; },
  };
}
function fakeParent(p, i) { return { __isParent: true, name: `parent:${i}`, position: {}, quaternion: {} }; }

// ---- catalog + visual flag plumbing -----------------------------------------
const GEM_DID = 0x02009001;     // a "magic gem" SetupModel carrying [gemSparkle, glint, windBend]
const BRAZIER_DID = 0x0200a002; // a brazier carrying [brazierEmbers]
const PLAIN_DID = 0x0200b003;   // no particle component
function installCatalog() {
  const m = new Map();
  m.set(GEM_DID, desc(["particle.gemSparkle", "emissive.glint", "deformation.windBend"], { sprite: 0x0100abcd }));
  m.set(BRAZIER_DID, desc(["particle.brazierEmbers"]));
  m.set(PLAIN_DID, desc(["emissive.glint"]));
  setVfxCatalog(m);
}
function reset() { _resetVfxCatalog(); _resetVfxFlags(); _resetParticleAttach(); }
function visualOn() { globalThis.window = { location: { search: "?visual=on" } }; reset(); installCatalog(); }
function visualAll() { globalThis.window = { location: { search: "?visual=all" } }; reset(); installCatalog(); }
function visualOff() { delete globalThis.window; reset(); installCatalog(); }

// ============================================================================
// SECTION A — particleEntriesForDescriptor: mech filtering + gate + ordering.
// ============================================================================
visualOn();
const eGem = particleEntriesForDescriptor(desc(["particle.gemSparkle", "emissive.glint", "deformation.windBend", "light.flameFlicker"]));
check("[A] admits mech-particle gemSparkle", eGem.some((e) => e.comp.id === "particle.gemSparkle"), eGem.map((e) => e.comp.id).join());
check("[A] DROPS frag (emissive.glint)", !eGem.some((e) => e.comp.id === "emissive.glint"));
check("[A] DROPS MECH-A (deformation.windBend)", !eGem.some((e) => e.comp.id === "deformation.windBend"));
check("[A] DROPS light (light.flameFlicker)", !eGem.some((e) => e.comp.id === "light.flameFlicker"));
check("[A] result is exactly [gemSparkle]", eGem.length === 1, eGem.map((e) => e.comp.id).join());
check("[A] PARTICLE_MECH constant is 'particle'", PARTICLE_MECH === "particle");
check("[A] FAMILY_ORDER.particle = 9 (composes LAST)", FAMILY_ORDER.particle === 9, String(FAMILY_ORDER.particle));

// ordering: two particle comps sort by (FAMILY_ORDER, id) → brazierEmbers < gemSparkle.
const eOrder = particleEntriesForDescriptor(desc(["particle.gemSparkle", "particle.brazierEmbers"]));
check("[A] two particle comps sort by id (brazierEmbers before gemSparkle)",
  eOrder.map((e) => e.comp.id).join() === "particle.brazierEmbers,particle.gemSparkle", eOrder.map((e) => e.comp.id).join());

// default-OFF gate: comp.enabled()===false drops it.
const eDis = particleEntriesForDescriptor(desc(["particle.gemSparkle", "particle.disabled"]));
check("[A] effect gate drops a disabled particle comp (enabled()→false)",
  eDis.length === 1 && eDis[0].comp.id === "particle.gemSparkle", eDis.map((e) => e.comp.id).join());

// airtight default: a particle comp with NO `enabled` + plain ?visual → dropped
// (vfxEffectEnabled fallback is OFF until a per-effect flag is wired).
const eUnflagged = particleEntriesForDescriptor(desc(["particle.unflagged"]));
check("[A] unflagged particle comp DROPPED under plain ?visual (airtight default-OFF)",
  eUnflagged.length === 0, eUnflagged.map((e) => e.comp.id).join());

// config merge precedence (defaults < shared < byId).
const merged = mergeComponentConfig(pGem, { shared: { sprite: 7 }, byId: { "particle.gemSparkle": { sprite: 9 } } });
check("[A] mergeComponentConfig precedence byId > shared > defaults", merged.sprite === 9, String(merged.sprite));

// master gate OFF → enabled() composes visualEnabled() → empty (byte-identical).
visualOff();
check("[A] master ?visual OFF → no entries (byte-identical)",
  particleEntriesForDescriptor(desc(["particle.gemSparkle"])).length === 0);
check("[A] visualEnabled() is false while off", visualEnabled() === false);

// ?visual=all lights the unflagged comp (the 1070 'light everything' switch).
visualAll();
check("[A] ?visual=all admits the unflagged particle comp (vfxEffectEnabled fallback)",
  particleEntriesForDescriptor(desc(["particle.unflagged"])).length === 1);

// ============================================================================
// SECTION B — particlePlanForDid / isParticleDid via the catalog.
// ============================================================================
visualOn();
const planGem = particlePlanForDid(GEM_DID);
check("[B] particlePlanForDid(gem) → plan with [gemSparkle] (glint+windBend filtered)",
  !!planGem && planGem.ids.join() === "particle.gemSparkle", planGem && planGem.ids.join());
check("[B] plan.entries[0].config carries the descriptor sprite override",
  planGem.entries[0].config.sprite === 0x0100abcd, String(planGem.entries[0].config.sprite));
check("[B] particlePlanForDid(plain, no particle comp) → null", particlePlanForDid(PLAIN_DID) === null);
check("[B] particlePlanForDid(unknown DID) → null", particlePlanForDid(0xdeadbeef) === null);
check("[B] isParticleDid(gem) true", isParticleDid(GEM_DID) === true);
check("[B] isParticleDid(plain) false", isParticleDid(PLAIN_DID) === false);
visualOff();
check("[B] isParticleDid(gem) false while ?visual OFF (gated)", isParticleDid(GEM_DID) === false);

// ============================================================================
// SECTION C — attachParticleEmitters: STUB emit → fake addEmitter, owner-keyed.
// ============================================================================
visualOn();
emitLog.length = 0;
const mgr = makeFakeManager();
const reg = makeFakeOwnerRegistry(mgr);
const staticPlacements = [{ modelId: GEM_DID, landblockId: 0xab940000 | 0x0001, x: 12.5, y: 34.5, z: 1.0 }];
const scene3d = { frameTime: { tsSec: 0 } };
// null scene3d short-circuits to a zero result (fail-soft guard).
check("[C] null scene3d → inert (fail-soft guard)",
  (await attachParticleEmitters(null, staticPlacements, {}, () => "static:0x0", { manager: mgr, buildParent: fakeParent, ownerRegistry: reg })).emitterCount === 0);
const r1 = await attachParticleEmitters(scene3d, staticPlacements, {}, (p) => staticOwnerKeyForLb(p.landblockId), {
  manager: mgr, buildParent: fakeParent, ownerRegistry: reg, clockNow: () => 0,
});
check("[C] one gem placement → exactly 1 emitter attached (gemSparkle)", r1.emitterCount === 1, JSON.stringify(r1));
check("[C] returned ids match emitterCount", r1.ids.length === 1 && (r1.ids[0] >>> 0) === r1.ids[0]);
check("[C] manager.addEmitter called once", mgr.calls.length === 1, String(mgr.calls.length));
check("[C] req.parent is the injected anchor (buildParent result)", mgr.calls[0].parent.__isParent === true);
check("[C] req.partIndex === -1 (gemSparkle root anchor)", mgr.calls[0].partIndex === -1, String(mgr.calls[0].partIndex));
check("[C] req.emitterId === 0 (anonymous; facade allocates)", mgr.calls[0].emitterId === 0);
check("[C] req.blocking === false (ambient persistent)", mgr.calls[0].blocking === false);
check("[C] emitterInfo.hwGfxObjId resolved from descriptor sprite override",
  (mgr.calls[0].emitterInfo.hwGfxObjId >>> 0) === 0x0100abcd, "0x" + mgr.calls[0].emitterInfo.hwGfxObjId.toString(16));
check("[C] owner key is 'static:<lb>' (high-16 landblock)",
  reg.calls[0].ownerKey === staticOwnerKeyForLb(0xab940000 | 0x0001), reg.calls[0].ownerKey);
check("[C] owner registry was used (not bare manager)", reg.calls.length === 1);

// emit-ctx shape + DETERMINISM: hash01 ∈ [0,1), stable across re-attach.
const ctx1 = emitLog[emitLog.length - 1].ctx;
check("[C] emit ctx.hash01 ∈ [0,1)", ctx1.hash01 >= 0 && ctx1.hash01 < 1, String(ctx1.hash01));
check("[C] emit ctx carries did/numParts/seed/tSec/config (agent02 shape)",
  ctx1.did === (GEM_DID >>> 0) && ctx1.numParts === 1 && Number.isFinite(ctx1.seed) &&
  ctx1.tSec === 0 && ctx1.config && ctx1.config.sprite === 0x0100abcd);
const birth1 = mgr.calls[0].emitterInfo.birthrate;
const mgr2 = makeFakeManager(); const reg2 = makeFakeOwnerRegistry(mgr2);
const r2 = await attachParticleEmitters(scene3d, staticPlacements, {}, (p) => staticOwnerKeyForLb(p.landblockId), {
  manager: mgr2, buildParent: fakeParent, ownerRegistry: reg2, clockNow: () => 0,
});
check("[C] DETERMINISTIC: same placement → identical seed/hash01 (no Math.random)",
  emitLog[emitLog.length - 1].ctx.seed === ctx1.seed && mgr2.calls[0].emitterInfo.birthrate === birth1);

// brazier: TWO specs from one component → 2 emitters, part-anchored.
emitLog.length = 0;
const mgrB = makeFakeManager(); const regB = makeFakeOwnerRegistry(mgrB);
const rB = await attachParticleEmitters(scene3d, [{ modelId: BRAZIER_DID, landblockId: 0xab940002, x: 1, y: 2, z: 3 }], {},
  (p) => staticOwnerKeyForLb(p.landblockId), { manager: mgrB, buildParent: fakeParent, ownerRegistry: regB });
check("[C] brazierEmbers emits 2 specs → 2 emitters", rB.emitterCount === 2, JSON.stringify(rB));
check("[C] both brazier specs anchored to partIndex 2 (part-frame anchor)",
  mgrB.calls.length === 2 && mgrB.calls[0].partIndex === 2 && mgrB.calls[1].partIndex === 2);
check("[C] spec parentOffset threaded through to the req",
  mgrB.calls[0].parentOffset && mgrB.calls[0].parentOffset.position.z === 0.4 && mgrB.calls[1].parentOffset === null);

// entity owner-keying: ownerKeyFn returns the guid NUMBER.
const mgrE = makeFakeManager(); const regE = makeFakeOwnerRegistry(mgrE);
const GUID = 0x50001234;
const rE = await attachParticleEmitters(scene3d, [{ modelId: GEM_DID, guid: GUID }], {},
  (p) => p.guid >>> 0, { manager: mgrE, buildParent: () => ({ __isParent: true, position: {}, quaternion: {} }), ownerRegistry: regE });
check("[C] entity seam: owner key is the guid number", rE.emitterCount === 1 && regE.calls[0].ownerKey === (GUID >>> 0), String(regE.calls[0]?.ownerKey));

// hwGfxObjId:0 spec is SKIPPED (no addEmitter, no counted emitter).
const mgrZ = makeFakeManager(); const regZ = makeFakeOwnerRegistry(mgrZ);
const catZ = new Map(); catZ.set(0x0200c00c, desc(["particle.zeroSprite"])); setVfxCatalog(catZ);
const rZ = await attachParticleEmitters(scene3d, [{ modelId: 0x0200c00c, landblockId: 0xab940003 }], {},
  (p) => staticOwnerKeyForLb(p.landblockId), { manager: mgrZ, buildParent: fakeParent, ownerRegistry: regZ });
check("[C] hwGfxObjId:0 spec is skipped (no emitter, no addEmitter churn)",
  rZ.emitterCount === 0 && mgrZ.calls.length === 0, JSON.stringify(rZ));
installCatalog();

// useOwnerRegistry:false → bare manager path (no facade).
const mgrR = makeFakeManager(); const regR = makeFakeOwnerRegistry(mgrR);
const rR = await attachParticleEmitters(scene3d, staticPlacements, {}, (p) => staticOwnerKeyForLb(p.landblockId),
  { manager: mgrR, buildParent: fakeParent, ownerRegistry: regR, useOwnerRegistry: false });
check("[C] useOwnerRegistry:false routes the bare manager (regCalls empty, manager called)",
  rR.emitterCount === 1 && regR.calls.length === 0 && mgrR.calls.length === 1);

// no manager / no buildParent → fail-soft inert (byte-identical).
const rNoMgr = await attachParticleEmitters(scene3d, staticPlacements, {}, (p) => staticOwnerKeyForLb(p.landblockId),
  { buildParent: fakeParent });
check("[C] no manager/ensureManager → inert (0 emitters, fail-soft)", rNoMgr.emitterCount === 0);
_resetParticleAttach();
const rNoParent = await attachParticleEmitters(scene3d, staticPlacements, {}, (p) => staticOwnerKeyForLb(p.landblockId),
  { manager: makeFakeManager() });
check("[C] no buildParent → inert (0 emitters, fail-soft)", rNoParent.emitterCount === 0);

// ensureManager (async resolver) path.
_resetParticleAttach();
const mgrA = makeFakeManager(); const regA = makeFakeOwnerRegistry(mgrA);
const rEns = await attachParticleEmitters(scene3d, staticPlacements, {}, (p) => staticOwnerKeyForLb(p.landblockId),
  { ensureManager: async () => mgrA, buildParent: fakeParent, ownerRegistry: regA });
check("[C] ensureManager async resolver path attaches", rEns.emitterCount === 1 && mgrA.calls.length === 1);

// OFF → no emitters (byte-identical): the whole point.
visualOff();
const mgrOff = makeFakeManager(); const regOff = makeFakeOwnerRegistry(mgrOff);
const rOff = await attachParticleEmitters(scene3d, staticPlacements, {}, (p) => staticOwnerKeyForLb(p.landblockId),
  { manager: mgrOff, buildParent: fakeParent, ownerRegistry: regOff });
check("[C] ?visual OFF → attach is a no-op (0 emitters, byte-identical)",
  rOff.emitterCount === 0 && mgrOff.calls.length === 0);

// staticOwnerKeyForLb derives the masked-high-16 landblock as a DECIMAL string
// (D7 single-source key — char-for-char identical to statics.js lbSetKey + the
// landblock_lru `_evictStaticParticlesForLb(lbKey & 0xffff0000)` teardown).
check("[C] staticOwnerKeyForLb === 'static:<(lb & 0xffff0000) decimal>' (D7 single-source key)",
  staticOwnerKeyForLb(0xab940001) === `static:${(0xab940001 & 0xffff0000) >>> 0}`, staticOwnerKeyForLb(0xab940001));
// idempotent on an already-masked lb-key (the per-LB attach passes lbKey directly).
check("[C] staticOwnerKeyForLb is mask-idempotent (attach key === teardown key)",
  staticOwnerKeyForLb(0xab940000) === staticOwnerKeyForLb(0xab94abcd));

// ============================================================================
// SECTION D — source firewall: run the REAL lint_caps.lintSource denylist over
// particle_attach.js (comment-stripped, call-form regexes), exactly as the
// legacy-safety audit scans component source. NOT a hand-rolled regex.
// ============================================================================
const src = readFileSync(new URL("./scene3d/vfx/particle_attach.js", import.meta.url), "utf8");
const hits = lintSource(src);
check("[D] particle_attach.js passes lint_caps.lintSource (no Math.random( / Date.now() / .visible= / wire / collision)",
  hits.length === 0, hits.map((h) => `${h.lineno}:${h.label}`).join(" | "));
check("[D] particle_attach.js imports nothing from the THREE graph at module-eval",
  !/^import[\s\S]*?from\s+["']three["']/m.test(src) && !/from\s+["']three["']/.test(src));

console.log(`\nVFX particle-install (P3.1, attach firewall): ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
