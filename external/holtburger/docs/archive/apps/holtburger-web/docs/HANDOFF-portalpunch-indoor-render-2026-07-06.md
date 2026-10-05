# HANDOFF — portalPunch interior reveal: near-plane clip + the indoor gap (2026-07-06)

Picks up from the R9 290 render regression debug (2026-07-06). Two commits landed
on `master` (pushed); this doc is the **remaining work** the user flagged after
validating them.

## TL;DR

`portalPunch` (the retail per-aperture depth punch that stops terrain covering
env-cell / cave / building entrances) now works **outdoor → interior** without the
"near geometry vanishes as you walk up" bug. But two things are still wrong:

1. **Doorway interior blinks off as you step into it.** The near-plane fix is a
   *cull* (drop the whole aperture) — too conservative. Upgrade cull → **near-plane
   clip** (keep the visible part).
2. **The reveal only works from OUTSIDE, on the terrain.** Once you're **inside a
   building interior cell / the env-cell itself**, the fix does nothing —
   `portalPunch` is armed only when the camera is outdoors (`!isIndoor`). The
   indoor case (looking out an entrance from inside, and cell↔cell inside a
   dungeon) is unhandled. This is the **indoor portal renderer** —
   `DESIGN-indoor-portal-clip-2026-07-06.md` Milestone R — and its wasm
   foundation (`getPViewCellClips`, Milestone W) is already **done + committed**.

Both need a **real GPU** to validate (R9 290 or 1070). **SwiftShader cannot
reproduce any of this** — it clips the degenerate polygons the real GPU chokes on,
so headless testing confirms wiring/data only, never the pixels.

## What already shipped (committed + pushed, master)

- **`5a6edc52`** — portalPunch near-plane over-punch fix + cell-static depth bias +
  `getPViewCellClips`.
  - `nearPlaneCullApertures` in `scene3d/cells.js` (feeds both `tickPortalPunch`
    and `tickPortalStencil`): drops any aperture with a vertex within the near
    plane (`clip.w < 0.2 m`). This is the JS stand-in for retail's `ConstructView`
    sidedness reject + `DrawPortalPolyInternal` `polyClipFinish` screen-clip.
  - `portalPunch` is **default-ON** again (`scene3d/index.js` ~3680), with the fix.
  - `getPViewCellClips` / `get_pview_cell_clips` in `src/lib.rs` — per-cell clipped
    NDC aperture polys from the PView BFS (Milestone W; foundation for the indoor
    renderer). Returns `Vec<u32>` (cell ids exceed 2^24 → NOT f32; coords are
    `f32::to_bits`). Verified live: exact set-equality with `getRenderSetWithPView`,
    nested to BFS depth 4.
- **`2853c8c8`** — torch-immersion lighting (player-ref light sort, pool 8→16,
  hysteresis). Unrelated to the render bug; committed because it was uncommitted WIP.

## Root cause (verified: decomp + live data)

`SessionHandle::get_visible_portal_apertures` (`src/lib.rs`) emits the **raw
world-space** aperture polygons, filtered ONLY by a coarse building-AABB frustum
test — **no near-plane clip, no sidedness check**. Retail does neither so loosely:
- `PView::ConstructView` (acclient 0x5A59A0) computes the portal-plane **sidedness**
  vs the camera and returns early if the camera is behind/past it.
- `D3DPolyRender::DrawPortalPolyInternal` (0x…453882) runs `ACRender::polyClipFinish`
  (Sutherland–Hodgman **screen clip**) before punching depth (`DEPTHTEST_ALWAYS`,
  writes far-Z, `CULLMODE_NONE`).
- Our own `get_render_set_with_pview_internal` already near-plane clips
  (`pview_clip_polygon_against_polygon`, `z+w>=0` homogeneous).

Our punch pass (`scene3d/portal_punch.js`) draws the raw apertures with
`depthFunc=Always`, `frustumCulled=false`, `DoubleSide`. **Live proof** (camera
0.4 m from a real doorway): 2 of 14 apertures fall behind the near plane, NDC blows
past 1.3 → the punch stamps far-Z over a huge near-screen region → the cells pass
overdraws → near terrain/statics vanish. On the R9 290 this rasterizes over that
huge area; SwiftShader clips it, which hid the bug for a whole session of
flag-bisecting before the decomp read caught it. (Lesson recorded: ground in the
decomp/code first, don't bisect by hypothesis.)

## Remaining issue 1 — doorway interior blinks off up close

**Cause:** `nearPlaneCullApertures` drops the WHOLE aperture when any vertex is
within the near plane. As you step into a doorway its near edge crosses the near
plane → the aperture is culled → its interior stops being punched → the interior
pops off for the last ~0.5 m before you transition indoors.

**Fix:** replace the cull with a proper **near-plane clip** (Sutherland–Hodgman
against `z+w>=0` in clip space), keeping the in-front part so the interior stays
revealed. Two clean options:
- **Wasm** — clip inside `get_visible_portal_apertures` and emit the clipped poly.
  Awkward: the output is world-space; clip-space clipping then needs un-projection.
- **JS (preferred)** — clip in `nearPlaneCullApertures` (it already has the MVP):
  transform aperture verts to clip space, Sutherland–Hodgman clip against the near
  plane, and have the punch render the **clipped NDC polygon directly** (skip the
  modelViewProjection, feed NDC positions like `getPViewCellClips` returns). This
  also removes the world→GPU near-plane dependency entirely. Reuse the clip math
  from `pview_clip_polygon_against_polygon` (mirror it in JS or expose it).

Cheap and self-contained; still needs the R9 290 to confirm no pop and no
over-punch.

## Remaining issue 2 — the reveal is OUTDOOR-only (the indoor gap)

`preFrameSkySync` arms the punch/split only when `punchActive = portalPunch &&
!isIndoor && portalPunchPass.hasApertures` (`scene3d/atmosphere_pipeline.js` ~637).
So the moment you're inside an env-cell/building interior, `portalPunch` disarms and
the interior renders through the plain shared-depth path. That leaves unhandled:
- **Indoor → outdoor**: standing inside a cave/building looking OUT the entrance —
  is terrain/exterior occluding/z-fighting the opening? (Same class as the outdoor
  bug, opposite direction — needs an aperture punch for the exit.)
- **Indoor → indoor (cell↔cell)**: the retail portal renderer proper. Adjacent
  dungeon cells' coincident two-sided walls, only clipped-away by drawing each cell
  masked to the doorway it's seen through. This is **Milestone R** in
  `DESIGN-indoor-portal-clip-2026-07-06.md`. Its wasm feed (`getPViewCellClips`,
  Milestone W) is **already built** — it returns each visible cell's clipped NDC
  aperture polygon (current cell = full viewport). What's missing is the JS
  **`IndoorPortalClipPass`** that draws the current cell unclipped, then each
  neighbor stencil-clipped to its `getPViewCellClips` polygon (+ per-aperture depth
  punch — the decomp punches indoors too, in `ConstructView`'s recursion).

Read `DESIGN-indoor-portal-clip-2026-07-06.md` before starting Milestone R — it has
the decomp mechanism, the stencil-vs-software-clip translation (trevis + gmriggs on
Discord independently chose **stencil**), the perf caveats, and the honest
cost/benefit (the devs deprioritized cell↔cell: "99% of the time it's fine without
it… just rendering everything"). Note: AC cell geometry is authored **two-sided**
(`sides_type==1`, measured `{1: 712}` over 60 Marketplace cells), so per-poly cull
is a no-op for cells and can't fix the coincident-wall fight — only the clip can.

## Code map

| What | Where |
|---|---|
| Aperture generator (the raw, unclipped source) | `src/lib.rs::get_visible_portal_apertures` |
| Near-plane cull (issue-1 fix site; upgrade to clip here) | `scene3d/cells.js::nearPlaneCullApertures` + `tickPortalPunch`/`tickPortalStencil` |
| Punch pass (depthFunc=Always, world-space aperture mesh) | `scene3d/portal_punch.js` |
| Split arming (`punchActive`, outdoor-only gate) | `scene3d/atmosphere_pipeline.js` `preFrameSkySync` (~637) |
| portalPunch default flag | `scene3d/index.js` (~3680) |
| Indoor clip-poly feed (Milestone W, done) | `src/lib.rs::get_pview_cell_clips` / `getPViewCellClips` |
| PView BFS + near-plane clip reference | `src/lib.rs::get_render_set_with_pview_internal`; `holtburger_world::pview_clip_polygon_against_polygon` |
| Indoor renderer design | `docs/DESIGN-indoor-portal-clip-2026-07-06.md` |
| Retail portal-renderer facts | `docs/RETAIL-PORTAL-RENDERER-AND-CELL-TERRAIN-WATER-RELATIONSHIPS.md` |

Decomp (`$DECOMP/acclient.c`): `PView::ConstructView` (sidedness), `PView::DrawCells`
/ `DrawInside`, `D3DPolyRender::DrawPortalPolyInternal` (453882, `polyClipFinish` +
depth punch), `Render::set_view` (380479, the screen-space clip polygon).

## How to reproduce / validate (must be a real GPU)

- **SwiftShader (headless MCP) cannot show these bugs** — it clips the degenerate
  polys. Use it only for data checks (aperture counts, NDC/w of aperture verts,
  set-equality) — those are GPU-independent and were how the root cause was proven.
- **R9 290 (the user's, remote)** reproduces all of it. A cloudflared tunnel is
  set up: `proxy.cjs` (:7080, fronts serve.py :8765 + wsbridge `/wsbridge`→:8080),
  one `cloudflared` quick tunnel → `https://<host>.trycloudflare.com`. App URL uses
  the directory path (`/apps/holtburger-web/?...`, not `index.html`) with
  `bridge_url=wss://<host>/wsbridge`. Tunnel URL is ephemeral (dies on reboot;
  logs in `/mnt/wbterminal1/tmp/cloudflared-tunnels/`). See the session where it
  was stood up.
- Repro: outdoors near Holtburg buildings / a cave entrance. Issue-1: walk up to a
  doorway, watch the interior blink off. Issue-2: enter the building/cave and look
  around / out.
- Headless aperture check (paste into devtools with a live scene): fetch
  `getVisiblePortalApertures(mvp,0)`, project each vertex with the MVP, count how
  many have `w <= 0` (straddling) — should be 0 after the clip upgrade.

## Discipline note (why this doc exists)

The batch that caused this (portalPunch default-on, stablist, horizonFade, clouds,
torch-immersion) shipped **default-on with only SwiftShader "wiring confirmed"**
behind it — none eye-tested on a real GPU. That's the actual root problem. Rule
going forward: **nothing render-visible flips default-on until it's seen on the
R9 290 or 1070.** `horizonFade` and `perPolyCull` are still default-on and still
un-validated on the R9 290 — treat as suspect.
