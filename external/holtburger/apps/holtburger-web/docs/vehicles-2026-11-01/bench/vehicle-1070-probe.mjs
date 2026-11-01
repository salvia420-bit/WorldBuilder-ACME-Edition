// vehicle-1070-probe.mjs — short live probe on the 1070 (MODE T, same launch path as vehicle-1070.mjs): what happens to
// the vehicle stand-in entity (exists? root.visible and its producers, mesh visibility, position vs predicted pose)
// across chase → cockpit → chase → guns. Stills at each beat.  node vehicle-1070-probe.mjs [--out DIR] [--keep]
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const BOX = "young@100.127.215.75", CDP = "http://127.0.0.1:9333";
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = opt("--out", "/mnt/wbterminal1/tmp/claude-scratch/vehicles/1070-probe-a");
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const log = (...m) => console.log(`[probe ${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ssh = (c) => execFileSync("ssh", ["-o", "BatchMode=yes", BOX, c], { encoding: "utf8", timeout: 60000 });
try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) {}
ssh(`echo hbb-vprobe-${Date.now()}> D:\\Temp\\hbbench\\profile.txt`);
ssh(`echo 1280,720> D:\\Temp\\hbbench\\winsize.txt`);
ssh('schtasks /create /tn hbprobe /tr "wscript.exe //B //Nologo D:\\Temp\\hbbench\\hidden-run.vbs D:\\Temp\\hbbench\\hbprobe-launch.bat" /sc once /st 00:00 /it /f >nul 2>nul & schtasks /run /tn hbprobe >nul');
let up = false;
for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`${CDP}/json/version`)).ok; } catch (_) {} if (!up) await sleep(1000); }
if (!up) { log("no CDP"); process.exit(1); }
const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
const pg = ctx.pages()[0];
const url = "http://127.0.0.1:8765/apps/holtburger-web/index.html?autoLogin=1&account=agentp10&password=agentp10&autoSpawn=first&nosw=1&portalSpace=off&camDebug=on&quality=high&csm=off&renderScale=1&adaptiveRes=off&objRadius=3&vehicles=on&targetFps=30" + (opt("--flags", "") ? "&" + opt("--flags", "") : "");
const consoleLines = [];
pg.on("console", (m) => { const t = m.text(); if (/spawn-trace|\[vehicles\]|phase7\.4b|spawn\(/.test(t) && consoleLines.length < 400) consoleLines.push(`${((Date.now() - t0) / 1000).toFixed(1)} ${t.slice(0, 400)}`); });
await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
for (let i = 0; i < 150; i++) { if (await pg.evaluate(() => !!window.__vehicles && (window.__bootStateHistory || []).some((s) => (s.state || s) === "ready")).catch(() => false)) break; await sleep(1000); }
log("in world");
// the 1070's display turns off after 10 min idle (owner, 2026-11-01): hold a screen wake lock for the run so a dark
// display never throttles the test tab; it ends when the page navigates away (about:blank at the end)
log("wake lock", await pg.evaluate(async () => { try { window.__benchWake = await navigator.wakeLock.request("screen"); return "held"; } catch (e) { return String(e); } }).catch((e) => String(e)));
const cdp = await ctx.newCDPSession(pg);
const still = async (name) => { const r = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 85 }); writeFileSync(join(OUT, `${name}.jpg`), Buffer.from(r.data, "base64")); };
const rows = [];
const sample = async (label) => {
  const r = await pg.evaluate(() => {
    const V = window.__vehicles, em = window.liveScene3d.entityManager;
    const v = V.vehicles().slice(-1)[0];
    if (!v) return { none: true };
    const inst = em.entityMap.get(v.guid);
    const st = V.status().pilot?.state;
    let meshes = 0, meshVis = 0, opac = [];
    inst?.root?.traverse?.((o) => { if (o.isMesh) { meshes++; if (o.visible) meshVis++; const m = Array.isArray(o.material) ? o.material[0] : o.material; if (m && opac.length < 3) opac.push([+(m.opacity ?? 1).toFixed(2), !!m.transparent, m.visible !== false]); } });
    const p = inst?.root?.position;
    let anc = 0; for (let o = inst?.root; o; o = o.parent) if (o.visible === false) anc++;
    return { guid: v.guid.toString(16), has: !!inst, rootVis: inst?.root?.visible ?? null, stateVis: inst?._stateVisible ?? null, cullHidden: inst?._renderCullHidden ?? null,
      filmHidden: inst?._filmHidden ?? null, hiddenAncestors: anc, meshes, meshVis, opac, inScene: !!inst?.root?.parent,
      pos: p ? [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)] : null, pred: st ? [+st.x.toFixed(1), +st.y.toFixed(1), +st.z.toFixed(1)] : null,
      scale: inst?.root ? +inst.root.scale.x.toFixed(2) : null, view: V.status().pilot?.view ?? null, mode: st?.mode ?? null,
      inFlight: !!em.spawnInFlight?.has?.(v.guid), lastError: em.lastError ?? null,
      me: (() => { const g = (window.getLocalPlayerGuid?.() ?? 0) >>> 0, m = em.entityMap.get(g); const q = m?.root?.position;
        return m ? { guid: g.toString(16), pos: q ? [+q.x.toFixed(2), +q.y.toFixed(2), +q.z.toFixed(2)] : null, vis: m.root.visible, film: m._filmHidden ?? null,
          cull: m._renderCullHidden ?? null, state: m._stateVisible ?? null, inScene: !!m.root.parent } : { guid: g.toString(16), missing: true, inFlight: !!em.spawnInFlight?.has?.(g) }; })(),
      seatOff: v.profile?.seats?.[0]?.offset ?? null };
  });
  rows.push({ t: +((Date.now() - t0) / 1000).toFixed(1), label, ...r });
  log(label, JSON.stringify(r));
};
await pg.evaluate((c) => window.__sessionHandle.sendChat(c), "@teleloc 0xA9B40019 84 7.1 94"); await sleep(12000);
await pg.evaluate((c) => window.__sessionHandle.sendChat(c), "@vehicle despawn all"); await sleep(1500);
await pg.evaluate(() => window.__vehicles.spawn()); await sleep(5000);
await sample("parked");
if (argv.includes("--halo2")) {
  // the parked balloon from below against the clouds, the free camera orbiting (motion = disocclusion); the fix toggled live
  for (let i = 0; i < 60; i++) { const ok = await pg.evaluate(() => { const v = window.__vehicles.vehicles().slice(-1)[0]; return !!(v && window.liveScene3d.entityManager.entityMap.get(v.guid)); }); if (ok) break; await sleep(500); }
  await pg.evaluate(() => {
    const v = window.__vehicles.vehicles().slice(-1)[0], p = window.liveScene3d.entityManager.entityMap.get(v.guid).root.position;
    const c = { x: p.x, y: p.y, z: p.z + 9 }; window.__haloOrbit = { on: true };
    const t0 = performance.now();
    const f = (now) => { if (!window.__haloOrbit.on) return; window.__cam.orbit(c.x, c.y, c.z, 15, ((now - t0) / 1000) * 20, -18); requestAnimationFrame(f); };
    requestAnimationFrame(f);
  });
  await sleep(3000);
  log("halo2", JSON.stringify(await pg.evaluate(() => ({ edge: window.__cloudEdgeResolve?.stats?.() ?? null, sky: window.__skyTimePin ?? null }))));
  for (let k = 0; k < 4; k++) {
    await pg.evaluate(() => window.__cloudEdgeResolve?.set?.(false)); await sleep(1200); await still(`halo2-${k}-off`);
    await pg.evaluate(() => window.__cloudEdgeResolve?.set?.(true)); await sleep(1200); await still(`halo2-${k}-on`);
  }
  await pg.evaluate(() => { window.__haloOrbit.on = false; window.__cam.release(); });
  await pg.goto("about:blank").catch(() => {}); await sleep(1500);
  try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) {}
  log("done", OUT); process.exit(0);
}
await pg.evaluate(() => window.__vehicles.board()); await sleep(3000);
await sample("boarded");
if (argv.includes("--halo")) {
  // the balloon against clouds: a climbing bank in chase view; ?cloudEdgeResolve toggled live (same frame conditions)
  await pg.evaluate(() => window.__vehicles.setSticks({ throttle: 1, pitch: 0.5, roll: 0.35 }, 120000));
  await sleep(14000);
  const info = await pg.evaluate(() => ({ edge: window.__cloudEdgeResolve?.stats?.() ?? null, sky: window.__skyTimePin ?? null }));
  log("halo setup", JSON.stringify(info));
  for (let k = 0; k < 3; k++) {
    await pg.evaluate(() => window.__cloudEdgeResolve?.set?.(false)); await sleep(1500); await still(`halo-${k}-off`);
    await pg.evaluate(() => window.__cloudEdgeResolve?.set?.(true)); await sleep(1500); await still(`halo-${k}-on`);
  }
  await pg.evaluate(() => { window.__vehicles.setSticks({ throttle: 0, land: true }, 60000); });
  await sleep(1000);
  await pg.goto("about:blank").catch(() => {}); await sleep(1500);
  try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) {}
  log("done", OUT); process.exit(0);
}
if (argv.includes("--bail")) {
  // climb, bail, and sample the local rig against the fall twin through the fall
  await pg.evaluate(() => window.__vehicles.setSticks({ throttle: 1, pitch: 1, roll: 0.2 }, 120000));
  for (let i = 0; i < 40; i++) { await sleep(1000); const r = await pg.evaluate(() => { const s = window.__vehicles.status(); const st = s.pilot?.state; return st ? st.z - (window.__sessionHandle.terrainHeightAt(st.x, st.y) ?? 0) : 0; }); if (r > 160) break; }
  await pg.evaluate(() => { window.__vehicles.clearSticks(); window.__vehicles.exit(1); });
  for (let i = 0; i < 14; i++) {
    await sleep(1000);
    const f = await pg.evaluate(() => {
      const V = window.__vehicles, em = window.liveScene3d.entityManager, g = (window.getLocalPlayerGuid?.() ?? 0) >>> 0, m = em.entityMap.get(g);
      const s = V.status(); const r = m?.root;
      let meshVis = 0, meshes = 0; r?.traverse?.((o) => { if (o.isMesh) { meshes++; if (o.visible) meshVis++; } });
      let anc = 0; for (let o = r; o; o = o.parent) if (o.visible === false) anc++;
      return { falling: V.falling, fall: s.fall ? [+s.fall.x.toFixed(1), +s.fall.y.toFixed(1), +s.fall.z.toFixed(1)] : null, chute: s.fall?.chute ?? null,
        rig: r ? [+r.position.x.toFixed(1), +r.position.y.toFixed(1), +r.position.z.toFixed(1)] : null, vis: r?.visible ?? null, film: m?._filmHidden ?? null,
        state: m?._stateVisible ?? null, cull: m?._renderCullHidden ?? null, hiddenAncestors: anc, meshes, meshVis,
        scale: r ? +r.scale.x.toFixed(2) : null, chutes: s.chutes, fade: window.liveScene3d.cameraSwitcher?._camFadeLastOpacity ?? null,
        matOpacity: (() => { let o = null; r?.traverse?.((x) => { if (o === null && x.isMesh) { const mm = Array.isArray(x.material) ? x.material[0] : x.material; o = mm ? [+(mm.opacity ?? 1).toFixed(2), !!mm.transparent] : null; } }); return o; })() };
    });
    rows.push({ t: +((Date.now() - t0) / 1000).toFixed(1), label: "fall", ...f });
    log("fall", JSON.stringify(f));
    if (i === 3) await still("e-fall");
    if (!f.falling && i > 2) break;
  }
  writeFileSync(join(OUT, "rows.json"), JSON.stringify(rows, null, 1));
  writeFileSync(join(OUT, "console.txt"), consoleLines.join("\n"));
  await pg.goto("about:blank").catch(() => {}); await sleep(1500);
  try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) {}
  log("done", OUT); process.exit(0);
}
await pg.evaluate(() => window.__vehicles.setSticks({ throttle: 1, pitch: -0.2 }, 60000));
for (let i = 0; i < 4; i++) { await sleep(3000); await sample("flying chase"); }
await still("a-chase-before");
await pg.evaluate(() => window.__vehicles.setView("cockpit"));
for (let i = 0; i < 3; i++) { await sleep(1000); await sample("cockpit"); }
await still("b-cockpit");
await pg.evaluate(() => window.__vehicles.setView("chase"));
for (let i = 0; i < 4; i++) { await sleep(1000); await sample("chase after cockpit"); }
await still("c-chase-after");
await pg.evaluate(() => window.__vehicles.setSticks({ throttle: 1, pitch: -0.2, fire: true }, 2000));
for (let i = 0; i < 3; i++) { await sleep(1000); await sample("firing"); }
await pg.evaluate(() => window.__vehicles.setSticks({ throttle: 1, pitch: -0.2 }, 60000));
for (let i = 0; i < 3; i++) { await sleep(1000); await sample("after firing"); }
await still("d-after-fire");
writeFileSync(join(OUT, "rows.json"), JSON.stringify(rows, null, 1));
writeFileSync(join(OUT, "console.txt"), consoleLines.join("\n"));
if (!argv.includes("--keep")) {
  await pg.evaluate(() => { window.__vehicles.setSticks({ throttle: 0, land: true }, 60000); });
  await sleep(1500);
  await pg.goto("about:blank").catch(() => {});
  await sleep(1500);
  try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) {}
}
log("done", OUT);
process.exit(0);
