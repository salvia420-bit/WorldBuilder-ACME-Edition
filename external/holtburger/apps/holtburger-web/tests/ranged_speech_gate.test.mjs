// tests/ranged_speech_gate.test.mjs — chat-errors-3 (2026-10-13).
//
// Retail gmCCommunicationSystem::HandleRangedTalkEvent (acclient.c:434662)
// prints a HearRangedSpeech line only when
// ACCWeenieObject::ObjectsInRange(player, sender, range, 0, 0) (:436730)
// holds: both objects known and their centre distance <= the wire range.
// ACE broadcasts a ranged Say emote to everyone within 96 m
// (WorldObject.LocalBroadcastRange) but writes the emote's Extent into the
// range field (EmoteManager.cs EmoteType.Say), so without the gate far-off
// NPC chatter filled the log and the speech bubbles.
//
// The decision is Rust (chat_format::ranged_speech_in_range, unit-tested
// natively); this pins the wasm wiring by source so the JS gate sees a
// regression without a wasm build. Escape: ?rangedSpeechGate=off.
//
// Run: node tests/ranged_speech_gate.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

// The body of one `GameMessage::<name>(` arm: up to the next GameMessage arm.
function arm(source, name) {
  const head = `GameMessage::${name}(`;
  const at = source.indexOf(head);
  assert.ok(at >= 0, `arm ${name} not found`);
  const next = source.indexOf("GameMessage::", at + head.length);
  return source.slice(at, next < 0 ? undefined : next);
}

test("HearRangedSpeech gates the line AND the bubble on the wire range", () => {
  const chat = src("src/session/messages/chat.rs");
  const body = arm(chat, "HearRangedSpeech");
  const gate = body.match(
    /if can_hear\(data\.sender, data\.chat_type, entry, globals_mask\)\s*&& \(!ranged_speech_gate_enabled\(&flag_search\(\)\)\s*\|\| ranged_speech_audible\(world, data\.sender, data\.range\)\)\s*\{/,
  );
  assert.ok(gate, "squelch + range gate on the arm's single if");
  const after = body.slice(gate.index + gate[0].length);
  const line = after.indexOf("kind: CLIENT_EVENT_KIND_CHAT_RECEIVED");
  const bubble = after.indexOf("kind: CLIENT_EVENT_KIND_OVERHEAD_SPEECH");
  assert.ok(line >= 0 && bubble > line, "both pushes sit inside the gated block");
  // kind=2 payload shape unchanged: chat_type in u32_payload.
  assert.match(after, /u32_payload: Some\(data\.chat_type\)/);
});

test("ranged_speech_audible resolves both objects from the world (unknown drops)", () => {
  const chat = src("src/session/messages/chat.rs");
  const m = chat.match(/fn ranged_speech_audible\([\s\S]*?\n\}/);
  assert.ok(m, "ranged_speech_audible found");
  const body = m[0];
  assert.match(body, /local_player_runtime_pose\(\)/, "player = client-predicted pose");
  assert.match(body, /player_position\(\)/, "falls back to the entity pose");
  assert.match(body, /w\.entities\.get\(sender\)\.map\(\|e\| &e\.position\)/);
  assert.match(body, /ranged_speech_in_range\(/);
  // No WorldState → no player object → dropped (retail).
  assert.match(body, /let Some\(w\) = cell\.as_ref\(\) else \{\s*return false;/);
});

test("the radar gate is not ported: other speech arms ignore range", () => {
  const chat = src("src/session/messages/chat.rs");
  for (const name of ["HearSpeech", "EmoteText", "SoulEmote", "ServerMessage"]) {
    const body = arm(chat, name);
    assert.doesNotMatch(body, /ranged_speech_/, name);
  }
});

test("chat_format: range helper + escape-flag parser", () => {
  const cf = src("src/chat_format.rs");
  const helper = cf.match(
    /pub\(crate\) fn ranged_speech_in_range\(\s*player: Option<&WorldPosition>,\s*sender: Option<&WorldPosition>,\s*is_self: bool,\s*range: f32,?\s*\) -> bool \{([\s\S]*?)\n\}/,
  );
  assert.ok(helper, "ranged_speech_in_range found");
  assert.match(helper[1], /if is_self \{\s*return true;/);
  assert.match(helper[1], /\(Some\(p\), Some\(s\)\) => p\.distance_to\(s\) <= range/, "inclusive centre distance");
  assert.match(helper[1], /_ => false/, "unknown object drops");
  const flag = cf.match(/pub\(crate\) fn ranged_speech_gate_enabled\(search: &str\) -> bool \{([\s\S]*?)\n\}/);
  assert.ok(flag, "ranged_speech_gate_enabled found");
  for (const v of ["off", "0", "false"]) {
    assert.match(flag[1], new RegExp(`"rangedSpeechGate=${v}"`), v);
  }
  assert.match(flag[1], /!trimmed\.split\('&'\)\.any/, "default ON (absent → enabled)");
});
