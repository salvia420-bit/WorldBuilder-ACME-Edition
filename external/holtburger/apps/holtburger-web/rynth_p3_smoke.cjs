const { chromium } = require("playwright");
const { bootInWorld, sleep } = require("./rynth_boot_helper.cjs");
const URL = "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first";
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await bootInWorld(browser, URL);
  if (!page) { console.log("FAIL boot"); await browser.close(); process.exit(1); }
  await sleep(3000);
  const r = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const wh = await import("/apps/holtburger-web/rynth/webhost.js");
    const cl = await import("/apps/holtburger-web/rynth/combat_loop.js");
    const host = new wh.RynthWebHost(window.__sessionHandle, { noEventTap: true });
    const loop = new cl.RynthCombatLoop(host);
    loop.locked = 0x111;
    // Target due north (+Y) of the player; desired yaw = atan2(dx=0, dy=10) = 0.
    host.TryGetObjectPosition = () => ({ objCellId: 0, x: 0, y: 10, z: 0 });
    let turns = 0, lastTurn = null;
    host.TurnToHeading = (rad) => { turns++; lastTurn = rad; };
    // 1) Facing east (heading=pi/2), target north -> err ~90deg -> "turn".
    host.TryGetPlayerPose = () => ({ objCellId: 0, x: 0, y: 0, z: 0, heading: Math.PI / 2 });
    const g1 = loop._faceGate(0x111);
    // 2) Now facing north (heading=0) -> within tolerance but must SETTLE.
    host.TryGetPlayerPose = () => ({ objCellId: 0, x: 0, y: 0, z: 0, heading: 0 });
    const g2 = loop._faceGate(0x111);           // first in-window tick -> "turn" (settling)
    await sleep(160);
    const g3 = loop._faceGate(0x111);           // 160ms > 140ms settle -> "cast"
    // 3) Slightly off (10deg < 15deg tolerance) also settles -> cast after wait.
    host.TryGetPlayerPose = () => ({ objCellId: 0, x: 0, y: 0, z: 0, heading: (10 * Math.PI) / 180 });
    loop._faceInWindowSince = Date.now() - 200; // pretend already settled
    const g4 = loop._faceGate(0x111);
    return { g1, g2, g3, g4, turns, lastTurnRad: lastTurn };
  });
  console.log("P3: " + JSON.stringify(r));
  const pass = r.g1 === "turn" && r.turns >= 1 && Math.abs(r.lastTurnRad) < 1e-6 &&
               r.g2 === "turn" && r.g3 === "cast" && r.g4 === "cast";
  console.log(`P3 FACE-SETTLE: ${pass ? "PASS" : "FAIL"}`);
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(async (e) => { console.error("ERR " + e.message); try { await browser.close(); } catch (_) {} process.exit(1); });
