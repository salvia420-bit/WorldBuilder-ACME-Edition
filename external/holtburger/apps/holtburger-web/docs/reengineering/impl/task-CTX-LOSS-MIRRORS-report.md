# task-CTX-LOSS-MIRRORS — the lane-T payload was never ours to transfer

Orchestrator session §-11, 2026-08-11, branch `orch/s10-2026-08-11`.

Charge (self-assigned from `ORCHESTRATOR-HANDOFF.md` §-10 B, ranked #1 of the
agenda): the first live exercise of the rehydrate path returned
`mirrorRestoreFailed=6, mirrorRestores=0` with six "will render BLACK" misses
against a gate demanding 0. §-10 said it needs its own card; write the card,
and fix it if the fix is tractable and verifiable here.

**Outcome: root-caused, fixed, and proven in node. The live browser arm is
NOT done and is not claimed.** A second, previously unexplained live symptom
(`fullFailed = 18`) now has a demonstrated candidate mechanism.

---

## Shipped

| commit | contents |
|---|---|
| `e2f4f741` | reproduction — RED ON PURPOSE. Makes the two doubles in `harness/test_tex_compressed_only.mjs` faithful; suite goes 112/0 → 109/6, all six the defect. |
| `725609ee` | the fix — `scene3d/materials.js`, `scene3d/bc7_textures.js`, `scene3d/pack_fetch_controller.js`, both suites, `harness/lib/diag_schema.mjs`, `docs/url-flags.md`. 115/0 + 99/0. |
| `185e4f6f` | `docs/reengineering/queued/CTX-LOSS-MIRRORS-card.md` — the card §-10 said was owed. |

Files touched (all read-verified this session):
`scene3d/materials.js` (`_fetchFullTierParsed`) ·
`scene3d/bc7_textures.js` (`noteFullTierFetchMiss`, two counters) ·
`scene3d/pack_fetch_controller.js` (`forget`, `diag.forgotten`) ·
`harness/test_tex_compressed_only.mjs` · `harness/test_pack_fetch_controller.mjs` ·
`harness/lib/diag_schema.mjs` · `docs/url-flags.md`.

---

## Root cause

Three mechanisms, each defensible alone, wrong composed. Full narrative in the
card; the short form:

1. **`controller.need()` latches.** A settled entry stays in the map and every
   later caller for that url resolves off the same promise — **the same
   ArrayBuffer object** (`pack_fetch_controller.js` `settleSuccess` + the
   `if (entry) … return entry.promise` branch in `need`).
2. **`_workerTranscodeXu7` transfers** any whole-buffer view it is handed
   (`xu7_textures.js`), on the stated premise that "the view owns its whole
   buffer".
3. **`_fetchFullTierParsed` handed (1) straight to (2)**, so the transfer
   detached the controller's latch.

*Owning your whole buffer is not the same as being allowed to eat it.*

Two second readers of a texFull url exist and the live arm hit both:

* the **rehydrate after a context loss** — the six MISSes;
* a **second Surface DID sharing one RenderSurface**, ordinary in retail art
  and needing no context loss — the standing candidate for the same arm's
  `fullFailed = 18` (`task-T4-EYES-report.md` §3.5, "non-zero and
  unexplained").

`new Uint8Array(detachedBuffer)` **throws** `TypeError` (verified in node 20).
That throw landed in the seam's own `catch (_) { return null; }` and surfaced
as an ordinary `rehydrator returned false`. The live console's
`pass finished with 6 MISS(es) in 3ms` was the tell that survived: six CAS
re-fetches plus six worker transcodes cannot finish in three milliseconds.
Nothing was fetched.

### Why a 112/0 suite could not see it

Both doubles were kinder than the browser, and either one alone hides it:
the mock worker took `postMessage(msg)` and dropped the transfer list; the
mock controller minted a fresh ArrayBuffer per `need()`. General lesson worth
keeping: **a double more generous than the thing it stands for cannot fail the
way production fails.**

---

## The fix

* **Copy at the seam that does not own the bytes.** Unconditional, so the
  whole hazard class goes — including the concurrent-reader case a `forget`
  alone would not cover.
* **`controller.forget(url)`** drops a **settled** latch and its residency, so
  a one-shot payload is not pinned for the session. Without it the fix trades
  a black texture for ~1.3 MB × N of retention against M4. It **refuses** a
  queued/in-flight entry — forgetting one would orphan every waiter latched to
  its promise and break the D-03.4 dedupe guarantee.
* **The miss is named**, not swallowed: `__texStats().tiers.fullFetchMisses` +
  `.lastFullFetchError`, `__hbFetch.forgotten`.
* The legacy `xu7_blocks` route keeps its zero-copy transfer (a fresh copy out
  of wasm memory genuinely is the caller's) and now says so.

---

## Tests run

| suite | before | after |
|---|---|---|
| `harness/test_tex_compressed_only.mjs` | 112/0 (kind doubles) → **109/6** (faithful) | **115/0** |
| `harness/test_pack_fetch_controller.mjs` | 92/0 | **99/0** |
| `harness/test_diag_schema.mjs` | 63/6 | **63/6** — byte-identical failure set (6 pre-existing evidence-line drifts, all in files this task did not touch; my four drifted rows were re-pointed) |

Neighbours, all green and all run this session: `draw_pools` 448/0 ·
`rsid_marker` 87/0 · `terrain_tier_ladder` 105/0 · `texture_worker` 69/0 ·
`texture_rehydrate` 56/0 · `bc7_record_budget` 23/0 · `page_resample_texref`
26/0 · `xu7_budget` 49/0 · `texture_census` 44/0 · `static_atlas_growth` 73/0 ·
`stat_array_merge` 115/0 · `mat_budget_lru` 123/0 · `pal_budget_bytes` 101/0 ·
`dead_batch_skip` 33/0 · `vertex_bake_flags` 61/0 · `surface_single_pass` 10/0 ·
`f7_8_surface_bitfield` PASS · `visfid_p31_pom` 30/30 · `vfx_material_substrate` 6/0.

Rust, on the merged tree: **core 643/0**, **world 688/0** (687 baseline plus
one new test from the sibling oracle work), `cargo check -p holtburger-web
--target wasm32-unknown-unknown` clean.

Both flag lints clean of these rows: `lint-url-flags` 632 documented / 0
undocumented (same 3 pre-existing PRESENCE-GUARD findings, which pre-date the
branch), `audit-flag-defaults` exit 0 / 0 mismatches.

Pre-existing failures confirmed pre-existing by stashing this session's edits
and re-running: `test_recolor_escape_entmb` 134/1; `test_materials_paletted_lru`,
`test_paletted_dedup`, `test_visfid_c4_program_cache_key`,
`test_visfid_p02_detail_material`, `test_visfid_p33_csm` crash identically on
clean HEAD; `harness/test_pack_fetch_region` and `test_xu7_transcode` need
`/mnt/wbterminal2`, which is the laptop's mount and absent on this box;
`harness/test_build_shell` SKIPs for the same reason.

> Environment note for successors: these suites need `three` resolvable from
> `apps/holtburger-web/node_modules`, which did not exist on the box (pruned
> during the disk squeeze). `npm install --no-save --no-package-lock three@0.184.0`
> — 2 s, 39 MB, gitignored. Without it every three-importing harness suite
> dies at module resolution before asserting anything.

---

## Deviations

**None.** SPEC is silent on ArrayBuffer ownership across the controller/worker
boundary; nothing here contradicts it.

---

## Handoffs & risks

1. **THE LIVE ARM IS OWED** and is the open half of the card. One headless T4
   arm, ~15 min, no 1070. Recipe, gates and traps are in
   `queued/CTX-LOSS-MIRRORS-card.md` §5. The node proof is the *mechanism*; it
   is not the arm. I did not run it: `~/eyetest*` is fenced by this session's
   charter, and a live-ACE login with the owner away is his call, not mine.
   The rig is warm — `serve.py` is up on `127.0.0.1:8765` with
   `HOLTBURGER_DIST=$HOME/holtburger-dist-v4`, and `~/eyetest/arm.mjs` is the
   turnkey driver the T4 session built.
2. **`fullFailed = 18` is a CANDIDATE explanation, not a confirmed one.** The
   mechanism is demonstrated (`fullSwaps=1 fullFailed=1` in the new arm);
   nobody has counted how many rsIds the live arm actually shared. The live
   arm above settles it for free — read `fullFailed` and
   `tiers.lastFullFetchError` on the same boot.
3. **NOT FIXED, flagged not absorbed: the controller pins every payload it has
   ever fetched.** `settleSuccess` never deletes a success entry, so each
   fetched pack/index/texFull buffer is retained for the session.
   `forget` is opt-in and only the texFull consumer calls it. This is a
   systemic wire-lane retention question, plausibly material against M4, and
   deliberately out of this defect's scope.
4. **The queue row for this leg names the wrong gate.**
   `__terrainBc7Stats.mirrorRestoreFailed` is vacuous on the v4 dist (no
   `terrain_bc7` tier deployed). The live failure is
   `__texStats().mirrors.release.restoreFailed`. Fix the row when that dist is
   rebaked.
5. **Terrain checked and CLEAN.** The t1024 rebuild re-fetches through a raw
   `fetch()` (no controller, no latch); the t128 rebuild reads a
   controller-held slice but `_mipsFromChannel` copies and never transfers.
   `workerTerrainAssemble` does transfer, and its author knew — the fallback
   path re-fetches, and says so in the comment.
6. **Six pre-existing `test_diag_schema` failures are all evidence-line drift**
   (`__diag.pools`, `__diag.residency`, `__diag.textures`, `__diag.wasmMem`,
   `__hbWasmMemory`, `__landblockLru.getStats`) in files this task did not
   touch. Each is a one-line registry fix. Left alone to keep this diff
   honest; someone should spend the ten minutes and get the gate back to green,
   because a lint with six standing reds stops being read.
