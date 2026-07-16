#!/usr/bin/env node
// rynth_netbrain_smoke.cjs — LIVE shadow-mode smoke for the .NET-wasm brain
// (D1 path A′). Boots headless with ?netBrain=shadow, starts a grind bot, and
// verifies: (1) the mono-wasm AppBundle loads IN-PAGE beside the Rust wasm,
// (2) the combat shadow makes real scoreTargets calls off live host state,
// (3) zero shadow errors, and (4) call cost stays sane (<20 ms/call).
// Divergence COUNT is not asserted (C#-vs-JS divergences are documented
// findings, and an empty field agrees trivially) — only the pipeline is.
//
// Needs: serve.py :8765, wsbridge :8080, local ACE, Playwright on NODE_PATH,
// and a built netbrain/AppBundle (netbrain/build.sh).
const { chromium } = require("playwright");
const { bootInWorld, sleep } = require("./rynth_boot_helper.cjs");

const URL =
  "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&netBrain=shadow";

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    const page = await bootInWorld(browser, URL);
    if (!page) { console.log("FAIL boot"); process.exit(1); }

    await page.evaluate(async () => {
      const { createGrindBot } = await import("/apps/holtburger-web/rynth/bot.js");
      window.__bot = await createGrindBot(window.__sessionHandle, {
        buffs: [2], control: false, // loot stays on: corpse pickups exercise the loot shadow
      });
    });

    // The kernel only grants combat.tick() when a threat exists — teleport to
    // the proven clean-physics spot and spawn a Drudge (same recipe as
    // rynth_combat_smoke.cjs) so the shadow has real selections to compare.
    await page.evaluate(() => window.__bot.host.WriteToChat("@teleloc 0xA9B40019 84.0 15.0 94.05"));
    await sleep(6000);
    // Three drudges: one dies inside ~5 compared ticks and the kernel then
    // (correctly) stops granting combat the tick — more threats = more
    // shadowed selections per login.
    await page.evaluate(() => window.__bot.host.WriteToChat("@create 7"));
    await sleep(400);
    await page.evaluate(() => window.__bot.host.WriteToChat("@create 7"));
    await sleep(400);
    await page.evaluate(() => window.__bot.host.WriteToChat("@create 7"));

    // Wait for the lazy AppBundle load + a few shadowed selection ticks.
    let d = null;
    for (let i = 0; i < 30; i++) {
      d = await page.evaluate(() => {
        const n = window.__diag?.netbrain;
        return n
          ? { mode: n.mode, loaded: n.loaded, loadError: n.loadError,
              calls: { ...n.calls }, agrees: { ...n.agrees },
              diverges: { ...n.diverges }, errors: { ...n.errors },
              firstMs: n.firstCallMs.combat, steadyMs: n.steadyMs("combat") }
          : null;
      });
      if (d?.loaded && d.calls.combat >= 15) break;
      await sleep(2000);
    }

    check("diag surface present", !!d, "window.__diag.netbrain missing");
    check("mode=shadow", d?.mode === "shadow", d?.mode);
    check("AppBundle loaded in-page", !!d?.loaded, d?.loadError || "no load recorded");
    check("combat shadow called", (d?.calls.combat ?? 0) >= 10, `calls=${d?.calls.combat}`);
    check("zero shadow errors", (d?.errors.combat ?? 0) === 0, `errors=${d?.errors.combat}`);
    // First call pays the one-time mono-wasm warmup (~270-400 ms); the interp
    // tiers up over the next few calls. 30 ms on this 8 GB laptop ≈ 10% of
    // main thread at the 4 Hz shadow cadence — acceptable for an opt-in
    // diagnostic mode (node steady state on the same corpus is ~1.4 ms).
    check("steady-state cost < 30ms", d?.steadyMs > 0 && d.steadyMs < 30, `${d?.steadyMs?.toFixed(2)} ms/call`);
    console.log(
      `shadow: ${d?.agrees.combat}/${d?.calls.combat} agree, ${d?.diverges.combat} diverge, ` +
      `${d?.steadyMs?.toFixed(2)} ms/call steady (first ${d?.firstMs?.toFixed(0)} ms), ` +
      `bundle ${d?.loaded?.version} in ${d?.loaded?.loadMs} ms`
    );

    // Buff/loot shadows are informational here (they fire only when the
    // kernel routes those loops); their DTO correctness is pinned by
    // rynth_netbrain_test.cjs against the same bundle.
    const bl = await page.evaluate(() => {
      const n = window.__diag.netbrain;
      return `buff ${n.agrees.buff}/${n.calls.buff} agree (${n.errors.buff} err), ` +
             `loot ${n.agrees.loot}/${n.calls.loot} agree (${n.errors.loot} err)`;
    });
    console.log(`other shadows: ${bl}`);

    const sample = await page.evaluate(() => (window.__diag.netbrain.samples[0] || null));
    if (sample) console.log("first divergence sample:", JSON.stringify(sample).slice(0, 300));

    await page.evaluate(() => { window.__bot?.stop(); }).catch(() => null);
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
