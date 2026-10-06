// tests/social_panel.test.mjs — HUD overhaul 2026-10-05.
//
// Pure-logic coverage for the social hub (plugins/social-panel.js) and the
// allegiance / fellowship pages it hosts, each pinned to the retail rule it
// ports (acclient.c):
//
//   • resolveSocialTab            — explicit tab > remembered > Allegiance
//   • sortFriendsForDisplay       — gmFriendsUI::FindSortedInsertPosition
//                                    (online first, then name)
//   • canAddFriend                — Add disabled at 50 friends (0x32)
//   • SQUELCH_ALL_CHANNELS = 0x01 — gmSquelchUI sends ChatMessageType 1;
//                                    ACE rejects 0xFFFFFFFF
//   • applySquelchToMirror        — speculative squelch mirror
//   • buildAllegianceViewModel    — gmAllegianceUI::UpdateMonarchData /
//                                    UpdatePatronData / UpdateVassalsData
//   • allegianceButtonStates      — UpdateSwearButton / UpdateBreakButton /
//                                    vassal-selection Kick
//   • evenSplitXpPct / fellowStatsText / fellowshipButtonStates —
//     FellowshipSystem::GetEvenSplitXPPctg, gmFellowshipUI::UpdateFellowStats
//     and ::UpdateButtons
//
// Run from apps/holtburger-web/:
//   node tests/social_panel.test.mjs

import assert from "node:assert/strict";

// Minimal DOM so the real modules evaluate (their DOM work is in mount()).
function mkEl() {
  return {
    style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { this.children.push(c); return c; },
    setAttribute() {}, addEventListener() {}, remove() {}, querySelectorAll: () => [],
  };
}
globalThis.window = globalThis;
globalThis.document = {
  createElement: mkEl,
  getElementById: () => null,
  head: mkEl(),
  body: mkEl(),
};

const social = await import("../plugins/social-panel.js");
const alleg = await import("../plugins/allegiance-panel.js");
const fellow = await import("../plugins/fellowship-panel.js");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.message}`); }
}

console.log("── social hub ─────────────────────────────────────────────");

check("resolveSocialTab: explicit > remembered > allegiance", () => {
  assert.equal(social.resolveSocialTab("friends", "squelch"), "friends");
  assert.equal(social.resolveSocialTab("bogus", "squelch"), "squelch");
  assert.equal(social.resolveSocialTab(undefined, "nope"), "allegiance");
  assert.equal(social.resolveSocialTab(null, null), "allegiance");
});

check("SOCIAL_TABS mirror gmSocialUI's four tabs and route to view ids", () => {
  assert.deepEqual(social.SOCIAL_TABS.map((t) => t.id), ["allegiance", "fellowship", "friends", "squelch"]);
  assert.deepEqual(social.SOCIAL_TABS.map((t) => t.view), ["allegiance", "fellowship", "social", "social"]);
});

check("sortFriendsForDisplay: online first, then name (code-unit order)", () => {
  const rows = social.sortFriendsForDisplay([
    { friendId: 1, name: "Zed", isOnline: false },
    { friendId: 2, name: "Bob", isOnline: true },
    { friendId: 3, name: "Amy", isOnline: false },
    { friendId: 4, name: "Cat", isOnline: true },
    null,
  ]);
  assert.deepEqual(rows.map((r) => r.name), ["Bob", "Cat", "Amy", "Zed"]);
  assert.equal(rows[0].online, true);
  assert.equal(rows[2].online, false);
});

check("canAddFriend: non-empty name and fewer than 50 friends", () => {
  assert.equal(social.canAddFriend("Bob", 0), true);
  assert.equal(social.canAddFriend("   ", 0), false);
  assert.equal(social.canAddFriend("Bob", 49), true);
  assert.equal(social.canAddFriend("Bob", 50), false);
});

check("SQUELCH_ALL_CHANNELS is ChatMessageType.AllChannels (0x01)", () => {
  assert.equal(social.SQUELCH_ALL_CHANNELS, 0x01);
});

check("applySquelchToMirror: add by name, update by guid, remove", () => {
  let m = social.applySquelchToMirror(null, { name: "Griefer", add: true });
  assert.equal(m.characters.length, 1);
  assert.equal(m.characters[0].targetGuid, 0);
  assert.equal(m.characters[0].mask, 0x01);
  // A later guid-carrying squelch of the same name updates, not duplicates.
  m = social.applySquelchToMirror(m, { name: "griefer", guid: 0x50000001, add: true });
  assert.equal(m.characters.length, 1);
  assert.equal(m.characters[0].targetGuid, 0x50000001);
  m = social.applySquelchToMirror(m, { name: "Alt", isAccount: true, add: true });
  assert.equal(m.characters.length, 2);
  m = social.applySquelchToMirror(m, { name: "ALT", isAccount: true, add: false });
  assert.equal(m.characters.length, 1, "account names are case-insensitive");
  m = social.applySquelchToMirror(m, { guid: 0x50000001, name: "Griefer", add: false });
  assert.equal(m.characters.length, 0);
});

check("squelchKey distinguishes account / guid / name entries", () => {
  assert.equal(social.squelchKey({ isAccount: true, name: "Bob" }), "acct:bob");
  assert.equal(social.squelchKey({ targetGuid: 5, name: "Bob" }), "char:5");
  assert.equal(social.squelchKey({ targetGuid: 0, name: "Bob" }), "name:bob");
});

check("fmtInt groups thousands", () => {
  assert.equal(social.fmtInt(1234567), "1,234,567");
  assert.equal(social.fmtInt(0), "0");
  assert.equal(social.fmtInt("x"), "0");
});

check("social view registers as the 'Social' hub", () => {
  assert.equal(social.view.name, "Social");
  assert.equal(typeof social.view.mount, "function");
  assert.equal(typeof social.mount, "function", "bar-slot mount registers the view");
});

console.log("── allegiance ─────────────────────────────────────────────");

const M = (guid, name, extra = {}) => ({ guid, name, rank: 1, level: 50, loggedIn: true, cpTithed: 0, ...extra });

check("not in an allegiance → empty model", () => {
  const vm = alleg.buildAllegianceViewModel(null);
  assert.equal(vm.inAllegiance, false);
  assert.equal(vm.hasPatron, false);
  assert.deepEqual(vm.vassals, []);
});

check("player is monarch (no `myself`) → monarch/patron sections hidden", () => {
  const vm = alleg.buildAllegianceViewModel({
    name: "Order", rank: 6, totalMembers: 3, totalVassals: 2,
    monarch: M(1, "Me", { cpTithed: 0 }),
    vassals: [M(2, "V1", { cpTithed: 1500 }), M(3, "V2", { loggedIn: false, cpTithed: 20 })],
  });
  assert.equal(vm.isMonarch, true);
  assert.equal(vm.monarch, null);
  assert.equal(vm.patron, null);
  assert.equal(vm.followers, 2);
  assert.deepEqual(vm.vassals.map((v) => v.xpProduced), [1500, 20], "vassal XP = their cp_tithed");
  assert.equal(vm.vassals[1].online, false);
});

check("patron == monarch → merged 'Patron / Monarch' row with my passed-up XP", () => {
  const vm = alleg.buildAllegianceViewModel({
    name: "Order", rank: 2, totalMembers: 5, totalVassals: 0,
    monarch: M(1, "Boss"), patron: M(1, "Boss"), myself: M(9, "Me", { cpTithed: 777 }), vassals: [],
  });
  assert.equal(vm.monarch.label, "Patron / Monarch");
  assert.equal(vm.monarch.xpProduced, 777);
  assert.equal(vm.monarch.followers, 4, "monarch followers = total members − 1");
  assert.equal(vm.patron, null, "no separate patron field");
  assert.deepEqual(vm.breakTarget, { guid: 1, name: "Boss" }, "Break still targets the patron");
});

check("distinct patron → 'Monarch' (no XP frame) + 'Patron' with my passed-up XP", () => {
  const vm = alleg.buildAllegianceViewModel({
    name: "Order", rank: 1, totalMembers: 9, totalVassals: 0,
    monarch: M(1, "Boss"), patron: M(2, "Pat"), myself: M(9, "Me", { cpTithed: 42 }), vassals: [],
  });
  assert.equal(vm.monarch.label, "Monarch");
  assert.equal(vm.monarch.xpProduced, null);
  assert.equal(vm.patron.name, "Pat");
  assert.equal(vm.patron.xpProduced, 42);
  assert.deepEqual(vm.members.sort(), [1, 2, 9]);
});

check("Swear: needs no patron + a selected player not in my allegiance (UpdateSwearButton)", () => {
  const none = alleg.buildAllegianceViewModel(null);
  const S = (vm, o) => alleg.allegianceButtonStates(vm, { playerGuid: 9, ...o }).swear;
  assert.equal(S(none, { selectedGuid: 5, selectedIsPlayer: true }), true);
  assert.equal(S(none, { selectedGuid: 0 }), false, "nothing selected");
  assert.equal(S(none, { selectedGuid: 9, selectedIsPlayer: true }), false, "self");
  assert.equal(S(none, { selectedGuid: 5, selectedIsPlayer: false }), false, "not a player");
  const monarchVm = alleg.buildAllegianceViewModel({ monarch: M(9, "Me"), vassals: [M(5, "V")] });
  assert.equal(S(monarchVm, { selectedGuid: 5, selectedIsPlayer: true }), false, "already my vassal");
  assert.equal(S(monarchVm, { selectedGuid: 6, selectedIsPlayer: true }), true, "monarch may swear");
  const sworn = alleg.buildAllegianceViewModel({ monarch: M(1, "B"), patron: M(1, "B"), myself: M(9, "Me"), vassals: [] });
  assert.equal(S(sworn, { selectedGuid: 6, selectedIsPlayer: true }), false, "has a patron");
});

check("Break needs a patron; Kick needs a selected vassal", () => {
  const sworn = alleg.buildAllegianceViewModel({ monarch: M(1, "B"), patron: M(1, "B"), myself: M(9, "Me"), vassals: [M(4, "V")] });
  const st = alleg.allegianceButtonStates(sworn, { playerGuid: 9, selectedVassalGuid: 4 });
  assert.equal(st.brk, true);
  assert.equal(st.kick, true);
  assert.equal(alleg.allegianceButtonStates(sworn, { selectedVassalGuid: 77 }).kick, false, "unknown vassal");
  const mon = alleg.buildAllegianceViewModel({ monarch: M(9, "Me"), vassals: [] });
  assert.equal(alleg.allegianceButtonStates(mon, {}).brk, false, "a monarch has nobody to break from");
});

check("allegiance view is the hub on its Allegiance tab", () => {
  assert.equal(alleg.view.name, "Allegiance");
  assert.equal(alleg.view.nameFor(), "Social");
});

console.log("── fellowship ─────────────────────────────────────────────");

check("evenSplitXpPct = FellowshipSystem::GetEvenSplitXPPctg", () => {
  assert.equal(fellow.evenSplitXpPct(1), 1);
  assert.equal(fellow.evenSplitXpPct(2), 0.75);
  assert.equal(fellow.evenSplitXpPct(9), 0.31111109);
  assert.equal(fellow.evenSplitXpPct(0), 0);
  assert.equal(fellow.evenSplitXpPct(11), 0);
});

check("fellowStatsText: no share → 0%; even → split; uneven → level only", () => {
  const m = { level: 126 };
  assert.equal(fellow.fellowStatsText({ shareXp: false, members: [1, 2] }, m), "126 / 0%");
  assert.equal(fellow.fellowStatsText({ shareXp: true, evenShare: true, members: [1, 2, 3] }, m), "126 / 60%");
  assert.equal(fellow.fellowStatsText({ shareXp: true, evenShare: false, members: [1, 2] }, m), "126");
  assert.equal(fellow.fellowStatsText({ shareXp: false }, { level: 0 }), "? / 0%");
});

check("vitalPct clamps and tolerates unknown max", () => {
  assert.equal(fellow.vitalPct(50, 100), 50);
  assert.equal(fellow.vitalPct(150, 100), 100);
  assert.equal(fellow.vitalPct(5, 0), 0);
});

check("fellowshipButtonStates: leader rules (gmFellowshipUI::UpdateButtons)", () => {
  const base = { isLeader: true, playerGuid: 9, open: false, isFull: false };
  let st = fellow.fellowshipButtonStates({ ...base });
  assert.deepEqual(st, { leader: false, quit: true, open: true, recruit: false, dismiss: false, disband: true });
  st = fellow.fellowshipButtonStates({ ...base, selectedFellowGuid: 4 });
  assert.equal(st.leader, true);
  assert.equal(st.dismiss, true);
  st = fellow.fellowshipButtonStates({ ...base, selectedFellowGuid: 9 });
  assert.equal(st.dismiss, false, "cannot dismiss yourself");
  st = fellow.fellowshipButtonStates({ ...base, selectedWorldGuid: 5, selectedIsPlayer: true });
  assert.equal(st.recruit, true);
  assert.equal(fellow.fellowshipButtonStates({ ...base, selectedWorldGuid: 5, selectedIsPlayer: true, isFull: true }).recruit, false, "full");
  assert.equal(fellow.fellowshipButtonStates({ ...base, selectedWorldGuid: 5, selectedIsFellow: true }).recruit, false, "already a fellow");
});

check("fellowshipButtonStates: members recruit only when the fellowship is open", () => {
  const base = { isLeader: false, playerGuid: 9, selectedWorldGuid: 5, selectedIsPlayer: true, selectedFellowGuid: 4 };
  assert.deepEqual(fellow.fellowshipButtonStates({ ...base, open: false }),
    { leader: false, quit: true, open: false, recruit: false, dismiss: false, disband: false });
  assert.equal(fellow.fellowshipButtonStates({ ...base, open: true }).recruit, true);
});

check("fellowship view is the hub on its Fellowship tab", () => {
  assert.equal(fellow.view.name, "Fellowship");
  assert.equal(fellow.view.nameFor(), "Social");
  assert.equal(fellow.FELLOWSHIP_MAX, 9);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
