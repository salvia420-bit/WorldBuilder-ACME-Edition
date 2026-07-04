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
import { PaperdollViewport } from "../ui/ac_paperdoll_viewport.js";
import { resolveBindingIcon, resolveSpellIcon } from "../ui/ac_entity_icon.js";
import {
  uiEffectIconsEnabled,
  uiEffectIconsFor,
  uiEffectTintCss,
} from "../scene3d/vfx/ui_effects_registry.js";
import { fetchIconDataUrl } from "../ui/ac_icon_cache.js";

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
    /* Embedded PaperdollViewport (Wave 3.B) — renders the examined
       entity's rig with their current equipped armor + dye palette
       inside the scrollable body. Sits at the top of the body content
       stack before the Identity section. Transparent background lets
       the body's brass-bordered backdrop show through. */
    .hb-exa-paperdoll-wrap {
      position: relative;
      width: 100%;
      height: 180px;
      margin: 0 0 6px 0;
      background: linear-gradient(180deg, #2a2418, #1c160e 60%, #14110a);
      border: 1px solid var(--hb-border-brass-dim);
      box-sizing: border-box;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .hb-exa-paperdoll-wrap canvas {
      display: block;
      pointer-events: none;
    }
    .hb-exa-paperdoll-empty {
      font-size: 10px;
      color: var(--hb-text-muted);
      font-style: italic;
      padding: 8px;
      text-align: center;
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

// ACE.Entity.Enum.Skill order (Skill.cs) — index = wire skill id. Used to
// label WeaponProfile.weapon_skill (retail ItemExamineUI weapon-skill row).
const SKILL_NAMES = [
  "None", "Axe", "Bow", "Crossbow", "Dagger", "Mace", "Melee Defense",
  "Missile Defense", "Sling", "Spear", "Staff", "Sword", "Thrown Weapon",
  "Unarmed Combat", "Arcane Lore", "Magic Defense", "Mana Conversion",
  "Spellcraft", "Item Tinkering", "Assess Person", "Deception", "Healing",
  "Jump", "Lockpick", "Run", "Awareness", "Arms and Armor Repair",
  "Assess Creature", "Weapon Tinkering", "Armor Tinkering",
  "Magic Item Tinkering", "Creature Enchantment", "Item Enchantment",
  "Life Magic", "War Magic", "Leadership", "Loyalty", "Fletching",
  "Alchemy", "Cooking", "Salvaging", "Two Handed Combat", "Gearcraft",
  "Void Magic", "Heavy Weapons", "Light Weapons", "Finesse Weapons",
  "Missile Weapons", "Shield", "Dual Wield", "Recklessness",
  "Sneak Attack", "Dirty Fighting", "Challenge", "Summoning",
];
function skillName(id) {
  const n = Number(id);
  return SKILL_NAMES[n] || `Skill ${n}`;
}

// ACE.Entity.Enum.DamageType (DamageType.cs) — bitflags; WeaponProfile.
// damage_type carries the weapon's dealt-damage type(s). Join set bits
// (retail weapons are almost always single-bit, but render faithfully).
const DAMAGE_TYPE_BITS = [
  [0x1, "Slash"], [0x2, "Pierce"], [0x4, "Bludgeon"], [0x8, "Cold"],
  [0x10, "Fire"], [0x20, "Acid"], [0x40, "Electric"], [0x400, "Nether"],
];
function damageTypeLabel(mask) {
  const m = (Number(mask) >>> 0);
  if (!m) return null;
  const names = DAMAGE_TYPE_BITS.filter(([bit]) => (m & bit) !== 0).map(([, n]) => n);
  return names.length > 0 ? names.join(" / ") : null;
}

// Body-location labels for ArmorLevels (per-slot armor level breakdown).
// Order mirrors the wire struct (types.rs ArmorLevels) — retail's
// ItemExamineUI armor-level table lists head→foot.
const ARMOR_LEVEL_SLOTS = [
  ["head", "Head"], ["chest", "Chest"], ["abdomen", "Abdomen"],
  ["upper_arm", "Upper Arm"], ["lower_arm", "Lower Arm"], ["hand", "Hand"],
  ["upper_leg", "Upper Leg"], ["lower_leg", "Lower Leg"], ["foot", "Foot"],
];

// Sync spell-name lookup mirroring plugins/spellbook.js's wasm-Map
// normalization (getSpellRecord crosses the wasm boundary as a JS Map —
// `.name` on the raw object silently returns undefined, per the 2026-07-01
// fix in that file). Small local cache avoids re-crossing the boundary
// every render.
const _spellNameCache = new Map();
function getSpellName(spellId) {
  const id = spellId >>> 0;
  if (_spellNameCache.has(id)) return _spellNameCache.get(id);
  let name = null;
  try {
    const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
    let rec = handle?.getSpellRecord?.(id);
    if (rec instanceof Map) rec = Object.fromEntries(rec);
    if (rec && typeof rec.name === "string") name = rec.name;
  } catch (_) { /* pre-SpellTable-load — retry next render */ }
  if (name) _spellNameCache.set(id, name);
  return name;
}

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
//   2. handle.getObjectInscription(guid) — covers items/weapons/scrolls
//      via the holtburger-world assessment cache populated on
//      EntityIdentified (Assess/Identify response).
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
    if (handle?.getObjectInscription) {
      const text = handle.getObjectInscription(g);
      if (typeof text === "string") {
        const ownedByPlayer = !!getItemByGuid(g);
        return { text, ownedByPlayer };
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
  // P2-44 (cross-find EX-06): Set-Inscription button dropped. Retail
  // examine is read-only; the user sets inscriptions via the
  // dedicated UI command path (chat /si or item context menu), not
  // a window.prompt() embedded in the examine popup. Inscription
  // text remains displayed for read.
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

// Wave 3.B (2026-05-28) — render the examined entity's full rig
// (with their current equipped gear + dye palette) into the supplied
// wrapper element. Reuses the same PaperdollViewport that
// `plugins/inventory.js` mounts for the player's own paperdoll
// (`refreshPaperdollViewport` at inventory.js:1389). For the examined
// entity, we source `setupId / mtableId / paletteId / subPalettes`
// from `entityMap.get(guid).meta` — populated by the spawn-time
// `ObjectCreate` / `EntityUpdate` wire flow (see
// `entities.js:_applyAppearanceHotSwap` for the contract).
//
// Returns the PaperdollViewport instance (caller disposes on unmount)
// or null when the entity is missing / has no usable setupId. The
// wrapper element is mutated in-place: on success, the viewport canvas
// is appended; on failure, an "(no preview available)" sentinel is
// rendered instead.
//
// Visibility note: NPCs + remote players ALWAYS have their visible
// armor in `meta.subPalettes` + `meta.modelChanges` /
// `meta.textureChanges` (the server sends ObjectDescription on every
// PVS-enter so the entity can render at all). Hidden / inventory-only
// slots are excluded from the wire packet by retail design, so the
// preview matches what's on-screen — no extra slots missing vs. the
// nameplate visible rendering.
function renderEntityPaperdoll(wrapEl, guid) {
  if (!wrapEl) return null;
  wrapEl.innerHTML = "";
  const g = (Number(guid) >>> 0);
  if (!g) {
    const note = document.createElement("div");
    note.className = "hb-exa-paperdoll-empty";
    setAcText(note, "(no entity selected)");
    wrapEl.appendChild(note);
    return null;
  }
  const em = window.liveScene3d?.entityManager;
  const inst = em?.entityMap?.get?.(g) || em?.entityMap?.get?.(String(g)) || null;
  const meta = inst?.meta;
  const setupId = (meta?.modelId ?? meta?.setupId ?? 0) >>> 0;
  if (!meta || setupId === 0) {
    const note = document.createElement("div");
    note.className = "hb-exa-paperdoll-empty";
    setAcText(note, meta
      ? "(no model id — preview unavailable)"
      : "(entity not in PVS — no preview)");
    wrapEl.appendChild(note);
    return null;
  }
  // Rec #55 — retail ItemExamineUI uses gm3DItemsUI for items and the
  // creature-paperdoll only for creatures/NPCs/players. Mirror that
  // here: skip the paperdoll mount when the target's ItemType is
  // populated AND the IT_CREATURE bit (0x10) is clear. ItemType not
  // set yet = pre-spawn snapshot; fall through to keep the existing
  // "preview" behaviour for those (rarely observed but the safer
  // default — wrong paperdoll < no paperdoll for an unknown class).
  const ITEM_TYPE_CREATURE = 0x00000010;
  const itemType = (meta.itemType >>> 0) || 0;
  if (itemType !== 0 && (itemType & ITEM_TYPE_CREATURE) === 0) {
    const note = document.createElement("div");
    note.className = "hb-exa-paperdoll-empty";
    setAcText(note, "(item — no paperdoll)");
    wrapEl.appendChild(note);
    return null;
  }
  // Match the inventory paperdoll dimensions so the viewport reads
  // consistently across panels. Width clamped to the body slot's
  // ~284px usable interior (300 minus left/right body padding).
  const viewport = new PaperdollViewport({ width: 224, height: 178 });
  wrapEl.appendChild(viewport.dom);
  // Pull the examined entity's wielded items and thread them into
  // loadPlayer so the examine popover shows held weapons (not just
  // armor). Same wasm + meta-source contract as the local player path
  // in plugins/inventory.js::refreshPaperdollViewport.
  const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
  let wieldedItems = [];
  if (handle && typeof handle.entityWieldedItems === "function") {
    try {
      const raw = handle.entityWieldedItems(g) || [];
      for (const w of raw) {
        if (((w.equipMask >>> 0) & 0x3700000) === 0) continue;
        const childInst = em?.entityMap?.get?.(w.guid >>> 0);
        if (!childInst?.meta) continue;
        wieldedItems.push({
          itemGuid: w.guid >>> 0,
          parentLocation: (typeof w.parentLocation === "number")
            ? (w.parentLocation >>> 0) : 0,
          placement: (typeof w.placement === "number")
            ? (w.placement >>> 0) : 0,
          meta: childInst.meta,
        });
      }
    } catch (_) { wieldedItems = []; }
  }
  const stanceLow = 0; // examined entity's stance is not surfaced; 0 = idle pose
  viewport.loadPlayer(
    setupId,
    (meta.mtableId ?? 0) >>> 0,
    (meta.paletteId ?? 0) >>> 0,
    meta.subPalettes ?? new Uint32Array(0),
    wieldedItems,
    stanceLow,
  ).catch(() => { /* loadPlayer logs internally on failure */ });
  try {
    window.__diag?.examine?.onPaperdollMounted?.({
      guid: g, setupId, mtableId: (meta.mtableId ?? 0) >>> 0,
      paletteId: (meta.paletteId ?? 0) >>> 0,
      subPaletteTriples: ((meta.subPalettes?.length ?? 0) / 3) | 0,
    });
  } catch (_) {}
  return viewport;
}

function populateFromEntity(body, ctx, nameEl, guidEl) {
  const guid = (ctx.guid >>> 0) || 0;
  const em = window.liveScene3d?.entityManager;
  const ent = em?.entityMap?.get?.(guid) || em?.entityMap?.get?.(String(guid)) || null;
  // === Wave 6 polish — examine meta-vs-flat read (2026-05-28) ===
  // Real `EntityInstance` objects (entities.js:798) store their
  // wire-supplied fields (type/level/health/etc.) under `inst.meta` —
  // the spawn meta dict built by `toMeta(upd)` in scene3d/loop.js. The
  // debug stub at `__examineTargetDebug.open` (line 826) flattens
  // those onto the root for testability, hence the pre-fix accessors
  // worked in dev but rendered an empty Combat + Position section for
  // every live NPC. Read meta-first, fall back to flat for the debug
  // stub. See Wave 3.B handoff for the original bug surface.
  const meta = ent?.meta || null;
  const v = (key) => meta?.[key] ?? ent?.[key];
  const entName = ent?.name ?? meta?.name;
  // No-target empty state: blank the identity strip and show a friendly
  // prompt instead of "(unnamed) 0x00000000" — the panel often opens via
  // the target-bar Examine button when nothing is selected.
  if (!guid) {
    nameEl.textContent = "—";
    guidEl.textContent = "";
    section(body, "Status");
    r(body, "Selection", "Click an entity or item to examine");
    return;
  }
  nameEl.textContent = entName || ctx.name || "(unnamed)";
  guidEl.textContent = `0x${guid.toString(16).toUpperCase().padStart(8, "0")}`;
  if (!ent) {
    section(body, "Status");
    r(body, "Loading", "—");
    return;
  }
  section(body, "Identity");
  const type_ = v("type");
  const classId = v("classId");
  const wcid = v("wcid");
  // HUD rec #52 (2026-06-16) — player vs creature dispatch via
  // `ObjectDescriptionFlag::PLAYER` (0x08). Replaces the CharExamineUI
  // branch in retail's gmExamineUI::SetTargetGuid. PLAYER_KILLER
  // (0x20) marks PK status — surfaced as an Identity row when set so
  // the examiner sees the same UI affordance retail's nameplate
  // showed via the red "Player Killer" tag.
  const objDescFlags = (v("objDescFlags") ?? 0) >>> 0;
  const isPlayer = (objDescFlags & 0x08) !== 0;
  const isPlayerKiller = (objDescFlags & 0x20) !== 0;
  if (isPlayer) {
    r(body, "Type", "Player");
  } else if (type_ != null) {
    r(body, "Type", String(type_));
  }
  if (classId != null) r(body, "Class", `0x${classId.toString(16)}`);
  if (wcid != null) r(body, "Wcid", String(wcid));
  if (isPlayer && isPlayerKiller) {
    r(body, "PK Status", "Player Killer");
  }
  if (isPlayer) {
    // Heritage / Profession / Allegiance arrive through the
    // AppraisalProfile (`handle.getObjectAppraisal(guid)`) when ACE
    // includes them on Identify. Read what's present and render the
    // labels retail's CharExamineUI did; absent fields skip silently
    // (server may not surface them for remote players).
    try {
      const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
      const json = handle?.getObjectAppraisal?.(guid >>> 0);
      if (typeof json === "string" && json.length > 0) {
        const snapshot = JSON.parse(json);
        const props = snapshot.properties || {};
        const ints = props.ints || {};
        const strings = props.strings || {};
        const heritage = ints.HeritageGroup;
        if (heritage != null) r(body, "Heritage", String(heritage));
        const title = strings.Title || strings.CharacterTitle;
        if (title) r(body, "Profession", String(title));
        const allegianceName = strings.AllegianceName
          ?? strings.MonarchsName
          ?? strings.PatronsName;
        if (allegianceName) r(body, "Allegiance", String(allegianceName));
      }
    } catch (_) { /* leave the player-specific rows empty on failure */ }
  }
  const position = v("position");
  const landblock = v("landblock");
  if (position) {
    section(body, "Position");
    const p = position;
    r(body, "X", p.x?.toFixed?.(1) ?? p.x);
    r(body, "Y", p.y?.toFixed?.(1) ?? p.y);
    r(body, "Z", p.z?.toFixed?.(1) ?? p.z);
    if (landblock != null) r(body, "Landblock", `0x${landblock.toString(16).padStart(8, "0").toUpperCase()}`);
  }
  section(body, "Combat");
  const level = v("level");
  const health = v("health");
  const stamina = v("stamina");
  const mana = v("mana");
  if (level != null) r(body, "Level", String(level));
  if (health != null) r(body, "Health", String(health));
  if (stamina != null) r(body, "Stamina", String(stamina));
  if (mana != null) r(body, "Mana", String(mana));
  const motionState = v("motionState");
  const heading = v("heading");
  if (motionState != null) {
    section(body, "Animation");
    r(body, "Motion", String(motionState));
    if (heading != null) r(body, "Heading", (heading * 180 / Math.PI).toFixed(1) + "°");
  }
}

// Element-id map + layout id for callers that need to position chrome
// around the examine body in a standalone floaty.
export const EXAMINE_LAYOUT = {
  layoutId: EXAMINE_LAYOUT_ID,
  elements: EXAMINE_ELEMS,
};

// EX-05 (2026-06-05) — render the AppraisalProfile snapshot returned
// by `getObjectAppraisal(guid)` (wasm-side) into `wrapEl`. JSON-parses
// the snapshot and lays out three sections:
//   • Attributes — CreatureProfile.attributes (Str/End/Coord/Quick/
//     Focus/Self) + Health/Stamina/Mana via WorldObjectProperties.ints
//   • Skills — CreatureProfile.skills (per-skill base/current/buffed
//     mapping). The exact wire shape is preserved verbatim; UI just
//     formats each entry.
//   • Effects — armor/weapon/resist enchantment bitfields surfaced as
//     hex chips; spell-book GUIDs printed as a short list.
//
// Wraps inside `wrapEl.innerHTML = ""` for re-render-on-event. Hidden
// (display:none) when no appraisal has landed yet for this GUID.
function renderAppraisal(wrapEl, guid) {
  if (!wrapEl) return;
  wrapEl.innerHTML = "";
  if (!guid) { wrapEl.style.display = "none"; return; }
  let snapshot = null;
  try {
    const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
    if (handle?.getObjectAppraisal) {
      const json = handle.getObjectAppraisal(guid >>> 0);
      if (typeof json === "string" && json.length > 0) {
        snapshot = JSON.parse(json);
      }
    }
  } catch (_) {}
  if (!snapshot) { wrapEl.style.display = "none"; return; }
  wrapEl.style.display = "";

  // HUD rec #53 (2026-06-16) — IdentifyResponse-level gating.
  // identifySuccess=false means ACE rolled an Identify check the
  // player's skill failed (Player_Skills.cs HandleIdentifyResponse).
  // Render the AC failure line instead of the (potentially stale)
  // appraisal sections. identifyFlags is the IdentifyResponseFlags
  // bitmask — only render sections whose bit is set so we don't show
  // stale data from a prior identify of a different target type.
  // Snapshots NOT produced by an Identify (e.g. ViewContents on
  // vendor items) default `identifySuccess=true` + flags=0 in wasm —
  // which falls through to legacy behaviour (render everything).
  const identifySuccess = snapshot.identifySuccess !== false;
  const identifyFlags = (snapshot.identifyFlags ?? 0) >>> 0;
  const gated = identifyFlags !== 0; // 0 = "no Identify round-trip yet", render all
  const flagBit = (mask) => !gated || (identifyFlags & mask) !== 0;
  const IDENTIFY_FLAG_WEAPON_PROFILE   = 0x0020;
  const IDENTIFY_FLAG_HOOK_PROFILE     = 0x0040;
  const IDENTIFY_FLAG_ARMOR_PROFILE    = 0x0080;
  const IDENTIFY_FLAG_CREATURE_PROFILE = 0x0100;
  const IDENTIFY_FLAG_ARMOR_ENCH       = 0x0200;
  const IDENTIFY_FLAG_RESIST_ENCH      = 0x0400;
  const IDENTIFY_FLAG_WEAPON_ENCH      = 0x0800;
  const IDENTIFY_FLAG_SPELL_BOOK       = 0x0010;
  const IDENTIFY_FLAG_ARMOR_LEVELS     = 0x4000;
  if (!identifySuccess) {
    const fail = document.createElement("div");
    fail.className = "hb-exa-fail";
    setAcText(fail, "Your skill is not high enough to identify this item.");
    wrapEl.appendChild(fail);
    return;
  }

  // Helper: emit a "section header" + key/value rows table inside
  // wrapEl, like populate*'s `section()`/`r()` but scoped to wrapEl.
  const sec = (text) => {
    const s = document.createElement("div");
    s.className = "hb-exa-section";
    setAcText(s, text);
    wrapEl.appendChild(s);
  };
  const row = (label, value) => {
    if (value == null || value === "") return;
    const r = document.createElement("div");
    r.className = "hb-exa-row";
    const l = document.createElement("span");
    l.className = "hb-exa-label";
    setAcText(l, label);
    const v = document.createElement("span");
    v.className = "hb-exa-value";
    setAcText(v, String(value));
    r.appendChild(l);
    r.appendChild(v);
    wrapEl.appendChild(r);
  };

  const props = snapshot.properties || {};
  const ints = props.ints || {};
  const floats = props.floats || {};
  const strings = props.strings || {};
  const cp = snapshot.creatureProfile || null;
  const ap = snapshot.armorProfile || null;
  const wp = snapshot.weaponProfile || null;
  const hp = snapshot.hookProfile || null;
  const al = snapshot.armorLevels || null;

  // === UiEffects magic-effect badges (Track A A0, 2026-06-24) ===
  // `?uiEffectIcons` (default OFF) — render the item's UiEffects (PropertyInt
  // 18) as colored badge(s). UiEffects is a 2D icon overlay in retail
  // (acclient IconData::RenderIcons), so this lives in the DOM/HUD layer and
  // never touches the WebGL canvas. A0 uses the registry TINT; resolving the
  // real `*_UIEffectImage` icon (EnumIDMap 0x25000009) is A1. The appraisal
  // serializer may key ints by name or number — accept both. Flag-off =
  // byte-identical (block never runs).
  if (uiEffectIconsEnabled()) {
    const uiEffectsMask = ((ints.UiEffects ?? ints["18"] ?? 0) >>> 0);
    const fx = uiEffectIconsFor(uiEffectsMask);
    if (fx.length) {
      sec("Magic Effects");
      const badges = document.createElement("div");
      badges.className = "hb-exa-uifx";
      badges.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;margin:2px 0;";
      for (const f of fx) {
        const b = document.createElement("span");
        b.className = "hb-exa-uifx-badge";
        b.style.cssText =
          "display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:7px;" +
          `font-size:11px;color:#111;background:${uiEffectTintCss(f.tint)};`;
        b.title = f.name;
        // real *_UIEffectImage icon (0x06 DID via the 0x25000009 map); tint pill
        // is the fallback while it fetches / if it fails.
        const ic = document.createElement("span");
        ic.style.cssText = "width:14px;height:14px;display:inline-block;background:center/contain no-repeat;";
        b.appendChild(ic);
        const txt = document.createElement("span");
        setAcText(txt, f.name);
        b.appendChild(txt);
        badges.appendChild(b);
        if (f.iconDid) {
          fetchIconDataUrl(f.iconDid >>> 0).then((url) => {
            if (url && ic.isConnected) ic.style.background = `url("${url}") center/contain no-repeat`;
          }).catch(() => {});
        }
      }
      wrapEl.appendChild(badges);
    }
  }

  // === Attributes ===
  // HUD rec #53: only render the Creature-Profile-derived attributes
  // section when the wire identify included CREATURE_PROFILE (0x0100).
  // Without the gate a successful armor identify would leak stale
  // attribute numbers from a prior creature identify.
  //
  // Field-name fix (2026-07-04): CreatureProfile (types.rs) has no
  // `vitals` sub-object — health/health_max are top-level on the
  // profile itself, and stamina/mana (+ their maxes) live nested under
  // `attributes`, not a separate vitals struct. The prior `cp?.vitals`
  // read always missed, so Health/Stamina/Mana silently fell back to
  // (usually absent) top-level `ints.Max*` — this block effectively
  // never rendered vitals for a creature identify.
  if (flagBit(IDENTIFY_FLAG_CREATURE_PROFILE)
      && (cp?.attributes || cp?.health != null || ints.Strength != null
        || ints.Endurance != null || ints.Coordination != null
        || ints.Quickness != null || ints.Focus != null || ints.Self != null)) {
    sec("Attributes");
    const a = cp?.attributes || {};
    row("Strength",     a.strength     ?? ints.Strength);
    row("Endurance",    a.endurance    ?? ints.Endurance);
    row("Coordination", a.coordination ?? ints.Coordination);
    row("Quickness",    a.quickness    ?? ints.Quickness);
    row("Focus",        a.focus        ?? ints.Focus);
    row("Self",         a.self_        ?? a.self ?? ints.Self);
    row("Health",       cp?.health_max != null ? `${cp.health}/${cp.health_max}` : (cp?.health ?? ints.MaxHealth));
    row("Stamina",      a.stamina_max != null ? `${a.stamina}/${a.stamina_max}` : (a.stamina ?? ints.MaxStamina));
    row("Mana",         a.mana_max != null ? `${a.mana}/${a.mana_max}` : (a.mana ?? ints.MaxMana));
  }

  // === Skills ===
  // Skipped (data-blocked, 2026-07-04): CreatureProfile (types.rs:100)
  // carries no `skills` field at all on the wire — only
  // flags/health/health_max/attributes/buffs. The prior code read
  // `cp.skills` as an object map, which never existed, so this section
  // was permanently dead. There is no per-skill AppraisalProfile data
  // to render until the wasm/protocol side adds a SkillProfile — see
  // `crates/holtburger-protocol/src/messages/object/types.rs` if that
  // lands later.

  // === Equipment / Item profile ===
  // HUD rec #53: each profile sub-section gated by its own
  // IdentifyResponseFlags bit. ARMOR_LEVELS is a separate wire flag
  // from ARMOR_PROFILE (per IdentifyResponseFlags 0x0080 vs 0x4000),
  // so a body-armor identify that only sent ARMOR_PROFILE won't leak
  // chest/head/foot levels from a stale armor-levels payload.
  //
  // Field-name fix (2026-07-04): the real wire ArmorProfile (types.rs:38)
  // has no armor_level/physical_mod/acid_mod/fire_mod/cold_mod/
  // electric_mod fields — it carries per-damage-type multipliers keyed
  // `slashing/piercing/bludgeoning/cold/fire/acid/nether/lightning`.
  // The overall Armor Level (a single number) is a WorldObjectProperties
  // int (`ints.ArmorLevel`, PropertyInt.ArmorLevel=28), not part of
  // ArmorProfile at all. Every `ap.*` read below was hitting undefined
  // keys, so the whole Item/armor block was silently empty before this
  // fix despite the data being present on the wire.
  const showArmor = flagBit(IDENTIFY_FLAG_ARMOR_PROFILE) && ap;
  const showWeapon = flagBit(IDENTIFY_FLAG_WEAPON_PROFILE) && wp;
  const showHook = flagBit(IDENTIFY_FLAG_HOOK_PROFILE) && hp;
  const showArmorLevels = flagBit(IDENTIFY_FLAG_ARMOR_LEVELS) && al;
  const showArmorLevelInt = flagBit(IDENTIFY_FLAG_ARMOR_PROFILE) && ints.ArmorLevel != null;
  if (showArmor || showWeapon || showHook || showArmorLevels || showArmorLevelInt) {
    sec("Item");
    if (showArmorLevelInt) row("Armor Level", ints.ArmorLevel);
    if (showArmor && ap.slashing != null)    row("Slash Mod",    Number(ap.slashing).toFixed(2));
    if (showArmor && ap.piercing != null)    row("Pierce Mod",   Number(ap.piercing).toFixed(2));
    if (showArmor && ap.bludgeoning != null) row("Bludgeon Mod", Number(ap.bludgeoning).toFixed(2));
    if (showArmor && ap.cold != null)         row("Cold Mod",     Number(ap.cold).toFixed(2));
    if (showArmor && ap.fire != null)         row("Fire Mod",     Number(ap.fire).toFixed(2));
    if (showArmor && ap.acid != null)         row("Acid Mod",     Number(ap.acid).toFixed(2));
    if (showArmor && ap.nether != null)       row("Nether Mod",   Number(ap.nether).toFixed(2));
    if (showArmor && ap.lightning != null)    row("Electric Mod", Number(ap.lightning).toFixed(2));
    // Weapon block — retail ItemExamineUI weapon row order: damage type,
    // damage (+variance/mod), speed, skill.
    if (showWeapon && damageTypeLabel(wp.damage_type)) row("Damage Type", damageTypeLabel(wp.damage_type));
    if (showWeapon && wp.damage != null)       row("Damage",       wp.damage);
    if (showWeapon && wp.damage_variance != null) row("Variance",  Number(wp.damage_variance).toFixed(2));
    if (showWeapon && wp.damage_mod != null)   row("Damage Mod",   Number(wp.damage_mod).toFixed(2));
    if (showWeapon && wp.weapon_time != null)  row("Weapon Speed", wp.weapon_time);
    if (showWeapon && wp.weapon_skill != null) row("Weapon Skill", skillName(wp.weapon_skill));
    // Per-slot armor-level breakdown (types.rs ArmorLevels — 9 body
    // locations). Only render slots the wire actually populated.
    if (showArmorLevels) {
      for (const [key, label] of ARMOR_LEVEL_SLOTS) {
        if (al[key] != null) row(label + " Armor", al[key]);
      }
    }
    if (showHook && hp.hook_type != null)    row("Hook Type",    hp.hook_type);
  }

  // === Effects: enchantment bitfields + spell-book ===
  // HUD rec #53: each enchantment bitfield is its own wire flag
  // (ARMOR=0x0200, WEAPON=0x0800, RESIST=0x0400). Spell-book gated by
  // SPELL_BOOK (0x0010). Gating prevents a fresh skill-fail wipe from
  // showing stale enchantment / spell numbers from the prior identify.
  const ah = flagBit(IDENTIFY_FLAG_ARMOR_ENCH) ? snapshot.armorHighlight : null;
  const ac = flagBit(IDENTIFY_FLAG_ARMOR_ENCH) ? snapshot.armorColor : null;
  const wh = flagBit(IDENTIFY_FLAG_WEAPON_ENCH) ? snapshot.weaponHighlight : null;
  const wc = flagBit(IDENTIFY_FLAG_WEAPON_ENCH) ? snapshot.weaponColor : null;
  const rh = flagBit(IDENTIFY_FLAG_RESIST_ENCH) ? snapshot.resistHighlight : null;
  const rc = flagBit(IDENTIFY_FLAG_RESIST_ENCH) ? snapshot.resistColor : null;
  const sb = flagBit(IDENTIFY_FLAG_SPELL_BOOK) && Array.isArray(snapshot.spellBook)
    ? snapshot.spellBook : [];
  if (ah != null || wh != null || rh != null || sb.length > 0) {
    sec("Effects");
    const hex = (n) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(4, "0")}`;
    if (ah != null) row("Armor Ench.",  `${hex(ah)} / color ${hex(ac ?? 0)}`);
    if (wh != null) row("Weapon Ench.", `${hex(wh)} / color ${hex(wc ?? 0)}`);
    if (rh != null) row("Resist Ench.", `${hex(rh)} / color ${hex(rc ?? 0)}`);
    if (sb.length > 0) {
      // Spell list with names + icons — retail's ItemExamineUI spell
      // strip. `spellBook` is a plain `Vec<u32>` of spell ids on the
      // wire (types.rs) — no name/icon travels with it, so each is
      // resolved locally via handle.getSpellRecord (sync name) +
      // resolveSpellIcon (async icon, same path plugins/spellbook.js
      // and ui/ac_entity_icon.js use for the hotbar/spellbook icons).
      const list = document.createElement("div");
      list.className = "hb-exa-spelllist";
      list.style.cssText = "display:flex;flex-direction:column;gap:2px;margin:2px 0;";
      for (const spellId of sb) {
        const id = spellId >>> 0;
        const entry = document.createElement("div");
        entry.className = "hb-exa-spell";
        entry.style.cssText = "display:flex;align-items:center;gap:6px;font-size:10px;";
        const ic = document.createElement("span");
        ic.style.cssText = "width:16px;height:16px;flex:0 0 auto;background:center/contain no-repeat;image-rendering:pixelated;";
        entry.appendChild(ic);
        const label = document.createElement("span");
        setAcText(label, getSpellName(id) || `Spell ${id}`);
        entry.appendChild(label);
        list.appendChild(entry);
        resolveSpellIcon(id).then((url) => {
          if (url && ic.isConnected) ic.style.backgroundImage = `url("${url}")`;
        }).catch(() => {});
      }
      wrapEl.appendChild(list);
    }
  }

  // === Requirements (wield gating) ===
  // Ports retail ItemExamineUI::Appraisal_ShowWieldRequirements.
  // WieldRequirements is the AC enum picking which check applies:
  //   1=RawSkill, 2=AttribSkill, 3=RawAttrib, 4=Level, 5=RawAttrib2,
  //   7=Heritage, 8=Faction (per acclient.h:54900-ish). When the wasm
  //   side surfaces only the raw PropertyInts (no enum name), we
  //   fall back to a generic "Skill <n> ≥ X" / "Attribute <n> ≥ X"
  //   label so the player at least sees the bar.
  const WIELD_REQ_LABELS = {
    1: "Raw skill", 2: "Skill", 3: "Raw attribute",
    4: "Level", 5: "Raw attribute (alt)",
    7: "Heritage", 8: "Faction",
  };
  if (ints.WieldDifficulty != null
      || ints.WieldRequirements != null
      || ints.ItemMinLevel != null
      || ints.HeritageGroup != null
      || ints.Faction1Bits != null) {
    sec("Requirements");
    const reqKind = ints.WieldRequirements >>> 0;
    const skillType = ints.WieldSkillType ?? null;
    const diff = ints.WieldDifficulty ?? null;
    if (reqKind || diff != null || skillType != null) {
      const label = WIELD_REQ_LABELS[reqKind] || "Wield req";
      // reqKind 2 (AttribSkill)/1 (RawSkill) key off a Skill id — label
      // it with the real skill name (mirrors WeaponProfile.weapon_skill
      // handling above) instead of a bare numeric id.
      const isSkillReq = reqKind === 1 || reqKind === 2;
      const skillLabel = skillType != null ? (isSkillReq ? skillName(skillType) : `id ${skillType}`) : null;
      if (skillLabel != null && diff != null) {
        row(label, `${skillLabel} ≥ ${diff}`);
      } else if (skillLabel != null) {
        row(label, skillLabel);
      } else if (diff != null) {
        row(label, `≥ ${diff}`);
      }
    }
    if (ints.ItemMinLevel != null) row("Min level", `${ints.ItemMinLevel}+`);
    // Mirror requirements for the alt slot if present (some artifacts
    // ship a second wield req block).
    if (ints.WieldDifficulty2 != null || ints.WieldSkillType2 != null) {
      const reqKind2 = ints.WieldRequirements2 >>> 0;
      const label2 = WIELD_REQ_LABELS[reqKind2] || "Wield req (alt)";
      if (ints.WieldSkillType2 != null && ints.WieldDifficulty2 != null) {
        row(label2, `id ${ints.WieldSkillType2} ≥ ${ints.WieldDifficulty2}`);
      }
    }
    if (ints.HeritageGroup != null) row("Heritage", String(ints.HeritageGroup));
  }

  // === Description ===
  // Retail ItemExamineUI's scrollable description area (armor/weapon
  // pane 0x10000148/0x10000149 — see the gmFloatyExaminationUI layout
  // comment at the top of this file). `strings.LongDesc` is
  // PropertyString.LongDesc (=16) — the item/creature's flavour text.
  // Previously only surfaced under `?debug=1`; retail always shows it
  // when present, so it's promoted to a normal always-visible section.
  if (strings.LongDesc) {
    sec("Description");
    const desc = document.createElement("div");
    desc.className = "hb-exa-desc";
    desc.style.cssText = "font-size:11px;line-height:1.4;font-style:italic;padding:2px 4px;white-space:pre-wrap;";
    setAcText(desc, String(strings.LongDesc));
    wrapEl.appendChild(desc);
  }

  // === Debug (gated) — Type/Class/Wcid/X/Y/Z/Landblock ===
  // Reserved for `?debug=1` per the EX-05 plan; cheap to leave gated.
  try {
    const params = new URLSearchParams(window.location?.search ?? "");
    if (params.get("debug") === "1") {
      sec("Debug");
      row("ItemType",    ints.ItemType);
      row("CreatureType", ints.CreatureType);
      if (strings.PluralName) row("Plural", strings.PluralName);
      const flt = (k) => floats[k] != null ? Number(floats[k]).toFixed(2) : undefined;
      row("Weight",  flt("EncumbranceVal"));
      row("Value",   ints.Value);
    }
  } catch (_) {}
}

// Resolve the title text for an examine context (matches view.nameFor).
export function examineTitleFor(ctx) {
  if (ctx?.name) return `Examine: ${ctx.name}`;
  if (ctx?.srcLi) {
    const n = ctx.srcLi.querySelector?.(".name")?.textContent;
    if (n) return `Examine: ${n}`;
  }
  return "Examine";
}

// Build the examine body DOM into `parentEl` and wire up paperdoll +
// inscription + bus refresh subscriptions. Returns a cleanup function.
// Used by BOTH the main-panel view (main-panel host) and the standalone
// floaty (gmFloatyExaminationUI). Caller owns the outer chrome
// (title bar / close button / frame); this only owns the body content.
export function mountExamineBody(parentEl, ctx) {
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
    // P2-44 (cross-find EX-02 / placeholder cluster): resolve the
    // entity's real iconId via the shared resolver. Fire-and-forget;
    // the icon paints in once the data URL arrives.
    const exaGuid = (ctx?.guid ?? 0) >>> 0;
    if (exaGuid) {
      resolveBindingIcon({ itemGuid: exaGuid })
        .then((url) => { if (url) iconEl.style.backgroundImage = `url("${url}")`; })
        .catch(() => {});
    }

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

    // Wave 3.B (2026-05-28) — embedded paperdoll preview. Renders the
    // examined entity's full rig with equipped armor + dye palette via
    // the same PaperdollViewport that powers the inventory panel
    // (`plugins/inventory.js:1389`). Sits at the top of the scrollable
    // body so the player sees the dyed gear above the stats. Only
    // populated for the `fromEntity` path; inventory items are NOT
    // creatures so the paperdoll wrap stays hidden for that flow.
    // Reference: `external/chorizite/ACBindings/Generated/UI/Elements/
    // gmFloatyExaminationUI.cs` for the canonical retail layout (icon
    // top-right + rig area + stat rows below).
    const paperdollWrap = document.createElement("div");
    paperdollWrap.className = "hb-exa-paperdoll-wrap";
    paperdollWrap.style.display = "none"; // shown only on fromEntity below
    body.appendChild(paperdollWrap);

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

    let paperdollViewport = null;
    if (ctx?.fromInventory) {
      populateFromInventory(body, ctx, nameEl, guidEl);
    } else {
      populateFromEntity(body, ctx ?? {}, nameEl, guidEl);
      // Wave 3.B — render the entity's gear/dye preview at the top
      // of the body. renderEntityPaperdoll handles the entity-missing
      // / no-setupId fallbacks internally; returns null when the
      // viewport couldn't be constructed (no entry to dispose then).
      paperdollWrap.style.display = "";
      paperdollViewport = renderEntityPaperdoll(paperdollWrap, examineGuid);
    }
    renderInscription(inscWrap, examineGuid);

    // EX-05 (2026-06-05) — AppraisalProfile section. Adds a sub-block
    // inside the scrollable body that renders the entity's full
    // AppraisalProfile (AttributeInfoRegion / SkillInfoRegion /
    // EffectInfoRegion analogues). Fires `requestAppraisal(guid)` on
    // mount; subscribes to `objectAppraised` and reads back via
    // `getObjectAppraisal(guid)` whenever the GUID matches our target.
    const appraisalWrap = document.createElement("div");
    appraisalWrap.className = "hb-exa-appraisal-wrap";
    appraisalWrap.style.display = "none";
    appraisalWrap.style.marginTop = "6px";
    body.appendChild(appraisalWrap);
    renderAppraisal(appraisalWrap, examineGuid);
    if (examineGuid) {
      try {
        const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
        if (handle?.requestAppraisal) handle.requestAppraisal(examineGuid >>> 0);
      } catch (_) {}
    }

    // Refresh inscription on bookUpdated (book panel pushes fresh
    // BookSnapshot here) and on playerInventoryChanged (ownership
    // gates the Set Inscription button).
    const pc = window.__pluginClient ?? null;
    const onRefresh = () => renderInscription(inscWrap, examineGuid);
    // HUD rec #107 (2026-06-16) — RNG-based identify retry. ACE rolls
    // an Identify skill check per Player_Skills.cs HandleIdentifyResponse;
    // on failure the IdentifyResponse comes back with success=false and
    // the panel falls through to the "Insufficient identification skill"
    // banner (rec #53). Retail's awaiting_appraisal_ID gating retries
    // automatically on failure (acclient.h:55670-ish). Mirror that with
    // bounded exponential backoff: 3 attempts at 5s / 10s / 20s, then
    // give up. Cancellation: any successful identify (or unmount) clears
    // the pending timer so we don't double-fire.
    const IDENTIFY_RETRY_DELAYS_MS = [5000, 10000, 20000];
    let identifyRetryAttempt = 0;
    let identifyRetryTimer = null;
    const cancelIdentifyRetry = () => {
      if (identifyRetryTimer !== null) {
        clearTimeout(identifyRetryTimer);
        identifyRetryTimer = null;
      }
    };
    const scheduleIdentifyRetry = () => {
      if (!examineGuid) return;
      if (identifyRetryAttempt >= IDENTIFY_RETRY_DELAYS_MS.length) return;
      const delay = IDENTIFY_RETRY_DELAYS_MS[identifyRetryAttempt];
      identifyRetryAttempt++;
      cancelIdentifyRetry();
      identifyRetryTimer = setTimeout(() => {
        identifyRetryTimer = null;
        const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
        try { handle?.requestAppraisal?.(examineGuid >>> 0); } catch (_) {}
      }, delay);
    };
    const onAppraised = (ev) => {
      const guid = (ev?.detail?.u32Payload ?? 0) >>> 0;
      if (!examineGuid || guid !== (examineGuid >>> 0)) return;
      renderAppraisal(appraisalWrap, examineGuid);
      try {
        const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
        const json = handle?.getObjectAppraisal?.(guid >>> 0);
        if (typeof json === "string" && json.length > 0) {
          const snap = JSON.parse(json);
          if (snap?.identifySuccess === false) {
            scheduleIdentifyRetry();
          } else {
            cancelIdentifyRetry();
            identifyRetryAttempt = 0;
          }
        }
      } catch (_) { /* leave retry state untouched on parse failure */ }
    };
    // Wave 3.B — refresh the paperdoll when the examined entity's
    // appearance changes (e.g. NPC equips a new item via ACE's
    // applyAppearance broadcast). Local-player-only events fire for
    // `playerInventoryChanged`; non-player entities re-publish via
    // ObjectCreate/EntityUpdate which flows through entity refresh.
    const onAppearanceRefresh = () => {
      if (!examineGuid || ctx?.fromInventory) return;
      // Tear down + rebuild the viewport so the new substitutions land.
      // PaperdollViewport's _lastLoadKey debounce will no-op when
      // nothing meaningful changed.
      if (paperdollViewport) {
        try { paperdollViewport.dispose(); } catch (_) {}
        paperdollViewport = null;
      }
      paperdollWrap.style.display = "";
      paperdollViewport = renderEntityPaperdoll(paperdollWrap, examineGuid);
    };
    if (pc?.events?.on) {
      pc.events.on("bookUpdated", onRefresh);
      pc.events.on("playerInventoryChanged", onRefresh);
      pc.events.on("entityAppearanceChanged", onAppearanceRefresh);
      pc.events.on("objectAppraised", onAppraised);
    }

    return () => {
      if (pc?.events?.off) {
        try { pc.events.off("bookUpdated", onRefresh); } catch (_) {}
        try { pc.events.off("playerInventoryChanged", onRefresh); } catch (_) {}
        try { pc.events.off("entityAppearanceChanged", onAppearanceRefresh); } catch (_) {}
        try { pc.events.off("objectAppraised", onAppraised); } catch (_) {}
      }
      // HUD rec #107: drop any pending identify-retry timer so the
      // backoff schedule doesn't outlive the panel's unmount.
      cancelIdentifyRetry();
      if (paperdollViewport) {
        try { paperdollViewport.dispose(); } catch (_) {}
        paperdollViewport = null;
      }
      root.remove();
    };
}

// View interface — registered with main-panel under id "examine".
// Thin wrapper around mountExamineBody so the floaty (EX-03) shares
// the same body builder.
export const view = {
  name: "Examine",
  nameFor: examineTitleFor,
  mount: (parentEl, ctx) => mountExamineBody(parentEl, ctx),
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
  // Forward an optional ctx so callers can thread {fromInventory, srcLi,
  // name} — examine-target.js:996 checks ctx?.fromInventory. Earlier
  // signature dropped the second arg silently and broke container-panel +
  // inventory grid -> examine context.
  window.__showExamineFor = (guid, ctx) => window.__mainPanel?.pushView?.("examine", { guid: guid >>> 0, ...(ctx || {}) });

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
    // Route through __showExamineFor so the flag-gated floaty vs
    // main-panel choice (examine-floaty.js mount) is honored. Falls
    // through to mainPanel directly if no router is installed.
    if (typeof window.__showExamineFor === "function") {
      window.__showExamineFor(guid, { name: snap.name, fromEntity: true });
    } else if (window.__mainPanel?.pushView) {
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
