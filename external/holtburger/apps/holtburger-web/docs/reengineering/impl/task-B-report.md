# LANE B — ORACLE (handoff O-P4) — 2026-08-14

branch `lane/oracle-20260814`, worktree `/mnt/wbterminal2/lanes/b-oracle`, commit `885a311b`.
Task: port `orch/s13-oracle` commit `3f57d9ed` — a real bug fix that was never verified and
never merged — onto today's master, resolve it against the 08-13 wasm ABI, and supply the
verification its own commit message says it lacks.

## 1. Does the bug reproduce? YES.

`3f57d9ed` named the site correctly and the site is still unguarded on today's master:
`apply_inventory_object_create` (`src/lib.rs`) built an entity from
`data.public_weenie_desc` and finished with a bare `world.entities.insert(entity)`.
`EntityManager::insert` is `HashMap::insert` — wholesale replace, no merge. ACE re-sends the
LOCAL PLAYER's own `ObjectCreate` on portal and visibility transitions, and that create
carries only the public weenie baseline, so the player's property bag was replaced by it.

The guard written for exactly this case, `WorldState::upsert_entity_from_create`
(`crates/holtburger-world/src/state/liveness.rs:399`), is real and still present — the wasm
lane simply never routed through it. That is also why the aug trace stayed silent: this path
enters neither `routing::handle_message` nor the `tick()` sweep, the only two hooked places.

**Reproduced as a test, not merely re-reasoned.** `raw_entities_insert_wipes_the_local_player_bag`
seeds a world through the real login `PlayerDescription` message and then performs the same raw
insert the wasm lane was doing. Afterwards `Level` and `AugmentationJackOfAllTrades` both read
`None` — the exact `aug_joat 1 -> null` shape `3f57d9ed`'s live capture measured. The guard is
therefore not speculative, and the reproduction half stays in the suite so it cannot become so.

**Live corroboration that the wire really does re-send the self create**: booting headless
against the running ACE server logs
`[step 3.7] WorldState player entity seeded via ObjectCreate ... (guid=0x50000178)` on every
login. The self `ObjectCreate` reaches this function in normal play.

## 2. What ported, and what did not

`3f57d9ed` had two hunks.

* **The recv_loop hunk — DROPPED as a no-op.** It was a revert of `34d55412`. `34d55412` is
  not an ancestor of master and its `!w.entities.contains(*player_guid)` condition does not
  appear anywhere in the tree, so master is already in the reverted state. Re-applying the
  hunk would have been a null diff at best and a conflict at worst. Verified with
  `git merge-base --is-ancestor` (NO for both `34d55412` and `3f57d9ed`) plus a direct grep.
* **The guard hunk — PORTED**, but not as written. See below.

## 3. How it was resolved against the new ABI

`3f57d9ed` inlined the guard into `apply_inventory_object_create` immediately above the insert.
That would apply textually today, but it would have shipped **untestable a second time**:
`apply_inventory_object_create` is `#[cfg(target_arch = "wasm32")]`, and so is its entire
parameter chain (`PerGuidBridgeIndexes`, `WieldedWeaponEntry`, `PROJECTILE_GRAVITY_GUIDS`).
Nothing on the native test target can call it, so `cargo test -p holtburger-web --lib` could
never have covered the fix — which is precisely how the original ended up "NOT VERIFIED".

Instead the guard **and the insert** are lifted into one helper:

```rust
#[cfg(any(target_arch = "wasm32", test))]
fn insert_object_create_entity(world: &mut WorldState, mut entity: Entity)
```

and `apply_inventory_object_create` calls it. Two things follow:

1. There is **no raw `entities.insert` left in the ObjectCreate path** — a future caller has to
   go through the guard, rather than around it the way this one did.
2. The behaviour is reachable natively. The `cfg(any(target_arch = "wasm32", test))` pattern is
   the crate's existing convention (the Wave C.2 math wrappers, `fetch_surface_pixels_impl`),
   and `holtburger-world` is already a dev-dependency with `test-support` for exactly this
   native mirroring (see the `tests_entity_bsp_door_collision` note in `Cargo.toml`).

Semantics are liveness.rs's, mirrored exactly: for `guid == world.player.guid` the incoming
create is rebased on the live entity bag, or — when the entity has already been removed
(explicit delete then re-create) — on the stashed login `PlayerDescription` dump via the public
`player_description_properties()` accessor, then merged. `WorldObjectProperties::merge` extends
with the incoming set, so **the fresh create still wins on every property it actually carries**;
only properties the create does not mention survive.

## 4. The test that was missing

`mod tests_object_create_local_player_rebase` in `src/lib.rs`, five tests, all native:

| test | what it settles |
|---|---|
| `raw_entities_insert_wipes_the_local_player_bag` | REPRODUCTION — the unguarded primitive drops `Level` + `AugmentationJackOfAllTrades` |
| `self_object_create_keeps_the_player_its_own_identity` | the deliverable — private props survive, guid intact, and the create's OWN props still win |
| `self_object_create_after_entity_removal_reseeds_from_the_stash` | the second wipe path liveness.rs documents (entity gone → stash re-seed) |
| `other_guids_are_not_rebased` | guard is local-player-only; a recycled dynamic GUID cannot inherit the previous occupant's bag |
| `null_guid_is_not_treated_as_the_local_player` | NULL guid before the player guid is known is not mistaken for the player |

## 5. Results, named — vs the 243/12/1 baseline

**`node harness/run-js-headless.mjs`**, against the rebuilt release wasm:

```
243 passed, 12 failed, 1 missing  (of 258 run)
```

Identical to the `origin/master` baseline, and the same twelve named failures:
`test_move_telemetry.mjs`, `test_a14_i3_run_keys.mjs`, `test_a5_p3_root_motion.mjs`,
`test_a14_i2_pursuit_monitor.mjs`, `test_motion_sequence.mjs`,
`test_a11_s5_default_script_spawn.mjs`, `test_materials_paletted_lru.mjs`,
`test_sky_birds.mjs`, `test_visfid_c4_program_cache_key.mjs`,
`test_visfid_p02_detail_material.mjs`, `test_visfid_p11_normal_gate.mjs`,
`test_visfid_p33_csm.mjs`. No new failure, none fixed. No `parity-ab.sh` run was needed
because nothing moved.

**`cargo test -p holtburger-web --lib`** (under the flock build lock,
`CARGO_TARGET_DIR=/mnt/wbterminal2/lanes/target-B`):

```
before  236 passed / 1 failed / 4 ignored
after   241 passed / 1 failed / 4 ignored     (+5 = the new module)
```

Same single named failure on both sides: `tests_substitution::resolve_static_placement_frame_orders`
(`left: 0, right: 101` at `src/lib.rs:56755`). Confirmed pre-existing by `git stash`-ing this
diff and re-running — it is a pure-logic placement-frame test with no relation to entities.

**Release wasm**, rebuilt under the lock: `6,684,061` bytes (was `6,682,404`; +1,657 for the
guard). Release-shaped, not the ~18 MB dev build. `serve.py --check` prints a "pkg wasm predates
the last Rust-touching commit" warning — that is a false positive of ordering here: the wasm was
built at 15:40 from the edited source and the commit was made afterwards, so the mtime is older
than the commit but newer than the source it contains.

## 6. Allocation cost on the default path

**No URL flag was added, no gate introduced, and no flag default moved**, so there is no gated
allocation to account for. The unconditional cost is:

* every `ObjectCreate`: one `Guid` compare (`guid == world.player.guid`), plus a
  `guid != Guid::NULL` compare;
* an `ObjectCreate` **whose guid is the local player's**: one `WorldObjectProperties` clone
  (seven small maps) plus one `merge` (seven `extend`s). This fires a handful of times per
  session — login and portal/visibility transitions — not per frame and not per entity.

Nothing on the render path, nothing in the composer, no texture or attachment state touched, so
the 08-13 stencil-allocation class of failure does not apply here.

## 7. Live confirmation (fixed arm only)

Headless, `?nullRender=1&renderOnDemand=1&netDrainHz=30&nosw=1&agent=1&autoLogin=1`, account
`agentp08` (character "Funnel Probe Two"), against the ACE server already running on this
laptop, serve.py on port 8772 (stopped again afterwards). `playerEntityProps()` read via
`import('./pkg/holtburger_web.js?v=wasmrev-20260803')` from the page — the ES module cache hands
back the LIVE instance, so this is not a second wasm. The export is not wired to any JS surface;
`window.__hbWasm` is a curated plugin surface and does not carry it.

After login and after **two** cross-region teleports (`@telepoi Holtburg`, then `@telepoi Arwic`):

```
augJoatEntity: 1     augJoatStash: 1     present: true
entity.ints: Age, AugmentationJackOfAllTrades, AvailableSkillCredits 52, CoinValue 10000,
             ContainersCapacity, CreationTimestamp, DeathLevel, EncumbranceVal, Gender,
             HeritageGroup, Level, MeleeMastery, NumDeaths, RangedMastery, VitaeCpPool
entity.strings: Name "+Funnel Probe Two", Template "Bow Hunter"
```

The two lanes AGREE at 1, and the entity bag holds the **full private dump**, not the public
weenie int set. That is the direct negation of `3f57d9ed`'s measured defect state
(`augJoatEntity: null`, entity bag = `[Age, CloakStatus, ContainersCapacity, ItemType,
ItemUseable, ItemsCapacity, PhysicsState, ShowableOnRadar]`), read with the same
entity-vs-stash discriminator, through the same accessor, after the same class of transition.

## 8. What I could NOT prove

* **The live check is one arm, not a matched pair.** I did not rebuild the unguarded wasm to
  capture a live BEFORE, because that is a second ~10-minute release build holding the shared
  build lock while two other lanes are active, and the unit-test reproduction already
  establishes the defect. So the live result is a strong positive on the fixed arm, not a
  controlled A/B. The A/B that matters is the cargo one, and it is in the suite.
* **The character differs** from the one in `3f57d9ed`'s capture (a fresh Level 1 vs the
  original's). The discriminator (entity-vs-stash agreement) is character-independent, but the
  absolute values are not comparable across the two captures.
* **Frequency is unquantified.** I confirmed ACE re-sends the self `ObjectCreate` at login; I
  did not instrument how often it re-sends on portal/visibility transitions, so I cannot say how
  many wipes per session the guard actually prevents — only that any of them would have wiped.
* **No GPU evidence was needed or submitted**; no jobs appended to `/mnt/wbterminal2/eyeq/queue.jsonl`.
  This change has no render-path surface.
