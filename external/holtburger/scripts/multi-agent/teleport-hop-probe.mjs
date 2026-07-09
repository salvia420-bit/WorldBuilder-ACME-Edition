// Validate @teleloc westward hop: decrement landblock x-byte, confirm streaming.
import pw from '/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core/index.js';
const { chromium } = pw;
const CHROME = '/home/wbterminal/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--window-size=1280,720'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
page.setDefaultTimeout(60000);
const url = `http://127.0.0.1:8765/apps/holtburger-web/index.html?autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&kickDance=1&renderer=3d&quality=low&agentic=low&pvsRingRadius=2&nosw=1`;
await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
for (let i = 0; i < 120; i++) { const s = await page.evaluate(() => window.__bootState).catch(()=>null); if (s === 'in-world' || s === 'ready') break; await sleep(1500); }
await page.evaluate(() => { try { window.__sessionHandle.sendChat('@telepoi Holtburg'); } catch(e){} });
const meshN = () => page.evaluate(() => { const s=window.liveScene3d&&window.liveScene3d.scene; if(!s)return 0; let n=0; s.traverse(o=>{if(o.isMesh)n++;}); return n; }).catch(()=>0);
for (let i = 0; i < 40; i++) { await sleep(2000); if (await meshN() > 100) { console.log('scene ready'); break; } }

const poseOf = () => page.evaluate(() => { const h=window.__sessionHandle; const p=h&&h.getLocalPlayerPose?h.getLocalPlayerPose():null; if(!p)return null; const o={x:p.x,y:p.y,z:p.z,lb:p.landblockId>>>0}; try{p.free();}catch{} return o; });
const xb = (lb) => (lb >>> 24) & 0xff;
const send = (cmd) => page.evaluate((c) => { try { window.__sessionHandle.sendChat(c); return 'ok'; } catch(e){ return String(e); } }, cmd);

const p0 = await poseOf();
console.log('P0', JSON.stringify(p0), 'xb=0x'+xb(p0.lb).toString(16), 'meshes='+await meshN());
const baseCell = p0.lb >>> 0;
const x = p0.x, y = p0.y, z = p0.z;

for (let hop = 1; hop <= 3; hop++) {
  const cell = (baseCell - hop * 0x01000000) >>> 0;   // hop landblocks WEST (x-byte -1 each)
  const cmd = `@teleloc 0x${cell.toString(16).toUpperCase()} ${x.toFixed(3)} ${y.toFixed(3)} ${(z + 3).toFixed(3)}`;
  const r = await send(cmd);
  console.log(`HOP ${hop}: ${cmd} -> ${r}`);
  // sample streaming for ~12s
  for (let t = 0; t < 3; t++) {
    await sleep(4000);
    const p = await poseOf();
    console.log(`  hop${hop} t${(t+1)*4}s`, p ? `lb=0x${p.lb.toString(16)} xb=0x${xb(p.lb).toString(16)} x=${p.x.toFixed(1)} y=${p.y.toFixed(1)} z=${p.z.toFixed(1)} meshes=${await meshN()}` : 'no-pose');
  }
}
await b.close();
console.log('HOP_PROBE_DONE');
