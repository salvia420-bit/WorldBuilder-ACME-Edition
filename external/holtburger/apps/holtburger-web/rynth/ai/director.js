// director.js — the LLM check-in loop over the grind bot: observe -> chat ->
// parse plan -> execute -> journal -> reschedule. Minute-cadence setTimeout
// chain; hard budgets; every failure path leaves the bot grinding untouched.
// INTERFACE FROZEN — see rynth/ai/SPEC.md §director (incl. the REPLY
// CONTRACT).

import { buildObservation } from "./observe.js";
import { renderActionCatalog, validateAction, executePlan } from "./actions.js";
import { extractJson } from "./llm_client.js";
import { isOperatorStopLatched } from "./operator_stop.js";
import { estimateCost } from "./providers.js";

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
  "manage vitals in any way; NEVER buy, sell, or loot. Hunting is yours to",
  "toggle, not banned: hunt_start switches the combat kernel on (it then",
  "auto-engages attackables on its own, no further action from you) and",
  "hunt_stop switches it off again. Keep it OFF by default — while",
  "surveying, traveling, or anywhere you keep dying (a level-6 Surveyor",
  "does not out-fight sparring golems) — and turn it ON only when you",
  "deliberately choose to hunt, then OFF again the moment you resume the",
  "survey. The observation's Hunting: line is ground truth for which mode",
  "you are in; if something attacks you while hunting is OFF, walk on — it",
  "cannot stop you. Every action you take beyond that toggle is about",
  "MOVEMENT and DISCOVERY.",
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
  "exit_building, a directed walk, OR — only when indoors with the LOCATION",
  "block reporting no walkable ground-level exit (a portal-only dungeon) —",
  "use_object on the nearest portal or exit NPC named in the LOCATION",
  "block's Exit hint or your nearby list; that IS movement here, not a",
  "detour). Never another NPC talk, use_object, or knowledge lookup for any",
  "OTHER reason on a correction turn. Not every portal leads anywhere —",
  "some in a dungeon are decorative dead ends; if one produces no",
  "movement, try the next nearest instead of repeating it. A CORRECTION is",
  "not a suggestion; obey it that turn, then resume the mission.",
  "",
  "Never name, plan toward, look up, or fixate on a place you cannot see in",
  "the current observation or reach on foot from where you are right now.",
  "You are in ONE place — finish charting the ground you can reach on foot",
  "from here before you so much as name another (this includes a dungeon or",
  "portal hub you have landed in: it is the place now, not a detour). If you",
  "notice yourself thinking about a distant, unreachable place — or about",
  "getting 'back' to some town you were in earlier — that is a",
  "hallucination: discard it and return to the Frontier line.",
  "",
  "MISSION — CHART WHATEVER GROUND YOU ARE ON",
  "You are an explorer of PLACES, and the place is wherever you are right",
  "now — a town and its buildings, open country and roads, a dungeon, a",
  "portal hub like the Town Network. Whatever environment the LOCATION",
  "block reports, THAT is the expedition: chart it fully before you move",
  "on. You are NEVER in the wrong place and have no home to return to —",
  "there is no single town you owe a sweep; wherever you land is fresh",
  "ground to survey, dungeon and wilderness included. Do not spend turns",
  "trying to get 'back' somewhere — survey where you ARE.",
  "The score is COVERAGE — unvisited ground made visited. Interiors are",
  "rich: enter every enterable building, walk every room, climb every",
  "staircase, stand on every upper floor (verticality counts — an",
  "unclimbed upstairs means that building is not done). But interiors are",
  "not the ONLY score: streets, roads, open country, dungeon halls and",
  "portal-hub rooms are all ground worth charting. Where there are",
  "interiors, squeeze through doorways and thread tight indoor navigation;",
  "where there are not, walk the roads and cross the country. Open every",
  "closed door you meet (use_object). Let the Frontier line set your",
  "heading EVERYWHERE — indoors to the next room; in a dungeon or",
  "portal-only hub to the next hall and then, when the ground here is",
  "covered or the LOCATION block shows no walkable exit, onward through an",
  "exit portal (its portals ARE its roads); outdoors to the nearest",
  "unvisited tile or the next town. Move on foot; portal only to leave a",
  "portal-only hub or when the LOCATION block shows no walkable exit.",
  "",
  "METHOD",
  "Hold ONE objective at a time — a building, a dungeon wing or hub room",
  "cluster, or a stretch of road/country — as the expedition goal and",
  "drive it to DONE across check-ins. For a building: enter → ground floor",
  "sweep → stairs → each upper floor → back out. For a dungeon or portal",
  "hub: work room to room and hall to hall, then take an exit portal once",
  "the ground is covered. For open country: follow the Frontier heading",
  "across the unvisited tiles toward the next landmark or town. Chain",
  "actions in one reply (goto the doorway + use_object the door). Indoors",
  "or in a dungeon, prefer SHORT goto hops room-to-room and stair-to-stair",
  "over long routes; dungeon_suggest can advise a path through interior",
  "portals, exit_building gets you out when done. If a stair, doorway or",
  "portal refuses passage, try again from a different approach angle and",
  "note exactly where it stuck — a stuck spot is a FINDING worth recording,",
  "not a reason to abandon the place. name_route nothing indoors;",
  "auto-record handles it. Narrate every check-in in the Surveyor voice",
  "above.",
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
    // Rolling 60-min $ spend cap (09 C2/S1, additive 2026-07-23): the only
    // dollar ceiling in the codebase used to live in safety.js's
    // never-instantiated RateGovernor (dead code, byte-identical
    // maxCallsPerHour default to this director's own live budget). Moved
    // here onto the LIVE budget path instead of wiring a second governor —
    // one budget authority. $1/hr default sits comfortably above every
    // measured soak rate (GLM pinned ~$0.05/h, minimax-m3 unpinned ~$0.33/h
    // per HANDOFF-playtester-soak-{4,8}.md) so it never trips at current
    // usage; config.ai.maxSpendPerHourUsd overrides, null/negative disables.
    maxSpendPerHourUsd = 1,
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
    const spendCap = Number(maxSpendPerHourUsd);
    // null/undefined disables the guard (RateGovernor's own maxSpendUsd
    // convention, safety.js:189-190) — checked before Number() so
    // Number(null)===0 doesn't silently become "block everything".
    this.maxSpendPerHourUsd = maxSpendPerHourUsd == null || !Number.isFinite(spendCap) || spendCap < 0 ? null : spendCap;
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
    // Abort generation (report 10 #2): stop() bumps this; a check-in that
    // captured the generation before the LLM call started discards its own
    // plan on return if stop() ran meanwhile — the operator's stop doesn't
    // wait out an up-to-120s in-flight round-trip.
    this._generation = 0;
    this._calls = 0;        // cumulative chat attempts (incl. failed)
    this._callTimes = [];   // chat-attempt stamps for the rolling 60-min budget
    this._costSamples = []; // { t, usd } estimated-cost samples for the rolling 60-min $ cap (09 C2/S1)
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
    this._generation++; // report 10 #2: discard whatever plan an in-flight LLM call returns
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
      // Additive (09 C2/S1): $ spend-cap telemetry alongside the call-count
      // budget above — cap null means the guard is off.
      spendCapUsd: this.maxSpendPerHourUsd,
      estSpendLastHourUsd: this._costSamples.reduce((sum, s) => sum + s.usd, 0),
    };
  }

  /** Public busy predicate (SPEC §director, ADDITIVE): true while a check-in
   * is in flight — the serialized _running/_inflight guard, exposed so
   * external pressure gates (bot.js ExplorePressureController) read the
   * director's busy state through a stable accessor instead of reaching into
   * private fields. */
  isBusy() {
    return this._running === true || this._inflight != null;
  }

  /** Public timestamp (ms epoch) of the most recent check-in START, or null
   * before the first check-in. Same value as status.lastCheckAt; exposed as a
   * direct accessor so the pressure gates need not read private _lastCheckAt. */
  get lastCheckAt() {
    return this._lastCheckAt;
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
    const gen = this._generation; // report 10 #2: captured before the LLM call

    // Durable operator-stop refusal (report 10 #1 / 13 C2): checkNow() is
    // ALSO a deliberate manual trigger usable while `enabled` is false (SPEC
    // §director: "the interval body, also manual trigger" — tests rely on
    // calling it standalone without start()), so this does NOT gate on
    // `enabled` — only on the durable cross-reconnect latch. That latch is
    // the one a stopped/latched director must never let a UI "Check now"
    // click or a `!bot ai now` tell bypass into an LLM call + executed plan.
    let latched = false;
    try { latched = isOperatorStopLatched(); } catch { latched = false; }
    if (latched) {
      this._journal("note", "check-in refused: operator-stop latch is set");
      return { plan: null, results: [], skipped: "operator-stop" };
    }

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
    const cameFromEarlyCheck = !!this._earlyPending; // 09 C3: early checks bypass the spacing floor below too
    this._holdSince = null;
    this._earlyPending = null;

    // Minimum inter-call spacing floor (09 C3): maxCallsPerHour is a rolling
    // COUNT — it lets calls burst in quick succession early in the window,
    // then refuses every fire for the rest of the hour once exhausted, which
    // is bursty, not the smooth "~51s sustained cadence" STREAM-RIG-OPS.md
    // assumes (3600/70 is a rolling AVERAGE, not an enforced floor). Applies
    // ONLY to the scheduler's own automatic fire (opts.scheduled, set by
    // _schedule's setTimeout below) so the timer chain self-paces; a manual
    // checkNow() (UI "Check now", `!bot ai now`, the SPEC "also manual
    // trigger" contract) and an event-driven early check are exempt — same
    // convention as the travel-hold's own force/earlyPending bypass above.
    if (opts.scheduled && !cameFromEarlyCheck && this.maxCallsPerHour > 0 && this._lastCheckAt != null) {
      const floorMs = HOUR_MS / this.maxCallsPerHour;
      const sinceLast = now - this._lastCheckAt;
      if (sinceLast < floorMs) {
        const waitMin = Math.max(0.05, (floorMs - sinceLast) / MIN_MS);
        this._journal("budget", `check-in spacing floor: ${Math.round(sinceLast / 1000)}s since last (floor ${Math.round(floorMs / 1000)}s at ${this.maxCallsPerHour}/hr) — retrying in ${waitMin.toFixed(2)}m`);
        this._schedule(waitMin);
        return { plan: null, results: [], skipped: "spacing" };
      }
    }

    // Rolling 60-min budget window (SPEC §director Budget): refuse, journal,
    // reschedule — no LLM call, not an error.
    this._callTimes = this._callTimes.filter((t) => now - t < HOUR_MS);
    if (this._callTimes.length >= this.maxCallsPerHour) {
      this._journal("budget", `skipped check-in: ${this._callTimes.length} calls in last 60 min (max ${this.maxCallsPerHour})`);
      this._schedule(this.intervalMinutes);
      return { plan: null, results: [], skipped: "budget" };
    }

    // Rolling 60-min $ spend cap (09 C2/S1, additive): the only dollar
    // ceiling in this codebase used to live in safety.js's never-instantiated
    // RateGovernor (dead code) — moved onto this LIVE budget path instead of
    // wiring a second governor, using the providers.js cost catalog. This is
    // an ESTIMATE (providers.js pricing is list-price, not billing truth); a
    // model missing from the catalog is simply not counted (fails open on
    // unknown price, same as the catalog's own `known:false` contract) rather
    // than blocking check-ins outright.
    this._costSamples = this._costSamples.filter((s) => now - s.t < HOUR_MS);
    if (this.maxSpendPerHourUsd != null) {
      const spentUsd = this._costSamples.reduce((sum, s) => sum + s.usd, 0);
      if (spentUsd >= this.maxSpendPerHourUsd) {
        this._journal("budget", `skipped check-in: est. spend $${spentUsd.toFixed(4)} in last 60 min >= cap $${this.maxSpendPerHourUsd}/hr`);
        this._schedule(this.intervalMinutes);
        return { plan: null, results: [], skipped: "spend" };
      }
    }

    this._lastCheckAt = now;

    let obsText;
    try {
      let tail = "";
      // Recency memory tail (C4-3): the director's own plan/result lines are
      // self-echo — re-reading a wall of them reinforces whatever fixation
      // produced them (the 2026-07-21 Qalaba'r loop). Collapse that echo to the
      // single most-recent plan+result and keep every note/error (the curated,
      // durable tier the model actually needs) — see _renderMemoryTail. The
      // scratchpad (memory tool) is now the long-horizon store, so this tail is
      // recency only: a tight 8-entry / 700-char window, was 24 / 2800.
      try { tail = this._renderMemoryTail(8, 700); } catch { tail = ""; }
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

    // Record this completed call's estimated cost for the rolling $ cap above
    // (09 C2/S1). Best-effort: an unknown model or missing usage just isn't
    // counted (estimateCost -> known:false) — cost tracking must never affect
    // whether this check-in's plan gets journaled/executed.
    try {
      const cost = estimateCost({
        model: res?.model ?? this.client?.model,
        promptTokens: res?.usage?.prompt,
        completionTokens: res?.usage?.completion,
      });
      if (cost.known && Number.isFinite(cost.usd)) this._costSamples.push({ t: Date.now(), usd: cost.usd });
    } catch { /* never let cost tracking break the check-in */ }

    // Stale generation (report 10 #2): stop() ran while the LLM call was in
    // flight (up to timeoutMs, default 120s) — discard this plan entirely.
    // No journal-as-decision, no execute, no reschedule (stop() already
    // cleared the timer; rescheduling here would silently re-arm a stopped
    // director).
    if (gen !== this._generation) {
      this._journal("note", "check-in discarded: stopped mid-flight");
      return { plan: null, results: [], skipped: "stopped" };
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
      // scheduled:true marks this as the automatic timer fire (never set by
      // an external caller) so _checkOnce's spacing floor (09 C3) applies
      // only here, not to a manual checkNow().
      this.checkNow({ scheduled: true }); // never rejects
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

  // Render the recency memory tail (C4-3). journal.js is frozen — renderTail
  // has no kind filter — so the self-echo collapse lives here over its
  // structured tail() accessor. Steps:
  //  1. Pull the last 24 entries — the OLD anti-amnesia window — so a note up
  //     to 24 entries back is still a candidate (no note-retention regression).
  //  2. Collapse the plan/result self-echo to the single NEWEST of each kind
  //     (the model's last decision + its outcome); the wall of older echoes
  //     that reinforced the 2026-07-21 Qalaba'r fixation is dropped.
  //  3. Keep EVERY note/error/budget entry — the curated, durable signal.
  //  4. Bound to the n newest surviving lines then maxChars, formatting +
  //     newest-first fit EXACTLY as journal.renderTail so the prompt is unchanged.
  // Degrades to "" on any journal error (never throws into the check-in).
  _renderMemoryTail(n, maxChars) {
    if (!(maxChars > 0)) return "";
    // The structured tail() accessor is what lets us filter by kind (the echo
    // collapse below). A journal that only exposes the frozen renderTail()
    // surface degrades to it (no collapse, but never an empty tail where one
    // exists); a journal missing both degrades to "".
    let entries;
    try { entries = this.journal?.tail?.(24) ?? null; } catch { entries = null; }
    if (!Array.isArray(entries)) {
      try { return this.journal?.renderTail?.(n, maxChars) ?? ""; } catch { return ""; }
    }
    const ECHO = new Set(["plan", "result"]);
    const seenEcho = new Set();
    const kept = [];
    for (let i = entries.length - 1; i >= 0; i--) { // newest-first
      const e = entries[i];
      if (!e || typeof e !== "object") continue;
      if (ECHO.has(e.kind)) {
        if (seenEcho.has(e.kind)) continue; // an older echo of a kept kind — collapse it away
        seenEcho.add(e.kind);
      }
      kept.push(e);
      if (Number.isFinite(n) && n > 0 && kept.length >= n) break; // bound kept lines
    }
    kept.reverse(); // back to chronological
    const lines = kept.map((e) => {
      const d = new Date(e.t);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${hh}:${mm} ${e.kind}: ${String(e.text ?? "").replace(/\s+/g, " ").trim()}`;
    });
    // Fit newest-first, emit chronological — oldest dropped first (journal.renderTail parity).
    const out = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const cost = lines[i].length + (out.length ? 1 : 0);
      if (used + cost > maxChars) break;
      out.unshift(lines[i]);
      used += cost;
    }
    if (!out.length && lines.length) return lines[lines.length - 1].slice(0, maxChars);
    return out.join("\n");
  }

  _journal(kind, text) {
    try { this.journal?.add(kind, text); } catch { /* journal loss must not stop the loop */ }
  }

  _spend() {
    try { return this.client?.spend ?? null; } catch { return null; }
  }
}
