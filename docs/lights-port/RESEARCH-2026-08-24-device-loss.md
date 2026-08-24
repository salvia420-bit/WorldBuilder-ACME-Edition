# RESEARCH 2026-08-24 — device-loss/reset story (decomp, read-verified)

Fork deliverable for HANDOFF-2026-08-24-rgba-mirror-diet.md ("Device-loss story" research
task). All anchors are `~/ac-headers/acclient.c` line numbers (defs, read-verified in body).

## Verdict (short)

**YES — the client's own machinery already recreates D3DPOOL_DEFAULT textures after a device
reset, because world textures ALREADY live in D3DPOOL_DEFAULT.** `RenderTextureD3D::
CreateD3DTexture` (:685177, 0x00695550) passes `poolD3D = 0` (D3DPOOL_DEFAULT) to
`CreateTexture`/`CreateCubeTexture` for every texture except those with `m_Flags` bit 1 set,
which get `poolD3D = 2` (D3DPOOL_SYSTEMMEM — staging sources for the `UpdateTexture` upload
path, see `RenderTextureD3D::LoadTexture` :685606). **Nothing here uses D3DPOOL_MANAGED for
world textures** (the one managed allocation found at the device level is the 1×1
`m_pSolidColorTexture`, pool 1, `GetD3DResources` :458315 — managed because it is locked at
runtime, :457831).

⚠ **Lane-steering consequence:** the handoff's "D3D9 managed-pool mirrors" hypothesis
(machinery item 2) is WRONG for RenderTextureD3D. The 1,008 MiB of RGBA CPU buffers cannot
be D3D managed-pool shadows; they must be the client's OWN copies — `ImgTex::m_pImageData`
(a `RenderSurface` whose `m_pSurfaceBits` is the CPU pixel buffer), `m_pSystemMemTexture`
(the pool-2 staging texture, which D3D itself backs in sysmem), and TexMerge outputs. The
dump-split and ImgTex-pool research tasks should target those, not managed-pool.

## The loss-detect → release → reset → recreate chain

1. **Detect** — `RenderDeviceD3D::Flip` (:457611): `Present` via the swap chain; retries
   while `D3DERR_WASSTILLDRAWING` (−2005532132); on `D3DERR_DEVICELOST` (−2005530520) sets
   `m_bDeviceLost = 1`. Also set by `GenerateSurfaceFromFrontBuffer` (:457805).
   `RenderDeviceD3D::IsResetPossible` (:457060) = `TestCooperativeLevel` ≠ DEVICELOST
   (returns false and re-marks lost while the device can't be reset yet).
2. **Per-frame check** — `SceneTool::PrepareGraphicsDevice` (:123040) calls
   `Render::CheckForLostDevice` (:381873) every frame: if `m_bDeviceLost` and
   `IsResetPossible`, run `Render::RestartRenderingSystem()`; if that fails → error dialog
   and `_exit(1)`.
3. **Reset** — `Render::RestartRenderingSystem(pres, config)` (:380797) →
   `Render::RestartDevice` → `RenderDeviceD3D::ResetDevice` (:459792):
   `KeyStone::Release()` → **`GraphicsResource::PurgeResources()`** (:131147 — walks the
   global `s_Resources` list, virtual `PurgeResource` destroys each live D3D object, marks
   `m_bIsLost`) → `ReleaseD3DResources` (:457457 — frame-buffer/depth wrapper surfaces,
   primitive vbuf, swap chain, solid-color texture) → `IDirect3DDevice9::Reset` loop (2
   attempts, 10 s timeout each, 200 ms sleeps; `D3DERR_OUTOFVIDEOMEMORY` −2005532292 →
   dialog, fail) → `GetD3DResources` (:458315 — re-wrap backbuffer + depth-stencil (both
   `UnlinkResource`d — the two device surfaces deliberately OUTSIDE the purge/restore list),
   re-get swap chain, recreate solid-color texture) → `OnDeviceDisplayModeChange` →
   `KeyStone::Create()`.
4. **Recreate content** — back in `RestartRenderingSystem` (:380797):
   **`GraphicsResource::RestoreLostResources()`** (:131171 — every lost resource with
   `m_AutoRestore` gets virtual `RestoreResource`) then the **RGR callback list**
   (`Render::m_RGRCallbacks`; registrants found: `DBObj::InitLoad` :124489,
   `SmartBox::ResetDetailTexturing` :144205 via :146399). Restoration is ALSO lazy per-use:
   `RenderTextureD3D::Get2DTextureD3D` (:685453) checks `m_bIsLost` → `RestoreResource` →
   `CreateD3DTexture` on every texture fetch, so anything the eager sweep misses self-heals
   on first draw.

## Where the pixels come back from

`RenderTextureD3D::RestoreResource` (:685423): if the texture's DAT id is valid (≠ the
invalid-DID global `stru_8F88E0`), call the reload virtual (vtbl+84) — the
`RenderTexture::GetSubObjects` path (:136717) = `LoadLevelResources` (:136423, re-reads the
per-level DIDs from the DAT cache) + `ConstructTexture` (:136496, rebuilds + uploads);
otherwise (runtime-generated: TexMerge merged terrain, custom/copied textures) it only
`CreateD3DTexture`s an EMPTY texture — pixels return when the producer re-runs (terrain:
`SmartBox::ResetDetailTexturing` RGR callback + the `bNeedReloadTextures` re-merge).

`bNeedReloadTextures` itself (`Render::UpdateFromPreferences` :380924) is the
LandscapeTextureDetail/EnvironmentTextureDetail pref-change path: it calls
`Render::FlushGraphicsResources` (:380760) = null out stage textures + `PurgeResources` +
`RestoreLostResources` + RGR callbacks — i.e. **retail already ships a
flush-everything-and-rebuild-from-DAT big red button that runs without a device reset.**
It rebuilds ALL GraphicsResources, not just terrain. This is the recreation hook the
Acme plugin should invoke (or imitate) — no need to hand-roll one.

Bonus machinery relevant to the diet: `GraphicsResource::PurgeOldResources(age)` (:131192,
LRU-by-`m_TimeUsed` eviction of thrashable resources) and `DiscardResourceBytes` (:131576)
— `CreateD3DTexture` already loops `DiscardResourceBytes(size)` on
`D3DERR_OUTOFVIDEOMEMORY` (:685177 body). Retail HAS a graphics-side memory governor; it
just never watched CPU-side commit.

## Reset triggers for a windowed client (FullScreen=False)

- **Alt-tab / focus loss: no device loss** for a windowed D3D9 device (only fullscreen
  exclusive loses on alt-tab). Windowed `Flip` presents through the swap chain with
  source/dest rects (:457611) — window moves/drags never touch the device.
- **Resolution / display-pref change**: `Device::ChangePresentation` (:119157) — a
  PROACTIVE `RestartRenderingSystem` (full purge/reset/restore) after `SetWindowLongA` +
  `SetWindowPos`. Same path as loss recovery, so it exercises the identical machinery.
- **Driver TDR / GPU reset, sleep-resume (driver-dependent)**: genuine DEVICELOST at
  `Present` → chain above. On WDDM (Vista+), UAC secure desktop and locking do NOT lose a
  windowed d3d9 device; TDR is the realistic in-the-wild trigger.
- The chain runs every frame regardless (`PrepareGraphicsDevice`), so recovery latency is
  one frame after `TestCooperativeLevel` reports resettable.

## Residual risks for the RGBA-mirror diet

1. `RestoreResource` recreates runtime-generated (invalid-DID) textures EMPTY. Purging a
   TexMerge output outside a reset shows garbage/black terrain until re-merge runs — any
   plugin purge of merged textures must also trip `ResetDetailTexturing`/re-merge (or use
   `FlushGraphicsResources` which does both).
2. Pool-2 (SYSTEMMEM, `m_Flags` bit 1) textures are the sources of the
   `UpdateTexture` upload path (`LoadTexture` :685606, src must have bit 1, dest must not).
   Freeing their bits breaks that copy path — exempt them (they're also where D3D itself
   keeps the sysmem backing, so "free after upload" doesn't even apply).
3. Palette/recolor classes re-read CPU source bits (separate research task; exempt list
   pending).
4. The vtbl+84 reload call in `RestoreResource` is inferred to be the
   `GetSubObjects`/`LoadLevelResources` chain from structure + the `stru_8F88E0`
   (IDClass INVALID id) compare; the decompile at :685423 is this-adjusted and noisy —
   worth a 5-minute PDB vtable-slot confirmation before shipping code that depends on it.
5. `ResetDevice` failure path is `_exit(1)` after 2×10 s — if the plugin makes resets more
   frequent (it shouldn't; it adds no new reset triggers), that hard-exit is the downside.
