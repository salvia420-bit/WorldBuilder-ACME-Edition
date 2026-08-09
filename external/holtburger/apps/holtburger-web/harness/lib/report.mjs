// harness/lib/report.mjs — the RESULTS-v2 report writer (SPEC §1.7 / pass-10
// D-10.1 point 1 + S12; T01 deliverable).
//
// WHY IT EXISTS
// -------------
// Four ~2x scale errors landed in one day because figures entered reports
// without declaring their population. This writer is enforcement point 1 of
// D-10.1: every key in a `metrics` object is `<name>@<scale>` (multi-axis
// where needed: `bytes@wire@preview-complete`) and the writer THROWS on an
// unsuffixed key or an off-vocabulary tag — a figure cannot enter a RESULTS
// file without declaring what it counts. The tag vocabulary is imported from
// the diag-schema registry so RESULTS files and diag surfaces share ONE
// closed set (pass-10 S1).
//
// Further S12 rules enforced mechanically:
//   - `*Ms` metrics must be stat OBJECTS ({p50, p95, ...}), never bare
//     numbers — a bare number is an implicit p50 claim and is forbidden (S1).
//   - stat objects may only carry the S1 statistic keys (p50/p95/p99/mean/
//     max/min/n).
//   - verdict ∈ PASS|FAIL|EXPLORATORY|INVALID; `controlSpread` is MANDATORY
//     for any comparative verdict (PASS/FAIL over interleaved arms or a
//     delta — D-10.7's noise-floor rule is unenforceable without it).
//   - arm verdicts ∈ USABLE|REJECT with reasons (PR-10: reject, never
//     average; REJECT arms stay in the file as evidence, never scored).
//   - every run records {ts, commit, distGeneratedAt, url, taint[],
//     wasmProfile} (D-10.6 run-validity model). Unknown provenance is
//     recorded as null/"unknown" — recorded, not invented.
//
// Output shape (S12, supersedes the ad-hoc docs/RESULTS-*.json shapes):
//
//   { "schema": "hb-results-v2",
//     "bench", "gate", "protocol", "ts", "commit", "distGeneratedAt",
//     "platform": { "box", "renderer" },
//     "url", "taint": [], "wasmProfile",
//     "arms": [ { "arm", "verdict", "rejectReasons": [],
//                 "metrics": { "frameMs@moving": {"p50": ...}, ... },
//                 "series": {...}, ...aux } ],
//     "controlSpread": { "metric", "value" } | null,
//     "delta": {}, "verdict", "notes" }
//
// Existing consumers: moving-bench's report was "already ~this shape and
// converts first" (S12) — its legacy fields ride along as aux keys on the
// arm, so nothing an operator read from the old file is lost.

import { writeFileSync } from "node:fs";
import { SCALE_TAGS, STAT_KEYS } from "./diag_schema.mjs";

export const VERDICTS = Object.freeze(["PASS", "FAIL", "EXPLORATORY", "INVALID"]);
export const ARM_VERDICTS = Object.freeze(["USABLE", "REJECT"]);
export const SCHEMA = "hb-results-v2";

/**
 * Validate one metric key. Throws with the closed vocabulary in the message
 * on any violation (the whole point is that the failure is loud and names
 * the fix).
 * @param {string} key e.g. "bytes@wire@preview-complete"
 */
export function assertMetricKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error(`RESULTS-v2: metric key must be a non-empty string, got ${JSON.stringify(key)}`);
  }
  const parts = key.split("@");
  if (parts.length < 2) {
    throw new Error(
      `RESULTS-v2: untagged metric key "${key}" REFUSED — every figure carries `
      + `a mechanical @scale tag (pass-10 D-10.1). Write "<name>@<scale>" with `
      + `scale from: ${SCALE_TAGS.join(", ")}`,
    );
  }
  const [name, ...tags] = parts;
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`RESULTS-v2: bad metric name "${name}" in key "${key}"`);
  }
  for (const tag of tags) {
    if (!SCALE_TAGS.includes(tag)) {
      throw new Error(
        `RESULTS-v2: unknown scale tag "${tag}" in key "${key}" — the vocabulary `
        + `is CLOSED (pass-10 S1): ${SCALE_TAGS.join(", ")}`,
      );
    }
  }
  return { name, tags };
}

/**
 * Validate one metric value against its (already-validated) key.
 * Numbers are legal for counts/levels; `*Ms` metrics MUST be stat objects.
 */
export function assertMetricValue(key, value) {
  const { name } = assertMetricKey(key);
  const isStatObject = value !== null && typeof value === "object" && !Array.isArray(value);
  if (/Ms$/.test(name)) {
    if (!isStatObject) {
      throw new Error(
        `RESULTS-v2: "${key}" is a latency/frame metric — a bare number is an `
        + `implicit p50 claim and is forbidden (pass-10 S1). Pass a stat object `
        + `{${STAT_KEYS.join(", ")}}.`,
      );
    }
  }
  if (isStatObject) {
    const keys = Object.keys(value);
    if (keys.length === 0) throw new Error(`RESULTS-v2: "${key}" stat object is empty`);
    for (const k of keys) {
      if (!STAT_KEYS.includes(k)) {
        throw new Error(
          `RESULTS-v2: "${key}" stat object carries unknown key "${k}" — legal `
          + `statistic labels: ${STAT_KEYS.join(", ")}`,
        );
      }
      const v = value[k];
      if (v !== null && typeof v !== "number") {
        throw new Error(`RESULTS-v2: "${key}".${k} must be a number or null, got ${typeof v}`);
      }
    }
  } else if (typeof value !== "number" && value !== null) {
    throw new Error(`RESULTS-v2: "${key}" must be a number, null, or a stat object, got ${typeof value}`);
  }
}

/** Validate a whole metrics object (throws on first violation). */
export function assertMetrics(metrics) {
  if (metrics === null || typeof metrics !== "object" || Array.isArray(metrics)) {
    throw new Error("RESULTS-v2: `metrics` must be an object");
  }
  for (const [k, v] of Object.entries(metrics)) assertMetricValue(k, v);
}

export class ResultsV2 {
  /**
   * @param {object} header
   * @param {string} header.bench     bench card name (e.g. "MOVE-FIX")
   * @param {string} header.protocol  protocol class (e.g. "PC-3")
   * @param {string} header.url       full page URL of the run
   * @param {string} [header.gate]    owning gate (e.g. "GATE-POOLS") or null
   * @param {string} [header.commit]  git sha; null = unknown, recorded as such
   * @param {string} [header.distGeneratedAt] manifest field; null = unknown
   * @param {object} [header.platform] { box, renderer }
   * @param {string[]} [header.taint] retaining/throttling diagnostics armed
   * @param {string} [header.wasmProfile] "release" | "DEV-WASM" | "unknown"
   * @param {string} [header.ts]      ISO timestamp (defaults to now)
   */
  constructor(header) {
    const h = header || {};
    for (const req of ["bench", "protocol", "url"]) {
      if (typeof h[req] !== "string" || h[req].length === 0) {
        throw new Error(`RESULTS-v2: header.${req} is required`);
      }
    }
    if (h.taint != null && !Array.isArray(h.taint)) throw new Error("RESULTS-v2: taint must be an array");
    this.header = {
      bench: h.bench,
      gate: h.gate ?? null,
      protocol: h.protocol,
      ts: h.ts ?? new Date().toISOString(),
      commit: h.commit ?? null,
      distGeneratedAt: h.distGeneratedAt ?? null,
      platform: { box: h.platform?.box ?? null, renderer: h.platform?.renderer ?? null },
      url: h.url,
      taint: h.taint ?? [],
      wasmProfile: h.wasmProfile ?? "unknown",
    };
    this.arms = [];
    this.controlSpread = null;
    this.delta = {};
    this.verdict = null;
    this.notes = "";
  }

  /**
   * Add one arm. `metrics` keys are validated (tags + stat-object rules);
   * any extra own keys of `arm` beyond the schema ones ride along as aux
   * fields (legacy-consumer compatibility).
   */
  addArm(arm) {
    const a = arm || {};
    if (typeof a.arm !== "string") throw new Error("RESULTS-v2: arm.arm (the arm label) is required");
    if (!ARM_VERDICTS.includes(a.verdict)) {
      throw new Error(`RESULTS-v2: arm.verdict must be ${ARM_VERDICTS.join("|")}, got ${JSON.stringify(a.verdict)}`);
    }
    if (a.verdict === "REJECT" && !(Array.isArray(a.rejectReasons) && a.rejectReasons.length > 0)) {
      throw new Error("RESULTS-v2: a REJECT arm must name its reasons (PR-10)");
    }
    assertMetrics(a.metrics ?? {});
    const { arm: label, verdict, rejectReasons, metrics, series, ...aux } = a;
    this.arms.push({
      arm: label,
      verdict,
      rejectReasons: rejectReasons ?? [],
      metrics: metrics ?? {},
      ...(series !== undefined ? { series } : {}),
      ...aux,
    });
    return this;
  }

  /** controlSpread is mandatory for any comparative verdict (D-10.7). */
  setControlSpread(metric, value) {
    assertMetricKey(String(metric).split(".")[0]); // "frameMs@moving.p50" — key part must be tagged
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("RESULTS-v2: controlSpread.value must be a finite number");
    }
    this.controlSpread = { metric: String(metric), value };
    return this;
  }

  setDelta(delta) {
    assertMetrics(delta ?? {});
    this.delta = delta ?? {};
    return this;
  }

  setNotes(notes) { this.notes = String(notes ?? ""); return this; }

  setVerdict(verdict) {
    if (!VERDICTS.includes(verdict)) {
      throw new Error(`RESULTS-v2: verdict must be ${VERDICTS.join("|")}, got ${JSON.stringify(verdict)}`);
    }
    this.verdict = verdict;
    return this;
  }

  /** Build the final object (throws if the report is structurally unfinished). */
  toJSON() {
    if (this.arms.length === 0) throw new Error("RESULTS-v2: at least one arm is required");
    if (this.verdict === null) throw new Error("RESULTS-v2: setVerdict() before writing");
    const comparative = (this.verdict === "PASS" || this.verdict === "FAIL")
      && (this.arms.length > 1 || Object.keys(this.delta).length > 0);
    if (comparative && this.controlSpread === null) {
      throw new Error(
        "RESULTS-v2: a comparative PASS/FAIL verdict without controlSpread is "
        + "REFUSED — the D-10.7 noise-floor kill rule (delta > max(2x same-run "
        + "control spread, protocol floor)) is unenforceable without it.",
      );
    }
    return {
      schema: SCHEMA,
      ...this.header,
      arms: this.arms,
      controlSpread: this.controlSpread,
      delta: this.delta,
      verdict: this.verdict,
      notes: this.notes,
    };
  }

  /** Serialize + write. Returns the object written. */
  write(path) {
    const obj = this.toJSON();
    writeFileSync(path, JSON.stringify(obj, null, 2));
    return obj;
  }
}

/** Convenience constructor mirroring the class. */
export function createReport(header) {
  return new ResultsV2(header);
}
