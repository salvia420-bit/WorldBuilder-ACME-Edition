// P4.1a — config_merge identity. Proves the extracted splitConfig/mergeComponentConfig
// reproduce, byte-for-byte, the inline logic that lived (duplicated) in frag_attach.js +
// particle_attach.js — i.e. the dedup is behavior-preserving ([R]).
import { splitConfig, mergeComponentConfig } from "./scene3d/vfx/config_merge.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// Reference impls = the pre-P4.1a inline code, verbatim.
function refSplit(descriptorConfig) {
  const shared = {}, byId = {}; const cfg = descriptorConfig || {};
  for (const k in cfg) {
    if (!Object.prototype.hasOwnProperty.call(cfg, k)) continue;
    const v = cfg[k];
    if (v && typeof v === "object" && !Array.isArray(v)) byId[k] = v; else shared[k] = v;
  }
  return { shared, byId };
}
const refMerge = (comp, split) => ({ ...(comp.defaults || {}), ...split.shared, ...(split.byId[comp.id] || {}) });

const fixtures = [
  undefined, null, {},
  { age: 0.4 },                                   // shared scalar
  { tints: [1, 2, 3] },                           // shared ARRAY (array → shared, not byId)
  { "emissive.glint": { strength: 0.9 } },        // byId object
  { age: 0.4, "emissive.glint": { strength: 0.9 }, "weathering.tarnish": { amount: "hash01" } }, // mixed + precedence
];
const comps = [
  { id: "emissive.glint", defaults: { strength: 0.5, bloomTier: "sub" } },
  { id: "weathering.tarnish", defaults: { amount: 0.0 } },
  { id: "particle.gemSparkle", defaults: {} },
];

let i = 0;
for (const fx of fixtures) {
  const a = splitConfig(fx), b = refSplit(fx);
  check(`splitConfig fixture#${i} == reference (keys+order)`,
    JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));
  for (const c of comps) {
    check(`mergeComponentConfig fixture#${i} :: ${c.id} == reference`,
      JSON.stringify(mergeComponentConfig(c, a)) === JSON.stringify(refMerge(c, b)));
  }
  i++;
}

console.log(`\nconfig_merge identity: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
