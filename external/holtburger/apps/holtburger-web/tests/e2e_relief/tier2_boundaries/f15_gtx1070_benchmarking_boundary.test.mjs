/**
 * apps/holtburger-web/tests/e2e_relief/tier2_boundaries/f15_gtx1070_benchmarking_boundary.test.mjs
 *
 * Tier 2: Boundary & Corner Cases — F15: GTX 1070 Live Framerate & Latency Benchmarking
 */

import { describe, test, ok, equal, computeLatencyPercentiles } from "../harness.mjs";

export function runTests() {
  describe("F15: GTX 1070 Live Framerate & Latency Benchmarking — Boundary & Corner Cases", () => {
    test("B15-1: Empty frame delta array returns zeroed metrics without NaN or throw", () => {
      const metrics = computeLatencyPercentiles([]);
      equal(metrics.mean, 0, "Mean of empty array is 0");
      equal(metrics.fps, 0, "FPS of empty array is 0");
      equal(metrics.p50, 0, "p50 is 0");
      equal(metrics.hitchCount, 0, "Hitch count is 0");
    });

    test("B15-2: Single-frame measurement returns identical percentiles across all tiers", () => {
      const singleFrame = [16.6667];
      const metrics = computeLatencyPercentiles(singleFrame);

      equal(metrics.p50, 16.6667, "p50 matches single frame");
      equal(metrics.p95, 16.6667, "p95 matches single frame");
      equal(metrics.p99, 16.6667, "p99 matches single frame");
      equal(metrics.max, 16.6667, "max matches single frame");
      equal(metrics.hitchCount, 0, "No hitch");
    });

    test("B15-3: Exactly on 60.0 FPS boundary (frame time = 16.6667ms)", () => {
      const boundaryFrames = new Array(100).fill(16.666667);
      const metrics = computeLatencyPercentiles(boundaryFrames);

      ok(metrics.fps >= 59.99 && metrics.fps <= 60.01, `FPS (${metrics.fps}) is right on 60.0 target boundary`);
      equal(metrics.hitchCount, 0, "16.67ms is normal 60 FPS cadence, not a hitch");
    });

    test("B15-4: Extreme spike frame (500ms hitch) is isolated in max and hitchCount", () => {
      const frames = new Array(99).fill(15.0).concat([500.0]);
      const metrics = computeLatencyPercentiles(frames);

      equal(metrics.p50, 15.0, "p50 unaffected by single outlier");
      equal(metrics.max, 500.0, "max captures 500ms stall");
      equal(metrics.hitchCount, 1, "Detects exactly 1 severe hitch");
    });

    test("B15-5: Clock skew or zero frame time delta handled defensively", () => {
      const skewFrames = [15.0, 0.0, 15.0, 16.0];
      const metrics = computeLatencyPercentiles(skewFrames);

      ok(Number.isFinite(metrics.mean), "Mean remains finite");
      ok(metrics.mean > 0, "Mean remains positive");
    });
  });
}
