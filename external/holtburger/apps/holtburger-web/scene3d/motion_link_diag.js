// scene3d/motion_link_diag.js — which missing MotionTable links deserve a console warning
// (2026-10-06).
//
// entities.js `_tryPlayLink` routes every one-shot through the MotionTable LINK lookup: swings and
// casts, but also emotes, reactions, interactions, idle ambients, FallDown, Jump, recalls and — via
// the class-byte fallback (`?mtClassFallback`, default on) — any other Action (0x10) or ChatEmote
// (0x13) command, such as the NPC idle fidgets Twitch1-4 (0x10000051-54). For most of those a missing
// link is normal: the human MotionTable 0x09000001 has no Twitch animation at all, and Jump (0x3B) is
// absent from every retail motion table, so retail plays nothing for them either. The old diag
// warned for everything routed as "attack", so a remote console filled with "no MotionTable link
// for attack 0x10000053 … swing/cast/eat will not play" for NPC fidgets.
//
// A miss is a DEFECT only for a real swing or cast: the commands in entities.js ATTACK_COMMANDS /
// CAST_COMMANDS (minus Jump / JumpCharging) plus the creature special attacks (0xCD-0xCF) and the
// multi-strike chains (0x11F-0x12A), with an Action (0x10) or Modifier (0x40) class byte or a bare
// low-16 command. A QuickEmote (0x13) sharing an attack's low 16 bits is not a swing.

const JUMP_LOW = 0x003b;
const JUMP_CHARGING_LOW = 0x001d;

/**
 * Is a missing MotionTable link for `cmd` a real defect worth a console warning?
 * @param {number} cmd full 32-bit MotionCommand (or a bare low-16 command)
 * @param {Set<number>} attackLow entities.js ATTACK_COMMANDS (low-16 values)
 * @param {Set<number>} castLow entities.js CAST_COMMANDS (low-16 values)
 */
export function linkMissIsDefect(cmd, attackLow, castLow) {
  const c = cmd >>> 0;
  const cls = c >>> 24;
  if (cls !== 0x00 && cls !== 0x10 && cls !== 0x40) return false;
  const low = c & 0xffff;
  if (low === JUMP_LOW || low === JUMP_CHARGING_LOW) return false;
  if ((attackLow && attackLow.has(low)) || (castLow && castLow.has(low))) return true;
  return (low >= 0x00cd && low <= 0x00cf) || (low >= 0x011f && low <= 0x012a);
}
