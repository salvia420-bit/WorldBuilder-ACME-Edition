// Fellowship panel — view of plugins/main-panel.js. Port of retail
// gmFellowshipUI (layout 0x21000030, 36 elements, 11 image DIDs).
// Bound to the F key.
//
// Two retail states (selected by whether the player is in a fellowship):
//   - "Alone": empty-state copy + Fellowship-Name input + 4 toggle
//     options + Create-Fellowship button. (acpedia screenshot.)
//   - "In fellowship": member list with each member's name + mini
//     vital bars (HP/St/Mn thin sprites 0x0600251C/0x06002520/
//     0x0600251F) + Leave/Recruit/Disband action row.
//
// Player fellowship data isn't exposed via player.stats yet, so we
// render the "Alone" state by default + a debug stub for the "In"
// state (toggleable via window.__hbFellowshipDebug for testing).
//
// Companion tabs Allegiance / Fellowship / Friends / Squelch mirror
// the same set used by plugins/allegiance-panel.js. Fellowship is the
// active tab here; the other tabs swap main-panel views.
//
// Layout-port 2026-05-24: wired retail gmFellowshipUI (LayoutDesc
// 0x21000030, 300×600 native compressed into main-panel's 300×337 body
// via scaleY). Both the "Alone" state (empty msg, divider, name input,
// 4 option rows, Create button) AND the "InFellowship" state (header,
// column labels, member list, scrollbar, 6 action buttons) come from
// the DAT. The 3-button companion-tab strip (Allegiance/Fellowship/
// Friends) at the top mirrors the orphan tab tree (0x10000281)
// alongside the two state subtrees.
//
// Element-id map (confirmed by fellowship_panel_layout_dump 2026-05-24):
//
//   ROOT 0x1000026A (300×600) — has 2 sibling state subtrees:
//
//   Alone-state subtree 0x1000026B (300×600, type=3 bevel):
//     0x1000026C — empty-state text  (8,18)   284×120
//     0x1000026D — divider            (0,191) 300×9
//     0x1000026E — "Fellowship Name:" label (0,200) 148×18
//     0x1000026F — name input field   (148,200) 147×18
//     0x10000270 — option row 1       (25,225) 275×14
//     0x10000271 — option row 2       (25,239) 275×14
//     0x10000272 — option row 3       (25,253) 275×14
//     0x10000273 — option row 4       (25,267) 275×14
//     0x10000274 — Create button      (33,298) 234×33, default_state=13
//
//   InFellowship-state subtree 0x10000275 (300×600, type=3 bevel):
//     0x10000276 — header strip       (0,2)   300×18
//     0x10000277 — "Name" col header  (8,22)  100×18
//     0x10000278 — "Level" col header (179,22) 100×18
//     0x10000279 — member list (type=5) (8,38) 271×487
//     0x1000027A — list scrollbar     (279,38) 16×487
//     0x1000027B — action button #1   (18,534) 79×30
//     0x1000027C — action button #2   (108,534) 79×30
//     0x1000027D — action button #3   (198,534) 79×30
//     0x1000027E — action button #4   (18,567) 79×30
//     0x1000027F — action button #5   (108,567) 79×30
//     0x10000280 — action button #6   (198,567) 79×30
//
//   ORPHAN tab tree 0x10000281 (279×32, 2 states):
//     0x10000282 — header bar      (0,0)   279×16
//       0x10000283 — title text    (0,0)   190×16
//       0x10000284 — header right  (199,0) 80×16
//     0x10000285 — Tab Allegiance  (0,16)  93×16, type=7
//     0x10000287 — Tab Fellowship  (93,16) 93×16, type=7
//     0x10000289 — Tab Friends    (186,16) 93×16, type=7
//
// Compression: native 300×600 layout into main-panel's 300×337 body.
// scaleY = bodyH / 600. Horizontal x/width applied unchanged. This
// mirrors character-info's Title-tab handling — see TITLE_NATIVE_H +
// applyCharacterInfoLayout in plugins/character-info.js.
//
// v1 fetch_layout caveat: only geometry serialized. Action-button
// labels (Recruit/Disband/Leave/etc.) + option-row text + the 4
// Holtburger fellowship options are hand-tuned (StateDesc /
// BaseProperty text content unwired — see G3 in layout-port-plan).

import { setAcText } from "../ui/ac_font.js";
import { loadLayout, findElementById, getCachedLayout } from "../ui/ac_layout.js";
import { modalConfirmCallback } from "./modal-dialog.js";

const STYLE_ID = "hb-fellow-view-style";

// gmFellowshipUI 0x21000030 — element_id constants from
// fellowship_panel_layout_dump 2026-05-24. See head-comment block above
// for the full element-purpose mapping.
const FELLOWSHIP_LAYOUT_ID = 0x21000030;

// Alone-state element_ids (subtree 0x1000026B).
const FE_ALONE_EMPTY     = 0x1000026C;
const FE_ALONE_DIVIDER   = 0x1000026D;
const FE_ALONE_NAME_LBL  = 0x1000026E;
const FE_ALONE_NAME_INP  = 0x1000026F;
const FE_ALONE_OPT_ROW_1 = 0x10000270;
const FE_ALONE_OPT_ROW_2 = 0x10000271;
const FE_ALONE_OPT_ROW_3 = 0x10000272;
const FE_ALONE_OPT_ROW_4 = 0x10000273;
const FE_ALONE_CREATE    = 0x10000274;

// InFellowship-state element_ids (subtree 0x10000275).
const FE_IN_HEADER       = 0x10000276;
const FE_IN_COL_NAME     = 0x10000277;
const FE_IN_COL_LEVEL    = 0x10000278;
const FE_IN_LIST         = 0x10000279;
const FE_IN_SCROLLBAR    = 0x1000027A;
const FE_IN_BTN_1        = 0x1000027B;
const FE_IN_BTN_2        = 0x1000027C;
const FE_IN_BTN_3        = 0x1000027D;
const FE_IN_BTN_4        = 0x1000027E;
const FE_IN_BTN_5        = 0x1000027F;
const FE_IN_BTN_6        = 0x10000280;

// Orphan companion-tab strip (subtree 0x10000281).
const FE_TAB_BAR         = 0x10000281;
const FE_TAB_ALLEG       = 0x10000285;
const FE_TAB_FELLOWSHIP  = 0x10000287;
const FE_TAB_FRIENDS     = 0x10000289;

// Native layout height — used to compute scaleY for main-panel's body
// (337 px tall) so the InFellowship state's action buttons at y≈567
// land inside our pane instead of overflowing.
const FELLOWSHIP_NATIVE_H = 600;

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    /* Fellowship view — mounts inside main-panel's body slot (300×337).
       Native gmFellowshipUI layout is 300×600 — we compress vertical
       positions via scaleY (mirroring character-info's Title tab).
       The hand-tuned positions below act as fallback when fetch_layout
       fails; applyFellowshipLayout() then overrides with retail values. */
    .hb-fellow-root {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      box-sizing: border-box;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      overflow: hidden;
    }
    /* Companion-tab strip — retail orphan tree 0x10000281 (279×32).
       3 retail tabs (Allegiance/Fellowship/Friends); Holtburger keeps
       a 4th (Squelch) as a stub for future wiring. */
    .hb-fellow-tabs {
      position: absolute;
      top: 0;
      left: 0;
      width: 279px;
      height: 32px;
      box-sizing: border-box;
      display: block;
      padding: 0;
      pointer-events: auto;
    }
    .hb-fellow-tabs-header {
      position: absolute;
      top: 0; left: 0;
      width: 279px;
      height: 16px;
      box-sizing: border-box;
      background: rgba(0, 0, 0, 0.45);
      border-bottom: 1px solid var(--hb-border-brass-dim);
      display: flex;
      align-items: center;
      padding: 0 4px;
      font-size: 10px;
      color: var(--hb-text-gold);
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .hb-fellow-tab {
      position: absolute;
      top: 16px;
      width: 93px;
      height: 16px;
      box-sizing: border-box;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream-bright);
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--hb-border-brass-dim);
      border-bottom: none;
      cursor: pointer;
      user-select: none;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .hb-fellow-tab:hover { background: var(--hb-overlay-hover); }
    .hb-fellow-tab.active {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
      border-color: var(--hb-border-brass);
    }
    /* "Alone" empty-state text — retail 0x1000026C (8,18) 284×120. */
    .hb-fellow-empty {
      position: absolute;
      top: 18px;
      left: 8px;
      width: 284px;
      height: 120px;
      box-sizing: border-box;
      padding: 8px 6px;
      font-size: 11px;
      line-height: 16px;
      color: var(--hb-text-cream);
      text-align: center;
      background: rgba(0, 0, 0, 0.25);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    /* Divider sprite — retail 0x1000026D (0,191) 300×9. */
    .hb-fellow-divider {
      position: absolute;
      top: 191px;
      left: 0;
      width: 300px;
      height: 9px;
      box-sizing: border-box;
      background: url("./data/ui-sprites/0x06001420.png") center/auto 100% no-repeat;
    }
    /* Name label — retail 0x1000026E (0,200) 148×18. */
    .hb-fellow-name-lbl {
      position: absolute;
      top: 200px;
      left: 0;
      width: 148px;
      height: 18px;
      box-sizing: border-box;
      padding: 0 6px;
      font-size: 10px;
      color: var(--hb-text-cream-bright);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      display: flex;
      align-items: center;
      justify-content: flex-end;
    }
    /* Name input — retail 0x1000026F (148,200) 147×18. */
    .hb-fellow-input {
      position: absolute;
      top: 200px;
      left: 148px;
      width: 147px;
      height: 18px;
      box-sizing: border-box;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid var(--hb-border-brass-dim);
      color: var(--hb-text-cream);
      font-family: var(--hb-font-serif);
      font-size: 11px;
      padding: 2px 6px;
      outline: none;
    }
    .hb-fellow-input:focus { border-color: var(--hb-border-brass); }
    /* Option row — retail 0x10000270/71/72/73 (25,225 + 14*n) 275×14. */
    .hb-fellow-opt {
      position: absolute;
      left: 25px;
      width: 275px;
      height: 14px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 4px;
      font-size: 10px;
      cursor: pointer;
      user-select: none;
    }
    .hb-fellow-opt .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.65);
      border: 1px solid var(--hb-border-brass-dim);
      flex: 0 0 8px;
    }
    .hb-fellow-opt.on .dot {
      background: var(--hb-text-numeric-green);
      border-color: var(--hb-border-brass);
      box-shadow: 0 0 4px rgba(120, 220, 120, 0.6);
    }
    .hb-fellow-opt-text {
      flex: 1 1 auto;
      color: var(--hb-text-cream);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.85);
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    /* Create button — retail 0x10000274 (33,298) 234×33. */
    .hb-fellow-create {
      position: absolute;
      top: 298px;
      left: 33px;
      width: 234px;
      height: 33px;
      box-sizing: border-box;
      padding: 6px 12px;
      font-family: var(--hb-font-serif);
      font-size: 12px;
      letter-spacing: 0.06em;
      color: var(--hb-text-cream);
      background: linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      border: 1px solid var(--hb-border-brass);
      cursor: pointer;
      text-transform: uppercase;
      user-select: none;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .hb-fellow-create:hover {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
    .hb-fellow-create:disabled,
    .hb-fellow-create[aria-disabled="true"] {
      opacity: 0.55;
      cursor: not-allowed;
    }
    /* ---- "In fellowship" state ---- */
    /* Header strip — retail 0x10000276 (0,2) 300×18. */
    .hb-fellow-in-header {
      position: absolute;
      top: 2px;
      left: 0;
      width: 300px;
      height: 18px;
      box-sizing: border-box;
      padding: 0 8px;
      background: rgba(0, 0, 0, 0.45);
      border-bottom: 1px solid var(--hb-border-brass-dim);
      font-size: 10px;
      color: var(--hb-text-gold);
      display: flex;
      align-items: center;
      letter-spacing: 0.04em;
    }
    /* Column headers — retail 0x10000277 (8,22) 100×18 + 0x10000278 (179,22) 100×18. */
    .hb-fellow-in-col {
      position: absolute;
      top: 22px;
      height: 18px;
      box-sizing: border-box;
      padding: 0 4px;
      font-size: 10px;
      color: var(--hb-text-cream-bright);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      display: flex;
      align-items: center;
      border-bottom: 1px solid var(--hb-border-brass-dim);
    }
    .hb-fellow-in-col-name  { left: 8px;   width: 100px; }
    .hb-fellow-in-col-level { left: 179px; width: 100px; }
    /* Member list — retail 0x10000279 (8,38) 271×487, type=5 (list). */
    .hb-fellow-members {
      position: absolute;
      top: 38px;
      left: 8px;
      width: 271px;
      height: 487px;
      box-sizing: border-box;
      overflow-y: auto;
      padding: 2px 4px;
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.5);
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid var(--hb-border-brass-dim);
    }
    /* List scrollbar slot — retail 0x1000027A (279,38) 16×487. */
    .hb-fellow-in-scrollbar {
      position: absolute;
      top: 38px;
      left: 279px;
      width: 16px;
      height: 487px;
      box-sizing: border-box;
      pointer-events: none;
      background: transparent;
    }
    .hb-fellow-member {
      display: flex;
      flex-direction: column;
      gap: 1px;
      padding: 3px 4px;
      border-bottom: 1px solid rgba(138, 117, 68, 0.18);
    }
    .hb-fellow-member-h {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
    }
    .hb-fellow-member-h .name { color: var(--hb-text-cream); }
    .hb-fellow-member-h .level { color: var(--hb-text-gold); }
    .hb-fellow-bar {
      position: relative;
      height: 4px;
      background: url("./data/ui-sprites/0x06002521.png") left/100% 100% no-repeat;
      overflow: hidden;
    }
    .hb-fellow-bar-fill {
      position: absolute;
      top: 0; left: 0; bottom: 0;
      background: left/auto 100% no-repeat;
      transition: width 120ms linear;
    }
    .hb-fellow-bar.health  .hb-fellow-bar-fill { background-image: url("./data/ui-sprites/0x0600251C.png"); }
    .hb-fellow-bar.stamina .hb-fellow-bar-fill { background-image: url("./data/ui-sprites/0x06002520.png"); }
    .hb-fellow-bar.mana    .hb-fellow-bar-fill { background-image: url("./data/ui-sprites/0x0600251F.png"); }
    /* Action buttons — retail 0x1000027B-0x10000280 (79×30 each), arranged
       in 2 rows of 3 at y=534 and y=567 with x=18/108/198. */
    .hb-fellow-in-btn {
      position: absolute;
      width: 79px;
      height: 30px;
      box-sizing: border-box;
      padding: 4px 6px;
      font-family: var(--hb-font-serif);
      font-size: 10px;
      letter-spacing: 0.03em;
      color: var(--hb-text-cream);
      background: linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      border: 1px solid var(--hb-border-brass);
      cursor: pointer;
      text-transform: uppercase;
      user-select: none;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .hb-fellow-in-btn:hover {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
  `;
  document.head.appendChild(style);
}

function emit(msgText, cat = 0) {
  const log = document.getElementById("chat-log");
  if (!log) return;
  const li = document.createElement("li");
  li.className = `cat-${cat}`;
  li.dataset.cat = String(cat);
  li.textContent = msgText;
  log.appendChild(li);
}

// Pull the currently selected entity GUID (set by scene3d/picking.js
// when the user clicks an entity in the world). Returns null when no
// target is selected.
function currentSelectedGuid() {
  try {
    const em = window.liveScene3d?.entityManager;
    const g = em?.getSelectedTarget?.();
    return g ? (g >>> 0) : null;
  } catch (_) {
    return null;
  }
}

function withSession(label, fn) {
  const handle = window.__sessionHandle;
  if (typeof handle?.[label] !== "function") {
    emit(`[fellowship] Wasm session not ready (${label}).`);
    return;
  }
  try {
    fn(handle);
  } catch (err) {
    emit(`[fellowship] ${label} failed: ${err?.message ?? err}`);
  }
}

function invokeRecruit() {
  const guid = currentSelectedGuid();
  if (!guid) {
    emit("[fellowship] Click an entity first (Recruit target).");
    return;
  }
  withSession("fellowshipRecruit", (h) => {
    h.fellowshipRecruit(guid);
    emit(`[fellowship/recruit] target=0x${guid.toString(16).padStart(8, "0")}`);
  });
}

function invokeAssignLeader() {
  const guid = currentSelectedGuid();
  if (!guid) {
    emit("[fellowship] Click an entity first (Assign Leader target).");
    return;
  }
  withSession("fellowshipAssignNewLeader", (h) => {
    h.fellowshipAssignNewLeader(guid);
    emit(`[fellowship/assign-leader] new_leader=0x${guid.toString(16).padStart(8, "0")}`);
  });
}

function invokeQuit(disband, prompt) {
  modalConfirmCallback({
    title: disband ? "Disband Fellowship" : "Leave Fellowship",
    message: prompt ?? "Leave fellowship?",
    onConfirm: () => {
      withSession("fellowshipQuit", (h) => {
        h.fellowshipQuit(!!disband);
        emit(`[fellowship/quit] disband=${!!disband}`);
      });
    },
  });
}

// Apply gmFellowshipUI 0x21000030 layout to the fellowship-panel
// sub-elements. Native height is 600 px; we compress vertically by
// scaleY = bodyH / FELLOWSHIP_NATIVE_H so the InFellowship action
// buttons at y≈567 stay inside our 337-tall body.
//
// Mounted via main-panel.showView("fellowship") AFTER wasm-ready, so
// no retry loop needed (mirrors character-info's pattern).
//
// refs:
//   root      — outer .hb-fellow-root (sized to main-panel body)
//   tabsEl    — companion-tab strip wrapper
//   tabHeaderEl — top-half header band of tab strip
//   tabBtns   — { allegiance, fellowship, friends } tab buttons
//   aloneRefs — { emptyEl, dividerEl, nameLblEl, inputEl, optEls[4],
//                 createBtnEl } for the Alone state
//   inRefs    — { headerEl, colNameEl, colLevelEl, listEl, scrollbarEl,
//                 btnEls[6] } for the InFellowship state
function applyFellowshipLayout(refs) {
  const apply = (layout) => {
    if (!layout) return;
    let applied = 0;

    // Compute scaleY against the actual mounted body height.
    const bodyH = refs.root?.getBoundingClientRect().height || 337;
    const scaleY = bodyH / FELLOWSHIP_NATIVE_H;

    const applyBox = (el, desc, compressY) => {
      if (!el || !desc) return false;
      el.style.right = "";
      el.style.bottom = "";
      if (typeof desc.x === "number") el.style.left = `${desc.x}px`;
      if (typeof desc.y === "number") {
        el.style.top = compressY
          ? `${Math.round(desc.y * scaleY)}px`
          : `${desc.y}px`;
      }
      if (typeof desc.width === "number") el.style.width = `${desc.width}px`;
      if (typeof desc.height === "number") {
        el.style.height = compressY
          ? `${Math.max(1, Math.round(desc.height * scaleY))}px`
          : `${desc.height}px`;
      }
      return true;
    };

    // ── Companion-tab strip (orphan subtree 0x10000281) ──────────────
    // This sits at (0,0) 279×32 — no compression needed, it fits.
    const tabBar = findElementById(layout, FE_TAB_BAR);
    if (tabBar && refs.tabsEl) {
      if (applyBox(refs.tabsEl, tabBar, false)) applied += 1;
    }
    // Header band — orphan child 0x10000282 (0,0) 279×16, relative to
    // the tab strip. Walk inside the tab subtree for the children.
    const tabAlleg = findElementById(layout, FE_TAB_ALLEG);
    const tabFell  = findElementById(layout, FE_TAB_FELLOWSHIP);
    const tabFrnd  = findElementById(layout, FE_TAB_FRIENDS);
    if (tabAlleg && refs.tabBtns?.allegiance) {
      if (applyBox(refs.tabBtns.allegiance, tabAlleg, false)) applied += 1;
    }
    if (tabFell && refs.tabBtns?.fellowship) {
      if (applyBox(refs.tabBtns.fellowship, tabFell, false)) applied += 1;
    }
    if (tabFrnd && refs.tabBtns?.friends) {
      if (applyBox(refs.tabBtns.friends, tabFrnd, false)) applied += 1;
    }

    // ── Alone-state subtree ──────────────────────────────────────────
    // Compressed via scaleY for the section anchors (empty/divider/name),
    // but OPT rows + Create button get stacked at native 14px stride to
    // keep label text readable — compressed row height would collapse to
    // ~8 px and stack four 10 px-font labels into ~32 px of vertical space,
    // which is the overlap users saw before.
    if (refs.aloneRefs) {
      const nonStackPairs = [
        [FE_ALONE_EMPTY,    refs.aloneRefs.emptyEl],
        [FE_ALONE_DIVIDER,  refs.aloneRefs.dividerEl],
        [FE_ALONE_NAME_LBL, refs.aloneRefs.nameLblEl],
        [FE_ALONE_NAME_INP, refs.aloneRefs.inputEl],
      ];
      for (const [id, el] of nonStackPairs) {
        if (!el) continue;
        const desc = findElementById(layout, id);
        if (!desc) continue;
        if (applyBox(el, desc, true)) applied += 1;
      }
      // OPT rows: place row 1 at retail Y compressed, then stack 2/3/4
      // at +14 px (native height) so labels don't visually overlap.
      const OPT_NATIVE_ROW_H = 14;
      const row1Desc = findElementById(layout, FE_ALONE_OPT_ROW_1);
      const row1El   = refs.aloneRefs.optEls?.[0];
      let row1TopPx = null;
      if (row1Desc && row1El) {
        // Inline override — applyBox would compress height; here we keep H=14.
        row1El.style.right = "";
        row1El.style.bottom = "";
        if (typeof row1Desc.x === "number")     row1El.style.left   = `${row1Desc.x}px`;
        if (typeof row1Desc.width === "number") row1El.style.width  = `${row1Desc.width}px`;
        row1TopPx = typeof row1Desc.y === "number" ? Math.round(row1Desc.y * scaleY) : null;
        if (row1TopPx != null) row1El.style.top = `${row1TopPx}px`;
        row1El.style.height = `${OPT_NATIVE_ROW_H}px`;
        applied += 1;
      }
      // Rows 2/3/4 inherit row 1's left/width/height, stack at +14 stride.
      for (let i = 1; i < 4; i += 1) {
        const el = refs.aloneRefs.optEls?.[i];
        if (!el) continue;
        const rowDesc = findElementById(layout, [FE_ALONE_OPT_ROW_2, FE_ALONE_OPT_ROW_3, FE_ALONE_OPT_ROW_4][i - 1]);
        if (!rowDesc || row1TopPx == null) continue;
        el.style.right = "";
        el.style.bottom = "";
        if (typeof rowDesc.x === "number")     el.style.left  = `${rowDesc.x}px`;
        if (typeof rowDesc.width === "number") el.style.width = `${rowDesc.width}px`;
        el.style.top    = `${row1TopPx + i * OPT_NATIVE_ROW_H}px`;
        el.style.height = `${OPT_NATIVE_ROW_H}px`;
        applied += 1;
      }
      // Create button: anchor below OPT row 4 (+8 px gap) instead of using
      // compressed retail Y (167), which would land *behind* the rows.
      const createDesc = findElementById(layout, FE_ALONE_CREATE);
      const createEl   = refs.aloneRefs.createBtnEl;
      if (createDesc && createEl && row1TopPx != null) {
        createEl.style.right = "";
        createEl.style.bottom = "";
        if (typeof createDesc.x === "number")     createEl.style.left   = `${createDesc.x}px`;
        if (typeof createDesc.width === "number") createEl.style.width  = `${createDesc.width}px`;
        const stackedBottom = row1TopPx + 4 * OPT_NATIVE_ROW_H;
        createEl.style.top    = `${stackedBottom + 8}px`;
        // Keep native height (33) so the button is tappable.
        if (typeof createDesc.height === "number") createEl.style.height = `${createDesc.height}px`;
        applied += 1;
      }
    }

    // ── InFellowship-state subtree ───────────────────────────────────
    // Compressed via scaleY — y=534/567 (button rows) land at ~300/318
    // in our 337-tall body.
    if (refs.inRefs) {
      const inPairs = [
        [FE_IN_HEADER,    refs.inRefs.headerEl],
        [FE_IN_COL_NAME,  refs.inRefs.colNameEl],
        [FE_IN_COL_LEVEL, refs.inRefs.colLevelEl],
        [FE_IN_LIST,      refs.inRefs.listEl],
        [FE_IN_SCROLLBAR, refs.inRefs.scrollbarEl],
        [FE_IN_BTN_1,     refs.inRefs.btnEls?.[0]],
        [FE_IN_BTN_2,     refs.inRefs.btnEls?.[1]],
        [FE_IN_BTN_3,     refs.inRefs.btnEls?.[2]],
        [FE_IN_BTN_4,     refs.inRefs.btnEls?.[3]],
        [FE_IN_BTN_5,     refs.inRefs.btnEls?.[4]],
        [FE_IN_BTN_6,     refs.inRefs.btnEls?.[5]],
      ];
      for (const [id, el] of inPairs) {
        if (!el) continue;
        const desc = findElementById(layout, id);
        if (!desc) continue;
        if (applyBox(el, desc, true)) applied += 1;
      }
    }

    try {
      window.__diag?.layout?.onFellowshipApplied?.({
        applied,
        scaleY,
        bodyH,
      });
    } catch (_) {}
  };
  const cached = getCachedLayout(FELLOWSHIP_LAYOUT_ID);
  if (cached) { apply(cached); return; }
  loadLayout(FELLOWSHIP_LAYOUT_ID).then(apply).catch(() => {});
}

function buildAloneState(root, fellowshipName, opts, onCreate, aloneRefs) {
  const empty = document.createElement("div");
  empty.className = "hb-fellow-empty";
  setAcText(empty, "You do not belong to a fellowship.");
  root.appendChild(empty);

  const divider = document.createElement("div");
  divider.className = "hb-fellow-divider";
  root.appendChild(divider);

  const nameLbl = document.createElement("div");
  nameLbl.className = "hb-fellow-name-lbl";
  setAcText(nameLbl, "Fellowship Name:");
  root.appendChild(nameLbl);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "hb-fellow-input";
  input.placeholder = "Enter a name…";
  input.maxLength = 32;
  input.value = fellowshipName;
  root.appendChild(input);

  const OPT_DEFS = [
    { id: "ignore",     label: "Ignore Fellowship Requests" },
    { id: "autoAccept", label: "Automatically Accept Fellowship Requests" },
    { id: "shareXp",    label: "Share Fellowship Experience and Luminance" },
    { id: "shareLoot",  label: "Share Fellowship Loot" },
  ];
  const optEls = [];
  // Each row gets a per-instance top offset; applyFellowshipLayout will
  // override these with the retail (25, 225 + 14*n) coordinates.
  const FALLBACK_TOP = [225, 239, 253, 267];
  OPT_DEFS.forEach((o, i) => {
    const row = document.createElement("div");
    row.className = "hb-fellow-opt" + (opts[o.id] ? " on" : "");
    row.dataset.optIdx = String(i);
    row.style.top = `${FALLBACK_TOP[i]}px`;
    const dot = document.createElement("span");
    dot.className = "dot";
    row.appendChild(dot);
    const txt = document.createElement("span");
    txt.className = "hb-fellow-opt-text";
    setAcText(txt, o.label);
    txt.style.color = "var(--hb-text-cream)";
    row.appendChild(txt);
    row.addEventListener("click", () => {
      opts[o.id] = !opts[o.id];
      row.classList.toggle("on", opts[o.id]);
      emit(`[fellowship] ${o.label} = ${opts[o.id] ? "on" : "off"} (client-side only)`);
    });
    root.appendChild(row);
    optEls.push(row);
  });

  const createBtn = document.createElement("button");
  createBtn.type = "button";
  createBtn.className = "hb-fellow-create";
  setAcText(createBtn, "Create Fellowship");
  createBtn.addEventListener("click", () => onCreate(input.value.trim()));
  root.appendChild(createBtn);

  // Stash refs back so the layout-applier can position each element.
  if (aloneRefs) {
    aloneRefs.emptyEl     = empty;
    aloneRefs.dividerEl   = divider;
    aloneRefs.nameLblEl   = nameLbl;
    aloneRefs.inputEl     = input;
    aloneRefs.optEls      = optEls;
    aloneRefs.createBtnEl = createBtn;
  }
}

function buildInState(root, members, inRefs) {
  const header = document.createElement("div");
  header.className = "hb-fellow-in-header";
  setAcText(header, "Fellowship Members");
  root.appendChild(header);

  const colName = document.createElement("div");
  colName.className = "hb-fellow-in-col hb-fellow-in-col-name";
  setAcText(colName, "Name");
  root.appendChild(colName);

  const colLevel = document.createElement("div");
  colLevel.className = "hb-fellow-in-col hb-fellow-in-col-level";
  setAcText(colLevel, "Level");
  root.appendChild(colLevel);

  const list = document.createElement("div");
  list.className = "hb-fellow-members";
  for (const m of members) {
    const memberRow = document.createElement("div");
    memberRow.className = "hb-fellow-member";
    const head = document.createElement("div");
    head.className = "hb-fellow-member-h";
    const nameSpan = document.createElement("span");
    nameSpan.className = "name";
    setAcText(nameSpan, m.name);
    head.appendChild(nameSpan);
    const lvl = document.createElement("span");
    lvl.className = "level";
    setAcText(lvl, `Lv ${m.level ?? "?"}`);
    head.appendChild(lvl);
    memberRow.appendChild(head);
    for (const kind of ["health", "stamina", "mana"]) {
      const bar = document.createElement("div");
      bar.className = `hb-fellow-bar ${kind}`;
      const fill = document.createElement("div");
      fill.className = "hb-fellow-bar-fill";
      const pct = m[kind] != null && m[kind + "Max"] ? Math.max(0, Math.min(100, (m[kind] / m[kind + "Max"]) * 100)) : 100;
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);
      memberRow.appendChild(bar);
    }
    list.appendChild(memberRow);
  }
  root.appendChild(list);

  // Phantom scrollbar slot — applyFellowshipLayout writes the retail
  // 16×487 dims onto this for diagnostic visibility (native browser
  // scrollbar inside .hb-fellow-members handles actual scrolling).
  const scrollbar = document.createElement("div");
  scrollbar.className = "hb-fellow-in-scrollbar";
  root.appendChild(scrollbar);

  // 6 action buttons — retail's gmFellowshipUI puts these in 2 rows of
  // 3 at the bottom. Labels mirror retail's typical fellowship actions;
  // each button is wired to its matching wasm GameAction send. Recruit,
  // Pass Leader → require a selected entity (uses scene3d entityManager
  // selection state). The 6th slot previously held a stub "Lock" button
  // (FellowshipChangeOpenness opcode never implemented) — rec #49
  // replaces it with the Vital-Updates toggle that mirrors the
  // standalone overlay's `fellowshipUpdateRequest` call (Player_Fellowship.cs:16
  // batching flag). togglesUpdates entries get a special click handler
  // installed below so the closure captures the button.
  const ACTIONS = [
    { label: "Recruit",     fn: invokeRecruit },
    { label: "Disband",     fn: () => invokeQuit(true,  "Disband fellowship?") },
    { label: "Leave",       fn: () => invokeQuit(false, "Leave fellowship?") },
    { label: "Pass Leader", fn: invokeAssignLeader },
    { label: "Quit",        fn: () => invokeQuit(false, "Quit fellowship?") },
    { label: "Vital Updates", togglesUpdates: true },
  ];
  // Each action button gets a per-instance fallback x/y; the layout
  // applier overrides with retail (18/108/198, 534/567) coords.
  const FALLBACK_BTN_POS = [
    { left: 18,  top: 534 }, { left: 108, top: 534 }, { left: 198, top: 534 },
    { left: 18,  top: 567 }, { left: 108, top: 567 }, { left: 198, top: 567 },
  ];
  const btnEls = [];
  for (let i = 0; i < ACTIONS.length; i++) {
    const action = ACTIONS[i];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hb-fellow-in-btn";
    btn.dataset.action = action.label.toLowerCase().replace(/\s+/g, "-");
    btn.style.left = `${FALLBACK_BTN_POS[i].left}px`;
    btn.style.top  = `${FALLBACK_BTN_POS[i].top}px`;
    setAcText(btn, action.label);
    if (action.togglesUpdates) {
      // Mirror the standalone toggle: share standaloneUpdatesOn so
      // both shells stay in sync when one toggles.
      btn.setAttribute("aria-pressed", String(standaloneUpdatesOn));
      btn.addEventListener("click", () => {
        const next = !standaloneUpdatesOn;
        withSession("fellowshipUpdateRequest", (h) => {
          h.fellowshipUpdateRequest(next);
          standaloneUpdatesOn = next;
          btn.setAttribute("aria-pressed", String(next));
          emit(`[fellowship/update-request] want_updates=${next}`);
        });
      });
    } else if (typeof action.fn === "function") {
      btn.addEventListener("click", action.fn);
    }
    root.appendChild(btn);
    btnEls.push(btn);
  }

  if (inRefs) {
    inRefs.headerEl    = header;
    inRefs.colNameEl   = colName;
    inRefs.colLevelEl  = colLevel;
    inRefs.listEl      = list;
    inRefs.scrollbarEl = scrollbar;
    inRefs.btnEls      = btnEls;
  }
}

export const view = {
  name: "Fellowship",
  nameFor: () => "Fellowship",
  mount: (parentEl, _ctx) => {
    ensureStyles();
    const root = document.createElement("div");
    root.className = "hb-fellow-root";

    // Tabs — Holtburger adds Squelch as a 4th tab. Retail layout only
    // provides 3 (Allegiance/Fellowship/Friends); Squelch sits at the
    // right of the strip outside the layout's coordinates.
    const tabs = document.createElement("div");
    tabs.className = "hb-fellow-tabs";

    const tabHeader = document.createElement("div");
    tabHeader.className = "hb-fellow-tabs-header";
    setAcText(tabHeader, "Fellowship");
    tabs.appendChild(tabHeader);

    const tabBtns = {};
    const TAB_DEFS = [
      { id: "allegiance", key: "allegiance", label: "Allegiance", swap: "allegiance" },
      { id: "fellowship", key: "fellowship", label: "Fellowship", current: true },
      { id: "friends",    key: "friends",    label: "Friends",    swap: null },
    ];
    for (const t of TAB_DEFS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hb-fellow-tab" + (t.current ? " active" : "");
      btn.dataset.tab = t.id;
      setAcText(btn, t.label);
      if (t.swap) {
        btn.addEventListener("click", () => window.__mainPanel?.showView?.(t.swap));
      } else if (!t.current) {
        btn.addEventListener("click", () => emit(`[fellowship] ${t.label} tab not wired yet`));
      }
      tabs.appendChild(btn);
      tabBtns[t.key] = btn;
    }
    root.appendChild(tabs);

    // Wave D: Fellowship state — alone vs in, driven by the real
    // wasm snapshot (kind=22 fellowshipUpdated). The Alone-state DOM
    // includes the Create form; the InFellowship DOM lists members
    // with vital bars. `__hbFellowshipDebug` overrides for testing.
    let opts = { ignore: false, autoAccept: false, shareXp: true, shareLoot: true };
    let fellowshipName = "";

    // `stateRoot` wraps both DOM subtrees so a re-render can teardown
    // the previous tree and rebuild for the new snapshot shape (Alone
    // ↔ InFellowship transitions on join/disband).
    const stateRoot = document.createElement("div");
    stateRoot.style.position = "absolute";
    stateRoot.style.top = "32px";
    stateRoot.style.left = "0";
    stateRoot.style.right = "0";
    stateRoot.style.bottom = "0";

    let mountedRefs = { aloneRefs: null, inRefs: null };

    function deriveMembers(snapshot) {
      if (!snapshot) return [];
      return snapshot.members.map((m) => ({
        guid:        m.guid,
        name:        m.name,
        level:       m.level,
        health:      m.currentHealth,
        healthMax:   m.maxHealth,
        stamina:     m.currentStamina,
        staminaMax:  m.maxStamina,
        mana:        m.currentMana,
        manaMax:     m.maxMana,
        isLeader:    (m.guid >>> 0) === (snapshot.leaderGuid >>> 0),
        shareLoot:   m.shareLoot,
      }));
    }

    function rebuildFromSnapshot(snapshot) {
      while (stateRoot.firstChild) stateRoot.removeChild(stateRoot.firstChild);
      const aloneRefs = {};
      const inRefs = {};
      const debug = window.__hbFellowshipDebug;
      const debugMembers = (debug && Array.isArray(debug.members) && debug.members.length > 0)
        ? debug.members : null;
      const members = debugMembers ?? deriveMembers(snapshot);
      if (members.length > 0) {
        // Prefix leader with "*" via the existing buildInState shape —
        // it doesn't know about leader markers, so embed inline.
        const labeled = members.map((m) => ({
          ...m,
          name: m.isLeader ? `* ${m.name}` : m.name,
        }));
        buildInState(stateRoot, labeled, inRefs);
      } else {
        buildAloneState(stateRoot, fellowshipName, opts, (name) => {
          if (!name) {
            emit("[fellowship] Cannot create — name required.");
            return;
          }
          const handle = window.__sessionHandle;
          if (typeof handle?.fellowshipCreate !== "function") {
            emit("[fellowship] Wasm session not ready.");
            return;
          }
          try {
            handle.fellowshipCreate(name, !!opts.shareXp);
            emit(`[fellowship/create] name="${name}" share_xp=${!!opts.shareXp}`);
          } catch (err) {
            emit(`[fellowship] Create failed: ${err?.message ?? err}`);
          }
        }, aloneRefs);
      }
      mountedRefs = { aloneRefs, inRefs };

      // Re-apply layout positions whenever the DOM shape flips.
      applyFellowshipLayout({
        root,
        tabsEl: tabs,
        tabHeaderEl: tabHeader,
        tabBtns,
        aloneRefs: mountedRefs.aloneRefs,
        inRefs: mountedRefs.inRefs,
      });
    }

    rebuildFromSnapshot(fetchFellowshipSnapshot());
    root.appendChild(stateRoot);

    parentEl.appendChild(root);

    // Apply retail layout positions for tabs (member content layout
    // re-applies inside rebuildFromSnapshot). The applier reads
    // root.getBoundingClientRect() for scaleY, so the call must
    // happen AFTER parentEl.appendChild(root).
    applyFellowshipLayout({
      root,
      tabsEl: tabs,
      tabHeaderEl: tabHeader,
      tabBtns,
      aloneRefs: mountedRefs.aloneRefs,
      inRefs: mountedRefs.inRefs,
    });

    // Re-render whenever the wasm side emits fellowshipUpdated — covers
    // join/leave/disband as well as per-member vital ticks.
    const unsub = subscribeFellowship(() => {
      rebuildFromSnapshot(fetchFellowshipSnapshot());
    });

    return () => {
      try { unsub(); } catch (_) {}
      root.remove();
    };
  },
};

export const manifest = {
  id: "fellowship-panel",
  name: "Fellowship",
  icon: "🤝",
  iconHidden: true,
  version: "0.1.0",
  description: "Fellowship view (gmFellowshipUI 0x21000030)",
};

// ─────────────────────────────────────────────────────────────────
// Standalone floating action panel
//
// Lightweight overlay distinct from the main-panel `view` export
// above. Exposes window.__openFellowshipPanel / __closeFellowshipPanel
// for ad-hoc opening from devtools or hotkeys. 6 spec-aligned buttons:
// Create, Quit, Recruit, Dismiss, Assign Leader, Toggle Updates.
//
// State (member list / leader stats) is Wave-D scope — placeholder
// text below the action grid says so.
// ─────────────────────────────────────────────────────────────────

const STANDALONE_STYLE_ID = "hb-fellow-standalone-style";
const STANDALONE_OVERLAY_ID = "hb-fellow-standalone";

function ensureStandaloneStyles() {
  if (document.getElementById(STANDALONE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STANDALONE_STYLE_ID;
  style.textContent = `
    #${STANDALONE_OVERLAY_ID} {
      position: fixed;
      top: 120px;
      right: 24px;
      width: 280px;
      box-sizing: border-box;
      z-index: 12000;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      background: linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      border: 1px solid var(--hb-border-brass);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.65);
      display: none;
    }
    #${STANDALONE_OVERLAY_ID}.open { display: block; }
    .hb-fellow-sa-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      background: rgba(0, 0, 0, 0.45);
      border-bottom: 1px solid var(--hb-border-brass-dim);
      font-size: 12px;
      color: var(--hb-text-gold);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      user-select: none;
    }
    .hb-fellow-sa-x {
      width: 18px;
      height: 18px;
      padding: 0;
      background: transparent;
      border: 1px solid var(--hb-border-brass-dim);
      color: var(--hb-text-cream);
      font-family: inherit;
      cursor: pointer;
      line-height: 1;
    }
    .hb-fellow-sa-x:hover {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
    .hb-fellow-sa-body { padding: 8px 10px; }
    .hb-fellow-sa-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      margin-bottom: 10px;
    }
    .hb-fellow-sa-btn {
      box-sizing: border-box;
      padding: 6px 4px;
      font-family: var(--hb-font-serif);
      font-size: 10px;
      letter-spacing: 0.04em;
      color: var(--hb-text-cream);
      background: linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      border: 1px solid var(--hb-border-brass);
      cursor: pointer;
      text-transform: uppercase;
      user-select: none;
    }
    .hb-fellow-sa-btn:hover {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
    .hb-fellow-sa-btn[aria-pressed="true"] {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
    .hb-fellow-sa-create {
      display: none;
      margin: 0 0 10px 0;
      padding: 6px;
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid var(--hb-border-brass-dim);
    }
    .hb-fellow-sa-create.open { display: block; }
    .hb-fellow-sa-create label {
      display: block;
      font-size: 10px;
      color: var(--hb-text-cream-bright);
      margin-bottom: 4px;
      letter-spacing: 0.04em;
    }
    .hb-fellow-sa-create input[type="text"] {
      width: 100%;
      box-sizing: border-box;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid var(--hb-border-brass-dim);
      color: var(--hb-text-cream);
      font-family: var(--hb-font-serif);
      font-size: 11px;
      padding: 2px 4px;
      margin-bottom: 6px;
      outline: none;
    }
    .hb-fellow-sa-create input[type="text"]:focus { border-color: var(--hb-border-brass); }
    .hb-fellow-sa-create .row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 10px;
      margin-bottom: 6px;
    }
    .hb-fellow-sa-create button {
      width: 100%;
      box-sizing: border-box;
      padding: 4px;
      font-family: var(--hb-font-serif);
      font-size: 10px;
      letter-spacing: 0.04em;
      color: var(--hb-text-cream);
      background: linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      border: 1px solid var(--hb-border-brass);
      cursor: pointer;
      text-transform: uppercase;
    }
    .hb-fellow-sa-create button:hover {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
    .hb-fellow-sa-state {
      padding: 8px 6px;
      font-size: 10px;
      color: rgba(220, 200, 160, 0.55);
      font-style: italic;
      border-top: 1px solid var(--hb-border-brass-dim);
      text-align: center;
    }
    /* Wave D — populated fellowship state */
    .hb-fellow-state-hdr {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      padding: 4px 6px;
      font-size: 11px;
      color: var(--hb-text-gold);
      border-top: 1px solid var(--hb-border-brass-dim);
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .hb-fellow-state-hdr .name {
      flex: 1 1 auto;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .hb-fellow-state-hdr .locked {
      flex: 0 0 auto;
      margin-left: 6px;
      color: var(--hb-text-cream-bright);
      font-size: 9px;
      background: rgba(160, 40, 40, 0.55);
      border: 1px solid var(--hb-border-brass-dim);
      padding: 0 4px;
    }
    .hb-fellow-state-rows {
      padding: 2px 4px 4px 4px;
      max-height: 240px;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.4);
    }
    .hb-fellow-state-row {
      display: grid;
      grid-template-columns: 14px 1fr auto;
      gap: 4px;
      align-items: center;
      height: 18px;
      padding: 1px 2px;
      font-size: 10px;
      border-bottom: 1px solid rgba(138, 117, 68, 0.18);
    }
    .hb-fellow-state-row.leader { color: var(--hb-text-gold); }
    .hb-fellow-state-row .marker {
      text-align: center;
      color: var(--hb-text-gold);
      font-weight: bold;
    }
    .hb-fellow-state-row .name {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .hb-fellow-state-row .meta {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 9px;
      color: var(--hb-text-cream-bright);
    }
    .hb-fellow-state-row .bars {
      grid-column: 1 / span 3;
      display: flex;
      gap: 2px;
      margin-top: 1px;
    }
    .hb-fellow-state-bar {
      flex: 1 1 auto;
      height: 3px;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid rgba(0, 0, 0, 0.65);
      position: relative;
      overflow: hidden;
    }
    .hb-fellow-state-bar > span {
      display: block;
      height: 100%;
    }
    .hb-fellow-state-bar.health > span  { background: #c33; }
    .hb-fellow-state-bar.stamina > span { background: #c9a23a; }
    .hb-fellow-state-bar.mana > span    { background: #4a8bd6; }
    .hb-fellow-state-row .xp-mark {
      color: var(--hb-text-numeric-green);
      font-size: 9px;
    }
    .hb-fellow-state-departed {
      margin-top: 4px;
      padding: 2px 4px;
      border-top: 1px solid var(--hb-border-brass-dim);
      font-size: 10px;
    }
    .hb-fellow-state-departed summary {
      cursor: pointer;
      color: var(--hb-text-cream-bright);
      letter-spacing: 0.04em;
      user-select: none;
      list-style: none;
    }
    .hb-fellow-state-departed summary::before {
      content: "▸ ";
      color: var(--hb-text-gold);
    }
    .hb-fellow-state-departed[open] summary::before { content: "▾ "; }
    .hb-fellow-state-departed ul {
      list-style: none;
      margin: 4px 0 0 0;
      padding: 0 0 0 12px;
      color: rgba(220, 200, 160, 0.7);
    }
    .hb-fellow-state-departed li {
      font-size: 9px;
      padding: 1px 0;
    }
    .hb-fellow-state-empty {
      padding: 8px 6px;
      font-size: 10px;
      color: rgba(220, 200, 160, 0.55);
      font-style: italic;
      border-top: 1px solid var(--hb-border-brass-dim);
      text-align: center;
    }
    .hb-fellow-sa-toast {
      position: absolute;
      left: 10px;
      right: 10px;
      bottom: 6px;
      padding: 4px 6px;
      font-size: 10px;
      text-align: center;
      background: rgba(0, 0, 0, 0.75);
      border: 1px solid var(--hb-border-brass);
      color: var(--hb-text-gold);
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
}

let standaloneOverlay = null;
let standaloneUpdatesOn = false;

// Wave D — pull the live fellowship snapshot off the wasm handle.
// Returns the JS-side wrapper (or null pre-join / post-disband).
function fetchFellowshipSnapshot() {
  const handle = window.__sessionHandle;
  if (typeof handle?.playerFellowship !== "function") return null;
  try {
    return handle.playerFellowship() ?? null;
  } catch (_) {
    return null;
  }
}

// Wave D — populate `container` with the populated-fellowship view
// (header, member rows with vital bars + leader marker, departed list)
// or the empty-state message. Idempotent: caller clears container
// before calling on each event-driven rerender.
function renderFellowshipState(container, snapshot) {
  while (container.firstChild) container.removeChild(container.firstChild);
  if (!snapshot) {
    const empty = document.createElement("div");
    empty.className = "hb-fellow-state-empty";
    setAcText(empty, "Not in a fellowship — Create or wait for Recruit.");
    container.appendChild(empty);
    return;
  }
  const hdr = document.createElement("div");
  hdr.className = "hb-fellow-state-hdr";
  const nameEl = document.createElement("span");
  nameEl.className = "name";
  setAcText(nameEl, snapshot.name || "(unnamed)");
  hdr.appendChild(nameEl);
  if (snapshot.isLocked) {
    const lock = document.createElement("span");
    lock.className = "locked";
    setAcText(lock, "LOCKED");
    hdr.appendChild(lock);
  }
  container.appendChild(hdr);

  const rows = document.createElement("div");
  rows.className = "hb-fellow-state-rows";
  const leaderGuid = (snapshot.leaderGuid >>> 0);
  // members getter returns Vec<FellowshipMemberJs> — wasm-bindgen array
  for (const m of snapshot.members) {
    const isLeader = (m.guid >>> 0) === leaderGuid;
    const row = document.createElement("div");
    row.className = "hb-fellow-state-row" + (isLeader ? " leader" : "");
    const marker = document.createElement("span");
    marker.className = "marker";
    marker.textContent = isLeader ? "*" : "";
    row.appendChild(marker);
    const nm = document.createElement("span");
    nm.className = "name";
    setAcText(nm, m.name || `0x${(m.guid >>> 0).toString(16).padStart(8, "0")}`);
    row.appendChild(nm);
    const meta = document.createElement("span");
    meta.className = "meta";
    const lvl = document.createElement("span");
    setAcText(lvl, `L${m.level || "?"}`);
    meta.appendChild(lvl);
    if (snapshot.shareXp) {
      const xp = document.createElement("span");
      xp.className = "xp-mark";
      xp.textContent = "XP";
      xp.title = "Sharing XP with this member";
      meta.appendChild(xp);
    }
    row.appendChild(meta);

    const bars = document.createElement("div");
    bars.className = "bars";
    const VITALS = [
      { key: "health",  cur: m.currentHealth,  max: m.maxHealth },
      { key: "stamina", cur: m.currentStamina, max: m.maxStamina },
      { key: "mana",    cur: m.currentMana,    max: m.maxMana },
    ];
    for (const v of VITALS) {
      const bar = document.createElement("div");
      bar.className = `hb-fellow-state-bar ${v.key}`;
      const fill = document.createElement("span");
      const pct = v.max > 0 ? Math.max(0, Math.min(100, (v.cur / v.max) * 100)) : 0;
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);
      bar.title = `${v.key} ${v.cur}/${v.max}`;
      bars.appendChild(bar);
    }
    row.appendChild(bars);
    rows.appendChild(row);
  }
  container.appendChild(rows);

  if (snapshot.departed && snapshot.departed.length > 0) {
    const details = document.createElement("details");
    details.className = "hb-fellow-state-departed";
    const sum = document.createElement("summary");
    setAcText(sum, `Departed (${snapshot.departed.length})`);
    details.appendChild(sum);
    const ul = document.createElement("ul");
    for (const d of snapshot.departed) {
      const li = document.createElement("li");
      const guidHex = `0x${(d.guid >>> 0).toString(16).padStart(8, "0").toUpperCase()}`;
      setAcText(li, guidHex);
      ul.appendChild(li);
    }
    details.appendChild(ul);
    container.appendChild(details);
  }
}

// Subscribe `rerender` to fellowshipUpdated events on the plugin bus,
// returning an unsubscribe handle for unmount cleanup. Mirrors how
// other plugins consume `__pluginClient.events`.
function subscribeFellowship(rerender) {
  const bus = window.__pluginClient?.events;
  if (!bus || typeof bus.on !== "function") return () => {};
  const listener = () => {
    try { rerender(); } catch (_) {}
  };
  bus.on("fellowshipUpdated", listener);
  return () => {
    if (typeof bus.off === "function") bus.off("fellowshipUpdated", listener);
  };
}

function standaloneToast(text) {
  if (!standaloneOverlay) return;
  const old = standaloneOverlay.querySelector(".hb-fellow-sa-toast");
  if (old) old.remove();
  const t = document.createElement("div");
  t.className = "hb-fellow-sa-toast";
  t.textContent = text;
  standaloneOverlay.appendChild(t);
  setTimeout(() => t.remove(), 1750);
}

function buildStandaloneOverlay() {
  ensureStandaloneStyles();
  const overlay = document.createElement("div");
  overlay.id = STANDALONE_OVERLAY_ID;

  const hdr = document.createElement("div");
  hdr.className = "hb-fellow-sa-hdr";
  const title = document.createElement("span");
  setAcText(title, "Fellowship");
  hdr.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "hb-fellow-sa-x";
  closeBtn.title = "Close (Esc)";
  closeBtn.textContent = "x";
  closeBtn.addEventListener("click", closeStandalone);
  hdr.appendChild(closeBtn);
  overlay.appendChild(hdr);

  const body = document.createElement("div");
  body.className = "hb-fellow-sa-body";

  // Inline Create form — toggled by the Create button below.
  const createForm = document.createElement("div");
  createForm.className = "hb-fellow-sa-create";
  const nameLbl = document.createElement("label");
  setAcText(nameLbl, "Fellowship Name");
  createForm.appendChild(nameLbl);
  const nameInp = document.createElement("input");
  nameInp.type = "text";
  nameInp.maxLength = 32;
  nameInp.placeholder = "Enter a name…";
  createForm.appendChild(nameInp);
  const shareRow = document.createElement("div");
  shareRow.className = "row";
  const shareCb = document.createElement("input");
  shareCb.type = "checkbox";
  shareCb.id = "hb-fellow-sa-share";
  shareCb.checked = true;
  const shareLabel = document.createElement("label");
  shareLabel.htmlFor = "hb-fellow-sa-share";
  setAcText(shareLabel, "Share XP?");
  shareRow.appendChild(shareCb);
  shareRow.appendChild(shareLabel);
  createForm.appendChild(shareRow);
  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  setAcText(confirmBtn, "Confirm Create");
  confirmBtn.addEventListener("click", () => {
    const name = nameInp.value.trim();
    if (!name) {
      standaloneToast("Name required");
      return;
    }
    withSession("fellowshipCreate", (h) => {
      h.fellowshipCreate(name, shareCb.checked);
      emit(`[fellowship/create] name="${name}" share_xp=${shareCb.checked}`);
      standaloneToast(`Created "${name}"`);
      createForm.classList.remove("open");
      nameInp.value = "";
    });
  });
  createForm.appendChild(confirmBtn);
  body.appendChild(createForm);

  // 2×3 action button grid — spec layout.
  const grid = document.createElement("div");
  grid.className = "hb-fellow-sa-grid";

  const ACTIONS = [
    {
      label: "Create",
      onClick: () => createForm.classList.toggle("open"),
    },
    {
      label: "Quit",
      onClick: () => {
        modalConfirmCallback({
          title: "Quit Fellowship",
          message: "Quit fellowship?",
          onConfirm: () => {
            withSession("fellowshipQuit", (h) => {
              h.fellowshipQuit(false);
              emit("[fellowship/quit] disband=false");
              standaloneToast("Quit sent");
            });
          },
        });
      },
    },
    {
      label: "Recruit",
      onClick: () => {
        const guid = currentSelectedGuid();
        if (!guid) { standaloneToast("Click an entity first"); return; }
        withSession("fellowshipRecruit", (h) => {
          h.fellowshipRecruit(guid);
          emit(`[fellowship/recruit] target=0x${guid.toString(16).padStart(8, "0")}`);
          standaloneToast("Recruit sent");
        });
      },
    },
    {
      label: "Dismiss",
      onClick: () => {
        const guid = currentSelectedGuid();
        if (!guid) { standaloneToast("Click an entity first"); return; }
        withSession("fellowshipDismiss", (h) => {
          h.fellowshipDismiss(guid);
          emit(`[fellowship/dismiss] member=0x${guid.toString(16).padStart(8, "0")}`);
          standaloneToast("Dismiss sent");
        });
      },
    },
    {
      label: "Assign Leader",
      onClick: () => {
        const guid = currentSelectedGuid();
        if (!guid) { standaloneToast("Click an entity first"); return; }
        withSession("fellowshipAssignNewLeader", (h) => {
          h.fellowshipAssignNewLeader(guid);
          emit(`[fellowship/assign-leader] new_leader=0x${guid.toString(16).padStart(8, "0")}`);
          standaloneToast("Assign sent");
        });
      },
    },
    {
      label: "Toggle Updates",
      togglesUpdates: true,
      onClick: (btn) => {
        const next = !standaloneUpdatesOn;
        withSession("fellowshipUpdateRequest", (h) => {
          h.fellowshipUpdateRequest(next);
          standaloneUpdatesOn = next;
          btn.setAttribute("aria-pressed", String(next));
          emit(`[fellowship/update-request] want_updates=${next}`);
          standaloneToast(next ? "Updates: on" : "Updates: off");
        });
      },
    },
  ];

  for (const a of ACTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hb-fellow-sa-btn";
    btn.dataset.action = a.label.toLowerCase().replace(/\s+/g, "-");
    if (a.togglesUpdates) btn.setAttribute("aria-pressed", "false");
    setAcText(btn, a.label);
    btn.addEventListener("click", () => a.onClick(btn));
    grid.appendChild(btn);
  }
  body.appendChild(grid);

  // Wave D — populated state container, re-rendered on every
  // fellowshipUpdated event from the plugin bus.
  const stateContainer = document.createElement("div");
  stateContainer.className = "hb-fellow-state";
  body.appendChild(stateContainer);

  const rerender = () => renderFellowshipState(stateContainer, fetchFellowshipSnapshot());
  rerender();
  // Stash the unsubscribe handle on the overlay so close/teardown can
  // detach without leaving a dangling listener on the plugin bus.
  overlay.__hbFellowUnsub = subscribeFellowship(rerender);

  overlay.appendChild(body);

  // Esc dismisses the panel when it's open.
  overlay.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeStandalone();
  });

  document.body.appendChild(overlay);
  return overlay;
}

function openStandalone() {
  if (!standaloneOverlay) standaloneOverlay = buildStandaloneOverlay();
  standaloneOverlay.classList.add("open");
  standaloneOverlay.tabIndex = -1;
  try { standaloneOverlay.focus({ preventScroll: true }); } catch (_) {}
}

function closeStandalone() {
  if (!standaloneOverlay) return;
  standaloneOverlay.classList.remove("open");
}

// Esc anywhere closes the standalone panel (mirrors vendor-ui's Esc
// handling). Re-installs the listener idempotently so module reloads
// in the same page don't pile up duplicates.
if (typeof window !== "undefined") {
  if (!window.__hbFellowshipPanelEscBound) {
    window.__hbFellowshipPanelEscBound = true;
    window.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (standaloneOverlay?.classList.contains("open")) closeStandalone();
    });
  }
  window.__openFellowshipPanel = openStandalone;
  window.__closeFellowshipPanel = closeStandalone;
}
