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
    // Compressed via scaleY — y=298 (Create button) lands at ~167 in
    // our 337-tall body.
    if (refs.aloneRefs) {
      const alonePairs = [
        [FE_ALONE_EMPTY,     refs.aloneRefs.emptyEl],
        [FE_ALONE_DIVIDER,   refs.aloneRefs.dividerEl],
        [FE_ALONE_NAME_LBL,  refs.aloneRefs.nameLblEl],
        [FE_ALONE_NAME_INP,  refs.aloneRefs.inputEl],
        [FE_ALONE_OPT_ROW_1, refs.aloneRefs.optEls?.[0]],
        [FE_ALONE_OPT_ROW_2, refs.aloneRefs.optEls?.[1]],
        [FE_ALONE_OPT_ROW_3, refs.aloneRefs.optEls?.[2]],
        [FE_ALONE_OPT_ROW_4, refs.aloneRefs.optEls?.[3]],
        [FE_ALONE_CREATE,    refs.aloneRefs.createBtnEl],
      ];
      for (const [id, el] of alonePairs) {
        if (!el) continue;
        const desc = findElementById(layout, id);
        if (!desc) continue;
        if (applyBox(el, desc, true)) applied += 1;
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
  // 3 at the bottom. Labels mirror retail's typical fellowship actions
  // (Recruit/Disband/Leave + Pass-Leader/Quit/Lock — these come from
  // StateDesc text in v2 fetch_layout, hand-tuned for now).
  const ACTION_LABELS = [
    "Recruit", "Disband", "Leave",
    "Pass Leader", "Quit", "Lock",
  ];
  // Each action button gets a per-instance fallback x/y; the layout
  // applier overrides with retail (18/108/198, 534/567) coords.
  const FALLBACK_BTN_POS = [
    { left: 18,  top: 534 }, { left: 108, top: 534 }, { left: 198, top: 534 },
    { left: 18,  top: 567 }, { left: 108, top: 567 }, { left: 198, top: 567 },
  ];
  const btnEls = [];
  for (let i = 0; i < ACTION_LABELS.length; i++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hb-fellow-in-btn";
    btn.dataset.action = ACTION_LABELS[i].toLowerCase().replace(/\s+/g, "-");
    btn.style.left = `${FALLBACK_BTN_POS[i].left}px`;
    btn.style.top  = `${FALLBACK_BTN_POS[i].top}px`;
    setAcText(btn, ACTION_LABELS[i]);
    btn.addEventListener("click", () => {
      emit(`[fellowship] ${ACTION_LABELS[i]} (game-action not wired yet)`);
    });
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

    // Fellowship state — alone vs in. Player API doesn't expose this
    // yet, default to alone. Debug toggle via window for testing.
    const debug = window.__hbFellowshipDebug;
    let opts = { ignore: false, autoAccept: false, shareXp: true, shareLoot: true };
    let fellowshipName = "";
    const aloneRefs = {};
    const inRefs = {};
    if (debug && Array.isArray(debug.members) && debug.members.length > 0) {
      buildInState(root, debug.members, inRefs);
    } else {
      buildAloneState(root, fellowshipName, opts, (name) => {
        if (!name) {
          emit("[fellowship] Cannot create — name required.");
          return;
        }
        // GameAction Fellowship_Create isn't exposed yet — log + simulate.
        emit(`[fellowship] Created "${name}" (game-action not wired yet)`);
      }, aloneRefs);
    }

    parentEl.appendChild(root);

    // Apply retail layout positions. The view mounts via main-panel's
    // showView() which only fires after wasm-ready, so the layout
    // resolves on the first call and no retry loop is needed. The
    // applier reads root.getBoundingClientRect() for scaleY, so the
    // call must happen AFTER parentEl.appendChild(root).
    applyFellowshipLayout({
      root,
      tabsEl: tabs,
      tabHeaderEl: tabHeader,
      tabBtns,
      aloneRefs,
      inRefs,
    });

    return () => { root.remove(); };
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
