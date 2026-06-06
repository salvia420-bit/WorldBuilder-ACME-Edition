# Run-rate input probe — capture playbook (P0 snapback root)

Wired 2026-06-06. Instruments the run-rate INPUTS (not the formula) so the live `+Tester` values
can be diffed against ACE `Creature.GetRunRate`. The research pass + the `load_mod`-clamp argument
pinned the over-run to the run-skill INPUT (burden only brakes — `burden_load_modifier` clamps at
1.0); this measures exactly which input diverges.

## What was added (all read-only; no formula change)

- **Rust (world crate)** `crates/holtburger-world/src/context.rs`
  - `RunSkillSource` enum + `RunRateInputs` struct + `RunRateInputs::to_json()`.
  - `WorldContextExt::player_run_rate_inputs()` — mirrors `player_run_rate()` step-for-step
    (same Quickness fallback, same `burden.unwrap_or(3.0)`), capturing provenance.
  - Unit test `player_run_rate_inputs_reports_skill_source_and_matches_run_rate` (passes; 17/17 in
    the `context::` suite).
- **Rust (wasm)** `apps/holtburger-web/src/lib.rs`
  - Free export `playerRunRateInputs() -> String` (JSON) + `LATEST_RUN_RATE_INPUTS_JSON`
    thread_local, written in `publish_player_stats_snapshot` on every stats delta (same trigger as
    `playerRunRate`). `cargo check --target wasm32` passes.
- **JS (diag)** `apps/holtburger-web/scene3d/diag/physics.js`
  - `__diag.physics.runRate()` reads + parses the export and cross-checks the scalar
    `playerRunRate()`. Pure JS, reload-live (but returns null until the wasm below is rebuilt).

## JSON shape

```json
{
  "run_rate": 2.32,                 // null when stats unloaded (caller uses 4.5 cap)
  "run_skill_used": 185,            // the value actually fed into the formula
  "run_skill_source": "wire_run_skill" | "quickness_fallback" | "unavailable",
  "run_skill_wire": 185,            // wire Run skill .current (null if absent)
  "quickness": 180,                 // Quickness .current (null if absent)
  "burden": 0.012,
  "load_mod": 1.0,                  // clamped at 1.0 — burden only brakes
  "encumbrance": 555, "capacity": 45000, "strength": 100, "num_augs": 0,
  "run_rate_scalar_export": 2.32    // = playerRunRate(); should match run_rate
}
```

## To run the capture (live session)

1. **Build + deploy the wasm bundle** (the new export only exists after a rebuild — do this on the
   buildbox per the cloud-buildbox workflow to avoid the 8GB-laptop OOM that killed MariaDB last
   session; do NOT stack it with headed chromium locally):
   `wasm-pack build --target web …` then redeploy the bundle the 1070 loads.
2. **On the 1070**, log in `+Tester`, stand still on flat outdoor ground, then in the console:
   ```js
   __diag.physics.runRate()
   ```
   Record it standing, then while holding forward (run). Also grab `__diag.physics.summary()` for the
   drift it drives.
3. **On ACE**, for the same char, read the server's truth:
   - `GetCreatureSkill(Skill.Run).Current` (the effective Run skill ACE feeds), and
   - `EncumbranceSystem.GetBurden(capacity, EncumbranceVal)` (its burden).
   (`external/ACE/.../WorldObjects/Monster_Navigation.cs:346`.)

## How to read the result

- **`run_skill_source === "quickness_fallback"`** → prime suspect confirmed: the wire Run skill
  hasn't hydrated and we're substituting Quickness (ACE never does). Fix = ensure the Run skill is
  populated before the run-rate is consumed, or align the fallback to ACE's effective Run skill.
- **`run_skill_used` ≫ ACE's `Run.Current`** with `source === "wire_run_skill"` → we're feeding a
  buffed/base-mismatched skill; align the skill flavor.
- **`load_mod < 1.0`** (i.e. `burden ≥ 1.0`) → the char IS over-encumbered and the augmentation-cap
  cleanup (`context.rs:196`, demoted P0) actually matters here; otherwise it stays inert.
- `run_rate_scalar_export` should equal `run_rate`; a mismatch means the cache is stale vs the
  snapshot trigger.

The integrator formula (`4.0 × run_rate`) stays untouched — fix the INPUT so our `run_rate` matches
ACE's for the same char, and the rig stops out-running ACE → snapback resolves.
