import { chromium } from "playwright";
import { readFileSync } from "fs";
const LBHEX = process.argv[2] || "A9B4";
const lbId = (parseInt(LBHEX, 16) << 16) >>> 0;
const tp = "0x" + lbId.toString(16).padStart(8, "0");
const exp = JSON.parse(readFileSync(`/home/wbterminal/out/expected_${LBHEX}.json`, "utf8"));
const args = ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"];
const PRESET = "renderer=3d&wireframe=1&quality=low&agentic=low&eagerDungeons=on&hud=none&plugins=none&diag=1&nosw=1&renderOnDemand=1&autoLogin=1&autoSpawn=first&kickDance=1&server_host=127.0.0.1&server_port=9000&bridge_url=ws://127.0.0.1:8080/";
const U = `http://127.0.0.1:8765/apps/holtburger-web/index.html?${PRESET}&account=smoketest1&password=smoketest1`;
const b = await chromium.launch({ headless: true, args }); const p = await b.newPage();
await p.goto(U, { waitUntil: "domcontentloaded", timeout: 60000 });
let dl = Date.now() + 130000;
while (Date.now() < dl) { const s = await p.evaluate(() => window.__bootState).catch(() => null);
  if (["ready", "in-world"].includes(s)) break;
  if (s === "error") { await p.evaluate(() => { try { window.__sessionHandle.createTestCharacter("Pv" + Date.now().toString().slice(-5)); } catch (e) {} }); await p.waitForTimeout(8000); await p.evaluate(() => { try { window.__runAutonomousLogin({ autoSpawn: "first", kickDance: 0 }); } catch (e) {} }); }
  await p.waitForTimeout(2500); }
await p.evaluate(() => { try { window.__sessionHandle.sendChat("@god"); } catch (e) {} }); await p.waitForTimeout(1500);
await p.evaluate((c) => { try { window.__sessionHandle.sendChat(`@teleloc ${c} 96.0 96.0 500.0`); } catch (e) {} }, tp);
let rendered = [];
for (let i = 0; i < 16; i++) { await p.waitForTimeout(2000); await p.evaluate(() => { try { window.__renderOnce?.(); } catch (e) {} });
  rendered = await p.evaluate((lbId) => { const w = window.__diag?.placements?.walk?.(lbId); return Array.isArray(w) ? w.map(o => ({ m: o.modelId >>> 0, p: o.position })) : []; }, lbId);
  if (rendered.length >= exp.length * 0.8) break; }
await b.close();
// compare: for each expected, find nearest rendered with same modelId
const d2 = (a, x, y) => (a[0] - x) ** 2 + (a[1] - y) ** 2;
let matched = 0, misplaced = 0, notRendered = 0; const roof = []; const moved = [];
for (const e of exp) {
  const cands = rendered.filter(r => r.m === (e.modelId >>> 0) && Array.isArray(r.p));
  if (!cands.length) { notRendered++; continue; }
  let best = null, bd = Infinity;
  for (const c of cands) { const dd = d2(c.p, e.wx, e.wy); if (dd < bd) { bd = dd; best = c; } }
  const xy = Math.sqrt(bd), dz = best.p[2] - e.z, dist = Math.sqrt(bd + dz * dz);
  if (dist <= 2) matched++;
  else { misplaced++; moved.push({ m: "0x" + (e.modelId >>> 0).toString(16), xy: +xy.toFixed(1), dz: +dz.toFixed(1) });
    if (dz > 4) roof.push({ m: "0x" + (e.modelId >>> 0).toString(16), exp_z: e.z, ren_z: +best.p[2].toFixed(1), dz: +dz.toFixed(1) }); }
}
console.log(`LB 0x${LBHEX}: expected=${exp.length} rendered=${rendered.length}`);
console.log(`  matched(<2m)=${matched}  misplaced=${misplaced}  not-rendered=${notRendered}`);
if (roof.length) console.log(`  ROOF CANDIDATES (rendered Z >4m above expected): ${roof.length}`), console.log("   ", JSON.stringify(roof.slice(0, 10)));
else console.log("  (no roof candidates)");
if (moved.length) console.log("  sample misplaced:", JSON.stringify(moved.slice(0, 8)));
