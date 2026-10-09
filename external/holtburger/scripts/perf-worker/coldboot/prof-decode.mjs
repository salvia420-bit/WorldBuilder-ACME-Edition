// prof-dec.mjs — CPU-profile one main-thread fetch_surfaces_pixels over the cached material DIDs.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const pg = browser.contexts()[0].pages().find((p) => p.url().includes("holtburger-web"));
const cdp = await pg.context().newCDPSession(pg);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
await cdp.send("Profiler.start");
const r = await pg.evaluate(async () => {
  const s = window.liveScene3d, ns = window.__hbWasmNs || window.__hbWasm;
  const dids = Array.from(s.materialCache.materials.keys()).map((d) => d >>> 0).filter((d) => (d >>> 24) === 0x08);
  const t0 = performance.now();
  const out = await ns.fetch_surfaces_pixels(new Uint32Array(dids), true);
  const ms = Math.round(performance.now() - t0);
  for (const sp of out) { try { sp?.free?.(); } catch (_) {} }
  return { n: dids.length, ms };
});
const { profile } = await cdp.send("Profiler.stop");
writeFileSync("prof-dec.cpuprofile", JSON.stringify(profile));
const self = new Map();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const dt = profile.timeDeltas; const samples = profile.samples;
const tot = new Map();
for (let i = 0; i < samples.length; i++) {
  const n = byId.get(samples[i]); const d = dt[i] || 0;
  const k = `${n.callFrame.functionName || "(anon)"} ${String(n.callFrame.url).split("/").pop()}`;
  self.set(k, (self.get(k) || 0) + d);
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
console.log(JSON.stringify(r), "profiled ms", Math.round(total / 1000));
for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log((v / 1000).toFixed(0).padStart(7), "ms", (100 * v / total).toFixed(1).padStart(5) + "%", k.slice(0, 120));
process.exit(0);
