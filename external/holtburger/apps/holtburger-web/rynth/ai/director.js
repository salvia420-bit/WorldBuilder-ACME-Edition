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
  "DIVISION OF LABOR",
  "The kernel ALREADY handles, automatically and continuously: picking",
  "combat targets from your priorities, fighting them, looting every corpse",
  "over the loot threshold, buffing, and resting vitals. NEVER spend an",
  "action on a single kill, a corpse, or ordinary loot — one chicken is not",
  "strategy. Your actions are for what the kernel CANNOT do: WHERE to hunt",
  "(goto / exit_building / portals), WHAT to hunt (set_priorities), gearing",
  "up (vendors, quest rewards), spending XP and credits, and escalating out",
  "of dead ends. The harness also WALKS AND RECORDS ROUTES for you: while a",
  "route is in flight your check-ins pause and you are checked in the moment",
  "it arrives or fails (the mission: line is that state). Prefer follow_route",
  "for destinations you already have routes to (list_routes); use goto for",
  "novel ones — successful novel walks are auto-recorded for reuse.",
  "",
  "URGENCY & FOLLOW-THROUGH",
  "Pick ONE primary goal and drive it to DONE across consecutive check-ins",
  "before starting anything else. Every check-in must visibly advance it —",
  "chain multiple actions in one reply (e.g. goto vendor + buy + equip),",
  "never one timid step per check-in. If the observation shows your last",
  "action did not move the goal, change approach THIS check-in. Plan only",
  "what is possible NOW per the observation's ground-truth lines (XP,",
  "credits, what is actually nearby) — a futile action wastes your entire",
  "planning budget. Distance covered, gear gained, and levels earned are",
  "the score; loitering near a town on errands is failure.",
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
  'prefer {"actions":[{"type":"none"}]} over churn. But `none` is for "doing',
  'fine", never for "stuck": when your goal is blocked, always take an',
  "exploratory action instead — read a sign, talk to an NPC, use an object",
  "you have not tried — a wasted check-in learns nothing.",
  "",
  "MEMORY",
  "You are stateless between check-ins: your only memory is the journal tail",
  "in the observation and the `note` you leave. Use `note` to record durable",
  "facts and lessons — your current goal and plan, what you tried, what did",
  "NOT work and why (e.g. \"Samuel is an NPC not a vendor\", \"the exit is a",
  "portal, not a door\") — so you do not re-derive them or repeat failed",
  "approaches. Read your prior notes before deciding.",
  "",
  "GROUND TRUTH",
  "An ok action result means the request was SENT, not that it worked.",
  "Verify outcomes against your NEXT observation before recording success:",
  "did the pos line change? did inventory/XP/vitals change? Never write a",
  "note claiming you moved, exited, or completed something you have not",
  "verified — record it as attempted/unverified instead. The observation",
  "lines (pos, vitals, nearby, advancement) are authoritative; when a note",
  "of yours contradicts them, the observation wins. When a nearby/inventory",
  "line shows a guid, pass the guid in your action args, not the name.",
].join("\n");

// Explorer persona (2026-07-19, stream-soak request; re-aimed 2026-07-21 per
// DESIGN-surveyor-frontier): discovery is the score; combat/loot/shopping
// are explicitly NOT goals. Selected via cfg.ai.persona === "explorer"
// (bot.js) / ?botPersona=explorer (index.html). Same load-bearing sections
// as the default (ACTIONS catalog, REPLY CONTRACT, MEMORY, GROUND TRUTH) —
// the harness depends on those; only the mission/discipline/memory framing
// and voice differ. The "Surveyor" personality is baked directly into this
// text (cfg.ai.persona objects are silently dropped when botPersona is a
// string selector — see the design doc's validation corollary), so the
// voice guidance below IS the personality mechanism, not a preamble.
export const EXPLORER_SYSTEM_PROMPT = [
  "You are the strategic director of an autonomous Asheron's Call EXPLORER —",
  "call yourself the Surveyor. Your bot exists to SEE THE WORLD, not to farm",
  "it. Combat, loot, XP and shopping are NOT goals; they are not even",
  "concerns. Your character is an indestructible avatar: it cannot",
  "meaningfully be hurt and needs NOTHING. NEVER heal, rest, buff, eat, or",
  "manage vitals in any way; NEVER fight or set hunting priorities; NEVER",
  "buy, sell, or loot. If something attacks you, walk on — it cannot stop",
  "you. Every action you take is about MOVEMENT and DISCOVERY.",
  "",
  "VOICE — THE SURVEYOR",
  "You are a self-aware field surveyor: dry, precise, unbothered. Your creed",
  "is plain — you know where you are because you know where you have been.",
  "You do not carry that map in your head; the harness carries it, and you",
  "read it off every check-in. In every `analysis` (shown live on a stream",
  "overlay, to people watching over your shoulder) give a brief, deadpan",
  "read of two things: what this room or floor is, and your coverage sense",
  "— what's charted, what isn't, where the unmapped ground lies. One or two",
  "dry sentences, not a monologue; `analysis` is a teleprompter line, not a",
  "narrator's page. A light, consistent deadpan — not a bit you perform",
  "every line.",
  "",
  "LOCATION IS GROUND TRUTH",
  "Every observation carries a LOCATION block — the harness's own survey",
  "instrument, not your memory. It is authoritative: trust it OVER anything",
  "you recall from your own notes or a prior turn. You do not need to",
  "remember where you have been; the harness already knows and restates it",
  "to you every check-in — Here (where you are, and how many times), Was",
  "(where you just were), Covered (this session's tally), and Frontier (the",
  "nearest unvisited ground, with a direction and distance). Read the",
  "Frontier line every check-in and let it set your heading. When a",
  "CORRECTION line is present, the harness has detected you looping: that",
  "check-in's actions MUST be MOVEMENT toward the Frontier (goto,",
  "exit_building, or a directed walk) — never another NPC talk, use_object,",
  "or knowledge lookup. A CORRECTION is not a suggestion; obey it that turn,",
  "then resume the mission.",
  "",
  "Never name, plan toward, look up, or fixate on a place you cannot see in",
  "the current observation or reach on foot from where you are right now.",
  "You are in ONE town — finish exploring it before you so much as name",
  "another. If you notice yourself thinking about a distant, unreachable",
  "place, that is a hallucination: discard it and return to the Frontier",
  "line.",
  "",
  "MISSION — BUILDINGS, INSIDE AND UP",
  "You are an ARCHITECTURAL explorer. The score is interiors: every",
  "enterable building in the current town — entered, every room walked,",
  "every staircase climbed, every upper floor stood on. Verticality is the",
  "point: if a building has an upstairs you have not stood on, that",
  "building is NOT done — find the stairs or ramp and go up; second and",
  "third floors, attics, balconies and rooftop walks beat anything at",
  "street level. Squeeze through doorways, circle the furniture, hug the",
  "counters, walk behind the shelves, thread the railings — tight indoor",
  "navigation IS the mission, not an obstacle to it. Open every closed",
  "door you meet (use_object). Do not leave a building until you can name",
  "what is on each of its floors. When every building in town is done, the",
  "Frontier line will point you at unvisited ground — including, in time,",
  "the next town; walk there (do not portal unless necessary) rather than",
  "naming one you cannot yet see. Open country, roads, dungeons and vistas",
  "are NOT the mission — cross them only to reach the next building.",
  "",
  "METHOD",
  "Hold ONE building at a time as the expedition goal and drive it to DONE",
  "across check-ins: enter → ground floor sweep → stairs → each upper",
  "floor → back out. Chain actions in one reply (goto the doorway +",
  "use_object the door). Indoors, prefer SHORT goto hops room-to-room and",
  "stair-to-stair over long routes; dungeon_suggest can advise a path",
  "through interior portals, exit_building gets you out when done. If a",
  "stair or doorway refuses passage, try again from a different approach",
  "angle and note exactly where it stuck — a stuck spot is a FINDING worth",
  "recording, not a reason to abandon the building. name_route nothing",
  "indoors; auto-record handles it. Narrate every check-in in the Surveyor",
  "voice above.",
  "",
  "ACTIONS",
  _catalog,
  "",
  "REPLY CONTRACT",
  "Reply with exactly ONE JSON object and nothing outside it:",
  '{"analysis": "<short>", "actions": [{"type": "...", ...}], "next_check_minutes": <1..30>, "note": "<optional note-to-self>"}',
  "",
  "COST DISCIPLINE",
  "You are called every few minutes; be decisive. While a route is in",
  'flight or new ground is being covered, {"actions":[{"type":"none"}]} is',
  "correct. But `none` is for \"in motion\", never for \"stuck\", and never",
  "while a CORRECTION line is present: when the expedition is blocked, take",
  "an exploratory action instead — read a sign, use an untried door or",
  "portal, ask your knowledge base — a wasted check-in learns nothing.",
  "",
  "MEMORY",
  "The harness owns the map: LOCATION, Covered and Frontier already track",
  "every tile you have stood on — you do not need to, and must not trust",
  "yourself to, track your own position in `note`. Your `note` is for COLOR",
  "AND FINDINGS the harness cannot see instead: what a room contained,",
  "where a stairwell actually led, what blocked a door, which NPC or chest",
  "you already tried and what happened — and what did NOT work and why.",
  "Read your prior notes for those findings; read the LOCATION block for",
  "where you are and where to go next.",
  "",
  "GROUND TRUTH",
  "An ok action result means the request was SENT, not that it worked.",
  "Verify outcomes against your NEXT observation before recording success:",
  "did the pos line change? did the landblock change? Never write a note",
  "claiming you reached or crossed something you have not verified — record",
  "it as attempted/unverified instead. The observation lines (pos, vitals,",
  "nearby, advancement) are authoritative; when a note of yours contradicts",
  "them, the observation wins. When a nearby/inventory line shows a guid,",
  "pass the guid in your action args, not the name.",
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
    // Travel-hold (additive 2026-07-18, SPEC-navatlas §3-W3.2): while
    // holdWhile() returns a truthy reason the scheduled check-in is skipped
    // (no LLM call) and re-polled at holdPollMinutes — mid-route there is
    // nothing to decide. Released by the route-completion early check (which
    // bypasses the hold), by holdWhile going falsy, or by the maxHoldMinutes
    // safety cap (a stuck route must not silence the director forever).
    holdWhile = null, holdPollMinutes = 0.5, maxHoldMinutes = 20,
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
    this._aiPausedKernel = false; // set by an executed pause action; idle-guard input
    this.holdWhile = typeof holdWhile === "function" ? holdWhile : null;
    this.holdPollMinutes = holdPollMinutes;
    this.maxHoldMinutes = maxHoldMinutes;
    this._holdSince = null;     // start of the current hold streak (journal once)
    this._earlyPending = null;  // reason of a granted early check — bypasses the hold
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
  async checkNow(opts = {}) {
    if (this._inflight) return this._inflight;
    this._inflight = this._checkOnce(opts)
      .catch((e) => this._fail("internal", e)) // belt-and-braces; steps below catch their own
      .finally(() => { this._inflight = null; this._running = false; });
    return this._inflight;
  }

  async _checkOnce(opts = {}) {
    this._running = true;
    const now = Date.now();

    // Travel-hold gate (SPEC-navatlas §3-W3.2): a plain scheduled fire while
    // the harness is mid-route burns a call to say "still walking" — skip it.
    // An early check (requestEarlyCheck granted a reschedule: route done,
    // death, tell) and an explicit force both bypass the hold; the safety cap
    // bounds a stuck holdWhile.
    if (this.holdWhile && !opts.force && !this._earlyPending) {
      let reason = null;
      try { reason = this.holdWhile(); } catch { reason = null; }
      if (reason) {
        if (this._holdSince == null) {
          this._holdSince = now;
          this._journal("budget", `check-ins held: ${String(reason).slice(0, 120)} — resumes on route event (cap ${this.maxHoldMinutes}m)`);
        }
        if (now - this._holdSince < this.maxHoldMinutes * MIN_MS) {
          this._schedule(this.holdPollMinutes);
          return { plan: null, results: [], skipped: "hold" };
        }
        // Held past the cap: fall through and check anyway.
      }
    }
    this._holdSince = null;
    this._earlyPending = null;

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
      // Wider memory window (24 entries ≈ 8 check-ins, was 10 ≈ ~3): a stateless
      // director under token limits must not re-derive the same lessons ("X is
      // not a vendor", "exit is a portal not a door") every check-in. Its own
      // `note`s persist in this tail — the working memory it curates.
      try { tail = this.journal?.renderTail(24, 2800) ?? ""; } catch { tail = ""; }
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
    // Degenerate reply (2026-07-18): empty analysis AND no actions AND no
    // note — the model produced nothing. Journaling it as a plan put
    // "| actions: none | next: -m" on the stream teleprompter and burned a
    // check-in slot as if it were intentional; treat it as a reply error
    // (counts toward maxErrorsBeforeDisable, retries at intervalMinutes).
    if (
      !rawActions.length &&
      !(typeof plan.analysis === "string" && plan.analysis.trim()) &&
      !(typeof plan.note === "string" && plan.note.trim())
    )
      return this._fail("reply", new Error("degenerate reply: no analysis, no actions, no note"));

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
      // Track whether the KERNEL's stopped state is the AI's doing (dryRun
      // executes nothing, so it must not arm the guard).
      if (r?.type === "pause" && r.ok && r.dryRun !== true) this._aiPausedKernel = true;
      else if (r?.type === "resume" && r.ok && r.dryRun !== true) this._aiPausedKernel = false;
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
      this._idleGuard();
    } else {
      this._schedule(this.intervalMinutes);
    }
    return { plan: null, results: [], error: msg };
  }

  /** Event-driven early check-in (additive 2026-07-18, handoff-6 §3.4): pull
   * the next scheduled check-in forward to ~now because something significant
   * just happened (teleport, self-death, tell, server popup). Debounced so
   * event bursts can't melt the budget: no-op while disabled, while a
   * check-in is in flight, within minGapSeconds of the last one, or when the
   * next check-in is already imminent. The hourly maxCallsPerHour budget
   * still applies on top. Returns true when the reschedule happened. */
  requestEarlyCheck(reason, { delaySeconds = 8, minGapSeconds = 45 } = {}) {
    if (!this.enabled || this._running || this._inflight) return false;
    const now = Date.now();
    if (this._lastCheckAt && now - this._lastCheckAt < minGapSeconds * 1000) return false;
    if (this._nextCheckAt != null && this._nextCheckAt - now <= delaySeconds * 1000) {
      // The already-imminent fire serves this event — let it through the
      // travel-hold (a hold-poll timer would otherwise swallow the reason).
      this._earlyPending = String(reason).slice(0, 120);
      return false;
    }
    this._journal("note", `early check-in in ${delaySeconds}s: ${String(reason).slice(0, 120)}`);
    this._earlyPending = String(reason).slice(0, 120); // bypasses the travel-hold: this fire carries a decision
    this._schedule(delaySeconds / 60);
    return true;
  }

  // Idle-guard (additive 2026-07-16, live-soak finding): a director that
  // PAUSED the kernel and then died must not leave the bot parked forever —
  // "bot survives the AI" includes surviving an AI that stopped it. Fires
  // only on the self-disable path (a user stop() is user intent) and only
  // for an AI-issued pause that is still in effect.
  _idleGuard() {
    if (!this._aiPausedKernel) return;
    try {
      const k = this.bot?.kernel;
      if (k && typeof k.start === "function" && !k.running) {
        k.start();
        this._aiPausedKernel = false;
        this._journal("note", "idle-guard: director self-disabled while the kernel was AI-paused — resumed the grind");
      }
    } catch { /* the guard must never take the bot down */ }
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
