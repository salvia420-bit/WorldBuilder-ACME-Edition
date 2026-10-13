// tests/combat_hit_chat_lines.test.mjs — combat-magic-3 (2026-10-13).
//
// Retail formats the melee / missile hit lines client-side:
// - ClientCombatSystem::HandleAttackerNotificationEvent (acclient.c:408294):
//   "Critical hit!  " / "Sneak Attack! " / "Recklessness! ", then
//   "You %s %s for %d point%s of %sdamage!", then (condition bit 0x1)
//   " Your target's Critical Protection augmentation allows them to avoid your
//   critical hit!".
// - HandleDefenderNotificationEvent (:409442): "Critical hit! " (one space) /
//   "Sneak Attack! " / "Reckless! ", "<attacker> <verbs> your <part> for N
//   point[s] of <type >damage!", then " Your Critical Protection augmentation
//   allows you to avoid a critical hit!".
// - CombatSystem::InqCombatHitAdjectives (:500139) is an EXACT-value switch
//   (Nether 0x400 -> scar/twist/wither/eradicate, anything else -> hit/hits);
//   AppraisalSystem::DamageTypeToString (:479074) gives the type word.
// - HandleEvasionDefenderNotificationEvent (:409275): "You evaded <attacker>!".
//
// The line builders are Rust (chat_format::format_*_hit_line, unit-tested
// natively by `cargo test -p holtburger-web --lib chat_format`); this pins the
// wasm wiring by source so the JS gate sees a regression without a wasm
// build, and pins the kind=19 combat JSON (rynth's combat_loop / combat_memory
// read it) byte-identical.
//
// Run: node tests/combat_hit_chat_lines.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

// The body of one inner `GameEvent::<name>(` arm: up to the next GameEvent arm.
function eventArm(source, name) {
  const head = `GameEvent::${name}(`;
  const at = source.indexOf(head);
  if (at < 0) return null;
  const next = source.indexOf("GameEvent::", at + head.length);
  return source.slice(at, next < 0 ? undefined : next);
}

function fnBody(source, name) {
  const m = source.match(new RegExp(`\\npub\\(crate\\) fn ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(m, `fn ${name} found`);
  return m[0];
}

test("the hit arms call the chat_format builders with the raw bits", () => {
  const ge = src("src/session/messages/game_event.rs");
  const atk = eventArm(ge, "AttackerNotification");
  assert.ok(atk, "AttackerNotification arm present");
  assert.match(
    atk,
    /crate::chat_format::format_attacker_hit_line\(\s*&data\.defender_name,\s*data\.damage_type\.bits\(\),\s*data\.health_percent,\s*data\.damage,\s*data\.critical_hit,\s*data\.attack_conditions\.bits\(\),?\s*\)/,
  );
  const def = eventArm(ge, "DefenderNotification");
  assert.ok(def, "DefenderNotification arm present");
  assert.match(
    def,
    /crate::chat_format::format_defender_hit_line\(\s*&data\.attacker_name,\s*data\.damage_type\.bits\(\),\s*data\.health_percent,\s*data\.damage,\s*damage_location_label\(data\.damage_location\),\s*data\.critical_hit,\s*data\.attack_conditions\.bits\(\),?\s*\)/,
  );
  // The pre-retail templates are gone.
  assert.doesNotMatch(ge, /of damage to your/);
  assert.doesNotMatch(ge, /\{\}You \{\} \{\} for/);
  assert.doesNotMatch(ge, /You evaded \{\}'s attack\./);
  for (const body of [atk, def]) {
    assert.match(body, /u32_payload_2: Some\(CHAT_CATEGORY_COMBAT\)/, "chat category unchanged");
  }
});

test("the evade arms call the chat_format builders", () => {
  const ge = src("src/session/messages/game_event.rs");
  const ea = eventArm(ge, "EvasionAttackerNotification");
  assert.ok(ea, "EvasionAttackerNotification arm present");
  assert.match(ea, /crate::chat_format::format_evasion_attacker_line\(\s*&data\.defender_name,?\s*\)/);
  const ed = eventArm(ge, "EvasionDefenderNotification");
  assert.ok(ed, "EvasionDefenderNotification arm present");
  assert.match(ed, /crate::chat_format::format_evasion_defender_line\(\s*&data\.attacker_name,?\s*\)/);
});

test("kind=19 combat JSON is unchanged (rynth reads it)", () => {
  const ge = src("src/session/messages/game_event.rs");
  const json = (body) => {
    const m = body.match(/serde_json::json!\(\{([\s\S]*?)\}\)/);
    assert.ok(m, "json! payload present");
    return m[1].split("\n").map((l) => l.trim()).filter(Boolean);
  };
  assert.deepEqual(json(eventArm(ge, "AttackerNotification")), [
    '"type": "damageDealt",',
    '"defenderName": data.defender_name,',
    '"damage": data.damage,',
    '"damageType": damage_type_label(data.damage_type),',
    '"severity": data.health_percent,',
    '"criticalHit": data.critical_hit,',
    '"attackConditions": data.attack_conditions.bits(),',
  ]);
  assert.deepEqual(json(eventArm(ge, "DefenderNotification")), [
    '"type": "damageTaken",',
    '"attackerName": data.attacker_name,',
    '"damage": data.damage,',
    '"damageType": damage_type_label(data.damage_type),',
    '"damageLocation": damage_location_label(data.damage_location),',
    '"severity": data.health_percent,',
    '"criticalHit": data.critical_hit,',
    '"attackConditions": data.attack_conditions.bits(),',
  ]);
  assert.deepEqual(json(eventArm(ge, "EvasionAttackerNotification")), [
    '"type": "evadedTarget",',
    '"defenderName": data.defender_name,',
  ]);
  assert.deepEqual(json(eventArm(ge, "EvasionDefenderNotification")), [
    '"type": "evadedAttacker",',
    '"attackerName": data.attacker_name,',
  ]);
  // damage_type_label (the JSON's "damageType") keeps its old names.
  const lib = src("src/lib.rs");
  assert.match(lib, /fn damage_type_label\(damage_type: holtburger_common::properties::DamageType\) -> String \{\s*let names: Vec<&'static str> = damage_type\.iter_display_names\(\)\.collect\(\);/);
});

test("the old contains-chain helpers are gone from lib.rs", () => {
  const lib = src("src/lib.rs");
  assert.doesNotMatch(lib, /\nfn damage_severity_verb\(/);
  assert.doesNotMatch(lib, /\nfn attack_conditions_prefix\(/);
});

test("chat_format: retail strings, exact-value verb switch, appraisal names", () => {
  const cf = src("src/chat_format.rs");
  const adj = fnBody(cf, "combat_hit_adjectives");
  assert.match(adj, /match damage_type \{/);
  assert.match(
    adj,
    /0x400 => \[\("scar", "scars"\), \("twist", "twists"\), \("wither", "withers"\), \("eradicate", "eradicates"\)\]/,
  );
  assert.match(adj, /_ => return \("hit", "hits"\),/);
  assert.doesNotMatch(adj, /contains/);
  for (const v of ["0x1", "0x2", "0x4", "0x8", "0x10", "0x20", "0x40", "0x80"]) {
    assert.match(adj, new RegExp(`\\n\\s*${v} => \\[`), `exact arm ${v}`);
  }
  assert.match(adj, /severity > 0\.5[\s\S]*severity > 0\.25[\s\S]*severity > 0\.1/);

  assert.match(fnBody(cf, "attacker_hit_prefix"), /"Critical hit!  "[\s\S]*"Sneak Attack! "[\s\S]*"Recklessness! "/);
  assert.match(fnBody(cf, "defender_hit_prefix"), /"Critical hit! "[\s\S]*"Sneak Attack! "[\s\S]*"Reckless! "/);
  assert.match(
    fnBody(cf, "format_attacker_hit_line"),
    /"You \{verb\} \{defender_name\} for \{damage\} point\{s\} of \{ty\}damage!"[\s\S]*" Your target's Critical Protection augmentation allows them to avoid your critical hit!"/,
  );
  const def = fnBody(cf, "format_defender_hit_line");
  assert.match(def, /"\{attacker_name\} \{verbs\} \{target\} for \{damage\} point\{s\} of \{ty\}damage!"/);
  assert.match(def, /format!\("your \{body_part\}"\)/);
  assert.match(def, /" Your Critical Protection augmentation allows you to avoid a critical hit!"/);
  assert.match(fnBody(cf, "format_evasion_defender_line"), /format!\("You evaded \{attacker_name\}!"\)/);
  assert.match(fnBody(cf, "format_evasion_attacker_line"), /format!\("\{defender_name\} evaded your attack\."\)/);

  const names = cf.match(/const RETAIL_DAMAGE_TYPE_NAMES: \[\(u32, &str\); 9\] = \[([\s\S]*?)\];/);
  assert.ok(names, "RETAIL_DAMAGE_TYPE_NAMES present");
  const pairs = [...names[1].matchAll(/\((0x[0-9a-fA-F_]+), "([A-Za-z]+)"\)/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(pairs, [
    ["0x1", "Slashing"],
    ["0x2", "Piercing"],
    ["0x4", "Bludgeoning"],
    ["0x8", "Cold"],
    ["0x10", "Fire"],
    ["0x20", "Acid"],
    ["0x40", "Electrical"],
    ["0x400", "Nether"],
    ["0x1000_0000", "Prismatic"],
  ]);
});
