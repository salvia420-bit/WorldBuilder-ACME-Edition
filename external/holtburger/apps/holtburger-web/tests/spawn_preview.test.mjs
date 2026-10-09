// tests/spawn_preview.test.mjs — app/spawn_preview.js (2026-10-09): the
// character-select warm-up's remembered spots and its start.
//
// What must hold:
//   - spots are keyed per server + account + character (case-insensitive
//     server/account) and round-trip through storage; malformed or empty
//     records read back as null, never as a guess;
//   - the recorder writes on a landblock change at once, otherwise at most
//     every `minIntervalMs`; `flush` always writes; no key (no character in
//     the world yet) writes nothing;
//   - startSpawnPreview waits for the 3D scene, hands it the normalized spot,
//     and does nothing when `?spawnPreview=off`, without a spot, or when the
//     scene never arrives;
//   - newCharacterSpot gives the Training Academy a new character starts in:
//     the chosen start area's first location, else the wizard's default (the
//     first heritage's primary, then secondary, area); null without one.
//
// Run from apps/holtburger-web/:  node tests/spawn_preview.test.mjs

import assert from "node:assert/strict";
import {
  LAST_LOCATION_PREFIX,
  createLocationRecorder,
  isIndoorCell,
  lastLocationKey,
  loadLastLocation,
  newCharacterSpot,
  normalizeLocation,
  saveLastLocation,
  spawnPreviewEnabled,
  startSpawnPreview,
} from "../app/spawn_preview.js";

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.stack || e.message}`); }
}
function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m };
}

const HOLT = { cell: 0xa9b40019, x: 82.7, y: 8.8, z: 94 };

await check("keys: per server + account + character, case-insensitive server/account", () => {
  const a = lastLocationKey({ server: "Play.Example:9000", account: "Tailnet1", charId: 0x50000007 });
  const b = lastLocationKey({ server: "play.example:9000", account: "tailnet1", charId: 0x50000007 });
  assert.equal(a, b);
  assert.ok(a.startsWith(LAST_LOCATION_PREFIX));
  assert.notEqual(a, lastLocationKey({ server: "play.example:9000", account: "tailnet1", charId: 0x50000008 }));
  assert.notEqual(a, lastLocationKey({ server: "other:9000", account: "tailnet1", charId: 0x50000007 }));
});

await check("spots round-trip; malformed / empty ones read back as null", () => {
  const s = memStorage();
  const k = lastLocationKey({ server: "s", account: "a", charId: 7 });
  assert.equal(loadLastLocation(s, k), null, "nothing saved yet");
  assert.equal(saveLastLocation(s, k, HOLT), true);
  const got = loadLastLocation(s, k);
  assert.equal(got.cell, HOLT.cell);
  assert.deepEqual([got.x, got.y, got.z], [HOLT.x, HOLT.y, HOLT.z]);
  assert.ok(got.t > 0, "stamped");
  s.setItem(k, "{not json");
  assert.equal(loadLastLocation(s, k), null);
  assert.equal(normalizeLocation({ cell: 0, x: 1, y: 2, z: 3 }), null, "cell 0");
  assert.equal(normalizeLocation({ cell: 0x19, x: 1, y: 2, z: 3 }), null, "no landblock");
  assert.equal(normalizeLocation({ cell: HOLT.cell, x: NaN, y: 2, z: 3 }), null, "bad coordinate");
  assert.equal(saveLastLocation(s, k, { cell: 0 }), false, "a bad spot is not written");
});

await check("indoor = cell low word >= 0x100 (retail objcell discriminator)", () => {
  assert.equal(isIndoorCell(0xa9b40019), false);
  assert.equal(isIndoorCell(0xa9b40141), true);
});

await check("recorder: landblock change writes at once, same landblock throttled, flush always", () => {
  const s = memStorage();
  let t = 1000;
  let key = null;
  const r = createLocationRecorder({ storage: s, getKey: () => key, minIntervalMs: 15000, now: () => t });
  assert.equal(r.note({ landblockId: HOLT.cell, x: 1, y: 2, z: 3 }), false, "no key (no character in the world)");
  key = lastLocationKey({ server: "s", account: "a", charId: 7 });
  assert.equal(r.note({ landblockId: HOLT.cell, x: 1, y: 2, z: 3 }), true, "first sighting");
  t += 5000;
  assert.equal(r.note({ landblockId: HOLT.cell + 1, x: 5, y: 2, z: 3 }), false, "same landblock, too soon");
  t += 11000;
  assert.equal(r.note({ landblockId: HOLT.cell + 1, x: 6, y: 2, z: 3 }), true, "same landblock after the interval");
  t += 1000;
  assert.equal(r.note({ landblockId: 0xaab40019, x: 7, y: 2, z: 3 }), true, "landblock change at once");
  assert.equal(loadLastLocation(s, key).cell, 0xaab40019);
  assert.equal(r.flush({ landblockId: 0xaab40020, x: 8, y: 2, z: 3 }), true, "flush always writes");
  assert.equal(loadLastLocation(s, key).x, 8);
  assert.equal(r.note(null), false);
});

await check("startSpawnPreview: waits for the scene, then hands it the normalized spot", async () => {
  const calls = [];
  let scene = null;
  setTimeout(() => { scene = { previewSpawnArea: (loc) => { calls.push(loc); return { cell: loc.cell }; } }; }, 30);
  const r = await startSpawnPreview({ loc: { ...HOLT, extra: 1 }, getScene: () => scene, pollMs: 5, timeoutMs: 1000, search: "" });
  assert.deepEqual(r, { cell: HOLT.cell });
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]).sort(), ["cell", "t", "x", "y", "z"]);
});

await check("startSpawnPreview: off flag, no spot, no scene in time, or a player in the world → null", async () => {
  const scene = { previewSpawnArea: () => ({ cell: 1 }) };
  assert.equal(spawnPreviewEnabled("?spawnPreview=off"), false);
  assert.equal(spawnPreviewEnabled(""), true);
  assert.equal(await startSpawnPreview({ loc: HOLT, getScene: () => scene, search: "?spawnPreview=off" }), null);
  assert.equal(await startSpawnPreview({ loc: null, getScene: () => scene, search: "" }), null);
  assert.equal(await startSpawnPreview({ loc: HOLT, getScene: () => null, pollMs: 5, timeoutMs: 30, search: "" }), null);
  assert.equal(await startSpawnPreview({ loc: HOLT, getScene: () => ({ previewSpawnArea: () => null }), search: "" }), null,
    "the scene refuses once a player exists");
});

// The catalog shape `client.characters.getCatalog()` returns (plain objects,
// rynth/webhost.js plainFromMaps). Values read from the live ACE catalog on
// 2026-10-09: every academy is cell 0x01AD of its own landblock.
const ACADEMY = { x: 12.319899559020996, y: -28.48200035095215, z: 0.004999999888241291 };
const CATALOG = {
  heritages: [
    { heritageId: 1, name: "Aluvian", primaryStartAreaIds: [0], secondaryStartAreaIds: [1, 2, 3] },
    { heritageId: 3, name: "Sho", primaryStartAreaIds: [1], secondaryStartAreaIds: [0, 2, 3] },
  ],
  starterAreas: [
    { startAreaId: 0, name: "Holtburg", firstLocation: { cell: 0x860201ad, ...ACADEMY } },
    { startAreaId: 1, name: "Shoushi", firstLocation: { cell: 0x7f0301ad, ...ACADEMY } },
    { startAreaId: 2, name: "Yaraq", firstLocation: { cell: 0x8c0401ad, ...ACADEMY } },
    { startAreaId: 3, name: "Sanamar", firstLocation: { cell: 0x720201ad, ...ACADEMY } },
    { startAreaId: 9, name: "(synthetic, no location)", firstLocation: null },
  ],
};

await check("newCharacterSpot: the chosen area's academy, else the wizard's default", () => {
  assert.equal(newCharacterSpot(CATALOG, 1).cell, 0x7f0301ad);
  assert.equal(newCharacterSpot(CATALOG, 3).cell, 0x720201ad);
  assert.equal(newCharacterSpot(CATALOG, 0).cell, 0x860201ad, "area 0 is a real id, not 'none'");
  assert.equal(newCharacterSpot(CATALOG).cell, 0x860201ad, "default: first heritage's primary area");
  assert.equal(newCharacterSpot(CATALOG, null).cell, 0x860201ad);
  assert.equal(newCharacterSpot({ ...CATALOG, heritages: [CATALOG.heritages[1]] }).cell, 0x7f0301ad);
  // Synthetic: a heritage with only secondary areas.
  const secondaryOnly = { ...CATALOG, heritages: [{ heritageId: 99, primaryStartAreaIds: [], secondaryStartAreaIds: [2] }] };
  assert.equal(newCharacterSpot(secondaryOnly).cell, 0x8c0401ad, "falls back to the secondary area");
  assert.ok(isIndoorCell(newCharacterSpot(CATALOG).cell), "an academy is indoors");
});

await check("newCharacterSpot: no catalog, unknown area, or an area without a location → null", () => {
  assert.equal(newCharacterSpot(null), null);
  assert.equal(newCharacterSpot({}), null);
  assert.equal(newCharacterSpot(CATALOG, 7), null, "unknown area");
  assert.equal(newCharacterSpot(CATALOG, 9), null, "an area without a location");
  assert.equal(newCharacterSpot({ ...CATALOG, heritages: [{ heritageId: 3 }] }), null);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
