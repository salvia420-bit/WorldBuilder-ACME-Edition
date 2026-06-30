# Spawn-driven boot — the Holtburg test ring is retired — 2026-06-30

## TL;DR
The hardcoded **Holtburg boot ring** (the early-dev test-site scaffolding that eagerly baked a 13×13 = 169-LB ring centred on landblock `0xA9B4` *before the player's real spawn was known*) is **retired**. Boot is now **spawn-driven**: the world streams terrain/buildings/statics around the player's actual spawn LB via the already-default `world_stream.js#onPositionUpdate` path + `tickPvsLoadExpansion`. No landblock is special at boot. Branch: `spawn-driven-boot`.

**This also fixes the dual static-`ParticleManager` bug for free** (see `2026-06-30-treesway-gpu-and-staticsgroup-mesh-mystery-handoff.md` §RESOLVED): the abandoned `scene3dForBuilders` bake manager (~5,143 emitters, ~20k invisible meshes) is gone — only the streaming `liveScene3d._staticParticleManager` remains.

## Verified on the real GTX 1070 (off-screen interactive-session Chrome, `account=tailnet1`, weather off, ultra)
- Boots **in-world, ZERO console errors**.
- World streams around the **real spawn LB** (`initialCentreLbKey = 0xA8B30000`, the actual spawn — **not** hardcoded `0xA9B4`): terrain + buildings + statics + scripted-static particles + NPCs all render (visually identical to the old Holtburg view, but spawn-driven).
- **Single static ParticleManager** (`ls._staticParticleManager`; the `scene3dForBuilders`/`cameraSwitcher.scene3d` bake manager no longer exists).
- **Adversarially reviewed clean**: a 6-dimension / 18-agent review verified 12 candidate findings → **0 confirmed bugs**.

## Why pure-streaming (Design A), not a deferred spawn-centred bake (Design B)
The streaming path (`world_stream.js#onPositionUpdate`, default-on since the `?unifiedDispatch` flip 2026-06-18) was **already spawn-driven and already the path every non-Holtburg spawn used**. The Holtburg ring was purely additive scaffolding. Deleting it regresses nothing, removes a ~10–30 s blocking 169-LB init bake, and the horizon is maintained spawn-agnostically by `tickPvsLoadExpansion` (radius 5, ~10 Hz). A deferred eager bake would just re-introduce a blocking ring and duplicate the PVS expansion. **No spawn-seed ring was added** — that would re-introduce a (spawn-centred) ring concept; Holtburg now cold-boots exactly like Cragstone does.

## Changes (branch `spawn-driven-boot`, 8 files)
- **`scene3d/index.js`** — deleted the eager `bakeTerrainRing`/`bakeBuildingsRing`/`bakeStaticsRing` boot calls + the Holtburg camera retarget + hello-cube reposition; nulled `initialCentreLbKey`/`playerLbKey` (now set lazily from the real spawn LB in `loadTerrainForLandblock`); `getPlayerWorldPos` pre-spawn fallback decodes the spawn LB or returns neutral; the terrain `terrainOpts` lazy-resolve now centres on the LB being loaded, not Holtburg; deleted `HOLTBURG_X/Y` + `HOLTBURG_RING_RADIUS` + the now-unused `bakeXRing` imports; `ringMax` drops `HOLTBURG_RING_RADIUS`.
- **`scene3d/buildings.js`** — **lazy `resolveBuildingsOpts` self-heal inside `bakeBuildingsForLandblock`** (the boot ring used to stash `buildingsOpts`; without this the per-LB bake threw into `_guardedStreamBake` and `buildingsGroup` stayed empty — this was the one real bug caught during verify). Retired `HOLTBURG_X/Y` + `SPAWN_REF`; the bake-time shadow-distance gate now defers to the live `tickShadowReceiveGate`; deleted `buildHoltburgBuildings`.
- **`scene3d/statics.js`** — retired `HOLTBURG_X/Y` + `SPAWN_REF` + the bake-time shadow gate + `buildHoltburgStatics`. (`staticsOpts` is a stub, so the statics stream needed no self-heal.)
- **`scene3d/terrain.js`** — retired `HOLTBURG_X/Y` + `buildHoltburgTerrain`.
- **`scene3d/camera.js`** — `_safePlayerPos` pre-spawn fallback is neutral, not Holtburg.
- **`index.html`** — removed the `renderHoltburg` 9-LB Holtburg heightmap/object/colour warmup (it only ever fed the now-retired 2D PIXI renderer; the 3D path fetched-then-`free()`d it). The `if (useRenderer3d)` gate stays so `?renderer=2d` still degrades to blank.
- **`smoke_test.cjs`** — the 3 `buildHoltburg*` export assertions repointed to `bakeTerrainRing`/`bakeBuildingsRing`/`bakeStaticsRing` (the wrappers are deleted; the ring functions remain exported for explicit-centre callers/tests).

## Known-benign / follow-ups (none blocking; review confirmed not bugs)
- `?ringRadius` URL flag is now **inert** (the const it drove was deleted). `?staticsRadius`/`?buildingsRadius`/`?agentic=low` still work (LRU sizing + draw distance). url-flags.md not yet updated.
- `index.html`'s `NEIGHBOURHOOD` const (built from Holtburg coords ~2755) is now **dead** (only the removed warmup read it). Harmless; left in place.
- `buildingsReceiveShadowForPlacement` / `staticsReceiveShadowForPlacement` keep unused `worldX/worldY` params (signature parity, commented) — dead-param smell, not a bug.
- **Capture scripts** `capture_phase7_1_terrain.cjs` / `capture_phase7_2_buildings.cjs` assert boot-time Holtburg rendering — they now need a `@telepoi`/spawn + wait-for-streamed-LB step (intentionally obsoleted; not updated here).
- `disposeStaticParticles` is dead code (zero call sites) — noted by review, unrelated.
