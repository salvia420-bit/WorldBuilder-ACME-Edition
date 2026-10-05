// audio_server_sound.test.mjs — server Sound 0xF750 + AdminEnvirons sounds.
//
// Retail (acclient.c, read 2026-10-05):
//   SmartBox::HandleSoundEvent 143333 -> CPhysicsObj::play_sound 316424 ->
//   SoundManager::PlaySoundA(stype, obj, volume) 383655-383678: the row's
//   PROBABILITY is rolled, the WIRE volume is the gain (row volume unused),
//   and GetAttenuation (383079-383118) silences volume <= 0.
//   CPlayerSystem::Handle_Admin__Environs 396430-396545: 101..114 ->
//   UI_Roar..UI_LostSouls, 115/116 none, 117 UI_Squeal(0x84), 118..123
//   UI_Thunder1..6, all via PlaySoundFromCenter(stype, GetUISoundTable()).
//
// Fails on the old code (app/client_events.js before 2026-10-05):
//   - gain was entry.volume * wire, so a row volume 0.4 at wire 0.8 played
//     at 0.32 instead of 0.8;
//   - a wire volume of 0 was forced to 1.0 (played at full volume);
//   - a row with probability 0 still played (no roll);
//   - environ option 117 played SoundType 0x86 (117+0x11) instead of 0x84,
//     option 115 played 0x84 instead of nothing, and environ sounds went
//     through play() at the camera instead of playFromCenter.
//
// Run: node tests/audio_server_sound.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";

globalThis.window = globalThis;
globalThis.location = { search: "", href: "http://test/index.html", reload() {} };
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ style: {} }),
  body: { appendChild() {} },
};

const rules = await import("../scene3d/audio/retail_sound_rules.js");
const { dispatchClientEvent } = await import("../app/client_events.js");
const { ClientEventKind } = await import("../scene3d/client_event_kinds.js");

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n    ${err.message}`); process.exitCode = 1; }
};
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── pure rules ──
await test("serverSoundPlan: gain = wire volume, not row volume x wire", () => {
  const p = rules.serverSoundPlan({ probability: 1, volume: 0.4 }, 0.8, () => 0);
  assert.deepEqual(p, { play: true, gain: 0.8, reason: "ok" });
});
await test("serverSoundPlan: wire volume 0 / negative is silent", () => {
  assert.equal(rules.serverSoundPlan({ probability: 1 }, 0, () => 0).play, false);
  assert.equal(rules.serverSoundPlan({ probability: 1 }, -1, () => 0).play, false);
});
await test("serverSoundPlan: rolls the row probability (rand < p)", () => {
  assert.equal(rules.serverSoundPlan({ probability: 0.3 }, 1, () => 0.29).play, true);
  assert.equal(rules.serverSoundPlan({ probability: 0.3 }, 1, () => 0.3).play, false);
  assert.equal(rules.serverSoundPlan({ probability: 0 }, 1, () => 0).play, false);
});
await test("retailVolume: authored 0 stays 0, missing -> 1.0", () => {
  assert.equal(rules.retailVolume(0), 0);
  assert.equal(rules.retailVolume(0.25), 0.25);
  assert.equal(rules.retailVolume(undefined), 1.0);
  assert.equal(rules.retailVolume(NaN), 1.0);
});
await test("environSoundType follows Handle_Admin__Environs case table", () => {
  assert.equal(rules.environSoundType(101), 0x76); // Roar
  assert.equal(rules.environSoundType(114), 0x83); // LostSouls
  assert.equal(rules.environSoundType(115), 0);
  assert.equal(rules.environSoundType(116), 0);
  assert.equal(rules.environSoundType(117), 0x84); // Squeal
  assert.equal(rules.environSoundType(118), 0x85); // Thunder1
  assert.equal(rules.environSoundType(123), 0x8a); // Thunder6
  assert.equal(rules.environSoundType(124), 0);
  assert.equal(rules.environSoundType(100), 0);
});

// ── through the real dispatcher ──
const calls = [];
let rows = new Map(); // `${stb}:${stype}` -> entry
const GUID = 0x50000001;
window.liveScene3d = {
  audioManager: {
    play: async (wave, pos, opts) => { calls.push({ fn: "play", wave, pos, opts }); return {}; },
    playFromCenter: async (wave, vol, opts) => { calls.push({ fn: "center", wave, vol, opts }); return {}; },
  },
  soundTableCache: {
    resolveSound: async (stb, st) => rows.get(`${stb >>> 0}:${st >>> 0}`) ?? null,
  },
  entityManager: {
    entityMap: new Map([[GUID, { soundTableDid: 0x20000001, root: { position: { x: 1, y: 2, z: 3 } } }]]),
  },
  wasmExports: {
    resolveClientEnumDid: async (e, c) => (e === 0x10000003 && c === 7 ? 0x2000004b : 0),
  },
};
const evt = (kind, extra) => ({ kind, u32Payload: 0, u32Payload2: 0, free() {}, ...extra });
const D = { EVT_GUARD_ON: true, setBootState() {} };

await test("0xF750 plays at the wire volume (row volume ignored)", async () => {
  calls.length = 0;
  rows = new Map([[`${0x20000001}:${0x8c}`, { waveDid: 0x0a000111, probability: 1, volume: 0.4, priority: 0 }]]);
  dispatchClientEvent(evt(ClientEventKind.SOUND_TRIGGERED, { u32Payload: GUID, u32Payload2: 0x8c, f32Payload: 0.8 }), D);
  await tick(); await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, "play");
  assert.equal(calls[0].opts.gain, 0.8);
});
await test("0xF750 wire volume 0 is silent (old code forced 1.0)", async () => {
  calls.length = 0;
  dispatchClientEvent(evt(ClientEventKind.SOUND_TRIGGERED, { u32Payload: GUID, u32Payload2: 0x8c, f32Payload: 0 }), D);
  await tick(); await tick();
  assert.equal(calls.length, 0);
});
await test("0xF750 row probability 0 never plays", async () => {
  calls.length = 0;
  rows = new Map([[`${0x20000001}:${0x8c}`, { waveDid: 0x0a000111, probability: 0, volume: 1, priority: 0 }]]);
  dispatchClientEvent(evt(ClientEventKind.SOUND_TRIGGERED, { u32Payload: GUID, u32Payload2: 0x8c, f32Payload: 1 }), D);
  await tick(); await tick();
  assert.equal(calls.length, 0);
});
await test("environ 117 -> UI_Squeal from the UI table via playFromCenter at row volume", async () => {
  calls.length = 0;
  rows = new Map([[`${0x2000004b}:${0x84}`, { waveDid: 0x0a000222, probability: 1, volume: 0.6, priority: 0 }]]);
  dispatchClientEvent(evt(ClientEventKind.ENVIRON_CHANGE, { u32Payload: 117 }), D);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(calls.length, 1, JSON.stringify(calls));
  assert.equal(calls[0].fn, "center");
  assert.equal(calls[0].wave, 0x0a000222);
  assert.equal(calls[0].vol, 0.6);
});
await test("environ 115 plays nothing", async () => {
  calls.length = 0;
  rows = new Map([[`${0x2000004b}:${0x84}`, { waveDid: 1, probability: 1, volume: 1, priority: 0 }]]);
  dispatchClientEvent(evt(ClientEventKind.ENVIRON_CHANGE, { u32Payload: 115 }), D);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(calls.length, 0);
});

// ── sound for an object not created yet ──
// Retail HandleSoundEvent 143340-143345 queues the blob on the unknown
// object (QueueBlobForObject 310848-310861) and replays it when the object
// is created; the null object is destroyed 25 s after the FIRST blob
// (310666). Round 3: replay is synchronous from the entity-insert hook
// (entities.js drainPendingObjectSounds), and one deadline per guid.
// Old code: a 250 ms poll (nothing played at insert time) and a deadline
// per message.
await test("0xF750 for an unknown object plays synchronously when the object is inserted", async () => {
  calls.length = 0;
  const LATE = 0x50000077;
  rows = new Map([[`${0x20000001}:${0x8c}`, { waveDid: 0x0a000333, probability: 1, volume: 1, priority: 0 }]]);
  dispatchClientEvent(evt(ClientEventKind.SOUND_TRIGGERED, { u32Payload: LATE, u32Payload2: 0x8c, f32Payload: 0.9 }), D);
  await tick(); await tick();
  assert.equal(calls.length, 0, "nothing yet");
  assert.equal(rules.pendingObjectSounds.size, 1);
  window.liveScene3d.entityManager.entityMap.set(LATE, { soundTableDid: 0x20000001, root: { position: { x: 0, y: 0, z: 0 } } });
  assert.equal(rules.drainPendingObjectSounds(LATE), 1, "drained at insert");
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(calls.length, 1, JSON.stringify(calls));
  assert.equal(calls[0].wave, 0x0a000333);
  assert.equal(calls[0].opts.gain, 0.9);
  assert.equal(rules.pendingObjectSounds.size, 0);
});
await test("entities.js insert hook drains queued object sounds", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../scene3d/entities.js", import.meta.url), "utf8");
  const at = src.indexOf("drainPendingPlayEffects(this, guid);");
  assert.ok(at > 0 && src.slice(at, at + 300).includes("drainPendingObjectSounds(guid)"));
});
await test("one 25 s deadline per guid, from the first queued sound", () => {
  let t = 0;
  const q = new rules.PendingObjectSounds({ now: () => t });
  let played = 0;
  q.add(1, () => { played++; });
  t = 20000; q.add(1, () => { played++; });   // joins the first deadline
  t = 24000; q.prune(t);
  assert.equal(q.size, 2);
  t = 25001; q.prune(t);
  assert.equal(q.size, 0, "second sound expires with the first (shared deadline)");
  assert.equal(q.expired, 2);
  assert.equal(played, 0);
});

console.log(`\n${passed} passed${process.exitCode ? ", FAILURES above" : ""}`);
