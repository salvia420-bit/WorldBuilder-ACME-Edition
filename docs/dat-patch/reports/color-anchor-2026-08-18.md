# Colour restore at the r7.1 re-encode (I8) + degrade-chain fold (I3) — 2026-08-18

Phase 1.1 + 1.2 of `PLAN-2026-08-18-hedonic-allocation.md`. All work is in the
working tree (no commits) plus scratch under `/mnt/wbterminal2/color-anchor-2026-08-18/`.

---

## 1. Where the retail anchor lives, and whether r7.1 would have got it

**The anchor is real and it is in the re-encode path r7.1 uses.**

| step | file:line |
|---|---|
| the anchor itself — "mean lum = LUM_TARGET × retail mean", fixed-point solved through the softclip | `tools/dat-patch/legibility.py:281-293` (`bake_texture`, `lum` branch); `LUM_TARGET = 1.15` at `legibility.py:61` |
| the anchor's *reference* — the retail re-export, loaded deliberately with `prefer_remacri=False` | `tools/dat-patch/texture_lane.py:398-406` (`bake_one`) |
| the call site that wires them | `texture_lane.py:408-410` → `legibility.bake_all` → `bake_texture` |
| the path r7.1 runs | `texture_lane.py run --remacri` (`run_lane`, `texture_lane.py:478`), i.e. exactly what `/mnt/wbterminal2/dat-patch-r7/r7_driver4.sh:run_lane` invokes |
| the doctrine note | `tools/dat-patch/README.md` "Bake:… anchor 1.15× retail" |

### Root cause of the "A-arm is darker" observation

Not a missing pipeline step — a **comparison of two different artefacts**. The
owner compared `/mnt/wbterminal2/deblock-ab/out-remacri-full/*.png` (raw Remacri
output, no bake) against `/mnt/wbterminal2/dat-patch-r7/*/baked/*.png` (post-bake,
post-anchor). Measured here on the four textures cited in the deblock report:

| rsId | retail lum | old r7 bake lum | old/retail | A-arm raw lum | A-raw vs old bake RGB |
|---|---|---|---|---|---|
| 0x0600378C | 0.3138 | 0.3527 | **1.1239** | 0.3326 | −5.5% |
| 0x06003C83 | 0.5961 | 0.6855 | **1.1500** | 0.6039 | −12.1% |
| 0x06003E7E | 0.2161 | 0.2485 | **1.1500** | 0.2267 | −8.7% |
| 0x06003C9E | 0.2932 | 0.3372 | **1.1499** | 0.3038 | −9.9% |

The old bakes sit at exactly 1.1500 × retail; raw Remacri sits at ~1.03. The
−8..−30% gap **is** the missing 1.15× anchor gain, nothing more exotic. Corpus-
wide the raw A-arm's median lumRatio is **1.0363** (n=1,630) against the shipped
r7 corpus's **1.1534** (n=2,192).

**So the deblock re-encode gets the anchor for free — provided three traps are
closed.** All three were open. Two were latent; one was already shipping damage.

---

## 2. What was actually broken (and is now fixed)

### 2a. THE REAL DEFECT — the anchor averaged two different populations (SHIPPED IN r7)

`bake_texture` took the reference's mean over the *retail alpha cutout* and the
candidate's mean over the *whole frame*, because the Remacri corpus comes back
**fully opaque** (the real alpha is transplanted back only afterwards, in
`texture_lane.run_lane`, `texture_lane.py:570-588`) with the cutout region
filled by whatever the upscaler painted there. The solver then closed a gap
that was an artefact of the mismatched populations.

Proven on `0x060066B8` (a creature tile), old code:

```
mean_lum(retail, its own cutout) = 0.32302      <- reference
mean_lum(remacri, all texels)    = 0.08493      <- candidate (cutout is black fill)
solved exposure_gain             = 16.45
resulting opaque-region mean     = 0.99999      <- a PURE WHITE silhouette
```

The mirror case (bright fill) crushes instead: `0x06006BDF` shipped at 0.809 ×
retail, `0x06003E9C` at 0.525 ×.

**Scale: 175 of the 2,192 shipped r7 bakes (8.1% of the band-checked set) are
outside a [1.05, 1.30] lumRatio band for this reason.** Concentrated in the
cutout-heavy lanes: props 67, scenery 60, creatures 19, doors 7.

Fix: `legibility.py` `_ref_mask()` — when the retail reference carries a real
cutout, that cutout (nearest-resampled to the candidate's grid) defines the
population for *both* sides. Fully-opaque references are unaffected.

**Regression proof of the no-op property**: re-baking `0x06003C83` and
`0x06003E7E` from the *original* r7 corpus with `DATPATCH_COLOR_ANCHOR=lum`
reproduces the shipped r7 PNGs **byte-identically** (maxAbsDiff 0).

### 2b. `DATPATCH_DEBLOCK_BASE` could hijack the anchor's reference

`matlib.tex_path` (`matlib.py:118` before the fix) returned the *deblocked*
PNG for any `prefer_remacri=False` lookup — which is exactly how `bake_one`
loads the retail anchor reference. With the r7.1 deblock pre-stage mounted, the
anchor would have measured against a filtered image instead of retail.

Magnitude measured on 80 random records of `in-deblocked-full/` vs retail:
median ratio **1.00012**, p1/p99 0.99610/1.00291, worst **1.37%**. Small today,
unbounded for any future pre-stage. Fixed with an explicit `allow_deblock=False`
on the anchor's load only (`matlib.py`, `texture_lane.py:398-406`).

Related staleness fix: `matlib.height_for`'s cache key now carries a `_db`
marker when a deblock base is mounted, so a warm `hcache/` from a non-deblocked
run cannot be silently reused.

### 2c. A warm `baked/` dir would have made the whole deblock rebake a no-op

`r7_driver4.sh` exports `DATPATCH_BAKE_CACHE=1`, and `texture_lane.py:551-560`
reuses `baked/<rs>.png` verbatim when it exists. Pointing `DATPATCH_REMACRI` at
the new A-arm over the existing `$R7/<lane>/baked/` dirs (2,192 PNGs on disk)
would have re-imported the **old** pixels while every log line said "re-encoded".

Fix: `texture_lane.bake_config_guard()` stamps `baked/bake-config.json` with
every input that decides the bytes (`DATPATCH_REMACRI`, `DATPATCH_DEBLOCK_BASE`,
`DATPATCH_TEX_BASE`, `DATPATCH_WRAPPED_CORPUS`, `DATPATCH_BAKE_MAX_SIDE`,
`DATPATCH_COLOR_ANCHOR`, `prefer_remacri`, `LUM_TARGET`, gainset) and raises
`SystemExit` with the diff on mismatch (`DATPATCH_BAKE_CACHE_FORCE=1` overrides).
Take 5 also defaults `DATPATCH_BAKE_CACHE=0`.

---

## 3. The residual after anchoring, and the colour-stats transfer

The anchor is a single scalar gain matched on **luminance only**. Two residuals
survive it, both measurable on the shipped corpus:

* **Saturation**: median satRatio vs retail **0.9293** on r7's 2,192 bakes
  (−7%). Matches the owner's −5..−10%.
* **Channel balance**: median rRatio/gRatio/bRatio **1.1455 / 1.1544 / 1.1990** —
  a ~+4% blue cast relative to the 1.15 exposure the anchor promised.

So the residual is real, and the per-texture colour-stats transfer was
implemented (CPU only, retail reference = the `tex-reexport-2026-07-30` re-export
of `~/ac_base_dats/client_portal.dat`, which was never written to):

`DATPATCH_COLOR_ANCHOR` in `legibility.py`:
* `lum` — r7 semantics (default; keeps every existing lane reproducible).
* `rgb` — solve a gain **per channel** against `1.15 × retail per-channel mean`.
  A strict generalisation: matching all three channels implies the luminance match.
* `rgb+sat` — `rgb`, then a chroma scale about per-texel luma, bisected so mean
  saturation matches retail's, clamped to [0.80, 1.40] so it can only *restore*,
  never enhance. Three alternating rounds; the channel anchor always has the
  last word because it is the hard constraint. The bisection runs on a ≤256k-texel
  stride (estimator error ~0.1%, two orders under the tripwire band).

**r7.1 ships `rgb+sat`** (set explicitly by the take-5 driver, recorded in the
ledger and in each lane's `bake-config.json`).

---

## 4. Proof run — 20 representative textures

Re-encoded through the **real** lane path (`texture_lane.bake_one` + the lane's
alpha transplant) from `/mnt/wbterminal2/deblock-ab/out-remacri-full/`. Sample:
12 from the severe/material quilting set (`ab-scores.jsonl` `excOld ≥ +50%`,
including the report's eye-test stops 0x0600378C / 0x06003C83 / 0x06003C9E and
the median stop 0x06003E7E) + 8 ordinary. Every number is `bake / retail`.

| rsId | tier | A-arm RAW lum/sat | r7 old bake lum/sat | anchored `lum` lum/sat | anchored `rgb+sat` lum/sat |
|---|---|---|---|---|---|
| 0x0600378C | severe | 1.036 / 0.936 | 1.122 / 0.938 | 1.150 / 0.937 | 1.150 / 0.999 |
| 0x06003C83 | severe | 1.015 / 0.983 | 1.152 / 0.944 | 1.152 / 0.947 | 1.152 / 0.965 |
| 0x06003E7E | quilt | 1.054 / 0.940 | 1.155 / 0.948 | 1.155 / 0.940 | 1.155 / 0.968 |
| 0x06003C9E | severe | 1.039 / 0.923 | 1.153 / 0.918 | 1.153 / 0.918 | 1.153 / 0.999 |
| 0x06004727 | severe | 1.081 / 0.926 | 1.156 / 0.920 | 1.156 / 0.926 | 1.156 / 0.996 |
| 0x06003B03 | severe | 1.032 / 0.944 | 1.153 / 0.942 | 1.153 / 0.941 | 1.153 / 0.995 |
| 0x06005E03 | severe | 1.027 / 0.975 | 1.152 / 0.934 | 1.152 / 0.934 | 1.152 / 0.985 |
| 0x06003EEB | severe | 1.134 / 0.920 | 1.160 / 0.918 | 1.160 / 0.921 | 1.160 / 0.973 |
| 0x06003ED7 | severe | 1.034 / 0.939 | 1.153 / 0.939 | 1.153 / 0.939 | 1.153 / 0.990 |
| 0x06006BDF | severe | 1.023 / 0.938 | **0.809** / 0.939 | 1.152 / 0.939 | 1.152 / 0.999 |
| 0x060042E4 | severe | 1.039 / 0.947 | 1.153 / 0.947 | 1.153 / 0.947 | 1.154 / 0.991 |
| 0x06006A0D | severe | 1.033 / 0.946 | 1.153 / 0.941 | 1.153 / 0.944 | 1.153 / 1.016 |
| 0x06006CEA | ordinary | 1.066 / 0.830 | 1.156 / 0.829 | 1.156 / 0.830 | 1.156 / 0.897 |
| 0x06007003 | ordinary | 1.045 / 0.953 | 1.154 / 0.959 | 1.154 / 0.957 | 1.154 / 1.000 |
| 0x0600459C | ordinary | 1.002 / 0.969 | **1.289** / 0.946 | 1.157 / 0.970 | 1.157 / 0.991 |
| 0x06006B9C | ordinary | 1.008 / 0.865 | 1.151 / 0.857 | 1.151 / 0.859 | 1.151 / 1.000 |
| 0x06007375 | ordinary | 1.079 / 0.936 | 1.158 / 0.942 | 1.158 / 0.937 | 1.158 / 0.958 |
| 0x06003F78 | ordinary | 1.015 / 0.994 | **2.517** / 0.488 | 1.154 / 0.982 | 1.154 / 0.991 |
| 0x0600662B | ordinary | 1.007 / 0.942 | 1.151 / 0.840 | 1.151 / 0.840 | 1.151 / 0.941 |
| 0x06004113 | ordinary | 1.092 / 0.935 | 1.159 / 1.037 | 1.159 / 0.962 | 1.158 / 0.959 |

Aggregates over the same 20:

| arm | median lumRatio | median R | median G | median B | median satRatio | p90 castDrift |
|---|---|---|---|---|---|---|
| A-arm RAW (the regression) | 1.0352 | 1.0334 | 1.0364 | 1.0751 | 0.9394 | 0.0404 |
| r7 old bake (what shipped) | 1.1534 | 1.1439 | 1.1556 | 1.1932 | 0.9388 | 0.0688 |
| r7.1 anchored `lum` | 1.1534 | 1.1473 | 1.1553 | 1.1930 | 0.9386 | 0.0593 |
| r7.1 anchored `rgb+sat` | **1.1534** | **1.1529** | **1.1536** | **1.1550** | **0.9908** | **0.0029** |

Reading it: the anchor restores the +11.4% brightness the raw A-arm was missing
(1.035 → 1.153) and **fixes three of the twenty r7 records outright** (0.809,
1.289 and 2.517 → 1.152/1.157/1.154 — the §2a defect). `rgb+sat` on top removes
the +4% blue cast (bRatio 1.193 → 1.155) and recovers the saturation loss
(0.939 → 0.991, i.e. ~5.5 of the missing 6 points), with p90 colour cast **24×**
tighter.

### Wider validation — 100 textures, 50 of them r7's defect records

`bake100-rgbsat/` (50 sampled from the 156 available r7 out-of-band records +
50 healthy), scored with the ship thresholds:

```
lumRatio  p10 1.1515  median 1.1539  p90 1.1569
satRatio  p10 0.9298  median 0.9743  p90 1.0002
castDrift median 0.0014  p90 0.0036  p99 0.0222
lumRatio out of band [1.05,1.30]: 0 of 98 checked (0.00%);
                                  2 near-white ceiling-limited (0 darker than retail)
colour ledger: PASS
```

Every one of the 50 previously-defective records lands in band.

---

## 5. The colour ledger (numeric tripwire) — `tools/dat-patch/color_ledger.py`

Per texture, bake vs retail, over a common grid and the **retail alpha mask**
(mask mismatch was itself worth a 3.1× phantom "regression"):

`lumRatio`, `rRatio`/`gRatio`/`bRatio`, `satRatio`, `conRatio`, and
`castDrift = max_c |bake_c − lumRatio·retail_c| / max(retail_lum, 0.15)` —
a scale-free colour-cast metric with a dark floor (without the floor a near-black
tile scores 2.5 for an invisible +0.02 lift and the metric is useless).

Textures whose retail mean luminance is already near white (`1.15 × lumRetail >
0.92`) cannot reach the target — the softclip runs out of headroom — so they are
judged by the weaker rule "never darker than retail" instead of by the band.

### Thresholds, and why these

Calibrated, not guessed: the widest band that **passes** a correctly anchored
corpus and **fails** both the raw A-arm and r7's defect population.

| threshold | default | driver override (rgb+sat) | rationale |
|---|---|---|---|
| `lum_median_tol` | 0.03 | — | raw A-arm median is 1.0363, i.e. 0.114 off the 1.15 anchor — fires with 3.8× margin. Healthy corpora sit at 1.1534 ± 0.0006. |
| `lum_lo` / `lum_hi` | 1.05 / 1.30 | — | shipped-r7 healthy body is p10 1.1515 / p90 1.1614; the band is ~9σ wide either way, yet every §2a defect (0.52…3.10) is outside it. |
| `lum_out_frac` | 0.02 | — | anchored rebake measured 0.00% out of band on 98 checked (incl. 50 ex-defects); r7 as shipped measures 8.07%. |
| `lum_ceiling` | 0.92 | — | headroom rule above; 23 of 2,192 r7 records are ceiling-limited. |
| `chan_median_tol` | 0.08 | — | raw A-arm channel medians are 1.034/1.034/1.069 → all three fire. r7's +4% blue cast (1.199) passes at the default and is the reason the driver ships `rgb+sat`. |
| `sat_median_lo` / `hi` | 0.88 / 1.15 | **0.95** | 0.88 admits a `lum`-anchored corpus (0.929); the 0.95 override is the `rgb+sat` *mode contract* — measured 0.974 on the hostile 50%-defect sample, 0.991 on the ordinary sample, vs 0.936/0.929 with no chroma anchor. |
| `cast_p99` | 0.20 | **0.05** | r7 healthy p99 is 0.157 under `lum`; `rgb+sat` measures 0.022. |
| `min_records` | 1 | **1500** | an empty/partial bake set is itself a failure — the ledger must never pass by having nothing to look at. |

**Would it have caught the regression?** Run against the raw A-arm corpus the
gate exits 1 with six violations:

```
colour ledger [A-arm RAW (the regression, 1630)]: 1630 textures scored
  lumRatio p10 1.0112 median 1.0363 p90 1.0939
  out of band [1.05,1.30]: 1104 of 1615 checked (68.36%)
  - median lumRatio 1.0363 is off the 1.15 anchor by more than 0.030 ...
  - 68.36% of textures are outside the per-texture lumRatio band ...
  - median rRatio 1.0343 / gRatio 1.0344 / bRatio 1.0689 off the anchor ...
  - 1 near-white texture came back DARKER than retail: 0x060043F3
EXIT=1
```

Run against the shipped r7 corpus it also exits 1 — correctly, on the §2a defect
population (8.07% out of band, p99 castDrift 0.277).

Wiring: take-5 stage 2, on the bake artefacts, **after every lane and before the
structural fixup**. A colour regression is a bake fault; catching it there costs
a re-bake, catching it at the eye-test costs the take.

---

## 6. Degrade-chain fold (I3) — `tools/dat-patch/r7_take5.sh`

Takes 1–4 lived in `/mnt/wbterminal2/dat-patch-r7/r7_driver{,2,3,4}.sh` (outside
the repo). Take 5 is versioned in-repo at `tools/dat-patch/r7_take5.sh`, derived
from `r7_driver4.sh`, with the stage order the README prescribes:

```
1  lanes            texture_lane.py run --remacri   (per lane; walk+guard+compress after each)
2  COLOUR LEDGER    color_ledger.py --gate           <- new; on the bake artefacts
3  fixup            texture_lane.py fixup + walk_check
4  DEGRADE FIX      fix_degrade_chains.py --fix --retail $BASE --wbt $WBT --json $R7/degrade-fix.json
   walk_check; DatCompress; DatCompact                <- churn absorbed by the compact
5  final validation datlib strict walk (83,618 entries)
   DEGRADE CHECK    fix_degrade_chains.py --check --retail $BASE --json $R7/degrade-check.json
6  package          tar + sha256 + R71_BAKE_DONE
```

* **Placement** is exactly the README's: `--fix` after every lane has written
  (the baked set is only complete then) and before the final compress/compact;
  `--check` on the file that gets packaged.
* **Idempotent**: the driver rebuilds from the canonical r6 copy each run;
  `--fix` delegates to WBT `surface-texture-collapse`, which reports
  `ALREADY-SINGLE` for chains already collapsed, and `fix_degrade_chains`
  re-analyses after writing and exits nonzero on residue
  (`fix_degrade_chains.py:404-407`).
* **Fail-loud**: `set -eu`, distinct exit codes (7 colour, 8 structural/degrade,
  9 ceiling guard), and preflight existence checks on the WBT dll, the corpus
  and the retail re-export.

Verified against the shipped r7 portal — the ship gate would have blocked it:

```
$ python3 fix_degrade_chains.py $R7/export/client_portal.dat --check --retail ~/ac_base_dats/client_portal.dat
client_portal.dat: 7221 SurfaceTextures, 7212 distinct chains (1624 multi-entry), baked set 1
  chain-length histogram: {'1': 5597, '2': 1624}
  degrade-chain violations: 1
    chain ['0x0600628F', '0x060045B4']  sts ['0x05000ECE']  keep 0x060045B4
EXIT=1
```

---

## 7. Files changed

| file | change |
|---|---|
| `tools/dat-patch/legibility.py` | `_ref_mask`/`_mlum` — the anchor now averages both sides over the reference's texel population (the §2a defect). `COLOUR_ANCHOR` modes `lum`/`rgb`/`rgb+sat` via `DATPATCH_COLOR_ANCHOR`; `chan_means`, `mean_sat`, `_sat_scale`, `_solve_sat`. `info` gained `sat_gain`, `color_anchor`, `anchor_mask_frac`. |
| `tools/dat-patch/matlib.py` | `tex_path`/`load_tex`/`load_tex_full` gained `allow_deblock` so a mounted `DATPATCH_DEBLOCK_BASE` can never become the anchor's reference; `height_for` cache key carries a `_db` marker. |
| `tools/dat-patch/texture_lane.py` | anchor base loaded with `allow_deblock=False`; `bake_config_sig`/`bake_config_guard` (stale-bake-cache tripwire, called at the top of `run_lane`); per-record plan gained `colorAnchor`, `satGain`, `exposureGain`, `cached`. |
| `tools/dat-patch/color_ledger.py` | **new** — the colour tripwire + gate. |
| `tools/dat-patch/r7_take5.sh` | **new** — the r7.1 take-5 driver (deblock corpus, explicit anchor, colour-ledger gate, degrade `--fix` + packaged `--check`). |
| `tools/dat-patch/README.md` | new "colour anchor and its ledger" section; take-driver entry in Layout; degrade-chain placement note points at the take-5 stages. |

Scratch artefacts (not in the repo): `/mnt/wbterminal2/color-anchor-2026-08-18/`
— `cal-r7-shipped.json` (2,192-record ledger of the shipped corpus),
`led-aarm-raw.json` (1,630-record ledger of the regression),
`led-100-rgbsat.json`, `sample20-scores.json`, `bake-lum/`, `bake-rgbsat/`,
`bake100-rgbsat/`, `proof.py`, `stats.py`.

---

## 8. Not verified / open

1. **No full-corpus r7.1 rebake was run** — that is the ~50-minute take-5 job and
   it needs the whole `$R7/<lane>/ids_*.txt` set plus the r6 source portal. The
   colour claims are proven on 120 textures (20 representative + 100 including
   50 of the defect population), not on all 2,192. The corpus-wide out-of-band
   fraction under `rgb+sat` is therefore *projected* 0%, measured 0/98.
2. **No dat-side ledger.** The gate scores the bake PNGs, not the DXT1/DXT5
   records after `render-surface-import`. Block compression will move these
   statistics slightly (and unequally for DXT1 vs DXT5). WBT has `export-textures`
   with a `minId`/`maxId` range, so a post-import arm is buildable; it was not
   built or measured here.
3. **No in-client / eye-test verification.** Per §1070-eyetests-batched this
   belongs to the batched r7.1 session (plan step 1.5). The numbers say the
   colour is back; only the eye can price the deblock's mid-tier softness.
4. **`r7_take5.sh` has not been executed end-to-end.** Its stages were validated
   individually: `bash -n`; the colour-ledger invocation with the driver's exact
   arguments (including the `--min-records 1500` fail-loud); `fix_degrade_chains`
   `--fix`/`--check` argument parsing plus a real `--check` on the shipped r7
   portal; the bake-cache guard's fire/idempotent/force paths.
5. **The 175 defective r7 records are diagnosed, not repaired in a shipped dat.**
   They are repaired by construction on the next full rebake (take 5), because
   the fix is in the bake.
6. **`terrain_lane.py` was read but not re-run.** Its `bake_texture` calls pass a
   base whose alpha is the same array the candidate carries, so `_ref_mask`
   resolves to the identical population and the lane's "512-default byte-identical"
   property should hold — argued from the code, not re-measured.
