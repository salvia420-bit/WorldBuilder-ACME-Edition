// tests/options_sound_prefs.test.mjs — audio-5 (2026-10-13): Options →
// Config → Sound carries retail's sound on/off preferences
// (SoundManager::InitPrefs, acclient.c 383284) as checkboxes, persisted in
// hb.options.audio.v1 and applied to the live AudioManager.
//
// Pins:
//   • three boolean rows — "Play sounds only when the game is active",
//     "Interface sounds", "Ambient sounds" — all on by default, and NO
//     interface-volume slider (retail's interface_sound_volume has no reader);
//   • ticking a box writes the boolean into hb.options.audio.v1 (next to the
//     sliders) and calls the AudioManager setter at once;
//   • a new AudioManager built from that storage starts with the saved prefs;
//   • a re-render shows the saved state; Cancel restores the opening state on
//     the live manager.
//
// Run from apps/holtburger-web/:
//   node tests/options_sound_prefs.test.mjs

import assert from "node:assert/strict";
import { installFakeDom, typeInto } from "./helpers/social_fake_dom.mjs";

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);
globalThis.__mainPanel = { closeView: () => {} };

const { AudioManager, AUDIO_SETTINGS_KEY } = await import("../scene3d/audio/audio_manager.js");
const panel = await import("../plugins/options-panel.js");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.stack || err.message}`); }
}

// A hidden tab: with the retail default the manager is inactive.
const listeners = {};
const doc = {
  hidden: true,
  hasFocus: () => true,
  addEventListener(t, f) { (listeners[t] ??= []).push(f); },
  removeEventListener(t, f) { listeners[t] = (listeners[t] ?? []).filter((g) => g !== f); },
};
const win = { addEventListener() {}, removeEventListener() {} };
const fetchWave = async () => { throw new Error("not used"); };
const am = new AudioManager({ fetchWave, hrtf: true, document: doc, window: win });
globalThis.liveScene3d = { audioManager: am };

const PLAY_ONLY = "Play sounds only when the game is active";
const IFACE = "Interface sounds";
const AMBIENT = "Ambient sounds";

const host = document.createElement("div");
document.body.appendChild(host);
let cleanup = panel.view.mount(host, { tab: "config" });

const labels = () => host.querySelectorAll("label").map((l) => l.textContent);
function box(label) {
  const lbl = host.querySelectorAll("label").find((l) => l.textContent === label);
  assert.ok(lbl, `row "${label}" rendered`);
  const cb = lbl.parentNode.querySelector("input");
  assert.ok(cb, `checkbox for "${label}"`);
  return cb;
}
const saved = () => JSON.parse(globalThis.localStorage.getItem(AUDIO_SETTINGS_KEY) || "{}");
const button = (label) => host.querySelectorAll("button").find((b) => b.textContent === label);

console.log("── audio-5: Options sound preferences ──");

check("three boolean rows, all on by default; no interface-volume slider", () => {
  for (const l of [PLAY_ONLY, IFACE, AMBIENT]) assert.equal(box(l).checked, true, l);
  assert.ok(!labels().some((l) => /interface (sound )?volume/i.test(l)), "no interface-volume row");
  assert.equal(am.isActive(), false, "retail default: hidden tab is inactive");
});

check("unticking 'Play sounds only when the game is active' saves it and activates the hidden tab", () => {
  box(PLAY_ONLY).click();
  assert.equal(saved().playOnlyWhenActive, false);
  assert.equal(am.isPlayOnlyWhenActive(), false);
  assert.equal(am.isActive(), true);
  assert.equal((listeners.visibilitychange ?? []).length, 0, "tracking removed");
});

check("unticking 'Interface sounds' / 'Ambient sounds' saves them and reaches the manager", () => {
  box(IFACE).click();
  box(AMBIENT).click();
  const s = saved();
  assert.equal(s.interfaceSounds, false);
  assert.equal(s.ambientSounds, false);
  assert.equal(am.isInterfaceSoundsEnabled(), false);
  assert.equal(am.isAmbientSoundsEnabled(), false);
});

check("the sliders share the object (a slider write keeps the booleans)", () => {
  const lbl = host.querySelectorAll("label").find((l) => l.textContent === "Master volume");
  const range = lbl.parentNode.querySelector("input");
  typeInto(range, "40");
  const s = saved();
  assert.equal(s.master, 0.4);
  assert.equal(s.playOnlyWhenActive, false);
  assert.equal(s.interfaceSounds, false);
  assert.equal(s.ambientSounds, false);
});

check("a new AudioManager built from the saved object starts with the prefs", () => {
  const am2 = new AudioManager({ fetchWave, hrtf: true, document: { ...doc, addEventListener() {} }, window: win });
  assert.equal(am2.isPlayOnlyWhenActive(), false);
  assert.equal(am2.isInterfaceSoundsEnabled(), false);
  assert.equal(am2.isAmbientSoundsEnabled(), false);
  assert.equal(am2.isActive(), true);
});

check("re-render shows the saved state", () => {
  cleanup?.();
  host.innerHTML = "";
  cleanup = panel.view.mount(host, { tab: "config" });
  for (const l of [PLAY_ONLY, IFACE, AMBIENT]) assert.equal(box(l).checked, false, l);
});

check("Cancel restores the opening state on the live manager", () => {
  // Open fresh with everything on, flip, cancel.
  cleanup?.();
  globalThis.localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify({ master: 1, effect: 1, ambient: 1 }));
  am.setPlayOnlyWhenActive(true);
  am.setInterfaceSoundsEnabled(true);
  am.setAmbientSoundsEnabled(true);
  host.innerHTML = "";
  cleanup = panel.view.mount(host, { tab: "config" });
  box(PLAY_ONLY).click();
  box(IFACE).click();
  box(AMBIENT).click();
  assert.equal(am.isActive(), true);
  button("Cancel").click();
  assert.equal(am.isPlayOnlyWhenActive(), true);
  assert.equal(am.isInterfaceSoundsEnabled(), true);
  assert.equal(am.isAmbientSoundsEnabled(), true);
  assert.equal(am.isActive(), false, "hidden tab inactive again");
  assert.equal(saved().playOnlyWhenActive, undefined, "storage snapshot restored");
  cleanup?.();
  cleanup = null;
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
