// tests/rejection_feedback_paired_line.test.mjs — chat-errors-5 (2026-10-13).
// plugins/rejection_feedback.js swallows the transient chat line the 0x00A0
// recv arm pushes right after kind=48 (the kind=48 toast already showed it).
// That suppression used to arm for 250 ms after EVERY kind=48 and eat whatever
// transient came next — but a current pkg pushes no line for a failure retail
// prints nothing for (code 0 with nothing pending; 0x426 AttunedItem on an
// unknown object — HandleFailureEvent has no case), so an unrelated line in
// that window was lost. Now it arms only when a line will follow: the retail
// line itself (or a HandleFailureEvent line that repeats the toast word for
// word), or, for an older pkg's / `?retailAttemptFailed=off` Debug-label
// payload, the next line whatever it says (none for the player's own guid).
//
// Run: node tests/rejection_feedback_paired_line.test.mjs
import assert from "node:assert/strict";

// ── clock skew: each step starts past every earlier step's 250 ms window ──
const realNow = Date.now.bind(Date);
let skewMs = 0;
Date.now = () => realNow() + skewMs;

// ── minimal DOM + bus stubs (installed BEFORE the module evaluates) ──────
const toasts = [];
const flashed = [];
const fakeNode = (sel) => ({
  classList: { add: () => flashed.push(sel), remove: () => {} },
});
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ remove() {}, classList: { add() {}, remove() {} } }),
  head: { appendChild() {} },
  body: { appendChild: (el) => { if (el.className === "hb-rejection-toast") toasts.push(el.textContent); } },
  querySelectorAll: (sel) => (sel.includes('"305419896"') ? [fakeNode(sel)] : []),
};
const bus = new EventTarget();
const client = {
  events: {
    on: (n, h) => bus.addEventListener(n, h),
    emit: (n, p) => bus.dispatchEvent(new CustomEvent(n, { detail: p })),
  },
  attachHandle() {},
};
globalThis.window = { __pluginClient: client, __sessionHandle: { moveItem() {} } };

await import("../plugins/rejection_feedback.js");

const ITEM = 0x12345678;
const PLAYER = 0x50000001;
const AMMO = "You are out of ammunition!";
const failed = (u32Payload, u32Payload2, stringPayload) =>
  client.events.emit("kind:48", { kind: 48, u32Payload, u32Payload2, stringPayload });
const transient = (stringPayload) => client.events.emit("kind:2", { u32Payload2: 9, stringPayload });

let passed = 0;
const step = (name, fn) => {
  toasts.length = 0;
  flashed.length = 0;
  skewMs += 1000;
  try { fn(); } finally { delete window.getLocalPlayerGuid; }
  passed++;
  console.log(`  ok ${passed} - ${name}`);
};

step("no line follows (0x426 on an unknown object): the next transient within 250 ms still toasts", () => {
  failed(ITEM, 0x0426, "");
  assert.equal(toasts.length, 1, "the code's own toast (unchanged)");
  assert.ok(flashed.length > 0, "the item's slot still flashes");
  transient(AMMO);
  assert.equal(toasts.length, 2, "an unrelated transient is not swallowed");
  assert.equal(toasts[1], AMMO);
});

step("code 0 with an empty line arms nothing", () => {
  failed(ITEM, 0, "");
  assert.equal(toasts.length, 0);
  transient(AMMO);
  assert.deepEqual(toasts, [AMMO]);
});

step("the retail line's own chat copy is swallowed once; an unrelated line is not", () => {
  const line = "The Pyreal Sword can't be dropped";
  failed(ITEM, 0x0426, line);
  assert.deepEqual(toasts, [line]);
  transient(AMMO);
  assert.deepEqual(toasts, [line, AMMO], "a different line still toasts");
  transient(line);
  assert.deepEqual(toasts, [line, AMMO], "the paired copy is swallowed");
  transient(line);
  assert.deepEqual(toasts, [line, AMMO, line], "one-shot");
});

step("a HandleFailureEvent line that repeats the code toast word for word is swallowed", () => {
  failed(ITEM, 0x001d, "");
  assert.deepEqual(toasts, ["You're too busy!"]);
  transient("You're too busy!");
  assert.deepEqual(toasts, ["You're too busy!"], "no second identical toast");
  transient(AMMO);
  assert.deepEqual(toasts, ["You're too busy!", AMMO]);
});

step("the window still closes after 250 ms", () => {
  const line = "The Pyreal can't be picked up - action cancelled";
  failed(ITEM, 0x36, line);
  skewMs += 300;
  transient(line);
  assert.deepEqual(toasts, [line, line]);
});

step("a refused shop event (current pkg: the player's guid, empty line) arms nothing", () => {
  window.getLocalPlayerGuid = () => PLAYER;
  failed(PLAYER, 0, "");
  assert.equal(toasts.length, 0, "a refused shop event is not toasted");
  assert.equal(flashed.length, 0);
  transient(AMMO);
  assert.deepEqual(toasts, [AMMO]);
});

step("a player-guid retail line is left to its own chat route", () => {
  window.getLocalPlayerGuid = () => PLAYER;
  failed(PLAYER, 0x001d, " - you're too busy");
  assert.equal(toasts.length, 0, "kind=48 for the player renders nothing itself");
  transient(" - you're too busy");
  assert.deepEqual(toasts, [" - you're too busy"], "the chat line shows once");
});

step("?retailAttemptFailed=off: the player's Debug-label payload gets no line either", () => {
  window.getLocalPlayerGuid = () => PLAYER;
  failed(PLAYER, 0, "None");
  assert.equal(toasts.length, 0);
  transient(AMMO);
  assert.deepEqual(toasts, [AMMO]);
});

step("an item's Debug-label payload still swallows its paired line, whatever it says", () => {
  failed(ITEM, 0x001d, "YoureTooBusy");
  assert.deepEqual(toasts, ["You're too busy!"]);
  transient("[Wield failed] YoureTooBusy");
  assert.deepEqual(toasts, ["You're too busy!"], "the legacy paired line is swallowed");
  transient(AMMO);
  assert.deepEqual(toasts, ["You're too busy!", AMMO]);
});

step("a payload with no stringPayload (pre-kind-48 kind:13 reroute) keeps the old next-line rule", () => {
  client.events.emit("kind:13", { u32Payload: 0x001d, u32Payload2: ITEM });
  assert.deepEqual(toasts, ["You're too busy!"]);
  transient("You can't wield that!");
  assert.deepEqual(toasts, ["You're too busy!"]);
});

step("a non-transient line never consumes the armed suppression", () => {
  const line = "The Arrows can't be merged - you're too busy";
  failed(ITEM, 0x001d, line);
  client.events.emit("kind:2", { u32Payload2: 0, stringPayload: line });
  transient(line);
  assert.deepEqual(toasts, [line], "the transient copy is still the swallowed one");
});

// ── the LIVE route (review C-R3): the page never emits 'kind:2' on the bus;
// app/chat_log.js appendChatLine hands every transient line to
// window.__hbSpewBox.push, so the paired line is matched there. A swallowed
// line adds no row; an identical-top REPLACE would still append a new row.
step("live route: the retail line's chat copy through __hbSpewBox adds no second row", () => {
  const line = "The Pyreal Sword can't be dropped";
  failed(ITEM, 0x0426, line);
  assert.deepEqual(toasts, [line]);
  window.__hbSpewBox.push(line);
  assert.deepEqual(toasts, [line], "the paired copy is swallowed, not re-stacked");
  window.__hbSpewBox.push(AMMO);
  assert.deepEqual(toasts, [line, AMMO], "the next line stacks");
});

step("live route: no line follows (0x426, empty line) → the next spew line still stacks", () => {
  failed(ITEM, 0x0426, "");
  assert.equal(toasts.length, 1);
  window.__hbSpewBox.push(AMMO);
  assert.equal(toasts.length, 2);
  assert.equal(toasts[1], AMMO);
});

step("live route: an item's Debug-label payload swallows its legacy paired line", () => {
  failed(ITEM, 0x001d, "YoureTooBusy");
  window.__hbSpewBox.push("[Wield failed] YoureTooBusy");
  assert.deepEqual(toasts, ["You're too busy!"]);
  window.__hbSpewBox.push(AMMO);
  assert.deepEqual(toasts, ["You're too busy!", AMMO]);
});

step("code 0 that toasts nothing never swallows its line (Debug label or no payload)", () => {
  // ?retailAttemptFailed=off: label "None", line "You can't wield that!".
  failed(ITEM, 0, "None");
  assert.equal(toasts.length, 0, "code 0 toasts nothing");
  window.__hbSpewBox.push("You can't wield that!");
  assert.deepEqual(toasts, ["You can't wield that!"], "the only notice is shown");
  toasts.length = 0;
  skewMs += 1000;
  // The pre-kind-48 kind:13 reroute (no stringPayload), code 0.
  client.events.emit("kind:13", { u32Payload: 0, u32Payload2: ITEM });
  assert.equal(toasts.length, 0);
  transient("You can't wield that!");
  assert.deepEqual(toasts, ["You can't wield that!"]);
});

Date.now = realNow;
console.log(`rejection_feedback_paired_line: ${passed}/15 PASS`);
