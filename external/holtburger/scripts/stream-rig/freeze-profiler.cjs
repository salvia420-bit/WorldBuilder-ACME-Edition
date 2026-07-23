#!/usr/bin/env node
/*
 * Freeze-profiler — catches the recurring main-thread hot-loop red-handed.
 *
 * A CDP CPU sampling profiler runs continuously on the game renderer. When the
 * main thread stops responding (the freeze), the profiler has been sampling the
 * spinning stack — we Profiler.stop FAST (before v2's ~16s auto-recover SIGKILLs
 * the browser) and dump the hottest functions by self-time = the loop culprit,
 * with file:line. Read-only; exits after catching one freeze. Writes the top
 * findings to comprehension-monitor.log (surfaced by the Monitor) + a full
 * profile to /mnt/wbterminal2/stream/freeze-profile.json.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const CDP = 'http://127.0.0.1:9223';
const LOG = '/mnt/wbterminal2/stream/comprehension-monitor.log';
const OUT = '/mnt/wbterminal2/stream/freeze-profile.json';
const POLL_MS = 2000, EVAL_TIMEOUT_MS = 2500;
const iso = () => new Date().toISOString();
const emit = (m) => { try { fs.appendFileSync(LOG, `${iso()} ${m}\n`); } catch {} process.stdout.write(`${iso()} ${m}\n`); };

function topSelf(profile) {
  // nodes[].hitCount = self-samples for that function. Sum per callFrame key.
  const byFn = new Map();
  for (const n of profile.nodes || []) {
    const c = n.callFrame || {};
    const key = `${c.functionName || '(anon)'} @ ${(c.url||'').replace(/^https?:\/\/[^/]+/,'')}:${(c.lineNumber||0)+1}`;
    byFn.set(key, (byFn.get(key) || 0) + (n.hitCount || 0));
  }
  return [...byFn.entries()].filter(([,h])=>h>0).sort((a,b)=>b[1]-a[1]).slice(0, 12);
}

async function run() {
  emit('🔬 freeze-profiler armed — CPU sampler running; will dump the hot-loop stack on the next freeze');
  let browser, page, cdp;
  const connect = async () => {
    browser = await chromium.connectOverCDP(CDP);
    page = browser.contexts()[0].pages().find(p => p.url().includes('holtburger-web/index.html'));
    if (!page) throw new Error('no game page');
    cdp = await browser.contexts()[0].newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); // 200us
    await cdp.send('Profiler.start');
  };
  while (true) {
    try { await connect(); break; }
    catch (e) { await new Promise(r=>setTimeout(r,4000)); }
  }
  while (true) {
    let frozen = false;
    try {
      await Promise.race([
        page.evaluate('Date.now()'),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error('t')), EVAL_TIMEOUT_MS)),
      ]);
    } catch { frozen = true; }
    if (frozen) {
      // confirm once more quickly to avoid a transient GC pause false-positive
      try { await Promise.race([page.evaluate('1'), new Promise((_,r)=>setTimeout(()=>r(new Error('t')),1500))]); frozen = false; } catch { frozen = true; }
    }
    if (frozen) {
      emit('🔬 FREEZE detected — stopping profiler + dumping hot stack (racing v2 auto-recover)...');
      try {
        const { profile } = await cdp.send('Profiler.stop');
        fs.writeFileSync(OUT, JSON.stringify(profile));
        const top = topSelf(profile);
        emit('🔬 HOT-LOOP culprits (self-time samples, most→least):');
        for (const [fn, hits] of top) emit(`     ${hits}  ${fn}`);
        emit(`🔬 full profile → ${OUT} (samples=${(profile.samples||[]).length})`);
      } catch (e) {
        emit(`🔬 profiler dump FAILED (${e.message}) — browser likely already killed by auto-recover; will re-arm`);
        // browser gone — reconnect and re-arm for the next freeze
        try { await browser.close(); } catch {}
        while (true) { try { await connect(); break; } catch { await new Promise(r=>setTimeout(r,4000)); } }
        continue;
      }
      emit('🔬 freeze-profiler done — caught one. (re-run to catch another)');
      return;
    }
    await new Promise(r=>setTimeout(r, POLL_MS));
  }
}
run().catch(e => { emit(`🔬 freeze-profiler crashed: ${e.message}`); process.exit(1); });
