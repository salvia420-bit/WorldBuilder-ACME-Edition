# 2026-10-19 — water that flows downstream, waterfalls that stay drawn, dams that stay dry

Owner request (2026-10-19):

> "for holtburger-web there are issues with a number of waterfalls not correctly displaying particle
> effects, there is also a general issue with our modifications to water not flowing in the right
> direction down these waterfalls ... it will be noticable that the water is flowing towards a
> waterfall instead of away from it ... otherwise you have to come up with some sort of system which
> understands which way the water needs to flow, and still have to come up with solutions around the
> waterfalls. there are some dams on marae lassel and the water can clip into the dams a little bit"

Nothing here was eye-tested: agent-driven live sessions are off-limits on the laptop (see the
`no-agent-eyetests` rule). Verification is node suites, a real-WebGL2 GPU smoke (SwiftShader) and the
full JS gate. The 1070 checklist in section 5 is owed.

## 1. What was wrong

| Symptom | Root cause | Evidence |
|---|---|---|
| Water flows the wrong way at falls; pools crawl toward their falls; steep water faces slide sideways or uphill | `terrain.js` scrolled every water pixel the same way, `fract(cellUv + uTime*(0.05,0.02))`: about 1.3 m/s west-south-west on rivers, lakes and the sea alike. `cellUv` is a horizontal parameterisation, so on a steep face the drift is a projection that ignores the slope. | Shader read; GPU smoke `flow_uniform_off` measures (−2, −1) px per 0.3 s = WSW |
| Water pokes through the Marae Lassel dam walkways | The swell lifts water vertices up to +0.24 m. Under East Fork Dam's north end (0x1FBC cell 4,2) and West Fork Dam's south end (0x1BBB cell 5,7), retail's terrain split leaves a flat 82.000 m triangle with one reservoir corner. Retail draws all terrain 1 cm low, so the walkway always won. Our swell tilted the triangle up through the deck: 0.224 m at worst, about 48 % of the time. | Real-DAT fixture `fixtures/terrain/marae_dams.json`; `test_terrain_water_flow.mjs` §2 |
| Crack along shores at the LOD boundary | A subdivided shoreline vertex took its NEAREST control-grid code (full swell or none), while the coarser neighbour drew the chord. This left a 0.125 m crack on water/land edges. | `test_terrain_water_flow.mjs` §2 crack test (the old gate measures > 0.05 m) |
| Waterfalls vanish when the lip is off-screen | RP6 hides and freezes a whole emitter when a sphere round its anchor leaves the frustum. That sphere was retail's sorting radius `max(maxOffset, maxA·lifespan)`: maxA is only A's random multiplier and gravity never enters. A 12–18 m sphere at the lip, against sheets travelling 44–134 m. | Node probe with the real `ParticleManager`: hidden in 17–31 % of close views with water on screen → 0 % |
| Distant falls missing | RP6 caps particles at 220 m; every waterfall GfxObj authors a 392 m degrade distance (retail draws to it). At the Cataracts portal drop, 30 of 65 spouts were beyond about 234 m. | `test_particle_waterfall_reach.mjs` |
| Sheets erode into wisps and blink dark | The tier-1 FX profile gave the 5 water-sheet emitters smoke-style noise erosion, rim, and a 0.6 shadow sample per 13 m sheet. | `tools/particle-fx/tier1_overrides.json` |

Wrong earlier premise, corrected in passing: `particle_manager.js` and the `particleBillboard` url-flags row
called 0x32000829 / 0x3200002F the "Nanto waterfall sheet / mist". They are a torch glow and a wall-torch
flame. Nanto's Blue Ghost Falls use 0x32000031 + 0x3200000C.

## 2. What changed

| Flag | Default | What |
|---|---|---|
| `?waterFlow` | **on** (`off` escape) | Flow map: water advected along a baked per-vertex flow field (two-phase flow map in the TexMerge slots and bilinear taps), slow mean-zero eddy on still water, ripples ride the flow, whitewater on fall faces, plunge pools and fast water. `scene3d/terrain_water_flow.js`. |
| `?waterBank` | **on** (`off` escape) | Banked swell: evaluated on every vertex as bilinear(swell × weight) over the 24 m lattice. Weight 0 on land and beside a drop (dam crests, waterfall lips), so it is crack-free at shores. The open-water swell is unchanged. |
| `?waterFlowSpeed` / `?waterFlowPeriod` / `?waterStill` / `?waterFoam` | 1.2 / 1.6 / 0.35 / 1 | Tuning; also live via `window.__waterFlow.set({speed, period, still, foam})`. |
| `?rp6TravelReach` | **on** | Cull sphere = per-ParticleType travel bound (gravity included); sprite reach measured from the particle origin. |
| `?rp6DegradeCap` | **on** | An emitter with a degrade distance beyond 220 m draws out to it (retail). |
| `?particleAlphaRetail` | **on** (owner: default-on; eye test still owed) | Retail state for alpha particles: no depth write, alpha test ≈0, alpha drawn before additive. Trade-off: two overlapping alpha buckets (different emitters) draw in creation order, not back to front. |
| (profiles) | — | The five water-sheet emitters: noise 0, rim 0, shadow 0.1; the velocity-stretch "teleport" guard follows each emitter's own top speed. |

Data: `data/water_flow.bin` (208 KB, 849 landblocks) and `data/water_flow_sites.json` (31 sites) are baked
by `tools/water-flow/bake_water_flow.py` from `~/ac_base_dats` only. It is pure Python + numpy, reads the
DATs directly, takes about 20 s and is deterministic. The README there documents the algorithm and the
format. Rivers are flat terraces (99.6 % of running water sits on flats), so direction comes from topology:
a priority flood to the ocean over land and water, with water routes winning, lakes filling to their spill
point and falls opening their land gaps. Per landblock the data rides columns 18..35 of `uVertexTypes`,
which is now 36 wide. No new sampler: the terrain program stays at 15 of the 1070's 16 units. The batched
ring, per-LB fallback and far bake are all covered; the far bake switches both features off, since its
scratch texture is 9 wide and its albedo is frozen.

## 3. Verification (laptop, 2026-10-19)

- `test_terrain_water_flow.mjs` — 101/0:
  - flags;
  - real-DAT dam decks: the drawn terrain stays under 82.000 m at factors 1/2/4 over 120 s, while the old gate poked;
  - crack-free on every cell edge of both dam landblocks, shores included;
  - landblock seams;
  - column writer, table parser, and the shipped table: 1,266 neighbour pairs byte-equal, 15 hand-labelled checkpoints (Holtburg north river, Cragstone lip/faces/pool/lake, the south river flowing away from the lake, Marae Lassel fall + pool, Blue Ghost pools, a still pond, a river mouth, open ocean);
  - assembled GLSL order and anchors;
  - the real batched derivation;
  - six flag variants.
- `harness/glsl_smoke/water_flow_smoke.mjs` (headless Chromium / SwiftShader, `capped-build`) — PASS. It
  compiles the real per-LB and batched programs, then measures motion over 0.3 s:

  | case | measured |
  |---|---|
  | east / north / west flow | (4,0) / (0,4) / (−4,0) px, expected 3.9 |
  | batched | identical |
  | zero flow, no eddy | exactly still (no flow-map pulse) |
  | eddy | slow |
  | flow uniform off | the old WSW drift |
  | whitewater | brightens with texture kept (contrast 17.7) |
  | swell weight 255 / 0 | moves / still |

- Particle suites (22 targeted, incl. the new `test_particle_waterfall_reach.mjs` 47/0) — green.
- Existing terrain suites (water 84, batch 56, round 91, micro 122, far-simplify 51, texmerge 33, sand/volcano/dirt/snow/ice) — green.
- Full JS gate (`capped-build node harness/run-js-headless.mjs`): **830 / 830**, re-run after `?particleAlphaRetail` went default-on. The first run was 828 / 830; both failures were environmental (the sparse worktree lacked `WorldBuilder.Terminal/VfxData` and the gitignored `pkg-node/`) and passed once those were provided.
- Coverage guard: 0 unregistered.
- Browser suites, each under `capped-build`, one tab:
  - `water_flow_smoke` PASS
  - `test_far_bake_shared_textures_gpu` 6/6
  - after the default flip: `test_particle_fx_gpu` 19/19, `test_particle_fx_tier1_gpu` 15/15, `test_particle_fx_tier2_gpu` 31/31, `test_weapon_fx_gpu` PASS, `test_lifestone_fx_gpu` 15/15, `test_moon_fx_gpu` 25/25

## 4. Cost

- **Terrain:**
  - Vertex stage: 4 texelFetch per vertex, plus the 4 swell sines only near water.
  - Water fragments: 4 flow + 4 foam texelFetch, 1 extra atlas tap per flowing water layer (2 per water corner on the bilinear path), 2 noise for the phase/eddy, and the ripple field twice inside the sheen range.
  - Land fragments: nothing beyond a branch.
- **Moving water reads about 20 % lower in texture contrast mid-blend** (18.7 vs 23.8 in the smoke). This is inherent to two-phase flow maps.
- **Particles:** 1,729 of 2,051 retail emitters get a larger cull sphere (median +1.2 m, 190 by > 10 m). The rough estimate is the Linvak drizzle going from about 40 % to 76 % live within its 64 m radius. Also, 93 emitters draw beyond 220 m: 76 at 392 m (waterfalls, ritual and beacon pillars). `staticScriptRadius` is unchanged (radius 2 already covers every listed fall).

## 5. Owed: 1070 eye test (owner-run, off-screen, muted)

URLs with `?nosw=1`. Teleports are computed, not tried.

1. **Holtburg north river** `@teleloc 0xA9B60025 96 96 28.5` — the river runs east/south-east (downstream), not west-south-west. A/B `?waterFlow=off`.
2. **Cragstone Falls** `@teleloc 0xB6A30011 56 1.1 1.9` —
   - the river above runs to the lip;
   - the code-22 faces stream down white;
   - the pool flows AWAY from the foot with foam fading downstream;
   - with the lip out of frame the sheets keep falling (A/B `?rp6TravelReach=off`);
   - `?particleAlphaRetail=off` vs the default: sheets against mist, and overlapping smoke columns (wrong-order layering would show here).
3. **Cragstone lake → south river** (0xBF9C → 0xCA89) — the lake drifts slowly south, and the river leaves the lake (it used to run back toward the falls).
4. **Marae Lassel main fall** `@teleloc 0x1DB40009 40 10 2` — the river runs south to the lip, the pool flows out, and the delta channels head for the sea.
5. **Marae Lassel dams**:
   - East Fork north end `@teleloc 0x1FBC0023 116 56 82.05`;
   - West Fork south end `@teleloc 0x1BBB0030 126 176 82.05`;
   - expect no water through the walkway; `?waterBank=off` shows the old poke every few seconds.
6. **Cataracts of Sabella portal drop** `@teleloc 0x22E60029 132 12 117` — falls 234–392 m away are drawn (A/B `?rp6DegradeCap=off`).
7. **Open sea / a still lake** — slow wandering motion, no global heading. `?waterStill=0` gives a static retail texture; `?waterFlow=off` gives the old drift.
8. **Tuning live:** `__waterFlow.set({speed: 1.5, period: 2, still: 0.25, foam: 0.7})`, `__waterFlow.at(x, y)`.
9. **Perf:** Linvak Tukal particle count / frame time with `?rp6TravelReach=on` vs `off`.

## 6. Known limits / follow-ups

- **Marae Lassel's pool cascades** (0x1BBC, 0x1EBC–0x20BC, 0x1FBF) are painted code 23 (SeaSlime). Retail draws them as slime, and so do we: no flow or foam there. The baked sites file lists them if a mist / spray treatment is wanted (`data/water_flow_sites.json`, kinds `land-cliff gap` / `spill`).
- **Braided channels and deltas** flow toward the nearest outlet, so a few side channels run against the visual main stream (about 88 % agreement in Marae Lassel's delta).
- **Fresh-water swell is kept everywhere except at drops** (the owner kept the swell after the 2026-10-08 A/B). Objects floating in fresh water (pool hives, lily pads) still sit at retail height while the water rises and falls around them. Restricting the swell to the sea is a small change if wanted.
- **Not water, unverified:** procedural grass / pebbles can stand on the flat 82 m triangles under the two dam end pieces, which have no interior cells for the indoor cull.
- **Synthesized mist at terrain-only falls** (the 0x20BF spill and others without retail emitters) is not done. The sites file is the input for it.
- **The cull sphere is centred on the lip.** A sphere centred mid-fall would be tighter if the 1070 shows a particle cost.
- **Film mode** `particles_query.js` still uses the retail sorting radius.
