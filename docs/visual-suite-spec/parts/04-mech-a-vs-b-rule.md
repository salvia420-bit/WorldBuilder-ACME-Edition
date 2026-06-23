I now have everything I need. Writing the spec.

---

# MECH-A vs MECH-B Decision Rule — Build Spec (slice 04)

## Goal

Give the VFX dispatcher a **deterministic, geometry-driven function** that routes each `procMotion.*`/`deformation.*` component to exactly one of two in-tree substrates:

- **MECH-A** — CPU per-part keyframe hinges on the `animated_scenery.js` shared mixer (one driver per `(setupId, phaseBucket)`, advanced once/rAF, transforms copied onto N de-instanced instance nodes).
- **MECH-B** — GPU intra-part `begin_vertex` displacement via a `materials.js` `_chainBeforeCompile` patch on a per-DID **cloned** material (instancing preserved, no per-instance node cost, no 512 cap).

The router must (a) pick A or B from `partCount` + per-part geometry + the motion locus, (b) apply an instance-count override against the **512 cap**, and (c) allow **one object to carry both** (bow = limb-B + string-A). It must never violate THE RULE and never make `customProgramCacheKey` per-instance.

---

## Design

### The two substrates, as the code actually implements them

**MECH-A (`animated_scenery.js`).** A wind/anim instance is a `THREE.Group` whose children are per-part `THREE.Group`s named `part0…partN` (`buildOneWind` lines 441–479), each holding that part's meshes. One shared driver per group key holds a template + mixer + clip (`getOrCreateWindGroup:389`); the clip is per-part `position`+`quaternion` keyframe tracks (`buildSceneryAnimationClip:127`, tracks at :153–154). The rAF advances each driver **once** (`:580`) then **copies** the template's per-part `position`/`quaternion` onto each near instance's part groups (`:605–609`). Granularity = **one rigid part**: a part Group rotates as a unit about a pivot; its child meshes cannot move relative to each other.

- Driver key: `wind:0x${setupId}:${bucket}` (`:529`), bucket from `hash01(key)` (`:528`) — phase decorrelation without a per-instance mixer.
- Rig: `buildBboxRig` (`wind_rig.js:113`) gives each part a pivot at its own **vertex-Zmin base** (`:132`) + a monotone `swayAmp` weight (`:98`), so co-located-origin parts still hinge correctly (comment :15–19).
- **Cost = CPU + draw calls.** De-instancing: each animated placement draws its parts individually (it leaves the merged `InstancedMesh`). Bounded by `DEFAULT_MAX_ANIMATED = 512` (`:45`, enforced :338/:516) + a 140 m distance tick-cull (`:46`, :62–69, applied :585–602). GPU work ≈ a static of the same poly count.

**MECH-B (`materials.js`).** `_chainBeforeCompile` (`:292`) injects GLSL at `#include <begin_vertex>` to modify `transformed` (the AO patch at :324–327 is the exact insertion precedent). The material is a **clone per DID** (`getCachedFloorBias:1794–1806` is the precedent: clone base, `_chainBeforeCompile`, store in a per-variant `Map`). The program-cache key is **per patch-SET** via `userData` flags (`_patchSetCacheKey:262`, installed :281–284) — *never* per-instance. Granularity = **per vertex**: one rigid mesh can bend continuously (tip lags base).

- **Cost = GPU vertex ALU**, a few `sin`/`mul` on displaced verts. **Per-instance cost ≈ 0** — shared program + shared material, instancing intact → **no 512 cap, no draw-call increase.**
- Per-instance phase MUST come from a **per-instance attribute** (e.g. a hash derived in-shader from `instanceMatrix` translation, or an `InstancedBufferAttribute`), NOT a uniform and NOT baked into the GLSL string — otherwise the material/key forks per instance and the program cache explodes (the project's #1 cold-load cost).

### The discriminator

```
motionLocus(component, geom):
  geom = { partCount, partBoxes[], hingeFrames[], placementCount }
        // partCount, partBoxes, hingeFrames from fetchBuildingPlacement bundle
        // (animated_scenery.js:428 partCount, :430 takePartMeshes, :431 takePartHingeFrames)

  // 1. Author override wins (archetype declares its mechanism in config.mech)
  if component.mech in {'A','B'}: return component.mech

  // 2. Auto: is the motion expressible as RIGID rotation of whole parts?
  //    -> needs ≥2 spatially-distinct parts forming the articulation.
  acrossParts = (partCount >= 2) && articulationIsPartStructure(partBoxes, hingeFrames)
  withinPart  = component.locus == 'withinPart'   // continuous flex of one mesh

  if withinPart and not acrossParts: return 'B'   // spear shaft, bow limb
  if acrossParts and not withinPart: mech = 'A'   // trunk/canopy, link chain
  else: mech = component.preferMech ?? 'B'         // ambiguous → cheaper GPU path

  // 3. Instance-count override (the 512-cap escape)
  if mech == 'A' and geom.placementCount > INSTANCE_CAP_REACH   // ~512
     and componentHasSingleAxisApprox(component):
       // A would freeze all but ~512 nearest. If the motion has a
       // single-axis B approximation, prefer B to animate ALL placements
       // for ~free GPU (preserves instancing).
       return 'B (height/axial-weighted approx)'
  return mech

articulationIsPartStructure(partBoxes, hingeFrames):
  // ≥2 parts whose AABBs are spatially separable along the bend axis
  // (distinct vertex-Zmin bases) OR carry distinct non-identity hinge frames.
  // This is what buildBboxRig already exploits (wind_rig.js:122-135).
  return countSeparableParts(partBoxes) >= 2
```

**The core test, in one sentence:** *Can the visually-correct motion be written as rigid rotation of whole parts about per-part pivots?* If **yes and partCount ≥ 2** → A is sufficient. If the motion **requires bending vertices within a single rigid part** → only B can express it (a MECH-A part Group is rigid). When both are possible, the **CPU-bound / idle-GPU** reality and the **512 cap** tilt to B unless near-camera per-part independence reads materially better (trees).

### MECH-B `begin_vertex` skeleton (axial-weighted intra-part flex)

```glsl
// installTipFlexPatch(material): chained via _chainBeforeCompile (materials.js:292)
// uniforms: uTime (shared clock), uFlexAmp, uFlexAxis(vec3), uGripZ (anchor along shaft)
// per-instance phase: aInstPhase (InstancedBufferAttribute) — NOT a uniform.
#include <begin_vertex>
{
  // weight 0 at grip, →1 at tip; smoothstep over the shaft span
  float w = smoothstep(uGripZ, uShaftTopZ, position.z);
  float ph = aInstPhase;                         // per-instance, keeps ONE program
  float bend = uFlexAmp * w * w * sin(uTime * uFlexFreq + ph);
  transformed += uFlexAxis * bend;               // displace render-time vertex only
}
```

`customProgramCacheKey` stays `_patchSetCacheKey(this)` — one key for the whole "tip-flex" patch SET, shared by every placement of every tip-flex DID that uses the same uniform layout. Amplitude/axis/grip are **uniforms**, phase is an **instanced attribute** → one program, one material clone per surfaceDid.

### Worked examples

| Object | partCount / geometry | Motion locus | Mechanism | Why |
|---|---|---|---|---|
| **trunk-canopy** (tree `0x02000258`) | multi-part (trunk + branches + canopy billboards), spatially-distinct bases | acrossParts (per-part rigid rotation about each base) | **A** | Articulation *is* the part structure; `buildBboxRig` hinges each part about its vertex-Zmin (`wind_rig.js:132`). Near-camera trees dominate; far ones freeze under the 512 cap imperceptibly. |
| **spear-tip** (Atlan `0x02000724`) | 1–2 rigid parts; shaft is one mesh | withinPart (tip lags base, continuous flex) | **B** | No joint exists; a part Group is rigid so A literally can't bend the shaft. Axial-weighted `begin_vertex`, grip = `holding_locations` frame (`setup_model.rs:334`). Per-instance ≈ free; rides the frozen instanced path. |
| **bow** | riser + 2 limbs (one mesh each) + string (thin part) | **mixed** | **B + A** | Limb = intra-mesh curve driven by `drawAmount` uniform → B. String = thin part hinging between two rigid attach points → A. Dispatcher routes **per-component**; the object carries one B material patch (limbs) AND one A driver (string). Demonstrates that mechanism is a *component* property, not an *object* property. |
| **chain / rope** | **case split on partCount** | acrossParts *or* withinPart | **A if ≥2 link parts, B if 1 tube mesh** | Cleanest illustration of the rule: if DAT models each link as a separate PART → MECH-A pendulum cascade (per-part hinge). If it's ONE continuous tube mesh → MECH-B catenary displacement weighted by arc-length. `partCount` is the literal switch. |

**Fern note (the cap-escape case):** `0x02001063` — 3-part billboard cluster, **317 k placements**, on the wind allowlist (`tree_wind.js:65`). Under MECH-A only the ~512 nearest animate. Because the motion has a clean single-axis height-weighted approximation, it's the prime **A→B migration candidate** (the instance-count override): a `begin_vertex` height-weighted bend animates **all 317 k** for ~free GPU, preserving instancing. Flag as a Phase-2 migration, not a day-zero change.

---

## Integration seams (file:line)

- **Dispatch/divert site (where the router lives):** `statics.js:1584–1600` — anim peel (`defaultAnimationId != 0`) runs first, then tree-wind peel (`isTreeDid`), producing disjoint sets; `attachWindTrees`/`attachAnimatedScenery` called at `:1843–1846` and `:2390–2393`. The generalized router replaces the two hardcoded `filter` peels with a per-component classify→route→bucket pass over `statics`, emitting (frozen, mechA-list, mechB-DID-set).
- **MECH-A consumer:** `animated_scenery.js` — `attachWindTrees:495`, `getOrCreateWindGroup:389`, rAF advance `:580`, copy `:605–609`, 512 cap `:45`/`:338`/`:516`, distance cull `:62–69`/`:585–602`.
- **MECH-A rig math:** `wind_rig.js` — `buildBboxRig:113`, `partBBox:59`, `swayAmp:98`, `buildTreeWindClip:149`, `hash01:199`.
- **MECH-B patch infra:** `materials.js` — `_chainBeforeCompile:292`, `_patchSetCacheKey:262`, `_installPatchSetCacheKey:281`, `begin_vertex` insertion precedent `:324–327`, per-DID clone-variant precedent `getCachedFloorBias:1794–1806`, base `getCached:1769`.
- **Geometry inputs for the discriminator:** `fetchBuildingPlacement` bundle — `partCount` (`animated_scenery.js:428`), `takePartMeshes` (`:430`), `takePartHingeFrames` (`:431`); DAT `holding_locations` (`setup_model.rs:334`), `num_parts` (`:366`).

---

## Edge cases & legacy-safety check (per THE RULE)

- **MECH-A writes** per-part Group local transforms on a **non-rendered template** copied onto instance nodes (`:605–609`); **reads** DAT geometry (`partBBox`), `hash01(guid)` phase (`:528`), and the client wall-clock (`performance.now` in the rAF). Never the wire, never the collision BSP (server-authoritative, untouched). ✓
- **MECH-B writes** `transformed` (render-time vertex pos) + a cloned material's uniforms; **reads** static vertex attributes, `uTime` (client clock), and optionally read-only client `drawAmount`. The server stores/replicates neither vertex positions nor uniforms. ✓
- **No per-instance cache key:** B's displacement params are **uniforms**, per-instance phase is an **instanced attribute** → one program/material per patch-SET (`_patchSetCacheKey:262`). Forbid string-baked per-instance constants. ✓ (guards the #1 cold-load cost)
- **No light-count change:** neither mechanism touches lights. ✓
- **De-instancing is bounded:** A leaves the merged InstancedMesh and draws per-part — capped at 512 (`:45`) + 140 m cull (`:46`). The router must keep A’s output set ≤ cap and pass everything else frozen. ✓
- **Don't double-animate:** DAT self-animation (hook 22/23/24) wins. The router keeps DAT-anim and synthetic-motion sets disjoint exactly as `statics.js:1584–1599` already does (anim peel before motion peel). (cross-ref slice 14)
- **Shadow/normal correctness (B only, deferred to slices 05/08):** B leaves shadow geometry + normals stale. Cheap thin-object flex skips both (imperceptible). Large bends (cloth/limb) must also patch `customDepthMaterial` and recompute normals — flagged, not solved here.

---

## GPU cost

| | MECH-A | MECH-B |
|---|---|---|
| Where it spends | **CPU** (scarce; world is CPU-bound ~20 fps) | **GPU** (30–50 % idle on the 1070) |
| Per-frame | `O(drivers)` mixer.update + `O(min(inst,512)·parts)` transform copies | `O(displacedVerts)` ALU (few `sin`/`mul`/vert) |
| Per-instance | de-instanced → **extra draw calls per part**, counts vs 512 cap | **≈ 0** (shared program+material, instancing intact, no cap) |
| Scaling | unique drivers + capped near instances | total visible verts of patched DIDs (cheap for thin objects) |
| Holtburg ref (222 placements / 66 models) | ≤512 inst × ~5 parts ≈ ≤2.5 k extra draws worst-case, cut hard by the 140 m cull | dozens of verts × spear/sign → negligible; stays well under the <75 %-GPU ceiling |

**Thumb on the scale:** on a CPU-bound world with idle GPU, **B is the cheaper mechanism whenever the motion is intra-part-expressible** (no draw-call growth, no cap, spends the idle resource). Reserve A for genuine multi-part articulation where per-part independence reads materially better near camera (trees).

---

## Build checklist (ordered)

1. **`scene3d/mech_dispatch.js` (new, pure, no THREE):** export `routeMechanism(component, geom)` implementing the discriminator above; export `articulationIsPartStructure(partBoxes, hingeFrames)` reusing `wind_rig.js` `partBBox`/`_modelBox` separability logic. Unit-test the four worked cases + the fern override. Keep `INSTANCE_CAP_REACH = maxAnimated()` import-free (pass it in).
2. **`materials.js`: add `installVertexDisplacePatch(material, {patchKey, glsl, uniforms})`** — a generic MECH-B installer that `_chainBeforeCompile`s a `begin_vertex` displacement, registers its flag in `_patchSetCacheKey` (extend the userData-flag string at `:262`), and is idempotent. Add a per-DID variant cache `getCachedDisplaced(surfaceDid, patchKey)` mirroring `getCachedFloorBias:1794–1806` (clone base → patch → store in a `Map`).
3. **`materials.js`: per-instance phase attribute** — add an `InstancedBufferAttribute aInstPhase` plumbed at the InstancedMesh build in `statics.js` (derive from `hash01` of the placement key, mirroring `animated_scenery.js:528`); declare it in the patched vertex shader. Verify `customProgramCacheKey` stays constant across instances (assert one program in `renderer.info.programs`).
4. **`statics.js:1584–1600`: generalize the two hardcoded peels into one router pass.** For each placement: classify→component(s)→`routeMechanism`. Emit three buckets — `frozen` (unchanged merged path), `mechA` (→ `attachWindTrees`/`attachAnimatedScenery`, ≤512), `mechB` (DID set → `getCachedDisplaced` material variant chosen at the existing `getOrCreateMaterialCache` seam `:1550`). Keep buckets **disjoint** and keep DAT-anim peel first (preserve `:1584` ordering).
5. **Per-component routing for mixed objects (bow):** allow a placement to land in **both** `mechA` (string part) and `mechB` (limb material) — the buckets are not mutually exclusive at the object level, only at the component level. Add a test asserting a bow DID yields one A driver + one B patch.
6. **Instance-count override:** wire `placementCount` per DID (already available from the statics ring count) into `geom`; when A is sufficient but `placementCount > INSTANCE_CAP_REACH` and the component declares `singleAxisApprox: true`, route to B. Log the override (mirrors the cap-drop log at `:357`/`:541`).
7. **Diag:** extend `animatedSceneryDiag()` (`:635`) with `{mechA, mechB, overrides}` counts; add a `renderer.info.programs` assertion to the A/B harness so a regression that forks the cache key per-instance fails loudly (guards the cold-load cost).
8. **Round-trip test:** with only `trunk-canopy` registered, the router must reproduce today's `TREE_WIND_DIDS` MECH-A behavior byte-identically (proves the generalization is non-regressing), and `?treeWind=off` must leave the frozen path untouched.
