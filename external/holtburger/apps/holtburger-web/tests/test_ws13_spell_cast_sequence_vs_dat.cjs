#!/usr/bin/env node
// tests/test_ws13_spell_cast_sequence_vs_dat.cjs
//
// WS13 (2026-07-12) — gesture-identity regression: proves the shipped
// `data/spell-cast-sequence.json` is byte-consistent with the
// DAT-authoritative attribute table `data/spell-table-attrs.json`
// (decrypted client_portal.dat 0x0E00000E) joined against the DAT
// component table `data/spell-components.json`, for EVERY one of the
// 6,266 spells.
//
// It re-derives the cast sequence with an INDEPENDENT reimplementation of
// the ACE algorithm (SpellFormula.cs:245-287 / Player_Magic.cs:605-689)
// so a bug shared with the generator can't hide the mismatch, and it
// hard-asserts zero unresolved component ids (the check that would have
// caught the corrupt LSD rows 4024/4904 the DAT source now fixes).
//
// Also asserts the §4.2 focused fixtures (exact windup/cast/scale/effect
// values for a war/void/life spread + the 3 post-fix spells).
//
// Run: node tests/test_ws13_spell_cast_sequence_vs_dat.cjs
//   (from apps/holtburger-web/)

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const seqDoc = JSON.parse(
  fs.readFileSync(path.join(ROOT, "data", "spell-cast-sequence.json"), "utf8"),
);
const compsDoc = JSON.parse(
  fs.readFileSync(path.join(ROOT, "data", "spell-components.json"), "utf8"),
);
const attrsDoc = JSON.parse(
  fs.readFileSync(path.join(ROOT, "data", "spell-table-attrs.json"), "utf8"),
);

const sequences = seqDoc.sequences;
const attrs = attrsDoc.attrs;
const compById = {};
for (const idStr of Object.keys(compsDoc.components)) {
  compById[idStr | 0] = compsDoc.components[idStr];
}

// Constants mirrored from the generator (kept local so the test is
// independent of the generator source).
const SPELL_FLAGS_FAST_CAST = 0x4000;
const MOTION_INVALID = "0x80000000";
const TYPE_SCARAB = 1;
const TYPE_TALISMAN = 5;
const SCARAB_SCALE = {
  1: 0.05, 2: 0.2, 3: 0.4, 4: 0.5, 5: 0.6,
  6: 1.0, 110: 1.0, 112: 1.0, 192: 1.0, 193: 1.0,
};

let failures = 0;
function fail(msg) {
  failures += 1;
  console.error("  FAIL: " + msg);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}

// ---- Independent re-derivation for every spell ---------------------------

let unresolvedTotal = 0;
let checked = 0;
let warVoid = 0;
for (const sidStr of Object.keys(attrs)) {
  const a = attrs[sidStr];
  const seq = sequences[sidStr];
  if (!seq) {
    fail(`spell ${sidStr}: present in attrs but missing from sequences`);
    continue;
  }
  checked += 1;
  if (a.school === "WarMagic" || a.school === "VoidMagic") warVoid += 1;

  const componentIds = a.formula.map((n) => n & 0xffff).filter((n) => n > 0);
  const fastCast = (a.bitfield & SPELL_FLAGS_FAST_CAST) !== 0;

  // formulaScale — first scarab in decoded order.
  let formulaScale = 1.0;
  for (const cid of componentIds) {
    const c = compById[cid];
    if (c && c.type === TYPE_SCARAB) {
      if (typeof SCARAB_SCALE[cid] === "number") formulaScale = SCARAB_SCALE[cid];
      break;
    }
  }

  const scarabs = [];
  let talisman = null;
  for (const cid of componentIds) {
    const c = compById[cid];
    if (!c) {
      unresolvedTotal += 1;
      continue;
    }
    if (c.type === TYPE_SCARAB) scarabs.push({ id: cid, comp: c });
    else if (c.type === TYPE_TALISMAN) talisman = { id: cid, comp: c };
  }
  const leadOnly = scarabs.length > 0 && scarabs.every((s) => s.id === 1);

  const windup = [];
  if (!fastCast && !leadOnly) {
    for (const s of scarabs) {
      if (s.comp.gesture === MOTION_INVALID) continue;
      windup.push(s.comp.gesture);
    }
  }

  const lastCompId = componentIds.length
    ? componentIds[componentIds.length - 1]
    : 0;
  const lastComp = compById[lastCompId];
  const lastIsTalisman = !!(lastComp && lastComp.type === TYPE_TALISMAN);
  // Default-off build: cast is the talisman gesture iff the formula's
  // LAST component is a talisman, else null (Patch B / Ready fallback is
  // env-gated and NOT the shipped default).
  const expectCastMotion =
    talisman && lastIsTalisman ? talisman.comp.gesture : null;

  // Compare gesture-identity fields against the shipped sequence.
  assert(seq.fastCast === fastCast, `spell ${sidStr}: fastCast ${seq.fastCast}!=${fastCast}`);
  assert(seq.leadOnly === leadOnly, `spell ${sidStr}: leadOnly ${seq.leadOnly}!=${leadOnly}`);
  const seqWindup = seq.windupGestures.map((g) => g.motion);
  assert(
    JSON.stringify(seqWindup) === JSON.stringify(windup),
    `spell ${sidStr}: windup ${JSON.stringify(seqWindup)}!=${JSON.stringify(windup)}`,
  );
  const seqCast = seq.castGesture ? seq.castGesture.motion : null;
  assert(seqCast === expectCastMotion, `spell ${sidStr}: cast ${seqCast}!=${expectCastMotion}`);
  assert(
    Number(seq.formulaScale) === Number(formulaScale.toFixed(4)),
    `spell ${sidStr}: formulaScale ${seq.formulaScale}!=${formulaScale}`,
  );
  assert(
    (seq.casterEffect >>> 0) === (a.casterEffect >>> 0),
    `spell ${sidStr}: casterEffect ${seq.casterEffect}!=${a.casterEffect}`,
  );
  assert(
    (seq.targetEffect >>> 0) === (a.targetEffect >>> 0),
    `spell ${sidStr}: targetEffect ${seq.targetEffect}!=${a.targetEffect}`,
  );
}

// Hard-assert: no unresolved component ids anywhere (would have flagged
// the old corrupt LSD rows 4024/4904).
assert(unresolvedTotal === 0, `unresolved component ids found: ${unresolvedTotal}`);
assert(
  seqDoc._missing_component_lookups === 0,
  `_missing_component_lookups should be 0, got ${seqDoc._missing_component_lookups}`,
);
// The generator's data-warnings must contain ZERO unresolved-components
// entries (only the informational no-talisman-terminal notes).
const unresWarnings = (seqDoc._data_warnings || []).filter(
  (w) => w.reason === "unresolved-components",
);
assert(
  unresWarnings.length === 0,
  `unresolved-components warnings: ${JSON.stringify(unresWarnings)}`,
);

console.log(
  `[recompute] checked ${checked} spells (${warVoid} war/void), ` +
  `unresolved=${unresolvedTotal}, failures so far=${failures}`,
);

// ---- §4.2 focused fixtures (exact values) --------------------------------

function fixture(sid, checks) {
  const e = sequences[sid];
  if (!e) return fail(`fixture spell ${sid} missing`);
  const wu = e.windupGestures.map((g) => g.motion);
  const cast = e.castGesture ? e.castGesture.motion : null;
  for (const [label, got, want] of checks) {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    assert(g === w, `fixture ${sid} ${label}: ${g}!=${w}`);
  }
  return [wu, cast];
}

// 5355 Nether Bolt VII (Void): windup [0x10000132], cast MagicRecoilMissile, scale 1.0
{
  const wu = sequences["5355"].windupGestures.map((g) => g.motion);
  fixture("5355", [
    ["fastCast", sequences["5355"].fastCast, false],
    ["windup", wu, ["0x10000132"]],
    ["cast", sequences["5355"].castGesture.motion, "0x40000033"],
    ["scale", sequences["5355"].formulaScale, 1],
  ]);
}
// 5347 Nether Streak VII (Void): fastCast, empty windup, cast MagicRecoilMissile
fixture("5347", [
  ["fastCast", sequences["5347"].fastCast, true],
  ["windup", sequences["5347"].windupGestures.map((g) => g.motion), []],
  ["cast", sequences["5347"].castGesture.motion, "0x40000033"],
]);
// 1708 Wedding Bliss: windup [0x10000076,0x10000078,0x10000078] (Lead Invalid dropped)
fixture("1708", [
  ["leadOnly", sequences["1708"].leadOnly, false],
  ["windup", sequences["1708"].windupGestures.map((g) => g.motion),
    ["0x10000076", "0x10000078", "0x10000078"]],
]);
// 2038 Exploding Ice (War): windup [0x10000072,0x10000070,0x10000072], cast null (default-off)
fixture("2038", [
  ["windup", sequences["2038"].windupGestures.map((g) => g.motion),
    ["0x10000072", "0x10000070", "0x10000072"]],
  ["cast", sequences["2038"].castGesture, null],
]);
// 4024 (post-fix): windup [0x10000070], cast MagicPenalty 0x40000034, scale 0.05.
// NOTE (WS13-verify mustFix #2): totalDurationS ALSO changes here (0 -> 2.7795)
// now that the windup+cast are populated — asserted below.
fixture("4024", [
  ["windup", sequences["4024"].windupGestures.map((g) => g.motion), ["0x10000070"]],
  ["cast", sequences["4024"].castGesture.motion, "0x40000034"],
  ["scale", sequences["4024"].formulaScale, 0.05],
]);
assert(sequences["4024"].totalDurationS > 0,
  `4024 totalDurationS should be populated, got ${sequences["4024"].totalDurationS}`);
// 4904 (post-fix): cast MagicSelfHead 0x4000002C. totalDurationS also shifts.
fixture("4904", [
  ["cast", sequences["4904"].castGesture.motion, "0x4000002C"],
]);
// 5174 (post-fix): targetEffect 31 (HealthUpRed)
fixture("5174", [
  ["targetEffect", sequences["5174"].targetEffect, 31],
]);

// The 10 §2.4 no-talisman spells must be recorded as informational warnings
// and (default build) carry a null castGesture.
const noTal = (seqDoc._data_warnings || [])
  .filter((w) => w.reason === "no-talisman-terminal")
  .map((w) => w.spell)
  .sort((a, b) => a - b);
assert(
  JSON.stringify(noTal) === JSON.stringify([1781, 2034, 2038, 2976, 3874, 3911, 3940, 3999, 4113, 4239]),
  `no-talisman-terminal set: ${JSON.stringify(noTal)}`,
);
for (const s of noTal) {
  assert(sequences[String(s)].castGesture === null,
    `no-talisman spell ${s} should have null cast in default build`);
}

// fastCast count parity with the DAT attrs table.
assert(
  seqDoc._fast_cast_count === attrsDoc._fast_cast_count,
  `fastCast count mismatch: seq ${seqDoc._fast_cast_count} vs attrs ${attrsDoc._fast_cast_count}`,
);
assert(seqDoc._fast_cast_count === 686, `expected 686 fastCast, got ${seqDoc._fast_cast_count}`);

if (failures === 0) {
  console.log(`\nPASS — all ${checked} spells consistent + fixtures OK (0 unresolved, fastCast=686)`);
  process.exit(0);
} else {
  console.error(`\nFAILED — ${failures} assertion(s)`);
  process.exit(1);
}
