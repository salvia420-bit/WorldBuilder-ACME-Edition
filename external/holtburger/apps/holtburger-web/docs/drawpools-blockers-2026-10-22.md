# drawPools blockers ledger: F7(b) page-dim corpus, F7(c) the E2–E6 batches, and every other flip prerequisite (2026-10-22)

**This is research plus a runbook. Nothing was built, encoded, baked, published or browsed.** It covers handoff
`HANDOFF-gpu-resident-statics-2026-10-22.md` §5 F7(b) and F7(c), and it gathers every other prerequisite of flipping
`?drawPools` that SPEC.md §0/§3 names, so that this file is the one blockers ledger.

- HEAD `87fabdb4`, plus a dirty tree: other agents were editing `pool_*.js`, `batched_runs.js`, `static_atlas.js`,
  `geom_bundles.rs`/`hbg1.rs`/`pack_bake.rs` (HBG1 v2 `?negFace`), SPEC.md and url-flags.md while this ran. Rows that
  depend on their work say "in the working tree", meaning uncommitted at the time of writing.
- What ran: read-only Python over the served packs, the served `holtburger/tex-xu7` catalog, the shard store and the
  ingest farms (the scripts are inlined in §2.5 R4 or described in §6), plus two targeted node tests:
  `node harness/test_page_resample_texref.mjs` **26 passed / 0 failed** and `node harness/test_draw_pools.mjs`
  **448 / 0**.
- No fps predictions (charter D-01.5). Evidence tags: **[M]** measured (source named), **[D]** derived, **[A]** assumed.

## 1. Verdict

1. **F7(b) as written is stale. The corpus-wide encode it waits for already ran,** on the buildbox on 2026-08-10
   (1,309 members, basisu v2.50.0, sha-verified on arrival). Its farm `/mnt/wbterminal2/xu7-ingest-pages` fed BAKE-4,
   which ran with `--require-page-dims`, was deployed the same evening, and is the pack layer served today. In the served
   `pack-report.json`, `texref_off_page_full_tier` is **0** [M].
2. **No encode can move the 409 off-page rows.** All 409 are legacy-lane rsIds with no XUBC7 full tier at all: 244
   paletted tranche-2 textures, 116 tiny ones (≤ 32 px), 19 suspect-tiled exclusions and 30 others [M, §2.2]. They are
   PAGE-RESAMPLE's recorded D3 residue. They cap pool coverage and block T40 retirement, but no GATE-POOLS criterion
   names them.
3. **The real F7(b) blocker is a publication gap, and it is new.** The page-dim payloads were baked into the packs'
   TEXREF dims but **never published into the served `holtburger/tex-xu7` shard namespace.** The served catalog is the
   2026-08-05 snapshot. **985 of the 3,051 TEXREF'd full-tier rsIds** declare a page (bit `FULL_PAGE_DIMS` set) while
   lane T serves them at their old, smaller dims [M, §2.3].
   - The pools' strict arm refuses such members `offPage` and retires them after their settle, so they stay on the
     legacy producer for the session.
   - The likely cause of E6's one NOT-DEMONSTRATED assertion ("offPage climbs, then reOfferAdmitted follows") on the T4
     [D].
   - The same gap also left texfix debt #2 unpaid: 593 green-fringe repairs (2026-08-09) never reached the served full
     tier [M].
4. **Fixing it is a light laptop job plus an owner decision.**
   - The job: a side-car `dat-shard --tex-xu7` ingest, a merge into the archive dist, and a re-stage. It is I/O plus
     sha256 work, takes minutes, and needs well under 0.1 GB of RSS [D] (§2.5 R1).
   - The decision: it changes the default arm's full-tier textures for **1,730** rsIds (1,309 resampled by texel
     replication, 11 of them downscaled, plus 421 texfix repairs).
   - Cost: +1,113 MB of shard payloads, and the world full-tier corpus grows from 2,342.8 to 2,615.5 MB (+11.6 %) [M].
   - None of this is pixel-identical, so it is an owner call (§2.5 R5).
5. **The laptop can re-encode if that is ever needed.** The whole 3,985-member lossless corpus was encoded on this
   laptop on 2026-08-04 in 44 min at `-P 3` [M]. Re-encoding the 1,309 page members is about 20–30 min lossless and
   30–55 min at q75 [D]. The one piece that is infeasible here is a new Remacri **upscale** (CUDA). That would be the only
   way to give the 409 a real full tier, and owner policy excludes them anyway.
6. **F7(c): five eye items (E2–E6) across two batch files, plus their riders.**
   - E6 ran once, on a GCE T4 (not the 1070), and came back INCONCLUSIVE.
   - E2, E3, E4 and E5 have never run anywhere.
   - Each one's counter half can run as a laptop SwiftShader structural check (§3). Every eye half needs a real GPU, and
     E4's sheet review needs only the owner's phone.

## 2. F7(b): the page-dim texture corpus

### 2.1 The claim versus the record

| Claim (handoff F7b / IMPLEMENTATION.md PAGE-RESAMPLE row) | What is true | Evidence |
|---|---|---|
| "corpus-wide encode = buildbox job", and the buildbox is gone | Done 2026-08-10 on the buildbox: 1,309 encoded (the first attempt failed 1,309/1,309 on a GLIBC 2.38 mismatch; a box-built binary was used), sha-verified on arrival. Farm = 1,309 files + 2,676 identity symlinks + `encoded-members.sha256` + `PROVENANCE.md` | [M] `/mnt/wbterminal2/xu7-ingest-pages/` (1,309 regular `.ktx2`, 2,676 symlinks); archived ORCHESTRATOR-HANDOFF §-7 "ENCODE DONE" |
| The served dist is pre-page-dim | Served packs = BAKE-4: `--tex-xu7 /mnt/wbterminal2/xu7-ingest-pages --require-page-dims --geom-relief 1.0` + both verify flags, rc=0, 189 min | [M] `run-world-bake-4.sh`, `driver4.log`, served `bake-source-packs.sha256` line `tex-xu7 /mnt/wbterminal2/xu7-ingest-pages` |
| `texref_off_page` 409 of 3,471 → "those members stay on the legacy producer" | True, but all 409 are `texref_off_page_legacy_only`; `texref_off_page_full_tier = 0` | [M] served `pack-report.json`; re-derived from the 17,682 BAKE-4 packs' TEXREF sections: 3,471 unique rsIds, 0 conflicts, on-page 3,062 (= 3,051 with a full tier + 11 legacy rows already 256² at DAT dims), off-page 409, of which with a full tier **0**, with a preview 36 |

### 2.2 The 409 off-page rows: what they are, and what would move them

Classified this session [M]. Lists used: tranche-2 `records-4x/` (shipped) and `work/batch_ids.txt`,
`upscale-corpus/quarantine-suspect-tiled/EXCLUDED-rsids.txt`, and DAT dims from the pristine PNG export
`/mnt/wbterminal2/tex-reexport-2026-07-30/`. The per-rsId table was written to a session scratchpad and is not kept;
§6 has the recipe.

| Class | Rows | Has a PVW preview | Why there is no full tier | What could move it |
|---|---|---|---|---|
| Paletted (INDEX16) tranche 2, shipped as 4× DAT records | 244 | 8 | One source renders in N dye palettes, so a pre-baked BC7 is "structurally impossible" (tranche-2 doc). The 4× records live in the served `eor/portal` shards (`portal-t2.dat`, dist `bake-source.sha256` amended 2026-08-05); the pack bake reads the pristine `~/ac_base_dats`, so TEXREF declares base-DAT dims | Nothing bake-side. Bit CLEAR means the producer keys on LIVE dims (`pool_producer.js _axisRecordFor`, `texRefBitClear`), and live dims are the 4× record's, so the square ≥256² ones may already pool [D, unmeasured] |
| Tiny (max edge ≤ 32 px) | 116 | 5 | Retail-res by policy (562 tiny never upscaled) | A page-dim tier by replication (below) |
| Suspect-tiled exclusions | 19 | 19 | Owner verdict 2026-08-04: "EXCLUDE ALL 32", ship at retail res | Same |
| Other (thin aspect: 32×64, 16×64, 64×16, 128×32 …) | 30 | 4 | Not in any upscale list. Carve-out reason not found [A] | Same |

DAT dims: 32×32 119, 128×128 94, 64×64 77, 64×128 49, 32×64 20, 128×64 15, and a tail.

**The replication option is a look change, not a free move.** One could decode the DAT record, run `page-resample` (its
integer kernel is texel replication) up to the 256² floor, encode with `basisu -xubc7 -mipmap` and add the result to the
farm. For 165 non-paletted members at 256² that is about 87 KB each, roughly 14 MB [D], and a few minutes of encode. But
bilinear magnification of an 8× replicated page gives flat 8×8 blocks with one-texel ramps, where the native 32² texture
gives a smooth ramp, so close-range magnification turns blockier [D]. BC7 also replaces RGBA8. This needs an owner eye; it
is not a mechanical job.

**Is it a drawPools-flip blocker?** Not under SPEC §3 T22's GATE-POOLS text. These members render through the legacy
producer as passthrough, which `test_draw_pools` covers. They matter to pool coverage and to T40/ST10, which needs
legacy-lane world load = 0.

### 2.3 NEW: the page-dim full tier never reached the served `holtburger/tex-xu7` namespace

How the client gets a full tier: `xu7_cas_info` → `shard_cas_info("holtburger/tex-xu7", rsId)`
(`src/lib.rs` ~12760) → the HBNS catalog `manifest/holtburger-tex-xu7.bin` → `shards/<p2>/<sha16>.bin`.
`dat-shard --emit-packs` **without** `--legacy-layers` skips the legacy shard/catalog emission
(`src/bin/dat-shard.rs` `main`, `run_legacy = !emit_packs || legacy_layers`). BAKE-4's `--tex-xu7` therefore only set
TEXREF dims, and `deploy-packs-v4.sh` copied only `packs/` and `index/`. Nobody republished the namespace. Measured this
session:

| Read | Result |
|---|---|
| Served catalog + `shards/` mtime | 2026-08-05 07:58, in the archive and the SSD copy alike; dist `bake-source.sha256` says `tex-xu7: /mnt/wbterminal2/xu7-ingest` (pre-resample) |
| The 1,309 page-farm encodes vs the served catalog/shards | **0 of 1,309** in either. 1,137 of their OLD payloads are served |
| Served KTX2 dims vs the plan's page dims, all 3,985 | resampled: 0 equal / **1,309 differ**; identity: 2,676 equal |
| Served catalog vs the CURRENT `xu7-ingest` | 593 differ, exactly the texfix re-encodes (`xu7-ingest` targets dated 2026-08-09 18:23–18:28) |
| TEXREF rows with `FULL_PAGE_DIMS` + `FULL_XU7_PRESENT` vs served dims (validator, §2.5 R4) | consistent **2,066**, **MISMATCH 985**, not served 0 (exit 1) |
| Payloads the farm would add to the shard store | **1,730** (1,309 resampled + 421 texfix identity), **1,113.1 MB** |

What it does today [D, from `pool_producer.js _axisRecordFor`/`_holdOut`]:
1. A pooled member with the bit SET keys on its declared page.
2. Preview-born, it is refused `offPage` and held out.
3. When its full tier settles at the OLD dims, DECLARED ≠ RESIDENT still holds, so it is RETIRED (`heldOutRetired`)
   and renders on the legacy producer for the rest of the session.

For the 985 TEXREF'd resampled rsIds, the resample therefore buys the pools nothing on the served dist. That matches the
T4 E6 reading: `classPages.refused.offPage 249`, `heldOutByReason.offPage` 203 → 205 while `reOfferAdmitted` stayed
flat at 32 (batch-D `E6.verdict`). The T4 box served its own copy (`~/holtburger-dist-v4`) whose catalog provenance is
not recorded [A].

### 2.4 The tool chain (what "the encoder" is)

| Stage | Tool | Input → output | Where it ran |
|---|---|---|---|
| Upscale | Remacri ×4 (PyTorch, CUDA) | DAT export PNG → `upscale-corpus/out/{statics,tranche1}-remacri/` (2,931 + 1,054; texfix-repaired 593 in place 2026-08-09) | GCE L4 spot, ~0.57 s/img [M, texture-pipeline handoff §6] |
| Page resample | `target/release/page-resample` (`apps/holtburger-tools/src/bin/page-resample.rs`, exact-rational integer area kernel) | `reeng/page-resample/src-all` (symlinks to `upscale-corpus/out`) → `src-corpus-pages/` + plan/sha/provenance | Laptop, single-threaded by design, ~1 h [M, PAGE-RESAMPLE report] |
| Encode | `basisu` v2.50.0 (upstream `9bebe167`), `-xubc7 -mipmap` (lossless; `-quality 75` is the owner-gated q75 arm) | `src-corpus-pages/<rsId>.png` → `<rsId>.ktx2` | Lossless corpus: laptop 2026-08-04. q75 corpus (T16) and page farm: buildbox. Box/laptop parity byte-proven (T16) |
| Farm | `ln -s` identity members from `xu7-ingest` | `/mnt/wbterminal2/xu7-ingest-pages/` | Laptop |
| Pack bake | `dat-shard --emit-packs --tex-xu7 <farm> --require-page-dims` | farm KTX2 headers → TEXREF dims + bit 5 | Laptop, `capped-build` (BAKE-4) |
| **Namespace publish (never run for the page farm)** | `dat-shard --tex-xu7 <farm> --output <sidecar>` (side-car branch `dat_shard.rs` ~273) | farm → `shards/` + `manifest/holtburger-tex-xu7.bin` + `shards/holtburger-tex-xu7/0x….bin` aliases | — |

How the buildbox was used: `reeng/T16/q75-driver.sh` rsync'd 400-PNG chunks to the box, ran an encode at `-P 16`
(18 vCPU), deleted the staged inputs and aborted below 3 GB free. That came to ~16.5 min for 3,985 at q75 [M, T16
report]. The page farm run (08-10) used the same per-member line.

### 2.5 Laptop runbook

Every heavy step is one job, alone, inside `capped-build` (cgroup `builds`, `memory.max` 3,758,096,384 B,
`memory.swap.max` 2 GiB). Check `free -m` ≥ 2.5 GB available first. Scratch goes on `/mnt/wbterminal2/reeng/…`, never
`/`, which is 94 % full with 7.2 GB free.

**R0 — preconditions (every step).**
```bash
free -m | sed -n 2p                         # "available" >= 2500
df -h / /mnt/wbterminal2                     # / keeps >= 6 GB after staging (dist_ssd floor)
pgrep -af 'cargo|rustc|wasm-pack|chrom|run-js-headless|basisu|dat-shard' || echo idle
```

**R1 — PUBLISH the page farm into the served namespace. This is the step that unblocks F7(b), and it needs the owner's
go (R5).** No Rust build and no encode.
```bash
W=/mnt/wbterminal2/reeng/xu7-pages-publish-2026-10-22
DIST=/mnt/wbterminal2/holtburger-dist-hires-bc7m-xu7t2          # the ARCHIVE; never edit ~/hb-serve directly
FARM=/mnt/wbterminal2/xu7-ingest-pages
BIN=/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/target/release/dat-shard
mkdir -p "$W/backup"
# 1. farm integrity (the 1,309 encodes; identity members are symlinks into xu7-ingest)
( cd "$FARM" && sed 's#  out/#  #' encoded-members.sha256 | sha256sum -c --quiet ) && echo FARM-OK
# 2. side-car ingest of ONLY holtburger/tex-xu7 (manifest v2 is the default)
capped-build "$BIN" --tex-xu7 "$FARM" --output "$W/sidecar" 2>&1 | tee "$W/sidecar.log"
#    expect "dat-shard: tex-xu7 — 3985 records, … 0 skipped". The side-car's manifest.json / boot.hba are NOT deployed.
#    (side-car branch read-verified in dat_shard.rs; never run for tex-xu7 alone, so read the log before step 3)
# 3. backups of everything the merge replaces (CAS shards are additive, so they need none)
cp -a "$DIST/manifest/holtburger-tex-xu7.bin" "$DIST/manifest.json" "$W/backup/"
cp -a "$DIST/shards/holtburger-tex-xu7" "$W/backup/alias-holtburger-tex-xu7"
# 4. merge: buckets additive (a CAS name IS its bytes), aliases overwritten, catalog replaced atomically
rsync -a --ignore-existing "$W"/sidecar/shards/[0-9a-f][0-9a-f] "$DIST/shards/"
rsync -a "$W/sidecar/shards/holtburger-tex-xu7/" "$DIST/shards/holtburger-tex-xu7/"
cp "$W/sidecar/manifest/holtburger-tex-xu7.bin" "$DIST/manifest/.xu7.tmp" \
  && mv "$DIST/manifest/.xu7.tmp" "$DIST/manifest/holtburger-tex-xu7.bin"
# 5. bump ONLY manifest.json generated_at. The SW v2 bake-identity gate keys on boot_pack.sha256:catalog_version:
#    generated_at (service-worker.js currentBakeId). Without the bump, returning SW clients keep the cached OLD catalog.
python3 -I - "$DIST/manifest.json" <<'EOF'
import json, os, sys, datetime
p = sys.argv[1]; m = json.load(open(p))
m["generated_at"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
json.dump(m, open(p + ".tmp", "w"), indent=2); os.replace(p + ".tmp", p)
EOF
# 6. re-stage the SSD serving copy, then check
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger
python3 scripts/dist_ssd.py stage --activate && python3 scripts/dist_ssd.py check && python3 scripts/serve.py --check
```
- **Cost.**
  - Step 2 reads 2.6 GB and writes 2.6 GB on the same USB spinner: ~5–15 min [A].
  - Its RSS is one KTX2 at a time (`ingest_tex_xu7_dir` → `std::fs::read` per file) plus the catalog vectors, well under
    0.1 GB [D].
  - Step 6 copies about 1.11 GB to the SSD. The last re-stage, a 29 MB delta, took 160.9 s, mostly `cp -al` of the tree
    [M, `.dist-ssd.json`].
- **Space.** The stage guard needs free − (1.113 GB + 4 KiB × 1,730) ≥ 6.0 GB. 7.2 GB is free now, which leaves
  ~6.08 GB: it passes with about 80 MB to spare [D]. If `/` drifts lower the stage REFUSES (exit 3) without copying.
  Free space first; lowering `--min-free-gb` is an owner call. After the swap the superseded payloads drop out of the
  copy (unreferenced shards are not staged), so the net is smaller than 1.1 GB [D].
- **Resumable and idempotent.**
  - Step 2 can be rerun into an empty `$W/sidecar`.
  - Step 4: `--ignore-existing` makes a repeat a no-op.
  - Step 6: an interrupted stage keeps `.staging-<name>` and the next `stage` resumes it.
  - Never rsync with `--delete` into the archive.
- **Rollback.** Copy the three backups back (catalog, `manifest.json`, alias dir), then `dist_ssd.py stage --activate`.
  The new CAS shards can stay, since nothing references them.

**R2 — RE-ENCODE (only if the farm itself must change: lost, the q75 election, `PAGE_TIER_MAX`, or a new upscale
corpus).** Not needed for R1.
```bash
B=/mnt/wbterminal2/xubc7-proto/basis_universal/bin/basisu      # laptop-built; needs GLIBC 2.38 (fine here)
R=/mnt/wbterminal2/reeng/page-resample
OUT=/mnt/wbterminal2/xu7-ingest-pages-$(date +%F); mkdir -p "$OUT"   # a NEW farm; never overwrite the live one
# (a) PNG tier, only if src-corpus-pages is gone or the kernel/tier bounds change (~1 h, single-threaded by design).
#     If you regenerate it, point (b)/(c) at the new dir instead of $R/src-corpus-pages.
capped-build /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/target/release/page-resample \
  --src "$R/src-all" --out "$R/src-corpus-pages-$(date +%F)" --verify-deterministic
# (b) pilot: max RSS of ONE 2048² resampled member (0x0600387D, 1024x2048 -> 2048²) before choosing -P.
#     Output OUTSIDE $OUT: dat-shard ingests every *.ktx2 in the farm dir.
capped-build python3 -I -c 'import resource,subprocess,sys;rc=subprocess.run(sys.argv[1:]).returncode;print("rc",rc,"maxrss_MiB",resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss//1024)' \
  "$B" -xubc7 -mipmap -output_file "$R/pilot-0x0600387D.ktx2" "$R/src-corpus-pages/0x0600387D.png"
# (c) the encode: the UNCHANGED per-member line (encode-region-pages.sh pattern), resumable.
#     q75 arm (owner-gated): add -quality 75 here AND link identity members from the q75 corpus in (d).
cat > "$R/enc-one.sh" <<'EOF'
b="$1"; dst="$OUT/$b.ktx2"; [ -s "$dst" ] && { echo "skip $b"; exit 0; }
"$B" -xubc7 -mipmap -output_file "$dst.tmp.ktx2" "$R/src-corpus-pages/$b.png" >/dev/null 2>&1 \
  && mv "$dst.tmp.ktx2" "$dst" && echo "ok $b" || { rm -f "$dst.tmp.ktx2"; echo "FAIL $b"; }
EOF
export B R OUT
capped-build bash -c "xargs -P 2 -n 1 bash '$R/enc-one.sh' < '$R/encode-ids-full.txt' >> '$OUT.encode.log'"
grep -c '^ok' "$OUT.encode.log"; grep '^FAIL' "$OUT.encode.log"     # expect 1309 / none
# (d) identity members as symlinks (never re-encoded), then manifest + provenance
for f in /mnt/wbterminal2/xu7-ingest/*.ktx2; do [ -e "$OUT/$(basename "$f")" ] || ln -s "$f" "$OUT/"; done
( cd "$OUT" && find . -maxdepth 1 -type f -name '0x*.ktx2' | sort | xargs sha256sum ) > "$OUT/encoded-members.sha256"
ls "$OUT" | grep -c '\.ktx2$'                                       # expect 3985
```
- **CPU time [D from M].**
  - Calibration: the 2026-08-04 laptop lossless run encoded 3,985 members (2,964.8 Mpx of source) in 2,649 s wall at
    `-P 3`, about 1.12 Mpx/s (`xubc7-corpus/encode-lossless.log`, 0 FAIL).
  - The 1,309 resampled pages are 1,369.4 Mpx: ~20 min at `-P 3`, ~20–30 min at `-P 2`.
  - q75: the per-texture laptop matrix (`xubc7-proto/results/matrix.json`) puts q75 at 1.4–1.75× lossless at
    1024²–2048² (2048²: 10.97 → 19.16 s), so ~30–55 min.
  - A whole 3,985-member page-dim corpus (3,562.8 Mpx) is ~55–80 min lossless.
- **Peak RAM [A until the pilot runs].** basisu's RSS was never recorded.
  - Bound from below by the evidence: the 08-04 run at `-P 3` included 4096² sources (64 MiB RGBA each), finished
    3,985/3,985 uncapped on this 8 GB laptop, and `/var/log/earlyoom.log` has no basisu entry.
  - Page-resampled inputs stop at 2048² (16 MiB RGBA), so `-P 2` inside the 3.5 GiB cap has more margin [D].
  - Each basisu process also multithreads internally (`-version`: "Multithreading: 1"), so `-P` above 2 buys little on
    4 hardware threads.
- **Resumable.** Each member is skipped when it already exists non-empty, and written to `.tmp` then renamed, so the
  job is kill-safe: rerun the same line.

**R3 — RE-BAKE the packs (only with a changed farm, or as part of the F7(a) HBG1 v2 GEOM rebake already in the working
tree).**
- **Cost [M].** BAKE-4 took 189 min wall (62 min user, 90 min sys) and `memory.current` sat at the 3,584 MiB cap (page
  cache counts) and finished rc=0. BAKE-3 took 152 min. Run it alone, after
  `pgrep -x rust-analyzer | xargs -r kill` and the one-package build
  `env PATH="/home/wbterminal/.cargo/bin:/usr/local/bin:/usr/bin:/bin" capped-build cargo build -p holtburger-tools --release --bin dat-shard`.
- **Driver.** Copy `reeng/orch-bake/run-world-bake-4.sh` to `-5.sh` (OUT `world-packs-v5`, `driver5.log`) and **keep**
  `--tex-xu7 /mnt/wbterminal2/xu7-ingest-pages --require-page-dims --geom-relief 1.0 --verify-closure
  --verify-deterministic`. The previews are already derived from the page farm (the 1,309 re-derived 08-10), so the
  single verified pass is enough while `pvw_wanted_from_xu7` reads `[]`.
- **Deploy.** Copy `deploy-packs-v4.sh` to `v5` (gate on `driver5.log`; `world_index` must change), then
  `dist_ssd.py stage --activate`.
- **TEXREF and the served catalog must name the SAME farm.**
  - If the owner keeps the page farm (R1 published), bake with the page farm.
  - If the owner declines R1, bake with `--tex-xu7 /mnt/wbterminal2/xu7-ingest` and DROP `--require-page-dims`. The
    985 then read bit CLEAR, key on live dims, and the `needsResample` gate decides, so only identity members pool.
  - Decide this before the F7(a) rebake, so that one heavy bake covers both.

**R4 — VALIDATE.**
1. Offline consistency check, read-only, ~2 min over 17,682 packs on the spinner. Save the script below as
   `texref_catalog_check.py` (in a scratch directory, not the repo) and run
   `python3 -I texref_catalog_check.py <bake-out>/packs <dist-root>`. Point it at the bake OUTPUT's `packs/` dir: the
   archive `packs/` also holds every older CAS generation. Exit 0 = every bit-5 + xu7 TEXREF row is served
   at its page. Today, against `world-packs-v4/packs` and `~/hb-serve/dist/current`, it prints "consistent 2066,
   MISMATCH 985, not served 0", exit 1 [M]. The script:
   ```python
   import os, struct, sys
   packs, dist = sys.argv[1], sys.argv[2]; rows = {}
   for d in os.listdir(packs):
       for f in os.listdir(os.path.join(packs, d)):
           with open(os.path.join(packs, d, f), 'rb') as fh:
               h = fh.read(32); ns, nn = struct.unpack_from('<H', h, 12)[0], h[14]
               fh.seek(32 + 32 * nn); t = fh.read(16 * ns)
               for i in range(ns):
                   kind, cd = struct.unpack_from('<HB', t, 16 * i); off, st, _ = struct.unpack_from('<III', t, 16 * i + 4)
                   if kind != 0x0A or cd != 0: continue          # TEXREF, codec RAW
                   fh.seek(off); b = fh.read(st)
                   for k in range(struct.unpack_from('<I', b)[0]):
                       rs, bits, _, dims = struct.unpack_from('<IBHB', b, 4 + 8 * k); rows[rs] = (bits, dims)
   c = open(os.path.join(dist, 'manifest/holtburger-tex-xu7.bin'), 'rb').read()   # HBNS v1
   n, hl, p, fid, cat = struct.unpack_from('<I', c, 8)[0], (32 if c[5] & 1 else 16), 16, 0, {}
   def uleb(p):
       r = s = 0
       while True:
           x = c[p]; p += 1; r |= (x & 0x7f) << s; s += 7
           if not x & 0x80: return r, p
   for _ in range(n):
       d, p = uleb(p); fid += d; cat[fid] = c[p:p + hl].hex()[:32]; p += hl; _, p = uleb(p)
   ok = bad = miss = 0
   for rs, (bits, dims) in rows.items():
       if not (bits & 0x20 and bits & 0x02): continue      # FULL_PAGE_DIMS + FULL_XU7_PRESENT
       page = (1 << (dims >> 4), 1 << (dims & 15)); h = cat.get(rs)
       f = h and os.path.join(dist, 'shards', h[:2], h + '.bin')
       if not f or not os.path.exists(f): miss += 1; continue
       with open(f, 'rb') as fh: got = struct.unpack_from('<II', fh.read(28), 20)   # KTX2 pixelWidth/Height
       ok, bad = (ok + 1, bad) if got == page else (ok, bad + 1)
   print(f'consistent {ok}, MISMATCH {bad}, not served {miss}'); sys.exit(1 if bad or miss else 0)
   ```
2. After any rebake, `pack-report.json` must show:
   - `texref_off_page_full_tier == 0`;
   - `texref_off_page == texref_off_page_legacy_only` (409 today);
   - `closure_verified` and `determinism_verified` true;
   - on a v2 GEOM bake, `geom_face_marked_parts` equal to the distinct 0x01 GEOM model count (in the working tree).
3. `dist_ssd.py check` exits 0. `serve.py --check` is green with `--allow-missing` never passed.
4. Live, on the orchestrator's one tab under `capped-build` (the P0-LAPTOP-TWIN arm-3 recipe). Run it before AND after
   R1 and read `__diag.pools()` on the full chain + `&negFace=off`:
   - `producer.texRefDimsWillMove` and `classPages.refused.offPage` fall back to the preview-born transient;
   - `heldOutByReason.offPage` drains into `reOfferAdmitted`;
   - `heldOutRetired` stays small.

   `__texStats().coverage.texRefOnPage` / `texRefOffPage` should be unchanged by R1. Use a fresh profile or `?nosw=1`.
5. On the 1070: E6 (§3).

**R5 — feasibility on the 8 GB laptop, stated plainly.**
- **R1 is feasible and cheap.** The binding constraint is SSD headroom: about 80 MB above the 6 GB floor today.
- **R2 is feasible.** It was done for the full corpus on 08-04, in 44 min at `-P 3`.
- **R3 is feasible.** BAKE-3 and BAKE-4 both ran here at the cap.
- **Infeasible here:** a fresh Remacri **upscale**. It needs CUDA (the laptop has an HD520 iGPU), and it is the only
  path to a true full tier for the 409. Owner policy already excludes them (tiny / suspect-tiled / paletted), so the
  buildbox's deletion blocks nothing in F7(b).
- **The owner question R1 carries.** Publishing changes the bare-default client's full tier for 1,730 rsIds:
  - texel-replicated pages, blockier under close magnification [D];
  - 11 4096²/4096-edge sources clamped to 2048² (the only information loss; PAGE-RESAMPLE Handoff #7);
  - the 593 texfix repairs, which the owner asked for;
  - +43.9 % full-tier bytes for the resampled members (621.4 → 894.1 MB) and +11.6 % world-wide [M]. This is the
    world-scale figure PAGE-RESAMPLE Handoff #5 asked the Q75/B4a election to read first. It also adds to open lead 260
    (the Town Network HD set downloads in full);
  - about 1.78× resident BC7 texel area for the resampled members (page/source Mpx 1,369.4 / 771.4) [D], so the record
    budget and VRAM both grow.

  Either eye the default arm with the owner before R1, or take the R3 "declined" branch.

## 3. F7(c): the E2–E6 1070 batches

Folder: `docs/reengineering/queue-1070/`. SPEC §3 T31 = Batch B (E2+E3+E4), T32 = Batch C (E5+E6). Batch D
(2026-08-10) re-cut E6 for the v4 dist, and the T4 session ran it. Batch P0 (2026-10-22) is the handoff's P0.

| Item | File | What it measures (structural change) | Arms | Feeds | State | Needs the 1070 for | Laptop structural part (SwiftShader, one tab, `capped-build`, counts never looks) |
|---|---|---|---|---|---|---|---|
| **E2** | batch-B | Frame-1 preview world; preview-commit/`atlasRefeed` re-home; terrain ladder t128 → converged → t1024 | `packSource+texWorkers+texCompressedOnly` vs bare | **GATE-TEX** (T15) → `texCompressedOnly` flip → drawPools chain | Never run (`verdict: null`) | The owner eye: preview→full sharpening without flicker, array mip/aniso shimmer at grazing angles, t128→t1024 seam, the 79 %-held-out prop class | The frame-1-white zero-tolerance console/diag gate; boot reaches in-world with 0 allowlist-subtracted errors; `__texStats` coverage; `__terrainBc7Stats().ladder` promotions. The T4 found no terrain_bc7 tier on its dist (T128-INTERIM-EYE BLOCKED), so check the ladder on the served dist first |
| **E3** | batch-B | Worker-derived half-res NRA vs full-res Sobel | same | **GATE-TEX** | Never run | All of it: stone/wood/metal relief parity is pure eye (SPEC: pixel diffs inadmissible) | Only that the worker NRA path ran (`texWorkerStats`). NB: `nraSourceRes` (10-20, default on) changed the statics-atlas NRA since this item was written, so re-verify its OFF arm at go-time |
| **E4** | batch-B | q75 lossy full tier vs lossless | dist-level (manifest repoint) | **GATE-Q75** (T16) + the in-writing B4a election | Never run. The q75 **dist** was never produced | The in-world painted/emblem pass | None in-world. The sheet half is a desk review on the owner's phone (36 sheets; 4 texfix-affected sheets need regenerating first, texfix debt #3). NEW: the q75 corpus is pre-resample, so a q75 dist consistent with page-dim packs needs an R2 q75 encode of the 1,309 (~30–55 min, laptop) |
| D5-SHELL-EYE | batch-B | Bundled shell (T11): module-registry collapse | `index-bundled.html` vs `index.html` | none (B2 ledger) | Never run | — | Fully laptop-checkable (0 errors, world parity counts). Not a drawPools prerequisite |
| MEM-ROUTE-ST5, ULTRA-SOAK-30-ST5 | batch-B | M4/M5/M6 on route + 30-min ultra soak | ST5 vs legacy | GATE-TEX | `cmd: null`, not executable | M5/M6 at ultra on the real GPU | MEM-ROUTE structure only (M8/M9 are T2/laptop budgets) |
| **E5** | batch-C | Slot grid as residency authority: shift-in-place, teleport, sealed hub | `packSource+slotGrid` vs bare | **GATE-GRID** (T20) | Never run | The walk eye (seams, holes, ghost tiles across ≥3 shift boundaries; keyboard walk on a real GPU) | The integrity counters: `pinLeaks/shiftMismatches/slotDesyncs = 0` and `gridLruDivergence === 0` via `@teleloc` hops. T20's own laptop live arm already read divergence 0 over 14 crossings + zigzag + teleport (IMPLEMENTATION T20 row). r4 is recorded, not gated, on this arm |
| **E6** | batch-C, re-cut in batch-D | First pooled world: ClipMap pass membership, depth-bias floors, shadowed-town `receiveShadow`, envcell baked light, silhouettes, plus batch-D counter assertions | full F-11.3 chain + `drawPools` vs the same minus `drawPools` (K2) | **GATE-POOLS** (T22), the flip itself | **INCONCLUSIVE**, T4 only (2026-08-11): 9/10 counters pass; the offPage drain is not demonstrated (§2.3 explains it [D]); `containersVisible` has no key; owner ratification owed | The whole eye half, on the 1070 | All batch-D counter assertions (`classesCreatedPostBoot`, `mutationsThisFrame`, `heldOutNoRsId`, `refeedFormatMismatch`, refusals, envcells) = the P0-LAPTOP-TWIN arm-3 recipe. **The URLs predate `?negFace` (default ON 10-19):** add `&negFace=off` until the HBG1 v2 GEOM rebake deploys, or every model is `missing` (F7a). `?poolRuns` (default ON inside drawPools, in the working tree) now rides this arm too |
| MOVE-FIX-ST9 | batch-C (also batch-A/D MOVE-FIX-BASELINE) | Moving bench ≥1,800 frames; **creates** the F3/F4 baselines | pools on/off | GATE-POOLS kill row; SPEC §2.2 (F absolutes need it) | Never accepted (batch A: harness stall, since fixed by MOVEFIX-HARNESS; the T4 refused to create a baseline on the wrong GPU) | Everything (baseline-creating) | None. A laptop baseline would poison the comparison |
| GATE-GRID-BENCH-SET | batch-C | M1/M2 MEM-ROUTE, TAIL-ULTRA governor bucket, BENCH-ZIGZAG/TELEPORT confirm arms | grid vs legacy | GATE-GRID | `cmd: null` | M1/M2 + tail | BENCH-ZIGZAG / BENCH-TELEPORT also run as CI (S11) |
| P0 (arms 1–3) | batch-P0 | Per-range ANGLE term; whether the drawPools chain boots on HEAD; F1 | bare / `batchedRuns=off` / chain + `negFace=off` | Decides P1/L1 and the GATE-POOLS precondition for P3 | Queued (`result: null`) | CrGpuMain ms (`gputrace` + `gpu_thread_split`), owner-run | P0-LAPTOP-TWIN (`scripts/perf-worker/laptop-structure-probe.mjs`, in the working tree). Its arm-3 prereq text still cites "409 of 3,471", so see §5 |

E1 (batch A, GATE-GEOM) is the remaining eye on the chain. It was CLEAN on an R9 290 (orchestrator eye, 2026-08-10, not
the 1070), and owner ratification is open. It predates `?negFace`, so it needs a re-eye on the HBG1 v2 bake.

## 4. Every other prerequisite of flipping `?drawPools` (SPEC §0/§3), with current state

"Flip" means default-ON. SPEC §0.1/§3 make it the owner's migration event: an implementing agent never flips it.
Default flips go one at a time, with a clean soak between (pass 9 D-09.3.3). The kill cascade packSource →
{geomBundles, texCompressedOnly, slotGrid} → drawPools forces dependents OFF.

| # | Prerequisite (source) | Current state (evidence) | Blocks / next action |
|---|---|---|---|
| 1 | `?packSource` DEFAULT-ON via **GATE-WIRE-BOOT** (T12) | DEV/off (url-flags row). Local battery MET (T12 report: 0 mismatches / 0 terminal quarantines over the T10 region); P-SUBTLE ran (batch A). Comparative cold-boot bytes/requests vs legacy + BOOT-WARM + T2-BOT: no accepted run found | Every other stage. Owner-gated flip |
| 2 | `?geomBundles` via **GATE-GEOM** (T13): differ green, **E1 CLEAN**, P-ASSEMBLE, parked p50 non-regression | Differ green; P-ASSEMBLE ran (batch A); E1 CLEAN on an R9 290, ratification open. **Broken under `?negFace`** (default ON 10-19): `assemble_model_geometry` returns `missing` without a back-face marker (handoff F7a). HBG1 v2 face-marker encoder + `geom_face_*` census are in the working tree; runbook expected at `docs/HBG1-negface-marker-2026-10-22.md` (not present yet). [2026-10-23: v2 landed with its runbook, and the v5 rebake ran (not deployed; handoff §0).] | Land v2 → R3 rebake (with the farm choice from §2.5 R3) → wasm release → E1 re-eye |
| 3 | `?texCompressedOnly` via **GATE-TEX** (T15): **E2 + E3 CLEAN**, M4/M5/M6, B1 absolute, C4, frame-1-white zero | E2/E3 never run; MEM-ROUTE/ULTRA-SOAK `cmd: null`. CTX-LOSS-MIRRORS was DIRTY on the T4 (`mirrorRestoreFailed = 6`); the node fix landed (`725609ee`), live arm owed. T128-INTERIM-EYE blocked on the T4 dist (no terrain_bc7 tier) | Batch B on the 1070 + the CTX-LOSS live arm |
| 4 | `?texWorkers` via GATE-TEXWORKER (T14, soft dep of T15) | **DEFAULT-ON since 2026-10-06** (GATE-TEXWORKER measured on the 1070). TEXWORKER-INTERLEAVE hardening still queued | Met |
| 5 | **GATE-Q75** (T16): E4 + the two in-writing decisions (q75 verdict, B4a election) | Q75-ELECTION / B4a OPEN (batch-D ownerItems). NEW [M]: world full tier with page dims +11.6 % (the number they asked for). Off the T22 critical path (SPEC §4: "T16 off the critical path") but it decides which farm R1/R3 publish | Owner (redmi) |
| 6 | `?slotGrid` via **GATE-GRID** (T20): **E5 CLEAN**, divergence 0, integrity counters 0, M1/M2, ZIGZAG/TELEPORT, TAIL-ULTRA governor bucket | DEV/off. E5 never run; bench set `cmd: null`; T20 local live arm green | Batch C on the 1070 |
| 7 | `?frameWork` via **GATE-PHASE** (T21): `__framePhase` census + BENCH-CROSS-SETTLE fast-line AND 666 | DEV/off. No accepted GATE-PHASE run found [A: searched the queue files and impl reports] | A census run (laptop-capable for the census; 666 arm per SPEC) |
| 8 | T00 class census / R-03 | CLOSED-as-measured (63 classes / 271 pools Nanto) **pending the GATE-POOLS 1070 confirm**. T4 E6: 17 classes, 46 pools | Rides E6 |
| 9 | T22 remainder (IMPLEMENTATION row): envcells + the worker-side record→axis ladder (T22 D1) | ENVCELL-POOL-SWAP landed 08-10. Worker-side ladder: queued; no landing commit found (`git log --grep`) [A] | Agent task; not named by GATE-POOLS |
| 10 | **GATE-POOLS** (T22): E6 CLEAN; `classesCreatedPostBoot = 0`, pools ≤ ~300; parked `poolMutationsPerFrame = 0`; MOVE-FIX; TAIL-ULTRA F5 `linkStatusMs = 0`; ktris + GPU-boundedness | E6 INCONCLUSIVE (T4); census + mutation counters PASS on the T4; MOVE-FIX baselines never created; TAIL-ULTRA on pools never run. Wall row 33: culling-off costs +420k tris (+81 %), so the ktris/boundedness check is load-bearing | Batch C/D on the 1070 after rows 2, 11, 12 |
| 11 | **F1 criteria** (SPEC §1.5/§3 amendment 2026-10-22): `issuedSubDraws` ≤ legacy arm; CrGpuMain WebGL ms not worse; `?poolRuns` | SPEC amendment + `poolRuns` reader/tests/smoke in the working tree (uncommitted); the smoke (`harness/glsl_smoke/pool_runs_smoke.mjs`) is unrun | Merge + smoke, then P0 arm 3 / GATE-POOLS reads |
| 12 | **F7(b), corrected**: TEXREF page dims and the served `tex-xu7` catalog name the same farm | **MISMATCH 985** (§2.3); 593 texfix repairs unpublished | §2.5 R1 (owner go) or the R3 "declined" branch, then the R4 validator exits 0 |
| 13 | PAGE-RESAMPLE handoffs | #2 stitch LANDED (`4d9ddbd8`). #3 preview-feed decision (options a/b) OPEN, so `refused.needsResample` cannot reach 0 from the bake alone (T4: 8). #4 legacy-only residual = the 409 (§2.2). #6 VRAM: no M4 census on a page-dim pooled arm yet (impossible until row 12). #7 the 11 downscales: owner call | Owner (#3, #7); M4 census after row 12 |
| 14 | F-11.18 / R-11: `three_batchedmesh_colortexture_fix.js` applied at pool scale | MET (T22 `_verifyColorTextureFix`; T22P live `fix.applied: true`; `test_bm_colortexture_fix` 13/0) | Re-check on any three bump |
| 15 | Batch cadence (R-05), SPEC §2.2 binding | Three owner 1070 sessions serialize the promotions. F-series absolutes need MOVE-FIX baselines first | Scheduling |
| 16 | Handoff P0 decision rules (not SPEC, but P3 depends on them) | Batch P0 queued; arm-3 rule: if `issuedSubDraws` or CrGpuMain rises vs arm 1, L1 must land before any GATE-POOLS run | Owner-run 1070 session |

## 5. Suggested order (nothing here is self-initiated on the 1070)

1. **Owner decisions, which unblock everything else:** the R1 publish (or decline it), the 11 downscales, and the Q75/B4a
   election, now that its world-scale number exists (+11.6 %).
2. **Laptop, one heavy job at a time:**
   - R1 + the R4 validator, if the owner approved R1;
   - land HBG1 v2 (F7a);
   - **one** R3 rebake that carries both the v2 GEOM rows and the chosen farm;
   - wasm release build;
   - P0-LAPTOP-TWIN arm 3 as the structural read of rows 2, 11 and 12.
3. **1070, owner-run:** E1 re-eye + P0, then Batch B (E2, E3, in-world E4), then Batch C (E5, E6 with `negFace` as
   decided, MOVE-FIX-ST9, TAIL-ULTRA, the F1 reads).

## 6. Evidence index

- **Served dist.** `~/hb-serve/dist/current` → `holtburger-dist-hires-bc7m-xu7t2`, staged 2026-10-19 from the archive
  `/mnt/wbterminal2/holtburger-dist-hires-bc7m-xu7t2`:
  - `pack-report.json` is BAKE-4's;
  - `bake-source-packs.sha256` (BAKE-4 inputs);
  - `bake-source.sha256` (the 2026-08-05 legacy layer: `tex-xu7: /mnt/wbterminal2/xu7-ingest`, `portal-t2.dat`);
  - `manifest/holtburger-tex-xu7.bin` (HBNS v1, 3,985 entries, 2026-08-05).

  Trap: `apps/holtburger-web/dist` still points at the older `holtburger-dist-hires-bc7m-xu7` (no packs). serve.py does
  not use it (its root is `dist_ssd.CURRENT`), but a validator reading it reads the wrong dist.
- **Bakes.** `/mnt/wbterminal2/reeng/orch-bake/`: `run-world-bake-4.sh`, `driver4.log`, `mem.log` (BAKE-4 peak
  `cgB=3584 MiB` 15:56), `deploy-packs-v4.sh`, `world-packs-v4/packs` (17,682 packs; the TEXREF census source).
- **Corpora.**
  - `/mnt/wbterminal2/xu7-ingest` (symlinks into `xubc7-corpus/*-lossless`, texfix-updated 08-09);
  - `/mnt/wbterminal2/xu7-ingest-pages` (page farm);
  - `/mnt/wbterminal2/reeng/page-resample/{src-all,src-corpus-pages,encode-ids-full.txt,encode-region-pages.sh}`;
  - `/mnt/wbterminal2/xubc7-corpus/encode_lossless.sh` + `encode-lossless.log` (the 08-04 laptop run);
  - `/mnt/wbterminal2/xubc7-corpus-q75/PROVENANCE.md`; `/mnt/wbterminal2/reeng/T16/q75-driver.sh`;
  - `/mnt/wbterminal2/xubc7-proto/results/matrix.json` (per-texture laptop encode seconds).
- **Docs.**
  - `docs/reengineering/impl/task-PAGE-RESAMPLE-report.md` (D3, D4, D6, Handoffs #1–#7);
  - `impl/texfix-fringe-2026-08-09.md` (propagation debts #1–#3);
  - `impl/task-T4-EYES-report.md` §3.4;
  - archived `docs/archive/apps/holtburger-web/docs/reengineering/ORCHESTRATOR-HANDOFF.md` §-5…§-9;
  - `docs/HANDOFF-texture-pipeline-2026-08-04.md` §2, §5b, §6.
- **Code.**
  - `apps/holtburger-tools/src/bin/dat-shard.rs` `main` (legacy skip);
  - `apps/holtburger-tools/src/dat_shard.rs` side-car branch and `ingest_tex_xu7_dir`;
  - `apps/holtburger-tools/src/pack_bake.rs` TEXREF census (`texref_off_page_*`, `texref_legacy_only`);
  - `apps/holtburger-tools/src/pack_format.rs` `TexRefRow`/`tier_bits`;
  - `crates/holtburger-manifest/src/catalog.rs` (HBNS format);
  - `apps/holtburger-web/src/lib.rs` `xu7_cas_info`;
  - `scene3d/pool_producer.js` `_axisRecordFor`/`_holdOut`;
  - `service-worker.js` `currentBakeId`/`isBakeVersioned`;
  - `scripts/dist_ssd.py` `cmd_stage`.
- **Classification recipe (§2.2).** Take the TEXREF rows without bit 5 from the census. Join them against
  `tranche2-proto/records-4x/*.bin` names, `work/batch_ids.txt`, `EXCLUDED-rsids.txt`, and the PNG IHDR dims from
  `tex-reexport-2026-07-30/<rsId>.png`. Precedence: shipped paletted, then cap-skipped paletted, then excluded, then
  max edge ≤ 32, then other.
