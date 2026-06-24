// VFX Phase 1 / slice 15 — cost-model + gauge accounting test.
//
// Validates the data the `vfx gauge` (CommandEngine.Vfx.cs VfxGauge) consumes:
//   1. cost_model.jsonl parses (skip-blank, mirrors LoadCostModel).
//   2. EVERY Phase-1 component id has a cost row (gauge never faults
//      "missing cost rows" when a DID resolves to one).
//   3. EVERY id referenced by visual_archetype_rules.jsonl has a row.
//   4. The placement-independence invariant on every NEW row: 0-calls
//      (G2), O(1) programs, 0 VRAM for the uniform-only set, costClass cheap.
//   5. The G4 light invariant: dLightsPerDriver == 0 on every row.
//   6. A JS mirror of the gauge sum proves a frag-heavy + light archetype
//      passes G1–G4 — i.e. the gauge ACCOUNTS for the Phase-1 set.
//   7. Adding the new rows does NOT perturb the Holtburg-ref result (none
//      of the new ids are carried by trunk-canopy / rigid — the only
//      archetypes the Holtburg ref resolves to), so the gauge stays green.
//
// Pure data test (no three.js); run: `node test_vfx_cost_model.mjs`.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// ── Resolve VfxData (walk up to the repo root) ──────────────────────────
function findUp(rel) {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const p = join(dir, rel);
    if (existsSync(p)) return p;
    dir = dirname(dir);
  }
  throw new Error(`could not locate ${rel} walking up from the test dir`);
}
const COST_PATH = findUp("WorldBuilder.Terminal/VfxData/cost_model.jsonl");
const RULES_PATH = findUp("WorldBuilder.Terminal/VfxData/visual_archetype_rules.jsonl");

// ── Tolerant JSONL load (mirrors LoadCostModel: skip blank lines) ───────
function loadJsonl(path) {
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (t.length === 0 || t.startsWith("#")) continue;
    out.push(JSON.parse(t));
  }
  return out;
}

const rows = loadJsonl(COST_PATH);
const byId = new Map(rows.map((r) => [r.id, r]));
check("cost_model.jsonl parses", rows.length > 0, `got ${rows.length} rows`);

// ── 2. Every Phase-1 component has a cost row ───────────────────────────
const PHASE1 = [
  "emissive.glint", "emissive.magicGlow", "emissive.enchantShimmer",
  "weathering.tarnish", "weathering.wetness", "weathering.frost",
  "light.flameFlicker",
];
for (const id of PHASE1) check(`cost row present: ${id}`, byId.has(id));

// The five NEW rows this slice adds (glint + tarnish shipped in Phase 0).
const NEW_ROWS = [
  "emissive.magicGlow", "emissive.enchantShimmer",
  "weathering.wetness", "weathering.frost", "light.flameFlicker",
];

// ── 3. Every archetype-rule component id is scored ──────────────────────
const rules = loadJsonl(RULES_PATH);
const referenced = new Set();
for (const r of rules) for (const c of (r.components || [])) referenced.add(typeof c === "string" ? c : c.id);
for (const id of referenced)
  check(`archetype-referenced component has a cost row: ${id}`, byId.has(id));

// ── 4. Placement-independence invariant on every NEW row ────────────────
function num(r, k) { return typeof r[k] === "number" ? r[k] : 0; }
for (const id of NEW_ROWS) {
  const r = byId.get(id); if (!r) continue;
  check(`${id}: costClass=cheap`, r.costClass === "cheap", `got ${r.costClass}`);
  check(`${id}: 0-calls (G2 placement-independent)`, num(r, "dCallsPerInstance") === 0);
  check(`${id}: O(1) programs (≤1 per driver, G1)`, num(r, "dProgramsPerDriver") <= 1);
  check(`${id}: 0 VRAM (uniform-only, no per-instance tex growth)`, num(r, "dVramMB") === 0);
  check(`${id}: 0 particle emitters`, num(r, "dParticleEmitters") === 0);
}

// ── 4b. Particle rows — the FIRST family on the FILL axis (P3.5). They are
//        the ONLY rows allowed dCallsPerInstance>0; each is bounded by its own
//        emitter count (calls ≤ emitters), adds 0 programs / 0 VRAM / 0 lights,
//        and declares mech "particle". (gemSparkle = P3.3; brazierEmbers +
//        foliageMotes = P3.6/P3.7 stubs.)
const PARTICLE_ROWS = ["particle.gemSparkle", "particle.brazierEmbers", "particle.foliagePollen", "particle.foliageFireflies", "particle.foliageLeaves", "particle.breathFog"];
for (const id of PARTICLE_ROWS) {
  const r = byId.get(id);
  check(`particle cost row present: ${id}`, !!r);
  if (!r) continue;
  check(`${id}: mech=particle`, r.mech === "particle", `got ${r.mech}`);
  check(`${id}: ≥1 emitter`, num(r, "dParticleEmitters") >= 1, `got ${r.dParticleEmitters}`);
  check(`${id}: 1 ≤ calls ≤ emitters (FILL bound, G2)`,
    num(r, "dCallsPerInstance") >= 1 && num(r, "dCallsPerInstance") <= num(r, "dParticleEmitters"),
    `calls=${r.dCallsPerInstance} emitters=${r.dParticleEmitters}`);
  check(`${id}: 0 programs (no shader patch — additive billboard)`, num(r, "dProgramsPerDriver") === 0);
  check(`${id}: 0 VRAM (reuses existing DAT sprite gfxobj)`, num(r, "dVramMB") === 0);
  check(`${id}: 0 lights (G4)`, num(r, "dLightsPerDriver") === 0);
}

// ── 4c. The G2 firewall on the data: ONLY particle rows may add draw calls.
//        Every non-particle row stays dCallsPerInstance:0 (the phases-0-2
//        invariant the old G2 == 0 asserted, now restricted to the non-particle
//        subset).
for (const r of rows) {
  if (r.mech === "particle") continue;
  check(`${r.id}: non-particle ⇒ 0 draw calls (G2 firewall)`, num(r, "dCallsPerInstance") === 0,
    `got ${r.dCallsPerInstance}`);
}

// ── 5. G4 light invariant — NO row adds a light (absent ⇒ 0) ────────────
for (const r of rows)
  check(`${r.id}: dLightsPerDriver == 0 (no relink, G4)`, num(r, "dLightsPerDriver") === 0,
    `got ${r.dLightsPerDriver}`);

// ── 6. Mech-specific shape ──────────────────────────────────────────────
for (const id of ["emissive.magicGlow", "emissive.enchantShimmer", "weathering.wetness", "weathering.frost"]) {
  const r = byId.get(id);
  check(`${id}: mech=frag, +1 program per SET`, r.mech === "frag" && num(r, "dProgramsPerDriver") === 1);
}
const ff = byId.get("light.flameFlicker");
check("light.flameFlicker: mech=light, 0 programs (no shader patch)",
  ff.mech === "light" && num(ff, "dProgramsPerDriver") === 0);
check("light.flameFlicker: dAluClass=none (CPU intensity tick)", ff.dAluClass === "none");

// ── 7. Gauge sum mirror — a frag+light archetype passes G1–G4 ───────────
// Mirrors VfxGauge: sum each resolved component's row ONCE per unique driver.
function gaugeSum(componentIds) {
  let programs = 0, calls = 0, vram = 0, parts = 0, lights = 0;
  for (const id of componentIds) {
    const r = byId.get(id); if (!r) throw new Error(`missing cost row ${id}`);
    programs += num(r, "dProgramsPerDriver"); calls += num(r, "dCallsPerInstance");
    vram += num(r, "dVramMB"); parts += num(r, "dParticleEmitters"); lights += num(r, "dLightsPerDriver");
  }
  return { programs, calls, vram, parts, lights };
}
// A hypothetical magic weapon: glow + shimmer + tarnish (frag) + a brazier flame (light).
const set = gaugeSum(["emissive.magicGlow", "emissive.enchantShimmer", "weathering.tarnish", "light.flameFlicker"]);
check("gauge sum: G2 ΔCalls == 0", set.calls === 0, JSON.stringify(set));
check("gauge sum: G4 Δlights == 0", set.lights === 0, JSON.stringify(set));
check("gauge sum: programs O(component-set) (≤4 conservative upper bound)", set.programs <= 4, JSON.stringify(set));
check("gauge sum: VRAM within budget (≤16MB)", set.vram <= 16, JSON.stringify(set));

// ── 7b. Holtburg ref stays green — new ids NOT carried by the resolvable
//        archetypes (trunk-canopy / rigid), so programsDelta is unperturbed.
const holtburgResolvable = new Set();
for (const r of rules) {
  if (r.id === "trunk-canopy" || r.id === "rigid")
    for (const c of (r.components || [])) holtburgResolvable.add(typeof c === "string" ? c : c.id);
}
for (const id of [...NEW_ROWS, ...PARTICLE_ROWS])
  check(`Holtburg ref unperturbed: ${id} not on trunk-canopy/rigid`, !holtburgResolvable.has(id));

// ── 7c. JS mirror of the NEW particle-aware G2 (CommandEngine.Vfx.cs VfxGauge).
//        Splits the drawcall delta: the NON-particle subset must be exactly 0,
//        the particle subset is bounded by emitters, and the emitter count is
//        O(unique drivers) ≤ Kpe = uniqueDrivers + slack (mirrors the G1 link
//        budget — emitters scale with unique drivers, NEVER placements).
const GAUGE_KPE_SLACK = 8; // mirrors CommandEngine.Vfx.cs GaugeKpeSlack
function g2Eval(rowsArr, uniqueDrivers) {
  let nonParticleCalls = 0, particleCalls = 0, emitters = 0;
  for (const r of rowsArr) {
    const calls = num(r, "dCallsPerInstance");
    if (r.mech === "particle") { particleCalls += calls; emitters += num(r, "dParticleEmitters"); }
    else nonParticleCalls += calls;
  }
  const kpe = uniqueDrivers + GAUGE_KPE_SLACK;
  return { nonParticleCalls, particleCalls, emitters, kpe,
    pass: nonParticleCalls === 0 && particleCalls <= emitters && emitters <= kpe };
}
function gaugeG2(componentIds, uniqueDrivers) {
  return g2Eval(componentIds.map((id) => {
    const r = byId.get(id); if (!r) throw new Error(`missing cost row ${id}`); return r;
  }), uniqueDrivers);
}
// (a) the Phase-1 frag+light set: 0 particle calls, non-particle subset 0 → PASS.
const g2frag = gaugeG2(["emissive.magicGlow", "emissive.enchantShimmer", "weathering.tarnish", "light.flameFlicker"], 27);
check("G2 mirror: frag/light set non-particle==0 & 0 particle calls (PASS)",
  g2frag.pass && g2frag.particleCalls === 0 && g2frag.nonParticleCalls === 0, JSON.stringify(g2frag));
// (b) a particle driver (gemSparkle) + a frag sibling: calls ≤ emitters, non-particle still 0 → PASS.
const g2gem = gaugeG2(["particle.gemSparkle", "emissive.glint"], 27);
check("G2 mirror: gemSparkle+glint PASS (calls ≤ emitters, non-particle == 0)",
  g2gem.pass && g2gem.particleCalls === 1 && g2gem.emitters === 1 && g2gem.nonParticleCalls === 0,
  JSON.stringify(g2gem));
// (c) the brazier stub (2 emitters / 2 calls) stays within its own bound → PASS.
const g2braz = gaugeG2(["particle.brazierEmbers"], 27);
check("G2 mirror: brazierEmbers 2 calls ≤ 2 emitters (PASS)",
  g2braz.pass && g2braz.particleCalls === 2 && g2braz.emitters === 2, JSON.stringify(g2braz));
// (d) NEGATIVE control — a particle row with calls > emitters MUST fail the FILL bound.
check("G2 mirror: calls>emitters FAILS (negative control)",
  g2Eval([{ mech: "particle", dCallsPerInstance: 3, dParticleEmitters: 1 }], 27).pass === false);
// (e) NEGATIVE control — a non-particle row with calls>0 MUST fail the firewall.
check("G2 mirror: non-particle calls>0 FAILS (firewall negative control)",
  g2Eval([{ mech: "frag", dCallsPerInstance: 1, dParticleEmitters: 0 }], 27).pass === false);
// (f) NEGATIVE control — emitters exceeding Kpe (a per-placement explosion proxy) MUST fail.
check("G2 mirror: emitters>Kpe FAILS (placement-explosion negative control)",
  g2Eval([{ mech: "particle", dCallsPerInstance: 36, dParticleEmitters: 36 }], 27).pass === false);

console.log(`\nVFX cost-model + gauge accounting: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
