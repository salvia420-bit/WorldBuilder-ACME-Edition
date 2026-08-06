// bootab.mjs — interleaved BOOT-arm A/B for flags that cannot be toggled live.
//
// Boots alternate arms (A,B,A,B,...) so drift cancels, and RELAUNCHES CHROME
// between runs — last night's census proved that reusing one Chrome degrades it
// 2.44x over ~100 minutes (p50 25.6 -> 62.5 while materials halved), which is
// what made those results unusable.
//
// Usage: FLAG=statBatchChunk ARM_B=off node bootab.mjs out.json

import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const OUT = process.argv[2] || '/tmp/bootab.json';
const FLAG = process.env.FLAG;
const ARM_B = process.env.ARM_B || 'off';
const REPS = Number(process.env.REPS || 2);
const POI = process.env.POI || 'Nanto';
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 9000);
const ACCOUNTS = ['tailnet1', 'phase4demo'];
const ACE_LOG = '/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0/ACE_Log.txt';
const S = '/tmp/claude-1000/-home-wbterminal/7c942ef3-88b5-4c93-864e-5f919e845e87/scratchpad';
if (!FLAG) { console.error('FLAG env required'); process.exit(1); }

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c, t = 90000) => { try { return execSync(c, { timeout: t, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); } };

// hard watchdog — last night a hung page.evaluate cost 6 hours
const withTimeout = (p, ms, what) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`watchdog: ${what} > ${ms}ms`)), ms)),
]);

function aceHolds(a) { return /entered the world/.test(sh(`grep -a -E "Account ${a} (entered|exited) the world" ${ACE_LOG} | tail -1`, 20000)); }
async function waitRelease(a, max = 120000) { const t = Date.now(); while (aceHolds(a)) { if (Date.now() - t > max) return false; await sleep(5000); } return true; }

async function cdpUp() { try { const r = await fetch('http://127.0.0.1:9333/json/version', { signal: AbortSignal.timeout(4000) }); return r.ok; } catch (_) { return false; } }

async function freshChrome() {
  sh(`setsid ${S}/killchrome.sh > /dev/null 2>&1 < /dev/null`, 60000);
  await sleep(6000);
  sh(`ssh -o BatchMode=yes -o ConnectTimeout=15 young@100.127.215.75 "schtasks /run /tn hbcensus"`, 90000);
  await sleep(10000);
  sh(`bash ${S}/tun.sh 2>&1 || true`, 30000);
  await sleep(3000);
  for (let i = 0; i < 6 && !(await cdpUp()); i++) { await sleep(4000); }
  return await cdpUp();
}

function sampler() {
  const r = window.liveScene3d.renderer; r.info.autoReset = false;
  window.__B = { on: false, frames: [], c0: 0, t0: 0, last: performance.now(),
    start() { const rr = window.liveScene3d.renderer; this.frames = []; this.c0 = rr.info.render.calls; this.t0 = rr.info.render.triangles; this.last = performance.now(); this.on = true; },
    stop() { this.on = false; const rr = window.liveScene3d.renderer; const f = this.frames.slice().sort((a, b) => a - b);
      let bm = 0, batchC = 0; window.liveScene3d.scene.traverse((o) => { if (o.isBatchedMesh) { bm++; if (o.name?.startsWith('static-batch-c-')) batchC++; } });
      return { n: f.length, p50: f.length ? +f[f.length >> 1].toFixed(2) : null, p95: f.length ? +f[Math.floor(f.length * 0.95)].toFixed(2) : null,
               draws: f.length ? +((rr.info.render.calls - this.c0) / f.length).toFixed(1) : null,
               ktris: f.length ? +(((rr.info.render.triangles - this.t0) / f.length) / 1000).toFixed(0) : null,
               batchedMeshes: bm, staticBatchC: batchC }; } };
  const tick = () => { const n = performance.now(); if (window.__B.on) window.__B.frames.push(n - window.__B.last); window.__B.last = n; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return true;
}

async function runArm(arm, account) {
  if (!(await cdpUp())) { if (!(await freshChrome())) return { arm, verdict: 'INFRA-FAIL' }; }
  await waitRelease(account);
  const url = 'http://127.0.0.1:8765/apps/holtburger-web/index.html'
    + '?nosw=1&quality=mid&adaptiveRes=off&renderScale=1&renderDiag=on&camDebug=on'
    + `&autoLogin=1&account=${account}&password=${account}&autoSpawn=first&agent=1`
    + (arm === 'B' ? `&${FLAG}=${ARM_B}` : '');
  let page;
  try {
    const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
    const ctx = b.contexts()[0];
    for (const p of ctx.pages()) { if (p.url() !== 'about:blank') await p.close().catch(() => {}); }
    page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120)));
    await withTimeout(page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 }), 100000, 'goto');
    const t0 = Date.now();
    for (;;) {
      const s = await withTimeout(page.evaluate(() => window.__bootState).catch(() => null), 20000, 'bootState');
      if (s === 'ready' || s === 'in-world') break;
      if (s === 'error') return { arm, verdict: 'BOOT-FAIL' };
      if (Date.now() - t0 > 160000) return { arm, verdict: 'BOOT-TIMEOUT' };
      await sleep(700);
    }
    await withTimeout(page.evaluate((p) => window.__sessionHandle?.sendChat('@telepoi ' + p), POI), 20000, 'telepoi');
    await sleep(45000);
    await withTimeout(page.evaluate(() => { window.__cam?.player(9, 35, 14, 1.2); }), 20000, 'cam').catch(() => {});
    await sleep(6000);
    await withTimeout(page.evaluate(sampler), 30000, 'sampler');
    let prev = null, stable = 0;
    for (let i = 0; i < 8 && stable < 2; i++) {
      await withTimeout(page.evaluate(() => window.__B.start()), 20000, 'start');
      await sleep(4000);
      const s = await withTimeout(page.evaluate(() => window.__B.stop()), 20000, 'stop');
      if (prev && s.draws && Math.abs(s.draws - prev) / prev < 0.03) stable++; else stable = 0;
      prev = s.draws;
    }
    await withTimeout(page.evaluate(() => window.__B.start()), 20000, 'start2');
    await sleep(SAMPLE_MS);
    const r = await withTimeout(page.evaluate(() => window.__B.stop()), 20000, 'stop2');
    await page.close().catch(() => {});
    return { arm, verdict: 'OK', errors: errs.length, ...r };
  } catch (e) {
    try { await page?.close(); } catch (_) {}
    return { arm, verdict: 'ERROR', error: String(e.message).slice(0, 140) };
  }
}

(async () => {
  log(`boot A/B  flag=${FLAG}  B-arm=?${FLAG}=${ARM_B}  reps=${REPS}`);
  const arms = [];
  let ai = 0;
  for (let i = 0; i < REPS; i++) {
    for (const arm of ['A', 'B']) {
      const acct = ACCOUNTS[ai++ % ACCOUNTS.length];
      const r = await runArm(arm, acct);
      arms.push(r);
      log(`  ${arm}(${arm === 'A' ? 'default' : ARM_B}) ${r.verdict} p50=${r.p50} p95=${r.p95} draws=${r.draws} ktris=${r.ktris} batched=${r.batchedMeshes} batchC=${r.staticBatchC}`);
      if (i < REPS - 1 || arm === 'A') { log('    [relaunching chrome for a clean GPU state]'); await freshChrome(); }
    }
  }
  const agg = {};
  for (const a of arms) if (a.verdict === 'OK') (agg[a.arm] ||= []).push(a);
  const med = (l, k) => { const v = l.map((x) => x[k]).filter((x) => x != null).sort((a, c) => a - c); return v.length ? +v[Math.floor(v.length / 2)].toFixed(2) : null; };
  const sum = Object.entries(agg).map(([arm, l]) => ({
    arm: arm === 'A' ? 'A default' : `B ?${FLAG}=${ARM_B}`, n: l.length,
    p50: med(l, 'p50'), p95: med(l, 'p95'), draws: med(l, 'draws'), ktris: med(l, 'ktris'),
    batched: med(l, 'batchedMeshes'), batchC: med(l, 'staticBatchC'),
    p50_runs: l.map((x) => x.p50).join('/'), draws_runs: l.map((x) => x.draws).join('/'),
  }));
  console.table(sum);
  writeFileSync(OUT, JSON.stringify({ flag: FLAG, armB: ARM_B, arms, sum }, null, 2));
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
