// Plain SoundHook (hook type 1) plays with the effect slider applied twice, as
// retail: SoundHook::Execute → PlaySoundA(gid, obj) passes effect_sound_volume
// as the volume (acclient.c:342190 → 383481) and GetAttenuation multiplies by
// it again (383092-383095). SoundTweaked (21) passes its own volume, so once.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, "..", "scene3d", "entities.js"), "utf8");

test("every SoundHook/SoundTweaked play() site passes sliderTwice for type 1 only", () => {
  assert.match(src, /sliderTwice: ht === 1 \}/, "_firePlayEffectSoundHook");
  assert.match(src, /sliderTwice: e\.hookType === 1 \}/, "script-attach hook arm");
  assert.match(src, /\{ sliderTwice: true \}\)/, "Sound(1) animation hook");
});

test("AudioManager squares the effect slider when sliderTwice is set", async () => {
  const mod = await import("../scene3d/audio/audio_manager.js");
  const AudioManager = mod.AudioManager ?? mod.default;
  assert.equal(typeof AudioManager, "function");
  const amSrc = fs.readFileSync(path.join(HERE, "..", "scene3d", "audio", "audio_manager.js"), "utf8");
  assert.match(amSrc, /opts\.sliderTwice/);
});

// Round 3: drive play() on a fake AudioContext and measure the effective
// gain (voice GainNode x effect bus). Old test only grepped the source.
test("play(): effective gain = slider^2 with sliderTwice, slider without", async () => {
  const { installFakeAudio } = await import("./helpers/fake_audio_context.mjs");
  const fake = installFakeAudio();
  const { AudioManager } = await import("../scene3d/audio/audio_manager.js");
  for (const hrtf of [true, false]) {
    const am = new AudioManager({ fetchWave: fake.fetchWave, hrtf, savedGains: false });
    am.notifyUserGesture();
    am.setListener({ x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 });
    am.setEffectGain(0.5);
    const at = { x: 1, y: 0, z: 0 }; // inside 5 m: no distance falloff
    const twice = await am.play(0x0a000001, at, { gain: 1.0, sliderTwice: true });
    const once = await am.play(0x0a000002, at, { gain: 1.0 });
    const bus = am._effectMaster.gain.value;
    const eff = (h) => h.gain.gain.value * bus;
    // Whole-dB quantisation: 0.25 -> -12 dB, 0.5 -> -6 dB (ceil(log2*6.0206)).
    const db = (g) => Math.pow(10, Math.ceil(Math.log2(g) * 6.0206) / 20);
    const tol = 0.01;
    assert.ok(Math.abs(eff(twice) - db(0.25)) < tol, `${hrtf ? "HRTF" : "retail"} twice ${eff(twice)} vs ${db(0.25)}`);
    assert.ok(Math.abs(eff(once) - db(0.5)) < tol, `${hrtf ? "HRTF" : "retail"} once ${eff(once)} vs ${db(0.5)}`);
  }
  fake.uninstall();
});
