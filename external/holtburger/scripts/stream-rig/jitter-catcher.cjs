#!/usr/bin/env node
/*
 * Jitter-catcher — high-frequency companion to the comprehension monitor.
 *
 * The bot intermittently "moves and jitters while stuck in one spot" during
 * OUTDOOR gotos: the character shuffles/oscillates but makes little net
 * progress. The 30s-cadence comprehension monitor's NOT-MOVING gate can't see
 * this (pose IS changing, just not progressing, and the episode is short). This
 * samples pose+router at ~5 Hz and flags a jitter episode = a rolling window
 * where the mover is WALKing outdoors but path length >> net displacement (it
 * moved a lot, went nowhere) or the heading reverses repeatedly. On a catch it
 * dumps the full pose trace so the cause is diagnosable, then re-arms.
 *
 * Emits into the same log the comprehension Monitor tails, so catches surface
 * as notifications. Read-only; never drives the bot.
 */
const { chromium } = require('playwright');
const fs = require('fs');

const CDP = 'http://127.0.0.1:9223';
const LOG = '/mnt/wbterminal2/stream/comprehension-monitor.log';
const TICK_MS   = 200;     // ~5 Hz
const WIN       = 14;      // rolling window (~2.8s)
const MIN_PATH  = 2.0;     // yards of accumulated movement to consider "active"
const MAX_NET   = 1.2;     // ... but net displacement under this = not progressing
const MIN_REV   = 4;       // OR this many >90° heading reversals in the window
const REALERT_MS = 20000;  // don't re-alert the same ongoing episode faster than this
const MOVE_EPS    = 0.08;   // yd/tick above which the mover counts as "moving"
const MOVE_WIN_MS = 300000; // 5-min rolling window for the moving% utilization metric
const REPORT_MS   = 60000;  // emit the moving% report this often (goal: 100% moving)

const iso = () => new Date().toISOString();
const emit = (m) => { const line = `${iso()} ${m}\n`; try { fs.appendFileSync(LOG, line); } catch {} process.stdout.write(line); };

let win = [];            // {t,x,y,walk,outdoor}
let lastAlert = 0;
let connectWarned = false;
let moveWin = [];        // {t,moved,walk} rolling window for the moving% metric
let prevPose = null;
let lastReport = 0;

function analyze() {
  // consider only the contiguous recent WALK+outdoor stretch
  const active = win.filter(s => s.walk && s.outdoor);
  if (active.length < WIN * 0.6) return null;
  let path = 0, revs = 0;
  for (let i = 1; i < active.length; i++) {
    const dx = active[i].x - active[i-1].x, dy = active[i].y - active[i-1].y;
    path += Math.hypot(dx, dy);
    if (i >= 2) {
      const px = active[i-1].x - active[i-2].x, py = active[i-1].y - active[i-2].y;
      const dot = dx*px + dy*py, m1 = Math.hypot(dx,dy), m2 = Math.hypot(px,py);
      if (m1 > 0.05 && m2 > 0.05 && dot/(m1*m2) < 0) revs++;   // >90° reversal
    }
  }
  const a = active[0], b = active[active.length-1];
  const net = Math.hypot(b.x - a.x, b.y - a.y);
  const jitter = (path >= MIN_PATH && net <= MAX_NET) || revs >= MIN_REV;
  return jitter ? { path:+path.toFixed(2), net:+net.toFixed(2), revs, span:((b.t-a.t)/1000).toFixed(1),
                    n:active.length, x:+b.x.toFixed(1), y:+b.y.toFixed(1) } : null;
}

async function loop() {
  emit('🎯 jitter-catcher online — ~5Hz watch for outdoor goto jitter (path≫net / heading reversals)');
  let browser = null, page = null;
  while (true) {
    if (!browser || !page || page.isClosed()) {
      try {
        if (browser) { try { await browser.close(); } catch {} }
        browser = await chromium.connectOverCDP(CDP);
        page = browser.contexts()[0].pages().find(p => p.url().includes('holtburger-web/index.html'));
        if (!page) throw new Error('no game page');
        connectWarned = false; win = [];
      } catch (e) {
        if (!connectWarned) { emit(`   jitter-catcher waiting for page (${e.message})`); connectWarned = true; }
        await new Promise(r => setTimeout(r, 4000)); continue;
      }
    }
    let s;
    try {
      s = await Promise.race([
        page.evaluate(() => {
          const p = window.__sessionHandle?.getLocalPlayerPose?.();
          if (!p) return null;
          const x = p.x, y = p.y, lb = (p.landblockId >>> 0); p.free && p.free();
          const r = window.__bot?.router;
          const plan = (window.__bot?.ai?.director?._lastSummary || '').replace(/\s+/g,' ').slice(0,60);
          return { x, y, lb, walk: r?.state === 'WALK', outdoor: (lb & 0xFFFF) < 0x0100,
                   rstate: r?.state, leg: r?.leg, legs: r?.route?.length, plan };
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('eval-timeout')), 4000)),
      ]);
    } catch { page = null; await new Promise(r => setTimeout(r, TICK_MS)); continue; }

    if (s) {
      // movement utilization (goal: 100% moving). Classify each tick as moving
      // (real translation) vs idle (standing / director-thinking) vs wedged
      // (router WALK but pose not advancing = the wall-grind waste).
      if (prevPose) {
        const moved = Math.hypot(s.x - prevPose.x, s.y - prevPose.y) > MOVE_EPS;
        moveWin.push({ t: Date.now(), moved, walk: s.walk });
        const cut = Date.now() - MOVE_WIN_MS;
        while (moveWin.length && moveWin[0].t < cut) moveWin.shift();
      }
      prevPose = { x: s.x, y: s.y };
      if (moveWin.length >= 30 && (Date.now() - lastReport) > REPORT_MS) {
        lastReport = Date.now();
        const tot = moveWin.length;
        const mv = moveWin.filter(m => m.moved).length;
        const wedged = moveWin.filter(m => !m.moved && m.walk).length; // WALK, not advancing
        const idle = tot - mv - wedged;                                // standing / director-wait
        const pct = n => Math.round(100 * n / tot);
        emit(`🏃 MOVING ${pct(mv)}% (goal 100%) over ${(tot*TICK_MS/60000).toFixed(1)}min `
           + `— idle ${pct(idle)}% (director-wait/standing), wedged ${pct(wedged)}% (WALK-not-progressing)`);
      }
      win.push({ t: Date.now(), x: s.x, y: s.y, walk: s.walk, outdoor: s.outdoor });
      if (win.length > WIN) win.shift();
      if (win.length === WIN) {
        const j = analyze();
        if (j && (Date.now() - lastAlert) > REALERT_MS) {
          lastAlert = Date.now();
          emit(`🌀 JITTER (outdoor goto) — moved ${j.path}yd of path but only ${j.net}yd net over ${j.span}s `
             + `(${j.revs} heading reversals, ${j.n} samples) at (${j.x},${j.y}) leg ${s.leg}/${s.legs} `
             + `router=${s.rstate} | plan: ${s.plan}`);
        }
      }
    }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}
loop().catch(e => { emit(`💥 jitter-catcher crashed: ${e.message}`); process.exit(1); });
