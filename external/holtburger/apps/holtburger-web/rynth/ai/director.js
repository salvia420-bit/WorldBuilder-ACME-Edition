// director.js — the LLM check-in loop over the grind bot: observe -> chat ->
// parse plan -> execute -> journal -> reschedule. Minute-cadence setTimeout
// chain; hard budgets; every failure path leaves the bot grinding untouched.
// INTERFACE FROZEN — see rynth/ai/SPEC.md §director (incl. the REPLY
// CONTRACT).

import { buildObservation } from "./observe.js";
import { renderActionCatalog, validateAction, executePlan } from "./actions.js";
import { extractJson } from "./llm_client.js";

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

// Guarded render: a broken/absent action catalog must degrade the prompt,
// not break the director import (SPEC "every director failure path degrades
// to bot keeps grinding untouched").
let _catalog;
try { _catalog = renderActionCatalog(); } catch { _catalog = "(action catalog unavailable)"; }

export const DEFAULT_SYSTEM_PROMPT = [
  "You are the strategic director of an autonomous Asheron's Call grind bot.",
  "The bot survives on its own — it fights, loots, buffs and travels without",
  "you. You check in every few minutes, read the observation, and steer at a",
  "strategic level: adjust hunting priorities, loot threshold, travel, pause,",
  "or leave yourself a note. You are never consulted per-tick.",
  "",
  "ACTIONS",
  _catalog,
  "",
  "REPLY CONTRACT",
  "Reply with exactly ONE JSON object and nothing outside it:",
  '{"analysis": "<short>", "actions": [{"type": "...", ...}], "next_check_minutes": <1..30>, "note": "<optional note-to-self>"}',
  "",
  "COST DISCIPLINE",
  "You are called every few minutes; be decisive. If the bot is doing fine,",
  'prefer {"actions":[{"type":"none"}]} over churn.',
].join("\n");

export class RynthAiDirector {
  constructor(bot, {
    client, journal, observe = buildObservation,
    // execute/validate are injectable for tests (additive to the frozen SPEC
    // surface; defaults are the SPEC-mandated actions.js entry points).
    execute = executePlan, validate = validateAction,
    intervalMinutes = 5, minIntervalMinutes = 1, maxIntervalMinutes = 30,
    maxCallsPerHour = 12, maxErrorsBeforeDisable = 5,
    systemPrompt = DEFAULT_SYSTEM_PROMPT, dryRun = false, log,
  } = {}) {
    this.bot = bot;
    this.client = client;
    this.journal = journal;
    this.observe = observe;
    this.execute = execute;
    this.validate = validate;
    this.intervalMinutes = intervalMinutes;
    this.minIntervalMinutes = minIntervalMinutes;
    this.maxIntervalMinutes = maxIntervalMinutes;
    this.maxCallsPerHour = maxCallsPerHour;
    this.maxErrorsBeforeDisable = maxErrorsBeforeDisable;
    this.systemPrompt = systemPrompt;
    this.dryRun = dryRun;
    this.enabled = false;
    this._log = typeof log === "function" ? log : () => {};
    this._timer = null;
    this._nextCheckAt = null;
    this._lastCheckAt = null;
    this._inflight = null;
    this._running = false;
    this._calls = 0;        // cumulative chat attempts (incl. failed)
    this._callTimes = [];   // chat-attempt stamps for the rolling 60-min budget
    this._consecutiveErrors = 0;
    this._lastSummary = null;
  }

  /** Idempotent: enables the loop and schedules the first check-in at
   * intervalMinutes; a pending timer is left untouched. Re-enabling after a
   * disable resets the consecutive-error count (explicit user intent). */
  start() {
    if (!this.enabled) this._consecutiveErrors = 0;
    this.enabled = true;
    if (this._timer == null) this._schedule(this.intervalMinutes);
  }

  /** Idempotent: disables the loop and cancels any pending check-in. */
  stop() {
    this.enabled = false;
    if (this._timer != null) { clearTimeout(this._timer); this._timer = null; }
    this._nextCheckAt = null;
  }

  get status() {
    return {
      enabled: this.enabled,
      running: this._running,
      lastCheckAt: this._lastCheckAt,
      nextCheckAt: this._nextCheckAt,
      calls: this._calls,
      consecutiveErrors: this._consecutiveErrors,
      lastSummary: this._lastSummary,
      spend: this._spend(),
    };
  }

  /** One check-in (interval body + manual trigger). Serialized: while a
   * check-in is in flight, concurrent calls share it and resolve to the SAME
   * result object (documented choice per SPEC §director). Never rejects —
   * every failure resolves to { plan: null, results: [], error? } so the
   * timer chain and manual triggers can't take the bot down. */
  async checkNow() {
    if (this._inflight) return this._inflight;
    this._inflight = this._checkOnce()
      .catch((e) => this._fail("internal", e)) // belt-and-braces; steps below catch their own
      .finally(() => { this._inflight = null; this._running = false; });
    return this._inflight;
  }

  async _checkOnce() {
    this._running = true;
    const now = Date.now();

    // Rolling 60-min budget window (SPEC §director Budget): refuse, journal,
    // reschedule — no LLM call, not an error.
    this._callTimes = this._callTimes.filter((t) => now - t < HOUR_MS);
    if (this._callTimes.length >= this.maxCallsPerHour) {
      this._journal("budget", `skipped check-in: ${this._callTimes.length} calls in last 60 min (max ${this.maxCallsPerHour})`);
      this._schedule(this.intervalMinutes);
      return { plan: null, results: [], skipped: "budget" };
    }

    this._lastCheckAt = now;

    let obsText;
    try {
      let tail = "";
      try { tail = this.journal?.renderTail() ?? ""; } catch { tail = ""; }
      // opts.spend is the "AI spend counters if given" hook of SPEC §observe.
      const obs = this.observe(this.bot, { journalTail: tail, now, spend: this._spend() });
      obsText = typeof obs?.text === "string" ? obs.text : String(obs ?? "");
    } catch (e) {
      return this._fail("observe", e);
    }

    let res;
    try {
      this._callTimes.push(Date.now()); // attempts count toward budget, success or not
      this._calls++;
      res = await this.client.chat([
        { role: "system", content: this.systemPrompt },
        { role: "user", content: obsText },
      ]);
    } catch (e) {
      return this._fail("llm", e);
    }

    let plan = res?.json ?? null;
    if (!plan && typeof res?.text === "string") {
      try { plan = extractJson(res.text); } catch { plan = null; }
    }
    // A missing "actions" field is tolerated as a no-op (a degenerate-but-
    // parsed reply shouldn't burn an error toward disable); a non-array one
    // is an invalid reply.
    if (!plan || typeof plan !== "object") return this._fail("reply", new Error("invalid or missing JSON plan"));
    const rawActions = plan.actions == null ? [] : plan.actions;
    if (!Array.isArray(rawActions)) return this._fail("reply", new Error("plan.actions is not an array"));

    const valid = [];
    const results = [];
    for (const a of rawActions) {
      let v;
      try { v = this.validate(a); } catch (e) { v = { ok: false, error: String(e?.message ?? e) }; }
      if (v && v.ok) valid.push(a);
      else results.push({ type: a?.type ?? "?", ok: false, error: v?.error ?? "invalid" });
    }

    let execResults;
    if (this.dryRun) {
      // dryRun: full loop minus execution — observe/plan/journal/reschedule
      // all run, the bot is untouched (SPEC §director).
      execResults = valid.map((a) => ({ type: a.type, ok: true, dryRun: true }));
    } else {
      try {
        execResults = await this.execute(this.bot, valid, { log: this._log });
        if (!Array.isArray(execResults)) execResults = [];
      } catch (e) {
        // executePlan never throws by contract; guard injected replacements.
        execResults = [{ type: "plan", ok: false, error: String(e?.message ?? e) }];
      }
    }
    results.push(...execResults);

    const analysis = typeof plan.analysis === "string" ? plan.analysis : "";
    this._lastSummary = analysis.slice(0, 200) || null;
    this._journal("plan", `${analysis} | actions: ${valid.map((a) => a.type).join(", ") || "none"} | next: ${plan.next_check_minutes ?? "-"}m${this.dryRun ? " (dry-run)" : ""}`);
    this._journal("result", results.map((r) => `${r.type}:${r.ok ? "ok" : `FAIL ${r.error ?? ""}`}`).join(" ") || "no actions");
    if (typeof plan.note === "string" && plan.note) this._journal("note", plan.note.slice(0, 500));

    let nextMin = this._clampMinutes(plan.next_check_minutes);
    for (const r of results) {
      // set_checkin is applied here, not by the executor (SPEC §actions).
      if (r?.type === "set_checkin" && r.ok) {
        const m = Number(r.result?.minutes ?? r.result);
        if (Number.isFinite(m)) nextMin = this._clampMinutes(m);
      }
    }
    this._consecutiveErrors = 0;
    this._schedule(nextMin);
    return { plan, results };
  }

  /** Shared failure path: journal, count toward the CONSECUTIVE-error disable
   * (any check-in failure counts — LLM, observe, internal — so a persistently
   * broken loop still self-disables), else retry at intervalMinutes. */
  _fail(where, e) {
    this._consecutiveErrors++;
    const msg = `${where}: ${String((e && e.message) || e)}`;
    this._journal("error", msg);
    this._log(`[ai] director ${msg}`);
    if (this._consecutiveErrors >= this.maxErrorsBeforeDisable) {
      this.stop();
      this._journal("error", `disabled after ${this._consecutiveErrors} consecutive errors`);
    } else {
      this._schedule(this.intervalMinutes);
    }
    return { plan: null, results: [], error: msg };
  }

  // setTimeout chain, NOT setInterval (SPEC: tab throttling clamps background
  // timers to >=1/min, fine at minute cadence). No-op while disabled so a
  // manual checkNow can't resurrect a stopped loop.
  _schedule(minutes) {
    if (!this.enabled) return;
    if (this._timer != null) clearTimeout(this._timer);
    const ms = Math.max(0, Number(minutes) * MIN_MS || 0);
    this._nextCheckAt = Date.now() + ms;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.checkNow(); // never rejects
    }, ms);
    if (typeof this._timer?.unref === "function") this._timer.unref(); // don't pin a node process
  }

  // Clamp is for LLM-supplied next_check_minutes ONLY; the configured
  // intervalMinutes fallback passes through unclamped (fractional ok).
  _clampMinutes(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return this.intervalMinutes;
    return Math.min(this.maxIntervalMinutes, Math.max(this.minIntervalMinutes, n));
  }

  _journal(kind, text) {
    try { this.journal?.add(kind, text); } catch { /* journal loss must not stop the loop */ }
  }

  _spend() {
    try { return this.client?.spend ?? null; } catch { return null; }
  }
}
