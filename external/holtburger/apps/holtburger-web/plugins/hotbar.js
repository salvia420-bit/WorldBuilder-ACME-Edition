// Hotbar — port of retail gmFloatyToolbarUI (layout 0x21000070, 18
// elements, 15 image DIDs). Retail size 310x100 with a 5px brass
// 9-slice frame. The 1-9 numbered slots are rendered content INSIDE
// the panel — the layout's image DIDs are only the frame chrome
// (corners 0x060074BF-C6 + edges 0x06006129-2D + move cursor
// 0x06006119). Slot art reuses the canonical icon-slot-bg sprite.
//
// First-pass behaviour:
//   - 9 brass-trim slots numbered 1-9 in a horizontal row.
//   - Drag-drop a spell from the Spellbook into a slot (uses the
//     existing `application/x-hb-spell-id` mime — same as combat-bar's
//     spell row drag handler).
//   - Click a bound slot to fire the bound spell/item; empty slots
//     are no-ops. Real fire wiring (cast spell / use item) is a
//     follow-on; for now it just logs via the chat-log.
//   - Number key 1-9 fires the matching slot if it's bound.

import { resolveLocalBinding, matchesBinding } from "./options-panel.js";

const OVERLAY_ID = "hb-hotbar";
const WIDTH = 310;
const HEIGHT = 40;            // single-row variant; retail's 100 is the
                              // two-row default. Stick to one row until
                              // we expose row-toggle.
const SLOT_SIZE = 30;
const SLOT_COUNT = 9;

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-hotbar-style";
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      bottom: 8px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 50;
      width: ${WIDTH}px;
      height: ${HEIGHT}px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0;
      padding: 4px 6px;
      pointer-events: none;
      font-family: var(--hb-font-serif);
      background: linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      border: 5px solid transparent;
      border-image: url("./sprites/acsprites/panel.png") 5 / 5px / 0 stretch;
      box-shadow: var(--hb-shadow-panel);
    }
    #${OVERLAY_ID} .hb-hotbar-row {
      display: flex;
      align-items: center;
      gap: 1px;
      pointer-events: auto;
    }
    #${OVERLAY_ID} .hb-hotbar-slot {
      position: relative;
      width: ${SLOT_SIZE}px;
      height: ${SLOT_SIZE}px;
      background: url("./sprites/acsprites/icon-slot-bg.png") center/100% 100% no-repeat;
      cursor: pointer;
      user-select: none;
      pointer-events: auto;
      transition: filter 120ms ease;
      image-rendering: pixelated;
    }
    #${OVERLAY_ID} .hb-hotbar-slot:hover {
      filter: brightness(1.2);
    }
    #${OVERLAY_ID} .hb-hotbar-slot.drag-over {
      filter: drop-shadow(0 0 4px rgba(120, 220, 120, 0.95));
    }
    #${OVERLAY_ID} .hb-hotbar-slot.bound .hb-hotbar-slot-icon {
      opacity: 1;
    }
    #${OVERLAY_ID} .hb-hotbar-slot-icon {
      position: absolute;
      top: 4px; left: 4px;
      right: 4px; bottom: 8px;
      background-position: center;
      background-size: contain;
      background-repeat: no-repeat;
      opacity: 0;
      pointer-events: none;
    }
    /* Number badge bottom-right of each slot. */
    #${OVERLAY_ID} .hb-hotbar-slot-num {
      position: absolute;
      bottom: 0;
      right: 2px;
      font-size: 9px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.95), 0 0 2px rgba(0, 0, 0, 0.85);
      pointer-events: none;
      line-height: 1;
    }
  `;
  document.head.appendChild(style);
}

const LS_KEY = "holtburger_hotbar_v1";
function loadState() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || { slots: Array(SLOT_COUNT).fill(null) }; }
  catch (_) { return { slots: Array(SLOT_COUNT).fill(null) }; }
}
function saveState(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (_) {}
}

export const manifest = {
  id: "hotbar",
  name: "Hotbar",
  icon: "1",
  iconHidden: true,
  version: "0.1.0",
  description: "Bottom-center 1-9 hotbar (gmFloatyToolbarUI 0x21000070)",
};

export function mount(ctx) {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  const row = document.createElement("div");
  row.className = "hb-hotbar-row";
  overlay.appendChild(row);

  const state = loadState();
  const slotEls = [];

  function renderSlot(idx) {
    const el = slotEls[idx];
    const bound = state.slots[idx];
    el.classList.toggle("bound", !!bound);
    const icon = el.querySelector(".hb-hotbar-slot-icon");
    if (bound && bound.spellId) {
      // Spell icon — try our spell-component icon table; fall back to
      // a generic spell glyph.
      icon.style.backgroundImage = "url('./data/ui-sprites/0x06004CC1.png')"; // compass disk as placeholder
      icon.style.opacity = "1";
    } else {
      icon.style.backgroundImage = "";
      icon.style.opacity = "0";
    }
  }

  function fireSlot(idx) {
    const bound = state.slots[idx];
    if (!bound) return;
    const client = ctx?.client ?? window.__pluginClient ?? null;
    if (bound.spellId && client?.player?.castSpell) {
      try { client.player.castSpell(bound.spellId); } catch (_) {}
    }
    // Mirror to chat for visibility.
    const src = document.getElementById("chat-log");
    if (src) {
      const li = document.createElement("li");
      li.dataset.cat = "0";
      li.className = "cat-0";
      li.textContent = `Hotbar ${idx + 1}: fired ${bound.spellId ? `spell 0x${bound.spellId.toString(16)}` : "(unbound)"}`;
      src.appendChild(li);
    }
  }

  for (let i = 0; i < SLOT_COUNT; i++) {
    const el = document.createElement("div");
    el.className = "hb-hotbar-slot";
    el.dataset.slot = String(i);

    const icon = document.createElement("div");
    icon.className = "hb-hotbar-slot-icon";
    el.appendChild(icon);

    const num = document.createElement("ac-text");
    num.className = "hb-hotbar-slot-num";
    num.textContent = String(i + 1);
    el.appendChild(num);

    // Click → fire.
    el.addEventListener("click", () => fireSlot(i));

    // Drag-drop: spellbook + combat-bar use mime "application/x-hb-spell-id".
    el.addEventListener("dragenter", (ev) => {
      const types = ev.dataTransfer?.types;
      if (types && Array.from(types).includes("application/x-hb-spell-id")) {
        ev.preventDefault();
        el.classList.add("drag-over");
      }
    });
    el.addEventListener("dragover", (ev) => {
      const types = ev.dataTransfer?.types;
      if (types && Array.from(types).includes("application/x-hb-spell-id")) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "copy";
      }
    });
    el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
    el.addEventListener("drop", (ev) => {
      el.classList.remove("drag-over");
      const sid = ev.dataTransfer?.getData("application/x-hb-spell-id");
      if (!sid) return;
      ev.preventDefault();
      state.slots[i] = { spellId: Number(sid) };
      saveState(state);
      renderSlot(i);
    });

    // Right-click → clear slot.
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      state.slots[i] = null;
      saveState(state);
      renderSlot(i);
    });

    row.appendChild(el);
    slotEls.push(el);
    renderSlot(i);
  }

  document.body.appendChild(overlay);

  // Hotbar slot keys 1-9 (default Digit1..Digit9). User-rebindable
  // via Options → Controls → Local Actions. Suppress while focused
  // on a text input (chat send, etc.).
  function onKey(ev) {
    const tag = ev.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    for (let slot = 1; slot <= SLOT_COUNT; slot++) {
      const hash = `0xFF00000${slot}`;
      const binding = resolveLocalBinding(hash, `Digit${slot}`);
      if (matchesBinding(ev, binding)) {
        fireSlot(slot - 1);
        return;
      }
    }
  }
  window.addEventListener("keydown", onKey);

  return () => {
    window.removeEventListener("keydown", onKey);
    overlay.remove();
  };
}
