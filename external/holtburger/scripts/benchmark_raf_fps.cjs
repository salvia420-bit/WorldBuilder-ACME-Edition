const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const fs = require("node:fs");
const path = require("node:path");

async function runBenchmark() {
  console.log("Launching headless browser for live rAF framerate benchmark...");
  const browser = await chromium.launch({
    args: ["--use-gl=swiftshader", "--no-sandbox"],
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1024 } });
    const url = "http://127.0.0.1:8765/apps/holtburger-web/index.html?renderer=3d&quality=high&gfxRelief=on&reliefBundles=on&skyhour=12&portalSpace=off&loginPortalSpace=off&atmosphere=off";
    console.log("Navigating to:", url);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.getElementById("results")?.innerHTML.includes("PASS"), { timeout: 30000 });

    console.log("Page loaded and initial render pass completed. Measuring 600 live rAF frames...");
    const stats = await page.evaluate(async () => {
      const live = window.liveScene3d;
      const cam = live?.cameraSwitcher?.activeCamera ?? live?.camera;

      // Allow 60 frames warmup to let shaders link and pipelines settle
      await new Promise(resolve => {
        let count = 0;
        function warm() {
          count++;
          if (count >= 60) resolve();
          else requestAnimationFrame(warm);
        }
        requestAnimationFrame(warm);
      });

      // Benchmark 600 consecutive frames with slight camera motion (navigation simulation)
      const frameDeltas = [];
      let lastTime = performance.now();
      const initialPos = cam ? { x: cam.position.x, y: cam.position.y, z: cam.position.z } : null;

      await new Promise(resolve => {
        let frame = 0;
        const TARGET_FRAMES = 600;

        function tick(now) {
          const dt = now - lastTime;
          lastTime = now;
          if (dt > 0) {
            frameDeltas.push(dt);
          }

          // Gentle camera drift to simulate live player motion
          if (cam && initialPos) {
            const angle = frame * 0.01;
            cam.position.x = initialPos.x + Math.sin(angle) * 1.5;
            cam.position.z = initialPos.z + Math.cos(angle) * 1.5;
          }

          frame++;
          if (frame < TARGET_FRAMES) {
            requestAnimationFrame(tick);
          } else {
            resolve();
          }
        }
        requestAnimationFrame(tick);
      });

      // Calculate statistics
      frameDeltas.sort((a, b) => a - b);
      const n = frameDeltas.length;
      const sum = frameDeltas.reduce((acc, v) => acc + v, 0);
      const meanDelta = sum / n;
      const meanFps = 1000.0 / meanDelta;

      const p50 = frameDeltas[Math.floor(n * 0.50)];
      const p90 = frameDeltas[Math.floor(n * 0.90)];
      const p95 = frameDeltas[Math.floor(n * 0.95)];
      const p99 = frameDeltas[Math.floor(n * 0.99)];
      const maxDelta = frameDeltas[n - 1];
      const minDelta = frameDeltas[0];

      return {
        sampleCount: n,
        totalDurationMs: +sum.toFixed(2),
        meanDeltaMs: +meanDelta.toFixed(3),
        meanFps: +meanFps.toFixed(2),
        minDeltaMs: +minDelta.toFixed(3),
        p50DeltaMs: +p50.toFixed(3),
        p90DeltaMs: +p90.toFixed(3),
        p95DeltaMs: +p95.toFixed(3),
        p99DeltaMs: +p99.toFixed(3),
        maxDeltaMs: +maxDelta.toFixed(3),
        stutter33msCount: frameDeltas.filter(d => d > 33.33).length,
        stutter50msCount: frameDeltas.filter(d => d > 50.0).length,
      };
    });

    console.log("Live rAF Framerate Benchmark Results:\n", JSON.stringify(stats, null, 2));

    const outPath = "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/reports/captures/benchmark_raf_fps.json";
    fs.writeFileSync(outPath, JSON.stringify(stats, null, 2));
    console.log(`Saved benchmark report to ${outPath}`);

    return stats;

  } finally {
    await browser.close();
  }
}

runBenchmark().catch(err => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
