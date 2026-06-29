# PLAN — Phase 3 CTransition · Phase E1: walkable step-up / slope & ledge climbing (default-ON)

**Status:** plan of record for Phase E1, first of the Phase E loop (E1 step-up → E2 cross-portal → E3 polish+validate+ship).
Written 2026-06-29 from a 6-source sweep (decomp `acclient.c/.h`, `acclient.txt` PDB, Chorizite ACBindings
offsets, ACE `ACE.Server.Physics` reference, holtburger source, dev-Discord gotchas). Builds on committed
Phase D (`69a782b8`). **Intended executor:** ultracode / Opus-4.8, run locally. Self-contained.

---

## 0. Decision record (read first)

- **Scope:** make movers CLIMB walkable up-slopes / ramps / stairs / ledges instead of stopping at the base —
  the gap BOTH Phase C (wall/ledge) and Phase D (slope) documented. This is the unported behavior of
  `CTransition::step_up` / `CSphere::step_sphere_up` (the twin of the already-ported `step_down`).
- **MAJOR FINDING — step_up is ~90% ALREADY PORTED.** The infrastructure exists (see §3). The missing piece is
  the **faithful invocation wiring**: today a grounded CONTACT mover walking into a walkable up-slope is
  early-stopped at `driver_validate.rs:415-422` and never climbs. E1 is therefore **small but subtle** — it is
  a *wiring + faithfulness* task, NOT a from-scratch port.
- **THE CENTRAL QUESTION (resolve from acclient.c, §2):** *where does retail actually invoke step_up when a
  grounded mover walks into a walkable up-slope?* The up-offset early-stop (`driver_validate.rs:415`,
  faithful to decomp 313269-313274) is NOT obviously the hook. Retail invokes step_up from the COLLISION path
  (`CSphere::step_sphere_up`, decomp 359072) and the negative-poly path — already partly wired. Do NOT blindly
  hook step_up into the validate gate; first prove the faithful path against the decomp.
- **TERRAIN INTERACTION (carry from Phase D):** Phase D WS3 routed outdoor terrain through `validate_walkable`
  (find_terrain_poly + slope check), *not* the swept-sphere resolver where `step_sphere_up` lives. So an outdoor
  terrain up-slope may never reach the climb path. E1 must determine, from acclient.c, how retail climbs a
  TERRAIN up-slope (via step_sphere_up on the terrain poly, vs the terrain/validate_walkable height path) and
  wire it faithfully for BOTH indoor BSP geometry AND outdoor terrain.
- **Default-ON** with a `?flag=off` escape (memory `default-on-no-eyetest-gate`); the climb must be toggleable so
  the drift A/B can show climb-on vs stop-at-base.
- **Fidelity rule (Discord-reinforced):** preserve retail movement quirks; do not "improve" them
  (Dekaru, chorizite 2025-02-11: "100% fidelity with the client"). acclient.c wins on any disagreement;
  ACE is the readable Rosetta stone; Chorizite offsets corroborate. ACE is REFERENCE ONLY (no server/DB data).

---

## 1. Convergent mechanism (all sources agree)

- **step_up REUSES step_down.** `CTransition::step_up(collision_normal)` (decomp 312794 / ACE `Transition.cs:746`)
  sets `SpherePath.step_up=true`, stores `step_up_normal`, backs up check_pos, then calls
  `step_down(step_up_height, walkable_z)`. `step_down` (decomp 312629 / ACE `Transition.cs:710`) **skips the
  downward z-offset when `step_up` is set** (`if (!step_up) { offset.z = -h; … }`) — so it searches for the
  walkable surface from the elevated collision point instead of probing down. On failure, restore check_pos.
- **The decision gate** (`CSphere::step_sphere_up`, decomp 359072 / ACE `Sphere.cs:686`):
  `if (step_up_height < radsum + EPSILON − disp.z) return slide_sphere(); else { compute collision_normal;
  if step_up(normal) OK else step_up_slide(); }`. **EPSILON = 0.0002** (confirmed both sides). Too tall ⇒ slide;
  climbable ⇒ step, with a slide fallback.
- **step_up_height source:** `CSetup.StepUpHeight * scale.z`, default `0.01` (`PhysicsGlobals.DefaultStepHeight`);
  the `step_up` entry itself uses `0.04` as the non-walkable fallback `step_down_ht`. Climbing is STRICTER than
  falling (step_up_height < step_down_height).
- **Post-step walkability:** `step_down`'s success gate requires `contact_plane.N.z >= walkable_z` and (for
  walking, unless step_up bypasses EdgeSlide) `check_walkable(z)` (ACE `Transition.cs:206`). Walkability is
  angle-based (Discord trevis/OptimShi: slope-only; deep water unwalkable).

---

## 2. THE CENTRAL FAITHFULNESS QUESTION (workstream WS-A, do FIRST, read-only)

Before touching code, an agent must answer from **acclient.c** (cross-check ACE), with line cites:
1. **Trace the retail spine** for a grounded CONTACT mover walking horizontally into a walkable up-slope:
   `find_transitional_position` → `transitional_insert` → `insert_into_cell` → `find_collisions` →
   `CSphere::collide_with_pt`/`step_sphere_up`. At what point is `step_sphere_up` called, and does control reach
   the up-offset early-stop (decomp 313269-313274) BEFORE or only if step_sphere_up declines?
2. **Is the `driver_validate.rs:415-422` up-offset early-stop reached on a normal walk-into-slope, or only on
   non-walkable overhangs?** i.e. is the current early-stop *correct retail behavior that fires only when climbing
   legitimately fails*, or is holtburger missing an earlier step_sphere_up call that retail makes first?
3. **Terrain:** how does retail climb a TERRAIN up-slope? Does `CLandCell::find_collisions` run the terrain polys
   through the swept-sphere `step_sphere_up` path, or does the terrain/`find_terrain_poly`+`ValidateWalkable`
   path raise the mover? (This decides whether Phase D's validate_walkable terrain routing needs a step_up hook.)
4. **Output:** a precise statement of the faithful invocation path(s) for indoor BSP and outdoor terrain, naming
   the exact holtburger seam(s) to change, and explicitly confirming/refuting the holtburger-survey's proposed
   "hook step_up into the validate up-offset gate" fix. The implementation WS depend on this verdict.

---

## 3. Current-state seam map (what's ported vs missing)

`$HD = $REPO/external/holtburger/crates/holtburger-dat/src/transition`

| Piece | File:line | State |
|---|---|---|
| `step_up_impl` (entry: flags, backup, reuse step_down, restore) | `$HD/driver_spine.rs:410-442` | ✅ ported |
| `step_up` shim (recovers world from DriverCtx) | `$HD/driver_spine.rs:398-403` | ✅ ported |
| `step_down` (suppresses down-offset when `step_up`) | `$HD/driver_spine.rs:345-386` | ✅ ported |
| `resolver_step_down::step_sphere_down` (serves BOTH modes via flag) | `$HD/resolver_step_down.rs:61-166` | ✅ ported |
| `resolver_slide::step_sphere_up` → `transition.step_up(&gnormal)` | `$HD/resolver_slide.rs:188-203` | ✅ ported |
| neg-poly path calls `step_up_impl` | `$HD/driver_spine.rs:226-258` (call `:251`) | ✅ ported |
| `step_up_slide` fallback | `$HD/spherepath_methods.rs:267-303` | ✅ ported |
| `SpherePath` fields (step_up, step_up_normal, neg_step_up, walkable*, …) | `$HD/types.rs:305-391` | ✅ all present |
| `CollisionInfo` (contact_plane, collision_normal, sliding_normal, setters) | `$HD/types.rs:257-286` | ✅ present |
| `ObjectInfo.step_up_height` / `step_down_height` | `$HD/types.rs:237-250` | ✅ present |
| walkable validation (`resolver_check_walkable`, `polygon_walkable`, `bspnode_walkable`) | — | ✅ present |
| **up-offset early-stop gate** (the suspected blocker) | `$HD/driver_validate.rs:415-422` | ⚠ **faithful retail; WS-A decides if it's the hook** |
| **`ObjectInfo` step_up enablement flag** (has `step_down: bool`, NO `step_up: bool`) | `$HD/types.rs:243-249` | ❌ likely add |
| **the faithful climb invocation for a grounded walk-into-slope (indoor)** | per WS-A | ❌ wire |
| **terrain up-slope climb (outdoor; Phase D validate_walkable path)** | per WS-A | ❌ wire |
| **gate threshold parity** `step_up_height < radsum + 0.0002 − disp.z` | check in `resolver_slide`/`sphere_*` | ⚠ verify exact |
| **step_up_height data wiring** (`CSetup.StepUpHeight * scale.z`, default 0.01) | ObjectInfo init / live feed | ⚠ verify real values feed in, not 0 |

---

## 4. Cross-source reference table (port-from)

| Concept | decomp `acclient.c` | ACE (REF) | Chorizite offset | holtburger |
|---|---|---|---|---|
| step_up entry | `CTransition::step_up :312794` | `Transition.cs:746` | `0x0050C0E0` | `driver_spine.rs:410` |
| step_down (down-offset suppress) | `:312629` | `Transition.cs:710` | `0x0050BD70` | `driver_spine.rs:345` |
| step_sphere_up (gate) | `CSphere::step_sphere_up :359072` (gate `:359083`) | `Sphere.cs:686` | `0x00538640` | `resolver_slide.rs:188` |
| step_sphere_down (twin) | `:358616` | `Sphere.cs` | `0x00537A60` | `resolver_step_down.rs:61` |
| step_up_slide fallback | `SPHEREPATH::step_up_slide :313456` | `SpherePath.cs:309` | `0x0050CE80` | `spherepath_methods.rs:267` |
| check_walkable (post-step) | `CTransition::check_walkable` | `Transition.cs:206` | `0x0050BAC0` | `resolver_check_walkable.rs` |
| up-offset early-stop | `:313269-313274` | (in TransitionalInsert) | — | `driver_validate.rs:415` |
| step_up_height source | `GetStepUpHeight :315701/325400` | `PartArray.cs:243` (`*Scale.Z`, def 0.01) | — | ObjectInfo init |
| EPSILON | `0.0002` | `PhysicsGlobals.EPSILON` | — | verify const |

Struct field offsets (from `acclient.txt`): OBJECTINFO@12 step_up_height, @16 step_down_height;
SPHEREPATH@244 step_up, @248 step_up_normal, @440 walkable_allowance, @448 step_down_amt, @468 walkable;
COLLISIONINFO@28 contact_plane.

---

## 5. Work-streams

> Every WS: ground in acclient.c (wins), port-from ACE, cross-check Chorizite offset. capped-build only, one
> build at a time. Default-ON + `?flag=off`. No commits. ace-server reference-only.

### WS-A — Faithful invocation recon (READ-ONLY, gating)  → answers §2
Produce the verdict in §2 (indoor + terrain climb paths, the exact seams, confirm/refute the validate-gate hook).
All implementation WS consume this. **Output is a short spec, no code.**

### WS-B — Wire the faithful climb (indoor BSP geometry)
Per WS-A, wire `step_sphere_up`/`step_up_impl` into the path a grounded CONTACT mover takes when it hits a
walkable up-slope/ledge in an env cell, so it climbs instead of early-stopping. Likely touches
`driver_validate.rs` (the up-offset gate) and/or `resolver_find.rs`/`resolver_slide.rs` dispatch — exact site per
WS-A. Verify the gate threshold `step_up_height < radsum + 0.0002 − disp.z` matches retail exactly. Add
`ObjectInfo.step_up` enablement if WS-A shows retail gates on it.
- **Tests (drift A/B):** grounded mover walks into a climbable indoor ledge/ramp → climbs (feet z rises to the
  top); same with climb OFF → stops at base. A too-tall wall → does NOT climb (slides/stops), proving the
  threshold. No jitter/oscillation at the step edge (assert monotonic progress, no position bounce).

### WS-C — Terrain up-slope climb (outdoor)
Per WS-A, ensure outdoor terrain up-slopes climb faithfully. If retail climbs terrain via `step_sphere_up` on the
terrain polygon, route Phase D's terrain path (currently validate_walkable-only) through the climb; if retail
raises the mover via the terrain height/validate_walkable path, confirm holtburger matches. Reuse the WS2 terrain
`ResolvedPolygon`s.
- **Tests (drift A/B):** grounded mover walks up a real outdoor terrain slope → ascends, feet track
  `terrain_height_at` up the grade (this is the test Phase D WS3 had to skip); climb OFF → stops at slope base.
  Cliff (too steep) → still stops (Phase D behavior preserved).

### WS-D — Flag + data wiring
- WS9-style: `USE_FAITHFUL_STEPUP` const (default true) + `?stepUp=off` escape, mirroring the
  `USE_FAITHFUL_OUTDOOR` plumbing (system.rs/handle.rs/lib.rs + url-flags.md). Thread into the WS-B/WS-C sites.
- Verify `step_up_height` is fed real values (`CSetup.StepUpHeight * scale.z`, default 0.01) for the player
  capsule, not 0 — a 0 height silently disables all climbing. Trace ObjectInfo init / the live feed.

---

## 6. Tests & validation
- `capped-build ~/.cargo/bin/cargo test -p holtburger-dat   --lib 'transition::'`   (keep ≥256)
- `capped-build ~/.cargo/bin/cargo test -p holtburger-world --lib 'spatial::faithful_bridge::drift'` (≥19 + new
  climb A/B: indoor ledge climb on/off, outdoor slope climb on/off, too-tall no-climb, no-jitter)
- `capped-build ~/.cargo/bin/cargo check -p holtburger-core`
- `capped-build wasm-pack build --target web --out-dir pkg --dev`
- **Headline proof:** indoor ledge AND outdoor slope — climb-ON ascends, climb-OFF stops at base; print feet-z
  start/end for both. Plus a too-tall-wall test proving the threshold gate.
- Live headless (deferred to E3 with C/D): `phase4demo` harness; not required to land E1.

## 7. Risks & gotchas (Discord-sourced — bake into tests)
- **Jitter / "magnetism" at step edges** (bosh scranson, Hells "jitter is our enemy") — assert no per-step
  position oscillation; the climb must settle, not bounce.
- **Getting stuck on tiny obstacles / ramps** (Variegated BBQ) — ensure the gate lets real slopes through;
  too-conservative threshold = can't climb viable slopes.
- **step_up_height = 0 silently disables climbing** — the #1 footgun; WS-D must verify real values feed in.
- **Landblock-edge fall/slide cascade** (gmriggs "landblock loading virus") — climbing near a boundary must not
  trigger neighbor-load cascades; bound like Phase D.
- **Preserve retail quirks** (Dekaru) — if retail's early-stop is correct for overhangs, keep it; only add the
  climb where retail climbs. Do not "fix" powerslide/other quirks.
- **Terrain vs BSP split** — the climb must work for both; outdoor terrain went through validate_walkable in D.

## 8. Build / paths
Same discipline as Phase D §7 (capped-build, full toolchain paths, one build at a time, kill rust-analyzer to
reclaim RAM). Driver crate `$HD`; flags in `holtburger-core/src/client/movement/{system.rs,handle.rs}` +
`apps/holtburger-web/src/lib.rs` + `docs/url-flags.md`. Branch: continue on `feat/phase3-phaseD-outdoor-terrain`
or a new `feat/phase3-phaseE-stepup` (orchestrator decides; D is committed at `69a782b8`).

## 9. Definition of done
1. Grounded movers climb walkable up-slopes/ramps/stairs/ledges (indoor BSP + outdoor terrain), default-ON,
   `?stepUp=off` rollback.
2. The faithful invocation path is grounded in acclient.c (WS-A), not a guessed validate-gate hook.
3. Too-tall obstacles still don't climb (threshold proven); cliffs still stop (D preserved); no jitter.
4. `step_up_height` fed real values. Unit suites green (transition:: ≥256, drift ≥19 + climb A/B); core clean;
   wasm rebuilt.
5. No retail quirks "fixed"; ace-server untouched; no commits beyond what the orchestrator checkpoints.
