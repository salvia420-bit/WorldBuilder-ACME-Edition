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

const NA = "n/a";
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
  const focus = suggestFocus(d, trend);
  const ext = { trend, burden, portals, focus };

  // Importance order: dropping from the END under maxChars sheds portals
  // first and the focus line last.
  const lines = [
    `focus: ${focus}`,
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
