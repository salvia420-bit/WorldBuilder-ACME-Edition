// tests/server_confirm.test.mjs — crafting-1 (2026-10-08 round 3).
//
// Retail ClientUISystem::Handle_Character__ConfirmationRequest
// (acclient.c:401345) hands every server ConfirmationRequest (GameEvent
// 0x0274) to a player dialog; the gameplay types append " Continue?" to the
// server text (gmGamePlayUI::RecvNotice_*_ConfirmationRequest :280624-280789),
// YesNo shows the text as-is (:280731). ConfirmationDone (0x0276,
// Handle_Character__ConfirmationDone :401387) closes the dialog for that
// (type, context); ACE's ConfirmationManager.EnqueueAbort relies on the
// client's automatic "no" for AlterSkill / AlterAttribute / CraftInteraction /
// Augmentation / YesNo to clear the pending entry.
//
// Pins plugins/server-confirm.js (pure controller + dialog specs), the
// modal-dialog dismiss handle, the client_events.js wiring and the wasm
// emit (by source).
//
// Run: node tests/server_confirm.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CONFIRM_TYPE, confirmDialogSpec, createServerConfirmController, serverConfirmUiEnabled,
} from "../plugins/server-confirm.js";

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("gameplay types append ' Continue?' to the server text and answer no on abort", () => {
  const text = "You determine that you have a 42 percent chance to succeed.";
  for (const t of [CONFIRM_TYPE.ALTER_SKILL, CONFIRM_TYPE.ALTER_ATTRIBUTE,
    CONFIRM_TYPE.CRAFT_INTERACTION, CONFIRM_TYPE.AUGMENTATION]) {
    const spec = confirmDialogSpec(t, text);
    assert.equal(spec.message, `${text} Continue?`);
    assert.equal(spec.answerOnAbort, true);
    assert.equal(spec.confirmLabel, "Yes");
    assert.equal(spec.cancelLabel, "No");
  }
  const yn = confirmDialogSpec(CONFIRM_TYPE.YES_NO, "Do you wish to proceed?");
  assert.equal(yn.message, "Do you wish to proceed?", "YesNo shows the text as-is");
  assert.equal(yn.answerOnAbort, true);
});

test("fellowship / allegiance carry the requester name and are closed (not answered) on abort", () => {
  const f = confirmDialogSpec(CONFIRM_TYPE.FELLOWSHIP, "Gaerlan");
  assert.match(f.message, /^Gaerlan /);
  assert.equal(f.answerOnAbort, false);
  const a = confirmDialogSpec(CONFIRM_TYPE.SWEAR_ALLEGIANCE, "Gaerlan");
  assert.match(a.message, /^Gaerlan /);
  assert.equal(a.answerOnAbort, false);
  assert.equal(confirmDialogSpec(CONFIRM_TYPE.UNDEFINED, "x"), null, "type 0: retail shows nothing");
  assert.equal(confirmDialogSpec(9, "x"), null);
});

function harness() {
  const shown = [];
  const sent = [];
  const ctl = createServerConfirmController({
    show: (spec, onAnswer) => {
      const rec = { spec, onAnswer, dismissed: false };
      shown.push(rec);
      return { dismiss: () => { rec.dismissed = true; return true; } };
    },
    respond: (type, context, accepted) => sent.push([type, context, accepted]),
  });
  return { ctl, shown, sent };
}

test("a request shows one dialog; Yes / No answer with the same (type, context)", () => {
  const { ctl, shown, sent } = harness();
  assert.equal(ctl.onRequest(5, 17, "42%"), true);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].spec.message, "42% Continue?");
  shown[0].onAnswer(true);
  assert.deepEqual(sent, [[5, 17, true]]);
  assert.equal(ctl.openCount(), 0);
  ctl.onRequest(7, 18, "Sure?");
  shown[1].onAnswer(false);
  assert.deepEqual(sent[1], [7, 18, false]);
});

test("ConfirmationDone closes the dialog; gameplay types send the automatic no, social ones do not", () => {
  const { ctl, shown, sent } = harness();
  ctl.onRequest(5, 20, "craft");
  assert.equal(ctl.onDone(5, 20), true);
  assert.equal(shown[0].dismissed, true);
  assert.deepEqual(sent, [[5, 20, false]]);
  shown[0].onAnswer(true); // a late click after the close is ignored
  assert.equal(sent.length, 1);

  ctl.onRequest(4, 21, "Gaerlan");
  assert.equal(ctl.onDone(4, 21), true);
  assert.equal(shown[1].dismissed, true);
  assert.equal(sent.length, 1, "fellowship: ACE resolves the timeout itself");

  assert.equal(ctl.onDone(5, 999), false, "unknown context → nothing");
});

test("duplicate delivery and unknown types are ignored", () => {
  const { ctl, shown } = harness();
  ctl.onRequest(5, 30, "a");
  assert.equal(ctl.onRequest(5, 30, "a"), false);
  assert.equal(ctl.onRequest(0, 31, "a"), false);
  assert.equal(shown.length, 1);
});

test("?serverConfirmUi: default on, off/0/false disable", () => {
  assert.equal(serverConfirmUiEnabled(""), true);
  assert.equal(serverConfirmUiEnabled("?serverConfirmUi=on"), true);
  for (const v of ["off", "0", "false", "OFF"]) {
    assert.equal(serverConfirmUiEnabled(`?serverConfirmUi=${v}`), false, v);
  }
});

test("wiring: wasm emits kinds 70/71, client_events dispatches window events, modal-dialog can dismiss", () => {
  const lib = src("src/lib.rs");
  assert.match(lib, /const CLIENT_EVENT_KIND_CONFIRMATION_REQUEST: u32 = 70;/);
  assert.match(lib, /const CLIENT_EVENT_KIND_CONFIRMATION_DONE: u32 = 71;/);
  const ge = src("src/session/messages/game_event.rs");
  assert.match(ge, /kind: CLIENT_EVENT_KIND_CONFIRMATION_REQUEST/);
  assert.match(ge, /GameEvent::CharacterConfirmationDone\(/);
  assert.match(ge, /pending_confirmations\.borrow_mut\(\)\.push/, "the bot queue stays");
  const kinds = src("scene3d/client_event_kinds.js");
  assert.match(kinds, /CONFIRMATION_REQUEST: 70,/);
  assert.match(kinds, /CONFIRMATION_DONE: 71,/);
  const ce = src("app/client_events.js");
  assert.match(ce, /hb:server-confirm-request/);
  assert.match(ce, /hb:server-confirm-done/);
  const md = src("plugins/modal-dialog.js");
  assert.match(md, /dismiss: \(\) => dismissEntry\(entry\)/);
  const idx = JSON.parse(src("plugins/index.json"));
  assert.ok(idx.plugins.some((p) => p.manifestPath === "./server-confirm.manifest.json"));
});
