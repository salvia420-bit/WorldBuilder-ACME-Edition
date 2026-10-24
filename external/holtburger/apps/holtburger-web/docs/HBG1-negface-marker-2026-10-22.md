# HBG1 v2: the `?negFace` back-face marker (2026-10-22)

Handoff item **F7(a)** of `docs/HANDOFF-gpu-resident-statics-2026-10-22.md`.

`?negFace` has been default ON since 2026-10-19. Until this change, it made
`assemble_model_geometry` return `missing` for every model. That disabled
`?geomBundles` on any default URL, and `?drawPools` needs `?geomBundles`.

**Status:**
- **Written:** the Rust codec, the pack writer, the wasm reader, the JS diag seam, and node, native and real-DAT tests.
- **Not done:** no compile, no cargo test, no wasm build, no bake, no browser run. The laptop rule reserves those for
  the orchestrator, one at a time.
- **Run here:** node tests only (§6).

Evidence tags: **[M]** measured (source named), **[D]** derived from code that was read, **[A]** assumed. This document
makes no fps claim. The term the change shrinks is `__diag.geometry.geomFallback.modelsServedByRuntimeDecode`. On a v2
dist under the default flags, that counter should fall back to entity-only, as the `geomBundles` row of
`url-flags.md` asks.

---

## 1. What `?negFace` changes, read from code

The flag reader is `parse_neg_face_retail_flag` in `src/lib.rs`, parsed once per wasm instance from `flag_search()`
(the bake worker uses its own seeded query string). The url-flags row for `negFace` matches it.

Two triangulators read the flag:
- **GfxObj models:** `append_gfx_tris_with_tex_swaps`. Statics, buildings and animated scenery all go through it, by
  way of `triangulate_model_uncached`, `triangulate_setup_model_per_part` and the related callers.
- **EnvCells:** `append_environment_tris`.

The decision unit is **one source polygon**, plus that polygon's pos and neg Surface. [D]

### 1.1 GfxObj polygons (the model path)

| Polygon class | `?negFace=off` (legacy) | `?negFace` on (the default) | `?negFace` + `?perPolyCull=on` |
|---|---|---|---|
| SidesType 2, NoNeg (0x8) clear, `neg_uv_indices` present, neg DID ≠ 0 and ≠ pos DID | front tri **+ REVERSED back tri**: neg DID, neg UVs, ACB winding, normals ×−1 | front tri only | front tri. Exception: when `neg_surface < pos_surface` and both Surfaces are opaque (not `0x10314`-delayed), the **same-winding neg copy replaces it** (`front_copy_neg_did`) |
| NoPos (stippling 0x4 means "no POSITIVE UV indices"), pos Surface **textured** (`type & 6`) | skipped | **front tri, UV slot 0**, no back | same as `?negFace` on |
| NoPos, pos Surface untextured or of unknown type | skipped | skipped | skipped |
| every other drawing polygon | front tri | front tri | front tri |

The runtime reads "textured" and "opaque" from `SURFACE_TYPE_BITS`. `prime_surface_types` primes that table from each
Surface record before the triangulator runs, and only under the flag. [D]

### 1.2 EnvCell polygons

Only the back-face rule differs here: `?negFace` emits no reversed back tri, and NoPos stays skipped under every arm.
HBG1 already handled this. Env subsets have carried `ENV_BACKFACE` since T13, and on 10-13 `assemble_envcells` began
dropping them under the flag. **Env payloads therefore need no change and stay v1.** [D]

### 1.3 What the marker must encode

Every model triangle falls into one of four classes:

| Class | Triangles | Arms that draw it |
|---|---|---|
| A | ordinary front tris | both arms |
| B | the reversed back tris | legacy arm only (`=off`) |
| C | front tris of textured NoPos polygons, at UV slot 0 | `?negFace` arm only |
| D | same-winding front copies | `?negFace` + `?perPolyCull=on` only. Each one **replaces** a class-A tri of the same polygon |

A v1 payload carries classes A and B with **no way to tell them apart**: the encoder keys subsets on (surface, flags,
pair), and a back tri's flags equal a front tri's when the stipple side bits agree. It also carries **no class C at
all**, because v1 skips NoPos. No v1 assembly can reproduce the default arm, and that is why the reader answered
`missing`. [D]

The marker is per **subset**. The encoder already makes the subset flags part of the subset key, so adding one bit per
class puts every class-B tri and every class-C tri in a subset of its own. An arm then keeps or drops whole subsets.
- What remains equals that arm's runtime triangle set as a **per-surface multiset**. That is the bar the existing
  differs hold the bundle path to (`assert_groups_equal`).
- It also preserves that arm's **first-seen surface order**, because a subset's position is set by its own first
  triangle. [D]

Class D is not encoded. Encoding it would take two more classes: the copies, and the class-A tris they replace. The
payload carries a conservative flag instead (§2), and that arm falls back for flagged models. `?perPolyCull` stays off
by default (url-flags `negFace` row).

## 2. The format change: v2 on kind-0 PART payloads

The byte layout does not change. Only these values are new:

| Field | Value | Meaning |
|---|---|---|
| payload header byte 5 (`version`) | `HBG1_VERSION_FACES = 2` | The subsets of this kind-0 PART payload carry the face marker. |
| payload `flags` bit 4 | `flags::NEG_FRONT_COPY` | Some SidesType-2 polygon has `neg_surface < pos_surface` with neg in range. This is the **geometric superset** of the runtime's front-copy rule: opacity and pos-DID are ignored, and so is NoNeg (retail builds side 1 either way). |
| subset `flags` bit 3 | `subset_flags::MODEL_BACKFACE` (the same bit as `ENV_BACKFACE`: "this is a back face") | The class-B reversed back tri. The bake already resolved the DID comparison, so the pair slot is 0. |
| subset `flags` bit 4 | `subset_flags::NOPOS_SLOT0` | The class-C NoPos front tri at UV slot 0. |

**What is written as v2:**
- **Written as v2:** top-level 0x01 GfxObj payloads in GEOM (0x09) and GEOMR (0x0C) rows.
- **Unchanged and still v1:** 0x02 SETUP directories, 0x0D ENV directories, and the mesh blocks embedded in ENV
  directories. The v2 bake writes those byte-identically to the v1 bake.
- **Row `encoding` stays `0x0001`.** No pack-reader change was needed (`crates/holtburger-resource-http/src/pack.rs`
  is untouched).

**How "textured" is decided:**
- **At bake time:** `hbg1::read_surface_type` reads the Surface record's `type` from the portal DAT. This is the bake's
  twin of `prime_surface_types`.
- **When the record is missing or unreadable:** the NoPos polygon is skipped. That is the runtime's unknown-type rule.

**The reader:** `src/geom_bundles.rs`, `FaceArm::drop_mask`. It runs per part payload.

| payload | `?negFace` on (default) | `?negFace=off` | `?negFace` + `?perPolyCull=on` |
|---|---|---|---|
| v1 | `missing` (counted `faceUnmarked`). This is the old rule, now applied per payload. | all subsets, exactly as before | `missing` (`faceUnmarked`) |
| v2 | drop `MODEL_BACKFACE` | drop `NOPOS_SLOT0` | `NEG_FRONT_COPY` set: `missing` (counted `faceFrontCopy`). Otherwise drop `MODEL_BACKFACE`. |

- **Setups:** a setup is `missing` when ANY of its drawable parts misses. This is the existing "never a partial
  building" rule. Since 2026-10-23 each part is checked as it is read, so on a v1 dist under `?negFace` a setup stops at
  its first part instead of copying every part payload out of the pack (review hbg1v2-2). A 0x01 model on a v1 dist
  still costs one payload copy and a header parse before its `Unmarked`, because `PackSource::geom_payload` returns an
  owned `Vec`. Before v2 that arm read nothing. Opt-in only, and gone after the rebake.
- **Compaction:** after a drop, the kept index ranges are repacked in payload order. The vertex stream is compacted to
  the vertices those ranges use, numbered by first use, which is the encoder's own rule. No orphan back-face or NoPos
  vertices stay in the bundle, and the entry's bbox is that arm's bbox.
- **No-drop fast path:** a payload with nothing to drop takes the old verbatim copy. Every v1 payload on the legacy arm
  takes it.

### 2.1 Compatibility (wasm × dist)

| | v1 dist (served today) | v2 dist (after the rebake) |
|---|---|---|
| **old wasm** (today's `pkg/`) | `?negFace` on: every model `missing` (today). `=off`: assembled. | `?negFace` on: every model `missing`. The old export returns `None` before it parses anything, so nothing changes. `=off`: the old `parse_header` rejects v2, so `assemble_model_geometry` throws and **the whole batch** goes to the runtime decode with a `console.error`. Pixel-correct, but noisy. |
| **new wasm** | `?negFace` on: `missing` + `faceUnmarked` + **one** `console.warn` ("rebake GEOM"). `=off`: assembled, byte-identical to before. | Both arms assemble. `+perPolyCull`: flagged models fall back. |

A dist that mixes packs from both bakes is decided **per payload**. Only one cell of the table is noisy (old wasm, v2
dist, `=off`), so **rebuild and deploy the release wasm before activating the v2 dist** (§5 step 0).

## 3. Code

| File | Change |
|---|---|
| `crates/holtburger-dat/src/hbg1.rs` | Module-doc section "v2". `HBG1_VERSION_FACES`, `flags::NEG_FRONT_COPY`, `subset_flags::{MODEL_BACKFACE, NOPOS_SLOT0}`. `PolyPlan` replaces the resolver's tuple, and the NoPos skip moved from `fan_polygons` into the resolvers (the env and v1 resolvers still skip). New: `encode_gfx_part_faces`, `encode_gfx_part_relief_faces`, `read_surface_type`, `has_front_copy_candidate`, `MeshBuilder::serialize_with`, `Hbg1Mesh::face_marked`. `parse_header` now accepts v1 and v2. `encode_gfx_part` and `encode_gfx_part_relief` (v1) keep their bytes. 5 new unit tests. |
| `apps/holtburger-tools/src/pack_bake.rs` | `GeomBaker` writes 0x01 GEOM and GEOMR rows as v2. It memoizes Surface types per bake, and its census adds 4 report fields (`geom_face_marked_parts`, `geom_face_backface_parts`, `geom_face_nopos_parts`, `geom_face_front_copy_parts`). `verify_geom` gains leg **(f)**: every 0x01 GEOM row is v2. Leg (e) now also checks that each GEOMR row and its default row share a version. |
| `apps/holtburger-tools/tests/bake_ci.rs` | Both `#[ignore]` byte-identity legs re-encode through the v2 encoders. |
| `apps/holtburger-web/src/geom_bundles.rs` | Module-doc section. `FaceArm`, `Miss`, the filtered and compacted `collect_part_source`, and descriptor fields `negFaceRetail` / `faceUnmarked` / `faceFrontCopy`. The blanket `?negFace ⇒ None` was removed from both model exports. 3 new fixture differs, plus 1 `#[ignore]` real-DAT differ. 2026-10-23 (review): the setup branch checks each part's arm as it reads it; 2 more fixture tests (the v2 SETUP differ on both arms, the v1 setup early-out) and a setup leg in the real-DAT differ. |
| `apps/holtburger-web/scene3d/geom_bundles.js` | Header note. `__diag.geometry.faceMarker` = `{negFaceRetail, unmarkedModels, frontCopyModels}`, a once-only "rebake GEOM" `console.warn`, and the test seam `_testResetFaceMarkerAudit`. Group shapes are unchanged, because `_subsetsToGroups` reads flag bits 0-2 only. |
| `apps/holtburger-web/tests/geom_bundles_negface.test.mjs` (new) | 17 checks on the JS half. |
| `apps/holtburger-web/scripts/hbg1_face_census.py` (new) | At-rest census of the packs the manifest's `world_index` names, with a `--require-v2` gate and a `--diff OTHER` section-level bake compare. |

## 4. Build and test commands (orchestrator: one at a time, inside the cap)

Before each command: `free -m` must show at least 2.5 GB available, and `pgrep -x rust-analyzer | xargs -r kill`.
Run from `external/holtburger`, with `P='env PATH=/home/wbterminal/.cargo/bin:/usr/local/bin:/usr/bin:/bin'`. Never
use `--workspace`.

1. `$P capped-build cargo test -p holtburger-dat --lib hbg1`
   - Expect: the existing hbg1 tests, plus `faces_v2_marks_backface_nopos_and_front_copy`,
     `faces_v2_unknown_surface_type_skips_nopos`, `faces_v2_is_v1_plus_version_byte_when_nothing_to_mark`,
     `parse_header_accepts_v1_and_v2_only` and `relief_faces_variant_is_additive_over_the_faces_default`.
2. `$P capped-build cargo test -p holtburger-web --lib geom_bundles`
   - Expect: the existing differs, plus `neg_face_v2_model_matches_runtime_on_both_arms`,
     `neg_face_v1_payload_is_missing_under_retail_only`,
     `neg_face_front_copy_candidates_fall_back_only_under_per_poly_cull`,
     `neg_face_v2_setup_matches_runtime_on_both_arms` and `neg_face_v1_setup_stops_at_first_unmarked_part`
     (the last two added 2026-10-23).
3. `$P capped-build cargo test -p holtburger-tools --no-run`
   - A compile check of `pack_bake.rs` and `bake_ci.rs`. The bake legs themselves are `#[ignore]` and heavy (§5).
4. Real-DAT corpus differ (needs `~/ac_base_dats`). Run it **by exact name**, because the relief differs flip
   process-wide relief atomics:
   `$P capped-build cargo test -p holtburger-web --lib geom_bundles::tests::differ_real_dats_models_neg_face_v2 -- --ignored --exact --nocapture`
   - It prints `real-DAT negFace v2: N GfxObjs encoded | MODEL_BACKFACE … | NOPOS_SLOT0 … | NEG_FRONT_COPY … | exact on
     both arms: …`.
   - Since 2026-10-23 it also runs a setup leg and prints `real-DAT negFace v2 setups: exact on both arms: M using a marked
     GfxObj + P plain (S scaled: positions + uvs only)`. Every setup that uses a marked GfxObj (up to 200) and the first
     150 plain ones are checked on both arms. Positions and uvs must be bit-exact. Normals are held to 2 quantization
     steps only on unit-scale setups, because a skewed `default_scale` magnifies one step past any fixed bar. M is
     unmeasured.
   - Those are the first [M] class counts for this doc. They are unmeasured today.
   - `crates/holtburger-dat/tests/neg_face_census.rs` (dat-parser-2's own census) sizes the same populations by polygon.
5. Release wasm, needed before any browser check: `cd apps/holtburger-web && $P capped-build wasm-pack build --target web --out-dir pkg --release`
   - Then `ls -la pkg/*.wasm`: about 4.5 MB means a release build; about 18 MB means a dev build.
6. Bake binary: `$P capped-build cargo build --release -p holtburger-tools --bin dat-shard`
   - Today's `target/release/dat-shard` dates from 2026-08-10 and writes v1.
7. Node (light): `node tests/geom_bundles_negface.test.mjs`, then `node harness/test_geom_bundles.mjs`.

## 5. Rebake runbook (do not start without the owner's go; laptop, alone)

### 5.1 Which tool, and can it be GEOM-only?

**The tool:** `dat-shard --emit-packs` (`apps/holtburger-tools/src/bin/dat-shard.rs` → `pack_bake::emit_packs`).
`GeomBaker::sections_for` writes GEOM (0x09) and GEOMR (0x0C) into every pack that carries a model-class record. This
is the co-location rule, D-04.2. [D]

**GEOM-only is not possible with today's tooling.**
- Packs are content-addressed: the file name is the sha256. Nearly every tile, meta, interior and core pack carries 0x01
  GEOM rows, so changing them renames almost every pack and rewrites the HBSI1 pack table and the manifest's
  `world_index`. [D]
- A "re-section" tool is feasible. It would read the v4 packs, re-encode only the 0x09/0x0C sections, re-hash, and
  rewrite the index. REFS address packs by ordinal, not by hash. But this tool is **not built**.
- The proven path is the existing full verified run. It is the recommendation.

**The full run cost:**

| Run | Wall time | Source |
|---|---|---|
| 2026-08-10, verified (closure + determinism + page dims + relief) | **189 min** | [M] `/mnt/wbterminal2/reeng/orch-bake/driver4.log` |
| 2026-08-09, unverified | **84 min** | [M] `driver.log` |

v2 adds one Surface read per distinct Surface DID (memoized) and one parse per 0x01 payload for the census. Against
189 minutes that is [A] negligible.

### 5.2 Inputs

The inputs are exactly those of `run-world-bake-4.sh` (the bake behind today's served dist). The served
`pack-report.json` matches `world-packs-v4` [M]: 17,682 packs, 301,641,513 B, `geom_rows` 16,107, `geom_relief_rows`
2,179.
- DATs: only `~/ac_base_dats/client_portal.dat` and `client_cell_1.dat` (the bake-base-dats-only rule).
- Every input path was checked present on 2026-10-22, and none has changed since the v4 bake: `find -newermt` over
  scenery, spawns, events, xu7-ingest-pages, tex-bc7-pre, pvw-extra and blocks-mip returned 0 files. [M]
- Caveat: `crates/holtburger-dat` and `apps/holtburger-tools` have **many commits since 08-10**, and none of them
  touches `pack_bake.rs`, `pack_format.rs` or `hbg1.rs`. Some parser change could still move a non-GEOM section. The
  `--diff` check in §5.4 is there to catch it.

### 5.3 Driver

Copy `run-world-bake-4.sh` and change only OUT and the log. Run it as
`setsid nohup bash run-world-bake-5.sh > driver5.log 2>&1 &`, after closing Chrome and checking `free -m`.

```bash
#!/bin/bash
# /mnt/wbterminal2/reeng/orch-bake/run-world-bake-5.sh — HBG1 v2 (?negFace face marker) full-world rebake.
# Same inputs and flags as run-world-bake-4.sh; only the binary (v2 GEOM emitter) and OUT differ.
set -e
export RAYON_NUM_THREADS=4
B=/mnt/wbterminal2/reeng/orch-bake
( while :; do echo "$(date -Is) cgB=$(cat /sys/fs/cgroup/dev/builds/memory.current 2>/dev/null) $(free -m | sed -n '2p' | tr -s ' ')"; sleep 30; done ) >> "$B/mem.log" 2>&1 &
MONPID=$!
trap 'rc=$?; kill $MONPID 2>/dev/null; echo "=== EXIT rc=$rc $(date -Is)"' EXIT
H=/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger
BIN=$H/target/release/dat-shard
OUT=$B/world-packs-v5
DIST=/mnt/wbterminal2/holtburger-dist-hires-bc7m-xu7t2
EXTRA=$B/pvw-extra
mkdir -p "$OUT"
cp "$DIST/manifest.json" "$OUT/manifest.json"
ARGS=(--emit-packs
  --eor-portal /home/wbterminal/ac_base_dats/client_portal.dat
  --eor-cell /home/wbterminal/ac_base_dats/client_cell_1.dat
  --scenery-dir "$DIST/scenery" --spawns-dir "$DIST/spawns" --events-dir "$DIST/events"
  --tex-bc7 /mnt/wbterminal2/pbr-terrain/bc7/blocks-mip
  --tex-bc7-pre /mnt/wbterminal2/tex-bc7-pre/pre
  --tex-xu7 /mnt/wbterminal2/xu7-ingest-pages
  --tex-pvw-extra "$EXTRA"
  --terrain-bc7-dir "$H/apps/holtburger-web/scene3d/assets/terrain_bc7/t1024"
  --output "$OUT")
echo "=== RUN5-HBG1V2 (verified) $(date -Is) bin=$(sha256sum "$BIN" | cut -c1-16)"
time capped-build "$BIN" "${ARGS[@]}" --verify-closure --verify-deterministic --require-page-dims --geom-relief 1.0 2>&1 | tail -60
echo "=== DONE $(date -Is)"
du -sh "$OUT" "$OUT"/packs 2>/dev/null
python3 - <<'EOF'
import json
r = json.load(open('/mnt/wbterminal2/reeng/orch-bake/world-packs-v5/pack-report.json'))
keys = ['tiles','interiors','packs_emitted','pack_bytes_total','geom_rows','geom_relief_rows',
        'geom_face_marked_parts','geom_face_backface_parts','geom_face_nopos_parts',
        'geom_face_front_copy_parts','closure_verified','determinism_verified']
print({k: r.get(k) for k in keys})
EOF
```

**Peak RAM [M]:** this is the risk to watch. On the v4 run the `builds` cgroup sat **at the 3.5 GiB cap**: p50 0.80,
p90 3.35, p99 and max 3.50 GiB, over 379 samples in `mem.log`. It finished without an OOM kill. `memory.current`
counts page cache, which the cap reclaims; the PAGE-RESAMPLE report calls this bake "R-MEM1-bound (~3.44 G cgroup)".
v2 adds a Surface-type `HashMap`, [A] a few thousand entries and well under 1 MB. **Run it alone.** If the cap
OOM-kills it, the fallback is `RAYON_NUM_THREADS=2`. That is [A]: the v4 run used 4 threads and was never tried with
fewer.

**Disk [M]:**
- `world-packs-v4` is 333 MB on `/mnt/wbterminal2`, which has 6.3 TB free.
- The deploy is additive (rsync with no delete), so it adds the renamed packs, [A] at most about 300 MB, to the archive
  dist.
- After staging, it adds about the same to the SSD copy. `/` has 7.2 GB free (94% used), and `dist_ssd.py` refuses to
  go below 6 GB free. **This is tight:** if `stage` refuses, prune the previous staged copy (`dist_ssd.py prune --keep
  1`) before anything else.

### 5.4 Validate, deploy, stage, check

0. **Wasm first.** Do §4 step 5, the release wasm, before activating the dist (§2.1).
1. `driver5.log` must show `=== DONE` and `=== EXIT rc=0`. The dat-shard summary must report the v4 counts: 17,682
   packs / 16,384 tiles / 1,153 interiors / 65,025 LBs, `missingPvw=0`.
2. Check `world-packs-v5/pack-report.json`:
   - `closure_verified` and `determinism_verified` are true. Closure now includes leg (f), "every 0x01 GEOM row is v2".
   - `geom_rows == 16107` and `geom_relief_rows == 2179`. v2 changes no row membership. Relief rails never attach to
     NoPos or SidesType-2 polygons (`ModelTopology` excludes them), so the set of changed models is the same. [D]
   - `geom_face_marked_parts > 0`, plus the three class counts. Record them here.
3. Run `python3 apps/holtburger-web/scripts/hbg1_face_census.py /mnt/wbterminal2/reeng/orch-bake/world-packs-v5 --require-v2 --diff /mnt/wbterminal2/reeng/orch-bake/world-packs-v4`
   - Expect exit 0, `verdict: v2 (face-marked)…`, and `diff.only_geom: True`. GEOM differs only in packs that carry a
     0x01 row; GEOMR differs where variants live.
   - If any other section kind differs, HEAD's non-GEOM bake output has drifted since 08-10. Name the kinds and stop
     before deploying. That drift is not this change.
   - The script was smoke-checked on 2026-10-22 [M]:
     - The served dist against v4, first 40 packs: 40 identical.
     - Against v3: only 0x0C differs (v3 had no GEOMR).
     - The served dist with `--require-v2`: exits 1 (`gfx_by_version {'v1': 3106}` in the first 40 packs). The gate
       works.
4. Copy `deploy-packs-v4.sh` to `deploy-packs-v5.sh`, changing `OUT=$B/world-packs-v5` and `driver5.log`. Run it with
   `--dry-run` first, then for real.
   - Its manifest check allows only `world_index` to change. It CAS-verifies every pack and runs `serve.py --check` at
     the end.
5. From `external/holtburger`: `scripts/dist_ssd.py stage --activate`, then `scripts/dist_ssd.py check` (exit 0).
6. Run `python3 apps/holtburger-web/scripts/hbg1_face_census.py dist --require-v2` (the served copy). Expect exit 0.
7. **Browser (orchestrator):** one tab, release wasm, `?nosw=1`, wireframe is fine on the laptop.
   - URL: `?nosw=1&packSource=on&geomBundles=on&autoLogin=1&account=…&password=…&autoSpawn=first&agent=1` with **no**
     `negFace=off`.
   - After `__bootState === 'ready'`, `__diag.geometry.faceMarker` should read `negFaceRetail: true` and
     `unmarkedModels: 0`.
   - `__diag.geometry.bundles.assembled > 0`, and `geomFallback.modelsServedByRuntimeDecode` falls against the same
     URL on the old dist. Before the rebake, every static model is counted there.
   - The console must show no `rebake GEOM` warning and 0 new errors.
   - Repeat with `&negFace=off`: `negFaceRetail: false`, `assembled > 0`.
   - The pass criteria for the pixel identity of the two arms are in §7.
8. Update the P0 arm 3 URL in the handoff: drop `&negFace=off` (§8).

## 6. Tests run here (node only)

| command | before | after |
|---|---|---|
| `node harness/test_geom_bundles.mjs` | 98 passed / 0 failed | 98 / 0 |
| `node tests/geom_bundles_negface.test.mjs` (new) | n/a | 17 / 0 |
| `node harness/test_diag_schema.mjs` | n/a | 69 / 0. One pre-existing evidence-drift note for `__diag.geometry` (HEAD already read `:174` against the registered `:69`; it now reads `:198`). |
| `node tests/pool_runs.test.mjs` | n/a | 109 / 0 |

None of the Rust tests in §4 has run. The 2026-10-23 review additions (the setup early-out, the two setup fixture
tests and the real-DAT setup leg) were also written without `cargo`.

Writing the setup differs turned up one gap in the older fixture: `hbg1_fixture_setup` sets `default_scale` but `flags: 0`, and
`SetupModel::pack` writes the scales only under flag 0x02. So `differ_setup_matches_runtime_walk` never exercised a
non-unit scale. The new `nf_setup` fixture sets 0x02 and asserts that the scales survive the pack.

## 7. Risks: what is not proven pixel-identical

- **Triangle order inside one surface group.** Bundles concatenate a surface's subsets, while the runtime interleaves
  by polygon. v2 can add a subset per surface: textured NoPos tris now sit beside the ordinary fronts, and back tris
  sit apart from fronts with equal flags. That changes the in-draw triangle order for those surfaces.
  - The multiset is identical, and group (surface) order is exact by construction. [D]
  - It matters only for coplanar overlap inside one draw, or for blending inside one draw (translucent surfaces).
  - The same class of deviation already exists in v1, where stipple-flag splits do the same thing.
  - Pass criterion for the browser or 1070 arm: same view, `&geomBundles=on` against `=off`, no visible difference.
- **NoPos "textured" is decided at bake.** The runtime skips a NoPos polygon while its Surface record is not resident
  (unknown type). `MissCountingSource` stops that partial decode from being memoized, so the runtime converges later.
  The bundle draws the polygon at once. The converged pixels are equal. [D]
- **The `?perPolyCull=on` arm is coarser.** `NEG_FRONT_COPY` is a superset (opacity ignored), so on that non-default
  arm more models fall back than strictly needed. The fallback is pixel-correct. [D]
- **Old wasm on a v2 dist with `?negFace=off`** throws per batch and falls back (§2.1). Avoid it by doing step 0
  first.
- **Kind-1 SETUP fused bbox.** It still comes from the v1 part encode. It is informational, and the assembly never
  reads it. [D]
- **Uncompiled.** All the Rust was written without `cargo` (laptop rule), so expect possible compile nits. The places
  most likely to need a touch:
  - the `faces?` early return inside the resolver closure in `encode_gfx_part_variant`;
  - the `&|did: u32| …` coercions to `&dyn Fn`;
  - the `Ok(Err(miss))` nesting in `assemble_one_model`.

## 8. Shared files the orchestrator should update (not edited here)

1. `docs/url-flags.md`, the **`negFace` row**. In "`?geomBundles=on` (dev opt-in) measurements should add `&negFace=off`:
   model payloads carry no back-face marker, so every model takes the runtime decode while this is on.", replace it with:
   "Model bundles are decided per payload (2026-10-22, HBG1 v2): a dist baked with the face marker assembles on both
   arms; an older dist sends every model to the runtime decode while this is on, counted in
   `__diag.geometry.faceMarker.unmarkedModels` (docs/HBG1-negface-marker-2026-10-22.md)."
   In its Code column, add `hbg1.rs encode_gfx_part_faces; geom_bundles.rs FaceArm`.
2. `docs/url-flags.md`, the **`geomBundles` row**:
   - In the Diag clause, add `faceMarker` (`negFaceRetail`, `unmarkedModels`, `frontCopyModels`).
   - In "Pinned by", add `tests/geom_bundles_negface.test.mjs`.
3. `harness/run-js-headless.mjs`. Register the new test next to `harness_geom_bundles`:
   `{ tier: 5, flag: "geomBundlesNegFace", file: "tests/geom_bundles_negface.test.mjs" },`
4. `harness/lib/diag_schema.mjs`, the `__diag.geometry` entry. This is not on the never-edit list, but it is not my
   file either.
   - Set `evidence: "scene3d/geom_bundles.js:198"`.
   - Add these fields:
     - `"faceMarker.negFaceRetail": L("bool", null, { note: "?negFace arm of the last model batch (null before one / old wasm)" })`
     - `"faceMarker.unmarkedModels": C("count")`
     - `"faceMarker.frontCopyModels": C("count")`
5. `docs/HANDOFF-gpu-resident-statics-2026-10-22.md`:
   - §5 F7(a): "codec + reader landed (HBG1 v2, docs/HBG1-negface-marker-2026-10-22.md); GEOM rebake outstanding".
   - §7 P0 arm 3: drop `&negFace=off` once §5.4 passes.

## 9. Orchestrator results (2026-10-23)

- §4 steps 1-4 and 6 ran on the laptop, one at a time, inside `capped-build` [M]:
  - `cargo test -p holtburger-dat --lib hbg1`: 14 passed (compiled first time).
  - `cargo test -p holtburger-web --lib geom_bundles`: 10 passed (8 + the review's two setup differs).
  - `cargo test -p holtburger-tools --no-run` compiles; `--test bake_ci` 1 passed; `--lib pack_bake` 9 passed; the
    ignored `bake_ci_bounded_region` and `bake_ci_relief_variants` legs both PASS (234 s).
  - Real-DAT differ: `15318 GfxObjs encoded | MODEL_BACKFACE 2 | NOPOS_SLOT0 30 | NEG_FRONT_COPY 1 | exact on both
    arms: 32 marked + 100 plain`; setups: `30 using a marked GfxObj + 150 plain (0 scaled)`. The original
    `marked >= 50` guard was a guess the corpus disproved (only 32 GfxObjs need a mark); it now pins "every marked
    GfxObj (up to 400) was checked".
  - `cargo build --release -p holtburger-tools --bin dat-shard` (1 min, incremental).
- §5 rebake: `run-world-bake-5.sh` → `world-packs-v5`, 160 min, rc=0, closure + determinism verified, counts equal to
  v4. `geom_face_marked_parts` 7,498 = every 0x01 GEOM row is v2 (backface 1, NoPos 24, front-copy 0).
- §5.4 step 3: the census `--diff` first read `only_geom: False` (REFS 0x08 differed in 17,029 packs). That is the
  content-hash cascade (a REFS table names its target packs by hash, and every pack whose GEOM changed is renamed),
  not drift: a full pass found the REFS records identical and every renamed entry pointing at the same index ordinal
  (0 violations). The script now classifies that case (`refs_cascade` / `refs_drift`) and reads `only_geom: True`.
- §5.4 steps 4-8 (deploy, stage/activate, served-copy census, browser check) were NOT run: they change what the owner is
  served, and `/` has only ~80 MB above the `dist_ssd` floor. Owner's call.
- Browser A/B (laptop SwiftShader, one tab, `capped-build`), done WITHOUT touching the served dist: a read-only overlay
  (`/mnt/wbterminal2/reeng/orch-bake/dist-v5-overlay`: today's layers + the v5 packs/index/manifest) served from a
  copy of the working tree (`serve.py` repoints its OWN tree's `dist` symlink, so it must never be pointed at an
  overlay from the live tree), new release wasm (`wasmrev-20261023a`), Holtburg, `quality=low&pvsRingRadius=1`,
  `packSource=on&geomBundles=on`, default `?negFace` [M]:

  | Dist | `faceMarker.unmarkedModels` | `bundles.assembled` | `geomFallback.modelsServedByRuntimeDecode` |
  |---|---|---|---|
  | today's served (v1 GEOM) | 124 | 88 | 229 |
  | v5 overlay (v2 GEOM) | **0** | **212** | **105** |

  `&negFace=off` on v5: `negFaceRetail: false`, 0 unmarked, 212 assembled. 0 console errors and 0 page errors in all
  three runs. Pixel identity of `geomBundles` on vs off was not judged (laptop wireframe-class check only); that
  stays with the owner's eye check after a deploy.
- **Deployed 2026-10-23** (owner instruction; `HANDOFF-gpu-resident-statics-2026-10-22.md` §0.1). §5.4 ran in order:
  - steps 1-3: driver5 rc=0, the pack report as above, and the census against v4 exit 0 (`only_geom: True`);
  - step 4: `deploy-packs-v5.sh`, made from v4 (dry run, then real);
  - step 5: `dist_ssd.py stage --activate`, then `check` exit 0;
  - step 6: the census on the served copy, exit 0;
  - step 7: headless boots on the served v2 dist (live tree, `quality` mid, spawn point not Holtburg): default `?negFace`
    gave `negFaceRetail: true`, `unmarkedModels: 0`, bundles assembled and 0 errors; `&negFace=off` gave
    `negFaceRetail: false` and 0 errors;
  - step 8: `&negFace=off` dropped from the queue arms.
  - The owner's eye check of the v2 look is still owed.
