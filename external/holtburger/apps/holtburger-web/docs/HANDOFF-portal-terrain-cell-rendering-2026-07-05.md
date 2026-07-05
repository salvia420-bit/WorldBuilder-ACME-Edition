# HANDOFF — terrain ↔ building-interior ↔ env-cell rendering (issues 1–4)

> Written 2026-07-05 after a long session that produced solid **intelligence + a
> fix scaffold** but **ZERO visible rendering progress**. Read this fully before
> touching code. The companion doc
> `docs/RETAIL-PORTAL-RENDERER-AND-CELL-TERRAIN-WATER-RELATIONSHIPS.md` is the
> verified retail ground truth — read it FIRST.

## Blunt status

The user (viewing on a real GPU, R9 290, via cloudflared) reports, verbatim:
> "still can't see inside of buildings from outside, still issue with terrain and
> floor of building fighting, still issue with terrain covering top of dungeons,
> 0 progress."

So: **none of the four rendering symptoms are fixed.** What DID get done is durable
but not user-visible: root-cause analysis, retail-algorithm extraction, and an
(unsuccessful) `?portalStencil` fix scaffold that is **default-OFF and inert** unless
the flag is set.

## ⚠️ Two things I got wrong — fix these assumptions first

1. **I claimed "issue 1 (interiors visible from outside) is already fixed."** My
   evidence was local screenshots of the Yaraq Archmage interior rendered from
   outside. BUT those were taken after teleporting the player INSIDE the env cell
   first (which pre-loads/bakes the cells) and then stepping out. In natural play
   (walking up to a building), the user says interiors are NOT visible from outside.
   **RECONCILE THIS.** Likely one of: (a) `?portalStencil=on` regresses it (see #2),
   (b) outdoorPview only works once cells are baked and they don't bake/stream from
   an outdoor approach, or (c) it's building-specific. **Test with `?portalStencil`
   OFF first to get the true baseline** — do NOT trust my "fixed" claim.

2. **`?portalStencil=on` most likely REGRESSES issue 1 right now.** `tickPortalStencil`
   (cells.js) moves the visible interior cells to `RENDER_LAYER_PORTAL_CELL` (=2), so
   the world pass (mask layers 0|1) stops drawing them. The `PortalStencilPass` is
   supposed to draw them masked to door apertures — but it evidently draws nothing
   visible (empty/mis-projected stencil mask, or flat-grey clipped to nothing). Net:
   with the flag on, interiors that WOULD render via outdoorPview are hidden. Fixing
   the camera crash made this worse (the pass now runs and hides, instead of
   crashing). **If the user tested with my `portalStencil=on` URL, that alone could
   explain "can't see inside buildings."**

## The problem (4 issues → 2 root causes)

From the companion doc (verified against the retail decomp + AC-dev Discord):

- **Issue 1** — building interiors not visible from outside (historically "only NPCs").
  A *visibility/loading* matter, independent of depth.
- **Issues 2/3/4** — terrain (and water, which IS terrain) covers dungeon entrances,
  covers/z-fights building interior floors, and covers ocean-placed dungeons. These
  are **ONE root cause**: our renderer is "acviewer-style" (single shared depth
  buffer, draw-everything, no portal clipping), so the gapless terrain heightfield
  occludes any cell geometry at/below grade. gmriggs (ACViewer's author) names our
  exact bug: *"z-fight between the dungeon floor and overworld water … one of the
  cons of acviewer-style renderer, vs. acclient portal renderer."*

## Retail ground truth (the target — see the companion doc for quotes/anchors)

- Retail is an **iterative portal renderer**: draw current cell → screen-space clip
  to each door/portal polygon (`PView::GetClip` + `ACRender::polyClipFinish`) →
  recurse. Interiors are drawn ONLY within a portal aperture.
- **Per-aperture depth punch**: `D3DPolyRender::DrawPortalPolyInternal` writes
  `gl_FragDepth ≈ 0.99999899` (far) inside the doorway so terrain/walls can't occlude
  the interior there, and outside the aperture nothing is overdrawn (no see-through).
- **Terrain is NOT holed under buildings.** Z-fighting is solved by ONE global
  constant `zFightTerrainAdjust = 0.0099999998` (`acclient.c:46689`) — every terrain
  vertex drawn ~1 cm BELOW true elevation, so floors/objects at grade win depth. NO
  runtime depth bias (`SetDepthBias` only ever called with `0.0`).
- **Ocean dungeons are never drawn from an outdoor camera** — excluded before
  rasterization (no building shell → not in the landblock stablist), NOT
  depth-occluded by water.
- **`SeenOutside` flag** gates which env cells render when the camera is outdoors.
  Our client parses that bit but uses it only for ambient sound, not render.

## What was built (the `?portalStencil` attempt — DEFAULT OFF, inert)

Flag `?portalStencil=on`. Files:
- `apps/holtburger-web/src/lib.rs` — **`getVisiblePortalApertures(mvp, maxDepth)`**
  wasm export. VALIDATED against live Yaraq/Holtburg: returns real world-space (AC
  Z-up) door/window aperture polygons (100+ for a town LB). This part works.
- `scene3d/portal_stencil.js` — `PortalStencilPass`: (a) stencil-mark each aperture
  (depth-tested → no see-through), (b) reset depth to far in the mask, (c) draw the
  portal-visible interior cells **flat grey** (via `scene.overrideMaterial`) masked
  to the aperture. Exports `RENDER_LAYER_PORTAL_CELL = 2`.
- `scene3d/atmosphere_pipeline.js` — composer built with `stencilBuffer:true` when
  on; `PortalStencilPass` added after `worldRenderPass`; sets the pass camera every
  frame; depth texture flipped to `DepthStencilFormat`.
- `scene3d/cells.js` — `tickPortalStencil`: feeds apertures + moves visible interior
  cells to layer 2 (and un-parks them to layer 1 when indoor / on error).
- `scene3d/index.js`, `scene3d/loop.js` — flag parse + wiring. `docs/url-flags.md` — doc row.

**State:** boots clean (0 console errors), the camera-undefined freeze is fixed, the
pass *activates* on real data (`hasWork=true`, e.g. 4 apertures / 3 cells at the
Yaraq Archmage). **But it produces no visible fix and likely hides interiors (see #2).**

## Why the portal-stencil approach fell short (diagnosis)

1. **Wrong shape for half the symptoms.** A door-aperture pass only affects views
   looking THROUGH a door. It does nothing for "terrain covering the TOP of a dungeon
   viewed from above" or floor z-fight when no door is in the sightline. Issues 2/3/4
   have big non-doorway cases this can't touch.
2. **Layer-2 move regresses issue 1** (see #2 above) without delivering the masked draw.
3. **Milestone draws FLAT GREY** — even working, it's not the textured interior; and
   if the mark pass finds no visible doorway pixels (door polygon depth-fails behind
   the building shell/terrain, or projects wrong), the stencil mask is empty → nothing draws.
4. **Stencil attachment unverified on real drivers** — the manual depth-stencil
   texture may conflict with pmndrs's own (reviewer Finding 6); never confirmed the
   stencil buffer is actually bound/working on the R9 290 (SwiftShader was too lenient
   and never even reached the draw because cells=0 headless).

## Recommended next steps (in priority order)

1. **Isolate first.** At one building, screenshot/observe `?portalStencil=off` vs
   `on`. Determine: does OFF (default outdoorPview) show interiors from outside in
   natural play? This decides whether issue 1 is real-open or flag-induced.
2. **Strongly consider the cheap retail win FIRST: `zFightTerrainAdjust`.** Draw
   terrain ~1 cm below true grade globally (write `gl_FragDepth += tiny` in the
   terrain shader — polygonOffset is DEAD under `logarithmicDepthBuffer`; terrain
   already writes log `gl_FragDepth` at `terrain.js:~1353`). This directly targets
   issues 2/3 (floor z-fight + at-grade terrain coverage) the way retail does, with
   none of the stencil complexity. This was under-explored and is probably the
   highest value/effort ratio. Watch commit `5261caf0` (2026-06-26) which raised
   terrain to full collision grade and removed the ±0.3 m visual clamp — that is the
   regression that started burying entrances.
3. **For dungeons/ocean:** the retail answer is portal EXCLUSION (don't draw env-cell
   geometry from an outdoor camera unless reached through a portal). Consider gating
   outdoor env-cell rendering on the retail `SeenOutside` bit instead of the current
   AABB-frustum heuristic.
4. **If continuing the portal-stencil path:** verify the stencil buffer is actually
   attached (`gl.getParameter(gl.STENCIL_BITS)`), log the aperture's projected screen
   coverage and whether the flat-grey draw touches any pixels, and switch the cell
   draw from a flat override to the cells' real (textured) materials cloned with the
   stencil test. Also decide the layer-2 approach only makes sense once the masked
   draw is proven — until then it just hides interiors.
5. **Consider reverting** the `?portalStencil` scaffold (it's flag-off so harmless,
   but it's unvalidated code) OR keep it as clearly-marked WIP. Do NOT ship it on.

## Environment, gotchas, artifacts

**Testing / viewing:**
- **cloudflared tunnels** are UP for R9 290 viewing (tailnet was too laggy; the user
  wanted cloudflared, as a prior "Fable" session used). serve.py →
  `https://worldcat-musicians-forests-shot.trycloudflare.com`, ws bridge →
  `wss://widespread-taking-filters-continental.trycloudflare.com`. URLs +
  teardown in `/mnt/wbterminal1/tmp/cloudflared-tunnels/ACTIVE-0705.txt`. Teardown:
  `pkill -f "cloudflared tunnel"`. These are PUBLIC trycloudflare URLs (scannable);
  tear down when idle. (Tailscale-IP path `http://100.116.47.66:8765` is private but
  laggy over DERP.) Test-URL flags that matter for remote: `bridge_url=wss://<ws-url>/`,
  `server_host=127.0.0.1&server_port=9000`, `nosw=1`.
- **JS changes are LIVE via serve.py** (`scripts/serve.py`, port 8765) — no build;
  reload with `?nosw=1` (SW caches aggressively; only nosw clears it).
- **Local SwiftShader can't judge pixel/stencil fidelity** but CAN do STRUCTURAL A/B:
  calculated camera + `renderOnDemand` + `page.screenshot`. **Cells DO build headless —
  but only with a proper bake-wait** (poll `cellContainers3d` for the LB's cells,
  require a ~2.5 s stability window, up to ~90 s). My quick 18 s probes wrongly
  concluded "cells don't build headless." Copy the wait loop from
  `capture_academy_envcells.cjs`.
- **Capture scripts:** `apps/holtburger-web/capture_yaraq_archmage.cjs` (A/B off/on,
  teleports to the Archmage building, computes an outside-the-door shot; env
  `CAP_ONLY=on|off`); `scripts/multi-agent/{smoke_portal_stencil,diag_cells,aperture_export_probe}.mjs`.
  Run with `NODE_PATH=/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/scripts/multi-agent/node_modules node <script>`.
- **Screenshots:** `/mnt/wbterminal1/holtburger-captures/yaraq-archmage-*.png` (inside
  shows full interior; outside shows terrain grass intruding into a building = issue 3
  reproduced).
- **Test account:** `acadmp1ge522` (single-login — ~25 s+ gap between logins or
  "Account In Use" boots both; coordinate with the user who may be logged in).
- **Archmage Inyamkaya bint Ruz** (issue-1 test building, Yaraq): LB `0x7D64`, env cell
  `0x7D64012E`, `@teleloc 0x7d64012e 87 92 15` (inside), then walk out the big door.

**Build (only if you touch `src/lib.rs`):**
- Memory is tight (8 GB laptop, HD520 iGPU — NO R9 290 here). Free RAM first:
  `kill $(pgrep -f rust-analyzer)`, and the ~1 GB tsserver if needed. The build cgroup
  caps at 3.5 GB with `oom.group` (kills the whole build atomically).
- `cd apps/holtburger-web && cp -a pkg pkg.bak-X && export PATH="/home/wbterminal/.cargo/bin:/usr/local/bin:/usr/bin:/bin" CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 && script -qfc "capped-build wasm-pack build --target web --out-dir pkg --release" LOG`.
  **Use a PTY (`script`) + `debuginfo=0`** — otherwise an OOM kill loses the buffered
  log (empty log + exit 144 == OOM, NOT a code error — I wasted time on this).
  Dev wasm ≈ 18 MB (4× slower), release ≈ 4.7 MB. `pkg/` is gitignored → always rebuild.
  A backup of the pre-change release build is at `pkg.bak-portal-pre-2026-07-05`.
- **1070 real GPU (desktop-4anudo2) is OFFLINE** (last seen 3 h+). When online, use
  the MODE2i recipe in `memory/fleet-runbooks.md`.

**Files changed this session (for review/revert):**
`apps/holtburger-web/src/lib.rs` (new export), `scene3d/portal_stencil.js` (new),
`scene3d/atmosphere_pipeline.js`, `scene3d/cells.js`, `scene3d/index.js`,
`scene3d/loop.js`, `docs/url-flags.md` (row), plus the two docs. It's a git repo at
`external/holtburger`; `git diff` shows everything.
