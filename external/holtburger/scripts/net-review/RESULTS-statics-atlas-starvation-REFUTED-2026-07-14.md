# RESULTS — the "statics atlas-starvation" lead is REFUTED. The real lever is static particle billboards.

**Date:** 2026-07-14 · **Box:** wbterminal laptop → 1070 (tailscale, CDP :9333) · **Measured on the REAL GPU**
(`UNMASKED_RENDERER = ANGLE (NVIDIA GeForce GTX 1070 … Direct3D11)`; the `cdpwbclaude` headless task still
picks the NVIDIA adapter — `--enable-unsafe-swiftshader` is only a *fallback* permit, not a force).
Supersedes §2 of `HANDOFF-perf-statics-atlas-starvation-2026-07-14.md`. Tree left clean (all diagnostics reverted).

---
## 0. TL;DR
- **The ⭐ open lead was a MEASUREMENT ARTIFACT.** There is no atlas starvation. With static particle
  scripts off, the count of "eligible individual statics" is **exactly 0**. Every one of the
  "~1000-1066 eligible statics bypassing the atlas" was a **particle billboard**, not a static.
- **The static atlas is HEALTHY** and needs no routing fix. Its counters are *byte-identical* whether
  particles are on or off (`atlased=160 nodesIn=298 atlasBakedLbs=45 ptFiltered=0`, buckets=22, full=0).
- **The REAL lever (bigger than the phantom one): static `default_script` particle billboards are
  ~78% of the town frame's draw calls.** Cragstone A/B: **808.3 → 181 draws/frame** (−627) with
  `?staticScripts=off`. Each live particle is its own 6-vert `MeshBasicMaterial` quad with
  **`frustumCulled = false`** → it submits a draw call every frame no matter where the camera looks.
- The handoff's "the bake runs in the bake worker" conclusion is **also wrong** (see §3) — `bake_worker.js`
  never touches THREE. That false premise is what sent the last session chasing the wrong instance.

## 1. THE MEASUREMENT (Cragstone, real GPU, `buildingBatch=off` to isolate statics)
| | A: default (particles ON) | B: `staticScripts=off` |
|---|---|---|
| draws/frame | **808.3** | **181** |
| individual static meshes | 330 | **18** |
| **"eligible" (census metric)** | **312** | **0** |
| batched nodes | 458 | 458 |
| atlas atlased / nodesIn / atlasBakedLbs | 160 / 298 / 45 | 160 / 298 / 45 |

- `eligible → 0` in arm B is the whole proof. The census's `eligible` counter was **counting particles**.
- The residual **18** individual statics = `perLb-atlasPassthrough`, all `ptDeformed` — wind-sway foliage
  (`deformation.windSwayGpu`), which the atlas passes through **on purpose** (`static_atlas.js:412-421`;
  batching them strips the sway → the 2026-07-02 "trunk sways, foliage frozen" bug). Correct as-is.
- Atlas columns identical across arms ⇒ particles never touched the atlas; nothing to unstarve.

## 2. WHAT THE "ELIGIBLE STATICS" ACTUALLY ARE
Fingerprint of all 700 unstamped "eligible" meshes at steady state:
```
688 x  verts=6 transparent=true blending=2(Additive) depthWrite=false MeshBasicMaterial frustumCulled=false
 12 x  verts=6 transparent=true blending=1(Normal)   depthWrite=true  MeshBasicMaterial frustumCulled=false
```
Textbook billboards. Provenance: `particles/particle_emitter.js:381` `emitParticle()` → `this._scene.add(mesh)`,
and for static `default_script` chains **`this._scene` IS `scene3d.staticsGroup`** (stated outright at
`statics.js:~464`: *"the static ParticleManager's scene = scene3d.staticsGroup"*). So **one Mesh per live
particle** is parented directly under `Group(statics)` — fountains/braziers/torches from `attachStaticDefaultScripts`.

They are "eligible" only because the census gate (uv + map + `image.data` + not-LOD/deformed/`__staticBatch`)
describes a *textured quad*, which a particle trivially is. They must **never** be atlased (per-frame
position/visibility; additive, depth-sorted).

**This also solves the handoff's "draw counts swing 279↔1850 at the SAME POI" mystery.** It is not
"atlas-consumption state" — the live particle count keeps climbing as emitters spin up (I measured the same
scene at 166 → 312 → 532 → 700 individual meshes on four successive runs). Draw counts move with it.

## 3. CORRECTIONS TO THE PRIOR HANDOFF (don't re-inherit these)
- ❌ *"The bake runs in the bake worker, which imports its OWN instance of the scene3d modules."*
  **False.** `bake_worker.js` imports only wasm decode fns (`fetch_model_meshes`, `fetch_surfaces_pixels`, …)
  + `bake_transfer.js` serializers. It contains **no THREE, no staticsGroup, no atlas**. The whole
  scene-graph bake is main-thread. (`rg -n 'staticsGroup|Atlas|THREE' scene3d/bake_worker.js` → 0 hits.)
- ❌ *Why the last session's counters read zero* — nothing to do with workers:
  - the counter at `~2790` sat on the **`else` of `if (statAtlasEnabled()) ringSingletons.push(node)`**,
    and `?statAtlas` is **default-ON** → that else is dead code in the default config;
  - the counter at `~2210` is the **per-LB walk-in** path, ~silent at a teleport-in town where the **ring**
    path does the baking.
  Both zero, no worker required.
- ❌ *"only 49 of ~121 resident LBs ever feed the atlas"* → not starvation. `_atlasBakedLbs` only records LBs
  that landed **≥1 successful** atlas node (`static_atlas.js:480,492`); LBs with no atlasable singleton never
  join. 45/121 is the expected shape, not a leak.
- ✅ Still true: `?buildingBatch` default-ON shipped fine; capacity is not the limit (`full=0`).

## 4. THE ACTUAL NEXT LEVER — batch/cull static particle billboards
Sizing bound: **−627 draws/frame (78%) at Cragstone.** `?staticScripts=off` is the *measurement*, not the fix
(it deletes the fountains/braziers/torches). Real work, in increasing order of payoff:
1. **`frustumCulled = false` on every particle** (`particle_emitter.js`, and the anim-scenery buckets at
   `animated_scenery.js:500` do the same). A brazier behind the camera still costs a full draw. Culling
   per-emitter (not per-particle) is the cheap, safe first cut — bound it by the emitter's radius.
2. **One InstancedMesh (or Points) per (emitter × texture)** instead of one Mesh per particle — the
   `_getOrCreateBucket` pattern already proven for anim-scenery (`animated_scenery.js:489-510`, InstancedMesh
   + `DynamicDrawUsage` + slot registry) ports over almost directly. This is the retail shape: retail drives a
   particle system per emitter, not N scene nodes.
3. Ship behind a default-off flag; validate with the A/B below + a 62-town walk before flipping.
Respect `vfx-write-invariant`: FX may write render transforms / cloned uniforms only — never light count.

## 5. HOW TO RE-RUN (harness that produced this)
The route/fingerprint probe lives in scratchpad (`route-census.mjs`) — it stamps `userData.__addRoute` at every
`staticsGroup.add` site, then attributes surviving individual meshes at **snapshot** time (immune to the
cumulative-vs-snapshot trap that `__atlasStats()` counters have — those tally the whole session incl. evicted LBs,
which is why `ptDeformed=138` cumulative vs `deformed=18` resident looked contradictory).
```
# 1070 chrome (headless, muted, real GPU): schtasks /run /tn cdpwbclaude   (task -> C:\Temp\launch-claude.bat)
#    then CDP is at 127.0.0.1:9333 via the existing -L 9333 / -R 8765 tunnel.
cd $REPO/external/holtburger/scripts/net-review
CENSUS_ONLY=1 EXTRA_QUERY="buildingBatch=off"                    POI=Cragstone node steadyframe-sizing.mjs /tmp/a.json
CENSUS_ONLY=1 EXTRA_QUERY="buildingBatch=off&staticScripts=off"  POI=Cragstone node steadyframe-sizing.mjs /tmp/b.json
```
**Gotcha that cost me two runs:** the harness leaves its page open on abort, and a second `tailnet1` login is
rejected while the old session lives. Close stale pages via `/json/close/<id>` and wait ~30s between arms.

## 6. RECOMMENDED FOLLOW-UP FIX TO THE HARNESS
`steadyframe-sizing.mjs` `staticCollapse()` must not count particles as batchable statics, or this phantom
lead regenerates. Cheapest correct gate — skip billboards before the eligibility ladder:
```js
if (o.frustumCulled === false && o.material?.depthWrite === false) return;  // particle billboard
```
Better: stamp `userData.__particle = true` in `particle_emitter.js` and skip on that (explicit > inferred).

## 7. RAW DATA
`/mnt/wbterminal2/tmp/arm-particles-ON.json`, `arm-particles-OFF.json`, `route-census{,2,3,4}.json`,
`statics-only.json` (+ `statics-only.png`). Console at steady = 404 partial-world noise only (serve.py
`--allow-missing`); no PAGEERROR/TypeError in any arm.
