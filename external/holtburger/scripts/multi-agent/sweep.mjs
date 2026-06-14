import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
// World completeness sweep agent: per landblock, teleport (outdoor center, godmode)
// and verify BOTH outdoor placements (placements.walk) AND interior EnvCells
// (cellContainers3d, eagerDungeons) against an expected-count map. Resumable +
// shardable. Verdicts: OK / INT_DRIFT / EMPTY / MISS. Run multiple instances with
// --shard i/N --account sweepI --label world for parallel coverage.
const A = process.argv.slice(2), arg = (k, d) => { const m = A.find(a => a.startsWith(`--${k}=`)); return m ? m.split("=")[1] : d; };
const [si, sn] = arg("shard", "0/1").split("/").map(Number);
const limit = parseInt(arg("limit", "0")) || 0, label = arg("label", "sweep"), account = arg("account", "smoketest1");
const EXP = JSON.parse(readFileSync("/home/wbterminal/out/lb_expected.json", "utf8"));
const STATE = `/home/wbterminal/out/sweep-state-${label}`; if (!existsSync(STATE)) mkdirSync(STATE, { recursive: true });
const done = new Set(readdirSync(STATE).filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, "")));
const all = readFileSync("/home/wbterminal/out/sweep_queue.txt", "utf8").split("\n").map(s => s.trim()).filter(Boolean);
let queue = all.filter((_, i) => i % sn === si).filter(base => !done.has(((parseInt(base, 16) >>> 16) & 0xffff).toString(16)));
if (limit) queue = queue.slice(0, limit);
const PRESET = "renderer=3d&wireframe=1&quality=low&agentic=low&eagerDungeons=on&hud=none&plugins=none&diag=1&nosw=1&renderOnDemand=1&autoLogin=1&autoSpawn=first&kickDance=1&server_host=127.0.0.1&server_port=9000&bridge_url=ws://127.0.0.1:8080/";
const U = `http://127.0.0.1:8765/apps/holtburger-web/index.html?${PRESET}&account=${account}&password=${account}`;
const b = await chromium.launch({ headless: true, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"] });
process.on("SIGTERM", async () => { try { await b.close(); } catch {} process.exit(143); });
const p = await b.newPage();
await p.goto(U, { waitUntil: "domcontentloaded", timeout: 60000 });
let dl = Date.now() + 150000;
while (Date.now() < dl) {
  const s = await p.evaluate(() => window.__bootState).catch(() => null);
  if (["ready", "in-world"].includes(s) && (await p.evaluate(() => (window.liveScene3d?.entitiesGroup?.children?.length || 0) > 0))) break;
  if (s === "error" || s === "ready") {
    await p.evaluate((nm) => { try { window.__sessionHandle.createTestCharacter(nm); } catch (e) {} }, "S" + account.slice(-3) + Date.now().toString().slice(-5));
    await p.waitForTimeout(8000);
    await p.evaluate(() => { try { window.__runAutonomousLogin({ autoSpawn: "first", kickDance: 0 }); } catch (e) {} });
  }
  await p.waitForTimeout(2500);
}
await p.evaluate(() => { try { window.__sessionHandle.sendChat("@god"); } catch (e) {} });
await p.waitForTimeout(2000);
const read = (lbId, lbX, lbY) => p.evaluate(({ lbId, lbX, lbY }) => {
  const L = window.liveScene3d || {};
  let cam = false; const c = L.camera?.position;
  if (c) cam = (((Math.floor(c.x / 192)) & 0xff) === lbX) && (((Math.floor(c.y / 192)) & 0xff) === lbY);
  let outdoor = 0; try { const w = window.__diag?.placements?.walk?.(lbId); outdoor = Array.isArray(w) ? w.length : 0; } catch (e) {}
  let interior = 0; const m = L.cellContainers3d;
  if (m instanceof Map) { const hi = lbId >>> 16; for (const cid of m.keys()) if (((cid >>> 0) >>> 16) === hi) interior++; }
  return { cam, outdoor, interior };
}, { lbId, lbX, lbY });
const R = { OK: 0, INT_DRIFT: 0, EMPTY: 0, MISS: 0 }; const flags = []; const t0 = Date.now();
for (const base of queue) {
  const lbId = parseInt(base, 16) >>> 0, lbX = (lbId >>> 24) & 0xff, lbY = (lbId >>> 16) & 0xff, lbHex = (lbId >>> 16).toString(16);
  const exp = EXP[lbHex.padStart(4, "0")] || { li: 1, cells: 0 }; const expCells = exp.cells || 0;
  const cap = expCells > 200 ? 34000 : (expCells > 0 ? 24000 : 15000);
  let arrived = false, outdoor = 0, interior = 0;
  for (let att = 1; att <= 2 && !arrived; att++) {
    await p.evaluate((c) => { try { window.__sessionHandle.sendChat(`@teleloc ${c} 96.0 96.0 500.0`); } catch (e) {} }, base);
    let prevO = -9, prevI = -9, stable = 0; const deadline = Date.now() + cap;
    while (Date.now() < deadline) {
      await p.waitForTimeout(1700);
      await p.evaluate(() => { try { window.__renderOnce?.(); } catch (e) {} });
      const r = await read(lbId, lbX, lbY); outdoor = r.outdoor; interior = r.interior;
      if (r.cam || r.outdoor > 0 || r.interior > 0) arrived = true;
      const intDone = expCells === 0 || interior >= Math.ceil(expCells * 0.9);
      if (r.outdoor === prevO && r.interior === prevI) { stable++; if (stable >= 2 && arrived && (intDone || interior > 0)) break; } else stable = 0;
      prevO = r.outdoor; prevI = r.interior;
    }
  }
  let verdict;
  if (!arrived) verdict = "MISS";
  else if (outdoor === 0 && interior === 0) verdict = "EMPTY";
  else if (expCells > 0 && interior < Math.ceil(expCells * 0.9)) verdict = "INT_DRIFT";
  else verdict = "OK";
  R[verdict]++;
  if (verdict !== "OK") flags.push(`${lbHex}:${verdict}(o${outdoor}/i${interior} exp_c${expCells})`);
  writeFileSync(`${STATE}/${lbHex}.json`, JSON.stringify({ lb: lbHex, verdict, outdoor, interior, expCells, ts: Date.now() }));
}
const secs = Math.round((Date.now() - t0) / 1000);
console.log(`SWEEP ${arg("shard", "0/1")} acct=${account}: ${queue.length} LBs ${secs}s (${(secs / Math.max(1, queue.length)).toFixed(1)}s/LB) | OK=${R.OK} INT_DRIFT=${R.INT_DRIFT} EMPTY=${R.EMPTY} MISS=${R.MISS}`);
if (flags.length) console.log("FLAGS:", flags.slice(0, 40).join("  "));
await b.close();
