#!/usr/bin/env node
// validate_skybox.cjs — Wave 5.B skybox parity end-to-end driver.
//
// Workflow:
//   1. Sample 24 game-times across the AC day-length (7620s, per
//      `project_holtburger_skybox_done_2026-05-11` line 153).
//   2. For each sample:
//      a. Send `region-skybox-snapshot {gameTimeSec}` to a persistent
//         WB.Terminal --stdin subprocess → C# canonical envelope.
//      b. Run the pure-JS port of the cloud_volume.js Clouds-C math on
//         the same gameTimeSec → JS subject envelope.
//      c. Diff the 5 DayGroup uniforms (SkyTop / SkyBottom /
//         SunPosition / Ambient / Fog) — tolerance 1e-4 on every f32
//         component.
//   3. Emit report.json conforming to the §4.4 envelope under
//      /mnt/wbterminal1/holtburger-validator-reports/skybox/<ts>/.
//   4. Exit:
//        0 — passed (24/24 samples agree on ALL 5 uniforms within 1e-4)
//        1 — drift on at least one sample
//        2 — infra (WB.Terminal subprocess crashed; JS port threw)
//
// **Why a pure-JS oracle instead of headed browser?**
// The cloud_volume.js Clouds-C path (`tick(state)`) is a pure mapping
// from `SkyState` to 5 uniforms — see `cloud_volume.js:160-220`. The
// SkyState itself comes from Rust's `SkyEvalState::evaluate`. Wave 5.B
// validates the projection, not the runtime renderer. A pure-Node port
// of both halves (eval → uniforms) gives deterministic per-sample
// outputs that the C# oracle can grade. Browser-driven sampling adds
// rAF jitter + WebGL roundtrips that mask the math under noise.
// (Browser-driven validation is reserved for the in-game visual A/B
// next to Sky-K.2.)
//
// **Pre-reqs:**
//   - WorldBuilder.Terminal built (Release).
//   - `~/ac_base_dats/client_portal.dat` present (sha256
//     `dc6e500b…` per [[feedback_base_dats_only_for_bake]]).
//   - Node ≥ 18 (Buffer / Math.fround intrinsics).
//
// **Run:**
//   `node validate_skybox.cjs`
//
// See:
//   - `docs/skybox-parity-method.md`
//   - `WorldBuilder.Terminal/CommandEngine.Skybox.cs`
//   - `external/holtburger/crates/holtburger-world/src/sky.rs`
//   - `external/holtburger/apps/holtburger-web/scene3d/cloud_volume.js`
//   - `external/holtburger/apps/holtburger-web/scene3d/sun_direction.js`

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// ── Constants ────────────────────────────────────────────────────────────
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const WBT_DLL = path.join(
  REPO_ROOT,
  "WorldBuilder.Terminal",
  "bin",
  "Release",
  "net8.0",
  "WorldBuilder.Terminal.dll"
);
const DOTNET = process.env.DOTNET_ROOT
  ? path.join(process.env.DOTNET_ROOT, "dotnet")
  : "/home/wbterminal/.dotnet/dotnet";

const REPORT_ROOT = "/mnt/wbterminal1/holtburger-validator-reports/skybox";

// AC day length in seconds. Retail Dereth ships day_length=7620 (127 min
// real-time per AC day) per the Sky-A probe. We do NOT hardcode the day
// length here — we read it from C#'s region-day-night-curve response,
// which fetches it from Region.GameTime.DayLength. That keeps the
// validator decoupled from any future Region edit. The constant below
// is the default-when-missing fallback.
const FALLBACK_DAY_LENGTH_SECONDS = 7620;

// Sample count. Default 24 — one per hour of the AC day. Per the brief
// (§W5.B done criteria): "24 sampled game-times (1/h): all 5 DayGroup
// uniforms match within 1e-4".
const SAMPLE_COUNT = 24;

// Tolerance per f32 component, per the brief. ~3.3 ULPs of single
// precision at unit magnitude — well above IEEE 754 trig roundoff
// (`Math.sin/cos` deltas are O(1e-15)) and ARGB byte-rounding
// (O(1/255) ≈ 4e-3, but ARGB is bit-exact across both ports).
const TOLERANCE = 1e-4;

// ── Pure-JS port of Rust holtburger_world::sky::SkyEvalState ────────────
// Mirrors:
//   - SkyEvalState::evaluate (sky.rs:475)
//   - evaluate_lighting       (sky.rs:594)
//   - find_keyframe_pair      (sky.rs:649)
//   - lerp_sky_time           (sky.rs:718)
//   - lerp_argb               (sky.rs:969)
//   - calc_present_day_group  (sky.rs:576)
//
// The port treats the supplied gameTimeSec as "seconds since
// AC_LAUNCH_UNIX_EPOCH" — identical convention to
// CommandEngine.Skybox.cs's BuildSnapshotForGameTimeSec.

function calcPresentDayGroup(day, year, daysPerYear, numGroups) {
  if (numGroups === 0) return 0;
  // Unsigned 32-bit wrap math via BigInt to mirror Rust's wrapping_*.
  const LCG_MULT = 1782775218n;
  const LCG_ADDEND = 1967253934n;
  const MASK32 = 0xFFFFFFFFn;
  const key = (BigInt(day) + BigInt(daysPerYear) * BigInt(year)) & MASK32;
  const hashed = ((LCG_MULT * key - LCG_ADDEND) & MASK32);
  // 1/2^32 — same magic constant as C++ / Rust / C# port.
  const fraction = Number(hashed) * 2.3283064e-10;
  const idx = Math.floor(fraction * numGroups);
  return Math.min(idx, numGroups - 1);
}

function findKeyframePair(skyTimes, t) {
  if (skyTimes.length === 0) throw new Error("empty SkyTime");
  if (skyTimes.length === 1) return { a: skyTimes[0], b: skyTimes[0], u: 0 };
  for (let i = 0; i < skyTimes.length; i++) {
    if (skyTimes[i].begin > t) {
      if (i === 0) {
        const a = skyTimes[skyTimes.length - 1];
        const b = skyTimes[0];
        const span = (b.begin + 1) - a.begin;
        if (span <= 0) return { a, b, u: 0 };
        const tWrap = (t < a.begin) ? t + 1 : t;
        const u = Math.max(0, Math.min(1, (tWrap - a.begin) / span));
        return { a, b, u };
      }
      const a = skyTimes[i - 1];
      const b = skyTimes[i];
      const span = b.begin - a.begin;
      if (span <= 0) return { a, b, u: 0 };
      const u = Math.max(0, Math.min(1, (t - a.begin) / span));
      return { a, b, u };
    }
  }
  // Past last keyframe — wrap last → first.
  const a = skyTimes[skyTimes.length - 1];
  const b = skyTimes[0];
  const span = (b.begin + 1) - a.begin;
  if (span <= 0) return { a, b, u: 0 };
  const u = Math.max(0, Math.min(1, (t - a.begin) / span));
  return { a, b, u };
}

function lerpArgb(a, b, u) {
  u = Math.max(0, Math.min(1, u));
  const aa = (a >>> 24) & 0xFF;
  const ar = (a >>> 16) & 0xFF;
  const ag = (a >>> 8) & 0xFF;
  const ab = a & 0xFF;
  const ba = (b >>> 24) & 0xFF;
  const br = (b >>> 16) & 0xFF;
  const bg = (b >>> 8) & 0xFF;
  const bb = b & 0xFF;
  // Rust uses f32 lerp + .round() + u8 clamp. Math.round in JS matches
  // round-half-away-from-zero (same as Rust f32::round); both are 1-LSB
  // exact for non-negative byte values.
  const lerp = (x, y) => Math.max(0, Math.min(255, Math.round(x + (y - x) * u)));
  return (
    ((lerp(aa, ba) << 24) >>> 0) |
    (lerp(ar, br) << 16) |
    (lerp(ag, bg) << 8) |
    lerp(ab, bb)
  ) >>> 0;
}

function lerpSkyTime(a, b, u, dayGroupIndex, timeOfDay) {
  u = Math.max(0, Math.min(1, u));
  const lerp = (x, y) => x + (y - x) * u;
  return {
    dirColorArgb: lerpArgb(a.dirColor, b.dirColor, u),
    dirBright: lerp(a.dirBright, b.dirBright),
    dirHeading: lerp(a.dirHeading, b.dirHeading),
    dirPitch: lerp(a.dirPitch, b.dirPitch),
    ambColorArgb: lerpArgb(a.ambColor, b.ambColor, u),
    ambBright: lerp(a.ambBright, b.ambBright),
    fogColorArgb: lerpArgb(a.worldFogColor, b.worldFogColor, u),
    fogMin: lerp(a.minWorldFog, b.minWorldFog),
    fogMax: lerp(a.maxWorldFog, b.maxWorldFog),
    worldFog: (u < 0.5) ? a.worldFog : b.worldFog,
    timeOfDayNormalized: timeOfDay,
    dayGroupIndex,
  };
}

// AC → three.js sun direction from heading (deg) + pitch (deg).
// Verbatim from scene3d/sun_direction.js::sunDirFromHeadingPitch
// (the JS-side authoritative formula).
function sunDirFromHeadingPitch(headingDeg, pitchDeg) {
  const DEG = Math.PI / 180;
  const h = headingDeg * DEG;
  const p = pitchDeg * DEG;
  const cp = Math.cos(p);
  const sp = Math.sin(p);
  return [
    cp * Math.sin(h),
    sp,
    -cp * Math.cos(h),
  ];
}

// ARGB 0xAARRGGBB → [r, g, b] in 0..1.
function argbToRgb01(argb) {
  return [
    ((argb >>> 16) & 0xFF) / 255,
    ((argb >>> 8) & 0xFF) / 255,
    (argb & 0xFF) / 255,
  ];
}

// Project a raw SkyState onto the 5 DayGroup uniforms — the same
// projection cloud_volume.js's Clouds-C path applies.
function projectToUniforms(raw) {
  return {
    skyTop: argbToRgb01(raw.ambColorArgb),
    skyBottom: argbToRgb01(raw.fogColorArgb),
    sunPosition: sunDirFromHeadingPitch(raw.dirHeading, raw.dirPitch),
    ambient: raw.dirBright,
    // Same formula as the Clouds-C contract table in cloud_volume.js:35:
    //   uFogDensity = ln(2) / max(1, (fogMax - fogMin) * 0.5)
    fog: Math.log(2) / Math.max(1, (raw.fogMax - raw.fogMin) * 0.5),
  };
}

/**
 * Pure-JS evaluator. Given a parsed Region snapshot AND a gameTimeSec,
 * return both the raw SkyState AND the projected uniforms.
 *
 * Mirror of CommandEngine.Skybox.BuildSnapshotForGameTimeSec.
 */
function evaluateSkyboxJs(region, gameTimeSec) {
  const dayLength = region.gameTime.dayLength;
  const daysPerYear = Math.max(1, region.gameTime.daysPerYear);
  const zeroYear = region.gameTime.zeroYear;
  const zeroTimeOfYear = region.gameTime.zeroTimeOfYear;

  const worldSeconds = gameTimeSec + zeroTimeOfYear;
  const worldDay = Math.floor(worldSeconds / dayLength);
  let rem = worldSeconds - worldDay * dayLength;
  if (rem < 0) rem += dayLength;
  const timeOfDayNormalized = rem / dayLength;

  // Signed Euclidean div/rem for (day, year):
  let r = worldDay % daysPerYear;
  if (r < 0) r += daysPerYear;
  const dayInYear = r;
  const yearOffset = (worldDay - r) / daysPerYear;
  const day = dayInYear >>> 0;
  const year = (zeroYear + yearOffset) >>> 0;

  const dayGroups = region.skyInfo.dayGroups;
  const dayGroupIndex = calcPresentDayGroup(day, year, daysPerYear, dayGroups.length);
  const dayGroup = dayGroups[dayGroupIndex];

  const { a, b, u } = findKeyframePair(dayGroup.skyTime, timeOfDayNormalized);
  const raw = lerpSkyTime(a, b, u, dayGroupIndex, timeOfDayNormalized);
  const uniforms = projectToUniforms(raw);

  return {
    gameTimeSec,
    normalizedDayPosition: timeOfDayNormalized,
    dayGroupIndex,
    dayGroupName: dayGroup.dayName,
    uniforms,
    rawSkyState: raw,
    weatherStateName: dayGroup.dayName,
  };
}

// ── WB.Terminal subprocess driver (sequential single-stream) ────────────
class WbtDriver {
  constructor() {
    this.child = null;
    this.buf = "";
    this.queue = [];
    this.current = null;
    this.stderrBuf = "";
  }
  start() {
    this.child = spawn(DOTNET, [WBT_DLL, "--stdin"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.child.stdout.on("data", (chunk) => this.onData(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk) => {
      this.stderrBuf += chunk.toString("utf8");
    });
    this.child.on("exit", (code) => {
      if (this.current) {
        const { reject } = this.current;
        this.current = null;
        reject(new Error(
          `WB.Terminal exited (code=${code}) mid-command. stderr:\n${this.stderrBuf.slice(-2000)}`
        ));
      }
    });
  }
  onData(data) {
    this.buf += data;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.command === "ready") continue;
      if (this.current &&
          (obj.command === this.current.expected || obj.success === false)) {
        const { resolve } = this.current;
        this.current = null;
        resolve(obj);
        this.drain();
      }
    }
  }
  send(commandObj, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      this.queue.push({ commandObj, resolve, reject, expected: commandObj.command, timeoutMs });
      this.drain();
    });
  }
  drain() {
    if (this.current || this.queue.length === 0) return;
    const next = this.queue.shift();
    this.current = next;
    const timer = setTimeout(() => {
      if (this.current === next) {
        this.current = null;
        next.reject(new Error(`Timeout ${next.timeoutMs}ms for ${next.expected}`));
        this.drain();
      }
    }, next.timeoutMs);
    const origResolve = next.resolve;
    next.resolve = (val) => { clearTimeout(timer); origResolve(val); };
    next.reject = ((origReject) => (err) => { clearTimeout(timer); origReject(err); })(next.reject);
    this.child.stdin.write(JSON.stringify(next.commandObj) + "\n");
  }
  stop() {
    try { this.child.stdin.end(); } catch (_) {}
    try { this.child.kill(); } catch (_) {}
  }
}

// ── Region read-once cache ──────────────────────────────────────────────
//
// To make the JS-side evaluator self-contained, we need the Region's
// SkyDesc + GameTime. We pull it via WB.Terminal's chorizite-parse-dat-record
// command (which already exists and produces the canonical Chorizite
// field tree). This means the JS-side oracle math reads the SAME bytes
// the C#-side oracle reads, eliminating any "different parse" drift.

async function loadRegionForJsEval(driver) {
  const resp = await driver.send({
    command: "chorizite-parse-dat-record",
    idHex: "0x13000000",
    typeName: "Region",
  });
  if (!resp.success || resp.errorMessage) {
    throw new Error(`Failed to parse Region 0x13000000: ${resp.errorMessage ?? "(no message)"}`);
  }
  // Normalise the Chorizite field tree into the shape evaluateSkyboxJs expects.
  // The chorizite-parse-dat-record envelope camelCases field names and
  // unwraps the AC1LegacyPStringBase via System.Text.Json reflection.
  const fields = resp.fields;
  if (!fields) throw new Error("chorizite-parse-dat-record returned null fields");

  function unwrapArgb(v) {
    // ColorARGB struct serialises as { alpha, red, green, blue } camelCase
    // bytes via System.Text.Json default. Compose to 0xAARRGGBB.
    if (v && typeof v === "object" && "alpha" in v) {
      return (((v.alpha & 0xFF) << 24) >>> 0) |
             ((v.red & 0xFF) << 16) |
             ((v.green & 0xFF) << 8) |
             (v.blue & 0xFF);
    }
    if (typeof v === "number") return v >>> 0;
    if (typeof v === "string" && v.startsWith("0x")) return parseInt(v.slice(2), 16) >>> 0;
    return 0;
  }
  function unwrapPString(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "object" && "value" in v) return String(v.value);
    return String(v);
  }
  function unwrapQualifiedDataId(v) {
    if (v == null) return 0;
    if (typeof v === "number") return v >>> 0;
    if (typeof v === "object" && "dataId" in v) return v.dataId >>> 0;
    if (typeof v === "object" && "id" in v) return v.id >>> 0;
    if (typeof v === "string" && v.startsWith("0x")) return parseInt(v.slice(2), 16) >>> 0;
    return 0;
  }

  const gameTime = {
    zeroTimeOfYear: fields.gameTime.zeroTimeOfYear,
    zeroYear: fields.gameTime.zeroYear,
    dayLength: fields.gameTime.dayLength,
    daysPerYear: fields.gameTime.daysPerYear,
  };

  const dayGroups = fields.skyInfo.dayGroups.map((dg) => ({
    chanceOfOccur: dg.chanceOfOccur,
    dayName: unwrapPString(dg.dayName),
    skyObjects: dg.skyObjects.map((so) => ({
      beginTime: so.beginTime,
      endTime: so.endTime,
      beginAngle: so.beginAngle,
      endAngle: so.endAngle,
      texVelocityX: so.texVelocityX,
      texVelocityY: so.texVelocityY,
      defaultGfxObjectId: unwrapQualifiedDataId(so.defaultGfxObjectId),
      defaultPesObjectId: unwrapQualifiedDataId(so.defaultPesObjectId),
      properties: so.properties,
    })),
    skyTime: dg.skyTime.map((kf) => ({
      begin: kf.begin,
      dirBright: kf.dirBright,
      dirHeading: kf.dirHeading,
      dirPitch: kf.dirPitch,
      dirColor: unwrapArgb(kf.dirColor),
      ambBright: kf.ambBright,
      ambColor: unwrapArgb(kf.ambColor),
      minWorldFog: kf.minWorldFog,
      maxWorldFog: kf.maxWorldFog,
      worldFogColor: unwrapArgb(kf.worldFogColor),
      worldFog: kf.worldFog,
      skyObjReplace: (kf.skyObjReplace ?? []).map((r) => ({
        objectIndex: r.objectIndex,
        gfxObjId: unwrapQualifiedDataId(r.gfxObjId),
        rotate: r.rotate,
        transparent: r.transparent,
        luminosity: r.luminosity,
        maxBright: r.maxBright,
      })),
    })),
  }));

  return {
    gameTime,
    skyInfo: { dayGroups },
  };
}

// ── Diff helpers ─────────────────────────────────────────────────────────
function diffComponent(name, oracle, subject, tolerance) {
  const drift = Math.abs(oracle - subject);
  return {
    name,
    oracle,
    subject,
    drift,
    pass: drift <= tolerance,
  };
}

function diffUniforms(oracleUniforms, subjectUniforms, tolerance) {
  const rows = [];
  const O = oracleUniforms;
  const S = subjectUniforms;
  // SkyTop (Vec3)
  rows.push(diffComponent("uniforms.skyTop[0]", O.skyTop[0], S.skyTop[0], tolerance));
  rows.push(diffComponent("uniforms.skyTop[1]", O.skyTop[1], S.skyTop[1], tolerance));
  rows.push(diffComponent("uniforms.skyTop[2]", O.skyTop[2], S.skyTop[2], tolerance));
  // SkyBottom (Vec3)
  rows.push(diffComponent("uniforms.skyBottom[0]", O.skyBottom[0], S.skyBottom[0], tolerance));
  rows.push(diffComponent("uniforms.skyBottom[1]", O.skyBottom[1], S.skyBottom[1], tolerance));
  rows.push(diffComponent("uniforms.skyBottom[2]", O.skyBottom[2], S.skyBottom[2], tolerance));
  // SunPosition (Vec3)
  rows.push(diffComponent("uniforms.sunPosition[0]", O.sunPosition[0], S.sunPosition[0], tolerance));
  rows.push(diffComponent("uniforms.sunPosition[1]", O.sunPosition[1], S.sunPosition[1], tolerance));
  rows.push(diffComponent("uniforms.sunPosition[2]", O.sunPosition[2], S.sunPosition[2], tolerance));
  // Ambient (scalar)
  rows.push(diffComponent("uniforms.ambient", O.ambient, S.ambient, tolerance));
  // Fog (scalar)
  rows.push(diffComponent("uniforms.fog", O.fog, S.fog, tolerance));
  const maxDrift = Math.max(...rows.map((r) => r.drift));
  const allPass = rows.every((r) => r.pass);
  return { rows, maxDrift, allPass };
}

// ── Main ────────────────────────────────────────────────────────────────
(async () => {
  console.log("=== Wave 5.B region-skybox-snapshot validator ===");
  if (!fs.existsSync(WBT_DLL)) {
    console.error(`FATAL: WB.Terminal.dll missing at ${WBT_DLL}`);
    console.error(`Build: dotnet build WorldBuilder.Terminal -c Release`);
    process.exit(2);
  }

  const startedAt = new Date();
  const ts = startedAt.toISOString().replace(/\.[0-9]{3}Z$/, "Z").replace(/:/g, "-");
  const reportDir = path.join(REPORT_ROOT, ts);
  fs.mkdirSync(reportDir, { recursive: true });
  console.log(`report dir: ${reportDir}`);

  const driver = new WbtDriver();
  driver.start();

  let dayLengthSeconds = FALLBACK_DAY_LENGTH_SECONDS;
  let datSha256 = "";
  let datPath = "";
  let region;
  try {
    // Step 1: load Region 0x13000000 once. The JS-side oracle math
    // reads from the chorizite-parse-dat-record envelope; that's
    // bytewise-identical to what region-skybox-snapshot reads.
    console.log("loading Region 0x13000000 …");
    region = await loadRegionForJsEval(driver);
    dayLengthSeconds = region.gameTime.dayLength;
    console.log(`  Region loaded: ${region.skyInfo.dayGroups.length} DayGroups, ` +
                `day_length=${dayLengthSeconds}s, days_per_year=${region.gameTime.daysPerYear}`);

    // Step 2: also fetch one C# call to pull the canonical sha256.
    const probe = await driver.send({
      command: "region-skybox-snapshot",
      gameTimeSec: 0,
    });
    if (!probe.success) {
      throw new Error(`region-skybox-snapshot probe failed: ${probe.error}`);
    }
    datSha256 = probe.datSha256;
    datPath = probe.datPath;
    console.log(`  base DAT sha256: ${datSha256}`);

    // Step 3: sample the 24 game-times across one full day.
    const sampleTimes = [];
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      sampleTimes.push((i * dayLengthSeconds) / SAMPLE_COUNT);
    }
    console.log(`sampling ${SAMPLE_COUNT} game-times across ${dayLengthSeconds}s day …`);

    const samples = [];
    for (const gts of sampleTimes) {
      const oracle = await driver.send({
        command: "region-skybox-snapshot",
        gameTimeSec: gts,
      });
      if (!oracle.success) {
        throw new Error(`region-skybox-snapshot failed at gts=${gts}: ${oracle.error}`);
      }
      const subject = evaluateSkyboxJs(region, gts);
      const diff = diffUniforms(oracle.uniforms, subject.uniforms, TOLERANCE);
      const sample = {
        gameTimeSec: gts,
        oracle: {
          normalizedDayPosition: oracle.normalizedDayPosition,
          dayGroupIndex: oracle.dayGroupIndex,
          dayGroupName: oracle.dayGroupName,
          uniforms: oracle.uniforms,
          rawSkyState: oracle.rawSkyState,
        },
        subject: {
          normalizedDayPosition: subject.normalizedDayPosition,
          dayGroupIndex: subject.dayGroupIndex,
          dayGroupName: subject.dayGroupName,
          uniforms: subject.uniforms,
          rawSkyState: subject.rawSkyState,
        },
        diff: {
          maxDrift: diff.maxDrift,
          allPass: diff.allPass,
          // Only include the actual mismatching rows in the report —
          // a full 11-row dump for 24 samples is noisy.
          mismatches: diff.rows.filter((r) => !r.pass),
        },
      };
      samples.push(sample);
      const marker = diff.allPass ? "PASS" : "FAIL";
      console.log(
        `  gts=${gts.toFixed(2).padStart(8)} → ` +
        `pos=${oracle.normalizedDayPosition.toFixed(4)} ` +
        `dgi=${oracle.dayGroupIndex.toString().padStart(2)} ` +
        `${oracle.dayGroupName.padEnd(10)} ` +
        `maxDrift=${diff.maxDrift.toExponential(2)} ${marker}`
      );
    }

    const passedCount = samples.filter((s) => s.diff.allPass).length;
    const failedCount = samples.length - passedCount;
    const overallMaxDrift = Math.max(...samples.map((s) => s.diff.maxDrift));

    // Per-uniform max drift across all samples — load-bearing diagnostic.
    const perUniformMaxDrift = {};
    const uniformNames = [
      "uniforms.skyTop[0]", "uniforms.skyTop[1]", "uniforms.skyTop[2]",
      "uniforms.skyBottom[0]", "uniforms.skyBottom[1]", "uniforms.skyBottom[2]",
      "uniforms.sunPosition[0]", "uniforms.sunPosition[1]", "uniforms.sunPosition[2]",
      "uniforms.ambient", "uniforms.fog",
    ];
    for (const name of uniformNames) perUniformMaxDrift[name] = 0;
    for (const s of samples) {
      const O = s.oracle.uniforms;
      const S = s.subject.uniforms;
      const pairs = [
        ["uniforms.skyTop[0]", O.skyTop[0], S.skyTop[0]],
        ["uniforms.skyTop[1]", O.skyTop[1], S.skyTop[1]],
        ["uniforms.skyTop[2]", O.skyTop[2], S.skyTop[2]],
        ["uniforms.skyBottom[0]", O.skyBottom[0], S.skyBottom[0]],
        ["uniforms.skyBottom[1]", O.skyBottom[1], S.skyBottom[1]],
        ["uniforms.skyBottom[2]", O.skyBottom[2], S.skyBottom[2]],
        ["uniforms.sunPosition[0]", O.sunPosition[0], S.sunPosition[0]],
        ["uniforms.sunPosition[1]", O.sunPosition[1], S.sunPosition[1]],
        ["uniforms.sunPosition[2]", O.sunPosition[2], S.sunPosition[2]],
        ["uniforms.ambient", O.ambient, S.ambient],
        ["uniforms.fog", O.fog, S.fog],
      ];
      for (const [name, o, ss] of pairs) {
        const d = Math.abs(o - ss);
        if (d > perUniformMaxDrift[name]) perUniformMaxDrift[name] = d;
      }
    }

    // §4.4 envelope.
    const envelope = {
      surface: "skybox-parity",
      oracle: {
        kind: "wb-terminal-region-skybox-snapshot",
        method: "skybox-parity-method.md",
        citations: [
          "external/holtburger/crates/holtburger-world/src/sky.rs",
          "external/holtburger/crates/holtburger-dat/src/file_type/region.rs",
          "Chorizite.DatReaderWriter.DBObjs.Region(0x13000000)",
          "external/GDL/PhatSDK/SkyDesc.cpp:52-71 (CalcPresentDayGroup)",
          "external/holtburger/apps/holtburger-web/scene3d/cloud_volume.js:35 (Clouds-C contract)",
          "external/holtburger/apps/holtburger-web/scene3d/sun_direction.js:49 (sunDirFromHeadingPitch)",
        ],
      },
      subject: {
        kind: "holtburger-web-cloud-volume-js-port",
        method: "skybox-parity-method.md",
        notes: [
          "Pure-Node port of cloud_volume.js's Clouds-C SkyState→uniform projection.",
          "Reads same Region bytes via chorizite-parse-dat-record (no Playwright).",
        ],
      },
      bakeSourceSha256: datSha256,
      subjectSha256: null, // pure-JS port; no compiled artifact
      summary: {
        checked: samples.length,
        pass: passedCount,
        fail: failedCount,
        skipped: 0,
        tolerance: TOLERANCE,
        maxDrift: overallMaxDrift,
        dayLengthSeconds,
        sampleCount: SAMPLE_COUNT,
        perUniformMaxDrift,
      },
      mismatches: samples
        .filter((s) => !s.diff.allPass)
        .map((s) => ({
          gameTimeSec: s.gameTimeSec,
          normalizedDayPosition: s.oracle.normalizedDayPosition,
          dayGroupIndex: s.oracle.dayGroupIndex,
          dayGroupName: s.oracle.dayGroupName,
          maxDrift: s.diff.maxDrift,
          mismatches: s.diff.mismatches,
        })),
      finishedAt: new Date().toISOString(),
      startedAt: startedAt.toISOString(),
      datPath,
      datSha256,
      outputPath: reportDir,
    };
    const reportPath = path.join(reportDir, "report.json");
    fs.writeFileSync(reportPath, JSON.stringify(envelope, null, 2));

    // Also write the per-sample dump so a future debugger can see every
    // f32 oracle/subject pair.
    fs.writeFileSync(
      path.join(reportDir, "samples.json"),
      JSON.stringify({ samples }, null, 2)
    );

    console.log("");
    console.log(`=== Wave 5.B skybox-parity SUMMARY ===`);
    console.log(`checked:      ${samples.length}`);
    console.log(`pass:         ${passedCount}`);
    console.log(`fail:         ${failedCount}`);
    console.log(`tolerance:    ${TOLERANCE}`);
    console.log(`maxDrift:     ${overallMaxDrift.toExponential(3)}`);
    console.log(`per-uniform max drift:`);
    for (const name of uniformNames) {
      console.log(`  ${name.padEnd(28)} ${perUniformMaxDrift[name].toExponential(3)}`);
    }
    console.log(`reportPath:   ${reportPath}`);
    driver.stop();
    process.exit(failedCount === 0 ? 0 : 1);
  } catch (e) {
    driver.stop();
    console.error(`[w5b-val] FATAL: ${e?.stack || e?.message || e}`);
    // Try to write a failure report so we have evidence.
    try {
      fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify({
        surface: "skybox-parity",
        infraError: e?.message || String(e),
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
      }, null, 2));
    } catch (_) {}
    process.exit(2);
  }
})();
