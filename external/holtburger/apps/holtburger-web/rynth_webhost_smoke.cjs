const { chromium } = require("playwright");
const { bootInWorld, sleep } = require("./rynth_boot_helper.cjs");
const URL = "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first";
(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage();
  const st = await bootInWorld(page, URL);
  if (!st) { console.log("FAIL boot"); await browser.close(); process.exit(1); }
  await page.waitForFunction(() => !!window.__sessionHandle, { timeout: 30_000 });
  await sleep(3000);

  const result = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const mod = await import("/apps/holtburger-web/rynth/webhost.js");
    const host = new mod.RynthWebHost(window.__sessionHandle, { entityMap: window.entityMap });
    window.__rynthHost = host;
    const caps = host.capabilities;
    host.start(10);
    await sleep(2500);
    const snapA = host.snap;
    const poseA = host.TryGetPlayerPose();
    // Drive via the RynthCoreHost-named seam only.
    host.MoveToPosition(poseA.objCellId, poseA.x, Math.min(191, poseA.y + 8), poseA.z, true);
    let latch = 0;
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      latch = host.GetPursuitStatus().last;
      if (latch >= 2) break;
    }
    const poseB = host.TryGetPlayerPose();
    const snapB = host.snap;
    host.stop();
    return {
      capCount: caps.length,
      missing: Object.keys(mod.RynthWebHost ? {} : {}),
      capsSample: caps.slice(0, 6),
      seqA: snapA.seq, seqB: snapB.seq,
      ticksFresh: snapB.tMs - snapA.tMs > 0,
      playerGuid: host.GetPlayerId(),
      isReady: host.IsPlayerReady(),
      serverTime: Math.round(host.GetServerTime()),
      selfName: host.TryGetObjectName(host.GetPlayerId()),
      ownership: host.TryGetObjectOwnershipInfo(host.GetPlayerId()),
      moved: Math.hypot(poseB.x - poseA.x, poseB.y - poseA.y).toFixed(2),
      pursuitLast: latch,
      nearbyCount: snapB.nearby.length,
    };
  });
  console.log("WEBHOST: " + JSON.stringify(result, null, 1));
  const pass =
    result.capCount >= 35 &&
    result.seqB > result.seqA &&
    result.playerGuid > 0 &&
    result.isReady === true &&
    typeof result.selfName === "string" &&
    result.pursuitLast === 2 &&
    Number(result.moved) > 5;
  console.log(`WEBHOST SMOKE: ${pass ? "PASS" : "FAIL/PARTIAL"}`);
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error("ERR " + e.message); process.exit(1); });
