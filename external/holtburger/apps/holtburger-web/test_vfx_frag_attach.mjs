// VFX Phase 1 / slice 13 — descriptor → frag-attach plan threading test.
//
// Locks: the descriptor's componentIds + config{} resolve to a FAMILY_ORDER-
// sorted plan of REGISTERED FRAG components with per-component merged config
// (defaults < shared < per-id); MECH-A (windBend) is filtered out; a DID
// carrying BOTH windBend + a frag comp yields a frag-only plan (coexistence);
// off / unknown / non-frag ⇒ null (the seam keeps the frozen material); and the
// statics-seam swap predicate (mirrors statics.js) is byte-identical when off.

import {
  fragPlanForDid, fragEntriesForDescriptor, mergeComponentConfig, isFragDid,
} from "./scene3d/vfx/frag_attach.js";
import { registerComponent, _clearComponents } from "./scene3d/vfx/registry.js";
import {
  parseDescriptorsJsonl, setVfxCatalog, _resetVfxCatalog, vfxDescriptorFor,
  visualEnabled,
} from "./scene3d/vfx_catalog.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// ---- register stub components (valid manifests; lint-clean shapes) ----
_clearComponents();
const glint = {
  id: "emissive.glint", family: "emissive", mech: "frag", channel: "glint",
  linkVariant: () => "", cacheKeyScope: "set", deterministic: true, lightCountDelta: 0,
  reads: ["surface", "instanceHash", "clock"], writes: ["materialUniform"],
  defaults: { strength: 0.6, metalBias: 0.5 },
  declareUniforms() {}, inject() {},
};
const tarnish = {
  id: "weathering.tarnish", family: "weathering", mech: "frag", channel: "diffuse",
  linkVariant: () => "", cacheKeyScope: "set", deterministic: true, lightCountDelta: 0,
  reads: ["surface", "instanceHash", "clock"], writes: ["materialUniform"],
  defaults: { tarnish: 0.3, tint: 0.5 },
  declareUniforms() {}, inject() {},
};
const windBend = {
  id: "deformation.windBend", family: "deformation", mech: "A", channel: "transform",
  linkVariant: () => "", cacheKeyScope: "none", deterministic: true, lightCountDelta: 0,
  reads: ["geometry", "clock"], writes: ["partTransform"], defaults: {},
};
registerComponent(glint); registerComponent(tarnish); registerComponent(windBend);

// ---- catalog: rigid-glint (frag), trunk-canopy (MECH-A), mixed (both) ----
const FIXTURE = [
  // rigid-glint: both frag comps + shared `age` + a per-id glint override
  '{"did":"0x02000999","archetype":"rigid-glint","components":["emissive.glint","weathering.tarnish"],' +
    '"config":{"age":0.4,"emissive.glint":{"strength":0.9}}}',
  // trunk-canopy: MECH-A only → no frag plan
  '{"did":"0x02001063","archetype":"trunk-canopy","components":["deformation.windBend"]}',
  // mixed: BOTH windBend + glint → frag plan is glint-only (windBend filtered)
  '{"did":"0x02000abc","archetype":"glinting-tree","components":["deformation.windBend","emissive.glint"]}',
  // names an UNREGISTERED frag id → skipped (fail-soft)
  '{"did":"0x02000bad","archetype":"future","components":["emissive.notRegistered"]}',
].join("\n");
_resetVfxCatalog();
setVfxCatalog(parseDescriptorsJsonl(FIXTURE));

// ---- plan shape + FAMILY_ORDER sort ----
const plan = fragPlanForDid(0x02000999);
check("rigid-glint → plan present", !!plan);
check("plan has 2 entries", plan && plan.entries.length === 2, `got ${plan && plan.entries.length}`);
check("entries sorted FAMILY_ORDER: weathering(2) BEFORE emissive(3)",
  plan && plan.ids.join() === "weathering.tarnish,emissive.glint", `got ${plan && plan.ids.join()}`);

// ---- config merge precedence: defaults < shared < per-id ----
const cGlint = plan && plan.entries.find((e) => e.comp.id === "emissive.glint").config;
const cTarn = plan && plan.entries.find((e) => e.comp.id === "weathering.tarnish").config;
check("glint.strength = per-id override (0.9)", cGlint && cGlint.strength === 0.9, `got ${cGlint && cGlint.strength}`);
check("glint.metalBias = default (0.5, untouched)", cGlint && cGlint.metalBias === 0.5);
check("glint.age = shared scalar (0.4)", cGlint && cGlint.age === 0.4);
check("tarnish gets shared age but NOT glint's per-id bucket",
  cTarn && cTarn.age === 0.4 && cTarn.strength === undefined && cTarn.tarnish === 0.3);

// ---- MECH-A filtered; coexistence (both) yields frag-only ----
check("trunk-canopy (windBend only) → null plan", fragPlanForDid(0x02001063) === null);
const mixed = fragPlanForDid(0x02000abc);
check("mixed DID (windBend+glint) → frag plan is glint-ONLY",
  !!mixed && mixed.ids.join() === "emissive.glint", `got ${mixed && mixed.ids.join()}`);
check("isFragDid(mixed) true; isFragDid(windBend-only) false",
  isFragDid(0x02000abc) === true && isFragDid(0x02001063) === false);

// ---- fail-soft: unregistered frag id, unknown DID ----
check("descriptor naming an UNREGISTERED frag comp → null", fragPlanForDid(0x02000bad) === null);
check("unknown DID → null", fragPlanForDid(0x0200dead) === null);

// ---- determinism: identical plan on repeat (stable order + values) ----
const p2 = fragPlanForDid(0x02000999);
check("plan is deterministic (same ids order on repeat)", p2.ids.join() === plan.ids.join());

// ---- per-effect gate hook (slice 14 plug-in): comp.enabled() === false skips ----
glint.enabled = () => false;
const gated = fragEntriesForDescriptor(vfxDescriptorFor(0x02000999));
check("comp.enabled()===false skips that component (tarnish remains)",
  gated.length === 1 && gated[0].comp.id === "weathering.tarnish", `got ${gated.map((e) => e.comp.id).join()}`);
delete glint.enabled;

// ---- the statics-seam swap predicate (mirrors statics.js exactly) ----
// `const fragPlan = visualEnabled() ? fragPlanForDid(modelId) : null;`
// then per surface: `if (fragPlan) mat = buildFragVariant(mc, sid, fragPlan.entries)`.
function seamMaterial(modelId, surfaceDid, baseMat, resolve) {
  const fragPlan = visualEnabled() ? fragPlanForDid(modelId) : null;
  let mat = baseMat;                       // = materialCache.getCached(surfaceDid)
  if (fragPlan) mat = resolve(surfaceDid, fragPlan.entries);
  return mat;
}
const BASE = { __base: true };
let resolveCalls = [];
const resolveStub = (sid, entries) => { resolveCalls.push({ sid, n: entries.length }); return { __variant: sid }; };

// OFF: seam keeps the base material → byte-identical frozen.
// 2026-08-03: this used to `delete globalThis.window`, i.e. assert that the
// NO-WINDOW default is off. `?visual` is default-ON (vfx_catalog.js:29,
// docs/url-flags.md:305 "on, default-on since f3942a95"), and the no-window
// case follows that default — so the assertion was pinning a retired default,
// not the seam. Drive the OFF state the way a user actually reaches it.
globalThis.window = { location: { search: "?visual=off" } };
_resetVfxCatalog(); setVfxCatalog(parseDescriptorsJsonl(FIXTURE));
resolveCalls = [];
check("seam OFF (?visual=off): rigid-glint keeps BASE material (no swap, no resolver call)",
  seamMaterial(0x02000999, 0x1111, BASE, resolveStub) === BASE && resolveCalls.length === 0);

// ON (?visual): frag DID swaps to the variant; resolver gets (surfaceDid, entries).
globalThis.window = { location: { search: "?visual=on" } };
_resetVfxCatalog(); setVfxCatalog(parseDescriptorsJsonl(FIXTURE));
resolveCalls = [];
const swapped = seamMaterial(0x02000999, 0x2222, BASE, resolveStub);
check("seam ON: frag DID swaps to the variant material", swapped && swapped.__variant === 0x2222);
check("seam ON: resolver called once with (surfaceDid, 2 entries)",
  resolveCalls.length === 1 && resolveCalls[0].sid === 0x2222 && resolveCalls[0].n === 2);
// ON but a NON-frag DID (windBend-only) keeps base → coexists with the MECH-A peel.
resolveCalls = [];
check("seam ON: non-frag DID keeps BASE (frozen; MECH-A handled on wind path)",
  seamMaterial(0x02001063, 0x3333, BASE, resolveStub) === BASE && resolveCalls.length === 0);

delete globalThis.window;
console.log(`\nVFX frag-attach threading: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
