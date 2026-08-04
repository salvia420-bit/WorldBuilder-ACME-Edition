import { chromium } from "playwright";
const b = await chromium.launch({ headless: true, args: ["--use-gl=swiftshader","--enable-unsafe-swiftshader","--no-sandbox","--disable-dev-shm-usage"] });
let p = null;
for (let attempt = 1; attempt <= 4; attempt++) {
  p = await b.newPage({ viewport: { width: 800, height: 600 } });
  const errs = [];
  p.on("console", (m) => { if (m.type()==="error") errs.push(m.text().slice(0,160)); });
  p.errsRef = errs;
  p.on("pageerror", (e) => errs.push("PAGEERR " + String(e).slice(0, 200)));
  await p.goto("http://127.0.0.1:8766/apps/holtburger-web/index.html?renderer=3d&quality=low&agentic=low&hud=none&plugins=none&diag=1&nosw=1&targetFps=10&autoLogin=1&autoSpawn=first&server_host=127.0.0.1&server_port=9000&bridge_url=ws://127.0.0.1:8080/&account=tailnet1&password=tailnet1", { waitUntil: "domcontentloaded", timeout: 45000 });
  const t0 = Date.now(); let ok = false;
  while (Date.now() - t0 < 150000) {
    ok = await p.evaluate(() => !!window.liveScene3d?.entityManager && window.liveScene3d.entityManager.entityMap.size > 10).catch(() => false);
    if (ok) break; await p.waitForTimeout(2000);
  }
  if (ok) {
    const a = await p.evaluate(() => window.liveScene3d?.frameTime?.tsSec ?? -1).catch(()=>-1);
    await p.waitForTimeout(3000);
    const bb = await p.evaluate(() => window.liveScene3d?.frameTime?.tsSec ?? -1).catch(()=>-1);
    if (bb > a && a >= 0) { console.log("healthy boot attempt", attempt); break; }
    ok = false;
  }
  if (!ok) { await p.close(); p = null; }
}
if (!p) { await b.close(); process.exit(1); }
const snap = async (label) => {
  await p.waitForTimeout(9000);
  const s = await p.evaluate(() => {
    const ls = window.liveScene3d, sd = ls.skyDome, sh = window.__sessionHandle;
    return {
      cell: (sh?.getCurrentCellId?.() >>> 0)?.toString(16),
      indoor: sh?.isCurrentCellIndoor?.(), seenOut: sh?.isCurrentCellSeenOutside?.(),
      lastIsIndoor: sd?._lastIsIndoor, skyBlocked: sd?._lastSkyBlocked,
      skyPassEnabled: ls?._atmo?.skyRenderPass?.enabled ?? ls?.atmosphere?.skyRenderPass?.enabled ?? "n/a",
      skyRendered: sd?.wasSkyRenderedLastFrame?.(),
    };
  });
  console.log(label, JSON.stringify(s));
};
await snap("OUTDOOR(spawn):");
// cottage interior: Holtburg meeting hall interior cell — use @teleloc into a known interior.
// Easier: telepoi to a dungeon for the dungeon case, and use a cottage interior cell for seen-outside.
await p.evaluate(() => window.__sessionHandle?.sendChat?.("@teleloc 0xA9B4011A 82.7 33.9 74.1 1 0 0 0")); // Holtburg interior guess
await snap("INTERIOR-GUESS:");
await p.screenshot({ path: "/tmp/claude-1000/-home-wbterminal/012e5a77-56c3-4b53-b928-ed735cb0ac43/scratchpad/sky-interior.png" });
await p.evaluate(() => window.__sessionHandle?.sendChat?.("@teledungeon 0007"));
await snap("DUNGEON:");
console.log("errors:", (p.errsRef ?? []).slice(0,8));
await b.close(); process.exit(0);
