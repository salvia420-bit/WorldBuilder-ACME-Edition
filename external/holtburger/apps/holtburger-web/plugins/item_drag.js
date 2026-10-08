// item_drag — the shared retail item drag & drop layer (HUD overhaul
// 2026-10-05). Helper module (no manifest), imported by inventory.js and
// corpse-loot-bar.js.
//
// WHY: every panel used to hand-roll HTML5 DnD with per-element
// dragenter/dragleave (flickery highlight), the browser's own translucent
// drag bitmap (often blank — the icon image wasn't decoded yet — and NOT
// scaled with the HUD zoom), full-panel innerHTML rebuilds mid-drag (the
// drag source node vanished, so `dragend` never fired) and no optimistic
// feedback. Retail (UIElement_ItemList / ItemHolder, see
// inventory_helpers.decideItemDrop) moves the icon at once and shows it
// "waiting" (ItemSlot_Icon_Ghosted 0x0600109A) until the server agrees.
//
// Transport stays HTML5 DnD with the SAME dataTransfer contract other
// plugins consume — `application/x-hb-inv-guid` + `text/x-hb-item-guid`
// (hotbar.js, vendor-ui.js, trade-panel.js, tinker-panel.js,
// salvage-panel, scene3d/picking.js) — so every external drop target keeps
// working untouched. What changes:
//   * our own ghost: `#hb-item-drag-ghost.hbk-drag-ghost`, a body child
//     with an hb- id, so the HUD zoom sizes it like the slot it came from;
//     it tracks the pointer from a window-capture `dragover` (the native
//     bitmap is replaced by a 1×1 transparent image);
//   * drop ZONES: panels register a root + `resolve(ev)` describing what is
//     under the pointer; ONE window-capture listener highlights
//     (`.is-drop-target` / `.is-drop-reject`) and dispatches the drop — no
//     per-cell listeners, no enter/leave flicker;
//   * effectAllowed "all" — the inventory used "move", which silently
//     vetoed hotbar.js ("copy") and tinker-panel.js ("link") drops;
//   * the 3D view: retail ItemHolder::AttemptPlaceIn3D (self → pack,
//     creature → give the whole stack — or, with the "Drag item onto player
//     opens trade" option, a player → secure trade — open chest → put in,
//     else drop). It
//     used to be BOTH inventory.js's dropItem AND picking.js's giveObject
//     on the same drop (an item dropped on an NPC was given AND dropped);
//     for drags we started, the capture-phase handler now owns it;
//   * optimistic ledger + server-failure revert (InventoryServerSaveFailed
//     → `inventoryActionFailed`, see rejection_feedback.js).

import { getIconImmediate, getItemIconImmediate, fetchItemIconDataUrl } from "../ui/ac_icon_cache.js";
import {
  createPendingLedger,
  decideItemDrop,
  defaultOnUrlFlag,
  DEFAULT_PLAYER_CONTAINERS_CAPACITY,
  DEFAULT_PLAYER_ITEMS_CAPACITY,
  DROP_TARGET,
  MAIN_PACK_KEY,
  PACKS_KEY,
  pendingExpect,
  planPlaceInBackpack,
  rowUsesPackSlot,
  takeInventoryRows,
} from "./inventory_helpers.js";
import { resolveContainedItemMeta } from "./contained_item_meta.js";
import { CHARACTER_OPTION, isCharacterOptionEnabled } from "../ui/ac_character_options.js";

export const INV_MIME = "application/x-hb-inv-guid";
export const INV_TEXT_MIME = "text/x-hb-item-guid";

const STYLE_ID = "hb-item-drag-style";
const GHOST_ID = "hb-item-drag-ghost";
const TOOLTIP_ID = "hb-item-tooltip";
const TOAST_ID = "hb-item-toast";
const PROMPT_ID = "hb-stack-split";
const SP = "./data/ui-sprites";
const TRANSPARENT_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const hasDom = typeof window !== "undefined" && typeof document !== "undefined";

// ── shared slot + overlay styles ─────────────────────────────────────
// `.hb-islot` is the retail ItemSlot_Generic cell both the inventory grid
// and the external-container strip render, so states look identical:
//   .is-selected  ItemSlot_Icon_Selected 0x06004D09
//   .is-pending   ItemSlot_Icon_Ghosted  0x0600109A (waiting for server)
//   .is-drop-target / .is-drop-reject  drag-accept highlight
export const ITEM_DRAG_CSS = `
  .hb-islot {
    position: relative;
    width: 32px; height: 32px;
    box-sizing: border-box;
    background: url("./sprites/acsprites/icon-slot-bg.png") center / 100% 100% no-repeat;
    image-rendering: pixelated;
    cursor: pointer;
    flex: 0 0 auto;
  }
  .hb-islot.is-empty { opacity: 0.55; cursor: default; }
  .hb-islot > .hb-islot-icon {
    position: absolute; inset: 0;
    background: transparent center / 100% 100% no-repeat;
    image-rendering: pixelated;
    pointer-events: none;
  }
  .hb-islot > .hb-islot-stack {
    position: absolute; right: 1px; bottom: 0;
    font: 10px/1 var(--hbk-font, serif);
    color: #fff;
    text-shadow: 0 0 2px #000, 1px 1px 0 #000;
    pointer-events: none;
    z-index: 3;
  }
  .hb-islot > .hb-islot-fx {
    position: absolute; top: 1px; left: 1px;
    display: flex; gap: 1px;
    pointer-events: none; z-index: 3;
  }
  .hb-islot > .hb-islot-fx > span {
    width: 10px; height: 10px; border-radius: 2px;
    border: 1px solid rgba(0, 0, 0, 0.55);
    background: transparent center / contain no-repeat;
  }
  .hb-islot:hover { filter: brightness(1.18); }
  .hb-islot.is-selected::after {
    content: ""; position: absolute; inset: 0;
    background: url("${SP}/0x06004D09.png") center / 100% 100% no-repeat;
    pointer-events: none; z-index: 4;
  }
  .hb-islot.is-pending::before {
    content: ""; position: absolute; inset: 0;
    background: url("${SP}/0x0600109A.png") center / 100% 100% no-repeat;
    opacity: 0.85;
    pointer-events: none; z-index: 2;
  }
  .hb-islot.is-drag-source { opacity: 0.35; }
  .is-drop-target {
    outline: 1px solid var(--hbk-gold-bright, #f3d27a);
    outline-offset: -1px;
    box-shadow: 0 0 8px rgba(243, 210, 122, 0.6);
    z-index: 5;
  }
  .is-drop-reject {
    outline: 1px solid #e05040;
    outline-offset: -1px;
    box-shadow: 0 0 8px rgba(224, 80, 64, 0.55);
  }
  body.hb-item-dragging, body.hb-item-dragging * { cursor: grabbing !important; }

  #${GHOST_ID} {
    left: -100px; top: -100px;
    display: none;
    background: center / 100% 100% no-repeat;
    image-rendering: pixelated;
  }
  #${GHOST_ID}[data-show="1"] { display: block; }
  #${GHOST_ID} > span {
    position: absolute; right: -2px; bottom: -2px;
    font: 10px/1 var(--hbk-font, serif); color: #fff;
    text-shadow: 0 0 2px #000, 1px 1px 0 #000;
  }

  #${TOOLTIP_ID} { display: none; white-space: pre-line; line-height: 1.35; }
  #${TOOLTIP_ID}[data-show="1"] { display: block; }

  #${TOAST_ID} {
    position: fixed; left: 50%; top: 72px;
    transform: translateX(-50%);
    z-index: 1001;
    max-width: 360px;
    padding: 5px 12px;
    background: url("${SP}/0x06004CC2.png") repeat, #0b0c10;
    border: 1px solid #a8483a;
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.8);
    color: #ffd8c8;
    font: 12px/1.3 var(--hbk-font, serif);
    text-align: center;
    pointer-events: none;
    opacity: 0;
    transition: opacity 140ms ease;
  }
  #${TOAST_ID}[data-show="1"] { opacity: 1; }

  #${PROMPT_ID} {
    z-index: 1002;
    width: 196px;
    display: none;
  }
  #${PROMPT_ID}[data-open="1"] { display: block; }
  #${PROMPT_ID} .hbk-titlebar { cursor: default; }
  #${PROMPT_ID} .hb-split-row {
    display: flex; align-items: center; gap: 6px;
    padding: 8px 8px 4px;
  }
  #${PROMPT_ID} .hb-split-row input.hbk-range { flex: 1 1 auto; min-width: 0; }
  #${PROMPT_ID} .hb-split-row input.hbk-input { width: 58px; text-align: right; }
  #${PROMPT_ID} .hb-split-of { padding: 0 8px 2px; color: var(--hbk-text-dim); font-size: 11px; }
`;

function ensureStyles() {
  if (!hasDom || document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = ITEM_DRAG_CSS;
  document.head.appendChild(s);
}

// ── small accessors ─────────────────────────────────────────────────
export function sessionHandle() {
  if (!hasDom) return null;
  return window.__sessionHandle ?? window.__pluginClient?._handle ?? null;
}
export function localPlayerGuid() {
  try { return (window.getLocalPlayerGuid?.() >>> 0) || 0; } catch (_) { return 0; }
}
function zoomOf(el) {
  const z = Number(el?.currentCSSZoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}
export function flashElement(el, cls = "hb-server-rejected", ms = 420) {
  if (!el?.classList) return;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}
function uiError() { try { window.__audioOptimistic?.playUiError?.(); } catch (_) {} }
function sfx(code, guid) { try { window.__audioOptimistic?.playOptimistic?.(code, guid >>> 0); } catch (_) {} }

let _transparent = null;
if (hasDom) {
  try { _transparent = new Image(); _transparent.src = TRANSPARENT_GIF; } catch (_) { _transparent = null; }
}

// ── pending ledger (shared by every panel) ──────────────────────────
export const pendingOps = createPendingLedger();

// ── drag session ────────────────────────────────────────────────────
let session = null;
let lastDragOverAt = 0;
let highlightEl = null;
let ghostRaf = 0;
let ghostXY = null;
const zones = new Set();

/** The active drag (null when nothing of ours is being dragged). */
export function getDragSession() { return session; }

function ghostEl() {
  let el = document.getElementById(GHOST_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = GHOST_ID;
    el.className = "hbk-drag-ghost";
    el.appendChild(document.createElement("span"));
    document.body.appendChild(el);
  }
  return el;
}

function moveGhost(cx, cy) {
  ghostXY = { cx, cy };
  if (ghostRaf) return;
  ghostRaf = requestAnimationFrame(() => {
    ghostRaf = 0;
    const el = document.getElementById(GHOST_ID);
    if (!el || !ghostXY) return;
    const z = zoomOf(el);
    el.style.left = `${ghostXY.cx / z}px`;
    el.style.top = `${ghostXY.cy / z}px`;
  });
}

function publishDragState(state) {
  try {
    if (!window.__inventory) window.__inventory = { armedGuid: 0 };
    window.__inventory.dragState = state;
    window.dispatchEvent(new CustomEvent("hb:inventory-drag-state-change", { detail: state }));
  } catch (_) {}
}

/**
 * Start a drag from one of our item cells. Call from the cell's
 * `dragstart`. `payload`:
 *   guid, item {name, wcid, stackSize, iconId, validLocations, equipMask,
 *   isPack, maxStackSize?}, owned, sourceList {key, kind}, sourceIndex,
 *   sourceEl, iconUrl?
 */
export function beginItemDrag(ev, payload) {
  const dt = ev?.dataTransfer;
  const guid = (payload?.guid >>> 0) || 0;
  if (!dt || !guid) return false;
  ensureStyles();
  const item = payload.item || {};
  try {
    dt.setData(INV_MIME, String(guid));
    dt.setData(INV_TEXT_MIME, String(guid));
    dt.setData("text/plain", item.name || "");
    // "all": consumers pick their own dropEffect (hotbar "copy", tinker
    // "link", vendor/trade "move"); any value outside effectAllowed makes
    // the browser cancel the drop.
    dt.effectAllowed = "all";
    if (_transparent && _transparent.complete) dt.setDragImage(_transparent, 0, 0);
  } catch (_) {}
  session = {
    guid,
    item,
    owned: payload.owned !== false,
    sourceList: payload.sourceList ?? null,
    sourceIndex: Number.isInteger(payload.sourceIndex) ? payload.sourceIndex : -1,
    sourceEl: payload.sourceEl ?? null,
    shift: !!ev.shiftKey,
    startedAt: performance.now(),
  };
  lastDragOverAt = performance.now();
  const g = ghostEl();
  // Bug 12 (2026-10-07): the ghost is retail's DRAG icon — icon + overlay
  // with the white key replaced by the UI-effect tile, no type background
  // (`IconData::RenderIcons` m_pDragIcon).
  const dragMeta = {
    iconId: item.iconId >>> 0,
    itemType: item.itemType >>> 0,
    uiEffects: item.uiEffects >>> 0,
    iconOverlay: item.iconOverlay >>> 0,
    iconUnderlay: item.iconUnderlay >>> 0,
  };
  const url = payload.iconUrl || getItemIconImmediate(dragMeta, true)
    || getItemIconImmediate(dragMeta) || getIconImmediate(item.iconId >>> 0) || "";
  g.style.backgroundImage = url ? `url("${url}")` : "";
  g.style.backgroundColor = url ? "" : "rgba(40, 34, 24, 0.85)";
  if (!payload.iconUrl && dragMeta.iconId && !getItemIconImmediate(dragMeta, true)) {
    const want = guid;
    fetchItemIconDataUrl(dragMeta, "item-drag", { drag: true }).then((u) => {
      if (typeof u === "string" && session && session.guid === want) {
        g.style.backgroundImage = `url("${u}")`;
        g.style.backgroundColor = "";
      }
    }).catch(() => {});
  }
  const n = Math.max(1, item.stackSize | 0 || 1);
  g.firstChild.textContent = n > 1 ? String(n) : "";
  g.dataset.show = "1";
  moveGhost(ev.clientX, ev.clientY);
  session.sourceEl?.classList?.add("is-drag-source");
  document.body.classList.add("hb-item-dragging");
  publishDragState({ guid, startX: ev.clientX, startY: ev.clientY, isDragging: true });
  return true;
}

function setHighlight(el, ok) {
  if (highlightEl && highlightEl !== el) {
    highlightEl.classList.remove("is-drop-target", "is-drop-reject");
  }
  highlightEl = el || null;
  if (highlightEl) {
    highlightEl.classList.toggle("is-drop-target", ok !== false);
    highlightEl.classList.toggle("is-drop-reject", ok === false);
  }
}

function endSession() {
  if (!session && !highlightEl) return;
  setHighlight(null);
  const s = session;
  session = null;
  const g = document.getElementById(GHOST_ID);
  if (g) g.dataset.show = "0";
  try { s?.sourceEl?.classList?.remove("is-drag-source"); } catch (_) {}
  document.body.classList.remove("hb-item-dragging");
  publishDragState({ guid: 0, startX: 0, startY: 0, isDragging: false });
  try { window.dispatchEvent(new CustomEvent("hb:inventory-drag-end")); } catch (_) {}
}

/**
 * Register a drop zone. `spec.resolve(ev, session)` → hit | null where
 *   hit = { el, ok?: boolean, reason?: string, target, scope? }
 * (`target` is the decideItemDrop target description; `scope` "items" |
 * "paperdoll" also publishes `hb:inventory-drag-over` for dye-preview.js).
 * `spec.drop(ev, session, hit)` performs the drop. Innermost zone wins.
 * Returns an unregister function.
 */
export function registerDropZone(root, spec) {
  if (!root || !spec) return () => {};
  ensureStyles();
  const z = { root, resolve: spec.resolve, drop: spec.drop };
  zones.add(z);
  return () => zones.delete(z);
}

function zoneFor(node) {
  if (!node || typeof node.closest !== "function") node = node?.parentElement ?? null;
  if (!node) return null;
  let best = null;
  for (const z of zones) {
    if (!z.root.isConnected || !z.root.contains(node)) continue;
    if (!best || best.root.contains(z.root)) best = z;
  }
  return best;
}

function hasInvType(dt) {
  try { return !!dt?.types && Array.from(dt.types).includes(INV_MIME); } catch (_) { return false; }
}

export function isWorldDropTarget(node) {
  const el = node && typeof node.closest === "function" ? node : node?.parentElement;
  return !!el && (el.id === "canvas" || !!el.closest?.("#canvas"));
}

// A drag that did not start from one of our cells (index.html's legacy
// <li> list): build a minimal session from the snapshot.
function sessionFromTransfer(ev) {
  let guid = 0;
  try { guid = (parseInt(ev.dataTransfer?.getData(INV_MIME), 10) >>> 0) || 0; } catch (_) { guid = 0; }
  if (!guid) return null;
  const rows = takeInventoryRows(sessionHandle());
  const row = rows.find((r) => r.guid === guid);
  if (!row) return { guid, item: { name: "item" }, owned: false, sourceList: null, sourceIndex: -1, shift: !!ev.shiftKey };
  const isPack = rowUsesPackSlot(row);
  let key = null;
  if ((row.equipMask >>> 0) === 0) key = row.containerId ? row.containerId : (isPack ? PACKS_KEY : MAIN_PACK_KEY);
  return {
    guid,
    item: { ...row, isPack },
    owned: true,
    sourceList: key === null ? null : { key, kind: "inventory" },
    sourceIndex: -1,
    shift: !!ev.shiftKey,
  };
}

function onDragOver(ev) {
  if (session) {
    lastDragOverAt = performance.now();
    session.shift = !!ev.shiftKey;
    moveGhost(ev.clientX, ev.clientY);
  }
  if (!hasInvType(ev.dataTransfer)) return;
  const zone = zoneFor(ev.target);
  if (zone) {
    let hit = null;
    try { hit = zone.resolve(ev, session); } catch (e) { console.warn("[item-drag] resolve failed", e); }
    if (!hit) { setHighlight(null); return; }
    setHighlight(hit.el, hit.ok);
    // Refused targets still ACCEPT the drop (red highlight instead of the
    // browser's no-drop cursor) so the release can say why — retail
    // AcceptDragObject reports "Cannot place item in container list" etc.
    // through DisplayStringInfo on the drop itself.
    ev.preventDefault();
    try { ev.dataTransfer.dropEffect = "move"; } catch (_) {}
    if (hit.scope && session && ev.type === "dragover") {
      const el = hit.el || null;
      try {
        window.dispatchEvent(new CustomEvent("hb:inventory-drag-over", {
          detail: {
            scope: hit.scope,
            hoveredElement: ev.target,
            hoveredSlot: el,
            hoveredGuid: el?.dataset?.guid ?? el?.dataset?.itemGuid ?? null,
            draggedGuid: String(session.guid),
            clientX: ev.clientX,
            clientY: ev.clientY,
            shiftKey: !!ev.shiftKey,
            altKey: !!ev.altKey,
            ctrlKey: !!ev.ctrlKey,
          },
        }));
      } catch (_) {}
    }
    return;
  }
  setHighlight(null);
  if (session && isWorldDropTarget(ev.target)) {
    ev.preventDefault();
    try { ev.dataTransfer.dropEffect = "move"; } catch (_) {}
  }
}

function onDrop(ev) {
  if (!hasInvType(ev.dataTransfer)) return;
  const zone = zoneFor(ev.target);
  const worldDrop = !zone && isWorldDropTarget(ev.target);
  if (!zone && !(worldDrop && session)) return;
  const s = session ?? sessionFromTransfer(ev);
  if (s) s.shift = !!ev.shiftKey || !!s.shift;
  ev.preventDefault();
  ev.stopPropagation();
  setHighlight(null);
  if (!s) return;
  if (zone) {
    let hit = null;
    try { hit = zone.resolve(ev, s); } catch (_) { hit = null; }
    if (hit && hit.ok === false) {
      if (hit.reason) showItemToast(hit.reason);
      uiError();
    } else if (hit) {
      Promise.resolve()
        .then(() => zone.drop(ev, s, hit))
        .catch((e) => console.warn("[item-drag] drop failed", e));
    }
  } else {
    handleWorldDrop(ev, s);
  }
  // dragend normally follows; if the source cell was replaced it may not
  // reach us — the mousemove watchdog below also covers that.
  setTimeout(() => { if (session === s) endSession(); }, 0);
}

// ── 3D world drop — ItemHolder::AttemptPlaceIn3D ─────────────────────
export function describeWorldEntity(guid) {
  const g = guid >>> 0;
  if (!g) return null;
  const me = localPlayerGuid();
  let meta = {};
  try {
    const ent = window.liveScene3d?.entityManager?.entityMap?.get?.(g);
    meta = ent?.meta || ent || {};
  } catch (_) {}
  const itemType = (meta.itemType >>> 0) || 0;
  const h = sessionHandle();
  let ground = 0;
  try {
    const v = typeof h?.groundContainerId === "function" ? h.groundContainerId() : h?.groundContainerId;
    ground = (v >>> 0) || 0;
  } catch (_) { ground = 0; }
  let odf = 0;
  try { odf = ((meta.objDescFlags ?? h?.objectDescFlags?.(g)) >>> 0) || 0; } catch (_) { odf = 0; }
  return {
    guid: g,
    isSelf: g === me,
    // ItemType.Creature 0x10 (players, monsters, NPCs) — retail gives to
    // anything whose object type is a creature (vfptr[6] == 16).
    isCreature: (itemType & 0x10) !== 0 || meta.category === "creature",
    // ODF Player 0x8 — retail ACCWeenieObject::IsPlayer (acclient.c:437199).
    isPlayer: (odf & 0x8) !== 0,
    isOpenContainer: !!ground && ground === g,
    name: meta.name || "",
  };
}

function handleWorldDrop(ev, s) {
  let picked = 0;
  try { picked = (window.__pickEntityAt?.(ev.clientX, ev.clientY) >>> 0) || 0; } catch (_) { picked = 0; }
  const target = { kind: DROP_TARGET.WORLD, entity: picked ? describeWorldEntity(picked) : null };
  resolveDropAction(s, target, { anchor: ev }).then((action) => {
    if (action) executeItemAction(action, s);
  });
}

// ── decision + execution ────────────────────────────────────────────
function defaultCtx() {
  return {
    playerGuid: localPlayerGuid(),
    canUseWith: (a, b) => {
      const h = sessionHandle();
      if (typeof h?.canUseWith !== "function") return null;
      try { return !!h.canUseWith(a >>> 0, b >>> 0); } catch (_) { return null; }
    },
    isCorpse: (g) => isCorpseGuid(g),
    // charopt-4: the "Drag item onto player opens trade" character option.
    dragOnPlayerOpensTrade:
      isCharacterOptionEnabled(CHARACTER_OPTION.DragItemOnPlayerOpensSecureTrade, false) === true,
  };
}

/** Corpse test (ODF Corpse 0x2000 / objectClass) — ACE refuses drops into
 *  non-monster corpses (Player_Inventory.cs), so do the UI. */
export function isCorpseGuid(guid) {
  const g = guid >>> 0;
  try {
    const em = window.liveScene3d?.entityManager;
    const ent = em?.entityMap?.get?.(g) || em?.entityMap?.get?.(String(g)) || null;
    if (!ent) return false;
    const meta = ent.meta || ent;
    if (meta?.objectClass === "Corpse") return true;
    return (((meta?.objDescFlags >>> 0) || 0) & 0x00002000) !== 0;
  } catch (_) { return false; }
}

/**
 * Shift-drop of a stack asks how many (retail took the amount from the
 * toolbar StackSizeEntryBox / GenItemHolder::splitSize; a prompt at the
 * drop point is the browser equivalent), then runs decideItemDrop.
 * Resolves to the action, or null when the player cancelled.
 */
export async function resolveDropAction(s, target, { ctx = null, anchor = null } = {}) {
  if (!s) return null;
  const merged = { ...defaultCtx(), ...(ctx || {}) };
  const stack = Math.max(1, s.item?.stackSize | 0 || 1);
  let split = 0;
  if (s.shift && stack > 1 && target.kind !== DROP_TARGET.DOLL) {
    // A trade takes the whole object (ClientTradeSystem::AttemptToTradeItem
    // has no split size), so it never asks how many.
    const whole = decideItemDrop({ ...s, split: 0 }, target, merged);
    if (whole.op === "trade") return whole;
    const n = await promptStackAmount({
      max: stack,
      initial: Math.max(1, Math.floor(stack / 2)),
      clientX: anchor?.clientX ?? 0,
      clientY: anchor?.clientY ?? 0,
      name: s.item?.name || "",
    });
    if (n == null) return null;
    split = n;
  }
  return decideItemDrop({ ...s, split }, target, merged);
}

function moveExpectation(action, stack, split) {
  if (split) return pendingExpect.reduced(stack);
  if (action.external) return pendingExpect.gone();
  return (row) => !!row && (row.equipMask >>> 0) === 0;
}

/**
 * Send the wire call for `action` and record the optimistic waiting state.
 * `opts.undo` reverts the caller's local order change if the server
 * refuses; `opts.stub` is display data for an item not yet owned.
 * Returns true when something was sent.
 */
export function executeItemAction(action, s, opts = {}) {
  if (!action || action.op === "noop") return false;
  if (action.op === "reject") {
    showItemToast(action.message);
    uiError();
    flashElement(s?.sourceEl);
    return false;
  }
  const h = sessionHandle();
  const guid = ((action.guid ?? s?.guid) >>> 0) || 0;
  const stack = Math.max(1, s?.item?.stackSize | 0 || 1);
  const amount = Math.max(1, Math.min(stack, action.amount ?? stack));
  const split = amount < stack;
  const call = (name, ...args) => {
    if (typeof h?.[name] !== "function") return false;
    try { h[name](...args); return true; } catch (e) { console.warn(`[item-drag] ${name} failed:`, e); return false; }
  };
  const undo = typeof opts.undo === "function" ? opts.undo : null;
  let sent = false;
  switch (action.op) {
    case "usewith": {
      // plugins/tradeskill.js owns the use-with dispatch (and its
      // optional confirmation popup).
      try {
        window.dispatchEvent(new CustomEvent("hb:inventory-item-on-item-drop", {
          detail: { sourceGuid: guid, targetGuid: action.target >>> 0, sourceIsEquipSlot: false, targetIsEquipSlot: false },
        }));
        return true;
      } catch (_) { return false; }
    }
    case "move": {
      if (split) sent = call("splitStackToContainer", guid, action.container >>> 0, action.placement | 0, amount);
      else sent = call("moveItem", guid, action.container >>> 0, action.placement | 0)
        || call("putItemInContainer", guid, action.container >>> 0, action.placement | 0);
      if (sent) {
        if (!s?.owned) sfx(0x8F, guid);
        else if ((s?.item?.equipMask >>> 0) !== 0) sfx(0x8D, guid);
        pendingOps.add(guid, {
          op: split ? "split" : "move",
          toKey: action.external ? null : action.listKey,
          index: action.index | 0,
          external: !!action.external,
          amount,
          expect: moveExpectation(action, stack, split),
          undo,
          stub: opts.stub || null,
        });
      }
      break;
    }
    case "merge": {
      const to = action.target >>> 0;
      sent = call("mergeStacks", guid, to, amount);
      if (sent) {
        // A source we never owned (corpse / ground auto-merge) has no row to
        // shrink: wait for the target stack to grow instead.
        const expect = s?.owned === false && Number.isFinite(action.targetStack)
          ? pendingExpect.grew(to, action.targetStack + amount)
          : pendingExpect.reduced(stack);
        pendingOps.add(guid, { op: "merge", amount, expect, undo });
        // Retail ItemHolder::AttemptMerge → SendNotice_FullMergingItem(from, to):
        // the toolbar moves a shortcut on `from` to `to` (hotbar.js).
        try { window.dispatchEvent(new CustomEvent("hb:item-merge", { detail: { from: guid, to } })); } catch (_) {}
      }
      break;
    }
    case "wield":
    case "wear": {
      const slot = (action.slotMask >>> 0) || 0;
      if (!slot) return false;
      if (split && typeof h?.splitStackToWield === "function") sent = call("splitStackToWield", guid, slot, amount);
      else sent = call("setWielded", guid, slot) || call("wieldFromPack", guid, slot);
      if (sent) {
        sfx(0x8C, guid);
        pendingOps.add(guid, {
          op: "wield", slotMask: slot, amount,
          expect: split ? pendingExpect.reduced(stack) : pendingExpect.wielded(),
          undo, stub: opts.stub || null,
        });
      }
      break;
    }
    case "trade": {
      // charopt-4 — ClientTradeSystem::AttemptToTradeItem (acclient.c:
      // 410566), owned by plugins/trade-panel.js: add to the open trade with
      // this player, refuse while trading with someone else or out of peace
      // mode, else open the trade and add the item once it registers. The
      // item does not move, so there is no pending-ledger entry.
      const attempt = window.__tradePanel?.attemptToTradeItem;
      if (typeof attempt !== "function") return call("openTrade", action.target >>> 0);
      let r = null;
      try { r = attempt(action.target >>> 0, guid); } catch (e) { console.warn("[item-drag] trade failed:", e); }
      if (r?.message) {
        showItemToast(r.message);
        uiError();
        flashElement(s?.sourceEl);
      }
      return !!r?.sent;
    }
    case "give": {
      sent = call("giveObject", action.target >>> 0, guid, amount);
      if (sent) pendingOps.add(guid, { op: "give", amount, expect: pendingExpect.reduced(stack), undo });
      break;
    }
    case "drop": {
      if (split) sent = call("splitStackTo3D", guid, amount);
      else sent = call("dropItem", guid);
      if (sent) {
        sfx(0x90, guid);
        pendingOps.add(guid, { op: "drop", amount, expect: pendingExpect.reduced(stack), undo });
      }
      break;
    }
    default:
      return false;
  }
  if (!sent && undo) { try { undo(); } catch (_) {} }
  return sent;
}

// ── takes and ground pickups — CPlayerSystem::PlaceInBackpack ────────
// `?retailPickup=off` restores the old fixed destination, moveItem(item,
// player, 0): no auto-merge, no side-pack overflow, no open-pack preference.
const RETAIL_PICKUP = hasDom ? defaultOnUrlFlag("retailPickup") : true;

function playerDisplayName() {
  try {
    return String(document.getElementById("char-name")?.textContent
      || window.__pluginClient?.player?.stats?.name || "").trim();
  } catch (_) { return ""; }
}
function handleNumber(h, name) {
  try {
    if (typeof h?.[name] === "number") return h[name];
    if (typeof h?.[name] === "function") return Number(h[name]()) || 0;
  } catch (_) {}
  return 0;
}

/**
 * Where an item the player is about to take goes, against the live
 * inventory (inventory_helpers.planPlaceInBackpack): a matching stack that
 * takes the whole amount, else the side pack open in the inventory, the
 * main pack, the first side pack with room. `item` = {guid, wcid, name,
 * stackSize, itemType, maxStackSize?}.
 */
export function planBackpackPlacement(item, { amount } = {}) {
  const guid = (item?.guid >>> 0) || 0;
  const me = localPlayerGuid();
  if (!guid || !me) return { op: "noop" };
  const isPack = typeof item.isPack === "boolean" ? item.isPack : rowUsesPackSlot(item);
  if (!RETAIL_PICKUP) {
    const stack = Math.max(1, item.stackSize | 0 || 1);
    return {
      op: "move", guid, container: me, placement: 0,
      listKey: isPack ? PACKS_KEY : MAIN_PACK_KEY, index: 0, amount: amount ?? stack,
    };
  }
  const h = sessionHandle();
  let preferredPack = 0;
  try { preferredPack = (window.__inventory?.selectedPack?.() >>> 0) || 0; } catch (_) { preferredPack = 0; }
  return planPlaceInBackpack(takeInventoryRows(h), { ...item, guid, isPack }, {
    playerGuid: me,
    amount,
    preferredPack,
    // charopt-3 — "Use main pack as default pickup destination" (retail
    // PlayerModule::MainPackPreferred, acclient.c:395895).
    mainPackPreferred: isCharacterOptionEnabled(CHARACTER_OPTION.MainPackPreferred, false) === true,
    mainCap: (handleNumber(h, "playerItemsCapacity") >>> 0) || DEFAULT_PLAYER_ITEMS_CAPACITY,
    packsCap: (handleNumber(h, "playerContainersCapacity") >>> 0) || DEFAULT_PLAYER_CONTAINERS_CAPACITY,
    playerName: playerDisplayName(),
  });
}

/**
 * Plan and send a take / pickup through executeItemAction, so it is
 * optimistic like a drag (pending ledger; a ghost stub for a move). `meta`
 * defaults to the wasm entity store's view of the object. Returns
 * {sent, action}; a "reject" action has already been toasted.
 */
export function placeInBackpack(guid, meta = null) {
  const g = (guid >>> 0) || 0;
  // One request per item in flight (a repeated double-click / menu take).
  if (!g || pendingOps.has(g)) return { sent: false, action: { op: "noop" } };
  const item = meta || resolveContainedItemMeta(sessionHandle(), g) || { guid: g, name: "", stackSize: 1 };
  const action = planBackpackPlacement({ ...item, guid: g });
  const stub = action.op === "move"
    ? {
      name: item.name || "", iconId: (item.iconId >>> 0) || 0, stackSize: action.amount ?? item.stackSize ?? 1,
      wcid: (item.wcid >>> 0) || 0, itemType: (item.itemType >>> 0) || 0, equipMask: 0,
    }
    : null;
  const sent = executeItemAction(action, { guid: g, item, owned: false }, { stub });
  return { sent, action };
}

// ── tooltip ─────────────────────────────────────────────────────────
export function showItemTooltip(anchorEl, text) {
  if (!hasDom || !anchorEl || !text) return;
  ensureStyles();
  let tip = document.getElementById(TOOLTIP_ID);
  if (!tip) {
    tip = document.createElement("div");
    tip.id = TOOLTIP_ID;
    tip.className = "hbk-tooltip";
    document.body.appendChild(tip);
  }
  tip.textContent = text;
  tip.dataset.show = "1";
  // Everything in the tooltip's own (zoomed) CSS px: rects are screen px.
  const z = zoomOf(tip);
  const r = anchorEl.getBoundingClientRect();
  const vw = window.innerWidth / z;
  const vh = window.innerHeight / z;
  const tr = tip.getBoundingClientRect();
  const tw = tr.width / z;
  const th = tr.height / z;
  let x = (r.left + r.width / 2) / z - tw / 2;
  let y = r.top / z - th - 6;
  if (y < 4) y = r.bottom / z + 6;
  x = Math.max(4, Math.min(x, vw - tw - 4));
  y = Math.max(4, Math.min(y, vh - th - 4));
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
export function hideItemTooltip() {
  const tip = hasDom ? document.getElementById(TOOLTIP_ID) : null;
  if (tip) tip.dataset.show = "0";
}

// ── toast (retail ECM_UI::SendNotice_DisplayStringInfo text) ────────
let toastTimer = 0;
export function showItemToast(message) {
  if (!hasDom || !message) return;
  ensureStyles();
  let el = document.getElementById(TOAST_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = TOAST_ID;
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.dataset.show = "1";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.dataset.show = "0"; }, 2400);
}

// ── stack split prompt ──────────────────────────────────────────────
let promptState = null;
/**
 * Ask for a split amount. Resolves the chosen 1..max, or null (Esc,
 * Cancel, click elsewhere).
 */
export function promptStackAmount({ max, initial, clientX = 0, clientY = 0, name = "" }) {
  if (!hasDom) return Promise.resolve(null);
  ensureStyles();
  if (promptState) promptState.finish(null);
  const cap = Math.max(1, max | 0);
  let el = document.getElementById(PROMPT_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = PROMPT_ID;
    el.className = "hbk-window";
    el.setAttribute("role", "dialog");
    const mk = (tag, cls, attrs = {}) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      return n;
    };
    const bar = mk("div", "hbk-titlebar");
    bar.appendChild(mk("span", "hbk-title"));
    const row = mk("div", "hb-split-row");
    const rangeIn = mk("input", "hbk-range", { type: "range", min: "1", step: "1" });
    rangeIn.type = "range";
    const numIn = mk("input", "hbk-input", { type: "number", min: "1", step: "1" });
    numIn.type = "number";
    row.append(rangeIn, numIn);
    const foot = mk("div", "hbk-footer");
    const cancel = mk("button", "hbk-btn-small hbk-brown", { "data-act": "cancel" });
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const ok = mk("button", "hbk-btn-small", { "data-act": "ok" });
    ok.type = "button";
    ok.textContent = "Split";
    foot.append(cancel, ok);
    el.append(bar, row, mk("div", "hb-split-of"), foot);
    document.body.appendChild(el);
  }
  const range = el.querySelector("input.hbk-range");
  const num = el.querySelector("input.hbk-input");
  const of = el.querySelector(".hb-split-of");
  const title = el.querySelector(".hbk-title");
  title.textContent = name ? `Split ${name}` : "Split stack";
  range.max = String(cap);
  num.max = String(cap);
  const start = Math.max(1, Math.min(cap, initial | 0 || 1));
  range.value = String(start);
  num.value = String(start);
  of.textContent = `of ${cap}`;
  el.dataset.open = "1";
  // Place at the drop point (HUD px), clamped into the viewport.
  const z = zoomOf(el);
  const pr = el.getBoundingClientRect();
  const w = pr.width / z || 196;
  const hgt = pr.height / z || 100;
  const vw = window.innerWidth / z;
  const vh = window.innerHeight / z;
  el.style.left = `${Math.max(4, Math.min(clientX / z - w / 2, vw - w - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(clientY / z - hgt - 8, vh - hgt - 4))}px`;
  return new Promise((resolve) => {
    const clampVal = (v) => Math.max(1, Math.min(cap, Math.round(Number(v) || 1)));
    const onRange = () => { num.value = range.value; };
    const onNum = () => { range.value = String(clampVal(num.value)); };
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); finish(clampVal(num.value)); }
      else if (e.key === "Escape") { e.preventDefault(); finish(null); }
    };
    const onClick = (e) => {
      const act = e.target?.closest?.("[data-act]")?.dataset?.act;
      if (act === "ok") finish(clampVal(num.value));
      else if (act === "cancel") finish(null);
    };
    const onOutside = (e) => { if (!el.contains(e.target)) finish(null); };
    function finish(v) {
      if (!promptState) return;
      promptState = null;
      el.dataset.open = "0";
      range.removeEventListener("input", onRange);
      num.removeEventListener("input", onNum);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("click", onClick);
      document.removeEventListener("pointerdown", onOutside, true);
      resolve(v);
    }
    promptState = { finish };
    range.addEventListener("input", onRange);
    num.addEventListener("input", onNum);
    el.addEventListener("keydown", onKey);
    el.addEventListener("click", onClick);
    setTimeout(() => document.addEventListener("pointerdown", onOutside, true), 0);
    setTimeout(() => { try { num.focus(); num.select(); } catch (_) {} }, 0);
  });
}

// ── global wiring (once per page) ───────────────────────────────────
function onDragEnd() { endSession(); }
function onMouseMove() {
  // HTML5 DnD suppresses mouse events; seeing one with a live session
  // means the drag ended without a dragend reaching window (source node
  // detached mid-drag).
  if (session && performance.now() - lastDragOverAt > 250) endSession();
}

let _busWired = false;
function wireBus() {
  if (_busWired) return true;
  const client = window.__pluginClient;
  if (!client?.events?.on) return false;
  _busWired = true;
  client.events.on("inventoryActionFailed", (evt) => {
    const p = evt?.detail ?? evt ?? {};
    const g = (p.u32Payload >>> 0) || 0;
    if (g) pendingOps.fail(g);
  });
  client.events.on("playerInventoryChanged", () => {
    pendingOps.bump();
    if (pendingOps.size() === 0) return;
    const rows = takeInventoryRows(sessionHandle());
    pendingOps.sweep(new Map(rows.map((r) => [r.guid, r])));
  });
  return true;
}

if (hasDom && !window.__hbItemDragInstalled) {
  window.__hbItemDragInstalled = true;
  window.addEventListener("dragenter", onDragOver, true);
  window.addEventListener("dragover", onDragOver, true);
  window.addEventListener("drop", onDrop, true);
  window.addEventListener("dragend", onDragEnd, true);
  window.addEventListener("mousemove", onMouseMove, true);
  if (!wireBus()) {
    const t = setInterval(() => { if (wireBus()) clearInterval(t); }, 500);
  }
  // Pending-ledger sweep on a timer too, so TTL expiry repaints even when
  // no inventory event arrives (a lost server echo).
  setInterval(() => {
    if (pendingOps.size() === 0) return;
    pendingOps.sweep(new Map(takeInventoryRows(sessionHandle()).map((r) => [r.guid, r])));
  }, 1500);
  window.__itemDrag = {
    session: () => session,
    pending: () => pendingOps.all(),
    zones: () => zones.size,
    // scene3d/picking.js ground pickup + radial-menu "Take From Container".
    placeInBackpack,
    // vendor-ui.js split-before-sell (shift-drop → amount prompt → split
    // through the pending ledger) without importing this DOM module.
    executeItemAction,
    promptStackAmount,
  };
}
