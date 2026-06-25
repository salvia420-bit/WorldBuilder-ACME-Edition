# Handoff — VFX classifier unblocked: hand-staged → world-wide catalog (2026-06-25)

## What was wrong
The Visual-Behavior Suite engine (phases 0–3) is sound, but the **data layer was barely
populated**: the live `dist/vfx/visual_descriptors.jsonl` was **14 HAND-STAGED eye-test DIDs**
("HAND-STAGED test assignment, NOT classifier output"), so almost nothing in the world received an
effect. The C# classifier existed but: (a) ran one DID at a time (no bulk command), and (b) its
gem/weapon predicates couldn't fire because `OntologyEntry` dropped `ItemType`/`WeaponType`/
`MaterialType` on ingest (the "DATA GAP §18 #1"). gemSparkle was a 1-DID hardcoded allowlist; glint
was **never reachable** in the cascade.

## What changed (C# — WorldBuilder.Terminal + WorldBuilder.Shared)
The data to classify was already in LSD-partial (`external/LSD-Partial-2025-02-23_16-15/weenies/`):
each weenie carries `ItemType` (PropertyInt 1, bitfield — Gem=2048), `WeaponType` (353 — Sword=2/
Axe=3/Mace=4/Spear=5/Staff=7), `MaterialType` (131), and the Setup DID (DataId 1).

1. **`OntologyEntry`** — added `ItemType`/`WeaponType`/`MaterialType`.
2. **`IngestWeenies`** — extracts WeaponType(353) + MaterialType(131) into `weenie_summary.jsonl`
   (ItemType(1) was already extracted).
3. **`EnrichFromWeenies`** — merges them onto the ontology entry: ItemType is **OR-merged** across
   all weenies sharing a Setup ("any weenie on this model is a gem" sticks); WeaponType/MaterialType
   take the first non-zero.
4. **Ontology cache** (`CacheToFile`/load DTO) — persists the three fields, so the catalog is
   regenerable from a plain `load` (no re-ingest/enrich needed).
5. **Classifier cascade** (`VfxClassify`) — wired real predicates:
   - **gem-sparkle**: `ItemType & 2048` (Gem bit) — data-driven, allowlist kept as override.
   - **rigid-glint** (glint+tarnish): `WeaponType ∈ {2,3,4}` (Sword/Axe/Mace); metal MaterialType refines. *(Was previously dead code — never fired.)*
   - **tip-flex**: `WeaponType ∈ {5,7}` (Spear/Staff) exact, with the pre-existing thin-geometry surrogate as fallback.
   - Rule registry: gem-sparkle gets `itemTypes:[2048]` + scale fixed (0.45/0.15, clearing the [0.1,10] clamp — same bug as the JS gemSparkle defaults).
6. **NEW `vfx-emit-catalog <out.jsonl>`** — runs the cascade over every scanned Setup ontology entry
   and writes a full catalog (DIDs with ≥1 component; rigid/fallback omitted = frozen path).

## Result (verified)
`vfx-emit-catalog` over 5935 setups → **1612 effect DIDs** (was 14):

| archetype | count |   | archetype | count |
|---|---|---|---|---|
| tip-flex | 848 | | trunk-canopy | 103 |
| rigid-glint | 340 | | creature-breath | 9 |
| foliage-pollen | 269 | | brazier | 1 |
| **gem-sparkle** | **42** | | | |

- Mechanism proven: glint fires on `wt=2`(Sword)/`wt=3`(Axe); 42 gems via the Gem bit.
- **Deployed live**: `dist/vfx/visual_descriptors.jsonl` replaced with the 1612-line catalog
  (hand-staged original backed up → `visual_descriptors.hand-staged.bak.jsonl`).
- **`vfx gauge --ref holtburg` = STRUCTURAL-PASS** (G1–G4 green; Holtburg refs → 14 trees-wind + 12
  foliage + 1 breath; 13 emitters ≤ 35 budget). No regression.
- **Repeatable**: cache persists the fields → fresh `load` → `vfx-emit-catalog` reproduces 1612 exactly.

### Regen pipeline (one session)
```
load <project.wbproj>                                  # auto-loads enriched ontology_cache.jsonl
# (only if the cache predates this change:)
ingest-weenies  lsdPath=<LSD-Partial>  outputPath=<summary.jsonl>
enrich-weenies  summaryPath=<summary.jsonl>
vfx-emit-catalog outputPath=<dist>/vfx/visual_descriptors.jsonl
```

## Honest caveats / follow-ups
- **magicGlow / enchantShimmer / wetness / frost have NO classifier rule** — they only ever existed
  as the hand-staged eye-test cranks (now replaced). The dramatic "lifestone glows" demo came from a
  cranked magicGlow entry; it's in the backup. To auto-attach magicGlow, add a rule (e.g. ItemType
  magic/jewelry or spell-bearing weenies — same pattern as gem).
- **tip-flex = 848 is broad** — dominated by the *pre-existing* thin-geometry surrogate (aspect≥3,
  parts≤2), which catches signposts/poles/masts, not just spears/staffs. Flag-gated (`?tipFlex`,
  default-off); worth tightening (e.g. require weapon ItemType) before default-on.
- **gem OR-merge** may yield a few false positives (a generic model shared with a gem weenie inherits
  the Gem bit). Spot-review the 42.
- **Coverage = base portal DAT (5935 setups)**; custom/late-content DIDs aren't scanned.
- **In Holtburg specifically**, the visible payoff is trees-wind (MOTION — needs video) + foliage
  motes (billboarded, visible — see HANDOFF-phase3-particle-render). Gems/weapons are ITEMS (entities),
  not town statics, so they show where such entities spawn, not in the town square.

## Follow-up fix (same day): tip-flex over-assignment → scenery slivers
First deploy of the full 1612-effect catalog (suite default-on) made the world render a **dense field
of vertical white slivers**. 1070 A/B isolated it: stripping `tip-flex` lines → clean; so tip-flex was
the cause. The classifier's **geometry-surrogate** tip-flex (`AspectRatio≥3 && PartCount≤2`) fired on
~848 thin **scenery** objects (poles/signs/fences), and MECH-B vertex bend turned them into slivers.
**Fix:** gate the geometry surrogate to require a **weapon ItemType** (`(ItemType & 0x101) != 0`,
MeleeWeapon|MissileWeapon) — the WeaponType-exact path already handles real spears/staffs. Result:
tip-flex 848→**404** (all weapons/items, never town scenery). Re-emitted catalog = **1168 effects**;
gauge STRUCTURAL-PASS; 1070-confirmed the town renders **clean** with the suite default-on.
`CommandEngine.Vfx.cs` (geometry-surrogate gate).

## Stack investigation (the "we never had night until this" report) — RESOLVED, no conflict
Investigated a suspected takram-clouds↔atmosphere conflict causing "night". Findings (1070):
- **No clouds/atmosphere conflict.** Clouds (`?clouds=on`) wire + render with **zero errors**
  (`CloudOverlay wired … noise=prebaked`, `CloudVolume.attachAtmosphere wired Bruneton tables`); they
  composite after tonemapping and never darken the sky. Atmosphere loads **fast (~1.2s prebaked EXR)**.
- **Not actually night.** Sky state is daytime (`dirPitch` 28–67°). Even forced `setSkyTimeOverride(0.0)`
  ("midnight") keeps the sun at the horizon and the scene fully lit — the takram sky never goes black.
- **The "black" = the boot-load window.** Until init3D finishes (~26s at quality=low; the documented
  ~90s on cold-load), the 3D canvas is black (HUD only). That + the tip-flex slivers is what read as
  "night/broken". After full init it's bright day. "We never had night until this" = Sky-K replaced the
  old always-day parametric sky with the wall-clock AC cycle.
- **takram kept STOCK** — all fixes are in our classifier/glue, so the prebaked cold-load LUT/cloud
  files stay valid.
- Open/minor: a few **retail `default_script` flame emitters** render edge-on as faint slivers
  (pre-existing, flat quads, not billboarded — retail-faithful); optional follow-up = billboard retail
  flat sprites. And a lit boot-fallback during the LUT load would remove the black-at-boot.

All changes uncommitted on `feat/phase3-particle-2026-06-24`. Verified: build 0 errors, gauge
STRUCTURAL-PASS, `test_particle_billboard.mjs` 8/8, 1070 clean daytime render with suite default-on.
