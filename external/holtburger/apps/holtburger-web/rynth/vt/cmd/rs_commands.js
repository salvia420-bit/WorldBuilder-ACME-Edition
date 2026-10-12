// rynth/vt/cmd/rs_commands.js — the `/rs` command dispatcher (PLAN W1-5 CMD,
// §3.7; guide G:7-11, G:123, G:214-224, G:300-319; decisions D13, D19).
//
// ONE dispatcher for every line whose prefix is /rs /vt /ra /mt /ub, reached
// from the chat bar (INT-3 routeSlashCommand branch → the page's __rynthVt.route),
// from nav Chat waypoints and meta Chat/ChatExpr actions (their runChat goes
// through the local chain FIRST), from `!bot rs|vt <line>` tells, and from
// the console. Lines are handled LOCALLY and never sent to ACE (all five
// prefixes are eaten — an unknown verb is a local error line, D13).
//
//   /rs == /vt  the canonical table below (VTank guide verbs + corpus idioms)
//   /ra /mt /ub explicit compat tables (compat_commands.js)
//
// run() is SYNCHRONOUS for every state-changing verb (opt, settings, nav,
// meta, reverseroute, addnav*, …): `nav load` makes the route non-empty within
// the same call, so a meta pass sees it at once. Only start/stop/toggle (HUD
// boot) and ui (lazy panel import) also return `pending`.
//
// Output: every line goes into the RsResult AND to ctx.print(text, category)
// — except for source "tell", where the caller replies with lines[0..2].
// Never the server-sending chat member (C7). Never throws (C9). No timers (C4): the
// `/ub delay` queue, the deferred `/mt loot` and the paced `/ra givea*` gives
// are advanced by pump(nowMs), which INT-2 calls from the VT pre-tick only
// while the operator has NOT paused the bot (V-7); pump() re-checks that.
//
// Motion verbs (jump, nav start, follow <target>, face) are refused while the
// operator holds the bot or the client is in portal space.

import { parseCoords, poseToCoords, coordsToText } from "./coords.js";
import { COMPAT, CAT_INFO, CAT_ERROR } from "./compat_commands.js";
import { createVtActions } from "./actions_lib.js";
import { valueToString, valueTypeName } from "./stdlib_host.js";

class ReadonlySet extends Set {
  constructor(items) {
    super(items);
    this._sealed = true;
  }
  add(v) {
    if (this._sealed) throw new TypeError("RS_PREFIXES is read-only");
    return super.add(v);
  }
  delete() {
    throw new TypeError("RS_PREFIXES is read-only");
  }
  clear() {
    throw new TypeError("RS_PREFIXES is read-only");
  }
}

/** The five eaten prefixes (D13). */
export const RS_PREFIXES = Object.freeze(new ReadonlySet(["rs", "vt", "ra", "mt", "ub"]));

export const RS_TAG = "[RynthSuite]";
const MAX_DEPTH = 8;
const DELAY_QUEUE_MAX = 256;
const LOOT_WAIT_MS = 8000;
const GIVE_GAP_MS = 150;
const SOURCES = new Set(["chat", "meta", "nav", "tell", "console"]);

// G:125-134 — the monster-expression variables (CMB monster_list.js
// MONSTER_VARIABLES carries the same rows; CMD may not import CMB, C2).
export const LISTED_MONSTER_VARIABLES = Object.freeze([
  ["true", false, "always evaluates to true"],
  ["false", false, "always evaluates to false"],
  ["name", false, "the monster's name"],
  ["typeid", false, "the weenie class id (WCID) — 'Type' when a monster is propertydumped"],
  ["species", false, "the name of the monster's species, such as 'Drudge'"],
  ["maxhp", false, "the maximum number of hit points this monster has when it first spawns"],
  ["range", true, "the range in yards (metres) to this target"],
  ["hasshield", true, "true if the target has equipped anything of objectclass armor, false otherwise"],
  ["setting_x", true, "the value of macro setting x, e.g. setting_DoJiggle (case-sensitive)"],
  ["metastate", true, "the current meta state"],
]);

const JUMP_DIRS = Object.freeze({ w: "forward", x: "back", z: "strafeleft", c: "straferight" });
const DIRECTION_WORDS = Object.freeze(["none", "forward", "strafeleft", "straferight", "back"]);
const ROUTE_TYPES = Object.freeze({ circular: 1, linear: 2, follow: 3, once: 4, "1": 1, "2": 2, "3": 3, "4": 4 });
const ROUTE_NAMES = Object.freeze({ 1: "Circular", 2: "Linear", 3: "Follow", 4: "Once" });

function errText(e) {
  return e && e.message ? e.message : String(e);
}

/**
 * Corpus metas name files with their extension (`/vt loot load Basic.utl`);
 * the stores are keyed by profile name. Try the name as given, then without a
 * known extension.
 */
function loadByNameOrStem(load, name, exts) {
  const r = load(name);
  if (r && r.ok) return { r, name };
  const m = new RegExp(`^(.+)\\.(?:${exts.join("|")})$`, "i").exec(name);
  if (m) {
    const r2 = load(m[1]);
    if (r2 && r2.ok) return { r: r2, name: m[1] };
  }
  return { r, name };
}

/**
 * Split a command line. Accepts "/rs …" and the slash-less "rs …" (`!bot rs`).
 * @returns {{prefix:string, verb:string, args:string[], rest:string, raw:string} | null}
 */
export function parseRsLine(line) {
  if (typeof line !== "string") return null;
  let s = line.replace(/^\s+/, "");
  if (s.startsWith("/")) s = s.slice(1);
  const m = /^([A-Za-z]+)(?=\s|$)/.exec(s);
  if (!m) return null;
  const prefix = m[1].toLowerCase();
  if (!RS_PREFIXES.has(prefix)) return null;
  const after = s.slice(m[1].length).replace(/^\s+/, "");
  const vm = /^\S+/.exec(after);
  const verbRaw = vm ? vm[0] : "";
  const rest = vm ? after.slice(verbRaw.length).replace(/^\s+/, "") : "";
  const args = rest.split(/\s+/).filter(Boolean);
  return { prefix, verb: verbRaw.toLowerCase(), args, rest, raw: line };
}

function boolWord(s) {
  const t = String(s ?? "").trim().toLowerCase();
  if (t === "true" || t === "on" || t === "yes" || t === "1") return true;
  if (t === "false" || t === "off" || t === "no" || t === "0") return false;
  return null;
}

function fmtOpt(v) {
  if (v === undefined || v === null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return String(v);
    if (Number.isInteger(v)) return String(v);
    return String(Number(v.toPrecision(7)));
  }
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch (_) {
      return String(v);
    }
  }
  return String(v);
}

/**
 * Jump arguments (G:220 + UB). VTank form when any argument is true|false:
 * `[heading] <true|false> [ms]` (in place, unless the verb carries w/x/z/c);
 * otherwise the UB form `jump[swzxc] [heading] [hold]` where ONE integer is the
 * hold time (C# RynthAiCommands.cs:986-990 quirk) and one non-integer is the
 * heading. Letters: w forward, x back, z strafe left, c strafe right, s shift.
 * @returns {{ok:true, headingDeg:number|null, shift:boolean, ms:number, direction:string, form:"vtank"|"ub"} | {ok:false, error:string}}
 */
export function parseJumpArgs(verb, args) {
  const letters = String(verb ?? "").toLowerCase().replace(/^jump/, "");
  if (/[^swzxc]/.test(letters)) return { ok: false, error: `unknown jump letters "${letters}" (use s w z x c)` };
  let direction = "none";
  for (const ch of letters) {
    if (JUMP_DIRS[ch]) {
      direction = JUMP_DIRS[ch];
      break;
    }
  }
  const words = (args || []).map((a) => String(a));
  const boolAt = words.findIndex((w) => /^(true|false)$/i.test(w));
  let headingDeg = null;
  let shift = letters.includes("s");
  let ms = 0;
  let form;
  const num = (w, what) => {
    const n = Number(w);
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(String(w)) || !Number.isFinite(n)) throw new Error(`"${w}" is not a ${what}`);
    return n;
  };
  try {
    if (boolAt >= 0) {
      form = "vtank";
      const before = words.slice(0, boolAt);
      const after = words.slice(boolAt + 1);
      if (before.length > 1 || after.length > 1) return { ok: false, error: "usage: jump [heading] [true|false] [ms]" };
      if (before.length) headingDeg = num(before[0], "heading");
      shift = words[boolAt].toLowerCase() === "true";
      if (after.length) ms = num(after[0], "charge time");
    } else {
      form = "ub";
      if (words.length > 2) return { ok: false, error: "usage: jump[swzxc] [heading] [holdMs]" };
      if (words.length === 2) {
        headingDeg = num(words[0], "heading");
        ms = num(words[1], "hold time");
      } else if (words.length === 1) {
        const n = num(words[0], "number");
        if (Number.isInteger(n) && !/\./.test(words[0])) ms = n;
        else headingDeg = n;
      }
    }
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
  if (headingDeg !== null && !(headingDeg >= 0 && headingDeg < 360)) return { ok: false, error: "heading must be in [0, 360)" };
  if (!(ms >= 0 && ms <= 1000)) return { ok: false, error: "charge time must be 0-1000 ms" };
  return { ok: true, headingDeg, shift, ms, direction, form };
}

/** `/rs addnavjump [heading] [shift] [charge] [strafeleft|straferight|forward]` */
export function parseAddNavJumpArgs(args) {
  let headingDeg = null;
  let holdShift = false;
  let delayMs = 0;
  let direction = null;
  const nums = [];
  for (const w of args || []) {
    const lw = String(w).toLowerCase();
    if (lw === "true" || lw === "false") holdShift = lw === "true";
    else if (DIRECTION_WORDS.includes(lw)) direction = lw;
    else if (/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(lw)) nums.push(Number(lw));
    else return { ok: false, error: `cannot read "${w}" (usage: addnavjump [heading] [true|false] [charge] [strafeleft|straferight|forward])` };
  }
  if (nums.length > 2) return { ok: false, error: "too many numbers (heading, charge)" };
  if (nums.length >= 1) headingDeg = nums[0];
  if (nums.length === 2) delayMs = nums[1];
  if (headingDeg !== null && !(headingDeg >= 0 && headingDeg < 360)) return { ok: false, error: "heading must be in [0, 360)" };
  if (!(delayMs >= 0 && delayMs <= 1000)) return { ok: false, error: "charge must be 0-1000 ms" };
  return { ok: true, headingDeg, holdShift, delayMs, direction };
}

// ── the /rs (== /vt) verb table ────────────────────────────────────────────

const RS = new Map();
const RS_HELP = [];
function verb(names, help, run) {
  for (const n of names.split("|")) RS.set(n, run);
  if (help) RS_HELP.push(help);
}

verb("help", "help — this list", (c) => c.help("rs"));

// G:7 Run Macro = pause/resume (OperatorControl through the HUD, else bot.control).
function runMacro(which) {
  return (c) => {
    const hud = c.ctx.hud();
    const fn = hud && typeof hud[which === "toggle" ? "toggleRun" : which] === "function" ? hud[which === "toggle" ? "toggleRun" : which] : null;
    if (fn) {
      let p;
      try {
        p = Promise.resolve(fn.call(hud));
      } catch (e) {
        return c.fail(`${which} failed: ${errText(e)}`);
      }
      c.out(`${RS_TAG} ${which === "start" ? "starting" : which === "stop" ? "stopping" : "toggling"} the macro…`);
      c.pending(
        p.then(
          (r) => {
            if (r && r.ok === false) c.late(`${RS_TAG} ${which}: ${r.error || "refused"}`, CAT_ERROR);
            else c.late(`${RS_TAG} macro ${which === "stop" ? "paused" : which === "start" ? "running" : "toggled"}`);
          },
          (e) => c.late(`${RS_TAG} ${which} failed: ${errText(e)}`, CAT_ERROR),
        ),
      );
      return undefined;
    }
    const bot = c.ctx.bot();
    const ctl = bot && bot.control;
    if (!ctl) return c.fail("open the RynthSuite HUD or use ?bot=1");
    try {
      if (which === "start") ctl.resume();
      else if (which === "stop") ctl.stop({ persist: true, reason: `/${c.prefix} stop` });
      else if (typeof ctl.toggle === "function") ctl.toggle({ persist: true, reason: `/${c.prefix} toggle` });
      else if (ctl.isStopped?.()) ctl.resume();
      else ctl.stop({ persist: true, reason: `/${c.prefix} toggle` });
    } catch (e) {
      return c.fail(`${which} failed: ${errText(e)}`);
    }
    const held = !!(ctl.isStopped?.() ?? bot.kernel?.operatorHeld);
    return c.out(`${RS_TAG} macro ${held ? "paused" : "running"}`);
  };
}
verb("start", "start | stop | toggle — Run Macro (pause / resume the bot)", runMacro("start"));
verb("stop", null, runMacro("stop"));
verb("toggle", null, runMacro("toggle"));

// G:10-11 Force Buff / Cancel.
function forceBuff(cancel) {
  return (c) => {
    const buff = c.ctx.bot()?.buff;
    const m = cancel ? "cancelForceRebuff" : "forceRebuff";
    if (buff && typeof buff[m] === "function") {
      try {
        buff[m]();
      } catch (e) {
        return c.fail(`${cancel ? "cancel force buff" : "force buff"} failed: ${errText(e)}`);
      }
      return c.out(`${RS_TAG} ${cancel ? "force buff cancelled" : "force buffing"}`);
    }
    const hud = c.ctx.hud();
    if (hud && typeof hud[m] === "function") {
      const r = hud[m]();
      return r && r.ok === false ? c.fail(r.error || "refused") : c.out(`${RS_TAG} ${cancel ? "force buff cancelled" : "force buffing"}`);
    }
    return c.fail("there is no buff loop on this bot (start the bot with buffs)");
  };
}
verb("forcebuff", "forcebuff | cancelforcebuff | cancelbuff", forceBuff(false));
verb("cancelforcebuff|cancelbuff", null, forceBuff(true));

// K3 options (D19: an unknown name is an error and writes nothing).
verb("opt", "opt list [filter] | opt get <name> | opt set <name> <value> | opt remember|restore <name>", (c) => {
  const o = c.options();
  if (!o) return c.fail("settings are not available yet (log in first)");
  const sub = (c.args[0] ?? "").toLowerCase();
  const after = c.rest.replace(/^\S+\s*/, "");
  if (sub === "list") {
    const rows = o.list(after.trim() || undefined) || [];
    c.out(`${RS_TAG} ${rows.length} option(s)${after.trim() ? ` matching "${after.trim()}"` : ""}:`);
    for (const r of rows) {
      const shown = fmtOpt(r.vtValue !== undefined ? r.vtValue : r.value);
      const name = r.vtName && r.vtName !== r.key ? `${r.vtName} (${r.key})` : r.key;
      c.out(`  ${name} = ${shown}${r.inert ? " (not implemented on web)" : ""}`);
    }
    return undefined;
  }
  const name = (c.args[1] ?? "").trim();
  if (sub === "get") {
    if (!name) return c.fail(`usage: /${c.prefix} opt get <name>`);
    const r = o.get(name, { vtUnits: true });
    if (r && r.ok) return c.out(`${RS_TAG} ${name} = ${fmtOpt(r.value)}`);
    if (o.bag?.has?.(name)) return c.out(`${RS_TAG} ${name} = ${fmtOpt(o.bag.get(name))} (meta option)`);
    return c.fail(r?.error || `unknown option ${name}`);
  }
  if (sub === "set") {
    const value = after.replace(/^\S+\s*/, "");
    if (!name || value === "") return c.fail(`usage: /${c.prefix} opt set <name> <value>`);
    const r = o.set(name, value.trim(), { source: "command" });
    if (!r || !r.ok) return c.fail(r?.error || `unknown option ${name}`);
    if (r.saveError) c.out(`${RS_TAG} (not saved: ${r.saveError})`, CAT_ERROR);
    return c.out(r.echo || `${RS_TAG} Set option ${name} = ${fmtOpt(r.value)}`);
  }
  if (sub === "remember") {
    if (!name) return c.fail(`usage: /${c.prefix} opt remember <name>`);
    const r = o.get(name);
    if (!r || !r.ok) return c.fail(r?.error || `unknown option ${name}`);
    c.remembered().set(String(r.key ?? r.row?.key ?? name).toLowerCase(), { key: r.key ?? r.row?.key ?? name, value: r.value });
    return c.out(`${RS_TAG} remembered ${name} = ${fmtOpt(r.value)}`);
  }
  if (sub === "restore") {
    if (!name) return c.fail(`usage: /${c.prefix} opt restore <name>`);
    const look = o.get(name);
    const key = String((look && look.ok && (look.key ?? look.row?.key)) || name).toLowerCase();
    const saved = c.remembered().get(key);
    if (!saved) return c.fail(`nothing remembered for ${name}`);
    const r = o.set(saved.key, saved.value, { source: "command" });
    if (!r || !r.ok) return c.fail(r?.error || "restore failed");
    return c.out(`${RS_TAG} restored ${name} = ${fmtOpt(r.value)}`);
  }
  return c.fail(`usage: /${c.prefix} opt list|get|set|remember|restore …`);
});

// K6 settings profiles (corpus: `/vt settings loadchar Quest Profile`).
verb(
  "settings",
  "settings list | load <name> | saveas <name> [mine] | preset vtank | importhud | loadchar <name> | savechar <name>",
  (c) => {
    const o = c.options();
    if (!o) return c.fail("settings are not available yet (log in first)");
    const sub = (c.args[0] ?? "").toLowerCase();
    const rest = c.rest.replace(/^\S+\s*/, "").trim();
    const profiles = o.profiles;
    const label = () => {
      const a = profiles?.active?.();
      return a ? a.name : "?";
    };
    switch (sub) {
      case "list": {
        const list = profiles?.list?.() || [];
        const act = profiles?.active?.();
        c.out(`${RS_TAG} settings profiles:`);
        for (const p of list) {
          const on = act && act.name === p.name && act.kind === p.kind;
          c.out(`  ${on ? "*" : " "} ${p.label ?? p.name}`);
        }
        return undefined;
      }
      case "load":
      case "loadchar": {
        if (!rest) return c.fail(`usage: /${c.prefix} settings ${sub} <name>`);
        const r = o.selectProfile(rest, sub === "loadchar" ? "char" : undefined);
        return r && r.ok ? c.out(`${RS_TAG} settings profile "${label()}" loaded`) : c.fail(r?.error || "load failed");
      }
      case "saveas":
      case "savechar": {
        let name = rest;
        let mineOnly = sub === "savechar";
        if (sub === "saveas") {
          const m = /^(.*\S)\s+mine$/i.exec(rest);
          if (m) {
            name = m[1].trim();
            mineOnly = true;
          }
        }
        if (!name) return c.fail(`usage: /${c.prefix} settings ${sub} <name>${sub === "saveas" ? " [mine]" : ""}`);
        const r = o.saveAs(name, { mineOnly });
        return r && r.ok ? c.out(`${RS_TAG} settings saved as "${label()}"${mineOnly ? " (this character only)" : ""}`) : c.fail(r?.error || "save failed");
      }
      case "preset": {
        const which = (c.args[1] ?? "vtank").toLowerCase();
        const r = o.applyPreset(which);
        return r && r.ok ? c.out(`${RS_TAG} preset ${which} applied to "${label()}"`) : c.fail(r?.error || "preset failed");
      }
      case "importhud": {
        const r = o.importHud();
        return r && r.ok ? c.out(`${RS_TAG} imported ${(r.imported || []).length} HUD setting(s) into "${label()}"`) : c.fail(r?.error || "import failed");
      }
      default:
        return c.fail(`usage: /${c.prefix} settings list|load|saveas|preset|importhud|loadchar|savechar …`);
    }
  },
);

// Corpus CapNavPoints idiom: `/vt refresh` succeeds and does nothing.
verb("refresh", "refresh — (no-op on web)", (c) => c.out(`${RS_TAG} refresh: nothing to do on web`));

// R14/R15 + route control (ActiveNav).
verb(
  "nav",
  "nav save|load <name> | nav clear|start|stop|status|list | nav type <circular|linear|follow|once> | nav setcurrent <n> | nav next|prev | nav delete <n>",
  (c) => {
    const sub = (c.args[0] ?? "").toLowerCase();
    const rest = c.rest.replace(/^\S+\s*/, "").trim();
    if (sub === "list") {
      const store = c.vt()?.navProfiles;
      if (!store || typeof store.list !== "function") return c.fail("start the bot first");
      const list = store.list() || [];
      return c.out(`${RS_TAG} nav profiles (${list.length}): ${list.map((p) => p.name).join(", ") || "(none)"}`);
    }
    const nav = c.needNav();
    if (!nav) return undefined;
    switch (sub) {
      case "save": {
        if (!rest) return c.fail(`usage: /${c.prefix} nav save <name>`);
        const r = nav.save(rest);
        return r && r.ok ? c.out(`${RS_TAG} nav profile "${rest}" saved (${nav.route().points.length} points)`) : c.fail(r?.error || "save failed");
      }
      case "load": {
        if (!rest) return c.fail(`usage: /${c.prefix} nav load <name>`);
        const { r } = loadByNameOrStem((n) => nav.loadByName(n), rest, ["nav"]);
        if (!r || !r.ok) return c.fail(r?.error || `no nav profile named "${rest}"`);
        const st = nav.status();
        c.out(`${RS_TAG} nav "${st.name ?? rest}" loaded (${ROUTE_NAMES[st.type] ?? st.type}, ${st.n} points, waypoint ${st.n ? st.i + 1 : 0})`);
        for (const w of (r.warnings || []).slice(0, 3)) c.out(`${RS_TAG} warning: ${w}`, CAT_ERROR);
        return undefined;
      }
      case "clear":
        nav.clear();
        return c.out(`${RS_TAG} route cleared`);
      case "start": {
        if (c.motionRefused("nav start")) return undefined;
        const r = nav.setEnabled(true);
        if (r && r.ok === false) return c.fail(r.error || "could not enable navigation");
        nav.resume?.();
        return c.out(`${RS_TAG} navigation on`);
      }
      case "stop": {
        const r = nav.setEnabled(false);
        if (r && r.ok === false) return c.fail(r.error || "could not disable navigation");
        return c.out(`${RS_TAG} navigation off`);
      }
      case "status":
      case "": {
        const st = nav.status();
        const bits = [
          `"${st.name ?? "(unnamed)"}"`,
          ROUTE_NAMES[st.type] ?? String(st.type),
          `${st.n ? st.i + 1 : 0}/${st.n}`,
          st.enabled ? "enabled" : "disabled",
        ];
        if (st.paused) bits.push(`paused: ${st.paused.reason}`);
        if (st.reversed) bits.push("reversed");
        if (st.followTarget) bits.push(`following ${st.followTarget.name || st.followTarget.guid}`);
        if (st.exec) bits.push(`exec: ${st.exec}`);
        if (st.lastResult) bits.push(`last: ${st.lastResult}`);
        return c.out(`${RS_TAG} nav ${bits.join(", ")}`);
      }
      case "type": {
        const t = ROUTE_TYPES[(c.args[1] ?? "").toLowerCase()];
        if (!t) return c.fail(`usage: /${c.prefix} nav type circular|linear|follow|once`);
        nav.setType(t);
        return c.out(`${RS_TAG} route type ${ROUTE_NAMES[t]}`);
      }
      case "setcurrent": {
        const n = Number(c.args[1]);
        const len = nav.route().points.length;
        if (!Number.isInteger(n) || n < 1 || n > len) return c.fail(`usage: /${c.prefix} nav setcurrent <1-${len}>`);
        nav.setActive(n - 1);
        return c.out(`${RS_TAG} current waypoint ${n}/${len}`);
      }
      case "next":
      case "prev": {
        const r = nav.step(sub === "next" ? 1 : -1);
        return c.out(`${RS_TAG} current waypoint ${(r?.index ?? nav.route().activeIndex) + 1}/${nav.route().points.length}`);
      }
      case "delete": {
        const n = Number(c.args[1]);
        const len = nav.route().points.length;
        if (!Number.isInteger(n) || n < 1 || n > len) return c.fail(`usage: /${c.prefix} nav delete <1-${len}>`);
        const r = nav.removeAt(n - 1);
        return r && r.ok === false ? c.fail(r.error) : c.out(`${RS_TAG} waypoint ${n} deleted`);
      }
      default:
        return c.fail(`usage: /${c.prefix} nav save|load|clear|start|stop|status|list|type|setcurrent|next|prev|delete …`);
    }
  },
);

// R16 addnavpt [coords] — always appended to the END; Z = pose.z/240 when not given.
verb("addnavpt", "addnavpt [coords] — e.g. 12.3N 41.5E (no coords = here)", (c) => {
  const nav = c.needNav();
  if (!nav) return undefined;
  const h = c.host();
  const pose = h?.TryGetPlayerPose?.() || h?.TryGetPlayerPoseLive?.() || null;
  const here = poseToCoords(pose);
  let ns;
  let ew;
  let z;
  if (c.args.length) {
    const p = parseCoords(c.args);
    if (!p.ok) return c.fail(`addnavpt: ${p.error}`);
    ns = p.ns;
    ew = p.ew;
    z = p.z !== undefined ? p.z : here ? here.z : 0;
  } else {
    if (!here) return c.fail("addnavpt: no player position yet");
    ({ ns, ew, z } = here);
  }
  const idx = nav.add({ type: 0, ew, ns, z, flag: "0" }, { mode: "end" });
  if (!(idx >= 0)) return c.fail("addnavpt: the point was refused");
  return c.out(`${RS_TAG} added nav point ${idx + 1} at ${coordsToText(ns, ew)}`);
});

// R17 addnavcheckpoint (type 8 at the pose).
verb("addnavcheckpoint", "addnavcheckpoint — checkpoint here", (c) => {
  const nav = c.needNav();
  if (!nav) return undefined;
  const r = nav.addHere(8, {}, { mode: "end" });
  return r && r.ok ? c.out(`${RS_TAG} added checkpoint ${r.index + 1}`) : c.fail(`addnavcheckpoint: ${r?.error || "refused"}`);
});

// R19/R20 addnavjump [heading] [shift] [charge] [direction].
verb("addnavjump", "addnavjump [heading] [true|false] [charge] [strafeleft|straferight|forward]", (c) => {
  const nav = c.needNav();
  if (!nav) return undefined;
  const p = parseAddNavJumpArgs(c.args);
  if (!p.ok) return c.fail(`addnavjump: ${p.error}`);
  const fields = { holdShift: p.holdShift, delayMs: p.delayMs };
  if (p.headingDeg !== null) fields.headingDeg = p.headingDeg;
  if (p.direction) fields.direction = p.direction;
  const r = nav.addHere(9, fields, { mode: "end" });
  return r && r.ok ? c.out(`${RS_TAG} added jump ${r.index + 1}`) : c.fail(`addnavjump: ${r?.error || "refused"}`);
});

// R18 jump (VTank and UB forms).
function jumpVerb(c) {
  const p = parseJumpArgs(c.verb, c.args);
  if (!p.ok) return c.fail(`jump: ${p.error}`);
  if (c.motionRefused("jump")) return undefined;
  const nav = c.needNav();
  if (!nav) return undefined;
  const r = nav.requestJump({ headingDeg: p.headingDeg, shift: p.shift, ms: p.ms, direction: p.direction });
  if (!r || r.ok === false) return c.fail(`jump: ${r?.error || "refused"}`);
  const head = p.headingDeg === null ? "current heading" : `${p.headingDeg}°`;
  return c.out(`${RS_TAG} jump: ${head}, ${p.shift ? "shift" : "no shift"}, ${p.ms} ms${p.direction !== "none" ? `, ${p.direction}` : ""}`);
}
verb("jump", "jump [heading] [true|false] [ms]   (UB: jump[swzxc] [heading] [holdMs])", jumpVerb);
const JUMP_RE = /^jump[swzxc]+$/;

// R21/R22 reverseroute [true|false] / reverseroutequery.
verb("reverseroute", "reverseroute [true|false] | reverseroutequery", (c) => {
  const nav = c.needNav();
  if (!nav) return undefined;
  let flag;
  if (c.args.length) {
    flag = boolWord(c.args[0]);
    if (flag === null) return c.fail(`usage: /${c.prefix} reverseroute [true|false]`);
  }
  const v = nav.reverse(flag);
  return c.out(`${RS_TAG} reverseroute = ${v ? "true" : "false"}`);
});
verb("reverseroutequery", null, (c) => {
  const nav = c.needNav();
  if (!nav) return undefined;
  return c.out(nav.route().reversed ? "true" : "false");
});

// R3 follow <name>|leader|off (route type Follow; enables navigation).
verb("follow", "follow <name>|leader|off|status", (c) => {
  const nav = c.needNav();
  if (!nav) return undefined;
  const arg = c.rest.trim();
  const low = arg.toLowerCase();
  if (!arg || low === "status") {
    const t = nav.route().followTarget;
    return c.out(`${RS_TAG} follow: ${t ? `${t.name || "?"} (0x${(t.guid >>> 0).toString(16).toUpperCase()})` : "nobody"}`);
  }
  if (low === "off" || low === "none" || low === "stop") {
    nav.setFollowTarget(null);
    return c.out(`${RS_TAG} follow off`);
  }
  if (c.motionRefused("follow")) return undefined;
  const h = c.host();
  let guid = 0;
  let name = arg;
  if (low === "leader") {
    const f = h?.TryGetFellowshipInfo?.() || null;
    guid = Number(f?.leaderGuid) >>> 0;
    if (!guid) return c.fail("follow leader: not in a fellowship");
    const me = Number(h?.GetPlayerId?.()) >>> 0;
    if (guid === me) return c.fail("follow leader: you are the leader");
    const m = Array.isArray(f.members) ? f.members.find((x) => (Number(x.guid) >>> 0) === guid) : null;
    name = (m && m.name) || h?.TryGetObjectName?.(guid) || "";
  } else {
    const found = typeof h?.FindNearbyByName === "function" ? h.FindNearbyByName(arg, { player: true }) : null;
    const hit = Array.isArray(found) && found.length ? found[0] : c.actions()?.findNearestByName(arg, { partial: false });
    if (!hit) return c.fail(`follow: ${arg} is not in sight`);
    guid = Number(hit.guid) >>> 0;
    name = hit.name || arg;
  }
  nav.setFollowTarget({ guid, name });
  const r = nav.setEnabled(true);
  nav.resume?.();
  if (r && r.ok === false) return c.fail(r.error || "could not enable navigation");
  return c.out(`${RS_TAG} following ${name}`);
});

// K4 meta.
function needMeta(c) {
  const meta = c.vt()?.meta;
  if (!meta) {
    c.fail("start the bot first");
    return null;
  }
  return meta;
}
verb("meta", "meta load <name> | meta list|state|enable|disable | meta debug on|off | meta setstate <state>", (c) => {
  const sub = (c.args[0] ?? "").toLowerCase();
  const rest = c.rest.replace(/^\S+\s*/, "").trim();
  const lib = c.vt()?.library;
  if (sub === "load" || sub === "list") {
    if (!lib) return c.fail("start the bot first");
    if (sub === "list") {
      const list = lib.listMetas?.() || [];
      return c.out(`${RS_TAG} metas (${list.length}): ${list.map((m) => m.name).join(", ") || "(none)"}`);
    }
    if (!rest) return c.fail(`usage: /${c.prefix} meta load <name>`);
    const { r, name } = loadByNameOrStem((n) => lib.loadMeta(n), rest, ["met", "af", "json"]);
    if (!r || !r.ok) return c.fail(r?.error || `no meta named "${rest}"`);
    c.out(`${RS_TAG} meta "${name}" loaded (state Default)`);
    for (const w of (r.warnings || []).slice(0, 3)) c.out(`${RS_TAG} warning: ${w}`, CAT_ERROR);
    return undefined;
  }
  const meta = needMeta(c);
  if (!meta) return undefined;
  switch (sub) {
    case "state":
    case "":
      return c.out(`${RS_TAG} meta state: ${meta.state ?? "?"}${meta.enabled === false ? " (meta disabled)" : ""}`);
    case "enable":
    case "disable":
      meta.enabled = sub === "enable";
      return c.out(`${RS_TAG} meta ${sub}d`);
    case "debug": {
      const on = boolWord(c.args[1] ?? "on");
      if (on === null) return c.fail(`usage: /${c.prefix} meta debug on|off`);
      meta.setDebug?.(on);
      return c.out(`${RS_TAG} meta debug ${on ? "on" : "off"}`);
    }
    case "setstate":
      if (!rest) return c.fail(`usage: /${c.prefix} meta setstate <state>`);
      meta.enterState(rest, "command");
      return c.out(`${RS_TAG} meta state → ${rest}`);
    default:
      return c.fail(`usage: /${c.prefix} meta load|list|state|enable|disable|debug|setstate …`);
  }
});
verb("setmetastate", "setmetastate <state>", (c) => {
  const state = c.rest.trim();
  if (!state) return c.fail(`usage: /${c.prefix} setmetastate <state>`);
  const meta = needMeta(c);
  if (!meta) return undefined;
  meta.enterState(state, "command");
  return c.out(`${RS_TAG} meta state → ${state}`);
});

// mexec <expr> — evaluate in the meta scope; prints "[<type>] <value>".
verb("mexec", "mexec <expression>", (c) => {
  const src = c.rest;
  if (!src.trim()) return c.fail(`usage: /${c.prefix} mexec <expression>`);
  const rt = c.vt()?.expr;
  if (!rt || typeof rt.evaluate !== "function") return c.fail("start the bot first");
  let v;
  try {
    v = rt.evaluate(src);
  } catch (e) {
    v = { t: "err", msg: errText(e) };
  }
  if (v && typeof v === "object" && v.t === "err") return c.out(`[Error] ${v.msg}`, CAT_ERROR);
  let shown;
  if (typeof v === "boolean") shown = v ? "true" : "false";
  else if (v && typeof v === "object" && v.t === "wobj") shown = `0x${(v.guid >>> 0).toString(16).toUpperCase().padStart(8, "0")}: ${v.name ?? ""}`;
  else shown = valueToString(v);
  return c.out(`[${valueTypeName(v)}] ${shown}`);
});

// M26 / G:123.
verb("listmonstervariables", "listmonstervariables", (c) => {
  const vars = Array.isArray(c.vt()?.monsterVariables)
    ? c.vt().monsterVariables.map((r) => [r.name, !!r.dynamic, r.doc ?? ""])
    : LISTED_MONSTER_VARIABLES;
  c.out(`${RS_TAG} monster variables:`);
  for (const [name, dynamic, doc] of vars) c.out(`  ${name}${dynamic ? " (DYNAMIC)" : ""} — ${doc}`);
  return undefined;
});

verb("echo", "echo <text>", (c) => c.out(c.rest));

// /vt setattackbar <0..1> → MeleeAttackPower + MissileAttackPower.
verb("setattackbar", "setattackbar <0..1>", (c) => {
  const o = c.options();
  if (!o) return c.fail("settings are not available yet");
  const v = Number(c.args[0]);
  if (!c.args.length || !Number.isFinite(v) || v < 0 || v > 1) return c.fail(`usage: /${c.prefix} setattackbar <0..1>`);
  const a = o.set("MeleeAttackPower", v, { source: "command" });
  const b = o.set("MissileAttackPower", v, { source: "command" });
  if (!a?.ok || !b?.ok) return c.fail(a?.error || b?.error || "not set");
  return c.out(`${RS_TAG} attack bar set to ${fmtOpt(v)}`);
});

// Loot profiles (.utl) through the composition's library (critic C2).
verb("loot|lootprofile", "loot load <name> | loot none | loot list", (c) => {
  const lib = c.vt()?.library;
  if (!lib) return c.fail("start the bot first");
  const sub = (c.args[0] ?? "").toLowerCase();
  const rest = c.rest.replace(/^\S+\s*/, "").trim();
  if (sub === "list") {
    const list = lib.listLoot?.() || [];
    return c.out(`${RS_TAG} loot profiles (${list.length}): ${list.map((p) => p.name).join(", ") || "(none)"}`);
  }
  if (sub === "none" || sub === "clear") {
    const r = lib.clearLoot?.();
    return r && r.ok === false ? c.fail(r.error || "failed") : c.out(`${RS_TAG} loot profile cleared (value floor only)`);
  }
  if (sub === "load") {
    if (!rest) return c.fail(`usage: /${c.prefix} loot load <name>`);
    const { r, name } = loadByNameOrStem((n) => lib.loadLoot(n), rest, ["utl"]);
    return r && r.ok ? c.out(`${RS_TAG} loot profile "${name}" loaded`) : c.fail(r?.error || `no loot profile named "${rest}"`);
  }
  return c.fail(`usage: /${c.prefix} loot load <name>|none|list`);
});

verb("ui", "ui [tab] — open the VTank panel", (c) => {
  if (typeof c.ctx.raw.openPanel !== "function") return c.fail("the VT panel is not available here");
  const tab = c.args[0];
  let p;
  try {
    p = Promise.resolve(c.ctx.raw.openPanel(tab));
  } catch (e) {
    return c.fail(`ui: ${errText(e)}`);
  }
  c.pending(p.then(() => {}, (e) => c.late(`${RS_TAG} ui: ${errText(e)}`, CAT_ERROR)));
  return undefined;
});

/** Verb summary lines for `/rs help`. */
export function rsHelpLines() {
  return RS_HELP.map((h) => `  /rs ${h}`);
}

// ── RsCtx normalisation ─────────────────────────────────────────────────────

function normCtx(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const call = (k) => {
    try {
      return typeof r[k] === "function" ? r[k]() ?? null : null;
    } catch (_) {
      return null;
    }
  };
  const bot = () => call("bot");
  const vt = () => call("vt") ?? bot()?.vt ?? null;
  const session = () => call("session") ?? vt()?.session ?? null;
  const hud = () => call("hud");
  const host = () => call("host") ?? bot()?.host ?? null;
  return {
    raw: r,
    bot,
    vt,
    session,
    hud,
    host,
    now() {
      try {
        const t = typeof r.now === "function" ? Number(r.now()) : Date.now();
        return Number.isFinite(t) ? t : Date.now();
      } catch (_) {
        return Date.now();
      }
    },
    operatorHeld() {
      try {
        if (typeof r.operatorHeld === "function") return r.operatorHeld() === true;
      } catch (_) {
        return false;
      }
      return bot()?.kernel?.operatorHeld === true;
    },
    print(text, cat = CAT_INFO) {
      try {
        if (typeof r.print === "function") r.print(text, cat);
        else host()?.WriteToChatWindow?.(text, cat);
      } catch (_) {
        /* output is best effort */
      }
    },
    invokeChatParser(line) {
      try {
        if (typeof r.invokeChatParser === "function") return r.invokeChatParser(line) !== false;
        return host()?.InvokeChatParser?.(line) === true;
      } catch (_) {
        return false;
      }
    },
  };
}

// ── the dispatcher ─────────────────────────────────────────────────────────

/**
 * @param {{getCtx: () => object}} deps  RsCtx (PLAN §3.7) — every member optional.
 * @returns {{run(line:string, opts?:{source?:string}): object, wouldHandle(line:string): boolean,
 *            help(): string[], pump(nowMs:number): void, runChat(line:string, opts?:{source?:string}): object,
 *            pendingDelayed(): number}}
 */
export function createRsDispatcher({ getCtx } = {}) {
  const fallbackRemembered = new Map();
  const delayQueue = []; // {due, seq, line, source}
  let delaySeq = 0;
  let pendingLoot = null; // {name, partial, until, source}
  const giveQueue = []; // {item:{guid,name,amount}, target:{guid,name}, source}
  let lastGiveAt = -Infinity;
  let ownActions = null;
  let ownActionsHost = null;
  let depth = 0;

  const ctxNow = () => {
    try {
      return normCtx(typeof getCtx === "function" ? getCtx() : null);
    } catch (_) {
      return normCtx(null);
    }
  };

  function actionsFor(C) {
    const shared = C.vt()?.actions;
    if (shared) return shared;
    const h = C.host();
    if (!ownActions || ownActionsHost !== h) {
      ownActionsHost = h;
      ownActions = createVtActions({ host: () => C.host(), getBot: () => C.bot(), print: (t, k) => C.print(t, k), now: () => C.now() });
    }
    return ownActions;
  }

  function rememberedFor(C) {
    const s = C.session();
    if (s && typeof s === "object") {
      s.ext = s.ext && typeof s.ext === "object" ? s.ext : {};
      if (!(s.ext.rsRemembered instanceof Map)) s.ext.rsRemembered = new Map();
      return s.ext.rsRemembered;
    }
    return fallbackRemembered;
  }

  /** The local chain for a non-command chat line: /ls, /lifestone, /ah, then the game. */
  function chainOther(C, line) {
    const t = line.trim();
    const verb = (/^\/(\S+)/.exec(t)?.[1] ?? "").toLowerCase();
    const h = C.host();
    if ((verb === "ls" || verb === "lifestone") && typeof h?.RecallToLifestone === "function") {
      h.RecallToLifestone();
      return { via: "lifestone" };
    }
    if ((verb === "ah" || verb === "allegiancehometown") && typeof h?.RecallAllegianceHometown === "function") {
      h.RecallAllegianceHometown();
      return { via: "allegiance" };
    }
    C.invokeChatParser(t);
    return { via: "game" };
  }

  function exec(parsed, st) {
    const C = st.C;
    const c = {
      ctx: C,
      prefix: parsed.prefix,
      verb: parsed.verb,
      args: parsed.args,
      rest: parsed.rest,
      raw: parsed.raw,
      source: st.source,
      out(text, cat = CAT_INFO) {
        st.lines.push({ text: String(text ?? ""), category: cat });
        return undefined;
      },
      fail(text) {
        const msg = String(text ?? "error");
        if (!st.error) st.error = msg;
        st.lines.push({ text: msg.startsWith("[") ? msg : `${RS_TAG} ${msg}`, category: CAT_ERROR });
        return undefined;
      },
      late(text, cat = CAT_INFO) {
        if (st.source !== "tell") C.print(String(text), cat);
      },
      pending(p) {
        st.pendings.push(Promise.resolve(p).catch(() => {}));
      },
      bot: () => C.bot(),
      vt: () => C.vt(),
      host: () => C.host(),
      options: () => C.vt()?.options ?? C.session()?.options ?? null,
      actions: () => actionsFor(C),
      quests: () => C.vt()?.quests ?? null,
      remembered: () => rememberedFor(C),
      needNav() {
        const nav = C.vt()?.nav;
        if (!nav) {
          c.fail("start the bot first");
          return null;
        }
        return nav;
      },
      motionRefused(label) {
        if (C.operatorHeld()) {
          c.fail(`${label} refused: the bot is paused (Run Macro is off)`);
          return true;
        }
        let portal = false;
        try {
          portal = C.host()?.IsPortalSpaceActive?.() === true;
        } catch (_) {
          portal = false;
        }
        if (portal) {
          c.fail(`${label} refused: in portal space`);
          return true;
        }
        return false;
      },
      rs(verbName, rest = "") {
        const r = String(rest ?? "");
        return exec({ prefix: parsed.prefix, verb: String(verbName).toLowerCase(), args: r.split(/\s+/).filter(Boolean), rest: r, raw: parsed.raw, viaRs: true }, st);
      },
      run(line) {
        const p = parseRsLine(line);
        if (!p) return c.chat(line);
        if (depth >= MAX_DEPTH) return c.fail("command nesting too deep");
        depth++;
        try {
          return exec(p, st);
        } finally {
          depth--;
        }
      },
      chat(line) {
        const t = String(line ?? "").trim();
        if (!t) return undefined;
        if (/^\//.test(t) && parseRsLine(t)) return c.run(t);
        chainOther(C, t);
        return undefined;
      },
      sendToGame(line) {
        C.invokeChatParser(line);
      },
      help(which) {
        if (which === "rs") {
          c.out(`${RS_TAG} /rs (== /vt) commands:`);
          for (const l of rsHelpLines()) c.out(l);
          c.out(`  compat: /ra help, /mt help, /ub help`);
          return undefined;
        }
        const table = COMPAT[which];
        c.out(`${RS_TAG} /${which} (${table.title}) commands:`);
        for (const l of table.helpLines()) c.out(l);
        return undefined;
      },
      queueDelay(ms, line) {
        if (delayQueue.length >= DELAY_QUEUE_MAX) return c.fail("delay queue is full");
        delayQueue.push({ due: C.now() + ms, seq: ++delaySeq, line, source: st.source });
        delayQueue.sort((a, b) => a.due - b.due || a.seq - b.seq);
        return undefined;
      },
      queueLoot(name, partial) {
        pendingLoot = { name, partial: !!partial, until: C.now() + LOOT_WAIT_MS, source: st.source };
      },
      queueGives(items, target) {
        for (const item of items) giveQueue.push({ item, target, source: st.source });
      },
    };
    try {
      if (parsed.prefix === "rs" || parsed.prefix === "vt" || parsed.viaRs) {
        if (!parsed.verb) return c.help("rs");
        const fn = RS.get(parsed.verb) || (JUMP_RE.test(parsed.verb) ? jumpVerb : null);
        if (!fn) return c.fail(`unknown /${parsed.prefix} command '${parsed.verb}'`);
        return fn(c);
      }
      const table = COMPAT[parsed.prefix];
      if (!parsed.verb) return c.help(parsed.prefix);
      const entry = table ? table.resolve(parsed.verb) : null;
      if (!entry) return c.fail(`unknown /${parsed.prefix} command '${parsed.verb}'`);
      return entry.run(c);
    } catch (e) {
      return c.fail(`/${parsed.prefix} ${parsed.verb} failed: ${errText(e)}`);
    }
  }

  function finish(st) {
    if (st.source !== "tell") for (const l of st.lines) st.C.print(l.text, l.category);
    const res = { handled: true, lines: st.lines };
    if (st.error) res.error = st.error;
    if (st.pendings.length) res.pending = Promise.all(st.pendings).then(() => undefined);
    return res;
  }

  function run(line, { source = "chat" } = {}) {
    const src = SOURCES.has(source) ? source : "chat";
    let parsed;
    try {
      parsed = parseRsLine(line);
    } catch (_) {
      parsed = null;
    }
    if (!parsed) return { handled: false, lines: [] };
    const st = { C: ctxNow(), source: src, lines: [], error: null, pendings: [] };
    if (depth >= MAX_DEPTH) {
      st.error = "command nesting too deep";
      st.lines.push({ text: `${RS_TAG} command nesting too deep`, category: CAT_ERROR });
      return finish(st);
    }
    depth++;
    try {
      exec(parsed, st);
    } finally {
      depth--;
    }
    return finish(st);
  }

  /** True for every SLASH line whose prefix is /rs /vt /ra /mt /ub (the eaten set). */
  function wouldHandle(line) {
    return typeof line === "string" && /^\s*\//.test(line) && parseRsLine(line) !== null;
  }

  /**
   * The local chat chain used by nav Chat points, meta Chat actions, chatbox[]
   * and /mt send: a /rs-family line runs here; /ls and /lifestone recall to
   * the lifestone; /ah recalls to the allegiance hometown; anything else goes
   * to host.InvokeChatParser (the page's slash router, then the server).
   */
  function runChat(line, { source = "meta" } = {}) {
    const t = String(line ?? "").trim();
    if (!t) return { handled: false, via: null, lines: [] };
    if (wouldHandle(t)) return { ...run(t, { source }), via: "rs" };
    const C = ctxNow();
    try {
      return { handled: false, lines: [], ...chainOther(C, t) };
    } catch (e) {
      return { handled: false, lines: [], via: "error", error: errText(e) };
    }
  }

  function pump(nowMs) {
    try {
      const C = ctxNow();
      if (C.operatorHeld()) return; // V-7: queued commands wait for RESUME
      const t = Number.isFinite(nowMs) ? nowMs : C.now();
      let guard = 0;
      while (delayQueue.length && delayQueue[0].due <= t && guard++ < 32) {
        const e = delayQueue.shift();
        if (wouldHandle(e.line)) run(e.line, { source: e.source });
        else chainOther(C, e.line);
      }
      if (pendingLoot) {
        if (t > pendingLoot.until) {
          if (pendingLoot.source !== "tell") C.print(`${RS_TAG} loot '${pendingLoot.name}': timed out`, CAT_ERROR);
          pendingLoot = null;
        } else {
          const r = actionsFor(C).lootFromOpen(pendingLoot.name, { partial: pendingLoot.partial });
          if (r.ok) {
            if (pendingLoot.source !== "tell") C.print(`${RS_TAG} looting ${r.name}`);
            pendingLoot = null;
          } else if (!r.retry) {
            pendingLoot = null;
          }
        }
      }
      if (giveQueue.length && t - lastGiveAt >= GIVE_GAP_MS) {
        const g = giveQueue[0];
        const r = actionsFor(C).give(g.item.guid, g.target.guid, g.item.amount);
        if (r.ok) {
          lastGiveAt = t;
          giveQueue.shift();
        } else if (!/in progress/.test(String(r.error))) {
          giveQueue.shift();
          if (g.source !== "tell") C.print(`${RS_TAG} give ${g.item.name}: ${r.error}`, CAT_ERROR);
        }
      }
    } catch (e) {
      try {
        console.log(`[vt:cmd] pump failed: ${errText(e)}`);
      } catch (_) {
        /* no console */
      }
    }
  }

  function help() {
    return [
      `${RS_TAG} /rs (== /vt) commands:`,
      ...rsHelpLines(),
      ...["ra", "mt", "ub"].flatMap((p) => [`${RS_TAG} /${p} (${COMPAT[p].title}):`, ...COMPAT[p].helpLines()]),
    ];
  }

  return {
    run,
    wouldHandle,
    help,
    pump,
    runChat,
    pendingDelayed: () => delayQueue.length,
  };
}
