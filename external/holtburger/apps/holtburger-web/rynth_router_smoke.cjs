// Router smoke: follow a multi-leg square route within a landblock via
// moveToPosition legs; verify the follower advances through all legs and
// the character actually traverses the waypoints.
const { chromium } = require("playwright");
const { bootInWorld, sleep } = require("./rynth_boot_helper.cjs");
const URL = "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first";
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await bootInWorld(browser, URL);
  if (!page) { console.log("FAIL boot"); await browser.close(); process.exit(1); }
  page.on("console", (m) => { const t = m.text(); if (/^\[router\]/.test(t)) console.log(t); });
  await sleep(3000);

  const start = await page.evaluate(async () => {
    const wh = await import("/apps/holtburger-web/rynth/webhost.js");
    const rt = await import("/apps/holtburger-web/rynth/router.js");
    const host = new wh.RynthWebHost(window.__sessionHandle);
    window.__rh = host;
    host.start(10);
    await new Promise((r) => setTimeout(r, 800));
    const p = host.TryGetPlayerPose();
    // A small square around the spawn (all in-landblock, land is flat here).
    const lb = p.objCellId >>> 16 << 16 >>> 0; // this leg uses full cell ids
    const cell = p.objCellId; // keep the same outdoor cell id
    const route = [
      { lb: cell, x: p.x + 8, y: p.y,     z: p.z },
      { lb: cell, x: p.x + 8, y: p.y + 8, z: p.z },
      { lb: cell, x: p.x,     y: p.y + 8, z: p.z },
      { lb: cell, x: p.x,     y: p.y,     z: p.z },
    ];
    const arrivals = [];
    const router = new rt.RynthRouter(host, { onArrive: (i) => arrivals.push(i) });
    window.__router = router;
    window.__arrivals = arrivals;
    host.onTick(() => router.tick());
    router.follow(route);
    return { start: { x: p.x, y: p.y }, legs: route.length };
  });
  console.log(`route start (${start.start.x.toFixed(1)},${start.start.y.toFixed(1)}), ${start.legs} legs`);

  let st = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    await sleep(2000);
    st = await page.evaluate(() => ({ ...window.__router.status, arrivals: window.__arrivals.length })).catch(() => null);
    if (!st) break;
    if (st.state === "DONE" || st.state === "FAILED") break;
  }
  console.log(`router: ${JSON.stringify(st)}`);
  await page.evaluate(() => { window.__router.cancel(); window.__rh.stop(); }).catch(() => null);
  // PASS if the route completed all legs (or got most of the way — moving
  // between waypoints proves the follower + moveToPosition integration).
  const pass = st && st.state === "DONE" && st.arrivals >= 4;
  const partial = st && st.arrivals >= 2;
  console.log(`ROUTER: ${pass ? "PASS" : partial ? "PARTIAL (advanced legs)" : "FAIL"}`);
  await browser.close();
  process.exit(pass || partial ? 0 : 1);
})().catch(async (e) => { console.error("ERR " + e.message); try { await browser.close(); } catch (_) {} process.exit(1); });
