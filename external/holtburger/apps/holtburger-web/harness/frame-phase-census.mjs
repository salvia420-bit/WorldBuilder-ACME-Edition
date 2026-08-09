#!/usr/bin/env node
// harness/frame-phase-census.mjs — GATE-PHASE census reducer (T21/ST8;
// pass-08 S7 + Q1, pass-10 H-08.2a): turns sampled `window.__framePhase`
// snapshots into a RESULTS-v2 report that re-classes the pass-08 S1 [A]
// per-phase budgets.
//
// COLLECTION (browser side — serve.py + `?nosw=1&framePhase=on`, one
// chromium max per I5; add `&frameWork=on` for the ON arm; `?nullRender=1`
// bots are valid for p0/p1/p2/p4 but p3 reads ~0 by construction and MUST
// be reported as such, never as "render is free"):
//
//   // paste in the console / CDP-evaluate, sample ~1 Hz for >= 60 s:
//   window.__fpSamples = [];
//   window.__fpTimer = setInterval(() => {
//     const p = window.__framePhase;
//     if (p) window.__fpSamples.push({ tMs: performance.now(), phase: { ...p } });
//   }, 1000);
//   // ... after the window: clearInterval(window.__fpTimer);
//   //     copy(JSON.stringify({ meta: { url: location.href }, samples: window.__fpSamples }))
//
// REDUCTION: consecutive snapshot pairs whose `frames` advanced form
// windows; each window yields a per-frame MEAN ms per phase (cumulative
// deltas / frame delta — the stall-probe differencing method). Stats
// (p50/p95/mean/max/min/n) are taken ACROSS windows, so a 1 Hz sampler over
// 60 s gives n≈60 window-means per phase. Window means UNDERSTATE tails —
// this census re-classes the S1 slot BUDGETS (means-scale numbers [A] →
// [M]); the tail instrument remains the stall probe (pass-08 D-08.8).
//
// Run:
//   node harness/frame-phase-census.mjs --in samples.json --url <run url> \
//     [--regime parked|moving] [--arm legacy|frameWork] [--out results.json] \
//     [--commit sha] [--box name] [--renderer name] [--taint a,b] \
//     [--wasm-profile release|DEV-WASM|unknown]
//
// Output: hb-results-v2 (EXPLORATORY — the census informs budgets, it gates
// nothing by itself) with metrics framePhaseP0Ms@<regime> .. P4, plus a
// console re-class table against the pass-08 S1 [A] figures.

import { readFileSync } from "node:fs";
import { createReport } from "./lib/report.mjs";

// pass-08 S1's assumed-pending-measurement slot figures, printed alongside
// the measured means so the re-class is one diff.
export const S1_ASSUMED_MS = Object.freeze({
  p0: 1.0, // SIM [A]
  p1: 0.2, // RESIDENCY settled [A]
  p2: null, // WORLD TICKS — no single [A] figure (RP3-gated)
  p3: null, // RENDER — measured elsewhere (render-split figures exist)
  p4: 6.0, // STREAM SLOT budget [A]
});

const PHASES = ["p0", "p1", "p2", "p3", "p4"];

function statObject(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const pct = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    p50: pct(0.5),
    p95: pct(0.95),
    mean,
    max: s[s.length - 1],
    min: s[0],
    n: s.length,
  };
}

/**
 * Reduce cumulative `__framePhase` snapshots to per-phase window-mean stats.
 * @param {Array<{tMs?:number, phase:{p0Ms:number,p1Ms:number,p2Ms:number,
 *   p3Ms:number,p4Ms:number,frames:number}}>} samples
 * @returns {{ windows:number, framesTotal:number, perPhase:Record<string,
 *   object|null>, invalid:string[] }}
 */
export function reduceCensusSamples(samples) {
  const invalid = [];
  const perPhaseWindows = { p0: [], p1: [], p2: [], p3: [], p4: [] };
  let framesTotal = 0;
  let windows = 0;
  for (let i = 1; i < (samples?.length ?? 0); i++) {
    const a = samples[i - 1]?.phase;
    const b = samples[i]?.phase;
    if (!a || !b) { invalid.push(`sample ${i}: missing phase object`); continue; }
    const dFrames = (b.frames ?? 0) - (a.frames ?? 0);
    if (dFrames < 0) { invalid.push(`sample ${i}: frames went backwards (page reload mid-window?)`); continue; }
    if (dFrames === 0) continue; // idle window (renderOnDemand) — no frames, no data
    let bad = false;
    const means = {};
    for (const p of PHASES) {
      const d = (b[`${p}Ms`] ?? 0) - (a[`${p}Ms`] ?? 0);
      if (!Number.isFinite(d) || d < 0) { bad = true; break; }
      means[p] = d / dFrames;
    }
    if (bad) { invalid.push(`sample ${i}: non-finite/negative phase delta`); continue; }
    for (const p of PHASES) perPhaseWindows[p].push(means[p]);
    framesTotal += dFrames;
    windows += 1;
  }
  const perPhase = {};
  for (const p of PHASES) perPhase[p] = statObject(perPhaseWindows[p]);
  return { windows, framesTotal, perPhase, invalid };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}

async function main() {
  const inPath = arg("in", null);
  if (!inPath) {
    console.error("usage: node harness/frame-phase-census.mjs --in samples.json --url <url> [--regime parked|moving] [--arm label] [--out results.json]");
    process.exit(2);
  }
  const regime = arg("regime", "parked");
  if (!["parked", "moving"].includes(regime)) {
    console.error(`--regime must be parked|moving (S1 motion-regime axis), got ${regime}`);
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(inPath, "utf8"));
  const samples = Array.isArray(raw) ? raw : raw.samples;
  const url = arg("url", raw?.meta?.url ?? null);
  if (!url) {
    console.error("--url required (or meta.url in the samples file) — run validity needs the exact URL (D-10.6)");
    process.exit(2);
  }
  const armLabel = arg("arm", "legacy");
  const red = reduceCensusSamples(samples ?? []);
  if (red.windows === 0) {
    console.error("no usable windows (need >= 2 snapshots with advancing frames; is ?framePhase=on set?)");
    for (const m of red.invalid) console.error(`  ${m}`);
    process.exit(1);
  }

  // Console re-class table (the actual GATE-PHASE artifact is the v2 file).
  console.log(`frame-phase census: ${red.windows} windows, ${red.framesTotal} frames, regime=${regime}, arm=${armLabel}`);
  if (red.invalid.length) console.log(`  (${red.invalid.length} windows rejected: ${red.invalid[0]} ...)`);
  console.log("  phase  S1-assumed[A]  measured mean  p50      p95      max");
  for (const p of PHASES) {
    const st = red.perPhase[p];
    const assumed = S1_ASSUMED_MS[p];
    console.log(
      `  ${p}     ${assumed === null ? "   —   " : assumed.toFixed(2).padStart(7)}`
      + `  ${st.mean.toFixed(3).padStart(9)}ms  ${st.p50.toFixed(3).padStart(7)}  ${st.p95.toFixed(3).padStart(7)}  ${st.max.toFixed(3).padStart(7)}`,
    );
  }

  const metrics = {};
  for (const p of PHASES) {
    metrics[`framePhase${p.toUpperCase()}Ms@${regime}`] = red.perPhase[p];
  }
  metrics[`frames@${regime}`] = red.framesTotal;

  const taint = (arg("taint", "") || "").split(",").filter(Boolean);
  // ?framePhase is itself an instrument — census runs are dedicated runs and
  // the flag rides the taint list (the ?texCensus precedent, D-10.4.4).
  if (!taint.includes("framePhase")) taint.push("framePhase");
  const report = createReport({
    bench: "FRAME-PHASE-CENSUS",
    gate: "GATE-PHASE",
    protocol: "PC-7", // instrumented-walk class: census informs, never scores frames
    url,
    commit: arg("commit", null),
    platform: { box: arg("box", null), renderer: arg("renderer", null) },
    taint,
    wasmProfile: arg("wasm-profile", "unknown"),
  });
  report.addArm({
    arm: armLabel,
    verdict: "USABLE",
    metrics,
    windowsRejected: red.invalid.length,
  });
  // The census is information, not a gate score: budgets re-class at the
  // orchestrator's GATE-PHASE review, so the file verdict is EXPLORATORY.
  report.setVerdict("EXPLORATORY");
  report.setNotes(
    "Window-mean per-frame phase costs (cumulative deltas / frames). Means "
    + "understate tails — the stall probe remains the tail instrument. "
    + "S1 [A] anchors: " + JSON.stringify(S1_ASSUMED_MS),
  );
  const outPath = arg("out", null);
  if (outPath) {
    report.write(outPath);
    console.log(`wrote ${outPath}`);
  } else {
    console.log(JSON.stringify(report.toJSON(), null, 2));
  }
}

// Only run the CLI when invoked directly (the reducer is importable).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
