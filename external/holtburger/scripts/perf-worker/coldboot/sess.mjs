// sess.mjs — persistent eye-test session on the 1070 (boot once, then drive with probe.mjs / shot.mjs).
//   node sess.mjs boot [--flags 'a=b'] [--window 1280,720]
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { statSync, openSync, readSync, closeSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const BOX = "young@100.127.215.75", CDP = "http://127.0.0.1:9333", PORT = +opt("--port", 7093), HOST = opt("--host", "100.116.47.66");
const ACE_LOG = "/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0/ACE_Log.txt";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ssh = (c) => execFileSync("ssh", ["-o", "BatchMode=yes", BOX, c], { encoding: "utf8", timeout: 60000 });
function aceTail(n = 262144) { const s = statSync(ACE_LOG).size, fd = openSync(ACE_LOG, "r"); const b = Buffer.alloc(Math.min(n, s)); readSync(fd, b, 0, b.length, s - b.length); closeSync(fd); return b.toString("utf8"); }
async function waitFree(maxMs = 150000) { const end = Date.now() + maxMs; while (Date.now() < end) { const ev = aceTail().split("\n").filter((l) => /\[(LOGIN|LOGOUT)\] Account tailnet1 /.test(l)); const last = ev[ev.length - 1]; if (!last || /\[LOGOUT\]/.test(last)) return true; await sleep(2000); } return false; }
try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) {}
console.log("account free:", await waitFree());
ssh(`echo hbb-sess-${Date.now()}> D:\\Temp\\hbbench\\profile.txt`);
ssh(`echo ${opt("--window", "1280,720")}> D:\\Temp\\hbbench\\winsize.txt`);
ssh('schtasks /create /tn hbprobe /tr "D:\\Temp\\hbbench\\hbprobe-launch.bat" /sc once /st 00:00 /it /f >nul 2>nul & schtasks /run /tn hbprobe >nul');
for (let i = 0; i < 40; i++) { try { if ((await fetch(`${CDP}/json/version`)).ok) break; } catch (_) {} await sleep(1000); }
const browser = await chromium.connectOverCDP(CDP);
const pg = browser.contexts()[0].pages()[0];
const flags = opt("--flags", "");
const url = `http://${HOST}:${PORT}/apps/holtburger-web/index.html?autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=${opt("--spawn", "first")}&nosw=1&camDebug=on&bridge_url=ws://${HOST}:${PORT}/wsbridge&server_host=127.0.0.1&server_port=9000${flags ? "&" + flags : ""}`;
await pg.addInitScript(() => { try { performance.setResourceTimingBufferSize(200000); } catch (_) {} }); // full resource timing (default buffer: 250)
await pg.goto(url, { waitUntil: "commit", timeout: 120000 });
let ok = false;
const selectMode = opt("--spawn", "first") === "select";
for (let i = 0; i < 180 && !ok; i++) {
  ok = await pg.evaluate((sel) => sel
    ? (window.__bootStateHistory || []).some((h) => h.state === "char-list-ready") && !!document.querySelector('#hb-charselect[data-open="1"]')
    : !!window.liveScene3d && !!window.__sessionHandle && window.__sceneReadyEverFired === true && (window.liveScene3d?.terrainBakedLbs?.size ?? 0) >= 9, selectMode).catch(() => false);
  if (!ok) await sleep(1000);
}
console.log(ok ? (selectMode ? "character screen up" : "in-world with terrain") : "boot NOT ready", JSON.stringify(await pg.evaluate(() => (window.__bootStateHistory || []).map((h) => h.state)).catch(() => null)));
// Login portal space (2026-10-09, default on): "in-world with terrain" can come while the login
// tunnel still owns the screen — eye tests should gate on __isPortalSpaceActive() === false.
console.log("portalSpace", JSON.stringify(await pg.evaluate(() => { const P = window.__portalSpace; return { active: !!window.__isPortalSpaceActive?.(), state: P?.state ?? null, reason: P?.reason ?? null, login: P?.login ?? null, loginSkip: P?.loginSkip ?? null }; }).catch(() => null)));
process.exit(ok ? 0 : 1);
