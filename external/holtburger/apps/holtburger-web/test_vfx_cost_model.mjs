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
for (const id of NEW_ROWS)
  check(`Holtburg ref unperturbed: ${id} not on trunk-canopy/rigid`, !holtburgResolvable.has(id));

console.log(`\nVFX cost-model + gauge accounting: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
