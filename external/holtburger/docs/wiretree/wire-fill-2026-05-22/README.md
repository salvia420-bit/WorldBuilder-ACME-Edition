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
