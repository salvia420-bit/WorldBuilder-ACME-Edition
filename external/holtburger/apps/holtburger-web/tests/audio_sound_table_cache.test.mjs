// tests/audio_sound_table_cache.test.mjs — B2-use-items audio-5 (2026-10-08 round 2).
//
// SoundTableCache.resolveSound (scene3d/audio/sound_table_cache.js) crossed
// the wasm boundary on EVERY play: `entriesForSound` clones the Vec on the
// Rust side (lib.rs entries_for_sound `Some(v) => v.clone()`) and hands back N
// fresh SoundEntryJs wrappers, all freed again — for data that never changes
// (every footstep, server sound, UI click). Retail SoundManager::GetSound
// (acclient.c:383433-383463) is a lookup into the resident CSoundTable that
// copies four fields to the stack. The rows are now read once per
// (did, enum) and memoized as frozen plain objects; the uniform pick
// (GetSound :383446-383450: floor((N-1) * RollDice)) is unchanged.
//
// Run: node tests/audio_sound_table_cache.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { SoundTableCache } from "../scene3d/audio/sound_table_cache.js";

const DID = 0x20000014;

/** A fake wasm SoundTableJs: counts entriesForSound calls and frees. */
function fakeTables(table) {
  const stats = { fetches: 0, entryCalls: 0, frees: 0, handles: [] };
  const fetchSoundTable = async (did) => {
    stats.fetches += 1;
    return {
      did,
      entriesForSound(e) {
        stats.entryCalls += 1;
        return (table[e] || []).map((row) => {
          const h = { ...row, freed: 0, free() { this.freed += 1; stats.frees += 1; } };
          stats.handles.push(h);
          return h;
        });
      },
      free() {},
    };
  };
  return { stats, fetchSoundTable };
}

const row = (waveDid, extra = {}) => ({ waveDid, priority: 0.5, probability: 1, volume: 0.8, ...extra });

test("100 plays of one sound read the wasm table once and free every handle exactly once", async () => {
  const { stats, fetchSoundTable } = fakeTables({ 0x37: [row(0x0A000001), row(0x0A000002), row(0x0A000003)] });
  const cache = new SoundTableCache({ fetchSoundTable, rng: () => 0.5 });
  for (let i = 0; i < 100; i += 1) {
    const e = await cache.resolveSound(DID, 0x37);
    assert.equal(e.waveDid, 0x0A000002);
  }
  assert.equal(stats.fetches, 1);
  assert.equal(stats.entryCalls, 1, "entriesForSound crossed the boundary once");
  assert.equal(stats.handles.length, 3);
  assert.ok(stats.handles.every((h) => h.freed === 1), "each SoundEntryJs freed exactly once");
});

test("the uniform pick is retail GetSound's floor((N-1) * r) — unchanged", async () => {
  const { fetchSoundTable } = fakeTables({ 1: [row(0xA1), row(0xA2)], 2: [row(0xB1), row(0xB2), row(0xB3)] });
  let r = 0.999;
  const cache = new SoundTableCache({ fetchSoundTable, rng: () => r });
  assert.equal((await cache.resolveSound(DID, 1)).waveDid, 0xA1, "N=2: the last entry is unreachable (retail quirk)");
  r = 0.5;
  assert.equal((await cache.resolveSound(DID, 2)).waveDid, 0xB2, "N=3, r=0.5 → entry 1");
  r = 0;
  assert.equal((await cache.resolveSound(DID, 2)).waveDid, 0xB1);
});

test("a single row never consumes the rng (seeded callers read cache._rng afterwards)", async () => {
  const { fetchSoundTable } = fakeTables({ 7: [row(0xC1, { probability: 0.25, volume: 0.4, priority: 2 })] });
  let rolls = 0;
  const cache = new SoundTableCache({ fetchSoundTable, rng: () => { rolls += 1; return 0.3; } });
  const e = await cache.resolveSound(DID, 7);
  assert.deepEqual(e, { waveDid: 0xC1, priority: 2, probability: 0.25, volume: 0.4 });
  await cache.resolveSound(DID, 7);
  assert.equal(rolls, 0);
});

test("callers get their own plain copy; the cached rows stay intact", async () => {
  const { fetchSoundTable } = fakeTables({ 7: [row(0xC1)] });
  const cache = new SoundTableCache({ fetchSoundTable });
  const a = await cache.resolveSound(DID, 7);
  assert.equal(typeof a.free, "undefined", "a POJO, not a wasm handle");
  a.volume = 0;
  const b = await cache.resolveSound(DID, 7);
  assert.equal(b.volume, 0.8);
  assert.notEqual(a, b);
});

test("an enum the table lacks returns null and costs no second wasm call", async () => {
  const { stats, fetchSoundTable } = fakeTables({});
  const cache = new SoundTableCache({ fetchSoundTable });
  assert.equal(await cache.resolveSound(DID, 0x99), null);
  assert.equal(await cache.resolveSound(DID, 0x99), null);
  assert.equal(stats.entryCalls, 1);
});

test("a throwing entriesForSound is not memoized; dispose() drops the rows", async () => {
  let boom = true;
  const { stats, fetchSoundTable } = fakeTables({ 5: [row(0xD1)] });
  const cache = new SoundTableCache({
    fetchSoundTable: async (did) => {
      const stb = await fetchSoundTable(did);
      const inner = stb.entriesForSound.bind(stb);
      stb.entriesForSound = (e) => { if (boom) throw new Error("transient"); return inner(e); };
      return stb;
    },
  });
  const warn = console.warn;
  console.warn = () => {};
  try { assert.equal(await cache.resolveSound(DID, 5), null); } finally { console.warn = warn; }
  boom = false;
  assert.equal((await cache.resolveSound(DID, 5)).waveDid, 0xD1, "retried");
  assert.equal(stats.entryCalls, 1);
  cache.dispose();
  assert.equal((await cache.resolveSound(DID, 5)).waveDid, 0xD1);
  assert.equal(stats.fetches, 2, "the table is refetched after dispose");
  assert.equal(stats.entryCalls, 2, "and its rows re-read");
});
