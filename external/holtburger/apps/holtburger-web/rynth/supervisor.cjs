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
// Bot page contract (installed via evaluate): window.__rh (RynthWebHost),
// window.__kn (BotKernel). Health = __rh.snap freshness + __sessionHandle
// liveness; a stalled snapshot or a dropped session triggers a rebuild.

const { chromium } = require("playwright");

const BASE_URL =
  process.env.RYNTH_URL ||
  "http://127.0.0.1:8765/apps/holtburger-web/index.html";
const HEALTH_INTERVAL_MS = 5000;
const SNAP_STALE_MS = 8000; // snapshot older than this = the tick died
const RELOGIN_BACKOFF_MS = 20_000; // ACE session reap window
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

async function bootBot(browser, cfg, log) {
  for (let a = 1; a <= BOOT_ATTEMPTS; a++) {
    let page = null;
    try {
      page = await browser.newPage();
      await page.goto(bootUrl(cfg), { waitUntil: "domcontentloaded", timeout: 60_000 });
      let ok = false;
      for (let i = 0; i < 60; i++) {
        const st = await page.evaluate(() => window.__bootState || "");
        if (st === "in-world" || st === "ready") { ok = true; break; }
        if (st === "error") break;
        await sleep(2000);
      }
      if (ok) {
        await page.waitForFunction(() => !!window.__sessionHandle, { timeout: 90_000 });
        await installBot(page, cfg);
        log(`${cfg.account}: booted + bot installed`);
        return page;
      }
      log(`${cfg.account}: boot attempt ${a} failed`);
    } catch (e) {
      log(`${cfg.account}: boot attempt ${a} threw ${String(e.message).slice(0, 80)}`);
    }
    if (page) await page.close().catch(() => null);
    await sleep(RELOGIN_BACKOFF_MS); // let ACE reap the stale session
  }
  return null;
}

async function installBot(page, cfg) {
  await page.evaluate(async (buffIds) => {
    const wh = await import("/apps/holtburger-web/rynth/webhost.js");
    const cl = await import("/apps/holtburger-web/rynth/combat_loop.js");
    const bl = await import("/apps/holtburger-web/rynth/buff_loop.js");
    const ll = await import("/apps/holtburger-web/rynth/loot_loop.js");
    const kn = await import("/apps/holtburger-web/rynth/kernel.js");
    const host = new wh.RynthWebHost(window.__sessionHandle);
    host.nearbyRangeM = 60;
    const known = Array.from(window.__sessionHandle.playerKnownSpells() || []).map(Number);
    const buffs = (buffIds || []).filter((id) => known.includes(id));
    window.__rh = host;
    window.__kn = new kn.RynthBotKernel(host, {
      combat: new cl.RynthCombatLoop(host),
      buff: buffs.length ? new bl.RynthBuffLoop(host, buffs) : null,
      loot: new ll.RynthLootLoop(host),
    });
    host.start(10);
    window.__kn.start();
  }, cfg.buffs || []);
}

async function health(page) {
  try {
    return await page.evaluate(() => {
      const h = window.__rh;
      const alive = !!window.__sessionHandle && !!h && !!h.snap;
      const snapAge = h && h.snap ? Date.now() - h.snap.tMs : Infinity;
      const st = window.__kn ? window.__kn.status : null;
      return { alive, snapAge, status: st, boot: window.__bootState };
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
      const dead = !h.alive || h.snapAge > SNAP_STALE_MS || h.boot === "error";
      if (dead) {
        log(`${b.cfg.account}: UNHEALTHY (snapAge=${h.snapAge} boot=${h.boot}) — rebuilding`);
        await b.page.close().catch(() => null);
        b.rebuilds++;
        b.page = await bootBot(browser, b.cfg, log);
      } else if (opts.verbose) {
        log(`${b.cfg.account}: ${JSON.stringify(h.status)}`);
      }
    }
  }
  const summary = bots.map((b) => ({ account: b.cfg.account, rebuilds: b.rebuilds, status: stats[b.cfg.account] }));
  if (!opts.keepOpen) await browser.close();
  return { browser, bots, summary };
}

module.exports = { runFleet, bootBot, installBot, health, sidecarHealth };

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
