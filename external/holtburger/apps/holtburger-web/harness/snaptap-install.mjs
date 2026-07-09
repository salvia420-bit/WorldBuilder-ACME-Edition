// Attach to the USER'S capture chrome (CDP :9334 via tunnel), wait in-world,
// probe surfaces, install the passive snapback tap. NEVER closes their page or
// browser — exits without close() so chrome lives on.
import pw from '/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core/index.js';
const { chromium } = pw;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const pages = browser.contexts().flatMap((c) => c.pages());
const page = pages.find((p) => p.url().includes('/apps/holtburger-web/index.html'));
if (!page) { log('NO GAME PAGE. urls:', pages.map((p) => p.url().slice(0, 90))); process.exit(2); }
log('page:', page.url().slice(0, 140));

for (let i = 0; i < 60; i++) {
  const s = await page.evaluate(() => ({
    b: window.__bootState,
    hist: Array.isArray(window.__bootStateHistory) && window.__bootStateHistory.some((e) => e && e.state === 'in-world'),
    g: typeof window.getLocalPlayerGuid === 'function' ? window.getLocalPlayerGuid() : null,
  })).catch(() => null);
  if (s && s.g && (s.b === 'in-world' || s.hist)) { log('in-world, state=', s.b); break; }
  if (i === 59) { log('NOT in-world after 90s, state=', JSON.stringify(s)); process.exit(3); }
  await sleep(1500);
}

const probe = await page.evaluate(() => {
  let wireShape = null;
  try { const w = window.__diag?.wire?.summary?.(); wireShape = w ? JSON.stringify(w).slice(0, 380) : 'null'; } catch (e) { wireShape = 'ERR ' + String(e).slice(0, 80); }
  return {
    hasDiag: !!(window.__hbWasm && typeof window.__hbWasm.movementPendingMotionsDiag === 'function'),
    hasSnapDiag: !!(window.__hbWasmNs?.localPoseSnapDiag || window.__hbWasm?.localPoseSnapDiag),
    hasLeashDiag: !!(window.__hbWasmNs?.leashEchoDiag || window.__hbWasm?.leashEchoDiag),
    reclaims: window.__cmdInterpReclaims | 0,
    wireShape,
  };
});
log('probe:', JSON.stringify(probe));

const installed = await page.evaluate(() => {
  // Round-3 freshness: the leash-gate build must be loaded, not just
  // the round-2 one (leashEchoDiag is the newest export).
  const fresh = !!(window.__hbWasm && typeof window.__hbWasm.leashEchoDiag === 'function');
  if (!fresh) return 'stale-page-awaiting-reload';
  if (window.__snapTap) return 'already-installed';
  const T = (window.__snapTap = {
    wall0: Date.now(), t0: performance.now(),
    samples: [], snaps: [], wires: [], max: 7200,
  });
  const pend = () => { try { return window.__hbWasm?.movementPendingMotionsDiag ? window.__hbWasm.movementPendingMotionsDiag() | 0 : -1; } catch { return -2; } };
  const wire = () => { try { const w = window.__diag?.wire?.summary?.(); return w ? JSON.stringify(w) : null; } catch { return null; } };
  const snapDiagFn = window.__hbWasm?.localPoseSnapDiag || window.__hbWasmNs?.localPoseSnapDiag || null;
  const causeFn = window.__hbWasm?.reclaimCauseDiag || window.__hbWasmNs?.reclaimCauseDiag || null;
  const leashFn = window.__hbWasm?.leashEchoDiag || window.__hbWasmNs?.leashEchoDiag || null;
  const snapDiag = () => { try { return snapDiagFn ? String(snapDiagFn()) : ''; } catch { return 'E'; } };
  const cause = () => { try { return causeFn ? causeFn() >>> 0 : 0; } catch { return 0; } };
  const leash = () => { try { return leashFn ? String(leashFn()) : ''; } catch { return 'E'; } };
  T.iv = setInterval(() => {
    try {
      const p = window.__sessionHandle.getLocalPlayerPose();
      const s = { t: Math.round(performance.now() - T.t0), x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3), pd: pend(), rc: window.__cmdInterpReclaims | 0, sd: snapDiag(), cz: cause(), le: leash() };
      try { p.free(); } catch {}
      const n = T.samples.length;
      if (n) {
        const q = T.samples[n - 1];
        const dt = Math.max(1, s.t - q.t) / 1000;
        const d = Math.hypot(s.x - q.x, s.y - q.y);
        s.v = +(d / dt).toFixed(2);
        if (n >= 3) {
          const r = T.samples[n - 3];
          const fwdx = q.x - r.x, fwdy = q.y - r.y;
          const stepx = s.x - q.x, stepy = s.y - q.y;
          const dot = fwdx * stepx + fwdy * stepy;
          // Backward jump against recent travel, or any large teleport-ish step.
          if ((d > 0.55 && dot < 0 && Math.hypot(fwdx, fwdy) > 0.15) || d > 3.5) {
            T.snaps.push({ t: s.t, wall: Date.now(), d: +d.toFixed(2), dot: +dot.toFixed(2), wire: wire() });
            if (T.snaps.length > 80) T.snaps.shift();
          }
        }
      }
      T.samples.push(s);
      if (T.samples.length > T.max) T.samples.shift();
    } catch (_) {}
  }, 125);
  T.wiv = setInterval(() => {
    const w = wire();
    if (w) { T.wires.push({ t: Math.round(performance.now() - T.t0), w }); if (T.wires.length > 900) T.wires.shift(); }
  }, 1000);
  return 'installed wall0=' + T.wall0;
});
log('tap:', installed);
log('DONE — exiting WITHOUT closing anything');
process.exit(0);
