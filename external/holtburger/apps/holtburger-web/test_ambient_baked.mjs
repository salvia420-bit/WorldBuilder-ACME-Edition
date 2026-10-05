// 2026-06-23 — ESM test for the baked-events ambient path:
//   - `scene3d/audio/baked_ambient_source.js` (clean ESM, imported directly)
//   - `scene3d/audio/ambient_runtime.js` baked branch (strip-eval, same
//     closure-captured-import trick as `test_ambient_frame.mjs`, since
//     ambient_runtime.js imports `acToThree` from `../adapter.js`).
//
// Run with:
//   cd apps/holtburger-web/
//   node test_ambient_baked.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";
import {
  BakedAmbientSource,
  parseAmbientTriggers,
} from "./scene3d/audio/baked_ambient_source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

// 2026-10-05: ambient_runtime.js is a plain ESM adapter over
// ambient_model.js now — import it directly.
const { AmbientRuntime } = await import("./scene3d/audio/ambient_runtime.js");

// eslint-disable-next-line no-console
console.log("2026-06-23 — baked-events ambient path test");
// eslint-disable-next-line no-console
console.log("=========================");

// ===================================================================
// 1. parseAmbientTriggers — real Holtburg row shape
// ===================================================================
{
  const jsonl = [
    // an ambient row (stb_id as "0x…" string; mixed continuous/prob)
    JSON.stringify({
      source: "ambient",
      trigger: "terrain",
      terrain_type: 1,
      scene_type: 0,
      scene_info_idx: 2,
      stb_index: 4,
      stb_id: "0x2000001B",
      vertex_indices: [0, 9, 73],
      ambient_sounds: [
        { s_type: 70, volume: 0.25, base_chance: 0.0, min_rate: 8.27, max_rate: 8.27, continuous: true },
        { s_type: 71, volume: 0.6, base_chance: 0.25, min_rate: 1.4, max_rate: 10.0, continuous: false },
      ],
    }),
    // a NON-ambient row that must be filtered out
    JSON.stringify({ source: "physics_script_particle", trigger: "scenery", foo: 1 }),
    "", // blank line tolerated
    "{ this is not json", // malformed line tolerated
  ].join("\n");

  const triggers = parseAmbientTriggers(jsonl);
  check("parse: exactly 1 ambient trigger (non-ambient filtered)", triggers.length === 1, String(triggers.length));
  const t = triggers[0];
  check("parse: stb_id '0x2000001B' → int 0x2000001B", t && t.stbId === 0x2000001b, t && "0x" + t.stbId.toString(16));
  check("parse: vertexIndices preserved", JSON.stringify(t.vertexIndices) === "[0,9,73]", JSON.stringify(t && t.vertexIndices));
  check("parse: 2 ambient sounds adapted", t && t.ambientSounds.length === 2, String(t && t.ambientSounds.length));
  const s0 = t && t.ambientSounds[0];
  check(
    "parse: snake→camel field adapt (s_type→sType, base_chance→baseChance, continuous→isContinuous)",
    s0 && s0.sType === 70 && s0.baseChance === 0.0 && s0.minRate === 8.27 && s0.isContinuous === true,
    JSON.stringify(s0)
  );
  check("parse: row[1].isContinuous === false (base_chance 0.25)", t && t.ambientSounds[1].isContinuous === false, String(t && t.ambientSounds[1].isContinuous));
}

// ===================================================================
// 2. BakedAmbientSource — lazy fetch + correct LB hex URL + caching
// ===================================================================
{
  const fetched = [];
  const fakeBody = JSON.stringify({
    source: "ambient", trigger: "terrain", terrain_type: 1, scene_type: 0,
    scene_info_idx: 0, stb_index: 0, stb_id: "0x20000017",
    vertex_indices: [0, 1, 2], ambient_sounds: [
      { s_type: 70, volume: 0.6, base_chance: 0.0, min_rate: 0, max_rate: 0, continuous: true },
    ],
  });
  const src = new BakedAmbientSource({
    baseUrl: "BASE/",
    fetchImpl: async (url) => {
      fetched.push(url);
      return { ok: true, status: 200, text: async () => fakeBody };
    },
  });

  // Holtburg lbX=0xA9 (169), lbY=0xB4 (180) → file 0xA9B4.
  const first = src.getTriggersForLb(169, 180);
  check("BakedSource: first ask returns null (pending)", first === null, String(first));
  // Let the async fetch + .text() chain fully settle (a setTimeout(0)
  // macrotask drains all pending microtasks first).
  await new Promise((r) => setTimeout(r, 0));
  const url = fetched[0];
  check("BakedSource: URL = BASE/0xA9B4.events.jsonl", url === "BASE/0xA9B4.events.jsonl", url);
  const second = src.getTriggersForLb(169, 180);
  check("BakedSource: second ask returns the parsed array", Array.isArray(second) && second.length === 1, JSON.stringify(second && second.length));
  check("BakedSource: cached — no re-fetch on second ask", fetched.length === 1, String(fetched.length));
  check("BakedSource: parsed stbId 0x20000017", second && second[0].stbId === 0x20000017, second && "0x" + second[0].stbId.toString(16));

  // 404 → cached empty (silence), no throw.
  const src404 = new BakedAmbientSource({
    baseUrl: "B/",
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => "" }),
  });
  src404.getTriggersForLb(1, 2);
  await new Promise((r) => setTimeout(r, 0));
  const r404 = src404.getTriggersForLb(1, 2);
  check("BakedSource: 404 → cached empty array (fail-soft)", Array.isArray(r404) && r404.length === 0, JSON.stringify(r404));
}

// ===================================================================
// 3. AmbientRuntime baked branch — retail gather over baked per-vertex STBs
// ===================================================================
function makeBakedRuntime(triggersByLb, playerPos) {
  const calls = [];
  const state = { clockMs: 0 };
  const audioManager = {
    async play(did, worldPos, opts) { calls.push({ fn: "play", did, worldPos, opts }); return {}; },
    async playFromCenter(did, vol, opts) { calls.push({ fn: "center", did, vol, opts }); return {}; },
  };
  // waveDid = 0x0A000000 + sType so assertions can tell which slot resolved.
  const soundTableCache = {
    async resolveSound(_stbId, sType) {
      return { waveDid: (0x0a000000 + (sType >>> 0)) >>> 0, volume: 1.0, probability: 1.0 };
    },
  };
  const rt = new AmbientRuntime({
    soundTableCache,
    audioManager,
    getPlayerPos: () => playerPos,
    getRegion: () => { throw new Error("getRegion must not be called in baked mode"); },
    getBakedAmbientTriggers: (lbX, lbY) => triggersByLb(lbX, lbY),
    rng: () => 0.0,
    clock: () => state.clockMs,
  });
  return { rt, calls, state };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

// Every vertex of every landblock is STB 0x20000017: a continuous bed (70)
// and an always-on intermittent (71, base_chance 1, every 1 s).
const ALL_VERTS = Array.from({ length: 81 }, (_, i) => i);
const TRIGGERS = [{
  stbId: 0x20000017,
  vertexIndices: ALL_VERTS,
  ambientSounds: [
    { sType: 70, volume: 0.6, baseChance: 0.0, minRate: 5, maxRate: 5, isContinuous: true },
    { sType: 71, volume: 0.5, baseChance: 1.0, minRate: 1, maxRate: 1, isContinuous: false },
  ],
}];
{
  const { rt, calls, state } = makeBakedRuntime(() => TRIGGERS, { x: 96, y: 96, z: 50 });
  rt.tick(0);
  await flush();
  check("baked: activeStbId 0x20000017", rt.stats().activeStbId === 0x20000017, "0x" + (rt.stats().activeStbId || 0).toString(16));
  const cont = calls.find((c) => c.did === 0x0a000000 + 70);
  check("baked: continuous bed plays at once from the centre (no loop)", !!cont && cont.fn === "center" && !cont.opts.loop,
    JSON.stringify(calls.map((c) => [c.fn, c.did.toString(16)])));
  check("baked: continuous volume = authored 0.6 x full share (one STB everywhere)", !!cont && Math.abs(cont.vol - 0.6) < 1e-6, cont && String(cont.vol));
  check("baked: ambient slider twice requested", !!cont && cont.opts.sliderTwice === true && cont.opts.category === "ambient");
  const chirp = calls.find((c) => c.did === 0x0a000000 + 71);
  check("baked: intermittent is positional (play with a worldPos)", !!chirp && chirp.fn === "play" && !!chirp.worldPos, chirp && chirp.fn);
  calls.length = 0;
  state.clockMs = 5100;
  rt.tick(0);
  await flush();
  check("baked: the continuous bed re-triggers as a one-shot after min_rate",
    calls.some((c) => c.did === 0x0a000000 + 70 && c.fn === "center"), JSON.stringify(calls.map((c) => c.did.toString(16))));
}
// Uncovered vertices -> no instances, no plays.
{
  const { rt, calls } = makeBakedRuntime(
    () => [{ stbId: 0x20000099, vertexIndices: [80], ambientSounds: [{ sType: 70, volume: 1, baseChance: 0, minRate: 5, maxRate: 5, isContinuous: true }] }],
    { x: 96, y: 96, z: 50 },
  );
  rt.tick(0);
  await flush();
  check("baked: STB only on unused vertex 80 (8x8 cells use x,y<8) -> silence", calls.length === 0 && rt.stats().activeStbId === null,
    JSON.stringify({ plays: calls.length, stb: rt.stats().activeStbId }));
}
// Triggers pending (null) -> no throw, region untouched, counted as missing.
{
  let threw = false;
  const { rt } = makeBakedRuntime(() => null, { x: 96, y: 96, z: 50 });
  try { rt.tick(0); } catch (_) { threw = true; }
  check("baked: pending triggers (null) -> no throw, region untouched", threw === false);
  check("baked: pending counted as terrainSampleMiss", rt.stats().terrainSampleMisses >= 1, String(rt.stats().terrainSampleMisses));
}

// eslint-disable-next-line no-console
console.log("=========================");
// eslint-disable-next-line no-console
console.log(`baked-events ambient: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
