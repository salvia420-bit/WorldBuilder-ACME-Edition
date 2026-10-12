// rynth/vt/cmd/compat_commands.js — the /ra, /mt and /ub compat verb tables
// (PLAN W1-5 CMD §3.7 "Compat"; U7b §3.1-§3.4).
//
// Explicit PREFIX tables (U7b H21: C# HandleMtCommand ignores the prefix and
// runs any "/xyz use foo" as /mt). Every handler receives the dispatcher's
// command context `c` (built in rs_commands.js):
//   c.verb c.args c.rest c.prefix c.source
//   c.out(text, cat?) c.fail(text) c.pending(promise)
//   c.rs(verb, rest)     run an RS verb (the /rs table) with a new rest
//   c.run(line)          run another command line (nested, same result)
//   c.chat(line)         the local chain: /rs-family → /ls → /ah → InvokeChatParser
//   c.motionRefused(label)  true (and prints) while operator-held / in portal space
//   c.actions() c.host() c.options() c.quests() c.vt()
//   c.queueDelay(ms, line) c.queueLoot(name, partial) c.queueGives(items, target)
//
// What each prefix covers (corpus-used verbs first; U5 §4.1, U7b §3):
//   /ra  forcebuff cancelforcebuff power cast mexec follow use* select* give*
//        jump[swzxc] myquests refreshquests clearbusy panic addnavpt ig igp
//   /mt  opt combatstate face cast castp use* select selectp give givep loot
//        lootp drop dropp equip equipp dequip dequipp fellow logoff logout quit
//        exit send
//   /ub  jump[swzxc] mexec delay myquests follow opt clearbugged ig igp; any
//        other verb is rewritten to /mt <verb> (C# UtilityBeltCommands.cs:22-59)
//
// /mt fellow uses ONLY the host Fellowship* members (A10) and never emits a
// "/fellowship …" line: `fellowship` is a CHANNEL verb in
// app/slash_commands.js, so that text would be SPOKEN on the fellowship
// channel (critic B3). /mt send and /mt logoff are the only verbs that reach
// the game deliberately (send: through the local chain first).

import { OBJECT_CLASS } from "./actions_lib.js";

export const CAT_INFO = 0;
export const CAT_ERROR = 10;

/** One prefix's verbs: exact entries plus pattern entries (jump[swzxc]…). */
export class VerbTable {
  constructor(prefix, title, entries, { patterns = [], fallback = null } = {}) {
    this.prefix = prefix;
    this.title = title;
    this._entries = new Map();
    for (const [verbs, entry] of entries) {
      for (const v of String(verbs).split("|")) this._entries.set(v, entry);
    }
    this._patterns = patterns;
    this._fallback = fallback;
    Object.freeze(this);
  }
  /** → { run(c), help, motion? } | null */
  resolve(verb) {
    const v = String(verb ?? "").toLowerCase();
    if (this._entries.has(v)) return this._entries.get(v);
    for (const [re, entry] of this._patterns) if (re.test(v)) return entry;
    return this._fallback ? this._fallback(v) : null;
  }
  has(verb) {
    return this.resolve(verb) !== null;
  }
  verbs() {
    return [...this._entries.keys()];
  }
  helpLines() {
    const seen = new Set();
    const out = [];
    for (const e of [...this._entries.values(), ...this._patterns.map((p) => p[1])]) {
      if (seen.has(e) || !e.help) continue;
      seen.add(e);
      out.push(`  /${this.prefix} ${e.help}`);
    }
    return out;
  }
}

// ── shared helpers ─────────────────────────────────────────────────────────

function split2(text, sep, { last = false } = {}) {
  const s = String(text ?? "");
  const lower = s.toLowerCase();
  const i = last ? lower.lastIndexOf(sep) : lower.indexOf(sep);
  if (i < 0) return null;
  return [s.slice(0, i).trim(), s.slice(i + sep.length).trim()];
}

/** C# FindObject: inventory first (inv), then the NEAREST landscape match (land). */
function findObj(c, name, { inv = true, land = true, partial = false } = {}) {
  const acts = c.actions();
  const want = String(name ?? "").trim();
  if (!want || !acts) return null;
  if (inv) {
    const rows = acts.findInventoryByName(want, { partial });
    if (rows.length) return { guid: rows[0].guid, name: rows[0].name, carried: true, stack: rows[0].stack };
  }
  if (land) {
    const o = acts.findNearestByName(want, { partial });
    if (o) return { guid: o.guid, name: o.name, carried: false };
  }
  return null;
}

const hex = (g) => `0x${(Number(g) >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;

/** use[i|l][p] <name> [on <name2>] (+ /mt closestnpc|closestvendor|closestportal). */
function useCmd({ inv, land, partial, closest = false }) {
  return (c) => {
    const acts = c.actions();
    const arg = c.rest.trim();
    if (!arg) return c.fail(`usage: /${c.prefix} ${c.verb} <name> [on <name2>]`);
    if (!acts) return c.fail("not in the world");
    const lower = arg.toLowerCase();
    if (closest && (lower === "closestnpc" || lower === "closestvendor" || lower === "closestportal")) {
      const cls = { closestnpc: OBJECT_CLASS.Npc, closestvendor: OBJECT_CLASS.Vendor, closestportal: OBJECT_CLASS.Portal }[lower];
      const best = acts
        .landscape()
        .filter((o) => acts.objectClassOf(o.guid) === cls)
        .sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity))[0];
      if (!best) return c.fail(`no ${lower.slice(7)} found nearby`);
      const r = acts.use(best.guid);
      return r.ok ? c.out(`[RynthSuite] using ${best.name} (${hex(best.guid)})`) : c.fail(r.error);
    }
    const on = split2(arg, " on ");
    if (on) {
      const src = findObj(c, on[0], { inv, land, partial });
      if (!src) return c.fail(`not found: '${on[0]}'`);
      const tgt = findObj(c, on[1], { inv, land, partial });
      if (!tgt) return c.fail(`not found: '${on[1]}'`);
      const r = acts.useOn(src.guid, tgt.guid);
      return r.ok ? c.out(`[RynthSuite] using ${src.name} on ${tgt.name}`) : c.fail(r.error);
    }
    const obj = findObj(c, arg, { inv, land, partial });
    if (!obj) return c.fail(`not found: '${arg}'`);
    const r = acts.use(obj.guid);
    return r.ok ? c.out(`[RynthSuite] using ${obj.name} (${hex(obj.guid)})`) : c.fail(r.error);
  };
}

function selectCmd({ inv, land, partial }) {
  return (c) => {
    const acts = c.actions();
    const arg = c.rest.trim();
    if (!arg) return c.fail(`usage: /${c.prefix} ${c.verb} <name>`);
    const obj = findObj(c, arg, { inv, land, partial });
    if (!obj) return c.fail(`not found: '${arg}'`);
    const r = acts.select(obj.guid);
    return r.ok ? c.out(`[RynthSuite] selected ${obj.name} (${hex(obj.guid)})`) : c.fail(r.error);
  };
}

/**
 * /ra give* — `[count] <item> to <player>`, split on the LAST " to ".
 * item: exact | partial | regex; player: exact | partial; all = every matching stack.
 */
function raGiveCmd({ item = "exact", partialPlayer = false, all = false }) {
  return (c) => {
    const acts = c.actions();
    const parts = split2(c.rest, " to ", { last: true });
    if (!parts || !parts[0] || !parts[1]) return c.fail(`usage: /${c.prefix} ${c.verb} [count] <item> to <player>`);
    let [itemPart, playerPart] = parts;
    let maxCount = all ? Infinity : 1;
    const m = /^(\d+)\s+(.+)$/.exec(itemPart);
    if (!all && m && Number(m[1]) > 0) {
      maxCount = Number(m[1]);
      itemPart = m[2].trim();
    }
    const target = acts.findNearestByName(playerPart, { partial: partialPlayer });
    if (!target) return c.fail(`target not found: '${playerPart}'`);
    const rows = acts
      .findInventoryByName(itemPart, { partial: item === "partial", regex: item === "regex" })
      .slice(0, Number.isFinite(maxCount) ? maxCount : undefined);
    if (!rows.length) return c.fail(`no items found matching '${itemPart}'`);
    if (all || rows.length > 1) {
      c.queueGives(
        rows.map((r) => ({ guid: r.guid, name: r.name, amount: r.stack })),
        { guid: target.guid, name: target.name },
      );
      return c.out(`[RynthSuite] queued ${rows.length} stack(s) matching '${itemPart}' → ${target.name}`);
    }
    const r = acts.give(rows[0].guid, target.guid, rows[0].stack);
    return r.ok ? c.out(`[RynthSuite] giving ${rows[0].name} to ${target.name}`) : c.fail(r.error);
  };
}

/** /mt give[p] <item> to <target> — FIRST " to "; item from inventory, target partial. */
function mtGiveCmd({ partial }) {
  return (c) => {
    const acts = c.actions();
    const parts = split2(c.rest, " to ");
    if (!parts || !parts[0] || !parts[1]) return c.fail(`usage: /${c.prefix} ${c.verb} <item> to <target>`);
    const item = findObj(c, parts[0], { inv: true, land: false, partial });
    if (!item) return c.fail(`item not found: '${parts[0]}'`);
    const target = acts.findNearestByName(parts[1], { partial: true });
    if (!target) return c.fail(`target not found: '${parts[1]}'`);
    const r = acts.give(item.guid, target.guid, item.stack ?? 1);
    return r.ok ? c.out(`[RynthSuite] giving ${item.name} to ${target.name}`) : c.fail(r.error);
  };
}

function lootCmd({ partial }) {
  return (c) => {
    const acts = c.actions();
    const name = c.rest.trim();
    if (!name) return c.fail(`usage: /${c.prefix} ${c.verb} <item>`);
    const r = acts.lootFromOpen(name, { partial });
    if (r.ok) return c.out(`[RynthSuite] looting ${r.name} (${hex(r.guid)})`);
    if (r.retry) {
      c.queueLoot(name, partial);
      const what = r.contents && r.contents.length ? ` (open container holds: ${r.contents.slice(0, 8).join(", ")})` : "";
      return c.out(`[RynthSuite] loot '${name}': waiting for it to appear${what}`);
    }
    return c.fail(r.error);
  };
}

function invItemCmd(label, action, { partial, wieldedOnly = false }) {
  return (c) => {
    const acts = c.actions();
    const name = c.rest.trim();
    if (!name) return c.fail(`usage: /${c.prefix} ${c.verb} <item>`);
    let rows = acts.findInventoryByName(name, { partial });
    if (wieldedOnly) {
      const wielded = new Set(acts.inventory().filter((r) => Number(r.equipMask) >>> 0).map((r) => Number(r.guid) >>> 0));
      rows = rows.filter((r) => wielded.has(r.guid));
    }
    if (!rows.length) return c.fail(`${wieldedOnly ? "wielded item" : "item"} not found: '${name}'`);
    const r = acts[action](rows[0].guid);
    return r.ok ? c.out(`[RynthSuite] ${label} ${rows[0].name} (${hex(rows[0].guid)})`) : c.fail(r.error);
  };
}

/** Resolve a spell argument: an id, or a KNOWN spell by name (exact, or partial with castp). */
function resolveSpell(c, arg, partial) {
  const s = String(arg ?? "").trim();
  if (/^\d+$/.test(s)) return { id: Number(s), name: "" };
  const h = c.host();
  const known = typeof h?.TryGetKnownSpells === "function" ? h.TryGetKnownSpells() : [];
  const lw = s.toLowerCase();
  let hit = null;
  for (const id of Array.isArray(known) ? known : []) {
    const rec = typeof h?.TryGetSpellRecord === "function" ? h.TryGetSpellRecord(id) : null;
    const name = rec && typeof rec.name === "string" ? rec.name : "";
    if (!name) continue;
    if (name.toLowerCase() === lw) return { id: Number(id), name };
    if (partial && !hit && name.toLowerCase().includes(lw)) hit = { id: Number(id), name };
  }
  return hit;
}

function castReport(c, code, label) {
  if (code === 0) return c.out(`[RynthSuite] casting ${label}`);
  if (code === 1) return c.out(`[RynthSuite] cast ${label}: getting ready (magic mode / busy) — repeat the command`);
  return c.fail(`cannot cast ${label} (unknown spell, not known, or it needs a target)`);
}

/** /mt cast[p] <id|name> [on <target>] */
function mtCastCmd({ partial }) {
  return (c) => {
    const acts = c.actions();
    if (!c.rest.trim()) return c.fail(`usage: /${c.prefix} ${c.verb} <id|name> [on <target>]`);
    const on = split2(c.rest, " on ");
    const spellArg = on ? on[0] : c.rest.trim();
    let target = 0;
    if (on) {
      const t = acts.findNearestByName(on[1], { partial: true });
      if (!t) return c.fail(`target not found: '${on[1]}'`);
      target = t.guid;
    } else {
      const h = c.host();
      target = Number(typeof h?.GetSelectedItemId === "function" ? h.GetSelectedItemId() : h?.GetSelectedId?.()) >>> 0;
    }
    const spell = resolveSpell(c, spellArg, partial);
    if (!spell) return c.fail(`spell not found: '${spellArg}'`);
    return castReport(c, acts.castById(spell.id, target || null), spell.name || `spell ${spell.id}`);
  };
}

/** /ra cast <spellId> — on the selected target (SelfTargeted spells go to the player). */
function raCastCmd(c) {
  const id = Number(c.args[0]);
  if (!Number.isInteger(id) || id <= 0) return c.fail(`usage: /${c.prefix} cast <spellId>`);
  const h = c.host();
  const sel = Number(typeof h?.GetSelectedItemId === "function" ? h.GetSelectedItemId() : h?.GetSelectedId?.()) >>> 0;
  return castReport(c, c.actions().castById(id, sel || null), `spell ${id}`);
}

function setPower(c) {
  const o = c.options();
  if (!o) return c.fail("settings are not available yet");
  const a = (c.args[0] ?? "").toLowerCase();
  if (!a) {
    const m = o.get("MeleeAttackPower");
    const s = o.get("MissileAttackPower");
    return c.out(`[RynthSuite] power: melee ${Math.round((m.value ?? 0) * 100)}, missile ${Math.round((s.value ?? 0) * 100)}`);
  }
  if (a === "auto") return c.fail("power auto (recklessness-aware) is not supported on web — give 0-100");
  const n = Number(a);
  if (!Number.isFinite(n) || n < 0 || n > 100) return c.fail(`usage: /${c.prefix} power <0-100>`);
  const v = Math.round(n) / 100;
  const r1 = o.set("MeleeAttackPower", v, { source: "command" });
  const r2 = o.set("MissileAttackPower", v, { source: "command" });
  if (!r1.ok || !r2.ok) return c.fail(r1.error || r2.error || "power was not set");
  return c.out(`[RynthSuite] attack power set to ${Math.round(n)}`);
}

function clearBusy(c) {
  const h = c.host();
  if (!h) return c.fail("not in the world");
  try {
    h.ForceResetBusyCount?.();
    h.StopCompletely?.();
  } catch (_) {
    /* best effort */
  }
  return c.out("[RynthSuite] busy state cleared");
}

function panic(c) {
  const h = c.host();
  if (!h) return c.fail("not in the world");
  try {
    h.CancelAttack?.();
    h.ChangeCombatMode?.(1);
    h.StopCompletely?.();
    h.ForceResetBusyCount?.();
  } catch (_) {
    /* best effort */
  }
  return c.out("[RynthSuite] panic: attack cancelled, peace mode, stopped");
}

function questsRefresh(c) {
  const q = c.quests();
  if (q && typeof q.refresh === "function") {
    const sent = q.refresh();
    return c.out(sent === false ? "[RynthSuite] quest refresh already running" : "[RynthSuite] refreshing quests (/myquests)");
  }
  // No tracker (bot not running): the line still has to reach ACE (@myquests).
  c.sendToGame("/myquests");
  return c.out("[RynthSuite] /myquests sent");
}

function lootProfileGive(c) {
  return c.fail(`/${c.prefix} ${c.verb} (give by loot profile) is not supported on web`);
}

/** /mt fellow create <name>|open|close|disband|quit|recruit <name> — host members only (critic B3). */
function mtFellow(c) {
  const h = c.host();
  const sub = (c.args[0] ?? "").toLowerCase();
  const rest = c.rest.trim().slice(sub.length).trim();
  if (!h) return c.fail("not in the world");
  const done = (ok, text) => (ok === false ? c.fail(`${text} failed (not available on this client?)`) : c.out(`[RynthSuite] ${text}`));
  switch (sub) {
    case "create":
      if (!rest) return c.fail(`usage: /${c.prefix} fellow create <name>`);
      return done(typeof h.FellowshipCreate === "function" ? h.FellowshipCreate(rest, true) : false, `fellowship "${rest}" created`);
    case "open":
      return done(typeof h.FellowshipSetOpen === "function" ? h.FellowshipSetOpen(true) : false, "fellowship opened");
    case "close":
      return done(typeof h.FellowshipSetOpen === "function" ? h.FellowshipSetOpen(false) : false, "fellowship closed");
    case "disband":
      return done(typeof h.FellowshipQuit === "function" ? h.FellowshipQuit(true) : false, "fellowship disbanded");
    case "quit":
      return done(typeof h.FellowshipQuit === "function" ? h.FellowshipQuit(false) : false, "left the fellowship");
    case "recruit": {
      if (!rest) return c.fail(`usage: /${c.prefix} fellow recruit <name>`);
      let guid = 0;
      let name = rest;
      const found = typeof h.FindNearbyByName === "function" ? h.FindNearbyByName(rest, { player: true }) : null;
      if (Array.isArray(found) && found.length) {
        guid = Number(found[0].guid) >>> 0;
        name = found[0].name || rest;
      } else {
        const o = c.actions()?.findNearestByName(rest, { partial: false });
        if (o) {
          guid = o.guid;
          name = o.name;
        }
      }
      if (!guid) return c.fail(`${rest} is not in sight`);
      return done(typeof h.FellowshipRecruit === "function" ? h.FellowshipRecruit(guid) : false, `recruiting ${name}`);
    }
    default:
      return c.fail(`usage: /${c.prefix} fellow create <name>|open|close|disband|quit|recruit <name>`);
  }
}

function logoff(c) {
  const h = c.host();
  if (typeof h?.LogOffCharacter !== "function") return c.fail("log off is not available");
  h.LogOffCharacter();
  return c.out("[RynthSuite] logging off");
}

function mtSend(c) {
  const line = c.rest.trim();
  if (!line) return c.fail(`usage: /${c.prefix} send <text>`);
  c.chat(line);
  return undefined;
}

function mtFace(c) {
  if (!c.args.length) return c.fail(`usage: /${c.prefix} face <degrees>`);
  if (c.motionRefused("face")) return undefined;
  const r = c.actions().face(c.args[0]);
  return r.ok ? c.out(`[RynthSuite] facing ${Math.round(r.headingDeg)}°`) : c.fail(r.error);
}

function combatState(c) {
  const st = (c.args[0] ?? "").toLowerCase();
  if (!st) return c.fail(`usage: /${c.prefix} combatstate <peace|melee|missile|magic>`);
  const r = c.actions().setCombatState(st);
  return r.ok ? c.out(`[RynthSuite] combat state → ${st}`) : c.fail(r.error);
}

function ubDelay(c) {
  const m = /^(\S+)\s+([\s\S]+)$/.exec(c.rest.trim());
  const ms = m ? Number(m[1]) : NaN;
  if (!m || !Number.isFinite(ms) || ms < 0) return c.fail(`usage: /${c.prefix} delay <ms> <command>`);
  c.queueDelay(Math.round(ms), m[2].trim());
  return undefined;
}

const toRs = (verb, help, extra = {}) => ({ run: (c) => c.rs(verb ?? c.verb, c.rest), help, ...extra });
const JUMP_RE = /^jump[swzxc]*$/;
const JUMP_ENTRY = { run: (c) => c.rs(c.verb, c.rest), help: "jump[swzxc] [heading] [holdMs]", motion: true };

// Use / select / give verb families (C# RynthAiPlugin.cs:2177-2189, MagToolsCommands.cs:44-60).
const USE_RA = [
  ["use", useCmd({ inv: true, land: true, partial: false })],
  ["usei", useCmd({ inv: true, land: false, partial: false })],
  ["usel", useCmd({ inv: false, land: true, partial: false })],
  ["usep", useCmd({ inv: true, land: true, partial: true })],
  ["usepi|useip", useCmd({ inv: true, land: false, partial: true })],
  ["uselp|usepl", useCmd({ inv: false, land: true, partial: true })],
];
const USE_MT = [
  ["use", useCmd({ inv: true, land: true, partial: false, closest: true })],
  ["usep", useCmd({ inv: true, land: true, partial: true, closest: true })],
  ["usei", useCmd({ inv: true, land: false, partial: false, closest: true })],
  ["useip|usepi", useCmd({ inv: true, land: false, partial: true, closest: true })],
  ["usel", useCmd({ inv: false, land: true, partial: false, closest: true })],
  ["uselp|usepl", useCmd({ inv: false, land: true, partial: true, closest: true })],
];

const RA = new VerbTable("ra", "RynthAi", [
  ["help", { run: (c) => c.help("ra"), help: "help" }],
  ["forcebuff", toRs("forcebuff", "forcebuff | cancelforcebuff")],
  ["cancelforcebuff", toRs("cancelforcebuff")],
  ["power", { run: setPower, help: "power <0-100>" }],
  ["cast", { run: raCastCmd, help: "cast <spellId>   (on the selected target; self spells on you)" }],
  ["mexec", toRs("mexec", "mexec <expression>")],
  ["follow", toRs("follow", "follow <name>|leader|off", { motion: false })],
  ...USE_RA.map(([v, run], i) => [v, { run, help: i === 0 ? "use[i|l][p] <name> [on <name2>]" : null }]),
  ["select|selecti", { run: selectCmd({ inv: true, land: true, partial: false }), help: "select[i|l][p] <name>" }],
  ["selectl", { run: selectCmd({ inv: false, land: true, partial: false }) }],
  ["selectp", { run: selectCmd({ inv: true, land: true, partial: true }) }],
  ["selectpi|selectip", { run: selectCmd({ inv: true, land: false, partial: true }) }],
  ["selectlp|selectpl", { run: selectCmd({ inv: false, land: true, partial: true }) }],
  ["give", { run: raGiveCmd({}), help: "give[a][p|xp|pp|r] [count] <item> to <player>" }],
  ["givep", { run: raGiveCmd({ item: "partial" }) }],
  ["givexp", { run: raGiveCmd({ partialPlayer: true }) }],
  ["givepp", { run: raGiveCmd({ item: "partial", partialPlayer: true }) }],
  ["giver", { run: raGiveCmd({ item: "regex" }) }],
  ["givea", { run: raGiveCmd({ all: true }) }],
  ["giveap", { run: raGiveCmd({ item: "partial", all: true }) }],
  ["giveaxp", { run: raGiveCmd({ partialPlayer: true, all: true }) }],
  ["giveapp|gap", { run: raGiveCmd({ item: "partial", partialPlayer: true, all: true }) }],
  ["givear", { run: raGiveCmd({ item: "regex", all: true }) }],
  ["ig|igp", { run: lootProfileGive }],
  ["myquests|refreshquests", { run: questsRefresh, help: "myquests" }],
  ["clearbusy", { run: clearBusy, help: "clearbusy" }],
  ["panic", { run: panic, help: "panic" }],
  ["addnavpt", toRs("addnavpt", "addnavpt [coords]")],
  ["navdebug", { run: (c) => c.rs("nav", "status"), help: "navdebug" }],
], { patterns: [[JUMP_RE, JUMP_ENTRY]] });

const MT = new VerbTable("mt", "Mag-Tools", [
  ["help", { run: (c) => c.help("mt"), help: "help" }],
  ["opt", toRs("opt", "opt list|get|set|remember|restore …")],
  ["combatstate", { run: combatState, help: "combatstate <peace|melee|missile|magic>" }],
  ["face", { run: mtFace, help: "face <degrees>", motion: true }],
  ["cast", { run: mtCastCmd({ partial: false }), help: "cast[p] <id|name> [on <target>]" }],
  ["castp", { run: mtCastCmd({ partial: true }) }],
  ...USE_MT.map(([v, run], i) => [v, { run, help: i === 0 ? "use[i|l][p] <name|closestnpc|closestvendor|closestportal> [on <name2>]" : null }]),
  ["select", { run: selectCmd({ inv: true, land: true, partial: false }), help: "select[p] <name>" }],
  ["selectp", { run: selectCmd({ inv: true, land: true, partial: true }) }],
  ["give", { run: mtGiveCmd({ partial: false }), help: "give[p] <item> to <target>" }],
  ["givep", { run: mtGiveCmd({ partial: true }) }],
  ["loot", { run: lootCmd({ partial: false }), help: "loot[p] <item>   (from the open container)" }],
  ["lootp", { run: lootCmd({ partial: true }) }],
  ["drop", { run: invItemCmd("dropping", "drop", { partial: false }), help: "drop[p] <item>" }],
  ["dropp", { run: invItemCmd("dropping", "drop", { partial: true }) }],
  ["equip", { run: invItemCmd("equipping", "equip", { partial: false }), help: "equip[p] | dequip[p] <item>" }],
  ["equipp", { run: invItemCmd("equipping", "equip", { partial: true }) }],
  ["dequip", { run: invItemCmd("unequipping", "unequip", { partial: false, wieldedOnly: true }) }],
  ["dequipp", { run: invItemCmd("unequipping", "unequip", { partial: true, wieldedOnly: true }) }],
  ["fellow", { run: mtFellow, help: "fellow create <name>|open|close|disband|quit|recruit <name>" }],
  ["logoff|logout|quit|exit", { run: logoff, help: "logoff" }],
  ["send", { run: mtSend, help: "send <text>" }],
]);

const UB = new VerbTable(
  "ub",
  "UtilityBelt",
  [
    ["help", { run: (c) => c.help("ub"), help: "help   (other verbs run as /mt <verb>)" }],
    ["mexec", toRs("mexec", "mexec <expression>")],
    ["delay", { run: ubDelay, help: "delay <ms> <command>" }],
    ["myquests", { run: questsRefresh, help: "myquests" }],
    ["follow", toRs("follow", "follow <name>|leader|off")],
    ["opt", toRs("opt", "opt list|get|set|remember|restore …")],
    ["clearbugged", { run: clearBusy, help: "clearbugged" }],
    ["ig|igp", { run: lootProfileGive }],
  ],
  {
    patterns: [[JUMP_RE, JUMP_ENTRY]],
    // Everything else is rewritten to /mt <verb> like C# (UtilityBeltCommands.cs:46-59).
    fallback: (verb) => (MT.has(verb) ? { run: (c) => c.run(`/mt ${c.verb}${c.rest ? ` ${c.rest}` : ""}`), motion: MT.resolve(verb).motion } : null),
  },
);

/** Explicit prefix tables (U7b §3.1-3.4, H21). */
export const COMPAT = Object.freeze({ ra: RA, mt: MT, ub: UB });
