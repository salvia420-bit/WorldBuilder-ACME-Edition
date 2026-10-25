// tests/drone_hud.test.mjs — Drone Deploy HUD launcher (plugins/drone-hud.js, 2026-10-24).
//
// WHY: the plugin is the drone's only page-side surface and the single owner of
// three things scene3d/drone/index.js takes from it (SPEC §6.7 / §6.9): the
// deploy-refusal reader, the late-bound plugin-bus edges and the `/read`
// broadcast. A wrong flag read would load the drone for everybody; a launcher
// in the wrong place, a `disabled` button (no right-click), a state listener on
// `window` (index.js dispatches on `document`), a bus bound only at mount
// (ctx.client is null at page load) or a static scene3d/three import (I-27)
// would all pass a quick look in the browser and fail the 1070 eye test.
//
// Mounts the REAL plugin on the shared small fake DOM
// (tests/helpers/social_fake_dom.mjs, `window = globalThis`, `location.href` =
// the app's index.html file URL) and drives its real handlers: the exact
// `?drone=on` gate, the launcher in `.hb-hotbar-addons` (remount, float, flip),
// the dot / aria-disabled / tooltip for every refusal signal (real page shapes,
// incl. `targeting` for a pending use-target; index.js's `covered` only as a
// refused click's flash), one `status()` per state read,
// the tooltip key from the real manifest bindings (ui/keymap.js), the
// `hb-drone-state` listener on `document`, clicks → `api.button({shift})`
// on a fake api from `ctx.loadDrone` (and the computed-URL default loader on a
// temp-dir fake index.js), the late bus through a pending `__pluginClientReady`,
// the settings popover (right-click, rows, Escape / outside press, focus
// release on close; its outside-press closers armed at mount and checked
// against a later drone-lock capture blocker in an emulated window-capture
// order), the one idle prewarm, `/read`, the manifest, the generated index and
// the I-27 import rule.
//
// FLAG: DEFAULT ON since 2026-10-25 (DRONE_DEFAULT_ON = true); the exact ?drone=off disables it.
// Run from apps/holtburger-web/:  node tests/drone_hud.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installFakeDom, FakeEvent } from "./helpers/social_fake_dom.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);
const APP_HREF = pathToFileURL(path.join(APP, "index.html")).href;
globalThis.location = { href: APP_HREF, search: "?drone=on" };
// The fake DOM assigns ev.target, which node's native CustomEvent forbids.
class FakeCustomEvent extends FakeEvent { constructor(t, i = {}) { super(t, i); this.detail = i.detail; } }

// ── listener accounting (the fake DOM ignores the capture flag; record it) ──
function trackListeners(target) {
  const live = new Map(); // "type|capture" → Set(fn)
  const order = []; // {type, fn, capture} in registration order (a browser's same-target, same-phase order)
  const add = target.addEventListener.bind(target);
  const rem = target.removeEventListener.bind(target);
  const isCapture = (opts) => opts === true || !!(opts && opts.capture);
  const keyOf = (type, opts) => `${type}|${isCapture(opts) ? 1 : 0}`;
  target.addEventListener = (type, fn, opts) => {
    const k = keyOf(type, opts);
    if (!live.has(k)) live.set(k, new Set());
    if (!live.get(k).has(fn)) order.push({ type, fn, capture: isCapture(opts) });
    live.get(k).add(fn);
    return add(type, fn, opts);
  };
  target.removeEventListener = (type, fn, opts) => {
    live.get(keyOf(type, opts))?.delete(fn);
    const i = order.findIndex((e) => e.type === type && e.fn === fn && e.capture === isCapture(opts));
    if (i >= 0) order.splice(i, 1);
    return rem(type, fn, opts);
  };
  return {
    count(type, capture = null) {
      let n = 0;
      for (const [k, set] of live) {
        const [t, c] = k.split("|");
        if (t === type && (capture === null || c === (capture ? "1" : "0"))) n += set.size;
      }
      return n;
    },
    total() { let n = 0; for (const s of live.values()) n += s.size; return n; },
    /** The capture listeners of `type`, in registration order. */
    capture(type) { return order.filter((e) => e.type === type && e.capture).map((e) => e.fn); },
  };
}
const winL = trackListeners(window);
const docL = trackListeners(document);

/**
 * A browser's WINDOW-CAPTURE phase for a press on `target`, which the fake DOM
 * does not model (it fires window listeners last and lets every same-target
 * listener run): the window-capture listeners in registration order until one
 * calls stopImmediatePropagation(). That ordering is what the drone lock's
 * blockers and the popover's outside-press closer compete on.
 * @returns {FakeEvent} the event, with `immediateStopped`
 */
function windowCapturePress(type, target) {
  const ev = new FakeEvent(type);
  ev.target = target;
  ev.immediateStopped = false;
  ev.stopImmediatePropagation = () => { ev.immediateStopped = true; ev._stop = true; };
  for (const fn of winL.capture(type)) {
    ev.currentTarget = window;
    fn.call(window, ev);
    if (ev.immediateStopped) break;
  }
  return ev;
}
/**
 * The drone input lock's canvas blocker (controls.js lock() at the deploy
 * click, T1 — after the plugin's mount): window capture, every canvas press
 * stopImmediatePropagation()ed and prevented.
 */
function installLockBlocker(canvas) {
  const seen = [];
  const block = (ev) => {
    if (ev.target !== canvas) return;
    seen.push(ev.type);
    ev.stopImmediatePropagation();
    ev.preventDefault();
  };
  for (const t of ["pointerdown", "mousedown"]) window.addEventListener(t, block, { capture: true });
  return { seen, remove() { for (const t of ["pointerdown", "mousedown"]) window.removeEventListener(t, block, { capture: true }); } };
}

const hud = await import("../plugins/drone-hud.js");
// The same ui/keymap.js instance the plugin imports (its hotkeyLabel reads it).
const keymap = await import("../ui/keymap.js");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    const first = String(err?.stack ?? err).split("\n").slice(0, 3).join(" | ");
    console.log(`  [FAIL] ${name} — ${first}`);
  }
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const settle = async (n = 4) => { for (let i = 0; i < n; i += 1) await tick(0); };
const q = (sel, root = document) => root.querySelector(sel);
const launcher = () => document.getElementById("hb-drone-hud-launcher");
const popover = () => document.getElementById("hb-drone-hud-settings");

// ── page fakes ─────────────────────────────────────────────────────────
const PLAYER = 0x50000001;
const PAGE_KEYS = [
  "__bootState", "liveScene3d", "getLocalPlayerGuid", "__hbLoggingOff", "__sessionHandle", "__isPortalSpaceActive",
  "__getCurrentStanceLow", "__inputFunnel", "__autoRunOn", "__film", "__useTargeting", "__jumpKeydownTs",
  "__jumpChargeActive", "__pluginClient", "__pluginClientReady", "__drone", "__hotbar", "__sceneReadyEverFired",
  "requestIdleCallback", "cancelIdleCallback", "__routeSlashCommand", "__appendChatLine",
];
let poseFrees = 0;
function makeHandle(over = {}) {
  return {
    getCurrentCellId: () => 0xa9b4001f, // outdoor landcell (low 16 bits < 0x100)
    isCurrentCellIndoor: () => false,
    getLocalPlayerPose: () => ({ isOnGround: true, free() { poseFrees += 1; } }),
    localAutonomousMotion: () => 0,
    ...over,
  };
}
function resetPage() {
  for (const k of PAGE_KEYS) delete window[k];
  document.getElementById("hb-hotbar")?.remove();
  window.innerWidth = 1280;
  window.innerHeight = 720;
  globalThis.location.href = APP_HREF;
  globalThis.location.search = "?drone=on";
}
function setInWorld(over = {}) {
  window.__bootState = "in-world";
  window.liveScene3d = { renderer: { tag: "renderer" }, scene: { tag: "scene" }, camera: { tag: "camera" }, wireframeMode: false };
  window.getLocalPlayerGuid = () => PLAYER;
  window.__hbLoggingOff = false;
  window.__sessionHandle = makeHandle(over.handle);
  window.__isPortalSpaceActive = () => false;
  window.__getCurrentStanceLow = () => 0x3d;
  window.__inputFunnel = { _held: new Map() };
  window.__autoRunOn = false;
  window.__useTargeting = { pending: null };
  window.__jumpChargeActive = false;
  delete window.__jumpKeydownTs;
  delete window.__film;
}
function makeHotbar() {
  document.getElementById("hb-hotbar")?.remove();
  const hb = document.createElement("div");
  hb.id = "hb-hotbar";
  const addons = document.createElement("div");
  addons.className = "hb-hotbar-addons";
  hb.appendChild(addons);
  document.body.appendChild(hb);
  window.__hotbar = { addonSlot: () => addons };
  return { hb, addons };
}
const DEFAULT_SETTINGS = Object.freeze({
  mode: "cine", sensitivity: 1, invertY: false, gamepadLayout: "mode2", acroRc: 1, acroSuper: 0.7, acroExpo: 0,
  rangeM: 150, ceilingAglM: 120, batteryMin: 10, crash: true, crashMps: 7, quickDeploy: false, launchFacing: "pilot",
  broadcastPose: false, volume: 0.6, fovDeg: 75,
});
/** A DroneApi fake implementing the §3.9 shapes the plugin uses, recording calls. */
function makeApi() {
  const calls = [];
  let state = "idle";
  let rig = null;
  let settings = { ...DEFAULT_SETTINGS };
  const api = {
    version: "drone-1",
    status: () => { calls.push(["status"]); return { ok: true, version: "drone-1", state, rig }; },
    button: (o) => { calls.push(["button", o]); return { ok: true, action: state === "idle" ? "deploy" : "recall", state }; },
    settings: () => { calls.push(["settings"]); return { ok: true, settings: { ...settings }, defaults: { ...DEFAULT_SETTINGS } }; },
    setSettings: (p) => {
      calls.push(["setSettings", p]);
      if (p.rangeM !== undefined && p.rangeM > 180) return { ok: false, code: "bad-argument", reason: "rangeM must be within [20, 180]" };
      settings = { ...settings, ...p };
      if (p.sensitivity !== undefined) settings.sensitivity = Math.round(p.sensitivity * 10) / 10; // the API normalises
      return { ok: true, settings: { ...settings } };
    },
    calls,
    setState(s) { state = s; },
    setRig(r) { rig = r; },
    setStored(p) { settings = { ...settings, ...p }; },
    count(type) { return calls.filter((c) => c[0] === type).length; },
    last(type) { const all = calls.filter((c) => c[0] === type); return all.length ? all[all.length - 1] : null; },
  };
  return api;
}
/** ctx.loadDrone fake: records deps, installs window.__drone like installDrone does. */
function makeLoader(api, { failFirst = 0 } = {}) {
  const deps = [];
  let fails = failFirst;
  const fn = async (d) => {
    deps.push(d);
    if (fails > 0) { fails -= 1; throw new Error("fake import failure"); }
    window.__drone = api;
    return api;
  };
  fn.deps = deps;
  return fn;
}
async function withNowOffset(offsetMs, fn) {
  const real = Date.now;
  Date.now = () => real() + offsetMs;
  try { return await fn(); } finally { Date.now = real; }
}
/** Run the launcher tick now: index.js's per-transition event (the plugin ticks on every one). */
async function forceTick() {
  document.dispatchEvent(new FakeCustomEvent("hb-drone-state", { bubbles: false, detail: { state: "idle", prev: "idle", at: 0 } }));
  await settle(1);
}
const DEFAULT_TIP = "Deploy the camera drone (right-click: settings)";
function captureWarns(fn) {
  const real = console.warn;
  const out = [];
  console.warn = (...a) => { out.push(a.join(" ")); };
  return Promise.resolve().then(fn).then(
    (v) => { console.warn = real; return { v, warns: out }; },
    (e) => { console.warn = real; throw e; },
  );
}
async function withMount(ctx, fn) {
  const dispose = hud.mount({ client: null, slot: {}, root: document.body, bar: null, ...ctx });
  try { return await fn(dispose); } finally { dispose(); }
}
function assertNeverDisabled(b) {
  assert.equal(b.disabled, false, "the launcher is never disabled");
  assert.equal(b.hasAttribute("disabled"), false, "no disabled attribute");
}

console.log("drone_hud — plugins/drone-hud.js launcher, refusals, bus, settings, prewarm");

// ── [1] flag ───────────────────────────────────────────────────────────
console.log("\n[1] ?drone flag (DEFAULT ON, exact ?drone=off escape)");

await check("DRONE_DEFAULT_ON is true (flipped after the 1070 eye test); only the exact ?drone=off disables", () => {
  assert.equal(hud.DRONE_DEFAULT_ON, true);
  assert.equal(hud.droneHudEnabled("?drone=off"), false);
  assert.equal(hud.droneHudEnabled("drone=off&x=1"), false);
  for (const s of ["?drone=on", "?drone=ON", "?drone=1", "?drone=OFF", "?drone=0", "?drone=", "", "?other=off", null, undefined]) {
    assert.equal(hud.droneHudEnabled(s), true, `search ${JSON.stringify(s)} stays on`);
  }
});

await check("droneHudEnabled(s, false) keeps the development reader: only the exact ?drone=on enables", () => {
  assert.equal(hud.droneHudEnabled("?drone=on", false), true);
  for (const s of ["?drone=ON", "?drone=1", "?drone=true", "?drone=off", "?drone=", "", null, undefined]) {
    assert.equal(hud.droneHudEnabled(s, false), false, `search ${JSON.stringify(s)} stays off with defaultOn false`);
  }
});

await check("droneHudEnabled(s, true): only the exact ?drone=off disables", () => {
  assert.equal(hud.droneHudEnabled("?drone=off", true), false);
  for (const s of ["", "?drone=on", "?drone=OFF", "?drone=0", "?drone=false", null, undefined]) {
    assert.equal(hud.droneHudEnabled(s, true), true, `search ${JSON.stringify(s)} stays on after the flip`);
  }
  assert.doesNotThrow(() => hud.droneHudEnabled({ [Symbol.iterator]: 1 }));
});

await check("with the exact ?drone=off mount() mounts nothing and installs no globals", () => {
  resetPage();
  makeHotbar();
  for (const s of ["?drone=off", "drone=off&x=1"]) {
    globalThis.location.search = s;
    const before = { win: winL.total(), doc: docL.total() };
    const dispose = hud.mount({ client: null });
    assert.equal(typeof dispose, "function");
    assert.equal(launcher(), null, `no launcher for ${s}`);
    assert.equal(document.getElementById("hb-drone-hud-style"), null);
    assert.equal(window.__toggleDroneHud, undefined);
    assert.equal(window.__droneHud, undefined);
    assert.deepEqual({ win: winL.total(), doc: docL.total() }, before, "no listener added");
    dispose();
  }
  resetPage();
});

// ── [2] launcher placement ─────────────────────────────────────────────
console.log("\n[2] launcher in the toolbar add-on column, remount, float, flip");

await check("launcher: a BUTTON in .hb-hotbar-addons with the kit tooltip; the style carries order: 10", async () => {
  resetPage();
  const { addons } = makeHotbar();
  await withMount({}, () => {
    const b = launcher();
    assert.ok(b, "launcher built");
    assert.equal(b.tagName, "BUTTON");
    assert.equal(b.type, "button");
    assert.equal(b.parentNode, addons, "inside the add-on column");
    assert.ok(b.classList.contains("dhud-launcher"));
    assert.equal(b.getAttribute("data-tip"), "");
    assert.ok(q(".dhud-launcher-icon", b) && q(".dhud-launcher-dot", b), "icon + dot");
    assert.equal(b.title, "", "the toolbar's kit tooltip covers it (no title)");
    assert.equal(typeof b._hbTip, "function");
    const tip = b._hbTip();
    assert.equal(tip.text, "Drone");
    assert.equal(tip.key, "Shift+F11");
    assert.equal(typeof tip.sub, "string");
    assertNeverDisabled(b);
    const style = document.getElementById("hb-drone-hud-style");
    assert.ok(style, "style #hb-drone-hud-style");
    assert.match(style.textContent, /\.dhud-launcher \{[^}]*order: 10;/);
    assert.match(style.textContent, /#hb-drone-hud-launcher-float \{ position: fixed; right: 12px; bottom: 84px; z-index: 55; \}/);
    assert.match(style.textContent, /mask: url\("data:image\/svg\+xml,/, "quadcopter icon is a CSS mask data URI");
  });
  assert.equal(launcher(), null, "dispose removed the launcher");
  assert.equal(document.getElementById("hb-drone-hud-style"), null, "dispose removed the style");
});

await check("one launcher per page: a second mount is a no-op", async () => {
  resetPage();
  makeHotbar();
  await withMount({}, () => {
    const d2 = hud.mount({ client: null });
    assert.equal(document.querySelectorAll("#hb-drone-hud-launcher").length, 1);
    d2();
    assert.ok(launcher(), "the no-op disposer leaves the first launcher");
  });
});

await check("remount: hb-hotbar-mounted (fired before __hotbar is re-pointed) re-attaches to the NEW column", async () => {
  resetPage();
  makeHotbar();
  const oldSlot = window.__hotbar.addonSlot();
  await withMount({}, () => {
    assert.equal(launcher().parentNode, oldSlot);
    // hotbar.js remount: the old toolbar is removed, the event fires, THEN __hotbar is assigned.
    document.getElementById("hb-hotbar").remove();
    const hb = document.createElement("div");
    hb.id = "hb-hotbar";
    const addons = document.createElement("div");
    addons.className = "hb-hotbar-addons";
    hb.appendChild(addons);
    document.body.appendChild(hb);
    window.__hotbar = { addonSlot: () => oldSlot }; // still the removed column
    document.dispatchEvent(new FakeCustomEvent("hb-hotbar-mounted", { detail: { root: hb, addons } }));
    assert.equal(launcher().parentNode, addons, "moved into the event's column");
    assert.equal(launcher().isConnected, true);
  });
});

await check("no toolbar → the fixed float (right 12 / bottom 84) with a title; a toolbar later takes it back", async () => {
  resetPage();
  await withMount({}, () => {
    const float = document.getElementById("hb-drone-hud-launcher-float");
    assert.ok(float, "float created");
    assert.equal(float.parentNode, document.body, "float is a body child (HUD-zoomed #hb-*)");
    assert.equal(launcher().parentNode, float);
    assert.equal(launcher().title, "Drone — deploy / recall (Shift+F11)");
    const { addons } = makeHotbar();
    document.dispatchEvent(new FakeCustomEvent("hb-hotbar-mounted", { detail: { root: addons.parentNode, addons } }));
    assert.equal(launcher().parentNode, addons);
    assert.equal(document.getElementById("hb-drone-hud-launcher-float"), null, "float removed");
    assert.equal(launcher().title, "", "title dropped inside the toolbar");
  });
  assert.equal(document.getElementById("hb-drone-hud-launcher-float"), null);
});

await check("a disconnected launcher re-attaches on the tick; the column flips at the screen edge (rynth rule)", async () => {
  resetPage();
  const { addons } = makeHotbar();
  await withMount({}, async () => {
    window.innerWidth = 320; // rect.right 300 + 36 > 320
    await tick(560);
    assert.equal(addons.classList.contains("flip"), true, "flipped left");
    window.innerWidth = 1280;
    await tick(560);
    assert.equal(addons.classList.contains("flip"), false, "flipped back");
    launcher().remove();
    assert.equal(launcher(), null);
    await tick(560);
    assert.ok(launcher(), "re-attached by the 500 ms tick");
    assert.equal(launcher().parentNode, addons);
  });
});

// ── [3] refusals ───────────────────────────────────────────────────────
console.log("\n[3] deploy refusals: REFUSAL_TEXT, refusalFor, readDeploySignals (real page shapes)");

await check("REFUSAL_TEXT is the exact frozen §2.8 table (incl. `targeting`, SPEC §14 R4-10, and index.js's `covered`, phase 4 F1)", () => {
  assert.deepEqual({ ...hud.REFUSAL_TEXT }, {
    "not-in-world": "Enter the world first",
    portal: "Not while in portal space",
    dead: "Not while dead",
    "film-busy": "A film take owns the camera",
    busy: "The drone is busy",
    targeting: "Finish targeting first",
    indoors: "Outdoors only",
    combat: "Leave combat mode first",
    moving: "Stand still to deploy",
    covered: "Needs open sky above you",
  });
  assert.ok(Object.isFrozen(hud.REFUSAL_TEXT));
  // `covered` is index.js's own check at deploy: no page signal of the plugin's maps to it.
  const all = { inWorld: true, portal: true, dead: true, filmBusy: true, busy: true, targeting: true, indoors: true, combat: true, moving: true };
  for (const k of Object.keys(all)) {
    if (k === "inWorld") continue;
    assert.notEqual(hud.refusalFor({ inWorld: true, [k]: true }), "covered", k);
  }
  assert.notEqual(hud.refusalFor(all), "covered");
});

await check("refusalFor: not-in-world first, then portal > dead > film-busy > busy > targeting > indoors > combat > moving", () => {
  assert.equal(hud.refusalFor(null), "not-in-world");
  assert.equal(hud.refusalFor({ inWorld: false, portal: true }), "not-in-world");
  const s = { inWorld: true, portal: true, dead: true, filmBusy: true, busy: true, targeting: true, indoors: true, combat: true, moving: true };
  for (const [k, code] of [["portal", "portal"], ["dead", "dead"], ["filmBusy", "film-busy"], ["busy", "busy"],
    ["targeting", "targeting"], ["indoors", "indoors"], ["combat", "combat"], ["moving", "moving"]]) {
    assert.equal(hud.refusalFor(s), code);
    s[k] = false;
  }
  assert.equal(hud.refusalFor(s), null);
});

await check("readDeploySignals: in-world needs bootState in-world|ready, handle, liveScene3d, guid, not logging off", () => {
  resetPage();
  assert.deepEqual(hud.readDeploySignals(window, { health: null }), { inWorld: false });
  setInWorld();
  const clear = hud.readDeploySignals(window, { health: null });
  assert.deepEqual(clear, { inWorld: true, portal: false, dead: false, filmBusy: false, busy: false, targeting: false,
    indoors: false, combat: false, moving: false });
  window.__bootState = "ready";
  assert.equal(hud.readDeploySignals(window, { health: null }).inWorld, true, "'ready' and 'in-world' share the scalar");
  for (const [k, v] of [["__bootState", "char-list-ready"], ["__sessionHandle", null], ["liveScene3d", null],
    ["getLocalPlayerGuid", () => 0], ["__hbLoggingOff", true]]) {
    setInWorld();
    window[k] = v;
    assert.equal(hud.readDeploySignals(window, { health: null }).inWorld, false, `${k} = ${v}`);
  }
  resetPage();
});

await check("readDeploySignals: each signal from its real page shape", () => {
  const sig = () => hud.readDeploySignals(window, { health: null });
  resetPage();
  setInWorld(); window.__isPortalSpaceActive = () => true; assert.equal(sig().portal, true);
  setInWorld(); window.__pluginClient = { host: { TryGetPlayerStats: () => ({ vitals: { 1: { current: 0, base: 100, max: 100 } } }) } };
  assert.equal(sig().dead, true, "vitals fallback (TryGetPlayerStats().vitals[1])");
  assert.equal(hud.readDeploySignals(window, { health: { current: 50, max: 100 } }).dead, false, "the bus cache wins");
  assert.equal(hud.readDeploySignals(window, { health: { current: 0, max: 100 } }).dead, true);
  setInWorld(); window.__film = { status: () => ({ ok: true, active: false, cameraOwned: false, clean: false, take: { running: { mode: "take", locked: true, record: true, frames: 3, progress: 0.1 } } }) };
  assert.equal(sig().filmBusy, true, "take.running is an object → film-busy");
  window.__film = { status: () => ({ ok: true, active: false, cameraOwned: false, clean: false, take: { running: null } }) };
  assert.equal(sig().filmBusy, false, "take.running null → not busy");
  window.__film = { status: () => ({ ok: true, active: false, cameraOwned: true, clean: false, take: { running: null } }) };
  assert.equal(sig().filmBusy, true, "cameraOwned");
  setInWorld(); window.__useTargeting = { pending: { itemGuid: 1, itemName: "x" } };
  assert.equal(sig().targeting, true, "a pending use-target {itemGuid, itemName} → targeting");
  assert.equal(sig().busy, false, "a pending use-target is not `busy` (the drone is idle)");
  window.__useTargeting = { pending: null };
  assert.equal(sig().targeting, false, "pending null → not targeting");
  window.__drone = { status: () => ({ ok: true, state: "flying" }) };
  assert.equal(sig().busy, true, "a running drone cycle → busy");
  assert.equal(sig().targeting, false, "a drone cycle is not `targeting`");
  delete window.__drone;
  setInWorld({ handle: { getCurrentCellId: () => 0xa9b40105 } });
  assert.equal(sig().indoors, true, "an envcell id (low 16 bits ≥ 0x100)");
  setInWorld({ handle: { isCurrentCellIndoor: () => true } });
  assert.equal(sig().indoors, true, "isCurrentCellIndoor");
  for (const [low, combat] of [[0x3c, true], [0x49, true], [0x3d, false], [0, false]]) {
    setInWorld(); window.__getCurrentStanceLow = () => (0x80000000 | low) >>> 0;
    assert.equal(sig().combat, combat, `stance low 0x${low.toString(16)}`);
  }
  setInWorld(); window.__inputFunnel = { _held: new Map([["KeyW", { key: "w" }]]) };
  assert.equal(sig().moving, true, "a held movement key");
  setInWorld(); window.__autoRunOn = true; assert.equal(sig().moving, true, "autorun");
  setInWorld({ handle: { localAutonomousMotion: () => 7 } }); assert.equal(sig().moving, true, "a server MoveTo / TurnTo");
  setInWorld({ handle: { getLocalPlayerPose: () => ({ isOnGround: false, free() {} }) } }); assert.equal(sig().moving, true, "airborne");
  setInWorld(); window.__jumpKeydownTs = 123; assert.equal(sig().moving, true, "legacy jump charge");
  setInWorld(); window.__jumpChargeActive = true; assert.equal(sig().moving, true, "wasm jump charge");
  setInWorld();
  const frees = poseFrees;
  assert.equal(sig().moving, false, "standing still");
  assert.equal(poseFrees, frees + 1, "the LocalPlayerPose box is freed");
  resetPage();
});

await check("readDeploySignals never throws (throwing getters, throwing handle methods, no window)", () => {
  const hostile = new Proxy({}, { get() { throw new Error("boom"); } });
  assert.deepEqual(hud.readDeploySignals(hostile, null), { inWorld: false });
  assert.deepEqual(hud.readDeploySignals(null, null), { inWorld: false });
  resetPage();
  setInWorld({ handle: {
    getCurrentCellId() { throw new Error("x"); }, isCurrentCellIndoor() { throw new Error("x"); },
    getLocalPlayerPose() { throw new Error("x"); }, localAutonomousMotion() { throw new Error("x"); },
  } });
  window.__film = { status() { throw new Error("x"); } };
  window.__getCurrentStanceLow = () => { throw new Error("x"); };
  const s = hud.readDeploySignals(window, { health: null });
  assert.equal(s.inWorld, true);
  assert.equal(s.indoors, false);
  assert.equal(s.combat, false);
  assert.equal(s.filmBusy, false);
  resetPage();
});

await check("readDeploySignals(win, cache, droneState): a passed state decides `busy` with no status() call; omitted (or not a string) → one __drone.status() read (SPEC §14 R2-7)", () => {
  resetPage();
  setInWorld();
  let calls = 0;
  window.__drone = { status: () => { calls += 1; return { ok: true, state: "stowing" }; } };
  assert.equal(hud.readDeploySignals(window, { health: null }, "idle").busy, false, "the state the caller just read wins");
  assert.equal(hud.readDeploySignals(window, { health: null }, "returning").busy, true);
  assert.equal(calls, 0, "no status() call when the state is passed");
  assert.equal(hud.readDeploySignals(window, { health: null }).busy, true, "omitted → __drone.status().state ('stowing')");
  assert.equal(calls, 1);
  for (const v of [null, 7, {}]) assert.equal(hud.readDeploySignals(window, { health: null }, v).busy, true, `${JSON.stringify(v)} → the status() read`);
  assert.equal(calls, 4);
  resetPage();
});

await check("dot + aria-disabled + tooltip for every refusal (moving / targeting never red on their own); never disabled", async () => {
  resetPage();
  makeHotbar();
  await withMount({}, async () => {
    const b = launcher();
    const cases = [
      ["not-in-world", () => { window.__bootState = "char-list-ready"; }, true],
      ["portal", () => { window.__isPortalSpaceActive = () => true; }, true],
      ["dead", () => { window.__pluginClient = { host: { TryGetPlayerStats: () => ({ vitals: { 1: { current: 0, max: 100 } } }) } }; }, true],
      ["film-busy", () => { window.__film = { status: () => ({ ok: true, active: false, take: { running: { mode: "take" } } }) }; }, true],
      ["indoors", () => { window.__sessionHandle = makeHandle({ isCurrentCellIndoor: () => true }); }, true],
      ["combat", () => { window.__getCurrentStanceLow = () => 0x8000003c; }, true],
      ["targeting", () => { window.__useTargeting = { pending: { itemGuid: 1, itemName: "x" } }; }, false],
      ["moving", () => { window.__inputFunnel = { _held: new Map([["KeyA", { key: "a" }]]) }; }, false],
    ];
    for (const [code, apply, red] of cases) {
      setInWorld();
      delete window.__pluginClient;
      delete window.__film;
      apply();
      await forceTick();
      assert.equal(b.dataset.state, red ? "refused" : "idle", `${code}: dot`);
      assert.equal(b.getAttribute("aria-disabled"), red ? "true" : "false", `${code}: aria-disabled`);
      assert.equal(b._hbTip().sub, hud.REFUSAL_TEXT[code], `${code}: tooltip reason`);
      assertNeverDisabled(b);
    }
    setInWorld();
    delete window.__pluginClient;
    await forceTick();
    assert.equal(b.dataset.state, "idle");
    assert.equal(b.getAttribute("aria-disabled"), "false");
    assert.equal(b._hbTip().sub, DEFAULT_TIP);
    // the 500 ms tick alone also catches a refusal appearing (no event needed)
    window.__isPortalSpaceActive = () => true;
    await tick(560);
    assert.equal(b.dataset.state, "refused", "the launcher tick polls the persistent refusals");
  });
  resetPage();
});

await check("a persistent refusal behind `targeting` still turns the dot red (refusalFor ranks a pending use-target above indoors / combat)", async () => {
  resetPage();
  makeHotbar();
  await withMount({}, async () => {
    const b = launcher();
    for (const [code, apply] of [
      ["indoors", () => { window.__sessionHandle = makeHandle({ isCurrentCellIndoor: () => true }); }],
      ["combat", () => { window.__getCurrentStanceLow = () => 0x8000003c; }],
    ]) {
      setInWorld();
      apply();
      window.__useTargeting = { pending: { itemGuid: 1, itemName: "x" } };
      assert.equal(hud.refusalFor(hud.readDeploySignals(window, { health: null })), "targeting", "targeting ranks first");
      await forceTick();
      assert.equal(b.dataset.state, "refused", `${code} behind targeting: red dot`);
      assert.equal(b.getAttribute("aria-disabled"), "true", `${code} behind targeting: aria-disabled`);
      assert.equal(b._hbTip().sub, hud.REFUSAL_TEXT.targeting, "the tooltip names the first refusal (what a click answers)");
      assertNeverDisabled(b);
    }
    setInWorld();
    window.__useTargeting = { pending: { itemGuid: 1, itemName: "x" } };
    window.__inputFunnel = { _held: new Map([["KeyW", { key: "w" }]]) };
    await forceTick();
    assert.equal(b.dataset.state, "idle", "targeting + moving alone never turn it red");
    assert.equal(b.getAttribute("aria-disabled"), "false");
  });
  resetPage();
});

await check("a click with a pending use-target: no load, no button, a red flash with 'Finish targeting first' (not 'The drone is busy')", async () => {
  resetPage();
  setInWorld();
  makeHotbar();
  const api = makeApi();
  const loader = makeLoader(api);
  await withMount({ loadDrone: loader }, async () => {
    const b = launcher();
    window.__useTargeting = { pending: { itemGuid: 1, itemName: "x" } };
    await forceTick();
    assert.equal(b.dataset.state, "idle", "not red on its own");
    const r = await window.__toggleDroneHud();
    assert.deepEqual(r, { ok: false, code: "targeting", reason: "Finish targeting first" });
    assert.equal(loader.deps.length, 0, "refused before any load");
    assert.equal(api.count("button"), 0);
    assert.equal(b.dataset.state, "refused", "red flash");
    assert.equal(b._hbTip().sub, "Finish targeting first");
    window.__useTargeting = { pending: null };
    await withNowOffset(2600, async () => {
      await forceTick();
      assert.equal(b.dataset.state, "idle", "the flash ends after 2.5 s");
      assert.equal(b._hbTip().sub, DEFAULT_TIP);
    });
  });
  resetPage();
});

await check("tooltip key = the manifest binding for drone-hud / toggle (rynth-hud's hotkeyLabel): real manifests → Shift+F11; a rebind follows", async () => {
  resetPage();
  makeHotbar();
  const dir = path.join(APP, "plugins");
  const manifests = fs.readdirSync(dir).filter((f) => f.endsWith(".manifest.json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  try {
    await withMount({}, () => {
      const b = launcher();
      const { map, duplicates } = keymap.buildManifestBindings(manifests);
      assert.deepEqual(duplicates.filter((d) => d.keyString === "Shift+F11"), [], "no other manifest claims Shift+F11");
      assert.equal(map["Shift+F11"], "drone-hud::toggle");
      keymap.setManifestBindings(map);
      assert.equal(b._hbTip().key, "Shift+F11", "from the binding");
      const rebound = { ...map };
      delete rebound["Shift+F11"];
      rebound["Ctrl+Shift+D"] = "drone-hud::toggle";
      keymap.setManifestBindings(rebound);
      const want = keymap.listManifestBindings().find((x) => x.pluginId === "drone-hud")?.keyString;
      assert.ok(want && want !== "Shift+F11", `rebound to ${want}`);
      assert.equal(b._hbTip().key, want, "the tooltip follows a rebind");
      delete rebound["Ctrl+Shift+D"];
      keymap.setManifestBindings(rebound);
      assert.equal(b._hbTip().key, "", "bindings without drone-hud → no key (rynth semantics)");
    });
  } finally {
    keymap.clearManifestBindings();
  }
  resetPage();
});

// ── [4] state listener + tooltips ──────────────────────────────────────
console.log("\n[4] hb-drone-state on document; dot and tooltip by drone state");

await check("the hb-drone-state listener is on document (not window); the dot follows the drone state", async () => {
  resetPage();
  setInWorld();
  makeHotbar();
  const api = makeApi();
  const loader = makeLoader(api);
  const before = { doc: docL.count("hb-drone-state"), win: winL.count("hb-drone-state") };
  await withMount({ loadDrone: loader }, async () => {
    assert.equal(docL.count("hb-drone-state"), before.doc + 1, "one document listener");
    assert.equal(winL.count("hb-drone-state"), before.win, "none on window");
    assert.deepEqual(await window.__droneHud.load(), { ok: true, version: "drone-1" });
    const b = launcher();
    const expect = [
      ["deploying", "busy", "Deploying — click to skip"],
      ["flying", "flying", "Flying — click to fly home (Shift: now)"],
      ["pilotView", "flying", "Flying — click to fly home (Shift: now)"],
      ["returning", "busy", "Flying home — click to recall now"],
      ["landing", "busy", "Landing…"],
      ["stowing", "busy", null],
      ["aborting", "busy", null],
      ["crashed", "busy", null],
      ["idle", "idle", "Deploy the camera drone (right-click: settings)"],
    ];
    let prev = "idle";
    for (const [state, dot, sub] of expect) {
      api.setState(state);
      document.dispatchEvent(new FakeCustomEvent("hb-drone-state", { bubbles: false, detail: { state, prev, at: 1 } }));
      prev = state;
      await settle(1);
      assert.equal(b.dataset.state, dot, `${state} → dot ${dot}`);
      assert.equal(b.classList.contains("is-active"), state !== "idle", `${state}: is-active`);
      if (sub) assert.equal(b._hbTip().sub, sub, `${state}: tooltip`);
      else assert.ok(b._hbTip().sub.length > 0 && b._hbTip().sub.length < 40, `${state}: a short tooltip`);
      assertNeverDisabled(b);
    }
    api.setRig({ kind: "no-hands", setupId: "0x0200004E", parts: 3 });
    assert.equal(b._hbTip().sub, "Deploy the camera drone (right-click: settings) · No hands: the drone launches beside you");
  });
  assert.equal(docL.count("hb-drone-state"), before.doc, "dispose removed it");
  resetPage();
});

await check("idle: a launcher tick, a tooltip read and a click read api.status() once per state read — the state is passed into readDeploySignals (SPEC §14 R2-7)", async () => {
  resetPage();
  setInWorld();
  makeHotbar();
  const api = makeApi();
  await withMount({ loadDrone: makeLoader(api) }, async () => {
    await window.__droneHud.load();
    await settle();
    const b = launcher();
    // Measured synchronously / within microtasks: the 500 ms interval cannot run in between.
    let n = api.count("status");
    document.dispatchEvent(new FakeCustomEvent("hb-drone-state", { bubbles: false, detail: { state: "idle", prev: "idle", at: 0 } }));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(api.count("status") - n, 1, "one status() per launcher tick (was 2: the tick + readDeploySignals' busy read)");
    n = api.count("status");
    assert.equal(b._hbTip().sub, DEFAULT_TIP);
    assert.equal(api.count("status") - n, 1, "one status() per tooltip read");
    n = api.count("status");
    b.dispatchEvent(new FakeEvent("click"));
    assert.equal(api.count("status") - n, 2, "a click: activate's read, then the tick after the press (was 4)");
    assert.deepEqual(api.last("button"), ["button", { shift: false }]);
  });
  resetPage();
});

await check("a click right after the drone went idle deploys: activate reads the state fresh (a 500 ms-old 'stowing' would refuse it as busy)", async () => {
  resetPage();
  setInWorld();
  makeHotbar();
  const api = makeApi();
  await withMount({ loadDrone: makeLoader(api) }, async () => {
    await window.__droneHud.load();
    const b = launcher();
    api.setState("stowing");
    await forceTick();
    assert.equal(b.dataset.state, "busy", "the last tick saw stowing");
    api.setState("idle"); // the cycle ended; no tick has run since
    const buttons = api.count("button");
    b.dispatchEvent(new FakeEvent("click"));
    await settle();
    assert.equal(api.count("button"), buttons + 1, "the press reached api.button() (deploy)");
    assert.notEqual(b.dataset.state, "refused", "no refusal flash");
    assert.equal(b._hbTip().sub, DEFAULT_TIP);
  });
  resetPage();
});

// ── [5] clicks ─────────────────────────────────────────────────────────
console.log("\n[5] clicks → api.button({shift}); refusals flash red; a failed load retries");

await check("click → loadDrone(deps) once → api.button({shift:false}); Shift+click → {shift:true}; __toggleDroneHud", async () => {
  resetPage();
  setInWorld();
  makeHotbar();
  const api = makeApi();
  const loader = makeLoader(api);
  await withMount({ loadDrone: loader }, async () => {
    const b = launcher();
    const ev = new FakeEvent("click");
    b.dispatchEvent(ev);
    assert.equal(ev._stop, true, "click stopPropagation()");
    await settle();
    assert.equal(loader.deps.length, 1, "loaded on first use");
    const deps = loader.deps[0];
    assert.equal(typeof deps.refusal, "function");
    assert.equal(typeof deps.onSignal, "function");
    assert.equal(typeof deps.broadcastPose, "function");
    assert.deepEqual(api.last("button"), ["button", { shift: false }]);
    const sev = new FakeEvent("click");
    sev.shiftKey = true;
    b.dispatchEvent(sev);
    await settle();
    assert.deepEqual(api.last("button"), ["button", { shift: true }]);
    assert.equal(loader.deps.length, 1, "memoised: no second load");
    assert.equal(typeof window.__toggleDroneHud, "function");
    const r = await window.__toggleDroneHud();
    assert.deepEqual(api.last("button"), ["button", { shift: false }], "Shift+F11 = the button (no shift)");
    assert.equal(r.ok, true);
    assert.equal(api.count("button"), 3);
  });
  resetPage();
});

await check("idle + a refusal: no load, no button, the dot flashes red for 2.5 s with the reason", async () => {
  resetPage();
  setInWorld();
  makeHotbar();
  const api = makeApi();
  const loader = makeLoader(api);
  await withMount({ loadDrone: loader }, async () => {
    const b = launcher();
    window.__inputFunnel = { _held: new Map([["KeyW", { key: "w" }]]) }; // moving: not red on its own
    await forceTick();
    assert.equal(b.dataset.state, "idle");
    b.dispatchEvent(new FakeEvent("click"));
    await settle();
    assert.equal(loader.deps.length, 0, "refused before any load");
    assert.equal(api.count("button"), 0);
    assert.equal(b.dataset.state, "refused", "red flash");
    assert.equal(b._hbTip().sub, "Stand still to deploy");
    window.__inputFunnel = { _held: new Map() };
    await forceTick();
    assert.equal(b.dataset.state, "refused", "still flashing within 2.5 s");
    assert.equal(b._hbTip().sub, "Stand still to deploy", "the flash reason while nothing is current");
    await withNowOffset(2600, async () => {
      await forceTick();
      assert.equal(b.dataset.state, "idle", "the flash ends after 2.5 s");
      assert.equal(b._hbTip().sub, DEFAULT_TIP);
    });
    // a persistent refusal: no load either
    window.__getCurrentStanceLow = () => 0x8000003c;
    const r = await window.__toggleDroneHud();
    assert.deepEqual(r, { ok: false, code: "combat", reason: "Leave combat mode first" });
    assert.equal(loader.deps.length, 0);
  });
  resetPage();
});

await check("an api refusal `covered` (index.js's open-sky check, phase 4 F1): a red flash with 'Needs open sky above you', never persistent", async () => {
  resetPage();
  setInWorld();
  makeHotbar();
  const api = makeApi();
  api.button = (o) => {
    api.calls.push(["button", o]);
    return { ok: false, code: "covered", reason: "Needs open sky above you", action: "deploy" };
  };
  const loader = makeLoader(api);
  await withMount({ loadDrone: loader }, async () => {
    const b = launcher();
    await forceTick();
    assert.equal(b.dataset.state, "idle", "no page signal says covered before the click");
    b.dispatchEvent(new FakeEvent("click"));
    await settle();
    assert.equal(loader.deps.length, 1, "the plugin's own checks pass: the module loads");
    assert.deepEqual(api.last("button"), ["button", { shift: false }]);
    assert.equal(b.dataset.state, "refused", "red flash");
    assert.equal(b.getAttribute("aria-disabled"), "false", "not a persistent refusal");
    assert.equal(b._hbTip().sub, "Needs open sky above you");
    await forceTick();
    assert.equal(b.dataset.state, "refused", "still flashing within 2.5 s");
    await withNowOffset(2600, async () => {
      await forceTick();
      assert.equal(b.dataset.state, "idle", "the flash ends after 2.5 s");
      assert.equal(b.getAttribute("aria-disabled"), "false");
      assert.equal(b._hbTip().sub, DEFAULT_TIP);
    });
  });
  resetPage();
});

await check("non-idle states skip the refusal check (a moving pilot can still recall)", async () => {
  resetPage();
  setInWorld();
  makeHotbar();
  const api = makeApi();
  const loader = makeLoader(api);
  await withMount({ loadDrone: loader }, async () => {
    await window.__droneHud.load();
    api.setState("flying");
    window.__inputFunnel = { _held: new Map([["KeyW", { key: "w" }]]) };
    window.__getCurrentStanceLow = () => 0x8000003c;
    const ev = new FakeEvent("click");
    ev.shiftKey = true;
    launcher().dispatchEvent(ev);
    await settle();
    assert.deepEqual(api.last("button"), ["button", { shift: true }]);
  });
  resetPage();
});

await check("a failed load clears the memo (the next click retries) and flashes red (busy)", async () => {
  resetPage();
  setInWorld();
  makeHotbar();
  const api = makeApi();
  const loader = makeLoader(api, { failFirst: 1 });
  const { warns } = await captureWarns(() => withMount({ loadDrone: loader }, async () => {
    const b = launcher();
    b.dispatchEvent(new FakeEvent("click"));
    await settle();
    assert.equal(loader.deps.length, 1);
    assert.equal(api.count("button"), 0);
    assert.equal(b.dataset.state, "refused", "red flash on a failed load");
    assert.equal(b._hbTip().sub, "The drone is busy");
    b.dispatchEvent(new FakeEvent("click"));
    await settle();
    assert.equal(loader.deps.length, 2, "retried");
    assert.deepEqual(api.last("button"), ["button", { shift: false }]);
  }));
  assert.equal(warns.filter((w) => w.startsWith("[drone] ")).length, 1, "one [drone] warn");
  resetPage();
});

await check("an api refusal from button() flashes red with its reason; deps.refusal / deps.broadcastPose read the page", async () => {
  resetPage();
  setInWorld();
  makeHotbar();
  const api = makeApi();
  api.button = (o) => { api.calls.push(["button", o]); return { ok: false, code: "not-in-world", reason: "Enter the world first" }; };
  const loader = makeLoader(api);
  await withMount({ loadDrone: loader }, async () => {
    const b = launcher();
    b.dispatchEvent(new FakeEvent("click"));
    await settle();
    assert.equal(b.dataset.state, "refused");
    const deps = loader.deps[0];
    assert.equal(deps.refusal(), null, "clear");
    window.__getCurrentStanceLow = () => 0x8000003c;
    assert.equal(deps.refusal(), "combat");
    window.__getCurrentStanceLow = () => 0x8000003d;
    window.__useTargeting = { pending: { itemGuid: 1, itemName: "x" } };
    assert.equal(deps.refusal(), "targeting", "index.js gets `targeting` for a pending use-target (its own table has the text)");
    window.__useTargeting = { pending: null };
    api.setState("flying");
    assert.equal(deps.refusal(), "busy", "deps.refusal() reads the drone state itself (no state passed)");
    api.setState("idle");
    const route = [];
    window.__routeSlashCommand = (h, m) => { route.push([h, m]); return { dispatched: true, echo: "You read." }; };
    window.__sessionHandle.resolveSoulEmote = () => ({ free() {} });
    window.__appendChatLine = () => {};
    assert.deepEqual(deps.broadcastPose(), { ok: true, echo: "You read." });
    assert.equal(route[0][1], "/read");
  });
  resetPage();
});

// ── [6] bus ────────────────────────────────────────────────────────────
console.log("\n[6] the plugin bus: late bind, edges forwarded through deps.onSignal");

function makeBus() {
  const listeners = new Map();
  return {
    on(n, fn) { if (!listeners.has(n)) listeners.set(n, new Set()); listeners.get(n).add(fn); },
    off(n, fn) { listeners.get(n)?.delete(fn); },
    emit(n, detail) { for (const fn of [...(listeners.get(n) || [])]) fn(new FakeCustomEvent(n, { detail })); },
    count(n) { return listeners.get(n)?.size ?? 0; },
    total() { let t = 0; for (const s of listeners.values()) t += s.size; return t; },
  };
}

await check("binds late through a pending __pluginClientReady; forwards damage / death (self only) / portal to every sink", async () => {
  resetPage();
  setInWorld();
  makeHotbar();
  let resolveClient;
  window.__pluginClientReady = new Promise((r) => { resolveClient = r; });
  const api = makeApi();
  const loader = makeLoader(api);
  await withMount({ loadDrone: loader }, async () => {
    await window.__droneHud.load();
    const deps = loader.deps[0];
    const a = [];
    const b = [];
    const offA = deps.onSignal((name, detail) => a.push([name, detail]));
    deps.onSignal(() => { throw new Error("a throwing sink"); });
    deps.onSignal((name, detail) => b.push([name, detail]));
    assert.equal(typeof deps.onSignal(null), "function", "a non-function listener gets a no-op unsubscribe");
    const bus = makeBus();
    const client = { events: bus };
    window.__pluginClient = client; // index.html assigns it, then resolves the promise
    resolveClient(client);
    await settle();
    for (const n of ["vitalChangedHealth", "damageTaken", "death", "portalSpaceEntered", "landblockChanged"]) {
      assert.equal(bus.count(n), 1, `${n} subscribed once`);
    }
    bus.emit("vitalChangedHealth", { current: 100, buffedMax: 100, oldValue: undefined }); // spawn hydrate
    assert.deepEqual(a, [], "no edge on the hydrate");
    bus.emit("vitalChangedHealth", { current: 80, buffedMax: 100, oldValue: 100 });
    assert.deepEqual(a.map((x) => x[0]), ["damage"]);
    assert.equal(a[0][1].current, 80, "detail forwarded");
    bus.emit("vitalChangedHealth", { current: 70, buffedMax: 90, oldValue: 80 }); // a buff ran out: max dropped
    assert.deepEqual(a.map((x) => x[0]), ["damage"], "a lower max is not damage");
    bus.emit("vitalChangedHealth", { current: 0, buffedMax: 90, oldValue: 70 });
    assert.deepEqual(a.map((x) => x[0]), ["damage", "damage", "death"]);
    bus.emit("damageTaken", { attackerName: "Drudge", damage: 5 });
    bus.emit("death", { victimGuid: 0x50000099, killerGuid: PLAYER, message: "You killed it" });
    bus.emit("death", { victimGuid: PLAYER, killerGuid: 0x50000099, message: "You died" });
    bus.emit("portalSpaceEntered", { teleportSeq: 3 });
    bus.emit("landblockChanged", { prevLb: 1, lbId: 2 });
    assert.deepEqual(a.map((x) => x[0]), ["damage", "damage", "death", "damage", "death", "portal", "landblock"]);
    assert.deepEqual(b.map((x) => x[0]), a.map((x) => x[0]), "every sink gets every edge (a throwing one is isolated)");
    assert.deepEqual(a[5][1], { teleportSeq: 3 });
    // the cached health drives the dead refusal
    assert.equal(deps.refusal(), "dead");
    bus.emit("vitalChangedHealth", { current: 90, buffedMax: 90, oldValue: 0 });
    assert.equal(deps.refusal(), null);
    assert.equal(a.length, 7, "a recovery (current > oldValue) is no edge");
    offA();
    bus.emit("portalSpaceEntered", { teleportSeq: 4 });
    assert.equal(a.length, 7, "an unsubscribed sink gets nothing more");
    assert.equal(b.length, 8);
    assert.deepEqual(b[7], ["portal", { teleportSeq: 4 }]);
  });
  resetPage();
});

await check("dispose unsubscribes the bus; a dispose before login never subscribes; a client at mount binds at once", async () => {
  resetPage();
  makeHotbar();
  // client present at mount
  const bus = makeBus();
  await withMount({ client: { events: bus } }, () => {
    assert.equal(bus.total(), 5, "subscribed at mount");
  });
  assert.equal(bus.total(), 0, "dispose → events.off for every handler");
  // disposed before the login resolves
  let resolveClient;
  window.__pluginClientReady = new Promise((r) => { resolveClient = r; });
  const bus2 = makeBus();
  const dispose = hud.mount({ client: null });
  dispose();
  resolveClient({ events: bus2 });
  await settle();
  assert.equal(bus2.total(), 0, "never subscribed after dispose");
  resetPage();
});

await check("vitalChangedHealth with no earlier max on record: a drop is damage (max taken as unchanged); a regen is not", async () => {
  resetPage();
  makeHotbar();
  const bus = makeBus();
  const loader = makeLoader(makeApi());
  await withMount({ client: { events: bus }, loadDrone: loader }, async () => {
    await window.__droneHud.load();
    const got = [];
    loader.deps[0].onSignal((name) => got.push(name));
    bus.emit("vitalChangedHealth", { current: 60, buffedMax: 100, oldValue: 75 }); // the first event the plugin sees is a hit
    assert.deepEqual(got, ["damage"]);
    bus.emit("vitalChangedHealth", { current: 70, buffedMax: 100, oldValue: 60 });
    assert.deepEqual(got, ["damage"], "a regen is no edge");
    bus.emit("vitalChangedHealth", { current: "x", buffedMax: 100, oldValue: 70 });
    assert.deepEqual(got, ["damage"], "a non-numeric payload is ignored");
  });
  resetPage();
});

// ── [7] settings popover ───────────────────────────────────────────────
console.log("\n[7] settings popover (right-click, kit look, Escape / outside press / close)");

await check("right-click opens the kit popover (preventDefault), renders api.settings(), writes setSettings and re-renders", async () => {
  resetPage();
  setInWorld();
  makeHotbar();
  const api = makeApi();
  api.setStored({ batteryMin: 30 }); // outside the popover's choices
  const loader = makeLoader(api);
  await withMount({ loadDrone: loader }, async () => {
    const b = launcher();
    const ev = new FakeEvent("contextmenu");
    b.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true, "contextmenu preventDefault");
    assert.equal(ev._stop, true, "and stopPropagation");
    const pop = popover();
    assert.ok(pop, "#hb-drone-hud-settings");
    assert.ok(pop.classList.contains("hbk-window"));
    assert.equal(pop.parentNode, document.body);
    assert.equal(pop.dataset.open, "1");
    assert.equal(q(".hbk-titlebar .hbk-title", pop).textContent, "Drone");
    assert.ok(q(".hbk-close", pop));
    await settle();
    assert.equal(loader.deps.length, 1, "the popover loads the drone module");
    assert.ok(api.count("settings") >= 1, "rendered from api.settings()");
    const ctl = (k) => q(`[data-key='${k}']`, pop);
    assert.equal(ctl("mode").tagName, "SELECT");
    assert.ok(ctl("mode").classList.contains("hbk-select"));
    assert.equal(ctl("mode").value, "cine");
    for (const k of ["quickDeploy", "invertY", "crash", "broadcastPose"]) {
      assert.ok(ctl(k).classList.contains("hbk-check"), `${k} is a kit check`);
      assert.equal(ctl(k).checked, DEFAULT_SETTINGS[k], `${k} rendered`);
    }
    for (const k of ["volume", "sensitivity", "rangeM"]) assert.ok(ctl(k).classList.contains("hbk-range"), `${k} is a kit range`);
    assert.equal(ctl("sensitivity").min, "0.25");
    assert.equal(ctl("sensitivity").max, "3");
    assert.equal(ctl("rangeM").min, "50");
    assert.equal(ctl("rangeM").max, "180");
    assert.equal(ctl("rangeM").value, "150");
    assert.equal(ctl("batteryMin").value, "30", "an off-list stored value is shown, not lost");
    const vals = [...pop.querySelectorAll(".dhud-val")].map((e) => e.textContent);
    assert.deepEqual(vals, ["60%", "1.00×", "150 m"]);
    assert.equal(b.classList.contains("is-active"), true, "launcher active while the popover is open");
    assert.match(pop.style.left, /^-?\d+px$/);
    assert.match(pop.style.top, /^-?\d+px$/);
    // writes
    ctl("mode").value = "acro";
    ctl("mode").dispatchEvent(new FakeEvent("change"));
    assert.deepEqual(api.last("setSettings"), ["setSettings", { mode: "acro" }]);
    ctl("quickDeploy").checked = true;
    ctl("quickDeploy").dispatchEvent(new FakeEvent("change"));
    assert.deepEqual(api.last("setSettings"), ["setSettings", { quickDeploy: true }]);
    ctl("sensitivity").value = "1.25";
    ctl("sensitivity").dispatchEvent(new FakeEvent("input"));
    assert.equal(q(".dhud-val", ctl("sensitivity").parentNode).textContent, "1.25×", "label follows the drag");
    ctl("sensitivity").dispatchEvent(new FakeEvent("change"));
    assert.deepEqual(api.last("setSettings"), ["setSettings", { sensitivity: 1.25 }]);
    assert.equal(ctl("sensitivity").value, "1.3", "re-rendered from the setSettings result");
    ctl("batteryMin").value = "5";
    ctl("batteryMin").dispatchEvent(new FakeEvent("change"));
    assert.deepEqual(api.last("setSettings"), ["setSettings", { batteryMin: 5 }], "numeric select writes a number");
    // a refused write shows the reason and re-renders from the API
    ctl("rangeM").value = "999";
    ctl("rangeM").dispatchEvent(new FakeEvent("change"));
    const msg = q(".dhud-msg", pop);
    assert.equal(msg.textContent, "rangeM must be within [20, 180]");
    assert.equal(msg.dataset.kind, "error");
    assert.equal(ctl("rangeM").value, "150", "re-rendered from api.settings()");
  });
  assert.equal(popover(), null, "dispose removed the popover");
  resetPage();
});

await check("Escape (preventDefault), an outside press and the titlebar close all close it; right-click toggles", async () => {
  resetPage();
  setInWorld();
  makeHotbar();
  const api = makeApi();
  const before = { key: winL.count("keydown"), down: winL.count("mousedown", true), pdown: winL.count("pointerdown", true) };
  await withMount({ loadDrone: makeLoader(api) }, async () => {
    const b = launcher();
    // The outside-press closers are armed ONCE at mount (SPEC §14 R2-4); only Escape follows the popover.
    assert.equal(winL.count("mousedown", true), before.down + 1, "window-capture mousedown present after mount");
    assert.equal(winL.count("pointerdown", true), before.pdown + 1, "window-capture pointerdown present after mount");
    assert.equal(winL.count("keydown"), before.key, "no Escape listener while closed");
    document.body.dispatchEvent(new FakeEvent("pointerdown"));
    document.body.dispatchEvent(new FakeEvent("mousedown"));
    assert.equal(popover(), null, "a press before the popover exists is a no-op");
    b.dispatchEvent(new FakeEvent("contextmenu"));
    await settle();
    const pop = popover();
    assert.equal(winL.count("keydown"), before.key + 1, "Escape listener while open");
    assert.equal(winL.count("mousedown", true), before.down + 1, "opening adds no second mousedown closer");
    assert.equal(winL.count("pointerdown", true), before.pdown + 1, "opening adds no second pointerdown closer");
    const other = new FakeEvent("keydown", { key: "a" });
    window.dispatchEvent(other);
    assert.equal(pop.dataset.open, "1");
    assert.equal(other.defaultPrevented, false, "other keys untouched");
    const esc = new FakeEvent("keydown", { key: "Escape" });
    window.dispatchEvent(esc);
    assert.equal(pop.dataset.open, "0", "Escape closed it");
    assert.equal(esc.defaultPrevented, true, "consumed for escape_action");
    assert.equal(winL.count("keydown"), before.key, "the Escape listener is removed on close");
    assert.equal(winL.count("mousedown", true), before.down + 1, "the outside-press closers stay armed after a close");
    assert.equal(winL.count("pointerdown", true), before.pdown + 1);
    document.body.dispatchEvent(new FakeEvent("mousedown"));
    assert.equal(pop.dataset.open, "0", "a press while closed changes nothing");
    await tick(0);
    assert.equal(b.classList.contains("is-active"), false);
    // outside press
    b.dispatchEvent(new FakeEvent("contextmenu"));
    q("select", pop).dispatchEvent(new FakeEvent("mousedown"));
    assert.equal(pop.dataset.open, "1", "a press inside keeps it open");
    b.dispatchEvent(new FakeEvent("mousedown"));
    assert.equal(pop.dataset.open, "1", "a press on the launcher keeps it open");
    document.body.dispatchEvent(new FakeEvent("mousedown"));
    assert.equal(pop.dataset.open, "0", "an outside press closed it");
    // a cancelled pointerdown (picking.js on an entity pick) sends no mousedown: the pointerdown alone closes it
    b.dispatchEvent(new FakeEvent("contextmenu"));
    q("select", pop).dispatchEvent(new FakeEvent("pointerdown"));
    b.dispatchEvent(new FakeEvent("pointerdown"));
    assert.equal(pop.dataset.open, "1", "a pointerdown inside or on the launcher keeps it open");
    document.body.dispatchEvent(new FakeEvent("pointerdown"));
    assert.equal(pop.dataset.open, "0", "an outside pointerdown closed it (no mousedown needed)");
    // titlebar close
    b.dispatchEvent(new FakeEvent("contextmenu"));
    q(".hbk-close", pop).dispatchEvent(new FakeEvent("click"));
    assert.equal(pop.dataset.open, "0", "the close button closed it");
    // right-click toggles
    b.dispatchEvent(new FakeEvent("contextmenu"));
    assert.equal(pop.dataset.open, "1");
    b.dispatchEvent(new FakeEvent("contextmenu"));
    assert.equal(pop.dataset.open, "0");
    b.dispatchEvent(new FakeEvent("contextmenu")); // left open for dispose
  });
  assert.equal(winL.count("keydown"), before.key, "dispose removed the open popover's Escape listener");
  assert.equal(winL.count("mousedown", true), before.down, "dispose removed the outside-press closers");
  assert.equal(winL.count("pointerdown", true), before.pdown);
  resetPage();
});

await check("a popover opened after the drone lock still closes on a canvas press: its closers (armed at mount) run before the lock's capture blockers (SPEC §14 R2-4)", async () => {
  resetPage();
  setInWorld();
  makeHotbar();
  const api = makeApi();
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  await withMount({ loadDrone: makeLoader(api) }, async () => {
    await window.__droneHud.load();
    const b = launcher();
    api.setState("flying");
    const lock = installLockBlocker(canvas); // the deploy click locks input AFTER the mount
    try {
      b.dispatchEvent(new FakeEvent("contextmenu")); // opened mid-cycle
      await settle();
      const pop = popover();
      assert.equal(pop.dataset.open, "1");
      for (const type of ["pointerdown", "mousedown"]) {
        if (pop.dataset.open !== "1") { b.dispatchEvent(new FakeEvent("contextmenu")); await settle(); }
        const ev = windowCapturePress(type, canvas);
        assert.equal(pop.dataset.open, "0", `a canvas ${type} closed it`);
        assert.equal(ev.immediateStopped, true, `the lock still swallowed the ${type} (the client never sees it)`);
        assert.equal(ev.defaultPrevented, true);
      }
      assert.deepEqual(lock.seen, ["pointerdown", "mousedown"], "the blocker ran after the closer");
      const n = lock.seen.length;
      windowCapturePress("pointerdown", canvas);
      assert.equal(lock.seen.length, n + 1, "while closed the closer is a no-op and the lock blocks as before");
      assert.equal(pop.dataset.open, "0");
    } finally {
      lock.remove();
    }
  });
  canvas.remove();
  resetPage();
});

await check("closing the popover blurs a control left focused inside it (a focused SELECT / INPUT makes the funnel defer every key)", async () => {
  resetPage();
  setInWorld();
  makeHotbar();
  await withMount({ loadDrone: makeLoader(makeApi()) }, async () => {
    const b = launcher();
    const closers = [
      ["Escape", () => window.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }))],
      ["titlebar close", () => q(".hbk-close", popover()).dispatchEvent(new FakeEvent("click"))],
      ["right-click toggle", () => b.dispatchEvent(new FakeEvent("contextmenu"))],
    ];
    for (const [how, close] of closers) {
      b.dispatchEvent(new FakeEvent("contextmenu"));
      await settle();
      const sel = q("[data-key='mode']", popover());
      sel.focus(); // a select opened and closed without a change keeps focus
      assert.equal(document.activeElement, sel);
      close();
      assert.equal(popover().dataset.open, "0", `${how} closed it`);
      assert.notEqual(document.activeElement, sel, `${how}: focus left the hidden popover`);
    }
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    b.dispatchEvent(new FakeEvent("contextmenu"));
    outside.focus();
    window.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }));
    assert.equal(popover().dataset.open, "0");
    assert.equal(document.activeElement, outside, "a focus outside the popover is left alone");
    outside.remove();
  });
  resetPage();
});

await check("the popover rows are the §3.11 list in order (kit controls, slider bounds, battery Off / 5 / 10 / 15 / 20 min)", async () => {
  resetPage();
  setInWorld();
  makeHotbar();
  await withMount({ loadDrone: makeLoader(makeApi()) }, async () => {
    launcher().dispatchEvent(new FakeEvent("contextmenu"));
    await settle();
    const pop = popover();
    assert.deepEqual([...pop.querySelectorAll(".dhud-row-label")].map((e) => e.textContent),
      ["Flight mode", "Quick deploy", "Invert mouse Y", "Crashes", "Show /read to others", "Motor volume", "Mouse sensitivity", "Range", "Battery"]);
    const opts = (k) => [...q(`[data-key='${k}']`, pop).children].map((o) => [o.value, o.textContent]);
    assert.deepEqual(opts("mode"), [["cine", "Cine"], ["angle", "Angle"], ["acro", "Acro"]]);
    assert.deepEqual(opts("batteryMin"), [["0", "Off"], ["5", "5 min"], ["10", "10 min"], ["15", "15 min"], ["20", "20 min"]]);
    const bounds = (k) => { const c = q(`[data-key='${k}']`, pop); return [c.min, c.max]; };
    assert.deepEqual(bounds("sensitivity"), ["0.25", "3"]);
    assert.deepEqual(bounds("rangeM"), ["50", "180"]);
    assert.deepEqual(bounds("volume"), ["0", "1"]);
  });
  resetPage();
});

// ── [8] idle prewarm ───────────────────────────────────────────────────
console.log("\n[8] the one idle prewarm per page");

await check("armed at mount; fires on holtburger:state 'ready' via requestIdleCallback({timeout: 5000}), exactly once", async () => {
  resetPage();
  makeHotbar();
  const idle = [];
  window.requestIdleCallback = (fn, opts) => { idle.push({ fn, opts }); return idle.length; };
  window.cancelIdleCallback = () => {};
  let runs = 0;
  const prewarm = async () => { runs += 1; return { ok: true, compiled: 4, ms: 2 }; };
  const before = winL.count("holtburger:state");
  await withMount({ prewarm }, async () => {
    assert.equal(idle.length, 0, "not before the scene is ready");
    assert.equal(winL.count("holtburger:state"), before + 1, "listening for the ready state");
    assert.deepEqual(await window.__droneHud.prewarm(), { ok: false, compiled: 0, ms: 0, reason: "the scene is not ready" });
    assert.equal(runs, 0, "a public prewarm before ready does not consume the one shot");
    window.dispatchEvent(new FakeCustomEvent("holtburger:state", { detail: { state: "in-world" } }));
    assert.equal(idle.length, 0, "'in-world' is not 'ready'");
    window.__sceneReadyEverFired = true;
    window.dispatchEvent(new FakeCustomEvent("holtburger:state", { detail: { state: "ready" } }));
    assert.equal(idle.length, 1, "scheduled in idle time");
    assert.deepEqual(idle[0].opts, { timeout: 5000 });
    assert.equal(winL.count("holtburger:state"), before, "listener dropped once armed");
    window.dispatchEvent(new FakeCustomEvent("holtburger:state", { detail: { state: "ready" } }));
    assert.equal(idle.length, 1);
    idle[0].fn();
    await settle();
    assert.equal(runs, 1);
    assert.deepEqual(await window.__droneHud.prewarm(), { ok: true, compiled: 4, ms: 2 }, "the memoised result");
    assert.equal(runs, 1, "exactly one per page");
  });
  resetPage();
});

await check("latched at mount without requestIdleCallback → setTimeout(2000) fallback; a failure is one [drone] warn", async () => {
  resetPage();
  makeHotbar();
  window.__sceneReadyEverFired = true;
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  let runs = 0;
  const prewarm = async () => { runs += 1; throw new Error("no renderer"); };
  const { warns } = await captureWarns(async () => {
    let dispose;
    globalThis.setTimeout = (fn, ms, ...rest) => { timers.push(ms); return realSetTimeout(fn, ms === 2000 ? 0 : ms, ...rest); };
    try { dispose = hud.mount({ client: null, prewarm }); } finally { globalThis.setTimeout = realSetTimeout; }
    try {
      assert.ok(timers.includes(2000), `setTimeout(run, 2000) scheduled (got ${timers})`);
      await settle(6);
      assert.equal(runs, 1);
      const r = await window.__droneHud.prewarm();
      assert.equal(r.ok, false);
      assert.equal(r.reason, "no renderer");
      assert.equal(runs, 1);
    } finally { dispose(); }
  });
  assert.equal(warns.filter((w) => w.startsWith("[drone] ")).length, 1, "one [drone] warn");
  resetPage();
});

// ── [9] default (computed-URL) loader and prewarm ──────────────────────
console.log("\n[9] the default loaders: new URL(…, location.href) dynamic imports (temp-dir fakes)");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "drone-hud-test-"));
try {
  const okDir = path.join(TMP, "ok");
  fs.mkdirSync(path.join(okDir, "scene3d", "drone"), { recursive: true });
  fs.writeFileSync(path.join(okDir, "scene3d", "drone", "index.js"),
    "export const calls = [];\n" +
    "export async function installDrone(deps) { calls.push(deps); const api = globalThis.__hudTestApi; globalThis.window.__drone = api; return api; }\n");
  fs.writeFileSync(path.join(okDir, "scene3d", "drone", "props.js"),
    "export const calls = [];\n" +
    "export async function prewarm(deps) { calls.push(deps); return { ok: true, compiled: 7, ms: 3 }; }\n");
  fs.mkdirSync(path.join(TMP, "empty"), { recursive: true });

  await check("no ctx.loadDrone: imports <page>/scene3d/drone/index.js and calls installDrone(deps) once", async () => {
    resetPage();
    setInWorld();
    makeHotbar();
    const api = makeApi();
    globalThis.__hudTestApi = api;
    globalThis.location.href = pathToFileURL(path.join(okDir, "index.html")).href;
    await withMount({}, async () => {
      assert.deepEqual(await window.__droneHud.load(), { ok: true, version: "drone-1" });
      assert.deepEqual(await window.__droneHud.load(), { ok: true, version: "drone-1" });
      const m = await import(pathToFileURL(path.join(okDir, "scene3d", "drone", "index.js")).href);
      assert.equal(m.calls.length, 1, "installDrone once (memoised)");
      const deps = m.calls[0];
      assert.deepEqual(Object.keys(deps).sort(), ["broadcastPose", "onSignal", "refusal"]);
      launcher().dispatchEvent(new FakeEvent("click"));
      await settle();
      assert.deepEqual(api.last("button"), ["button", { shift: false }]);
    });
    delete globalThis.__hudTestApi;
    resetPage();
  });

  await check("a failed default import → {ok:false, code:'not-available'} and the next load retries", async () => {
    resetPage();
    setInWorld();
    makeHotbar();
    globalThis.location.href = pathToFileURL(path.join(TMP, "empty", "index.html")).href;
    await captureWarns(() => withMount({}, async () => {
      const r1 = await window.__droneHud.load();
      assert.equal(r1.ok, false);
      assert.equal(r1.code, "not-available");
      const b = launcher();
      b.dispatchEvent(new FakeEvent("click"));
      await settle();
      assert.equal(b.dataset.state, "refused", "a failed load flashes red");
      globalThis.__hudTestApi = makeApi();
      globalThis.location.href = pathToFileURL(path.join(okDir, "index.html")).href;
      const r2 = await window.__droneHud.load();
      assert.equal(r2.ok, true, "the memo was cleared");
    }));
    delete globalThis.__hudTestApi;
    resetPage();
  });

  await check("no ctx.prewarm: import('three') + <page>/scene3d/drone/props.js → prewarm({THREE, renderer, scene, camera, offscreen})", async () => {
    resetPage();
    makeHotbar();
    window.__sceneReadyEverFired = true;
    const idle = [];
    window.requestIdleCallback = (fn, opts) => { idle.push({ fn, opts }); return 1; };
    window.liveScene3d = { renderer: { tag: "r" }, scene: { tag: "s" }, camera: { tag: "c" }, wireframeMode: true };
    globalThis.location.href = pathToFileURL(path.join(okDir, "index.html")).href;
    await withMount({}, async () => {
      assert.equal(idle.length, 1);
      idle[0].fn();
      const r = await window.__droneHud.prewarm();
      assert.deepEqual(r, { ok: true, compiled: 7, ms: 3 });
      const m = await import(pathToFileURL(path.join(okDir, "scene3d", "drone", "props.js")).href);
      assert.equal(m.calls.length, 1);
      const d = m.calls[0];
      assert.equal(typeof d.THREE.WebGLRenderTarget, "function", "the real three module");
      assert.equal(d.renderer, window.liveScene3d.renderer);
      assert.equal(d.scene, window.liveScene3d.scene);
      assert.equal(d.camera, window.liveScene3d.camera);
      assert.equal(d.offscreen, false, "offscreen = !wireframeMode");
    });
    resetPage();
  });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

// ── [10] /read ─────────────────────────────────────────────────────────
console.log("\n[10] broadcastReadEmote (§6.9)");

await check("broadcastReadEmote: every refusal path, the probe is freed, the echo is printed at EMOTE (4)", () => {
  assert.deepEqual(hud.broadcastReadEmote({}), { ok: false, error: "Enter the world first." });
  assert.deepEqual(hud.broadcastReadEmote(null), { ok: false, error: "Enter the world first." });
  const routed = [];
  const chat = [];
  const route = (h, m) => { routed.push(m); return { dispatched: true, echo: "You pull out a book." }; };
  assert.deepEqual(hud.broadcastReadEmote({ __sessionHandle: {}, __routeSlashCommand: route }),
    { ok: false, error: "Emotes need a newer client build." });
  assert.deepEqual(hud.broadcastReadEmote({ __sessionHandle: { resolveSoulEmote: () => undefined }, __routeSlashCommand: route }),
    { ok: false, error: "/read is not available yet." });
  assert.deepEqual(hud.broadcastReadEmote({ __sessionHandle: { resolveSoulEmote() { throw new Error("x"); } }, __routeSlashCommand: route }),
    { ok: false, error: "/read is not available yet." });
  assert.equal(routed.length, 0, "an unknown token never goes out");
  let freed = 0;
  const handle = { resolveSoulEmote: (t) => (t === "read" ? { free() { freed += 1; } } : undefined) };
  const win = { __sessionHandle: handle, __routeSlashCommand: route, __appendChatLine: (t, c) => chat.push([t, c]) };
  assert.deepEqual(hud.broadcastReadEmote(win), { ok: true, echo: "You pull out a book." });
  assert.deepEqual(routed, ["/read"]);
  assert.equal(freed, 1, "the SoulEmoteResolution probe is freed");
  assert.deepEqual(chat, [["You pull out a book.", 4]]);
  win.__routeSlashCommand = () => ({ dispatched: true, echo: null, error: "/read: nope" });
  assert.deepEqual(hud.broadcastReadEmote(win), { ok: false, error: "/read: nope" });
  win.__routeSlashCommand = () => ({ dispatched: false });
  assert.deepEqual(hud.broadcastReadEmote(win), { ok: false, error: "/read is not available." });
  win.__routeSlashCommand = () => { throw new Error("wire down"); };
  assert.deepEqual(hud.broadcastReadEmote(win), { ok: false, error: "wire down" });
  win.__routeSlashCommand = () => ({ dispatched: true, echo: null });
  assert.deepEqual(hud.broadcastReadEmote(win), { ok: true, echo: null });
  assert.equal(chat.length, 1, "no echo → nothing printed");
});

// ── [11] lifecycle ─────────────────────────────────────────────────────
console.log("\n[11] globals and dispose");

await check("__toggleDroneHud / frozen __droneHud {load, prewarm} installed; dispose removes everything and stops the tick", async () => {
  resetPage();
  setInWorld();
  makeHotbar();
  const before = { win: winL.total(), doc: docL.total() };
  const api = makeApi();
  const dispose = hud.mount({ client: null, loadDrone: makeLoader(api) });
  assert.equal(typeof window.__toggleDroneHud, "function");
  assert.ok(Object.isFrozen(window.__droneHud));
  assert.deepEqual(Object.keys(window.__droneHud).sort(), ["load", "prewarm"]);
  await window.__droneHud.load();
  launcher().dispatchEvent(new FakeEvent("contextmenu"));
  await settle();
  dispose();
  assert.equal(window.__toggleDroneHud, undefined);
  assert.equal(window.__droneHud, undefined);
  assert.equal(launcher(), null);
  assert.equal(popover(), null);
  assert.equal(document.getElementById("hb-drone-hud-launcher-float"), null);
  assert.equal(document.getElementById("hb-drone-hud-style"), null);
  assert.deepEqual({ win: winL.total(), doc: docL.total() }, before, "window / document listeners back to baseline");
  const statusCalls = api.count("status");
  await tick(600);
  assert.equal(api.count("status"), statusCalls, "the 500 ms launcher tick stopped");
  // a fresh mount works again, and the first disposer is idempotent (it never touches the newer mount)
  await withMount({ loadDrone: makeLoader(api) }, () => {
    assert.ok(launcher());
    dispose();
    assert.ok(launcher(), "a second call of an old disposer is a no-op");
    assert.equal(typeof window.__toggleDroneHud, "function");
  });
  resetPage();
});

// ── [12] module surface, I-27, manifest, index ─────────────────────────
console.log("\n[12] exports, I-27 imports, manifest, generated index");

await check("exports exactly the §3.11 surface (+ default {mount})", () => {
  assert.deepEqual(Object.keys(hud).sort(),
    ["DRONE_DEFAULT_ON", "REFUSAL_TEXT", "broadcastReadEmote", "default", "droneHudEnabled", "mount", "readDeploySignals", "refusalFor"]);
  assert.equal(hud.default.mount, hud.mount);
});

await check("I-27: static imports are exactly the five ui helpers — no scene3d/, no three; new URL(…, location.href)", () => {
  const src = fs.readFileSync(path.join(APP, "plugins", "drone-hud.js"), "utf8");
  const statics = [...src.matchAll(/^\s*import\s+(?:[^"'();]*?\s+from\s+)?["']([^"']+)["']\s*;?\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(statics.sort(), ["../ui/escape_action.js", "../ui/hud_focus.js", "../ui/hud_kit.js", "../ui/hud_scale.js", "../ui/keymap.js"]);
  assert.equal(statics.some((s) => s.includes("scene3d/") || s === "three" || s.startsWith("three/")), false);
  assert.equal(/^\s*import\s[^(]*["']three["']/m.test(src), false, "no static three import");
  assert.ok(src.includes("new URL("), "new URL( present");
  assert.ok(src.includes("location.href"), "location.href present");
  assert.ok(src.includes('new URL(DRONE_INDEX_PATH, location.href)') && src.includes('"scene3d/drone/index.js"'));
  assert.ok(src.includes('import("three")'), "three only as a dynamic import");
});

await check("plugins/drone-hud.manifest.json is the exact §3.11 manifest (hotkey Shift+F11, iconHidden, no capabilities)", () => {
  const m = JSON.parse(fs.readFileSync(path.join(APP, "plugins", "drone-hud.manifest.json"), "utf8"));
  assert.deepEqual(m, {
    $schema: "./schemas/plugin-manifest.json",
    id: "drone-hud",
    name: "Drone",
    author: "holtburger",
    version: "0.1.0",
    description: "Drone Deploy launcher: a toolbar button under the RynthSuite ⚒ (plugins/hotbar.js .hb-hotbar-addons) that deploys, flies and recalls a local-only camera drone (scene3d/drone/, loaded on first use). Click deploys / skips / recalls, Shift+click recalls at once, right-click opens the settings, Shift+F11 = the button; on by default, ?drone=off (exact match) hides it.",
    icon: "✈",
    iconHidden: true,
    entry: "./drone-hud.js",
    environments: ["browser"],
    slots: ["hud", "overlay"],
    hotkeys: [{ id: "toggle", default: "Shift+F11", label: "Deploy / recall drone" }],
    clientApi: "^1.0",
  });
  assert.equal("capabilities" in m, false);
});

await check("plugins/index.json lists ./drone-hud.manifest.json between corpse-loot-bar and dye-preview", () => {
  const j = JSON.parse(fs.readFileSync(path.join(APP, "plugins", "index.json"), "utf8"));
  const paths = j.plugins.map((p) => p.manifestPath);
  const i = paths.indexOf("./drone-hud.manifest.json");
  assert.ok(i > 0, "listed");
  assert.deepEqual(j.plugins[i], { manifestPath: "./drone-hud.manifest.json", devPath: "./drone-hud.manifest.dev.json" });
  assert.equal(paths[i - 1], "./corpse-loot-bar.manifest.json");
  assert.equal(paths[i + 1], "./dye-preview.manifest.json");
});

console.log(`\ndrone_hud: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
