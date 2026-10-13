// tests/rynth_vt_formats_comma.test.mjs — rynth/vt/formats/utl_eval.js reads a
// ',' in a .utl double as a decimal comma (WebAC comparison item
// rynth-formats-expr-2).
//
// VTank writes doubles with "G" (no group separators) and VTClassic's
// HaxConvertDouble (Constants.cs) turns ',' into '.' before parsing, so a
// comma-decimal locale's "0,95" means 0.95. The RynthAi port
// (VTankLootEvaluator.ReadDouble, NumberStyles.AllowThousands) dropped the
// comma and read 95: a DoubleValKeyGE rule never matched, a LE rule always did.
//
//   (a) rule `0;1;5` (DoubleValKeyGE) with data ["0,95", "5"] parsed from a v0
//       and a v1 .utl: keeps an item with float 5 = 0.96, null for 0.5; the
//       '.' spelling behaves identically; writeUtl is byte-identical (the data
//       string is kept verbatim);
//   (b) every double node (4, 5, 10, 2000, 2001, 2003, 2005, 2006, 2007) reads
//       "x,y" as x.y;
//   (c) "1,5" is 1.5 (not 15); two commas ("1,000,5") are not a number ⇒ the
//       rule does not match and is reported, never a throw.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_formats_comma.test.mjs

import assert from "node:assert/strict";

const F = await import("../rynth/vt/formats/index.js");
const { parseUtl, writeUtl, utlNodeType, utlLengthCode, evaluateUtl } = F;

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n       ") : e}`);
  }
}

// A minimal appraised UtlItemCtx (see tests/rynth_vt_formats_utl.test.mjs).
function item({ ints = {}, floats = {} } = {}) {
  return {
    name: "Thing",
    objectClass: 1,
    hasAppraisal: true,
    intProp: (id) => (id in ints ? ints[id] : null),
    floatProp: (id) => (id in floats ? floats[id] : null),
    strProp: () => null,
    boolProp: () => null,
    didProp: () => null,
    spellIds: () => [],
    charSkillBuffed: () => null,
    charSkillBase: () => null,
  };
}
const rule = (name, conditions) => ({ name, enabled: true, priority: 0, action: "Keep", conditions });
const node = (type, ...data) => ({ type, typeName: utlNodeType(type).name, data: data.map(String) });
const prof = (...rules) => ({ version: 1, rules });
const keeps = (n, it) => evaluateUtl(prof(rule("r", [n])), it).action === "keep";

const v0 = (val) => ["1", "Shiny", "0;1;5", val, "5", ""].join("\r\n");
const v1 = (val) => ["UTL", "1", "1", "Shiny", "", "0;1;5", String(utlLengthCode([val, "5"])), val, "5", ""].join("\r\n");

console.log("utl decimal comma");

await check("(a) v0 rule 0;1;5 with \"0,95\": keeps 0.96, null for 0.5, '.' identical, byte-stable", () => {
  for (const val of ["0,95", "0.95"]) {
    const text = v0(val);
    const r = parseUtl(text);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.warnings, []);
    const p = r.profile;
    assert.deepEqual(p.rules[0].conditions[0].data, [val, "5"], "data kept verbatim");
    const hi = evaluateUtl(p, item({ floats: { 5: 0.96 } }));
    assert.equal(hi.action, "keep", `${val}: 0.96 >= 0.95`);
    assert.equal(hi.rule, "Shiny");
    assert.equal(hi.unsupported, undefined);
    assert.equal(evaluateUtl(p, item({ floats: { 5: 0.5 } })).action, null, `${val}: 0.5 < 0.95`);
    assert.equal(evaluateUtl(p, item({ floats: { 5: 0.95 } })).action, "keep", `${val}: equal is >=`);
    assert.equal(writeUtl(p), text, `${val}: byte-identical`);
    assert.equal(writeUtl(JSON.parse(JSON.stringify(p))), text, `${val}: byte-identical after JSON`);
  }
});

await check("(a) v1 rule 0;1;5 with \"0,95\": same verdicts, byte-stable", () => {
  for (const val of ["0,95", "0.95"]) {
    const text = v1(val);
    const r = parseUtl(text);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.warnings, []);
    assert.equal(evaluateUtl(r.profile, item({ floats: { 5: 0.96 } })).action, "keep");
    assert.equal(evaluateUtl(r.profile, item({ floats: { 5: 0.5 } })).action, null);
    assert.equal(writeUtl(r.profile), text);
  }
});

await check("(b) every double node reads \"x,y\" as x.y", () => {
  const it = item({ ints: { 19: 100, 44: 40, 370: 1, 371: 2, 372: 0, 373: 0, 374: 3, 375: 0, 376: 0, 379: 4 }, floats: { 5: 0.8, 22: 0.5, 152: 1.25 } });
  // DoubleValKeyLE: the old 80 made LE always true.
  assert.equal(keeps(node(4, "0,8", 5), it), true);
  assert.equal(keeps(node(4, "0,79", 5), it), false, "0.8 <= 0.79 is false (old read 79)");
  // DoubleValKeyGE: the old 81 made GE never true.
  assert.equal(keeps(node(5, "0,8", 5), it), true, "0.8 >= 0.8 (old read 8)");
  assert.equal(keeps(node(5, "0,81", 5), it), false);
  // MinDamageGE: min = 40 − 0.5·40 = 20.
  assert.equal(keeps(node(10, "19,5"), it), true, "20 >= 19.5 (old read 195)");
  assert.equal(keeps(node(10, "20,5"), it), false);
  // BuffedMedianDamageGE (2000): (20+40)/2 = 30.
  assert.equal(keeps(node(2000, "29,9"), it), true, "30 >= 29.9 (old read 299)");
  assert.equal(keeps(node(2000, "30,1"), it), false);
  // BuffedMissileDamageGE (2001): 40 · 1.25 = 50.
  assert.equal(keeps(node(2001, "49,5"), it), true, "50 >= 49.5 (old read 495)");
  assert.equal(keeps(node(2001, "50,5"), it), false);
  // BuffedLongValKeyGE (2003): STypeInt 19 = 100.
  assert.equal(keeps(node(2003, "99,5", 19), it), true, "100 >= 99.5 (old read 995)");
  assert.equal(keeps(node(2003, "100,5", 19), it), false);
  // BuffedDoubleValKeyGE (2005): STypeFloat 152 = 1.25.
  assert.equal(keeps(node(2005, "1,2", 152), it), true, "1.25 >= 1.2 (old read 12)");
  assert.equal(keeps(node(2005, "1,3", 152), it), false);
  // CalcdBuffedTinkedDamageGE (2006): max damage STypeInt 44 = 40.
  assert.equal(keeps(node(2006, "39,5"), it), true, "40 >= 39.5 (old read 395)");
  assert.equal(keeps(node(2006, "40,5"), it), false);
  // TotalRatingsGE (2007): 1+2+3+4 = 10.
  assert.equal(keeps(node(2007, "9,5"), it), true, "10 >= 9.5 (old read 95)");
  assert.equal(keeps(node(2007, "10,5"), it), false);
});

await check("(b) the '.' spelling of the same thresholds is unchanged", () => {
  const it = item({ ints: { 19: 100, 44: 40 }, floats: { 5: 0.8, 22: 0.5, 152: 1.25 } });
  assert.equal(keeps(node(4, "0.8", 5), it), true);
  assert.equal(keeps(node(4, "0.79", 5), it), false);
  assert.equal(keeps(node(5, "0.8", 5), it), true);
  assert.equal(keeps(node(5, "0.81", 5), it), false);
  assert.equal(keeps(node(10, "19.5"), it), true);
  assert.equal(keeps(node(2005, "1.2", 152), it), true);
  assert.equal(keeps(node(2006, " 40 "), it), true, "surrounding blanks trimmed");
});

await check("(c) \"1,5\" is 1.5; \"1,000,5\" is not a number ⇒ rule does not match, reported, no throw", () => {
  const it = item({ floats: { 5: 5 } });
  assert.equal(keeps(node(4, "1,5", 5), it), false, "5 <= 1.5 is false (old read 15 ⇒ true)");
  assert.equal(keeps(node(5, "1,5", 5), it), true, "5 >= 1.5");
  const bad = evaluateUtl(prof(rule("grouped", [node(4, "1,000,5", 5)])), it);
  assert.equal(bad.action, null);
  assert.ok(Array.isArray(bad.unsupported) && bad.unsupported.some((s) => /grouped/.test(s) && /is not a number/.test(s)), JSON.stringify(bad.unsupported));
  // A later rule still decides.
  const next = evaluateUtl(prof(rule("grouped", [node(4, "1,000,5", 5)]), rule("fallback", [node(5, "4,5", 5)])), it);
  assert.equal(next.action, "keep");
  assert.equal(next.rule, "fallback");
  // An empty or comma-only value stays unparseable.
  assert.equal(evaluateUtl(prof(rule("empty", [node(5, "", 5)])), it).action, null);
  assert.equal(evaluateUtl(prof(rule("comma", [node(5, ",", 5)])), it).action, null);
});

console.log(fail === 0 ? `rynth_vt_formats_comma: all ${pass} checks passed` : `rynth_vt_formats_comma: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
