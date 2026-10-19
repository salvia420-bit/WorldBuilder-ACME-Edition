// tests/rynth_vt_formats_usd.test.mjs — rynth/vt/formats/usd.js: VirindiTank
// settings profiles (`.usd`) read and imported into a NEW user profile
// (WebAC comparison item rynth-formats-expr-5; format after WebAC
// vtankUsd.ts / docs/vtank-formats.md §6, AGPL-3.0).
//
//   (a) the synthetic fixture tests/fixtures/rynth_vt_synthetic.usd (CRLF;
//       Settings with bool / double / int / string / enum rows, an unknown
//       name and a nested RechargeHandlerSet TABLE; MyMonsters with <DEFAULT>,
//       a named and an expression row; AssistItems, BuffedItems,
//       ExtraBuffSpells, a kept SettingsCategories) parses to the documented
//       shape; every MyMonsters switch lands on a MONSTER_COLUMNS letter;
//   (b) robustness: text = bytes = BOM = bare-LF copy; `b` in any case; a bad
//       `b`, a .met file, a nesting bomb, a huge row count and EVERY truncation
//       of the fixture are { ok:false } (never a throw); `ba` counts CRLF
//       characters in an LF copy; a decimal comma reads as '.';
//   (c) importUsdProfile on a real VtOptions + ProfileStore: refused for
//       Default / [By char] / an existing name / a bad name / a bad file with
//       nothing changed; otherwise a new shared ([Char] with mineOnly) profile
//       is selected, Settings applied by VTank name (AttackDistance 0.0833 ⇒
//       MonsterRange 20 m, DoorOpenRange ⇒ 6 m), clamps and unknown names
//       reported, the Monsters list stored through the MonsterList validator,
//       the Default overlay untouched;
//   (d) WebAC's own hunter.usd (read from /mnt/wbterminal1/ac-refs/webac when
//       present, skipped otherwise) parses and imports;
//   (e) the layer: library.importUsd pushes the imported values into the live
//       loops and the layer's MonsterList; Default is refused.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_formats_usd.test.mjs

import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HW = path.resolve(HERE, "..");

const F = await import("../rynth/vt/formats/index.js");
const { parseUsd, importUsdProfile, USD_MONSTER_SWITCHES } = F;
const S = await import("../rynth/vt/settings/index.js");
const { ProfileStore, createVtOptions, SHARED_PREFIX, charPrefix } = S;
const CMB = await import("../rynth/vt/combat/index.js");
const { normalizeEntry, MonsterList, MONSTER_COLUMNS, DEFAULT_ENTRY } = CMB;
const VT = await import("../rynth/vt/index.js");

let pass = 0;
let fail = 0;
let skipped = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 5).join("\n       ") : e}`);
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const quiet = () => {};
const FIXTURE = path.join(HERE, "fixtures", "rynth_vt_synthetic.usd");
const HUNTER = "/mnt/wbterminal1/ac-refs/webac/tests/fixtures/vtank/hunter.usd";
const fixture = () => new Uint8Array(readFileSync(FIXTURE));
const toLf = (b) => enc.encode(dec.decode(b).replace(/\r\n/g, "\n"));
const crlf = (lines) => enc.encode(lines.map((l) => `${l}\r\n`).join(""));

const W1 = 0x8000abcd; // -2147439667 as written (an object id)
const W2 = 0x8000abce; // -2147439666

let T = 1_800_000_000_000;
const now = () => T;

function spyStorage() {
  const m = new Map();
  const s = {
    m,
    writes: [],
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem(k, v) {
      s.writes.push(k);
      m.set(k, String(v));
    },
    removeItem(k) {
      s.writes.push(`-${k}`);
      m.delete(k);
    },
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
  return s;
}

function mkOptions() {
  const storage = spyStorage();
  const profiles = new ProfileStore({ storage, scope: "1342177281", charName: "Tester", now, log: quiet });
  const options = createVtOptions({ profiles, now, log: quiet });
  return { storage, profiles, options };
}

console.log("rynth_vt_formats_usd");

// ── (a) the parse shape ─────────────────────────────────────────────────────

await check("(a) synthetic fixture: tables in file order, index flags, kept SettingsCategories", () => {
  const r = parseUsd(fixture());
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.tables.map((t) => t.name), ["AssistItems", "BuffedItems", "ExtraBuffSpells", "MyMonsters", "Settings", "SettingsCategories"]);
  const mm = r.tables.find((t) => t.name === "MyMonsters");
  assert.equal(mm.cols.length, 21);
  assert.deepEqual(mm.index, [true, ...Array(20).fill(false)]);
  assert.deepEqual(r.tables.find((t) => t.name === "Settings").index, [true, false, false, false]);
  const sc = r.tables.find((t) => t.name === "SettingsCategories");
  assert.deepEqual(sc.rows, [[{ t: "s", v: "EnableCombat" }, { t: "i", v: 12 }]]);
});

await check("(a) Settings rows: { vtName, t, value, type } for bool / double / int / string / enum / nested TABLE", () => {
  const r = parseUsd(fixture());
  const by = Object.fromEntries(r.settings.map((s) => [s.vtName, s]));
  assert.equal(r.settings.length, 9);
  assert.deepEqual(by.EnableCombat, { vtName: "EnableCombat", t: "b", value: false, type: 1 });
  assert.equal(by.AttackDistance.t, "d");
  assert.ok(Math.abs(by.AttackDistance.value - 1 / 12) < 1e-12);
  assert.equal(by.AttackDistance.type, 2);
  assert.deepEqual(by["Recharge-Norm-HitP"], { vtName: "Recharge-Norm-HitP", t: "i", value: 70, type: 3 });
  assert.deepEqual(by.BuffProfile_Banes, { vtName: "BuffProfile_Banes", t: "s", value: "Banes1", type: 5 });
  assert.deepEqual(by.AttackHeight, { vtName: "AttackHeight", t: "i", value: 3, type: 6 });
  const rh = by.RechargeHandlerSet;
  assert.equal(rh.t, "table");
  assert.equal(rh.type, 7);
  assert.deepEqual(rh.value.cols, ["Vital", "HandlerString", "MinPercent", "MaxPercent", "Stance"]);
  assert.deepEqual(rh.value.rows, [[{ t: "i", v: 1 }, { t: "s", v: "Kit Recharge" }, { t: "i", v: 0 }, { t: "i", v: 100 }, { t: "i", v: 1 }]]);
});

await check("(a) MyMonsters → MonsterList entries: <DEFAULT> ⇒ DEFAULT, switches ⇒ letters, VT elements, -1/0 ⇒ Auto, ids kept", () => {
  const r = parseUsd(fixture());
  assert.equal(r.monsters.length, 3);
  const [def, drudge, expr] = r.monsters;
  assert.equal(def.text, "DEFAULT");
  assert.equal(def.A, true);
  assert.equal(def.S, true);
  assert.deepEqual([def.damageType, def.exVuln, def.petDmg, def.weapon, def.offhand], ["Auto", "None", "PAuto", 0, 0]);
  assert.equal(drudge.text, "Drudge Skulker");
  assert.equal(drudge.priority, 3);
  const on = (e) => MONSTER_COLUMNS.filter((c) => e[c] === true);
  assert.deepEqual(on(drudge).sort(), ["A", "Cs", "F", "I", "V"].sort());
  assert.deepEqual([drudge.damageType, drudge.exVuln, drudge.petDmg], ["Fire", "Cold", "Lightning"]);
  assert.equal(drudge.weapon, W1);
  assert.equal(drudge.offhand, 0);
  assert.equal(expr.text, "maxhp>500");
  assert.equal(expr.priority, 4, "7 clamps to the -1..4 tiers");
  assert.equal(expr.damageType, "Auto", "Harm has no web element");
  assert.equal(expr.weapon, 0);
  assert.equal(expr.offhand, W2);
  assert.deepEqual(on(expr).sort(), ["B", "Cp", "DC", "FC", "G", "R", "WC", "Y"].sort());
  assert.ok(r.warnings.some((w) => /priority 7 is outside -1\.\.4/.test(w)), r.warnings.join("\n"));
  assert.ok(r.warnings.some((w) => /Harm \(7\) has no web equivalent/.test(w)));
  assert.ok(r.warnings.some((w) => /2 monster row\(s\).*server-specific/.test(w)));
});

await check("(a) every MyMonsters switch maps to a distinct MONSTER_COLUMNS letter, and every letter is covered", () => {
  const letters = USD_MONSTER_SWITCHES.map(([, l]) => l);
  assert.equal(new Set(letters).size, letters.length);
  assert.deepEqual([...letters].sort(), [...MONSTER_COLUMNS].sort());
  for (const e of parseUsd(fixture()).monsters) for (const c of MONSTER_COLUMNS) assert.equal(typeof e[c], "boolean", `${e.text} ${c}`);
});

await check("(a) Items / Consumables / Buffs tables are parsed (object ids u32, kinds named), not interpreted further", () => {
  const r = parseUsd(fixture());
  assert.deepEqual(r.items, [{ object: W1, spells: [1599, 35] }, { object: W2, spells: [] }]);
  assert.deepEqual(r.consumables, [
    { name: "Handy Healing Kit", type: 0, kind: "health kit" },
    { name: "Mana Draught", type: 5, kind: "mana food" },
  ]);
  assert.deepEqual(r.extraBuffs, [1018, 2]);
  assert.deepEqual(r.blacklistedBuffs, []);
  assert.deepEqual(r.gemFood, []);
  assert.deepEqual(r.itemUses, []);
});

// ── (b) robustness ──────────────────────────────────────────────────────────

await check("(b) a string, a BOM file and a bare-LF copy parse to the same tables", () => {
  const want = parseUsd(fixture());
  const asText = parseUsd(dec.decode(fixture()));
  assert.equal(asText.ok, true, asText.error);
  assert.deepEqual(asText.tables, want.tables);
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...fixture()]);
  assert.deepEqual(parseUsd(bom).tables, want.tables);
  const lf = toLf(fixture());
  assert.ok(!dec.decode(lf).includes("\r"));
  const r = parseUsd(lf);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.tables, want.tables);
  assert.deepEqual(r.monsters, want.monsters);
  assert.deepEqual(parseUsd(lf.buffer.slice(lf.byteOffset, lf.byteOffset + lf.byteLength)).tables, want.tables, "an ArrayBuffer reads too");
});

const ONE = (cells) => crlf(["1", "Settings", "2", "Setting", "Value", "y", "n", "1", "s", "X", ...cells]);

await check("(b) `b` is True / False in any case; anything else is { ok:false } naming the problem", () => {
  for (const [txt, v] of [["True", true], ["true", true], ["TRUE", true], ["False", false], ["false", false], ["FaLsE", false]]) {
    const r = parseUsd(ONE(["b", txt]));
    assert.equal(r.ok, true, `${txt}: ${r.error}`);
    assert.equal(r.settings[0].value, v, txt);
  }
  const bad = parseUsd(ONE(["b", "Yes"]));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /True or False/);
});

await check("(b) a decimal comma in a `d` reads as '.'; a non-number is { ok:false }", () => {
  assert.equal(parseUsd(ONE(["d", "0,025"])).settings[0].value, 0.025);
  assert.equal(parseUsd(ONE(["d", "0.025"])).settings[0].value, 0.025);
  assert.equal(parseUsd(ONE(["d", "abc"])).ok, false);
});

await check("(b) `ba`: a CRLF byte count; in a bare-LF copy each LF counts as VTank's CRLF", () => {
  // Settings rows X = ba "a<EOL>b<EOL>" (no EOL after the bytes) and Y = i 1.
  const doc = (eol, count) =>
    enc.encode(
      ["1", "Settings", "2", "Setting", "Value", "y", "n", "2", "s", "X", "ba", String(count)].map((l) => `${l}${eol}`).join("") +
        `a${eol}b${eol}` +
        ["s", "Y", "i", "1"].map((l) => `${l}${eol}`).join(""),
    );
  const r1 = parseUsd(doc("\r\n", 6));
  assert.equal(r1.ok, true, r1.error);
  assert.equal(r1.settings[0].value, "a\r\nb\r\n");
  assert.deepEqual(r1.settings[1], { vtName: "Y", t: "i", value: 1, type: null }, "a two-column Settings has no SettingType");
  const r2 = parseUsd(doc("\n", 6));
  assert.equal(r2.ok, true, r2.error);
  assert.equal(r2.settings[0].value, "a\nb\n", "6 = VTank's CRLF count of the LF copy's 4 bytes");
  assert.deepEqual(r2.warnings, []);
  const r3 = parseUsd(doc("\n", 4));
  assert.equal(r3.ok, true, r3.error);
  assert.equal(r3.settings[0].value, "a\nb\n");
  assert.ok(r3.warnings.some((w) => /LF byte counts/.test(w)), "a raw-count LF file loads through the retry, reported");
  const past = parseUsd(doc("\r\n", 99));
  assert.equal(past.ok, false);
  assert.match(past.error, /past the end/);
});

await check("(b) a .met file, an empty file, garbage and a non-VTank table set are { ok:false }", () => {
  const metDir = path.join(HW, "rynth", "testdata", "vt", "meta");
  const met = readdirSync(metDir).find((n) => n.endsWith(".met"));
  const r = parseUsd(readFileSync(path.join(metDir, met)));
  assert.equal(r.ok, false);
  assert.match(r.error, /not a VTank settings file|unknown value type/);
  assert.equal(parseUsd("").ok, false);
  assert.equal(parseUsd("\r\n  \r\n").ok, false);
  assert.equal(parseUsd("hello").ok, false);
  assert.equal(parseUsd(null).ok, false);
  assert.equal(parseUsd({}).ok, false);
  const other = parseUsd(crlf(["1", "Foo", "1", "A", "n", "1", "i", "1"]));
  assert.equal(other.ok, false);
  assert.match(other.error, /not a VTank settings file/);
});

await check("(b) a nesting bomb and a huge row count fail fast; extra bytes after the last table are a warning", () => {
  const bomb = ["1", "Settings", "2", "Setting", "Value", "y", "n", "1", "s", "X"];
  for (let i = 0; i < 40; i++) bomb.push("TABLE", "1", "c", "n", "1");
  bomb.push("i", "1");
  const r = parseUsd(crlf(bomb));
  assert.equal(r.ok, false);
  assert.match(r.error, /nested deeper/);
  const huge = parseUsd(crlf(["1", "Settings", "2", "Setting", "Value", "y", "n", "999999999", "s", "X", "i", "1"]));
  assert.equal(huge.ok, false);
  assert.match(huge.error, /bad row count/);
  const zeroCols = parseUsd(crlf(["1", "Settings", "0", "999999999"]));
  assert.equal(zeroCols.ok, false);
  const tail = parseUsd(enc.encode(dec.decode(ONE(["i", "5"])) + "junk\r\n"));
  assert.equal(tail.ok, true, tail.error);
  assert.ok(tail.warnings.some((w) => /trailing byte/.test(w)));
});

await check("(b) EVERY truncation of the fixture returns a result object — never throws", () => {
  const b = fixture();
  let failures = 0;
  for (let n = 0; n < b.length; n++) {
    let r;
    assert.doesNotThrow(() => {
      r = parseUsd(b.subarray(0, n));
    }, `prefix ${n}`);
    assert.equal(typeof r.ok, "boolean");
    if (!r.ok) {
      failures++;
      assert.equal(typeof r.error, "string");
    }
  }
  assert.ok(failures > b.length - 4, `${failures} of ${b.length} prefixes fail (only the last CRLF may be cut)`);
});

// ── (c) importUsdProfile on VtOptions ───────────────────────────────────────

await check("(c) refused for Default / [By char] / a bad name / an existing name / a bad file — nothing changes", () => {
  const { storage, profiles, options } = mkOptions();
  assert.equal(options.set("HealAt", 77, { source: "ui" }).ok, true, "a Default-session overlay edit");
  const overlay = JSON.stringify(profiles.overlay());
  const before = JSON.stringify([...storage.m.entries()]);
  for (const name of ["Default", "default", "[By char]", "__bychar__", "", "   ", "two words", null]) {
    const r = importUsdProfile(options, name, fixture(), { normalizeMonster: normalizeEntry });
    assert.equal(r.ok, false, `${JSON.stringify(name)} must be refused`);
    assert.equal(typeof r.error, "string");
  }
  const garbage = importUsdProfile(options, "Fresh", "not a usd", { normalizeMonster: normalizeEntry });
  assert.equal(garbage.ok, false);
  assert.equal(profiles.active().kind, "default");
  assert.equal(JSON.stringify(profiles.overlay()), overlay, "the Default overlay is untouched");
  assert.equal(JSON.stringify([...storage.m.entries()]), before, "no storage write");
  assert.equal(options.getValue("HealAt"), 77);
  // an existing profile name (any case) is never overwritten
  assert.equal(options.saveAs("Taken").ok, true);
  assert.equal(options.selectProfile("Default").ok, true);
  const taken = JSON.stringify([...storage.m.entries()]);
  const r = importUsdProfile(options, "taken", fixture(), { normalizeMonster: normalizeEntry });
  assert.equal(r.ok, false);
  assert.match(r.error, /already exists/);
  assert.equal(profiles.active().kind, "default");
  assert.equal(JSON.stringify([...storage.m.entries()]), taken);
});

await check("(c) a new shared profile: Settings by VTank name (×240 lbf), clamps and unknown names reported, monsters validated", () => {
  const { storage, profiles, options } = mkOptions();
  const overlay = JSON.stringify(profiles.overlay());
  const r = importUsdProfile(options, "Hunter", fixture(), { normalizeMonster: normalizeEntry });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.profile, { name: "Hunter", kind: "shared" });
  assert.deepEqual(profiles.active(), { name: "Hunter", kind: "shared", writable: true });
  assert.equal(JSON.stringify(profiles.overlay()), overlay, "Default's overlay is never written");
  assert.equal(options.getValue("EnableCombat"), false);
  assert.equal(options.getValue("MonsterRange"), 20, "AttackDistance 0.0833… landblocks = 20 m");
  assert.ok(Math.abs(options.get("AttackDistance", { vtUnits: true }).value - 1 / 12) < 1e-9, "reads back in VTank units");
  assert.equal(options.getValue("OpenDoorRange"), 6, "DoorOpenRange 0.025 × 240");
  assert.equal(options.getValue("HealAt"), 70);
  // "Banes1" is no bane profile (VTank's enum, All/None or ALFCBPS letters): reported, not imported
  assert.equal(options.getValue("BuffProfileBanes"), "ALFCBPS", "left at its default");
  assert.equal(options.getValue("AttackHeight"), 3);
  assert.equal(options.getValue("NavFarStopDistance"), 100000, "999999 landblocks (VTank's 'off') clamp to the 100 km row max");
  assert.equal(r.applied.includes("BuffProfileBanes"), false);
  for (const k of ["EnableCombat", "MonsterRange", "OpenDoorRange", "HealAt", "AttackHeight", "NavFarStopDistance", "monsters"]) {
    assert.ok(r.applied.includes(k), `applied ${k}`);
  }
  assert.deepEqual(r.unknown, ["NotARealOption"]);
  const w = r.warnings.join("\n");
  assert.match(w, /NavFarStopRange 999999: outside the web range — NavFarStopDistance = 100000/);
  assert.match(w, /1 setting\(s\) not known here, not imported: NotARealOption/);
  assert.match(w, /table-valued setting\(s\) not imported: RechargeHandlerSet/);
  assert.match(w, /Items tab: 2 object id\(s\) not imported/);
  assert.match(w, /Consumables tab: 2 row\(s\) not imported/);
  assert.match(w, /Buffs tab: 2 spell id\(s\)/);
  assert.match(w, /server-specific/);

  // the stored list is the validator's output, DEFAULT first
  const want = parseUsd(fixture()).monsters.map(normalizeEntry);
  const list = options.getList("monsters");
  assert.deepEqual(list, want);
  for (const e of list) assert.deepEqual(Object.keys(e).sort(), Object.keys(DEFAULT_ENTRY).sort());
  const ml = new MonsterList({ entries: list, log: quiet });
  assert.deepEqual(ml.entries().map((e) => e.text), ["DEFAULT", "Drudge Skulker", "maxhp>500"]);
  assert.equal(ml.entries()[0].S, true);
  assert.equal(ml.entries()[1].weapon, W1);

  // persisted under the shared key
  const rec = JSON.parse(storage.getItem(`${SHARED_PREFIX}Hunter`));
  assert.equal(rec.settings.MonsterRange, 20);
  assert.equal(rec.settings.EnableCombat, false);
  assert.equal(rec.lists.monsters.length, 3);
  assert.ok(!storage.writes.some((k) => /default/i.test(k) && !k.startsWith("rynth.vt.v1.active.")), storage.writes.join(", "));

  // the same name again is refused
  assert.equal(importUsdProfile(options, "Hunter", fixture()).ok, false);
});

await check("(c) mineOnly ⇒ a [Char] profile; a path/.usd name is stripped; a parseUsd result imports as-is", () => {
  const { storage, profiles, options } = mkOptions();
  const r = importUsdProfile(options, "C:\\VT\\Profiles\\Melee-1.usd", parseUsd(fixture()), { mineOnly: true, normalizeMonster: normalizeEntry });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.profile, { name: "Melee-1", kind: "char" });
  assert.equal(profiles.active().kind, "char");
  assert.ok(storage.getItem(`${charPrefix("1342177281")}Melee-1`), "stored under the character's prefix");
  assert.equal(options.getValue("MonsterRange"), 20);
});

await check("(c) the bane profile: BuffProfile_Banes (VTank's enum) wins over a BuffProfile-Banes letters row unless it says Custom (1), in any file order", () => {
  const base = parseUsd(fixture());
  const withBanes = (rows) => ({ ...base, settings: [...base.settings.filter((x) => !/^buffprofile[_-]banes$/i.test(x.vtName)), ...rows] });
  const imp = (name, rows) => {
    const { options } = mkOptions();
    const r = importUsdProfile(options, name, withBanes(rows), { normalizeMonster: normalizeEntry });
    assert.equal(r.ok, true, r.error);
    return options.getValue("BuffProfileBanes");
  };
  const letters = { vtName: "BuffProfile-Banes", t: "s", value: "ALFCBPS", type: 5 };
  assert.equal(imp("BanesA", [{ vtName: "BuffProfile_Banes", t: "i", value: 4, type: 1 }, letters]), "B", "enum 4 (B) with stale letters after it");
  assert.equal(imp("BanesB", [letters, { vtName: "BuffProfile_Banes", t: "i", value: 5, type: 1 }]), "BPS", "letters first, enum 5 (BPS) after");
  assert.equal(imp("BanesC", [{ vtName: "BuffProfile_Banes", t: "i", value: 1, type: 1 }, { ...letters, value: "SA" }]), "AS", "Custom: the letters");
  assert.equal(imp("BanesD", [{ ...letters, value: "lfc" }]), "LFC", "letters alone");
});

await check("(c) malformed MyMonsters cells fall back to the validator's defaults (no throw, no bad types)", () => {
  const { options } = mkOptions();
  const doc = crlf([
    "1", "MyMonsters", "5", "MonsterName", "AttackPriority", "DamageType", "Imperil", "WeaponToUse", "y", "n", "n", "n", "n", "3",
    "s", "<DEFAULT>", "s", "high", "s", "fire", "s", "yes", "d", "-1",
    "s", "Mite", "i", "2", "i", "77", "i", "1", "s", "sword",
    "s", "", "i", "1", "i", "1", "b", "True", "i", "-1",
  ]);
  const p = parseUsd(doc);
  assert.equal(p.ok, true, p.error);
  assert.equal(p.monsters.length, 2, "the nameless row is skipped");
  assert.ok(p.warnings.some((w) => /without a MonsterName/.test(w)));
  const r = importUsdProfile(options, "Odd", p, { normalizeMonster: normalizeEntry });
  assert.equal(r.ok, true, r.error);
  const [def, mite] = options.getList("monsters");
  assert.deepEqual([def.text, def.priority, def.damageType, def.I, def.weapon], ["DEFAULT", 1, "Auto", false, 0]);
  assert.deepEqual([mite.text, mite.priority, mite.damageType, mite.I, mite.weapon], ["Mite", 2, "Auto", true, 0]);
  assert.ok(r.warnings.some((w) => /no web equivalent/.test(w)), "DamageType 77 is reported");
  assert.ok(r.warnings.some((w) => /no Settings table/.test(w)));
});

// ── (d) WebAC's hunter.usd ──────────────────────────────────────────────────

if (existsSync(HUNTER)) {
  await check("(d) WebAC tests/fixtures/vtank/hunter.usd parses (9 tables) and imports", () => {
    const b = new Uint8Array(readFileSync(HUNTER));
    const p = parseUsd(b);
    assert.equal(p.ok, true, p.error);
    assert.equal(p.tables.length, 9);
    assert.deepEqual(p.monsters.map((m) => m.text), ["DEFAULT", "Drudge Skulker", "maxhp>500"]);
    assert.deepEqual(p.consumables.map((c) => c.kind), ["health kit", "mana food", null]);
    assert.deepEqual(p.gemFood, [{ name: "Asheron's Benediction", spell: 3810 }]);
    assert.deepEqual(p.itemUses, [{ object: W1, uses: 5 }]);
    assert.deepEqual(p.blacklistedBuffs, [1018]);
    const { options } = mkOptions();
    const r = importUsdProfile(options, "hunter.usd", b, { normalizeMonster: normalizeEntry });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.profile.name, "hunter");
    assert.equal(options.getValue("MonsterRange"), 20);
    assert.equal(options.getValue("EnableLooting"), false);
    assert.equal(options.getValue("HealAt"), 60);
    assert.deepEqual([...r.unknown].sort(), ["BuffProfile-Prots", "SomePluginSetting", "UseArcs"]);
    assert.equal(options.getList("monsters").length, 3);
  });
} else {
  skipped++;
  console.log(`  skip (d) ${HUNTER} not present`);
}

// ── (e) the layer: library.importUsd ────────────────────────────────────────

const ME = 0x50000001;
function makeHost() {
  const W = { subs: [], ticks: [] };
  const host = {
    get snap() {
      return { seq: 1 };
    },
    nearbyRangeM: 60,
    s: { playerGuid: () => ME },
    has: () => false,
    GetPlayerId: () => ME,
    TryGetObjectName: (g) => (g === ME ? "Tester" : null),
    TryGetObjectWcid: () => null,
    TryGetPlayerPose: () => ({ objCellId: 0xa9b40015, x: 100, y: 100, z: 0, heading: 0 }),
    IsPortalSpaceActive: () => false,
    NearbyGuids: () => [],
    GetBusyState: () => 0,
    GetGroundContainerId: () => 0,
    TryGetKnownSpells: () => [],
    TryGetPlayerInventory: () => [],
    TryGetPlayerInventoryCached: () => [],
    TryGetPackRoomCached: () => ({ main: { used: 10, cap: 102, free: 92 } }),
    TryGetBurden: () => 42,
    TryGetSelfEnchantments: () => [],
    TryGetObjectIntProperty: () => undefined,
    TryGetObjectDoubleProperty: () => undefined,
    TryGetObjectDistance: () => null,
    TryGetTargetHealthFraction: () => -1,
    ObjectIsAttackable: () => true,
    ObjectIsPlayer: () => false,
    HasAppraisalData: () => false,
    TryGetObjectAppraisal: () => null,
    TryGetPlayerStats: () => ({ level: 50, skills: {} }),
    get itemActionToken() {
      return null;
    },
    onEvent: (fn) => W.subs.push(fn),
    onTick: (fn) => W.ticks.push(fn),
    WriteToChatWindow: () => false,
  };
  return { host, W };
}

function makeBot(host) {
  const claims = new Set();
  const bot = {
    host,
    kernel: { action: "Idle", operatorHeld: false, running: true, aux: VT.createAuxShell() },
    combat: {
      enabled: true, monsterRangeM: 40, priorities: {}, meleePower: 0.6, missileAccuracy: 0.6, attackHeight: 2,
      blacklistAttempts: 3, blacklistTimeoutMs: 30_000, vt: null, acquireRangeFn: null, invalidations: 0,
      invalidateScan() { this.invalidations++; }, underAttack: () => false, disengage() {},
    },
    vitals: {
      enabled: true,
      cfg: { healAtCombat: 60, getManaAtCombat: 40, restamAtCombat: 30, topOffHp: 95, topOffStam: 95, topOffMana: 95, emergencyHp: 30, emergencyStamFloor: 20, manaRechargeStamFloor: 15 },
    },
    loot: { enabled: true, state: "SCAN", minValue: 0, corpseRangeM: 30, classify: null },
    buff: {
      enabled: true, rebuffSecondsRemaining: 300, idleRebuffWindowS: 0, itemBuffs: [], setCalls: 0,
      setItemBuffs(l) { this.itemBuffs = l.slice(); this.setCalls++; return l.length; },
      needsBuff: () => false, desired: [], pending: null, status: { desired: 0, active: 0, ready: true },
    },
    router: { status: { state: "IDLE" }, route: [], follow(legs) { this.route = legs; this.status = { state: "WALK" }; }, cancel() { this.status = { state: "IDLE" }; } },
    unwedge: { allowEscalation: null, active: () => false },
    buffSpec: null,
    setBuffs: async (spec) => { bot.buffSpec = spec; return []; },
    claimMovement: (tag) => { const t = { tag }; claims.add(t); return () => claims.delete(t); },
    movementClaimed: () => claims.size > 0,
    control: { setEnabled(name, on) { const loop = bot[name]; if (loop) loop.enabled = !!on; return { ok: true }; } },
  };
  return bot;
}

await check("(e) layer.library.importUsd: Default refused; an import selects the new profile and reaches the live loops and the MonsterList", async () => {
  const { host } = makeHost();
  const bot = makeBot(host);
  const storage = spyStorage();
  const win = { localStorage: storage };
  const layer = await VT.createVtLayer(bot, { aux: bot.kernel.aux, win, storage, log: quiet, print: quiet, now });
  try {
    assert.equal(typeof layer.library.importUsd, "function");
    const refused = layer.library.importUsd("Default", fixture());
    assert.equal(refused.ok, false);
    assert.equal(layer.profiles.active().kind, "default");
    assert.equal(bot.combat.monsterRangeM, 40, "nothing pushed on a refusal");
    assert.equal(layer.library.importUsd("x", fixture(), null).ok, true, "a null opts is fine");
    assert.equal(layer.profiles.active().name, "x");
    const r = layer.library.importUsd("Hunter", fixture(), { mineOnly: true });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.profile, { name: "Hunter", kind: "char" });
    assert.equal(bot.combat.monsterRangeM, 20, "MonsterRange pushed into the combat loop");
    assert.equal(bot.combat.enabled, false, "EnableCombat False reached the loop");
    assert.equal(bot.vitals.cfg.healAtCombat, 70, "Recharge-Norm-HitP reached vitals");
    assert.deepEqual(layer.monsters.entries().map((e) => e.text), ["DEFAULT", "Drudge Skulker", "maxhp>500"]);
    assert.equal(layer.monsters.entries()[1].damageType, "Fire");
  } finally {
    layer.dispose();
  }
});

console.log(
  fail === 0
    ? `rynth_vt_formats_usd: all ${pass} checks passed${skipped ? ` (${skipped} skipped)` : ""}`
    : `rynth_vt_formats_usd: ${fail} FAILED (${pass} passed)`,
);
process.exit(fail === 0 ? 0 : 1);
