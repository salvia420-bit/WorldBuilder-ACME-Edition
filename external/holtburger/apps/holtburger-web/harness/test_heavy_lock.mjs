// harness/test_heavy_lock.mjs — Tier-5 test for harness/lib/heavy_lock.mjs,
// the machine-wide one-heavy-job lock + free-memory gate (~/CLAUDE.md, after
// the 2026-10-05 freeze: four full gates at once on the 8 GB laptop).
//
// Pure Node. Run: node harness/test_heavy_lock.mjs — exit 0/1.
//
// Every case uses its OWN temp lock dir and an env with CI / HB_HEAVY_LOCK /
// HB_HEAVY_LOCK_HELD stripped, so it never touches /tmp/hb-heavy.lock and runs
// the same inside the gate (whose runner holds the real lock and exports
// HB_HEAVY_LOCK_HELD) as by hand. Child processes are plain `node -e`.
//
//   1  a second process waits, naming the holder ("waiting for pid"), and
//      takes the lock once the first releases; 'exit' releases it
//   1b re-entrant within one process (ref-counted)
//   2  a dead-pid owner is reclaimed; a recycled pid (start time mismatch)
//      too; a LIVE owner is not
//   2d a holder killed by SIGINT leaves a dead-pid dir that is reclaimed at
//      once (why there are no signal listeners)
//   3  an ownerless dir 60 s old is reclaimed; a fresh one is not
//   4  CI=true / HB_HEAVY_LOCK=0 / HB_HEAVY_LOCK_HELD bypass
//   5  MemAvailable parsed from a /proc/meminfo fixture
//   6  HB_MIN_FREE_MB above what is available fails after the deadline with
//      the clear message, and releases the lock
//   7  childHeapArgs (the per-child --max-old-space-size)
//   8  wiring: importing moving-bench / lib/boot.mjs takes no lock; each heavy
//      entry point acquires before it starts work

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  acquireHeavyLock, acquireHeavyLockSync, availableMemoryBytes, childHeapArgs, heavyLockBypass,
  HELD_ENV, ORPHAN_LOCK_MS, parseMemAvailable, procStartTime, readOwner,
} from "./lib/heavy_lock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");
const LOCK_URL = pathToFileURL(path.join(HERE, "lib", "heavy_lock.mjs")).href;

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL ${label}`); }
};

const BASE = mkdtempSync(path.join(os.tmpdir(), "hb-heavy-lock-test-"));
const lockDir = (name) => path.join(BASE, name);
const CLEAN_ENV = { ...process.env, HB_MIN_FREE_MB: "0" };
for (const k of ["CI", "HB_HEAVY_LOCK", HELD_ENV, "HB_HEAVY_LOCK_DIR", "HB_LOCK_WAIT_MIN", "HB_MEM_WAIT_MIN"]) {
  delete CLEAN_ENV[k];
}
const quiet = { env: CLEAN_ENV, log: () => {} };
// Inherited from the gate runner when run inside it; a release must restore it.
const HELD_BEFORE = process.env[HELD_ENV];
const hasProc = procStartTime(process.pid) != null;

/** A child that tries the lock synchronously and prints TOOK on success. */
function childTry(dir, extraEnv = {}) {
  const code = `import { acquireHeavyLockSync } from ${JSON.stringify(LOCK_URL)};\n` +
    `const h = acquireHeavyLockSync({ pollMs: 50, label: "child-try" });\n` +
    `console.log("TOOK " + (h.bypassed || "lock"));`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: APP_ROOT,
    env: { ...CLEAN_ENV, HB_HEAVY_LOCK_DIR: dir, ...extraEnv },
    encoding: "utf8",
    timeout: 20000,
  });
}

function deadPid() {
  for (let p = 4194303; p > 1000; p--) {
    try { process.kill(p, 0); } catch (e) { if (e.code === "ESRCH") return p; }
  }
  return 4194303;
}

function writeOwner(dir, owner) {
  mkdirSync(dir);
  writeFileSync(path.join(dir, "owner.json"), JSON.stringify(owner));
}

try {
  // ── 1: a second process waits for the holder, then takes it ──────────────
  {
    const dir = lockDir("one");
    const h = acquireHeavyLockSync({ ...quiet, dir, label: "parent-holder" });
    ok(h.bypassed === null && existsSync(dir), "1: first acquire takes the lock dir");
    const owner = readOwner(dir);
    ok(owner && owner.pid === process.pid && owner.label === "parent-holder" && typeof owner.started === "string",
      "1: owner.json records pid / label / started");
    ok(process.env[HELD_ENV] === String(process.pid), "1: holder exports HB_HEAVY_LOCK_HELD for its children");

    const blocked = childTry(dir, { HB_LOCK_WAIT_MIN: "0.02" }); // 1.2 s
    ok(blocked.status !== 0 && !/TOOK/.test(blocked.stdout), "1: second process does not take a held lock");
    ok(new RegExp(`waiting for pid ${process.pid} \\(parent-holder\\)`).test(blocked.stderr),
      `1: second process says whom it waits for (stderr: ${blocked.stderr.split("\n")[0]})`);
    ok(/gave up after .* \(HB_LOCK_WAIT_MIN\)/.test(blocked.stderr), "1: HB_LOCK_WAIT_MIN bounds the wait with a clear message");
    ok(readOwner(dir)?.pid === process.pid, "1: the waiter left the holder's lock alone");

    h.release();
    ok(!existsSync(dir), "1: release removes the lock dir");
    ok(process.env[HELD_ENV] === HELD_BEFORE, "1: release restores HB_HEAVY_LOCK_HELD (the gate runner's, if any)");
    h.release(); // idempotent

    const took = childTry(dir);
    ok(took.status === 0 && /TOOK lock/.test(took.stdout), "1: once released, the next process takes it");
    ok(!existsSync(dir), "1: the child's 'exit' released its lock");
  }

  // ── 1b: re-entrant within one process ────────────────────────────────────
  {
    const dir = lockDir("reentrant");
    const a = acquireHeavyLockSync({ ...quiet, dir });
    const b = await acquireHeavyLock({ ...quiet, dir, lockWaitMin: 0.01 });
    ok(a.bypassed === null && b.bypassed === null, "1b: a second in-process acquire shares the hold (no wait)");
    a.release();
    ok(existsSync(dir), "1b: the lock survives while one share is outstanding");
    b.release();
    ok(!existsSync(dir), "1b: the last share removes it");
  }

  // ── 2: stale owners ──────────────────────────────────────────────────────
  {
    const dir = lockDir("dead");
    const dead = deadPid();
    writeOwner(dir, { pid: dead, cmd: "crashed", started: "2026-10-05T00:00:00Z" });
    const h = acquireHeavyLockSync({ ...quiet, dir, lockWaitMin: 0.01 });
    ok(readOwner(dir)?.pid === process.pid, `2: a dead owner (pid ${dead}) is reclaimed`);
    h.release();
  }
  if (hasProc) {
    const dir = lockDir("recycled");
    writeOwner(dir, { pid: process.ppid, startTime: "-1", cmd: "before-reboot" }); // no real start time is negative
    const h = acquireHeavyLockSync({ ...quiet, dir, lockWaitMin: 0.01 });
    ok(readOwner(dir)?.pid === process.pid, "2: a recycled pid (start time mismatch) is reclaimed");
    h.release();
  }
  {
    const dir = lockDir("live");
    writeOwner(dir, { pid: process.ppid, startTime: procStartTime(process.ppid), cmd: "live-gate", label: "live-gate" });
    const logs = [];
    let err = null;
    try {
      acquireHeavyLockSync({ env: CLEAN_ENV, log: (m) => logs.push(m), dir, lockWaitMin: 0.005, pollMs: 20 });
    } catch (e) { err = e; }
    ok(err && err.code === "HB_HEAVY_LOCK_WAIT", "2: a LIVE owner is never reclaimed (wait deadline instead)");
    ok(logs.some((m) => m.includes(`waiting for pid ${process.ppid} (live-gate)`)), "2: the wait names the live owner");
    ok(readOwner(dir)?.pid === process.ppid, "2: the live owner's lock is untouched");
  }

  // ── 2d: SIGINT-killed holder → dead-pid reclaim ──────────────────────────
  {
    const dir = lockDir("sigint");
    const code = `import { acquireHeavyLock } from ${JSON.stringify(LOCK_URL)};\n` +
      `await acquireHeavyLock({ pollMs: 20 });\nconsole.log("HELD");\nsetTimeout(() => {}, 60000);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: APP_ROOT, env: { ...CLEAN_ENV, HB_HEAVY_LOCK_DIR: dir }, stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise((r) => child.on("exit", (c, s) => r({ code: c, signal: s })));
    const held = await new Promise((resolve) => {
      let out = "";
      const t = setTimeout(() => resolve(false), 15000);
      child.stdout.on("data", (d) => { out += d; if (out.includes("HELD")) { clearTimeout(t); resolve(true); } });
      child.on("exit", () => { clearTimeout(t); resolve(out.includes("HELD")); });
    });
    ok(held && readOwner(dir)?.pid === child.pid, "2d: child holds the lock");
    child.kill("SIGINT");
    const ex = await exited;
    ok(ex.signal === "SIGINT", `2d: SIGINT kills the holder (default disposition, no listener) — got ${JSON.stringify(ex)}`);
    ok(readOwner(dir)?.pid === child.pid, "2d: a signal-killed holder leaves its dir behind");
    const t0 = Date.now();
    const h = acquireHeavyLockSync({ ...quiet, dir, lockWaitMin: 0.05, pollMs: 20 });
    ok(readOwner(dir)?.pid === process.pid && Date.now() - t0 < 1000, "2d: ...which the next acquirer reclaims at once");
    h.release();
  }

  // ── 3: ownerless dirs ────────────────────────────────────────────────────
  {
    const dir = lockDir("orphan");
    mkdirSync(dir);
    const past = (Date.now() - 2 * ORPHAN_LOCK_MS) / 1000;
    utimesSync(dir, past, past);
    const h = acquireHeavyLockSync({ ...quiet, dir, lockWaitMin: 0.01 });
    ok(readOwner(dir)?.pid === process.pid, "3: an ownerless dir 60 s old is reclaimed");
    h.release();

    const fresh = lockDir("fresh");
    mkdirSync(fresh);
    let err = null;
    try { acquireHeavyLockSync({ ...quiet, dir: fresh, lockWaitMin: 0.005, pollMs: 20 }); } catch (e) { err = e; }
    ok(err && err.code === "HB_HEAVY_LOCK_WAIT" && existsSync(fresh) && !readOwner(fresh),
      "3: a FRESH ownerless dir (owner mid-write) is left alone");
  }

  // ── 4: bypass ────────────────────────────────────────────────────────────
  {
    ok(heavyLockBypass({ CI: "true" }) === "CI", "4: CI=true bypasses");
    ok(heavyLockBypass({ CI: "false" }) === null, "4: CI=false does not");
    ok(heavyLockBypass({ HB_HEAVY_LOCK: "0" }) === "HB_HEAVY_LOCK=0", "4: HB_HEAVY_LOCK=0 bypasses");
    ok(heavyLockBypass({ HB_HEAVY_LOCK: "off" }) !== null, "4: HB_HEAVY_LOCK=off bypasses");
    ok(heavyLockBypass({ [HELD_ENV]: "12345" }) === "held by ancestor pid 12345", "4: an ancestor's HB_HEAVY_LOCK_HELD bypasses");
    ok(heavyLockBypass({ [HELD_ENV]: String(process.pid) }) === null, "4: our own pid in HB_HEAVY_LOCK_HELD is not a bypass");
    ok(heavyLockBypass({}) === null, "4: a bare env takes the lock");

    const dir = lockDir("bypass");
    const h = acquireHeavyLockSync({ ...quiet, env: { ...CLEAN_ENV, CI: "true" }, dir });
    ok(h.bypassed === "CI" && !existsSync(dir), "4: a bypassed acquire creates no lock dir");
    h.release();

    // A gate child under a holder: the holder's export reaches it and it never waits.
    const held = lockDir("held");
    const p = acquireHeavyLockSync({ ...quiet, dir: held });
    const r = childTry(held, { [HELD_ENV]: process.env[HELD_ENV], HB_LOCK_WAIT_MIN: "0.01" });
    ok(r.status === 0 && /TOOK held by ancestor pid/.test(r.stdout), "4: a child of the holder bypasses instead of waiting on its parent");
    p.release();
  }

  // ── 5: MemAvailable parsing ──────────────────────────────────────────────
  {
    const FIXTURE = [
      "MemTotal:        7962104 kB",
      "MemFree:          312400 kB",
      "MemAvailable:    1024000 kB",
      "Buffers:           81236 kB",
    ].join("\n");
    ok(parseMemAvailable(FIXTURE) === 1024000 * 1024, "5: MemAvailable parsed to bytes");
    ok(parseMemAvailable("MemTotal: 1 kB\nMemFree: 1 kB") === null, "5: no MemAvailable line → null");
    ok(availableMemoryBytes(() => FIXTURE) === 1024000 * 1024, "5: availableMemoryBytes reads the meminfo text");
    const fallback = availableMemoryBytes(() => { throw new Error("no /proc"); });
    ok(Number.isFinite(fallback) && fallback > 0, "5: no /proc → os.freemem() fallback");
    ok(availableMemoryBytes() > 0, "5: live read is a positive byte count");
  }

  // ── 6: free-memory gate ──────────────────────────────────────────────────
  {
    const dir = lockDir("mem");
    const FIXTURE = "MemAvailable:    1024000 kB\n"; // 1000 MB
    let err = null;
    try {
      acquireHeavyLockSync({
        ...quiet, dir, minFreeMb: 2560, memWaitMin: 0.001, memPollMs: 10,
        memAvailable: () => availableMemoryBytes(() => FIXTURE),
      });
    } catch (e) { err = e; }
    ok(err && err.code === "HB_HEAVY_LOCK_MEM", "6: below HB_MIN_FREE_MB past the deadline → HB_HEAVY_LOCK_MEM");
    ok(err && /only 1000 MB available \(need 2560 MB, HB_MIN_FREE_MB\).*not starting/.test(err.message),
      `6: the message says how much, how much is needed, and that nothing started (${err && err.message})`);
    ok(!existsSync(dir), "6: a refused start releases the lock");
    ok(process.env[HELD_ENV] === HELD_BEFORE, "6: ...and exports nothing");

    // Memory frees up while waiting → it starts, having said it was waiting.
    const logs = [];
    let reads = 0;
    const h = acquireHeavyLockSync({
      env: CLEAN_ENV, log: (m) => logs.push(m), dir, minFreeMb: 2560, memWaitMin: 1, memPollMs: 10,
      memAvailable: () => (++reads < 3 ? 1000 * 1024 * 1024 : 3000 * 1024 * 1024),
    });
    ok(h.bypassed === null && reads === 3 && logs.some((m) => /1000 MB available, waiting for 2560 MB/.test(m)),
      "6: waits for memory under the lock, then starts");
    h.release();

    // The same gate from the environment, in a child.
    const r = childTry(lockDir("mem-env"), { HB_MIN_FREE_MB: "999999999", HB_MEM_WAIT_MIN: "0.001" });
    ok(r.status !== 0 && /\[heavy-lock\] only \d+ MB available \(need 999999999 MB/.test(r.stderr),
      "6: HB_MIN_FREE_MB / HB_MEM_WAIT_MIN from the environment");
  }

  // ── 7: per-child heap cap ────────────────────────────────────────────────
  {
    ok(JSON.stringify(childHeapArgs({})) === '["--max-old-space-size=1536"]', "7: default child heap cap 1536 MB");
    ok(JSON.stringify(childHeapArgs({ HB_TEST_HEAP_MB: "2048" })) === '["--max-old-space-size=2048"]', "7: HB_TEST_HEAP_MB overrides");
    ok(childHeapArgs({ HB_TEST_HEAP_MB: "0" }).length === 0, "7: HB_TEST_HEAP_MB=0 uncaps");
    ok(childHeapArgs({ HB_TEST_HEAP_MB: "junk" }).length === 0, "7: junk → uncapped, never a bad node flag");
  }

  // ── 8: wiring ────────────────────────────────────────────────────────────
  {
    // Importing a heavy entry point's module must take nothing:
    // test_moving_bench_boot.mjs / test_report_v2.mjs import moving-bench in
    // the gate, and a module-scope lock there would block on the runner.
    const dir = lockDir("import");
    const prev = process.env.HB_HEAVY_LOCK_DIR;
    process.env.HB_HEAVY_LOCK_DIR = dir;
    await import("./moving-bench.mjs");
    await import("./lib/boot.mjs");
    if (prev === undefined) delete process.env.HB_HEAVY_LOCK_DIR; else process.env.HB_HEAVY_LOCK_DIR = prev;
    ok(!existsSync(dir), "8: importing moving-bench.mjs / lib/boot.mjs takes no lock");

    const src = (rel) => readFileSync(path.join(APP_ROOT, rel), "utf8");
    const before = (text, a, b) => text.indexOf(a) >= 0 && text.indexOf(b) > text.indexOf(a);
    const gate = src("harness/run-js-headless.mjs");
    ok(before(gate, "function main()", "acquireHeavyLockSync(") && before(gate, "if (opts.list)", "acquireHeavyLockSync({"),
      "8: run-js-headless takes the lock in main(), after --list");
    ok(/spawnSync\(process\.execPath, \[\.\.\.CHILD_HEAP_ARGS, entry\.file\]/.test(gate), "8: run-js-headless children get the heap cap");
    const cargo = src("harness/cargo-tests.mjs");
    ok(before(cargo, "--print-only: not running cargo", "await acquireHeavyLock("), "8: cargo-tests locks only when it runs cargo");
    const bench = src("harness/moving-bench.mjs");
    ok(before(bench, "async function main()", "await acquireHeavyLock(") && before(bench, "await acquireHeavyLock(", "connectOverCDP"),
      "8: moving-bench locks inside main(), before CDP");
    const walk = src("harness/perf-walk.mjs");
    ok(before(walk, "async function main()", "await acquireHeavyLock(") && before(walk, "await acquireHeavyLock(", "chromium.launch("),
      "8: perf-walk locks inside main(), before launch");
    const boot = src("harness/lib/boot.mjs");
    ok(before(boot, "await acquireHeavyLock(", "chromium.launch(") && /ctx\.heavy\.release\(\)/.test(boot),
      "8: launchAndEnter locks before launch and releases in helpers.close()");
    for (const f of ["test_far_bake_shared_textures_gpu.cjs", "test_fx_decal_gpu.cjs", "test_lifestone_fx_gpu.cjs",
      "test_moon_fx_gpu.cjs", "test_particle_fx_gpu.cjs", "test_particle_fx_tier1_gpu.cjs",
      "test_particle_fx_tier2_gpu.cjs", "test_weapon_fx_gpu.cjs"]) {
      ok(before(src(f), "acquireHeavyLock()", "chromium.launch("), `8: ${f} locks before launching Chromium`);
    }
  }
} finally {
  rmSync(BASE, { recursive: true, force: true });
}

console.log(`heavy-lock: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log("HEAVY-LOCK ✅");
  process.exit(0);
} else {
  console.error("HEAVY-LOCK ❌");
  process.exit(1);
}
