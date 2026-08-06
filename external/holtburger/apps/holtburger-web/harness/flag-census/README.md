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
