// rynth-integration Phase 1 live smoke: boot holtburger-web headless against
// local ACE, verify the new SessionHandle getters, drive moveToPosition.
const { chromium } = require("playwright");

const URL =
  "http://127.0.0.1:8765/apps/holtburger-web/index.html" +
  "?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1" +
  "&account=tailnet1&password=tailnet1&autoSpawn=first";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (/error|fail|rynth|moveto|pursuit/i.test(t)) console.log(`[con] ${t.slice(0, 180)}`);
  });

  console.log(`goto ${URL}`);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // Boot gate: in-world (NOT 'ready' — render gate, may never fire headless).
  let state = "";
  for (let i = 0; i < 90; i++) {
    state = await page.evaluate(() => window.__bootState || "");
    if (state === "in-world" || state === "ready") break;
    if (i % 10 === 0) console.log(`  boot poll ${i}: ${state}`);
    await sleep(2000);
  }
  console.log(`bootState: ${state}`);
  if (state !== "in-world" && state !== "ready") {
    const hist = await page.evaluate(() => window.__bootStateHistory || []);
    console.log(`FAIL boot. history: ${JSON.stringify(hist)}`);
    await browser.close();
    process.exit(1);
  }

  // Session handle + a settled entity map.
  await page.waitForFunction(() => !!window.__sessionHandle, { timeout: 30_000 });
  await sleep(5000);

  const readout = await page.evaluate(() => {
    const s = window.__sessionHandle;
    const out = { getters: {}, entityProbe: null };
    out.getters.isPlayerReady = s.isPlayerReady();
    out.getters.playerGuid = s.playerGuid();
    out.getters.serverTime = s.serverTime();
    out.getters.combatMode = s.combatMode();
    out.getters.pursuitStatus = s.pursuitStatus ? s.pursuitStatus() : "(absent)";
    out.getters.selfName = s.objectName(out.getters.playerGuid);
    out.getters.selfPhysicsState = s.objectPhysicsState(out.getters.playerGuid);
    // Probe a non-self entity from entityMap.
    const em = window.entityMap;
    if (em && em.size) {
      for (const [guid] of em) {
        const g = Number(guid);
        if (g === out.getters.playerGuid) continue;
        const name = s.objectName(g);
        if (!name) continue;
        out.entityProbe = {
          guid: g,
          name,
          wcid: s.objectWcid(g),
          physicsState: s.objectPhysicsState(g),
          healthFraction: s.objectHealthFraction(g),
          intProp_ItemType: s.objectIntProperty(g, 1),
          didProp_Icon: s.objectDataIdProperty(g, 8),
        };
        break;
      }
      out.entityCount = em.size;
    }
    const pose = s.getLocalPlayerPose ? s.getLocalPlayerPose() : null;
    out.pose = pose
      ? { lb: pose.landblockId >>> 0, x: pose.x, y: pose.y, z: pose.z }
      : null;
    return out;
  });
  console.log("READOUT: " + JSON.stringify(readout, null, 1));

  const g = readout.getters;
  const pass1 =
    g.isPlayerReady === true &&
    g.playerGuid > 0 &&
    g.serverTime > 0 &&
    [1, 2, 4, 8].includes(g.combatMode) &&
    typeof g.selfName === "string" &&
    g.selfName.length > 0;
  console.log(`GETTERS: ${pass1 ? "PASS" : "FAIL"}`);

  // moveToPosition: +12m north (y+12), same landblock, run=true.
  if (!readout.pose) {
    console.log("MOVETO: SKIP (no pose)");
    await browser.close();
    process.exit(pass1 ? 0 : 1);
  }
  const tgt = {
    lb: readout.pose.lb,
    x: readout.pose.x,
    y: Math.min(191.0, readout.pose.y + 12.0),
    z: readout.pose.z,
  };
  console.log(`moveToPosition -> lb=0x${tgt.lb.toString(16)} x=${tgt.x.toFixed(1)} y=${tgt.y.toFixed(1)} z=${tgt.z.toFixed(1)}`);
  await page.evaluate((t) => {
    window.__sessionHandle.moveToPosition(t.lb, t.x, t.y, t.z, true);
  }, tgt);

  let statuses = [];
  let lastPose = readout.pose;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const snap = await page.evaluate(() => {
      const s = window.__sessionHandle;
      const p = s.getLocalPlayerPose ? s.getLocalPlayerPose() : null;
      return {
        st: s.pursuitStatus ? s.pursuitStatus() : -1,
        x: p ? p.x : null,
        y: p ? p.y : null,
      };
    });
    if (!statuses.length || statuses[statuses.length - 1] !== snap.st) statuses.push(snap.st);
    lastPose = { ...lastPose, x: snap.x, y: snap.y };
    if (snap.st === 2 || snap.st === 3) break;
  }
  const dy = lastPose.y - readout.pose.y;
  const dx = lastPose.x - readout.pose.x;
  const moved = Math.hypot(dx, dy);
  console.log(
    `MOVETO: statuses=${JSON.stringify(statuses)} moved=${moved.toFixed(2)}m ` +
      `(dx=${dx.toFixed(2)} dy=${dy.toFixed(2)})`
  );
  const pass2 = statuses.includes(2) && moved > 8.0;
  console.log(`MOVETO: ${pass2 ? "PASS" : statuses.includes(2) || moved > 8 ? "PARTIAL" : "FAIL"}`);

  await browser.close();
  process.exit(pass1 && pass2 ? 0 : 1);
})().catch((e) => {
  console.error(`SMOKE ERROR: ${e.message}`);
  process.exit(1);
});
