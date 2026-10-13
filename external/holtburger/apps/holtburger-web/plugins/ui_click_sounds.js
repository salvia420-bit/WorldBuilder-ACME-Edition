// UI click sounds — fires sound 0x72 (UI_ButtonPress, ACE.Entity.Enum.Sound)
// when an interactive HUD control is pressed (left-button pointerdown; see
// Timing below for the drag-source and `?retailUiSounds=off` click cases).
// Delegated at the document level so a single listener covers every panel
// without each plugin needing to wire its own subscription.
//
// Selectors match the canonical interactive surfaces across plugins —
// inventory slots, paperdoll slots, hotbar/spellbook/combat-bar
// abilities, vendor rows, journal entries, generic [role=button]. The
// selector list is conservative; adding a class to a new control is
// the simplest way to opt in.
//
// Wire path (2026-10-05, retail parity): retail UI sounds play through
// SoundManager::PlaySoundFromCenter(stype, table) (acclient.c:383569-383589)
// — no position, no distance falloff, no pan; row probability rolled; row
// volume x effect slider — and UI elements' sounds come from the UI
// SoundTable (ClientUISystem::GetUISoundTable, acclient.c:401286:
// GetByEnum(0x10000003, 7), resolved through wasm resolveClientEnumDid;
// fallback 0x2000004B). The old path played the PLAYER's SoundTable row at
// the raw AC-frame player position (a different frame from the listener,
// so it went silent away from the origin) at a made-up x0.5.
//
// Timing (audio-2, 2026-10-13): retail's chime is the button's LayoutDesc
// Sound media, played when UIElement_Button::MouseDown (acclient.c:174702)
// sets mousePressedOnButton and UpdateState_ enters the Pressed state —
// on PRESS. MouseUp (174736) only broadcasts the click. `click` fires after
// the release, so the chime came late: by default it now rides a left-button
// `pointerdown`. `?retailUiSounds=off` (or 0/false) restores `click`.
// HTML5 drag sources (`draggable="true"`: inventory / hotbar / spell-bar
// slots, spell-research rows, …) keep the `click` chime even by default. A
// press there may start a drag, and a drag never fired `click`, so those
// drags were silent; chiming on their press would add a chime to every item
// or shortcut drag, which retail does not play. A plain click on one still
// chimes (on release). Narrowing CLICK_SELECTORS to real buttons is the
// separate audio-2 part (d).
//
// Programmatic API:
//   window.__playUiClickSound() — fire-and-forget; no-op if audio not ready
//
// References:
//   - plugins/audio_optimistic.js (playOptimistic pattern)
//   - ace-server/Source/ACE.Entity/Enum/Sound.cs UI_ButtonPress = 0x72
//   - memory `[Event-sound SYSTEMIC]` 0x20000001 humanoid fallback
//   - acclient_2013.bndb_pseudo_c.txt gmUI button-press call sites

import { playUiSound, retailUiSoundsEnabled } from "../scene3d/audio/retail_sound_rules.js";

const UI_BUTTON_PRESS = 0x72;

// Selectors covering common interactive HUD surfaces. Adding a new
// element class here (or applying one of these classes on a new
// button) is the simplest way to opt a control into the click chime.
const CLICK_SELECTORS = [
  ".hb-inv-slot",
  ".hb-inv-doll-slot",
  ".paperdoll-slot",
  ".spell-slot",
  ".ability-button",
  ".vendor-row",
  ".journal-entry",
  ".combat-ability",
  ".hb-hotbar-slot",
  ".hb-mp-tab",
  ".hb-alleg-vassal-row",
  ".hb-sr-row",
  "[role='button']",
  "button",
].join(", ");

let installed = false;
let lastClickAt = 0;
const DEDUPE_MS = 60;

export async function playUiClickSound() {
  try {
    return await playUiSound(window.liveScene3d, UI_BUTTON_PRESS);
  } catch (_) { /* best-effort */ }
}

function chimeFor(ev, onPress) {
  // Click-throttle — many UI elements live inside containers that ALSO
  // match the selectors (e.g. .hb-inv-slot inside a .vendor-row). The
  // throttle keeps the chime to one play per click chain.
  const now = (typeof performance !== "undefined") ? performance.now() : Date.now();
  if (now - lastClickAt < DEDUPE_MS) return;
  const target = ev.target;
  if (!target || typeof target.closest !== "function") return;
  const hit = target.closest(CLICK_SELECTORS);
  if (!hit) return;
  // Disabled controls don't chime — matches retail behaviour.
  if (hit.matches?.("[disabled]") || hit.dataset?.disabled === "1") return;
  lastClickAt = now;
  if (onPress) {
    // This capture listener runs before scene3d/index.js's window-bubble
    // autoplay gesture handler, so on the session's first press the
    // AudioContext would not exist yet and the chime would be dropped.
    // notifyUserGesture is idempotent; the press is a real user gesture.
    try { window.liveScene3d?.audioManager?.notifyUserGesture?.(); } catch (_) {}
  }
  void playUiClickSound();
}

// A press inside an HTML5 drag source may start a drag (header, Timing).
// Checked from the event target, so a draggable child of a matched control
// counts too. `el.draggable = true` reflects to the attribute.
const DRAG_SOURCE_SELECTOR = "[draggable='true']";
function inDragSource(ev) {
  const t = ev?.target;
  if (!t || typeof t.closest !== "function") return false;
  try { return !!t.closest(DRAG_SOURCE_SELECTOR); } catch (_) { return false; }
}

// audio-2 default: the chime on press (UIElement_Button::MouseDown, header).
// Left button only, as retail's press state; right/middle presses are silent.
// Drag sources are left to onDocumentClick.
function onDocumentPointerDown(ev) {
  if (!retailUiSoundsEnabled()) return;
  if (ev.button !== 0) return;
  if (inDragSource(ev)) return;
  chimeFor(ev, true);
}

// `?retailUiSounds=off`: the old chime on `click` (after the release), for
// every control. Default: only drag sources, whose press stayed silent.
function onDocumentClick(ev) {
  if (retailUiSoundsEnabled() && !inDragSource(ev)) return;
  chimeFor(ev, false);
}

export const manifest = {
  id: "ui-click-sounds",
  name: "UI Click Sounds",
  icon: "🔉",
  iconHidden: true,
  version: "0.1.0",
  description: "Fires UI_ButtonPress (0x72) when a HUD interactive control is pressed (document-delegated).",
};

export function mount() {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }
  if (!installed) {
    // Both listeners stay installed; each reads `?retailUiSounds` per event
    // and only one of them chimes. Capture phase, as before, so a panel that
    // stops propagation of its own press/click still chimes.
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    document.addEventListener("click", onDocumentClick, true);
    installed = true;
  }
  return () => {
    if (installed) {
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      document.removeEventListener("click", onDocumentClick, true);
      installed = false;
    }
  };
}

if (typeof window !== "undefined") {
  window.__playUiClickSound = playUiClickSound;
}
