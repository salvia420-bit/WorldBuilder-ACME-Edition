# PLAN — 2026-08-18: order of operations + spending the runway for perceived quality
Demuddling session output. Inputs: HANDOFF-2026-08-17-EOD3.md (HIFI split math, D4
verdict, DO-NOT-LOSE list), TASKLIST-2026-08-17 §I (I1–I8), reports/deblock-ab-2026-08-17.md
(decision + color note). This is a PLAN, not a work log — no implementation happened
in this session.

## 0. The two questions this answers
1. **Order of operations** for the queued work (r7.1 → HIFI split → r8 fill).
2. **Allocation**: we use ~1.5 GiB today and will have ~2.77 GiB of total runway after
   the HIFI split (1.40 GiB highres/texture side + 1.27 GiB portal/geometry side).
   "Twice the bytes" does NOT buy "twice the visual quality" — this plan says where
   the remaining headroom actually buys perception, and where it evaporates into
   diminishing returns.

## 1. Three facts that reframe the whole allocation problem

**F-A. Disk is no longer the binding wall — the client's 32-bit address space is.**
D4 proved it: terrain baseTexSize 2048 at VeryHigh OOM-crashed on the FIRST outdoor
composite burst (VmSize 1.63 → 2.42 GB). The portal ceiling research (exact 2^31−1)
plus the HIFI split retire the *disk* ceiling, but every lane from here on must be
scored on **resident footprint**, not dat bytes. Dat bytes are streamed; composites,
resident texture sets, and geometry working sets are not. A 4 GB dat pair the client
cannot page comfortably is worth less than a 2 GB pair it can.
→ Standing gate for every new lane: record peak VmSize across the 6-stop tour per
arm; treat ~2.0 GB (wine) as the amber line until measured on Windows/LAA.

**F-B. Texture fidelity is codec-capped, so resolution-deepening is the WRONG spend.**
Our lane ships DXT1/DXT5 (texture_lane.py; = BC1/BC3). The client is D3D9 — BC7
does not exist for it, ever. At 2048² through BC3, most of what an 8× (4096²)
re-upscale adds is quantized away by the codec while quadrupling VRAM/composite
pressure straight into wall F-A. The user's intuition is correct and now grounded:
2048²/BC3 done WELL is hedonically competitive with far larger textures; past it the
marginal byte buys almost nothing on already-covered surfaces.
→ Corollary: on the texture side, the remaining headroom should buy **coverage**
(surface classes still at retail quality) and **artifact removal** (quilting, lost
color), not density on surfaces already at 2048².

**F-C. Artifact removal is the steepest part of the hedonic curve.**
Removing an ugliness (16-px quilting, washed-out color, feet-sink, jaggies on a
silhouette you stare at) is worth more per byte than adding fidelity, because
artifacts are what the eye locks onto. Two of our known artifacts are *free* to fix
(deblock rebake inputs already on disk; color anchor is a pipeline switch). They go
first, before any byte of new content.

## 2. The hedonic ranking (what a byte buys, best → worst)
Score ≈ (visible improvement × screen-time exposure) ÷ (bytes + resident cost + risk).

| rank | lever | cost | why |
|---|---|---|---|
| 1 | **Color restore at r7.1 re-encode** (I8: verify/apply retail anchor; residual → per-texture color-stats transfer, CPU) | ~0 B, CPU min | Recovers value we already paid GPU for; deblock A-arm is raw Remacri, −8..−30% RGB. Pure recovery. |
| 2 | **Deblock rebake** (decided: ADOPT) | 0 GPU, ~50 min re-encode | Severe quilting eliminated, 272→57. Already bought. |
| 3 | **Degrade-chain collapse + CI** (I3) | minutes | Kills old-texture patchwork class. |
| 4 | **Creature/monster texture project** (the 811 recolor wall: INDEX16 depalettize + ClothingTable recolor handling; 4,182 surfaces / 432 palettes) | highres headroom, real eng. work | Highest-exposure surfaces in the game (you fight things at close range constantly) still at RETAIL quality. Biggest un-diminished texture lever we own. |
| 5 | **Geometry coverage expansion** (portal headroom): finish scenery aa+ab; 9 degrade-deferred; env-variant re-cut w/ orientation veto + wider class coverage; NEW research lane: animated/creature meshes | freed 617 MiB | The user's "4× triangles not applied everywhere" — same logic as #4: extend the proven 4–6× subdiv to uncovered high-exposure classes before deepening covered ones. Creature silhouettes = highest exposure if the lane proves feasible on animated Setups. |
| 6 | **Terrain detail textures** (D5; DetailTextureId, tiling 4, now visible) | small | Cheap, dodges the MergeTexture composite wall entirely. |
| 7 | **Terrain-2x** | gated | Only in the shape the D4 diagnostic proves safe (see §4 fork). |
| 8 | Selective 4096² for surfaces PROVEN texel-starved at typical view distance (measure first; expect a short list) | measured | The only defensible resolution-deepening. |
| 9 | Blanket 8× resolution on covered surfaces | — | REJECTED: codec-capped (F-B), VRAM-hostile (F-A), diminishing. |
| 10 | Uncompressed A8R8G8B8 instead of DXT to dodge BC artifacts | — | REJECTED as default: 4–6× resident cost into wall F-A. At most a per-surface exception via #8's measurement. |

"Double the hedonic value" is achieved as: **recover (1–3) → widen (4–6) → deepen
only where measured (7–8)** — i.e. every commonly-viewed surface AND silhouette
class touched by a 4× lane, zero known artifact classes left. That is a defensible
2×; "2× the pixels/triangles everywhere" is not.

## 3. Order of operations

### Phase 0 — next box session opener (already staged)
- **0.1** The 15-min LandscapeTextureDetail=High terrain diagnostic
  (~/terrain-arm/, ~/terrain-smoke.sh, INI bak in place). Pure information;
  forks Phase-4 terrain scope. Blocks nothing else.
- **0.2** Same T4 session: bake Remacri 2× PNGs for the 1,320 highres-lane records
  (the last missing highres-lane input). Piggyback — one box spin-up.

### Phase 1 — r7.1 (quality take; needs NO new space, NO new GPU beyond 0.2)
1. **1.1** Re-encode + import the deblock corpus from out-remacri-full/ with the
   retail color anchor VERIFIED ON (the I8 fix — this is where the lost color comes
   back). Add a meanDrift-style color ledger vs retail to the take gate so color
   regression becomes a numeric tripwire, not an eye-only catch.
2. **1.2** Fold fix_degrade_chains --fix + --check into the take-5 driver (I3),
   placement per README (after lanes, before compress/compact; recheck packaged).
3. **1.3** Run highres_lane.py on the 0.2 PNGs; hold the no-regression-vs-r7
   invariant 1,342/1,342.
4. **1.4** Terrain fold ONLY per the Phase-0 verdict (else shelve to Phase 4 / D5).
   If any highres dat ships alongside terrain-2x: collapse the 8 blend STs first
   (entry[0] = highres ids — MANDATORY, already flagged in I6).
5. **1.5** ONE batched eye-test session (per §1070-eyetests-batched): deblock stops
   (0600378C severe wall, Muggy Guruk median, creature closeup) + color check vs
   retail AND vs old bakes + terrain arm (if any) + highres arm. Severity-gated mix
   is the pre-approved fallback; both arms on disk, switching is free.
6. **1.6** Package + ship r7.1 (standard walk_check / DatCompress --verify / tour
   gate; EOR exe + dat-version-preserve is the release artifact).

### Phase 2 — mount guarantee + HIFI preconditions (research, parallel to Phase 1)
The split makes highres LOAD-BEARING (no portal fallback → un-mounted = missing
textures). Nothing in Phase 3 starts until ALL of:
1. **2.1** Mount mechanism decided + built. Recommendation: the **client-side
   force-mount patch** (CLCache::LoadHighResDat guard, acclient.c:293792) — it keeps
   ACE vanilla (§2 rule), keeps the 9-byte-patch release model, and works on any
   server. ACE product-bit-4 (GameMessageDDDInterrogation.cs 1u→5u) stays the
   documented alternative for server operators. Add to the external patch registry
   (enabled=False) + verify boot-mounts the real eor2013 highres.
2. **2.2** DDD iteration semantics for a CUSTOM highres when ACE serves dats
   (open item #4 in the handoff) — verified, not assumed.
3. **2.3** Installer/kit story: fresh-install simulation — a client kit MISSING
   client_highres.dat must fail loudly/gracefully at our gate, and the shipped kit
   must make that state impossible.
4. **2.4** Keep-or-drop the 11 unnamed retail highres ids + 22 passthroughs:
   default drop-with-the-rest (unreferenced, ≤ a few MiB).

### Phase 3 — r8 architecture: THE HIFI SPLIT, variant B
1. **3.1** Move our baked 0x06 payload → client_highres.dat (highres_lane b-tree
   bulk loader); DELETE the superseded retail standard copies from the portal
   (trevis's exact form); DatCompact both (delete frees blocks, never file size —
   the win lands at compact).
2. **3.2** Expected landing: portal ~0.9 GiB, highres ~648 MB; runway 1.40 GiB
   texture-side + 1.27 GiB world-side. Geometry stays portal-side (geometry-in-
   highres is decomp-plausible but UNTESTED — do not lean on it).
3. **3.3** Gate hard: mount-guaranteed arm + missing-highres arm (must be the loud
   failure from 2.3) + full 6-stop tour + walk_check + degrade-chain --check on BOTH
   files + VmSize ledger (F-A gate).
4. Variant C (portal carries zero 0x06) stays the clean end-state option AFTER B
   has soaked in the wild.

### Phase 4 — fill the runway, in hedonic-rank order (§2)
Portal side (1.27 GiB), budget_planner-driven, no silent caps:
1. **4.P1** Finish the scenery lane (the aa+ab chunks that tripped the r7 ceiling —
   the freed space's first customer).
2. **4.P2** Sweep the deferred tail: 9 degrade-deferred records (band-object lane),
   demote-to-skip-gate router refinement from the box validation run.
3. **4.P3** Env-variant re-cut with the orientation veto (C3) + widen WALL_CLASSES
   coverage (C4) — fixes feet-sink debt AND recovers wasted triangles.
4. **4.P4** RESEARCH SPIKE, timeboxed: 4× subdiv on animated/creature GfxObjs
   (skinning + physics-untouched invariant + degrade-band guard on Setups). If
   feasible → highest-value geometry lane we have; if not, write the negative
   result and stop.

Highres side (1.40 GiB):
5. **4.H1** The creature/monster texture project (rank #4; unparks E3). Own the
   INDEX16→DXT depalettize + ClothingTable recolor path. This is the headline
   spend of the texture headroom.
6. **4.H2** D5 terrain detail-texture upscale (cheap, composite-safe).
7. **4.H3** Terrain-2x per the Phase-0 fork: diagnostic PASS → ship as
   High-detail-supported (documented VeryHigh cap) or with a composite-memory
   strategy; FAIL → 1024 sources without the Region patch + D5 only.
8. **4.H4** Texel-starvation survey → the SHORT selective-4096² list (rank #8),
   if any survive measurement.

### Phase 5 — finishing touches (owner-ordered LAST, after the space is filled)
- T4 color/tone enhancement pass over the corpus (the I8 "finishing touches" order).
- F3 4K-res UI patch (with the one-byte Pea defect fix) — owner review pending.
- G5c DXVK knobs (samplerAnisotropy / LOD bias) on the wine box.
- E1 re-shoot showcase footage at VeryHigh with everything landed.

## 4. Decision forks (the only places the plan branches)
- **D4 diagnostic** (0.1): PASS → terrain-2x lives as High-detail feature (4.H3);
  FAIL → terrain-2x is dead in current form; D5 + no-Region-patch 1024 only.
- **Eye-test** (1.5): mid-tier softness → severity-gated mix fallback (free).
- **Mount** (2.1): force-mount patch proves out → ship it; else product-bit-4
  becomes a documented server requirement and keep-ACE-vanilla takes the exception.
- **Creature-geometry spike** (4.P4): feasible → new flagship lane; not → the
  portal headroom goes deeper into scenery/env coverage instead.

## 5. What this plan explicitly does NOT do
- No blanket 8×/4096² texture pass (F-B), no blanket A8R8G8B8 (F-A).
- No color-enhancement GPU work before Phase 5 (owner order, recorded in the
  deblock report).
- No reliance on geometry-in-highres (untested).
- No lane ships without the VmSize ledger once F-A is the known wall.
