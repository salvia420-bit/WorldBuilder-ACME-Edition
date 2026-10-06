// tests/social_panel_dom.test.mjs — HUD overhaul 2026-10-05.
//
// DOM smoke test for the social + quest cluster (social hub, allegiance,
// fellowship, friends, squelch, contracts, journal, library) on the small
// fake DOM in tests/helpers/social_fake_dom.mjs. It mounts every view the way
// plugins/main-panel.js does, drives the controls, and asserts:
//
//   • ONE tab strip per hub (the before-shot drew two, labels overlapped)
//     and every label rendered once;
//   • every wire action still reaches the session handle with the retail
//     arguments (Swear → selected guid, Break → PATRON guid, Kick → the
//     selected VASSAL, squelch type 0x01, fellowship UpdateRequest on
//     show/hide, AbandonContract, AddFriend/RemoveFriend …);
//   • retail enable rules gate the buttons;
//   • sensible empty states.
// Layout/visuals are verified by the orchestrator's screenshots, not here.
//
// Run from apps/holtburger-web/:
//   node tests/social_panel_dom.test.mjs

import assert from "node:assert/strict";
import { installFakeDom, visibleText, typeInto, FakeEvent } from "./helpers/social_fake_dom.mjs";

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);

// ── fakes: chat log, chat input, session handle, bus, selection ─────────
const chatLog = document.createElement("ul");
chatLog.id = "chat-log";
document.body.appendChild(chatLog);
const chatInput = document.createElement("input");
chatInput.className = "hb-chat-input";
document.body.appendChild(chatInput);

const ME = 0x50000009;
const names = { 0x50000005: "Stranger", 0x50000001: "Boss", 0x50000004: "Vassal Val", 0x50000006: "Fellow Fay", 0x7000AAAA: "Drudge" };
const players = new Set([0x50000005, 0x50000001, 0x50000004, 0x50000006, ME]);
const calls = [];
const rec = (name) => (...args) => { calls.push([name, ...args]); };
const state = { friends: null, squelch: null, allegiance: null, fellowship: null, contracts: null, options: {}, inventory: [] };
globalThis.__sessionHandle = {
  playerGuid: () => ME,
  objectDescFlags: (g) => (players.has(g) ? 0x08 : 0),
  objectName: (g) => names[g],
  isCharacterOptionEnabled: (o) => !!state.options[o],
  setCharacterOption: (o, v) => { state.options[o] = v; calls.push(["setCharacterOption", o, v]); },
  playerFriends: () => state.friends,
  playerSquelch: () => state.squelch,
  playerAllegiance: () => state.allegiance,
  playerFellowship: () => state.fellowship,
  playerContracts: () => state.contracts,
  playerInventory: () => state.inventory,
  playerBook: () => null,
  getLocalPlayerPose: () => ({ landblockId: 0xA9B4001F, x: 96, y: 96, z: 0, heading: 0 }),
  ...Object.fromEntries([
    "addFriend", "removeFriend", "modifyCharacterSquelch", "modifyAccountSquelch", "modifyGlobalSquelch",
    "swearAllegiance", "breakAllegiance", "breakAllegianceBoot", "setAllegianceName", "setAllegianceOfficer",
    "allegianceChatGag", "addAllegianceBan", "removeAllegianceBan", "doAllegianceLockAction",
    "recallAllegianceHometown", "requestAllegianceInfo", "fellowshipCreate", "fellowshipQuit",
    "fellowshipRecruit", "fellowshipDismiss", "fellowshipAssignNewLeader", "fellowshipUpdateRequest",
    "abandonContract", "bookData",
  ].map((n) => [n, rec(n)])),
};
const busL = new Map();
const bus = {
  on(n, f) { if (!busL.has(n)) busL.set(n, new Set()); busL.get(n).add(f); },
  off(n, f) { busL.get(n)?.delete(f); },
  emit(n, detail) { for (const f of [...(busL.get(n) || [])]) f(new FakeEvent(n, { detail })); },
  count(n) { return busL.get(n)?.size ?? 0; },
};
globalThis.__pluginClient = { events: bus, player: { stats: { name: "Tester" } } };
let selected = 0;
globalThis.liveScene3d = {
  entityManager: {
    getSelectedTarget: () => selected,
    getEntityName: (g) => names[g] || "",
    entityMap: new Map([[0x50000005, {}], [0x50000006, {}], [0x7000AAAA, {}]]),
    _commitSelection(g) { const prev = selected; selected = g >>> 0; bus.emit("selectionChanged", { guid: selected, prevGuid: prev }); return selected; },
  },
};
function select(g) { globalThis.liveScene3d.entityManager._commitSelection(g); }

// Minimal main panel with plugins/main-panel.js semantics (view stack,
// showView remounts, toggleView closes the top view).
const mpBody = document.createElement("div");
mpBody.className = "hb-mp-body";
document.body.appendChild(mpBody);
const views = new Map();
let stack = [];
let mpCleanup = null;
let mpOpen = false;
let mpTitle = "";
function mpMountTop() {
  if (mpCleanup) { mpCleanup(); mpCleanup = null; }
  mpBody.textContent = "";
  const { id, ctx } = stack[stack.length - 1];
  const v = views.get(id);
  mpTitle = typeof v.nameFor === "function" ? v.nameFor(ctx) : v.name;
  mpCleanup = v.mount(mpBody, ctx) || null;
  mpOpen = true;
}
globalThis.__mainPanel = {
  registerView: (id, v) => views.set(id, v),
  showView(id, ctx = {}) { if (!views.has(id)) return; stack = [{ id, ctx }]; mpMountTop(); },
  closeView() {
    if (mpCleanup) { mpCleanup(); mpCleanup = null; }
    mpBody.textContent = "";
    stack.pop();
    if (stack.length) mpMountTop(); else mpOpen = false;
  },
  toggleView(id, ctx) { if (mpOpen && stack.at(-1)?.id === id) this.closeView(); else this.showView(id, ctx); },
  isOpen: () => mpOpen,
  currentViewId: () => stack.at(-1)?.id ?? null,
  setTitle: (t) => { mpTitle = t; return true; },
};

const social = await import("../plugins/social-panel.js");
const alleg = await import("../plugins/allegiance-panel.js");
const fellow = await import("../plugins/fellowship-panel.js");
const contracts = await import("../plugins/contracts-panel.js");
const journal = await import("../plugins/journal-panel.js");
const lore = await import("../plugins/lore-panel.js");
// Registration the way app/plugin_bar.js does + social-panel's bar mount.
views.set("allegiance", alleg.view);
views.set("fellowship", fellow.view);
views.set("contracts", contracts.view);
views.set("journal", journal.view);
views.set("lore", lore.view);
social.mount();

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.stack || err.message}`); }
}
const q = (sel, root = mpBody) => root.querySelector(sel);
const qa = (sel, root = mpBody) => root.querySelectorAll(sel);
const btn = (label, root = mpBody) => qa("button", root).find((b) => b.textContent === label);
function confirmModal() {
  const ok = document.querySelector("#hb-modal-dialog [data-action='confirm']");
  assert.ok(ok, "a confirmation dialog is open");
  ok.click();
}
const lastCall = (name) => [...calls].reverse().find((c) => c[0] === name);
const M = (guid, name, extra = {}) => ({ guid, name, rank: 2, level: 60, loggedIn: true, cpTithed: 0, ...extra });

// ── social hub ──────────────────────────────────────────────────────────
console.log("── social hub ─────────────────────────────────────────────");

check("'social' view is registered by the bar-slot mount", () => {
  assert.ok(views.has("social"));
});

check("F8 opens ONE tab strip with four retail labels, each drawn once", () => {
  globalThis.__mainPanel.showView("allegiance");
  assert.equal(mpTitle, "Social");
  const strips = qa(".hbk-tabs");
  assert.equal(strips.length, 1, "exactly one tab strip");
  const labels = qa(".hbk-tab", strips[0]).map((t) => t.textContent);
  assert.deepEqual(labels, ["Allegiance", "Fellowship", "Friends", "Squelch"]);
  assert.equal(q(".hbk-tab[aria-selected='true']").textContent, "Allegiance");
  const text = visibleText(mpBody);
  assert.equal(text.split("Fellowship").length - 1, 1, "'Fellowship' rendered once");
});

check("allegiance empty state + Swear gated on a selected player", () => {
  assert.match(visibleText(mpBody), /You have not sworn allegiance\./);
  assert.equal(btn("Swear").disabled, true, "nothing selected");
  assert.equal(btn("Break").disabled, true);
  assert.equal(btn("Kick").disabled, true);
  select(0x7000AAAA); // a monster
  assert.equal(btn("Swear").disabled, true, "monsters cannot be sworn to");
  select(0x50000005);
  assert.equal(btn("Swear").disabled, false);
  btn("Swear").click();
  confirmModal();
  assert.deepEqual(lastCall("swearAllegiance"), ["swearAllegiance", 0x50000005]);
});

check("Ignore Allegiance Requests orb round-trips CharacterOption 0x01", () => {
  const orb = qa("input.hbk-check").find((i) => i.parentNode.textContent.includes("Ignore Allegiance"));
  orb.click();
  assert.deepEqual(lastCall("setCharacterOption"), ["setCharacterOption", 0x01, true]);
});

check("sworn: Patron / Monarch row, vassals, Break → patron, Kick → selected vassal", () => {
  state.allegiance = {
    name: "Order of Tests", rank: 3, isLocked: true, motd: "Hi", totalMembers: 6, totalVassals: 1,
    monarch: M(0x50000001, "Boss"), patron: M(0x50000001, "Boss"),
    myself: M(ME, "Me", { cpTithed: 1234 }),
    vassals: [M(0x50000004, "Vassal Val", { cpTithed: 5000 }), M(0x50000007, "Sleepy", { loggedIn: false })],
  };
  bus.emit("allegianceUpdated", {});
  const t = visibleText(mpBody);
  assert.match(t, /Order of Tests/);
  assert.match(t, /Locked/);
  assert.match(t, /Patron \/ Monarch/);
  assert.match(t, /1,234/, "my passed-up XP in the merged row");
  assert.match(t, /Followers: 5/, "monarch followers = members − 1");
  assert.equal(qa(".hb-alleg-vassal-row").length, 2);
  assert.match(t, /Sleepy \(Offline\)/);
  assert.equal(btn("Swear").disabled, true, "already has a patron");
  assert.equal(btn("Kick").disabled, true, "no vassal selected yet");
  btn("Break").click();
  confirmModal();
  assert.deepEqual(lastCall("breakAllegiance"), ["breakAllegiance", 0x50000001]);
  qa(".hb-alleg-vassal-row")[0].click();
  assert.equal(btn("Kick").disabled, false);
  btn("Kick").click();
  confirmModal();
  assert.deepEqual(lastCall("breakAllegiance"), ["breakAllegiance", 0x50000004]);
});

check("Manage opens the Allegiance Management floaty (zoomable #hb-* root)", () => {
  btn("Manage").click();
  const win = document.getElementById("hb-alleg-standalone");
  assert.ok(win && !win.hidden);
  assert.equal(win.parentNode, document.body, "direct <body> child → hud_scale zooms it");
  const who = qa("input.hbk-input", win).find((i) => i.placeholder === "Character name");
  typeInto(who, "Vassal Val");
  btn("Gag", win).click();
  assert.deepEqual(lastCall("allegianceChatGag"), ["allegianceChatGag", "Vassal Val", true]);
  btn("Appoint", win).click();
  confirmModal();
  assert.deepEqual(lastCall("setAllegianceOfficer"), ["setAllegianceOfficer", "Vassal Val", 1]);
  btn("Boot", win).click();
  confirmModal();
  assert.deepEqual(lastCall("breakAllegianceBoot"), ["breakAllegianceBoot", "Vassal Val", false]);
  btn("Apply", win).click();
  assert.deepEqual(lastCall("doAllegianceLockAction"), ["doAllegianceLockAction", 2]);
  globalThis.__closeAllegiancePanel();
  assert.equal(win.hidden, true);
});

check("tab click routes through the main panel (F9 view) and fellowship asks for vitals", () => {
  const before = calls.filter((c) => c[0] === "fellowshipUpdateRequest").length;
  btn("Fellowship").click();
  assert.equal(globalThis.__mainPanel.currentViewId(), "fellowship");
  assert.equal(q(".hbk-tab[aria-selected='true']").textContent, "Fellowship");
  const reqs = calls.filter((c) => c[0] === "fellowshipUpdateRequest");
  assert.equal(reqs.length, before + 1);
  assert.deepEqual(reqs.at(-1), ["fellowshipUpdateRequest", true], "retail OnVisibilityChanged(true)");
  assert.equal(bus.count("allegianceUpdated"), 0, "allegiance page unsubscribed on unmount");
});

check("fellowship alone: orb options, Create gated on a name", () => {
  assert.match(visibleText(mpBody), /You do not belong to a fellowship\./);
  assert.equal(qa("input.hbk-check").length, 4, "four retail option orbs");
  const create = btn("Create Fellowship");
  assert.equal(create.disabled, true);
  const name = qa("input.hbk-input")[0];
  typeInto(name, "Test Party");
  assert.equal(create.disabled, false);
  create.click();
  assert.equal(lastCall("fellowshipCreate")[1], "Test Party");
});

check("fellowship (leader): rows with vitals, Dismiss/Leader on a selected fellow, Recruit on a selected player", () => {
  state.fellowship = {
    name: "Test Party", leaderGuid: ME, shareXp: true, evenShare: true, open: false, isLocked: false, updateType: 1,
    members: [
      { guid: ME, name: "Me", level: 100, currentHealth: 50, maxHealth: 100, currentStamina: 10, maxStamina: 10, currentMana: 0, maxMana: 0 },
      { guid: 0x50000006, name: "Fellow Fay", level: 80, currentHealth: 1, maxHealth: 4, currentStamina: 3, maxStamina: 3, currentMana: 2, maxMana: 2 },
    ],
  };
  bus.emit("fellowshipUpdated", {});
  const rows = qa(".hb-fellow-row");
  assert.equal(rows.length, 2);
  assert.match(visibleText(rows[0]), /100 \/ 75%/, "even split for 2 fellows");
  assert.equal(rows[0].querySelector(".hb-fellow-vital").style.getPropertyValue("--pct"), "50%");
  assert.equal(btn("Disband").disabled, false);
  assert.equal(btn("Dismiss").disabled, true);
  select(0x50000005);
  assert.equal(btn("Recruit").disabled, false);
  btn("Recruit").click();
  assert.deepEqual(lastCall("fellowshipRecruit"), ["fellowshipRecruit", 0x50000005]);
  rows[1].click();
  assert.equal(selected, 0x50000006, "list click selects the fellow in the world");
  assert.equal(btn("Recruit").disabled, true, "a fellow is selected now");
  btn("Dismiss").click();
  confirmModal();
  assert.deepEqual(lastCall("fellowshipDismiss"), ["fellowshipDismiss", 0x50000006]);
  btn("Leader").click();
  assert.deepEqual(lastCall("fellowshipAssignNewLeader"), ["fellowshipAssignNewLeader", 0x50000006]);
  assert.equal(btn("Open").disabled, true, "no openness binding yet");
});

check("fellowship vitals patch in place on a Vitals(3) update", () => {
  const rowBefore = qa(".hb-fellow-row")[1];
  state.fellowship = { ...state.fellowship, updateType: 3, members: state.fellowship.members.map((m) => (m.guid === 0x50000006 ? { ...m, currentHealth: 3 } : m)) };
  bus.emit("fellowshipUpdated", {});
  const rowAfter = qa(".hb-fellow-row")[1];
  assert.equal(rowAfter, rowBefore, "same row element (patched, not rebuilt)");
  assert.equal(rowAfter.querySelector(".hb-fellow-vital").style.getPropertyValue("--pct"), "75%");
});

check("Quit as leader hands leadership on first (retail), then quits", () => {
  btn("Quit").click();
  confirmModal();
  const n = calls.length;
  assert.deepEqual(calls[n - 2], ["fellowshipAssignNewLeader", 0x50000006]);
  assert.deepEqual(calls[n - 1], ["fellowshipQuit", false]);
});

check("Friends tab: sorted list, Send Tell prefills chat, Remove/Add wire", () => {
  state.friends = { friends: [
    { friendId: 11, name: "Zed", isOnline: true },
    { friendId: 12, name: "Amy", isOnline: false },
    { friendId: 13, name: "Bob", isOnline: true },
  ] };
  btn("Friends").click();
  assert.equal(globalThis.__mainPanel.currentViewId(), "social");
  const updates = calls.filter((c) => c[0] === "fellowshipUpdateRequest");
  assert.deepEqual(updates.at(-1), ["fellowshipUpdateRequest", false], "leaving fellowship → OnVisibilityChanged(false)");
  const rows = qa(".hb-soc-row");
  assert.deepEqual(rows.map((r) => r.querySelector(".hb-soc-row-name").textContent), ["Bob", "Zed", "Amy"]);
  assert.equal(btn("Send Tell").disabled, true);
  rows[0].click();
  btn("Send Tell").click();
  assert.equal(chatInput.value, "/t Bob, ");
  btn("Remove").click();
  confirmModal();
  assert.deepEqual(lastCall("removeFriend"), ["removeFriend", 13]);
  const add = btn("Add");
  assert.equal(add.disabled, true);
  typeInto(qa("input.hbk-input")[0], "Newpal");
  add.click();
  assert.deepEqual(lastCall("addFriend"), ["addFriend", "Newpal"]);
});

check("Squelch tab: retail type 0x01, speculative row, Unsquelch", () => {
  btn("Squelch").click();
  assert.match(visibleText(mpBody), /No one is squelched\./);
  typeInto(qa("input.hbk-input")[0], "Spammer");
  btn("Squelch Character").click();
  assert.deepEqual(lastCall("modifyCharacterSquelch"), ["modifyCharacterSquelch", 0, "Spammer", true, 0x01]);
  const row = qa(".hb-soc-row")[0];
  assert.ok(row, "speculative row appears");
  row.click();
  btn("Unsquelch").click();
  assert.deepEqual(lastCall("modifyCharacterSquelch"), ["modifyCharacterSquelch", 0, "Spammer", false, 0x01]);
  select(0x50000005);
  btn("Target").click();
  assert.equal(qa("input.hbk-input")[0].value, "Stranger");
  btn("Squelch Account").click();
  confirmModal();
  assert.deepEqual(lastCall("modifyAccountSquelch"), ["modifyAccountSquelch", "Stranger", true, 0x01]);
});

check("Shift+F3 toggle closes the open hub, reopens on the remembered tab", () => {
  globalThis.__toggleSocialPanel();
  assert.equal(globalThis.__mainPanel.isOpen(), false);
  globalThis.__toggleSocialPanel();
  assert.equal(globalThis.__mainPanel.currentViewId(), "social");
  assert.equal(q(".hbk-tab[aria-selected='true']").textContent, "Squelch", "remembered tab");
  globalThis.__mainPanel.closeView();
});

check("social floaty hosts the same hub and closes cleanly", () => {
  globalThis.__openSocialPanel("friends");
  const win = document.getElementById("hb-social-standalone");
  assert.ok(win && !win.hidden);
  assert.equal(qa(".hbk-tabs", win).length, 1);
  assert.equal(q(".hbk-tab[aria-selected='true']", win).textContent, "Friends");
  btn("Allegiance", win).click(); // in-place switch (not the main panel)
  assert.equal(q(".hbk-tab[aria-selected='true']", win).textContent, "Allegiance");
  assert.equal(globalThis.__mainPanel.isOpen(), false);
  globalThis.__closeSocialPanel();
  assert.equal(win.hidden, true);
});

check("fellowship floaty mounts the fellowship page", () => {
  globalThis.__openFellowshipPanel();
  const win = document.getElementById("hb-fellow-standalone");
  assert.ok(win && !win.hidden);
  assert.equal(qa(".hb-fellow-row", win).length, 2);
  globalThis.__closeFellowshipPanel();
  assert.equal(win.hidden, true);
});

// ── contracts / journal / library ───────────────────────────────────────
console.log("── quests ─────────────────────────────────────────────────");

check("contracts: empty state, then rows + details + Abandon", () => {
  globalThis.__mainPanel.showView("contracts");
  assert.match(visibleText(mpBody), /You have no contracts\./);
  globalThis.__hbWasm = {
    getContractRecord: (id) => (id === 7 ? {
      name: "Drudge Cull", nameNpcStart: "Avarin", nameNpcEnd: "", description: "Slay drudges.",
      descriptionProgress: "%d/5 Drudges", questflagTimer: "", locationNpcStart: { cellId: 0xA9B4001F },
      locationQuestArea: { cellId: 0x01D90108 },
    } : null),
  };
  state.contracts = { displayContractId: 0, trackers: [
    { contractId: 7, stage: 6, timeWhenDone: 0, timeWhenRepeats: 0 },
    { contractId: 9, stage: 3, timeWhenDone: 0, timeWhenRepeats: 3600 },
  ] };
  bus.emit("contractsUpdated", {});
  const rows = qa(".hb-con-row");
  assert.equal(rows.length, 2);
  assert.match(visibleText(rows[0]), /Contract 9/);
  assert.match(visibleText(rows[1]), /Drudge Cull.*2\/5 Drudges/);
  assert.equal(btn("Abandon").disabled, true);
  rows[1].click();
  const t = visibleText(mpBody);
  assert.match(t, /Avarin/);
  assert.match(t, /42\.7N, 33\.6E/);
  assert.match(t, /Indoors/);
  btn("Abandon").click();
  confirmModal();
  assert.deepEqual(lastCall("abandonContract"), ["abandonContract", 7]);
  // Sort by name reversed → Drudge Cull after Contract 9 flips.
  const nameSort = qa(".hb-con-sortbtn")[0];
  nameSort.click();
  assert.equal(nameSort.getAttribute("aria-sort"), "descending");
});

check("journal: Quests tab lists contracts; clicking opens Contracts on it", () => {
  globalThis.__mainPanel.showView("journal");
  assert.equal(qa(".hbk-tabs").length, 1);
  assert.match(visibleText(mpBody), /Journal of Tester/);
  const entries = qa(".hb-jrnl-entry");
  assert.equal(entries.length, 2);
  entries.find((e) => visibleText(e).includes("Drudge Cull")).click();
  assert.equal(globalThis.__mainPanel.currentViewId(), "contracts");
  assert.equal(q(".hb-con-row.is-selected").dataset.id, "7");
});

check("journal Notes: retail notebook pages, Record, timer, paging", () => {
  globalThis.__mainPanel.showView("journal", { tab: "notes" });
  assert.equal(q(".hbk-tab[aria-selected='true']").textContent, "Notes");
  assert.match(visibleText(mpBody), /~ 1 ~/);
  const inputs = qa("input.hb-jrnl-input");
  typeInto(inputs[1], "Aerbax keys"); // title
  btn("Record").click();
  assert.match(visibleText(mpBody), /42\.4N, 33\.6E/);
  const [d, h, m] = qa("input.hb-jrnl-num");
  typeInto(h, "2");
  btn("Start").click();
  assert.match(visibleText(mpBody), /2h 0s|1h 59m/);
  assert.ok(btn("Reset"), "running timer offers Reset");
  btn("New").click();
  assert.match(visibleText(mpBody), /~ 2 ~/);
  q(".hb-jrnl-prev").click();
  assert.match(visibleText(mpBody), /~ 1 ~/, "blank page 2 torn out on leaving it");
  assert.equal(q(".hb-jrnl-next").disabled, true);
  assert.equal(qa("input.hb-jrnl-input")[1].value, "Aerbax keys");
  globalThis.__mainPanel.closeView();
  const saved = JSON.parse(localStorage.getItem("hb.journal.pages.v1.Tester"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].title, "Aerbax keys");
  assert.ok(saved[0].timer.endsAt > 0);
});

check("library: empty state, then a writable item appears", () => {
  globalThis.__mainPanel.showView("lore");
  assert.match(visibleText(mpBody), /Your library is empty/);
  globalThis.__mainPanel.closeView();
  state.inventory = [{ wcid: 77, guid: 0x80000001, name: "Tome of Lore", itemType: 0x2000 }];
  globalThis.__mainPanel.showView("lore");
  const row = q(".hb-soc-row");
  assert.ok(row);
  row.click();
  assert.deepEqual(lastCall("bookData"), ["bookData", 0x80000001]);
  assert.match(visibleText(mpBody), /Opening the book/);
  globalThis.__mainPanel.closeView();
});

check("no debug strings leak into the chat log", () => {
  const lines = chatLog.children.map((li) => li.textContent);
  assert.ok(!lines.some((l) => /\[(social|allegiance|fellowship|contracts)/.test(l)), lines.join(" | "));
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
