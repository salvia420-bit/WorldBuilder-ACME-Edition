# T15-REMAINDER (T15R) — ST5 staged remainder: rehydrate-v3 completion, the
# full-tier upgrade path, and the default-arm texture-tier question

Agent: T15R implementation agent. Date: 2026-08-10. Scope worked:
`scene3d/bc7_textures.js`, `scene3d/materials.js` (texture sections),
`harness/test_tex_compressed_only.mjs`, `harness/lib/{scene3d_stubs,diag_schema}.mjs`.
**`index.html` was NOT touched** (no texture-lane wiring hunk was needed — the
arming block landed at T15 and carries every export this pass calls). No Rust
change was needed, so `pkg/` is unchanged: the resident wasm is still the T13/T15
release artifact, 6,404,273 B (`ls -la pkg/*.wasm`) — release-class, verified, NOT
rebuilt (nothing in `src/` changed).

## Shipped

| commit | what |
|---|---|
| `04806ad6` | **rehydrate-v3 full-tier mirror seam + the demote rung.** `bc7_textures.js`: `registerFullTierMirror` / `releaseFullTierMirror` / `unregisterFullTierMirror` / `fullTierMirrorStats` / `_resetFullTierMirrorsForTest`; `_trimToBudget` releases the mirror when it evicts a full record; `__texStats().mirrors.release` counters. `materials.js`: `_fetchFullTierParsed` extracted verbatim from `_upgradeCompressedFull` (one source path shared by the upgrade AND the rehydrator — this is what makes rehydrate v3 *source*-keyed), mirror arming at upgrade, unregistration at demote and at material eviction, and `demoteFullTierUnderPressure({bytes,max})` (the H-05.1 R1 texture rung). Battery 84 → 112 checks; registry rows + stub map + re-pinned evidence lines. |
| `10e685f4` | **Fixup:** the rehydrator used the captured texture instead of the registry's `t` argument, which would have pinned the texture through the strongly-held callback and defeated both WeakRef layers. |

## The default-arm question (the orchestrator's gating item)

**Answer: there is no missing full-res tier on the `?packSource=on` /
`texCompressedOnly` OFF arm. The `fullSwaps = 0` reading is a counter-naming
artifact, and the capture that produced it also proves the legacy full-tier
upgrade ran 306 times in that same session.**

Read-verified chain:

1. `fullSwaps`, `pvwBuilds`, `fullFailed`, `demotions`, `nraAttached` are **ST5-only**
   counters. Every `_bumpBc7Stat` for them lives inside `_tryCompressedOnlyBuild` /
   `_upgradeCompressedFull` / `demoteToPreview` (`scene3d/materials.js:5821, 5876,
   5900, 5987`), all of which are reachable only through the two
   `texCompressedOnlyActive()` gates in `materials.js:4791` and `:5455`. With
   `?texCompressedOnly` absent the branch is unreachable, so those five counters are
   **structurally 0**. That is I7's OFF-arm-identical property working, not a defect.
2. The LEGACY full-tier upgrade counts on a **different** counter. In
   `upgradeMaterialToBc7` (`scene3d/bc7_textures.js:1121-1211`) the pre phase bumps
   `preSwaps` and the FULL phase bumps `singletonUpgrades`
   (`bc7_textures.js:1146-1147`).
3. The 1070 capture
   (`/tmp/claude-1000/…/b1070/texdiag-on.json`) reads:
   `preSwaps 235`, **`singletonUpgrades 306`**, `fetches 321`, `hits 291`,
   `absent 30`, `bytesFetched 112,191,340`, `inflight 0`, `records.bytes 186,595,544`,
   `records.budget 268,435,456`. 112 MB / 321 records ≈ 349 KB per record — full-tier
   size (SPEC §1.1 median 242 KB), not preview size (a 128² BC7 level-0 is 16 KB).
   `budget 256 MB` independently confirms `texCompressedOnlyEnabled()` was false
   (`bc7RecordBudgetBytes`, `bc7_textures.js:685`, halves to 128 MB under the flag).
   So: 306 surfaces reached the full tier and nothing was still in flight at settle.
4. Packs cannot substitute preview bytes for full ones on that arm either: PVW
   payloads register into a **separate** map (`pack.rs` `inner.pvw`, accessor
   `pvw_payload()` / export `pack_pvw_blocks`) and are never inserted into the record
   streams `ResourceSource::get` reads — read-verified in
   `crates/holtburger-resource-http/src/pack.rs:740-760, 990-1000`.

**So the E1 texture comparison does not need to wait on a missing upgrade stage.**
What remains is a *softness* observation that the counters do not explain, and I did
not have an OFF-arm `__bc7Stats` capture to compare against. Two read-verified
candidate mechanisms, in the order I would test them:

- **C1 — the atlas-deferral population (arm-dependent, therefore the ON/OFF
  candidate).** `static_atlas.js:1534` holds a node out of the atlas for the whole
  LB residency whenever its BC7 verdict is in flight (`bc7PendingOn`), and on the
  legacy arm those hold-outs are **untracked** — `_rsMembers` tracking and the
  `atlasRefeed` re-home are `texCompressedOnlyActive()`-gated
  (`static_atlas.js:1539-1547`). A held-out prop renders as an unbatched singleton
  off `mat.map`: a **full mip chain with `anisotropy` left at three's default 1**
  (`makeBc7Texture` only applies `opts.anisotropy`, and `upgradeMaterialToBc7`'s
  `buildAndSwap` passes only wrap/colorSpace — `bc7_textures.js:1136-1149`). An
  atlas-committed prop on that same arm samples a **level-0-only array** (no mips,
  `LinearFilter`, `bc7_textures.js:460`). Those two render *visibly differently* at
  grazing angles: trilinear-without-aniso reads soft, no-mips reads crisp. Packs
  deliver world data far sooner than the per-record lane while the full-tier texture
  records still arrive on the legacy shard-CAS lane, so the ON arm's LB feeds run
  earlier relative to texture verdicts and the hold-out population grows. The 1070
  capture's `deferredNodes = 398` is that population; without an OFF-arm number it is
  a strong hypothesis, not a proven delta.
- **C2 — the anisotropy drop on every BC7 albedo swap (arm-INDEPENDENT).** The RGBA8
  albedo the swap replaces carries the adapter's `_maxAnisotropy` (4 at quality mid,
  16 at high/ultra — `adapter.js:1134`, `index.js:1228-1234`); the BC7 replacement
  gets 1. This is a real fidelity loss and a plausible reason the whole ON/OFF pair
  looked softer than memory of the pre-BC7 client, but because it fires identically
  on both arms it **cannot** be the ON-vs-OFF delta. I did NOT fix it: it would change
  the legacy path, i.e. exactly the byte-identical OFF arm I7 protects, so the
  one-line fix (`buildAndSwap` → `{ …, anisotropy: getAdapterMaxAnisotropy() }`) is an
  orchestrator flag-lifecycle call, not mine. (`?texCompressedOnly=on` already sets
  aniso on both the preview and the full texture — `materials.js:5784, 5890.`)

**Recommendation to the orchestrator:** re-run the E1 texture pair, and add
`&texCompressedOnly=on&texWorkers=on` to the ON arm (or run it as a third arm) —
that is the arm where the preview-commit + `atlasRefeed` re-home + full-chain+aniso
arrays close C1 by construction. Capture `__bc7Stats().deferredNodes` and
`singletonUpgrades` on BOTH arms; a deferral delta is the C1 confirmation and costs
nothing extra.

## Spec conformance (SPEC §3 T15 remainder bullets only — the rest are T15's report)

- **Rehydrate v3 + mirror policy (D-05.7)** — **row 2 MET, row 3 MET-by-policy, row 1
  DEFERRED.**
  - *Row 2, full-tier singleton `CompressedTexture`* — MET. "Mirror ≡ the record-cache
    entry … freed **with** record eviction via the release seam" now holds
    mechanically: `_trimToBudget` calls `releaseFullTierMirror(id)`, which registers
    a source-keyed rehydrator (re-fetch the xu7 CAS → worker re-transcode, the same
    `_fetchFullTierParsed` the upgrade uses) and then empties the mip levels. Before
    this, eviction dropped the map entry while the live texture still held the same
    `ArrayBuffer` through its subarrays, so the 128 MB budget freed nothing.
  - *Row 3, previews* — MET as specified: "mirror KEPT" ⇒ no release, no registration,
    and three's own restore path re-uploads from the retained levels. Recorded here
    because "no code" is a decision, not an omission.
  - *Row 1, terrain arrays freed post-upload (−88 MiB)* — **NOT LANDED**, see
    Deviations D1 (out of assigned file scope; same owner as the terrain ladder).
- **Terrain tier ladder (`?terrainT1024`)** — **NOT LANDED, still queued.** Deviation
  D1. The remaining work is `terrain_bc7.js` consumer surgery (T15's own handoff says
  so), and `terrain_bc7.js` is outside the file scope this task was given.
- **Full-tier upgrade path produces `fullSwaps > 0`** — **MET (node-proven), live arm
  DEFERRED-TO-BATCH.** The path was already wired at T15; this task pinned it harder
  and proved the deployed dist can drive it: the v3 pack layer's TEXREF rows carry the
  `FULL_XU7_PRESENT` bit (`pack_bake.rs:856`, gated on `xu7_present(--tex-xu7 …)`;
  the deployed bake was run with `tex-xu7 /mnt/wbterminal2/xu7-ingest`, 3,985 `.ktx2`
  files vs 3,471 TEXREF rows, per `dist/bake-source-packs.sha256` +
  `dist/pack-report.json` `texref_rows 3471`, `texref_missing_pvw 0`). So
  `__texFullPending` is set for the world-texture population and `_upgradeCompressedFull`
  fires. Battery PART 7 asserts `fullSwaps === 1` on the ON arm and PART 8 asserts a
  two-surface population; a live 1070 `fullSwaps > 0` reading stays a GATE-TEX/Batch-B
  item (I9 — no browser number is claimed here beyond what is in *Tests run*).
- **Demote / pressure interplay** — **MET on the texture lane.**
  `demoteFullTierUnderPressure({bytes,max})` walks upgrade-oldest-first and stops on a
  byte or count target; every step is `demoteToPreview` (correct pixels at preview
  sharpness, never blackness — D-05.8). The residency ladder's rung action remains a
  one-liner in `residency_grid.js` (T20's scope, deliberately untouched — same
  reasoning T15 gave).
- **Flag lifecycle (I7)** — **MET.** No flag was added, no default flipped. Everything
  new is reachable only from `_upgradeCompressedFull` / `demoteToPreview` (both
  `texCompressedOnlyActive()`-gated) or from `_trimToBudget`'s
  `if (isFull && _fullMirrors.size > 0)` guard, which is a `size` read on an arm where
  nothing arms a mirror. Suite-pinned: PART 8's OFF-arm leg drives a real
  `Bc7RecordSource` over its budget and asserts eviction behaves as before with
  `mirrorsFreed = 0` and `releasedTextureCount() = 0`.

## Deviations

- **D1 — DEVIATION: SPEC §3 T15 "terrain tier ladder wiring (t128 → converged →
  deferred t1024)" and D-05.7 row 1 (terrain mirrors freed post-upload) are NOT in
  this landing, because** both are `scene3d/terrain_bc7.js` consumer surgery
  (read-verified: `terrain_bc7.js:107-231` still owns tier order, tier-aware aniso and
  the t1024-first boot; `TERRAIN_BC7_TIERS = ["t1024","t512"]` at `:120`), and
  `terrain_bc7.js` is outside the file scope this task was assigned (bc7_textures.js /
  xu7_textures.js / materials.js texture sections / src / harness / index.html
  texture-lane wiring). Freeing the terrain mirrors is not separable from the ladder
  either — the −88 MiB is bought by the assemble path the ladder rewrites. Recorded as
  STILL QUEUED, unchanged in substance from T15's "Named remainder 1", with T15's
  entire upstream still in place (controller-fetched t128 slices, PVW registration for
  slice packs, worker-side assembly). It binds B4a/B1's terrain component at ST6, not
  before, so nothing downstream of this task is blocked by the deferral.
- **D2 — sub-spec note: the release is POST-UPLOAD-only.** D-05.7 does not say when a
  mirror may be dropped; releasing before three has uploaded would upload nothing.
  `registerFullTierMirror` installs the same chained `onUpdate` watcher
  `texture_release.js:109-114` uses and `releaseFullTierMirror` refuses (counted
  `mirrorReleaseDeferred`, never silent) until it has fired. An eviction that hits a
  not-yet-uploaded texture therefore keeps its bytes — correct, and visible.
- **D3 — sub-spec note: `image.data = null` on release.** `textureHasPixels`
  (`texture_rehydrate.js:258-277`) checks `tex.image` FIRST and treats an object with
  no `data` KEY as element-backed ("canvas/ImageBitmap carry their own pixels"). A
  compressed texture's `image` is the bare `{width,height}` descriptor
  `makeBc7Texture` builds, so a released mirror would have reported pixels it did not
  have and **every restore pass would have skipped it** — a black surface after a
  context loss, produced by the guard meant to prevent one. Declaring the key routes
  the predicate to `mipmaps`, where a compressed texture's bytes actually live. Found
  by the battery (the check failed before the fix), not by reading.
- **D4 — probe account: `agentp09`, not the `agentp07` named in the task.** A sibling
  agent's chromium (`/tmp/mbfix-profile`, CDP 9333, `harness/moving-bench.mjs` in-flight)
  was live on this box and its harness defaults to `agentp07`; one ACE account is one
  session, so sharing it would have produced exactly the `[character-error] Logon`
  latch that killed my first boot attempt. `agentp09` exists with one character
  (`ace_auth.account` × `ace_shard.character`, read-only query). Same class of account,
  no other change.

## Tests run

Node direct; ONE headless chromium (SwiftShader, `--use-gl=swiftshader`), single page,
sequential. No Rust build (nothing in `src/` changed — `pkg/` untouched at
6,404,273 B release).

```
node harness/test_tex_compressed_only.mjs   112 passed, 0 failed  (was 84 — PART 8 new)
node harness/test_diag_schema.mjs            67 passed, 0 failed  (21 surfaces)
node harness/test_report_v2.mjs              REPORT-V2 ✅
node harness/test_console_allowlist.mjs      CONSOLE-ALLOWLIST ✅
node test_texture_rehydrate.mjs              56 passed / 0 failed
node test_bc7_record_budget.mjs              23 passed / 0 failed
node test_static_atlas_growth.mjs            73 passed / 0 failed
node test_mat_budget_lru.mjs                 123 passed / 0 failed
node test_texture_census.mjs                 44 passed / 0 failed
node harness/test_texture_worker.mjs         69 passed / 0 failed
node harness/test_nra_derive.mjs             41 passed / 0 failed
node test_xu7_budget.mjs                     49 passed / 0 failed
node test_materials_paletted_lru.mjs         28/28   (after the stub-map addition)
node test_paletted_dedup.mjs                 41/41
node test_atlas_bc7_pre_gate.mjs             ALL PASS
node test_xu7_transcode.mjs                  ALL PASS
node test_terrain_bc7_aniso.mjs              ALL PASS   (terrain untouched)
node scripts/lint-url-flags.mjs --strict     exit 1 PRE-EXISTING (fogRingCap,
                                             stableDepthShare presence-guards; T15R adds 0 rows,
                                             0 findings — no new flag)
node scripts/audit-flag-defaults.mjs --mismatch   exit 0
```

PART 8's new checks, for the record: mirror arming at upgrade · post-upload refusal
(counted) · register-before-release ordering · descriptor survival across a release ·
`textureHasPixels` reads false after one · a REAL restore pass that re-fires the lane-T
`need` and re-adopts the record · record eviction driving the release · the demote
rung's oldest-first order, byte target and count cap · mirror unregistration with the
disposed texture · and the OFF-arm identity (real `Bc7RecordSource` evicted over budget:
`mirrorsFreed 0`, `releasedTextureCount 0`, registry empty).

@scale SwiftShader/T2, single boot, packs arm (`?packSource=on&geomBundles=on`,
`agentp09`, Holtburg): see *Live probe* below. No frame/perf figure is claimed from
this box (PR-1: T2 is functional-only).

### Live probe (T2, SwiftShader) — the atlas hold-out class, observed

ONE local headless chromium, `?nosw=1&netDrainHz=30&agent=1&autoLogin=1&
account=agentp09&autoSpawn=first&packSource=on&geomBundles=on`, `@telepoi Holtburg`,
120 s settle, full render (no `nullRender`). Script + raw logs:
`<session scratchpad>/texarm.mjs`, `arm-packs.log`.

```
settle+30s  {pre 0,  full 0, deferredNodes 65, fetches 31, inflight 28}
settle+60s  {pre 0,  full 0, deferredNodes 85, fetches 65, inflight 62}
settle+120s {pre 14, full 0, deferredNodes 85, fetches 75, inflight 69}
__atlasStats: feeds 2 · nodesIn 85 · atlased 0 · ptBc7Deferred 85 ·
              ptFullHoldout 0 · refeeds 0 · bucketCount 0
__hbFetch/verify: 0 mismatch, 0 quarantines, 0 console errors
```

**What this shows and what it does not.** It shows the C1 *mechanism* live and
unambiguously: with packs on, **every** static node the atlas was fed (85/85) was held
out because its BC7 verdict was still in flight, and because `texCompressedOnly` was
OFF the hold-outs were untracked (`ptFullHoldout 0`, `refeeds 0`) — they only ever
re-enter the atlas if their LB re-streams. It does NOT establish the ON-vs-OFF *delta*:
this box is two orders slower on the texture lane than the 1070 (nothing had converged
at settle — `inflight 69`, `hits 0`), and the legacy comparison arm never reached
in-world inside its boot budget (the per-record legacy boot blocks the main thread hard
enough on SwiftShader that `page.evaluate` stopped answering; killed and not retried,
per the one-chromium/RAM rule). The delta belongs on the 1070, where it is one extra
counter read on each of the E1 arms.

A third arm (`&texCompressedOnly=on&texWorkers=on`, 240 s settle) was attempted for a
LIVE `fullSwaps > 0`. It booted on its second attempt (first attempt latched
`bootState=error` with zero console errors — the stale-ACE-session class) and reported
two windows

```
settle+30s {pre 0, full 0, deferredNodes 65, fetches 28, inflight 28}
settle+60s {pre 0, full 0, deferredNodes 83, fetches 61, inflight 61}
```

before `page.evaluate` stopped answering under the box's load and the run was killed
(the probe prints only pre/full/deferred/fetch/inflight per window, so these say
nothing about `pvwBuilds` or `active`).
**No `fullSwaps` reading is claimed from it (I9).** One thing that interim window does
NOT settle and that the 1070 run should check explicitly: `__texStats().active` — 65
deferrals on an armed ST5 arm would be unexpected (preview-born materials commit at
frame 1), so either the path had not armed yet for those early feeds, or those surfaces
legacy-routed on the documented D2 "PVW carrier still in flight" path. Both are
existing, counted behaviours (`coverage.texrefMissingPvw`, `tiers.pvwHits`), and both
are one read away on a box that can settle.

## Handoffs & risks

- **Still queued (unchanged owner class): the terrain tier ladder + terrain mirror
  freeing.** D1. Everything upstream stands; the work is `terrain_bc7.js`. Give it to
  an agent whose scope includes that file; it wants the same pass as D-05.7 row 1.
- **The E1 texture re-run should carry a THIRD arm.** `?packSource=on&geomBundles=on`
  vs the same **plus** `&texCompressedOnly=on&texWorkers=on` vs legacy. C1 above says
  the ST5 arm is where the hold-out class disappears; if the ST5 arm reads sharp and
  the packs-only arm reads soft, C1 is confirmed and the finding closes as "ST2/ST3
  carry a texture-timing artifact that ST5 removes by construction".
- **C2 (aniso 1 on every legacy BC7 swap) is an orchestrator decision.** One line, real
  fidelity, but it changes the arm I7 says must stay byte-identical. If it is wanted
  before ST5's default flip it needs its own flag row and a lint/audit pass.
- **`mirrors.release.restoreFailed` is the new must-stay-0 counter.** A released
  full-tier mirror whose rehydrator misses is a black surface after a context loss.
  It is registry-declared and surfaced on `__texStats()`; add it to the GATE-TEX
  M5/context-loss checklist alongside `texrefMissingPvw` and `chainWriteRejects`.
- **Pressure-ladder wiring is now a genuine one-liner.** `residency_grid.js`'s R1 rung
  calls `materialCache.demoteFullTierUnderPressure({ bytes, max })`. Still T20's file,
  still deliberately untouched.
- **Unrelated dirty state (I6, staged-out, NOT committed):**
  `apps/holtburger-web/harness/moving-bench.mjs` (modified) and
  `apps/holtburger-web/harness/test_moving_bench_boot.mjs` (untracked) — a sibling
  agent's in-flight MOVE-FIX boot-gate work. Left alone.
