import { chromium } from "playwright";
const arm = process.argv[2] || "";
const b = await chromium.launch({ headless: true, args: ["--use-gl=swiftshader","--enable-unsafe-swiftshader","--no-sandbox","--disable-dev-shm-usage"] });
let p = null;
for (let attempt = 1; attempt <= 3; attempt++) {
  p = await b.newPage({ viewport: { width: 800, height: 600 } });
  p.on("pageerror", (e) => console.log("PAGEERR", String(e).slice(0, 150)));
  await p.goto("http://127.0.0.1:8766/apps/holtburger-web/index.html?renderer=3d&quality=low&agentic=low&hud=none&plugins=none&diag=1&nosw=1&targetFps=10&autoLogin=1&autoSpawn=first&server_host=127.0.0.1&server_port=9000&bridge_url=ws://127.0.0.1:8080/&account=tailnet1&password=tailnet1" + arm, { waitUntil: "domcontentloaded", timeout: 45000 });
  const t0 = Date.now(); let ok = false;
  while (Date.now() - t0 < 150000) {
    ok = await p.evaluate(() => !!window.liveScene3d?.entityManager).catch(() => false);
    if (ok) break; await p.waitForTimeout(2000);
  }
  if (ok) {
    const a = await p.evaluate(() => window.liveScene3d?.frameTime?.tsSec ?? -1).catch(()=>-1);
    await p.waitForTimeout(3000);
    const bb = await p.evaluate(() => window.liveScene3d?.frameTime?.tsSec ?? -1).catch(()=>-1);
    if (bb > a && a >= 0) break; ok = false;
  }
  if (!ok) { await p.close(); p = null; }
}
if (!p) { await b.close(); process.exit(1); }
await p.evaluate(() => window.__sessionHandle?.sendChat?.("@telepoi sawato"));
await p.waitForTimeout(45000); // stream the swamp
const r = await p.evaluate(async () => {
  const ls = window.liveScene3d;
  const r3 = ls.renderer;
  r3.info.autoReset = false; r3.info.reset();
  const t0 = performance.now();
  let longtasks = 0;
  const po = new PerformanceObserver((l) => { longtasks += l.getEntries().length; });
  po.observe({ entryTypes: ["longtask"] });
  await new Promise((res) => setTimeout(res, 15000));
  po.disconnect();
  const frames = ls.frameCount3d ?? null;
  // static particle manager census
  let statTable = 0, statMeshes = 0, instBuckets = 0;
  const spm = window.__staticParticleManager || ls.staticParticleManager || null;
  const em = ls.entityManager;
  const wpm = em?._worldParticleManager;
  let sceneMeshes = 0, sceneParticleMeshes = 0;
  ls.scene.traverse((o) => { if (o.isMesh) { sceneMeshes++; if (o.userData?.__particle || /particle/i.test(o.name||"")) sceneParticleMeshes++; } });
  return {
    calls: r3.info.render.calls, tris: r3.info.render.triangles, elapsedS: ((performance.now()-t0)/1000).toFixed(1),
    longtasks, worldTable: wpm?.particleTable?.size ?? null, worldInstBuckets: wpm?._instBuckets?.size ?? null,
    sceneMeshes, sceneParticleMeshes,
    geometries: r3.info.memory.geometries,
  };
});
console.log("ARM", arm || "(default)", JSON.stringify(r));
await b.close(); process.exit(0);
