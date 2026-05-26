// Wave 7 / Phase 20 — `ui/ac_damage_rating.js` unit tests.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_ac_damage_rating.mjs
//
// Mirrors the Phase 12 pattern (`test_ac_spell_shape.mjs`): loads the
// helper via file:// URL, stubs `window.__sessionHandle.playerStats()`
// so the rollup can be tested without a real session. Exits non-zero
// on any failure.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperUrl =
  "file://" + resolvePath(__dirname, "ui/ac_damage_rating.js");
const {
  SKILL_RECKLESSNESS,
  SKILL_SNEAK_ATTACK,
  TRAINING_UNTRAINED,
  TRAINING_TRAINED,
  TRAINING_SPECIALIZED,
  RECKLESSNESS_BAND_MIN,
  RECKLESSNESS_BAND_MAX,
  readTrainingLevel,
  computeDamageRatingRollup,
} = await import(helperUrl);

// --- Bootstrap a minimal `window` so the helper's
// `(typeof window !== "undefined") ? window.__sessionHandle : null`
// branch has a sink to read from. Tests can swap `__sessionHandle`
// per-case to drive different skill-training scenarios.
if (typeof globalThis.window === "undefined") {
  globalThis.window = {};
}

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1; else passed += 1;
}

function eqRollup(name, got, expected) {
  const ok =
    got.base === expected.base &&
    got.sneak === expected.sneak &&
    got.reckless === expected.reckless &&
    got.total === expected.total;
  check(
    name,
    ok,
    `got={base:${got.base},sneak:${got.sneak},reckless:${got.reckless},total:${got.total}} ` +
    `expected={base:${expected.base},sneak:${expected.sneak},reckless:${expected.reckless},total:${expected.total}}`,
  );
}

// Build a stub session handle whose `playerStats()` returns a `skills`
// flat array containing the requested Recklessness + SneakAttack
// training levels. Any other skill row is omitted (the helper iterates
// 5-tuples until it finds the target type or runs out).
//
//   trainings = { [SkillType]: trainingLevel }
function stubSessionHandle(trainings) {
  const skills = [];
  for (const [type, training] of Object.entries(trainings)) {
    skills.push(
      Number(type), // type
      0,            // current
      0,            // base
      0,            // ranks
      training,     // training
    );
  }
  return {
    playerStats: () => ({ skills }),
  };
}

console.log("===========================================================");
console.log("Wave 7 / Phase 20 — ac_damage_rating unit tests");
console.log("===========================================================");

// --- Module exports surface ---

check(
  "SKILL_RECKLESSNESS === 50 (stats.rs:156)",
  SKILL_RECKLESSNESS === 50,
);
check(
  "SKILL_SNEAK_ATTACK === 51 (stats.rs:157-158)",
  SKILL_SNEAK_ATTACK === 51,
);
check(
  "TRAINING_TRAINED === 2 + TRAINING_SPECIALIZED === 3 (stats.rs:287)",
  TRAINING_TRAINED === 2 && TRAINING_SPECIALIZED === 3,
);
check(
  "Recklessness band 0.10..0.90 (Combat omnibus)",
  RECKLESSNESS_BAND_MIN === 0.10 && RECKLESSNESS_BAND_MAX === 0.90,
);
check(
  "computeDamageRatingRollup is a function",
  typeof computeDamageRatingRollup === "function",
);
check(
  "readTrainingLevel is a function",
  typeof readTrainingLevel === "function",
);

// --- Case 1: Recklessness Trained + power 0.5 + no sneak ---
// In-band → +10 reckless, sneak gated off, base unchanged.

eqRollup(
  "Reck Trained + power 0.5 + no sneak → +10 reckless",
  computeDamageRatingRollup({
    powerLevel: 0.5,
    hasSneak: false,
    sessionHandle: stubSessionHandle({
      [SKILL_RECKLESSNESS]: TRAINING_TRAINED,
      [SKILL_SNEAK_ATTACK]: TRAINING_UNTRAINED,
    }),
  }),
  { base: 0, sneak: 0, reckless: 10, total: 10 },
);

// --- Case 2: Recklessness Specialized + power 0.05 (OUT of band) + no sneak ---
// Out of band → reckless gated off, sneak gated off.

eqRollup(
  "Reck Spec + power 0.05 (out of band) + no sneak → all zeros",
  computeDamageRatingRollup({
    powerLevel: 0.05,
    hasSneak: false,
    sessionHandle: stubSessionHandle({
      [SKILL_RECKLESSNESS]: TRAINING_SPECIALIZED,
      [SKILL_SNEAK_ATTACK]: TRAINING_UNTRAINED,
    }),
  }),
  { base: 0, sneak: 0, reckless: 0, total: 0 },
);

// --- Case 3: Recklessness Untrained + power 0.5 + Sneak Trained ---
// Reck gated off by training; sneak fires for +10.

eqRollup(
  "Reck Untrained + power 0.5 + Sneak Trained → +10 sneak only",
  computeDamageRatingRollup({
    powerLevel: 0.5,
    hasSneak: true,
    sessionHandle: stubSessionHandle({
      [SKILL_RECKLESSNESS]: TRAINING_UNTRAINED,
      [SKILL_SNEAK_ATTACK]: TRAINING_TRAINED,
    }),
  }),
  { base: 0, sneak: 10, reckless: 0, total: 10 },
);

// --- Case 4: Both Specialized + power 0.5 + sneak ---
// Both fire at +20 → +40 total.

eqRollup(
  "Both Spec + power 0.5 + sneak → +40 (20+20)",
  computeDamageRatingRollup({
    powerLevel: 0.5,
    hasSneak: true,
    sessionHandle: stubSessionHandle({
      [SKILL_RECKLESSNESS]: TRAINING_SPECIALIZED,
      [SKILL_SNEAK_ATTACK]: TRAINING_SPECIALIZED,
    }),
  }),
  { base: 0, sneak: 20, reckless: 20, total: 40 },
);

// --- Case 5: No session handle → all zeros, no throw ---
// `readTrainingLevel` must return null when the handle is missing.

let case5Threw = false;
let case5Result;
try {
  case5Result = computeDamageRatingRollup({
    powerLevel: 0.5,
    hasSneak: true,
    sessionHandle: null, // explicit null; window.__sessionHandle is also unset
  });
} catch (e) {
  case5Threw = true;
  console.log(`    threw: ${e?.message ?? e}`);
}
check(
  "No session handle → does not throw",
  !case5Threw,
);
if (!case5Threw) {
  eqRollup(
    "No session handle → all zeros",
    case5Result,
    { base: 0, sneak: 0, reckless: 0, total: 0 },
  );
}

// --- Case 6a: Edge — power exactly 0.10 (lower bound, inclusive) ---

eqRollup(
  "Power exactly 0.10 + Reck Trained → in band (+10)",
  computeDamageRatingRollup({
    powerLevel: 0.10,
    hasSneak: false,
    sessionHandle: stubSessionHandle({
      [SKILL_RECKLESSNESS]: TRAINING_TRAINED,
    }),
  }),
  { base: 0, sneak: 0, reckless: 10, total: 10 },
);

// --- Case 6b: Edge — power exactly 0.90 (upper bound, inclusive) ---

eqRollup(
  "Power exactly 0.90 + Reck Trained → in band (+10)",
  computeDamageRatingRollup({
    powerLevel: 0.90,
    hasSneak: false,
    sessionHandle: stubSessionHandle({
      [SKILL_RECKLESSNESS]: TRAINING_TRAINED,
    }),
  }),
  { base: 0, sneak: 0, reckless: 10, total: 10 },
);

// --- Bonus coverage: readTrainingLevel direct API ---

const stub = stubSessionHandle({
  [SKILL_RECKLESSNESS]: TRAINING_SPECIALIZED,
  [SKILL_SNEAK_ATTACK]: TRAINING_TRAINED,
});
check(
  "readTrainingLevel(SKILL_RECKLESSNESS) reads training row",
  readTrainingLevel(SKILL_RECKLESSNESS, stub) === TRAINING_SPECIALIZED,
);
check(
  "readTrainingLevel(SKILL_SNEAK_ATTACK) reads training row",
  readTrainingLevel(SKILL_SNEAK_ATTACK, stub) === TRAINING_TRAINED,
);
check(
  "readTrainingLevel(unknown skill) returns null",
  readTrainingLevel(9999, stub) === null,
);

// --- Bonus: NaN / undefined powerLevel guards (reckless off) ---

eqRollup(
  "powerLevel = NaN → reckless off",
  computeDamageRatingRollup({
    powerLevel: NaN,
    hasSneak: false,
    sessionHandle: stubSessionHandle({
      [SKILL_RECKLESSNESS]: TRAINING_SPECIALIZED,
    }),
  }),
  { base: 0, sneak: 0, reckless: 0, total: 0 },
);
eqRollup(
  "powerLevel = undefined → reckless off",
  computeDamageRatingRollup({
    powerLevel: undefined,
    hasSneak: false,
    sessionHandle: stubSessionHandle({
      [SKILL_RECKLESSNESS]: TRAINING_SPECIALIZED,
    }),
  }),
  { base: 0, sneak: 0, reckless: 0, total: 0 },
);

// --- Summary ---
console.log("");
console.log(`Cases: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log("All Phase 20 damage-rating tests PASS.");
}
