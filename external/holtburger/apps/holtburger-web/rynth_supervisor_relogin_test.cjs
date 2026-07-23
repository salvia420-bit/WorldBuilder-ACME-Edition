#!/usr/bin/env node
// rynth_supervisor_relogin_test.cjs — pure-node regression: rynth/supervisor.cjs's
// per-account relogin path can never have two concurrent login attempts in
// flight for the SAME account (a "boot-loop stacking" hazard — the fleet
// manager's own account-lifecycle analogue of the soak-12 session-stacking
// bug the client's index.html was fixed for; rynth-review 17-SYNTHESIS
// streamline #11 / task W5a item 4a).
//
// supervisor.cjs does `const { chromium } = require("playwright")` at MODULE
// LOAD TIME (no lazy import) — it cannot be require()'d at all without the
// real package installed (verified: MODULE_NOT_FOUND on this box). Rather
// than skip the regression entirely, this intercepts JUST the bare
// "playwright" specifier (via node:module's Module._load, restored
// immediately after the one require this file needs) with a fully
// in-memory fake chromium/browser/page — no real browser, no network, no
// process spawn. The fake's page.evaluate() dispatches on the (fixed,
// SPEC-stable) closure source supervisor.cjs actually passes today — see
// EVAL_SHAPES below; an evaluate() call that matches none of them throws
// LOUDLY instead of silently no-op'ing, so a future supervisor.cjs edit
// that changes what it evaluates fails this test instead of passing one
// that no longer means anything.
//
// Scenario: one account, boots instantly (this test's own fake — no ACE),
// then health() is made to report "dead" every cycle forever (the fake
// never populates a fresh snapshot timestamp) — the worst-case stacking
// stress: every HEALTH_INTERVAL_MS tick tries to relogin the same account.
// Assertion: the observed concurrent-login-attempt count for that account
// never exceeds 1, across an initial boot + >=2 forced rebuilds.
//
// Run: node rynth_supervisor_relogin_test.cjs

"use strict";
const path = require("node:path");
const Module = require("node:module");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// ── fake `playwright`, intercepted at require() time only ──────────────────
const inFlight = new Map();   // account -> current concurrent-attempt count
const maxInFlight = new Map(); // account -> max concurrent-attempt count observed
const events = [];            // { t, kind, account } trace for diagnosis on failure
let gotoCount = 0, closeCount = 0, installCount = 0;

function accountOf(url) {
  return new URL(url).searchParams.get("account");
}
function bump(account, kind, delta) {
  const cur = (inFlight.get(account) || 0) + delta;
  inFlight.set(account, cur);
  maxInFlight.set(account, Math.max(maxInFlight.get(account) || 0, cur));
  events.push({ t: Date.now(), kind, account, level: cur });
}

class FakePage {
  constructor() {
    this._win = {}; // stand-in for the page's `window`
    this._resolved = true; // true until goto() opens an attempt
  }
  async goto(url) {
    this._account = accountOf(url);
    this._resolved = false;
    gotoCount++;
    bump(this._account, "goto", +1);
    // Instant, deterministic "in-world + real pose" — no timers, no ACE.
    this._win.__bootState = "in-world";
    this._win.__sessionHandle = { getLocalPlayerPose: () => ({ x: 1, y: 2, z: 3 }) };
  }
  async evaluate(fn, ..._args) {
    const src = fn.toString();
    if (src.includes("getLocalPlayerPose")) {
      // supervisor.cjs's pollTrulyInWorld() probe.
      const hist = Array.isArray(this._win.__bootStateHistory) ? this._win.__bootStateHistory : [];
      const reachedInWorld = this._win.__bootState === "in-world" || hist.some((e) => e && e.state === "in-world");
      if (this._win.__bootState === "error") return { ok: false, isError: true };
      if (!reachedInWorld) return { ok: false, isError: false };
      const h = this._win.__sessionHandle;
      let poseVal;
      try { poseVal = h && typeof h.getLocalPlayerPose === "function" ? h.getLocalPlayerPose() : undefined; } catch (_) { poseVal = undefined; }
      return { ok: poseVal !== undefined && poseVal !== null, isError: false };
    }
    if (src.includes("await import(")) {
      // installBot(): mark this attempt CONCLUDED (success) and leave the
      // fake window in a state health() will read as immediately stale —
      // no snapshot timestamp is ever populated, so every health cycle
      // reports dead and forces another relogin (the worst-case stress).
      installCount++;
      if (!this._resolved) { this._resolved = true; bump(this._account, "install", -1); }
      this._win.__rh = {}; // no .snap -> health() sees alive:false forever
      this._win.__kn = { status: { action: "idle", kills: 0, looted: 0 } };
      return undefined;
    }
    if (src.includes("window.__rh")) {
      // health(): mirror supervisor.cjs's own evaluate body exactly.
      const h = this._win.__rh;
      const alive = !!this._win.__sessionHandle && !!h && !!h.snap;
      const snapAge = h && h.snap ? Date.now() - h.snap.tMs : Infinity;
      const st = this._win.__kn ? this._win.__kn.status : null;
      return { alive, snapAge, status: st, boot: this._win.__bootState };
    }
    throw new Error(`FakePage.evaluate: unrecognized evaluate() shape (supervisor.cjs drifted from what this test fakes):\n${src}`);
  }
  async close() {
    closeCount++;
    if (!this._resolved) { this._resolved = true; bump(this._account, "close-unresolved", -1); }
  }
}

class FakeBrowser {
  async newPage() { return new FakePage(); }
  async close() {}
}

const fakePlaywright = { chromium: { async launch() { return new FakeBrowser(); } } };

const realLoad = Module._load;
let supervisor;
try {
  Module._load = function (request, parent, isMain) {
    if (request === "playwright") return fakePlaywright;
    return realLoad.call(this, request, parent, isMain);
  };
  supervisor = require(path.join(__dirname, "rynth", "supervisor.cjs"));
} finally {
  Module._load = realLoad; // restore immediately — only supervisor.cjs's own load needs the shim
}

(async () => {
  const ACCOUNT = "relogin-stress";
  // 2 forced rebuild cycles (5s HEALTH_INTERVAL_MS apart) plus the initial
  // boot — long enough to prove the guard holds across repeats, short
  // enough to stay well under the per-file test timeout.
  const RUN_MS = 12_000;

  const { summary } = await supervisor.runFleet(
    [{ account: ACCOUNT, password: "x", buffs: [] }],
    { runMs: RUN_MS, log: () => {} } // silence the [sup] log lines
  );

  check("scenario actually exercised: bootBot ran (goto) at least 3 times (initial + >=2 rebuilds)",
    gotoCount >= 3, `gotoCount=${gotoCount}`);
  check("installBot ran once per successful boot (matches gotoCount — every attempt in this fake succeeds first try)",
    installCount === gotoCount, `installCount=${installCount} gotoCount=${gotoCount}`);
  check("every attempt that opened also closed or installed (no leaked in-flight page)",
    (inFlight.get(ACCOUNT) || 0) === 0, `final in-flight level=${inFlight.get(ACCOUNT)}`);

  // ── the regression itself ──
  const max = maxInFlight.get(ACCOUNT) || 0;
  check(`relogin path never had >1 concurrent login attempt for '${ACCOUNT}' (max observed=${max})`,
    max <= 1,
    `event trace: ${JSON.stringify(events.slice(0, 40))}`);

  check("health-driven rebuilds actually happened (summary.rebuilds > 0 — proves the stress scenario, not a no-op run)",
    summary && summary[0] && summary[0].rebuilds > 0, JSON.stringify(summary));

  console.log(`${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e && e.stack || e);
  process.exit(1);
});
