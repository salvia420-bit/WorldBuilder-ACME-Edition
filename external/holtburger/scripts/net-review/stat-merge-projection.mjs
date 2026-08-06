// stat-merge-projection.mjs — settle the ONE number the statics bulk-merge
// design turns on: how much of the ceiling does the TILE-SIZE axis eat?
//
// THE CEILING, as re-measured 2026-08-06 at Nanto over DRAWN buckets:
//
//     376 resident · 129 DRAWN · 5,063 instances submitted
//     drawn keyed by (region, material VALUE) : 123
//     drawn keyed by (region, render STATE)   :  37   <- the ceiling
//     drawn distinct render states            :   6
//     drawn distinct material values          :  38
//
// 129 -> 37 drawn buckets at ~40 us each ≈ 3.68 ms. Two things about that
// number are load-bearing:
//
//   1. It is over DRAWN buckets. The region-width sweep (regionDiv 3 -> 12)
//      removed 131 resident buckets and bought 14 draws and 0.00 ms — resident
//      count and drawn count are decoupled, so any projection stated over
//      resident buckets is measuring a quantity that does not pay.
//   2. The 37 comes from a key that ignores the bound texture ENTIRELY,
//      dimensions included. A texture array cannot: `texStorage3D` fixes
//      (format, w, h, depth) at allocation. The reachable key is
//      (region x TILE x state x format). With only 6 render states across all
//      drawn buckets, the tile axis is essentially the whole problem — and it
//      has never been measured on this population.
//
// The projection lives in the CLIENT (`scene3d/static_atlas.js`
// `projectStatMergeBuckets`, exposed as `window.__statMergeProjection()`) so it
// is computed by the atlas's OWN key functions rather than a transcription of
// them — the same rule `bc7AtlasShouldDefer` states for the regression suite.
// This script is only the courier and the arithmetic.
//
// Usage — attach to an ALREADY-RUNNING, already-SETTLED page. Settle
// draws/frame first (§7 of docs/2026-08-06-frame-cost-structure-measured.md: a
// sweep taken while the scene was still streaming was wasted outright).
//
//   node stat-merge-projection.mjs [outJson] [cdpUrl]
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const OUT = process.argv[2] || "/tmp/stat-merge-projection.json";
const CDP = process.argv[3] || "http://127.0.0.1:9333";

// ~40 us per DRAWN bucket, the figure behind the 129 -> 37 ≈ 3.68 ms ceiling.
// It is dominated by the §5a fixed draw cost (37.6 us, r^2 = 0.014 against
// instance count) plus the fixed share of the multidraw rebuild (5.9 us).
// Merging removes ONLY the fixed part — the instances still exist.
const PER_DRAWN_BUCKET_US = 40;
// §5a per-instance costs, for the correction below.
const PER_INSTANCE_DRAW_US = 0.038;
const PER_INSTANCE_REBUILD_US = 0.348;

(async () => {
  const b = await chromium.connectOverCDP(CDP);
  const page = b.contexts()[0].pages().find((p) => p.url().includes("holtburger"));
  if (!page) throw new Error("no holtburger page");
  const r = await page.evaluate(() => {
    if (typeof window.__statMergeProjection !== "function") {
      return { error: "__statMergeProjection missing — client predates the probe" };
    }
    const p = window.__statMergeProjection();
    // Cross-check the drawn count against what the renderer actually submitted.
    // `_projDrawn` reads `visible` + instance count between frames; it cannot
    // re-derive frustum culling, so it OVER-counts if anything. If these two
    // disagree badly, trust the renderer and say so rather than quoting the probe.
    try { p.rendererCalls = window.liveScene3d?.renderer?.info?.render?.calls ?? null; } catch (_) {}
    return p;
  });
  if (r.error) { console.error("FAIL", r.error); process.exit(1); }

  writeFileSync(OUT, JSON.stringify(r, null, 2));

  const d = r.drawn;
  const today = d.buckets.today;
  const ms = (n) => ((today - n) * PER_DRAWN_BUCKET_US / 1000);
  const row = (label, n, note) => console.log(
    `  ${label.padEnd(34)} ${String(n).padStart(4)}   ` +
    `${(ms(n) >= 0 ? "+" : "")}${ms(n).toFixed(2)} ms${note ? "   " + note : ""}`
  );

  console.log(`\nDRAWN buckets: ${today} of ${r.batchBuckets} resident, ` +
    `${r.drawnInstances} instances submitted, over ${d.regions} regions`);
  console.log(`drawn axes: ${d.distinctTiles} tiles · ${d.distinctStates} states · ` +
    `${d.distinctValues} material values`);
  if (r.rendererCalls != null) console.log(`(renderer.info.render.calls = ${r.rendererCalls} — sanity only)`);

  console.log(`\ndrawn buckets under each keying, and what it is worth:`);
  row("(region, state) — CEILING", d.buckets.regionState, "<- ignores tile size; not reachable");
  row("(region, tile, state, format)", d.buckets.regionClass, "<- the design");
  row("+ side/offset/emissive/shadow", d.buckets.regionStrict, "<- the design, image-preserving");

  console.log(`\nTILE-AXIS COST: ${d.buckets.regionState} -> ${d.buckets.regionClass} drawn buckets ` +
    `(+${d.buckets.regionClass - d.buckets.regionState}), i.e. ` +
    `${(100 * (d.buckets.regionClass - d.buckets.regionState) / Math.max(1, today - d.buckets.regionState)).toFixed(0)}% ` +
    `of the ceiling eaten before any correctness constraint.`);

  console.log(`\nsnapping tiles to canonical tiers (a pure resolution change — each layer`);
  console.log(`holds one surface addressed by normalized UV, so no UV math moves):`);
  for (const s of d.snapped) {
    console.log(`  tiers ${JSON.stringify(s.tiers).padEnd(18)} ` +
      `class ${String(s.regionClass).padStart(4)}  strict ${String(s.regionStrict).padStart(4)}  ` +
      `${(ms(s.regionStrict) >= 0 ? "+" : "")}${ms(s.regionStrict).toFixed(2)} ms   ` +
      `${s.layers} layers / ${s.sharedMB} MB`);
  }

  console.log(`\narray-texture memory (drawn population):`);
  console.log(`  GLOBAL pools  ${d.layers.shared} layers / ${d.layers.sharedMB} MB`);
  console.log(`  region-scoped ${d.layers.regional} layers / ${d.layers.regionalMB} MB   ` +
    `<- ${(d.layers.regionalMB / Math.max(0.1, d.layers.sharedMB)).toFixed(1)}x; ` +
    `for scale, the X7 grow-on-demand fix recovered 428 MB on a page that OOMs at ~2,800 MB`);
  if (d.layers.classesOverCapacity > 0) {
    console.log(`  ⚠ ${d.layers.classesOverCapacity} class(es) hold more surfaces than ` +
      `_layerCapacityFor allows — those members spill to ptLayerFull (fail-soft, one draw each).`);
  }

  console.log(`\nunmergeable residue (still one draw each): ${JSON.stringify(r.blockedDrawn)}`);

  // The correction the brief demands: merging must not multiply instances
  // SUBMITTED. It does not — the region key is kept and every instance keeps its
  // own bucket-region — but state it so nobody has to take it on trust.
  const perInst = (PER_INSTANCE_DRAW_US + PER_INSTANCE_REBUILD_US) / 1000;
  console.log(`\ninstance check: ${r.drawnInstances} submitted × ${(perInst * 1000).toFixed(3)} us ` +
    `= ${(r.drawnInstances * perInst).toFixed(2)} ms, UNCHANGED by merging (the region key is kept, so`);
  console.log(`no instance moves into a bucket that survives culling when it did not before).`);

  console.error(`[merge-projection] wrote ${OUT}`);
  process.exit(0);
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
