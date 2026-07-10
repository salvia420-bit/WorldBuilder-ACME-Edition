#!/usr/bin/env node
// harness/entity-warm-probe.mjs — P6 net-fixwave (2026-07-10) coverage probe
// for R-6 (entity program warm; A10-F1/O1, A08-1). Headless per the A16
// contract with `?renderDiag=on` so `renderer.info.programs` is sampled.
//
// Sequence: boot → in-world settle (archetype warm fires ~4 s after the
// local player commits) → record programs.length → `@telepoi Town Network`
// → settle → record again. Assert the teleport's Δprograms is small.
//
// HONESTY NOTE (A10's validation caveat): on SwiftShader program LINKS are
// ~free, so this probe measures warm COVERAGE — how many program variants
// TN entry still discovers that neither the archetype matrix nor the
// per-spawn warms already compiled. The LATENCY win is only provable on the
// 1070. Default bound: Δ ≤ 6 (a couple of world-lit bias/emissive combos TN
// legitimately adds — A10 §1.3 census; entity variants should all be hits).
//
// Arms:
//   default            — warms ON (expect PASS, small Δ)
//   --query "entityWarm=off&archetypeWarm=off" — the coverage control
//     (Δ there − Δ default ≈ what the warms absorbed)
//
// Usage:
//   node entity-warm-probe.mjs [--poi "Town Network"] [--bound 6]
//        [--settleMs 12000] [--query "extra=flags"] [--out out.json]
import fs from "node:fs";
import { launchAndEnter } from "./lib/boot.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : dflt;
};
const POI = arg("poi", "Town Network");
const BOUND = Number(arg("bound", "6"));
const SETTLE_MS = Number(arg("settleMs", "12000"));
const EXTRA_QUERY = arg("query", "");
const OUT = arg("out", "");

const query = ["renderDiag=on", EXTRA_QUERY].filter(Boolean).join("&");
const { page, helpers, inWorld } = await launchAndEnter({ query, timeoutMs: 120_000 });
const out = { poi: POI, bound: BOUND, query, inWorld };
const programs = () =>
  page.evaluate(() => {
    const r = window.liveScene3d?.renderer;
    return Array.isArray(r?.info?.programs) ? r.info.programs.length : null;
  });
const consoleTells = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("archetype warm") || t.includes("rig warm")) consoleTells.push(t);
});
try {
  if (!inWorld) throw new Error("boot stalled pre-in-world");
  // Settle: boot bake + the ~4 s archetype-warm delay + its compile.
  await page.waitForTimeout(SETTLE_MS);
  out.programsAtSettle = await programs();

  await page.evaluate((p) => {
    try { window.__sessionHandle.sendChat("@telepoi " + p); } catch (_) {}
  }, POI);
  await page.waitForTimeout(SETTLE_MS + 8000);
  out.programsAfterTeleport = await programs();

  out.archetypeWarmTells = consoleTells.filter((t) => t.includes("archetype warm"));
  out.rigWarmLinkTells = consoleTells.filter((t) => t.includes("rig warm")).length;

  if (out.programsAtSettle == null || out.programsAfterTeleport == null) {
    out.status = "SKIP";
    out.error = "renderer.info.programs unavailable (renderDiag path changed?)";
  } else {
    out.deltaPrograms = out.programsAfterTeleport - out.programsAtSettle;
    out.status = out.deltaPrograms <= BOUND ? "PASS" : "FAIL";
  }
} catch (e) {
  out.status = "SKIP";
  out.error = String((e && e.message) || e);
} finally {
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(
    `ENTITY-WARM SUMMARY: ${out.status} settle=${out.programsAtSettle} ` +
      `afterTeleport=${out.programsAfterTeleport} delta=${out.deltaPrograms}` +
      ` archetypeTells=${(out.archetypeWarmTells || []).length}` +
      ` rigLinkTells=${out.rigWarmLinkTells ?? 0}` +
      (out.error ? ` (${out.error})` : ""),
  );
  await helpers.close().catch(() => {});
  process.exit(out.status === "FAIL" ? 1 : 0);
}
