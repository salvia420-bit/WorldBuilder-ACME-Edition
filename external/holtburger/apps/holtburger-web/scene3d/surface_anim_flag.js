// scene3d/surface_anim_flag.js — `?surfaceAnim=on` (DEFAULT OFF, 2026-10-13).
//
// Gates the "animated SurfaceTexture" path: wasm `fetchSurfaceAnimFrames` →
// MaterialCache `_maybeSetupSurfaceAnimation` → `tickAnimatedSurfaces` (4 Hz).
// That path read a 2-entry SurfaceTexture (0x05) list as animation frames, but
// retail lists DETAIL LEVELS there and draws exactly one: acclient.c
// ImgTex::GetSurfaceDID returns level[0] (the client_highres.dat "HiFi" level)
// unless Render::ShouldDropHighDetail(), else level[1]; no retail path cycles
// levels. On a base-DAT bake it never yields frames anyway (degrade-chain audit
// 2026-08-17: of 3,024 two-level lists, 2,284 have level[0] absent from
// client_portal.dat, 740 are `[id, id]`, 0 are two distinct resident levels),
// so OFF changes no pixel and only sheds one async wasm call + prefetch walk
// per unique textured surface DID. The wasm export stays; this flag re-arms it
// for a census (`liveScene3d.materialCache._animatedMaterials.size`) before the
// path is retired.
//
// Opt-in is EXACT: only `?surfaceAnim=on` enables it.

/** True only for `?surfaceAnim=on`. `search` defaults to the page URL. */
export function surfaceAnimEnabled(search) {
  try {
    const s = search ?? globalThis.location?.search ?? "";
    return new URLSearchParams(s).get("surfaceAnim") === "on";
  } catch (_) {
    return false;
  }
}

/**
 * The `animFramesFetch` getter a MaterialCache should receive: the wasm
 * `fetchSurfaceAnimFrames` export under `?surfaceAnim=on`, else null — which
 * short-circuits `_maybeSetupSurfaceAnimation`, leaving `_animatedMaterials`
 * empty so `tickAnimatedSurfaces` returns at once. Null as well on a stale
 * pkg/ that lacks the export.
 */
export function surfaceAnimFramesFetch(wasmExports, search) {
  if (!surfaceAnimEnabled(search)) return null;
  const fn = wasmExports?.fetchSurfaceAnimFrames;
  return typeof fn === "function" ? fn : null;
}
