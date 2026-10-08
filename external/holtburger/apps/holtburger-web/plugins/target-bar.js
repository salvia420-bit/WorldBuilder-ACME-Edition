// Toolbar controls — the top band of retail gmToolbarUI (LayoutDesc
// 0x21000016): combat-mode button, the six panel buttons, the
// [Use | Selected Object | Examine] row and the Inventory (backpack)
// button.
//
// HUD overhaul 2026-10-05 — ONE toolbar. This file used to mount a
// second, independently positioned overlay (#hb-target-bar, bottom:46px,
// z-index 49) that sat 36 px out of line BEHIND the hotbar's frame, so
// players saw a blurry strip instead of the panel buttons and the pack
// ("there are seemingly two hotbars"). Retail draws all of this inside
// the SAME floaty that holds the shortcut row — gmFloatyToolbarUI::PostInit
// calls gmToolbarUI::PostInit on itself (acclient.c) — so this module is
// now a pure builder: plugins/hotbar.js owns the single draggable
// #hb-hotbar root and calls `mountToolbarControls(field)` to place these
// controls inside its ToolbarField (0x1000001B). The plugin `mount()` at
// the bottom is a no-op kept for the loader contract.
//
// Retail behaviour matched (acclient.c, read 2026-10-05):
//   gmToolbarUI::PostInit — 6 PanelButtonInfo (Social/Magic/Skill/Quest/
//     World/Options) + InventoryButton; health + mana meters and the
//     stack-size box start HIDDEN.
//   gmToolbarUI::ListenToElementMessage — 0x10000192-195 click →
//     ClientCombatSystem::ToggleCombatMode; 0x1000019D Use →
//     ItemHolder::UseObject(selectedID); 0x100001A5 Examine →
//     ClientUISystem::ExamineObject(selectedID).
//   gmToolbarUI::RecvNotice_SetCombatMode — exactly one of the four mode
//     buttons is visible (mode 1/2/4/8) and the shortcut numbers are drawn
//     GHOSTED in Magic mode (UIElement_UIItem::SetShortcutNum _ghosted).
//   gmToolbarUI::RecvNotice_SetPanelVisibility — a panel button sits in
//     its Highlight state (6) while its panel is open, Normal (1) else.
//   gmToolbarUI::RecvNotice_UpdateObjectHealth — the ToolbarHealthMeter is
//     made visible and filled when health arrives for the selected object.
//   gmToolbarUI::HandleDropRelease — an item dropped on the InventoryButton
//     goes into the main pack (CPlayerSystem::PlaceInBackpack when owned,
//     ItemHolder::AttemptToPlaceInContainer(player) otherwise).
//
// Modern liberties: panel buttons/backpack also show their Highlight
// sprite on hover, every control has a kit tooltip with its hotkey, and
// the selected-object field shows a dim "No selection" instead of a blank
// box. Not ported: the stack-split entry box/slider (0x100001A3/4) and
// the selected item's mana meter (0x100001A2) — no consumer yet.

import { setAcText } from "../ui/ac_font.js";
import { listManifestBindings } from "../ui/keymap.js";
import { suggestedCombatModeFromInventory, activateOrUse, worldUseLeaf } from "./inventory_helpers.js";
import { noteCombatModeRequest } from "../ui/ac_combat_mode_intent.js";
import { DropItemFlags, isDropAccepted } from "./drop_item_flags.js";
import { shouldQueryHealth, consumeWorldUseThrottle } from "../scene3d/target_cycle.js";
import {
  COMBAT_MODE,
  combatModeForStance,
  stanceButtonFor,
  stanceButtonTip,
} from "./stance-toggle.js";

const STYLE_ID = "hb-toolbar-controls-style";
const LEGACY_OVERLAY_ID = "hb-target-bar";
const SP = "./data/ui-sprites";
const sprite = (id) => `url("${SP}/${id}.png")`;

// ── Retail geometry ──────────────────────────────────────────────────
// Every rect below is the element's StateDesc x/y/width/height from the
// DAT dump data/retail-layouts/0x21000016.json, relative to the
// gmToolbarUI root (= the gmFloatyToolbarUI ToolbarField 0x1000001B at
// (5,5) of the 310×100 floaty). test_toolbar_unified.mjs re-reads that
// JSON and fails if any number here drifts from the DAT.
export const TOOLBAR_RECTS = Object.freeze({
  stance:      Object.freeze({ id: 0x10000192, x: 0,   y: 0,  w: 55,  h: 58 }),
  leftSpacer:  Object.freeze({ id: 0x10000196, x: 55,  y: 0,  w: 7,   h: 27, sprite: "0x0600112B" }),
  rightSpacer: Object.freeze({ id: 0x1000019C, x: 236, y: 0,  w: 10,  h: 27, sprite: "0x0600112C" }),
  use:         Object.freeze({ id: 0x1000019D, x: 55,  y: 27, w: 23,  h: 31 }),
  target:      Object.freeze({ id: 0x1000019E, x: 78,  y: 27, w: 140, h: 31 }),
  examine:     Object.freeze({ id: 0x100001A5, x: 218, y: 27, w: 22,  h: 31 }),
  pack:        Object.freeze({ id: 0x100001B1, x: 238, y: 0,  w: 63,  h: 58 }),
});

// The six PanelButtonInfo entries gmToolbarUI::PostInit registers, in
// retail draw order. normal/highlight = the Normal (1) / Highlight (6)
// state sprites. `views` = every main-panel view that counts as "this
// panel is open" for the Highlight state (Social is our allegiance view,
// whose tab strip also hosts Fellowship).
export const PANEL_BUTTONS = Object.freeze([
  Object.freeze({ key: "social",  id: 0x10000197, x: 55,  y: 0, w: 35, h: 27, normal: "0x0600111F", highlight: "0x06001121",
    view: "social", views: ["social", "allegiance", "fellowship"], label: "Social",
    sub: "Allegiance, fellowship, friends and squelch", hotkey: { plugin: "social-panel", id: "toggle", fallback: "Shift+F3" } }),
  Object.freeze({ key: "magic",   id: 0x10000198, x: 85,  y: 0, w: 34, h: 27, normal: "0x06001119", highlight: "0x0600111B",
    view: "spellbook", views: ["spellbook"], label: "Spellbook",
    sub: null, hotkey: { plugin: "spellbook", id: "toggle", fallback: "F5" } }),
  Object.freeze({ key: "skills",  id: 0x10000199, x: 115, y: 0, w: 34, h: 27, normal: "0x06001122", highlight: "0x06001124",
    view: "character", views: ["character", "train-skills"], label: "Character Information",
    sub: "Attributes, skills and training", hotkey: { plugin: "character-info", id: "toggle", fallback: "F1" } }),
  Object.freeze({ key: "quests",  id: 0x1000055A, x: 145, y: 0, w: 34, h: 27, normal: "0x060069AE", highlight: "0x060069AF",
    view: "journal", views: ["journal"], label: "Journal",
    sub: null, hotkey: { plugin: "journal-panel", id: "toggle", fallback: "F6" } }),
  Object.freeze({ key: "world",   id: 0x1000019A, x: 175, y: 0, w: 34, h: 27, normal: "0x06001116", highlight: "0x06001118",
    view: "map", views: ["map"], label: "Map",
    sub: null, hotkey: { plugin: "map-panel", id: "toggle", fallback: "F3" } }),
  Object.freeze({ key: "options", id: 0x1000019B, x: 204, y: 0, w: 34, h: 27, normal: "0x0600111C", highlight: "0x0600111E",
    view: "options", views: ["options"], label: "Options",
    sub: null, hotkey: { plugin: "options-panel", id: "toggle", fallback: "F10" } }),
]);

export const INVENTORY_BUTTON = Object.freeze({
  normal: "0x06004CF7", highlight: "0x06004CF8",
  view: "inventory", views: ["inventory"], label: "Inventory",
  hotkey: Object.freeze({ plugin: "inventory", id: "toggle", fallback: "F4" }),
});

// Backtick toggles combat mode (index.html gameplay keydown, retail
// default keybind); not rebindable today.
const COMBAT_TOGGLE_KEY = "`";

// ── Pure helpers (unit-tested in test_toolbar_unified.mjs) ───────────

/** Resolve the live key-string for a manifest hotkey. Before the loader
 *  has registered any manifest bindings, show the manifest default; once
 *  bindings exist, show only a key that really dispatches to this plugin
 *  (a duplicate lost to another plugin shows no key rather than a lie). */
export function pickHotkeyLabel(bindings, pluginId, hotkeyId, fallback = "") {
  if (!Array.isArray(bindings) || bindings.length === 0) return fallback || "";
  const hit = bindings.find((b) => b && b.pluginId === pluginId && b.hotkeyId === hotkeyId);
  return hit ? String(hit.keyString || "") : "";
}

/** "Spellbook" + "F5" → "Spellbook (F5)". */
export function formatTipLabel(label, key) {
  return key ? `${label} (${key})` : String(label ?? "");
}

/** Retail Highlight state: the button's panel is the open main-panel view. */
export function panelButtonIsActive(btn, isOpen, viewId) {
  if (!isOpen || !viewId || !btn) return false;
  const views = Array.isArray(btn.views) && btn.views.length ? btn.views : [btn.view];
  return views.includes(viewId);
}

/** Health fraction → filled px of the 140-px ToolbarHealthMeter, or null
 *  when the fraction is unknown (meter stays hidden, as retail PostInit
 *  leaves it until UpdateObjectHealth). */
export function healthFillWidth(frac, width = TOOLBAR_RECTS.target.w) {
  if (frac == null || !Number.isFinite(frac) || frac < 0) return null;
  return Math.round(Math.max(0, Math.min(1, frac)) * width);
}

function hotkeyFor(hk) {
  let list = null;
  try { list = listManifestBindings(); } catch (_) { list = null; }
  return pickHotkeyLabel(list, hk.plugin, hk.id, hk.fallback);
}

// ── Styles ───────────────────────────────────────────────────────────
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  // Sprites are drawn at native size from the element's top-left and
  // clipped by the element box (retail DrawMode Normal): e.g. the 146-px
  // SelectedObjectField / meter sprites show their first 140 px, the
  // 39-px Options sprite its first 34.
  s.textContent = `
    .htb-btn, .htb-spacer, .htb-target {
      position: absolute;
      box-sizing: border-box;
      margin: 0; padding: 0; border: 0;
      background: var(--sp) left top no-repeat;
      image-rendering: pixelated;
    }
    .htb-spacer { pointer-events: none; }
    .htb-btn { cursor: pointer; outline: none; }
    .htb-btn:focus-visible, .htb-target:focus-visible {
      outline: 1px solid var(--hbk-gold-bright, #f3d27a);
      outline-offset: -1px;
    }
    .htb-panel-btn:hover, .htb-panel-btn.is-open,
    .htb-pack:hover, .htb-pack.is-open, .htb-pack.is-drop-target,
    .htb-stance:hover, .htb-stance:active { background-image: var(--sp-hi); }
    .htb-panel-btn:active, .htb-pack:active { filter: brightness(0.85); }
    .htb-pack.is-drop-target { filter: drop-shadow(0 0 4px rgba(243, 210, 122, 0.95)); }
    .htb-use { --sp: ${sprite("0x06001129")}; }
    .htb-use:active { background-image: ${sprite("0x0600112A")}; }
    .htb-use:hover:not(:disabled), .htb-examine:hover:not(:disabled) { filter: brightness(1.25); }
    .htb-use:disabled { background-image: ${sprite("0x0600120E")}; cursor: default; }
    .htb-examine { --sp: ${sprite("0x06001127")}; }
    .htb-examine:active { background-image: ${sprite("0x06001128")}; }
    .htb-examine:disabled { opacity: 0.45; cursor: default; }

    .htb-target {
      --sp: ${sprite("0x06001126")};
      overflow: hidden;
      cursor: pointer;
    }
    .htb-target.is-empty { cursor: default; }
    .htb-target:not(.is-empty):hover { filter: brightness(1.12); }
    .htb-target > * { position: absolute; pointer-events: none; }
    .htb-target-blink {
      inset: 0;
      background: ${sprite("0x06001937")} left top no-repeat;
      opacity: 0;
    }
    .htb-target.is-blinking .htb-target-blink { animation: htb-select-blink 560ms ease-out 1; }
    @keyframes htb-select-blink {
      0% { opacity: 0; } 20% { opacity: 0.85; } 45% { opacity: 0.2; }
      70% { opacity: 0.7; } 100% { opacity: 0; }
    }
    .htb-target-health { inset: 0; background: ${sprite("0x0600193E")} left top no-repeat; }
    .htb-target-health-fill {
      left: 0; top: 0; bottom: 0; width: 0;
      background: ${sprite("0x0600193F")} left top no-repeat;
      transition: width 180ms ease-out;
    }
    .htb-target-name {
      left: 5px; right: 5px; top: 0; bottom: 4px;
      display: flex; align-items: center; justify-content: center;
      overflow: hidden; white-space: nowrap;
    }
    /* The meter sprites are black in rows 0-12, bar in 13-26, gold rule
       27-30: with health showing, the name moves into the black top band
       so it never sits on the red bar. */
    .htb-target.has-health .htb-target-name { bottom: auto; height: 14px; }
  `;
  document.head.appendChild(s);
}

// ── Live-state readers ───────────────────────────────────────────────
function getSelectedTargetGuid() {
  try {
    const em = window.liveScene3d?.entityManager;
    return (em?.getSelectedTarget?.() ?? 0) >>> 0;
  } catch { return 0; }
}

/** Display name for any tracked object: the wasm property bag
 *  (`objectName`, populated at spawn — covers world objects AND pack
 *  items), then scene3d's nameplate cache. */
export function lookupObjectName(guid) {
  if (!guid) return null;
  const handle = window.__sessionHandle;
  try {
    const n = handle?.objectName?.(guid >>> 0);
    if (typeof n === "string" && n) return n;
  } catch {}
  try {
    const e = window.liveScene3d?.entityManager?.entityMap?.get(guid >>> 0);
    if (e?.name) return e.name;
    if (e?.meta?.name) return e.meta.name;
  } catch {}
  return null;
}

// Bug 10 (2026-10-07) — retail's selection meter policy. Only a player, a
// pet, or an attackable object is queried and metered
// (`gmToolbarUI::HandleSelectionChanged` acclient.c:241923-241930; OpenAC
// SelectedObjectHealthPolicy). A non-attackable NPC (Reformed Bandit) shows
// no meter in retail. PropertyInstanceId.PetOwner = 44.
const PROP_IID_PET_OWNER = 44;
function selectionMeta(guid) {
  try {
    const e = window.liveScene3d?.entityManager?.entityMap?.get(guid >>> 0);
    const meta = e?.meta || null;
    if (!meta) return null;
    let petOwner = 0;
    try {
      petOwner = (window.__sessionHandle?.objectInstanceIdProperty?.(guid >>> 0, PROP_IID_PET_OWNER) >>> 0) || 0;
    } catch (_) { petOwner = 0; }
    return {
      itemType: (meta.itemType >>> 0) || 0,
      objDescFlags: (meta.objDescFlags >>> 0) || 0,
      petOwner,
    };
  } catch (_) { return null; }
}
export function wantsHealthMeter(guid) {
  const g = guid >>> 0;
  if (!g) return false;
  let me = 0;
  try {
    me = (window.getLocalPlayerGuid?.() ?? window.__sessionHandle?.playerGuid?.() ?? 0) >>> 0;
  } catch (_) { me = 0; }
  if (me && g === me) return true;
  const target = selectionMeta(g);
  // No rig to read (inventory item, out-of-view object): keep the old
  // behaviour and ask — ACE answers only for creatures it can find.
  if (!target) return true;
  return shouldQueryHealth(target, me ? selectionMeta(me) : null);
}

function cachedHealthFraction(guid) {
  try {
    const f = window.__sessionHandle?.objectHealthFraction?.(guid >>> 0);
    return (Number.isFinite(f) && f >= 0) ? f : null;
  } catch { return null; }
}

function readStanceMode() {
  let low = 0;
  try {
    low = (typeof window.__getCurrentStanceLow === "function") ? (window.__getCurrentStanceLow() >>> 0) : 0;
  } catch { low = 0; }
  if (low) return { low, mode: combatModeForStance(low) };
  // No UpdateMotion confirmed yet — fall back to the server's CombatMode
  // property if the wasm export exists, else Peace.
  try {
    const m = window.__sessionHandle?.combatMode?.();
    if (m === 1 || m === 2 || m === 4 || m === 8) return { low: 0, mode: m };
  } catch {}
  return { low: 0, mode: COMBAT_MODE.NONCOMBAT };
}

// ── Builder ──────────────────────────────────────────────────────────

/**
 * Build the gmToolbarUI top-band controls inside `field` (an absolutely
 * positioned 300-px-wide box whose origin is retail's ToolbarField).
 * Elements carry `data-tip` + `_hbTip()` for the host's tooltip.
 *
 * @param {HTMLElement} field
 * @param {{root?: HTMLElement}} [opts] root receives the
 *   `hb-toolbar-magic` class while in Magic mode (shortcut numbers ghost).
 * @returns {{dispose(): void, refs: object, getCombatMode(): number}}
 */
export function mountToolbarControls(field, opts = {}) {
  ensureStyles();
  // A pre-overhaul overlay left behind by a hot reload must not linger.
  document.getElementById(LEGACY_OVERLAY_ID)?.remove();
  const root = opts.root || null;
  const created = [];
  const refs = { panelBtns: {} };
  const state = {
    selectedGuid: 0,
    selectedName: "",
    selectedHealth: null,
    // Bug 10: does the current selection get a health meter (retail policy)?
    healthQueried: false,
    healthReplyLogged: false,
    mode: COMBAT_MODE.NONCOMBAT,
    // Optimistic combat-mode flip window: until the server's UpdateMotion
    // changes the stance away from `pendingFromLow`, a poll that still
    // reads the OLD stance must not snap the button back.
    pendingFromLow: null,
    optimisticUntil: 0,
  };

  const place = (el, r) => {
    el.style.left = `${r.x}px`;
    el.style.top = `${r.y}px`;
    el.style.width = `${r.w}px`;
    el.style.height = `${r.h}px`;
    if (r.id != null) el.dataset.elementId = `0x${(r.id >>> 0).toString(16).toUpperCase()}`;
  };
  const add = (el) => { field.appendChild(el); created.push(el); return el; };
  const mkButton = (cls, label) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `htb-btn ${cls}`;
    b.setAttribute("aria-label", label);
    b.dataset.tip = "";
    return b;
  };
  const mkSpacer = (r) => {
    const d = document.createElement("div");
    d.className = "htb-spacer";
    d.style.setProperty("--sp", sprite(r.sprite));
    place(d, r);
    return d;
  };

  // DOM order = retail draw order (data/retail-layouts readOrder): the left
  // spacer sits under Social, the right spacer over the Options sprite's
  // tail and under the backpack.
  add(mkSpacer(TOOLBAR_RECTS.leftSpacer));
  for (const b of PANEL_BUTTONS) {
    const btn = mkButton("htb-panel-btn", b.label);
    btn.dataset.panel = b.key;
    btn.style.setProperty("--sp", sprite(b.normal));
    btn.style.setProperty("--sp-hi", sprite(b.highlight));
    place(btn, b);
    btn._hbTip = () => ({ text: b.label, key: hotkeyFor(b.hotkey), sub: b.sub });
    btn.addEventListener("click", () => {
      try {
        // HUD overhaul 2026-10-05: Social opens the one social hub on its
        // last-used tab (plugins/social-panel.js).
        if (b.key === "social" && typeof window.__toggleSocialPanel === "function") window.__toggleSocialPanel();
        else window.__mainPanel?.toggleView?.(b.view);
      } catch (e) {
        console.warn(`[toolbar] toggleView(${b.view}) failed`, e);
      }
      updatePanelHighlights();
    });
    refs.panelBtns[b.key] = add(btn);
  }
  add(mkSpacer(TOOLBAR_RECTS.rightSpacer));

  // ── Combat-mode button (0x10000192-195 share one rect) ─────────────
  const stance = mkButton("htb-stance", "Combat mode");
  place(stance, TOOLBAR_RECTS.stance);
  stance._hbTip = () => stanceButtonTip(state.mode, COMBAT_TOGGLE_KEY);
  stance.addEventListener("click", onStanceClick);
  refs.stanceBtn = add(stance);

  // ── Use | Selected object | Examine ────────────────────────────────
  const useBtn = mkButton("htb-use", "Use selected");
  place(useBtn, TOOLBAR_RECTS.use);
  useBtn._hbTip = () => (state.selectedGuid
    ? { text: "Use", sub: state.selectedName || null }
    : { text: "Use", sub: "Select something first" });
  useBtn.addEventListener("click", onUseClick);
  refs.useBtn = add(useBtn);

  const target = document.createElement("div");
  target.className = "htb-target is-empty";
  target.setAttribute("role", "button");
  target.tabIndex = 0;
  target.dataset.tip = "";
  place(target, TOOLBAR_RECTS.target);
  const blink = document.createElement("div");
  blink.className = "htb-target-blink";
  const health = document.createElement("div");
  health.className = "htb-target-health";
  health.hidden = true;
  const healthFill = document.createElement("div");
  healthFill.className = "htb-target-health-fill";
  health.appendChild(healthFill);
  const nameEl = document.createElement("div");
  nameEl.className = "htb-target-name";
  // Retail zLevels inside SelectedObjectField: meters 2, SelectionBlinkField
  // 1, SelectedObjectText 0 (front) — so DOM order meter → blink → name.
  target.append(health, blink, nameEl);
  target._hbTip = () => {
    if (!state.selectedGuid) return { text: "No selection", sub: "Click a creature, player or object" };
    const pct = state.selectedHealth != null ? Math.round(state.selectedHealth * 100) : null;
    return {
      text: state.selectedName || "Unknown object",
      sub: pct != null ? `${pct}% health — click to examine` : "Click to examine",
    };
  };
  target.addEventListener("click", examineSelected);
  target.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); examineSelected(); }
  });
  target.addEventListener("animationend", () => target.classList.remove("is-blinking"));
  refs.targetEl = add(target);

  const examineBtn = mkButton("htb-examine", "Examine selected");
  place(examineBtn, TOOLBAR_RECTS.examine);
  examineBtn._hbTip = () => (state.selectedGuid
    ? { text: "Examine", sub: state.selectedName || null }
    : { text: "Examine", sub: "Select something first" });
  examineBtn.addEventListener("click", examineSelected);
  refs.examineBtn = add(examineBtn);

  // ── Inventory (backpack) button ────────────────────────────────────
  const pack = mkButton("htb-pack", INVENTORY_BUTTON.label);
  pack.style.setProperty("--sp", sprite(INVENTORY_BUTTON.normal));
  pack.style.setProperty("--sp-hi", sprite(INVENTORY_BUTTON.highlight));
  place(pack, TOOLBAR_RECTS.pack);
  pack._hbTip = () => ({
    text: INVENTORY_BUTTON.label,
    key: hotkeyFor(INVENTORY_BUTTON.hotkey),
    sub: "Drop an item here to put it in your main pack",
  });
  pack.addEventListener("click", () => {
    try { window.__mainPanel?.toggleView?.(INVENTORY_BUTTON.view); } catch (_) {}
    updatePanelHighlights();
  });
  // gmToolbarUI::HandleDropRelease (InventoryButton branch) — retail moves
  // the dropped item into the player's main pack.
  const acceptsDrop = (ev) => isDropAccepted(ev.dataTransfer?.types, DropItemFlags.CONTAINER);
  pack.addEventListener("dragenter", (ev) => {
    if (!acceptsDrop(ev)) return;
    ev.preventDefault();
    pack.classList.add("is-drop-target");
  });
  pack.addEventListener("dragover", (ev) => {
    if (!acceptsDrop(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
  });
  pack.addEventListener("dragleave", () => pack.classList.remove("is-drop-target"));
  pack.addEventListener("drop", (ev) => {
    pack.classList.remove("is-drop-target");
    if (!acceptsDrop(ev)) return;
    ev.preventDefault();
    const raw = ev.dataTransfer.getData("application/x-hb-inv-guid")
      || ev.dataTransfer.getData("text/x-hb-item-guid");
    const guid = parseInt(raw, 10) >>> 0;
    const handle = window.__sessionHandle;
    let me = 0;
    try { me = (handle?.playerGuid?.() ?? window.getLocalPlayerGuid?.() ?? 0) >>> 0; } catch (_) {}
    if (!me) { try { me = (window.getLocalPlayerGuid?.() ?? 0) >>> 0; } catch (_) {} }
    if (!guid || !me || guid === me || typeof handle?.moveItem !== "function") return;
    try { handle.moveItem(guid, me, 0); } catch (e) {
      console.warn("[toolbar] backpack drop moveItem failed", e);
    }
  });
  refs.packBtn = add(pack);

  // ── Behaviour ──────────────────────────────────────────────────────
  function onStanceClick() {
    const handle = window.__sessionHandle;
    if (!handle) return;
    const now = Date.now();
    const live = readStanceMode();
    const curMode = now < state.optimisticUntil ? state.mode : live.mode;
    const inCombatNow = curMode !== COMBAT_MODE.NONCOMBAT;
    // Leaving Peace: pick the mode from the equipped weapon (Missile/
    // Magic/Melee) so bow- and wand-wielders enter combat instead of a
    // hardcoded Melee that ACE silently reverts (F11-1).
    let suggested = COMBAT_MODE.MELEE;
    if (!inCombatNow) {
      try {
        const inv = typeof handle.playerInventory === "function" ? handle.playerInventory() : [];
        suggested = suggestedCombatModeFromInventory(inv);
        // Copy-then-free (2026-08-03): only `equipMask` primitives are read.
        for (const it of inv) { try { it?.free?.(); } catch (_) {} }
      } catch {}
    }
    const next = inCombatNow ? COMBAT_MODE.NONCOMBAT : suggested;
    try {
      if (typeof handle.setCombatMode === "function") {
        // C8 — see ui/ac_combat_mode_intent.js (ACE LastCombatMode mirror).
        noteCombatModeRequest(next);
        handle.setCombatMode(next);
      } else if (typeof handle.toggleCombatMode === "function") {
        // Untyped toggle: the server picks the mode — record "unknown".
        noteCombatModeRequest(null);
        handle.toggleCombatMode();
      } else {
        return;
      }
      state.pendingFromLow = live.low;
      state.optimisticUntil = now + 2000;
      setMode(next);
    } catch (e) {
      console.warn("[toolbar] combat-mode toggle failed", e);
    }
  }

  function onUseClick() {
    const handle = window.__sessionHandle;
    if (!handle?.useObject || !state.selectedGuid) return;
    const guid = state.selectedGuid >>> 0;
    // Retail gmToolbarUI Use (0x1000019D) → ItemHolder::UseObject(selected):
    // an OWNED item takes the shortcut-key route (inventory.js activateItem —
    // wield / wear / salvage / target mode, no bare Use ACE cannot act on);
    // a world object, or `?hotbarActivate=off`, keeps the plain Use.
    // B2-use-items (2026-10-08 round 2): that world leaf runs the
    // double-click's rules (inventory_helpers.worldUseLeaf) — the 0.2 s
    // throttle, a loose item picked up instead of Used, a non-useable object
    // refused with retail's line. The throttle is spent here, at the leaf
    // only: activateItem spends it itself for an owned item.
    let route = "none";
    let leaf = "none";
    try {
      route = activateOrUse(guid, {
        activate: window.__inventory?.activateItem,
        use: (g) => {
          leaf = worldUseLeaf(g, {
            throttleOk: () => consumeWorldUseThrottle(performance.now()),
            isPickup: window.__worldUseIsPickup,
            pickUp: window.__itemDrag?.placeInBackpack,
            refusal: window.__worldUseRefusal,
            reject: (message) => window.__pluginClient?.events?.emit?.("clientActionRejected", { message }),
            use: (u) => handle.useObject(u),
          });
        },
      });
    } catch (e) {
      console.warn("[toolbar] useObject failed", e);
    }
    // A pickup is not a Use: a book taken off the floor is not opened.
    if (route !== "used" || leaf !== "used") return;
    // HUD rec #180 (2026-06-16): a book (object-description flag BOOK =
    // 0x100) also needs a bookData() request — ACE's Use on a book only
    // acks; the server ignores BookData on non-book GUIDs.
    try {
      const ent = window.liveScene3d?.entityManager?.entityMap?.get?.(guid);
      const objDescFlags = ((ent?.meta?.objDescFlags ?? ent?.objDescFlags) ?? 0) >>> 0;
      if ((objDescFlags & 0x100) !== 0 && handle.bookData) handle.bookData(guid);
    } catch (_) { /* book auto-open is best-effort */ }
  }

  function examineSelected() {
    if (!state.selectedGuid) return;
    // Toggle: when the floaty is already open, close it. Otherwise route
    // through __showExamineFor so the flag-gated floaty vs main-panel path
    // (EX-03) is honored.
    if (window.__examineFloaty?.isOpen?.()) {
      window.__examineFloaty.close?.();
      return;
    }
    const ctx = { name: state.selectedName, fromEntity: true };
    if (typeof window.__showExamineFor === "function") {
      window.__showExamineFor(state.selectedGuid, ctx);
    } else {
      window.__mainPanel?.toggleView?.("examine", { guid: state.selectedGuid, ...ctx });
    }
  }

  function setMode(mode) {
    state.mode = mode;
    const b = stanceButtonFor(mode);
    stance.style.setProperty("--sp", sprite(b.normal));
    stance.style.setProperty("--sp-hi", sprite(b.pressed));
    stance.dataset.mode = String(mode);
    stance.setAttribute("aria-label", `${b.label} — toggle combat`);
    // RecvNotice_SetCombatMode: shortcut numbers ghost in Magic mode.
    root?.classList.toggle("hb-toolbar-magic", mode === COMBAT_MODE.MAGIC);
  }

  function updateStance() {
    const live = readStanceMode();
    if (Date.now() < state.optimisticUntil && live.low === state.pendingFromLow) return;
    state.optimisticUntil = 0;
    state.pendingFromLow = null;
    if (live.mode !== state.mode) setMode(live.mode);
  }

  function renderTarget() {
    const guid = state.selectedGuid;
    target.classList.toggle("is-empty", !guid);
    useBtn.disabled = !guid;
    examineBtn.disabled = !guid;
    target.dataset.guid = guid ? `0x${guid.toString(16).toUpperCase().padStart(8, "0")}` : "";
    const px = guid ? healthFillWidth(state.selectedHealth) : null;
    health.hidden = px == null;
    target.classList.toggle("has-health", px != null);
    if (px != null) healthFill.style.width = `${px}px`;
    if (!guid) {
      setAcText(nameEl, "No selection", { color: "#77705f", fit: true });
      return;
    }
    setAcText(nameEl, state.selectedName || "Unknown object", { color: "#ffffff", fit: true });
  }

  function updateSelection(nextOverride) {
    const next = (nextOverride != null) ? (nextOverride >>> 0) : getSelectedTargetGuid();
    if (next !== state.selectedGuid) {
      const prevQueried = !!state.healthQueried;
      state.selectedGuid = next;
      state.selectedName = next ? (lookupObjectName(next) || "") : "";
      // F10-1 — new target: seed from the cached health fraction, then ask
      // the server (reply = `entityHealthUpdated`). HUD rec #98: the next
      // bus event resyncs a stale in-flight reply.
      // Bug 10: only players, pets and attackable objects are metered (retail).
      state.healthQueried = next ? wantsHealthMeter(next) : false;
      state.healthReplyLogged = false;
      state.selectedHealth = state.healthQueried ? cachedHealthFraction(next) : null;
      const h = window.__sessionHandle;
      if (next && state.healthQueried) {
        try { h?.queryHealth?.(next); } catch (_) {}
      } else if (prevQueried) {
        // Retail `Event_QueryHealth(0)` when the meter goes away
        // (acclient.c:241825): ACE stops the heartbeat health updates.
        try { h?.queryHealth?.(0); } catch (_) {}
      }
      if (next) {
        console.info(
          `[target-health] sel 0x${next.toString(16)} meter=${state.healthQueried} ` +
          `cached=${state.selectedHealth == null ? "none" : state.selectedHealth.toFixed(2)}`,
        );
        // SelectionBlinkField (0x100001A0) ObjectSelected state.
        target.classList.remove("is-blinking");
        void target.offsetWidth;
        target.classList.add("is-blinking");
      }
      renderTarget();
    } else if (next) {
      if (!state.selectedName) {
        const n = lookupObjectName(next);
        if (n) { state.selectedName = n; renderTarget(); }
      }
      // The rig (and so its flags) can land after the selection.
      if (!state.healthQueried && wantsHealthMeter(next)) {
        state.healthQueried = true;
        try { window.__sessionHandle?.queryHealth?.(next); } catch (_) {}
      }
    }
  }

  function updatePanelHighlights() {
    let open = false;
    let viewId = null;
    try {
      const mp = window.__mainPanel;
      open = !!mp?.isOpen?.();
      viewId = mp?.currentViewId?.() ?? null;
    } catch (_) {}
    for (const b of PANEL_BUTTONS) {
      refs.panelBtns[b.key].classList.toggle("is-open", panelButtonIsActive(b, open, viewId));
    }
    pack.classList.toggle("is-open", panelButtonIsActive(INVENTORY_BUTTON, open, viewId));
  }

  // ── Event wiring ───────────────────────────────────────────────────
  const onSelectionChanged = (ev) => updateSelection((ev?.detail?.guid ?? ev?.guid ?? 0) >>> 0);
  // F10-1 — selected target's health changed (QueryHealth reply / damage).
  const onEntityHealth = (ev) => {
    const d = ev?.detail ?? ev ?? {};
    const guid = (d.guid ?? 0) >>> 0;
    if (!guid || guid !== state.selectedGuid) return;
    if (!state.healthQueried) return; // no meter for this selection (retail)
    const f = d.fraction;
    state.selectedHealth = Number.isFinite(f) && f >= 0 ? f : null;
    if (!state.healthReplyLogged) {
      state.healthReplyLogged = true;
      let inStore = false;
      try { inStore = typeof window.__sessionHandle?.objectName?.(guid) === "string"; } catch (_) {}
      console.info(
        `[target-health] reply 0x${guid.toString(16)} frac=${Number.isFinite(f) ? f.toFixed(2) : f} inStore=${inStore}`,
      );
    }
    renderTarget();
  };
  const onStatsUpdated = () => updateStance();
  let bus = null;
  const subscribe = (client) => {
    if (!client?.events?.on || bus) return;
    bus = client.events;
    bus.on("selectionChanged", onSelectionChanged);
    bus.on("playerStatsUpdated", onStatsUpdated);
    bus.on("entityHealthUpdated", onEntityHealth);
  };
  if (window.__pluginClient?.events?.on) subscribe(window.__pluginClient);
  else window.__pluginClientReady?.then?.(subscribe);

  // One 250 ms tick: panel Highlight state every tick (main-panel has no
  // visibility notice to subscribe to — two property reads), and a 1 Hz
  // backstop for late name resolution / dropped bus events.
  let tick = 0;
  const timer = setInterval(() => {
    updatePanelHighlights();
    if ((tick++ & 3) === 0) { updateSelection(); updateStance(); }
  }, 250);

  setMode(readStanceMode().mode);
  updateSelection();
  renderTarget();
  updatePanelHighlights();

  return {
    refs,
    getCombatMode: () => state.mode,
    dispose() {
      clearInterval(timer);
      if (bus?.off) {
        try { bus.off("selectionChanged", onSelectionChanged); } catch (_) {}
        try { bus.off("playerStatsUpdated", onStatsUpdated); } catch (_) {}
        try { bus.off("entityHealthUpdated", onEntityHealth); } catch (_) {}
      }
      bus = null;
      root?.classList.remove("hb-toolbar-magic");
      for (const el of created) el.remove();
      created.length = 0;
    },
  };
}

export const manifest = {
  id: "target-bar",
  name: "Target Bar",
  icon: "⊙",
  iconHidden: true,
  version: "0.2.0",
  description: "Retail gmToolbarUI controls (combat mode, 6 panel buttons, Use/Selected/Examine, backpack) — mounted inside the unified #hb-hotbar toolbar",
};

// HUD overhaul 2026-10-05: no standalone overlay any more — the controls
// are mounted by plugins/hotbar.js into the single toolbar. Kept so the
// loader's mount lifecycle (BAR_SLOT_ORDER "target-bar") stays valid; it
// only clears a stale pre-overhaul #hb-target-bar.
export function mount(_ctx) {
  document.getElementById(LEGACY_OVERLAY_ID)?.remove();
  return () => {};
}
