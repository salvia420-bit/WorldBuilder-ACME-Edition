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

// ---- load ambient_runtime.js (strip the adapter import + exports) ----
function loadAmbientRuntime() {
  const full = resolvePath(__dirname, "scene3d/audio/ambient_runtime.js");
  let src = readFileSync(full, "utf8");
  src = src.replace(
    /^\s*import\s+\{\s*acToThree\s*\}\s+from\s+["']\.\.\/adapter\.js["'];?\s*$/m,
    "const acToThree = (ax, ay, az) => [ax, az, -ay];"
  );
  src = src
    .replace(/^\s*export\s+function\s+/gm, "function ")
    .replace(/^\s*export\s+class\s+/gm, "class ")
    .replace(/^\s*export\s+const\s+/gm, "const ")
    .replace(/^\s*export\s+default\s+/gm, "")
    .replace(/^\s*export\s+\{[^}]+\}[\s;]*$/gm, "");
  const composite =
    "// === ambient_runtime.js ===\n" + src + "\n; return { AmbientRuntime };";
  const factory = new Function("performance", "console", composite);
  return factory(globalThis.performance ?? { now: () => Date.now() }, console)
    .AmbientRuntime;
}
const AmbientRuntime = loadAmbientRuntime();

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
// 3. AmbientRuntime baked branch — per-vertex STB selection + play
// ===================================================================
function makeBakedRuntime(triggersByLb, playerPos, vertexCode = 1) {
  const playCalls = [];
  const state = { clockMs: 0 };
  const audioManager = {
    async play(did, worldPos, opts) {
      playCalls.push({ did, worldPos, opts });
      return { source: { stop() {} }, panner: {}, gain: {} };
    },
  };
  // resolveSound encodes the sType into the waveDid so we can assert
  // which Sound enum slot resolved: waveDid = 0x0A000000 + sType.
  const soundTableCache = {
    async resolveSound(_stbId, sType) {
      return { waveDid: (0x0a000000 + (sType >>> 0)) >>> 0, volume: 1.0 };
    },
  };
  // One terrain mesh covering lb (0,0) with a uniform code grid.
  const codes = new Uint8Array(81).fill(vertexCode);
  const mesh = { userData: { lbX: 0, lbY: 0, terrainCodes: codes } };
  const rt = new AmbientRuntime({
    soundTableCache,
    audioManager,
    getPlayerPos: () => playerPos,
    // getRegion THROWS — proves baked mode never touches the live chain.
    getRegion: () => {
      throw new Error("getRegion must not be called in baked mode");
    },
    getBakedAmbientTriggers: (lbX, lbY) => triggersByLb(lbX, lbY),
    getTerrainMeshes: () => [mesh],
    rng: () => 0.0,
    clock: () => state.clockMs,
  });
  return { rt, playCalls, state };
}

// Player at LB (0,0) local (0,0) → col=0,row=0 → vertexIndex 0.
const TRIGGERS = [
  {
    stbId: 0x20000017,
    vertexIndices: [0, 1, 2],
    ambientSounds: [
      { sType: 70, volume: 0.6, baseChance: 0.0, minRate: 0, maxRate: 0, isContinuous: true },
      { sType: 71, volume: 0.5, baseChance: 1.0, minRate: 1, maxRate: 1, isContinuous: false },
    ],
  },
];

{
  const { rt, playCalls, state } = makeBakedRuntime(
    () => TRIGGERS,
    { x: 0.1, y: 0.1, z: 50 }
  );
  // Tick 1: clock baseline (dt=0). Continuous loop starts (dt-independent);
  // probabilistic timer for sType 71 seeds at 1s.
  rt.tick(0);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  check("baked: activeStbId resolved to 0x20000017 from vertex 0", rt.stats().activeStbId === 0x20000017, "0x" + (rt.stats().activeStbId || 0).toString(16));
  const cont = playCalls.find((c) => c.did === 0x0a000000 + 70);
  check("baked: continuous sType 70 played (waveDid 0x0A000046)", !!cont, JSON.stringify(playCalls.map((c) => "0x" + c.did.toString(16))));
  check("baked: continuous opts.loop === true + category ambient", !!cont && cont.opts.loop === true && cont.opts.category === "ambient", cont && JSON.stringify({ loop: cont.opts.loop, cat: cont.opts.category }));

  // Tick 2: advance wall clock +1.0s → probabilistic sType 71 timer
  // expires; rng()=0 < baseChance 1.0 → fires.
  state.clockMs = 1000;
  rt.tick(0);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const prob = playCalls.find((c) => c.did === 0x0a000000 + 71);
  check("baked: probabilistic sType 71 fired after +1s (waveDid 0x0A000047)", !!prob, JSON.stringify(playCalls.map((c) => "0x" + c.did.toString(16))));
  check("baked: probabilistic opts.loop === false", !!prob && prob.opts.loop === false, prob && String(prob.opts.loop));
}

// Vertex NOT covered by any trigger → no STB → no play.
{
  const { rt, playCalls } = makeBakedRuntime(
    () => [{ stbId: 0x20000099, vertexIndices: [5, 6, 7], ambientSounds: [{ sType: 70, volume: 1, baseChance: 0, minRate: 0, maxRate: 0, isContinuous: true }] }],
    { x: 0.1, y: 0.1, z: 50 } // vertexIndex 0, not in [5,6,7]
  );
  rt.tick(0);
  await Promise.resolve();
  await Promise.resolve();
  check("baked: uncovered vertex → no STB, no play, activeStbId null", playCalls.length === 0 && rt.stats().activeStbId === null, JSON.stringify({ plays: playCalls.length, stb: rt.stats().activeStbId }));
}

// Triggers pending (null) → transient miss, getRegion NOT called (no throw).
{
  let threw = false;
  const { rt } = makeBakedRuntime(() => null, { x: 0.1, y: 0.1, z: 50 });
  try {
    rt.tick(0);
  } catch (e) {
    threw = true;
  }
  check("baked: pending triggers (null) → no throw, region untouched", threw === false, "threw=" + threw);
  check("baked: pending counted as terrainSampleMiss", rt.stats().terrainSampleMisses >= 1, String(rt.stats().terrainSampleMisses));
}

// eslint-disable-next-line no-console
console.log("=========================");
// eslint-disable-next-line no-console
console.log(`baked-events ambient: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
