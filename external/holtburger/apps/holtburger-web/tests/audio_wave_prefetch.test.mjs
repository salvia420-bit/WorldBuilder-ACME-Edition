// tests/audio_wave_prefetch.test.mjs — audio-1 part 2 (2026-10-13).
//
// Retail CreateSound analogue, OPT-IN `?wavePrefetch=on`. Retail loads every
// wave a sound table names when the table loads: SoundTableData::UnPack
// (acclient.c:385399) → SoundManager::CreateSound (:383707) for each non-zero
// variant (:385486-385488). WavePrefetchQueue (scene3d/audio/wave_prefetch.js)
// fetches a newly installed table's waves as bytes on the normal lane, with
// these guards from the audit verifier:
//   - nothing starts before scene-ready
//   - at most 2 fetches in flight
//   - an 8 MiB per-session byte budget
//   - one fetch per wave DID per instance
//   - no audio decode
// Off by default. Under `?wavePrefetch=off`, or with no flag, there are no
// prefetch calls at all.
//
// Run: node tests/audio_wave_prefetch.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { SoundTableCache } from "../scene3d/audio/sound_table_cache.js";
import {
  WavePrefetchQueue,
  WAVE_PREFETCH_BYTE_BUDGET,
  WAVE_PREFETCH_MAX_IN_FLIGHT,
  createWavePrefetch,
  sceneReadyLatched,
  soundTableWaveIds,
  wavePrefetchEnabled,
} from "../scene3d/audio/wave_prefetch.js";

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** fetchWave fake: per-call deferreds, live in-flight tracking, decode trap. */
function controlledWaves(size = 1000) {
  const calls = [];
  const handles = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchWave = (...args) => {
    const d = deferred();
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push({ args, d });
    return d.promise.finally(() => { inFlight -= 1; });
  };
  const wave = (did) => {
    const h = {
      id: did,
      riffByteLength: size,
      freed: 0,
      free() { this.freed += 1; },
      takeRiffBytes() { throw new Error("prefetch must not decode"); },
    };
    handles.push(h);
    return h;
  };
  return {
    calls,
    handles,
    fetchWave,
    wave,
    get inFlight() { return inFlight; },
    get maxInFlight() { return maxInFlight; },
    /** Resolve the oldest unresolved call. */
    async landNext() {
      const c = calls.find((x) => !x.done);
      c.done = true;
      c.d.resolve(wave(c.args[0]));
      await flush();
    },
  };
}

/** Fake timer: records the armed callback; `fire()` runs it. */
function fakeTimer() {
  const armed = [];
  return {
    armed,
    setTimeout: (fn, ms) => { armed.push({ fn, ms }); return armed.length; },
    fire() { const t = armed.shift(); t?.fn(); },
  };
}

/** A fake SoundTableJs with `waveIds()` (the audio-1 wasm method). */
function stbWithIds(ids) {
  return { waveIds: () => Uint32Array.from(ids), entriesForSound: () => [], free() {} };
}

const W = (n) => (0x0A000000 + n) >>> 0;

test("the flag is opt-in: only ?wavePrefetch=on builds a queue", () => {
  assert.equal(wavePrefetchEnabled(""), false);
  assert.equal(wavePrefetchEnabled("?wavePrefetch=off"), false);
  assert.equal(wavePrefetchEnabled("?wavePrefetch=1"), false);
  assert.equal(wavePrefetchEnabled("?wavePrefetch=on"), true);
  const fetchWave = async () => null;
  assert.equal(createWavePrefetch({ search: "", fetchWave }), null);
  assert.equal(createWavePrefetch({ search: "?wavePrefetch=off", fetchWave }), null);
  assert.ok(createWavePrefetch({ search: "?wavePrefetch=on", fetchWave }) instanceof WavePrefetchQueue);
  assert.equal(WAVE_PREFETCH_MAX_IN_FLIGHT, 2);
  assert.equal(WAVE_PREFETCH_BYTE_BUDGET, 8 * 1024 * 1024);
});

test("?wavePrefetch=off: installing tables makes zero wave prefetch calls", async () => {
  const waves = controlledWaves();
  for (const search of ["", "?wavePrefetch=off"]) {
    const q = createWavePrefetch({ search, fetchWave: waves.fetchWave, isReady: () => true });
    const cache = new SoundTableCache({
      fetchSoundTable: async () => stbWithIds([W(1), W(2), W(3)]),
      onInstall: q ? (_did, stb) => q.enqueueTable(stb) : null,
    });
    await cache.get(0x20000001);
    await cache.resolveSound(0x20000002, 0x37);
  }
  await flush();
  assert.equal(waves.calls.length, 0);
});

test("scene-ready gate: nothing starts before ready; the re-check timer starts the drain", async () => {
  const waves = controlledWaves();
  const timer = fakeTimer();
  let ready = false;
  const q = new WavePrefetchQueue({
    fetchWave: waves.fetchWave,
    isReady: () => ready,
    setTimeout: timer.setTimeout,
  });
  assert.equal(q.enqueueTable(stbWithIds([W(1), W(2), W(3)])), 3);
  await flush();
  assert.equal(waves.calls.length, 0, "no fetch before scene-ready");
  assert.equal(timer.armed.length, 1, "one re-check armed");
  q.enqueueTable(stbWithIds([W(4)]));
  assert.equal(timer.armed.length, 1, "not re-armed while one is pending");
  timer.fire();
  assert.equal(waves.calls.length, 0, "still not ready");
  assert.equal(timer.armed.length, 1, "re-armed");
  ready = true;
  timer.fire();
  assert.equal(waves.calls.length, 2, "drain starts at the in-flight cap");
});

test("the default gate is the order-safe scene-ready latch", () => {
  assert.equal(sceneReadyLatched({}), false);
  assert.equal(sceneReadyLatched({ __bootState: "in-world" }), false);
  assert.equal(sceneReadyLatched({ __bootState: "ready" }), true);
  assert.equal(sceneReadyLatched({ __bootState: "in-world", __sceneReadyEverFired: true }), true);
  assert.equal(sceneReadyLatched(undefined), false);
});

test("at most 2 fetches in flight; every wave is fetched once on the normal lane, freed, never decoded", async () => {
  const waves = controlledWaves();
  const q = new WavePrefetchQueue({ fetchWave: waves.fetchWave, isReady: () => true });
  q.enqueue([W(1), W(2), W(3), W(4), W(5), W(6)]);
  assert.equal(waves.calls.length, 2);
  assert.equal(q.stats().queued, 4);
  for (let i = 0; i < 6; i += 1) {
    assert.ok(waves.inFlight <= 2, `in flight ${waves.inFlight}`);
    await waves.landNext();
  }
  assert.equal(waves.calls.length, 6);
  assert.equal(waves.maxInFlight, 2);
  assert.equal(q.stats().maxInFlightSeen, 2);
  assert.ok(waves.calls.every((c) => c.args.length === 1), "fetchWave(did): no urgent argument");
  assert.deepEqual(waves.calls.map((c) => c.args[0]), [W(1), W(2), W(3), W(4), W(5), W(6)], "FIFO");
  assert.ok(waves.handles.every((h) => h.freed === 1), "each WaveJs freed once");
  const s = q.stats();
  assert.equal(s.fetched, 6);
  assert.equal(s.bytes, 6000);
  assert.equal(s.inFlight, 0);
  assert.equal(s.queued, 0);
});

test("byte budget: the drain stops once the budget is spent (overshoot bounded by the in-flight cap)", async () => {
  const waves = controlledWaves(40);
  const q = new WavePrefetchQueue({ fetchWave: waves.fetchWave, isReady: () => true, byteBudget: 100 });
  q.enqueue([W(1), W(2), W(3), W(4), W(5), W(6)]);
  for (let i = 0; i < 4; i += 1) await waves.landNext();
  await flush();
  // 1,2 start at 0 B; 3 starts at 40 B, 4 at 80 B; at 120 B the queue is capped.
  assert.equal(waves.calls.length, 4);
  const s = q.stats();
  assert.equal(s.capped, true);
  assert.equal(s.dropped, 2);
  assert.equal(s.bytes, 160);
  assert.ok(s.bytes <= 100 + 2 * 40, "at most maxInFlight records past the budget");
  // New tables after the cap are counted, not fetched.
  q.enqueueTable(stbWithIds([W(7), W(8)]));
  await flush();
  assert.equal(waves.calls.length, 4);
  assert.equal(q.stats().dropped, 4);
});

test("dedupe: a wave shared by two tables is fetched once; zero and non-Wave ids are skipped", async () => {
  const waves = controlledWaves();
  const q = new WavePrefetchQueue({ fetchWave: waves.fetchWave, isReady: () => true, maxInFlight: 8 });
  assert.equal(q.enqueueTable(stbWithIds([W(1), W(2), 0, 0x20000001])), 2);
  assert.equal(q.enqueueTable(stbWithIds([W(2), W(3)])), 1);
  await flush();
  assert.deepEqual(waves.calls.map((c) => c.args[0]).sort(), [W(1), W(2), W(3)]);
  assert.equal(q.stats().tables, 2);
  assert.equal(q.stats().seen, 3);
});

test("a failed prefetch is counted and does not stall the drain", async () => {
  let n = 0;
  const q = new WavePrefetchQueue({
    fetchWave: async () => {
      n += 1;
      if (n === 1) throw new Error("not prefetched");
      return { riffByteLength: 10, free() {} };
    },
    isReady: () => true,
  });
  q.enqueue([W(1), W(2), W(3)]);
  await flush();
  const s = q.stats();
  assert.equal(n, 3);
  assert.equal(s.failed, 1);
  assert.equal(s.fetched, 2);
  assert.equal(s.bytes, 20);
});

test("soundTableWaveIds prefers waveIds(); an older pkg falls back to soundKeys + entriesForSound", () => {
  assert.deepEqual(soundTableWaveIds(stbWithIds([W(3), W(1), W(3), 0])), [W(1), W(3)]);
  const freed = [];
  const rows = { 0x37: [W(9), W(2)], 0x38: [W(2), 0x20000005, 0] };
  const legacy = {
    soundKeys: () => Uint32Array.from([0x37, 0x38]),
    entriesForSound: (k) => rows[k].map((waveDid) => ({ waveDid, free() { freed.push(waveDid); } })),
  };
  assert.deepEqual(soundTableWaveIds(legacy), [W(2), W(9)]);
  assert.equal(freed.length, 5, "every entry handle freed");
  assert.deepEqual(soundTableWaveIds(null), []);
  assert.deepEqual(soundTableWaveIds({ waveIds() { throw new Error("x"); } }), []);
});

test("?wavePrefetch=on end to end: a play installs a table, and its waves are prefetched once", async () => {
  const waves = controlledWaves();
  const q = createWavePrefetch({ search: "?wavePrefetch=on", fetchWave: waves.fetchWave, isReady: () => true });
  const cache = new SoundTableCache({
    fetchSoundTable: async () => ({
      waveIds: () => Uint32Array.from([W(1), W(2), W(3)]),
      entriesForSound: () => [{ waveDid: W(1), priority: 0, probability: 1, volume: 1, free() {} }],
      free() {},
    }),
    urgentPlayFetch: true,
    onInstall: (_did, stb) => q.enqueueTable(stb),
  });
  assert.equal((await cache.resolveSound(0x20000003, 0x37)).waveDid, W(1));
  await cache.resolveSound(0x20000003, 0x37);
  assert.equal(waves.calls.length, 2, "in-flight cap");
  await waves.landNext();
  await waves.landNext();
  await waves.landNext();
  assert.equal(waves.calls.length, 3);
  assert.equal(q.stats().tables, 1, "one install, one enqueue");
});
