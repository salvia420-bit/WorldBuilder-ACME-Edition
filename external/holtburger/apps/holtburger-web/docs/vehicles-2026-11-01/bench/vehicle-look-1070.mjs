// vehicle-look-1070.mjs — the Hellcat built from AC parts on the 1070's real GPU (MODE T: off-screen, muted test Chrome via
// the hidden hbprobe task, its own profile; nothing on the owner's screen; same launch path as vehicle-1070-probe.mjs).
//   node vehicle-look-1070.mjs [--out DIR]
// Stills (CDP Page.captureScreenshot): parked from four sides, the cockpit, take-off, in flight, the guns from the chase
// and the cockpit, the lightning rails, a real 2,000 lb bomb run framed from ahead (release, burst, smoke), the landing.
// Needs the laptop tunnel (-L 9333 -R 8765 -R 8080) and the 1070 gate (hbgate.ps1 exit 0).
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const BOX = "young@100.127.215.75", CDP = "http://127.0.0.1:9333";
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = opt("--out", "/mnt/wbterminal1/tmp/claude-scratch/vehicles/1070-look-a");
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const log = (...m) => console.log(`[look1070 ${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ssh = (c) => execFileSync("ssh", ["-o", "BatchMode=yes", BOX, c], { encoding: "utf8", timeout: 60000 });
const res = { shots: [], errors: [], notes: {} };
try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) {}
ssh(`echo hbb-vlook-${Date.now()}> D:\\Temp\\hbbench\\profile.txt`);
ssh(`echo 1600,900> D:\\Temp\\hbbench\\winsize.txt`);
ssh('schtasks /create /tn hbprobe /tr "wscript.exe //B //Nologo D:\\Temp\\hbbench\\hidden-run.vbs D:\\Temp\\hbbench\\hbprobe-launch.bat" /sc once /st 00:00 /it /f >nul 2>nul & schtasks /run /tn hbprobe >nul');
let up = false;
for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`${CDP}/json/version`)).ok; } catch (_) {} if (!up) await sleep(1000); }
if (!up) { log("no CDP"); process.exit(1); }
const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
const pg = ctx.pages()[0];
const url = "http://127.0.0.1:8765/apps/holtburger-web/index.html?autoLogin=1&account=agentp10&password=agentp10&autoSpawn=first&nosw=1&portalSpace=off"
  + "&quality=high&csm=off&renderScale=1&adaptiveRes=off&objRadius=3&vehicles=on&vehicleAudio=off&targetFps=30&skytime=11&cloudCoverage=0.3&hud=none";
pg.on("console", (m) => { const t = m.text(); if (m.type() === "error" && res.errors.length < 60) res.errors.push(t.slice(0, 300)); if (/\[vehicles\]/.test(t)) log(t.slice(0, 160)); });
pg.on("pageerror", (e) => res.errors.push(`pageerror ${String(e?.message ?? e).slice(0, 300)}`));
const cdp = await ctx.newCDPSession(pg);
const shot = async (name, settleMs = 1500) => {
  await sleep(settleMs);
  const r = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 88 });
  const f = join(OUT, `${String(res.shots.length).padStart(2, "0")}-${name}.jpg`);
  writeFileSync(f, Buffer.from(r.data, "base64"));
  res.shots.push(f);
  log("shot", name);
};
const V = (fn, arg) => pg.evaluate(fn, arg);
try {
  await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  for (let i = 0; i < 180; i++) { if (await V(() => !!window.__vehicles && (window.__bootStateHistory || []).some((s) => (s.state || s) === "ready")).catch(() => false)) break; await sleep(1000); }
  log("in world");
  res.notes.gpu = await V(() => { try { const gl = document.createElement("canvas").getContext("webgl2"); const e = gl.getExtension("WEBGL_debug_renderer_info"); return gl.getParameter(e.UNMASKED_RENDERER_WEBGL); } catch (e) { return String(e); } });
  log("gpu", res.notes.gpu);
  log("wake lock", await V(async () => { try { window.__benchWake = await navigator.wakeLock.request("screen"); return "held"; } catch (e) { return String(e); } }).catch((e) => String(e)));
  const chat = (m) => V((x) => window.__sessionHandle.sendChat(x), m);
  await chat("@cloak on"); await sleep(1000);
  await chat("@teleloc 0xA9B40019 84 7.1 94"); await sleep(15000);
  await chat("@vehicle despawn all"); await sleep(1500);
  res.notes.spawn = await V(async () => {
    const W = window.__vehicles; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40 && W.status().caps.granted === null; i++) await sleep(500);
    W.spawn();
    for (let i = 0; i < 80; i++) { const v = W.status().vehicles.find((x) => x.mode === 0); if (v && v.airframe === "ready") return v; await sleep(500); }
    return W.status().vehicles;
  });
  log("spawned", JSON.stringify(res.notes.spawn).slice(0, 160));
  res.notes.board = await V(async () => { const W = window.__vehicles; W.board(); for (let i = 0; i < 40 && !W.piloting; i++) await new Promise((x) => setTimeout(x, 250)); return W.piloting; });
  const tweak = (t) => V((x) => window.__vehicles.setCameraTweak(x), t);
  const sticks = (k, ms) => V(([a, b]) => window.__vehicles.setSticks(a, b), [k, ms]);
  // parked
  await tweak({ yaw: 0.65, back: 16, up: 4.5 }); await shot("parked-rear-quarter", 5000);
  await tweak({ yaw: Math.PI / 2, back: 15, up: 2.6 }); await shot("parked-side");
  await tweak({ yaw: Math.PI - 0.55, back: 15, up: 3.2 }); await shot("parked-front-quarter");
  await tweak({ yaw: Math.PI, back: 13, up: 2.4 }); await shot("parked-front");
  await tweak({ yaw: -Math.PI / 2, back: 9, up: 6 }); await shot("parked-cockpit-close");
  await tweak(null);
  await V(() => window.__vehicles.setView("cockpit")); await shot("cockpit-parked");
  await V(() => window.__vehicles.setView("chase"));
  // take off, climb to ~150 m
  await sticks({ throttle: 1 }, 60000);
  await tweak({ yaw: 0.9, back: 18, up: 3 }); await shot("takeoff", 2500);
  await tweak(null);
  await sleep(6000);
  await sticks({ throttle: 0.85, pitch: 0.35 }, 60000); await sleep(9000);
  await sticks({ throttle: 0.85, pitch: 0 }, 60000);
  await tweak({ yaw: 1.0, back: 20, up: 4 }); await shot("flight-quarter", 2500);
  await tweak({ yaw: Math.PI / 2, back: 18, up: 2 }); await shot("flight-side", 1500);
  await tweak(null); await shot("flight-chase", 1500);
  await sticks({ throttle: 0.85, fire: true }, 3000); await shot("guns-chase", 600);
  await V(() => window.__vehicles.setView("cockpit"));
  await sticks({ throttle: 0.85, fire: true }, 3000); await shot("guns-cockpit", 700);
  await shot("cockpit-flight", 2600);
  await V(() => window.__vehicles.setView("chase"));
  await sticks({ throttle: 0.85, missile: true }, 1600); await shot("rails-launch", 450);
  await shot("rails-bolts", 900);
  // the bomb run: release the 2,000 lb, then frame from ahead / above looking back at the burst
  res.notes.pipper = await V(() => window.__vehicles.pipper());
  await sticks({ throttle: 0.85, bomb: true }, 250); await sleep(300);
  await sticks({ throttle: 0.85 }, 60000);
  await tweak({ yaw: Math.PI / 2, back: 25, up: 3 }); await shot("bomb-falling", 900);
  const tImp = res.notes.pipper?.t ?? 6;
  await tweak({ yaw: Math.PI - 0.3, back: 60, up: 110 }); // ahead + high, looking steeply down past the aircraft onto its ground track
  await sleep(Math.max(500, (tImp - 1.4) * 1000));
  await shot("bomb-burst", 0); await shot("bomb-burst-2", 350); await shot("bomb-burst-3", 600); await shot("bomb-smoke", 1500); await shot("bomb-smoke-2", 3000);
  // a client-drawn 2,000 lb burst at 150 m ahead of the nose, framed from high behind the aircraft (the chase camera looks
  // level: the burst ~100 m below was out of frame in 1070-look-c)
  await tweak({ yaw: 0, back: 40, up: 60 });
  await V(() => { const W = window.__vehicles, s = W.status().pilot?.state; if (!s) return;
    const x = s.x + Math.sin(s.heading) * 150, y = s.y + Math.cos(s.heading) * 150;
    let z = s.z - 100; try { const g = window.__sessionHandle.terrainHeightAt(x, y); if (Number.isFinite(g)) z = g; } catch (_) {}
    W.debugExplode([x, y, z], 2000); });
  await shot("burst-ahead", 500); await shot("burst-ahead-2", 700); await shot("burst-ahead-smoke", 2500);
  res.notes.weapons = await V(() => window.__vehicles.status().weapons);
  await tweak(null);
  // land
  await sticks({ throttle: 0, land: true }, 90000);
  for (let i = 0; i < 120; i++) { const m = await V(() => window.__vehicles.status().pilot?.state?.mode); if (m === 0) break; await sleep(500); }
  await tweak({ yaw: 0.65, back: 16, up: 4.5 }); await shot("landed", 2500);
  await tweak(null);
  await V(() => { window.__vehicles.clearSticks(); window.__vehicles.exit(0); }); await sleep(3000);
  await chat("@vehicle despawn all"); await sleep(1500);
} catch (e) {
  res.errors.push(`fatal ${e?.stack ?? e}`);
} finally {
  writeFileSync(join(OUT, "result.json"), JSON.stringify(res, null, 1));
  await pg.goto("about:blank").catch(() => {}); await sleep(1500);
  try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) {}
  log("done", res.shots.length, "shots,", res.errors.length, "errors");
  process.exit(0);
}
