// loaf-stalls.eval.js — page-side body of an async fn (`node hbsess.mjs eval loaf-stalls.eval.js`),
// 2026-10-29, batch RC: attribute the multi-second frames the RC-BENCH defaults arm showed on the 1070.
// 20 s still + 20 s orbit (window.__hbOrbit from hbsess boot; window.__loafSec overrides each half),
// a PerformanceObserver on 'long-animation-frame' (Chrome's LoAF: per long frame, the scripts that ran,
// their source URL / function / char position, duration, forced style+layout) and rAF frame times.
// Returns every frame >= 100 ms with its scripts, a per-script total over all long frames, and the
// frame-time summary. Changes nothing on the page but the camera (released at the end).
const half = (window.__loafSec || 20) * 1000;
const long = [];
let obs = null;
try {
  obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (long.length >= 400) break;
      long.push({
        t: Math.round(e.startTime), dur: Math.round(e.duration), blocking: Math.round(e.blockingDuration || 0),
        render: Math.round((e.renderStart ? e.startTime + e.duration - e.renderStart : 0)),
        styleLayout: Math.round(e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0),
        scripts: (e.scripts || []).map((s) => ({ dur: Math.round(s.duration), forced: Math.round(s.forcedStyleAndLayoutDuration || 0),
          inv: s.invoker, type: s.invokerType, fn: s.sourceFunctionName, url: (s.sourceURL || "").replace(/^.*\/apps\/holtburger-web\//, ""), pos: s.sourceCharPosition })),
      });
    }
  });
  obs.observe({ type: "long-animation-frame", buffered: false });
} catch (e) { return { error: "no LoAF: " + String(e) }; }
const frames = [];
const o = window.__hbOrbit;
const run = (ms, orbit) => new Promise((res) => {
  let last = null; const t0 = performance.now();
  const f = (now) => {
    if (last !== null) frames.push([Math.round(now - last), orbit ? 1 : 0, Math.round(now)]);
    last = now;
    if (orbit && o) window.__cam.orbit(o.x, o.y, o.z, o.dist, o.az + (now - t0) / 1000 * o.degPerSec, o.el);
    if (now - t0 >= ms) return res();
    requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
});
if (o) window.__cam.orbit(o.x, o.y, o.z, o.dist, o.az, o.el);
await run(half, false);
await run(half, true);
await new Promise((r) => setTimeout(r, 500));
obs.disconnect();
const byScript = new Map();
for (const lf of long) for (const s of lf.scripts) {
  const k = `${s.url}:${s.fn || "?"}@${s.pos}|${s.type}`;
  const v = byScript.get(k) || { key: k, dur: 0, n: 0, max: 0 };
  v.dur += s.dur; v.n += 1; v.max = Math.max(v.max, s.dur); byScript.set(k, v);
}
const d = frames.map((x) => x[0]).sort((a, b) => a - b), n = d.length;
const q = (p) => d[Math.min(n - 1, Math.floor(p * n))];
let heap = null;
try { heap = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null; } catch (_) {}
return {
  url: location.search.replace(/password=[^&]*/, "password=***"),
  frames: n, fps: +(n / (frames.reduce((a, x) => a + x[0], 0) / 1000)).toFixed(1), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: d[n - 1],
  over100: frames.filter((x) => x[0] >= 100).map((x) => ({ ms: x[0], orbit: x[1], at: x[2] })),
  heapMB: heap,
  topScripts: [...byScript.values()].sort((a, b) => b.dur - a.dur).slice(0, 40),
  longFrames: long.filter((lf) => lf.dur >= 100).slice(0, 60),
  longFrameCount: long.length,
};
