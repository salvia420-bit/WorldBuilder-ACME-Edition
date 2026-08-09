# T15 — ST5: compressed-only texture path (`?texCompressedOnly`): implementation report

Agent: T15 implementation agent. Date: 2026-08-09. Scope: `scene3d/bc7_textures.js`,
`scene3d/xu7_textures.js`, `scene3d/materials.js`, `scene3d/static_atlas.js`,
`scene3d/texture_release.js`, `apps/holtburger-web/src/{lib.rs,pack_source_glue.rs}`,
`crates/holtburger-resource-http/src/{pack.rs,manifest_source.rs}`, `harness/**`,
`docs/url-flags.md`, S7.3 doc rows. Recorded out-of-scope edits (I2, each minimal +
unavoidable): `index.html` (arming — the T20 curated-bag lesson), `harness/lib/
scene3d_stubs.mjs` + `harness/test_diag_schema.mjs` (splice-stub map + the registry's
reserved→current expectation move in the same commit as the surface).

This is a **coherent staged subset** per the SPEC's bisectable-landing preference and
the task directive ("an honest partial beats a papered-over whole"). What remains is
named exactly in *Handoffs & risks*; the two structural remainders are the terrain
tier-ladder wiring and the rehydrate-v3 mirror-policy completion.

## Shipped

| commit | what |
|---|---|
| `3c49c17d` | **Rust half.** `pack.rs`: `insert_pack` registers PVW payloads (rsId → HBC7 bytes, `parse_pvw_index`) + TEXREF rows (rsId → tier_bits/dims, `parse_texref_rows`) alongside the record streams — first-copy dedup across carriers, section-identity unregistration at eviction, `pvw_payload()`/`texref()` sync accessors, `pvw_rows`/`texref_rows` stats, new unit test. `manifest_source.rs`: `shard_cas_info(ns, fid)` → (CAS url, trunc-16 sha) WITHOUT fetching the record (single-namespace catalog-ensure mirroring prefetch Step B; V1/convention mode → None). `pack_source_glue.rs`: `pack_pvw_blocks` / `pack_texref` exports + additive stats keys. `lib.rs`: `surface_meta_sync(did)` (scalars-only sync surface decode — resident 0x08+0x05 records, no pixel planes, no 0x06 fetch, JSON; `palId`/`aliased` mark the substituted class) + `xu7_cas_info(rsId)` (async lane-T routing input). |
| `4976f0e5` | **Texture-family core JS.** `bc7_textures.js`: `texCompressedOnlyEnabled` (EXACT-MATCH DEV opt-in, DEFAULT OFF) + `initTexCompressedOnly`/`texCompressedOnlyActive` (4-leg gate: flag + BPTC + armed wasm exports + armed `?packSource` controller); `makeBc7ArrayTexture` `opts.mipChain` full-chain + aniso allocation (OFF arm byte-identical level-0-only); `writeBc7ArrayLayer` all-level chain writes, validate-before-write, LOUD shallow-payload refusal (`chainWriteRejects`); record budget 256→128 MB under the flag; `Bc7RecordSource.adoptParsed`/`dropRecord`; `registerAtlasRefeed`/`atlasRefeed` producer-agnostic seam (F-11.17); `texStats()` + `window.__texStats`; header rewritten (S7.3). `xu7_textures.js`: `transcodeXu7WithNra` (worker-first with the T14 `want.nra` rider, bounded ready-wait, counted FIFO fallback without NRA). Registry: `__texStats` reserved→current; evidence refreshes; stub map. |
| `7cc64ad4` | **Consumers.** `materials.js`: `_tryCompressedOnlyBuild` (frame-1 preview-born build in `get()` + `_installFromPixels`; legacy-routed: solid / substituted / no-TEXREF / non-resident / PVW-carrier-in-flight), `_upgradeCompressedFull` (lane-T via controller + hash-on-receipt → worker transcode + NRA → swap via the extracted-and-shared `_repointAlbedoForDid` → record adoption → `atlasRefeed`), `_attachWorkerNra` (packed plane → RGB8 normal, z reconstructed), `demoteToPreview(did)` (D-05.8 primitive; preview retained per-DID, freed with its entry). `static_atlas.js`: preview-commit + rsId member tracking + `_atlasRefeedImpl` re-home (the CONSCIOUS THROWAWAY) + `?atlasPreviewCommit=off` hold-out arm WITH the re-feed hook + chain buckets + chain-aware grow + ×1.5 growth + empty-bucket GC + LB-eviction purge of re-home rows. `index.html`: fail-soft arming. |
| `db93c40a` | **Battery + docs.** `harness/test_tex_compressed_only.mjs` (84 checks — see Tests run); url-flags rows `texCompressedOnly` (+§0 adjudication) and `atlasPreviewCommit`; `texFreeCpu` row + `texture_release.js` header re-scoped (S7.3). |
| (report commit) | **Release wasm** rebuilt from HEAD and rsync'd into `pkg/` (see Tests run; pkg/ is gitignored build output, so the rebuild rides no commit — this row lands the report + status row). |

## Spec conformance

SPEC §3 T15: *"scalars-only surface decode, PVW frame-1 materials, lane-T upgrade,
preview-commit + `atlasRefeed` re-home (conscious throwaway; seam producer-agnostic
[F-11.17]), full-chain+aniso arrays, ×1.5 growth, worker-NRA, rehydrate v3 + mirror
policy, terrain tier ladder wiring (t128 → converged → deferred t1024 per §0.2.1),
128 MB record budget, demote-to-preview primitive. Deps: T12 (+T14 soft).
Acceptance: GATE-TEX — E2 + E3 CLEAN (Batch B); M4/M5/M6 on route+soak; B1 absolute;
C4; frame-1-white zero-tolerance."*

- **Scalars-only surface decode** — **MET, two recorded gaps (D1).** `surface_meta_sync`
  reads the pack-resident 0x08 Surface + 0x05 SurfaceTexture records synchronously and
  emits every scalar `materials.js:5495–5504` consumes EXCEPT `hasPalette` (needs the
  deliberately-unpacked 0x06 header) and the pixel-stats `category` heuristic (overrides
  consulted; else Generic) — see Deviations D1. The palette-substituted class
  (`palId != 0` / tex-swap alias) is detected and legacy-routed — the SPEC §0.4 I3 kept
  degree.
- **PVW frame-1 materials** — **MET (node-proven); live frame-1-white zero-tolerance
  DEFERRED-TO-BATCH.** PVW payloads + TEXREF rows register at pack admission (real-corpus
  proof: the T10-region battery admits real preview packs; the full-world dist carries
  3,471 TEXREF rows / `texref_missing_pvw = 0` per its pack-report). Materials are born
  with `makeBc7Texture(parseHbc7(pvw))` — full chain, mips + aniso, zero pixel decode,
  zero legacy fetches (suite-pinned: the legacy fetch spy reads 0 on the compressed path).
  A TEXREF'd rsId with a missing PVW is counted + warned and legacy-routed (D2 — never
  silently wrong pixels, never white).
- **Lane-T upgrade** — **MET, one substrate deviation (D3).** Full-tier bytes ride
  `controller.need(url, {lane:"T", component:"texFull", expectedHash})` with
  hash-on-receipt against the catalog's trunc-16 sha; suite pins lane/component/hash.
  The URL is the legacy shard-CAS URL (the dist ships no per-record `tex/` tier — D3).
  No-CAS-info fallback = the legacy `xu7_blocks` record route; every failure keeps the
  preview, counted.
- **Preview-commit + `atlasRefeed` re-home** — **MET.** Default arm: preview-born nodes
  commit at preview dims from frame 1 (the `__bc7Pending` 79%-unbatched hold-out class
  does not exist on this arm); `atlasRefeed(rsId)` excises + re-feeds into the full-dim
  bucket; emptied buckets GC. Escape arm (`?atlasPreviewCommit=off`): hold-out WITH the
  re-feed hook — held singletons commit + leave the scene on refeed; nothing can stick.
  The seam is producer-agnostic (registered handler; pools re-register at ST9) and the
  atlas-side implementation is marked CONSCIOUS THROWAWAY at every site (F-11.17).
- **Full-chain + aniso arrays** — **MET.** Chain allocation + all-level writes +
  mipmapped filtering + preset aniso, flag-gated; OFF arm byte-identical level-0-only
  (suite-pinned both arms). Level-0-only writes into chain arrays are refused LOUDLY.
  Read-verified three-r184 upload cost documented: `layerUpdates` clears after mip 0,
  so chain-bucket layer writes upload full-depth at levels 1+ (~⅓ of array bytes/write)
  — correct output, counted class, restructured by ST9's P4 staging.
- **×1.5 growth** — **MET.** `_atlasGrowTargetFor` steps `ceil(a×1.5)` under the flag
  (M6-bounded, swept 1..128 in the suite); OFF arm keeps the X7 doubling verbatim.
- **Worker-NRA** — **MET (E3 parity DEFERRED-TO-BATCH).** `want.nra:"half"` on lane-T
  transcodes (T14's landed, golden-pinned derive); packed plane → RGB8 normal with z
  reconstruction → adapter texture → material + variant clones; FIFO-fallback arm has
  no NRA (counted; recorded D5).
- **Rehydrate v3 + mirror policy** — **PARTIAL (honest).** Landed: the D-05.7
  "full-tier mirror ≡ record-cache entry" identity (lane-T records adopt into the
  128 MB-budgeted cache; `dropRecord` on demote), previews pack-resident + retained
  per-DID, `texture_release.js`/`texFreeCpu` re-scoped to the legacy-RGBA8 residue
  (S7.3). NOT landed: terrain mirrors freed post-upload (−88 MiB), the source-keyed
  rehydrator table rows for re-fetch→re-transcode restore. Named remainder.
- **Terrain tier ladder wiring** — **NOT LANDED (named remainder).** The t128 slices
  are controller-fetched + retained (T12's `getT128Slice`) and slice packs now register
  their PVW payloads on admission, but `terrain_bc7.js` still boots its own t1024 path;
  `?terrainT1024=eager|defer|off` does not exist yet. B4a/B4b scoring is unaffected at
  this stage (binds ST6+ with the ladder).
- **128 MB record budget** — **MET.** Default halves under the flag; explicit
  `?bc7RecordsMB` grammar unchanged; suite-pinned.
- **Demote-to-preview primitive** — **MET.** `MaterialCache.demoteToPreview(did)`:
  preview re-pointed (clone/alias walk shared with the upgrade), full texture disposed,
  record dropped, idempotent, counted. Pressure-ladder WIRING is pass-6/H-05.1 scope
  (T20's ladder rungs are the caller; an orchestrator-sequenced one-liner when GATE-TEX
  approaches).
- **GATE-TEX (E2 + E3 CLEAN; M4/M5/M6; B1 absolute; C4; frame-1-white)** —
  **DEFERRED-TO-BATCH.** All are 1070/browser items (Batch B; T31's two GATE-TEX bench
  riders can now be filled in — the arm is `?packSource=on&texCompressedOnly=on` vs
  legacy on the full-world dist). No browser was launched this session (task directive:
  sibling T00 owns the box's chromium + RAM).
- **Flag lifecycle (I7)** — **MET.** DEFAULT OFF, EXACT-MATCH opt-in, requires
  `?packSource` structurally (the active gate); OFF arm proven byte-identical at the
  behavioral level: the branch is unreachable (suite-pinned legacy routing), atlas
  allocations/keys/growth byte-identical (suite + `test_static_atlas_growth.mjs` 73/73
  + `test_atlas_bc7_pre_gate.mjs` green), and every neighboring texture-family suite
  passes unmodified. `lint-url-flags --strict` adds 0 findings; `audit-flag-defaults`
  exit 0.

## Deviations

- **D1 — DEVIATION: pass 5 D-05.5.1 ("scalars-only form … translucency/luminosity/
  diffuse/palette flags") because** (read-verified) `hasPalette` derives from the 0x06
  RenderSurface header (`tex.format().needs_palette()`, lib.rs — the record class ST5
  deliberately leaves unpacked and unfetched) and `category` from pixel statistics
  (`compute_stats(&pixels …)` → `classify`) — neither exists without the pixels this
  path exists to not decode. Minimal sound thing: `hasPalette: undefined` (the JS
  decoder's DOCUMENTED stale-pkg fail-soft — alpha-test ref 0.5, between the paletted
  0.39 and DDS 0.78 refs; visible only on clipmap cutout edges, E2-eye-gated), and
  category from the DID-keyed `surface_overrides.json` else Generic (the decoder's
  documented "no opinion" arm). Named successor for the orchestrator: TEXREF
  `tier_bits` bits 5–7 are reserved — a bake-side palettedness/class bit closes both
  gaps at the next full-world bake with zero wire cost.
- **D2 — DEVIATION: pass 5 D-05.5.4 ("missing preview … placeholder material, never a
  silent RGBA8 fallback") because** at T15 the residency guarantee that rule assumes
  (pass 3 S1.4 "packs for the ring are resident before materials build") is provided by
  ST7's event-driven feeds, not by today's legacy build timing — materials build the
  moment an LB streams, racing the PVW-REGIONAL lane-R fetch. A placeholder here would
  trade correct pixels for policy mid-migration. Minimal sound thing: legacy-route +
  count (`__texStats().coverage.texrefMissingPvw`) + once-per-rsId warn. The counter
  still surfaces true bake-coverage defects (the bake guarantees `texrefMissingPvw = 0`
  once carriers are resident); the strict placeholder rule binds when `?slotGrid` feeds
  drive builds. Suite-pinned.
- **D3 — DEVIATION: SPEC §1.1 "full-tier textures stay per-record CAS files" as the
  lane-T substrate because** (verified) the canonical dist ships NO per-record texture
  CAS tier — full-tier xu7 records live in the legacy shard CAS
  (`shards/{p2}/{sha256}.bin`) addressed by the `holtburger/tex-xu7` catalog
  (pass 2 D-02.1's own words: "per-record content-addressed files, **exactly as
  today**"). Minimal sound thing: `xu7_cas_info` renders the shard-CAS URL + trunc-16
  sha from the catalog and lane T fetches THAT, hash-verified — same bytes, full lane
  discipline. A dedicated `tex/` tier is a bake-side rename, not a client change.
- **D4 — sub-spec note:** `transcodeXu7WithNra` uses a BOUNDED ready-wait (10 s [A])
  on the texture worker instead of the hot path's ask-don't-await: lane-T upgrades are
  background work, and the FIFO fallback both costs main-thread ms and cannot produce
  the NRA rider. The hot record path (`transcodeXu7`) is untouched.
- **D5 — sub-spec notes:** (a) the FIFO fallback arm produces no NRA plane (counted
  `fifoFallbacks`; the surface keeps flat shading until a later demote/upgrade cycle);
  (b) animated SurfaceTextures keep today's RGBA frame machinery over the preview base
  (motion beats purity during migration); (c) the bake-worker feed path
  (`_installFromPixels`) still pays the worker-side RGBA8 decode whose output the
  compressed build then ignores — retiring that decode is the ST7-lease/ST9 consumer
  swap, not a texture-path change; (d) TEXREF `dims` is surfaced (`pack_texref`) but
  bucket identity still derives from `map` dims — correctness-neutral under
  preview-commit + re-home (the full payload is resident at re-home time), and the
  TEXREF-keyed form belongs to the ST9 class-key material tier.

## Tests run

Rust via `capped-build` (rust-analyzer killed first, I5), node direct, NO browser
(task directive: RAM + the sibling's chromium). No @scale-tagged perf figures claimed —
all counter values are correctness reads.

```
capped-build cargo test -p holtburger-resource-http            24 passed, 0 failed
                                                               (incl. NEW pvw_and_texref_register_and_evict)
capped-build cargo test -p holtburger-resource-http --release \
    --test pack_source_region -- --ignored --nocapture         3/3 — 56 packs admitted, 7,228 records
                                                               BYTE-IDENTICAL to base DATs, composite
                                                               pack-first (unchanged from T12's record,
                                                               now WITH PVW/TEXREF registration live)
                                                               @scale: T10 bounded region
capped-build cargo check -p holtburger-web --target wasm32-unknown-unknown   clean
capped-build wasm-pack build --target web --out-dir pkg-t15 --release        ok (5m39s); 6,334,666 B (release-class);
    rsync -a --delete pkg-t15/ pkg/; surface_meta_sync / xu7_cas_info /
    pack_pvw_blocks / pack_texref verified present in pkg/holtburger_web.d.ts;
    pre-T15 release wasm backed up to the session scratchpad (one session)
node harness/test_tex_compressed_only.mjs      84 passed, 0 failed   TEX-COMPRESSED-ONLY ✅ (NEW)
node harness/test_diag_schema.mjs              66 passed, 0 failed   (21 surfaces; __texStats landed current)
node harness/test_report_v2.mjs                REPORT-V2 ✅
node harness/test_console_allowlist.mjs        CONSOLE-ALLOWLIST ✅
node test_xu7_budget.mjs                       49/0   (FIFO arm verbatim)
node harness/test_texture_worker.mjs           69/0   (T14 arm untouched)
node harness/test_nra_derive.mjs               41/0
node test_bc7_record_budget.mjs                23/0
node test_static_atlas_growth.mjs              73/0   (OFF-arm growth byte-identical)
node test_atlas_bc7_pre_gate.mjs               ALL PASS
node test_mat_budget_lru.mjs                   123/0
node test_texture_rehydrate.mjs                56/0
node test_texture_census.mjs                   44/0
node test_stat_array_merge.mjs                 115/0
node test_materials_paletted_lru.mjs           28/28  (after the stub-map additions)
node test_paletted_dedup.mjs 41/41 · test_visfid_p33_csm 30/30 ·
     test_visfid_p02 PASS · test_visfid_p11 18/0
node test_terrain_bc7_aniso.mjs                ALL PASS (terrain untouched)
node test_xu7_transcode.mjs                    ALL PASS
node harness/test_pack_fetch_controller.mjs    92/0 · test_pack_fetch_region.mjs 22/0
     (46 req / 6.33 MiB — byte-identical to the T12/T20 record)
node scripts/lint-url-flags.mjs --strict       exit 1 PRE-EXISTING (fogRingCap,
                                               stableDepthShare presence-guards only; T15 adds 0)
node scripts/audit-flag-defaults.mjs --mismatch  exit 0 (both new rows agree with readers)
```

## Handoffs & risks

- **Named remainder 1 — terrain tier ladder (t128 → converged → deferred t1024,
  `?terrainT1024`).** Everything upstream is in place: the controller fetches +
  retains both t128 slices (T12), slice packs (kinds 6/7) register their PVW payloads
  at admission (this task), and the worker assembles arrays off-thread (T14). The
  remaining work is `terrain_bc7.js` consumer surgery: build the 128² pair from
  `pack_pvw_blocks`/`getT128Slice` at boot, stamp terrain-converged at t128, stream
  the t1024 pair per-payload on lane T behind `?terrainT1024=eager|defer|off`
  (default `defer`), wholesale-swap under the existing all-or-nothing rule. B1's
  terrain component and B4a scoring want this before GATE-TEX absolutes are read.
- **Named remainder 2 — rehydrate-v3 completion.** Terrain mirror freeing post-upload
  (−88 MiB) + the source-keyed rehydrator rows (re-fetch → worker re-transcode
  restore for demote-evicted fulls under context loss). The demote primitive and the
  record-cache-≡-mirror identity are in; the release-seam generalization is not.
- **Pressure-ladder wiring (H-05.1):** `demoteToPreview` is the primitive; wiring it
  as the texture rung of T20's ladder (R1 demote-first) is a small
  orchestrator-sequenced change touching `residency_grid.js`'s rung actions — kept
  out of this landing to avoid touching T20's live-verified arm without its battery.
- **Batch B (T31) is now fillable:** the two GATE-TEX bench riders T31 left null get
  `?packSource=on&texCompressedOnly=on&texWorkers=on` vs legacy arms on the
  full-world dist; E2 vantages should include clipmap-foliage edges (D1's 0.5
  alpha-ref) and a category-sensitive material set (D1's Generic fallback); E3 is the
  half-res worker-NRA parity item. Frame-1-white zero-tolerance = a boot capture on
  the ON arm with `texrefMissingPvw` and `chainWriteRejects` both 0.
- **Orchestrator notes:** (1) D1's named successor — reserve TEXREF tier_bits bit 5
  for palettedness (+ optionally a class nibble) at the next full-world bake;
  (2) D3 — if a dedicated `tex/` CAS tier is wanted, it is a bake/dist rename with a
  `tex_url_template` manifest field, client-side is one URL join; (3) the
  `?texWorkers` soft-dep is real on the ON arm (FIFO fallback = no NRA) — consider
  gating the texCompressedOnly default flip on texWorkers' flip; (4) kill-cascade:
  a `?packSource` kill must force this flag OFF loudly (F-11.3) — the active-gate
  already disarms it structurally (controller unarmed ⇒ inactive), but the loud
  in-session log line lands with the cascade wiring at ST9.
- **Risk — chain-bucket upload cost (read-verified three r184):** layer writes into
  chain buckets upload full-depth at mips 1+ (~⅓ of array bytes per write; the
  `layerUpdates` set is cleared after mip 0). Bounded, documented at both sites,
  and restructured by ST9's P4 `initTexture` staging; if a soak attributes real
  cost, the escape is committing chain buckets only at re-home time (one write per
  layer lifetime).
- **Risk — `_rsMembers` node retention:** a preview-committed node whose upgrade
  fails stays tracked (node + CPU geometry attributes) until its LB evicts. Counted
  via `fullFailed`; bounded by LB churn.
- **pkg/ backup:** pre-T15 release wasm at the session scratchpad `pkg-backup/` for
  one session.
- **Unrelated dirty state:** none staged; `Cargo.lock` unchanged (no new deps).
