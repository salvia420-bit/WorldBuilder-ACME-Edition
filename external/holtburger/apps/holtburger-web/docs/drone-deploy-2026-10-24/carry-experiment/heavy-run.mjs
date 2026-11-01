// heavy-run.mjs <label> -- <cmd> [args...] : hold the laptop's shared heavy-job lock
// (harness/lib/heavy_lock.mjs: one heavy job per machine + MemAvailable >= 2.5 GB) for the
// duration of one child command; exits with the child's status.
import { spawnSync } from "node:child_process";
const { acquireHeavyLock } = await import("/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/harness/lib/heavy_lock.mjs");
const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const label = sep > 0 ? argv.slice(0, sep).join(" ") : "heavy-run";
const cmd = sep >= 0 ? argv.slice(sep + 1) : argv;
const lock = await acquireHeavyLock({ label });
console.log(`[heavy-run] lock ${lock.dir} (waited ${lock.waitedMs} ms) -> ${cmd.join(" ")}`);
const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", env: { ...process.env, HB_HEAVY_LOCK_HELD: String(process.pid) } });
process.exit(r.status ?? 1);
