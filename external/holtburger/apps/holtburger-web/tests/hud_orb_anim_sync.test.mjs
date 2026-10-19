// tests/hud_orb_anim_sync.test.mjs — fps review 2026-10-19, HUD part (orbs).
//
// The orbs' ambient CSS loops (specular drift, bubbles, mana shimmer, fracture
// glints / bloom, low-HP heartbeat) are `infinite` animations on SVG children,
// which Blink advances and re-rasters at DISPLAY rate on top of the 30 Hz wave
// tick. `?orbAnimSync` (DEFAULT ON) pauses each one and sets its currentTime
// from the document timeline on the driver's cadence ticks only.
//
// CONTRACT
//   [1] orbAnimSyncEnabled: default ON; off / 0 / false / no (any case,
//       trimmed) turn it off; anything else stays on; read once (memoized).
//   [2] makeOrbAnimSync returns null when the flag is off, and when no root
//       has getAnimations (today's behaviour: Blink keeps its own clock).
//   [3] step(now) adopts every INFINITE animation at its current phase
//       (start = now - currentTime), pauses it and sets currentTime from the
//       timeline; finite ones (the damage glare) are left alone.
//   [4] later steps advance adopted loops in lockstep with the timeline;
//       a loop that starts later (`.beat`) is picked up; one that ended
//       drops out of the live set.
//   [5] release(now) hands every live loop back to Blink's clock at its
//       phase (currentTime set, then play()).
//   [6] source: the driver builds the sync (never under reduced motion),
//       steps it on cadence ticks BEFORE the wave writes, releases it on
//       stop(), and mount() passes the panes as its roots.
//
// Run:
//   cd apps/holtburger-web/
//   node tests/hud_orb_anim_sync.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Minimal DOM shim so the real plugin module imports.
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = {
  createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, setAttribute() {}, addEventListener() {} }),
  getElementById: () => null, head: { appendChild() {}, prepend() {} }, body: { appendChild() {} },
  addEventListener() {}, removeEventListener() {},
  documentElement: { style: { setProperty() {} } },
};

const O = await import("../plugins/vitals-orbs.js");
const { orbAnimSyncEnabled, __setOrbAnimSyncForTest, makeOrbAnimSync } = O;

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.message}`); }
}
function assertEq(a, e, label) {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assert(cond, label) { if (!cond) throw new Error(label); }

function withSearch(search, fn) {
  const prev = globalThis.location;
  globalThis.location = { search };
  __setOrbAnimSyncForTest(undefined);
  try { return fn(); } finally {
    globalThis.location = prev;
    __setOrbAnimSyncForTest(undefined);
  }
}

check("[1] default ON (no URL, empty URL, unrelated params)", () => {
  assertEq(withSearch("", () => orbAnimSyncEnabled()), true, "empty");
  assertEq(withSearch("?vitalsOrbs=on", () => orbAnimSyncEnabled()), true, "unrelated");
  assertEq(withSearch("?orbAnimSync=on", () => orbAnimSyncEnabled()), true, "=on");
  assertEq(withSearch("?orbAnimSync=maybe", () => orbAnimSyncEnabled()), true, "garbage stays on");
});

check("[1] off-forms turn it off, any case, trimmed", () => {
  for (const v of ["off", "OFF", "0", "false", "False", "no", "NO", "%20Off%20"]) {
    assertEq(withSearch(`?orbAnimSync=${v}`, () => orbAnimSyncEnabled()), false, `=${v}`);
  }
});

check("[1] memoized: a later URL change does not move a read value", () => {
  const prev = globalThis.location;
  globalThis.location = { search: "?orbAnimSync=off" };
  __setOrbAnimSyncForTest(undefined);
  assertEq(orbAnimSyncEnabled(), false, "first read");
  globalThis.location = { search: "" };
  assertEq(orbAnimSyncEnabled(), false, "still the memoized value");
  globalThis.location = prev;
  __setOrbAnimSyncForTest(undefined);
});

// Stub Web Animations: only what makeOrbAnimSync touches.
function anim(currentTime, iterations = Infinity) {
  return {
    currentTime,
    playState: "running",
    pauses: 0,
    plays: 0,
    effect: { getTiming: () => ({ iterations }) },
    pause() { this.pauses += 1; this.playState = "paused"; },
    play() { this.plays += 1; this.playState = "running"; },
  };
}
function root(list) {
  return { list, getAnimations(opts) { assertEq(opts, { subtree: true }, "getAnimations({ subtree: true })"); return this.list.slice(); } };
}

check("[2] null when the flag is off", () => {
  __setOrbAnimSyncForTest(false);
  assertEq(makeOrbAnimSync([root([anim(0)])]), null, "flag off");
  __setOrbAnimSyncForTest(undefined);
});

check("[2] null when no root has getAnimations (or there are no roots)", () => {
  __setOrbAnimSyncForTest(true);
  assertEq(makeOrbAnimSync([{}, { getAnimations: 1 }]), null, "no getAnimations");
  assertEq(makeOrbAnimSync([]), null, "empty roots");
  assertEq(makeOrbAnimSync(null), null, "null roots");
  __setOrbAnimSyncForTest(undefined);
});

check("[3]-[5] adopt, advance in lockstep, pick up, drop, release", () => {
  __setOrbAnimSyncForTest(true);
  const sspec = anim(500);
  const shimmer = anim(1200);
  const glare = anim(100, 1);
  const r = root([sspec, glare, shimmer]);
  const sync = makeOrbAnimSync([r, {}]); // a root without getAnimations is skipped
  assert(sync, "built");

  sync.step(1000);
  assertEq([sspec.playState, sspec.currentTime], ["paused", 500], "sspec adopted at its phase");
  assertEq([shimmer.playState, shimmer.currentTime], ["paused", 1200], "shimmer adopted at its phase");
  assertEq([glare.playState, glare.currentTime, glare.pauses], ["running", 100, 0], "finite glare untouched");
  assertEq(sync.count, 2, "two live loops");

  sync.step(1033);
  assertEq([sspec.currentTime, shimmer.currentTime], [533, 1233], "advanced with the timeline");
  assertEq(sspec.pauses, 1, "no re-pause of a paused loop");

  const beat = anim(40);
  r.list = [sspec, beat];  // shimmer ended (class removed), beat started (.beat)
  sync.step(1066);
  assertEq([beat.playState, beat.currentTime], ["paused", 40], "late loop adopted at its phase");
  assertEq(sspec.currentTime, 566, "sspec still in lockstep");
  assertEq(sync.count, 2, "shimmer dropped, beat added");

  sync.step(1100);
  sync.release(1150);
  assertEq([sspec.currentTime, sspec.plays, sspec.playState], [650, 1, "running"], "sspec handed back at its phase");
  assertEq([beat.currentTime, beat.plays], [124, 1], "beat handed back at its phase");
  assertEq(shimmer.plays, 0, "an ended loop is not resumed");
  assertEq(sync.count, 0, "nothing live after release");
  __setOrbAnimSyncForTest(undefined);
});

check("[3] a loop with no currentTime yet (not started) is not adopted", () => {
  __setOrbAnimSyncForTest(true);
  const pending = anim(null);
  const sync = makeOrbAnimSync([root([pending])]);
  sync.step(2000);
  assertEq([pending.pauses, sync.count], [0, 0], "left alone");
  __setOrbAnimSyncForTest(undefined);
});

check("[6] source: driver + mount wiring", () => {
  const src = readFileSync(path.join(APP, "plugins/vitals-orbs.js"), "utf8");
  const drv = src.match(/function createDriver\(orbs, reducedMotion, hz, syncRoots = null\) \{([\s\S]*?)\n\}\n/);
  assert(drv, "createDriver(…, syncRoots) found");
  const body = drv[1];
  assert(/const sync = reducedMotion \? null : makeOrbAnimSync\(syncRoots\);/.test(body), "built from syncRoots, never under reduced motion");
  const frame = body.match(/function frame\(t\) \{([\s\S]*?)\n  \}/);
  assert(frame, "frame() found");
  const f = frame[1];
  const iCadence = f.indexOf("if (acc < minStep) return;");
  const iStep = f.indexOf("sync.step(");
  const iTick = f.indexOf("tick(clock, acc);");
  assert(iCadence >= 0 && iStep > iCadence, "stepped only past the cadence gate");
  assert(iTick > iStep, "stepped BEFORE the wave writes");
  assert(/stop\(\) \{[\s\S]*?sync\.release\(/.test(body), "released on stop()");
  assert(/createDriver\(orbs, reduced, orbHz\(\), paneList\)/.test(src), "mount passes the panes as roots");
});

console.log(`\n===========================================================`);
console.log(`PASS: ${passed} / ${passed + failed}`);
console.log(`===========================================================`);
if (failed > 0) process.exitCode = 1;
