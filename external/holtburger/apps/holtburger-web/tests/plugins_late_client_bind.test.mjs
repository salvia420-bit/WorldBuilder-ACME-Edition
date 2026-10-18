// tests/plugins_late_client_bind.test.mjs — 2026-10-18 systematic review
// (PLUGINSB-1, PLUGINSB-3, PLUGINSB-4, and the hover-tooltip sweep).
//
// app/plugin_bar.js mounts every bar slot ONCE at page load with
// `mountBar({ client: null })`; window.__pluginClient is built only after
// login (index.html), which then resolves window.__pluginClientReady. A
// plugin that subscribed in mount() to `ctx.client ?? window.__pluginClient`
// never subscribed at all. The older suites pre-set __pluginClient before
// mount (the opposite of production order) and could not see it. Here: mount
// with client null and no __pluginClient, then the bus + the ready promise.
//
// CONTRACT
//   [1] salvage-panel: salvageResult binds on __pluginClientReady → the
//       retail "You obtain …" chat line (crafting-3) and the Results list;
//   [2] tinker-panel: playerInventoryChanged binds late → a fired tinker
//       leaves "Working…" and a consumed tool leaves its slot;
//   [3] landblock-messages (?lbMessages=on): binds late, reads the payload
//       off ev.detail (the bus dispatches a CustomEvent), and its disposer
//       really unsubscribes (api.js events.on returns nothing);
//   [4] hover-tooltip: hoverEntity reaches the post-login bus;
//   [5] every disposer removes the late listener; a client present at mount
//       subscribes once; a plugin disposed before login never subscribes.
//
// Run from apps/holtburger-web/:  node tests/plugins_late_client_bind.test.mjs

import assert from "node:assert/strict";
import { installFakeDom, FakeEvent } from "./helpers/fake_dom_items.mjs";

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err?.stack?.split("\n").slice(0, 3).join(" | ") ?? err}`);
  }
}
const settle = async (n = 4) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

/* ── fake session + the plugin bus (api.js shape: CustomEvent detail) ──── */

const PLAYER = 0x50000001;
const UST = 0x80000004;
const BAG = 0x80000005;
const DAGGER = 0x80000002;
const calls = [];
const chat = [];
let inv = [
  { guid: DAGGER, wcid: 100, name: "Iron Dagger", itemType: 0x01, iconId: 0, equipMask: 0, containerId: PLAYER },
  { guid: UST, wcid: 102, name: "Ust", itemType: 0x20000000, iconId: 0, equipMask: 0, containerId: PLAYER },
  { guid: BAG, wcid: 103, name: "Salvaged Iron", itemType: 0x40000000, iconId: 0, equipMask: 0, containerId: PLAYER },
];
window.__sessionHandle = {
  playerGuid: () => PLAYER,
  playerInventory: () => inv.map((i) => ({ ...i })),
  objectName: (g) => inv.find((i) => i.guid === (g >>> 0))?.name,
  getObjectIconId: () => 0,
  useWithTarget: (a, b) => calls.push(["useWithTarget", a >>> 0, b >>> 0]),
};
window.getLocalPlayerGuid = () => PLAYER;
window.__appendChatLine = (text, cat) => chat.push([text, cat]);

const listeners = new Map();
const bus = {
  on(n, fn) { if (!listeners.has(n)) listeners.set(n, new Set()); listeners.get(n).add(fn); },
  off(n, fn) { listeners.get(n)?.delete(fn); },
  emit(n, detail) { for (const fn of [...(listeners.get(n) || [])]) fn(new FakeEvent(n, { detail })); },
  count(n) { return listeners.get(n)?.size ?? 0; },
};
const client = { events: bus };
const counts = () => ({
  salvageResult: bus.count("salvageResult"),
  playerInventoryChanged: bus.count("playerInventoryChanged"),
  landblockChanged: bus.count("landblockChanged"),
});
const NONE = { salvageResult: 0, playerInventoryChanged: 0, landblockChanged: 0 };
const ONE = { salvageResult: 1, playerInventoryChanged: 1, landblockChanged: 1 };

// The bar mounts before login: no client, a pending ready promise.
delete window.__pluginClient;
let resolveReady = null;
window.__pluginClientReady = new Promise((r) => { resolveReady = r; });
window.location.search = "?lbMessages=on";
const chatLog = document.createElement("ul");
chatLog.id = "chat-log";
document.body.appendChild(chatLog);

const salvage = await import("../plugins/salvage-panel.js");
const tinker = await import("../plugins/tinker-panel.js");
const lbMessages = await import("../plugins/landblock-messages.js");
const hover = await import("../plugins/hover-tooltip.js");

const unmount = {
  salvage: salvage.mount({ client: null }),
  tinker: tinker.mount({ client: null }),
  lb: lbMessages.mount({ client: null }),
  hover: hover.mount({ client: null }),
};
const byId = (id) => document.getElementById(id);
const text = (id) => byId(id)?.textContent ?? "";

console.log("[0] page-load mount, then login");
await check("mounted before login: nothing subscribed", () => {
  assert.deepEqual(counts(), NONE);
});
await check("__pluginClientReady resolves → each plugin subscribes once", async () => {
  window.__pluginClient = client;
  resolveReady(client);
  await settle();
  assert.deepEqual(counts(), ONE);
});

console.log("[1] salvage-panel");
await check("salvageResult → the retail chat line + the Results list", () => {
  window.__openSalvagePanel(UST);
  chat.length = 0;
  bus.emit("salvageResult", { skill: 0, augBonus: 0, results: [{ material: 0x3D, units: 12, workmanship: 5.42 }] });
  assert.equal(chat.length, 1, "one chat line");
  assert.match(chat[0][0], /^You obtain 12 Iron \(ws 5\.42\) using your knowledge of /);
  assert.match(text("hb-salvage-panel"), /You obtain 12 × Iron \(workmanship 5\.42\)/);
  window.__closeSalvagePanel();
});

console.log("[2] tinker-panel");
await check("a fired tinker: 'Working…' → the bag is consumed → 'Done', the Use slot empties", () => {
  calls.length = 0;
  window.__openTinkerPanel({ toolGuid: BAG, targetGuid: DAGGER });
  const root = byId("hb-tinker-panel");
  let apply = null;
  for (const b of root.querySelectorAll("button")) if (b.textContent.trim() === "Apply") apply = b;
  apply.click();
  assert.deepEqual(calls, [["useWithTarget", BAG, DAGGER]]);
  assert.match(text("hb-tinker-panel"), /Working/);
  inv = inv.filter((i) => i.guid !== BAG);
  bus.emit("playerInventoryChanged", {});
  assert.match(text("hb-tinker-panel"), /Done — see chat for the result\./);
  assert.doesNotMatch(text("hb-tinker-panel"), /Salvaged Iron/, "the consumed bag left its slot");
  assert.match(text("hb-tinker-panel"), /Iron Dagger/);
  window.__closeTinkerPanel();
});

console.log("[3] landblock-messages (?lbMessages=on)");
await check("landblockChanged {prevLb, lbId} (as a CustomEvent) prints one line per new landblock", () => {
  bus.emit("landblockChanged", { prevLb: 0, lbId: 0xA9B40000 });
  bus.emit("landblockChanged", { prevLb: 0xA9B40000, lbId: 0xA9B40000 });
  const lines = chatLog.querySelectorAll("li").map((li) => li.textContent);
  assert.deepEqual(lines, ["Entering Landblock 0xA9B4 (169, 180)"]);
});

console.log("[4] hover-tooltip");
await check("an unnamed entity at rest → hoverEntity {guid, name: null} on the post-login bus", async () => {
  const seen = [];
  const savedEmit = bus.emit;
  bus.emit = (n, detail) => { if (n === "hoverEntity") seen.push(detail); else savedEmit.call(bus, n, detail); };
  try {
    window.__pickEntityAt = () => 0x7A4B4013;
    window.liveScene3d = { entityManager: { entityMap: new Map([[0x7A4B4013, { meta: {} }]]) } };
    window.dispatchEvent(new FakeEvent("mousemove", { clientX: 200, clientY: 150 }));
    await new Promise((r) => setTimeout(r, 450));
    assert.deepEqual(seen, [{ guid: 0x7A4B4013, name: null, source: "tooltip" }]);
  } finally {
    bus.emit = savedEmit;
    delete window.__pickEntityAt;
    delete window.liveScene3d;
  }
});

console.log("[5] dispose / remount");
await check("each disposer removes its late listener", () => {
  unmount.salvage();
  unmount.tinker();
  unmount.lb();
  unmount.hover();
  assert.deepEqual(counts(), NONE);
});
await check("a client present at mount subscribes at once, and only once", async () => {
  const again = [salvage.mount({ client }), tinker.mount({ client }), lbMessages.mount({ client })];
  assert.deepEqual(counts(), ONE);
  await settle();
  assert.deepEqual(counts(), ONE);
  for (const un of again) un();
  assert.deepEqual(counts(), NONE);
});
await check("disposed before login → never subscribes when the bus arrives", async () => {
  delete window.__pluginClient;
  let resolveLate = null;
  window.__pluginClientReady = new Promise((r) => { resolveLate = r; });
  for (const un of [salvage.mount({ client: null }), tinker.mount({ client: null }), lbMessages.mount({ client: null })]) un();
  window.__pluginClient = client;
  resolveLate(client);
  await settle();
  assert.deepEqual(counts(), NONE);
});

console.log(`\nplugins_late_client_bind: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
