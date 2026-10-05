// UI click sounds — fires sound 0x72 (UI_ButtonPress, ACE.Entity.Enum.Sound)
// on every interactive HUD click. Delegated at the document level so a
// single listener covers every panel without each plugin needing to
// wire its own subscription.
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
// Programmatic API:
//   window.__playUiClickSound() — fire-and-forget; no-op if audio not ready
//
// References:
//   - plugins/audio_optimistic.js (playOptimistic pattern)
//   - ace-server/Source/ACE.Entity/Enum/Sound.cs UI_ButtonPress = 0x72
//   - memory `[Event-sound SYSTEMIC]` 0x20000001 humanoid fallback
//   - acclient_2013.bndb_pseudo_c.txt gmUI button-press call sites

import { playUiSound } from "../scene3d/audio/retail_sound_rules.js";

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

function onDocumentClick(ev) {
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
  void playUiClickSound();
}

export const manifest = {
  id: "ui-click-sounds",
  name: "UI Click Sounds",
  icon: "🔉",
  iconHidden: true,
  version: "0.1.0",
  description: "Fires UI_ButtonPress (0x72) on every HUD interactive click (document-delegated).",
};

export function mount() {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }
  if (!installed) {
    document.addEventListener("click", onDocumentClick, true);
    installed = true;
  }
  return () => {
    if (installed) {
      document.removeEventListener("click", onDocumentClick, true);
      installed = false;
    }
  };
}

if (typeof window !== "undefined") {
  window.__playUiClickSound = playUiClickSound;
}
