# Spec: Movement (Rapier) · Skinned Avatars · Progressive Destruction (three-pinata)

Date: 2026-08-01 · Status: DRAFT for review · Owner: holtburger-web
Decisions locked in consult: Rapier for movement · skinned skeletons for players AND monsters ·
live-hit **progressive destruction** · death = **ragdoll → fracture** · fracture geometry = **per-part convex hulls**.

## 0. Goals / Non-goals

**Goals**
- Replace the hand-rolled movement system with an engine-backed controller whose failure modes are enumerable.
- Replace per-part character assembly (scattered-limb failure class) with single skinned meshes — one bone-write site.
- A damage/death presentation nobody else in the AC scene has: wounds accumulate on live monsters, corpses ragdoll
  and fracture by damage type. Differentiation is a stated goal, not a side effect.
- Every system testable without eye tests (cargo/node); eye tests batched to 1070 per house rules.

**Non-goals**
- No server changes required — everything here works against vanilla ACE as-is (see §1.4 acceptance contract).
- No art replacement; retail meshes/textures/palettes remain the source. (Modular-art direction explicitly parked.)
- No changes to equipment/clothing composition semantics (ObjDesc remains the single source of truth).
- Retail rendering/movement paths remain as escape hatches until each default-on gate passes.

## 1. Movement — Rapier as query engine, policy owned by us

**Crate placement:** `rapier3d` (0.34.x, glam-based) inside the existing wasm crate (`apps/holtburger-web/src/`),
NOT a JS-side integration. JS keeps input capture (`setMovementInput`) and reads poses — unchanged surface.

### 1.1 Collision world
- Terrain: per-landblock trimesh from already-baked terrain triangles (retail per-cell diagonal split preserved —
  do NOT use Rapier heightfields: fixed diagonal ≠ AC's per-cell split).
- Interiors: EnvCell physics polygons → trimesh. Statics: setup physics meshes → trimesh.
- `TriMeshFlags::FIX_INTERNAL_EDGES` ON everywhere.
- **LB-seam rule:** landblock borders are internal edges the flag can't see. Strategy: weld shared border vertices
  across adjacent LB colliders (border verts are shared by construction, 9×9 grid). Fallback if welding is
  insufficient in spike: single merged collider per 3×3 neighborhood, rebuilt on LB crossing.
- Colliders stream/evict with landblocks (tie into existing residency path).

### 1.2 Controller
- Capsule character; start from `KinematicCharacterController`, expect to own the policy layer:
  - **AC walkability** implemented by us (surface-normal z-threshold per retail semantics), not via
    `max_slope_climb_angle` (known-weak enforcement, dimforge/rapier.js#274).
  - **Depenetration helper is REQUIRED from day one** — upstream `check_and_fix_penetrations()` is a stub.
    Parry contact query + push-out; used at spawn/teleport/portal and as a per-frame safety net.
  - Autostep: explicitly enabled (off by default since rapier 0.20); `max_height` tuned from measured EnvCell
    stair geometry (spike task). Capsule radius handles sub-radius steps for free.
  - Gravity/jump integrated by us with retail constants (gravity −9.8 yd/s²; retail jump v_z formula).
  - Moving platforms (AC lifts): out of scope; if ever needed, manual attach-and-offset (upstream #488 is
    open/Difficult — treat as won't-fix).
- Escape gradient (documented intent): KCC+our rules → fully-owned collide-and-slide on Parry shape-casts
  (~300–500 lines) if KCC fights us. Parry-only build is also the payload-reduction option.

### 1.3 Wire reporting (unchanged protocol)
- `AutonomousPosition` ~1Hz while moving: position + correct cell id + ground-contact byte
  (from controller ground state). Indoor cell id = point-in-EnvCell containment (existing obligation, unchanged).
- `MoveToState` raw motion flags derived from input/velocity (existing classifier path).
- Jump action with retail-formula velocity.

### 1.4 ACE acceptance contract (verified in ace-server source, 2026-08-01)
- `GameActionAutonomousPosition`: no physics validation; stores RequestedLocation unless teleporting.
- `ValidateMovement` rejects only: indoor→indoor cross-landblock, dungeon→dungeon cross-landblock.
- Speed gate: >50 units/update AND >1 landblock away — enormous headroom.
- Z gate: climbing >10u above LastGroundPos without recent jump ⇒ ground-contact verify. Controller ground
  detection satisfies naturally.

### 1.5 Flags / tests / gates
- `?movement=rapier|legacy` (legacy default until gate). Default-on bar: bare-default loads+spawns+0 errors,
  plus walk-parity checks below.
- Cargo tests: golden walks over baked fixtures (real DAT data per house rule) — flat terrain, LB seam crossing,
  stair flight, steep slope rejection, teleport-into-wall depenetration, jump arc vs retail constants.
- Spike checklist (pre-implementation): measure real stair step heights from a hostile dungeon EnvCell;
  LB-seam weld proof; autostep tuning; capsule dims vs retail sphere radii.

## 2. Skinned avatars — players and monsters (one implementation)

- Merge per-part meshes → one `BufferGeometry`; `skinIndex` = part index, weight 1.0 (rigid). Bones = Setup part
  hierarchy — monsters included automatically ("their own skeletons" = each Setup's hierarchy).
- Same `partFrames` data drives bone matrices, written in ONE loop with guards: frame-index clamp
  (retail-clamps-never-empties), NaN guard, translation sanity clamp to model bounds.
- The bone-write loop exposes a **modifier-stack hook** (base pose → per-limb procedural modifiers → final
  matrices) — consumed by §3.2b wound posing and the §3.3 ragdoll blend. Modifiers compose after animation
  sampling; animation data itself is never rewritten.
- Geometry merge in wasm (parts already live there); JS receives one geometry + bone matrix array.
- Equipment: ObjDesc part swap ⇒ rebuild merged geometry from scratch (per-equip-event, never incremental).
  Per-part material groups preserved (`meshToGeometryGroups` path). Palette/texture machinery untouched by this spec.
- Later dial (not gated on): seam-blend weights near joints.
- `?skinnedAvatars=1` until gate. Node test: bone matrices vs legacy per-part group transforms — byte-comparable,
  no eye test needed for correctness; one queued 1070 look-check for confidence.
- **Ordering: this ships first.** Movement (§1) is independent; destruction (§3) hard-depends on this
  (pose baking + bone-parented fragments).

## 3. Destruction — three-pinata + Rapier dynamics

Vendor `@dgreenheck/three-pinata` (MIT, three ≥0.158 — we're on 0.184) into `vendor/` per takram precedent
(no CDN import: serve.py live-source + offline discipline).

### 3.1 Fracture geometry: per-part convex hulls
- At model load: compute convex hull per body part (bone-local space), cache per (setup, part-swap state).
- Hulls are watertight by construction — sidesteps pinata's manifold requirement (raw 1998 meshes are not manifold).
- Hull fragments carry: outer material ≈ part's surface material (tint/triplanar approximation accepted —
  stylized "hewn" look is embraced, it serves the differentiation goal), inner material = damage-type cut-face.

### 3.2 Live-hit progressive destruction
- On qualifying hit: slice the struck part's hull **in bone-local space**; resulting fragments remain rigid
  children of that bone ⇒ wounds animate with the living creature.
- Wounded part's render swaps: original skinned surface (that part's vertex range hidden via material group)
  → bone-parented fragment set. Small chips (a fragment or two) detach as short-lived dynamic gibs.
- Re-slicing (pinata supports progressive cuts) accumulates wounds. Caps: ≤2 re-slices per part;
  global live-wound fragment budget; per-creature budget.
- Dismemberment (optional, flag-gated): a part at max slice depth releases ALL its fragments to dynamics —
  limb severed; bone continues driving nothing (or a stump cap).
- Wound history recorded per corpse → death fracture (§3.3) seeds from accumulated impact points.

### 3.2b Hit location & wound-adaptive posing
**Wire reality (verified 2026-08-01):** `DefenderNotification` (0x01B2) carries `DamageLocation` — hits on US have
authoritative body part. `AttackerNotification` (0x01B0) carries NO location — for OUR hits the client rolls its
own body part: we know our AttackHeight; implement retail-style height→zone chance tables
(low → feet/lowerLegs/upperLegs · mid → upperLegs/abdomen/hands/lowerArms · high → head/chest/shoulders/upperArms).
Server's internal roll only affects armor math; ours only affects visuals — divergence is unobservable.
Damage %, crit, and damage type ride the same messages.

**Skeleton census (at model load):** classify Setup part chains geometrically — chains whose rest-pose extremity
lies in the bottom band of model bounds = legs (counts Olthoi many-leg rigs correctly), upper-torso chains = arms,
topmost = head. Zone roll → specific limb: weighted random biased toward un-wounded limbs, seeded per instance
(never "always the same leg").

**Severity ladder (accumulated damage % on the creature; crit amplifies):**
| Tier | Pose effect |
|---|---|
| ≤25% | none — chips/decals only |
| ≤50% | favor: constant offsets on wounded chain (hip/knee/shoulder droop) + amplitude damp toward rest |
| ≤75% | limp: root-dip synced to wounded leg stride phase + stronger damp; wounded arm = partial-ragdoll blend (reuses §3.3 joint chains) |
| 100% | death sequence (§3.3); crit ⇒ amplified fragments/impulses |

**Mechanism — no new animations, ever:** all effects are a procedural modifier stack applied AFTER sampling the
base MotionTable pose, at the §2 single bone-write site. The Hermite/keyframe animation data is never edited or
re-splined. Many-legged scaling: per-leg effect ∝ 1/legCount; cap concurrent dangling limbs. Foot IK explicitly
out of scope v1 (accept minor foot slide during limp).

### 3.3 Death: ragdoll → fracture
1. Death event: bake current pose (bone matrices → static geometry, in wasm), swap SkinnedMesh → posed snapshot.
2. Ragdoll: Rapier joint chain from the Setup hierarchy — capsule per major bone, spherical joints with limits;
   replaces retail death anims when enabled. Settle by sleep or ≤3s timeout.
3. Fracture the settled corpse per **killing damage type** (table below), fragments → dynamic bodies
   (convex hull colliders), then fade/despawn.

### 3.4 Damage-type table
| Damage | Fracture | Fragment treatment |
|---|---|---|
| Slash | `sliceWorld` along swing plane (re-slice on multi-hit) | clean cut faces |
| Pierce | impact-concentrated Voronoi, low count, tight radius | puncture cluster at impact |
| Bludgeon | coarse Voronoi (3–8), radial impulse from impact | heavy chunks |
| Fire | standard fracture | emissive-edge dissolve shader |
| Cold | many small shards (higher count, brittle scatter) | ice material, sharp restitution |
| Acid | standard fracture | tint + melt (scale/sink over lifetime) |
| Electric | standard fracture | char + jittered impulses |
- Elemental shaders obey vfx-write-invariant: cloned uniforms only, no light-count changes, no per-instance
  customProgramCacheKey churn.

### 3.5 Physics & perf budgets
- Fragments: dynamic bodies, convex colliders, collide vs static world ONLY (no fragment-fragment), despawn
  fade 4–8s, pooled meshes/bodies.
- ≤1 fracture event resolved per frame (queue deaths); global live-fragment cap (initial: 64, tune on 1070);
  fracture ops are synchronous main-thread — per-part hulls keep them sub-ms; author guidance 10–50 fragments
  per event respected.
- Shares the §1 Rapier world — one physics instance for movement + gibs.

### 3.6 Flags / tests / gates
- `?destruction=off|hits|death|full` (default off until gate; "full" = progressive + ragdoll + fracture).
- Node tests: hull generation per part (watertight assert), bone-local slice determinism, budget/cap enforcement,
  despawn lifecycle. Visual quality (hewn look, ragdoll feel, elemental reads) = queued 1070 batch items.

## 4. Build order & dependency graph

```
Phase A  Skinned avatars (§2)            — prerequisite for C; independent of B
Phase B  Rapier movement (§1)            — independent; shares Rapier world with C
Phase C  Destruction (§3)               — needs A (pose bake, bone fragments) + B's world (dynamics)
   C1 death-only fracture (validates pinata+hulls+budgets with smallest surface)
   C2 ragdoll phase
   C3 progressive live-hit destruction (+ optional dismemberment)
```
Each phase lands flag-gated → node/cargo tests green → queued 1070 batch → default-on per house bar.

## 5. Risks (acknowledged)
- Rapier KCC gaps → mitigated by owned policy layer + documented escape gradient (§1.2).
- Hull "hewn" aesthetic may read too coarse on large monsters → 1070 judgment; upgrade path = baked watertight
  destruction proxies (bake-side remesh) without touching the rest of the pipeline.
- Progressive destruction is the novel/experimental piece → sequenced LAST (C3) so A/B/C1 value lands regardless.
- Ragdoll joint tuning is fiddly wall-clock → C2 timeboxed; instant-fracture (C1) is the shipped fallback.
- Wounded-part render swap changes draw batching for wounded creatures → watch instanced-anim-scenery interplay.
