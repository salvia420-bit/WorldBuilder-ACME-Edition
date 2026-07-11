// crash-probe.mjs — s13 renderer-death diagnostic. Repro loop over the heavy
// POIs that killed battery sessions, sampling JS heap + renderer RSS per stop,
// with page.on('crash') armed to distinguish CRASH (process died) from HANG
// (eval-timeout with live process). Run with DEBUG=pw:browser* to also capture
// chromium's own stderr (SwiftShader aborts / OOM kills show up there).
import { execSync } from "node:child_process";
import { launchAndEnter } from "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/harness/lib/boot.mjs";

const HEAVY = ["Arwic", "Tou-Tou", "Lytelthorpe", "TownNetwork", "TN", "Ayan", "Cragstone", "Zaikhal", "Yaraq", "Hebian-To"];
const ROUNDS = 3;

const rendererRss = () => {
  try {
    const out = execSync(
      "ps -eo rss,args | grep -F -- '--type=renderer' | grep -v grep | sort -rn | head -1",
      { encoding: "utf8" }
    ).trim();
    return out ? Math.round(parseInt(out, 10) / 1024) : null; // MiB
  } catch (_) { return null; }
};

const r = await launchAndEnter({ query: { nosw: "1" } });
if (!r.inWorld) { console.log("PROBE: boot failed"); await r.helpers.close(); process.exit(2); }
let crashed = false;
r.page.on("crash", () => { crashed = true; console.log("PAGE-CRASH EVENT (renderer process died)"); });

const samples = [];
const sample = async (tag) => {
  let mem = null, lbs = null;
  try {
    mem = await Promise.race([
      r.page.evaluate(() => {
        const m = performance.memory || {};
        return {
          usedMB: Math.round((m.usedJSHeapSize || 0) / 1048576),
          totalMB: Math.round((m.totalJSHeapSize || 0) / 1048576),
          limitMB: Math.round((m.jsHeapSizeLimit || 0) / 1048576),
          geoms: (() => { try { return window.liveScene3d?.renderer?.info?.memory?.geometries ?? null; } catch (_) { return null; } })(),
          baked: (() => { try { return window.liveScene3d?.terrainBakedLbs?.size ?? null; } catch (_) { return null; } })(),
        };
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("eval-timeout")), 15000)),
    ]);
  } catch (e) {
    console.log(`SAMPLE ${tag}: EVAL FAILED (${e.message}) crashedEvent=${crashed}`);
    return false;
  }
  const rss = rendererRss();
  samples.push({ tag, ...mem, rendererRssMB: rss });
  console.log(`SAMPLE ${tag}: jsHeap=${mem.usedMB}/${mem.totalMB}MB (limit ${mem.limitMB}) geoms=${mem.geoms} baked=${mem.baked} rendererRSS=${rss}MB`);
  return true;
};

await sample("boot");
outer:
for (let round = 1; round <= ROUNDS; round += 1) {
  for (const poi of HEAVY) {
    try {
      await r.page.evaluate((p) => window.__sessionHandle?.sendChat(`@telepoi ${p}`), poi);
    } catch (e) {
      console.log(`TELEPOI ${poi} eval failed: ${e.message} crashedEvent=${crashed}`);
      break outer;
    }
    await r.page.waitForTimeout(12000).catch(() => {});
    const ok = await sample(`r${round}:${poi}`);
    if (!ok || crashed) break outer;
  }
}
console.log(`PROBE END crashed=${crashed} samples=${samples.length}`);
console.log("TRAJECTORY:", JSON.stringify(samples.map((s) => [s.tag, s.usedMB, s.rendererRssMB])));
await r.helpers.close();
