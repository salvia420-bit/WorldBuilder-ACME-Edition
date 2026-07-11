// Verify movement: face west + hold 'w' (keyboard), log pose trajectory.
import pw from '/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core/index.js';
const { chromium } = pw;
const CHROME = '/home/wbterminal/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--window-size=1280,720'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
page.setDefaultTimeout(60000);
page.on('console', (m) => { const t = m.text(); if (/move|stuck|error|heading/i.test(t)) console.log('  [page]', t.slice(0,160)); });
const url = `http://127.0.0.1:8765/apps/holtburger-web/index.html?autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&renderer=3d&quality=low&agentic=low&pvsRingRadius=2&nosw=1`;
await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
for (let i = 0; i < 120; i++) { const s = await page.evaluate(() => window.__bootState).catch(()=>null); if (s === 'in-world' || s === 'ready') break; await sleep(1500); }
await page.evaluate(() => { try { window.__sessionHandle.sendChat('@telepoi Holtburg'); } catch(e){} });
// wait for scene
for (let i = 0; i < 40; i++) { await sleep(2000); const mt = await page.evaluate(() => { const s=window.liveScene3d&&window.liveScene3d.scene; if(!s)return 0; let n=0; s.traverse(o=>{if(o.isMesh)n++;}); return n; }).catch(()=>0); if (mt > 100) { console.log('scene ready meshes=', mt); break; } }

const poseOf = () => page.evaluate(() => {
  const h = window.__sessionHandle; if (!h || !h.getLocalPlayerPose) return null;
  const p = h.getLocalPlayerPose(); if (!p) return null;
  const o = { x:+p.x.toFixed(1), y:+p.y.toFixed(1), z:+p.z.toFixed(1), lb:p.landblockId, heading:+p.heading.toFixed(3) };
  try { p.free(); } catch{} return o;
});

console.log('--- P0 baseline ---', JSON.stringify(await poseOf()));

// APPROACH A: turnToHeading(west) + held 'w' via keyboard
const startA = await page.evaluate(() => {
  try {
    const el = document.activeElement; if (el && el !== document.body && el.blur) el.blur();
    const r = { hasTurn: typeof window.__sessionHandle.turnToHeading === 'function' };
    try { window.__sessionHandle.turnToHeading(3*Math.PI/2); r.turned = true; } catch(e){ r.turnErr = String(e); }
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'w', code:'KeyW', bubbles:true, cancelable:true }));
    return r;
  } catch(e){ return { err:String(e) }; }
});
console.log('startA', JSON.stringify(startA));
for (let i = 0; i < 9; i++) {
  await sleep(5000);
  // re-assert heading west each tick (in case it decays)
  await page.evaluate(() => { try { window.__sessionHandle.turnToHeading(3*Math.PI/2); } catch(e){}
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'w', code:'KeyW', bubbles:true, cancelable:true })); }).catch(()=>{});
  console.log(`  A t${(i+1)*5}s`, JSON.stringify(await poseOf()));
}
await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keyup', { key:'w', code:'KeyW', bubbles:true, cancelable:true })));
console.log('--- released W ---');
await b.close();
console.log('MOVE_PROBE_DONE');
