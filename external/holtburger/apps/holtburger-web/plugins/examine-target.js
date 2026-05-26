// Examine view — mounts inside main-panel's body slot. Replaces the
// PR-S standalone floating popup (gmFloatyExaminationUI 0x2100006B).
//
// User direction 2026-05-22: examine and inventory share the same UI
// pane — clicking an inventory item OR examining a creature in the
// world transitions the same pane. main-panel owns the position +
// title + close; we render the examine content inside its body slot.
//
// Two trigger paths:
//   1. From inventory: inventory.js pushes view "examine" with ctx
//      { srcLi, guid, name, fromInventory: true }. We pull stats from
//      the source <li>'s dataset + window.__sessionHandle.playerInventory().
//   2. From world picking: the rAF tick polls
//      liveScene3d.entityManager.getSelectedTarget(); on
//      0 → non-zero, pushes view "examine" with ctx { guid, name?,
//      fromEntity: true }. EntityMap entry sourced for details.
//
// Real DAT sprites:
//   - 0x06004CFC : blue glowing orb (32x32) — examine icon at top-left.
//
// gmFloatyExaminationUI 0x2100006B — retail layout that drives the
// examine popup. Element-id map confirmed by examine_target_layout_dump
// 2026-05-24. Retail native size: 310×400 (popup) within 800×600 canvas;
// our embed shrinks to main-panel's body (300×337 — 25-px title bar of
// main-panel takes the place of retail's own 20-px title bar at y=5,
// so popup-relative offsets land cleanly inside the body slot).
//
// Native popup root (0x100005F2, 310×400 at 20,20) holds:
//   - 16 frame elements (0x10000673..0x10000682) — brass corners + edges
//   - 0x1000012D / 0x10000529 — title backdrop band (300×20 at 5,5)
//   - 0x10000528 — title separator (300×5 at 5,25)
//   - 0x100005F3 — close button (14×14 at 284,8, 2 states)
//   - Three alternative content panels (300×365 at 5,30):
//     * 0x1000012E — text-list pane (inscribed-text / journal style)
//     * 0x10000140 — armor/weapon detail pane (header + 3 stat rows +
//       scrollable description + footer)
//     * 0x10000153 — creature/identification pane (3 horizontal sections
//       + large icon + content area + bottom-centre icon)
//
// v1 fetch_layout limitation: geometry only. StateDesc/BaseProperty
// not serialized. We wire popup-frame geometry + header + content
// region + scrollbar; the per-row label/value semantics stay
// hand-tuned (driven by getItemByGuid / EntityMap, not by the layout).

import { setAcText } from "../ui/ac_font.js";
import { loadLayout, findElementById, getCachedLayout } from "../ui/ac_layout.js";

const EXAMINE_LAYOUT_ID = 0x2100006B;
// Retail popup root is 310x400 inside an 800x600 canvas. Our embed
// repurposes the body slot of main-panel (300x337) so popup-relative
// child offsets land inside the body. The retail 25-px title region
// (5+20) is consumed by main-panel's own 25-px title bar — we expose
// the entire main-panel body as if it were the popup's content frame
// (y=30 in popup-space) starting at y=0 in our parent's space.
// Reference-only: popup-space y=30 is where the pane content begins
// (main-panel's own title bar consumes the retail 25-px title region).
const EXAMINE_ELEMS = {
  popupRoot:    0x100005F2,  // outer popup frame (310x400)
  titleBand:    0x1000012D,  // header backdrop strip (300x20 at 5,5)
  titleSep:     0x10000528,  // title separator line (300x5 at 5,25)
  closeBtn:     0x100005F3,  // close button (14x14 at 284,8, 2 states)
  // Creature/identification pane (0x10000153 — 300x365 at popup 5,30):
  creaturePane:    0x10000153,  // outer pane wrapper
  creatureHeader:  0x1000015E,  // creature header (232x38 at 6,2)
  creatureIcon:    0x1000015F,  // 32x32 icon top-right (at 244,6)
  creatureSection1: 0x10000158,  // horizontal divider at y=42
  creatureSection2: 0x1000015A,  // horizontal divider at y=92
  creatureSection3: 0x1000015C,  // horizontal divider at y=268
  creatureRow1:    0x10000160,  // first property row (278x19 at 11,52)
  creatureRow2:    0x10000162,  // second property row (278x19 at 11,71)
  creatureBody:    0x10000163,  // main scrollable body (264x168 at 11,100)
  creatureScroll:  0x10000164,  // right-side scrollbar (16x171 at 284,99)
  creatureFooter:  0x10000165,  // footer status line (278x19 at 11,276)
  creatureBottomIcon: 0x1000032D, // centre bottom icon (32x32 at 134,298)
};

const VIEW_ID_STYLE = "hb-examine-view-style";

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = VIEW_ID_STYLE;
  style.textContent = `
    .hb-exa-root {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      box-sizing: border-box;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      overflow: hidden;
    }
    /* Creature-pane sections — applyExamineLayout reasserts retail
       offsets relative to .hb-exa-root. They're popup-relative offsets
       in the layout but we map them into our parent (main-panel body)
       by subtracting EXAMINE_POPUP_TITLE_Y so y=30 in popup-space
       lands at y=0 in our space. */
    .hb-exa-head {
      position: absolute;
      top: 6px;
      left: 8px;
      right: 8px;
      height: 44px;
      display: flex;
      align-items: center;
      gap: 8px;
      box-sizing: border-box;
    }
    .hb-exa-icon {
      position: absolute;
      width: 32px; height: 32px;
      background: url("./data/ui-sprites/0x06004CFC.png") center/contain no-repeat;
      filter: drop-shadow(0 0 4px rgba(80, 140, 255, 0.7));
      image-rendering: pixelated;
    }
    .hb-exa-namecol {
      display: flex;
      flex-direction: column;
      flex: 1;
      gap: 2px;
    }
    .hb-exa-name {
      font-size: 13px;
      color: var(--hb-text-gold);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.9);
      letter-spacing: 0.02em;
    }
    .hb-exa-guid {
      font-size: 9px;
      font-family: var(--hb-font-mono);
      color: var(--hb-text-muted);
    }
    .hb-exa-body {
      position: absolute;
      top: 56px;
      left: 8px;
      right: 8px;
      bottom: 8px;
      overflow-y: auto;
      padding: 4px;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--hb-border-brass-dim);
      box-sizing: border-box;
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.5);
    }
    /* Section divider rendered as a hairline along the retail 4-px
       separator's top edge. Layout 0x10000158/0x1000015A/0x1000015C
       drive position via applyExamineLayout. */
    .hb-exa-divider {
      position: absolute;
      left: 0;
      background: var(--hb-border-brass-dim);
      box-sizing: border-box;
      pointer-events: none;
    }
    .hb-exa-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 2px 4px;
      font-size: 10px;
      line-height: 14px;
      border-bottom: 1px solid rgba(138, 117, 68, 0.18);
      box-sizing: border-box;
    }
    /* applyExamineLayout-driven property rows above the body. Border-box
       so the layout's exact 278x19 lands without padding/border
       inflating getBoundingClientRect.height. */
    .hb-exa-row1, .hb-exa-row2 {
      box-sizing: border-box;
      overflow: hidden;
    }
    .hb-exa-row:last-child { border-bottom: none; }
    .hb-exa-label {
      color: var(--hb-text-cream);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-size: 9px;
    }
    .hb-exa-value {
      color: var(--hb-text-gold);
      text-align: right;
    }
    .hb-exa-section {
      font-size: 9px;
      color: var(--hb-text-cream-bright);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding: 4px 0 2px;
      margin-top: 4px;
      border-bottom: 1px solid var(--hb-border-brass-dim);
    }
    .hb-exa-insc-wrap { margin-top: 6px; }
    .hb-exa-insc-head {
      font-size: 9px;
      color: var(--hb-text-gold);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding: 2px 0;
    }
    .hb-exa-insc-body {
      background: #2a1f15;
      color: #f0e8d0;
      border: 1px solid var(--hb-border-brass-dim);
      font-family: var(--hb-font-serif);
      font-style: italic;
      font-size: 11px;
      line-height: 1.4;
      padding: 5px 7px;
      word-wrap: break-word;
      overflow-wrap: break-word;
      white-space: pre-wrap;
      max-height: 80px;
      overflow-y: auto;
    }
    .hb-exa-insc-btn {
      margin-top: 4px;
      background: transparent;
      border: 1px solid var(--hb-border-brass-dim);
      color: var(--hb-text-cream);
      font-family: inherit;
      font-size: 10px;
      padding: 3px 8px;
      cursor: pointer;
    }
    .hb-exa-insc-btn:hover {
      background: var(--hb-overlay-hover);
      border-color: var(--hb-border-brass);
      color: var(--hb-text-cream-bright);
    }
  `;
  document.head.appendChild(style);
}

// Apply retail gmFloatyExaminationUI 0x2100006B layout positions to
// the examine pane's sub-elements. The popup-relative coordinates in
// the LayoutDesc are translated into our parent's space by subtracting
// EXAMINE_POPUP_TITLE_Y (30px) so popup y=30 (content top) lands at
// our y=0. Pane lives inside main-panel's body which already strips
// the retail title-bar rows.
//
// Examine view is mounted via user-initiated pushView("examine") AFTER
// wasm is ready (inventory click / right-click world entity / debug
// stub), so no retry loop is needed.
function applyExamineLayout(refs) {
  const apply = (layout) => {
    if (!layout) return;
    const popup = findElementById(layout, EXAMINE_ELEMS.popupRoot);
    if (!popup) return;
    let applied = 0;
    // Per-element popup-relative descriptors translated by popup-title-y.
    const applyPopupChild = (id, el, opts = {}) => {
      if (!el) return false;
      const desc = findElementById(popup, id) || findElementById(layout, id);
      if (!desc) return false;
      el.style.right = "";
      el.style.bottom = "";
      el.style.transform = "none";
      const ox = opts.offsetX ?? 0;
      const oy = opts.offsetY ?? 0;
      if (typeof desc.x === "number") el.style.left = `${desc.x + ox}px`;
      if (typeof desc.y === "number") el.style.top = `${desc.y + oy}px`;
      if (typeof desc.width === "number") el.style.width = `${desc.width}px`;
      if (typeof desc.height === "number") el.style.height = `${desc.height}px`;
      applied += 1;
      return true;
    };
    // Creature-pane children land popup-relative; subtract the
    // EXAMINE_POPUP_TITLE_Y so y=30 (popup content origin) lands at
    // y=0 inside our root, and offset by the pane's own (5, 30) origin
    // because the layout records its children relative to the pane
    // itself, not the popup root. Net: subtract popup-title-y (30)
    // from popup-space y, leaving children at the layout's pane-
    // relative y. For the icon at popup (5+244, 5+30+6) = popup (249, 36)
    // we want screen (244, 6) relative to our pane's content.
    // The simplest mapping: take the *pane-child* coords directly as
    // our root-relative coords (since the pane itself is at popup
    // (5,30) and our root starts at popup (5,30) too).
    applyPopupChild(EXAMINE_ELEMS.creatureHeader, refs.headEl);
    applyPopupChild(EXAMINE_ELEMS.creatureIcon, refs.iconEl);
    applyPopupChild(EXAMINE_ELEMS.creatureBody, refs.bodyEl);
    applyPopupChild(EXAMINE_ELEMS.creatureRow1, refs.row1El);
    applyPopupChild(EXAMINE_ELEMS.creatureRow2, refs.row2El);
    applyPopupChild(EXAMINE_ELEMS.creatureFooter, refs.footerEl);
    // Section dividers — render as hairlines along the top edge of
    // each 4-px separator in the retail layout. Each gets explicit
    // height = 1px after the layout's y is applied (the layout's 4-px
    // separator height is its sprite gutter; we draw the actual rule
    // at its top edge for a crisper retail-AC line).
    const applyDivider = (id, el) => {
      if (!el) return;
      const desc = findElementById(popup, id) || findElementById(layout, id);
      if (!desc) return;
      el.style.right = "";
      el.style.bottom = "";
      if (typeof desc.x === "number") el.style.left = `${desc.x}px`;
      if (typeof desc.y === "number") el.style.top = `${desc.y}px`;
      if (typeof desc.width === "number") el.style.width = `${desc.width}px`;
      el.style.height = "1px";
      applied += 1;
    };
    applyDivider(EXAMINE_ELEMS.creatureSection1, refs.divider1El);
    applyDivider(EXAMINE_ELEMS.creatureSection2, refs.divider2El);
    applyDivider(EXAMINE_ELEMS.creatureSection3, refs.divider3El);
    try {
      window.__diag?.layout?.onExamineApplied?.({ applied });
    } catch (_) {}
  };
  const cached = getCachedLayout(EXAMINE_LAYOUT_ID);
  if (cached) { apply(cached); return; }
  loadLayout(EXAMINE_LAYOUT_ID).then(apply).catch(() => {});
}

// Type-bit → label (mirrors inventory.js TYPE_COLOR map).
const TYPE_LABEL = {
  "0x4":     "Weapon",
  "0x2":     "Armor",
  "0x10000": "Magic / Scroll",
  "0x20":    "Currency (pyreal)",
};

function r(parent, label, value) {
  if (value == null || value === "") return;
  const row = document.createElement("div");
  row.className = "hb-exa-row";
  const l = document.createElement("span");
  l.className = "hb-exa-label";
  setAcText(l, label);
  const v = document.createElement("span");
  v.className = "hb-exa-value";
  setAcText(v, String(value));
  row.appendChild(l);
  row.appendChild(v);
  parent.appendChild(row);
}
function section(parent, text) {
  const s = document.createElement("div");
  s.className = "hb-exa-section";
  setAcText(s, text);
  parent.appendChild(s);
}

function getItemByGuid(guid) {
  try {
    const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
    if (!handle?.playerInventory) return null;
    const items = handle.playerInventory();
    return items.find((it) => String(it.guid) === String(guid)) || null;
  } catch (_) { return null; }
}

// Data-source cascade for inscription on guid:
//   1. handle.playerBook() if its objectGuid matches — freshest data
//      pushed by ACE on BookDataResponse (kind=24 bookUpdated).
//   2. InventoryItem fields (none today — Rust struct lacks the field;
//      wasm getter follow-up needed before this branch can hit).
// Returns { text: string, ownedByPlayer: boolean } or null.
function getInscriptionForGuid(guid) {
  if (guid == null) return null;
  const g = (Number(guid) >>> 0);
  try {
    const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
    if (handle?.playerBook) {
      const book = handle.playerBook();
      if (book && (book.objectGuid >>> 0) === g && typeof book.inscription === "string") {
        const ownedByPlayer = !!getItemByGuid(g);
        return { text: book.inscription, ownedByPlayer };
      }
    }
  } catch (_) {}
  return null;
}

function renderInscription(wrapEl, guid) {
  if (!wrapEl) return;
  wrapEl.innerHTML = "";
  const info = getInscriptionForGuid(guid);
  if (!info) { wrapEl.style.display = "none"; return; }
  wrapEl.style.display = "";
  const head = document.createElement("div");
  head.className = "hb-exa-insc-head";
  setAcText(head, "Inscription");
  wrapEl.appendChild(head);
  const body = document.createElement("div");
  body.className = "hb-exa-insc-body";
  // Retail clamp at ~280 chars; ACE rejects longer payloads anyway.
  const trimmed = info.text.length > 280 ? info.text.slice(0, 280) : info.text;
  setAcText(body, trimmed.length > 0 ? trimmed : "(blank)");
  if (trimmed.length === 0) body.style.opacity = "0.6";
  wrapEl.appendChild(body);
  if (info.ownedByPlayer) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hb-exa-insc-btn";
    setAcText(btn, "Set Inscription");
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
      if (!handle?.setInscription) {
        console.warn("[examine] setInscription not available");
        return;
      }
      const next = window.prompt("New inscription:", info.text);
      if (next === null) return;
      try {
        handle.setInscription((guid >>> 0), next);
      } catch (e) {
        console.warn("[examine] setInscription failed:", e);
      }
    });
    wrapEl.appendChild(btn);
  }
}

function populateFromInventory(body, ctx, nameEl, guidEl) {
  const srcLi = ctx.srcLi;
  const guid = ctx.guid ?? srcLi?.dataset?.guid;
  const item = getItemByGuid(guid);
  const tb = srcLi?.dataset?.typeBit ?? "0x0";
  nameEl.textContent = srcLi?.querySelector?.(".name")?.textContent || item?.name || ctx.name || "(unnamed)";
  guidEl.textContent = guid != null
    ? `0x${(Number(guid) >>> 0).toString(16).toUpperCase().padStart(8, "0")}`
    : "";
  section(body, "Identity");
  r(body, "Kind", TYPE_LABEL[tb] || "Item");
  if (item) {
    if (item.stackSize > 1) r(body, "Stack", item.stackSize);
    if (item.value > 0) r(body, "Value", `${item.value} pyreals`);
    if (item.equipMask) r(body, "Equip mask", `0x${item.equipMask.toString(16).toUpperCase().padStart(8, "0")}`);
    if (item.burden != null) r(body, "Burden", item.burden);
    if (item.itemType != null) r(body, "Item type bits", `0x${item.itemType.toString(16)}`);
  }
  r(body, "GUID", guidEl.textContent);
}

function populateFromEntity(body, ctx, nameEl, guidEl) {
  const guid = (ctx.guid >>> 0) || 0;
  const em = window.liveScene3d?.entityManager;
  const ent = em?.entityMap?.get?.(guid) || em?.entityMap?.get?.(String(guid)) || null;
  nameEl.textContent = ent?.name || ctx.name || "(unnamed)";
  guidEl.textContent = `0x${guid.toString(16).toUpperCase().padStart(8, "0")}`;
  if (!ent) {
    section(body, "Status");
    r(body, "Loading", "—");
    return;
  }
  section(body, "Identity");
  if (ent.type != null) r(body, "Type", String(ent.type));
  if (ent.classId != null) r(body, "Class", `0x${ent.classId.toString(16)}`);
  if (ent.wcid != null) r(body, "Wcid", String(ent.wcid));
  if (ent.position) {
    section(body, "Position");
    const p = ent.position;
    r(body, "X", p.x?.toFixed?.(1) ?? p.x);
    r(body, "Y", p.y?.toFixed?.(1) ?? p.y);
    r(body, "Z", p.z?.toFixed?.(1) ?? p.z);
    if (ent.landblock != null) r(body, "Landblock", `0x${ent.landblock.toString(16).padStart(8, "0").toUpperCase()}`);
  }
  section(body, "Combat");
  if (ent.level != null) r(body, "Level", String(ent.level));
  if (ent.health != null) r(body, "Health", String(ent.health));
  if (ent.stamina != null) r(body, "Stamina", String(ent.stamina));
  if (ent.mana != null) r(body, "Mana", String(ent.mana));
  if (ent.motionState != null) {
    section(body, "Animation");
    r(body, "Motion", String(ent.motionState));
    if (ent.heading != null) r(body, "Heading", (ent.heading * 180 / Math.PI).toFixed(1) + "°");
  }
}

// View interface — registered with main-panel under id "examine".
export const view = {
  name: "Examine",
  nameFor: (ctx) => {
    if (ctx?.name) return `Examine: ${ctx.name}`;
    if (ctx?.srcLi) {
      const n = ctx.srcLi.querySelector(".name")?.textContent;
      if (n) return `Examine: ${n}`;
    }
    return "Examine";
  },
  mount: (parentEl, ctx) => {
    ensureStyles();
    const root = document.createElement("div");
    root.className = "hb-exa-root";

    // Head band — retail places the icon at (244, 6) (right side) and
    // the header text block at (6, 2) 232x38. applyExamineLayout
    // overrides these inline positions once the layout loads.
    const head = document.createElement("div");
    head.className = "hb-exa-head";
    const nameCol = document.createElement("div");
    nameCol.className = "hb-exa-namecol";
    const nameEl = document.createElement("div");
    nameEl.className = "hb-exa-name";
    nameEl.textContent = "—";
    const guidEl = document.createElement("div");
    guidEl.className = "hb-exa-guid";
    guidEl.textContent = "";
    nameCol.appendChild(nameEl);
    nameCol.appendChild(guidEl);
    head.appendChild(nameCol);
    root.appendChild(head);

    // Icon — separate from .hb-exa-head so applyExamineLayout can
    // position it independently per retail (244, 6) 32x32. CSS still
    // gives it a fallback position inside the head band for the
    // wasm-not-yet-loaded paint frame.
    const iconEl = document.createElement("div");
    iconEl.className = "hb-exa-icon";
    iconEl.style.right = "8px";
    iconEl.style.top = "6px";
    root.appendChild(iconEl);

    // Property rows above the main body — retail 0x10000160 (Row1) and
    // 0x10000162 (Row2) at popup-space (11, 52) / (11, 71) 278x19.
    // Optional summary lines — visibility:hidden when no content so the
    // layout rectangle is preserved (for retail-faithful chrome anatomy)
    // but no visual artifact appears.
    const row1El = document.createElement("div");
    row1El.className = "hb-exa-row hb-exa-row1";
    row1El.style.position = "absolute";
    row1El.style.left = "8px";
    row1El.style.right = "8px";
    row1El.style.visibility = "hidden";
    root.appendChild(row1El);
    const row2El = document.createElement("div");
    row2El.className = "hb-exa-row hb-exa-row2";
    row2El.style.position = "absolute";
    row2El.style.left = "8px";
    row2El.style.right = "8px";
    row2El.style.visibility = "hidden";
    root.appendChild(row2El);

    // Section dividers — three horizontal rules per retail at popup-
    // space y={42, 92, 268} 300x4. applyExamineLayout overrides.
    const divider1El = document.createElement("div");
    divider1El.className = "hb-exa-divider hb-exa-divider-1";
    divider1El.style.top = "44px";  // CSS fallback close to retail y=42
    root.appendChild(divider1El);
    const divider2El = document.createElement("div");
    divider2El.className = "hb-exa-divider hb-exa-divider-2";
    divider2El.style.top = "94px";  // CSS fallback close to retail y=92
    root.appendChild(divider2El);
    const divider3El = document.createElement("div");
    divider3El.className = "hb-exa-divider hb-exa-divider-3";
    divider3El.style.top = "270px";  // CSS fallback close to retail y=268
    root.appendChild(divider3El);

    const body = document.createElement("div");
    body.className = "hb-exa-body";
    root.appendChild(body);

    // Inscription section — appended at the tail of the scrollable
    // body. Hidden when no inscription is present for the examined guid.
    const inscWrap = document.createElement("div");
    inscWrap.className = "hb-exa-insc-wrap";
    inscWrap.style.display = "none";
    body.appendChild(inscWrap);

    // Footer status line — retail 0x10000165 (278x19 at popup 11,276).
    // We use it as an out-of-band "loading"/"action" line when present.
    // Hidden via visibility (not display) to preserve the layout rectangle.
    const footerEl = document.createElement("div");
    footerEl.className = "hb-exa-footer";
    footerEl.style.position = "absolute";
    footerEl.style.left = "8px";
    footerEl.style.right = "8px";
    footerEl.style.bottom = "8px";
    footerEl.style.height = "19px";
    footerEl.style.fontSize = "10px";
    footerEl.style.color = "var(--hb-text-muted)";
    footerEl.style.textAlign = "center";
    footerEl.style.boxSizing = "border-box";
    footerEl.style.visibility = "hidden";
    root.appendChild(footerEl);

    parentEl.appendChild(root);

    // Apply retail layout positions to the popup-frame anatomy. Body,
    // dividers, head, icon, optional summary rows + footer all pull
    // x/y/w/h from the LayoutDesc. The per-row label/value content
    // inside .hb-exa-body stays hand-tuned (v1 fetch_layout does not
    // serialize StateDesc/BaseProperty, so the labels themselves
    // aren't recoverable from the DAT yet).
    applyExamineLayout({
      headEl: head,
      iconEl,
      bodyEl: body,
      row1El,
      row2El,
      divider1El,
      divider2El,
      divider3El,
      footerEl,
    });

    const examineGuid = (ctx?.guid != null)
      ? (Number(ctx.guid) >>> 0)
      : ((ctx?.srcLi?.dataset?.guid != null)
          ? (Number(ctx.srcLi.dataset.guid) >>> 0)
          : null);

    if (ctx?.fromInventory) {
      populateFromInventory(body, ctx, nameEl, guidEl);
    } else {
      populateFromEntity(body, ctx ?? {}, nameEl, guidEl);
    }
    renderInscription(inscWrap, examineGuid);

    // Refresh inscription on bookUpdated (book panel pushes fresh
    // BookSnapshot here) and on playerInventoryChanged (ownership
    // gates the Set Inscription button).
    const pc = window.__pluginClient ?? null;
    const onRefresh = () => renderInscription(inscWrap, examineGuid);
    if (pc?.events?.on) {
      pc.events.on("bookUpdated", onRefresh);
      pc.events.on("playerInventoryChanged", onRefresh);
    }

    return () => {
      if (pc?.events?.off) {
        try { pc.events.off("bookUpdated", onRefresh); } catch (_) {}
        try { pc.events.off("playerInventoryChanged", onRefresh); } catch (_) {}
      }
      root.remove();
    };
  },
};

// Selection-poll module: watches getSelectedTarget() and pushes the
// examine view onto the main-panel stack on non-zero transitions
// (skipping inventory items, which are handled by inventory.js).
// Exported as a separate mount() so index.html can register it as
// an iconHidden bar slot — it has no DOM of its own; it only watches.
export const manifest = {
  id: "examine-target-watcher",
  name: "Examine watcher",
  icon: "🔍",
  iconHidden: true,
  version: "0.2.0",
  description: "rAF polls getSelectedTarget; pushes examine view to main-panel on world-target change",
};

export function mount(_ctx) {
  // No auto-pop on selection change — selection click is reserved for
  // select-to-interact (attack / use / vendor-open / etc.). Examine
  // fires only on explicit user action: window.__showExamineFor(guid),
  // inventory slot click, or (future) right-click context menu.
  // User regression 2026-05-22: "clicking on the vendor causes
  // examine, before it was the other command, which would let you
  // interact with things."

  // E key removed 2026-05-22 (collides with turn-right movement key).
  // Examine is now only triggered explicitly via
  // window.__showExamineFor(guid), inventory slot click, or right-click
  // (when wired). Keeping the debug helper for console testing.
  window.__showExamineFor = (guid) => window.__mainPanel?.pushView?.("examine", { guid: guid >>> 0 });

  return () => {
    delete window.__showExamineFor;
  };
}

// Debug helper: pop a synthetic examine target from DevTools / e2e
// verifier. Mirrors __vendorPluginDebug — drives the view through the
// main-panel stack even when wasm/__sessionHandle isn't fully wired
// (or when the entity-map doesn't yet have the synthetic GUID).
// Provides a synthetic EntityMap entry temporarily so populateFromEntity
// has something to render.
if (typeof window !== "undefined") {
  const DEBUG_SNAPSHOT = {
    guid: 0xCAFEBABE,
    name: "Cragstone Drudge (debug)",
    type: 16,           // Creature
    classId: 0x1F4E,
    wcid: 8023,
    level: 7,
    health: 84,
    stamina: 112,
    mana: 50,
    heading: 0.78,
    motionState: 0x00000001,
    position: { x: -14523.4, y: 0.0, z: 28310.8 },
    landblock: 0x8602FFFE,
  };
  const openDebug = (snapshot) => {
    const snap = { ...DEBUG_SNAPSHOT, ...(snapshot || {}) };
    const guid = (snap.guid >>> 0) || DEBUG_SNAPSHOT.guid;
    // Plant a synthetic entity in the EntityManager's map if available
    // so populateFromEntity has data to render. Skip if the live game
    // already has the GUID populated (don't clobber).
    const em = window.liveScene3d?.entityManager;
    if (em && em.entityMap && typeof em.entityMap.set === "function") {
      const existing = em.entityMap.get(guid) || em.entityMap.get(String(guid));
      if (!existing) {
        try { em.entityMap.set(guid, { ...snap, guid }); } catch (_) {}
      }
    }
    const ctx = { guid, name: snap.name, fromEntity: true };
    if (window.__mainPanel?.pushView) {
      window.__mainPanel.pushView("examine", ctx);
    } else if (window.__mainPanel?.showView) {
      window.__mainPanel.showView("examine", ctx);
    }
  };
  window.__examineTargetDebug = {
    open: openDebug,
    close: () => window.__mainPanel?.closeView?.(),
  };
}
