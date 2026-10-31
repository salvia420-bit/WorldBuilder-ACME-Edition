// tests/m1c_webac.test.mjs — scripts/perf-worker/m1c-webac.mjs (M1c-WEBAC, the W arm) and the M1c
// additions to lib/hb_box.mjs, against fakes only (2026-10-30, lane M1C).
//   node scripts/perf-worker/tests/m1c_webac.test.mjs        (any cwd)
// NO BOX, NO BROWSER: `ssh` on PATH is a stub that fails and logs (checked empty at the end), HB_CDP points at
// a dead local port before any import, the box is a fake that decodes the encoded PowerShell it is sent, and
// the "Chrome" is a fake CDP server on 127.0.0.1:0 (HTTP /json/* + WebSocket targets) driven over real
// loopback WebSockets by lib/cdp_raw.mjs. Time is virtual (sleep advances a clock).
// Pins: argument parsing; credentials from the environment and redacted in every log line and file; the
// WebAC URL equals the queue recipe's; the shim equals the lessons doc's (and does what it says); the
// launcher .bat; launchChrome's default command byte-identical to the pre-M1c one; the profile kill
// matches only C:\Temp\hbm1c-webac (never the user's, the bench's or the owner's MODE P Chrome); the
// measure-perf statistics ports; the settle rule; preflight refusal with the recipe's start commands;
// the step order of a whole rep (shim before navigate; gate before teleport; settle; measure-perf's
// idle sequence; teardown kill before the account wait); renderer refusal before any login; Ctrl-C
// kills the W Chrome before exit; the W JSON round-trips through hbreport.py m1c (python3 -I).
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import http from "node:http";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const PW = join(HERE, "..");

// ---- guards first: no ssh, no real CDP endpoint ---------------------------------------------------
const SSH_GUARD = mkdtempSync(join(tmpdir(), "m1c-nossh-"));
const SSH_LOG = join(SSH_GUARD, "ssh-attempts.log");
writeFileSync(join(SSH_GUARD, "ssh"), `#!/bin/sh\necho "$@" >> '${SSH_LOG}'\necho "m1c_webac.test: ssh blocked" >&2\nexit 255\n`);
chmodSync(join(SSH_GUARD, "ssh"), 0o755);
process.env.PATH = `${SSH_GUARD}:${process.env.PATH}`;
process.env.HB_CDP = "http://127.0.0.1:9"; // discard port: a stray default CDP call fails locally, never reaches a tunnel
{
  const g = spawnSync("ssh", ["m1c-guard-selftest"], { encoding: "utf8" });
  if (g.status !== 255 || !/ssh blocked/.test(g.stderr || "")) { console.log("[FAIL] ssh guard not in effect: refusing to run the suite"); process.exit(1); }
  writeFileSync(SSH_LOG, "");
}
const TMP = mkdtempSync(join(tmpdir(), "m1c-webac-test-"));

let pass = 0, fail = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); pass++; console.log(`[PASS] ${name}`); }
  catch (e) { fail++; failures.push(name); console.log(`[FAIL] ${name}\n       ${String(e && e.stack || e).split("\n").slice(0, 8).join("\n       ")}`); }
}

const tryImport = async (rel) => { try { return { m: await import(join(PW, rel)) }; } catch (e) { return { err: e }; } };
const I = { m1c: await tryImport("m1c-webac.mjs"), box: await tryImport("lib/hb_box.mjs"), v2: await tryImport("lib/hb_v2.mjs") };
const M = I.m1c.m || {}, BOX = I.box.m || {}, V2 = I.v2.m || {};

await check("modules import without side effects; the tool exports its parts", () => {
  for (const [k, r] of Object.entries(I)) assert.ok(!r.err, `${k}: ${r.err && r.err.stack}`);
  for (const f of ["parseArgs", "credentials", "buildWebacUrl", "redact", "runRep", "main", "preflight", "launcherBat", "phaseStats", "summarizeInfoSamples", "settleStep", "buildWResult"]) assert.equal(typeof M[f], "function", f);
  for (const f of ["launchTaskCommand", "launchChrome", "chromeProfilePattern", "selectProfileKill", "profileKillScript", "killChromeByProfile", "parseKillLine", "boxSample", "killBench", "armKillOnSignal"]) assert.equal(typeof BOX[f], "function", f);
});

const QUEUE = JSON.parse(readFileSync(join(PW, "../../apps/holtburger-web/docs/reengineering/queue-1070/batch-R3-M1-2026-10-30.json"), "utf8"));
const ITEM = QUEUE.items.find((i) => i.id === "M1c-WEBAC");
const LESSONS = readFileSync(join(PW, "../../apps/holtburger-web/docs/2026-10-29-webac-openac-renderer-lessons.md"), "utf8");

// ------------------------------------------------------------------------------------------
// Arguments, credentials, URL, redaction
// ------------------------------------------------------------------------------------------
await check("parseArgs: defaults, values, and refusals of anything malformed", () => {
  const o = M.parseArgs(["--rep", "2", "--out", "/tmp/x"]);
  assert.equal(o.rep, 2);
  assert.equal(o.out, "/tmp/x");
  assert.equal(o.urlBase, "http://127.0.0.1:3000");
  assert.equal(o.bridge, "ws://127.0.0.1:9090");
  assert.equal(o.secs, 20);
  assert.equal(o.dryRun, false);
  assert.equal(o.uncapped, true, "uncapped by default, like the H arms' --uncapped");
  assert.equal(o.window, "1920,1080");
  assert.equal(o.degmul, 1);
  assert.equal(o.drawDistance, 8);
  const p = M.parseArgs(["--rep", "3", "--out", "/tmp/y", "--url-base", "http://127.0.0.1:3001/", "--bridge", "ws://127.0.0.1:9091", "--secs", "15", "--dry-run", "--capped", "--no-box-samples"]);
  assert.equal(p.urlBase, "http://127.0.0.1:3001");
  assert.equal(p.bridge, "ws://127.0.0.1:9091");
  assert.equal(p.secs, 15);
  assert.equal(p.dryRun, true);
  assert.equal(p.uncapped, false);
  assert.equal(p.boxSamples, false);
  for (const bad of [[], ["--out", "/x"], ["--rep", "0", "--out", "/x"], ["--rep", "x", "--out", "/x"], ["--rep", "1"], ["--rep", "1", "--out", "/x", "--secs", "-3"],
    ["--rep", "1", "--out", "/x", "--url-base", "http://127.0.0.1:3000/?nocache"], ["--rep", "1", "--out", "/x", "--bridge", "http://127.0.0.1:9090"],
    ["--rep", "1", "--out", "/x", "--frobnicate"], ["--rep", "--out", "/x"], ["--rep1", "--out", "/x"]]) {
    assert.throws(() => M.parseArgs(bad), Error, JSON.stringify(bad));
  }
  assert.deepEqual(M.parseArgs(["--predict-hour", "/a/W-r1.json", "--at", "2026-10-30T22:00:00Z"]), { predictHour: "/a/W-r1.json", at: "2026-10-30T22:00:00Z" });
});

await check("credentials: env first; unset = the bench's own account (from lib/hb_v2.mjs at run time); another account needs its password", () => {
  const bench = M.benchDefaults();
  assert.equal(bench.account, "tailnet1", "the bench account the queue names");
  const d = M.credentials({});
  assert.equal(d.account, "tailnet1");
  assert.equal(d.password, bench.password);
  assert.match(d.passwordSource, /bench default/);
  const e = M.credentials({ M1C_ACCOUNT: "webacdev", M1C_PASSWORD: "pw-from-env" });
  assert.deepEqual([e.account, e.password, e.accountSource, e.passwordSource], ["webacdev", "pw-from-env", "env M1C_ACCOUNT", "env M1C_PASSWORD"]);
  assert.throws(() => M.credentials({ M1C_ACCOUNT: "webacdev" }), /M1C_PASSWORD is required/);
  assert.throws(() => M.credentials({ M1C_ACCOUNT: "bad name", M1C_PASSWORD: "x" }), /letters, digits/);
  // the tool's source never spells out a password literal (credentials are read at run time only)
  const src = readFileSync(join(PW, "m1c-webac.mjs"), "utf8");
  assert.ok(!/password\s*[:=]\s*["'][^"'$]/i.test(src.replace(/password=\*\*\*/g, "")), "no password literal in m1c-webac.mjs");
});

await check("the WebAC URL is the queue recipe's and the lessons doc's (?ace&bridge&account&password&degmul=1), credentials URI-encoded", () => {
  const recipeUrl = ITEM.recipe.map((s) => (/(http:\/\/127\.0\.0\.1:3000\/\?ace\S+)/.exec(s) || [])[1]).find(Boolean);
  assert.ok(recipeUrl, "the recipe names the URL");
  assert.equal(M.buildWebacUrl({ account: "<ACCT>", password: "<PW>" }).replace("%3CACCT%3E", "<ACCT>").replace("%3CPW%3E", "<PW>"), recipeUrl);
  assert.ok(LESSONS.includes(recipeUrl), "the lessons doc step 7 names the same URL");
  assert.equal(M.buildWebacUrl({ account: "a", password: "p q&r" }), "http://127.0.0.1:3000/?ace&bridge=ws://127.0.0.1:9090&account=a&password=p%20q%26r&degmul=1");
  assert.ok(!/nocache/.test(M.buildWebacUrl({ account: "a", password: "b" })));
  assert.equal(M.bridgeHealthUrl("ws://127.0.0.1:9090"), "http://127.0.0.1:9090/healthz");
  assert.ok(ITEM.recipe.some((s) => s.includes(`acDebug.admin('${M.TELELOC}')`)), "the recipe's teleloc is the tool's");
});

await check("redact: password= values and the literal / encoded password vanish", () => {
  const s = M.redact("go http://h/?ace&account=tailnet1&password=Zq9%20s3cret%26x&degmul=1 and Zq9 s3cret&x", { password: "Zq9 s3cret&x", account: "tailnet1" });
  assert.ok(!/s3cret/.test(s), s);
  assert.match(s, /password=\*\*\*&degmul=1/);
  assert.match(s, /account=tailnet1/);
  assert.equal(M.redact("x password=abc", {}), "x password=***");
});

// ------------------------------------------------------------------------------------------
// The shim
// ------------------------------------------------------------------------------------------
await check("DAT_SHIM is the lessons doc section 5.1 step 6 shim, byte for byte", () => {
  const lines = LESSONS.split("\n");
  const at = lines.findIndex((l) => l.includes("**Shim:**"));
  assert.ok(at > 0, "the doc has a Shim block");
  const open = lines.findIndex((l, i) => i > at && /```js/.test(l));
  const close = lines.findIndex((l, i) => i > open && /```/.test(l));
  const docShim = lines.slice(open + 1, close).map((l) => l.replace(/^ {3}/, "")).join("\n").trim();
  assert.equal(M.DAT_SHIM, docShim);
  assert.ok(ITEM.recipe.some((s) => /portal 2074 \/ cell 982 \/ language 994/.test(s)), "the queue names the same iterations");
});

await check("DAT_SHIM does what the doc says: every datIterations write reports portal 2074 / cell 982 / language 994", () => {
  const run = () => { const ctx = { window: {} }; vm.createContext(ctx); vm.runInContext(M.DAT_SHIM, ctx); return ctx; };
  // accessor on the prototype (ClientConnection-like)
  const a = run();
  class Conn { constructor() { this._it = null; } get datIterations() { return this._it; } set datIterations(v) { this._it = v; } }
  const c = new Conn();
  a.window.__aceConnection = c;
  assert.equal(a.window.__aceConnection, c);
  c.datIterations = { portal: 2072, cell: 1, language: 3 };
  assert.deepEqual({ ...c._it }, { portal: 2074, cell: 982, language: 994 });
  // a plain data property
  const b = run();
  const plain = { datIterations: { portal: 0, cell: 0, language: 0 } };
  b.window.__aceConnection = plain;
  plain.datIterations = { portal: 2072, cell: 1, language: 3 };
  assert.deepEqual({ ...plain.datIterations }, { portal: 2074, cell: 982, language: 994 });
});

// ------------------------------------------------------------------------------------------
// hb_box additions (backward compatible)
// ------------------------------------------------------------------------------------------
await check("hb_box launchTaskCommand(): with no options byte-identical to the pre-M1c launchChrome command; the W task + launcher ride hidden-run.vbs", () => {
  assert.equal(BOX.launchTaskCommand(), 'schtasks /create /tn hbprobe /tr "wscript.exe //B //Nologo D:\\Temp\\hbbench\\hidden-run.vbs D:\\Temp\\hbbench\\hbprobe-launch.bat" /sc once /st 00:00 /it /f >nul 2>nul & schtasks /run /tn hbprobe >nul');
  assert.equal(BOX.launchTaskCommand({ task: M.TASK, launcher: M.LAUNCHER }), 'schtasks /create /tn hbm1cwebac /tr "wscript.exe //B //Nologo D:\\Temp\\hbbench\\hidden-run.vbs D:\\Temp\\hbbench\\m1c-webac-launch.bat" /sc once /st 00:00 /it /f >nul 2>nul & schtasks /run /tn hbm1cwebac >nul');
  for (const bad of [{ task: "x&y" }, { task: "probe" }, { launcher: "D:\\Temp\\a b.bat" }, { launcher: "D:\\Temp\\x.bat&calc" }, { launcher: "relative.bat" }]) assert.throws(() => BOX.launchTaskCommand(bad), Error, JSON.stringify(bad));
});

await check("hb_box launchChrome(cdp, {task, launcher, run, fetch, sleep}): sends the task command, polls /json/version", async () => {
  const sent = [], fetched = [];
  let n = 0;
  const ok = await BOX.launchChrome("http://fake:1", { task: M.TASK, launcher: M.LAUNCHER, run: async (c) => { sent.push(c); }, fetch: async (u) => { fetched.push(u); if (++n < 3) throw new Error("down"); return { ok: true }; }, sleep: async () => {} });
  assert.equal(ok, true);
  assert.deepEqual(sent, [BOX.launchTaskCommand({ task: M.TASK, launcher: M.LAUNCHER })]);
  assert.deepEqual(fetched, ["http://fake:1/json/version", "http://fake:1/json/version", "http://fake:1/json/version"]);
  const no = await BOX.launchChrome("http://fake:1", { run: async () => {}, fetch: async () => { throw new Error("down"); }, sleep: async () => {}, tries: 4 });
  assert.equal(no, false);
});

const CH = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"';
const W_ROOT = `${CH} --remote-debugging-port=9333 --use-angle=d3d11 --ignore-gpu-blocklist --mute-audio --user-data-dir=C:\\Temp\\hbm1c-webac --window-position=-32000,-32000 --window-size=1920,1080 --no-first-run about:blank`;
const PROCS = [
  { pid: 100, ppid: 4, name: "chrome.exe", cmd: W_ROOT },
  { pid: 101, ppid: 100, name: "chrome.exe", cmd: `${CH} --type=renderer --user-data-dir="C:\\Temp\\hbm1c-webac" --lang=en-US` },
  { pid: 102, ppid: 100, name: "chrome.exe", cmd: `${CH} --type=gpu-process --user-data-dir="C:\\Temp\\hbm1c-webac" --gpu-preferences=x` },
  { pid: 103, ppid: 999, name: "chrome.exe", cmd: `${CH} --type=utility --user-data-dir="C:\\Temp\\hbm1c-webac"` }, // orphan of an earlier W Chrome
  { pid: 200, ppid: 4, name: "chrome.exe", cmd: `${CH} --remote-debugging-port=9333 --use-angle=d3d11 --mute-audio --user-data-dir=D:\\Temp\\hbbench\\hbb-bench-H-default-1-1761868800000 --window-position=-32000,-32000` },
  { pid: 201, ppid: 200, name: "chrome.exe", cmd: `${CH} --type=renderer --user-data-dir="D:\\Temp\\hbbench\\hbb-bench-H-default-1-1761868800000"` },
  { pid: 300, ppid: 4, name: "chrome.exe", cmd: CH }, // the user's own Chrome
  { pid: 301, ppid: 300, name: "chrome.exe", cmd: `${CH} --type=renderer --user-data-dir="C:\\Users\\owner\\AppData\\Local\\Google\\Chrome\\User Data"` },
  { pid: 400, ppid: 4, name: "chrome.exe", cmd: `${CH} --remote-debugging-port=9333 --mute-audio --user-data-dir=C:\\Temp\\hbm1c-webac2 --window-position=-32000,-32000` },
  { pid: 401, ppid: 4, name: "chrome.exe", cmd: `${CH} --mute-audio --user-data-dir=C:\\Temp\\hbm1c-webac-old --window-position=-32000,-32000 --remote-debugging-port=9333` },
  { pid: 402, ppid: 4, name: "chrome.exe", cmd: `${CH} --mute-audio --user-data-dir=D:\\Temp\\hbm1c-webac --window-position=-32000,-32000 --remote-debugging-port=9333` },
  { pid: 500, ppid: 4, name: "powershell.exe", cmd: "powershell -File x.ps1 --user-data-dir=C:\\Temp\\hbm1c-webac" }, // the right text, not a chrome.exe
  { pid: 600, ppid: 4, name: "chrome.exe", cmd: `${CH} --remote-debugging-port=9333 --use-angle=d3d11 --ignore-gpu-blocklist --mute-audio --user-data-dir=C:\\Temp\\cdpwb-wls --window-position=-32000,-32000` }, // the owner's MODE P profile (2026-10-30: W no longer shares it)
  { pid: 601, ppid: 600, name: "chrome.exe", cmd: `${CH} --type=renderer --user-data-dir="C:\\Temp\\cdpwb-wls"` },
];

await check("kill pattern: matches only --user-data-dir=C:\\Temp\\hbm1c-webac (quoted or not, any case); never the user's, the bench's or a look-alike", () => {
  const re = new RegExp(BOX.chromeProfilePattern(M.PROFILE), "i");
  const hit = PROCS.filter((p) => re.test(p.cmd)).map((p) => p.pid);
  assert.deepEqual(hit, [100, 101, 102, 103, 500], "the PowerShell line matches the text; selectProfileKill keeps chrome.exe only");
  assert.ok(re.test(`${CH} --mute-audio --user-data-dir=c:\\temp\\HBM1C-WEBAC`), "Windows paths are case-insensitive");
  assert.ok(re.test(`${CH} --user-data-dir=C:\\Temp\\hbm1c-webac`), "at the end of the line");
  const k = BOX.selectProfileKill(PROCS, M.PROFILE, { requireFlags: [...M.ROOT_FLAGS] });
  assert.deepEqual(k.roots, [100]);
  assert.deepEqual(k.kill, [100, 101, 102, 103]);
  for (const pid of [200, 201, 300, 301, 400, 401, 402, 500, 600, 601]) assert.ok(!k.kill.includes(pid), `never ${pid}`);
  assert.throws(() => BOX.chromeProfilePattern("C:\\Temp\\a b"), /without spaces/);
  assert.throws(() => BOX.chromeProfilePattern("relative"), /absolute/);
});

await check("kill: the owner's on-screen MODE P Chrome on the same profile (unmuted, maximized) is never a root, never killed; the box check still sees it", () => {
  const modeP = [
    { pid: 700, ppid: 4, name: "chrome.exe", cmd: `${CH} --remote-debugging-port=9333 --use-angle=d3d11 --ignore-gpu-blocklist --autoplay-policy=no-user-gesture-required --user-data-dir=C:\\Temp\\hbm1c-webac --start-maximized --no-first-run about:blank` },
    { pid: 701, ppid: 700, name: "chrome.exe", cmd: `${CH} --type=renderer --user-data-dir="C:\\Temp\\hbm1c-webac"` },
  ];
  const k = BOX.selectProfileKill(modeP, M.PROFILE, { requireFlags: [...M.ROOT_FLAGS] });
  assert.deepEqual(k.kill, []);
  assert.deepEqual(k.matched, [700, 701], "the dry-run count the box check refuses on");
});

const decodePs = (cmd) => { const m = /-EncodedCommand (\S+)/.exec(String(cmd)); return m ? Buffer.from(m[1], "base64").toString("utf16le") : null; };

await check("profileKillScript / killChromeByProfile: the same regex and root flags on the box, Stop-Process only when not a dry run, one HBKILL line", () => {
  const s = BOX.profileKillScript(M.PROFILE, { requireFlags: [...M.ROOT_FLAGS] });
  assert.ok(s.includes(`$re = '${BOX.chromeProfilePattern(M.PROFILE)}'`));
  assert.ok(s.includes("Name='chrome.exe'"), "chrome.exe only");
  for (const f of M.ROOT_FLAGS) assert.ok(s.includes(`-match '${f}'`), f);
  assert.ok(s.includes("Stop-Process"));
  assert.ok(!/taskkill|\/IM chrome/i.test(s), "never by image name");
  assert.ok(!BOX.profileKillScript(M.PROFILE, { dryRun: true }).includes("Stop-Process"));
  const sent = [];
  const r = BOX.killChromeByProfile(M.PROFILE, { requireFlags: [...M.ROOT_FLAGS], run: (cmd) => { sent.push(cmd); return "noise\r\nHBKILL matched=4 roots=1 killed=4 browsers=1 muted=1 offscreen=1\r\n"; } });
  assert.deepEqual(r, { matched: 4, roots: 1, killed: 4, browsers: 1, muted: 1, offscreen: 1 });
  assert.equal(decodePs(sent[0]), s);
  assert.deepEqual(Object.keys(BOX.killChromeByProfile(M.PROFILE, { run: () => { throw new Error("box gone"); } })), ["error"], "never throws");
});

await check("hb_box boxSample(label, {script, run}): an injected script and runner; the default call is unchanged", async () => {
  const sent = [];
  const s = await BOX.boxSample("x", { script: "Write-Output hi", run: async (cmd, o) => { sent.push([cmd, o]); return 'HBWHO idle=900 gpu3d_other=1\r\nHBTOP {"wallMs":2000,"cores":8,"top":[{"n":"chrome","p":5,"c":0.5,"o":1}]}\r\n'; } });
  assert.equal(decodePs(sent[0][0]), "Write-Output hi");
  assert.equal(sent[0][1].timeout, 45000);
  assert.equal(s.who.idle, 900);
  assert.deepEqual(s.top, [{ name: "chrome", pid: 5, cores: 0.5, ours: true }]);
  const w = M.wBoxSampleScript();
  assert.equal(w.oursRule, "the hbm1c-webac Chrome and its children");
  assert.ok(w.script.includes(`$_.CommandLine -match '${BOX.chromeProfilePattern(M.PROFILE)}'`));
  assert.ok(!w.script.includes("-like '*D:\\Temp\\hbbench\\*'"), "the roots rule was swapped");
  assert.equal(w.script.replace(`$_.CommandLine -match '${BOX.chromeProfilePattern(M.PROFILE)}'`, "$_.CommandLine -like '*D:\\Temp\\hbbench\\*'"), V2.boxSampleScript({ windowMs: 2000 }), "only the roots rule differs");
});

// ------------------------------------------------------------------------------------------
// The launcher
// ------------------------------------------------------------------------------------------
await check("launcher .bat: owner gate first, muted, off-screen (never minimized), 1920,1080, the persistent profile, CDP 9333, uncapped by default; no log console", () => {
  const bat = M.launcherBat({});
  assert.ok(bat.includes("\r\n") && !/[^\r]\n/.test(bat), "CRLF");
  assert.ok(/^[\x20-\x7e\r\n]*$/.test(bat), "ASCII only (the box check compares byte counts)");
  const lines = bat.split("\r\n");
  const gate = lines.findIndex((l) => l.includes("hbgate.ps1")), start = lines.findIndex((l) => /^start "" "C:\\Program Files/.test(l));
  assert.ok(gate > 0 && start > gate, "hbgate.ps1 runs before Chrome starts");
  assert.equal(lines[gate + 1], "if errorlevel 1 exit /b 1");
  const s = lines[start];
  for (const f of ["--remote-debugging-port=9333", "--use-angle=d3d11", "--mute-audio", "--user-data-dir=C:\\Temp\\hbm1c-webac", "--window-position=-32000,-32000", "--window-size=1920,1080",
    "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion",
    "--disable-frame-rate-limit", "--disable-gpu-vsync", "about:blank"]) assert.ok(s.includes(f), f);
  for (const f of ["--enable-logging", "--start-maximized", "--start-minimized", "--headless", "--autoplay-policy"]) assert.ok(!bat.includes(f), `never ${f}`);
  assert.ok(lines.some((l) => l.includes("noflash.ps1")), "noflash.ps1 keeps it off the taskbar");
  const capped = M.launcherBat({ uncapped: false });
  assert.ok(!capped.includes("--disable-gpu-vsync") && !capped.includes("--disable-frame-rate-limit"));
  const ws = M.launcherWriteScript(bat);
  const b64 = /FromBase64String\('([^']+)'\)/.exec(ws)[1];
  assert.equal(Buffer.from(b64, "base64").toString("ascii"), bat, "the box gets the exact bytes");
  assert.ok(ws.includes(`'${M.LAUNCHER}'`));
});

// ------------------------------------------------------------------------------------------
// measure-perf statistics (ported 1:1 from tools/measure-perf.ts + tools/perf-ratchet-lib.ts)
// ------------------------------------------------------------------------------------------
await check("phaseStats = measure-perf stats(): same quantiles, rounding and hitch counts", () => {
  const d = [10, 10, 10, 20, 40, 60, 120, 10, 10, 10];
  assert.deepEqual(M.phaseStats("idle", d), { phase: "idle", durationMs: 300, frames: 10, avgFps: 33.3, p50Ms: 10, p95Ms: 120, p99Ms: 120, maxMs: 120, longFramePct: 30, hitch50: 2, hitch100: 1 });
  assert.deepEqual(M.renderJsStats([3, 1, 2, 4]), { frames: 4, p50Ms: 3, p95Ms: 4 });
  assert.equal(M.renderJsStats([]), null);
});

await check("summarizeInfoSamples / headingBin: per-sector means over 30-degree sectors with yaw, plain mean without", () => {
  assert.equal(M.headingBin(0), 0);
  assert.equal(M.headingBin(-0.01), 11);
  assert.equal(M.headingBin(Math.PI), 6);
  assert.equal(M.headingBin(4 * Math.PI + 0.1), 0);
  // sector 0: 100,100,100 (mean 100); sector 6: 400 (mean 400) -> heading mean 250 (frame mean would be 175)
  const s = [{ drawCalls: 100, triangles: 1, geometries: 5, yaw: 0 }, { drawCalls: 100, triangles: 1, geometries: 5, yaw: 0.1 }, { drawCalls: 100, triangles: 1, geometries: 5, yaw: 0.2 }, { drawCalls: 400, triangles: 3, geometries: 5, yaw: Math.PI }];
  const b = M.summarizeInfoSamples(s);
  assert.equal(b.drawCalls, 250);
  assert.equal(b.triangles, 2);
  assert.equal(b.headingBins, 2);
  assert.deepEqual(b.spread.drawCalls, { min: 100, max: 400 });
  const u = M.summarizeInfoSamples(s.map(({ yaw, ...r }) => r));
  assert.equal(u.drawCalls, 175);
  assert.equal(u.headingBins, undefined);
  assert.equal(M.summarizeInfoSamples([]), null);
});

await check("estimateRealGpu, droppedFrameWarnings, landblockOf, locationOf, mergeInfo match perf-ratchet-lib / measure-perf", () => {
  assert.deepEqual(M.estimateRealGpu(1000), { frameMs: 8.5, fps: 117.6 });
  assert.equal(M.estimateRealGpu(0).fps, Infinity);
  assert.deepEqual(M.droppedFrameWarnings({ frames: 10, rawDtTotal: 0, droppedFrames: 2 }, [{ phase: "idle", frameStats: { frames: 20, rawDtTotal: 0, droppedFrames: 3 } }]), []);
  assert.equal(M.droppedFrameWarnings(null, [{ phase: "idle", frameStats: { frames: 5, rawDtTotal: 0, droppedFrames: 5 } }]).length, 1);
  assert.equal(M.landblockOf(M.SPOT_WORLD.x, M.SPOT_WORLD.north), "0xa9b4ffff");
  assert.deepEqual(M.SPOT_WORLD, { x: 32544, north: 34656 });
  assert.deepEqual(M.locationOf({ x: 32544.31, y: 80.44, z: 34655.77 }), { x: 32544.3, y: 34655.8, z: 80.4, landblock: "0xa9b4ffff" });
  assert.deepEqual(M.mergeInfo({ drawCalls: 1, triangles: 2, geometries: 3, textures: 4 }, { drawCalls: 9, triangles: 8, geometries: 7 }), { drawCalls: 9, triangles: 8, geometries: 7, textures: 4 });
  assert.equal(M.mergeInfo(null, { drawCalls: 1 }), null);
});

await check("settle rule = measure-perf waitForSceneSettle: within max(1, 1 %) of the previous poll, 4 polls in a row", () => {
  const run = (ns) => { let st = { prev: -1, stablePolls: 0, plateau: false }; const at = []; ns.forEach((n, i) => { st = M.settleStep(st, n); if (st.plateau) at.push(i); }); return at[0] ?? null; };
  assert.equal(run([500, 900, 1000, 1004, 1008, 1009]), 5, "1000 -> 1004 -> 1008 -> 1009: 4 polls within 1 %");
  assert.equal(run([1000, 1011, 1022, 1033, 1044]), null, "1.1 % steps never settle");
  assert.equal(run([1000, 1010, 1020, 1030]), 3, "exactly 1 % is stable");
  assert.equal(run([10, 11, 12, 13]), 3, "small counts: max(1, ...) allows 1");
  assert.equal(run([1000, 1000, -1, 1000, 1000, 1000]), null, "a missing scene (-1) restarts the count");
  assert.equal(run([1000, 1000, 1000, 1000]), 3);
});

await check("renderer gate: GTX 1070 on D3D11 only", () => {
  assert.ok(M.rendererOk("ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 (0x00001B81) Direct3D11 vs_5_0 ps_5_0, D3D11)"));
  for (const bad of ["ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)", "ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 OpenGL 4.5)", "masked", "no-webgl", "", null]) assert.ok(!M.rendererOk(bad), String(bad));
});

await check("ACE hour: from a server-synced acDebug.timeOfDay() only; our --skytime argument; prediction for an H-first rep", () => {
  const r = M.skyReading({ timeOfDay: 0.5592, dayLengthSeconds: 7620, gameClock: 1.2e9, dayGroup: { name: "Sunny", index: 0, absoluteDay: 5, pinned: false } }, "2026-10-30T22:00:00.000Z");
  assert.equal(r.hour, 13.42);
  assert.equal(r.skytimeArg, "13.42");
  assert.equal(r.why, null);
  assert.equal(r.dayGroup.namesAgree, true);
  const u = M.skyReading({ timeOfDay: 0.5, dayLengthSeconds: 7620, gameClock: null }, "t");
  assert.equal(u.hour, null);
  assert.match(u.why, /not synced/);
  assert.match(M.skyReading({ why: "acDebug.timeOfDay is not exposed" }, "t").why, /not exposed/);
  assert.equal(M.skytimeArg(0.5), "0.0208", "an hour <= 1 goes as the 0-1 fraction (index.html reads v > 1 as hours)");
  assert.equal(M.skytimeArg(1), "0.0417");
  assert.equal(M.skytimeArg(23.999), "0.0000", "24.00 would not pin our sky: wraps to 0");
  assert.equal(M.skytimeArg(23.5), "23.50");
  const p = M.predictHour(r, Date.parse("2026-10-30T22:00:00.000Z") + 7620 * 1000 / 24 * 2); // two Dereth hours later
  assert.equal(p.hour, 15.42);
  assert.equal(M.predictHour(u, 0), null);
});

await check("login cool-down: the ACE log's last [LOGOUT] of the account and the >= 65 s gap", () => {
  const log = [
    "2026-10-30 20:52:28,940 [World Manager] DEBUG (ACE.Server.WorldObjects.Player) [LOGIN] Account tailnet1 entered the world with character +Tester (0x50000007) at 2026-10-30 8:52:28 PM.",
    "2026-10-30 20:57:03,293 [World Manager] DEBUG (ACE.Server.WorldObjects.Player) [LOGOUT] Account tailnet1 exited the world with character +Tester (0x50000007) at 2026-10-30 8:57:03 PM.",
    "2026-10-30 20:57:10,000 [World Manager] DEBUG (ACE.Server.WorldObjects.Player) [LOGIN] Account tailnet10 entered the world with character X at 2026-10-30 8:57:10 PM.",
  ].join("\n");
  const ev = M.lastAccountEvent(log, "tailnet1");
  assert.equal(ev.kind, "LOGOUT", "tailnet10 is another account");
  assert.equal(ev.at, new Date(2026, 9, 30, 20, 57, 3, 293).getTime());
  assert.equal(M.cooldownRemainingMs(ev, ev.at + 30000), 35000);
  assert.equal(M.cooldownRemainingMs(ev, ev.at + 70000), 0);
  assert.equal(M.cooldownRemainingMs({ kind: "LOGIN", at: 0 }, 1), 0);
  assert.equal(M.cooldownRemainingMs(null, 1), 0);
});

await check("recipe start commands come from the queue item verbatim (npm, dat links, bridge, vite, tunnel)", () => {
  const c = M.recipeStartCommands(QUEUE);
  const bridge = "setsid nohup npx tsx services/ws-tcp-bridge/src/bridge.ts 9090 127.0.0.1 9000 > /mnt/wbterminal2/webac-bridge.log 2>&1 &";
  const vite = "setsid nohup npx vite --host 127.0.0.1 --port 3000 --strictPort > /mnt/wbterminal2/webac-vite.log 2>&1 &";
  assert.ok(ITEM.recipe.some((s) => s.endsWith(bridge)) && ITEM.recipe.some((s) => s.endsWith(vite)), "the queue recipe still says this");
  assert.ok(c.includes(`cd /mnt/wbterminal1/ac-refs/webac && ${bridge}`), JSON.stringify(c));
  assert.ok(c.includes(`cd /mnt/wbterminal1/ac-refs/webac && ${vite}`));
  assert.ok(c.some((s) => s.includes("npm install")));
  assert.ok(c.some((s) => s.includes("ln -s /home/wbterminal/ac_base_dats/client_portal.dat")));
  assert.ok(c.some((s) => s.startsWith("Tunnel: add -R 3000:127.0.0.1:3000 -R 9090:127.0.0.1:9090")));
});

// ------------------------------------------------------------------------------------------
// A whole rep against a fake box + fake Chrome (real loopback CDP WebSockets)
// ------------------------------------------------------------------------------------------
const require = createRequire(import.meta.url);
const PWC = process.env.PLAYWRIGHT_CORE || "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core";
const { wsServer: WSS } = require(`${PWC}/lib/utilsBundle.js`);
const GOOD = "ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 (0x00001B81) Direct3D11 vs_5_0 ps_5_0, D3D11)";
const tagOf = (e) => (/^\/\*m1c:(\w+)\*\//.exec(String(e)) || [])[1] || (/innerWidth/.test(e) ? "size" : "fn");

function makeModel(over = {}) {
  const m = {
    alive: false, renderer: GOOD, pages: [{ id: "P1", url: "about:blank" }, { id: "P2", url: "chrome://whats-new/" }], outer: [1920, 1080], chromeUi: [16, 103],
    loadPolls: 0, inWorldAfter: 3, pos: { x: 1200.5, north: 2200.5, loginComplete: true }, teleportWorks: true, teleported: false,
    meshes: [500, 900, 1000, 1004, 1008, 1009, 1010], meshIdx: 0, drains: 0, admin: [], navigations: [], scripts: [], yawSets: 0, riCalls: 0, onLoadPoll: null,
    deltas: Array.from({ length: 1500 }, (_, i) => (i % 150 === 149 ? 30 : 13.3)), renderJs: Array.from({ length: 1500 }, (_, i) => 4 + (i % 10) / 10),
    sky: { timeOfDay: 0.5592, dayLengthSeconds: 7620, gameClock: 1.2e9, sunBrightness: 1, dayGroup: { name: "Sunny", index: 0, absoluteDay: 5, pinned: false }, why: null },
    ...over,
  };
  const value = (v) => ({ result: v === undefined ? { type: "undefined" } : { type: typeof v, value: v } });
  m.handle = async (target, method, p, emit) => {
    if (target === "browser") {
      if (method === "Browser.getWindowForTarget") { assert.equal(p.targetId, "P1", "window of the WebAC tab"); return { windowId: 7 }; }
      if (method === "Browser.setWindowBounds") { m.outer = [p.bounds.width, p.bounds.height]; return {}; }
      if (method === "Target.closeTarget") { m.pages = m.pages.filter((x) => x.id !== p.targetId); return { success: true }; }
      throw new Error(`fake browser: ${method}`);
    }
    if (method === "Page.addScriptToEvaluateOnNewDocument") { m.scripts.push(p.source); return { identifier: String(m.scripts.length) }; }
    if (method === "Page.navigate") { m.navigations.push(p.url); m.pages.find((x) => x.id === target).url = p.url; return { frameId: "F", loaderId: "L" }; }
    if (["Page.enable", "Runtime.enable", "Emulation.setFocusEmulationEnabled", "Page.handleJavaScriptDialog", "Emulation.setDeviceMetricsOverride"].includes(method)) return {};
    if (method !== "Runtime.evaluate") throw new Error(`fake page: ${method}`);
    const e = p.expression, t = tagOf(e);
    const inner = [m.outer[0] - m.chromeUi[0], m.outer[1] - m.chromeUi[1]];
    switch (t) {
      case "size": return value({ iw: inner[0], ih: inner[1], ow: m.outer[0], oh: m.outer[1], dpr: 1 });
      case "renderer": return value(m.renderer);
      case "loadState": {
        m.loadPolls++;
        if (m.loadPolls === 1) emit("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "[AC:DatCache] portal: served from OPFS cache (no re-download)" }] });
        if (m.onLoadPoll) m.onLoadPoll(m.loadPolls);
        const inW = m.loadPolls >= m.inWorldAfter;
        return value({ x: inW ? 32000.5 : null, loginComplete: inW, sceneManager: inW, screen: inW ? "world" : "connecting", opfsBytes: 1.33e9, readyState: "complete", visibility: "visible" });
      }
      case "worldPos": return value(m.teleported ? { x: 32544.4, north: 34655.6, loginComplete: true } : m.pos);
      case "admin": { const cmd = JSON.parse(/d\.admin\(("(?:[^"\\]|\\.)*")\)/.exec(e)[1]); m.admin.push(cmd); if (m.teleportWorks && cmd === M.TELELOC) m.teleported = true; return value(true); }
      case "setYaw": m.yawSets++; return value(true);
      case "countMeshes": return value(m.meshes[Math.min(m.meshIdx++, m.meshes.length - 1)]);
      case "sky": return value(m.sky);
      case "viewport": return value({ width: inner[0], height: inner[1], dpr: 1, outerWidth: m.outer[0], outerHeight: m.outer[1], visibility: "visible", focus: true });
      case "drawDistance": return value({ stored: 8, live: 8 });
      case "location": return value({ x: 32544.41, y: 80.42, z: 34655.63 });
      case "installRenderTimer": return value(true);
      case "renderInfo": m.riCalls++; return value({ drawCalls: 851, triangles: 120000, geometries: 400, textures: 310, programs: 41, frameStats: { frames: 1000 + 1500 * (m.riCalls - 1), rawDtTotal: 0, droppedFrames: 0 } });
      case "drainRenderTimer": return value(m.drains++ === 0 ? [99] : m.renderJs);
      case "samplePhase": {
        assert.ok(e.includes("if (t - start < 20000) requestAnimationFrame(tick);"), "the --secs window");
        return value({ deltas: m.deltas, infoSamples: m.deltas.map((_, i) => ({ atMs: Math.round(i * 13.3), drawCalls: 850 + (i % 3), triangles: 120000, geometries: 400, yaw: 0 })) });
      }
      case "sceneCensus": return value({ meshes: 1010, instanced: 12, categories: { part: { total: 600, beyond300: 20, beyond600: 4 } } });
      default: throw new Error(`fake page: unexpected evaluate ${t}: ${e.slice(0, 80)}`);
    }
  };
  return m;
}

async function fakeChrome(model) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const port = server.address().port;
    const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (!model.alive) { res.writeHead(404, { "content-type": "application/json" }); return res.end("{}"); }
    if (req.url === "/json/version") return json({ Browser: "Chrome/156.0.7390.0", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/B1` });
    if (req.url === "/json/list") return json(model.pages.map((p) => ({ id: p.id, type: "page", url: p.url, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${p.id}` })));
    res.writeHead(404); res.end();
  });
  const wss = new WSS({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const mm = /^\/devtools\/(browser|page)\/(\w+)$/.exec(req.url);
    if (!mm) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const target = mm[1] === "browser" ? "browser" : mm[2];
      const emit = (method, params) => ws.send(JSON.stringify({ method, params }));
      ws.on("message", async (data) => {
        const msg = JSON.parse(String(data));
        calls.push({ target, method: msg.method, params: msg.params || {}, tag: msg.method === "Runtime.evaluate" ? tagOf(msg.params.expression) : null });
        try { ws.send(JSON.stringify({ id: msg.id, result: (await model.handle(target, msg.method, msg.params || {}, emit)) ?? {} })); }
        catch (e) { ws.send(JSON.stringify({ id: msg.id, error: { message: String(e && e.message || e) } })); }
      });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    cdp: `http://127.0.0.1:${server.address().port}`, calls,
    close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

function fakeBox(model, events) {
  model.sampleScripts = [];
  model.killScripts = [];
  const box = async (cmd) => {
    const ps = decodePs(cmd);
    if (ps === null) {
      if (/^schtasks \/create \/tn hbm1cwebac /.test(cmd)) { assert.equal(cmd, BOX.launchTaskCommand({ task: M.TASK, launcher: M.LAUNCHER })); model.alive = true; events.push("launch"); return ""; }
      if (/^schtasks \/delete \/tn hbm1cwebac /.test(cmd)) { events.push("taskDelete"); return ""; }
      throw new Error(`fake box: unexpected ${cmd.slice(0, 60)}`);
    }
    if (ps.includes("M1CNET")) { events.push("boxCheck"); const n = model.preRunning || 0; return `HBKILL matched=${n} roots=${n ? 1 : 0} killed=0 browsers=${n ? 1 : 0} muted=0 offscreen=0\r\nM1CNET vite=200 bridge=200\r\n`; }
    if (ps.includes("M1CBAT")) { events.push("launcherWrite"); model.bat = Buffer.from(/FromBase64String\('([^']+)'\)/.exec(ps)[1], "base64").toString("ascii"); return `M1CBAT bytes=${model.bat.length}\r\n`; }
    if (ps.includes("HBWHO")) { events.push("boxSample"); model.sampleScripts.push(ps); return 'HBWHO idle=1500 hbage=4 locked=0 browsers=1 roblox=0 gpu3d_other=55 gpu3d_mine=0 ourchrome=0\r\nHBTOP {"wallMs":2004,"cores":8,"top":[{"n":"chrome","p":101,"c":0.9,"o":1}]}\r\n'; }
    throw new Error(`fake box: unexpected script ${ps.slice(0, 80)}`);
  };
  const boxSync = (cmd) => {
    const ps = decodePs(cmd);
    if (ps && ps.includes("HBKILL") && ps.includes("Stop-Process")) { events.push("kill"); model.killScripts.push(ps); model.alive = false; return "HBKILL matched=6 roots=1 killed=6 browsers=1 muted=1 offscreen=1\r\n"; }
    throw new Error(`fake boxSync: unexpected ${String(ps || cmd).slice(0, 80)}`);
  };
  return { box, boxSync };
}

const START = new Date(2026, 9, 30, 22, 0, 0).getTime();
function fakeDeps(model, chrome, { events = [], logs = [], env = {}, proc = null, http: httpFake = null, aceTail = "" } = {}) {
  let clock = START;
  const { box, boxSync } = fakeBox(model, events);
  return {
    env, log: (m) => logs.push(String(m)), now: () => clock, sleep: async (ms) => { clock += ms; },
    http: httpFake || (async (url, { method = "GET" } = {}) => ({ status: 200, ok: true, type: /\/$/.test(url) ? "text/html" : /healthz$/.test(url) ? "application/json" : "application/octet-stream", length: /\.dat$/.test(url) ? 1e9 : 120 })),
    tcpOpen: async () => true, udpBound: () => true,
    waitAccountFree: async (acct) => { events.push(`accountFree:${acct}`); return true; },
    readAceTail: () => aceTail,
    box, boxSync,
    armKillOnSignal: (o) => { events.push("arm"); return BOX.armKillOnSignal({ ...o, proc: proc || new EventEmitter() }); },
    // launchChrome / cdpJson / cdpConnect / sizeWindow / boxSample stay REAL: they run against the fakes above
  };
}

const baseOpts = (out, chrome, over = {}) => ({ ...M.parseArgs(["--rep", "1", "--out", out]), cdp: chrome.cdp, ...over });
const noSecrets = (text, secret) => { assert.ok(!String(text).includes(secret), `leaked ${secret}`); assert.ok(!String(text).includes(encodeURIComponent(secret)), `leaked ${encodeURIComponent(secret)}`); };

const SECRET = "Zq9 s3cret&x";
let happy = null;
await check("a whole W rep (fake box + fake Chrome): exit 0, one W JSON, every step in order", async () => {
  const model = makeModel();
  const chrome = await fakeChrome(model);
  const events = [], logs = [];
  const out = join(TMP, "happy");
  const env = { M1C_ACCOUNT: "tailnet1", M1C_PASSWORD: SECRET };
  const o = { ...baseOpts(out, chrome), creds: M.credentials(env) };
  const aceTail = "2026-10-30 21:59:30,000 [World Manager] DEBUG (ACE.Server.WorldObjects.Player) [LOGOUT] Account tailnet1 exited the world with character +Tester (0x50000007) at 2026-10-30 9:59:30 PM.\n";
  try {
    const r = await M.runRep(o, fakeDeps(model, chrome, { events, logs, env, aceTail }));
    assert.equal(r.code, 0, logs.join("\n"));
    assert.ok(existsSync(join(out, "W-r1.json")));
    assert.ok(!existsSync(join(out, "W-r1.failed.json")));
    const j = JSON.parse(readFileSync(join(out, "W-r1.json"), "utf8"));
    happy = { j, file: join(out, "W-r1.json"), logs, events, model, calls: chrome.calls };
    assert.deepEqual(j.m1c.steps.map((s) => s.id), ["preflight", "account", "box.check", "box.launcher", "launch", "cdp", "window", "renderer", "shim", "navigate", "load", "streams", "park", "settle", "sky", "measure", "write", "teardown.tab", "teardown.kill", "teardown.account"]);
    assert.deepEqual(events, ["accountFree:tailnet1", "boxCheck", "boxSample", "launcherWrite", "arm", "launch", "boxSample", "boxSample", "kill", "accountFree:tailnet1", "taskDelete"]);
    assert.equal(j.m1c.cooldown_before.heldMs, 35000, "held until 65 s after the account's last logout");
    assert.deepEqual(model.bat, M.launcherBat({ uncapped: true, window: "1920,1080" }));
  } finally { await chrome.close(); }
});

await check("step order: the shim (verbatim) and the draw-distance seed are added BEFORE navigating; the URL carries the env credentials", () => {
  assert.ok(happy, "needs the whole-rep check");
  const c = happy.calls.filter((x) => x.target !== "browser");
  const iShim = c.findIndex((x) => x.method === "Page.addScriptToEvaluateOnNewDocument" && x.params.source === M.DAT_SHIM);
  const iSeed = c.findIndex((x) => x.method === "Page.addScriptToEvaluateOnNewDocument" && /landscapeDrawDistance: dd/.test(x.params.source));
  const iNav = c.findIndex((x) => x.method === "Page.navigate" && /\/\?ace&/.test(x.params.url));
  const iRend = c.findIndex((x) => x.tag === "renderer");
  assert.ok(iRend >= 0 && iShim > iRend && iSeed > iShim && iNav > iSeed, JSON.stringify({ iRend, iShim, iSeed, iNav }));
  assert.equal(c[iNav].params.url, `http://127.0.0.1:3000/?ace&bridge=ws://127.0.0.1:9090&account=tailnet1&password=${encodeURIComponent(SECRET)}&degmul=1`);
  assert.equal(happy.model.navigations.filter((u) => /\?ace&/.test(u)).length, 1, "one navigation, never a reload");
  assert.ok(!happy.model.navigations.some((u) => /nocache/.test(u)));
  const iFocus = c.findIndex((x) => x.method === "Emulation.setFocusEmulationEnabled");
  assert.ok(iFocus >= 0 && iFocus < iNav, "focus emulation as Playwright's attach");
  assert.ok(happy.calls.some((x) => x.target === "browser" && x.method === "Target.closeTarget" && x.params.targetId === "P2"), "the extra chrome:// tab was closed");
  assert.equal(happy.j.m1c.window.ok, true);
  assert.deepEqual(happy.j.m1c.window.inner, [1920, 1080], "INNER 1920x1080 through sizeWindow");
  assert.deepEqual(happy.j.viewport, { width: 1920, height: 1080 });
});

await check("step order: the in-world gate before the teleport, 10 s streams wait, landed, yaw 0, then the settle plateau", () => {
  assert.ok(happy, "needs the whole-rep check");
  const tags = happy.calls.filter((x) => x.tag && x.tag !== "size").map((x) => x.tag);
  const lastLoad = tags.lastIndexOf("loadState"), admin = tags.indexOf("admin");
  assert.ok(lastLoad >= 0 && admin > lastLoad, "every load poll (the gate) happens before the teleport");
  assert.equal(happy.model.loadPolls, 3, "the gate passed on the poll where x > 0 and the sceneManager exists");
  assert.deepEqual(happy.model.admin, [M.TELELOC]);
  const st = Object.fromEntries(happy.j.m1c.steps.map((s) => [s.id, Date.parse(s.at)]));
  assert.ok(st.park - st.streams >= 10000, "measure-perf's 10 s in-world wait");
  assert.equal(happy.j.m1c.park.teleloc, "sent");
  assert.ok(happy.j.m1c.park.distBefore > 10);
  const afterAdmin = tags.slice(admin + 1);
  assert.equal(afterAdmin[0], "worldPos", "landed check");
  assert.equal(afterAdmin[afterAdmin.indexOf("setYaw") + 1], "countMeshes", "yaw 0 before the settle");
  assert.deepEqual(happy.j.m1c.settle.polls, [500, 900, 1000, 1004, 1008, 1009], "stops at the first 4-poll plateau");
  assert.equal(happy.j.m1c.settle.plateau, true);
  assert.equal(happy.j.m1c.settle.meshes, 1009);
});

await check("the measurement is measure-perf's idle sequence, call for call", () => {
  assert.ok(happy, "needs the whole-rep check");
  const tags = happy.calls.filter((x) => x.tag && x.tag !== "size").map((x) => x.tag);
  const from = tags.indexOf("viewport");
  assert.deepEqual(tags.slice(from, from + 12), ["viewport", "renderer", "drawDistance", "location", "installRenderTimer", "renderInfo", "setYaw", "drainRenderTimer", "samplePhase", "renderInfo", "drainRenderTimer", "sceneCensus"]);
  const j = happy.j;
  assert.equal(j.phases.length, 1);
  assert.deepEqual(j.phases[0], M.phaseStats("idle", happy.model.deltas));
  assert.equal(j.render.idle.drawCalls, 851, "the heading-sector mean of 850/851/852");
  assert.equal(j.render.idle.textures, 310, "memory counters from the point read");
  assert.equal(j.renderSampling, "frame-heading-binned");
  assert.deepEqual(j.renderJs.idle, M.renderJsStats(happy.model.renderJs));
  assert.equal(j.rawSamples.idle.frameDeltasMs.length, 1500);
  assert.equal(j.rawSamples.idle.renderJsMs.length, 1500);
  assert.equal(j.renderSamples.idle.length, 1500);
  assert.equal(j.landscapeDrawDistance, 8);
  assert.equal(j.drawDistance, 8);
  assert.equal(j.degmul, 1);
  assert.equal(j.phaseSecs, 20);
  assert.equal(j.renderer, GOOD);
  assert.deepEqual(j.location, { x: 32544.4, y: 34655.6, z: 80.4, landblock: "0xa9b4ffff" });
  assert.deepEqual(j.warnings, []);
  assert.equal(j.m1c.sky.hour, 13.42);
  assert.equal(j.m1c.sky.skytimeArg, "13.42");
  assert.equal(j.m1c.profile, "C:\\Temp\\hbm1c-webac");
  assert.equal(j.m1c.profilePersistent, true);
  assert.equal(j.m1c.vsync.uncapped, true);
  assert.equal(j.m1c.load.warmProfile, true);
  assert.equal(j.m1c.box.length, 3);
  assert.equal(j.m1c.box[0].oursRule, "the hbm1c-webac Chrome and its children");
  assert.ok(happy.model.sampleScripts.every((s) => s === M.wBoxSampleScript().script));
  assert.equal(j.m1c.frameStatsHbbench.n, 1500, "the idle deltas in hbbench's frameStats too");
  assert.ok(happy.logs.some((l) => l.includes("--item M1c-WEBAC --reps 1 --port 8766 --uncapped --skytime 13.42")), "prints the H-arm command");
});

await check("teardown: about:blank, close the tab, kill ONLY the hbm1c-webac Chrome (muted, off-screen, CDP 9333 roots), CDP closed, THEN the account wait", () => {
  assert.ok(happy, "needs the whole-rep check");
  const c = happy.calls;
  const blank = c.findIndex((x) => x.method === "Page.navigate" && x.params.url === "about:blank");
  const close = c.findIndex((x) => x.method === "Target.closeTarget" && x.params.targetId === "P1");
  assert.ok(blank > 0 && close > blank);
  assert.equal(happy.model.killScripts.length, 1);
  assert.equal(happy.model.killScripts[0], BOX.profileKillScript(M.PROFILE, { requireFlags: [...M.ROOT_FLAGS] }));
  const ev = happy.events;
  assert.ok(ev.indexOf("kill") < ev.lastIndexOf("accountFree:tailnet1"), "kill, then wait for ACE's logout");
  assert.equal(happy.j.m1c.teardown.cdpClosed, true);
  assert.deepEqual(happy.j.m1c.teardown.kill, { matched: 6, roots: 1, killed: 6, browsers: 1, muted: 1, offscreen: 1 });
});

await check("credentials never reach a log line or a file (URL redacted to password=***)", () => {
  assert.ok(happy, "needs the whole-rep check");
  const all = happy.logs.join("\n");
  noSecrets(all, SECRET);
  noSecrets(readFileSync(happy.file, "utf8"), SECRET);
  assert.ok(happy.logs.some((l) => l.includes("password=***&degmul=1")), "the navigate step logs the redacted URL");
  assert.equal(happy.j.url, "http://127.0.0.1:3000/?ace&bridge=ws://127.0.0.1:9090&account=tailnet1&password=***&degmul=1");
});

await check("the W JSON round-trips through hbreport.py m1c's parser (python3 -I)", () => {
  assert.ok(happy, "needs the whole-rep check");
  const outJson = join(TMP, "m1c-report.json");
  const r = spawnSync("python3", ["-I", join(PW, "hbreport.py"), "m1c", "--w", happy.file, "--json", outJson], { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const rep = JSON.parse(readFileSync(outJson, "utf8"));
  assert.equal(rep.rows.length, 1);
  const row = rep.rows[0], j = happy.j;
  assert.equal(row.side, "W");
  assert.equal(row.rep, "W-r1.json");
  assert.equal(row.fps, j.phases[0].avgFps);
  assert.equal(row.draws, j.render.idle.drawCalls);
  assert.equal(row.renderJsP50, j.renderJs.idle.p50Ms);
  assert.equal(row.usPerDraw, Math.round((j.renderJs.idle.p50Ms * 1000 / j.render.idle.drawCalls) * 100) / 100);
  assert.deepEqual(row.window, j.viewport);
  assert.equal(row.sampling, "frame-heading-binned");
  assert.match(r.stdout, /W W\s+W-r1\.json\s+fps [\d.]+ draws 851/);
});

await check("renderer refusal: a non-1070 adapter stops the rep BEFORE the shim, the navigation and any login (exit 3), and the W Chrome is killed", async () => {
  const model = makeModel({ renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)" });
  const chrome = await fakeChrome(model);
  const events = [], logs = [];
  const out = join(TMP, "badgpu");
  try {
    const r = await M.runRep({ ...baseOpts(out, chrome), creds: M.credentials({}) }, fakeDeps(model, chrome, { events, logs }));
    assert.equal(r.code, 3, logs.join("\n"));
    assert.deepEqual(model.scripts, [], "no shim");
    assert.deepEqual(model.navigations, ["about:blank"], "only the teardown blank: WebAC was never loaded, nobody logged in");
    assert.ok(events.includes("kill"));
    assert.ok(!existsSync(join(out, "W-r1.json")));
    const f = JSON.parse(readFileSync(join(out, "W-r1.failed.json"), "utf8"));
    assert.equal(f.code, 3);
    assert.match(f.error, /SwiftShader/);
    assert.ok(logs.some((l) => /REFUSED: renderer/.test(l)));
  } finally { await chrome.close(); }
});

await check("preflight refusal: vite / bridge down -> exit 2, the recipe's exact start commands printed, nothing touches the box", async () => {
  const model = makeModel();
  const chrome = await fakeChrome(model);
  const events = [], logs = [];
  const httpDown = async (url) => { throw new Error(`connect ECONNREFUSED ${new URL(url).host}`); };
  try {
    const deps = { ...fakeDeps(model, chrome, { events, logs, http: httpDown }), box: async () => { throw new Error("box touched"); }, boxSync: () => { throw new Error("box touched"); }, launchChrome: async () => { throw new Error("launch"); } };
    const r = await M.runRep({ ...baseOpts(join(TMP, "pf"), chrome), creds: M.credentials({}) }, deps);
    assert.equal(r.code, 2);
    const all = logs.join("\n");
    assert.match(all, /REFUSED: vite dev server at http:\/\/127\.0\.0\.1:3000\/ does not answer/);
    assert.match(all, /REFUSED: WebAC's bridge does not answer at http:\/\/127\.0\.0\.1:9090\/healthz/);
    for (const c of M.recipeStartCommands(QUEUE)) assert.ok(all.includes(`  ${c}`), `prints: ${c}`);
    assert.deepEqual(events, [], "no account wait, no box call");
    assert.equal(chrome.calls.length, 0);
  } finally { await chrome.close(); }
});

await check("preflight refusal: a Chrome already on CDP :9333, an existing W JSON, ACE down; box check refusal: a hbm1c-webac Chrome running (maybe MODE P) is never killed", async () => {
  const model = makeModel({ alive: true });
  const chrome = await fakeChrome(model);
  const out = join(TMP, "exists");
  try {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "W-r1.json"), "{}");
    const logs = [];
    const deps = { ...fakeDeps(model, chrome, { logs }), udpBound: () => false };
    const r = await M.runRep({ ...baseOpts(out, chrome), creds: M.credentials({}) }, deps);
    assert.equal(r.code, 2);
    const all = logs.join("\n");
    assert.match(all, /a Chrome already answers on/);
    assert.match(all, /W-r1\.json exists: never overwrite a rep/);
    assert.match(all, /ACE does not hold UDP :9000/);
  } finally { await chrome.close(); }
  const model2 = makeModel({ preRunning: 2 });
  const chrome2 = await fakeChrome(model2);
  try {
    const events = [], logs = [];
    const r = await M.runRep({ ...baseOpts(join(TMP, "modep"), chrome2), creds: M.credentials({}) }, fakeDeps(model2, chrome2, { events, logs }));
    assert.equal(r.code, 2);
    assert.match(logs.join("\n"), /may be the owner's MODE P session\. Never killed from here/);
    assert.ok(!events.includes("kill") && !events.includes("launch"), JSON.stringify(events));
  } finally { await chrome2.close(); }
});

await check("Ctrl-C during the rep: the W Chrome (hbm1c-webac only) is killed BEFORE the process exits", async () => {
  const proc = new EventEmitter();
  const events = [];
  proc.exit = (c) => events.push(`exit:${c}`);
  const model = makeModel({ onLoadPoll: (n) => { if (n === 2) proc.emit("SIGINT"); } });
  const chrome = await fakeChrome(model);
  const logs = [];
  try {
    await M.runRep({ ...baseOpts(join(TMP, "sigint"), chrome), creds: M.credentials({}) }, fakeDeps(model, chrome, { events, logs, proc }));
    const k = events.indexOf("kill"), x = events.indexOf("exit:130");
    assert.ok(k >= 0 && x > k, JSON.stringify(events));
    assert.equal(model.killScripts[0], BOX.profileKillScript(M.PROFILE, { requireFlags: [...M.ROOT_FLAGS] }), "the signal kill is the hbm1c-webac kill, not killBench");
    assert.ok(events.indexOf("arm") < events.indexOf("launch"), "armed before the launch");
    assert.equal(proc.listenerCount("SIGINT"), 0, "disarmed at the end");
  } finally { await chrome.close(); }
});

await check("a teleport that never lands fails the rep (exit 1, W-r1.failed.json, no W JSON) and still tears down", async () => {
  const model = makeModel({ teleportWorks: false });
  const chrome = await fakeChrome(model);
  const events = [], logs = [];
  const out = join(TMP, "noland");
  try {
    const r = await M.runRep({ ...baseOpts(out, chrome), creds: M.credentials({}) }, fakeDeps(model, chrome, { events, logs }));
    assert.equal(r.code, 1);
    assert.ok(!existsSync(join(out, "W-r1.json")));
    assert.match(JSON.parse(readFileSync(join(out, "W-r1.failed.json"), "utf8")).error, /never landed/);
    assert.ok(events.includes("kill") && events.lastIndexOf("accountFree:tailnet1") > events.indexOf("kill"));
    assert.ok(model.navigations.includes("about:blank"));
  } finally { await chrome.close(); }
});

await check("--dry-run prints every step (credentials redacted) and touches nothing", async () => {
  const logs = [];
  const touched = Object.fromEntries(Object.keys(M.DEPS).filter((k) => k !== "log" && k !== "env").map((k) => [k, () => { throw new Error(`dry run touched ${k}`); }]));
  const out = join(TMP, "dry");
  const code = await M.main(["--rep", "2", "--out", out, "--dry-run"], { ...touched, log: (m) => logs.push(m), env: { M1C_PASSWORD: SECRET } });
  assert.equal(code, 0, logs.join("\n"));
  const all = logs.join("\n");
  for (const id of ["preflight", "account", "box.check", "box.sample", "box.launcher", "launch", "cdp", "window", "renderer", "shim", "navigate", "load", "streams", "park", "settle", "sky", "measure", "write", "teardown"]) assert.ok(new RegExp(`^step ${id.replace(".", "\\.")}:`, "m").test(all), id);
  noSecrets(all, SECRET);
  assert.match(all, /password=\*\*\*&degmul=1/);
  assert.ok(!existsSync(out), "no directory created");
});

await check("main: usage errors exit 2; --predict-hour reads a W JSON and prints the hour", async () => {
  const logs = [];
  assert.equal(await M.main(["--rep", "1"], { log: (m) => logs.push(m) }), 2);
  assert.ok(happy, "needs the whole-rep check");
  const L = [];
  const at = new Date(Date.parse(happy.j.m1c.sky.measuredAt) + 7620 * 1000 / 24).toISOString();
  assert.equal(await M.main(["--predict-hour", happy.file, "--at", at], { log: (m) => L.push(m), readText: (p) => readFileSync(p, "utf8") }), 0);
  assert.match(L.join("\n"), /ACE hour at .*: 14\.42 .* -> --skytime 14\.42/);
});

await check("no ssh was attempted by any check", () => {
  assert.equal(readFileSync(SSH_LOG, "utf8"), "");
});

try { rmSync(TMP, { recursive: true, force: true }); rmSync(SSH_GUARD, { recursive: true, force: true }); } catch (_) { /* tmp */ }
console.log(`\nm1c_webac.test: ${pass} passed, ${fail} failed${fail ? `\n  ${failures.join("\n  ")}` : ""}`);
process.exit(fail ? 1 : 0);
