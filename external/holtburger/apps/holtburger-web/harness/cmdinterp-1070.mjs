// cmdInterp step-5 batched 1070 A/B — three arms + P15 sequences, MODE2i CDP.
// Drives the 1070's interactive-session Chrome (:9333 tunnel); serve.py is
// reached box-side via the 18765 reverse tunnel. NEVER closes the shared
// browser — only its own pages. Screenshots + JSON verdict land in OUT.
import pw from '/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core/index.js';
import fs from 'node:fs';
const { chromium } = pw;

const OUT = '/home/wbterminal/.claude/jobs/333ff13e/tmp/ab1070';
fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://127.0.0.1:18765/apps/holtburger-web/index.html';
const COMMON = 'nosw=1&renderer=3d&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=%2BTester2&agent=1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const results = {};

const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
const ctx = b.contexts()[0] ?? (await b.newContext());

async function boot(extra, label) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);
  const errors = [];
  const lines = [];
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') errors.push(t.slice(0, 200));
    if (/cmdInterp|\[jump\]/i.test(t)) lines.push(t.slice(0, 160));
  });
  const url = `${BASE}?${COMMON}${extra}`;
  log(`[${label}] goto ${extra || '(bare)'}`);
  await page.goto(url, { waitUntil: 'commit', timeout: 90000 });
  let bootState = null;
  for (let i = 0; i < 75; i++) {
    bootState = await page.evaluate(() => window.__bootState).catch(() => null);
    if (bootState === 'in-world' || bootState === 'ready') break;
    await sleep(2000);
  }
  let meshes = 0;
  for (let i = 0; i < 40; i++) {
    meshes = await page
      .evaluate(() => {
        const s = window.liveScene3d?.scene;
        if (!s) return 0;
        let n = 0;
        s.traverse((o) => { if (o.isMesh) n++; });
        return n;
      })
      .catch(() => 0);
    if (meshes > 100) break;
    await sleep(2000);
  }
  log(`[${label}] boot=${bootState} meshes=${meshes}`);
  return { page, errors, lines, bootState, meshes };
}

const shot = async (page, name) => {
  try { await page.screenshot({ path: `${OUT}/${name}.png` }); log('shot', name); } catch (e) { log('shot-fail', name, String(e).slice(0, 80)); }
};

// One leg body runs INSIDE the page as a single evaluate (bot lore: no gaps).
const KEYFN = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const key = (type, k) => document.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true }));
  const pose = () => { const p = window.__sessionHandle.getLocalPlayerPose(); const o = { x: p.x, y: p.y, z: p.z }; try { p.free(); } catch {} return o; };
  const guid = window.getLocalPlayerGuid() >>> 0;
`;

async function armA() {
  const { page, errors, lines, bootState, meshes } = await boot('', 'arm-a');
  const gl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const g = c.getContext('webgl2') || c.getContext('webgl');
    const ext = g.getExtension('WEBGL_debug_renderer_info');
    return ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER);
  }).catch((e) => String(e));
  log('[arm-a] GPU =', gl);
  await shot(page, 'arm-a-01-spawn');
  const r = await page.evaluate(`(async () => { ${KEYFN}
    key('keydown', 'a'); await sleep(700);
    const p0 = pose();
    window.__sessionHandle.castTargetedSpell(guid, 1708);
    const samples = []; let prev = pose(); let prevT = performance.now(); const t0 = prevT;
    while (performance.now() - t0 < 8500) {
      await sleep(250);
      const p = pose(); const t = performance.now();
      samples.push(+((Math.hypot(p.x - prev.x, p.y - prev.y)) / ((t - prevT) / 1000)).toFixed(2));
      prev = p; prevT = t;
    }
    key('keyup', 'a');
    let dead = 0, run = 0; for (const s of samples) { run = s < 0.25 ? run + 1 : 0; dead = Math.max(dead, run); }
    return { samples, longestDeadSamples: dead };
  })()`);
  await shot(page, 'arm-a-02-postcast');
  results.armA = { gl, bootState, meshes, errors: errors.slice(0, 5), errorCount: errors.length, ...r };
  await page.goto('about:blank').catch(() => {});
  await page.close().catch(() => {});
}

async function armB() {
  const { page, errors, lines, bootState, meshes } = await boot('&cmdInterp=on', 'arm-b');
  await shot(page, 'arm-b-01-spawn');
  // Instrument cut-count + Q5. Local-legs findings: gesture ids ride the
  // CAST-SEQUENCE lane (playCastSequence), NOT em.setMotion; setMotion
  // doubles as the kind-61 DriveApplied liveness probe (Ready/walk/run
  // base clips per edge). _castBusyUntilMs never arms under headless
  // castTargetedSpell — capture it anyway on the real-GPU arm.
  await page.evaluate(() => {
    const em = window.liveScene3d?.entityManager;
    window.__cutCount = 0; window.__motionLog = []; window.__castSeqLog = [];
    if (em) {
      const origCut = em.cancelCastSequence?.bind(em);
      if (origCut) em.cancelCastSequence = (g) => { window.__cutCount++; return origCut(g); };
      const origSet = em.setMotion?.bind(em);
      if (origSet) em.setMotion = (g, m, s) => { window.__motionLog.push(m >>> 0); return origSet(g, m, s); };
      const origCast = em.playCastSequence?.bind(em);
      if (origCast) em.playCastSequence = (g, sp) => { window.__castSeqLog.push(sp >>> 0); return origCast(g, sp); };
    }
  });
  // Smoke: walk forward + jump.
  const smoke = await page.evaluate(`(async () => { ${KEYFN}
    const smi0 = window.__smiCallCount | 0;
    const p0 = pose(); key('keydown', 'w'); await sleep(2200); key('keyup', 'w'); await sleep(300);
    const p1 = pose();
    key('keydown', ' '); await sleep(350); key('keyup', ' '); await sleep(900);
    const p2 = pose();
    return { fwdM: +Math.hypot(p1.x - p0.x, p1.y - p0.y).toFixed(2), smiDelta: (window.__smiCallCount | 0) - smi0,
             zAfterJump: +(p2.z - p1.z).toFixed(2), reclaims: window.__cmdInterpReclaims | 0 };
  })()`);
  await shot(page, 'arm-b-02-postjump');
  // Strafecast + Q3 turn-tap mid-cast.
  const cast1 = await page.evaluate(`(async () => { ${KEYFN}
    key('keydown', 'a'); await sleep(700);
    window.__sessionHandle.castTargetedSpell(guid, 1708);
    const samples = []; let prev = pose(); let prevT = performance.now(); const t0 = prevT;
    let tapped = false;
    while (performance.now() - t0 < 9000) {
      await sleep(250);
      if (!tapped && performance.now() - t0 > 2500) { key('keydown', 'e'); await sleep(90); key('keyup', 'e'); tapped = true; }
      const p = pose(); const t = performance.now();
      samples.push(+((Math.hypot(p.x - prev.x, p.y - prev.y)) / ((t - prevT) / 1000)).toFixed(2));
      prev = p; prevT = t;
    }
    key('keyup', 'a');
    let dead = 0, run = 0; for (const s of samples) { run = s < 0.25 ? run + 1 : 0; dead = Math.max(dead, run); }
    const em2 = window.liveScene3d?.entityManager;
    const inst2 = em2?.entityMap?.get?.(guid);
    return { samples, longestDeadSamples: dead, reclaims: window.__cmdInterpReclaims | 0,
             cutCount: window.__cutCount | 0,
             castSeqSpells: [...new Set(window.__castSeqLog)],
             castBusyMsLeft: inst2?._castBusyUntilMs ? Math.round(inst2._castBusyUntilMs - performance.now()) : null,
             motionIdsDuringCast: [...new Set(window.__motionLog.map((m) => '0x' + m.toString(16)))].slice(-14) };
  })()`);
  await shot(page, 'arm-b-03-postcast');
  // P15 Sequence F: silent release cascade under the cast, slide survives on d.
  const seqF = await page.evaluate(`(async () => { ${KEYFN}
    for (const k of ['d', 'q', 's', 'w']) { key('keydown', k); await sleep(60); }
    await sleep(400);
    window.__sessionHandle.castTargetedSpell(guid, 1708);
    await sleep(1000);
    const r0 = window.__cmdInterpReclaims | 0;
    key('keyup', 'w'); key('keyup', 's'); key('keyup', 'q'); // the SILENT cascade
    const pA = pose(); await sleep(1200); const pB = pose();
    const slideSurvivedM = +Math.hypot(pB.x - pA.x, pB.y - pA.y).toFixed(2);
    key('keydown', 'e'); await sleep(90); key('keyup', 'e'); // reclaim tap
    await sleep(500);
    key('keydown', 's'); await sleep(600); const pC = pose(); key('keyup', 's'); key('keyup', 'd');
    return { slideSurvivedM, reclaimDelta: (window.__cmdInterpReclaims | 0) - r0,
             backOwnedM: +Math.hypot(pC.x - pB.x, pC.y - pB.y).toFixed(2) };
  })()`);
  await shot(page, 'arm-b-04-seqF');
  results.armB = { bootState, meshes, errors: errors.slice(0, 5), errorCount: errors.length,
                   consoleCmdInterp: lines.slice(0, 12), smoke, cast1, seqF };
  await page.goto('about:blank').catch(() => {});
  await page.close().catch(() => {});
}

async function armC() {
  const { page, errors, lines, bootState, meshes } = await boot('&cmdInterp=on&slideCast=off', 'arm-c');
  await shot(page, 'arm-c-01-spawn');
  const burst = await page.evaluate(`(async () => { ${KEYFN}
    key('keydown', 'a'); await sleep(700);
    window.__sessionHandle.castTargetedSpell(guid, 1708);
    const samples = []; let prev = pose(); let prevT = performance.now(); const t0 = prevT;
    let tapAt = -1;
    while (performance.now() - t0 < 10000) {
      await sleep(250);
      // Tap INTO the dead window (the bare stomp kills the slide within
      // ~0.5-3 s of cast start; the mistimed 2.5 s tap missed it once).
      if (tapAt < 0 && performance.now() - t0 > 5000) { key('keydown', 'e'); await sleep(90); key('keyup', 'e'); tapAt = samples.length; }
      const p = pose(); const t = performance.now();
      samples.push(+((Math.hypot(p.x - prev.x, p.y - prev.y)) / ((t - prevT) / 1000)).toFixed(2));
      prev = p; prevT = t;
    }
    key('keyup', 'a');
    const preTap = samples.slice(0, tapAt);
    const postTap = samples.slice(tapAt + 1, tapAt + 6);
    return { samples, tapAt,
             deadBeforeTap: preTap.filter((s) => s < 0.25).length,
             preTapLen: preTap.length,
             revivedAfterTap: postTap.some((s) => s > 1.0),
             reclaims: window.__cmdInterpReclaims | 0 };
  })()`);
  await shot(page, 'arm-c-02-burst');
  results.armC = { bootState, meshes, errors: errors.slice(0, 5), errorCount: errors.length,
                   consoleCmdInterp: lines.slice(0, 8), burst };
  await page.goto('about:blank').catch(() => {});
  await page.close().catch(() => {});
}

try {
  log('initial ghost-wait 90s (a local-leg session may have just dropped)');
  await sleep(90000);
  await armA();
  log('ghost-wait 100s');
  await sleep(100000);
  await armB();
  log('ghost-wait 100s');
  await sleep(100000);
  await armC();
} finally {
  fs.writeFileSync(`${OUT}/verdict.json`, JSON.stringify(results, null, 2));
  log('VERDICT WRITTEN', `${OUT}/verdict.json`);
}
process.exit(0);
