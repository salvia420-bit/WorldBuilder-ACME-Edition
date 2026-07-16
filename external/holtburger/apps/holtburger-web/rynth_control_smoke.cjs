const { chromium } = require("playwright");
const { bootInWorld, sleep } = require("./rynth_boot_helper.cjs");
const URL = "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first";
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await bootInWorld(browser, URL);
  if (!page) { console.log("FAIL boot"); await browser.close(); process.exit(1); }
  page.on("console", (m) => { const t = m.text(); if (/^\[ctl\]/.test(t)) console.log(t); });
  await sleep(3000);

  const out = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const wh = await import("/apps/holtburger-web/rynth/webhost.js");
    const cl = await import("/apps/holtburger-web/rynth/combat_loop.js");
    const kn = await import("/apps/holtburger-web/rynth/kernel.js");
    const ctl = await import("/apps/holtburger-web/rynth/control_channel.js");
    const host = new wh.RynthWebHost(window.__sessionHandle);
    host.nearbyRangeM = 60;
    const kernel = new kn.RynthBotKernel(host, { combat: new cl.RynthCombatLoop(host), buff: null, loot: null });
    const channel = new ctl.RynthControlChannel(host, kernel, { prefix: "!bot" });
    host.start(10);
    kernel.start();
    await sleep(500);

    const results = {};
    // Verify the real page tap is installed and drives our dispatcher:
    results.tapInstalled = typeof window.__rynthOnEvent === "function";

    // Inject a real ChatReceived event through the ACTUAL tap (same path
    // the client's pumpNetFrame uses to forward drained events).
    window.__rynthOnEvent({ kind: 2, stringPayload: 'Owner tells you, "!bot status"' });
    await sleep(300);
    window.__rynthOnEvent({ kind: 2, stringPayload: 'Owner tells you, "!bot pause"' });
    await sleep(500);
    results.pausedAfterPause = channel.paused;
    window.__rynthOnEvent({ kind: 2, stringPayload: 'Owner tells you, "!bot resume"' });
    await sleep(500);
    results.pausedAfterResume = channel.paused;
    // Non-owner-prefixed / non-tell lines must be ignored.
    window.__rynthOnEvent({ kind: 2, stringPayload: 'Someone says, "hello world"' });
    window.__rynthOnEvent({ kind: 2, stringPayload: 'Bob tells you, "not a command"' });
    await sleep(300);
    results.commandCount = channel.commands.length; // expect 3 (status/pause/resume)
    results.cmds = channel.commands.map((c) => c.cmd);

    kernel.stop(); host.stop();
    return results;
  });
  console.log("CONTROL: " + JSON.stringify(out));
  const pass = out.tapInstalled && out.pausedAfterPause === true && out.pausedAfterResume === false &&
               out.commandCount === 3 && JSON.stringify(out.cmds) === JSON.stringify(["status", "pause", "resume"]);
  console.log(`CONTROL CHANNEL: ${pass ? "PASS" : "FAIL"}`);
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(async (e) => { console.error("ERR " + e.message); try { await browser.close(); } catch (_) {} process.exit(1); });
