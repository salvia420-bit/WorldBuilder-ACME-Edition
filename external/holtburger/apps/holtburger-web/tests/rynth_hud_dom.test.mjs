// tests/rynth_hud_dom.test.mjs — RynthSuite HUD DOM smoke (2026-10-12).
//
// Mounts plugins/rynth-hud.js on the small fake DOM (tests/helpers/
// social_fake_dom.mjs) with a fake bot whose OperatorControl is the REAL
// rynth/ai/operator_stop.js one, and drives the real handlers:
//   • the ⚒ launcher lands in the toolbar's add-on column (plugins/hotbar.js
//     `.hb-hotbar-addons`), carries the kit tooltip, re-attaches after a
//     toolbar remount, floats when there is no toolbar;
//   • the window builds with kit controls only, shows RUNNING / state /
//     activity / target / vitals, and RUNNING → STOPPED → RUNNING drives the
//     real stop/resume;
//   • toggles, force rebuff, loot floor, every launcher section (Monsters,
//     Settings, Navigation, AI panel embed, Log), minimize, opacity, Escape;
//   • ?rynthHud=off mounts nothing; dispose removes everything.
// Pixels are the orchestrator's 1070 look-check, not this test's job.
//
// Run from apps/holtburger-web/:  node tests/rynth_hud_dom.test.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installFakeDom, FakeEvent } from "./helpers/social_fake_dom.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);
// file:// so the HUD's location-relative dynamic imports (rynth/…) load the
// real modules under node.
globalThis.location = { href: pathToFileURL(path.join(APP, "index.html")).href, search: "" };
// The fake DOM assigns ev.target, which node's native CustomEvent forbids.
class FakeCustomEvent extends FakeEvent { constructor(t, i = {}) { super(t, i); this.detail = i.detail; } }

const opStop = await import("../rynth/ai/operator_stop.js");
const hud = await import("../plugins/rynth-hud.js");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n       ") : e}`);
  }
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const click = (el) => el.dispatchEvent(new FakeEvent("click"));
const q = (sel, root = document) => root.querySelector(sel);
const qa = (sel, root = document) => root.querySelectorAll(sel);

// ── fakes ──────────────────────────────────────────────────────────────
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
const names = { 0x80001234: "Drudge Skulker" };
window.__sessionHandle = {
  isPlayerReady: () => true,
  playerStats: () => ({ vitals: [1, 75, 100, 150, 3, 180, 200, 200, 5, 40, 90, 120] }),
  objectName: (g) => names[g] ?? null,
  objectHealthFraction: () => -1,
  playerKnownSpells: () => [2],
};
function makeBot() {
  const calls = [];
  const combat = { enabled: true, priorities: { olthoi: 10 }, locked: 0x80001234, kills: 3 };
  const loot = { enabled: true, minValue: 0, state: "SCAN", lootedCount: 1 };
  const buff = {
    enabled: true, pending: null, status: { ready: true, desired: 2, active: 2, pending: 0, blocked: null, lastRefusal: null },
    forceRebuff() { calls.push("forceRebuff"); }, cancelForceRebuff() { calls.push("cancelForceRebuff"); },
  };
  const vitals = { cfg: { healAtCombat: 60, getManaAtCombat: 40, restamAtCombat: 30, emergencyHp: 30, topOffHp: 95, topOffStam: 95, topOffMana: 95 }, status: { spells: { healSelf: 6 } } };
  const kernel = {
    action: "Combat", running: true, operatorHeld: false, combat, loot, buff, vitals,
    start() { if (this.operatorHeld) return false; this.running = true; return true; },
    stop() { this.running = false; },
    holdForOperator() { this.operatorHeld = true; this.stop(); },
    releaseOperatorHold() { this.operatorHeld = false; },
    get status() { return { action: this.action, running: this.running, operatorHeld: this.operatorHeld, kills: combat.kills, looted: loot.lootedCount, buffs: buff.status, combat: { locked: combat.locked, mode: 2 } }; },
  };
  const director = {
    enabled: true, start() { this.enabled = true; }, stop() { this.enabled = false; }, isBusy: () => false,
    intervalMinutes: 5, client: { model: "openai/gpt-oss-120b" }, journal: { tail: () => [{ kind: "plan", text: "hunt" }] },
    get status() { return { enabled: this.enabled, running: false, nextCheckAt: Date.now() + 60_000, calls: 2, consecutiveErrors: 0, lastSummary: "hunting" }; },
  };
  const bot = {
    host: {
      TryGetObjectName: (g) => names[g] ?? null,
      TryGetTargetHealthFraction: (g) => (g === 0x80001234 ? 0.42 : -1),
      StopStick: () => calls.push("StopStick"), StopCompletely: () => calls.push("StopCompletely"),
    },
    kernel, combat, loot, buff, vitals,
    router: { status: { state: "IDLE" }, cancel() { calls.push("router.cancel"); } },
    globalRouter: { busy: false },
    startedAt: Date.now() - 600_000,
    mission: null,
    ai: { director, journal: director.journal },
    followRoute: async (legs, o) => { calls.push(["followRoute", legs.length, o.label]); return { ok: true }; },
    goto: async () => ({ ok: true, legsWalked: 1 }),
    egress: async () => ({ ok: true }),
    calls,
  };
  opStop.getOperatorControl(bot); // bot.js attaches bot.control at boot
  return bot;
}
window.__atlas = {
  listRoutes: () => [{ id: "r1", name: "Holtburg loop", legs: [{}, {}, {}], portalsUsed: 1 }],
  getRoute: (k) => (k === "r1" ? { id: "r1", name: "Holtburg loop", legs: [{ lb: 1 }, { lb: 1 }, { lb: 1 }] } : null),
};

// ── tests ──────────────────────────────────────────────────────────────
await check("?rynthHud=off mounts nothing", () => {
  globalThis.location.search = "?rynthHud=off";
  makeHotbar();
  const dispose = hud.mount();
  assert.equal(document.getElementById("hb-rynth-hud-launcher"), null);
  assert.equal(typeof window.__toggleRynthHud, "undefined");
  dispose();
  globalThis.location.search = "";
  assert.equal(hud.rynthHudDisabled("?rynthHud=0"), false, "only the exact string off disables");
});

const bot = makeBot();
window.__bot = bot;
let { addons } = makeHotbar();
let dispose = hud.mount();

await check("launcher lands in the toolbar add-on column with the kit tooltip", () => {
  const b = document.getElementById("hb-rynth-hud-launcher");
  assert.ok(b, "launcher exists");
  assert.equal(b.parentNode, addons, "inside .hb-hotbar-addons");
  assert.equal(b.tagName, "BUTTON", "a <button> — exempt from the toolbar's drag handle");
  assert.equal(b.getAttribute("data-tip"), "");
  const tip = b._hbTip();
  assert.equal(tip.text, "RynthSuite");
  assert.equal(tip.key, "Shift+F12", "manifest default before bindings register");
  assert.match(tip.sub, /dashboard/);
  assert.equal(b.dataset.state, "running", "green dot for a running bot");
});

await check("the window opens with kit controls only", async () => {
  window.__toggleRynthHud();
  const root = document.getElementById("hb-rynth-hud");
  assert.ok(root, "window built");
  assert.equal(root.dataset.open, "1");
  assert.ok(root.classList.contains("hbk-window"));
  assert.ok(q(".hbk-titlebar", root) && q(".hbk-close", root));
  assert.equal(qa(".rhud-tgl", root).length, 6, "Combat/Buff/Nav/Loot/AI + FR");
  assert.equal(qa(".rhud-launch .hbk-btn-brass", root).length, 5);
  for (const s of qa("select", root)) assert.ok(s.classList.contains("hbk-select"), "kit select");
  for (const i of qa("input", root)) assert.ok(i.classList.contains("hbk-input") || i.classList.contains("hbk-check"), `kit input (${i.className})`);
  await tick(320);
});

await check("RUNNING / state / activity / target / vitals / stats render", () => {
  const root = document.getElementById("hb-rynth-hud");
  assert.equal(q(".rhud-body .rhud-run", root).textContent, "RUNNING");
  const kv = qa(".rhud-head .rhud-kv", root);
  assert.equal(kv[0].lastChild.textContent, "Combat");
  assert.equal(kv[1].lastChild.textContent, "Fighting Drudge Skulker (42%)");
  assert.equal(q(".rhud-target", root).firstChild.textContent, "Drudge Skulker");
  assert.equal(qa(".rhud-seg i.on", root).length, 5, "42% → 5 of 10 segments"); // (fake DOM: no `>` combinator)
  const labels = qa(".rhud-vital .hbk-meter-label", root).map((e) => e.textContent);
  assert.deepStrictEqual(labels, ["75/150", "180/200", "40/120"]);
  assert.ok(q(".rhud-stats", root).textContent.includes("Kills 3"));
});

await check("RUNNING → STOPPED → RUNNING drives the real OperatorControl", async () => {
  const root = document.getElementById("hb-rynth-hud");
  const run = q(".rhud-body .rhud-run", root);
  click(run);
  await tick(20);
  assert.equal(bot.kernel.operatorHeld, true);
  assert.equal(bot.ai.director.enabled, false);
  assert.ok(bot.calls.includes("StopCompletely"));
  await tick(300);
  assert.equal(run.textContent, "STOPPED");
  click(run);
  await tick(20);
  assert.equal(bot.kernel.operatorHeld, false);
  assert.equal(bot.kernel.running, true);
  assert.equal(bot.ai.director.enabled, true);
  await tick(300);
  assert.equal(run.textContent, "RUNNING");
});

await check("toggles, FR (+ right-click cancel) and the loot floor reach the bot", async () => {
  const root = document.getElementById("hb-rynth-hud");
  const [combatBtn] = qa(".rhud-tgl", root);
  click(combatBtn);
  await tick(20);
  assert.equal(bot.combat.enabled, false);
  click(combatBtn);
  await tick(20);
  assert.equal(bot.combat.enabled, true);
  const fr = q(".rhud-fr", root);
  click(fr);
  fr.dispatchEvent(new FakeEvent("contextmenu"));
  assert.deepStrictEqual(bot.calls.filter((c) => typeof c === "string" && /Rebuff/.test(c)), ["forceRebuff", "cancelForceRebuff"]);
  const loot = q(".rhud-selectors input", root);
  loot.value = "250";
  loot.dispatchEvent(new FakeEvent("change"));
  assert.equal(bot.loot.minValue, 250);
});

await check("Monsters: rows from combat.priorities; add from the inputs and from the target", async () => {
  const root = document.getElementById("hb-rynth-hud");
  click(qa(".rhud-launch .hbk-btn-brass", root)[0]);
  await tick(5);
  const sec = q('.rhud-section[data-section="monsters"]', root);
  assert.equal(sec.hidden, false);
  assert.ok(sec.textContent.includes("olthoi"));
  const [name, prio] = qa(".rhud-row input", sec).slice(-2);
  name.value = "Mosswart";
  prio.value = "7";
  click(qa("button", sec).find((b) => b.textContent === "Add"));
  assert.equal(bot.combat.priorities.mosswart, 7);
  await tick(300);
  click(qa("button", sec).find((b) => b.textContent === "Add current target"));
  assert.equal(bot.combat.priorities["drudge skulker"], 7);
});

await check("Settings: 7 vitals thresholds drive vitals.cfg; Auto buffs; recovery spells", async () => {
  const root = document.getElementById("hb-rynth-hud");
  click(qa(".rhud-launch .hbk-btn-brass", root)[1]);
  await tick(5);
  const sec = q('.rhud-section[data-section="settings"]', root);
  const inputs = qa(".rhud-grid2 input", sec);
  assert.equal(inputs.length, 7);
  inputs[0].value = "66";
  inputs[0].dispatchEvent(new FakeEvent("change"));
  assert.equal(bot.vitals.cfg.healAtCombat, 66);
  assert.ok(qa("button", sec).some((b) => b.textContent === "Auto"));
  await tick(300);
  assert.match(sec.textContent, /Recovery spells — heal:/);
});

await check("Navigation: saved routes list + Follow; goto inputs", async () => {
  const root = document.getElementById("hb-rynth-hud");
  click(qa(".rhud-launch .hbk-btn-brass", root)[2]);
  await tick(20);
  const sec = q('.rhud-section[data-section="nav"]', root);
  assert.ok(sec.textContent.includes("Holtburg loop — 3 legs, 1 portal(s)"), sec.textContent);
  click(qa("button", sec).find((b) => b.textContent === "Follow"));
  await tick(20);
  assert.deepStrictEqual(bot.calls.find((c) => Array.isArray(c) && c[0] === "followRoute"), ["followRoute", 3, "Holtburg loop"]);
  const routeSel = qa(".rhud-selectors select", root)[1];
  assert.ok(routeSel.textContent.includes("Holtburg loop"), "header route selector filled");
});

await check("AI: the director panel (rynth/ai/ui.js) mounts INSIDE the section", async () => {
  const root = document.getElementById("hb-rynth-hud");
  click(qa(".rhud-launch .hbk-btn-brass", root)[3]);
  await tick(150);
  const sec = q('.rhud-section[data-section="ai"]', root);
  const host = q(".rhud-ai-host", sec);
  assert.ok(host.childNodes.length > 0, "panel mounted");
  assert.ok(host.textContent.includes("AI DIRECTOR") || host.textContent.length > 0);
  assert.ok(!document.body.childNodes.some((n) => n !== root && /AI DIRECTOR/.test(n.textContent || "")), "not left on <body>");
});

await check("Log: bridge transitions + AI journal", async () => {
  const root = document.getElementById("hb-rynth-hud");
  click(qa(".rhud-launch .hbk-btn-brass", root)[4]);
  await tick(300);
  const sec = q('.rhud-section[data-section="log"]', root);
  assert.match(sec.textContent, /STOP/);
  assert.match(sec.textContent, /\[plan\] hunt/);
  click(qa(".rhud-launch .hbk-btn-brass", root)[4]); // toggles closed
  assert.equal(sec.hidden, true);
});

await check("minimize, opacity, lock button text, Escape closes", async () => {
  const root = document.getElementById("hb-rynth-hud");
  const hdr = qa(".rhud-hdr-btn", q(".hbk-titlebar", root));
  const [lockB, fadeB, solidB, minB] = hdr;
  assert.equal(lockB.textContent, "Lock");
  click(fadeB);
  assert.equal(root.style.getPropertyValue("--rhud-alpha"), "0.85");
  click(solidB);
  assert.equal(root.style.getPropertyValue("--rhud-alpha"), "0.95");
  click(minB);
  assert.equal(root.dataset.min, "1");
  click(minB);
  assert.equal(root.dataset.min, "0");
  root.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }));
  assert.equal(root.dataset.open, "0");
  assert.equal(JSON.parse(localStorage.getItem("rynth.hud.ui.v1")).open, false);
});

await check("toolbar remount → the launcher re-attaches to the new column", () => {
  ({ addons } = makeHotbar());
  document.dispatchEvent(new FakeCustomEvent("hb-hotbar-mounted", { detail: { addons } }));
  assert.equal(document.getElementById("hb-rynth-hud-launcher").parentNode, addons);
});

await check("dispose removes the window, launcher and globals", () => {
  dispose();
  assert.equal(document.getElementById("hb-rynth-hud"), null);
  assert.equal(document.getElementById("hb-rynth-hud-launcher"), null);
  assert.equal(window.__toggleRynthHud, undefined);
});

await check("no toolbar → the launcher floats so the HUD stays reachable; reopen restores", () => {
  document.getElementById("hb-hotbar")?.remove();
  delete window.__hotbar;
  localStorage.setItem("rynth.hud.ui.v1", JSON.stringify({ open: true }));
  dispose = hud.mount();
  const b = document.getElementById("hb-rynth-hud-launcher");
  assert.equal(b.parentNode.id, "hb-rynth-hud-launcher-float");
  assert.equal(document.getElementById("hb-rynth-hud").dataset.open, "1", "persisted open state");
  dispose();
});

console.log(fail === 0 ? `rynth_hud_dom: all ${pass} checks passed` : `rynth_hud_dom: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
