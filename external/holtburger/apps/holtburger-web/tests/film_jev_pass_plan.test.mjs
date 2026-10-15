// tests/film_jev_pass_plan.test.mjs
//
// WHY: the Egg Orchard FPV run (research/egg-orchard-run/DESIGN.md §4) bakes an over / left / right pass past
// every creature near its racing line. The side is a planning-time JEV decision (`film jev task pass-plan`,
// tools/film/lib/jev_tasks.mjs planPasses) with an identical code rule as the fallback. This suite pins:
//   P1 room words: margin = gap − need → 'blocked' <0, 'tight' <0.5, 'comfortable' <1.5, 'wide open'; the DESIGN
//      needs (side 1.9 m; over 1.2 m above the top + 0.4 m below the ceiling) and per-creature overrides
//   P2 codePass: the four rules in order (allowed → variety → roomiest → next_turn / canonical order) + squeeze
//   P3 the request: valid questions, the code pick listed FIRST, criteria + instructions quote the room words,
//      state carries words (gaps as words with metres), previous_pass, next_turn
//   P4 no client → the code plan for every creature (source 'code'), previous chaining, deterministic
//   P5 the real createJevClient over a FAKE transport (injected fetchFn, no network): JEV picks honoured, the
//      next request's previous_pass is JEV's previous answer, usage summed, the key never logged
//   P6 guard: a JEV pick with room 'blocked' while another option is allowed → the code pick (escalate)
//   P7 failures: a 500 → that creature uses the code pick (jevError), source 'mixed'; 401 → thrown;
//      3 failures in a row → the rest without calls
//   P8 batch mode: one call, one question per creature, previous_pass from the code chain
//   P9 input validation (bad-request) ; P10 PASS_PLAN_CLI input/text
//   P11 property: over 500 random creatures the code pick is the first listed option and is never 'blocked'
//      unless every option is
// No real network call is ever made.
//
// Run from apps/holtburger-web/: node tests/film_jev_pass_plan.test.mjs

import assert from "node:assert/strict";

import { JevError, createJevClient, validateQuestions } from "../tools/film/lib/jev.mjs";
import {
  PASS_INSTRUCTIONS,
  PASS_PLAN_CLI,
  PASS_ROOM_WORDS,
  PASS_RULES,
  PASS_SIDES,
  buildPassBatchRequest,
  buildPassRequest,
  codePass,
  normalizePassInput,
  passRoomWord,
  passWordsFor,
  planPasses,
} from "../tools/film/lib/jev_tasks.mjs";

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name} — ${e?.stack ?? e}`);
  }
}

const KEY = "sk-or-v1-TESTKEY-pass-plan-0123456789abcdef";

// Egg-Orchard-like creatures (gaps in metres; tunnel needs raised to the run's 0.9 m ceiling rule where noted).
const C = {
  slasherTunnel: { id: "slasher-35d", name: "Olthoi Slasher", region: "tunnel", s: 46.5, gaps: { over: 1.4, left: 1.6, right: 1.7 }, nextTurn: "left" },
  slasherRight: { id: "slasher-350", name: "Olthoi Slasher", region: "tunnel", s: 78, gaps: { over: 1.4, left: 1.4, right: 2.1 }, nextTurn: "straight" },
  ripperTunnel: { id: "ripper-1a5", name: "Olthoi Ripper", region: "tunnel", s: 507.5, gaps: { over: 1.89, left: 2.0, right: 2.3 }, nextTurn: "right" },
  ripperRoom: { id: "ripper-1de", name: "Olthoi Ripper", region: "room", s: 419.5, gaps: { over: 4.1, left: 1.7, right: 8.0 }, nextTurn: "left" },
  ripperOpen: { id: "ripper-12f", name: "Olthoi Ripper", region: "room", s: 652, gaps: { over: 12.7, left: 3.9, right: 6.8 }, nextTurn: "straight" },
};

// ---------------------------------------------------------------------------
// A fake Decisions-API transport for the REAL client: fetchFn(url, init) → {status, headers, text()}.
// `script(body, n)` returns {status?, body?} for the n-th request (default: answer every question with `pick`).
function fakeTransport(script) {
  const t = { calls: [], bodies: [] };
  t.fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    t.calls.push({ url, headers: init.headers });
    t.bodies.push(body);
    const out = script(body, t.bodies.length) ?? {};
    const status = out.status ?? 200;
    const payload = out.body ?? { id: `gen-${t.bodies.length}`, model: "typesafe/jev-1.13-20260917", answers: out.answers, usage: { input_tokens: 400, output_tokens: 1, cost: 0.0000168 } };
    return { status, headers: { get: () => null }, text: async () => JSON.stringify(payload) };
  };
  return t;
}
const choice = (c, conf = 0.9) => ({ type: "choice", choice: c, confidence: conf });
const clientFor = (t, extra = {}) => createJevClient({ apiKey: KEY, fetchFn: t.fetchFn, maxRetries: 0, sleep: async () => {}, ...extra });

// ---------------------------------------------------------------------------
console.log("-- P1 room words -------------------------------------------------------------");

await check("P1 passRoomWord bands: <0 blocked, <0.5 tight, <1.5 comfortable, else wide open; non-finite → blocked", () => {
  assert.deepEqual(PASS_ROOM_WORDS, ["blocked", "tight", "comfortable", "wide open"]);
  assert.equal(passRoomWord(-0.01), "blocked");
  assert.equal(passRoomWord(0), "tight");
  assert.equal(passRoomWord(0.49), "tight");
  assert.equal(passRoomWord(0.5), "comfortable");
  assert.equal(passRoomWord(1.49), "comfortable");
  assert.equal(passRoomWord(1.5), "wide open");
  assert.equal(passRoomWord(null), "blocked");
  assert.equal(passRoomWord(Number.NaN), "blocked");
});

await check("P1 passWordsFor: DESIGN needs (side 1.9, over 1.2 + 0.4) → margins, words, phrases with metres", () => {
  assert.deepEqual(PASS_RULES, { sideNeedM: 1.9, overAboveTopM: 1.2, overBelowCeilM: 0.4 });
  const w = passWordsFor(C.ripperTunnel);
  assert.deepEqual(w.needs, { over: 1.6, left: 1.9, right: 1.9 });
  assert.deepEqual(w.margins, { over: 0.29, left: 0.1, right: 0.4 });
  assert.deepEqual(w.words, { over: "tight", left: "tight", right: "tight" });
  assert.equal(w.room.over, "tight (1.89 m headroom above its top, the pass needs 1.6 m)");
  assert.equal(w.room.left, "tight (2 m gap on its left, the pass needs 1.9 m)");
  // per-creature needs (the run raises 'below the ceiling' to its 0.9 m tunnel wall rule)
  const strict = passWordsFor({ ...C.ripperTunnel, needs: { over: 2.1 } });
  assert.equal(strict.words.over, "blocked");
  assert.equal(strict.needs.over, 2.1);
  // missing gap → blocked + "no … measured"
  const miss = passWordsFor({ gaps: { left: 3 } });
  assert.equal(miss.words.over, "blocked");
  assert.match(miss.room.right, /no gap on its right measured/);
  // rules override
  assert.equal(passWordsFor(C.slasherTunnel, { sideNeedM: 1.5 }).words.left, "tight");
});

// ---------------------------------------------------------------------------
console.log("-- P2 code rule ---------------------------------------------------------------");

await check("P2 codePass: allowed → variety → roomiest → next_turn → canonical order; squeeze when all blocked", () => {
  const W = (gaps, needs) => passWordsFor({ gaps, needs });
  // only one allowed
  assert.deepEqual(codePass(W(C.slasherRight.gaps)), { side: "right", rule: "only", allowed: ["right"] });
  // roomiest word wins: over 'tight' (0.4), left 'comfortable' (0.6), right 'wide open' (2.1)
  const graded = { over: 2.0, left: 2.5, right: 4.0 };
  assert.deepEqual(passWordsFor({ gaps: graded }).words, { over: "tight", left: "comfortable", right: "wide open" });
  assert.deepEqual(codePass(W(graded)), { side: "right", rule: "roomiest", allowed: ["over", "left", "right"] });
  // variety: previous 'right' removes it → left (comfortable) beats over (tight)
  const v = codePass(W(graded), "right");
  assert.equal(v.side, "left");
  assert.equal(v.rule, "variety");
  // equally roomy (over and right both 'wide open', left blocked): next_turn decides, else canonical order
  assert.equal(codePass(W(C.ripperRoom.gaps), null, "straight").side, "over");
  assert.equal(codePass(W(C.ripperRoom.gaps), null, "right").side, "right");
  assert.equal(codePass(W(C.ripperRoom.gaps), "over", "left").side, "right");
  // previous is the ONLY allowed option → repeat it
  assert.equal(codePass(W(C.slasherRight.gaps), "right").side, "right");
  // ties (all 'tight') → next_turn side, else canonical order
  assert.deepEqual(codePass(W(C.ripperTunnel.gaps), null, "right"), { side: "right", rule: "turn", allowed: ["over", "left", "right"] });
  assert.equal(codePass(W(C.ripperTunnel.gaps), null, "straight").side, "over");
  assert.equal(codePass(W(C.ripperTunnel.gaps), "over", "straight").side, "left");
  assert.equal(codePass(W(C.ripperTunnel.gaps), "over", "right").rule, "variety+turn");
  // squeeze: every option blocked → the largest margin
  const sq = codePass(W(C.slasherTunnel.gaps));
  assert.equal(sq.rule, "squeeze");
  assert.equal(sq.side, "over"); // over 1.4 − 1.6 = −0.2 ties right 1.7 − 1.9 = −0.2 (left −0.3): the canonical order breaks the tie
  assert.deepEqual(sq.allowed, []);
});

// ---------------------------------------------------------------------------
console.log("-- P3 request -----------------------------------------------------------------");

await check("P3 buildPassRequest: valid choice, code pick listed first, words in the state, rules in the instructions", () => {
  const c = normalizePassInput({ creatures: [C.ripperRoom] }).creatures[0];
  const req = buildPassRequest(c, "right");
  assert.ok(validateQuestions(req.questions).ok);
  assert.equal(req.code.side, "over");
  assert.deepEqual(req.order, ["over", "left", "right"]);
  assert.deepEqual(Object.keys(req.questions.pass.criteria), req.order);
  const g = normalizePassInput({ creatures: [{ name: "Olthoi Ripper", gaps: { over: 2.0, left: 2.5, right: 4.0 } }] }).creatures[0];
  const req2 = buildPassRequest(g, null);
  assert.equal(req2.code.side, "right");
  assert.deepEqual(Object.keys(req2.questions.pass.criteria), ["right", "over", "left"], "code pick (right) listed first");
  assert.equal(req.questions.pass.instructions, PASS_INSTRUCTIONS);
  for (const w of PASS_ROOM_WORDS) assert.ok(PASS_INSTRUCTIONS.includes(`'${w}'`), `instructions quote '${w}'`);
  assert.match(PASS_INSTRUCTIONS, /do not repeat previous_pass/);
  assert.match(PASS_INSTRUCTIONS, /next_turn/);
  assert.match(PASS_INSTRUCTIONS, /listed first/);
  for (const s of PASS_SIDES) assert.ok(req.questions.pass.criteria[s].includes(`room.${s} is 'blocked'`), `criteria for ${s} quote its room word`);
  assert.deepEqual(req.state.creature, { kind: "Olthoi Ripper", where: "room" });
  assert.equal(req.state.previous_pass, "right");
  assert.equal(req.state.next_turn, "left");
  assert.equal(req.state.room.right, "wide open (8 m gap on its right, the pass needs 1.9 m)");
  assert.equal(buildPassRequest(c, null).state.previous_pass, "none (first creature)");
});

// ---------------------------------------------------------------------------
console.log("-- P4 code plan ---------------------------------------------------------------");

const RUN = { creatures: [C.slasherTunnel, C.slasherRight, C.ripperTunnel, C.ripperRoom, C.ripperOpen] };

await check("P4 planPasses(null): code rule for every creature, previous chaining, counts, deterministic", async () => {
  const r = await planPasses(null, RUN);
  assert.equal(r.task, "pass-plan");
  assert.equal(r.source, "code");
  // slasherTunnel: all blocked → squeeze, over/right tie at −0.2 → 'over'; slasherRight: only right allowed;
  // ripperTunnel: all 'tight', variety drops right, over/left tie, next_turn 'right' not among them → 'over';
  // ripperRoom: left blocked, variety drops over → 'right'; ripperOpen: all 'wide open', variety drops right,
  // next_turn straight → 'over'.
  assert.deepEqual(r.passes.map((p) => p.side), ["over", "right", "over", "right", "over"]);
  assert.deepEqual(r.passes.map((p) => p.codeRule), ["squeeze", "only", "variety", "variety", "variety"]);
  assert.deepEqual(r.passes.map((p) => p.previous_pass), [null, "over", "right", "over", "right"]);
  assert.equal(r.passes[0].squeeze, true);
  assert.ok(r.warnings.some((w) => /squeeze/.test(w)));
  assert.deepEqual(r.counts, { over: 3, left: 0, right: 2 });
  assert.deepEqual(r.bySource, { jev: 0, code: 5 });
  assert.deepEqual(r.usage, { calls: 0, costUsd: 0 });
  for (const p of r.passes) {
    assert.equal(p.side, p.code);
    assert.equal(p.band, "confirm");
    assert.ok(p.words && p.margins && p.gaps && p.needs);
  }
  const again = await planPasses(null, RUN);
  assert.deepEqual(JSON.stringify(again), JSON.stringify(r));
  // previousPass input seeds the chain
  const seeded = await planPasses(null, { creatures: [C.ripperOpen], previousPass: "over" });
  assert.equal(seeded.passes[0].side, "left");
});

// ---------------------------------------------------------------------------
console.log("-- P5 JEV over a fake transport ---------------------------------------------");

await check("P5 real client + fake fetch: JEV picks honoured (a squeeze excepted), previous_pass = the side flown, usage summed, key never logged", async () => {
  // JEV answers: creature 1 'right' (not the code pick 'over'), 2 'right', 3 'left', 4 'over', 5 'left'.
  const picks = ["right", "right", "left", "over", "left"];
  const t = fakeTransport((body, n) => ({ answers: { pass: { type: "choice", choice: picks[n - 1], confidence: 0.86, probabilities: Object.fromEntries(Object.keys(body.questions.pass.criteria).map((k) => [k, k === picks[n - 1] ? 0.86 : 0.07])) } } }));
  const logs = [];
  const client = clientFor(t, { log: (e) => logs.push(e) });
  const taskLogs = [];
  const r = await planPasses(client, RUN, { log: (e) => taskLogs.push(e) });
  assert.equal(t.bodies.length, 5, "one decision per creature");
  for (const b of t.bodies) {
    assert.equal(b.model, "typesafe/jev-1.13");
    assert.deepEqual(Object.keys(b.questions), ["pass"]);
    assert.ok(validateQuestions(b.questions).ok);
  }
  assert.equal(t.calls[0].url, "https://openrouter.ai/api/alpha/decisions");
  // creature 1 is a squeeze (EVERY option blocked): the words cannot tell its sides apart, so the measured room
  // decides — the code pick 'over' is flown, JEV's 'right' is recorded (2026-10-15, Egg Orchard Slayer 0x1E4).
  assert.deepEqual(r.passes.map((p) => p.side), ["over", ...picks.slice(1)]);
  assert.deepEqual(r.passes.map((p) => p.source), ["code", "jev", "jev", "jev", "jev"]);
  assert.equal(r.passes[0].jevChoice, "right");
  assert.match(r.passes[0].guard, /squeeze: every option is 'blocked', so the measured room decides/);
  // previous_pass sent in request n is the side flown at n−1
  assert.deepEqual(t.bodies.map((b) => b.state.previous_pass), ["none (first creature)", "over", "right", "left", "over"]);
  assert.equal(r.source, "mixed");
  assert.equal(r.usage.calls, 5);
  assert.ok(Math.abs(r.usage.costUsd - 5 * 0.0000168) < 1e-12);
  assert.equal(r.passes[2].band, "act");
  assert.equal(r.passes[2].confidence, 0.86);
  assert.equal(taskLogs.filter((e) => e.event === "jev-task" && e.task === "planPasses").length, 5);
  const text = JSON.stringify(logs) + JSON.stringify(taskLogs);
  assert.ok(!text.includes(KEY), "key in a log");
  assert.ok(!text.includes("Olthoi"), "state in a log");
  assert.ok(t.calls.every((c) => c.headers.Authorization === `Bearer ${KEY}`));
});

await check("P6 guard: JEV picks a 'blocked' side while another is allowed → the code pick, band escalate, warning", async () => {
  const t = fakeTransport(() => ({ answers: { pass: choice("left", 0.95) } }));
  const r = await planPasses(clientFor(t), { creatures: [C.slasherRight, C.ripperOpen] });
  assert.equal(r.passes[0].side, "right"); // left is blocked (1.4 < 1.9), right is allowed
  assert.equal(r.passes[0].source, "code");
  assert.equal(r.passes[0].jevChoice, "left");
  assert.equal(r.passes[0].band, "escalate");
  assert.match(r.passes[0].guard, /JEV chose 'left' with room 'blocked'/);
  assert.equal(r.passes[1].side, "left"); // allowed → honoured
  assert.equal(r.passes[1].source, "jev");
  assert.equal(r.source, "mixed");
  assert.ok(r.warnings.some((w) => /slasher-350/.test(w)));
  // the request after the guard carries the GUARDED side as previous_pass
  assert.equal(t.bodies[1].state.previous_pass, "right");
});

await check("P7 failures: 500 → that creature uses the code pick; 401 → thrown; 3 failures in a row → no more calls", async () => {
  let t = fakeTransport((body, n) => (n === 2 ? { status: 500, body: { error: { code: 500, message: "upstream" } } } : { answers: { pass: choice(Object.keys(body.questions.pass.criteria)[1]) } }));
  let r = await planPasses(clientFor(t), RUN);
  assert.equal(r.passes[1].source, "code");
  assert.match(r.passes[1].jevError, /^server/);
  assert.equal(r.passes[1].side, r.passes[1].code);
  assert.equal(r.source, "mixed");
  assert.equal(r.usage.calls, 4);
  t = fakeTransport(() => ({ status: 401, body: { error: { code: 401, message: "no auth" } } }));
  await assert.rejects(planPasses(clientFor(t), RUN), (e) => e instanceof JevError && e.kind === "auth");
  t = fakeTransport(() => ({ status: 503, body: { error: { code: 503, message: "down" } } }));
  r = await planPasses(clientFor(t), RUN);
  assert.equal(t.bodies.length, 3, "stops calling after 3 failures in a row");
  assert.equal(r.source, "code");
  assert.deepEqual(r.passes.map((p) => p.side), (await planPasses(null, RUN)).passes.map((p) => p.side), "identical to the code plan");
  assert.ok(r.warnings.some((w) => /3 JEV failures in a row/.test(w)));
  assert.equal(r.passes[4].jevError, "skipped after repeated JEV failures");
  // a malformed answer (choice not offered) is a bad-response → code pick for that creature
  t = fakeTransport(() => ({ answers: { pass: choice("under") } }));
  r = await planPasses(clientFor(t), { creatures: [C.ripperOpen] });
  assert.equal(r.passes[0].source, "code");
  assert.match(r.passes[0].jevError, /^bad-response/);
});

await check("P8 batch: one call, one question per creature, previous_pass from the code chain, answers mapped", async () => {
  const t = fakeTransport((body) => ({ answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [id, choice(Object.keys(q.criteria)[0])])) }));
  const r = await planPasses(clientFor(t), { ...RUN, batch: true });
  assert.equal(t.bodies.length, 1);
  assert.deepEqual(Object.keys(t.bodies[0].questions), ["pass_1", "pass_2", "pass_3", "pass_4", "pass_5"]);
  assert.ok(validateQuestions(t.bodies[0].questions).ok);
  assert.match(t.bodies[0].questions.pass_3.instructions, /Judge only state\.creatures\.pass_3\./);
  assert.ok(t.bodies[0].questions.pass_3.criteria.over.includes("state.creatures.pass_3.room.over"));
  assert.equal(t.bodies[0].state.creatures.pass_2.previous_pass, "over");
  const code = await planPasses(null, RUN);
  assert.deepEqual(r.passes.map((p) => p.side), code.passes.map((p) => p.side), "first option = the code pick");
  assert.equal(r.source, "jev");
  assert.equal(r.usage.calls, 1);
  const req = buildPassBatchRequest(normalizePassInput(RUN).creatures, null);
  assert.deepEqual(req.items.map((i) => i.code.side), code.passes.map((p) => p.side));
});

// ---------------------------------------------------------------------------
console.log("-- P9 input / P10 CLI / P11 property ------------------------------------------");

await check("P9 normalizePassInput: bad input → JevError bad-request; defaults (ids, nextTurn, rules)", async () => {
  const bad = [
    null, {}, { creatures: [] }, { creatures: [{ gaps: { over: 1 } }] }, { creatures: [{ name: "x" }] },
    { creatures: [{ name: "x", gaps: { under: 1 } }] }, { creatures: [{ name: "x", gaps: { over: "high" } }] },
    { creatures: [{ name: "x", gaps: {}, nextTurn: "up" }] }, { creatures: [{ name: "x", gaps: {} }], previousPass: "under" },
    { creatures: [{ id: "a", name: "x", gaps: {} }, { id: "a", name: "y", gaps: {} }] },
    { creatures: [{ name: "x", gaps: {} }], rules: { sideNeedM: -1 } }, { creatures: [{ name: "x", gaps: {}, needs: { over: "x" } }] },
  ];
  for (const b of bad) assert.throws(() => normalizePassInput(b), (e) => e instanceof JevError && e.kind === "bad-request", JSON.stringify(b));
  await assert.rejects(planPasses(null, { creatures: [] }), (e) => e.kind === "bad-request");
  const n = normalizePassInput({ creatures: [{ name: " Olthoi Larvae ", gaps: { over: 8, left: null }, next_turn: "Left" }], rules: { sideNeedM: 2 } });
  assert.equal(n.creatures[0].id, "c1");
  assert.equal(n.creatures[0].name, "Olthoi Larvae");
  assert.equal(n.creatures[0].nextTurn, "left");
  assert.deepEqual(n.rules, { sideNeedM: 2, overAboveTopM: 1.2, overBelowCeilM: 0.4 });
});

await check("P10 PASS_PLAN_CLI: run = planPasses, input unwraps {passInput}, one-line text with counts and source", async () => {
  assert.equal(PASS_PLAN_CLI.run, planPasses);
  assert.deepEqual(PASS_PLAN_CLI.input({}, { passInput: RUN }), RUN);
  assert.deepEqual(PASS_PLAN_CLI.input({}, RUN), RUN);
  const r = await PASS_PLAN_CLI.run(null, PASS_PLAN_CLI.input({}, RUN));
  assert.match(PASS_PLAN_CLI.text(r), /^pass-plan: 5 creatures · over 3 · left 0 · right 2 · code/);
});

await check("P11 property: the code pick is the first listed option and never 'blocked' unless every option is", () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const turns = ["left", "right", "straight"];
  let prev = null;
  for (let k = 0; k < 500; k++) {
    const c = normalizePassInput({ creatures: [{ name: "Olthoi Ripper", gaps: { over: rnd() * 4, left: rnd() < 0.1 ? null : rnd() * 4, right: rnd() * 4 }, nextTurn: turns[k % 3] }] }).creatures[0];
    const req = buildPassRequest(c, prev);
    assert.equal(Object.keys(req.questions.pass.criteria)[0], req.code.side);
    const anyAllowed = PASS_SIDES.some((s) => req.words.margins[s] != null && req.words.margins[s] >= 0);
    if (anyAllowed) assert.ok(req.words.margins[req.code.side] >= 0, "an allowed option exists but the code pick is blocked");
    if (anyAllowed && req.code.allowed.length > 1 && prev) assert.notEqual(req.code.side, prev, "variety");
    prev = req.code.side;
  }
});

console.log(`\nfilm_jev_pass_plan: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
