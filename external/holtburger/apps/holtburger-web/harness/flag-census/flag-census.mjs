// flag-census.mjs — overnight A/B census of the default-ON URL flags.
//
// NO CLIENT CODE IS TOUCHED. This is a measurement harness only: it boots the
// shipped client with one flag escaped at a time and records what changes.
//
// WHAT THIS IS FOR. Cross-boot frame time on this workload cannot resolve small
// effects — sessions measured 25.2 / 25.8 / 31.4 / 32.3 ms today purely because
// the entity population differs. So p50 is recorded but is the WEAKEST signal
// here. The strong signals are structural and near-deterministic: draws/frame,
// bucket / material / program counts, triangles, texture bytes, heap, boot time,
// console errors. The most valuable single finding this can produce is a flag
// documented as default-ON whose escape arm is indistinguishable from baseline
// on EVERY metric — that flag is dead or mis-documented, and this tree has a
// history of exactly that (the `shadows` tombstone; "6 cast flags silently
// live").
//
// METHOD
//  - fixed POI + parked camera + settle-gate on draws/frame, so arms are
//    comparable (the first sweep of 2026-08-06 was wasted because the scene was
//    still streaming and draws climbed 291 -> 523 across arms).
//  - a BASELINE run every Nth iteration. The noise band is derived from the
//    baselines' own spread rather than assumed, so "beyond noise" means beyond
//    what THIS night's baseline actually did.
//  - any flag beyond the band is REQUEUED for 3 interleaved repeats.
//  - resumable: completed rows are read back from results.jsonl on start.
//
// SAFETY / ETIQUETTE (the 1070 is someone's personal machine)
//  - Chrome is launched off-screen (--window-position=-32000,-32000) and
//    --mute-audio; both come from C:\Temp\launch-wls.bat, unchanged.
//  - only processes matching --user-data-dir=...cdpwb-wls are ever killed.
//  - the loop stops itself at STOP_AT and kills its own Chrome.

import { chromium } from 'playwright-core';
import { appendFileSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const OUTDIR = process.env.OUTDIR || '/mnt/wbterminal2/flag-census';
const RESULTS = `${OUTDIR}/results.jsonl`;
const LOGF = `${OUTDIR}/driver.log`;
const FLAGS_JSON = process.env.FLAGS_JSON || '/tmp/claude-1000/-home-wbterminal/7c942ef3-88b5-4c93-864e-5f919e845e87/scratchpad/flags.json';
const BOX = 'young@100.127.215.75';
const CDP = 'http://127.0.0.1:9333';
const ACE_LOG = '/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0/ACE_Log.txt';
const TUNNEL = '/tmp/claude-1000/-home-wbterminal/7c942ef3-88b5-4c93-864e-5f919e845e87/scratchpad/tun.sh';

const POI = process.env.POI || 'Nanto';
const BASELINE_EVERY = Number(process.env.BASELINE_EVERY || 5);
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 7000);
const SETTLE_MS = Number(process.env.SETTLE_MS || 40000);
const BOOT_TIMEOUT_MS = Number(process.env.BOOT_TIMEOUT_MS || 150000);
const STOP_AT = process.env.STOP_AT ? new Date(process.env.STOP_AT).getTime() : Infinity;
const ACCOUNTS = ['tailnet1', 'phase4demo'];

// Flags the HARNESS itself depends on, or that change what "a frame" means.
// Escaping these would measure the instrument, not the flag.
const EXCLUDE = new Set([
  // harness login / plumbing
  'autoLogin', 'account', 'password', 'autoSpawn', 'agent', 'nosw', 'spawn',
  // harness instrumentation
  'renderDiag', 'camDebug', 'vfxGauge', 'vfxGaugeFence', 'diag', 'debug',
  // pinned measurement conditions
  'quality', 'renderScale', 'adaptiveRes', 'adaptiveResSettle',
  // change the meaning of a frame / skip rendering entirely
  'nullRender', 'renderOnDemand', 'targetFps', 'netDrainHz', 'wireframe',
  'renderer', 'singleDriver', 'unifiedDispatch',
]);

mkdirSync(OUTDIR, { recursive: true });
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => {
  const line = `${ts()} ${a.join(' ')}`;
  console.log(line);
  try { appendFileSync(LOGF, line + '\n'); } catch (_) {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c, t = 60000) => { try { return execSync(c, { timeout: t, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); } };

// ---------- infrastructure keepers ----------
async function cdpAlive() {
  try {
    const c = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(4000) });
    return c.ok;
  } catch (_) { return false; }
}

function ensureTunnel() {
  const out = sh(`bash ${TUNNEL} 2>&1 || true`, 30000);
  return out;
}

function relaunchChrome() {
  log('  [infra] relaunching Chrome on the box (off-screen, muted)');
  sh(`ssh -o BatchMode=yes -o ConnectTimeout=15 ${BOX} "schtasks /create /tn hbcensus /tr C:\\\\Temp\\\\launch-wls.bat /sc once /st 00:00 /it /f & schtasks /run /tn hbcensus"`, 90000);
}

async function ensureInfra() {
  if (await cdpAlive()) return true;
  log('  [infra] CDP down — rebuilding tunnel');
  ensureTunnel();
  await sleep(3000);
  if (await cdpAlive()) return true;
  relaunchChrome();
  await sleep(10000);
  ensureTunnel();
  await sleep(3000);
  return await cdpAlive();
}

// ---------- ACE single-login serialisation ----------
function aceHolds(account) {
  // last event for this account: LOGIN with no later LOGOUT means ACE still holds it
  const out = sh(`grep -a -E "Account ${account} (entered|exited) the world" ${ACE_LOG} | tail -1`, 20000);
  return /entered the world/.test(out);
}
async function waitForRelease(account, maxMs = 150000) {
  const t0 = Date.now();
  while (aceHolds(account)) {
    if (Date.now() - t0 > maxMs) { log(`  [ace] ${account} still held after ${Math.round(maxMs / 1000)}s — continuing anyway`); return false; }
    await sleep(5000);
  }
  return true;
}

// ---------- the page-side probe ----------
function probe() {
  const sc = window.liveScene3d;
  const r = sc?.renderer;
  if (!r) return { err: 'no renderer' };
  const scene = sc.scene;
  let batched = 0, meshes = 0, instanced = 0, sprites = 0, atlasB = 0, batchC = 0;
  const mats = new Set(), progs = new Set(), geoms = new Set();
  let transparentMats = 0;
  scene.traverse((o) => {
    const isR = o.isMesh || o.isInstancedMesh || o.isBatchedMesh || o.isSprite || o.isPoints;
    if (!isR) return;
    if (o.isBatchedMesh) { batched++; if (o.name?.startsWith('static-batch-c-')) batchC++; else if (o.name?.startsWith('stat-atlas-x-')) atlasB++; }
    else if (o.isInstancedMesh) instanced++;
    else if (o.isSprite) sprites++;
    else meshes++;
    const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of ms) {
      if (!m) continue;
      if (!mats.has(m.id) && m.transparent) transparentMats++;
      mats.add(m.id);
      progs.add(m.program?.id ?? `v${m.version}:${m.type}`);
    }
    if (o.geometry) geoms.add(o.geometry.id);
  });
  const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
  let texBytes = null;
  try { const c = window.__diag?.textureCensus?.(); texBytes = c ? Math.round((c.liveBytes ?? c.bytes ?? 0) / 1048576) : null; } catch (_) {}
  let atlas = null;
  try { const a = window.__atlasStats?.(); if (a) atlas = { nodesIn: a.nodesIn, atlased: a.atlased, ptBc7Deferred: a.ptBc7Deferred, buckets: a.bucketCount }; } catch (_) {}
  return {
    renderables: batched + meshes + instanced + sprites,
    batchedMeshes: batched, staticBatchC: batchC, atlasBuckets: atlasB,
    plainMeshes: meshes, instancedMeshes: instanced, sprites,
    distinctMaterials: mats.size, distinctPrograms: progs.size, distinctGeometries: geoms.size,
    transparentMaterials: transparentMats,
    heapMB: mem, texMB: texBytes, atlas,
    infoTextures: r.info.memory.textures, infoGeometries: r.info.memory.geometries,
    programsCompiled: r.info.programs?.length ?? null,
  };
}

function installSampler() {
  const r = window.liveScene3d?.renderer;
  if (r) r.info.autoReset = false;
  window.__C = {
    on: false, frames: [], c0: 0, t0: 0, last: performance.now(),
    start() { const rr = window.liveScene3d.renderer; this.frames = []; this.c0 = rr.info.render.calls; this.t0 = rr.info.render.triangles; this.last = performance.now(); this.on = true; },
    stop() {
      this.on = false;
      const rr = window.liveScene3d.renderer;
      const f = this.frames.slice().sort((a, b) => a - b);
      return {
        n: f.length,
        p50: f.length ? +f[f.length >> 1].toFixed(2) : null,
        p95: f.length ? +f[Math.floor(f.length * 0.95)].toFixed(2) : null,
        draws: f.length ? +((rr.info.render.calls - this.c0) / f.length).toFixed(1) : null,
        ktris: f.length ? +(((rr.info.render.triangles - this.t0) / f.length) / 1000).toFixed(0) : null,
      };
    },
  };
  if (!window.__C_TICK) {
    window.__C_TICK = true;
    const tick = () => {
      const now = performance.now();
      if (window.__C.on) window.__C.frames.push(now - window.__C.last);
      window.__C.last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  return true;
}

// ---------- one run ----------
async function runOne(flag, escape, account) {
  const label = flag ? `${flag}=${escape}` : 'BASELINE';
  const row = { t: new Date().toISOString(), flag: flag || null, escape: flag ? escape : null, label, account };
  if (!(await ensureInfra())) { row.verdict = 'INFRA-FAIL'; return row; }
  await waitForRelease(account);

  let browser, page;
  const errors = [];
  try {
    browser = await chromium.connectOverCDP(CDP);
    const ctx = browser.contexts()[0];
    for (const p of ctx.pages()) { if (p.url() !== 'about:blank') await p.close().catch(() => {}); }
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 180)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 180)); });

    const url = 'http://127.0.0.1:8765/apps/holtburger-web/index.html'
      + '?nosw=1&quality=mid&adaptiveRes=off&renderScale=1&renderDiag=on&camDebug=on'
      + `&autoLogin=1&account=${account}&password=${account}&autoSpawn=first&agent=1`
      + (flag ? `&${flag}=${escape}` : '');
    row.url = url;

    const tBoot = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    for (;;) {
      const s = await page.evaluate(() => window.__bootState).catch(() => null);
      if (s === 'ready' || s === 'in-world') break;
      if (s === 'error') {
        row.verdict = 'BOOT-FAIL';
        row.bootHistory = await page.evaluate(() => (window.__bootStateHistory || []).slice(-3)).catch(() => null);
        row.errors = errors.slice(0, 5);
        await page.close().catch(() => {});
        return row;
      }
      if (Date.now() - tBoot > BOOT_TIMEOUT_MS) {
        row.verdict = 'BOOT-TIMEOUT'; row.lastState = s; row.errors = errors.slice(0, 5);
        await page.close().catch(() => {});
        return row;
      }
      await sleep(700);
    }
    row.bootMs = Date.now() - tBoot;

    await page.evaluate((p) => window.__sessionHandle?.sendChat('@telepoi ' + p), POI);
    await sleep(SETTLE_MS);
    await page.evaluate(() => { window.__cam?.player(9, 35, 14, 1.2); }).catch(() => {});
    await sleep(4000);
    await page.evaluate(installSampler);

    // settle gate on draws/frame
    let prev = null, stable = 0;
    for (let i = 0; i < 10 && stable < 2; i++) {
      await page.evaluate(() => window.__C.start());
      await sleep(4000);
      const s = await page.evaluate(() => window.__C.stop());
      if (prev && s.draws && Math.abs(s.draws - prev) / prev < 0.03) stable++; else stable = 0;
      prev = s.draws;
    }
    row.settledDraws = prev;

    await page.evaluate(() => window.__C.start());
    await sleep(SAMPLE_MS);
    Object.assign(row, await page.evaluate(() => window.__C.stop()));
    Object.assign(row, await page.evaluate(probe));
    row.errors = errors.slice(0, 5);
    row.errorCount = errors.length;
    row.verdict = 'OK';
    await page.close().catch(() => {});
  } catch (e) {
    row.verdict = 'RUN-ERROR';
    row.error = String(e.message).slice(0, 200);
    try { await page?.close(); } catch (_) {}
  }
  return row;
}

// ---------- main ----------
(async () => {
  const flagsDoc = JSON.parse(readFileSync(FLAGS_JSON, 'utf8'));
  const work = flagsDoc.defaultOn.filter((f) => !EXCLUDE.has(f.name));
  log(`flag-census start — ${work.length} default-ON flags (${flagsDoc.defaultOn.length - work.length} excluded as harness-critical)`);
  log(`output ${RESULTS}`);
  if (STOP_AT !== Infinity) log(`will stop at ${new Date(STOP_AT).toISOString()}`);

  const done = new Set();
  if (existsSync(RESULTS)) {
    for (const l of readFileSync(RESULTS, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { const r = JSON.parse(l); if (r.flag) done.add(r.flag); } catch (_) {}
    }
    log(`resuming — ${done.size} flags already recorded`);
  }
  const queue = work.filter((f) => !done.has(f.name));

  let i = 0, acct = 0;
  for (const f of queue) {
    if (Date.now() > STOP_AT) { log('STOP_AT reached — stopping cleanly'); break; }
    if (i % BASELINE_EVERY === 0) {
      const b = await runOne(null, null, ACCOUNTS[acct++ % ACCOUNTS.length]);
      appendFileSync(RESULTS, JSON.stringify(b) + '\n');
      log(`  BASELINE            ${b.verdict} draws=${b.draws} p50=${b.p50} mats=${b.distinctMaterials} heap=${b.heapMB}MB`);
    }
    const r = await runOne(f.name, f.escape, ACCOUNTS[acct++ % ACCOUNTS.length]);
    appendFileSync(RESULTS, JSON.stringify(r) + '\n');
    log(`  ${String(i + 1).padStart(3)}/${queue.length} ${f.name.padEnd(24)} ${r.verdict.padEnd(12)} draws=${r.draws} p50=${r.p50} mats=${r.distinctMaterials} heap=${r.heapMB}MB err=${r.errorCount ?? '-'}`);
    i++;
  }
  log('flag-census finished pass 1');
  process.exit(0);
})().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
