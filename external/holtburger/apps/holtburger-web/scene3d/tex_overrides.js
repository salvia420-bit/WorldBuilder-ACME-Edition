// scene3d/tex_overrides.js — X-track `?statTexOverride=on` (DEFAULT OFF,
// exact-match opt-in): per-RenderSurface pixel override loader.
//
// Fetches `data/tex-overrides/manifest.json` + its PNGs, decodes each to raw
// RGBA via ImageBitmap→OffscreenCanvas, and installs them into a wasm
// instance's override map (`add_texture_override` / `commit_texture_overrides`
// in src/texture_overrides.rs). The decode-time hook in
// `fetch_surface_pixels_impl` then serves the replacement pixels to every
// consumer of that instance.
//
// CALLED FROM BOTH SIDES — this is the load-bearing part:
//   - index.html, right after `init_resource_source` (main thread instance);
//   - bake_worker.js `handleInit` (the worker's OWN wasm instance — it decodes
//     surfaces too; skipping it would bake stale texels). The worker re-fetches
//     the same bundle (HTTP cache absorbs it) instead of widening the init
//     message ABI. threads-lite shared-memory mode shares ONE instance, so the
//     worker skips the install there (bake_worker.js gates on that).
//
// Fail-soft by design: any fetch/decode error logs and skips — the page must
// boot identical to flag-off rather than die on a missing bundle. But the flag
// being ON with a missing manifest is loud (console.error), not silent.

/** Resolves against this module's own URL so page (root-relative) and worker
 *  (scene3d-relative) contexts agree on where the bundle lives. */
const BASE_URL = new URL("../data/tex-overrides/", import.meta.url);

/** `?statTexOverride=on` — exact match, everything else (absent, "1", "true")
 *  reads OFF. Pass `search` explicitly in worker context (msg.locationSearch);
 *  defaults to the page's own query string. */
export function texOverrideEnabled(search) {
  try {
    const s =
      search !== undefined
        ? search
        : typeof window !== "undefined"
          ? window.location.search
          : "";
    return new URLSearchParams(s).get("statTexOverride") === "on";
  } catch (_) {
    return false;
  }
}

/**
 * Install the override bundle into one wasm instance.
 * @param {object} wasm — namespace holding `add_texture_override` and
 *   `commit_texture_overrides` (pass `__hbWasmNs` on the main thread; a stale
 *   pkg missing the exports bails loudly instead of link-erroring).
 * @param {object} [opts] — { search, label } — `search`: query string to gate
 *   on (worker passes msg.locationSearch); `label`: log prefix.
 * @returns {Promise<number>} number of overrides installed (0 when disabled).
 */
export async function installTextureOverrides(wasm, { search, label = "main" } = {}) {
  if (!texOverrideEnabled(search)) return 0;
  if (
    typeof wasm?.add_texture_override !== "function" ||
    typeof wasm?.commit_texture_overrides !== "function"
  ) {
    console.error(
      `[tex-overrides:${label}] flag ON but wasm exports missing — stale pkg/ build? Rebuild wasm-pack.`,
    );
    return 0;
  }
  let manifest;
  try {
    const res = await fetch(new URL("manifest.json", BASE_URL), { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    console.error(
      `[tex-overrides:${label}] flag ON but manifest fetch failed (${BASE_URL}manifest.json):`,
      e,
    );
    return 0;
  }
  const entries = Array.isArray(manifest.overrides) ? manifest.overrides : [];
  let installed = 0;
  // Decode one image (optionally resized to w×h) to raw RGBA.
  const decodeRgba = async (src, w, h) => {
    const res = await fetch(new URL(src, BASE_URL));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bmp = await createImageBitmap(await res.blob(), {
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    });
    const dw = w ?? bmp.width;
    const dh = h ?? bmp.height;
    const canvas = new OffscreenCanvas(dw, dh);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, dw, dh);
    bmp.close();
    return { w: dw, h: dh, data: ctx.getImageData(0, 0, dw, dh).data };
  };
  // Sequential on purpose — bounds peak memory (one decoded bitmap at a time)
  // on the 8 GB boxes; the bundle is small and this runs once per boot.
  for (const ent of entries) {
    const did = typeof ent.did === "string" ? parseInt(ent.did, 16) : ent.did;
    if (!Number.isFinite(did)) {
      console.warn(`[tex-overrides:${label}] bad did ${JSON.stringify(ent.did)} — skipped`);
      continue;
    }
    try {
      const diff = await decodeRgba(ent.src);
      // Manifest v2: `gain` (scalar multiplier) and/or `tint` ([r,g,b]
      // multipliers) pre-applied HERE — retail statics are baked dark, CC0
      // albedo is daylight-bright; applying at install keeps the runtime
      // path free of per-texel math. Alpha untouched.
      const gain = typeof ent.gain === "number" ? ent.gain : 1;
      const tint = Array.isArray(ent.tint) && ent.tint.length === 3 ? ent.tint : null;
      if (gain !== 1 || tint) {
        const d = diff.data;
        const mr = gain * (tint ? tint[0] : 1);
        const mg = gain * (tint ? tint[1] : 1);
        const mb = gain * (tint ? tint[2] : 1);
        for (let i = 0; i < d.length; i += 4) {
          d[i] = Math.min(255, d[i] * mr);
          d[i + 1] = Math.min(255, d[i + 1] * mg);
          d[i + 2] = Math.min(255, d[i + 2] * mb);
        }
      }
      // Manifest v2: authored GL-space normal map, resized to the diffuse
      // dims (SurfacePixels carries one width/height for all planes) and
      // repacked RGBA→RGB8 — the normal plane is 3 bytes/px throughout
      // (Sobel emits RGB, adapter reads stride 3).
      let normal;
      if (ent.normalSrc) {
        try {
          const n4 = (await decodeRgba(ent.normalSrc, diff.w, diff.h)).data;
          const px = diff.w * diff.h;
          normal = new Uint8Array(px * 3);
          for (let i = 0; i < px; i++) {
            normal[i * 3] = n4[i * 4];
            normal[i * 3 + 1] = n4[i * 4 + 1];
            normal[i * 3 + 2] = n4[i * 4 + 2];
          }
        } catch (e) {
          console.warn(`[tex-overrides:${label}] ${ent.normalSrc} failed — diffuse-only:`, e);
        }
      }
      const rough = typeof ent.roughness === "number" ? ent.roughness : undefined;
      wasm.add_texture_override(
        did >>> 0,
        diff.w,
        diff.h,
        new Uint8Array(diff.data.buffer),
        normal ? new Uint8Array(normal.buffer) : undefined,
        rough,
      );
      installed++;
    } catch (e) {
      console.warn(`[tex-overrides:${label}] ${ent.src} failed — skipped:`, e);
    }
  }
  // One cache invalidation for the whole batch (pre-override decodes are
  // stale). Returns dropped entry count.
  const cleared = wasm.commit_texture_overrides();
  console.log(
    `[tex-overrides:${label}] installed ${installed}/${entries.length} (cleared ${cleared} cached decodes)`,
  );
  return installed;
}
