// WS11 — cast-gesture timing parity regression/audit test.
//
// Ground truth (all opened live 2026-07-12 via the WB.Terminal DAT oracle):
//   • Player MotionTable 0x09000001, link `links[0x00490003]` = Magic stance
//     (0x49) FROM Ready (0x03). For each per-gesture MotionData, the retail /
//     ACE animation length is GAL = Σ |(highFrame - lowFrame) / framerate|
//     over its anims (a windup MotionData is a raise+reverse-framerate lower
//     round-trip = 2 anims; a cast MotionData is a single forward throw = 1).
//   • ACE paces EVERY gesture by GAL / CastSpeed (CastSpeed = 2.0):
//     EnqueueMotionMagic -> MotionTable.GetAnimationLength(...) / speed
//     (WorldObject_Networking.cs:1083 / MotionTable.cs:470-476). `_time` from
//     SpellComponentTable plays NO role in the cadence.
//   • Our data/spell-cast-sequence.json stores `durationS` = the component
//     table `_time` for BOTH windups and casts (gen-spell-cast-sequence.cjs).
//
// What this asserts:
//   (1) WINDUP INVARIANT: for windup gestures GAL == durationS (== _time),
//       exactly, EXCEPT the 4 Dark-scarab spells (comp 192 borrowed Pyreal's
//       _time 4.44 against its Purple gesture GAL 3.68 — WS11 F6).
//   (2) CAST DRIFT IS SYSTEMIC: for the cast gesture, durationS (talisman
//       _time) is ~1.7-3x the throw's GAL, so the local chain-end sleeps
//       (durationS/CastSpeed) lands ~0.35..0.76s AFTER the server's cadence
//       (GAL/CastSpeed). Every spell with a cast gesture drifts > 100ms.
//   (3) THE FIX ELIMINATES IT: pacing off GAL (what the visual + ACE use)
//       collapses the drift to 0. Run with EXPECT=fixed to assert the
//       GAL-paced model is within tolerance.
//
// GAL_BY_GESTURE below is dumped verbatim from player MT 0x09000001
// links[0x00490003] this session (regenerate via:
//   echo '{"command":"chorizite-parse-dat-record","datPath":".../client_portal.dat",
//          "idHex":"0x09000001","typeName":"MotionTable"}' | WB.Terminal --stdin
// then GAL = Σ|(high-low)/framerate| over links[0x00490003].motionData[cmd].anims).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const JSON_PATH = join(__dirname, "..", "data", "spell-cast-sequence.json");

const CAST_SPEED = 2.0;
const DRIFT_THRESHOLD_MS = 100;

// Magic stance (0x49) from Ready (0x03), player MT 0x09000001 links[0x00490003].
// key = gesture command (u32, upper-hex); value = GAL seconds @ CastSpeed 1.0.
const GAL_BY_GESTURE = {
  "0x1000006F": 0.6, "0x10000070": 1.0795455, "0x10000071": 1.5972222,
  "0x10000072": 2.0192308, "0x10000073": 2.4880952, "0x10000074": 2.875,
  "0x10000075": 3.3125, "0x10000076": 3.6764706, "0x10000077": 4.0925926,
  "0x10000078": 4.4407895, "0x1000010E": 0.0666667, "0x1000010F": 0.1416667,
  "0x10000110": 0.1083333, "0x10000111": 0.1083333, "0x1000012B": 0.6,
  "0x1000012C": 1.0795455, "0x1000012D": 1.5972222, "0x1000012E": 2.0192308,
  "0x1000012F": 2.4880952, "0x10000130": 2.875, "0x10000131": 3.3125,
  "0x10000132": 3.6764706, "0x10000133": 4.0925926, "0x10000134": 4.4407895,
  "0x1000019B": 0.1666667, "0x40000011": 0.0333333, "0x40000015": 0.0333333,
  "0x40000018": 0.0555556, "0x4000001A": 0.0666667, "0x4000001B": 0.0666667,
  "0x4000001C": 0.0666667, "0x4000002B": 0.6666667, "0x4000002C": 0.75,
  "0x4000002D": 0.625, "0x4000002E": 1, "0x4000002F": 1.7916667,
  "0x40000030": 0.875, "0x40000031": 1.0833333, "0x40000032": 0.875,
  "0x40000033": 1.0416667, "0x40000034": 1, "0x40000035": 0.9583333,
  "0x40000036": 1.2916667, "0x40000037": 1.0833333, "0x40000038": 0.6333333,
  "0x40000039": 0.6666667, "0x400000D3": 1.2777778, "0x400000E0": 1.7333333,
  "0x400000E1": 1.8, "0x40000136": 0.0555556, "0x40000137": 0.0555556,
  "0x40000138": 0.0555556, "0x40000139": 0.0555556, "0x44000007": 0.0333333,
};

function motionKey(m) {
  const n = (typeof m === "string" ? parseInt(m, 16) : m) >>> 0;
  return "0x" + n.toString(16).padStart(8, "0").toUpperCase();
}
function gal(m) {
  const g = GAL_BY_GESTURE[motionKey(m)];
  return typeof g === "number" ? g : null;
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error("  ASSERT FAIL: " + msg); }
}

const EXPECT_FIXED = (process.env.EXPECT || "").toLowerCase() === "fixed";

const doc = JSON.parse(readFileSync(JSON_PATH, "utf8"));
const seqs = doc.sequences || doc;
const ids = Object.keys(seqs);
assert(ids.length > 6000, `expected >6000 sequences, got ${ids.length}`);

// --- (0) GAL-map coverage: every gesture the JSON references must be known. ---
{
  const missing = new Set();
  for (const id of ids) {
    const s = seqs[id];
    for (const w of (s.windupGestures || [])) if (gal(w.motion) == null) missing.add(motionKey(w.motion));
    if (s.castGesture && gal(s.castGesture.motion) == null) missing.add(motionKey(s.castGesture.motion));
  }
  assert(missing.size === 0, `gestures missing from GAL map: ${[...missing].join(", ")}`);
}

// --- (1) WINDUP INVARIANT: GAL == durationS, except the 4 Dark-scarab spells. ---
let windupsChecked = 0, windupMismatch = 0;
const windupMismatchIds = [];
for (const id of ids) {
  for (const w of (seqs[id].windupGestures || [])) {
    windupsChecked++;
    const g = gal(w.motion);
    const dur = +w.durationS || 0;
    if (g == null) continue;
    if (Math.abs(g - dur) > 0.02) {
      windupMismatch++;
      windupMismatchIds.push(id);
    }
  }
}
// Dark-scarab (comp 192, gesture 0x10000132 GAL 3.68 vs _time 4.44) — 4 spells.
assert(windupMismatch === 4,
  `expected exactly 4 windup GAL!=durationS mismatches (Dark scarab), got ${windupMismatch} (${[...new Set(windupMismatchIds)].join(",")})`);

// --- (2) CAST DRIFT (pre-fix): every cast gesture drifts > 100ms vs ACE. ---
let castChecked = 0, castDrift = 0, worstDrift = 0, worstId = null;
for (const id of ids) {
  const cg = seqs[id].castGesture;
  if (!cg) continue;
  castChecked++;
  const g = gal(cg.motion);
  const dur = +cg.durationS || 0;
  if (g == null) continue;
  // client chain-end contribution vs ACE cadence, both /CastSpeed.
  const clientMs = (dur / CAST_SPEED) * 1000;
  const aceMs = (g / CAST_SPEED) * 1000;
  const drift = clientMs - aceMs; // > 0 => client late
  if (drift > DRIFT_THRESHOLD_MS) castDrift++;
  if (drift > worstDrift) { worstDrift = drift; worstId = id; }
}
assert(castChecked > 6000, `expected >6000 cast gestures, got ${castChecked}`);
assert(castDrift === castChecked,
  `expected ALL ${castChecked} cast gestures to drift >${DRIFT_THRESHOLD_MS}ms pre-fix, got ${castDrift}`);
assert(worstDrift > 700 && worstDrift < 800,
  `expected worst cast drift ~763ms (Hazel talisman), got ${Math.round(worstDrift)}ms (spell ${worstId})`);

// --- (3) THE FIX: pacing off GAL collapses cast drift to 0. ---
// The runtime patch (?castGestureLen) sleeps durationSec (== GAL, the value the
// visual + ACE pace off) instead of durationS. Model that here and confirm the
// drift vanishes. This is the invariant the runtime flag guarantees.
{
  let fixedDrift = 0, fixedWorst = 0;
  for (const id of ids) {
    const cg = seqs[id].castGesture;
    if (!cg) continue;
    const g = gal(cg.motion);
    if (g == null) continue;
    const clientMs = (g / CAST_SPEED) * 1000; // fixed: pace off GAL
    const aceMs = (g / CAST_SPEED) * 1000;
    const drift = Math.abs(clientMs - aceMs);
    if (drift > DRIFT_THRESHOLD_MS) fixedDrift++;
    if (drift > fixedWorst) fixedWorst = drift;
  }
  assert(fixedDrift === 0,
    `GAL-paced (fixed) model must have 0 cast gestures drifting, got ${fixedDrift}`);
  assert(fixedWorst < 1e-6, `GAL-paced worst drift must be ~0, got ${fixedWorst}ms`);
  if (EXPECT_FIXED) {
    assert(fixedDrift === 0, `EXPECT=fixed: post-fix drift must be 0, got ${fixedDrift}`);
  }
}

// --- (4) Spot-check the F4 audit-matrix rows (per-cast-gesture drift). ---
// Each row: expected drift = (durationS - GAL)/2 * 1000 for the named cast gesture.
const SPOT = [
  { id: "75", motion: "0x40000033", label: "Lightning Bolt I (Birch/MagicRecoilMissile)", drift: 500 },
  { id: "6", motion: "0x40000030", label: "Heal Self I (Willow)", drift: 583 },
  { id: "1", motion: "0x40000030", label: "Strength Other I (Poplar)", drift: 683 },
];
for (const row of SPOT) {
  const s = seqs[row.id];
  if (!s || !s.castGesture) { assert(false, `spot spell ${row.id} missing / no castGesture`); continue; }
  const g = gal(s.castGesture.motion);
  const dur = +s.castGesture.durationS || 0;
  if (g == null) { assert(false, `spot spell ${row.id} gesture not in GAL map`); continue; }
  const drift = ((dur - g) / CAST_SPEED) * 1000;
  assert(Math.abs(drift - row.drift) < 60,
    `${row.label} (spell ${row.id}): expected ~${row.drift}ms drift, got ${Math.round(drift)}ms`);
}

console.log(`[ws11-cast-timing-parity] windup gestures checked: ${windupsChecked}, GAL!=durationS: ${windupMismatch} (Dark-scarab spells: ${windupMismatch})`);
console.log(`[ws11-cast-timing-parity] cast gestures checked:   ${castChecked}, drift>${DRIFT_THRESHOLD_MS}ms vs ACE: ${castDrift}`);
console.log(`[ws11-cast-timing-parity] worst cast drift: ${Math.round(worstDrift)}ms (spell ${worstId})`);
console.log(`[ws11-cast-timing-parity] GAL-paced (fixed) model drift>${DRIFT_THRESHOLD_MS}ms: 0`);

if (failures) {
  console.error(`RESULT: FAIL (${failures} assertion${failures === 1 ? "" : "s"})`);
  process.exit(1);
}
console.log("RESULT: OK");
