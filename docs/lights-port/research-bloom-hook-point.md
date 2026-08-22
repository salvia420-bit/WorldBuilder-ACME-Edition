# Post-world / pre-UI hook point for AcmeBloom — research (2026-08-22)

> Explore-agent report. Map-build VAs (mapRVA+0x401000).

## 1. Per-frame call graph (map-build VAs = mapRVA + 0x401000)

Frame driver is `Client::UseTime` (login/idle path duplicates it in `Client::KeepUIAlive`). Verified in `/home/wbterminal/ac-headers/acclient_2013.bndb_pseudo_c.txt` @ `00411c40`:

```
Client::UseTime                      0x00411FA0   (map 0x00010FA0)
 ├ Timer::update_time
 ├ Device::DoEventLoop               0x00439E50
 ├ ClientNet::UseTime / PacketController::UseTime / DBCache::UseTime
 ├ UIElementManager::UseTime         0x0045D0B0   (UI *logic*, no drawing)
 ├ SmartBox::UseTime
 ├ SceneTool::PrepareGraphicsDevice  0x0043E690
 ├ SceneTool::StartFrame             0x0043E6A0   -> tailcall SceneTool::BeginScene
 │   └ SceneTool::BeginScene         0x0043DC70
 │       ├ RenderDevice::vfptr->Clear(7,black,1.0)
 │       └ RenderDevice::vfptr->BeginScene -> RenderDeviceD3D::BeginScene 0x005A0D90
 │                                             -> IDirect3DDevice9::BeginScene (slot 41)
 ├ SmartBox::Draw                    0x00455610   ======== ENTIRE 3D WORLD ========
 │   └ SmartBox::DrawNoBlit          0x00454CC0
 │       ├ SmartBox::SetNormalMode   0x00453160
 │       ├ SmartBox::update_viewer   0x00453D80
 │       └ SmartBox::RenderNormalMode 0x00453B40
 │           ├ [outdoor] LScape::update_viewpoint / Render::update_viewpoint
 │           │            Render::set_default_view 0x0054FB60
 │           │            Render::useSunlightSet(1)
 │           │            LScape::draw            0x00506D90
 │           │              ├ GameSky::Draw(sky, 0)   0x00507A50   <- skybox/celestials
 │           │              ├ LScape::draw_check_blocks 0x005069E0
 │           │              ├ for each block: RenderDevice::vfptr->DrawBlock
 │           │              │                  -> RenderDeviceD3D::DrawBlock 0x005A28D0  <- terrain
 │           │              └ GameSky::Draw(sky, 1)   <- weather (if LScape::weather_enabled)
 │           ├ [indoor]  RenderDevice::vfptr->DrawInside -> RenderDeviceD3D::DrawInside 0x005A01E0
 │           │            -> PView::DrawCells 0x005A5950
 │           │                 ├ LScape::draw 0x00506D90
 │           │                 ├ D3DPolyRender::FlushAlphaList(0.0f) 0x0059E3F0
 │           │                 ├ render_device->Clear(4=Z, ...)   (depth-only re-clear)
 │           │                 └ per-cell: SetCurrentMaterial/SetSurfaceArray/positionPush/DrawEnvCell
 │           ├ D3DPolyRender::FlushAlphaList(0.0f)  0x0059E3F0   <<< LAST 3D DRAW OF THE FRAME
 │           ├ SmartBox::target_callback(...)        (target bbox, screen-space rect calc only)
 │           └ SmartBox::m_renderingCallback()       <<< client-provided hook slot, fires here
 ├ SceneTool::EndFrame(1)            0x0043FCD0   ======== UI + PRESENT ========
 │   if (RenderDevice::render_device->m_bOpenScene) {
 │     save m_viewportX/Y/W/H + m_ViewportAspectRatio
 │     vfptr->SetViewport(0,0,GetDisplayWidth(),GetDisplayHeight(),0)   <- full backbuffer
 │     if (bDrawUI && SceneTool::m_RenderUIObjects)
 │        RenderUI::RenderObjects()  0x004488A0   <<< FIRST 2D UI DRAW (chat/panels/bar/radar)
 │        KeyStone::Update()         0x00557840
 │     if (SceneTool::m_pProfilerUI) ProfilerUI::Render()   0x005DA8F0
 │     if (SceneTool::m_pDebugConsole) DebugConsole::Render() 0x00692470
 │     SceneTool::RenderDebugHUD()   0x0043F7F0
 │     restore viewport + aspect
 │     vfptr->EndScene  -> RenderDeviceD3D::EndScene 0x005A0E10  (IDirect3DDevice9::EndScene slot 42)
 │     vfptr->Flip      -> RenderDeviceD3D::Flip    0x005A0F60
 │                          m_pPrimarySwapChain->Present(...)  (IDirect3DSwapChain9 slot 3)
 │                          SetStageTexture(0..7,null); D3DPolyRender::ResetDynamicBuffers;
 │                          Profiler::ResetFrameStats(); ++m_nFrameStamp
 │     SceneTool::UpdateFPSCounter() 0x0043E6B0
 │   }
 └ Device::DoFrameSleep              0x004392B0
```

Note: `RenderDevice::Begin/End` (0x00550850 / 0x005502A0) and `RenderDeviceD3D::Begin/End` (0x005A3310 / 0x005A2C50) are **startup/shutdown**, not per-frame. Do not confuse with BeginScene/EndScene.

## 2. The exact 3D→2D boundary

**Last 3D-world draw:** `D3DPolyRender::FlushAlphaList(0.0f)` @ **0x0059E3F0**, called from the tail of `SmartBox::RenderNormalMode` @ 0x00453B40. Decomp (`bndb 00453b8b`):

```c
    }                                        // end outdoor/indoor branch
00453b8b  D3DPolyRender::FlushAlphaList(0f); // last geometry submitted
00453bd4  void (*m_renderingCallback)() = this_1->m_renderingCallback;
00453bde  if (m_renderingCallback) m_renderingCallback();
```

**First 2D-UI draw:** `RenderUI::RenderObjects()` @ **0x004488A0**, called only from `SceneTool::EndFrame`. It walks `RenderUI::s_hlObjects` (0x0083A334) calling each `UIObject::vtable[+4]`. Every game UI panel registers there via `UIRegion` → `RenderUI::LinkObject` (0x00449320) / `UIElementManager::DrawRegionWithObject` → `RenderUI::LinkObjectAfter` (0x00449290). So chat, panels, spell bar, radar are *all* inside that single call.

**Winner: `SceneTool::EndFrame(bool)` @ 0x0043FCD0, hooked at ENTRY.** Nothing at all executes between `SmartBox::Draw` returning and this function; the 3D scene is complete, no UI pixel has been written, `m_bOpenScene == 1`, viewport is still the 3D game viewport, and the scene depth buffer is intact.

Rejected alternatives:
- `PView::DrawCells` end (0x005A5950) — indoor-only, called per portal-view, runs many times/frame.
- `D3DPolyRender::FlushAlphaList` exit (0x0059E3F0) — called 2+ times per frame (once inside `PView::DrawCells`, once at RenderNormalMode tail); no unambiguous "final" invocation.
- `RenderUI::RenderObjects` entry (0x004488A0) — correct boundary and viewport is already full-display, but gated on `bDrawUI && SceneTool::m_RenderUIObjects` (0x00818C0C), so it silently stops firing if UI rendering is toggled off.
- `RenderDeviceD3D::EndScene` (0x005A0E10) — this is where Chorizite already hooks; it is **after** the UI.
- There is **no** `Set2DView`/`Begin2D`/ortho-setup function. The map has only `Render::Set3DView` (0x0054BE30) / `Render::Set3DViewInternal` (0x0054FC80) and `SceneTool::IdentityMatrices` (0x0043F5D0). The UI is drawn with pre-transformed vertices; there is no distinct 2D-mode entry point to hook.

Zero-detour alternative worth knowing: **`SmartBox::m_renderingCallback`**, a `void(__cdecl*)()` slot at **offset 276 (0x114)** of `SmartBox`, invoked at 0x00453BDE right after the final `FlushAlphaList`. Reachable as `*(void**)((byte*)Client::GetInstance()[0x004114C0] + 288 /*smartbox_*/ + 276)`. Downside: only fires when `player != 0 && viewer_cell != 0` (in-world), so it dies at char-select/portal-space. Setter `SmartBox::SetRenderingCallback` is inlined (present in PDB, not in the map).

## 3. Render-target / backbuffer access at that point

The client renders **directly into the swapchain backbuffer**. It never switches RTs mid-frame.

`RenderDeviceD3D::GetD3DResources` @ **0x005A1B40** (bndb `005a0a30`), run once at device init:

```c
m_pDirect3DDevice->vtable->GetRenderTarget(m_pDirect3DDevice, 0, &surf);   // slot 38
RenderSurface* s = this->vtable->CreateSurface();
this->m_pFrameBufferSurface = s;      // RenderSurfaceD3D wrapping the backbuffer surface
...
this->m_pRenderTarget = m_pFrameBufferSurface;  AddRef
this->m_RenderTargetWidth/Height = m_pRenderTarget->width/height
m_pDirect3DDevice->vtable->GetDepthStencilSurface(...) -> m_pDepthStencilSurface/m_pDepthStencilTarget
m_pDirect3DDevice->vtable->GetSwapChain(dev, 0, &this->m_pPrimarySwapChain);   // slot 14
m_pDirect3DDevice->vtable->CreateTexture(dev,1,1,1,0,0x15/*A8R8G8B8*/,1,&m_pSolidColorTexture,0);
```

`RenderDeviceD3D::SetRenderTarget` @ 0x005A1260 exists but is **dead code** — the only reference in the whole image is its vtable slot at 0x007E5534; no call site. Grep results across `acclient.c` + `acclient_2013.bndb_pseudo_c.txt`:

- `StretchRect` (slot 34): **0 call sites**
- `GetBackBuffer` (slot 18): **0 call sites**
- `CreateRenderTarget` (slot 28): **0 call sites**
- `GetRenderTarget` (slot 38): **1 call site**, the init one above
- `GetFrontBufferData` (slot 33): 1, in `RenderDeviceD3D::GenerateSurfaceFromFrontBuffer` 0x005A1320 (screenshots only)

**Yes, a plugin can StretchRect the backbuffer into its own texture at the boundary.** Recipe at `SceneTool::EndFrame` entry:

```
RenderDevice*  rd  = *(RenderDevice**)0x00870340;            // RenderDevice::render_device
IDirect3DDevice9* dev = *(IDirect3DDevice9**)((byte*)rd + 1128);

// exact rect of the finished 3D scene (still the 3D viewport at EndFrame entry):
uint vx = *(uint*)((byte*)rd + 140);   // m_viewportX
uint vy = *(uint*)((byte*)rd + 144);   // m_viewportY
uint vw = *(uint*)((byte*)rd + 148);   // m_viewportWidth
uint vh = *(uint*)((byte*)rd + 152);   // m_viewportHeight
// full backbuffer size:  RenderDevice::GetDisplayWidth 0x0054FD20 / GetDisplayHeight 0x0054FD30
//   == rd->m_pFrameBufferSurface->width/height, m_pFrameBufferSurface at offset 180

dev->GetRenderTarget(0, &pBB);                                  // slot 38 -> the backbuffer surface
// one-time: CreateTexture(w,h,1, D3DUSAGE_RENDERTARGET, D3DFMT_A8R8G8B8, D3DPOOL_DEFAULT, &pSceneTex)
pSceneTex->GetSurfaceLevel(0, &pSceneSurf);                     // IDirect3DTexture9 slot 18
dev->StretchRect(pBB, &srcRect, pSceneSurf, NULL, D3DTEXF_LINEAR);   // slot 34
// bright-pass / blur into half-res RTs via SetRenderTarget(0, ...) + fullscreen quads,
// then SetRenderTarget(0, pBB) and additively composite over the 3D viewport rect.
pBB->Release();
```

`StretchRect` from the backbuffer is legal in D3D9 as long as the backbuffer was created without multisampling (AC's `SetupPresentation` @ 0x005A3560 / `SelectBufferFormats` @ 0x005A2EF0 — check `m_presentation`; the client's own `RenderDeviceD3D::SetMultiSampleAntialias` 0x005A43D0 toggles only the D3DRS_MULTISAMPLEANTIALIAS renderstate). If MSAA is on you must `SetRenderTarget(0, mySurf)` + re-render, or use `GetRenderTargetData` to sysmem (slow).

You **must** restore RT0 to the original backbuffer surface before returning, because the client never calls `SetRenderTarget` and will happily draw the whole UI into whatever RT you left bound.

Useful struct offsets, straight from the PDB dump (`/home/wbterminal/ac-headers/acclient.txt`):

| field | class | offset |
|---|---|---|
| `m_viewportX / Y / Width / Height` | RenderDevice | 140 / 144 / 148 / 152 |
| `m_RenderTargetWidth / Height` | RenderDevice | 156 / 160 |
| `m_DisplayAspectRatio / m_ViewportAspectRatio` | RenderDevice | 164 / 168 |
| `m_bOpenScene` | RenderDevice | **172 (0xAC)** |
| `m_bDeviceLost` | RenderDevice | 173 |
| `m_nFrameStamp` | RenderDevice | 176 |
| `m_pFrameBufferSurface` | RenderDevice | **180 (0xB4)** |
| `m_pDepthStencilSurface` | RenderDevice | 184 |
| `m_pRenderTarget` | RenderDevice | **188 (0xBC)** |
| `m_pDepthStencilTarget` | RenderDevice | 192 |
| `m_GState` (WorldToView/ViewToClip live here) | RenderDevice | 200 |
| sizeof(RenderDevice) | | 772 |
| `m_pDirect3DDevice` | RenderDeviceD3D | **1128 (0x468)** |
| `m_pPrimarySwapChain` | RenderDeviceD3D | 1132 |
| `m_currentlyDrawingSky` | RenderDeviceD3D | 2016 |

`RenderSurfaceD3D::GetDirect3DSurface` @ **0x00696C50** converts a client `RenderSurface*` (e.g. `m_pFrameBufferSurface`) into the raw `IDirect3DSurface9*` if you'd rather not call `GetRenderTarget`.

## 4. Device pointer + scene state

**Confirmed.** `RenderDeviceD3D::m_pDirect3DDevice` is at byte offset **1128** of the render device — PDB `list[15] = LF_MEMBER, protected, type = 0x735C, offset = 1128, member name = 'm_pDirect3DDevice'`. Independently confirmed in the decomp, e.g. `RenderDeviceD3D::ApplyVertexFormat` (bndb `0059f50b`):

```c
int32_t* eax_1 = *(int32_t*)((char*)RenderDevice::render_device + 0x468);   // 0x468 == 1128
*(uint32_t*)(*(uint32_t*)eax_1 + 0x164)(eax_1, arg2->format);               // 0x164/4 == 89 == SetFVF
```

Full path a plugin already uses (`AcmeSky/Lib/ClientState.cs:33`, `Chorizite .../Hooks/DirectXHooks.cs:88`):

```
RenderDevice::render_device = (RenderDevice**)0x00870340      // ACBindings Rendering/RenderDevice.cs:9
IDirect3DDevice9* dev = *(IDirect3DDevice9**)((byte*)(*(void**)0x00870340) + 1128);
```

**BeginScene/EndScene is still OPEN at the boundary.** `SceneTool::BeginScene` (0x0043DC70) called `IDirect3DDevice9::BeginScene` via `RenderDeviceD3D::BeginScene` (0x005A0D90) and set `m_bOpenScene = 1`; `RenderDeviceD3D::EndScene` (0x005A0E10) is not reached until the tail of `SceneTool::EndFrame`. The whole body of `EndFrame` is wrapped in `if (RenderDevice::render_device->m_bOpenScene)`. A plugin hooked at `EndFrame` entry can draw a fullscreen quad immediately — **no re-Begin needed, and it must not call EndScene/BeginScene itself.** Cheap guard: read `*(byte*)((byte*)rd + 172) != 0` before drawing.

`RenderDeviceD3D::EndScene` decomp for reference:

```c
void __thiscall RenderDeviceD3D::EndScene(RenderDeviceD3D *this) {
  if ( this->m_bOpenScene ) {
    ((void (__stdcall *)(_DWORD))this->m_pDirect3DDevice->vfptr[14].QueryInterface)(this->m_pDirect3DDevice); // slot 42
    v1->m_bOpenScene = 0;
  }
}
```

## 5. Shader usage — the client is pure fixed-function, with one asterisk

Scanned both decomps for every IDirect3DDevice9 programmable-pipeline vtable slot (mapping validated against three known anchors: `vfptr[13].Release` = slot 41 BeginScene, `vfptr[16].AddRef` = slot 49 SetMaterial, vtable byte offset `0x164` = slot 89 SetFVF).

| slot | method | vtable byte off | call sites in acclient |
|---|---|---|---|
| 86 | CreateVertexDeclaration | 0x158 | 0 |
| 87 | SetVertexDeclaration | 0x15C | 0 |
| 89 | SetFVF | 0x164 | 1 (`RenderDeviceD3D::ApplyVertexFormat` 0x005A0610) |
| 91 | CreateVertexShader | 0x16C | **0** |
| 92 | SetVertexShader | 0x170 | **1 — `SetVertexShader(dev, NULL)`** |
| 94–99 | Set*VertexShaderConstant* | 0x178+ | 0 |
| 105 | CreatePixelShader | 0x1A4 | **0** |
| 106 | SetPixelShader | 0x1A8 | **0** |
| 108+ | Set*PixelShaderConstant* | 0x1B0+ | **0** |

The single `SetVertexShader` is in **`RenderDeviceD3D::SetupState` @ 0x005A1D80** (bndb `005a0ec8`), which nulls the vertex shader each material setup to force the FF vertex pipeline:

```c
005a0ebd  int32_t* eax_11 = *(int32_t*)((char*)RenderDevice::render_device + 0x468);
005a0ec8  *(uint32_t*)(*(uint32_t*)eax_11 + 0x170)(eax_11, 0);      // SetVertexShader(NULL)
005a0ed9  RenderDeviceD3D::SetFFFogEnable(this_1, MGStates.WantFFDistanceFog);
005a0ee8  RenderDeviceD3D::SetFFLighting(this_1, MGStates.WantFFLighting);
```

Everything else in the render device is `SetFF*` / `SetStageFF*` (see the map block 0x005A3EB0–0x005A4910). The map contains zero shader-creation symbols; `ShaderResourceType` / `MaterialShaderConstant` (0x0044A3F0, 0x005D8570) are unused DBObj material-schema leftovers. The `ps_1_1 / ps_2_0 / ps_3_0 / vs_1_1 / vs_2_0 / vs_3_0` strings present in `.rdata` at `[0002:0005FD70..0005FE48]` are unreferenced by client code — they belong to the statically-linked `d:\ac2_sdk\dxsdk\9.0\lib\x86\d3dx9.lib` (`D3DXGetPixelShaderProfile`/`D3DXGetVertexShaderProfile`).

**Practical consequence for the bloom plugin:** AcmeSky's assumption holds. Your SM3 shaders cannot collide with client shader state, and the client will clear your *vertex* shader for you on its next `SetupState`. But the client **never touches `SetPixelShader`**, so if you leave a pixel shader bound, every subsequent FF draw (the whole UI, and the next frame's world) renders through it. **`RenderStateGuard` must be extended with `SetPixelShader(NULL)` + `SetVertexShader(NULL)` + `SetVertexDeclaration(NULL)` on restore** — those are not FF renderstates and are not covered by the current Get/Set renderstate snapshot. Also restore `SetRenderTarget(0, origBB)`, `SetDepthStencilSurface(origDS)`, viewport, and stage-1..N textures if you use multi-texture blur taps (the guard only saves stage 0).

## 6. Chorizite's existing frame hook — it is AFTER the UI

`external/chorizite/Chorizite/Chorizite.NativeClientBootstrapper/Hooks/DirectXHooks.cs`:

```csharp
_renderDeviceD3D_EndSceneHook = CreateHook<RenderDeviceD3D_EndScene>(
    typeof(DirectXHooks), nameof(RenderDeviceD3D_EndSceneImpl),
    "## 56 8B F1 8A 86 AC 00 00 00 84 C0 74 16");        // sig-scan, not a fixed VA

private unsafe static void RenderDeviceD3D_EndSceneImpl(IntPtr a) {
    if (_count > 60) { StandaloneLoader.Render?.Render2D(); }   // overlay drawn BEFORE original
    else { _count++; }
    _renderDeviceD3D_EndSceneHook!.OriginalFunction.Invoke(a);
}
```

- Detoured function: **`RenderDeviceD3D::EndScene` @ 0x005A0E10** (map 0x0019FE10). The signature decodes exactly: `push esi; mov esi,ecx; mov al,[esi+0xAC]` — `0xAC` = `m_bOpenScene` offset 172, matching the PDB.
- Position in the frame: `EndScene` is the *second-to-last* thing `SceneTool::EndFrame` does. So Chorizite's `Render2D()` (RmlUi, ImGui-style overlays) draws **after `RenderUI::RenderObjects`, after ProfilerUI/DebugConsole/RenderDebugHUD, and before Present**. It is on top of the client UI — the wrong side for bloom.
- `DirectXHooks` also detours `RenderDeviceD3D::OnDeviceDisplayModeChange` @ **0x005A2BA0** (map 0x001A1BA0, sig `## 83 EC 10 53 56 57 8B F1 E8 ?? ?? ?? ?? 8B CE`) and fires `TriggerGraphicsPreReset` / `TriggerGraphicsPostReset` around it. **Subscribe to those** — that is where you must release/recreate your `D3DPOOL_DEFAULT` bloom RTs, and it's where Chorizite reads `*(int*)(a + 1128)` to build its `Device`.
- `Chorizite.NativeClientBootstrapper/Render/DX9RenderInterface.Render2D()` wraps its callbacks in `new StateBlock(dev, StateBlockType.All)` + `Capture()`/`Apply()` and restores `D3Ddevice.Viewport`. Note a `D3DSBT_ALL` state block does **not** capture render targets, and in D3D9 it does capture shaders — so if you also render from that event, your RT swap still leaks.

---

## Recommendation

| item | value |
|---|---|
| **Hook point** | `SceneTool::EndFrame(bool bDrawUI)` |
| **Map VA** | **0x0043FCD0** (map RVA 0x0003ECD0 + 0x401000) — matches `ACBindings/Generated/SceneTool.cs` `EndFrame` |
| **Entry vs exit** | **ENTRY** (run bloom, then call `OriginalFunction`) |
| **Convention** | `__cdecl`, one stack arg (`byte bDrawUI`) → `[Function(CallingConventions.Cdecl)] delegate void SceneTool_EndFrame(byte bDrawUI)` |
| **Guard** | `if (*(byte*)((byte*)rd + 172) == 0) return;` — mirrors the function's own `m_bOpenScene` gate |
| **Scene state** | D3D `BeginScene` open; RT0 = swapchain backbuffer; depth buffer intact; viewport = 3D game viewport (`rd+140/144/148/152`); FF pipeline only |
| **Callers** | `Client::UseTime` 0x00411FA0 and `Client::KeepUIAlive` 0x00411630 — both are frame drivers, one fires per frame |
| **Backup hook** | `SmartBox::Draw` 0x00455610, hooked at **EXIT** (thiscall, `SmartBox*`) — identical boundary one call earlier; use if `EndFrame` proves awkward to sig-scan |
| **Zero-detour option** | `SmartBox::m_renderingCallback`, `Client::GetInstance()`(0x004114C0) `+288` → `+276`; fires at 0x00453BDE right after the final `FlushAlphaList`, but only while in-world |
| **Restore before return** | `SetRenderTarget(0, origBB)`, `SetDepthStencilSurface(origDS)`, `SetPixelShader(NULL)`, `SetVertexShader(NULL)`, `SetVertexDeclaration(NULL)`, `SetFVF`, viewport, stages 0..N textures + TSS, plus everything `RenderStateGuard` already covers |
| **Device reset** | subscribe to Chorizite `TriggerGraphicsPreReset`/`PostReset` around `RenderDeviceD3D::OnDeviceDisplayModeChange` 0x005A2BA0 |

Caveat on address provenance: `/home/wbterminal/ac-headers/acclient.c` and `acclient_2013.bndb_pseudo_c.txt` are a **different build** from the Chorizite map (per-function deltas are non-constant — e.g. `SceneTool::EndFrame` sits at 0x0043FB30 in the decomp vs 0x0043FCD0 in the map build; `RenderDeviceD3D::EndScene` 0x0059FD00 vs 0x005A0E10). Every VA in this report is **map-build** (`mapRVA + 0x401000`, verified against `ACBindings/Generated/*.cs` where a binding exists); the code excerpts are from the decomp build. Prefer a sig-scan over the hard VA, as `SkyHook`/`DirectXHooks` already do.