# PAGE-RESAMPLE — the bake/transcode-side page-dim resample (T22 deviation D2)

T22 shipped the array-page class key and recorded the hole in it:

> **D2** — the page-tier class key is CORRECT ONLY ONCE MEMBERS ARE RESAMPLED TO PAGE
> DIMS, and that resample does not exist yet. … the key as shipped is sound as a
> *census* key today and becomes sound as an *allocation* key only when the resample
> lands. `pageDimsOf()`/`needsResample()` are exported so the transcode side has the
> exact predicate.

This task is the resample. It lands as four bisectable commits: the arithmetic + kernel,
the derived-corpus producer, the bake wiring, and the one client-side read of the new
marker. The gate — `needsResample` over every full-tier member of a bounded region —
went **185 → 0**, measured end to end through real KTX2 headers.

It also found, and fixed, a defect nobody was looking for: the TEXREF row was declaring
the **DAT record's** dims while the shipped full tier is the **4× upscale corpus**, so
the page tier the class key would compute was wrong for **253 of 400** sampled members
before any resample was in the picture.

## Shipped

| file | commit | what |
|---|---|---|
| `apps/holtburger-tools/src/page_resample.rs` (new) | `6625e821` | page-tier arithmetic mirroring `scene3d/pool_class_key.js` + the exact-rational integer AREA kernel + `plan_page` |
| `apps/holtburger-tools/src/lib.rs` | `6625e821` | module export |
| `apps/holtburger-tools/tests/page_resample.rs` (new) | `6625e821`, `cb3674f4`, `6eff9597` | the JS↔Rust parity pin, the corpus-histogram plan, the CLI end-to-end, the 4× ground-truth test |
| `apps/holtburger-tools/src/bin/page-resample.rs` (new) | `cb3674f4` | the derived-tier producer (plan + sha256 + `bake-source.sha256` + `PROVENANCE.md`) |
| `Cargo.toml`, `apps/holtburger-tools/Cargo.toml`, `Cargo.lock` | `cb3674f4` | `png 0.18` (native tool crate only) |
| `apps/holtburger-tools/src/pack_format.rs` | `6eff9597` | `tier_bits::FULL_PAGE_DIMS` (bit 5) |
| `apps/holtburger-tools/src/pack_bake.rs` | `6eff9597` | KTX2 header read, full-tier-declared TEXREF dims, the page census, `verify_texref_pages`, the `require_page_dims` gate |
| `apps/holtburger-tools/src/bin/dat-shard.rs` | `6eff9597` | `--require-page-dims` |
| `apps/holtburger-tools/tests/bake_ci.rs` | `6eff9597` | `bake_ci_page_resample_region` (two arms, scored against the emitted bytes) |
| `apps/holtburger-web/scene3d/bc7_textures.js` | `8ab2eb3d` | `texRefPageInfo()` + the tier-bit constants + two counters |
| `apps/holtburger-web/harness/lib/diag_schema.mjs` | `8ab2eb3d` | the two counters registered on `__texStats`; four evidence line refs re-pinned |
| `apps/holtburger-web/harness/test_page_resample_texref.mjs` (new) | `8ab2eb3d` | the 26-check client battery |

Data artifacts, all under `/mnt/wbterminal2/reeng/page-resample/` (never the source
tree — I5):

| artifact | what |
|---|---|
| `src-corpus-pages/` | the **full derived PNG tier — COMPLETE**: 3,985 members at page dims (2,676 identity / 1,298 upscaled / 11 downscaled; `needsResample` 1,309 → **0**; 4,660.7 MB → 4,666.4 MB source-side, 1.2 GB on disk because 2,676 members are symlinks), plus `page-resample-plan.json`, `page-resample.sha256` (3,985 rows), `bake-source.sha256` and `PROVENANCE.md`. This is the encode input for step 1 below. ~1 h to regenerate on this laptop, single-threaded by design: the 4096² cases hold a 134 MB intermediate and a rayon pool would multiply that by the core count on a 7.8 GB box. Re-run: `page-resample --src /mnt/wbterminal2/reeng/page-resample/src-all --out <dir> --verify-deterministic` |
| `src-region-pages/` | the same for the 413 full-tier rsIds of T10's bounded region |
| `xu7-ingest-pages/` | the region's page-dim XUBC7 ingest (185 re-encoded, 228 identity members symlinked from the live corpus) |
| `region-texref-xu7-ids.txt` | the region's full-tier rsIds, written by the CI leg itself |
| `encode-region-pages.sh`, `encode-region-pages.log` | the encode driver + log (0 FAIL) |
| `page-resample-bake-ci.json` | the two-arm leg summary |
| `bake-live/`, `bake-pages/` | the two bounded-region bakes |

Nothing pushed.

## Spec conformance

SPEC.md has no PAGE-RESAMPLE card — the work is T22's recorded deviation D2, whose
authority is the T00 re-key proposal §4 (`impl/t00-rekey-proposal-2026-08-09.md`) as
propagated into pass-07 S3/D-07.2 and SPEC §1.5. Scored against that text and against
the orchestrator's charge.

| requirement | status | evidence |
|---|---|---|
| "a member whose native dims ≠ its page dims is stored RESAMPLED to page dims at bake/transcode time" (re-key §4) | **MET for the full tier, over a bounded region; corpus-wide encode is a buildbox job** | `page-resample` produces the derived tier; `bake_ci_page_resample_region` arm B reads real KTX2 headers and scores `texref_off_page_full_tier = 0` (was 185) |
| consume `pageDimsOf`/`needsResample`, or mirror the arithmetic EXACTLY with a shared-constant test pinning them | **MET (mirror + pin)** | `page_resample.rs` mirrors it; `predicate_matches_pool_class_key_js` runs the REAL `scene3d/pool_class_key.js` under `node` over **2,888** `(hasTex, w, h)` records and diffs `PAGE_TIER_MIN`, `PAGE_TIER_MAX`, `pageTierOf`, `pageEdgeOf`, `pageDimsOf`, `needsResample`. The mirror could not simply *import* the JS: `pool_class_key.js` is T22's scope and this task is forbidden to edit it, and the bake is a Rust binary |
| deterministic and provenance-carrying | **MET** | integer-only kernel (no floats); rsId-ordered; PNG encoder settings pinned in-tree rather than inherited; `--verify-deterministic` re-runs kernel + encoder per member; two independent runs over 33 real corpus members produced identical `page-resample.sha256`; `sha256sum -c` 33/33 OK. Every derived dir carries `page-resample-plan.json` (source dims, page dims, tier, action, source sha256, output sha256), `page-resample.sha256`, `bake-source.sha256`, `PROVENANCE.md` |
| existing corpora (`xubc7-corpus`, q75) NOT mutated in place; derived tier or sidecar; promotion path documented | **MET** | the tool REFUSES `--src == --out`; identity members are symlinks back to the source, so they are byte-identical by construction; the CLI end-to-end test asserts `--src` is untouched byte-for-byte and that `--src == --out` exits non-zero. Promotion path in `PROVENANCE.md` and in Handoffs below |
| decide the pack/dist story (texref bit vs new rows vs replacement payloads) and record it as a deviation if SPEC is silent | **MET** | **replacement payloads at bake + one tier bit.** Recorded as D4 with the read-verified reasoning |
| client side minimal, `needsResample()` members TREND TO ZERO on a future bake | **MET for the bake half; the client half needs one more line that is NOT this task's to write** | `texRefPageInfo()` landed, counted, inert by construction. But `pool_producer.js:195` calls `axisRecordOf(mat, …)` with **no `texRef`**, so the pooled arm still keys on LIVE dims — read-verified this session. See Handoffs #2; that line is in the producer-swap agent's scope |
| do not touch `statics.js`, `cells.js`, `static_batch_x.js`, `pool_*.js` | **MET** | none of those files appear in any of the four commits (`git show --stat`) |
| native Rust tests for the resample math (deterministic, dims-exact) | **MET** | 12 unit tests + 5 integration tests (below) |
| bounded-region bake/transcode CI leg proving `needsResample` counts drop to zero over the region | **MET** | `bake_ci_page_resample_region`, both arms, 107 s |
| JS battery only if a client-side reader was added | **MET** | one was; 26 checks |

## Measurements

All bake figures are `@resident`-scale bake census over T10's bounded region
(`0xA4AF:0xAEB9` + the deterministic densest-interior 3×3, `0x00AD:0x01AF`). No frame
time is claimed, derived or implied by this task.

**The gate.**

| arm | TEXREF rows | on-page | off-page | of which full-tier | of which legacy-only |
|---|---|---|---|---|---|
| A — live corpus | 462 | 228 | 234 | **185** | 49 |
| B — page-resampled | 462 | **413** | 49 | **0** | 49 |

**The 4× finding** [M, 400-record deterministic slice of `/mnt/wbterminal2/xu7-ingest`]:
400 of 400 full-tier payloads are exactly 4× the DAT record in each axis; 0 equal;
0 other. Keying the page tier on the DAT record instead of the full tier would put
**253 of 400** members in the wrong class. Pinned as
`full_tier_is_four_x_the_dat_record_dims`.

**Corpus-wide plan** [M, the full 3,985-member run, not a projection]: 2,676 identity /
1,298 upscaled / 11 downscaled — `needsResample` reads **1,309** over the live corpus and
**0** over the derived tier, which the tool asserts before it writes its manifest. The 11 downscales are the tier clamp: eight 4096², one
128×4096, one 1024×4096, one 2560×1920.

**Byte cost** [M, region-scoped — the corpus-wide figure needs the buildbox encode]:

| stage | before | after | ratio |
|---|---|---|---|
| PNG source tier, 413 members | 244.1 MB | 249.8 MB | 1.023 |
| encoded XUBC7, same 413 members | 121.36 MB | 137.36 MB | **1.132** |

The PNG tier barely moves (a replicated upscale compresses almost for free); the encoded
tier grows 13.2 %, which is the real number — it is BC7 blocks, 8 bpp of page area. This
lands on the B4a election and is flagged in Handoffs.

**Why the kernel is an area filter, and why that is not a quality compromise.** Integer
upscale degenerates EXACTLY to texel replication, so a box mip chain over a k× replicated
page reproduces the ORIGINAL image at level log2(k) — asserted at 8→256 and again at
512→2048 (`corpus_scale_replication_round_trip`, byte-exact). The page costs VRAM and
never sharpness. A bilinear or Lanczos "upscale" would blur content the GPU otherwise
magnifies identically to the native texture. Integer downscale degenerates to the box
average mip generation already performs. `basisu -resample` is also a box filter, so a
member that ever skips this tool and gets resampled by the encoder lands in the same
place — but the encoder's version is not reproducible outside that binary and would put
the resample decision behind a flag no test can see, so the kernel is owned here.

## Deviations

**D1 — the TEXREF `dims` byte now declares the FULL TIER's dims, not the DAT record's.
This changes emitted pack bytes for every bake.**
SPEC §1.3 and the re-key §4 both say the tier derives from "TEXREF-**declared**
(full-tier) dims". The implementation did not: `pack_bake.rs`'s `build_texref_rows`
called `tex_dims(&source, rs)` → `Texture::unpack` on the DAT record. Read-verified
evidence that this is a defect and not a preference: the shipped full tier is the
upscale corpus, 4× the DAT record in each axis over 400/400 sampled records, shifting
the page tier for 253 of them; and `xu7_present()` deliberately treated the KTX2 as
opaque, so nothing in the bake had ever looked at what it actually declares. The bake now
reads 32 bytes of KTX2 header (the payload stays opaque) and falls back to the DAT record
only when there is no full tier. `texref_full_tier_dims_differ` reports the gap — 413 of
413 over the region, i.e. every full-tier member.

**D2 — a new TEXREF tier bit (`FULL_PAGE_DIMS`, bit 5), because the dims byte cannot
express the answer.**
SPEC is silent on a page marker. The byte is 4 bits per axis of `ceil(log2)`, so the
corpus's 1096² member rounds to `2^11 × 2^11` and is **indistinguishable from a real
2048² page**. Found by a test that asserted the obvious two-way invariant and went red
(`the_page_bit_is_the_authority_the_dims_byte_cannot_be`). The invariant is therefore
ONE-WAY — bit set ⇒ the byte decodes to a legal square page — and every consumer must
trust the bit. Bits 3 and 4 are reserved-and-zero (`OFFLINE_NRA`, `TEXCHAN_SIDECAR`), so
bit 5 is claimed; bits 6–7 remain free. The row width is unchanged, so this is additive
on the wire.

**D3 — the gate is scoped to rows that HAVE a full tier; legacy-only rows stay off-page,
counted separately.**
49 of the region's 462 TEXREF rows (10.6 %) carry no compressed full tier at all — their
pixels come from the DAT record through the legacy decode, and no corpus re-encode moves
them. `require_page_dims` gates `texref_off_page_full_tier`; `texref_off_page_legacy_only`
is reported beside it and the CI leg asserts the legacy population is *unchanged* by the
resample. Folding the two together would make a "0" meaningless. These members need either
full-tier coverage in the corpus or an explicit exclusion in the pool producer — Handoffs
#4.

**D4 — the pack/dist story: RESAMPLED MEMBERS RIDE REPLACEMENT PAYLOADS AT BAKE, plus one
tier bit. Not new rows, not a payload-selection bit.**
SPEC is silent, so the choice is recorded here with the read-verification behind it.
`dat-shard --tex-xu7 <DIR>` ingests the full tier from a directory of `<rsId>.ktx2`
addressed by RenderSurface id; the bake publishes them into `holtburger/tex-xu7` and the
deployed manifest/`world_index`/tex-xu7 catalog select which shard store is live. That is
already the mechanism T16 documented for the q75↔lossless swap (K3: "manifest points at
either corpus; both are CAS"). So the page-resampled corpus is a SIBLING CAS tier reached
by pointing the bake at a different `--tex-xu7` directory, and rolling back is a redeploy
rather than a re-bake. New TEXREF rows were rejected because a second row per rsId makes
class identity ambiguous at exactly the moment it must be closed at boot (D-07.9); a
payload-selection bit was rejected because the client would then need two fetch paths for
one tier, which is the "compressed-only" property ST5 just finished establishing. The only
wire consequences are the tier bit (D2) and the dims byte's corrected meaning (D1).

**D5 — the PVW preview tier is NOT resampled; only the full tier is.**
The re-key §4 explicitly leaves the "preview feed" to T22 as an advisory with two
compatible options — (a) a designated preview page per class tier with `atlasRefeed` as
pool-to-pool transfer, or (b) upsampling the ≤128² preview into the member's FINAL page
layer at transcode. Neither is part of the key, and (b) is a texture-worker change that
would land in `pool_material.js`'s write path, which this task must not touch. Consequence,
stated plainly: a member resident at PREVIEW dims still cannot fill a page layer, so the
producer's `refused.needsResample` will not reach 0 on live dims until that decision is
taken. Handoffs #3.

**D6 — the corpus-wide XUBC7 encode was not run here; the bounded region was.**
I5 makes the full-corpus encode a buildbox job (T16 measured ~17 min at `-P 16` for
3,985 members; the laptop has 4 cores and 7.8 GB). The full derived **PNG** tier IS
produced and sha-verified on the external drive, so the buildbox job is a pure encode
with the UNCHANGED per-member command. The region's 185 resampled members were encoded
locally (0 FAIL) to make the CI leg real rather than asserted.

## Tests run

Rust, via `env PATH=… capped-build cargo test -p holtburger-tools --release …` (I5:
single package, never `--workspace`; `rust-analyzer` killed first).

| command | result |
|---|---|
| `--lib` | **50 passed, 0 failed** (12 new: 10 `page_resample::tests` + `ktx2_dims_reads_the_header_and_rejects_non_ktx2` + `the_page_bit_is_the_authority_the_dims_byte_cannot_be`) |
| `--test page_resample` | **5 passed, 0 failed** — `predicate_matches_pool_class_key_js` (2,888 records agree with the real JS module), `real_corpus_histogram_lands_on_legal_pages`, `page_dims_byte_round_trips`, `corpus_scale_replication_round_trip`, `cli_derives_a_page_dim_tier_with_provenance` |
| `--test page_resample -- --ignored full_tier` | **1 passed** — 400/400 exactly 4×, tier would shift for 253 |
| `--test bake_ci -- --ignored bake_ci_page_resample_region` | **1 passed**, 107 s — the two-arm gate above |
| `--test bake_ci -- --ignored bake_ci_bounded_region` | **1 passed**, 170 s — T10's GATE-BAKE arm re-run under the changed emitter: closure verified, determinism verified, `missingPvw = 0`, differ 2,022 unique models / 3,365 envcells byte-verified, HBG1 1,927 rows byte-identical re-encode |
| whole package (`cargo test -p holtburger-tools --release`) | all suites green |

JS, node, from `apps/holtburger-web/`.

| command | result |
|---|---|
| `node harness/test_page_resample_texref.mjs` | **26 passed, 0 failed** — PAGE-RESAMPLE-TEXREF ✅ |
| `node harness/test_tex_compressed_only.mjs` | 112 passed, 0 failed ✅ |
| `node harness/test_texture_worker.mjs` | 69 passed, 0 failed |
| `node harness/test_nra_derive.mjs` | 41 passed, 0 failed |
| `node harness/test_terrain_tier_ladder.mjs` | 105 passed, 0 failed |
| `node harness/test_diag_schema.mjs` | DIAG-SCHEMA ✅ (69 checks; the four bc7_textures.js evidence refs re-pinned) |
| `node harness/test_draw_pools.mjs` | DRAW-POOLS ✅ |
| `node harness/test_census_class.mjs` | CENSUS-CLASS-TEST ✅ |
| `node harness/test_build_shell.mjs` | BUILD-SHELL ✅ 56 passed |
| `node scripts/lint-url-flags.mjs --app apps/holtburger-web` (repo root) | 0 undocumented readers owed docs rows — this task introduces **no URL flag** |

Corpus determinism: two independent `page-resample` runs over 33 real corpus members
produced byte-identical `page-resample.sha256`; `sha256sum -c` 33/33 OK. Region encode:
185 ok / 0 FAIL.

`docs/RESULTS-shell-requests-2026-08-09.json` was regenerated by `test_build_shell` and
RESTORED, not committed — it is T11's measurement record (the same call T22 made).

**No wasm was rebuilt**: nothing under `src/` or `crates/` was touched, and `pkg/` is
untouched.

## Handoffs & risks

**1. WHAT THE NEXT FULL-WORLD BAKE MUST BE INVOKED WITH.** Two steps; the orchestrator
owns the scheduling.

*Step 1 — encode the derived tier (buildbox; ~17 min at `-P 16` by T16's measurement).*
The PNG tier is already produced and sha-verified:
`/mnt/wbterminal2/reeng/page-resample/src-corpus-pages/` (3,985 members; 2,676 of them are
symlinks straight back to `upscale-corpus`, so **only 1,309 need encoding at all** — the
identity members' existing KTX2 can be symlinked from `/mnt/wbterminal2/xu7-ingest`
exactly as the region arm did, which is what `encode-region-pages.sh` demonstrates).
Per-member command, UNCHANGED from the live lossless corpus so the only variable is the
dims:

```
basisu -xubc7 -mipmap -output_file <rsId>.ktx2 <rsId>.png     # lossless (today's live arm)
basisu -xubc7 -quality 75 -mipmap -output_file <rsId>.ktx2 <rsId>.png   # if the owner elects q75
```

Result goes to a NEW ingest farm, e.g. `/mnt/wbterminal2/xu7-ingest-pages`.

*Step 2 — the bake.* Read-verified against
`/mnt/wbterminal2/reeng/orch-bake/run-world-bake.sh` this session (it is a 3-phase
driver: warn-only bake → harvest `pvw_wanted_from_xu7` → derive previews → verified
rebake). Exactly **three** edits:

1. In `ARGS`, `--tex-xu7 /mnt/wbterminal2/xu7-ingest` → `--tex-xu7 <PAGE-DIM INGEST>`.
2. In the DERIVE phase, `derive-pvw-xu7.mjs --xu7 /mnt/wbterminal2/xu7-ingest` →
   the SAME page-dim farm. The deriver slices previews out of the full tier; pointing
   it at the old corpus would derive previews from a different aspect than the tier
   they preview. This is the edit that is easy to miss — the path appears twice.
3. On the **RUN2 (verified)** invocation only, add `--require-page-dims`:
   `capped-build "$BIN" "${ARGS[@]}" --verify-closure --verify-deterministic
   --require-page-dims`. RUN1 is the warn-only harvest pass and must not abort before
   the previews are derived.

So the verified bake carries `… --emit-packs --tex-xu7 <PAGE-DIM INGEST>
--verify-closure --verify-deterministic --require-page-dims …`, everything else
unchanged. `--require-page-dims` FAILS the bake if any full-tier member is still off
its page and names the offenders; without it the bake only censuses
(`texref_on_page` / `texref_off_page` / `texref_off_page_full_tier` /
`texref_off_page_legacy_only` in `pack-report.json`). `--verify-closure` additionally
runs the new `verify_texref_pages` emitter check. That bake is R-MEM1-bound on the
laptop (~3.44 G cgroup on 2026-08-09) — schedule it alone.

**Do not deploy the page-dim bake without reading #2 first** — a pooled arm on a
page-dim dist still keys on live dims until that one line lands, so the dist would be
correct and the pools would not benefit.

**2. `pool_producer.js:195` must pass `texRef` (producer-swap agent's scope).**
Read-verified this session: it calls `axisRecordOf(mat, { domain, castShadow, receiveShadow })`
with no `texRef`, so `axisRecordOf` falls back to live `material.map` dims and stamps
`texApprox: true`. The seam is one argument:

```js
const info = texRefPageInfo(rsId);            // scene3d/bc7_textures.js
rec = axisRecordOf(mat, { domain, castShadow: cast, receiveShadow: recv,
                          texRef: info ? { w: info.w, h: info.h, compressed: true } : null });
```

`texRefPageInfo` also carries `onPage`, which is the authority the dims byte cannot be
(D2) — a member with `onPage === false` should keep taking the legacy path even if its
decoded dims happen to look square. That is the coordination surface this task was asked
to leave, and it is exported, counted (`__texStats().coverage.texRefOnPage` /
`texRefOffPage`) and covered by a 26-check battery.

**3. The preview-feed decision is still open (re-key §4, D5).** Until it is taken, a
member resident at PREVIEW dims cannot fill a page layer, so `classPages.refused.needsResample`
(85 on T22P's live arm) will not reach 0 from the bake alone. Options, unchanged from the
proposal: (a) a designated preview page per class tier with `atlasRefeed` as pool-to-pool
transfer; (b) upsample the preview into the member's FINAL page layer at transcode, which
makes `atlasRefeed` an in-place layer rewrite at the price of full-page preview uploads
during the boot burst. (b) is the simpler pool contract and is a texture-worker change.

**4. The legacy-only residual (D3).** 49 of 462 region rows have no full tier. At
full-world scale that population is what `texref_off_page_legacy_only` will report; it is
the pool producer's exclusion list, not a bake defect.

**5. RISK — the B4a election gets worse.** The encoded full tier grew **13.2 %** over the
region's 413 members [M, region-scoped]. T16 already measured the q75 corpus at 0.690 of
lossless, projecting B4a ≈ 69.6 MB against a ≤65 gate. If that ratio holds at world scale,
page-resampling multiplies the full-tier term again. The named escapes are unchanged (the
rdo arm ≈ 42, or the owner relaxation), but the owner should see this number before
electing. Two things soften it and neither is measured yet: the 13.2 % is over a region
whose composition is not the ring's, and 2,676 of 3,985 corpus members are identity (zero
growth), so the world-scale figure could land well below 13.2 %. **A world-scale byte
figure needs the buildbox encode of the full derived tier — that is the first thing to
read off step 1 above.**

**6. RISK — VRAM.** The re-key proposal's own [D] upper bound was +31.6 MB at Nanto for
162 resampled materials. T22P's live arm measured 17 class pages allocating 127.8 MiB
*before* any resample, with the envcell domain not yet swapped. The resample moves members
UP to their page, so the class-page allocation only grows. This is inside the D-05.8
≤256 MiB atlas-class budget on the proposal's arithmetic, but it is now two independent
[A]s stacked and deserves a real M4 census on the first page-dim pooled arm.

**7. The 11 DOWNSCALES are the one place the resample loses information.** `page_tier_of`
clamps at 2048, so a 4096² member is stored at 2048² — a real reduction, not a
reformatting. Eight 4096², one 128×4096, one 1024×4096 and one 2560×1920 across the whole
corpus. If any of them is a hero surface the owner cares about, the escape is raising
`PAGE_TIER_MAX` to 12 on BOTH sides (the parity test will hold them together), at the cost
of a fifth page tier in the class key. Not raised here: 11 of 3,985 did not look worth a
class-count regression, and the decision belongs to whoever owns the class bound.

**8. Working tree.** The concurrent T22-PRODUCER task landed while this one ran; none of
its files (`pool_*.js`, `statics.js`, `cells.js`, `static_batch_x.js`) appear in any of
these four commits, and none of this task's files appear in its. The only shared file is
`harness/lib/diag_schema.mjs`, where this task added two field rows and re-pinned four
`bc7_textures.js` evidence line refs (the insertion moved them) — a merge-visible edit, so
worth knowing about if that agent is still in flight there.
