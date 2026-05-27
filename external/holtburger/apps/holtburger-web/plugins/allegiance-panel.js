// Allegiance panel — view of plugins/main-panel.js. Port of retail
// gmAllegianceUI (layout 0x2100002F, 34 elements, 5 image DIDs).
// Bound to the A key.
//
// Real DAT sprites:
//   0x06001420 — thin gold horizontal divider strip
//   0x06001451 — wider amber/gold separator
//   0x06001AAF — dark mottled background panel
//   0x06004D0B — small black corner accent
//
// Layout structure (300×600 native, from gmAllegianceUI 0x2100002F).
// Element-id map confirmed by allegiance_panel_layout_dump 2026-05-24:
//
//   Root 0x1000024F — 300×600 outer panel (11 children + 1 sibling).
//     Patron section 0x10000250 type=3 (0,0) 300×45 — "Followers/Rank" header
//       0x10000251 type=0 (0,0)   300×18 — header strip / icon row
//       0x10000252 type=0 (0,18)  120×18 — "Followers:" label column
//       0x10000253 type=0 (120,18)280×18 — Rank value column (1 state)
//       0x10000254 type=3 (0,36)  300×9  — divider
//     Monarch section 0x10000255 type=3 (0,45) 300×63 (2 states)
//       0x10000256 type=0 (0,0)   210×18 — Patron row
//       0x10000257 type=0 (0,18)  210×18 — Monarch row
//       0x10000490 type=3 (210,0) 90×36  — selector box (Patron/Monarch picker)
//         0x10000491 type=0 (0,0) 90×18  — selector top
//         0x10000492 type=0 (0,18)90×18  — selector bottom
//       0x10000258 type=0 (0,36)  280×18 — Allegiance-name row
//       0x10000259 type=3 (0,54)  300×9  — divider
//     XP section 0x1000025A type=3 (0,108) 300×45 (2 states)
//       0x1000025B type=0 (0,0)   100×18 — XP Generated label
//       0x1000025C type=0 (0,18)  280×18 — XP Available row
//       0x10000490 type=3 (220,0) 80×36  — selector box (reuses elem id)
//         0x10000491 (0,0) 80×18 — selector top
//         0x10000492 (0,18)80×18 — selector bottom
//       0x1000025D type=3 (0,36)  300×9  — divider
//     Status row 0x1000025E (0,153) 100×18 — small status left
//     Status row 0x1000025F (179,153)100×18 — small status right
//     Vassal list 0x10000260 type=5 (0,171) 279×350 (R2 B1 edges)
//     Vassal scrollbar 0x10000261 (280,171) 16×350
//     Ignore-toggle row 0x10000262 (9,535) 275×14
//     Swear button 0x10000263 (9,562)   88×33 default_state=13
//     Break button 0x10000264 (106,562) 88×33 default_state=13
//     Kick  button 0x10000265 (203,562) 88×32 default_state=13
//
//   Vassal-row template 0x10000266 — 279×32 sibling at (0,0) (2 states).
//     0x10000267 type=3 (0,0)   279×16 — row body (1 state)
//       0x10000268 type=0 (0,0) 279×16 — name cell template
//     0x100004AA type=0 (0,16)  100×16 — vassal-XP left column
//     0x10000269 type=0 (100,16)179×16 — vassal-XP right column
//
// Companion tabs Friends/Squelch share the panel via gmFloatyPanelUI —
// those still swap views via window.__mainPanel.showView.
//
// SCALE: native layout is 300×600; our main-panel body is 300×337.
// We use scaleY = 337 / 600 ≈ 0.562 compression on every Y/height
// value applied from the layout (preserving retail-Y fidelity). X is
// applied unchanged. The Y compression squeezes the 9-px dividers and
// 18-px header rows but the proportions stay retail-correct. Picked
// option (a) per layout-port-plan-2026-05-24.md instead of option (b)
// (which would force the user to scroll the whole panel).

import { setAcText } from "../ui/ac_font.js";
import { loadLayout, findElementById, getCachedLayout } from "../ui/ac_layout.js";

// gmAllegianceUI 0x2100002F — element_id constants from
// allegiance_panel_layout_dump 2026-05-24. See head-comment block for
// the full element-purpose mapping.
const ALLEGIANCE_LAYOUT_ID = 0x2100002F;
const ALLEGIANCE_NATIVE_H = 600;
const ALLEGIANCE_ELEMS = {
  // Top patron section (Followers / Rank).
  patronSection:    0x10000250,
  patronHeaderRow:  0x10000251,  // (0,0) 300×18
  patronLabelCol:   0x10000252,  // (0,18) 120×18 — Followers: label
  patronValueCol:   0x10000253,  // (120,18) 280×18 — rank value
  patronDivider:    0x10000254,  // (0,36) 300×9
  // Monarch section (Patron / Monarch / Allegiance).
  monarchSection:   0x10000255,  // (0,45) 300×63
  monarchPatronRow: 0x10000256,  // (0,0) 210×18
  monarchMonarchRow:0x10000257,  // (0,18) 210×18
  monarchAllegRow:  0x10000258,  // (0,36) 280×18
  monarchDivider:   0x10000259,  // (0,54) 300×9
  // XP section (XP Generated / XP Available).
  xpSection:        0x1000025A,  // (0,108) 300×45
  xpGenLabel:       0x1000025B,  // (0,0) 100×18
  xpAvailRow:       0x1000025C,  // (0,18) 280×18
  xpDivider:        0x1000025D,  // (0,36) 300×9
  // Mid-status row.
  statusLeft:       0x1000025E,  // (0,153) 100×18
  statusRight:      0x1000025F,  // (179,153) 100×18
  // Vassals scroll list + scrollbar.
  vassalList:       0x10000260,  // (0,171) 279×350
  vassalScrollbar:  0x10000261,  // (280,171) 16×350
  // Ignore-allegiance-requests toggle row.
  ignoreToggleRow:  0x10000262,  // (9,535) 275×14
  // Swear / Break / Kick action buttons.
  swearBtn:         0x10000263,  // (9,562) 88×33
  breakBtn:         0x10000264,  // (106,562) 88×33
  kickBtn:          0x10000265,  // (203,562) 88×32
};

const STYLE_ID = "hb-alleg-view-style";

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .hb-alleg-root {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      box-sizing: border-box;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      overflow: hidden;
      background: url("./data/ui-sprites/0x06001AAF.png") repeat-x;
    }
    /* Tab strip — Holtburger UX addition (retail packs Allegiance +
       Fellowship + Friends + Squelch into separate panels referenced
       via gmFloatyPanelUI). Kept on top so user can swap views; not
       in the retail layout's element tree. */
    .hb-alleg-tabs {
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 20px;
      box-sizing: border-box;
      display: flex;
      gap: 1px;
      padding: 2px 4px 0;
      border-bottom: 1px solid var(--hb-border-brass-dim);
      background: rgba(0, 0, 0, 0.35);
      z-index: 5;
    }
    .hb-alleg-tab {
      padding: 2px 8px;
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
    .hb-alleg-tab:hover { background: var(--hb-overlay-hover); }
    .hb-alleg-tab.active {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
      border-color: var(--hb-border-brass);
    }
    /* Layout-anchored region — applyAllegianceLayout populates explicit
       left/top/width/height for every retail element. We mark each
       region with a dedicated class so the e2e verifier can read the
       bounding box for parity confirmation. All regions live below the
       20px Holtburger tab strip — body region starts at y=20. */
    .hb-alleg-section {
      position: absolute;
      box-sizing: border-box;
      padding: 4px 8px;
      background: rgba(0, 0, 0, 0.25);
      border-bottom: 1px solid var(--hb-border-brass-dim);
      overflow: hidden;
    }
    .hb-alleg-row {
      position: absolute;
      box-sizing: border-box;
      display: flex;
      justify-content: space-between;
      gap: 6px;
      padding: 0 6px;
      font-size: 10px;
      align-items: center;
      overflow: hidden;
    }
    .hb-alleg-row .label { color: var(--hb-text-cream); }
    .hb-alleg-row .value { color: var(--hb-text-gold); font-variant-numeric: tabular-nums; }
    .hb-alleg-divider {
      position: absolute;
      box-sizing: border-box;
      background: url("./data/ui-sprites/0x06001420.png") center/auto 100% no-repeat;
    }
    .hb-alleg-selector {
      position: absolute;
      box-sizing: border-box;
      border: 1px solid var(--hb-border-brass-dim);
      background: rgba(0, 0, 0, 0.45);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      color: var(--hb-text-cream-bright);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .hb-alleg-selector:hover {
      background: var(--hb-overlay-hover);
      border-color: var(--hb-border-brass);
    }
    .hb-alleg-vassals {
      position: absolute;
      box-sizing: border-box;
      overflow-y: auto;
      padding: 4px;
      background: rgba(0, 0, 0, 0.6);
      border: 1px solid var(--hb-border-brass-dim);
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.5);
    }
    .hb-alleg-vassal-scrollbar {
      position: absolute;
      box-sizing: border-box;
      pointer-events: none;
      background: rgba(0, 0, 0, 0.5);
      border-left: 1px solid var(--hb-border-brass-dim);
    }
    .hb-alleg-vassal-row {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      padding: 1px 4px;
      line-height: 14px;
      border-bottom: 1px solid rgba(138, 117, 68, 0.18);
    }
    .hb-alleg-vassal-row:last-child { border-bottom: none; }
    .hb-alleg-vassal-row .name { color: var(--hb-text-cream); }
    .hb-alleg-vassal-row .xp { color: var(--hb-text-numeric-green); }
    .hb-alleg-empty {
      padding: 14px 12px;
      color: var(--hb-text-muted);
      font-style: italic;
      text-align: center;
      font-size: 10px;
    }
    .hb-alleg-toggle-row {
      position: absolute;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 9px;
      color: var(--hb-text-cream);
      overflow: hidden;
    }
    .hb-alleg-toggle {
      width: 10px; height: 10px;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.65);
      border: 1px solid var(--hb-border-brass-dim);
      cursor: pointer;
      flex: 0 0 10px;
    }
    .hb-alleg-toggle.on {
      background: var(--hb-text-numeric-green);
      border-color: var(--hb-border-brass);
      box-shadow: 0 0 4px rgba(120, 220, 120, 0.6);
    }
    .hb-alleg-btn {
      position: absolute;
      box-sizing: border-box;
      padding: 4px 8px;
      font-family: var(--hb-font-serif);
      font-size: 10px;
      color: var(--hb-text-cream);
      background: linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      border: 1px solid var(--hb-border-brass);
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      user-select: none;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .hb-alleg-btn:hover {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
    .hb-alleg-btn:disabled,
    .hb-alleg-btn[aria-disabled="true"] {
      opacity: 0.5;
      cursor: not-allowed;
      color: var(--hb-text-muted);
    }
  `;
  document.head.appendChild(style);
}

function emit(msgText, cat = 0) {
  // Append a line to the chat log so the user sees feedback. Mirrors
  // index.html's appendChatLine pattern (category 0 = system / green).
  const log = document.getElementById("chat-log");
  if (!log) return;
  const li = document.createElement("li");
  li.className = `cat-${cat}`;
  li.dataset.cat = String(cat);
  li.textContent = msgText;
  log.appendChild(li);
}

// Wave-F2 (2026-05-26): pull the live allegiance snapshot off the wasm
// handle. Returns the wasm wrapper (or null pre-join / post-break).
function fetchAllegianceSnapshot() {
  const handle = window.__sessionHandle;
  if (typeof handle?.playerAllegiance !== "function") return null;
  try {
    return handle.playerAllegiance() ?? null;
  } catch (_) {
    return null;
  }
}

function memberDisplay(m) {
  if (!m) return null;
  return {
    guid: m.guid >>> 0,
    name: m.name || `0x${(m.guid >>> 0).toString(16).padStart(8, "0").toUpperCase()}`,
    rank: m.rank >>> 0,
    level: m.level >>> 0,
    loggedIn: !!m.loggedIn,
  };
}

// Apply gmAllegianceUI 0x2100002F layout to the allegiance plugin's
// sub-regions. Native layout is 300×600; we squeeze into the main-
// panel body's 300×337 by SCALING vertical offsets/heights by
// `scaleY = bodyH / 600`. Horizontal positions and widths are passed
// through unchanged.
//
// View mounts via main-panel.showView which only fires AFTER wasm is
// ready (user-initiated panel open), so no retry loop is required.
function applyAllegianceLayout(refs) {
  const apply = (layout) => {
    if (!layout) return;
    let applied = 0;
    const bodyH = refs.rootEl?.getBoundingClientRect().height || 337;
    // Holtburger tab strip lives at y=0..20 OUTSIDE the retail layout.
    // The retail anchor space starts AT the tabs' bottom edge, so we
    // shift retail Y by +TAB_OFFSET after compression.
    const TAB_OFFSET = 20;
    const scaleY = (bodyH - TAB_OFFSET) / ALLEGIANCE_NATIVE_H;

    const applyBox = (el, desc) => {
      if (!el || !desc) return false;
      el.style.right = "";
      el.style.bottom = "";
      el.style.transform = "none";
      if (typeof desc.x === "number") el.style.left = `${desc.x}px`;
      if (typeof desc.y === "number") el.style.top = `${Math.round(desc.y * scaleY) + TAB_OFFSET}px`;
      if (typeof desc.width === "number") el.style.width = `${desc.width}px`;
      if (typeof desc.height === "number") {
        el.style.height = `${Math.max(1, Math.round(desc.height * scaleY))}px`;
      }
      return true;
    };

    // ── Top patron section + child rows + divider ──────────────────
    if (refs.patronSectionEl) {
      const desc = findElementById(layout, ALLEGIANCE_ELEMS.patronSection);
      if (applyBox(refs.patronSectionEl, desc)) applied += 1;
    }
    // patron-section's inner rows have x/y RELATIVE to the section
    // (parent (0,0)+section.y), so we re-anchor inside the section
    // using `position:absolute` against the section container. The
    // retail tree places them at section-local (0,0) (0,18) (120,18)
    // (0,36); we just feed those offsets to applyBox _without_
    // applying the parent y-shift again. The simplest approach is
    // to set the row's position relative to .hb-alleg-root and let
    // the section function purely as a visual band. That matches
    // how `applyBox` writes ROOT-relative coords; the rows below get
    // their absolute layout coords (section.y + row.y) computed via
    // the retail tree-walk + manual offset.
    //
    // ApplyBox writes ROOT-relative coords; row.desc.y is RELATIVE
    // TO PARENT. We add the parent's y. The plugin builds its rows
    // as siblings of the section (not children) for simpler
    // absolute-anchoring.
    const applyChildOf = (parentId, childId, el) => {
      const parent = findElementById(layout, parentId);
      const child = findElementById(layout, childId);
      if (!parent || !child || !el) return false;
      const px = typeof parent.x === "number" ? parent.x : 0;
      const py = typeof parent.y === "number" ? parent.y : 0;
      const cx = typeof child.x === "number" ? child.x : 0;
      const cy = typeof child.y === "number" ? child.y : 0;
      el.style.right = "";
      el.style.bottom = "";
      el.style.transform = "none";
      el.style.left = `${px + cx}px`;
      el.style.top = `${Math.round((py + cy) * scaleY) + TAB_OFFSET}px`;
      if (typeof child.width === "number") el.style.width = `${child.width}px`;
      if (typeof child.height === "number") {
        el.style.height = `${Math.max(1, Math.round(child.height * scaleY))}px`;
      }
      return true;
    };

    // Patron section children.
    if (applyChildOf(ALLEGIANCE_ELEMS.patronSection, ALLEGIANCE_ELEMS.patronHeaderRow, refs.patronHeaderRowEl)) applied += 1;
    if (applyChildOf(ALLEGIANCE_ELEMS.patronSection, ALLEGIANCE_ELEMS.patronLabelCol,  refs.patronLabelEl))     applied += 1;
    if (applyChildOf(ALLEGIANCE_ELEMS.patronSection, ALLEGIANCE_ELEMS.patronValueCol,  refs.patronValueEl))     applied += 1;
    if (applyChildOf(ALLEGIANCE_ELEMS.patronSection, ALLEGIANCE_ELEMS.patronDivider,   refs.patronDividerEl))   applied += 1;

    // Monarch section + rows + divider.
    if (refs.monarchSectionEl) {
      const desc = findElementById(layout, ALLEGIANCE_ELEMS.monarchSection);
      if (applyBox(refs.monarchSectionEl, desc)) applied += 1;
    }
    if (applyChildOf(ALLEGIANCE_ELEMS.monarchSection, ALLEGIANCE_ELEMS.monarchPatronRow, refs.monarchPatronRowEl)) applied += 1;
    if (applyChildOf(ALLEGIANCE_ELEMS.monarchSection, ALLEGIANCE_ELEMS.monarchMonarchRow,refs.monarchMonarchRowEl)) applied += 1;
    if (applyChildOf(ALLEGIANCE_ELEMS.monarchSection, ALLEGIANCE_ELEMS.monarchAllegRow, refs.monarchAllegRowEl)) applied += 1;
    if (applyChildOf(ALLEGIANCE_ELEMS.monarchSection, ALLEGIANCE_ELEMS.monarchDivider, refs.monarchDividerEl)) applied += 1;

    // XP section + rows + divider.
    if (refs.xpSectionEl) {
      const desc = findElementById(layout, ALLEGIANCE_ELEMS.xpSection);
      if (applyBox(refs.xpSectionEl, desc)) applied += 1;
    }
    if (applyChildOf(ALLEGIANCE_ELEMS.xpSection, ALLEGIANCE_ELEMS.xpGenLabel, refs.xpGenLabelEl)) applied += 1;
    if (applyChildOf(ALLEGIANCE_ELEMS.xpSection, ALLEGIANCE_ELEMS.xpAvailRow, refs.xpAvailRowEl)) applied += 1;
    if (applyChildOf(ALLEGIANCE_ELEMS.xpSection, ALLEGIANCE_ELEMS.xpDivider, refs.xpDividerEl)) applied += 1;

    // Status rows (top-level direct children of root, not inside any section).
    if (refs.statusLeftEl) {
      const desc = findElementById(layout, ALLEGIANCE_ELEMS.statusLeft);
      if (applyBox(refs.statusLeftEl, desc)) applied += 1;
    }
    if (refs.statusRightEl) {
      const desc = findElementById(layout, ALLEGIANCE_ELEMS.statusRight);
      if (applyBox(refs.statusRightEl, desc)) applied += 1;
    }

    // Vassals scrollable list + scrollbar.
    if (refs.vassalListEl) {
      const desc = findElementById(layout, ALLEGIANCE_ELEMS.vassalList);
      if (applyBox(refs.vassalListEl, desc)) applied += 1;
    }
    if (refs.vassalScrollbarEl) {
      const desc = findElementById(layout, ALLEGIANCE_ELEMS.vassalScrollbar);
      if (applyBox(refs.vassalScrollbarEl, desc)) applied += 1;
    }

    // Ignore-toggle row.
    if (refs.toggleRowEl) {
      const desc = findElementById(layout, ALLEGIANCE_ELEMS.ignoreToggleRow);
      if (applyBox(refs.toggleRowEl, desc)) applied += 1;
    }

    // Action buttons (Swear / Break / Kick).
    if (refs.swearBtnEl) {
      const desc = findElementById(layout, ALLEGIANCE_ELEMS.swearBtn);
      if (applyBox(refs.swearBtnEl, desc)) applied += 1;
    }
    if (refs.breakBtnEl) {
      const desc = findElementById(layout, ALLEGIANCE_ELEMS.breakBtn);
      if (applyBox(refs.breakBtnEl, desc)) applied += 1;
    }
    if (refs.kickBtnEl) {
      const desc = findElementById(layout, ALLEGIANCE_ELEMS.kickBtn);
      if (applyBox(refs.kickBtnEl, desc)) applied += 1;
    }

    try {
      window.__diag?.layout?.onAllegianceApplied?.({ applied });
    } catch (_) {}
  };

  const cached = getCachedLayout(ALLEGIANCE_LAYOUT_ID);
  if (cached) { apply(cached); return; }
  loadLayout(ALLEGIANCE_LAYOUT_ID).then(apply).catch(() => {});
}

// Wave-F2 (2026-05-26): render the live monarch/patron/vassal state
// into the layout-anchored regions built by `view.mount`. Idempotent —
// clears each region before re-populating. `refs` carries the same DOM
// handles `applyAllegianceLayout` was given. `snapshot` is the
// wasm-bindgen `AllegianceSnapshotJs` from `handle.playerAllegiance()`
// (or null pre-join).
function renderAllegianceState(refs, snapshot) {
  if (!refs) return;

  if (!snapshot) {
    if (refs.patronLabelEl)
      refs.patronLabelEl.innerHTML =
        `<span class="label">Followers:</span><span class="value">0</span>`;
    if (refs.patronValueEl)
      refs.patronValueEl.innerHTML =
        `<span class="label">Rank:</span><span class="value">[0]</span>`;
    if (refs.patronHeaderRowEl)
      refs.patronHeaderRowEl.innerHTML =
        `<span class="label">Allegiance Information</span>`;
    if (refs.monarchPatronRowEl)
      refs.monarchPatronRowEl.innerHTML =
        `<span class="label">Patron:</span><span class="value">—</span>`;
    if (refs.monarchMonarchRowEl)
      refs.monarchMonarchRowEl.innerHTML =
        `<span class="label">Monarch:</span><span class="value">—</span>`;
    if (refs.monarchAllegRowEl)
      refs.monarchAllegRowEl.innerHTML =
        `<span class="label">Allegiance:</span><span class="value">—</span>`;
    if (refs.statusLeftEl)
      refs.statusLeftEl.innerHTML =
        `<span class="label">Status:</span><span class="value">—</span>`;
    if (refs.statusRightEl)
      refs.statusRightEl.innerHTML =
        `<span class="label">Title:</span><span class="value">—</span>`;
    if (refs.vassalListEl) {
      while (refs.vassalListEl.firstChild)
        refs.vassalListEl.removeChild(refs.vassalListEl.firstChild);
      const empty = document.createElement("div");
      empty.className = "hb-alleg-empty";
      setAcText(empty, "Not in an allegiance. Use Swear above to join one.");
      refs.vassalListEl.appendChild(empty);
    }
    return;
  }

  const name = snapshot.name || "(unnamed)";
  const locked = !!snapshot.isLocked;
  const rank = (snapshot.rank >>> 0);
  const monarch = memberDisplay(snapshot.monarch);
  const patron = memberDisplay(snapshot.patron);
  const myself = memberDisplay(snapshot.myself);
  const vassals = Array.isArray(snapshot.vassals) ? snapshot.vassals : [];
  const totalMembers = (snapshot.totalMembers >>> 0);
  const totalVassals = (snapshot.totalVassals >>> 0);
  const motd = snapshot.motd || "";

  // `myself` is None when the local player IS the monarch — derive
  // player-is-monarch from that shape, mirroring publish_player_allegiance_snapshot.
  const playerIsMonarch = monarch && !myself;

  if (refs.patronHeaderRowEl) {
    const lockBadge = locked
      ? ` <span class="value" style="color: var(--hb-text-gold)">[LOCKED]</span>`
      : "";
    refs.patronHeaderRowEl.innerHTML =
      `<span class="label">${name}</span>${lockBadge}`;
  }
  if (refs.patronLabelEl) {
    refs.patronLabelEl.innerHTML =
      `<span class="label">Followers:</span><span class="value">${totalVassals}</span>`;
  }
  if (refs.patronValueEl) {
    refs.patronValueEl.innerHTML =
      `<span class="label">Rank:</span><span class="value">[${rank}]</span>`;
  }
  if (refs.monarchPatronRowEl) {
    const text = playerIsMonarch
      ? "You are Monarch"
      : patron
        ? `Patron: ${patron.name}`
        : "No patron";
    refs.monarchPatronRowEl.innerHTML =
      `<span class="label">${text}</span>`;
  }
  if (refs.monarchMonarchRowEl) {
    const text = monarch
      ? (playerIsMonarch ? `Monarch: ${monarch.name} (you)` : `Monarch: ${monarch.name}`)
      : "Monarch: —";
    refs.monarchMonarchRowEl.innerHTML =
      `<span class="label">${text}</span>`;
  }
  if (refs.monarchAllegRowEl) {
    refs.monarchAllegRowEl.innerHTML =
      `<span class="label">Allegiance:</span><span class="value">${name}</span>`;
  }
  if (refs.statusLeftEl) {
    refs.statusLeftEl.innerHTML =
      `<span class="label">Members:</span><span class="value">${totalMembers}</span>`;
  }
  if (refs.statusRightEl) {
    const motdShort = motd
      ? (motd.length > 22 ? motd.slice(0, 21) + "…" : motd)
      : "—";
    refs.statusRightEl.title = motd || "";
    refs.statusRightEl.innerHTML =
      `<span class="label">MOTD:</span><span class="value">${motdShort.replace(/[<>&]/g, "")}</span>`;
  }
  if (refs.vassalListEl) {
    while (refs.vassalListEl.firstChild)
      refs.vassalListEl.removeChild(refs.vassalListEl.firstChild);
    if (vassals.length === 0) {
      const empty = document.createElement("div");
      empty.className = "hb-alleg-empty";
      setAcText(empty, "No vassals.");
      refs.vassalListEl.appendChild(empty);
    } else {
      for (const v of vassals) {
        const display = memberDisplay(v);
        const row = document.createElement("div");
        row.className = "hb-alleg-vassal-row";
        row.dataset.guid = String(display.guid);
        const nameEl = document.createElement("span");
        nameEl.className = "name";
        setAcText(nameEl, display.name + (display.loggedIn ? "" : " (offline)"));
        row.appendChild(nameEl);
        const meta = document.createElement("span");
        meta.className = "xp";
        setAcText(meta, `L${display.level || "?"} R${display.rank || 1}`);
        row.appendChild(meta);
        refs.vassalListEl.appendChild(row);
      }
    }
  }
}

// Subscribe `rerender` to allegianceUpdated events on the plugin bus.
function subscribeAllegiance(rerender) {
  const bus = window.__pluginClient?.events;
  if (!bus || typeof bus.on !== "function") return () => {};
  const listener = () => { try { rerender(); } catch (_) {} };
  bus.on("allegianceUpdated", listener);
  return () => {
    if (typeof bus.off === "function") bus.off("allegianceUpdated", listener);
  };
}

// Wave F.3 (2026-05-27): subscribe to per-member login/logout events
// (`Allegiance_AllegianceLoginNotification`, opcode 0x027A). The wasm
// side ALSO re-emits `allegianceUpdated` after flipping the cached
// `logged_in` flag, so the snapshot-driven panel will refresh through
// the existing path. This handler adds the chat-style "X has logged in"
// notification line that retail surfaces in the system chat tab — the
// allegiance panel itself stays driven by the snapshot subscription.
function subscribeAllegiancePresence() {
  const bus = window.__pluginClient?.events;
  if (!bus || typeof bus.on !== "function") return () => {};
  const listener = (payload) => {
    try {
      const guid = (payload?.characterGuid >>> 0) || 0;
      const isLoggedIn = !!payload?.isLoggedIn;
      if (!guid) return;
      const snap = fetchAllegianceSnapshot();
      if (!snap) return;
      // Resolve the member's display name out of the cached hierarchy.
      // Look in monarch/patron/myself/vassals in that order.
      const candidates = [snap.monarch, snap.patron, snap.myself, ...(snap.vassals || [])];
      let name = "";
      for (const m of candidates) {
        if (m && (m.guid >>> 0) === guid) { name = m.name || ""; break; }
      }
      if (!name) name = `0x${guid.toString(16).padStart(8, "0").toUpperCase()}`;
      const verb = isLoggedIn ? "has logged in" : "has logged out";
      emit(`${name} ${verb}.`, 6 /* allegiance chat category */);
    } catch (_) {}
  };
  bus.on("allegiancePresence", listener);
  return () => {
    if (typeof bus.off === "function") bus.off("allegiancePresence", listener);
  };
}

export const view = {
  name: "Allegiance",
  nameFor: () => "Allegiance",
  mount: (parentEl, _ctx) => {
    ensureStyles();
    const root = document.createElement("div");
    root.className = "hb-alleg-root";

    // Companion-tab strip — retail puts Allegiance/Fellowship/Friends/
    // Squelch in one panel. Friends + Squelch are not wired yet;
    // clicking them swaps the main-panel view (or stays stub). This is
    // Holtburger chrome — no retail element-id maps here.
    const tabs = document.createElement("div");
    tabs.className = "hb-alleg-tabs";
    for (const t of [
      { id: "allegiance", label: "Allegiance", current: true },
      { id: "fellowship", label: "Fellowship", swap: "fellowship" },
      { id: "friends",    label: "Friends",    swap: null },
      { id: "squelch",    label: "Squelch",    swap: null },
    ]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hb-alleg-tab" + (t.current ? " active" : "");
      setAcText(btn, t.label);
      if (t.swap) {
        btn.addEventListener("click", () => {
          window.__mainPanel?.showView?.(t.swap);
        });
      } else if (!t.current) {
        btn.addEventListener("click", () => emit(`[allegiance] ${t.label} tab not wired yet`));
      }
      tabs.appendChild(btn);
    }
    root.appendChild(tabs);

    // ── Patron section + 4 children ────────────────────────────────
    // Section is a sized band; child rows are absolute-positioned
    // siblings of the section (so applyChildOf can write ROOT-
    // relative coords from layout.parent.y + layout.child.y).
    const patronSectionEl = document.createElement("div");
    patronSectionEl.className = "hb-alleg-section";
    patronSectionEl.dataset.elId = "0x10000250";
    root.appendChild(patronSectionEl);

    const patronHeaderRowEl = document.createElement("div");
    patronHeaderRowEl.className = "hb-alleg-row";
    patronHeaderRowEl.dataset.elId = "0x10000251";
    patronHeaderRowEl.innerHTML = `<span class="label">Allegiance Information</span>`;
    root.appendChild(patronHeaderRowEl);

    const patronLabelEl = document.createElement("div");
    patronLabelEl.className = "hb-alleg-row";
    patronLabelEl.dataset.elId = "0x10000252";
    patronLabelEl.innerHTML = `<span class="label">Followers:</span><span class="value">0</span>`;
    root.appendChild(patronLabelEl);

    const patronValueEl = document.createElement("div");
    patronValueEl.className = "hb-alleg-row";
    patronValueEl.dataset.elId = "0x10000253";
    patronValueEl.innerHTML = `<span class="label">Rank:</span><span class="value">[0]</span>`;
    root.appendChild(patronValueEl);

    const patronDividerEl = document.createElement("div");
    patronDividerEl.className = "hb-alleg-divider";
    patronDividerEl.dataset.elId = "0x10000254";
    root.appendChild(patronDividerEl);

    // ── Monarch section + 4 children + 1 divider ───────────────────
    const monarchSectionEl = document.createElement("div");
    monarchSectionEl.className = "hb-alleg-section";
    monarchSectionEl.dataset.elId = "0x10000255";
    root.appendChild(monarchSectionEl);

    const monarchPatronRowEl = document.createElement("div");
    monarchPatronRowEl.className = "hb-alleg-row";
    monarchPatronRowEl.dataset.elId = "0x10000256";
    monarchPatronRowEl.innerHTML = `<span class="label">Patron:</span><span class="value">—</span>`;
    root.appendChild(monarchPatronRowEl);

    const monarchMonarchRowEl = document.createElement("div");
    monarchMonarchRowEl.className = "hb-alleg-row";
    monarchMonarchRowEl.dataset.elId = "0x10000257";
    monarchMonarchRowEl.innerHTML = `<span class="label">Monarch:</span><span class="value">—</span>`;
    root.appendChild(monarchMonarchRowEl);

    const monarchAllegRowEl = document.createElement("div");
    monarchAllegRowEl.className = "hb-alleg-row";
    monarchAllegRowEl.dataset.elId = "0x10000258";
    monarchAllegRowEl.innerHTML = `<span class="label">Allegiance:</span><span class="value">—</span>`;
    root.appendChild(monarchAllegRowEl);

    const monarchDividerEl = document.createElement("div");
    monarchDividerEl.className = "hb-alleg-divider";
    monarchDividerEl.dataset.elId = "0x10000259";
    root.appendChild(monarchDividerEl);

    // ── XP section + 2 children + 1 divider ────────────────────────
    const xpSectionEl = document.createElement("div");
    xpSectionEl.className = "hb-alleg-section";
    xpSectionEl.dataset.elId = "0x1000025A";
    root.appendChild(xpSectionEl);

    const xpGenLabelEl = document.createElement("div");
    xpGenLabelEl.className = "hb-alleg-row";
    xpGenLabelEl.dataset.elId = "0x1000025B";
    xpGenLabelEl.innerHTML = `<span class="label">XP Generated:</span><span class="value">0</span>`;
    root.appendChild(xpGenLabelEl);

    const xpAvailRowEl = document.createElement("div");
    xpAvailRowEl.className = "hb-alleg-row";
    xpAvailRowEl.dataset.elId = "0x1000025C";
    xpAvailRowEl.innerHTML = `<span class="label">XP Available:</span><span class="value">0</span>`;
    root.appendChild(xpAvailRowEl);

    const xpDividerEl = document.createElement("div");
    xpDividerEl.className = "hb-alleg-divider";
    xpDividerEl.dataset.elId = "0x1000025D";
    root.appendChild(xpDividerEl);

    // ── Status rows (small mid-panel state strip) ──────────────────
    const statusLeftEl = document.createElement("div");
    statusLeftEl.className = "hb-alleg-row";
    statusLeftEl.dataset.elId = "0x1000025E";
    statusLeftEl.innerHTML = `<span class="label">Status:</span><span class="value">—</span>`;
    root.appendChild(statusLeftEl);

    const statusRightEl = document.createElement("div");
    statusRightEl.className = "hb-alleg-row";
    statusRightEl.dataset.elId = "0x1000025F";
    statusRightEl.innerHTML = `<span class="label">Title:</span><span class="value">—</span>`;
    root.appendChild(statusRightEl);

    // ── Vassal list + scrollbar ────────────────────────────────────
    const vassalListEl = document.createElement("div");
    vassalListEl.className = "hb-alleg-vassals";
    vassalListEl.dataset.elId = "0x10000260";
    const empty = document.createElement("div");
    empty.className = "hb-alleg-empty";
    setAcText(empty, "No vassals — you have not yet sworn fealty as a patron.");
    vassalListEl.appendChild(empty);
    root.appendChild(vassalListEl);

    const vassalScrollbarEl = document.createElement("div");
    vassalScrollbarEl.className = "hb-alleg-vassal-scrollbar";
    vassalScrollbarEl.dataset.elId = "0x10000261";
    root.appendChild(vassalScrollbarEl);

    // ── Ignore-allegiance-requests toggle row ──────────────────────
    const toggleRowEl = document.createElement("div");
    toggleRowEl.className = "hb-alleg-toggle-row";
    toggleRowEl.dataset.elId = "0x10000262";
    let ignore = false;
    const toggle = document.createElement("span");
    toggle.className = "hb-alleg-toggle";
    toggle.setAttribute("role", "button");
    toggle.title = "Toggle ignore allegiance requests";
    toggleRowEl.appendChild(toggle);
    const toggleLabel = document.createElement("span");
    setAcText(toggleLabel, "Ignore Allegiance Requests");
    toggleLabel.style.color = "var(--hb-text-cream)";
    toggleRowEl.appendChild(toggleLabel);
    toggle.addEventListener("click", () => {
      ignore = !ignore;
      toggle.classList.toggle("on", ignore);
      emit(`[allegiance] Ignore-requests ${ignore ? "enabled" : "disabled"} (client-side only)`);
    });
    root.appendChild(toggleRowEl);

    // ── Action buttons (Swear / Break / Kick) ──────────────────────
    const swearBtnEl = document.createElement("button");
    swearBtnEl.type = "button";
    swearBtnEl.className = "hb-alleg-btn";
    swearBtnEl.dataset.elId = "0x10000263";
    setAcText(swearBtnEl, "Swear");
    swearBtnEl.title = "swear fealty to selected target";
    swearBtnEl.addEventListener("click", () => {
      emit(`[allegiance] Swear: swear fealty to selected target (game-action not wired yet)`);
    });
    root.appendChild(swearBtnEl);

    const breakBtnEl = document.createElement("button");
    breakBtnEl.type = "button";
    breakBtnEl.className = "hb-alleg-btn";
    breakBtnEl.dataset.elId = "0x10000264";
    setAcText(breakBtnEl, "Break");
    breakBtnEl.title = "break fealty (leave your patron)";
    breakBtnEl.addEventListener("click", () => {
      emit(`[allegiance] Break: break fealty (leave your patron) (game-action not wired yet)`);
    });
    root.appendChild(breakBtnEl);

    const kickBtnEl = document.createElement("button");
    kickBtnEl.type = "button";
    kickBtnEl.className = "hb-alleg-btn";
    kickBtnEl.dataset.elId = "0x10000265";
    setAcText(kickBtnEl, "Kick");
    kickBtnEl.title = "kick a vassal from your allegiance";
    kickBtnEl.addEventListener("click", () => {
      emit(`[allegiance] Kick: kick a vassal from your allegiance (game-action not wired yet)`);
    });
    root.appendChild(kickBtnEl);

    parentEl.appendChild(root);

    // Apply retail gmAllegianceUI layout AFTER all elements live in
    // the DOM so getBoundingClientRect() returns the actual body height
    // for scaleY computation.
    applyAllegianceLayout({
      rootEl: root,
      patronSectionEl,
      patronHeaderRowEl,
      patronLabelEl,
      patronValueEl,
      patronDividerEl,
      monarchSectionEl,
      monarchPatronRowEl,
      monarchMonarchRowEl,
      monarchAllegRowEl,
      monarchDividerEl,
      xpSectionEl,
      xpGenLabelEl,
      xpAvailRowEl,
      xpDividerEl,
      statusLeftEl,
      statusRightEl,
      vassalListEl,
      vassalScrollbarEl,
      toggleRowEl,
      swearBtnEl,
      breakBtnEl,
      kickBtnEl,
    });

    // Wave-F2 (2026-05-26): subscribe to allegianceUpdated + render the
    // initial snapshot (covers re-mount when state already exists).
    const renderRefs = {
      patronHeaderRowEl, patronLabelEl, patronValueEl,
      monarchPatronRowEl, monarchMonarchRowEl, monarchAllegRowEl,
      statusLeftEl, statusRightEl, vassalListEl,
    };
    const rerender = () => renderAllegianceState(renderRefs, fetchAllegianceSnapshot());
    rerender();
    const unsub = subscribeAllegiance(rerender);
    // Wave F.3 (2026-05-27): per-member login/logout chat-line notifier.
    // Snapshot refresh is already covered by `subscribeAllegiance` —
    // this exists solely to emit the retail-style "X has logged in"
    // line into the system chat tab.
    const unsubPresence = subscribeAllegiancePresence();

    return () => {
      try { unsub(); } catch (_) {}
      try { unsubPresence(); } catch (_) {}
      root.remove();
    };
  },
};

export const manifest = {
  id: "allegiance-panel",
  name: "Allegiance",
  icon: "🛡",
  iconHidden: true,
  version: "0.3.0",
  description: "Allegiance + companion-tab view (gmAllegianceUI 0x2100002F)",
};

// ─────────────────────────────────────────────────────────────────
// Standalone floating action panel (Wave E1 + F1 + F3 send-only)
//
// Lightweight overlay distinct from the main-panel `view` export
// above. Exposes window.__openAllegiancePanel /
// __closeAllegiancePanel for ad-hoc opening from devtools or hotkeys.
// 10 wired send-side controls: Swear / Break / MOTD / Officer / Gag /
// Recall / Add Ban / Remove Ban / Boot Selected / Lock Action dropdown.
// The Lock Action dropdown surfaces the full AllegianceLockAction enum
// (Off / On / Toggle / Check / CheckApproved / ClearApproved); the
// previous Wave-J1 hardcoded `LOCK_ON = 2` button is replaced.
//
// Receive-side AllegianceUpdate snapshot is live (Wave F2). Deferred:
// approved-vassal + officer-titles + ListBans receive — coming in a
// future wave.
// ─────────────────────────────────────────────────────────────────

const SA_STYLE_ID = "hb-alleg-standalone-style";
const SA_OVERLAY_ID = "hb-alleg-standalone";

// ACE.Entity.Enum.AllegianceLockAction (skipping Undef=0).
const ALLEGIANCE_LOCK_ACTIONS = {
  Off: 1, On: 2, Toggle: 3,
  Check: 4, CheckApproved: 5, ClearApproved: 6,
};

function ensureStandaloneStyles() {
  if (document.getElementById(SA_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = SA_STYLE_ID;
  style.textContent = `
    #${SA_OVERLAY_ID} {
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
    #${SA_OVERLAY_ID}.open { display: block; }
    .hb-alleg-sa-hdr {
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
    .hb-alleg-sa-x {
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
    .hb-alleg-sa-x:hover {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
    .hb-alleg-sa-body { padding: 10px; }
    .hb-alleg-sa-stack {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 10px;
    }
    .hb-alleg-sa-btn {
      box-sizing: border-box;
      padding: 8px 6px;
      font-family: var(--hb-font-serif);
      font-size: 11px;
      letter-spacing: 0.04em;
      color: var(--hb-text-cream);
      background: linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      border: 1px solid var(--hb-border-brass);
      cursor: pointer;
      text-transform: uppercase;
      user-select: none;
    }
    .hb-alleg-sa-btn:hover {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
    .hb-alleg-sa-placeholder {
      padding: 8px 6px;
      font-size: 10px;
      color: rgba(220, 200, 160, 0.55);
      font-style: italic;
      border-top: 1px solid var(--hb-border-brass-dim);
      text-align: center;
    }
    .hb-alleg-sa-row {
      display: flex;
      gap: 4px;
      align-items: stretch;
    }
    .hb-alleg-sa-row .hb-alleg-sa-btn { flex: 0 0 auto; padding: 6px 8px; }
    .hb-alleg-sa-input {
      flex: 1 1 auto;
      box-sizing: border-box;
      padding: 4px 6px;
      font-family: var(--hb-font-serif);
      font-size: 11px;
      color: var(--hb-text-cream);
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid var(--hb-border-brass-dim);
      outline: none;
    }
    .hb-alleg-sa-input:focus { border-color: var(--hb-border-brass); }
    .hb-alleg-sa-select {
      flex: 1 1 auto;
      box-sizing: border-box;
      padding: 4px 6px;
      font-family: var(--hb-font-serif);
      font-size: 11px;
      color: var(--hb-text-cream);
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid var(--hb-border-brass-dim);
      outline: none;
      min-width: 0;
    }
    .hb-alleg-sa-select:focus { border-color: var(--hb-border-brass); }
    .hb-alleg-sa-toast {
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

let saOverlay = null;

function saCurrentSelectedGuid() {
  try {
    const em = window.liveScene3d?.entityManager;
    const g = em?.getSelectedTarget?.();
    return g ? (g >>> 0) : null;
  } catch (_) {
    return null;
  }
}

function saCurrentSelectedName() {
  try {
    const em = window.liveScene3d?.entityManager;
    const g = em?.getSelectedTarget?.();
    if (!g) return "";
    let name = em?.getEntityName?.(g);
    if (typeof name === "string" && name.length) return name;
    // Fallback path used by social-panel when getEntityName isn't wired:
    // pull from the live entity meta.
    try {
      const inst = em?.entityMap?.get?.(g);
      if (inst?.meta?.name) return String(inst.meta.name);
    } catch (_) {}
    return "";
  } catch (_) {
    return "";
  }
}

function saWithSession(label, fn) {
  const handle = window.__sessionHandle;
  if (typeof handle?.[label] !== "function") {
    emit(`[allegiance] Wasm session not ready (${label}).`);
    return;
  }
  try {
    fn(handle);
  } catch (err) {
    emit(`[allegiance] ${label} failed: ${err?.message ?? err}`);
  }
}

function saToast(text) {
  if (!saOverlay) return;
  const old = saOverlay.querySelector(".hb-alleg-sa-toast");
  if (old) old.remove();
  const t = document.createElement("div");
  t.className = "hb-alleg-sa-toast";
  t.textContent = text;
  saOverlay.appendChild(t);
  setTimeout(() => t.remove(), 1750);
}

function buildStandaloneOverlay() {
  ensureStandaloneStyles();
  const overlay = document.createElement("div");
  overlay.id = SA_OVERLAY_ID;

  const hdr = document.createElement("div");
  hdr.className = "hb-alleg-sa-hdr";
  const title = document.createElement("span");
  setAcText(title, "Allegiance");
  hdr.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "hb-alleg-sa-x";
  closeBtn.title = "Close (Esc)";
  closeBtn.textContent = "x";
  closeBtn.addEventListener("click", closeStandalone);
  hdr.appendChild(closeBtn);
  overlay.appendChild(hdr);

  const body = document.createElement("div");
  body.className = "hb-alleg-sa-body";

  const stack = document.createElement("div");
  stack.className = "hb-alleg-sa-stack";

  const ACTIONS = [
    {
      label: "Swear Allegiance to Selected",
      confirm: "Swear allegiance to the selected target?",
      method: "swearAllegiance",
      verb: "swear",
    },
    {
      label: "Break Allegiance with Selected",
      confirm: "Break allegiance with the selected target?",
      method: "breakAllegiance",
      verb: "break",
    },
  ];

  for (const a of ACTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hb-alleg-sa-btn";
    btn.dataset.action = a.verb;
    setAcText(btn, a.label);
    btn.addEventListener("click", () => {
      const guid = saCurrentSelectedGuid();
      if (!guid) { saToast("Click a player first"); return; }
      if (!window.confirm(a.confirm)) return;
      saWithSession(a.method, (h) => {
        h[a.method](guid);
        emit(`[allegiance/${a.verb}] target=0x${guid.toString(16).padStart(8, "0")}`);
        saToast(`${a.verb === "swear" ? "Swear" : "Break"} sent`);
      });
    });
    stack.appendChild(btn);
  }

  // Wave F1: MOTD set row (inline text input + Confirm button).
  const motdRow = document.createElement("div");
  motdRow.className = "hb-alleg-sa-row";
  motdRow.dataset.action = "set-motd";
  const motdInput = document.createElement("input");
  motdInput.type = "text";
  motdInput.className = "hb-alleg-sa-input";
  motdInput.placeholder = "Allegiance MOTD";
  motdInput.maxLength = 255;
  motdRow.appendChild(motdInput);
  const motdBtn = document.createElement("button");
  motdBtn.type = "button";
  motdBtn.className = "hb-alleg-sa-btn";
  setAcText(motdBtn, "Set MOTD");
  motdBtn.title = "Set the allegiance MOTD / name";
  const submitMotd = () => {
    const text = (motdInput.value ?? "").trim();
    if (!text) { saToast("Enter a MOTD first"); return; }
    saWithSession("setAllegianceName", (h) => {
      h.setAllegianceName(text);
      emit(`[allegiance/set-name] name="${text}"`);
      saToast("MOTD sent");
      motdInput.value = "";
    });
  };
  motdBtn.addEventListener("click", submitMotd);
  motdInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); submitMotd(); }
  });
  motdRow.appendChild(motdBtn);
  stack.appendChild(motdRow);

  // Wave F1: Promote selected target to officer (officer_level = 1).
  const promoteBtn = document.createElement("button");
  promoteBtn.type = "button";
  promoteBtn.className = "hb-alleg-sa-btn";
  promoteBtn.dataset.action = "promote-officer";
  setAcText(promoteBtn, "Promote Selected to Officer");
  promoteBtn.addEventListener("click", () => {
    const name = saCurrentSelectedName();
    if (!name) { saToast("Click a player first"); return; }
    if (!window.confirm(`Promote ${name} to allegiance officer (level 1)?`)) return;
    saWithSession("setAllegianceOfficer", (h) => {
      h.setAllegianceOfficer(name, 1);
      emit(`[allegiance/officer] target="${name}" level=1`);
      saToast("Promote sent");
    });
  });
  stack.appendChild(promoteBtn);

  // Wave F1: Toggle chat-gag for selected target. Local bool flips on each click.
  let nextGagOn = true;
  const gagBtn = document.createElement("button");
  gagBtn.type = "button";
  gagBtn.className = "hb-alleg-sa-btn";
  gagBtn.dataset.action = "chat-gag";
  setAcText(gagBtn, "Toggle Chat Gag for Selected");
  gagBtn.addEventListener("click", () => {
    const name = saCurrentSelectedName();
    if (!name) { saToast("Click a player first"); return; }
    const turning = nextGagOn ? "gag" : "ungag";
    if (!window.confirm(`${turning === "gag" ? "Gag" : "Ungag"} ${name} from allegiance chat?`)) return;
    saWithSession("allegianceChatGag", (h) => {
      h.allegianceChatGag(name, nextGagOn);
      emit(`[allegiance/chat-gag] target="${name}" gag=${nextGagOn}`);
      saToast(`${nextGagOn ? "Gag" : "Ungag"} sent`);
      nextGagOn = !nextGagOn;
    });
  });
  stack.appendChild(gagBtn);

  // Wave F1: Recall to allegiance hometown (no args).
  const recallBtn = document.createElement("button");
  recallBtn.type = "button";
  recallBtn.className = "hb-alleg-sa-btn";
  recallBtn.dataset.action = "recall-hometown";
  setAcText(recallBtn, "Recall to Hometown");
  recallBtn.addEventListener("click", () => {
    if (!window.confirm("Recall to allegiance hometown?")) return;
    saWithSession("recallAllegianceHometown", (h) => {
      h.recallAllegianceHometown();
      emit("[allegiance/recall]");
      saToast("Recall sent");
    });
  });
  stack.appendChild(recallBtn);

  // Wave F3 (2026-05-26): Add ban — inline text input + Confirm. Sends
  // GameAction::AddAllegianceBan (sub-opcode 0x02A1).
  const addBanRow = document.createElement("div");
  addBanRow.className = "hb-alleg-sa-row";
  addBanRow.dataset.action = "add-ban";
  const addBanInput = document.createElement("input");
  addBanInput.type = "text";
  addBanInput.className = "hb-alleg-sa-input";
  addBanInput.placeholder = "Player to ban";
  addBanInput.maxLength = 64;
  addBanRow.appendChild(addBanInput);
  const addBanBtn = document.createElement("button");
  addBanBtn.type = "button";
  addBanBtn.className = "hb-alleg-sa-btn";
  setAcText(addBanBtn, "Add Ban");
  addBanBtn.title = "Add player to allegiance ban list";
  const submitAddBan = () => {
    const name = (addBanInput.value ?? "").trim();
    if (!name) { saToast("Enter a player name first"); return; }
    if (!window.confirm(`Ban ${name} from the allegiance?`)) return;
    saWithSession("addAllegianceBan", (h) => {
      h.addAllegianceBan(name);
      emit(`[allegiance/add-ban] target="${name}"`);
      saToast("Ban sent");
      addBanInput.value = "";
    });
  };
  addBanBtn.addEventListener("click", submitAddBan);
  addBanInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); submitAddBan(); }
  });
  addBanRow.appendChild(addBanBtn);
  stack.appendChild(addBanRow);

  // Wave F3 (2026-05-26): Remove ban — inline text input + Confirm.
  // Sends GameAction::RemoveAllegianceBan (sub-opcode 0x02A2).
  const removeBanRow = document.createElement("div");
  removeBanRow.className = "hb-alleg-sa-row";
  removeBanRow.dataset.action = "remove-ban";
  const removeBanInput = document.createElement("input");
  removeBanInput.type = "text";
  removeBanInput.className = "hb-alleg-sa-input";
  removeBanInput.placeholder = "Player to unban";
  removeBanInput.maxLength = 64;
  removeBanRow.appendChild(removeBanInput);
  const removeBanBtn = document.createElement("button");
  removeBanBtn.type = "button";
  removeBanBtn.className = "hb-alleg-sa-btn";
  setAcText(removeBanBtn, "Remove Ban");
  removeBanBtn.title = "Lift the ban on a player";
  const submitRemoveBan = () => {
    const name = (removeBanInput.value ?? "").trim();
    if (!name) { saToast("Enter a player name first"); return; }
    if (!window.confirm(`Lift the ban on ${name}?`)) return;
    saWithSession("removeAllegianceBan", (h) => {
      h.removeAllegianceBan(name);
      emit(`[allegiance/remove-ban] target="${name}"`);
      saToast("Unban sent");
      removeBanInput.value = "";
    });
  };
  removeBanBtn.addEventListener("click", submitRemoveBan);
  removeBanInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); submitRemoveBan(); }
  });
  removeBanRow.appendChild(removeBanBtn);
  stack.appendChild(removeBanRow);

  // Wave F3 (2026-05-26): Boot selected — picks target name from the
  // current 3D selection. Optional checkbox flips the account_boot flag
  // so ACE bans every character on the booted account. Sends
  // GameAction::BreakAllegianceBoot (sub-opcode 0x0277).
  const bootRow = document.createElement("div");
  bootRow.className = "hb-alleg-sa-row";
  bootRow.dataset.action = "boot-selected";
  const bootBtn = document.createElement("button");
  bootBtn.type = "button";
  bootBtn.className = "hb-alleg-sa-btn";
  setAcText(bootBtn, "Boot Selected");
  bootBtn.title = "Forcibly boot the selected player from the allegiance";
  const bootAccLabel = document.createElement("label");
  bootAccLabel.style.display = "flex";
  bootAccLabel.style.alignItems = "center";
  bootAccLabel.style.gap = "4px";
  bootAccLabel.style.fontSize = "10px";
  bootAccLabel.style.color = "var(--hb-text-cream)";
  bootAccLabel.style.padding = "0 6px";
  const bootAccCb = document.createElement("input");
  bootAccCb.type = "checkbox";
  bootAccLabel.appendChild(bootAccCb);
  const bootAccText = document.createElement("span");
  setAcText(bootAccText, "Account-wide");
  bootAccLabel.appendChild(bootAccText);
  bootBtn.addEventListener("click", () => {
    const name = saCurrentSelectedName();
    if (!name) { saToast("Click a player first"); return; }
    const accountBoot = !!bootAccCb.checked;
    const scopeWord = accountBoot ? " (entire account)" : "";
    if (!window.confirm(`Boot ${name} from the allegiance${scopeWord}?`)) return;
    saWithSession("breakAllegianceBoot", (h) => {
      h.breakAllegianceBoot(name, accountBoot);
      emit(`[allegiance/boot] target="${name}" account_boot=${accountBoot}`);
      saToast("Boot sent");
    });
  });
  bootRow.appendChild(bootBtn);
  bootRow.appendChild(bootAccLabel);
  stack.appendChild(bootRow);

  // Wave F3 (2026-05-26): Lock allegiance — dropdown covers the full
  // ACE.Entity.Enum.AllegianceLockAction (Off=1 / On=2 / Toggle=3 /
  // Check=4 / CheckApproved=5 / ClearApproved=6). Sends
  // GameAction::DoAllegianceLockAction (sub-opcode 0x003F).
  const lockRow = document.createElement("div");
  lockRow.className = "hb-alleg-sa-row";
  const lockSelect = document.createElement("select");
  lockSelect.className = "hb-alleg-sa-select";
  lockSelect.dataset.role = "lock-action";
  lockSelect.title = "Pick the AllegianceLockAction to send";
  const LOCK_OPTIONS = [
    { value: ALLEGIANCE_LOCK_ACTIONS.Off,            label: "Off — Unlock" },
    { value: ALLEGIANCE_LOCK_ACTIONS.On,             label: "On — Lock", selected: true },
    { value: ALLEGIANCE_LOCK_ACTIONS.Toggle,         label: "Toggle" },
    { value: ALLEGIANCE_LOCK_ACTIONS.Check,          label: "Check — Query lock state" },
    { value: ALLEGIANCE_LOCK_ACTIONS.CheckApproved,  label: "Check Approved — Query approved-vassal status" },
    { value: ALLEGIANCE_LOCK_ACTIONS.ClearApproved,  label: "Clear Approved — Reset approved-vassal list" },
  ];
  for (const opt of LOCK_OPTIONS) {
    const o = document.createElement("option");
    o.value = String(opt.value);
    o.textContent = opt.label;
    if (opt.selected) o.selected = true;
    lockSelect.appendChild(o);
  }
  lockRow.appendChild(lockSelect);
  const lockBtn = document.createElement("button");
  lockBtn.type = "button";
  lockBtn.className = "hb-alleg-sa-btn";
  lockBtn.dataset.action = "lock-allegiance";
  setAcText(lockBtn, "Confirm Lock Action");
  lockBtn.title = "Send the selected AllegianceLockAction";
  lockBtn.addEventListener("click", () => {
    const action = (parseInt(lockSelect.value, 10) >>> 0);
    if (!Number.isFinite(action) || action < 1 || action > 6) {
      saToast("Invalid lock action");
      return;
    }
    saWithSession("doAllegianceLockAction", (h) => {
      h.doAllegianceLockAction(action);
      emit(`[allegiance/lock] action=${action}`);
      saToast("Lock action sent");
    });
  });
  lockRow.appendChild(lockBtn);
  stack.appendChild(lockRow);

  body.appendChild(stack);

  // Wave-F2 (2026-05-26): live state mini-view. Subscribes to
  // allegianceUpdated and re-fetches `playerAllegiance()` on each event.
  const stateBox = document.createElement("div");
  stateBox.className = "hb-alleg-sa-placeholder";
  stateBox.dataset.role = "alleg-state";
  body.appendChild(stateBox);

  const renderStateBox = () => {
    const snap = fetchAllegianceSnapshot();
    while (stateBox.firstChild) stateBox.removeChild(stateBox.firstChild);
    if (!snap) {
      setAcText(stateBox, "Not in an allegiance. Use Swear above to join one.");
      return;
    }
    const headerLine = document.createElement("div");
    const lockSuffix = snap.isLocked ? " [LOCKED]" : "";
    setAcText(headerLine, `${snap.name || "(unnamed)"}${lockSuffix} — rank ${(snap.rank >>> 0)}`);
    headerLine.style.color = "var(--hb-text-gold)";
    headerLine.style.fontStyle = "normal";
    headerLine.style.marginBottom = "4px";
    stateBox.appendChild(headerLine);

    const monarch = memberDisplay(snap.monarch);
    const patron = memberDisplay(snap.patron);
    const myself = memberDisplay(snap.myself);
    const vassals = Array.isArray(snap.vassals) ? snap.vassals : [];
    const playerIsMonarch = monarch && !myself;

    const monarchLine = document.createElement("div");
    setAcText(
      monarchLine,
      monarch
        ? (playerIsMonarch ? `Monarch: ${monarch.name} (you)` : `Monarch: ${monarch.name}`)
        : "Monarch: —"
    );
    monarchLine.style.fontStyle = "normal";
    stateBox.appendChild(monarchLine);

    const patronLine = document.createElement("div");
    setAcText(
      patronLine,
      playerIsMonarch ? "Patron: (you are monarch)" : patron ? `Patron: ${patron.name}` : "No patron"
    );
    patronLine.style.fontStyle = "normal";
    stateBox.appendChild(patronLine);

    const vassalLine = document.createElement("div");
    setAcText(vassalLine, `Vassals: ${vassals.length}`);
    vassalLine.style.fontStyle = "normal";
    stateBox.appendChild(vassalLine);
  };
  renderStateBox();
  // Track the unsub so we can drop it if the overlay is closed; for the
  // standalone we keep the bus subscription alive for the page lifetime
  // (overlay is hidden, not destroyed, on close).
  subscribeAllegiance(renderStateBox);
  // Wave F.3 (2026-05-27): emit per-member login chat lines in the
  // standalone too. Same page-lifetime subscription rationale.
  subscribeAllegiancePresence();

  overlay.appendChild(body);

  overlay.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeStandalone();
  });

  document.body.appendChild(overlay);
  return overlay;
}

function openStandalone() {
  if (!saOverlay) saOverlay = buildStandaloneOverlay();
  saOverlay.classList.add("open");
  saOverlay.tabIndex = -1;
  try { saOverlay.focus({ preventScroll: true }); } catch (_) {}
}

function closeStandalone() {
  if (!saOverlay) return;
  saOverlay.classList.remove("open");
}

if (typeof window !== "undefined") {
  if (!window.__hbAllegiancePanelEscBound) {
    window.__hbAllegiancePanelEscBound = true;
    window.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (saOverlay?.classList.contains("open")) closeStandalone();
    });
  }
  window.__openAllegiancePanel = openStandalone;
  window.__closeAllegiancePanel = closeStandalone;
}
