// WS01 (2026-07-12) — proves F1 + F3 at the DATA level (no wasm/browser needed).
//
//   F1: EVERY gesture the cast-sequence JSON can emit is linked from-Ready in the
//       player MotionTable's Magic stance (0x49) — S1a ("unlinked windup") REFUTED.
//   F3: ZERO of those magic gestures resolve under NonCombat (0x3d) from-Ready — a
//       stale/NonCombat stance is therefore a HARD silent miss (the RC-2 mechanism).
//
// Fixture = tests/fixtures/ws01_player_mt_fromReady.json, captured from the DAT
// oracle (player MT 0x09000001, links[(stance<<16)|Ready(0x3)] inner keys). Regen
// recipe is in the WS01 packet §4.3 (magic=54 keys, nonCombat=125 keys).
//
// Run: node tests/test_ws01_windup_link_coverage.mjs   (from apps/holtburger-web/)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const seqs = JSON.parse(fs.readFileSync(path.join(ROOT, "data/spell-cast-sequence.json"), "utf8")).sequences;
const fix = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/ws01_player_mt_fromReady.json"), "utf8"));

const magic = new Set(fix.magicStance_0x49.map((s) => parseInt(s, 16) >>> 0));
const noncombat = new Set(fix.nonCombatStance_0x3d.map((s) => parseInt(s, 16) >>> 0));

const norm = (m) => {
  const s = String(m);
  return (s.toLowerCase().startsWith("0x") ? parseInt(s, 16) : parseInt(s, 10)) >>> 0;
};

// Extract every distinct motion the JSON can emit (all windups + every cast gesture).
const emitted = new Set();
for (const e of Object.values(seqs)) {
  for (const wg of e.windupGestures || []) if (wg.motion != null) emitted.add(norm(wg.motion));
  if (e.castGesture?.motion != null) emitted.add(norm(e.castGesture.motion));
}

let fail = 0;

// F1 — all emitted gestures linked from-Ready in Magic.
const missMagic = [...emitted].filter((m) => !magic.has(m));
if (missMagic.length) {
  fail++;
  console.log("FAIL unlinked in Magic:", missMagic.map((m) => "0x" + m.toString(16)));
} else {
  console.log(`PASS: all ${emitted.size} emitted gestures are linked from-Ready in Magic stance (0x49).`);
}

// F3 — 0 of the emitted MAGIC-class gestures (0x1xxxxxxx windups / 0x4xxxxxxx casts)
// resolve under NonCombat from-Ready.
const magicClass = [...emitted].filter(
  (m) => (m & 0xf0000000) === 0x10000000 || (m & 0xf0000000) === 0x40000000,
);
const ncResolvable = magicClass.filter((m) => noncombat.has(m));
if (ncResolvable.length) {
  fail++;
  console.log("FAIL magic resolves under NonCombat:", ncResolvable.map((m) => "0x" + m.toString(16)));
} else {
  console.log(`PASS: 0 of ${magicClass.length} emitted magic gestures resolve under NonCombat (0x3d) — stance mismatch = silent miss, confirmed.`);
}

// Sanity: the void Purple windup (0x10000132) and the talisman cast band must be present.
for (const [id, label] of [[0x10000132, "MagicPowerUp08Purple (void)"], [0x40000035, "MagicTransfer"], [0x4000002b, "MagicBlast"]]) {
  if (!magic.has(id >>> 0)) { fail++; console.log(`FAIL: expected ${label} 0x${id.toString(16)} in Magic from-Ready`); }
}

console.log(fail ? "FAIL" : "ALL PASS");
process.exit(fail ? 1 : 0);
