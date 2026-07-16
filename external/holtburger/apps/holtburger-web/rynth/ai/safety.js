// safety.js — standalone SAFETY / GOVERNOR layer for the AI director:
// defense-in-depth action sanitizing over actions.js validateAction, a
// rolling call/spend governor, and a plan filter the integrator can slot in
// front of executePlan:
//
//   const gov = new RateGovernor({ maxSpendUsd: 1 });
//   if (gov.allowCall().ok) { gov.recordCall(); /* client.chat(...) */ }
//   const { actions, rejected } = guardPlan(plan.actions, { maxActions: gov.maxActionsPerCheck });
//   await executePlan(bot, actions);
//
// This module MODIFIES NO v1 file — it only calls the frozen actions.js
// surface. Everything is pure / deterministic with an injected `now`, and
// NEVER throws: the bot must survive the LLM (and this layer) being wrong
// (SPEC "Cost & safety discipline").

import { ACTIONS, validateAction } from "./actions.js";

// Bounds mirror actions.js:8-10 (module-private there) + SPEC §actions.
const MAX_LOC_DEG = 102; // documented for symmetry; goto is deliberately NOT clamped (see below)
const SAY_MAX_CHARS = 120;
const NOTE_MAX_CHARS = 500;
const CHECKIN_MIN = 1;
const CHECKIN_MAX = 30;
const PRIORITY_MIN = 1;
const PRIORITY_MAX = 99;
// Defense-only caps with no v1 equivalent: any other string param (future
// lookup queries etc.), priority-rule names, and rule count — an unbounded
// rules blob is a journal/prompt DoS, not a game action.
const GENERIC_TEXT_MAX = 500;
const RULE_NAME_MAX = 100;
const MAX_PRIORITY_RULES = 64;
const HOUR_MS = 3_600_000; // same rolling window as director.js:12

// All C0/C1 controls (incl. \t \n \r — chat is single-line; a newline could
// smuggle a second line starting with "@") plus the JS line separators.
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
// Invisible/format characters an LLM reply (or an injected item name echoed
// back through the observation) could use to hide a leading command char:
// whitespace, soft hyphen, CGJ, arabic letter mark, Hangul fillers, Mongolian
// selectors, zero-widths + bidi marks, bidi embeds/isolates, word-joiner +
// invisible operators, variation selectors, BOM.
const LEADING_JUNK_RE =
  /^[\s\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFE00-\uFE0F\uFEFF\uFFA0]+/;
// Keys that would collide with Object plumbing when rebuilt/spread
// (executeAction spreads rules at actions.js:144).
const RESERVED_RULE_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/** NFKC-fold (＠ -> @, ／ -> /) and strip leading invisibles so a disguised
 * command char lands at position 0 for the check. */
function commandStripped(text) {
  let t = text;
  try { t = t.normalize("NFKC"); } catch {}
  return t.replace(LEADING_JUNK_RE, "");
}

/** Screen one string param. -> null when clean, else the rejection reason. */
function screenText(value, { maxChars = GENERIC_TEXT_MAX, label = "text" } = {}) {
  if (typeof value !== "string") return `${label} must be a string`;
  if (CONTROL_RE.test(value)) return `${label} contains control characters`;
  const stripped = commandStripped(value);
  if (!stripped.trim()) return `${label} is empty`;
  // SPEC §actions bans "@" admin commands; "/" client slash commands are the
  // same in-game command channel, so the safety layer bans both.
  if (stripped.startsWith("@") || stripped.startsWith("/"))
    return `refused: ${label} starts with an in-game command character ("@" or "/")`;
  if (value.trim().length > maxChars) return `${label} exceeds ${maxChars} chars`;
  return null;
}

/** Round-then-clamp a plain finite number into [lo, hi]; null = reject-worthy. */
function clampInt(v, lo, hi) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

// Per-type caps for text params the v1 catalog defines; anything else string
// falls back to GENERIC_TEXT_MAX.
const TEXT_CAPS = { say: { text: SAY_MAX_CHARS }, note: { text: NOTE_MAX_CHARS } };

/**
 * Defense-in-depth sanitizer over actions.js validateAction.
 * -> { ok:true, action, note? } | { ok:false, error }
 *
 * Beyond validateAction it: screens EVERY string param (control chars,
 * hidden leading "@"/"/" after NFKC + invisible-strip, length caps) — this
 * generically covers say/note today and any text-bearing action (lookup
 * etc.) registered into ACTIONS later; clamps numeric params to bounds where
 * the clamp can only reduce cost/impact (set_checkin down to 30,
 * set_loot_min_value up to 0, priorities into 1..99 — each with a `note`),
 * and rejects where a clamp would amplify (set_checkin below 1 = faster,
 * costlier cadence; goto beyond ±102 = a destination the model never asked
 * for). Pure — the input is never mutated; `action` is a fresh clone. Never
 * throws.
 */
export function sanitizeAction(a) {
  try {
    if (!a || typeof a !== "object" || Array.isArray(a)) return { ok: false, error: "action must be an object" };
    if (typeof a.type !== "string" || !Object.prototype.hasOwnProperty.call(ACTIONS, a.type))
      return { ok: false, error: `unknown action type: ${JSON.stringify(a && a.type)}` };
    const action = { ...a };
    const notes = [];

    for (const [k, v] of Object.entries(action)) {
      if (k === "type" || typeof v !== "string") continue;
      const err = screenText(v, { maxChars: TEXT_CAPS[action.type]?.[k] ?? GENERIC_TEXT_MAX, label: k });
      if (err) return { ok: false, error: err };
    }

    switch (action.type) {
      case "set_checkin": {
        const orig = action.minutes;
        const m = clampInt(orig, CHECKIN_MIN, CHECKIN_MAX);
        if (m == null) return { ok: false, error: "minutes must be a finite number" };
        if (orig < CHECKIN_MIN)
          // Clamping UP would hand the model the fastest (most expensive)
          // cadence it just tried to undercut — reject instead.
          return { ok: false, error: `minutes must be >= ${CHECKIN_MIN} (refused: not clamping to a faster cadence)` };
        if (m !== orig) { notes.push(`minutes clamped ${orig} -> ${m}`); action.minutes = m; }
        break;
      }
      case "set_loot_min_value": {
        const orig = action.value;
        const v = clampInt(orig, 0, Number.MAX_SAFE_INTEGER);
        if (v == null) return { ok: false, error: "value must be a finite number" };
        if (v !== orig) { notes.push(`value clamped ${orig} -> ${v}`); action.value = v; }
        break;
      }
      case "set_priorities": {
        const r = action.rules;
        if (!r || typeof r !== "object" || Array.isArray(r))
          return { ok: false, error: "rules must be an object of name -> int 1..99" };
        const entries = Object.entries(r);
        if (entries.length > MAX_PRIORITY_RULES)
          return { ok: false, error: `too many rules (${entries.length} > ${MAX_PRIORITY_RULES})` };
        const rules = {};
        for (const [name, val] of entries) {
          // Rule names never reach chat, so no "@" check — but control
          // chars / emptiness / length are still junk, and Object-plumbing
          // names would corrupt the rebuilt rules object.
          if (RESERVED_RULE_NAMES.has(name)) return { ok: false, error: `reserved rule name ${JSON.stringify(name)}` };
          if (CONTROL_RE.test(name)) return { ok: false, error: "rule name contains control characters" };
          if (!name.trim()) return { ok: false, error: "rule names must be non-empty" };
          if (name.length > RULE_NAME_MAX) return { ok: false, error: `rule name exceeds ${RULE_NAME_MAX} chars` };
          const p = clampInt(val, PRIORITY_MIN, PRIORITY_MAX);
          if (p == null) return { ok: false, error: `priority for ${JSON.stringify(name)} must be a number` };
          if (p !== val) notes.push(`priority ${JSON.stringify(name)} clamped ${val} -> ${p}`);
          rules[name] = p;
        }
        action.rules = rules;
        break;
      }
      // goto / goto_lb numerics are deliberately NOT clamped: snapping a
      // coordinate to the map edge sends the bot somewhere the model never
      // asked for. validateAction below rejects out-of-range travel outright.
      default:
        break;
    }

    // Final gate: the frozen v1 validator on the sanitized clone, so anything
    // the screens above miss still hits shape+bounds validation.
    let v;
    try { v = validateAction(action); } catch (e) { v = { ok: false, error: `validate threw: ${String(e?.message ?? e)}` }; }
    if (!v || v.ok !== true) return { ok: false, error: (v && v.error) || "invalid action" };

    const out = { ok: true, action };
    if (notes.length) out.note = notes.join("; ");
    return out;
  } catch (e) {
    return { ok: false, error: `sanitize failed: ${String((e && e.message) || e)}` };
  }
}

const intAtLeast0 = (v, dflt) => (Number.isInteger(v) && v >= 0 ? v : dflt);

/**
 * Deterministic call/spend budget with an injected clock. Window semantics
 * match director.js:123 (`now - t < 60min` keeps a call). `allowCall` /
 * `note` never mutate history except pruning expired stamps; `recordCall`
 * counts attempts, success or not (director.js:145). `allowSpend(usd)`
 * takes the CUMULATIVE spend estimate to date (the integrator prices
 * client.spend token counters); with a cap set, an unknown/non-finite spend
 * FAILS CLOSED. Defaults mirror SPEC "Cost & safety discipline".
 */
export class RateGovernor {
  constructor(opts = {}) {
    const { maxCallsPerHour = 12, maxActionsPerCheck = 5, maxSpendUsd = null } = opts || {};
    this.maxCallsPerHour = intAtLeast0(maxCallsPerHour, 12);
    this.maxActionsPerCheck = intAtLeast0(maxActionsPerCheck, 5);
    const cap = Number(maxSpendUsd);
    this.maxSpendUsd = maxSpendUsd == null || !Number.isFinite(cap) || cap < 0 ? null : cap;
    this._calls = [];
  }

  _inWindow(now) { return this._calls.filter((t) => now - t < HOUR_MS); }

  /** -> { ok, reason? }. Check only — does not record. */
  allowCall(now = Date.now()) {
    try {
      const n = Number(now);
      if (!Number.isFinite(n)) return { ok: false, reason: "invalid now" }; // fail closed
      this._calls = this._inWindow(n);
      if (this._calls.length >= this.maxCallsPerHour)
        return { ok: false, reason: `${this._calls.length} calls in last 60 min (max ${this.maxCallsPerHour})` };
      return { ok: true };
    } catch { return { ok: false, reason: "governor error" }; }
  }

  recordCall(now = Date.now()) {
    try {
      const n = Number(now);
      if (!Number.isFinite(n)) return; // a poisoned stamp would corrupt the window
      this._calls = this._inWindow(n);
      this._calls.push(n);
    } catch {}
  }

  /** -> { ok, reason? }. usd = cumulative spend estimate so far. */
  allowSpend(usd) {
    try {
      if (this.maxSpendUsd == null) return { ok: true };
      const n = Number(usd);
      if (!Number.isFinite(n))
        return { ok: false, reason: `spend unknown (${String(usd)}) with $${this.maxSpendUsd} cap set` };
      if (n >= this.maxSpendUsd) return { ok: false, reason: `spend $${n} >= cap $${this.maxSpendUsd}` };
      return { ok: true };
    } catch { return { ok: false, reason: "governor error" }; }
  }

  /** One-line telemetry for journals/status lines. Non-mutating. */
  note(now = Date.now()) {
    try {
      const n = Number(now);
      const inWindow = Number.isFinite(n) ? this._inWindow(n).length : this._calls.length;
      const spend = this.maxSpendUsd == null ? "off" : `$${this.maxSpendUsd}`;
      return `governor: ${inWindow}/${this.maxCallsPerHour} calls in last 60 min; <=${this.maxActionsPerCheck} actions/check; spend cap ${spend}`;
    } catch { return "governor: n/a"; }
  }
}

/**
 * Filter a plan before executePlan: sanitize each action, keep at most
 * maxActions. -> { actions: kept sanitized clones, rejected: [{ action:
 * original, error }], notes: [{ action, note }] } (`notes` is additive
 * telemetry — clamps that kept an action alive). Non-array input degrades to
 * an empty plan (matches executePlan, actions.js:186). Never throws, even
 * with an injected sanitize that does.
 */
export function guardPlan(actions, opts = {}) {
  const { sanitize = sanitizeAction, maxActions = 5 } = opts || {};
  const cap = intAtLeast0(maxActions, 5);
  const kept = [];
  const rejected = [];
  const notes = [];
  const list = Array.isArray(actions) ? actions : [];
  for (const a of list) {
    let s;
    try { s = sanitize(a); } catch (e) { s = { ok: false, error: String((e && e.message) || e) }; }
    if (!s || s.ok !== true) { rejected.push({ action: a, error: (s && s.error) || "rejected" }); continue; }
    if (kept.length >= cap) { rejected.push({ action: a, error: `plan truncated: over maxActions=${cap}` }); continue; }
    const sanitized = s.action ?? a;
    kept.push(sanitized);
    if (s.note) notes.push({ action: sanitized, note: s.note });
  }
  return { actions: kept, rejected, notes };
}
