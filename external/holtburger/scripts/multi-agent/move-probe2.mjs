// Validate an adaptive WEST-lock run controller (keyboard Q/E turn + W run) with stuck->teleport.
import pw from '/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core/index.js';
const { chromium } = pw;
const CHROME = '/home/wbterminal/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--window-size=1280,720'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
page.setDefaultTimeout(60000);
page.on('console', (m) => { const t = m.text(); if (/\[walk\]/i.test(t)) console.log('  [page]', t.slice(0,160)); });
const url = `http://127.0.0.1:8765/apps/holtburger-web/index.html?autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&kickDance=1&renderer=3d&quality=low&agentic=low&pvsRingRadius=2&nosw=1`;
await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
for (let i = 0; i < 120; i++) { const s = await page.evaluate(() => window.__bootState).catch(()=>null); if (s === 'in-world' || s === 'ready') break; await sleep(1500); }
await page.evaluate(() => { try { window.__sessionHandle.sendChat('@telepoi Holtburg'); } catch(e){} });
for (let i = 0; i < 40; i++) { await sleep(2000); const mt = await page.evaluate(() => { const s=window.liveScene3d&&window.liveScene3d.scene; if(!s)return 0; let n=0; s.traverse(o=>{if(o.isMesh)n++;}); return n; }).catch(()=>0); if (mt > 100) { console.log('scene ready meshes=', mt); break; } }

// Install the in-page WEST-lock run controller (self-contained, low-fps robust).
await page.evaluate(() => {
  if (window.__walkCtl) { window.__walkCtl.stop = true; try { window.__walkCtl.releaseAll(); } catch {} }
  const TARGET = -Math.PI / 2;   // west: pose.heading +X east=+pi/2 -> -X west=-pi/2
  const held = new Set();
  const fire = (k, type) => document.dispatchEvent(new KeyboardEvent(type, { key: k, code: 'Key' + k.toUpperCase(), bubbles: true, cancelable: true }));
  const setHeld = (k, on) => { if (on && !held.has(k)) { fire(k, 'keydown'); held.add(k); } else if (!on && held.has(k)) { fire(k, 'keyup'); held.delete(k); } };
  const releaseAll = () => { for (const k of Array.from(held)) { fire(k, 'keyup'); held.delete(k); } };
  const angDiff = (a, t) => { let d = a - t; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
  const getPose = () => { try { const h = window.__sessionHandle; const p = h && h.getLocalPlayerPose ? h.getLocalPlayerPose() : null; if (!p) return null; const o = { x: p.x, y: p.y, lb: p.landblockId, h: p.heading }; try { p.free(); } catch {} return o; } catch { return null; } };
  try { const el = document.activeElement; if (el && el !== document.body && el.blur) el.blur(); } catch {}
  const st = { started: performance.now(), stuckTeleports: 0, turnKey: 'q', lastDh: null, lastPose: null, lastMoveT: 0, faced: false, releaseAll, stop: false, corrections: 0 };
  window.__walkCtl = st;
  const tick = () => {
    if (st.stop) { releaseAll(); return; }
    const p = getPose();
    if (!p) return;
    const dh = angDiff(p.h, TARGET);
    if (Math.abs(dh) > 0.2) {
      // turning: stop forward for a clean turn; pick turn key adaptively
      setHeld('w', false);
      if (st.lastDh != null && Math.abs(dh) > Math.abs(st.lastDh) + 0.08) { st.turnKey = st.turnKey === 'q' ? 'e' : 'q'; }
      setHeld(st.turnKey === 'q' ? 'e' : 'q', false);
      setHeld(st.turnKey, true);
      st.lastDh = dh;
      st.faced = false;
    } else {
      setHeld('q', false); setHeld('e', false); st.lastDh = null;
      setHeld('w', true);
      if (!st.faced) { st.faced = true; st.corrections++; console.log(`[walk] faced west (heading=${p.h.toFixed(2)})`); }
    }
    // stuck detection every ~6s (only while trying to run forward)
    const now = performance.now();
    if (now - st.lastMoveT > 6000) {
      if (st.lastPose && st.faced) {
        const moved = Math.hypot(p.x - st.lastPose.x, p.y - st.lastPose.y);
        const lbChanged = st.lastPose.lb !== p.lb;
        if (!lbChanged && moved < 5) {
          st.stuckTeleports++;
          console.log(`[walk] stuck (moved ${moved.toFixed(1)}m) -> teleport Holtburg`);
          try { window.__sessionHandle.sendChat('@telepoi Holtburg'); } catch {}
          setHeld('w', false); st.faced = false; st.lastPose = null; st.lastMoveT = now + 4000; return;
        }
      }
      st.lastPose = { x: p.x, y: p.y, lb: p.lb }; st.lastMoveT = now;
    }
  };
  st.timer = setInterval(tick, 500);
});

const xb = (lb) => (lb >>> 24) & 0xff, yb = (lb) => (lb >>> 16) & 0xff;
const poseOf = () => page.evaluate(() => { const h = window.__sessionHandle; const p = h && h.getLocalPlayerPose ? h.getLocalPlayerPose() : null; if (!p) return null; const o = { x: +p.x.toFixed(1), y: +p.y.toFixed(1), lb: p.landblockId, h: +p.heading.toFixed(2) }; try { p.free(); } catch {} return o; });
console.log('start lb-xbyte tracking (west = xbyte decreasing)');
for (let i = 0; i < 20; i++) {
  await sleep(5000);
  const p = await poseOf();
  const ctl = await page.evaluate(() => ({ tp: window.__walkCtl?.stuckTeleports, faced: window.__walkCtl?.faced, turnKey: window.__walkCtl?.turnKey }));
  if (p) console.log(`  t${(i+1)*5}s x=${p.x} y=${p.y} lb=0x${p.lb.toString(16)} xb=0x${xb(p.lb).toString(16)} yb=0x${yb(p.lb).toString(16)} h=${p.h} | faced=${ctl.faced} tp=${ctl.tp}`);
}
await page.evaluate(() => { if (window.__walkCtl) { window.__walkCtl.stop = true; try { window.__walkCtl.releaseAll(); } catch {} } });
await b.close();
console.log('MOVE_PROBE2_DONE');
