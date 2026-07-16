#!/usr/bin/env node
// rynth_netbrain_soak.cjs — LONG-RUN soak for netBrain DEFAULT-ON (mode "on":
// the C# brain drives combat target selection). Boots a bare-default page
// (no ?netBrain param), runs the full grind bot (combat + loot + buff +
// vitals) against live ACE, keeps mobs spawning, and watches for:
//   - shadow/adoption errors (must stay 0)
//   - lock oscillation (the mode-"on" tug-of-war class: A->B->A flip-backs
//     with both sides nonzero inside ~2 s)
//   - page/console errors, bot wedges (kills must keep accumulating)
//   - call cost drift over time
//
// Usage: node rynth_netbrain_soak.cjs [--minutes=30]
// Needs serve.py/wsbridge/ACE up + Playwright on NODE_PATH + built AppBundle.
const { chromium } = require("playwright");
const { bootInWorld, sleep } = require("./rynth_boot_helper.cjs");

const MINUTES = Number((process.argv.find((a) => a.startsWith("--minutes=")) || "").split("=")[1] || 30);
const URL =
  "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first";

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

(async () => {
  let browser;
  const consoleErrors = [];
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    const page = await bootInWorld(browser, URL);
    if (!page) { console.log("FAIL boot"); process.exit(1); }
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 160)}`));
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(`console: ${m.text().slice(0, 160)}`);
    });

    await page.evaluate(async () => {
      const { createGrindBot } = await import("/apps/holtburger-web/rynth/bot.js");
      window.__bot = await createGrindBot(window.__sessionHandle, {
        buffs: [2, 6], control: false, // loot + vitals stay default-on
      });
    });
    await page.evaluate(() => window.__bot.host.WriteToChat("@teleloc 0xA9B40019 84.0 15.0 94.05"));
    await sleep(6000);

    const t0 = Date.now();
    const endAt = t0 + MINUTES * 60_000;
    let spawns = 0, flipBacks = 0, lockChanges = 0;
    const lockTrail = [0, 0, 0];
    let lastSpawnCheck = 0, lastReport = 0;
    let snap = null;

    while (Date.now() < endAt) {
      await sleep(1000);
      // 1 Hz lock sampling for oscillation detection.
      const locked = await page.evaluate(() => window.__bot?.combat?.locked ?? -1).catch(() => -1);
      if (locked === -1) break; // page died — checked below
      lockTrail.push(locked >>> 0);
      lockTrail.shift();
      const [a, b, c] = lockTrail;
      if (c !== b) lockChanges++;
      if (a !== 0 && b !== 0 && a !== b && c === a) flipBacks++; // A->B->A inside 2 s

      // Mob keeper: every 45 s ensure >=2 live attackables (cap the total).
      if (Date.now() - lastSpawnCheck > 45_000) {
        lastSpawnCheck = Date.now();
        // Use the bot's OWN threat truth (same filter the kernel gates
        // combat on) — a raw creature count sees ambient critters combat
        // never engages and starves the spawner into a 30-min Idle soak.
        const alive = await page.evaluate(() => window.__bot.combat._scanTargets().length).catch(() => 0);
        if (alive < 2 && spawns < 60) {
          await page.evaluate(() => window.__bot.host.WriteToChat("@create 7")).catch(() => {});
          spawns++;
        }
      }

      // Minute report.
      if (Date.now() - lastReport > 60_000) {
        lastReport = Date.now();
        snap = await page.evaluate(() => {
          const n = window.__diag.netbrain;
          const st = window.__bot.status();
          return {
            mode: n.mode, loaded: !!n.loaded, loadError: n.loadError,
            calls: { ...n.calls }, agrees: { ...n.agrees },
            diverges: { ...n.diverges }, errors: { ...n.errors },
            steady: n.steadyMs("combat"), truncated: n.truncated,
            kills: st.kills, looted: st.looted, action: st.action,
          };
        }).catch(() => null);
        const min = Math.round((Date.now() - t0) / 60_000);
        console.log(
          `[${min}m] ${JSON.stringify(snap)} spawns=${spawns} lockChanges=${lockChanges} flipBacks=${flipBacks} consoleErr=${consoleErrors.length}`
        );
      }
    }

    // ── verdict ──
    const minutes = (Date.now() - t0) / 60_000;
    check("ran full window", minutes >= MINUTES - 0.5, `${minutes.toFixed(1)}m of ${MINUTES}m`);
    check("bundle loaded, mode on", !!snap?.loaded && snap.mode === "on",
      snap ? `mode=${snap.mode} loadError=${snap.loadError}` : "no snapshot");
    check("combat shadow active", (snap?.calls.combat ?? 0) >= 50, `calls=${snap?.calls.combat}`);
    check("zero netbrain errors",
      snap && snap.errors.combat + snap.errors.buff + snap.errors.loot === 0,
      JSON.stringify(snap?.errors));
    check("bot kept killing", (snap?.kills ?? 0) >= 3, `kills=${snap?.kills}`);
    check("no lock oscillation", flipBacks <= Math.max(3, lockChanges * 0.05),
      `flipBacks=${flipBacks} of ${lockChanges} changes`);
    check("steady cost sane", snap?.steady > 0 && snap.steady < 30, `${snap?.steady?.toFixed(2)} ms/call`);
    check("no page errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
    console.log(
      `SOAK SUMMARY: ${minutes.toFixed(1)}m, kills=${snap?.kills} looted=${snap?.looted} spawns=${spawns}, ` +
      `combat ${snap?.agrees.combat}/${snap?.calls.combat} agree ${snap?.diverges.combat} div, ` +
      `buff ${snap?.agrees.buff}/${snap?.calls.buff}, loot ${snap?.agrees.loot}/${snap?.calls.loot}, ` +
      `${snap?.steady?.toFixed(2)} ms/call, truncated=${snap?.truncated}, flipBacks=${flipBacks}/${lockChanges}`
    );

    await page.evaluate(() => window.__bot?.stop()).catch(() => null);
    await sleep(1000);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    if (browser) await browser.close().catch(() => null);
  }
  console.log(`${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
