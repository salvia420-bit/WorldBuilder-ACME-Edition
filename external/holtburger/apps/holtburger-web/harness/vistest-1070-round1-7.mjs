// vistest-1070-round1-7.mjs — the eye-test queue accumulated by the 2026-08-03
// review rounds, driven on the fleet's only real GPU.
//
// PRECONDITIONS (see ~/.claude/.../memory/fleet-runbooks.md §1070 — read it):
//   1. Chrome must already be running on the box in the INTERACTIVE session
//      (MODE2i). SSH-launched Chrome gives NO GL CONTEXT — the 3D renders
//      black and the run is worthless. Launch with:
//        ssh box "schtasks /create /tn VT /tr C:\\Temp\\launch-wls.bat /sc once /st 00:00 /it /f & schtasks /run /tn VT"
//      launch-wls.bat MUST carry, non-negotiably:
//        --mute-audio                      (no sound may reach the 1070's user)
//        --window-position=-32000,-32000   (off-screen; a person is at that desk)
//        --user-data-dir=C:\Temp\cdpwb-wls (the ONLY safe cleanup handle)
//        --remote-debugging-port=9333 --use-angle=d3d11 --ignore-gpu-blocklist
//   2. Tunnel (no `timeout` wrapper — it breaks -f). -R 8080 is the ws↔UDP
//      bridge (holtburger-wsbridge) — WITHOUT it every login dies with
//      "WsTransport ws handshake failed" and __bootState='error' (2026-08-05):
//        ssh -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 -R 8080:127.0.0.1:8080 young@100.127.215.75
//   3. serve.py on the laptop at :8765, ACE on :9000.
//
// This script NEVER closes the browser and NEVER touches a page it did not
// open — the person's own Chrome shares that machine.
//
// Usage: node harness/vistest-1070-round1-7.mjs [--out DIR]

import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i > 0 ? process.argv[i + 1] : "vistest-out";
})();
mkdirSync(OUT, { recursive: true });

const BASE = "http://127.0.0.1:8765/apps/holtburger-web/index.html";
// ?nosw=1 is MANDATORY — the service worker caches index.html across reloads
// AND browser restarts, so without it the run measures pre-fix JS.
const LOGIN =
  "renderer=3d&nosw=1&autoLogin=1&account=phase4demo&password=phase4demo" +
  "&autoSpawn=first&server_host=127.0.0.1&server_port=9000";

/** The queue. `flags` append to LOGIN; `checks` run in-page after boot. */
const ARMS = [
  { id: "A-default-high", flags: "quality=high",
    why: "R4#1 birds overhead · R3#1/#3 CSM look-around + shimmer · R1#1 recolor fade · R1#17 banner loop · R2#4 BC7 luminous · R7 tarnish variation + gemSparkle anchor · combatFx splatter" },
  { id: "B-warmpark-off", flags: "quality=high&warmPark=off",
    why: "R3#12 duplicate terrain mesh on evict-during-bake · R2#3 buildings return after evict" },
  { id: "C-clouds-dpr", flags: "quality=high&clouds=on&renderScale=0.75",
    why: "R4#3 canvas must not resize on first cloud frame · R4#7 press C to top-down (fxPass ortho depth)" },
  { id: "D-combatfx-off", flags: "quality=high&combatFx=off",
    why: "R2#8 A/B against arm A" },
  { id: "E-statpom", flags: "quality=high&statPom=on",
    why: "R2#1 POM relief still marches after the height-texture WeakMap move" },
  // 2026-08-04 — terrainBc7 flipped DEFAULT-ON (t512) with the 1070 look-pass
  // QUEUED, not waived. Arm F is the new bare default (retail-derived BC7
  // atlas); arm G pins the old CC0 arm for the side-by-side. Look for: derived
  // normal green-channel sign (lighting reads inverted on N-S slopes if
  // wrong), derived-height POM sliding vs texels, and the retail-vs-CC0 look
  // call. `__terrainBc7Stats()` in the probe must show built:"color+nra",
  // tier t512 in arm F and enabled:false in arm G.
  { id: "F-terrain-bc7-default", flags: "quality=high",
    why: "terrainBc7 default-ON 08-04: green-channel sign · POM height slide · retail look (A/B vs G)" },
  { id: "G-terrain-cc0", flags: "quality=high&terrainBc7=off",
    why: "CC0 comparison arm for F (the pre-08-04 default look)" },
  { id: "H-terrain-bc7-1024", flags: "quality=high&terrainBc7=1024",
    why: "TERRAIN-BC7-REPORT: eye-test BOTH tiers — ESRGAN sharpening is not uniformly better; don't assume t1024 dominates t512" },
];

/** Read-only page probes. Anything that mutates game state stays out. */
const PROBE = `(() => {
  const out = {};
  try {
    const gl = document.querySelector("canvas")?.getContext("webgl2");
    const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
    out.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
  } catch (e) { out.renderer = "probe-threw:" + e.message; }
  out.bootState = window.__bootState ?? null;
  // R7#9 — batch must actually consolidate, not silently pass through.
  try { out.terrainBatch = window.__terrainBatch?.stats?.() ?? null; } catch (e) { out.terrainBatch = null; }
  // R7#10 — buckets must be reaped, not ratcheted.
  try { out.statBatchX = window.__statBatchXStats?.() ?? null; } catch (e) { out.statBatchX = null; }
  try { out.farTerrain = window.__farTerrainState?.() ?? null; } catch (e) { out.farTerrain = null; }
  // 08-04 arms F/G — BC7 terrain atlas state (enabled/tier/built/errors).
  try { out.terrainBc7 = window.__terrainBc7Stats?.() ?? null; } catch (e) { out.terrainBc7 = null; }
  // R4#1 — the anchor must be genuinely OVERHEAD, not 40 m sideways.
  try {
    const a = window.liveScene3d?.skyDome?._skyBirdAnchor;
    const cam = window.liveScene3d?.cameraSwitcher?.activeCamera;
    if (a && cam) {
      a.updateWorldMatrix(true, false);
      const ap = new (a.constructor.prototype.constructor === Object ? Object : Object)();
      const w = a.matrixWorld.elements;
      out.birdAnchorWorld = { x: w[12], y: w[13], z: w[14] };
      out.camWorld = { x: cam.position.x, y: cam.position.y, z: cam.position.z };
      out.birdAboveCamM = +(w[13] - cam.position.y).toFixed(2);
      out.birdHorizOffsetM = +Math.hypot(w[12] - cam.position.x, w[14] - cam.position.z).toFixed(2);
    }
  } catch (e) { out.birdErr = e.message; }
  // R7#1 — itemFx must produce a plan (it threw into a swallowing catch before).
  try { out.itemFxPlan = !!window.liveScene3d?.entityManager?._itemFxPlan; } catch (e) {}
  out.canvasCss = (() => { const c = document.querySelector("canvas"); return c ? { w: c.clientWidth, h: c.clientHeight, bw: c.width, bh: c.height } : null; })();
  return out;
})()`;

const run = async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const results = [];
  let page = null;
  try {
    for (const arm of ARMS) {
      page = await ctx.newPage();          // OUR page; the person's tabs are untouched
      const errors = [];
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
      page.on("pageerror", (e) => errors.push("PAGEERROR " + String(e).slice(0, 300)));
      await page.goto(`${BASE}?${LOGIN}&${arm.flags}`, { waitUntil: "domcontentloaded", timeout: 60000 });
      // ⚠ 'ready', NOT 'in-world' — the atmosphere/__set* helpers attach AFTER
      // 'in-world', so probing at 'in-world' reads undefined (the documented
      // 2026-06-27 timesink). R9 290/1070 atmosphere bake can take ~45 s.
      let boot = null;
      try {
        await page.waitForFunction(() => window.__bootState === "ready", null, { timeout: 180000 });
        boot = "ready";
      } catch (_) { boot = await page.evaluate(() => window.__bootState ?? "none"); }
      await page.waitForTimeout(8000);      // let streaming settle before probing
      const probe = await page.evaluate(PROBE);
      await page.screenshot({ path: `${OUT}/${arm.id}.png`, fullPage: false });
      results.push({ arm: arm.id, why: arm.why, boot, probe, errors: errors.slice(0, 12) });
      await page.close();                   // close OUR page only
      page = null;
      await new Promise((r) => setTimeout(r, 26000)); // single-login: >25 s gap
    }
  } finally {
    if (page) { try { await page.close(); } catch (_) {} }
    // NEVER browser.close() — that is the person's Chrome.
  }
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  const r0 = results[0]?.probe?.renderer ?? "(none)";
  console.log("UNMASKED_RENDERER:", r0);
  if (!/NVIDIA|GTX 1070/i.test(String(r0))) {
    console.log("!! NOT the real GPU — Chrome was probably launched from SSH.");
    console.log("!! Relaunch via schtasks in the INTERACTIVE session (MODE2i) and re-run.");
  }
  for (const r of results) {
    console.log(`\n== ${r.arm} boot=${r.boot} errors=${r.errors.length}`);
    console.log("   birds above cam:", r.probe?.birdAboveCamM, "m, horiz offset:", r.probe?.birdHorizOffsetM, "m");
    console.log("   terrainBatch:", JSON.stringify(r.probe?.terrainBatch)?.slice(0, 160));
    console.log("   statBatchX:", JSON.stringify(r.probe?.statBatchX)?.slice(0, 160));
    console.log("   canvas:", JSON.stringify(r.probe?.canvasCss));
    for (const e of r.errors) console.log("   ERR", e);
  }
};

run().catch((e) => { console.error("vistest failed:", e.message); process.exit(1); });
