# RESULTS — recolor A/B: the thrash leak is real, the 3.6 GB step is neither cache — it's the Town Network (2026-07-26)

> **⚠ PARTIAL RETRACTION (same night, later):** the Town Network attribution
> (finding 4) is VOID — the "step" was `performance.memory`'s 20-minute cache
> expiring, not an allocation (see `RETRACTION-jsheap-step-2026-07-26.md`; a
> DAT census independently shows TN is content-light and costs ~20 MB measured
> precisely). Findings 1–2 (palEvict thrash, entMB=0) stand as churn/counter
> facts, but the "1–2 GB retained duplicates" MB attribution is withdrawn —
> retained-byte truth awaits the fixed instrument.

Executes the consequence/memory experiment from the "dye" terminology audit (see
`DESIGN-recolor-residency-2026-07-26.md` §0) with the new instruments from merge
`4965f2d5` (`?recolor=off`, `__diag.palettedCache()`, `__diag.entityOwned()`,
relay columns `palSigs/palMB/palHiMB/palEvict/entMB`). Two armLong-style 62-POI
single sessions on the same release wasm; caveat: arms sequential (not
interleaved) and a decomp-research agent added background IO during arm 1 —
memory verdicts are drift-proof, settle deltas are indicative only.
Raw: `/mnt/wbterminal2/recolor-ab-2026-07-26/` (+ `run2-slim/` confirmation).

## Arms (02:00–03:27)

| metric | armRecOn (default) | armRecOff (`?recolor=off`) |
|---|---:|---:|
| settleMed(work) / capped | 19.95 s / 21 | 16.93 s / 22 |
| jsHeapPeak med → max | 93 → **3,586 MB** | 133 → **3,586 MB** |
| maxMain / maxWkr wasm | 683 / 191 | 681 / 183 |
| final mats (`matMB`) | 1,798 (323 MB) | 2,745 (431 MB) |
| palSigs / palMB / palHiMB | 256 (at cap) / 26 / 35 | 0 / 0 / 0 |
| **palEvict** | **11,604** | 0 |
| entMB | 0 | 0 |

## Findings

1. **The paletted-cache thrash leak is REAL and large.** The 256-count cap
   caused **11,604 evictions** over one route; each eviction re-mints a full
   texture whose `image.data` any live mesh retains (dispose frees GPU handles
   only). At ~100-200 KB/texture that is a **1-2+ GB class of retained
   duplicates** that no cache tally could see — the cache's own content never
   exceeded **35 MB**. The count cap wasn't just untracked; it was the
   *duplicator* (the "shared" cache degrades to per-wearer duplication above
   256 signatures). The fix (merged `feat/composed-slim`): `?palBudgetMB` byte
   budget, default 64 MiB ≈ ~600 signatures at the observed ~100 KB/sig — room
   for the museum without thrash. Confirmation rerun pending (`run2-slim/`).
2. **`entMB` = 0 in both arms** — the per-wearer owned-texture pool the
   falsifier doc originally suspected is confirmed unreachable in normal
   sessions (audit prediction validated by instrument).
3. **The 3.6 GB step is NOT the recolor system at all.** It fired at the same
   magnitude and the same route position with recolor entirely off (palSigs 0,
   palEvict 0). Combined with the matcache falsifier (cache pinned at 64 MB,
   step unmoved), every texture pool is now excluded: `matMB` read only
   258-431 MB at the step in these arms.
4. **POI correction: the step fires entering the TOWN NETWORK, not Swank.**
   Row-aligned js/POI extraction puts the 93→3,586 (and 133→3,586) transition
   at TN/Town Network — the giant indoor portal-hub dungeon — in both arms
   (the earlier Swank attribution was off by two rows). This is literally the
   H2 example from `DESIGN-first-bake-batches-2026-07-25.md` §6: "EnvCell/
   dungeon-dense town introduces a new allocation class." Lead suspect is now
   the **dungeon/EnvCell geometry allocation class** (BufferGeometry JS
   arrays, bake outputs), which no current instrument tallies.
5. **Recolor-off measurement notes:** `mats` grows ~1.5× (formerly-composed
   surfaces land in the palette-free maps — with their normal/height planes,
   pre-slim). Settle was ~3 s faster with recolor off (less decode work);
   drift-caveated but consistent with the composed path's Sobel cost, which
   `feat/composed-slim` removes for the composed class anyway.

## Disposition

- `?recolor=off` remains a **measurement bracket only** (visual cost per the
  audit: skin/hair/eyes, loot colors, creature variants, clipmap bodies).
- The **rename** (dye→recolor, 3 tiers) proceeds — terminology was the only
  "dye" problem; the system itself is essential and now properly bounded.
- **Next investigation: the Town Network geometry step.** Discriminator to
  build: a geometry byte tally (BufferGeometry attribute array bytes, keyed by
  owner: landblock LRU vs dungeon/EnvCell bake vs entity) exposed via __diag +
  relay, then an armLong rerun watching it at TN entry; a skip-TN route
  control isolates the POI. Also check `?eagerDungeons` interaction and
  whether the landblock LRU's parked/evicted accounting covers EnvCell
  geometry at all.
