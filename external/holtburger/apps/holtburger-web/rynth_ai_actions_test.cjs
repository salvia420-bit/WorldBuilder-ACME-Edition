#!/usr/bin/env node
// rynth_ai_actions_test.cjs — unit tests for rynth/ai/actions.js (the typed
// action surface the AI director's LLM may invoke). No infra, no network —
// a recording mock bot stands in for the live surfaces.
//
// Run: node rynth_ai_actions_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// Recording mock over the live surfaces actions.js drives: bot.goto
// (bot.js:148), router.cancel (bot.js:153), combat.priorities
// (combat_loop.js:50), loot.minValue (loot_loop.js:19), kernel start/stop
// (kernel.js:31/52), host.WriteToChat (webhost.js:464).
function makeBot(overrides = {}) {
  const calls = [];
  return {
    calls,
    goto: async (to) => { calls.push(["goto", to]); return { ok: true, state: "ARRIVED", legsWalked: 2, replans: 0 }; },
    router: { cancel: () => calls.push(["cancel"]) },
    combat: { priorities: { rat: 5 } },
    loot: { minValue: 0 },
    kernel: { start: () => calls.push(["start"]), stop: () => calls.push(["stop"]) },
    host: { WriteToChat: (t) => calls.push(["chat", t]) },
    ...overrides,
  };
}

(async () => {
  const A = await import(pathToFileURL(path.join(__dirname, "rynth", "ai", "actions.js")).href);
  const { ACTIONS, renderActionCatalog, validateAction, executeAction, executePlan } = A;

  // --- catalog -------------------------------------------------------------
  const TYPES = ["goto", "goto_lb", "stop_goto", "set_priorities", "set_loot_min_value",
    "pause", "resume", "say", "set_checkin", "note", "none"];
  check("ACTIONS has exactly the v1 types",
    JSON.stringify(Object.keys(ACTIONS).sort()) === JSON.stringify([...TYPES].sort()),
    Object.keys(ACTIONS).join(","));
  check("ACTIONS entries have params+desc",
    Object.values(ACTIONS).every((s) => s && typeof s.desc === "string" && s.params && typeof s.params === "object"));
  const cat = renderActionCatalog();
  check("catalog is one line per action",
    typeof cat === "string" && cat.split("\n").length === TYPES.length, `${cat.split("\n").length} lines`);
  check("catalog names every type", TYPES.every((t) => cat.includes(t)));
  check("catalog states bounds", cat.includes("102") && cat.includes("1..99") && cat.includes("1..30")
    && cat.includes("120") && cat.includes("500") && cat.includes('"@"'));

  // --- validateAction: happy paths ----------------------------------------
  const good = [
    { type: "goto", ns: -33.6, ew: 72.1 },
    { type: "goto", ns: 102, ew: -102 }, // boundary inclusive
    { type: "goto_lb", lb: "A9B40015", x: 50, y: 50, z: 0 },
    { type: "goto_lb", lb: "0xa9b4001d", x: 1, y: 2, z: 3 },
    { type: "goto_lb", lb: 0xa9b40015, x: 0, y: 0, z: -1.5 },
    { type: "stop_goto" },
    { type: "set_priorities", rules: { olthoi: 99, rat: 1 } },
    { type: "set_priorities", rules: {} }, // clears all rules
    { type: "set_loot_min_value", value: 0 },
    { type: "set_loot_min_value", value: 50000 },
    { type: "pause" }, { type: "resume" },
    { type: "say", text: "hunting olthoi north of Hebian-To" },
    { type: "set_checkin", minutes: 1 }, { type: "set_checkin", minutes: 30 },
    { type: "note", text: "loot floor raised; area was picked clean" },
    { type: "none" },
  ];
  for (const a of good) {
    const v = validateAction(a);
    check(`valid: ${JSON.stringify(a).slice(0, 60)}`, v.ok === true, v.error);
  }

  // --- validateAction: every bound violated --------------------------------
  const bad = [
    [null, "null action"],
    ["goto", "string action"],
    [[], "array action"],
    [{}, "missing type"],
    [{ type: "eval", code: "1" }, "unknown type"],
    [{ type: "toString" }, "prototype-chain type"],
    [{ type: "goto", ns: 102.5, ew: 0 }, "goto ns > 102"],
    [{ type: "goto", ns: 0, ew: -103 }, "goto ew < -102"],
    [{ type: "goto", ns: NaN, ew: 0 }, "goto NaN"],
    [{ type: "goto", ns: Infinity, ew: 0 }, "goto Infinity"],
    [{ type: "goto", ns: "12", ew: 0 }, "goto string deg"],
    [{ type: "goto", ns: 12 }, "goto missing ew"],
    [{ type: "goto_lb", lb: "not-hex", x: 0, y: 0, z: 0 }, "lb bad hex"],
    [{ type: "goto_lb", lb: "A9B40015FF", x: 0, y: 0, z: 0 }, "lb hex too long"],
    [{ type: "goto_lb", lb: -1, x: 0, y: 0, z: 0 }, "lb negative"],
    [{ type: "goto_lb", lb: 1.5, x: 0, y: 0, z: 0 }, "lb non-integer"],
    [{ type: "goto_lb", lb: "A9B4", x: "0", y: 0, z: 0 }, "lb x string"],
    [{ type: "goto_lb", lb: "A9B4", x: 0, y: 0 }, "lb missing z"],
    [{ type: "set_priorities" }, "priorities missing rules"],
    [{ type: "set_priorities", rules: [1, 2] }, "priorities array"],
    [{ type: "set_priorities", rules: { olthoi: 0 } }, "priority 0"],
    [{ type: "set_priorities", rules: { olthoi: 100 } }, "priority 100"],
    [{ type: "set_priorities", rules: { olthoi: 4.5 } }, "priority float"],
    [{ type: "set_priorities", rules: { olthoi: "9" } }, "priority string"],
    [{ type: "set_priorities", rules: { "  ": 5 } }, "blank rule name"],
    [{ type: "set_loot_min_value", value: -1 }, "loot value < 0"],
    [{ type: "set_loot_min_value", value: 2.5 }, "loot value float"],
    [{ type: "set_loot_min_value", value: "500" }, "loot value string"],
    [{ type: "say", text: "@sethealth 1" }, 'say "@sethealth 1"'],
    [{ type: "say", text: "  @tele 0 0" }, "say @ after leading spaces"],
    [{ type: "say", text: "" }, "say empty"],
    [{ type: "say", text: 42 }, "say non-string"],
    [{ type: "set_checkin", minutes: 0 }, "checkin 0"],
    [{ type: "set_checkin", minutes: 31 }, "checkin 31"],
    [{ type: "set_checkin", minutes: 2.5 }, "checkin float"],
    [{ type: "set_checkin", minutes: "5" }, "checkin string"],
    [{ type: "note", text: "" }, "note empty"],
    [{ type: "note" }, "note missing text"],
  ];
  for (const [a, name] of bad) {
    const v = validateAction(a);
    check(`rejects ${name}`, v.ok === false && typeof v.error === "string", JSON.stringify(v));
  }

  // --- executeAction: happy path per action --------------------------------
  {
    const bot = makeBot();
    let r = await executeAction(bot, { type: "goto", ns: -33.6, ew: 72.1 });
    check("exec goto", r.type === "goto" && r.ok === true && r.result.state === "ARRIVED"
      && bot.calls[0][0] === "goto" && bot.calls[0][1].ns === -33.6 && bot.calls[0][1].ew === 72.1,
      JSON.stringify(r));

    r = await executeAction(bot, { type: "goto_lb", lb: "A9B40015", x: 50, y: 60, z: 0 });
    const to = bot.calls[1] && bot.calls[1][1];
    check("exec goto_lb hex lb -> number", r.ok === true && to && to.lb === 0xa9b40015
      && to.x === 50 && to.y === 60 && to.z === 0, JSON.stringify(to));
    r = await executeAction(bot, { type: "goto_lb", lb: 0x12340010, x: 0, y: 0, z: 0 });
    check("exec goto_lb numeric lb passes through", r.ok === true && bot.calls[2][1].lb === 0x12340010);
    r = await executeAction(bot, { type: "goto_lb", lb: "A9B4", x: 0, y: 0, z: 0 });
    check("exec goto_lb refuses bare landblock word", r.ok === false
      && /objCellId/.test(r.error) && !bot.calls.some((c) => c[0] === "goto" && c[1].lb === 0xa9b4),
      JSON.stringify(r));

    r = await executeAction(bot, { type: "stop_goto" });
    check("exec stop_goto", r.ok === true && bot.calls[3][0] === "cancel", JSON.stringify(r));

    r = await executeAction(bot, { type: "set_priorities", rules: { olthoi: 10 } });
    check("exec set_priorities REPLACES", r.ok === true
      && bot.combat.priorities.olthoi === 10 && !("rat" in bot.combat.priorities), // mock started with {rat:5}
      JSON.stringify(bot.combat.priorities));
    const rules = { drudge: 3 };
    await executeAction(bot, { type: "set_priorities", rules });
    rules.drudge = 77;
    check("exec set_priorities copies rules", bot.combat.priorities.drudge === 3);

    r = await executeAction(bot, { type: "set_loot_min_value", value: 5000 });
    check("exec set_loot_min_value", r.ok === true && bot.loot.minValue === 5000);

    r = await executeAction(bot, { type: "pause" });
    check("exec pause -> kernel.stop", r.ok === true && bot.calls.some((c) => c[0] === "stop"));
    r = await executeAction(bot, { type: "resume" });
    check("exec resume -> kernel.start", r.ok === true && bot.calls.some((c) => c[0] === "start"));

    r = await executeAction(bot, { type: "say", text: "  hello there  " });
    const chat = bot.calls.find((c) => c[0] === "chat");
    check("exec say trims + sends", r.ok === true && chat && chat[1] === "hello there", JSON.stringify(chat));
    r = await executeAction(bot, { type: "say", text: "x".repeat(200) });
    const chat2 = bot.calls.filter((c) => c[0] === "chat")[1];
    check("exec say caps 120", r.ok === true && chat2[1].length === 120 && r.result.text.length === 120);

    r = await executeAction(bot, { type: "set_checkin", minutes: 7 });
    check("exec set_checkin returns minutes for the director", r.ok === true && r.result.minutes === 7);

    r = await executeAction(bot, { type: "note", text: "n".repeat(600) });
    check("exec note caps 500", r.ok === true && r.result.text.length === 500);

    const before = bot.calls.length;
    r = await executeAction(bot, { type: "none" });
    check("exec none is a no-op", r.ok === true && bot.calls.length === before);
  }

  // --- executeAction: failures never throw ---------------------------------
  {
    const bot = makeBot({ goto: async () => ({ ok: false, error: "goto already active" }) });
    const r = await executeAction(bot, { type: "goto", ns: 0, ew: 0 });
    check("goto refusal surfaces as error", r.ok === false && r.error === "goto already active", JSON.stringify(r));
  }
  {
    const bot = makeBot({ goto: () => { throw new Error("sync boom"); } });
    const r = await executeAction(bot, { type: "goto", ns: 0, ew: 0 });
    check("sync-throwing bot call caught", r.ok === false && r.error === "sync boom", JSON.stringify(r));
  }
  {
    const bot = makeBot({ goto: async () => { throw new Error("async boom"); } });
    const r = await executeAction(bot, { type: "goto", ns: 0, ew: 0 });
    check("rejecting bot call caught", r.ok === false && r.error === "async boom", JSON.stringify(r));
  }
  {
    const bot = makeBot({ kernel: { start: () => {}, stop: () => { throw new Error("kernel boom"); } } });
    const r = await executeAction(bot, { type: "pause" });
    check("throwing kernel.stop caught", r.ok === false && r.error === "kernel boom", JSON.stringify(r));
  }
  {
    // invalid action through the executor (not just validateAction)
    const bot = makeBot();
    const r = await executeAction(bot, { type: "say", text: "@sethealth 1" });
    check("executor refuses @say", r.ok === false && /@/.test(r.error) && !bot.calls.some((c) => c[0] === "chat"),
      JSON.stringify(r));
    const r2 = await executeAction(bot, { type: "eval", code: "1" });
    check("executor rejects unknown type", r2.ok === false, JSON.stringify(r2));
    const r3 = await executeAction(bot, null);
    check("executor survives null action", r3.ok === false, JSON.stringify(r3));
    const r4 = await executeAction(null, { type: "pause" });
    check("executor survives null bot", r4.ok === false && r4.error === "unavailable", JSON.stringify(r4));
  }

  // --- executeAction: missing subsystems -> "unavailable" ------------------
  {
    const cases = [
      [{ loot: null }, { type: "set_loot_min_value", value: 1 }],
      [{ combat: null }, { type: "set_priorities", rules: { rat: 1 } }],
      [{ kernel: null }, { type: "pause" }],
      [{ kernel: null }, { type: "resume" }],
      [{ router: null }, { type: "stop_goto" }],
      [{ host: null }, { type: "say", text: "hi" }],
      [{ goto: null }, { type: "goto", ns: 0, ew: 0 }],
      [{ goto: null }, { type: "goto_lb", lb: "A9B4", x: 0, y: 0, z: 0 }],
    ];
    for (const [over, a] of cases) {
      const r = await executeAction(makeBot(over), a);
      check(`unavailable: ${a.type} without ${Object.keys(over)[0]}`,
        r.ok === false && r.error === "unavailable", JSON.stringify(r));
    }
  }

  // --- executePlan ----------------------------------------------------------
  {
    const bot = makeBot();
    const plan = [
      { type: "note", text: "1" }, { type: "note", text: "2" }, { type: "note", text: "3" },
      { type: "note", text: "4" }, { type: "note", text: "5" }, { type: "note", text: "6" },
      { type: "pause" },
    ];
    const logs = [];
    const results = await executePlan(bot, plan, { log: (m) => logs.push(m) });
    check("plan caps at default maxActions=5", results.length === 5, `${results.length}`);
    check("plan is sequential/in-order",
      results.every((r, i) => r.type === "note" && r.ok && r.result.text === String(i + 1)));
    check("plan skips past-cap actions", !bot.calls.some((c) => c[0] === "stop"));
    check("plan logs truncation", logs.some((m) => /truncated/.test(m)), JSON.stringify(logs));

    const r2 = await executePlan(bot, plan, { maxActions: 2 });
    check("plan honors maxActions override", r2.length === 2);
  }
  {
    // mixed valid/invalid/throwing — every result recorded, nothing thrown
    const bot = makeBot({ goto: async () => { throw new Error("boom"); } });
    const results = await executePlan(bot, [
      { type: "set_loot_min_value", value: 100 },
      { type: "goto", ns: 0, ew: 0 },       // rejects (mock throws)
      { type: "say", text: "@admin" },       // invalid
      { type: "resume" },
    ]);
    check("mixed plan records every result", results.length === 4
      && results[0].ok && !results[1].ok && !results[2].ok && results[3].ok,
      JSON.stringify(results.map((r) => r.ok)));
    check("mixed plan keeps executing after failures", bot.calls.some((c) => c[0] === "start"));
  }
  {
    const r1 = await executePlan(makeBot(), null);
    const r2 = await executePlan(makeBot(), "not-an-array");
    check("plan tolerates non-array actions", Array.isArray(r1) && r1.length === 0
      && Array.isArray(r2) && r2.length === 0);
    const r3 = await executePlan(makeBot(), [{ type: "note", text: "x" }], { log: () => { throw new Error("log boom"); } });
    check("plan survives a throwing log", r3.length === 1 && r3[0].ok === true);
  }

  console.log(`${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
