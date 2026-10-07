// audio_voice_pool.test.mjs — retail 16-voice sound pool.
//
// Ported from OpenAC tests/AcDream.Core.Tests/Audio/RetailVoicePoolTests.cs
// (MIT). Retail: SoundManager::PlaySoundInternal (acclient.c:383004-383067).
//
// Fails on the old code: scene3d/audio/voice_pool.js did not exist and
// AudioManager.play() started every sound with no voice limit — the last
// block below drives a real AudioManager with 17 concurrent sounds and
// asserts the 17th is dropped (old code: 17 sources started).
//
// Run: node tests/audio_voice_pool.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";
import {
  acquireVoice, advanceCursor, NO_SLOT, VOICE_COUNT, VOICE_PRIORITY, VoicePool,
} from "../scene3d/audio/voice_pool.js";
import { installFakeAudio } from "./helpers/fake_audio_context.mjs";

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n    ${err.message}`); process.exitCode = 1; }
};

const Free = () => ({ occupied: false, stillPlaying: false, priority: 0 });
const Finished = (p) => ({ occupied: true, stillPlaying: false, priority: p });
const Busy = (p) => ({ occupied: true, stillPlaying: true, priority: p });
const AllBusy = (p, n = 16) => Array.from({ length: n }, () => Busy(p));

await test("empty pool drops the sound", () => {
  assert.equal(acquireVoice([], 0, 1), NO_SLOT);
});
await test("first pass prefers a free slot scanning from the cursor", () => {
  const s = AllBusy(1); s[9] = Free();
  assert.equal(acquireVoice(s, 0, 0), 9);
});
await test("first pass reclaims a finished voice even at higher priority", () => {
  const s = AllBusy(1); s[4] = Finished(1);
  assert.equal(acquireVoice(s, 0, 0.1), 4);
});
await test("first pass wraps around the ring", () => {
  const s = AllBusy(1); s[2] = Free();
  assert.equal(acquireVoice(s, 5, 0), 2);
});
await test("first pass takes the nearest free slot in ring order", () => {
  const s = AllBusy(1); s[1] = Free(); s[12] = Free();
  assert.equal(acquireVoice(s, 10, 0), 12);
});
await test("second pass evicts strictly lower priority", () => {
  const s = AllBusy(0.5); s[7] = Busy(0.2);
  assert.equal(acquireVoice(s, 0, 0.3), 7);
});
await test("second pass: equal priority never evicts", () => {
  assert.equal(acquireVoice(AllBusy(0.5), 0, 0.5), NO_SLOT);
});
await test("second pass: higher-priority pool drops the new sound", () => {
  assert.equal(acquireVoice(AllBusy(0.9), 0, 0.4), NO_SLOT);
});
await test("second pass takes the first lower slot in ring order, not the lowest", () => {
  const s = AllBusy(0.9); s[3] = Busy(0.1); s[6] = Busy(0.5);
  assert.equal(acquireVoice(s, 6, 0.6), 6);
});
for (const [claimed, expected] of [[0, 1], [15, 0], [9, 10]]) {
  await test(`cursor advances past ${claimed} -> ${expected}`, () => {
    assert.equal(advanceCursor(claimed, 16), expected);
  });
}
await test("ring order is stable across repeated claims", () => {
  const s = Array.from({ length: 4 }, Free);
  let cursor = 0; const claimed = [];
  for (let i = 0; i < 4; i++) {
    claimed.push(acquireVoice(s, cursor, 1));
    cursor = advanceCursor(claimed[i], 4);
  }
  assert.deepEqual(claimed, [0, 1, 2, 3]);
});

await test("VoicePool: retail constant priority => 17th concurrent sound dropped", () => {
  const pool = new VoicePool();
  assert.equal(VOICE_COUNT, 16);
  const stopped = [];
  const tokens = [];
  for (let i = 0; i < 16; i++) tokens.push(pool.claim({ stop: () => stopped.push(i) }, VOICE_PRIORITY));
  assert.ok(tokens.every((t) => t > 0));
  assert.equal(pool.claim({ stop() {} }, VOICE_PRIORITY), 0, "17th must drop");
  assert.equal(stopped.length, 0, "no playing voice is cut short");
  pool.release(tokens[5]);
  assert.ok(pool.claim({ stop() {} }) > 0, "a finished voice frees its slot");
});
await test("VoicePool: strictly higher priority steals and stops the victim", () => {
  const pool = new VoicePool(2);
  let stopped = 0;
  pool.claim({ stop: () => { stopped++; } }, 0);
  pool.claim({ stop: () => { stopped++; } }, 0);
  assert.ok(pool.claim({ stop() {} }, 1) > 0);
  assert.equal(stopped, 1);
  assert.equal(pool.stealCount, 1);
});

await test("AudioManager: 17 concurrent one-shots -> 16 start, 17th dropped; ended voice frees a slot", async () => {
  const fake = installFakeAudio();
  const { AudioManager } = await import("../scene3d/audio/audio_manager.js");
  const am = new AudioManager({ fetchWave: fake.fetchWave, hrtf: false });
  am.notifyUserGesture();
  const handles = [];
  for (let i = 0; i < 17; i++) handles.push(await am.playFromCenter(0x0A000001 + i, 1.0));
  assert.equal(fake.started().length, 16, `started=${fake.started().length}`);
  assert.equal(handles[16], null);
  handles[0].source.onended();
  assert.ok(await am.playFromCenter(0x0A000100, 1.0), "slot reused after a voice ended");
  fake.uninstall();
});

// Bug 8 (2026-10-07) — OpenAC's per-wave cap (VoiceAllocation
// .TryTakeOldestOfOneSound, AudioMixerOptions.DefaultMaxVoicesPerWave = 4).
await test("per-wave cap: a fifth copy of one wave replaces its oldest copy", () => {
  const pool = new VoicePool(16, 4);
  const stopped = [];
  const W = 0x0a00042e;
  for (let i = 0; i < 4; i++) pool.claim({ stop: () => stopped.push(i) }, VOICE_PRIORITY, W);
  assert.equal(pool.copiesOf(W), 4);
  const t5 = pool.claim({ stop: () => stopped.push(4) }, VOICE_PRIORITY, W);
  assert.ok(t5 > 0, "the fifth copy plays");
  assert.deepEqual(stopped, [0], "the oldest copy was stopped");
  assert.equal(pool.copiesOf(W), 4, "still four copies");
  assert.equal(pool.waveCapCount, 1);
  // Other waves still get free voices.
  assert.ok(pool.claim({ stop() {} }, VOICE_PRIORITY, 0x0a000001) > 0);
  assert.equal(pool.activeCount(), 5);
});

await test("per-wave cap off (retailMixer) keeps the shipped behaviour", () => {
  const pool = new VoicePool(16, 0);
  const W = 0x0a00042e;
  for (let i = 0; i < 6; i++) pool.claim({ stop() {} }, VOICE_PRIORITY, W);
  assert.equal(pool.copiesOf(W), 6);
  assert.equal(pool.waveCapCount, 0);
});

await test("acquireVoice: the cap only counts PLAYING copies of the same wave", () => {
  const W = 7;
  const slots = [
    { occupied: true, stillPlaying: true, priority: 0, waveId: W, startedAt: 2 },
    { occupied: true, stillPlaying: false, priority: 0, waveId: W, startedAt: 1 },
    { occupied: true, stillPlaying: true, priority: 0, waveId: 9, startedAt: 0 },
    { occupied: false, stillPlaying: false, priority: 0, waveId: 0, startedAt: 0 },
  ];
  assert.equal(acquireVoice(slots, 0, 0, W, 1), 0, "at the cap of 1 → its own playing copy");
  assert.equal(acquireVoice(slots, 0, 0, W, 2), 1, "under the cap → the normal free/finished slot");
});

console.log(`\n${passed} passed${process.exitCode ? ", FAILURES above" : ""}`);
