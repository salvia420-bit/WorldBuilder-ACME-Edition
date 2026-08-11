# CARD — CTX-LOSS-MIRRORS (filed 2026-08-11 by the §-11 orchestrator session)

**Status: root-caused and FIXED in node; the LIVE arm is still owed.**
Fix landed on `orch/s10-2026-08-11` — `e2f4f741` (reproduction, red on
purpose) then `725609ee` (fix). This card exists because
`ORCHESTRATOR-HANDOFF.md` §-10 B said the finding "NEEDS ITS OWN CARD" and
because the *live* half of the gate cannot be closed by the work that closed
the mechanism.

---

## 1. What was seen (the evidence this card is built on)

2026-08-11 T4 eye session, `impl/task-T4-EYES-report.md` §2.2. Settled
`texCompressedOnly + texWorkers + terrainT1024` arm, forced
`WEBGL_lose_context.loseContext()` → 5 s → `restoreContext()` → 35 s settle.
The renderer recovered (`isContextLost()` false, 6,866 meshes, 124 terrain
LBs). The mirror gate did not:

```
mirrorsArmed 30 · mirrorsFreed 6 · mirrorReleaseDeferred 3
mirrorRestores 0 · mirrorRestoreFailed 6          ← gate demands 0

[tex-rehydrate] context-restore #1: re-supplying pixels for 6 released texture(s)
[tex-rehydrate] MISS 0x6003A66:texFull owner=texCompressedOnly:full
                — rehydrator returned false; this texture will render BLACK   (×6)
[tex-rehydrate] pass finished with 6 MISS(es) in 3ms (rehydrated=0 skipped=0 gcd=0)
```

Six of six released full-tier mirrors came back with no pixels. The same
report's §3.5 recorded a second, separate oddity on the tco arm and left it
open: **`fullFailed = 18`, "non-zero and unexplained"**.

**`3ms` is the load-bearing number.** Six CAS re-fetches plus six worker
transcodes cannot complete in three milliseconds. Whatever failed, failed
before any wire read.

---

## 2. Root cause

Three mechanisms, each defensible alone, wrong in composition.

1. **The controller latches.** `settleSuccess` leaves a successful entry in
   `entries` forever and `need()` short-circuits onto its settled promise, so
   every later caller for that url gets **the same ArrayBuffer object**
   (`scene3d/pack_fetch_controller.js`, the `success entries stay in the map as
   a latch` comment and the `if (entry) … return entry.promise` branch). This
   is correct for a payload several consumers read.

2. **The worker transcode transfers.** `_workerTranscodeXu7`
   (`scene3d/xu7_textures.js`) computes
   `owned = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8 : u8.slice()`
   and puts `owned.buffer` in `postMessage`'s transfer list. Its comment says
   *"Transfer, don't copy — but only when the view owns its whole buffer
   (`xu7_blocks` returns fresh copies out of wasm memory, so it does)"*. For
   the `xu7_blocks` route that is free and safe.

3. **The seam handed (1) straight to (2).** `_fetchFullTierParsed`
   (`scene3d/materials.js`) did
   `return await transcodeXu7WithNra(new Uint8Array(buf), wantNra)` where `buf`
   is the controller's latched buffer. `new Uint8Array(arrayBuffer)` is a
   whole-buffer view, so branch (2) transferred it. **The latch was detached.**

> "Owns its whole buffer" is not "is ours to eat." That is the whole defect in
> one line.

There are exactly **two** second readers of a texFull url, and the live arm hit
both:

* **the rehydrate after a context loss** — `registerFullTierMirror(rs, tex, () => this._fetchFullTierParsed(rs, null)…)`
  re-enters the same seam and gets the detached latch;
* **a second Surface DID sharing one RenderSurface** — ordinary in retail art,
  and it needs no context loss at all. This is the standing candidate
  explanation for `fullFailed = 18`.

### Why nobody could read it

`new Uint8Array(detachedBuffer)` **throws** `TypeError: Cannot perform Construct
on a detached ArrayBuffer` (verified in V8/node 20). That throw landed in
`_fetchFullTierParsed`'s own `catch (_) { return null; }`, became a bare null,
and surfaced to the registry as an ordinary `rehydrator returned false`. A hard
type error read from outside as a soft miss for an entire live session.

### Why the 112/0 suite could not see it

Both doubles in `harness/test_tex_compressed_only.mjs` were kinder than the
browser, independently:

* `MockWorker.postMessage(msg)` took one argument and **dropped the transfer
  list**, so nothing was ever detached;
* the mock controller was `need: async () => new Uint8Array([1,2,3]).buffer` —
  a **fresh buffer every call**, i.e. no latch.

Either one alone hides the defect. This is the general lesson worth carrying:
*a double that is more generous than the thing it stands for cannot fail the way
production fails.*

---

## 3. The fix (landed `725609ee`)

* **Copy at the seam that does not own the bytes.** `_fetchFullTierParsed`
  slices the controller's payload before the transcoder sees it. Unconditional,
  so it removes the whole hazard class — including the concurrent-reader case
  that a `forget`-only fix would not cover.
* **`controller.forget(url)`** — drops a **settled** latch (and its residency)
  so a one-shot payload is not pinned for the session. Without it the fix would
  trade a black texture for ~1.3 MB × N of retention against M4. It **refuses**
  a queued/in-flight entry: forgetting one would orphan every waiter already
  latched to its promise and break the D-03.4 dedupe guarantee.
* **Name the miss.** `__texStats().tiers.fullFetchMisses` +
  `.lastFullFetchError`, `__hbFetch.forgotten` — all three registered in
  `harness/lib/diag_schema.mjs`.
* The legacy `xu7_blocks` route keeps its zero-copy transfer and now carries a
  comment saying why it may.

**Not fixed, deliberately:** a settled success entry is never deleted, so the
controller pins **every** pack payload it has fetched for the life of the
session. `forget` is opt-in and only the texFull consumer calls it. That is a
systemic retention question for the wire lane, not this defect. Flagged, not
absorbed.

---

## 4. What is proven, and what is not

**PROVEN (node, no browser spent):**

| | before | after |
|---|---|---|
| `harness/test_tex_compressed_only.mjs` | 112/0 with kind doubles → **109/6** with faithful ones | **115/0** |
| `harness/test_pack_fetch_controller.mjs` | 92/0 | **99/0** |

The reproduction emits the live console line character-for-character
(`MISS 0x…:texFull owner=texCompressedOnly:full — rehydrator returned false;
this texture will render BLACK`) and the sub-millisecond pass, in node. The
shared-rsId arm reproduces `fullSwaps=1 fullFailed=1` where both should land.

**NOT PROVEN — this is the open half of the card:**

* No browser has been spent on this fix. The node proof is the *mechanism*; it
  is not the arm.
* `fullFailed = 18` on the T4 tco arm is a **candidate** explanation, not a
  confirmed one. It is consistent (a second DID on one rsId fails exactly this
  way) but nobody has counted how many rsIds the live arm shared.

---

## 5. THE LIVE ARM STILL OWED (this is the runnable part of the card)

One headless arm, ~15 min, no 1070 required — the T4 can do it.

**Prereqs**
* release wasm current (`pkg/*.wasm` ≈ 4.5 MB) — no Rust changed in the fix, so
  the deployed wasm is fine, but `serve.py --check` will warn if pkg/ predates
  the last Rust-touching commit; that warning is not this card's business;
* `?renderScale=1` is MANDATORY (adaptiveRes pins 448×280 otherwise);
* GPU proven inside the live page before judging anything — assert the renderer
  string reads `ANGLE (NVIDIA Corporation, Tesla T4/PCIe/SSE2)` **and**
  readPixels a drawn triangle. Never infer the GPU from a string alone;
* same-account relogin inside ~3 min is fatal — budget one boot;
* capture must `readPixels` INSIDE the render call. `page.screenshot()`
  photographs a BLACK world.

**Arm**
`?renderScale=1&packSource=on&texCompressedOnly=on&texWorkers=on&terrainT1024=on`
(the §2.2 arm), settle, then `__loseContext()` → 5 s → `__restoreContext()` →
35 s settle.

**Read**
```
__texStats().mirrors.release   → restoreFailed MUST be 0, restores === freed
__texStats().tiers.fullFetchMisses → 0 preferred; if >0, lastFullFetchError NAMES it
__texStats().tiers.fullFailed  → compare against the T4 arm's 18
__hbFetch.forgotten            → > 0 (the texFull consumer is dropping its latches)
__hbFetch.byComponent.texFull.requests → should now EXCEED the number of distinct
                                 rsIds upgraded, because a rehydrate re-fetches
console                        → zero "will render BLACK" lines
```

**Judgement**
`restoreFailed === 0` with `restores === freed` closes the card. Anything else
reports the counters and `lastFullFetchError` verbatim — that string exists
precisely so the next failure does not cost another session.

---

## 6. Related, checked, NOT affected

* **Terrain t1024 mirrors** (`scene3d/terrain_bc7.js` `_releaseArrayMirror` /
  `_rebuildTierMips`) are **clean**. The t1024 rebuild re-fetches through
  `_fetchPayload`'s raw `fetch()` — no controller, no latch. The t128 rebuild
  reads `ctl.getT128Slice(chan)`, which is controller-held, but `_mipsFromChannel`
  **copies** (`data.set`) and never transfers. Note that
  `workerTerrainAssemble` DOES transfer its payloads — its author knew, and
  handled it by re-fetching on the fallback path (the comment at
  `xu7_textures.js` `workerTerrainAssemble` says so outright).
* The gate literally named in the T4 queue row,
  `__terrainBc7Stats.mirrorRestoreFailed`, is **vacuous on the v4 dist** (no
  `terrain_bc7` tier is deployed). The failure was always in the full-tier path
  (`__texStats().mirrors.release`). Fix the queue row when that dist is rebaked.
