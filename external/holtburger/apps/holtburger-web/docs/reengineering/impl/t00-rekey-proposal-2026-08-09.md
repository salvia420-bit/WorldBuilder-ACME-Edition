# T00 re-key proposal — the texture axis of the pool class key (2026-08-09)

Agent: census re-key analyst. Inputs: T00 live census (task-T00-report.md, run 3,
commit `4ecc8ec6`, VERDICT RE-EXAMINE), pass-07 S3/D-07.2/D-07.7/S5, SPEC §1.3/§1.5/§3
(T00, T22), task-T15-report.md, and the two REAL captured snapshots
`/mnt/wbterminal2/reeng/T00/census-class-{nanto,townnetwork}-2026-08-09.json`.
**Offline analysis only** — every candidate was evaluated by re-reducing the real
snapshots through the harness's own exported reducer
(`harness/census-class.mjs` `reduceClassCensus`/`classKeyOf`), with candidate tex-axis
transforms applied to the raw records exactly the way the harness's `axisAnalysis`
applies its drops. No synthetic data; no browser.

Evaluation script + outputs: `/mnt/wbterminal2/reeng/T00/rekey/`
(`rekey-reduce.mjs`, `rekey-results.json`, `rekey-supplement.json`, `rekey-run.log`).

**Recommendation in one line:** replace the raw-dims byte with an **ARRAY-PAGE TIER**
— `tex = x{t}{f7|f8}`, t = log2 page edge ∈ {8,9,10,11} (square pow2 pages
256²/512²/1024²/2048², tier = clamp-ceil of the max TEXREF dim), members stored
**resampled to page dims** — giving 63/51 classes, 271/238 pools (≤ 300 ✓ both),
**zero** layer-share violations by construction, and program classes 24/23 (≤ 48 ✓).

## 1. Baseline reproduction (rig validity)

`node harness/census-class.mjs --reduce <snapshot>` over the captured snapshots
reproduces the T00 report exactly:

| scene | classes | pools | report says |
|---|---|---|---|
| nanto | 122 | 352 | 122 / 352 ✓ |
| townnetwork | 80 | 274 | 80 / 274 ✓ |

## 2. What texDims was protecting (the correctness constraint)

Pass-7 D-07.2: *"`textureArrayId` is forced by `texStorage3D` (format/w/h/depth fixed
at allocation)"*. One class = ONE material = ONE `sampler2DArray`; a pool is one
BatchedMesh = one draw = one material. Two textures can share a class **only if they
can share layers of one array page**, i.e. identical (w, h, format). That is the
constraint; raw dims enforced it by making every distinct (w, h) its own class.

The landed reality (T15, task-T15-report.md deviation d) keys array buckets on **exact
`map` dims + format** today (`stat-atlas-x-<w>x<h>…|f7`), with the TEXREF-keyed form
explicitly reserved for "the ST9 class-key material tier" — i.e. for exactly this
decision. The snapshots show why exact dims cannot be the class axis: **27 (Nanto) /
22 (TN) distinct (dims, format) combos** live in the pooled population, dominated by
square pow2 (512² f7 alone: 126 materials at Nanto) with a thin non-square tail
(256×512, 512×256, 1024×2048, …).

**Violation metric used below:** group the ORIGINAL records by the CANDIDATE class
key; each distinct exact (w, h, format) combo in a class beyond the first is one
violation (= one extra `texStorage3D` page the class material cannot bind).

## 3. Candidate table (both scenes, real snapshots, harness reducer)

Bounds: classes ≤ 48, pools ≤ 300 (SPEC §3 T00 [A]).

| candidate | tex axis | nanto classes/pools | TN classes/pools | page violations n/TN (pre-normalization) | what breaks |
|---|---|---|---|---|---|
| **baseline** (S3 as designed) | raw `(log2w<<4\|log2h)` + f7\|f8 | 122 ✗ / 352 ✗ | 80 ✗ / 274 ✓ | 0 / 0 | nothing breaks; the census bounds do — 92 of Nanto's 122 classes exist only for raw dims |
| **(1) dropDims** | format only (f7\|f8) | 30 ✓ / 155 ✓ | 26 ✓ / 161 ✓ | **92 / 54** (in 24/18 classes) | classes hold members that CANNOT share one array (e.g. 2048² and 32² in one class). Requires multi-array class materials (re-fragmentation in disguise, defeats one-material-per-class) or one global page size (~×64 upsample for small textures — VRAM absurd). REJECT |
| **(2a) tier256 — WINNER** | page tier {256,512,1024,2048}² + format | **63 / 271 ✓** | **51 / 238 ✓** | 59 / 29 pre-norm → **0 post-normalization** (members stored at page dims) | class bound: 63 > 48 — resolved by the gate split in §6 (program classes 24/23 ≤ 48) |
| (2b) tier128 | page tier {128,…,2048}² + format | 73 / 287 ✓ | 54 / 244 ✓ | 49 / 26 pre-norm → 0 post-norm | strictly dominated by tier256: +10/+3 classes for a trivial resample saving (22.2 vs 23.1 MB native) |
| **(3) aspect-only** | square vs non-square + format | 44 ✓ / 185 ✓ | 33 ✓ / 175 ✓ | **78 / 47** (in 28/21 classes) | same failure as dropDims (256² and 2048² share a class); no page maps to "square". REJECT |
| **(4) T15 page key** | exact map dims + format | 122 / 352 | 80 / 274 | 0 / 0 | identical to baseline BY CONSTRUCTION — the landed atlas keys pages on exact dims; proves the fragmentation is inherited from putting the exact page identity in the class key |

## 4. The winning key, precisely

```
tex = x{t}{f7|f8}
t   = clamp(ceil(log2(max(TEXREF w, TEXREF h))), 8, 11)     ∈ {8, 9, 10, 11}
      → square pow2 array pages 256² / 512² / 1024² / 2048² per format
```

**Normalization rule (the correctness half of the proposal):** a member whose native
dims ≠ its page dims is stored **resampled (upscaled) to page dims** at bake/transcode
time. The layer is always fully covered — UV 0..1 spans the whole layer, so **wrap
(`r{w|c}`), full mip chains, and aniso all stay legal** (no subrects, no `fract()`
shader tricks, no mip bleed). Non-square members stretch to square (resampling is
upscale-only by construction of `t`); tiny members pay the page (measured cost below).

**Correctness argument:** after normalization every member of a class has identical
(w, h, format) = the page — so any two members can share any layer of the class's one
`texStorage3D` allocation BY CONSTRUCTION. Violations = 0 is a theorem of the key, not
a measurement. The D-07.2 soundness paragraph survives intact: the tier IS the
(format, w, h) triple that `texStorage3D` fixes; nothing else in the key changed.

**Why TEXREF dims, not live dims:** tier derives from TEXREF-**declared** (full-tier)
dims, preserving pass-5 D-05.6.2 ("bucket identity known before any payload arrives")
and D-07.9 (class set CLOSED at boot — TEXREF is bake-time static). Class identity is
then **stable across preview→full**: a member never changes class as its resident tier
upgrades.

Measured composition of the winner (from `rekey-supplement.json`; tier tokens collapse
27/22 raw combos to **5** — 256f7, 256f8, 512f7, 1024f7, 2048f7):

| page | nanto mats/inst (resampled mats) | TN mats/inst (resampled mats) |
|---|---|---|
| 256² f7 | 140 / 2,631 (101) | 43 / 2,195 (30) |
| 256² f8 | 13 / 42 (8) | 4 / 16 (3) |
| 512² f7 | 161 / 3,025 (35) | 34 / 2,356 (12) |
| 1024² f7 | 52 / 5,057 (16) | 31 / 4,991 (3) |
| 2048² f7 | 33 / 17,551 (2) | 34 / 18,251 (7) |

**Resample cost [D, upper bound]:** Nanto 162 materials resampled, chain bytes
23.1 → 54.8 MB (**+31.6 MB**); TN 55 materials, 21.2 → 48.8 MB (+27.6 MB). Counted
per-material (unique textures ≤ materials), so real VRAM overhead is at or below this
— comfortably inside the D-05.8 ≤ 256 MiB atlas-class budget. Most of the load is tiny
textures paying the 256² floor (101 of Nanto's 162).

**Preview feed (advisory, T22's choice — not part of the key):** D-07.7's "128²-dims
class pool" landing zone predates this key. Two compatible options: (a) keep a
designated preview page per class-tier and keep `atlasRefeed` as pool-to-pool member
transfer (D-07.7 verbatim); or (b) upsample the ≤128² preview into the member's FINAL
page layer at transcode — member never changes pools, `atlasRefeed` degenerates to an
in-place layer rewrite (no addInstance/deleteInstance churn), at the price of
full-page-sized preview uploads during the boot burst (P4-budgeted). Either preserves
the key; (b) is the simpler pool contract.

## 5. Interaction check — full axis table under the winning key

Classes each axis adds, computed over tier256-keyed records (base = 63 Nanto / 51 TN):

| axis | nanto | townnetwork |
|---|---|---|
| tex (tier+format, residual) | +33 | +25 |
| stateAlphaTest | +18 | +12 |
| patchBias | +9 | +3 |
| patchVfx | +8 | +9 |
| texFormat alone | +6 | +3 |
| vfxConfigOnly | +0 | +3 |
| domain, blend, wrap, side, depthWrite, shadow | +0 | +0 |

No axis pushes any bound back over after the fix: pools stay 271/238 ≤ 300 with ~10%
headroom, and the secondary contributors the T00 report flagged (patchBias +20 → +9;
alphaTest +16 → +18; the three alphaTest values are 0 / 0.392… / 0.784… — the
retail-derived ClipMap pair, load-bearing per D-07.3) remain individually small. The
residual tex contribution (+33/+25) is the price of correctness — it is the page
identity itself, now at 5 tokens instead of 27/22.

**Program classes** (key modulo the entire tex axis — dims AND format never change the
GLSL program; a 512² and a 2048² `sampler2DArray` compile identically): **24 (Nanto) /
23 (TN)** — the population that D-07.9's prewarm list, the p99 link-storm term, and
the 160-program-switch term actually key on, comfortably ≤ 48.

## 6. Taint honesty (what these numbers are)

- **Both snapshots carry `settled:false`** (T00 report taint 1): counts are late-burst
  residency, not a settled floor — direction of error unknown but small
  (terrainBakedLbs 130/136 ≈ streaming substantially complete). Treat every figure
  here as a point estimate with small error, **neither a strict floor nor ceiling**.
  Candidate RANKING is robust to this: all candidates reduce the SAME snapshot, and
  the fragmentation structure is content-driven. The pools margin (271 vs 300) is
  ~10% — a settled run could move it either way.
- **TN VFX floor** (T00 taint 2): 8 TN classes carry an unresolvable
  `deformation.windSwayGpu` config (counted as one each) — TN class counts are FLOORS
  on the vfx-config axis, for every candidate equally.
- **Live-dims approximation**: the census reads live texture dims; the proposed key
  reads TEXREF full-tier dims. Members resident at preview dims during capture would
  tier UP under TEXREF keying — this cannot mint new tier tokens (the 5-token set is
  the ceiling by content) but could shift a few members/pools between tiers.
- The 1070 confirm arm (F-11.13, GATE-POOLS) remains the second venue and should
  re-run the census with the amended key.

**Residual flag for the orchestrator (not resolved here):** D-07.6/SPEC §1.5 carry
"world-static nodes ≤ ~250 [A]" while the winner projects 271 pools at Nanto (baseline
was 352). Resident-attached ≠ drawn, and the census sector spread (11–12 sectors) is
below the ≤ 16 ceiling, but the ~250 [A] node figure deserves a look when T22 sizes —
either it absorbs the same re-baseline or sector-level culling arithmetic closes it.

## 7. EXACT amendments (I3 — the orchestrator propagates; apply verbatim)

### 7.1 pass-07 S3 — replace the `tex` line of the canonical form

Current:
```
 tex    = x{(log2w<<4|log2h) hex}{f7|f8}    (pass 5 TEXREF dims byte + format)
```
Replace with:
```
 tex    = x{t}{f7|f8}   (ARRAY-PAGE TIER + format; t = log2 page edge ∈ {8,9,10,11}
          — square pow2 pages 256²/512²/1024²/2048²,
          t = clamp(ceil(log2(max(TEXREF w, TEXREF h))), 8, 11). Members whose
          native dims ≠ page dims are stored RESAMPLED (upscaled) to page dims at
          bake/transcode time — every layer fully covered, so wrap, full mip
          chains and aniso stay legal. Raw-dims keying is RETIRED from the class
          key: it fragmented the census (+92 classes at Nanto; T00 re-key
          2026-08-09). Tier derives from TEXREF-DECLARED dims (D-05.6.2: identity
          before payload; class identity stable across preview→full).)
```

### 7.2 pass-07 D-07.2 — replace the `textureArrayId` line of the MatClassKey block

Current:
```
  textureArrayId  (log2 w << 4 | log2 h) from pass 5 TEXREF dims + format (f7|f8)
```
Replace with:
```
  textureArrayPage  array-page tier: square pow2 page 256²–2048² (clamp-ceil of the
                  max TEXREF dim) + format (f7|f8); members resampled to page dims
                  (T00 re-key 2026-08-09 — raw dims retired from the key)
```

Also rename the two other `textureArrayId` mentions in D-07.2 for consistency: the
`MatClassKey = … | textureArrayId | shadowPair` header line → `textureArrayPage`, and
in the load-bearing paragraph "`textureArrayId` is forced by `texStorage3D`" →
"`textureArrayPage` is forced by `texStorage3D`" (the sentence stays true verbatim —
the tier IS the (format, w, h) triple `texStorage3D` fixes).

### 7.3 pass-07 S5.3 — re-baseline the census gate sentence

Current:
```
3. **Census gates (pass 10 wiring):** `pools.count ≤ 300` at settled Nanto (else the
   class key is fragmenting — investigate before shipping) [A]; `classes.count` reported
```
Replace with:
```
3. **Census gates (pass 10 wiring):** `pools.count ≤ 300` at settled Nanto (else the
   class key is fragmenting — investigate before shipping) [M: 271 Nanto / 238 TN
   under the page-tier key, T00 re-key 2026-08-09]; `classes.count ≤ ~72` [A;
   measured 63/51 late-burst] with `programClasses.count ≤ ~48` (the class key modulo
   the tex axis — the D-07.9 program population; measured 24/23); `classes.count` reported
```

### 7.4 SPEC §1.5 — replace the tex clause of the Class-key bullet

Current:
```
  textureArrayId (TEXREF dims+format)
```
Replace with:
```
  textureArrayPage (page TIER: square pow2 page 256²/512²/1024²/2048² = clamp-ceil of
  the max TEXREF dim, + format f7|f8; members resampled to page dims at bake/transcode
  — raw dims retired from the key, T00 re-key 2026-08-09)
```

### 7.5 SPEC §3 T00 — re-baseline the acceptance figures

Current:
```
≤ ~48 / projected pools ≤ ~300, or pass 7's key design is re-examined BEFORE T22 sizes
```
Replace the acceptance clause "classes ≤ ~48 / projected pools ≤ ~300" with:
```
total classes ≤ ~72 / program classes (key modulo tex axis) ≤ ~48 / projected pools
≤ ~300 (page-tier key per the T00 re-key 2026-08-09)
```

T22's own acceptance line ("pools ≤ ~300") needs no edit. R-03 closes as MEASURED
under the amended key: 63/271 (Nanto), 51/238 (TN), program classes 24/23, zero
layer-share violations by construction — pending the 1070 confirm arm at GATE-POOLS.

## 8. Artifacts

- Candidate evaluation: `/mnt/wbterminal2/reeng/T00/rekey/rekey-reduce.mjs` (imports
  the harness reducer; run from the app root)
- Results: `/mnt/wbterminal2/reeng/T00/rekey/rekey-results.json` (all candidates ×
  both scenes, violations, resample load, axis tables), `rekey-supplement.json`
  (program classes, per-tier composition), `rekey-run.log`
- Snapshots consumed (unchanged): `/mnt/wbterminal2/reeng/T00/census-class-{nanto,townnetwork}-2026-08-09.json`
