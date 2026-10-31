// lib/hb_box.mjs — the 1070 box side of harness v2 (2026-10-30): ssh with retries, the fresh-profile
// launch files, the hidden schtasks launch, the kill-by-user-data-dir, and the per-segment box
// sample (box/hbwho.ps1 + top processes by CPU, one ssh round trip; lib/hb_v2.mjs builds and parses
// it). The commands are hbbench.mjs's own (box/hbprobe-launch.bat reads profile.txt / winsize.txt /
// uncapped.txt / angle.txt / disablefeatures.txt / extraflags.txt; box/hbbench-kill.ps1 kills only
// Chrome whose command line is under D:\Temp\hbbench\). Nothing here runs at import time.
// Kill discipline (2026-10-30): every launching path kills in a `finally` that a failed write or box
// sample cannot skip, and armKillOnSignal covers Ctrl-C (tests/hb_v2.test.mjs pins both).
//
// 1070 rules (plan §3): off-screen only, muted (the launcher passes --mute-audio), never the user's
// Chrome (kill matches the user-data-dir only), fresh --user-data-dir per arm-rep, one real-world tab.
import { execFileSync } from "node:child_process";
import { boxSampleScript, encodePowerShell, parseBoxSample, retry } from "./hb_v2.mjs";

export const BOX = "young@100.127.215.75";
// HB_CDP overrides the CDP endpoint (as cdp-eval.mjs does): the orchestrator's one laptop tab check of the
// attach-mode tools (hbanatomy --attach, hbsweep) points them at a local tab, with --no-box-samples.
export const CDP = process.env.HB_CDP || "http://127.0.0.1:9333";
export const ACE_LOG = "/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0/ACE_Log.txt";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One ssh command on the box (cmd.exe is the remote shell). Throws on failure / timeout. */
export function ssh(cmd, { timeout = 60000 } = {}) {
  return execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", BOX, cmd], { encoding: "utf8", timeout });
}

/** ssh with 3 tries (5 s, 20 s apart): RC-BENCH v2 died on one `spawnSync ssh ETIMEDOUT` (plan §1.1). */
export function sshRetry(cmd, o = {}) {
  return retry(() => ssh(cmd, o), { tries: o.tries || 3, delays: o.delays || [5000, 20000] });
}

/** Kill only the bench Chrome (profile under D:\Temp\hbbench\) and drop old hbb-* profiles. Never throws. */
export function killBench() {
  try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) { /* box gone: the next launch step reports it */ }
}

/** Exit codes of a signal-terminated run (128 + signal number). */
export const SIGNAL_EXIT = Object.freeze({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 });

/**
 * Ctrl-C / SIGTERM / SIGHUP while a launching tool runs (2026-10-30, lane H2): node's default signal
 * exit runs no `finally`, so the test Chrome would stay up, logged in and in world on the person's
 * 1070. The handler kills the bench Chrome (killBench: by user-data-dir only, synchronous), then exits
 * 128 + signal. A tool's main() arms it for its LAUNCHING modes only (hbbench, hbanatomy without
 * --attach, hbsweep --boot): never at import, never for an attached session. Returns disarm().
 * `kill` / `proc` are for the suite.
 */
export function armKillOnSignal({ kill = killBench, proc = process, signals = Object.keys(SIGNAL_EXIT), log = (m) => console.error(m) } = {}) {
  const handlers = [];
  let fired = false;
  for (const s of signals) {
    const h = () => {
      if (fired) return;
      fired = true;
      try { log(`[hb_box] ${s}: killing the bench Chrome on the box before exit`); kill(); } catch (_) { /* best effort */ }
      proc.exit(SIGNAL_EXIT[s] || 1);
    };
    proc.on(s, h);
    handlers.push([s, h]);
  }
  return () => { for (const [s, h] of handlers) proc.removeListener(s, h); };
}

const META = /[&|<>^"]/;

/**
 * Write the launch files for one fresh-profile Chrome. `windowOuter` = "W,H" written to winsize.txt
 * (the launcher's --window-size, the OUTER window). Every run writes or deletes every file so no
 * experimental arm leaks into the next launch (hbbench.mjs's rule since 2026-10-25).
 */
export async function prepareLaunch({ profile, windowOuter = "1280,720", uncapped = false, chrome = {} }) {
  for (const v of [profile, windowOuter]) if (META.test(String(v))) throw new Error(`cmd metacharacters are not allowed (${v})`);
  await sshRetry(`echo ${profile}> D:\\Temp\\hbbench\\profile.txt`);
  await sshRetry(`echo ${windowOuter}> D:\\Temp\\hbbench\\winsize.txt`);
  await sshRetry(uncapped ? "echo 1> D:\\Temp\\hbbench\\uncapped.txt" : "if exist D:\\Temp\\hbbench\\uncapped.txt del D:\\Temp\\hbbench\\uncapped.txt");
  const ch = chrome || {};
  for (const [file, val] of [["angle.txt", ch.angle || ""], ["disablefeatures.txt", ch.disableFeatures || ""], ["extraflags.txt", ch.extraFlags || ""]]) {
    if (META.test(val)) throw new Error(`${file}: cmd metacharacters are not allowed (${val})`);
    await sshRetry(val ? `echo ${val}> D:\\Temp\\hbbench\\${file}` : `if exist D:\\Temp\\hbbench\\${file} del /q D:\\Temp\\hbbench\\${file}`);
  }
}

/** The scheduled task + launcher every existing caller uses (hbprobe-launch.bat: fresh D:\Temp\hbbench\ profile). */
export const LAUNCH_DEFAULTS = Object.freeze({ task: "hbprobe", launcher: "D:\\Temp\\hbbench\\hbprobe-launch.bat" });

/**
 * The box command that (re)creates and runs the hidden launch task (2026-10-30, M1c lane: `task` /
 * `launcher` are optional, so another launcher .bat, e.g. m1c-webac.mjs's persistent-profile one, rides
 * the same hidden-run.vbs path). With no options it is byte-identical to the command launchChrome
 * always sent (tests/m1c_webac.test.mjs pins that).
 */
export function launchTaskCommand({ task = LAUNCH_DEFAULTS.task, launcher = LAUNCH_DEFAULTS.launcher } = {}) {
  if (!/^hb[A-Za-z0-9_-]{1,40}$/.test(String(task))) throw new Error(`launch task name must be hb<word> (got ${task})`);
  if (META.test(String(launcher)) || /\s/.test(String(launcher)) || !/^[A-Za-z]:\\[^\s]+\.bat$/i.test(String(launcher))) throw new Error(`launcher must be an absolute .bat path without spaces or cmd metacharacters (got ${launcher})`);
  return `schtasks /create /tn ${task} /tr "wscript.exe //B //Nologo D:\\Temp\\hbbench\\hidden-run.vbs ${launcher}" /sc once /st 00:00 /it /f >nul 2>nul & schtasks /run /tn ${task} >nul`;
}

/**
 * Start the test Chrome through the hidden scheduled task, wait for CDP. Returns true when CDP answered.
 * Every option is optional (existing callers pass only `cdp`): `task` / `launcher` (launchTaskCommand),
 * and for the suite `run` (async box command, default sshRetry), `fetch`, `sleep`, `tries` (default 40).
 */
export async function launchChrome(cdp = CDP, o = {}) {
  const run = o.run || sshRetry, fetchFn = o.fetch || fetch, sleepFn = o.sleep || sleep, tries = o.tries ?? 40;
  await run(launchTaskCommand({ task: o.task, launcher: o.launcher }));
  for (let i = 0; i < tries; i++) {
    try { if ((await fetchFn(`${cdp}/json/version`)).ok) return true; } catch (_) { /* not up yet */ }
    await sleepFn(1000);
  }
  return false;
}

// ------------------------------------------------------------------------------------------------
// Kill by an exact --user-data-dir (2026-10-30, M1c lane; killBench above is unchanged)
// ------------------------------------------------------------------------------------------------

const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Regex source (the same text in .NET and JS, matched case-insensitively) for a Chrome command line
 * whose --user-data-dir is EXACTLY `profile` (quoted or not): `C:\Temp\cdpwb-wls` matches, while
 * `C:\Temp\cdpwb-wls2`, `C:\Temp\cdpwb-wls-old` and every D:\Temp\hbbench\ bench profile do not.
 */
export function chromeProfilePattern(profile) {
  const p = String(profile || "");
  if (!/^[A-Za-z]:\\[^\s"'&|<>^%]+$/.test(p)) throw new Error(`profile must be an absolute Windows path without spaces, quotes or cmd metacharacters (got ${p})`);
  return `--user-data-dir="?${reEscape(p)}"?(?=\\s|$)`;
}

/**
 * Which Chrome processes a profile kill takes (the JS twin of profileKillScript's selection, so the
 * suite can pin it on process lists). `procs` = [{pid, ppid, name, cmd}]. A ROOT is a chrome.exe
 * browser process (no --type=) on exactly that profile that ALSO carries every `requireFlags` switch
 * (so the owner's on-screen, unmuted MODE P Chrome on the same profile is never a root); the kill set
 * is those roots, their children on the profile, and orphaned children on the profile (parent no
 * longer a chrome.exe). Nothing is ever matched by image name alone.
 */
export function selectProfileKill(procs, profile, { requireFlags = [] } = {}) {
  const re = new RegExp(chromeProfilePattern(profile), "i");
  const chrome = (procs || []).filter((p) => String(p.name || "").toLowerCase() === "chrome.exe");
  const ids = new Set(chrome.map((p) => p.pid));
  const all = chrome.filter((p) => re.test(String(p.cmd || "")));
  const roots = new Set(all.filter((p) => !/--type=/i.test(p.cmd) && requireFlags.every((f) => new RegExp(reEscape(f), "i").test(p.cmd))).map((p) => p.pid));
  const kill = all.filter((p) => roots.has(p.pid) || roots.has(p.ppid) || (/--type=/i.test(p.cmd) && !ids.has(p.ppid)));
  return { matched: all.map((p) => p.pid), roots: [...roots], kill: kill.map((p) => p.pid) };
}

/**
 * PowerShell for the box: the selectProfileKill rule over Win32_Process, Stop-Process on the kill set
 * (none with `dryRun`), and one `HBKILL matched=N roots=N killed=N muted=N offscreen=N` line.
 */
export function profileKillScript(profile, { requireFlags = [], dryRun = false } = {}) {
  const re = chromeProfilePattern(profile);
  for (const f of requireFlags) if (/['"\s]/.test(f)) throw new Error(`requireFlags: no quotes or spaces (${f})`);
  const flagTest = requireFlags.map((f) => ` -and $_.CommandLine -match '${reEscape(f)}'`).join("");
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$re = '${re}'`,
    "$chrome = @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\")",
    "$ids = @($chrome | ForEach-Object { [int]$_.ProcessId })",
    "$all = @($chrome | Where-Object { $_.CommandLine -match $re })",
    `$roots = @($all | Where-Object { $_.CommandLine -notmatch '--type='${flagTest} } | ForEach-Object { [int]$_.ProcessId })`,
    "$kill = @($all | Where-Object { $roots -contains [int]$_.ProcessId -or $roots -contains [int]$_.ParentProcessId -or ($_.CommandLine -match '--type=' -and $ids -notcontains [int]$_.ParentProcessId) })",
    "$br = @($all | Where-Object { $_.CommandLine -notmatch '--type=' })",
    "$muted = @($br | Where-Object { $_.CommandLine -match '--mute-audio' }).Count",
    "$off = @($br | Where-Object { $_.CommandLine -match '--window-position=-32000,-32000' }).Count",
    dryRun ? "$n = 0" : "$n = 0; foreach ($p in $kill) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }",
    "\"HBKILL matched=$($all.Count) roots=$($roots.Count) killed=$n browsers=$($br.Count) muted=$muted offscreen=$off\"",
  ].join("\n");
}

/** `HBKILL k=v ...` -> numbers ({error} when the line is missing). */
export function parseKillLine(stdout) {
  const line = String(stdout || "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("HBKILL "));
  if (!line) return { error: `no HBKILL line in ${JSON.stringify(String(stdout || "").slice(0, 200))}` };
  const out = {};
  for (const tok of line.slice(7).split(/\s+/)) { const [k, v] = tok.split("="); if (k && v !== undefined) out[k] = Number(v); }
  return out;
}

/**
 * Kill the Chrome of exactly one --user-data-dir on the box (profileKillScript), synchronously so a
 * signal handler can use it. Never throws: returns parseKillLine's result or {error}. `run` = a sync
 * box command (default ssh).
 */
export function killChromeByProfile(profile, { requireFlags = [], dryRun = false, run = ssh } = {}) {
  try {
    const b64 = encodePowerShell(profileKillScript(profile, { requireFlags, dryRun }));
    return parseKillLine(run(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${b64}`));
  } catch (e) { return { error: String((e && e.message) || e).slice(0, 300) }; }
}

/**
 * One box sample: hbwho.ps1's line + the top processes by CPU over ~2 s (core-equivalents, ours
 * marked). Never throws: a failed sample is recorded as {error}, and hbreport treats a segment
 * without samples as unverified, not as valid. Optional (M1c lane, 2026-10-30): `script` replaces
 * boxSampleScript's text (m1c-webac.mjs marks its persistent-profile Chrome as ours), `run` the ssh.
 */
export async function boxSample(label, { windowMs = 2000, script = null, run = null } = {}) {
  const at = new Date().toISOString();
  const t0 = Date.now();
  try {
    const b64 = encodePowerShell(script || boxSampleScript({ windowMs }));
    const out = await (run || sshRetry)(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${b64}`, { timeout: 45000, tries: 2, delays: [3000] });
    const s = parseBoxSample(out);
    return { label, at, ms: Date.now() - t0, who: s.who, top: s.top, wallMs: s.wallMs, cores: s.cores, ...(s.raw ? { raw: s.raw } : {}) };
  } catch (e) {
    return { label, at, ms: Date.now() - t0, error: String((e && e.message) || e).slice(0, 300) };
  }
}
