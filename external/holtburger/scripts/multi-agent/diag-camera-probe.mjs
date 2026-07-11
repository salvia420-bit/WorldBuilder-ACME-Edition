// Deep diagnostic: after populate, is the camera on the player? why calls=1?
import pw from '/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core/index.js';
const { chromium } = pw;
const CHROME = '/home/wbterminal/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PVS = process.env.PVS ?? '3';

const b = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--window-size=1280,720'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
page.setDefaultTimeout(60000);
const url = `http://127.0.0.1:8765/apps/holtburger-web/index.html?autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&renderer=3d&quality=low&agentic=low&pvsRingRadius=${PVS}&nosw=1&renderDiag=on`;
console.log('goto', url);
await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
// wait ready
for (let i = 0; i < 120; i++) { const s = await page.evaluate(() => window.__bootState).catch(()=>null); if (s === 'ready') break; await sleep(1500); }
console.log('ready; teleport');
await page.evaluate(() => { try { window.__sessionHandle.sendChat('@telepoi Holtburg'); } catch(e){} });
// wait for populate (meshNodes>400) up to 150s
for (let i = 0; i < 75; i++) {
  await sleep(2000);
  const mn = await page.evaluate(() => window.__diag?.render?.meshNodes ?? 0).catch(()=>0);
  if (i % 5 === 0) console.log(`  t~${i*2}s meshNodes=${mn}`);
  if (mn > 400) { console.log(`populated meshNodes=${mn} at ~${i*2}s`); break; }
}
const dump = await page.evaluate(() => {
  const out = {};
  const ls = window.liveScene3d;
  out.hasLiveScene = !!ls;
  const keys = ls ? Object.keys(ls).filter(k => !k.startsWith('_')).slice(0, 60) : [];
  out.lsKeys = keys;
  let renderer = ls && (ls.renderer || ls.gl || (ls.three && ls.three.renderer));
  let scene = ls && (ls.scene || (ls.three && ls.three.scene));
  let camera = ls && (ls.camera || (ls.three && ls.three.camera));
  out.hasRenderer = !!renderer; out.hasScene = !!scene; out.hasCamera = !!camera;
  if (renderer && renderer.info) { out.infoRender = JSON.parse(JSON.stringify(renderer.info.render)); out.autoReset = renderer.info.autoReset; }
  if (camera) { try { out.cam = { pos: camera.position.toArray().map(n=>+n.toFixed(1)), near: camera.near, far: camera.far, type: camera.type }; } catch(e){ out.camErr=String(e);} }
  if (scene) {
    let total=0, visLeaf=0, visChain=0, culled=0;
    scene.traverse(o => {
      if (o.isMesh || o.isInstancedMesh || o.isBatchedMesh) {
        total++;
        if (o.visible) visLeaf++;
        let chainVisible = o.visible; let p = o.parent; while (p) { if (!p.visible) { chainVisible=false; break; } p = p.parent; }
        if (chainVisible) visChain++;
        if (o.frustumCulled) culled++;
      }
    });
    out.meshTotal=total; out.meshVisibleLeaf=visLeaf; out.meshVisibleChain=visChain; out.meshFrustumCulledFlag=culled;
    out.topGroups = scene.children.map(c => ({ name: c.name || c.type, visible: c.visible, kids: c.children ? c.children.length : 0 }));
  }
  const h = window.__sessionHandle;
  try { out.pose = h && h.getLocalPlayerPose ? h.getLocalPlayerPose() : null; } catch(e){ out.poseErr=String(e); }
  out.renderDiag = window.__diag?.render || null;
  return out;
});
console.log('DUMP', JSON.stringify(dump, null, 2));
await b.close();
console.log('PROBE_DONE');
