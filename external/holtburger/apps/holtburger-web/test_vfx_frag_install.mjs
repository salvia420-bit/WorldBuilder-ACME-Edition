// VFX Phase 1 / slice 02 — frag-component attach path test.
//
// Locks the FIREWALL: program-cache key (setKey) is per component-SET, encoding
// set membership + linkVariant() bits ONLY — never config scalars / per-instance
// hashes. So N surfaceDids × M configs sharing one SET still produce ONE setKey
// (one program). Also locks: (FAMILY_ORDER, id) ordering of both the key and the
// install chain; non-frag (MECH-A) components filtered out (windBend coexists);
// off ⇒ null (byte-identical); the clone-dedup configKey.
//
// Pure node (no THREE): we register fake frag components into the registry and
// drive resolveFragMaterial through a fake MaterialCache that records every
// getCachedVariant call, mirroring materials.js (sets __vfxSetKey BEFORE builder).

import {
  componentSetKey, fragConfigKey, fragComponentsForDescriptor,
  configForComponent, resolveFragMaterial, resolveFragMaterialForDid, _resetFragInstall,
} from "./scene3d/vfx/frag_install.js";
import { registerComponent, _clearComponents } from "./scene3d/vfx/registry.js";
import { visualEnabled, _resetVfxCatalog, setVfxCatalog } from "./scene3d/vfx_catalog.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// ---- fake components (valid manifests so registerComponent accepts them) ----
const fragGlint = {
  id: "emissive.glint", family: "emissive", mech: "frag", channel: "glint",
  linkVariant() { return ""; }, cacheKeyScope: "set", deterministic: true, lightCountDelta: 0,
  reads: ["clock", "instanceHash"], writes: ["materialUniform"], defaults: { strength: 0.4 },
  declareUniforms() {}, inject() {},
};
const fragTarnish = {
  id: "weathering.tarnish", family: "weathering", mech: "frag", channel: "tarnish",
  linkVariant() { return ""; }, cacheKeyScope: "set", deterministic: true, lightCountDelta: 0,
  reads: ["surface", "instanceHash"], writes: ["materialUniform"], defaults: { tarnish: 0.5 },
  declareUniforms() {}, inject() {},
};
// A frag component whose linkVariant() forks the program on a LINK bit.
const fragFrost = {
  id: "weathering.frost", family: "weathering", mech: "frag", channel: "frost",
  linkVariant(cfg) { return cfg && cfg.mode === "ice" ? "ice" : ""; },
  cacheKeyScope: "set", deterministic: true, lightCountDelta: 0,
  reads: ["weather", "geometry"], writes: ["materialUniform"], defaults: {},
  declareUniforms() {}, inject() {},
};
// MECH-A (NOT a frag patch) — must be filtered out so it coexists with frag.
const windBendLike = {
  id: "deformation.windBend", family: "deformation", mech: "A", channel: "transform",
  linkVariant() { return ""; }, cacheKeyScope: "none", deterministic: true, lightCountDelta: 0,
  reads: ["geometry"], writes: ["partTransform"], defaults: {},
};

_clearComponents();
[fragGlint, fragTarnish, fragFrost, windBendLike].forEach(registerComponent);

function desc(ids, config) { return { componentIds: new Set(ids), config: config || {} }; }

// A fake MaterialCache mirroring materials.js getCachedVariant (sets __vfxSetKey
// BEFORE the builder; dedups on surfaceDid|setKey|configKey).
function makeFakeMC() {
  const variants = new Map();
  const calls = [];
  const installRecord = [];
  const installComponentPatch = (material, comp) => { material.__installed.push(comp.id); installRecord.push(comp.id); };
  return {
    calls, variants, installRecord, installComponentPatch,
    getCachedVariant(surfaceDid, setKey, configKey, builder) {
      const key = `${surfaceDid >>> 0}|${setKey}|${configKey}`;
      calls.push({ surfaceDid: surfaceDid >>> 0, setKey, configKey, key });
      let m = variants.get(key);
      if (!m) { m = { userData: { __vfxSetKey: setKey }, __installed: [] }; builder(m); variants.set(key, m); }
      return m;
    },
  };
}
const GLOBALS = { uTime: { value: 0 }, uWetness: { value: 0 } }; // stand-in for VFX_GLOBALS

function visualOn() { globalThis.window = { location: { search: "?visual=on" } }; _resetVfxCatalog(); _resetFragInstall(); }
function visualOff() { delete globalThis.window; _resetVfxCatalog(); _resetFragInstall(); }

// ===== pure helpers: ordering + filtering =====
const both = fragComponentsForDescriptor(desc(["deformation.windBend", "emissive.glint", "weathering.tarnish"]));
check("fragComponentsForDescriptor filters MECH-A (windBend) out", !both.some((c) => c.id === "deformation.windBend"));
check("frag components sorted (FAMILY_ORDER weathering<emissive): [tarnish, glint]",
  both.map((c) => c.id).join() === "weathering.tarnish,emissive.glint", both.map((c) => c.id).join());
check("unregistered id is skipped (no throw)",
  fragComponentsForDescriptor(desc(["emissive.glint", "does.not.exist"])).map((c) => c.id).join() === "emissive.glint");

// ===== componentSetKey: SET membership + linkVariant ONLY =====
const dA = desc(["emissive.glint", "weathering.tarnish"]);
const dB = desc(["weathering.tarnish", "emissive.glint"]); // different Set insertion order
const compsA = fragComponentsForDescriptor(dA);
const compsB = fragComponentsForDescriptor(dB);
check("setKey is input-order-independent (same SET ⇒ same key)",
  componentSetKey(compsA, dA.config) === componentSetKey(compsB, dB.config),
  `${componentSetKey(compsA, dA.config)} vs ${componentSetKey(compsB, dB.config)}`);
check("setKey value is the ordered ids",
  componentSetKey(compsA, dA.config) === "weathering.tarnish+emissive.glint", componentSetKey(compsA, dA.config));

// FIREWALL: config scalars MUST NOT change the setKey (they ride uniforms).
const cfg1 = { "emissive.glint": { strength: 0.2 }, "weathering.tarnish": { tarnish: 0.9 } };
const cfg2 = { "emissive.glint": { strength: 0.95 }, "weathering.tarnish": { tarnish: 0.1 } };
check("config scalars do NOT change setKey (firewall: program per SET, not per config)",
  componentSetKey(compsA, cfg1) === componentSetKey(compsA, cfg2));
// ...but they DO change the heap-dedup configKey.
check("config scalars DO change configKey (heap clone dedup)",
  fragConfigKey(compsA, cfg1) !== fragConfigKey(compsA, cfg2));

// linkVariant() bits DO fork the program (setKey).
const frostDesc = desc(["weathering.frost"]);
const frostComps = fragComponentsForDescriptor(frostDesc);
check("linkVariant() bit forks the setKey (program)",
  componentSetKey(frostComps, { "weathering.frost": { mode: "ice" } }) !==
  componentSetKey(frostComps, { "weathering.frost": { mode: "snow" } }));
check("linkVariant ice variant encodes the bit",
  componentSetKey(frostComps, { "weathering.frost": { mode: "ice" } }) === "weathering.frost:ice");

// ===== resolveFragMaterial: off ⇒ null (byte-identical) =====
visualOff();
check("?visual OFF ⇒ resolveFragMaterial returns null", resolveFragMaterial({
  materialCache: makeFakeMC(), surfaceDid: 7, descriptor: dA, globals: GLOBALS,
  installComponentPatch: makeFakeMC().installComponentPatch,
}) === null);
check("visualEnabled() is false while off", visualEnabled() === false);

// ===== resolveFragMaterial: on ⇒ one variant, ordered install =====
visualOn();
const mc = makeFakeMC();
const mat = resolveFragMaterial({ materialCache: mc, surfaceDid: 7, descriptor: dA, globals: GLOBALS, installComponentPatch: mc.installComponentPatch });
check("?visual ON ⇒ returns a material", !!mat);
check("getCachedVariant called exactly once for one node", mc.calls.length === 1);
check("variant install order == (FAMILY_ORDER,id): [tarnish, glint]",
  mat.__installed.join() === "weathering.tarnish,emissive.glint", mat.__installed.join());
check("__vfxSetKey stamped on the variant", mat.userData.__vfxSetKey === "weathering.tarnish+emissive.glint");

// descriptor with ONLY a MECH-A component ⇒ null (frag path inert; windBend coexists)
check("descriptor carrying ONLY windBend ⇒ null (coexists, no frag variant)",
  resolveFragMaterial({ materialCache: mc, surfaceDid: 7, descriptor: desc(["deformation.windBend"]), globals: GLOBALS, installComponentPatch: mc.installComponentPatch }) === null);

// missing installer ⇒ null (fail-soft to base, byte-identical)
check("no installComponentPatch ⇒ null (fail-soft)",
  resolveFragMaterial({ materialCache: makeFakeMC(), surfaceDid: 7, descriptor: dA, globals: GLOBALS }) === null);

// ===== THE FIREWALL: program count ≈ distinct SETs, not DIDs/configs =====
const fw = makeFakeMC();
// Same SET on 5 surfaceDids × 3 distinct configs = 15 getCachedVariant calls...
for (const surf of [10, 20, 30, 40, 50]) {
  for (const cfg of [cfg1, cfg2, { "emissive.glint": { strength: 0.5 } }]) {
    resolveFragMaterial({ materialCache: fw, surfaceDid: surf, descriptor: { componentIds: new Set(["emissive.glint", "weathering.tarnish"]), config: cfg }, globals: GLOBALS, installComponentPatch: fw.installComponentPatch });
  }
}
const distinctSetKeys = new Set(fw.calls.map((c) => c.setKey));
const distinctCloneKeys = new Set(fw.calls.map((c) => c.key));
check("15 resolves over 5 DIDs × 3 configs ⇒ EXACTLY 1 distinct setKey (1 program)",
  distinctSetKeys.size === 1, `setKeys=${[...distinctSetKeys].join("|")}`);
check("…but 15 distinct clone keys (per-DID×config heap dedup, NOT programs)",
  distinctCloneKeys.size === 15, `cloneKeys=${distinctCloneKeys.size}`);

// adding a frost (different SET) ⇒ a 2nd setKey, never a 16th program for a config
resolveFragMaterial({ materialCache: fw, surfaceDid: 10, descriptor: desc(["weathering.frost"], {}), globals: GLOBALS, installComponentPatch: fw.installComponentPatch });
check("a genuinely different SET adds exactly one more program (setKey)",
  new Set(fw.calls.map((c) => c.setKey)).size === 2);

// ===== resolveFragMaterialForDid via the catalog =====
const catalog = new Map();
catalog.set(0x02000999, { archetype: "rigid-glint", componentIds: new Set(["emissive.glint", "weathering.tarnish"]), config: {} });
catalog.set(0x02001063, { archetype: "trunk-canopy", componentIds: new Set(["deformation.windBend"]), config: {} });
visualOn(); setVfxCatalog(catalog);
const dmc = makeFakeMC();
check("resolveFragMaterialForDid(rigid-glint DID) ⇒ frag variant",
  !!resolveFragMaterialForDid({ materialCache: dmc, surfaceDid: 3, did: 0x02000999, globals: GLOBALS, installComponentPatch: dmc.installComponentPatch }));
check("resolveFragMaterialForDid(windBend-only DID) ⇒ null (MECH-A, no frag)",
  resolveFragMaterialForDid({ materialCache: dmc, surfaceDid: 3, did: 0x02001063, globals: GLOBALS, installComponentPatch: dmc.installComponentPatch }) === null);
check("resolveFragMaterialForDid(unknown DID) ⇒ null",
  resolveFragMaterialForDid({ materialCache: dmc, surfaceDid: 3, did: 0x0200dead, globals: GLOBALS, installComponentPatch: dmc.installComponentPatch }) === null);

// ===== shared prelude (slice 03 vVfxHash) installs FIRST, no setKey impact =====
visualOn();
const pmc = makeFakeMC();
const prelude = { id: "__vfxHash", declareUniforms() {}, inject() {} };
const pmat = resolveFragMaterial({ materialCache: pmc, surfaceDid: 1, descriptor: dA, globals: GLOBALS, installComponentPatch: pmc.installComponentPatch, sharedPrelude: prelude });
check("sharedPrelude installs FIRST then components in order",
  pmat.__installed.join() === "__vfxHash,weathering.tarnish,emissive.glint", pmat.__installed.join());
check("sharedPrelude does NOT change the setKey (firewall)",
  pmc.calls[0].setKey === "weathering.tarnish+emissive.glint", pmc.calls[0].setKey);

// configForComponent: namespaced vs flat
check("configForComponent picks the namespaced slice",
  configForComponent(fragGlint, { "emissive.glint": { strength: 9 } }).strength === 9);
check("configForComponent falls back to flat config",
  configForComponent(fragGlint, { strength: 3 }).strength === 3);

visualOff();
console.log(`\nVFX frag-install: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
