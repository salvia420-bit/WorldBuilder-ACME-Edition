import { chromium } from "playwright";
const b = await chromium.launch({ headless: true, args: ["--use-gl=swiftshader","--enable-unsafe-swiftshader","--no-sandbox","--disable-dev-shm-usage"] });
let p = null;
for (let attempt = 1; attempt <= 4; attempt++) {
  p = await b.newPage({ viewport: { width: 900, height: 700 } });
  const errs = [];
  p.on("console", (m) => { if (m.type()==="error" || (m.type()==="warning" && /PORTAL-LOOP/.test(m.text()))) errs.push(m.text().slice(0,180)); });
  p.errsRef = errs;
  p.on("pageerror", (e) => errs.push("PAGEERR " + String(e).slice(0, 200)));
  await p.goto("http://127.0.0.1:8766/apps/holtburger-web/index.html?renderer=3d&quality=low&agentic=low&hud=none&plugins=none&diag=1&nosw=1&targetFps=10&autoLogin=1&autoSpawn=first&server_host=127.0.0.1&server_port=9000&bridge_url=ws://127.0.0.1:8080/&account=tailnet1&password=tailnet1", { waitUntil: "domcontentloaded", timeout: 45000 });
  const t0 = Date.now(); let ok = false;
  while (Date.now() - t0 < 150000) {
    ok = await p.evaluate(() => !!window.liveScene3d?.entityManager && window.liveScene3d.entityManager.entityMap.size > 30).catch(() => false);
    if (ok) break; await p.waitForTimeout(2000);
  }
  if (ok) {
    const a = await p.evaluate(() => window.liveScene3d?.frameTime?.tsSec ?? -1).catch(()=>-1);
    await p.waitForTimeout(3000);
    const bb = await p.evaluate(() => window.liveScene3d?.frameTime?.tsSec ?? -1).catch(()=>-1);
    if (bb > a && a >= 0) { console.log("healthy boot attempt", attempt); break; }
    ok = false;
  }
  if (!ok) { console.log("boot attempt", attempt, "unhealthy"); await p.close(); p = null; }
}
if (!p) { await b.close(); process.exit(1); }
// sample the portal script managers + emitter census every 30s for 3 min
for (let i = 0; i < 6; i++) {
  await p.waitForTimeout(30000);
  const s = await p.evaluate(() => {
    const em = window.liveScene3d.entityManager;
    const out = [];
    for (const [g, inst] of em.entityMap) {
      if (!/portal/i.test(String(inst?.meta?.name??""))) continue;
      const m = em._scriptManagersForGuid.get(g >>> 0);
      let owned = 0;
      try {
        const pm = em._worldParticleManager;
        if (pm) for (const [, emr] of pm.particleTable) {
          for (let o = emr.parent || emr._parent || null; o; o = o.parent) if (o === inst.root) { owned++; break; }
        }
      } catch (_) {}
      out.push(`${inst.meta.name}: done=${m?.scriptsCompleted ?? "-"} fired=${m?.hooksFired ?? "-"} active=${m?.active ?? "-"} emitters=${owned}`);
    }
    return { portals: out, table: em._worldParticleManager?.particleTable?.size ?? null };
  });
  console.log(`t+${(i+1)*30}s table=${s.table}`);
  for (const line of s.portals) console.log("  " + line);
}
// walk to the TN portal and screenshot
const info = await p.evaluate(() => {
  const em = window.liveScene3d.entityManager;
  for (const [, inst] of em.entityMap) if (/portal to town network/i.test(String(inst?.meta?.name??""))) {
    const pos = inst.root.position; return { wx: pos.x, wy: pos.y, z: pos.z };
  }
  return null;
});
if (info) {
  const lbx = Math.floor(info.wx/192).toString(16).padStart(2,"0"), lby = Math.floor((info.wy-6)/192).toString(16).padStart(2,"0");
  const cmd = `@teleloc 0x${lbx}${lby}0019 ${(info.wx%192).toFixed(2)} ${((info.wy-6)%192).toFixed(2)} ${info.z.toFixed(2)} 1 0 0 0`;
  console.log("tele:", cmd);
  await p.evaluate((c) => window.__sessionHandle?.sendChat?.(c), cmd);
  await p.waitForTimeout(12000);
}
await p.screenshot({ path: "/tmp/claude-1000/-home-wbterminal/012e5a77-56c3-4b53-b928-ed735cb0ac43/scratchpad/portal-fixed.png" });
console.log("errors:", (p.errsRef ?? []).slice(0,10));
await b.close(); process.exit(0);
