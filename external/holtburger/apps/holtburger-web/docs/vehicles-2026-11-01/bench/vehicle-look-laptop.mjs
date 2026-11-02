// vehicle-look-laptop.mjs — screenshots of the Hellcat built from AC parts in the real renderer, on the laptop
// (SwiftShader, ONE real-world tab; a heavy job: run it inside capped-build, nothing else heavy at the same time).
//   capped-build node vehicle-look-laptop.mjs --out /mnt/wbterminal1/tmp/claude-scratch/vehicles/look-a
// Logs in agentp10 at Holtburg with ?vehicles=on (noon sky), spawns a Hellcat, boards it and takes stills: parked from
// four sides (the chase camera orbited with __vehicles.setCameraTweak), the cockpit view, in flight (chase), firing the
// guns, the rails, and a client-drawn 2,000 lb explosion; then lands, exits and despawns.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HB = "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web";
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const OUT = opt("--out", "/mnt/wbterminal1/tmp/claude-scratch/vehicles/look");
mkdirSync(OUT, { recursive: true });
let cg = ""; try { cg = readFileSync("/proc/self/cgroup", "utf8"); } catch (_) { /* */ }
if (!/\/builds(\/|\n|$)/.test(cg)) { console.error("REFUSED: run inside capped-build"); process.exit(2); }
const { acquireHeavyLock } = await import(join(HB, "harness/lib/heavy_lock.mjs"));
const lock = await acquireHeavyLock({ label: "vehicle-look-laptop" });
const require = createRequire(import.meta.url);
const { chromium } = require(join(HB, "node_modules/playwright-core"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...m) => console.log(`[look ${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...m);
const url = "http://127.0.0.1:8765/apps/holtburger-web/index.html?autoLogin=1&account=agentp10&password=agentp10&autoSpawn=first&agent=1&nosw=1"
  + "&portalSpace=off&hud=none&adaptiveRes=off&skytime=12&vehicles=on&vehicleAudio=off"
  // SwiftShader: a light scene, or a frame takes longer than the screenshot timeout (look-a: 30 s timed out)
  + (argv.includes("--full") ? "&quality=high&renderScale=1" : "&quality=low&csm=off&renderScale=0.6&objRadius=1&pvsRingRadius=1&flightView=off&targetFps=10");
const res = { shots: [], errors: [], notes: [] };
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium", headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--mute-audio",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--js-flags=--max-old-space-size=2048"],
});
const hard = setTimeout(() => { res.errors.push("hard timeout"); browser.close().catch(() => {}); setTimeout(() => process.exit(1), 3000).unref(); }, 20 * 60000);
hard.unref();
try {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 576 } });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error" && res.errors.length < 80) res.errors.push(m.text().slice(0, 240)); if (/\[vehicles\]/.test(m.text())) log(m.text().slice(0, 160)); });
  page.on("pageerror", (e) => res.errors.push(`pageerror ${String(e?.message ?? e).slice(0, 240)}`));
  log("goto");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  for (let i = 0; i < 240; i++) {
    const ok = await page.evaluate(() => { let m = 0; try { window.liveScene3d?.scene?.traverse((o) => { if (o.isMesh) m++; }); } catch (_) {} return !!window.__vehicles && !!window.liveScene3d && m > 100; }).catch(() => false);
    if (ok) break;
    await sleep(2000);
  }
  await page.evaluate(() => { if (window.__bootState === "error") window.__bootState = "ready"; });
  log("in world");
  const chat = (m) => page.evaluate((x) => window.__sessionHandle.sendChat(x), m);
  await chat("@cloak on"); await sleep(1000);
  await chat("@teleloc 0xA9B40019 84 7.1 94"); await sleep(15000);
  await chat("@vehicle despawn all"); await sleep(1500);
  const sp = await page.evaluate(async () => {
    const V = window.__vehicles; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40 && V.status().caps.granted === null; i++) await sleep(500);
    V.spawn();
    for (let i = 0; i < 60; i++) { const v = V.status().vehicles.find((x) => x.mode === 0); if (v && v.airframe === "ready") return v; await sleep(500); }
    return V.status().vehicles;
  });
  res.notes.push({ spawn: sp });
  log("spawned", JSON.stringify(sp).slice(0, 200));
  const board = await page.evaluate(async () => { const V = window.__vehicles; const r = V.board(); for (let i = 0; i < 40 && !V.piloting; i++) await new Promise((x) => setTimeout(x, 250)); return { r, piloting: V.piloting }; });
  log("board", JSON.stringify(board));
  const shot = async (name, settleMs = 2500) => {
    await sleep(settleMs);
    const f = join(OUT, `${String(res.shots.length).padStart(2, "0")}-${name}.png`);
    await page.screenshot({ path: f, timeout: 150000 });
    res.shots.push(f);
    log("shot", f);
  };
  const tweak = (t) => page.evaluate((x) => window.__vehicles.setCameraTweak(x), t);
  // parked, four sides
  await tweak({ yaw: 0.6, back: 15, up: 4 }); await shot("parked-rear-quarter", 6000);
  await tweak({ yaw: Math.PI / 2, back: 14, up: 2.5 }); await shot("parked-side");
  await tweak({ yaw: Math.PI - 0.5, back: 15, up: 3 }); await shot("parked-front-quarter");
  await tweak({ yaw: Math.PI, back: 13, up: 2.2 }); await shot("parked-front");
  await tweak(null);
  await page.evaluate(() => window.__vehicles.setView("cockpit")); await shot("cockpit-parked");
  await page.evaluate(() => window.__vehicles.setView("chase"));
  // take off and climb
  await page.evaluate(() => window.__vehicles.setSticks({ throttle: 1 }, 60000));
  await sleep(9000);
  await page.evaluate(() => window.__vehicles.setSticks({ throttle: 0.8, pitch: 0.3 }, 60000));
  await sleep(6000);
  await page.evaluate(() => window.__vehicles.setSticks({ throttle: 0.8, pitch: 0 }, 60000));
  await tweak({ yaw: 0.9, back: 18, up: 3 }); await shot("flight-quarter", 2500);
  await tweak(null); await shot("flight-chase", 1500);
  await page.evaluate(() => window.__vehicles.setSticks({ throttle: 0.8, fire: true }, 2500));
  await shot("guns", 700);
  await page.evaluate(() => window.__vehicles.setSticks({ throttle: 0.8, missile: true }, 1500));
  await shot("rails", 600);
  await page.evaluate(() => window.__vehicles.setView("cockpit"));
  await page.evaluate(() => window.__vehicles.setSticks({ throttle: 0.8, fire: true }, 2000));
  await shot("cockpit-guns", 800);
  await page.evaluate(() => window.__vehicles.setView("chase"));
  // a client-drawn 2,000 lb burst on the ground 120 m ahead
  await page.evaluate(() => {
    const V = window.__vehicles; const s = V.status().pilot?.state; if (!s) return;
    const x = s.x + Math.sin(s.heading) * 120, y = s.y + Math.cos(s.heading) * 120;
    let z = 0; try { z = window.__sessionHandle.terrainHeightAt(x, y) ?? s.z - 80; } catch (_) {}
    V.debugExplode([x, y, z], 2000);
  });
  await shot("explosion", 500);
  await shot("explosion-smoke", 1500);
  res.status = await page.evaluate(() => { const s = window.__vehicles.status(); return { weapons: s.weapons, airframes: s.airframes, pilot: s.pilot && { state: s.pilot.state, view: s.pilot.view } }; });
  // land, exit, despawn
  await page.evaluate(() => window.__vehicles.setSticks({ throttle: 0, land: true }, 60000));
  for (let i = 0; i < 80; i++) { const m = await page.evaluate(() => window.__vehicles.status().pilot?.state?.mode); if (m === 0) break; await sleep(500); }
  await page.evaluate(() => { window.__vehicles.clearSticks(); window.__vehicles.exit(0); });
  await sleep(3000);
  await chat("@vehicle despawn all"); await sleep(1500);
} catch (e) {
  res.errors.push(`fatal ${e?.stack ?? e}`);
} finally {
  writeFileSync(join(OUT, "result.json"), JSON.stringify(res, null, 1));
  await browser.close().catch(() => {});
  try { lock?.release?.(); } catch (_) { /* */ }
  log("done", res.shots.length, "shots,", res.errors.length, "errors");
}
