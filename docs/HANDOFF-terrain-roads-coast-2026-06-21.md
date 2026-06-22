# HANDOFF — Terrain ROADS + COAST rendering bugs (2026-06-21)

Status: **RESOLVED (smear) 2026-06-21 — root-caused + fixed + validated live on the
1070. Coast: NO change (retail-faithful per-cell texMerge).** See "RESOLUTION" below.

## RESOLUTION (2026-06-21)

The "roads/terrain streaked/smeared in directional bands" was NOT a road-overlay or
TexMerge data bug — live CDP probing of the 1070 session (LB `0xcd9d`, `quality=high`)
showed the road overlay data is correct (slot4 `[32,5,rot,255]` → atlas layer 32 grey
road tile + road mask 5; overlays + masks all present). The smear had **two render-side
root causes**, both measured live:

1. **Anisotropic filtering globally OFF.** `index.js:629` hardcoded
   `setAdapterMaxAnisotropy(1)` (a 2026-05-20 "anisotropy cap" perf experiment, never
   reverted). Live `atlas.anisotropy = 1` while the GPU max is 16 → every adapter
   texture (terrain atlas/road/detail + object surfaces) smeared at grazing angles.
   **Fix:** drive it from the quality preset (`low:1 mid:4 high/ultra:16`), capped by
   `renderer.capabilities.getMaxAnisotropy()`, with `?anisotropy=N` override
   (`quality.js` + `index.js`).
2. **Base tiles rendered 1× instead of retail 2×.** Live `uBaseTexTiling = [1,…]` (the
   silent fail-soft fallback). The DAT says `texTiling == 2` for **all 33** terrain
   types (confirmed via WB.Terminal `get-terrain-textures`). **Fix:** flipped
   `BASE_TEX_TILING_FALLBACK` `fill(1)`→`fill(2)` (`terrain.js:625`) so a missing/late
   LUT fetch still renders at the correct 2× tiling.

**Validation (smear):** fresh reload of the live 1070 session →
`uBaseTexTiling=[2,…]`, `atlasAnisotropy=16`. Road renders as a distinct cracked-stone
strip; grass regains blade detail. Before/after: `/mnt/wbterminal1/tmp/claude-scratch/
terrain-roads-coast/BEFORE-AFTER-road.png` + `fixed-cd9d.png`.

3. **TexMerge "big blocks" + "two-lane road" (added after user feedback).** With the
   smear fixed, the user reported the terrain painting still looked like "big blocks" and
   the road was a "two-lane highway" that should be a single lane. Diagnosed live: the
   road bit sits on a SINGLE vertex column (`gx=5`), but the texMerge composite paints a
   road overlay in BOTH adjacent cell-columns (`iu=4` AND `iu=5`), each with a near-full
   road alpha mask (`road0`=idx5, `road2`=idx7 decode ~solid) → the road fills ~2 whole
   cells = two lanes; and the per-cell flat base tiles read as hard "big blocks." A live
   A/B (`uTexMergeEnabled=0`) showed the **bilinear** path cross-dissolves the 4 cell
   corners → smooth terrain (no blocks) AND runs the legacy road painter, which
   `smoothstep(0.85,0.95)`-narrows the road to retail `_road_width` (~5 m,
   acclient.c:467318) = ONE centered lane. **Fix:** `readTexMergeFlag()` → DEFAULT OFF
   (opt-in `?texMerge=on`), `terrain.js`. A/B: `terrain-roads-coast/AB-merge-road.png`,
   `merge-on.png` vs `merge-off.png`.

**Coast (CORRECTION):** my earlier call — "coast hard edge is retail-faithful, do not
bilinear-smooth" — was overruled by the user (the retail authority). Flipping texMerge
default-off ALSO routes the coast through the bilinear blend, softening the land/water
transition, which the user prefers (reads as classic AC). The texMerge SELECTION half is
still bit-exact vs the decomp; its pixel composite (road width/rotation, cell-edge
hardness) needs real work before it can default-on again — kept opt-in until then.

---

## (original report)

Status: **OPEN — diagnosed as real, not yet root-caused or fixed.** User-reported,
confirmed live on the GTX 1070 at `quality=high`.

## 1. Symptom (confirmed, NOT a quality artifact)

Standing on a coastal landblock (`0xcd9d`, player pose `0xcd9d0021`), two terrain
defects, both still present at **`quality=high`** (verified `urlQ: quality=high`,
so triplanar is ON — these are not the `quality=low` planar-UV smear):

- **ROADS / terrain texture:** the ground texture is **streaked/smeared in
  directional bands** even on flat grass; a road does **not** render as a distinct
  dirt/stone strip — it reads as smeared grass.
- **COAST:** the land→ocean boundary is a **hard, blocky edge** with flat water
  right up against the land — no graded shoreline; green clumps sit at the waterline.

Evidence screenshots (durable copies):
`/mnt/wbterminal1/tmp/claude-scratch/terrain-roads-coast/0xcd9d-quality-{low,high}.png`
(both quality tiers show it; re-capture is trivial via §3).

## 2. System + code map (where the bug lives)

AC terrain texture blending = **TexMerge**. Roads are a terrain *Road* overlay; the
coast is a land-tile ↔ `WaterDeepSea` alpha transition. Both render hard/smeared.

DATA side (faithful per prior reconciliation — see [[project_terrain_reconciliation_2026-06-20]]):
- Terrain word: **road bits 0-1** (`TERRAIN_MASK_ROAD 0x0003`), type bits 2-6
  (`0x007C`). `external/holtburger/crates/holtburger-dat/src/landblock.rs:69-79`.
- Road alpha overlay: `RoadAlphaMap` + `road_maps` —
  `external/holtburger/crates/holtburger-dat/src/file_type/region.rs:707-723, :809`;
  `road_width` `:98`.
- TexMerge port (32-bit-wrap, verified faithful): `crates/holtburger-dat/src/terrain_merge.rs`.

RENDER side (the likely FIX site) — `external/holtburger/apps/holtburger-web/scene3d/terrain.js`:
- **Roads are painted inside the terrain SHADER** (`uRoadEnabled` block), bilinear-
  blend on the per-vertex road flag, matching retail `_road_width`
  (acclient.c:467318). `terrain.js:18-21`.
- `acquireVertexTypesTex(terrainCodes, roadCodes)` → 9×9 RGBA8 where
  **G = roadCode*64**. `terrain.js:313-328`.
- `mergeDataTex` = 48×8 RGBA8 TexMerge DataTexture (`?texMerge=on`). `terrain.js:339+`.
- Water type table incl `WaterDeepSea=20`. `terrain.js:96-102`.

## 3. How to reproduce + probe the LIVE session (the key technique)

The user plays on the GTX 1070 (real GPU). Their Chrome exposes **CDP on
`127.0.0.1:9333`** (the desktop `Holtburg (Chrome).lnk` launches with
`--remote-debugging-port=9333 --remote-allow-origins=*`). To probe/screenshot their
LIVE outdoor real-GPU session:

1. Reverse tunnel from the laptop (serve.py is loopback-only on :8765):
   `ssh -fN -R 18765:127.0.0.1:8765 -R 18080:127.0.0.1:8080 young@100.127.215.75`
2. Run a node script **ON the 1070** (`C:\Temp`, Playwright at
   `C:\Temp\node_modules\playwright`): `chromium.connectOverCDP("http://127.0.0.1:9333")`,
   find the holtburger page, `page.evaluate(...)` / `page.screenshot({path:"C:/Temp/x.png"})`.
   **DO NOT `browser.close()`** — it kills the user's session. Invoke via
   `ssh young@100.127.215.75 'node C:\Temp\<script>.cjs'`; pull PNGs with `scp`.
3. Renderer must read `ANGLE (NVIDIA … Direct3D11)`. Headless or SSH-launched headed
   chromium does NOT work (SwiftShader / no WebGL context); only the user's own
   debug Chrome on :9333 gives the real GPU. (Earlier full saga: `schtasks` into the
   interactive console session is the only way to launch a fresh real-GPU Chrome.)
4. Reusable scripts left under `C:\Temp`: `cdp-snap2.cjs` (quality+pose+screenshot),
   `cdp-spin.cjs` (360° via `cameraSwitcher.followYaw`), `cdp-watch3.cjs` (auto-capture
   on teleport ≥8 LBs from Holtburg + outdoor). Camera:
   `liveScene3d.cameraSwitcher.{followYaw,followPitch,followDistance}` — restore after.

## 4. Hypotheses to chase (start here)

1. **Road smear:** read the `uRoadEnabled` shader block in `terrain.js` — the road
   overlay's UV / blend looks stretched. Check the road-flag bilinear blend + the
   road texture sampling UVs + the `roadCode*64` G-channel encoding round-trip.
2. **Flat-grass streaking (not just road):** base terrain texture splat/atlas UVs may
   be stretched per-cell — possibly the texture-coordinate generation or the TexMerge
   alpha sampling. Could relate to the per-cell split diagonal (C-1, shipped 893dc61f)
   or to ClampToEdge-vs-RepeatWrapping on tiling DataTextures (see
   [[project_tree_trunk_flat_texture_clamp_wrap_2026-06-19]] — UV>1 collapses to the
   edge texel → smear; check the terrain atlas/road/alpha texture wrap modes).
3. **Coast hard edge:** how is `WaterDeepSea` (type 20) textured, and does TexMerge
   blend land *into* water via the corner/side alpha maps, or hard-cut at the tile
   boundary? A missing/zero water-transition alpha → the blocky shoreline.

## 5. Cross-reference tools

- **WB.Terminal `get-terrain-textures`** (shipped 38f25afe) dumps the TexMerge chain
  for an LB incl `roadMaps` + corner/side alpha maps — compare DATA vs RENDER for
  `0xCD9D`. (`WorldBuilder.Terminal/bin/Release/net8.0/`, `RetailSmoke.wbproj`.)
- Retail truth: acclient.c road `_road_width` @467318; `~/ac-headers/` decomp;
  three-source cross-ref (acclient + ACE + DAT).

## 6. Notes
- Bug is confirmed at `quality=high` (triplanar on) — do NOT chase it as a preset issue.
- Separate from the (resolved) "no trees" thread: scenery renders fine; that was
  `quality=low` + open town areas. The desktop link is now `quality=high`.
- Related: [[project_terrain_reconciliation_2026-06-20]],
  [[project_terrain_black_and_indoor_floor_zfight_2026-06-15]] (terrainMod),
  [[reference_ac_terrain_textures]].
