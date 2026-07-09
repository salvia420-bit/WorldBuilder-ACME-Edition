// cmdInterp POST-FLIP wave — AnimationDone-route live validation vs live ACE.
// Self-launched chromium (throttle-immune — the step-5 MCP-tab trap).
//
// Leg 1 (bare defaults — cmdInterp is the flipped-ON lane):
//   queue dynamics: movementPendingMotionsDiag 0 while idle/moving (autonomous
//   echoes never enqueue) → rises during the 1708 windup chain (retail wire
//   enqueue) → drains back to 0 (completion-clock shim), while the arm-b
//   strafecast floor holds (slide continuous, no FU-A reclaims during ACE
//   casts — the documented dormant finding must NOT change).
// Leg 2 (same session): W-run + Shift-walk gait smoke (the 5.7 floor).
// Leg 3 (slideCast=off): the authentic burst arm — slide dies at the stomp,
//   stays dead, single tap revives (the strafecast floor survives the seam
//   swap).
import pw from '/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core/index.js';
import fs from 'node:fs';
const { chromium } = pw;
const CHROME = '/home/wbterminal/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const OUT = '/home/wbterminal/.claude/jobs/333ff13e/tmp/postflip-legs.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const results = {};

const b = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
    '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--window-size=1280,720'],
});
const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
page.setDefaultTimeout(150000);
const errors = [];
const clines = [];
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') errors.push(t.slice(0, 180));
  if (/cmdInterp|\[jump\]/.test(t)) clines.push(t.slice(0, 140));
});

const BASE = 'http://127.0.0.1:8765/apps/holtburger-web/index.html';
const COMMON = 'nosw=1&nullRender=1&renderOnDemand=1&netDrainHz=30&renderer=3d&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=%2BTester2&agent=1';

async function login(extra, label) {
  errors.length = 0; clines.length = 0;
  await page.goto(`${BASE}?${COMMON}${extra}`, { waitUntil: 'commit', timeout: 60000 });
  for (let i = 0; i < 90; i++) {
    // Bug-11 gate (index.html:9284-9332): the wire-agent boot fires
    // in-world -> ready within ~90ms, so scan __bootStateHistory for the
    // in-world transition instead of sampling the current state.
    const s = await page.evaluate(() => ({
      b: window.__bootState,
      g: typeof window.getLocalPlayerGuid === 'function' ? window.getLocalPlayerGuid() : null,
      hist: Array.isArray(window.__bootStateHistory) && window.__bootStateHistory.some((e) => e && e.state === 'in-world'),
    })).catch((e) => ({ err: String(e).slice(0, 100) }));
    if (i % 8 === 0 || (s && s.err)) log(`[${label}] poll${i}`, JSON.stringify(s));
    if (s && s.g && (s.b === 'in-world' || s.hist)) { log(`[${label}] in-world (state=${s.b})`); return true; }
    await sleep(1500);
  }
  log(`[${label}] BOOT TIMEOUT`);
  return false;
}
const drop = async () => { await page.goto('about:blank').catch(() => {}); };

const LEGFN = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const key = (type, k) => document.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true }));
  const pose = () => { const p = window.__sessionHandle.getLocalPlayerPose(); const o = { x: p.x, y: p.y, z: p.z }; try { p.free(); } catch {} return o; };
  const guid = window.getLocalPlayerGuid() >>> 0;
  const pendFn = (window.__hbWasm && window.__hbWasm.movementPendingMotionsDiag)
    || (window.__hbWasmNs && window.__hbWasmNs.movementPendingMotionsDiag) || null;
  const pend = () => { try { return pendFn ? (pendFn() | 0) : -1; } catch { return -2; } };
`;

// ---------- Legs 1+2: bare flipped defaults, ONE session ----------
if (await login('', 'leg1-defaults')) {
  await sleep(5000); // session hydration settle
  results.leg1_queue = await page.evaluate(`(async () => { ${LEGFN}
    const hasDiag = !!pendFn;
    // ACE rejects casts outside Magic stance (Player_Magic.cs:84 —
    // fresh logins are NonCombat/Undef): toggle first, let the stance
    // echo land.
    window.__sessionHandle.toggleCombatMode(); await sleep(1800);
    const idlePend = pend();
    const r0 = window.__cmdInterpReclaims | 0;
    // Held strafe alone: autonomous echoes must NOT enqueue.
    key('keydown', 'a'); await sleep(700);
    const movingPend = pend();
    window.__sessionHandle.castTargetedSpell(guid, 1708);
    const speeds = [], pends = [];
    let prev = pose(); let prevT = performance.now(); const t0 = prevT;
    while (performance.now() - t0 < 14000) {
      await sleep(200);
      const p = pose(); const t = performance.now();
      speeds.push(+((Math.hypot(p.x - prev.x, p.y - prev.y)) / ((t - prevT) / 1000)).toFixed(2));
      pends.push(pend());
      prev = p; prevT = t;
    }
    key('keyup', 'a'); await sleep(400);
    const tailPend = pend();
    let dead = 0, run = 0; for (const s of speeds) { run = s < 0.25 ? run + 1 : 0; dead = Math.max(dead, run); }
    return { hasDiag, idlePend, movingPend, maxPend: Math.max(...pends), tailPend,
             pends, speeds, longestDead: dead,
             reclaimDelta: (window.__cmdInterpReclaims | 0) - r0 };
  })()`);
  log('leg1_queue', JSON.stringify(results.leg1_queue).slice(0, 420));

  results.leg2_gait = await page.evaluate(`(async () => { ${LEGFN}
    await sleep(800);
    const pA = pose();
    key('keydown', 'w'); await sleep(2200); key('keyup', 'w');
    await sleep(250); const pB = pose();
    const runM = +Math.hypot(pB.x - pA.x, pB.y - pA.y).toFixed(2);
    await sleep(600);
    const pC = pose();
    key('keydown', 'Shift'); await sleep(120); key('keydown', 'w');
    await sleep(1600);
    key('keyup', 'w'); key('keyup', 'Shift');
    await sleep(250); const pD = pose();
    const walkM = +Math.hypot(pD.x - pC.x, pD.y - pC.y).toFixed(2);
    return { runM, walkM, runSpeed: +(runM / 2.2).toFixed(2), walkSpeed: +(walkM / 1.6).toFixed(2) };
  })()`);
  log('leg2_gait', JSON.stringify(results.leg2_gait));
  results.leg12_errors = errors.slice(0, 6);
  results.leg12_console = clines.slice(0, 10);
  await drop();
}

log('ghost-wait 200s (LOGOUT lands ~60s after drop; +95s ghost after THAT)');
await sleep(200000);

// ---------- Leg 3: burst arm (slideCast=off) ----------
if (await login('&slideCast=off', 'leg3-burst')) {
  await sleep(5000);
  results.leg3_burst = await page.evaluate(`(async () => { ${LEGFN}
    window.__sessionHandle.toggleCombatMode(); await sleep(1800);
    const r0 = window.__cmdInterpReclaims | 0;
    key('keydown', 'a'); await sleep(700);
    window.__sessionHandle.castTargetedSpell(guid, 1708);
    const speeds = [], pends = [];
    let prev = pose(); let prevT = performance.now(); const t0 = prevT;
    let tapped = false, tapAt = -1;
    while (performance.now() - t0 < 9000) {
      await sleep(250);
      if (!tapped && performance.now() - t0 > 3000) { key('keydown', 'e'); await sleep(90); key('keyup', 'e'); tapped = true; tapAt = speeds.length; }
      const p = pose(); const t = performance.now();
      speeds.push(+((Math.hypot(p.x - prev.x, p.y - prev.y)) / ((t - prevT) / 1000)).toFixed(2));
      pends.push(pend());
      prev = p; prevT = t;
    }
    key('keyup', 'a'); await sleep(300);
    const preTap = speeds.slice(0, tapAt);
    const postTap = speeds.slice(tapAt + 1, tapAt + 6);
    return { speeds, pends, tapAt,
             deadPreTap: preTap.filter((s) => s < 0.25).length, preTapLen: preTap.length,
             revived: postTap.some((s) => s > 1.0),
             maxPend: Math.max(...pends),
             reclaimDelta: (window.__cmdInterpReclaims | 0) - r0 };
  })()`);
  log('leg3_burst', JSON.stringify(results.leg3_burst).slice(0, 420));
  results.leg3_errors = errors.slice(0, 6);
  results.leg3_console = clines.slice(0, 10);
  await drop();
}

fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
log('RESULTS WRITTEN', OUT);
await b.close();
process.exit(0);
