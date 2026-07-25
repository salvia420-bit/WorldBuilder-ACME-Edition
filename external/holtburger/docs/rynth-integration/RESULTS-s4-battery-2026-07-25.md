# RESULTS — S4 decode-admission full battery (2026-07-25)

Executes recommended move 1 of `HANDOFF-A15-landed-2026-07-25.md`: the full 3-arm
battery (design `DESIGN-A15-ab-2026-07-24.md` §4 S4) to settle whether the admission
bound cuts the first-spike high-water, and whether the smoke's 44% drop repeats.

**Verdict up front: the gate gates (negative control regresses hard), armB is
settle-neutral, but the 44% first-hop high-water drop is REFUTED — it was a sampling
artifact. Do NOT arm S4's default for memory. Unexpected real finding: throttling decode
dramatically reduces renderer-crash frequency (armT ran 60 stops in one session vs
crashes every ~20–25 stops in the other arms) — the OOM lever S4 actually offers is
crash-rate, not resident MB.**

## Rig

- `battery-telepoi.mjs --mode local`, full 62-POI `telepoi-list-2026-07-10.txt`,
  `--dwellMax 45`, release wasm 4,881,207 B (same build as
  `RESULTS-settle-vs-age-2026-07-25.md`), `nullRender=1` + `nosw=1`, local ACE,
  account tailnet1, fresh Playwright profile per session.
- Wrapper relaunches on exit 3 with `--resume` (renderer deaths segment cleanly by
  `sessionIdx`; the script applies the ACE quiet-gap on resume).
- Park town Samsur is on the route; every arm boots there identically, so it enters
  each arm equally pre-warmed — comparable across arms, but its row is not a cold hop.
- Raw JSONs + log: `/mnt/wbterminal2/s4-battery-2026-07-25/` (`unbounded.json`,
  `armB.json`, `armT.json`, `battery.log`).

Arms (worker spec verbatim; main explicit to match design §4 S4):

| arm | query |
|---|---|
| unbounded | (none) |
| armB | `decodeAdmissionWorker=4x192+2&decodeAdmissionMain=2x64+2` |
| armT | `decodeAdmission=1x16+1` (deliberately too tight; must regress) |

## Results

All arms: 62/62 attempted, 55–57 landed (rest `noMove` duplicates — accounted stops).
`settleMed(work)` = median over work-guard settles only (the comparable class).

| arm | settleMed all | settleMed work | capped@45s | sessions (stops each) | steady maxMain | worst maxMain | maxWkr |
|---|---:|---:|---:|---|---:|---:|---:|
| unbounded | 12.4 s | 13.3 s | 7 | 4 (7/29/23/3) | 382–383 MB | 681 MB (s0, cold boot) | 247 MB |
| armB | 12.3 s | 13.0 s | 11 | 4 (3/24/19/16) | 383–387 MB | **985 MB (s0)** | 261 MB |
| armT | 17.7 s | 17.7 s | **21** | **2 (2/60)** | 440 MB | 440 MB | 301 MB |

1. **The gate is real.** armT regresses settle by ~4.4–7 s median with 3× the capped
   stops, and even its floor-guard (idle) settles regress (17.4 s vs 3.4 s) — queue
   delay leaks into everything. The middle arm's neutrality is therefore meaningful.
2. **armB is settle-neutral** (13.0 vs 13.3 s work-guard; within noise at these n).
3. **The 44% memory win is refuted.** armB's first-hop sample read 120 MB (vs 681
   unbounded) — but its session-0 *max* hit **985 MB**, the highest reading in the whole
   battery, before crashing 3 stops in. The gate doesn't trim the cold-spike peak; it
   stretches the ramp so an early sample catches it mid-climb (exactly what the smoke's
   n=1 first-hop reading did), while backlog accumulation makes the eventual peak the
   same or worse. Steady-state resident (~383 MB main) is identical in all three arms —
   admission caps concurrency, not residency, and the S2 finding (high-water set once
   at the first cold spike) still rules.
4. **Within-arm variance kills the smoke's comparison method.** Per-session high-water
   depends on which town the session boots into (681 MB booting cold at
   Samsur→Ahurenga vs ~382 MB for mid-route relaunch boots) — any cross-arm high-water
   claim must be matched on boot context, which the n=1 smoke was not.
5. **Unexpected: crash cadence.** unbounded/armB crashed every ~19–25 stops
   (3 renderer deaths each); armT ran **60 stops (~23.5 min active) crash-free** after
   its session-0 death. Slowing decode admission lowers whatever transient (JS-heap /
   geometry-churn side) actually kills the renderer. That is a real OOM lever — but at
   +4–7 s settle it is the wrong shape; S5's *pressure-conditional* throttle
   (`?decodePressure=`, inert until memory is high) is precisely the settle-free
   version of it, which raises S5-soak priority.

## Disposition

- **Do not arm S4's default.** Keep `?decodeAdmission*` as a host-supplied diagnostic
  and as S5's actuation mechanism.
- **First-spike peak needs a different lever** — admission is not it. Candidates:
  smaller first-bake batches (handoff move 1's alternative), and the surface-budget
  design (`DESIGN-surface-budget-2026-07-25.md`).
- **S5 soak promoted to the next measurement** with a concrete threshold hint: steady
  main sits at ~383 MB and cold spikes reach 681–985 MB, so `?decodePressure=512:768`
  brackets the spike while never touching steady-state. Combine with
  `?shardBudgetMB=48` per the handoff. Artifact: time-to-first-renderer-death on the
  battery route (this battery's baseline: crashes at stops ~7/32/53 unbounded).

## armP addendum — S5 preview (same day, same rig, run 4th)

armP = armB's settle-neutral admission base + `decodePressure=512:768` +
`shardBudgetMB=48`, same route. Result:

| arm | settleMed work | capped@45s | sessions (stops each) | steady maxMain | maxWkr |
|---|---:|---:|---|---:|---:|
| armB | 13.0 s | 11 | 4 (3/24/19/16) | 383–387 MB | 261 MB |
| armP | **24.5 s** | 19 | 3 (3/2/57) | 382–405 MB | 262 MB |

1. **The regression is the shard budget, not the pressure gate.** armP's long
   session (52 landed stops) peaked at 405 MB main — *below* the 512 MB t1 threshold —
   so pressure sat at level 0 (inert; `effective_max_* = configured` at level 0,
   `decode_admission.rs`) for essentially the whole run. What remained active was
   `shardBudgetMB=48`: **48 MB/instance thrashes on a world-roam route** (settle 24.5 s
   vs 13.0 s, worse than even armT's hard throttle), refuting the handoff's
   "48–64 looks like a production number" for whole-world roaming. The 62-POI route's
   shard working set is far wider than the 3-hop test that condemned 24 MB.
2. **Session-0 cold-spike crashes are untouched by pressure.** armP sessions 0/1
   died 3 and 2 stops in (like armB's s0) even with pressure armed — s0 read 680 MB
   main right before death (t1 crossed, ÷2 caps engaged) and s1 hit 985 MB. Either the
   250 ms sampler + cap-halving reacts too slowly for the cold ramp, or the killing
   transient is not wasm linear memory at all (battery can't see JS-heap — see traps).
3. **Crash-free long session again correlates with a slowed pipeline** (52 stops, like
   armT's 60): further evidence that decode/fetch pacing, however achieved, is what
   keeps the renderer alive — the honest version of this lever must be
   pressure-*conditional* so it costs nothing at level 0. That part of the S5 design
   survives; the shard budget number does not.

**Disposition update:** the real S5 soak should re-run with `shardBudgetMB` raised
(96/instance) or dropped, keep `decodePressure=512:768`, and add JS-heap +
`decodeAdmission.*`/`shardCache` fields to the battery relay so the cold-spike killer
and the thrash are directly observable rather than inferred.

## Traps (new)

- **First-hop memory samples under a gate are meaningless** — the gate stretches the
  ramp past the sample point. Compare per-session *max*, matched on boot town.
- Battery relays only `wasmMemoryBytes` {main,worker} — it never saw
  `decodeAdmission.queued/maxQueueMs` or JS-heap, so the crash-side transient is
  untracked. A soak arm should sample `performance.memory` + `decodeAdmission.*`
  per stop (small field-list extension to the battery relay).
