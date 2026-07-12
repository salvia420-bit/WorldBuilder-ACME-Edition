// WS09 (2026-07-12) — Patch B: the PlayEffect resolver fires the wire
// PlayScript's AUDIO hooks (Sound 1 / SoundTable 2 / SoundTweaked 21) through
// the entity sound sink, not particles only. Guards the two mustFix-#2
// corrections:
//   (1) the sound branch runs ABOVE the `particleHookCount === 0` early-return,
//       so a SOUND-ONLY wire PlayScript still plays (the resolver still returns
//       false for it, but the sound already fired), and
//   (2) it fires the SoundTable(2) hook that the generic Fizzle 0x33000103
//       (CreateParticle + SoundTable) carries — previously dropped.
// Also proves the default-OFF regression: with the flag absent, NO sound hook
// is routed (byte-identical to today).
//
// `PLAY_EFFECT_SOUND_ON` is read once at module import, so the ON and OFF arms
// run in separate child processes (this file is its own worker):
//   node tests/test_ws09_play_effect_sound.mjs            → driver (spawns both)
//   node tests/test_ws09_play_effect_sound.mjs worker-on  → flag ON arm
//   node tests/test_ws09_play_effect_sound.mjs worker-off → flag OFF arm

import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODE = process.argv[2] || "";

// ---------------------------------------------------------------- driver ----
if (MODE === "") {
  const runArm = (arm) => {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), arm], {
      stdio: "inherit",
    });
    return r.status === 0;
  };
  console.log("=== WS09 play_effect_vfx sound-hook resolver ===");
  const on = runArm("worker-on");
  const off = runArm("worker-off");
  process.exit(on && off ? 0 : 1);
}

// ---------------------------------------------------------------- worker ----
register(pathToFileURL(resolvePath(__dirname, "../_three_stub_loader.mjs")).href);

const FLAG_ON = MODE === "worker-on";

// window scaffold BEFORE import (the flag IIFE + auto-bind read it).
globalThis.window = {
  __pluginClient: { events: { on() {}, off() {}, emit() {} } },
  __playEffectVfxBound: false,
  __hbWasm: null,
  liveScene3d: null,
  location: FLAG_ON ? { search: "?playEffectSound=on" } : { search: "" },
};

// Recording sound sink — the real EntityManager._firePlayEffectSoundHook.
const soundCalls = [];
// Recording particle manager (so the fizzle-like case fully resolves).
function makeParticleManager() {
  let nextId = 1;
  const calls = [];
  return {
    calls,
    addEmitter(args) { const id = nextId++; calls.push({ id, ...args }); return id; },
    destroyParticleEmitter() {},
  };
}

function makeWasmStubs({ table, scriptByDid, particleEmitter }) {
  return {
    fetchPhysicsScriptTable: async () => JSON.stringify(table),
    fetchPhysicsScript: async (did) => {
      const s = scriptByDid.get(did >>> 0);
      if (!s) throw new Error(`no fixture for 0x${did.toString(16)}`);
      return s;
    },
    fetchParticleEmitter: async () => particleEmitter ?? { emitterId: 0x32000001 },
  };
}

// Build a PhysicsScriptJs.takeEntries() shape with sound + particle hooks.
function makePhysicsScript(entries) {
  return {
    takeEntries: () => entries.map((e) => {
      const ht = e.hookType ?? 13;
      const base = { hookType: ht, startTime: e.startTime ?? 0, direction: 0 };
      if (ht === 13 || ht === 26) {
        Object.assign(base, {
          createParticleEmitterId: e.emitterDid ?? 0x32000001,
          createParticleOffsetX: 0, createParticleOffsetY: 0, createParticleOffsetZ: 0,
          createParticleOffsetQX: 0, createParticleOffsetQY: 0, createParticleOffsetQZ: 0,
          createParticleOffsetQW: 1, createParticlePartIndex: -1,
        });
      }
      if (ht === 1 || ht === 21) {
        base.soundWaveId = e.soundWaveId ?? 0;
        base.soundProbability = e.soundProbability ?? 1.0;
        base.soundVolume = e.soundVolume ?? 1.0;
      }
      if (ht === 2) {
        const buf = new Uint8Array(4);
        new DataView(buf.buffer).setUint32(0, (e.soundEnum ?? 0) >>> 0, true);
        base.hookData = buf;
        base.soundWaveId = 0;
      }
      return base;
    }),
  };
}

const TARGET = 0xC0000001;
function installScene({ tableDid, scriptByDid, particleEmitter, table }) {
  const root = { position: { x: 1, y: 2, z: 3 }, parent: null, children: [], add() {}, remove() {} };
  const entityMap = new Map([[TARGET >>> 0, { root }]]);
  const wasmExports = makeWasmStubs({ table, scriptByDid, particleEmitter });
  const particleManager = makeParticleManager();
  globalThis.window.__hbWasm = wasmExports;
  globalThis.window.liveScene3d = {
    entitiesGroup: { add() {}, remove() {} },
    entityManager: {
      entityMap,
      wasmExports,
      materialCache: null,
      _worldParticleManager: particleManager,
      // Pre-existing harness stub gap (packet §4 T3 / risk #5): the resolver's
      // legacy per-guid emitter map is undefined under Node when particleOwner
      // is off. Seed it so the spawn-tracking path doesn't throw.
      _particleEmittersForGuid: new Map(),
      getPhysicsScriptTableDid: (g) => ((g >>> 0) === (TARGET >>> 0) ? (tableDid >>> 0) : 0),
      // The real sink under test — record (guid, desc) so we can assert.
      _firePlayEffectSoundHook: (guid, desc) => { soundCalls.push({ guid: guid >>> 0, ...desc }); },
    },
  };
  return { particleManager };
}

const { __test } = await import(
  pathToFileURL(resolvePath(__dirname, "../scene3d/play_effect_vfx.js")).href
);
const { _clearPhysicsScriptTableCache } = await import(
  pathToFileURL(resolvePath(__dirname, "../ui/ac_physics_script_table.js")).href
);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log(`  FAIL [${MODE}] ${m}`); } };

// scriptId key used by the table (PScriptType); arbitrary for the test.
const SCRIPT_ID = 0x51; // Fizzle PScriptType (PlayScript.Fizzle)

// --- Case 1: fizzle-shape [CreateParticle(13) + SoundTable(2)] --------------
{
  _clearPhysicsScriptTableCache();
  soundCalls.length = 0;
  const PES = 0x33000103;
  const scriptByDid = new Map([[PES, makePhysicsScript([
    { hookType: 13, emitterDid: 0x32000001 },
    { hookType: 2, soundEnum: 42, startTime: 0 },
  ])]]);
  installScene({
    tableDid: 0x34000004,
    table: { id: 0x34000004, scripts: { [String(SCRIPT_ID)]: [{ mod: 1.0, scriptDid: PES }] } },
    scriptByDid,
    particleEmitter: { emitterId: 0x32000001 },
  });
  const result = await __test.tryResolveRealVfx(TARGET, SCRIPT_ID, 0.5);
  ok(result === true, "fizzle-shape resolves true (has a particle hook)");
  if (FLAG_ON) {
    ok(soundCalls.length === 1, `SoundTable hook fired once (got ${soundCalls.length})`);
    ok(soundCalls[0]?.hookType === 2 && soundCalls[0]?.soundEnum === 42,
      `sink got {hookType:2, soundEnum:42} (got ${JSON.stringify(soundCalls[0])})`);
    ok(soundCalls[0]?.guid === (TARGET >>> 0), "sink got the target guid");
  } else {
    ok(soundCalls.length === 0, `flag OFF: no sound routed (got ${soundCalls.length})`);
  }
}

// --- Case 2: SOUND-ONLY [SoundTable(2)] — mustFix #2 hoist proof ------------
// No particle hook → resolver returns false, but the sound must STILL fire
// (the branch runs above the particleHookCount===0 early-return).
{
  _clearPhysicsScriptTableCache();
  soundCalls.length = 0;
  const PES = 0x33000200;
  const scriptByDid = new Map([[PES, makePhysicsScript([
    { hookType: 2, soundEnum: 99, startTime: 0.25 },
  ])]]);
  installScene({
    tableDid: 0x34000005,
    table: { id: 0x34000005, scripts: { [String(SCRIPT_ID)]: [{ mod: 1.0, scriptDid: PES }] } },
    scriptByDid,
    particleEmitter: null,
  });
  const result = await __test.tryResolveRealVfx(TARGET, SCRIPT_ID, 0.5);
  ok(result === false, "sound-only script returns false (no particle hook)");
  if (FLAG_ON) {
    ok(soundCalls.length === 1, `sound-only STILL fired above early-return (got ${soundCalls.length})`);
    ok(soundCalls[0]?.soundEnum === 99 && soundCalls[0]?.startTime === 0.25,
      `sink got the sound-only hook (got ${JSON.stringify(soundCalls[0])})`);
  } else {
    ok(soundCalls.length === 0, "flag OFF: sound-only not routed");
  }
}

// --- Case 3: raw Sound(1) wave hook ----------------------------------------
{
  _clearPhysicsScriptTableCache();
  soundCalls.length = 0;
  const PES = 0x33000300;
  const scriptByDid = new Map([[PES, makePhysicsScript([
    { hookType: 13, emitterDid: 0x32000003 },
    { hookType: 1, soundWaveId: 0x0A00ABCD, startTime: 0 },
  ])]]);
  installScene({
    tableDid: 0x34000006,
    table: { id: 0x34000006, scripts: { [String(SCRIPT_ID)]: [{ mod: 1.0, scriptDid: PES }] } },
    scriptByDid,
    particleEmitter: { emitterId: 0x32000003 },
  });
  await __test.tryResolveRealVfx(TARGET, SCRIPT_ID, 0.5);
  if (FLAG_ON) {
    ok(soundCalls.length === 1 && soundCalls[0]?.hookType === 1
      && (soundCalls[0]?.soundWaveId >>> 0) === (0x0A00ABCD >>> 0),
      `Sound(1) wave hook routed (got ${JSON.stringify(soundCalls[0])})`);
  } else {
    ok(soundCalls.length === 0, "flag OFF: Sound(1) not routed");
  }
}

// --- Case 4: particle-ONLY script → sink NOT called (gating on hook type) ---
{
  _clearPhysicsScriptTableCache();
  soundCalls.length = 0;
  const PES = 0x33000400;
  const scriptByDid = new Map([[PES, makePhysicsScript([
    { hookType: 13, emitterDid: 0x32000004 },
  ])]]);
  installScene({
    tableDid: 0x34000007,
    table: { id: 0x34000007, scripts: { [String(SCRIPT_ID)]: [{ mod: 1.0, scriptDid: PES }] } },
    scriptByDid,
    particleEmitter: { emitterId: 0x32000004 },
  });
  const result = await __test.tryResolveRealVfx(TARGET, SCRIPT_ID, 0.5);
  ok(result === true, "particle-only script resolves true");
  ok(soundCalls.length === 0, `particle-only: no sound routed either arm (got ${soundCalls.length})`);
}

console.log(`WS09 sound-hook [${MODE}]: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
