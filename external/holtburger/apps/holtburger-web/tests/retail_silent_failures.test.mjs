// tests/retail_silent_failures.test.mjs — chat-errors-1 (2026-10-13).
//
// Retail ClientCommunicationSystem::HandleFailureEvent (acclient.c:413716)
// prints nothing for a code its switch has no case for, and both
// Handle_Communication__WeenieError (:420742) and ...WithString (:422430)
// hand it every code. Vanilla ACE sends ITeleported (0x3C) after every portal
// (Portal.cs) and TurbineChatIsEnabled (0x51D) at every login
// (Player_Networking.cs), which reached chat as "I teleported." / "Turbine
// chat is enabled.". 0x51B / 0x51C ("You have entered/left the %s channel.")
// do have cases and keep printing.
//
// The decision is Rust (chat_format::weenie_error_chat_line +
// holtburger_core::errors::is_silent_failure, unit-tested natively); this
// pins the wasm wiring by source so the JS gate sees a regression without a
// wasm build. Escape: ?retailSilentFailures=off.
//
// Run: node tests/retail_silent_failures.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const core = (rel) => readFileSync(new URL(`../../../crates/${rel}`, import.meta.url), "utf8");

// The body of one `GameEvent::<name>(` arm: up to the next GameEvent arm.
function arm(source, name) {
  const head = `holtburger_protocol::messages::GameEvent::${name}(`;
  const at = source.indexOf(head);
  assert.ok(at >= 0, `arm ${name} not found`);
  const next = source.indexOf("holtburger_protocol::messages::GameEvent::", at + head.length);
  return source.slice(at, next < 0 ? undefined : next);
}

test("is_silent_failure covers 0x3B / 0x3C / 0x51D and not the channel lines", () => {
  const errors = core("holtburger-core/src/errors.rs");
  const m = errors.match(/pub fn is_silent_failure\(error: WeenieError\) -> bool \{([\s\S]*?)\n\}/);
  assert.ok(m, "is_silent_failure found");
  const body = m[1];
  for (const v of ["ILeftTheWorld", "ITeleported", "TurbineChatIsEnabled"]) {
    assert.match(body, new RegExp(`WeenieError::${v}\\b`), v);
  }
  for (const v of ["YouHaveEnteredTheChannel", "YouHaveLeftTheChannel"]) {
    assert.doesNotMatch(body, new RegExp(`WeenieError::${v}\\b`), v);
  }
});

test("both WeenieError arms route their chat line through the shared helper", () => {
  const ge = src("src/session/messages/game_event.rs");
  const bare = arm(ge, "WeenieError");
  const withString = arm(ge, "WeenieErrorWithString");
  for (const [name, body] of [["WeenieError", bare], ["WeenieErrorWithString", withString]]) {
    assert.match(body, /chat_format::retail_silent_failures_enabled\(\s*&flag_search\(\),?\s*\)/, name);
    // chat-errors-2 (2026-10-13) moved the arms to the `_with` form, which adds
    // the `?retailFailureText` flag after `retail_silent`; either form routes
    // through the shared helper.
    assert.match(body, /chat_format::weenie_error_chat_line(?:_with)?\(/, name);
    assert.match(body, /retail_silent,?\s*(?:retail_text,?\s*)?\)/, `${name} passes the flag`);
    assert.doesNotMatch(body, /errors::format_weenie_error\(/, `${name} has no direct (unsilenced) format`);
  }
  assert.match(withString, /Some\(data\.parameter\.as_str\(\)\)/, "the parameter still reaches the template");
  // The spell-cast subset still pushes kind=13 (F8-2 cast-cancel, rynth buff_loop).
  assert.match(bare, /if let Some\(text\) = spellcast_error_text\(code\)/);
  assert.match(bare, /kind: CLIENT_EVENT_KIND_USE_FAILED/);
  // The kind=2 payload keeps the WeenieError code in u32_payload.
  assert.match(bare, /u32_payload: Some\(code\)/);
  assert.match(withString, /u32_payload: Some\(code\)/);
});

test("UseDone keeps use-3's unconditional silence through the same helper", () => {
  const ge = src("src/session/messages/game_event.rs");
  const useDone = arm(ge, "UseDone");
  assert.match(useDone, /chat_format::weenie_error_chat_line(?:_with)?\(\s*data\.error,\s*None,\s*true,?\s*(?:retail_text,?\s*)?\)/);
  assert.match(useDone, /kind: CLIENT_EVENT_KIND_USE_FAILED/, "kind=13 unchanged");
  assert.doesNotMatch(useDone, /retail_silent_failures_enabled/);
});

test("chat_format: escape-flag parser and category guard", () => {
  const cf = src("src/chat_format.rs");
  const m = cf.match(/pub\(crate\) fn retail_silent_failures_enabled\(search: &str\) -> bool \{([\s\S]*?)\n\}/);
  assert.ok(m, "retail_silent_failures_enabled found");
  for (const v of ["off", "0", "false"]) {
    assert.match(m[1], new RegExp(`"retailSilentFailures=${v}"`), v);
  }
  assert.match(cf, /pub\(crate\) const FAILURE_CATEGORY_SYSTEM: u32 = 0;/);
  assert.match(cf, /pub\(crate\) const FAILURE_CATEGORY_MAGIC: u32 = 7;/);
  const ge = src("src/session/messages/game_event.rs");
  assert.match(ge, /FAILURE_CATEGORY_SYSTEM == CHAT_CATEGORY_SYSTEM/);
  assert.match(ge, /FAILURE_CATEGORY_MAGIC == CHAT_CATEGORY_MAGIC/);
  const lib = src("src/lib.rs");
  assert.match(lib, /const CHAT_CATEGORY_SYSTEM: u32 = 0;/);
  assert.match(lib, /const CHAT_CATEGORY_MAGIC: u32 = 7;/);
});
