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
