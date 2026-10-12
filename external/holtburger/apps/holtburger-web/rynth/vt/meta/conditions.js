// rynth/vt/meta/conditions.js — the meta CONDITION table (PLAN §2.9, §3.12,
// Appendix B). One pure function per metaf keyword, evaluated over a per-pass
// run context built by engine.js. No imports, no side effects at load.
//
// Run context `rc` (built by MetaEngine._makeRc; tests fake it):
//   rc.ctx                   the injected MetaContext (§3.12)
//   rc.events                events latched for THIS pass (pushEvent), each
//                            visible to exactly one pass
//   rc.values                { truthy, toStr, isErr } (EXPR, injected)
//   rc.secondsInState()      (now − enteredAt) / 1000
//   rc.secondsInStateP()     (now − enteredAtP) / 1000
//   rc.vendorOpen()          vendor-session level (vendorOpen … vendorClose)
//   rc.evaluate(src)         meta-mode expression → Value (never throws)
//   rc.regex(pattern, flags) translated .NET regex → RegExp | null
//   rc.setVar(name, value)   session variable writer (capturegroup_*)
//   rc.exprError(msg)        record + echo an Expr error once per rule
//   rc.recordError(msg)      lastError for the debug strip
//   rc.warnOnce(key, msg)    one chat line per key per engine
//
// Semantics are the RynthAi structure with the U5 §9 bugs fixed: empty All is
// true, empty Any is false (B: RynthAi says true), Not with no child is false;
// ChatMatch sees EVERY pending line (and its synthesized retail tell markup);
// item counts are stack-aware (the context sums stacks); monsters with an
// unknown health fraction are counted (B16); BlockE accepts XXXX and
// XXXX0000 (B9); (P) has its own timer (B7); VendorClosed is a real edge (B5);
// ChatCapture is CType 28 and binds capturegroup_<name> session vars (B1/B6).

export const MAX_CONDITION_DEPTH = 64;
const NO_MOBS_DEFAULT_DIST_M = 20; // MetaManager.cs NoMonstersWithinDistance (≤0 ⇒ 20)

// ── small coercions (no EXPR import: C2) ─────────────────────────────────

function num(x) {
  if (typeof x === "number") return x;
  if (typeof x === "string" && x.trim() !== "") {
    const t = x.trim();
    const h = /^([+-]?)0x([0-9a-f]+)$/i.exec(t);
    if (h) {
      const n = parseInt(h[2], 16);
      return h[1] === "-" ? -n : n;
    }
    return Number(t);
  }
  return NaN;
}

function finite(x) {
  return typeof x === "number" && Number.isFinite(x);
}

function text(x) {
  if (x === null || x === undefined) return "";
  return typeof x === "string" ? x : String(x);
}

// uint32 from a number (signed .met ints included) or a hex string
// ("C8E90000", "0xC8E9"); null when unusable.
export function toU32(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v >>> 0 : null;
  if (typeof v === "string") {
    const t = v.trim().replace(/^0x/i, "");
    if (!/^[0-9a-f]{1,8}$/i.test(t)) return null;
    return parseInt(t, 16) >>> 0;
  }
  return null;
}

function kids(c) {
  return Array.isArray(c && c.children) ? c.children : [];
}

function events(rc, type) {
  const ev = Array.isArray(rc.events) ? rc.events : [];
  return ev.filter((e) => e && e.type === type);
}

function call(fn, ...args) {
  return typeof fn === "function" ? fn(...args) : undefined;
}

// Live, attackable monsters from ctx.world.monsters(): known-dead (hf === 0)
// and non-attackable rows excluded; unknown health (hf −1 / missing) counted.
function liveMonsters(rc) {
  const w = rc.ctx && rc.ctx.world;
  const rows = w && typeof w.monsters === "function" ? w.monsters() : null;
  if (!Array.isArray(rows)) return [];
  return rows.filter((m) => m && m.attackable !== false && m.hf !== 0 && finite(Number(m.dist)));
}

// ── chat matching ────────────────────────────────────────────────────────

const TELL_RE = /^(.+?) tells you, "(.*)"$/; // control_channel.js / host_signals.js TELL_RE
const CHAT_CATEGORY_TELL = 2;

// The subjects one chat line is tested as: the plain line, then (for a tell)
// the retail markup form corpus regexes are written against (U5 §3 row 4):
//   <Tell:IIDString:0:Name>Name<\Tell> tells you, "msg"
// The sender guid is not known on the web (MISSING-RUST C1), so it is 0.
export function chatSubjects(e) {
  const t = text(e && e.text);
  const out = [t];
  if (e && e.cat !== undefined && e.cat !== null && (Number(e.cat) >>> 0) !== CHAT_CATEGORY_TELL) return out;
  const m = TELL_RE.exec(t);
  if (m) out.push(`<Tell:IIDString:0:${m[1]}>${m[1]}<\\Tell> tells you, "${m[2]}"`);
  return out;
}

// ";"-separated ChatMessageType ids (decimal or 0x hex; "," and spaces
// tolerated) → Set<number>, or null when empty/unparseable (no filter).
export function parseColorIds(colors) {
  const s = text(colors).trim();
  if (!s) return null;
  const out = new Set();
  for (const part of s.split(/[;,\s]+/)) {
    if (!part) continue;
    const n = num(part);
    if (Number.isFinite(n)) out.add(n >>> 0);
  }
  return out.size ? out : null;
}

function execOn(rx, subject) {
  try {
    rx.lastIndex = 0;
    return rx.exec(subject);
  } catch {
    return null;
  }
}

function chatMatch(c, rc, capture) {
  const pattern = text(c.re);
  if (!pattern) return false;
  const rx = rc.regex(pattern, "");
  if (!rx) {
    rc.exprError(`invalid regular expression /${pattern}/`); // once per rule; never matches
    return false;
  }
  const colors = capture ? parseColorIds(c.colors) : null;
  for (const e of events(rc, "chat")) {
    if (colors && !colors.has(Number(e.chatType) >>> 0)) continue;
    for (const subject of chatSubjects(e)) {
      const m = execOn(rx, subject);
      if (!m) continue;
      if (capture && m.groups) {
        // Bind BEFORE the action runs (and before later siblings of an All):
        // every named group → session var capturegroup_<name>; a group that
        // did not participate binds "" (.NET Group.Value).
        for (const name of Object.keys(m.groups)) {
          rc.setVar(`capturegroup_${name}`, m.groups[name] === undefined ? "" : m.groups[name]);
        }
      }
      return true;
    }
  }
  return false;
}

// ── the table (Appendix B numbering; keyword = metaf name = canonical id) ─

function row(met, label, test) {
  return Object.freeze({ met, label, test });
}

export const CONDITIONS = Object.freeze({
  Never: row(0, "Never", () => false),
  Always: row(1, "Always", () => true),
  All: row(2, "All", (c, rc, d) => {
    for (const ch of kids(c)) if (!evalCondition(ch, rc, d + 1)) return false;
    return true; // empty All = true (real metas use it as Always)
  }),
  Any: row(3, "Any", (c, rc, d) => {
    for (const ch of kids(c)) if (evalCondition(ch, rc, d + 1)) return true;
    return false; // empty Any = false (RynthAi's true is logically wrong, U5 §1.3)
  }),
  ChatMatch: row(4, "Chat Message", (c, rc) => chatMatch(c, rc, false)),
  MainSlotsLE: row(5, "Pack Slots <=", (c, rc) => {
    const n = num(c.n);
    const free = call(rc.ctx.player && rc.ctx.player.packFreeMain);
    return finite(n) && finite(free) && free <= n;
  }),
  SecsInStateGE: row(6, "Seconds in State >=", (c, rc) => {
    const s = num(c.secs);
    return finite(s) && rc.secondsInState() >= s;
  }),
  NavEmpty: row(7, "Navroute Empty", (c, rc) => {
    const nav = rc.ctx.nav;
    if (!nav || typeof nav.isEmpty !== "function") return true; // no nav service ⇒ no route
    return nav.isEmpty() === true;
  }),
  Death: row(8, "Character Death", (c, rc) => events(rc, "death").some((e) => e.self !== false)),
  VendorOpen: row(9, "Any Vendor Open", (c, rc) => rc.vendorOpen() === true),
  VendorClosed: row(10, "Vendor Closed", (c, rc) => events(rc, "vendorClose").length > 0),
  ItemCountLE: row(11, "Inventory Item Count <=", (c, rc) => itemCount(c, rc, (have, want) => have <= want)),
  ItemCountGE: row(12, "Inventory Item Count >=", (c, rc) => itemCount(c, rc, (have, want) => have >= want)),
  MobsInDist_Name: row(13, "Monster Name Count Within Distance", (c, rc) => {
    const dist = num(c.dist);
    const want = finite(num(c.count)) ? num(c.count) : 1;
    if (!finite(dist)) return false;
    const rx = rc.regex(text(c.re), "i"); // monster names match case-insensitively
    if (!rx) {
      rc.exprError(`invalid regular expression /${text(c.re)}/`);
      return false;
    }
    let n = 0;
    for (const m of liveMonsters(rc)) {
      if (Number(m.dist) > dist) continue;
      if (execOn(rx, text(m.name))) n++;
    }
    return n >= want;
  }),
  MobsInDist_Priority: row(14, "Monster Priority Count Within Distance", (c, rc) => {
    const dist = num(c.dist);
    const want = finite(num(c.count)) ? num(c.count) : 1;
    const minP = finite(num(c.priority)) ? num(c.priority) : 0;
    const mon = rc.ctx.monsters;
    if (!finite(dist) || !mon || typeof mon.priorityOf !== "function") return false;
    let n = 0;
    for (const m of liveMonsters(rc)) {
      if (Number(m.dist) > dist) continue;
      const p = Number(mon.priorityOf(m.guid));
      if (finite(p) && p >= minP) n++;
    }
    return n >= want;
  }),
  NeedToBuff: row(15, "Need to Buff", (c, rc) => call(rc.ctx.buff && rc.ctx.buff.needsBuff) === true),
  NoMobsInDist: row(16, "No Monsters Within Distance", (c, rc) => {
    let dist = num(c.dist);
    if (!(dist > 0)) dist = NO_MOBS_DEFAULT_DIST_M;
    return !liveMonsters(rc).some((m) => Number(m.dist) <= dist);
  }),
  BlockE: row(17, "Landblock ==", (c, rc) => {
    const v = toU32(c.value);
    const cell = playerCell(rc);
    if (v === null || cell === null) return false;
    // Both forms (B9): XXXX0000 (or any full cell id) compares the high 16
    // bits; a bare XXXX compares the landblock number itself.
    return v > 0xffff ? cell >>> 16 === v >>> 16 : cell >>> 16 === v;
  }),
  CellE: row(18, "Landcell ==", (c, rc) => {
    const v = toU32(c.value);
    const cell = playerCell(rc);
    return v !== null && cell !== null && cell === v;
  }),
  IntoPortal: row(19, "Portalspace Entered", (c, rc) => events(rc, "portalIn").length > 0),
  ExitPortal: row(20, "Portalspace Exited", (c, rc) => events(rc, "portalOut").length > 0),
  Not: row(21, "Not", (c, rc, d) => {
    const ch = kids(c);
    return ch.length > 0 ? !evalCondition(ch[0], rc, d + 1) : false;
  }),
  PSecsInStateGE: row(22, "Seconds in state (P) >=", (c, rc) => {
    const s = num(c.secs);
    return finite(s) && rc.secondsInStateP() >= s;
  }),
  SecsOnSpellGE: row(23, "Time Left On Spell >=", (c, rc) => {
    const id = num(c.spellId);
    const secs = num(c.secs);
    if (!finite(id) || !finite(secs)) return false;
    const rows = call(rc.ctx.player && rc.ctx.player.selfEnchantments);
    let left = 0; // not found = 0 s (U5 §3 row 23)
    if (Array.isArray(rows)) {
      for (const r of rows) {
        if (!r || Number(r.spellId) >>> 0 !== id >>> 0) continue;
        const rem = r.permanent === true ? Infinity : Number(r.remainingS);
        if (rem > left) left = rem; // max over layers of the same spell id
      }
    }
    return left >= secs;
  }),
  BuPercentGE: row(24, "Burden Percent >=", (c, rc) => {
    const pct = num(c.pct);
    const b = call(rc.ctx.player && rc.ctx.player.burdenPct);
    return finite(pct) && finite(b) && b >= pct;
  }),
  DistToRteGE: row(25, "Dist Any Route Pt >=", (c, rc) => {
    const dist = num(c.dist);
    const d = call(rc.ctx.nav && rc.ctx.nav.minDistToAnyPointM);
    // metres (Q8); no coordinate-bearing point ⇒ false (C# DistAnyRoutePT_GE)
    return finite(dist) && finite(d) && d >= dist;
  }),
  Expr: row(26, "Expression", (c, rc) => {
    const src = text(c.expr);
    if (!src.trim()) return false;
    const v = rc.evaluate(src);
    if (rc.values.isErr(v)) {
      rc.exprError(v && v.msg ? v.msg : "expression error"); // fails closed (C# MetaManager.cs:569-586)
      return false;
    }
    return !!rc.values.truthy(v);
  }),
  ChatCapture: row(28, "Chat Message Capture", (c, rc) => chatMatch(c, rc, true)),
});

export const CONDITION_KEYWORDS = Object.freeze(Object.keys(CONDITIONS));

function itemCount(c, rc, cmp) {
  const name = text(c.name).trim();
  const want = num(c.count);
  if (!name || !finite(want)) return false;
  const have = Number(call(rc.ctx.player && rc.ctx.player.itemCount, name));
  return finite(have) && cmp(have, want);
}

function playerCell(rc) {
  const p = call(rc.ctx.player && rc.ctx.player.pose);
  if (!p || p.objCellId === undefined || p.objCellId === null) return null;
  const n = Number(p.objCellId);
  return Number.isFinite(n) ? n >>> 0 : null;
}

class ConditionDepthError extends Error {}

/**
 * Evaluate one condition tree. Unknown keywords are false (FMT already maps
 * them to Never + unknownKeyword). Nesting deeper than 64 makes the WHOLE
 * tree false (recorded) — not just the deep node, which a Not would flip.
 * Other exceptions from the context propagate to the engine, which records
 * lastError and treats the rule's condition as false.
 */
export function evalCondition(cond, rc, depth = 0) {
  if (depth === 0) {
    try {
      return evalNode(cond, rc, 0);
    } catch (e) {
      if (!(e instanceof ConditionDepthError)) throw e;
      rc.recordError(`condition nesting deeper than ${MAX_CONDITION_DEPTH}`);
      return false;
    }
  }
  return evalNode(cond, rc, depth);
}

function evalNode(cond, rc, depth) {
  if (!cond || typeof cond !== "object") return false;
  if (depth > MAX_CONDITION_DEPTH) throw new ConditionDepthError("too deep");
  const r = Object.prototype.hasOwnProperty.call(CONDITIONS, cond.t) ? CONDITIONS[cond.t] : null;
  if (!r) {
    const kw = text(cond.unknownKeyword || cond.t);
    rc.warnOnce(`cond:${kw}`, `[Meta] unsupported condition "${kw}" is treated as Never`);
    return false;
  }
  return r.test(cond, rc, depth) === true;
}

// ── human-readable form (debug lines, MetaSnapshot.lastFired) ─────────────

function clip(s, n = 60) {
  const t = text(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function hex8(v) {
  const u = toU32(v);
  return u === null ? text(v) : u.toString(16).toUpperCase().padStart(8, "0");
}

export function describeCondition(c, depth = 0) {
  if (!c || typeof c !== "object") return "?";
  if (depth > 4) return `${c.t}…`;
  switch (c.t) {
    case "All":
    case "Any":
    case "Not": {
      const ch = kids(c).map((k) => describeCondition(k, depth + 1));
      return clip(`${c.t}(${ch.join(", ")})`, 120);
    }
    case "ChatMatch":
      return `ChatMatch {${clip(c.re)}}`;
    case "ChatCapture":
      return `ChatCapture {${clip(c.re)}}${c.colors ? ` {${c.colors}}` : ""}`;
    case "MainSlotsLE":
      return `MainSlotsLE ${c.n}`;
    case "SecsInStateGE":
    case "PSecsInStateGE":
      return `${c.t} ${c.secs}`;
    case "ItemCountLE":
    case "ItemCountGE":
      return `${c.t} ${c.count} {${clip(c.name)}}`;
    case "MobsInDist_Name":
      return `MobsInDist_Name ${c.count} ${c.dist} {${clip(c.re)}}`;
    case "MobsInDist_Priority":
      return `MobsInDist_Priority ${c.count} ${c.dist} ${c.priority}`;
    case "NoMobsInDist":
      return `NoMobsInDist ${c.dist}`;
    case "BlockE":
    case "CellE":
      return `${c.t} ${hex8(c.value)}`;
    case "SecsOnSpellGE":
      return `SecsOnSpellGE ${c.spellId} ${c.secs}`;
    case "BuPercentGE":
      return `BuPercentGE ${c.pct}`;
    case "DistToRteGE":
      return `DistToRteGE ${c.dist}`;
    case "Expr":
      return `Expr {${clip(c.expr)}}`;
    default:
      return text(c.unknownKeyword || c.t);
  }
}
