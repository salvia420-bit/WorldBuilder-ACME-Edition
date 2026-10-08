// tests/use_fail_ground_object.test.mjs — use-3 remainder (2026-10-08
// follow-ups).
//
// Retail ClientCommunicationSystem::HandleFailureEvent (acclient.c:415858-415867)
// handles MotionFailure 0x23 / ObjectGone 0x37 / NoObject 0x38 / CantGetThere
// 0x39 with
//     ClientUISystem::SetGroundObject(GetUISystem(), 0, 1);
//     "Unable to move to object!"
// and Handle_Item__UseDone (acclient.c:401924) routes a UseDone(error) there.
// SetGroundObject (acclient.c:401643-401687) closes the OPEN ground container,
// sends Event_NoLongerViewingContents (askServer = 1) and drops a selection
// owned by it; with no ground container open it changes nothing.
//
// Holtburger: the ground container UI is plugins/corpse-loot-bar.js; its
// closeBar() sends noLongerViewingContents and clears its own selection. A
// kind:13 (UseFailed) carrying one of those codes now closes it.
//
// Pins plugins/weenie_error_messages.js clearsGroundObjectOnFailure /
// moveFailCloseGroundEnabled (`?moveFailCloseGround=off`), and the
// corpse-loot-bar kind:13 handler (spliced from source with stubs).
//
// Run: node tests/use_fail_ground_object.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GROUND_OBJECT_CLEAR_CODES,
  clearsGroundObjectOnFailure,
  moveFailCloseGroundEnabled,
} from "../plugins/weenie_error_messages.js";

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("the four retail move-failure codes clear the ground object", () => {
  assert.deepEqual([...GROUND_OBJECT_CLEAR_CODES], [0x23, 0x37, 0x38, 0x39]);
  for (const code of [0x23, 0x37, 0x38, 0x39]) {
    assert.equal(clearsGroundObjectOnFailure(code), true, `0x${code.toString(16)}`);
  }
  // You're too busy / Action cancelled / You cannot pick that up / charge
  // too far / no code: text only, no SetGroundObject.
  for (const code of [0x1d, 0x36, 0x29, 0x3d, 0, undefined, null]) {
    assert.equal(clearsGroundObjectOnFailure(code), false, String(code));
  }
});

test("?moveFailCloseGround: default on, off / 0 / false (any case) disable", () => {
  assert.equal(moveFailCloseGroundEnabled(""), true);
  assert.equal(moveFailCloseGroundEnabled("?nosw=1"), true);
  assert.equal(moveFailCloseGroundEnabled("?moveFailCloseGround=on"), true);
  for (const v of ["off", "0", "false", "OFF", "False"]) {
    assert.equal(moveFailCloseGroundEnabled(`?moveFailCloseGround=${v}`), false, v);
  }
  assert.equal(moveFailCloseGroundEnabled("?nosw=1&moveFailCloseGround=off"), false);
});

test("reader falls back to location.search when no string is passed", () => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "location");
  const prev = globalThis.location;
  try {
    globalThis.location = { search: "?moveFailCloseGround=off" };
    assert.equal(moveFailCloseGroundEnabled(), false);
    globalThis.location = { search: "" };
    assert.equal(moveFailCloseGroundEnabled(), true);
  } finally {
    if (had) globalThis.location = prev;
    else delete globalThis.location;
  }
});

/** Extract `function name(...) { ... }` from `text` by brace matching. */
function extractFunction(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  let depth = 0;
  for (let i = text.indexOf("{", start); i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`${name}: unbalanced braces`);
}

function loadHandler({ open, corpseGuid, flagOn = true }) {
  const body = extractFunction(src("plugins/corpse-loot-bar.js"), "onUseFailedClearGroundObject");
  const calls = { closeBar: 0 };
  const overlayEl = open === undefined ? null : { dataset: { open: open ? "1" : "0" } };
  const state = { corpseGuid };
  const factory = new Function(
    "clearsGroundObjectOnFailure",
    "moveFailCloseGroundEnabled",
    "overlayEl",
    "state",
    "closeBar",
    `${body}\nreturn onUseFailedClearGroundObject;`,
  );
  const handler = factory(
    clearsGroundObjectOnFailure,
    () => flagOn,
    overlayEl,
    state,
    () => { calls.closeBar += 1; },
  );
  return { handler, calls };
}

test("a UseDone move failure closes the OPEN ground container (CustomEvent detail)", () => {
  const { handler, calls } = loadHandler({ open: true, corpseGuid: 0xc0ffee01 });
  handler({ detail: { kind: 13, u32Payload: 0x38 } });
  assert.equal(calls.closeBar, 1);
});

test("other failure codes, a closed window, or the escape leave it alone", () => {
  let h = loadHandler({ open: true, corpseGuid: 0xc0ffee01 });
  h.handler({ detail: { kind: 13, u32Payload: 0x1d } });
  assert.equal(h.calls.closeBar, 0, "You're too busy! is text only");

  h = loadHandler({ open: false, corpseGuid: 0 });
  h.handler({ detail: { kind: 13, u32Payload: 0x39 } });
  assert.equal(h.calls.closeBar, 0, "nothing open: SetGroundObject(0) is a no-op");

  h = loadHandler({ open: undefined, corpseGuid: 0 });
  h.handler({ detail: { kind: 13, u32Payload: 0x23 } });
  assert.equal(h.calls.closeBar, 0, "no window built yet");

  h = loadHandler({ open: true, corpseGuid: 0xc0ffee01, flagOn: false });
  h.handler({ detail: { kind: 13, u32Payload: 0x37 } });
  assert.equal(h.calls.closeBar, 0, "?moveFailCloseGround=off");
});

test("wiring: subscribed on kind:13, and closeBar tells the server", () => {
  const text = src("plugins/corpse-loot-bar.js");
  assert.match(text, /client\.events\.on\("kind:13", onUseFailedClearGroundObject\)/);
  const close = extractFunction(text, "closeBar");
  assert.match(close, /noLongerViewingContents/, "the askServer leg of SetGroundObject(0, 1)");
  assert.match(close, /state\.selectedGuid = 0/, "the owned-selection drop");
});
