// rynth/vt/cmd/stdlib_host.js — the meta HOST function library (PLAN W1-5 CMD
// §3.7; U5 §5.6 groups G-H(host), I, J, K(read), L, M, N, O, P(settings)).
//
// registerHostFunctions(registry, hctx) defines, through registry.define()
// only, every RynthAi/VTank/UB expression function that needs the game:
// character reads, world-object finders and getters, inventory counts,
// actions (use/give/cast/select/…), chat, quests, fellowship and settings.
// It does NOT define EXPR's pure library (§3.4 groups A-H(T)), the META
// functions (*metastate) or the view functions (ui*) — those packages own
// them.
//
// Values follow the PLAN §3.2 shapes (EXPR values.js; re-stated here because
// vt packages may not import each other, C2): world objects are
// {t:"wobj", guid, name}; "not found" is None (null), so the corpus idiom
// `getobjectinternaltype[wobjectfind…[…]]==7` tells found from not found;
// lists are {t:"list", items}; coordinates {t:"coords", ns, ew, z} with z in
// nav units (m/240); RynthAi's "1"/"0" predicates are the numbers 1/0.
//
// Functions that cannot work in a browser against vanilla ACE return the
// error value `unsupported: <name>` (one warning per name) — never a silent
// "" (§2.11): the Dereth clock (no client memory), monster enchantments (ACE
// sends enchantments for the player only), the salvage panel, chat-input
// paste, the account hash / world name, loot-profile gives, component data.
//
// Cast safety (C6): actiontrycastbyid* go through VtActions.castById, which
// never casts untargeted. Chat safety (C7): echo prints locally; chatbox goes
// to hctx.runChat (the local /rs chain first, then host.InvokeChatParser).
//
// HostFnContext (built by INT-2 glue/host_fn_context.js) =
//   { host, actions: VtActions, options: VtOptions, print(text, cat), runChat(line),
//     quests: QuestTracker, creatures: CreatureProfiles|null, nav: {status(), isEmpty()}|null, now() }
//   + optional (additive): log(msg), getRegex(pattern, flags) (EXPR's .NET-dialect cache),
//     operatorHeld() (else VtActions.operatorHeld()).
//
// Movement keys (setmotion/clearmotion): pressing one is refused while the
// operator holds the bot or in portal space; registry.release() (run by the
// meta engine on the hold edge, portalIn and destroy) lets go of every key
// pressed with one SetMovementInput(0,0,0,false).

import { createVtActions, OBJECT_CLASS, ODF } from "./actions_lib.js";
import { poseToCoords } from "./coords.js";

// ── value helpers (mirror rynth/vt/expr/values.js; C2 forbids the import) ──

const tagOf = (v) => (v !== null && typeof v === "object" ? v.t : undefined);

export const VAL = Object.freeze({
  list: (items = []) => ({ t: "list", items: Array.isArray(items) ? items : [] }),
  dict: (entries = []) => ({ t: "dict", map: new Map(entries) }),
  wobj: (guid, name = "") => ({ t: "wobj", guid: Number(guid) >>> 0, name: name == null ? "" : String(name) }),
  coords: (ns, ew, z = 0) => ({ t: "coords", ns: Number(ns) || 0, ew: Number(ew) || 0, z: Number(z) || 0 }),
  err: (msg) => ({ t: "err", msg: String(msg) }),
});

const DEC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const HEX_RE = /^([+-]?)0x([0-9a-f]+)$/i;

function parseNum(s) {
  const t = String(s).trim();
  if (!t) return null;
  if (DEC_RE.test(t)) return Number(t);
  const h = HEX_RE.exec(t);
  if (h) {
    const n = parseInt(h[2], 16);
    return h[1] === "-" ? -n : n;
  }
  return null;
}

/** Numeric view of a value (non-numeric → 0), like EXPR toNum (a WorldObject is 0 there too; use guidOfValue for ids). */
export function valueToNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") return parseNum(v) ?? 0;
  return 0;
}

/** .NET double.ToString("G") (shortest round trip; E notation outside 1e-5..1e15). */
export function formatNumber(n) {
  if (typeof n !== "number") n = Number(n);
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "Infinity";
  if (n === -Infinity) return "-Infinity";
  if (n === 0) return "0";
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(n.toExponential());
  if (!m) return String(n);
  const e = Number(m[4]);
  if (e > -5 && e < 15) return String(n);
  const ae = Math.abs(e);
  return `${m[1]}${m[3] ? `${m[2]}.${m[3]}` : m[2]}E${e < 0 ? "-" : "+"}${ae < 10 ? "0" : ""}${ae}`;
}

const hex8 = (n) => (Number(n) >>> 0).toString(16).toUpperCase().padStart(8, "0");
const fixed2 = (n) => {
  const s = (Number(n) || 0).toFixed(2);
  return s === "-0.00" ? "0.00" : s;
};

/** String view of a value (EXPR toStr rules). */
export function valueToString(v, depth = 0) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (depth > 16) return "...";
  switch (v.t) {
    case "list":
      return `[${v.items.map((x) => valueToString(x, depth + 1)).join(",")}]`;
    case "dict": {
      const parts = [];
      for (const [k, x] of v.map) parts.push(`${k}=>${valueToString(x, depth + 1)}`);
      return `{${parts.join(",")}}`;
    }
    case "wobj":
      return `[WorldObject] 0x${hex8(v.guid)}: ${v.name ?? ""}`;
    case "coords": {
      const ns = Number(v.ns) || 0;
      const ew = Number(v.ew) || 0;
      return `${ns >= 0 ? `${fixed2(ns)}N` : `${fixed2(-ns)}S`}, ${ew >= 0 ? `${fixed2(ew)}E` : `${fixed2(-ew)}W`}, ${fixed2(v.z)}Z`;
    }
    case "sw":
      return "[Stopwatch]";
    case "err":
      return `ERR: ${v.msg}`;
    default:
      return String(v);
  }
}

/** EXPR typeName (the `/rs mexec` "[<type>]" tag). */
export function valueTypeName(v) {
  if (v === null || v === undefined) return "None";
  if (typeof v === "number") return "Number";
  if (typeof v === "string") return "String";
  if (typeof v === "boolean") return "Boolean";
  return { list: "List", dict: "Dictionary", wobj: "WorldObject", coords: "Coordinates", sw: "Stopwatch", err: "Error" }[v.t] ?? "Unknown";
}

/** Scalar for an option write (Bool/number/string; anything else as text). */
function toScalar(v) {
  if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") return v;
  return valueToString(v);
}

// AC chat text types (ChatMessageType / eChatTypes) → web CHAT_CATEGORY ids
// (app/chat_log.js). Unknown → SYSTEM (0).
const CHAT_TYPE_TO_CATEGORY = Object.freeze({
  2: 1, 3: 2, 4: 24, 5: 0, 6: 5, 7: 7, 8: 3, 9: 3, 10: 25, 11: 26, 12: 4, 13: 8, 15: 11, 16: 20, 17: 7, 18: 17,
  19: 16, 20: 21, 21: 5, 22: 5, 23: 18, 24: 19, 25: 19, 27: 15, 28: 12, 29: 13, 30: 14, 31: 2, 32: 22, 33: 23,
});
export function chatCategoryForType(chatType) {
  const n = Math.trunc(valueToNumber(chatType));
  return CHAT_TYPE_TO_CATEGORY[n] ?? 0;
}

/** World-object reference from any argument form: wobj, guid number, "0x…" hex, "[WorldObject] 0x…: name", decimal. */
export function guidOfValue(v) {
  if (v === null || v === undefined) return 0;
  if (tagOf(v) === "wobj") return v.guid >>> 0;
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) >>> 0 : 0;
  if (typeof v === "boolean") return 0;
  const s = String(typeof v === "string" ? v : valueToString(v)).trim();
  if (!s || s === "0") return 0;
  const m = /^\[WorldObject\]\s*0x([0-9a-f]+)/i.exec(s) || /^0x([0-9a-f]+)$/i.exec(s);
  if (m) return parseInt(m[1], 16) >>> 0;
  if (/^-?\d+$/.test(s)) return Number(s) >>> 0;
  return 0;
}

// Dereth time, the salvage panel, chat-input paste, account/world identity,
// loot-profile gives and component data have no web seam (§2.11).
const VITAL_KEY = Object.freeze({ 1: 1, 2: 3, 3: 5 }); // VTank 1/2/3 → stats key 1/3/5 (Health/Stamina/Mana)
const MOTIONS = Object.freeze(["forward", "backward", "turnright", "turnleft", "straferight", "strafeleft", "walk"]);
const EXT_PROP_TEMPLATE_TYPE = 218103808; // UB 0xD000000 → wcid
const EXT_PROP_CONTAINER = 218103810; // Decal LongValueKey.Container (0xD000002)
const EXT_DPROP_WORKMANSHIP = 167772169; // UB 0xA000009 → PropertyFloat 280 (ItemWorkmanship)
const FELLOW_MAX = 9;
const PERMANENT_S = 2147483647;
const ELEMENT_ALIASES = Object.freeze({
  slash: "Slash", sl: "Slash", pierce: "Pierce", pi: "Pierce", bludgeon: "Bludgeon", bl: "Bludgeon", b: "Bludgeon",
  fire: "Fire", fi: "Fire", f: "Fire", cold: "Cold", co: "Cold", c: "Cold", acid: "Acid", ac: "Acid", a: "Acid",
  electric: "Lightning", lightning: "Lightning", el: "Lightning", li: "Lightning", nether: "Nether",
});

// ── the function table: [name, factory(E) → impl(args, call), opts?] ────────
// One row per function; HOST_FUNCTION_NAMES is derived from it, so the
// exported list and the registrations can never drift.

const n0 = (args, i) => valueToNumber(args[i]);
const s0 = (args, i) => valueToString(args[i]).trim();
const int0 = (args, i) => Math.trunc(n0(args, i));
const b01 = (b) => (b ? 1 : 0);

const SPEC = [
  // ── I. player character ─────────────────────────────────────────────────
  ["getcharintprop", (E) => (a) => E.charProp("TryGetObjectIntProperty", int0(a, 0), 0)],
  ["getchardoubleprop", (E) => (a) => E.charProp("TryGetObjectDoubleProperty", int0(a, 0), 0)],
  ["getcharquadprop", (E) => (a) => E.charProp("TryGetObjectQuadProperty", int0(a, 0), 0)],
  ["getcharboolprop", (E) => (a) => b01(E.charProp("TryGetObjectBoolProperty", int0(a, 0), false) === true)],
  [
    "getcharstringprop",
    (E) => (a) => {
      const id = int0(a, 0);
      const v = E.charProp("TryGetObjectStringProperty", id, "");
      if (typeof v === "string" && v) return v;
      return id === 1 ? E.objName(E.me()) : "";
    },
  ],
  ["getcharvital_base", (E) => (a) => E.vital(int0(a, 0), "base")],
  ["getcharvital_current", (E) => (a) => E.vital(int0(a, 0), "current")],
  ["getcharvital_buffedmax", (E) => (a) => E.vital(int0(a, 0), "max")],
  ["getcharskill_traininglevel", (E) => (a) => E.statRow("skills", int0(a, 0), "training")],
  ["getcharskill_base", (E) => (a) => E.statRow("skills", int0(a, 0), "base")],
  ["getcharskill_buffed", (E) => (a) => E.statRow("skills", int0(a, 0), "current")],
  ["getcharattribute_base", (E) => (a) => E.statRow("attributes", int0(a, 0), "base")],
  ["getcharattribute_buffed", (E) => (a) => E.statRow("attributes", int0(a, 0), "current")],
  ["getcharburden", (E) => () => E.num(E.hc("TryGetBurden"))],
  ["getcharburden_total", (E) => () => E.charProp("TryGetObjectIntProperty", 5, 0)],
  ["getplayerlandcell", (E) => () => (E.pose() ? Number(E.pose().objCellId) >>> 0 : 0)],
  ["getplayerlandblock", (E) => () => (E.pose() ? (Number(E.pose().objCellId) & 0xffff0000) >>> 0 : 0)],
  ["getcellid", (E) => () => (E.pose() ? `0x${hex8(E.pose().objCellId)}` : "")],
  [
    "getplayercoordinates",
    (E) => () => {
      const c = poseToCoords(E.pose());
      return c ? VAL.coords(c.ns, c.ew, c.z) : "";
    },
  ],
  [
    "vitae",
    (E) => () => {
      const v = E.hc("TryGetVitae");
      if (typeof v !== "number" || !Number.isFinite(v)) return 0;
      return Math.min(100, Math.max(0, 100 - Math.round(v * 100)));
    },
  ],
  ["isportaling", (E) => () => b01(E.hc("IsPortalSpaceActive") === true)],
  [
    "getcombatstate",
    (E) => () => ({ 2: "Melee", 4: "Missile", 8: "Magic" })[Number(E.hc("GetCurrentCombatMode"))] ?? "Peace",
  ],
  ["setcombatstate", (E) => (a) => b01(E.actions().setCombatState(s0(a, 0)).ok)],
  ["getbusystate", (E) => () => E.num(E.hc("GetBusyState"))],
  [
    "getequippedweapontype",
    (E) => () => {
      for (const r of E.actions().inventory()) {
        if (!(Number(r.equipMask) >>> 0)) continue;
        const it = Number(r.itemType) >>> 0;
        if (it & 0x1) return "Melee";
        if (it & 0x100) return "Missile";
        if (it & 0x8000) return "Wand";
      }
      return "None";
    },
  ],
  [
    "getheading",
    (E) => (a) => {
      const g = guidOfValue(a[0]);
      if (!g || g === E.me()) {
        const h = E.hc("TryGetPlayerCompassHeadingDeg");
        return typeof h === "number" && Number.isFinite(h) ? h : 0;
      }
      return E.unsupported("getheading", "the facing of other objects is not readable on web");
    },
  ],
  ["getheadingto", (E) => (a) => E.bearingTo(guidOfValue(a[0]))],
  ["getisspellknown", (E) => (a) => b01(E.known().includes(int0(a, 0)))],
  ["getcancastspell_hunt", (E) => (a) => E.canCast(int0(a, 0))],
  ["getcancastspell_buff", (E) => (a) => E.canCast(int0(a, 0))],
  ["getspellexpiration", (E) => (a) => E.spellExpiration((row) => row.spellId === int0(a, 0), 0)],
  [
    "getspellexpirationbyname",
    (E) => (a) => {
      const want = s0(a, 0).toLowerCase();
      if (!want) return -1;
      return E.spellExpiration((row) => E.spellName(row.spellId).toLowerCase().includes(want), -1);
    },
  ],
  ["getworldname", (E) => () => E.unsupported("getworldname", "the server name is not exposed to the bot")],
  ["getaccounthash", (E) => () => E.unsupported("getaccounthash", "the account name is not exposed to the bot")],

  // ── G. Dereth calendar (client clock memory — X) ───────────────────────
  ...[
    "getgameticks", "getgameyear", "getgamemonth", "getgamemonthname", "getgameday", "getgamehour",
    "getgamehourname", "getisday", "getisnight", "getminutesuntilday", "getminutesuntilnight",
  ].map((name) => [name, (E) => () => E.unsupported(name, "the Dereth clock is client memory")]),

  // ── J. world objects: finders ──────────────────────────────────────────
  ["wobjectfindnearestbytemplatetype", (E) => (a) => E.nearest(E.land().filter((o) => E.wcidOf(o.guid) === int0(a, 0) && int0(a, 0) > 0))],
  ["wobjectfindininventorybytemplatetype", (E) => (a) => E.first(E.inv().filter((r) => int0(a, 0) > 0 && r.wcid === int0(a, 0)))],
  ["wobjectfindininventorybyname", (E) => (a) => E.first(E.inv().filter(E.nameIs(s0(a, 0))))],
  ["wobjectfindininventorybynamerx", (E) => (a) => E.first(E.inv().filter(E.nameRx(s0(a, 0))))],
  ["wobjectfindallinventorybynamerx", (E) => (a) => E.listOf(E.inv().filter(E.nameRx(s0(a, 0))))],
  ["wobjectfindallinventorybytemplatetype", (E) => (a) => E.listOf(E.inv().filter((r) => int0(a, 0) > 0 && r.wcid === int0(a, 0)))],
  ["wobjectfindallinventorybyobjectclass", (E) => (a) => E.listOf(E.inv().filter((r) => E.classOf(r.guid) === int0(a, 0)))],
  ["wobjectfindallbyobjectclass", (E) => (a) => E.listOf(E.land().filter((o) => E.classOf(o.guid) === int0(a, 0)))],
  ["wobjectfindalllandscapebyobjectclass", (E) => (a) => E.listOf(E.land().filter((o) => E.classOf(o.guid) === int0(a, 0)))],
  ["wobjectfindallbynamerx", (E) => (a) => E.listOf([...E.land(), ...E.inv()].filter(E.nameRx(s0(a, 0))))],
  ["wobjectfindallbytemplatetype", (E) => (a) => E.listOf([...E.land(), ...E.inv()].filter((o) => int0(a, 0) > 0 && E.wcidOf(o.guid, o) === int0(a, 0)))],
  ["wobjectfindalllandscape", (E) => () => E.listOf(E.land())],
  ["wobjectfindallinventory", (E) => () => E.listOf(E.inv())],
  ["wobjectfindall", (E) => () => E.listOf([...E.land(), ...E.inv()])],
  ["wobjectfindalllandscapebytemplatetype", (E) => (a) => E.listOf(E.land().filter((o) => int0(a, 0) > 0 && E.wcidOf(o.guid) === int0(a, 0)))],
  ["wobjectfindalllandscapebynamerx", (E) => (a) => E.listOf(E.land().filter(E.nameRx(s0(a, 0))))],
  [
    "wobjectfindallbycontainer",
    (E) => (a) => {
      const c = guidOfValue(a[0]);
      if (!c) return VAL.list([]);
      const ids = E.hc("GetContainerContents", c);
      return VAL.list((Array.isArray(ids) ? ids : []).map((g) => VAL.wobj(g, E.objName(g))));
    },
  ],
  [
    "wobjectgetselection",
    (E) => () => {
      const h = E.host();
      let g = typeof h?.GetSelectedItemId === "function" ? E.hc("GetSelectedItemId") : E.hc("GetSelectedId");
      g = Number(g) >>> 0;
      return g ? VAL.wobj(g, E.objName(g)) : null;
    },
  ],
  ["wobjectgetplayer", (E) => () => (E.me() ? VAL.wobj(E.me(), E.objName(E.me())) : null)],
  [
    "wobjectgetopencontainer",
    (E) => () => {
      const g = Number(E.hc("GetGroundContainerId")) >>> 0;
      return g ? VAL.wobj(g, E.objName(g)) : null;
    },
  ],
  [
    "wobjectfindnearestdoor",
    (E) =>
      () =>
        E.nearest(
          E.land().filter((o) => {
            const df = E.hc("TryGetObjectDescFlags", o.guid);
            if (typeof df === "number") return (df & ODF.DOOR) !== 0;
            return /door|gate|hatch|portcullis/i.test(o.name);
          }),
        ),
  ],
  [
    "wobjectfindnearestmonster",
    (E) =>
      () =>
        E.nearest(
          E.land().filter((o) => {
            if (E.hc("ObjectIsPlayer", o.guid) === true) return false;
            const it = Number(E.hc("TryGetObjectIntProperty", o.guid, 1)) >>> 0;
            if (!(it & 0x10)) return false;
            return E.hc("ObjectIsAttackable", o.guid) !== false;
          }),
        ),
  ],
  [
    "wobjectfindbyid",
    (E) => (a) => {
      const g = guidOfValue(a[0]);
      if (!g) return null;
      const row = E.inv().find((r) => r.guid === g);
      const name = row ? row.name : E.objName(g);
      return name || row ? VAL.wobj(g, name) : null;
    },
  ],
  ["wobjectfindnearestbyobjectclass", (E) => (a) => E.nearest(E.land().filter((o) => E.classOf(o.guid) === int0(a, 0)))],
  [
    "wobjectfindnearestbynameandobjectclass",
    (E) => (a) => {
      const cls = int0(a, 0);
      const m = E.nameRx(s0(a, 1));
      return E.nearest(E.land().filter((o) => m(o) && E.classOf(o.guid) === cls));
    },
  ],

  // ── J. world objects: getters ──────────────────────────────────────────
  [
    "wobjectgetphysicscoordinates",
    (E) => (a) => {
      const g = guidOfValue(a[0]);
      if (!g) return "";
      const pos = g === E.me() ? E.pose() : E.hc("TryGetObjectPosition", g);
      const c = poseToCoords(pos);
      return c ? VAL.coords(c.ns, c.ew, c.z) : "";
    },
  ],
  [
    "wobjectgetname",
    (E) => (a) => {
      const v = a[0];
      if (tagOf(v) === "wobj" && v.name) return v.name;
      const g = guidOfValue(v);
      if (!g) return "";
      const row = E.inv().find((r) => r.guid === g);
      return row ? row.name : E.objName(g);
    },
  ],
  ["wobjectgetid", (E) => (a) => guidOfValue(a[0])],
  ["wobjectgettemplatetype", (E) => (a) => E.wcidOf(guidOfValue(a[0]))],
  ["wobjectgetobjectclass", (E) => (a) => E.classOf(guidOfValue(a[0]))],
  ["wobjectgetobjclass", (E) => (a) => E.classOf(guidOfValue(a[0]))],
  [
    "wobjectgetisdooropen",
    (E) => (a) => {
      const g = guidOfValue(a[0]);
      return g ? b01((Number(E.hc("TryGetObjectState", g)) & 0x4) !== 0) : 0;
    },
  ],
  ["wobjectgetphysicsstate", (E) => (a) => (guidOfValue(a[0]) ? E.num(E.hc("TryGetObjectState", guidOfValue(a[0]))) : 0)],
  [
    "wobjectgetintprop",
    (E) => (a) => {
      const g = guidOfValue(a[0]);
      const prop = int0(a, 1) >>> 0;
      if (!g) return 0;
      if (prop === EXT_PROP_TEMPLATE_TYPE) return E.wcidOf(g);
      if (prop === EXT_PROP_CONTAINER) {
        // The host reports containerId 0 for the MAIN pack (and worn items);
        // Decal's Container of a main-pack item is the player itself.
        const row = E.inv().find((r) => r.guid === g);
        if (row) return row.containerId || (row.equipMask ? 0 : E.me());
        return E.num(E.hc("TryGetObjectInstanceIdProperty", g, 2));
      }
      return E.num(E.hc("TryGetObjectIntProperty", g, prop));
    },
  ],
  [
    "wobjectgetdoubleprop",
    (E) => (a) => {
      const g = guidOfValue(a[0]);
      let prop = int0(a, 1) >>> 0;
      if (prop === EXT_DPROP_WORKMANSHIP) prop = 280;
      return g ? E.num(E.hc("TryGetObjectDoubleProperty", g, prop)) : 0;
    },
  ],
  ["wobjectgetboolprop", (E) => (a) => (guidOfValue(a[0]) ? b01(E.hc("TryGetObjectBoolProperty", guidOfValue(a[0]), int0(a, 1)) === true) : 0)],
  [
    "wobjectgetstringprop",
    (E) => (a) => {
      const g = guidOfValue(a[0]);
      if (!g) return "";
      const v = E.hc("TryGetObjectStringProperty", g, int0(a, 1));
      return typeof v === "string" ? v : "";
    },
  ],
  ["wobjecthasdata", (E) => (a) => (guidOfValue(a[0]) ? b01(E.hc("HasAppraisalData", guidOfValue(a[0])) === true) : 0)],
  [
    "wobjectrequestdata",
    (E) => (a) => {
      const g = guidOfValue(a[0]);
      if (!g || typeof E.host()?.RequestId !== "function") return 0;
      E.hc("RequestId", g);
      return 1;
    },
  ],
  ["wobjectlastidtime", (E) => (a) => (guidOfValue(a[0]) ? E.num(E.hc("GetLastIdTime", guidOfValue(a[0]))) : 0)],
  [
    "wobjectisvalid",
    (E) => (a) => {
      const g = guidOfValue(a[0]);
      return g ? b01(!!E.objName(g) || E.inv().some((r) => r.guid === g)) : 0;
    },
  ],
  [
    "wobjectgethealth",
    (E) => (a) => {
      const g = guidOfValue(a[0]);
      if (!g) return -1;
      const v = E.hc("TryGetTargetHealthFraction", g);
      return typeof v === "number" && Number.isFinite(v) ? v : -1;
    },
  ],
  [
    "wobjectgetspellids",
    (E) => (a) => VAL.list(E.spellBook(guidOfValue(a[0])).map((id) => (id & 0x7fffffff) >>> 0)),
  ],
  ["wobjectgetactivespellids", (E) => (a) => E.activeSpells(guidOfValue(a[0]), "wobjectgetactivespellids", "id")],
  ["wobjectgetactivespelldurations", (E) => (a) => E.activeSpells(guidOfValue(a[0]), "wobjectgetactivespelldurations", "duration")],

  // ── K. creature profiles (learned from appraisals; CMB CreatureProfiles) ─
  [
    "creaturegetmaxhealth",
    (E) => (a) => {
      const w = E.creatureWcid(a[0]);
      const v = w ? E.creatures()?.maxHp?.(w) : null;
      return typeof v === "number" && v > 0 ? v : 0;
    },
  ],
  [
    "creaturegetresist",
    (E) => (a) => {
      const w = E.creatureWcid(a[0]);
      const el = ELEMENT_ALIASES[s0(a, 1).toLowerCase()];
      const r = w ? E.creatures()?.resists?.(w) : null;
      const v = r && el ? r[el] : null;
      return typeof v === "number" && Number.isFinite(v) ? v : 1;
    },
  ],
  [
    "creaturegetweakest",
    (E) => (a) => {
      const w = E.creatureWcid(a[0]);
      const v = w ? E.creatures()?.weakest?.(w) : null;
      return typeof v === "string" ? v : "";
    },
  ],
  ["creaturegetarmor", (E) => () => E.unsupported("creaturegetarmor", "armor levels are not kept in the creature profiles")],
  [
    "creaturehasprofile",
    (E) => (a) => {
      const w = E.creatureWcid(a[0]);
      const c = E.creatures();
      if (!w || !c) return 0;
      return b01((c.maxHp?.(w) ?? null) !== null || (c.resists?.(w) ?? null) !== null);
    },
  ],

  // ── J. inventory counts / pack room ────────────────────────────────────
  ["getitemcountininventorybyname", (E) => (a) => E.stackSum(E.inv().filter(E.nameIs(s0(a, 0))))],
  ["getitemcountininventorybynamerx", (E) => (a) => E.stackSum(E.inv().filter(E.nameRx(s0(a, 0))))],
  ["getinventorycountbytemplatetype", (E) => (a) => E.stackSum(E.inv().filter((r) => int0(a, 0) > 0 && r.wcid === int0(a, 0)))],
  ["getfreeitemslots", (E) => (a) => E.packRoom(a[0], (room) => room.main?.free, (p) => p.free)],
  ["getfreecontainerslots", (E) => (a) => E.packRoom(a[0], (room) => room.containers?.free, () => 0)],
  ["getcontaineritemcount", (E) => (a) => E.packRoom(a[0], (room) => room.main?.used, (p) => p.used)],

  // ── L. actions ─────────────────────────────────────────────────────────
  [
    "actiontryselect",
    (E) => (a) => {
      E.actions().select(guidOfValue(a[0]));
      return 0;
    },
  ],
  [
    "actiontryuseitem",
    (E) => (a) => {
      E.actions().use(guidOfValue(a[0]));
      return 0;
    },
  ],
  ["actiontryapplyitem", (E) => (a) => b01(E.actions().useOn(guidOfValue(a[0]), guidOfValue(a[1])).ok)],
  [
    "actiontrygiveitem",
    (E) => (a) => {
      const item = guidOfValue(a[0]);
      const row = E.inv().find((r) => r.guid === item);
      return b01(E.actions().give(item, guidOfValue(a[1]), row ? row.stack : 1).ok);
    },
  ],
  [
    "actiontryequipanywand",
    (E) => () => {
      const acts = E.actions();
      if (acts.casterWielded() === true) return 1;
      const wand = acts.casterRows()[0];
      if (wand) acts.equip(Number(wand.guid) >>> 0);
      return 0;
    },
  ],
  [
    "actiontrycastbyid",
    (E) => (a) => {
      const h = E.host();
      let sel = typeof h?.GetSelectedItemId === "function" ? E.hc("GetSelectedItemId") : E.hc("GetSelectedId");
      sel = Number(sel) >>> 0;
      return E.actions().castById(int0(a, 0), sel || null);
    },
  ],
  ["actiontrycastbyidontarget", (E) => (a) => (guidOfValue(a[1]) ? E.actions().castById(int0(a, 0), guidOfValue(a[1])) : 2)],
  ["actiontrygiveprofile", (E) => () => E.unsupported("actiontrygiveprofile", "loot-profile gives are not implemented on web")],
  [
    "setmotion",
    (E) => (a) => {
      const m = s0(a, 0).toLowerCase();
      if (!MOTIONS.includes(m)) return 0;
      const on = n0(a, 1) !== 0;
      // I-3/V-7/V-12: no movement key is pressed while the operator holds the
      // bot or in portal space (releasing one is always allowed).
      if (on && (E.held() || E.inPortal())) {
        E.log(`setmotion[${m}] refused: ${E.held() ? "the bot is paused (Run Macro is off)" : "in portal space"}`);
        return 0;
      }
      E.motion.set(m, on);
      return b01(E.applyMotion());
    },
  ],
  ["getmotion", (E) => (a) => b01(E.motion.get(s0(a, 0).toLowerCase()) === true)],
  [
    "clearmotion",
    (E) => () => {
      E.motion.clear();
      E.applyMotion();
      return 1;
    },
  ],
  ["ustopen", (E) => () => E.unsupported("ustopen", "the salvage panel has no web seam")],
  ["ustadd", (E) => () => E.unsupported("ustadd", "the salvage panel has no web seam")],
  ["ustsalvage", (E) => () => E.unsupported("ustsalvage", "the salvage panel has no web seam")],
  [
    "chatbox",
    (E) => (a) => {
      const msg = valueToString(a[0]);
      if (typeof E.ctx.runChat !== "function") return E.unsupported("chatbox", "no chat path was wired");
      if (msg.trim()) E.ctx.runChat(msg);
      return msg;
    },
  ],
  ["chatboxpaste", (E) => () => E.unsupported("chatboxpaste", "the chat input cannot be filled from a meta")],
  [
    "echo",
    (E) => (a) => {
      E.print(valueToString(a[0]), a.length > 1 ? chatCategoryForType(a[1]) : 0);
      return 1;
    },
  ],
  ["statushud", (E) => () => E.unsupported("statushud", "there is no status HUD panel on web")],
  ["statushudcolored", (E) => () => E.unsupported("statushudcolored", "there is no status HUD panel on web")],

  // ── M. quests ──────────────────────────────────────────────────────────
  ["testquestflag", (E) => (a) => b01(E.quests()?.testFlag?.(s0(a, 0)) === true)],
  ["getqueststatus", (E) => (a) => (E.quests() ? E.num(E.quests().status(s0(a, 0))) : 1)],
  ["getquestktprogress", (E) => (a) => (E.quests() ? E.num(E.quests().ktProgress(s0(a, 0))) : 0)],
  ["getquestktrequired", (E) => (a) => (E.quests() ? E.num(E.quests().ktRequired(s0(a, 0))) : 0)],
  ["isrefreshingquests", (E) => () => b01(E.quests()?.isRefreshing?.() === true)],
  ["refreshquests", (E) => () => (E.quests() ? (E.quests().refresh(), 1) : 0)],

  // ── N. spells / components ─────────────────────────────────────────────
  ["spellname", (E) => (a) => E.spellName(int0(a, 0))],
  ["getknownspells", (E) => () => VAL.list(E.known())],
  ["componentname", (E) => () => E.unsupported("componentname", "no component table on web")],
  ["componentdata", (E) => () => E.unsupported("componentdata", "no component table on web")],
  ["spelldata", (E) => () => E.unsupported("spelldata", "use spellname[] / getisspellknown[]")],

  // ── O. fellowship (TryGetFellowshipInfo, A10) ──────────────────────────
  ["getfellowshipname", (E) => () => E.fellow()?.name ?? ""],
  ["getfellowshipcount", (E) => () => E.fellowMembers().length],
  ["getfellowshipleaderid", (E) => () => (Number(E.fellow()?.leaderGuid) >>> 0) || 0],
  ["getfellowshiplocked", (E) => () => b01(E.fellow()?.isLocked === true)],
  ["getfellowshipisleader", (E) => () => b01(!!E.fellow() && (Number(E.fellow().leaderGuid) >>> 0) === E.me() && E.me() !== 0)],
  ["getfellowshipisopen", (E) => () => b01(E.fellow()?.open === true)],
  [
    "getfellowshipstatus",
    (E) => () => {
      const f = E.fellow();
      if (!f) return 0;
      return (Number(f.leaderGuid) >>> 0) === E.me() && E.me() !== 0 ? 1 : 2;
    },
  ],
  ["getfellowshipisfull", (E) => () => b01(!!E.fellow() && E.fellowMembers().length >= FELLOW_MAX)],
  [
    "getfellowshipcanrecruit",
    (E) => () => {
      const f = E.fellow();
      if (!f || E.fellowMembers().length >= FELLOW_MAX) return 0;
      return b01((Number(f.leaderGuid) >>> 0) === E.me() || f.open === true);
    },
  ],
  ["getfellowid", (E) => (a) => (Number(E.fellowMembers()[int0(a, 0)]?.guid) >>> 0) || 0],
  ["getfellowname", (E) => (a) => String(E.fellowMembers()[int0(a, 0)]?.name ?? "")],
  [
    "getfellownames",
    (E) => () =>
      VAL.list(
        E.fellowMembers()
          .map((m) => String(m.name ?? ""))
          .sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase())),
      ),
  ],
  [
    "getfellowids",
    (E) => () =>
      VAL.list(
        E.fellowMembers()
          .map((m) => Number(m.guid) >>> 0)
          .filter(Boolean)
          .sort((x, y) => x - y),
      ),
  ],

  // ── P. settings / options (the ONE settings authority + the meta bag) ───
  ["vtgetsetting", (E) => (a) => E.getSetting(s0(a, 0))],
  ["ragetsetting", (E) => (a) => E.getSetting(s0(a, 0))],
  ["vtankgetsetting", (E) => (a) => E.getSetting(s0(a, 0))],
  ["vtsetsetting", (E) => (a) => E.setSetting(s0(a, 0), a[1])],
  ["rasetsetting", (E) => (a) => E.setSetting(s0(a, 0), a[1])],
  ["raoptget", (E) => (a) => E.getSetting(s0(a, 0))],
  ["uboptget", (E) => (a) => E.getSetting(s0(a, 0))],
  ["raoptset", (E) => (a) => E.setSetting(s0(a, 0), a[1])],
  ["uboptset", (E) => (a) => E.setSetting(s0(a, 0), a[1])],
];

/** Every function name registerHostFunctions defines (sorted). */
export const HOST_FUNCTION_NAMES = Object.freeze(SPEC.map((r) => r[0]).sort());

/** Names this library deliberately does NOT define (owned by EXPR / META). */
export const NOT_HOST_FUNCTIONS = Object.freeze([
  "vtgetmetastate", "ragetmetastate", "getmetastate", "vtsetmetastate", "rasetmetastate", "setmetastate",
  "uiviewexists", "uiviewvisible", "uigetcontrol", "uisetlabel", "uisetvisible",
]);

function errText(e) {
  return e && e.message ? e.message : String(e);
}

/**
 * Register the host function library into an EXPR FunctionRegistry (only
 * `registry.define(name, impl, opts)` is used).
 * @returns {string[]} the names defined
 */
export function registerHostFunctions(registry, hctx = {}) {
  if (!registry || typeof registry.define !== "function") return [];
  const E = buildEnv(hctx || {});
  // setmotion[] keys are released on an operator hold, in portal space and on
  // detach (the meta engine runs registry.release(); review runtime-1).
  if (typeof registry.onRelease === "function") registry.onRelease(() => E.releaseMotion());
  const defined = [];
  for (const [name, factory, opts] of SPEC) {
    const impl = factory(E);
    const wrapped = (args, call) => {
      try {
        return impl(Array.isArray(args) ? args : [], call);
      } catch (e) {
        E.log(`${name}[] failed: ${errText(e)}`);
        return VAL.err(`${name}[] failed: ${errText(e)}`);
      }
    };
    try {
      if (registry.define(name, wrapped, opts || {}) !== false) defined.push(name);
    } catch (e) {
      E.log(`cannot register ${name}: ${errText(e)}`);
    }
  }
  return defined;
}

// ── the environment every implementation closes over ──────────────────────
function buildEnv(ctx) {
  const seen = new Map();
  const log = (msg) => {
    const m = String(msg);
    const t = Date.now();
    if (seen.has(m) && t - seen.get(m) < 10_000) return;
    if (seen.size > 256) seen.clear();
    seen.set(m, t);
    try {
      if (typeof ctx.log === "function") ctx.log(m);
      else console.log(`[vt:cmd] ${m}`);
    } catch (_) {
      /* never break an expression on logging */
    }
  };
  let ownActions = null;
  const host = () => {
    try {
      const h = typeof ctx.host === "function" ? ctx.host() : ctx.host;
      if (h) return h;
      return ctx.actions && typeof ctx.actions.host === "function" ? ctx.actions.host() : null;
    } catch (_) {
      return null;
    }
  };
  const actions = () => {
    if (ctx.actions) return ctx.actions;
    if (!ownActions) ownActions = createVtActions({ host, print: ctx.print, log, now: ctx.now, getRegex: ctx.getRegex });
    return ownActions;
  };
  const hc = (name, ...args) => {
    const h = host();
    if (!h || typeof h[name] !== "function") return undefined;
    try {
      return h[name](...args);
    } catch (e) {
      log(`${name} failed: ${errText(e)}`);
      return undefined;
    }
  };
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "bigint" ? Number(v) : typeof v === "boolean" ? (v ? 1 : 0) : 0);
  const me = () => (Number(hc("GetPlayerId")) >>> 0) || 0;
  const objName = (g) => {
    const n = hc("TryGetObjectName", Number(g) >>> 0);
    return typeof n === "string" ? n : "";
  };
  const warned = new Set();
  const unsupported = (name, why) => {
    if (!warned.has(name)) {
      warned.add(name);
      log(`meta function ${name}[] is not supported on web${why ? ` (${why})` : ""}`);
    }
    return VAL.err(`unsupported: ${name}`);
  };
  const regexCache = new Map();
  const toRegex = (pattern) => {
    const p = String(pattern ?? "");
    if (typeof ctx.getRegex === "function") {
      try {
        return ctx.getRegex(p, "i") || null;
      } catch (_) {
        return null;
      }
    }
    if (regexCache.has(p)) return regexCache.get(p);
    let re = null;
    try {
      re = new RegExp(p, "i");
    } catch (_) {
      log(`bad regex /${p}/ (no match)`);
    }
    if (regexCache.size > 512) regexCache.clear();
    regexCache.set(p, re);
    return re;
  };

  // Inventory rows normalised to {guid, name, wcid, stack, containerId, equipMask, itemType}.
  const inv = () =>
    actions()
      .inventory()
      .map((r) => ({
        guid: Number(r.guid) >>> 0,
        name: String(r.name ?? ""),
        wcid: Number(r.wcid) >>> 0,
        stack: Math.max(1, Number(r.stackSize) || 1),
        containerId: Number(r.containerId) >>> 0,
        equipMask: Number(r.equipMask) >>> 0,
        itemType: Number(r.itemType) >>> 0,
      }));
  const land = () => actions().landscape();
  const wcidOf = (g, row = null) => {
    if (!g) return 0;
    if (row && Number.isFinite(row.wcid) && row.wcid) return row.wcid;
    const w = Number(hc("TryGetObjectWcid", g)) >>> 0;
    if (w) return w;
    const r = inv().find((x) => x.guid === g);
    return r ? r.wcid : 0;
  };
  const classOf = (g) => (g ? actions().objectClassOf(g) : OBJECT_CLASS.Unknown);
  const nameIs = (name) => {
    const lw = String(name ?? "").trim().toLowerCase();
    return (o) => !!lw && String(o.name ?? "").toLowerCase() === lw;
  };
  const nameRx = (pattern) => {
    const re = String(pattern ?? "") ? toRegex(pattern) : null;
    return (o) => {
      if (!re) return false;
      re.lastIndex = 0;
      return re.test(String(o.name ?? ""));
    };
  };
  const toWobj = (o) => VAL.wobj(o.guid, o.name);
  const first = (rows) => (rows.length ? toWobj(rows[0]) : null);
  const nearest = (rows) => {
    if (!rows.length) return null;
    const sorted = rows.slice().sort((x, y) => (x.dist ?? Infinity) - (y.dist ?? Infinity));
    return toWobj(sorted[0]);
  };
  const seenGuids = (rows) => {
    const s = new Set();
    return rows.filter((o) => (s.has(o.guid) ? false : (s.add(o.guid), true)));
  };
  const listOf = (rows) => VAL.list(seenGuids(rows).map(toWobj));
  const stackSum = (rows) => rows.reduce((s, r) => s + (r.stack || 1), 0);
  const pose = () => {
    const p = hc("TryGetPlayerPose");
    return p && typeof p === "object" ? p : null;
  };
  const stats = () => {
    const s = hc("TryGetPlayerStats");
    return s && typeof s === "object" ? s : null;
  };
  const statRow = (group, id, field) => {
    const row = stats()?.[group]?.[id];
    return row ? num(Number(row[field])) : 0;
  };
  const vital = (vtId, field) => {
    const key = VITAL_KEY[vtId];
    return key ? statRow("vitals", key, field) : 0;
  };
  const charProp = (member, id, dflt) => {
    const g = me();
    if (!g) return dflt;
    const v = hc(member, g, id);
    if (v === undefined || v === null) return dflt;
    if (typeof dflt === "number") return num(typeof v === "bigint" ? Number(v) : v);
    return v;
  };
  const known = () => {
    const k = hc("TryGetKnownSpells");
    return Array.isArray(k) ? k.map((x) => Number(x) >>> 0) : [];
  };
  const canCast = (id) => {
    if (!(id > 0) || !known().includes(id)) return 0;
    const st = stats();
    const mana = st?.vitals?.[5];
    if (mana && Number(mana.current) === 0) return 0;
    return 1;
  };
  const spellName = (id) => {
    const r = hc("TryGetSpellRecord", Number(id) >>> 0);
    return r && typeof r.name === "string" ? r.name : "";
  };
  const enchantments = () => {
    const rows = hc("TryGetSelfEnchantments");
    return Array.isArray(rows) ? rows : null;
  };
  const spellExpiration = (pred, missingValue) => {
    const rows = enchantments();
    if (!rows) return missingValue;
    let best = null;
    for (const r of rows) {
      if (!r || r.isCooldown || !pred(r)) continue;
      const rem = r.permanent ? PERMANENT_S : Math.ceil(Number(r.remainingS) || 0);
      if (best === null || rem > best) best = rem;
    }
    return best === null || best <= 0 ? 0 : Math.min(best, PERMANENT_S);
  };
  const appraisal = (g) => {
    const a = g ? hc("TryGetObjectAppraisal", g) : null;
    return a && typeof a === "object" ? a : null;
  };
  const spellBook = (g) => {
    const sb = appraisal(g)?.spellBook;
    return Array.isArray(sb) ? sb.map((x) => Number(x) >>> 0).filter(Boolean) : [];
  };
  const isCreature = (g) => (Number(hc("TryGetObjectIntProperty", g, 1)) & 0x10) !== 0;
  const activeSpells = (g, name, what) => {
    if (!g) return VAL.list([]);
    if (g === me()) {
      const rows = enchantments();
      if (!rows) return VAL.list([]);
      const live = rows.filter((r) => r && !r.isCooldown);
      return VAL.list(live.map((r) => (what === "id" ? Number(r.spellId) >>> 0 : r.permanent ? -1 : num(Number(r.remainingS)))));
    }
    if (isCreature(g)) return unsupported(name, "ACE sends enchantments for the player only");
    const active = spellBook(g).filter((id) => id & 0x80000000);
    return VAL.list(active.map((id) => (what === "id" ? (id & 0x7fffffff) >>> 0 : -1)));
  };
  const creatures = () => ctx.creatures || null;
  const creatureWcid = (v) => {
    let g = guidOfValue(v);
    if (!g && typeof v === "string" && v.trim()) {
      const hit = actions().findNearestByName(v.trim(), { partial: false });
      g = hit ? hit.guid : 0;
    }
    return g ? wcidOf(g) : 0;
  };
  const packRoom = (arg, ofPlayer, ofPack) => {
    const room = hc("TryGetPackRoomCached") ?? hc("TryGetPackRoom");
    if (!room || typeof room !== "object") return -1;
    const g = guidOfValue(arg);
    if (!g || g === me()) {
      const v = ofPlayer(room);
      return typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : -1;
    }
    const p = Array.isArray(room.packs) ? room.packs.find((x) => (Number(x.guid) >>> 0) === g) : null;
    if (!p) return -1;
    const v = ofPack(p);
    return typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : -1;
  };
  const fellow = () => {
    const f = hc("TryGetFellowshipInfo");
    return f && typeof f === "object" ? f : null;
  };
  const fellowMembers = () => (Array.isArray(fellow()?.members) ? fellow().members : []);
  const bearingTo = (g) => {
    const me0 = pose();
    const pos = g ? hc("TryGetObjectPosition", g) : null;
    if (!me0 || !pos) return 0;
    const a = Number(me0.objCellId) >>> 0;
    const b = Number(pos.objCellId) >>> 0;
    let dx;
    let dy;
    if (a >>> 16 === b >>> 16) {
      dx = pos.x - me0.x;
      dy = pos.y - me0.y;
    } else {
      dx = ((b >>> 24) & 0xff) * 192 + pos.x - (((a >>> 24) & 0xff) * 192 + me0.x);
      dy = ((b >>> 16) & 0xff) * 192 + pos.y - (((a >>> 16) & 0xff) * 192 + me0.y);
    }
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return 0;
    const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
    return deg < 0 ? deg + 360 : deg;
  };
  const motion = new Map();
  const held = () => {
    try {
      if (typeof ctx.operatorHeld === "function") return ctx.operatorHeld() === true;
      const a = actions();
      return typeof a?.operatorHeld === "function" ? a.operatorHeld() === true : false;
    } catch (_) {
      return false;
    }
  };
  const inPortal = () => hc("IsPortalSpaceActive") === true;
  /** Let go of every movement key a setmotion[] pressed: one
   *  SetMovementInput(0,0,0,false) when any is down. → true when sent. */
  const releaseMotion = () => {
    let down = false;
    for (const v of motion.values()) if (v === true) down = true;
    motion.clear();
    if (!down) return false;
    const h = host();
    if (typeof h?.SetMovementInput !== "function") return false;
    return hc("SetMovementInput", 0, 0, 0, false) !== false;
  };
  const applyMotion = () => {
    const h = host();
    if (typeof h?.SetMovementInput !== "function") return false;
    const on = (m) => motion.get(m) === true;
    const forward = (on("forward") ? 1 : 0) - (on("backward") ? 1 : 0);
    const strafe = (on("straferight") ? 1 : 0) - (on("strafeleft") ? 1 : 0);
    const turn = (on("turnright") ? 1 : 0) - (on("turnleft") ? 1 : 0);
    return hc("SetMovementInput", forward, strafe, turn, !on("walk")) !== false;
  };
  const print = (text, cat = 0) => {
    try {
      if (typeof ctx.print === "function") ctx.print(String(text), cat);
      else host()?.WriteToChatWindow?.(String(text), cat);
    } catch (e) {
      log(`echo failed: ${errText(e)}`);
    }
  };
  // Read-only, option-like values derived from live state (PLAN R22):
  // `RouteReversed` = the loaded route's reverse flag (/rs reverseroute).
  const derived = (name) => {
    if (String(name).trim().toLowerCase() !== "routereversed") return undefined;
    try {
      const st = ctx.nav && typeof ctx.nav.status === "function" ? ctx.nav.status() : null;
      return !!(st && st.reversed);
    } catch (_) {
      return false;
    }
  };
  const getSetting = (name) => {
    const o = ctx.options;
    if (!name) return "";
    const d = derived(name);
    if (d !== undefined) return d;
    try {
      const r = o?.get?.(name, { vtUnits: true });
      if (r && r.ok) return r.value === undefined ? "" : r.value;
      if (o?.bag?.has?.(name)) {
        const v = o.bag.get(name);
        return v === undefined ? "" : v;
      }
    } catch (e) {
      log(`getsetting ${name} failed: ${errText(e)}`);
    }
    return "";
  };
  const setSetting = (name, value) => {
    const o = ctx.options;
    if (derived(name) !== undefined) {
      log(`${name} is read-only (use /rs reverseroute)`);
      return 0;
    }
    if (!name || !o) return 0;
    const v = toScalar(value);
    try {
      const r = o.set?.(name, v, { source: "meta" });
      if (r && r.ok) return 1;
      if (r && /unknown option/i.test(String(r.error ?? ""))) {
        if (typeof o.bag?.set === "function") {
          if (!o.bag.has?.(name)) log(`setting "${name}" is not a known option — kept in the meta option bag`);
          o.bag.set(name, v);
          return 1;
        }
        return 0;
      }
      log(`cannot set ${name}: ${r?.error ?? "refused"}`);
      return 0;
    } catch (e) {
      log(`setsetting ${name} failed: ${errText(e)}`);
      return 0;
    }
  };
  return {
    ctx,
    log,
    host,
    hc,
    num,
    me,
    objName,
    actions,
    unsupported,
    inv,
    land,
    wcidOf,
    classOf,
    nameIs,
    nameRx,
    first,
    nearest,
    listOf,
    stackSum,
    pose,
    statRow,
    vital,
    charProp,
    known,
    canCast,
    spellName,
    spellExpiration,
    spellBook,
    activeSpells,
    creatures,
    creatureWcid,
    packRoom,
    fellow,
    fellowMembers,
    bearingTo,
    motion,
    applyMotion,
    held,
    inPortal,
    releaseMotion,
    print,
    quests: () => ctx.quests || null,
    getSetting,
    setSetting,
  };
}
