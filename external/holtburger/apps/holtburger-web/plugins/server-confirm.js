// server-confirm — the player dialog for server confirmation requests
// (crafting-1, 2026-10-08 round 3).
//
// ACE asks the player a yes/no question through GameEvent 0x0274
// CharacterConfirmationRequest {type, context, text} and expects
// GameAction 0x0275 ConfirmationResponse {type, context, accepted}. Until
// now holtburger only parked these in the bot queue (pendingConfirmations,
// rynth), so a player could never answer: a tinker/imbue with the
// "chance of success" option on did nothing, fellowship invites and
// allegiance swears could not be accepted, aug gems and skill/attribute
// devices stalled, emote yes/no quests timed out.
//
// RETAIL (acclient.c):
//   ClientUISystem::Handle_Character__ConfirmationRequest (:401345)
//     1 SwearAllegiance → gmAllegianceUI::MakeAcceptSwearConfirmationDialog
//     4 Fellowship      → gmFellowshipUI::MakeFellowRequestDialog
//     2 AlterSkill / 3 AlterAttribute / 5 CraftInteraction / 6 Augmentation
//                       → gmGamePlayUI: server text + " Continue?"
//                         (RecvNotice_*_ConfirmationRequest :280624-280789)
//     7 YesNo           → gmGamePlayUI: the server text as-is (:280731)
//   The answer goes out as CM_Character::Event_ConfirmationResponse
//   (gmGamePlayUI::CloseGameplayConfirmationDialog :279392).
//   ClientUISystem::Handle_Character__ConfirmationDone (:401387) →
//   AbortConfirmationRequest closes the dialog for that (type, context)
//   (gmGamePlayUI :279309, gmFellowshipUI :201825, gmAllegianceUI :204131).
//
// ACE (~/ace-server ConfirmationManager.cs EnqueueAbort): on a timeout it
// sends ConfirmationDone and, for AlterSkill / AlterAttribute /
// CraftInteraction / Augmentation / YesNo, relies on the client's automatic
// "no" (retail's closed gameplay dialog answers through
// CloseGameplayConfirmationDialog) to clear the pending entry — without that
// answer the type stays busy server-side and the next request of that type
// is refused with ConfirmationInProgress. So those five types answer `false`
// when the server closes them; SwearAllegiance / Fellowship are resolved by
// ACE itself and just close.
//
// Wording: the gameplay types use the server's own text exactly as retail
// does. The fellowship and allegiance dialogs are localized string-table
// entries in retail (ID_Fellowship_FellowshipRequest /
// ID_Allegiance_AcceptSwearConfirmation, table enum 0x10000001) that
// holtburger cannot resolve yet; their text below is an English stand-in
// carrying the requester's name (ACE sends the name as the text).
//
// Wire-in: app/client_events.js turns ClientEvent kinds CONFIRMATION_REQUEST
// (70) / CONFIRMATION_DONE (71) into `hb:server-confirm-request` /
// `hb:server-confirm-done` window events. `?serverConfirmUi=off` (or 0 /
// false) disables the dialog; the bot queue is untouched either way.

import { modalConfirmCallback } from "./modal-dialog.js";

/** holtburger-common ConfirmationType (wire enum 0..=7). */
export const CONFIRM_TYPE = Object.freeze({
  UNDEFINED: 0,
  SWEAR_ALLEGIANCE: 1,
  ALTER_SKILL: 2,
  ALTER_ATTRIBUTE: 3,
  FELLOWSHIP: 4,
  CRAFT_INTERACTION: 5,
  AUGMENTATION: 6,
  YES_NO: 7,
});

/** `?serverConfirmUi` — DEFAULT-ON; `off` / `0` / `false` disables. */
export function serverConfirmUiEnabled(search) {
  try {
    const s = typeof search === "string"
      ? search
      : (typeof window !== "undefined" && window.location ? window.location.search : "");
    const v = new URLSearchParams(s).get("serverConfirmUi");
    if (v == null) return true;
    const t = String(v).toLowerCase();
    return !(t === "off" || t === "0" || t === "false");
  } catch (_) {
    return true;
  }
}

/**
 * The dialog for one request, or null when retail shows nothing (type 0 /
 * out of range).
 * @returns {{title:string, message:string, confirmLabel:string,
 *            cancelLabel:string, answerOnAbort:boolean}|null}
 */
export function confirmDialogSpec(type, text) {
  const t = (type >>> 0);
  const body = typeof text === "string" ? text : "";
  switch (t) {
    case CONFIRM_TYPE.ALTER_SKILL:
      return { title: "Alter Skill", message: `${body} Continue?`, confirmLabel: "Yes", cancelLabel: "No", answerOnAbort: true };
    case CONFIRM_TYPE.ALTER_ATTRIBUTE:
      return { title: "Alter Attribute", message: `${body} Continue?`, confirmLabel: "Yes", cancelLabel: "No", answerOnAbort: true };
    case CONFIRM_TYPE.CRAFT_INTERACTION:
      return { title: "Crafting", message: `${body} Continue?`, confirmLabel: "Yes", cancelLabel: "No", answerOnAbort: true };
    case CONFIRM_TYPE.AUGMENTATION:
      return { title: "Augmentation", message: `${body} Continue?`, confirmLabel: "Yes", cancelLabel: "No", answerOnAbort: true };
    case CONFIRM_TYPE.YES_NO:
      return { title: "Confirm", message: body, confirmLabel: "Yes", cancelLabel: "No", answerOnAbort: true };
    case CONFIRM_TYPE.FELLOWSHIP: {
      const who = body.trim() || "Someone";
      return {
        title: "Fellowship",
        message: `${who} has invited you to join a fellowship. Do you accept?`,
        confirmLabel: "Yes",
        cancelLabel: "No",
        answerOnAbort: false,
      };
    }
    case CONFIRM_TYPE.SWEAR_ALLEGIANCE: {
      const who = body.trim() || "Someone";
      return {
        title: "Allegiance",
        message: `${who} wishes to swear allegiance to you. Do you accept?`,
        confirmLabel: "Yes",
        cancelLabel: "No",
        answerOnAbort: false,
      };
    }
    default:
      return null;
  }
}

/**
 * Pure controller (DOM-free; unit-tested in tests/server_confirm.test.mjs).
 *   show(spec, onAnswer) → handle {dismiss()} | null
 *   respond(type, context, accepted)
 */
export function createServerConfirmController({ show, respond }) {
  /** key `${type}:${context}` → {type, context, spec, handle} */
  const open = new Map();
  const key = (type, context) => `${type >>> 0}:${context >>> 0}`;
  return {
    onRequest(type, context, text) {
      const t = type >>> 0;
      const c = context >>> 0;
      const spec = confirmDialogSpec(t, text);
      if (!spec) return false;
      const k = key(t, c);
      if (open.has(k)) return false; // duplicate delivery
      const rec = { type: t, context: c, spec, handle: null };
      open.set(k, rec);
      rec.handle = show(spec, (accepted) => {
        if (open.get(k) !== rec) return;
        open.delete(k);
        try { respond(t, c, !!accepted); } catch (_) {}
      }) ?? null;
      return true;
    },
    onDone(type, context) {
      const k = key(type, context);
      const rec = open.get(k);
      if (!rec) return false;
      open.delete(k);
      try { rec.handle?.dismiss?.(); } catch (_) {}
      if (rec.spec.answerOnAbort) {
        try { respond(rec.type, rec.context, false); } catch (_) {}
      }
      return true;
    },
    openCount() { return open.size; },
    clear() {
      for (const rec of open.values()) { try { rec.handle?.dismiss?.(); } catch (_) {} }
      open.clear();
    },
  };
}

function sendResponse(type, context, accepted) {
  const handle = (typeof window !== "undefined") ? window.__sessionHandle : null;
  if (typeof handle?.sendConfirmationResponse !== "function") {
    console.warn("[server-confirm] sendConfirmationResponse unavailable (stale wasm pkg?)");
    return;
  }
  try {
    handle.sendConfirmationResponse(type >>> 0, context >>> 0, !!accepted);
  } catch (e) {
    console.warn("[server-confirm] sendConfirmationResponse failed:", e);
  }
}

function showDialog(spec, onAnswer) {
  return modalConfirmCallback({
    title: spec.title,
    message: spec.message,
    confirmLabel: spec.confirmLabel,
    cancelLabel: spec.cancelLabel,
    onConfirm: () => onAnswer(true),
    onCancel: () => onAnswer(false),
  });
}

export const manifest = {
  id: "server-confirm",
  name: "Server Confirm",
  icon: "?",
  iconHidden: true,
  version: "0.1.0",
  description: "Yes/No dialog for server confirmation requests (craft chance, fellowship, allegiance, devices, quests).",
};

export function mount() {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  if (!serverConfirmUiEnabled()) return () => {};
  const ctl = createServerConfirmController({ show: showDialog, respond: sendResponse });
  const onRequest = (ev) => {
    const d = ev?.detail ?? {};
    ctl.onRequest(d.type, d.context, d.text);
  };
  const onDone = (ev) => {
    const d = ev?.detail ?? {};
    ctl.onDone(d.type, d.context);
  };
  window.addEventListener("hb:server-confirm-request", onRequest);
  window.addEventListener("hb:server-confirm-done", onDone);
  window.__serverConfirm = ctl;
  return () => {
    window.removeEventListener("hb:server-confirm-request", onRequest);
    window.removeEventListener("hb:server-confirm-done", onDone);
    ctl.clear();
    if (window.__serverConfirm === ctl) window.__serverConfirm = null;
  };
}
