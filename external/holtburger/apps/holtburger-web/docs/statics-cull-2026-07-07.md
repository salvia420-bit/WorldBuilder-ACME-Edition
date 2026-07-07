# Statics-cull work — Town Network per-frame freeze (2026-07-07)

**Root cause (profiled, CDP through the freeze):** teleporting to a hub dungeon
("Town Network") makes the client crawl at sub-1fps for minutes. It is NOT the
spawn/decode burst — it is the **per-frame statics tick scaling O(total resident
statics)**: `scene3d.staticsGroup` is a flat list walked in full every frame by
`cullStaticsGroup` + `tickStaticsBillboards` + lighting `recordStatics`. At Town
Network the streamer makes **~65 landblocks resident** (`staticsBakedLbs.size`),
i.e. ~50k static nodes, each frustum-tested every frame.

## ✅ Step 1a — indoor PVS-ring gate (LANDED, the effective fix)

`scene3d/cells.js` `tickPvsLoadExpansion`: when `sessionHandle.isCurrentCellIndoor()`
is true, collapse the prefetch ring from the outdoor radius-5 (11×11 = 121 LBs)
to `INDOOR_PVS_RING_RADIUS` (default 1 = a 3×3 skirt). A dungeon has no
line-of-sight to the surface LBs the ring pulls; the render-set (`getRenderSet`)
is baked regardless of ring radius, so anything the PVS actually sees still
loads. Default-ON; `?indoorPvsRing=N` overrides (`=0` render-set only; `=N ≥
pvsRingRadius` disables). Zero effect outdoors.

**Verified (headless, Town Network, gate ON vs `indoorPvsRing=5`):** resident
landblocks **65 → 6 (−91%)**, sustained >100 ms hitches 9 → 2, entities
unaffected (177), 0 errors, `isCurrentCellIndoor: true` (gate fires). Because
every per-frame statics walk AND all bake work scale with resident-LB count,
this ~11× residency cut resolves the reported dungeon freeze at the source.
**Owed:** a 1070 pixel eye-test (nothing visibly missing at a dungeon
mouth/portal where surface is visible through the render-set).

## ❌ Step 2 — landblock-bucketed cull (ATTEMPTED, REVERTED — measured dead end)

The design (buildbox 16-agent `FINAL_DESIGN.md`, agents 05/06) recommended a
per-LB bucket index: one aggregate-sphere frustum test per landblock gates the
whole bucket → O(N_LBs + N_in_frustum). Implemented as a rebuild-on-drift index
in `cullStaticsGroup` with a conservative union sphere (exact visible set).

**It does not work for this scene — measured, not guessed.** At 65 resident LBs
(50,843 nodes): **only 52 buckets vs 49,092 nodes in the cross-LB tier (96%)**,
`perCallMs` unchanged (~7.9→9.0 ms). Reason: the statics are **cross-LB
INSTANCED** — the ~50k `InstancedMesh`/LOD consolidation nodes carry a
`coversLbKeys` **Set of size > 1** (one InstancedMesh spans many landblocks, the
statAtlas/cross-LB-consolidation trade of draw-calls for un-bucketable nodes),
not a single `userData.landblockId`. A salvage bucketing `coversLbKeys.size===1`
nodes moved almost nothing (they are genuinely multi-LB). Per-LB spatial
bucketing therefore cannot group them; the cost is ~50k individual frustum tests
on cross-LB aggregate spheres, 94% of which cull (so the cull is doing real
work — dropping ~46k draws — it is just O(nodes)).

Reverted (`git checkout statics.js`) to avoid shipping index-rebuild overhead
with no payoff. **This is the `verify-agent-leads` discipline paying off: the
design's per-LB-bucket premise was false for the real node structure.**

## Remaining levers for the per-frame cull (future, only matters for a large
## OUTDOOR view — the dungeon case is fixed by 1a)

1. **Residency is the real lever** (Step 1a already applies it indoors). An
   outdoor residency cap (size `maxResident` to the working set, not the ~203
   ring ceiling — `FINAL_DESIGN` secondary) would cut N outdoors too.
2. **Fewer instanced nodes** — coarser consolidation (fewer, larger
   `InstancedMesh`) cuts the per-node frustum-test count directly.
3. **Spatial hash on node aggregate-sphere CENTERS** (NOT landblockId) — the
   only hierarchical cull that fits cross-LB instanced nodes. Bigger redesign;
   large multi-LB spheres cull poorly, so payoff is uncertain — measure first.
4. Secondary (orthogonal, still open): missing-surface negative cache
   (`0x08F00001` warned 569×/90s — `FINAL_DESIGN` agent 11).

Full design corpus: `~/from-vm/statics-cull-wf/` (`FINAL_DESIGN.md` + 16 parts).
