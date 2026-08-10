# T15R-TERRAIN — the ST5 terrain tier ladder (`?terrainT1024`) and terrain
# CPU-mirror freeing (the T15/T15R named remainder)

Agent: T15R-TERRAIN implementation agent. Date: 2026-08-10. Scope worked:
`scene3d/terrain_bc7.js`, new `harness/test_terrain_tier_ladder.mjs`,
`harness/lib/diag_schema.mjs` (the `__terrainBc7Stats` row only),
`docs/url-flags.md` (two `terrainT1024` rows). **No other file was touched** —
in particular `bc7_textures.js`, `materials.js`, `static_atlas.js`,
`index.html`, `terrain.js`, `pool_registry.js` and `harness/moving-bench.mjs`
are untouched (`git show --stat` on the landing commit is the proof). No Rust
change, so `pkg/` is unchanged: still the T13/T15 release artifact,
6,404,273 B (`ls -la pkg/*.wasm`) — release-class, NOT rebuilt.

## Shipped

| commit | what |
|---|---|
| `<commit-1>` | **The tier ladder + terrain mirror freeing.** `terrain_bc7.js`: `terrainT1024Mode`/`terrainLadderArmed` (4-state reader), `parseTerrainSlicePack` (HBP1 → PVW reader for the D-12.6 boot slice), t128 channel assembly, the wholesale in-place swap, `initTexture` staging, `promoteTerrainT1024Now`, `demoteTerrainUnderPressure`, source-keyed mirror release/rehydrate, `initTerrainTierLadder`, `_stats.ladder` counters; the level-major concatenation factored to `_mipsFromChannel`/`_mipsFromAssembled`/`_assembleChannelMips` (behaviour-identical, suite-pinned). New 105-check battery `harness/test_terrain_tier_ladder.mjs`. Registry rows for `__terrainBc7Stats().ladder.*`; both `terrainT1024` rows in `docs/url-flags.md`. |

## What the ladder is, in one paragraph

With `?terrainT1024` present, `buildTerrainBc7Atlas` builds the 33-layer pair
at **128²** out of the two `terrain-t128-{color,nra}` slice packs the pack
controller already fetches on lane B (D-12.6: ONE CAS file per channel, 29
deduped HBC7 payloads × 21,892 B = 0.63 MB wire each), so **terrain converges
at t128** and the full tier leaves the converged wave. The promotion is
**wholesale and in place**: the same two `CompressedArrayTexture` OBJECTS are
disposed, re-mipped, re-`image`d and re-`needsUpdate`ed, then staged with
`renderer.initTexture` — colour and nra on separate frames. Because the
objects survive, every landblock material's `uAtlas`/`uAtlasNormalAo` uniform
stays valid and **no consumer file needed a line of change** (that is why this
landing does not touch `terrain.js`). After the upload, each array's CPU
mirror is FREED with its way back registered first. Under pressure,
`demoteTerrainUnderPressure` swaps back to the retained t128 mip sets with no
fetch.

Two read-verified facts make the in-place swap legal, and both were checked in
the vendored three r184 this session:

- `resolveTerrainRingOpts` consumes only `atlasTexture` / `nraTexture` from the
  returned atlas (`terrain.js:3983-3991`, `:4092-4093`, uniform at `:5612`) and
  never reads `tileSize`/`levels`; nothing re-sets `needsUpdate` or
  `anisotropy` on the BC7 arrays afterwards (the only such lines,
  `terrain.js:4082-4083`, are on the RGBA8 twin that `:4092` disposes, and
  `adapter.js:52-54` states there is "no retroactive sweep").
- `dispose()` drops three's per-texture properties
  (`three.module.js:11350-11386`), so the next `uploadTexture` takes
  `forceUpload` ⇒ `allocateMemory` ⇒ a fresh `texStorage3D` at
  `mipmaps[0].width/height, image.depth` (`:12026-12034`), and `onUpdate`
  fires at the end of every upload branch (`:12378`). `image` is a
  getter/setter over `source.data` (`three.core.js:7625-7633`), so re-`image`ing
  is the supported way to re-spec the descriptor.

## Spec conformance (SPEC §3 T15's two remainder bullets)

- **Terrain tier ladder wiring (t128 → converged → deferred t1024 per §0.2.1)**
  — **MET, behind `?terrainT1024`, DEFAULT OFF.**
  - t128 boot from the D-12.6 slice: MET and **live-proven on the deployed
    dist** — `__hbFetch.byComponent.terrainTier = {requests: 2, bytes:
    1,270,680}` (exactly the two 635,340 B slice packs, i.e. D-12.6's "+2 boot
    requests"), `ladder.sliceSource = "pack"`, 33 layers @ 128px, 8 levels.
  - "converged stamps with terrain at t128": MET in the sense this task can
    deliver — the ladder holds terrain at t128 and does not fetch the full
    tier until the converged signal. **Nothing in the client stamps
    `convergedMs`** (read-verified: `pack_fetch_controller.js` sets
    `inWorldMs` :666 and `previewCompleteMs` :779-780 only; the field exists at
    :287 and is null by construction), so `defer` uses
    `convergedMs ?? previewCompleteMs` + a 2 s settle, with a 30 s ceiling.
    Recorded as **DEVIATION D2**.
  - post-converged wholesale swap: MET, live-proven (t128 → t512 promotion,
    both arrays, 0 console errors).
  - `?terrainT1024=eager|defer|off` grammar: MET, with the ABSENT state added
    as the legacy/kill path — **DEVIATION D1**.
  - "assembly runs in the texture worker": MET for the full tier (the
    promotion goes through the unchanged ST4 `_assembleChannelMips` seam, so
    `?texWorkers=on` moves it off-thread). The **t128** assembly is
    deliberately main-thread (0.63 MB/channel — three orders below the 88 MiB
    case D-05.4 exists for; a transfer round-trip would cost more than the
    memcpy). Recorded as **DEVIATION D3**.
  - "staging via ≤ 2 exclusive `initTexture` calls (44/44 MiB splittable)":
    MET — exactly two `renderer.initTexture` calls per promotion, one per
    array, on separate frames, sized by P-88MIB (see *Measured input* below).
- **Rehydrate v3 row 1 — terrain arrays freed post-upload (−88 MiB), rehydrate
  by re-fetch → re-assemble → re-upload** — **MET, live-proven.** On the local
  arm the t512 pair freed **23,070,432 B = 22.0 MiB** (`ladder.mirrorsReleased
  2`, `mirrorReleaseDeferred 0`); at t1024 the same code path frees the 88 MiB
  D-05.7 quotes. Register-the-way-back-FIRST is implemented in that order and
  suite-pinned; the release refuses (counted) until three has uploaded (T15R
  D2's rule); `image.data` is nulled so `textureHasPixels` reads the mipmaps
  (T15R D3's trap, which bites terrain arrays identically). The rehydrator is
  SOURCE-keyed: it re-runs the same fetch+assemble the promotion ran. A real
  `rehydrateReleasedTextures` pass restores both arrays in the battery
  (`rehydrated 2, failed 0`).
  - **It is NOT built on `bc7_textures.js`'s `registerFullTierMirror` /
    `releaseFullTierMirror`** — **DEVIATION D4**, evidence below.
- **Demote rung consistent with `demoteFullTierUnderPressure`** — **MET.**
  `demoteTerrainUnderPressure({bytes, max})` returns
  `{demoted, bytesFreed, remaining}`, sheds colour first, needs no fetch
  (the t128 mip sets are retained — 1.38 MiB), unregisters the released-mirror
  entries with the bytes they described, and is a no-op at t128 or with the
  ladder disarmed. The residency ladder's R1 rung action stays a one-liner in
  `residency_grid.js` (T20's file, deliberately untouched — same reasoning
  T15/T15R gave for the texture rung).
- **Flag lifecycle (I7)** — **MET.** DEFAULT OFF (absent = ladder off), no
  default flipped, url-flags row + §0 docket row in the landing commit, lint
  adds 0 findings, audit `--mismatch` exit 0. OFF-arm identity is suite-pinned
  (PART 9: legacy atlas, manifest + 29×2 payload fetches, controller never
  consulted, every ladder counter 0, `releasedTextureCount() === 0`).

## Measured input this design was sized by

P-88MIB (1070, 2026-08-10 batch A): the full-res t1024 pair (~88 MiB) stages
whole in **87–96 ms** via `renderer.initTexture`, and split 44/44 MiB on
consecutive frames at **~43–45 ms/frame** — both under F6's 250 ms line, the
split with 5× headroom. The ladder therefore stages **split by default**
(`TERRAIN_STAGE_SPLIT`), colour first, and the constant carries that citation
in the code. @scale: 1070/T1, bench-measured, NOT measured inside this client —
that reading is a GATE-TEX item (see *Handoffs*).

## Deviations

- **D1 — DEVIATION: the flag has a fourth state SPEC does not name (ABSENT),
  because** SPEC's `eager|defer|off` grammar describes the world after the
  default flip, where there is no other terrain path. Today there is: the
  2026-08-05 t1024-first boot, which I7 says must remain byte-identical as the
  kill path. So: **absent = ladder OFF = legacy**; `defer`(=`on`/`1`/`true`/
  `yes`) and `eager` arm it; **`off` arms the ladder and PINS t128** (the
  low-bandwidth arm and the demote destination). At the default flip, ABSENT
  stops meaning "legacy" and SPEC's three-value grammar becomes the whole
  grammar — that transition is a one-line change to the reader and is called
  out in the url-flags §0 row as part of the flip.
- **D2 — DEVIATION: `defer` waits on preview-complete + a settle, not on
  `convergedMs`, because** no producer stamps `convergedMs` anywhere in the
  client (read-verified this session: `pack_fetch_controller.js:287` declares
  it, `:666` and `:779-780` are the only writes and they set `inWorldMs` /
  `previewCompleteMs`). A ladder that waited on a field that is null by
  construction would never promote. The reader takes
  `convergedMs ?? previewCompleteMs` so it upgrades itself for free the day
  something stamps the real milestone, plus `TERRAIN_LADDER_DEFER_SETTLE_MS`
  (2 s) and a `TERRAIN_LADDER_DEFER_MAX_MS` (30 s) ceiling — SPEC §0.2.1's
  "every session still ends at t1024" is an invariant, so a missing signal
  must not strand a session at t128.
- **D3 — sub-spec note: t128 assembles on the main thread.** D-05.4 moves
  terrain assembly into the texture worker because at t1024 it is 88 MiB of
  alloc+memcpy in one main-thread task. At t128 it is 0.63 MB per channel; the
  live arm builds the whole pair in **179 ms** including the pack parse. The
  full-tier promotion keeps the worker seam unchanged.
- **D4 — DEVIATION: terrain mirrors are freed on `texture_rehydrate.js`'s
  registry directly, NOT via `bc7_textures.js`'s `registerFullTierMirror` /
  `releaseFullTierMirror`, because** that seam is keyed to the RECORD CACHE by
  construction: its restore path ends in `_source?.adoptParsed(id, parsed)`
  (`bc7_textures.js:416`) to re-establish D-05.7's "full-tier mirror ≡ the
  record-cache entry" identity, and `adoptParsed` charges the parsed bytes to
  the 128 MB record budget (`bc7_textures.js:1020-1024` → `_put` → trim). A
  terrain array is 44 MiB and SPEC §1.3/D-05.8 put terrain in its OWN
  non-budgeted class ("terrain arrays ≤96 MiB … fixed-shape allocation;
  allocated = used by construction"), separate from the "full-tier singletons
  + previews ≤192 MiB" class the record budget enforces. Registering terrain
  there would, after a context loss, insert a 44 MiB pseudo-record into the
  budget and evict real full-tier records to make room. It also needs an
  rsId key, and a terrain array has 29 of them.
  **What I did instead** is the seam `registerFullTierMirror` is itself built
  on — `registerReleasedTexture` / `unregisterReleasedTexture` /
  `textureHasPixels` (`texture_rehydrate.js:151-215, 258-277`) — with the SAME
  three invariants copied deliberately and cited in the code: register the way
  back first (`texture_release.js:117-124`), refuse until three has uploaded
  (T15R D2), null `image.data` so the restore pass does not skip a compressed
  texture (T15R D3). D-05.7's table gives terrain its own row with its own
  rehydrator ("re-fetch payloads → worker re-assemble → re-upload"), which is
  exactly this. `bc7_textures.js` was NOT edited; the ladder's owner is
  `owner: "terrainT1024:array"` in the registry, so the two classes remain
  distinguishable in `textureRehydrateStats().byOwner`.
- **D5 — DEVIATION (additive, evidence-driven): `renderer.initTexture` staging
  is not optional, and the ladder discovers the renderer itself.** SPEC §1.3
  names `initTexture` for terrain staging; nothing in the client calls it
  today and no consumer passes a renderer to `buildTerrainBc7Atlas`. I first
  implemented staging as "swap, then let three upload on the next render" with
  the mirror release armed on the upload event. **Three live boots proved that
  wrong**: with the promotion complete and the renderer advancing 4,738 frames,
  the swapped arrays still read `colorUploaded:false` **150 s later**
  (`mirrorReleaseDeferred 2`, `mirrorsReleased 0`, 0 bytes freed) — i.e. those
  arrays were not being drawn in that session, so an upload-gated release
  would never fire. The ladder now stages through
  `window.liveScene3d.renderer.initTexture(tex)` (that handle is stamped AT
  init3D and is live — read-verified by reading `renderer.info.render.frame`
  off a running page, unlike the late-stamped fields the `liveScene3d`
  snapshot trap describes), with `initTerrainTierLadder({renderer})` as the
  explicit injection and a no-renderer fallback that keeps the swap correct
  and the release armed. Same run after the fix: `mirrorsReleased 2`,
  **22.0 MiB freed**, `mirrorReleaseDeferred 0`.
- **D6 — measured correction to pass-05 D-05.2's t128 GPU figure.** D-05.2
  states "~0.9 MiB GPU both arrays [D]" for the t128 slice. Measured live and
  in the battery: **1,443,552 B = 1.376 MiB** for the pair. The estimate
  counted the 29 DEDUPED payloads; dedup saves wire bytes (0.63 MB/channel ✓)
  but never GPU bytes, because `texStorage3D` allocates all 33 layers
  (2 × 33 × chain(128²) = 2 × 721,776). No budget moves — B4a's terrain
  component is the wire number — but the VRAM line in D-05.8's terrain row
  should read "+t128 slice ~1.4 MiB", not ~0.9.
- **D7 — probe account: `agentp08` and `agentp09`, never `tailnet1`.** As
  directed. Note for successors: one ACE account is one session and the reap
  is ~60 s after the socket dies, so back-to-back arms on the SAME account
  latch `bootState=error` with `start_session: no CharacterList within 30s` —
  observed once here (the OFF-arm boot started seconds after the ON-arm
  browser closed). Alternate accounts between arms.

## Tests run

Node direct. ONE headless chromium at a time (SwiftShader), sequential; every
browser killed at the end of its run.

```
node harness/test_terrain_tier_ladder.mjs      105 passed, 0 failed   (NEW)
node test_terrain_bc7_aniso.mjs                ALL PASS
node harness/test_tex_compressed_only.mjs      112 passed, 0 failed
node harness/test_texture_worker.mjs            69 passed, 0 failed
node harness/test_nra_derive.mjs                41 passed, 0 failed
node test_texture_rehydrate.mjs                 56 passed / 0 failed
node test_texture_census.mjs                    44 passed / 0 failed
node test_bc7_record_budget.mjs                 23 passed / 0 failed
node test_static_atlas_growth.mjs               73 passed / 0 failed
node test_mat_budget_lru.mjs                   123 passed / 0 failed
node test_materials_paletted_lru.mjs            28/28
node test_paletted_dedup.mjs                    41/41
node test_atlas_bc7_pre_gate.mjs                ALL PASS
node test_xu7_transcode.mjs                     ALL PASS
node test_xu7_budget.mjs                        49 passed, 0 failed
node harness/test_pack_fetch_controller.mjs     92 passed, 0 failed
node harness/test_diag_schema.mjs               67 passed, 0 failed (21 surfaces)
node scripts/lint-url-flags.mjs --strict        exit 1 PRE-EXISTING (fogRingCap,
                                                stableDepthShare presence-guards only;
                                                this task adds 0 findings, 0 undocumented readers)
node scripts/audit-flag-defaults.mjs --mismatch exit 0
```

The battery's PART 2 runs against the **deployed dist's real slice packs**
(located through the pinned HBSI1 index, shared kinds 7/8): 29 rows each,
uniform 21,892 B, HBC7 at 128², payload copies not views. It FAILS LOUD if the
dist is not mounted (the `test_pack_fetch_region.mjs` house precedent).

### Live arm (@scale SwiftShader/T2 — functional, not perf)

`?nosw=1&netDrainHz=30&agent=1&autoLogin=1&account=agentp08&autoSpawn=first&packSource=on&terrainBc7=512&terrainT1024=eager`
(`terrainBc7=512` pins a 22 MiB promote target so a SwiftShader box can do the
whole ladder; the code path is identical at t1024). Probe + logs:
`/tmp/t15rterr/ladder-probe.mjs`, `eager4.log`.

```
[terrain-bc7] ladder eager: terrain converged at t128
              (33 layers @ 128px, 8 levels, 1.38 MiB GPU, aniso 4) — t512 promotion eager
[terrain-bc7] ladder: promoted t128 → t512 (512px, 10 levels, aniso 4,
              2 array(s), 1376 ms, mirrors freed 22.0 MiB)

ladder: tier t512 · sliceSource pack · t128Ms 178.8 · t128Bytes 1,443,552
        promotions 1 · stageSplit 1 · stageColorMs 10.4 · stageNraMs 17.1
        uploadWaitTimeouts 0 · colorUploaded true · nraUploaded true
        mirrorsReleased 2 · mirrorBytesFreed 23,070,432 · mirrorReleaseDeferred 0
        mirrorRestoreFailed 0 · promoteFailures 0 · fallbacks 0
__hbFetch.byComponent.terrainTier: {requests: 2, bytes: 1,270,680}
console errors: 0
```

No frame or fps figure is claimed from this box (PR-1: T2 is
functional-only); `stageColorMs`/`stageNraMs` here are wall-clock around the
swap+stage on SwiftShader and are NOT the F6 reading — that is the 1070 item.

**OFF arm, same box, same URL minus `terrainT1024`** (`agentp09`,
`offarm2.log`): `ladder.mode "absent"`, `armed false`, tier null, every
counter 0, `tileSize 512 / levels 10 / aniso 4` — the legacy t512 boot, 0
console errors. Note `byComponent.terrainTier` reads `{2, 1,270,680}` on
**both** arms: the controller fetches the t128 slices on lane B as part of
T12's boot wave whether or not this flag is set, so those two requests are
NOT attributable to `?terrainT1024` — the ladder only CONSUMES bytes the
packs arm already paid for.

## Handoffs & risks

- **GATE-TEX now has a terrain leg, and it is entirely 1070/owner work.** In
  order of value: (1) the promotion's real staging cost measured IN the client
  (`ladder.stageColorMs`/`stageNraMs` on the 1070 at t1024, against F6's
  250 ms — P-88MIB says 43–45 ms/array on a bench, this is the in-app
  confirmation); (2) `ladder.mirrorRestoreFailed = 0` across a forced context
  loss at the full tier (a missed terrain restore is a black WORLD, not a
  black prop — this is the counter that must never move); (3) an **owner eye
  pass on the interim state**: with the ladder on, the world is visibly at
  t128 while the ring converges. That is the whole point of D-12.1 and nobody
  has ever looked at it. (4) B4a re-scored with terrain excluded from the
  converged wave, B4b's `terrainT1024CompleteMs` reported.
- **The recommended 1070 arm chain** is
  `?packSource=on&geomBundles=on&texCompressedOnly=on&texWorkers=on&terrainT1024=defer`
  vs the same without `terrainT1024` — that pairs this ladder with T15R's own
  recommended third E1 arm and costs no extra boots.
- **`ladder.mirrorRestoreFailed` joins `mirrors.release.restoreFailed` on the
  M5/context-loss checklist.** Both are registry-declared; both must read 0.
- **D6's VRAM line** (t128 pair = 1.38 MiB, not ~0.9) is an orchestrator
  doc-propagation item for pass-05 D-05.8's terrain row.
- **`convergedMs` is still unstamped by anyone** (D2). Whoever lands the
  converged milestone should know the terrain ladder already reads it
  preferentially — no change needed here when it appears.
- **The controller's success-latch retains every settled body**
  (`pack_fetch_controller.js:518-521`), so the full-tier payloads were
  deliberately NOT routed through lane T: the latch would pin the 88 MiB the
  mirror release exists to free. Pass-05 S7's "retire this module's private
  `fetch()` calls" therefore needs a controller-side forget/release for
  non-pack bodies first. Recorded, not attempted.
- **Unrelated dirty state (I6, staged-out, NOT committed):**
  `apps/holtburger-web/docs/RESULTS-shell-requests-2026-08-09.json` (a sibling
  agent's file). Left alone.
