// scene3d/texture_release.js
//
// 2026-08-05 — task 4 of the residency plan: give back the CPU-side copy of
// pixels the GPU already has.
//
// THE PRIZE. 1,332 MB of the JS heap is `image.data` / `mipmaps[].data` on
// textures that have already been uploaded (measured live, handoff §9). The
// renderer process dies at ~2,800 MB of a 4,192 MB cap. This is the largest
// single lever in the whole investigation — bigger than every cache budget in
// this codebase put together.
//
// WHY IT IS DEFAULT-OFF, AND WHAT HAS TO BE TRUE BEFORE IT IS NOT.
// Releasing is only safe once nothing else needs those bytes back:
//
//   (a) the statics atlas must stage layers from somewhere else. It reads
//       `img.data` at `static_atlas.js:1203` and through `packNraLayer`
//       (`:297-341`), and "uploaded first, atlased later" is routine — LRU
//       evict → re-enter frees the layer while the texture survives
//       (`landblock_lru.js:1730` skips `__cacheOwned`). `scene3d/surface_planes.js`
//       is that somewhere else; the atlas call sites are the remaining work.
//   (b) the BATCHING gates must ask "can pixels be supplied", not "does this
//       texture still carry bytes". `statics.js` was converted 2026-08-05; the
//       twin at `static_atlas.js:1121` is the other half. Miss this and every
//       static silently goes UNBATCHED — a frame-rate regression, invisible to
//       any eye-test for blackness.
//   (c) context loss must re-hydrate. `webgl_context_recovery.js` opts into
//       three's restore, which re-uploads FROM `image.data`; loss is observed
//       ~7× per session on the 1070. `scene3d/texture_rehydrate.js` is that
//       path, and this module is its first real caller.
//
// (c) is done. (a) and (b) are in flight. Until they land, `?texFreeCpu=on` is
// the only way to turn this on, and turning it on before (a)/(b) WILL unbatch
// statics. That is written here rather than in a ticket because the flag is one
// keystroke and the failure is silent.
//
// ST5 RE-SCOPE (2026-08-09, T15 `?texCompressedOnly`): on the compressed-only
// arm this module's population shrinks to the legacy-RGBA8 residue. A
// compressed-only material has NO decoded pixel planes — its albedo mirror IS
// the 128 MB-budgeted record-cache entry (shared buffer, bc7_textures.js),
// its preview is pack-resident, and `armCpuRelease` already skips compressed
// textures (the `planeBytes` gate reads `image.data`, which they lack). The
// full-tier byte lever on that arm is `MaterialCache.demoteToPreview`
// (pass 5 D-05.8: shed ~7/8 of a texture's bytes to the resident preview —
// no fetch, no decode, never black), not plane release. Preconditions
// (a)/(b) above still bind, unchanged, for the legacy arm. The full
// rehydrate-v3 mirror policy (terrain mirrors freed post-upload; the
// release-seam generalization to source-keyed rehydrators) is the T15
// report's named remainder.
//
// WHAT IT DOES NOT TOUCH, by construction:
//   * atlas arrays (`DataArrayTexture` / `CompressedArrayTexture`) — their CPU
//     buffer is the staging copy `addLayerUpdate` re-uploads individual layers
//     from. Releasing it breaks layer writes outright, not subtly.
//   * pooled per-LB planes (`__rp4Pooled`) — recycled and rewritten forever.
//   * canvas-backed textures — no typed array to release.
//   * anything without a `surfaceDid`, because the refill could not find the
//     pixels again and a release with no refill is a black texture waiting for
//     a context loss.

import { registerReleasedTexture, unregisterReleasedTexture } from "./texture_rehydrate.js";
import { PLANE, planeFor, warmPlanes } from "./surface_planes.js";

/** Strict `=on` opt-in. See the preconditions above — this one is not a taste
 *  knob, it is gated on other work being finished. */
export function texFreeCpuEnabled(search = (typeof location !== "undefined" ? location.search : "")) {
  try {
    return new URLSearchParams(search || "").get("texFreeCpu") === "on";
  } catch (_) {
    return false;
  }
}

const _stats = { released: 0, bytesReleased: 0, refilled: 0, refillFailed: 0, skipped: 0 };

/** Bytes a plane holds, for the diag and for the rehydrate registry's report. */
function planeBytes(tex) {
  const d = tex?.image?.data;
  return d?.byteLength || 0;
}

/**
 * Arm one per-surface texture to drop its CPU copy after the GPU has it.
 *
 * `plane` is one of `PLANE.*`; `surfaceDid` is what the refill re-asks for.
 * Idempotent, and a no-op when the flag is off, when the texture is one of the
 * excluded classes, or when there is no DID to refill from.
 *
 * The hook is three's `onUpdate`, fired at the end of `uploadTexture`
 * (three.module.js:12378) — NOT `onUpload`, which does not exist and which an
 * earlier draft of this plan cited. It is per-SOURCE, so a `.clone()` (which
 * shares `source`) never fires it: clones must not be armed separately, and the
 * source-owning texture is the one to arm.
 */
export function armCpuRelease(tex, plane, surfaceDid, opts = {}) {
  if (!tex || !tex.isTexture) return false;
  if (!(opts.force || texFreeCpuEnabled())) return false;
  if (tex.__cpuReleaseArmed) return true;
  if (!surfaceDid) { _stats.skipped += 1; return false; }
  // Excluded classes — see the header. These are not "unsupported yet", they
  // are wrong by construction.
  if (tex.isDataArrayTexture || tex.isCompressedArrayTexture || tex.isData3DTexture) {
    _stats.skipped += 1;
    return false;
  }
  if (tex.userData?.__rp4Pooled) { _stats.skipped += 1; return false; }
  if (!planeBytes(tex)) { _stats.skipped += 1; return false; }

  tex.__cpuReleaseArmed = true;
  const prevOnUpdate = typeof tex.onUpdate === "function" ? tex.onUpdate : null;
  tex.onUpdate = function (t) {
    try { prevOnUpdate?.call(this, t); } catch (_) { /* never break an upload */ }
    releaseNow(tex, plane, surfaceDid);
  };
  return true;
}

/**
 * Drop the CPU copy and register the way back.
 *
 * Order matters: register FIRST, release second. A context loss landing between
 * the two would otherwise find a texture with no pixels and no entry telling
 * anyone to refill it — the exact black-world outcome this whole subsystem
 * exists to prevent.
 */
export function releaseNow(tex, plane, surfaceDid) {
  const bytes = planeBytes(tex);
  if (!bytes) return false;

  registerReleasedTexture(
    tex,
    async (t) => {
      // Warm the decode memo, then take the plane back out of it. `planeFor`
      // returns null rather than zeros when it cannot supply — which the
      // registry treats as a loud MISS, not a silent black texture.
      await warmPlanes([surfaceDid]);
      const p = planeFor({ map: t, normalMap: t, roughnessMap: t, aoMap: t }, plane, surfaceDid);
      if (!p || !p.data?.byteLength) return false;
      if (t.image) t.image.data = p.data;
      _stats.refilled += 1;
      return true;
    },
    { label: `0x${(surfaceDid >>> 0).toString(16).toUpperCase()}:${plane}`, owner: "texture_release", bytes },
  );

  if (tex.image) tex.image.data = null;
  _stats.released += 1;
  _stats.bytesReleased += bytes;
  return true;
}

/** Drop the arming + registry entry, e.g. when the texture is disposed. */
export function disarmCpuRelease(tex) {
  if (!tex) return false;
  tex.__cpuReleaseArmed = false;
  return unregisterReleasedTexture(tex);
}

export function textureReleaseStats() {
  return { ..._stats, enabled: texFreeCpuEnabled() };
}

export function __resetTextureReleaseForTests() {
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}
