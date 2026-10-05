// audio_retail_mixer.test.mjs — retail positional mix (gain curve + pan).
//
// Ported from OpenAC tests/AcDream.Core.Tests/Audio/RetailSoundMixerTests.cs
// (MIT), re-checked against acclient.c: GetAttenuation 383079-383118,
// PlaySoundInternal(Position) 383152-383180, Position::heading 467051-467062.
//
// Fails on the old code: retail_mixer.js did not exist, and the AudioManager
// block at the bottom asserts the retail (`?audioRetailPan=on`) play() path builds a
// StereoPannerNode with retail's fixed pan and puts the 25/d^2 integer-dB
// gain on the GainNode — the old path built an HRTF PannerNode, left the
// GainNode at 1.0 (distance handled inside the panner) and had no
// StereoPannerNode at all.
//
// Run: node tests/audio_retail_mixer.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";
import {
  getAttenuation, compassHeadingDegrees, normalizeSignedDegrees, mix,
  linearGain, stereoPositionFromPan, audibleRadius, VOL_MIN_DECIBELS,
  headingFromThreeQuaternion, threeToAc,
} from "../scene3d/audio/retail_mixer.js";
import { installFakeAudio } from "./helpers/fake_audio_context.mjs";

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n    ${err.message}`); process.exitCode = 1; }
};
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} ${a} vs ${b}`);
const V = (x, y, z = 0) => ({ x, y, z });
const O = V(0, 0, 0);

// ── GetAttenuation ──
for (const [d, db] of [[0, 0], [2, 0], [4.99, 0], [5, 0], [10, -12], [20, -24], [30, -31], [50, -40], [90, -50], [94, -50]]) {
  await test(`attenuation at ${d} m = ${db} dB`, () => {
    const a = getAttenuation(d, 1, 1);
    assert.equal(a.play, true);
    assert.equal(a.decibels, db);
  });
}
for (const d of [95, 120, 1000]) {
  await test(`beyond cutoff ${d} m does not play`, () => {
    const a = getAttenuation(d, 1, 1);
    assert.equal(a.play, false);
    assert.equal(a.decibels, VOL_MIN_DECIBELS);
  });
}
await test("inverse square, not inverse first power", () => {
  assert.equal(getAttenuation(10, 1, 1).decibels - getAttenuation(20, 1, 1).decibels, 12);
});
await test("clamps above unity", () => assert.equal(getAttenuation(1, 10, 1).decibels, 0));
await test("clamps before the master multiply", () => assert.equal(getAttenuation(1, 10, 0.5).decibels, -6));
await test("high volume extends audible radius", () => {
  assert.equal(getAttenuation(200, 1, 1).play, false);
  const loud = getAttenuation(200, 10, 1);
  assert.equal(loud.play, true);
  assert.equal(loud.decibels, -44);
});
for (const m of [0, -1]) {
  await test(`non-positive master ${m} does not play`, () => assert.equal(getAttenuation(1, 1, m).play, false));
}
await test("volume 0 is silent (retail v5 > 0 test, 383096)", () => assert.equal(getAttenuation(0, 0, 1).play, false));
await test("master applied exactly once", () => {
  assert.equal(getAttenuation(10, 1, 0.5).decibels - getAttenuation(10, 1, 1).decibels, -6);
});
for (const [scale, metres] of [[1, 94.2], [0.5, 66.6], [0.1, 29.8]]) {
  await test(`audible radius ${scale} = ${metres} m`, () => near(audibleRadius(scale, 1), metres, 0.06));
}
await test("audible radius agrees with the live predicate", () => {
  for (let v = 0.1; v <= 3; v += 0.1) {
    const r = audibleRadius(v, 1);
    assert.equal(getAttenuation(r - 0.5, v, 1).play, true, `v=${v}`);
    assert.equal(getAttenuation(r + 0.5, v, 1).play, false, `v=${v}`);
  }
});
await test("decibels are whole numbers quantised by ceil", () => {
  const seen = new Set();
  for (let d = 5; d < 94; d += 0.05) {
    const { decibels } = getAttenuation(d, 1, 1);
    assert.equal(decibels, Math.trunc(decibels));
    seen.add(decibels);
  }
  assert.ok(seen.size >= 40 && seen.size <= 51, `${seen.size}`);
});
await test("linear gain round-trips the dB scale", () => {
  near(linearGain(0), 1, 1e-5); near(linearGain(-6), 0.5, 0.01);
  near(linearGain(-12), 0.25, 0.01); near(linearGain(-50), 0.00316, 1e-5);
});

// ── heading + pan ──
for (const [dx, dy, h] of [[0, 1, 0], [1, 0, 90], [0, -1, 180], [-1, 0, 270]]) {
  await test(`compass heading (${dx},${dy}) = ${h}`, () => near(compassHeadingDegrees(O, V(dx, dy)), h, 0.01));
}
for (const [i, o] of [[0, 0], [180, 180], [181, -179], [270, -90], [359, -1], [-90, -90], [-270, -270]]) {
  await test(`normalizeSigned ${i} -> ${o}`, () => near(normalizeSignedDegrees(i), o, 1e-3));
}
await test("source due east of a north-facing listener is full right", () => assert.equal(mix(O, 0, V(10, 0), 1, 1).pan, 15));
await test("source due west is full left", () => assert.equal(mix(O, 0, V(-10, 0), 1, 1).pan, -15));
await test("no front/back distinction", () => {
  assert.equal(mix(O, 0, V(0, 10), 1, 1).pan, 0);
  assert.equal(mix(O, 0, V(0, -10), 1, 1).pan, 0);
});
await test("pan rotates with listener heading", () => assert.equal(mix(O, 90, V(10, 0), 1, 1).pan, 0));
for (const [d, p] of [[1, 0], [4.9, 0], [5, 15]]) {
  await test(`pan deadzone is an integer-metre test (${d} m -> ${p})`, () => assert.equal(mix(O, 0, V(d, 0), 1, 1).pan, p));
}
await test("elevation never contributes to pan", () => {
  const level = mix(O, 0, V(10, 0, 0), 1, 1);
  const high = mix(O, 0, V(10, 0, 40), 1, 1);
  assert.equal(level.pan, high.pan);
  assert.notEqual(level.decibels, high.decibels);
});
await test("purely vertical offset: Position::heading returns 0 (467058) -> centre", () => {
  const m = mix(O, 0, V(0, 0, 10), 1, 1);
  assert.equal(m.pan, 0);
  assert.equal(m.decibels, -12);
});
await test("panning disabled -> centre", () => assert.equal(mix(O, 0, V(10, 0), 1, 1, false).pan, 0));
await test("pan stays within +-15", () => {
  for (let deg = 0; deg < 360; deg++) {
    const r = deg * Math.PI / 180;
    const p = mix(O, 0, V(Math.sin(r) * 20, Math.cos(r) * 20), 1, 1).pan;
    assert.ok(p >= -15 && p <= 15);
  }
});
await test("beyond cutoff reports do-not-play", () => assert.equal(mix(O, 0, V(0, 200), 1, 1).play, false));
for (const [b, p] of [[64.158, 13], [-64.158, -13]]) {
  await test(`pan truncates toward zero (${b} deg -> ${p})`, () => {
    const r = b * Math.PI / 180;
    assert.equal(mix(O, 0, V(Math.sin(r) * 20, Math.cos(r) * 20), 1, 1).pan, p);
  });
}
await test("stereo position: centre is centre", () => near(stereoPositionFromPan(0), 0, 1e-4));
for (const pan of [15, -15]) {
  await test(`stereo position: full pan ${pan} stays inside the speaker angle`, () => {
    near(Math.abs(stereoPositionFromPan(pan)), 0.776, 1e-3);
  });
}
for (const pan of [0, 3, 7, 11, 15, -6, -15]) {
  await test(`stereo position reproduces ${pan} dB channel difference`, () => {
    const p = stereoPositionFromPan(pan);
    const a = (p + 1) * Math.PI / 4;
    near(20 * Math.log10(Math.sin(a) / Math.cos(a)), pan, 0.01);
  });
}
await test("stereo position is monotonic", () => {
  let prev = stereoPositionFromPan(-15);
  for (let pan = -14; pan <= 15; pan++) {
    const c = stereoPositionFromPan(pan);
    assert.ok(c > prev);
    prev = c;
  }
});

// ── three.js frame bridge ──
await test("three.js camera looking down -Z faces AC north (heading 0)", () => {
  near(headingFromThreeQuaternion({ w: 1, x: 0, y: 0, z: 0 }), 0, 1e-6);
});
await test("three.js camera yawed -90 deg about +Y faces AC east (heading 90)", () => {
  const h = -Math.PI / 4; // half-angle of -90 deg
  near(headingFromThreeQuaternion({ w: Math.cos(h), x: 0, y: Math.sin(h), z: 0 }), 90, 1e-6);
});
await test("threeToAc inverts acToThree (x, z, -y)", () => {
  assert.deepEqual(threeToAc({ x: 1, y: 3, z: -2 }), { x: 1, y: 2, z: 3 });
});

// ── AudioManager ?audioRetailPan=on path uses the retail mix ──
await test("?audioRetailPan=on AudioManager.play: StereoPanner with fixed retail pan + 25/d^2 integer-dB gain", async () => {
  const fake = installFakeAudio();
  const { AudioManager } = await import("../scene3d/audio/audio_manager.js");
  const am = new AudioManager({ fetchWave: fake.fetchWave, hrtf: false });
  am.notifyUserGesture();
  // Listener at the origin facing AC north; source 10 m AC-east = three (10, 0, 0).
  am.setListener({ x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 });
  const h = await am.play(0x0A000001, { x: 10, y: 0, z: 0 }, { gain: 1.0 });
  assert.ok(h, "played");
  assert.equal(h.panner?.kind, "stereo", "StereoPannerNode, not HRTF PannerNode");
  near(h.panner.pan.value, stereoPositionFromPan(15), 1e-6, "full right");
  near(h.gain.gain.value, linearGain(-12), 1e-6, "-12 dB at 10 m");
  // 100 m north: below -50 dB -> not started.
  assert.equal(await am.play(0x0A000002, { x: 0, y: 0, z: -100 }, { gain: 1.0 }), null);
  // gain 0 is silent, not 1.0.
  assert.equal(await am.play(0x0A000003, { x: 0, y: 0, z: -1 }, { gain: 0 }), null);
  fake.uninstall();
});
await test("AudioManager.playFromCenter: no panner, effect slider folded into dB", async () => {
  const fake = installFakeAudio();
  const { AudioManager } = await import("../scene3d/audio/audio_manager.js");
  const am = new AudioManager({ fetchWave: fake.fetchWave, hrtf: false });
  am.notifyUserGesture();
  am.setEffectGain(0.5);
  const h = await am.playFromCenter(0x0A000010, 1.0);
  assert.equal(h.panner, null);
  near(h.gain.gain.value, linearGain(-6), 1e-6);
  assert.equal(await am.playFromCenter(0x0A000011, 0), null, "volume 0 silent");
  fake.uninstall();
});
await test("default (no ?audioRetailPan) keeps the HRTF PannerNode path", async () => {
  const fake = installFakeAudio();
  const { AudioManager } = await import("../scene3d/audio/audio_manager.js");
  const am = new AudioManager({ fetchWave: fake.fetchWave });
  am.notifyUserGesture();
  const h = await am.play(0x0A000020, { x: 10, y: 0, z: 0 }, { gain: 1.0 });
  assert.equal(h.panner.kind, "panner");
  assert.equal(h.panner.panningModel, "HRTF");
  fake.uninstall();
});

console.log(`\n${passed} passed${process.exitCode ? ", FAILURES above" : ""}`);
