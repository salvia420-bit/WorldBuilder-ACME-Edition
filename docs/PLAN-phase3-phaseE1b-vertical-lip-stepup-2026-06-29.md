# PLAN — Phase 3 CTransition · Phase E1b: faithful vertical-lip step-up (curbs / stairs / ledges), default-ON

**Status:** plan of record for E1b (the E1 redo). Written 2026-06-29 from the E1 workflow + a deep
mechanism investigation (agent add3f415). Builds on committed Phase D (`69a782b8`); E1's uncommitted
working-tree changes are present and partly **to be reverted** (see §1). Executor: ultracode / Opus-4.8, local.

---

## 0. Why E1b (what E1 v1 got wrong)

E1 v1 made a grounded mover climb walkable **slopes/ramps** — but that already worked via Phase C/D
surface-tracking; E1's actual code change (the `driver_validate.rs:436` up-offset early-stop relaxation +
`?stepUp` flag) is a **non-faithful no-op** (ON==OFF byte-identical in live play; the recon §2 of the E1 plan
explicitly warned against that hook). The over-climb threshold concern was **disproven** (threshold is
faithfully enforced as the `step_down` budget). The REAL, still-missing behavior is genuine **vertical-lip
step-up**: lifting over a curb / stair riser / ledge shorter than `step_up_height`. Today holtburger gets
**stuck at `face − radius`** for any vertical lip, even a 0.3 m one.

## 1. The mechanism (grounded in acclient.c — DO NOT invent a raise)

The lift is **emergent**, not an explicit raise. Sequence for a grounded CONTACT mover walking into a curb
(radius 0.4, curb 0.3, step_up_height 0.6):
1. Outer sweep commits `check_pos` forward → sphere **penetrates** the curb (lower hemisphere overlaps the
   curb-top poly). (`find_transitional_position` acclient.c:313298 / holtburger `driver_validate.rs:475-482`.)
2. `transitional_insert` → `BSPTREE::find_collisions` (361296), CONTACT branch (361410) → `sphere_intersects_poly`
   hits the riser → **`BSPTREE::step_sphere_up`** (361072, ungated wrapper) → `CTransition::step_up(faceNormal)`.
3. **`CTransition::step_up`** (312794): set `step_up=1`; **if `ON_WALKABLE`** → `step_down_ht = step_up_height`,
   `walkable_z = get_walkable_z()` (312810-312813); backup check_pos; call `step_down`.
4. **`CTransition::step_down`** (312629): `step_up` set ⇒ the `if(!step_up)` downward-lower (312648) is **skipped**
   (check_pos stays penetrating); `transitional_insert(5)`.
5. `find_collisions` with `step_down=1` → **`BSPTREE::step_sphere_down`** (361177): builds
   `movement = -(step_down_amt·walk_interp)·z = -0.6·(+z)` (straight DOWN) → `find_walkable`.
6. `find_walkable` → `walkable_hits_sphere` (top poly walkable AND sphere overlaps) → **`CPolygon::adjust_sphere_to_plane`**.
7. **`adjust_sphere_to_plane`** (the ONLY Z-change): `dp_pos = N·center+D`, `dp_move = N·movement = -0.6`,
   `iDist = (dp_pos − radius)/dp_move` (positive for a penetrating sphere); `validPos.Center -= movement·iDist`
   → since `movement` points down and `iDist>0`, the center moves **UP** onto the top (rests `radius` above it).
8. `step_down` sees contact plane = top poly (N=+z, walkable, `N.z ≥ zVal`) → `transitional_insert(1)` re-pin →
   returns 1; `step_up` returns 1. **Climb succeeds.**

**The height gate is emergent** (no explicit `if step_up_height < …` on the polygon path — that 359083 gate is
the sphere-vs-sphere path only): a curb is climbable iff the penetrating sphere can still **reach/overlap** the
top poly (bounded by radius + forward penetration) AND the `adjust_sphere_to_plane` **interp window**
(`interp = (1−iDist)·walk_interp`, rejected if `interp ≥ walk_interp || interp < −0.5`, capping `iDist ≈ H/step_up_height`)
admits it. Shorter than ~step_up_height ⇒ climbs; taller ⇒ `find_walkable` finds nothing ⇒ `step_down` 0 ⇒
`step_up` 0 ⇒ `step_up_slide` ⇒ slide/stop. **This IS the faithful "too tall ⇒ stop", no hand-coded threshold.**

## 2. The actual gap = an `ON_WALKABLE` precondition bug (NOT a missing function)

All primitives are present + faithfully ported and wired: `adjust_sphere_to_plane` (`polygon_adjust.rs`),
`step_sphere_down`/`find_walkable`/`walkable_hits_sphere` (`resolver_find.rs:133-144`), `step_up_impl`/`step_down`
(`driver_spine.rs:410-442` / `:345-386`), CONTACT→`step_sphere_up` (`resolver_find.rs:210-222`).

The lift fires only when `step_up` uses `step_up_height` as the step-down budget — gated on **`ON_WALKABLE`**
(`driver_spine.rs:420-423`, faithful to acclient.c:312810). But holtburger's grounded mover does **not** carry
`ON_WALKABLE` into the transition:
- `ObjectInfo::for_local_player` stamps `CONTACT | EDGE_SLIDE` only — **no `ON_WALKABLE`** (`transition.rs:104-107`);
  and `faithful_find_transitional_position` **re-stamps** `t.object_info.state = input.object.state` every frame
  (`faithful_bridge.rs:805`), dropping any latched `ON_WALKABLE`.
- `ON_WALKABLE` is latched only at the END of a transition by `validate_transition` from a walkable contact plane
  (`driver_validate.rs:185-194`). On a dz=0 horizontal live walk no step-down runs ⇒ no floor contact ⇒ never latched.

⇒ at the curb, `ON_WALKABLE` clear ⇒ `step_up` uses the **0.04 default budget** ⇒ `step_sphere_down` descends only
0.04 ⇒ never overlaps the curb top ⇒ no lift ⇒ slide ⇒ **stuck at `face − radius`** (empirically x≈9.601 for a
riser at 10.0, at every height incl. 0.3 < step_up_height). Code self-flags at `faithful_bridge.rs:862-865`.

## 3. THE CENTRAL RECON QUESTION (WS-A, do FIRST, read-only, gating)

Restore `ON_WALKABLE` faithfully. From acclient.c, decide the MINIMAL faithful change (least regression surface):
- **(a) Persist grounded state across frames** — thread the persistent grounded `ON_WALKABLE` into the per-frame
  transition input instead of re-stamping `CONTACT|EDGE_SLIDE` (seam: `transition.rs:98-117` `for_local_player`,
  the per-frame stamp `faithful_bridge.rs:805`, fed from `movement/system.rs`).
- **(b) Faithful grounded per-frame gravity/sink** — retail's grounded mover is never dz=0; it applies a small
  downward motion each frame so `validate_transition` re-latches `ON_WALKABLE` from the floor contact plane
  (`driver_validate.rs:185-194`).
- Retail does BOTH; determine which holtburger needs (likely (b) is the true root cause — the dz=0 live model is
  the divergence — with (a) as a complement). **WS-A must answer: what exactly does retail's grounded mover do
  each frame to keep `ON_WALKABLE` set, and what is the smallest faithful holtburger change that reproduces it
  WITHOUT regressing C/D movement?** Output: the chosen approach + exact seams + regression risks. NO code.

## 4. Work-streams

> Ground in acclient.c (wins); ACE readable ref (`Transition.cs`/`Sphere.cs`/`Polygon.cs`); Chorizite offsets.
> capped-build only, one build at a time. Default-ON + `?stepUp=off`. No commits. ace-server reference-only.

- **WS-A — recon (read-only, gating):** answer §3. Pick approach (a)/(b)/both; name seams; assess regression.
- **WS-B — revert E1 v1's no-op:** remove the `driver_validate.rs:436` up-offset early-stop relaxation
  (`allow_contact_stepup`) and the dead bits, restoring the faithful early-stop verbatim. **Keep** the `?stepUp`
  flag plumbing but **repurpose** it to gate the REAL E1b fix (WS-C). Keep the E1 climb tests that still pass.
- **WS-C — implement the faithful `ON_WALKABLE` fix** per WS-A (state persistence and/or grounded gravity), gated
  by `?stepUp` default-ON, so `step_up` gets the `step_up_height` budget and the existing
  `step_sphere_down`/`adjust_sphere_to_plane` chain lifts the mover. NO new raise; NO hand-coded threshold.
- **WS-D — tests:** the curb-straddle A/B is the headline — a **0.3 m vertical curb CLIMBS** onto its top
  (feet z rises ~0.3), a **1.0 m curb STOPS** (the emergent reach/interp gate), with `?stepUp=off` reverting to
  stuck-at-base. Plus: walkable **slopes still climb** (don't regress E1's working slope behavior); **steep cliff
  still stops** (Phase D); **C/D drift suite still green** (movement-state change ⇒ regression risk); **no jitter**
  (monotonic settle, no oscillation on the curb top).

## 5. Seam map
`$HD = .../holtburger-dat/src/transition` · `$HW = .../holtburger-world/src/spatial` · core = `.../holtburger-core/src/client`
- `transition.rs:98-117` `ObjectInfo::for_local_player` (state stamp — add/persist `ON_WALKABLE`).
- `$HW/faithful_bridge.rs:805` per-frame `t.object_info.state = input.object.state` re-stamp (the dropper).
- `core/movement/system.rs` — source of the per-frame object state / grounded flag; grounded-gravity behavior.
- `$HD/driver_spine.rs:420-423` — the budget consumer (`if ON_WALKABLE { step_down_ht = step_up_height }`).
- `$HD/driver_validate.rs:185-194` — where `ON_WALKABLE` latches from a walkable contact plane; `:436` — the
  E1 v1 no-op relaxation to REVERT.
- `$HD/polygon_adjust.rs` (`adjust_sphere_to_plane`, the emergent lift), `resolver_find.rs:133-144 / :210-222`,
  `driver_spine.rs:345-386 / :410-442` — all faithful, DO NOT change (verify only).
- Flag: `core/movement/{system.rs,handle.rs}` (`USE_FAITHFUL_STEPUP` / `?stepUp`), `apps/holtburger-web/src/lib.rs`,
  `docs/url-flags.md`.

## 6. Tests / build
- `capped-build ~/.cargo/bin/cargo test -p holtburger-dat --lib transition::` (≥256)
- `capped-build ~/.cargo/bin/cargo test -p holtburger-world --lib spatial::faithful_bridge::drift` (curb-straddle
  A/B + slope-still-climbs + cliff-stops + no-jitter; keep C/D regressions green)
- `capped-build ~/.cargo/bin/cargo check -p holtburger-core` ; `capped-build wasm-pack build --target web --out-dir pkg --dev`
- Headline: print feet-z for 0.3 curb (climbs ~+0.3) and 1.0 curb (stuck at base) with `?stepUp` on/off.

## 7. Risks
- **Movement-state-machine regression** — `ON_WALKABLE`/grounded-gravity touches ALL movement (indoor/outdoor,
  C/D). The C/D drift suite is the regression guard; WS-A must scope the minimal change.
- **Grounded gravity vs dz=0 live model** — if approach (b), the per-frame sink must not introduce sink-through,
  jitter, or fall-through; bound it (retail's small grounded settle). Watch the Discord jitter gotcha.
- **Emergent gate tuning** — confirm the reach/interp window reproduces retail's climbable-height feel; the
  curb-straddle test brackets it (0.3 climbs / 1.0 stops). Don't hand-code a threshold.
- **Don't regress E1's working slope/ramp climb.**

## 8. Definition of done
1. A grounded mover climbs a vertical curb/stair/ledge shorter than `step_up_height` (feet rise onto the top) and
   STOPS at one taller — via the faithful emergent chain (`ON_WALKABLE` budget → `step_sphere_down` →
   `adjust_sphere_to_plane`), no invented raise, no hand-coded threshold.
2. E1 v1's non-faithful no-op relaxation reverted; `?stepUp=off` now meaningfully reverts to stuck-at-base (real A/B).
3. Slopes still climb; cliffs still stop; C/D drift + transition:: suites green; core clean; wasm rebuilt; no jitter.
4. ace-server untouched; no retail quirks "fixed"; commit a clean E1 checkpoint.
