// Character info view — Attributes / Skills / Titles tabs.
// Port of retail gmCharacterInfoUI (0x2100001A parent) with child
// tabs gmAttributeUI (0x2100002C), gmSkillUI (0x2100002D),
// gmCharacterTitleUI (0x2100005E).
//
// Wave 2 surface — mounts as a view of plugins/main-panel.js
// (the shared right-side pane). Toggled via the C key.
//
// Per-skill icons come from SkillTable DAT 0xE000004 (38 skills,
// each with `iconIdHex`). Dump pipeline: WB.Terminal
// `chorizite-dump-skill-table` → `apps/holtburger-web/data/
// skill-table.json` + extracted PNGs under data/ui-sprites/.
//
// Player skill/attribute values come from
// `client.player.stats.skills` and `.attributes` — flat int arrays
// the wasm SessionHandle owns. Per the player-stats inspection at
// 1070 runtime: skills = [id, current, base, trained_state, xp]
// per skill, attributes = [id, current, base, buffed_max] per attr.
//
// Retail layout source per character_info_layout_dump 2026-05-24:
//
//   gmCharacterInfoUI 0x2100001A — 300×362 parent panel.
//     0x1000011B root (300×362)
//       0x100000FC close button (276,0) 24×25, 2 states
//       0x100000FE title bar strip (0,0) 276×25
//       0x1000011C content area type=3 (0,25) 300×337
//         0x1000011D inner content (8,0) 262×337 — main text region
//         0x1000011E right scrollbar (280,0) 16×337
//   gmAttributeUI 0x2100002C — wrapper, child rows populated by runtime
//     0x10000225 root type=268435498 (0,0) 300×337, 3 states
//       0x10000226 inner (0,0) 300×337
//   gmSkillUI 0x2100002D — wrapper, same shape
//     0x1000022E root type=268435499 (0,0) 300×337, 3 states
//       0x10000226 inner (0,0) 300×337
//   gmCharacterTitleUI 0x2100005E — 300×600, standalone in retail
//     0x1000052D outer (300×600)
//       0x1000052E header row 1 (8,20) 270×18
//       0x1000052F header row 2 (8,40) 270×18
//       0x10000530 separator (0,60) 300×9
//       0x10000531 header row 3 (8,70) 270×18
//       0x10000532 list area type=5 (8,90) 270×455
//       0x10000533 scrollbar (280,90) 16×455
//       0x10000534 separator (0,550) 300×9
//       0x10000535 bottom button (53,560) 200×32
//
// v1 fetch_layout caveat: only geometry is serialized. Tab labels,
// row labels, sprite IDs etc. are hand-tuned. Retail rows of
// Attribute/Skill UIs live in a state-controlled child layout that
// fetch_layout v1 does not yet expand (G3 in layout-port-plan).
// We hand-pitch attribute rows (24px) and skill rows (18px) within
// the content area; the layout supplies the OUTER content-area
// dimensions and the Title-tab row positions.

import { setAcText } from "../ui/ac_font.js";
import { loadLayout, findElementById, getCachedLayout } from "../ui/ac_layout.js";

const VIEW_STYLE_ID = "hb-charinfo-view-style";

// gmCharacterInfoUI parent panel — outer 300×362 (the entire
// floating panel: title bar + content area). Our DOM lives inside
// main-panel's body slot which is already at y=25; so element
// 0x1000011C (content area at 0,25 of 300×337) maps to body (0,0,
// 300,337). 0x1000011D (inner content 262×337 inset 8px from the
// left) is where text/tabs live.
const CI_LAYOUT_ID            = 0x2100001A;
// Reference-only element_ids for the outer panel chrome — owned by
// main-panel (close button, title bar) or by the wrapping floating
// panel (root). Kept here so the layout map stays complete for
// future ports:
//   0x1000011B — 300×362 outer (whole panel)
//   0x100000FC — (276,0) 24×25 close button
//   0x100000FE — (0,0) 276×25 title bar
const CI_ELEM_CONTENT         = 0x1000011C; // (0,25) 300×337 — main-panel.body
const CI_ELEM_INNER           = 0x1000011D; // (8,0 of content) 262×337 — text/rows
const CI_ELEM_SCROLLBAR       = 0x1000011E; // (280,0 of content) 16×337

// gmAttributeUI / gmSkillUI tab content layouts — wrappers only;
// retail populates row UIElements at runtime via per-stat code paths
// (gmStatManagementUI::PostInit at acclient.c:284203 uses
// GetChildRecursive on element_ids 0x10000231 … 0x100005C6 that don't
// exist in the LayoutDesc's static tree). We use the wrapper's outer
// dims to confirm the body sizing matches our content area.
const ATTR_LAYOUT_ID          = 0x2100002C;
const ATTR_ELEM_ROOT          = 0x10000225; // 300×337
const ATTR_ELEM_INNER         = 0x10000226; // 300×337

const SKILL_LAYOUT_ID         = 0x2100002D;
const SKILL_ELEM_ROOT         = 0x1000022E; // 300×337
const SKILL_ELEM_INNER        = 0x10000226; // 300×337

// gmCharacterTitleUI — rich structured layout (the only one of the
// three tab layouts with explicit row geometry in the LayoutDesc).
// Native size 300×600; we squeeze into 300×337 by SCALING vertical
// offsets via a constant: scaleY = 337 / (top-bottom of the layout's
// effective vertical span). Holding x unchanged for crispness.
const TITLE_LAYOUT_ID         = 0x2100005E;
// Reference-only: 0x1000052D is the 300×600 native panel root —
// scaling is applied per-row by applyCharacterInfoLayout instead.
const TITLE_ELEM_HEADER_1     = 0x1000052E; // (8,20) 270×18
const TITLE_ELEM_HEADER_2     = 0x1000052F; // (8,40) 270×18
const TITLE_ELEM_SEP_1        = 0x10000530; // (0,60) 300×9
const TITLE_ELEM_HEADER_3     = 0x10000531; // (8,70) 270×18
const TITLE_ELEM_LIST         = 0x10000532; // (8,90) 270×455
const TITLE_ELEM_SCROLLBAR    = 0x10000533; // (280,90) 16×455
const TITLE_ELEM_SEP_2        = 0x10000534; // (0,550) 300×9
const TITLE_ELEM_BOTTOM_BTN   = 0x10000535; // (53,560) 200×32

// Native height of the Title-tab layout in the LayoutDesc. Retail
// opens it as its own 300×600 floating panel; in Holtburger it lives
// as a tab inside the 300×337 character-info panel, so we compress
// the vertical range to fit. Horizontal positions (x, width) are
// applied unchanged — they're already 300px-wide.
const TITLE_NATIVE_H = 600;

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = VIEW_STYLE_ID;
  style.textContent = `
    .hb-ci-root {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      box-sizing: border-box;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      overflow: hidden;
    }
    /* Tab strip — Holtburger UX addition (retail gmCharacterInfoUI
       has no tabs; it's a single wall-of-text panel). 3 buttons at
       the top of our content area, slimmed to leave maximum room
       for the content below. */
    .hb-ci-tabs {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 20px;
      box-sizing: border-box;
      display: flex;
      gap: 1px;
      padding: 2px 4px 0;
      border-bottom: 1px solid var(--hb-border-brass-dim);
    }
    .hb-ci-tab {
      padding: 2px 8px;
      font-size: 10px;
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
    .hb-ci-tab:hover { background: var(--hb-overlay-hover); }
    .hb-ci-tab.active {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
      border-color: var(--hb-border-brass);
    }
    /* Header strip — character name + level. Sized by hand below the
       tab strip; retail's gmStatManagementUI::PostInit binds these to
       UIElement_Text fields at runtime (element ids 0x10000231 name,
       0x1000023B level) which v1 fetch_layout doesn't surface yet. */
    .hb-ci-head {
      position: absolute;
      top: 20px;
      left: 0;
      right: 0;
      height: 22px;
      box-sizing: border-box;
      padding: 3px 8px;
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      background: rgba(0, 0, 0, 0.3);
      border-bottom: 1px solid var(--hb-border-brass-dim);
    }
    .hb-ci-head-name {
      font-size: 12px;
      color: var(--hb-text-gold);
      letter-spacing: 0.02em;
    }
    .hb-ci-head-level {
      font-size: 10px;
      color: var(--hb-text-cream);
    }
    /* Body — fills the area below the tab strip + header strip, above
       the footer. applyCharacterInfoLayout overrides left/width using
       the parent layout's inner-content element 0x1000011D so the
       8-px left inset matches retail anatomy. */
    .hb-ci-body {
      position: absolute;
      top: 42px;
      left: 0;
      right: 0;
      bottom: 18px;
      overflow-y: auto;
      box-sizing: border-box;
      padding: 4px 4px;
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.5);
    }
    /* Scrollbar gutter — retail puts a dedicated 16-px scrollbar
       element (0x1000011E) at the right edge of the content area.
       Our DOM uses the browser's native scrollbar inside .hb-ci-body,
       so we mark the layout-derived scrollbar dims on a phantom div
       (.hb-ci-scrollbar) for diagnostic visibility — kept invisible
       to avoid double scrollbars. The verifier reads its bounding box
       to confirm layout-driven placement. */
    .hb-ci-scrollbar {
      position: absolute;
      pointer-events: none;
      background: transparent;
    }
    /* Per-row pieces shared across all tabs. */
    .hb-ci-section {
      font-size: 9px;
      color: #6acaca;
      background: rgba(0, 60, 70, 0.35);
      padding: 3px 8px;
      margin: 4px 0 2px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      border-bottom: 1px solid rgba(106, 202, 202, 0.4);
    }
    .hb-ci-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 1px 6px;
      font-size: 10px;
      line-height: 18px;
    }
    .hb-ci-row:hover { background: var(--hb-overlay-hover); }
    .hb-ci-icon {
      width: 20px;
      height: 20px;
      flex: 0 0 20px;
      background-repeat: no-repeat;
      background-size: contain;
      background-position: center;
      image-rendering: pixelated;
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.7));
    }
    .hb-ci-name {
      flex: 1 1 auto;
      color: var(--hb-text-cream);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.85);
    }
    .hb-ci-value {
      flex: 0 0 auto;
      color: var(--hb-text-numeric-green);
      font-variant-numeric: tabular-nums;
      text-align: right;
      min-width: 30px;
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.85);
    }
    /* Raise controls — DAT sprites 0x06001282/83 (UP button) and
       0x06004D17/19 (green/red eligibility dot) from gmStatManagementUI
       layout 0x2100002B. The dot shows the can/can't-raise state; the
       button dispatches RaiseAttribute / RaiseVital to the server. */
    .hb-ci-dot {
      width: 13px; height: 13px;
      flex: 0 0 13px;
      background: center/contain no-repeat;
      image-rendering: pixelated;
    }
    .hb-ci-raise {
      width: 24px; height: 25px;
      flex: 0 0 24px;
      padding: 0;
      border: 0;
      background: center/contain no-repeat;
      image-rendering: pixelated;
      cursor: pointer;
    }
    .hb-ci-raise[disabled] { opacity: 0.45; cursor: not-allowed; }
    .hb-ci-raise:hover:not([disabled]) { filter: brightness(1.2); }
    /* Title-tab specific structure — uses absolute layout from
       gmCharacterTitleUI 0x2100005E (compressed to fit our body).
       Mounted in the .hb-ci-body when the Titles tab is active. */
    .hb-ci-titles {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
    }
    .hb-ci-titles-header {
      position: absolute;
      box-sizing: border-box;
      font-size: 10px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.85);
      padding: 0 4px;
      display: flex;
      align-items: center;
    }
    .hb-ci-titles-sep {
      position: absolute;
      box-sizing: border-box;
      background:
        linear-gradient(180deg,
          transparent 0%,
          var(--hb-border-brass-dim) 40%,
          var(--hb-border-brass) 50%,
          var(--hb-border-brass-dim) 60%,
          transparent 100%);
      opacity: 0.7;
    }
    .hb-ci-titles-list {
      position: absolute;
      box-sizing: border-box;
      overflow-y: auto;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--hb-border-brass-dim);
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.5);
    }
    .hb-ci-titles-list-empty {
      padding: 14px 12px;
      color: var(--hb-text-muted);
      font-style: italic;
      text-align: center;
      font-size: 10px;
    }
    .hb-ci-titles-bottom {
      position: absolute;
      box-sizing: border-box;
      padding: 2px 6px;
      font-size: 10px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid var(--hb-border-brass);
      cursor: pointer;
      user-select: none;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      text-align: center;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .hb-ci-titles-bottom:hover {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
    .hb-ci-footer {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 18px;
      box-sizing: border-box;
      padding: 4px 8px;
      background: rgba(0, 0, 0, 0.45);
      border-top: 1px solid var(--hb-border-brass-dim);
      font-size: 9px;
      color: var(--hb-text-muted);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .hb-ci-empty {
      padding: 14px 12px;
      color: var(--hb-text-muted);
      font-style: italic;
      text-align: center;
    }
  `;
  document.head.appendChild(style);
}

// Cached skill table — fetched once, reused across mounts.
let skillTablePromise = null;
function loadSkillTable() {
  if (!skillTablePromise) {
    skillTablePromise = fetch("./data/skill-table.json")
      .then((r) => r.json())
      .catch((e) => { console.warn("[char-info] skill-table load failed", e); return { skills: [] }; });
  }
  return skillTablePromise;
}

// AC skill state encoding (player.stats.skills[i*5+3] value):
//   0 = Unusable (some Magic skills if class can't learn)
//   1 = Untrained (default for usable)
//   2 = Trained
//   3 = Specialized

// Attribute name table — matches ACE's PropertyAttribute enum
// (Source/ACE.Entity/Enum/Properties/PropertyAttribute.cs) and the
// retail DBObj.EnumIDMap UIAttributeIcons table (0x25000006). Pre-fix
// the table had Coordination=3 / Quickness=4 swapped — diag char's
// values for those two are both 100 so the bug was invisible until the
// hex DID extraction matched up.
const ATTR_NAMES = {
  1: "Strength", 2: "Endurance", 3: "Quickness",
  4: "Coordination", 5: "Focus", 6: "Self",
};
const VITAL_NAMES = { 1: "Health", 3: "Stamina", 5: "Mana" };

// Canonical retail attribute icon DIDs, sourced from DAT DBObj.EnumIDMap
// `UIAttributeIcons` (0x25000006) + `UIAttribute2ndIcons` (0x25000007),
// dumped via WB.Terminal chorizite-parse-dat-record. Extracted to
// data/ui-sprites/ as 25×25 PFID_R8G8B8 PNGs.
const ATTR_ICONS = {
  1: "0x060002C8", // Strength    — flexed arm
  2: "0x060002C4", // Endurance   — armored fighter
  3: "0x060002C6", // Quickness
  4: "0x060002C9", // Coordination
  5: "0x060002C5", // Focus
  6: "0x060002C7", // Self
};
const VITAL_ICONS = {
  1: "0x06004C3B", // Health   — red heart
  3: "0x06004C3C", // Stamina  — yellow leaf
  5: "0x06004C3D", // Mana
};
const ATTR_ICON_URL = (id) =>
  ATTR_ICONS[id] ? `./data/ui-sprites/${ATTR_ICONS[id]}.png` : null;
const VITAL_ICON_URL = (id) =>
  VITAL_ICONS[id] ? `./data/ui-sprites/${VITAL_ICONS[id]}.png` : null;

// 2026-05-30 — ExperienceTable (DAT 0x0E000018) lazy-loaded once.
// `attributes[N]` is the cumulative XP to reach rank N (191 ranks);
// `vitals[N]` likewise (197 ranks). Cost from current → next rank is
// `arr[r+1] - arr[r]`. The same table that
// `ACE.Server.WorldObjects.Player.HandleActionRaiseAttribute` consults
// via `DatManager.PortalDat.XpTable.AttributeXpList` (so the JS preview
// matches what the server will accept).
let _xpTablesPromise = null;
function loadXpTables() {
  if (_xpTablesPromise) return _xpTablesPromise;
  _xpTablesPromise = (typeof window !== "undefined" && window.__xpTablesPromise) ||
    fetch("./data/xp-tables.json").then((r) => r.json()).catch(() => null);
  return _xpTablesPromise;
}
function nextRankCost(table, ranks) {
  if (!Array.isArray(table)) return null;
  if (ranks == null || ranks < 0) ranks = 0;
  if (ranks >= table.length - 1) return null; // max
  return (table[ranks + 1] >>> 0) - (table[ranks] >>> 0);
}

// Pull the player's unspent XP from levelInfo[3,4] (the lo/hi pair of
// `holtburger_world::context::WorldContextExt::player_unspent_xp`). Safe
// up to 2^53 — AC caps well below that.
function getAvailableXp(stats) {
  const lv = stats?.levelInfo;
  if (!lv) return 0;
  const lo = tupleArrayAt(lv, 3) ?? 0;
  const hi = tupleArrayAt(lv, 4) ?? 0;
  return (hi >>> 0) * 0x1_0000_0000 + (lo >>> 0);
}

function tupleArrayAt(arr, i) {
  // Wasm flat-array stat tuples are exposed as `{ "0": v, "1": v, ... }`
  // when read from a JS Object accessor. Coerce to a real array.
  if (Array.isArray(arr)) return arr[i];
  if (arr && typeof arr === "object") return arr[i];
  return undefined;
}

function getStats() {
  const s = window.__pluginClient?.player?.stats;
  if (!s) return null;
  try {
    return {
      name: s.name,
      attributes: s.attributes,   // [id, cur, base, buffed_max] × 6 + vitals appended?
      skills: s.skills,           // [id, cur, base, trained_state, xp] × 38
      vitals: s.vitals,           // [type, cur, base, buffed_max] × 3
      levelInfo: s.levelInfo,     // [level, xp_total, xp_to_next, ...]
    };
  } catch (_) { return null; }
}

// Apply gmCharacterInfoUI / gmAttributeUI / gmSkillUI / gmCharacterTitleUI
// layouts to the character-info view. Mounted via main-panel.showView,
// which only fires AFTER wasm-ready (user-initiated panel open), so no
// retry loop is needed; the layouts resolve on the first call.
//
// refs:
//   rootEl       — .hb-ci-root (top-level container, sized to main-panel body)
//   tabsEl       — .hb-ci-tabs (Holtburger tab strip; not in retail layout)
//   headEl       — .hb-ci-head (character name + level header strip)
//   bodyEl       — .hb-ci-body (per-tab content area; layout-anchored to
//                  parent layout's inner-content element 0x1000011D)
//   scrollbarEl  — .hb-ci-scrollbar (invisible phantom for retail scrollbar
//                  geometry confirmation; native browser scrollbar handles
//                  the actual scrolling)
//   titleRefs    — { headerEls[3], sepEls[2], listEl, bottomBtnEl } —
//                  per-element refs for the Title-tab structured layout.
function applyCharacterInfoLayout(refs) {
  const apply = ([parent, attr, skill, title]) => {
    let appliedRegions = 0;

    // ── Parent panel (gmCharacterInfoUI 0x2100001A) ─────────────────
    // Main-panel owns the title bar (0x100000FE) and close button
    // (0x100000FC) — we don't apply those. Element 0x1000011C is the
    // content area; its dimensions should already match main-panel's
    // body (300×337). Element 0x1000011D supplies the 8-px left inset
    // for the inner content region — we apply that to .hb-ci-body so
    // the tabs/header/body all share the retail content anatomy.
    let innerInset = { x: 8, w: 262 };
    if (parent) {
      const content = findElementById(parent, CI_ELEM_CONTENT);
      const inner = findElementById(parent, CI_ELEM_INNER);
      const scrollbar = findElementById(parent, CI_ELEM_SCROLLBAR);
      if (content) appliedRegions += 1;
      if (inner && refs.bodyEl) {
        // Apply the 8-px left inset + 262-px width to the body region.
        // The CSS rule uses `left:0; right:0` for full-width; we
        // explicit-override left + width here.
        refs.bodyEl.style.right = "";
        if (typeof inner.x === "number") refs.bodyEl.style.left = `${inner.x}px`;
        if (typeof inner.width === "number") refs.bodyEl.style.width = `${inner.width}px`;
        if (typeof inner.x === "number") innerInset.x = inner.x;
        if (typeof inner.width === "number") innerInset.w = inner.width;
        appliedRegions += 1;
      }
      // Also anchor the tabs + head strip to the same x/width so the
      // tab strip lines up with the body's left edge (retail content
      // is fully inset 8 px — applying the same anchor to all three
      // bands keeps the panel coherent).
      if (inner && refs.tabsEl) {
        refs.tabsEl.style.right = "";
        if (typeof inner.x === "number") refs.tabsEl.style.left = `${inner.x}px`;
        if (typeof inner.width === "number") refs.tabsEl.style.width = `${inner.width}px`;
      }
      if (inner && refs.headEl) {
        refs.headEl.style.right = "";
        if (typeof inner.x === "number") refs.headEl.style.left = `${inner.x}px`;
        if (typeof inner.width === "number") refs.headEl.style.width = `${inner.width}px`;
      }
      if (scrollbar && refs.scrollbarEl) {
        if (typeof scrollbar.x === "number") refs.scrollbarEl.style.left = `${scrollbar.x}px`;
        if (typeof scrollbar.y === "number") refs.scrollbarEl.style.top = `${scrollbar.y}px`;
        if (typeof scrollbar.width === "number") refs.scrollbarEl.style.width = `${scrollbar.width}px`;
        if (typeof scrollbar.height === "number") refs.scrollbarEl.style.height = `${scrollbar.height}px`;
        appliedRegions += 1;
      }
    }

    // ── Attribute / Skill tab layouts ────────────────────────────────
    // gmAttributeUI 0x2100002C + gmSkillUI 0x2100002D are wrapper
    // containers only. The per-stat rows aren't in the LayoutDesc's
    // static tree (retail populates them at runtime via UIElement
    // factory calls referenced by ids 0x10000231-0x100005C6, which
    // v1 fetch_layout does not yet expand — see layout-port-plan G3).
    // Confirm the outer dims match our body for diagnostic visibility.
    if (attr) {
      const root = findElementById(attr, ATTR_ELEM_ROOT);
      const inner = findElementById(attr, ATTR_ELEM_INNER);
      if (root) appliedRegions += 1;
      if (inner) appliedRegions += 1;
    }
    if (skill) {
      const root = findElementById(skill, SKILL_ELEM_ROOT);
      const inner = findElementById(skill, SKILL_ELEM_INNER);
      if (root) appliedRegions += 1;
      if (inner) appliedRegions += 1;
    }

    // ── Title tab layout (gmCharacterTitleUI 0x2100005E) ─────────────
    // Native size 300×600. Compressed to fit our body (~ 277-px tall
    // after tabs/header/footer). Per-element scaleY = bodyH / 600.
    if (title && refs.titleRefs) {
      const titleRefMap = [
        [TITLE_ELEM_HEADER_1, refs.titleRefs.headerEls?.[0]],
        [TITLE_ELEM_HEADER_2, refs.titleRefs.headerEls?.[1]],
        [TITLE_ELEM_HEADER_3, refs.titleRefs.headerEls?.[2]],
        [TITLE_ELEM_SEP_1,    refs.titleRefs.sepEls?.[0]],
        [TITLE_ELEM_SEP_2,    refs.titleRefs.sepEls?.[1]],
        [TITLE_ELEM_LIST,     refs.titleRefs.listEl],
        [TITLE_ELEM_BOTTOM_BTN, refs.titleRefs.bottomBtnEl],
      ];
      const bodyH = refs.bodyEl?.getBoundingClientRect().height || 277;
      const scaleY = bodyH / TITLE_NATIVE_H;
      for (const [id, el] of titleRefMap) {
        if (!el) continue;
        const desc = findElementById(title, id);
        if (!desc) continue;
        if (typeof desc.x === "number") el.style.left = `${desc.x}px`;
        if (typeof desc.y === "number") el.style.top = `${Math.round(desc.y * scaleY)}px`;
        if (typeof desc.width === "number") el.style.width = `${desc.width}px`;
        if (typeof desc.height === "number") el.style.height = `${Math.max(1, Math.round(desc.height * scaleY))}px`;
        appliedRegions += 1;
      }
      // Also wire the Title-tab scrollbar geometry on a phantom div if
      // we have one (kept invisible — native scrollbar handles
      // scrolling).
      const titleScroll = findElementById(title, TITLE_ELEM_SCROLLBAR);
      if (titleScroll && refs.titleRefs.scrollbarEl) {
        if (typeof titleScroll.x === "number") refs.titleRefs.scrollbarEl.style.left = `${titleScroll.x}px`;
        if (typeof titleScroll.y === "number") refs.titleRefs.scrollbarEl.style.top = `${Math.round(titleScroll.y * scaleY)}px`;
        if (typeof titleScroll.width === "number") refs.titleRefs.scrollbarEl.style.width = `${titleScroll.width}px`;
        if (typeof titleScroll.height === "number") refs.titleRefs.scrollbarEl.style.height = `${Math.max(1, Math.round(titleScroll.height * scaleY))}px`;
        appliedRegions += 1;
      }
    }

    try {
      window.__diag?.layout?.onCharacterInfoApplied?.({
        appliedRegions,
        parentLoaded: !!parent,
        attrLoaded: !!attr,
        skillLoaded: !!skill,
        titleLoaded: !!title,
        innerInset,
      });
    } catch (_) {}
  };

  const cachedParent = getCachedLayout(CI_LAYOUT_ID);
  const cachedAttr   = getCachedLayout(ATTR_LAYOUT_ID);
  const cachedSkill  = getCachedLayout(SKILL_LAYOUT_ID);
  const cachedTitle  = getCachedLayout(TITLE_LAYOUT_ID);
  if (cachedParent && cachedAttr && cachedSkill && cachedTitle) {
    apply([cachedParent, cachedAttr, cachedSkill, cachedTitle]);
    return;
  }
  Promise.all([
    loadLayout(CI_LAYOUT_ID),
    loadLayout(ATTR_LAYOUT_ID),
    loadLayout(SKILL_LAYOUT_ID),
    loadLayout(TITLE_LAYOUT_ID),
  ]).then(apply).catch(() => {});
}

function renderHead(headEl, stats) {
  headEl.innerHTML = "";
  const nameEl = document.createElement("div");
  nameEl.className = "hb-ci-head-name";
  setAcText(nameEl, stats?.name || "—", { color: "#f0c87c" });
  headEl.appendChild(nameEl);
  const levelEl = document.createElement("div");
  levelEl.className = "hb-ci-head-level";
  const level = stats?.levelInfo ? (tupleArrayAt(stats.levelInfo, 0) ?? 1) : 1;
  setAcText(levelEl, `Level ${level}`, { color: "#f0d8a0" });
  headEl.appendChild(levelEl);
}

function renderAttributes(bodyEl, stats, _skillTable) {
  bodyEl.innerHTML = "";
  const a = stats?.attributes;
  if (!a) {
    const e = document.createElement("div");
    e.className = "hb-ci-empty";
    setAcText(e, "No attributes yet.", { color: "#a8a090" });
    bodyEl.appendChild(e);
    return;
  }
  bodyEl.appendChild(section("Attributes"));
  // Rust src/lib.rs:16183 — attributes layout is
  // `[type, current, base, ranks]` (4-tuple × 6). NO `buffed_max` field;
  // pre-2026-05-29 the JS read index 3 as `max` and rendered "40/0" for
  // every attribute (the diag char has ranks=0). Show `current` alone,
  // and if `current` ≠ `base` (e.g. a debuff or item bonus is active)
  // also show the base in parentheses.
  const availableXp = getAvailableXp(stats);
  const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
  // Cached XP tables (lazy-loaded). The render runs before fetch resolves
  // on first open, so we may pass null cost on initial paint and refresh
  // on the next playerStatsUpdated drain.
  const xpTables = _xpTablesPromise?._cached ?? null;
  if (!xpTables) loadXpTables().then((t) => { if (t) _xpTablesPromise._cached = t; });
  for (let i = 0; i < 24; i += 4) {
    const id = tupleArrayAt(a, i);
    if (id == null) break;
    const cur = tupleArrayAt(a, i + 1);
    const base = tupleArrayAt(a, i + 2);
    const ranks = tupleArrayAt(a, i + 3) ?? 0;
    const display = (cur != null && base != null && cur !== base)
      ? `${cur} (${base})`
      : `${cur ?? "—"}`;
    const cost = xpTables ? nextRankCost(xpTables.attributes, ranks) : null;
    const raise = (cost != null && handle?.raiseAttribute) ? {
      cost,
      canAfford: cost <= availableXp,
      isMax: false,
      availableXp,
      onClick: () => { try { handle.raiseAttribute(id >>> 0, cost >>> 0); } catch (e) { console.warn("[raiseAttribute]", e); } },
    } : (xpTables ? { cost: 0, canAfford: false, isMax: true, availableXp, onClick: () => {} } : null);
    bodyEl.appendChild(row(ATTR_ICON_URL(id), ATTR_NAMES[id] || `Attr ${id}`, display, raise));
  }
  const v = stats?.vitals;
  if (v) {
    bodyEl.appendChild(section("Vitals"));
    // Vitals (src/lib.rs:16174) DO have `buffed_max` at index 3.
    for (let i = 0; i + 3 < (v.length ?? 12); i += 4) {
      const id = tupleArrayAt(v, i);
      if (id == null) break;
      const cur = tupleArrayAt(v, i + 1);
      const base = tupleArrayAt(v, i + 2);
      const max = tupleArrayAt(v, i + 3);
      // Vitals carry current/buffed_max instead of ranks; ranks is
      // (base - intrinsic_start) — fall back to base for the lookup.
      const ranks = base ?? 0;
      const cost = xpTables ? nextRankCost(xpTables.vitals, ranks) : null;
      const raise = (cost != null && handle?.raiseVital) ? {
        cost,
        canAfford: cost <= availableXp,
        isMax: false,
        availableXp,
        onClick: () => { try { handle.raiseVital(id >>> 0, cost >>> 0); } catch (e) { console.warn("[raiseVital]", e); } },
      } : null;
      bodyEl.appendChild(row(VITAL_ICON_URL(id), VITAL_NAMES[id] || `Vital ${id}`, `${cur}/${max}`, raise));
    }
  }
}

function renderSkills(bodyEl, stats, skillTable) {
  bodyEl.innerHTML = "";
  if (!skillTable?.skills?.length) {
    bodyEl.appendChild(emptyMsg("Skill table not loaded."));
    return;
  }
  // Player skills: 5-tuple per entry — `[type, current, base, ranks, training]`
  // (Rust src/lib.rs:16191). Pre-2026-05-29 the JS read index 3 as
  // `trained` and ignored index 4, so the diag character's skills (which
  // have ranks=0 + training=Untrained=1) all bucketed into Unusable.
  // ACE's `SkillAdvancementClass`: Inactive=0, Untrained=1, Trained=2,
  // Specialized=3 — matches the TRAINING enum in train-skills.js.
  const playerSkills = stats?.skills;
  const valueByLine = new Map();   // skillId → "cur/base"
  const stateByLine = new Map();
  if (playerSkills) {
    const len = playerSkills.length ?? 0;
    for (let i = 0; i + 4 < len; i += 5) {
      const id = tupleArrayAt(playerSkills, i);
      const cur = tupleArrayAt(playerSkills, i + 1);
      const base = tupleArrayAt(playerSkills, i + 2);
      const trained = tupleArrayAt(playerSkills, i + 4);
      valueByLine.set(id, base != null && cur != null ? `${base}` : "—");
      stateByLine.set(id, trained ?? 0);
    }
  }
  // Group by trained state — Specialized first, then Trained, then Untrained.
  const tiers = { 3: [], 2: [], 1: [], 0: [], 4: [] };
  for (const skill of skillTable.skills) {
    const idInt = skill.skillIdInt;
    const trained = stateByLine.get(idInt) ?? 1;
    (tiers[trained] || tiers[1]).push(skill);
  }
  const tierOrder = [
    { key: 3, label: "Specialized Skills" },
    { key: 2, label: "Trained Skills" },
    { key: 1, label: "Untrained Skills" },
    { key: 0, label: "Unusable" },
    { key: 4, label: "Unusable" },
  ];
  for (const t of tierOrder) {
    const items = tiers[t.key];
    if (!items || items.length === 0) continue;
    bodyEl.appendChild(section(t.label));
    for (const skill of items) {
      const iconUrl = `./data/ui-sprites/${skill.iconIdHex}.png`;
      const value = valueByLine.get(skill.skillIdInt) ?? "—";
      bodyEl.appendChild(row(iconUrl, skill.name, value));
    }
  }
}

// Top-30 entries of ACE's CharacterTitle enum (Source/ACE.Entity/Enum/
// CharacterTitle.cs). Used to label the current title and earned-list
// rows by name when the id is in range; falls back to "Title N" otherwise.
// Full enum has 1000+ entries — porting the whole thing would warrant
// a generated string table.
const TITLE_NAMES = {
  0: "Invalid",   1: "Adventurer",  2: "Archer",        3: "Blademaster",
  4: "Enchanter", 5: "LifeMage",    6: "Sorcerer",      7: "Vagabond",
  8: "Warrior",   9: "BowHunter",  10: "LifeCaster",   11: "Soldier",
  12: "Swashbuckler", 13: "WarMage", 14: "Wayfarer",   15: "AbhorrentWarrior",
  16: "Alchemist",17: "Annihilator",18: "Apothecary",  19: "ArcticAdventurer",
  20: "ArcticMattekarAnnihilator",  21: "Artifex",     22: "AxeWarrior",
  23: "Ballisteer",24: "BaneoftheRemoran",25: "BloodShrethButcher",
  26: "Bookbinder",27: "Brawler",   28: "ButcheroftheNorth",29: "Cabalist",
  30: "Carpenter",
};

// Title tab — uses the gmCharacterTitleUI 0x2100005E structured layout.
// Three header rows (display info / counts / column heading), 2
// separators, a scrollable list area, and a bottom action button.
//
// 2026-05-30 — wired to the real server snapshot via
// `__sessionHandle.playerTitle()` (TitleSnapshotJs at src/lib.rs:23960
// with `currentTitleId` + `titleIds` map). Refreshed on every recv-loop
// `kind=28 titleUpdated` drain.
function renderTitles(bodyEl, _stats, titleRefs) {
  bodyEl.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "hb-ci-titles";

  // Pull the snapshot once for this render. Wasm-bindgen exposes the two
  // fields as getters so the snapshot has to be live-read.
  let currentId = 0;
  const earnedIds = [];
  try {
    const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
    const snap = handle?.playerTitle?.();
    if (snap) {
      currentId = snap.currentTitleId >>> 0;
      const ids = snap.titleIds;
      if (ids && typeof ids === "object") {
        for (const k of Object.keys(ids)) {
          const v = (ids[k] >>> 0);
          if (v) earnedIds.push(v);
        }
      }
    }
  } catch (_) { /* pre-snapshot: render the empty-state */ }
  const currentName = TITLE_NAMES[currentId] || (currentId ? `Title ${currentId}` : "—");

  const header1 = document.createElement("div");
  header1.className = "hb-ci-titles-header";
  setAcText(header1, `Display Title: ${currentName}`, { color: "#f0d8a0" });
  wrap.appendChild(header1);

  const header2 = document.createElement("div");
  header2.className = "hb-ci-titles-header";
  setAcText(header2, `Earned: ${earnedIds.length}`, { color: "#f0d8a0" });
  wrap.appendChild(header2);

  const header3 = document.createElement("div");
  header3.className = "hb-ci-titles-header";
  setAcText(header3, "Title", { color: "#6acaca" });
  wrap.appendChild(header3);

  const sep1 = document.createElement("div");
  sep1.className = "hb-ci-titles-sep";
  sep1.dataset.sep = "1";
  wrap.appendChild(sep1);

  const sep2 = document.createElement("div");
  sep2.className = "hb-ci-titles-sep";
  sep2.dataset.sep = "2";
  wrap.appendChild(sep2);

  const list = document.createElement("div");
  list.className = "hb-ci-titles-list";
  if (earnedIds.length === 0) {
    const listEmpty = document.createElement("div");
    listEmpty.className = "hb-ci-titles-list-empty";
    setAcText(listEmpty, "No titles earned yet.", { color: "#a8a090" });
    list.appendChild(listEmpty);
  } else {
    // One row per earned title id, current title highlighted gold.
    for (const id of earnedIds.sort((a, b) => a - b)) {
      const r = document.createElement("div");
      r.className = "hb-ci-titles-row" + (id === currentId ? " current" : "");
      r.dataset.titleId = String(id);
      const name = TITLE_NAMES[id] || `Title ${id}`;
      setAcText(r, name, { color: id === currentId ? "#f0c87c" : "#f0d8a0" });
      list.appendChild(r);
    }
  }
  wrap.appendChild(list);

  // Invisible phantom for the layout-derived scrollbar geometry.
  const titleScrollbar = document.createElement("div");
  titleScrollbar.className = "hb-ci-scrollbar";
  wrap.appendChild(titleScrollbar);

  const bottomBtn = document.createElement("div");
  bottomBtn.className = "hb-ci-titles-bottom";
  setAcText(bottomBtn, "Set Display Title", { color: "#f0d8a0" });
  wrap.appendChild(bottomBtn);

  bodyEl.appendChild(wrap);

  // Stash refs back on titleRefs so applyCharacterInfoLayout can
  // populate the per-element positions.
  if (titleRefs) {
    titleRefs.headerEls = [header1, header2, header3];
    titleRefs.sepEls    = [sep1, sep2];
    titleRefs.listEl    = list;
    titleRefs.scrollbarEl = titleScrollbar;
    titleRefs.bottomBtnEl = bottomBtn;
  }
}

function section(text) {
  const el = document.createElement("div");
  el.className = "hb-ci-section";
  setAcText(el, text, { color: "#6acaca" });
  return el;
}
function emptyMsg(text) {
  const el = document.createElement("div");
  el.className = "hb-ci-empty";
  setAcText(el, text, { color: "#a8a090" });
  return el;
}
function row(iconUrl, name, value, raise) {
  const el = document.createElement("div");
  el.className = "hb-ci-row";
  const ic = document.createElement("div");
  ic.className = "hb-ci-icon";
  if (iconUrl) ic.style.backgroundImage = `url("${iconUrl}")`;
  el.appendChild(ic);
  const n = document.createElement("div");
  n.className = "hb-ci-name";
  setAcText(n, name, { color: "#f0d8a0" });
  el.appendChild(n);
  const v = document.createElement("div");
  v.className = "hb-ci-value";
  setAcText(v, String(value), { color: "#8aef6d" });
  el.appendChild(v);
  // 2026-05-30 — optional raise control. `raise` is
  // `{ cost: number, canAfford: boolean, isMax: boolean, onClick: fn }`.
  // gmStatManagementUI 0x2100002B element 0x10000210 — Normal sprite
  // 0x06001282, Pressed 0x06001283 + green/red eligibility dots
  // 0x06004D17 / 0x06004D19.
  if (raise) {
    const dot = document.createElement("div");
    dot.className = "hb-ci-dot";
    dot.style.backgroundImage = `url("./data/ui-sprites/${raise.canAfford ? "0x06004D17" : "0x06004D19"}.png")`;
    el.appendChild(dot);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hb-ci-raise";
    btn.disabled = raise.isMax || !raise.canAfford;
    btn.title = raise.isMax
      ? "Already at max rank"
      : raise.canAfford
        ? `Spend ${raise.cost} XP to raise this rank`
        : `Needs ${raise.cost} XP (you have ${raise.availableXp ?? 0})`;
    btn.style.backgroundImage = `url("./data/ui-sprites/0x06001282.png")`;
    btn.addEventListener("pointerdown", () => {
      btn.style.backgroundImage = `url("./data/ui-sprites/0x06001283.png")`;
    });
    btn.addEventListener("pointerup", () => {
      btn.style.backgroundImage = `url("./data/ui-sprites/0x06001282.png")`;
    });
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      try { raise.onClick?.(); } catch (e) { console.warn("[raise]", e); }
    });
    el.appendChild(btn);
  }
  return el;
}

export const view = {
  name: "Character",
  nameFor: (ctx) => {
    const stats = getStats();
    const tabLabel = ctx?.tab === "skills" ? "Skills"
                   : ctx?.tab === "titles" ? "Titles"
                   : "Attributes";
    return stats?.name ? `${stats.name} — ${tabLabel}` : tabLabel;
  },
  mount: (parentEl, ctx) => {
    ensureStyles();
    const root = document.createElement("div");
    root.className = "hb-ci-root";

    const tabsEl = document.createElement("div");
    tabsEl.className = "hb-ci-tabs";
    const tabBtns = {};
    const TABS = [
      { id: "attributes", label: "Attributes" },
      { id: "skills",     label: "Skills" },
      { id: "titles",     label: "Titles" },
    ];
    let activeTab = ctx?.tab || "skills";
    for (const t of TABS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hb-ci-tab" + (t.id === activeTab ? " active" : "");
      btn.dataset.tab = t.id;
      setAcText(btn, t.label, { color: t.id === activeTab ? "#f0c87c" : "#f0e8d0" });
      btn.addEventListener("click", () => setTab(t.id));
      tabsEl.appendChild(btn);
      tabBtns[t.id] = btn;
    }
    root.appendChild(tabsEl);

    const headEl = document.createElement("div");
    headEl.className = "hb-ci-head";
    root.appendChild(headEl);

    const bodyEl = document.createElement("div");
    bodyEl.className = "hb-ci-body";
    root.appendChild(bodyEl);

    // Invisible scrollbar geometry phantom — applyCharacterInfoLayout
    // writes the retail scrollbar dimensions here so the e2e verifier
    // can confirm placement without our DOM showing a double scrollbar.
    const scrollbarEl = document.createElement("div");
    scrollbarEl.className = "hb-ci-scrollbar";
    root.appendChild(scrollbarEl);

    const footerEl = document.createElement("div");
    footerEl.className = "hb-ci-footer";
    const footL = document.createElement("span");
    setAcText(footL, "—", { color: "#a8a090" });
    const footR = document.createElement("span");
    setAcText(footR, "", { color: "#a8a090" });
    footerEl.appendChild(footL);
    footerEl.appendChild(footR);
    root.appendChild(footerEl);

    parentEl.appendChild(root);

    // Apply retail layouts: parent panel anchors + Title-tab structured
    // rows. The view mounts via main-panel.showView which only fires
    // after wasm-ready, so no retry loop is required.
    const titleRefs = {};
    applyCharacterInfoLayout({
      rootEl: root,
      tabsEl,
      headEl,
      bodyEl,
      scrollbarEl,
      titleRefs,
    });

    let skillTable = null;
    function setTab(id) {
      activeTab = id;
      for (const k of Object.keys(tabBtns)) {
        const btn = tabBtns[k];
        btn.classList.toggle("active", k === id);
        setAcText(btn, btn.textContent || k, { color: k === id ? "#f0c87c" : "#f0e8d0" });
      }
      rerender();
    }
    function rerender() {
      const stats = getStats();
      renderHead(headEl, stats);
      switch (activeTab) {
        case "attributes": renderAttributes(bodyEl, stats, skillTable); break;
        case "skills":     renderSkills(bodyEl, stats, skillTable); break;
        case "titles":
          renderTitles(bodyEl, stats, titleRefs);
          // After Title-tab DOM lands, re-apply the structured layout
          // positions for its header rows / separators / list / button.
          applyCharacterInfoLayout({
            rootEl: root,
            tabsEl,
            headEl,
            bodyEl,
            scrollbarEl,
            titleRefs,
          });
          break;
      }
      // Footer: XP if available.
      const lv = stats?.levelInfo;
      setAcText(footL, lv ? `XP: ${tupleArrayAt(lv, 1) ?? 0}` : "—", { color: "#a8a090" });
      setAcText(footR, lv ? `Next: ${tupleArrayAt(lv, 2) ?? 0}` : "", { color: "#a8a090" });
    }

    // Load skill table + XP-rank tables, then render. Both async — the
    // initial rerender paints without raise costs; the .then() triggers
    // a second paint once tables resolve.
    loadSkillTable().then((st) => { skillTable = st; rerender(); });
    loadXpTables().then((t) => {
      if (t) { _xpTablesPromise._cached = t; rerender(); }
    });
    rerender();

    // Subscribe to player stats updates so live skill changes reflect.
    let off = null;
    const client = window.__pluginClient;
    if (client?.events?.on) {
      const onStats = () => rerender();
      client.events.on("playerStatsUpdated", onStats);
      off = () => { try { client.events.off("playerStatsUpdated", onStats); } catch (_) {} };
    }

    return () => {
      if (off) off();
      root.remove();
    };
  },
};
