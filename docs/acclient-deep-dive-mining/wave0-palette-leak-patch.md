# Palette leak — external patch adopted + holtburger analogue

Source: `eriknihlen/ac-eor-palette-leak-fix`, cloned to
`external/ac-eor-palette-leak-fix/` (MIT for the scripts; no binary redistributed).
Related deep-dive sections: `07-dat-resources.md` §palette pipeline (cites
`Palette::makeModifiedPalette` at acclient.c:365273), `06-rendering.md` §521-523
(`ImgTex::Combine` / `CPhysicsPart::shiftPal` palette-shift path),
`11-memory-leak-investigation.md` (a *different* leak — icons/`IconData`; the
palette leak is NOT covered there, so this patch is additive to that report).

## 1. The retail defect (independently re-verified here)

Both overloads of `Palette::makeModifiedPalette` increment the inherited `DBObj`
refcount at object offset `+0x24` immediately after the constructor already set
it to 1. Every modified palette is therefore born at `refcount = 2`; the cleanup
chain releases once, reaching 1 — never 0 — so the `Palette` object and its
2048-entry (8 KB) ARGB buffer are never destroyed.

Verified in OUR on-disk 2013 decomp, not just taken from the patch README:

| Site | Our decomp | Body |
|---|---|---|
| `Palette::makeModifiedPalette()` | `ac-headers/acclient.c:365189` | `Palette::Palette(v0, 2048); if (v1) ++*(_DWORD *)(v1 + 36);` |
| `Palette::makeModifiedPalette(DataID, Subpalette*)` | `ac-headers/acclient.c:365273` | `Palette::Palette(v5, 2048); ... if (v6) { ++*(_DWORD *)(v6 + 36); ...` |

`36` decimal = `0x24` — the same field the patch targets. The 2-arg overload's
early-out (`palID == stru_84575C.id → return 0`, and the "single whole-palette
subpalette" shortcut that returns a plain `DBObj::Get`) means only the genuine
compose path leaks, which matches the measured allocation rate.

Reported impact: 56,664 leaked palettes / ~446 MB in a 27-hour dump; allocation
rate 18–60/min unpatched vs −4 to +5/min patched; ~40–50% of the total leak
budget, enough to push the 32-bit 2 GB-ceiling crash out of normal sessions. A
separate `D3DXMesh`-family leak (~1,700 instances) is NOT addressed.

## 2. Patch applied

Byte-level change, both sites in `.text`, `inc dword [reg+0x24]` → 3× `NOP`:

| File offset | VA | Original | Patched |
|---|---|---|---|
| `0x13EFFE` | `0x0053EFFE` | `FF 40 24` | `90 90 90` |
| `0x13F19C` | `0x0053F19C` | `FF 46 24` | `90 90 90` |

Pre-patch bytes confirmed with `od` before running anything, including the
following instructions, which match the decompiled control flow:
`0x13effe: ff 40 24 c3 33 c0 c3` (increment, `ret`, then the `xor eax,eax; ret`
null path) and `0x13f19c: ff 46 24 8b 06 53 8b ce` (increment, then the vtable
`SetID` call setup).

Our EoR binary: `~/ac_base_dats/acclient.exe`, 4,841,472 B,
SHA-256 `bca95bbebed4b9ed1ff09d0da83144e2fc4208f63ad7ada5cb47c3ca207ccba9`
— an exact match for the patcher's expected input.

**`~/ac_base_dats/` was NOT touched** (it is the pristine bake source per the
`bake-base-dats-only` rule, and the patcher writes its outputs next to its
input). Work was done on a copy:

```
/mnt/wbterminal2/ac-eor-patch/acclient.exe             (copy of the base dats exe)
/mnt/wbterminal2/ac-eor-patch/acclient.eor.orig.exe    (patcher's backup)
/mnt/wbterminal2/ac-eor-patch/acclient.eor.patched.exe (SHA-256 69ac7517...4fc1 — verified)
```

Patched hash matches the repo's published expected output
`69ac75174a0ea0f5a1fcd1c17bad2a562fad6439e984f05ff103a44e02bf4fc1`. Deploying it
to a Windows box (e.g. the 1070) is a file copy; reverting is a copy back.
A runtime variant (`patch_acclient_eor_runtime.py`, `WriteProcessMemory`,
`--revert` / `--dry-run` / `--pid`) can patch live clients without a restart.

## 3. The holtburger-web analogue — REAL GAP, no instrument

The retail bug is not portable as-is (Rust has no hand-rolled refcount here),
but its *shape* is: **a stuck extra reference makes composed-palette pixel
buffers permanently resident.** Holtburger has exactly that mechanism.

The composed-palette (recolored-entity) surface cache is a byte-budgeted LRU
whose eviction predicate is `Arc::strong_count(v) == 1`
(`apps/holtburger-web/src/lib.rs:9542`, `:9611`, and `:8428` for the model-tri
store). When no victim qualifies, `ByteBudgetLru::insert` deliberately **runs
over budget rather than break a live holder** (`lib.rs:9200-9218`, comment at
`:9214`). This is the structurally correct choice — and it is also precisely the
condition retail was stuck in permanently.

Design intent is that a hit is a transient `Arc` clone-out which JS frees
(`lib.rs:9707-9709`). So a single leaked JS handle pins one entry forever; a
leaked handle on a hot recolor variant pins it on every wasm instance.

**What's missing:** `surface_cache_stats` (`lib.rs:9663`) exposes
`pf_/comp_ hits|misses|inserts`, `evictions`, `bytes`, `entries`, `pal_entries`
— and nothing about un-evictable entries. There is no `pinned` counter anywhere
in `lib.rs` (grep for `pinned|unevictable|strong_count > 1`: no hits). Because
over-budget operation is legal by design, a pinned-entry leak and healthy
over-budget operation are **indistinguishable** in the current diag surface. The
only visible symptom would be `surfaceCacheBytes` sitting above
`?surfaceBudgetMB=` — which the code is documented to allow.

### PAL-01 — expose a pinned-entry counter on the surface cache (S)
Add to `ByteBudgetLru` a count of entries failing `evictable` at sweep time, and
surface it through `surface_cache_stats` → `dat_decode_diag` as
`surfacePinnedEntries` / `surfacePinnedBytes` (plus the composed-class split, to
match the existing `palXxx` convention). Payoff: turns an invisible unbounded-
retention class into a one-number check. Validation: `__diag.assets` (or
whichever surface carries `dat_decode_diag`) after a long soak; assert pinned
count returns to ~0 when the scene is idle.

### PAL-02 — assert the pinned set drains (M)
A leaked handle is a bug, not a steady state. Add a soak assertion: after N
seconds with no new decode traffic, `surfacePinnedEntries` must fall to zero (or
to a small known set of legitimately long-lived holders, enumerated). Wire it
into `__diag.runAll` so it reports PASS|DRIFT like the other integrity checks.
Validation: headless bot (`?nullRender=1&autoLogin=1`) doing repeated
equip/recolor churn — the retail trigger was equipment colour customisation,
character appearance, icon tinting and landscape detail tinting, so churn those.

### PAL-03 — audit every composed-surface `Arc` clone-out for handle release (M)
Enumerate the JS consumers that take `sp.pixels` from the composed class (the
doc at `lib.rs:9455-9462` says all three recolored-entity consumers do) and
confirm each frees its wasm handle on every path, including error and
early-return paths. Retail's leak was a single unbalanced increment on one
statement; ours would be a single missing `free()` on one path. Validation: a
targeted heap-growth test — `capture_audio_heap.cjs` in
`apps/holtburger-web/` is a precedent harness for this shape of test.

### PAL-04 — record the palette-shift pipeline as parity reference (REF-ONLY)
`06-rendering.md` §521-523 documents the retail chain
`Palette` → optional `CPhysicsPart::shiftPal` → software expansion via
`ImgTex::Combine`, and `07-dat-resources.md` §550-557 documents
`ClothingBase` → `CloPaletteTemplate` → `CloSubpalEffect` →
`PalSet::GetPaletteID` (`palette_IDs[(u64)((num_pals − 0.000001) * shade)]`) →
`CPartArray::SetPalette` → `makeModifiedPalette`, which copies the 2048-entry
base palette and overwrites only the named ranges. Cross-check against
`crates/holtburger-dat/src/file_type/palette.rs` `splice_from` and
`palette_set.rs`, and against `scene3d/diag/palettes.js` /
`scene3d/diag/clothing.js`. Note the `− 0.000001` epsilon in the shade→index
formula: an off-by-one there is a silent wrong-colour bug. Owner: the
DAT/rendering mining agents — folded in here so the constant is not lost.

## 4. Note for the 2015 doc set

The patch's addresses are EoR/11.6096 (`0x0053EFFE`, `0x0053F19C`); our verified
decomp sites are 2013/11.4186 (`0x0053E280` / `0x0053E3C0` region, acclient.c
365189 / 365273). Consistent with `13-client-differences-2013-vs-2015.md`: this
function is not among the 46 changed, so the defect is byte-identical in both
builds. Do NOT translate the +3 command-ID shift caveat onto these addresses —
that caveat applies to command ordinals, not code addresses.
