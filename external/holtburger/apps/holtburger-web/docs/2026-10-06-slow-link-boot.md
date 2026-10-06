# Slow-link cold boot (666 kbps) — 2026-10-06

Owner question: "at work on my 666 kbps it can take like 10 mins to load up the game".
Measured on the 1070 (Chrome 154, fresh profile per run, off-screen + muted) through a
laptop-side throttle (`one shared 666 kbps pipe` for every connection incl. the game
WebSocket, 40 ms one-way delay, HTTP/1.1 — i.e. the Tailscale-direct shape; the Cloudflare
tunnel gives the browser HTTP/2/3, which interleaves better but moves the same bytes).

## What the default client downloaded (before)

Unthrottled census, Holtburg spawn, preset `mid` (the default), until the spawn ring
stopped streaming: **285 MB / 9,552 requests** (~60 min at 666 kbps).

| class | MB | note |
|---|---:|---|
| statics textures (shards) | ~138 | 91 xu7 upscaled lossless, 29 raw DAT RenderSurface, 18 BC7 |
| terrain array t1024 | 65 | all 29 terrain surfaces × colour+nra, whatever is nearby |
| texchan roughness/AO sidecars | 24 | 616 requests |
| `manifest/eor-cell.bin` | 14 | 805k entries, sha prefixes — incompressible; 296 entries used |
| static images | 30 | terrain detail normals 9, macro 9, atmosphere EXRs 7.4, moons 3.4 |
| code | 6.5 | 376 unbundled JS files (3.95 MB) + wasm 2.1 MB gz |
| boot.hba + eor-portal catalog | 3.3 | |
| ALL other world data | ~3 | geometry, cells, setups, animations, palettes |

Shaped run (before): login at 108 s, in-world 125 s, 3D scene object 493 s, buildings ~9 min,
**no terrain and no sky at 30 min** (the 65 MB terrain array only STARTED at 24 min; the
atmosphere EXRs never completed). Second visit with an intact cache: in-world in 20 s,
0.6 MB — but the public quick tunnel's hostname changes on every cloudflared restart,
which empties every player's cache.

## What changed

1. **Terrain is not gated on 1024².** `?terrainT1024` absent now means `auto`: the tier
   ladder boots terrain at t128 (1.2 MB) from the pack slice when `?packSource` is armed,
   else from the static derived tier `scene3d/assets/terrain_bc7/t128/`
   (`node scripts/derive-terrain-t128.mjs` — mip-sliced from t1024, byte-identical to the
   pack slices), then promotes in place. Fast link: t1024 (look unchanged). Low tier: t512.
   `?terrainT1024=legacy` = the old t1024-first boot. The one-time terrain setup chain
   that `resolveTerrainRingOpts` awaits before ANY terrain mesh had three more walls,
   each found by a shaped run and fixed in turn: (a) its records rode the normal
   (low-priority FIFO) lane behind the statics flood → `fetch_terrain_textures` /
   `_detail_textures` / `_alpha_masks` now use `prefetch_urgent`; (b) with BC7 active it
   still decoded all 29 unique 512² retail tiles (~11 MB) only to discard the RGBA8
   atlas → `fetch_terrain_textures(only_codes)` and the BC7 arm fetches only RoadType
   (code 32) for the road overlay, resolving the BC7 atlas first; (c) the chain read the
   Region record without ever prefetching it (it relied on a slower caller) → an urgent
   `ensure_region_resident` in all four Region readers.
2. **Regional cell catalogs.** `manifest.json` `catalog_regions` (holtburger-manifest
   `CatalogRegions`): `eor/cell` is fetched per 8×8-landblock region
   (`manifest/regions/eor-cell/<rrr>.bin`, all 1,024 written —
   `node scripts/split-catalog-regions.mjs --write-manifest`). Holtburg ring: 6 regions,
   27 KB instead of 14 MB. Older clients ignore the field. A region 404 is a deploy fault
   (loud), never "absent".
3. **`?bandwidth` tier** (`scene3d/bandwidth_tier.js`; Options → Graphics → Downloads).
   Auto-measured from the page's own boot downloads. `low` skips: statics full-tier
   upgrades (xu7/BC7/pre), texchan sidecars, terrain detail normals + macro, the
   atmosphere download (GPU bake); terrain promotes to t512.
4. **Sky / `ready` no longer wait on downloads.** `?atmosphereLut`: low ⇒ GPU bake
   (745 ms on the 1070); high ⇒ EXR download raced against a GPU bake after 15 s.
5. **Boot chain.** Plugin manifests fetched concurrently (was ~49 serial round-trips);
   the wasm is preloaded from `<head>`; the public front (`scripts/proxy.cjs` +
   `scripts/shell_gate.cjs`) serves the T11 bundle (`index-bundled.html`, ~1.1 MB gzip,
   15 JS files) while it is provably current, rebuilding it in the background otherwise;
   serve.py now compresses `shell/`; the bundle carries a lazy plugin registry so runtime
   plugins share one module instance with the app (T11-D4).

6. **Login on a saturated link.** Validation found the handshake itself is the next
   wall: with cold-boot downloads sharing the line (and the session on the main thread
   until the net worker's script arrives), Connect→CharacterList measured ~27 s — past
   the auto-login's 25 s budget and inside a hair of the session's 30 s deadline (a
   pre-change warm run had also died this way). The low-tier sky bake now waits for
   in-world; the auto-login connect budget is 45 s on a low session; the wasm session's
   CharacterList deadline is 60 s (still bounded — the 2026-07-18 flood fix stands).

## Results (same rig)

| | before | after |
|---|---|---|
| unthrottled cold total | 285 MB / 9,552 req | 270 MB / 9,283 req (tier high: same look) |
| JS on the wire | 384 files / 3.95 MB | 15 files / 1.35 MB |
| cell catalog | 14 MB | 27 KB |
| `ready` (fast link) | 14 s | 6 s |
| 666 kbps: login / in-world | 108 s / 125 s | 80 s / 97 s |
| 666 kbps: 3D scene + sky (`ready`) | 493 s / never (30 min) | 106 s / 106 s |
| 666 kbps: terrain on screen | none at 30 min | 3.4 min (t128, roads; t512 at ~8 min) |
| 666 kbps: total to converge the ring | ~285 MB (≈ 60 min) | 47–65 MB (13–15 min) |

Shaped-run series (same rig, fresh profile each): F2 = items 1–5 only (terrain 13.4 min);
F4 = + urgent terrain lane (7.7 min); F5 = + road-tile-only fetch (3.4 min); F6 = + the
Region prefetch (confirmation). Ring size varies with time of day: the authored-fog cap
(`cells.js` FOG_RING_CAP) shrinks the radius-5 ring (121 LBs) to radius 4 (81) at night.

Deploy notes: `proxy.cjs` and `serve.py` changes take effect on restart (both run
in production — restarting drops live tunnel sessions, so it is the owner's call).
The JS/wasm/dist changes are live on disk already (serve.py serves the tree).
