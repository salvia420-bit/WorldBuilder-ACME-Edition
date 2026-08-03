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
  carnageDeathSeed,
} = await import("../scene3d/carnage.js");
const { mulberry32, hash32, pickFallStyle, FALL_STYLES } = await import("../scene3d/kill_impulse.js");

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

/* ── 8. the death seed is DECOUPLED from the FALL seed ────────────────── */
section("seed decoupling (2026-08-03 regression lock)");
{
  // THE SETUP THAT MATTERS. entities.js stamps `inst._deathAt` at :9535 and
  // calls `killOptsFor(inst)` at :9554, so on essentially every kill both
  // modules round to the SAME millisecond. `resolveKillImpulse` seeds with
  // `hash32(guid, Math.round(nowMs))`; `carnageOnDeath` used to seed with
  // exactly that expression too. Identical seed ⇒ identical mulberry32 stream,
  // and each side spends its FIRST draw on a different decision. So the fall
  // style and the finisher budget were drawn from THE SAME NUMBER.
  //
  // §4 above could never see this: it seeds with its own `hash32(i+1, 0xd1e)`
  // and never asks what kill_impulse would have drawn at the same instant.
  // This section reseeds the way the RUNTIME seeds.
  const killSeed = (guid, ms) => hash32(guid, Math.round(ms)); // == resolveKillImpulse
  const N = 600;
  const pairs = [];
  for (let i = 0; i < N; i++) {
    const guid = 0x50000000 + i * 7;
    const ms = 1_000_000 + i * 13;
    pairs.push([guid, ms]);
  }

  let identical = 0;
  for (const [g, ms] of pairs) if (carnageDeathSeed(g, ms) === killSeed(g, ms)) identical++;
  ok(identical === 0, `the two seeds never coincide over ${N} kills (got ${identical})`);

  // The first draws must be statistically independent, not equal.
  let sameHalf = 0;
  let equalDraw = 0;
  for (const [g, ms] of pairs) {
    const a = mulberry32(killSeed(g, ms))();
    const b = mulberry32(carnageDeathSeed(g, ms))();
    if (a === b) equalDraw++;
    if ((a < 0.5) === (b < 0.5)) sameHalf++;
  }
  ok(equalDraw === 0, `no kill draws the same first number twice (got ${equalDraw}) — pre-fix: all ${N}`);
  const agree = sameHalf / N;
  console.log(`    first-draw half agreement: ${(agree * 100).toFixed(1)}% (pre-fix 100%, ideal 50%)`);
  ok(agree > 0.38 && agree < 0.62, `the streams are independent, not coupled (${(agree * 100).toFixed(1)}%)`);

  // The BEHAVIOURAL statement of the same thing, and the legible one: at
  // tier 2 the budget threshold is 0.55 while "topple" owns roll < 0.40, so a
  // shared draw makes a toppling death ALWAYS spend the low budget. It must be
  // possible to topple and still draw the bigger finisher.
  const seen = new Map(); // style -> Set(budget)
  for (const [g, ms] of pairs) {
    const style = pickFallStyle(mulberry32(killSeed(g, ms))());
    const budget = finisherBudget(2, mulberry32(carnageDeathSeed(g, ms))());
    if (!seen.has(style.name)) seen.set(style.name, new Set());
    seen.get(style.name).add(budget);
  }
  ok((seen.get("topple")?.size ?? 0) === 2,
    `a toppling death can draw EITHER tier-2 budget (got ${[...(seen.get("topple") ?? [])].join("/")})`);
  const coupled = [...seen.entries()].filter(([, b]) => b.size < 2).map(([k]) => k);
  ok(coupled.length === 0, `no fall style is locked to one budget (coupled: ${coupled.join(",") || "none"})`);
  ok(seen.size >= 4, `the fixture really does exercise several fall styles (${seen.size} of ${FALL_STYLES.length})`);

  // Determinism is the whole reason the seed is a pure function — a seeded
  // test must still replay one kill exactly, and neighbouring kills must differ.
  ok(carnageDeathSeed(0x1234, 5000) === carnageDeathSeed(0x1234, 5000), "the same kill replays exactly");
  ok(carnageDeathSeed(0x1234, 5000) !== carnageDeathSeed(0x1234, 5001), "one millisecond later is a different draw");
  ok(carnageDeathSeed(0x1234, 5000) !== carnageDeathSeed(0x1235, 5000), "a different creature is a different draw");
  ok(carnageDeathSeed(0x1234, 5000.4) === carnageDeathSeed(0x1234, 5000), "sub-millisecond jitter is rounded away");
  ok(Number.isInteger(carnageDeathSeed(0, 0)) && carnageDeathSeed(0, 0) >= 0, "a degenerate kill still seeds a u32");
  ok(Number.isInteger(carnageDeathSeed(undefined, NaN)), "…as does a malformed one");
}

console.log(`\ncarnage_finisher: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
