// Bottom-left chat panel — retail port of gmFloatyMainChatUI
// (LayoutDesc 0x2100006F, root element 0x10000600 at 410×100).
//
// The non-agent-mode page already does all the heavy lifting:
//
//   - `appendChatLine(text, category)` (index.html:5926) is the
//     canonical entry point.
//   - The recv loop's kind=2 ChatReceived handler (index.html:7160+)
//     formats every chat-bearing variant and tags it with a
//     CHAT_CATEGORY_* id (0=system, 1=local, 2=tell, 3=channel,
//     4=emote, 5=combat, 6=death, 7=magic, 8=advancement, 9=transient).
//   - `#chat-log li.cat-N` per-category CSS colours already exist.
//   - Outgoing chat goes through `#chat-input` (index.html:6755+).
//
// Agent-mode `display:none`s the original `#chat-panel`, so this
// plugin is the visible chat for agent-mode + wireframe sessions.
// We mirror every `<li>` from `#chat-log` into our retail-framed
// panel via MutationObserver, and forward our input's Enter key
// to the existing `#chat-input` so all send paths stay in one
// place (no duplicated wasm/ACE wiring).
//
// Retail layout source: gmFloatyMainChatUI 0x2100006F.
// URL knob: `?chatFade=1` enables opacity-on-mouseout (45% at rest,
// fades to 100% on hover). Persisted in localStorage `hb_chat_panel_fade`.
// Per chat_panel_layout_dump 2026-05-24 the root element 0x10000600
// holds 23 children:
//   - 16 frame corners/edges (0x10000693-0x100006A2; decorative)
//   - 0x10000010 chat-log container (5, 5) 400×73
//     - 0x10000011 text area (16, 0) 368×73  (16-px left gutter
//       clears the 4 left-edge filter buttons)
//     - 0x1000048C "new messages" badge (0, 57) 16×16 (m_chatNew-
//       NonVisibleTextIndicator per acclient.h gmMainChatUI:54906)
//     - 0x10000012 right-side scrollbar (384, 0) 16×73
//   - 0x1000046F top-right Maximize button (368, 5) 16×16
//     (acclient.c:254293 GetChildRecursive(0x1000046Fu) → ToggleMaximize)
//   - 0x10000522/3/4/5 left-edge filter buttons (5, 5+17k) 16×16
//     (not referenced anywhere in acclient.c — pure layout artifacts;
//      retail used them as filter-tab toggles bound to the
//      gmMainChatUI::m_llTextTypeFilter bitmask via UIElement events.
//      We bind them to All / Local / Tells / Channels per the default
//      4-tab consolidation in layout-port-plan-2026-05-24.md.)
//   - 0x10000013 input row (5, 78) 400×17
//     - 0x10000014 channel selector (0, 0) 46×17 (talk-focus dropdown
//       anchor per acclient.c:255043 GetChildRecursive(0x10000014u)
//       → InitTalkFocusMenu populates m_aTalkFocusButtons SmartArray)
//     - 0x10000016 text input (46, 0) 306×17 (m_chatEntry per
//       acclient.c:287807 GetChildRecursive(0x10000011u))
//     - 0x10000019 send button (354, 0) 46×17, 3 states
//
// Per the Chat Interface wiki page (acpedia), the actual retail panel
// is RESIZABLE — 410×100 is just the default. Resize-handle is kept.

import { setAcText, CHAT_FONT_ID } from "../ui/ac_font.js";
import { loadLayout, findElementById, getCachedLayout } from "../ui/ac_layout.js";
import { installDragPersistence } from "./main-panel.js";
import { persistWindowSize, WINDOW_ID } from "../ui/ac_window_position.js";
import { attachCornerResizers } from "../ui/ac_resize_corners.js";

const OVERLAY_ID = "hb-chat-panel";
const WIDTH = 410;
const HEIGHT = 100;
const MAX_LINES = 48;          // ring buffer; ~6x what fits on-screen

// gmFloatyMainChatUI — retail layout that drives the chat panel.
// Element-id map confirmed by chat_panel_layout_dump 2026-05-24:
const CHAT_LAYOUT_ID         = 0x2100006F;
// Root (0x10000600), inner log-text container (0x10000011), in-log badge
// (0x1000048C), and explicit scrollbar (0x10000012) are intentionally NOT
// wired today — our DOM places the log + scrollbar via CSS, and the badge
// is a Holtburger-specific concept. Listed here for the next layout pass.
const CHAT_ELEM_LOG_CONT     = 0x10000010;
const CHAT_ELEM_TOPRIGHT_BTN = 0x1000046F;
// Retail left-edge filter buttons — superseded by the horizontal 6-tab
// strip below, but the element IDs stay for documentation.
// Retail 4-edge filter buttons 0x10000522-0x10000525 superseded by the 6-tab
// horizontal strip below — see header comment + TABS array. IDs preserved
// in the header doc for future retail-layout work.
const CHAT_ELEM_INPUT_ROW    = 0x10000013;
const CHAT_ELEM_CHANNEL_SEL  = 0x10000014;
const CHAT_ELEM_INPUT_FIELD  = 0x10000016;
const CHAT_ELEM_SEND_BTN     = 0x10000019;

// 6-tab strip — explicit derivative of the retail 4-button layout
// (0x10000522-0x10000525). P2-20 (cross-find chat-filter-count-and-
// labels): truncated to 4 retail entries (A/L/T/C); Allegiance + Fellow-
// ship remain selectable via the Channels popup (CHANNELS array below)
// — retail folds those channels under the Chan dropdown, not as
// independent filter buttons. The 4 retail buttons fit in the 100-px
// panel height which the prior 6-button strip did not.
const TABS = [
  { id: "all",      label: "All"   },
  { id: "local",    label: "Local" },
  { id: "tell",     label: "Tell"  },
  { id: "channels", label: "Chan"  },
];

// CHAT_CATEGORY_* colours — mirror the index.html `#chat-log .cat-N`
// palette but adjusted for legibility against our dark stone background
// (the index.html version sits on a light #fafafa, ours on dark).
// Concrete hex colors (no CSS vars) so canvas2d's fillStyle in
// ac_font's renderAcText accepts them. The cream/tell-yellow values
// mirror the `--hb-text-cream` / `--hb-text-tell-yellow` definitions
// in index.html (theme variables).
const CAT_COLORS = {
  0: "#90d090",                            // system   (was #1a7f1a)
  1: "#f0d8a0",                            // local    (--hb-text-cream)
  2: "#ffe060",                            // tell     (--hb-text-tell-yellow per wiki)
  3: "#7da6e0",                            // channel  (blue-grey per retail wiki)
  4: "#bba696",                            // emote    (italic-grey)
  5: "#ff6a4a",                            // combat
  6: "#ff5050",                            // death
  7: "#c060ff",                            // magic
  8: "#f0c060",                            // advancement
  9: "#888070",                            // transient
  10: "#ff8080",                           // send-error
};
const ECHO_COLOR = "#f0e8d0";              // --hb-text-cream-bright

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-chat-panel-style";
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      bottom: 8px;
      left: 8px;
      z-index: 50;
      width: ${WIDTH}px;
      height: ${HEIGHT}px;
      box-sizing: border-box;
      pointer-events: none;
      font-family: var(--hb-font-serif);
      background: linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      border: 6px solid transparent;
      border-image: url("./sprites/acsprites/panel.png") 6 / 6px / 0 stretch;
      box-shadow: var(--hb-shadow-panel);
      color: var(--hb-text-cream);
    }
    /* Horizontal tab strip — 6 equal-width buttons above the chat log.
       Width 360 to clear the top-right Maximize button at (368,5).
       Replaces the retail 4-button left-edge column to fit the
       Alleg + Fell + Chan split. */
    /* P2-39 (cross-find chat-filter-anchor-orientation): horizontal
       tab strip at top, NOT retail's vertical 16x16 column on the
       left. ACCEPTED DEVIATION — horizontal reads better at our
       400-wide panel + matches contemporary chat UX (Discord/Slack/
       game chat). Switch to vertical only if retail-parity QA flags
       this as essential. */
    #${OVERLAY_ID} .hb-chat-tab-strip {
      position: absolute;
      top: 0;
      left: 5px;
      width: 360px;
      height: 12px;
      display: flex;
      gap: 1px;
      pointer-events: auto;
      z-index: 3;
    }
    #${OVERLAY_ID} .hb-chat-tab-btn {
      flex: 1 1 0;
      min-width: 0;
      height: 12px;
      box-sizing: border-box;
      padding: 0;
      font-size: 9px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream-bright);
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid var(--hb-border-brass-dim);
      cursor: pointer;
      user-select: none;
      text-align: center;
      line-height: 10px;
      pointer-events: auto;
    }
    #${OVERLAY_ID} .hb-chat-tab-btn:hover {
      background: var(--hb-overlay-hover);
    }
    #${OVERLAY_ID} .hb-chat-tab-btn.active {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
      border-color: var(--hb-border-brass);
    }
    /* Opt-in: panel fades to 45% at rest, snaps to full opacity on hover.
       Toggled by ?chatFade=1 (persisted in hb_chat_panel_fade). */
    #${OVERLAY_ID}[data-fade="1"] {
      opacity: 0.45;
      transition: opacity 0.3s ease-out;
    }
    #${OVERLAY_ID}[data-fade="1"]:hover {
      opacity: 1;
      transition: opacity 0.15s ease-in;
    }
    /* Top-right Maximize button (0x1000046F at 368,5 16×16). Per
       acclient.c:254293 the retail behavior toggles m_Maximized →
       expand/collapse the chat panel between collapsed (default
       height) and m_OldHeight. We surface a placeholder click handler
       (functional toggle is a follow-on; layout-port lands the
       button geometry first). */
    #${OVERLAY_ID} .hb-chat-topright-btn {
      position: absolute;
      width: 16px;
      height: 16px;
      box-sizing: border-box;
      padding: 0;
      font-size: 10px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream-bright);
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--hb-border-brass-dim);
      cursor: pointer;
      user-select: none;
      text-align: center;
      line-height: 14px;
      pointer-events: auto;
      z-index: 2;
    }
    #${OVERLAY_ID} .hb-chat-topright-btn:hover {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
    /* Chat scrollback container — per layout 0x10000010 it sits at
       (5, 5) 400×73 inside the panel; per 0x10000011 the text area
       is inset (16, 0) 368×73 to clear the 4 left-edge filter
       buttons. We collapse the wrapper into one scrollable div and
       use padding-left to mimic the 16-px gutter. The right-edge
       16-px scrollbar gutter (0x10000012 at (384, 0) 16×73) is left
       as a TODO — for now we use CSS scrollbar-width:thin and
       trust the browser's renderer. */
    #${OVERLAY_ID} .hb-chat-scroll {
      position: absolute;
      top: 5px;
      left: 5px;
      width: 400px;
      height: 73px;
      box-sizing: border-box;
      padding: 14px 4px 0 5px;   /* top:14 clears the horizontal tab strip */
      overflow-y: auto;
      overflow-x: hidden;
      font-size: 11px;
      /* line-height 17px fits the chat-window font's 16px cell
         (0x40000027) with 1px margin. Previously 13px for the compact
         font's 12px cell. */
      line-height: 17px;
      color: var(--hb-text-cream);
      pointer-events: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.4);
    }
    #${OVERLAY_ID} .hb-chat-line {
      margin: 0;
      padding: 0;
      white-space: pre-wrap;
      word-break: break-word;
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.85);
    }
    /* 4-tab retail filter chains. "all" shows everything; "local" keeps
       cat-1 + cat-4 (spoken/emote); "tell" cat-2; "channels" — all
       channel chatter INCLUDING allegiance (cat-17) and fellowship
       (cat-16). Combat/Magic/System are subsumed by "all". Alleg / Fell
       posting still works via the CHANNELS popup; just no dedicated
       filter button. */
    #${OVERLAY_ID} .hb-chat-scroll[data-tab="local"] .hb-chat-line:not(.cat-1):not(.cat-4):not(.echo) { display: none; }
    #${OVERLAY_ID} .hb-chat-scroll[data-tab="tell"] .hb-chat-line:not(.cat-2):not(.echo) { display: none; }
    #${OVERLAY_ID} .hb-chat-scroll[data-tab="channels"] .hb-chat-line:not(.cat-3):not(.cat-12):not(.cat-13):not(.cat-14):not(.cat-15):not(.cat-16):not(.cat-17):not(.cat-22):not(.cat-23):not(.echo) { display: none; }
    /* Resize handle — bottom-right corner, drag to grow/shrink. Wiki
       says retail chat windows are resizable, with size persisted
       per-character. Persistence is a follow-on. */
    /* Rec #80 — bespoke .hb-chat-resize replaced by attachCornerResizers
       in the mount path; CSS removed. */
    /* Input row container — per layout 0x10000013 at (5, 78) 400×17.
       Sub-elements (channel selector, text input, send button) are
       positioned absolutely inside via applyChatLayout(). */
    #${OVERLAY_ID} .hb-chat-input-row {
      position: absolute;
      left: 5px;
      top: 78px;
      width: 400px;
      height: 17px;
      box-sizing: border-box;
      font-size: 10px;
      color: var(--hb-text-cream);
    }
    /* Channel selector — per layout 0x10000014 at (0, 0) 46×17 inside
       the input row. Click opens the talk-focus dropdown menu above. */
    #${OVERLAY_ID} .hb-chat-channel-btn {
      position: absolute;
      left: 0;
      top: 0;
      width: 46px;
      height: 17px;
      box-sizing: border-box;
      padding: 1px 4px 1px 4px;
      font-family: var(--hb-font-serif);
      font-size: 9px;
      color: var(--hb-text-gold);
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid var(--hb-border-brass);
      cursor: pointer;
      user-select: none;
      text-transform: uppercase;
      letter-spacing: 0.02em;
      text-align: left;
      pointer-events: auto;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* P2-20 (cross-find chat-channel-selector-chevron): retail's
       channel button has no chevron decoration. Drop the inserted
       ▾ glyph. */
    #${OVERLAY_ID} .hb-chat-channel-btn:hover {
      background: var(--hb-overlay-active);
    }
    #${OVERLAY_ID} .hb-chat-channel-menu {
      position: absolute;
      bottom: calc(100% + 2px);
      left: 0;
      min-width: 140px;
      background: linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      border: 6px solid transparent;
      border-image: url("./sprites/acsprites/panel.png") 6 / 6px / 0 stretch;
      box-shadow: var(--hb-shadow-panel);
      padding: 2px;
      display: none;
      z-index: 200;
      pointer-events: auto;
    }
    #${OVERLAY_ID} .hb-chat-channel-menu[data-open="1"] { display: block; }
    #${OVERLAY_ID} .hb-chat-channel-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 3px 8px;
      font-family: var(--hb-font-serif);
      font-size: 10px;
      color: var(--hb-text-cream);
      cursor: pointer;
      user-select: none;
    }
    #${OVERLAY_ID} .hb-chat-channel-item:hover {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
    /* .hb-chat-channel-cmd CSS dropped together with the per-item
       cmd span (P2-20 chat-channel-menu-slash-cmd-leak). */
    #${OVERLAY_ID} .hb-chat-channel-item.selected {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
    /* Text input — per layout 0x10000016 at (46, 0) 306×17 inside
       the input row. */
    #${OVERLAY_ID} .hb-chat-input {
      position: absolute;
      left: 46px;
      top: 0;
      width: 306px;
      height: 17px;
      box-sizing: border-box;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid var(--hb-border-brass-dim);
      color: var(--hb-text-cream);
      font-family: var(--hb-font-serif);
      font-size: 10px;
      padding: 1px 4px;
      outline: none;
      pointer-events: auto;
    }
    #${OVERLAY_ID} .hb-chat-input:focus {
      border-color: var(--hb-border-brass);
    }
    /* Send button — per layout 0x10000019 at (354, 0) 46×17 inside
       the input row, 3 states (idle/hover/active). */
    #${OVERLAY_ID} .hb-chat-send-btn {
      position: absolute;
      left: 354px;
      top: 0;
      width: 46px;
      height: 17px;
      box-sizing: border-box;
      padding: 0;
      font-family: var(--hb-font-serif);
      font-size: 9px;
      font-weight: 600;
      color: var(--hb-text-gold);
      background: linear-gradient(180deg, rgba(120, 84, 32, 0.55) 0%, rgba(50, 35, 15, 0.7) 100%);
      border: 1px solid var(--hb-border-brass);
      cursor: pointer;
      user-select: none;
      letter-spacing: 0.04em;
      pointer-events: auto;
      text-align: center;
      line-height: 15px;
    }
    #${OVERLAY_ID} .hb-chat-send-btn:hover {
      background: linear-gradient(180deg, rgba(150, 105, 40, 0.65) 0%, rgba(70, 50, 20, 0.75) 100%);
      color: var(--hb-text-cream-bright);
    }
    #${OVERLAY_ID} .hb-chat-send-btn:active {
      background: linear-gradient(180deg, rgba(40, 25, 10, 0.75) 0%, rgba(80, 55, 20, 0.6) 100%);
    }
  `;
  document.head.appendChild(style);
}

function colorForCategory(catStr) {
  // catStr is the dataset.cat attribute from the source <li> ("0".."9")
  // or null/undefined for the .echo neutral class (outgoing local-echo).
  if (catStr == null) return ECHO_COLOR;
  const c = CAT_COLORS[catStr];
  return c || "#f0d8a0";
}

export const manifest = {
  id: "chat-panel",
  name: "Chat",
  icon: "💬",
  iconHidden: true,
  version: "0.1.0",
  description: "Bottom-left chat panel (retail gmFloatyMainChatUI 0x2100006F)",
};

// Apply gmFloatyMainChatUI 0x2100006F layout to the chat-panel's
// sub-elements. Mirrors radar.js's applyRadarLayout — 8 × 2s retry
// loop because chat-panel mounts via mountBar() before
// init_resource_source has populated window.__hbWasm. The horizontal
// 6-tab strip is CSS-positioned (no DAT slots for 6 buttons), so the
// retail 0x10000522-0x10000525 element IDs are unused.
function applyChatLayout(refs, attempt = 0) {
  const apply = (layout) => {
    if (!layout) {
      if (attempt < 8) {
        setTimeout(() => applyChatLayout(refs, attempt + 1), 2000);
      }
      return;
    }
    let applied = 0;
    // Element pairs: (element_id, DOM ref). We apply x/y/width/height
    // from the LayoutDesc. The chat-log container, input row, etc are
    // already CSS-positioned to the layout values; this re-asserts
    // them from the DAT so the asset stays source-of-truth.
    // 6-tab horizontal strip is positioned via flex/CSS, not the DAT
    // (the retail layout only has 4 filter slots at 0x10000522-0x10000525).
    const pairs = [
      [CHAT_ELEM_LOG_CONT,     refs.scrollEl],     // (5,5) 400×73
      [CHAT_ELEM_INPUT_ROW,    refs.inputRowEl],   // (5,78) 400×17
      [CHAT_ELEM_TOPRIGHT_BTN, refs.toprightEl],   // (368,5) 16×16
      [CHAT_ELEM_CHANNEL_SEL,  refs.channelEl],    // (0,0) 46×17
      [CHAT_ELEM_INPUT_FIELD,  refs.inputEl],      // (46,0) 306×17
      [CHAT_ELEM_SEND_BTN,     refs.sendEl],       // (354,0) 46×17
    ];
    for (const [id, el] of pairs) {
      if (!el) continue;
      const desc = findElementById(layout, id);
      if (!desc) continue;
      // Clear any CSS `right`/`bottom` anchors that would fight an
      // explicit `left`/`top` override.
      el.style.right = "";
      el.style.bottom = "";
      if (typeof desc.x === "number") el.style.left = `${desc.x}px`;
      if (typeof desc.y === "number") el.style.top = `${desc.y}px`;
      if (typeof desc.width === "number") el.style.width = `${desc.width}px`;
      if (typeof desc.height === "number") el.style.height = `${desc.height}px`;
      applied += 1;
    }
    try {
      window.__diag?.layout?.onChatApplied?.({ applied });
    } catch (_) {}
  };
  const cached = getCachedLayout(CHAT_LAYOUT_ID);
  if (cached) { apply(cached); return; }
  loadLayout(CHAT_LAYOUT_ID).then(apply).catch(() => {});
}

export function mount(_ctx) {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  // Opt-in fade: `?chatFade=1` or persisted `hb_chat_panel_fade=1`.
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("chatFade") === "1") {
      localStorage.setItem("hb_chat_panel_fade", "1");
    } else if (params.get("chatFade") === "0") {
      localStorage.removeItem("hb_chat_panel_fade");
    }
    if (localStorage.getItem("hb_chat_panel_fade") === "1") {
      overlay.dataset.fade = "1";
    }
  } catch (_) {}

  // Horizontal 6-tab strip — derivative of the retail 4-button column.
  const tabStrip = document.createElement("div");
  tabStrip.className = "hb-chat-tab-strip";
  const tabBtns = {};
  for (const t of TABS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hb-chat-tab-btn" + (t.id === "all" ? " active" : "");
    btn.dataset.tab = t.id;
    btn.title = t.label;
    setAcText(btn, t.label);
    tabStrip.appendChild(btn);
    tabBtns[t.id] = btn;
  }
  overlay.appendChild(tabStrip);

  // Top-right Maximize button (0x1000046F at 368,5 16×16). Retail
  // toggles the chat panel between collapsed (default height) and
  // m_OldHeight per acclient.c:254293. We surface a placeholder
  // toggle that logs to console + flips a `data-maximized` flag for
  // a future expansion handler.
  const toprightBtn = document.createElement("button");
  toprightBtn.type = "button";
  toprightBtn.className = "hb-chat-topright-btn";
  toprightBtn.title = "Maximize";
  setAcText(toprightBtn, "▲");
  toprightBtn.addEventListener("click", () => {
    const next = overlay.dataset.maximized === "1" ? "0" : "1";
    overlay.dataset.maximized = next;
    setAcText(toprightBtn, next === "1" ? "▼" : "▲");
    try {
      console.log(`[chat-panel] maximize toggled → ${next === "1" ? "expanded" : "collapsed"}`);
    } catch (_) {}
  });
  // Inline default position (the layout override lands after wasm
  // is ready; this prevents a 0,0 flicker on first paint).
  toprightBtn.style.left = "368px";
  toprightBtn.style.top = "5px";
  overlay.appendChild(toprightBtn);

  // Scrollback area — its [data-tab] drives the CSS filter chains
  // defined alongside this block in ensureStyles().
  const scroll = document.createElement("div");
  scroll.className = "hb-chat-scroll";
  scroll.dataset.tab = "all";
  overlay.appendChild(scroll);

  function setTab(tabId) {
    scroll.dataset.tab = tabId;
    for (const id of Object.keys(tabBtns)) {
      tabBtns[id].classList.toggle("active", id === tabId);
    }
    // Mirror the selection to the source #chat-log so the filter
    // stays in sync if the agent-mode hide rule is ever removed.
    const src = document.getElementById("chat-log");
    if (src) src.dataset.tab = tabId;
    // Re-pin to bottom on tab change.
    scroll.scrollTop = scroll.scrollHeight;
  }
  // Single click handler delegated for all tab buttons.
  overlay.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".hb-chat-tab-btn[data-tab]");
    if (!btn) return;
    setTab(btn.dataset.tab);
  });

  // Channel selector — outgoing-chat channel + slash-prefix table.
  // Sourced from acpedia Chat Interface page (channel tags + commands):
  //   - Say   -> default, no prefix
  //   - Tell  -> /tell <name>  (target is per-message; we surface "/tell ")
  //   - General/Trade/LFG/Roleplay -> /cg /ct /clfg /crp (global channels)
  //   - Allegiance/Fellowship -> /a /f
  //   - Emote -> /me <action>
  //   - Broadcast -> /b   (admin-gated; ACE may reject)
  const CHANNELS = [
    { id: "say",        label: "Local",      cmd: "" },
    { id: "tell",       label: "Tell",       cmd: "/tell " },
    { id: "general",    label: "General",    cmd: "/cg " },
    { id: "trade",      label: "Trade",      cmd: "/ct " },
    { id: "lfg",        label: "LFG",        cmd: "/clfg " },
    { id: "roleplay",   label: "Roleplay",   cmd: "/crp " },
    { id: "allegiance", label: "Allegiance", cmd: "/a " },
    { id: "fellowship", label: "Fellowship", cmd: "/f " },
    { id: "emote",      label: "Emote",      cmd: "/me " },
    { id: "broadcast",  label: "Broadcast",  cmd: "/b " },
  ];
  let activeChannel = CHANNELS[0];

  // Input row container — per layout 0x10000013 at (5, 78) 400×17.
  const inputRow = document.createElement("div");
  inputRow.className = "hb-chat-input-row";

  // Channel selector button — talk-focus dropdown anchor.
  // Per retail (acclient.c:255043) this is element_id 0x10000014 and
  // is `Container Type=6` in the layout (i.e. a popup-menu container).
  const channelBtn = document.createElement("button");
  channelBtn.type = "button";
  channelBtn.className = "hb-chat-channel-btn";
  setAcText(channelBtn, activeChannel.label);
  inputRow.appendChild(channelBtn);

  // Channel popup menu — opens above the button.
  const channelMenu = document.createElement("div");
  channelMenu.className = "hb-chat-channel-menu";
  const channelItems = {};
  for (const c of CHANNELS) {
    const item = document.createElement("div");
    item.className = "hb-chat-channel-item" + (c.id === activeChannel.id ? " selected" : "");
    item.dataset.channel = c.id;
    const lbl = document.createElement("span");
    setAcText(lbl, c.label);
    item.appendChild(lbl);
    // P2-20 (cross-find chat-channel-menu-slash-cmd-leak): retail's
    // channel popup shows just the label — the `/a` / `/f` slash
    // commands aren't listed. Drop the per-item cmd span. The cmd is
    // still applied when the user picks a channel (CHANNELS[i].cmd).
    channelMenu.appendChild(item);
    channelItems[c.id] = item;
  }
  inputRow.appendChild(channelMenu);

  function selectChannel(id) {
    const c = CHANNELS.find((x) => x.id === id);
    if (!c) return;
    activeChannel = c;
    setAcText(channelBtn, c.label);
    for (const k of Object.keys(channelItems)) {
      channelItems[k].classList.toggle("selected", k === id);
    }
    closeChannelMenu();
    input.focus();
  }
  function openChannelMenu()  { channelMenu.dataset.open = "1"; }
  function closeChannelMenu() { channelMenu.dataset.open = "0"; }

  channelBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (channelMenu.dataset.open === "1") closeChannelMenu();
    else openChannelMenu();
  });
  channelMenu.addEventListener("click", (ev) => {
    const item = ev.target.closest("[data-channel]");
    if (!item) return;
    selectChannel(item.dataset.channel);
  });
  // Click anywhere else closes the menu.
  document.addEventListener("click", (ev) => {
    if (channelMenu.dataset.open !== "1") return;
    if (overlay.contains(ev.target)) return;
    closeChannelMenu();
  });

  // Text input — per layout 0x10000016 at (46, 0) 306×17.
  const input = document.createElement("input");
  input.className = "hb-chat-input";
  input.type = "text";
  input.placeholder = "type here…";
  inputRow.appendChild(input);

  // Send button — per layout 0x10000019 at (354, 0) 46×17, 3 states.
  // PR-LL 2026-05-23: explicit Send button on the right of the input
  // row. Same submit path as Enter.
  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "hb-chat-send-btn";
  setAcText(sendBtn, "Send");
  sendBtn.title = "Send (Enter)";
  inputRow.appendChild(sendBtn);

  overlay.appendChild(inputRow);

  // Rec #80 — corner-resize hotspots replace the bespoke bottom-right
  // handle. attachCornerResizers gives all four corners with lock-
  // state sync via WINDOW_ID.CHAT; persistWindowSize stores width /
  // height alongside x / y in the unified hb.window.<id> entry.
  // Legacy hb_chat_panel_width/height are migrated on first mount
  // (see below) so the visual size carries over from prior versions.
  const _chatSize = persistWindowSize(overlay, WINDOW_ID.CHAT, {
    minW: 220, minH: 70, maxW: 900, maxH: 500,
  });
  // Resizer handle stashed on overlay so a future plugin-loader dispose
  // pass can drop the corner divs + lock-change listener.
  overlay._chatCornerResizers = attachCornerResizers(overlay, {
    windowId: WINDOW_ID.CHAT,
    minWidth: 220, minHeight: 70,
    maxWidth: 900, maxHeight: 500,
    onSizeChange: ({ width, height }) => _chatSize.commit(width, height),
  });

  // P2-40 (cross-find chat-maximize-button-spurious): retail's chat
  // panel has a maximize/restore toggle that swaps between the
  // current height and m_OldHeight (acclient.c). Click expands to
  // ~half the viewport height; click again restores. Tucked into
  // the top-right corner of the panel, 12×12 square.
  const maxBtn = document.createElement("div");
  maxBtn.className = "hb-chat-maxbtn";
  maxBtn.title = "Maximize / Restore";
  maxBtn.style.cssText =
    "position:absolute;top:2px;right:14px;width:12px;height:12px;cursor:pointer;" +
    "background:rgba(0,0,0,0.4);border:1px solid var(--hb-border-brass-dim);" +
    "z-index:25;color:var(--hb-text-cream);font-size:9px;text-align:center;line-height:11px;";
  maxBtn.textContent = "▢";
  overlay.appendChild(maxBtn);
  let savedHeight = null;
  maxBtn.addEventListener("click", () => {
    if (savedHeight == null) {
      // Maximize — save current height, expand to half viewport.
      savedHeight = overlay.style.height || `${overlay.getBoundingClientRect().height}px`;
      overlay.style.height = `${Math.max(220, Math.floor(window.innerHeight * 0.5))}px`;
      maxBtn.textContent = "▣";
    } else {
      // Restore to previous size (retail m_OldHeight).
      overlay.style.height = savedHeight;
      savedHeight = null;
      maxBtn.textContent = "▢";
    }
  });

  // No lock + move handles on chat — those are radar-only chrome per
  // user direction 2026-05-22. Resize is on the bottom-right corner.

  document.body.appendChild(overlay);

  // Drag-by-tab-strip + localStorage position persistence (Improvement C,
  // 2026-05-29). The tab strip is the natural "grip" — chat-panel has no
  // dedicated titlebar. Drag suppressed on clicks targeting the tab
  // buttons themselves so a single click still selects a channel.
  installDragPersistence(overlay, tabStrip, "chat-panel");

  // HUD rec #47 — restore persisted size if present. Same clamp as the
  // resize handler (220-900 wide, 70-500 tall) so corrupted/edge values
  // can't escape viewport. Position is owned by installDragPersistence.
  // Rec #80 — persistWindowSize (above) reads the unified hb.window
  // entry on construction and applies the stored size automatically.
  // The block below is now a one-shot legacy migration: if the bespoke
  // hb_chat_panel_width / height keys still exist, commit them through
  // the new persistor and remove the old keys so subsequent loads use
  // the unified storage.
  try {
    const w = parseInt(localStorage.getItem("hb_chat_panel_width") ?? "", 10);
    const h = parseInt(localStorage.getItem("hb_chat_panel_height") ?? "", 10);
    if ((Number.isFinite(w) && w > 0) || (Number.isFinite(h) && h > 0)) {
      _chatSize.commit(
        Number.isFinite(w) && w > 0 ? Math.max(220, Math.min(900, w)) : null,
        Number.isFinite(h) && h > 0 ? Math.max(70, Math.min(500, h)) : null,
      );
      try { localStorage.removeItem("hb_chat_panel_width"); } catch (_) {}
      try { localStorage.removeItem("hb_chat_panel_height"); } catch (_) {}
    }
  } catch (_) {}

  // Apply retail layout positions for sub-elements. The CSS values
  // above already match retail; this re-asserts from the DAT so the
  // asset stays the source of truth for future tweaks.
  // NOTE: the right-side scrollbar (0x10000012 at 384,0 16×73) is
  // currently expressed via CSS `scrollbar-width: thin` on the
  // .hb-chat-scroll container; the layout's explicit scrollbar
  // element is decorative-only here and not surfaced as DOM.
  applyChatLayout({
    scrollEl:     scroll,
    inputRowEl:   inputRow,
    toprightEl:   toprightBtn,
    channelEl:    channelBtn,
    inputEl:      input,
    sendEl:       sendBtn,
  });

  // Mirror an <li> from #chat-log into our retail scrollback. We tag
  // each mirrored line with `data-empty` if the source was the empty
  // placeholder so we can drop it the first time a real message lands
  // (matches index.html's behaviour at line 5928).
  function mirrorOne(srcLi) {
    const isEmpty = srcLi.classList.contains("empty");
    if (!isEmpty) {
      // Drop any stale empty placeholders before appending the first
      // real line — source #chat-log does the same.
      scroll.querySelectorAll('[data-empty="1"]').forEach((el) => el.remove());
    }
    const line = document.createElement("div");
    line.className = "hb-chat-line";
    const cat = srcLi.dataset?.cat ?? null;
    let lineColor = colorForCategory(cat);
    if (cat != null) {
      line.classList.add(`cat-${cat}`);
      line.dataset.cat = cat;
    }
    if (srcLi.classList.contains("echo")) {
      line.classList.add("echo");
      lineColor = ECHO_COLOR;
    } else if (isEmpty) {
      line.dataset.empty = "1";
      line.style.opacity = "0.55";
      line.style.fontStyle = "italic";
    }
    line.style.color = lineColor;
    // Chat lines use the chat-window font (0x40000027, 16×15, 1419-
    // glyph extended set) — covers accented Latin / smart quotes /
    // symbols that compact's 1050-glyph set drops. Scroll line-height
    // (17px) was bumped to accommodate the 16px cell.
    setAcText(line, srcLi.textContent || "", { color: lineColor, fontId: CHAT_FONT_ID });
    scroll.appendChild(line);
    // Auto-scroll if pinned to bottom; otherwise raise the new-messages
    // badge so the user knows there's chatter waiting (P2-29).
    if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40) {
      scroll.scrollTop = scroll.scrollHeight;
    } else if (typeof overlay._hbChatMaybeFlag === "function") {
      overlay._hbChatMaybeFlag();
    }
    // Cap our own mirror at MAX_LINES (insurance vs source-log resets).
    while (scroll.childElementCount > MAX_LINES) {
      scroll.firstElementChild.remove();
    }
  }

  // Initial sync — pull whatever's already in #chat-log when we mount.
  const sourceLog = document.getElementById("chat-log");
  if (sourceLog) {
    for (const li of sourceLog.children) mirrorOne(li);
  }

  // MutationObserver watches for new <li>s appended by appendChatLine.
  let observer = null;
  if (sourceLog) {
    observer = new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (node?.tagName === "LI") mirrorOne(node);
        }
      }
    });
    observer.observe(sourceLog, { childList: true });
  } else {
    // index.html hasn't mounted #chat-log yet (we ran first); retry.
    const retry = setInterval(() => {
      const log = document.getElementById("chat-log");
      if (!log) return;
      clearInterval(retry);
      for (const li of log.children) mirrorOne(li);
      observer = new MutationObserver((records) => {
        for (const r of records) {
          for (const node of r.addedNodes) {
            if (node?.tagName === "LI") mirrorOne(node);
          }
        }
      });
      observer.observe(log, { childList: true });
    }, 250);
  }

  // Send: forward our input to the existing #chat-input so all the
  // wasm/ACE wiring (Talk packet, error handling, local echo) stays in
  // one place. Keypress on Enter mirrors index.html's Submit form
  // behaviour at line 6755+.
  function submitChat() {
    const text = input.value.trim();
    if (!text) return;
    // If the user typed their own slash-command, honour it as-is
    // (don't double-prefix). Otherwise prepend the active channel's
    // command so e.g. selecting "Trade" + typing "WTS keys" sends
    // "/ct WTS keys" through the existing chat-form submit handler.
    const startsWithSlash = text.startsWith("/") || text.startsWith("@");
    const outgoing = startsWithSlash ? text : (activeChannel.cmd + text);
    const srcInput = document.getElementById("chat-input");
    const srcForm = document.getElementById("chat-form");
    if (srcInput && srcForm) {
      srcInput.value = outgoing;
      // Dispatch submit on the source form so all listeners (the
      // existing Talk packet sender) fire.
      const submitEv = new Event("submit", { bubbles: true, cancelable: true });
      srcForm.dispatchEvent(submitEv);
      input.value = "";
    } else {
      // Fallback: no source input found yet, just clear ours.
      input.value = "";
    }
  }
  // P2-29 (cross-find chat-input-history-missing): retail's
  // m_InputHistory ring buffer — Up/Down arrows recall recent sends.
  // 64-entry ring is bigger than retail's docs cite (32) but cheap
  // and gives users a less-frustrating recall window.
  const inputHistory = [];
  const HISTORY_MAX = 64;
  let historyCursor = -1;       // -1 = past the latest entry (typing fresh)
  let historyDraft = "";        // saved while browsing history
  function pushHistory(text) {
    const t = (text ?? "").trim();
    if (!t) return;
    // Skip if same as latest entry (deduplicate consecutive resubmits).
    if (inputHistory.length > 0 && inputHistory[inputHistory.length - 1] === t) return;
    inputHistory.push(t);
    if (inputHistory.length > HISTORY_MAX) inputHistory.shift();
    historyCursor = -1;
    historyDraft = "";
  }
  function recallHistory(direction) {
    if (inputHistory.length === 0) return;
    if (historyCursor === -1) {
      // First Up after typing — remember the draft.
      historyDraft = input.value;
      historyCursor = inputHistory.length - 1;
    } else {
      historyCursor += direction === "up" ? -1 : 1;
      historyCursor = Math.max(0, Math.min(inputHistory.length, historyCursor));
    }
    if (historyCursor >= inputHistory.length) {
      // Past the latest — restore the draft.
      input.value = historyDraft;
      historyCursor = -1;
      historyDraft = "";
    } else {
      input.value = inputHistory[historyCursor];
    }
    // Place caret at end so the user can keep typing.
    requestAnimationFrame(() => {
      input.selectionStart = input.value.length;
      input.selectionEnd = input.value.length;
    });
  }
  function submitChatWithHistory() {
    const outgoing = (input.value ?? "").trim();
    pushHistory(outgoing);
    submitChat();
  }
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      submitChatWithHistory();
      return;
    }
    if (ev.key === "ArrowUp")   { ev.preventDefault(); recallHistory("up");   return; }
    if (ev.key === "ArrowDown") { ev.preventDefault(); recallHistory("down"); return; }
  });
  sendBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    submitChatWithHistory();
    input.focus();
  });
  // Stop the global keydown-driven movement from firing while typing.
  input.addEventListener("keydown", (ev) => ev.stopPropagation(), true);

  // P2-29 (cross-find chat-new-messages-badge-missing): retail's
  // m_chatNewNonVisibleTextIndicator (element 0x1000048C, 16×16 at
  // 0,57). Lights when new chat-log entries arrive while the scroll
  // is NOT at the bottom (user is reviewing history). Clicking the
  // badge scrolls to bottom + clears it. Hidden by default.
  const badge = document.createElement("div");
  badge.className = "hb-chat-new-badge";
  badge.hidden = true;
  badge.title = "New messages — click to scroll";
  badge.style.cssText =
    "position:absolute;left:6px;top:54px;width:16px;height:16px;cursor:pointer;" +
    "background:linear-gradient(180deg,#ffd76a 0%,#a87830 100%);" +
    "border:1px solid var(--hb-border-brass);border-radius:50%;z-index:20;" +
    "box-shadow:0 0 6px rgba(255,200,80,0.7);";
  overlay.appendChild(badge);
  badge.addEventListener("click", () => {
    scroll.scrollTop = scroll.scrollHeight;
    badge.hidden = true;
  });
  function isScrollNearBottom() {
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 24;
  }
  // Hide the badge when the user scrolls back to bottom themselves.
  scroll.addEventListener("scroll", () => {
    if (isScrollNearBottom()) badge.hidden = true;
  });
  // The MutationObserver below already watches for new lines; expose a
  // helper it can call to light the badge when warranted.
  function maybeFlagNewMessages() {
    if (!isScrollNearBottom()) badge.hidden = false;
  }
  // Bind the helper so the observer block (below mount return) can see it.
  overlay._hbChatMaybeFlag = maybeFlagNewMessages;

  return () => {
    if (observer) observer.disconnect();
    overlay.remove();
  };
}
