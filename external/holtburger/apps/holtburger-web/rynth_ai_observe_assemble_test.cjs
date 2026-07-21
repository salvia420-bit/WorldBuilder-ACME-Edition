#!/usr/bin/env node
// rynth_ai_observe_assemble_test.cjs — unit tests for rynth/ai/observe_assemble.js
// (the salience-tagged, budgeted observation assembler, C4-1). Pure module: no
// host, no network. Covers quota enforcement, salience drop-order, the total-
// token ceiling, injection-order preservation, and the degrade-to-parts.join
// fallback contract the extensions.js wiring leans on.
//
// Run: node rynth_ai_observe_assemble_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// length-n filler; CHARS_PER_TOKEN is 4 so S(4k) estimates to k tokens.
const S = (n) => "x".repeat(n);

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, "rynth", "ai", "observe_assemble.js")).href);
  const { assembleObservation, estimateTokens, SALIENCE_TIERS } = mod;

  // ── estimateTokens: ~4 chars/token, 0 for empty/nullish ─────────────────
  check("estimateTokens('') === 0", estimateTokens("") === 0);
  check("estimateTokens(null) === 0", estimateTokens(null) === 0);
  check("estimateTokens(S(40)) === 10", estimateTokens(S(40)) === 10);
  check("estimateTokens rounds up", estimateTokens(S(41)) === 11);
  check("SALIENCE_TIERS ordered high→low", SALIENCE_TIERS[0] === "CORRECTION" && SALIENCE_TIERS[SALIENCE_TIERS.length - 1] === "STEADY");

  // ── injection-order preservation + happy-path parity ────────────────────
  {
    const sections = [
      { subsystem: "location", tier: "DECISION", text: "LOC" },
      { subsystem: "mission", tier: "DECISION", text: "MISSION" },
      { subsystem: "deltas", tier: "CHANGE", text: "DELTA" },
      { subsystem: "base", tier: "DECISION", text: "BASE" },
    ];
    const parts = sections.map((s) => s.text);
    const r = assembleObservation(sections, { totalTokens: Infinity });
    check("under budget: text === parts.join", r.text === parts.join("\n"), r.text);
    check("under budget: nothing dropped", r.dropped.length === 0);
    check("under budget: all kept", r.kept.length === 4);
    check("default separator is newline", r.text.split("\n").length === 4);
    // no totalTokens given -> no ceiling, still returns full text
    check("no opts: never throws, returns full", assembleObservation(sections).text === parts.join("\n"));
  }

  // ── salience drop-order: STEADY sheds first, then CHANGE, ANOMALY … ──────
  {
    const sections = [
      { subsystem: "location", tier: "DECISION", text: S(40) }, // idx0 10tok
      { subsystem: "scratchpad", tier: "STEADY", text: S(40) }, // idx1 10tok
      { subsystem: "deltas", tier: "CHANGE", text: S(40) }, // idx2 10tok
      { subsystem: "heard", tier: "ANOMALY", text: S(40) }, // idx3 10tok
    ]; // 40 tok total
    const keptSubs = (r) => r.kept.map((k) => k.subsystem);
    const dropSubs = (r) => r.dropped.map((d) => d.subsystem);

    const r30 = assembleObservation(sections, { totalTokens: 30 });
    check("drop STEADY first", !keptSubs(r30).includes("scratchpad") && dropSubs(r30).includes("scratchpad"),
      JSON.stringify({ kept: keptSubs(r30), dropped: dropSubs(r30) }));
    check("drop keeps DECISION/ANOMALY/CHANGE at 30",
      keptSubs(r30).includes("location") && keptSubs(r30).includes("heard") && keptSubs(r30).includes("deltas"));
    check("kept emitted in injection order", JSON.stringify(keptSubs(r30)) === JSON.stringify(["location", "deltas", "heard"]),
      JSON.stringify(keptSubs(r30)));
    check("dropped carries reason", r30.dropped.every((d) => typeof d.reason === "string"));

    const r20 = assembleObservation(sections, { totalTokens: 20 });
    check("tighter budget: CHANGE also sheds, ANOMALY/DECISION survive",
      JSON.stringify(keptSubs(r20)) === JSON.stringify(["location", "heard"]),
      JSON.stringify(keptSubs(r20)));
  }

  // ── CORRECTION outranks everything (never shed while budget for one) ─────
  {
    const sections = [
      { subsystem: "notes", tier: "STEADY", text: S(40) },
      { subsystem: "fix", tier: "CORRECTION", text: S(40) },
    ];
    const r = assembleObservation(sections, { totalTokens: 10 });
    check("CORRECTION retained over STEADY", r.kept.length === 1 && r.kept[0].subsystem === "fix",
      JSON.stringify(r.kept));
  }

  // ── unknown / missing tier defaults to STEADY (sheds before CHANGE) ──────
  {
    const sections = [
      { subsystem: "change", tier: "CHANGE", text: S(40) },
      { subsystem: "mystery", tier: "WAT", text: S(40) }, // bogus tier
      { subsystem: "notier", text: S(40) }, // no tier at all
    ];
    const r = assembleObservation(sections, { totalTokens: 10 });
    check("bogus/absent tier => STEADY (dropped before CHANGE)",
      r.kept.length === 1 && r.kept[0].subsystem === "change",
      JSON.stringify(r.kept.map((k) => k.subsystem)));
  }

  // ── per-subsystem quota: truncates over-quota sections ───────────────────
  {
    const r = assembleObservation([{ subsystem: "heard", tier: "ANOMALY", text: S(80) }], // 20 tok
      { totalTokens: Infinity, quotas: { heard: 10 } });
    check("quota truncates to cap", r.tokens <= 10 && r.text.length <= 40, `tokens=${r.tokens} len=${r.text.length}`);
    check("quota truncation marks the cut", r.text.endsWith("…"));
    check("kept section reports capped tokens", r.kept.length === 1 && r.kept[0].tokens <= 10);
  }

  // ── quota is cumulative per subsystem ────────────────────────────────────
  {
    const r = assembleObservation(
      [
        { subsystem: "heard", tier: "ANOMALY", text: S(40) }, // 10 tok
        { subsystem: "heard", tier: "ANOMALY", text: S(40) }, // 10 tok
      ],
      { totalTokens: Infinity, quotas: { heard: 15 } }
    );
    const heardTokens = r.kept.filter((k) => k.subsystem === "heard").reduce((a, k) => a + k.tokens, 0);
    check("cumulative subsystem quota honored", heardTokens <= 15, `heardTokens=${heardTokens}`);
  }

  // ── quota exhaustion drops later same-subsystem sections whole ───────────
  {
    const r = assembleObservation(
      [
        { subsystem: "x", tier: "DECISION", text: S(40) }, // fills the 10-tok quota
        { subsystem: "x", tier: "DECISION", text: S(40) }, // nothing left -> dropped
      ],
      { totalTokens: Infinity, quotas: { x: 10 } }
    );
    check("quota exhaustion drops the overflow section",
      r.kept.length === 1 && r.dropped.some((d) => d.subsystem === "x" && d.reason === "quota"),
      JSON.stringify({ kept: r.kept.length, dropped: r.dropped }));
  }

  // ── total-token ceiling is airtight (accounts for separators) ───────────
  {
    const sections = Array.from({ length: 10 }, (_, i) => ({
      subsystem: `s${i}`, tier: "STEADY", text: S(40),
    })); // 10 * 10 = 100 tok before separators
    for (const cap of [5, 17, 25, 63]) {
      const r = assembleObservation(sections, { totalTokens: cap });
      check(`ceiling honored @${cap}`, estimateTokens(r.text) <= cap && r.tokens <= cap,
        `tokens=${r.tokens} cap=${cap}`);
    }
  }

  // ── degrade-to-parts.join contract (mirrors extensions.js observe wiring) ─
  {
    // The exact fallback shape the integrator uses: try assembler, else the raw
    // parts.join. A thrown assembler must never lose the check-in.
    const assembleOrFallback = (fn, sections, parts, opts) => {
      try {
        const r = fn(sections, opts);
        if (r && typeof r.text === "string") return r.text;
      } catch { /* fall through */ }
      return parts.join("\n");
    };
    const parts = ["ALPHA", "BRAVO", "CHARLIE"];
    const sections = parts.map((t, i) => ({ subsystem: `p${i}`, tier: "DECISION", text: t }));
    const thrower = () => { throw new Error("boom"); };

    check("degrades to parts.join when assembler throws",
      assembleOrFallback(thrower, sections, parts, {}) === parts.join("\n"));
    check("degrades when assembler returns a non-string",
      assembleOrFallback(() => ({ text: 42 }), sections, parts, {}) === parts.join("\n"));
    check("uses assembler output under budget (== parts.join here)",
      assembleOrFallback(assembleObservation, sections, parts, { totalTokens: Infinity }) === parts.join("\n"));
  }

  // ── the assembler itself never throws on hostile / malformed input ───────
  {
    let threw = false, out = null;
    try {
      out = assembleObservation([
        null,
        42,
        "not-an-object",
        { text: 123 }, // non-string text -> coerced
        { text: "" }, // empty -> skipped
        { subsystem: "ok", tier: "DECISION", text: "KEEP" },
        { subsystem: "evil", tier: "STEADY", get text() { throw new Error("boom"); } },
      ], { totalTokens: Infinity });
    } catch { threw = true; }
    check("never throws on malformed sections", !threw && out && typeof out.text === "string");
    check("hostile getter skipped, good section survives", out && out.text.includes("KEEP") && !/boom/.test(out.text));
    check("garbage args degrade to empty text",
      assembleObservation(null).text === "" && assembleObservation("x").text === "" && assembleObservation(undefined).text === "");
  }

  // ── determinism: same input -> byte-identical text ──────────────────────
  {
    const sections = [
      { subsystem: "a", tier: "DECISION", text: S(40) },
      { subsystem: "b", tier: "STEADY", text: S(40) },
      { subsystem: "c", tier: "CHANGE", text: S(40) },
    ];
    const a = assembleObservation(sections, { totalTokens: 20, quotas: { c: 5 } });
    const b = assembleObservation(sections, { totalTokens: 20, quotas: { c: 5 } });
    check("deterministic text", a.text === b.text);
    check("deterministic kept/dropped", JSON.stringify(a.kept) === JSON.stringify(b.kept) && JSON.stringify(a.dropped) === JSON.stringify(b.dropped));
  }

  console.log(`${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
