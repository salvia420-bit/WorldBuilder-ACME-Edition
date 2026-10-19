// tests/barber_panel.test.mjs — maps-chargen-barber-1 (2026-10-13).
//
// The barber page (retail gmBarberUI) on the small fake DOM in
// tests/helpers/social_fake_dom.mjs, with a fake SessionHandle standing in
// for the wasm exports (barberInit / barberApply / finishBarber — their Rust
// half is pinned by holtburger-core's barber tests against the real
// portal.dat). Pins:
//
//   [1] ui/ac_barber.js rules: the UI_EVENT "barber" payload parse, the
//       `?barber` / `?barberMotionTable` flags, row arrows with wrap-around,
//       SetSelection's colour wheel (hair colours + shade, eyes without
//       shade, the skin spot + SKIN shade on nose / mouth / skin),
//       Gearknight / Olthoi rows, labels, Apply's effect order;
//   [2] the panel opens on the `startBarber` bus event (app/client_events.js
//       routes UI_EVENT tag "barber" there) with the player's heritage /
//       gender and the 16 fields — subscribed on __pluginClientReady, since
//       the bar mounts it at page load with client null (2026-10-18);
//   [3] Cancel sends nothing; Apply calls finishBarber exactly once (also
//       on a double click) and runs the Undead/Shadow local effects; a
//       Cancel / title-bar X / newer StartBarber while barberApply is still
//       pending runs no effects and sends nothing (review G-R1);
//   [4] a face ACE would reject is refused with a message and NOT sent;
//   [5] `?barber=off` keeps the page closed; a stale pkg/ (no barberInit)
//       too.
//
// Run from apps/holtburger-web/:  node tests/barber_panel.test.mjs

import assert from "node:assert/strict";
import { installFakeDom, visibleText, FakeEvent } from "./helpers/social_fake_dom.mjs";

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);
globalThis.location = { search: "", href: "http://test/index.html" };
globalThis.CustomEvent = class CustomEvent extends FakeEvent {
  constructor(type, init = {}) { super(type, init); this.detail = init.detail; }
};

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
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 6) { for (let i = 0; i < n; i += 1) await tick(); }

const B = await import("../ui/ac_barber.js");

// ── [1] pure rules ──────────────────────────────────────────────────────────
console.log("ui/ac_barber.js — gmBarberUI rules");

const FIELDS = Array.from({ length: 16 }, (_, i) => (0x04000000 + i) >>> 0);
FIELDS[13] = 0x02001A9C; // setup
FIELDS[14] = 0;
FIELDS[15] = 0;

await check("parseStartBarberFields: 16 decimal u32 in wire order, else null", () => {
  assert.deepEqual(B.parseStartBarberFields(FIELDS.join(",")), FIELDS);
  assert.deepEqual(B.parseStartBarberFields("4294967295," + "0,".repeat(14) + "1")[0], 0xFFFFFFFF);
  assert.equal(B.parseStartBarberFields(FIELDS.slice(0, 15).join(",")), null);
  assert.equal(B.parseStartBarberFields(FIELDS.join(",") + ",1"), null);
  assert.equal(B.parseStartBarberFields("a," + FIELDS.slice(1).join(",")), null);
  assert.equal(B.parseStartBarberFields("4294967296," + FIELDS.slice(1).join(",")), null);
  assert.equal(B.parseStartBarberFields(""), null);
  assert.equal(B.parseStartBarberFields(undefined), null);
});

await check("flags: ?barber and ?barberMotionTable default ON (off/0/false disable; no also for barberMotionTable)", () => {
  assert.equal(B.barberEnabled(""), true);
  assert.equal(B.barberEnabled("?barber=on"), true);
  for (const v of ["off", "0", "false"]) assert.equal(B.barberEnabled(`?barber=${v}`), false, v);
  assert.equal(B.barberMotionTableEnabled(""), true);
  for (const v of ["on", "1", "true", "yes", "garbage"]) assert.equal(B.barberMotionTableEnabled(`?barberMotionTable=${v}`), true, v);
  for (const v of ["off", "0", "false", "no", "OFF", "No"]) assert.equal(B.barberMotionTableEnabled(`?barberMotionTable=${v}`), false, v);
});

const INIT = Object.freeze({
  heritage: 11, gender: 1, option: "noflame", optionToken: "ID_Barber_Undead_NoFlame", gearOlthoi: false,
  counts: { hairStyles: 3, eyeStrips: 2, noseStrips: 2, mouthStrips: 4, hairColors: 2, eyeColors: 3 },
  face: { hairStyle: 1, eyesStrip: 0, noseStrip: 1, mouthStrip: 3, hairColor: 1, hairShade: 0.5, skinShade: 0.25, eyeColor: 2, option: false },
  spots: { hair: [[10, 20, 30], [40, 50, 60]], eyes: [[1, 2, 3], [4, 5, 6], null], skin: [[200, 150, 100]] },
});

await check("BarberPage: opens on Hair; arrows wrap (≥ n → 0, < 0 → n−1) and select the row", () => {
  const p = new B.BarberPage(INIT);
  assert.equal(p.part, B.BarberPart.HAIR);
  assert.equal(p.step(B.BarberPart.HAIR, -1), 0);
  assert.equal(p.step(B.BarberPart.HAIR, -1), 2, "wraps to n−1");
  assert.equal(p.step(B.BarberPart.HAIR, 1), 0, "wraps to 0");
  assert.equal(p.step(B.BarberPart.MOUTH, 1), 0, "mouth 3 → 0 (n = 4)");
  assert.equal(p.part, B.BarberPart.MOUTH, "an arrow selects its row");
  assert.equal(p.arrowsEnabled(B.BarberPart.SKIN), false, "skin has no styles");
  assert.equal(p.step(B.BarberPart.SKIN, 1), -1);
});

await check("BarberPage: SetSelection wheel — hair colours + hair shade, eyes w/o shade, skin spot + SKIN shade", () => {
  const p = new B.BarberPage(INIT);
  let w = p.wheel();
  assert.deepEqual(w.spots, INIT.spots.hair);
  assert.equal(w.current, 1);
  assert.equal(w.shadeVisible, true);
  assert.equal(w.shade, 0.5);
  p.pickSpot(0);
  assert.equal(p.face.hairColor, 0);
  p.pickSpot(7);
  assert.equal(p.face.hairColor, 0, "a spot past iNumColors does nothing");
  p.setShade(0.9);
  assert.equal(p.face.hairShade, 0.9);
  p.select(B.BarberPart.EYES);
  w = p.wheel();
  assert.equal(w.spots.length, 3);
  assert.equal(w.shadeVisible, false);
  p.setShade(0.1);
  assert.equal(p.face.skinShade, 0.25, "no shade on the eyes row");
  p.pickSpot(1);
  assert.equal(p.face.eyeColor, 1);
  for (const part of [B.BarberPart.NOSE, B.BarberPart.MOUTH, B.BarberPart.SKIN]) {
    p.select(part);
    w = p.wheel();
    assert.equal(w.spots.length, 1);
    assert.equal(w.current, 0);
    assert.equal(w.shadeVisible, true);
  }
  p.setShade(1.7);
  assert.equal(p.face.skinShade, 1, "clamped to [0, 1]");
  p.setShade(-3);
  assert.equal(p.face.skinShade, 0);
  assert.equal(p.face.hairShade, 0.9, "skin rows never move the hair shade");
});

await check("Gearknight / Olthoi: nose + mouth hidden, eyes arrows ghosted, retail row labels", () => {
  const p = new B.BarberPage({ ...INIT, heritage: 6, option: null, optionToken: null, gearOlthoi: true });
  assert.equal(p.rowVisible(B.BarberPart.NOSE), false);
  assert.equal(p.rowVisible(B.BarberPart.MOUTH), false);
  assert.equal(p.arrowsEnabled(B.BarberPart.EYES), false);
  assert.equal(p.arrowsEnabled(B.BarberPart.HAIR), true);
  assert.equal(p.select(B.BarberPart.NOSE), B.BarberPart.HAIR, "a hidden row cannot be selected");
  const gear = B.barberRowLabels(6);
  assert.equal(gear[B.BarberPart.HAIR], "Body Style");
  assert.equal(gear[B.BarberPart.EYES], "Trim Color");
  assert.equal(gear[B.BarberPart.SKIN], "Gear Color");
  const olthoi = B.barberRowLabels(13);
  assert.equal(olthoi[B.BarberPart.SKIN], "Markings");
  assert.equal(B.barberRowLabels(1)[B.BarberPart.HAIR], "Hair");
  // A loaded DAT string wins over the English fallback.
  assert.equal(B.barberRowLabels(6, () => "DAT text")[B.BarberPart.HAIR], "DAT text");
  assert.equal(B.barberOptionLabel("ID_Barber_Shadow_NoCrown"), "Suppress Crown");
  assert.equal(B.barberOptionLabel(null), null);
});

await check("runBarberLocalEffects: retail order; motion table only when opts.motionTable", () => {
  const log = [];
  const sinks = {
    setMotionTable: (id) => log.push(["mt", id]),
    destroyParticles: () => log.push(["destroy"]),
    playScript: (d) => log.push(["play", d]),
  };
  B.runBarberLocalEffects({ motionTableId: 0x0900020E, destroyParticles: true, playScript: 0x330012D4 }, sinks, {});
  assert.deepEqual(log, [["destroy"], ["play", 0x330012D4]]);
  log.length = 0;
  B.runBarberLocalEffects({ motionTableId: 0x0900020E, destroyParticles: true, playScript: 0x330012D4 }, sinks, { motionTable: true });
  assert.deepEqual(log, [["mt", 0x0900020E], ["destroy"], ["play", 0x330012D4]]);
  log.length = 0;
  B.runBarberLocalEffects({ motionTableId: 0, destroyParticles: true, playScript: 0 }, sinks, { motionTable: true });
  assert.deepEqual(log, [["destroy"]], "NOFLAME: particles go, nothing plays");
});

await check("applyBarber: sends once when ACE would accept; refuses 'rejected' / 'unbuildable'", async () => {
  const p = new B.BarberPage(INIT);
  const sent = [];
  const deps = (res) => ({
    barberApply: async () => JSON.stringify(res),
    finishBarber: (f) => sent.push(f),
    sinks: {},
  });
  let out = await B.applyBarber(p, deps({ fields: FIELDS, effects: {}, problems: [] }));
  assert.equal(out.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].constructor.name, "Uint32Array");
  assert.deepEqual(Array.from(sent[0]), FIELDS);
  out = await B.applyBarber(p, deps({ fields: FIELDS, effects: {}, problems: ["headObject", "hairTexture"] }));
  assert.equal(out.sent, false);
  assert.equal(out.reason, "rejected");
  assert.match(B.barberProblemText(out.problems), /hair style, hair/);
  out = await B.applyBarber(p, deps({ fields: null, effects: {}, problems: [] }));
  assert.equal(out.reason, "unbuildable");
  assert.equal(sent.length, 1, "nothing more was sent");
});

await check("applyBarber: stillOpen() false once barberApply settles → 'cancelled', no effects, nothing sent", async () => {
  const p = new B.BarberPage(INIT);
  const sent = [];
  const ran = [];
  const deps = (stillOpen) => ({
    barberApply: async () => JSON.stringify({
      fields: FIELDS, effects: { destroyParticles: true, playScript: 0x330012D4 }, problems: [],
    }),
    finishBarber: (f) => sent.push(f),
    sinks: { destroyParticles: () => ran.push("destroy"), playScript: () => ran.push("play") },
    stillOpen,
  });
  let out = await B.applyBarber(p, deps(() => false));
  assert.deepEqual(out, { sent: false, reason: "cancelled" });
  assert.equal(sent.length, 0);
  assert.deepEqual(ran, []);
  out = await B.applyBarber(p, deps(() => true));
  assert.equal(out.sent, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(ran, ["destroy", "play"]);
});

// ── [2]-[5] the panel ───────────────────────────────────────────────────────
console.log("plugins/barber-panel.js — the page");

const PLAYER = 0x50000001;
const calls = [];
const emCalls = [];
let applyResult = {
  fields: FIELDS,
  effects: { motionTableId: 0, destroyParticles: true, playScript: 0x330012D4 },
  problems: [],
};
const handle = {
  playerGuid: () => PLAYER,
  objectIntProperty: (g, p) => ((g >>> 0) === PLAYER ? ({ 188: 11, 113: 1 })[p] : undefined),
  barberInit: async (h, g, f) => {
    calls.push(["barberInit", h, g, Array.from(f), f.constructor.name]);
    return JSON.stringify(INIT);
  },
  barberApply: async (h, g, face) => {
    calls.push(["barberApply", h, g, { ...face }]);
    return JSON.stringify(applyResult);
  },
  finishBarber: (f) => calls.push(["finishBarber", Array.from(f), f.constructor.name]),
  ingestMotionLengths: (id) => calls.push(["ingestMotionLengths", id]),
};
globalThis.__sessionHandle = handle;
globalThis.getLocalPlayerGuid = () => PLAYER;
globalThis.liveScene3d = {
  entityManager: {
    entityMap: new Map([[PLAYER, { root: { isRoot: true }, meta: { mtableId: 0x09000001 } }]]),
    _particleEmittersForGuid: new Map([[PLAYER, [11, 12]]]),
    _worldParticleManager: { destroyParticleEmitter: (id) => emCalls.push(["destroyEmitter", id]) },
    _attachParticleChainForEntity: async (g, root, did) => { emCalls.push(["playScript", g >>> 0, did >>> 0, !!root?.isRoot]); },
  },
};
const busL = new Map();
const bus = {
  on(n, f) { if (!busL.has(n)) busL.set(n, new Set()); busL.get(n).add(f); },
  off(n, f) { busL.get(n)?.delete(f); },
  emit(n, detail) { for (const f of [...(busL.get(n) || [])]) f(new FakeEvent(n, { detail })); },
  count(n) { return busL.get(n)?.size ?? 0; },
};
// Production order: the bar mounts every slot at page load with client null
// (app/plugin_bar.js mountBar); index.html builds __pluginClient at login and
// resolves __pluginClientReady.
let resolveReady = null;
globalThis.__pluginClientReady = new Promise((r) => { resolveReady = r; });

const panel = await import("../plugins/barber-panel.js");
const unmount = panel.mount({ client: null });

const root = () => document.getElementById("hb-barber-panel");
const isOpen = () => root()?.dataset?.open === "1";
const q = (sel) => root()?.querySelector(sel);
const count = (name) => calls.filter((c) => c[0] === name).length;
const rest = FIELDS.join(",");

await check("mount before login waits; __pluginClientReady subscribes startBarber once", async () => {
  assert.equal(bus.count("startBarber"), 0);
  globalThis.__pluginClient = { events: bus };
  resolveReady(globalThis.__pluginClient);
  await settle();
  assert.equal(bus.count("startBarber"), 1);
});

await check("[2] startBarber {rest} opens the page with heritage/gender + the 16 fields", async () => {
  bus.emit("startBarber", { rest, u32: FIELDS[13], u32b: FIELDS[0] });
  await settle();
  assert.equal(isOpen(), true);
  const init = calls.find((c) => c[0] === "barberInit");
  assert.deepEqual(init, ["barberInit", 11, 1, FIELDS, "Uint32Array"]);
  const rows = root().querySelectorAll(".hbb-row");
  assert.equal(rows.length, 5);
  assert.ok(q('.hbb-row[data-part="1"]').classList.contains("is-selected"), "Hair selected");
  assert.match(visibleText(q('.hbb-row[data-part="1"]')), /Hair\s*2\/3/);
  assert.equal(root().querySelectorAll(".hbb-spot").length, 2, "two hair colours");
  assert.equal(q(".hbb-shade").hidden, false);
  assert.equal(q(".hbb-option").hidden, false);
  assert.match(visibleText(q(".hbb-option")), /Suppress Flames/);
});

await check("[2] row arrows, eyes row + spot click edit the live face", async () => {
  q('.hbb-row[data-part="1"] [data-dir="-1"]').click();
  assert.equal(panel._barberPageForTests().face.hairStyle, 0);
  q('.hbb-row[data-part="2"]').click();
  assert.ok(q('.hbb-row[data-part="2"]').classList.contains("is-selected"));
  assert.equal(root().querySelectorAll(".hbb-spot").length, 3, "three eye colours");
  assert.equal(q(".hbb-shade").hidden, true, "no shade on the eyes row");
  root().querySelectorAll(".hbb-spot")[1].click();
  assert.equal(panel._barberPageForTests().face.eyeColor, 1);
  const opt = q(".hbb-option-input");
  opt.click();
  assert.equal(panel._barberPageForTests().face.option, true);
});

await check("[3] Cancel closes and sends nothing", async () => {
  q('[data-action="cancel"]').click();
  await settle();
  assert.equal(isOpen(), false);
  assert.equal(count("barberApply"), 0);
  assert.equal(count("finishBarber"), 0);
});

await check("[3] Apply (double-clicked) sends FinishBarber exactly once, runs the effects, closes", async () => {
  bus.emit("startBarber", { rest });
  await settle();
  assert.equal(isOpen(), true);
  const apply = q('[data-action="apply"]');
  apply.click();
  apply.click();
  await settle();
  assert.equal(count("barberApply"), 1);
  assert.equal(count("finishBarber"), 1);
  const fin = calls.find((c) => c[0] === "finishBarber");
  assert.deepEqual(fin, ["finishBarber", FIELDS, "Uint32Array"]);
  const app = calls.find((c) => c[0] === "barberApply");
  assert.equal(app[1], 11);
  assert.equal(app[2], 1);
  assert.equal(app[3].hairStyle, 1, "a fresh open re-inits the face");
  assert.deepEqual(emCalls, [["destroyEmitter", 11], ["destroyEmitter", 12], ["playScript", PLAYER, 0x330012D4, true]]);
  assert.equal(globalThis.liveScene3d.entityManager._particleEmittersForGuid.has(PLAYER), false);
  assert.equal(isOpen(), false);
});

await check("[3] the Empyrean motion table is swapped by default; ?barberMotionTable=off skips it", async () => {
  const meta = globalThis.liveScene3d.entityManager.entityMap.get(PLAYER).meta;
  applyResult = { fields: FIELDS, effects: { motionTableId: 0x0900020E, destroyParticles: false, playScript: 0 }, problems: [] };
  location.search = "?barberMotionTable=off";
  bus.emit("startBarber", { rest });
  await settle();
  q('[data-action="apply"]').click();
  await settle();
  assert.equal(meta.mtableId, 0x09000001, "=off: unchanged");
  location.search = "";
  bus.emit("startBarber", { rest });
  await settle();
  q('[data-action="apply"]').click();
  await settle();
  location.search = "";
  assert.equal(meta.mtableId, 0x0900020E);
  assert.deepEqual(calls.filter((c) => c[0] === "ingestMotionLengths"), [["ingestMotionLengths", 0x0900020E]]);
  assert.equal(count("finishBarber"), 3);
});

await check("[4] a face ACE would reject is refused with a message and NOT sent", async () => {
  applyResult = { fields: FIELDS, effects: { destroyParticles: true, playScript: 0x330012D4 }, problems: ["headObject"] };
  const before = count("finishBarber");
  const fx = emCalls.length;
  bus.emit("startBarber", { rest });
  await settle();
  q('[data-action="apply"]').click();
  await settle();
  assert.equal(count("finishBarber"), before);
  assert.equal(emCalls.length, fx, "no local effects either");
  assert.equal(isOpen(), true, "the page stays open");
  assert.match(visibleText(q(".hbb-status")), /cannot do that \(hair style\)/);
  q('[data-action="cancel"]').click();
});

// barberApply held open (its ensure_records re-fetching a PalSet that failed
// at open) while the page goes away: nothing may run or be sent.
function holdBarberApply() {
  const saved = handle.barberApply;
  const pending = [];
  handle.barberApply = (h, g, face) => {
    calls.push(["barberApply", h, g, { ...face }]);
    return new Promise((resolve) => pending.push(() => resolve(JSON.stringify(applyResult))));
  };
  return {
    release() { for (const r of pending.splice(0)) r(); },
    restore() { handle.barberApply = saved; },
  };
}

await check("[3] Cancel / the title-bar X while barberApply is pending: no local effects, no FinishBarber", async () => {
  applyResult = { fields: FIELDS, effects: { motionTableId: 0, destroyParticles: true, playScript: 0x330012D4 }, problems: [] };
  const hold = holdBarberApply();
  try {
    const closers = {
      cancel: () => q('[data-action="cancel"]').click(),
      titlebarX: () => q(".hbk-close").click(), // win.close() → onHide, not closePanel
    };
    for (const [how, close] of Object.entries(closers)) {
      const fin = count("finishBarber");
      const fx = emCalls.length;
      bus.emit("startBarber", { rest });
      await settle();
      assert.equal(isOpen(), true, how);
      const applying = panel.applyNow();
      await settle();
      close();
      assert.equal(isOpen(), false, how);
      hold.release();
      const out = await applying;
      await settle();
      assert.deepEqual(out, { sent: false, reason: "cancelled" }, how);
      assert.equal(count("finishBarber"), fin, `${how}: nothing sent`);
      assert.equal(emCalls.length, fx, `${how}: no local effects`);
      assert.equal(isOpen(), false, how);
    }
  } finally {
    hold.restore();
  }
});

await check("[3] a newer StartBarber while barberApply is pending cancels the old Apply; the new page applies once", async () => {
  const hold = holdBarberApply();
  const fin = count("finishBarber");
  const fx = emCalls.length;
  let first;
  try {
    bus.emit("startBarber", { rest });
    await settle();
    first = panel._barberPageForTests();
    const applying = panel.applyNow();
    await settle();
    bus.emit("startBarber", { rest });
    await settle();
    assert.notEqual(panel._barberPageForTests(), first, "the newer page replaced it");
    hold.release();
    assert.equal((await applying).reason, "cancelled");
    await settle();
    assert.equal(count("finishBarber"), fin);
    assert.equal(emCalls.length, fx);
  } finally {
    hold.restore();
  }
  assert.equal(isOpen(), true);
  assert.equal(q('[data-action="apply"]').disabled, false, "the new page's Apply is live");
  q('[data-action="apply"]').click();
  await settle();
  assert.equal(count("finishBarber"), fin + 1);
  assert.equal(isOpen(), false);
});

await check("[3] a newer StartBarber that fails to init: the old page's Apply is not left stuck", async () => {
  const hold = holdBarberApply();
  const savedInit = handle.barberInit;
  const warn = console.warn;
  const fin = count("finishBarber");
  try {
    bus.emit("startBarber", { rest });
    await settle();
    const page = panel._barberPageForTests();
    const applying = panel.applyNow();
    await settle();
    assert.equal(q('[data-action="apply"]').disabled, true, "Apply ghosted while pending");
    console.warn = () => {};
    handle.barberInit = async () => { throw new Error("init failed"); };
    bus.emit("startBarber", { rest });
    await settle();
    hold.release();
    assert.equal((await applying).reason, "cancelled");
    await settle();
    assert.equal(panel._barberPageForTests(), page, "the old page is still the live one");
    assert.equal(isOpen(), true);
    assert.equal(q('[data-action="apply"]').disabled, false, "Apply re-enabled");
    assert.equal(count("finishBarber"), fin);
  } finally {
    handle.barberInit = savedInit;
    console.warn = warn;
    hold.restore();
  }
  q('[data-action="cancel"]').click();
  await settle();
  assert.equal(isOpen(), false);
});

await check("[5] ?barber=off keeps the page closed", async () => {
  location.search = "?barber=off";
  const before = count("barberInit");
  bus.emit("startBarber", { rest });
  await settle();
  location.search = "";
  assert.equal(isOpen(), false);
  assert.equal(count("barberInit"), before);
});

await check("[5] a stale pkg/ (no barberInit) or a malformed payload keeps it closed", async () => {
  const saved = handle.barberInit;
  delete handle.barberInit;
  const warn = console.warn;
  console.warn = () => {};
  try {
    bus.emit("startBarber", { rest });
    await settle();
    assert.equal(isOpen(), false);
    handle.barberInit = saved;
    bus.emit("startBarber", { rest: "1,2,3" });
    await settle();
    assert.equal(isOpen(), false);
  } finally {
    handle.barberInit = saved;
    console.warn = warn;
  }
});

await check("unmount unsubscribes", () => {
  unmount();
  assert.equal(bus.count("startBarber"), 0);
});

await check("a client at mount subscribes at once (once); an unmount before login never subscribes", async () => {
  const again = panel.mount({ client: globalThis.__pluginClient });
  assert.equal(bus.count("startBarber"), 1);
  await settle();
  assert.equal(bus.count("startBarber"), 1);
  again();
  assert.equal(bus.count("startBarber"), 0);
  const client = globalThis.__pluginClient;
  delete globalThis.__pluginClient;
  let resolveLate = null;
  globalThis.__pluginClientReady = new Promise((r) => { resolveLate = r; });
  panel.mount({ client: null })();
  globalThis.__pluginClient = client;
  resolveLate(client);
  await settle();
  assert.equal(bus.count("startBarber"), 0);
});

// ── app/client_events.js routing ────────────────────────────────────────────
console.log("app/client_events.js — UI_EVENT 'barber' → startBarber");

await check("UI_EVENT 'barber|…' emits startBarber {rest} and still emits uiEvent", async () => {
  const { dispatchClientEvent } = await import("../app/client_events.js");
  const { ClientEventKind } = await import("../scene3d/client_event_kinds.js");
  const seen = [];
  globalThis.__pluginClient = {
    events: { emit: (n, d) => seen.push([n, d]), on() {}, off() {} },
  };
  const evt = {
    kind: ClientEventKind.UI_EVENT, stringPayload: `barber|${rest}`,
    u32Payload: FIELDS[13], u32Payload2: FIELDS[0], free() {},
  };
  const log = console.log;
  console.log = () => {};
  try {
    dispatchClientEvent(evt, { EVT_GUARD_ON: false });
  } finally {
    console.log = log;
  }
  const sb = seen.find((s) => s[0] === "startBarber");
  assert.ok(sb, "startBarber emitted");
  assert.equal(sb[1].rest, rest);
  assert.deepEqual(B.parseStartBarberFields(sb[1].rest), FIELDS);
  assert.ok(seen.some((s) => s[0] === "uiEvent" && s[1].tag === "barber"));
});

console.log(`\nbarber_panel: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
