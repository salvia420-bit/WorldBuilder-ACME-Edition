// tests/audio_urgent_fetch.test.mjs — audio-1 part 1 (2026-10-13).
//
// Retail never loads a sound at play time. SoundTableData::UnPack
// (acclient.c:385399) calls SoundManager::CreateSound (:383707) for every
// variant, and GetSound (:383433) only looks the wave up. Holtburger fetched
// a missing sound table (and wave) on the wasm NORMAL lane, which is the
// fetch_sem FIFO at FetchPriority::Low behind the ring bakers, so a play
// could start seconds late. Now a resolveSound (play-path) miss calls
// `fetchSoundTable(did, true)`, the urgent lane. A play that finds the table
// still queued by the spawn prewarm races one urgent fetch against it. The
// spawn prewarm itself (`get(did)`) keeps the single-argument normal-lane
// call. `?audioUrgentFetch=off` restores the old lane.
//
// Run: node tests/audio_urgent_fetch.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { SoundTableCache, audioUrgentFetchEnabled } from "../scene3d/audio/sound_table_cache.js";

const DID = 0x20000014;
const ENUM = 0x37;
const flush = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A fake SoundTableJs with one wave row under ENUM. */
function table(tag, waveDid = 0x0A000001) {
  return {
    tag,
    freed: 0,
    entriesForSound(e) {
      return e === ENUM ? [{ waveDid, priority: 0, probability: 1, volume: 1, free() {} }] : [];
    },
    free() { this.freed += 1; },
  };
}

/** fetchSoundTable fake: records each call's args; each call gets its own deferred. */
function controlledFetch() {
  const calls = [];
  const fetchSoundTable = (...args) => {
    const d = deferred();
    calls.push({ args, d });
    return d.promise;
  };
  return { calls, fetchSoundTable };
}

test("audioUrgentFetchEnabled: default on; off/0/false disable it", () => {
  assert.equal(audioUrgentFetchEnabled(""), true);
  assert.equal(audioUrgentFetchEnabled("?audioUrgentFetch=on"), true);
  assert.equal(audioUrgentFetchEnabled("?audioUrgentFetch=off"), false);
  assert.equal(audioUrgentFetchEnabled("?audioUrgentFetch=0"), false);
  assert.equal(audioUrgentFetchEnabled("?audioUrgentFetch=false"), false);
});

test("a resolveSound miss fetches on the urgent lane: fetchSoundTable(did, true)", async () => {
  const { calls, fetchSoundTable } = controlledFetch();
  const cache = new SoundTableCache({ fetchSoundTable, urgentPlayFetch: true });
  const p = cache.resolveSound(DID, ENUM);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [DID, true]);
  calls[0].d.resolve(table("u"));
  assert.equal((await p).waveDid, 0x0A000001);
  assert.equal(cache.stats().urgentFetches, 1);
  assert.equal(cache.stats().escalations, 0);
});

test("the spawn prewarm get(did) keeps the single-argument normal-lane call", async () => {
  const { calls, fetchSoundTable } = controlledFetch();
  const cache = new SoundTableCache({ fetchSoundTable, urgentPlayFetch: true });
  const p = cache.get(DID);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [DID], "no urgent argument at all");
  calls[0].d.resolve(table("n"));
  assert.equal((await p).tag, "n");
  assert.equal(cache.stats().urgentFetches, 0);
});

test("without urgentPlayFetch (and under ?audioUrgentFetch=off) resolveSound stays single-lane", async () => {
  const { calls, fetchSoundTable } = controlledFetch();
  const cache = new SoundTableCache({ fetchSoundTable });
  const p = cache.resolveSound(DID, ENUM);
  assert.deepEqual(calls[0].args, [DID]);
  calls[0].d.resolve(table("n"));
  await p;
  const offFetch = controlledFetch();
  const off = new SoundTableCache({
    fetchSoundTable: offFetch.fetchSoundTable,
    urgentPlayFetch: audioUrgentFetchEnabled("?audioUrgentFetch=off"),
  });
  const prewarm = off.get(DID);
  const play = off.resolveSound(DID, ENUM);
  assert.equal(offFetch.calls.length, 1, "the play shares the prewarm; no race");
  assert.deepEqual(offFetch.calls[0].args, [DID]);
  offFetch.calls[0].d.resolve(table("n"));
  await prewarm;
  assert.equal((await play).waveDid, 0x0A000001);
  assert.equal(off.stats().urgentFetches, 0);
});

test("a play during a queued prewarm races an urgent fetch; the urgent table wins and the loser is freed", async () => {
  const { calls, fetchSoundTable } = controlledFetch();
  const installs = [];
  const cache = new SoundTableCache({
    fetchSoundTable,
    urgentPlayFetch: true,
    onInstall: (did, stb) => installs.push([did, stb.tag]),
  });
  const prewarm = cache.get(DID);                 // normal lane, stuck
  const play = cache.resolveSound(DID, ENUM);     // play path
  const play2 = cache.resolveSound(DID, ENUM);    // second play shares the race
  assert.equal(calls.length, 2, "exactly one urgent fetch is added");
  assert.deepEqual(calls[0].args, [DID]);
  assert.deepEqual(calls[1].args, [DID, true]);
  const urgentTable = table("u");
  const normalTable = table("n");
  calls[1].d.resolve(urgentTable);
  assert.equal((await play).waveDid, 0x0A000001);
  assert.equal((await play2).waveDid, 0x0A000001);
  calls[0].d.resolve(normalTable);
  assert.equal(await prewarm, urgentTable, "the prewarm sees the installed table");
  await flush();
  assert.equal(cache.cached.get(DID), urgentTable);
  assert.equal(normalTable.freed, 1, "the losing handle is freed");
  assert.equal(urgentTable.freed, 0);
  assert.deepEqual(installs, [[DID, "u"]], "onInstall fires once");
  assert.equal(cache.pending.size, 0);
  const s = cache.stats();
  assert.equal(s.escalations, 1);
  assert.equal(s.urgentFetches, 1);
  assert.equal(s.misses, 1);
});

test("if the normal-lane fetch lands first, the play takes it and the urgent handle is freed", async () => {
  const { calls, fetchSoundTable } = controlledFetch();
  const cache = new SoundTableCache({ fetchSoundTable, urgentPlayFetch: true });
  const prewarm = cache.get(DID);
  const play = cache.resolveSound(DID, ENUM);
  const normalTable = table("n", 0x0A000005);
  const urgentTable = table("u", 0x0A000005);
  calls[0].d.resolve(normalTable);
  assert.equal(await prewarm, normalTable);
  assert.equal((await play).waveDid, 0x0A000005);
  calls[1].d.resolve(urgentTable);
  await flush();
  assert.equal(cache.cached.get(DID), normalTable);
  assert.equal(urgentTable.freed, 1);
  assert.equal(cache.pending.size, 0);
});

test("a failed prewarm does not fail the play while its urgent fetch is still out", async () => {
  const { calls, fetchSoundTable } = controlledFetch();
  const cache = new SoundTableCache({ fetchSoundTable, urgentPlayFetch: true });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const prewarm = cache.get(DID);
    const play = cache.resolveSound(DID, ENUM);
    calls[0].d.reject(new Error("dropped"));
    assert.equal(await prewarm, null);
    calls[1].d.resolve(table("u"));
    assert.equal((await play).waveDid, 0x0A000001);
  } finally {
    console.warn = warn;
  }
  await flush();
  assert.equal(cache.pending.size, 0);
});

test("an urgent fetch already in flight is shared by later prewarms and plays (no extra fetch)", async () => {
  const { calls, fetchSoundTable } = controlledFetch();
  const cache = new SoundTableCache({ fetchSoundTable, urgentPlayFetch: true });
  const play = cache.resolveSound(DID, ENUM);
  const prewarm = cache.get(DID);
  const play2 = cache.resolveSound(DID, ENUM);
  assert.equal(calls.length, 1);
  calls[0].d.resolve(table("u"));
  await Promise.all([play, prewarm, play2]);
  assert.equal(cache.stats().escalations, 0);
  // A hit afterwards fetches nothing.
  await cache.resolveSound(DID, ENUM);
  assert.equal(calls.length, 1);
});

test("both lanes failing resolves null, caches nothing, and the next play retries", async () => {
  const { calls, fetchSoundTable } = controlledFetch();
  const cache = new SoundTableCache({ fetchSoundTable, urgentPlayFetch: true });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const prewarm = cache.get(DID);
    const play = cache.resolveSound(DID, ENUM);
    calls[0].d.reject(new Error("a"));
    calls[1].d.reject(new Error("b"));
    assert.equal(await prewarm, null);
    assert.equal(await play, null);
  } finally {
    console.warn = warn;
  }
  await flush();
  assert.equal(cache.cached.size, 0);
  assert.equal(cache.pending.size, 0);
  const retry = cache.resolveSound(DID, ENUM);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].args, [DID, true]);
  calls[2].d.resolve(table("r"));
  assert.equal((await retry).waveDid, 0x0A000001);
});

test("onInstall fires once per newly cached table and a throwing hook is contained", async () => {
  let n = 0;
  const cache = new SoundTableCache({
    fetchSoundTable: async () => table("t"),
    onInstall: () => { n += 1; throw new Error("hook"); },
  });
  assert.equal((await cache.resolveSound(DID, ENUM)).waveDid, 0x0A000001);
  await cache.resolveSound(DID, ENUM);
  await cache.get(DID);
  assert.equal(n, 1);
  assert.equal(cache.stats().lastError, "hook");
});
