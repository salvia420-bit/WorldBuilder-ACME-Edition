// audio_sound_prefs.test.mjs — audio-5 (2026-10-13): retail's sound on/off
// preferences, now set from Options → Config → Sound.
//
// Retail SoundManager::InitPrefs (acclient.c 383284) registers "Interface
// Sound Disabled", "Ambient Sound Disabled" and "Play Sound Only When Active"
// over interface_sounds_enabled / ambient_sounds_enabled /
// s_bPlaySoundOnlyWhenActive (all true, 45629-45633). Readers:
// PlaySoundFromCenter 383575/383598 (interface), PlayAmbientSound(FromCenter)
// 383525/383549 + Ambient::UseTime 384517 (ambient), and every play path's
// `!s_bPlaySoundOnlyWhenActive || m_bIsActiveApp` test.
//
//  1. setPlayOnlyWhenActive(false) removes the visibility/focus tracking, so a
//     hidden tab plays; true re-installs it; `?audioWhenInactive=on` wins.
//     Old code: the tracking was fixed at construction (URL flag only).
//  2. loadSavedAudioPrefs reads the booleans from hb.options.audio.v1
//     (default true) and the AudioManager applies them at construction;
//     loadSavedAudioGains keeps its { master, effect, ambient } shape.
//  3. Interface sounds off → playUiSound / playSoundFromCenter make no
//     playFromCenter call (and resolve nothing).
//  4. Ambient sounds off → `category: "ambient"` plays refused, and
//     AmbientRuntime.tick plays nothing but fast-forwards its queue, so
//     turning it back on does not fire every overdue sound at once.
//
// Run: node tests/audio_sound_prefs.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";
import { installFakeAudio } from "./helpers/fake_audio_context.mjs";

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n    ${err.stack || err.message}`); process.exitCode = 1; }
};
const near = (a, b, eps = 1e-6, m = "") => assert.ok(Math.abs(a - b) <= eps, `${m} ${a} vs ${b}`);

const fake = installFakeAudio();
const {
  AudioManager, loadSavedAudioGains, loadSavedAudioPrefs, AUDIO_SETTINGS_KEY, AUDIO_PREF_DEFAULTS,
} = await import("../scene3d/audio/audio_manager.js");
const { playUiSound, playSoundFromCenter } = await import("../scene3d/audio/retail_sound_rules.js");
const { AmbientRuntime } = await import("../scene3d/audio/ambient_runtime.js");

function fakeDoc({ hidden = false } = {}) {
  const l = {};
  return {
    hidden,
    focused: true,
    hasFocus() { return this.focused; },
    addEventListener(t, f) { (l[t] ??= []).push(f); },
    removeEventListener(t, f) { l[t] = (l[t] ?? []).filter((g) => g !== f); },
    count(t) { return (l[t] ?? []).length; },
    fire(t) { for (const f of [...(l[t] ?? [])]) f(); },
  };
}
function fakeWin() {
  const l = {};
  return {
    addEventListener(t, f) { (l[t] ??= []).push(f); },
    removeEventListener(t, f) { l[t] = (l[t] ?? []).filter((g) => g !== f); },
    count(t) { return (l[t] ?? []).length; },
    fire(t) { for (const f of [...(l[t] ?? [])]) f(); },
  };
}
const store = (obj) => ({ getItem: (k) => (k === AUDIO_SETTINGS_KEY && obj ? JSON.stringify(obj) : null) });
const mk = (extra = {}) => {
  const am = new AudioManager({ fetchWave: fake.fetchWave, hrtf: true, savedGains: false, ...extra });
  am.notifyUserGesture();
  am.setListener({ x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 });
  return am;
};

// ── 1. Play only when active ────────────────────────────────────────────
await test("setPlayOnlyWhenActive(false): a hidden tab is active and plays; tracking removed", async () => {
  const doc = fakeDoc({ hidden: true });
  const win = fakeWin();
  const am = mk({ document: doc, window: win });
  assert.equal(am.isActive(), false, "hidden at construction → inactive (retail default)");
  assert.equal(await am.playFromCenter(0x0a000001, 1), null);
  near(am._master.gain.value, 0, 1e-9, "master muted while inactive");
  am.setPlayOnlyWhenActive(false);
  assert.equal(am.isPlayOnlyWhenActive(), false);
  assert.equal(am.isActive(), true);
  near(am._master.gain.value, 1, 1e-9, "master restored");
  assert.ok(await am.playFromCenter(0x0a000002, 1), "plays while hidden");
  assert.ok(await am.play(0x0a000003, { x: 1, y: 0, z: 0 }, { gain: 1 }), "positional too");
  assert.equal(doc.count("visibilitychange"), 0, "visibility listener removed");
  assert.equal(win.count("focus") + win.count("blur"), 0, "focus/blur listeners removed");
  win.fire("blur");
  assert.equal(am.isActive(), true, "a blur no longer deactivates");
});

await test("setPlayOnlyWhenActive(true) re-installs tracking once: hidden → inactive, visible → active", async () => {
  const doc = fakeDoc({ hidden: true });
  const win = fakeWin();
  const am = mk({ document: doc, window: win });
  am.setPlayOnlyWhenActive(false);
  am.setPlayOnlyWhenActive(true);
  assert.equal(am.isActive(), false, "re-reads the hidden state at once");
  assert.equal(await am.playFromCenter(0x0a000010, 1), null);
  am.setPlayOnlyWhenActive(true); // idempotent (Options re-applies on every render)
  assert.equal(doc.count("visibilitychange"), 1, "no duplicate listeners");
  assert.equal(win.count("blur"), 1);
  doc.hidden = false; doc.fire("visibilitychange");
  assert.equal(am.isActive(), true);
  assert.ok(await am.playFromCenter(0x0a000011, 1));
  win.fire("blur");
  assert.equal(am.isActive(), false, "blur deactivates again");
});

await test("setPlayOnlyWhenActive(false) bumps activityEpoch when it reactivates (ambient fast-forward cue)", () => {
  const doc = fakeDoc({ hidden: true });
  const am = mk({ document: doc, window: fakeWin() });
  const before = am.activityEpoch | 0;
  am.setPlayOnlyWhenActive(false);
  assert.equal(am.activityEpoch | 0, before + 1);
});

await test("?audioWhenInactive=on overrides the preference", async () => {
  const prev = globalThis.location;
  globalThis.location = { search: "?audioWhenInactive=on" };
  try {
    const doc = fakeDoc({ hidden: true });
    const win = fakeWin();
    const am = mk({ document: doc, window: win });
    assert.equal(am.isActive(), true, "no tracking at construction");
    am.setPlayOnlyWhenActive(true);
    assert.equal(am.isActive(), true, "the setter does not install tracking either");
    assert.equal(doc.count("visibilitychange"), 0);
    assert.ok(await am.playFromCenter(0x0a000020, 1));
  } finally {
    if (prev === undefined) delete globalThis.location; else globalThis.location = prev;
  }
});

// ── 2. Persistence (hb.options.audio.v1) ────────────────────────────────
await test("loadSavedAudioPrefs: booleans round-trip; missing / corrupt / non-boolean → true", () => {
  assert.deepEqual(AUDIO_PREF_DEFAULTS, { playOnlyWhenActive: true, interfaceSounds: true, ambientSounds: true });
  const saved = { master: 0.4, playOnlyWhenActive: false, interfaceSounds: false, ambientSounds: true };
  assert.deepEqual(loadSavedAudioPrefs(store(saved)),
    { playOnlyWhenActive: false, interfaceSounds: false, ambientSounds: true });
  assert.deepEqual(loadSavedAudioPrefs(store(null)), { ...AUDIO_PREF_DEFAULTS });
  assert.deepEqual(loadSavedAudioPrefs({ getItem: () => "{nope" }), { ...AUDIO_PREF_DEFAULTS });
  assert.deepEqual(loadSavedAudioPrefs(store({ playOnlyWhenActive: 0, interfaceSounds: "false", ambientSounds: null })),
    { ...AUDIO_PREF_DEFAULTS }, "only real booleans count");
  // The gains loader keeps its shape alongside the new keys.
  assert.deepEqual(loadSavedAudioGains(store(saved)), { master: 0.4, effect: 1, ambient: 1 });
});

await test("saved prefs apply at construction (hidden tab plays when playOnlyWhenActive=false)", async () => {
  const doc = fakeDoc({ hidden: true });
  const storage = store({ playOnlyWhenActive: false, interfaceSounds: false, ambientSounds: false });
  const am = new AudioManager({ fetchWave: fake.fetchWave, hrtf: true, storage, document: doc, window: fakeWin() });
  am.notifyUserGesture();
  assert.equal(am.isPlayOnlyWhenActive(), false);
  assert.equal(am.isInterfaceSoundsEnabled(), false);
  assert.equal(am.isAmbientSoundsEnabled(), false);
  assert.equal(am.isActive(), true);
  assert.equal(doc.count("visibilitychange"), 0, "no tracking installed");
  assert.ok(await am.playFromCenter(0x0a000030, 1));
  const dflt = new AudioManager({ fetchWave: fake.fetchWave, hrtf: true, storage: store(null), document: fakeDoc({ hidden: true }), window: fakeWin() });
  assert.equal(dflt.isActive(), false, "default stays retail (inactive when hidden)");
  assert.equal(dflt.isInterfaceSoundsEnabled(), true);
  assert.equal(dflt.isAmbientSoundsEnabled(), true);
});

// ── 3. Interface sounds ────────────────────────────────────────────────
function liveFor(am) {
  const centre = [];
  const resolves = [];
  const orig = am.playFromCenter.bind(am);
  am.playFromCenter = (did, vol, opts) => { centre.push(did); return orig(did, vol, opts); };
  return {
    centre,
    resolves,
    live: {
      audioManager: am,
      soundTableCache: {
        async resolveSound(stb, st) { resolves.push([stb, st]); return { waveDid: 0x0a000000 + st, volume: 1, probability: 1 }; },
      },
    },
  };
}

await test("interface sounds off: playUiSound / playSoundFromCenter make no playFromCenter call", async () => {
  const am = mk();
  const { live, centre, resolves } = liveFor(am);
  assert.ok(await playUiSound(live, 0x72, { rng: () => 0 }), "on by default: the click plays");
  assert.equal(centre.length, 1);
  am.setInterfaceSoundsEnabled(false);
  assert.equal(am.isInterfaceSoundsEnabled(), false);
  centre.length = 0; resolves.length = 0;
  assert.equal(await playUiSound(live, 0x72, { rng: () => 0 }), null);
  assert.equal(await playSoundFromCenter(live, 0x2000004b, 0x85, { rng: () => 0 }), null, "Environs override path too");
  assert.equal(centre.length, 0, "no playFromCenter");
  assert.equal(resolves.length, 0, "gate is checked before GetSound");
  am.setInterfaceSoundsEnabled(true);
  assert.ok(await playUiSound(live, 0x72, { rng: () => 0 }));
});

await test("interface sounds off does not touch effect / positional sounds", async () => {
  const am = mk();
  am.setInterfaceSoundsEnabled(false);
  assert.ok(await am.play(0x0a000040, { x: 1, y: 0, z: 0 }, { gain: 1 }));
  assert.ok(await am.playFromCenter(0x0a000041, 1), "direct playFromCenter is not the interface gate");
});

// ── 4. Ambient sounds ──────────────────────────────────────────────────
await test("ambient sounds off: category ambient refused (play + playFromCenter), effect still plays", async () => {
  const am = mk();
  am.setAmbientSoundsEnabled(false);
  const skips = am.skipCount;
  assert.equal(await am.playFromCenter(0x0a000050, 1, { category: "ambient", sliderTwice: true }), null);
  assert.equal(await am.play(0x0a000051, { x: 1, y: 0, z: 0 }, { gain: 1, category: "ambient" }), null);
  assert.equal(am.skipCount, skips + 2);
  assert.ok(await am.playFromCenter(0x0a000052, 1), "effect from the centre");
  assert.ok(await am.play(0x0a000053, { x: 1, y: 0, z: 0 }, { gain: 1 }), "effect positional");
  am.setAmbientSoundsEnabled(true);
  assert.ok(await am.playFromCenter(0x0a000054, 1, { category: "ambient" }));
});

// Every vertex is STB 0x20000017: a continuous bed (70, every 5 s) and an
// always-on intermittent (71, every 1 s) — the test_ambient_baked.mjs set.
const ALL_VERTS = Array.from({ length: 81 }, (_, i) => i);
const TRIGGERS = [{
  stbId: 0x20000017,
  vertexIndices: ALL_VERTS,
  ambientSounds: [
    { sType: 70, volume: 0.6, baseChance: 0.0, minRate: 5, maxRate: 5, isContinuous: true },
    { sType: 71, volume: 0.5, baseChance: 1.0, minRate: 1, maxRate: 1, isContinuous: false },
  ],
}];
function makeRuntime() {
  const calls = [];
  const state = { clockMs: 0, enabled: true };
  const audioManager = {
    activityEpoch: 0,
    isActive: () => true,
    isAmbientSoundsEnabled: () => state.enabled,
    async play(did) { calls.push(did); return {}; },
    async playFromCenter(did) { calls.push(did); return {}; },
  };
  const rt = new AmbientRuntime({
    soundTableCache: { async resolveSound(_s, t) { return { waveDid: 0x0a000000 + t, volume: 1, probability: 1 }; } },
    audioManager,
    getPlayerPos: () => ({ x: 96, y: 96, z: 50 }),
    getRegion: () => ({}),
    getBakedAmbientTriggers: () => TRIGGERS,
    rng: () => 0.0,
    clock: () => state.clockMs,
  });
  return { rt, calls, state };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

await test("ambient off from the start: tick plays nothing", async () => {
  const { rt, calls, state } = makeRuntime();
  state.enabled = false;
  for (const t of [0, 1000, 6000, 12000]) { state.clockMs = t; rt.tick(0); }
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(rt.stats().skippedDisabled, 4);
});

await test("ambient off then on: no plays while off, no burst on re-enable, cadence resumes", async () => {
  const { rt, calls, state } = makeRuntime();
  rt.tick(0); await flush();
  assert.ok(calls.length > 0, "playing while on");
  calls.length = 0;
  state.enabled = false;
  // Frames keep running while the option is off.
  for (let t = 1000; t <= 30000; t += 1000) { state.clockMs = t; rt.tick(0); }
  state.clockMs = 30020; rt.tick(0); // last frame before the box is ticked again
  await flush();
  assert.equal(calls.length, 0, "nothing plays while off");
  const ffs = rt.fastForwardCount | 0;
  assert.ok(ffs > 0, "queue fast-forwarded while off");
  state.enabled = true;
  state.clockMs = 30050; rt.tick(0); await flush();
  assert.equal(calls.length, 0, "first tick back: no overdue burst (retail's freeze would fire them all)");
  state.clockMs = 35100; rt.tick(0); await flush();
  assert.ok(calls.includes(0x0a000000 + 70), "the bed resumes at its cadence");
});

await test("a manager without isAmbientSoundsEnabled (older fake) still plays", async () => {
  const { rt, calls } = makeRuntime();
  delete rt._audioManager.isAmbientSoundsEnabled;
  rt.tick(0); await flush();
  assert.ok(calls.length > 0);
});

fake.uninstall();
console.log(`\n${passed} passed${process.exitCode ? ", FAILURES above" : ""}`);
