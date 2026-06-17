// Wave 1.F (2026-05-28) — status-indicators event-wiring smoke test.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_status_indicators.mjs
//
// Validates that the 6 indicators wire to the established event bus
// correctly. Retail layout 0x21000071's indicator children are read_order
// 17-23 (Link/PositiveEffects/NegativeEffects/Vitae/Burden/MiniGame/Logoff);
// read_order 23 is the LogoffButton, NOT a PortalStormIndicator (rec #197),
// so there are 6 status indicators here, not 7:
//
//   buffs / debuffs  ← world.enchantmentAdded/Removed
//   vitae            ← Character.vitaeChanged + playerStatsUpdated fallback
//   burden           ← playerStatsUpdated → sessionHandle.playerBurden
//   linkstatus       ← 1Hz internal poll (not exercised here — covered by SS / SS.1)
//   minigame         ← client.events.miniGameChanged (no upstream emit yet)
//
// Portal storm has no indicator slot — portalStormChanged drives a CSS
// screen-edge pulse (#hb-portal-storm-pulse) instead.
//
// The test installs a jsdom-lite DOM shim, mounts the plugin via dynamic
// import, dispatches synthetic events through a minimal fake client, and
// asserts the indicator DOM's `classList.contains("active")` changes match.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── jsdom-lite shim (mirrors tests/buffs_hud.test.cjs:56-96) ─────────
// status-indicators.js touches document.head/body/createElement,
// setInterval/clearInterval, fetch (via loadLayout). Provide just enough
// for mount()/unmount() to run without throwing.
function installDomShim() {
  if (typeof globalThis.document !== "undefined") return;
  const elementProto = {
    appendChild(c) { this.children = this.children || []; this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) {
      if (!this.children) return;
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    setAttribute(k, v) { this.attrs = this.attrs || {}; this.attrs[k] = v; },
    removeAttribute(k) { if (this.attrs) delete this.attrs[k]; },
    getAttribute(k) { return this.attrs?.[k] ?? null; },
    addEventListener() {},
    removeEventListener() {},
    querySelector(sel) {
      const m = sel.match(/^\[data-indicator="([^"]+)"\]$/);
      if (!m) return null;
      const id = m[1];
      const walk = (n) => {
        if (n?.dataset?.indicator === id) return n;
        for (const c of n.children || []) {
          const found = walk(c);
          if (found) return found;
        }
        return null;
      };
      return walk(this);
    },
    classList: undefined,  // set per-instance below
    dataset: undefined,
    style: undefined,
    get isConnected() { return true; },
  };
  function mkClassList() {
    const set = new Set();
    return {
      add(c) { set.add(c); },
      remove(c) { set.delete(c); },
      contains(c) { return set.has(c); },
      toggle(c, force) {
        const desired = force === undefined ? !set.has(c) : !!force;
        if (desired) set.add(c); else set.delete(c);
        return desired;
      },
    };
  }
  function mkEl() {
    const el = Object.assign(Object.create(elementProto), {
      children: [],
      attrs: {},
      style: {},
      dataset: {},
      classList: mkClassList(),
      parentNode: null,
      ownerDocument: null,  // wired below after document exists
    });
    return el;
  }
  globalThis.document = {
    head: mkEl(),
    body: mkEl(),
    createElement: () => {
      const el = mkEl();
      el.ownerDocument = globalThis.document;
      return el;
    },
    getElementById(id) {
      // status-indicators.js calls this in mount() to remove a prior overlay;
      // we always return null so it skips the removal step.
      void id;
      return null;
    },
  };
  globalThis.document.head.ownerDocument = globalThis.document;
  globalThis.document.body.ownerDocument = globalThis.document;
  globalThis.window = globalThis;
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};
  globalThis.setTimeout = () => 0;
  globalThis.clearTimeout = () => {};
  globalThis.fetch = () => Promise.resolve({
    ok: false,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(""),
  });
}

installDomShim();

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

const url = pathToFileURL(
  resolvePath(__dirname, "plugins/status-indicators.js")
).href;
const { mount, manifest, __test } = await import(url);

console.log("===========================================================");
console.log("Wave 1.F — status-indicators event-wiring smoke test");
console.log("===========================================================");

console.log("\n[1] Module surface");

check("exports manifest with id=status-indicators", () => {
  if (manifest.id !== "status-indicators") {
    throw new Error(`bad manifest.id: ${manifest.id}`);
  }
});

check("exports mount() function", () => {
  if (typeof mount !== "function") throw new Error("mount not a function");
});

check("exports __test surface with classifier helpers", () => {
  if (!__test || typeof __test.classifyEnchKind !== "function") {
    throw new Error("__test.classifyEnchKind missing");
  }
});

console.log("\n[2] Pure helpers — enchantment classifier");

check("BENEFICIAL flag → buff", () => {
  if (__test.classifyEnchKind({ type: 0x2000000 }) !== "buff") throw new Error("not buff");
});

check("COOLDOWN flag → cooldown (filtered out of buff/debuff counts)", () => {
  if (__test.classifyEnchKind({ type: 0x1000000 }) !== "cooldown") throw new Error("not cooldown");
});

check("ADDITIVE + negative statValue → debuff", () => {
  const e = { type: 0x40000, statValue: -10 };
  if (__test.classifyEnchKind(e) !== "debuff") throw new Error("not debuff");
});

check("ADDITIVE + positive statValue → buff", () => {
  const e = { type: 0x40000, statValue: 10 };
  if (__test.classifyEnchKind(e) !== "buff") throw new Error("not buff");
});

check("MULTIPLICATIVE >1.0 → buff", () => {
  const e = { type: 0x80000, statValue: 1.25 };
  if (__test.classifyEnchKind(e) !== "buff") throw new Error("not buff");
});

check("MULTIPLICATIVE <1.0 → debuff", () => {
  const e = { type: 0x80000, statValue: 0.75 };
  if (__test.classifyEnchKind(e) !== "debuff") throw new Error("not debuff");
});

console.log("\n[3] Pure helpers — burden / vitae thresholds");

check("burden ratio 0.0 → inactive", () => {
  if (__test.isBurdenActive(0.0) !== false) throw new Error("0.0 is active");
});

check("burden ratio 0.49 → inactive", () => {
  if (__test.isBurdenActive(0.49) !== false) throw new Error("0.49 is active");
});

check("burden ratio 0.5 → active", () => {
  if (__test.isBurdenActive(0.5) !== true) throw new Error("0.5 not active");
});

check("burden ratio 0.99 → active, not over", () => {
  if (__test.isBurdenActive(0.99) !== true) throw new Error("0.99 not active");
  if (__test.isBurdenOver(0.99) !== false) throw new Error("0.99 marked over");
});

check("burden ratio 1.0 → active AND over", () => {
  if (__test.isBurdenActive(1.0) !== true) throw new Error("1.0 not active");
  if (__test.isBurdenOver(1.0) !== true) throw new Error("1.0 not over");
});

check("vitae 1.0 → inactive (no death penalty)", () => {
  if (__test.isVitaeActive(1.0) !== false) throw new Error("1.0 active");
});

check("vitae 0.95 → active (5% vitae)", () => {
  if (__test.isVitaeActive(0.95) !== true) throw new Error("0.95 inactive");
});

check("vitae 0.5 → active (50% vitae)", () => {
  if (__test.isVitaeActive(0.5) !== true) throw new Error("0.5 inactive");
});

console.log("\n[4] Indicator inventory");

check("6 indicators present (retail layout 0x21000071 read_order 17-22; 23 is LogoffButton)", () => {
  if (__test.INDICATORS.length !== 6) {
    throw new Error(`got ${__test.INDICATORS.length} indicators, expected 6`);
  }
  const ids = __test.INDICATORS.map(i => i.id).sort();
  const expected = ["buffs", "burden", "debuffs", "linkstatus", "minigame", "vitae"];
  for (let i = 0; i < expected.length; i += 1) {
    if (ids[i] !== expected[i]) {
      throw new Error(`missing/extra indicator: got=${ids[i]}, want=${expected[i]}`);
    }
  }
});

check("minigame indicator uses resolved layout sprites 0x060074A5/A6 (rec #149)", () => {
  const mg = __test.INDICATORS.find(i => i.id === "minigame");
  if (!mg) throw new Error("minigame indicator missing");
  if (mg.active !== "0x060074A5" || mg.inactive !== "0x060074A6") {
    throw new Error(`minigame sprites got active=${mg.active} inactive=${mg.inactive}, want 0x060074A5/0x060074A6`);
  }
});

check("no phantom portalstorm indicator slot (rec #197)", () => {
  if (__test.INDICATORS.some(i => i.id === "portalstorm")) {
    throw new Error("portalstorm slot should have been removed");
  }
});

console.log("\n[5] Event dispatch — synthetic mount + bus");

// Build a minimal fake plugin client. Mirrors createClient() in plugins/api.js
// just enough to exercise the wired subscriptions.
function makeFakeClient() {
  const bus = new EventTarget();
  const world = new EventTarget();
  // Character emits its own vitaeChanged via a private bus that mirrors
  // the EventTarget surface (per plugins/world-objects/character.js:170-225).
  const characterBus = new EventTarget();
  const character = {
    vitae: 1.0,
    addEventListener: characterBus.addEventListener.bind(characterBus),
    removeEventListener: characterBus.removeEventListener.bind(characterBus),
    dispatchEvent: characterBus.dispatchEvent.bind(characterBus),
  };
  let enchantmentSnapshot = [];
  const client = {
    events: {
      on(name, h) { bus.addEventListener(name, h); },
      off(name, h) { bus.removeEventListener(name, h); },
      emit(name, payload) { bus.dispatchEvent(new CustomEvent(name, { detail: payload })); },
    },
    player: {
      enchantments() { return enchantmentSnapshot; },
    },
    world,
    character,
    _setEnchantments(s) { enchantmentSnapshot = s; },
  };
  return client;
}

// Mount the plugin against the fake client. status-indicators.js polls
// window.__pluginClient + window.__sessionHandle inside mount(); set both
// BEFORE calling mount() so the first tryWireClient() succeeds synchronously.
const fakeClient = makeFakeClient();
let burdenValue = 0.0;
window.__pluginClient = fakeClient;
window.__sessionHandle = {
  // wasm-bindgen surfaces this as a property getter (number), per
  // src/lib.rs:18576 `#[wasm_bindgen(getter, js_name = playerBurden)]`.
  get playerBurden() { return burdenValue; },
  sessionLastRecvAgeMs: () => 0xFFFFFFFF,
  sessionLastPingRttMs: () => 0xFFFFFFFF,
};

const unmount = mount({ client: fakeClient });

// Pull the indicator DOM elements out of document.body for assertions.
const overlay = document.body.children.find(c => c.attrs?.id === "hb-status-indicators")
  ?? document.body.children[0];
function getIndicator(id) {
  return overlay.querySelector(`[data-indicator="${id}"]`);
}

check("overlay mounted to document.body", () => {
  if (!overlay) throw new Error("no overlay child on body");
});

check("all 6 indicator elements rendered", () => {
  for (const id of ["linkstatus", "buffs", "debuffs", "vitae", "burden", "minigame"]) {
    if (!getIndicator(id)) throw new Error(`missing indicator: ${id}`);
  }
});

check("no portalstorm indicator element rendered (rec #197)", () => {
  if (getIndicator("portalstorm")) throw new Error("portalstorm element should not render");
});

check("indicators start inactive (no active class)", () => {
  for (const id of ["buffs", "debuffs", "vitae", "burden", "minigame"]) {
    if (getIndicator(id).classList.contains("active")) {
      throw new Error(`${id} starts active`);
    }
  }
});

console.log("\n[6] Burden — playerStatsUpdated reads sessionHandle.playerBurden");

check("burden 0.6 → burden indicator active", () => {
  burdenValue = 0.6;
  fakeClient.events.emit("playerStatsUpdated", {});
  if (!getIndicator("burden").classList.contains("active")) {
    throw new Error("burden not active at 0.6");
  }
  if (getIndicator("burden").dataset.over === "1") {
    throw new Error("burden falsely marked over at 0.6");
  }
});

check("burden 1.1 → burden indicator active AND over", () => {
  burdenValue = 1.1;
  fakeClient.events.emit("playerStatsUpdated", {});
  if (!getIndicator("burden").classList.contains("active")) {
    throw new Error("burden not active at 1.1");
  }
  if (getIndicator("burden").dataset.over !== "1") {
    throw new Error("burden not over at 1.1");
  }
});

check("burden 0.2 → burden indicator inactive again", () => {
  burdenValue = 0.2;
  fakeClient.events.emit("playerStatsUpdated", {});
  if (getIndicator("burden").classList.contains("active")) {
    throw new Error("burden still active at 0.2");
  }
});

console.log("\n[7] Vitae — Character.vitaeChanged + playerStatsUpdated fallback");

check("Character.vitaeChanged 0.9 → vitae indicator active", () => {
  fakeClient.character.vitae = 0.9;
  fakeClient.character.dispatchEvent(new CustomEvent("vitaeChanged", {
    detail: { vitae: 0.9, oldVitae: 1.0 },
  }));
  if (!getIndicator("vitae").classList.contains("active")) {
    throw new Error("vitae not active after vitaeChanged 0.9");
  }
});

check("Character.vitaeChanged 1.0 → vitae indicator inactive", () => {
  fakeClient.character.vitae = 1.0;
  fakeClient.character.dispatchEvent(new CustomEvent("vitaeChanged", {
    detail: { vitae: 1.0, oldVitae: 0.9 },
  }));
  if (getIndicator("vitae").classList.contains("active")) {
    throw new Error("vitae still active after vitaeChanged 1.0");
  }
});

check("playerStatsUpdated fallback reads client.character.vitae", () => {
  fakeClient.character.vitae = 0.85;
  // No vitaeChanged event fired — only stats updated.
  fakeClient.events.emit("playerStatsUpdated", {});
  if (!getIndicator("vitae").classList.contains("active")) {
    throw new Error("vitae not active via fallback");
  }
});

console.log("\n[8] Buffs/debuffs — world enchantmentAdded/Removed");

check("enchantmentAdded buff → buffs indicator active", () => {
  fakeClient._setEnchantments([
    { type: 0x2000000, spellId: 1158 }, // BENEFICIAL → buff
  ]);
  fakeClient.world.dispatchEvent(new CustomEvent("enchantmentAdded", {
    detail: { type: 0, layeredSpellId: 1, spellId: 1158 },
  }));
  if (!getIndicator("buffs").classList.contains("active")) {
    throw new Error("buffs not active after add");
  }
  if (getIndicator("debuffs").classList.contains("active")) {
    throw new Error("debuffs falsely active");
  }
});

check("add debuff → debuffs indicator active too", () => {
  fakeClient._setEnchantments([
    { type: 0x2000000, spellId: 1158 },
    { type: 0x40000, statValue: -10, spellId: 999 }, // ADDITIVE neg → debuff
  ]);
  fakeClient.world.dispatchEvent(new CustomEvent("enchantmentAdded", {
    detail: { type: 0, layeredSpellId: 2, spellId: 999 },
  }));
  if (!getIndicator("buffs").classList.contains("active")) {
    throw new Error("buffs lost");
  }
  if (!getIndicator("debuffs").classList.contains("active")) {
    throw new Error("debuffs not active");
  }
});

check("enchantmentRemoved → updated counts (drop debuff, keep buff)", () => {
  fakeClient._setEnchantments([
    { type: 0x2000000, spellId: 1158 }, // only the buff remains
  ]);
  fakeClient.world.dispatchEvent(new CustomEvent("enchantmentRemoved", {
    detail: { type: 1, layeredSpellId: 2, spellId: 999 },
  }));
  if (!getIndicator("buffs").classList.contains("active")) {
    throw new Error("buffs lost on remove");
  }
  if (getIndicator("debuffs").classList.contains("active")) {
    throw new Error("debuffs still active after remove");
  }
});

check("enchantments emptied → both indicators inactive", () => {
  fakeClient._setEnchantments([]);
  fakeClient.world.dispatchEvent(new CustomEvent("enchantmentsChanged", {
    detail: { added: 0, removed: 1, total: 0, snapshot: [] },
  }));
  if (getIndicator("buffs").classList.contains("active")) {
    throw new Error("buffs still active");
  }
  if (getIndicator("debuffs").classList.contains("active")) {
    throw new Error("debuffs still active");
  }
});

console.log("\n[9] Portal storm / mini-game — speculative bus hooks");

// rec #197 — portal storm has no indicator slot (read_order 23 is the
// LogoffButton). A level>=2 storm flashes the #hb-portal-storm-pulse
// screen overlay instead. The DOM shim's getElementById always returns
// null, so firePortalStormPulse creates a fresh body-appended div per
// level>=2 trigger; we locate it by scanning body.children by id. Test
// the below-threshold case first (no element is ever created for it).
function findPortalStormPulse() {
  return (document.body.children || []).find(c => c.id === "hb-portal-storm-pulse") || null;
}

check("portalStormChanged level=1 → no screen pulse (below threshold)", () => {
  fakeClient.events.emit("portalStormChanged", { level: 1 });
  const pulse = findPortalStormPulse();
  if (pulse && pulse.classList.contains("active")) {
    throw new Error("portal-storm pulse should not activate below level 2");
  }
});

check("portalStormChanged level=2 → screen-edge pulse active", () => {
  // Speculative bus name — no upstream emit today. Validates the hook is
  // wired so the moment a downstream wave surfaces the wire, the pulse
  // fires without further status-indicators edits.
  fakeClient.events.emit("portalStormChanged", { level: 2 });
  const pulse = findPortalStormPulse();
  if (!pulse || !pulse.classList.contains("active")) {
    throw new Error("portal-storm pulse not active on level=2");
  }
});

check("miniGameChanged {active:true} → minigame indicator active", () => {
  fakeClient.events.emit("miniGameChanged", { active: true });
  if (!getIndicator("minigame").classList.contains("active")) {
    throw new Error("minigame not active");
  }
});

check("miniGameChanged {active:false} → minigame indicator inactive", () => {
  fakeClient.events.emit("miniGameChanged", { active: false });
  if (getIndicator("minigame").classList.contains("active")) {
    throw new Error("minigame still active");
  }
});

console.log("\n[10] Unmount cleanup");

check("unmount() returns cleanly", () => {
  if (typeof unmount !== "function") throw new Error("no unmount fn returned");
  unmount();
});

check("post-unmount: synthetic events no longer drive indicators", () => {
  // We can't easily check unsubscribe on the EventTarget without a leak
  // detector, but we can assert __setStatusIndicator was removed.
  if (typeof window.__setStatusIndicator === "function") {
    throw new Error("__setStatusIndicator should be deleted on unmount");
  }
});

console.log("\n===========================================================");
console.log(`Total: ${passed + failed}, PASS: ${passed}, FAIL: ${failed}`);
console.log("===========================================================");
if (failed > 0) process.exit(1);
