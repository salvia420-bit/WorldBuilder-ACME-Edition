# AcmeLights

holtburger-tier lighting for the retail AC client, as a Chorizite plugin. Drives the
client's OWN fixed-function D3D9 light pipeline (the same machinery holtburger-web
re-implemented) via two inline detours, plus later a luminance bloom post-process.

Research + plan: `../docs/lights-port/` (PLAN + two Explore reports).

## Phases (see PLAN)
- P0 enumerate FF pools (log)  · P1 raised pools + viewer headlamp
- P2 flame flicker + ambient fixes  · P3 dynamic spell/portal/glow lights
- P4 importance slot selection  · P5 AcmeBloom luminance post-process

## Live config: `C:\Temp\acdt\lights.cfg` (re-read 1/s; keys in Lib/LightsConfig.cs)

## Hooks (map-build VAs, via ACBindings statics)
- PrimD3DRender::UpdateLightsInternal @0x0059BEE0 — per-viewpoint heartbeat
- SmartBox::SetWorldAmbientLight @0x004530E0 — ambient red-bias + dungeon fix
- RenderDeviceD3D::EndScene @0x005A0E10 — POST-detour backbuffer dump (extrahooks>=1, dump=1)
- SmartBox::m_renderingCallback (SmartBox+276, ZERO-detour pointer slot) — bloom passes at the
  post-3D/pre-UI boundary; re-asserted per frame from the heartbeat (SmartBox::Reset zeroes it).
  Replaces the SceneTool::EndFrame detour, whose cdecl trampoline destabilized the client.

Build: `DOTNET_ROLL_FORWARD=LatestMajor dotnet build AcmeLights/AcmeLights.csproj -c Release`.
Deploy: scp AcmeLights.dll + deps.json + ACBindings/FASM/manifest to the 1070 plugins dir.
