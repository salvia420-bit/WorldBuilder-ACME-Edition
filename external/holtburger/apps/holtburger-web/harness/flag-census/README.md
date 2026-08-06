# flag-census — what is every default-ON flag actually paying for?

A measurement harness. **It modifies no client code.** It boots the shipped client
once per flag with that flag escaped, at a fixed POI with a parked camera, and records
what changes.

```bash
# 1. build the work list from the docs
python3 extract-flags.py ../../docs/url-flags.md /tmp/flags.json

# 2. run (detached; resumable; stops itself at STOP_AT)
mkdir -p /mnt/wbterminal2/flag-census
OUTDIR=/mnt/wbterminal2/flag-census FLAGS_JSON=/tmp/flags.json \
  STOP_AT="$(date -u -d '+9 hours' +%Y-%m-%dT%H:%M:%SZ)" \
  setsid nohup node flag-census.mjs > /mnt/wbterminal2/flag-census/run.log 2>&1 &

# 3. tracking doc (safe to run at any time, including mid-run)
node analyze-census.mjs /mnt/wbterminal2/flag-census/results.jsonl \
                        /mnt/wbterminal2/flag-census/TRACKING.md
```

## What it is for, and what it is not for

**Not for frame time.** Cross-boot p50 on this workload is not trustworthy at small
effect sizes: sessions on 2026-08-06 measured 25.2 / 25.8 / 31.4 / 32.3 ms purely
because the entity population differed. `p50` is recorded, and it is the weakest column
here. The `?skipDeadAlpha` change that shipped the same day was 2.8% — invisible to this
instrument.

**For structure.** `draws/frame`, bucket / material / program / geometry counts,
triangles, texture bytes, heap, boot time and console errors are near-deterministic
across boots and are what this actually measures well.

**The prize is the null result.** A flag documented as default-ON whose escape arm is
indistinguishable from baseline on every metric is dead, mis-documented, or context-
dependent. This tree has that history — the `shadows` tombstone (a dead flag whose
checkbox still wrote to localStorage), and the documented footgun where a flag coded
`!== "off"` reads ON when absent despite a "default OFF" comment.

## The two things that make the numbers mean anything

**The noise band is measured, not assumed.** Baselines are interleaved every Nth run and
are configuration-identical, so their own spread *is* the night's noise floor. A flag
registers an effect only when it moves a metric further than the baselines moved among
themselves. Each flag is compared against the baselines **bracketing it in time**, so
slow drift cancels instead of accumulating into a false effect. A fixed "5% is
significant" rule would manufacture dozens of findings on this workload.

**Silence is not success.** `analyze-census.mjs` refuses to emit `NO-OBSERVABLE-EFFECT`
unless it had at least `MIN_BASELINES` baselines and a computable band; otherwise the
verdict is `INSUFFICIENT-BASELINE`. This guard is not theoretical — the first version
lacked it, and when run against smoke data with a single baseline it reported
`animSceneryInstanced=off` as "no observable effect". That flag adds **1,353 draws per
frame** and is the largest single effect in the tree. With no band, a 1,353-draw change
and a zero change are the same number.

## Validation

The smoke set is the positive control, and it must reproduce known effects before a full
run is trusted:

| run | draws/frame | p50 |
|---|---|---|
| BASELINE | 472.4 | 26.1 |
| `statPom=off` | 494.2 (+22) | 26.9 |
| `skipDeadAlpha=off` | 583.3 (+111) | 33.7 |
| `animSceneryInstanced=off` | 1825.6 (+1353) | 52.5 |

`animSceneryInstanced` reproduces the documented 2026-07-02 instancing result; a run that
does not show it has a broken instrument, not a quiet night.

## Exclusions

`EXCLUDE` in `flag-census.mjs` fences off flags the harness itself depends on
(`autoLogin`, `renderDiag`, `camDebug`, `quality`, `renderScale`, `adaptiveRes`) or that
change what a frame means (`nullRender`, `renderOnDemand`, `targetFps`, `wireframe`,
`renderer`). Escaping those would measure the instrument.

The escape token per flag is derived from the doc's **Values** column, not its Default
column, because the Default column is a claim the run is trying to test.

## Operational notes

- ACE enforces single login: the driver waits for the account's `LOGOUT` in `ACE_Log.txt`
  before each boot and alternates `tailnet1` / `phase4demo`. Skipping this yields
  `Account In Use`, which boots *both* sessions.
- Chrome on the 1070 has died mid-run before. `ensureInfra()` rebuilds the tunnel and
  relaunches via `schtasks` between runs.
- The 1070 is someone's personal machine. Chrome is launched off-screen
  (`--window-position=-32000,-32000`) and `--mute-audio` from the unmodified
  `C:\Temp\launch-wls.bat`, and only processes matching `--user-data-dir=...cdpwb-wls`
  are ever killed — never `taskkill /IM chrome.exe`.
- Results go to `/mnt/wbterminal2` because the system disk runs 85–96% full.
- Resumable: completed flags are read back from `results.jsonl` on start.

## Night 1 post-mortem (2026-08-06) — read before trusting this harness

It wedged at 42 of 241 flags and its verdicts were unusable. Two independent faults, both
now understood:

**1. No watchdog.** `page.evaluate()` has no default timeout in Playwright, so when the
renderer stopped responding the driver waited forever — 6 hours lost. `bootab.mjs` wraps
every page call in `withTimeout()`; `flag-census.mjs` still does not, and must not be re-run
until it does.

**2. Reusing one Chrome poisons the measurement — this is the important one.** Baselines are
configuration-identical and should be flat. They were not:

| time | draws | p50 | materials | texObjs |
|---|---|---|---|---|
| 05:12 | 463.3 | 25.6 | 712 | 786 |
| 05:47 | 464.1 | 26.1 | 681 | 701 |
| 05:58 | 454.5 | 49.3 | 671 | 693 |
| 06:47 | 407.1 | 62.5 | 382 | 604 |

p50 degraded **2.44×** while materials nearly halved — the scene got emptier *and* slower, as
GPU state accumulated across page loads until the client's memory-pressure governor began
evicting. `bootab.mjs` relaunches Chrome between arms for exactly this reason.

**The guard checked the wrong property.** `analyze-census.mjs` refuses a verdict without
enough baselines, and that passed (9 ≥ 3) — then computed a band of ±64.8 draws / ±47.9 ms
from those *drifting* baselines, which swallowed everything and returned 35 of 42 flags as
"no observable effect". A drifting baseline is worse than a missing one because it looks
valid. **Baseline count is not baseline stationarity**; any future version must test the
baselines for trend before using their spread as a noise floor.

**One-shot runs cannot resolve ~20 draws.** In the clean early window the band was genuinely
tight (draws ±0.5%), yet flag deltas clustered at ≈0, −16, −19, −26 across unrelated flags
including `unwedgeLivelockRecall`, which has no plausible render effect. That quantisation is
NPCs wandering (a rig is ~16–20 meshes), not flags. The census's one interesting signal,
`particleBillboard` at p50 +3.0 ms, did **not** reproduce under interleaved boot arms
(−0.4 ms, overlapping). Structural metrics need entity count recorded as a covariate, or a
location with no NPCs.

Raw night-1 data is kept at `/mnt/wbterminal2/flag-census/results-night1.jsonl` as evidence,
not as findings.

## bootab.mjs — the thing that did work

Interleaved BOOT arms with Chrome relaunched between them and a hard watchdog on every page
call. This is the tool to reach for when a flag cannot be toggled live:

```bash
FLAG=statBatchChunk ARM_B=off REPS=2 node bootab.mjs out.json
```

It validated the bucket-cost slope (~45 µs/draw measured against 37.6 µs predicted by
regression) and killed the `particleBillboard` lead. Prefer an in-session interleaved toggle
where the flag allows it — that method resolves ~0.3 ms; boot arms resolve ~1 ms at best.
