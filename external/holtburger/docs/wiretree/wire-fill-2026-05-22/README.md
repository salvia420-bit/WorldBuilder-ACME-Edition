# Wire-agent solid-fill screenshots (2026-05-22)

Visual artifacts from the wire-agent colour-fill series this session
(commits `5cab848` + `b93a26f` + `7377d2a`). Captured headless via
`/tmp/local-wire-validate/validate-chromium.mjs` (Playwright +
Chromium+SwiftShader, `?renderer=3d&quality=low&agentic=low&wireframe=1`).

The session's cumulative boot win on this same harness:
**4395ms → 2755ms median (-1640ms, -37.3%)**.

| File | Shows |
|---|---|
| [01-holtburg-cottage-row.png](01-holtburg-cottage-row.png) | **HSL-hash bucket era (pre-manifest).** Close-up of the Holtburg cottage row at spawn. Red roofs, blue/yellow walls, green doors — per-bucket HSL fills from `MaterialCache._wireframeMaterialFor`. NPC nameplates visible. |
| [02-holtburg-village-wide.png](02-holtburg-village-wide.png) | **HSL-hash bucket era.** Wider village view. Terrain palette green + bucket-hash building fills. |
| [03-holtburg-dominant-colors.png](03-holtburg-dominant-colors.png) | **Dominant-colour manifest (after the `surface-colors` tool ran).** Same Holtburg town centre, but every surface now uses its actual dominant texture colour: stone-grey walls on the right ("Door" → Holtburg Meeting Hall), tan / orange-brown wooden archway in the middle ("Agent of the Arcanum" NPC visible behind), grass-green terrain. The 6,147-DID manifest at `apps/holtburger-web/data/surface-colors.json` was loaded by MaterialCache; each surface mints a per-DID material pair (wire = brightened HSL of dominant, fill = dominant) instead of the 32-bucket hash. |
| [04-holtburg-centre-archway.png](04-holtburg-centre-archway.png) | Town centre close-up. Wooden archway in tan, NPC on steps with green tunic, Holtburg Meeting Hall stone-grey wall on the right. Player rig (centre) is still wire-only — the local player bypasses `EntityManager._spawnImpl` (see loop.js:791-793 — wasm-eager-WorldState suppresses KIND_SPAWN for local player on SelectCharacter) so the entity hook in `_spawnImpl` never fires for it. Tracked as follow-on. |
| [05-holtburg-meeting-hall.png](05-holtburg-meeting-hall.png) | The Meeting Hall facade in cream-tan stone. NPC on the steps wearing green (per-bucket HSL hash colour — the manifest didn't have entries for the body-part DIDs because they were assigned per-instance at runtime by the character's clothing palette). |
| [06-holtburg-cottage-row.png](06-holtburg-cottage-row.png) | Wide Holtburg cottage-row panorama. ~6 cottages visible with terracotta roofs, tan / cream walls. Multiple red NPC nameplates above shopkeepers. The blue/cyan structure mid-village is the smithy chimney (matches retail). Player rig still wire-only (same follow-on as above). |
| [07-player-with-cow.png](07-player-with-cow.png) | **Player-fix landed.** Local player standing next to a "Cow" inside a wooden fence pen. Player body parts now show their dominant texture colours (tan-wooden tunic, dark grey armour-arms, red mohawk hair, cream-white pants/boots). Cow rendered with cream-yellow body. Fence in tan wood. The bug was the local player's per-entity material path (entities.js:990 — palette-substitution branch) minting `entity-<guid>-surface-<did>` materials that bypassed MaterialCache → bypassed `addFillCompanions`. Fix routes the wire-mode branch through `materialCache._wireframeMaterialFor(did)` so the per-DID dominant-colour pair + fill twin both apply. |
| [08-player-alchemy-forge.png](08-player-alchemy-forge.png) | Player + Alchemy Forge close-up. Stone-grey walls, terracotta-brown roof, gold/tan structural details on the forge. Player rig with full fills. |
| [09-player-overview.png](09-player-overview.png) | Wide pano of the player on a hill with distant green NPC markers + cyan Bind Stone glyph in the distance. Background terrain transitions from grass to water along the horizon. |
| [10-sky-ao-cow-pen.png](10-sky-ao-cow-pen.png) | **Sky gradient + vertex AO landed.** Same cow-pen scene as 07. Sky now shows a vertical gradient (dark blue-grey zenith → warmer grey at the horizon, matching the FogExp2 colour). Player + cow now show normal-derived AO: top surfaces fully bright, side surfaces ~70%, undersides ~45%. The wooden fence posts each have visible top-vs-side shading; the player's torso has a bright shoulder + darker armpit. |
| [11-sky-ao-alchemy-forge.png](11-sky-ao-alchemy-forge.png) | The Alchemy Forge in stark relief now — the roof is the brightest surface, walls drop to mid-tone, the under-overhang shadow is visible. The forge furnace shows clear top-of-cone vs side-of-cone separation. |
| [12-sky-ao-overview.png](12-sky-ao-overview.png) | Wide pano showing the most dramatic sky-gradient effect. Zenith dark blue, horizon line warmer grey, foreground sand bright. Distant terrain visibly atmospherically dimmed. |

Both screenshots are from Chromium+SwiftShader headless — no real GPU,
no anti-aliasing. On real hardware (e.g. the 1070 Ti) the wireframe
lines look noticeably crisper.

The terrain palette is hand-tuned per terrain code 0..31; see
`apps/holtburger-web/scene3d/terrain.js::TERRAIN_CODE_TO_RGB`.

Building / static / cell / entity fill colours have two tiers:

1. **Per-DID dominant colour** (default when `data/surface-colors.json`
   is present) — actual centroid-of-most-populated-bin from the texture
   pixels, computed offline by
   `apps/holtburger-tools surface-colors`.
2. **32-bucket HSL hash** (fallback when the manifest is missing or
   a DID isn't covered) — `hue = bucket/32, S=0.45 L=0.32`. Used for
   custom content / future surfaces.

Regenerating the manifest after a DAT change:

```bash
cd external/holtburger
cargo run --release --bin surface-colors
# walks ~6147 surfaces in ~7s, emits apps/holtburger-web/data/surface-colors.json
```

## Mesh-creation inventory (audit trail)

Every `new THREE.Mesh|InstancedMesh|SkinnedMesh|LOD(...)` call site in
the wire-agent render path, and how each one gets a solid-fill
companion. Re-run the audit with:

```bash
grep -rnE 'new THREE\.(Mesh|InstancedMesh|SkinnedMesh|LOD)\(' \
  apps/holtburger-web/scene3d/ apps/holtburger-web/index.html
```

| Site | Path | Fill coverage |
|---|---|---|
| terrain LB mesh | `scene3d/terrain.js:1371` | ✓ wire mat + per-vertex palette fill via dedicated second mesh @1454 |
| terrain LB fill twin | `scene3d/terrain.js:1454` | (this IS the fill) |
| buildings | `scene3d/buildings.js:380` | ✓ `materialCache.getCached(did)` → wire bucket → fill via `addFillCompanions(buildingsGroup)` |
| statics (singleton) | `scene3d/statics.js:569` + LOD wrapper 626 | ✓ same path as buildings |
| statics (degraded LOD) | `scene3d/statics.js:603` | N/A in wire — `?wireframe=1` skips degraded fetch (commit 2cd43b9) |
| statics (instanced) | `scene3d/statics.js:696` + degraded 737 + LOD 758 | ✓ `addFillCompanions` clones InstancedMesh with shared instanceMatrix |
| cells (fused, material array) | `scene3d/cells.js:443` | ✓ `addFillCompanions` walks material-array entries |
| cells (per-surface) | `scene3d/cells.js:477` | ✓ same path |
| cells (static interior) | `scene3d/cells.js:499` | ✓ same path |
| entities (plain) | `scene3d/entities.js:1107` | ✓ `materialCache.getCached(did)` + entity-spawn hook attaches companion |
| entities (palette-subbed, incl. local player) | `scene3d/entities.js:990-1024` | ✓ **fixed by f9b2293** — was minting `entity-<guid>-surface-<did>` materials that bypassed the cache; now routes wire-mode through `_wireframeMaterialFor` |
| particles | `scene3d/particles/particle_manager.js:218` | ✓ uses `materialCache` factory → wire bucket → fill via entity-spawn hook on parent (or world particle manager) |
| selection ring | `scene3d/entities.js:1657` | N/A — UI overlay (target-selection highlight), intentionally outside fill scope |
| hello-cube | `scene3d/index.js:429` | N/A — debug artifact, intentionally wire-only per spec |
| aurora / atmosphere / clouds / moons | `aurora.js:232`, `atmosphere_sky.js:144`, `cloud_overlay.js:271`, `ac_moons.js:431` | N/A — wire-agent skips these subsystems entirely |
| PIXI 2D mesh | `index.html:1971, 2696` | N/A — `?renderer=3d` short-circuits the PIXI path |

To audit a specific run live, drop into the Playwright probe at
`/tmp/local-wire-validate/diag-player2.mjs` — it walks every entity
in `EntityManager.entityMap`, reports mesh count and how many carry
`userData.__wireFillCompanion`. Any entity with `meshCount.total > 0`
but `withFillCompanion: 0` is a regression candidate.
