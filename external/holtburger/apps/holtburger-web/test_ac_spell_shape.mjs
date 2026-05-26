// Wave 5 / Phase 12 — `ui/ac_spell_shape.js` unit tests.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_ac_spell_shape.mjs
//
// Mirrors the Phase 7 pattern (`test_ac_aim_level_for_velocity.mjs`):
// loads the helper via file:// URL, preloads the JSON shape table
// synchronously via `_loadTableSync` so `classifySpell` is callable
// without `fetch`. Exits non-zero on any failure.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperUrl =
    "file://" + resolvePath(__dirname, "ui/ac_spell_shape.js");
const {
    SPELL_SHAPE,
    SPELL_SCHOOL,
    classifySpell,
    _loadTableSync,
    _resetTable,
    isShapeTableLoaded,
} = await import(helperUrl);

// Preload the table from the committed JSON. The generator MUST have
// run successfully for this path to exist; if not, the test bails out
// before any case so the failure mode is "regen the table" not
// "classifier returned null for every spell".
const tablePath = resolvePath(__dirname, "data/spell-shapes.json");
let table;
try {
    table = JSON.parse(readFileSync(tablePath, "utf8"));
} catch (err) {
    console.error(`FATAL: could not load ${tablePath}: ${err.message}`);
    console.error("Run `node scripts/gen-spell-shapes.cjs` first.");
    process.exit(2);
}
_loadTableSync(table);

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failed += 1; else passed += 1;
}
function checkClassify(name, spellId, expected) {
    const got = classifySpell(spellId);
    if (got === null && expected === null) {
        check(name, true, `id=${spellId} → null (expected)`);
        return;
    }
    if (got === null) {
        check(name, false, `id=${spellId} → null (expected ${JSON.stringify(expected)})`);
        return;
    }
    if (expected === null) {
        check(name, false, `id=${spellId} → ${JSON.stringify(got)} (expected null)`);
        return;
    }
    const ok = got.school === expected.school
        && got.shape === expected.shape
        && got.level === expected.level;
    check(
        name,
        ok,
        `id=${spellId} got={school=${got.school},shape=${got.shape},level=${got.level}} ` +
        `expected={school=${expected.school},shape=${expected.shape},level=${expected.level}}`,
    );
}

console.log("===========================================================");
console.log("Wave 5 / Phase 12 — ac_spell_shape unit tests");
console.log("===========================================================");

// --- Module exports surface ---

check(
    "SPELL_SCHOOL exposes the 6 ACE-canonical schools (None+War+Life+Item+Creature+Void)",
    SPELL_SCHOOL.None === 0
    && SPELL_SCHOOL.War === 1
    && SPELL_SCHOOL.Life === 2
    && SPELL_SCHOOL.Item === 3
    && SPELL_SCHOOL.Creature === 4
    && SPELL_SCHOOL.Void === 5,
);
check(
    "SPELL_SHAPE exposes the 7-projectile superset + Self",
    SPELL_SHAPE.Bolt === "Bolt"
    && SPELL_SHAPE.Arc === "Arc"
    && SPELL_SHAPE.Streak === "Streak"
    && SPELL_SHAPE.Volley === "Volley"
    && SPELL_SHAPE.Wall === "Wall"
    && SPELL_SHAPE.Ring === "Ring"
    && SPELL_SHAPE.Blast === "Blast"
    && SPELL_SHAPE.Self === "Self",
);
check("SPELL_SCHOOL is frozen", Object.isFrozen(SPELL_SCHOOL));
check("SPELL_SHAPE is frozen", Object.isFrozen(SPELL_SHAPE));
check("classifySpell is a function", typeof classifySpell === "function");
check("isShapeTableLoaded returns true after preload", isShapeTableLoaded() === true);

// --- Hand-picked spell IDs from War + Void ---
// Verified against the committed catalog at `data/spells-catalog.json`
// (each comment cites the LSD-derived name + school + level).

// War / Bolt — Lightning Bolt I (id 75): school=1, level=1, name has "Bolt"
checkClassify(
    "Lightning Bolt I (id 75) → War / Bolt / 1",
    75,
    { school: SPELL_SCHOOL.War, shape: SPELL_SHAPE.Bolt, level: 1 },
);

// War / Bolt — Frost Bolt VI (id 74): school=1, level=6
checkClassify(
    "Frost Bolt VI (id 74) → War / Bolt / 6",
    74,
    { school: SPELL_SCHOOL.War, shape: SPELL_SHAPE.Bolt, level: 6 },
);

// War / Volley — Acid Volley III (id 127): school=1, level=3, name has "Volley"
checkClassify(
    "Acid Volley III (id 127) → War / Volley / 3",
    127,
    { school: SPELL_SCHOOL.War, shape: SPELL_SHAPE.Volley, level: 3 },
);

// War / Arc — Acid Arc VII (id 2717): school=1, level=7, name has "Arc"
checkClassify(
    "Acid Arc VII (id 2717) → War / Arc / 7",
    2717,
    { school: SPELL_SCHOOL.War, shape: SPELL_SHAPE.Arc, level: 7 },
);

// War / Streak — Acid Streak I (id 1790): school=1, level=1, name has "Streak"
checkClassify(
    "Acid Streak I (id 1790) → War / Streak / 1",
    1790,
    { school: SPELL_SCHOOL.War, shape: SPELL_SHAPE.Streak, level: 1 },
);

// War / Bolt (desc-fallback) — Whirling Blade III (id 94): name has no
// shape word but desc "Shoots a magical blade at the target" → Bolt.
// This exercises the description-pattern classifier, not the name
// classifier.
checkClassify(
    "Whirling Blade III (id 94) — desc-fallback Bolt match",
    94,
    { school: SPELL_SCHOOL.War, shape: SPELL_SHAPE.Bolt, level: 3 },
);

// Void / Streak — Nether Streak VII (id 5347): school=5, level=7
checkClassify(
    "Nether Streak VII (id 5347) → Void / Streak / 7",
    5347,
    { school: SPELL_SCHOOL.Void, shape: SPELL_SHAPE.Streak, level: 7 },
);

// Void / Bolt — Nether Bolt I (id 5349): school=5, level=1, name has "Bolt"
checkClassify(
    "Nether Bolt I (id 5349) → Void / Bolt / 1",
    5349,
    { school: SPELL_SCHOOL.Void, shape: SPELL_SHAPE.Bolt, level: 1 },
);

// Life / Self — Heal Other I (id 5): school=2, level=1, non-projectile
checkClassify(
    "Heal Other I (id 5) → Life / Self / 1 (non-projectile)",
    5,
    { school: SPELL_SCHOOL.Life, shape: SPELL_SHAPE.Self, level: 1 },
);

// Creature / Self — Strength Self I (id 2): school=4, level=1, buff
checkClassify(
    "Strength Self I (id 2) → Creature / Self / 1 (buff)",
    2,
    { school: SPELL_SCHOOL.Creature, shape: SPELL_SHAPE.Self, level: 1 },
);

// --- Edge cases ---

checkClassify("unknown SpellId → null", 999999999, null);
checkClassify("negative SpellId → null", -1, null);
checkClassify("NaN → null", Number.NaN, null);
checkClassify("string decimal '75' → Lightning Bolt I",
    "75",
    { school: SPELL_SCHOOL.War, shape: SPELL_SHAPE.Bolt, level: 1 });
checkClassify("string hex '0x4B' (75) → Lightning Bolt I",
    "0x4B",
    { school: SPELL_SCHOOL.War, shape: SPELL_SHAPE.Bolt, level: 1 });
checkClassify("null input → null", null, null);
checkClassify("undefined input → null", undefined, null);
checkClassify("non-numeric string → null", "not-a-spell", null);

// --- Bucket-distribution sanity (verifies the table joined OK) ---

const counts = { war: 0, void_: 0, life: 0, item: 0, creature: 0, none: 0 };
const warShapes = new Set();
const voidShapes = new Set();
for (const k of Object.keys(table)) {
    const e = table[k];
    if (e.school === 1) { counts.war += 1; warShapes.add(e.shape); }
    else if (e.school === 5) { counts.void_ += 1; voidShapes.add(e.shape); }
    else if (e.school === 2) counts.life += 1;
    else if (e.school === 3) counts.item += 1;
    else if (e.school === 4) counts.creature += 1;
    else if (e.school === 0) counts.none += 1;
}
check(
    "≥600 War Magic spells in table (catalog has 691)",
    counts.war >= 600,
    `got ${counts.war}`,
);
check(
    "≥60 Void Magic spells in table (catalog has 76)",
    counts.void_ >= 60,
    `got ${counts.void_}`,
);
// War must hit all 7 projectile shapes (6 from wiki + Streak from
// Slumbering Giant patch) plus Self.
check(
    "War uses all 7 projectile shapes (+Self)",
    warShapes.has("Bolt") && warShapes.has("Arc") && warShapes.has("Streak")
    && warShapes.has("Volley") && warShapes.has("Wall")
    && warShapes.has("Ring") && warShapes.has("Blast")
    && warShapes.has("Self"),
    `got ${[...warShapes].sort().join(",")}`,
);
// Void uses 5 projectile shapes per wiki: Arc, Ring, Bolt, Streak,
// Blast — NO Wall, NO Volley. Plus Self for DoTs/debuffs.
check(
    "Void uses exactly 5 projectile shapes (+Self), NO Wall, NO Volley",
    voidShapes.has("Bolt") && voidShapes.has("Arc") && voidShapes.has("Streak")
    && voidShapes.has("Ring") && voidShapes.has("Blast")
    && voidShapes.has("Self")
    && !voidShapes.has("Wall") && !voidShapes.has("Volley"),
    `got ${[...voidShapes].sort().join(",")}`,
);

// --- Reset path (async loader gating) ---

_resetTable();
check("After _resetTable, isShapeTableLoaded → false", !isShapeTableLoaded());
check(
    "After _resetTable, classifySpell returns null (sync) for valid id",
    classifySpell(75) === null,
);
// Reload for cleanup so test-runner's subsequent calls (none here, but
// future tests added to this file) get a populated table.
_loadTableSync(table);

// --- Summary ---
console.log("");
console.log(`Cases: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exitCode = 1;
} else {
    console.log("All Phase 12 spell-shape tests PASS.");
}
