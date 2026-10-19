// tests/rynth_vt_display.test.mjs — plugins/rynth-vt/display.js, the VTank
// profile's page-level display options (2026-10-19): the frame-rate limit
// (EnableFPSLimit, TargetFPSFocused / TargetFPSBackground → the real
// scene3d/frame_cap.js driver → window.__setFrameCap) and the steep-ground
// tint (ShowTerrainPassability → scene3d/passability_overlay.js, stubbed
// here). Driven by the REAL VtOptions of a page session (rynth/vt/settings,
// in-memory storage), so edits, profile switches and Default's fresh overlay
// fire the real onChange events:
//   • works with no bot (the page session) and before login (nothing touched);
//   • the defaults are ON (60 / 30, the tint shown); an edit applies at once;
//   • blur → the background rate; a profile switch re-applies at once;
//   • ?targetFps wins: the setter is never called, the console says so once;
//   • logout / another character re-binds; dispose releases everything;
//   • the Route tab's "Steep" row comes through the bridge's route view.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_display.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const D = await import("../plugins/rynth-vt/display.js");
const SET = await import("../rynth/vt/settings/index.js");
const { createVtBridge } = await import("../rynth/vt/bridge/vt_bridge.js");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 5).join("\n       ") : e}`);
  }
}
const flush = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
function target(extra = {}) {
  const l = new Map();
  return {
    ...extra,
    addEventListener(t, f) {
      if (!l.has(t)) l.set(t, new Set());
      l.get(t).add(f);
    },
    removeEventListener(t, f) {
      l.get(t)?.delete(f);
    },
    fire(t) {
      for (const f of [...(l.get(t) || [])]) f({ type: t });
    },
  };
}
function fakeTimers() {
  return {
    n: 0,
    fns: new Map(),
    setInterval(fn) {
      this.n += 1;
      this.fns.set(this.n, fn);
      return this.n;
    },
    clearInterval(id) {
      this.fns.delete(id);
    },
    fire() {
      for (const fn of [...this.fns.values()]) fn();
    },
  };
}
/** The passability overlay stand-in (installPassabilityOverlay's handle). */
function fakeOverlay() {
  const o = {
    shows: [],
    disposed: 0,
    installs: 0,
    handle: null,
  };
  o.handle = {
    setVisible: (v) => (o.shows.push(!!v), !!v),
    dispose: () => o.disposed++,
    status: () => ({ visible: o.shows.at(-1) === true }),
  };
  o.module = { installPassabilityOverlay: () => (o.installs++, o.handle) };
  return o;
}
/** A page: window + document (focus), the 3D loop's setter, the page entry. */
function makePage({ search = "" } = {}) {
  let focused = true;
  const doc = target({ hidden: false, hasFocus: () => focused });
  const caps = [];
  const win = target({ location: { search }, document: doc });
  win.__setFrameCap = (fps) => (caps.push(fps), true);
  let session = null;
  win.__rynthVt = { session: () => session };
  return {
    win,
    doc,
    caps,
    login(scope = "1342177281", storage = memStorage()) {
      session = SET.getVtSession(win, scope, { storage });
      return session;
    },
    logout() {
      session = null;
    },
    setFocus(v) {
      focused = v;
    },
  };
}

console.log("— plugins/rynth-vt/display.js");

await check("no session yet (before login): nothing touched; login → the defaults apply (60 fps, steep tint shown)", async () => {
  const p = makePage();
  const timers = fakeTimers();
  const ov = fakeOverlay();
  const h = D.installVtDisplay(p.win, { timers, loadPassability: async () => ov.module, log: () => {} });
  assert.equal(p.win.__rynthVtDisplay, h);
  assert.equal(D.installVtDisplay(p.win, { timers }), h, "idempotent");
  assert.equal(timers.fns.size, 1, "one 1 Hz poll");
  timers.fire();
  assert.deepEqual(p.caps, [], "no options: the loop is left alone");
  assert.equal(ov.installs, 0, "nothing loaded");
  p.login();
  timers.fire();
  await flush();
  assert.deepEqual(p.caps, [60], "EnableFPSLimit on by default, the focused rate");
  assert.equal(ov.installs, 1);
  assert.deepEqual(ov.shows, [true], "ShowTerrainPassability on by default");
  const st = h.status();
  assert.equal(st.options, true);
  assert.equal(st.cap.fps, 60);
  assert.equal(st.steep.want, true);
  h.dispose();
});

await check("edits apply at once (no poll): rate, limit off/on, the tint; blur → the background rate", async () => {
  const p = makePage();
  const ov = fakeOverlay();
  const s = p.login();
  const timers = fakeTimers();
  const h = D.installVtDisplay(p.win, { timers, loadPassability: async () => ov.module, log: () => {} });
  await flush();
  assert.deepEqual(p.caps, [60], "bound at install");
  s.options.set("TargetFPSFocused", 90);
  assert.deepEqual(p.caps, [60, 90]);
  p.setFocus(false);
  p.win.fire("blur");
  assert.deepEqual(p.caps.at(-1), 30, "unfocused: TargetFPSBackground");
  s.options.set("TargetFPSBackground", 15);
  assert.deepEqual(p.caps.at(-1), 15);
  p.setFocus(true);
  p.win.fire("focus");
  assert.deepEqual(p.caps.at(-1), 90);
  s.options.set("EnableFPSLimit", false);
  assert.deepEqual(p.caps.at(-1), 0, "limit off: uncapped");
  s.options.set("EnableFPSLimit", true);
  assert.deepEqual(p.caps.at(-1), 90);
  const n = p.caps.length;
  s.options.set("MonsterRange", 55);
  assert.equal(p.caps.length, n, "other options are ignored");
  s.options.set("ShowTerrainPassability", false);
  assert.deepEqual(ov.shows, [true, false], "the tint hides at once");
  s.options.set("ShowTerrainPassability", true);
  assert.deepEqual(ov.shows, [true, false, true]);
  // VTank names and /rs-style sets go through the same authority
  s.options.set("targetfpsfocused", 120, { source: "command" });
  assert.deepEqual(p.caps.at(-1), 120);
  h.dispose();
});

await check("a profile switch re-applies at once (Save As keeps the edits; Default is the schema defaults again)", async () => {
  const p = makePage();
  const ov = fakeOverlay();
  const s = p.login();
  const h = D.installVtDisplay(p.win, { timers: fakeTimers(), loadPassability: async () => ov.module, log: () => {} });
  await flush();
  s.options.set("TargetFPSFocused", 144);
  s.options.set("ShowTerrainPassability", false);
  assert.equal(s.options.saveAs("Fast").ok, true);
  assert.deepEqual(p.caps.at(-1), 144);
  assert.equal(s.options.selectProfile("Default", "default").ok, true);
  assert.deepEqual(p.caps.at(-1), 60, "Default = the schema defaults");
  assert.deepEqual(ov.shows.at(-1), true);
  assert.equal(s.options.selectProfile("Fast", "shared").ok, true);
  assert.deepEqual(p.caps.at(-1), 144, "back on the saved profile");
  assert.deepEqual(ov.shows.at(-1), false);
  h.dispose();
});

await check("?targetFps wins: the setter is never called; the console says so once", async () => {
  const p = makePage({ search: "?targetFps=20" });
  p.login();
  const lines = [];
  const h = D.installVtDisplay(p.win, { timers: fakeTimers(), loadPassability: async () => fakeOverlay().module, log: (m) => lines.push(m) });
  p.setFocus(false);
  p.win.fire("blur");
  h.refresh();
  assert.deepEqual(p.caps, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[rynth-vt\] \?targetFps=20 pins the frame rate on this page — the frame-rate limit \(EnableFPSLimit, TargetFPSFocused \/ TargetFPSBackground\) is not applied$/);
  assert.equal(h.status().cap.pinned, true);
  h.dispose();
  assert.deepEqual(p.caps, [], "nothing to release");
});

await check("the 3D loop arrives later: the 1 Hz poll applies the cap once its setter exists", async () => {
  const p = makePage();
  const setter = p.win.__setFrameCap;
  delete p.win.__setFrameCap;
  p.login();
  const timers = fakeTimers();
  const h = D.installVtDisplay(p.win, { timers, loadPassability: async () => fakeOverlay().module, log: () => {} });
  timers.fire();
  assert.deepEqual(p.caps, []);
  p.win.__setFrameCap = setter;
  timers.fire();
  assert.deepEqual(p.caps, [60]);
  timers.fire();
  assert.deepEqual(p.caps, [60], "applied once");
  h.dispose();
});

await check("logout releases the cap and hides the tint; another character / a bot layer re-binds", async () => {
  const p = makePage();
  const ov = fakeOverlay();
  const timers = fakeTimers();
  const s1 = p.login("1342177281");
  const h = D.installVtDisplay(p.win, { timers, loadPassability: async () => ov.module, log: () => {} });
  await flush();
  s1.options.set("TargetFPSFocused", 100);
  p.logout();
  timers.fire();
  assert.deepEqual(p.caps.at(-1), 0, "released");
  assert.deepEqual(ov.shows.at(-1), false, "hidden");
  s1.options.set("TargetFPSFocused", 110);
  assert.deepEqual(p.caps.at(-1), 0, "the old character's options are no longer followed");
  const s2 = p.login("1342177282");
  timers.fire();
  assert.deepEqual(p.caps.at(-1), 60, "the new character's profile");
  assert.deepEqual(ov.shows.at(-1), true);
  // a bot layer's options are preferred (vt_bridge.js optionsOf)
  s2.options.set("TargetFPSFocused", 75);
  assert.deepEqual(p.caps.at(-1), 75);
  const layerSession = SET.getVtSession({}, "1342177283", { storage: memStorage() });
  layerSession.options.set("TargetFPSFocused", 50);
  p.win.__bot = { vt: { options: layerSession.options } };
  assert.equal(D.displayOptionsOf(p.win), layerSession.options);
  timers.fire();
  assert.deepEqual(p.caps.at(-1), 50);
  delete p.win.__bot;
  assert.equal(D.displayOptionsOf(p.win), s2.options);
  assert.equal(D.displayOptionsOf({}), null);
  h.dispose();
});

await check("dispose: cap released, tint disposed, poll stopped, no more option events followed", async () => {
  const p = makePage();
  const ov = fakeOverlay();
  const timers = fakeTimers();
  const s = p.login();
  const h = D.installVtDisplay(p.win, { timers, loadPassability: async () => ov.module, log: () => {} });
  await flush();
  h.dispose();
  assert.deepEqual(p.caps.at(-1), 0);
  assert.equal(ov.disposed, 1);
  assert.equal(timers.fns.size, 0);
  assert.equal(p.win.__rynthVtDisplay, undefined);
  const n = p.caps.length;
  s.options.set("TargetFPSFocused", 33);
  p.win.fire("blur");
  assert.equal(p.caps.length, n, "unsubscribed and unhooked");
  h.dispose();
  const h2 = D.installVtDisplay(p.win, { timers, loadPassability: async () => ov.module, log: () => {} });
  assert.notEqual(h2, h, "a fresh controller after dispose");
  h2.dispose();
});

await check("the overlay module failing to load is reported once and not retried; broken options read as defaults", async () => {
  const p = makePage();
  p.login();
  const timers = fakeTimers();
  let loads = 0;
  const warn = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    const h = D.installVtDisplay(p.win, { timers, loadPassability: async () => { loads++; throw new Error("no scene3d"); }, log: () => {} });
    await flush();
    timers.fire();
    timers.fire();
    await flush();
    assert.equal(loads, 1);
    assert.equal(h.status().steep.failed, true);
    assert.equal(warns.filter((w) => /steep-ground overlay unavailable/.test(w)).length, 1);
    h.dispose();
  } finally {
    console.warn = warn;
  }
  const q = makePage();
  const broken = { getValue() { throw new Error("x"); }, onChange() { throw new Error("y"); } };
  const ov = fakeOverlay();
  const h = D.installVtDisplay(q.win, { timers: fakeTimers(), getOptions: () => broken, loadPassability: async () => ov.module, log: () => {} });
  await flush();
  assert.deepEqual(q.caps, [60], "the schema defaults");
  assert.deepEqual(ov.shows, [true]);
  h.dispose();
});

console.log("\n— the Route tab's Steep row (bridge route view)");

await check("route view: the ShowTerrainPassability row without a bot (page session), writable through bridge.opt.set", async () => {
  const p = makePage();
  const s = p.login();
  const b = createVtBridge({ win: { __rynthVt: { session: () => s } } });
  let v = b.snapshot("route").view;
  assert.equal(v.available, false, "no bot: no route editing");
  assert.ok(v.steep, "…but the Steep row is there");
  assert.equal(v.steep.key, "ShowTerrainPassability");
  assert.equal(v.steep.type, "bool");
  assert.equal(v.steep.value, true, "RynthAi's default: on");
  assert.equal(v.steep.isDefault, true);
  assert.equal(v.steep.label, "Show steep ground");
  const r = await b.opt.set("ShowTerrainPassability", false);
  assert.equal(r.ok, true);
  v = b.snapshot("route").view;
  assert.equal(v.steep.value, false);
  assert.equal(v.steep.isDefault, false);
  assert.equal(s.options.getValue("ShowTerrainPassability"), false);
  assert.equal(createVtBridge({ win: {} }).snapshot("route").view.steep, null, "no settings yet: null (the switch is disabled)");
});

await check("wiring: the HUD installs display.js lazily from location.href after the page entry, and disposes it", () => {
  const src = readFileSync(path.join(APP, "plugins/rynth-hud.js"), "utf8");
  assert.match(src, /const VT_DISPLAY_PATH = "plugins\/rynth-vt\/display\.js";/);
  assert.match(src, /const api = m\.installRsEntry\(window\);\n\s*installVtDisplay\(\);/);
  assert.match(src, /S\.vtDisplay\?\.dispose\?\.\(\)/);
  assert.ok(!/^import\s[^;]*display\.js/m.test(src), "no static import");
});

console.log(`\nrynth_vt_display: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
