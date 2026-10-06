// HUD kit — the shared retail-AC component vocabulary (HUD overhaul
// 2026-10-05).
//
// Every panel used to hand-roll its own tabs, buttons, checkboxes and
// scrollbars, so the HUD read as forty different UIs (native blue range
// sliders next to brass frames, tab labels drifting off their tabs,
// system-font emote panels). This module injects ONE stylesheet of
// `hbk-*` classes built from the retail DAT sprites the gm*UI layouts
// actually draw (sprite ids from `ui-layout-render` manifests of
// client_local_English.dat, exported to data/ui-sprites/ — see
// data/ui-sprites/INDEX-hud-kit-2026-10-05.json):
//
//   title bar     0x06004CFA  276×25 trapezoid (gmCharacterInfoUI TitleText)
//   close button  0x06001393 / 0x06001394 hover (ClosePanelButton)
//   red button    0x06004C4C / 4C4D hover / 4C4E pressed (VendorItemButton)
//   small button  0x060012BA (Clear Item/Clear List) / 0x06001927 brown
//   brass tag     0x06004D1C / 0x06004D1D (combat High/Medium/Low)
//   orb checkbox  0x06004D15 off / 4D16 off-hover / 4D17 on / 4D18 on-hover
//   rope scroll   0x06004C5F track, 0x06004C6C up / 0x06004C69 down caps
//   gold divider  0x060012C5 rule + 0x060012C4 end cap (examine dividers)
//   dark field    0x06004CC2 (every gm*UI background_* element)
//   stone field   0x0600128A (examination background)
//   selected slot 0x06004D09 (ItemSlot_Icon_Selected)
//   tab strip bg  0x06005F10 (vendor TabBackground)
//
// Modern liberties (deliberate): hover/focus states on everything,
// keyboard focus rings, larger hit targets on the 9-slice buttons,
// smooth 120 ms transitions. The look stays retail; the feel is 2026.
//
// Usage: add the classes; no JS needed. `installHudKit()` is idempotent
// and runs once at boot (index.html) — plugins never call it.

const STYLE_ID = "hb-hud-kit";
const SP = "./data/ui-sprites";

export const HUD_KIT_CSS = `
  :root {
    --hbk-gold: #d9b45a;
    --hbk-gold-bright: #f3d27a;
    --hbk-gold-dim: #8a7544;
    --hbk-gold-deep: #4e3f1f;
    --hbk-ink: #0b0c10;
    --hbk-field: #101216;
    --hbk-text: #e8dfc8;
    --hbk-text-dim: #a8a090;
    --hbk-text-faint: #77705f;
    --hbk-value: #8aef6d;
    --hbk-warn: #ff6a50;
    --hbk-sel: rgba(243, 210, 122, 0.16);
    --hbk-hover: rgba(243, 210, 122, 0.08);
    --hbk-font: var(--hb-font-serif, "Times New Roman", serif);
  }

  /* ── Window chrome ─────────────────────────────────────────────── */
  .hbk-window {
    position: fixed;
    box-sizing: border-box;
    color: var(--hbk-text);
    font-family: var(--hbk-font);
    font-size: 12px;
    background: url("${SP}/0x06004CC2.png") repeat, var(--hbk-ink);
    border: 1px solid var(--hbk-gold-dim);
    box-shadow:
      inset 0 0 0 1px #1c160b,
      inset 0 1px 0 1px rgba(243, 210, 122, 0.12),
      0 0 0 1px #000,
      0 10px 28px rgba(0, 0, 0, 0.7);
    pointer-events: auto;
    user-select: none;
  }
  .hbk-window.hbk-stone { background: url("${SP}/0x0600128A.png") center / cover, var(--hbk-ink); }
  .hbk-titlebar {
    position: relative;
    height: 25px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 30px 0 14px;
    border-style: solid;
    border-width: 0 14px 0 14px;
    border-image: url("${SP}/0x06004CFA.png") 0 14 0 14 fill / 0 14px 0 14px stretch;
    color: var(--hbk-gold-bright);
    font-size: 13px;
    letter-spacing: 0.04em;
    text-shadow: 0 1px 0 #000, 0 0 6px rgba(0, 0, 0, 0.9);
    white-space: nowrap;
    overflow: hidden;
    cursor: move;
    touch-action: none;
  }
  .hbk-titlebar > .hbk-title { overflow: hidden; text-overflow: ellipsis; }
  .hbk-close {
    position: absolute;
    top: 0; right: 0;
    width: 24px; height: 25px;
    border: 0; padding: 0; margin: 0;
    background: url("${SP}/0x06001393.png") center / 100% 100% no-repeat;
    cursor: pointer;
    image-rendering: pixelated;
  }
  .hbk-close:hover, .hbk-close:focus-visible { background-image: url("${SP}/0x06001394.png"); }
  .hbk-close:active { filter: brightness(0.8); }

  /* ── Tabs ──────────────────────────────────────────────────────── */
  .hbk-tabs {
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 2px 4px 0;
    background: url("${SP}/0x06005F10.png") repeat-x bottom / auto 100%;
    border-bottom: 1px solid var(--hbk-gold-dim);
    min-height: 20px;
  }
  .hbk-tab {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2px 6px 3px;
    border: 1px solid #3a2f18;
    border-bottom: 0;
    border-radius: 3px 3px 0 0;
    background: linear-gradient(180deg, #2a2418 0%, #15120c 100%);
    color: var(--hbk-text-dim);
    font-family: var(--hbk-font);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    white-space: nowrap;
    overflow: hidden;
    cursor: pointer;
    transition: color 120ms, background 120ms;
  }
  .hbk-tab:hover { color: var(--hbk-text); background: linear-gradient(180deg, #3a3020 0%, #1b170e 100%); }
  .hbk-tab[aria-selected="true"], .hbk-tab.is-active {
    color: var(--hbk-gold-bright);
    border-color: var(--hbk-gold-dim);
    background: linear-gradient(180deg, #4a3c1e 0%, #1d180d 100%);
    box-shadow: inset 0 1px 0 rgba(243, 210, 122, 0.25);
  }

  /* ── Buttons ───────────────────────────────────────────────────── */
  .hbk-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-height: 22px;
    min-width: 64px;
    padding: 0 10px;
    box-sizing: border-box;
    border-style: solid;
    border-width: 3px;
    border-image: url("${SP}/0x06004C4C.png") 3 fill / 3px stretch;
    background: transparent;
    color: #f6e8c8;
    font-family: var(--hbk-font);
    font-size: 12px;
    text-shadow: 0 1px 0 #000;
    cursor: pointer;
    white-space: nowrap;
  }
  .hbk-btn:hover, .hbk-btn:focus-visible { border-image-source: url("${SP}/0x06004C4D.png"); }
  .hbk-btn:active, .hbk-btn.is-pressed { border-image-source: url("${SP}/0x06004C4E.png"); }
  .hbk-btn:disabled, .hbk-btn.is-disabled {
    border-image-source: url("${SP}/0x06004C4E.png");
    color: var(--hbk-text-faint);
    cursor: default;
  }
  .hbk-btn-small {
    display: inline-flex; align-items: center; justify-content: center;
    min-height: 14px; min-width: 56px; padding: 0 6px;
    border: 1px solid #000;
    background: url("${SP}/0x060012BA.png") center / 100% 100% no-repeat;
    color: #f0e0c0; font-family: var(--hbk-font); font-size: 10px;
    cursor: pointer; white-space: nowrap;
  }
  .hbk-btn-small:hover { filter: brightness(1.25); }
  .hbk-btn-small:disabled { filter: grayscale(0.7) brightness(0.55); cursor: default; }
  .hbk-btn[hidden], .hbk-btn-small[hidden], .hbk-btn-brass[hidden], .hbk-icon-btn[hidden] { display: none; }
  .hbk-btn-small.hbk-brown { background-image: url("${SP}/0x06001927.png"); }
  .hbk-btn-brass {
    display: inline-flex; align-items: center; justify-content: center;
    min-height: 19px; min-width: 64px; padding: 0 8px;
    border: 0;
    background: url("${SP}/0x06004D1C.png") center / 100% 100% no-repeat;
    color: #fff4dc; font-family: var(--hbk-font); font-size: 11px;
    text-shadow: 0 1px 0 #000, 0 0 3px #000;
    cursor: pointer; white-space: nowrap;
  }
  .hbk-btn-brass:hover, .hbk-btn-brass.is-active { background-image: url("${SP}/0x06004D1D.png"); }
  .hbk-icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; padding: 0;
    border: 1px solid var(--hbk-gold-deep);
    background: rgba(0, 0, 0, 0.45);
    color: var(--hbk-text); cursor: pointer;
  }
  .hbk-icon-btn:hover { border-color: var(--hbk-gold-dim); color: var(--hbk-gold-bright); }

  /* ── Form controls ─────────────────────────────────────────────── */
  input.hbk-check, input.hbk-radio {
    appearance: none; -webkit-appearance: none;
    width: 13px; height: 13px; margin: 0 4px 0 0;
    flex: 0 0 13px;
    background: url("${SP}/0x06004D15.png") center / 100% 100% no-repeat;
    border: 0; cursor: pointer; vertical-align: middle;
    image-rendering: pixelated;
  }
  input.hbk-check:hover, input.hbk-radio:hover { background-image: url("${SP}/0x06004D16.png"); }
  input.hbk-check:checked, input.hbk-radio:checked { background-image: url("${SP}/0x06004D17.png"); }
  input.hbk-check:checked:hover, input.hbk-radio:checked:hover { background-image: url("${SP}/0x06004D18.png"); }
  input.hbk-check:focus-visible, input.hbk-radio:focus-visible { outline: 1px solid var(--hbk-gold); outline-offset: 1px; }
  .hbk-label { display: inline-flex; align-items: center; gap: 2px; cursor: pointer; color: var(--hbk-text); }

  input.hbk-range {
    appearance: none; -webkit-appearance: none;
    height: 14px; background: transparent; cursor: pointer; margin: 0;
  }
  input.hbk-range::-webkit-slider-runnable-track {
    height: 6px; border: 1px solid #000;
    background: linear-gradient(180deg, #050505, #241d10);
    box-shadow: inset 0 1px 2px #000, 0 1px 0 rgba(243, 210, 122, 0.12);
  }
  input.hbk-range::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 10px; height: 16px; margin-top: -6px;
    border: 1px solid #000; border-radius: 2px;
    background: linear-gradient(180deg, #f3d27a, #8a6a28);
    box-shadow: 0 1px 2px #000;
  }
  input.hbk-range::-moz-range-track { height: 6px; border: 1px solid #000; background: #15110a; }
  input.hbk-range::-moz-range-thumb { width: 10px; height: 16px; border: 1px solid #000; border-radius: 2px; background: linear-gradient(180deg, #f3d27a, #8a6a28); }

  input.hbk-input, textarea.hbk-input, select.hbk-select {
    box-sizing: border-box;
    min-height: 20px; padding: 2px 6px;
    border: 1px solid var(--hbk-gold-deep);
    background: rgba(0, 0, 0, 0.6);
    color: var(--hbk-text);
    font-family: var(--hbk-font); font-size: 12px;
    box-shadow: inset 0 1px 3px #000;
    outline: none;
  }
  input.hbk-input:focus, textarea.hbk-input:focus, select.hbk-select:focus { border-color: var(--hbk-gold-dim); }
  input.hbk-input::placeholder { color: var(--hbk-text-faint); font-style: italic; }
  select.hbk-select { cursor: pointer; padding-right: 18px; }
  select.hbk-select option { background: #15120c; color: var(--hbk-text); }

  /* ── Structure ─────────────────────────────────────────────────── */
  .hbk-divider {
    height: 8px; margin: 2px 0;
    background:
      url("${SP}/0x060012C4.png") right center / 17px 8px no-repeat,
      url("${SP}/0x060012C5.png") left center / calc(100% - 17px) 8px no-repeat;
  }
  .hbk-rule { height: 1px; margin: 4px 0; background: linear-gradient(90deg, transparent, var(--hbk-gold-dim) 15%, var(--hbk-gold-dim) 85%, transparent); }
  .hbk-section-title {
    display: flex; align-items: center; justify-content: space-between;
    padding: 3px 6px 2px;
    color: var(--hbk-gold-bright);
    font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
    background: linear-gradient(90deg, rgba(243, 210, 122, 0.14), transparent 80%);
    border-top: 1px solid rgba(243, 210, 122, 0.25);
    border-bottom: 1px solid rgba(0, 0, 0, 0.8);
  }
  .hbk-body { padding: 6px 8px; }
  .hbk-footer {
    display: flex; align-items: center; justify-content: flex-end; gap: 6px;
    padding: 5px 8px;
    border-top: 1px solid var(--hbk-gold-deep);
    background: rgba(0, 0, 0, 0.35);
  }
  .hbk-empty { padding: 18px 10px; text-align: center; color: var(--hbk-text-faint); font-style: italic; }
  .hbk-muted { color: var(--hbk-text-dim); }
  .hbk-value { color: var(--hbk-value); }
  .hbk-gold { color: var(--hbk-gold-bright); }
  .hbk-kv { display: flex; justify-content: space-between; gap: 8px; padding: 1px 0; }
  .hbk-kv > :first-child { color: var(--hbk-text-dim); }
  .hbk-kv > :last-child { color: var(--hbk-value); text-align: right; }

  /* Scroll container with the retail rope scrollbar. */
  /* NOTE: Chrome 121+ ignores every ::-webkit-scrollbar rule on an element
     that sets scrollbar-width / scrollbar-color, so the standard properties
     are only applied where the WebKit pseudo-elements don't exist
     (Firefox). Found by the chat-panel port, 2026-10-05. */
  .hbk-scroll {
    overflow-y: auto; overflow-x: hidden;
    overscroll-behavior: contain;
  }
  @supports not selector(::-webkit-scrollbar) {
    .hbk-scroll { scrollbar-width: thin; scrollbar-color: var(--hbk-gold-dim) #0a0806; }
  }
  .hbk-scroll::-webkit-scrollbar { width: 16px; height: 16px; }
  .hbk-scroll::-webkit-scrollbar-track {
    background: url("${SP}/0x06004C5F.png") center top / 16px 32px repeat-y, #0a0806;
  }
  .hbk-scroll::-webkit-scrollbar-thumb {
    border: 2px solid transparent; border-radius: 3px;
    background: linear-gradient(90deg, #6b5426, #f3d27a 45%, #b08a3c 70%, #5a4520) padding-box;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.6);
  }
  .hbk-scroll::-webkit-scrollbar-thumb:hover { filter: brightness(1.15); }
  .hbk-scroll::-webkit-scrollbar-button:single-button:vertical:decrement {
    display: block; height: 16px;
    background: url("${SP}/0x06004C6C.png") center / 16px 16px no-repeat;
  }
  .hbk-scroll::-webkit-scrollbar-button:single-button:vertical:increment {
    display: block; height: 16px;
    background: url("${SP}/0x06004C69.png") center / 16px 16px no-repeat;
  }
  .hbk-scroll::-webkit-scrollbar-corner { background: transparent; }

  /* Lists. */
  .hbk-list { display: flex; flex-direction: column; }
  .hbk-row {
    display: flex; align-items: center; gap: 6px;
    min-height: 20px; padding: 1px 6px;
    color: var(--hbk-text);
    border-left: 2px solid transparent;
    cursor: default;
  }
  .hbk-row:nth-child(even) { background: rgba(255, 255, 255, 0.02); }
  .hbk-row.is-clickable { cursor: pointer; }
  .hbk-row.is-clickable:hover, .hbk-row:hover { background: var(--hbk-hover); }
  .hbk-row.is-selected, .hbk-row[aria-selected="true"] {
    background: var(--hbk-sel);
    border-left-color: var(--hbk-gold);
    color: var(--hbk-gold-bright);
  }
  .hbk-row > .hbk-grow { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Item slots (32×32 retail ItemSlot_Generic). */
  .hbk-slot {
    position: relative;
    width: 32px; height: 32px;
    box-sizing: border-box;
    background: linear-gradient(180deg, #17181c, #0b0c0e);
    border: 1px solid #000;
    box-shadow: inset 1px 1px 0 rgba(255, 255, 255, 0.07), inset -1px -1px 0 rgba(0, 0, 0, 0.8);
  }
  .hbk-slot > img, .hbk-slot > canvas { position: absolute; inset: 0; width: 100%; height: 100%; image-rendering: pixelated; pointer-events: none; }
  .hbk-slot.is-selected::after {
    content: ""; position: absolute; inset: 0;
    background: url("${SP}/0x06004D09.png") center / 100% 100% no-repeat;
    pointer-events: none;
  }
  .hbk-slot.is-drop-target { box-shadow: 0 0 0 1px var(--hbk-gold-bright), 0 0 8px rgba(243, 210, 122, 0.6); }
  .hbk-slot .hbk-stack {
    position: absolute; right: 1px; bottom: 0;
    font-size: 9px; line-height: 1; color: #fff;
    text-shadow: 0 0 2px #000, 1px 1px 0 #000; pointer-events: none;
  }

  /* Meters (XP, burden, health). */
  .hbk-meter {
    position: relative; height: 12px;
    background: #060606; border: 1px solid #000;
    box-shadow: inset 0 1px 2px #000, 0 1px 0 rgba(243, 210, 122, 0.1);
    overflow: hidden;
  }
  .hbk-meter > .hbk-meter-fill {
    position: absolute; inset: 0 auto 0 0;
    width: var(--hbk-fill, 0%);
    background: var(--hbk-meter-color, linear-gradient(180deg, #d84030, #6a1010));
    transition: width 200ms ease-out;
  }
  .hbk-meter > .hbk-meter-label {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 10px; color: #fff; text-shadow: 0 0 2px #000, 1px 1px 0 #000;
  }

  /* Tooltips (retail ToolTip_ObjectName field 0x06004CC2). */
  .hbk-tooltip {
    position: fixed; z-index: 1000;
    max-width: 280px; padding: 4px 7px;
    background: url("${SP}/0x06004CC2.png") repeat, #0b0c10;
    border: 1px solid var(--hbk-gold-dim);
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.8);
    color: var(--hbk-text); font-family: var(--hbk-font); font-size: 12px;
    pointer-events: none;
  }

  /* Drag ghost for item drags (inventory/hotbar/loot share it). */
  .hbk-drag-ghost {
    position: fixed; z-index: 2000; pointer-events: none;
    width: 32px; height: 32px;
    opacity: 0.9; filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.8));
    transform: translate(-50%, -50%) scale(1.08);
  }
`;

/** Idempotent boot hook — injects the kit stylesheet once. */
export function installHudKit() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = HUD_KIT_CSS;
  // Prepend so per-plugin stylesheets (appended later) can override.
  document.head.prepend(style);
}

/**
 * Build a kit window titlebar: `<div class="hbk-titlebar"><span
 * class="hbk-title">…</span><button class="hbk-close"></button></div>`.
 * Returns { bar, title, close } — the caller wires drag/close.
 */
export function makeTitlebar(text, { onClose } = {}) {
  const bar = document.createElement("div");
  bar.className = "hbk-titlebar";
  const title = document.createElement("span");
  title.className = "hbk-title";
  title.textContent = text ?? "";
  bar.appendChild(title);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "hbk-close";
  close.title = "Close";
  close.setAttribute("aria-label", "Close");
  if (typeof onClose === "function") close.addEventListener("click", (e) => { e.stopPropagation(); onClose(); });
  bar.appendChild(close);
  return { bar, title, close };
}
