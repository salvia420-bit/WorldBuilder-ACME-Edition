// Examine view — retail gmExaminationUI (layout 0x2100001C) content,
// mounted in main-panel's body slot or in the standalone floaty
// (plugins/examine-floaty.js, gmFloatyExaminationUI 0x2100006B). Both
// hosts call `mountExamineBody`; the host owns the outer chrome (title =
// the examined thing's name, close button, frame).
//
// User direction 2026-05-22: examine and inventory share the same UI
// pane — clicking an inventory item OR examining a creature in the
// world transitions the same pane.
//
// Two trigger paths:
//   1. From inventory: inventory.js pushes view "examine" with ctx
//      { srcLi, guid, name, fromInventory: true }. We pull stats from
//      the source <li>'s dataset + window.__sessionHandle.playerInventory().
//   2. From the world / right-click menu / target bar:
//      window.__showExamineFor(guid, { name?, fromEntity: true }).
//      EntityMap entry sourced for details.
// Both then request the AppraisalProfile (`requestAppraisal(guid)`) and
// re-render when `objectAppraised` lands.
//
// HUD overhaul 2026-10-05 — retail examination layout. Anatomy, from the
// ui-layout-render manifest of 0x2100001C (retail/m-1C.json, body-relative
// = minus the 25-px title):
//   ItemExamineUI 0x1000012E
//     ItemValueText (4,5) 240×20 "Value: N"  ItemBurdenText (4,25) "Burden: N"
//     ItemIcon (244,12) 32×32 over ItemIconBackground 0x060010F9
//     gold divider 0x060012C5 + right cap 0x060012C4 at y=52
//     ItemDisplayText (11,60) 264×192 + rope scrollbar 0x06004C5F
//     lower divider y=252, parchment 0x0600126F (4,260) 292×73 holding
//     ItemInscriptionText + ItemInscriptionSignatureText
//   BasicCreatureExamineUI 0x10000140
//     CreatureName (creature type) (10,2) 222×54 | vertical divider
//     0x060012C6 at x=230 | LevelInfo "Character"/"Level"/value (237,2)
//     divider y=60, attribute rows (BasicCreatureAttributeInfo 292×20)
//   all on the stone field 0x0600128A.
// Ours: the same top block (lines left, icon/level box right), gold
// divider, a scrolling body of kit `hbk-kv` rows (label dim / value
// retail green) grouped under `hbk-section-title`s in retail's
// ItemExamineUI::SetAppraiseInfo order, the spell list with icons, and
// the inscription on the parchment at the bottom — only when there is
// one. Creatures/players get a health meter and the 3D paperdoll.
// No wire ids / hex reach the player (they live in dev tooltips and the
// `?debug=1` section).

import { PaperdollViewport } from "../ui/ac_paperdoll_viewport.js";
import { resolveBindingIcon, resolveSpellIcon } from "../ui/ac_entity_icon.js";
import {
  uiEffectIconsEnabled,
  uiEffectIconsFor,
  uiEffectTintCss,
} from "../scene3d/vfx/ui_effects_registry.js";
import { fetchIconDataUrl } from "../ui/ac_icon_cache.js";
import {
  itemTypeLabel, equipSlotsLabel, skillName, damageTypeLabel,
  formatThousands, protectionText, weaponSpeedText, damageRangeText,
  highlightState, healthModel, examineHeaderModel, creatureAttributeRows, pkStatusText,
} from "./examine_format.js";

const VIEW_ID_STYLE = "hb-examine-view-style";
const SP = "./data/ui-sprites";

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = VIEW_ID_STYLE;
  style.textContent = `
    .hb-exa-root {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      pointer-events: auto;
      overflow: hidden;
      font-family: var(--hbk-font);
      font-size: 12px;
      color: var(--hbk-text);
      /* Retail examination stone field (0x0600128A, tiled). */
      background: url("${SP}/0x0600128A.png") 0 0 / 220px 77px repeat, #1d1912;
    }
    .hb-exa-head {
      flex: 0 0 auto;
      display: flex;
      align-items: stretch;
      gap: 8px;
      min-height: 46px;
      padding: 5px 8px 3px;
      box-sizing: border-box;
    }
    .hb-exa-headtext {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 2px;
    }
    .hb-exa-line {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      text-shadow: 0 1px 0 #000;
    }
    .hb-exa-line.is-warn { color: var(--hbk-warn); }
    .hb-exa-line.is-muted { color: var(--hbk-text-dim); font-style: italic; }
    /* ItemIcon over ItemIconBackground 0x060010F9. */
    .hb-exa-iconbox {
      position: relative;
      flex: 0 0 32px;
      width: 32px;
      height: 32px;
      align-self: center;
      background: url("${SP}/0x060010F9.png") center / 100% 100% no-repeat;
      box-shadow: 0 0 0 1px #000, 0 0 6px rgba(0, 0, 0, 0.8);
      image-rendering: pixelated;
    }
    .hb-exa-iconbox > img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      image-rendering: pixelated;
    }
    /* LevelInfo box behind the vertical divider 0x060012C6. */
    .hb-exa-levelbox {
      flex: 0 0 66px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding-left: 9px;
      background: url("${SP}/0x060012C6.png") left center / 7px 100% no-repeat;
      text-align: center;
    }
    .hb-exa-levellabel { color: var(--hbk-text-dim); font-size: 10px; line-height: 1.15; letter-spacing: 0.03em; }
    .hb-exa-levelvalue { color: var(--hbk-gold-bright); font-size: 18px; line-height: 1.2; text-shadow: 0 1px 0 #000; }
    .hb-exa-root > .hbk-divider { flex: 0 0 auto; margin: 0 0 2px; }
    .hb-exa-health { flex: 0 0 auto; height: 13px; margin: 2px 8px 4px; }
    .hb-exa-body {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
      padding: 2px 4px 8px 8px;
    }
    .hb-exa-body > * { flex-shrink: 0; }
    /* Creatures: retail BasicCreatureExamineUI leads with the attribute
       block; the gear/dye preview follows it. Players: the paperdoll
       leads, like retail's Exam_PaperDoll page. */
    .hb-exa-body.is-creature > .hb-exa-paperdoll-wrap { order: 2; margin-top: 6px; }
    .hb-exa-body .hbk-section-title { margin: 7px 0 2px -4px; }
    .hb-exa-body > .hbk-section-title:first-child,
    .hb-exa-body > div:first-child > .hbk-section-title:first-child { margin-top: 1px; }
    .hb-exa-body .hbk-kv { min-height: 17px; align-items: baseline; padding: 1px 2px; }
    .hb-exa-body .hbk-kv > :first-child { flex: 0 1 auto; white-space: nowrap; }
    .hb-exa-body .hbk-kv > :last-child { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
    .hb-exa-body .hbk-kv.is-buffed > :last-child { color: #c6ff9a; text-shadow: 0 0 4px rgba(138, 239, 109, 0.55); }
    .hb-exa-body .hbk-kv.is-buffed > :last-child::after { content: " \\25B2"; font-size: 9px; }
    .hb-exa-body .hbk-kv.is-debuffed > :last-child { color: var(--hbk-warn); }
    .hb-exa-body .hbk-kv.is-debuffed > :last-child::after { content: " \\25BC"; font-size: 9px; }
    .hb-exa-body .hbk-kv.is-incomplete > :last-child { opacity: 0.65; font-style: italic; }
    .hb-exa-grid2 { display: grid; grid-template-columns: 1fr 1fr; column-gap: 14px; }
    .hb-exa-spells { display: flex; flex-direction: column; gap: 1px; margin: 1px 0 2px; }
    .hb-exa-spell { display: flex; align-items: center; gap: 6px; min-height: 18px; }
    .hb-exa-spell > i {
      flex: 0 0 16px; width: 16px; height: 16px;
      background: center / contain no-repeat;
      image-rendering: pixelated;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.7);
    }
    .hb-exa-prose {
      padding: 2px 2px 0;
      line-height: 1.4;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      user-select: text;
    }
    .hb-exa-prose.is-flavor { font-style: italic; color: var(--hbk-text); }
    .hb-exa-fail { padding: 8px 2px; color: var(--hbk-warn); font-style: italic; }
    .hb-exa-pending { padding: 6px 2px; color: var(--hbk-text-dim); font-style: italic; }
    /* Embedded PaperdollViewport (Wave 3.B) — the examined creature /
       player rig with its equipped armor + dye palette, at the top of
       the scrolling body (retail Exam_PaperDoll 0x10000148). */
    .hb-exa-paperdoll-wrap {
      position: relative;
      width: 100%;
      height: 180px;
      margin: 0 0 4px 0;
      background: radial-gradient(ellipse at 50% 60%, rgba(60, 50, 34, 0.55), rgba(10, 8, 6, 0.75));
      border: 1px solid var(--hbk-gold-deep);
      box-sizing: border-box;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .hb-exa-paperdoll-wrap canvas { display: block; pointer-events: none; }
    .hb-exa-paperdoll-empty {
      font-size: 11px;
      color: var(--hbk-text-dim);
      font-style: italic;
      padding: 8px;
      text-align: center;
    }
    /* Inscription parchment (ItemExamBackground_Paper 0x0600126F). */
    .hb-exa-insc-wrap { flex: 0 0 auto; display: flex; flex-direction: column; }
    .hb-exa-insc-wrap > .hbk-divider { margin: 0; }
    .hb-exa-paper {
      height: 72px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      padding: 5px 10px 4px;
      background: url("${SP}/0x0600126F.png") center / 100% 100% no-repeat, #b9965a;
      color: #2b1b08;
      font-style: italic;
      line-height: 1.35;
    }
    .hb-exa-paper-text {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      user-select: text;
      scrollbar-width: thin;
      scrollbar-color: #6b4a1e transparent;
    }
    .hb-exa-paper.is-blank .hb-exa-paper-text { opacity: 0.6; }
    .hb-exa-paper-sig { flex: 0 0 auto; text-align: right; font-size: 11px; color: #4a3010; }
  `;
  document.head.appendChild(style);
}

// ── Small DOM builders ─────────────────────────────────────────────────

function kvRow(parent, label, value, { tone = null, title = null } = {}) {
  if (value == null || value === "") return null;
  const row = document.createElement("div");
  row.className = "hbk-kv";
  if (tone === "buffed") { row.classList.add("is-buffed"); row.title = "Raised by an enchantment"; }
  else if (tone === "debuffed") { row.classList.add("is-debuffed"); row.title = "Lowered by an enchantment"; }
  // enchstats-4: retail font 3 — the value of a failed assess.
  else if (tone === "incomplete") { row.classList.add("is-incomplete"); row.title = "Assess failed"; }
  if (title) row.title = title;
  const l = document.createElement("span");
  l.textContent = label;
  const v = document.createElement("span");
  v.textContent = String(value);
  row.appendChild(l);
  row.appendChild(v);
  parent.appendChild(row);
  return row;
}

/** enchstats-4: BasicCreatureExamineUI's attribute grid + vital rows from
 *  `creatureAttributeRows` (rows with a null value are skipped). */
function renderCreatureAttributeBlock(wrapEl, rows) {
  sectionTitle(wrapEl, "Attributes");
  const grid = document.createElement("div");
  grid.className = "hb-exa-grid2";
  for (const r of rows) {
    if (r.kind === "attribute") kvRow(grid, r.label, r.value, { tone: r.tone });
  }
  wrapEl.appendChild(grid);
  for (const r of rows) {
    if (r.kind === "vital") kvRow(wrapEl, r.label, r.value, { tone: r.tone });
  }
}

function sectionTitle(parent, text) {
  const s = document.createElement("div");
  s.className = "hbk-section-title";
  s.textContent = text;
  parent.appendChild(s);
  return s;
}

function prose(parent, text, cls = "") {
  const d = document.createElement("div");
  d.className = `hb-exa-prose${cls ? ` ${cls}` : ""}`;
  d.textContent = String(text);
  parent.appendChild(d);
  return d;
}

function debugEnabled() {
  try { return new URLSearchParams(window.location?.search ?? "").get("debug") === "1"; }
  catch (_) { return false; }
}

const hex8 = (n) => `0x${(Number(n) >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;

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

function getHandle() {
  return window.__sessionHandle ?? window.__pluginClient?._handle ?? null;
}

function getItemByGuid(guid) {
  try {
    const handle = getHandle();
    if (!handle?.playerInventory) return null;
    const items = handle.playerInventory();
    return items.find((it) => String(it.guid) === String(guid)) || null;
  } catch (_) { return null; }
}

function getEntityEntry(guid) {
  const em = window.liveScene3d?.entityManager;
  return em?.entityMap?.get?.(guid) || em?.entityMap?.get?.(String(guid)) || null;
}

/** Parsed AppraisalProfile snapshot for `guid`, or null. */
function readAppraisal(guid) {
  if (!guid) return null;
  try {
    const json = getHandle()?.getObjectAppraisal?.(guid >>> 0);
    if (typeof json === "string" && json.length > 0) return JSON.parse(json);
  } catch (_) {}
  return null;
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
    const handle = getHandle();
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

// books-journal-3 (2026-10-08): retail writes inscriptions HERE, not in the
// book window. ItemExamineUI::SetInscription (acclient.c:229275-229380)
// shows the inscription box only for an Inscribable item (PublicWeenieDesc
// bitfield 0x2); with no ScribeName it reads "<Inscribe here>". The save
// path (:229410-229449) sends CM_Writing::Event_SetInscription only when the
// text changed. ACE accepts it for an owned Inscribable item that is
// unsigned or signed by this character (Player_Inventory.cs
// HandleActionSetInscription). `?examineInscribe=off` (or 0/false) keeps
// the old read-only parchment.
export const ODF_INSCRIBABLE = 0x2;
export const INSCRIBE_PLACEHOLDER = "<Inscribe here>";
const INSCRIPTION_MAX = 280;

let _examineInscribeOn = null;
export function examineInscribeEnabled(search) {
  if (typeof search === "string") {
    const v = new URLSearchParams(search).get("examineInscribe")?.toLowerCase();
    return !(v === "off" || v === "0" || v === "false");
  }
  if (_examineInscribeOn === null) {
    try { _examineInscribeOn = examineInscribeEnabled(globalThis.location?.search ?? ""); }
    catch (_) { _examineInscribeOn = true; }
  }
  return _examineInscribeOn;
}

/**
 * Pure gate: may the local player write this item's inscription?
 * @param {{descFlags:number, owned:boolean, scribeName?:string|null, myName?:string|null}} o
 */
export function inscriptionEditable({ descFlags = 0, owned = false, scribeName = null, myName = null } = {}) {
  if (((descFlags >>> 0) & ODF_INSCRIBABLE) === 0) return false;
  if (!owned) return false;
  const scribe = typeof scribeName === "string" ? scribeName.trim() : "";
  if (!scribe) return true;
  return typeof myName === "string" && myName.trim() !== "" && scribe === myName.trim();
}

function localPlayerName() {
  try {
    const g = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
    const h = getHandle();
    if (!g || !h) return null;
    const n = typeof h.objectName === "function" ? h.objectName(g) : null;
    return typeof n === "string" && n ? n : null;
  } catch (_) { return null; }
}

function scribeNameFor(guid) {
  const fromAppraisal = readAppraisal(guid)?.properties?.strings?.ScribeName;
  if (typeof fromAppraisal === "string") return fromAppraisal;
  try {
    const v = getHandle()?.objectStringProperty?.(guid >>> 0, 8);
    return typeof v === "string" ? v : null;
  } catch (_) { return null; }
}

function canWriteInscription(guid) {
  if (!guid || !examineInscribeEnabled()) return false;
  const h = getHandle();
  if (typeof h?.objectDescFlags !== "function" || typeof h?.setInscription !== "function") return false;
  let descFlags = 0;
  try { descFlags = h.objectDescFlags(guid >>> 0) >>> 0; } catch (_) { descFlags = 0; }
  return inscriptionEditable({
    descFlags,
    owned: !!getItemByGuid(guid),
    scribeName: scribeNameFor(guid),
    myName: localPlayerName(),
  });
}

// The inscription being written (one at a time): saved on blur and when the
// examine body unmounts. Re-renders skip the paper while it is being edited.
let _inscEdit = null; // { guid, el, original }

function commitInscriptionEdit() {
  const ed = _inscEdit;
  if (!ed) return false;
  _inscEdit = null;
  let text = String(ed.el?.textContent ?? "");
  if (text === INSCRIBE_PLACEHOLDER) text = "";
  if (text.length > INSCRIPTION_MAX) text = text.slice(0, INSCRIPTION_MAX);
  if (text === ed.original) return false;
  try {
    getHandle()?.setInscription?.(ed.guid >>> 0, text);
    return true;
  } catch (e) {
    console.warn("[examine] setInscription failed:", e);
    return false;
  }
}

// Retail ItemInscriptionText + ItemInscriptionSignatureText on the
// parchment. Writable per the retail gate above; read-only otherwise.
function renderInscription(wrapEl, guid) {
  if (!wrapEl) return;
  // Don't tear the parchment down under the player's cursor.
  if (_inscEdit && _inscEdit.guid === (guid >>> 0) && _inscEdit.el?.isConnected &&
      wrapEl.contains(_inscEdit.el)) return;
  wrapEl.innerHTML = "";
  const writable = canWriteInscription(guid);
  let info = getInscriptionForGuid(guid);
  if (!info && writable) info = { text: "", ownedByPlayer: true };
  if (!info) { wrapEl.style.display = "none"; return; }
  wrapEl.style.display = "";
  const divider = document.createElement("div");
  divider.className = "hbk-divider";
  wrapEl.appendChild(divider);
  const paper = document.createElement("div");
  paper.className = "hb-exa-paper";
  // Retail clamp at ~280 chars; ACE rejects longer payloads anyway.
  const trimmed = info.text.length > 280 ? info.text.slice(0, 280) : info.text;
  const text = document.createElement("div");
  text.className = "hb-exa-paper-text";
  if (writable) {
    // Retail: an unsigned inscribable item reads "<Inscribe here>".
    text.textContent = trimmed.length > 0 ? trimmed : INSCRIBE_PLACEHOLDER;
    if (trimmed.length === 0) paper.classList.add("is-blank");
    text.contentEditable = "true";
    text.spellcheck = true;
    text.setAttribute("role", "textbox");
    text.setAttribute("aria-label", "Inscription");
    const g = guid >>> 0;
    text.addEventListener("focus", () => {
      if (text.textContent === INSCRIBE_PLACEHOLDER) text.textContent = "";
      paper.classList.remove("is-blank");
      _inscEdit = { guid: g, el: text, original: trimmed };
    });
    text.addEventListener("blur", () => {
      if (_inscEdit?.el === text) commitInscriptionEdit();
      if (!text.textContent) { text.textContent = INSCRIBE_PLACEHOLDER; paper.classList.add("is-blank"); }
    });
    text.addEventListener("keydown", (ev) => {
      // Keep typing out of the game's key bindings; Esc / Enter leave the box.
      ev.stopPropagation();
      if (ev.key === "Escape") { text.textContent = trimmed; text.blur(); }
      else if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); text.blur(); }
    });
  } else {
    text.textContent = trimmed.length > 0 ? trimmed : "(The inscription is blank.)";
    if (trimmed.length === 0) paper.classList.add("is-blank");
  }
  paper.appendChild(text);
  const scribe = readAppraisal(guid)?.properties?.strings?.ScribeName;
  if (scribe && trimmed.length > 0) {
    const sig = document.createElement("div");
    sig.className = "hb-exa-paper-sig";
    sig.textContent = `— ${scribe}`;
    paper.appendChild(sig);
  }
  wrapEl.appendChild(paper);
}

// Inventory item → identity rows (the name/value/burden live in the
// title + header). `model` collects what the header needs.
function populateFromInventory(body, ctx, model) {
  const srcLi = ctx.srcLi;
  const guid = ctx.guid ?? srcLi?.dataset?.guid;
  const item = getItemByGuid(guid);
  model.kind = "item";
  model.item = item;
  model.name = srcLi?.querySelector?.(".name")?.textContent || item?.name || ctx.name || model.name;
  const typeMask = item?.itemType ?? Number(srcLi?.dataset?.typeBit ?? 0);
  const rows = document.createElement("div");
  kvRow(rows, "Type", itemTypeLabel(typeMask));
  if (item) {
    if (item.stackSize > 1) kvRow(rows, "Stack", formatThousands(item.stackSize));
    const equip = (item.equipMask >>> 0) || 0;
    if (equip) kvRow(rows, "Equipped", equipSlotsLabel(equip));
    else if ((item.validLocations >>> 0) && ((item.itemType >>> 0) & 0x0E)) {
      // Armor / clothing / jewelry: where it can be worn.
      kvRow(rows, "Worn on", equipSlotsLabel(item.validLocations));
    }
  }
  if (rows.childElementCount ?? rows.children?.length) {
    sectionTitle(body, "Item");
    body.appendChild(rows);
  }
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
function setNoteText(el, text) { el.textContent = text; }

function renderEntityPaperdoll(wrapEl, guid) {
  if (!wrapEl) return null;
  wrapEl.innerHTML = "";
  const g = (Number(guid) >>> 0);
  if (!g) {
    const note = document.createElement("div");
    note.className = "hb-exa-paperdoll-empty";
    setNoteText(note, "(nothing selected)");
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
    setNoteText(note, meta
      ? "(no preview available)"
      : "(too far away to preview)");
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
    setNoteText(note, "(no preview for items)");
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

// World entity → kind + header facts; wire ids / raw state only under
// `?debug=1`. `model` collects what the header + health meter need.
function populateFromEntity(body, ctx, model) {
  const guid = (ctx.guid >>> 0) || 0;
  const ent = guid ? getEntityEntry(guid) : null;
  // === Wave 6 polish — examine meta-vs-flat read (2026-05-28) ===
  // Real `EntityInstance` objects (entities.js:798) store their
  // wire-supplied fields (type/level/health/etc.) under `inst.meta` —
  // the spawn meta dict built by `toMeta(upd)` in scene3d/loop.js. The
  // debug stub at `__examineTargetDebug.open` flattens those onto the
  // root for testability. Read meta-first, fall back to flat for the
  // debug stub.
  const meta = ent?.meta || null;
  const v = (key) => meta?.[key] ?? ent?.[key];
  if (!guid) {
    model.kind = "empty";
    return;
  }
  model.name = v("name") || ctx.name || model.name;
  model.loading = !ent;
  // HUD rec #52 (2026-06-16) — player vs creature dispatch via
  // `ObjectDescriptionFlag::PLAYER` (0x08) — retail gmExamineUI::
  // SetTargetGuid's CharExamineUI branch — plus the canonical
  // WorldObjectManager class when it's populated. PLAYER_KILLER (0x20)
  // → the red "Player Killer" line (retail PlayerKillerText).
  const objDescFlags = (v("objDescFlags") ?? 0) >>> 0;
  let womPlayer = false;
  try {
    const wo = window.__wom?.get?.(guid);
    womPlayer = !!wo && (wo.canonicalObjectClass === "Player" || wo.className === "Player");
  } catch (_) {}
  model.isPlayer = (objDescFlags & 0x08) !== 0 || womPlayer;
  // pk-5: the LIVE PK bits (a PlayerKillerStatus update after spawn).
  let liveOdf = 0;
  try { liveOdf = (window.__sessionHandle?.objectDescFlags?.(guid >>> 0) ?? 0) >>> 0; } catch (_) { liveOdf = 0; }
  const pkOdf = liveOdf || objDescFlags;
  model.isPK = model.isPlayer && (pkOdf & 0x20) !== 0;
  model.pkStatus = model.isPlayer ? pkStatusText(pkOdf) : null;
  const itemType = (v("itemType") ?? 0) >>> 0;
  const isCreature = (itemType & 0x10) !== 0 || (!itemType && Number(v("type")) === 16);
  model.kind = model.isPlayer ? "player" : (isCreature ? "creature" : "item");
  model.meta = { level: v("level") };
  const hp = v("health");
  const hpMax = v("maxHealth") ?? v("healthMax");
  if (hp != null && hpMax != null) model.health = { cur: hp, max: hpMax };

  if (debugEnabled()) {
    sectionTitle(body, "Debug");
    kvRow(body, "GUID", hex8(guid));
    kvRow(body, "Class", v("classId") != null ? `0x${Number(v("classId")).toString(16)}` : null);
    kvRow(body, "Wcid", v("wcid"));
    kvRow(body, "Type", v("type"));
    kvRow(body, "ItemType", itemType ? hex8(itemType) : null);
    const p = v("position");
    if (p) kvRow(body, "Position", `${p.x?.toFixed?.(1) ?? p.x}, ${p.y?.toFixed?.(1) ?? p.y}, ${p.z?.toFixed?.(1) ?? p.z}`);
    const landblock = v("landblock");
    if (landblock != null) kvRow(body, "Landblock", hex8(landblock));
    kvRow(body, "Level", v("level"));
    kvRow(body, "Health", v("health"));
    kvRow(body, "Stamina", v("stamina"));
    kvRow(body, "Mana", v("mana"));
    const motionState = v("motionState");
    if (motionState != null) kvRow(body, "Motion", hex8(motionState));
    const heading = v("heading");
    if (heading != null) kvRow(body, "Heading", (heading * 180 / Math.PI).toFixed(1) + "°");
  }
}

// EX-05 (2026-06-05) — render the AppraisalProfile snapshot returned by
// `getObjectAppraisal(guid)` into `wrapEl`, in retail
// ItemExamineUI::SetAppraiseInfo order (acclient.c 235257): tinkering →
// weapon & armor data → armor mods → magic → wield requirements →
// properties / usage → spells → description. Creatures get
// BasicCreatureExamineUI's attribute block instead.
// Hidden (display:none) when no appraisal has landed yet for this GUID.
function renderAppraisal(wrapEl, guid, snapshot, kind) {
  if (!wrapEl) return;
  wrapEl.innerHTML = "";
  if (!guid || !snapshot) { wrapEl.style.display = "none"; return; }
  wrapEl.style.display = "";

  // HUD rec #53 (2026-06-16) — IdentifyResponse-level gating.
  // identifySuccess=false means ACE rolled an Identify check the
  // player's skill failed (Player_Skills.cs HandleIdentifyResponse).
  // identifyFlags is the IdentifyResponseFlags bitmask — only render
  // sections whose bit is set so we don't show stale data from a prior
  // identify of a different target type. Snapshots NOT produced by an
  // Identify (e.g. ViewContents) default `identifySuccess=true` + flags=0
  // in wasm — which falls through to "render everything".
  const identifySuccess = snapshot.identifySuccess !== false;
  const identifyFlags = (snapshot.identifyFlags ?? 0) >>> 0;
  const gated = identifyFlags !== 0;
  const flagBit = (mask) => !gated || (identifyFlags & mask) !== 0;
  const IDENTIFY_FLAG_SPELL_BOOK       = 0x0010;
  const IDENTIFY_FLAG_WEAPON_PROFILE   = 0x0020;
  const IDENTIFY_FLAG_HOOK_PROFILE     = 0x0040;
  const IDENTIFY_FLAG_ARMOR_PROFILE    = 0x0080;
  const IDENTIFY_FLAG_CREATURE_PROFILE = 0x0100;
  const IDENTIFY_FLAG_ARMOR_ENCH       = 0x0200;
  const IDENTIFY_FLAG_WEAPON_ENCH      = 0x0800;
  const IDENTIFY_FLAG_ARMOR_LEVELS     = 0x4000;
  if (!identifySuccess) {
    const fail = document.createElement("div");
    fail.className = "hb-exa-fail";
    fail.textContent = (kind === "creature" || kind === "player")
      ? "You fail to assess this creature. You will try again shortly."
      : "Your skill is not high enough to identify this item. You will try again shortly.";
    wrapEl.appendChild(fail);
    // enchstats-4 (2026-10-08): retail still renders the creature block on
    // a failed assess (AttributeInfoRegion / Attribute2ndInfoRegion::
    // Update(AppraisalProfile*), acclient.c:285975 / :286022): attributes
    // "???" and Health as "N %" in the incomplete font. The wasm stub ships
    // the failed profile as `failedCreatureProfile` (never merged).
    const fcp = snapshot.failedCreatureProfile || null;
    if (fcp && (kind === "creature" || kind === "player")) {
      renderCreatureAttributeBlock(wrapEl, creatureAttributeRows(fcp, false));
    }
    return;
  }

  const props = snapshot.properties || {};
  const ints = props.ints || {};
  const floats = props.floats || {};
  const strings = props.strings || {};
  const cp = snapshot.creatureProfile || null;
  const ap = snapshot.armorProfile || null;
  const wp = snapshot.weaponProfile || null;
  const hp = snapshot.hookProfile || null;
  const al = snapshot.armorLevels || null;
  // Enchantment highlights (retail tints the line green / red).
  const ah = flagBit(IDENTIFY_FLAG_ARMOR_ENCH) ? snapshot.armorHighlight : 0;
  const ac = flagBit(IDENTIFY_FLAG_ARMOR_ENCH) ? snapshot.armorColor : 0;
  const wh = flagBit(IDENTIFY_FLAG_WEAPON_ENCH) ? snapshot.weaponHighlight : 0;
  const wc = flagBit(IDENTIFY_FLAG_WEAPON_ENCH) ? snapshot.weaponColor : 0;
  const armorTone = (bit) => highlightState(ah, ac, bit);
  const weaponTone = (bit) => highlightState(wh, wc, bit);
  const sec = (text) => sectionTitle(wrapEl, text);
  const row = (label, value, opts) => kvRow(wrapEl, label, value, opts);

  // === UiEffects magic-effect badges (Track A A0, 2026-06-24) ===
  // `?uiEffectIcons` (default OFF) — render the item's UiEffects (PropertyInt
  // 18) as colored badge(s). UiEffects is a 2D icon overlay in retail
  // (acclient IconData::RenderIcons), so this lives in the DOM/HUD layer and
  // never touches the WebGL canvas. Flag-off = byte-identical (block never runs).
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
        const ic = document.createElement("span");
        ic.style.cssText = "width:14px;height:14px;display:inline-block;background:center/contain no-repeat;";
        b.appendChild(ic);
        const txt = document.createElement("span");
        txt.textContent = f.name;
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

  // === Creature: BasicCreatureExamineUI attributes + vitals ===
  // Field-name note (2026-07-04): CreatureProfile has no `vitals`
  // sub-object — health/health_max are top-level, stamina/mana (+ maxes)
  // live under `attributes`.
  if (flagBit(IDENTIFY_FLAG_CREATURE_PROFILE)
      && (cp?.attributes || cp?.health != null || ints.Strength != null
        || ints.Endurance != null || ints.Coordination != null
        || ints.Quickness != null || ints.Focus != null || ints.Self != null)) {
    // enchstats-4 (2026-10-08): rows (incl. the Self row — the wire field is
    // `self_attr` — and the buff/debuff tints from `cp.buffs`) come from the
    // pure examine_format.js helper.
    renderCreatureAttributeBlock(wrapEl, creatureAttributeRows(cp, true, ints));
  }
  // Skills: data-blocked — CreatureProfile carries no per-skill data on
  // the wire (types.rs), so there is nothing to render until a
  // SkillProfile lands.

  // === Tinkering (Appraisal_ShowTinkeringInfo) ===
  const tinkerRows = [];
  if (ints.ItemWorkmanship != null) tinkerRows.push(["Workmanship", ints.ItemWorkmanship]);
  if (ints.NumTimesTinkered > 0) tinkerRows.push(["Tinkered", `${ints.NumTimesTinkered} time${ints.NumTimesTinkered === 1 ? "" : "s"}`]);
  if (strings.TinkerName) tinkerRows.push(["Last tinkered by", strings.TinkerName]);
  if (strings.ImbuerName) tinkerRows.push(["Imbued by", strings.ImbuerName]);

  // === Weapon & armor data (Appraisal_ShowWeaponAndArmorData /
  //     Appraisal_ShowArmorMods). ArmorProfile carries per-damage-type
  //     multipliers; the overall AL is PropertyInt.ArmorLevel (28). ===
  const showArmor = flagBit(IDENTIFY_FLAG_ARMOR_PROFILE) && ap;
  const showWeapon = flagBit(IDENTIFY_FLAG_WEAPON_PROFILE) && wp;
  const showHook = flagBit(IDENTIFY_FLAG_HOOK_PROFILE) && hp;
  const showArmorLevels = flagBit(IDENTIFY_FLAG_ARMOR_LEVELS) && al;
  const showArmorLevelInt = flagBit(IDENTIFY_FLAG_ARMOR_PROFILE) && ints.ArmorLevel != null;
  if (tinkerRows.length || showWeapon || showArmorLevelInt || showArmor) {
    sec(showWeapon ? "Weapon" : (showArmor || showArmorLevelInt) ? "Armor" : "Craftsmanship");
    for (const [l, val] of tinkerRows) row(l, val);
    if (showWeapon) {
      // Retail weapon block: Skill, Damage "min - max, Type", Speed.
      const dmg = damageRangeText(wp.damage, wp.damage_variance);
      const dtype = damageTypeLabel(wp.damage_type);
      if (wp.weapon_skill != null) row("Skill", skillName(wp.weapon_skill), { tone: weaponTone(0x0001) });
      if (dmg) row("Damage", dtype ? `${dmg}, ${dtype}` : dmg, { tone: weaponTone(0x0008) || weaponTone(0x0010) });
      if (wp.weapon_time != null) row("Speed", weaponSpeedText(wp.weapon_time), { tone: weaponTone(0x0004) });
      if (wp.damage_mod != null && Number(wp.damage_mod) !== 1) {
        row("Damage bonus", `${Math.round((Number(wp.damage_mod) - 1) * 100)}%`, { tone: weaponTone(0x0020) });
      }
    }
    if (showArmorLevelInt) row("Armor Level", formatThousands(ints.ArmorLevel), { tone: armorTone(0x0001) });
    if (showArmor) {
      const AL = Number(ints.ArmorLevel);
      const prot = (label, mod, bit) => {
        if (mod == null) return;
        row(label, protectionText(mod, Number.isFinite(AL) ? AL : null), { tone: armorTone(bit) });
      };
      prot("Slashing",    ap.slashing,    0x0002);
      prot("Piercing",    ap.piercing,    0x0004);
      prot("Bludgeoning", ap.bludgeoning, 0x0008);
      prot("Fire",        ap.fire,        0x0020);
      prot("Cold",        ap.cold,        0x0010);
      prot("Acid",        ap.acid,        0x0040);
      prot("Electric",    ap.lightning,   0x0080);
      prot("Nether",      ap.nether,      0);
    }
  }
  // Per-slot armor-level breakdown (ArmorLevels, 9 body locations).
  if (showArmorLevels) {
    const slots = [
      ["head", "Head"], ["chest", "Chest"], ["abdomen", "Abdomen"],
      ["upper_arm", "Upper Arms"], ["lower_arm", "Lower Arms"], ["hand", "Hands"],
      ["upper_leg", "Upper Legs"], ["lower_leg", "Lower Legs"], ["foot", "Feet"],
    ].filter(([k]) => al[k] != null);
    if (slots.length) {
      sec("Armor by Location");
      const grid = document.createElement("div");
      grid.className = "hb-exa-grid2";
      for (const [key, label] of slots) kvRow(grid, label, formatThousands(al[key]));
      wrapEl.appendChild(grid);
    }
  }

  // === Magic (Appraisal_ShowMagicInfo: "Spellcraft: %d." "Mana: %d / %d."
  //     + Appraisal_ShowActivationRequirements arcane-lore difficulty) ===
  const sb = flagBit(IDENTIFY_FLAG_SPELL_BOOK) && Array.isArray(snapshot.spellBook)
    ? snapshot.spellBook : [];
  const hasMagic = ints.ItemSpellcraft != null || ints.ItemMaxMana != null || ints.ItemDifficulty != null || sb.length > 0;
  if (hasMagic) {
    sec("Magic");
    if (ints.ItemSpellcraft != null) row("Spellcraft", ints.ItemSpellcraft);
    if (ints.ItemMaxMana != null) row("Mana", `${formatThousands(ints.ItemCurMana ?? 0)} / ${formatThousands(ints.ItemMaxMana)}`);
    if (ints.ItemDifficulty != null) row("Arcane Lore to activate", ints.ItemDifficulty);
    if (floats.ManaRate != null && Number(floats.ManaRate) < 0) {
      const secs = Math.round(-1 / Number(floats.ManaRate));
      if (Number.isFinite(secs) && secs > 0) row("Mana cost", `1 every ${secs} s`);
    }
    if (sb.length > 0) {
      // Spell list with names + icons — retail's ItemExamineUI spell
      // strip. `spellBook` is a plain `Vec<u32>` of spell ids on the
      // wire — names resolve via handle.getSpellRecord (sync) and icons
      // via resolveSpellIcon (async), same path as the spellbook/hotbar.
      const list = document.createElement("div");
      list.className = "hb-exa-spells hb-exa-spelllist";
      for (const spellId of sb) {
        const id = spellId >>> 0;
        const entry = document.createElement("div");
        entry.className = "hb-exa-spell";
        const ic = document.createElement("i");
        entry.appendChild(ic);
        const label = document.createElement("span");
        label.textContent = getSpellName(id) || "Unknown spell";
        if (debugEnabled()) label.title = `spell ${id}`;
        entry.appendChild(label);
        list.appendChild(entry);
        resolveSpellIcon(id).then((url) => {
          if (url && ic.isConnected) ic.style.backgroundImage = `url("${url}")`;
        }).catch(() => {});
      }
      wrapEl.appendChild(list);
    }
  }

  // === Requirements (Appraisal_ShowWieldRequirements) ===
  // WieldRequirements picks which check applies: 1=RawSkill,
  // 2=AttribSkill (trained skill), 3=RawAttrib, 4=Level, 5=RawAttrib2,
  // 7=Heritage, 8=Faction.
  const WIELD_REQ_LABELS = {
    1: "Skill", 2: "Skill", 3: "Attribute",
    4: "Level", 5: "Attribute",
    7: "Heritage", 8: "Faction",
  };
  const reqRows = [];
  if (ints.WieldDifficulty != null || ints.WieldRequirements != null || ints.WieldSkillType != null) {
    const reqKind = ints.WieldRequirements >>> 0;
    const skillType = ints.WieldSkillType ?? null;
    const diff = ints.WieldDifficulty ?? null;
    const isSkillReq = reqKind === 1 || reqKind === 2;
    const what = skillType != null && isSkillReq ? skillName(skillType) : null;
    if (reqKind === 4 && diff != null) reqRows.push(["Wield", `Level ${diff}+`]);
    else if (what && diff != null) reqRows.push(["Wield", `${what} ${diff}+`]);
    else if (what) reqRows.push(["Wield", what]);
    else if (diff != null) reqRows.push([`Wield (${WIELD_REQ_LABELS[reqKind] || "requirement"})`, `${diff}+`]);
  }
  if (ints.WieldDifficulty2 != null && ints.WieldSkillType2 != null) {
    const reqKind2 = ints.WieldRequirements2 >>> 0;
    const what2 = (reqKind2 === 1 || reqKind2 === 2) ? skillName(ints.WieldSkillType2) : null;
    if (what2) reqRows.push(["Wield", `${what2} ${ints.WieldDifficulty2}+`]);
  }
  if (ints.ItemMinLevel != null) reqRows.push(["Minimum level", ints.ItemMinLevel]);
  if (ints.ItemMaxLevel != null && kind === "item") reqRows.push(["Item level cap", ints.ItemMaxLevel]);
  if (reqRows.length) {
    sec("Requirements");
    for (const [l, val] of reqRows) row(l, val);
  }

  // === Properties (Appraisal_ShowSpecialProperties / Bonded/Attuned
  //     status / "This item cannot be sold.") ===
  const special = [];
  if (Number(ints.Bonded) === 1) special.push("Bonded");
  else if (Number(ints.Bonded) === -1) special.push("Destroyed on death");
  if (Number(ints.Attuned) === 1) special.push("Attuned");
  if (props.bools?.IsSellable === false) special.push("Cannot be sold");
  if (props.bools?.Retained === true) special.push("Retained");
  if (special.length) {
    sec("Properties");
    prose(wrapEl, special.join(" · "));
  }
  if (showHook && hp.hook_type != null && debugEnabled()) row("Hook type", hp.hook_type);

  // === Usage + description (Appraisal_ShowUsage / ShowDescription) ===
  const useText = strings.Use || strings.UseMessage;
  if (useText) {
    sec("Use");
    prose(wrapEl, useText);
  }
  const desc = strings.LongDesc || strings.ShortDesc;
  if (desc && desc !== snapshot?.properties?.strings?.Name) {
    sec("Description");
    prose(wrapEl, desc, "is-flavor hb-exa-desc");
  }

  // === Debug (gated) ===
  if (debugEnabled()) {
    sec("Appraisal (debug)");
    row("ItemType", ints.ItemType != null ? hex8(ints.ItemType) : null);
    row("CreatureType", ints.CreatureType);
    row("Identify flags", hex8(identifyFlags));
    if (strings.PluralName) row("Plural", strings.PluralName);
  }
}

// ── Header (value/burden or creature type/level) + health meter ───────

function renderHeader(refs, model, snapshot) {
  const ints = snapshot?.properties?.ints || {};
  const strings = snapshot?.properties?.strings || {};
  let kind = model.kind;
  // An appraisal with a creature profile settles an unknown item/creature.
  if (kind === "item" && !model.fromInventory
      && (snapshot?.creatureProfile || snapshot?.failedCreatureProfile)) kind = "creature";
  model.kind = kind;
  const head = examineHeaderModel({
    kind, ints, strings, item: model.item, meta: model.meta, isPK: model.isPK,
    pkStatus: model.pkStatus,
  });
  refs.textEl.innerHTML = "";
  if (kind === "empty") {
    // The body's empty-state message explains; keep the head quiet.
  } else if (!head.lines.length) {
    const l = document.createElement("div");
    l.className = "hb-exa-line is-muted";
    l.textContent = model.loading ? "Looking closer…" : (kind === "player" ? "Player" : "Creature");
    refs.textEl.appendChild(l);
  }
  for (const line of head.lines) {
    const l = document.createElement("div");
    l.className = "hb-exa-line" + (line.tone === "warn" ? " is-warn" : "");
    l.textContent = line.text;
    refs.textEl.appendChild(l);
  }
  refs.bodyEl?.classList.toggle("is-creature", kind === "creature");
  // Right box: icon for items, level for creatures / players.
  const showLevel = head.level != null;
  refs.iconBox.style.display = (!showLevel && kind !== "empty") ? "" : "none";
  refs.levelBox.style.display = showLevel ? "" : "none";
  if (showLevel) {
    refs.levelLabel.textContent = head.levelLabel || "Level";
    refs.levelValue.textContent = head.level;
  }
  // Health meter (creatures / players): exact appraisal numbers beat a
  // QueryHealth fraction beat nothing.
  if (kind === "creature" || kind === "player") {
    const cp = snapshot?.creatureProfile;
    const hm = healthModel(cp?.health_max != null
      ? { cur: cp.health, max: cp.health_max }
      : (model.health ?? { fraction: model.healthFraction }));
    if (hm) {
      refs.healthEl.style.display = "";
      refs.healthFill.style.setProperty("--hbk-fill", `${(hm.fraction * 100).toFixed(1)}%`);
      refs.healthLabel.textContent = `Health ${hm.label}`;
    } else {
      refs.healthEl.style.display = "none";
    }
  } else {
    refs.healthEl.style.display = "none";
  }
  // Title follows the best-known name (appraisal Name beats a guess).
  const name = strings.Name || model.name;
  if (name && name !== model.titleShown && typeof refs.setTitle === "function") {
    model.titleShown = name;
    try { refs.setTitle(name); } catch (_) {}
  }
}

/** Best-known display name for an examine ctx (title bar text). */
function resolveExamineName(ctx) {
  if (ctx?.name) return ctx.name;
  const fromLi = ctx?.srcLi?.querySelector?.(".name")?.textContent;
  if (fromLi) return fromLi;
  const guid = (Number(ctx?.guid ?? ctx?.srcLi?.dataset?.guid) >>> 0) || 0;
  if (!guid) return null;
  const inv = getItemByGuid(guid);
  if (inv?.name) return inv.name;
  const ent = getEntityEntry(guid);
  return ent?.meta?.name || ent?.name || null;
}

// Resolve the title text for an examine context (matches view.nameFor):
// the examined thing's name, like retail's DisplayedNameText — never
// "Examine: X" plus the name again in the body.
export function examineTitleFor(ctx) {
  return resolveExamineName(ctx) || "Examine";
}

// Build the examine body DOM into `parentEl` and wire up paperdoll +
// inscription + bus refresh subscriptions. Returns a cleanup function.
// Used by BOTH the main-panel view and the standalone floaty
// (gmFloatyExaminationUI). Caller owns the outer chrome (title bar /
// close button / frame); `opts.setTitle(text)` lets the body retitle it
// once a better name arrives (appraisal / late entity spawn).
export function mountExamineBody(parentEl, ctx, opts = {}) {
  ensureStyles();
  const root = document.createElement("div");
  root.className = "hb-exa-root";

  const examineGuid = (ctx?.guid != null)
    ? (Number(ctx.guid) >>> 0)
    : ((ctx?.srcLi?.dataset?.guid != null)
        ? (Number(ctx.srcLi.dataset.guid) >>> 0)
        : null);

  // Head — retail ItemValueText/ItemBurdenText (or CreatureName / heritage
  // lines) on the left, ItemIcon or LevelInfo on the right.
  const head = document.createElement("div");
  head.className = "hb-exa-head";
  const textEl = document.createElement("div");
  textEl.className = "hb-exa-headtext";
  head.appendChild(textEl);
  const iconBox = document.createElement("div");
  iconBox.className = "hb-exa-iconbox";
  iconBox.style.display = "none";
  const iconImg = document.createElement("img");
  iconImg.alt = "";
  iconImg.style.display = "none";
  iconBox.appendChild(iconImg);
  head.appendChild(iconBox);
  const levelBox = document.createElement("div");
  levelBox.className = "hb-exa-levelbox";
  levelBox.style.display = "none";
  const levelLabel = document.createElement("div");
  levelLabel.className = "hb-exa-levellabel";
  const levelValue = document.createElement("div");
  levelValue.className = "hb-exa-levelvalue";
  levelBox.appendChild(levelLabel);
  levelBox.appendChild(levelValue);
  head.appendChild(levelBox);
  root.appendChild(head);
  if (examineGuid && debugEnabled()) head.title = hex8(examineGuid);

  // Gold divider (0x060012C5 + right cap 0x060012C4).
  const divider = document.createElement("div");
  divider.className = "hbk-divider";
  root.appendChild(divider);

  const healthEl = document.createElement("div");
  healthEl.className = "hbk-meter hb-exa-health";
  healthEl.style.display = "none";
  const healthFill = document.createElement("div");
  healthFill.className = "hbk-meter-fill";
  const healthLabel = document.createElement("div");
  healthLabel.className = "hbk-meter-label";
  healthEl.appendChild(healthFill);
  healthEl.appendChild(healthLabel);
  root.appendChild(healthEl);

  // Scrolling display text (ItemDisplayText + rope scrollbar).
  const body = document.createElement("div");
  body.className = "hb-exa-body hbk-scroll";
  root.appendChild(body);

  // Wave 3.B (2026-05-28) — embedded paperdoll preview (creatures /
  // players only — retail ItemExamineUI never shows a doll for items).
  const paperdollWrap = document.createElement("div");
  paperdollWrap.className = "hb-exa-paperdoll-wrap";
  paperdollWrap.style.display = "none"; // shown only for creatures / players below
  body.appendChild(paperdollWrap);

  // Identity rows (inventory facts / debug) then the appraisal block.
  const identity = document.createElement("div");
  identity.className = "hb-exa-identity";
  body.appendChild(identity);
  const appraisalWrap = document.createElement("div");
  appraisalWrap.className = "hb-exa-appraisal-wrap";
  appraisalWrap.style.display = "none";
  body.appendChild(appraisalWrap);
  const pending = document.createElement("div");
  pending.className = "hb-exa-pending";
  pending.style.display = "none";
  body.appendChild(pending);

  // Inscription parchment — pinned under the scroll area, hidden when
  // the examined thing has no inscription.
  const inscWrap = document.createElement("div");
  inscWrap.className = "hb-exa-insc-wrap";
  inscWrap.style.display = "none";
  root.appendChild(inscWrap);

  parentEl.appendChild(root);

  const model = {
    kind: "item", name: resolveExamineName(ctx), titleShown: null,
    item: null, meta: null, isPlayer: false, isPK: false, pkStatus: null,
    health: null, healthFraction: null, loading: false,
    fromInventory: !!ctx?.fromInventory,
  };
  const refs = {
    textEl, iconBox, levelBox, levelLabel, levelValue,
    healthEl, healthFill, healthLabel, setTitle: opts.setTitle,
    bodyEl: body,
  };
  model.titleShown = model.name;

  let paperdollViewport = null;
  if (ctx?.fromInventory) {
    populateFromInventory(identity, ctx, model);
  } else {
    populateFromEntity(identity, ctx ?? {}, model);
    // Wave 3.B — render the creature / player gear + dye preview at the
    // top of the body. renderEntityPaperdoll handles the entity-missing /
    // no-setupId fallbacks internally; returns null when the viewport
    // couldn't be constructed (no entry to dispose then).
    if (model.kind === "creature" || model.kind === "player") {
      paperdollWrap.style.display = "";
      paperdollViewport = renderEntityPaperdoll(paperdollWrap, examineGuid);
    }
  }

  // P2-44 — the item's real icon via the shared resolver (fire-and-forget).
  if (examineGuid) {
    resolveBindingIcon({ itemGuid: examineGuid })
      .then((url) => {
        if (url && iconImg.isConnected) {
          iconImg.src = url;
          iconImg.style.display = "";
        }
      })
      .catch(() => {});
  }

  const refreshAll = () => {
    const snap = readAppraisal(examineGuid);
    renderHeader(refs, model, snap);
    renderAppraisal(appraisalWrap, examineGuid, snap, model.kind);
    const empty = model.kind === "empty";
    pending.style.display = (!snap && !empty) ? "" : "none";
    pending.textContent = model.loading ? "Too far away to see clearly." : "Appraising…";
    if (empty && !body.querySelector(".hbk-empty")) {
      const e = document.createElement("div");
      e.className = "hbk-empty";
      e.textContent = "Nothing is selected. Click something in the world or in your pack, then choose Examine.";
      body.appendChild(e);
    }
  };
  refreshAll();
  renderInscription(inscWrap, examineGuid);
  // Not everything answers an appraisal (scenery, some statics) — don't
  // leave "Appraising…" up forever.
  const pendingTimer = setTimeout(() => {
    if (!readAppraisal(examineGuid)) pending.style.display = "none";
  }, 6000);

  // EX-05 (2026-06-05) — ask for the AppraisalProfile; `objectAppraised`
  // re-renders when it lands. Creatures also get a QueryHealth so the
  // meter fills before (or without) a full assess.
  if (examineGuid) {
    try {
      const handle = getHandle();
      if (handle?.requestAppraisal) handle.requestAppraisal(examineGuid >>> 0);
      if ((model.kind === "creature" || model.kind === "player") && handle?.queryHealth) {
        handle.queryHealth(examineGuid >>> 0);
      }
    } catch (_) {}
  }

  // Refresh inscription on bookUpdated (book panel pushes fresh
  // BookSnapshot here) and on playerInventoryChanged (ownership).
  const pc = window.__pluginClient ?? null;
  const onRefresh = () => renderInscription(inscWrap, examineGuid);
  // HUD rec #107 (2026-06-16) — RNG-based identify retry. ACE rolls
  // an Identify skill check per Player_Skills.cs HandleIdentifyResponse;
  // on failure the IdentifyResponse comes back with success=false and
  // the panel shows the failure line (rec #53). Retail's
  // awaiting_appraisal_ID gating retries automatically on failure.
  // Mirror that with bounded backoff: 3 attempts at 5s / 10s / 20s, then
  // give up. Any successful identify (or unmount) clears the timer.
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
      try { getHandle()?.requestAppraisal?.(examineGuid >>> 0); } catch (_) {}
    }, delay);
  };
  const onAppraised = (ev) => {
    const guid = (ev?.detail?.u32Payload ?? 0) >>> 0;
    if (!examineGuid || guid !== (examineGuid >>> 0)) return;
    const wasCreature = model.kind === "creature" || model.kind === "player";
    refreshAll();
    renderInscription(inscWrap, examineGuid);
    // A late appraisal can reveal a creature the spawn data didn't flag.
    if (!wasCreature && (model.kind === "creature" || model.kind === "player") && !paperdollViewport) {
      onAppearanceRefresh();
    }
    const snap = readAppraisal(guid);
    if (snap?.identifySuccess === false) {
      scheduleIdentifyRetry();
    } else if (snap) {
      cancelIdentifyRetry();
      identifyRetryAttempt = 0;
    }
  };
  // QueryHealth reply / damage broadcast (target-bar's F10-1 channel).
  const onEntityHealth = (ev) => {
    const d = ev?.detail ?? ev ?? {};
    if (!examineGuid || ((d.guid ?? 0) >>> 0) !== examineGuid) return;
    if (!Number.isFinite(d.fraction)) return;
    model.healthFraction = d.fraction;
    renderHeader(refs, model, readAppraisal(examineGuid));
  };
  // Wave 3.B — refresh the paperdoll when the examined entity's
  // appearance changes (e.g. NPC equips a new item via ACE's
  // applyAppearance broadcast).
  const onAppearanceRefresh = () => {
    if (!examineGuid || ctx?.fromInventory) return;
    if (!(model.kind === "creature" || model.kind === "player")) return;
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
    pc.events.on("entityHealthUpdated", onEntityHealth);
  }

  return () => {
    if (pc?.events?.off) {
      try { pc.events.off("bookUpdated", onRefresh); } catch (_) {}
      try { pc.events.off("playerInventoryChanged", onRefresh); } catch (_) {}
      try { pc.events.off("entityAppearanceChanged", onAppearanceRefresh); } catch (_) {}
      try { pc.events.off("objectAppraised", onAppraised); } catch (_) {}
      try { pc.events.off("entityHealthUpdated", onEntityHealth); } catch (_) {}
    }
    // HUD rec #107: drop any pending identify-retry timer so the
    // backoff schedule doesn't outlive the panel's unmount.
    cancelIdentifyRetry();
    clearTimeout(pendingTimer);
    // books-journal-3: an inscription being written is saved on close.
    if (_inscEdit && _inscEdit.guid === ((examineGuid ?? 0) >>> 0)) commitInscriptionEdit();
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
  mount: (parentEl, ctx) => mountExamineBody(parentEl, ctx, {
    setTitle: (text) => window.__mainPanel?.setTitle?.(text),
  }),
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
