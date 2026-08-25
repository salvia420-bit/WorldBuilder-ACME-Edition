# HANDOFF — Phase 3 CTransition: Phase C DONE + default-ON; Phase D is next (2026-06-28, EOD)

**Supersedes the status sections of** `docs/HANDOFF-phase3-ctransition-2026-06-28.md`
(that one's §4 "blocking bug" was disproven — keep it for the §4/§8 background, but
this doc is the current state of record).

**All Phase 3 work is MERGED to `origin/master`** (fast-forward `2fb81188..e993acd2`).
The feature branch `feat/phase3-ctransition-driver` is also on origin (tracking).
The faithful CTransition driver is **default-ON** for indoor movement.

---

## 1. Phase status (the B4 "wire it live" sub-phases A–E)

| Phase | What | Status |
|---|---|---|
| **A** | `SpatialScene→CObjCell` bridge + dispatcher + flag (`faithful_bridge.rs`) | ✅ `4a0a541a` |
| **B** | drift A/B harness + marshalling shape settled (`mod drift`) | ✅ `f0c4c803` |
| **C** | **in-cell statics** — `find_obj_collisions` + cell re-seat + wasm live-feed | ✅ `380eb8f1` + `ba7ed2a8` |
| **D** | **outdoor terrain parity** | ⛔ **NOT done** — the next frontier (see §4) |
| **E** | flip `USE_FAITHFUL_TRANSITION` default-ON | ✅ `e993acd2` |

Plus the investigation that disproved the old §4 "blocking bug": `1680b197` (grounded
walker stops at wall), `a87bf0ad` (airborne stop is faithful too). And B1–B3 (the
driver/resolver build) below A: `e7d18fa2 57819827 60135a12 081892e9 08ba5b4a`.

**Yes — Phase C is finished.** Phase D was *intentionally* left for last and is
independent of the default-on flip (see §3).

---

## 2. What's LIVE now (routing with default-ON)

`faithful_find_transitional_position` (`faithful_bridge.rs:393`) routes per-pose:
- **Indoor, baked cell** → **faithful driver**: env-cell BSP (walls/floor) **+ in-cell
  STATICS** (doors/props/furniture) via `SceneObjCell::find_obj_collisions`. ← Phase C, NEW default.
- **Outdoor** (`!begin.is_indoors()`, `faithful_bridge.rs:398`) → **delegates** to the
  existing heightfield pipeline (`find_transitional_position`). Unchanged.
- **Indoor, UNbaked cell** (no `cell_physics_bsp`, `:408`) → delegates (pre-bake guard).

So default-ON changed **only indoor-baked movement** to faithful. Outdoor + unbaked
keep the battle-tested approximate path. `?faithfulTransition=on` still forces the
faithful path when the const is off (rollback = revert the const, `system.rs:577`).

---

## 3. Why Phase E (default-ON) was safe before Phase D

The faithful path is **indoor-only**; outdoor delegates to the working heightfield.
Flipping default-ON therefore can't regress outdoor movement — it only swaps the
indoor-baked path to the (now validated) faithful driver. Validation that cleared the
bar (memory `default-on-no-eyetest-gate`: "loads+spawns+0 errors"):
- **Unit**: `holtburger-dat` `transition::` = **252 pass, 0 ignored**; `holtburger-world`
  `mod drift` = **9 pass** incl. `faithful_static_object_stops_mover` (mover stops at a
  static wall x=10.40 vs control walks through 12.00); the 2 `position_manager` fails are
  pre-existing/unrelated.
- **Live feed (in-world)**: headless boot drained **4 real static BSPs** from real DAT
  env-cells into `scene.cell_static_physics_bsp` (`[bsp] drained … cell STATIC physics BSPs`).
- **Live A/B (in-world)**: `faithful` on **and** off both reach in-world, stay grounded
  over a 10s walk, **0 errors / no fall-through**.

---

## 4. ⛔ PHASE D — outdoor terrain parity (the next frontier)

**Goal:** make OUTDOOR movement use the faithful CTransition driver too, instead of
delegating to the heightfield pipeline.

**Why it's blocked / hard:** the faithful resolver sweeps a swept-sphere against a
**physics BSP + resolved polygons**. Indoor cells have that (`cell_physics_bsp`).
**Outdoor terrain has NO physics BSP** — it's a bilinear **heightfield** (the existing
`TransitionEnv::terrain_height_at`/`terrain_normal_at`). So Phase D needs one of:
1. **Port retail's outdoor land collision** (`CLandCell` / `add_all_outside_cells` +
   the terrain-polygon collision) into the faithful driver — the proper, decomp-faithful
   route. This is a *new layer* (the landscape/terrain collision), comparable in size to
   the resolver layer. The seams already exist as no-ops/traits:
   - `SceneWorld::add_all_outside_cells` (`faithful_bridge.rs:356`) — currently a **no-op**
     (Phase A). Phase D wires it to flood the outdoor cell ring.
   - The driver's `Landscape` / `LandDefsSeam` traits (`objcell.rs`) + `add_cell_block` /
     `check_add_cell_boundary` (`objcell.rs:561/586`) — the neighbor-ring machinery,
     **already ported**, just not fed outdoors.
   - A terrain collision surface: either synthesize terrain physics polygons per landblock
     from the heightfield, or special-case the resolver to collide against the heightfield
     (retail does the latter via the land-cell terrain polys).
2. **Outdoor buildings + outdoor statics**: outdoor buildings have physics
   (`building_physics_index` / SetupModel parts), and outdoor statics have BSPs
   (`statics_physics_bsp`, outdoor twin of the Phase-C `cell_static_physics_bsp`). Phase D
   would route these through the faithful driver via `add_all_outside_cells` instead of the
   current approximate AABB/pushout (`resolve_static_bsp_pushout`).

**Related community-confirmed risk (carry into Phase D)** — the adjacent-landblock /
off-center-building walk-through (Vanquish420, worldbuilder 2026-02-11): retail/ACE only
checks the player's current 24×24 cell, so an off-center building's BSP overruns the cell
boundary and you walk through it from the neighbor cell. The faithful `find_cell_list` +
`add_all_outside_cells` model the full cell-ring, so wiring Phase D's neighbor loading is
the chance to fix this (load the 3×3 ring at outdoor cell transitions).

**Until Phase D lands, outdoor stays on the heightfield path — which works.** Phase D is a
fidelity upgrade, not a bug fix.

---

## 5. Phase C — remaining refinements (NOT blockers; documented in-code as VERIFY)

- **`SceneObjCell::point_in_cell` uses the cell AABB**, not the precise cell-membership
  BSP (`CellMembership` / `CellStruct.cell_bsp`, which the scene already carries). Adequate
  for the single-cell indoor sweep; refine for cross-portal precision. (`faithful_bridge.rs`
  `aabb` field + `point_in_cell`.)
- **Per-static scale not applied** — `CellPhysicsBsp` carries no scale; statics are treated
  unscaled (framed to world via origin/orientation), matching the outdoor path.
- **Cross-portal cell collision** — `find_transit_cells` floods portal neighbours with NULL
  handles; only the primary cell is collision-tested. Cross-portal sweeps need the live cell
  graph (a `'static` cell can't hold the scene ref). (`faithful_bridge.rs:153` VERIFY.)
- **Combined in-world position A/B not run** — the "walk into THIS static, measure stop"
  single-number test. Mechanism is proven by the drift test + the live feed independently,
  so this is confirmation-grade. Needs movement scripting to a known static-wall spot.
- **Other carried VERIFY(1070)**: quaternion `set_rotate`/SLERP for orientation-changing
  sweeps (Frame has no quaternion; player capsule is upright so identity-frame is fine for
  now); EnvCell `water_type` through the cell adapter; real `CPhysicsObj` velocity.

---

## 6. ⚠ DEPLOY — default-ON is in the SOURCE, not yet in the shipped wasm

`USE_FAITHFUL_TRANSITION` is a Rust `const` compiled **into the wasm**. The source is
default-ON on origin/master, so the **next wasm build/deploy** produces a default-ON
client. The local `pkg/` and any shipped `dist/` built before the flip are still const=false.
To make it live:
```bash
cd external/holtburger/apps/holtburger-web
PATH="$HOME/.cargo/bin:$PATH" capped-build wasm-pack build --target web --out-dir pkg --dev   # ~1m
# then ship dist/ per the deploy mechanism (pkg/ is gitignored)
```
To confirm default-ON at runtime: boot with NO faithful flag and verify indoor collision
still stops the player (and `[bsp] drained … cell STATIC physics BSPs` appears indoors).

---

## 7. Build / test / where things live

```bash
cd external/holtburger
capped-build ~/.cargo/bin/cargo test  -p holtburger-dat   --lib 'transition::'        # 252 pass
capped-build ~/.cargo/bin/cargo test  -p holtburger-world --lib 'spatial::faithful_bridge::drift'  # 9 pass
capped-build ~/.cargo/bin/cargo check -p holtburger-core                              # clean
PATH="$HOME/.cargo/bin:$PATH" capped-build wasm-pack build --target web --out-dir pkg --dev
```
- **Driver crate**: `crates/holtburger-dat/src/transition/` (resolver, driver, `find_obj_collisions` is in the bridge).
- **Live bridge**: `crates/holtburger-world/src/spatial/faithful_bridge.rs` (`SceneObjCell`,
  `find_obj_collisions`, `point_in_cell`, `add_all_outside_cells` ← Phase D), `transition.rs`
  (dispatcher `:840`), `scene.rs` (`cell_static_physics_bsp` table `:472` + insert/accessor/clear).
- **Flag**: `crates/holtburger-core/src/client/movement/system.rs:577` (`const USE_FAITHFUL_TRANSITION = true`).
- **wasm live-feed populate**: `apps/holtburger-web/src/lib.rs` — `CELL_STATIC_BSP_PENDING`,
  `drain_pending_cell_static_bsps_into`, and the per-stab staging in `fetch_env_cells_in_landblock`.

## 8. Headless in-world harness (how to drive an A/B — no 1070 needed for collision)

Collision is position-based (CPU-side) → GPU-independent; the laptop SwiftShader bot is the
right tool. Raw `chrome --headless` botches the WS upgrade to the bridge; **use Playwright**.
Local stack is up: serve.py `:8765`, `holtburger-wsbridge :8080`, ACE (UDP `:9000/:9001`),
MariaDB. Safe account: **`<test-account>`/`<test-account>`** (NOT the owner's `<account>`).
- Turnkey: `harness/lib/boot.mjs#launchAndEnter({query, timeoutMs})` (env `HARNESS_ACCOUNT`/
  `HARNESS_PASSWORD` override the default `<account>`). Or the scratch drivers used this session.
- 1070 real-GPU render eye-test (only for render fidelity, NOT collision): MODE2i off-screen
  per `MEMORY.md` — Roblox is light (~22% GPU) so the box has headroom, but never browser.close()
  the person's session.

## 9. Suggested next session
1. **Phase D** — port outdoor land collision (`CLandCell` / `add_all_outside_cells` + terrain
   polys) into the faithful driver; wire the 3×3 neighbor ring (fixes the off-center-building
   walk-through). Biggest remaining piece; start from the decomp `CLandCell::find_collisions`.
2. Optional Phase-C polish: precise `point_in_cell` (membership BSP), the single-number in-world
   static A/B, cross-portal collision.
3. Deploy: rebuild + ship the wasm so default-ON is live (§6).
