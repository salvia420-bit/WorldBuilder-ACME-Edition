// harness/moving-bench.mjs — a REPEATABLE moving benchmark for one arm.
//
// THE PROBLEM IT REPLACES (2026-08-06)
// ------------------------------------
// The moving arm of the frame-cost investigation was unusable and the reason
// was mechanical, not statistical. The rig spun the camera with a per-frame
//     window.__cam.player(dist, az, el, dz)
// whose azimuth advanced on WALL CLOCK and whose centre was the LIVE player
// pose. A slower arm therefore swept a shorter arc from a slightly different
// place, so it streamed and frustum-culled a different amount:
//
//   ?statBatchMemo=slack, moving:  off [28.5, 33.6, 27.0]  slack [29.6, 19.0, 22.4]
//                                  delta 6.10 ms | control spread 6.60 ms
//
// The control was wider than the effect. Parked runs on the same box held
// 0.7-2.3 ms, so nothing about the box or the sampler was at fault — only how
// motion was produced. Two conclusions were lost to it.
//
// WHAT THIS DOES INSTEAD
// ----------------------
//  1. The camera path is a TABLE computed in node (`lib/moving_path.mjs`) and
//     indexed by FRAME NUMBER. Frame k gets pose k whether it took 12 ms or
//     40 ms, so two arms traverse identical geometry at different fps.
//  2. The run length is a FRAME COUNT, never a duration. A duration would put
//     the measured quantity back into the independent variable.
//  3. The anchor is PINNED on the command line, never read from the live pose.
//  4. A warm lap streams and compiles; the measure lap is the identical lap.
//  5. Every run reports what it would take to REJECT it: the intended path
//     checksum, the REALISED path checksum, resident-landblock churn, and the
//     per-frame draw/triangle spread. A run that diverged is thrown away, not
//     averaged in — the overnight census produced 42 runs of unusable data
//     because its baseline drifted 2.44x and nothing checked.
//
// It does NOT own Chrome. Chrome lifecycle (relaunch between arms — reusing one
// Chrome degrades it 2.44x over ~100 minutes) stays in the operator's existing
// flow; this connects to a CDP endpoint that is already up, runs ONE arm, and
// prints a JSON report. Interleave arms by invoking it repeatedly.
//
// INVOCATION
// ----------
//   node harness/moving-bench.mjs --cdp=http://127.0.0.1:9333 \
//        --anchor=25171,20344,42.0 --mode=orbit --frames=600 --laps=1 \
//        --account=tailnet1 --poi=Nanto \
//        --arm='statBatchSphere=on&statBatchMemo=off' \
//        --out=/tmp/mb-sphere-on.json
//
//   # the control arm is the same line with --arm='' (or --arm=default)
//
// Getting the anchor ONCE, then pinning it forever:
//   in the page, `@telepoi Nanto` then `__cam.world()` -> {x, y, z}
//   (or `@loc` and fold the landblock: x = ((cell>>>24)&0xff)*192 + localX).
//
// hop mode (the arm that deliberately DOES stream):
//   --mode=hop --hops=0x9722003a:80:80:42,0x9622003a:80:80:42 --dwell=120
//
// perf HISTORY / ratchet (test-tooling-8, 2026-10-13):
//   --history            ratchet this run against its own recent past, then
//   --history=DIR        append it (harness/perf-ratchet.mjs; DIR defaults to
//                        $HB_PERF_HISTORY, else /mnt/wbterminal2/hb-perf-history).
//                        Exit 3 = USABLE run that the ratchet calls a
//                        regression (1 stays "REJECT"). Absent = no history I/O.
//   --historyAccept      with --history: an INTENDED cost change — stamp this
//                        run "accepted" so it becomes the new bar.
//   Every run now records platform.renderer, wasmProfile (from the loaded
//   wasm's custom sections — lib/wasm_profile.mjs), distGeneratedAt and the
//   harness checkout's commit, read AFTER the measure lap.
//
// FLAGS THE RUN NEEDS ON THE PAGE (added automatically unless --url is given):
//   ?camDebug=on        installs window.__cam            (required)
//   ?vfxGauge=on        per-frame CPU time               (required for cpuMs)
//   ?renderOnDemand=1   one render per pose              (drive=ondemand)
//   ?renderDiag=on      draws/triangles/nodes
//   ?nosw=1             or the service worker serves a stale build
//   ?agent=1 &autoLogin ...  headless login
//   ?linkProbe=on       OPTIONAL, `--linkProbe` adds it outside the arm label:
//                       the program ledger (scene3d/shader_prewarm.js) ->
//                       programsRelinked@moving + programs@resident, and the
//                       run's taint list names it (pass-10 D-10.4.4)
//
// THE BOOT GATE (2026-08-10 — why it is not a one-line poll any more)
// -------------------------------------------------------------------
// The MOVE-FIX baseline attempt of 2026-08-10 died printing four words —
// `[moving-bench] BOOT-FAIL` — and nothing else, and the flag it was carrying
// (`?renderOnDemand=1`) got the blame. It was innocent: the exact URL this
// file builds, flag and all, boots to `__bootState === "ready"` in 8.4 s on
// SwiftShader (live-reproduced 2026-08-10, `atmosphere load 1817.2ms`). Two
// real defects were hiding behind the silent exit:
//
//   1. `error` was treated as terminal and printed WITHOUT its message, so a
//      recoverable stale-session refusal looked identical to a broken build.
//      The reproduced failure is ACE holding the previous run's character:
//      `[character-error] code=0x1 name=Logon` → `connect failed after 1
//      attempts: timeout`. index.html's autoLogin defaults to maxRetries=0
//      ("one clean warm connect", index.html ~:11251) — deliberate, because
//      the old retry-dance was destructive — so the FIRST refusal latches
//      `error` and the harness quit. Two arms back-to-back on one account
//      (which is what an interleaved bench IS) hit this every time.
//   2. `error` can also latch AFTER a healthy `in-world`: index.html's
//      ready-watchdog fires `error: in-world reached but scene-ready signal
//      did not fire within 90000ms`, and `ready`/`in-world` share one scalar
//      (index.html :6122-6131 conn-fix). A poll of the scalar alone can read
//      a terminal `error` on a session that is fine.
//
// So the gate now reads `__bootStateHistory` + `__sceneReadyEverFired` (not
// just the scalar), and on a genuine PRE-in-world error it re-fires the
// documented retry entry point `window.__runAutonomousLogin({...})`
// (index.html :11218 — "an agent CAN retry ... it just cannot run two at
// once") after a cooldown, instead of exiting. Every failure now prints the
// boot-state history that produced it.
//
// Account note: `--account` defaults to `tailnet1`, which on the 1070 is the
// HUMAN's Developer account — two things logging into it fight. Pass a bot
// account (`--account=agentp07`) for unattended runs.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireHeavyLock } from "./lib/heavy_lock.mjs";
import { poseTable } from "./lib/moving_path.mjs";
import { movingRigSource } from "./lib/moving_rig.mjs";
import { createReport } from "./lib/report.mjs";
import { classifyWasmProfile, wasmCustomSectionNames } from "./lib/wasm_profile.mjs";
import { appendHistory, formatRatchet, ratchetResults, readHistory, resolveHistoryDir } from "./perf-ratchet.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`));
  if (!hit) return d;
  const eq = hit.indexOf("=");
  return eq < 0 ? true : hit.slice(eq + 1);
};
const num = (k, d) => { const v = arg(k, null); return v == null ? d : Number(v); };

const CDP = String(arg("cdp", "") || "");
const OUT = String(arg("out", "/tmp/moving-bench.json"));
const MODE = String(arg("mode", "orbit"));
const ACCOUNT = String(arg("account", "tailnet1"));
const POI = String(arg("poi", "Nanto"));
const ARM = String(arg("arm", "") || "").replace(/^default$/, "");
const DRIVE = String(arg("drive", "ondemand"));
// `--linkProbe` (or `=on`/`=1`): arm the program create/release ledger in BOTH
// arms without it becoming part of the arm label.
const LINK_PROBE = ((v) => v === true || v === "on" || v === "1")(arg("linkProbe", false));
const SETTLE_MS = num("settle", 45000);
const BOOT_MS = num("bootTimeout", 160000);
// Boot-gate retry budget (see "THE BOOT GATE" above). `--loginRetries=0`
// restores the old exit-on-first-error behaviour.
const LOGIN_RETRIES = num("loginRetries", 2);
// ACE's CHARACTER-level logout is ~5-10 s (index.html sizes its own
// charInWorldWaitMs at 7000); wait past it before re-firing, or the retry
// chases a half-killed session that keeps emitting CharacterError::Logon.
const LOGIN_COOLDOWN_MS = num("loginCooldownMs", 9000);
// Each retry buys its own runway on top of --bootTimeout: one attempt costs
// the in-page connectTimeoutMs (25 s) + spawnTimeoutMs (20 s) at worst.
const LOGIN_RETRY_BUDGET_MS = num("loginRetryBudgetMs", 60000);
const BASE = String(arg("base", "http://127.0.0.1:8765/apps/holtburger-web/index.html"));
// Repeatability budgets. A run outside them is REJECTED, not averaged in.
const CHURN_MAX = num("churnMax", MODE === "hop" ? 1e9 : 0);
const DRAW_SPREAD_MAX = num("drawSpreadMax", 0.05);
// `--history` (default dir) or `--history=DIR`: ratchet + append (see header).
const HISTORY = arg("history", null);
// `--historyAccept`: this run is an operator rebase after an INTENDED cost
// change (perf-ratchet rule 5). Only meaningful with --history.
const HISTORY_ACCEPT = ((v) => v === true || v === "on" || v === "1")(arg("historyAccept", false));

function parseAnchor(s) {
  if (!s || s === true) return null;
  const p = String(s).split(",").map(Number);
  if (p.length !== 3 || p.some((v) => !Number.isFinite(v))) throw new Error(`--anchor=x,y,z expected, got ${s}`);
  return { x: p[0], y: p[1], z: p[2] };
}
function parseHops(s) {
  if (!s || s === true) return null;
  return String(s).split(",").map((tok) => {
    const f = tok.split(":");
    if (f.length !== 4) throw new Error(`--hops entry must be cell:x:y:z, got ${tok}`);
    return { cell: Number(f[0]) >>> 0, x: Number(f[1]), y: Number(f[2]), z: Number(f[3]) };
  });
}

export function buildSpec() {
  return {
    mode: MODE,
    frames: num("frames", 600),
    anchor: parseAnchor(arg("anchor", null)),
    dist: num("dist", 26),
    el: num("el", 18),
    elAmp: num("elAmp", 0),
    az0: num("az0", 0),
    laps: num("laps", 1),
    dz: num("dz", 1.2),
    hops: parseHops(arg("hops", null)),
    dwell: num("dwell", 120),
  };
}

export function buildUrl(arm) {
  const explicit = arg("url", null);
  if (explicit && explicit !== true) return String(explicit);
  const flags = [
    "nosw=1", "quality=mid", "adaptiveRes=off", "renderScale=1",
    "renderDiag=on", "camDebug=on", "vfxGauge=on",
    `autoLogin=1&account=${ACCOUNT}&password=${ACCOUNT}&autoSpawn=first&agent=1`,
  ];
  if (DRIVE === "ondemand") flags.push("renderOnDemand=1", "netDrainHz=30");
  if (LINK_PROBE) flags.push("linkProbe=on");
  if (arm) flags.push(arm);
  return `${BASE}?${flags.join("&")}`;
}

/**
 * States index.html's autoLogin orchestrator passes through on the way to a
 * playable session (index.html :6106-6109). Anything in here is "still
 * working", never a verdict.
 */
export const BOOT_TRANSIENT_STATES = new Set([
  "init", "form-shown", "connecting", "kicking", "reconnecting",
  "char-list-ready", "spawning",
]);

/**
 * THE boot verdict, as a pure function of one page snapshot — so the policy
 * that cost the 2026-08-10 baseline is testable in node instead of only
 * observable at 2 a.m. against a live ACE.
 *
 * `snap` = { state, history:[{state,message}], sceneReadyEverFired, inFlight }
 * exactly as `readBootSnapshot` reads it off the page. A null snapshot (the
 * evaluate raced a navigation) is "wait", never a verdict.
 *
 * Returns { action, reason }:
 *   "go"      — the session reached in-world/ready at least once. A LATER
 *               `error` does not revoke that (ready/in-world share one scalar
 *               and the 90 s ready-watchdog latches error on healthy sessions
 *               — index.html :6122-6131, :11626-11647).
 *   "wait"    — a transient state, or an error while a login run is still in
 *               flight (the orchestrator releases its claim in a `finally`,
 *               so the terminal state may lag the scalar by a poll).
 *   "relogin" — a PRE-in-world error with retries left: re-fire
 *               `window.__runAutonomousLogin`. This is the stale-ACE-session
 *               case (CharacterError::Logon 0x01 → connect timeout) that a
 *               second bench arm on one account reproduces every time.
 *   "fatal"   — a pre-in-world error with no retries left. `reason` carries
 *               the page's own message so the operator sees WHY.
 */
export function classifyBoot(snap, { attempt = 0, maxAttempts = 2 } = {}) {
  if (!snap) return { action: "wait", reason: "no snapshot (evaluate raced a navigation)" };
  const history = Array.isArray(snap.history) ? snap.history : [];
  const reached = (s) => snap.state === s || history.some((e) => e && e.state === s);
  if (reached("in-world") || reached("ready") || snap.sceneReadyEverFired) {
    return { action: "go", reason: snap.state === "error" ? "in-world reached; later error ignored" : "in-world/ready" };
  }
  if (snap.state === "error") {
    if (snap.inFlight) return { action: "wait", reason: "error latched while a login run is still in flight" };
    const last = [...history].reverse().find((e) => e && e.state === "error");
    const why = (last && last.message) || "no message recorded";
    if (attempt < maxAttempts) return { action: "relogin", reason: why };
    return { action: "fatal", reason: `${why} (after ${attempt} relogin ${attempt === 1 ? "retry" : "retries"})` };
  }
  if (snap.state == null || BOOT_TRANSIENT_STATES.has(snap.state)) {
    return { action: "wait", reason: `state=${snap.state ?? "(unset)"}` };
  }
  // Unknown state: index.html grew a state this harness has not been taught.
  // Waiting is the safe read — the deadline still ends the run.
  return { action: "wait", reason: `unrecognised boot state "${snap.state}"` };
}

/** One-line-per-state dump of what the page actually did. Printed on EVERY
 *  boot failure — the 2026-08-10 run's whole diagnosis cost was this dump. */
export function formatBootHistory(snap) {
  if (!snap) return "  (no snapshot)";
  const rows = (snap.history || []).map((e) => `  - ${e.state}${e.message ? ": " + e.message : ""}`);
  if (!rows.length) rows.push("  (no boot-state history — did the page load index.html?)");
  return rows.join("\n");
}

/**
 * Split the console-error log at the instant the boot gate passed.
 *
 * Errors from BEFORE that instant belong to the login phase — and once the
 * gate retries a refused connect, the refusal's own console error
 * ("start_session: no CharacterList within 30s") sits in the log of a run
 * that then went on to be perfectly healthy. judge() counts errors, so
 * leaving them in would REJECT every recovered run: the harness would fail
 * itself for surviving. They are reported (`bootErrors`), never judged.
 * Everything from the gate onward — settle, teleport, warm lap, measure lap —
 * is judged exactly as before.
 */
export function splitBootErrors(all, cutIndex) {
  const list = Array.isArray(all) ? all : [];
  const cut = Math.max(0, Math.min(list.length, cutIndex | 0));
  return { bootErrors: list.slice(0, cut), runErrors: list.slice(cut) };
}

async function readBootSnapshot(page) {
  return page.evaluate(() => ({
    state: window.__bootState ?? null,
    history: (window.__bootStateHistory || []).map((e) => ({ state: e.state, message: e.message || "" })),
    sceneReadyEverFired: !!window.__sceneReadyEverFired,
    inFlight: typeof window.__autoLoginInFlight === "function" ? window.__autoLoginInFlight() : false,
  })).catch(() => null);
}

const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2); };
const mean = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null);
const stat = (a) => (a.length ? { n: a.length, p50: pct(a, 50), p95: pct(a, 95), p99: pct(a, 99), mean: mean(a), min: +Math.min(...a).toFixed(2), max: +Math.max(...a).toFixed(2) } : null);

/**
 * Run provenance, as a page-evaluable expression (test-tooling-8). Evaluated
 * AFTER the measure lap — it fetches the wasm and touches GL state, so it must
 * never overlap a measured frame:
 *   renderer        UNMASKED_RENDERER_WEBGL of the context that rendered
 *                   (liveScene3d.renderer), else a throwaway context that is
 *                   lost again at once. The ratchet's software-renderer rule
 *                   (counts only on SwiftShader) keys on it.
 *   wasm            custom-section names of the module THIS page loaded: the
 *                   Resource Timing entry's exact URL (cache-busting ?v=
 *                   included; force-cache reuses the boot's download), walked
 *                   in-page with lib/wasm_profile.mjs's self-contained walker
 *                   so 7-17 MB never crosses CDP. A `name`/.debug_* section =
 *                   DEV-WASM; size is NOT the test (release is ~7.2 MB now).
 *   distGeneratedAt ../../dist/manifest.json `generated_at`, the bake stamp the
 *                   service worker keys on (recorded as ratchet taint).
 */
export function provenanceProbeSource() {
  return `(async () => {
  const walk = ${wasmCustomSectionNames.toString()};
  const out = { renderer: null, wasm: null, distGeneratedAt: null, errors: [] };
  try {
    let gl = null;
    let scratch = false;
    try { gl = window.liveScene3d && window.liveScene3d.renderer ? window.liveScene3d.renderer.getContext() : null; } catch (_) { gl = null; }
    if (!gl) { scratch = true; const c = document.createElement("canvas"); gl = c.getContext("webgl2") || c.getContext("webgl"); }
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      out.renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || "") || null;
      if (scratch) { const lose = gl.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext(); }
    }
  } catch (e) { out.errors.push("renderer: " + ((e && e.message) || e)); }
  try {
    const entry = (performance.getEntriesByType("resource") || []).find((e) => /holtburger_web_bg\\.wasm/.test(e.name));
    const url = entry ? entry.name : new URL("pkg/holtburger_web_bg.wasm", location.href).href;
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
    const bytes = new Uint8Array(await res.arrayBuffer());
    let sections = null;
    let error = null;
    try { sections = walk(bytes); } catch (e) { error = String((e && e.message) || e); }
    out.wasm = { url, size: bytes.length, sections, error };
  } catch (e) { out.errors.push("wasm: " + ((e && e.message) || e)); }
  try {
    const res = await fetch(new URL("../../dist/manifest.json", location.href).href, { cache: "no-store" });
    if (res.ok) { const m = await res.json(); out.distGeneratedAt = (m && m.generated_at) || null; }
  } catch (e) { out.errors.push("manifest: " + ((e && e.message) || e)); }
  return out;
})()`;
}

/**
 * Fold the page probe into report fields. Pure, so the mapping is testable.
 * A probe that failed outright (`null`) records "unknown", never a guess.
 */
export function provenanceFields(prov) {
  const w = prov && prov.wasm ? prov.wasm : null;
  const cls = classifyWasmProfile({
    sections: w && Array.isArray(w.sections) ? w.sections : null,
    size: w && Number.isFinite(w.size) ? w.size : null,
    error: w ? (w.error || null) : "wasm not fetched",
  });
  return {
    renderer: (prov && typeof prov.renderer === "string" && prov.renderer) || null,
    wasmProfile: cls.profile,
    wasmProbe: { url: (w && w.url) || null, size: cls.size, reason: cls.reason, customSections: cls.customSections },
    distGeneratedAt: (prov && prov.distGeneratedAt) || null,
    provenanceErrors: (prov && Array.isArray(prov.errors)) ? prov.errors : ["provenance probe returned nothing"],
  };
}

/**
 * HEAD of the checkout this harness runs from (in the laptop flow, the tree
 * serve.py serves). Provenance only — recorded, never part of the ratchet key;
 * null when git is unavailable.
 */
function gitCommit() {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * The verdict. A harness that cannot prove its own repeatability is worse than
 * none, so this is deliberately quick to say NO.
 */
export function judge(rep, opts) {
  const reasons = [];
  if (rep.realisedChecksum !== rep.pathChecksum) {
    reasons.push(`DIVERGED-PATH (realised ${rep.realisedChecksum} != intended ${rep.pathChecksum}) `
      + "— the camera did not go where it was told. Check that ?camDebug=on installed __cam and "
      + "that nothing released the park.");
  }
  if (rep.frames.measured !== rep.frames.requested) {
    reasons.push(`SHORT (${rep.frames.measured}/${rep.frames.requested} frames)`);
  }
  if (rep.lb.churnFrames > opts.churnMax) {
    reasons.push(`DIVERGED-STREAM (${rep.lb.churnFrames} frames changed the resident landblock set, budget ${opts.churnMax}) `
      + "— this run streamed. It is not comparable to a run that did not; raise --settle or pick a "
      + "quieter anchor, or use --mode=hop where streaming is the point.");
  }
  const d = rep.workload.draws;
  if (d && d.mean > 0) {
    const spread = (d.max - d.min) / d.mean;
    if (spread > opts.drawSpreadMax) {
      reasons.push(`DIVERGED-WORKLOAD (per-frame draw spread ${(spread * 100).toFixed(1)}% > ${(opts.drawSpreadMax * 100).toFixed(0)}%)`);
    }
  }
  if (rep.errors && rep.errors.length) reasons.push(`ERRORS (${rep.errors.length})`);
  if (rep.missedGauge > rep.frames.requested * 0.02) {
    reasons.push(`GAUGE-GAPS (${rep.missedGauge} frames had no vfxGauge sample — is ?vfxGauge=on set?)`);
  }
  return { ok: reasons.length === 0, verdict: reasons.length === 0 ? "USABLE" : "REJECT", reasons };
}

async function main() {
  if (!CDP) {
    console.error("moving-bench: --cdp=<endpoint> is required. This harness never picks an endpoint for you —\n"
      + "the operator owns the test box and its Chrome lifecycle.");
    process.exit(2);
  }
  const spec = buildSpec();
  const table = poseTable(spec);
  const url = buildUrl(ARM);
  console.log(`[moving-bench] mode=${spec.mode} frames=${table.rows.length} laps=${spec.laps} drive=${DRIVE}`);
  console.log(`[moving-bench] path checksum ${table.checksum}  (identical across arms by construction)`);
  console.log(`[moving-bench] arm=${ARM || "(default)"}`);
  console.log(`[moving-bench] url=${url}`);

  // One heavy job per machine (~/CLAUDE.md). Taken HERE, never at module
  // scope: harness/test_moving_bench_boot.mjs (a gate suite) imports this file.
  await acquireHeavyLock({ label: `moving-bench arm=${ARM || "(default)"}` });

  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  for (const p of ctx.pages()) { if (p.url() !== "about:blank") await p.close().catch(() => {}); }
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  const t0 = Date.now();
  let attempt = 0;
  for (;;) {
    const snap = await readBootSnapshot(page);
    const d = classifyBoot(snap, { attempt, maxAttempts: LOGIN_RETRIES });
    if (d.action === "go") break;
    if (d.action === "relogin") {
      attempt += 1;
      console.warn(`[moving-bench] boot error: ${d.reason}`);
      console.warn(`[moving-bench] relogin ${attempt}/${LOGIN_RETRIES} in ${LOGIN_COOLDOWN_MS}ms `
        + "(ACE holds the previous session's character for ~5-10 s; a fresh connect boots it)");
      await new Promise((r) => setTimeout(r, LOGIN_COOLDOWN_MS));
      // Fire-and-forget: the orchestrator's promise settles minutes later and
      // awaiting it here would just re-implement the poll below. `maxRetries:1`
      // lets the in-page attempt loop absorb a char-in-world (0x0D) refusal
      // itself; the claim guard makes a double-run impossible.
      const fired = await page.evaluate((o) => {
        if (typeof window.__runAutonomousLogin !== "function") return false;
        window.__runAutonomousLogin(o);
        return true;
      }, { autoSpawn: "first", maxRetries: 1 }).catch(() => false);
      if (!fired) {
        console.error("[moving-bench] BOOT-FAIL — window.__runAutonomousLogin is absent "
          + "(a --url without ?autoLogin=1 cannot be retried by this harness)");
        console.error(formatBootHistory(snap));
        process.exit(1);
      }
      continue;
    }
    if (d.action === "fatal") {
      console.error(`[moving-bench] BOOT-FAIL — ${d.reason}`);
      console.error("[moving-bench] boot-state history:");
      console.error(formatBootHistory(snap));
      process.exit(1);
    }
    // "wait": each relogin buys its own runway on top of --bootTimeout.
    if (Date.now() - t0 > BOOT_MS + attempt * LOGIN_RETRY_BUDGET_MS) {
      console.error(`[moving-bench] BOOT-TIMEOUT after ${((Date.now() - t0) / 1000).toFixed(1)}s `
        + `(last: ${d.reason})`);
      console.error("[moving-bench] boot-state history:");
      console.error(formatBootHistory(snap));
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  // Everything logged up to here is the login phase (see splitBootErrors).
  const bootErrorCut = errors.length;
  if (spec.mode !== "hop") {
    await page.evaluate((p) => window.__sessionHandle?.sendChat("@telepoi " + p), POI).catch(() => {});
  }
  // Settle: let the arrival stream finish BEFORE the warm lap, so the warm lap
  // is warming the path rather than paying for the teleport.
  await new Promise((r) => setTimeout(r, SETTLE_MS));

  await page.evaluate(movingRigSource());
  const install = await page.evaluate(
    (payload) => window.__mbench.install(payload),
    { spec: table.spec, rows: table.rows, events: table.events, warmFrames: table.rows.length, drive: DRIVE }
  );
  console.log(`[moving-bench] rig installed: ${JSON.stringify(install)} — warm lap, then measure lap`);

  const r = await page.evaluate(() => window.__mbench.run());
  // Provenance strictly AFTER the measure lap (see provenanceProbeSource).
  const prov = provenanceFields(await page.evaluate(provenanceProbeSource()).catch((e) => ({
    errors: [`probe: ${e && e.message ? e.message : e}`],
  })));
  await page.close().catch(() => {});

  const rep = {
    ts: new Date().toISOString(),
    arm: ARM || "(default)",
    url,
    spec: table.spec,
    pathChecksum: table.checksum,
    realisedChecksum: r.realisedChecksum,
    frames: { requested: table.rows.length, measured: r.frames, warm: r.warmFrames },
    cpuMs: stat(r.cpuMs),
    rafMs: stat(r.rafMs),
    missedGauge: r.missedGauge,
    workload: {
      // SUBMITTED per frame (renderer.info, differenced — autoReset is off).
      draws: stat(r.draws),
      ktris: stat(r.ktris),
      // RESIDENT, not submitted. Never price this as if it were drawn.
      residentInstances: r.census.instances,
      batchedMeshes: r.census.batched,
      staticBatchC: r.census.staticBatchC,
      // renderer.info.programs.length at the lap's end (null = stale rig).
      programs: Number.isFinite(r.programs) ? r.programs : null,
    },
    lb: { churnFrames: r.lb.churnFrames, countFirst: r.lb.counts[0], countLast: r.lb.counts[r.lb.counts.length - 1], hashFirst: r.lb.hashFirst, hashLast: r.lb.hashLast },
    walkDelta: deltaWalk(r.walk0, r.walk1),
    // Program ledger across the measure lap (`?linkProbe=on`); null = absent.
    link: r.link || null,
    // Login-phase errors are reported, never judged (see splitBootErrors).
    bootErrors: splitBootErrors(errors, bootErrorCut).bootErrors.slice(0, 8),
    reloginAttempts: attempt,
    errors: splitBootErrors(errors, bootErrorCut).runErrors.concat(r.errors || []).slice(0, 16),
    // Run provenance (test-tooling-8): header fields of the v2 report.
    renderer: prov.renderer,
    wasmProfile: prov.wasmProfile,
    wasmProbe: prov.wasmProbe,
    distGeneratedAt: prov.distGeneratedAt,
    commit: gitCommit(),
    provenanceErrors: prov.provenanceErrors,
  };
  const j = judge(rep, { churnMax: CHURN_MAX, drawSpreadMax: DRAW_SPREAD_MAX });
  rep.verdict = j.verdict;
  rep.rejectReasons = j.reasons;

  // RESULTS v2 (T01): same measurements, emitted through the shared report
  // writer — every figure now carries its mechanical @scale tag.
  const v2 = toResultsV2(rep, { series: { cpuMs: r.cpuMs, rafMs: r.rafMs, draws: r.draws } });
  writeFileSync(OUT, JSON.stringify(v2, null, 2));
  console.log("\n" + "=".repeat(72));
  console.log(`  MOVING BENCH — ${rep.arm}`);
  console.log("=".repeat(72));
  console.log(`  verdict        : ${rep.verdict}`);
  for (const why of j.reasons) console.log(`      ! ${why}`);
  console.log(`  path checksum  : intended ${rep.pathChecksum}  realised ${rep.realisedChecksum}`);
  console.log(`  frames         : ${rep.frames.measured}/${rep.frames.requested} (warm ${rep.frames.warm})`);
  console.log(`  cpuMs          : ${JSON.stringify(rep.cpuMs)}`);
  console.log(`  rafMs          : ${JSON.stringify(rep.rafMs)}`);
  console.log(`  draws/frame    : ${JSON.stringify(rep.workload.draws)}   (SUBMITTED)`);
  console.log(`  ktris/frame    : ${JSON.stringify(rep.workload.ktris)}`);
  console.log(`  resident slots : ${rep.workload.residentInstances}  buckets ${rep.workload.staticBatchC}/${rep.workload.batchedMeshes}   (RESIDENT)`);
  console.log(`  lb churn       : ${rep.lb.churnFrames} frames  count ${rep.lb.countFirst} -> ${rep.lb.countLast}  hash ${rep.lb.hashFirst} -> ${rep.lb.hashLast}`);
  console.log(`  walk delta     : ${JSON.stringify(rep.walkDelta)}`);
  console.log(`  programs       : ${rep.link
    ? `${rep.link.relinks} relinked, +${rep.link.created} -${rep.link.released} this lap, ${rep.link.programs} resident`
    : `${rep.workload.programs ?? "?"} resident (no relink ledger — pass --linkProbe)`}`);
  console.log(`  errors         : ${rep.errors.length}`);
  console.log(`  boot           : ${rep.reloginAttempts} relogin(s), ${rep.bootErrors.length} login-phase error(s) (reported, not judged)`);
  for (const be of rep.bootErrors) console.log(`      ~ ${be}`);
  console.log(`  provenance     : renderer=${rep.renderer ?? "?"}  wasm=${rep.wasmProfile} (${rep.wasmProbe.reason})  `
    + `dist=${rep.distGeneratedAt ?? "?"}  commit=${rep.commit ?? "?"}`);
  for (const pe of rep.provenanceErrors) console.log(`      ~ ${pe}`);
  console.log(`\n  full JSON -> ${OUT}`);
  console.log("=".repeat(72));

  // --history: hold this run to its own recent past, then keep it
  // (harness/perf-ratchet.mjs). A failure here never costs the run's JSON.
  let ratchetRegression = false;
  if (HISTORY) {
    const dir = resolveHistoryDir(HISTORY === true ? null : String(HISTORY));
    try {
      const { records: history } = readHistory(dir);
      const { records, toAppend } = ratchetResults(v2, history, { source: path.resolve(OUT), accept: HISTORY_ACCEPT });
      const file = appendHistory(dir, toAppend);
      for (const rec of records) {
        console.log(formatRatchet(rec));
        if (rec.ratchet?.verdict === "regression") ratchetRegression = true;
      }
      console.log(`  history -> ${file}`);
    } catch (e) {
      console.error(`[moving-bench] --history failed: ${e && e.message ? e.message : e} `
        + "(set HB_PERF_HISTORY or --history=DIR)");
    }
  }
  process.exit(j.ok ? (ratchetRegression ? 3 : 0) : 1);
}

/**
 * `getStatBatchXStats().walk` is CUMULATIVE since page load, so only the delta
 * across the measure lap describes the measure lap. Quoting the raw counter
 * would fold in the warm lap and the boot.
 */
export function deltaWalk(a, b) {
  if (!a || !b) return null;
  const keys = ["calls", "hitsExact", "hitsSlack", "rebuilds", "rebuildsSlack", "instancesWalked", "instancesSkipped", "errors"];
  const d = {};
  for (const k of keys) d[k] = (b[k] | 0) - (a[k] | 0);
  if (a.sphere && b.sphere) {
    d.sphere = {};
    for (const k of ["calls", "walks", "builds", "slotsBuilt", "slotsWalked", "ineligible", "errors", "lateActivations", "verifyFails"]) {
      d.sphere[k] = (b.sphere[k] | 0) - (a.sphere[k] | 0);
    }
    // The ONE ratio that says whether the cache is worth anything: slots read
    // from the cache per slot spent building it. Below ~1 the epoch is moving
    // faster than the cache can pay for itself.
    d.sphere.payback = d.sphere.slotsBuilt > 0 ? +(d.sphere.slotsWalked / d.sphere.slotsBuilt).toFixed(2) : null;
  }
  d.hitRate = (d.calls > 0) ? +((d.hitsExact + d.hitsSlack) / d.calls).toFixed(3) : null;
  return d;
}

/**
 * Fold one run's legacy rep into a RESULTS-v2 object (T01, pass-10 S12 —
 * "moving-bench's report is already ~this shape and converts first").
 * Behavior-preserving: the measurements are the same numbers judge() saw; the
 * emission path is the shared writer, which refuses untagged figures.
 *
 * Metric mapping (tags per pass-10 S1):
 *   rafMs  -> frameMs@moving   (the rAF interval IS the frame time; the arm
 *                               notes frameMsSource:"raf-interval")
 *   cpuMs  -> cpuMs@moving     (vfxGauge tick CPU)
 *   draws  -> draws@submitted  (renderer.info, differenced, autoReset off)
 *   ktris  -> ktris@submitted
 *   residentInstances/batchedMeshes/staticBatchC -> *@resident (RESIDENT,
 *                               never priced as if drawn — the founding wall)
 *   link.relinks  -> programsRelinked@moving  (`--linkProbe` only: programs
 *                               whose key was resident earlier, linked again
 *                               during the measure lap)
 *   link.programs -> programs@resident  (renderer.info.programs.length at the
 *                               lap's end). With the ledger present the header
 *                               taint lists "linkProbe" (pass-10 D-10.4.4); absent
 *                               ledger = neither ledger key, never a 0.
 *   workload.programs -> programs@resident  when there is no ledger (the rig's
 *                               bare count, every run since test-tooling-8);
 *                               absent or -1 = no key.
 *
 * Everything else the old file carried (checksums, frames, lb churn,
 * walkDelta, errors, spec, series) rides along as aux fields on the arm, so
 * nothing an operator read from the legacy shape is lost.
 *
 * Header provenance (test-tooling-8): rep.renderer -> platform.renderer,
 * rep.wasmProfile / commit / distGeneratedAt -> the D-10.6 run-validity
 * fields. A rep without them keeps the old "unknown"/null header exactly —
 * harness/perf-ratchet.mjs keys comparability on renderer + wasmProfile.
 *
 * A judge() USABLE run lands verdict EXPLORATORY (a single arm is never a
 * scored budget by itself); a REJECT run lands INVALID and is kept on disk as
 * evidence, never scored (PR-10).
 */
export function toResultsV2(rep, { series } = {}) {
  const metrics = {};
  if (rep.rafMs) metrics["frameMs@moving"] = rep.rafMs;
  if (rep.cpuMs) metrics["cpuMs@moving"] = rep.cpuMs;
  if (rep.workload?.draws) metrics["draws@submitted"] = rep.workload.draws;
  if (rep.workload?.ktris) metrics["ktris@submitted"] = rep.workload.ktris;
  if (Number.isFinite(rep.workload?.residentInstances)) metrics["instances@resident"] = rep.workload.residentInstances;
  if (Number.isFinite(rep.workload?.batchedMeshes)) metrics["batchedMeshes@resident"] = rep.workload.batchedMeshes;
  if (Number.isFinite(rep.workload?.staticBatchC)) metrics["staticBatchBuckets@resident"] = rep.workload.staticBatchC;
  const link = rep.link && Number.isFinite(rep.link.relinks) ? rep.link : null;
  if (link) {
    metrics["programsRelinked@moving"] = link.relinks;
    if (Number.isFinite(link.programs) && link.programs >= 0) metrics["programs@resident"] = link.programs;
  }
  // Without the ledger, the rig's bare count (test-tooling-8): the ratchet
  // needs programs@resident in DEFAULT runs to catch a default-on change that
  // adds programs. Absent / -1 (unreadable) = no key, never a 0.
  if (!("programs@resident" in metrics) && Number.isFinite(rep.workload?.programs) && rep.workload.programs >= 0) {
    metrics["programs@resident"] = rep.workload.programs;
  }
  return createReport({
    bench: "MOVE-FIX",
    protocol: "PC-3",
    url: rep.url,
    ts: rep.ts,
    // PR-13 (test-tooling-8): read from the loaded wasm's custom sections by
    // provenanceProbeSource; a rep without the probe stays "unknown".
    wasmProfile: rep.wasmProfile ?? "unknown",
    commit: rep.commit ?? null,
    distGeneratedAt: rep.distGeneratedAt ?? null,
    platform: { box: null, renderer: rep.renderer ?? null },
    // The ledger retains a ring of program records: a diagnostic that rides
    // a measurement is declared, not hidden (pass-10 D-10.4.4).
    ...(link ? { taint: ["linkProbe"] } : {}),
  })
    .addArm({
      arm: rep.arm,
      verdict: rep.verdict === "USABLE" ? "USABLE" : "REJECT",
      rejectReasons: rep.rejectReasons || [],
      metrics,
      frameMsSource: "raf-interval",
      spec: rep.spec,
      pathChecksum: rep.pathChecksum,
      realisedChecksum: rep.realisedChecksum,
      frames: rep.frames,
      missedGauge: rep.missedGauge,
      lb: rep.lb,
      walkDelta: rep.walkDelta,
      ...(link ? { link } : {}),
      errors: rep.errors,
      // Boot provenance (2026-08-10): how many relogins the gate had to spend
      // and what the login phase logged. Reported, never judged.
      reloginAttempts: rep.reloginAttempts ?? 0,
      bootErrors: rep.bootErrors ?? [],
      // How wasmProfile was decided (url, size, reason) + probe failures.
      ...(rep.wasmProbe ? { wasmProbe: rep.wasmProbe } : {}),
      ...(rep.provenanceErrors && rep.provenanceErrors.length ? { provenanceErrors: rep.provenanceErrors } : {}),
      ...(series !== undefined ? { series } : {}),
    })
    .setVerdict(rep.verdict === "USABLE" ? "EXPLORATORY" : "INVALID")
    .toJSON();
}

// Importable for tests; only `main()` touches the network.
const isMain = process.argv[1] && process.argv[1].endsWith("moving-bench.mjs");
if (isMain) main().catch((e) => { console.error("[moving-bench] fatal:", e && e.stack ? e.stack : e); process.exit(1); });
