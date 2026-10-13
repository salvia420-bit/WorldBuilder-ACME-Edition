// tests/buff_expiry_line.test.mjs — chat-errors-4 (2026-10-13).
//
// Retail ClientMagicSystem::NotifyOfEnchantmentRemoval (acclient.c:405087)
// prints "<Spell> has expired." at text type 7 (Magic) when an enchantment on
// the player is removed — "Vitae penalty has expired." for spell 666, nothing
// for a cooldown id (spell >= 0x8000), nothing for a spell the SpellTable
// doesn't know, nothing when Magic is globally squelched
// (IsSquelched(0, …, 7)). Handle_Magic__RemoveEnchantment /
// RemoveMultipleEnchantments notify (fNotify = 1 from the UI dispatch); the
// Dispel pair passes fNotify = 0. ACE sends no text of its own for a spell
// expiring on the player (EnchantmentManager.Remove), so the client prints it.
//
// The line builder is Rust (chat_format::enchantment_expired_line[s],
// unit-tested natively); this pins the wasm wiring by source so the JS gate
// sees a regression without a wasm build. Escape: ?buffExpiryLine=off.
//
// Run: node tests/buff_expiry_line.test.mjs   (from apps/holtburger-web/)

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
  const m = source.match(new RegExp(`\\nfn ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(m, `fn ${name} found`);
  return m[0];
}

test("RemoveEnchantment + RemoveMultipleEnchantments push the expired lines", () => {
  const ge = src("src/session/messages/game_event.rs");
  const single = eventArm(ge, "MagicRemoveEnchantment");
  assert.ok(single, "MagicRemoveEnchantment arm present");
  // The layered id: spell in the low 16 bits, layer in the high 16.
  assert.match(
    single,
    /let eid = u32::from\(data\.spell_id\) \| \(u32::from\(data\.layer\) << 16\);/,
  );
  assert.match(single, /push_enchantment_expired_lines\([\s\S]*?data\.target\.0,\s*&\[eid\],?\s*\)/);
  const multi = eventArm(ge, "MagicRemoveMultipleEnchantments");
  assert.ok(multi, "MagicRemoveMultipleEnchantments arm present");
  assert.match(multi, /\.spells\s*\.iter\(\)/);
  assert.match(multi, /u32::from\(spell_id\) \| \(u32::from\(layer\) << 16\)/);
  assert.match(multi, /push_enchantment_expired_lines\([\s\S]*?data\.target\.0,\s*&eids,?\s*\)/);
});

test("Dispel / Purge never print an expiry line (retail fNotify = 0)", () => {
  const ge = src("src/session/messages/game_event.rs");
  for (const name of [
    "MagicDispelEnchantment",
    "MagicDispelMultipleEnchantments",
    "MagicPurgeEnchantments",
    "MagicPurgeBadEnchantments",
  ]) {
    const body = eventArm(ge, name);
    if (body) assert.doesNotMatch(body, /expired/, name);
  }
  // Exactly the two notifying arms call the helper (plus its definition).
  const calls = ge.match(/push_enchantment_expired_lines\(/g) || [];
  assert.equal(calls.length, 3, "two call sites + one definition");
});

test("the helper: local player only, escape flag, Magic squelch, kind=2 Magic", () => {
  const ge = src("src/session/messages/game_event.rs");
  const body = fnBody(ge, "push_enchantment_expired_lines");
  assert.match(body, /if local_guid == 0 \|\| target != local_guid \{\s*return;/, "local player only");
  assert.match(body, /if !crate::chat_format::buff_expiry_line_enabled\(&flag_search\(\)\) \{\s*return;/);
  assert.match(body, /\.map\(\|s\| s\.globals_mask\)/, "global squelch mask");
  assert.match(body, /crate::world_bootstrap_cache::try_get_cached\(\)/, "SpellTable names");
  assert.match(body, /\.spell_table\s*\.spells\s*\.get\(&spell_id\)/);
  assert.match(body, /crate::chat_format::enchantment_expired_lines\(eids, globals_mask,/);
  // kind=2 shape: u32 = the retail text type (7), u32b = the Magic category.
  assert.match(body, /kind: CLIENT_EVENT_KIND_CHAT_RECEIVED/);
  assert.match(body, /u32_payload: Some\(crate::chat_format::TEXT_TYPE_MAGIC\)/);
  assert.match(body, /u32_payload_2: Some\(CHAT_CATEGORY_MAGIC\)/);
});

test("chat_format: retail wording, cooldown + unknown gates, escape parser", () => {
  const cf = src("src/chat_format.rs");
  assert.match(cf, /pub\(crate\) const TEXT_TYPE_MAGIC: u32 = 0x07;/);
  const line = cf.match(
    /pub\(crate\) fn enchantment_expired_line\(eid: u32, name: Option<&str>\) -> Option<String> \{([\s\S]*?)\n\}/,
  );
  assert.ok(line, "enchantment_expired_line found");
  assert.match(line[1], /VITAE_SPELL_ID as u32/);
  assert.match(line[1], /let spell_id = eid & 0xFFFF;/, "layer masked");
  assert.match(line[1], /if spell_id >= 0x8000 \{\s*return None;/, "cooldown ids silent");
  assert.match(line[1], /let name = name\?;/, "unknown spell silent");
  assert.match(line[1], /if spell_id == VITAE \{ " penalty" \} else \{ "" \}/);
  assert.match(line[1], /format!\("\{name\}\{penalty\} has expired\."\)/);
  const lines = cf.match(/pub\(crate\) fn enchantment_expired_lines<[\s\S]*?\n\}/);
  assert.ok(lines, "enchantment_expired_lines found");
  assert.match(lines[0], /if !textbox_visible\(TEXT_TYPE_MAGIC, globals_mask\) \{\s*return Vec::new\(\);/);
  assert.match(lines[0], /spell_name\(eid & 0xFFFF\)/);
  const flag = cf.match(/pub\(crate\) fn buff_expiry_line_enabled\(search: &str\) -> bool \{([\s\S]*?)\n\}/);
  assert.ok(flag, "buff_expiry_line_enabled found");
  for (const v of ["off", "0", "false"]) {
    assert.match(flag[1], new RegExp(`"buffExpiryLine=${v}"`), v);
  }
  assert.match(flag[1], /!trimmed\.split\('&'\)\.any/, "default ON (absent → enabled)");
  // Magic (7) is a legal squelch channel, so the global bit can drop it.
  const legal = cf.match(/fn is_legal_squelch_channel\(chat_type: u32\) -> bool \{([\s\S]*?)\n\}/);
  assert.ok(legal);
  assert.match(legal[1], /\b7\b/);
});
