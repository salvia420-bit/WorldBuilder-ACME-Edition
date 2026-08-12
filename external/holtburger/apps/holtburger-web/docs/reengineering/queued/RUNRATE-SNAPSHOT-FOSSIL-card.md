# RUNRATE-SNAPSHOT-FOSSIL — `playerRunRateInputs` is a login-time fossil, not a cache

**Found:** 2026-08-12, lane O (s13), live `agentp08` session.
**Status:** PROVEN, not fixed. Diagnostic-lane only — it does not corrupt
movement, it corrupts the provenance used to *judge* movement.
**Related:** `5ae4efd6` (which identified the staleness), the s13 lane-O
report `docs/reengineering/impl/task-ORACLE-s13-lane-O-report.md` §4.

## The claim

`playerRunRateInputs` (`apps/holtburger-web/src/lib.rs:40794`) returns the
thread_local `LATEST_RUN_RATE_INPUTS_JSON`, written in exactly one place
(`lib.rs:41208`, inside `publish_player_stats_snapshot`). `5ae4efd6`
correctly called this a cache refreshed on a stats delta.

**It is weaker than that: in a live session it never refreshed again after
the login burst.**

## The measurement

One in-world `agentp08` session, `?moveTelemetry=1`, sampled at 5 s intervals
from boot and then drained per-tick:

| lane | `burden` | `encumbrance` | `capacity` |
|---|---:|---:|---:|
| `playerRunRateInputs` (snapshot) | `0` | `0` | 6000 |
| per-tick telemetry, all 26 ticks | `0.12216666` | — | — |

The snapshot still read `burden 0` **30 s after reaching in-world**, with
inventory long loaded and the per-tick lane reading `0.12216666` throughout
(that value was invariant across every tick — it is not a transient).

`burden 0` beside `encumbrance 0, capacity 6000` is internally consistent for
a moment *before inventory landed*, which dates the fossil to the login
burst.

## Why it matters

The two call sites of `publish_player_stats_snapshot` (`lib.rs:44523`,
`lib.rs:50680`) both fire on `stats_changed`. Inventory arriving — and with
it a real encumbrance — evidently does not raise that, so the snapshot is
pinned at its login value for the rest of the session.

Consequence: **every capture that has ever read `playerRunRateInputs` was
reading login-time values**, including the two prior sessions' ORACLE #1
claims. This is the mechanism behind `6e87563b`'s retracted "same
millisecond" proof, and it is still live for any future reader.

It does **not** corrupt the run rate itself: `burden_load_modifier`
(`crates/holtburger-world/src/context.rs:48-56`) returns `1.0` for any
`burden < 1.0`, so 0 and 0.122 produce the same rate. The damage is confined
to provenance — which is the entire purpose of that export.

## Options (not chosen here — this wants a decision, not a patch)

1. **Make it tick-fresh.** Serialize `RunRateInputs` in the tick like
   `playerAugTrace` does, guarded by a change-compare so the steady-state
   cost is a scalar diff rather than a ~15-field JSON build. Truthful, costs
   a little.
2. **Refresh it on encumbrance/inventory settle too**, not only
   `stats_changed`. Narrower, but leaves the "what else fails to raise
   `stats_changed`?" question open — which is how this bug got here.
3. **Rename and document it as login-only** (e.g. `playerRunRateInputsAtLogin`)
   and add a `stamp` field so a reader can see the age. Cheapest, and it
   makes the fossil self-describing rather than silently wrong.

Recommend **(1)** if anything is going to keep reading it as evidence, else
**(3)**. Whatever is chosen, the export should carry a timestamp — a
provenance probe with no age on it is what cost two sessions.

## Guard to add with the fix

Any capture reading this export should assert *presence separately from
content*, and should cross-check `burden` against the per-tick lane before
quoting either. See the lane-O report §1.3 for why: an absent getter and an
empty/zeroed reading are indistinguishable otherwise.
