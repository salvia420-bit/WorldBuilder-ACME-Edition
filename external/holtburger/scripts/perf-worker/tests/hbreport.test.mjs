// tests/hbreport.test.mjs — node entry for the hbreport.py suite (round 3 R3-0, 2026-10-30), so the JS
// gate (harness/run-js-headless.mjs, `node <file>`) can run it: spawns
// `python3 -I scripts/perf-worker/tests/test_hbreport.py` and exits with its status. The python suite
// reproduces the 10-29 numbers of docs/2026-10-29-round3-gpu-driven.md section 1 from the stored runs
// (skipped, and printed as skipped, when /mnt/wbterminal1/.../rc-rust-scene-core-2026-10-29 is absent)
// and pins rules V / R1 / R3 / R5 / R6 / R8 on synthetic runs.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const r = spawnSync("python3", ["-I", join(here, "test_hbreport.py")], { encoding: "utf8", timeout: 300000 });
process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
if (r.error) { console.error(`hbreport.test.mjs: could not run python3: ${r.error.message}`); process.exit(1); }
process.exit(r.status === 0 ? 0 : 1);
