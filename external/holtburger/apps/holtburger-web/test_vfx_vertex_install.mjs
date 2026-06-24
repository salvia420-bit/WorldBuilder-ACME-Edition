// VFX Phase 2 / P2.1 — MECH-B vertex-install firewall test (authoritative).
//
// Locks the CENTRAL DESIGN DECISION + the FIREWALL for the FIRST vertex-
// displacement component. The tip-flex archetype SET is
// [deformation.tipFlex (vertex/mech B), emissive.glint (frag)] — ONE material
// carrying BOTH a vertex AND a fragment component. The correct design is ONE
// getCachedVariant call whose setKey spans the WHOLE set, whose builder installs
// every entry, each dispatched to its OWN shader seam (frag -> fragmentShader
// emissivemap; mech B -> vertexShader #include <begin_vertex>). Two chained
// clones would mint two competing __vfxSetKey and is WRONG; this proves one.
//
// COVERS BOTH mech gates (the runtime gate is the load-bearing one):
//   A. frag_attach.fragEntriesForDescriptor — the LIVE runtime selection
//      (statics._fragMat / entities._entityFragMat -> fragPlanForDid) — must
//      admit mech "B" alongside "frag". THIS gate is what makes the spear render;
//      a PATCH_MECHS-only change would leave it dropping tipFlex.
//   B. frag_install.PATCH_MECHS / fragComponentsForDescriptor / resolveFragMaterial
//      — the descriptor->comps path — admits {frag, B} by its shipped default.
//   C. vertex_install.injectBeginVertex — the shared begin_vertex seam helper:
//      idempotent, seam-absent inert, shared-uniform dedup, never touches the
//      fragmentShader / shader.uniforms / customProgramCacheKey (can't fork).
//
// Pure node (no THREE, no wasm): fake components (mech-B tipFlex + frag glint) in
// the registry, a fake MaterialCache recording every getCachedVariant call AND
// running each component's declareUniforms+inject on the variant's single shared
// fake shader — mirroring materials.js installVfxComponentPatch (materials.js:333:
// declareUniforms then inject) + getCachedVariant (sets __vfxSetKey BEFORE the
// builder, materials.js:1902).

import {
  componentSetKey, fragConfigKey, fragComponentsForDescriptor,
  configForComponent, resolveFragMaterial, buildFragVariant, _resetFragInstall,
  PATCH_MECHS,
} from "./scene3d/vfx/frag_install.js";
import { fragEntriesForDescriptor, fragPlanForDid } from "./scene3d/vfx/frag_attach.js";
import { registerComponent, _clearComponents, FAMILY_ORDER } from "./scene3d/vfx/registry.js";
import { visualEnabled, _resetVfxCatalog, setVfxCatalog } from "./scene3d/vfx_catalog.js";
import {
  injectBeginVertex, hasBeginVertexPatch, VERTEX_BEGIN_SEAM, VERTEX_PARS_SEAM,
} from "./scene3d/vfx/vertex_install.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// The mech set the GENERALIZED install path must admit for Phase 2: frag + B.
const VERTEX_SET_MECHS = new Set(["frag", "B"]);

// ---- fake shaders: stand-in MeshStandard vertex + fragment with the seams ----
function fakeVert() {
  return [
    "#include <common>",
    "void main() {",
    "  #include <begin_vertex>",
    "  #include <project_vertex>",
    "  gl_Position = vec4(1.0);",
    "}",
  ].join("\n");
}
function fakeFrag() {
  return [
    "#include <common>",
    "void main() {",
    "  vec3 totalEmissiveRadiance = emissive;",
    "  #include <emissivemap_fragment>",
    "  #include <lights_fragment_begin>",
    "  gl_FragColor = vec4(1.0);",
    "}",
  ].join("\n");
}
function makeFakeShader() { return { uniforms: {}, vertexShader: fakeVert(), fragmentShader: fakeFrag() }; }

// ---- fake components (valid manifests so registerComponent accepts them) ----
// FAKE mech-B vertex component: patches ONLY the vertex shader at begin_vertex,
// via the SHIPPED vertex_install.injectBeginVertex helper (exercises it in situ).
const vtxTipFlex = {
  id: "deformation.tipFlex", family: "deformation", mech: "B", channel: "transform",
  linkVariant() { return ""; }, cacheKeyScope: "set", deterministic: true, lightCountDelta: 0,
  reads: ["geometry", "setup", "clock", "instanceHash"], writes: ["renderTransform"],
  defaults: { ampDeg: 1.5 },
  declareUniforms(shader, config, globals) {
    shader.uniforms = shader.uniforms || {};
    shader.uniforms.uTime = (globals && globals.uTime) || shader.uniforms.uTime || { value: 0 };
    shader.uniforms.uTipAmp = { value: (config && typeof config.ampDeg === "number") ? config.ampDeg : 1.5 };
  },
  inject(shader) {
    injectBeginVertex(shader, {
      marker: "VFX_TIPFLEX_BEGIN",
      parsVertex: "varying float vTipW;",
      sharedUniforms: ["uniform float uTime;", "uniform float uTipAmp;"],
      body: "  // VFX_TIPFLEX_BEGIN\n  transformed += vTipW * uTipAmp * vec3(1.0,0.0,0.0);\n  // VFX_TIPFLEX_END",
    });
  },
};
// FAKE frag component: patches ONLY the fragment shader at emissivemap_fragment.
const fragGlint = {
  id: "emissive.glint", family: "emissive", mech: "frag", channel: "glint",
  linkVariant() { return ""; }, cacheKeyScope: "set", deterministic: true, lightCountDelta: 0,
  reads: ["clock", "instanceHash", "surface"], writes: ["materialUniform"], defaults: { strength: 0.4 },
  declareUniforms(shader, config, globals) {
    shader.uniforms = shader.uniforms || {};
    shader.uniforms.uTime = (globals && globals.uTime) || shader.uniforms.uTime || { value: 0 };
    shader.uniforms.uGlintStrength = { value: (config && typeof config.strength === "number") ? config.strength : 0.4 };
  },
  inject(shader) {
    let fs = shader.fragmentShader || "";
    if (fs.indexOf("VFX_GLINT_BEGIN") !== -1) return;             // recompile-safe
    if (fs.indexOf("#include <emissivemap_fragment>") === -1) return;
    shader.fragmentShader = fs.replace(
      "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\n  // VFX_GLINT_BEGIN\n  totalEmissiveRadiance += vec3(0.0);\n  // VFX_GLINT_END");
  },
};
// A mech-B component whose linkVariant() forks the program on a LINK bit.
const vtxLinkFork = {
  id: "deformation.tipFlex2", family: "deformation", mech: "B", channel: "transform",
  linkVariant(cfg) { return cfg && cfg.curve === "linear" ? "lin" : ""; },
  cacheKeyScope: "set", deterministic: true, lightCountDelta: 0,
  reads: ["geometry", "clock"], writes: ["renderTransform"], defaults: {},
  declareUniforms() {}, inject() {},
};
// MECH-A (CPU keyframe player) — must STILL be filtered out everywhere.
const windBendLike = {
  id: "deformation.windBend", family: "deformation", mech: "A", channel: "transform",
  linkVariant() { return ""; }, cacheKeyScope: "none", deterministic: true, lightCountDelta: 0,
  reads: ["geometry"], writes: ["partTransform"], defaults: {},
};

_clearComponents();
[vtxTipFlex, fragGlint, vtxLinkFork, windBendLike].forEach(registerComponent);

function desc(ids, config) { return { componentIds: new Set(ids), config: config || {} }; }

// Fake MaterialCache mirroring materials.js getCachedVariant + installVfxComponentPatch.
function makeFakeMC() {
  const variants = new Map();
  const calls = [];
  const installRecord = [];
  const installComponentPatch = (material, comp, cfg, globals) => {
    material.__installed.push(comp.id);
    installRecord.push(comp.id);
    try { comp.declareUniforms && comp.declareUniforms(material.__shader, cfg, globals); } catch (_) {}
    try { comp.inject && comp.inject(material.__shader, { material, config: cfg, globals }); } catch (_) {}
  };
  return {
    calls, variants, installRecord, installComponentPatch,
    getCachedVariant(surfaceDid, setKey, configKey, builder) {
      const key = `${surfaceDid >>> 0}|${setKey}|${configKey}`;
      calls.push({ surfaceDid: surfaceDid >>> 0, setKey, configKey, key });
      let m = variants.get(key);
      if (!m) {
        m = { userData: { __vfxSetKey: setKey }, __installed: [], __shader: makeFakeShader() };
        builder(m);
        variants.set(key, m);
      }
      return m;
    },
  };
}
const GLOBALS = { uTime: { value: 0 } };

function visualOn() { globalThis.window = { location: { search: "?visual=on" } }; _resetVfxCatalog(); _resetFragInstall(); }
function visualOff() { delete globalThis.window; _resetVfxCatalog(); _resetFragInstall(); }

// ============================================================================
// GATE A — the LIVE runtime selection: frag_attach.fragEntriesForDescriptor.
// This is what statics._fragMat / entities._entityFragMat resolve through. It
// reads comp.mech from the LIVE registry (no patchMechs param). REQUIRES the
// frag_attach edit (admit mech "B"); on the unedited tree tipFlex is dropped.
// ============================================================================
const liveEntries = fragEntriesForDescriptor(desc(["emissive.glint", "deformation.windBend", "deformation.tipFlex"]));
check("[GATE A] fragEntriesForDescriptor ADMITS mech-B tipFlex (runtime gate widened)",
  liveEntries.some((e) => e.comp.id === "deformation.tipFlex"), liveEntries.map((e) => e.comp.id).join());
check("[GATE A] fragEntriesForDescriptor still admits the frag set-mate (glint)",
  liveEntries.some((e) => e.comp.id === "emissive.glint"));
check("[GATE A] fragEntriesForDescriptor STILL drops MECH-A windBend (CPU player)",
  !liveEntries.some((e) => e.comp.id === "deformation.windBend") && liveEntries.length === 2);
check("[GATE A] entries sorted (FAMILY_ORDER,id): [tipFlex, glint] (vertex before frag)",
  liveEntries.map((e) => e.comp.id).join() === "deformation.tipFlex,emissive.glint", liveEntries.map((e) => e.comp.id).join());

// fragPlanForDid via the catalog -> buildFragVariant -> ONE variant carrying both.
visualOn();
const catalog = new Map();
catalog.set(0x02000724, { archetype: "tip-flex", componentIds: new Set(["deformation.tipFlex", "emissive.glint"]), config: {} });
setVfxCatalog(catalog);
const plan = fragPlanForDid(0x02000724); // atlan spear SetupModel
check("[GATE A] fragPlanForDid(atlan spear) -> plan with [tipFlex, glint]",
  !!plan && plan.ids.join() === "deformation.tipFlex,emissive.glint", plan && plan.ids.join());
const pmc = makeFakeMC();
const pmat = buildFragVariant(pmc, 0x0800abcd, plan.entries, { globals: GLOBALS, installComponentPatch: pmc.installComponentPatch });
check("[GATE A] fragPlanForDid->buildFragVariant builds ONE variant (combined SET)",
  !!pmat && pmc.calls.length === 1 && pmc.calls[0].setKey === "deformation.tipFlex+emissive.glint", pmc.calls[0] && pmc.calls[0].setKey);
check("[GATE A] that ONE variant carries BOTH seams (vertex begin_vertex + frag emissivemap)",
  pmat.__shader.vertexShader.includes("VFX_TIPFLEX_BEGIN") && pmat.__shader.fragmentShader.includes("VFX_GLINT_BEGIN"));

// ============================================================================
// GATE B — the descriptor->comps path: frag_install.PATCH_MECHS shipped default.
// ============================================================================
check("[GATE B] PATCH_MECHS (shipped default) admits frag", PATCH_MECHS.has("frag"));
check("[GATE B] PATCH_MECHS (shipped default) admits MECH-B vertex (generalization landed)",
  PATCH_MECHS.has("B"), [...PATCH_MECHS].join());
check("[GATE B] PATCH_MECHS still EXCLUDES MECH-A / light / particle (not material patches)",
  !PATCH_MECHS.has("A") && !PATCH_MECHS.has("light") && !PATCH_MECHS.has("particle"));
check("FAMILY_ORDER: deformation(0) sorts before emissive(3) — vertex installs before frag",
  FAMILY_ORDER.deformation < FAMILY_ORDER.emissive);

const setComps = fragComponentsForDescriptor(desc(["emissive.glint", "deformation.windBend", "deformation.tipFlex"]));
check("[GATE B] fragComponentsForDescriptor admits tipFlex(B)+glint(frag), drops windBend(A)",
  setComps.map((c) => c.id).join() === "deformation.tipFlex,emissive.glint", setComps.map((c) => c.id).join());

// ===== componentSetKey: SET membership + linkVariant ONLY, order-stable =====
const dA = desc(["deformation.tipFlex", "emissive.glint"]);
const dB = desc(["emissive.glint", "deformation.tipFlex"]);
const compsA = fragComponentsForDescriptor(dA);
const compsB = fragComponentsForDescriptor(dB);
check("setKey is input-order-independent (same SET => same key)",
  componentSetKey(compsA, dA.config) === componentSetKey(compsB, dB.config),
  `${componentSetKey(compsA, dA.config)} vs ${componentSetKey(compsB, dB.config)}`);
check("setKey value is the ordered ids (vertex+frag in one key)",
  componentSetKey(compsA, dA.config) === "deformation.tipFlex+emissive.glint", componentSetKey(compsA, dA.config));

// FIREWALL: config scalars (ampDeg / strength) MUST NOT change the setKey.
const cfg1 = { "deformation.tipFlex": { ampDeg: 1.5 }, "emissive.glint": { strength: 0.2 } };
const cfg2 = { "deformation.tipFlex": { ampDeg: 4.0 }, "emissive.glint": { strength: 0.95 } };
check("config scalars do NOT change setKey (firewall: program per SET, not per config)",
  componentSetKey(compsA, cfg1) === componentSetKey(compsA, cfg2));
check("config scalars DO change configKey (heap clone dedup)",
  fragConfigKey(compsA, cfg1) !== fragConfigKey(compsA, cfg2));

// FIREWALL: a per-instance hash riding the config MUST NOT enter the setKey.
const cfgHash = { "deformation.tipFlex": { ampDeg: 1.5, instanceHash: 0.73, vVfxHash: 0.73 } };
check("per-instance hash in config does NOT change setKey (no per-instance link)",
  componentSetKey(compsA, cfgHash) === componentSetKey(compsA, cfg1));
check("setKey string carries NO per-instance hash token (vVfxHash/instanceHash)",
  !/vVfxHash|instanceHash|Hash/i.test(componentSetKey(compsA, cfgHash)), componentSetKey(compsA, cfgHash));

// linkVariant() bits DO fork the program (setKey) — genuine link bits only.
const forkComps = fragComponentsForDescriptor(desc(["deformation.tipFlex2"]));
check("linkVariant() bit forks the setKey (program) for a vertex component",
  componentSetKey(forkComps, { "deformation.tipFlex2": { curve: "linear" } }) !==
  componentSetKey(forkComps, { "deformation.tipFlex2": { curve: "smoothstep" } }));
check("linkVariant variant encodes the bit",
  componentSetKey(forkComps, { "deformation.tipFlex2": { curve: "linear" } }) === "deformation.tipFlex2:lin");

// ===== off => null (byte-identical) =====
visualOff();
check("?visual OFF => resolveFragMaterial returns null (byte-identical)", resolveFragMaterial({
  materialCache: makeFakeMC(), surfaceDid: 7, descriptor: dA, globals: GLOBALS,
  installComponentPatch: makeFakeMC().installComponentPatch,
}) === null);
check("visualEnabled() is false while off", visualEnabled() === false);

// ===== ON: ONE variant carries BOTH seams (vertex + frag), ordered install =====
visualOn();
const mc = makeFakeMC();
const mat = resolveFragMaterial({ materialCache: mc, surfaceDid: 7, descriptor: dA, globals: GLOBALS, installComponentPatch: mc.installComponentPatch });
check("?visual ON => returns a material", !!mat);
check("getCachedVariant called EXACTLY ONCE for the combined SET (one variant, not two clones)",
  mc.calls.length === 1, `calls=${mc.calls.length}`);
check("the ONE variant carries a single __vfxSetKey spanning the whole SET",
  mat.userData.__vfxSetKey === "deformation.tipFlex+emissive.glint", mat.userData.__vfxSetKey);
check("install order == (FAMILY_ORDER,id): [tipFlex, glint]",
  mat.__installed.join() === "deformation.tipFlex,emissive.glint", mat.__installed.join());
// THE DUAL-SEAM PROOF — both inside the ONE variant's shader:
check("the vertex component patched shader.vertexShader at begin_vertex",
  mat.__shader.vertexShader.indexOf("VFX_TIPFLEX_BEGIN") > mat.__shader.vertexShader.indexOf("#include <begin_vertex>") &&
  mat.__shader.vertexShader.includes("transformed +="));
check("the frag component patched shader.fragmentShader at emissivemap_fragment",
  mat.__shader.fragmentShader.indexOf("VFX_GLINT_BEGIN") > mat.__shader.fragmentShader.indexOf("#include <emissivemap_fragment>"));
check("the vertex patch did NOT leak into the fragment shader",
  !mat.__shader.fragmentShader.includes("VFX_TIPFLEX_BEGIN"));
check("the frag patch did NOT leak into the vertex shader",
  !mat.__shader.vertexShader.includes("VFX_GLINT_BEGIN"));
check("both components share ONE uTime uniform (by reference, single clock)",
  mat.__shader.uniforms.uTime === GLOBALS.uTime &&
  typeof mat.__shader.uniforms.uTipAmp?.value === "number" &&
  typeof mat.__shader.uniforms.uGlintStrength?.value === "number");

// a descriptor carrying ONLY the MECH-A windBend => null (combined path inert)
check("descriptor carrying ONLY MECH-A windBend => null (CPU player coexists, no variant)",
  resolveFragMaterial({ materialCache: mc, surfaceDid: 7, descriptor: desc(["deformation.windBend"]), globals: GLOBALS, installComponentPatch: mc.installComponentPatch }) === null);
// missing installer => null (fail-soft to base, byte-identical)
check("no installComponentPatch => null (fail-soft, base kept)",
  resolveFragMaterial({ materialCache: makeFakeMC(), surfaceDid: 7, descriptor: dA, globals: GLOBALS }) === null);

// ===== THE FIREWALL: program count == distinct SETs, not DIDs/configs =====
const fw = makeFakeMC();
const FW_CONFIGS = [cfg1, cfg2, { "deformation.tipFlex": { ampDeg: 2.2 }, "emissive.glint": { strength: 0.5 } }];
for (const surf of [10, 20, 30, 40, 50]) {
  for (const cfg of FW_CONFIGS) {
    resolveFragMaterial({ materialCache: fw, surfaceDid: surf, descriptor: { componentIds: new Set(["deformation.tipFlex", "emissive.glint"]), config: cfg }, globals: GLOBALS, installComponentPatch: fw.installComponentPatch });
  }
}
const distinctSetKeys = new Set(fw.calls.map((c) => c.setKey));
const distinctCloneKeys = new Set(fw.calls.map((c) => c.key));
check("15 resolves over 5 DIDs x 3 configs => EXACTLY 1 distinct setKey (1 program)",
  distinctSetKeys.size === 1, `setKeys=${[...distinctSetKeys].join("|")}`);
check("…but 15 distinct clone keys (per-DID x config heap dedup, NOT programs)",
  distinctCloneKeys.size === 15, `cloneKeys=${distinctCloneKeys.size}`);
check("the single program key is the combined vertex+frag SET",
  [...distinctSetKeys][0] === "deformation.tipFlex+emissive.glint", [...distinctSetKeys][0]);

// adding a genuinely different SET (a link-fork) => exactly one MORE program.
resolveFragMaterial({ materialCache: fw, surfaceDid: 10, descriptor: desc(["deformation.tipFlex2"], { "deformation.tipFlex2": { curve: "linear" } }), globals: GLOBALS, installComponentPatch: fw.installComponentPatch });
check("a genuinely different SET adds exactly one more program (setKey)",
  new Set(fw.calls.map((c) => c.setKey)).size === 2);

// ===== buildFragVariant (frag_attach plan.entries path) also mixes B+frag =====
const bEntries = [
  { comp: vtxTipFlex, config: { ampDeg: 1.5 } },
  { comp: fragGlint, config: { strength: 0.6 } },
];
const bmc = makeFakeMC();
const bmat = buildFragVariant(bmc, 5, bEntries, { globals: GLOBALS, installComponentPatch: bmc.installComponentPatch });
check("buildFragVariant builds ONE variant from mixed (vertex+frag) entries", !!bmat && bmc.calls.length === 1);
check("buildFragVariant setKey spans the whole SET (firewall-consistent)",
  bmc.calls[0].setKey === "deformation.tipFlex+emissive.glint", bmc.calls[0].setKey);
check("buildFragVariant installs entries in FAMILY_ORDER [tipFlex, glint]",
  bmat.__installed.join() === "deformation.tipFlex,emissive.glint", bmat.__installed.join());
const bmc2 = makeFakeMC();
buildFragVariant(bmc2, 5, [{ comp: vtxTipFlex, config: { ampDeg: 9.0 } }, { comp: fragGlint, config: { strength: 0.6 } }], { globals: GLOBALS, installComponentPatch: bmc2.installComponentPatch });
check("buildFragVariant: config change keeps setKey but forks configKey (firewall)",
  bmc2.calls[0].setKey === bmc.calls[0].setKey && bmc2.calls[0].configKey !== bmc.calls[0].configKey,
  `${bmc2.calls[0].setKey} | ${bmc2.calls[0].configKey} vs ${bmc.calls[0].configKey}`);

// configForComponent: namespaced vs flat (shared with frag path)
check("configForComponent picks the namespaced slice",
  configForComponent(vtxTipFlex, { "deformation.tipFlex": { ampDeg: 9 } }).ampDeg === 9);
check("configForComponent falls back to flat config",
  configForComponent(vtxTipFlex, { ampDeg: 3 }).ampDeg === 3);

// ============================================================================
// GATE C — the begin_vertex seam helper (vertex_install.injectBeginVertex).
// ============================================================================
check("[GATE C] helper exports the canonical seam anchors",
  VERTEX_BEGIN_SEAM === "#include <begin_vertex>" && VERTEX_PARS_SEAM === "#include <common>");

const sh = makeFakeShader();
const fragBefore = sh.fragmentShader;
injectBeginVertex(sh, { marker: "VFX_M", parsVertex: "varying float vTipW;", sharedUniforms: ["uniform float uTime;"], body: "  // VFX_M\n  transformed += vTipW;" });
check("[GATE C] body spliced AFTER begin_vertex (transformed write present)",
  /#include <begin_vertex>\n\s*\/\/ VFX_M\n\s*transformed \+=/.test(sh.vertexShader), sh.vertexShader);
check("[GATE C] pars + shared uTime declared in the VERTEX stage (after #include <common>)",
  sh.vertexShader.includes("uniform float uTime;") && sh.vertexShader.includes("varying float vTipW;"));
check("[GATE C] helper does NOT touch the fragmentShader (frag seam owned by glint)",
  sh.fragmentShader === fragBefore);
check("[GATE C] marker now present (hasBeginVertexPatch)", hasBeginVertexPatch(sh, "VFX_M"));
const vsAfterFirst = sh.vertexShader;
injectBeginVertex(sh, { marker: "VFX_M", parsVertex: "varying float vTipW;", sharedUniforms: ["uniform float uTime;"], body: "  // VFX_M\n  transformed += vTipW;" });
check("[GATE C] idempotent (second inject is a no-op via marker)", sh.vertexShader === vsAfterFirst);
check("[GATE C] body appears exactly once", sh.vertexShader.split("VFX_M").length - 1 === 1);

// shared-uniform dedup across two MECH-B components in one SET.
const sh2 = makeFakeShader();
injectBeginVertex(sh2, { marker: "VFX_A", parsVertex: "varying float vA;", sharedUniforms: ["uniform float uTime;"], body: "  // VFX_A\n  transformed += vA;" });
injectBeginVertex(sh2, { marker: "VFX_B", parsVertex: "varying float vB;", sharedUniforms: ["uniform float uTime;"], body: "  // VFX_B\n  transformed += vB;" });
check("[GATE C] shared uTime declared ONCE across two MECH-B comps (no GLSL redeclare)",
  sh2.vertexShader.split("uniform float uTime;").length - 1 === 1);
check("[GATE C] both bodies present (composes on the chain, order-independent)",
  sh2.vertexShader.includes("transformed += vA;") && sh2.vertexShader.includes("transformed += vB;"));

// seam-absent ⇒ inert (byte-identical), like glint's missing-seam guard.
const noSeam = { vertexShader: "void main() {\n  gl_Position = vec4(0.0);\n}", fragmentShader: "" };
const noSeamBefore = noSeam.vertexShader;
injectBeginVertex(noSeam, { marker: "VFX_X", parsVertex: "uniform float u;", body: "  // VFX_X\n  transformed += 1.0;" });
check("[GATE C] seam-absent ⇒ vertexShader untouched (byte-identical, inert)",
  noSeam.vertexShader === noSeamBefore);

// afterBlock ordering: a vVfxHash-reading component anchors AFTER the per-instance
// hash-assign block (mirrors per_instance.VFX_HASH_ASSIGN_VERTEX) so vVfxHash is
// written before the body reads it. Simulate the prelude having already spliced.
const HASH_ASSIGN = "  vVfxHash = vfxHash01(modelMatrix[3].xy);";
const sh3 = { vertexShader: "#include <common>\nvoid main() {\n  #include <begin_vertex>\n" + HASH_ASSIGN + "\n}", fragmentShader: "" };
injectBeginVertex(sh3, { marker: "VFX_RD", body: "  // VFX_RD\n  transformed += vVfxHash;", afterBlock: HASH_ASSIGN });
check("[GATE C] afterBlock anchors body AFTER the hash-assign (vVfxHash readable)",
  sh3.vertexShader.indexOf("VFX_RD") > sh3.vertexShader.indexOf("vVfxHash = vfxHash01"),
  sh3.vertexShader);
// fallback: afterBlock absent ⇒ anchor on begin_vertex (no crash, still patches).
const sh4 = makeFakeShader();
injectBeginVertex(sh4, { marker: "VFX_FB", body: "  // VFX_FB\n  transformed += 1.0;", afterBlock: "  vVfxHash = vfxHash01(modelMatrix[3].xy);" });
check("[GATE C] afterBlock ABSENT ⇒ falls back to begin_vertex anchor (still patches)",
  sh4.vertexShader.includes("VFX_FB") &&
  sh4.vertexShader.indexOf("VFX_FB") > sh4.vertexShader.indexOf("#include <begin_vertex>"));

visualOff();
console.log(`\nVFX vertex-install (P2.1, MECH-B firewall): ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
