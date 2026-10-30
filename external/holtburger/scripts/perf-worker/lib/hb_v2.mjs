// lib/hb_v2.mjs — the pure half of harness v2 (round 3, R3-0; 2026-10-30).
//
// Everything here is plain data in, plain data out: no browser, no ssh, no file system (the B0 snapshot
// check reads files only through the `io` its caller passes), no import side effects.
// hbbench.mjs / hbanatomy.mjs / hbsweep.mjs call it; scripts/perf-worker/tests/
// hb_v2.test.mjs pins it (URL building, DayGroup pick, heading bins, box-sample parsing, arms
// loading, the run-JSON asserts). Plan: apps/holtburger-web/docs/2026-10-29-round3-gpu-driven.md
// §3 R3-0 item 2, §4 protocol, §5 rule V.
//
// THE PINS (§4 protocol; every one is overridable by naming the parameter in an arm's flags):
//   skytime=13      the sky clock held at 13:00 (url-flags `skytime` row: numeric pin, applied once
//                   via SessionHandle.setSkyTimeOverride). Without it cloud, aerial-perspective and
//                   night-ramp cost follow the server clock (§1.6 "Any run with the sky pinned").
//   DayGroup 0      a fixed clear DayGroup. There is no URL flag for it: the driver calls
//                   `__sessionHandle.setGameDayOverride(day, year)` (lib.rs, Workstream Sky-G) with a
//                   (day, year) that retail's CalcPresentDayGroup LCG maps to index 0, and reads the
//                   index back from `getSkyState().dayGroupIndex`. Index 0's DAT name is "Sunny" and
//                   scene3d/daygroup_weather.js PROFILES[0] is 'sunny' (no storm, no snow). The DAT's
//                   three "Clear" groups (8, 10, 11) are NOT used: that inferred profile table maps
//                   them to light-snow / foggy / windy-clear, which would add weather cost
//                   (docs/openac-comparison-2026-10-08/round2-findings.json, the DAT day-name decode).
//   renderScale=1, adaptiveRes=off, targetFps=0 (lib/bench-url.mjs), and gpuGovernor=off ONCE THAT FLAG
//                   EXISTS (R3-11; §3 R3-0 "pinned the same way, so no bench arm is measured under a closed
//                   quality loop"): the drivers pass `governorFlag` when docs/url-flags.md has a
//                   `gpuGovernor` row (governorFlagDocumented), so no dead param rides the URL before it
//                   has a reader (scripts/lint-harness-params.mjs).
//   window          1920x1080 INNER (budget resolution; §4 "1920x1080 unless the arm says 720p").
// `--compat v1` turns every v2 page-side change off (old URL, 1280,720 outer window, 12 deg/s
// orbit, no in-page probe, no DayGroup, nothing between the settle and the tour's end: hbbench.mjs
// planArm boxSampleAt / pinsBeforeSegments / settledServerState / exposeOrbit) so RC-BENCH v2 reps 2-3
// pool with rep 1 (plan §1.1 note).

/** Harness version stamped into every run JSON. */
export const HARNESS_V2 = "hbbench-v2-2026-10-30";

/** Defaults of the v2 pins. */
export const V2_DEFAULTS = Object.freeze({
  skytime: 13,
  dayGroup: 0,
  window: "1920,1080",
  orbitDegPerSec: 18, // 360 deg in the 20 s moving segment: every heading sector sampled once
  renderScale: 1,
});

/** What `--compat v1` reproduces (hbbench.mjs before 2026-10-30). */
export const V1_DEFAULTS = Object.freeze({ window: "1280,720", orbitDegPerSec: 12 });

/** Retail Dereth: days per year and DayGroups in Region 0x13000000 (holtburger-world sky.rs tests). */
export const DERETH_DAYS_PER_YEAR = 360;
export const DERETH_DAY_GROUPS = 20;
/** DayGroup day names straight from client_portal.dat (round2-findings.json, the Region decode). */
export const DAY_GROUP_DAT_NAMES = Object.freeze([
  "Sunny", "Sunny", "Sunny", "Rainy", "Sunny", "Sunny", "Sunny", "Rainy", "Clear", "Rainy",
  "Clear", "Clear", "Cloudy", "Cloudy", "Cloudy", "Rainy", "Rainy", "Rainy", "Rainy", "Rainy",
]);

// --------------------------------------------------------------------------------------------
// URL building
// --------------------------------------------------------------------------------------------

/** URLSearchParams of a `a=b&c=d` flag string (a leading `?` or `&` is ignored). */
export function parseFlags(flags) {
  const s = String(flags || "").replace(/^[?&]+/, "");
  return new URLSearchParams(s);
}

/** The query string of a URL as URLSearchParams (hash ignored). */
export function urlParams(url) {
  const s = String(url);
  const h = s.indexOf("#");
  const head = h < 0 ? s : s.slice(0, h);
  const q = head.indexOf("?");
  return new URLSearchParams(q < 0 ? "" : head.slice(q + 1));
}

/** `url` with `k=v` appended unless the query already names `k`. Rest of the URL kept byte for byte. */
export function pinParam(url, k, v) {
  const s = String(url);
  const hashAt = s.indexOf("#");
  const head = hashAt < 0 ? s : s.slice(0, hashAt);
  const hash = hashAt < 0 ? "" : s.slice(hashAt);
  if (urlParams(head).has(k)) return s;
  const q = head.indexOf("?");
  const sep = q < 0 ? "?" : /[?&]$/.test(head) ? "" : "&";
  return `${head}${sep}${k}=${v}${hash}`;
}

/**
 * The bench URL of one arm. v1 (compat) is hbbench.mjs's pre-2026-10-30 URL exactly (before
 * lib/bench-url.mjs adds targetFps=0); v2 appends the §4 pins in a fixed order after the arm's own
 * flags, each only when neither the base nor the arm names it.
 * @param {string} app   e.g. http://127.0.0.1:8766/apps/holtburger-web/index.html
 * @param {{quality?:string, flags?:string, skytime?:number|string}} arm
 * @param {{compat?:string|null, skytime?:number|string|null, governorFlag?:boolean, account?:string, password?:string}} [o]
 */
export function benchUrlBase(app, arm, o = {}) {
  const acct = o.account || "tailnet1", pw = o.password || "tailnet1";
  const q = (arm && arm.quality) || "mid";
  const flags = arm && arm.flags ? String(arm.flags).replace(/^[?&]+/, "") : "";
  let url = `${app}?autoLogin=1&account=${acct}&password=${pw}&autoSpawn=first&nosw=1&camDebug=on&adaptiveRes=off&quality=${q}${flags ? "&" + flags : ""}`;
  if (o.compat === "v1") return url;
  const sky = arm && arm.skytime != null ? arm.skytime : o.skytime != null ? o.skytime : V2_DEFAULTS.skytime;
  if (sky !== "none") url = pinParam(url, "skytime", sky);
  url = pinParam(url, "renderScale", V2_DEFAULTS.renderScale);
  if (o.governorFlag) url = pinParam(url, "gpuGovernor", "off");
  return url;
}

/** True when a url-flags.md text documents the R3-11 `gpuGovernor` flag (a table row starting with it). */
export function governorFlagDocumented(urlFlagsMd) {
  return /^\|\s*`gpuGovernor`/m.test(String(urlFlagsMd || ""));
}

/** Password-free copy of a URL for logs and run JSON. */
export function redactUrl(url) {
  return String(url).replace(/(password=)[^&#]*/g, "$1***");
}

/**
 * The §4 pins as they ended up in the final URL. `armOverride` lists the pins the arm named
 * itself (an arm that benches a cap or a governor on purpose), so the assert is explicit, not lost.
 */
export function urlPins(url, arm) {
  const p = urlParams(url);
  const own = parseFlags(arm && arm.flags);
  const pick = (k) => (p.has(k) ? p.get(k) : null);
  const out = {
    targetFps: pick("targetFps"), adaptiveRes: pick("adaptiveRes"), renderScale: pick("renderScale"),
    gpuGovernor: pick("gpuGovernor"), skytime: pick("skytime"), quality: pick("quality"), nosw: pick("nosw"),
    armOverride: ["targetFps", "adaptiveRes", "renderScale", "gpuGovernor", "skytime"].filter((k) => own.has(k)),
  };
  return out;
}

/** Problems with the URL pins (empty = OK). Pins the arm overrides on purpose are not problems. */
export function urlPinProblems(pins, { compat = null, governorFlag = false } = {}) {
  const bad = [];
  const ok = (k, want) => pins.armOverride.includes(k) || pins[k] === want;
  if (!ok("targetFps", "0")) bad.push(`targetFps=${pins.targetFps} (want 0)`);
  if (!ok("adaptiveRes", "off")) bad.push(`adaptiveRes=${pins.adaptiveRes} (want off)`);
  if (compat !== "v1") {
    if (!ok("renderScale", "1")) bad.push(`renderScale=${pins.renderScale} (want 1)`);
    if (governorFlag && !ok("gpuGovernor", "off")) bad.push(`gpuGovernor=${pins.gpuGovernor} (want off)`);
    if (!pins.armOverride.includes("skytime") && pins.skytime === null) bad.push("skytime not pinned");
  }
  if (pins.nosw !== "1") bad.push(`nosw=${pins.nosw} (want 1)`);
  return bad;
}

/** "1920,1080" -> {w, h}; throws on anything that is not two positive integers. */
export function parseWindow(s) {
  const m = /^\s*(\d{3,5})\s*[,x]\s*(\d{3,5})\s*$/.exec(String(s || ""));
  if (!m) throw new Error(`window must be "W,H" (got ${JSON.stringify(s)})`);
  const w = +m[1], h = +m[2];
  if (w < 320 || h < 200 || w > 7680 || h > 4320) throw new Error(`window out of range: ${s}`);
  return { w, h };
}

// --------------------------------------------------------------------------------------------
// DayGroup (retail SkyDesc::CalcPresentDayGroup, ported verbatim in holtburger-world sky.rs)
// --------------------------------------------------------------------------------------------

/** Retail's DayGroup LCG: u32 wrap-around exactly as `calc_present_day_group` (sky.rs). */
export function calcPresentDayGroup(day, year, daysPerYear = DERETH_DAYS_PER_YEAR, numGroups = DERETH_DAY_GROUPS) {
  if (!numGroups) return 0;
  const key = ((day >>> 0) + Math.imul(daysPerYear >>> 0, year >>> 0)) >>> 0;
  const hashed = (Math.imul(1782775218, key) >>> 0) - 1967253934 >>> 0;
  const idx = Math.floor(hashed * 2.3283064e-10 * numGroups);
  return Math.min(idx, numGroups - 1);
}

/** The first (day, year) at `year` (days 1..daysPerYear) that the LCG maps to `index`, or null. */
export function dayYearForGroup(index, { year = 10, daysPerYear = DERETH_DAYS_PER_YEAR, numGroups = DERETH_DAY_GROUPS } = {}) {
  for (let y = year; y < year + 50; y++) {
    for (let d = 1; d <= daysPerYear; d++) if (calcPresentDayGroup(d, y, daysPerYear, numGroups) === index) return { day: d, year: y, index };
  }
  return null;
}

// --------------------------------------------------------------------------------------------
// Frame statistics (hbbench.mjs `stats`, unchanged output — moved here so the suite pins it)
// --------------------------------------------------------------------------------------------

/** Frame-interval summary. Same fields and rounding as hbbench.mjs has always written. */
export function frameStats(d) {
  if (!d || !d.length) return null;
  const s = [...d].sort((a, b) => a - b), n = s.length, sum = d.reduce((a, b) => a + b, 0);
  const q = (p) => +s[Math.min(n - 1, Math.floor(p * n))].toFixed(1);
  const lowOf = (f) => { const w = s.slice(Math.floor(n * (1 - f))); return +(1000 / (w.reduce((a, b) => a + b, 0) / w.length)).toFixed(1); };
  return { n, fps: +(n / (sum / 1000)).toFixed(1), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +s[n - 1].toFixed(0), low1: lowOf(0.01), low01: lowOf(0.001),
    h50: d.filter((x) => x > 50).length, h100: d.filter((x) => x > 100).length, h250: d.filter((x) => x > 250).length,
    jankMs: Math.round(d.filter((x) => x > 50).reduce((a, x) => a + x - 33.3, 0)) };
}

/** Median of the finite numbers in `arr` (null when none). */
export function median(arr) {
  const a = (arr || []).filter((x) => typeof x === "number" && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const n = a.length;
  return n % 2 ? a[n >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/** {n, mean, p50, p95, max} of numbers (null when empty). */
export function summary(arr, digits = 2) {
  const a = (arr || []).filter((x) => Number.isFinite(x));
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), n = s.length;
  const q = (p) => +s[Math.min(n - 1, Math.floor(p * n))].toFixed(digits);
  return { n, mean: +(a.reduce((x, y) => x + y, 0) / n).toFixed(digits), p50: q(0.5), p95: q(0.95), max: +s[n - 1].toFixed(digits) };
}

// --------------------------------------------------------------------------------------------
// Heading bins (L1; WebAC PERF.6 tools/measure-perf.ts: per-frame info + yaw, mean over sectors)
// --------------------------------------------------------------------------------------------

/**
 * Camera heading in AC degrees clockwise from north, [0, 360), from a three.js camera
 * matrixWorld (column-major `elements`). The scene is Y-up with AC (x, y, z) -> three (x, z, -y)
 * (scene3d/adapter.js acToThree), and the camera looks down its local -Z: forward = -(m8, m9, m10)
 * in three, so AC forward = (-m8, +m10) and heading = atan2(east, north) = atan2(-m8, m10).
 */
export function headingFromMatrix(m8, m10) {
  if (!Number.isFinite(m8) || !Number.isFinite(m10) || (m8 === 0 && m10 === 0)) return NaN;
  let deg = (Math.atan2(-m8, m10) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  if (deg >= 360) deg -= 360;
  return deg === 0 ? 0 : deg; // no -0
}

/** Sector index of a heading (0..n-1); NaN heading -> -1. */
export function sectorOf(deg, n = 12) {
  if (!Number.isFinite(deg)) return -1;
  const d = ((deg % 360) + 360) % 360;
  return Math.min(n - 1, Math.floor((d * n) / 360));
}

/**
 * Bin per-frame samples by heading. `frames` = array of objects with `yaw` (degrees) and numeric
 * fields. Returns per-sector means, the number of sectors that got at least one frame, and the
 * SECTOR-MEAN of each field (mean of the covered sectors' means: every heading counts once, however
 * long the camera dwelt there — WebAC PERF.6) next to the plain FRAME-MEAN.
 */
export function binByHeading(frames, fields, n = 12) {
  const sectors = Array.from({ length: n }, (_, i) => ({ sector: i, fromDeg: (i * 360) / n, frames: 0, sum: {}, cnt: {} }));
  const frameSum = {}, frameCnt = {};
  let used = 0, noYaw = 0;
  for (const f of frames || []) {
    const s = sectorOf(f.yaw, n);
    if (s < 0) { noYaw++; continue; }
    used++;
    const b = sectors[s];
    b.frames++;
    for (const k of fields) {
      // null / undefined / NaN = this frame does not know the field (e.g. the probe's last row's
      // ranges): it is left out of that field's means, not counted as 0.
      const v = f[k] === null || f[k] === undefined ? NaN : Number(f[k]);
      if (!Number.isFinite(v)) continue;
      b.sum[k] = (b.sum[k] || 0) + v; b.cnt[k] = (b.cnt[k] || 0) + 1;
      frameSum[k] = (frameSum[k] || 0) + v; frameCnt[k] = (frameCnt[k] || 0) + 1;
    }
  }
  const out = { sectors: [], covered: 0, n, frames: used, noYaw, sectorMean: {}, frameMean: {} };
  const acc = {};
  for (const b of sectors) {
    const row = { sector: b.sector, fromDeg: b.fromDeg, frames: b.frames };
    if (b.frames > 0) {
      out.covered++;
      for (const k of fields) {
        if (b.sum[k] === undefined) continue;
        row[k] = +(b.sum[k] / b.cnt[k]).toFixed(2);
        (acc[k] ||= []).push(b.sum[k] / b.cnt[k]);
      }
    }
    out.sectors.push(row);
  }
  for (const k of fields) {
    out.sectorMean[k] = acc[k] ? +(acc[k].reduce((a, x) => a + x, 0) / acc[k].length).toFixed(2) : null;
    out.frameMean[k] = frameCnt[k] ? +(frameSum[k] / frameCnt[k]).toFixed(2) : null;
  }
  return out;
}

/** Fields binned by heading in every probed segment. */
export const PROBE_BIN_FIELDS = Object.freeze(["calls", "realDraws", "subDraws", "issued", "terrainRanges", "renderJs", "walks", "tris"]);

/**
 * One probed segment (lib/hb_page.mjs pageInstallProbe `end()`) -> the run-JSON summary:
 * renderJs / info.calls / REAL draws (calls - BatchedMesh calls + ranges that reached ANGLE, i.e.
 * one D3D draw per issued range, plan §0 rule 5) / walks per frame, the multidraw range counts,
 * heading bins, a renderJs-per-draw figure (the dated µs-per-draw calibration's CPU half) and the
 * per-pass table (calls per frame, draws per call, ms per frame, share of empty walks).
 */
export function summarizeProbeSegment(p, { sectors = 12 } = {}) {
  if (!p || !p.cols) return null;
  const c = p.cols, n = p.n | 0;
  const frames = new Array(n);
  // null = not known (the probe's last row: its __batchedRuns totals become readable only on the
  // next rendered frame, after the segment ended). NaN keeps it out of every mean and heading bin.
  const num = (v) => (v === null || v === undefined ? NaN : v);
  for (let i = 0; i < n; i++) {
    const bC = num(c.bCalls[i]), iss = num(c.issued[i]);
    frames[i] = {
      yaw: c.yaw[i] === null ? NaN : c.yaw[i], calls: c.calls[i], tris: c.tris[i], renderJs: c.ms[i], walks: c.walks[i],
      world: c.world[i], empty: c.empty[i], batchedCalls: bC, subDraws: num(c.sub[i]), issued: iss,
      terrainRanges: c.terr[i], realDraws: c.calls[i] - bC + iss,
    };
  }
  const col = (k) => frames.map((f) => f[k]);
  const renderJs = summary(col("renderJs"), 3), calls = summary(col("calls"));
  const out = {
    n, renderJs, calls, realDraws: summary(col("realDraws")), tris: summary(col("tris"), 0),
    walks: summary(col("walks")), worldWalks: summary(col("world")), emptyWalks: summary(col("empty")),
    ranges: { batchedCalls: summary(col("batchedCalls")), subDraws: summary(col("subDraws")), issued: summary(col("issued")), terrain: summary(col("terrainRanges")) },
    usPerCall: renderJs && calls && calls.mean > 0 ? +((renderJs.mean * 1000) / calls.mean).toFixed(2) : null,
    headingBins: binByHeading(frames, PROBE_BIN_FIELDS, sectors),
    passes: (p.passes || []).slice(0, 40).map((x) => ({
      key: x.key, sceneChildren: x.sceneChildren, callsPerFrame: n ? +(x.calls / n).toFixed(3) : null,
      drawsPerCall: x.calls ? +(x.draws / x.calls).toFixed(1) : null, msPerFrame: n ? +(x.ms / n).toFixed(3) : null,
      emptyFrac: x.calls ? +(x.empty / x.calls).toFixed(3) : null,
    })),
    heap: p.heap || [], heapEnd: p.heapEnd ?? null, nested: p.nested | 0, terrainMeshes: p.terrainMeshes | 0, rangesApi: p.rangesApi ?? null,
  };
  return out;
}

// --------------------------------------------------------------------------------------------
// Box sample (box/hbwho.ps1 + top processes by CPU), one ssh round trip, no file deployed
// --------------------------------------------------------------------------------------------

/**
 * The PowerShell the laptop sends with `-EncodedCommand` (UTF-16LE base64, so no quoting crosses
 * ssh -> cmd.exe -> powershell). Prints two lines:
 *   HBWHO <box/hbwho.ps1's own status line>
 *   HBTOP {"wallMs":..,"cores":..,"top":[{"n":name,"p":pid,"c":cores,"o":0|1}, ...]}
 * `c` = CPU seconds the process used over the ~2 s window / wall seconds = core-equivalents.
 * `o` = 1 for OUR processes: the test Chrome (command line under D:\Temp\hbbench\, as
 * hbbench-kill.ps1 matches it) and its direct children (hbwho.ps1's rule), and this sampler with
 * its parent chain (powershell, cmd, sshd). Bench 1's Seagate Toolkit hog (one core at 100%) is
 * what this catches and boxwatch could not (plan §1.1).
 */
export function boxSampleScript({ windowMs = 2000, top = 10 } = {}) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$who = \"$((& 'D:\\Temp\\hbbench\\hbwho.ps1') | Select-Object -Last 1)\"",
    "$procs = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine)",
    "$byId = @{}; foreach ($p in $procs) { $byId[[int]$p.ProcessId] = $p }",
    "$roots = @($procs | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*D:\\Temp\\hbbench\\*' } | ForEach-Object { [int]$_.ProcessId })",
    "$ours = @{}",
    "foreach ($p in $procs) { if ($roots -contains [int]$p.ProcessId -or $roots -contains [int]$p.ParentProcessId) { $ours[[int]$p.ProcessId] = 1 } }",
    "$q = [int]$PID; for ($i = 0; $i -lt 6 -and $q -gt 4; $i++) { $ours[$q] = 1; if ($byId.ContainsKey($q)) { $q = [int]$byId[$q].ParentProcessId } else { break } }",
    "function Cpu($g) { try { return $g.TotalProcessorTime.TotalMilliseconds } catch { return $null } }",
    "$sw = [Diagnostics.Stopwatch]::StartNew()",
    "$a = @{}; foreach ($g in Get-Process) { if ($g.Id -ne 0) { $t = Cpu $g; if ($t -ne $null) { $a[[int]$g.Id] = $t } } }",
    `Start-Sleep -Milliseconds ${windowMs | 0}`,
    "$b = @(Get-Process); $ms = $sw.Elapsed.TotalMilliseconds",
    "$rows = @(foreach ($g in $b) { $id = [int]$g.Id; if ($id -ne 0 -and $a.ContainsKey($id)) { $t = Cpu $g; if ($t -ne $null) { $d = $t - $a[$id]; if ($d -gt 0) { [pscustomobject]@{ n = $g.ProcessName; p = $id; c = [math]::Round($d / $ms, 3); o = [int]$ours.ContainsKey($id) } } } } })",
    `$top = @($rows | Sort-Object c -Descending | Select-Object -First ${top | 0})`,
    "\"HBWHO $who\"",
    "'HBTOP ' + (ConvertTo-Json -Compress -Depth 4 -InputObject @{ wallMs = [math]::Round($ms); cores = [Environment]::ProcessorCount; top = $top })",
  ].join("\n");
}

/** base64(UTF-16LE(script)) for `powershell -EncodedCommand`. */
export function encodePowerShell(script) {
  return Buffer.from(String(script), "utf16le").toString("base64");
}

/** hbwho.ps1's `k=v k=v` line -> numbers (unknown values kept as strings). */
export function parseHbwho(line) {
  const out = {};
  for (const tok of String(line || "").trim().split(/\s+/)) {
    const i = tok.indexOf("=");
    if (i <= 0) continue;
    const k = tok.slice(0, i), v = tok.slice(i + 1);
    const n = Number(v);
    out[k] = v !== "" && Number.isFinite(n) ? n : v;
  }
  return out;
}

/** The sampler's stdout -> {who, top:[{name,pid,cores,ours}], wallMs, cores, maxOther}. */
export function parseBoxSample(stdout) {
  const res = { who: null, top: [], wallMs: null, cores: null, maxOther: null, raw: null };
  for (const raw of String(stdout || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("HBWHO ")) res.who = parseHbwho(line.slice(6));
    else if (line.startsWith("HBTOP ")) {
      try {
        const j = JSON.parse(line.slice(6));
        res.wallMs = j.wallMs ?? null;
        res.cores = j.cores ?? null;
        const rows = Array.isArray(j.top) ? j.top : j.top ? [j.top] : [];
        res.top = rows.map((r) => ({ name: String(r.n), pid: r.p | 0, cores: +r.c || 0, ours: r.o === 1 }));
      } catch (e) { res.raw = line.slice(0, 400); }
    }
  }
  const other = res.top.filter((r) => !r.ours);
  res.maxOther = other.length ? other.reduce((m, r) => (r.cores > m.cores ? r : m)) : null;
  return res;
}

// --------------------------------------------------------------------------------------------
// Arms
// --------------------------------------------------------------------------------------------

/**
 * Arms from a parsed JSON: an arms file (array, as every arms-*.json so far) or an hb-1070-queue-v1
 * queue file with `item` naming an item that carries an `arms` array. Every arm gets a name.
 */
export function loadArms(json, item = null) {
  let arms;
  if (Array.isArray(json)) arms = json;
  else if (json && json.schema === "hb-1070-queue-v1") {
    if (!item) throw new Error("queue file: pass --item <id> (an item with an `arms` array)");
    const it = (json.items || []).find((x) => x.id === item);
    if (!it) throw new Error(`queue file: no item ${item}`);
    if (!Array.isArray(it.arms)) throw new Error(`queue item ${item} has no arms array`);
    arms = it.arms.map((a) => ({ ...(it.armDefaults || {}), ...a }));
  } else throw new Error("arms: expected an array or an hb-1070-queue-v1 file");
  const seen = new Set();
  for (const a of arms) {
    if (!a || typeof a.name !== "string" || !a.name) throw new Error("every arm needs a name");
    if (seen.has(a.name)) throw new Error(`duplicate arm ${a.name}`);
    seen.add(a.name);
    if (/[^A-Za-z0-9_.-]/.test(a.name)) throw new Error(`arm name ${a.name}: letters, digits, _ . - only (it names files)`);
  }
  return arms;
}

/** hbbench's interleave: rep r runs the arms rotated by r-1. */
export function rotation(arms, rep) {
  return arms.map((_, i) => arms[(i + rep - 1) % arms.length]);
}

/** Relative difference |a-b|/a (a = the reference arm's count). */
export function relDelta(ref, x) {
  if (!Number.isFinite(ref) || !Number.isFinite(x) || ref === 0) return null;
  return Math.abs(x - ref) / ref;
}

/**
 * The run-JSON asserts (rule V's machine half). `res` is one arm-rep result; returns
 * {ok, problems[]}. A problem here makes hbreport mark the arm-rep INVALID.
 */
export function runAssertProblems(res) {
  const p = [];
  const a = res && res.asserts;
  if (!a) return { ok: false, problems: ["no asserts recorded (pre-v2 run)"] };
  if (a.adapter && !/1070/.test(a.adapter)) p.push(`adapter ${a.adapter}`);
  if (!a.adapter) p.push("adapter not read");
  if (!a.wasm || a.wasm.profile !== "release") p.push(`wasm ${a.wasm ? a.wasm.profile : "unknown"}`);
  for (const x of a.urlPinProblems || []) p.push(`url: ${x}`);
  if (a.dayGroup && a.dayGroup.wanted != null && a.dayGroup.index !== a.dayGroup.wanted) p.push(`dayGroup ${a.dayGroup.index} (want ${a.dayGroup.wanted})`);
  if (a.skyTimePin && a.skyTimePin.wanted != null && !(Math.abs((a.skyTimePin.hours ?? NaN) - a.skyTimePin.wanted) < 0.01)) p.push(`skytime ${a.skyTimePin.hours} (want ${a.skyTimePin.wanted})`);
  if (a.window && a.window.target && a.window.inner) {
    const [tw, th] = a.window.target, [iw, ih] = a.window.inner;
    if (Math.abs(tw - iw) > 2 || Math.abs(th - ih) > 2) p.push(`window inner ${iw}x${ih} (want ${tw}x${th})`);
  }
  return { ok: p.length === 0, problems: p };
}

/** One verdict over the wasm files the page loaded: "release" only when every file is a release build. */
export function wasmVerdict(files) {
  const f = files || [];
  if (!f.length) return "unknown";
  return f.every((w) => w && w.profile === "release") ? "release" : f.some((w) => w && w.profile === "DEV-WASM") ? "DEV-WASM" : "unknown";
}

/** Hours of day a `skytime` URL value pins (url-flags `skytime`: > 1 = hour 0-24, else normalised 0-1); null when not a numeric pin. */
export function skyHoursWanted(skytime) {
  if (skytime === null || skytime === undefined || !/^[0-9.]+$/.test(String(skytime))) return null;
  const v = +skytime;
  if (!Number.isFinite(v)) return null;
  return v > 1 ? v : +(v * 24).toFixed(2);
}

/**
 * The run-JSON `asserts` block of one booted arm (hbbench.mjs runOne and lib/hb_boot.mjs bootArm build
 * it the same way, so hbanatomy's runs carry the URL-pin and window checks too). `plan` = planArm's
 * result; `gpu` = the adapter string read at boot; `pins` = pageApplyPins's read-back; `wasm` = the
 * wasm profile of every .wasm the page loaded; `sized` = sizeWindow's result (or undefined).
 */
export function buildAsserts({ plan, gpu, pins, wasm, sized }) {
  const p = pins || {};
  const skyWanted = skyHoursWanted(plan.pins.skytime);
  return {
    adapter: gpu,
    wasm: { profile: wasmVerdict(wasm), files: wasm || [] },
    urlPins: plan.pins, urlPinProblems: urlPinProblems(plan.pins, { compat: plan.compat, governorFlag: plan.governorFlag }), governorFlag: !!plan.governorFlag,
    dayGroup: plan.dayGroup ? { wanted: plan.dayGroup.index, index: p.dayGroup ? p.dayGroup.index : null, day: plan.dayGroup.day, year: plan.dayGroup.year } : null,
    skyTimePin: skyWanted === null ? null : { wanted: skyWanted, hours: p.skyTimePin ? p.skyTimePin.hours : null },
    window: plan.window.target ? { target: [plan.window.target.w, plan.window.target.h], inner: p.window ? p.window.inner : null, dpr: p.window ? p.window.dpr : null } : null,
    renderScale: p.renderScale ?? null, pixelRatio: p.pixelRatio ?? null, frameCap: p.frameCap ?? null, gpuGovernor: p.gpuGovernor ?? null,
    windowEmulated: !!(sized && sized.emulated),
  };
}

/**
 * Problems of an ATTACHED session (hbsweep.mjs / hbanatomy.mjs --attach on a session another tool
 * booted) against the §4 protocol: the URL pins of the page's own URL, the DayGroup and skytime read
 * back, the inner window, the port of the server under test (B0 = the frozen snapshot on :8766), the
 * adapter. `pins` = pageApplyPins's read-back (with `adapter: true`).
 */
export function sessionPinProblems({ url, pins, dayGroup = null, inner = null, port = null, governorFlag = false }) {
  const bad = [];
  const p = pins || {};
  const up = urlPins(url || "", { flags: "" });
  for (const x of urlPinProblems(up, { governorFlag })) bad.push(`url: ${x}`);
  const want = skyHoursWanted(up.skytime);
  if (want !== null && !(p.skyTimePin && Math.abs(p.skyTimePin.hours - want) < 0.01)) bad.push(`skytime ${p.skyTimePin ? p.skyTimePin.hours : "not pinned"} (want ${want})`);
  if (dayGroup && (!p.dayGroup || p.dayGroup.index !== dayGroup.index)) bad.push(`dayGroup ${p.dayGroup ? p.dayGroup.index : null} (want ${dayGroup.index})`);
  if (inner) {
    const got = p.window && p.window.inner;
    if (!got || Math.abs(got[0] - inner.w) > 2 || Math.abs(got[1] - inner.h) > 2) bad.push(`window inner ${got ? got.join("x") : "?"} (want ${inner.w}x${inner.h})`);
  }
  if (port != null) {
    let got = null;
    try { got = new URL(url).port || null; } catch (_) { /* not a URL */ }
    if (String(got) !== String(port)) bad.push(`page served from :${got}, want :${port} (the build under test)`);
  }
  if (!p.adapter || !/1070/.test(p.adapter)) bad.push(`adapter ${p.adapter || "not read"} (not the GTX 1070)`);
  return bad;
}

// --------------------------------------------------------------------------------------------
// B0 snapshot precondition (queue `b0Snapshot`; plan §3 R3-0 item 1, 2026-10-30 lane H2)
// --------------------------------------------------------------------------------------------

/**
 * Does the frozen snapshot that will serve B0 carry the code the M1 arms depend on? Each requirement of
 * `spec.requiredReaders` = {flag, file | dir, patterns: [RegExp source, ...]}: `file` (or, with `dir`,
 * at least one .js / .mjs file under it) must exist in the snapshot, be the snapshot's OWN copy (no
 * symlink anywhere on the path, so its realpath stays inside the snapshot) and match every pattern.
 * It reads the flag's READER, never docs/url-flags.md: hb-mksnap.sh symlinks docs/ (and pkg/, until it
 * is replaced by a release copy) into the live tree, so a url-flags row there says nothing about the
 * snapshot's code. A requirement without patterns checks only that the file is a real copy (the
 * release pkg wasm). `liveRoot` = the live tree: a "snapshot" that IS the live tree is refused.
 * Pure: every file access goes through `io` = {realpath, lstat -> {isSymlink, isDir} | null, readText,
 * readdir -> names}. Returns {ok, problems[], found[{flag, file}]}.
 */
export function snapshotReaderProblems(root, spec, io, { liveRoot = null } = {}) {
  const problems = [], found = [];
  const reqs = (spec && Array.isArray(spec.requiredReaders)) ? spec.requiredReaders : [];
  if (!reqs.length) return { ok: false, problems: ["the queue has no b0Snapshot.requiredReaders"], found };
  const trim = (p) => String(p).replace(/\/+$/, "");
  const base = trim(root);
  let rootReal;
  try { rootReal = trim(io.realpath(base)); } catch (e) { return { ok: false, problems: [`snapshot ${root}: ${(e && e.message) || e}`], found }; }
  if (liveRoot) {
    let live = null;
    try { live = trim(io.realpath(trim(liveRoot))); } catch (_) { /* no live tree here */ }
    if (live && live === rootReal) problems.push(`${root} is the live tree, not a frozen snapshot`);
  }
  // every component below the snapshot root must be a real entry (no symlink into the live tree)
  const ownCopy = (rel) => {
    let cur = base;
    for (const part of String(rel).split("/").filter(Boolean)) {
      cur = `${cur}/${part}`;
      const st = io.lstat(cur);
      if (!st) return `missing ${rel}`;
      if (st.isSymlink) return `${cur.slice(base.length + 1)} is a symlink (not the snapshot's own copy)`;
    }
    return null;
  };
  const matches = (text, pats) => pats.every((p) => new RegExp(p).test(text));
  const walk = (rel, out, depth = 0) => {
    if (depth > 8) return;
    for (const name of io.readdir(`${base}/${rel}`).sort()) {
      const r = `${rel}/${name}`;
      const st = io.lstat(`${base}/${r}`);
      if (!st || st.isSymlink) continue; // a symlinked entry is not the snapshot's own code
      if (st.isDir) walk(r, out, depth + 1);
      else if (/\.(m?js)$/.test(name)) out.push(r);
    }
  };
  for (const q of reqs) {
    const pats = Array.isArray(q.patterns) ? q.patterns : q.pattern ? [q.pattern] : [];
    const where = q.file || q.dir;
    if (!where) { problems.push(`${q.flag}: requirement names no file or dir`); continue; }
    const bad = ownCopy(where);
    if (bad) { problems.push(`${q.flag}: ${bad}`); continue; }
    if (q.file) {
      if (pats.length && !matches(io.readText(`${base}/${q.file}`), pats)) { problems.push(`${q.flag}: reader not found in ${q.file} (${pats.join(" + ")})`); continue; }
      found.push({ flag: q.flag, file: q.file });
    } else {
      const files = [];
      walk(trim(q.dir), files);
      const hit = files.find((f) => matches(io.readText(`${base}/${f}`), pats));
      if (!hit) { problems.push(`${q.flag}: no reader under ${q.dir} (${pats.join(" + ")})`); continue; }
      found.push({ flag: q.flag, file: hit });
    }
  }
  return { ok: problems.length === 0, problems, found };
}

/** Retry an async fn: `tries` attempts, waiting delays[i] ms between them. Rethrows the last error. */
export async function retry(fn, { tries = 3, delays = [5000, 15000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(i); } catch (e) {
      last = e;
      if (i + 1 < tries) await sleep(delays[Math.min(i, delays.length - 1)] ?? 0);
    }
  }
  throw last;
}
