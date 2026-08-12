# Lane O (s13) — ORACLE #1 settled, and the two instruments that were lying

Session: 2026-08-12. Worktree `/home/wbterminal/fanout-s12/A`, branch
`orch/s13-oracle`. Serve `:8771`, Chrome `:9341`, holtburger account
`agentp08`.

**Read the summary in this order: what the previous two sessions got wrong is
an INSTRUMENT story, and the defect verdict only makes sense after it.**

---

## 0. The short version

| question | answer |
|---|---|
| Is ORACLE #1 real? | **YES — confirmed against the retail oracle with exact arithmetic**, not a fossil artifact. |
| Was the "same millisecond" proof (`6e87563b`) valid? | No. `5ae4efd6`'s retraction was right to kill it. |
| Was the retraction's replacement instrument valid? | **No — it was blind.** It was hooked on a function the live client never calls, and it was not reachable from JS at all. Both fixed here. |
| Is the `burden` discrepancy a second defect? | No — same staleness. But it exposes a **worse** property of that lane than "stale": see §4. |
| MOVE-F6 strafe sign? | D1's premise is backwards. Retail is NOT capping the diagonal; holtburger is under-delivering it. See §5. |
| Vitae on the measured character? | **YES — `agentp08` carries it.** See §3.3. The briefing asked; the answer is yes and it is arithmetically visible. |

Commits: `98b69fed`, `906db477` (+ this report).

---

## 1. Two instrument defects, found before any conclusion was drawn

### 1.1 The getters were not reachable (fixed: `98b69fed`)

`playerAugTrace` and `playerEntityProps` compiled into the shipped wasm —
`pkg/holtburger_web.js` carries `export function playerAugTrace()` (:18193)
and `export function playerEntityProps()` (:18219), and the wasm data section
carries `augJoatEntity`, `augJoatStash`, `stashPresent`, `entityBefore`,
`entityAfter`, which only their write blocks emit.

But `liveScene3d.entityManager.wasmExports` is a **curated** object, built
from an explicit import list (`index.html:1322-1357`) and a matching init3D
opts block (`index.html:5340-5363`). Neither listed the two new names.
Measured in a live in-world session:

```
typeof wasmExports.playerRunRateInputs -> "function"
typeof wasmExports.playerAugTrace      -> "undefined"
typeof wasmExports.playerEntityProps   -> "undefined"
```

This is the same plumb-through miss the comment beside `playerRunRateInputs`
already records for itself. It recurred for the next two exports.

### 1.2 The trace was hooked where production never runs (fixed: `906db477`)

`5ae4efd6` put the probe on `WorldState::handle_message`
(`state/types.rs:435`), the "stable public entry point". The live wasm client
does not call it:

* `apps/holtburger-web/src/lib.rs:43647` calls
  `holtburger_world::handlers::routing::handle_message(w, &message, &mut world_events)`
  — the free function, directly.
* `crates/holtburger-world/src/handlers/mod.rs:11` is
  `pub use routing::handle_message;`; the wrapper merely delegates into it.

So the probe sat one level above the only path a browser takes. `5ae4efd6`'s
test passed because it drives the wrapper — the one caller that is not
production.

The probe now lives in `routing::handle_message` and is off the wrapper, so
neither caller double-records. The `tick/sweep` probe
(`state/liveness.rs:389-394`) is untouched.

### 1.3 Why this mattered more than the wiring — the trap that has now bitten three sessions

**An empty trace is not neutral under `5ae4efd6`'s design.** Its own docs say
a trace with no transition means the value was never seeded, i.e. *"ACE never
sent it and the defect is character data, not code."*

A blind instrument returns exactly that. My first probe read

```js
JSON.parse(w.playerAugTrace?.() ?? "[]")   // -> []
```

and `[]` is the finding-shaped output of an instrument that is not there.
**A probe that defaults an absent getter to its own empty value cannot
distinguish "nothing happened" from "nothing is measuring".** Every capture
script in this lane should report *presence* separately from *content*; the
one used here does, and it is what caught this.

The regression test added in `906db477` drives `routing::handle_message`
directly, in the production call shape. **Negative control run:** with the
routing probe neutered, it fails `left: 0, right: 1` — 0-vs-1 being the
blind-instrument signature itself.

---

## 2. ORACLE #1 — the verdict

Both lanes, same live session (`agentp08`, in-world, `?moveTelemetry=1`):

| | snapshot lane (`playerRunRateInputs`) | per-tick lane (telemetry `run_rate`) |
|---|---|---|
| `aug_joat` | `1` | **`null`** (invariant, 26 ticks) |
| `run_skill_aug_bonus` / `aug_bonus` | `5` | **`0`** |
| `run_skill_used` | `110` | **`105`** |
| `run_skill_wire` | 105 | 105 |
| `player_entity_present` | true | true |
| `burden` | `0` | `0.12216666` |
| composed rate | 1.9758065 | 1.9467213 |

`playerEntityProps` (now readable): `augJoatEntity: 1`, `augJoatStash: 1`,
7 keys each, **0 keys in stash but not in the live entity**.

### 2.1 The arithmetic is exact, and retail decides it

`run_rate_from_skill_and_burden` (`context.rs:142-158`) with
`burden_load_modifier` (`context.rs:48-56`, which returns **1.0 for any
burden < 1.0**, so burden 0 vs 0.122 give the *same* rate — an earlier
"burden confound" idea of mine was wrong):

```
run_rate(skill=105) = 1.9467213      <- holtburger's LIVE per-tick composition
run_rate(skill=110) = 1.9758065      <- retail's OWN wire forward_speed
```

Retail's capture (`task-ORACLE-report.md:578-579`) reports
`forward_speed 1.9758065`. That is `run_rate(110)` to seven digits.

**So the retail oracle runs at Run 110 — augmentation applied — and
holtburger's live movement lane composes Run 105. ORACLE #1 is a real
defect, confirmed against ground truth, and the agreement is exact rather
than approximate.**

What `5ae4efd6` correctly refused to concede — that the snapshot's `1` proves
anything about *now* — is no longer load-bearing: the retail oracle supplies
the correct value independently.

---

## 3. What is NOT yet named, and one thing that is

### 3.1 Still open: where the augmentation is lost

The repaired trace had not run in a browser at the time of writing (§7).
What is already excluded by measurement rather than reading:

* Not the ObjectCreate path (§-11 §C, and `5ae4efd6`'s test).
* Not "the entity went" — `player_entity_present` is true on every tick.
* Not "the stash lost it" — `augJoatStash: 1`, and stash and live bag share
  all 7 keys.

### 3.2 The live lane and the snapshot lane call the SAME function

Both reach `player_run_rate_inputs()` (`context.rs:626-681`) — the snapshot at
`lib.rs:41207`, the tick at `lib.rs:53843`. `aug_joat` there is
`get_player_int_property(AugmentationJackOfAllTrades)`, which for `WorldState`
delegates to `player_int_property` (`context.rs:452-454`) — the same funnel
`aug_probe()` uses. There is no accessor asymmetry; the difference is *when*,
or *which world*.

> Note for whoever picks this up: `WorldContext::get_player_int_property` has
> a **default impl returning `None` unconditionally** (`context.rs:390-392`).
> All three implementors override it (`WorldState` :452, `TestWorld` :1247,
> `GameData` `pages/game/data.rs:561`), so it is not leaking today — but it is
> a trait default that silently answers "absent" for any future implementor.

### 3.3 Vitae IS present on `agentp08` — and it is arithmetically visible

ACE's `server_run_rate` on the wire was `1.9700646`. Inverting the formula:

```
1.9700646 -> implied skill = 109.0000  (exactly)
          -> or skill 110 with load_mod 0.994116
```

`109 = round(110 x 0.99)`. ACE scales skill by vitae —
`ace-server/Source/ACE.Server/WorldObjects/Entity/CreatureSkill.cs:167-183`,
`fTotal *= vitae`. **So `agentp08` carries a Vitae enchantment**, exactly the
≤0.3 % effect the lane brief warned about for `agentp09`.

Consequence: **no reading finer than ~0.3 % on this character is trustworthy
until vitae is cleared**, and that includes the forward-axis half of MOVE-F6.
Clearing it needs ACE admin and is **not mine** — recommending it.

This also explains the forward-axis delta benignly: retail's client computed
its own rate *without* vitae (1.9758065 = Run 110) while ACE applied it
(1.9700646 = Run 109). −0.29 % predicted, −0.14 % measured.

---

## 4. Priority 2 — the `burden` discrepancy

**Not a second defect; the same staleness.** `burden 0` sits beside
`encumbrance 0, capacity 6000` — internally consistent for a moment *before
inventory landed*. The per-tick lane reads `0.12216666` live. Same function,
different times. `5ae4efd6`'s reading is confirmed.

**But it understates the problem.** The snapshot is described as a cache of
"the last stats delta". Measured here: it still read `burden 0` **30 s after
reaching in-world**, with inventory long since loaded and the per-tick lane
reading 0.122 throughout. So `publish_player_stats_snapshot` did not fire
again after the login burst.

That makes `playerRunRateInputs` **a login-time fossil for the whole
session**, not a recent cache — and every prior capture that read it was
reading login-time values. Since `burden < 1.0` clamps `load_mod` to 1.0, the
staleness does not corrupt the *rate*; it corrupts the *provenance*, which is
the entire purpose of that export.

Not fixed here (it is diagnostic-lane, and fixing it wants a decision about
whether that export should become tick-fresh or be documented as
login-only). Written up as a card: `docs/reengineering/queued/`.

---

## 5. Priority 3 — the strafe sign

Both sides agree on the sidestep *scalar*: retail's wire carries
`sidestep_speed 2.4658` beside `forward_speed 1.9758065`, and
`2.4658 / 1.9758065 = 1.248`, which is exactly holtburger's
`SIDESTEP_FACTOR x (WALK_ANIM_SPEED / SIDESTEP_ANIM_SPEED)`
`= 0.5 x (3.1199999 / 1.25)` (`motion_interp.rs:205-215`). No divergence
there.

Realized speeds, using `forward = 4.0 x run_rate` and
`sidestep = 1.56 x run_rate`:

| | run_rate | fwd model | side model | diag model | diag measured | vs own model |
|---|---:|---:|---:|---:|---:|---:|
| retail | 1.9758065 | 7.9032 | 3.0823 | 8.4830 | 8.468 | **−0.18 %** |
| holtburger | 1.9700646 | 7.8803 | 3.0733 | 8.4583 | 8.362 | **−1.14 %** |

**The sign explanation:** DEVIATION D1 predicted holtburger would be *faster*
on the diagonal because it assumed holtburger sums axes uncapped while retail
caps. The measurement says the opposite premise holds — **retail's own
diagonal matches an uncapped vector sum of its own two axes to 0.18 %**, so
retail is not capping anything. Holtburger is the side that falls ~1.14 %
below its *own* axes' vector sum. D1 is not merely unconfirmed; its premise
is inverted.

The residual is therefore ~1 % **specific to holtburger's diagonal
composition**, not to either axis alone, and it is *not* explained by the
run-rate difference (which is common-mode and only −0.29 %).

**Honesty bound:** the retail side of this is a ~1 Hz capture differentiated
for position, and vitae is on the character (§3.3). The −0.18 % vs −1.14 %
contrast is well outside those errors and I am confident in the *direction*;
I would not defend the second decimal place. I did not find the ~1 % — it is
a live, bounded question, and I am not naming a constant I have not read.

---

## 6. Environment facts that differ from the brief

* **The lane's paths are nested one level down.** `docs/reengineering/…`,
  `harness/…` and `scripts/oracle/…` live under
  `external/holtburger/` (and mostly `external/holtburger/apps/holtburger-web/`),
  not at the worktree root.
* **`100.116.47.66` is tailnet node `wbterminal`, not this box** (this box is
  `buildbox`, `100.115.127.76`). Port 8080 is the **wsbridge**, not HTTP — a
  plain `curl` gets `Empty reply from server`, which reads as "down" and is
  not. It answers.
* **`/mnt/wbterminal2` does not exist**, so `serve.py`'s default
  `HOLTBURGER_DIST` is dead; the live baked root is
  `/home/wbterminal/holtburger-dist-v4` (`--check` passes against it: 263
  shards, 65025 scenery, 38153 spawns, 80397 events, 256 packs).
* **No `ws`, no `playwright`, and node 20 has no global `WebSocket`.** The
  driver used here is a dependency-free CDP client with a 10-assertion
  selftest (large-payload/64-bit frame, exception surfacing, console capture)
  run before it was trusted.
* `node_modules` contains **only `three`** — the false-PASS trap for
  `three`-importing suites is live on this box.

---

## 7. What I could NOT verify

* **Where the augmentation is lost.** Named nothing. The repaired trace's
  first browser run is §8 (below); if that section is absent or empty, it did
  not happen.
* **`cargo test -p holtburger-core`** (the 643/0 movement gate) — not run.
* `test_pack_fetch_region`, `test_xu7_transcode`, `harness/test_build_shell`
  — **cannot run here** (`/mnt/wbterminal2` absent). Not reported green.
* **No retail client was launched this session.** Every retail number quoted
  is from the committed session-3 capture, not re-measured.
* **No flag default was moved.**
* The ~1 % diagonal residual (§5) is unexplained.
