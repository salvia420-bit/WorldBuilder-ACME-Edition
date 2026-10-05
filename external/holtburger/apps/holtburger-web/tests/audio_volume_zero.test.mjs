// audio_volume_zero.test.mjs — an authored sound volume of 0 is SILENT.
//
// Retail GetAttenuation (acclient.c:383079-383118) only plays when the
// effective volume is > 0; SoundTweakedHook passes its `vol` straight
// through (342207-342209) and SoundTableHook / PlaySoundFromCenter use the
// row volume (383681-383703, 383569-383589). The client used the idiom
// `v > 0 ? v : 1.0`, which turned every silent row/hook into a FULL-volume
// one.
//
// Fails on the old code: the source scan below finds that idiom at the
// sound sites in scene3d/entities.js (4), app/client_events.js (2),
// plugins/ui_click_sounds.js and plugins/audio_optimistic.js; and
// AudioManager.play(…, {gain: 0}) used to start a voice (gain snapped to 0
// but the voice was spent) — it now returns null.
//
// Run: node tests/audio_volume_zero.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { retailVolume } from "../scene3d/audio/retail_sound_rules.js";
import { installFakeAudio } from "./helpers/fake_audio_context.mjs";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ok  ${name}`); };

assert.equal(retailVolume(0), 0);
assert.equal(retailVolume(undefined), 1.0);
ok("retailVolume keeps 0, defaults only a missing value");

const IDIOM = /\b(?:entry\.volume|soundVolume|e\.soundVolume|desc\.soundVolume|hook\.soundVolume)\s*>\s*0\s*\?/;
for (const rel of ["scene3d/entities.js", "app/client_events.js", "plugins/ui_click_sounds.js", "plugins/audio_optimistic.js"]) {
  const src = readFileSync(path.join(APP, rel), "utf8");
  const hits = src.split("\n").filter((l) => IDIOM.test(l) && !l.trim().startsWith("//"));
  assert.deepEqual(hits, [], `${rel} still maps volume 0 to 1.0:\n${hits.join("\n")}`);
  ok(`${rel}: no 'volume > 0 ? volume : 1.0' at sound sites`);
}

for (const hrtf of [true, false]) {
  const fake = installFakeAudio();
  const { AudioManager } = await import("../scene3d/audio/audio_manager.js");
  const am = new AudioManager({ fetchWave: fake.fetchWave, hrtf });
  am.notifyUserGesture();
  am.setListener({ x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 });
  assert.equal(await am.play(0x0a000001, { x: 1, y: 0, z: 0 }, { gain: 0 }), null);
  assert.equal(await am.playFromCenter(0x0a000002, 0), null);
  assert.equal(fake.started().length, 0);
  fake.uninstall();
  ok(`AudioManager (${hrtf ? "HRTF default" : "?audioRetailPan=on"}): gain 0 starts no voice`);
}

console.log(`\n${passed} passed`);
