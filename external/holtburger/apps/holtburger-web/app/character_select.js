// app/character_select.js — the retail character screen (2026-10-09).
//
// RETAIL: gmCharacterManagementUI (acclient.c:281396) builds its root from the
// login LayoutDesc 0x21000004 "CharacterManagementField" (800×600, rendered from
// client_local_English.dat by WorldBuilder.Terminal ui-layout-render): the art
// field 0x06007576 (logo, Asheron, the "World" / "Characters" labels), the
// WorldName frame 0x06004D64 at (21,44), the CharacterListBox (42,212) 160×320 of
// 160×16 CharacterSlotTemplate rows, Create Character (216,185) 0x06004CA3,
// the round ENTER (239,289) 0x06004CB2, and Delete / Restore (36,522), Credits
// (465,522) and Exit (615,522) on 0x06004C9E. RebuildCharacterList
// (:281100) greys characters pending deletion and lists them last;
// SelectCharacter (:280955) + UpdateButtons (:281010) swap Delete for Restore
// on a greyed row; EnterGame (:281972) enters with the selected character and
// shows the "entering" dialog; Delete asks for DELETE to be typed
// (app/login_ui_rules.js). Credits has no content here and is left out.
//
// This page replaces the developer character list when the URL asks for it
// (`?autoLogin=1&autoSpawn=select`), on a manual Connect (escape
// `?charSelect=off`), and when /logout returns from the world. It drives the
// SAME hidden list index.html renders (#character-ul), so the spawn flow,
// boot states and agent hooks are unchanged. While it is up, the world around
// the selected character's last spot starts loading (app/spawn_preview.js).

import { setAcText, loadAcFont } from "../ui/ac_font.js";
import { ensureDialogChromeStyles } from "../plugins/modal-dialog.js";
import {
  characterErrorInfo,
  deleteConfirmationAccepted,
  deleteConfirmationText,
  isGreyedOut,
  orderCharacterRows,
} from "./login_ui_rules.js";
import {
  lastLocationKey,
  loadLastLocation,
  newCharacterSpot,
  spawnPreviewEnabled,
  startSpawnPreview,
} from "./spawn_preview.js";

export const CHARSELECT_ROOT_ID = "hb-charselect";
const STYLE_ID = "hb-charselect-style";
const SP = "./data/ui-sprites";
/** Retail fonts on this layout (WorldBuilder.Terminal render manifest). */
export const CHARSELECT_FONTS = Object.freeze({ small: 0x4000000b, create: 0x4000000c, enter: 0x40000012 });
const ROW_H = 16;
const SELECTED_KEY_PREFIX = "hb.charSelect.v1:";

function isOff(v) {
  return v === "off" || v === "0" || v === "false";
}

/**
 * When does the page show at the character list?
 *   autoLogin=1 + autoSpawn=select → yes (the /logout return and invite links);
 *   autoLogin=1 + any other autoSpawn → no (agents and the eye-test rigs);
 *   a manual Connect → yes, unless `?charSelect=off`.
 */
export function characterSelectWanted(search) {
  let p;
  try { p = new URLSearchParams(search ?? globalThis.location?.search ?? ""); } catch (_) { p = new URLSearchParams(""); }
  if (p.get("autoLogin") === "1") return p.get("autoSpawn") === "select";
  return !isOff(p.get("charSelect"));
}

/**
 * The rows the list shows, in retail order, with the selection resolved: the
 * remembered character when it is still listed and active, else the first
 * active one, else the first row.
 */
export function characterSelectRows(list, rememberedId) {
  const rows = orderCharacterRows(list).map(({ c, slot, greyed }) => ({
    id: Number(c?.id) >>> 0, name: String(c?.name ?? ""), slot, greyed,
  }));
  const want = Number(rememberedId) >>> 0;
  let selected = rows.find((r) => r.id === want) ?? rows.find((r) => !r.greyed) ?? rows[0] ?? null;
  return { rows, selectedId: selected ? selected.id : 0 };
}

/** Buttons for the selected row (retail UpdateButtons). */
export function characterSelectButtons(row) {
  return {
    enter: !!row && !row.greyed,
    del: !!row && !row.greyed,
    restore: !!row && row.greyed,
  };
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  ensureDialogChromeStyles();
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${CHARSELECT_ROOT_ID} {
      position: fixed; inset: 0; z-index: 8000;
      background: #000;
      display: none;
      user-select: none;
    }
    #${CHARSELECT_ROOT_ID}[data-open="1"] { display: block; }
    #${CHARSELECT_ROOT_ID} .hcs-stage {
      position: absolute; left: 50%; top: 50%;
      width: 800px; height: 600px;
      transform-origin: 0 0;
      background: url("${SP}/0x06007576.webp") 0 0 / 800px 600px no-repeat, #0b1630;
      overflow: hidden;
    }
    #${CHARSELECT_ROOT_ID} .hcs-abs { position: absolute; }
    #${CHARSELECT_ROOT_ID} .hcs-world {
      left: 21px; top: 44px; width: 193px; height: 110px;
      background: url("${SP}/0x06004D64.png") 0 0 / 193px 110px no-repeat;
    }
    #${CHARSELECT_ROOT_ID} .hcs-world-name {
      left: 52px; top: 74px; width: 131px; height: 48px;
      display: flex; align-items: center; justify-content: center; text-align: center;
      color: #f3d27a; font: 14px/1.1 Georgia, serif; overflow: hidden;
    }
    #${CHARSELECT_ROOT_ID} .hcs-list {
      left: 42px; top: 212px; width: 160px; height: 320px;
      overflow-y: auto; overflow-x: hidden; scrollbar-width: none;
    }
    #${CHARSELECT_ROOT_ID} .hcs-row {
      height: ${ROW_H}px; line-height: ${ROW_H}px; padding: 0 4px;
      color: #e8dcb0; font: 13px/16px Georgia, serif;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;
    }
    #${CHARSELECT_ROOT_ID} .hcs-row:hover { color: #fff3c4; }
    #${CHARSELECT_ROOT_ID} .hcs-row.is-selected {
      color: #fff3c4;
      background: linear-gradient(90deg, rgba(243,210,122,0.35), rgba(243,210,122,0.08));
      box-shadow: inset 1px 0 0 #f3d27a;
    }
    #${CHARSELECT_ROOT_ID} .hcs-row.is-greyed { color: #8d8676; font-style: italic; }
    #${CHARSELECT_ROOT_ID} .hcs-btn {
      border: 0; padding: 0; margin: 0; background-color: transparent;
      background-repeat: no-repeat; background-position: 0 0;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      color: #f3d27a; font: 15px Georgia, serif; letter-spacing: 0.04em;
    }
    #${CHARSELECT_ROOT_ID} .hcs-btn:hover:not([disabled]) { filter: brightness(1.18); }
    #${CHARSELECT_ROOT_ID} .hcs-btn:active:not([disabled]) { filter: brightness(0.9); }
    #${CHARSELECT_ROOT_ID} .hcs-btn[disabled] { cursor: default; filter: grayscale(0.8) brightness(0.65); }
    #${CHARSELECT_ROOT_ID} .hcs-btn[hidden] { display: none; }
    #${CHARSELECT_ROOT_ID} .hcs-small { width: 170px; height: 99px; background-image: url("${SP}/0x06004C9E.png"); background-size: 170px 99px; }
    #${CHARSELECT_ROOT_ID} .hcs-create {
      left: 216px; top: 185px; width: 254px; height: 113px;
      background-image: url("${SP}/0x06004CA3.png"); background-size: 254px 113px;
    }
    #${CHARSELECT_ROOT_ID} .hcs-enter {
      left: 239px; top: 289px; width: 211px; height: 211px;
      background-image: url("${SP}/0x06004CB2.png"); background-size: 211px 211px;
      font-size: 30px; color: #efe2b4;
    }
    #${CHARSELECT_ROOT_ID} .hcs-status {
      left: 210px; top: 500px; width: 380px; height: 20px;
      text-align: center; color: #e8dcb0; font: 13px Georgia, serif;
      text-shadow: 0 1px 2px #000;
    }
    #${CHARSELECT_ROOT_ID} .hcs-dialog-veil {
      position: absolute; inset: 0; background: rgba(0, 0, 0, 0.45);
      display: none; align-items: center; justify-content: center;
    }
    #${CHARSELECT_ROOT_ID} .hcs-dialog-veil[data-open="1"] { display: flex; }
    #${CHARSELECT_ROOT_ID} .hcs-dialog { width: 360px; padding: 18px 20px 14px; color: #e8dcb0; font: 13px/1.35 Georgia, serif; }
    #${CHARSELECT_ROOT_ID} .hcs-dialog p { margin: 0 0 10px; white-space: pre-line; }
    #${CHARSELECT_ROOT_ID} .hcs-dialog input {
      width: 100%; box-sizing: border-box; margin: 4px 0 12px; padding: 4px 6px;
      background: #0a0806; color: #fff3c4; border: 1px solid #8a7544; font: 14px Georgia, serif;
    }
    #${CHARSELECT_ROOT_ID} .hcs-dialog .hcs-dlg-btns { display: flex; justify-content: center; gap: 12px; }
  `;
  document.head.appendChild(s);
}

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

function label(node, text, fontId, color) {
  node.textContent = text;
  try { setAcText(node, text, { fontId, color }); } catch (_) { /* plain text stays */ }
}

/**
 * Mount the page (idempotent). `deps`:
 *   getHandle()        → the live SessionHandle
 *   characterUl        → index.html's hidden list (spawn buttons live there)
 *   getServerName()    → the World box text
 *   getAccountKey()    → { server, account } for the remembered spots
 *   openWizard(onDone) → opens the character-creation wizard
 *   onExit()           → leave the account (back to the login form)
 *   getCatalog()       → the plain char-gen catalog (null until loaded); an
 *                        account with no characters warms the academy a new
 *                        character would start in
 */
export function initCharacterSelect(deps) {
  let root = document.getElementById(CHARSELECT_ROOT_ID);
  if (root?._hcs) return root._hcs;
  ensureStyles();
  for (const id of Object.values(CHARSELECT_FONTS)) {
    try { loadAcFont(id)?.catch?.(() => {}); } catch (_) { /* fallback text */ }
  }
  root = el("div", "", document.body);
  root.id = CHARSELECT_ROOT_ID;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Characters");
  const stage = el("div", "hcs-stage", root);
  el("div", "hcs-abs hcs-world", stage);
  const worldName = el("div", "hcs-abs hcs-world-name", stage);
  const list = el("div", "hcs-abs hcs-list", stage);
  list.setAttribute("role", "listbox");
  const mkBtn = (cls, x, y, text, fontId, color) => {
    const b = el("button", `hcs-abs hcs-btn ${cls}`, stage);
    b.type = "button";
    if (x != null) { b.style.left = `${x}px`; b.style.top = `${y}px`; }
    label(b, text, fontId, color);
    return b;
  };
  const createBtn = mkBtn("hcs-create", null, null, "Create Character", CHARSELECT_FONTS.create, "#f3d27a");
  const enterBtn = mkBtn("hcs-enter", null, null, "ENTER", CHARSELECT_FONTS.enter, "#efe2b4");
  const deleteBtn = mkBtn("hcs-small", 36, 522, "DELETE", CHARSELECT_FONTS.small, "#f3d27a");
  const restoreBtn = mkBtn("hcs-small", 36, 522, "RESTORE", CHARSELECT_FONTS.small, "#f3d27a");
  const exitBtn = mkBtn("hcs-small", 615, 522, "EXIT", CHARSELECT_FONTS.small, "#f3d27a");
  const status = el("div", "hcs-abs hcs-status", stage);
  status.setAttribute("aria-live", "polite");
  const veil = el("div", "hcs-dialog-veil", stage);

  const state = { rows: [], selectedId: 0, entering: false, previewFor: 0, previewTimer: 0 };

  const handle = () => deps.getHandle?.() ?? null;
  const acctKey = () => deps.getAccountKey?.() ?? { server: "", account: "" };
  const selectedKey = () => {
    const k = acctKey();
    return `${SELECTED_KEY_PREFIX}${String(k.server).toLowerCase()}|${String(k.account).toLowerCase()}`;
  };
  const rememberSelection = (id) => { try { localStorage.setItem(selectedKey(), String(id >>> 0)); } catch (_) {} };
  const recallSelection = () => { try { return Number(localStorage.getItem(selectedKey())) >>> 0; } catch (_) { return 0; } };

  function placeStage() {
    const s = Math.min(window.innerWidth / 800, window.innerHeight / 600);
    stage.style.transform = `scale(${s}) translate(-50%, -50%)`;
  }
  window.addEventListener("resize", () => { if (root.dataset.open === "1") placeStage(); });

  function setStatus(text) { status.textContent = text || ""; }

  function closeDialog() { veil.dataset.open = "0"; veil.replaceChildren(); }
  function openDialog(build) {
    veil.replaceChildren();
    const box = el("div", "hb-dlg hcs-dialog", veil);
    build(box);
    veil.dataset.open = "1";
    const focus = box.querySelector("input, button");
    try { focus?.focus(); } catch (_) {}
  }
  function dialogButtons(box, specs) {
    const row = el("div", "hcs-dlg-btns", box);
    for (const s of specs) {
      const b = el("button", "hbk-btn", row);
      b.type = "button";
      b.textContent = s.text;
      b.addEventListener("click", s.onClick);
    }
  }
  function showError(text) {
    if (!text) return;
    openDialog((box) => {
      el("p", "", box).textContent = text;
      dialogButtons(box, [{ text: "OK", onClick: closeDialog }]);
    });
  }

  function selectedRow() { return state.rows.find((r) => r.id === state.selectedId) ?? null; }

  function render() {
    const h = handle();
    try { worldName.textContent = deps.getServerName?.() || ""; } catch (_) { worldName.textContent = ""; }
    let raw = [];
    try { raw = Array.from(h?.characterList?.() ?? []); } catch (_) { raw = []; }
    const r = characterSelectRows(raw, state.selectedId || recallSelection());
    state.rows = r.rows;
    state.selectedId = r.selectedId;
    list.replaceChildren();
    for (const row of state.rows) {
      const d = el("div", "hcs-row", list);
      d.setAttribute("role", "option");
      d.dataset.id = String(row.id);
      d.textContent = row.greyed ? `${row.name} (pending deletion)` : row.name;
      d.classList.toggle("is-greyed", row.greyed);
      d.classList.toggle("is-selected", row.id === state.selectedId);
      d.setAttribute("aria-selected", row.id === state.selectedId ? "true" : "false");
      d.addEventListener("click", () => select(row.id));
      d.addEventListener("dblclick", () => { select(row.id); enter(); });
    }
    const b = characterSelectButtons(selectedRow());
    enterBtn.disabled = !b.enter || state.entering;
    deleteBtn.hidden = b.restore;
    deleteBtn.disabled = !b.del || state.entering;
    restoreBtn.hidden = !b.restore;
    restoreBtn.disabled = state.entering;
    createBtn.disabled = state.entering || !h?.canCreateCharacter;
    if (!state.entering) setStatus(state.rows.length ? "" : "You have no characters yet — choose Create Character.");
  }

  // The warm-up: the remembered spot of the selected character, plus the
  // location-independent terrain assets either way. The first selection
  // starts at once; later changes wait a moment so flicking down the list does
  // not start a ring per name. An account with no characters (a first-time
  // player) warms the Training Academy a new character starts in — the
  // wizard then follows the chosen start area (index.html `onStartArea`).
  function schedulePreview(immediate) {
    if (!spawnPreviewEnabled()) return;
    clearTimeout(state.previewTimer);
    const run = () => {
      const id = state.selectedId >>> 0;
      const key = id || (state.rows.length ? 0 : "new");
      if (!key || state.previewFor === key) return;
      state.previewFor = key;
      try { globalThis.window?.liveScene3d?.warmTerrainAssets?.(); } catch (_) {}
      if (key === "new") { previewNewCharacterSpot(); return; }
      const k = acctKey();
      const loc = loadLastLocation(globalThis.localStorage, lastLocationKey({ ...k, charId: id }));
      if (loc) startSpawnPreview({ loc }).catch(() => {});
      else {
        // No spot on this browser yet: still warm the terrain chain once the
        // scene exists (init3D may still be running).
        const t0 = Date.now();
        const tick = () => {
          const s3d = globalThis.window?.liveScene3d;
          if (s3d?.warmTerrainAssets) { s3d.warmTerrainAssets(); return; }
          if (Date.now() - t0 < 60000) setTimeout(tick, 500);
        };
        tick();
      }
    };
    if (immediate) run(); else state.previewTimer = setTimeout(run, 1200);
  }

  // The catalog loads in the background after login (wasm
  // `load_character_gen_catalog`); wait for it, then load the default academy.
  function previewNewCharacterSpot() {
    const t0 = Date.now();
    const tick = () => {
      if (state.previewFor !== "new" || root.dataset.open !== "1") return;
      let loc = null;
      try { loc = newCharacterSpot(deps.getCatalog?.() ?? null); } catch (_) { loc = null; }
      if (loc) { startSpawnPreview({ loc }).catch(() => {}); return; }
      if (Date.now() - t0 < 60000) setTimeout(tick, 500);
    };
    tick();
  }

  function select(id) {
    if (state.entering) return;
    const first = !state.previewFor;
    state.selectedId = id >>> 0;
    rememberSelection(state.selectedId);
    render();
    schedulePreview(first);
  }

  function enter() {
    const row = selectedRow();
    if (!row || row.greyed || state.entering) return;
    const btn = deps.characterUl?.querySelector?.(`button[data-id="${row.id}"]`);
    if (!btn || btn.disabled) { showError("This character cannot enter the world right now."); return; }
    state.entering = true;
    window.__lastCharacterError = null;
    setStatus("Entering game...");
    render();
    btn.click();
  }

  function confirmDelete() {
    const row = selectedRow();
    if (!row || row.greyed) return;
    openDialog((box) => {
      el("p", "", box).textContent = deleteConfirmationText(row.name);
      const input = el("input", "", box);
      input.type = "text";
      input.autocomplete = "off";
      input.setAttribute("aria-label", "Type DELETE to confirm");
      const done = () => {
        if (!deleteConfirmationAccepted(input.value)) { input.focus(); return; }
        closeDialog();
        try { handle()?.deleteCharacter?.(row.slot); setStatus(`Deleting ${row.name}...`); }
        catch (e) { showError(`Server could not delete your character. (${String(e?.message ?? e)})`); }
      };
      input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") done(); if (ev.key === "Escape") closeDialog(); });
      dialogButtons(box, [{ text: "Done", onClick: done }, { text: "Cancel", onClick: closeDialog }]);
    });
  }

  function restore() {
    const row = selectedRow();
    if (!row || !row.greyed) return;
    try { handle()?.restoreCharacter?.(row.id); setStatus(`Restoring ${row.name}...`); }
    catch (e) { showError(String(e?.message ?? e)); }
  }

  function confirmExit() {
    openDialog((box) => {
      el("p", "", box).textContent = "Are you sure you want to exit?";
      dialogButtons(box, [
        { text: "Yes", onClick: () => { closeDialog(); try { deps.onExit?.(); } catch (_) {} } },
        { text: "No", onClick: closeDialog },
      ]);
    });
  }

  createBtn.addEventListener("click", () => {
    if (createBtn.disabled) return;
    try {
      deps.openWizard?.((created) => {
        render();
        if (created?.id) select(created.id);
      });
    } catch (e) { showError(String(e?.message ?? e)); }
  });
  enterBtn.addEventListener("click", enter);
  deleteBtn.addEventListener("click", confirmDelete);
  restoreBtn.addEventListener("click", restore);
  exitBtn.addEventListener("click", confirmExit);

  // Retail OnAction: arrows move the selection, Enter enters.
  root.addEventListener("keydown", (ev) => {
    if (root.dataset.open !== "1" || veil.dataset.open === "1") return;
    if (ev.target?.tagName === "INPUT") return;
    const i = state.rows.findIndex((r) => r.id === state.selectedId);
    if (ev.key === "ArrowDown" && i < state.rows.length - 1) { select(state.rows[i + 1].id); ev.preventDefault(); }
    else if (ev.key === "ArrowUp" && i > 0) { select(state.rows[i - 1].id); ev.preventDefault(); }
    else if (ev.key === "Enter") { enter(); ev.preventDefault(); }
  });

  // The list re-renders on the server's CharacterList re-fire (create /
  // delete / restore / log-off) — index.html rebuilds #character-ul then.
  try {
    new MutationObserver(() => { if (root.dataset.open === "1") render(); })
      .observe(deps.characterUl, { childList: true, subtree: true });
  } catch (_) {}

  // Leave once the character is in the world; an error keeps the page.
  window.addEventListener("holtburger:state", (ev) => {
    const st = ev?.detail?.state;
    if (root.dataset.open !== "1") return;
    if (st === "in-world") {
      api.hide();
    } else if (st === "error" && state.entering) {
      state.entering = false;
      const code = window.__lastCharacterError?.code;
      const info = code != null ? characterErrorInfo(code) : null;
      showError(info?.text || String(ev.detail?.message || "Could not enter the world."));
      render();
    }
  });

  const api = {
    show() {
      root.dataset.open = "1";
      state.entering = false;
      placeStage();
      render();
      schedulePreview(true);
      try { root.tabIndex = -1; root.focus(); } catch (_) {}
    },
    hide() {
      root.dataset.open = "0";
      closeDialog();
      clearTimeout(state.previewTimer);
      try { globalThis.window?.liveScene3d?.clearSpawnPreview?.(); } catch (_) {}
    },
    isOpen: () => root.dataset.open === "1",
    refresh: render,
    /** Test / agent hooks. */
    _state: state,
    _select: select,
    _enter: enter,
  };
  root._hcs = api;
  window.__characterSelect = api;
  return api;
}

export { isGreyedOut };
