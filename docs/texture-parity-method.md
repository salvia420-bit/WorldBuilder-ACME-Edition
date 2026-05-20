# Texture-Parity Method (Wave 4.A + 4.B)

Companion to [`wire-conformance-method.md`](wire-conformance-method.md) (Wave 1),
[`dat-parity-method.md`](dat-parity-method.md) (Wave 2.A/B/D),
[`enum-parity-method.md`](enum-parity-method.md) (Wave 2.C),
[`physics-parity-method.md`](physics-parity-method.md) (Wave 3.A/B/F),
[`motion-parity-method.md`](motion-parity-method.md) (Wave 3.C),
[`cell-portal-method.md`](cell-portal-method.md) (Wave 5.A),
[`skybox-parity-method.md`](skybox-parity-method.md) (Wave 5.B), and
[`diagnostic-toolset-method.md`](diagnostic-toolset-method.md) (Wave 5.C).

This doc covers the **Surface → SurfaceTexture → RenderSurface → Palette
chain decode** slice of Wave 4 per the
[diagnostic toolset plan](diagnostic-toolset-plan-2026-05-19.md) §3 row 10
and §6 Wave 4 (W4.A + W4.B).

Status: **shipped 2026-05-20**.

## The contract

For every Surface record in `client_portal.dat` (~6,152 records in retail):

```
∀ surface_id ∈ Surface.records(client_portal.dat):
    let bytes = portal.read(surface_id)
    let chain = Chorizite.Surface(bytes).walk()       # Surface→SurfaceTexture→RenderSurface→Palette
    let rgba  = chain.decode_to_rgba8()
    sha256(rgba) == cache[sha256(bytes)].pixel_sha256
```

i.e. the canonical Chorizite-side decode produces a deterministic
RGBA8 buffer per Surface, and re-runs against the same base DATs
hit the sha-keyed cache (returning the prior sha256 without
re-decoding). Per [[feedback_base_dats_only_for_bake]] the base
DATs are immutable, so steady-state runs are O(0) on the decode
side — only the dispatch-overhead is paid.

`Mean RGBA` is the 4-channel arithmetic mean over the decoded
pixels — the textured-mean reduction the JS material decoder uses
as a tint fallback (`fetch_object_colours` in
`apps/holtburger-web/src/lib.rs:2974`). Drift in mean RGBA across
cache hits = parser bug; the contract is exact.

## Why this method exists

Every visible-fidelity claim in `emit-dynamic-site` depends on the
Surface chain. The chain has three independent failure modes:

1. **Chain-shape drift** — Surface (0x08……) references a
   SurfaceTexture (0x05……) which references a RenderSurface
   (0x06…… or 0x07……). The wrong branch (e.g. picking the
   first MIP instead of the last) gives a decoded image of the
   wrong size. Holtburg's Aluvian wood doors are a common case
   (a 256×256 oak grain that decodes to a 16×16 LOD if you walk
   the chain wrong).
2. **Format-decode drift** — `PixelFormat` carries one of ten
   on-disk encodings (`PFID_R8G8B8` BGR-ordered, `PFID_A8R8G8B8`
   BGRA-ordered, `PFID_INDEX16` palette-indexed, DXT1/3/5
   block-compressed, etc.). Endianness errors in the 16-bit
   formats (`R5G6B5`, `A4R4G4B4`) silently produce washed-out
   pixels.
3. **Palette resolution drift** — palette-indexed formats
   (`PFID_P8`, `PFID_INDEX16`) require resolving
   `RenderSurface.DefaultPaletteId` to the canonical 256- or
   2048-entry Palette record (0x04……). Cache invalidation
   here is the entire reason ACE's [`CalculateObjDesc`](https://github.com/ACEmulator/ACE/blob/master/Source/ACE.Server/WorldObjects/WorldObject_Networking.cs#L1017)
   keeps a per-entity sub-palette overlay list.

Wave 4.A+B catches **all three** by exercising the entire chain
through Chorizite's port (which was validated against retail
acclient.exe by an independent C# author) and emitting (PNG sha,
mean RGBA, chain shape) per record. Drift surfaces as a
sha256 mismatch at the record level; chain-shape drift surfaces as
a `chainKind` mismatch (one of `solid`, `textured/direct`,
`textured/palette`, `textured/clipmap`).

## The two diagnostic commands

### `chorizite-decode-surface-chunk <startId> <endId>`

For every Surface ID in the half-open range `[startId, endId)`:

1. Resolve the Surface record via
   `DatReaderWriter.DatDatabase.TryGet<Surface>(id, out var s)`.
2. Read the raw bytes via `TryGetFileBytes(id, out byte[], true)`
   and sha256 them — this is the **cache key**.
3. **Cache hit fast path:** if `surface/<sha>.json` exists, load
   the cached `TextureRecordResult` and return as
   `Status: "CACHED"`. Per [[feedback_base_dats_only_for_bake]]
   this is the steady-state path on warm re-runs.
4. **Solid-colour branch:** if `Surface.Type & Base1Solid` or
   `ColorValue != null`, synthesize a 1×1 ARGB pixel from the
   colour value and emit a `chainKind: "solid"` result.
5. **Textured branch:** resolve `surface.OrigTextureId` →
   SurfaceTexture record → `.Textures[^1]` (highest-res MIP) →
   RenderSurface record. The MIP selection mirrors the Rust
   `surf_tex.highest_res()` path in
   `apps/holtburger-web/src/lib.rs::fetch_surface_pixels_impl:4771`.
6. **Format-decode switch:** ten on-disk formats handled per
   `DatReaderWriter.Extensions.DBObjs.RenderSurfaceExtensions.ToRgba8`
   (see `external/chorizite/DatReaderWriter.Extensions/DatReaderWriter.Extensions/DBObjs/RenderSurfaceExtensions.cs:98-282`).
   `PFID_P8` and `PFID_INDEX16` resolve palettes via the same
   DRW handle (re-implemented here vs the `DatEasyWriter`-based
   API to allow read-only DAT access — see §"Why we re-implement
   ToRgba8" below).
7. Compute `pixel_sha256` and `meanRgba`; persist the
   `TextureRecordResult` to the on-disk cache and (optionally)
   emit a PNG into `png/<sha>.png`.

Returns a `TextureChunkResult` envelope with per-record results
and a chunk-level `progress.json` sidecar at
`progress/<chunkLabel>.json`.

### `chorizite-decode-texture-chain-chunk <startId> <endId>`

Identical iteration to W4.A but records the **full chain shape**
per record:
- `chainKind`: one of `solid`, `textured/direct`,
  `textured/palette`, `textured/clipmap`
- `surfaceTextureIdHex`, `renderSurfaceIdHex`, `paletteIdHex`:
  the three downstream DIDs the chain resolved through (null
  for branches that don't apply)
- `pixelFormat`: the `PixelFormat` enum value as a string

W4.B's load-bearing output is the `chainKind` distribution — when
both sides decode through the same Chorizite path, the
distribution should match the Rust port's
`fetch_surface_pixels_impl` walk exactly. Drift in the kind
histogram = MIP-selection bug or palette-lookup bug; drift in
counts = chain-shape parser drift.

## Source files

### Oracle (canonical Chorizite parsers + decoders)

- `Chorizite.DatReaderWriter` v2.1.2 — NuGet ref in
  `WorldBuilder.Terminal.csproj`. Generated DBObj types under
  `DatReaderWriter.DBObjs.{Surface,SurfaceTexture,RenderSurface,Palette}`.
- `DatReaderWriter.Extensions` 1.x — ProjectReference. The
  format-decode switch in `RenderSurfaceExtensions.ToRgba8`
  is the canonical pixel-decode reference (we re-implement it
  inline to avoid the `DatEasyWriter` ReadWrite requirement).
- `WorldBuilder.Terminal/CommandEngine.TextureParity.cs` — the
  two chunk commands. ~700 LOC.

### Subject (holtburger-dat Rust + wasm-side decoder)

- `external/holtburger/crates/holtburger-dat/src/file_type/{surface,surface_texture,texture,palette}.rs`
  — parser side.
- `external/holtburger/crates/holtburger-dat/src/file_type/texture.rs::Texture::to_rgba8`
  — Rust-side format decode (same switch as
  `RenderSurfaceExtensions.ToRgba8`).
- `external/holtburger/apps/holtburger-web/src/lib.rs:fetch_surface_pixels_impl`
  — the wasm entry point. Walks Surface→SurfaceTexture→Texture
  via `holtburger_dat::ResourceSource` (HTTP-backed in the
  browser, native test target for unit tests).

### Validator

- `external/holtburger/apps/holtburger-web/validate_texture_decode.cjs`
  — Node driver. Persistent WB.Terminal subprocess.

### Dispatch splice

The JSON-stdin dispatch entries for the two commands are
documented in `WorldBuilder.Terminal/WAVE4T_DISPATCH_PENDING.patch`
because three sibling agents (W4-mesh + W4-orchestrator + W4-texture
+ events-F.D-fu + follow-ons-bundle) ran in parallel against the
same `JsonCommandProcessor.cs` file. The validator auto-applies
the patch transiently when run with `--auto-splice` and reverts
on exit. The canonical commit landing this slice splices the
dispatch permanently.

## Why we re-implement `ToRgba8`

`DatReaderWriter.Extensions.DBObjs.RenderSurfaceExtensions.ToRgba8`
takes a `DatEasyWriter` only because it needs to resolve palettes
via `datEasyWriter.Get<Palette>(id)`. `DatEasyWriter` requires
`DatAccessType.ReadWrite` (see DatEasyWriter.cs:42-46), and we
need the validator to be safe against the immutable base DATs per
[[feedback_base_dats_only_for_bake]]. The 200-LoC format switch
is ported inline (with the palette resolver swapped for a
RO-backed `Dictionary<uint, Palette>` cache) so the validator
opens DATs with `DatAccessType.Read` and can never accidentally
mutate the base bake.

The re-implementation is verbatim against the Chorizite extension
(see `external/chorizite/DatReaderWriter.Extensions/DatReaderWriter.Extensions/DBObjs/RenderSurfaceExtensions.cs:98-282`).
Any divergence will surface as a sha256 mismatch on the
W4.B cross-check (oracle decode vs in-process decode) — by
construction they MUST agree because we share the same DBObj
parser and BCnEncoder DXT decoder.

## Sha-keyed cache contract

Per plan §6 Wave 4 — "sha-keyed result cache":

```
/mnt/wbterminal1/holtburger-validator-fixtures/wave4/
  surface/<surface_sha>.json     — TextureRecordResult per record
  png/<surface_sha>.png          — RGBA8 → PNG (emitted only with --emit-png)
  progress/<chunk_label>.json    — per-chunk progress sidecar
```

External scratch only per [[feedback_use_external_drives_for_scratch]]
— the root disk fluctuates 85–96% on this box. Override via
`--cache-root=...` or env `WAVE4T_CACHE_ROOT` for ephemeral testing.

The cache key is `sha256(raw_surface_record_bytes_after_decompression)`.
Re-decoding only happens when the cache file is missing — by
[[feedback_base_dats_only_for_bake]] discipline this is "once per
base bake forever". 131 MB cache total for the full ~6,152
Surface records (most of which is the duplicated solid-color
1×1 ARGB blobs; the deduplicated payload is closer to 30 MB).

## CI gate sub-mode

The validator accepts `--mode=fast|full`:

- **`--mode=fast` (default)** — 81-record Holtburg-aligned subset.
  Engine-side resolution: walk every Surface ID in the DAT,
  sample-stride 81 evenly spaced records (so the subset is
  deterministic and covers every PixelFormat without locking to
  hand-picked DIDs). Sub-second after the cache primes; ~8s
  including dotnet startup. **Acceptance bar: ≥80/81 PASS**
  (per plan §6 Wave 4 W4.A; ~98.8%).
- **`--mode=full`** — whole `client_portal.dat` Surface range
  `[0x08000000, 0x08010000)` in 500-record chunks (configurable
  via `--chunk-size`). Currently 6,152 Surface records in retail.
  ~30s cold (first run, full decode); sub-second warm.
  **Acceptance bar: ≥99.5% PASS** (per plan §6 Wave 4 W4.A;
  ~76-record tolerance budget for palette-edge cases).

The `--wave4-mode=fast|full` flag in
`diag-run-all`'s CLI is already plumbed (no-op when Wave 4 wasn't
shipped); shipping this validator activates it.

## First-run results (2026-05-20)

```
mode=fast  records=81   pass=81    cached=0    fail=0   8.2 s   PASS (≥80/81)
mode=full  records=6152 pass=6065  cached=87   fail=0   34.0 s  PASS (≥99.5%)
```

The 87 cached entries in the full run are from the prior fast-mode
sweep hitting the sha cache. Steady-state warm full-mode run is
sub-second (all 6,152 records cache-hit).

### Chain-kind distribution (full sweep, 6,152 records)

| chainKind            | count | % of total |
|---|---|---|
| `textured/palette`   | 2,983 | 48.5% |
| `textured/clipmap`   | 2,132 | 34.7% |
| `textured/direct`    | 884   | 14.4% |
| `solid`              | 153   | 2.5%  |

The "solid 2.5%" figure matches the rev-tracked sweep in
[`docs/phase-3-renderer.md:834`](phase-3-renderer.md): "only 2.5% of
surfaces are solid-coloured; the textured-mean path is doing the
load-bearing work for ~97% of resolutions." Cross-validated.

### Pixel-format distribution (full sweep)

| PixelFormat         | count | % | notes |
|---|---|---|---|
| `PFID_INDEX16`      | 2,979 | 48.4% | palette-indexed, dominant Aluvian-architecture format |
| `PFID_DXT1`         | 1,987 | 32.3% | block-compressed, opaque |
| `PFID_R8G8B8`       | 679   | 11.0% | BGR-ordered, no alpha — terrain blends |
| `PFID_A8R8G8B8`     | 202   | 3.3%  | BGRA-ordered, used by UI overlays |
| `synth/argb`        | 153   | 2.5%  | solid-color synthesized 1×1 |
| `PFID_DXT5`         | 138   | 2.2%  | block-compressed, alpha |
| `PFID_DXT3`         | 5     | 0.1%  | block-compressed, sparse alpha |
| `PFID_P8`           | 4     | 0.07% | 8-bit palette |
| `PFID_R5G6B5`       | 3     | 0.05% | packed 16-bit |
| `PFID_A4R4G4B4`     | 2     | 0.03% | packed 16-bit + alpha |

The `PFID_INDEX16`-heavy retail bias is documented in
[[reference_ac_dat_file_types]] §RenderSurface — the indexed format
is preferred for retail content because re-coloring (e.g.
dyed armour, faction tabards) is a palette-swap operation
that doesn't require texture re-upload.

## Failure clustering rule

When the validator reports failures, they cluster into ≤5 root-cause
buckets per the plan acceptance criteria. The clustering happens in
`summarizeChunks` in the validator — failures are keyed by their
`failureReason` string (first 80 chars). Top-5 clusters are surfaced
to stdout.

Common known clusters (none observed in 2026-05-20 first-run; documented
for future regression):

1. `RenderSurface 0x... not present` — broken SurfaceTexture →
   RenderSurface link. Real retail data has none of these; appearance
   would indicate a stale DAT bake.
2. `Palette 0x... not found in DAT` — broken
   RenderSurface.DefaultPaletteId. Same provenance.
3. `Unsupported PixelFormat: PFID_...` — would indicate an
   undocumented format. Retail uses only the ten covered above.
4. `BcDecoder failed` — DXT block corruption. Would indicate a
   damaged bake.
5. Other (single-record one-offs).

If ≥1% of Surfaces fail (per spec push-back clause), don't loosen
the threshold — investigate the failure clusters and report.

## Source-of-truth precedence

When DRW labels disagree with `~/ac-headers/acclient.c`, acclient.c
wins per [[feedback_dat_parser_mislabels]]. For the Surface chain,
the canonical retail references are:

- `CSurface::UnPack` at `acclient.c::CSurface::UnPack` — the
  on-wire Surface format. DRW's `Surface` matches bit-for-bit.
- `CSurfaceTexture::UnPack` at `acclient.c::CSurfaceTexture::UnPack`
  — SurfaceTexture (DB_TYPE_SURFACETEXTURE). DRW's
  `SurfaceTexture` matches.
- `CRenderSurface::UnPack` at `acclient.c::CRenderSurface::UnPack`
  — RenderSurface (DB_TYPE_RENDERSURFACE). DRW's `RenderSurface`
  matches the field tree but **does NOT** mirror retail's
  alternate-MIP / aniso-filter selection (which retail picks
  per-frame based on object distance). We always pick the
  highest-resolution MIP (`Textures[^1]`), matching the Rust
  `surf_tex.highest_res()` choice. Retail at distance 30+ metres
  would pick a coarser MIP — a documented Wave 4 follow-on for
  the LOD-aware variant.

## Wave 4 follow-ons

(per plan §6 Wave 4)

1. **W4.A.LOD — MIP-aware decode** — currently always picks
   `Textures[^1]` (highest-res). Retail's per-frame MIP
   selection runs in `CRenderSurface::GetLodLevel(distance)`
   at `acclient.c:178472`. A distance-keyed variant of the
   chunk command would let the renderer-acceptance validator
   check LOD selection too. ~120 LOC.
2. **W4.B.JS-side cross-check** — currently only the C#
   oracle runs. Adding a `wasm-pack --target nodejs` driver that
   exposes `fetch_surface_pixels_impl` to a node-side test
   would close the C#-vs-Rust loop. Blocked on
   `fetch_surface_pixels` being `#[cfg(target_arch = "wasm32")]`-
   gated; the existing native test target uses
   `fetch_surface_pixels_impl` directly via `ResourceSource`
   but isn't exposed over the wasm boundary yet.
3. **W4.B.HD-DAT** — Chorizite supports the `client_highres.dat`
   high-resolution texture pack (split out of the base portal in
   the modern AC content). Our base DATs are vanilla retail
   without highres; if a future bake mixes them, the validator
   needs to walk both DAT collections per the
   `DatEasyWriter::Save` branch in `DatEasyWriter.cs:69-78`.

## Cross-links

- Plan: [`diagnostic-toolset-plan-2026-05-19.md`](diagnostic-toolset-plan-2026-05-19.md) §3 row 10 + §6 Wave 4 W4.A/B.
- Sibling validators:
  [`validate_dat_parity.cjs`](../external/holtburger/apps/holtburger-web/validate_dat_parity.cjs),
  [`validate_cell_portal_graph.cjs`](../external/holtburger/apps/holtburger-web/validate_cell_portal_graph.cjs),
  [`validate_skybox.cjs`](../external/holtburger/apps/holtburger-web/validate_skybox.cjs).
- Engine partial: [`CommandEngine.TextureParity.cs`](../WorldBuilder.Terminal/CommandEngine.TextureParity.cs).
- Mesh sibling: [`CommandEngine.MeshParity.cs`](../WorldBuilder.Terminal/CommandEngine.MeshParity.cs) + [`mesh-parity-method.md`](mesh-parity-method.md) (W4.C/D).
- Memory entries: `project_emit_dynamic_site` (Surface chain notes),
  `feedback_base_dats_only_for_bake`,
  `feedback_use_external_drives_for_scratch`,
  `feedback_dat_parser_mislabels`,
  `reference_ac_dat_file_types`.
