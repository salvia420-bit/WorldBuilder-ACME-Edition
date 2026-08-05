// scene3d/terrain_bc7.js — retail-derived BC7 terrain atlas (?terrainBc7=on).
//
// WHAT THIS IS AND WHY IT EXISTS
// The 33-layer terrain atlas has two possible sources:
//
//   CC0 arm (today's default, `?pbrTerrain` — adapter.js
//   `loadPbrTerrainAtlasSet` / `applyPbrColorOverrides` / `buildPbrNraTexture`):
//   26 of the 33 layers are *replacements* — curated ambientCG CC0 material sets
//   picked to resemble the retail tiles. Because they are replacements they
//   needed human review rounds (`/mnt/wbterminal2/pbr-terrain/curation-manifest.json`
//   records r2 swaps like "Rock035 too dark vs retail tan speckle").
//
//   RETAIL arm (this module, DEFAULT ON since 2026-08-04): the SAME art AC
//   shipped, delivered as BC7. Provenance is PER TIER — t1024 (the default
//   since 2026-08-05) is 4x ESRGAN-family upscaled from retail
//   (4x_foolhardy_Remacri, the statics corpus model; `source:"retail-x4-remacri"`,
//   user-picked over x4plus/ultrasharp/hat-l), which is what puts terrain on the
//   SAME art footing as the Remacri statics around it; t512 is retail-native
//   level-0 pixels (`manifest source:"retail"`), kept as the low-bandwidth pin.
//   Character is preserved by construction, so there is nothing to sign off on —
//   the only question is resolution and compression fidelity, both of which are
//   measurable. One pipeline, one provenance, one format for the whole world.
//
// THIS MODULE DOES NOT REPLACE OR DELETE THE CC0 ARM. When `?terrainBc7` is
// absent, every function here returns null before it fetches anything, and
// terrain.js runs the CC0 path byte-for-byte as it does today. The two arms are
// mutually exclusive per boot (running both would write two different albedos
// into the same layers) and are meant to be A/B'd.
//
// LAYER IDENTIFICATION (the thing that had to be got right first)
// Layers are terrain codes 0..32 (32 terrain types + RoadType), NOT 33 distinct
// textures. Resolution chain, per `src/lib.rs fetch_terrain_textures` (~:4775):
//   Region 0x13000000 `terrain_info.land_surfaces.tex_merge.terrain_desc[i]
//   .terrain_tex.texture_id`  →  SurfaceTexture (0x05......)
//   →  `SurfaceTexture::highest_res()` = LAST entry of its texture list
//   →  RenderSurface (0x06......)
// with `RETAIL_TERRAIN_SURFACE_TEXTURES` (lib.rs:2068-2102) as the frozen
// fallback table. Resolving all 33 through the base client_portal.dat yields
// only **29 unique RenderSurfaces** — retail shares three of them:
//   0x06006D6F  BarrenRock(0) + Argila(24) + DesolateLands(31)
//   0x06006D4D  WaterRunning(16) + FauxWaterRunning(22)
//   0x06006D3C  PatchyGrassland(9) + Moss(28)
// so the manifest maps LAYER → rsId and payloads are deduped by rsId. (The CC0
// arm deliberately *differentiates* Argila/DesolateLands with distinct
// materials; the retail arm keeps retail's sharing, which is a fidelity choice,
// not an oversight.)
//
// WHY THIS IS NOT THE PER-rsId SHARD PATH
// `bc7_textures.js` `Bc7RecordSource` keys BC7 payloads by RenderSurface id out
// of the `holtburger/tex-bc7` namespace, for statics. Terrain does not go
// through that: it builds ONE `DataArrayTexture` of 33 fixed-size layers. So the
// BC7 integration here is the ATLAS BUILDER consuming BC7 into a
// `CompressedArrayTexture`. That is *easier* than statics, because a compressed
// array requires one fixed (format, width, height) for every layer and the
// terrain layers already share dimensions by construction.
//
// MIPS ARE MANDATORY HERE, NOT OPTIONAL
// Terrain is the most tiling, most distance-viewed surface in the game; a
// level-0-only atlas sampling `LinearFilter` would shimmer badly. It is also a
// hard correctness rule: `texStorage3D(levels = 1)` with a mipmapped minFilter
// is an INCOMPLETE texture and samples BLACK. Every payload therefore carries
// the full halving chain to 1x1 (HBC7 v2 — same 20-byte header, levels appended;
// `parseHbc7` infers the count by walking the chain), and this module asserts a
// uniform level count across all 33 layers before it enables
// `LinearMipmapLinearFilter` + anisotropy. Mixed level counts, or any layer
// missing, falls back to the RGBA8 path.
//
// nra: DERIVED FROM THE RETAIL ALBEDO, NOT CARRIED OVER FROM CC0
// The CC0 `nra` maps (R/G = NormalGL tangent XY, B = roughness, A = AO) were
// authored for the CC0 albedo. Pairing them with a retail albedo is not just a
// stylistic mismatch — the T4 POM march (terrain.js:1588-1596) reads *height*
// and offsets `cellUv` BEFORE every sample, so a heightfield describing a
// different surface makes relief slide against the visible texels. This arm
// therefore derives normal / roughness / AO / height from the retail albedo
// itself (see `scripts/derive_nra.py` in the agent scratch dir), which keeps
// one provenance and keeps every channel registered with what you can see.
// Water layers (16-20, 22) are NOT derived — they emit the flat texel
// (128,128,230,255) exactly as the current uncurated path does, because the
// terrainplan s4 water shader owns their normal and roughness.
//
// DEFAULT OFF. Nothing here fetches or allocates until `?terrainBc7=on` AND
// `EXT_texture_compression_bptc` is present (probed by `initBc7`, shared with
// the statics path via `bc7Available()`).

import * as THREE from "three";
import { parseHbc7, bc7LevelBytes, bc7Available, bc7SupportNote } from "./bc7_textures.js";

export const TERRAIN_BC7_DEPTH = 33;
const DEFAULT_BASE = "scene3d/assets/terrain_bc7";

// --------------------------------------------------------------------------
// flag
// --------------------------------------------------------------------------

let _flag;

// Tier = level-0 resolution of the published atlas. Tried in order; the first
// whose manifest.json fetches wins. See TERRAIN-BC7-REPORT.md §VRAM for why 2048
// is deliberately NOT a shippable tier (33 layers x 4 MiB x 4/3 mip = 176 MiB
// per array, 352 MiB for albedo+nra — 4x today's whole terrain budget).
//
// t1024 FIRST (2026-08-05, user direction): the Remacri arm is the intended
// terrain look, and t512 is NOT it — t512 ships `source:"retail"`, retail-native
// 512px pixels, so a t512-first default renders no upscaled art at all while the
// statics around it are all Remacri (the tex-xu7 corpus). Shipping the intended
// look is the driving metric now, not cold-load bytes:
//   t1024  81 MB wire · 88.0 MiB GPU (44.0 per array) · 11 mip levels ·
//          source "retail-x4-remacri" — EXACTLY VRAM-NEUTRAL against the
//          88.0 MiB RGBA8 arm it replaces, at 2x the linear resolution.
//   t512   20 MB wire · 22.0 MiB GPU · 10 mip levels · source "retail".
// `?terrainBc7=512` pins the low tier for a constrained line (the old default),
// `=1024` pins the new one explicitly, `=off` is still the CC0 escape. The
// first-visit cost at 666 kbps is ~15 min vs ~4 min of terrain download — the
// tier pin is the answer for anyone on that line, not the default.
export const TERRAIN_BC7_TIERS = ["t1024", "t512"];
let _tierPref = null;

/**
 * `?terrainBc7` — DEFAULT ON since 2026-08-04 (`?terrainBc7=off` is the escape).
 * Tier selectors `?terrainBc7=1024` / `?terrainBc7=512` pin one tier for A/B;
 * absent or any other value runs the default tier order (t1024 first since
 * 2026-08-05 — see TERRAIN_BC7_TIERS for why the Remacri tier leads).
 *
 * History: this was an EXACT-MATCH opt-in from 2026-07-30 to 2026-08-04 because
 * the arm had no GPU eye-test. Flipped default-ON by user direction (the retail
 * -derived upscaled BC7 atlas is the intended terrain arm; cold-load bytes are
 * the driving metric). The default-on bar (bare-default loads+spawns+0 errors)
 * was validated on local SwiftShader BPTC; the 1070 aesthetic pass (derived
 * normal green-channel sign, derived-height POM, retail-vs-CC0 look) is QUEUED
 * in the vistest queue, not waived. Failure of any kind — no BPTC, no bake,
 * bad payload — still nulls into the CC0/retail RGBA8 path, so default-on is
 * behaviour-neutral on unsupported GPUs and un-baked checkouts.
 */
export function terrainBc7Enabled(search) {
  if (_flag !== undefined && search === undefined) return _flag;
  let on = true; // DEFAULT-ON (2026-08-04); `off`/`0`/`false`/`no` disables
  let tier = null;
  try {
    const s =
      search !== undefined
        ? search
        : typeof window !== "undefined" && window.location
          ? window.location.search
          : "";
    const v = new URLSearchParams(s).get("terrainBc7");
    if (v != null) {
      const t = String(v).toLowerCase();
      on = !(t === "off" || t === "0" || t === "false" || t === "no");
      if (t === "1024" || t === "t1024") { on = true; tier = "t1024"; }
      else if (t === "512" || t === "t512") { on = true; tier = "t512"; }
    }
  } catch (_) {
    on = true;
  }
  if (search === undefined) {
    _flag = on;
    _tierPref = tier;
  }
  return on;
}

/** Tier order to try: the pinned one only, else the default preference list. */
export function terrainBc7TierOrder() {
  return _tierPref ? [_tierPref] : [...TERRAIN_BC7_TIERS];
}

/** Anisotropy floor the high-res tier is worth paying for.
 *
 * 16 = the GTX 1070's reported maximum, and the 1070 is the target this arm is
 * tuned for (the fleet's only real GPU — see the runbook). Nothing weaker is
 * penalised by the number: three clamps `texture.anisotropy` to
 * `capabilities.getMaxAnisotropy()` when it sets TEXTURE_MAX_ANISOTROPY_EXT, so
 * a GPU reporting 8 or 4 silently gets its own ceiling instead of an error. */
export const TERRAIN_BC7_HIRES_ANISO = 16;

/**
 * `?terrainAniso=N` — anisotropic tap count for the TWO BC7 terrain arrays.
 *
 * WHY TERRAIN GETS ITS OWN NUMBER. The global `setAdapterMaxAnisotropy` cap is
 * a per-PRESET budget spread over every adapter-built texture in the scene
 * (low 1 / mid 4 / high+ultra 16, clamped to the GPU max). Terrain is two
 * textures, and it is the surface that is ALWAYS viewed at grazing incidence —
 * which is exactly the regime where the anisotropy cap, not the texel density,
 * decides what you can see. At `mid` the measured live state was `anisotropy: 4`
 * on a GPU reporting 16, and at 4 taps a 1024² atlas resolves to roughly what a
 * 512² one does on a receding ground plane: the entire point of the t1024 tier
 * gets filtered away before it reaches the screen. So when the high-res tier is
 * the one that loaded, floor the count at TERRAIN_BC7_HIRES_ANISO on these two
 * arrays only. Bounded cost — two textures, not the whole scene — and it buys
 * back exactly the thing the tier exists for.
 *
 * Rules, in order:
 *   - `?terrainAniso=N` wins outright (N >= 1), including over the floor.
 *   - an explicit global `?anisotropy=N` is a deliberate A/B and is NOT
 *     overridden — the floor is skipped entirely.
 *   - `base <= 1` (preset `low`, or a GPU reporting 1) stays at base: someone
 *     asking for the cheap preset is not asking for this.
 *   - otherwise: t1024 ⇒ max(base, TERRAIN_BC7_HIRES_ANISO); t512 ⇒ base
 *     unchanged (the low tier has no extra texel density to resolve).
 *
 * Values above the GPU maximum are safe to request — three clamps to
 * `capabilities.getMaxAnisotropy()` when it sets TEXTURE_MAX_ANISOTROPY_EXT.
 */
export function terrainBc7Anisotropy(base, tier, search) {
  const b = Number.isFinite(base) ? Math.max(1, base | 0) : 1;
  let s = search;
  if (s === undefined) {
    try {
      s = typeof window !== "undefined" && window.location ? window.location.search : "";
    } catch (_) {
      s = "";
    }
  }
  let q = null;
  try {
    q = new URLSearchParams(s);
  } catch (_) {
    return b;
  }
  const own = Number.parseInt(q.get("terrainAniso"), 10);
  if (Number.isFinite(own) && own >= 1) return own;
  // A hand-set global cap is an experiment; don't silently outvote it.
  const globalOverride = Number.parseInt(q.get("anisotropy"), 10);
  if (Number.isFinite(globalOverride) && globalOverride >= 1) return b;
  if (b <= 1) return b;
  return tier === "t1024" ? Math.max(b, TERRAIN_BC7_HIRES_ANISO) : b;
}

/** Test hook: clear the memoised flag read. */
export function _resetTerrainBc7ForTest() {
  _flag = undefined;
  _tierPref = null;
  _stats.manifest = null;
  _stats.layers = 0;
  _stats.levels = 0;
  _stats.bytes = 0;
  _stats.tileSize = 0;
  _stats.errors = 0;
  _stats.lastError = null;
  _stats.built = null;
  _stats.anisotropy = 0;
  _stats.anisotropyBase = null;
}

const _stats = {
  manifest: null,
  tileSize: 0,
  layers: 0,
  levels: 0,
  bytes: 0,
  payloads: 0,
  errors: 0,
  lastError: null,
  built: null, // "color+nra" | "color" | null
  anisotropy: 0,      // taps actually requested on both arrays
  anisotropyBase: null, // what the global preset cap offered
};

/** Read via `window.__terrainBc7Stats()` (installed by terrain.js). */
export function terrainBc7Stats() {
  return { ..._stats, enabled: terrainBc7Enabled(), bptc: bc7Available(), support: bc7SupportNote() };
}

// --------------------------------------------------------------------------
// manifest + payload fetch
// --------------------------------------------------------------------------

/**
 * Fetch `<base>/manifest.json`.
 *
 * Shape (written by the bake; see TERRAIN-BC7-REPORT.md):
 *   {
 *     pack: "terrain-bc7-v2",         // HBC7 v2 = header + full mip chain
 *     tier: "t512" | "t2048",
 *     tileSize: 512,                  // level-0 dims, square, uniform
 *     levels: 10,                     // mip levels in EVERY payload
 *     source: "retail" | "retail-x4-esrgan",
 *     nra: "derived-from-retail-albedo",
 *     layers: { "0": { rsId: "0x06006D6F" }, ... 33 entries ... }
 *   }
 *
 * Returns null (with one warn) on any failure — the flag then degrades to a
 * no-op, exactly like a checkout without the gitignored asset bake.
 */
export async function loadTerrainBc7Manifest(baseUrl, { quiet = false } = {}) {
  const base = baseUrl ?? DEFAULT_BASE;
  try {
    const resp = await fetch(`${base}/manifest.json`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const m = await resp.json();
    const layers = m?.layers ?? {};
    const n = Object.keys(layers).length;
    if (n !== TERRAIN_BC7_DEPTH) {
      throw new Error(`manifest has ${n} layers, expected ${TERRAIN_BC7_DEPTH}`);
    }
    if (!Number.isInteger(m.tileSize) || m.tileSize <= 0) {
      throw new Error(`bad tileSize ${m.tileSize}`);
    }
    if (!Number.isInteger(m.levels) || m.levels < 2) {
      // < 2 would mean a level-0-only payload, which cannot use a mipmapped
      // minFilter (incomplete texture ⇒ samples BLACK). Refuse rather than
      // silently downgrade filtering on the most tiling surface in the game.
      throw new Error(`manifest levels=${m.levels}; terrain requires a mip chain`);
    }
    _stats.manifest = { pack: m.pack, tier: m.tier, source: m.source, nra: m.nra };
    _stats.tileSize = m.tileSize;
    _stats.levels = m.levels;
    return m;
  } catch (e) {
    _stats.errors += 1;
    _stats.lastError = `${base}: ${String(e?.message ?? e)}`;
    if (!quiet) {
      // eslint-disable-next-line no-console
      console.warn(
        "[terrain-bc7] manifest.json unavailable — ?terrainBc7=on is a no-op " +
          "(bake per TERRAIN-BC7-REPORT.md):",
        e
      );
    }
    return null;
  }
}

async function _fetchPayload(base, name) {
  const resp = await fetch(`${base}/${name}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${name}`);
  const buf = await resp.arrayBuffer();
  _stats.bytes += buf.byteLength;
  _stats.payloads += 1;
  return parseHbc7(new Uint8Array(buf));
}

/**
 * Fetch + parse every distinct payload the 33 layers reference, for one channel
 * (`"color"` or `"nra"`).
 *
 * Deduped by rsId: with retail's sharing this is 29 fetches for 33 layers, and
 * the shared parse is reused for each layer that points at it. Returns
 * `{ byLayer: Array<parsed|null>(33), tileSize, levels }`, or null if ANY layer
 * is missing / malformed / off-dimension.
 *
 * ALL-OR-NOTHING ON PURPOSE. A compressed array is allocated once at a fixed
 * (format, w, h, levels) — a partially-populated array would leave undefined
 * blocks in real layers, which is far worse than falling back to RGBA8.
 */
export async function loadTerrainBc7Channel(manifest, channel, baseUrl) {
  const base = baseUrl ?? DEFAULT_BASE;
  const size = manifest.tileSize;
  const wantLevels = manifest.levels;
  const wantBytes = (() => {
    let n = 0;
    let w = size;
    let h = size;
    for (let i = 0; i < wantLevels; i += 1) {
      n += bc7LevelBytes(w, h);
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
    return n;
  })();

  const byRs = new Map(); // rsId string -> Promise<parsed>
  const layerRs = new Array(TERRAIN_BC7_DEPTH).fill(null);
  for (const [idxStr, meta] of Object.entries(manifest.layers)) {
    const idx = Number.parseInt(idxStr, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= TERRAIN_BC7_DEPTH) continue;
    const rs = String(meta?.rsId ?? "");
    if (!rs) continue;
    layerRs[idx] = rs;
    if (!byRs.has(rs)) byRs.set(rs, _fetchPayload(base, `${rs}_${channel}.hbc7`));
  }

  let parsedByRs;
  try {
    const keys = [...byRs.keys()];
    const vals = await Promise.all(keys.map((k) => byRs.get(k)));
    parsedByRs = new Map(keys.map((k, i) => [k, vals[i]]));
  } catch (e) {
    _stats.errors += 1;
    _stats.lastError = String(e?.message ?? e);
    // eslint-disable-next-line no-console
    console.warn(`[terrain-bc7] ${channel} payload fetch/parse failed (RGBA8 fallback):`, e);
    return null;
  }

  const byLayer = new Array(TERRAIN_BC7_DEPTH).fill(null);
  for (let i = 0; i < TERRAIN_BC7_DEPTH; i += 1) {
    const rs = layerRs[i];
    const p = rs ? parsedByRs.get(rs) : null;
    if (!p) {
      _stats.lastError = `layer ${i} has no payload (rsId ${rs})`;
      // eslint-disable-next-line no-console
      console.warn(`[terrain-bc7] ${channel}: ${_stats.lastError} — RGBA8 fallback`);
      return null;
    }
    // Uniformity is a HARD requirement of texStorage3D, not a nicety.
    if (p.width !== size || p.height !== size) {
      _stats.lastError = `layer ${i} (${rs}) is ${p.width}x${p.height}, array is ${size}x${size}`;
      // eslint-disable-next-line no-console
      console.warn(`[terrain-bc7] ${channel}: ${_stats.lastError} — RGBA8 fallback`);
      return null;
    }
    if (p.levels.length !== wantLevels) {
      _stats.lastError = `layer ${i} (${rs}) has ${p.levels.length} levels, manifest says ${wantLevels}`;
      // eslint-disable-next-line no-console
      console.warn(`[terrain-bc7] ${channel}: ${_stats.lastError} — RGBA8 fallback`);
      return null;
    }
    let n = 0;
    for (const L of p.levels) n += L.data.byteLength;
    if (n !== wantBytes) {
      _stats.lastError = `layer ${i} (${rs}) level bytes ${n} != expected ${wantBytes}`;
      // eslint-disable-next-line no-console
      console.warn(`[terrain-bc7] ${channel}: ${_stats.lastError} — RGBA8 fallback`);
      return null;
    }
    byLayer[i] = p;
  }
  return { byLayer, tileSize: size, levels: wantLevels };
}

// --------------------------------------------------------------------------
// CompressedArrayTexture assembly
// --------------------------------------------------------------------------

/**
 * Build a mipped `THREE.CompressedArrayTexture` from 33 parsed payloads.
 *
 * LAYOUT CONTRACT (three r184 WebGLTextures, `isCompressedArrayTexture` branch):
 * `mipmaps[i].data` must hold level `i` for EVERY layer, concatenated in layer
 * order, because the uploader either calls
 * `compressedTexSubImage3D(..., i, 0,0,0, w, h, image.depth, fmt, mipmap.data)`
 * for the whole array, or slices per-layer at
 * `layerIndex * getByteLength(mipmap.width, mipmap.height, format, type)`.
 * `getByteLength` for a BPTC format is `ceil(w/4)*ceil(h/4)*16`, which is
 * exactly `bc7LevelBytes` — they MUST agree or per-layer uploads slice the
 * wrong bytes. `texStorage3D` is called with `levels = mipmaps.length`
 * (`getMipLevels`), so supplying the complete chain is what makes the
 * mipmapped minFilter legal.
 *
 * @param {{byLayer:Array, tileSize:number, levels:number}} ch
 * @param {{colorSpace?:any, anisotropy?:number, name?:string}} opts
 */
export function buildTerrainBc7Array(ch, opts = {}) {
  if (!ch || typeof THREE.CompressedArrayTexture !== "function") return null;
  const size = ch.tileSize;
  const depth = TERRAIN_BC7_DEPTH;
  const mipmaps = [];
  let w = size;
  let h = size;
  for (let li = 0; li < ch.levels; li += 1) {
    const layerBytes = bc7LevelBytes(w, h);
    const data = new Uint8Array(layerBytes * depth);
    for (let i = 0; i < depth; i += 1) {
      const src = ch.byLayer[i].levels[li].data;
      if (src.byteLength !== layerBytes) {
        // Already validated in the loader; belt-and-braces because a wrong
        // offset here would upload garbage rather than throw.
        throw new Error(
          `terrain-bc7: L${li} layer ${i} is ${src.byteLength} B, expected ${layerBytes}`
        );
      }
      data.set(src, i * layerBytes);
    }
    mipmaps.push({ data, width: w, height: h });
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }

  const tex = new THREE.CompressedArrayTexture(
    mipmaps,
    size,
    size,
    depth,
    THREE.RGBA_BPTC_Format,
    THREE.UnsignedByteType
  );
  // sRGB for albedo ⇒ three's convert() picks COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT,
  // i.e. the same hardware sRGB decode SRGB8_ALPHA8 gives the RGBA8 arm, and the
  // ALPHA channel is untouched by that decode — which is what makes packing POM
  // height into alpha safe (terrain.js:1123 "sRGB decode never touches A").
  // NoColorSpace for nra ⇒ COMPRESSED_RGBA_BPTC_UNORM_EXT, raw vector/scalar data.
  tex.colorSpace = opts.colorSpace ?? THREE.SRGBColorSpace;
  // Same addressing contract as the RGBA8 DataArrayTexture this replaces:
  // ClampToEdge per layer, with the shader's atlasUvFor fract() supplying the
  // retail 2x tiling. RepeatWrapping here would double-wrap.
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  // LEGAL ONLY BECAUSE THE CHAIN IS COMPLETE. mipmaps.length >= 2 is enforced by
  // the manifest check; with levels == 1 this line would make the texture
  // incomplete and every terrain fragment would sample BLACK.
  tex.minFilter =
    ch.levels > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.generateMipmaps = false; // impossible for compressed; three forces it anyway
  if (ch.levels > 1 && typeof opts.anisotropy === "number" && opts.anisotropy > 0) {
    tex.anisotropy = opts.anisotropy;
  }
  tex.name = opts.name ?? "scene3d-terrain-bc7-array";
  tex.needsUpdate = true;
  return tex;
}

/** GPU bytes a built array occupies (all levels, all layers). */
export function terrainBc7Bytes(tex) {
  if (!tex || !Array.isArray(tex.mipmaps)) return 0;
  let n = 0;
  for (const m of tex.mipmaps) if (m?.data) n += m.data.byteLength;
  return n;
}

/**
 * Whole-arm entry point, called once per session from `resolveTerrainRingOpts`.
 *
 * Returns `{ atlasTexture, nraTexture, tileSize, levels, bytes }` or null. Null
 * means "run the existing path unchanged" for EVERY reason: flag off, no BPTC,
 * no manifest, a missing/garbled payload, a dimension or level-count mismatch.
 * There is no partial success — see `loadTerrainBc7Channel`.
 *
 * `nraTexture` may be null on its own (colour still upgrades) if the nra set is
 * absent; terrain.js then leaves `uPbrEnabled` at 0 rather than pairing retail
 * albedo with CC0 normals, which is the mismatch this whole arm exists to avoid.
 */
export async function buildTerrainBc7Atlas({ baseUrl, anisotropy } = {}) {
  if (!terrainBc7Enabled()) return null;
  if (!bc7Available()) {
    // eslint-disable-next-line no-console
    console.log(
      `[terrain-bc7] flag=on but BPTC unavailable (${bc7SupportNote()}) — RGBA8 path`
    );
    return null;
  }
  // Resolve the tier: try each candidate's manifest, first hit wins. An explicit
  // `?terrainBc7=512` pins one and does NOT silently fall through to another —
  // an A/B arm that quietly renders the other tier is worse than a no-op.
  let manifest = null;
  let base = baseUrl ?? null;
  if (base) {
    manifest = await loadTerrainBc7Manifest(base);
  } else {
    // Probe quietly: a tier that simply is not baked is not an error, and warning
    // "?terrainBc7=on is a no-op" per missing tier before succeeding on the next
    // one would be actively misleading.
    const order = terrainBc7TierOrder();
    for (const tier of order) {
      const b = `${DEFAULT_BASE}/${tier}`;
      // eslint-disable-next-line no-await-in-loop
      const m = await loadTerrainBc7Manifest(b, { quiet: true });
      if (m) {
        manifest = m;
        base = b;
        break;
      }
    }
    if (!manifest) {
      // eslint-disable-next-line no-console
      console.warn(
        `[terrain-bc7] no tier manifest under ${DEFAULT_BASE} (tried ${order.join(", ")}) — ` +
          `?terrainBc7 is a no-op; bake per TERRAIN-BC7-REPORT.md. Last: ${_stats.lastError}`
      );
    }
  }
  if (!manifest) return null;

  const color = await loadTerrainBc7Channel(manifest, "color", base);
  if (!color) return null;

  // Tier-aware anisotropy — resolved AFTER the manifest, because the floor only
  // applies to the high-res tier (see `terrainBc7Anisotropy`).
  const aniso = terrainBc7Anisotropy(anisotropy, manifest.tier);
  _stats.anisotropy = aniso;
  _stats.anisotropyBase = Number.isFinite(anisotropy) ? anisotropy : null;

  let atlasTexture;
  try {
    atlasTexture = buildTerrainBc7Array(color, {
      colorSpace: THREE.SRGBColorSpace,
      anisotropy: aniso,
      name: "scene3d-terrain-bc7-albedo-array",
    });
  } catch (e) {
    _stats.errors += 1;
    _stats.lastError = String(e?.message ?? e);
    // eslint-disable-next-line no-console
    console.error("[terrain-bc7] albedo array assembly failed (RGBA8 fallback):", e);
    return null;
  }
  if (!atlasTexture) return null;

  let nraTexture = null;
  const nra = await loadTerrainBc7Channel(manifest, "nra", base);
  if (nra) {
    try {
      nraTexture = buildTerrainBc7Array(nra, {
        // Vector + scalar data — no transfer function. Matches
        // adapter.js buildPbrNraTexture's NoColorSpace.
        colorSpace: THREE.NoColorSpace,
        // Same count as the albedo, deliberately: the normal/roughness/AO
        // planes are sampled at the SAME cellUv as the albedo, so a lower tap
        // count here would make lighting resolve coarser than the colour it
        // shades — visible as flat-looking ground under a sharp texture.
        anisotropy: aniso,
        name: "scene3d-terrain-bc7-nra-array",
      });
    } catch (e) {
      _stats.errors += 1;
      _stats.lastError = String(e?.message ?? e);
      // eslint-disable-next-line no-console
      console.error("[terrain-bc7] nra array assembly failed (albedo only):", e);
      nraTexture = null;
    }
  }

  _stats.layers = TERRAIN_BC7_DEPTH;
  _stats.built = nraTexture ? "color+nra" : "color";
  const bytes = terrainBc7Bytes(atlasTexture) + terrainBc7Bytes(nraTexture);
  // eslint-disable-next-line no-console
  console.log(
    `[terrain-bc7] ${manifest.tier ?? "?"} ${manifest.source ?? "?"} — ` +
      `${TERRAIN_BC7_DEPTH} layers @ ${color.tileSize}px, ${color.levels} mip levels, ` +
      `${_stats.built}, aniso ${aniso}${aniso !== _stats.anisotropyBase ? ` (preset ${_stats.anisotropyBase})` : ""}, ` +
      `${(bytes / (1024 * 1024)).toFixed(1)} MiB GPU ` +
      `(RGBA8 equivalent ${((color.tileSize * color.tileSize * 4 * TERRAIN_BC7_DEPTH * (nraTexture ? 2 : 1) * 4) / 3 / (1024 * 1024)).toFixed(1)} MiB)`
  );
  return {
    atlasTexture,
    nraTexture,
    tileSize: color.tileSize,
    levels: color.levels,
    bytes,
    manifest,
  };
}
