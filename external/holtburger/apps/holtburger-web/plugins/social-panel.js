// Social panel — retail gmSocialUI (layout 0x21000031) as ONE hub.
// HUD overhaul 2026-10-05.
//
// Retail's toolbar "Social" button opens gmSocialUI: a 300×600 floaty-panel
// page with four tabs along the top — AllegianceTab / FellowshipTab /
// FriendsTab / SquelchTab (m-31.json: 72/72/62/70 × 25 at y=0, plus the
// 24×25 CloseSocialPanelButton) — over four pages at (0,25) 300×575 that
// host gmAllegianceUI 0x2100002F, gmFellowshipUI 0x21000030, gmFriendsUI
// 0x2100005D and gmSquelchUI. Holtburger used to ship three separate views
// that each drew their OWN copy of that tab strip (the allegiance one also
// compressed the 600-px retail layout by 0.56, so its rows stamped over the
// tabs — the "two rows of tab labels" in the 2026-10-05 before-shots), and
// Friends/Squelch only existed as a debug floaty of "… Selected Character"
// buttons. This module is now the single hub:
//
//   • mountSocialHub(parent, {tab})  — kit tab strip (hbk-tabs) + one page.
//   • registerSocialPage(id, page)   — allegiance-panel.js and
//     fellowship-panel.js register their pages at module load. They import
//     THIS module (never the reverse), so there is no import cycle.
//   • The Friends (gmFriendsUI) and Squelch (gmSquelchUI) pages live here.
//   • Main-panel view ids: "allegiance" (F8) and "fellowship" (F9) open the
//     hub on their tab; "social" (Shift+F3, the toolbar Social button) opens
//     it on the last-used tab. A tab click inside the main panel re-routes
//     through __mainPanel.showView(viewForTab) so the F8/F9 toggles stay
//     truthful about what is on screen.
//   • #hb-social-standalone — the same hub as a draggable kit floaty
//     (window.__openSocialPanel / __closeSocialPanel, zoom-aware via
//     attachWindowPosition).
//
// Wire format (unchanged):
//   AddFriend (0x0018) by name · RemoveFriend (0x0017) by guid
//   ModifyCharacterSquelch (0x0058) · ModifyAccountSquelch (0x0059)
//   ModifyGlobalSquelch (0x005B) · SetCharacterOption (AppearOffline 0x27)
//   S2C FriendsListUpdate (0x0021) → friendsUpdated · SetSquelchDb (0x01F4)
//   → squelchUpdated.
// The character Title picker that used to sit here (raw numeric ids) lives
// in the character panel's Titles tab — retail gmCharacterInfoUI — so it is
// not duplicated in the hub.

import { attachWindowPosition } from "../ui/ac_window_position.js";
import { makeTitlebar } from "../ui/hud_kit.js";
import { modalConfirmCallback } from "./modal-dialog.js";

const STYLE_ID = "hb-social-style";
const OVERLAY_ID = "hb-social-standalone";
const TAB_LS_KEY = "hb.social.tab.v1";
const SP = "./data/ui-sprites";

// gmSocialUI root element id (RootSocial_Field 0x1000028B) doubles as the
// floaty's m_eWindowID for position persistence.
const SOCIAL_WINDOW_ID = 0x1000028B;

// ChatMessageType.AllChannels = 0x01 — the value retail gmSquelchUI sends
// (`CM_Communication::Event_ModifyCharacterSquelch(1, 0, name, 1u)`,
// acclient.c gmSquelchUI::ListenToElementMessage) and the only "every
// channel" value ACE accepts: SquelchManager.HandleActionModifyCharacter-
// Squelch rejects any type that is neither AllChannels nor a legal channel,
// and ChatMessageTypeExtensions.ToMask maps AllChannels → SquelchMask.All.
// The previous 0xFFFFFFFF "squelch every bucket" mask was bounced by ACE
// ("… is not a legal squelch channel") and for global squelch shifted to a
// garbage mask bit.
export const SQUELCH_ALL_CHANNELS = 0x01;

// gmFriendsUI::ListenToElementMessage disables Add once
// `m_friendsList._num_elements >= 0x32`.
export const FRIENDS_MAX = 50;

// CharacterOption::AppearOffline (holtburger-common character.rs:157) —
// retail gmFriendsUI AppearOffline_Checkbox.
const OPT_APPEAR_OFFLINE = 0x27;

// The four retail tabs, left→right (m-31.json). `view` is the main-panel
// view a tab click routes to (Friends/Squelch share the generic "social"
// view with ctx.tab).
export const SOCIAL_TABS = Object.freeze([
  Object.freeze({ id: "allegiance", label: "Allegiance", view: "allegiance" }),
  Object.freeze({ id: "fellowship", label: "Fellowship", view: "fellowship" }),
  Object.freeze({ id: "friends", label: "Friends", view: "social" }),
  Object.freeze({ id: "squelch", label: "Squelch", view: "social" }),
]);
const TAB_IDS = new Set(SOCIAL_TABS.map((t) => t.id));

// ─── Pure helpers (exported for tests/social_panel.test.mjs) ─────────────

/**
 * Resolve which tab a hub mount should show: an explicit valid `tab`
 * wins, then the remembered tab, then Allegiance (retail's first tab).
 */
export function resolveSocialTab(tab, remembered) {
  if (typeof tab === "string" && TAB_IDS.has(tab)) return tab;
  if (typeof remembered === "string" && TAB_IDS.has(remembered)) return remembered;
  return "allegiance";
}

/**
 * Retail friends-list order (gmFriendsUI::FindSortedInsertPosition):
 * online friends first, then offline, each block in name order (retail
 * compares with wcscmp — a plain code-unit comparison, kept here).
 * Returns a new array of `{ id, name, online }`.
 */
export function sortFriendsForDisplay(friends) {
  const rows = [];
  for (const f of friends || []) {
    if (!f) continue;
    const id = (f.friendId ?? f.id ?? 0) >>> 0;
    const name = typeof f.name === "string" && f.name ? f.name : "";
    rows.push({ id, name, online: !!(f.isOnline ?? f.online) });
  }
  rows.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    if (a.name === b.name) return a.id - b.id;
    return a.name < b.name ? -1 : 1;
  });
  return rows;
}

/** Whether the Add-friend button may be pressed (gmFriendsUI rule). */
export function canAddFriend(name, count) {
  return typeof name === "string" && name.trim().length > 0 && (count >>> 0) < FRIENDS_MAX;
}

/** Thousands-separated integer for XP columns ("1,234,567"). */
export function fmtInt(n) {
  const v = Math.trunc(Number(n) || 0);
  return v.toLocaleString("en-US");
}

// ─── Shared DOM / session helpers (exported to the page modules) ─────────

/** Append a system line to the chat log (category 0 = system green). */
export function socialEmit(text, cat = 0) {
  if (typeof document === "undefined") return;
  const log = document.getElementById("chat-log");
  if (!log) return;
  const li = document.createElement("li");
  li.className = `cat-${cat}`;
  li.dataset.cat = String(cat);
  li.textContent = text;
  log.appendChild(li);
}

export function getHandle() {
  return (typeof window !== "undefined") ? (window.__sessionHandle ?? null) : null;
}

/**
 * Run `fn(handle)` when the wasm session exposes `method`. Player-facing
 * failure text only — the debug detail goes to the console.
 */
export function withSession(method, fn) {
  const h = getHandle();
  if (typeof h?.[method] !== "function") {
    socialEmit("You must be logged in to do that.");
    return false;
  }
  try {
    fn(h);
    return true;
  } catch (err) {
    console.warn(`[social] ${method} failed`, err);
    socialEmit("Unable to complete that action right now.");
    return false;
  }
}

function entityManager() {
  return (typeof window !== "undefined") ? (window.liveScene3d?.entityManager ?? null) : null;
}

/** Guid of the currently selected world object (0 when none). */
export function selectedTargetGuid() {
  try {
    const g = entityManager()?.getSelectedTarget?.();
    return g ? (g >>> 0) : 0;
  } catch (_) { return 0; }
}

/** Display name of the selected world object ("" when unknown). */
export function selectedTargetName() {
  const g = selectedTargetGuid();
  if (!g) return "";
  try {
    const em = entityManager();
    const n = em?.getEntityName?.(g);
    if (typeof n === "string" && n) return n;
    const meta = em?.entityMap?.get?.(g)?.meta?.name;
    if (meta) return String(meta);
  } catch (_) {}
  try {
    const n = getHandle()?.objectName?.(g);
    if (typeof n === "string" && n) return n;
  } catch (_) {}
  return "";
}

export function localPlayerGuid() {
  try { return (getHandle()?.playerGuid?.() ?? 0) >>> 0; } catch (_) { return 0; }
}

/**
 * ObjectDescriptionFlag.Player (0x08) test — retail gates Swear/Recruit on
 * the selected weenie being a player (vfptr[4] in gmAllegianceUI::
 * UpdateSwearButton / gmFellowshipUI::UpdateButtons). Unknown → true: the
 * server re-validates, and a false negative would strand the button.
 */
export function isPlayerGuid(guid) {
  if (!guid) return false;
  const h = getHandle();
  if (typeof h?.objectDescFlags !== "function") return true;
  try { return ((h.objectDescFlags(guid >>> 0) >>> 0) & 0x08) !== 0; } catch (_) { return true; }
}

/**
 * Select a world object the way retail's list clicks do
 * (ACCWeenieObject::SetSelectedObject in gmFellowshipUI::
 * ListenToElementMessage): through the entity manager's commit path so
 * the target bar hears `selectionChanged`.
 */
export function selectWorldObject(guid) {
  const em = entityManager();
  if (!em || !guid) return;
  // Only objects this client has spawned can carry a selection; committing
  // an unknown guid would just clear the player's current target.
  if (typeof em.entityMap?.has === "function" && !em.entityMap.has(guid >>> 0)) return;
  try {
    if (typeof em._commitSelection === "function") { em._commitSelection(guid >>> 0); return; }
    const prev = (em.getSelectedTarget?.() ?? 0) >>> 0;
    em.setSelectedTarget?.(guid >>> 0);
    if (prev !== (guid >>> 0)) {
      window.__pluginClient?.events?.emit?.("selectionChanged", { guid: guid >>> 0, prevGuid: prev });
    }
  } catch (_) {}
}

/**
 * Subscribe to a plugin-bus event; works pre-login by waiting on
 * window.__pluginClientReady. Returns an unsubscribe fn.
 */
export function onBus(name, fn) {
  if (typeof window === "undefined") return () => {};
  let bus = window.__pluginClient?.events ?? null;
  let live = true;
  if (bus?.on) {
    bus.on(name, fn);
  } else if (window.__pluginClientReady?.then) {
    window.__pluginClientReady.then((client) => {
      if (!live || !client?.events?.on) return;
      bus = client.events;
      bus.on(name, fn);
    }).catch(() => {});
  }
  return () => {
    live = false;
    try { bus?.off?.(name, fn); } catch (_) {}
  };
}

/** Retail-style confirmation dialog (modal-dialog.js) with a safe fallback. */
export function confirmAction({ title, message, confirmLabel, onConfirm }) {
  try {
    modalConfirmCallback({ title, message, confirmLabel, onConfirm });
  } catch (_) {
    if (typeof window !== "undefined" && window.confirm?.(message)) onConfirm?.();
  }
}

/** Read a server-held character option (ACE does not echo them). */
export function readCharacterOption(ordinal) {
  try {
    const h = getHandle();
    if (typeof h?.isCharacterOptionEnabled === "function") return !!h.isCharacterOptionEnabled(ordinal);
  } catch (_) {}
  return false;
}

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

/** Red 9-slice retail button (hbk-btn). */
export function makeKitButton(label, onClick, { cls = "hbk-btn", title } = {}) {
  const b = el("button", cls, label);
  b.type = "button";
  if (title) b.title = title;
  if (typeof onClick === "function") b.addEventListener("click", (ev) => { if (!b.disabled) onClick(ev); });
  return b;
}

let _orbSeq = 0;
/** Unique DOM id (pages can be mounted twice: main panel + floaty). */
export function uid(prefix) { return `${prefix}-${++_orbSeq}`; }

/** Retail orb checkbox (input.hbk-check) with its label. */
export function makeOrb(label, checked, onChange, { title } = {}) {
  const wrap = el("label", "hbk-label hb-soc-orb");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "hbk-check";
  input.id = uid("hb-soc-orb");
  input.checked = !!checked;
  if (title) wrap.title = title;
  input.addEventListener("change", () => { if (typeof onChange === "function") onChange(input.checked, input); });
  wrap.appendChild(input);
  wrap.appendChild(el("span", null, label));
  return { wrap, input };
}

/** The retail 300×9 gold spacer bar (0x06001420 — Spacer1/2/3). */
export function makeSpacer() {
  const s = el("div", "hb-soc-spacer");
  s.setAttribute("aria-hidden", "true");
  return s;
}

/** Two-ended column caption ("VASSALS ……… XP Produced"). */
export function makeColHead(left, right) {
  const h = el("div", "hb-soc-colhead");
  const l = el("span", "hb-soc-colhead-l", left);
  h.appendChild(l);
  const r = el("span", "hb-soc-colhead-r", right ?? "");
  h.appendChild(r);
  return h;
}

/** Selectable list row (hbk-row) with `name` grow cell + right meta. */
export function makeListRow(name, meta, { selected = false, dim = false } = {}) {
  const row = el("div", "hbk-row is-clickable hb-soc-row");
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", selected ? "true" : "false");
  if (selected) row.classList.add("is-selected");
  const n = el("span", "hbk-grow hb-soc-row-name" + (dim ? " is-dim" : ""), name);
  row.appendChild(n);
  if (meta != null) row.appendChild(el("span", "hb-soc-row-meta", meta));
  return row;
}

export function setRowSelected(listEl, rowEl) {
  if (!listEl) return;
  for (const r of listEl.querySelectorAll(".is-selected, [aria-selected='true']")) {
    r.classList.remove("is-selected");
    r.setAttribute("aria-selected", "false");
  }
  if (rowEl) {
    rowEl.classList.add("is-selected");
    rowEl.setAttribute("aria-selected", "true");
  }
}

/** Put "/t Name, " into the chat input (retail CM_UI::SendNotice_StartTell). */
export function startTell(name) {
  if (!name || typeof document === "undefined") return;
  const input = document.querySelector(".hb-chat-input") || document.getElementById("chat-input");
  if (!input) return;
  input.value = `/t ${name}, `;
  try {
    input.focus();
    input.setSelectionRange?.(input.value.length, input.value.length);
  } catch (_) {}
}

// ─── Stylesheet (shared by every social page + the floaty) ───────────────

export function ensureSocialStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    /* Hub frame — fills the 300×337 main-panel body (or the floaty body).
       Retail page field 0x06004CC2 under everything. */
    .hb-social-hub {
      position: absolute; inset: 0;
      display: flex; flex-direction: column;
      box-sizing: border-box;
      font-family: var(--hbk-font); font-size: 12px; color: var(--hbk-text);
      background: url("${SP}/0x06004CC2.png") repeat, var(--hbk-ink, #0b0c10);
      overflow: hidden;
      user-select: none;
    }
    .hb-social-hub > .hbk-tabs { flex: 0 0 auto; }
    /* Kit buttons/rows set display:flex — keep the hidden attribute honest. */
    .hb-social-hub [hidden], #hb-social-standalone [hidden],
    #hb-alleg-standalone [hidden], #hb-fellow-standalone [hidden] { display: none !important; }
    /* Retail tab labels are mixed-case ("Allegiance  Fellowship  Friends
       Squelch") and must fit four-across in 288 px without clipping. */
    .hb-social-tabs > .hbk-tab {
      text-transform: none; letter-spacing: 0.02em; font-size: 12px;
      padding: 2px 2px 3px;
    }
    .hb-social-page {
      position: relative; flex: 1 1 auto; min-height: 0;
      display: flex; flex-direction: column;
    }
    .hb-soc-col {
      flex: 1 1 auto; min-height: 0;
      display: flex; flex-direction: column; gap: 3px;
      padding: 4px 6px 6px;
      box-sizing: border-box;
    }
    .hb-soc-spacer {
      flex: 0 0 9px; height: 9px; margin: 1px -6px;
      background: url("${SP}/0x06001420.png") center / 100% 9px no-repeat;
    }
    .hb-soc-colhead {
      flex: 0 0 auto;
      display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
      padding: 0 4px;
      color: var(--hbk-gold-bright);
      font-size: 11px; letter-spacing: 0.06em;
    }
    .hb-soc-colhead-l { text-transform: uppercase; }
    .hb-soc-colhead-r { color: var(--hbk-text-dim); letter-spacing: 0.02em; white-space: nowrap; }
    .hb-soc-list {
      flex: 1 1 auto; min-height: 44px;
      background: rgba(0, 0, 0, 0.6);
      border: 1px solid #000;
      box-shadow: inset 0 1px 3px #000, 0 1px 0 rgba(243, 210, 122, 0.08);
    }
    .hb-soc-row { min-height: 18px; }
    .hb-soc-row-name.is-dim { color: var(--hbk-text-faint); }
    .hb-soc-row-meta {
      flex: 0 0 auto; margin-left: auto;
      color: var(--hbk-text-dim); font-size: 11px;
      font-variant-numeric: tabular-nums; white-space: nowrap;
    }
    .hb-soc-row.is-pending { opacity: 0.65; }
    .hb-soc-online { color: var(--hbk-value); }
    .hb-soc-offline { color: var(--hbk-text-faint); }
    .hb-soc-btnrow { flex: 0 0 auto; display: flex; gap: 6px; }
    .hb-soc-btnrow > .hbk-btn { flex: 1 1 0; min-width: 0; padding: 0 4px; }
    .hb-soc-field { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; }
    .hb-soc-field > label { color: var(--hbk-text-dim); white-space: nowrap; }
    .hb-soc-field > .hbk-input { flex: 1 1 auto; min-width: 0; height: 20px; }
    .hb-soc-field > .hbk-btn { flex: 0 0 auto; min-width: 56px; }
    .hb-soc-orb { flex: 0 0 auto; align-self: flex-start; padding: 1px 2px; font-size: 12px; }
    .hb-soc-orb.is-center { align-self: center; }
    .hb-soc-empty-block {
      flex: 1 1 auto; min-height: 0;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 6px; padding: 10px 14px; text-align: center;
    }
    .hb-soc-empty-block .hb-soc-empty-title { color: var(--hbk-text); font-size: 13px; }
    .hb-soc-empty-block .hb-soc-empty-hint { color: var(--hbk-text-dim); font-size: 12px; line-height: 1.35; }
    .hb-soc-list > .hbk-empty { padding: 14px 10px; }

    /* Floaty (#hb-social-standalone) — kit window, fits a 1280×720 HUD. */
    #${OVERLAY_ID} {
      width: 300px;
      height: min(430px, calc(100 * var(--hb-hud-vh, 7.2px) - 16px));
      display: flex; flex-direction: column;
      z-index: 60;
    }
    #${OVERLAY_ID}[hidden] { display: none; }
    .hb-soc-floaty-body { position: relative; flex: 1 1 auto; min-height: 0; }
  `;
  document.head.appendChild(style);
}

// ─── Page registry + hub ────────────────────────────────────────────────

const pages = new Map();

/**
 * Register a hub page. `page.mount(pageEl, ctx) → cleanup?` builds the
 * page into `pageEl` (a flex column filling the hub below the tabs).
 */
export function registerSocialPage(id, page) {
  if (!TAB_IDS.has(id) || !page || typeof page.mount !== "function") return;
  pages.set(id, page);
}

function readRememberedTab() {
  try { return localStorage.getItem(TAB_LS_KEY) || null; } catch (_) { return null; }
}
function rememberTab(id) {
  try { localStorage.setItem(TAB_LS_KEY, id); } catch (_) {}
}

/**
 * Mount the social hub into `parentEl`.
 * @param {HTMLElement} parentEl
 * @param {{ tab?: string, inMainPanel?: boolean }} [opts]
 * @returns {() => void} cleanup
 */
export function mountSocialHub(parentEl, opts = {}) {
  ensureSocialStyles();
  const root = el("div", "hb-social-hub");
  const tabs = el("div", "hbk-tabs hb-social-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Social");
  const page = el("div", "hb-social-page");
  page.setAttribute("role", "tabpanel");
  root.appendChild(tabs);
  root.appendChild(page);

  const btns = new Map();
  let active = null;
  let pageCleanup = null;
  let disposed = false;

  function showPage(id) {
    if (disposed) return;
    if (pageCleanup) { try { pageCleanup(); } catch (e) { console.error("[social] page cleanup", e); } }
    pageCleanup = null;
    page.textContent = "";
    active = id;
    for (const [tid, b] of btns) {
      const on = tid === id;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    }
    rememberTab(id);
    const p = pages.get(id);
    if (!p) {
      const block = el("div", "hb-soc-empty-block");
      block.appendChild(el("div", "hb-soc-empty-hint", "This page is not available."));
      page.appendChild(block);
      return;
    }
    try {
      const c = p.mount(page, { inMainPanel: !!opts.inMainPanel });
      pageCleanup = typeof c === "function" ? c : null;
    } catch (e) {
      console.error(`[social] ${id} page mount failed`, e);
    }
  }

  function onTabClick(t) {
    if (t.id === active) return;
    const mp = (typeof window !== "undefined") ? window.__mainPanel : null;
    if (opts.inMainPanel && typeof mp?.showView === "function") {
      rememberTab(t.id);
      mp.showView(t.view, { tab: t.id });
      // A registered view remounted the hub (this root is gone). An
      // unregistered one leaves us mounted — fall back to switching here.
      if (!root.isConnected || disposed) return;
    }
    showPage(t.id);
  }

  for (const t of SOCIAL_TABS) {
    const b = el("button", "hbk-tab", t.label);
    b.type = "button";
    b.dataset.tab = t.id;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", "false");
    b.addEventListener("click", () => onTabClick(t));
    btns.set(t.id, b);
    tabs.appendChild(b);
  }
  // Arrow keys walk the tab strip (modern liberty).
  tabs.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    const i = SOCIAL_TABS.findIndex((t) => t.id === active);
    const n = SOCIAL_TABS.length;
    const next = SOCIAL_TABS[(i + (ev.key === "ArrowRight" ? 1 : n - 1)) % n];
    ev.preventDefault();
    ev.stopPropagation(); // don't let the arrow also steer the character
    onTabClick(next);
    // The main-panel route remounts the hub into the same parent.
    const focusTarget = root.isConnected
      ? btns.get(next.id)
      : parentEl.querySelector?.(".hb-social-tabs .hbk-tab[aria-selected='true']");
    try { focusTarget?.focus?.(); } catch (_) {}
  });

  parentEl.appendChild(root);
  showPage(resolveSocialTab(opts.tab, readRememberedTab()));

  return () => {
    disposed = true;
    if (pageCleanup) { try { pageCleanup(); } catch (_) {} }
    pageCleanup = null;
    root.remove();
  };
}

// ─── Friends page (gmFriendsUI 0x2100005D) ──────────────────────────────

function mountFriendsPage(pageEl) {
  const col = el("div", "hb-soc-col");
  // FriendsLabel "Friend" / OnlineLabel "Status" (8,20).
  col.appendChild(makeColHead("Friend", "Status"));
  const list = el("div", "hbk-scroll hbk-list hb-soc-list");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Friends");
  col.appendChild(list);
  col.appendChild(makeSpacer());

  const appearOffline = makeOrb("Appear Offline", readCharacterOption(OPT_APPEAR_OFFLINE), (on, input) => {
    if (!withSession("setCharacterOption", (h) => h.setCharacterOption(OPT_APPEAR_OFFLINE, on))) {
      input.checked = !on;
    }
  }, { title: "Friends see you as offline" });
  appearOffline.wrap.classList.add("is-center");
  col.appendChild(appearOffline.wrap);

  const btnRow = el("div", "hb-soc-btnrow");
  const tellBtn = makeKitButton("Send Tell", () => {
    const f = currentRows.find((r) => r.id === selectedId);
    if (f) startTell(f.name);
  });
  const removeBtn = makeKitButton("Remove", () => {
    const f = currentRows.find((r) => r.id === selectedId);
    if (!f) return;
    confirmAction({
      title: "Remove Friend",
      message: `Remove ${f.name || "this friend"} from your friends list?`,
      confirmLabel: "Remove",
      onConfirm: () => withSession("removeFriend", (h) => h.removeFriend(f.id >>> 0)),
    });
  });
  btnRow.appendChild(tellBtn);
  btnRow.appendChild(removeBtn);
  col.appendChild(btnRow);
  col.appendChild(makeSpacer());

  // FriendNameLabel / FriendNameEntryBox / AddButton.
  const field = el("div", "hb-soc-field");
  const lbl = el("label", null, "Friend Name:");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "hbk-input";
  input.maxLength = 32;
  input.placeholder = "Character name";
  input.setAttribute("aria-label", "Friend name");
  lbl.htmlFor = input.id = uid("hb-soc-friend-name");
  const addBtn = makeKitButton("Add", () => doAdd());
  field.appendChild(lbl);
  field.appendChild(input);
  field.appendChild(addBtn);
  col.appendChild(field);
  pageEl.appendChild(col);

  let selectedId = 0;
  let currentRows = [];

  function updateButtons() {
    const has = currentRows.some((r) => r.id === selectedId);
    tellBtn.disabled = !has;
    removeBtn.disabled = !has;
    addBtn.disabled = !canAddFriend(input.value, currentRows.length);
  }
  function doAdd() {
    const name = input.value.trim();
    if (!canAddFriend(name, currentRows.length)) return;
    // gmFriendsUI: Request_AddFriend(name) then ClearAllText + disable Add.
    if (withSession("addFriend", (h) => h.addFriend(name))) input.value = "";
    updateButtons();
  }
  input.addEventListener("input", updateButtons);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); doAdd(); }
  });

  function render() {
    const h = getHandle();
    let snap = null;
    try { snap = typeof h?.playerFriends === "function" ? h.playerFriends() : null; } catch (_) {}
    currentRows = sortFriendsForDisplay(snap?.friends ?? []);
    list.textContent = "";
    if (!currentRows.length) {
      list.appendChild(el("div", "hbk-empty", h ? "Your friends list is empty." : "Log in to see your friends."));
    }
    for (const f of currentRows) {
      const row = makeListRow(f.name || "Unknown", null, { selected: f.id === selectedId, dim: !f.online });
      const st = el("span", "hb-soc-row-meta " + (f.online ? "hb-soc-online" : "hb-soc-offline"), f.online ? "Online" : "Offline");
      row.appendChild(st);
      row.dataset.id = String(f.id);
      row.addEventListener("click", () => {
        selectedId = f.id;
        setRowSelected(list, row);
        updateButtons();
      });
      row.addEventListener("dblclick", () => startTell(f.name));
      list.appendChild(row);
    }
    if (!currentRows.some((r) => r.id === selectedId)) selectedId = 0;
    updateButtons();
  }

  render();
  const off = onBus("friendsUpdated", () => { try { render(); } catch (_) {} });
  return () => { off(); col.remove(); };
}

// ─── Squelch (gmSquelchUI) ───────────────────────────────────────────────
//
// Speculative client-side mirror of the squelch DB (Wave I2): ACE does NOT
// re-push SetSquelchDb after a C2S Modify*Squelch round-trip, so the page
// folds each mutation into this mirror for instant feedback and reconciles
// wholesale (server wins) whenever `squelchUpdated` arrives.
let squelchMirror = null;
const squelchRenderers = new Set();
const speculativePending = new Map();
const SPECULATIVE_FADE_MS = 1500;

function serverSnapshotToMirror(snap) {
  if (!snap) return null;
  const chars = Array.isArray(snap.characters) ? snap.characters : [];
  return {
    characters: chars.map((e) => ({
      targetGuid: (e.targetGuid >>> 0),
      name: typeof e.name === "string" ? e.name : "",
      mask: (e.mask >>> 0),
      isAccount: !!e.isAccount,
    })),
    globalsMask: (snap.globals_mask ?? snap.globalsMask ?? 0) >>> 0,
    globalsName: snap.globals_name ?? snap.globalsName ?? "",
  };
}
function emptyMirror() { return { characters: [], globalsMask: 0, globalsName: "" }; }
function readMirror() {
  if (squelchMirror) return squelchMirror;
  let snap = null;
  try { snap = getHandle()?.playerSquelch?.() ?? null; } catch (_) {}
  if (snap) squelchMirror = serverSnapshotToMirror(snap);
  return squelchMirror;
}
function renderAllSquelch() {
  for (const fn of squelchRenderers) { try { fn(); } catch (_) {} }
}
function markPending(key) {
  const deadline = Date.now() + SPECULATIVE_FADE_MS;
  speculativePending.set(key, deadline);
  setTimeout(() => {
    if (speculativePending.get(key) === deadline) {
      speculativePending.delete(key);
      renderAllSquelch();
    }
  }, SPECULATIVE_FADE_MS + 32);
}

/** Mirror key for a squelch entry (account names are case-insensitive). */
export function squelchKey(entry) {
  return entry?.isAccount
    ? `acct:${String(entry.name || "").toLowerCase()}`
    : (entry?.targetGuid ? `char:${entry.targetGuid >>> 0}` : `name:${String(entry?.name || "").toLowerCase()}`);
}

/**
 * Fold one speculative character/account squelch into a mirror (pure —
 * exported for tests). Character squelches by name carry targetGuid 0.
 */
export function applySquelchToMirror(mirror, { name = "", guid = 0, isAccount = false, add = true, mask = SQUELCH_ALL_CHANNELS }) {
  const m = mirror || emptyMirror();
  const lname = String(name || "").toLowerCase();
  const g = guid >>> 0;
  const same = (c) => (isAccount
    ? c.isAccount && c.name.toLowerCase() === lname
    : !c.isAccount && ((g && c.targetGuid === g) || (!!lname && c.name.toLowerCase() === lname)));
  if (add) {
    const existing = m.characters.find(same);
    if (existing) {
      existing.mask = mask >>> 0;
      if (name) existing.name = name;
      if (g) existing.targetGuid = g;
    } else {
      m.characters.push({ targetGuid: isAccount ? 0 : g, name: name || "", mask: mask >>> 0, isAccount: !!isAccount });
    }
  } else {
    m.characters = m.characters.filter((c) => !same(c));
  }
  return m;
}

function squelchCharacter(guid, name, add) {
  return withSession("modifyCharacterSquelch", (h) => {
    h.modifyCharacterSquelch(guid >>> 0, name || "", add, SQUELCH_ALL_CHANNELS);
    squelchMirror = applySquelchToMirror(squelchMirror, { guid, name, add });
    markPending(squelchKey({ targetGuid: guid, name, isAccount: false }));
    renderAllSquelch();
  });
}
function squelchAccount(name, add) {
  return withSession("modifyAccountSquelch", (h) => {
    h.modifyAccountSquelch(name, add, SQUELCH_ALL_CHANNELS);
    squelchMirror = applySquelchToMirror(squelchMirror, { name, isAccount: true, add });
    markPending(squelchKey({ name, isAccount: true }));
    renderAllSquelch();
  });
}
function squelchGlobal(add) {
  return withSession("modifyGlobalSquelch", (h) => {
    h.modifyGlobalSquelch(add, SQUELCH_ALL_CHANNELS);
    if (!squelchMirror) squelchMirror = emptyMirror();
    squelchMirror.globalsMask = add ? SQUELCH_ALL_CHANNELS : 0;
    markPending("global");
    renderAllSquelch();
  });
}

function mountSquelchPage(pageEl) {
  const col = el("div", "hb-soc-col");
  col.appendChild(makeColHead("Squelched", "Type"));
  const list = el("div", "hbk-scroll hbk-list hb-soc-list");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Squelched players");
  col.appendChild(list);

  const unRow = el("div", "hb-soc-btnrow");
  const unBtn = makeKitButton("Unsquelch", () => {
    const e = currentEntries.find((x) => squelchKey(x) === selectedKey);
    if (!e) return;
    // gmSquelchUI: account rows → ModifyAccountSquelch(0, name);
    // character rows → ModifyCharacterSquelch(0, 0, name, AllChannels).
    if (e.isAccount) squelchAccount(e.name, false);
    else squelchCharacter(e.targetGuid, e.name, false);
  });
  unRow.appendChild(unBtn);
  col.appendChild(unRow);
  col.appendChild(makeSpacer());

  const field = el("div", "hb-soc-field");
  const lbl = el("label", null, "Name:");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "hbk-input";
  input.maxLength = 64;
  input.placeholder = "Character name";
  lbl.htmlFor = input.id = uid("hb-soc-squelch-name");
  const targetBtn = makeKitButton("Target", () => {
    const n = selectedTargetName();
    if (n) { input.value = n; updateButtons(); }
    else socialEmit("Select a player first.");
  }, { cls: "hbk-btn-small hbk-brown", title: "Use the selected player's name" });
  field.appendChild(lbl);
  field.appendChild(input);
  field.appendChild(targetBtn);
  col.appendChild(field);

  const addRow = el("div", "hb-soc-btnrow");
  const charBtn = makeKitButton("Squelch Character", () => {
    const name = input.value.trim();
    if (!name) return;
    if (squelchCharacter(0, name, true)) input.value = "";
    updateButtons();
  }, { title: "Hide every chat message from this character" });
  const acctBtn = makeKitButton("Squelch Account", () => {
    const name = input.value.trim();
    if (!name) return;
    confirmAction({
      title: "Squelch Account",
      message: `Squelch every character on ${name}'s account?`,
      confirmLabel: "Squelch",
      onConfirm: () => { if (squelchAccount(name, true)) input.value = ""; updateButtons(); },
    });
  }, { title: "Hide every character on this player's account" });
  addRow.appendChild(charBtn);
  addRow.appendChild(acctBtn);
  col.appendChild(addRow);
  col.appendChild(makeSpacer());

  const globalOrb = makeOrb("Squelch all global chat channels", false, (on, inp) => {
    if (!on) { if (!squelchGlobal(false)) inp.checked = true; return; }
    inp.checked = false;
    confirmAction({
      title: "Squelch Global Chat",
      message: "Hide every global chat channel message?",
      confirmLabel: "Squelch",
      onConfirm: () => { if (squelchGlobal(true)) inp.checked = true; },
    });
  });
  col.appendChild(globalOrb.wrap);
  pageEl.appendChild(col);

  let selectedKey = "";
  let currentEntries = [];

  function updateButtons() {
    unBtn.disabled = !currentEntries.some((x) => squelchKey(x) === selectedKey);
    const has = input.value.trim().length > 0;
    charBtn.disabled = !has;
    acctBtn.disabled = !has;
  }
  input.addEventListener("input", updateButtons);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); charBtn.click(); }
  });

  function render() {
    const mirror = readMirror();
    currentEntries = [...(mirror?.characters ?? [])]
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    globalOrb.input.checked = !!(mirror && mirror.globalsMask);
    list.textContent = "";
    if (!currentEntries.length) {
      list.appendChild(el("div", "hbk-empty", getHandle() ? "No one is squelched." : "Log in to manage squelches."));
    }
    for (const e of currentEntries) {
      const key = squelchKey(e);
      const row = makeListRow(e.name || "Unknown", e.isAccount ? "Account" : "Character", { selected: key === selectedKey });
      if (speculativePending.has(key)) row.classList.add("is-pending");
      row.addEventListener("click", () => {
        selectedKey = key;
        setRowSelected(list, row);
        updateButtons();
      });
      list.appendChild(row);
    }
    if (!currentEntries.some((x) => squelchKey(x) === selectedKey)) selectedKey = "";
    updateButtons();
  }

  squelchRenderers.add(render);
  render();
  // Server-wins reconcile: ACE's snapshot replaces the speculative mirror.
  const off = onBus("squelchUpdated", () => {
    try {
      const snap = getHandle()?.playerSquelch?.();
      squelchMirror = snap ? serverSnapshotToMirror(snap) : null;
      speculativePending.clear();
      renderAllSquelch();
    } catch (_) {}
  });
  return () => { off(); squelchRenderers.delete(render); col.remove(); };
}

registerSocialPage("friends", { mount: mountFriendsPage });
registerSocialPage("squelch", { mount: mountSquelchPage });

// ─── Main-panel view + floaty ───────────────────────────────────────────

/** Main-panel view "social": the hub on ctx.tab or the last-used tab. */
export const view = {
  name: "Social",
  nameFor: () => "Social",
  mount: (parentEl, ctx) => mountSocialHub(parentEl, { tab: ctx?.tab, inMainPanel: true }),
};

/** Register the "social" view with the shared main panel (idempotent). */
export function ensureSocialViewRegistered() {
  try { window.__mainPanel?.registerView?.("social", view); } catch (_) {}
}

let floaty = null; // { win, body, cleanup }

function buildFloaty() {
  ensureSocialStyles();
  const win = el("div", "hbk-window");
  win.id = OVERLAY_ID;
  win.hidden = true;
  win.setAttribute("role", "dialog");
  win.setAttribute("aria-label", "Social");
  const { bar } = makeTitlebar("Social", { onClose: () => closeFloaty() });
  win.appendChild(bar);
  const body = el("div", "hb-soc-floaty-body");
  win.appendChild(body);
  win.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && ev.target?.tagName !== "INPUT") closeFloaty();
  });
  document.body.appendChild(win);
  attachWindowPosition(win, {
    windowId: SOCIAL_WINDOW_ID,
    dragHandle: bar,
    ignoreSelector: ".hbk-close",
    defaultPos: { right: "330px", top: "96px" },
  });
  return { win, body, cleanup: null };
}

function openFloaty(tab) {
  if (typeof document === "undefined") return;
  if (!floaty) floaty = buildFloaty();
  if (!floaty.cleanup || tab) {
    if (floaty.cleanup) { try { floaty.cleanup(); } catch (_) {} }
    floaty.cleanup = mountSocialHub(floaty.body, { tab, inMainPanel: false });
  }
  floaty.win.hidden = false;
}

function closeFloaty() {
  if (!floaty) return;
  floaty.win.hidden = true;
  // Unmount so pages drop their bus subscriptions (and the fellowship page
  // tells the server the panel closed — retail OnVisibilityChanged).
  if (floaty.cleanup) { try { floaty.cleanup(); } catch (_) {} }
  floaty.cleanup = null;
}

function isFloatyOpen() { return !!floaty && !floaty.win.hidden; }

// Boot hooks: page modules that need page-lifetime wiring independent of
// any panel being open (e.g. the allegiance login/logout chat line, which
// retail's gmAllegianceUI receives whether or not the panel is shown).
const bootHooks = new Set();
let booted = false;
/** Run `fn` once the HUD bar has booted (immediately if it already has). */
export function onSocialBoot(fn) {
  if (typeof fn !== "function") return;
  bootHooks.add(fn);
  if (booted) { try { fn(); } catch (e) { console.warn("[social] boot hook", e); } }
}

/** Bar-slot mount (iconHidden): registers the "social" main-panel view. */
export function mount() {
  ensureSocialViewRegistered();
  booted = true;
  for (const fn of bootHooks) { try { fn(); } catch (e) { console.warn("[social] boot hook", e); } }
  return () => {};
}

if (typeof window !== "undefined") {
  if (!window.__hbSocialPanelEscBound && typeof window.addEventListener === "function") {
    window.__hbSocialPanelEscBound = true;
    window.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape" || !isFloatyOpen()) return;
      const tag = ev.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      closeFloaty();
    });
  }
  // Floaty hub (devtools / power users). `tab` is optional.
  window.__openSocialPanel = (tab) => openFloaty(tab);
  window.__closeSocialPanel = closeFloaty;
  // Shift+F3 (PLUGIN_HOTKEY_DISPATCH "social-panel") and the toolbar
  // Social button: toggle the hub in the shared main panel. Any of the
  // three hub view ids counts as "the social panel is open".
  window.__toggleSocialPanel = () => {
    const mp = window.__mainPanel;
    if (typeof mp?.showView !== "function") {
      if (isFloatyOpen()) closeFloaty(); else openFloaty();
      return;
    }
    ensureSocialViewRegistered();
    const cur = mp.isOpen?.() ? mp.currentViewId?.() : null;
    if (cur === "social" || cur === "allegiance" || cur === "fellowship") mp.closeView?.();
    else mp.showView("social");
  };
}

export const manifest = {
  id: "social-panel",
  name: "Social",
  icon: "🤝",
  iconHidden: true,
  version: "0.3.0",
  description: "Social hub (gmSocialUI 0x21000031): Allegiance / Fellowship / Friends / Squelch tabs",
};
