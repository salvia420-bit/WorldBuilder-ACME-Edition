// tests/vendor_ui_handle_reconnect.test.mjs — 2026-10-18 systematic review,
// PLUGINSB-2.
//
// plugins/vendor-ui.js hooks the plugin bus once, on __pluginClientReady
// (login). Its listeners captured `window.__sessionHandle` at hook time. A
// reconnect in the same page (`?autoLogin=1&maxRetries=N` after a kick, or
// an agent re-running __runAutonomousLogin) frees that SessionHandle and
// installs a new one; index.html rebinds the facade in place
// (pluginClient.attachHandle) and createClient never runs again. Every
// later VendorOpened then called getVendorState on the freed handle —
// wasm-bindgen throws ("null pointer passed to rust") and no vendor window
// opened for the rest of the page.
//
// CONTRACT (the REAL plugins/vendor-ui.js on tests/helpers/fake_dom_items.mjs)
//   [1] production order: mount before login, hook on __pluginClientReady,
//       a VendorOpened opens the vendor window;
//   [2] after the old handle is freed and a new one installed, VendorOpened
//       reads the NEW handle and opens its vendor; the old one is not called;
//   [3] the playerInventoryChanged re-pull reads the new handle too.
//
// Run from apps/holtburger-web/:  node tests/vendor_ui_handle_reconnect.test.mjs

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

const VENDOR_A = 0x70000001;
const VENDOR_B = 0x70000002;
const rawVendor = (vendorGuid, vendorName, items) => ({
  vendorGuid, vendorName, buyMultiplier: 0.9, sellMultiplier: 1.5,
  alternateCurrencyWcid: 0, alternateCurrencyAmount: 0, alternateCurrencyName: "",
  items: items.map(([itemGuid, name]) => ({ itemGuid, wcid: itemGuid & 0xff, name, value: 10, stackSize: 1, itemType: 0x20, iconId: 0 })),
});
function makeHandle(vendors) {
  const h = {
    freed: false,
    stateCalls: 0,
    vendors,
    getVendorState(g) {
      if (h.freed) throw new Error("null pointer passed to rust");
      h.stateCalls += 1;
      return h.vendors.get(g >>> 0) ?? null;
    },
    getCurrentVendorProfile() {
      if (h.freed) throw new Error("null pointer passed to rust");
      return null;
    },
    playerInventory: () => [],
    objectName: () => undefined,
  };
  return h;
}
const handle1 = makeHandle(new Map([[VENDOR_A, rawVendor(VENDOR_A, "Lin the Trader", [[0x90000001, "Bread"]])]]));
const handle2 = makeHandle(new Map([[VENDOR_B, rawVendor(VENDOR_B, "Grocer Abu", [[0x90000002, "Apple"]])]]));

const listeners = new Map();
const bus = {
  on(n, fn) { if (!listeners.has(n)) listeners.set(n, new Set()); listeners.get(n).add(fn); },
  off(n, fn) { listeners.get(n)?.delete(fn); },
  emit(n, detail) { for (const fn of [...(listeners.get(n) || [])]) fn(new FakeEvent(n, { detail })); },
};
window.getLocalPlayerGuid = () => 0x50000001;
globalThis.fetch = () => Promise.reject(new Error("no network in this suite"));

// Page load: the bar mounts vendor-ui with no client and no session.
delete window.__pluginClient;
delete window.__sessionHandle;
let resolveReady = null;
window.__pluginClientReady = new Promise((r) => { resolveReady = r; });
const vendor = await import("../plugins/vendor-ui.js");
const unmount = vendor.mount({ client: null });

const root = () => document.getElementById("hb-vendor-bar");
const isOpen = () => root()?.dataset.open === "1";
const text = () => root()?.textContent ?? "";
const stock = () => root().querySelectorAll(".hvb-cell").map((c) => Number(c.dataset.itemGuid));
const quiet = (fn) => { const i = console.info; console.info = () => {}; try { fn(); } finally { console.info = i; } };

console.log("[1] login #1");
await check("hooked on __pluginClientReady; VendorOpened opens the vendor window", async () => {
  window.__sessionHandle = handle1;
  window.__pluginClient = { events: bus };
  resolveReady(window.__pluginClient);
  await settle();
  quiet(() => bus.emit("vendorOpened", { u32Payload: VENDOR_A }));
  assert.ok(isOpen(), "open");
  assert.match(text(), /Lin the Trader/);
  quiet(() => window.__vendorPluginDebug.close());
  assert.equal(isOpen(), false);
});

console.log("[2] kick → reconnect: the old SessionHandle is freed, a new one installed");
await check("VendorOpened reads the NEW handle and opens its vendor", () => {
  handle1.freed = true;
  window.__sessionHandle = handle2;
  quiet(() => bus.emit("vendorOpened", { u32Payload: VENDOR_B }));
  assert.ok(isOpen(), "open");
  assert.match(text(), /Grocer Abu/);
  assert.deepEqual(stock(), [0x90000002]);
  assert.equal(handle2.stateCalls, 1, "the new handle answered");
});

console.log("[3] playerInventoryChanged re-pull");
await check("the re-pull reads the new handle (new stock shows)", () => {
  handle2.vendors.set(VENDOR_B, rawVendor(VENDOR_B, "Grocer Abu", [[0x90000002, "Apple"], [0x90000003, "Cheese"]]));
  quiet(() => bus.emit("playerInventoryChanged", {}));
  assert.equal(handle2.stateCalls, 2);
  assert.deepEqual(stock(), [0x90000002, 0x90000003]);
  quiet(() => window.__vendorPluginDebug.close());
});

unmount();
console.log(`\nvendor_ui_handle_reconnect: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
