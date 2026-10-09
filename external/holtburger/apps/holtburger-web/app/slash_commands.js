// app/slash_commands.js — retail chat-command routing: the sticky tell
// targets (window.__chatLastIncomingTellSender / __chatLastOutgoingTellTarget),
// the retail comma-tell parser, the tell/reply/retell/say alias sets and
// routeSlashCommand(handle, message) (slash command -> wire GameAction, or
// fall-through to sendChat), plus their window.__parseCommaTell /
// window.__routeSlashCommand exposures.
//
// Moved VERBATIM out of index.html's login handler (2026-10-05). index.html
// calls initSlashCommands() once per login at the point this code used to run
// (so the sticky tell targets are reset per session exactly as before); the
// chat form's submit listener stays in index.html and calls the returned
// routeSlashCommand / routePublicChat.
//
// R-chat (round 2, 2026-10-08) — retail ClientCommunicationSystem parity:
//   chat-1  Turbine room ids are retail ChatTypeEnum (acclient.h:4464:
//           Allegiance=1 General=2 Trade=3 LFG=4 Roleplay=5 Society=6 …
//           Olthoi=10) with the StartupTurbineChatSystem aliases
//           (acclient.c:424334); `/a` `/guild` `/gu` use the Turbine
//           Allegiance room, `/ab` the legacy Allegiance Broadcast.
//   chat-3  NO local echo for anything the server echoes back (say, tell,
//           channel, Turbine, /me) — retail's Do* send paths add no text;
//           the server copy is worded on receipt (wasm chat_format.rs).
//           Only the soul-emote `You …` line stays local (retail Pose).
//   chat-4  OnChatCommand (acclient.c:426126) prefixes: `/` and `@` are
//           command prefixes, but `@` reroutes ONLY retail client verbs (any
//           other `@line` goes to the server verbatim); `:` / `;` = emote.
//           Verbs match case-insensitively with a trailing `,` trimmed
//           (DoCommand :423537); the InitializeCommands aliases (:426432);
//           plain speech runs PublicChat (:426025) — inline `*pose*` /
//           `<pose>` tokens soul-emote and drop out of the spoken text.
//   chat-5  /reply uses the retail DoReply strings (:417665).
//
// social-lists-1 (round 4, 2026-10-08): the retail client verbs friends /
// friends_add / friends_remove / squelch / unsquelch / filter / unfilter /
// messagetypes run locally (app/social_commands.js) instead of going to
// the server as `@verb` (vanilla ACE has none of them). `?retailSocialCmds=off`
// restores the forward.

import { CHAT_CATEGORY } from "./chat_log.js";
import { SOCIAL_CLIENT_VERBS, runSocialCommand, retailSocialCmdsEnabled } from "./social_commands.js";

// ── Retail command tables ─────────────────────────────────────────────────
// Retail aliased the tell verb five ways (tell/t/send/whisper/w → DoTell).
// acclient.c:428178-428288.
export const TELL_ALIASES = new Set(["tell", "t", "send", "whisper", "w"]);
export const REPLY_ALIASES = new Set(["reply", "r", "rp"]);
export const RETELL_ALIASES = new Set(["retell", "rt"]);
// Local speech aliases. Strip the slash-prefix and dispatch through the
// Talk path (ACE's GameActionTalk does not parse client slash commands).
export const SAY_ALIASES = new Set(["say", "s"]);
// InitializeCommands: e / em / emote / me → DoEmote (GameAction::Emote).
export const EMOTE_ALIASES = new Set(["e", "em", "emote", "me"]);

const CH_HELP = 0x00000400;
const CH_FELLOW = 0x00000800;
const CH_VASSALS = 0x00001000;
const CH_PATRON = 0x00002000;
const CH_MONARCH = 0x00004000;
const CH_COVASSALS = 0x01000000;
const CH_ALLEGIANCE_BROADCAST = 0x02000000;

// Legacy channels (ChatChannel ids, crates/holtburger-protocol chat/types.rs).
// Retail InitializeCommands maps these verbs to DoStupidChannelHack and
// ChannelSystem::GetChannelID (acclient.c:507159) picks the channel; `ab` is
// DoAllegianceBroadcast. `a` is NOT here: it is the Turbine Allegiance room.
export const CHANNEL_MAP = Object.freeze({
  c: CH_COVASSALS, covassal: CH_COVASSALS, covassals: CH_COVASSALS, "co-vassals": CH_COVASSALS,
  f: CH_FELLOW, fellow: CH_FELLOW, fellows: CH_FELLOW, fellowship: CH_FELLOW,
  g: CH_FELLOW, group: CH_FELLOW, party: CH_FELLOW,
  m: CH_MONARCH, monarch: CH_MONARCH,
  p: CH_PATRON, patron: CH_PATRON,
  v: CH_VASSALS, vassal: CH_VASSALS, vassals: CH_VASSALS,
  ab: CH_ALLEGIANCE_BROADCAST,
  // holtburger extras (not retail verbs, so an `@` line never reroutes them).
  co: CH_COVASSALS, cv: CH_COVASSALS, h: CH_HELP,
});
const NON_RETAIL_CHANNEL_VERBS = new Set(["co", "cv", "h"]);

// Turbine rooms: `type` is the TurbineChatType / retail ChatTypeEnum value
// SessionHandle.sendTurbineChannel resolves to the advertised room id.
const T_ALLEGIANCE = Object.freeze({ type: 1, label: "Allegiance" });
const T_GENERAL = Object.freeze({ type: 2, label: "General" });
const T_TRADE = Object.freeze({ type: 3, label: "Trade" });
const T_LFG = Object.freeze({ type: 4, label: "LFG" });
const T_ROLEPLAY = Object.freeze({ type: 5, label: "Roleplay" });
const T_SOCIETY = Object.freeze({ type: 6, label: "Society" });
const T_OLTHOI = Object.freeze({ type: 10, label: "Olthoi" });
export const TURBINE_CMDS = Object.freeze({
  a: T_ALLEGIANCE, guild: T_ALLEGIANCE, gu: T_ALLEGIANCE,
  cg: T_GENERAL, general: T_GENERAL,
  ct: T_TRADE, trade: T_TRADE,
  clfg: T_LFG, lfg: T_LFG,
  crp: T_ROLEPLAY, roleplay: T_ROLEPLAY,
  society: T_SOCIETY, soc: T_SOCIETY,
  olthoi: T_OLTHOI, o: T_OLTHOI,
});

// pk-4 (2026-10-08 round 5): retail's client-side PK commands
// (InitializeCommands, acclient.c:428736-429784). ACE has no text command of
// these names (it answers "Unknown command"); it implements only the
// GameActions, which retail's DoPKLite / DoPKArena / DoPKLArena send after
// their own checks (:420147 / :418546 / :418615).
const PK_VERB_BASE = Object.freeze({
  pklite: "pklite", pkl: "pklite",
  pkarena: "pkarena", pka: "pkarena",
  pklarena: "pklarena", pla: "pklarena",
});
export const PK_CLIENT_VERBS = Object.freeze(Object.keys(PK_VERB_BASE));
const ODF_PK = 0x20;
const ODF_PKLITE = 0x02000000;

/** `?retailPkCmds` — DEFAULT-ON; off keeps the old server forward. */
export function retailPkCmdsEnabled(search) {
  try {
    const s = search ?? globalThis.location?.search ?? "";
    const v = new URLSearchParams(s).get("retailPkCmds");
    return !(v === "off" || v === "0" || v === "false");
  } catch (_) { return true; }
}

/**
 * Retail DoPKLite / DoPKArena / DoPKLArena for the local player's LIVE
 * ODF: arguments → the help line; @pklite only for a Non-Player Killer
 * (IsPlayerKiller = PK or PK Lite → HandleFailureEvent 0x507);
 * @pkarena only for a PK (0x55F); @pklarena only for a PK Lite (0x560).
 * @returns {{send:"enterPkLite"|"teleToPkArena"|"teleToPklArena"} | {text:string} | null}
 *          null = not a PK verb.
 */
export function pkCommandDecision(verb, rest, odf) {
  const base = PK_VERB_BASE[String(verb ?? "").toLowerCase()];
  if (!base) return null;
  if (String(rest ?? "").trim()) {
    return { text: `Please see @help ${base} for more information on how to use this command.` };
  }
  const f = (odf >>> 0) || 0;
  if (base === "pklite") {
    return (f & (ODF_PK | ODF_PKLITE)) !== 0
      ? { text: "Only Non-Player Killers may enter PK Lite. Please see @help pklite for more details about this command." }
      : { send: "enterPkLite" };
  }
  if (base === "pkarena") {
    return (f & ODF_PK) === 0
      ? { text: "Only Player Killer characters may use this command!" }
      : { send: "teleToPkArena" };
  }
  return (f & ODF_PKLITE) === 0
    ? { text: "Only Player Killer Lite characters may use this command!" }
    : { send: "teleToPklArena" };
}

/** Verbs retail's client command table owns — the only `@` verbs rerouted. */
export const RETAIL_CLIENT_VERBS = new Set([
  ...TELL_ALIASES, ...REPLY_ALIASES, ...RETELL_ALIASES, ...SAY_ALIASES, ...EMOTE_ALIASES,
  ...Object.keys(CHANNEL_MAP).filter((v) => !NON_RETAIL_CHANNEL_VERBS.has(v)),
  ...Object.keys(TURBINE_CMDS),
  ...SOCIAL_CLIENT_VERBS,
  ...PK_CLIENT_VERBS,
]);

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Split a prefixed command line into `{ rawCmd, cmd, rest }`. `rawCmd` is the
 * lowercased first word; `cmd` additionally has a trailing `,` trimmed
 * (retail DoCommand); `rest` is everything after the first space.
 */
export function parseCommandLine(line) {
  const s = String(line ?? "");
  const sp = s.indexOf(" ");
  const rawCmd = (sp < 0 ? s.slice(1) : s.slice(1, sp)).toLowerCase();
  return { rawCmd, cmd: rawCmd.replace(/,+$/, ""), rest: sp < 0 ? "" : s.slice(sp + 1) };
}

/**
 * Retail OnChatCommand prefix handling. Returns `{ kind, line }`:
 *   "command" — a `/` line, an `@` line whose verb is a retail client verb
 *               (rewritten to `/`), or a `:` / `;` emote (rewritten to
 *               `/emote …`);
 *   "server"  — any other `@` line: sent to the server verbatim;
 *   "say"     — plain speech.
 */
export function normalizeChatLine(message) {
  const m = String(message ?? "");
  const c = m.charAt(0);
  if (c === ":" || c === ";") return { kind: "command", line: `/emote ${m.slice(1)}` };
  if (c === "/") return { kind: "command", line: m };
  if (c === "@") {
    const verb = parseCommandLine(m).cmd;
    const social = SOCIAL_CLIENT_VERBS.includes(verb);
    const pk = PK_CLIENT_VERBS.includes(verb);
    return RETAIL_CLIENT_VERBS.has(verb) && (!social || retailSocialCmdsEnabled())
        && (!pk || retailPkCmdsEnabled())
      ? { kind: "command", line: `/${m.slice(1)}` }
      : { kind: "server", line: m };
  }
  return { kind: "say", line: m };
}

/** Retail HearEmote join: `You wave.` / `You's …` (no space before `'`). */
export function formatEmoteLine(name, text) {
  const t = String(text ?? "");
  return t.startsWith("'") ? `${name}${t}` : `${name} ${t}`;
}

/**
 * Retail PublicChat (acclient.c:426025) / RemoveTextBetween: scan plain
 * speech for `*token*` then `<token>` pairs. Every token `resolve` knows is
 * a pose (retail Pose always sends it); the token (markers included) is cut
 * from the spoken text only when it resolved to a motion (`motionFull !== 0`,
 * Pose returned 1). Unknown / unclosed tokens stay literal. Returns
 * `{ spoken, poses: [{ token, resolved }] }` with `spoken` trimmed (retail
 * sends Event_Talk only when it is non-empty).
 */
export function extractPoses(text, resolve) {
  let s = String(text ?? "");
  const poses = [];
  if (typeof resolve !== "function") return { spoken: s.trim(), poses };
  let cursor = 0;
  while (cursor < s.length) {
    const star = s.indexOf("*", cursor);
    const angle = s.indexOf("<", cursor);
    let open;
    let close;
    if (star < 0) { open = angle; close = ">"; }
    else if (angle < 0 || star <= angle) { open = star; close = "*"; }
    else { open = angle; close = ">"; }
    if (open < 0) break;
    const end = s.indexOf(close, open + 1);
    if (end < 0) { cursor = open + 1; continue; }
    const token = s.slice(open + 1, end);
    let resolved = null;
    if (token) {
      try { resolved = resolve(token) ?? null; } catch (_) { resolved = null; }
    }
    if (resolved) {
      poses.push({ token, resolved });
      if ((resolved.motionFull >>> 0) !== 0) {
        s = s.slice(0, open) + s.slice(end + 1);
        cursor = open;
        continue;
      }
    }
    cursor = end + 1;
  }
  return { spoken: s.trim(), poses };
}

// Local prediction: play the emote motion on the local player immediately
// (retail Pose drives cmdinterp locally, acclient.c:425567) instead of
// waiting for the UpdateMotion echo. Held `*State` poses loop via setMotion;
// one-shots (Wave / Cheer / …) play once via setSwingMotion. Best-effort.
function predictLocalEmote(motionFull, held) {
  try {
    const em = window.liveScene3d?.entityManager;
    const localGuid = (typeof window.getLocalPlayerGuid === "function")
      ? window.getLocalPlayerGuid()
      : null;
    if (!em || localGuid == null) return;
    const g = localGuid >>> 0;
    if (held) {
      const NONCOMBAT_STANCE = 0x8000003D;
      const stance = (typeof em.getStance === "function"
        ? em.getStance(g) >>> 0
        : 0) || NONCOMBAT_STANCE;
      if (typeof em.setMotion === "function") em.setMotion(g, motionFull, stance);
    } else if (typeof em.setSwingMotion === "function") {
      em.setSwingMotion(g, motionFull);
    }
  } catch (_) {
    // The wire packet already fired; the chat side surfaces regardless.
  }
}

/**
 * Perform one resolved soul emote (Wave 9 Phase 9.3/9.5): send the
 * broadcast text (Communication_SoulEmote 0x01E1 — ACE rebroadcasts it as
 * 0x01E2, whose own-echo the wasm drops like retail HearSoulEmote), pulse
 * the motion to observers (MoveToState), predict it locally, and return the
 * local `You …` line retail Pose prints. `{ echo, error }`.
 */
function runSoulEmote(handle, resolved, token) {
  const otherText = resolved.otherEmote;
  const myText = resolved.myEmote;
  const motionFull = resolved.motionFull >>> 0;
  try {
    // Some catalog entries (very rare) have no ChatEmoteData: fall back to
    // the bare token so the wire packet still fires.
    handle.sendSoulEmote(otherText || token);
  } catch (e) {
    return { echo: null, error: `/${token}: ${e?.message || e}` };
  }
  if (motionFull !== 0 && typeof handle.broadcastEmoteMotion === "function") {
    try { handle.broadcastEmoteMotion(motionFull); } catch (_) {
      // Best-effort — the chat text already fired.
    }
  }
  if (motionFull !== 0) predictLocalEmote(motionFull, !!resolved.held);
  const echo = formatEmoteLine("You", myText || otherText || resolved.pose);
  return { echo, error: null };
}

export function initSlashCommands() {
  // Two distinct sticky targets, matching retail
  // gmCCommunicationSystem state:
  //   __chatLastIncomingTellSender — name of last PLAYER who sent YOU a
  //     tell. Drives `/reply` `/r` `/rp`. Mirrored from the wasm
  //     SessionHandle.lastTellerName() (player senders only, retail
  //     HearDirectSpeech) by the kind=2 drain in app/client_events.js.
  //   __chatLastOutgoingTellTarget — name of last player YOU
  //     sent a tell to. Drives `/retell` `/rt`. Populated
  //     synchronously when a tell is dispatched below (retail
  //     DoTell's SetLastTelleeName).
  // Retail decomp: acclient.c:417665-417906 + 417862-417890.
  window.__chatLastIncomingTellSender = null;
  window.__chatLastOutgoingTellTarget = null;

  // Retail-strict comma parser. acclient.c:417984-418036's
  // DoTell does `_strchr(argv, 44)` (comma) and splits there;
  // on miss it prints "Use comma after the name for targeted
  // chat." We mirror that verbatim so AC veterans see the UX
  // they're used to. Returns { target, message } or null on
  // miss (no comma, empty target, or empty message).
  function parseCommaTell(rest) {
    const commaIdx = rest.indexOf(",");
    if (commaIdx < 0) return null;
    const target = rest.slice(0, commaIdx).trim();
    const msg = rest.slice(commaIdx + 1).trim();
    if (!target || !msg) return null;
    return { target, message: msg };
  }
  window.__parseCommaTell = parseCommaTell;

  // Slash-command → wire-opcode router. Retail's client
  // parses these locally and sends the matching GameAction;
  // ACE's GameActionTalk does NOT parse `/`-prefixes (only
  // `@admin` commands). So we have to dispatch the right
  // wasm method ourselves. Returns:
  //   { dispatched: true, echo, error?, category? } if we handled it
  //     (`echo` is a LOCAL line to print — null when the server echoes);
  //   { dispatched: false } if the caller should fall through to
  //     sendChat (plain say → routePublicChat, or a server `@command`).
  function routeSlashCommand(handle, message) {
    const norm = normalizeChatLine(message);
    if (norm.kind !== "command") return { dispatched: false };
    const { rawCmd, cmd, rest } = parseCommandLine(norm.line);

    // Tells: `/tell <name>, <msg>` (comma-delimited, retail-
    // strict). ACE echoes `You tell X, "…"` (OutgoingTell) back.
    if (TELL_ALIASES.has(cmd)) {
      const parsed = parseCommaTell(rest);
      if (!parsed) {
        return { dispatched: true, echo: null,
                 error: "Use comma after the name for targeted chat." };
      }
      handle.sendTell(parsed.target, parsed.message);
      window.__chatLastOutgoingTellTarget = parsed.target;
      return { dispatched: true, echo: null };
    }

    // Reply to last incoming PLAYER teller (retail DoReply,
    // acclient.c:417665: text check first, then the teller). We key
    // off name because our wire path is TellByName (0x005D) — ACE's
    // TalkDirect only resolves targets on the same landblock.
    if (REPLY_ALIASES.has(cmd)) {
      const text = rest.trim();
      if (!text) {
        return { dispatched: true, echo: null,
                 error: "You must specify the text you wish to say!" };
      }
      const target = window.__chatLastIncomingTellSender;
      if (!target) {
        return { dispatched: true, echo: null,
                 error: "Someone must @tell you first!" };
      }
      handle.sendTell(target, text);
      window.__chatLastOutgoingTellTarget = target;
      return { dispatched: true, echo: null };
    }

    // Local speech: `/say <msg>` or `/s <msg>` → plain Talk (ACE
    // echoes HearSpeech back; the wasm prints `You say, "…"`).
    if (SAY_ALIASES.has(cmd)) {
      const msg = rest.trim();
      if (!msg) {
        return { dispatched: true, echo: null,
                 error: "You must specify the text you wish to say!" };
      }
      handle.sendChat(msg);
      return { dispatched: true, echo: null };
    }

    // Retell to last outgoing target: `/retell <msg>` or
    // `/rt <msg>`. acclient.c:417832 DoReTell — GetLastTelleeName().
    if (RETELL_ALIASES.has(cmd)) {
      const target = window.__chatLastOutgoingTellTarget;
      if (!target) {
        return { dispatched: true, echo: null,
                 error: "You must first provide a name using @tell" };
      }
      const text = rest.trim();
      if (!text) {
        return { dispatched: true, echo: null,
                 error: "You must specify the text you wish to say!" };
      }
      handle.sendTell(target, text);
      return { dispatched: true, echo: null };
    }

    // Legacy channels (fellowship / patron / vassals / monarch /
    // co-vassals / allegiance broadcast). ACE echoes your own line
    // with an empty sender (wasm: `[Fellowship] You say, "…"`).
    if (hasOwn(CHANNEL_MAP, cmd)) {
      const text = rest.trim();
      if (!text) {
        return { dispatched: true, echo: null,
                 error: "You must specify the text you wish to broadcast!" };
      }
      try { handle.sendChannel(CHANNEL_MAP[cmd], text); }
      catch (e) {
        return { dispatched: true, echo: null, error: `/${cmd}: ${e?.message || e}` };
      }
      return { dispatched: true, echo: null };
    }

    // Turbine rooms (Allegiance / General / Trade / LFG / Roleplay /
    // Society / Olthoi). The room delivers your own line back with
    // your name (retail ChatRoomTracker wording), so no local echo.
    if (hasOwn(TURBINE_CMDS, cmd)) {
      const entry = TURBINE_CMDS[cmd];
      const text = rest.trim();
      if (!text) {
        // Retail DoTurbineChat_* with no text → 0x26.
        return { dispatched: true, echo: null, error: "That is not a valid command." };
      }
      try { handle.sendTurbineChannel(entry.type, text); }
      catch (e) {
        return { dispatched: true, echo: null,
                 error: `${entry.label}: ${e?.message || e}` };
      }
      return { dispatched: true, echo: null };
    }

    // Free-text emote: `/me` `/e` `/em` `/emote` (and `:` / `;`) →
    // GameAction::Emote (0x01DF). ACE rebroadcasts GameMessageEmoteText
    // (0x01E0) to everyone incl. you (wasm: `Name waves`). No motion plays
    // — pose emotes (`/bow`, `*wave*`) are soul emotes, below. Retail
    // DoEmote with no text sends and prints nothing.
    if (EMOTE_ALIASES.has(cmd)) {
      const action = rest.trim();
      if (!action) return { dispatched: true, echo: null };
      try { handle.sendEmote(action); }
      catch (e) {
        return { dispatched: true, echo: null,
                 error: `/${cmd}: ${e?.message || e}` };
      }
      return { dispatched: true, echo: null };
    }

    // social-lists-1 (round 4, 2026-10-08): retail client-side friends /
    // squelch / filter commands (ClientCommunicationSystem::DoFriends,
    // DoSquelch, DoUnSquelch, PerformGlobalSquelchMod, DoMessageTypes).
    // Their text goes straight to the chat window (retail AddTextToScroll,
    // system text) and is also returned as `lines` for callers / tests.
    if (SOCIAL_CLIENT_VERBS.includes(cmd) && retailSocialCmdsEnabled()) {
      let res;
      try {
        res = runSocialCommand(cmd, rest, handle, {
          lastTeller: window.__chatLastIncomingTellSender
            ?? (typeof handle.lastTellerName === "function" ? handle.lastTellerName() : null),
        });
      } catch (e) {
        return { dispatched: true, echo: null, error: `/${cmd}: ${e?.message || e}` };
      }
      const lines = res?.lines ?? [];
      const append = typeof window.__appendChatLine === "function" ? window.__appendChatLine : null;
      if (append) for (const line of lines) append(line, CHAT_CATEGORY.SYSTEM);
      return { dispatched: true, echo: null, lines, category: CHAT_CATEGORY.SYSTEM };
    }

    // pk-4 (round 5, 2026-10-08): @pklite / @pkarena / @pklarena run
    // retail's client checks on the LIVE PK bits, then send the GameAction.
    // A pkg without the bindings keeps the old server forward below.
    if (PK_CLIENT_VERBS.includes(cmd) && retailPkCmdsEnabled()) {
      let odf = 0;
      try {
        const me = (window.getLocalPlayerGuid?.() ?? handle.playerGuid?.() ?? 0) >>> 0;
        odf = me ? ((handle.objectDescFlags?.(me) ?? 0) >>> 0) : 0;
      } catch (_) { odf = 0; }
      const decision = pkCommandDecision(cmd, rest, odf);
      if (decision?.text) {
        const append = typeof window.__appendChatLine === "function" ? window.__appendChatLine : null;
        if (append) append(decision.text, CHAT_CATEGORY.SYSTEM);
        return { dispatched: true, echo: null, lines: [decision.text], category: CHAT_CATEGORY.SYSTEM };
      }
      if (decision?.send && typeof handle[decision.send] === "function") {
        try { handle[decision.send](); }
        catch (e) { return { dispatched: true, echo: null, error: `/${cmd}: ${e?.message || e}` }; }
        return { dispatched: true, echo: null };
      }
    }

    // Wave 9 Phase 9.3 (2026-05-26) — soul emote slash commands
    // (`/bow`, `/wave`, `/cheer`, …): a holtburger convenience (retail
    // only poses via `*token*` in speech). The DAT-derived ChatPoseTable
    // catalog (~303 tokens) lives in wasm — `handle.resolveSoulEmote`
    // returns { pose, motionFull, myEmote, otherEmote, held } or null.
    // Unknown token falls through so a typo draws ACE's "Unknown command".
    if (typeof handle.resolveSoulEmote === "function") {
      const resolved = handle.resolveSoulEmote(cmd);
      if (resolved) {
        const r = runSoulEmote(handle, resolved, cmd);
        try { resolved.free?.(); } catch (_) {}
        if (r.error) return { dispatched: true, echo: null, error: r.error };
        // Retail Pose prints the local `You …` line (grey, emote type 0xC).
        return { dispatched: true, echo: r.echo, category: CHAT_CATEGORY.EMOTE };
      }
    }

    // Unknown slash → treat as a SERVER command (retail
    // accepted `/` and `@` interchangeably as command
    // prefixes; ACE's GameActionTalk only parses `@`). Send
    // `@cmd rest` so `/telepoi holtburg` works and a typo
    // draws ACE's "Unknown command" instead of the player
    // SAYING "/telepoi holtburg" out loud (pre-fix behavior).
    // ACE does not echo commands, so this one keeps a local echo.
    const serverLine = `@${rawCmd}${rest ? ` ${rest}` : ""}`;
    handle.sendChat(serverLine);
    return { dispatched: true, echo: `> ${serverLine}` };
  }

  // Plain speech (no prefix): retail PublicChat. Runs every inline
  // `*pose*` / `<pose>` soul emote and returns what is left to say.
  // `{ spoken, echoes, errors, category }` — the caller sends `spoken`
  // with sendChat only when non-empty and prints `echoes` (the local
  // `You …` lines) in `category` (EMOTE).
  function routePublicChat(handle, message) {
    const resolve = typeof handle?.resolveSoulEmote === "function"
      ? (token) => handle.resolveSoulEmote(token)
      : null;
    const { spoken, poses } = extractPoses(message, resolve);
    const echoes = [];
    const errors = [];
    for (const { token, resolved } of poses) {
      const r = runSoulEmote(handle, resolved, token);
      try { resolved.free?.(); } catch (_) {}
      if (r.error) errors.push(r.error);
      else if (r.echo) echoes.push(r.echo);
    }
    return { spoken, echoes, errors, category: CHAT_CATEGORY.EMOTE };
  }

  window.__routeSlashCommand = routeSlashCommand;
  return { routeSlashCommand, routePublicChat };
}
