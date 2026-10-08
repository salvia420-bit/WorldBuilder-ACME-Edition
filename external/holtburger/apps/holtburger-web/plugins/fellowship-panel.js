// Fellowship — the Fellowship tab of the social hub (plugins/social-panel.js)
// plus a standalone fellowship floaty. HUD overhaul 2026-10-05: rebuilt on
// the hud_kit vocabulary.
//
// Retail gmFellowshipUI (layout 0x21000030, m-30.json, 300×600) has two
// frames:
//   NotInAFellowshipFrame — FellowshipInstructions (8,18) 284×120, Spacer
//     (0,191), "Fellowship Name:" + FellowshipNameEntryBox (148,200), four
//     option checkboxes (25,225…267: IgnoreFellowshipRequests,
//     FellowshipAutoAcceptRequests, FellowshipShareXP, FellowshipShareLoot)
//     and CreateFellowshipButton (33,298) 234×33.
//   FellowshipFrame — FellowshipName (0,2), FELLOW / LVL/XP% captions
//     (8,22), FellowsListBox (8,38) 271×487 of 279×32 entries (FellowInfo
//     strip 0x06001450 with name + stats, then three 93×16 vital bars:
//     health 0x0600251D/0x0600251C, stamina 0x06002521/0x06002520, mana
//     0x0600251F/0x0600251E — empty/full sprite pairs) and two rows of
//     buttons: Leader / Quit / Open, Recruit / Dismiss / Disband.
//
// The old port compressed the 600-px tree by scaleY≈0.56 AND drew a second
// hand-rolled Allegiance/Fellowship/Friends tab strip whose labels landed
// on top of each other ("FeFriendship" in the before-shot), used raw
// coloured dots for the options and the wrong mana sprite. This rewrite
// keeps retail's structure and sprites in a flex column that fits the
// main-panel body, with the member list as the rope-scroll region.
//
// Retail behaviour matched (acclient.c):
//   • gmFellowshipUI::OnVisibilityChanged → CM_Fellowship::Event_Update-
//     Request(visible): the server only streams fellow vitals while the
//     panel is open. Replaces the old manual "Vital Updates" button.
//   • gmFellowshipUI::UpdateButtons — Quit always; leader-only Disband /
//     Open (no lock gate — ACE answers a locked toggle with
//     FellowshipIsLocked); Leader & Dismiss need a selected fellow who is not you;
//     Recruit needs a selected PLAYER who is not a fellow, room in the
//     fellowship (Fellowship::IsFull: 9) and you leading or it being open.
//   • ListenToElementMessage — a list click also selects that fellow in
//     the world (ACCWeenieObject::SetSelectedObject); Quit as leader first
//     hands leadership to a non-leader fellow (GetNonLeaderFellowID).
//   • UpdateFellowStats — "LVL / XP%" with the share from
//     FellowshipSystem::GetEvenSplitXPPctg when the split is even.
//   • CreateFellowship — name from the entry box, share-XP from the
//     FellowshipShareXP option; the button needs a non-empty name.
//   • ListenToElementMessage case 0x1000027D (Open button) — toggles
//     _open_fellow and sends CM_Fellowship::Event_ChangeFellowOpeness; here
//     the server's FullUpdate echo flips the label (Open ↔ Close).
//
// Wire: FellowshipCreate 0x00A2 · Quit 0x00A3 · Dismiss 0x00A4 ·
// Recruit 0x00A5 · UpdateRequest 0x00A6 · AssignNewLeader 0x0290 ·
// ChangeOpenness 0x0291 · SetCharacterOption (fellowship option ordinals
// below). A wasm build without the fellowshipChangeOpenness binding keeps
// the Open button disabled.

import {
  registerSocialPage, mountSocialHub, ensureSocialStyles,
  el, makeKitButton, makeOrb, makeSpacer, makeColHead, setRowSelected,
  withSession, getHandle, selectedTargetGuid, localPlayerGuid, isPlayerGuid,
  selectWorldObject, onBus, confirmAction,
} from "./social-panel.js";
import { attachWindowPosition } from "../ui/ac_window_position.js";
import { makeTitlebar } from "../ui/hud_kit.js";

const STYLE_ID = "hb-fellow-style";
const STANDALONE_OVERLAY_ID = "hb-fellow-standalone";
// gmFellowshipUI root (RootFellowship_Field 0x1000026A) as the floaty's
// m_eWindowID.
const FELLOW_WINDOW_ID = 0x1000026A;
const SP = "./data/ui-sprites";

/** Fellowship::IsFull — `_fellowship_table._currNum >= 9`. */
export const FELLOWSHIP_MAX = 9;

// R7b: fellowship option-key → CharacterOption ORDINAL (character.rs
// 120/136/133/135; matches options-panel.js). setCharacterOption calls
// CharacterOption::from_repr, so these are literal ordinals.
const FELLOW_OPT_IDX = { ignore: 0x02, autoAccept: 0x12, shareXp: 0x0F, shareLoot: 0x11 };
const OPT_DEFS = [
  { id: "ignore", label: "Ignore Fellowship Requests" },
  { id: "autoAccept", label: "Automatically Accept Fellowship Requests" },
  { id: "shareXp", label: "Share Fellowship Experience" },
  { id: "shareLoot", label: "Share Fellowship Loot" },
];

const VITALS = [
  { key: "health", cur: "currentHealth", max: "maxHealth", empty: "0x0600251D", full: "0x0600251C", label: "Health" },
  { key: "stamina", cur: "currentStamina", max: "maxStamina", empty: "0x06002521", full: "0x06002520", label: "Stamina" },
  { key: "mana", cur: "currentMana", max: "maxMana", empty: "0x0600251F", full: "0x0600251E", label: "Mana" },
];

// ─── Pure helpers (exported for tests/social_panel.test.mjs) ─────────────

/** FellowshipSystem::GetEvenSplitXPPctg (acclient.c:484596), 0..1. */
export function evenSplitXpPct(count) {
  switch (count >>> 0) {
    case 1: return 1.0;
    case 2: return 0.75;
    case 3: return 0.6;
    case 4: return 0.55;
    case 5: return 0.5;
    case 6: return 0.45;
    case 7: return 0.4;
    case 8: return 0.35;
    case 9: return 0.31111109;
    case 10: return 0.28;
    default: return 0;
  }
}

/**
 * The FellowStats cell ("LVL / XP%", gmFellowshipUI::UpdateFellowStats).
 * Retail's proportional (uneven) share needs the character-level XP table,
 * which the client does not carry — the share is omitted rather than
 * guessed in that case.
 */
export function fellowStatsText(snapshot, m) {
  const level = (m?.level >>> 0) || 0;
  const lvl = level ? String(level) : "?";
  if (!snapshot?.shareXp) return `${lvl} / 0%`;
  if (snapshot.evenShare) {
    const n = Array.isArray(snapshot.members) ? snapshot.members.length : 0;
    return `${lvl} / ${Math.floor(evenSplitXpPct(n) * 100)}%`;
  }
  return lvl;
}

/** Fill fraction 0..100 for a vital (0 when the max is unknown). */
export function vitalPct(cur, max) {
  const c = Number(cur) || 0;
  const mx = Number(max) || 0;
  if (mx <= 0) return 0;
  return Math.max(0, Math.min(100, (c / mx) * 100));
}

function openTitle(isOpen) {
  return isOpen
    ? "Close the fellowship to recruiting by members"
    : "Let members recruit into the fellowship";
}

/** gmFellowshipUI::UpdateButtons enable rules. */
export function fellowshipButtonStates(s = {}) {
  const me = (s.playerGuid >>> 0) || 0;
  const fellow = (s.selectedFellowGuid >>> 0) || 0;
  const world = (s.selectedWorldGuid >>> 0) || 0;
  const fellowOk = !!fellow && fellow !== me;
  const canRecruitTarget = !!world && s.selectedIsPlayer !== false && !s.selectedIsFellow && !s.isFull;
  if (s.isLeader) {
    return {
      leader: fellowOk, quit: true, open: true,
      recruit: canRecruitTarget, dismiss: fellowOk, disband: true,
    };
  }
  return {
    leader: false, quit: true, open: false,
    recruit: !!s.open && canRecruitTarget, dismiss: false, disband: false,
  };
}

// ─── Data ───────────────────────────────────────────────────────────────

function fetchFellowshipSnapshot() {
  const dbg = (typeof window !== "undefined") ? window.__hbFellowshipDebug : null;
  if (dbg && Array.isArray(dbg.members) && dbg.members.length) return dbg; // dev override
  const handle = getHandle();
  if (typeof handle?.playerFellowship !== "function") return null;
  try { return handle.playerFellowship() ?? null; } catch (_) { return null; }
}

function membersOf(snap) {
  if (!snap || !snap.members) return [];
  const leader = (snap.leaderGuid >>> 0) || 0;
  const out = [];
  for (const m of snap.members) {
    const guid = (m.guid >>> 0) || 0;
    out.push({
      guid,
      name: m.name || "Unknown",
      level: (m.level >>> 0) || 0,
      isLeader: guid === leader,
      currentHealth: m.currentHealth, maxHealth: m.maxHealth,
      currentStamina: m.currentStamina, maxStamina: m.maxStamina,
      currentMana: m.currentMana, maxMana: m.maxMana,
    });
  }
  // Leader first, then name — a stable, readable order.
  out.sort((a, b) => (a.isLeader !== b.isLeader ? (a.isLeader ? -1 : 1) : a.name.localeCompare(b.name)));
  return out;
}

// Retail OnVisibilityChanged → Event_UpdateRequest(visible). Ref-counted so
// the main-panel tab and the floaty can both be open.
let visibleCount = 0;
function sendUpdateRequest(v) {
  try { getHandle()?.fellowshipUpdateRequest?.(!!v); } catch (_) {}
}
function fellowshipVisible(delta) {
  const before = visibleCount;
  visibleCount = Math.max(0, visibleCount + delta);
  if (before === 0 && visibleCount > 0) sendUpdateRequest(true);
  else if (before > 0 && visibleCount === 0) sendUpdateRequest(false);
}

// ─── Styles ─────────────────────────────────────────────────────────────

function ensureStyles() {
  ensureSocialStyles();
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .hb-fellow-intro {
      flex: 0 0 auto; padding: 6px 6px 2px;
      color: var(--hbk-text); font-size: 12px; line-height: 1.4; text-align: center;
    }
    .hb-fellow-intro p { margin: 0 0 4px; }
    .hb-fellow-intro p + p { color: var(--hbk-text-dim); }
    .hb-fellow-opts { flex: 0 0 auto; display: flex; flex-direction: column; gap: 1px; padding: 0 10px; }
    .hb-fellow-create { flex: 0 0 auto; align-self: center; min-width: 200px; min-height: 26px; margin-top: 4px; }
    .hb-fellow-head { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 0 4px; min-height: 20px; }
    .hb-fellow-name {
      flex: 1 1 auto; min-width: 0; text-align: center;
      color: var(--hbk-gold-bright); font-size: 13px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .hb-fellow-badge {
      flex: 0 0 auto; padding: 0 4px; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase;
      color: var(--hbk-text-dim); border: 1px solid var(--hbk-gold-deep);
    }
    .hb-fellow-badge.is-warn { color: var(--hbk-warn); }
    .hb-fellow-count { flex: 0 0 auto; color: var(--hbk-text-dim); font-size: 11px; font-variant-numeric: tabular-nums; }
    .hb-fellow-row {
      display: flex; flex-direction: column; gap: 1px;
      padding: 1px 2px 2px; cursor: pointer;
      border-left: 2px solid transparent;
    }
    .hb-fellow-row:hover { background: var(--hbk-hover); }
    .hb-fellow-row.is-selected { background: var(--hbk-sel); border-left-color: var(--hbk-gold); }
    .hb-fellow-info {
      display: flex; align-items: center; gap: 6px; height: 16px; padding: 0 4px;
      background: url("${SP}/0x06001450.png") center / 100% 100% no-repeat;
    }
    .hb-fellow-info-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hb-fellow-row.is-leader .hb-fellow-info-name { color: var(--hbk-gold-bright); }
    .hb-fellow-lead { color: var(--hbk-gold); font-size: 10px; letter-spacing: 0.04em; }
    .hb-fellow-stats { flex: 0 0 auto; color: var(--hbk-text-dim); font-size: 11px; font-variant-numeric: tabular-nums; }
    .hb-fellow-vitals { display: flex; gap: 1px; height: 13px; }
    .hb-fellow-vital {
      position: relative; flex: 1 1 0; min-width: 0;
      background: center / 100% 100% no-repeat;
    }
    .hb-fellow-vital-fill {
      position: absolute; inset: 0;
      background: center / 100% 100% no-repeat;
      clip-path: inset(0 calc(100% - var(--pct, 0%)) 0 0);
      transition: clip-path 160ms linear;
    }
    .hb-fellow-vital-txt {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      color: #fff; font-size: 10px; line-height: 1; text-shadow: 0 0 2px #000, 1px 1px 0 #000;
      font-variant-numeric: tabular-nums; pointer-events: none;
    }
    ${VITALS.map((v) => `
    .hb-fellow-vital[data-kind="${v.key}"] { background-image: url("${SP}/${v.empty}.png"); }
    .hb-fellow-vital[data-kind="${v.key}"] > .hb-fellow-vital-fill { background-image: url("${SP}/${v.full}.png"); }`).join("")}

    #${STANDALONE_OVERLAY_ID} {
      width: 300px;
      height: min(400px, calc(100 * var(--hb-hud-vh, 7.2px) - 16px));
      display: flex; flex-direction: column;
      z-index: 60;
    }
    #${STANDALONE_OVERLAY_ID}[hidden] { display: none; }
    .hb-fellow-floaty-body {
      position: relative; flex: 1 1 auto; min-height: 0;
      display: flex; flex-direction: column;
      background: url("${SP}/0x06004CC2.png") repeat;
    }
  `;
  document.head.appendChild(style);
}

// ─── Fellowship page ────────────────────────────────────────────────────

function readOpts() {
  const opts = { ignore: false, autoAccept: false, shareXp: true, shareLoot: true };
  try {
    const raw = localStorage.getItem("hb.fellowship.opts");
    const stored = raw ? JSON.parse(raw) : null;
    if (stored && typeof stored === "object") {
      for (const k of Object.keys(opts)) if (typeof stored[k] === "boolean") opts[k] = stored[k];
    }
  } catch (_) {}
  // R7b: the server-held options win (ACE does not echo them; read at render).
  try {
    const h = getHandle();
    if (typeof h?.isCharacterOptionEnabled === "function") {
      for (const k of Object.keys(FELLOW_OPT_IDX)) opts[k] = !!h.isCharacterOptionEnabled(FELLOW_OPT_IDX[k]);
    }
  } catch (_) {}
  return opts;
}

// Option writes are best-effort and silent pre-login (the localStorage
// copy above is the fallback); a logged-in failure goes to the console.
function setOptionQuiet(ordinal, on) {
  const h = getHandle();
  if (typeof h?.setCharacterOption !== "function") return;
  try { h.setCharacterOption(ordinal, !!on); } catch (err) { console.warn("[fellowship] setCharacterOption failed", err); }
}

function mountFellowshipPage(pageEl) {
  ensureStyles();
  fellowshipVisible(+1);
  const col = el("div", "hb-soc-col");
  pageEl.appendChild(col);

  let fellowshipName = "";
  let selectedFellow = 0;
  let snapshot = null;
  let members = [];
  let rowRefs = new Map();   // guid → { row, stats, bars: {key: {wrap, txt}} }
  let btns = null;           // in-fellowship buttons

  function buildAlone() {
    col.textContent = "";
    btns = null;
    rowRefs = new Map();
    const intro = el("div", "hb-fellow-intro");
    intro.appendChild(el("p", null, "You do not belong to a fellowship."));
    intro.appendChild(el("p", null, "To create one, enter a name below and click Create Fellowship. Once it exists you can recruit members."));
    col.appendChild(intro);
    col.appendChild(makeSpacer());

    const field = el("div", "hb-soc-field");
    const lbl = el("label", null, "Fellowship Name:");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "hbk-input";
    input.maxLength = 32;
    input.placeholder = "Enter a name";
    input.value = fellowshipName;
    input.setAttribute("aria-label", "Fellowship name");
    field.appendChild(lbl);
    field.appendChild(input);
    col.appendChild(field);

    const opts = readOpts();
    const optsBox = el("div", "hb-fellow-opts");
    const orbs = {};
    for (const o of OPT_DEFS) {
      const orb = makeOrb(o.label, opts[o.id], (on, inp) => {
        opts[o.id] = on;
        // Retail Ignore ↔ AutoAccept mutual exclusion.
        const pair = o.id === "ignore" ? "autoAccept" : (o.id === "autoAccept" ? "ignore" : null);
        if (on && pair && opts[pair]) {
          opts[pair] = false;
          orbs[pair].input.checked = false;
          setOptionQuiet(FELLOW_OPT_IDX[pair], false);
        }
        inp.checked = on;
        // Pre-login the local copy still drives Create's share-XP flag.
        try { localStorage.setItem("hb.fellowship.opts", JSON.stringify(opts)); } catch (_) {}
        setOptionQuiet(FELLOW_OPT_IDX[o.id], on);
      });
      orbs[o.id] = orb;
      optsBox.appendChild(orb.wrap);
    }
    col.appendChild(optsBox);

    const create = makeKitButton("Create Fellowship", () => {
      const name = input.value.trim();
      if (!name) return;
      withSession("fellowshipCreate", (h) => h.fellowshipCreate(name, !!opts.shareXp));
    });
    create.classList.add("hb-fellow-create");
    const sync = () => {
      fellowshipName = input.value;
      create.disabled = !input.value.trim();
    };
    input.addEventListener("input", sync);
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); create.click(); } });
    sync();
    col.appendChild(create);
  }

  function makeMemberRow(m) {
    const row = el("div", "hb-fellow-row" + (m.isLeader ? " is-leader" : ""));
    row.setAttribute("role", "option");
    row.dataset.guid = String(m.guid);
    const info = el("div", "hb-fellow-info");
    const name = el("span", "hb-fellow-info-name", m.name);
    if (m.isLeader) name.appendChild(el("span", "hb-fellow-lead", "  Leader"));
    const stats = el("span", "hb-fellow-stats", fellowStatsText(snapshot, m));
    info.appendChild(name);
    info.appendChild(stats);
    row.appendChild(info);
    const vit = el("div", "hb-fellow-vitals");
    const bars = {};
    for (const v of VITALS) {
      const wrap = el("div", "hb-fellow-vital");
      wrap.dataset.kind = v.key;
      wrap.appendChild(el("div", "hb-fellow-vital-fill"));
      const txt = el("span", "hb-fellow-vital-txt");
      wrap.appendChild(txt);
      vit.appendChild(wrap);
      bars[v.key] = { wrap, txt };
    }
    row.appendChild(vit);
    const sel = m.guid === selectedFellow;
    row.classList.toggle("is-selected", sel);
    row.setAttribute("aria-selected", sel ? "true" : "false");
    row.addEventListener("click", () => {
      selectedFellow = m.guid;
      setRowSelected(row.parentElement, row);
      selectWorldObject(m.guid);
      updateButtons();
    });
    const refs = { row, stats, bars };
    paintMember(refs, m);
    return refs;
  }

  function paintMember(refs, m) {
    refs.stats.textContent = fellowStatsText(snapshot, m);
    for (const v of VITALS) {
      const cur = Number(m[v.cur]) || 0;
      const max = Number(m[v.max]) || 0;
      const b = refs.bars[v.key];
      b.wrap.style.setProperty("--pct", `${vitalPct(cur, max)}%`);
      b.txt.textContent = max > 0 ? `${cur}/${max}` : "";
      b.wrap.title = max > 0 ? `${v.label} ${cur} / ${max}` : `${v.label} unknown`;
    }
  }

  function buildIn() {
    col.textContent = "";
    rowRefs = new Map();
    const head = el("div", "hb-fellow-head");
    head.appendChild(el("span", "hb-fellow-name", snapshot.name || "Fellowship"));
    if (snapshot.isLocked) {
      const b = el("span", "hb-fellow-badge is-warn", "Locked");
      b.title = "No new members can join";
      head.appendChild(b);
    }
    if (snapshot.open) {
      const b = el("span", "hb-fellow-badge", "Open");
      b.title = "Any member may recruit";
      head.appendChild(b);
    }
    head.appendChild(el("span", "hb-fellow-count", `${members.length}/${FELLOWSHIP_MAX}`));
    col.appendChild(head);
    col.appendChild(makeColHead("Fellow", "Lvl / XP%"));
    const list = el("div", "hbk-scroll hbk-list hb-soc-list");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Fellows");
    for (const m of members) {
      const refs = makeMemberRow(m);
      rowRefs.set(m.guid, refs);
      list.appendChild(refs.row);
    }
    col.appendChild(list);

    const me = () => localPlayerGuid();
    const sel = () => members.find((m) => m.guid === selectedFellow) || null;
    const row1 = el("div", "hb-soc-btnrow");
    const row2 = el("div", "hb-soc-btnrow");
    btns = {
      leader: makeKitButton("Leader", () => {
        const f = sel();
        if (f) withSession("fellowshipAssignNewLeader", (h) => h.fellowshipAssignNewLeader(f.guid));
      }, { title: "Make the selected fellow the leader" }),
      quit: makeKitButton("Quit", () => {
        confirmAction({
          title: "Leave Fellowship",
          message: "Leave the fellowship?",
          confirmLabel: "Leave",
          onConfirm: () => {
            const mine = me();
            if (mine && (snapshot?.leaderGuid >>> 0) === mine) {
              // Retail: hand leadership to a non-leader fellow before quitting.
              const heir = members.find((m) => m.guid !== mine);
              if (heir) withSession("fellowshipAssignNewLeader", (h) => h.fellowshipAssignNewLeader(heir.guid));
            }
            withSession("fellowshipQuit", (h) => h.fellowshipQuit(false));
          },
        });
      }, { title: "Leave the fellowship" }),
      open: makeKitButton(snapshot.open ? "Close" : "Open", () => {
        const next = !snapshot?.open;
        withSession("fellowshipChangeOpenness", (h) => h.fellowshipChangeOpenness(next));
      }, { title: openTitle(!!snapshot.open) }),
      recruit: makeKitButton("Recruit", () => {
        const g = selectedTargetGuid();
        if (g) withSession("fellowshipRecruit", (h) => h.fellowshipRecruit(g));
      }, { title: "Invite the selected player" }),
      dismiss: makeKitButton("Dismiss", () => {
        const f = sel();
        if (!f) return;
        confirmAction({
          title: "Dismiss Fellow",
          message: `Dismiss ${f.name} from the fellowship?`,
          confirmLabel: "Dismiss",
          onConfirm: () => withSession("fellowshipDismiss", (h) => h.fellowshipDismiss(f.guid)),
        });
      }, { title: "Remove the selected fellow" }),
      disband: makeKitButton("Disband", () => {
        confirmAction({
          title: "Disband Fellowship",
          message: "Disband the fellowship for everyone?",
          confirmLabel: "Disband",
          onConfirm: () => withSession("fellowshipQuit", (h) => h.fellowshipQuit(true)),
        });
      }, { title: "End the fellowship" }),
    };
    row1.appendChild(btns.leader);
    row1.appendChild(btns.quit);
    row1.appendChild(btns.open);
    row2.appendChild(btns.recruit);
    row2.appendChild(btns.dismiss);
    row2.appendChild(btns.disband);
    col.appendChild(row1);
    col.appendChild(row2);
    updateButtons();
  }

  function updateButtons() {
    if (!btns || !snapshot) return;
    const mine = localPlayerGuid();
    const world = selectedTargetGuid();
    const st = fellowshipButtonStates({
      isLeader: !!mine && (snapshot.leaderGuid >>> 0) === mine,
      open: !!snapshot.open,
      isFull: members.length >= FELLOWSHIP_MAX,
      playerGuid: mine,
      selectedFellowGuid: selectedFellow,
      selectedWorldGuid: world,
      selectedIsPlayer: world ? isPlayerGuid(world) : false,
      selectedIsFellow: members.some((m) => m.guid === world),
    });
    for (const k of Object.keys(btns)) btns[k].disabled = !st[k];
    // Label follows the server's openness (FullUpdate echo).
    const label = snapshot.open ? "Close" : "Open";
    if (btns.open.textContent !== label) btns.open.textContent = label;
    btns.open.title = openTitle(!!snapshot.open);
    // A wasm build without the FellowshipChangeOpenness (0x0291) binding.
    if (typeof getHandle()?.fellowshipChangeOpenness !== "function") btns.open.disabled = true;
  }

  function render(snap) {
    snapshot = snap;
    members = membersOf(snap);
    if (!members.some((m) => m.guid === selectedFellow)) selectedFellow = 0;
    if (members.length) buildIn(); else buildAlone();
  }

  // HUD rec #48: Stats(2)/Vitals(3) updates patch rows in place; anything
  // structural (join/leave/leader change) rebuilds.
  function patch(snap) {
    const next = membersOf(snap);
    if (!btns || next.length !== members.length) return false;
    for (const m of next) {
      const refs = rowRefs.get(m.guid);
      const prev = members.find((x) => x.guid === m.guid);
      if (!refs || !prev || prev.isLeader !== m.isLeader) return false;
    }
    snapshot = snap;
    members = next;
    for (const m of next) paintMember(rowRefs.get(m.guid), m);
    updateButtons();
    return true;
  }

  render(fetchFellowshipSnapshot());
  const offs = [
    onBus("fellowshipUpdated", () => {
      try {
        const snap = fetchFellowshipSnapshot();
        const t = snap?.updateType ?? 1;
        if (!((t === 2 || t === 3) && patch(snap))) render(snap);
      } catch (_) {}
    }),
    onBus("selectionChanged", () => { try { updateButtons(); } catch (_) {} }),
  ];
  return () => {
    for (const off of offs) { try { off(); } catch (_) {} }
    fellowshipVisible(-1);
    col.remove();
  };
}

registerSocialPage("fellowship", { mount: mountFellowshipPage });

// Main-panel view "fellowship" (F9) — the social hub on its Fellowship tab.
export const view = {
  name: "Fellowship",
  nameFor: () => "Social",
  mount: (parentEl, ctx) => mountSocialHub(parentEl, { tab: ctx?.tab ?? "fellowship", inMainPanel: true }),
};

export const manifest = {
  id: "fellowship-panel",
  name: "Fellowship",
  icon: "🤝",
  iconHidden: true,
  version: "0.2.0",
  description: "Fellowship tab of the social hub (gmFellowshipUI 0x21000030) + standalone floaty",
};

// ─── Standalone fellowship floaty (#hb-fellow-standalone) ───────────────
// The fellowship page in its own draggable kit window — a party frame that
// can stay up while the main panel shows something else.

let floaty = null; // { win, body, cleanup }

function buildStandalone() {
  ensureStyles();
  const win = el("div", "hbk-window");
  win.id = STANDALONE_OVERLAY_ID;
  win.hidden = true;
  win.setAttribute("role", "dialog");
  win.setAttribute("aria-label", "Fellowship");
  const { bar } = makeTitlebar("Fellowship", { onClose: () => closeStandalone() });
  win.appendChild(bar);
  const body = el("div", "hb-fellow-floaty-body");
  win.appendChild(body);
  win.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && ev.target?.tagName !== "INPUT") closeStandalone();
  });
  document.body.appendChild(win);
  attachWindowPosition(win, {
    windowId: FELLOW_WINDOW_ID,
    dragHandle: bar,
    ignoreSelector: ".hbk-close",
    defaultPos: { left: "16px", top: "140px" },
  });
  return { win, body, cleanup: null };
}

function openStandalone() {
  if (typeof document === "undefined") return;
  if (!floaty) floaty = buildStandalone();
  if (!floaty.cleanup) floaty.cleanup = mountFellowshipPage(floaty.body);
  floaty.win.hidden = false;
}

function closeStandalone() {
  if (!floaty) return;
  floaty.win.hidden = true;
  if (floaty.cleanup) { try { floaty.cleanup(); } catch (_) {} }
  floaty.cleanup = null;
}

if (typeof window !== "undefined") {
  if (!window.__hbFellowshipPanelEscBound && typeof window.addEventListener === "function") {
    window.__hbFellowshipPanelEscBound = true;
    window.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape" || !floaty || floaty.win.hidden) return;
      const tag = ev.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      closeStandalone();
    });
  }
  window.__openFellowshipPanel = openStandalone;
  window.__closeFellowshipPanel = closeStandalone;
}
