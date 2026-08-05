# Tranche 2 prototype — palette-preserving ×4 upscale for INDEX16/P8 (scoped 2026-08-04)

> **STATUS 2026-08-04 (post-run truth-up): the prototype RAN and ALL 5 GATES
> PASSED.** 20 samples, quantizer unit-tests 3/3, ZERO range-boundary /
> clip-sentinel / hard-bleed violations across all samples × all real dye
> variants, NN-control exact 20/20, live boot (gate 4) rendered Bak'tshay
> Servant at 1024² + 512×1024 from injected records with 0 errors. Evidence +
> tooling: `/mnt/wbterminal2/tranche2-proto/` (quantizer `t2quant.py`, gates,
> records, sheets, t2tool with the two DatReaderWriter write-bug workarounds);
> test dist `/mnt/wbterminal2/tranche2-testdist/`. Gate 1 shipped with an
> ACCEPTED SPEC REVISION — see the gate-1 note below; the original <1% index
> floor is superseded. Mechanism is GO for the 1,189 batch (user call, do not
> relitigate). Batch steps: HANDOFF-texture-pipeline-2026-08-04.md §4.7.

**Population:** 1,427 uncovered paletted RenderSurfaces (1,423 INDEX16 + 4 P8);
1,189 are >32 px and upscalable, 238 tiny stay retail-res. These are the
recolor-bearing textures — creature skins, clothing, hair — composed per-entity
at decode time (`objDesc.SubPalettes` → ClothingTable → the wasm's
palette-COMPOSED admission class). Pre-baked BC7 is structurally impossible
here: one source renders in N dye colors. Prototype BEFORE batch.

## Mechanism under test: upscale in index space

decode INDEX16 under its default palette → RGBA ×4 (Remacri, same mean-repin)
→ **constrained re-quantization back to the SOURCE palette** → re-emit the
RenderSurface record with 4× dims and 4× INDEX16 payload. The recolor chain
never notices — same palette, same indices semantics, just more texels.
Delivery: the record replaces the original in the shard store's eor-portal
namespace (the client never opens a DAT; dims come from the record; no 2 GiB /
5 MB caps apply). Target: ZERO client code changes — verify, don't assume.

## The two hard invariants (verified against code/formats, not negotiable)

1. **Range fidelity.** Subpalette recolors replace palette index RANGES
   (`CloSubPaletteRange{Offset,NumColors}`, dats.xml:3055). A boundary pixel
   that quantizes from a skin-range index to a color-similar hair-range index
   will tint wrongly under a hair dye. Constraint: each output pixel may only
   quantize to palette entries whose indices appear in its source-neighborhood
   window (the source 4×4 region it derives from). This preserves per-range
   membership by construction.
2. **Clip-map sentinel.** For `surface_type & 0x4` (Base1ClipMap), palette
   index < 8 IS the transparency key (lib.rs ~11668, retail
   ImgTex::CopyIntoData acclient.c:365958). Quantization must never move an
   opaque pixel below index 8 or a transparent one above it — violations are
   holes in creature bodies or solid fringes. Treat index<8 as a separate
   class: transparent source pixels map to the source's own sentinel index;
   opaque pixels exclude indices 0–7 from their candidate set.

Additional rules: exact alpha-class matching before color distance (palette
entries carry ARGB); nearest-entry metric in Lab or weighted-RGB; no error
diffusion in v1 (dither under recolor is untested — evaluate only if banding
demands it).

## Sample set (~20)

From the 1,189 upscalable: ~8 creature skins with ≥2 subpalette ranges
(resolve recolor-heavy cases via LSD weenies' palette templates + ClothingTable
refs), ~4 clothing, ~2 hair/face, ~4 clip-maps (`surface_type&0x4` — the
dolls/Virindi class), ~2 P8. Extraction via WB.Terminal
`chorizite-parse-dat-record` (RenderSurface + Palette records).

## Validation gates (all must pass before the 1,189 batch)

1. **Identity floor:** downscale the re-quantized 4× output back to 1× — no
   mismatch may cross a range boundary or the clip sentinel. (Catches
   quantizer bugs mechanically.)
   **SPEC REVISION (accepted 2026-08-04):** the original "<1% index mismatch"
   floor is WRONG for this pipeline and superseded by a structural-zero +
   color-delta budget. Remacri de-dithers AC's hand-dithered art, so 8–72%
   same-range adjacent-entry churn is EXPECTED and harmless — the gate is zero
   structural violations (range/sentinel) plus a bounded color delta, with the
   NN-control roundtripping exact as the mechanical check.
2. **Recolor stress:** compose every sample under ≥4 real subpalette variants
   (offline reimplementation of the compose, checked against wasm output at
   1×). Per-variant diff of 1×-vs-4×-downscaled: any pixel whose color CLASS
   differs between variants at 4× but not 1× = range bleed = FAIL.
3. **Visual sheets:** per sample × per variant, source|4× columns — the same
   montage harness as the two previous rounds; phone-reviewable.
4. **Client boot:** overlay dist with the ~20 modified records, spawn known
   recolored NPCs (ACE @spawn/wcid list from LSD), `?nosw=1`, assert 0 console
   errors + eyeball; confirm the wasm decode accepts non-retail dims via
   `actual_dimensions` with no side assumptions.
5. **Budget math:** composed entities decode to RGBA8 — ×16 texel growth vs
   today. Measure resident composed-texture bytes at Holtburg spawn
   (`surfaceBudget` is 24 MB main / 64 MB worker); project ×16 and decide:
   cap paletted output at 512² (likely sufficient — sources are 64–256) and/or
   raise the budget. This gate produces a NUMBER, not a vibe.

## Deliverables & effort

Quantizer + extraction driver (1 session, CPU/laptop is fine — Remacri on 20
textures runs on the iGPU ncnn build); validation harness + sheets (1 session);
boot test + budget measurement (part of a normal serve/chromium loop). GPU
rental unnecessary for the prototype; the 1,189 batch afterwards is ~1 h of
L4 (~$1) using the corpus driver + the quantizer as a post-stage.

## Kill criteria

Range bleed that constraint-quantization can't eliminate; structural
violations (range/sentinel) or unbounded color delta under the revised gate 1
(NOT raw index churn — see the spec revision above); budget math demanding an
unacceptable cap (<2× effective res gain); any
client dims assumption that would force wasm changes disproportionate to the
win. If killed: fall back to per-combo BC7 pre-bake for the FINITE composed
set actually observed in world data (enumerable from LSD weenies + ClothingTable
— bounded but larger; only if index-space fails).
