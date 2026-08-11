// oracle-diff.mjs — the movement/combat parity differ.
//
// Takes retail telemetry (pcap2jsonl output, or the D2 Chorizite plugin's
// dump) plus holtburger telemetry (?moveTelemetry=1), aligns them per
// scenario, computes per-segment movement metrics, and emits:
//   (a) a human report ranked by |delta|, so the biggest divergence is the
//       first thing you read;
//   (b) retail-pins.json — machine-readable retail truth, the input to future
//       retail_behavior_tests in holtburger-core.
//
// DESIGN NOTES worth knowing before changing anything here:
//
// * The two sides sample at different, IRREGULAR rates. Retail's curve is
//   reconstructed from wire traffic the client happens to send (position
//   updates are event-driven, not a fixed tick), while holtburger's is a
//   per-tick dump. So every metric is computed on a RESAMPLED uniform grid
//   rather than on raw samples — otherwise "median speed" silently weights
//   whichever side happened to emit more samples in the window.
//
// * Alignment is by FIRST-MOTION EDGE, not by wall clock. The two rigs start
//   their input scripts at unrelated absolute times, and the retail capture
//   includes login traffic before the scenario. Anchoring on "first sample
//   whose speed crosses MOTION_EPS" makes the comparison independent of both.
//
// * Speed is taken from an explicit velocity field when the source carries
//   one, else differentiated from position. Retail's UpdatePosition only
//   carries velocity when the HAS_VELOCITY flag is set, so the fallback is
//   the common path, not an edge case.
//
// * Heading is unwrapped across the 0/360 seam before any turn rate is
//   taken. Without that, a turn through north reads as a ~-360 deg/s spike
//   and poisons the median.
//
// Run:
//   node harness/oracle-diff.mjs --retail retail.jsonl --holt holt.jsonl \
//        --scenario run-hold --out-report report.md --out-pins retail-pins.json
//   node harness/oracle-diff.mjs --selftest

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Speed (m/s) above which we consider the avatar to be moving. */
export const MOTION_EPS = 0.15;
/** Resample grid period (ms). 20ms is finer than either source emits. */
export const GRID_MS = 20;

// ---------------------------------------------------------------------------
// loading + normalization
// ---------------------------------------------------------------------------

export function parseJsonl(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // A capture truncated mid-write leaves a partial final line; skip it
      // rather than failing the whole run.
    }
  }
  return out;
}

function norm360(d) {
  let x = d % 360;
  if (x < 0) x += 360;
  return x;
}

/**
 * Collapse a telemetry record stream into uniform samples:
 *   { t, x, y, z, heading, speed?, grounded?, gait?, cast?, jump? }
 * `t` is in SECONDS for retail-pcap (pcap timestamps) and whatever the holt
 * dump used; both are converted to ms here.
 */
/**
 * @param records raw JSONL records
 * @param playerGuid required to admit any s2c position into the player curve
 * @param playerStream "c2s" (default) or "all"
 *
 * TWO TRAPS the first real capture walked straight into, both guarded here:
 *
 * 1. MIXED SOURCES. The client reports its own position upstream (c2s
 *    MoveToState / AutonomousPosition) AND the server echoes it back (s2c
 *    UpdatePosition) a few tens of ms later carrying the SAME coordinates.
 *    Differentiating across the interleaved stream yields a real speed
 *    followed by a 0.000, alternating — the median of which is ~0. So the
 *    player curve is built from ONE source, and c2s is the right one: it is
 *    the client's own physics output, which is what holtburger's local
 *    integrator is being compared against.
 *
 * 2. UNFILTERED s2c. Every entity in view emits UpdatePosition. Without a
 *    guid filter an NPC across the square lands in the player's curve; the
 *    first real capture produced a 185 m/s "sample" exactly this way. s2c
 *    positions are therefore admitted ONLY when an explicit playerGuid says
 *    which ones are the player's.
 */
export function normalize(records, { playerGuid = null, playerStream = "c2s" } = {}) {
  const samples = [];
  const events = [];
  for (const r of records) {
    const src = r.source ?? "unknown";
    // Time: retail-pcap emits seconds, the holt surface emits ms. Normalize
    // to ms using an explicit unit marker when present, else infer: a
    // scenario is seconds-to-minutes long, so a t under 10_000 that came from
    // a pcap is seconds.
    const tms = r.t_ms != null ? r.t_ms : src === "retail-pcap" ? r.t * 1000 : r.t;

    if (src === "retail-pcap") {
      // --- retail side -------------------------------------------------
      // The client's OWN physics output is what we want to compare against
      // holtburger's local integrator, and the client reports it upstream in
      // c2s MoveToState / AutonomousPosition. Server-sent UpdatePosition for
      // the player is a second, coarser source (it is the server's echo).
      if (r.kind === "GameAction" && r.dir === "c2s") {
        const d = r.data ?? {};
        if (d.action === "MoveToState" || d.action === "AutonomousPosition") {
          samples.push({
            t: tms,
            x: d.x,
            y: d.y,
            z: d.z,
            heading: d.heading_deg,
            lb: d.lb,
            raw: d.raw_motion ?? null,
            origin: d.action,
          });
        } else if (d.action === "Jump") {
          events.push({ t: tms, type: "jump", extent: d.extent, vel: d.vel });
        }
      } else if (r.kind === "UpdatePosition" || r.kind === "PositionAndMovementEvent") {
        // Trap 2: never admit an s2c position without an explicit player
        // guid, and never mix the server echo into a c2s-sourced curve.
        if (!playerGuid || r.guid !== playerGuid) continue;
        if (playerStream === "c2s") continue;
        const p = r.pos ?? {};
        samples.push({
          t: tms,
          x: p.x,
          y: p.y,
          z: p.z,
          heading: p.heading_deg,
          lb: p.lb,
          speed: p.speed,
          grounded: p.grounded,
          origin: r.kind,
        });
      } else if (r.kind === "VectorUpdate") {
        if (playerGuid && r.guid !== playerGuid) continue;
        events.push({ t: tms, type: "vector", speed: r.speed });
      } else if (r.kind === "PlayEffect" || r.kind === "PlayScriptId") {
        events.push({ t: tms, type: "playscript", script: r.script_id, target: r.target });
      } else if (r.kind === "UpdateMotion") {
        events.push({ t: tms, type: "motion", movement: r.movement });
      }
    } else {
      // --- holtburger side ---------------------------------------------
      // The ?moveTelemetry=1 dump is already one record per tick.
      if (r.pos) {
        samples.push({
          t: tms,
          x: r.pos.x,
          y: r.pos.y,
          z: r.pos.z,
          heading: r.heading ?? r.pos.heading_deg,
          lb: r.pos.lb,
          speed: r.speed ?? (r.vel ? Math.hypot(r.vel.x ?? 0, r.vel.y ?? 0) : undefined),
          grounded: r.grounded,
          gait: r.gait,
          cast: r.cast,
          origin: "holt-tick",
        });
      }
      if (r.event) events.push({ t: tms, type: r.event, ...r });
    }
  }
  samples.sort((a, b) => a.t - b.t);
  events.sort((a, b) => a.t - b.t);
  return { samples, events };
}

/**
 * Fill in derived speed (from position deltas) and unwrap heading.
 * Mutates and returns the sample array.
 */
export function derive(samples) {
  let unwrapped = null;
  let prevRaw = null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    // speed from position when not carried explicitly
    if (s.speed == null && i > 0) {
      const p = samples[i - 1];
      const dt = (s.t - p.t) / 1000;
      if (dt > 0 && Number.isFinite(s.x) && Number.isFinite(p.x)) {
        s.speed = Math.hypot(s.x - p.x, s.y - p.y) / dt;
      }
    }
    // heading unwrap: accumulate the shortest-arc delta so a turn through
    // north does not read as a -359 deg jump.
    if (Number.isFinite(s.heading)) {
      if (unwrapped == null) {
        unwrapped = s.heading;
      } else {
        let d = norm360(s.heading - prevRaw);
        if (d > 180) d -= 360;
        unwrapped += d;
      }
      prevRaw = s.heading;
      s.headingUnwrapped = unwrapped;
    }
  }
  if (samples.length && samples[0].speed == null) samples[0].speed = 0;
  return samples;
}

// ---------------------------------------------------------------------------
// alignment + resampling
// ---------------------------------------------------------------------------

/** Index of the first sample whose speed crosses MOTION_EPS. */
export function firstMotionIndex(samples, eps = MOTION_EPS) {
  for (let i = 0; i < samples.length; i++) {
    if ((samples[i].speed ?? 0) > eps) return i;
  }
  return -1;
}

/**
 * Re-base sample times so the first-motion edge is t=0. Returns a new array.
 * Falls back to the first sample when nothing ever moves (a cast-only or
 * failed run) so the caller still gets a usable, if flat, curve.
 */
export function alignToFirstMotion(samples, eps = MOTION_EPS) {
  if (!samples.length) return { samples: [], t0: 0, moved: false };
  const i = firstMotionIndex(samples, eps);
  const moved = i >= 0;
  const t0 = moved ? samples[i].t : samples[0].t;
  return { samples: samples.map((s) => ({ ...s, t: s.t - t0 })), t0, moved };
}

/** Linear-interpolate a field onto a uniform ms grid over [t0,t1]. */
export function resample(samples, field, t0, t1, gridMs = GRID_MS) {
  const pts = samples.filter((s) => Number.isFinite(s[field]));
  const out = [];
  if (!pts.length) return out;
  let j = 0;
  for (let t = t0; t <= t1; t += gridMs) {
    while (j < pts.length - 1 && pts[j + 1].t < t) j++;
    const a = pts[j];
    const b = pts[Math.min(j + 1, pts.length - 1)];
    let v;
    if (b === a || b.t === a.t) {
      v = a[field];
    } else if (t <= a.t) {
      v = a[field];
    } else if (t >= b.t) {
      v = b[field];
    } else {
      const f = (t - a.t) / (b.t - a.t);
      v = a[field] + f * (b[field] - a[field]);
    }
    out.push({ t, v });
  }
  return out;
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

/** Median speed over a [start,end] ms window (post-alignment). */
export function steadySpeed(samples, [start, end]) {
  const grid = resample(samples, "speed", start, end);
  return median(grid.map((g) => g.v));
}

/**
 * Time (ms from alignment zero) to reach 90% of `target` speed.
 * Returns null when the curve never gets there.
 */
export function accelT90(samples, target, searchEnd = 4000) {
  if (!target) return null;
  const grid = resample(samples, "speed", 0, searchEnd);
  const thresh = 0.9 * target;
  for (const g of grid) if (g.v >= thresh) return g.t;
  return null;
}

/** Time from `releaseT` to the first sample at <=10% of `target`. */
export function decelT10(samples, target, releaseT, searchEnd) {
  if (!target) return null;
  const grid = resample(samples, "speed", releaseT, searchEnd ?? releaseT + 2000);
  const thresh = 0.1 * target;
  for (const g of grid) if (g.v <= thresh) return g.t - releaseT;
  return null;
}

/** Median turn rate (deg/s) over a window, from the unwrapped heading. */
export function turnRate(samples, [start, end]) {
  const grid = resample(samples, "headingUnwrapped", start, end);
  if (grid.length < 2) return null;
  const rates = [];
  for (let i = 1; i < grid.length; i++) {
    const dt = (grid[i].t - grid[i - 1].t) / 1000;
    if (dt > 0) rates.push((grid[i].v - grid[i - 1].v) / dt);
  }
  return median(rates);
}

/** Apex height, airtime and planar distance over a flight window. */
export function jumpMetrics(samples, [start, end]) {
  const win = samples.filter((s) => s.t >= start && s.t <= end && Number.isFinite(s.z));
  if (win.length < 2) return { jump_apex: null, jump_airtime: null, jump_distance: null };
  const z0 = win[0].z;
  let apex = -Infinity;
  let apexIdx = 0;
  for (let i = 0; i < win.length; i++) {
    if (win[i].z > apex) {
      apex = win[i].z;
      apexIdx = i;
    }
  }
  // Landing: first sample after apex back within 5cm of launch height.
  let landIdx = win.length - 1;
  for (let i = apexIdx; i < win.length; i++) {
    if (win[i].z <= z0 + 0.05) {
      landIdx = i;
      break;
    }
  }
  const dist = Math.hypot(win[landIdx].x - win[0].x, win[landIdx].y - win[0].y);
  return {
    jump_apex: apex - z0,
    jump_airtime: win[landIdx].t - win[0].t,
    jump_distance: dist,
  };
}

/**
 * Compute every metric a scenario asks for. `windows` come from the scenario
 * spec; times are ms relative to the scenario's own zero, and the sample
 * stream has already been aligned, so they line up directly.
 */
export function computeMetrics(samples, scenario) {
  const out = {};
  const w = scenario.windows ?? {};
  const wants = Object.keys(scenario.expect ?? {});

  // Per-window steady speeds, for both "steady" and named sub-windows.
  for (const [name, range] of Object.entries(w)) {
    const sp = steadySpeed(samples, range);
    if (name === "steady") out.steady_speed = sp;
    else out[`${name}.steady_speed`] = sp;
  }
  if (out.steady_speed == null && w.steady) out.steady_speed = steadySpeed(samples, w.steady);

  const target = out.steady_speed ?? out["second_hold.steady_speed"] ?? out["pre_jump.steady_speed"];

  if (wants.includes("accel_t90")) out.accel_t90 = accelT90(samples, target);
  if (wants.includes("decel_t10") && w.release) {
    out.decel_t10 = decelT10(samples, target, w.release[0], w.release[1]);
  }
  if (wants.includes("turn_rate") && w.steady) out.turn_rate = turnRate(samples, w.steady);
  if (w.flight && wants.some((k) => k.startsWith("jump_"))) {
    Object.assign(out, jumpMetrics(samples, w.flight));
  }
  if (w.cast) {
    out.cast_speed_during = steadySpeed(samples, w.cast);
  }
  if (wants.includes("heading_drift") && w.steady) {
    const grid = resample(samples, "headingUnwrapped", w.steady[0], w.steady[1]);
    out.heading_drift = grid.length ? grid[grid.length - 1].v - grid[0].v : null;
  }
  // Gait, when the source reports it — a metric comparison is meaningless if
  // the two sides were in different gaits, so this is surfaced not hidden.
  const gaits = new Set(samples.map((s) => s.gait).filter(Boolean));
  if (gaits.size) out.gait = [...gaits].join("|");
  return out;
}

// ---------------------------------------------------------------------------
// comparison + report
// ---------------------------------------------------------------------------

export function compareScenario(scenario, retailSamples, holtSamples, metricDefs = {}) {
  const r = computeMetrics(retailSamples, scenario);
  const h = computeMetrics(holtSamples, scenario);
  const keys = [...new Set([...Object.keys(r), ...Object.keys(h)])].sort();
  const rows = [];
  for (const k of keys) {
    const rv = r[k];
    const hv = h[k];
    if (typeof rv !== "number" || typeof hv !== "number") {
      rows.push({ metric: k, retail: rv ?? null, holt: hv ?? null, delta: null, pct: null, verdict: "no-data" });
      continue;
    }
    const delta = hv - rv;
    const pct = rv !== 0 ? (delta / Math.abs(rv)) * 100 : null;
    const base = k.split(".").pop();
    const tol = metricDefs[base]?.tolerance;
    const verdict = tol == null ? "no-tolerance" : Math.abs(delta) <= tol ? "PASS" : "FAIL";
    rows.push({ metric: k, retail: rv, holt: hv, delta, pct, verdict });
  }
  // Rank by |delta| relative to tolerance where we have one, else by |pct|,
  // so the report's first row is the worst real divergence rather than
  // whichever metric happens to have the largest raw units.
  rows.sort((a, b) => {
    const score = (x) => {
      if (x.delta == null) return -1;
      const base = x.metric.split(".").pop();
      const tol = metricDefs[base]?.tolerance;
      return tol ? Math.abs(x.delta) / tol : Math.abs(x.pct ?? 0);
    };
    return score(b) - score(a);
  });
  return { scenario: scenario.id, rows, retail: r, holt: h };
}

function fmt(v, digits = 3) {
  if (v == null) return "—";
  if (typeof v !== "number") return String(v);
  return Number.isInteger(v) ? String(v) : v.toFixed(digits);
}

export function renderReport(results, meta = {}) {
  const lines = [];
  lines.push("# Movement parity report — retail vs holtburger");
  lines.push("");
  lines.push(`Generated: ${meta.generated ?? new Date().toISOString()}`);
  if (meta.retailFile) lines.push(`Retail source: \`${meta.retailFile}\``);
  if (meta.holtFile) lines.push(`holtburger source: \`${meta.holtFile}\``);
  lines.push("");
  lines.push(
    "Rows are ranked by |delta| relative to the metric's tolerance, so the first row of each table is the worst real divergence. `delta` is holtburger minus retail: positive means holtburger is faster/higher/slower-to-settle than retail.",
  );
  lines.push("");

  const allFail = [];
  for (const res of results) {
    lines.push(`## ${res.scenario}`);
    lines.push("");
    lines.push("| metric | retail | holtburger | delta | delta % | verdict |");
    lines.push("|---|---:|---:|---:|---:|---|");
    for (const r of res.rows) {
      lines.push(
        `| ${r.metric} | ${fmt(r.retail)} | ${fmt(r.holt)} | ${fmt(r.delta)} | ${r.pct == null ? "—" : r.pct.toFixed(1) + "%"} | ${r.verdict} |`,
      );
      if (r.verdict === "FAIL") allFail.push({ scenario: res.scenario, ...r });
    }
    lines.push("");
  }

  if (allFail.length) {
    lines.push("## Ranked defects");
    lines.push("");
    allFail.sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
    for (const f of allFail) {
      lines.push(
        `1. **${f.scenario} / ${f.metric}** — retail ${fmt(f.retail)}, holtburger ${fmt(f.holt)} (delta ${fmt(f.delta)}${f.pct == null ? "" : `, ${f.pct.toFixed(1)}%`}).`,
      );
    }
    lines.push("");
  } else {
    lines.push("No metric exceeded its tolerance.");
    lines.push("");
  }
  return lines.join("\n");
}

/** retail-pins.json: retail truth only, for future retail_behavior_tests. */
export function renderPins(results, metricDefs) {
  const pins = { version: 1, generated: new Date().toISOString(), metric_defs: metricDefs, scenarios: {} };
  for (const res of results) {
    const entry = {};
    for (const [k, v] of Object.entries(res.retail)) {
      if (typeof v === "number") {
        const base = k.split(".").pop();
        entry[k] = { value: v, tolerance: metricDefs[base]?.tolerance ?? null, unit: metricDefs[base]?.unit ?? null };
      }
    }
    pins.scenarios[res.scenario] = entry;
  }
  return pins;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function loadSide(file, opts) {
  const recs = parseJsonl(readFileSync(file, "utf8"));
  const { samples } = normalize(recs, opts);
  derive(samples);
  return alignToFirstMotion(samples).samples;
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[k] = next;
        i++;
      } else args[k] = true;
    }
  }
  if (args.selftest) return selftest();

  const here = path.dirname(fileURLToPath(import.meta.url));
  const scenPath =
    args.scenarios ?? path.join(here, "..", "docs", "reengineering", "oracle", "scenarios.json");
  const spec = JSON.parse(readFileSync(scenPath, "utf8"));
  const metricDefs = spec.metric_defs ?? {};

  if (!args.retail || !args.holt) {
    console.error("usage: oracle-diff.mjs --retail <jsonl> --holt <jsonl> [--scenario <id>] [--out-report f.md] [--out-pins f.json]");
    console.error("       oracle-diff.mjs --selftest");
    process.exit(2);
  }

  const wanted = args.scenario ? spec.scenarios.filter((s) => s.id === args.scenario) : spec.scenarios;
  if (!wanted.length) {
    console.error(`no scenario matched '${args.scenario}'`);
    process.exit(2);
  }

  const retailSamples = loadSide(args.retail, { playerGuid: args.playerGuid ?? null });
  const holtSamples = loadSide(args.holt, {});
  if (!retailSamples.length) console.error("WARNING: retail stream produced no samples");
  if (!holtSamples.length) console.error("WARNING: holtburger stream produced no samples");

  const results = wanted.map((s) => compareScenario(s, retailSamples, holtSamples, metricDefs));
  const report = renderReport(results, { retailFile: args.retail, holtFile: args.holt });

  if (args["out-report"]) {
    writeFileSync(args["out-report"], report);
    console.error(`wrote ${args["out-report"]}`);
  } else {
    console.log(report);
  }
  if (args["out-pins"]) {
    writeFileSync(args["out-pins"], JSON.stringify(renderPins(results, metricDefs), null, 2));
    console.error(`wrote ${args["out-pins"]}`);
  }
  const fails = results.flatMap((r) => r.rows.filter((x) => x.verdict === "FAIL"));
  console.error(`oracle-diff: ${results.length} scenario(s), ${fails.length} metric(s) outside tolerance`);
  return 0;
}

// ---------------------------------------------------------------------------
// self-test (synthetic fixtures)
// ---------------------------------------------------------------------------

function selftest() {
  let passed = 0;
  let failed = 0;
  const check = (name, ok, detail) => {
    console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
    ok ? passed++ : failed++;
  };

  // --- synthetic straight-line run at exactly 4 m/s -----------------------
  // Built as retail-shaped c2s GameAction/MoveToState records so the retail
  // normalization path is what is under test, not a shortcut.
  const retailRecs = [];
  for (let i = 0; i <= 120; i++) {
    const tms = i * 50;
    const dist = Math.min(tms, 4000) / 1000 * 4; // 4 m/s, stops at t=4000
    retailRecs.push({
      source: "retail-pcap",
      t: tms / 1000,
      dir: "c2s",
      kind: "GameAction",
      data: { action: "MoveToState", x: dist, y: 0, z: 10, heading_deg: 0, lb: "0x00A90106" },
    });
  }
  const rn = normalize(retailRecs);
  derive(rn.samples);
  const ra = alignToFirstMotion(rn.samples).samples;
  check("retail normalize produced samples", ra.length > 100, `${ra.length} samples`);
  const rSpeed = steadySpeed(ra, [1000, 3000]);
  check("retail steady speed ~4 m/s", Math.abs(rSpeed - 4) < 0.05, `got ${rSpeed?.toFixed(3)}`);

  // --- holtburger side, deliberately 10% fast ----------------------------
  const holtRecs = [];
  for (let i = 0; i <= 120; i++) {
    const tms = i * 50;
    const dist = (Math.min(tms, 4000) / 1000) * 4.4;
    holtRecs.push({
      source: "holt",
      t: tms,
      pos: { x: dist, y: 0, z: 10 },
      heading: 0,
      gait: "run",
    });
  }
  const hn = normalize(holtRecs);
  derive(hn.samples);
  const ha = alignToFirstMotion(hn.samples).samples;
  const hSpeed = steadySpeed(ha, [1000, 3000]);
  check("holt steady speed ~4.4 m/s", Math.abs(hSpeed - 4.4) < 0.05, `got ${hSpeed?.toFixed(3)}`);

  const scenario = {
    id: "run-hold",
    windows: { steady: [1000, 3000] },
    expect: { steady_speed: null },
  };
  const metricDefs = { steady_speed: { unit: "m/s", tolerance: 0.05 } };
  const res = compareScenario(scenario, ra, ha, metricDefs);
  const row = res.rows.find((r) => r.metric === "steady_speed");
  check("differ computed a delta", row && Math.abs(row.delta - 0.4) < 0.05, `delta ${row?.delta?.toFixed(3)}`);
  check("delta outside tolerance flags FAIL", row?.verdict === "FAIL", `verdict ${row?.verdict}`);
  check("percent delta ~10%", row && Math.abs(row.pct - 10) < 1.5, `pct ${row?.pct?.toFixed(1)}`);

  // --- heading unwrap across the 0/360 seam ------------------------------
  const turnRecs = [];
  for (let i = 0; i <= 40; i++) {
    // 90 deg/s sweep starting at 350 deg -> crosses the seam at i=8
    const tms = i * 50;
    const h = norm360(350 + (tms / 1000) * 90);
    turnRecs.push({ source: "holt", t: tms, pos: { x: i * 0.2, y: 0, z: 0 }, heading: h });
  }
  const tn = normalize(turnRecs);
  derive(tn.samples);
  const rate = turnRate(tn.samples, [200, 1800]);
  check("turn rate survives the 0/360 seam", Math.abs(rate - 90) < 3, `got ${rate?.toFixed(2)} deg/s`);

  // --- jump metrics -------------------------------------------------------
  const jumpSamples = [];
  for (let i = 0; i <= 60; i++) {
    const tms = i * 20;
    const t = tms / 1000;
    // launch at 4.9 m/s vertical, g=9.8 -> apex 1.225m at t=0.5, land at t=1.0
    const z = Math.max(0, 4.9 * t - 0.5 * 9.8 * t * t);
    jumpSamples.push({ t: tms, x: t * 4, y: 0, z, speed: 4, heading: 0 });
  }
  const jm = jumpMetrics(jumpSamples, [0, 1200]);
  check("jump apex ~1.225 m", Math.abs(jm.jump_apex - 1.225) < 0.05, `got ${jm.jump_apex?.toFixed(3)}`);
  check("jump airtime ~1000 ms", Math.abs(jm.jump_airtime - 1000) < 60, `got ${jm.jump_airtime}`);
  check("jump distance ~4 m", Math.abs(jm.jump_distance - 4) < 0.2, `got ${jm.jump_distance?.toFixed(3)}`);

  // --- alignment independence --------------------------------------------
  // The same curve offset by 7.3s must produce identical metrics; this is the
  // property that makes retail's login traffic harmless.
  const shifted = rn.samples.map((s) => ({ ...s, t: s.t + 7300 }));
  const sa = alignToFirstMotion(shifted).samples;
  const sSpeed = steadySpeed(sa, [1000, 3000]);
  check("alignment is offset-independent", Math.abs(sSpeed - rSpeed) < 1e-6, `${sSpeed?.toFixed(4)} vs ${rSpeed?.toFixed(4)}`);

  // --- report + pins render ----------------------------------------------
  const md = renderReport([res], { generated: "TEST" });
  check("report ranks defects", md.includes("Ranked defects") && md.includes("run-hold"));
  const pins = renderPins([res], metricDefs);
  check("pins carry retail truth only", Math.abs(pins.scenarios["run-hold"].steady_speed.value - 4) < 0.05);
  check("pins carry tolerance", pins.scenarios["run-hold"].steady_speed.tolerance === 0.05);

  // --- malformed input ----------------------------------------------------
  const partial = parseJsonl('{"a":1}\n{"b":2\n{"c":3}\n');
  check("parseJsonl skips a truncated line", partial.length === 2, `${partial.length} records`);
  check("empty stream does not throw", normalize([]).samples.length === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main(process.argv.slice(2));
