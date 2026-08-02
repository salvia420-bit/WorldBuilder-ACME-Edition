// carnage_finisher.test.mjs — death finishers must be VARIED, escalating and
// seeded, and the mid-fight escalation policy must not regress.
//
// 2026-08-02 expansion. Before this, every death that reached the finisher ran
// the same script: hip sever (×2 on a crit), then optionally one limb gib and
// one torso gib. Three outcomes total, and the two gibs only ever fired at the
// same two thresholds — so hunting a camp looked like one animation on repeat.
// `planFinisher` now draws EXTRA three-pinata moves (decapitate / shear /
// torsoSplit / quarter / limbGib / torsoGib / chipShower / burst) from an
// overkill-TIERED pool, weighted, without replacement, off a per-death seed.
//
// Everything asserted here is pure — no renderer, no rig, no entity.
//
// Run: node tests/carnage_finisher.test.mjs   (from apps/holtburger-web/)

import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// carnage.js → dismember.js both build THREE objects at module scope; the
// shared stub covers exactly that surface (the planner itself touches none).
register(pathToFileURL(resolvePath(__dirname, "../_three_stub_loader.mjs")).href);

const {
  overkillTier,
  finisherBudget,
  planFinisher,
  planeRecipe,
  deathPlan,
  FINISHER_MOVES,
  pickEscalation,
  pickLegForHit,
  limpSeverity,
  chipChance,
  CARNAGE_LIMP_HITS,
  CARNAGE_SEVER_HITS,
} = await import("../scene3d/carnage.js");
const { mulberry32, hash32 } = await import("../scene3d/kill_impulse.js");

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  FAIL:", msg);
  }
}
function section(n) {
  console.log(`\n— ${n}`);
}

const FULL_RIG = { hasLegs: true, hasChains: true, hasRoot: true };

/* ── 1. overkill tiers ────────────────────────────────────────────────── */
section("overkill tiers");
{
  ok(overkillTier({ totalHits: 0 }) === 0, "an unmarked one-shot is tier 0");
  ok(overkillTier({ totalHits: 2 }) === 0, "two glancing hits stay tier 0");
  ok(overkillTier({ totalHits: 3 }) === 1, "three hits reach tier 1");
  ok(overkillTier({ totalHits: 0, critical: true }) === 1, "a bare crit finish reaches tier 1");
  ok(overkillTier({ totalHits: 8 }) === 2, "eight hits reach tier 2");
  ok(overkillTier({ totalHits: 4, critical: true }) === 2, "crit + 4 reaches tier 2");
  ok(overkillTier({ totalHits: 14 }) === 3, "fourteen hits reach tier 3");
  ok(overkillTier({ totalHits: 8, critical: true, severed: 1 }) === 3, "crit + 8 + a lost limb reaches tier 3");
  ok(overkillTier(null) === 0, "a null context is tier 0");
  // Monotone in every input.
  let prev = -1;
  let monotone = true;
  for (let h = 0; h <= 30; h++) {
    const t = overkillTier({ totalHits: h });
    if (t < prev) monotone = false;
    prev = t;
  }
  ok(monotone, "tier never decreases as hits accumulate");
}

/* ── 2. budgets ───────────────────────────────────────────────────────── */
section("budgets");
{
  ok(finisherBudget(0, 0) === 0 && finisherBudget(0, 0.99) === 0, "tier 0 spends nothing");
  ok(finisherBudget(1, 0) === 1 && finisherBudget(1, 0.99) === 1, "tier 1 always spends exactly one move");
  ok(finisherBudget(2, 0.1) === 1 && finisherBudget(2, 0.9) === 2, "tier 2 spends 1-2");
  ok(finisherBudget(3, 0.1) === 2 && finisherBudget(3, 0.9) === 3, "tier 3 spends 2-3");
}

/* ── 3. the draw ──────────────────────────────────────────────────────── */
section("the finisher draw");
{
  const plan = planFinisher({ totalHits: 20, critical: true, ...FULL_RIG }, mulberry32(1));
  ok(plan.tier === 3, "a 20-hit crit kill is tier 3");
  ok(plan.moves.length >= 2 && plan.moves.length <= 3, `tier-3 draws 2-3 moves (got ${plan.moves.length})`);
  ok(new Set(plan.moves).size === plan.moves.length, "no move is drawn twice in one death");
  ok(typeof plan.hipSevers === "number", "the legacy deathPlan spine is still present");

  // Tier gating: a low-tier kill can never draw a high-tier move.
  const highTierOnly = new Set(FINISHER_MOVES.filter((m) => m.minTier >= 2).map((m) => m.kind));
  let leak = 0;
  for (let s = 0; s < 500; s++) {
    const p = planFinisher({ totalHits: 3, critical: false, ...FULL_RIG }, mulberry32(s + 1));
    for (const m of p.moves) if (highTierOnly.has(m)) leak++;
  }
  ok(leak === 0, `tier-1 kills never draw a tier-2+ move (${leak} leaks)`);

  // Rig capability filtering.
  let bad = 0;
  for (let s = 0; s < 500; s++) {
    const p = planFinisher({ totalHits: 20, critical: true, hasLegs: false, hasChains: false, hasRoot: false }, mulberry32(s + 1));
    for (const m of p.moves) {
      const spec = FINISHER_MOVES.find((x) => x.kind === m);
      if (spec.needs !== "any") bad++;
    }
  }
  ok(bad === 0, `a legless/chainless/rootless rig only draws "any" moves (${bad} violations)`);

  const legless = planFinisher({ totalHits: 20, critical: true, hasLegs: false, hasChains: true, hasRoot: true }, mulberry32(5));
  ok(!legless.moves.includes("quarter") && !legless.moves.includes("limbGib"), "leg moves are filtered on a legless rig");
}

/* ── 4. VARIETY over 400 seeded kills ─────────────────────────────────── */
section("variety over 400 seeded kills");
{
  const lists = new Map();
  const byMove = {};
  const tierCount = {};
  let movesTotal = 0;
  for (let i = 0; i < 400; i++) {
    // A realistic mix of fight shapes, not one canned context.
    const hits = 1 + (i % 17);
    const crit = i % 3 === 0;
    const p = planFinisher(
      { totalHits: hits, critical: crit, severed: i % 5 === 0 ? 1 : 0, ...FULL_RIG },
      mulberry32(hash32(i + 1, 0xd1e)),
    );
    tierCount[p.tier] = (tierCount[p.tier] || 0) + 1;
    const key = `${p.hipSevers}|${p.gibLimb ? "L" : ""}${p.gibTorso ? "T" : ""}|${p.moves.join(">")}`;
    lists.set(key, (lists.get(key) || 0) + 1);
    for (const m of p.moves) byMove[m] = (byMove[m] || 0) + 1;
    movesTotal += p.moves.length;
  }
  const distinct = lists.size;
  const commonest = Math.max(...lists.values());
  console.log(`    ${distinct} distinct finisher scripts over 400 kills; commonest ${commonest} (${((commonest / 400) * 100).toFixed(1)}%)`);
  console.log("    tiers:", JSON.stringify(tierCount), " moves:", JSON.stringify(byMove));
  ok(distinct >= 24, `deaths are not canned: ${distinct} distinct scripts (was 4 before the expansion)`);
  ok(commonest / 400 <= 0.28, `no single script dominates (${((commonest / 400) * 100).toFixed(1)}%)`);
  ok(
    FINISHER_MOVES.every((m) => (byMove[m.kind] || 0) > 0),
    `every catalogued move actually fires (missing: ${FINISHER_MOVES.filter((m) => !byMove[m.kind]).map((m) => m.kind).join(",") || "none"})`,
  );
  ok(movesTotal / 400 >= 0.8 && movesTotal / 400 <= 2.2,
    `budget stays sane: ${(movesTotal / 400).toFixed(2)} extra moves per kill`);
}

/* ── 5. escalation with the fight's shape ─────────────────────────────── */
section("escalation");
{
  const avg = (ctx) => {
    let n = 0;
    for (let i = 0; i < 300; i++) n += planFinisher(ctx, mulberry32(i + 1)).moves.length;
    return n / 300;
  };
  const trivial = avg({ totalHits: 1, ...FULL_RIG });
  const modest = avg({ totalHits: 5, ...FULL_RIG });
  const brutal = avg({ totalHits: 18, critical: true, severed: 2, ...FULL_RIG });
  console.log(`    mean extra moves — trivial ${trivial.toFixed(2)}, modest ${modest.toFixed(2)}, brutal ${brutal.toFixed(2)}`);
  ok(trivial === 0, "a trivial kill stays clean");
  ok(modest > trivial && brutal > modest, "spectacle escalates with the fight");
  ok(brutal <= 3, "even a massacre stays inside the 3-move budget");
}

/* ── 6. cut planes ────────────────────────────────────────────────────── */
section("cut planes");
{
  const t = planeRecipe("transverse", () => 0.5);
  ok(Math.abs(t.tilt - Math.PI / 2) < 1e-9, "transverse cuts are horizontal (normal = world up)");
  const s = planeRecipe("sagittal", () => 0.5);
  ok(s.tilt === 0, "sagittal cuts are vertical");
  const o = planeRecipe("oblique", () => 0.5);
  ok(o.tilt > 0 && o.tilt < Math.PI / 2, `oblique cuts are diagonal (tilt ${o.tilt.toFixed(2)})`);
  // Azimuth + offset must actually vary, or every sever lands on one line.
  const az = new Set();
  const off = new Set();
  const rnd = mulberry32(4242);
  for (let i = 0; i < 200; i++) {
    const r = planeRecipe("oblique", rnd);
    az.add(Math.round(r.az * 4));
    off.add(Math.round(r.offset * 20));
    ok(Math.abs(r.offset) <= 0.25 + 1e-9, "the cut offset stays inside the part");
  }
  ok(az.size > 15, `cut azimuths are varied (${az.size} distinct octant-ish buckets)`);
  ok(off.size > 5, `cut offsets are varied (${off.size} distinct buckets)`);
}

/* ── 7. no regression in the shipped policy ───────────────────────────── */
section("shipped policy unchanged");
{
  ok(deathPlan({ totalHits: 9, critical: false }).gibLimb === true, "deathPlan: 9 hits still gibs a limb");
  ok(deathPlan({ totalHits: 5, critical: true }).gibLimb === true, "deathPlan: crit+5 still gibs a limb");
  ok(deathPlan({ totalHits: 12, critical: true }).gibTorso === true, "deathPlan: crit+12 still gibs the torso");
  ok(deathPlan({ totalHits: 12, critical: false }).gibTorso === false, "deathPlan: a non-crit never gibs the torso");
  ok(deathPlan({ totalHits: 3, critical: true }).hipSevers === 2, "deathPlan: a crit still takes two legs");
  // planFinisher must carry the spine through untouched.
  for (let i = 0; i < 50; i++) {
    const ctx = { totalHits: i, critical: i % 2 === 0, ...FULL_RIG };
    const p = planFinisher(ctx, mulberry32(i + 1));
    const d = deathPlan(ctx);
    if (p.hipSevers !== d.hipSevers || p.gibLimb !== d.gibLimb || p.gibTorso !== d.gibTorso) {
      ok(false, `planFinisher preserves deathPlan at hits=${i}`);
      break;
    }
  }
  ok(true, "planFinisher preserves the deathPlan spine across 50 contexts");

  // Mid-fight escalation policy (shipped 2026-08-02) — unchanged.
  ok(pickEscalation({ cooldownOk: false, critical: true }, 0) === null, "cooldown still gates everything");
  ok(pickEscalation({ cooldownOk: true, critical: true, dislocations: 0 }, 0.1) === "dislocate", "crits still dislocate");
  ok(pickEscalation({ cooldownOk: true, critical: true, dislocations: 2, height: 2, chips: 0, totalHits: 10 }, 0.01) === "chip",
    "a maxed-out dislocation budget falls through to chips");
  ok(limpSeverity(CARNAGE_LIMP_HITS - 1) === 0, "the limp still needs 2 hits");
  ok(limpSeverity(CARNAGE_SEVER_HITS) === 1, "4 hits is still full severity");
  ok(chipChance(0) < chipChance(10) && chipChance(100) <= 0.24, "chip chance still ramps and caps");
  const legs = [
    { leaf: 1, side: "L", end: "F" },
    { leaf: 2, side: "R", end: "F" },
    { leaf: 3, side: "L", end: "B" },
    { leaf: 4, side: "R", end: "B" },
  ];
  ok(pickLegForHit(legs, { height: 2, left: true, front: true }) === null, "Up band still never takes a leg");
  ok(pickLegForHit(legs, { height: 0, left: true, front: false }).leaf === 3, "Low band still routes by quadrant");
  ok(pickLegForHit(legs, { height: 1, left: true, front: true }, 0.9) === null, "Mid band still coin-flips to torso");
}

console.log(`\ncarnage_finisher: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
