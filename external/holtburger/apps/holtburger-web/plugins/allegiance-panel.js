// Allegiance — the Allegiance tab of the social hub (plugins/social-panel.js)
// plus the "Allegiance Management" officer-tools floaty. HUD overhaul
// 2026-10-05: rebuilt on the hud_kit vocabulary.
//
// Retail gmAllegianceUI (layout 0x2100002F, m-2F.json, 300×600) reads top
// to bottom:
//   PlayerField  (0,0)   — allegiance name / "Followers: N" / "Rank: R"
//   Spacer1      (0,36)  — 300×9 gold bar 0x06001420
//   MonarchField (0,45)  — "MONARCH" (or "PATRON / MONARCH") + name +
//                          "XP Produced" frame + "Followers: N"
//   Spacer3      (0,99)
//   PatronField  (0,108) — "PATRON" + name + "XP Produced"
//   Spacer2      (0,144)
//   VASSALS / XP Produced captions (0,153), VassalsListBox (0,171) 279×350
//   IgnoreAllegianceRequests (9,535); Swear / Break / Kick (y=562)
//
// The old port squeezed that 600-px tree into the 337-px main-panel body
// by scaleY≈0.53 and absolutely placed every element from the DAT, so the
// 18-px rows collapsed to 9 px and stamped over each other and over a
// second, hand-rolled tab strip (the 2026-10-05 before-shot). This rewrite
// keeps retail's SECTION ORDER and sprites but lays them out as a flex
// column that fits any body height, with the vassal list as the one
// flexible (rope-scroll) region.
//
// Retail behaviour matched (acclient.c):
//   • Section visibility — gmAllegianceUI::UpdateMonarchData hides the
//     monarch field when the player IS the monarch, labels it
//     ID_Allegiance_PatronSlashMonarchLabel when patron == monarch (and
//     only then shows its XP Produced frame); UpdatePatronData shows the
//     patron field only when a patron exists and is not the monarch.
//   • XP Produced = ID_Allegiance_VassalExperiencePassedUp: each vassal
//     row shows that vassal's _cp_tithed (UpdateVassalsData); the patron
//     row shows the player's own passed-up XP.
//   • Buttons — UpdateSwearButton: Swear only with no patron and a
//     selected PLAYER who is not already in your allegiance data;
//     UpdateBreakButton: Break only with a patron, and it breaks with the
//     PATRON (CloseBreakConfirmationDialog → Event_BreakAllegiance(patron));
//     Kick enables on a vassal-list selection and breaks with THAT vassal
//     (CloseKickConfirmationDialog → Event_BreakAllegiance(vassal)).
//     All three confirm first (Make*ConfirmationDialog).
//
//   • Tree request — AllegianceUpdateRequest 0x001F (u32 on): retail
//     gmAllegianceUI::RecvNotice_PlayerDescReceived sends Event_UpdateRequest(1)
//     once the player description lands, and OnVisibilityChanged sends 1 on
//     show / 0 on hide. ACE never pushes the tree at login, so without the
//     request playerAllegiance() stays null all session. Sent once per
//     SessionHandle after the player is in world, and ref-counted over the
//     page + Management floaty. The floaty's Refresh asks for the tree too.
//   • Patron resolution — AllegianceHierarchy::GetPatron is the parent link
//     of the player's node. ACE never writes a separate patron record when
//     the patron IS the monarch, so a non-monarch member with no patron
//     record is a direct vassal of the monarch (buildAllegianceViewModel).
//
// Wire: SwearAllegiance 0x001D · BreakAllegiance 0x001E ·
// AllegianceUpdateRequest 0x001F · SetCharacterOption
// IgnoreAllegianceRequests (ordinal 0x01) · officer tools in the floaty:
// SetAllegianceName, SetAllegianceOfficer, AllegianceChatGag,
// Add/RemoveAllegianceBan, BreakAllegianceBoot, DoAllegianceLockAction,
// RecallAllegianceHometown.

import {
  registerSocialPage, mountSocialHub, ensureSocialStyles, onSocialBoot,
  el, makeKitButton, makeOrb, makeSpacer, makeColHead, makeListRow, setRowSelected,
  withSession, selectedTargetGuid, selectedTargetName, localPlayerGuid,
  isPlayerGuid, onBus, confirmAction, readCharacterOption, fmtInt, socialEmit, uid,
  getHandle,
} from "./social-panel.js";
import { attachWindowPosition } from "../ui/ac_window_position.js";
import { makeTitlebar } from "../ui/hud_kit.js";

const STYLE_ID = "hb-alleg-style";
const SA_OVERLAY_ID = "hb-alleg-standalone";
// gmAllegianceUI root (RootAllegiance_Field 0x1000024F) as the floaty's
// m_eWindowID for position persistence.
const ALLEG_WINDOW_ID = 0x1000024F;
const SP = "./data/ui-sprites";

// R7a: CharacterOption::IgnoreAllegianceRequests ORDINAL (character.rs:119)
// — setCharacterOption calls CharacterOption::from_repr, so pass 0x01.
const OPT_IGNORE_ALLEGIANCE = 0x01;

// ACE.Entity.Enum.AllegianceOfficerLevel (Speaker 1 / Seneschal 2 /
// Castellan 3) and AllegianceLockAction (skipping Undef = 0).
const OFFICER_LEVELS = [
  { value: 1, label: "Speaker" },
  { value: 2, label: "Seneschal" },
  { value: 3, label: "Castellan" },
];
const LOCK_ACTIONS = [
  { value: 2, label: "Lock allegiance" },
  { value: 1, label: "Unlock allegiance" },
  { value: 3, label: "Toggle lock" },
  { value: 4, label: "Check lock status" },
  { value: 5, label: "Check approved vassal" },
  { value: 6, label: "Clear approved vassal" },
];

// ─── Pure view-model (exported for tests/social_panel.test.mjs) ─────────

function member(m) {
  if (!m) return null;
  const guid = (m.guid >>> 0) || 0;
  return {
    guid,
    name: (typeof m.name === "string" && m.name) ? m.name : "Unknown",
    rank: (m.rank >>> 0) || 0,
    level: (m.level >>> 0) || 0,
    online: !!m.loggedIn,
    xpProduced: Number(m.cpTithed) || 0,
  };
}

/**
 * Project a wasm AllegianceSnapshotJs (or null) into what the page draws.
 * `myself` is absent when the local player IS the monarch (wasm
 * publish_player_allegiance_snapshot shape).
 */
export function buildAllegianceViewModel(snap) {
  if (!snap) {
    return {
      inAllegiance: false, name: "", locked: false, motd: "", rank: 0,
      followers: 0, isMonarch: false, hasPatron: false, breakTarget: null,
      monarch: null, patron: null, vassals: [], members: [],
    };
  }
  const monarch = member(snap.monarch);
  const myself = member(snap.myself);
  // AllegianceHierarchy::GetPatron = the player's tree parent. ACE packs no
  // patron record when the patron IS the monarch (the self record just
  // hangs off the monarch), so an older wasm snapshot reports patron=null
  // for every first-tier vassal; a non-monarch member with no patron
  // record is a direct vassal of the monarch.
  const patron = member(snap.patron)
    ?? ((myself && monarch && myself.guid !== monarch.guid) ? monarch : null);
  const vassals = (Array.isArray(snap.vassals) ? snap.vassals : []).map(member).filter(Boolean);
  const isMonarch = !!monarch && !myself;
  const me = isMonarch ? monarch : myself;
  const passedUp = me ? me.xpProduced : 0;
  const patronIsMonarch = !!(patron && monarch && patron.guid === monarch.guid);
  const totalMembers = (snap.totalMembers >>> 0) || 0;
  const members = [];
  for (const m of [monarch, patron, myself, ...vassals]) if (m && m.guid) members.push(m.guid);
  return {
    inAllegiance: true,
    name: snap.name || "",
    locked: !!snap.isLocked,
    motd: snap.motd || "",
    rank: (snap.rank >>> 0) || (me?.rank ?? 0),
    followers: (snap.totalVassals >>> 0) || 0,
    isMonarch,
    hasPatron: !!patron,
    // Break always targets the PATRON, merged into the monarch row or not.
    breakTarget: patron ? { guid: patron.guid, name: patron.name } : null,
    monarch: (!isMonarch && monarch) ? {
      ...monarch,
      label: patronIsMonarch ? "Patron / Monarch" : "Monarch",
      // The XP Produced frame is only shown in the merged patron/monarch case.
      xpProduced: patronIsMonarch ? passedUp : null,
      followers: Math.max(0, totalMembers - 1),
    } : null,
    patron: (patron && !patronIsMonarch) ? { ...patron, xpProduced: passedUp } : null,
    vassals,
    members,
  };
}

/** Retail Swear / Break / Kick enable rules (see the header citations). */
export function allegianceButtonStates(vm, sel = {}) {
  const selectedGuid = (sel.selectedGuid >>> 0) || 0;
  const playerGuid = (sel.playerGuid >>> 0) || 0;
  const vassalGuid = (sel.selectedVassalGuid >>> 0) || 0;
  const inData = (g) => (vm?.members || []).includes(g);
  return {
    swear: !vm?.hasPatron && !!selectedGuid && selectedGuid !== playerGuid
      && sel.selectedIsPlayer !== false && !inData(selectedGuid),
    brk: !!vm?.hasPatron,
    kick: !!vassalGuid && (vm?.vassals || []).some((v) => v.guid === vassalGuid),
  };
}

// ─── Data + chat helpers ────────────────────────────────────────────────

function emit(msgText, cat = 17 /* allegiance */) {
  const log = document.getElementById("chat-log");
  if (!log) return;
  const li = document.createElement("li");
  li.className = `cat-${cat}`;
  li.dataset.cat = String(cat);
  li.textContent = msgText;
  log.appendChild(li);
}

// Wave-F2: the live allegiance snapshot off the wasm handle (null pre-join).
function fetchAllegianceSnapshot() {
  const handle = window.__sessionHandle;
  if (typeof handle?.playerAllegiance !== "function") return null;
  try {
    return handle.playerAllegiance() ?? null;
  } catch (_) {
    return null;
  }
}

// ─── AllegianceUpdateRequest (0x001F) ───────────────────────────────────

// typeof-guarded: a wasm build without the binding just never asks.
function sendAllegianceUpdateRequest(on, handle = getHandle()) {
  if (typeof handle?.allegianceUpdateRequest !== "function") return false;
  try {
    handle.allegianceUpdateRequest(!!on);
    return true;
  } catch (_) {
    return false;
  }
}

// Retail gmAllegianceUI::OnVisibilityChanged → Event_UpdateRequest(visible),
// ref-counted so the hub page and the Management floaty can both be open.
let allegVisibleCount = 0;
function allegianceVisible(delta) {
  const before = allegVisibleCount;
  allegVisibleCount = Math.max(0, allegVisibleCount + delta);
  if (before === 0 && allegVisibleCount > 0) sendAllegianceUpdateRequest(true);
  else if (before > 0 && allegVisibleCount === 0) sendAllegianceUpdateRequest(false);
}

// Retail gmAllegianceUI::RecvNotice_PlayerDescReceived → Event_UpdateRequest(1)
// (OpenAC: RuntimeAllegianceState.NoteEnteredWorld, once per session). Sent
// once per SessionHandle (a reconnect builds a new handle → asks again), and
// only once the player is in world: the eager SelectCharacter WorldState
// sets playerGuid() before ACE has a Player to answer.
const loginRequestSent = new WeakSet();
let loginPollTimer = null;
let loginPollDeadline = 0;
const LOGIN_POLL_MS = 1000;
const LOGIN_POLL_WINDOW_MS = 60000;

function playerInWorld() {
  if (!localPlayerGuid()) return false;
  const hist = (typeof window !== "undefined") ? window.__bootStateHistory : null;
  // No boot-state plumbing (harness / tests): the guid gate is all we have.
  if (!Array.isArray(hist)) return true;
  // The latest session-phase transition must be "in-world" ("ready" is the
  // scene latch, which can land on either side of it).
  for (let i = hist.length - 1; i >= 0; i -= 1) {
    const st = hist[i]?.state;
    if (st === "in-world") return true;
    if (st && st !== "ready") return false;
  }
  return false;
}

/** One login-time tree request per handle; true when it was sent now. */
export function maybeSendLoginAllegianceRequest() {
  const h = getHandle();
  if (!h || typeof h !== "object" || loginRequestSent.has(h)) return false;
  if (typeof h.allegianceUpdateRequest !== "function") return false;
  if (!playerInWorld()) return false;
  if (!sendAllegianceUpdateRequest(true, h)) return false;
  loginRequestSent.add(h);
  return true;
}

function stopLoginPoll() {
  if (loginPollTimer != null) { try { clearTimeout(loginPollTimer); } catch (_) {} }
  loginPollTimer = null;
}

// Retry for a bounded window (~60 s at ~1 s) after boot / each stats push,
// so the request goes out right after the in-world transition even when
// PlayerDescription beat PlayerCreate.
function scheduleLoginAllegianceRequest() {
  if (maybeSendLoginAllegianceRequest()) { stopLoginPoll(); return; }
  loginPollDeadline = Date.now() + LOGIN_POLL_WINDOW_MS;
  if (loginPollTimer != null) return;
  const tick = () => {
    loginPollTimer = null;
    if (maybeSendLoginAllegianceRequest()) return;
    if (Date.now() >= loginPollDeadline) return;
    loginPollTimer = setTimeout(tick, LOGIN_POLL_MS);
    try { loginPollTimer?.unref?.(); } catch (_) {}
  };
  loginPollTimer = setTimeout(tick, LOGIN_POLL_MS);
  try { loginPollTimer?.unref?.(); } catch (_) {}
}

let loginHookOff = null;
function installLoginAllegianceRequest() {
  if (typeof window === "undefined") return;
  // PlayerDescription publishes the stats snapshot (playerStatsUpdated), the
  // closest JS-side analogue of RecvNotice_PlayerDescReceived.
  if (!loginHookOff) {
    loginHookOff = onBus("playerStatsUpdated", () => {
      try { scheduleLoginAllegianceRequest(); } catch (_) {}
    });
  }
  scheduleLoginAllegianceRequest();
}

// Wave F.3: per-member login/logout chat line (opcode 0x027A,
// Allegiance_AllegianceLoginNotification). The bus is an EventTarget:
// handlers receive the CustomEvent and the payload lives on `.detail`
// (`?? ev` keeps a raw-payload emitter working — tests pin both).
function subscribeAllegiancePresence() {
  const bus = window.__pluginClient?.events;
  if (!bus || typeof bus.on !== "function") return () => {};
  const listener = (ev) => {
    try {
      const payload = ev?.detail ?? ev;
      const guid = (payload?.characterGuid >>> 0) || 0;
      const isLoggedIn = !!payload?.isLoggedIn;
      if (!guid) return;
      const snap = fetchAllegianceSnapshot();
      if (!snap) return;
      const candidates = [snap.monarch, snap.patron, snap.myself, ...(snap.vassals || [])];
      let name = "";
      for (const m of candidates) {
        if (m && (m.guid >>> 0) === guid) { name = m.name || ""; break; }
      }
      if (!name) name = `0x${guid.toString(16).padStart(8, "0").toUpperCase()}`;
      emit(`${name} ${isLoggedIn ? "has logged in" : "has logged out"}.`);
    } catch (_) {}
  };
  bus.on("allegiancePresence", listener);
  return () => {
    if (typeof bus.off === "function") bus.off("allegiancePresence", listener);
  };
}

// The presence line is page-independent: subscribe for the page lifetime,
// re-binding if a reconnect brings a new plugin client (bus).
let presenceBus = null;
let presenceOff = null;
let presenceWaiting = false;
function installPresenceOnce() {
  if (typeof window === "undefined") return;
  const bus = window.__pluginClient?.events;
  if (bus?.on) {
    if (bus !== presenceBus) {
      try { presenceOff?.(); } catch (_) {}
      presenceBus = bus;
      presenceOff = subscribeAllegiancePresence();
    }
    return;
  }
  if (!presenceWaiting && window.__pluginClientReady?.then) {
    presenceWaiting = true;
    window.__pluginClientReady.then(() => {
      presenceWaiting = false;
      installPresenceOnce();
    }).catch(() => { presenceWaiting = false; });
  }
}

// ─── Styles ─────────────────────────────────────────────────────────────

function ensureStyles() {
  ensureSocialStyles();
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .hb-alleg-head { flex: 0 0 auto; display: flex; flex-direction: column; gap: 1px; padding: 0 4px; }
    .hb-alleg-head-top { display: flex; align-items: center; gap: 6px; min-height: 20px; }
    .hb-alleg-name {
      flex: 1 1 auto; min-width: 0;
      color: var(--hbk-gold-bright); font-size: 13px; letter-spacing: 0.02em;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .hb-alleg-name.is-none { color: var(--hbk-text-dim); }
    .hb-alleg-badge {
      flex: 0 0 auto; padding: 0 4px; font-size: 10px; letter-spacing: 0.06em;
      color: var(--hbk-warn); border: 1px solid var(--hbk-gold-deep); text-transform: uppercase;
    }
    .hb-alleg-sub { display: flex; justify-content: space-between; gap: 8px; color: var(--hbk-text-dim); font-size: 11px; }
    .hb-alleg-sub .hbk-value { color: var(--hbk-text); }
    .hb-alleg-sec { flex: 0 0 auto; display: flex; flex-direction: column; gap: 1px; }
    .hb-alleg-member { display: flex; align-items: baseline; gap: 6px; padding: 0 4px 0 6px; min-height: 18px; }
    .hb-alleg-member-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hb-alleg-member-name.is-offline { color: var(--hbk-text-faint); }
    .hb-alleg-off { color: var(--hbk-text-faint); font-size: 11px; }
    .hb-alleg-xp { flex: 0 0 auto; color: var(--hbk-value); font-variant-numeric: tabular-nums; font-size: 12px; }
    .hb-alleg-note { padding: 0 4px 0 6px; color: var(--hbk-text-dim); font-size: 11px; }
    .hb-alleg-vassal-row .hb-soc-row-meta { color: var(--hbk-value); }

    /* Allegiance Management floaty (#hb-alleg-standalone). */
    #${SA_OVERLAY_ID} {
      width: 300px;
      max-height: calc(100 * var(--hb-hud-vh, 7.2px) - 16px);
      display: flex; flex-direction: column;
      z-index: 61;
    }
    #${SA_OVERLAY_ID}[hidden] { display: none; }
    .hb-alleg-mgmt { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; }
    .hb-alleg-mgmt .hbk-section-title { margin: 2px -8px 0; }
    .hb-alleg-mgmt-summary { color: var(--hbk-text); font-size: 12px; padding: 2px 0; }
    .hb-alleg-mgmt-summary .hbk-muted { font-size: 11px; }
    .hb-alleg-mgmt-row { display: flex; align-items: center; gap: 6px; }
    .hb-alleg-mgmt-row > .hbk-select { flex: 1 1 auto; min-width: 0; height: 22px; }
    .hb-alleg-mgmt-row > .hbk-btn { flex: 0 0 auto; }
    .hb-alleg-mgmt .hbk-footer { margin: 4px -8px -6px; justify-content: space-between; }
    .hb-alleg-mgmt .hbk-footer > .hbk-btn { flex: 1 1 0; }
  `;
  document.head.appendChild(style);
}

// ─── Allegiance page (social hub tab) ───────────────────────────────────

function memberLine(m, { showXp }) {
  const row = el("div", "hb-alleg-member");
  const name = el("span", "hb-alleg-member-name" + (m.online ? "" : " is-offline"), m.name);
  if (!m.online) name.appendChild(el("span", "hb-alleg-off", " (Offline)"));
  name.title = `Level ${m.level || "?"} · Rank ${m.rank}`;
  row.appendChild(name);
  if (showXp) row.appendChild(el("span", "hb-alleg-xp", fmtInt(m.xpProduced)));
  return row;
}

function mountAllegiancePage(pageEl) {
  ensureStyles();
  installPresenceOnce();
  allegianceVisible(+1);
  const col = el("div", "hb-soc-col");

  // PlayerField — name / followers / rank.
  const head = el("div", "hb-alleg-head");
  const headTop = el("div", "hb-alleg-head-top");
  const nameEl = el("span", "hb-alleg-name");
  const lockBadge = el("span", "hb-alleg-badge", "Locked");
  lockBadge.title = "New vassals cannot swear to this allegiance";
  const manageBtn = makeKitButton("Manage", () => openStandalone(), {
    cls: "hbk-btn-small hbk-brown",
    title: "Allegiance management (officers, bans, lock, recall)",
  });
  headTop.appendChild(nameEl);
  headTop.appendChild(lockBadge);
  headTop.appendChild(manageBtn);
  const headSub = el("div", "hb-alleg-sub");
  const followersEl = el("span");
  const rankEl = el("span");
  headSub.appendChild(followersEl);
  headSub.appendChild(rankEl);
  head.appendChild(headTop);
  head.appendChild(headSub);
  col.appendChild(head);

  // Monarch / Patron / Vassals live in `body`, rebuilt per snapshot.
  const body = el("div", "hb-soc-col");
  body.style.padding = "0";
  col.appendChild(body);

  // IgnoreAllegianceRequests orb (9,535).
  const ignore = makeOrb("Ignore Allegiance Requests", readCharacterOption(OPT_IGNORE_ALLEGIANCE), (on, input) => {
    if (!withSession("setCharacterOption", (h) => h.setCharacterOption(OPT_IGNORE_ALLEGIANCE, on))) {
      input.checked = !on;
    }
  });
  col.appendChild(ignore.wrap);

  // Swear / Break / Kick (y=562).
  const btnRow = el("div", "hb-soc-btnrow");
  const swearBtn = makeKitButton("Swear", () => {
    const guid = selectedTargetGuid();
    if (!guid) return;
    const who = selectedTargetName() || "the selected player";
    confirmAction({
      title: "Swear Allegiance",
      message: `Swear allegiance to ${who}?`,
      confirmLabel: "Swear",
      onConfirm: () => withSession("swearAllegiance", (h) => h.swearAllegiance(guid)),
    });
  }, { title: "Swear allegiance to the selected player" });
  const breakBtn = makeKitButton("Break", () => {
    const p = vm.breakTarget;
    if (!p) return;
    confirmAction({
      title: "Break Allegiance",
      message: `Break your allegiance to ${p.name}?`,
      confirmLabel: "Break",
      onConfirm: () => withSession("breakAllegiance", (h) => h.breakAllegiance(p.guid)),
    });
  }, { title: "Break allegiance with your patron" });
  const kickBtn = makeKitButton("Kick", () => {
    const v = vm.vassals.find((x) => x.guid === selectedVassal);
    if (!v) return;
    confirmAction({
      title: "Kick Vassal",
      message: `Kick ${v.name} from your allegiance?`,
      confirmLabel: "Kick",
      onConfirm: () => withSession("breakAllegiance", (h) => h.breakAllegiance(v.guid)),
    });
  }, { title: "Release the selected vassal" });
  btnRow.appendChild(swearBtn);
  btnRow.appendChild(breakBtn);
  btnRow.appendChild(kickBtn);
  col.appendChild(btnRow);
  pageEl.appendChild(col);

  let vm = buildAllegianceViewModel(null);
  let selectedVassal = 0;

  function updateButtons() {
    const sel = selectedTargetGuid();
    const st = allegianceButtonStates(vm, {
      selectedGuid: sel,
      selectedIsPlayer: sel ? isPlayerGuid(sel) : false,
      playerGuid: localPlayerGuid(),
      selectedVassalGuid: selectedVassal,
    });
    swearBtn.disabled = !st.swear;
    breakBtn.disabled = !st.brk;
    kickBtn.disabled = !st.kick;
  }

  function render() {
    vm = buildAllegianceViewModel(fetchAllegianceSnapshot());
    // Header.
    if (vm.inAllegiance) {
      nameEl.textContent = vm.name || "Allegiance";
      nameEl.classList.remove("is-none");
      nameEl.title = vm.motd ? `Message of the day: ${vm.motd}` : "";
    } else {
      nameEl.textContent = "No Allegiance";
      nameEl.classList.add("is-none");
      nameEl.title = "";
    }
    lockBadge.hidden = !vm.locked;
    manageBtn.hidden = !vm.inAllegiance;
    headSub.hidden = !vm.inAllegiance;
    followersEl.innerHTML = "";
    followersEl.append("Followers: ", el("span", "hbk-value", fmtInt(vm.followers)));
    rankEl.innerHTML = "";
    rankEl.append("Rank: ", el("span", "hbk-value", String(vm.rank)));

    body.textContent = "";
    if (!vm.inAllegiance) {
      body.appendChild(makeSpacer());
      const block = el("div", "hb-soc-empty-block");
      block.appendChild(el("div", "hb-soc-empty-title", "You have not sworn allegiance."));
      block.appendChild(el("div", "hb-soc-empty-hint", "Select a player and press Swear to pledge your allegiance to them."));
      body.appendChild(block);
      selectedVassal = 0;
      updateButtons();
      return;
    }
    body.appendChild(makeSpacer());
    if (vm.monarch) {
      const sec = el("div", "hb-alleg-sec");
      sec.appendChild(makeColHead(vm.monarch.label, vm.monarch.xpProduced != null ? "XP Produced" : ""));
      sec.appendChild(memberLine(vm.monarch, { showXp: vm.monarch.xpProduced != null }));
      const note = el("div", "hb-alleg-note");
      note.append("Followers: ", el("span", "hbk-value", fmtInt(vm.monarch.followers)));
      sec.appendChild(note);
      body.appendChild(sec);
      body.appendChild(makeSpacer());
    }
    if (vm.patron) {
      const sec = el("div", "hb-alleg-sec");
      sec.appendChild(makeColHead("Patron", "XP Produced"));
      sec.appendChild(memberLine(vm.patron, { showXp: true }));
      body.appendChild(sec);
      body.appendChild(makeSpacer());
    }
    body.appendChild(makeColHead("Vassals", "XP Produced"));
    const list = el("div", "hbk-scroll hbk-list hb-soc-list");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Vassals");
    if (!vm.vassals.length) {
      list.appendChild(el("div", "hbk-empty", "No vassals."));
    }
    for (const v of vm.vassals) {
      const row = makeListRow(v.online ? v.name : `${v.name} (Offline)`, fmtInt(v.xpProduced), {
        selected: v.guid === selectedVassal, dim: !v.online,
      });
      row.classList.add("hb-alleg-vassal-row");
      row.dataset.guid = String(v.guid);
      row.title = `Level ${v.level || "?"} · Rank ${v.rank}`;
      row.addEventListener("click", () => {
        selectedVassal = v.guid;
        setRowSelected(list, row);
        updateButtons();
      });
      list.appendChild(row);
    }
    body.appendChild(list);
    if (!vm.vassals.some((v) => v.guid === selectedVassal)) selectedVassal = 0;
    updateButtons();
  }

  render();
  const offs = [
    onBus("allegianceUpdated", () => { try { render(); } catch (_) {} }),
    onBus("selectionChanged", () => { try { updateButtons(); } catch (_) {} }),
  ];
  return () => {
    for (const off of offs) { try { off(); } catch (_) {} }
    col.remove();
    allegianceVisible(-1);
  };
}

registerSocialPage("allegiance", { mount: mountAllegiancePage });
// The login/logout chat line is page-lifetime (retail receives
// RecvNotice_AllegianceLogin whether or not the panel is open).
onSocialBoot(installPresenceOnce);
// The login-time tree request (RecvNotice_PlayerDescReceived) is too.
onSocialBoot(installLoginAllegianceRequest);

// Main-panel view "allegiance" (F8, toolbar Social button) — the social
// hub opened on its Allegiance tab.
export const view = {
  name: "Allegiance",
  nameFor: () => "Social",
  mount: (parentEl, ctx) => mountSocialHub(parentEl, { tab: ctx?.tab ?? "allegiance", inMainPanel: true }),
};

export const manifest = {
  id: "allegiance-panel",
  name: "Allegiance",
  icon: "🛡",
  iconHidden: true,
  version: "0.4.0",
  description: "Allegiance tab of the social hub (gmAllegianceUI 0x2100002F) + management floaty",
};

// ─── Allegiance Management floaty (#hb-alleg-standalone) ────────────────
//
// Retail exposed these officer powers only as /allegiance chat commands;
// the floaty gathers them in one kit window. Opened from the allegiance
// page's Manage button or window.__openAllegiancePanel().

let sa = null; // { win, summary, cleanup }

function buildStandalone() {
  ensureStyles();
  const win = el("div", "hbk-window");
  win.id = SA_OVERLAY_ID;
  win.hidden = true;
  win.setAttribute("role", "dialog");
  win.setAttribute("aria-label", "Allegiance Management");
  const { bar } = makeTitlebar("Allegiance Management", { onClose: () => closeStandalone() });
  win.appendChild(bar);

  const body = el("div", "hbk-scroll hb-alleg-mgmt");
  const summary = el("div", "hb-alleg-mgmt-summary");
  body.appendChild(summary);

  // Allegiance name.
  body.appendChild(el("div", "hbk-section-title", "Allegiance Name"));
  const nameRow = el("div", "hb-soc-field");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "hbk-input";
  nameInput.maxLength = 40;
  nameInput.placeholder = "New allegiance name";
  nameInput.setAttribute("aria-label", "Allegiance name");
  const nameBtn = makeKitButton("Set", () => {
    const text = nameInput.value.trim();
    if (!text) return;
    if (withSession("setAllegianceName", (h) => h.setAllegianceName(text))) nameInput.value = "";
  });
  nameInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); nameBtn.click(); } });
  nameRow.appendChild(nameInput);
  nameRow.appendChild(nameBtn);
  body.appendChild(nameRow);

  // Member actions share one name field.
  body.appendChild(el("div", "hbk-section-title", "Member"));
  const whoRow = el("div", "hb-soc-field");
  const whoLbl = el("label", null, "Player:");
  const who = document.createElement("input");
  who.type = "text";
  who.className = "hbk-input";
  who.maxLength = 64;
  who.placeholder = "Character name";
  whoLbl.htmlFor = who.id = uid("hb-alleg-who");
  const targetBtn = makeKitButton("Target", () => {
    const n = selectedTargetName();
    if (n) who.value = n; else socialEmit("Select a player first.");
  }, { cls: "hbk-btn-small hbk-brown", title: "Use the selected player's name" });
  whoRow.appendChild(whoLbl);
  whoRow.appendChild(who);
  whoRow.appendChild(targetBtn);
  body.appendChild(whoRow);
  const needName = () => {
    const n = who.value.trim();
    if (!n) socialEmit("Enter a player name first.");
    return n;
  };

  const officerRow = el("div", "hb-alleg-mgmt-row");
  const officerSel = document.createElement("select");
  officerSel.className = "hbk-select";
  officerSel.setAttribute("aria-label", "Officer level");
  for (const o of OFFICER_LEVELS) {
    const opt = document.createElement("option");
    opt.value = String(o.value);
    opt.textContent = o.label;
    officerSel.appendChild(opt);
  }
  const officerBtn = makeKitButton("Appoint", () => {
    const n = needName();
    if (!n) return;
    const level = parseInt(officerSel.value, 10) >>> 0;
    const label = OFFICER_LEVELS.find((o) => o.value === level)?.label ?? "officer";
    confirmAction({
      title: "Appoint Officer",
      message: `Appoint ${n} as ${label}?`,
      confirmLabel: "Appoint",
      onConfirm: () => withSession("setAllegianceOfficer", (h) => h.setAllegianceOfficer(n, level)),
    });
  });
  officerRow.appendChild(officerSel);
  officerRow.appendChild(officerBtn);
  body.appendChild(officerRow);

  const gagRow = el("div", "hb-soc-btnrow");
  gagRow.appendChild(makeKitButton("Gag", () => {
    const n = needName();
    if (n) withSession("allegianceChatGag", (h) => h.allegianceChatGag(n, true));
  }, { title: "Silence this member in allegiance chat" }));
  gagRow.appendChild(makeKitButton("Ungag", () => {
    const n = needName();
    if (n) withSession("allegianceChatGag", (h) => h.allegianceChatGag(n, false));
  }));
  body.appendChild(gagRow);

  const banRow = el("div", "hb-soc-btnrow");
  banRow.appendChild(makeKitButton("Ban", () => {
    const n = needName();
    if (!n) return;
    confirmAction({
      title: "Ban Player",
      message: `Ban ${n} from the allegiance?`,
      confirmLabel: "Ban",
      onConfirm: () => withSession("addAllegianceBan", (h) => h.addAllegianceBan(n)),
    });
  }));
  banRow.appendChild(makeKitButton("Unban", () => {
    const n = needName();
    if (n) withSession("removeAllegianceBan", (h) => h.removeAllegianceBan(n));
  }));
  body.appendChild(banRow);

  const bootRow = el("div", "hb-alleg-mgmt-row");
  const acct = makeOrb("Entire account", false, null, { title: "Boot every character on the player's account" });
  const bootBtn = makeKitButton("Boot", () => {
    const n = needName();
    if (!n) return;
    const whole = !!acct.input.checked;
    confirmAction({
      title: "Boot From Allegiance",
      message: `Boot ${n}${whole ? " (entire account)" : ""} from the allegiance?`,
      confirmLabel: "Boot",
      onConfirm: () => withSession("breakAllegianceBoot", (h) => h.breakAllegianceBoot(n, whole)),
    });
  });
  const gap = el("span");
  gap.style.flex = "1 1 auto";
  bootRow.appendChild(acct.wrap);
  bootRow.appendChild(gap);
  bootRow.appendChild(bootBtn);
  body.appendChild(bootRow);

  // Lock (AllegianceLockAction).
  body.appendChild(el("div", "hbk-section-title", "Lock"));
  const lockRow = el("div", "hb-alleg-mgmt-row");
  const lockSel = document.createElement("select");
  lockSel.className = "hbk-select";
  lockSel.setAttribute("aria-label", "Lock action");
  for (const a of LOCK_ACTIONS) {
    const opt = document.createElement("option");
    opt.value = String(a.value);
    opt.textContent = a.label;
    lockSel.appendChild(opt);
  }
  const lockBtn = makeKitButton("Apply", () => {
    const action = parseInt(lockSel.value, 10) >>> 0;
    if (action < 1 || action > 6) return;
    withSession("doAllegianceLockAction", (h) => h.doAllegianceLockAction(action));
  });
  lockRow.appendChild(lockSel);
  lockRow.appendChild(lockBtn);
  body.appendChild(lockRow);

  const footer = el("div", "hbk-footer");
  footer.appendChild(makeKitButton("Recall Home", () => {
    confirmAction({
      title: "Allegiance Hometown",
      message: "Recall to your allegiance hometown?",
      confirmLabel: "Recall",
      onConfirm: () => withSession("recallAllegianceHometown", (h) => h.recallAllegianceHometown()),
    });
  }, { title: "Portal to your allegiance's hometown" }));
  footer.appendChild(makeKitButton("Refresh", () => {
    // AllegianceUpdateRequest (0x001F): ACE answers any member with
    // AllegianceUpdate, which refreshes the page. (AllegianceInfoRequest
    // 0x027B is retail's officer-only `/allegiance info <name>` and its
    // reply is not the player's own tree.)
    if (typeof getHandle()?.allegianceUpdateRequest === "function") {
      withSession("allegianceUpdateRequest", (h) => h.allegianceUpdateRequest(true));
      return;
    }
    // Older wasm without the binding: the legacy officer query.
    const snap = fetchAllegianceSnapshot();
    const target = selectedTargetName() || snap?.monarch?.name || "";
    withSession("requestAllegianceInfo", (h) => h.requestAllegianceInfo(target));
  }, { title: "Ask the server for fresh allegiance information" }));
  body.appendChild(footer);
  win.appendChild(body);

  win.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && ev.target?.tagName !== "INPUT") closeStandalone();
  });
  document.body.appendChild(win);
  attachWindowPosition(win, {
    windowId: ALLEG_WINDOW_ID,
    dragHandle: bar,
    ignoreSelector: ".hbk-close",
    defaultPos: { right: "640px", top: "96px" },
  });
  return { win, summary, cleanup: null, visible: false };
}

function renderStandaloneSummary() {
  if (!sa) return;
  const vm = buildAllegianceViewModel(fetchAllegianceSnapshot());
  sa.summary.textContent = "";
  if (!vm.inAllegiance) {
    sa.summary.appendChild(el("span", "hbk-muted", "You are not in an allegiance."));
    return;
  }
  sa.summary.appendChild(el("div", "hbk-gold", `${vm.name || "Allegiance"}${vm.locked ? " (Locked)" : ""}`));
  const members = vm.monarch ? vm.monarch.followers + 1 : vm.followers + 1;
  sa.summary.appendChild(el("div", "hbk-muted", `Rank ${vm.rank} · ${fmtInt(members)} members${vm.isMonarch ? " · You are the monarch" : ""}`));
}

function openStandalone() {
  if (typeof document === "undefined") return;
  if (!sa) sa = buildStandalone();
  sa.win.hidden = false;
  if (!sa.visible) { sa.visible = true; allegianceVisible(+1); }
  renderStandaloneSummary();
  if (!sa.cleanup) sa.cleanup = onBus("allegianceUpdated", () => { try { renderStandaloneSummary(); } catch (_) {} });
}

function closeStandalone() {
  if (!sa) return;
  sa.win.hidden = true;
  if (sa.cleanup) { try { sa.cleanup(); } catch (_) {} }
  sa.cleanup = null;
  if (sa.visible) { sa.visible = false; allegianceVisible(-1); }
}

if (typeof window !== "undefined") {
  if (!window.__hbAllegiancePanelEscBound && typeof window.addEventListener === "function") {
    window.__hbAllegiancePanelEscBound = true;
    window.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape" || !sa || sa.win.hidden) return;
      const tag = ev.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      closeStandalone();
    });
  }
  window.__openAllegiancePanel = openStandalone;
  window.__closeAllegiancePanel = closeStandalone;
}
