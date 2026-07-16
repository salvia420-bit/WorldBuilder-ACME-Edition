const { chromium } = require("playwright");
const { bootInWorld, sleep } = require("./rynth_boot_helper.cjs");
const URL = "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first";
(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await bootInWorld(browser, URL);
  if (!page) { console.log("FAIL boot after retries"); await browser.close(); process.exit(1); }
  await sleep(3000);

  const castCheck = await page.evaluate(() => {
    const s = window.__sessionHandle;
    const before = s.getCastBusyState();
    s.noteLocalCastWindow(true);
    const during = s.getCastBusyState();
    s.noteLocalCastWindow(false);
    const after = s.getCastBusyState();
    return { before, during, after };
  });
  const castPass = castCheck.before === 0 && castCheck.during === 1 && castCheck.after === 0;
  console.log(`CAST GATE: ${JSON.stringify(castCheck)} -> ${castPass ? "PASS" : "FAIL"}`);

  // UseDone round-trip via a cast the server must refuse (unknown spell id 1
  // -> ACE ValidateSpell -> SendUseDoneEvent(error)). No entity needed.
  const trio = await page.evaluate(async () => {
    const s = window.__sessionHandle;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const baseline = { seq: s.getUseDoneSeq(), busy: s.getBusyState() };
    s.castUntargetedSpell(1);
    const afterSend = { seq: s.getUseDoneSeq(), busy: s.getBusyState() };
    let final = null;
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      final = { seq: s.getUseDoneSeq(), busy: s.getBusyState() };
      if (final.seq > baseline.seq) break;
    }
    const reset = (s.forceResetBusyCount(), s.getBusyState());
    return { baseline, afterSend, final, reset };
  });
  console.log("TRIO: " + JSON.stringify(trio));
  const pass =
    trio.afterSend.busy === trio.baseline.busy + 1 &&
    trio.final.seq === trio.baseline.seq + 1 &&
    trio.final.busy === trio.baseline.busy &&
    trio.reset === 0;
  console.log(`USEDONE ROUND-TRIP: ${pass ? "PASS" : "FAIL/PARTIAL"}`);
  await browser.close();
  process.exit(castPass && pass ? 0 : 1);
})().catch((e) => { console.error("ERR " + e.message); process.exit(1); });
