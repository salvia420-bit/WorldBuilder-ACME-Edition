#!/usr/bin/env node
// rynth_ai_safety_test.cjs — unit tests for rynth/ai/safety.js (the
// standalone SAFETY / GOVERNOR layer). No infra, no network: sanitizeAction
// is pure, RateGovernor takes an injected clock, guardPlan takes an injected
// sanitizer. actions.js is imported (safety.js layers over its frozen
// validateAction) but no bot / LLM is involved.
//
// Run: node rynth_ai_safety_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// Control/invisible test characters built by code point so no raw control
// byte lands in this source file.
const ch = (...codes) => String.fromCharCode(...codes);
const NUL = ch(0x0000), TAB = ch(0x0009), LF = ch(0x000a), BELL = ch(0x0007);
const C1_ST = ch(0x009c), LSEP = ch(0x2028);
const NBSP = ch(0x00a0), ZWSP = ch(0x200b), RLO = ch(0x202e), LRI = ch(0x2066), BOM = ch(0xfeff);
const FW_AT = ch(0xff20);    // ＠ FULLWIDTH COMMERCIAL AT (NFKC -> @)
const FW_SLASH = ch(0xff0f); // ／ FULLWIDTH SOLIDUS (NFKC -> /)

(async () => {
  const dir = path.join(__dirname, "rynth", "ai");
  const mod = await import(pathToFileURL(path.join(dir, "safety.js")).href);
  const { sanitizeAction, RateGovernor, guardPlan } = mod;
  const actionsMod = await import(pathToFileURL(path.join(dir, "actions.js")).href);

  check("exports", typeof sanitizeAction === "function" && typeof RateGovernor === "function" && typeof guardPlan === "function");

  // ================= sanitizeAction: admin-command rejection matrix =========
  const rejects = [
    ["say @admin", { type: "say", text: "@smite all" }],
    ["say leading spaces + @", { type: "say", text: "   @tele me" }],
    ["say bare @", { type: "say", text: "@" }],
    ["say /slash command", { type: "say", text: "/die now" }],
    ["say zero-width + @", { type: "say", text: ZWSP + "@tele" }],
    ["say NBSP + /", { type: "say", text: NBSP + "/quit" }],
    ["say fullwidth at (NFKC)", { type: "say", text: FW_AT + "tele" }],
    ["say fullwidth slash (NFKC)", { type: "say", text: FW_SLASH + "die" }],
    ["say BOM + /", { type: "say", text: BOM + "/allegiance" }],
    ["say bidi RLO + @", { type: "say", text: RLO + "@x" }],
    ["say bidi isolate + /", { type: "say", text: LRI + "/cmd" }],
    ["say stacked invisibles + @", { type: "say", text: ZWSP + BOM + NBSP + "@x" }],
    ["note @admin", { type: "note", text: "@remember this" }],
    ["note /slash", { type: "note", text: "/cmd note" }],
    // control characters (say is single-line chat; \t \n count too)
    ["say embedded NUL", { type: "say", text: "hi" + NUL + "there" }],
    ["say newline smuggle", { type: "say", text: "hello" + LF + "@smite" }],
    ["say tab", { type: "say", text: TAB + "tabbed" }],
    ["say BELL", { type: "say", text: "ding" + BELL }],
    ["say C1 control", { type: "say", text: "x" + C1_ST + "y" }],
    ["say U+2028 line sep", { type: "say", text: "a" + LSEP + "b" }],
    ["note control char", { type: "note", text: "n" + NUL }],
    // emptiness / length caps
    ["say empty", { type: "say", text: "" }],
    ["say invisible-only", { type: "say", text: ZWSP + ZWSP }],
    ["say 121 chars", { type: "say", text: "x".repeat(121) }],
    ["note 501 chars", { type: "note", text: "x".repeat(501) }],
    // generic string-param screening (defense on any string field)
    ["say with poisoned extra field", { type: "say", text: "ok", extra: "@x" }],
    // unknown / malformed
    ["unknown type", { type: "smite_all" }],
    ["proto type", { type: "__proto__" }],
    ["inherited-only type", { type: "toString" }],
    ["missing type", { text: "hi" }],
    ["null", null],
    ["array", [{ type: "none" }]],
    ["string", "say"],
    ["number type", { type: 42 }],
  ];
  for (const [name, a] of rejects) {
    let r;
    try { r = sanitizeAction(a); } catch (e) { r = { threw: e }; }
    check(`reject: ${name}`, !r.threw && r.ok === false && typeof r.error === "string" && r.action === undefined,
      r.threw ? `threw ${r.threw}` : JSON.stringify(r));
  }

  const accepts = [
    ["say plain", { type: "say", text: "pulling drudges north" }],
    ["say embedded @", { type: "say", text: "thanks @friend" }],
    ["say embedded /", { type: "say", text: "loot a/b test ongoing" }],
    ["say exactly 120 chars", { type: "say", text: "x".repeat(120) }],
    ["note exactly 500 chars", { type: "note", text: "x".repeat(500) }],
    ["goto in bounds", { type: "goto", ns: -33.6, ew: 12.25 }],
    ["goto at bound 102", { type: "goto", ns: 102, ew: -102 }],
    ["goto_lb hex string lb", { type: "goto_lb", lb: "0x00640021", x: 60, y: 60, z: 0 }],
    ["stop_goto", { type: "stop_goto" }],
    ["pause", { type: "pause" }],
    ["resume", { type: "resume" }],
    ["none", { type: "none" }],
    ["set_checkin in range", { type: "set_checkin", minutes: 7 }],
    ["set_loot_min_value ok", { type: "set_loot_min_value", value: 5000 }],
    ["set_priorities ok", { type: "set_priorities", rules: { Drudge: 10, "Olthoi Soldier": 99 } }],
  ];
  for (const [name, a] of accepts) {
    let r;
    try { r = sanitizeAction(a); } catch (e) { r = { threw: e }; }
    check(`accept: ${name}`, !r.threw && r.ok === true && r.action && r.action.type === a.type && r.error === undefined,
      r.threw ? `threw ${r.threw}` : JSON.stringify(r));
  }

  // ---------------- numeric clamp vs reject --------------------------------
  {
    let r = sanitizeAction({ type: "set_checkin", minutes: 45 });
    check("clamp: set_checkin 45 -> 30 with note", r.ok === true && r.action.minutes === 30 && /45/.test(r.note) && /30/.test(r.note), JSON.stringify(r));
    r = sanitizeAction({ type: "set_checkin", minutes: 0.5 });
    check("clamp: set_checkin 0.5 REJECTED (no clamp to faster cadence)", r.ok === false && /1/.test(r.error), JSON.stringify(r));
    r = sanitizeAction({ type: "set_checkin", minutes: 7.5 });
    check("clamp: set_checkin 7.5 -> rounded 8 with note", r.ok === true && r.action.minutes === 8 && !!r.note, JSON.stringify(r));
    r = sanitizeAction({ type: "set_checkin", minutes: 7 });
    check("clamp: set_checkin 7 untouched, no note", r.ok === true && r.action.minutes === 7 && r.note === undefined, JSON.stringify(r));
    for (const [label, v] of [["string", "5"], ["NaN", NaN], ["Infinity", Infinity], ["-3", -3], ["missing", undefined]]) {
      r = sanitizeAction({ type: "set_checkin", minutes: v });
      check(`clamp: set_checkin ${label} rejected`, r.ok === false, JSON.stringify(r));
    }

    r = sanitizeAction({ type: "set_loot_min_value", value: -5 });
    check("clamp: loot value -5 -> 0 with note", r.ok === true && r.action.value === 0 && !!r.note, JSON.stringify(r));
    r = sanitizeAction({ type: "set_loot_min_value", value: 2500.7 });
    check("clamp: loot value 2500.7 -> 2501 with note", r.ok === true && r.action.value === 2501 && !!r.note, JSON.stringify(r));
    r = sanitizeAction({ type: "set_loot_min_value", value: 0 });
    check("clamp: loot value 0 untouched", r.ok === true && r.action.value === 0 && r.note === undefined, JSON.stringify(r));
    for (const [label, v] of [["string", "5"], ["NaN", NaN], ["Infinity", Infinity]]) {
      r = sanitizeAction({ type: "set_loot_min_value", value: v });
      check(`clamp: loot value ${label} rejected`, r.ok === false, JSON.stringify(r));
    }

    // goto is REJECT-only: clamping a coordinate would move the destination.
    r = sanitizeAction({ type: "goto", ns: 200, ew: 0 });
    check("clamp: goto ns=200 rejected, NOT clamped", r.ok === false, JSON.stringify(r));
    r = sanitizeAction({ type: "goto", ns: 102.5, ew: 0 });
    check("clamp: goto ns=102.5 rejected", r.ok === false, JSON.stringify(r));
    r = sanitizeAction({ type: "goto", ns: NaN, ew: 0 });
    check("clamp: goto NaN rejected", r.ok === false, JSON.stringify(r));

    r = sanitizeAction({ type: "set_priorities", rules: { Drudge: 150 } });
    check("clamp: priority 150 -> 99 with note", r.ok === true && r.action.rules.Drudge === 99 && /Drudge/.test(r.note), JSON.stringify(r));
    r = sanitizeAction({ type: "set_priorities", rules: { Drudge: 0 } });
    check("clamp: priority 0 -> 1 with note", r.ok === true && r.action.rules.Drudge === 1 && !!r.note, JSON.stringify(r));
    r = sanitizeAction({ type: "set_priorities", rules: { Drudge: 2.7 } });
    check("clamp: priority 2.7 -> 3", r.ok === true && r.action.rules.Drudge === 3, JSON.stringify(r));
    r = sanitizeAction({ type: "set_priorities", rules: { Drudge: 10, Mosswart: 200, Shreth: -4 } });
    check("clamp: multi-rule notes joined", r.ok === true && r.action.rules.Mosswart === 99 && r.action.rules.Shreth === 1
      && r.action.rules.Drudge === 10 && /Mosswart/.test(r.note) && /Shreth/.test(r.note), JSON.stringify(r));

    const badPriorities = [
      ["empty name", { "": 5 }],
      ["control-char name", { ["Dru" + NUL + "dge"]: 5 }],
      ["overlong name", { ["x".repeat(101)]: 5 }],
      ["non-numeric value", { Drudge: "high" }],
      ["reserved __proto__ name", JSON.parse('{"__proto__": 5}')],
      ["reserved constructor name", { constructor: 5 }],
      ["array rules", ["Drudge"]],
      ["missing rules", undefined],
      ["too many rules", Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`m${i}`, 1]))],
    ];
    for (const [label, rules] of badPriorities) {
      const rr = sanitizeAction({ type: "set_priorities", rules });
      check(`priorities: ${label} rejected`, rr.ok === false, JSON.stringify(rr));
    }
  }

  // ---------------- layered validate gate + purity + never-throws ----------
  {
    // Passes every safety screen, fails the frozen v1 validator (bad lb hex).
    const r = sanitizeAction({ type: "goto_lb", lb: "zzzz", x: 1, y: 1, z: 1 });
    check("gate: v1 validateAction still applies to sanitized clone", r.ok === false && /objCellId/.test(r.error), JSON.stringify(r));
  }
  {
    const rules = Object.freeze({ Drudge: 150.6 });
    const input = Object.freeze({ type: "set_priorities", rules });
    let r;
    try { r = sanitizeAction(input); } catch (e) { r = { threw: e }; }
    check("pure: frozen input, clamped CLONE returned", !r.threw && r.ok === true
      && r.action !== input && r.action.rules !== rules
      && r.action.rules.Drudge === 99 && input.rules.Drudge === 150.6, r.threw ? String(r.threw) : JSON.stringify(r));
    if (r.action) { r.action.rules.Drudge = 1; }
    check("pure: mutating the clone leaves the input alone", input.rules.Drudge === 150.6);
    const say = Object.freeze({ type: "say", text: "hello" });
    const rs = sanitizeAction(say);
    check("pure: accepted action is a fresh object", rs.ok === true && rs.action !== say && rs.action.text === "hello");
  }
  {
    const garbage = [
      undefined, null, 0, 42, true, "say", [], [{}], () => {},
      { type: null }, { type: {} }, { type: "say" }, { type: "say", text: 7 },
      { type: "goto" }, { type: "goto", ns: "5", ew: 1 }, { type: "goto_lb", lb: {} },
      { type: "set_priorities" }, { type: "set_priorities", rules: 3 },
      { type: "set_checkin" }, { type: "set_loot_min_value" }, { type: "note" },
      Object.create({ type: "say", text: "inherited" }), // no OWN type
    ];
    let threw = 0, notRejected = 0;
    for (const g of garbage) {
      try { const r = sanitizeAction(g); if (!r || r.ok !== false || typeof r.error !== "string") notRejected++; }
      catch { threw++; }
    }
    check("fuzz: sanitizeAction never throws, rejects all garbage", threw === 0 && notRejected === 0,
      `threw=${threw} notRejected=${notRejected}`);
  }

  // ---------------- forward-compat: catalog-registered text action ---------
  {
    // A future agent registers a text-bearing action into ACTIONS (the
    // documented extension seam) — the generic string screen must cover it
    // with no safety.js change. In-memory only; removed in finally.
    actionsMod.ACTIONS.lookup = { params: { query: "string" }, desc: "test-only" };
    try {
      check("seam: registered type + clean text passes", sanitizeAction({ type: "lookup", query: "drudge spawn spots" }).ok === true);
      check("seam: registered type + hidden @ rejected", sanitizeAction({ type: "lookup", query: ZWSP + "@smite" }).ok === false);
      check("seam: registered type + control char rejected", sanitizeAction({ type: "lookup", query: "a" + LF + "b" }).ok === false);
      check("seam: registered type + overlong text rejected", sanitizeAction({ type: "lookup", query: "x".repeat(501) }).ok === false);
    } finally {
      delete actionsMod.ACTIONS.lookup;
    }
    check("seam: cleanup restored the catalog", sanitizeAction({ type: "lookup", query: "x" }).ok === false);
  }

  // ================= RateGovernor ===========================================
  {
    const t0 = 1_000_000_000;
    const g = new RateGovernor({ maxCallsPerHour: 3 });
    check("gov: fresh allows", g.allowCall(t0).ok === true);
    g.recordCall(t0);
    g.recordCall(t0 + 600_000);
    g.recordCall(t0 + 1_200_000);
    const b = g.allowCall(t0 + 1_800_000);
    check("gov: blocked at cap with reason", b.ok === false && /3/.test(b.reason) && /60 min/.test(b.reason), JSON.stringify(b));
    check("gov: 59:59.999 still blocked", g.allowCall(t0 + 3_599_999).ok === false);
    check("gov: first call ages out at exactly 60 min", g.allowCall(t0 + 3_600_000).ok === true);
    check("gov: second call ages out too", g.allowCall(t0 + 600_000 + 3_600_000).ok === true);
    g.recordCall(t0 + 4_000_000);
    check("gov: 2 in refreshed window still allows", g.allowCall(t0 + 4_000_001).ok === true);
    g.recordCall(t0 + 4_000_100);
    check("gov: refilled window blocks again at cap", g.allowCall(t0 + 4_000_200).ok === false);
    const g0 = new RateGovernor({ maxCallsPerHour: 0 });
    check("gov: maxCallsPerHour 0 blocks everything", g0.allowCall(t0).ok === false);
    check("gov: allowCall(NaN) fails closed", g.allowCall(NaN).ok === false);
  }
  {
    // recordCall(NaN) must not poison the window; note() is non-mutating.
    const t0 = 5_000_000;
    const g = new RateGovernor({ maxCallsPerHour: 5, maxActionsPerCheck: 3, maxSpendUsd: 2 });
    g.recordCall(NaN);
    check("gov: recordCall(NaN) ignored", /0\/5/.test(g.note(t0)), g.note(t0));
    g.recordCall(t0);
    const line = g.note(t0 + 1000);
    check("gov: note telemetry line", typeof line === "string" && line.includes("1/5") && line.includes("3") && line.includes("$2"), line);
    g.note(t0 + 100 * 3_600_000); // far-future note must NOT prune history
    check("gov: note non-mutating", /1\/5/.test(g.note(t0 + 1000)), g.note(t0 + 1000));
  }
  {
    const g = new RateGovernor({ maxSpendUsd: 1.0 });
    check("gov: spend under cap ok", g.allowSpend(0.5).ok === true);
    check("gov: spend 0 ok", g.allowSpend(0).ok === true);
    const at = g.allowSpend(1.0);
    check("gov: spend AT cap blocked", at.ok === false && /1/.test(at.reason), JSON.stringify(at));
    check("gov: spend over cap blocked", g.allowSpend(1.5).ok === false);
    check("gov: NaN spend fails CLOSED with cap set", g.allowSpend(NaN).ok === false);
    check("gov: undefined spend fails CLOSED with cap set", g.allowSpend(undefined).ok === false);
    const free = new RateGovernor();
    check("gov: defaults", free.maxCallsPerHour === 12 && free.maxActionsPerCheck === 5 && free.maxSpendUsd === null);
    check("gov: no cap -> any spend ok", free.allowSpend(1e9).ok === true && free.allowSpend(NaN).ok === true);
  }
  {
    let threw = 0;
    try {
      const g = new RateGovernor(null);
      g.allowCall(); g.recordCall(); g.allowSpend(); g.note();
      const g2 = new RateGovernor({ maxCallsPerHour: "x", maxActionsPerCheck: -1, maxSpendUsd: "y" });
      check("gov: garbage config -> defaults", g2.maxCallsPerHour === 12 && g2.maxActionsPerCheck === 5 && g2.maxSpendUsd === null);
      check("gov: garbage config still allows", g2.allowCall(1000).ok === true && g2.allowSpend(999).ok === true);
    } catch { threw++; }
    check("gov: never throws on garbage construction/args", threw === 0);
  }

  // ================= guardPlan ==============================================
  {
    const plan = [
      { type: "say", text: "pulling drudges" },
      { type: "say", text: "@smite" },
      { type: "set_checkin", minutes: 45 },
      { type: "totally_bogus" },
      { type: "note", text: "loot floor 5k works well" },
    ];
    const r = guardPlan(plan);
    check("guard: keeps sane, clamped plan in order",
      r.actions.length === 3 && r.actions.map((a) => a.type).join(",") === "say,set_checkin,note",
      JSON.stringify(r.actions));
    check("guard: clamp applied inside kept action", r.actions[1].minutes === 30);
    check("guard: rejected carry ORIGINAL action + error",
      r.rejected.length === 2 && r.rejected[0].action === plan[1] && /command/.test(r.rejected[0].error)
      && r.rejected[1].action === plan[3] && /unknown/.test(r.rejected[1].error),
      JSON.stringify(r.rejected));
    check("guard: clamp notes surfaced", Array.isArray(r.notes) && r.notes.length === 1
      && r.notes[0].action === r.actions[1] && /45/.test(r.notes[0].note), JSON.stringify(r.notes));
    check("guard: kept actions are sanitized clones", r.actions[0] !== plan[0]);
  }
  {
    const many = Array.from({ length: 8 }, (_, i) => ({ type: "note", text: `note ${i}` }));
    const r = guardPlan(many);
    check("guard: default maxActions=5 truncates", r.actions.length === 5 && r.rejected.length === 3
      && r.rejected.every((x) => /maxActions=5/.test(x.error)), JSON.stringify(r.rejected.map((x) => x.error)));
    const r2 = guardPlan(many, { maxActions: 2 });
    check("guard: custom maxActions", r2.actions.length === 2 && r2.rejected.length === 6);
    const r0 = guardPlan(many, { maxActions: 0 });
    check("guard: maxActions 0 keeps nothing", r0.actions.length === 0 && r0.rejected.length === 8);
    // Rejection does not consume a slot: 1 bad + 5 good with cap 5 keeps all 5.
    const mixed = [{ type: "bogus" }, ...many.slice(0, 5)];
    const r3 = guardPlan(mixed);
    check("guard: rejects don't consume maxActions slots", r3.actions.length === 5 && r3.rejected.length === 1, JSON.stringify(r3.rejected));
  }
  {
    const throwing = () => { throw new Error("sanitizer exploded"); };
    const r = guardPlan([{ type: "none" }], { sanitize: throwing });
    check("guard: throwing injected sanitize -> rejected, never throws",
      r.actions.length === 0 && r.rejected.length === 1 && /exploded/.test(r.rejected[0].error), JSON.stringify(r));
    const weird = () => undefined;
    const r2 = guardPlan([{ type: "none" }], { sanitize: weird });
    check("guard: undefined-returning sanitize -> rejected", r2.actions.length === 0 && r2.rejected.length === 1);
    const custom = (a) => ({ ok: true, action: { ...a, tagged: true } });
    const r3 = guardPlan([{ type: "none" }], { sanitize: custom });
    check("guard: injected sanitize's action is what's kept", r3.actions.length === 1 && r3.actions[0].tagged === true);
  }
  {
    let threw = 0, allEmpty = true;
    for (const bad of [null, undefined, "x", 42, {}, { length: 3 }]) {
      try {
        const r = guardPlan(bad);
        if (!r || !Array.isArray(r.actions) || r.actions.length !== 0 || !Array.isArray(r.rejected) || r.rejected.length !== 0) allEmpty = false;
      } catch { threw++; }
    }
    check("guard: non-array plan degrades to empty, never throws", threw === 0 && allEmpty);
    let threwOpts = 0;
    try { guardPlan([{ type: "none" }], null); } catch { threwOpts++; }
    check("guard: null opts tolerated", threwOpts === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
