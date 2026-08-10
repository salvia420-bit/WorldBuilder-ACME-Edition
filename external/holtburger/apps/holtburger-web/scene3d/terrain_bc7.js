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
import { parseHbc7, bc7LevelBytes, bc7Available, bc7SupportNote, flagIsOff } from "./bc7_textures.js";
// ST5 tier ladder (`?terrainT1024`, DEFAULT OFF) — the terrain arrays are the
// one texture class pass-05 D-05.7 frees OUTRIGHT post-upload (−88 MiB at
// t1024), so the ladder registers its way back with the SAME registry the
// context-loss restore pass walks. Flag absent ⇒ neither import is ever
// called and no entry is ever registered (`releasedTextureCount()` stays 0,
// which is what keeps webgl_context_recovery.js on its synchronous path).
import {
  registerReleasedTexture,
  unregisterReleasedTexture,
  textureHasPixels,
} from "./texture_rehydrate.js";
// ST4 (`?texWorkers`, DEFAULT OFF): the level-major array assembly can run in
// the dedicated texture worker (SPEC §3 T14 / pass-05 D-05.4 — at t1024 the
// synchronous build below is 88 MiB of alloc+memcpy in one main-thread task).
// Flag off ⇒ these imports are never called and the path below is unchanged.
import { texWorkersEnabled, workerTerrainAssemble } from "./xu7_textures.js";

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
      on = !flagIsOff(t);
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

// --------------------------------------------------------------------------
// ST5 — `?terrainT1024`: the TIER LADDER flag (SPEC §0.2.1 + §1.3; pass-12
// D-12.1; pass-05 D-05.2). DEFAULT OFF, and "off" here means ABSENT.
// --------------------------------------------------------------------------
//
// THE LADDER, AND WHY THE FLAG'S GRAMMAR LOOKS ODD
// SPEC §1.3 states the end-state ladder as: t128 color (lane B tail, 1 CAS
// file) → `preview-complete` → t128 nra → **`converged` stamps with terrain
// at t128** → the full pair streams post-converged on idle lane T,
// "default-ON, non-budgeted, wholesale-swapped (`?terrainT1024=eager|defer|
// off`, default `defer`)". That grammar describes the world AFTER the
// default flip; it has no spelling for "no ladder at all", because by then
// there is no other path. Today there is: this module's 2026-08-05
// t1024-FIRST boot, which is the shipped default and the kill path (I7).
//
// So the reader has four states and the ABSENT one is legacy:
//   absent            — LADDER OFF. `buildTerrainBc7Atlas` runs exactly as
//                       it did before this landing: resolve tier order,
//                       fetch the full pair, build, return. Byte-identical.
//   `defer`/`on`/`1`  — ladder ON, full tier promoted AFTER the converged
//     /`true`/`yes`     signal (SPEC's own default within the ladder).
//   `eager`           — ladder ON, promotion starts as soon as the t128 pair
//                       is live (the "I have bandwidth" arm).
//   `off`/`0`/`false` — ladder ON, terrain PINNED at t128 and never
//     /`no`             promoted. This is the low-bandwidth arm and the
//                       demote destination — NOT the legacy path.
//
// The distinction is documented in docs/url-flags.md the same way; a bench
// arm that means "today's client" must OMIT the parameter.
export const TERRAIN_LADDER_MODES = Object.freeze(["absent", "defer", "eager", "off"]);

/**
 * `?terrainT1024` — one of `TERRAIN_LADDER_MODES`. NOT memoised (the ESM
 * suites re-stub `window.location` per case, and the ladder is read at ring
 * resolve, long after any memo would have been taken).
 */
export function terrainT1024Mode(search) {
  let s = search;
  if (s === undefined) {
    try {
      s = typeof window !== "undefined" && window.location ? window.location.search : "";
    } catch (_) {
      s = "";
    }
  }
  let v = null;
  try {
    v = new URLSearchParams(s).get("terrainT1024");
  } catch (_) {
    return "absent";
  }
  if (v == null) return "absent";
  const t = String(v).toLowerCase();
  // Every documented off-spelling in one statement (the lint's OFF-SPELLING
  // rule): `off`/`0`/`false`/`no` pin t128, they do NOT disarm the ladder.
  if (t === "off" || t === "0" || t === "false" || t === "no") return "off";
  if (t === "eager") return "eager";
  if (t === "defer" || t === "on" || t === "1" || t === "true" || t === "yes") return "defer";
  // Garbage is not a silent third behaviour: fall back to the ladder's own
  // documented default rather than to the legacy path, because the operator
  // clearly asked for the ladder.
  return "defer";
}

/** Ladder armed at all? (`?terrainT1024` present in any spelling.) */
export function terrainLadderArmed(search) {
  return terrainT1024Mode(search) !== "absent";
}

/** Test hook: clear the memoised flag read. */
export function _resetTerrainBc7ForTest() {
  _resetTerrainLadderForTest();
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
  // ST5 tier ladder (`?terrainT1024`). `mode: "absent"` + every counter 0 is
  // the legacy arm's honest reading — an ABSENT ladder, not a failed one.
  ladder: _freshLadderStats(),
};

function _freshLadderStats() {
  return {
    mode: "absent",
    armed: false,
    tier: null,            // the tier CURRENTLY on the GPU: "t128" | full tier
    fullTier: null,        // the promote target (manifest tier)
    sliceSource: null,     // "pack" | null — where the t128 pair came from
    t128Ms: null,          // ms from ladder start to the t128 pair being built
    t128Bytes: 0,          // GPU bytes of the t128 pair (both arrays)
    promoteStartMs: null,
    terrainT1024CompleteMs: null, // SPEC B4b's named stamp
    promotions: 0,
    demotions: 0,
    promoteFailures: 0,
    fallbacks: 0,          // ladder could not arm ⇒ legacy full-tier boot
    stageSplit: 0,         // promotions staged as 2 single-array uploads
    stageColorMs: null,
    stageNraMs: null,
    uploadWaitTimeouts: 0,
    mirrorsReleased: 0,
    mirrorBytesFreed: 0,
    mirrorReleaseDeferred: 0,
    mirrorRestores: 0,
    mirrorRestoreFailed: 0,
    lastError: null,
  };
}

/** Live per-array upload state, folded into `terrainBc7Stats().ladder` on
 *  every read. The mirror release is gated on three having ACTUALLY uploaded
 *  (D-05.7/T15R D2), so "did three ever upload this array?" is the first
 *  question any capture with `mirrorsReleased: 0` has to answer — and it is
 *  unanswerable from the counters alone. */
function _ladderUploadState() {
  return {
    colorUploaded: !!_ladder.color?.__hbUploaded,
    nraUploaded: !!_ladder.nra?.__hbUploaded,
    colorVersion: _ladder.color ? _ladder.color.version | 0 : null,
    colorReleaseArmed: !!_ladder.color?.__hbAfterUpload,
  };
}

/** Read via `window.__terrainBc7Stats()` (installed by terrain.js). */
export function terrainBc7Stats() {
  return {
    ..._stats,
    ladder: { ..._stats.ladder, ..._ladderUploadState() },
    enabled: terrainBc7Enabled(),
    bptc: bc7Available(),
    support: bc7SupportNote(),
  };
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
  // `layerRs` is additive (ST4): the worker-assembly path needs the layer→rsId
  // map to rebuild the dedup on the other side. Existing consumers destructure
  // by name and are untouched.
  return { byLayer, tileSize: size, levels: wantLevels, layerRs };
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
  const m = _mipsFromChannel(ch);
  return _makeCompressedArrayTexture(m.mipmaps, m.size, m.levels, opts);
}

/** The level-major concatenation itself, factored at ST5 so the tier ladder
 *  can swap mip sets into a LIVE texture without building a second one
 *  (the wholesale swap keeps the texture OBJECT, see `_swapArrayInPlace`).
 *  Byte-identical to the pre-ST5 inline loop. */
function _mipsFromChannel(ch) {
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
  return { mipmaps, size, levels: ch.levels };
}

/**
 * ST4 twin of `buildTerrainBc7Array`: same texture, built from the ONE
 * concatenated level-major buffer the texture worker returns
 * (`workerTerrainAssemble` / texture_worker.js `assembleTerrainChannel`).
 * `mipmaps[i].data` become zero-copy subarray views over that buffer — byte-
 * identical content to the per-level buffers the synchronous path allocates
 * (three's uploader takes ArrayBufferViews either way).
 *
 * @param {{tileSize:number, levels:number, depth:number,
 *          levelBytes:number[], bc7:ArrayBuffer}} assembled
 */
export function buildTerrainBc7ArrayFromAssembled(assembled, opts = {}) {
  if (!assembled || typeof THREE.CompressedArrayTexture !== "function") return null;
  const m = _mipsFromAssembled(assembled);
  return _makeCompressedArrayTexture(m.mipmaps, m.size, m.levels, opts);
}

/** ST5 twin of `_mipsFromChannel` for the worker-assembled buffer. */
function _mipsFromAssembled(assembled) {
  const size = assembled.tileSize;
  const depth = assembled.depth ?? TERRAIN_BC7_DEPTH;
  if (depth !== TERRAIN_BC7_DEPTH) {
    throw new Error(`terrain-bc7: assembled depth ${depth} != ${TERRAIN_BC7_DEPTH}`);
  }
  const u8 = new Uint8Array(assembled.bc7);
  const mipmaps = [];
  let off = 0;
  let w = size;
  let h = size;
  for (let li = 0; li < assembled.levels; li += 1) {
    const expect = bc7LevelBytes(w, h) * depth;
    const n = assembled.levelBytes[li];
    if (n !== expect) {
      throw new Error(`terrain-bc7: assembled L${li} is ${n} B, expected ${expect}`);
    }
    if (off + n > u8.byteLength) {
      throw new Error(`terrain-bc7: assembled buffer short at L${li}`);
    }
    mipmaps.push({ data: u8.subarray(off, off + n), width: w, height: h });
    off += n;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  if (off !== u8.byteLength) {
    throw new Error(`terrain-bc7: assembled buffer has ${u8.byteLength - off} trailing bytes`);
  }
  return { mipmaps, size, levels: assembled.levels };
}

/**
 * ST4 seam: build one channel's array, in the texture worker when
 * `?texWorkers=on`, else (and on ANY worker failure) via the unchanged
 * synchronous path. Worker failure is NEVER silent: `workerTerrainAssemble`
 * counts `terrainFallbacks` on `__texWorkerStats` before throwing, and the
 * catch below warns with the channel name. The transferred payload buffers
 * die with a failed job, so the fallback RE-FETCHES the channel (immutable
 * HTTP cache — the same re-supply rehydrate v3 leans on) before assembling
 * on the main thread.
 *
 * Flag OFF ⇒ exactly `buildTerrainBc7Array(ch, opts)`, nothing else runs.
 * May THROW (from the sync builder) — callers keep their existing catch.
 */
async function _assembleChannelArray(manifest, channel, base, ch, opts) {
  if (!ch || typeof THREE.CompressedArrayTexture !== "function") return null;
  const m = await _assembleChannelMips(manifest, channel, base, ch);
  if (!m) return null;
  return _makeCompressedArrayTexture(m.mipmaps, m.size, m.levels, opts);
}

/** The same seam, one step short of the texture: ST5's ladder swaps mip sets
 *  into the LIVE arrays, so it needs the concatenation without a second
 *  `CompressedArrayTexture`. Control flow (worker → counted fallback →
 *  re-fetch → sync build) is the ST4 flow verbatim. */
async function _assembleChannelMips(manifest, channel, base, ch) {
  if (texWorkersEnabled()) {
    try {
      const seen = new Set();
      const payloads = [];
      for (let i = 0; i < TERRAIN_BC7_DEPTH; i += 1) {
        const rs = ch.layerRs ? ch.layerRs[i] : null;
        if (!rs || seen.has(rs)) continue;
        seen.add(rs);
        // parseHbc7 hands out subarray views of the ONE fetched payload
        // buffer (header included at offset 0), so `.data.buffer` IS the raw
        // HBC7 payload — transferable whole, re-parsed worker-side.
        payloads.push({ rs, bytes: ch.byLayer[i].levels[0].data.buffer });
      }
      const assembled = await workerTerrainAssemble({
        tileSize: ch.tileSize,
        levels: ch.levels,
        depth: TERRAIN_BC7_DEPTH,
        layerRs: ch.layerRs,
        payloads,
      });
      if (!assembled || typeof THREE.CompressedArrayTexture !== "function") {
        throw new Error("assembled-array construction returned null");
      }
      return _mipsFromAssembled(assembled);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[terrain-bc7] ${channel}: worker assembly failed — main-thread fallback (counted):`,
        e?.message ?? e
      );
      const again = await loadTerrainBc7Channel(manifest, channel, base);
      if (!again) return null;
      ch = again;
    }
  }
  return _mipsFromChannel(ch);
}

/** The texture-construction tail both builders share (factored at ST4;
 *  behaviour byte-identical to the pre-ST4 inline block). */
function _makeCompressedArrayTexture(mipmaps, size, chLevels, opts = {}) {
  const depth = TERRAIN_BC7_DEPTH;
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
    chLevels > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.generateMipmaps = false; // impossible for compressed; three forces it anyway
  if (chLevels > 1 && typeof opts.anisotropy === "number" && opts.anisotropy > 0) {
    tex.anisotropy = opts.anisotropy;
  }
  tex.name = opts.name ?? "scene3d-terrain-bc7-array";
  tex.needsUpdate = true;
  return tex;
}

// ==========================================================================
// ST5 — THE TIER LADDER (`?terrainT1024`)
// ==========================================================================
//
// SPEC §0.2.1/§1.3 + pass-12 D-12.1: the boot slice is t128 (ONE CAS file
// per channel, D-12.6), `converged` stamps with terrain AT t128, and the
// full pair streams afterwards and is WHOLESALE-swapped. Two properties of
// this module make that implementable without touching a single consumer:
//
//  1. `resolveTerrainRingOpts` (terrain.js:3961-4093) consumes exactly two
//     things from the returned atlas — `atlasTexture` and `nraTexture` —
//     and threads those OBJECTS into every landblock material's `uAtlas` /
//     nra uniforms. It never reads `tileSize`/`levels`. So a tier swap that
//     KEEPS THE TEXTURE OBJECTS is invisible above this file: no uniform
//     re-point, no material rebuild, no re-entry into the ring resolve.
//  2. three r184 re-allocates a disposed texture from scratch:
//     `deallocateTexture` drops the texture's properties
//     (three.module.js:11350-11386), so the next `uploadTexture` takes
//     `forceUpload` ⇒ `allocateMemory` ⇒ a fresh `texStorage3D` at
//     `mipmaps[0].width/height, image.depth` (three.module.js:12026-12034).
//     Dispose + new mipmaps + new `image` + `needsUpdate` therefore IS a
//     legal wholesale re-spec of a live compressed array.
//
// STAGING. P-88MIB (1070, 2026-08-10 batch A): the full t1024 PAIR stages
// whole in 87–96 ms and split 44/44 MiB on consecutive frames at
// ~43–45 ms/frame — both under F6's 250 ms streaming-hitch line, the split
// with 5× headroom. The ladder therefore swaps ONE array per frame by
// default (`TERRAIN_STAGE_SPLIT`): colour first (the visible channel), nra
// on the next frame, each its own upload task.
//
// MIRRORS. D-05.7 row 1: terrain arrays are FREED post-upload (−88 MiB
// heap at t1024) and rehydrate by re-fetching their payloads (immutable
// HTTP cache) → re-assemble → re-upload. The register-the-way-back-FIRST
// ordering is non-negotiable (texture_release.js:117-124 states it; T15R
// re-states it in bc7_textures.js:294-297): a context loss landing between
// "dropped the bytes" and "registered the restore" is a permanently black
// world. Release also refuses until three has actually uploaded (T15R D2)
// and nulls `image.data` so `textureHasPixels` reads the mipmaps rather
// than mistaking the `{width,height,depth}` descriptor for an
// element-backed image (T15R D3 — the bug that would silently SKIP terrain
// in every restore pass).

/** t128 boot-slice level-0 dims (D-12.6: 29 payloads × 21,892 B = 0.63 MB
 *  per channel, sliced from the t1024 chain, never re-encoded). */
export const TERRAIN_T128_TILE = 128;

/** Stage the promotion as two single-array uploads (P-88MIB: 44/44 MiB at
 *  ~43–45 ms each vs 87–96 ms whole — both legal, the split has 5× F6
 *  headroom, so it is the comfortable default). */
export const TERRAIN_STAGE_SPLIT = true;

/** How long a promotion waits for three to actually upload a swapped array
 *  before giving up on observing it. Exceeding this does NOT fail the
 *  swap (the pixels are correct and will upload on any later frame) — it
 *  only defers the mirror release, counted as `uploadWaitTimeouts`. */
export const TERRAIN_UPLOAD_WAIT_MS = 4000;

/** `defer` mode: how long after the converged signal to sit idle before
 *  starting the full-tier fetch. The milestone says "the ring is textured";
 *  this says "and the lane has gone quiet". */
export const TERRAIN_LADDER_DEFER_SETTLE_MS = 2000;

/** `defer` mode ceiling: promote anyway. A converged signal that never
 *  arrives (legacy dist, disarmed controller, a wedged lane) must not
 *  strand the session at t128 — the user direction is that every session
 *  ends at the full tier (SPEC §0.2.1). */
export const TERRAIN_LADDER_DEFER_MAX_MS = 30000;

/** How long the ladder waits for the controller's lane-B t128 slices
 *  (`bootCommons` fetches both; the ring resolve can beat them). */
export const TERRAIN_SLICE_WAIT_MS = 15000;

const _ladder = {
  mode: "absent",
  manifest: null,
  base: null,
  aniso: 1,
  anisoBase: null,
  color: null,   // live CompressedArrayTexture
  nra: null,
  t128: { color: null, nra: null }, // retained mip sets = the demote source
  promise: null, // in-flight promotion
  timers: [],
  controller: null, // injected (tests) or discovered lazily
  renderer: null,   // WebGLRenderer for initTexture staging (discovered lazily)
  stageUpload: null, // test override for the staging call
  now: () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()),
};

/**
 * Wiring/test seam.
 *
 * @param {Object} [o]
 * @param {Object} [o.controller] the PackFetchController singleton (the t128
 *   slice carrier). Production discovers it lazily; a suite has no page.
 * @param {Function} [o.now] clock.
 * @param {Object} [o.renderer] the WebGLRenderer, for `initTexture` staging.
 *   Discovered lazily from `window.liveScene3d.renderer` when not injected.
 * @param {(tex:Object) => void} [o.stageUpload] overrides the staging call
 *   entirely (suites stand in for the GPU with `tex.onUpdate(tex)`).
 */
export function initTerrainTierLadder({ controller, now, stageUpload, renderer } = {}) {
  if (controller !== undefined) _ladder.controller = controller || null;
  if (typeof now === "function") _ladder.now = now;
  if (renderer !== undefined) _ladder.renderer = renderer || null;
  if (stageUpload !== undefined) _ladder.stageUpload = typeof stageUpload === "function" ? stageUpload : null;
}

/**
 * Stage one array to the GPU NOW.
 *
 * `renderer.initTexture(tex)` is the call SPEC §1.3 names for this ("staging
 * via ≤ 2 exclusive `initTexture` calls (44/44 MiB splittable)") and the one
 * P-88MIB measured on the 1070 (87–96 ms for the pair whole, 43–45 ms per
 * array split). Landing it here is not an optimisation — it is a
 * CORRECTNESS requirement for the mirror release, proven live on this box
 * (2026-08-10, `?packSource=on&terrainBc7=512&terrainT1024=eager`,
 * agentp08/agentp09, 3 boots): with staging left to "whatever three does on
 * the next render", the swapped arrays read `colorUploaded:false` **150 s
 * after a successful promotion** while the renderer advanced 4,738 frames —
 * so a release gated on the upload (as D-05.7/T15R D2 require it to be)
 * freed exactly 0 bytes. `initTexture` uploads synchronously through the
 * same `uploadTexture` path, which is also what fires `onUpdate` and lets
 * the release proceed.
 *
 * No renderer ⇒ no staging call, the swap is still correct, and the release
 * simply waits on the upload event (counted `mirrorReleaseDeferred`).
 */
function _stageUpload(tex) {
  if (_ladder.stageUpload) { _ladder.stageUpload(tex); return; }
  let r = _ladder.renderer;
  if (!r) {
    try {
      // `window.liveScene3d` is a one-time init3D SNAPSHOT (late-stamped
      // subsystems read null forever) — but `renderer` is stamped AT init3D
      // and is live: read-verified this session by reading
      // `liveScene3d.renderer.info.render.frame` off a running page.
      r = (typeof window !== "undefined" && window.liveScene3d) ? window.liveScene3d.renderer : null;
    } catch (_) { r = null; }
    if (r && typeof r.initTexture === "function") _ladder.renderer = r;
  }
  if (r && typeof r.initTexture === "function") r.initTexture(tex);
}

/** Test hook: forget every ladder-owned texture, timer and counter. */
export function _resetTerrainLadderForTest() {
  for (const t of _ladder.timers) { try { clearTimeout(t); } catch (_) { /* noop */ } }
  _ladder.timers = [];
  for (const tex of [_ladder.color, _ladder.nra]) {
    if (tex) { try { unregisterReleasedTexture(tex); } catch (_) { /* fail-soft */ } }
  }
  _ladder.mode = "absent";
  _ladder.manifest = null;
  _ladder.base = null;
  _ladder.aniso = 1;
  _ladder.anisoBase = null;
  _ladder.color = null;
  _ladder.nra = null;
  _ladder.t128 = { color: null, nra: null };
  _ladder.promise = null;
  _ladder.controller = null;
  _ladder.renderer = null;
  _ladder.stageUpload = null;
  if (_stats) _stats.ladder = _freshLadderStats();
}

// --------------------------------------------------------------------------
// t128 slice source: the HBP1 pack the bake emits as ONE CAS file/channel
// --------------------------------------------------------------------------

const HBP1_HEADER_LEN = 32;
const HBP1_SECTION_ENTRY_LEN = 16;
const HBP1_FOOTER_LEN = 8;
const HBP1_SECTION_PVW = 0x0b;
const HBP1_CODEC_RAW = 0;

/**
 * Read the PVW stream out of a terrain t128 slice pack.
 *
 * Layout (apps/holtburger-tools/src/pack_format.rs `write_hbp1` +
 * `build_pvw_stream`, read-verified against the deployed slice packs —
 * kind 6 colour / kind 7 nra, 1 section, 29 rows, 21,892 B each):
 *   header 32 B: "HBP1" | ver u8 | kind u8 | flags u16 | origin u32 |
 *                sectionCount u16 | nsCount u8 | rsv u8 | epoch u64 | rsv u64
 *   namespace table: nsCount × 32 B
 *   section table:   sectionCount × [kind u16][codec u8][pad u8]
 *                    [offset u32 (FROM FILE START)][stored u32][raw u32]
 *   footer 8 B:      crc32 u32 | "1PBH"
 *   PVW payload:     [count u32] × [rs u32][off u32][size u32] + blobs
 *
 * The CRC is deliberately NOT checked: the controller sha256-verifies every
 * pack on receipt against the pinned index (pack_fetch_controller.js:
 * 434-449), which is strictly stronger, and a crc32 in JS here would exist
 * only to re-answer a question already answered. Magic/version/trailing
 * magic ARE checked — those catch a truncated or mis-routed body, which is
 * what actually happens in the wild.
 *
 * @returns {Map<number, Uint8Array>} rsId → HBC7 payload (a COPY: the caller
 *   hands these to the texture worker, and transferring a subarray of the
 *   pack buffer would neuter the controller's retained slice).
 */
export function parseTerrainSlicePack(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength < HBP1_HEADER_LEN + HBP1_FOOTER_LEN) {
    throw new Error("HBP1: shorter than header + footer");
  }
  if (u8[0] !== 0x48 || u8[1] !== 0x42 || u8[2] !== 0x50 || u8[3] !== 0x31) {
    throw new Error("HBP1: bad magic");
  }
  if (u8[4] !== 1) throw new Error(`HBP1: unsupported version ${u8[4]}`);
  const tail = u8.subarray(u8.byteLength - 4);
  if (tail[0] !== 0x31 || tail[1] !== 0x50 || tail[2] !== 0x42 || tail[3] !== 0x48) {
    throw new Error("HBP1: bad trailing magic (truncated?)");
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const sectionCount = dv.getUint16(12, true);
  const nsCount = u8[14];
  let pos = HBP1_HEADER_LEN + nsCount * 32;
  let pvw = null;
  for (let i = 0; i < sectionCount; i += 1) {
    if (pos + HBP1_SECTION_ENTRY_LEN > u8.byteLength) throw new Error("HBP1: section table overruns");
    const kind = dv.getUint16(pos, true);
    const codec = u8[pos + 2];
    const offset = dv.getUint32(pos + 4, true);
    const stored = dv.getUint32(pos + 8, true);
    if (kind === HBP1_SECTION_PVW) {
      if (codec !== HBP1_CODEC_RAW) {
        // The bake emits terrain slices RAW (pack_bake.rs:1219). A zstd
        // slice would need an inflater this module does not have, and
        // guessing is worse than the counted fallback.
        throw new Error(`HBP1: PVW section codec ${codec} is not RAW`);
      }
      if (offset + stored > u8.byteLength - HBP1_FOOTER_LEN) {
        throw new Error("HBP1: PVW section overruns file");
      }
      pvw = u8.subarray(offset, offset + stored);
    }
    pos += HBP1_SECTION_ENTRY_LEN;
  }
  if (!pvw) throw new Error("HBP1: no PVW section (not a terrain slice pack?)");
  const pdv = new DataView(pvw.buffer, pvw.byteOffset, pvw.byteLength);
  const count = pdv.getUint32(0, true);
  const indexLen = 4 + count * 12;
  if (pvw.byteLength < indexLen) throw new Error("HBP1: PVW index truncated");
  const body = indexLen;
  const out = new Map();
  for (let i = 0; i < count; i += 1) {
    const e = 4 + i * 12;
    const rs = pdv.getUint32(e, true) >>> 0;
    const off = pdv.getUint32(e + 4, true);
    const size = pdv.getUint32(e + 8, true);
    if (body + off + size > pvw.byteLength) throw new Error(`HBP1: PVW row ${i} overruns`);
    out.set(rs, pvw.slice(body + off, body + off + size));
  }
  return out;
}

/** The PackFetchController singleton, or null. Discovered lazily and only
 *  on the armed arm — the OFF arm never imports the module from here. */
async function _ladderController() {
  if (_ladder.controller) return _ladder.controller;
  try {
    const mod = await import("./pack_fetch_controller.js");
    // No-arg: index.html (:2715) and scene3d/index.js (:6275) both take the
    // singleton this way, so this returns the ARMED one on a packs boot and
    // an inert one otherwise. It never creates a second controller.
    _ladder.controller = mod.getPackFetchController();
  } catch (e) {
    _ladder.controller = null;
    _stats.ladder.lastError = `controller import: ${String(e?.message ?? e)}`;
  }
  return _ladder.controller;
}

/** Wait for one lane-B slice (`bootCommons` fetches both; the ring resolve
 *  can and does beat them). Resolves null on timeout — counted by the
 *  caller, never silent. */
async function _awaitSlice(ctl, chan, deadlineMs) {
  const t0 = _ladder.now();
  for (;;) {
    const buf = ctl.getT128Slice(chan);
    if (buf) return buf;
    if (_ladder.now() - t0 >= deadlineMs) return null;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { _ladder.timers.push(setTimeout(r, 50)); });
  }
}

/**
 * Build one channel's t128 `{byLayer, tileSize, levels, layerRs}` from the
 * slice pack, in the shape `loadTerrainBc7Channel` produces (so every
 * downstream builder is tier-blind). ALL-OR-NOTHING for the same reason the
 * full-tier loader is: a compressed array is one fixed (format, w, h).
 */
function _t128ChannelFromSlice(manifest, sliceBytes, channel) {
  const byRs = parseTerrainSlicePack(sliceBytes);
  const parsedByRs = new Map();
  const byLayer = new Array(TERRAIN_BC7_DEPTH).fill(null);
  const layerRs = new Array(TERRAIN_BC7_DEPTH).fill(null);
  let size = 0;
  let levels = 0;
  for (const [idxStr, meta] of Object.entries(manifest.layers ?? {})) {
    const idx = Number.parseInt(idxStr, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= TERRAIN_BC7_DEPTH) continue;
    const rsStr = String(meta?.rsId ?? "");
    if (!rsStr) continue;
    layerRs[idx] = rsStr;
    const rs = Number.parseInt(rsStr, 16) >>> 0;
    if (!parsedByRs.has(rs)) {
      const payload = byRs.get(rs);
      if (!payload) {
        throw new Error(`t128 slice (${channel}) has no payload for ${rsStr}`);
      }
      parsedByRs.set(rs, parseHbc7(payload));
    }
    const p = parsedByRs.get(rs);
    if (!size) { size = p.width; levels = p.levels.length; }
    if (p.width !== size || p.height !== size) {
      throw new Error(`t128 slice layer ${idx} (${rsStr}) is ${p.width}x${p.height}, array is ${size}x${size}`);
    }
    if (p.levels.length !== levels) {
      throw new Error(`t128 slice layer ${idx} (${rsStr}) has ${p.levels.length} levels, array has ${levels}`);
    }
    byLayer[idx] = p;
  }
  for (let i = 0; i < TERRAIN_BC7_DEPTH; i += 1) {
    if (!byLayer[i]) throw new Error(`t128 slice (${channel}) missing layer ${i}`);
  }
  if (levels < 2) {
    // Same hard rule as the manifest check: a level-0-only array with a
    // mipmapped minFilter is INCOMPLETE and samples BLACK.
    throw new Error(`t128 slice (${channel}) has ${levels} level(s); terrain requires a chain`);
  }
  return { byLayer, tileSize: size, levels, layerRs };
}

/** Both t128 channels, or null (counted) when the slice source is absent. */
async function _loadT128Pair(manifest) {
  const ctl = await _ladderController();
  if (!ctl || !ctl.armed) {
    _stats.ladder.lastError = "pack controller not armed (`?packSource` off or legacy dist)";
    return null;
  }
  const out = {};
  for (const chan of ["color", "nra"]) {
    // eslint-disable-next-line no-await-in-loop
    const bytes = await _awaitSlice(ctl, chan, TERRAIN_SLICE_WAIT_MS);
    if (!bytes) {
      _stats.ladder.lastError = `t128 ${chan} slice did not arrive within ${TERRAIN_SLICE_WAIT_MS} ms`;
      return null;
    }
    try {
      out[chan] = _t128ChannelFromSlice(manifest, bytes, chan);
    } catch (e) {
      _stats.ladder.lastError = `t128 ${chan}: ${String(e?.message ?? e)}`;
      return null;
    }
  }
  _stats.ladder.sliceSource = "pack";
  return out;
}

// --------------------------------------------------------------------------
// the wholesale swap + upload observation + mirror release
// --------------------------------------------------------------------------

/** Chain an upload watcher (three fires `onUpdate` at the end of
 *  `uploadTexture` — three.module.js:12378, every format branch), never
 *  replacing one an owner already installed: the same pattern the full-tier
 *  mirror seam uses.
 *
 *  It also runs `tex.__hbAfterUpload` if one is armed. That indirection is
 *  what makes the mirror release EVENT-DRIVEN rather than deadline-driven,
 *  and it was put here by evidence: on the local SwiftShader arm
 *  (2026-08-10, `?terrainBc7=512&terrainT1024=eager`) the swapped arrays
 *  uploaded LATER than the staging wait, so a release gated on the wait's
 *  return value freed exactly 0 bytes (`mirrorReleaseDeferred 2`). The wait
 *  bounds SEQUENCING (when to stage the second array); the release belongs
 *  to the upload, whenever three gets to it. */
function _armUploadWatcher(tex) {
  if (tex.__hbTerrainWatch) return;
  tex.__hbTerrainWatch = true;
  const prev = typeof tex.onUpdate === "function" ? tex.onUpdate : null;
  tex.onUpdate = function (t) {
    try { prev?.call(this, t); } catch (_) { /* never break an upload */ }
    tex.__hbUploaded = true;
    const after = tex.__hbAfterUpload;
    if (after) { tex.__hbAfterUpload = null; try { after(); } catch (_) { /* never break an upload */ } }
  };
}

/** Resolve once three has uploaded `tex`, or after the deadline (counted).
 *  The deadline bounds the STAGING SEQUENCE only — see `_armUploadWatcher`. */
function _awaitUpload(tex, ms = TERRAIN_UPLOAD_WAIT_MS) {
  if (tex.__hbUploaded) return Promise.resolve(true);
  const t0 = _ladder.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (tex.__hbUploaded) return resolve(true);
      if (_ladder.now() - t0 >= ms) {
        _stats.ladder.uploadWaitTimeouts += 1;
        return resolve(false);
      }
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(tick);
      else _ladder.timers.push(setTimeout(tick, 16));
      return undefined;
    };
    tick();
  });
}

/**
 * WHOLESALE SWAP, in place. Keeps the texture OBJECT (every material uniform
 * above this file keeps pointing at it) and re-specs its storage.
 *
 * `dispose()` is what makes the re-spec legal: it drops three's per-texture
 * properties, so the next upload takes the `allocateMemory` branch and calls
 * `texStorage3D` at the NEW dims instead of trying to `compressedTexSubImage3D`
 * 1024² bytes into a 128² allocation.
 */
function _swapArrayInPlace(tex, mips, aniso) {
  if (!tex || !mips) return false;
  // Any standing "these bytes are gone, here is the way back" registration
  // describes the OLD mip set. Drop it before the swap; the new tier
  // registers its own after ITS upload.
  try { unregisterReleasedTexture(tex); } catch (_) { /* fail-soft */ }
  try { tex.dispose(); } catch (_) { /* a texture never bound has nothing to free */ }
  tex.mipmaps = mips.mipmaps;
  tex.image = { width: mips.size, height: mips.size, depth: TERRAIN_BC7_DEPTH };
  tex.minFilter = mips.levels > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  if (mips.levels > 1 && typeof aniso === "number" && aniso > 0) tex.anisotropy = aniso;
  tex.__hbUploaded = false;
  _armUploadWatcher(tex);
  tex.needsUpdate = true;
  return true;
}

/**
 * D-05.7 row 1: free one array's CPU mirror, way back FIRST.
 * @param {Object} tex live array
 * @param {() => Promise<{mipmaps:Array}|null>} rebuild re-supplies the SAME
 *   dims/level count (re-fetch payloads → assemble). A rebuild that
 *   disagrees with the descriptor is a MISS, not a re-spec.
 */
function _releaseArrayMirror(tex, label, rebuild) {
  if (!tex || !Array.isArray(tex.mipmaps) || tex.mipmaps.length === 0) return 0;
  if (!tex.__hbUploaded) {
    // Releasing before three has uploaded would upload nothing (T15R D2).
    // The caller counts the deferral (`mirrorReleaseDeferred`) — this guard
    // is the invariant, not the instrument.
    return 0;
  }
  const bytes = terrainBc7Bytes(tex);
  if (!bytes) return 0;
  try {
    registerReleasedTexture(
      tex,
      // `t` is the registry's argument, never the captured texture: the
      // registry holds this callback strongly, so closing over the texture
      // would pin the very bytes this exists to free (T15R's fixup).
      async (t) => {
        const mips = await rebuild();
        const dst = t.mipmaps;
        if (!mips || !Array.isArray(mips.mipmaps) || mips.mipmaps.length !== dst.length) {
          _stats.ladder.mirrorRestoreFailed += 1;
          return false;
        }
        for (let i = 0; i < dst.length; i += 1) {
          const src = mips.mipmaps[i];
          if (!src || !src.data || (dst[i].width | 0) !== (src.width | 0)
              || (dst[i].height | 0) !== (src.height | 0)) {
            _stats.ladder.mirrorRestoreFailed += 1;
            return false;
          }
          dst[i].data = src.data;
        }
        if (t.image && typeof t.image === "object") t.image.data = undefined;
        _stats.ladder.mirrorRestores += 1;
        return true;
      },
      { label, owner: "terrainT1024:array", bytes },
    );
  } catch (_) {
    return 0; // a registration we could not make is a release we must not do
  }
  for (const m of tex.mipmaps) { if (m) m.data = new Uint8Array(0); }
  // `textureHasPixels` reads `image` FIRST and treats an object with no
  // `data` KEY as element-backed — a compressed array's image is the bare
  // {width,height,depth} descriptor, so without this line every restore
  // pass would SKIP the terrain arrays (T15R D3, same trap).
  if (tex.image && typeof tex.image === "object") tex.image.data = null;
  _stats.ladder.mirrorsReleased += 1;
  _stats.ladder.mirrorBytesFreed += bytes;
  return bytes;
}

/** Re-supply source for a released array: re-fetch the tier's payloads
 *  (immutable HTTP cache) and re-assemble. Shared by the restore pass and,
 *  by construction, identical to what the promotion did. */
function _rebuildTierMips(tier, channel) {
  return async () => {
    if (tier === "t128") {
      const pair = await _loadT128Pair(_ladder.manifest);
      return pair ? _mipsFromChannel(pair[channel]) : null;
    }
    const ch = await loadTerrainBc7Channel(_ladder.manifest, channel, _ladder.base);
    if (!ch) return null;
    return _assembleChannelMips(_ladder.manifest, channel, _ladder.base, ch);
  };
}

// --------------------------------------------------------------------------
// promote / demote
// --------------------------------------------------------------------------

/**
 * Promote the live arrays from t128 to the resolved full tier, wholesale.
 * Idempotent + latched: concurrent callers share one promotion.
 *
 * ALL-OR-NOTHING per channel, and a failure LEAVES t128 ON SCREEN — which is
 * strictly better than the legacy path's failure mode (fall back to RGBA8),
 * because t128 is already correct art at correct colours.
 */
export function promoteTerrainT1024Now() {
  if (_ladder.promise) return _ladder.promise;
  if (!_ladder.color || !_ladder.manifest) return Promise.resolve(false);
  if (_stats.ladder.tier && _stats.ladder.tier !== "t128") return Promise.resolve(true);
  _ladder.promise = _promoteToFullTier().finally(() => { _ladder.promise = null; });
  return _ladder.promise;
}

async function _promoteToFullTier() {
  const tier = _stats.ladder.fullTier || "t1024";
  const t0 = _ladder.now();
  _stats.ladder.promoteStartMs = t0;
  // Tier-aware anisotropy is resolved HERE, not at t128: the floor exists
  // for the high-res tier only (`terrainBc7Anisotropy`), and a t128 array
  // asking for 16 taps would spend them on 128² texels.
  const aniso = terrainBc7Anisotropy(_ladder.anisoBase, tier);
  const chans = _ladder.nra ? ["color", "nra"] : ["color"];
  const built = {};
  for (const chan of chans) {
    // eslint-disable-next-line no-await-in-loop
    const ch = await loadTerrainBc7Channel(_ladder.manifest, chan, _ladder.base);
    if (!ch) {
      _stats.ladder.promoteFailures += 1;
      _stats.ladder.lastError = `${tier} ${chan} channel unavailable — staying at t128`;
      // eslint-disable-next-line no-console
      console.warn(`[terrain-bc7] ladder: ${tier} ${chan} unavailable — terrain stays at t128`);
      return false;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      built[chan] = await _assembleChannelMips(_ladder.manifest, chan, _ladder.base, ch);
    } catch (e) {
      built[chan] = null;
      _stats.ladder.lastError = `${tier} ${chan} assembly: ${String(e?.message ?? e)}`;
    }
    if (!built[chan]) {
      _stats.ladder.promoteFailures += 1;
      _stats.errors += 1;
      // eslint-disable-next-line no-console
      console.warn(`[terrain-bc7] ladder: ${tier} ${chan} assembly failed — terrain stays at t128`);
      return false;
    }
  }

  // ── staging (P-88MIB) ──────────────────────────────────────────────────
  // One array per frame: 44 MiB / ~43–45 ms measured on the 1070, vs 88 MiB
  // / 87–96 ms whole. Both clear F6's 250 ms line; the split keeps 5×
  // headroom and leaves the frame between the two uploads free for the
  // scheduler's own work.
  const swapOne = async (chan) => {
    const tex = chan === "color" ? _ladder.color : _ladder.nra;
    const s0 = _ladder.now();
    _swapArrayInPlace(tex, built[chan], aniso);
    // Arm the release BEFORE anything can upload: the watcher fires it the
    // moment three actually uploads, which on a slow rasteriser is long
    // after the staging wait below has returned.
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      _releaseArrayMirror(tex, `terrain:${chan}:${tier}`, _rebuildTierMips(tier, chan));
    };
    tex.__hbAfterUpload = release;
    try { _stageUpload(tex); } catch (e) {
      _stats.ladder.lastError = `stage ${chan}: ${String(e?.message ?? e)}`;
    }
    const uploaded = await _awaitUpload(tex);
    const ms = _ladder.now() - s0;
    if (chan === "color") _stats.ladder.stageColorMs = ms;
    else _stats.ladder.stageNraMs = ms;
    if (uploaded) release();
    else _stats.ladder.mirrorReleaseDeferred += 1; // still armed on the event
  };
  await swapOne("color");
  if (chans.includes("nra")) {
    if (TERRAIN_STAGE_SPLIT) {
      _stats.ladder.stageSplit += 1;
      await new Promise((r) => {
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => r());
        else _ladder.timers.push(setTimeout(r, 0));
      });
    }
    await swapOne("nra");
  }

  _stats.ladder.tier = tier;
  _stats.ladder.promotions += 1;
  _stats.ladder.terrainT1024CompleteMs = _ladder.now();
  _stats.tileSize = built.color.size;
  _stats.levels = built.color.levels;
  _stats.anisotropy = aniso;
  // eslint-disable-next-line no-console
  console.log(
    `[terrain-bc7] ladder: promoted t128 → ${tier} (${built.color.size}px, ` +
      `${built.color.levels} levels, aniso ${aniso}, ${chans.length} array(s), ` +
      `${Math.round(_ladder.now() - t0)} ms, mirrors freed ` +
      `${(_stats.ladder.mirrorBytesFreed / (1024 * 1024)).toFixed(1)} MiB)`
  );
  return true;
}

/**
 * The terrain rung of the pressure ladder (pass-6 H-05.1 R1: "demote full-
 * tier textures of PARKED slots to preview; **terrain t1024→t128 demote**"),
 * shaped like `MaterialCache.demoteFullTierUnderPressure` so the residency
 * ladder's rung action stays a one-liner on both lanes.
 *
 * The demote needs NO fetch: the t128 mip sets are retained for exactly this
 * (0.9 MiB for both arrays — the cheapest insurance in the texture budget),
 * which is also why `?terrainT1024=off` is a coherent pinned arm rather than
 * a separate code path.
 *
 * @param {{bytes?:number, max?:number}} [opts]
 * @returns {{demoted:number, bytesFreed:number, remaining:number}}
 */
export function demoteTerrainUnderPressure(opts = {}) {
  const target = Number.isFinite(opts.bytes) ? opts.bytes : Infinity;
  const max = Number.isFinite(opts.max) ? opts.max : Infinity;
  let demoted = 0;
  let bytesFreed = 0;
  if (!_stats.ladder.armed || _stats.ladder.tier === "t128" || max < 1) {
    return { demoted, bytesFreed, remaining: 0 };
  }
  const aniso = terrainBc7Anisotropy(_ladder.anisoBase, "t128");
  // Colour first, deliberately: a capped call (`max: 1`) then sheds the
  // channel the eye reads, and the tier stamp follows the colour array.
  for (const chan of ["color", "nra"]) {
    if (demoted >= max || bytesFreed >= target) break;
    const tex = chan === "color" ? _ladder.color : _ladder.nra;
    const mips = _ladder.t128[chan];
    if (!tex || !mips) continue;
    // A RELEASED mirror has no bytes to account and nothing to give back,
    // but the swap still frees the GPU allocation — count only what the
    // heap actually gives up.
    const before = textureHasPixels(tex) ? terrainBc7Bytes(tex) : 0;
    _swapArrayInPlace(tex, mips, aniso);
    demoted += 1;
    bytesFreed += before;
  }
  if (demoted > 0) {
    _stats.ladder.demotions += 1;
    _stats.ladder.tier = "t128";
    _stats.tileSize = TERRAIN_T128_TILE;
    _stats.levels = _ladder.t128.color ? _ladder.t128.color.levels : _stats.levels;
    _stats.anisotropy = aniso;
    // eslint-disable-next-line no-console
    console.log(
      `[terrain-bc7] ladder: demoted to t128 under pressure (${demoted} array(s), ` +
        `${(bytesFreed / (1024 * 1024)).toFixed(1)} MiB CPU)`
    );
  }
  return { demoted, bytesFreed, remaining: 0 };
}

/** Schedule the promotion per mode. `off` never promotes; `eager` starts at
 *  once; `defer` waits for the converged signal + a settle, with a hard
 *  ceiling so a session cannot be stranded at t128. */
function _schedulePromotion(mode) {
  if (mode === "off") return;
  if (mode === "eager") { promoteTerrainT1024Now().catch(() => {}); return; }
  const t0 = _ladder.now();
  const poll = () => {
    if (_stats.ladder.tier !== "t128") return; // already promoted/demoted away
    const ctl = _ladder.controller;
    const ms = ctl?.diag?.milestones ?? null;
    // `convergedMs` is the milestone SPEC names; today NOTHING stamps it
    // (read-verified: pack_fetch_controller.js sets inWorldMs :666 and
    // previewCompleteMs :779-780 only). Until a producer does, the ladder
    // uses preview-complete + a settle as the converged proxy rather than
    // waiting forever on a field that is null by construction.
    const signal = ms ? (ms.convergedMs ?? ms.previewCompleteMs) : null;
    const elapsed = _ladder.now() - t0;
    if ((signal != null && elapsed >= TERRAIN_LADDER_DEFER_SETTLE_MS)
        || elapsed >= TERRAIN_LADDER_DEFER_MAX_MS) {
      promoteTerrainT1024Now().catch(() => {});
      return;
    }
    _ladder.timers.push(setTimeout(poll, 250));
  };
  _ladder.timers.push(setTimeout(poll, TERRAIN_LADDER_DEFER_SETTLE_MS));
}

/**
 * Boot the ladder: build the pair at t128 and schedule the promotion.
 * Returns the same atlas shape `buildTerrainBc7Atlas` returns, or null when
 * the ladder cannot arm (no slice source) — the caller then runs the legacy
 * full-tier boot, loudly and counted.
 */
async function _buildViaLadder({ manifest, base, anisotropy, mode }) {
  const t0 = _ladder.now();
  _stats.ladder.mode = mode;
  _stats.ladder.fullTier = manifest.tier ?? "t1024";
  const pair = await _loadT128Pair(manifest);
  if (!pair) {
    _stats.ladder.fallbacks += 1;
    // eslint-disable-next-line no-console
    console.warn(
      `[terrain-bc7] ?terrainT1024=${mode} but the t128 boot slice is unavailable ` +
        `(${_stats.ladder.lastError}) — booting the full tier directly (legacy order)`
    );
    return null;
  }
  // t128 assembles on the MAIN thread on purpose: 0.63 MB per channel is
  // three orders below the 88 MiB t1024 case the worker seam (D-05.4) was
  // built for, and a transfer round-trip would cost more than the memcpy.
  const aniso = terrainBc7Anisotropy(anisotropy, "t128");
  const mipsColor = _mipsFromChannel(pair.color);
  const mipsNra = _mipsFromChannel(pair.nra);
  const atlasTexture = _makeCompressedArrayTexture(mipsColor.mipmaps, mipsColor.size, mipsColor.levels, {
    colorSpace: THREE.SRGBColorSpace,
    anisotropy: aniso,
    name: "scene3d-terrain-bc7-albedo-array",
  });
  if (!atlasTexture) return null;
  const nraTexture = _makeCompressedArrayTexture(mipsNra.mipmaps, mipsNra.size, mipsNra.levels, {
    colorSpace: THREE.NoColorSpace,
    anisotropy: aniso,
    name: "scene3d-terrain-bc7-nra-array",
  });
  _armUploadWatcher(atlasTexture);
  if (nraTexture) _armUploadWatcher(nraTexture);
  try {
    _stageUpload(atlasTexture);
    if (nraTexture) _stageUpload(nraTexture);
  } catch (e) {
    _stats.ladder.lastError = `stage t128: ${String(e?.message ?? e)}`;
  }

  _ladder.mode = mode;
  _ladder.manifest = manifest;
  _ladder.base = base;
  _ladder.aniso = aniso;
  _ladder.anisoBase = Number.isFinite(anisotropy) ? anisotropy : null;
  _ladder.color = atlasTexture;
  _ladder.nra = nraTexture;
  // Retained: the demote source (R1) AND the t128 restore source. 0.9 MiB.
  _ladder.t128 = { color: mipsColor, nra: mipsNra };

  _stats.layers = TERRAIN_BC7_DEPTH;
  _stats.tileSize = mipsColor.size;
  _stats.levels = mipsColor.levels;
  _stats.built = nraTexture ? "color+nra" : "color";
  _stats.anisotropy = aniso;
  _stats.anisotropyBase = Number.isFinite(anisotropy) ? anisotropy : null;
  _stats.ladder.armed = true;
  _stats.ladder.tier = "t128";
  _stats.ladder.t128Ms = _ladder.now() - t0;
  _stats.ladder.t128Bytes = terrainBc7Bytes(atlasTexture) + terrainBc7Bytes(nraTexture);
  // eslint-disable-next-line no-console
  console.log(
    `[terrain-bc7] ladder ${mode}: terrain converged at t128 ` +
      `(${TERRAIN_BC7_DEPTH} layers @ ${mipsColor.size}px, ${mipsColor.levels} levels, ` +
      `${(_stats.ladder.t128Bytes / (1024 * 1024)).toFixed(2)} MiB GPU, aniso ${aniso}) — ` +
      `${mode === "off" ? "pinned (no promotion)" : `${_stats.ladder.fullTier} promotion ${mode}`}`
  );
  _schedulePromotionSafely(mode);
  return {
    atlasTexture,
    nraTexture,
    tileSize: mipsColor.size,
    levels: mipsColor.levels,
    bytes: _stats.ladder.t128Bytes,
    manifest,
    ladder: mode,
  };
}

/** Scheduling must never take the boot down with it. */
function _schedulePromotionSafely(mode) {
  try { _schedulePromotion(mode); } catch (e) {
    _stats.ladder.lastError = `schedule: ${String(e?.message ?? e)}`;
  }
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

  // ST5 tier ladder (`?terrainT1024`). ABSENT ⇒ not one line of the ladder
  // runs and everything below is the 2026-08-05 path byte-for-byte (I7's
  // kill path). PRESENT ⇒ boot at t128 and promote per mode; a ladder that
  // cannot arm (no slice source) falls through here, loudly and counted, so
  // the flag can never leave a session with no terrain at all.
  const ladderMode = terrainT1024Mode();
  if (ladderMode !== "absent") {
    const laddered = await _buildViaLadder({ manifest, base, anisotropy, mode: ladderMode });
    if (laddered) return laddered;
  }

  const color = await loadTerrainBc7Channel(manifest, "color", base);
  if (!color) return null;

  // Tier-aware anisotropy — resolved AFTER the manifest, because the floor only
  // applies to the high-res tier (see `terrainBc7Anisotropy`).
  const aniso = terrainBc7Anisotropy(anisotropy, manifest.tier);
  _stats.anisotropy = aniso;
  _stats.anisotropyBase = Number.isFinite(anisotropy) ? anisotropy : null;

  let atlasTexture;
  try {
    atlasTexture = await _assembleChannelArray(manifest, "color", base, color, {
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
      nraTexture = await _assembleChannelArray(manifest, "nra", base, nra, {
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
