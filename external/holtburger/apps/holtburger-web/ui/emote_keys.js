// ui/emote_keys.js — input-options-5 (2026-10-13): retail's emote and
// posture keys.
//
// ACCmdInterp::OnAction (acclient.c:435951) sends every InputAction outside
// its movement switch to the emote hash (InitializeEmoteInputActionHash
// :436034, 91 pairs) and plays the hashed motion with SetMotion(cmd, 1). The
// hash lives wasm-side in the retail CommandInterpreter
// (crates/holtburger-core/src/client/movement/command_interpreter.rs
// `EMOTE_INPUT_ACTION_IDS`); this module binds the keys. Each of the 91
// actions is an input-funnel action keyed by its retail ClientAction id
// ("0x10000096" …), so its Options → Controls row goes live through
// ui/keymap.js `retailActionStatus` and can be rebound there. A press calls
// `handle.handleKeyAction(id, true)`. Retail's hash arm ignores fStart (a
// release would play the motion again), so releases are not forwarded, and
// the funnel already drops OS autorepeat.
//
// Defaults are retail's gmDefaultMap (portal.dat 0x14000000), all free in
// this client's layout:
//   Movement map 0x4         Ready Y · Crouch H · Sitting (Sit) G ·
//                            Sleeping (Lay Down) B
//   Emotes map 0x10000006    Cheer O · Cry U · Laugh I · PointState K ·
//                            Wave J
// The other 82 emotes start unbound (no retail default) but are bindable.
//
// `?emoteKeys` is DEFAULT-OFF for now (`=on` opts in; `=off` will be the
// escape once it flips). The interpreter dispatches the motion, but the
// movement system's cmdInterp send path carries locomotion only:
// SystemInterpreterSeams::apply_axis (system.rs) and
// build_raw_state_raw_motion_state (common.rs, "FU6: a stored substate …
// the raw send omits the forward fields") drop a posture/emote command, and
// an action emote runs StopCompletely first. So, with the flag on, G does not
// sit and O stops you without cheering. Flip EMOTE_KEYS_DEFAULT_ON once that
// path sends the forward substate and the action list.
//
// The emote hash exists only in the `?cmdInterp` lane (default on);
// `?cmdInterp=off` binds nothing here, because the legacy lane has no
// interpreter to receive the ids. A stale pkg/ without handleKeyAction does
// nothing.
//
// No DOM / three.js dependency at import time — unit-testable under node.

import { retailActionBindingId } from "./keymap.js";

/** `?emoteKeys` value when the param is absent (see the header). */
export const EMOTE_KEYS_DEFAULT_ON = false;

/**
 * `?emoteKeys`: `on`/`1`/`true` binds the keys, `off`/`0`/`false` binds
 * nothing, absent = EMOTE_KEYS_DEFAULT_ON. Never throws.
 */
export function emoteKeysOn(search) {
  try {
    const s =
      typeof search === "string"
        ? search
        : typeof window !== "undefined" && window.location
        ? window.location.search
        : "";
    const v = new URLSearchParams(s).get("emoteKeys");
    if (v == null) return EMOTE_KEYS_DEFAULT_ON;
    const lc = v.toLowerCase();
    if (lc === "on" || lc === "1" || lc === "true") return true;
    if (lc === "off" || lc === "0" || lc === "false") return false;
    return EMOTE_KEYS_DEFAULT_ON;
  } catch (_) {
    return EMOTE_KEYS_DEFAULT_ON;
  }
}

const row = (action, name, defaultBinding) => Object.freeze({ action, name, defaultBinding });

/**
 * The emote hash's InputActions in retail insertion order, row for row with
 * command_interpreter.rs `EMOTE_INPUT_ACTION_IDS` (`name` = the acclient.c
 * symbol). `defaultBinding` = the gmDefaultMap key, or null.
 */
export const EMOTE_KEY_ACTIONS = Object.freeze([
  row(0x10000094, "Ready", "KeyY"),
  row(0x10000095, "Crouch", "KeyH"),
  row(0x10000096, "Sitting", "KeyG"),
  row(0x10000097, "Sleeping", "KeyB"),
  row(0x100000CF, "ShakeFistState", null),
  row(0x100000C7, "PrayState", null),
  row(0x100000A1, "BowDeepState", null),
  row(0x100000A4, "ClapHandsState", null),
  row(0x100000A6, "CrossArmsState", null),
  row(0x100000D2, "ShiverState", null),
  row(0x100000BE, "PointState", "KeyK"),
  row(0x100000E6, "WaveState", null),
  row(0x1000009B, "AkimboState", null),
  row(0x100000CA, "SaluteState", null),
  row(0x100000CD, "ScratchHeadState", null),
  row(0x100000E1, "TapFootState", null),
  row(0x100000B3, "LeanState", null),
  row(0x100000B0, "KneelState", null),
  row(0x100000BC, "PleadState", null),
  row(0x1000009A, "ATOYOT", null),
  row(0x100000D9, "SlouchState", null),
  row(0x100000DE, "SurrenderState", null),
  row(0x100000EC, "WoahState", null),
  row(0x100000EA, "WindedState", null),
  row(0x100000DB, "SnowAngelState", null),
  row(0x100000A8, "CurtseyState", null),
  row(0x10000098, "AFKState", null),
  row(0x100000B4, "MeditateState", null),
  row(0x100000D5, "SitState", null),
  row(0x100000D7, "SitCrossleggedState", null),
  row(0x100000D6, "SitBackState", null),
  row(0x100000C2, "PointLeftState", null),
  row(0x100000C4, "PointRightState", null),
  row(0x100000DF, "TalktotheHandState", null),
  row(0x100000C0, "PointDownState", null),
  row(0x100000AA, "DrudgeDanceState", null),
  row(0x100000C5, "PossumState", null),
  row(0x100000C8, "ReadState", null),
  row(0x100000E3, "ThinkerState", null),
  row(0x100000AC, "HaveASeatState", null),
  row(0x1000009C, "AtEaseState", null),
  row(0x100000A2, "Cheer", "KeyO"),
  row(0x100000A7, "Cry", "KeyU"),
  row(0x100000CE, "ShakeFist", null),
  row(0x1000009D, "Beckon", null),
  row(0x1000009E, "BeSeeingYou", null),
  row(0x1000009F, "BlowKiss", null),
  row(0x100000A0, "BowDeep", null),
  row(0x100000A3, "ClapHands", null),
  row(0x100000B2, "Laugh", "KeyI"),
  row(0x100000B6, "MimeEat", null),
  row(0x100000B5, "MimeDrink", null),
  row(0x100000B8, "Nod", null),
  row(0x100000BD, "Point", null),
  row(0x100000D0, "ShakeHead", null),
  row(0x100000D4, "Shrug", null),
  row(0x100000E5, "Wave", "KeyJ"),
  row(0x10000099, "Akimbo", null),
  row(0x100000AD, "HeartyLaugh", null),
  row(0x100000C9, "Salute", null),
  row(0x100000CC, "ScratchHead", null),
  row(0x100000DA, "SmackHead", null),
  row(0x100000E0, "TapFoot", null),
  row(0x100000E8, "WaveHigh", null),
  row(0x100000E7, "WaveLow", null),
  row(0x100000ED, "YawnStretch", null),
  row(0x100000A5, "Cringe", null),
  row(0x100000AF, "Kneel", null),
  row(0x100000BB, "Plead", null),
  row(0x100000D1, "Shiver", null),
  row(0x100000D3, "Shoo", null),
  row(0x100000D8, "Slouch", null),
  row(0x100000DC, "Spit", null),
  row(0x100000DD, "Surrender", null),
  row(0x100000EB, "Woah", null),
  row(0x100000E9, "Winded", null),
  row(0x100000EE, "YMCA", null),
  row(0x100000C6, "Pray", null),
  row(0x100000B7, "Mock", null),
  row(0x100000E2, "Teapot", null),
  row(0x100000E4, "WarmHands", null),
  row(0x100000B9, "NudgeLeft", null),
  row(0x100000BA, "NudgeRight", null),
  row(0x100000C1, "PointLeft", null),
  row(0x100000C3, "PointRight", null),
  row(0x100000BF, "PointDown", null),
  row(0x100000B1, "Knock", null),
  row(0x100000CB, "ScanHorizon", null),
  row(0x100000A9, "DrudgeDance", null),
  row(0x100000AB, "HaveASeat", null),
  row(0x100000AE, "Helper", null),
]);

/**
 * Bind every EMOTE_KEY_ACTIONS row on `funnel` under its retail id.
 *
 * @param {{bindAction: Function}} funnel  ui/input-funnel.js InputFunnel
 * @param {{getHandle?: () => object|null, cmdInterpOn?: boolean,
 *   search?: string}} [opts]  `getHandle` returns the live SessionHandle;
 *   `cmdInterpOn` is index.html's CMD_INTERP_ON (false binds nothing);
 *   `search` overrides location.search.
 * @returns {() => void} unbind all
 */
export function installEmoteKeys(funnel, opts = {}) {
  if (!funnel || typeof funnel.bindAction !== "function") return () => {};
  if (opts.cmdInterpOn !== true) return () => {};
  if (!emoteKeysOn(opts.search)) return () => {};
  const getHandle = typeof opts.getHandle === "function" ? opts.getHandle : () => null;
  const unbinds = [];
  for (const r of EMOTE_KEY_ACTIONS) {
    unbinds.push(funnel.bindAction(retailActionBindingId(r.action), r.defaultBinding, () => {
      const handle = getHandle();
      if (!handle || typeof handle.handleKeyAction !== "function") return;
      try {
        handle.handleKeyAction(r.action, true);
      } catch (e) {
        console.warn(`[emoteKeys] ${r.name} handleKeyAction failed:`, e);
      }
    }, { source: "emote" }));
  }
  return () => {
    for (const off of unbinds) {
      try { off?.(); } catch (_) { /* keep unbinding the rest */ }
    }
    unbinds.length = 0;
  };
}
