// audio_ambient_model.test.mjs — retail terrain-ambient model.
//
// Ported from OpenAC tests/AcDream.Core.Tests/Audio/AmbientSoundTests.cs
// (MIT). Retail: acclient.c 352444-352509 (gather), 383857-383925
// (CalcWeight/CalcDir), 384200-384308 (UpdateSound/AddTo/GetSoundPos),
// 384004/384013 (intervals), 384452-384531 (Play/UseTime), 384630
// (UpdatePlayQueue).
//
// Fails on the old code: scene3d/audio/ambient_model.js did not exist —
// the old ambient_runtime.js read ONE nearest vertex, had no weighting, no
// directions and no deadline queue (see audio_ambient_runtime.test.mjs for
// the runtime-level failures).
//
// Run: node tests/audio_ambient_model.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";
import {
  calcWeight, calcDirection, Dir, AmbientSoundInstance, AmbientSoundScheduler,
  gatherAmbient, MIN_VOLUME, IN_BLOCK_NEAR_DISTANCE, SHELL_HALF_THICKNESS, rollDice,
} from "../scene3d/audio/ambient_model.js";

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n    ${err.message}`); process.exitCode = 1; }
};
const near = (a, b, eps = 1e-3, m = "") => assert.ok(Math.abs(a - b) <= eps, `${m} ${a} vs ${b}`);
const scripted = (...rolls) => () => (rolls.length ? rolls.shift() : 0);
const V = (x, y, z = 0) => ({ x, y, z });
const Continuous = (volume = 1, minRate = 5) => ({ sType: 0x46, volume, baseChance: 0, minRate, maxRate: 0 });
const Intermittent = (volume = 1, baseChance = 0.5, minRate = 4, maxRate = 10) =>
  ({ sType: 0x47, volume, baseChance, minRate, maxRate });

test("baseChance 0 means continuous", () => {
  assert.equal(new AmbientSoundInstance(Continuous(), 1, "a").isContinuous, true);
  assert.equal(new AmbientSoundInstance(Intermittent(), 1, "b").isContinuous, false);
});
for (const [d, w] of [[0, 1], [19.9, 1], [20, 1], [40, 0.25], [120, 400 / 14400], [120.1, 0], [500, 0]]) {
  test(`calcWeight(${d}) = ${w}`, () => near(calcWeight(V(d, 0)), w, 1e-4));
}
test("inside 14.14 m is in-viewer-block", () => {
  assert.equal(calcDirection(V(14.1, 0)), Dir.IN_VIEWER_BLOCK);
  assert.notEqual(calcDirection(V(14.2, 0)), Dir.IN_VIEWER_BLOCK);
});
for (const [x, y, d] of [[0, 50, Dir.NORTH], [0, -50, Dir.SOUTH], [50, 0, Dir.EAST], [-50, 0, Dir.WEST],
  [40, 40, Dir.NORTHEAST], [-40, 40, Dir.NORTHWEST], [40, -40, Dir.SOUTHEAST], [-40, -40, Dir.SOUTHWEST]]) {
  test(`calcDirection(${x},${y}) = ${d}`, () => assert.equal(calcDirection(V(x, y)), d));
}
test("diagonal needs both axes within 2x", () => {
  assert.equal(calcDirection(V(20, 50)), Dir.NORTH);
  assert.equal(calcDirection(V(30, 40)), Dir.NORTHEAST);
});
test("continuous volume is its share of the total weight", () => {
  const s = new AmbientSoundScheduler(scripted());
  s.beginRebuild();
  const grass = s.track(Continuous(), 0x20000001);
  const shore = s.track(Continuous(), 0x20000002);
  s.contribute(grass, V(1, 0)); s.contribute(grass, V(2, 0)); s.contribute(grass, V(3, 0));
  s.contribute(shore, V(4, 0));
  s.endRebuild(0);
  near(s.totalSoundCount, 4); near(grass.currentVolume, 0.75); near(shore.currentVolume, 0.25);
});
test("continuous bed below 0.03 cannot be heard", () => {
  const s = new AmbientSoundScheduler(scripted());
  s.beginRebuild();
  const faint = s.track(Continuous(), 1);
  const loud = s.track(Continuous(), 2);
  s.contribute(faint, V(119, 0));
  for (let i = 0; i < 5; i++) s.contribute(loud, V(i, 0));
  s.endRebuild(0);
  assert.ok(faint.currentVolume < MIN_VOLUME);
  assert.equal(faint.canHear(), false);
  assert.equal(loud.canHear(), true);
});
test("intermittent play chance scales with its share, volume stays authored", () => {
  const s = new AmbientSoundScheduler(scripted());
  s.beginRebuild();
  const a = s.track(Intermittent(0.8, 0.6), 1);
  const b = s.track(Intermittent(0.8, 0.6), 2);
  s.contribute(a, V(1, 0)); s.contribute(b, V(2, 0));
  s.endRebuild(0);
  near(a.playChance, 0.3); near(a.getVolume(), 0.8);
});
test("intermittent with zero weight after a rebuild cannot be heard", () => {
  const s = new AmbientSoundScheduler(scripted());
  s.beginRebuild();
  const i = s.track(Intermittent(1, 0.6), 1);
  s.contribute(i, V(1, 0));
  s.endRebuild(0);
  near(i.playChance, 0.6);
  s.beginRebuild(); s.endRebuild(0);
  assert.equal(i.playChance, 0); assert.equal(i.canHear(), false);
});
test("rebuild resets stale bearings", () => {
  const s = new AmbientSoundScheduler(scripted());
  s.beginRebuild();
  const i = s.track(Intermittent(), 1);
  s.contribute(i, V(0, 60)); s.endRebuild(0);
  assert.ok(i.directions.some((d) => d.dir === Dir.NORTH));
  s.beginRebuild(); s.contribute(i, V(0, -60)); s.endRebuild(0);
  assert.ok(!i.directions.some((d) => d.dir === Dir.NORTH));
});
test("in-viewer-block contribution spreads over all 8 directions", () => {
  const s = new AmbientSoundScheduler(scripted());
  s.beginRebuild();
  const i = s.track(Intermittent(), 1);
  s.contribute(i, V(3, 0)); s.endRebuild(0);
  assert.equal(i.directions.length, 8);
  for (const d of i.directions) { near(d.min, IN_BLOCK_NEAR_DISTANCE); near(d.max, SHELL_HALF_THICKNESS); }
});
test("continuous PlayNow is always true", () => {
  assert.equal(new AmbientSoundInstance(Continuous(), 1, "k").playNow(scripted(0.99)), true);
});
for (const [roll, exp] of [[0.4, true], [0.5, true], [0.6, false]]) {
  test(`intermittent PlayNow roll ${roll} vs 0.5 -> ${exp}`, () => {
    const s = new AmbientSoundScheduler(scripted());
    s.beginRebuild();
    const i = s.track(Intermittent(1, 0.5), 1);
    s.contribute(i, V(1, 0)); s.endRebuild(0);
    assert.equal(i.playNow(scripted(roll)), exp);
  });
}
test("continuous bed has no position", () => {
  assert.equal(new AmbientSoundInstance(Continuous(), 1, "k").getSoundPosition(V(100, 200, 10), scripted()), null);
});
test("intermittent position offsets the listener and keeps its Z", () => {
  const s = new AmbientSoundScheduler(scripted());
  s.beginRebuild();
  const i = s.track(Intermittent(), 1);
  s.contribute(i, V(0, 60)); s.endRebuild(0);
  const p = i.getSoundPosition(V(100, 200, 37), scripted(0, 0.5, 1));
  assert.equal(p.z, 37); assert.ok(p.y > 200); near(p.x, 100, 0.1);
});
test("intermittent distance is quadratically biased toward min", () => {
  const s = new AmbientSoundScheduler(scripted());
  s.beginRebuild();
  const i = s.track(Intermittent(), 1);
  s.contribute(i, V(0, 60)); s.endRebuild(0);
  const sh = i.directions[0];
  const p = i.getSoundPosition(V(0, 0, 0), scripted(0, 0.5, 0.5));
  near(Math.hypot(p.x, p.y), sh.min + (sh.max - sh.min) * 0.25, 0.1);
});
test("continuous interval is min_rate only", () => {
  assert.equal(new AmbientSoundInstance(Continuous(1, 7), 1, "k").getPlayInterval(scripted(0.9)), 7);
});
test("intermittent interval rolls between the authored rates", () => {
  near(new AmbientSoundInstance(Intermittent(1, 0.5, 4, 10), 1, "k").getPlayInterval(scripted(0.5)), 7);
});
test("rollDice swaps an inverted range", () => near(rollDice(10, 4, scripted(0.5)), 7));

test("scheduler fires after the deadline (strictly) and re-arms", () => {
  const s = new AmbientSoundScheduler(scripted());
  const f = [];
  s.beginRebuild();
  const bed = s.track(Continuous(1, 5), 1);
  s.contribute(bed, V(0, 0)); s.endRebuild(0, f, V(0, 0));
  f.length = 0;
  s.tick(4.9, f, V(0, 0)); assert.equal(f.length, 0);
  s.tick(5.0, f, V(0, 0)); assert.equal(f.length, 0);
  s.tick(5.01, f, V(0, 0)); assert.equal(f.length, 1);
  assert.equal(bed.onQueue, true); assert.equal(s.queuedCount, 1);
  f.length = 0;
  s.tick(10.1, f, V(0, 0)); assert.equal(f.length, 1);
});
test("arming plays immediately with no initial delay", () => {
  const s = new AmbientSoundScheduler(scripted());
  const f = [];
  s.beginRebuild();
  const bed = s.track(Continuous(1, 30), 1);
  s.contribute(bed, V(0, 0)); s.endRebuild(100, f, V(0, 0));
  assert.equal(f.length, 1); assert.equal(bed.onQueue, true);
});
test("zero play interval does not spin forever", () => {
  const s = new AmbientSoundScheduler(scripted());
  s.beginRebuild();
  const bed = s.track(Continuous(1, 0), 1);
  s.contribute(bed, V(0, 0)); s.endRebuild(0);
  const f = [];
  s.tick(1, f, V(0, 0));
  assert.equal(f.length, 1);
});
test("rebuild does not re-arm an already-queued instance", () => {
  const s = new AmbientSoundScheduler(scripted());
  s.beginRebuild();
  const bed = s.track(Continuous(1, 5), 1);
  s.contribute(bed, V(0, 0)); s.endRebuild(0);
  for (let k = 0; k < 5; k++) { s.beginRebuild(); s.contribute(bed, V(0, 0)); s.endRebuild(0); }
  assert.equal(s.queuedCount, 1);
});
test("an instance that becomes audible is armed", () => {
  const s = new AmbientSoundScheduler(scripted());
  s.beginRebuild();
  const bed = s.track(Continuous(1, 5), 1);
  s.endRebuild(0);
  assert.equal(s.queuedCount, 0);
  s.beginRebuild(); s.contribute(bed, V(0, 0)); s.endRebuild(0);
  assert.equal(s.queuedCount, 1);
});
test("an instance that went inaudible is dropped from the queue", () => {
  const s = new AmbientSoundScheduler(scripted());
  s.beginRebuild();
  const bed = s.track(Continuous(1, 5), 1);
  s.contribute(bed, V(0, 0)); s.endRebuild(0);
  s.beginRebuild(); s.endRebuild(0);
  const f = [];
  s.tick(99, f, V(0, 0));
  assert.equal(f.length, 0); assert.equal(s.queuedCount, 0); assert.equal(bed.onQueue, false);
});
test("continuous firing has no position, intermittent does", () => {
  const s = new AmbientSoundScheduler(scripted());
  s.beginRebuild();
  const bed = s.track(Continuous(1, 1), 1);
  const chirp = s.track(Intermittent(1, 1, 1, 1), 2);
  s.contribute(bed, V(0, 0)); s.contribute(chirp, V(0, 60));
  s.endRebuild(0);
  const f = [];
  s.tick(1.01, f, V(0, 0));
  assert.equal(f.length, 2);
  assert.equal(f.find((x) => x.instance === bed).position, null);
  assert.ok(f.find((x) => x.instance === chirp).position);
});
test("clear drops everything", () => {
  const s = new AmbientSoundScheduler(scripted());
  s.beginRebuild();
  const bed = s.track(Continuous(), 1);
  s.contribute(bed, V(0, 0)); s.endRebuild(0);
  s.clear();
  assert.equal(s.queuedCount, 0); assert.equal(s.instances.length, 0);
  assert.equal(bed.onQueue, false); assert.equal(s.totalSoundCount, 0);
});

// ── gatherer ──
const uniform = (n) => () => ({ stbId: 0x20000001, sounds: Array.from({ length: n }, (_, i) => ({ ...Continuous(1, 5), sType: 0x46 + i })) });
const MID = V(0xa9 * 192 + 96, 0xb4 * 192 + 96, 0);
test("gatherer: listener inside the block accumulates weight", () => {
  const s = new AmbientSoundScheduler(scripted());
  gatherAmbient(s, MID, () => uniform(1), 0);
  assert.ok(s.totalSoundCount > 0);
  assert.equal(s.instances.length, 1);
  assert.equal(s.instances[0].canHear(), true);
});
test("gatherer: total weight counts cells once, not once per ambient row", () => {
  const one = new AmbientSoundScheduler(scripted());
  gatherAmbient(one, MID, () => uniform(1), 0);
  const three = new AmbientSoundScheduler(scripted());
  gatherAmbient(three, MID, () => uniform(3), 0);
  near(one.totalSoundCount, three.totalSoundCount);
  assert.equal(three.instances.length, 3);
  for (const bed of three.instances) near(bed.currentVolume, one.instances[0].currentVolume);
});
test("gatherer: missing neighbours contribute nothing, reported as missing", () => {
  const s = new AmbientSoundScheduler(scripted());
  const r = gatherAmbient(s, MID, (x, y) => (x === 0xa9 && y === 0xb4 ? uniform(1) : null), 0);
  assert.ok(s.totalSoundCount > 0);
  assert.equal(r.missing, 8);
});
test("gatherer: unauthored terrain produces no ambients", () => {
  const s = new AmbientSoundScheduler(scripted());
  gatherAmbient(s, MID, () => () => null, 0);
  assert.equal(s.instances.length, 0); assert.equal(s.totalSoundCount, 0);
});
test("gatherer: weights neighbouring cells (not just the nearest vertex)", () => {
  // Two terrain kinds: west half of the block = STB A, east half = STB B.
  const lookup = () => (vi) => ({
    stbId: Math.floor(vi / 9) < 4 ? 0x20000001 : 0x20000002,
    sounds: [Continuous(1, 5)],
  });
  const s = new AmbientSoundScheduler(scripted());
  gatherAmbient(s, MID, lookup, 0);
  const vols = s.instances.map((i) => i.currentVolume);
  assert.equal(s.instances.length, 2);
  assert.ok(vols.every((v) => v > 0.2), `both beds audible: ${vols}`);
});

console.log(`\n${passed} passed${process.exitCode ? ", FAILURES above" : ""}`);
