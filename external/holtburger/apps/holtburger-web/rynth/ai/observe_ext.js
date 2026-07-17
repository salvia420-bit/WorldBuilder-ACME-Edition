// observe_ext.js — ADDITIVE observation enricher over observe.js output.
// Does NOT modify or re-implement buildObservation: the caller composes
//   enrichObservation(bot, buildObservation(bot, opts), { ...opts, state })
// (e.g. via the director's injectable `observe` dep, director.js:42-52).
// APPENDS director-useful sections: kill-rate trend, burden/free-slots,
// nearby portals, and a one-line "suggested focus" heuristic.
//
// Contract (task B6):
// - baseResult is returned UNCHANGED (same object) on ANY error — one outer
//   try/catch, so a hostile/throwing bot can never break a check-in; the
//   base observation still reaches the LLM. Absent subsystems are handled
//   by existence checks (not throws) and render "n/a".
// - maxChars is re-applied after appending (extension lines drop from the
//   END — portals first, focus last — then the observe.js hard slice).
// - buildObservation is stateless; the kill trend keeps its short history
//   in the CALLER-OWNED `opts.state` object. No state -> trend is "n/a".

import { ADVANCEMENT_MAPS } from "./tools/advancement.js";

const NA = "n/a";
const { SKILLS, TRAINED_COST } = ADVANCEMENT_MAPS;
const ID2SKILL = Object.fromEntries(Object.entries(SKILLS).map(([n, i]) => [i, n]));
// Buff-relevant magic schools worth flagging as trainable when untrained.
const WISH_MAGIC = [32, 31, 16, 34]; // item_enchantment, creature_enchantment, mana_conversion, war_magic
// PropertyInt 1 = ItemType, read the same way combat_loop.js:175 reads it;
// Portal bit per Chorizite.Common/Enums/ItemType.cs:41.
const ITEM_TYPE_PORTAL = 0x00010000;
// PropertyInt.EncumbranceVal — Chorizite.Common/Enums/PropertyInt.cs:14.
const PROP_INT_ENCUMBRANCE = 5;
const PORTAL_TOP_N = 3;
const TREND_WINDOW_MS = 10 * 60_000; // kill-rate window (~2 check-ins)
const IDLE_TRAVEL_MS = 5 * 60_000;   // 0 kills for this long -> travel hint
const LOW_HP_PCT = 40;               // below this -> pause hint

// Duck-typed host getters, probed in order (SPEC roadmap hosts may expose
// these; today's RynthWebHost does not — the EncumbranceVal int-property
// read below is the only live fallback).
const BURDEN_GETTERS = ["TryGetBurden", "GetBurden", "getBurden"];
const FREE_SLOT_GETTERS = ["TryGetFreeSlots", "GetFreeSlots", "getFreeSlots", "GetFreeInventorySlots"];

const fin = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Enrich a buildObservation result. -> { text, data } (base on any error). */
export function enrichObservation(bot, baseResult, opts = {}) {
  // Not a buildObservation-shaped result -> nothing safe to append to.
  if (!baseResult || typeof baseResult.text !== "string") return baseResult;
  try {
    return enrich(bot || {}, baseResult, opts);
  } catch {
    return baseResult; // base unchanged on ANY error (task contract)
  }
}

function enrich(bot, base, { now = Date.now(), maxChars = 6000, state = null, trendWindowMs = TREND_WINDOW_MS } = {}) {
  const d = base.data && typeof base.data === "object" ? base.data : {};

  const trend = killTrend(bot, d, state, now, trendWindowMs);
  const burden = probeBurden(bot);
  const portals = nearbyPortals(bot);
  const advancement = probeAdvancement(bot);
  const nearby = probeNearbyObjects(bot);
  const focus = suggestFocus(d, trend);
  const ext = { trend, burden, portals, focus, advancement, nearby };

  // Importance order: dropping from the END under maxChars sheds portals
  // first and the focus/nearby/advancement lines last (perception + focus
  // are the most decision-critical, so they survive truncation).
  const lines = [
    `focus: ${focus}`,
    nearbyLine(nearby),
    advancementLine(advancement),
    trendLine(trend),
    burdenLine(burden),
    portalLine(portals),
  ];

  let text = base.text;
  while (lines.length && `${base.text}\n${lines.join("\n")}`.length > maxChars) lines.pop();
  if (lines.length) text = `${base.text}\n${lines.join("\n")}`;
  if (text.length > maxChars) text = text.slice(0, maxChars); // observe.js:275 hard-cap parity

  return { text, data: { ...d, ext } }; // base.data is never mutated
}

// ── kill trend ─────────────────────────────────────────────────────────
// Cumulative kill count comes from the base data when observe already
// extracted it (data.kernel.kills, observe.js:84-87), else straight off
// the bot. Samples live in caller-owned state._killSamples.
function killTrend(bot, d, state, now, windowMs) {
  if (!state || typeof state !== "object") return null;
  let kills = fin(d.kernel?.kills);
  if (kills == null && bot.kernel && typeof bot.kernel === "object") {
    kills = fin(bot.kernel.status?.kills);
  }
  if (kills == null) return null;

  if (!Array.isArray(state._killSamples)) state._killSamples = [];
  const s = state._killSamples;
  // Counter went backwards (kernel restart) -> the old history is a lie.
  if (s.length && s[s.length - 1].kills > kills) s.length = 0;
  s.push({ t: now, kills });
  while (s.length && s[0].t < now - windowMs) s.shift();

  const first = s[0], last = s[s.length - 1];
  const spanMs = last.t - first.t;
  if (s.length < 2 || spanMs <= 0) return { ratePerMin: null, kills, delta: 0, spanMs: 0, samples: s.length };
  const delta = last.kills - first.kills;
  return {
    ratePerMin: Math.round((delta / (spanMs / 60_000)) * 10) / 10,
    kills,
    delta,
    spanMs,
    samples: s.length,
  };
}

function trendLine(trend) {
  if (!trend) return `kill_trend: ${NA}`;
  if (trend.ratePerMin == null) return "kill_trend: warming up (1 sample)";
  return `kill_trend: ${trend.ratePerMin}/min over ${Math.round(trend.spanMs / 60_000)}m (+${trend.delta} kills)`;
}

// ── burden / free slots ────────────────────────────────────────────────
function probeBurden(bot) {
  const h = bot.host;
  if (!h || typeof h !== "object") return null;
  let burden = null;
  for (const name of BURDEN_GETTERS) {
    if (typeof h[name] === "function") { burden = fin(h[name]()); break; }
  }
  if (burden == null && typeof h.GetPlayerId === "function" && typeof h.TryGetObjectIntProperty === "function") {
    burden = fin(h.TryGetObjectIntProperty(h.GetPlayerId(), PROP_INT_ENCUMBRANCE));
  }
  let freeSlots = null;
  for (const name of FREE_SLOT_GETTERS) {
    if (typeof h[name] === "function") { freeSlots = fin(h[name]()); break; }
  }
  if (burden == null && freeSlots == null) return null;
  return { burden, freeSlots };
}

function burdenLine(b) {
  const v = (x) => (x == null ? NA : x);
  return `burden: ${v(b?.burden)} | free_slots: ${v(b?.freeSlots)}`;
}

// ── advancement (unspent XP, skill credits, raisable/ trainable) ────────
// Surfaces the raw advancement state so the LLM can DECIDE to spend XP /
// train skills. Deliberately NOT prescriptive (no "raise endurance now"
// instruction) — the data (low HP + unspent XP) is there; the reasoning is
// the playtester's. Reads the RynthWebHost advancement plane; null when the
// host predates it or the stats plane hasn't hydrated.
function probeAdvancement(bot) {
  const h = bot.host;
  if (!h || typeof h.TryGetPlayerStats !== "function") return null;
  const st = h.TryGetPlayerStats();
  if (!st) return null;
  const credits = typeof h.TryGetSkillCredits === "function" ? fin(h.TryGetSkillCredits()) : null;
  const trained = [];
  for (const [id, sk] of Object.entries(st.skills || {})) {
    if (sk && sk.training >= 2) trained.push({ name: ID2SKILL[id] || `skill${id}`, cur: sk.current, nextCost: sk.nextCost, spec: sk.training === 3 });
  }
  const trainable = [];
  for (const id of WISH_MAGIC) {
    const sk = st.skills?.[id];
    if (!sk || sk.training < 2) trainable.push({ name: ID2SKILL[id], cost: TRAINED_COST[id] });
  }
  return {
    level: st.level,
    unspentXp: st.unspentXp,
    skillCredits: credits,
    end: st.attributes?.[2]?.current ?? null,
    self: st.attributes?.[6]?.current ?? null,
    hp: st.vitals?.[1] ?? null,
    mana: st.vitals?.[5] ?? null,
    trained,
    trainable,
  };
}

function advancementLine(a) {
  if (!a) return `advancement: ${NA}`;
  const parts = [`L${a.level}`, `unspentXP=${a.unspentXp}`, `skillCredits=${a.skillCredits ?? NA}`];
  if (a.end != null) parts.push(`End=${a.end}${a.hp ? `(HP ${a.hp.current}/${a.hp.max})` : ""}`);
  if (a.self != null) parts.push(`Self=${a.self}${a.mana ? `(Mana ${a.mana.current}/${a.mana.max})` : ""}`);
  if (a.trained?.length) parts.push(`raisable: ${a.trained.map((s) => `${s.name}${s.spec ? "*" : ""} ${s.cur}${s.nextCost ? `(+${s.nextCost}xp)` : ""}`).join(", ")}`);
  if (a.trainable?.length && (a.skillCredits == null || a.skillCredits > 0))
    parts.push(`can-train(cost credits): ${a.trainable.map((s) => `${s.name}(${s.cost}cr)`).join(", ")}`);
  return `advancement: ${parts.join(" · ")}`;
}

// ── nearby objects (general perception — "look around the room") ────────
// Surfaces ALL named nearby objects/NPCs (not just attackable threats): the
// portal you can enter, the NPCs you can talk to, doors, chests, signs. This
// is the playtester's general sight; use_object (tools/world.js) is the hand.
// Deliberately not filtered to a task — the LLM reads names/types and decides.
const NEARBY_TOP_N = 16;
// ObjectDescriptionFlag bits (ObjectDescriptionFlag.generated.cs) — the client
// receives these, so a shopkeeper/healer/portal/lifestone/door/corpse is
// distinguishable at a glance without any world-DB lookup.
const ODF = {
  PLAYER: 0x8, ATTACKABLE: 0x10, BOOK: 0x100, VENDOR: 0x200, DOOR: 0x1000,
  CORPSE: 0x2000, LIFESTONE: 0x4000, FOOD: 0x8000, HEALER: 0x10000,
  PORTAL: 0x40000, BINDSTONE: 0x8000000, INSCRIBABLE: 0x2,
};
// Decode the flags into one salient category the LLM can act on. null flags =
// not yet streamed -> "?" (do NOT mislabel as monster: the old ObjectIsAttackable
// fail-open tagged every un-streamed sign/door as [creature]).
function classifyDesc(flags) {
  if (flags == null) return "?";
  // Specific object bits win over the generic ATTACKABLE bit — many world
  // objects (tutorial signs, food, some items) carry ATTACKABLE too, but are
  // better described by what they actually are.
  if (flags & ODF.PLAYER) return "player";
  if (flags & ODF.VENDOR) return "vendor";
  if (flags & ODF.HEALER) return "healer";
  if (flags & ODF.PORTAL) return "portal";
  if (flags & (ODF.LIFESTONE | ODF.BINDSTONE)) return "lifestone";
  if (flags & ODF.CORPSE) return "corpse";
  if (flags & ODF.DOOR) return "door";
  if (flags & ODF.FOOD) return "food";
  if (flags & ODF.BOOK) return "sign"; // readable plaque/book (INSCRIBABLE alone is unreliable — armor is inscribable)
  if (flags & ODF.ATTACKABLE) return "monster";
  return "npc"; // named, non-attackable, none of the above -> a person to talk to
}
function objGlobal(cell, x, y) {
  return { gx: ((cell >>> 24) & 0xff) * 192 + x, gy: ((cell >>> 16) & 0xff) * 192 + y };
}
function probeNearbyObjects(bot) {
  const h = bot.host;
  if (!h || typeof h.NearbyGuids !== "function" || typeof h.TryGetObjectName !== "function") return null;
  const me = typeof h.TryGetPlayerPose === "function" ? h.TryGetPlayerPose() : null;
  const meG = me ? objGlobal(me.objCellId >>> 0, me.x, me.y) : null;
  const out = [];
  let guids = [];
  try { guids = h.NearbyGuids() || []; } catch { return null; }
  for (const g of guids) {
    let name = null;
    try { name = h.TryGetObjectName(g); } catch {}
    if (!name) continue; // skip unnamed clutter
    let flags = null;
    try { flags = typeof h.TryGetObjectDescFlags === "function" ? h.TryGetObjectDescFlags(g) : null; } catch {}
    const type = classifyDesc(flags);
    let dist = null;
    let brg = null;
    try {
      const p = h.TryGetObjectPosition(g);
      if (p && meG) {
        const o = objGlobal(p.objCellId >>> 0, p.x, p.y);
        dist = Math.hypot(o.gx - meG.gx, o.gy - meG.gy, (p.z || 0) - (me.z || 0));
        brg = compassOctant(o.gx - meG.gx, o.gy - meG.gy);
      }
    } catch {}
    out.push({ guid: g >>> 0, name, type, dist, brg });
  }
  out.sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9));
  return out.slice(0, NEARBY_TOP_N);
}
// Compass octant from a world-frame delta (+x east, +y north) — gives the
// model a bearing to pair with the distance, so "walk toward" is decidable.
function compassOctant(dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return null;
  const oct = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"];
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI; // 0=E, 90=N
  return oct[((Math.round(deg / 45) % 8) + 8) % 8];
}

function nearbyLine(objs) {
  if (!objs) return `nearby: ${NA}`;
  if (!objs.length) return "nearby: nothing named in range";
  // guid included so use_object can disambiguate same-named objects (two Doors).
  return `nearby: ${objs.map((o) => `${o.name} [${o.type}] 0x${o.guid.toString(16)}${o.dist != null ? ` d=${o.dist.toFixed(0)}m` : ""}${o.brg ? ` ${o.brg}` : ""}`).join("; ")}`;
}

// ── nearby portals ─────────────────────────────────────────────────────
// Recall-SPELL hints are deliberately absent: there is no verified SpellId
// table in-repo to map recall ids from (see INTEGRATION-NOTES.md).
function nearbyPortals(bot) {
  const h = bot.host;
  if (!h || typeof h !== "object") return null;
  for (const m of ["NearbyGuids", "TryGetObjectIntProperty", "TryGetObjectPosition", "TryGetPlayerPose", "TryGetObjectName"]) {
    if (typeof h[m] !== "function") return null;
  }
  const me = h.TryGetPlayerPose();
  if (!me) return null;
  const out = [];
  for (const g of h.NearbyGuids()) {
    const itemType = h.TryGetObjectIntProperty(g, 1);
    if (typeof itemType !== "number" || !(itemType & ITEM_TYPE_PORTAL)) continue;
    const p = h.TryGetObjectPosition(g);
    if (!p) continue;
    // Global-frame distance, same math as observe.js:36-44 globalDist
    // (module-private there, so inlined).
    const gx = (cell, x) => ((cell >>> 24) & 0xff) * 192 + x;
    const gy = (cell, y) => ((cell >>> 16) & 0xff) * 192 + y;
    const dist = Math.hypot(
      gx(p.objCellId >>> 0, p.x) - gx(me.objCellId >>> 0, me.x),
      gy(p.objCellId >>> 0, p.y) - gy(me.objCellId >>> 0, me.y),
      (p.z || 0) - (me.z || 0)
    );
    out.push({ guid: g >>> 0, name: h.TryGetObjectName(g) || "?", dist });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.slice(0, PORTAL_TOP_N);
}

function portalLine(portals) {
  if (!portals) return `portals: ${NA}`;
  if (!portals.length) return "portals: none";
  return `portals: ${portals.map((p) => `${p.name} d=${p.dist.toFixed(1)}m`).join("; ")}`;
}

// ── suggested focus ────────────────────────────────────────────────────
// One-line heuristic over the base data (already safely extracted by
// observe.js) + the trend. A HINT for the LLM, never an instruction the
// code acts on itself.
function suggestFocus(d, trend) {
  const hp = fin(d.vitals?.hp);
  if (hp != null && hp < LOW_HP_PCT) return `vitals low (hp=${Math.round(hp)}%) -> consider pause`;
  const threats = Array.isArray(d.threats) ? d.threats.length : null;
  const corpses = fin(d.corpses);
  if (threats === 0 && corpses != null && corpses > 0) {
    return `no threats + ${corpses} corpse(s) -> loot`;
  }
  if (threats === 0 && trend && trend.delta === 0 && trend.spanMs >= IDLE_TRAVEL_MS) {
    return `idle ${Math.round(trend.spanMs / 60_000)}m with 0 kills -> consider travel`;
  }
  return "steady -> none";
}
