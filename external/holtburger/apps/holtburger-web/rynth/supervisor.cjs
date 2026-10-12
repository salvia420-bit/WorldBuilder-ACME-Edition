// RynthSupervisor — the multi-account bot fleet manager (report 06 §b).
//
// One Chrome page per account; each page boots holtburger-web headless,
// installs the RynthWebHost + BotKernel, and grinds. The supervisor owns
// process lifecycle the loops don't: login retry (the Account-In-Use kick
// dance), disconnect detection, and auto-relogin. serve.py needs zero
// changes (stateless — report 06 §b); the ceiling is browser-side tab
// throttling + ACE's per-account session model, not the HTTP server.
//
// Usage:
//   node rynth_supervisor.cjs '[{"account":"a","password":"a","buffs":[2,24]}]'
//
// Bot page contract (installed via evaluate): window.__bot (createGrindBot),
// window.__rh (its RynthWebHost), window.__kn (its BotKernel). Health =
// __rh.snap freshness + the live session (handle identity, link age); a
// stalled snapshot or a dropped session triggers a rebuild.
//
// 2026-10-12 update (client drift since 2026-07-23):
// - Every page is retired with SessionHandle.disconnect() (2026-10-09) before
//   it closes. Closing a page alone leaves its ACE session alive, the relogin
//   meets "Account In Use", and ACE drops BOTH sessions — the rebuild burned
//   its attempt and the reap backoff for nothing.
// - installBot builds the bot with createGrindBot (the README's one-call
//   entrypoint) instead of hand-assembling combat/buff/loot: the old fleet
//   bots ran with NO vitals loop (no emergency heals) and no unwedge reflex.
//   AI director off unless the account config asks for it.
// - Readiness is pose-first: a real getLocalPlayerPose() after in-world wins
//   even if `__bootState` latched "error" (the 90 s scene watchdog fires on a
//   slow-but-fine boot — STATUS.md "Readiness-gate reversal"); "error" with no
//   pose still fails the attempt. A latched "error" no longer marks a running
//   bot dead either.
// - A page that reconnected in place (new __sessionHandle) gets its host
//   re-attached instead of grinding on the freed handle while the worker
//   heartbeat keeps the snapshot "fresh"; a link silent for LINK_DEAD_MS
//   (sessionLastRecvAgeMs) is dead.

const { chromium } = require("playwright");

const BASE_URL =
  process.env.RYNTH_URL ||
  "http://127.0.0.1:8765/apps/holtburger-web/index.html";
const HEALTH_INTERVAL_MS = 5000;
const SNAP_STALE_MS = 8000; // snapshot older than this = the tick died
const LINK_DEAD_MS = 45_000; // no inbound packet this long = the session is gone (ACE drops at 60 s)
const RELOGIN_BACKOFF_MS = 20_000; // ACE session reap window (an unclean exit; a clean disconnect is immediate)
const DISCONNECT_FLUSH_MS = 750; // let the recv loop send the DISCONNECT before the page goes
const BOOT_ATTEMPTS = 4;

// ── OPT-IN sidecar health watch (env RYNTH_SIDECAR_URL; default unset=off) ──
// When set (e.g. http://127.0.0.1:8767), the fleet loop ALSO polls
// <url>/health each cycle and logs LOUDLY on down/up transitions (plus a
// periodic reminder while down). Deliberately observe-only: the supervisor
// NEVER spawns the sidecar — process lifecycle belongs to
// scripts/rynthnav-sidecar-boot.sh (cron @reboot; see the sidecar README's
// Lifecycle section). Keeping the concerns separate means a supervisor
// crash/restart can never double-start the sidecar, and a sidecar restart
// never recycles healthy bot pages.
const SIDECAR_HEALTH_TIMEOUT_MS = 3000;
const SIDECAR_DOWN_REMIND_CYCLES = 6; // re-log while down every ~30s (6x5s cycles)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sidecarHealth(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), SIDECAR_HEALTH_TIMEOUT_MS);
  try {
    const r = await fetch(`${url}/health`, { signal: ctl.signal });
    const j = await r.json();
    return { up: !!j && j.ok === true, detail: JSON.stringify(j) };
  } catch (e) {
    return { up: false, detail: String((e && e.message) || e) };
  } finally {
    clearTimeout(t);
  }
}

function bootUrl(cfg) {
  const q = new URLSearchParams({
    nosw: "1",
    nullRender: "1",
    netDrainHz: "30",
    autoLogin: "1",
    account: cfg.account,
    password: cfg.password,
    autoSpawn: "first",
  });
  return `${BASE_URL}?${q}&v=${Date.now()}`;
}

// Readiness gate (rynth-review 14 B-1 / 15 C-3 / 17-SYNTHESIS #15, fixed
// 2026-07-23): this used to accept `__bootState === "ready"` and wait only
// for `__sessionHandle` PRESENCE — the exact pattern soak-11/12 forbade
// ("gate on in-world+pose, NEVER ready"). Under the mandatory headless
// `?nullRender` this supervisor always injects, `ready` (scene-bake-
// complete) can fire BEFORE `in-world` (EnteredWorld kind=7) — the old gate
// could hand installBot() a session that LOOKS live (handle attached early)
// but hasn't actually entered the world, and (per C-3) could also abandon a
// perfectly healthy but slow GPU boot the moment a transient `error` state
// latched, burning a BOOT_ATTEMPT + the 20s relogin backoff for nothing.
// Fixed the same way as rynth_boot_helper.cjs / harness/lib/boot.mjs: gate
// on in-world (now OR anywhere in __bootStateHistory, to catch a brief
// in-world->ready slip between polls) AND a real getLocalPlayerPose().
async function pollTrulyInWorld(page) {
  return page.evaluate(() => {
    const hist = Array.isArray(window.__bootStateHistory) ? window.__bootStateHistory : [];
    const reachedInWorld =
      window.__bootState === "in-world" || hist.some((e) => e && e.state === "in-world");
    let pose;
    try {
      const h = window.__sessionHandle;
      pose = h && typeof h.getLocalPlayerPose === "function" ? h.getLocalPlayerPose() : undefined;
      try { pose?.free?.(); } catch (_) {}
    } catch (_) {
      pose = undefined;
    }
    const hasPose = pose !== undefined && pose !== null;
    // Pose-first: a real pose after in-world is ready even under a latched
    // "error" (the scene watchdog's false latch); "error" without one fails.
    if (reachedInWorld && hasPose) return { ok: true, isError: false };
    return { ok: false, isError: window.__bootState === "error" };
  });
}

// Retire a page: stop its bot, end the ACE session cleanly (DISCONNECT), give
// the recv loop a moment to send it, then close. Never throws.
async function retirePage(page) {
  if (!page) return;
  try {
    await page.evaluate(() => {
      try { window.__bot?.stop?.(); } catch (_) {}
      try { window.__sessionHandle?.disconnect?.(); } catch (_) {}
      return true;
    });
    await sleep(DISCONNECT_FLUSH_MS);
  } catch (_) {
    /* page already gone */
  }
  await page.close().catch(() => null);
}

async function bootBot(browser, cfg, log) {
  for (let a = 1; a <= BOOT_ATTEMPTS; a++) {
    let page = null;
    try {
      page = await browser.newPage();
      await page.goto(bootUrl(cfg), { waitUntil: "domcontentloaded", timeout: 60_000 });
      let ok = false;
      for (let i = 0; i < 60; i++) {
        const r = await pollTrulyInWorld(page);
        if (r.ok) { ok = true; break; }
        if (r.isError) break;
        await sleep(2000);
      }
      if (ok) {
        await installBot(page, cfg);
        log(`${cfg.account}: booted + bot installed`);
        return page;
      }
      log(`${cfg.account}: boot attempt ${a} failed`);
    } catch (e) {
      log(`${cfg.account}: boot attempt ${a} threw ${String(e.message).slice(0, 80)}`);
    }
    if (page) await retirePage(page);
    await sleep(RELOGIN_BACKOFF_MS); // let ACE reap the stale session
  }
  return null;
}

// The bot config createGrindBot sees: the account entry minus credentials,
// AI director off unless the entry asks for it.
function botConfig(cfg) {
  const { account: _a, password: _p, ...rest } = cfg || {};
  return { buffs: [], ...rest, ai: rest.ai ?? false };
}

async function installBot(page, cfg) {
  await page.evaluate(async (botCfg) => {
    const m = await import("/apps/holtburger-web/rynth/bot.js");
    const bot = await m.createGrindBot(window.__sessionHandle, botCfg);
    window.__bot = bot;
    window.__rh = bot.host;
    window.__kn = bot.kernel;
  }, botConfig(cfg));
}

async function health(page) {
  try {
    return await page.evaluate(() => {
      const h = window.__rh;
      const live = window.__sessionHandle;
      // Reconnected in place: rebind the host (and so every loop) to the
      // live session instead of grinding on the freed one.
      let reattached = false;
      if (h && live && h.s !== live && typeof h.attach === "function") {
        try { h.attach(live); reattached = true; } catch (_) {}
      }
      const alive = !!live && !!h && !!h.snap;
      const snapAge = h && h.snap ? Date.now() - h.snap.tMs : Infinity;
      let linkAgeMs = null;
      try {
        const v = live && typeof live.sessionLastRecvAgeMs === "function" ? live.sessionLastRecvAgeMs() : null;
        linkAgeMs = typeof v === "number" && v < 0xffffffff ? v : null;
      } catch (_) {}
      const st = window.__kn ? window.__kn.status : null;
      return { alive, snapAge, linkAgeMs, reattached, status: st, boot: window.__bootState };
    });
  } catch (e) {
    return { alive: false, snapAge: Infinity, error: e.message };
  }
}

async function runFleet(configs, opts = {}) {
  const log = opts.log || ((m) => console.log(`[sup] ${new Date().toISOString()} ${m}`));
  const runMs = opts.runMs || 0; // 0 = forever
  // Opt-in sidecar watch: read at runFleet time (not module load) so callers
  // and tests can set the env/opt right before invoking.
  const sidecarUrl = String(opts.sidecarUrl || process.env.RYNTH_SIDECAR_URL || "").replace(/\/+$/, "");
  const sidecar = { up: null, downCycles: 0 }; // up:null = never checked yet
  if (sidecarUrl) log(`sidecar watch ON: ${sidecarUrl}/health (observe-only; boot script owns lifecycle)`);
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const bots = configs.map((cfg) => ({ cfg, page: null, rebuilds: 0 }));

  for (const b of bots) b.page = await bootBot(browser, b.cfg, log);

  const started = Date.now();
  const stats = {};
  while (runMs === 0 || Date.now() - started < runMs) {
    await sleep(HEALTH_INTERVAL_MS);
    if (sidecarUrl) {
      const s = await sidecarHealth(sidecarUrl);
      if (s.up) {
        if (sidecar.up !== true) log(`sidecar ${sidecarUrl}: HEALTHY ${s.detail}${sidecar.up === false ? " — RECOVERED" : ""}`);
        sidecar.downCycles = 0;
      } else {
        // Loud on the transition, then a reminder every ~30s while down.
        if (sidecar.up !== false || sidecar.downCycles % SIDECAR_DOWN_REMIND_CYCLES === 0) {
          log(`sidecar ${sidecarUrl}: *** DOWN *** (${s.detail}) — global routes will fail; restart via scripts/rynthnav-sidecar-boot.sh (supervisor never auto-spawns it)`);
        }
        sidecar.downCycles = sidecar.up === false ? sidecar.downCycles + 1 : 1;
      }
      sidecar.up = s.up;
    }
    for (const b of bots) {
      if (!b.page) { b.page = await bootBot(browser, b.cfg, log); continue; }
      const h = await health(b.page);
      stats[b.cfg.account] = h.status;
      if (h.reattached) log(`${b.cfg.account}: session replaced in-page — host re-attached`);
      // A latched __bootState "error" is NOT a death signal on its own (the
      // scene watchdog false-latches on a slow-but-fine boot); a dead
      // snapshot or a silent link is.
      const linkDead = typeof h.linkAgeMs === "number" && h.linkAgeMs > LINK_DEAD_MS;
      const dead = !h.alive || h.snapAge > SNAP_STALE_MS || linkDead;
      if (dead) {
        log(`${b.cfg.account}: UNHEALTHY (snapAge=${h.snapAge} linkAgeMs=${h.linkAgeMs ?? "?"} boot=${h.boot}) — rebuilding`);
        await retirePage(b.page);
        b.rebuilds++;
        b.page = await bootBot(browser, b.cfg, log);
      } else if (opts.verbose) {
        log(`${b.cfg.account}: ${JSON.stringify(h.status)}`);
      }
    }
  }
  const summary = bots.map((b) => ({ account: b.cfg.account, rebuilds: b.rebuilds, status: stats[b.cfg.account] }));
  if (!opts.keepOpen) {
    for (const b of bots) await retirePage(b.page);
    await browser.close();
  }
  return { browser, bots, summary };
}

module.exports = { runFleet, bootBot, installBot, health, sidecarHealth, pollTrulyInWorld, retirePage, botConfig };

if (require.main === module) {
  const configs = JSON.parse(process.argv[2] || "[]");
  if (!configs.length) {
    console.error('usage: node rynth_supervisor.cjs \'[{"account":"a","password":"a","buffs":[2,24]}]\'');
    process.exit(2);
  }
  runFleet(configs, { verbose: true }).catch((e) => {
    console.error("fleet error:", e);
    process.exit(1);
  });
}
