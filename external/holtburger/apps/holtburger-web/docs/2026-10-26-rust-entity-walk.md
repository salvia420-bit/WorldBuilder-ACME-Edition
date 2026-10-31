# Lane R4 — what the entity rigs cost per frame, and how to cut it exactly (2026-10-26)

> **DELETED 2026-10-30.** `?rustEntityWorld` lost tour fps on the 1070 decision bench D1 (batch-R3-D1: still / moving / tour -0.1 / +0.7 / -1.8 fps vs defaults, the tour loss real under R1) and improved no fps segment, so its code (scene3d/entity_world.js, the index.js / entities.js wiring, tests/rust_entity_world.test.mjs) was removed per the plan's M1b-STRUCTURE rule. This document stays as the record of the lane.

Part of the Rust scene core effort: [2026-10-26-rust-scene-core.md](2026-10-26-rust-scene-core.md) (plan, §3 contract).
Builds on lane B ([2026-10-26-rust-rig.md](2026-10-26-rust-rig.md)), lane X
([2026-10-26-rust-draw-exec.md](2026-10-26-rust-draw-exec.md)), R3
([2026-10-26-rust-draw-list-design.md](2026-10-26-rust-draw-list-design.md)) and R2
([2026-10-26-rust-residency-design.md](2026-10-26-rust-residency-design.md)).

Evidence tags: **[M-node]** measured in node 20 / V8 on this laptop (i5-6300U, 2 cores / 4 threads, shared with the
other lanes all day), **[C]** code read, **[D]** derived. Nothing here ran in a browser, under cargo or wasm-pack, or on
the 1070 (laptop rule).

## 0. Answer

| Question | Answer |
|---|---|
| What do the rigs cost today (defaults: `?rustRig`, `?rustEntityCull`, `?drawExec` + `?drawExecRigs` on, `?rigMeshAlias` off)? | At a Holtburg-shaped world (19 visible rigs, 485 visible entity nodes, 236 visible part meshes — today's laptop census) [M-node]: matrix walk **231 µs/frame** (477 ns per visible entity node), projectObject **344** (710 ns per node, 1.46 µs per visible mesh), sort **122** (250 ns per node), draws **1,471** (6.2 µs per visible mesh). The scene walk (walk + projectObject + sort) is ~700 µs, the draws ~2× that. §1. |
| (a) Rust-written world matrices — exact, worth it? | **No.** Built as JS models of the kernel and measured: Rust computing the matrices and JS copying them into three's arrays is *slower* than three's walk (+26%); matrices whose `elements` ARE views on the kernel's buffer save 9% of the walk but cost as much again in three's typed-array-polymorphic paths (draws +35 µs), and on the real wasm memory those views detach whenever any wasm call grows it. Per node, three's walk is the stores into each node's own matrix arrays plus generic dispatch; Rust can take only the arithmetic, the cheap part (lane B's finding, re-measured in a megamorphic Holtburg-shaped world). §2. |
| (b) Rigs off the scene graph — exact, worth it? | **Yes, as a projection stand-in.** The rigs stay in the graph (every reader, the shadow pass, picking, film keep working); only three's `projectObject` over the rig subtrees is replaced, for the main scene, by a rig-aware pass that pushes the same render items at the same pre-order positions. The GL call stream, `renderer.info` and the sorted render lists are identical to stock frame by frame (§3, §6). |
| What shipped | `?rustEntityWorld` (DEFAULT OFF; `scene3d/entity_world.js`): the projection stand-in **plus** a rig-aware matrix walk (an own `updateMatrixWorld` on each rig root, three's math inlined, identity meshes by copy, exact). JS only — the measured Rust variants lose (§2.1). The projection is installed by an explicit line in `scene3d/index.js` (2026-10-29, §11: before that only the walk half ran in the client). |
| Gain [M-node] | Entity matrix walk **−30…−36%**, entity projectObject **−23…−28%**, the entity scene walk (walk + projectObject + sort) **−23…−26%** — **195–250 µs/frame** at the Holtburg-shaped world. Draws unchanged. 1070 estimate [D] §1.4: ~0.1–0.25 ms/frame. |
| Non-exact, estimate only | (c) per-(entity, material) merged draws: −30…−40% entity draws, ~0.3–0.4 ms/frame; (d) per-entity texture arrays: −85…−90% entity draws, ~1–1.7 ms/frame; both change draw order inside an entity and (d) resamples textures. §7. |
| Recommendation | Keep `?rustEntityWorld` off until a 1070 A/B confirms the node gain survives Chrome (§8); it is exact by construction and proven, so the default flip is a measured-gain decision only. The draws (2× the scene walk) are the larger prize and need (c)/(d) — owner-gated, eye-test class. |

## 1. Today's per-entity-node cost [M-node]

### 1.1 The harness

`node tests/rust_entity_world.test.mjs --bench` (the suite's bench mode; scratch originals in `/mnt/wbterminal1/tmp/claude-scratch/rustcore-2026-10-26-scratch/r4/`):

- three r184's real `WebGLRenderer` over `tests/helpers/fake_webgl2.mjs` as a plain object, with every production
  renderer patch in `scene3d/index.js` order: reversed-Z, `installUniformBindPatch` (texUnitPin, lightUploadOnce,
  lightUbo), the program sort with the punch phase, depth bands (0 bands/octave, the default), async_link_guard,
  skip_empty_multidraw, batched_runs, and the draw executor with `rigs` (today's default). `skip_hidden_matrix`
  installed. After warm-up the hot uniform / texture / program GL entry points are no-ops (lane X's method), so the
  draw numbers are three + wrapper + executor JS only.
- The world: a Holtburg-shaped scene — lights (8 point), worldRoot (−π/2) with 120 BatchedMesh chunk buckets on 20
  class materials (runs), 90 plain statics on 30 materials, 6 LODs, 10 InstancedMeshes, 300 hidden frozen groups,
  8 cell containers (80 cell statics, layer 1), 10 buildings, terrain + 10 far patches; and **49 rigs: 19 visible**
  (9 humanoids of 17 parts, 6 creatures of 9, 4 items of 2; 1–2 surfaces per part, ~6% of surfaces hidden
  (`materialRendersNothing`), a nameplate Sprite per humanoid / creature, a visual-ground own `updateMatrix` on every
  root, per-entity materials shared ~35% within a rig, part geometries shared per setup) **and 30 hidden** (render-culled
  roots). Census: 485 visible entity nodes, 236 visible part meshes — today's laptop Holtburg census reads 19 rigs,
  455 visible entity nodes, 176–208 drawables (`rust-boot-smoke-rc-bare-holt-r1/drawlist-census.json`).
- Per frame (untimed): raw part poses (as `?rustRig` writes them), root moves, an orbiting camera.
- Phases (timers outermost): **walk** = `scene.updateMatrixWorld`; **proj** = end of the walk → `list.finish()` (camera
  update, every `scene.onBeforeRender` hook, render state, frustum, `renderLists.get`, projectObject); **sort** =
  `list.sort`; **draw** = end of the sort → end of `render()`.
- Arms in ONE process: `none` (every rig hidden), `stock`, and the flag arm; short blocks in rotated order, medians of
  the per-round differences. Entity cost = stock − none; a variant's gain = variant − stock.
- **Build-order bias.** The world built last measures ~10% faster (heap placement): an A/A control (two stock arms)
  read −13% / +8% on walk + proj + sort depending on which was built first. Every comparison is therefore run twice,
  once in each build order, and averaged; the A/A residual after averaging is ~1–3% (the noise floor here).
- The laptop was shared with other lanes' suites and the orchestrator's builds; runs waited for the builds cgroup to be
  empty, and the numbers below are from the quietest windows. Absolute µs move ±20% with the load; the paired
  differences are what the conclusions rest on.

### 1.2 Numbers

Entity cost = the `stock` arm − the `none` arm (rigs hidden), µs per frame; per visible entity node (485) or per
visible part mesh (236).

| Phase | Quiet window (20 paired runs) | per visible entity node | Final-code runs (14 + 6 paired runs, partly loaded) |
|---|---|---|---|
| matrix walk (`scene.updateMatrixWorld`) | 231 | 477 ns | 270–283 |
| projectObject (+ render state, frustum, hooks) | 344 | 710 ns (1.46 µs per visible mesh) | 414–419 |
| sort | 122 | 250 ns | 150–158 |
| **scene walk** (the three above) | **697** | **1.44 µs** | 834–860 |
| draws (renderObject + the executor) | 1,471 | 6.2 µs per visible mesh | 1,696–1,714 |
| whole `render()` | 2,169 | | 2,542–2,566 |

Where it goes inside (CPU profile, the entity share = stock − none, one loaded pair of runs) [M-node]:
- matrix walk: `updateMatrix` (compose) + `multiplyMatrices` ~57%, the visit (skip_hidden's wrapper,
  `updateMatrixWorld`, the scene wrapper) ~43%;
- projectObject: its own body (visible / layers / type ladder / push / recursion) ~68%, the frustum test ~19%,
  `WebGLObjects.update` ~12%;
- sort: three's `sort` + `programSortStable` (the `?hotDrawSort` memo);
- draws: the material-switch work — `setProgram`, `refreshUniformsCommon`, `markUniformsLightsNeedsUpdate`,
  colour conversions, the upload walk — then `setValueM4` / `setValueM3` (per-draw matrices), three's
  `renderBufferDirect` and the executor's record checks.

What `?rustEntityWorld` takes off (variant − stock, both build orders averaged) [M-node]:

| Arm | matrix walk | projectObject | sort | scene walk | whole `render()` |
|---|---|---|---|---|---|
| walk + projection (scratch paired bench, 2 × 50 rounds) | −113 (−36%) | −133 (−28%) | −6 | **−252 (−26%)** | −361 |
| walk + projection (the suite's `--bench`, 2 × 50 rounds) | −90 (−32%) | −102 (−24%) | −3 | **−195 (−23%)** | −186 |
| walk only | −63 / −86 (−24% / −30%) | ≈ 0 | ≈ 0 | −9…−11% | |
| projection only | ≈ 0 | −90 / −95 (−26% / −23%) | ≈ 0 | −9…−13% | |
| A/A control (a second stock arm) | +20 | −14 | 0 | +1% | +3 |

(The whole-`render()` column also carries the draw phase's noise, ±50 µs.)

### 1.3 What the per-node cost is made of [M-node, CPU profiles]

- **Walk.** Per visible rig node three runs skip_hidden_matrix's wrapper → `Object3D.updateMatrixWorld` → the node's
  `updateMatrix` → `Matrix4.compose` → `multiplyMatrices`, every property access at call sites that see every class
  in the scene (megamorphic). Profile split of the walk: ~60% compose + multiply (the arithmetic and the 32 stores
  into the node's own `matrix` / `matrixWorld` arrays), ~40% the visit (dispatch, flags). Hidden rigs cost one check.
- **projectObject.** Per visible rig node: the `visible` / layers / type ladder; per mesh additionally the frustum test
  (`intersectsObject`: sphere × matrixWorld, 6 planes), `WebGLObjects.update` (WeakMap lookups per geometry and per
  attribute), the z key (two `applyMatrix4`) and the push. ~0.7 µs per visible entity node, ~1.4 µs per visible
  mesh; per-mesh work is memory-bound (each mesh touches ~10–15 objects).
- **Sort.** ~0.25 µs per entity node (~0.5 µs per entity render item): the items join three's sort (with
  `?hotDrawSort`'s memo).
- **Draws.** ~6.2 µs per visible mesh with the executor: nearly every entity draw is a material switch (per-entity
  materials, 111 materials over 176 meshes in today's census) — setProgram's refresh + upload walk (R3 §2).

### 1.4 Scaling to the 1070 [D]

The 1070 profiles of 10-23 (old stack) put the whole scene walk at 2.54 ms/frame with entity rigs 52–66% of its nodes;
today's laptop census has 455 visible entity nodes of ~1,590 visible nodes. In node the entity scene walk is
~1.4–1.7 µs per visible entity node; the 1070's CPU runs V8 roughly 1.5–2× faster than this laptop. At ~450–900 visible
entity nodes that is ~0.35–1.0 ms/frame of entity scene walk on the 1070, and `?rustEntityWorld`'s −23…−26% of it is
**~0.1–0.25 ms/frame** — measure before deciding (§8).

## 2. (a) Rust-written world matrices — prototyped, measured, not built

### 2.1 The variants [M-node, paired, both build orders]

Each is a per-root own `updateMatrixWorld`; the "kernel" is the JS model of what the Rust kernel would compute (three's
compose / multiply in the same operation order — wasm f64 arithmetic is no faster than V8's optimised JS for this). All
were checked bit-exact against three's walk (every node's matrices + flags, and the full GL stream) before timing.

| Variant | What JS does per rig node | Entity matrix walk | Other phases |
|---|---|---|---|
| `kernel` — Rust computes into its buffer, JS copies back into three's arrays | gather 10 inputs + scatter 32 values | **+60 µs (+26%)** | — |
| `views` — each node's `matrix.elements` / `matrixWorld.elements` IS a Float64Array view on the kernel's buffer (no copy) | gather 10 inputs | −21 µs (−9%) | draws **+35 µs**: three's Matrix4 / Vector3 / uniform paths now see Float64Array and Array elements (polymorphic) |
| `batch3` — three's own compose / multiply, called from a per-rig loop (no generic dispatch) | — | 0 | — |
| `fast` — the same loop with compose / multiply inlined and identity meshes by copy (**built**, §4) | — | **−63 µs (−28%)** | — |
| `fastNoIdent` — `fast` without the identity copy | — | −51 µs (−22%) | — |
| `alias` — lane B's `?rigMeshAlias` (reference; not exact between walks) | — | −70 µs (−32%) | — |

### 2.2 Why Rust cannot win here

- Under three's object model every node owns its `matrix` and `matrixWorld` arrays and every reader reads them. Any
  design that keeps three's objects must store 32 values per node per walk, in JS, or alias the arrays.
- Moving the arithmetic to Rust adds a gather (10 values per node into wasm) and either a scatter (the stores again)
  or views. The arithmetic is the cheap part; the stores and the per-node dispatch are the cost, and only the
  dispatch is removable — the `fast` walk removes it in JS.
- **Views are not safe on the real memory.** `memory.grow` (any wasm call that allocates: the net drain, physics,
  every scene kernel) detaches every view. Readers run between any wasm call and the next walk: the partFrames proxy
  right after the net drains, picking in DOM events, `Box3.setFromObject` in the visibility tick, the gate's
  `updateWorldMatrix`. A detached view reads `undefined` → NaN matrices; writes are lost. There is no growth event to
  re-point on, and no "stable allocation": an address that never moves still lives in an ArrayBuffer that is
  replaced. A fixed-size second `WebAssembly.Memory` would need a second wasm module outside the pkg architecture.
  A JS-owned arena with one bulk copy per walk avoids the detach, but keeps the polymorphism penalty measured above.
- The brief's other hazards, for the record: the refreshing readers (Box3, picking, rig radius, shadow-only casters,
  fx_ribbons, weapon_fx, partFrames) all write through three's code into whatever `elements` is — fine for views,
  fatal once detached; `clone` / `copy` copy values (fine); skip_hidden_matrix must be mirrored (the `fast` walk does);
  `?rigMeshAlias` shares a part's Matrix4 (the two cannot both own it); hidden parts, held items (nested rig roots) and
  dismember / reparent need slot bookkeeping on `childadded` / `childremoved` — and a debris mesh leaving a rig with
  its `elements` still a view on a reused slot would be corrupted silently.

### 2.3 What did win

The `fast` walk: no Rust, no views, three's own arrays, exact by construction (§4). Built as the walk half of
`?rustEntityWorld`.

## 3. (b) Rigs off the scene graph — the projection stand-in (built)

### 3.1 Why not literally off the graph

Taking the rig meshes out of the scene would break every reader that walks the graph or the parent chain: the shadow
pass (`WebGLShadowMap` / `shadow_caster_list.js` walk the scene), picking (`intersectObjects`), `Box3.setFromObject`,
the draw executor's root classification (`__hbDx`), the punch phase (`_punchPhase` walks parents), film / drone,
dismember, the partFrames proxy, the walk itself. And three's `WebGLObjects.update` (the per-mesh geometry upload
check) is reachable only from `projectObject`. So the rigs stay in the graph and only three's `projectObject` over
them is replaced, for the main scene's renders, for the duration of `projectObject`.

### 3.2 Mechanism (`scene3d/entity_world.js`, `installEntityWorld`)

- `scene.onBeforeRender` notes the render's camera. three's `renderLists.get(scene, depth)` — called after the camera,
  `_projScreenMatrix` and `_frustum` are final and directly before `projectObject(scene…)` — swaps the entities
  group's `children` for a stand-in: one **RigPusher** per visible real child, in order (projectObject returns at once
  for a hidden child, with no side effect). `list.finish()` (called directly
  after `projectObject`) puts the real array back; a `renderer.render` `finally` and the next `renderLists.get` do so
  too if a throw inside `projectObject` skipped `finish`. The same restore empties the stand-in pool — RigPusher
  targets and hot nodes, Carrier slots, SegPusher items — so no despawned rig stays reachable from it (2026-10-29,
  §11.2; stock's `list.finish` nulls its inactive render items the same way).
- three's `projectObject` reads a node's `visible` first. A RigPusher's `visible` getter runs `projectObject` over its
  rig in JS — three's exact rules: `visible` → stop; `layers.test` → a Group sets the groupOrder; the frustum test
  with a `THREE.Frustum` built from the same matrix by the same call — and returns true with its `children` set to the
  rig's **hot** nodes in pre-order, interleaved with **SegPushers**.
- A SegPusher's `visible` getter pushes its run of **cold** meshes into the render list —
  `list.push(mesh, geometry, material, groupOrder, z, null)` through the list's own (reversed-Z-wrapped) `push`, z
  from `boundingSphere.center` × `matrixWorld` × the projection matrix with three's `Vector4.applyMatrix4` — and
  returns false. So every push happens at the pre-order position where three would push it.
- **Cold**: a plain leaf Mesh (not skinned / instanced / batched, no children, one material, no own bounding sphere)
  that passes `visible` / `layers` / frustum and whose geometry three's `WebGLObjects.update` has already brought
  current: the module noted it at a hot visit **and confirmed it at a second hot visit at another
  `info.render.frame` value that saw the same attribute objects at the same versions** (2026-10-29, §11.3: three's
  update is memoised once per frame value and a shadow raster runs it after `frame++`, so one hot visit proves
  nothing), and it still holds the same attribute objects at the same versions in the same key order, was not
  disposed since, and no context restore / new render lists happened since. `WebGLObjects.update` is then a no-op (r184: `geometries.get` finds the geometry registered; `geometries.update`
  iterates `geometry.attributes` and `WebGLAttributes.update` finds `data.version === attribute.version` for each), so
  it is skipped — the one piece of three's per-mesh work not recomputed. The record lives on the geometry (three keys
  its work by geometry) and is validated once per geometry per render.
- **Hot**: everything else — lights (their push order is the light order), sprites (nameplates), first sights and
  changed / swapped / disposed geometries, SkinnedMesh / InstancedMesh / multi-material meshes, meshes with children,
  held items (nested rigs), anything not a plain Group part. Handed to three at its pre-order position; a hot node
  whose real groupOrder differs from the entities group's rides in a **Carrier** (a Group-shaped node with that
  renderOrder) so three gives it the same groupOrder.
- Off for: other scenes, `renderer.sortObjects !== true` (three then pushes a stale z), XR presenting, a render
  whose `scene.onBeforeRender` did not run, the live seam `__entityWorld.projOff`, and premise drift.

### 3.3 Exactness argument

1. **Same pushes, same order.** For every node of the rig subtree the stand-in reproduces projectObject's decision
   with three's own predicates and math (`visible`, `Layers.test`, `Frustum.intersectsObject`, `Vector4.applyMatrix4`)
   on the same inputs at the same moment (inside the same `projectObject` traversal, at the entities group). Cold
   pushes happen at their pre-order positions (segments), hot nodes are visited by three at theirs. So the render
   list's input arrays — items, order, pooled render-item assignment — equal stock's, and with them the sort output
   even when three's comparator is inconsistent (NaN z from a NaN pose: equal keys up to z, then `NaN` →
   input order decides; tested).
2. **Same side effects.** projectObject's other effects are: `pushLight` / `pushShadow` (lights are always hot),
   `LOD.update` (hot), `computeBoundingSphere` (our frustum test calls the same function at the same point; a null
   sphere is never cold), `WebGLObjects.update` (skipped only when it is a no-op, above; hot meshes keep it, so every
   upload happens at its stock position in the GL stream). Why two hot visits: `WebGLObjects.update` runs
   `geometries.update` only when its memo differs from `info.render.frame`, and render() runs the shadow pass after
   `frame++` — so after a raster, the next render's first visit to a caster's geometry uploads nothing (stock too),
   and a change made between the two renders reaches the GPU one render later. A note made there would claim
   "current" for versions three never uploaded. The second visit at another frame value is current: its update either
   ran (memo older) or was memoised by a call made after the first note — a raster of a later render, which uploaded
   those same attributes (§11.3 has the argument and its one formal limit).
3. **groupOrder.** Computed as projectObject does: the value three passes into the entities group's children (from the
   scene down), each Group that passes its layers test replacing it with its renderOrder. Hot nodes needing another
   value get a Carrier.
4. **Nothing else runs inside the window.** Between `renderLists.get` and `finish` three runs only `projectObject`;
   the shadow pass, transmission, background, the draws and every hook run after the restore.
5. **Premises** (the code three must have for 1–4): projectObject's head, mesh branch and children loop, and render()'s
   order — onBeforeRender → frustum → renderLists.get → projectObject → finish — are checked against the installed
   three's `WebGLRenderer` source at install (`PROJECT_PREMISES`; drift refuses the install). The closure bodies it
   cannot read at run time — `WebGLObjects.update`, `WebGLGeometries.get` / `update`, `WebGLAttributes.update`'s version
   test — are checked against three.module.js by the suite.

### 3.4 Hazards checked (each a suite scenario, §6)

Shadow pass (CSM / `shadow_caster_list` walk the real graph after the restore), indoor split (two renders, layer
masks, nodes on the other layer than their root), raycasts / picking (never inside the window), film (cameras and
layer masks are per render), `onBeforeRender` hooks (run in renderObject, after the window; a nested render inside one),
transparent / fading parts (cold pushes route by material flags like three's), `material.visible`, hidden roots /
parts / meshes, renderOrder on parts / roots / the entities group, debris meshes under the entities group, rigs added
and removed, geometry events (version bump, attribute replaced / added / deleted — on a clone and in place —, geometry
swapped, disposed while drawn and redrawn, null bounding sphere), context loss + restore, ArrayCamera, the live seam,
`sortObjects` off, a throw inside projectObject; gated shadow rasters (`shadowMap.autoUpdate` off, as lighting.js's
RP5 gate) with a dispose / version bump right after a raster, a sibling of another program sharing the disposed
geometry, a bump + a throw right after a raster (2026-10-29); despawned rigs collectable (Part L, 2026-10-29). The occlusion proxies are not under the rigs (the rig's occlusion box
comes from `Box3.setFromObject` in the visibility tick, outside the window).

### 3.5 Where Rust would fit — and why not now

The cold path's arithmetic (frustum test, z) needs each mesh's world matrix. In wasm that means copying 16 values per
mesh in, which costs about what the arithmetic costs in JS; only if the matrices already lived in Rust (§2, not viable)
would a Rust cull pay. The remaining cost is memory traffic over three's objects, not math.

## 4. The walk half — exactness argument

`installEntityWorldRoot(root)` (from the rig build in `entities.js`) gives an entity rig root an own `updateMatrixWorld`:

1. **The root**: three r184's body verbatim, after skip_hidden_matrix's rule (`skipHiddenWalkMode()`, a new read-only
   export: inside a scene walk with skipping on, a hidden node with a parent is marked stale and not walked). Its own
   `updateMatrix` (visual ground) is called exactly as three calls it.
2. **Plain Group parts** (prototype `updateMatrixWorld` / `updateMatrix`) and **plain leaf meshes** under them: three's
   body with `Matrix4.compose` / `multiplyMatrices` inlined operation for operation (premises: the installed three's
   source text, `WALK_PREMISES`), the same flags (`matrixAutoUpdate`, `matrixWorldAutoUpdate`,
   `matrixWorldNeedsUpdate`, pivot → three's own `updateMatrix`), the same skip rule, the same order.
3. **Identity copy.** A leaf mesh whose local transform is exactly position (+0,+0,+0), quaternion (+0,+0,+0,1), scale
   (1,1,1), no pivot: three composes the exact identity I (all products are of +0, sums exact) and multiplies P × I.
   Each output element is P[i][j] + Σ(±0) in three's evaluation order; that equals P[i][j] bit for bit unless P[i][j]
   is −0 (−0 + +0 = +0) or some P entry is ±Inf / NaN (Inf × 0 = NaN). So when the part's world P is **clean** (no −0,
   no non-finite entry; checked once per part), the mesh gets the identity (16 constant stores) and P by copy;
   otherwise the full multiply. (Lane B's §10.2, here without aliasing: each mesh keeps its own arrays.)
4. **Everything else** — sprites, lights, cameras (own method), SkinnedMesh (own method), held items (nested rig roots
   with their own entity walk), rigMeshAlias parts (own method), children of meshes, any own or patched matrix method
   — gets `child.updateMatrixWorld(force)` at its position in the loop, exactly as three's loop calls it.
5. **Falls back to three** for the whole root when: the live seam `walkOff`, the walk census is counting (it must count
   every node), or the prototype methods are not the ones the premises cover.

So every node's `matrix`, `matrixWorld` and `matrixWorldNeedsUpdate` hold three's values at every point in time — they
are written by the same walk, at the same moment, from the same inputs. Readers between walks see no difference.

## 5. What shipped

| File | Change |
|---|---|
| `scene3d/entity_world.js` (new) | `?rustEntityWorld`: `installEntityWorldRoot`, `installEntityWorld`, `ensureEntityWorld`, premises, diag `window.__entityWorld` (`stats()`, `walkOff`, `projOff`), test seams |
| `scene3d/entities.js` | rig build (`_spawnImpl`, after the part loop): `if (entityWorldEnabled()) { installEntityWorldRoot(root); ensureEntityWorld(this.scene3d); }` + the import (the `ensureEntityWorld` call is a no-op in the client — see below) |
| `scene3d/index.js` (2026-10-29) | `import { installEntityWorld } from "./entity_world.js";` and, right after `worldRoot.add(terrainGroup, …, entitiesGroup)` (so after `installDrawExec`): `try { installEntityWorld(renderer, () => scene, () => entitiesGroup); } catch (_) {}` — **required**; inert with the flag off |
| `scene3d/skip_hidden_matrix.js` | read-only exports `skipHiddenWalkMode()`, `skipHiddenMethod()` (the walk's state for subtree walkers); `_walkHooks.method` |
| `tests/rust_entity_world.test.mjs` (new) | the identity suite + `--bench` |

No Rust, no wasm export, no Cargo feature: the measured Rust variants lose (§2.1), so nothing is SKIPped by the suite.
The projection is installed by the explicit `installEntityWorld(renderer, () => scene, () => entitiesGroup)` line in
`scene3d/index.js` (**required**, 2026-10-29). The rig build's `ensureEntityWorld(scene3d)` cannot install it in the
client: the EntityManager is built with index.js's `scene3dForBuilders`, which has no `renderer` and no `scene` (the
`liveScene3d` / `scene3dForBuilders` dual facade), so it returns null there; it stays for harnesses that pass both.
(Before 2026-10-29 this section called the index.js line optional — wrong: in the client only the walk half ran.)

Diag: `window.__entityWorld.stats()` → roots, walks, walkFallbacks, identity, unclean, renders, rigs, rigsToThree,
cold, hot, carriers, lateRestores (must stay 0), projections (renderers with the projection installed: 1 in the client
with the flag on — 0 means only the walk runs), refused.

## 6. Tests

`node tests/rust_entity_world.test.mjs` — 98 checks (2026-10-29; 84 before), ~10 s on a quiet machine (~40 s under load):

- **P — premises / flag:** default OFF; refusal without the flag; `WALK_PREMISES` hold in the installed three; the
  `PROJECT_PREMISES` hold in `WebGLRenderer`'s source and a mutated projectObject is refused; the closure premises
  (`WebGLObjects.update` does nothing else for a plain Mesh, `WebGLGeometries.get` / `update`, `WebGLAttributes.update`'s
  version test) hold in three.module.js; a patched `Matrix4.compose` refuses the walk, the restored one installs.
  Install wiring (2026-10-29): `scene3d/index.js` imports `installEntityWorld` and calls it in a `try`, after
  `installDrawExec` and after the world groups are attached (a source check; `EW_INDEX_SRC=<file>` reads another
  copy); `installEntityWorld` with the flag off returns null and touches nothing.
- **W — the walk** (two identical worlds, every node compared with `Object.is` after every walk): poses + root moves +
  visual-ground dz; hidden root / part / mesh (moved while hidden, shown again); a direct `root.updateMatrixWorld(true)`
  outside a scene walk with a hidden part; the skip_hidden live seam off; a frozen part with −0, then NaN / ±Infinity in
  its world matrix; dislocation and heal; scale / `applyMatrix4` / Euler writes; reparent part → part, attach to the
  entities group (debris) and back, a mesh added, a part removed; flags and pivots changed; the walk census counting
  (every root handed to three); `walkOff`. Special nodes: a held item (nested rig with its own walk), a light, a camera,
  an InstancedMesh, a SkinnedMesh with bones, a mesh with a child, offset / −0-positioned / scaled meshes, pivot part and
  mesh, `matrixAutoUpdate` / `matrixWorldAutoUpdate` off, a multi-material mesh, `frustumCulled = false`, a rig of
  rigMeshAlias parts.
- **R — the projection + walk through three's renderer** (stock vs flag-on, the production patch chain incl. the
  executor with rigs; the full GL call stream with arguments, `renderer.info`, the sorted opaque / transparent lists
  (object, material, z with signed zero, groupOrder, renderOrder, group) frame by frame, every node's matrices after
  the run, the entities group holding its real children after every frame, the same frames throwing): baseline;
  geometry events; visibility + materials (incl. NaN poses arranged so the input order decides the sort); renderOrder
  on parts / roots / the entities group (carriers); indoor split with nodes on the other layer + depth bands; shadows;
  context loss + restore; `projOff` + `sortObjects` off; ArrayCamera; a nested render in an entity mesh's
  `onBeforeRender`; a throw inside projectObject; shadow memo (2026-10-29: rasters gated at R0 R1 R5 R8 with
  `shadowMap.autoUpdate` off; an entity-only caster geometry disposed and another version-bumped right after the R1
  raster, a sibling with another program sharing the disposed geometry from R4, a bump + a throw inside projectObject
  right after the R5 raster). Every scenario also checks, every frame, that the stand-in pool holds no node.
- **E — the real spawn path:** EntityManager rigs (fake wasm, 17 parts, as lane B's suite) in a flag-off and a flag-on
  manager, built with index.js's `scene3dForBuilders` shape (no `renderer`, no `scene`; 2026-10-29): the rig build's
  `ensureEntityWorld` installs nothing from that shape; index.js's line (replayed at its place) installs the projection
  only with the flag; the rig build installs the root walk only with the flag; over 33 ticks with motion changes and a
  hidden rig, GL stream, sorted lists and every node's matrices identical, and the projection ran (renders, cold > 0).
- **L — lifetime** (2026-10-29): a stock and a flag-on arm (the production patch chain), 8 rigs with nameplates, rig 0
  holding an item on a groupOrder carrier; the crowd shrinks to rig 0 and the item is dropped (surplus pushers, a stale
  carrier on a reused pusher), then the last rig goes (empty entities group: no stand-in render). WeakRefs + a full gc
  (`--expose-gc` set at run time through `v8.setFlagsFromString`): the flag-on arm keeps exactly the despawned roots
  stock keeps (both: none), and the pool is empty after every render. (Everything touching a rig node in the test runs
  in plain functions: an async function keeps its last temporaries in generator registers, which kept one despawned
  rig alive in BOTH arms of the review's repros — the "stock keeps 1" there is that artifact, not three.)

**Mutation testing** (scratch mutants of `entity_world.js`, `EW_MODULE=<file>`; 2026-10-29 re-run on the round-2
code: **37 of 44** caught — the same 26 of the 31 round-1 mutants, and 11 of the 13 new ones, §11.4): 26 of 31
single-point breaks fail the suite. The survivors are redundant or equivalent: the census fallback (the census also swaps the prototype
method, which the method-identity fallback catches anyway); each of the two attribute-set checks alone (either one
sees an ADDED key; a DELETED key leaves `WebGLObjects.update` a no-op, so skipping it stays exact — the mutant
removing both is caught); each of the two epoch triggers alone (new render lists, `webglcontextrestored` — the mutant
removing both is caught). The caught ones cover the walk (the clean check, the skip rule for parts / meshes / the root,
pivots, compose's association, a −0 position taken as identity, delegation, `matrixWorldAutoUpdate`) and the
projection (z, cold groupOrder, attribute versions, dispose, the epoch, pre-order pushes, the layers / frustum /
`material.visible` tests, both restores, carriers, the entities group's groupOrder, the root's layers for groupOrder,
first sights, the per-render memo).

**Existing suites with the flag forced on** (`node --import <preload> <suite>`, preload =
`__setRustFlagForTest("rustEntityWorld", true)`): 35 suites, each run forced on AND off, all pass in both: test_motion_sequence,
test_phase7_4a_animation_clip, test_phase7_4b_entity_pipeline, test_phase7_batch9_entity_lifecycle,
test_a9_stage2_setup_rig, test_skip_hidden_matrix; tests/ unified_hook_drain, unified_handback,
unified_motion_authority, unified_queue_preempt, motion_link_fidelity, drone_entities_seam, drone_gestures,
creature_gait_retail, turn_left_reverse, same_guid_respawn, limbs, ragdoll_rest, retail_rig_speed,
spawn_motion_stash_remove, film5_nameplate_take, entity_cell_cull, **rust_rig_parity** (58/58 — 18 roots through the
entity walk, 1,044 root walks, 17,748 identity copies, every part / mesh matrix still equal to the JS pose path's),
**rig_mesh_alias** (16/16 — 320 root walks over aliased parts), dismember_archive, death_hold, carnage_finisher,
carnage_hit_guard, csm_offscreen_casters, entity_particle_layer, default_script_part_child, held_attach_generation,
held_attach_promote, held_ledger_wire_spawn, draw_exec (401/401). The rig build installed the root walk in 13 of them
(the spawn path); none renders through a renderer with the projection installed (only this suite's R / E parts do).

## 7. Non-exact options — estimates only, not built

Per drawn entity mesh the draw costs ~6.2 µs in node with the executor (R3: on the 1070 a plain continuation ~3.6 µs,
a material switch ~7–8 µs); today's census: 176 visible part meshes over 111 materials and 162 (geometry, material)
pairs at Holtburg (8 pairs used more than once), lane X's 1070 arithmetic ~450 entity part draws with a continuation
share ~0.29.

| Option | Draw cut | Main-thread estimate [D] | Visual risk | Effort |
|---|---|---|---|---|
| **(c)** per-(entity, material) merged draws: an entity's parts that share a material drawn as one draw, each vertex carrying its part index, the part model-view / normal matrices uploaded per draw as a uniform array (computed per part on the CPU exactly as today, so vertex positions can stay bit-identical) | entity draws → distinct materials per entity: −30…−40% (176 → ~111; 1070 ~450 → ~300) | ~0.3–0.4 ms/frame (the removed draws are mostly continuations ~3–4 µs each, minus the palette upload) | draw order inside an entity changes: coplanar / equal-depth fragments between parts resolve by order (LessEqual/GreaterEqual ties), transparent parts lose their per-part sort (merge opaque only); hidden parts (dismember, partDegrade, `materialRendersNothing`) need per-part enables; picking / dismember / limbs / recolor address meshes by part (topology change); a new program variant per material class (compile stalls, prewarm lists); shadows need the same path | L; eye-test class |
| **(d)** per-entity texture arrays: all of an entity's opaque surfaces in one material over a texture array (a layer per surface, a per-vertex layer index) on top of (c) | −85…−90% (one draw per entity per blend class) | ~1–1.7 ms/frame (removes the per-entity material switches too) | **not exact**: array layers share one size, so AC surfaces (32–512 px) are resampled or padded (mip / filter changes at edges); per-surface material state (translucency, luminosity, alpha test, palette / dye, two-sidedness) moves into per-layer uniforms (a MeshStandardMaterial rewrite); arrays per entity duplicate shared textures (memory); equip / dye changes rebuild arrays (hitches) | XL; owner decision |

## 8. Recommendation and the 1070 protocol

1. Keep `?rustEntityWorld` **off** by default for now. It is exact by construction and proven in node (identical GL
   stream, mutants caught), so flipping it is purely a measured-gain decision.
2. On the 1070 (owner-run, off-screen, `?nosw=1`, fresh `--user-data-dir` per arm): `hbbench.mjs --uncapped` at
   Holtburg running and standing, arms `rustEntityWorld=off` vs `=on`, 3 reps interleaved, plus one `hbsess profile` per
   arm. Read: the scene-walk bucket (projectObject + updateMatrixWorld + sort) and `window.__entityWorld.stats()`
   (`projections` 1, `lateRestores` 0, `refused` null, `cold` ≈ visible part meshes). Builds before 2026-10-29 installed
   no projection in the client (`projections` absent, `renders` 0): an A/B on them measured the walk half only. Expect ~0.1–0.25 ms/frame; kill if not better than the rep
   spread or any console error. A bare-URL boot with 0 errors precedes it (house rule).
3. The bigger entity lever is the draws (2× the scene walk, §1.2): (c) then (d), owner-gated.

## 9. Not done, and follow-ups

- **Not built:** (a) Rust-written world matrices (§2), a Rust cull (§3.5), (c) and (d) (§7).
- **Presorted pushes** (exact, not built): with a consistent comparator (no NaN z) push order cannot change the sorted
  output, so the cold entity items could be pushed in last frame's sorted order, making them one presorted run for
  TimSort (~40–60% of the entity sort, ~50–70 µs/frame in node). Needs a NaN guard (fall back to pre-order pushes) and a
  check that nothing reads render-item identity across frames.
- **A fused walk + projection** (compute rig matrices inside the projection pass) would save one traversal of the rig
  nodes but moves matrix writes from the walk to projectObject; anything reading rig matrices in between (scene
  `onBeforeRender` hooks) would see older values — exact only with an audit. Not done.
- **Held items and nameplates** are hot (three projects them); recursing into nested rigs and pushing sprites cold
  (three's `intersectsSprite` + `setFromMatrixPosition` z) would take the last ~15 hot nodes per frame.
- The census probe (`__skipHiddenMatrix.census`) counts rig nodes only while the census runs (the walk then hands every
  root to three).

## 10. For the orchestrator

- **docs/url-flags.md** row (next to `rustRig`; in the file since round 1, updated 2026-10-29 — this is its text):

  | `rustEntityWorld` | `on`/`1`/`true`/`yes` opts in; `off`/`0`/`false`/`no` | **OFF** (2026-10-26, lane R4) | `scene3d/entity_world.js` `entityWorldEnabled` = `rustFlag("rustEntityWorld", false)`; live `window.__entityWorld.walkOff` / `.projOff`; `.stats()` (`projections` 1 = the projection is installed) | **The entity rigs' share of three's scene walk, done by rig-aware code with three's values.** WALK: each rig root (entities.js rig build) gets an own updateMatrixWorld — three r184's body for the root with skip_hidden's rule, then its plain-Group parts and plain leaf meshes in one loop with compose / multiplyMatrices inlined (source premises checked); an exact-identity leaf mesh under a clean part world (no −0 / ±Inf / NaN) takes the identity and the part's world by copy (P × I is P bit for bit); every other child walks itself in place. PROJECTION (main scene, between renderLists.get and list.finish; installed by scene3d/index.js's `installEntityWorld(renderer, () => scene, () => entitiesGroup)` line — required, 2026-10-29: before it only the walk ran in the client): the entities group's children are a stand-in whose RigPusher `visible` getters mirror projectObject over each rig, hand three its HOT nodes (lights, sprites, first sights, changed geometries, specials) in pre-order, and push the COLD meshes (same object / geometry / material / groupOrder / z) at their pre-order positions; WebGLObjects.update is skipped only where it is a no-op (geometry noted current at two hot visits at different info.render.frame values — three memoises the update per frame value and a shadow raster runs it after frame++ — same attribute objects + versions + keys, not disposed, no context restore); list.finish's restore also empties the stand-in pool, so no despawned rig stays reachable (2026-10-29). EXACT: tests/rust_entity_world.test.mjs (98 checks, 2026-10-29: every node's matrices Object.is-equal after every walk; the full GL call stream, renderer.info and the sorted render lists identical to stock frame by frame over 12 scenarios incl. shadows, gated shadow rasters with dispose / bump right after a raster, indoor split, context restore, ArrayCamera, NaN poses, carriers, a throw inside projectObject; the real spawn path with index.js's scene3dForBuilders shape + index.js's install line checked; despawned rigs collectable (WeakRef + gc, flag-on = stock); 37/44 mutants caught, the rest redundant or equivalent). Node, Holtburg-shaped (19 visible rigs): entity matrix walk −30…−36%, entity projectObject −23…−28%, entity scene walk −23…−26% (195–250 µs/frame). JS only (the Rust variants lose). 1070 A/B owed. docs/2026-10-26-rust-entity-walk.md | scene3d/entity_world.js; scene3d/index.js install line; entities.js rig build; skip_hidden_matrix.js `skipHiddenWalkMode` |

- **index.html**: re-run `node scripts/gen-modulepreload.mjs` — the block is stale (`--check`); the new non-app module
  `./scene3d/entity_world.js` joins it (with two other lanes' new modules `./scene3d/rust/world.js` and
  `./scene3d/terrain_shared_uniforms.js`), and `harness/test_build_shell.mjs`'s `NON_APP_PRELOADS` pin moves by the
  number of new non-app links (433 → 436 with all three).
- **index.js** (**required**; done 2026-10-29, §11.1): `try { installEntityWorld(renderer, () => scene, () => entitiesGroup); } catch (_) {}`
  (import from `./entity_world.js`) once the world groups exist (after `worldRoot.add(terrainGroup, …, entitiesGroup)`).
  The earlier text here said "optional — the first rig build installs it through `ensureEntityWorld(scene3d)`": false
  in the client (`scene3dForBuilders` has no renderer / scene). The modulepreload block is unchanged (the module was
  already preloaded; `gen-modulepreload.mjs --check` up to date).
- **Rust / wasm**: none. `cargo test -p holtburger-scene` and the wasm build are unaffected; no new export, no
  `lib.rs` / `Cargo.toml` / `scene_wasm/mod.rs` lines.

## 11. 2026-10-29 — round-2 review fixes

Review: `/mnt/wbterminal1/tmp/claude-scratch/rustcore-2026-10-29/review_r2.json` (lane R4: two confirmed findings, one
contested). Scratch for this round (pre-fix copies, mutants, probes, logs):
`/mnt/wbterminal1/tmp/claude-scratch/rustcore-2026-10-29/fix-r2/R4/`. All runs: node 20, laptop, one at a time.

### 11.1 The projection half never installed in the client (confirmed)

- **Bug.** index.js builds the EntityManager with `scene3dForBuilders`, which has no `renderer` and no `scene`; the rig
  build's `ensureEntityWorld(this.scene3d)` returned null at `scene3d.renderer`, and index.js never called
  `installEntityWorld`. With `?rustEntityWorld=on` only the walk half ran (`renders` = `cold` = 0, `refused` null). The
  suite's Part E passed only because it handed the EntityManager a renderer and a scene.
- **Fix.** `scene3d/index.js`: the import next to `installDrawExec`'s, and `try { installEntityWorld(renderer, () => scene,
  () => entitiesGroup); } catch (_) {}` right after `worldRoot.add(terrainGroup, …, entitiesGroup)` (after
  `installDrawExec`, before the first render — the suite's patch order). `scene3dForBuilders` is unchanged (flag-off
  builders read `scene3d.renderer` / `.scene` from it). With the flag off `installEntityWorld` returns at its first line;
  the module was already loaded (entities.js imports it), so the import adds no side effect. New diag
  `stats().projections`.
- **Regression checks.** Part P "install wiring" (index.js source: the import, the call in a `try`, after
  `installDrawExec` and after the world groups) and "installEntityWorld with the flag off touches nothing"; Part E now
  builds the EntityManager with the facade shape, checks that `ensureEntityWorld` installs nothing from it, and replays
  index.js's line. **Proof:** `EW_INDEX_SRC=<HEAD's index.js>` → `[FAIL] install wiring … import false, call @-1`,
  97 passed / 1 failed (`suite_prefix_index.log`); the fixed tree → PASS.

### 11.2 The stand-in pool kept despawned rigs reachable (confirmed)

- **Bug.** `RigPusher.children` / `Carrier.children[0]` were reset only when that pusher's `projectRig` ran again. After a
  crowd shrank (surplus pushers), an item was dropped (a stale carrier slot on a reused pusher), or the entities group
  emptied (onGet returns before the stand-in), hot nodes — nameplate Sprites, held items, lights — kept their despawned
  rigs reachable (parts, meshes, materials, CPU texture data) from `renderer.__hbEntityWorld`.
- **Fix.** `ProjectionState.restore()` (list.finish, the render `finally`, the late restore in onGet — each after
  projectObject is done with the stand-in) clears every pusher of the render: target, hot nodes, carrier slots, segment
  items (left only by a throw), and the stand-in array; plus `camUsed`. Cost: O(visible rigs + carriers) stores per main
  render, nothing per mesh (segment items are already nulled by `pushSeg`).
- **Regression checks.** Part L (§6) and, in every Part R scenario, "the pool holds no node" every frame. **Proof**
  (`EW_MODULE=<HEAD's entity_world.js>`, `suite_prefix_module.log`): `L: … stock [] vs flag [0,1,2,3,4,5,6,7]`,
  `stock [] vs flag [0]`, pool non-empty in all 12 R scenarios; fixed: `stock [] vs flag []` both phases. The review's
  repros now read flag-on = stock: `leak_pushers.mjs` 1/8 = 1/8 (`staleKids` all 0), `nameplate_retain.mjs` 1 / 1,
  `r2_pusher_retention.mjs` 0/7 = 0/7, `retainer_check.mjs` `[6]` in every arm (their stock survivor is the
  generator-register artifact of §6 L).

### 11.3 A note taken where three's update memo skipped the upload (contested, reproduced, fixed)

- **Reproduced.** `review-r2/r4-robust/shadow_memo.mjs`: `R3: stock bufferSubData=1 | flagOn bufferSubData=0 <-- DIFFERS`;
  `shadow_memo_dispose.mjs`: `R3: stock bufferData=3 | flagOn bufferData=0`; `refute-r4-shadowmemo/evict_dispose.mjs`:
  R3 and R9 differ; `sibling_vao_prog.mjs`: a sibling of another program draws with 0 live attribute pointers from R4
  on (stock 3) — a pixel difference, permanent. The refutation is right that the client's default frame shapes put
  another render() between two main renders (composer, sky, the indoor split), but the module's bar is exactness under
  any render sequence three accepts, and the bare shape is reachable (`?atmosphere=off`, the boot pre-bake window).
- **Mechanism.** r184 `WebGLObjects.update` runs `geometries.update` only when `updateMap.get(geometry) !==
  info.render.frame`; render() runs the shadow pass after `info.render.frame++`. After a raster in render N the memo
  of every caster equals render N+1's frame value, so N+1's first visit uploads nothing (stock too). A change made
  between N and N+1 (EVICT-DISPOSE, an attribute bump) is uploaded by stock at N+2's projectObject; the round-1 note at
  N+1's hot visit recorded those versions as current, so N+2 went cold and never uploaded.
- **Fix** (the reviewer's design, keyed by frame value instead of render serial). A note is **confirmed** only when the
  previous note of that geometry — same epoch, not disposed since — was taken at another `info.render.frame` value and
  saw the same attribute objects at the same versions in the same key order; `coldValid` requires confirmed. Why that is
  current: at the confirming visit three's update either runs (memo older than this frame value), or its memo equals
  this frame value, set by a call made after that value began — after the first note, whose frame value was earlier:
  a raster of a later render, which ran `geometries.update` on the attributes it saw. **Frame value, not serial:** a
  throw inside projectObject leaves the frame value unchanged, so the next render shares it; a serial-keyed confirm
  there trusts a memoised visit (mutant C2, caught at frame 8 of the new scenario). **Formal limit:** the raster in
  between could have seen other attribute objects only if, between the two notes, an attribute object were swapped out
  and back in around another render whose shadow pass draws the same geometry (an entity part geometry in a second
  shadow-casting scene) — not a path in the client.
- **Regression check.** Part R "shadow memo" (§6). **Proof:** HEAD's module → `frame 3 call 2 (stock 1081, flag 1070)`:
  stock re-creates the disposed geometry's buffers, flag-on does not; mutant C1 (the round-1 rule: trust a note at once)
  → the same; fixed → identical over 10 frames. All four `refute-r4-shadowmemo` repros, both `r4-robust` repros and
  `refute-shadow-memo/memo_paths.mjs` (5 frame shapes × dispose / bump) are identical in every frame with the fix.
- **Cost.** A new or changed geometry stays hot one render longer (the confirming visit). Suite, per scenario: +115 hot,
  −115 cold — one extra render for each first-seen part mesh (baseline 126 → 241 hot over 8 renders; context restore
  147 → 403: every record is re-noted twice). Steady state (every geometry confirmed): unchanged, and a new rig of a
  known setup is cold at first sight (its shared part geometries are already confirmed). Not re-benched (`--bench`
  warms 98 renders before it measures, so the steady state is what it reads).

### 11.4 Mutation run (`fix-r2/R4/mutate.py`, the round-1 list + 13 new)

37 of 44 caught. Round-1: the same 26 of 31 (survivors W9, P4, P5, P7, P7b — redundant / equivalent, §6). New:
R1 restore keeps the pool (the round-1 code), R2 hot nodes, R3 carrier slots, R4 targets, R5 segment items (caught by
the throw scenarios' pool check), C1 notes trusted unconfirmed (the round-1 code), C2 confirm within the same frame
value, C3 confirm without comparing attributes, C4 confirm across a dispose, C6 confirm ignoring versions, C8 frame value
not taken per render — caught. Survivors: C5 confirm across an epoch (equivalent: an epoch moves only with a context
restore, which also replaces three's update memo, so the first visit after it always uploads), C7 confirm ignoring a
deleted key (equivalent, as P5: a deleted key leaves the update a no-op).

### 11.5 Residuals found, not fixed (pre-existing in the round-1 code)

- **A throw inside projectObject, then a change.** The throwing render does not reach `frame++`, so the next render shares
  its frame value. Stock ran `WebGLObjects.update` (memo = that value) for every mesh it reached before the throw; the
  stand-in pushed the cold ones without it. A geometry cold in the throwing render and changed before the next render:
  stock's update there is a memo no-op (the upload comes one render later), the flag-on hot visit uploads at once.
  Repro `fix-r2/R4/residual_throw_memo.mjs`: `R4: stock bufferSubData=0 | flagOn 1`, `R5: stock 1 | flagOn 0` — the same
  with HEAD's module. Not fixable exactly from outside three (it would need three's memo, or `geometries.get` without
  `geometries.update` for a disposed geometry); needs a throw inside projectObject, which is itself a bug.
- **Attribute objects shared between geometries.** Disposing geometry X deletes the GL buffers of every attribute object
  X holds; a geometry Y sharing one keeps a valid record (only X's dispose is seen), so Y would stay cold where stock
  re-creates the buffer. No entity part geometry shares attribute objects (the only `setAttribute(…, other.attributes…)`
  sites are cell_fusion.js and fx_decal_effect.js); a fix would watch every geometry's dispose.

### 11.6 Runs (2026-10-29)

`node tests/rust_entity_world.test.mjs` → 98 passed / 0 failed (`suite_post2.log`); with HEAD's module 76 / 16
(`suite_prefix_module.log`, Part E skipped under `EW_MODULE`); with HEAD's index.js 97 / 1 (`suite_prefix_index.log`).
Flag forced on (`--import ew_on_preload.mjs`): rust_rig_parity 58/0, held_attach_promote 5/0, same_guid_respawn 6/0.
`node scripts/gen-modulepreload.mjs --check` → up to date (457 modules).
