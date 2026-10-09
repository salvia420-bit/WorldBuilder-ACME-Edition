// HUD overhaul 2026-10-05 — examine-panel text formatting.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_examine_format.mjs
//
// plugins/examine_format.js turns appraisal numbers into the words
// retail's ItemExamineUI / BasicCreatureExamineUI printed (acclient.c:
// AppraisalSystem::DamageResistanceToString, ::WeaponTimeToString,
// ::InqHeritageGroupDisplayName, ::InqCreatureDisplayName,
// ItemExamineUI::SetValueText / SetBurdenText, ...). These pins keep the
// thresholds retail-exact and keep raw enum ids / hex out of the panel.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const F = await import(pathToFileURL(resolvePath(__dirname, "plugins/examine_format.js")).href);

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  [OK] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
}
const is = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

console.log("== protectionText (DamageResistanceToString) ==");
is("0 → No", F.protectionText(0, 100), "No (0)");
is("0.0001 → No (|m| ≤ 0.0002)", F.protectionText(0.0001, 100), "No (0)");
is("0.4 → Poor (inclusive)", F.protectionText(0.4, 100), "Poor (40)");
is("0.41 → Below Average", F.protectionText(0.41, 100), "Below Average (41)");
is("0.8 → Below Average (inclusive)", F.protectionText(0.8, 100), "Below Average (80)");
is("1.0 → Average", F.protectionText(1.0, 150), "Average (150)");
is("1.2 → Above Average", F.protectionText(1.2, 100), "Above Average (120)");
is("1.6 → Excellent", F.protectionText(1.6, 100), "Excellent (160)");
is("2.5 → Unparalleled, clamped to 2.0", F.protectionText(2.5, 100), "Unparalleled (200)");
is("negative → Vulnerable", F.protectionText(-0.5, 100), "Vulnerable (-50)");
is("no AL → adjective only", F.protectionText(1.3, null), "Above Average");
is("garbage → null", F.protectionText("x", 100), null);

console.log("== weaponSpeedText (WeaponTimeToString) ==");
is("10 → Very Fast", F.weaponSpeedText(10), "Very Fast (10)");
is("11 → Fast", F.weaponSpeedText(11), "Fast (11)");
is("30 → Fast", F.weaponSpeedText(30), "Fast (30)");
is("31 → Average", F.weaponSpeedText(31), "Average (31)");
is("49 → Average", F.weaponSpeedText(49), "Average (49)");
is("50 → Slow", F.weaponSpeedText(50), "Slow (50)");
is("80 → Very Slow", F.weaponSpeedText(80), "Very Slow (80)");

console.log("== damageRangeText ==");
is("max 20, variance 0.5 → 10 - 20", F.damageRangeText(20, 0.5), "10 - 20");
is("max 13, variance 0.35 → 8.45 - 13", F.damageRangeText(13, 0.35), "8.45 - 13");
is("no variance → just max", F.damageRangeText(20, 0), "20");
is("missing max → null", F.damageRangeText(undefined, 0.3), null);

console.log("== highlightState (Armor/WeaponHighlightMask) ==");
is("bit off → null", F.highlightState(0x0002, 0xFFFF, 0x0001), null);
is("bit on + color 1 → buffed", F.highlightState(0x0001, 0x0001, 0x0001), "buffed");
is("bit on + color 0 → debuffed", F.highlightState(0x0001, 0x0000, 0x0001), "debuffed");
is("null masks → null", F.highlightState(null, null, 0x0004), null);

console.log("== enum names ==");
is("heritage 2 → Gharu'ndim (retail spelling)", F.heritageName(2), "Gharu'ndim");
is("heritage 5 → Umbraen (retail display name)", F.heritageName(5), "Umbraen");
is("heritage string passes through", F.heritageName("Sho"), "Sho");
is("heritage 0 → null", F.heritageName(0), null);
is("creature 3 → Drudge", F.creatureTypeName(3), "Drudge");
is("creature 101 → Anekshay (table length)", F.creatureTypeName(101), "Anekshay");
is("creature 0 / 999 → null", F.creatureTypeName(0) ?? F.creatureTypeName(999), null);
is("gender 1 → Male", F.genderName(null, 1), "Male");
is("gender string wins", F.genderName("Female", 1), "Female");
is("skill 11 → Sword", F.skillName(11), "Sword");
is("damage bits 1|16 → Slashing/Fire", F.damageTypeLabel(0x11), "Slashing/Fire");

console.log("== itemTypeLabel / equipSlotsLabel ==");
is("0x1 → Melee Weapon", F.itemTypeLabel(0x1), "Melee Weapon");
is("melee + magic → Melee Weapon (specific wins)", F.itemTypeLabel(0x00200001), "Melee Weapon");
is("0x2 → Armor", F.itemTypeLabel(0x2), "Armor");
is("0x4 → Clothing (not 'Weapon')", F.itemTypeLabel(0x4), "Clothing");
is("0x40 → Money", F.itemTypeLabel(0x40), "Money");
is("0x80000 → Mana Stone", F.itemTypeLabel(0x80000), "Mana Stone");
is("0 → null", F.itemTypeLabel(0), null);
is("chest armor+wear → one 'Chest'", F.equipSlotsLabel(0x00000202), "Chest");
is("breastplate (chest+abdomen armor)", F.equipSlotsLabel(0x00000600), "Chest, Abdomen");
is("rings both fingers", F.equipSlotsLabel(0x000C0000), "Left Finger, Right Finger");
is("0 → null", F.equipSlotsLabel(0), null);

console.log("== formatThousands / healthModel ==");
is("1234567 → 1,234,567", F.formatThousands(1234567), "1,234,567");
is("999 → 999", F.formatThousands(999), "999");
is("-1200 → -1,200", F.formatThousands(-1200), "-1,200");
is("NaN → null", F.formatThousands("abc"), null);
{
  const h = F.healthModel({ cur: 84, max: 120 });
  check("exact cur/max", Math.abs(h.fraction - 0.7) < 1e-9 && h.label === "84 / 120", JSON.stringify(h));
  const f = F.healthModel({ fraction: 0.456 });
  check("fraction only → percent", f.label === "46%" && f.fraction === 0.456, JSON.stringify(f));
  check("nothing → null", F.healthModel({}) === null);
  check("cur without max falls back to fraction/null", F.healthModel({ cur: 50 }) === null);
}

console.log("== examineHeaderModel ==");
{
  const m = F.examineHeaderModel({ kind: "item", ints: { Value: 12500, EncumbranceVal: 450 } });
  check("item lines = retail Value / Burden", m.lines[0].text === "Value: 12,500" && m.lines[1].text === "Burden: 450 Burden Units", JSON.stringify(m));
  check("item has no level box", m.level === null);
}
{
  const m = F.examineHeaderModel({ kind: "item", item: { value: 25 } });
  check("item: inventory value before appraisal, burden ???",
    m.lines[0].text === "Value: 25" && m.lines[1].text === "Burden: ???", JSON.stringify(m));
}
{
  const m = F.examineHeaderModel({ kind: "creature", ints: { CreatureType: 3, Level: 14 } });
  check("creature: type line + level", m.lines[0].text === "Drudge" && m.level === "14" && m.levelLabel === "Level", JSON.stringify(m));
}
{
  const m = F.examineHeaderModel({ kind: "creature" });
  check("creature: unknown level → ??? (SetLevelValueText)", m.level === "???" && m.lines.length === 0, JSON.stringify(m));
}
{
  const m = F.examineHeaderModel({ kind: "player", ints: { HeritageGroup: 1, Gender: 2, Level: 126 }, strings: { Title: "Master Archer" }, isPK: true });
  check("player: heritage+gender, title, PK, Character Level",
    m.lines[0].text === "Aluvian Female" && m.lines[1].text === "Master Archer"
    && m.lines[2].text === "Player Killer" && m.lines[2].tone === "warn"
    && m.level === "126" && m.levelLabel === "Character Level", JSON.stringify(m));
}
{
  const m = F.examineHeaderModel({ kind: "player", ints: { HeritageGroup: 3 } });
  check("player: no hex / ids anywhere in the lines", m.lines.every((l) => !/0x|\d{3,}/.test(l.text)), JSON.stringify(m));
}

// pk-5 (2026-10-08 round 5): CharExamineUI::SetAppraiseInfo tests IsPK, then
// IsPKLite, else Non-Player Killer — every examined character gets a line.
is("pkStatusText: PK (0x20)", F.pkStatusText(0x20), "Player Killer");
is("pkStatusText: PK Lite (0x2000000)", F.pkStatusText(0x2000000), "Player Killer Lite");
is("pkStatusText: PK tested first", F.pkStatusText(0x2000020), "Player Killer");
is("pkStatusText: NPK", F.pkStatusText(0x8), "Non-Player Killer");
{
  const npk = F.examineHeaderModel({ kind: "player", ints: { HeritageGroup: 1 }, pkStatus: "Non-Player Killer" });
  check("player: an NPK gets the Non-Player Killer line (no warn tone)",
    npk.lines.some((l) => l.text === "Non-Player Killer" && !l.tone), JSON.stringify(npk));
  const lite = F.examineHeaderModel({ kind: "player", ints: { HeritageGroup: 1 }, pkStatus: "Player Killer Lite" });
  check("player: PK Lite line", lite.lines.some((l) => l.text === "Player Killer Lite"), JSON.stringify(lite));
  const pk = F.examineHeaderModel({ kind: "player", ints: { HeritageGroup: 1 }, pkStatus: "Player Killer" });
  check("player: PK keeps the warn tone", pk.lines.some((l) => l.text === "Player Killer" && l.tone === "warn"), JSON.stringify(pk));
  const creature = F.examineHeaderModel({ kind: "creature", pkStatus: "Non-Player Killer" });
  check("creature: no PK line", !creature.lines.some((l) => /Killer/.test(l.text)), JSON.stringify(creature));
}

console.log("== creatureAttributeRows (enchstats-4: AttributeInfoRegion / Attribute2ndInfoRegion) ==");
{
  const byLabel = (rows) => Object.fromEntries(rows.map((r) => [r.label, r]));
  const full = {
    health: 50, health_max: 60,
    attributes: {
      strength: 10, endurance: 20, quickness: 30, coordination: 40, focus: 50,
      self_attr: 123, stamina: 3, stamina_max: 9, mana: 1, mana_max: 2,
    },
  };
  const ok = byLabel(F.creatureAttributeRows(full, true));
  is("Self row reads the wire field self_attr", ok.Self.value, "123");
  is("Strength value", ok.Strength.value, "10");
  is("success Health = cur / max", ok.Health.value, "50 / 60");
  is("success Stamina = cur / max", ok.Stamina.value, "3 / 9");
  is("no buffs → no tone", ok.Strength.tone, null);
  is("six attributes then three vitals", F.creatureAttributeRows(full, true).map((r) => r.kind).join(","),
    "attribute,attribute,attribute,attribute,attribute,attribute,vital,vital,vital");

  const buffed = byLabel(F.creatureAttributeRows({ ...full, buffs: { highlights: 0x0001, colors: 0x0001 } }, true));
  is("highlight 0x1 + colour 0x1 → Strength buffed", buffed.Strength.tone, "buffed");
  is("Endurance untouched", buffed.Endurance.tone, null);
  const debuffed = byLabel(F.creatureAttributeRows({ ...full, buffs: { highlights: 0x0002, colors: 0 } }, true));
  is("highlight 0x2 + colour 0 → Endurance debuffed", debuffed.Endurance.tone, "debuffed");
  const self = byLabel(F.creatureAttributeRows({ ...full, buffs: { highlights: 0x0020, colors: 0x0020 } }, true));
  is("Self bit is 0x20", self.Self.tone, "buffed");
  const vit = byLabel(F.creatureAttributeRows({ ...full, buffs: { highlights: 0x01C0, colors: 0x0040 } }, true));
  is("Health (max) bit 0x40", vit.Health.tone, "buffed");
  is("Stamina (max) bit 0x80", vit.Stamina.tone, "debuffed");
  is("Mana (max) bit 0x100", vit.Mana.tone, "debuffed");

  const zero = byLabel(F.creatureAttributeRows({ ...full, attributes: { ...full.attributes, quickness: 0 } }, true));
  is("success value 0 → ??? (retail)", zero.Quickness.value, "???");
  const bare = byLabel(F.creatureAttributeRows(null, true, { Strength: 77, MaxHealth: 1200 }));
  is("no profile: PropertyInt fallback", bare.Strength.value, "77");
  is("no profile: unknown attribute → null (row skipped)", bare.Focus.value, null);
  is("no profile: MaxHealth fallback", bare.Health.value, "1,200");

  const failed = byLabel(F.creatureAttributeRows({ health: 4, health_max: 7 }, false));
  is("failed: attributes ???", failed.Strength.value, "???");
  is("failed: Self ???", failed.Self.value, "???");
  is("failed: Health = MulDiv percent (4/7 → 57 %)", failed.Health.value, "57 %");
  is("failed: Stamina ???", failed.Stamina.value, "???");
  is("failed: incomplete tone", failed.Strength.tone, "incomplete");
  is("failed: Health incomplete tone", failed.Health.tone, "incomplete");
  is("failed: zero max → ???", byLabel(F.creatureAttributeRows({ health: 0, health_max: 0 }, false)).Health.value, "???");
  is("failed ignores the PropertyInt bag", byLabel(F.creatureAttributeRows({ health: 1, health_max: 2 }, false, { Strength: 5 })).Strength.value, "???");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
