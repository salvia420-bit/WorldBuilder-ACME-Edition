// Global-route smoke: end-to-end GlobalRouter.goto() against the RynthNav
// sidecar (:8767, apps/rynthnav-sidecar). Boot in world, @telepoi Holtburg,
// plan a route FROM NODE first (the plan's final leg becomes the goal, so we
// never hardcode unwalkable coords), then have the in-page GlobalRouter plan
// + walk to it and verify arrival in world-frame metres.
// NOTE: shares the ACE test account (tailnet1) — the orchestrator runs this
// serially; never in parallel with other smokes. The page fetches :8767
// cross-origin, which is exactly what the sidecar's CORS headers are for.
const { chromium } = require("playwright");
const { bootInWorld, sleep } = require("./rynth_boot_helper.cjs");
const URL = "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first";
const SIDECAR = "http://127.0.0.1:8767";
const BUDGET_MS = 300_000;

// Contract frame math (RynthNavPlugin.cs:128-130,295-296,585-586,707).
const worldXY = (lb, x, y) => [((lb >>> 24) & 0xff) * 192 + x, ((lb >>> 16) & 0xff) * 192 + y];
const degFromWorld = (w) => (w / 24 - 1019.5) / 10;

let browser;
(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await bootInWorld(browser, URL);
  if (!page) { console.log("FAIL boot"); await browser.close(); process.exit(1); }
  page.on("console", (m) => { const t = m.text(); if (/^\[(router|gnav)\]/.test(t)) console.log(t); });
  await sleep(3000);

  // Teleport to Holtburg and let the pose settle.
  await page.evaluate(() => window.__sessionHandle.sendChat("@telepoi Holtburg"));
  await sleep(8000);

  // Host up + pose read (world-frame source for the node-side plan).
  const pose = await page.evaluate(async () => {
    const wh = await import("/apps/holtburger-web/rynth/webhost.js");
    const host = new wh.RynthWebHost(window.__sessionHandle);
    window.__rh = host;
    host.start(10);
    await new Promise((r) => setTimeout(r, 800));
    return host.TryGetPlayerPose();
  });
  if (!pose) { console.log("FAIL: no pose after telepoi"); await browser.close(); process.exit(1); }
  console.log(`pose: lb=0x${(pose.objCellId >>> 16).toString(16)} (${pose.x.toFixed(1)},${pose.y.toFixed(1)},${pose.z.toFixed(1)})`);
  const lbX = (pose.objCellId >>> 24) & 0xff, lbY = (pose.objCellId >>> 16) & 0xff;
  if (Math.abs(lbX - 0xa9) > 2 || Math.abs(lbY - 0xb4) > 2) {
    console.log("FAIL: pose did not settle near Holtburg (expected ~0xA9B4)");
    await browser.close(); process.exit(1);
  }

  // Plan from node FIRST; the final leg of that plan is the goal (guaranteed
  // walkable — the navmesh itself chose it).
  const [pwx, pwy] = worldXY(pose.objCellId, pose.x, pose.y);
  const to = { ns: degFromWorld(pwy + 180), ew: degFromWorld(pwx + 180) }; // ~1.3 lbs diagonal
  let plan;
  try {
    const r = await fetch(`${SIDECAR}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: { lb: pose.objCellId >>> 0, x: pose.x, y: pose.y, z: pose.z }, to }),
    });
    plan = await r.json();
  } catch (e) {
    console.log(`FAIL: sidecar not reachable from node (${e.message}) — see apps/rynthnav-sidecar/README`);
    await browser.close(); process.exit(1);
  }
  if (!plan.ok || !Array.isArray(plan.legs) || !plan.legs.length) {
    console.log(`FAIL: node-side plan failed: ${plan.error || JSON.stringify(plan).slice(0, 200)}`);
    await browser.close(); process.exit(1);
  }
  const goal = plan.legs[plan.legs.length - 1];
  const [gwx, gwy] = worldXY(goal.lb >>> 0, goal.x, goal.y);
  console.log(`goal (final leg of ${plan.legs.length}-leg node plan): lb=0x${(goal.lb >>> 0).toString(16)} (${goal.x.toFixed(1)},${goal.y.toFixed(1)})`);

  // In-page: RynthRouter + GlobalRouter, goto toward the goal.
  await page.evaluate(async (goal) => {
    const rt = await import("/apps/holtburger-web/rynth/router.js");
    const gr = await import("/apps/holtburger-web/rynth/global_router.js");
    const host = window.__rh;
    const router = new rt.RynthRouter(host);
    window.__router = router;
    host.onTick(() => router.tick());
    const g = new gr.GlobalRouter(host);
    window.__gotoResult = null;
    g.goto(router, { lb: goal.lb >>> 0, x: goal.x, y: goal.y, z: goal.z })
      .then((r) => { window.__gotoResult = r; })
      .catch((e) => { window.__gotoResult = { ok: false, error: `threw: ${e.message}` }; });
  }, goal);

  // Progress loop: leg i/n + world-frame distance to goal every 5s.
  const t0 = Date.now();
  let result = null;
  let finalD = Infinity;
  while (Date.now() - t0 < BUDGET_MS) {
    await sleep(5000);
    const st = await page.evaluate(([gwx, gwy]) => {
      const p = window.__rh.TryGetPlayerPose();
      const d = p
        ? Math.hypot((((p.objCellId >>> 24) & 0xff) * 192 + p.x) - gwx, (((p.objCellId >>> 16) & 0xff) * 192 + p.y) - gwy)
        : NaN;
      return { r: window.__router.status, d, done: window.__gotoResult };
    }, [gwx, gwy]).catch(() => null);
    if (!st) { console.log("page died mid-route"); break; }
    console.log(`leg ${Math.min(st.r.leg + 1, st.r.legs)}/${st.r.legs} state=${st.r.state} dist-to-goal=${st.d.toFixed(1)}m`);
    if (st.done) { result = st.done; finalD = st.d; break; }
  }

  await page.evaluate(() => {
    try { window.__router && window.__router.cancel(); } catch (_) {}
    try { window.__rh && window.__rh.stop(); } catch (_) {}
  }).catch(() => null);

  if (result && result.ok !== true && /unreachable|TypeError|Failed to fetch/i.test(String(result.error))) {
    console.log("HINT: in-page fetch to :8767 failed — sidecar down, or its CORS headers are missing (the browser needs Access-Control-Allow-Origin on every response).");
  }
  const pass = !!(result && result.ok === true && finalD < 10);
  console.log(`goto result: ${JSON.stringify(result)} finalDist=${Number.isFinite(finalD) ? finalD.toFixed(1) : "?"}m`);
  console.log(`GLOBALROUTE: ${pass ? "PASS" : "FAIL"}`);
  await page.close().catch(() => null);
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(async (e) => { console.error("ERR " + e.message); try { await browser.close(); } catch (_) {} process.exit(1); });
