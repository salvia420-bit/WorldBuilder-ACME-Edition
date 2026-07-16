// eval/scenarios.js — offline eval harness for the AI director: scripted
// scenarios that run the REAL RynthAiDirector against canned LLM replies and
// a mock bot, proving the observe -> chat -> extractJson -> validate ->
// execute -> journal -> reschedule plumbing is sound for realistic plans.
// This tests the HARNESS AND PLUMBING, not a live model — replies are fixed
// strings (some fenced/noisy, to exercise the real extractJson path in
// director.js:155-158).
//
// Deliberately imports NOTHING: RynthAiDirector (and optionally observe/
// execute/validate) are dep-injected into runScenarios(), so this module
// stays decoupled from v1 files and importable anywhere.

/** Throw-on-false assertion for scenario expect() bodies. */
export function ensure(ok, msg) {
  if (!ok) throw new Error(msg);
}

// nextCheckAt is a real wall-clock stamp set by director._schedule; expects
// run within ms of the last check-in, so a 5s tolerance is generous.
const near = (at, minutes) =>
  typeof at === "number" && Math.abs(at - Date.now() - minutes * 60_000) < 5_000;

/**
 * Mock bot exposing exactly the surfaces observe.js reads (host pose/names/
 * health, kernel.status, vitals._fractions percent 0..100, buff.status,
 * combat.locked/_scanTargets/priorities, loot.minValue, router.status,
 * globalRouter.busy) and actions.js drives (goto, router.cancel,
 * kernel.stop/start, host.WriteToChat, combat.priorities, loot.minValue).
 * Side effects are recorded on bot._calls for expectations.
 */
export function makeMockBot({
  hp = 92, stam = 84, mana = 77,
  lootMinValue = 500,
  priorities = { "Drudge Prowler": 10 },
  running = true,
  threats = [{ guid: 0x71, name: "Drudge Prowler", dist: 11.2, hp: 0.85 }],
} = {}) {
  const calls = { goto: [], say: [], pause: 0, resume: 0, stopGoto: 0 };
  const names = new Map(threats.map((t) => [t.guid, t.name]));
  const hps = new Map(threats.map((t) => [t.guid, t.hp]));
  return {
    _calls: calls,
    startedAt: Date.now() - 42 * 60_000,
    host: {
      TryGetPlayerPose: () => ({ objCellId: 0xa9b40015 >>> 0, x: 60.3, y: 92.1, z: 0.5 }),
      TryGetObjectName: (g) => names.get(g) ?? null,
      // -1 = unknown, 0..1 = known (webhost.js TryGetTargetHealthFraction contract)
      TryGetTargetHealthFraction: (g) => (hps.has(g) ? hps.get(g) : -1),
      TryGetObjectPosition: () => null,
      TryGetObjectWcid: () => 0,
      NearbyGuids: () => threats.map((t) => t.guid),
      WriteToChat: (text) => { calls.say.push(text); },
    },
    kernel: {
      running,
      status: { action: running ? "combat" : "idle", kills: 17, looted: 9 },
      stop() { calls.pause++; this.running = false; },
      start() { calls.resume++; this.running = true; },
    },
    vitals: { _fractions: () => ({ hp, stam, mana }) },
    buff: { status: { ready: true, active: 7, desired: 7, parked: [], pending: 0 } },
    combat: {
      locked: null,
      priorities: { ...priorities },
      _scanTargets: () => threats.map((t) => ({ guid: t.guid, dist: t.dist })),
    },
    loot: { minValue: lootMinValue },
    router: { status: { state: "IDLE", leg: 0, legs: 0, walked: 0 }, cancel() { calls.stopGoto++; } },
    globalRouter: { busy: false },
    async goto(to) { calls.goto.push(to); return { ok: true, state: "ARRIVED", legsWalked: 1, replans: 0 }; },
  };
}

/** Minimal in-memory journal with the surface the director uses (add,
 * renderTail) plus .entries for expectations — same {t,kind,text} shape as
 * AiJournal, so the real class can be substituted via journalFactory. */
export function makeMemoryJournal() {
  const entries = [];
  return {
    entries,
    add(kind, text) { entries.push({ t: Date.now(), kind, text: String(text ?? "") }); },
    tail(n = 10) { return entries.slice(-n).map((e) => ({ ...e })); },
    renderTail(n = 10, maxChars = 2000) {
      return entries.slice(-n).map((e) => `${e.kind}: ${e.text}`).join("\n").slice(0, maxChars);
    },
  };
}

/**
 * Scripted client matching the LlmClient.chat return contract (SPEC
 * §llm_client) — but with NO `json` field, so the director falls through to
 * the REAL extractJson on `text` (director.js:155-158); that is the point of
 * the noisy/fenced reply strings. Consumes replies in order (last repeats).
 */
export function makeScriptedClient(replies) {
  let i = 0;
  const calls = [];
  const spend = { calls: 0, promptTokens: 0, completionTokens: 0, errors: 0 };
  return {
    calls,
    spend,
    async chat(messages) {
      calls.push({ messages });
      const text = replies[Math.min(i, replies.length - 1)];
      i++;
      spend.calls++;
      return { text, usage: { prompt: 0, completion: 0 }, model: "scripted", ms: 0 };
    },
  };
}

// ── the scenario suite ──────────────────────────────────────────────────────
// Each: { name, bot: () => mockBot, llmReplies: [raw assistant strings],
// expect(dirStatus, journal, bot) } — expect THROWS on failure. runScenarios
// attaches the scripted client's call log as bot._chats before the first
// check-in, so expects can assert what the observation actually told the LLM.

export const SCENARIOS = [
  {
    name: "low-loot-value: fenced+prosy reply raises the loot floor",
    bot: () => makeMockBot({ lootMinValue: 50 }),
    llmReplies: [
      [
        "Looking at the observation: kills are steady but loot_min is only 50",
        "— we are hoovering vendor trash. Raising the floor.",
        "",
        "```json",
        "{",
        '  "analysis": "loot floor too low for this hunting ground",',
        '  "actions": [{"type": "set_loot_min_value", "value": 5000}],',
        '  "next_check_minutes": 10,',
        '  "note": "raised loot floor 50 -> 5000"',
        "}",
        "```",
        "",
        "That should keep the packs clear.",
      ].join("\n"),
    ],
    expect(status, journal, bot) {
      ensure(bot._chats[0].messages[1].content.includes("loot_min: 50"),
        "observation should surface the low loot floor to the LLM");
      ensure(bot.loot.minValue === 5000, `loot.minValue applied, got ${bot.loot.minValue}`);
      const plans = journal.entries.filter((e) => e.kind === "plan");
      ensure(plans.length === 1 && plans[0].text.includes("set_loot_min_value"), "plan journaled");
      const results = journal.entries.filter((e) => e.kind === "result");
      ensure(results.length === 1 && results[0].text.includes("set_loot_min_value:ok"), "result journaled ok");
      ensure(journal.entries.some((e) => e.kind === "note" && e.text.includes("5000")), "note-to-self journaled");
      ensure(near(status.nextCheckAt, 10), `next_check_minutes=10 applied, nextCheckAt=${status.nextCheckAt}`);
      ensure(status.consecutiveErrors === 0 && status.lastSummary.includes("loot floor"),
        "clean check-in with analysis as lastSummary");
    },
  },

  {
    name: "dangerous-vitals: low hp in observation -> scripted pause+say+note lands",
    bot: () => makeMockBot({
      hp: 15, stam: 40, mana: 60,
      threats: [
        { guid: 0x71, name: "Tusker Guard", dist: 4.1, hp: 0.9 },
        { guid: 0x72, name: "Tusker Guard", dist: 6.8, hp: 1.0 },
        { guid: 0x73, name: "Obsidian Golem", dist: 9.9, hp: null },
      ],
    }),
    llmReplies: [
      // bare object with prose in front — exercises extractJson's brace scan
      'The character is at 15% hp with three threats in melee range — disengage now. ' +
      '{"analysis": "hp critical, pausing the grind", ' +
      '"actions": [{"type": "pause"}, {"type": "say", "text": "low hp, holding position"}], ' +
      '"next_check_minutes": 1, ' +
      '"note": "paused at 15% hp - resume when vitals recover"}',
    ],
    expect(status, journal, bot) {
      ensure(bot._chats[0].messages[1].content.includes("vitals: hp=15%"),
        "observation must carry the dangerous vitals");
      ensure(bot._calls.pause === 1 && bot.kernel.running === false, "kernel paused");
      ensure(bot._calls.say.length === 1 && bot._calls.say[0] === "low hp, holding position", "say executed");
      ensure(journal.entries.some((e) => e.kind === "note" && e.text.includes("paused at 15% hp")),
        "note-to-self journaled");
      ensure(journal.entries.some((e) => e.kind === "result" && e.text.includes("pause:ok") && e.text.includes("say:ok")),
        "both actions ok in the result journal");
      ensure(near(status.nextCheckAt, 1), `next_check_minutes=1 applied, nextCheckAt=${status.nextCheckAt}`);
      ensure(status.consecutiveErrors === 0, "no errors");
    },
  },

  {
    name: "malformed-reply: error journaled, bot untouched, retry at interval",
    bot: () => makeMockBot({ lootMinValue: 500 }),
    llmReplies: [
      "I am sorry, I cannot produce a plan right now — the observation seems incomplete.",
    ],
    expect(status, journal, bot) {
      ensure(journal.entries.filter((e) => e.kind === "error").length === 1, "one error journaled");
      ensure(!journal.entries.some((e) => e.kind === "plan" || e.kind === "result"),
        "no plan/result journaled for a failed reply");
      ensure(status.consecutiveErrors === 1, `consecutiveErrors=1, got ${status.consecutiveErrors}`);
      ensure(status.enabled === true, "one bad reply must not disable the director");
      ensure(bot.loot.minValue === 500 && bot._calls.pause === 0 && bot._calls.resume === 0
        && bot._calls.goto.length === 0 && bot._calls.say.length === 0 && bot._calls.stopGoto === 0,
        "bot completely untouched");
      ensure(near(status.nextCheckAt, 5), `retry at intervalMinutes(5), nextCheckAt=${status.nextCheckAt}`);
    },
  },

  {
    name: "malformed-then-recover: truncated JSON errors, next good reply resets",
    bot: () => makeMockBot(),
    llmReplies: [
      'Here is the plan: {"analysis": "broken', // unbalanced brace -> extractJson null
      '{"analysis": "all good, no changes", "actions": [{"type": "none"}], "next_check_minutes": 8}',
    ],
    expect(status, journal, bot) {
      ensure(journal.entries.filter((e) => e.kind === "error").length === 1, "exactly one error journaled");
      ensure(status.consecutiveErrors === 0, "good reply resets consecutive errors");
      ensure(journal.entries.filter((e) => e.kind === "plan").length === 1, "recovered plan journaled");
      ensure(journal.entries.some((e) => e.kind === "result" && e.text.includes("none:ok")), "none executed ok");
      ensure(bot._calls.pause === 0 && bot._calls.goto.length === 0 && bot.loot.minValue === 500,
        "bot untouched throughout");
      ensure(near(status.nextCheckAt, 8), `next_check_minutes=8 applied, nextCheckAt=${status.nextCheckAt}`);
    },
  },

  {
    name: "mixed-validity: out-of-bounds goto and @-say rejected, valid action still runs",
    bot: () => makeMockBot({ lootMinValue: 500 }),
    llmReplies: [
      [
        '{"analysis": "reposition and tighten loot", "actions": [',
        '  {"type": "goto", "ns": 500, "ew": 12.3},',      // |deg| > 102 -> validate fails
        '  {"type": "say", "text": "@teleport casino"},',  // admin say -> refused
        '  {"type": "set_loot_min_value", "value": 2500}',
        '], "next_check_minutes": 5}',
      ].join("\n"),
    ],
    expect(status, journal, bot) {
      ensure(bot._calls.goto.length === 0, "out-of-bounds goto must not reach the bot");
      ensure(bot._calls.say.length === 0, "@-command must never reach chat");
      ensure(bot.loot.minValue === 2500, "valid action in a mixed plan still executes");
      const result = journal.entries.find((e) => e.kind === "result");
      ensure(!!result && result.text.includes("goto:FAIL") && result.text.includes("say:FAIL")
        && result.text.includes("set_loot_min_value:ok"),
        `per-action verdicts journaled, got: ${result && result.text}`);
      ensure(status.consecutiveErrors === 0, "partially-invalid plan is not a director error");
    },
  },

  {
    name: "travel+priorities: goto forwarded, priorities REPLACED not merged",
    bot: () => makeMockBot({ priorities: { "Drudge Prowler": 10 } }),
    llmReplies: [
      '{"analysis": "relocate to tusker beach and rewire priorities", "actions": [' +
      '{"type": "goto", "ns": 12.5, "ew": -41.2}, ' +
      '{"type": "set_priorities", "rules": {"Tusker Guard": 90, "Obsidian Golem": 5}}' +
      '], "next_check_minutes": 15}',
    ],
    expect(status, journal, bot) {
      ensure(bot._chats[0].messages[1].content.includes("Drudge Prowler:10"),
        "observation carried the pre-change priorities");
      ensure(bot._calls.goto.length === 1
        && bot._calls.goto[0].ns === 12.5 && bot._calls.goto[0].ew === -41.2,
        `goto forwarded verbatim, got ${JSON.stringify(bot._calls.goto)}`);
      const p = bot.combat.priorities;
      ensure(p["Tusker Guard"] === 90 && p["Obsidian Golem"] === 5 && !("Drudge Prowler" in p),
        `priorities replaced (SPEC: REPLACES all), got ${JSON.stringify(p)}`);
      ensure(journal.entries.some((e) => e.kind === "result" && e.text.includes("goto:ok")
        && e.text.includes("set_priorities:ok")), "both actions ok");
      ensure(near(status.nextCheckAt, 15), `next_check_minutes=15 applied, nextCheckAt=${status.nextCheckAt}`);
    },
  },

  {
    name: "set_checkin action overrides the plan's next_check_minutes",
    bot: () => makeMockBot(),
    llmReplies: [
      '{"analysis": "tighten cadence while the pull is hot", ' +
      '"actions": [{"type": "set_checkin", "minutes": 2}], "next_check_minutes": 25}',
    ],
    expect(status, journal, bot) {
      // The REAL executeAction returns {minutes} in its result and the
      // director applies it over next_check_minutes (SPEC §actions).
      ensure(near(status.nextCheckAt, 2),
        `set_checkin(2) wins over next_check_minutes(25), nextCheckAt=${status.nextCheckAt}`);
      ensure(journal.entries.some((e) => e.kind === "result" && e.text.includes("set_checkin:ok")),
        "set_checkin ok in results");
      ensure(status.consecutiveErrors === 0, "clean check-in");
    },
  },
];

/**
 * Run scenarios against the REAL director class. Deps:
 *   RynthAiDirector  (required) — the class from rynth/ai/director.js
 *   observe/execute/validate    — optional; omitted -> director.js's own
 *                                 defaults (the real observe.js/actions.js)
 *   journalFactory              — optional; must return {add, renderTail,
 *                                 entries}; default makeMemoryJournal
 *   scenarios, directorOptions, log — optional overrides
 * -> { passed, failed, results: [{name, ok, error, checkins}] }
 * Never throws per-scenario: a failing expect() or a throwing director is a
 * failed RESULT, so one broken scenario can't hide the rest.
 */
export async function runScenarios({
  RynthAiDirector,
  observe, execute, validate,
  journalFactory = makeMemoryJournal,
  scenarios = SCENARIOS,
  directorOptions = {},
  log = () => {},
} = {}) {
  if (typeof RynthAiDirector !== "function") {
    throw new Error("runScenarios: deps.RynthAiDirector (the real director class) is required");
  }
  const results = [];
  let passed = 0, failed = 0;
  for (const sc of scenarios) {
    const res = { name: sc.name, ok: false, error: null, checkins: [] };
    try {
      const bot = sc.bot();
      const journal = journalFactory();
      const client = makeScriptedClient(sc.llmReplies);
      bot._chats = client.calls; // expects assert on what the LLM was actually told
      const opts = { client, journal, intervalMinutes: 5, ...directorOptions, log };
      if (observe) opts.observe = observe;
      if (execute) opts.execute = execute;
      if (validate) opts.validate = validate;
      const d = new RynthAiDirector(bot, opts);
      d.start(); // enabled so _schedule records nextCheckAt (timers are unref'd; stop() below)
      try {
        for (let i = 0; i < sc.llmReplies.length; i++) {
          try {
            res.checkins.push({ resolved: true, result: await d.checkNow() });
          } catch (e) {
            // checkNow never rejects by contract — a rejection is itself a finding
            res.checkins.push({ resolved: false, error: String((e && e.message) || e) });
          }
        }
        const threw = res.checkins.filter((c) => !c.resolved);
        if (threw.length) throw new Error(`director threw on ${threw.length} check-in(s): ${threw[0].error}`);
        sc.expect(d.status, journal, bot);
        res.ok = true;
      } finally {
        d.stop();
      }
    } catch (e) {
      res.error = String((e && e.stack) || e);
    }
    if (res.ok) passed++; else failed++;
    log(`[eval] ${res.ok ? "PASS" : "FAIL"} ${sc.name}${res.error ? " — " + res.error.split("\n")[0] : ""}`);
    results.push(res);
  }
  return { passed, failed, results };
}
