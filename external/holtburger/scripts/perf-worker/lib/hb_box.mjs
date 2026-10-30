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

/** Start the test Chrome through the hidden scheduled task, wait for CDP. Returns true when CDP answered. */
export async function launchChrome(cdp = CDP) {
  await sshRetry('schtasks /create /tn hbprobe /tr "wscript.exe //B //Nologo D:\\Temp\\hbbench\\hidden-run.vbs D:\\Temp\\hbbench\\hbprobe-launch.bat" /sc once /st 00:00 /it /f >nul 2>nul & schtasks /run /tn hbprobe >nul');
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${cdp}/json/version`)).ok) return true; } catch (_) { /* not up yet */ }
    await sleep(1000);
  }
  return false;
}

/**
 * One box sample: hbwho.ps1's line + the top processes by CPU over ~2 s (core-equivalents, ours
 * marked). Never throws: a failed sample is recorded as {error}, and hbreport treats a segment
 * without samples as unverified, not as valid.
 */
export async function boxSample(label, { windowMs = 2000 } = {}) {
  const at = new Date().toISOString();
  const t0 = Date.now();
  try {
    const b64 = encodePowerShell(boxSampleScript({ windowMs }));
    const out = await sshRetry(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${b64}`, { timeout: 45000, tries: 2, delays: [3000] });
    const s = parseBoxSample(out);
    return { label, at, ms: Date.now() - t0, who: s.who, top: s.top, wallMs: s.wallMs, cores: s.cores, ...(s.raw ? { raw: s.raw } : {}) };
  } catch (e) {
    return { label, at, ms: Date.now() - t0, error: String((e && e.message) || e).slice(0, 300) };
  }
}
