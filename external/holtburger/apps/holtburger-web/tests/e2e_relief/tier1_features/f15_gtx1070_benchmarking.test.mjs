/**
 * apps/holtburger-web/tests/e2e_relief/tier1_features/f15_gtx1070_benchmarking.test.mjs
 *
 * Tier 1: Feature Coverage — F15: GTX 1070 Live Framerate & Latency Benchmarking
 * Requirement: ORIGINAL_REQUEST §R3, PROJECT.md Feature Inventory #15
 */

import { describe, test, ok, equal, computeLatencyPercentiles, CONSTANTS } from "../harness.mjs";

export function runTests() {
  describe("F15: GTX 1070 Live Framerate & Latency Benchmarking — Feature Coverage", () => {
    test("F15-1: Percentile profiler accurately computes p50, p95, p99, and max latencies", () => {
      // 100 simulated frames: mostly 14ms (71 FPS), five at 16ms, one at 20ms
      const frames = new Array(94).fill(14.0).concat([16.0, 16.0, 16.0, 16.0, 16.0, 20.0]);
      const metrics = computeLatencyPercentiles(frames);

      equal(metrics.p50, 14.0, "p50 must be 14.0ms");
      equal(metrics.p95, 16.0, "p95 must be 16.0ms");
      equal(metrics.p99, 20.0, "p99 must be 20.0ms");
      equal(metrics.max, 20.0, "max must be 20.0ms");
      ok(metrics.fps > 65.0, `FPS (${metrics.fps.toFixed(1)}) must exceed 65 FPS`);
    });

    test("F15-2: Production framerate criteria requires mean FPS >= 60.0", () => {
      const stableFrames = new Array(600).fill(15.5); // ~64.5 FPS
      const slowFrames = new Array(600).fill(18.0);   // ~55.5 FPS

      const stableMetrics = computeLatencyPercentiles(stableFrames);
      const slowMetrics = computeLatencyPercentiles(slowFrames);

      ok(stableMetrics.fps >= CONSTANTS.GTX1070_TARGET_FPS, "Stable 15.5ms frames meet >60 FPS target");
      ok(slowMetrics.fps < CONSTANTS.GTX1070_TARGET_FPS, "Slow 18.0ms frames fail >60 FPS target");
    });

    test("F15-3: p95 frame-time delta invariant (<= 2.0ms relative to baseline) is enforced", () => {
      const baselineP95 = 14.5;
      function checkP95Delta(reliefP95) {
        return (reliefP95 - baselineP95) <= CONSTANTS.GTX1070_MAX_P95_DELTA_MS;
      }

      equal(checkP95Delta(15.5), true, "Delta 1.0ms is within production 2.0ms threshold");
      equal(checkP95Delta(16.5), true, "Delta 2.0ms meets threshold exactly");
      equal(checkP95Delta(17.2), false, "Delta 2.7ms violates threshold");
    });

    test("F15-4: First-turn hitching detection flags any frame delta exceeding 33.3ms", () => {
      // 599 smooth 15ms frames + 1 hitch at 45ms during camera rotation / shader compile
      const framesWithHitch = new Array(599).fill(15.0).concat([45.0]);
      const framesSmooth = new Array(600).fill(15.0);

      const metricsHitch = computeLatencyPercentiles(framesWithHitch);
      const metricsSmooth = computeLatencyPercentiles(framesSmooth);

      equal(metricsHitch.hitchCount, 1, "Detects exactly 1 frame hitch");
      equal(metricsSmooth.hitchCount, 0, "Smooth run has 0 hitches");
    });

    test("F15-5: 10-second sampling window verification checks minimum sample count", () => {
      function validateSampleCount(sampleCount, durationSec) {
        const minExpected = durationSec * 50; // At least 50 FPS average
        return sampleCount >= minExpected;
      }

      equal(validateSampleCount(600, 10.0), true, "600 samples across 10 seconds is valid");
      equal(validateSampleCount(350, 10.0), false, "350 samples indicates major stalling/dropped frames");
    });
  });
}
