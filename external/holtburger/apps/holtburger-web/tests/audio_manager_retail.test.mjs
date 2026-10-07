// audio_manager_retail.test.mjs — AudioManager retail behaviours (round 2).
//
//  1. Silence while inactive — retail s_bPlaySoundOnlyWhenActive = true
//     (acclient.c:45633); PlaySoundInternal 383015/383160, PlaySoundA
//     383469/383494/383661/383687 and PlaySoundFromCenter 383575/383598 refuse new
//     sounds unless Device::m_bIsActiveApp. Old code: no gating at all.
//  2. Saved sliders at construction — hb.options.audio.v1 (written by
//     plugins/options-panel.js). Old code: master 1.0 / effect 1.0 / ambient
//     1.0 until the Audio tab was opened.
//  3. Slider applied twice where retail applies it twice (sliderTwice):
//     SoundHook 342190 -> PlaySoundA(gid) 383481 passes effect_sound_volume
//     as the volume, GetAttenuation 383092-383095 multiplies again; ambient
//     PlayAmbientSound(FromCenter) 383527/383551 + GetAttenuation is_ambient.
//     Old code: no such option (slider once).
//  4. HRTF-path cull follows GetAttenuation (volume x slider), not a fixed
//     88.91 m. Old code: a volume-10 sound at 150 m was culled; a sound at
//     60 m with the effect slider at 0.05 played.
//  5. From-centre gain is whole dB (ceil(log2*6.0206), 383098). Old code
//     (HRTF default): gain = raw volume, e.g. 0.7 instead of 2^(-3/6.0206).
//
// Run: node tests/audio_manager_retail.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";
import { installFakeAudio } from "./helpers/fake_audio_context.mjs";
import { linearGain } from "../scene3d/audio/retail_mixer.js";

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n    ${err.message}`); process.exitCode = 1; }
};
const near = (a, b, eps = 1e-6, m = "") => assert.ok(Math.abs(a - b) <= eps, `${m} ${a} vs ${b}`);

const fake = installFakeAudio();
const { AudioManager, loadSavedAudioGains, AUDIO_SETTINGS_KEY } = await import("../scene3d/audio/audio_manager.js");

function fakeDoc() {
  const l = {};
  return {
    hidden: false,
    focused: true,
    hasFocus() { return this.focused; },
    addEventListener(t, f) { (l[t] ??= []).push(f); },
    fire(t) { for (const f of l[t] ?? []) f(); },
  };
}
function fakeWin() {
  const l = {};
  return { addEventListener(t, f) { (l[t] ??= []).push(f); }, fire(t) { for (const f of l[t] ?? []) f(); } };
}
const mk = (extra = {}) => {
  const am = new AudioManager({ fetchWave: fake.fetchWave, hrtf: true, savedGains: false, ...extra });
  am.notifyUserGesture();
  am.setListener({ x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 });
  return am;
};

await test("hidden tab refuses new sounds; visible again plays", async () => {
  const doc = fakeDoc();
  const am = mk({ document: doc, window: fakeWin() });
  doc.hidden = true; doc.fire("visibilitychange");
  assert.equal(await am.playFromCenter(0x0a000001, 1), null);
  assert.equal(await am.play(0x0a000002, { x: 1, y: 0, z: 0 }, { gain: 1 }), null);
  assert.equal(am.inactiveSkipCount, 2);
  doc.hidden = false; doc.fire("visibilitychange");
  assert.ok(await am.playFromCenter(0x0a000003, 1));
});
await test("window blur: new sounds refused, playing ones MUTED (not stopped), restored on focus", async () => {
  // Round 3: retail buffers lack DSBCAPS_GLOBALFOCUS (acclient.c:385878-
  // 385928), so DirectSound mutes them on focus loss. Old code left the
  // playing tail audible (master gain stayed 1).
  const doc = fakeDoc();
  const win = fakeWin();
  const am = mk({ document: doc, window: win });
  am.setMasterGain(0.8);
  const h = await am.playFromCenter(0x0a000004, 1);
  assert.ok(h);
  win.fire("blur");
  assert.equal(await am.playFromCenter(0x0a000005, 1), null);
  assert.equal(h.source.stopped, false, "playing voice keeps running");
  near(am._master.gain.value, 0, 1e-9, "master muted while inactive");
  am.setMasterGain(0.6);
  near(am._master.gain.value, 0, 1e-9, "slider change while inactive stays muted");
  win.fire("focus");
  near(am._master.gain.value, 0.6, 1e-9, "master restored on focus");
  assert.ok(await am.playFromCenter(0x0a000006, 1));
});
await test("hidden tab mutes the master bus too", async () => {
  const doc = fakeDoc();
  const am = mk({ document: doc, window: fakeWin() });
  doc.hidden = true; doc.fire("visibilitychange");
  near(am._master.gain.value, 0, 1e-9);
  doc.hidden = false; doc.fire("visibilitychange");
  near(am._master.gain.value, 1, 1e-9);
});

await test("saved sliders are applied at construction", async () => {
  const storage = { getItem: (k) => (k === AUDIO_SETTINGS_KEY ? JSON.stringify({ master: 0.3, effect: 0.5, ambient: 0.25 }) : null) };
  assert.deepEqual(loadSavedAudioGains(storage), { master: 0.3, effect: 0.5, ambient: 0.25 });
  const am = new AudioManager({ fetchWave: fake.fetchWave, hrtf: true, storage, masterGain: 1.0 });
  am.notifyUserGesture();
  near(am._master.gain.value, 0.3, 1e-9, "master bus");
  near(am._effectMaster.gain.value, 0.5, 1e-9, "effect bus (HRTF carries the slider)");
  near(am._ambientMaster.gain.value, 0.25, 1e-9, "ambient bus");
});
await test("corrupt / missing saved sliders fall back to 1.0", () => {
  assert.deepEqual(loadSavedAudioGains({ getItem: () => "{nope" }), { master: 1, effect: 1, ambient: 1 });
  assert.deepEqual(loadSavedAudioGains({ getItem: () => null }), { master: 1, effect: 1, ambient: 1 });
});

await test("sliderTwice: from-centre gain carries the slider once more (HRTF bus carries the other)", async () => {
  const am = mk();
  am.setEffectGain(0.5);
  const once = await am.playFromCenter(0x0a000010, 1.0);
  const twice = await am.playFromCenter(0x0a000011, 1.0, { sliderTwice: true });
  near(once.gain.gain.value, 1.0);
  near(twice.gain.gain.value, linearGain(-6), 1e-6);
});
await test("sliderTwice: retail mix applies the ambient slider twice (0.5 -> -12 dB)", async () => {
  const am = new AudioManager({ fetchWave: fake.fetchWave, hrtf: false, savedGains: false });
  am.notifyUserGesture();
  am.setAmbientGain(0.5);
  const h = await am.playFromCenter(0x0a000012, 1.0, { category: "ambient", sliderTwice: true });
  near(h.gain.gain.value, linearGain(-12), 1e-6);
});
await test("sliderTwice: a slider at 0.1 drops below the floor sooner (retail audibility edge)", async () => {
  const am = mk();
  am.setEffectGain(0.1);
  // 0.1*0.1 = 0.01 = -40 dB at the centre: audible; at 20 m: 25/400 * 0.01 = -64 dB (once: -44 dB).
  assert.ok(await am.playFromCenter(0x0a000013, 1.0, { sliderTwice: true }));
  assert.equal(await am.play(0x0a000014, { x: 20, y: 0, z: 0 }, { gain: 1.0, sliderTwice: true }), null);
  assert.ok(await am.play(0x0a000015, { x: 20, y: 0, z: 0 }, { gain: 1.0 }), "without sliderTwice it plays");
});

await test("HRTF cull follows GetAttenuation: loud sound at 150 m plays, slider 0.05 at 60 m does not", async () => {
  const am = mk();
  assert.ok(await am.play(0x0a000020, { x: 150, y: 0, z: 0 }, { gain: 10 }), "volume 10 audible to ~298 m");
  assert.equal(await am.play(0x0a000021, { x: 95, y: 0, z: 0 }, { gain: 1 }), null, "volume 1 culled past ~94 m");
  am.setEffectGain(0.05);
  assert.equal(await am.play(0x0a000022, { x: 60, y: 0, z: 0 }, { gain: 1 }), null);
});
await test("from-centre gain is whole dB (0.7 -> -3 dB)", async () => {
  const am = mk();
  const h = await am.playFromCenter(0x0a000030, 0.7);
  near(h.gain.gain.value, linearGain(-3), 1e-6);
});

await test("decoded-buffer cache is a byte-budgeted LRU (2026-10-07)", async () => {
  const am = mk();
  am._initContext?.();
  am._ctx.decodeAudioData = async () => ({ length: 1_000_000, numberOfChannels: 1, duration: 1 }); // 4 MB
  am._bufferBudgetBytes = 10 * 1024 * 1024; // room for two
  await am._loadBuffer(0x0a000101);
  await am._loadBuffer(0x0a000102);
  await am._loadBuffer(0x0a000101); // touch → 0x102 is now least recent
  await am._loadBuffer(0x0a000103);
  await Promise.resolve();
  assert.ok(am._bufferCache.has(0x0a000101), "recently used kept");
  assert.ok(am._bufferCache.has(0x0a000103), "newest kept");
  assert.ok(!am._bufferCache.has(0x0a000102), "least recently used evicted");
  assert.equal(am._bufferBytesTotal, 8_000_000);
});
await test("a FETCH failure is retried later; a decode failure stays cached", async () => {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 0; }; // collapse the retry delay
  try {
    let calls = 0;
    const am = mk({
      fetchWave: async (did) => {
        calls += 1;
        if (calls === 1) throw new Error("prefetch: network");
        return fake.fetchWave(did);
      },
    });
    assert.equal(await am._loadBuffer(0x0a000201), null);
    await new Promise((r) => queueMicrotask(r));
    await new Promise((r) => queueMicrotask(r));
    assert.ok(!am._bufferCache.has(0x0a000201), "fetch-failure null evicted after the retry delay");
    assert.ok(await am._loadBuffer(0x0a000201), "retried and decoded");
    am._ctx.decodeAudioData = async () => { throw new Error("bad wav"); };
    assert.equal(await am._loadBuffer(0x0a000202), null);
    await new Promise((r) => queueMicrotask(r));
    assert.ok(am._bufferCache.has(0x0a000202), "decode-failure null stays cached");
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

fake.uninstall();
console.log(`\n${passed} passed${process.exitCode ? ", FAILURES above" : ""}`);
