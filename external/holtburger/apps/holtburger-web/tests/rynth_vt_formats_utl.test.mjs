// tests/rynth_vt_formats_utl.test.mjs — rynth/vt/formats utl.js + utl_eval.js
// (W1-3 FMT, PLAN §3.6, §2.2 P8; U7a §5.9).
//
//   * the 31 node types (ids, arities — VTankNodeTypes.cs);
//   * v1 corpus fixtures (rynth/testdata/vt/loot, copies of CORPUS) and a
//     synthetic v0 file: parse, KeepUpTo counts, DisabledRule ⇒ enabled,
//     SalvageCombine, byte-stable round trips (also after JSON);
//   * length codes recomputed on edit, enabled ↔ DisabledRule reconciliation,
//     truncated files / stale rule counts kept byte-stable with warnings;
//   * evaluateUtl: every evaluable node, `pending` for appraisal-gated nodes
//     on an unappraised item, first-not-false rule decides, unsupported
//     reporting, injected getRegex;
//   * lootVerdict mapping incl. KeepUpTo against the inventory count;
//   * newUtlProfile + validateUtl (bad node id / wrong arity rejected) and a
//     profile built in code round-tripping through writeUtl / parseUtl.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_formats_utl.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const FIX = path.join(APP, "rynth", "testdata", "vt", "loot");

const F = await import("../rynth/vt/formats/index.js");
const { parseUtl, writeUtl, UTL_NODE_TYPES, utlNodeType, utlLengthCode, newUtlProfile, validateUtl, evaluateUtl, lootVerdict } = F;

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
const readFix = (n) => fs.readFileSync(path.join(FIX, n), "utf8");
const AUN = "Aun_Amanaualuan_the_Elder_Shaman-3d8a214f11b3acbf.utl";
const DQL = "RynDQLLootProfile-b0afe37e9d557746.utl";
const V0 = "synthetic_v0.utl";
const strip = (p) => JSON.parse(JSON.stringify(p, (k, v) => (k === "_fmt" ? undefined : v)));

// A fake UtlItemCtx (PLAN §3.6): maps of known properties; anything absent is
// unknown (null) — the evaluator turns that into `pending` until appraised.
function item({ name = "Thing", objectClass = 1, hasAppraisal = true, ints = {}, floats = {}, strs = {}, spells = null, names = null, skills = {}, base = {}, level, slots, palettes } = {}) {
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
  if (names !== undefined && names !== null) it.spellNames = () => names;
  if (level !== undefined) it.charLevel = () => level;
  if (slots !== undefined) it.charPackSlotsFree = () => slots;
  if (palettes !== undefined) it.palettes = () => palettes;
  return it;
}
const rule = (name, action, conditions, extra = {}) => ({ name, enabled: true, priority: 0, action, conditions, ...extra });
const node = (type, ...data) => ({ type, typeName: utlNodeType(type).name, data: data.map(String) });
const prof = (...rules) => ({ version: 1, rules });

// ── node types ─────────────────────────────────────────────────────────────
console.log("utl format");

await check("31 node types with VTank ids and arities", () => {
  assert.equal(UTL_NODE_TYPES.length, 31);
  const want = { 0: 1, 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 1, 7: 1, 8: 1, 9: 3, 10: 1, 11: 2, 12: 2, 13: 2, 14: 5, 15: 6, 16: 6, 17: 2, 1000: 2, 1001: 1, 1002: 1, 1003: 1, 1004: 3, 2000: 1, 2001: 1, 2003: 2, 2005: 2, 2006: 1, 2007: 1, 2008: 3, 9999: 1 };
  assert.deepEqual(Object.fromEntries(UTL_NODE_TYPES.map((n) => [n.id, n.arity])), want);
  assert.equal(new Set(UTL_NODE_TYPES.map((n) => n.name)).size, 31);
  for (const n of UTL_NODE_TYPES) assert.equal(n.fields.length, n.arity, n.name);
  assert.equal(utlNodeType(1004).name, "CharacterBaseSkill");
  assert.equal(utlNodeType(42), null);
});

await check("v1 fixture: KeepUpTo counts, SalvageCombine, custom-expression line", () => {
  const r = parseUtl(readFix(AUN));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.warnings, []);
  const p = r.profile;
  assert.equal(p.version, 1);
  assert.equal(p.rules.length, 3);
  assert.deepEqual(
    p.rules.map((x) => [x.name, x.action, x.keepCount, x.customExpr]),
    [
      ["B: Prismatic Taper", "KeepUpTo", 10000, ""],
      ["B: Platinum Scarab ", "KeepUpTo", 100, ""],
      ["B: Mana Scarab ", "KeepUpTo", 100, ""],
    ],
  );
  assert.deepEqual(p.rules[0].conditions, [{ type: 1, typeName: "StringValueMatch", data: ["Prismatic Taper", "1"] }]);
  assert.deepEqual(p.salvageCombine, { version: "11", enabled: true, defaultBands: "", materials: [] });
});

await check("v1 fixture: DisabledRule (9999 true) ⇒ enabled:false; Decal keys passed through", () => {
  const p = parseUtl(readFix(DQL)).profile;
  assert.equal(p.rules.length, 10);
  const tab = p.rules.find((x) => x.name === "(T) Stone Tablet");
  assert.equal(tab.enabled, false);
  assert.deepEqual(tab.conditions.map((c) => c.type), [1, 9999]);
  assert.ok(p.rules.filter((x) => x !== tab).every((x) => x.enabled === true));
  assert.deepEqual(p.rules[0].conditions[0], { type: 12, typeName: "LongValKeyE", data: ["23308", "218103850"] });
  assert.equal(p.salvageCombine.materials.length, 25);
  assert.deepEqual(p.salvageCombine.materials[0], { material: 10, bands: "1-10" });
});

await check("synthetic v0 (headerless) file", () => {
  const r = parseUtl(readFix(V0));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.warnings, []);
  const p = r.profile;
  assert.equal(p.version, 0);
  assert.deepEqual(strip(p), {
    version: 0,
    rules: [
      { name: "Trade Notes", enabled: true, priority: 0, action: "Keep", conditions: [{ type: 7, typeName: "ObjectClass", data: ["15"] }, { type: 12, typeName: "LongValKeyE", data: ["250000", "19"] }] },
      { name: "Keep 5 Scarabs", enabled: true, priority: 2, action: "KeepUpTo", keepCount: 5, conditions: [{ type: 1, typeName: "StringValueMatch", data: ["Mana Scarab", "1"] }] },
      { name: "Disabled junk", enabled: false, priority: 0, action: "Sell", conditions: [{ type: 9999, typeName: "DisabledRule", data: ["true"] }] },
    ],
  });
});

await check("round trip is byte-stable for every fixture (also after JSON persistence)", () => {
  for (const f of [AUN, DQL, V0]) {
    const t = readFix(f);
    const p = parseUtl(t).profile;
    assert.equal(writeUtl(p), t, f);
    assert.equal(writeUtl(JSON.parse(JSON.stringify(p))), t, `${f} after JSON`);
  }
});

await check("length codes are recomputed (UTF-8 bytes + CRLF per data line) when data is edited", () => {
  assert.equal(utlLengthCode(["31"]), 4);
  assert.equal(utlLengthCode(["250000", "19"]), 12);
  assert.equal(utlLengthCode(["true"]), 6);
  assert.equal(utlLengthCode(["Ü"]), 4, "bytes, not characters");
  const p = parseUtl(readFix(AUN)).profile;
  p.rules[0].conditions[0].data[0] = "Prismatic Taperz|Ink";
  const t = writeUtl(p);
  assert.ok(t.includes(`0;10;1\r\n10000\r\n${"Prismatic Taperz|Ink".length + 2 + 3}\r\nPrismatic Taperz|Ink\r\n1\r\n`), t.slice(0, 120));
  assert.equal(parseUtl(t).profile.rules[0].conditions[0].data[0], "Prismatic Taperz|Ink");
});

await check("enabled ↔ DisabledRule node: disabling adds 9999 true, enabling removes it", () => {
  const p = parseUtl(readFix(DQL)).profile;
  const i = p.rules.findIndex((x) => x.name === "(T) Stone Tablet");
  p.rules[i].enabled = true;
  p.rules[0].enabled = false;
  const back = parseUtl(writeUtl(p)).profile;
  assert.equal(back.rules[i].enabled, true);
  assert.deepEqual(back.rules[i].conditions.map((c) => c.type), [1], "9999 removed");
  assert.equal(back.rules[0].enabled, false);
  assert.deepEqual(back.rules[0].conditions.map((c) => [c.type, c.data]), [[12, ["23308", "218103850"]], [9999, ["true"]]]);
});

await check("truncated file / stale rule count: warnings, rules kept, lines kept, byte-stable", () => {
  const trunc = "UTL\r\n1\r\n3\r\nOne\r\n\r\n0;1;7\r\n4\r\n31\r\nTwo\r\n\r\n0;1;7\r\n4\r\n";
  const r = parseUtl(trunc);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.profile.rules.length, 1);
  assert.ok(r.warnings.some((w) => w.includes("ends inside this rule")));
  assert.ok(r.warnings.some((w) => w.includes("rule count says 3")));
  assert.equal(writeUtl(r.profile), trunc);
  const p = r.profile;
  p.rules.push(rule("New", "Keep", [node(7, 31)]));
  assert.ok(writeUtl(p).startsWith("UTL\r\n1\r\n2\r\n"), "an edited rule list writes the true count");
  const stale = "UTL\r\n1\r\n1\r\nA\r\n\r\n0;1;7\r\n4\r\n31\r\nB\r\n\r\n0;1;7\r\n4\r\n15\r\nSalvageCombine\r\n11\r\n1\r\n\r\n0\r\n0\r\n";
  const s = parseUtl(stale);
  assert.equal(s.profile.rules.length, 1, "VTank reads the header count");
  assert.ok(s.warnings.some((w) => w.includes("after the last counted rule")));
  assert.deepEqual(s.profile.salvageCombine, { version: "11", enabled: true, defaultBands: "", materials: [] });
  assert.equal(writeUtl(s.profile), stale);
  s.profile.salvageCombine.enabled = false;
  assert.ok(writeUtl(s.profile).endsWith("SalvageCombine\r\n11\r\n0\r\n\r\n0\r\n0\r\n"), "edited SalvageCombine re-emitted canonically");
});

await check("bad input ⇒ { ok:false, error }", () => {
  for (const bad of ["", "UTL\r\nx\r\n1\r\n", "UTL\r\n1\r\n-3\r\n", "hello world\r\n", null, 7]) {
    const r = parseUtl(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(typeof r.error, "string");
  }
  const unk = parseUtl("UTL\r\n1\r\n1\r\nOdd\r\n\r\n0;1;77\r\n9\r\nabc\r\nde\r\n");
  assert.equal(unk.ok, true, unk.error);
  assert.deepEqual(unk.profile.rules[0].conditions, [{ type: 77, typeName: "Unknown(77)", data: ["abc", "de"] }], "unknown node reads exactly lengthCode bytes");
  assert.ok(unk.warnings.some((w) => w.includes("unknown node type 77")));
  assert.equal(writeUtl(unk.profile), "UTL\r\n1\r\n1\r\nOdd\r\n\r\n0;1;77\r\n9\r\nabc\r\nde\r\n");
});

// ── evaluation ─────────────────────────────────────────────────────────────
console.log("utl_eval");

await check("KeepUpTo: action + keepCount; lootVerdict compares the inventory count", () => {
  const p = parseUtl(readFix(AUN)).profile;
  const res = evaluateUtl(p, item({ name: "Mana Scarab", hasAppraisal: false }));
  assert.deepEqual(res, { action: "keepUpTo", rule: "B: Mana Scarab ", keepCount: 100 });
  assert.equal(lootVerdict(res, { inventoryCount: () => 99 }), "pickup");
  assert.equal(lootVerdict(res, { inventoryCount: () => 100 }), "skip");
  let asked = null;
  lootVerdict(res, { inventoryCount: (r) => ((asked = r), 0) });
  assert.equal(asked, "B: Mana Scarab ", "counted per rule name");
  assert.equal(lootVerdict(res, {}), "pickup", "no counter ⇒ 0 held");
  assert.deepEqual(evaluateUtl(p, item({ name: "Pyreal" })), { action: null });
});

await check("lootVerdict mapping: keep/salvage/sell/read → pickup, no match → skip, pending → pending", () => {
  for (const a of ["keep", "salvage", "sell", "read"]) assert.equal(lootVerdict({ action: a, rule: "x" }, {}), "pickup", a);
  assert.equal(lootVerdict({ action: null }, {}), "skip");
  assert.equal(lootVerdict({ action: null, pending: true }, {}), "pending");
  assert.equal(lootVerdict(null, {}), "skip");
  const p = prof(rule("s", "Salvage", [node(7, 1)]), rule("x", "Sell", [node(7, 2)]), rule("r", "Read", [node(7, 3)]));
  assert.equal(evaluateUtl(p, item({ objectClass: 1 })).action, "salvage");
  assert.equal(evaluateUtl(p, item({ objectClass: 2 })).action, "sell");
  assert.equal(evaluateUtl(p, item({ objectClass: 3 })).action, "read");
});

await check("pending: appraisal-gated nodes on an unappraised item; defaults once appraised", () => {
  const p = prof(rule("Good armor", "Keep", [node(7, 2), node(3, 300, 28)]));
  const un = item({ objectClass: 2, hasAppraisal: false });
  assert.deepEqual(evaluateUtl(p, un), { action: null, pending: true, rule: "Good armor" });
  assert.equal(lootVerdict(evaluateUtl(p, un), {}), "pending");
  // a definite false elsewhere in the rule wins over pending
  assert.deepEqual(evaluateUtl(p, item({ objectClass: 9, hasAppraisal: false })), { action: null });
  // appraised: the value decides; an absent property reads 0
  assert.equal(evaluateUtl(p, item({ objectClass: 2, ints: { 28: 350 } })).action, "keep");
  assert.equal(evaluateUtl(p, item({ objectClass: 2, ints: {} })).action, null);
  // values known before the appraisal are not pending (name via key 1, objectClass, a known int)
  assert.equal(evaluateUtl(prof(rule("n", "Keep", [node(1, "^Pyreal", 1)])), item({ name: "Pyreal Sliver", hasAppraisal: false })).action, "keep");
  assert.equal(evaluateUtl(prof(rule("v", "Keep", [node(3, 5000, 19)])), item({ hasAppraisal: false, ints: { 19: 6000 } })).action, "keep");
  // the first rule that is not definitely false decides
  const two = prof(rule("first", "Sell", [node(3, 1, 28)]), rule("second", "Keep", [node(7, 2)]));
  assert.equal(evaluateUtl(two, item({ objectClass: 2, hasAppraisal: false })).pending, true);
  assert.equal(evaluateUtl(two, item({ objectClass: 2, hasAppraisal: true })).rule, "second");
});

await check("long/double/flag/spell/damage/rating/character nodes", () => {
  const ev = (n, it) => evaluateUtl(prof(rule("r", "Keep", [n])), it).action === "keep";
  const it = item({ ints: { 19: 100, 28: 7, 44: 40, 370: 1, 371: 2, 372: 0, 373: 0, 374: 3, 375: 0, 376: 0, 379: 4 }, floats: { 22: 0.5, 152: 1.25, 5: 0.8 }, strs: { 16: "Imbued with fire" }, spells: [1, 2, 3], names: ["Legendary Strength", "Epic Focus", "Minor Strength"] });
  assert.equal(ev(node(2, 100, 19), it), true);
  assert.equal(ev(node(2, 99, 19), it), false);
  assert.equal(ev(node(3, 100, 19), it), true);
  assert.equal(ev(node(12, 100, 19), it), true);
  assert.equal(ev(node(13, 100, 19), it), false);
  assert.equal(ev(node(11, 4, 28), it), true, "7 & 4");
  assert.equal(ev(node(11, 8, 28), it), false);
  assert.equal(ev(node(4, 0.8, 5), it), true);
  assert.equal(ev(node(5, 0.81, 5), it), false);
  assert.equal(ev(node(1, "fire", 16), it), true, "case-insensitive .NET regex");
  assert.equal(ev(node(8, 3), it), true);
  assert.equal(ev(node(8, 4), it), false);
  assert.equal(ev(node(0, "^legendary"), it), true);
  assert.equal(ev(node(9, "strength", "^minor", 1), it), true);
  assert.equal(ev(node(9, "strength", "^minor", 2), it), false, "the negative regex excludes Minor");
  assert.equal(ev(node(10, 20), it), true, "min = 40 − 0.5·40 = 20");
  assert.equal(ev(node(10, 21), it), false);
  assert.equal(ev(node(2000, 30), it), true, "median (20+40)/2");
  assert.equal(ev(node(2001, 50), it), true, "40 · 1.25");
  assert.equal(ev(node(2006, 40), it), true, "max damage = STypeInt 44");
  assert.equal(ev(node(2007, 10), it), true, "1+2+3+4");
  assert.equal(ev(node(2007, 11), it), false);
  assert.equal(ev(node(2003, 99.5, 19), it), true);
  assert.equal(ev(node(2005, 1.2, 152), it), true);
  const ch = item({ skills: { 33: 400 }, base: { 33: 250 }, level: 180, slots: 12 });
  assert.equal(ev(node(1000, 400, 33), ch), true);
  assert.equal(ev(node(1000, 401, 33), ch), false);
  assert.equal(ev(node(1004, 33, 200, 300), ch), true);
  assert.equal(ev(node(1004, 33, 260, 300), ch), false);
  assert.equal(ev(node(1002, 180), ch), true);
  assert.equal(ev(node(1003, 179), ch), false);
  assert.equal(ev(node(1001, 12), ch), true);
  assert.equal(ev(node(9999, "false"), ch), true);
  assert.equal(ev(node(17, 1, 0x1234), item({ palettes: [0x10, 0xff001234] })), true);
  assert.equal(ev(node(17, 5, 0x1234), item({ palettes: [0x10] })), false);
});

await check("C# fidelity + unsupported reporting (colours optimistic, DamagePercent false, bad data, unknown node, custom expr)", () => {
  const r1 = evaluateUtl(prof(rule("c", "Keep", [node(14, 1, 2, 3, 4, 5)])), item());
  assert.equal(r1.action, "keep");
  assert.ok(r1.unsupported.some((u) => u.includes("AnySimilarColor")));
  const r2 = evaluateUtl(prof(rule("d", "Keep", [node(6, 10)]), rule("t", "Sell", [node(2008, 1, 2, 3)]), rule("e", "Read", [])), item());
  assert.equal(r2.action, "read", "no conditions ⇒ matches");
  assert.equal(r2.unsupported.length, 2);
  const r3 = evaluateUtl(prof(rule("bad", "Keep", [node(2, "lots", 19)]), rule("unk", "Keep", [{ type: 77, typeName: "Unknown(77)", data: [] }]), rule("ok", "Sell", [node(7, 1)])), item());
  assert.equal(r3.action, "sell");
  assert.ok(r3.unsupported.some((u) => u.includes("is not an integer")));
  assert.ok(r3.unsupported.some((u) => u.includes("unknown node type 77")));
  const r4 = evaluateUtl(prof(rule("x", "Keep", [], { customExpr: "foo[]" })), item());
  assert.deepEqual(r4.unsupported, ["CustomExpression (ignored)"]);
  const r5 = evaluateUtl(prof(rule("rx", "Keep", [node(1, "([bad", 1)]), rule("ok", "Sell", [])), item({ name: "x" }));
  assert.equal(r5.action, "sell");
  assert.ok(r5.unsupported.some((u) => u.includes("bad regular expression")));
  // spell-name nodes without the spellNames capability: optimistic (C# with no host)
  const r6 = evaluateUtl(prof(rule("s", "Keep", [node(0, "x")])), item());
  assert.equal(r6.action, "keep");
  assert.ok(r6.unsupported[0].includes("SpellNameMatch"));
  // disabled rules never match
  assert.equal(evaluateUtl(prof(rule("off", "Keep", [], { enabled: false })), item()).action, null);
});

await check("an injected getRegex (EXPR translator) is used, case-insensitively", () => {
  const seen = [];
  const getRegex = (p, flags) => {
    seen.push([p, flags]);
    return new RegExp(p.replace("(?i)", ""), flags);
  };
  const r = evaluateUtl(prof(rule("n", "Keep", [node(1, "(?i)taper", 1)])), item({ name: "Prismatic TAPER" }), { getRegex });
  assert.equal(r.action, "keep");
  assert.deepEqual(seen, [["(?i)taper", "i"]]);
});

// ── editor support ─────────────────────────────────────────────────────────
console.log("editor");

await check("newUtlProfile + validateUtl: bad node id / wrong arity / bad action rejected", () => {
  const p = newUtlProfile();
  assert.deepEqual(p, { version: 1, rules: [] });
  assert.deepEqual(validateUtl(p), { ok: true, errors: [] });
  p.rules.push(rule("ok", "KeepUpTo", [node(1, "x", 1)], { keepCount: 3 }));
  assert.equal(validateUtl(p).ok, true);
  p.rules.push(rule("bad id", "Keep", [{ type: 42, data: ["1"] }]));
  p.rules.push(rule("arity", "Keep", [{ type: 2, data: ["1"] }]));
  p.rules.push(rule("act", "Explode", []));
  p.rules.push(rule("kc", "KeepUpTo", []));
  p.rules.push(rule("nl", "Keep", [{ type: 7, data: ["1\n2"] }]));
  const v = validateUtl(p);
  assert.equal(v.ok, false);
  const t = v.errors.join("\n");
  for (const want of ["unknown node type 42", "LongValKeyLE takes 2 data line(s), has 1", 'unknown action "Explode"', "KeepUpTo needs a keepCount", "single lines"]) assert.ok(t.includes(want), `${want}\n${t}`);
  assert.equal(validateUtl({ version: 3, rules: [] }).ok, false);
  assert.equal(validateUtl({ version: 0, rules: [rule("x", "Keep", [], { customExpr: "a" })] }).ok, false, "v0 cannot hold a custom expression");
});

await check("a profile built in code round-trips through writeUtl / parseUtl", () => {
  const p = newUtlProfile();
  p.rules.push(rule("Trade notes", "Keep", [node(7, 15), node(12, 250000, 19)], { customExpr: "" }));
  p.rules.push(rule("Scarabs ≤ 5", "KeepUpTo", [node(1, "Mana Scarab", 1)], { keepCount: 5, priority: 2 }));
  p.rules.push(rule("Off", "Sell", [node(3, 1000, 19)], { enabled: false }));
  p.salvageCombine = { version: "11", enabled: true, defaultBands: "1-6, 7-8", materials: [{ material: 25, bands: "1-10" }] };
  assert.equal(validateUtl(p).ok, true);
  const text = writeUtl(p);
  assert.ok(text.startsWith("UTL\r\n1\r\n3\r\nTrade notes\r\n\r\n0;1;7;12\r\n4\r\n15\r\n12\r\n250000\r\n19\r\n"), text.slice(0, 80));
  assert.ok(text.endsWith("SalvageCombine\r\n11\r\n1\r\n1-6, 7-8\r\n1\r\n25\r\n1-10\r\n0\r\n"));
  const back = parseUtl(text);
  assert.equal(back.ok, true, back.error);
  assert.deepEqual(back.warnings, []);
  const want = strip(p);
  want.rules[1].customExpr = "";
  want.rules[2].customExpr = "";
  want.rules[2].conditions.push({ type: 9999, typeName: "DisabledRule", data: ["true"] });
  assert.deepEqual(strip(back.profile), want);
  assert.equal(writeUtl(back.profile), text, "stable from then on");
  // v0 profiles write the headerless form
  const v0 = { version: 0, rules: [rule("A", "Keep", [node(7, 1)])] };
  assert.equal(writeUtl(v0), "1\r\nA\r\n0;1;7\r\n1\r\n");
});

console.log(fail === 0 ? `rynth_vt_formats_utl: all ${pass} checks passed` : `rynth_vt_formats_utl: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
