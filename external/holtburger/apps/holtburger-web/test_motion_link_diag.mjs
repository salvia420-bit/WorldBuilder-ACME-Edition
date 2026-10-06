// 2026-10-06 — scene3d/motion_link_diag.js: the "[motion-link] no MotionTable link" warning fires
// only for a real swing / cast, not for the NPC idle fidgets (Twitch1-4), emotes, FallDown, Jump or
// recalls that ride the same one-shot link path and legitimately have no link in many tables.
// Command values: external/ACE/Source/ACE.Entity/Enum/MotionCommand.cs.
//
// Run:
//   cd apps/holtburger-web/
//   node test_motion_link_diag.mjs

import { linkMissIsDefect } from "./scene3d/motion_link_diag.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

// the low-16 values entities.js keeps in ATTACK_COMMANDS / CAST_COMMANDS (subset + the jumps)
const ATTACK = new Set([0x0058, 0x0059, 0x005a, 0x005b, 0x005c, 0x005d, 0x0061, 0x0062, 0x00d0, 0x018f, 0x003b, 0x001d]);
const CAST = new Set([0x002b, 0x002c, 0x0033, 0x006f, 0x00d3]);
const defect = (c) => linkMissIsDefect(c, ATTACK, CAST);

console.log("real swings and casts still warn");
for (const [name, c] of [["ThrustLow", 0x10000059], ["SlashHigh", 0x1000005b], ["Shoot", 0x10000061], ["AttackHigh1", 0x10000062],
  ["MissileAttack1", 0x100000d0], ["PunchFastHigh", 0x1000018f], ["MagicBlast", 0x4000002b], ["MagicSelfHead", 0x4000002c],
  ["MagicRecoilMissile", 0x40000033], ["CastSpell", 0x400000d3], ["SpecialAttack1", 0x100000cd], ["DoubleSlashLow", 0x1000011f],
  ["TripleThrustHigh", 0x1000012a], ["bare low-16 thrust", 0x0059]]) {
  check(name, defect(c) === true, `0x${c.toString(16)}`);
}

console.log("\nno warning where a missing link is normal");
for (const [name, c] of [["Twitch1 (the remote console's 0x10000051)", 0x10000051], ["Twitch2", 0x10000052], ["Twitch3", 0x10000053],
  ["Twitch4", 0x10000054], ["FallDown", 0x10000050], ["Jump (in no retail table)", 0x2500003b], ["JumpCharging", 0x4000001d],
  ["QuickEmote sharing a thrust's low 16", 0x13000059], ["a QuickEmote", 0x13000042], ["Ready", 0x41000003],
  ["OnCreation ambient", 0x1000009e], ["HouseRecall", 0x1000013a]]) {
  check(name, defect(c) === false, `0x${c.toString(16)}`);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
