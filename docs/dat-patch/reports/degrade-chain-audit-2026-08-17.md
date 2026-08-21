# F1 — degrade-chain audit of r7 (SurfaceTexture LOD chains), 2026-08-17

**Verdict up front.** Over all 7,221 SurfaceTexture (0x05) records in the r7 portal:
**2,416 FULLY-BAKED, 1 PARTIAL, 4,804 UNTOUCHED.** There is **no LOW/HIGH
patchwork inside client_portal.dat**: not a single SurfaceTexture — retail or
r7 — lists two *distinct portal-resident* RenderSurfaces. The r7 pipeline
already collapses every multi-level chain it bakes into a single level, so the
texture-detail degrade path cannot pull a retail texture for a baked surface.
**Recommendation: ACCEPT — do not "bake both".** Fix the single leaked chain
(`0x05000ECE`, a de-dup miss, one 0x05 record rewrite) and add a pipeline
invariant. Bake-both only becomes interesting if we ever obtain
`client_highres.dat`, and then as a *quality* upgrade (better source pixels),
priced at **1,342 extra records**.

## Method (all reads, no dat modified)

Data: r7 `/mnt/wbterminal2/dat-patch-r7/export/client_portal.dat`, retail
`/home/wbterminal/ac_base_dats/client_portal.dat`, r6
`/mnt/wbterminal2/dat-patch-scenery/ace-r6-dats/client_portal.dat`.
Scripts in `/mnt/wbterminal2/dat-patch-r7/degrade-scratch/` (scratch, not
committed); detail table `/mnt/wbterminal2/dat-patch-r7/degrade-chain-audit.json`.

1. **B-tree inventory** with `tools/dat-patch/datlib.py`, subclassed to keep the
   entry *bitflags* datlib drops (b-tree entry = `u32 flags, id, offset, size,
   date, iteration`; flag bit 0 = zlib-compressed payload
   `[u32 uncompressedSize][zlib stream]`).
   r7/retail/r6 all hold the **same id sets**: 7,221 × 0x05, 20,684 × 0x06,
   6,152 × 0x08. In r7, 20,669 of 20,684 0x06 records are compressed; all 0x05
   and 0x08 records are uncompressed. Retail and r6 are fully uncompressed.
2. **Baked set** = 0x06 whose *inflated* r7 bytes differ from retail bytes.
   Cheap pass first (uncompressed-size prefix vs retail record size) → 2,381
   differ by size; full inflate+compare of the remaining 18,303 → 31 more
   differ at equal size. **Baked = 2,412**, zero inflate-length mismatches.
3. **Chain parse.** SurfaceTexture wire format taken from
   `RenderTexture::Serialize` (`~/ac-headers/acclient.c:137475`) and confirmed by
   `dats.xml` / `ACE.DatLoader/FileTypes/SurfaceTexture.cs`:
   `u32 id, u32 dataCategory, u8 TextureType, u32 count, count × u32 RenderSurface id`.
   Parser validation over all 7,221 records: **id echo matches in 100%**,
   **tail bytes = 0 in 100%**, TextureType = 2 (Texture2D) in 100%, chain length
   ∈ {1, 2}. Cross-checked the brief's example (below).
4. **RenderSurface header** (`u32 id, dataCategory, width, height, PixelFormat,
   len`) read for every referenced 0x06 in both dats for dimensions/format.

## What the client actually does with a chain (decomp, verified)

- `RenderTexture::LoadLevelResources` (acclient.c:136423) does `DBObj::Get`
  (QDID category 12) on **every** level id; if a level of a Texture2D fails to
  load the whole call returns false.
- `RenderTexture::ConstructTexture` (:136496) takes level 0
  (`m_SourceLevels.m_data->m_Resources[0]`) as the top mip.
- `RenderTexture::DropUnwantedLevels` (:137195), called from `InitLoad`
  (:137461), **drops the first N levels** — the *high-res* ones — where N comes
  from `dword_81EF9C`, registered as the user preference **"Environment texture
  detail level"** (`Render_EnvironmentTextureDetail`, values {4,3,2,1,0},
  acclient.c:382056-382065), or N=1 when `ShouldDropHighDetail()` (:136332)
  says the cache isn't on disk. **It is a no-op when the chain has ≤ 1 level**
  (`if (m_SourceLevels.m_num <= 1) goto LABEL_17`).
- `CLCache::LoadHighResDat` (:293658) mounts `client_highres.dat` when present.

So "the client serves the LOW sibling at lower texture quality" is real — but
the sibling it serves is the *next entry in the same chain*, and a 1-entry
chain has none.

## Findings

### 1. Retail chain structure — there is no in-portal low sibling

Of retail's **3,024** two-entry chains:

| pattern | count |
|---|---|
| entry[0] **absent from client_portal.dat** (a `client_highres.dat` id), entry[1] present | 2,284 |
| entry[0] == entry[1] (duplicate self-reference) | 740 |
| two distinct entries, both resident in portal | **0** |

2,254 of the 2,284 satisfy `entry[1] == entry[0] + 1`. 2,283 distinct
highres-only ids are named in total. The brief's example checks out exactly:

```
0x0500278B  retail chain [0x06003E7D, 0x06003E7E]
  0x06003E7D  not present in client_portal.dat (retail or r7) — highres-dat id
  0x06003E7E  retail 256x256 DXT1  →  r7 1024x1024 DXT1  (baked)
  r7 chain: [0x06003E7E]   ← entry[0] dropped by our pipeline
```

### 2. Our pipeline already collapses baked chains (since r6)

Chain-length histogram (retail, r6, r7): `(1,1,1) × 4,197`, `(2,2,2) × 1,624`,
`(2,1,1) × 1,400`. **1,400 chains were rewritten 2→1** — 1,342 dropped a
distinct highres id, 58 dropped a duplicate — and **all 1,400 contain a baked
texture**. r6 and r7 chains are identical, so this happened in the r6 import,
not r7. 1,624 chains still have two entries: 941 highres-only + 682 duplicate
(all untouched retail content) and 1 leak (below).

### 3. Classification (r7)

| class | count | meaning |
|---|---|---|
| FULLY-BAKED | 2,416 | every real entry in the chain is a baked record |
| PARTIAL | **1** | a baked entry sits under an unbaked sibling |
| UNTOUCHED | 4,804 | no baked entry at all (never in a lane) |

Entry-status totals across all chains: 2,417 baked entries (2,412 distinct RS,
5 shared by two SurfaceTextures), 942 highres-only-absent, 682 duplicate,
4,804 unbaked portal entries — **all 4,804 in UNTOUCHED chains; 0 stale
portal-resident siblings inside a baked chain.**

### 4. The single PARTIAL — a de-dup miss, not a design gap

```
0x05000ECE  r7 chain [0x0600628F, 0x060045B4]     ← still 2 entries
   0x0600628F  highres-only, absent from portal
   0x060045B4  baked (props lane): retail 64x128 → r7 256x512
0x05002C2E  retail chain [0x0600628F, 0x060045B4] → r7 [0x060045B4]  ← collapsed
```

Two SurfaceTextures share the identical retail chain; the importer rewrote one
and missed the other. Impact is bounded: only on an install that actually
mounts a real `client_highres.dat` and at high texture detail would
`0x0600628F` (retail 2× source) top the stack and mask our 256×512 upscale on
that one surface. Our own kits ship a **0-file** `client_highres.dat`
(`ace-r6-dats/`, `ace-r7-dats/`, 1,049,600 bytes, b-tree contains zero
records), so inside the kit nothing resolves and even this one is inert.

### 5. Baked-set sanity vs the lane lists

Lane `baked/*.png` id union = **2,192** (texture-remacri 691, dungeons 473,
props 434, scenery 340, creatures 195, doors 59; no cross-lane duplicates), all
2,192 present in the dat-derived baked set. The extra **220** are pre-r7 bakes
inherited through the r6 portal (mostly INDEX16 128²→512² DXT1, plus 27
512×512 A8R8G8B8 records rewritten in place at the same size, ids
`0x06006D06`–`0x06006D6F`). Baked set r7 **==** baked set r6 (2,412 ids,
identical membership); of those, r7 shipped **2,182** newly re-encoded records
and 230 byte-identical to r6 — i.e. r7 re-baked the lane work at the same id
footprint rather than widening it.

Upscale profile of the 2,412: **2,342 at exactly 4× linear**, 70 at 1× (format
conversions only). Top transitions: 128²→512² (708), 256²→1024² (375),
64²→256² (233), 128×256→512×1024 (192), 512²→2048² (178). Formats: retail
INDEX16 → DXT1/DXT5 for 716 records, DXT1→DXT1 for 1,397, R8G8B8/A8R8G8B8 →
DXT1/DXT5 for 175.

### 6. Where the in-scene old-vs-new patchwork actually comes from

Not the degrade chain. **4,804 of 7,221 SurfaceTextures (66.5%) are untouched
retail**, sitting next to the 2,417 baked ones in the same scenes. Patchwork is
a *coverage* artifact of lane selection, plus (per F4) retail's own pre-existing
UV bugs — not a LOD/sibling artifact.

## Cost of "bake both"

There is nothing to bake in the portal: the unbaked siblings do not exist there.
The only bake-both option is to obtain `client_highres.dat` and bake its
records. Cost = **1,342 distinct highres-only ids** named by chains whose portal
entry we already baked (their portal siblings are mostly small: 536 × 128²,
183 × 64², 132 × 256², 110 × 128×256, 104 × 128×64, …). That is roughly a
half-lane-scale bake, and it buys *better source pixels* (highres is typically
2× the portal record → 4× from 512 instead of 256), not a bug fix — because we
already drop entry[0] wherever we bake.

## Recommendation

1. **ACCEPT r7's chain handling.** Degrade-chain exposure is 1 SurfaceTexture
   out of 7,221; no bake-both is required for correctness.
2. **Fix `0x05000ECE`** by collapsing it to `[0x060045B4]` exactly as the other
   1,400 chains — a single 0x05 record rewrite, no re-bake, no id churn.
3. **Add a pipeline invariant** (cheap CI check on any exported portal): for
   every 0x05 whose chain contains a baked 0x06, `len(chain) == 1`. The r7 miss
   was a shared-chain de-dup bug, so key the rewrite on the *chain*, not on the
   SurfaceTexture.
4. **A/B hygiene:** the knob that matters for textures is the "Environment
   texture detail level" preference (`Render_EnvironmentTextureDetail` →
   `DropUnwantedLevels`), not `AutomaticDegrades`/`DegradeDistance` (those are
   the model-degrade path). Pin it at max detail and confirm whether the test
   install mounts a non-empty `client_highres.dat` before attributing any
   old-vs-new difference to our bakes.
5. **Defer the highres lane** (F1 follow-up): worth doing when a real
   `client_highres.dat` is in hand, priced at 1,342 records, as a source-quality
   upgrade — with the precedence question (portal vs highres for duplicate ids)
   still to be answered before shipping portal-only.

## Artifacts

- Detail table: `/mnt/wbterminal2/dat-patch-r7/degrade-chain-audit.json`
  (per-SurfaceTexture: class, retail/r6/r7 chains, per-entry status, retail and
  r7 dimensions, lane attribution, dropped entries; plus summary block with
  mechanism references and cost numbers).
- Scratch scripts: `/mnt/wbterminal2/dat-patch-r7/degrade-scratch/`
  (`inv.py`, `prefix.py`, `full_cmp.py`, `audit.py`, `classify2.py`, `final.py`).

---

## Re-run on SHIPPED r9 (2026-08-21) — CLOSED

`fix_degrade_chains.py --check` on the shipped r9 kit portal
(`/mnt/wbterminal2/dat-patch-r9/kit-r9b/acme-r9/client_portal.dat`):
7,221 SurfaceTextures, 7,211 distinct chains, 1,623 multi-entry (histogram
{1: 5,598, 2: 1,623}), **degrade-chain violations = 0** (report:
scratchpad/degrade-check-r9.json). The single r7 leak (`0x05000ECE`) is gone.

**This closes the "8 blend-ST collapse (entry[0]=highres) remains MANDATORY
regardless" note** from terrain-d4b-high-2026-08-18.md:44-45 /
TASKLIST-2026-08-17.md:408. That mandate was a terrain-2x prerequisite (the
2-entry blend STs must resolve to the collapsed sibling, not a reachable
highres sibling). terrain-2x is DEAD (D4b hard fail), and independently the
shipped r9 portal has ZERO multi-entry-chain violations — every reachable
entry is the correct one — and gated GREEN through full world entry on the
1070. Nothing owed for the r9/r10 ship. (F7's `--check` was the planned
verification; it is now run and green.)
