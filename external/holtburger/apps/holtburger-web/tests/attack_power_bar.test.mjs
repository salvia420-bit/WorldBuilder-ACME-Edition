// tests/attack_power_bar.test.mjs — retail hold-to-charge power bar
// (ui/attack_power_bar.js, 2026-10-07).
//
// Retail ClientCombatSystem (acclient.c): PRESS starts the bar (1.0 s to full,
// 0.8 s dual-wield — GetPowerBarLevel :407919); RELEASE commits
// max(selector, bar) (EndAttackRequest :408952): at/over the selector it fires
// now — and a bar that overshot the selector sends a second request at the
// selector (ACE's AttackQueue gives that to the auto-repeats); under it, the
// bar keeps building and fires on reaching the selector (UseTime :409015).
//
// Run from apps/holtburger-web/:  node tests/attack_power_bar.test.mjs

import assert from "node:assert/strict";
import {
  powerBarLevel,
  decideRelease,
  createAttackCharge,
  POWER_BAR_FULL_SECONDS,
  POWER_BAR_FULL_SECONDS_DUAL_WIELD,
} from "../ui/attack_power_bar.js";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

check("retail charge durations: 1.0 s, 0.8 s dual-wield", () => {
  assert.equal(POWER_BAR_FULL_SECONDS, 1.0);
  assert.equal(POWER_BAR_FULL_SECONDS_DUAL_WIELD, 0.8);
});

check("powerBarLevel is linear and clamped", () => {
  assert.equal(powerBarLevel(0), 0);
  assert.equal(powerBarLevel(-5), 0);
  assert.ok(near(powerBarLevel(500), 0.5));
  assert.equal(powerBarLevel(1000), 1);
  assert.equal(powerBarLevel(5000), 1);
  assert.ok(near(powerBarLevel(400, 0.8), 0.5));
});

check("release under the selector keeps building toward it", () => {
  assert.deepEqual(decideRelease(0.3, 0.6), { fireNow: false, power: 0.6, followUpPower: null });
});
check("release past the selector fires at the bar, then a selector follow-up", () => {
  const d = decideRelease(0.8, 0.6);
  assert.equal(d.fireNow, true);
  assert.ok(near(d.power, 0.8));
  assert.ok(near(d.followUpPower, 0.6));
});
check("release at the selector fires once (no follow-up)", () => {
  assert.deepEqual(decideRelease(0.6, 0.6), { fireNow: true, power: 0.6, followUpPower: null });
  assert.deepEqual(decideRelease(1, 1), { fireNow: true, power: 1, followUpPower: null });
});

function rig({ slider = 0.75, dual = false, ready = () => true } = {}) {
  const env = { t: 0, slider, fires: [], snaps: [] };
  env.charge = createAttackCharge({
    now: () => env.t,
    fire: (h, p, o) => env.fires.push([h, +p.toFixed(4), !!o?.followUp]),
    getSlider: () => env.slider,
    isDualWield: () => dual,
    isReady: ready,
    publish: (s) => env.snaps.push(s),
  });
  return env;
}

check("TAP: attacks at the selector once the bar reaches it", () => {
  const e = rig({ slider: 0.75 });
  e.charge.press(2);
  e.t = 60;
  e.charge.release(2);
  assert.deepEqual(e.fires, [], "a 60 ms tap does not fire at 6 % power");
  e.t = 700;
  e.charge.tick();
  assert.deepEqual(e.fires, [], "still building toward the selector");
  e.t = 750;
  e.charge.tick();
  assert.deepEqual(e.fires, [[2, 0.75, false]], "fires exactly at the selector");
  e.t = 900;
  e.charge.tick();
  assert.equal(e.fires.length, 1, "fires once");
  assert.equal(e.charge.building, false);
});

check("HOLD: charges past the selector; release fires at the charged level + selector follow-up", () => {
  const e = rig({ slider: 0.5 });
  e.charge.press(1);
  e.t = 900;
  e.charge.tick();
  assert.equal(e.snaps.at(-1).building, true);
  assert.ok(near(e.snaps.at(-1).level, 0.9), "the bar shows the charge while held");
  e.charge.release(1);
  assert.deepEqual(e.fires, [[1, 0.9, false], [1, 0.5, true]]);
});

check("HOLD past full stays at 100 %", () => {
  const e = rig({ slider: 0.25 });
  e.charge.press(3);
  e.t = 3000;
  e.charge.release(3);
  assert.deepEqual(e.fires, [[3, 1, false], [3, 0.25, true]]);
});

check("selector at 100 %: a tap waits a full second, a hold fires once at full", () => {
  const e = rig({ slider: 1 });
  e.charge.press(2);
  e.t = 100;
  e.charge.release(2);
  e.t = 999;
  e.charge.tick();
  assert.deepEqual(e.fires, []);
  e.t = 1000;
  e.charge.tick();
  assert.deepEqual(e.fires, [[2, 1, false]]);
});

check("dual-wield fills in 0.8 s", () => {
  const e = rig({ slider: 0.2, dual: true });
  e.charge.press(2);
  e.t = 400;
  e.charge.release(2);
  assert.deepEqual(e.fires, [[2, 0.5, false], [2, 0.2, true]]);
});

check("pressing another height mid-build retargets the height (SetRequestedAttackHeight)", () => {
  const e = rig({ slider: 0.1 });
  e.charge.press(1);
  e.t = 200;
  e.charge.press(3);
  e.t = 300;
  e.charge.release(1); // the first key's release is not the active height
  assert.deepEqual(e.fires, []);
  e.charge.release(3);
  assert.deepEqual(e.fires, [[3, 0.3, false], [3, 0.1, true]]);
});

check("leaving the ready position cancels the request", () => {
  let ready = true;
  const e = rig({ slider: 0.9, ready: () => ready });
  e.charge.press(2);
  e.t = 50;
  e.charge.release(2);
  ready = false;
  e.t = 2000;
  e.charge.tick();
  assert.deepEqual(e.fires, []);
  assert.equal(e.charge.building, false);
});

check("cancel() drops a held build without firing", () => {
  const e = rig();
  e.charge.press(2);
  e.t = 500;
  e.charge.cancel();
  e.charge.release(2);
  assert.deepEqual(e.fires, []);
});

console.log(`\nattack_power_bar: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
