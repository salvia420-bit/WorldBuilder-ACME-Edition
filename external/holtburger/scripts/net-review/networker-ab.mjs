#!/usr/bin/env node
// networker-ab.mjs — one zero-GPU boot of one ?netWorker arm. Driven N× per
// arm by networker-ab.sh. Measures: wire-message rates, movement speed over
// ground + rubber-band snaps (A12 "slow down while running"), and session
// survival across a synthetic 10s main-thread freeze.
//
// Usage: node networker-ab.mjs --net-worker 0|1 [--move 40] [--freeze 10]
//        [--run-id r1] [--out f.json]

import { pathToFileURL } from "node:url";
import fs from "node:fs";

const BOOT_MJS = process.env.BOOT_MJS ||
  "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/harness/lib/boot.mjs";
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const NET_WORKER = arg("net-worker", "0") === "1";
const MOVE_S = Number(arg("move", "40"));
const FREEZE_S = Number(arg("freeze", "10"));
const RUN_ID = arg("run-id", "r0");
const OUT = arg("out", "");

const boot = await import(pathToFileURL(BOOT_MJS).href);
// Zero-GPU bot mode per fleet spec. netWorker gate is allowlist 1|on|true
// (net_worker_client.js:netWorkerEnabled) so "0" is a true OFF arm.
const { page, helpers, inWorld } = await boot.launchAndEnter({
  query: { nosw: "1", renderOnDemand: "1", netDrainHz: "30",
           netWorker: NET_WORKER ? "1" : "0" },
  timeoutMs: 120_000,
});
const fail = async (reason) => {
  console.log(JSON.stringify({ ok: false, runId: RUN_ID, netWorker: NET_WORKER, reason }));
  console.log(`NETWORKER-AB SUMMARY: ${RUN_ID} arm=${NET_WORKER ? 1 : 0} FAIL ${reason}`);
  await helpers.close(); process.exit(2);
};
if (!inWorld) await fail("boot-stalled");

// Validity gate: with arm=1, confirm the worker actually armed (spawn failure
// silently falls back to direct start_session — handle.__netWorker is the tell).
const workerArmed = await helpers.evalInPage(() => !!(window.__sessionHandle && window.__sessionHandle.__netWorker));
if (NET_WORKER && !workerArmed) await fail("netWorker-requested-but-fell-back");

const wireSummary = () => helpers.evalInPage(() => {
  try { return window.__diag?.wire?.summary?.() ?? null; } catch (_) { return null; }
});
const getGlobalPose = () => helpers.evalInPage(() => {
  try {
    const p = window.__sessionHandle.getLocalPlayerPose();
    if (!p || p.landblockId == null) return null;
    const lb = p.landblockId >>> 0;
    return { gx: ((lb >>> 24) & 0xFF) * 192 + p.x, gy: ((lb >>> 16) & 0xFF) * 192 + p.y,
             lb, cell: lb & 0xFFFF };
  } catch (_) { return null; }
});
// chat-echo probe: @say token → event:2 counter delta + tail snippet match
const chatEcho = async (token, timeoutMs) => {
  const before = await helpers.evalInPage(() =>
    { try { return window.__diag?.wire?.counters?.["event:2"] ?? null; } catch (_) { return null; } });
  const t0 = Date.now();
  await helpers.evalInPage((tok) => { try { window.__sessionHandle.sendChat("@say " + tok); } catch (_) {} }, token);
  while (Date.now() - t0 < timeoutMs) {
    await page.waitForTimeout(250);
    const hit = await helpers.evalInPage((tok) => {
      try {
        const w = window.__diag?.wire;
        if (!w) return null; // wire diag absent — echo unverifiable
        const tail = w.tail || [];
        return tail.some((r) => r && typeof r.snippet === "string" && r.snippet.includes(tok));
      } catch (_) { return null; }
    }, token);
    if (hit === null) return { verdict: "unknown-no-wire-diag", rttMs: null };
    if (hit) return { verdict: "ok", rttMs: Date.now() - t0 };
  }
  const after = await helpers.evalInPage(() =>
    { try { return window.__diag?.wire?.counters?.["event:2"] ?? null; } catch (_) { return null; } });
  // counter moved but snippet truncated/missed → soft-ok
  if (before != null && after != null && after > before) return { verdict: "soft-ok-counter-moved", rttMs: null };
  return { verdict: "timeout", rttMs: null };
};

await page.waitForTimeout(5000); // settle
const wire0 = await wireSummary();

// ── movement phase: square pattern via setMovementInput (keyboard fallback) ──
const hasSMI = await helpers.evalInPage(() =>
  typeof window.__sessionHandle?.setMovementInput === "function");
const setMove = (f, s, t, run) => helpers.evalInPage(([f2, s2, t2, r2]) => {
  const h = window.__sessionHandle;
  if (h && typeof h.setMovementInput === "function") { h.setMovementInput(f2, s2, t2, r2); return "smi"; }
  // keyboard fallback (install-movement.js convention: document-level events,
  // 'w' forward / 'e' turn-right; NO Shift — Shift is WALK in AC)
  const fire = (key, type) => document.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
  fire("w", f2 > 0 ? "keydown" : "keyup");
  fire("e", t2 !== 0 ? "keydown" : "keyup");
  return "kbd";
}, [f, s, t, run]);

const LEG_MS = 8000, TURN_MS = 1500;
const poseSamples = [];
const sampleTimer = setInterval(async () => {
  try { const p = await getGlobalPose(); if (p) poseSamples.push({ t: Date.now(), ...p }); } catch (_) {}
}, 200);
const moveEnd = Date.now() + MOVE_S * 1000;
while (Date.now() < moveEnd) {
  await setMove(1, 0, 0, true);
  await page.waitForTimeout(Math.min(LEG_MS, Math.max(0, moveEnd - Date.now())));
  if (Date.now() >= moveEnd) break;
  await setMove(0, 0, 1, true);
  await page.waitForTimeout(TURN_MS);
}
await setMove(0, 0, 0, false);
clearInterval(sampleTimer);

// speed + rubber-band analysis (EMA velocity; snap-back = displacement
// opposing smoothed velocity by >0.75m; spike = >12 m/s instantaneous)
const speeds = [], snaps = [];
let emaVx = 0, emaVy = 0;
for (let i = 1; i < poseSamples.length; i++) {
  const a = poseSamples[i - 1], b = poseSamples[i];
  const dt = (b.t - a.t) / 1000;
  if (dt <= 0 || dt > 2) continue;
  const dx = b.gx - a.gx, dy = b.gy - a.gy, d = Math.hypot(dx, dy), v = d / dt;
  if (v > 40) continue; // teleport-scale jump, not movement
  const dot = dx * emaVx + dy * emaVy;
  if (d > 0.75 && dot < 0 && Math.hypot(emaVx, emaVy) > 0.5)
    snaps.push({ i, t: b.t - poseSamples[0].t, backM: +d.toFixed(2) });
  else if (v > 12) snaps.push({ i, t: b.t - poseSamples[0].t, spikeMps: +v.toFixed(1) });
  speeds.push(v);
  emaVx = 0.7 * emaVx + 0.3 * (dx / dt); emaVy = 0.7 * emaVy + 0.3 * (dy / dt);
}
speeds.sort((x, y) => x - y);
const medianSpeed = speeds.length ? +speeds[(speeds.length / 2) | 0].toFixed(2) : null;
const wire1 = await wireSummary();

// ── freeze phase: synchronous busy-loop on the main thread ──
const preFreezeWire = await wireSummary();
const preFreezePose = await getGlobalPose();
const freezeT0 = Date.now();
await page.evaluate((ms) => {                 // the injected freeze itself
  const end = performance.now() + ms;
  while (performance.now() < end) { /* saturate main thread */ }
  return true;
}, FREEZE_S * 1000);
const freezeActualMs = Date.now() - freezeT0;

// recovery: post-freeze burst (queued backlog draining), pose resume, chat echo
await page.waitForTimeout(3000);
const postFreezeWire = await wireSummary();
let poseResumedMs = null;
const rT0 = Date.now();
while (Date.now() - rT0 < 15_000) {
  const p = await getGlobalPose();
  if (p && preFreezePose && (p.gx !== preFreezePose.gx || p.gy !== preFreezePose.gy || p.cell !== preFreezePose.cell)) {
    poseResumedMs = Date.now() - rT0; break;
  }
  // stationary is legal — also accept a fresh net pump as "alive"
  const pumpAge = await helpers.evalInPage(() =>
    window.__lastPumpMs != null ? performance.now() - window.__lastPumpMs : null);
  if (pumpAge != null && pumpAge < 1500) { poseResumedMs = Date.now() - rT0; break; }
  await page.waitForTimeout(500);
}
const echo = await chatEcho(`ab-${RUN_ID}-${NET_WORKER ? 1 : 0}`, 10_000);
const errsAll = helpers.consoleErrors();
const timeoutErrs = errsAll.filter((e) => /timeout|disconnect|closed|dropped/i.test(e.text));
const survived = echo.verdict !== "timeout" && poseResumedMs != null;

const payload = {
  ok: true, runId: RUN_ID, netWorker: NET_WORKER, workerArmed, inputPath: hasSMI ? "setMovementInput" : "keyboard",
  movement: { medianSpeedMps: medianSpeed, samples: poseSamples.length,
              snapCount: snaps.length, snaps: snaps.slice(0, 20) },
  wire: { boot: wire0, postMove: wire1, preFreeze: preFreezeWire, postFreeze3s: postFreezeWire,
          postFreezeBurst: postFreezeWire && preFreezeWire ? postFreezeWire.total - preFreezeWire.total : null },
  freeze: { requestedMs: FREEZE_S * 1000, actualMs: freezeActualMs,
            poseResumedMs, chatEcho: echo, survived,
            timeoutErrorCount: timeoutErrs.length, timeoutErrors: timeoutErrs.slice(0, 5) },
  consoleErrorCount: errsAll.length,
};
const json = JSON.stringify(payload, null, 2);
if (OUT) fs.writeFileSync(OUT, json);
console.log(json);
console.log(`NETWORKER-AB SUMMARY: ${RUN_ID} arm=${NET_WORKER ? 1 : 0} armed=${workerArmed} ` +
  `speed=${medianSpeed}m/s snaps=${snaps.length} survived=${survived} ` +
  `echo=${echo.verdict} poseResume=${poseResumedMs}ms burst=${payload.wire.postFreezeBurst}`);
await helpers.close();
process.exit(survived ? 0 : 1);
