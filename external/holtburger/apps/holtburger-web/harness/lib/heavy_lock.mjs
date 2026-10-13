// harness/lib/heavy_lock.mjs — one heavy harness job per machine, and only
// with memory to spare.
//
// ~/CLAUDE.md "One heavy job at a time": on 2026-10-05 four parallel agents
// each ran `node harness/run-js-headless.mjs` next to ACE, serve.py and the
// Claude session, and the 8 GB laptop froze for ~20 min and rebooted. Until
// 2026-10-13 that rule was prompt text only; capped-build has no lock either
// (every job joins the same 3.5 GB oom.group cgroup, so two capped gates
// started together are OOM-killed together instead of serialising). The heavy
// entry points now call acquire before they start work: the full JS gate
// (run-js-headless main), cargo-tests (only when it runs cargo), moving-bench
// and perf-walk main(), lib/boot.mjs launchAndEnter (held until
// helpers.close()), and the test_*_gpu.cjs smokes.
//
//   1. LOCK — a directory created atomically (mkdir) at HB_HEAVY_LOCK_DIR,
//      default /tmp/hb-heavy.lock (a FIXED path, not os.tmpdir(): that follows
//      a per-session TMPDIR and two sessions would never see each other), with
//      owner.json {pid, cmd, label, cwd, started, startTime}. A second job
//      waits and says for whom, every 15 s. A lock whose owner is dead — or
//      whose pid was recycled (the kernel start time no longer matches) — or
//      an ownerless dir older than 30 s, is reclaimed. HB_LOCK_WAIT_MIN (unset
//      = wait forever) bounds the wait.
//   2. MEMORY — holding the lock, wait for MemAvailable >= HB_MIN_FREE_MB
//      (default 2560, the CLAUDE.md bar). After HB_MEM_WAIT_MIN minutes
//      (default 10) it releases and fails with a clear message instead of
//      starting.
//
// RELEASE: on 'exit' (process.exit, a normal end, an uncaught throw). There
// are deliberately NO SIGINT/SIGTERM listeners: a JS signal listener swallows
// Ctrl-C in the spawnSync runner (its loop never yields, so the listener runs
// only after the whole gate) and pre-empts Playwright's own graceful browser
// close. A job killed by a signal leaves the dir behind with a dead pid, which
// the next acquirer reclaims at once.
//
// BYPASS: CI=true (one job per VM), HB_HEAVY_LOCK=0, or HB_HEAVY_LOCK_HELD
// set by an ancestor — a holder exports its pid, so a gate's children (a gate
// suite that imports a bench, a nested runner) never wait on their own parent.
// Within one process the hold is re-entrant (ref-counted).
//
// Plain `node tests/x.test.mjs` never touches this: only the entry points
// above call acquire, so the parallel-agent rule (targeted single tests) is
// unchanged. Test: harness/test_heavy_lock.mjs.
//
// After WebAC tests/_harness/suite-guard.ts, AGPL-3.0.

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_LOCK_DIR =
  process.platform === "win32" ? path.join(os.tmpdir(), "hb-heavy.lock") : "/tmp/hb-heavy.lock";
/** An ownerless lock dir this old is an orphan (owner.json lands right after mkdir). */
export const ORPHAN_LOCK_MS = 30_000;
export const HELD_ENV = "HB_HEAVY_LOCK_HELD";
export const DEFAULT_MIN_FREE_MB = 2560;
export const DEFAULT_MEM_WAIT_MIN = 10;
export const DEFAULT_TEST_HEAP_MB = 1536;
const LOG_EVERY_MS = 15_000;
const MB = 1024 * 1024;

/** Bytes from a /proc/meminfo `MemAvailable:` line, or null when there is none. */
export function parseMemAvailable(text) {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(String(text ?? ""));
  return m ? Number(m[1]) * 1024 : null;
}

/** Bytes the OS could hand a new process right now: Linux MemAvailable, else os.freemem(). */
export function availableMemoryBytes(readMeminfo = () => readFileSync("/proc/meminfo", "utf8")) {
  try {
    const b = parseMemAvailable(readMeminfo());
    if (b != null) return b;
  } catch (_) {
    /* no /proc — fall through */
  }
  return os.freemem();
}

/** Why this process must not take the lock (a short reason), or null. */
export function heavyLockBypass(env = process.env) {
  const ci = env.CI;
  if (ci && ci !== "false" && ci !== "0") return "CI";
  const v = String(env.HB_HEAVY_LOCK ?? "").toLowerCase();
  if (v === "0" || v === "off" || v === "false" || v === "no") return `HB_HEAVY_LOCK=${env.HB_HEAVY_LOCK}`;
  const held = env[HELD_ENV];
  if (held && held !== String(process.pid)) return `held by ancestor pid ${held}`;
  return null;
}

/**
 * Node argv for each gate child: a V8 heap cap, so a runaway suite dies alone
 * on a heap OOM instead of pushing the box into swap (after WebAC
 * vitest.config.ts `execArgv: ['--max-old-space-size=1536']`, AGPL-3.0).
 * HB_TEST_HEAP_MB overrides (default 1536; 0 = uncapped).
 */
export function childHeapArgs(env = process.env) {
  const raw = env.HB_TEST_HEAP_MB;
  const mb = raw === undefined || raw === "" ? DEFAULT_TEST_HEAP_MB : Number(raw);
  return Number.isFinite(mb) && mb > 0 ? [`--max-old-space-size=${Math.floor(mb)}`] : [];
}

/** Kernel start time of `pid` (/proc/<pid>/stat field 22, ticks since boot), or null. */
export function procStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm (field 2) may hold spaces and parens; the fields resume after the
    // LAST ')'. rest[0] is field 3 (state), so field 22 is rest[19].
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return rest[19] ?? null;
  } catch (_) {
    return null;
  }
}

/** Is the recorded owner still the process that took the lock? */
export function ownerAlive(owner) {
  const pid = owner && owner.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code !== "EPERM") return false;
  }
  // A recycled pid (after a reboot, or long after the owner died) belongs to a
  // process with a different start time.
  if (owner.startTime != null) {
    const now = procStartTime(pid);
    if (now != null && now !== String(owner.startTime)) return false;
  }
  return true;
}

export function readOwner(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, "owner.json"), "utf8"));
  } catch (_) {
    return null;
  }
}

function ageMs(p) {
  try {
    return Date.now() - statSync(p).mtimeMs;
  } catch (_) {
    return 0;
  }
}

function isStale(dir, owner) {
  return owner ? !ownerAlive(owner) : ageMs(dir) > ORPHAN_LOCK_MS;
}

// Reclaimers are serialised by a second mkdir, and re-check under it: without
// that, A and B both see a dead owner, A removes and re-takes the lock, and
// B's late rm deletes A's live one.
function reclaim(dir) {
  const mutex = `${dir}.reclaim`;
  try {
    mkdirSync(mutex);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    if (ageMs(mutex) > ORPHAN_LOCK_MS) rmSync(mutex, { recursive: true, force: true });
    return false;
  }
  try {
    if (!isStale(dir, readOwner(dir))) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  } finally {
    rmSync(mutex, { recursive: true, force: true });
  }
}

function ownerRecord(label) {
  return {
    pid: process.pid,
    cmd: [path.basename(process.argv[1] || "node"), ...process.argv.slice(2)].join(" ").slice(0, 300),
    label: label || null,
    cwd: process.cwd(),
    started: new Date().toISOString(),
    startTime: procStartTime(process.pid),
  };
}

function tryTake(dir, label) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dir);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const owner = readOwner(dir);
      if (attempt === 0 && isStale(dir, owner) && reclaim(dir)) continue;
      return { taken: false, owner };
    }
    // tmp + rename: a reader sees no owner.json or a whole one, never half.
    const tmp = path.join(dir, `owner.json.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(ownerRecord(label)));
    renameSync(tmp, path.join(dir, "owner.json"));
    return { taken: true, owner: null };
  }
  return { taken: false, owner: readOwner(dir) };
}

// This process's holds: dir -> { refs, ready }. `ready` = past the memory gate.
const HELD = new Map();
let exitHooked = false;
let exportedEnv = null; // { prev } while this process exports HELD_ENV

function dropHold(dir) {
  if (!HELD.delete(dir)) return;
  const owner = readOwner(dir);
  if (owner && owner.pid === process.pid) rmSync(dir, { recursive: true, force: true });
  if (exportedEnv && HELD.size === 0) {
    if (exportedEnv.prev === undefined) delete process.env[HELD_ENV];
    else process.env[HELD_ENV] = exportedEnv.prev;
    exportedEnv = null;
  }
}

function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    for (const dir of [...HELD.keys()]) dropHold(dir);
  });
}

function holdHandle(dir, waitedMs) {
  let released = false;
  return {
    dir,
    bypassed: null,
    waitedMs,
    release() {
      if (released) return;
      released = true;
      const h = HELD.get(dir);
      if (h && --h.refs <= 0) dropHold(dir);
    },
  };
}

function lockError(code, message) {
  return Object.assign(new Error(message), { code });
}

function resolveOptions(opts = {}) {
  const env = opts.env || process.env;
  const num = (v, d) => {
    if (v === undefined || v === null || v === "") return d;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  const lockWaitMin = num(opts.lockWaitMin ?? env.HB_LOCK_WAIT_MIN, 0);
  return {
    env,
    dir: path.resolve(opts.dir || env.HB_HEAVY_LOCK_DIR || DEFAULT_LOCK_DIR),
    label: opts.label || "",
    minFreeBytes: num(opts.minFreeMb ?? env.HB_MIN_FREE_MB, DEFAULT_MIN_FREE_MB) * MB,
    memWaitMs: num(opts.memWaitMin ?? env.HB_MEM_WAIT_MIN, DEFAULT_MEM_WAIT_MIN) * 60_000,
    lockWaitMs: lockWaitMin > 0 ? lockWaitMin * 60_000 : Infinity,
    pollMs: opts.pollMs ?? 1000,
    memPollMs: opts.memPollMs ?? 2000,
    logEveryMs: opts.logEveryMs ?? LOG_EVERY_MS,
    memAvailable: opts.memAvailable || availableMemoryBytes,
    log: opts.log || ((m) => console.error(m)),
  };
}

const mbOf = (bytes) => Math.round(bytes / MB);

// The acquire state machine, shared by the sync and async front ends: yields
// a sleep in ms, returns the handle, throws a coded Error on a deadline.
function* acquireSteps(o) {
  const bypass = heavyLockBypass(o.env);
  if (bypass) return { dir: o.dir, bypassed: bypass, waitedMs: 0, release() {} };
  const t0 = Date.now();
  let lastLog = -Infinity;
  for (;;) {
    const mine = HELD.get(o.dir);
    if (mine) {
      // Re-entrant: share this process's hold once it is past the memory gate.
      if (mine.ready) {
        mine.refs += 1;
        return holdHandle(o.dir, Date.now() - t0);
      }
      yield o.pollMs;
      continue;
    }
    const r = tryTake(o.dir, o.label);
    if (r.taken) break;
    // Held by this very process through another copy of this module.
    if (r.owner && r.owner.pid === process.pid) {
      return { dir: o.dir, bypassed: "held by this process", waitedMs: Date.now() - t0, release() {} };
    }
    const now = Date.now();
    const who = r.owner
      ? `pid ${r.owner.pid} (${r.owner.label || r.owner.cmd || "?"}) since ${r.owner.started || "?"}`
      : "pid ? (owner.json not written yet)";
    if (now - t0 >= o.lockWaitMs) {
      throw lockError("HB_HEAVY_LOCK_WAIT",
        `[heavy-lock] gave up after ${((now - t0) / 1000).toFixed(1)} s (HB_LOCK_WAIT_MIN) waiting for ${who} — ` +
          `${o.dir} is held. One heavy job per machine (~/CLAUDE.md).`);
    }
    if (now - lastLog >= o.logEveryMs) {
      o.log(`[heavy-lock] waiting for ${who} — one heavy job per machine (~/CLAUDE.md); lock ${o.dir}`);
      lastLog = now;
    }
    yield o.pollMs;
  }

  const hold = { refs: 0, ready: false };
  HELD.set(o.dir, hold);
  hookExit();
  // The memory gate runs UNDER the lock, so two waiters never both start the
  // moment memory frees up.
  const memT0 = Date.now();
  lastLog = -Infinity;
  for (;;) {
    const avail = o.memAvailable();
    if (avail >= o.minFreeBytes) break;
    const now = Date.now();
    if (now - memT0 >= o.memWaitMs) {
      dropHold(o.dir);
      throw lockError("HB_HEAVY_LOCK_MEM",
        `[heavy-lock] only ${mbOf(avail)} MB available (need ${mbOf(o.minFreeBytes)} MB, HB_MIN_FREE_MB); ` +
          `waited ${((now - memT0) / 60_000).toFixed(1)} min (HB_MEM_WAIT_MIN) — not starting. ` +
          "Close something (Chrome tabs, a build, a stray node) or set HB_MIN_FREE_MB.");
    }
    if (now - lastLog >= o.logEveryMs) {
      o.log(`[heavy-lock] ${mbOf(avail)} MB available, waiting for ${mbOf(o.minFreeBytes)} MB (HB_MIN_FREE_MB)`);
      lastLog = now;
    }
    yield o.memPollMs;
  }
  hold.ready = true;
  hold.refs = 1;
  if (!exportedEnv) {
    exportedEnv = { prev: process.env[HELD_ENV] };
    process.env[HELD_ENV] = String(process.pid);
  }
  const waitedMs = Date.now() - t0;
  if (waitedMs >= 1000) o.log(`[heavy-lock] acquired ${o.dir} after ${(waitedMs / 1000).toFixed(0)} s`);
  return holdHandle(o.dir, waitedMs);
}

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

/**
 * Take the heavy-job lock, blocking the thread while waiting (for a fully
 * synchronous caller such as the spawnSync gate runner).
 * @param {object} [opts] {label, dir, minFreeMb, memWaitMin, lockWaitMin,
 *   pollMs, memPollMs, logEveryMs, env, log, memAvailable} — each defaults
 *   from the HB_* env described above.
 * @returns {{dir:string, bypassed:string|null, waitedMs:number, release():void}}
 * @throws Error with code HB_HEAVY_LOCK_MEM / HB_HEAVY_LOCK_WAIT on a deadline.
 */
export function acquireHeavyLockSync(opts) {
  const it = acquireSteps(resolveOptions(opts));
  for (let r = it.next(); ; r = it.next()) {
    if (r.done) return r.value;
    Atomics.wait(SLEEP_CELL, 0, 0, r.value);
  }
}

/** acquireHeavyLockSync, but waiting on timers (for async mains and launchAndEnter). */
export async function acquireHeavyLock(opts) {
  const it = acquireSteps(resolveOptions(opts));
  for (let r = it.next(); ; r = it.next()) {
    if (r.done) return r.value;
    await new Promise((res) => setTimeout(res, r.value));
  }
}
