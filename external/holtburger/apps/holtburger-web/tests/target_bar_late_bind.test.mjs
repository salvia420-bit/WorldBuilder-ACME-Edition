// tests/target_bar_late_bind.test.mjs — 2026-10-18 review fix pass (the
// PLUGINS-A late-bind class, plugins/target-bar.js mountToolbarControls).
//
// The hotbar mounts the toolbar controls at page load, before login, so they
// bind their bus listeners when window.__pluginClientReady resolves. A
// toolbar disposed BEFORE that (a hot remount, a bar teardown) used to bind
// anyway: three listeners on a dead toolbar, never removed.
//
//   [1] mounted before login: binds once on __pluginClientReady; dispose unbinds
//   [2] disposed before login: never binds when the promise resolves later
//
// Run from apps/holtburger-web/:  node tests/target_bar_late_bind.test.mjs

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

function makeBus() {
  const listeners = new Map();
  return {
    on(n, fn) { if (!listeners.has(n)) listeners.set(n, new Set()); listeners.get(n).add(fn); },
    off(n, fn) { listeners.get(n)?.delete(fn); },
    emit(n, detail) { for (const fn of [...(listeners.get(n) || [])]) fn(new FakeEvent(n, { detail })); },
    total() { let t = 0; for (const s of listeners.values()) t += s.size; return t; },
  };
}
function deferredClient() {
  let resolve;
  const ready = new Promise((r) => { resolve = r; });
  return { ready, resolve };
}

const { mountToolbarControls } = await import("../plugins/target-bar.js");

await check("[1] mounted before login: binds once on __pluginClientReady, dispose unbinds", async () => {
  delete window.__pluginClient;
  const d = deferredClient();
  window.__pluginClientReady = d.ready;
  const field = document.createElement("div");
  document.body.appendChild(field);
  const tb = mountToolbarControls(field);
  const bus = makeBus();
  assert.equal(bus.total(), 0);
  d.resolve({ events: bus });
  await settle();
  assert.equal(bus.total(), 3, "selectionChanged + playerStatsUpdated + entityHealthUpdated");
  tb.dispose();
  assert.equal(bus.total(), 0, "dispose removes them");
});

await check("[2] disposed before login: never binds when the ready promise resolves later", async () => {
  delete window.__pluginClient;
  const d = deferredClient();
  window.__pluginClientReady = d.ready;
  const field = document.createElement("div");
  document.body.appendChild(field);
  const tb = mountToolbarControls(field);
  tb.dispose();
  const bus = makeBus();
  d.resolve({ events: bus });
  await settle();
  assert.equal(bus.total(), 0, `a disposed toolbar bound ${bus.total()} listener(s)`);
});

delete window.__pluginClientReady;
console.log(`target_bar_late_bind: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
