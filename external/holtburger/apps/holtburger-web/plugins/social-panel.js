// Social panel — Wave E2 + Wave H1 + Wave H2 + Wave H3 + Wave I2.
//
// Standalone floating overlay (mirrors allegiance-panel.js's IIFE
// pattern). Exposes window.__openSocialPanel / __closeSocialPanel for
// ad-hoc opening from devtools or hotkeys. Sections:
//   - Friends Add/Remove (E2): add-by-name, remove-by-selected
//   - Friends list (H1): live snapshot from handle.playerFriends()
//   - Squelch Character (E2): squelch / unsquelch selected character
//   - Squelch Account (H2): squelch / unsquelch by account name
//   - Squelch Global (H2): squelch / unsquelch every global channel
//   - Squelched list (H3 + I2): server snapshot folded into a
//       speculative mirror that mutates on every C2S Modify*Squelch
//       and reconciles to the authoritative view on squelchUpdated.
//   - Title (H2/H3): pick from earned titles via handle.playerTitle()
//
// Wire format:
//   - AddFriend (0x0018)              — by-name (ACE GameActionAddFriend.cs)
//   - RemoveFriend (0x0017)           — by-guid (ACE GameActionRemoveFriend.cs)
//   - ModifyCharacterSquelch (0x0058) — bool/guid/name/u32
//   - ModifyAccountSquelch (0x0059)   — bool/name (no per-channel mask)
//   - ModifyGlobalSquelch (0x005B)    — bool/u32 (ChatMessageType mask)
//   - TitleSet (0x002C)               — u32 (CharacterTitle ordinal)
//   - FriendsListUpdate (0x0021)      — S2C, snapshot via playerFriends()
//   - SetSquelchDb (0x01F4)           — S2C, snapshot via playerSquelch()
//   - CharacterTitle (0x0029)         — S2C, snapshot via playerTitle()
//   - UpdateTitle (0x002B)            — S2C, single-title delta
//     0xFFFFFFFF mask = retail UX shortcut for "squelch every chat type".

import { setAcText } from "../ui/ac_font.js";

const STYLE_ID = "hb-social-standalone-style";
const OVERLAY_ID = "hb-social-standalone";

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${OVERLAY_ID} {
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
    #${OVERLAY_ID}.open { display: block; }
    .hb-social-hdr {
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
    .hb-social-x {
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
    .hb-social-x:hover {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
    .hb-social-body { padding: 10px; }
    .hb-social-section {
      margin-bottom: 8px;
    }
    .hb-social-section-title {
      font-size: 10px;
      color: var(--hb-text-gold);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 4px;
      padding-bottom: 2px;
      border-bottom: 1px solid var(--hb-border-brass-dim);
    }
    .hb-social-row {
      display: flex;
      gap: 4px;
      margin-bottom: 4px;
    }
    .hb-social-input {
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
    .hb-social-input:focus {
      border-color: var(--hb-border-brass);
    }
    .hb-social-btn {
      box-sizing: border-box;
      padding: 6px 8px;
      font-family: var(--hb-font-serif);
      font-size: 10px;
      letter-spacing: 0.04em;
      color: var(--hb-text-cream);
      background: linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      border: 1px solid var(--hb-border-brass);
      cursor: pointer;
      text-transform: uppercase;
      user-select: none;
    }
    .hb-social-btn:hover {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
    .hb-social-btn.full {
      width: 100%;
      padding: 8px 6px;
      font-size: 11px;
      margin-bottom: 4px;
    }
    .hb-social-placeholder {
      padding: 8px 6px;
      font-size: 10px;
      color: rgba(220, 200, 160, 0.55);
      font-style: italic;
      border-top: 1px solid var(--hb-border-brass-dim);
      text-align: center;
    }
    .hb-social-toast {
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
    .hb-social-friends-list {
      max-height: 180px;
      overflow-y: auto;
      border: 1px solid var(--hb-border-brass-dim);
      background: rgba(0, 0, 0, 0.35);
      margin-top: 4px;
    }
    .hb-social-friend-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 6px;
      font-size: 11px;
      color: var(--hb-text-cream);
      border-bottom: 1px solid rgba(0, 0, 0, 0.35);
    }
    .hb-social-friend-row:last-child { border-bottom: none; }
    .hb-social-friend-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex: 0 0 auto;
      box-shadow: 0 0 4px currentColor;
    }
    .hb-social-friend-dot.online { background: #6f6; color: #6f6; }
    .hb-social-friend-dot.offline { background: #666; color: #444; box-shadow: none; }
    .hb-social-friend-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hb-social-friend-x {
      flex: 0 0 auto;
      width: 18px;
      height: 18px;
      padding: 0;
      font-family: inherit;
      font-size: 12px;
      line-height: 1;
      color: var(--hb-text-cream);
      background: transparent;
      border: 1px solid var(--hb-border-brass-dim);
      cursor: pointer;
    }
    .hb-social-friend-x:hover {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
    .hb-social-friends-empty {
      padding: 8px 6px;
      font-size: 10px;
      color: rgba(220, 200, 160, 0.55);
      font-style: italic;
      text-align: center;
    }
    .hb-social-squelch-list {
      max-height: 160px;
      overflow-y: auto;
      border: 1px solid var(--hb-border-brass-dim);
      background: rgba(0, 0, 0, 0.35);
      margin-top: 4px;
    }
    .hb-social-squelch-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 6px;
      font-size: 11px;
      color: var(--hb-text-cream);
      border-bottom: 1px solid rgba(0, 0, 0, 0.35);
    }
    .hb-social-squelch-row:last-child { border-bottom: none; }
    .hb-social-squelch-badge {
      flex: 0 0 auto;
      display: inline-block;
      min-width: 14px;
      padding: 1px 3px;
      font-size: 9px;
      text-align: center;
      letter-spacing: 0.04em;
      color: var(--hb-text-gold);
      border: 1px solid var(--hb-border-brass-dim);
      background: rgba(0, 0, 0, 0.45);
    }
    .hb-social-squelch-badge.placeholder {
      visibility: hidden;
    }
    .hb-social-squelch-name {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .hb-social-squelch-x {
      flex: 0 0 auto;
      width: 18px;
      height: 18px;
      padding: 0;
      font-family: inherit;
      font-size: 12px;
      line-height: 1;
      color: var(--hb-text-cream);
      background: transparent;
      border: 1px solid var(--hb-border-brass-dim);
      cursor: pointer;
    }
    .hb-social-squelch-x:hover {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
    .hb-social-squelch-empty {
      padding: 8px 6px;
      font-size: 10px;
      color: rgba(220, 200, 160, 0.55);
      font-style: italic;
      text-align: center;
    }
    .hb-social-select {
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
    .hb-social-select:focus {
      border-color: var(--hb-border-brass);
    }
    .hb-social-title-empty {
      padding: 4px 6px;
      font-size: 10px;
      color: rgba(220, 200, 160, 0.55);
      font-style: italic;
    }
  `;
  document.head.appendChild(style);
}

let overlay = null;
// Wave-H1 (2026-05-26): subscription cleanups installed by buildOverlay
// for friendsUpdated. Currently unused (overlay lives for the page
// lifetime — no per-mount teardown), but kept so a future refactor
// that destroys/rebuilds the overlay can call them.
const overlay_unsubscribe_handlers = [];

function emit(msgText, cat = 0) {
  const log = document.getElementById("chat-log");
  if (!log) return;
  const li = document.createElement("li");
  li.className = `cat-${cat}`;
  li.dataset.cat = String(cat);
  li.textContent = msgText;
  log.appendChild(li);
}

function currentSelectedGuid() {
  try {
    const em = window.liveScene3d?.entityManager;
    const g = em?.getSelectedTarget?.();
    return g ? (g >>> 0) : null;
  } catch (_) {
    return null;
  }
}

function currentSelectedName() {
  try {
    const em = window.liveScene3d?.entityManager;
    const g = em?.getSelectedTarget?.();
    if (!g) return "";
    const name = em?.getEntityName?.(g);
    return typeof name === "string" ? name : "";
  } catch (_) {
    return "";
  }
}

function withSession(label, fn) {
  const handle = window.__sessionHandle;
  if (typeof handle?.[label] !== "function") {
    emit(`[social] Wasm session not ready (${label}).`);
    return;
  }
  try {
    fn(handle);
  } catch (err) {
    emit(`[social] ${label} failed: ${err?.message ?? err}`);
  }
}

function toast(text) {
  if (!overlay) return;
  const old = overlay.querySelector(".hb-social-toast");
  if (old) old.remove();
  const t = document.createElement("div");
  t.className = "hb-social-toast";
  t.textContent = text;
  overlay.appendChild(t);
  setTimeout(() => t.remove(), 1750);
}

// 0xFFFFFFFF = squelch every ChatMessageType bucket (retail UX shortcut
// for "squelch everything"); ACE persists per-character in
// SquelchManager keyed by guid.
const SQUELCH_ALL_MASK = 0xFFFFFFFF;

// Wave-I2 (2026-05-26): speculative client-side mirror of the squelch
// DB. ACE does NOT re-push SetSquelchDb after a C2S Modify*Squelch
// round-trip — the authoritative list only refreshes on next login —
// so the panel folds mutations into this mirror for instant UX, then
// reconciles wholesale when the server actually pushes (today: at
// login; tomorrow: if ACE grows deltas). Server-wins on reconcile.
let squelchMirror = null;
// Render hooks registered by buildOverlay so mutations made outside
// the overlay (or future deltas) repaint every visible squelch list.
const squelchRenderers = [];
// Map of (mirror-key, deadline_ms) — drives the brief 0.7-opacity
// pulse on rows that just mutated speculatively.
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

function emptyMirror() {
  return { characters: [], globalsMask: 0, globalsName: "" };
}

function readMirror() {
  if (squelchMirror) return squelchMirror;
  const snap = window.__sessionHandle?.playerSquelch?.();
  if (snap) squelchMirror = serverSnapshotToMirror(snap);
  return squelchMirror;
}

function renderAllSquelchLists() {
  for (const fn of squelchRenderers) {
    try { fn(); } catch (_) {}
  }
}

function markPending(key) {
  const deadline = Date.now() + SPECULATIVE_FADE_MS;
  speculativePending.set(key, deadline);
  setTimeout(() => {
    if (speculativePending.get(key) === deadline) {
      speculativePending.delete(key);
      renderAllSquelchLists();
    }
  }, SPECULATIVE_FADE_MS + 32);
}

// Speculative character squelch. Calls wasm AND folds the result into
// the mirror so the row appears/disappears before the next login.
function squelchCharacter(guid, name, add, mask) {
  withSession("modifyCharacterSquelch", (h) => {
    h.modifyCharacterSquelch(guid, name, add, mask);
    emit(`[squelch/character] target=0x${guid.toString(16).padStart(8, "0")} add=${add} mask=0x${mask.toString(16).toUpperCase()}`);
    if (!squelchMirror) squelchMirror = emptyMirror();
    const key = `char:${guid >>> 0}`;
    if (add) {
      const existing = squelchMirror.characters.find((c) => c.targetGuid === (guid >>> 0) && !c.isAccount);
      if (existing) {
        existing.mask = mask >>> 0;
        if (name) existing.name = name;
      } else {
        squelchMirror.characters.push({ targetGuid: guid >>> 0, name: name || "", mask: mask >>> 0, isAccount: false });
      }
    } else {
      squelchMirror.characters = squelchMirror.characters.filter((c) => !(c.targetGuid === (guid >>> 0) && !c.isAccount));
    }
    markPending(key);
    renderAllSquelchLists();
  });
}

function squelchAccount(accountName, add, mask) {
  withSession("modifyAccountSquelch", (h) => {
    h.modifyAccountSquelch(accountName, add, mask);
    emit(`[squelch/account] name=${accountName} add=${add} mask=0x${mask.toString(16).toUpperCase()}`);
    if (!squelchMirror) squelchMirror = emptyMirror();
    const key = `acct:${accountName.toLowerCase()}`;
    if (add) {
      const existing = squelchMirror.characters.find((c) => c.isAccount && c.name.toLowerCase() === accountName.toLowerCase());
      if (existing) existing.mask = mask >>> 0;
      else squelchMirror.characters.push({ targetGuid: 0, name: accountName, mask: mask >>> 0, isAccount: true });
    } else {
      squelchMirror.characters = squelchMirror.characters.filter(
        (c) => !(c.isAccount && c.name.toLowerCase() === accountName.toLowerCase()),
      );
    }
    markPending(key);
    renderAllSquelchLists();
  });
}

function squelchGlobal(add, mask) {
  withSession("modifyGlobalSquelch", (h) => {
    h.modifyGlobalSquelch(add, mask);
    emit(`[squelch/global] add=${add} mask=0x${mask.toString(16).toUpperCase()}`);
    if (!squelchMirror) squelchMirror = emptyMirror();
    squelchMirror.globalsMask = add ? (mask >>> 0) : 0;
    markPending("global");
    renderAllSquelchLists();
  });
}

function buildOverlay() {
  ensureStyles();
  const el = document.createElement("div");
  el.id = OVERLAY_ID;

  const hdr = document.createElement("div");
  hdr.className = "hb-social-hdr";
  const title = document.createElement("span");
  setAcText(title, "Social");
  hdr.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "hb-social-x";
  closeBtn.title = "Close (Esc)";
  closeBtn.textContent = "x";
  closeBtn.addEventListener("click", close);
  hdr.appendChild(closeBtn);
  el.appendChild(hdr);

  const body = document.createElement("div");
  body.className = "hb-social-body";

  // ── Friends section ────────────────────────────────────────────────
  const friendsSec = document.createElement("div");
  friendsSec.className = "hb-social-section";
  const friendsTitle = document.createElement("div");
  friendsTitle.className = "hb-social-section-title";
  setAcText(friendsTitle, "Friends");
  friendsSec.appendChild(friendsTitle);

  const addRow = document.createElement("div");
  addRow.className = "hb-social-row";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "hb-social-input";
  nameInput.placeholder = "Friend name";
  nameInput.maxLength = 32;
  addRow.appendChild(nameInput);
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "hb-social-btn";
  setAcText(addBtn, "Add");
  const doAdd = () => {
    const name = nameInput.value.trim();
    if (!name) { toast("Enter a name"); return; }
    withSession("addFriend", (h) => {
      h.addFriend(name);
      emit(`[friends/add] name=${name}`);
      toast("Add Friend sent");
      nameInput.value = "";
    });
  };
  addBtn.addEventListener("click", doAdd);
  nameInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); doAdd(); }
  });
  addRow.appendChild(addBtn);
  friendsSec.appendChild(addRow);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "hb-social-btn full";
  setAcText(removeBtn, "Remove Friend by Selected");
  removeBtn.title = "Remove the currently selected character from your friends list";
  removeBtn.addEventListener("click", () => {
    const guid = currentSelectedGuid();
    if (!guid) { toast("Click a player first"); return; }
    const nm = currentSelectedName();
    const who = nm ? `"${nm}" (0x${guid.toString(16).padStart(8, "0")})` : `0x${guid.toString(16).padStart(8, "0")}`;
    if (!window.confirm(`Remove ${who} from your friends list?`)) return;
    withSession("removeFriend", (h) => {
      h.removeFriend(guid);
      emit(`[friends/remove] target=0x${guid.toString(16).padStart(8, "0")}`);
      toast("Remove Friend sent");
    });
  });
  friendsSec.appendChild(removeBtn);

  // Wave-H1 (2026-05-26): receive-side Friends list. ACE pushes
  // `GameEvent::FriendsListUpdate` (opcode 0x0021); the wasm side
  // folds the wire payload per FriendsUpdateTypeFlags and emits a
  // kind=26 ClientEvent which index.html re-emits as
  // `friendsUpdated`. We re-pull on each event.
  const friendsListHeader = document.createElement("div");
  friendsListHeader.className = "hb-social-section-title";
  friendsListHeader.style.marginTop = "6px";
  setAcText(friendsListHeader, "Friends (0)");
  friendsSec.appendChild(friendsListHeader);

  const friendsListEl = document.createElement("div");
  friendsListEl.className = "hb-social-friends-list";
  friendsSec.appendChild(friendsListEl);

  function renderFriendsList() {
    const handle = window.__sessionHandle;
    const snap = typeof handle?.playerFriends === "function" ? handle.playerFriends() : null;
    const friends = snap?.friends ?? [];

    setAcText(friendsListHeader, `Friends (${friends.length})`);

    friendsListEl.innerHTML = "";
    if (friends.length === 0) {
      const empty = document.createElement("div");
      empty.className = "hb-social-friends-empty";
      setAcText(empty, "No friends yet — Add one above.");
      friendsListEl.appendChild(empty);
      return;
    }

    for (const f of friends) {
      const row = document.createElement("div");
      row.className = "hb-social-friend-row";

      const dot = document.createElement("span");
      dot.className = `hb-social-friend-dot ${f.isOnline ? "online" : "offline"}`;
      dot.title = f.isOnline ? "Online" : "Offline";
      row.appendChild(dot);

      const nameEl = document.createElement("span");
      nameEl.className = "hb-social-friend-name";
      setAcText(nameEl, f.name || `0x${f.friendId.toString(16).padStart(8, "0")}`);
      row.appendChild(nameEl);

      const xBtn = document.createElement("button");
      xBtn.type = "button";
      xBtn.className = "hb-social-friend-x";
      xBtn.textContent = "x";
      const fid = f.friendId >>> 0;
      const fname = f.name || `0x${fid.toString(16).padStart(8, "0")}`;
      xBtn.title = `Remove ${fname}`;
      xBtn.addEventListener("click", () => {
        if (!window.confirm(`Remove ${fname} from your friends list?`)) return;
        withSession("removeFriend", (h) => {
          h.removeFriend(fid);
          emit(`[friends/remove] target=0x${fid.toString(16).padStart(8, "0")}`);
          toast("Remove Friend sent");
        });
      });
      row.appendChild(xBtn);

      friendsListEl.appendChild(row);
    }
  }

  const bus = window.__pluginClient?.events;
  if (bus && typeof bus.on === "function") {
    const listener = () => { try { renderFriendsList(); } catch (_) {} };
    bus.on("friendsUpdated", listener);
    overlay_unsubscribe_handlers.push(() => {
      if (typeof bus.off === "function") bus.off("friendsUpdated", listener);
    });
  }
  // Initial render: pre-FullList playerFriends() returns null → "No friends yet".
  renderFriendsList();

  body.appendChild(friendsSec);

  // ── Squelch section ────────────────────────────────────────────────
  const squelchSec = document.createElement("div");
  squelchSec.className = "hb-social-section";
  const squelchTitle = document.createElement("div");
  squelchTitle.className = "hb-social-section-title";
  setAcText(squelchTitle, "Squelch (Character)");
  squelchSec.appendChild(squelchTitle);

  const SQUELCH_ACTIONS = [
    {
      label: "Squelch Selected Character",
      confirm: (who) => `Squelch ${who}? (all chat types)`,
      add: true,
      verb: "squelch",
      toastMsg: "Squelch sent",
    },
    {
      label: "Unsquelch Selected Character",
      confirm: (who) => `Unsquelch ${who}?`,
      add: false,
      verb: "unsquelch",
      toastMsg: "Unsquelch sent",
    },
  ];

  for (const a of SQUELCH_ACTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hb-social-btn full";
    btn.dataset.action = a.verb;
    setAcText(btn, a.label);
    btn.addEventListener("click", () => {
      const guid = currentSelectedGuid();
      if (!guid) { toast("Click a player first"); return; }
      const nm = currentSelectedName();
      const who = nm ? `"${nm}" (0x${guid.toString(16).padStart(8, "0")})` : `0x${guid.toString(16).padStart(8, "0")}`;
      if (!window.confirm(a.confirm(who))) return;
      squelchCharacter(guid, nm, a.add, SQUELCH_ALL_MASK);
      toast(a.toastMsg);
    });
    squelchSec.appendChild(btn);
  }
  body.appendChild(squelchSec);

  // ── Account Squelch section ────────────────────────────────────────
  const acctSec = document.createElement("div");
  acctSec.className = "hb-social-section";
  const acctTitle = document.createElement("div");
  acctTitle.className = "hb-social-section-title";
  setAcText(acctTitle, "Squelch (Account)");
  acctSec.appendChild(acctTitle);

  const acctRow = document.createElement("div");
  acctRow.className = "hb-social-row";
  const acctInput = document.createElement("input");
  acctInput.type = "text";
  acctInput.className = "hb-social-input";
  acctInput.placeholder = "Account name";
  acctInput.maxLength = 64;
  acctRow.appendChild(acctInput);
  acctSec.appendChild(acctRow);

  const ACCOUNT_ACTIONS = [
    { label: "Squelch Account", add: true, verb: "squelch", toastMsg: "Account Squelch sent",
      confirm: (acct) => `Squelch account "${acct}"? (all characters, all chat types)` },
    { label: "Unsquelch Account", add: false, verb: "unsquelch", toastMsg: "Account Unsquelch sent",
      confirm: (acct) => `Unsquelch account "${acct}"?` },
  ];

  for (const a of ACCOUNT_ACTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hb-social-btn full";
    btn.dataset.action = `acct-${a.verb}`;
    setAcText(btn, a.label);
    btn.addEventListener("click", () => {
      const acct = acctInput.value.trim();
      if (!acct) { toast("Enter an account"); return; }
      if (!window.confirm(a.confirm(acct))) return;
      squelchAccount(acct, a.add, SQUELCH_ALL_MASK);
      toast(a.toastMsg);
      if (!a.add) acctInput.value = "";
    });
    acctSec.appendChild(btn);
  }
  body.appendChild(acctSec);

  // ── Global Squelch section ─────────────────────────────────────────
  const globalSec = document.createElement("div");
  globalSec.className = "hb-social-section";
  const globalTitle = document.createElement("div");
  globalTitle.className = "hb-social-section-title";
  setAcText(globalTitle, "Squelch (Global)");
  globalSec.appendChild(globalTitle);

  const GLOBAL_ACTIONS = [
    { label: "Squelch All Channels", add: true, verb: "squelch", toastMsg: "Global Squelch sent",
      confirm: () => "Squelch every global chat channel?" },
    { label: "Unsquelch All Channels", add: false, verb: "unsquelch", toastMsg: "Global Unsquelch sent",
      confirm: () => "Unsquelch every global chat channel?" },
  ];

  for (const a of GLOBAL_ACTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hb-social-btn full";
    btn.dataset.action = `global-${a.verb}`;
    setAcText(btn, a.label);
    btn.addEventListener("click", () => {
      if (!window.confirm(a.confirm())) return;
      squelchGlobal(a.add, SQUELCH_ALL_MASK);
      toast(a.toastMsg);
    });
    globalSec.appendChild(btn);
  }
  body.appendChild(globalSec);

  // ── Squelched list ─────────────────────────────────────────────────
  // Wave-H3 (2026-05-26): receive-side squelch DB. ACE pushes
  // `GameEvent::SetSquelchDb` (opcode 0x01F4) at login; the wasm side
  // folds the wire payload into `latest_squelch` and emits a kind=27
  // ClientEvent which index.html re-emits as `squelchUpdated`. The
  // [A] badge marks account-wide squelches (SquelchInfo.account=true);
  // unbadged rows are per-character squelches. Removal sends
  // ModifyCharacterSquelch with add=false + 0xFFFFFFFF mask (retail
  // UX: unsquelch all chat types).
  //
  // Wave-I2 (2026-05-26): ACE does NOT re-push SetSquelchDb after a
  // C2S Modify*Squelch, so the visible list would only refresh on
  // next login. Mutations now fold into the module-level
  // `squelchMirror` for instant UX; the server-pushed snapshot still
  // wins on `squelchUpdated` reconcile.
  const squelchListSec = document.createElement("div");
  squelchListSec.className = "hb-social-section";
  const squelchListHeader = document.createElement("div");
  squelchListHeader.className = "hb-social-section-title";
  setAcText(squelchListHeader, "Squelched (0)");
  squelchListSec.appendChild(squelchListHeader);

  const squelchListEl = document.createElement("div");
  squelchListEl.className = "hb-social-squelch-list";
  squelchListSec.appendChild(squelchListEl);

  function renderSquelchList() {
    const mirror = readMirror();
    const entries = mirror?.characters ?? [];

    setAcText(squelchListHeader, `Squelched (${entries.length})`);

    squelchListEl.innerHTML = "";
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "hb-social-squelch-empty";
      setAcText(empty, "No squelches active.");
      squelchListEl.appendChild(empty);
      return;
    }

    for (const e of entries) {
      const row = document.createElement("div");
      row.className = "hb-social-squelch-row";
      const key = e.isAccount ? `acct:${(e.name || "").toLowerCase()}` : `char:${e.targetGuid >>> 0}`;
      if (speculativePending.has(key)) row.style.opacity = "0.7";

      const badge = document.createElement("span");
      badge.className = `hb-social-squelch-badge${e.isAccount ? "" : " placeholder"}`;
      badge.title = e.isAccount ? "Account-wide squelch" : "Character squelch";
      badge.textContent = "A";
      row.appendChild(badge);

      const nameEl = document.createElement("span");
      nameEl.className = "hb-social-squelch-name";
      setAcText(nameEl, e.name || `0x${e.targetGuid.toString(16).padStart(8, "0")}`);
      row.appendChild(nameEl);

      const xBtn = document.createElement("button");
      xBtn.type = "button";
      xBtn.className = "hb-social-squelch-x";
      xBtn.textContent = "x";
      const guid = e.targetGuid >>> 0;
      const nm = e.name || `0x${guid.toString(16).padStart(8, "0")}`;
      const isAccount = !!e.isAccount;
      xBtn.title = `Unsquelch ${nm}`;
      xBtn.addEventListener("click", () => {
        if (!window.confirm(`Unsquelch ${nm}?`)) return;
        if (isAccount) {
          squelchAccount(nm, false, SQUELCH_ALL_MASK);
        } else {
          squelchCharacter(guid, nm, false, SQUELCH_ALL_MASK);
        }
        toast("Unsquelch sent");
      });
      row.appendChild(xBtn);

      squelchListEl.appendChild(row);
    }
  }
  squelchRenderers.push(renderSquelchList);

  if (bus && typeof bus.on === "function") {
    // Server-wins reconcile: ACE's authoritative snapshot replaces
    // the speculative mirror wholesale.
    const listener = () => {
      try {
        const snap = window.__sessionHandle?.playerSquelch?.();
        squelchMirror = snap ? serverSnapshotToMirror(snap) : null;
        speculativePending.clear();
        renderSquelchList();
      } catch (_) {}
    };
    bus.on("squelchUpdated", listener);
    overlay_unsubscribe_handlers.push(() => {
      if (typeof bus.off === "function") bus.off("squelchUpdated", listener);
    });
  }
  renderSquelchList();
  body.appendChild(squelchListSec);

  // ── Title section ──────────────────────────────────────────────────
  // Wave-H3 (2026-05-26): receive-side title catalog. ACE pushes
  // `GameEvent::CharacterTitle` (opcode 0x0029) at login with every
  // title the character has earned + the currently active id; later
  // `GameEvent::UpdateTitle` (opcode 0x002B) deltas append. Replaces
  // the H2 placeholder input — players pick from titles they actually
  // have, not arbitrary IDs.
  const titleSec = document.createElement("div");
  titleSec.className = "hb-social-section";
  const titleHeader = document.createElement("div");
  titleHeader.className = "hb-social-section-title";
  setAcText(titleHeader, "Title");
  titleSec.appendChild(titleHeader);

  const titleRow = document.createElement("div");
  titleRow.className = "hb-social-row";
  const titleSelect = document.createElement("select");
  titleSelect.className = "hb-social-select";
  titleRow.appendChild(titleSelect);
  const titleBtn = document.createElement("button");
  titleBtn.type = "button";
  titleBtn.className = "hb-social-btn";
  setAcText(titleBtn, "Set");
  titleRow.appendChild(titleBtn);
  titleSec.appendChild(titleRow);

  const titleEmpty = document.createElement("div");
  titleEmpty.className = "hb-social-title-empty";
  setAcText(titleEmpty, "(no titles earned yet)");
  titleSec.appendChild(titleEmpty);

  function renderTitleSelect() {
    const handle = window.__sessionHandle;
    const snap = typeof handle?.playerTitle === "function" ? handle.playerTitle() : null;
    const ids = snap?.titleIds ?? [];
    const current = (snap?.currentTitleId ?? 0) >>> 0;

    // Save the user's current selection so a refresh during a delta
    // doesn't blow it away.
    const prevSelected = titleSelect.value ? parseInt(titleSelect.value, 10) >>> 0 : 0;
    titleSelect.innerHTML = "";

    if (ids.length === 0) {
      titleSelect.disabled = true;
      titleBtn.disabled = true;
      titleEmpty.style.display = "block";
      return;
    }
    titleSelect.disabled = false;
    titleBtn.disabled = false;
    titleEmpty.style.display = "none";

    for (const id of ids) {
      const opt = document.createElement("option");
      opt.value = String(id);
      opt.textContent = id === current ? `${id} (current)` : `${id}`;
      titleSelect.appendChild(opt);
    }

    const want = prevSelected && ids.includes(prevSelected) ? prevSelected : current;
    if (want && ids.includes(want)) {
      titleSelect.value = String(want);
    }
  }

  const doSetTitle = () => {
    const raw = titleSelect.value;
    if (!raw) { toast("No title selected"); return; }
    // Validate BEFORE the `>>> 0` — the coercion turns NaN into 0, so the
    // old `Number.isFinite(id)` guard could never fire and a non-numeric
    // option sent setTitle(0) = CharacterTitle::Undef, silently clearing
    // the player's displayed title.
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) { toast("Invalid title ID"); return; }
    const id = parsed >>> 0;
    withSession("setTitle", (h) => {
      h.setTitle(id);
      emit(`[title/set] id=${id}`);
      toast("Set Title sent");
    });
  };
  titleBtn.addEventListener("click", doSetTitle);

  if (bus && typeof bus.on === "function") {
    const listener = () => { try { renderTitleSelect(); } catch (_) {} };
    bus.on("titleUpdated", listener);
    overlay_unsubscribe_handlers.push(() => {
      if (typeof bus.off === "function") bus.off("titleUpdated", listener);
    });
  }
  renderTitleSelect();
  body.appendChild(titleSec);

  el.appendChild(body);

  el.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") close();
  });

  document.body.appendChild(el);
  return el;
}

function open() {
  if (!overlay) overlay = buildOverlay();
  overlay.classList.add("open");
  overlay.tabIndex = -1;
  try { overlay.focus({ preventScroll: true }); } catch (_) {}
}

function close() {
  if (!overlay) return;
  overlay.classList.remove("open");
}

if (typeof window !== "undefined") {
  if (!window.__hbSocialPanelEscBound) {
    window.__hbSocialPanelEscBound = true;
    window.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (overlay?.classList.contains("open")) close();
    });
  }
  window.__openSocialPanel = open;
  window.__closeSocialPanel = close;
  // R3 (BAND-C1): symmetric toggle for the Shift+F3 hotkey dispatch
  // (mirrors house-panel / spell-research-panel).
  window.__toggleSocialPanel = () => {
    if (overlay?.classList.contains("open")) close();
    else open();
  };
}

export const manifest = {
  id: "social-panel",
  name: "Social",
  icon: "🤝",
  iconHidden: true,
  version: "0.2.0",
  description: "Friends + squelch + title — send + receive (Waves E2 / H1 / H2 / H3 / I2)",
};
