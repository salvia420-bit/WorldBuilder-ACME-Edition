// app/social_commands.js — retail client-side friends / squelch commands
// (social-lists-1, round 4, 2026-10-08).
//
// Retail ClientCommunicationSystem registers these verbs in its own command
// table (acclient.c:429077-429139 friends / friends_add / friends_remove,
// :429387-430070 squelch / unsquelch / messagetypes / filter / unfilter) and
// runs them locally, sending the matching GameAction. Vanilla ACE has no
// such server commands, so forwarding them as `@friends …` only drew
// "Unknown command". Ported:
//   DoFriends (:421494) / DoFriendsAdd (:419061) / DoFriendsRemove (:419108)
//     and gmFriendsUI's chat-command handlers (:201085 list, :201230 remove
//     by name, :201571 remove -all, Request_AddFriend :200746 50-cap);
//   DoSquelch (:421669) / DoUnSquelch (:421735) via ProcessSquelchArgs
//     (:419701: `-reply` / `-account` / `-<type>` flags, the type names of
//     LogTextTypeEnumMapper::LogTextTypeFromString :713631);
//   DoSquelchQuery (:434826) / DoGlobalSquelchQuery (:434707) /
//     ConvertSQToPString (types: IsLegalChannel :713311, names
//     LogTextTypeToString :713341);
//   PerformGlobalSquelchMod (:421888) for filter / unfilter;
//   DoMessageTypes (:419898) / GetListofSquelchChannels (:434637).
// Output goes to the chat window as retail text type 0 / 0x1A (system).
//
// `?retailSocialCmds=off|0|false` restores the old behaviour (forward the
// verb to the server as `@verb …`).

/** Retail squelch category names → ChatMessageType index (LogTextTypeFromString). */
export const SQUELCH_TYPE_BY_NAME = Object.freeze({
  default: 0, speech: 2, tell: 3, speech_direct_send: 4, world_broadcast: 20,
  system: 5, combat: 6, combat_enemy: 21, combat_self: 22, magic: 7,
  channel: 8, channel_send: 9, social: 10, social_send: 11, emote: 12,
  advancement: 13, abuse: 14, help: 15, all: 1, spellcasting: 17,
  appraisal: 16, assessment: 16, allegiance: 18, fellowship: 19, recall: 23,
  craft: 24, salvaging: 25, admin_tell: 31,
});

/**
 * LogTextTypeEnumMapper::IsLegalChannel (acclient.c:713311) in index order,
 * with the LogTextTypeToString names — what /messagetypes lists and what a
 * squelch mask is printed as.
 */
export const LEGAL_SQUELCH_CHANNELS = Object.freeze([
  [2, "Speech"], [3, "Tell"], [6, "Combat"], [7, "Magic"], [12, "Emote"],
  [16, "Appraisal"], [17, "Spellcasting"], [18, "Allegiance"], [19, "Fellowship"],
  [21, "Combat_Enemy"], [22, "Combat_Self"], [23, "Recall"], [24, "Craft"],
  [25, "Salvaging"],
]);

/** ChatMessageType.AllChannels — retail ProcessSquelchArgs' default mask. */
export const SQUELCH_ALL = 1;
/** gmFriendsUI::Request_AddFriend refuses at 0x32 entries. */
export const MAX_FRIENDS = 50;

/** The verbs this module owns (all retail client-command-table entries). */
export const SOCIAL_CLIENT_VERBS = Object.freeze([
  "friends", "friends_add", "friends_remove",
  "squelch", "unsquelch", "filter", "unfilter", "messagetypes",
]);

// WeenieError texts (ACE WeenieError.cs) retail shows via
// ECM_UI::SendNotice_DisplayWeenieError.
const MSG_MAX_FRIENDS = "You may only have a maximum of 50 friends at once. If you wish to add more friends, you must first remove some.";
const MSG_NOT_A_FRIEND = "That character is not on your friends list!";

export function retailSocialCmdsEnabled(search) {
  try {
    const s = search ?? globalThis.location?.search ?? "";
    const v = new URLSearchParams(s).get("retailSocialCmds");
    return !(v === "off" || v === "0" || v === "false");
  } catch (_) { return true; }
}

/** Split the argument text like retail's argv (whitespace-separated). */
export function splitArgs(rest) {
  return String(rest ?? "").trim().split(/\s+/).filter(Boolean);
}

/** Retail JoinArgsAsName: the remaining argv joined by single spaces. */
function joinName(args) {
  return args.join(" ").trim();
}

/** Copy `handle.playerFriends()` into plain rows, freeing the wasm boxes. */
export function readFriends(handle) {
  let snap = null;
  try { snap = typeof handle?.playerFriends === "function" ? handle.playerFriends() : null; } catch (_) { snap = null; }
  if (!snap) return [];
  const out = [];
  try {
    for (const f of Array.from(snap.friends ?? [])) {
      try {
        out.push({ id: (f.friendId ?? f.id) >>> 0, name: String(f.name ?? ""), online: !!(f.isOnline ?? f.online) });
      } finally { try { f.free?.(); } catch (_) { /* plain object */ } }
    }
  } catch (_) { /* malformed snapshot */ }
  finally { try { snap.free?.(); } catch (_) { /* plain object */ } }
  return out;
}

/** Copy `handle.playerSquelch()` into plain rows, freeing the wasm boxes. */
export function readSquelch(handle) {
  let snap = null;
  try { snap = typeof handle?.playerSquelch === "function" ? handle.playerSquelch() : null; } catch (_) { snap = null; }
  const out = { characters: [], globalsMask: 0 };
  if (!snap) return out;
  try {
    out.globalsMask = (snap.globalsMask ?? 0) >>> 0;
    for (const c of Array.from(snap.characters ?? [])) {
      try {
        out.characters.push({
          guid: (c.targetGuid ?? 0) >>> 0, name: String(c.name ?? ""),
          mask: (c.mask ?? 0) >>> 0, isAccount: !!c.isAccount,
        });
      } finally { try { c.free?.(); } catch (_) { /* plain object */ } }
    }
  } catch (_) { /* malformed snapshot */ }
  finally { try { snap.free?.(); } catch (_) { /* plain object */ } }
  return out;
}

/**
 * Retail ConvertSQToPString type list (force_all = 0): "All message types"
 * when the AllChannels bit (1 << 1) is set, else the legal channel names
 * whose bit is set, joined by ", ".
 */
export function squelchTypesText(mask) {
  const m = mask >>> 0;
  if (m & (1 << SQUELCH_ALL)) return "All message types";
  const names = [];
  for (const [idx, name] of LEGAL_SQUELCH_CHANNELS) if (m & (1 << idx)) names.push(name);
  return names.join(", ");
}

/** Retail friend-name compare: case-insensitive, stored name's leading '+' trimmed. */
function sameFriendName(stored, wanted) {
  return String(stored).replace(/^\++/, "").toLowerCase() === String(wanted).toLowerCase();
}

/** gmFriendsUI display (acclient.c:201085): `/friends` and `/friends online`. */
export function friendsListLines(friends, onlineOnly) {
  if (!friends.length) return ["Your friends list is empty!"];
  const lines = ["Your friends:"];
  let shown = 0;
  for (const f of friends) {
    if (f.online) { lines.push(`  ${f.name} (Online)`); shown += 1; }
    else if (!onlineOnly) { lines.push(`  ${f.name}`); shown += 1; }
  }
  if (!shown) lines.push("  You have no friends that are online.");
  return lines;
}

function call(handle, method, ...args) {
  if (typeof handle?.[method] !== "function") return false;
  handle[method](...args);
  return true;
}

function friendsAdd(handle, args) {
  const name = joinName(args);
  if (!name) return ["You must specify the name of the friend you wish to add."];
  if (readFriends(handle).length >= MAX_FRIENDS) return [MSG_MAX_FRIENDS];
  call(handle, "addFriend", name);
  return [];
}

function friendsRemove(handle, args) {
  const name = joinName(args);
  if (!name) return ["You must specify the name of the friend you wish to remove."];
  if (name.toLowerCase() === "-all") {
    // gmFriendsUI::RecvNotice_ChatCommand_RemoveAllFriends. A pkg without
    // the clearFriends export (pre-round-4 wasm) removes them one by one.
    if (!call(handle, "clearFriends")) {
      for (const f of readFriends(handle)) call(handle, "removeFriend", f.id >>> 0);
    }
    return ["Your friends list has been cleared."];
  }
  const hit = readFriends(handle).find((f) => sameFriendName(f.name, name));
  if (!hit) return [MSG_NOT_A_FRIEND];
  call(handle, "removeFriend", hit.id >>> 0);
  return [];
}

function doFriends(handle, args) {
  const sub = (args[0] ?? "").toLowerCase();
  if (sub === "add") return friendsAdd(handle, args.slice(1));
  if (sub === "remove") return friendsRemove(handle, args.slice(1));
  if (sub === "online") return friendsListLines(readFriends(handle), true);
  // `old` asks the server for the pre-2006 list (Proto_UI::SendFriendsCommand);
  // ACE implements nothing for it, so — as retail against such a server —
  // nothing comes back.
  if (sub === "old") return [];
  if (!sub) return friendsListLines(readFriends(handle), false);
  return ["Invalid friends command specified."];
}

/**
 * Retail ProcessSquelchArgs. Returns `{ ok, lines, account, name, mask }`;
 * `ok === false` = an invalid category (retail returns 0 → nothing sent).
 */
export function processSquelchArgs(args, requireName, lastTeller) {
  const out = { ok: true, lines: [], account: false, name: "", mask: SQUELCH_ALL };
  if (args.length < 1) { out.lines.push("Not enough arguements."); return out; }
  let i = 0;
  let reply = false;
  for (; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith("-")) break;
    const key = a.slice(1).toLowerCase();
    if (key === "reply") { reply = true; continue; }
    if (key === "account") { out.account = true; continue; }
    if (!Object.prototype.hasOwnProperty.call(SQUELCH_TYPE_BY_NAME, key)) {
      out.ok = false;
      out.lines.push(`"${a}" is not a valid squelch category.`);
      return out;
    }
    out.mask = SQUELCH_TYPE_BY_NAME[key];
  }
  if (reply) {
    out.name = String(lastTeller ?? "").trim();
    if (!out.name) out.lines.push("A player must @tell you before you can squelch them with this command.");
    return out;
  }
  out.name = joinName(args.slice(i));
  if (requireName && !out.name) out.lines.push("You have not specified a squelch target.");
  return out;
}

/** DoSquelchQuery (acclient.c:434826). */
export function squelchQueryLines(squelch) {
  const lines = [
    "(account) denotes a character whose account has also been squelched.",
    "Format: Name : List of squelched message types.",
    "--------",
  ];
  if (!squelch.characters.length) { lines.push("none"); return lines; }
  for (const c of squelch.characters) {
    const zone = c.isAccount ? " (account) " : "";
    lines.push(`  Name: ${c.name}${zone} ${squelchTypesText(c.mask)}`);
  }
  return lines;
}

/** DoGlobalSquelchQuery (acclient.c:434707). */
export function globalSquelchQueryLines(globalsMask) {
  const m = globalsMask >>> 0;
  return [
    "The following types of messages are currently being filtered globally:",
    m ? squelchTypesText(m) || "none" : "none",
    "(For a list of filter options, type @help filter)",
  ];
}

/** DoMessageTypes / GetListofSquelchChannels. */
export function messageTypesLines() {
  return [
    "Squelch channels are as follows:",
    `  ${LEGAL_SQUELCH_CHANNELS.map(([, n]) => n).join(", ")}`,
  ];
}

function doSquelch(handle, args, add, lastTeller) {
  if (!args.length) return squelchQueryLines(readSquelch(handle));
  const p = processSquelchArgs(args, true, lastTeller);
  // Retail still sends with an empty name (ACE then ignores it); sending
  // nothing is the same outcome without the round trip.
  if (!p.ok || !p.name) return p.lines;
  if (p.account) call(handle, "modifyAccountSquelch", p.name, add, p.mask >>> 0);
  else call(handle, "modifyCharacterSquelch", 0, p.name, add, p.mask >>> 0);
  return p.lines;
}

function doGlobalSquelch(handle, args, add) {
  if (!args.length) return globalSquelchQueryLines(readSquelch(handle).globalsMask);
  if (!args[0].startsWith("-")) return ["You must specify a valid message type prefixed by a dash."];
  const p = processSquelchArgs(args, false, null);
  if (!p.ok) return p.lines;
  if (!p.account && !p.name) {
    call(handle, "modifyGlobalSquelch", add, p.mask >>> 0);
    return p.lines;
  }
  return [...p.lines, "Incorrect usage, use @help for proper arguements."];
}

/**
 * Run one retail social client command. `cmd` is the lower-cased verb,
 * `rest` the argument text. Returns `null` when `cmd` is not one of
 * SOCIAL_CLIENT_VERBS, else `{ lines }` — the chat lines retail prints.
 */
export function runSocialCommand(cmd, rest, handle, opts = {}) {
  const args = splitArgs(rest);
  switch (cmd) {
    case "friends": return { lines: doFriends(handle, args) };
    case "friends_add": return { lines: friendsAdd(handle, args) };
    case "friends_remove": return { lines: friendsRemove(handle, args) };
    case "squelch": return { lines: doSquelch(handle, args, true, opts.lastTeller) };
    case "unsquelch": return { lines: doSquelch(handle, args, false, opts.lastTeller) };
    case "filter": return { lines: doGlobalSquelch(handle, args, true) };
    case "unfilter": return { lines: doGlobalSquelch(handle, args, false) };
    case "messagetypes": return { lines: messageTypesLines() };
    default: return null;
  }
}
