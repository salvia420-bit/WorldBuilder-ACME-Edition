// WS07 (2026-07-12) — pins the REMOTE-caster render link coverage (F5) at the
// DATA level (no wasm/browser needed).
//
//   F5: EVERY magic gesture a remote observer can be handed renders IFF the
//       player MotionTable's Magic stance (0x49) links it from-Ready (0x03):
//         - green windups  0x1000006F..0x10000078  (KIND_MOTION_ACTION, F4)
//         - purple band    0x1000012B..0x10000134  (KIND_MOTION_ACTION, F4)
//         - final gestures 0x4000002B..0x40000039  (KIND_MOTION,        F3)
//       A DAT swap that drops any of these silently breaks remote casting.
//   F3/F4 class partition: windups carry the Action class (0x10000000) and
//       route through _armMotionAction; the finals carry the SubState class
//       (0x40000000) and route through _armMotion — both terminate at
//       setMotion's cast branch. This test asserts the class split so the two
//       surfacing routes stay distinct.
//
// Fixture = tests/fixtures/ws01_player_mt_fromReady.json (SHARED with WS01,
// captured from the DAT oracle: player MT 0x09000001, links[(0x49<<16)|0x03]
// inner motionData keys). WS07 scopes its assertions to the REMOTE-path
// command ranges to avoid duplicating WS01's local-windup coverage.
//
// Run: node tests/test_ws07_remote_cast_links.mjs   (from apps/holtburger-web/)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const fix = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/ws01_player_mt_fromReady.json"), "utf8"),
);
const magic = new Set(fix.magicStance_0x49.map((s) => parseInt(s, 16) >>> 0));

const hex = (n) => "0x" + (n >>> 0).toString(16);

// Build the three REMOTE-path command bands as full 32-bit MotionCommands.
const range = (cls, lo, hi) => {
  const out = [];
  for (let low = lo; low <= hi; low++) out.push((cls | low) >>> 0);
  return out;
};
const greenWindups = range(0x10000000, 0x6f, 0x78); // MagicPowerUp01..10
const purpleWindups = range(0x10000000, 0x12b, 0x134); // MagicPowerUp01..10 Purple
const finalGestures = range(0x40000000, 0x2b, 0x39); // MagicBlast..MagicPray

let fail = 0;
const checkBand = (label, band) => {
  const miss = band.filter((c) => !magic.has(c >>> 0));
  if (miss.length) {
    fail++;
    console.log(`FAIL ${label}: unlinked from-Ready in Magic (0x49):`, miss.map(hex));
  } else {
    console.log(`PASS ${label}: all ${band.length} linked from-Ready in Magic (0x49).`);
  }
};

// F5 — remote-path link coverage.
checkBand("green windups 0x1000006F..78", greenWindups);
checkBand("purple windups 0x1000012B..134", purpleWindups);
checkBand("final gestures 0x4000002B..39", finalGestures);

// F3/F4 — class partition: the two surfacing routes must not overlap.
const badWindupClass = [...greenWindups, ...purpleWindups].filter(
  (c) => (c & 0xf0000000) >>> 0 !== 0x10000000,
);
const badFinalClass = finalGestures.filter((c) => (c & 0xf0000000) >>> 0 !== 0x40000000);
if (badWindupClass.length || badFinalClass.length) {
  fail++;
  console.log("FAIL class partition:", { badWindupClass: badWindupClass.map(hex), badFinalClass: badFinalClass.map(hex) });
} else {
  console.log(
    "PASS class partition: windups are Action-class 0x10 (KIND_MOTION_ACTION), finals are SubState-class 0x40 (KIND_MOTION).",
  );
}

// Sanity: the specific gestures the packet + WS07 capture recipe reference.
for (const [id, label] of [
  [0x1000006f, "MagicPowerUp01 (first green windup)"],
  [0x10000132, "MagicPowerUp08Purple (void windup)"],
  [0x4000002b, "MagicBlast (war final gesture)"],
  [0x40000035, "MagicTransfer"],
  [0x40000039, "MagicPray (last final gesture)"],
]) {
  if (!magic.has(id >>> 0)) {
    fail++;
    console.log(`FAIL: expected ${label} ${hex(id)} in Magic from-Ready`);
  }
}

console.log(fail ? "FAIL" : "ALL PASS");
process.exit(fail ? 1 : 0);
