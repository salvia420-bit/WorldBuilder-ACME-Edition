// =============================================================================
// P4.2 follow-up F1 (2026-07-27) — buff-timer sign/age arithmetic tests
// =============================================================================
//
// ACE ground truth: wire `start_time` is RELATIVE and ≤ 0 — StartTime = 0 at
// cast, decremented per 5 s heartbeat (`enchantment.StartTime -=
// heartbeatInterval`, PropertiesEnchantmentRegistryExtensions.cs:251), so an
// enchantment re-sent aged N seconds (relog registry dump) arrives with
// start_time = −N. ACE's remaining-lifetime formula at send time is
//   remaining = Duration + StartTime          (EnchantmentManager.cs:188)
//
// Before F1:
//   - plugins/buffs-hud.js `remainingSeconds` ignored startTime entirely →
//     an aged re-send restarted the countdown at FULL duration (overestimate
//     = age).
//   - rynth/buff_loop.js used `receivedAt + duration − start` (sign error) →
//     the rebuff bot's expiry estimate was 2×age late.
//
// Scenarios: fresh cast · aged relog re-send · rebuff timing.
//
// Run from apps/holtburger-web/:
//   node tests/bufftime_f1.test.mjs
// =============================================================================

import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUFFS_URL = pathToFileURL(
  path.join(__dirname, "..", "plugins", "buffs-hud.js")
).href;
const BUFF_LOOP_URL = pathToFileURL(
  path.join(__dirname, "..", "rynth", "buff_loop.js")
).href;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  [FAIL] ${name}: ${err.message}`);
  }
}

// ─── Minimal DOM shim (same pattern as tests/buffs_hud.test.cjs) ───
function installDomShim() {
  const elementProto = {
    appendChild(c) { this.children = this.children || []; this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs = this.attrs || {}; this.attrs[k] = v; },
    removeChild() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    get isConnected() { return true; },
    set innerHTML(v) { this._innerHTML = v; this.children = []; },
    get innerHTML() { return this._innerHTML || ""; },
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, contains: () => false },
  };
  function mkEl() {
    return Object.assign(Object.create(elementProto), {
      attrs: {}, dataset: {}, style: {}, children: [],
      classList: { add() {}, remove() {}, contains: () => false },
    });
  }
  globalThis.document = {
    head: mkEl(), body: mkEl(),
    createElement: () => mkEl(),
    getElementById: () => null,
  };
  globalThis.window = globalThis;
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({}) });
}

// ─── Controllable clock: both consumers read Date.now() at call time ───
const realDateNow = Date.now;
function setNowMs(ms) { Date.now = () => ms; }
function restoreNow() { Date.now = realDateNow; }

// Fixed wall-clock origin (Unix ms). Absolute value is irrelevant to the
// arithmetic — that's the point of the receivedAt anchor.
const T0_MS = 1_785_000_000_000;
const T0_S = T0_MS / 1000;

(async () => {
  installDomShim();
  const { __test } = await import(BUFFS_URL);
  const { remainingSeconds, refreshFromSnapshot, state } = __test;
  const { RynthBuffLoop } = await import(BUFF_LOOP_URL);

  try {
    // ─── [1] buffs-hud remainingSeconds — direct arithmetic ───
    console.log("\n[1] buffs-hud remainingSeconds (ACE remaining = duration + startTime)");

    check("fresh cast (startTime 0): full duration at receive", () => {
      setNowMs(T0_MS);
      assert.equal(
        remainingSeconds({ duration: 1800, startTime: 0, receivedAt: T0_S }),
        1800
      );
    });

    check("fresh cast: counts down with elapsed wall time", () => {
      setNowMs(T0_MS + 60_000);
      assert.equal(
        remainingSeconds({ duration: 1800, startTime: 0, receivedAt: T0_S }),
        1740
      );
    });

    check("aged relog re-send (startTime −600): remaining = 1200, NOT full 1800", () => {
      setNowMs(T0_MS);
      const r = remainingSeconds({ duration: 1800, startTime: -600, receivedAt: T0_S });
      assert.equal(r, 1200);              // duration + startTime
      assert.notEqual(r, 1800);           // pre-F1 bug: restarted at full duration
    });

    check("aged re-send still ages from receipt", () => {
      setNowMs(T0_MS + 60_000);
      assert.equal(
        remainingSeconds({ duration: 1800, startTime: -600, receivedAt: T0_S }),
        1140
      );
    });

    check("over-aged re-send (age ≥ duration) reads expired, not positive", () => {
      setNowMs(T0_MS);
      const r = remainingSeconds({ duration: 1800, startTime: -1801, receivedAt: T0_S });
      assert.ok(r <= 0, `expected ≤ 0, got ${r}`);
    });

    check("permanent (duration −1 / 0) stays ∞ regardless of startTime", () => {
      setNowMs(T0_MS);
      assert.equal(remainingSeconds({ duration: -1, startTime: -600, receivedAt: T0_S }), Infinity);
      assert.equal(remainingSeconds({ duration: 0, startTime: -600, receivedAt: T0_S }), Infinity);
    });

    check("synthetic positive startTime clamps to 0 (old duration-only path)", () => {
      setNowMs(T0_MS);
      assert.equal(
        remainingSeconds({ duration: 600, startTime: 1000, receivedAt: T0_S }),
        600
      );
    });

    // ─── [2] buffs-hud ingestion path — aged relog through refreshFromSnapshot ───
    console.log("\n[2] buffs-hud refreshFromSnapshot → stampReceivedAt → remainingSeconds");

    check("aged wire row (relog dump) lands with remaining = duration + start_time", () => {
      setNowMs(T0_MS);
      refreshFromSnapshot([
        { spell_id: 1017, layer: 0, spell_category: 101, power_level: 250,
          start_time: -600, duration: 1800, caster_guid: 0x50000001,
          stat_mod_type: 0x0004 /* additive-ish; not COOLDOWN */,
          stat_mod_key: 1, stat_mod_value: 10 },
      ]);
      assert.equal(state.enchantments.size, 1);
      const rec = [...state.enchantments.values()][0];
      assert.equal(remainingSeconds(rec), 1200);
      refreshFromSnapshot([]); // leave shared state clean for other suites
    });

    // ─── [3] rynth buff_loop — expiry estimate & rebuff timing ───
    console.log("\n[3] buff_loop _readRegistry expiry (pre-F1: 2×age late)");

    function mkLoop(rows) {
      const host = {
        s: { playerEnchantments: () => rows.slice() },
      };
      return new RynthBuffLoop(host, [], { tierLadders: false, log: () => {} });
    }

    check("fresh cast: expiresAt = receivedAt + duration", () => {
      setNowMs(T0_MS);
      const loop = mkLoop([
        { spellId: 1017, spellCategory: 101, startTime: 0, duration: 1800 },
      ]);
      const fam = loop._readRegistry();
      assert.ok(fam && fam.get(101), "family 101 present");
      assert.equal(fam.get(101).expiresAtMs, (T0_S + 1800) * 1000);
    });

    check("aged re-send (age 600): expiresAt = receivedAt + 1200 — NOT +2400 (2×age late)", () => {
      setNowMs(T0_MS);
      const loop = mkLoop([
        { spellId: 1017, spellCategory: 101, startTime: -600, duration: 1800 },
      ]);
      const fam = loop._readRegistry();
      const e = fam.get(101);
      assert.ok(e, "family 101 present");
      assert.equal(e.expiresAtMs, (T0_S + 1200) * 1000);
      // Pre-F1 sign error: (receivedAt + duration − start) = T0 + 2400 —
      // the bot believed the buff alive 2×age past true server expiry.
      assert.notEqual(e.expiresAtMs, (T0_S + 2400) * 1000);
    });

    check("rebuff timing: true remaining 250 s < B3 threshold 300 s reads as due", () => {
      setNowMs(T0_MS);
      const loop = mkLoop([
        { spellId: 1017, spellCategory: 101, startTime: -1550, duration: 1800 },
      ]);
      const e = loop._readRegistry().get(101);
      const remainingS = e.expiresAtMs / 1000 - T0_S;
      assert.equal(remainingS, 250);
      assert.ok(remainingS < 300, "must fall below the B3 rebuff threshold");
      // Pre-F1 the same row read 1800 + 1550 = 3350 s remaining → the bot
      // idled while the server let the buff lapse.
    });

    check("fully expired aged row (age ≥ duration) is dropped from the registry view", () => {
      setNowMs(T0_MS);
      const loop = mkLoop([
        { spellId: 1017, spellCategory: 101, startTime: -1801, duration: 1800 },
      ]);
      const fam = loop._readRegistry();
      assert.equal(fam.get(101), undefined);
    });

    check("synthetic positive start clamps to 0 in buff_loop too", () => {
      setNowMs(T0_MS);
      const loop = mkLoop([
        { spellId: 1017, spellCategory: 101, startTime: 400, duration: 1800 },
      ]);
      assert.equal(loop._readRegistry().get(101).expiresAtMs, (T0_S + 1800) * 1000);
    });
  } finally {
    restoreNow();
  }

  console.log("\n========");
  console.log(`${passed} passed, ${failed} failed (total ${passed + failed} assertions)`);
  console.log("========");
  if (failed > 0) {
    for (const f of failures) console.error(`FAIL ${f.name}\n  ${f.err.stack}`);
    process.exit(1);
  }
})();
