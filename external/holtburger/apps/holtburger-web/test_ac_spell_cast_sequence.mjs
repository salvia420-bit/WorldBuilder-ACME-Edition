// Wave 14 / Phase 45 — `ui/ac_spell_cast_sequence.js` unit tests.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_ac_spell_cast_sequence.mjs
//
// Mirrors the Phase 12 pattern (`test_ac_spell_shape.mjs`): loads the
// helper via file:// URL, preloads a synthetic sequence table
// synchronously via `_loadSequenceSync` so `getCastSequence` is
// callable without `fetch`. Exits non-zero on any failure.
//
// Why synthetic data: Phase 44 (Agent AP) generates the real
// `data/spell-cast-sequence.json` in parallel. Phase 45's test
// contract is "consume the schema shape", not "validate the
// generator's spell-by-spell output". A synthetic fixture covering
// FastCast + Lead-exempt + multi-component + lookup-miss is enough
// to lock the contract; the data-side correctness is Phase 44's
// responsibility.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperUrl =
    "file://" + resolvePath(__dirname, "ui/ac_spell_cast_sequence.js");
const {
    getCastSequence,
    _loadSequenceSync,
    _resetSequenceTable,
    isCastSequenceLoaded,
} = await import(helperUrl);

// Synthetic fixture — covers all four shape variants the chain runner
// needs to handle:
//   1) Normal multi-component spell (3 windups + 1 cast)
//   2) FastCast spell (0 windups + 1 cast)
//   3) Lead-exempt spell (0 windups + 1 cast, like FastCast but
//      `fastCast: false` — Lead is exempt for a different reason
//      per ACE's SpellFormula.GetGestureMotionsList short-circuit)
//   4) Single-windup spell (1 windup + 1 cast — sanity check the
//      chain runner doesn't special-case "exactly one")
const FIXTURE = {
    // Spell 9999 — synthetic 3-windup War Bolt (Mana + Pyreal + Iron)
    "9999": {
        school: "War",
        shape: "Bolt",
        level: 5,
        fastCast: false,
        windupGestures: [
            { motion: "0x40000001", name: "MagicPowerUp01", durationS: 0.8 },
            { motion: "0x40000002", name: "MagicPowerUp02", durationS: 0.8 },
            { motion: "0x40000003", name: "MagicPowerUp03", durationS: 0.8 },
        ],
        castGesture: { motion: "0x40000010", name: "MagicBlast", durationS: 1.2 },
        totalDurationS: 3.6,
    },
    // Spell 8888 — synthetic FastCast spell (Cleric's Blessing analog,
    // FastCast bit set → no windup, only cast)
    "8888": {
        school: "Life",
        shape: "Self",
        level: 1,
        fastCast: true,
        windupGestures: [],
        castGesture: { motion: "0x40000011", name: "MagicSelf", durationS: 0.6 },
        totalDurationS: 0.6,
    },
    // Spell 75 — Lightning Bolt I (Lead-only scarab — exempt). Real
    // SpellId from LSD; the generator emits this with empty windup
    // per ACE's Lead-scarab short-circuit.
    "75": {
        school: "War",
        shape: "Bolt",
        level: 1,
        fastCast: false,
        windupGestures: [],
        castGesture: { motion: "0x40000010", name: "MagicBlast", durationS: 1.2 },
        totalDurationS: 1.2,
    },
    // Spell 7777 — synthetic single-windup spell (Mana scarab only)
    "7777": {
        school: "Item",
        shape: "Self",
        level: 2,
        fastCast: false,
        windupGestures: [
            { motion: "0x40000001", name: "MagicPowerUp01", durationS: 0.8 },
        ],
        castGesture: { motion: "0x40000011", name: "MagicSelf", durationS: 0.6 },
        totalDurationS: 1.4,
    },
};

_loadSequenceSync(FIXTURE);

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failed += 1; else passed += 1;
}

console.log("===========================================================");
console.log("Wave 14 / Phase 45 — ac_spell_cast_sequence unit tests");
console.log("===========================================================");

// --- Module exports surface ---

check("getCastSequence is a function", typeof getCastSequence === "function");
check(
    "isCastSequenceLoaded returns true after preload",
    isCastSequenceLoaded() === true,
);

// --- Case 1: Lookup-hit, normal multi-component spell ---

{
    const got = getCastSequence(9999);
    check(
        "normal multi-component (id 9999): returns object",
        got !== null && typeof got === "object",
    );
    check(
        "normal multi-component: school/shape/level match",
        got?.school === "War" && got?.shape === "Bolt" && got?.level === 5,
        `got school=${got?.school} shape=${got?.shape} level=${got?.level}`,
    );
    check(
        "normal multi-component: 3 windup gestures in order",
        Array.isArray(got?.windupGestures)
        && got.windupGestures.length === 3
        && got.windupGestures[0].name === "MagicPowerUp01"
        && got.windupGestures[1].name === "MagicPowerUp02"
        && got.windupGestures[2].name === "MagicPowerUp03",
        `got [${got?.windupGestures?.map(g => g.name).join(",")}]`,
    );
    check(
        "normal multi-component: castGesture is MagicBlast 1.2s",
        got?.castGesture?.name === "MagicBlast"
        && got?.castGesture?.durationS === 1.2,
    );
    check(
        "normal multi-component: totalDurationS = 3.6",
        got?.totalDurationS === 3.6,
        `got ${got?.totalDurationS}`,
    );
    check(
        "normal multi-component: fastCast=false",
        got?.fastCast === false,
    );
}

// --- Case 2: FastCast spell — empty windup, cast only ---

{
    const got = getCastSequence(8888);
    check(
        "FastCast (id 8888): fastCast=true",
        got?.fastCast === true,
    );
    check(
        "FastCast: empty windupGestures array",
        Array.isArray(got?.windupGestures) && got.windupGestures.length === 0,
        `got len=${got?.windupGestures?.length}`,
    );
    check(
        "FastCast: castGesture present (MagicSelf)",
        got?.castGesture?.name === "MagicSelf",
    );
    check(
        "FastCast: totalDurationS == castGesture.durationS",
        got?.totalDurationS === got?.castGesture?.durationS,
        `total=${got?.totalDurationS} cast=${got?.castGesture?.durationS}`,
    );
}

// --- Case 3: Lead-exempt spell (Lightning Bolt I) — empty windup ---

{
    const got = getCastSequence(75);
    check(
        "Lead-exempt Lightning Bolt I (id 75): fastCast=false",
        got?.fastCast === false,
    );
    check(
        "Lead-exempt: empty windupGestures despite fastCast=false",
        Array.isArray(got?.windupGestures) && got.windupGestures.length === 0,
        `got len=${got?.windupGestures?.length} (ACE Lead short-circuit)`,
    );
    check(
        "Lead-exempt: castGesture is MagicBlast",
        got?.castGesture?.name === "MagicBlast",
    );
}

// --- Case 4: Single-windup spell ---

{
    const got = getCastSequence(7777);
    check(
        "single-windup (id 7777): 1 windup + 1 cast",
        got?.windupGestures?.length === 1
        && got?.castGesture?.name === "MagicSelf",
        `windups=${got?.windupGestures?.length} cast=${got?.castGesture?.name}`,
    );
    check(
        "single-windup: totalDurationS sums correctly (0.8 + 0.6 = 1.4)",
        got?.totalDurationS === 1.4,
        `got ${got?.totalDurationS}`,
    );
}

// --- Case 5: Lookup-miss ---

{
    check("unknown SpellId 999999 → null", getCastSequence(999999) === null);
    check("negative SpellId -1 → null", getCastSequence(-1) === null);
    check("NaN → null", getCastSequence(Number.NaN) === null);
    check("null input → null", getCastSequence(null) === null);
    check("undefined input → null", getCastSequence(undefined) === null);
    check("non-numeric string → null", getCastSequence("not-a-spell") === null);
}

// --- Case 6: String + hex SpellId inputs ---

{
    check(
        "string decimal '9999' → multi-component spell",
        getCastSequence("9999")?.windupGestures?.length === 3,
    );
    // 0x4B = 75 = Lightning Bolt I (Lead-exempt fixture entry).
    check(
        "string hex '0x4B' → Lightning Bolt I (Lead-exempt)",
        getCastSequence("0x4B")?.castGesture?.name === "MagicBlast"
        && getCastSequence("0x4B")?.windupGestures?.length === 0,
    );
}

// --- Case 7: Reset path (async loader gating) ---

_resetSequenceTable();
check(
    "After _resetSequenceTable, isCastSequenceLoaded → false",
    !isCastSequenceLoaded(),
);
check(
    "After _resetSequenceTable, getCastSequence returns null (sync) for valid id",
    getCastSequence(9999) === null,
);
// Reload for cleanup so future tests added to this file get a populated
// table.
_loadSequenceSync(FIXTURE);

// --- Summary ---
console.log("");
console.log(`Cases: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exitCode = 1;
} else {
    console.log("All Phase 45 spell-cast-sequence tests PASS.");
}
