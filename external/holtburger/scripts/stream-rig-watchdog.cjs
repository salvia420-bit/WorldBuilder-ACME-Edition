#!/usr/bin/env node
// stream-rig-watchdog.cjs — CDP recovery watchdog for the stream rig
// (P1 #5b, rynth-review 15 S1 / 13 #2 / 17-SYNTHESIS streamline #4,
// 2026-07-23). Promotes STREAM-RIG-OPS.md's "Driving the rig from a
// Claude session" lore into a spawned process launch.sh owns.
//
// Polls the game window's CDP endpoint (:9223 by default) every ~60s and
// makes exactly the three calls the runbook already documents by hand:
//   (a) page unreachable / no game tab found -> log LOUDLY and do
//       NOTHING else. Relaunching chromium is the operator's call
//       (launch.sh), never this script's — see STREAM-RIG-OPS.md trap #2
//       (session-restore tab wars) for why an unsupervised second
//       chromium is actively dangerous here.
//   (b) session alive (getLocalPlayerPose() resolves) but window.__bot is
//       absent -> the kind=7-skipped-on-takeover gap (rynth-review 15 C1
//       / 13 #2): re-import rynth/bot.js and createGrindBot() per the
//       runbook's documented recovery recipe (STREAM-RIG-OPS.md "Bot boot
//       notes").
//   (c) __bootState === 'error' AND no pose -> one bounded reload. Own
//       retry budget (max RELOAD_MAX per ROLLING_WINDOW_MS, in-memory —
//       shares item 1's "bounded, never infinite" philosophy but is a
//       SEPARATE counter from index.html's sessionStorage one; this is a
//       different failure surface, the watchdog's own crash-detection).
//   (d) every cycle, regardless of outcome, appends one heartbeat line to
//       LOG_FILE so an operator (or a future monitor) can see the
//       watchdog is alive without attaching CDP themselves.
//
// Fail-safe by construction: every cycle body runs inside its own
// try/catch (one bad cycle logs and moves on, never kills the loop), and
// process-level uncaughtException/unhandledRejection handlers do the
// same — a watchdog crash must never take the rig down, and correspondingly
// this script never calls browser.close() on its CDP connection (that can
// tear down the remote chromium, not just this script's handle to it).
//
// STOP-file aware: exits promptly if /mnt/wbterminal2/stream/STOP exists
// (checked at the top of every cycle), matching go_live.sh's semantics.
//
// Usage (spawned by launch.sh; also runnable by hand):
//   node scripts/stream-rig-watchdog.cjs
// Env overrides: WATCHDOG_CDP_URL, WATCHDOG_PAGE_URL_PREFIX,
//   WATCHDOG_POLL_MS, WATCHDOG_STOP_FILE, WATCHDOG_LOG_FILE,
//   PLAYWRIGHT_CACHE (NODE_PATH fallback — see capture_*.cjs precedent).

const path = require("node:path");
const fs = require("node:fs");

const PLAYWRIGHT_CACHE =
  process.env.PLAYWRIGHT_CACHE ||
  "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (_) {
  try {
    ({ chromium } = require(path.join(PLAYWRIGHT_CACHE, "playwright")));
  } catch (e) {
    console.error(
      "[stream-rig-watchdog] FAIL: playwright not found in NODE_PATH or " +
        PLAYWRIGHT_CACHE + " — set NODE_PATH or PLAYWRIGHT_CACHE.",
    );
    process.exit(2);
  }
}

const CDP_URL = process.env.WATCHDOG_CDP_URL || "http://127.0.0.1:9223";
const PAGE_URL_PREFIX =
  process.env.WATCHDOG_PAGE_URL_PREFIX ||
  "http://127.0.0.1:8765/apps/holtburger-web/index.html";
const POLL_MS = Number(process.env.WATCHDOG_POLL_MS || 60_000);
const STOP_FILE = process.env.WATCHDOG_STOP_FILE || "/mnt/wbterminal2/stream/STOP";
const LOG_FILE = process.env.WATCHDOG_LOG_FILE || "/mnt/wbterminal2/stream/watchdog.log";
const RELOAD_MAX = 5;
const RELOAD_WINDOW_MS = 10 * 60 * 1000; // 10 min — same budget shape as index.html's

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let reloadBudget = { windowStart: 0, count: 0 };

function heartbeat(line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(`[stream-rig-watchdog] ${stamped}`);
  try { fs.appendFileSync(LOG_FILE, stamped + "\n"); } catch (_) { /* logging must never crash the watchdog */ }
}

function reloadAllowed() {
  const now = Date.now();
  if (now - reloadBudget.windowStart > RELOAD_WINDOW_MS) reloadBudget = { windowStart: now, count: 0 };
  if (reloadBudget.count >= RELOAD_MAX) return false;
  reloadBudget.count += 1;
  return true;
}

async function findGamePage(browser) {
  for (const ctx of browser.contexts()) {
    const hit = ctx.pages().find((p) => p.url().startsWith(PAGE_URL_PREFIX));
    if (hit) return hit;
  }
  return null;
}

async function pollOnce() {
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (e) {
    heartbeat(`(a) CDP unreachable at ${CDP_URL}: ${String(e && e.message || e)} — operator's call to relaunch, NOT auto-relaunching`);
    return;
  }
  try {
    const page = await findGamePage(browser);
    if (!page) {
      heartbeat(`(a) CDP up but no page matching ${PAGE_URL_PREFIX} — operator's call to relaunch, NOT auto-relaunching`);
      return;
    }
    const diag = await page.evaluate(() => {
      let poseOk = false;
      try {
        const h = window.__sessionHandle;
        const pose = h && typeof h.getLocalPlayerPose === "function" ? h.getLocalPlayerPose() : undefined;
        poseOk = pose !== undefined && pose !== null;
        try { pose && typeof pose.free === "function" && pose.free(); } catch (_) { /* best-effort */ }
      } catch (_) { poseOk = false; }
      return { bootState: window.__bootState, hasSession: !!window.__sessionHandle, hasBot: !!window.__bot, poseOk };
    });

    if (diag.hasSession && diag.poseOk && !diag.hasBot) {
      // (b) alive session, no bot — the kind=7-skipped-on-takeover gap.
      // Runbook recipe (STREAM-RIG-OPS.md "Bot boot notes"): re-import
      // rynth/bot.js and createGrindBot on the live session, bare cfg —
      // the same call an operator would type by hand over CDP.
      heartbeat("(b) session alive, window.__bot absent — re-importing rynth/bot.js -> createGrindBot()");
      try {
        const result = await page.evaluate(async () => {
          const m = await import(new URL("rynth/bot.js", location.href).href);
          window.__bot = await m.createGrindBot(window.__sessionHandle, {});
          return true;
        });
        heartbeat(`(b) createGrindBot result: ${result}`);
      } catch (e) {
        heartbeat(`(b) createGrindBot FAILED: ${String(e && e.message || e)}`);
      }
    } else if (diag.bootState === "error" && !diag.poseOk) {
      // (c) latched error state with no pose to fall back on — reload,
      // bounded. (A latched 'error' with a good pose is the documented
      // false-positive the runbook warns about — NEVER reload on that.)
      if (reloadAllowed()) {
        heartbeat(`(c) bootState=error, no pose — reloading (attempt ${reloadBudget.count}/${RELOAD_MAX} this 10-min window)`);
        try { await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }); }
        catch (e) { heartbeat(`(c) reload FAILED: ${String(e && e.message || e)}`); }
      } else {
        heartbeat("(c) bootState=error, no pose — retry budget exhausted, leaving it for a human");
      }
    } else {
      heartbeat(`(d) heartbeat: bootState=${diag.bootState} session=${diag.hasSession} pose=${diag.poseOk} bot=${diag.hasBot}`);
    }
  } finally {
    // Never browser.close() a connectOverCDP handle — it can tear down
    // the remote chromium, not just this script's connection to it.
  }
}

async function main() {
  heartbeat(`watchdog starting (cdp=${CDP_URL} poll=${POLL_MS}ms stop=${STOP_FILE})`);
  for (;;) {
    if (fs.existsSync(STOP_FILE)) { heartbeat("STOP file present — exiting"); return; }
    try { await pollOnce(); } catch (e) { heartbeat(`cycle threw (swallowed): ${String(e && e.stack || e)}`); }
    await sleep(POLL_MS);
  }
}

process.on("uncaughtException", (e) => heartbeat(`uncaughtException (swallowed): ${String(e && e.stack || e)}`));
process.on("unhandledRejection", (e) => heartbeat(`unhandledRejection (swallowed): ${String(e && e.stack || e)}`));

main().catch((e) => { heartbeat(`main() threw: ${String(e && e.stack || e)}`); process.exit(1); });
