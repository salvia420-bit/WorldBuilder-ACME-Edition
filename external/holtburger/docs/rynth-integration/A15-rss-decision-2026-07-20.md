# A15 residency continuation — scoping result + decision needed (2026-07-20)

Scoped by the perf loop (agent read `PLAN-fixed-slot-grid-residency`, the
`fixedGrid`/sealed code, docs 1123-1125). Conclusion: the autonomous loop
should NOT patch the RSS-crash class — it needs a design decision. Recorded here
so the loop doesn't re-attempt it (tried-ledger: A15-RSS = deferred-to-user).

## The sealed-terrain gap is real but already neutralized (not worth the budget)

`onPositionUpdate` fires terrain/buildings/statics loaders every packet
(`world_stream.js:143/160/165`). Only **statics** is sealed-gated
(`index.js:3280` `sealedStaticsSkip`); `loadTerrainRing` (`index.js:3143`) and
`loadBuildingsForLandblock` (`index.js:3222`) have no sealed guard — the doc-1125
§5.2 claim is literally true. BUT already-landed mechanisms bound the cost:
- `fixedGrid` no-move: standing sealed → zero terrain work (`fixed_grid.js:298`).
- `sealedKeepRing`: LRU purges every outdoor LB except the dungeon + its 3×3
  keep-ring (`landblock_lru.js:568/599`); the kept 3×3 (~1.4 MB, hidden) is
  deliberate — parking it re-triggers the s11 park↔unpark storm.
- `sealedCull` hides `terrainGroup` (`cells.js:1379`) → zero draw while sealed.

A byte-identical `sealedTerrainSkip` guard is possible but saves only the
pre-detection 3×3 flat-heightmap bake + ~1.4 MB — negligible vs a 2.8 GB crash,
and reclaiming the 1.4 MB means touching `SEALED_KEEP_RING_FLOOR` (storm risk).
**Not worth it.**

## The RSS crash is a wasm linear-memory high-water-mark problem (NEEDS A DECISION)

All the obvious caches are bounded: geometry `MAX_LIVE_GEOM=8000` +
`maxResident~203` (`landblock_lru.js`), `MODEL_TRI_CACHE` 64 MiB + `SURFACE_PIXEL_CACHE`
96 MiB (`lib.rs` ByteBudgetLru). The unbounded thing is **`WebAssembly.Memory`
itself** — it only ever grows and never returns pages to the OS. So the *peak
concurrent decode/bake working set* (transient heightmap/triangulation buffers +
per-LB mesh ArrayBuffers) sets a permanent RSS floor that ratchets up across a
long session until the ~2.8 GB crash. (Live-reproduced: the perf-loop soak
crashes ~every 30 min of roaming; `wasm_memory_bytes()` climbs while JS heap
stays flat ~93 MB.) None of the bounded caches govern this.

**This is not pixel-neutral to fix — options, all needing your call:**
- **(a) Bound concurrent in-flight decode** / add wasm-memory-sampler
  backpressure — shrinks the peak working set → lower RSS floor. Cost: changes
  settle timing; needs battery A/B.
- **(b) Reduce per-bake transient allocation in Rust** (stream/reuse decode
  scratch buffers instead of fresh allocs per bake). Substantial rework; the
  most principled fix.
- **(c) Periodically tear down + recreate the wasm instance at quiet points**
  (reclaim the high-water). Coarse but simple; risks a hitch at teardown.

Related XL already flagged: **wasm-threads (SAB)** is the only real fix for
main-thread decode starvation — multi-week, separate decision.

## What the loop is doing meanwhile

Regression-watch: keep the decode-axis league + settle baseline fresh, keep one
soak alive (it reproduces the crash as ongoing evidence), await the user's
decision on (a)/(b)/(c). No autonomous RSS patch.
