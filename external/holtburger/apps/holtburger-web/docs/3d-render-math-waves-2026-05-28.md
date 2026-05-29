# 3D-render math backlog — team-agent waves (2026-05-28)

**Audience:** orchestrator (Claude) spawning Explore + implementation sub-agents against
`/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/`.

**Goal:** land a backlog of **mathematically self-contained** renderer-fidelity tasks mined
from the canonical AC sources (acclient.c/.h/.txt, ACE, Chorizite, melt, DatReaderWriter) and
cross-checked against the live renderer. Every item is a formula/algorithm retail computed
precisely that holtburger-web currently approximates, gates off, or omits.

**Why this structure:** bundling is by **code-surface disjointness**, not ROI — so each wave's
agents run in one parallel batch with minimal merge friction. Shader/Rust/sky items (fully
disjoint files) go first; lighting (shared `lighting.js`/`materials.js`) next; the
`entities.js` + `lib.rs`-heavy motion/sort work goes last so smaller items don't fight those
files. Within a wave, agents own disjoint files; seams are called out explicitly.

This is a discovery backlog: **nothing here is blocking and nothing is half-done.** Pick a
wave, ship it, eye-test it, move on.

---

## Required reading (in order) for every spawned agent

1. **`apps/holtburger-web/docs/HANDOFF-3d-render-fidelity-2026-05-28.md`** — the canonical
   reference-source table (§1), the **one-shot 1070 headless eye-test loop** (§2), the
   precedence rule (**acclient.c > ACE > DRW** for exact arithmetic/widths), the wasm-rebuild
   recipe, and the gotchas (black-screenshot trap, GLSL-backtick trap, FIFO-stdin ACE).
2. **`apps/holtburger-web/docs/3d-render-fidelity-audit-2026-05-28.md`** — what the T1–T12
   fidelity pass already shipped; don't re-litigate.
3. **`docs/team-agents-plan-2026-05-27.md`** §"Cross-wave guidance" — visibility-blocker
   watch, opportunistic-assist, `lib.rs` etiquette, commit pattern. Those rules apply here
   verbatim; this doc does not repeat them.
4. This doc — the wave-specific brief for the agent's task + Appendix B (already-shipped, do
   NOT propose).

---

## Cross-wave guidance specific to this backlog

- **Flag-gate, then eye-test.** Every visual change ships behind a `?flag=on` query param
  (extend the `scene3d/loop.js` / `terrain.js` URL-parse pattern), defaults **off**, and is
  A/B'd on the 1070 via the handoff §2 loop before it's called done. A retail-faithful change
  that *looks* wrong on the GPU is not done — surface that, don't bury it.
- **Math precedence:** when sources disagree on a constant/width, **acclient.c wins** (it's the
  shipped client), then ACE, then DRW. Cite the line you took the number from in the commit body.
- **No fabricated formulas.** Every brief points at a source line range. Read it; extract the
  real arithmetic. If acclient and ACE differ (e.g. 32-bit wrap vs 64-bit `long`), prefer
  acclient and note the divergence.
- **`lib.rs` etiquette:** add-only, marked `// === Wave R<N>.<letter> — <feature> (2026-05-28) ===`,
  three-struct threading for per-entity surfacing. Orchestrator commits smaller-surface agent
  first when two agents touch `lib.rs` in one wave.
- **Validation gate (every task):** `cargo test -p holtburger-dat` + `cargo test -p holtburger-web`
  green · `cargo check --target wasm32-unknown-unknown` clean · `node --check` on edited JS ·
  then the 1070 eye-test. Add/extend a Rust reporting test where the task is parser/math-side.
- **Commit prefix:** `feat(holtburger-web): wave R<N>.<letter> — <subject>` + `Co-Authored-By:` block.

---

## TL;DR

| Wave | Theme | Agents | Parallel? | Risk | Effort | Primary surfaces |
|---|---|---|---|---|---|---|
| **R1** | Terrain/sky math — fully disjoint files | 3 | **Yes** | Low | ~½ day each | `terrain.js` shader · `terrain_subdiv.rs` (Rust) · `sky_lighting.js`+SkyState |
| **R2** | Lighting & shading accumulation | 2 | Yes (commit R2.A first) | Med | ~1 day / ~½ day | `entities.js`+`lighting.js` · `materials.js` shader |
| **R3** | Entity motion & sort — `lib.rs`/`entities.js` heavy | 2–3 | Partial (lib.rs etiquette) | Med | M / M / M | `entities.js` update · `adapter.js`+`graphics.rs` · vfx/projectile |
| **R4** | Fidelity nits (opportunistic) | as available | Yes | Low | S each | terrain composite · sky objects |

Ranked recommendation for a single first strike: **R1.A** (smallest, pure color-space math,
A/B harness already exists). Highest *visual* payoff: **R2.A** (entity lights).

---

## Wave R1 — terrain & sky math (3 agents, fully parallel)

All three touch disjoint files: a GLSL fragment path, a Rust mesh-index path, and the sky
state path. No `lib.rs` collisions if each marks its additions.

### R1.A — Terrain vertex **saturation + hue** modulation (finish `?terrainMod`)

- **Surface:** `scene3d/terrain.js` (fragment + the per-vertex attribute), small `src/lib.rs`
  extension of the existing `fetch_terrain_modulation_ranges()`.
- **Current status (do NOT redo brightness):** brightness modulation shipped;
  `buildTerrainVertexBrightness()` at `terrain.js:160-193` packs a per-vertex brightness
  hashed by world-XY; the fragment multiplies at `terrain.js:1192`
  (`result * mix(1.0, vBrightness, uTerrainModulationEnabled)`). The docstring at
  `terrain.js:148` states sat+hue are **authored but not applied**.
- **The math:** for each vertex pick a random in `[min_vert_saturate, max_vert_saturate]` and
  `[min_vert_hue, max_vert_hue]` (same world-XY hash you already use for brightness, different
  salt per channel so they decorrelate), pass as two more vertex attributes, then in the
  fragment do an RGB→HSL (or HSV) conversion, scale `S` by the saturation factor and rotate `H`
  by the hue offset, convert back — applied to the lit color **before** the cloud-shadow/CSM
  multiply, same composition point as brightness.
- **Sources:** field semantics `acclient.h:52974` (`TerrainTex` 6 fields:
  `{min,max}_vert_{bright,saturate,hue}`); Chorizite `TerrainTex.cs` confirms the per-terrain
  min/max storage. acclient ships no apply-path (the feature was authored, cut pre-ship — see
  `project_terrain_vertex_modulation_gap_2026-05-28`), so **unit interpretation is best-guess
  and the 1070 eye-test is load-bearing.** Treat `sat/hue` as percent like brightness.
- **Flag:** ride the existing `?terrainMod=on` (sat/hue activate together with brightness), but
  add a `uTerrainModSatHue` sub-uniform so you can A/B brightness-only vs full on the GPU.
- **Eye-test:** a Holtburg LB with both grass and road/ice cells; the Ice(2)/Road(32) outliers
  (`hue=30-40, sat=70-90`) should shift visibly vs natural terrain. If sat/hue looks wrong but
  brightness was fine, fall back to brightness-only and record the finding — don't ship a worse
  look for fidelity's sake.
- **Commit:** `feat(holtburger-web): wave R1.A — terrain vertex saturation+hue modulation`.

### R1.B — **Per-cell terrain triangulation diagonal** (`SWtoNEcut`)

- **Surface:** `crates/holtburger-dat/src/terrain_subdiv.rs` (triangle index emission) +
  wherever the per-cell split bit is sourced (`region.rs` / `LandDefs`). Rust-only — disjoint
  from R1.A's GLSL and R1.C's sky.
- **Current status:** every quad is split on a **fixed** diagonal — `terrain_subdiv.rs:586-604`
  emits T1 `(v01,v11,v00)` + T2 `(v11,v10,v00)` for all cells. Retail flips the diagonal
  per-cell, which changes the silhouette and the averaged vertex normals on slopes.
- **The math:** read the per-cell split decision and, when set, emit the opposite diagonal:
  `(SW,SE,NE)+(SW,NE,NW)` vs `(SW,SE,NW)+(SE,NE,NW)`; keep winding consistent with the
  adapter's CCW post-worldRoot convention so per-poly cull (default ON) still works.
- **Sources:** **extract the exact per-cell rule from acclient** — `ConstructUVs` at
  `acclient.c:354676-354759` and the `SWtoNEcut` array at `acclient.c:353224`; cross-check
  ACE's `Landblock`/`LandDefs` for the same decision (do not invent the rule — read it). Note
  per precedence: acclient is canonical for the bit derivation.
- **Flag:** `?terrainSplit=on` (default off) so you can A/B the diagonal flip on the same LB.
- **Eye-test:** ridgelines/hillsides at Holtburg — creases should follow true slope, not a
  uniform NW-SE bias. Add a `terrain_subdiv` reporting test asserting the split distribution
  is no longer constant across a real LB.
- **Commit:** `feat(holtburger-dat): wave R1.B — per-cell terrain triangulation diagonal`.

### R1.C — **Time-of-day fog-color interpolation**

- **Surface:** `scene3d/sky_lighting.js` (fog color consumption) + the SkyState producer in
  `src/lib.rs` (do the lerp where SkyState is built so JS reads an already-interpolated value).
- **Current status:** fog *distance* (`fogMin`/`fogMax`) is correct, but fog **color is static
  per DayGroup** — `SkyState.fogColorArgb` is set once on DayGroup change (`sky_lighting.js:4-10`),
  so it doesn't blend dawn→day→dusk→night.
- **The math:** bracket the two `SkyTimeOfDay` keyframes around the current normalized
  time-of-day, compute `t = (now - before.begin) / (after.begin - before.begin)` with the
  **midnight wraparound** (`t = (now - before.begin) / (1 - before.begin)` at end of day), then
  lerp `fogColor` **per ARGB channel** and lerp `fog_min`/`fog_max`. Repack to `fogColorArgb`.
- **Sources:** `acclient.c:301602-301661` (`CRegionDesc::GetWorldFog` — per-channel lerp + the
  end-of-day ratio case at `:301424-301469`). ACE's `RegionDesc`/`SkyTimeOfDay` for the C# shape.
- **Flag:** `?fogLerp=on` (default off; on = per-frame interpolated, off = current per-DayGroup).
- **Eye-test:** advance game time across a sunset (`@telepoi Holtburg`, watch the dir_heading
  sweep); fog tint should shift continuously (white morning → warm dusk → blue night) instead
  of stepping at DayGroup boundaries.
- **Commit:** `feat(holtburger-web): wave R1.C — time-of-day fog color interpolation`.

---

## Wave R2 — lighting & shading accumulation (2 agents)

Both relate to lighting but own disjoint files: R2.A adds light objects + dispatch
(`entities.js`/`lighting.js`); R2.B changes the shader accumulation math (`materials.js`).
**Commit R2.A first** — R2.B's per-channel clamp is most meaningfully eye-tested once dynamic
lights exist, and R2.A may add light-color uniforms R2.B reads.

### R2.A — **Entity-attached dynamic lights** (SetLight hook 25)

- **Surface:** `scene3d/entities.js` (`_fireHook` dispatch + a per-frame light tick, mirror the
  `_tickHookOmega` pattern) and `scene3d/lighting.js` (a per-entity light pool). The wire field
  `lightsOn` (i32 bool) is **already decoded and surfaced** on `AnimationHookJs`; `LightInfo` is
  already parsed at `crates/holtburger-dat/src/file_type/setup_model.rs:30`.
- **Current status:** the one explicitly-deferred AnimationHook. Per-*SetupModel* point/spot
  lights already render (`lighting.js:16-22`), but the SetLight hook is a no-op with a
  telemetry counter at `entities.js:5977`. Torches/lanterns/glowing-attack flashes don't cast
  light.
- **The math (the interesting part — retail lighting is non-standard):**
  - **Linear falloff, not inverse-square:** `attenuation = clamp(1 - dist/range, 0, 1)` where
    `range = falloff * static_light_factor` (`acclient.c:454579`, `calc_point_light`).
  - **Per-RGB clamp against the light's own color:** `contrib_c = min(intensity·dot·atten·color_c, color_c)` per channel — a red light never washes to pink (`acclient.c:454616-454627`).
  - **Spot cone:** `cone = pow(max(0, dot(L, coneDir)), falloffExp)` (`acclient.c:453206`,
    `UpdateLightsInternal`); `LightInfo.Falloff`/`ConeAngle` from melt `LightInfo.cs:10-11,19-20`.
  - Implementation choice: either toggle emissive on LightInfo-flagged parts (cheap, no real
    illumination) **or** attach/detach a `THREE.PointLight`/`SpotLight` per entity (correct,
    costlier). Recommend the real light path, pooled + count-capped per quality preset; encode
    the linear-falloff + per-RGB-clamp as a small `onBeforeCompile` patch shared with R2.B, OR
    approximate with THREE `distance`/`decay` and document the divergence.
- **Flag:** `?entityLights=on` (default off; light count capped by `quality.js` preset).
- **Eye-test:** an NPC with a lantern / a forge in Holtburg — surrounding terrain + walls
  should pick up the warm pool; confirm the per-RGB clamp keeps colored lights tinted.
- **Commit:** `feat(holtburger-web): wave R2.A — entity-attached dynamic lights (SetLight hook 25)`.

### R2.B — **Per-RGB-channel light-color clamp** in shading accumulation

- **Surface:** `scene3d/materials.js` lighting `onBeforeCompile` patch (the diffuse/ambient
  accumulation), independent of R2.A's `lighting.js` object management.
- **Current status:** the renderer uses standard PBR clamping to `[0,1]`; retail caps each
  channel at the contributing light's color so multiple/colored lights preserve tone.
- **The math:** replace the final `clamp(color, 0, 1)` on the light contribution with the
  per-channel `min(contrib_c, lightColor_c)` cap from `acclient.c:454616-454627`. Small,
  surgical; applies to sun + ambient + (once R2.A lands) entity lights.
- **Flag:** `?lightClamp=retail` (default off = standard PBR clamp).
- **Eye-test:** a scene with a strong colored light (R2.A lantern, or a tinted sun preset) —
  highlights should retain hue instead of blowing toward white.
- **Commit:** `feat(holtburger-web): wave R2.B — per-RGB light-color clamp (retail accumulation)`.

---

## Wave R3 — entity motion & sort (`lib.rs`/`entities.js` heavy, last by design) (2–3 agents)

Pushed last because these touch the big shared files. R3.A and R3.B both add `lib.rs` exports
(add-at-end etiquette; orchestrator commits smaller surface first) and R3.A and R3.C both touch
`entities.js` but in different functions (update loop vs vfx spawn) — keep their edits
function-local.

### R3.A — **Remote-entity dead-reckoning / motion interpolation**

- **Surface:** `scene3d/entities.js` per-frame update loop + `src/lib.rs` velocity surfacing.
- **Current status:** remote entities **snap to server-authoritative position** each update —
  no client-side prediction (coverage §6). Heading is normalized (`picking.js:84-88`) but
  position is not interpolated. Likely source of perceived stutter on other players/NPCs.
- **The math:** integrate position between packets from surfaced velocity + a
  critically-damped smoothing toward the latest authoritative position (avoid naive lerp lag);
  optionally use ACE's `Sphere.FindTimeOfCollision` quadratic sweep
  (`ace-server/Source/ACE.Server/Physics/Sphere.cs:232-248`) to clamp prediction so it doesn't
  overshoot into geometry. AFrame origin/rotation interpolation reference:
  `ACE.Server/Physics/Animation/AFrame.cs:43-78` (note: ACE uses Nlerp, not Slerp).
- **Flag:** `?deadReckon=on` (default off).
- **Eye-test:** a second logged-in character or a walking NPC — motion should smooth out vs the
  current snap. **Scope M–L** (touches the netcode boundary — least "pure math" of the set;
  consider splitting prediction vs smoothing if it grows).
- **Commit:** `feat(holtburger-web): wave R3.A — remote-entity motion interpolation`.

### R3.B — **Transparency depth-sort via GfxObj `SortCenter`**

- **Surface:** `scene3d/adapter.js` + `scene3d/materials.js` (`renderOrder` assignment) +
  `src/lib.rs` export of `sort_center` + `crates/holtburger-dat/src/graphics.rs` (GfxObj parse).
- **Current status:** multi-part translucent models (hair, cloth, ethereal/ghost entities) rely
  on THREE's auto bounding-sphere; retail sorts parts by an authored `SortCenter`. Blend-order
  artifacts on transparent parts.
- **The math:** surface `GfxObj.SortCenter` (melt `GfxObj.cs:25,57`) and
  `SetupModel.SortingSphere` (melt `SetupModel.cs:35-36`); compute a per-part depth key =
  view-space Z of `SortCenter`; assign `renderOrder` back-to-front for transparent parts.
- **Flag:** `?sortCenter=on` (default off).
- **Eye-test:** a character with layered hair/cloak, or a ghost (ethereal hook) — z-fighting /
  wrong blend stacking should resolve.
- **Commit:** `feat(holtburger-web): wave R3.B — transparency depth-sort via GfxObj SortCenter`.

### R3.C — **Projectile mechanics fidelity** (bolt vs arc vs streak/blast/wall) *(optional)*

**Revised 2026-05-29 with user-supplied retail mechanics — supersedes the original
"one quartic solver" framing.** AC war/void magic (and missile) has distinct projectile
behaviors, each needing its own handling:

- **Bolt** — aims at where the target *will be* (lead/prediction), travels in a **straight
  line** toward that predicted point. **Bolt speed depends on the target's trajectory**: release
  a bolt the instant the target moves *toward* you and the bolt crawls; otherwise it can be very
  fast. (Emergent from the intercept solve — relative velocity sets the apparent speed.) Heavily
  felt in PvP.
- **Arc** — aims at where the target is **at the moment of release** (a *stationary* point, so
  target velocity does NOT affect it), travels in an **arch**. Helps in some environments
  (lobbing over a hill crest) and hurts in others (down a long narrow hall — the arch hits the
  ceiling). Players commonly believe arcs travel slightly faster (at least for war magic).
- **Streak** — rapid-fire repeating same-projectile, target-locked.
- **Volley** — multi-projectile fan converging on target (incl. "rains N down" sky-rain).
- **Wall** — multi-projectile slow-advancing wall / forward wave-cone.
- **Ring** — caster-centered AoE, N projectiles radiating outward.
- **Blast** — AoE explosion at the target point.

**What already exists (this is NOT greenfield):**
- `ui/ac_spell_shape.js` — `classifySpell(spellId) → {school, shape, level}` over all 7 shapes +
  `Self`, backed by `data/spell-shapes.json` (LSD-derived). Shape vocabulary is complete.
- `scene3d/spell_shape_preview.js` (CMT Wave 12 / Phase 38) — a **500ms predictive overlay** on
  `spellCastInitiated` that already dispatches Bolt→line, Arc→parabola, Volley→fan, Ring→torus,
  etc. It resolves attacker+target world positions and is cosmetic-only (the server's
  `ObjectCreate` projectile entity is authoritative).

**Honest architectural reality (read before scoping):** the lead-prediction, the
target-trajectory-dependent bolt speed, and the arch path are all **server-authoritative** —
ACE computes them (`Trajectory.cs` `CalculateTrajectory`/`SolveQuartic`) and the client renders
the resulting projectile *entity* by following its position updates. So the client can't "add"
the real mechanics; it can only (a) make the **predictive preview** match them, and (b) render
the **real projectile's path** faithfully. The original doc's plan to port the quartic
client-side only makes sense for the preview, and bolt-lead needs target velocity the client
doesn't cleanly have (see R3.A — velocity isn't surfaced).

**Client-side scope that's actually faithful + valuable:**
1. **Preview fidelity** (`spell_shape_preview.js`): give the Arc preview a real apex so it visibly
   lobs *up and over* (conveys the over-hill/under-ceiling behavior) toward the release-time
   point; keep Bolt straight toward the target (lead-hint only if velocity ever gets surfaced).
   Distinguish Streak (fast repeat) / Blast (AoE at point) / Wall (advancing) visually.
2. **Real-projectile arc path** (interacts with **R3.A**): R3.A's straight-line damp would
   *flatten* an arc projectile's path (chord instead of arch) between sparse server positions.
   For Arc-classified live projectiles, interpolate a parabola through the server samples so the
   real projectile visibly arches. Requires classifying the live projectile entity by its source
   spell. This is the genuinely client-side, somewhat-mathy piece.
3. The **variable bolt speed** is nothing for the client to compute — it just shows the server's
   projectile at the server's speed; document it, don't fake it.
- **Flag:** `?projectileArc=on` (default off).
- **Eye-test:** arc spell lobbing over a Holtburg hill vs down a corridor; bolt straight.
- **Durable knowledge:** see memory `reference_ac_projectile_mechanics`.
- **Commit:** `feat(holtburger-web): wave R3.C — projectile mechanics fidelity`.

---

## Wave R4 — fidelity nits (opportunistic, any agent with slack)

Small, low-risk, parallel-safe. Capture them so they're not forgotten; none are blocking.

- **R4.a — TexMerge composite refinements.** The composite itself **already ships** (applied at
  `terrain.js:942-959` behind `?texMerge`; do NOT re-do it). Retail adds two details the port
  may skip: mid-point alpha rounding `if (a > 0x80) a++` and the explicit `all-road` corner
  case. Sources: `acclient.c:365632` (`ImgTex::MergeTexture`), Chorizite `FindRoadAlpha`.
  Surface: `terrain_merge.rs` + `terrain.js` shader. *(Conflicts with R1.A's shader edits —
  schedule after R1 merges.)*
- **R4.b — Sky-object live luminosity.** Stars/moon brightness fade per time-segment
  (`acclient.c:303101-303128`); partially covered by existing time-of-day star modulation —
  verify and close the gap. Surface: `atmosphere_sky.js` / `ac_moons.js`. *(Conflicts with R1.C
  only at the SkyState boundary; otherwise disjoint.)*

---

## Reference-source truth table (recap — full version in the handoff §1)

| Source | Path | Use for |
|---|---|---|
| **acclient.c** | `~/ac-headers/acclient.c` (31 MB) | behavioral truth — grep symbol, read the line region |
| **acclient.txt** | `~/ac-headers/acclient.txt` (82 MB) | cvdump symbols — find exact class/method name first |
| **acclient.h** | `~/ac-headers/acclient.h` | structs/enums (`TerrainTex`, `SurfaceType`, blend modes) |
| **ACE** | `~/ace-server/Source/` | full physics port — `Physics/{Common,Animation,BSP}`, `Trajectory.cs`, `Sphere.cs`, `AFrame.cs` |
| **Chorizite** | `external/chorizite/Chorizite/Chorizite.Core/Render/` | terrain render layer — `TextureMergeInfo`, `VertexLandscape`, `TerrainTex.cs` |
| **melt** | `external/melt/Source/` | DAT loader — `FileTypes/*`, `Entity/{LightInfo,Polygon}.cs`, `misc/*Tools.cs`, `DxtUtil.cs` |
| **DatReaderWriter** | `external/DatReaderWriter/` | record shapes — but acclient wins on widths/counts |

**Precedence:** acclient.c > ACE > DRW for exact arithmetic, scalar widths, vector-vs-scalar,
align-pad. (e.g. TexMerge PRNG: acclient's 32-bit unsigned wrap is canonical, NOT ACE's `long`.)

---

## Appendix A — how this backlog was built (provenance)

2026-05-28: 7 parallel Explore agents mined the six reference sources + mapped the live
renderer's current math coverage. The coverage map subtracted everything already shipped —
which removed two items the source-mining agents ranked #1 (the **TexMerge pixel composite**,
already applied at `terrain.js:942-959`, and the **12 particle physics modes** + emission cone,
fully ported in `scene3d/particles/`). The survivors are the tasks above.

## Appendix B — already shipped / verified-present — do NOT propose

Confirmed implemented in the renderer (file:line in the coverage map; don't re-litigate):

- **Terrain texturing:** TexMerge selection PRNG **and** pixel composite (exact, `terrain.js:942-959`,
  `?texMerge`); per-overlay alpha-mask rotation; road alpha (`terrain.js:1031-1046`); detail
  texture (`?terrainDetailTex`); minimap-palette tint (`?terrainPalette`); vertex **brightness**
  modulation (`?terrainMod`) — **sat/hue is R1.A, the only open terrain-color channel**.
- **Terrain geometry:** Catmull-Rom bicubic subdivision + per-code value-noise
  (`terrain_subdiv.rs`); THREE-computed per-vertex normals; water/lava sum-of-sines
  displacement. **Per-cell diagonal split is FIXED — that's R1.B.**
- **Lighting:** sun directional light (exact AC heading/pitch→dir, `sun_direction.js:49-88`);
  hemisphere + ambient probe; hand-rolled 3-cascade CSM with texel-snap; per-SetupModel
  point/spot lights. **Entity SetLight lights are R2.A; per-RGB clamp is R2.B. SSAO is absent
  (not proposed — screen-space, not retail math).**
- **Surface/material:** T/L/D float application; additive/alpha/InvAlpha blend modes; emissive
  via `emissiveIntensity`.
- **Animation:** multi-AnimData concat + per-frame `frameTimes` (reverse-framerate); discrete
  keyframe snap + hand-rolled per-part slerp tweens; SetOmega angular velocity (exact);
  heading angle-normalization. `cycleTimeScale` exists but is unwired **and the velocity premise
  was FALSIFIED — do not revisit.** **Dead-reckoning is absent — that's R3.A.**
- **Atmosphere:** Bruneton precomputed scattering + aerial perspective; AGX tonemapping;
  sun/moon at compressed game time; procedural hash star field; distance fog. **Fog *color* is
  static per-DayGroup — time-of-day color lerp is R1.C.**
- **Particles:** all 12 ParticleType physics modes; quaternion angular velocity; emission-cone
  distribution (`getRandomOffset`); scale/opacity-over-life lerp; birthrate/budget throttling.
- **Culling/LOD:** THREE frustum cull; per-poly backface cull (default on); entity LOD via
  despawn/respawn (`?dynLod`). BSP is absent (cells use portal graphs by design).
