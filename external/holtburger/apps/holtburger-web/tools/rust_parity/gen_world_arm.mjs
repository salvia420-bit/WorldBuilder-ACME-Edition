// tools/rust_parity/gen_world_arm.mjs — run ANY node script with the lane W
// shadow hooks armed (docs/2026-10-26-rust-world.md §5, "flag on" arm):
//
//   node --import ./tools/rust_parity/gen_world_arm.mjs test_x.mjs
//
// Preloaded before the script, it arms scene3d/rust/world.js on the JS
// reference model (tools/rust_parity/gen_world_model.mjs), exactly as
// `?rustWorld=on` arms it on the compiled kernel in a browser: every hooked
// producer the script drives posts its events, every BatchedMesh they make is
// tracked. stdout is left alone, so a suite's output with and without this
// preload can be diffed (no behaviour change). At exit one audit runs and its
// result goes to STDERR: `[rustWorld-arm] audit: … mismatches …`.
//
// The suites build their own (often partial or fake) scenes, so the exit audit
// is informative rather than a gate: a suite that stubs a producer's seam or
// swaps a registry mid-run can legitimately leave the shadow out of step.

import { armRustWorld } from "../../scene3d/rust/world.js";
import { WorldModel } from "./gen_world_model.mjs";

const model = new WorldModel();
const bridge = armRustWorld({ kernel: model, periodic: false });

process.on("exit", () => {
  try {
    if (globalThis.__hbRustWorld !== bridge) {
      process.stderr.write("[rustWorld-arm] the bridge was disarmed or replaced during the run\n");
      return;
    }
    const r = bridge.audit({ matrices: true });
    const rep = r && r.report;
    const cats = rep ? Object.entries(rep.last.cat).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" ") : "";
    process.stderr.write(
      `[rustWorld-arm] audit: ${r ? r.mismatches : "n/a"} mismatches${cats ? ` (${cats})` : ""}, ` +
      `integrity ${rep ? rep.integrityTotal : "n/a"}, tracked ${bridge.stats.tracked}, events ${bridge.stats.events}, ` +
      `hook errors ${bridge.stats.hookErrors}${bridge.stats.lastError ? ` (${bridge.stats.lastError})` : ""}\n`,
    );
  } catch (e) {
    process.stderr.write(`[rustWorld-arm] exit audit threw: ${e && e.stack ? e.stack : e}\n`);
  }
});
