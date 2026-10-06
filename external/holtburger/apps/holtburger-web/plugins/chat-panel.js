// Bottom-left main chat window — retail port of gmFloatyMainChatUI
// (LayoutDesc 0x2100006F, root RootFloatyMainChat_Field 0x10000600, 410×100).
//
// HUD overhaul 2026-10-05 — rebuilt on the retail sprites + HUD kit.
//
// Retail layout (ui-layout-render manifest m-6F.json, element-sprites.txt):
//   frame        0,0 410×100   8 pieces: corners 0x06006129, top 0x0600612A,
//                              left 0x0600612B, bottom 0x0600612C, right 0x0600612D
//   ChatLogField 5,5 400×73    dark field 0x06004CC2
//     FloatingChat1-4  5,5+17k 16×16   0x06006218 (lit 0x06006219), font 0x40000025
//     ChatLog          21,5 368×73     the text pane
//     NewNonVisibleTextIndicator 21,62 16×16 (Ghosted until text arrives off-screen)
//     MaximizeButton   368,5 16×16     0x06005E65 (maximised 0x06005E64)
//     ChatLogScrollbar 389,5 16×73     gold rope 0x06004C5F
//   ChatEntryField 5,78 400×17 gold bar 0x0600113A
//     ChatTarget   5,78 46×17  brass tag 0x06004D65 (hover 0x06004D66), "Chat" font 0x40000002
//     ChatPanelTextEntry 51,78 306×17
//     SendButton   359,78 46×17 0x06001915 (pressed 0x06001916), "Send" font 0x40000002
//
// What the "before" got wrong and how this version fixes it at the root:
//   • filter-tab labels drawn BELOW 12-px tab boxes (a 16-px ac-text canvas in
//     a 12-px button) and overlapping the first line → the four retail 16×16
//     left-edge buttons, one 11×13-font glyph each (exactly what retail drew).
//   • a yellow orb over the 3rd line → that was the hand-drawn "new messages"
//     badge (retail ChatLogNewNonVisibleTextIndicator), lit because auto-scroll
//     measured line heights before the per-line font canvases had rendered.
//     Lines are now real wrapping text, the log tracks a PINNED flag from user
//     scrolls (not a measurement at append time), and unread text raises a
//     "N new messages" pill that never sits in the text column.
//   • "Send" clipped / unfinished input row → the retail gold entry bar, brass
//     tag and Send sprite, sized to the 17-px row.
//
// Modern liberties: wrapping, selectable text with a hanging indent; resizable
// (top edge + corners), draggable by the frame and the left gutter; jump-to-
// latest pill; click a sender's name to start a tell (retail StartTell);
// coloured talk-focus menu; Enter focuses the chat bar, Esc leaves it.
//
// Lines are mirrored from the canonical #chat-log (app/chat_log.js
// appendChatLine), and sends are forwarded to #chat-form so the outbound
// chat hook (plugins/chat-hooks.js), slash routing (app/slash_commands.js)
// and echo stay on one path.
//
// URL knob: `?chatFade=1` (persisted `hb_chat_panel_fade`) — retail default/
// active opacity: 45% at rest, opaque on hover or while typing.

import { setAcText } from "../ui/ac_font.js";
import {
  attachWindowPosition, attachEdgeResizers, persistWindowSize, WINDOW_ID,
} from "../ui/ac_window_position.js";
import { attachCornerResizers } from "../ui/ac_resize_corners.js";
import { hudRect, hudViewport, HUD_SCALE_EVENT } from "../ui/hud_scale.js";
import {
  CHAT_FILTERS, normalizeFilterId, lineVisibleInFilter, filterGroupForCategory,
  chatLineStyle, colorForCategory, TALK_FOCUSES, talkFocusById,
  buildOutgoingLine, parseChatSender, isNearBottom, unreadLabel,
  formatChatTimestamp, computeMaximizedRect, FILTER_GROUP,
} from "../app/chat_log.js";

const OVERLAY_ID = "hb-chat-panel";
const STYLE_ID = "hb-chat-panel-style";
const SP = "./data/ui-sprites";
const WIDTH = 410;            // RootFloatyMainChat_Field 0x10000600
const HEIGHT = 100;
// Retail's minimum is the default box: four 16-px filter buttons (67 px) +
// 17-px entry row + 10-px frame.
const MIN_W = 260;
const MIN_H = 100;
const MAX_W = 1000;
const MAX_H = 640;
const MAX_LINES = 300;        // scrollback; source #chat-log keeps 400
const FILTER_FONT_ID = 0x40000025;  // FloatingChat1-4 label font (11×13)
const BUTTON_FONT_ID = 0x40000002;  // ChatTargetButtonText / SendButton (16×16)
const LABEL_COLOR = "#fff4dc";
const LS_FILTER = "hb_chat_panel_filter";
const LS_SAVED_HEIGHT = "hb_chat_panel_saved_height";   // maximise sentinel (pre-overhaul key)
const LS_FADE = "hb_chat_panel_fade";
const LS_CHAR_OPTIONS = "holtburger_character_options_v1"; // options-panel local cache
const OPT_STAY_IN_CHAT = 0x0B;   // CharacterOption StayInChatModeAfterSendingMessage
const OPT_TIMESTAMPS = 0x21;     // CharacterOption DisplayTimestamps
// pointerdown on these never starts a window drag.
const DRAG_IGNORE = "button, input, .hb-chat-log, .hb-chat-menu, .hb-chat-pill, .hb-resize-edge, .hb-resize-corner";

const CSS = `
  #${OVERLAY_ID} {
    --hb-chat-text-font: "Times New Roman", Times, "Liberation Serif", "Nimbus Roman", serif;
    position: fixed;
    left: 8px;
    bottom: 8px;
    z-index: 50;
    /* Retail 410, but never into the centred toolbar (310 wide) on a
       narrow HUD viewport (HUD overhaul 2026-10-05; a persisted user size
       still wins via the inline style). */
    width: min(${WIDTH}px, calc(50 * var(--hb-hud-vw, 1vw) - 171px));
    height: ${HEIGHT}px;
    min-width: ${MIN_W}px;
    min-height: ${MIN_H}px;
    box-sizing: border-box;
    padding: 5px;
    display: grid;
    grid-template-rows: minmax(0, 1fr) 17px;
    color: var(--hbk-text, #e8dfc8);
    font-family: var(--hbk-font, serif);
    pointer-events: auto;
    user-select: none;
    -webkit-user-select: none;
    touch-action: none;
    /* Retail 8-piece frame (MainChat*Corner/Border, 0x1000069B-6A2). */
    background:
      url("${SP}/0x06006129.png") left top / 5px 5px no-repeat,
      url("${SP}/0x06006129.png") right top / 5px 5px no-repeat,
      url("${SP}/0x06006129.png") left bottom / 5px 5px no-repeat,
      url("${SP}/0x06006129.png") right bottom / 5px 5px no-repeat,
      url("${SP}/0x0600612A.png") left top / 10px 5px repeat-x,
      url("${SP}/0x0600612C.png") left bottom / 10px 5px repeat-x,
      url("${SP}/0x0600612B.png") left top / 5px 10px repeat-y,
      url("${SP}/0x0600612D.png") right top / 5px 10px repeat-y,
      #0b0c10;
    box-shadow: 0 0 0 1px #000, 0 6px 18px rgba(0, 0, 0, 0.6);
  }
  #${OVERLAY_ID}.hb-window-dragging { cursor: grabbing; }
  #${OVERLAY_ID}[data-fade="1"] { opacity: 0.45; transition: opacity 0.3s ease-out; }
  #${OVERLAY_ID}[data-fade="1"]:hover,
  #${OVERLAY_ID}[data-fade="1"]:focus-within { opacity: 1; transition: opacity 0.15s ease-in; }
  #${OVERLAY_ID} ac-text { line-height: 0; pointer-events: none; }
  #${OVERLAY_ID} ac-text > canvas { display: block; }

  /* ChatLogField 0x10000010 — gutter column + text pane + rope. */
  #${OVERLAY_ID} .hb-chat-body {
    position: relative;
    min-height: 0;
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr);
    background: url("${SP}/0x06004CC2.png") repeat, #0b0c10;
  }
  #${OVERLAY_ID} .hb-chat-gutter {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-height: 0;
    overflow: hidden;
    cursor: move;
  }
  /* FloatingChat1-4 (0x10000522-525) — one glyph each, retail font. */
  #${OVERLAY_ID} .hb-chat-filter {
    flex: 0 0 16px;
    width: 16px;
    height: 16px;
    margin: 0;
    padding: 0;
    border: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background: url("${SP}/0x06006218.png") 0 0 / 100% 100% no-repeat;
    color: ${LABEL_COLOR};
    font: 10px/1 var(--hb-chat-text-font);
    cursor: pointer;
  }
  #${OVERLAY_ID} .hb-chat-filter:hover { filter: brightness(1.2); }
  #${OVERLAY_ID} .hb-chat-filter[aria-selected="true"] {
    background-image: url("${SP}/0x06006219.png");
    box-shadow: 0 0 4px rgba(243, 210, 122, 0.75);
  }
  #${OVERLAY_ID} .hb-chat-filter:focus-visible { outline: 1px solid var(--hbk-gold-bright, #f3d27a); outline-offset: 0; }

  /* ChatLog 0x10000011 + ChatLogScrollbar 0x10000012 (the rope is the
     kit's hbk-scroll track). Chrome ignores ::-webkit-scrollbar styling
     whenever scrollbar-width/-color are set, so reset them to auto here and
     keep the thin gold fallback for engines without the pseudo-elements. */
  #${OVERLAY_ID} .hb-chat-log {
    grid-column: 2;
    min-height: 0;
    min-width: 0;
    box-sizing: border-box;
    overflow-x: hidden;
    overflow-y: scroll;
    padding: 1px 18px 2px 4px;   /* right: keeps text clear of MaximizeButton */
    font: 13px/15px var(--hb-chat-text-font);
    cursor: auto;
    user-select: text;
    -webkit-user-select: text;
    touch-action: pan-y;
    overscroll-behavior: contain;
    scrollbar-width: auto;
    scrollbar-color: auto;
  }
  @supports not selector(::-webkit-scrollbar) {
    #${OVERLAY_ID} .hb-chat-log { scrollbar-width: thin; scrollbar-color: var(--hbk-gold-dim, #8a7544) #0a0806; }
  }
  /* Retail's chat rope has no arrow caps. */
  #${OVERLAY_ID} .hb-chat-log::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
  #${OVERLAY_ID} .hb-chat-line {
    margin: 0;
    padding: 0 0 0 12px;
    text-indent: -12px;          /* hanging indent: wrapped rows sit under the text */
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    text-shadow: 0 1px 0 #000, 0 0 2px #000;
  }
  #${OVERLAY_ID} .hb-chat-ts { display: none; color: #8f8670; }
  #${OVERLAY_ID} .hb-chat-log[data-ts="1"] .hb-chat-ts { display: inline; }
  #${OVERLAY_ID} .hb-chat-name { cursor: pointer; }
  #${OVERLAY_ID} .hb-chat-name:hover { text-decoration: underline; }
  #${OVERLAY_ID} .hb-chat-log[data-filter="local"] > .hb-chat-line:not([data-grp="local"]),
  #${OVERLAY_ID} .hb-chat-log[data-filter="tell"] > .hb-chat-line:not([data-grp="tell"]),
  #${OVERLAY_ID} .hb-chat-log[data-filter="channels"] > .hb-chat-line:not([data-grp="chan"]) { display: none; }
  #${OVERLAY_ID} .hb-chat-empty {
    position: absolute;
    left: 20px;
    right: 36px;
    top: 2px;
    display: none;
    color: var(--hbk-text-faint, #77705f);
    font: italic 12px/15px var(--hb-chat-text-font);
    pointer-events: none;
  }
  #${OVERLAY_ID}[data-empty="1"] .hb-chat-empty { display: block; }
  /* MaximizeButton 0x1000046F — top-right of the text pane, beside the rope. */
  #${OVERLAY_ID} .hb-chat-max {
    position: absolute;
    top: 0;
    right: 16px;
    z-index: 2;
    width: 16px;
    height: 16px;
    margin: 0;
    padding: 0;
    border: 0;
    background: url("${SP}/0x06005E65.png") 0 0 / 100% 100% no-repeat;
    cursor: pointer;
  }
  #${OVERLAY_ID}[data-maximized="1"] .hb-chat-max { background-image: url("${SP}/0x06005E64.png"); }
  #${OVERLAY_ID} .hb-chat-max:hover { filter: brightness(1.25); }
  #${OVERLAY_ID} .hb-chat-max:focus-visible { outline: 1px solid var(--hbk-gold-bright, #f3d27a); }
  /* ChatLogNewNonVisibleTextIndicator 0x1000048C, as a jump-to-latest pill
     in the bottom-right of the pane (only while scrolled up). */
  #${OVERLAY_ID} .hb-chat-pill {
    position: absolute;
    right: 22px;
    bottom: 3px;
    z-index: 3;
    display: none;
    align-items: center;
    gap: 4px;
    height: 16px;
    margin: 0;
    padding: 0 8px;
    box-sizing: border-box;
    border: 1px solid var(--hbk-gold-dim, #8a7544);
    border-radius: 8px;
    background: rgba(12, 10, 6, 0.94);
    box-shadow: 0 1px 4px #000;
    color: var(--hbk-gold-bright, #f3d27a);
    font: 11px/14px var(--hb-chat-text-font);
    white-space: nowrap;
    cursor: pointer;
  }
  #${OVERLAY_ID} .hb-chat-pill.is-visible { display: inline-flex; }
  #${OVERLAY_ID} .hb-chat-pill:hover { border-color: var(--hbk-gold-bright, #f3d27a); }

  /* ChatEntryField 0x10000013 — gold bar, brass tag, field, Send. */
  #${OVERLAY_ID} .hb-chat-entry {
    position: relative;
    display: flex;
    align-items: stretch;
    min-width: 0;
    height: 17px;
    /* Retail draws the 500-px bar clipped at its native size; stretch only
       once the window is wider than the sprite. */
    background: url("${SP}/0x0600113A.png") left top / max(100%, 500px) 17px no-repeat, #6e5420;
  }
  #${OVERLAY_ID} .hb-chat-target {
    flex: 0 0 auto;
    min-width: 46px;
    max-width: 110px;
    height: 17px;
    box-sizing: border-box;
    margin: 0;
    padding: 0;
    border-style: solid;
    border-width: 0 8px 0 12px;
    border-image: url("${SP}/0x06004D65.png") 0 8 0 12 fill / 0 8px 0 12px stretch;
    background: transparent;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    color: ${LABEL_COLOR};
    font: 11px/1 var(--hb-chat-text-font);
    cursor: pointer;
  }
  #${OVERLAY_ID} .hb-chat-target:hover,
  #${OVERLAY_ID} .hb-chat-target:focus-visible,
  #${OVERLAY_ID} .hb-chat-target[aria-expanded="true"] { border-image-source: url("${SP}/0x06004D66.png"); outline: none; }
  #${OVERLAY_ID} .hb-chat-input {
    flex: 1 1 auto;
    min-width: 60px;
    height: 15px;
    min-height: 0;
    margin: 1px 2px 1px 1px;
    padding: 0 5px;
    box-sizing: border-box;
    border: 1px solid rgba(0, 0, 0, 0.75);
    background: rgba(10, 8, 3, 0.62);
    box-shadow: inset 0 1px 2px #000;
    color: #ffffff;
    font: 12px/13px var(--hb-chat-text-font);
    outline: none;
    user-select: text;
    -webkit-user-select: text;
  }
  #${OVERLAY_ID} .hb-chat-input:focus {
    border-color: var(--hbk-gold-bright, #f3d27a);
    background: rgba(6, 5, 2, 0.8);
    box-shadow: inset 0 1px 2px #000, 0 0 4px rgba(243, 210, 122, 0.45);
  }
  #${OVERLAY_ID} .hb-chat-input::placeholder { color: #cbbd8e; font-style: italic; opacity: 0.8; }
  #${OVERLAY_ID} .hb-chat-input.is-error { border-color: var(--hbk-warn, #ff6a50); }
  #${OVERLAY_ID} .hb-chat-send {
    flex: 0 0 46px;
    width: 46px;
    height: 17px;
    margin: 0;
    padding: 0;
    border: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background: url("${SP}/0x06001915.png") 0 0 / 100% 100% no-repeat;
    color: ${LABEL_COLOR};
    font: 11px/1 var(--hb-chat-text-font);
    cursor: pointer;
  }
  #${OVERLAY_ID} .hb-chat-send:hover,
  #${OVERLAY_ID} .hb-chat-send:focus-visible { background-image: url("${SP}/0x06001916.png"); outline: none; }
  #${OVERLAY_ID} .hb-chat-send:active { filter: brightness(0.85); }

  /* Talk-focus popup (gmMainChatUI::InitTalkFocusMenu). */
  #${OVERLAY_ID} .hb-chat-menu {
    position: absolute;
    left: 5px;
    bottom: 24px;
    z-index: 20;
    display: none;
    min-width: 170px;
    max-height: 320px;
    padding: 3px 0;
    box-sizing: border-box;
    background: url("${SP}/0x06004CC2.png") repeat, #0b0c10;
    border: 1px solid var(--hbk-gold-dim, #8a7544);
    box-shadow: inset 0 0 0 1px #1c160b, 0 0 0 1px #000, 0 8px 22px rgba(0, 0, 0, 0.75);
    cursor: default;
    touch-action: pan-y;
  }
  #${OVERLAY_ID} .hb-chat-menu[data-open="1"] { display: block; }
  #${OVERLAY_ID} .hb-chat-menu .hbk-row { min-height: 18px; padding: 1px 8px; cursor: pointer; outline: none; }
  #${OVERLAY_ID} .hb-chat-menu .hbk-row:focus-visible { background: var(--hbk-hover, rgba(243, 210, 122, 0.08)); }
  #${OVERLAY_ID} .hb-chat-menu .hbk-row[aria-checked="true"] {
    background: var(--hbk-sel, rgba(243, 210, 122, 0.16));
    border-left-color: var(--hbk-gold, #d9b45a);
  }
  #${OVERLAY_ID} .hb-chat-menu .hbk-rule { margin: 3px 6px; }
`;

function ensureStyles() {
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== CSS) style.textContent = CSS;
}

function readLocal(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}
function writeLocal(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (_) {}
}

// CharacterOption read — same source order as options-panel.js
// readCharacterOption: the live wasm bitfield, else the local cache.
function readCharOption(idx) {
  const h = typeof window !== "undefined" ? window.__sessionHandle : null;
  if (h && typeof h.isCharacterOptionEnabled === "function") {
    try { return !!h.isCharacterOptionEnabled(idx >>> 0); } catch (_) {}
  }
  try {
    const raw = readLocal(LS_CHAR_OPTIONS);
    const obj = raw ? JSON.parse(raw) : null;
    return !!(obj && obj[String(idx)]);
  } catch (_) { return false; }
}

const GROUP_TO_FILTER = Object.freeze({
  [FILTER_GROUP.LOCAL]: "local", [FILTER_GROUP.TELL]: "tell", [FILTER_GROUP.CHAN]: "channels",
});

export const manifest = {
  id: "chat-panel",
  name: "Chat",
  icon: "💬",
  iconHidden: true,
  version: "0.2.0",
  description: "Bottom-left chat panel (retail gmFloatyMainChatUI 0x2100006F)",
};

export function mount(_ctx) {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.setAttribute("role", "region");
  overlay.setAttribute("aria-label", "Chat");
  overlay.dataset.maximized = "0";

  // Opt-in fade: `?chatFade=1` or persisted `hb_chat_panel_fade=1`.
  try {
    const p = new URLSearchParams(window.location.search).get("chatFade");
    if (p === "1") writeLocal(LS_FADE, "1");
    else if (p === "0") writeLocal(LS_FADE, null);
  } catch (_) {}
  if (readLocal(LS_FADE) === "1") overlay.dataset.fade = "1";

  // ── Body: gutter + log + maximize + pill + empty state ────────────────
  const body = document.createElement("div");
  body.className = "hb-chat-body";

  const gutter = document.createElement("div");
  gutter.className = "hb-chat-gutter";
  gutter.setAttribute("role", "tablist");
  gutter.setAttribute("aria-orientation", "vertical");
  gutter.setAttribute("aria-label", "Chat filters");
  const filterBtns = new Map();
  for (const f of CHAT_FILTERS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hb-chat-filter";
    btn.dataset.filter = f.id;
    btn.title = f.title;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-label", f.title);
    btn.setAttribute("aria-selected", "false");
    setAcText(btn, f.key, { fontId: FILTER_FONT_ID, color: LABEL_COLOR });
    gutter.appendChild(btn);
    filterBtns.set(f.id, btn);
  }
  body.appendChild(gutter);

  const log = document.createElement("div");
  log.className = "hb-chat-log hbk-scroll";
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");
  log.setAttribute("aria-label", "Chat messages");
  body.appendChild(log);

  const emptyEl = document.createElement("div");
  emptyEl.className = "hb-chat-empty";
  body.appendChild(emptyEl);

  const maxBtn = document.createElement("button");
  maxBtn.type = "button";
  maxBtn.className = "hb-chat-max";
  maxBtn.title = "Expand chat";
  maxBtn.setAttribute("aria-label", "Expand chat");
  body.appendChild(maxBtn);

  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "hb-chat-pill";
  pill.title = "Jump to the latest message";
  body.appendChild(pill);

  overlay.appendChild(body);

  // ── Entry row: talk-focus tag, field, Send ────────────────────────────
  const entry = document.createElement("div");
  entry.className = "hb-chat-entry";

  const targetBtn = document.createElement("button");
  targetBtn.type = "button";
  targetBtn.className = "hb-chat-target";
  targetBtn.setAttribute("aria-haspopup", "menu");
  targetBtn.setAttribute("aria-expanded", "false");
  entry.appendChild(targetBtn);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "hb-chat-input hbk-input";
  input.autocomplete = "off";
  input.spellcheck = true;
  input.maxLength = 240;
  input.setAttribute("aria-label", "Chat message");
  entry.appendChild(input);

  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "hb-chat-send";
  sendBtn.title = "Send (Enter)";
  sendBtn.setAttribute("aria-label", "Send");
  setAcText(sendBtn, "Send", { fontId: BUTTON_FONT_ID, color: LABEL_COLOR });
  entry.appendChild(sendBtn);

  overlay.appendChild(entry);

  const menu = document.createElement("div");
  menu.className = "hb-chat-menu hbk-scroll";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Talk to");
  const menuItems = new Map();
  let lastSection = TALK_FOCUSES[0].section;
  for (const f of TALK_FOCUSES) {
    if (f.section !== lastSection) {
      const rule = document.createElement("div");
      rule.className = "hbk-rule";
      rule.setAttribute("role", "separator");
      menu.appendChild(rule);
      lastSection = f.section;
    }
    const item = document.createElement("div");
    item.className = "hbk-row is-clickable";
    item.dataset.focus = f.id;
    item.tabIndex = -1;
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", "false");
    item.setAttribute("aria-label", f.menu);
    setAcText(item, f.menu, { color: colorForCategory(f.category) });
    menu.appendChild(item);
    menuItems.set(f.id, item);
  }
  overlay.appendChild(menu);

  // ── Window chrome: size, resize, drag ─────────────────────────────────
  // Size persists in the unified hb.window.<CHAT> entry (x/y written by
  // attachWindowPosition below share it).
  const sizeP = persistWindowSize(overlay, WINDOW_ID.CHAT, {
    minW: MIN_W, minH: MIN_H, maxW: MAX_W, maxH: MAX_H,
  });
  // One-shot migration of the pre-unification hb_chat_panel_width/height.
  try {
    const w = parseInt(readLocal("hb_chat_panel_width") ?? "", 10);
    const h = parseInt(readLocal("hb_chat_panel_height") ?? "", 10);
    if ((Number.isFinite(w) && w > 0) || (Number.isFinite(h) && h > 0)) {
      sizeP.commit(Number.isFinite(w) && w > 0 ? w : null, Number.isFinite(h) && h > 0 ? h : null);
      writeLocal("hb_chat_panel_width", null);
      writeLocal("hb_chat_panel_height", null);
    }
  } catch (_) {}
  // A size saved before the retail minimum existed (old min 220×70) would
  // clip the filter column — lift it to the minimum once.
  {
    const s = sizeP.getSize();
    if ((s.width != null && s.width < MIN_W) || (s.height != null && s.height < MIN_H)) {
      sizeP.commit(s.width != null ? Math.max(MIN_W, s.width) : null,
                   s.height != null ? Math.max(MIN_H, s.height) : null);
    }
  }

  document.body.appendChild(overlay);

  // Keep the box docked to its nearer vertical edge after a resize or a
  // maximise (the resizers write `top`; a bottom-docked chat must keep
  // `bottom` so it stays docked when the browser or HUD scale changes).
  function reanchorVertical() {
    if (!overlay.isConnected) return;
    const r = hudRect(overlay);
    const vp = hudViewport();
    if (r.top + r.height / 2 > vp.height / 2) {
      overlay.style.bottom = `${Math.max(0, vp.height - r.bottom)}px`;
      overlay.style.top = "auto";
    } else {
      overlay.style.top = `${Math.max(0, r.top)}px`;
      overlay.style.bottom = "auto";
    }
  }
  function onUserResize({ width, height }) {
    sizeP.commit(width, height);
    if (overlay.dataset.maximized === "1") setMaximized(false, { keepSize: true });
    reanchorVertical();
    if (pinned) scrollToBottom();
  }
  const edgeResizers = attachEdgeResizers(overlay, {
    edges: ["top"],
    windowId: WINDOW_ID.CHAT,
    minWidth: MIN_W, minHeight: MIN_H, maxWidth: MAX_W, maxHeight: MAX_H,
    onSizeChange: onUserResize,
  });
  const cornerResizers = attachCornerResizers(overlay, {
    windowId: WINDOW_ID.CHAT,
    size: 6,
    minWidth: MIN_W, minHeight: MIN_H, maxWidth: MAX_W, maxHeight: MAX_H,
    onSizeChange: onUserResize,
  });
  // Drag by the frame, the gutter and the bar margins (zoom-aware,
  // edge-anchored persistence). Same key the old installDragPersistence used.
  attachWindowPosition(overlay, {
    windowId: WINDOW_ID.CHAT,
    dragHandle: overlay,
    ignoreSelector: DRAG_IGNORE,
    legacyKey: "hb_panel_pos_chat-panel",
  });

  // Never larger than the HUD viewport (a box sized at HUD scale 1 can be
  // too big once the scale or the window changes). Transient — not saved.
  function fitToViewport() {
    if (!overlay.isConnected) return;
    const vp = hudViewport();
    const r = hudRect(overlay);
    const maxW = Math.max(MIN_W, Math.floor(vp.width - 8));
    const maxH = Math.max(MIN_H, Math.floor(vp.height - 8));
    if (r.width > maxW + 0.5) overlay.style.width = `${maxW}px`;
    if (r.height > maxH + 0.5) overlay.style.height = `${maxH}px`;
  }

  // ── Log model ─────────────────────────────────────────────────────────
  let filter = normalizeFilterId(readLocal(LS_FILTER));
  let pinned = true;
  let unread = 0;
  const counts = { local: 0, tell: 0, chan: 0, other: 0 };

  function visibleCount() {
    if (filter === "all") return counts.local + counts.tell + counts.chan + counts.other;
    return counts[filterGroupFor(filter)] ?? 0;
  }
  function filterGroupFor(id) {
    return id === "local" ? "local" : id === "tell" ? "tell" : id === "channels" ? "chan" : null;
  }
  function updateEmpty() {
    const f = CHAT_FILTERS.find((x) => x.id === filter) ?? CHAT_FILTERS[0];
    const empty = visibleCount() === 0;
    overlay.dataset.empty = empty ? "1" : "0";
    if (empty && emptyEl.textContent !== f.empty) emptyEl.textContent = f.empty;
  }
  function showUnread() {
    if (unread <= 0) { pill.classList.remove("is-visible"); return; }
    pill.textContent = `${unreadLabel(unread)} ↓`;
    pill.classList.add("is-visible");
  }
  function clearUnread() {
    if (unread === 0 && !pill.classList.contains("is-visible")) return;
    unread = 0;
    showUnread();
  }
  function scrollToBottom() {
    log.scrollTop = log.scrollHeight;
    pinned = true;
    clearUnread();
  }
  // Pinned is USER intent: only a scroll that leaves the bottom un-pins.
  log.addEventListener("scroll", () => {
    pinned = isNearBottom(log);
    if (pinned) clearUnread();
  }, { passive: true });
  // Retail gmMainChatUI::ResizeTo (acclient.c:254374) keeps the log at its
  // end across a resize when it was at the end.
  let ro = null;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => { if (pinned) log.scrollTop = log.scrollHeight; });
    ro.observe(log);
  }
  pill.addEventListener("click", () => scrollToBottom());

  function refreshTimestampFlag() {
    const on = readCharOption(OPT_TIMESTAMPS) ? "1" : "0";
    if (log.dataset.ts !== on) log.dataset.ts = on;
  }

  function setFilter(id, { persist = true } = {}) {
    filter = normalizeFilterId(id);
    log.dataset.filter = filter;
    for (const [fid, btn] of filterBtns) btn.setAttribute("aria-selected", fid === filter ? "true" : "false");
    if (persist) writeLocal(LS_FILTER, filter);
    // Keep the dev-page #chat-log in step (same data-tab vocabulary).
    const src = document.getElementById("chat-log");
    if (src) src.dataset.tab = filter;
    updateEmpty();
    scrollToBottom();
  }
  gutter.addEventListener("click", (ev) => {
    const btn = ev.target.closest?.(".hb-chat-filter[data-filter]");
    if (btn) setFilter(btn.dataset.filter);
  });
  gutter.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    const ids = CHAT_FILTERS.map((f) => f.id);
    const i = ids.indexOf(filter);
    const next = ids[(i + (ev.key === "ArrowDown" ? 1 : ids.length - 1)) % ids.length];
    ev.preventDefault();
    ev.stopPropagation();
    setFilter(next);
    filterBtns.get(next)?.focus();
  });

  function buildLine(text, cat, isEcho, ts) {
    const style = chatLineStyle(cat, text, isEcho);
    const line = document.createElement("div");
    line.className = "hb-chat-line";
    line.dataset.grp = style.group;
    line.dataset.cat = String(style.category);
    if (isEcho) line.classList.add("is-echo");
    line.style.color = style.color;
    const tsEl = document.createElement("span");
    tsEl.className = "hb-chat-ts";
    tsEl.textContent = `${formatChatTimestamp(ts)} `;
    line.appendChild(tsEl);
    // Chat text is untrusted — text nodes only, never innerHTML.
    const sender = isEcho ? null : parseChatSender(text);
    if (sender) {
      if (sender.start > 0) line.appendChild(document.createTextNode(text.slice(0, sender.start)));
      const name = document.createElement("span");
      name.className = "hb-chat-name";
      name.dataset.name = sender.name;
      name.title = `Send a tell to ${sender.name}`;
      name.textContent = sender.name;
      line.appendChild(name);
      line.appendChild(document.createTextNode(text.slice(sender.end)));
    } else {
      line.appendChild(document.createTextNode(text));
    }
    return line;
  }

  function trimLines() {
    let n = log.childElementCount;
    while (n > MAX_LINES) {
      const first = log.firstElementChild;
      if (!first) break;
      const g = first.dataset.grp;
      if (counts[g] != null) counts[g] = Math.max(0, counts[g] - 1);
      first.remove();
      n -= 1;
    }
  }

  // Mirror one #chat-log <li>. `batch` defers the scroll/empty bookkeeping
  // to the caller (initial sync).
  function mirrorOne(srcLi, batch = false) {
    if (!srcLi || srcLi.classList?.contains("empty")) return;
    const text = srcLi.textContent || "";
    if (!text) return;
    const isEcho = srcLi.classList.contains("echo");
    const ts = Number(srcLi.dataset?.ts) || Date.now();
    const line = buildLine(text, srcLi.dataset?.cat ?? null, isEcho, ts);
    log.appendChild(line);
    counts[line.dataset.grp] = (counts[line.dataset.grp] ?? 0) + 1;
    trimLines();
    if (batch) return;
    refreshTimestampFlag();
    updateEmpty();
    // Your own message always brings you back to the latest line.
    if (pinned || isEcho) scrollToBottom();
    else if (lineVisibleInFilter(filter, line.dataset.grp)) { unread += 1; showUnread(); }
  }

  let observer = null;
  let retryTimer = null;
  function attachSource(src) {
    for (const li of src.children) mirrorOne(li, true);
    refreshTimestampFlag();
    updateEmpty();
    scrollToBottom();
    observer = new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (node?.tagName === "LI") mirrorOne(node);
        }
      }
    });
    observer.observe(src, { childList: true });
  }
  const sourceLog = document.getElementById("chat-log");
  if (sourceLog) {
    attachSource(sourceLog);
  } else {
    // index.html hasn't mounted #chat-log yet (we ran first); retry. The
    // handle is mount-scoped so teardown cancels it (a remount must not
    // leave an orphan interval that attaches a second observer).
    retryTimer = setInterval(() => {
      const src = document.getElementById("chat-log");
      if (!src) return;
      clearInterval(retryTimer);
      retryTimer = null;
      attachSource(src);
    }, 250);
  }

  // ── Talk focus (ChatTarget 0x10000014) ───────────────────────────────
  let activeFocus = TALK_FOCUSES[0];
  function placeholderFor(f) {
    switch (f.id) {
      case "say": return "Press Enter to chat";
      case "emote": return "Describe an action, e.g. waves hello";
      case "tell": return "Name, message";
      case "reply": {
        const who = typeof window !== "undefined" ? window.__chatLastIncomingTellSender : null;
        return who ? `Reply to ${who}` : "No one has sent you a tell yet";
      }
      default: return `Message ${f.menu}`;
    }
  }
  function setTalkFocus(id, { focusInput = true, widen = true } = {}) {
    activeFocus = talkFocusById(id);
    setAcText(targetBtn, activeFocus.label, { fontId: BUTTON_FONT_ID, color: LABEL_COLOR });
    targetBtn.title = `Talking to: ${activeFocus.menu} (click to change)`;
    targetBtn.setAttribute("aria-label", `Talk to: ${activeFocus.menu}`);
    input.style.color = colorForCategory(activeFocus.category);
    input.placeholder = placeholderFor(activeFocus);
    for (const [fid, item] of menuItems) item.setAttribute("aria-checked", fid === activeFocus.id ? "true" : "false");
    // You always see what you send: if the current filter would hide this
    // channel, switch to the channel's own filter (player picks only — the
    // initial "Chat" focus must not override a saved filter).
    const g = filterGroupForCategory(activeFocus.category);
    if (widen && !lineVisibleInFilter(filter, g)) setFilter(GROUP_TO_FILTER[g] ?? "all");
    if (focusInput) activate();
  }

  let menuOpen = false;
  function openMenu() {
    if (menuOpen) return;
    menuOpen = true;
    menu.dataset.open = "1";
    targetBtn.setAttribute("aria-expanded", "true");
    // Open upward from the tag; flip below the bar when the window sits
    // too close to the top of the HUD viewport. HUD px throughout.
    const r = hudRect(overlay);
    const vp = hudViewport();
    const natural = menu.scrollHeight;
    const above = r.bottom - 24 - 4;
    const below = vp.height - r.bottom - 6;
    if (above >= Math.min(natural, 160) || above >= below) {
      menu.style.top = "auto";
      menu.style.bottom = "24px";
      menu.style.maxHeight = `${Math.max(80, Math.floor(above))}px`;
    } else {
      menu.style.bottom = "auto";
      menu.style.top = "calc(100% + 2px)";
      menu.style.maxHeight = `${Math.max(80, Math.floor(below))}px`;
    }
    (menuItems.get(activeFocus.id) ?? menu.querySelector(".hbk-row"))?.focus({ preventScroll: false });
  }
  function closeMenu({ refocus = false } = {}) {
    if (!menuOpen) return;
    menuOpen = false;
    menu.dataset.open = "0";
    targetBtn.setAttribute("aria-expanded", "false");
    if (refocus) targetBtn.focus();
  }
  targetBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (menuOpen) closeMenu();
    else openMenu();
  });
  menu.addEventListener("click", (ev) => {
    const item = ev.target.closest?.("[data-focus]");
    if (!item) return;
    closeMenu();
    setTalkFocus(item.dataset.focus);
  });
  menu.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    const items = [...menuItems.values()];
    const i = items.indexOf(document.activeElement);
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const n = items.length;
      const next = items[(i < 0 ? 0 : i + (ev.key === "ArrowDown" ? 1 : n - 1)) % n];
      next?.focus();
    } else if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      if (i >= 0) { closeMenu(); setTalkFocus(items[i].dataset.focus); }
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      closeMenu({ refocus: true });
    }
  });
  const onDocPointerDown = (ev) => {
    if (!menuOpen) return;
    if (menu.contains(ev.target) || targetBtn.contains(ev.target)) return;
    closeMenu();
  };
  document.addEventListener("pointerdown", onDocPointerDown, true);

  // ── Chat entry (ChatInterface Activate/DeactivateChatEntry) ───────────
  function activate() {
    refreshTimestampFlag();
    if (activeFocus.id === "reply") input.placeholder = placeholderFor(activeFocus);
    input.focus({ preventScroll: true });
    const n = input.value.length;
    try { input.setSelectionRange(n, n); } catch (_) {}
  }
  function deactivate() {
    closeMenu();
    input.blur();
    const src = document.getElementById("chat-input");
    if (src && document.activeElement === src) src.blur();
  }

  // Retail ChatInterface::StartTell (acclient.c:288028) — clicking a sender
  // puts a tell to them in the entry.
  function startTell(name) {
    if (!name) return;
    setTalkFocus("tell", { focusInput: false });
    input.value = `${name}, `;
    activate();
  }
  log.addEventListener("click", (ev) => {
    const nameEl = ev.target.closest?.(".hb-chat-name");
    if (!nameEl) return;
    const sel = typeof window.getSelection === "function" ? window.getSelection() : null;
    if (sel && !sel.isCollapsed) return;   // the player is selecting text
    startTell(nameEl.dataset.name);
  });

  // Up/Down recall (retail ChatInterface::SelectCommandFromHistory,
  // acclient.c:287558).
  const history = [];
  const HISTORY_MAX = 64;
  let historyCursor = -1;
  let historyDraft = "";
  function pushHistory(text) {
    const t = (text ?? "").trim();
    if (!t) return;
    if (history.length === 0 || history[history.length - 1] !== t) {
      history.push(t);
      if (history.length > HISTORY_MAX) history.shift();
    }
    historyCursor = -1;
    historyDraft = "";
  }
  function recallHistory(direction) {
    if (history.length === 0) return;
    if (historyCursor === -1) {
      // Down with nothing recalled yet has no newer entry to move to.
      if (direction !== "up") return;
      historyDraft = input.value;
      historyCursor = history.length - 1;
    } else {
      historyCursor += direction === "up" ? -1 : 1;
      historyCursor = Math.max(0, Math.min(history.length, historyCursor));
    }
    if (historyCursor >= history.length) {
      input.value = historyDraft;
      historyCursor = -1;
      historyDraft = "";
    } else {
      input.value = history[historyCursor];
    }
    const n = input.value.length;
    requestAnimationFrame(() => { try { input.setSelectionRange(n, n); } catch (_) {} });
  }

  let errorTimer = 0;
  function flashError(msg) {
    input.classList.add("is-error");
    if (msg) input.title = msg;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      input.classList.remove("is-error");
      input.removeAttribute("title");
    }, 900);
  }

  // Forward to #chat-form so the outbound hook, slash routing and echo stay
  // in index.html. The form's handler clears #chat-input on every handled
  // path (sent, routed, eaten by a plugin hook) and leaves it untouched when
  // the session is not in world or the send threw — that is our "accepted".
  function submit({ fromKeyboard }) {
    const typed = input.value.trim();
    // Retail ChatInterface::HandleEnterKey (acclient.c:288853): Enter on an
    // empty entry just leaves chat mode.
    if (!typed) { if (fromKeyboard) deactivate(); return; }
    const outgoing = buildOutgoingLine(activeFocus, typed);
    const srcInput = document.getElementById("chat-input");
    const srcForm = document.getElementById("chat-form");
    if (!srcInput || !srcForm) { flashError("Chat is not connected yet."); return; }
    srcInput.value = outgoing;
    srcForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const accepted = srcInput.value === "";
    srcInput.value = "";
    if (!accepted) { flashError("Not sent — you are not in the world yet."); return; }
    pushHistory(typed);
    input.value = "";
    // HandleEnterKey leaves chat mode after sending unless the player set
    // CharacterOption StayInChatModeAfterSendingMessage. A mouse Send keeps
    // the caret where the player is working.
    if (!fromKeyboard || readCharOption(OPT_STAY_IN_CHAT)) activate();
    else deactivate();
  }

  input.addEventListener("keydown", (ev) => {
    // Typing never reaches gameplay keys (the funnel already gates on the
    // focused <input>; this keeps document listeners out too).
    ev.stopPropagation();
    if (ev.isComposing) return;
    switch (ev.key) {
      case "Enter": ev.preventDefault(); submit({ fromKeyboard: true }); return;
      case "Escape": ev.preventDefault(); if (menuOpen) closeMenu(); else deactivate(); return;
      case "ArrowUp": ev.preventDefault(); recallHistory("up"); return;
      case "ArrowDown": ev.preventDefault(); recallHistory("down"); return;
      case "PageUp": ev.preventDefault(); log.scrollBy(0, -Math.max(15, log.clientHeight - 15)); return;
      case "PageDown": ev.preventDefault(); log.scrollBy(0, Math.max(15, log.clientHeight - 15)); return;
      default: return;
    }
  });
  input.addEventListener("focus", () => {
    refreshTimestampFlag();
    if (activeFocus.id === "reply") input.placeholder = placeholderFor(activeFocus);
  });
  sendBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    submit({ fromKeyboard: false });
  });

  // Enter anywhere in the game opens the chat bar (retail keymap "Chat Mode
  // → Enter", ChatInterface::OnToggleChatEntry acclient.c:287616). Skipped
  // when something else already handled the key or owns keyboard focus.
  const onDocKeyDown = (ev) => {
    if (ev.key !== "Enter" || ev.defaultPrevented || ev.repeat || ev.isComposing) return;
    if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    const ae = document.activeElement;
    if (ae && ae !== document.body) {
      const tag = ae.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || ae.isContentEditable) return;
      // A button the player TABBED to keeps Enter; one merely left focused
      // by a mouse click (no :focus-visible) must not swallow the chat key.
      if (tag === "BUTTON" || tag === "A" || ae.getAttribute?.("tabindex") != null) {
        let keyboardFocused = true;
        try { keyboardFocused = ae.matches(":focus-visible"); } catch (_) {}
        if (keyboardFocused) return;
      }
    }
    if (!overlay.isConnected || overlay.getClientRects().length === 0) return;
    ev.preventDefault();
    activate();
  };
  document.addEventListener("keydown", onDocKeyDown);

  // ── Maximise (MaximizeButton 0x1000046F) ─────────────────────────────
  let restoreRect = null;
  function applyRect({ top, height }) {
    const vp = hudViewport();
    overlay.style.height = `${Math.round(height)}px`;
    if (top + height / 2 > vp.height / 2) {
      overlay.style.top = "auto";
      overlay.style.bottom = `${Math.max(0, Math.round(vp.height - (top + height)))}px`;
    } else {
      overlay.style.bottom = "auto";
      overlay.style.top = `${Math.max(0, Math.round(top))}px`;
    }
  }
  function setMaximized(on, { keepSize = false, restoreHeight = null } = {}) {
    if (!overlay.isConnected) return;
    const isOn = overlay.dataset.maximized === "1";
    if (on === isOn) return;
    const vp = hudViewport();
    const r = hudRect(overlay);
    if (on) {
      const h0 = restoreHeight ?? r.height;
      restoreRect = { height: h0, top: r.bottom - h0 };
      applyRect(computeMaximizedRect({ top: r.top, height: r.height }, vp.height));
      writeLocal(LS_SAVED_HEIGHT, String(Math.round(h0)));
    } else {
      if (!keepSize) {
        const h = Math.max(MIN_H, restoreRect?.height ?? sizeP.getSize().height ?? HEIGHT);
        // Restore keeps the edge the window is docked to.
        const bottomDocked = r.top + r.height / 2 > vp.height / 2;
        const top = bottomDocked ? r.bottom - h : Math.min(r.top, Math.max(0, vp.height - h));
        applyRect({ top, height: h });
      }
      restoreRect = null;
      writeLocal(LS_SAVED_HEIGHT, null);
    }
    overlay.dataset.maximized = on ? "1" : "0";
    const label = on ? "Restore chat size" : "Expand chat";
    maxBtn.title = label;
    maxBtn.setAttribute("aria-label", label);
    if (pinned) requestAnimationFrame(() => { if (pinned) scrollToBottom(); });
  }
  maxBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setMaximized(overlay.dataset.maximized !== "1");
  });

  // ── Viewport / HUD-scale changes ─────────────────────────────────────
  let reflowRaf = 0;
  const onViewportChange = () => {
    cancelAnimationFrame(reflowRaf);
    reflowRaf = requestAnimationFrame(() => {
      fitToViewport();
      if (pinned) scrollToBottom();
    });
  };
  window.addEventListener("resize", onViewportChange);
  document.addEventListener(HUD_SCALE_EVENT, onViewportChange);

  // ── Initial state ────────────────────────────────────────────────────
  setTalkFocus(TALK_FOCUSES[0].id, { focusInput: false, widen: false });
  setFilter(filter, { persist: false });
  fitToViewport();
  {
    // Re-open maximised if the last session left it that way (the saved
    // value is the height to restore to; pre-overhaul builds stored "123px").
    const saved = parseFloat(readLocal(LS_SAVED_HEIGHT) ?? "");
    if (Number.isFinite(saved) && saved > 0) {
      requestAnimationFrame(() => setMaximized(true, { restoreHeight: Math.max(MIN_H, saved) }));
    }
  }

  // Console / verification surface.
  const api = {
    focus: activate,
    blur: deactivate,
    setFilter: (id) => setFilter(id),
    setTalkFocus: (id) => setTalkFocus(id, { focusInput: false }),
    toggleMaximize: () => setMaximized(overlay.dataset.maximized !== "1"),
    scrollToBottom,
    startTell,
    state: () => ({
      filter, talkFocus: activeFocus.id, pinned, unread,
      lines: log.childElementCount, maximized: overlay.dataset.maximized === "1",
    }),
  };
  window.__chatPanel = api;

  return () => {
    if (observer) observer.disconnect();
    observer = null;
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
    if (ro) { try { ro.disconnect(); } catch (_) {} ro = null; }
    clearTimeout(errorTimer);
    cancelAnimationFrame(reflowRaf);
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onDocKeyDown);
    document.removeEventListener(HUD_SCALE_EVENT, onViewportChange);
    window.removeEventListener("resize", onViewportChange);
    try { edgeResizers?.dispose?.(); } catch (_) {}
    try { cornerResizers?.dispose?.(); } catch (_) {}
    if (window.__chatPanel === api) window.__chatPanel = undefined;
    overlay.remove();
  };
}
