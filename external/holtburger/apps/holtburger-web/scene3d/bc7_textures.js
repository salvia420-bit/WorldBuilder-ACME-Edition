// scene3d/bc7_textures.js — BC7 (BPTC) direct-to-GPU texture path.
//
// WHAT THIS IS
// The client half of the BC7 texture track: instead of decoding a
// RenderSurface to RGBA8 on the CPU and uploading 32 bpp, fetch a
// pre-encoded BC7 block payload and hand the blocks to the GPU verbatim
// (`compressedTexImage2D` / `compressedTexImage3D` under the hood, via
// three.js `CompressedTexture` / `CompressedArrayTexture`). 8 bpp on the
// GPU instead of 32, and zero CPU decode.
//
// TRANSPORT CONTRACT (fixed by the lead; the bake/delivery half is a
// separate work item — this module only consumes it):
//   namespace  `holtburger/tex-bc7`
//   record key RenderSurface id as u32 (e.g. 0x06003789)
//   payload    "HBC7" container, little-endian:
//                magic "HBC7" (4 B) | u32 width | u32 height
//                | u32 blocksX | u32 blocksY | BC7 blocks (16 B / 4x4 px)
//              `width`/`height` are TRUE pixel dims and MAY be
//              non-multiples of 4; the blocks cover the padded area.
//              Blocks are COMPRESSED_RGBA_BPTC_UNORM_EXT (opaque
//              surfaces still encode alpha = 255).
//
// MIP LEVELS
// Every level of an HBC7 chain is consumed: `parseHbc7` walks the trailing
// halving chain (min 1x1) and `makeBc7Texture` enables mipmapped filtering
// whenever a chain is present. The shipped payloads (tex-bc7, previews, PVW
// pack payloads, terrain) all carry FULL chains — proven byte-exact from the
// bake ledger (a 2048^2 record is 5,592,452 B = 12-level chain + 20 B
// header; level 0 alone does not reconcile). A level-0-only payload still
// parses and MUST sample `minFilter = LinearFilter` — `texStorage3D(levels
// = 1)` plus a mipmapped minFilter is an incomplete texture and samples
// BLACK. That branch is a LOUD DIAGNOSTIC path now, not a contract
// (SPEC ST5 / pass 5 S5).
//
// ARRAY PATH (ST5, `?texCompressedOnly`): `makeBc7ArrayTexture` allocates
// the FULL halving chain when built with `opts.mipChain` (+ aniso from
// `opts.anisotropy`), and `writeBc7ArrayLayer` writes EVERY level of a
// chain-allocated array — closing the measured singleton-vs-atlas quality
// asymmetry (shimmer/moire on tiling surfaces; pass 5 D-05.6.1: the cost is
// +1/3 on compressed array bytes, priced there — memory/quality grounds,
// never an fps claim). The OFF arm (flag absent) allocates level 0 only,
// byte-identical to the pre-ST5 path — that is the kill path (I7).
// KNOWN COST, read-verified in three r184: with a mip chain + layerUpdates,
// three clears `layerUpdates` after mip 0, so a marked-layer write uploads
// marked layers at level 0 but the FULL depth at levels 1+ (~1/3 of the
// array's bytes per write). Correct output; counted; P4 upload staging
// (ST9) restructures it.
//
// FEATURE DETECTION IS MANDATORY, NOT OPTIONAL
// `EXT_texture_compression_bptc` is absent on plenty of real devices. (It is
// NOT absent on this laptop's SwiftShader, contrary to what this header and
// the url-flags row both claimed until 2026-08-05 — the probe reports it
// present and the whole path renders locally.) Without the extension three's `convert()`
// returns a null gl format and warns "Attempt to load unsupported
// compressed texture format" once per texture — i.e. flag-ON on an
// unsupported GPU would be a console-noise + all-white-texture bug. So:
//   - `bc7Enabled()` was an EXACT-MATCH opt-in until 2026-07-30, when it was
//     flipped DEFAULT-ON after the 1070 frame-time A/B (see the reader). This
//     header said "EXACT-MATCH opt-in ... DEFAULT OFF" for three days after
//     that flip; corrected 2026-08-02. `?texBc7=off` is the escape.
//   - `bc7Available()` additionally requires `initBc7(renderer)` to have
//     observed the extension. Every consumer calls `bc7Available()`, so an
//     unsupported GPU behaves EXACTLY like flag-off: the existing
//     decode-to-RGBA8 path, no fetches, no textures, no warnings.
//
// DEFAULT ON since 2026-07-30 (`?texBc7=off` escapes), still hard-gated on the
// extension: nothing here allocates or fetches until `bc7Available()` is true.
// (This trailer said "DEFAULT OFF ... until ?texBc7=on" for six days after the
// flip, contradicting the reader eighteen lines above it.)

import * as THREE from "three";
// P2 — call-time-only cycle with xu7_textures.js (it imports bc7BlocksFor/
// bc7LevelBytes back from here); both sides bind functions, never eval-time
// values, so the cycle is safe.
import { texXu7Enabled, transcodeXu7, xu7Stats, ensureXu7Transcoder, texWorkerStats } from "./xu7_textures.js";
import {
  textureRehydrateStats,
  registerReleasedTexture,
  unregisterReleasedTexture,
} from "./texture_rehydrate.js";

// --------------------------------------------------------------------------
// flag + capability
// --------------------------------------------------------------------------

/**
 * The shared "this flag is switched off" predicate for the texture family.
 *
 * `texBc7`, `texPre` and `terrainBc7` each inlined `off|0|false|no`, and
 * `texXu7` shipped `!== "off"` — so `?texXu7=0`, `=false` and `=no` all read ON
 * while the identical spelling disabled its three siblings. The flag audit
 * passed the whole time, because the docs faithfully recorded the divergence.
 * One predicate, imported by all four, is what actually removes the class.
 *
 * @param {string|null} v raw query value (null/undefined ⇒ not off)
 */
export function flagIsOff(v) {
  if (v == null) return false;
  const t = String(v).toLowerCase();
  return t === "off" || t === "0" || t === "false" || t === "no";
}

let _flag;
/** `?texBc7=on` — EXACT-MATCH opt-in (`on`/`1`/`true`/`yes`). Absent, empty,
 *  or any other value reads OFF. Pass `search` explicitly in worker context;
 *  defaults to the page's own query string. */
export function bc7Enabled(search) {
  if (_flag !== undefined && search === undefined) return _flag;
  // DEFAULT-ON since 2026-07-30 (1070, Dryreach, quality=mid, 400 frames/arm:
  // everything-on measured 35.2 ms median / 28.4 fps vs 36.7 / 27.2 for the bare
  // default — compressed textures cut enough bandwidth to more than pay for the
  // normal-map fragment work). Still hard-gated on EXT_texture_compression_bptc
  // below, so a GPU without BPTC falls back to the RGBA8 path regardless.
  let on = true;
  try {
    const s =
      search !== undefined
        ? search
        : typeof window !== "undefined" && window.location
          ? window.location.search
          : "";
    on = !flagIsOff(new URLSearchParams(s).get("texBc7"));
  } catch (_) {
    on = true;
  }
  if (search === undefined) _flag = on;
  return on;
}

let _supported = null; // null = not probed yet, true/false = probed
let _detectNote = "not probed";

/**
 * Probe `EXT_texture_compression_bptc` on the app's real WebGL context.
 * Called once from scene3d/index.js right after the renderer is built.
 * Safe to call with a null/absent renderer (records "no renderer").
 * @returns {boolean} whether the direct-BC7 path is usable on this GPU.
 */
export function initBc7(renderer) {
  if (!bc7Enabled()) {
    _supported = false;
    _detectNote = "flag off";
    return false;
  }
  try {
    // three's WebGLExtensions.has() caches the getExtension() result and is
    // what `convert()` itself consults, so this probes exactly the object
    // the upload path will use.
    if (renderer && renderer.extensions && typeof renderer.extensions.has === "function") {
      _supported = !!renderer.extensions.has("EXT_texture_compression_bptc");
      _detectNote = _supported ? "EXT_texture_compression_bptc present" : "EXT_texture_compression_bptc ABSENT";
    } else if (renderer && typeof renderer.getContext === "function") {
      const gl = renderer.getContext();
      _supported = !!(gl && gl.getExtension("EXT_texture_compression_bptc"));
      _detectNote = _supported ? "bptc via raw getExtension" : "bptc ABSENT (raw getExtension)";
    } else {
      _supported = false;
      _detectNote = "no renderer";
    }
  } catch (e) {
    _supported = false;
    _detectNote = `probe threw: ${String(e && e.message ? e.message : e)}`;
  }
  // Loud once, on purpose: a flag-ON boot must say which arm it took.
  // eslint-disable-next-line no-console
  console.log(`[bc7] flag=on support=${_supported} (${_detectNote})`);
  return _supported;
}

/** True only when the flag is on AND the GPU has BPTC. Every consumer gates
 *  on this; false ⇒ the legacy decode→RGBA8 path, byte-identical. */
export function bc7Available() {
  return bc7Enabled() && _supported === true;
}

/** Test/diag hook: force the capability verdict without a renderer. */
export function _setBc7SupportForTest(v, note = "forced (test)") {
  _supported = v === null ? null : !!v;
  _detectNote = note;
}

export function bc7SupportNote() {
  return _detectNote;
}

// --------------------------------------------------------------------------
// ?texCompressedOnly — ST5 (SPEC §3 T15; pass 5 D-05.5): materials are BORN
// compressed from the resident PVW preview (scalars-only surface decode, no
// RGBA8 double-build); the full tier upgrades async via lane T + the texture
// worker. DEV opt-in, DEFAULT OFF (I7); REQUIRES `?packSource` (the PVW
// payloads live in packs — without the controller the path cannot arm and
// every consumer stays byte-identical legacy).
// --------------------------------------------------------------------------

/**
 * `?texCompressedOnly` — EXACT-MATCH DEV opt-in, **DEFAULT OFF** (the
 * orchestrator flips it after GATE-TEX). Only `on`/`1`/`true`/`yes` read
 * ON. Not memoized (the ESM suites re-stub `window` per case).
 */
export function texCompressedOnlyEnabled(search) {
  try {
    const s = search !== undefined ? search : typeof window !== "undefined" && window.location ? window.location.search : "";
    const v = new URLSearchParams(s).get("texCompressedOnly");
    if (v == null) return false;
    const t = String(v).toLowerCase();
    return t === "on" || t === "1" || t === "true" || t === "yes";
  } catch (_) {
    return false;
  }
}

// Armed by index.html AFTER init_resource_source + controller boot (the
// same ordering contract as `initBc7Source`; the T20 export-bag lesson —
// every export this path calls must be carried here or it silently no-ops).
const _tco = { wasmNs: null, controller: null };

/**
 * Arm the compressed-only path: `wasmNs` must carry `surface_meta_sync`,
 * `pack_pvw_blocks`, `pack_texref`, `xu7_cas_info`; `controller` is the
 * PackFetchController singleton (lane-T `need`). Fail-soft: never throws;
 * an un-armed path leaves every consumer on the legacy build.
 */
export function initTexCompressedOnly({ wasmNs, controller } = {}) {
  _tco.wasmNs = wasmNs || null;
  _tco.controller = controller || null;
  return texCompressedOnlyActive();
}

/** The live gate every consumer checks: flag ON + BPTC present + wasm
 *  exports armed + controller armed (`?packSource` on a pack dist). */
export function texCompressedOnlyActive() {
  return (
    texCompressedOnlyEnabled() &&
    bc7Available() &&
    !!(_tco.wasmNs && typeof _tco.wasmNs.surface_meta_sync === "function" &&
       typeof _tco.wasmNs.pack_pvw_blocks === "function") &&
    !!(_tco.controller && _tco.controller.armed)
  );
}

/** The armed namespace/controller pair (materials.js consumer). */
export function texCompressedOnlyNs() {
  return _tco;
}

/** Test hook. NOTE: does NOT clear the `atlasRefeed` registration — that
 *  belongs to the registering producer (static_atlas at module load); a
 *  suite that wants a clean seam passes `registerAtlasRefeed(null)`. */
export function _resetTexCompressedOnlyForTest() {
  _tco.wasmNs = null;
  _tco.controller = null;
}

// --------------------------------------------------------------------------
// atlasRefeed(rsId) — the PRODUCER-AGNOSTIC re-home seam (F-11.17).
// The full-tier upgrade calls this after swapping a material's map so every
// batched member of that rsId re-homes from its preview-dim bucket into the
// full-dim one. The ATLAS-side implementation (static_atlas.js registers it)
// is a CONSCIOUS THROWAWAY: it retires at ST9 when draw pools subsume the
// atlas — pools register their own handler against this same seam.
// --------------------------------------------------------------------------

let _atlasRefeedImpl = null;

// --------------------------------------------------------------------------
// PAGE-RESAMPLE (T22 D2) — the TEXREF page-dim read.
//
// The pool class key (`scene3d/pool_class_key.js`) tiers on TEXREF-DECLARED
// dims and demands that members be STORED at their page dims; the bake half
// of that landed as `page_resample.rs` + the `FULL_PAGE_DIMS` TEXREF tier
// bit. This is the one client-side read of that marker, exported here rather
// than in a pool module so the pool producer and any other consumer read the
// SAME decode.
//
// TWO THINGS A CONSUMER MUST NOT DO ITSELF, which is why this exists:
//
//  1. **Do not re-derive "is it on its page?" from the dims byte.** The byte
//     is 4 bits per axis of `ceil(log2)`, so a non-pow2 member (1096² is in
//     the shipped corpus) rounds to 2^11 x 2^11 and reads exactly like a real
//     2048² page. The BIT is the authority; the byte alone cannot be. Proven
//     in `apps/holtburger-tools/src/pack_bake.rs`
//     (`the_page_bit_is_the_authority_the_dims_byte_cannot_be`).
//  2. **Do not fall back to the DAT record's dims.** The shipped full tier is
//     the UPSCALE corpus — measured 4x the retail texture in each axis over a
//     400-record sample, which shifts the page tier for 253 of them. TEXREF
//     is the only place the dims that actually reach the GPU are declared.
//
// Reading is free of side effects beyond the two counters, and returns null
// whenever the seam is unarmed — so this is inert on the OFF arm by
// construction (nothing calls it, and if something does, it reports "no
// TEXREF row" exactly as the legacy route already expects).
// --------------------------------------------------------------------------

/**
 * TEXREF page facts for one RenderSurface id, or `null` when no resident
 * pack carries a TEXREF row for it (⇒ not world-texture content: equipment
 * and dynamics stay on the legacy lane).
 *
 * @param {number} rsId
 * @returns {{tierBits:number, dimsByte:number, w:number, h:number,
 *            onPage:boolean, hasFullTier:boolean, hasPreview:boolean}|null}
 */
export function texRefPageInfo(rsId) {
  const { wasmNs } = _tco;
  if (!wasmNs || typeof wasmNs.pack_texref !== "function") return null;
  let packed = -1;
  try { packed = wasmNs.pack_texref(rsId >>> 0); } catch (_) { return null; }
  if (!(packed >= 0)) return null;
  const tierBits = (packed >> 8) & 0xff;
  const dimsByte = packed & 0xff;
  // The declared dims, decoded from the log2 pair the bake wrote. Exact for
  // the pow2 corpus; an upper bound for a non-pow2 member (see above).
  const w = 1 << ((dimsByte >> 4) & 0x0f);
  const h = 1 << (dimsByte & 0x0f);
  const onPage = (tierBits & TIER_BIT_FULL_PAGE_DIMS) !== 0;
  if (onPage) _stats.texRefOnPage += 1; else _stats.texRefOffPage += 1;
  return {
    tierBits,
    dimsByte,
    w,
    h,
    onPage,
    hasFullTier: (tierBits & TIER_BIT_FULL_XU7_PRESENT) !== 0,
    hasPreview: (tierBits & TIER_BIT_PVW_PRESENT) !== 0,
  };
}

/** TEXREF tier bits, mirroring `pack_format.rs::tier_bits`. */
export const TIER_BIT_PVW_PRESENT = 1 << 0;
export const TIER_BIT_FULL_XU7_PRESENT = 1 << 1;
export const TIER_BIT_FULL_LOSSY = 1 << 2;
/** The member's stored full tier IS at its array-page dims (T22 D2). */
export const TIER_BIT_FULL_PAGE_DIMS = 1 << 5;

/** Register the current producer's re-home handler (`fn(rsId) → nodes`). */
export function registerAtlasRefeed(fn) {
  _atlasRefeedImpl = typeof fn === "function" ? fn : null;
}

/** Re-home every committed member of `rsId`. Returns re-homed node count
 *  (0 when no producer handler is registered — fail-soft by design). */
export function atlasRefeed(rsId) {
  if (!_atlasRefeedImpl) return 0;
  try {
    return _atlasRefeedImpl(rsId >>> 0) | 0;
  } catch (_) {
    return 0;
  }
}

// --------------------------------------------------------------------------
// RSID-MARKER — the universal rsId stamp (T22-PRODUCER Handoff 3).
//
// THE HOLE THIS CLOSES. A producer that holds a member out (the atlas's
// `bc7AtlasShouldDefer`, the pool feed's `bc7Pending` refusal) can only
// re-offer it later if it can NAME the surface the hold-out is waiting on —
// `atlasRefeed(rsId)` carries an rsId and nothing else. Until now the two
// existing markers were both written at the END of a tier's life:
// `__pvwRsId` at preview-BORN materials only (ST5), `__bc7RsId` only after a
// full tier LANDED. A material sitting in `__bc7Pending` — precisely the
// state that gets it refused — carried NEITHER. T22-PRODUCER's live arm read
// `refused.bc7Pending = 363` against `holdoutRsIds = 0`: 363 members refused
// with no key to re-offer them under, so they stayed on the legacy producer
// for the session unless their landblock happened to re-stream.
//
// `__texRsId` is that key: stamped ONCE, at the point the texture lane ASKS
// for a surface (which is the earliest moment the rsId is known and is
// strictly before any hold-out can be taken), and never cleared. It is an
// IDENTITY, not a state — the tier state stays on `__bc7`/`__bc7Pending`/
// `__texFullPending`, so no existing reader changes meaning.
//
// Read through `materialRsId()`, never by hand: the tier-specific markers win
// when present (they are the same number when both exist, and the ST5 escape
// arm's hold-out tracking already keys on them), and `__texRsId` is the
// fallback that makes the read total.
// --------------------------------------------------------------------------

/**
 * Stamp a material with the RenderSurface id its albedo is sourced from.
 * Idempotent, in-place (never `{...spread}`: this can run on a compiled
 * material and a spread drops materials.js's non-enumerable live handles).
 *
 * @param {object} mat
 * @param {number} rsId
 * @returns {number} the stamped id (0 = nothing stamped)
 */
export function stampRsId(mat, rsId) {
  const rs = rsId >>> 0;
  if (!mat || !rs) return 0;
  const ud = (mat.userData = mat.userData || {});
  if (ud.__texRsId === rs) return rs;
  ud.__texRsId = rs;
  _stats.rsIdStamped += 1;
  return rs;
}

/**
 * The RenderSurface id of a material, whichever marker carries it.
 * ONE reader so a producer's hold-out key and a refeed's key cannot drift.
 * @returns {number} 0 when the material is not surface-backed.
 */
export function materialRsId(mat) {
  const ud = mat && mat.userData;
  if (!ud) return 0;
  const rs = ud.__bc7RsId != null ? ud.__bc7RsId
    : (ud.__pvwRsId != null ? ud.__pvwRsId : ud.__texRsId);
  return (rs || 0) >>> 0;
}

/**
 * The BC7 verdict for `rsId` has RESOLVED (landed, absent, or failed) — every
 * producer holding members out on it may re-offer them now.
 *
 * Fires on ALL THREE outcomes deliberately: a member is held out because its
 * dims/format could still move, and a NEGATIVE verdict settles those just as
 * finally as a positive one (the material keeps the map it has, forever). A
 * hold-out that only ever un-held on success would strand every surface whose
 * record is absent.
 *
 * Inert wherever no producer registered a handler, and a NO-OP for the atlas
 * handler unless that rsId has tracked members (`_rsMembers` is populated only
 * under `?texCompressedOnly`) — which is why this is safe to call from the
 * legacy X6 upgrade path without changing the legacy arm.
 */
function _rsVerdictResolved(rsId) {
  const rs = rsId >>> 0;
  if (!rs) return;
  _stats.rsVerdictsResolved += 1;
  if (!_atlasRefeedImpl) return;
  _stats.rsRefeedsFired += 1;
  atlasRefeed(rs); // already fail-soft
}

// --------------------------------------------------------------------------
// T15R — rehydrate v3, row 2 of pass 5 D-05.7: the FULL-TIER CPU-mirror
// release seam (source-keyed, not plane-keyed).
//
// D-05.7 states the identity "full-tier mirror ≡ the record-cache entry
// (shared buffer, zero-copy)" and then the consequence T15 landed only half
// of: the mirror is "freed WITH record eviction via the release seam". That
// second half is this block. Without it the 128 MB budget is bookkeeping
// only — `_trimToBudget` drops the map entry while the live
// `CompressedTexture` still holds the SAME ArrayBuffer through its
// `mipmaps[i].data` subarrays, so the heap gives back nothing (the exact
// "evicting frees nothing while the texture lives" dead end D-05.7 calls
// obsolete).
//
// THE ORDERING RULE IS NON-NEGOTIABLE (texture_release.js:117-124): register
// the way back FIRST, drop the bytes second. A context loss landing between
// the two would find a texture with no pixels and no entry telling anyone to
// refill it — a permanently black world, the one outcome M4's rider forbids.
//
// POST-UPLOAD ONLY. Releasing before three has uploaded the texture would
// upload nothing. `registerFullTierMirror` installs the same `onUpdate` hook
// `armCpuRelease` uses (three fires it at the end of `uploadTexture`) and the
// release refuses — counted, never silent — until it has fired.
//
// The rehydrator is SOURCE-keyed: it re-runs the owner's fetch→transcode
// (materials.js `_fetchFullTierParsed`: lane-T CAS fetch, hash-on-receipt,
// worker transcode), never a pixel-plane decode. Previews need no entry at
// all (D-05.7 row 3: their mirror is KEPT — a few tens of KB, and three's own
// restore path re-uploads from it).
// --------------------------------------------------------------------------

/** rsId -> { ref: WeakRef<CompressedTexture>, restore, released }. WeakRef so
 *  the registry never becomes the retention it exists to remove (the same
 *  rule texture_rehydrate.js:76-79 states for its own entries). */
const _fullMirrors = new Map();

/** One shared zero-length view: a released level keeps its `{width,height}`
 *  descriptor and loses only its bytes, so `textureHasPixels` reads false
 *  (byteLength 0) and three's descriptor is untouched — this is a re-supply
 *  seam, never a re-spec. */
const _EMPTY_LEVEL = new Uint8Array(0);

/**
 * Arm one full-tier texture's mirror for release-at-eviction.
 *
 * @param {number} rsId RenderSurface id (the record-cache key — the mirror's
 *   identity, because the buffer IS the record).
 * @param {Object} tex the live `CompressedTexture` built from that record.
 * @param {() => Promise<Object|null>} restore resolves to a freshly parsed
 *   HBC7 (`{width,height,levels:[{data,width,height}]}`) — the owner's
 *   fetch→transcode path. A restore that cannot supply returns null.
 */
export function registerFullTierMirror(rsId, tex, restore) {
  const id = rsId >>> 0;
  if (!id || !tex || typeof restore !== "function") return false;
  if (!Array.isArray(tex.mipmaps) || tex.mipmaps.length === 0) return false;
  // Upload watcher — see the header. Chained, never replacing, so an owner
  // that already installed an `onUpdate` keeps it.
  if (!tex.__hbMirrorArmed) {
    tex.__hbMirrorArmed = true;
    const prev = typeof tex.onUpdate === "function" ? tex.onUpdate : null;
    tex.onUpdate = function (t) {
      try { prev?.call(this, t); } catch (_) { /* never break an upload */ }
      tex.__hbUploaded = true;
    };
  }
  _fullMirrors.set(id, { ref: new WeakRef(tex), restore, released: false });
  _stats.mirrorsArmed += 1;
  return true;
}

/** Drop the arming (the texture is being disposed — demote, eviction,
 *  teardown). Also clears any live rehydrate registration. */
export function unregisterFullTierMirror(rsId) {
  const id = rsId >>> 0;
  const e = _fullMirrors.get(id);
  if (!e) return false;
  _fullMirrors.delete(id);
  const tex = e.ref.deref();
  if (tex) {
    try { unregisterReleasedTexture(tex); } catch (_) { /* fail-soft */ }
  }
  return true;
}

/** Re-supply a released mirror in place: same dims, same level count, same
 *  format — a rehydrator that disagrees with the descriptor is a MISS, not a
 *  re-spec (the registry verifies with `textureHasPixels` either way). */
function _relevelInPlace(tex, parsed) {
  if (!parsed || !Array.isArray(parsed.levels)) return false;
  const mips = tex.mipmaps;
  if (!Array.isArray(mips) || parsed.levels.length < mips.length) return false;
  for (let i = 0; i < mips.length; i += 1) {
    const src = parsed.levels[i];
    const dst = mips[i];
    if (!src || !src.data || !dst) return false;
    if ((dst.width | 0) !== (src.width | 0) || (dst.height | 0) !== (src.height | 0)) return false;
    dst.data = src.data;
  }
  return true;
}

/**
 * Release one full-tier mirror: register the way back, then null the bytes.
 * Called from the record cache's eviction path (and available to the
 * pressure ladder). Returns the bytes actually given back.
 */
export function releaseFullTierMirror(rsId) {
  const id = rsId >>> 0;
  const e = _fullMirrors.get(id);
  if (!e || e.released) return 0;
  const tex = e.ref.deref();
  if (!tex) { _fullMirrors.delete(id); return 0; }
  if (!tex.__hbUploaded) { _stats.mirrorReleaseDeferred += 1; return 0; }
  const bytes = bc7TextureBytes(tex);
  if (!bytes) return 0;
  const label = `0x${id.toString(16).toUpperCase()}:texFull`;
  try {
    registerReleasedTexture(
      tex,
      // `t` is the registry's own argument, NOT the captured `tex`: the
      // registry holds this callback strongly, so closing over the texture
      // would pin it and make the WeakRef entry (and this module's map)
      // the retention they exist to prevent.
      async (t) => {
        const parsed = await e.restore();
        if (!parsed || !_relevelInPlace(t, parsed)) {
          // The registry logs + counts the miss; this counter is the
          // texture-lane's own view of it (`__texStats().mirrors`).
          _stats.mirrorRestoreFailed += 1;
          return false;
        }
        e.released = false;
        // The mirror is the record again (D-05.7's identity) — re-adopt so
        // the budget keeps governing it.
        try { _source?.adoptParsed(id, parsed); } catch (_) { /* best-effort */ }
        _stats.mirrorRestores += 1;
        return true;
      },
      { label, owner: "texCompressedOnly:full", bytes },
    );
  } catch (_) {
    return 0; // a registration we could not make is a release we must not do
  }
  for (const m of tex.mipmaps) { if (m) m.data = _EMPTY_LEVEL; }
  // `textureHasPixels` reads `image` FIRST and treats an object with no
  // `data` KEY as element-backed ("canvas/ImageBitmap carry their own
  // pixels") — a compressed texture's `image` is the bare `{width,height}`
  // descriptor `makeBc7Texture` builds, so without this the released texture
  // would report pixels it does not have and every restore pass would SKIP
  // it. Declaring the key (null) routes the predicate to `mipmaps`, which is
  // where a compressed texture's bytes actually live.
  if (tex.image && typeof tex.image === "object") tex.image.data = null;
  e.released = true;
  _stats.mirrorsFreed += 1;
  _stats.mirrorBytesFreed += bytes;
  return bytes;
}

/** Diag/test: how many full-tier mirrors are armed, and how many are
 *  currently released (bytes given back, way back registered). */
export function fullTierMirrorStats() {
  let released = 0;
  let live = 0;
  for (const [id, e] of _fullMirrors) {
    if (!e.ref.deref()) { _fullMirrors.delete(id); continue; }
    live += 1;
    if (e.released) released += 1;
  }
  return { armed: live, released };
}

/** Test hook — the registry is module state, so the suites need a reset. */
export function _resetFullTierMirrorsForTest() {
  for (const [, e] of _fullMirrors) {
    const t = e.ref.deref();
    if (t) { try { unregisterReleasedTexture(t); } catch (_) { /* fail-soft */ } }
  }
  _fullMirrors.clear();
}

// --------------------------------------------------------------------------
// HBC7 container parse
// --------------------------------------------------------------------------

export const HBC7_MAGIC = 0x37434248; // "HBC7" read as LE u32
export const HBC7_HEADER_BYTES = 20;
export const BC7_BLOCK_BYTES = 16;

/** Blocks needed to cover `n` pixels along one axis (4x4 BC7 blocks). */
export function bc7BlocksFor(n) {
  return Math.ceil(Math.max(0, n | 0) / 4);
}

/** Byte length of one BC7 mip level at these TRUE pixel dims. Identical to
 *  three's own `getByteLength(w, h, RGBA_BPTC_Format, …)`
 *  (`ceil(w/4) * ceil(h/4) * 16`), which is what the array-layer subarray
 *  math in WebGLTextures uses — they MUST agree or per-layer uploads slice
 *  the wrong bytes. */
export function bc7LevelBytes(w, h) {
  return bc7BlocksFor(w) * bc7BlocksFor(h) * BC7_BLOCK_BYTES;
}

/**
 * Parse an HBC7 payload.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{width:number, height:number, blocksX:number, blocksY:number,
 *            levels:Array<{data:Uint8Array,width:number,height:number}>}}
 * @throws {Error} with a precise reason on any malformed field. Callers are
 *   expected to catch and fall back to the RGBA8 path — a bad payload must
 *   never take the renderer down.
 */
export function parseHbc7(input) {
  const u8 =
    input instanceof Uint8Array
      ? input
      : input && input.buffer instanceof ArrayBuffer && typeof input.byteOffset === "number"
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
  if (u8.byteLength < HBC7_HEADER_BYTES) {
    throw new Error(`HBC7 too short (${u8.byteLength} < ${HBC7_HEADER_BYTES})`);
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== HBC7_MAGIC) {
    throw new Error(
      `HBC7 bad magic 0x${dv.getUint32(0, true).toString(16)} (expected "HBC7")`,
    );
  }
  const width = dv.getUint32(4, true);
  const height = dv.getUint32(8, true);
  const blocksX = dv.getUint32(12, true);
  const blocksY = dv.getUint32(16, true);
  if (width === 0 || height === 0) throw new Error(`HBC7 zero dimension ${width}x${height}`);
  const ebx = bc7BlocksFor(width);
  const eby = bc7BlocksFor(height);
  if (blocksX !== ebx || blocksY !== eby) {
    throw new Error(
      `HBC7 block dims ${blocksX}x${blocksY} != ceil(${width}/4)x ceil(${height}/4) = ${ebx}x${eby}`,
    );
  }
  const level0 = blocksX * blocksY * BC7_BLOCK_BYTES;
  const payload = u8.byteLength - HBC7_HEADER_BYTES;
  if (payload < level0) {
    throw new Error(
      `HBC7 truncated: ${payload} payload bytes < level-0 ${level0} (${blocksX}x${blocksY} blocks)`,
    );
  }
  // v1: exactly one level. FORWARD COMPAT (see the header note): trailing
  // bytes are read as a halving mip chain so a v2 container that appends
  // levels needs no client change.
  const levels = [];
  let off = HBC7_HEADER_BYTES;
  let lw = width;
  let lh = height;
  let remaining = payload;
  for (;;) {
    const need = bc7LevelBytes(lw, lh);
    if (remaining < need) break;
    levels.push({ data: u8.subarray(off, off + need), width: lw, height: lh });
    off += need;
    remaining -= need;
    if (lw === 1 && lh === 1) break;
    lw = Math.max(1, lw >> 1);
    lh = Math.max(1, lh >> 1);
    if (remaining === 0) break;
  }
  if (levels.length === 0) throw new Error("HBC7 produced no mip levels");
  if (remaining !== 0) {
    throw new Error(
      `HBC7 trailing garbage: ${remaining} bytes left after ${levels.length} level(s) ` +
        `(v1 expects byteLength == ${HBC7_HEADER_BYTES} + ${blocksX}*${blocksY}*${BC7_BLOCK_BYTES} = ${HBC7_HEADER_BYTES + level0})`,
    );
  }
  return { width, height, blocksX, blocksY, levels };
}

// --------------------------------------------------------------------------
// three.js texture construction
// --------------------------------------------------------------------------

/**
 * Wrap a parsed HBC7 as a `THREE.CompressedTexture` — the per-surface
 * (singleton material) upload.
 *
 * Flags chosen to match `adapter.js surfacePixelsToTexture` wherever a
 * compressed texture can:
 *   colorSpace SRGBColorSpace → three's `convert()` picks
 *     COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT, i.e. the SAME hardware sRGB
 *     decode the RGBA8 path gets from SRGB8_ALPHA8. No shader-side EOTF
 *     anywhere, so the statics-atlas fragment injection is untouched.
 *   flipY — forced false by CompressedTexture, and the RGBA8 path also uses
 *     false (wasm pixels are top-down, as are PNG rows). Consistent.
 *   minFilter — LinearFilter when the payload is level-0-only (MANDATORY,
 *     see the header), LinearMipmapLinearFilter when it carries a chain.
 *   wrapS/wrapT — caller's choice; defaults to Repeat like the RGBA8 twin.
 */
export function makeBc7Texture(parsed, opts = {}) {
  const tex = new THREE.CompressedTexture(
    parsed.levels,
    parsed.width,
    parsed.height,
    THREE.RGBA_BPTC_Format,
    THREE.UnsignedByteType,
  );
  tex.colorSpace = opts.colorSpace ?? THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = parsed.levels.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.generateMipmaps = false; // impossible for compressed; three forces this anyway
  tex.wrapS = opts.wrapS ?? THREE.RepeatWrapping;
  tex.wrapT = opts.wrapT ?? THREE.RepeatWrapping;
  // Anisotropy is legal on a compressed texture, but it only does anything
  // with a mip chain — leave it at the caller's value (0/1 for level-0-only).
  if (typeof opts.anisotropy === "number" && parsed.levels.length > 1) {
    tex.anisotropy = opts.anisotropy;
  }
  tex.needsUpdate = true;
  return tex;
}

/**
 * Allocate an EMPTY `THREE.CompressedArrayTexture` of `depth` BC7 layers at
 * fixed `w`x`h` — the statics-atlas bucket array.
 *
 * WHY THIS SHAPE IS FORCED (and why the atlas already fits it):
 * a compressed array cannot be resized, and every layer must share format
 * AND dimensions. `compressedTexImage3D` wants the whole array's bytes;
 * per-layer writes must go through `compressedTexSubImage3D` at
 * block-aligned offsets. three.js exposes exactly that as
 * `CompressedArrayTexture.addLayerUpdate(i)` — with `layerUpdates` non-empty
 * it emits one `compressedTexSubImage3D` per marked layer instead of
 * re-uploading the array (three r184 WebGLTextures, `isCompressedArrayTexture`
 * branch). The statics atlas already allocates each bucket at a FIXED (w, h)
 * with a FIXED layer capacity and writes layers on demand, so it maps onto
 * this 1:1 — and per-layer subimage is strictly CHEAPER than the RGBA8
 * path's full `needsUpdate` re-upload of the whole array.
 */
export function makeBc7ArrayTexture(w, h, depth, opts = {}) {
  const d = Math.max(1, depth | 0);
  // ST5 (`?texCompressedOnly`, pass 5 D-05.6.1): `opts.mipChain` allocates
  // the COMPLETE halving chain per layer (mips + aniso legal — closes the
  // singleton-vs-atlas asymmetry). Without it: level 0 only, byte-identical
  // to the pre-ST5 allocator (the OFF arm / kill path).
  const mipmaps = [];
  let lw = w, lh = h;
  for (;;) {
    mipmaps.push({ data: new Uint8Array(bc7LevelBytes(lw, lh) * d), width: lw, height: lh });
    if (!opts.mipChain || (lw === 1 && lh === 1)) break;
    lw = Math.max(1, lw >> 1);
    lh = Math.max(1, lh >> 1);
  }
  const arr = new THREE.CompressedArrayTexture(
    mipmaps,
    w,
    h,
    d,
    THREE.RGBA_BPTC_Format,
    THREE.UnsignedByteType,
  );
  arr.colorSpace = opts.colorSpace ?? THREE.SRGBColorSpace;
  arr.magFilter = THREE.LinearFilter;
  // Chain-allocated ⇒ mipmapped filtering; level-0-only ⇒ LinearFilter is a
  // HARD correctness rule (`texStorage3D(levels = 1)` + mipmapped minFilter
  // = incomplete texture, samples BLACK).
  arr.minFilter = mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  if (typeof opts.anisotropy === "number" && mipmaps.length > 1) {
    arr.anisotropy = opts.anisotropy;
  }
  arr.generateMipmaps = false;
  // Same addressing contract as the RGBA8 DataArrayTexture the atlas uses:
  // ClampToEdge per layer, with the wrap-bucket shader's fract() supplying
  // the tiling (static_atlas.js `makeArrayMaterial`).
  arr.wrapS = THREE.ClampToEdgeWrapping;
  arr.wrapT = THREE.ClampToEdgeWrapping;
  arr.needsUpdate = true;
  return arr;
}

/**
 * Write one layer of a BC7 array from a parsed HBC7 whose dims MUST equal
 * the array's. Marks only that layer dirty (`addLayerUpdate`).
 *
 * Chain-allocated arrays (ST5) write EVERY level; the payload must carry a
 * chain at least as deep as the array's — a shallow payload into a chain
 * array is a LOUD diagnostic failure (pass 5 S5: level-0-only compressed
 * uploads are illegal on the compressed-only arm), never a silent
 * level-0-only write. Upload-cost note: three r184 clears `layerUpdates`
 * after mip 0, so this write uploads marked layers at level 0 + full depth
 * at levels 1+ (see the header).
 * @returns {boolean} true when written.
 */
export function writeBc7ArrayLayer(arr, layer, parsed) {
  try {
    const img = arr && arr.image;
    const mips = arr && arr.mipmaps;
    if (!img || !mips || !mips[0] || !mips[0].data) return false;
    if (parsed.width !== img.width || parsed.height !== img.height) return false;
    if (mips.length > 1 && (!parsed.levels || parsed.levels.length < mips.length)) {
      _stats.chainWriteRejects += 1;
      // eslint-disable-next-line no-console
      console.error(
        `[bc7] chain array wants ${mips.length} levels, payload carries ${parsed.levels ? parsed.levels.length : 0} — refusing a level-0-only write (bake/coverage defect)`,
      );
      return false;
    }
    // Validate every level before writing any (a layer index is recycled —
    // a half-written layer must not happen).
    for (let i = 0; i < mips.length; i += 1) {
      const levelBytes = bc7LevelBytes(mips[i].width, mips[i].height);
      const src = parsed.levels[i] && parsed.levels[i].data;
      if (!src || src.length !== levelBytes) return false;
      if ((layer + 1) * levelBytes > mips[i].data.length) return false;
    }
    for (let i = 0; i < mips.length; i += 1) {
      const levelBytes = bc7LevelBytes(mips[i].width, mips[i].height);
      mips[i].data.set(parsed.levels[i].data, layer * levelBytes);
    }
    if (typeof arr.addLayerUpdate === "function") arr.addLayerUpdate(layer);
    return true;
  } catch (_) {
    return false;
  }
}

/** GPU bytes a BC7 texture/array occupies — for the `?matBudgetMB` /
 *  atlas accounting, which reads `image.data` and so sees 0 for compressed. */
export function bc7TextureBytes(tex) {
  if (!tex || !tex.isCompressedTexture || !Array.isArray(tex.mipmaps)) return 0;
  let n = 0;
  for (const m of tex.mipmaps) if (m && m.data) n += m.data.byteLength;
  return n;
}

// --------------------------------------------------------------------------
// record source (namespace `holtburger/tex-bc7`, key = RenderSurface id)
// --------------------------------------------------------------------------

const _stats = {
  fetches: 0,
  hits: 0,
  absent: 0,
  errors: 0,
  parseErrors: 0,
  lastError: null,
  bytesFetched: 0,
  texturesBuilt: 0,
  atlasLayers: 0,
  atlasBuckets: 0,
  singletonUpgrades: 0,
  deferredNodes: 0,
  preFetches: 0,
  preHits: 0,
  preSwaps: 0,
  // ── ST5 (`?texCompressedOnly`) tier counters ────────────────────────────
  pvwBuilds: 0,          // materials born from a resident PVW preview
  texrefMissingPvw: 0,   // TEXREF'd rsId with no resident PVW — MUST stay 0
                         // (bake invariant D-05.5.4; >0 = LOUD deploy skew)
  fullSwaps: 0,          // lane-T full-tier upgrades swapped in
  fullFailed: 0,         // lane-T fetch/transcode failures (stayed preview)
  fullFetchMisses: 0,    // ... of which `_fetchFullTierParsed` NAMED a reason
  lastFullFetchError: null, // and the newest such reason (CTX-LOSS-MIRRORS:
                         // this path used to swallow a hard TypeError as a
                         // bare `return null`, which cost a live session)
  demotions: 0,          // pressure demote-to-preview events
  nraAttached: 0,        // worker-derived NRA planes attached
  chainWriteRejects: 0,  // shallow payload refused by a chain array (loud)
  // ── PAGE-RESAMPLE (T22 D2) — TEXREF page-dim reads ─────────────────────
  texRefOnPage: 0,       // rsIds read whose full tier IS stored at page dims
  texRefOffPage: 0,      // ... and whose full tier is NOT (needsResample true)
  // ── RSID-MARKER — the universal `__texRsId` stamp + the verdict seam ───
  rsIdStamped: 0,        // materials stamped with their RenderSurface id
  rsVerdictsResolved: 0, // BC7 verdicts settled (landed | absent | failed)
  rsRefeedsFired: 0,     // ... of which reached a registered producer handler
  // ── T15R (rehydrate v3, D-05.7 row 2) full-tier mirror seam ────────────
  mirrorsArmed: 0,           // full-tier textures with a source-keyed way back
  mirrorsFreed: 0,           // CPU mirrors dropped at record eviction
  mirrorBytesFreed: 0,       // bytes those releases actually gave back
  mirrorReleaseDeferred: 0,  // eviction hit a not-yet-uploaded texture (kept)
  mirrorRestores: 0,         // rehydrator re-supplied a released mirror
  mirrorRestoreFailed: 0,    // rehydrator MISS (loud; must stay 0)
};

// P1 preview-first (?texPre; DEFAULT ON, =off/0/false/no escape). Fetches the
// quarter-res `holtburger/tex-bc7-pre` record ahead of the full one and swaps
// twice. Pure acceleration: identical final pixels, and an archive without the
// pre namespace behaves exactly as before (empty fetch → negative cache).
let _preFlag;
export function texPreEnabled(search) {
  if (search === undefined && _preFlag !== undefined) return _preFlag;
  let on = true;
  try {
    const s = search !== undefined ? search : typeof window !== "undefined" ? window.location.search : "";
    on = !flagIsOff(new URLSearchParams(s).get("texPre"));
  } catch (_) {
    /* malformed location: stay ON (the path is fail-soft end to end) */
  }
  if (search === undefined) _preFlag = on;
  return on;
}

/** Mutable module tally — read via `window.__bc7Stats()`. */
export function bc7Stats() {
  return {
    ..._stats,
    enabled: bc7Enabled(),
    supported: _supported,
    support: _detectNote,
    cached: _source ? _source.cacheSize : 0,
    inflight: _source ? _source.inflightSize : 0,
    // 2026-08-05 — record-cache residency + the `?bc7RecordsMB` budget.
    // `budget: -1` = disarmed, the same convention `shardCacheBudget` uses.
    records: _source ? _source.recordCacheStats() : null,
  };
}

export function _bumpBc7Stat(name, by = 1) {
  if (name in _stats) _stats[name] += by;
}

/**
 * Name a lane-T full-tier fetch failure instead of returning a bare null
 * (CTX-LOSS-MIRRORS). Counted AND recorded: `fullFailed` already says "the
 * upgrade did not land", but it cannot say why, and on the 2026-08-11 T4 arm
 * the why was a swallowed `TypeError: ... detached ArrayBuffer` that read from
 * the outside as an ordinary rehydrator miss.
 */
export function noteFullTierFetchMiss(reason) {
  _stats.fullFetchMisses += 1;
  _stats.lastFullFetchError = reason == null ? null : String(reason);
}

/**
 * ST5 — the merged texture-tier surface (pass 5 S8): `__bc7Stats`/
 * `__xu7Stats`/`__texWorkerStats` fold into `__texStats()` (the
 * same-name-successor edge the diag registry encodes at T14).
 * `arrays` reads the atlas tally via the window install (a direct import
 * would mint a new module cycle — static_atlas already imports this file).
 */
export function texStats() {
  let arrays = null;
  try {
    if (typeof window !== "undefined" && typeof window.__atlasStats === "function") {
      arrays = window.__atlasStats();
    }
  } catch (_) { arrays = null; }
  let rehydrate = null;
  try { rehydrate = textureRehydrateStats(); } catch (_) { rehydrate = null; }
  return {
    enabled: texCompressedOnlyEnabled(),
    active: texCompressedOnlyActive(),
    tiers: {
      pvwHits: _stats.pvwBuilds,
      fullSwaps: _stats.fullSwaps,
      fullFailed: _stats.fullFailed,
      fullFetchMisses: _stats.fullFetchMisses,
      lastFullFetchError: _stats.lastFullFetchError,
      demotions: _stats.demotions,
      nraAttached: _stats.nraAttached,
      chainWriteRejects: _stats.chainWriteRejects,
      // RSID-MARKER: the stamp population and the re-offer seam's firings.
      // `rsIdStamped` is the universe a producer can re-offer from; a
      // `bc7Pending` refusal population LARGER than this is a marker gap.
      rsIdStamped: _stats.rsIdStamped,
      rsVerdictsResolved: _stats.rsVerdictsResolved,
      rsRefeedsFired: _stats.rsRefeedsFired,
    },
    coverage: {
      texrefMissingPvw: _stats.texrefMissingPvw,
      texRefOnPage: _stats.texRefOnPage,
      texRefOffPage: _stats.texRefOffPage,
    },
    worker: (() => {
      try {
        const w = texWorkerStats();
        // Registry shape (pass 10 S3): fallbackArm = work is currently
        // routing to the main-thread FIFO despite the flag.
        return { ...w, fallbackArm: !!w.enabled && w.state !== "ready" };
      } catch (_) { return null; }
    })(),
    xu7: (() => { try { return xu7Stats(); } catch (_) { return null; } })(),
    records: _source ? _source.recordCacheStats() : null,
    mirrors: (() => {
      const m = bc7RecordCacheBytes();
      // byClass @cpuMirror (D-05.7 classes; the atlas staging + terrain
      // rows live on their own surfaces — see the registry note).
      // `release` = the T15R full-tier seam (rehydrate v3 row 2):
      // armed/released mirrors + what eviction actually gave back.
      return {
        byClass: { fullTierRecords: m.bytes },
        ...m,
        release: {
          ...fullTierMirrorStats(),
          everArmed: _stats.mirrorsArmed,
          freed: _stats.mirrorsFreed,
          bytesFreed: _stats.mirrorBytesFreed,
          releaseDeferred: _stats.mirrorReleaseDeferred,
          restores: _stats.mirrorRestores,
          restoreFailed: _stats.mirrorRestoreFailed,
        },
      };
    })(),
    arrays,
    rehydrate,
  };
}

/**
 * Per-RenderSurface BC7 record source. Mirrors `suite_assets.js`
 * `SuiteAssetSource`: a SYNC accessor that returns the parsed payload or
 * null-while-loading and kicks the async fetch on the first ask, so callers
 * on a synchronous build path (the statics atlas feed) need no await.
 *
 * `fetchImpl(rsId) -> Promise<Uint8Array|null>` is injectable, which is what
 * makes this testable with no wasm and no GPU (and lets the delivery half
 * swap in a plain-HTTP route if it prefers one to the HBA namespace).
 */
/**
 * `?bc7RecordsMB=N` — byte budget for the parsed-payload caches below.
 *
 * DEFAULT ARMED at 256 MB legacy / **128 MB under `?texCompressedOnly`**
 * (pass 5 D-05.7: the old 256 MB rationale — "eviction costs a ~32 ms
 * main-thread transcode" and "evicting frees nothing while the texture
 * lives" — is obsolete on the compressed-only arm: re-transcode is
 * worker-side, and eviction there demotes the material to its
 * pack-resident preview, actually freeing the full-tier bytes). Absent /
 * unparseable ⇒ the default; only an explicit `off` (or `0`) disarms,
 * because a typo must not silently uncap memory — the same grammar
 * `?matBudgetMB` uses and for the same reason.
 *
 * Legacy-arm sizing (unchanged): the 2026-08-05 six-town census measured
 * 553 + 476 records holding ~297 MB gross; on that arm most bytes are
 * SHARED with the live `CompressedTexture` (`makeBc7Texture` passes
 * `parsed.levels` through with no copy), so a tight budget buys little.
 */
export function bc7RecordBudgetBytes(search) {
  let raw = null;
  try {
    const sq = search !== undefined
      ? search
      : (typeof window !== "undefined" && window.location ? window.location.search : "");
    raw = new URLSearchParams(sq).get("bc7RecordsMB");
  } catch (_) { raw = null; }
  if (raw != null && flagIsOff(raw)) return Infinity;
  const n = raw == null ? NaN : Number(raw);
  if (Number.isFinite(n) && n >= 1) return n * 1024 * 1024;
  return (texCompressedOnlyEnabled(search) ? 128 : 256) * 1024 * 1024;
}

/** Resident bytes of one parsed record, deduped by underlying ArrayBuffer —
 *  `parseHbc7` hands out mip levels as subarrays of ONE payload. */
function _parsedBytes(parsed) {
  if (!parsed) return 0; // a negative entry costs a map slot, not bytes
  let n = 0;
  const seen = new Set();
  for (const l of parsed.levels || []) {
    const buf = l?.data?.buffer;
    if (!buf || seen.has(buf)) continue;
    seen.add(buf);
    n += buf.byteLength;
  }
  return n;
}

export class Bc7RecordSource {
  constructor(opts = {}) {
    this._wasm = opts.wasmExports || null;
    this._fetchImpl = opts.fetchImpl || null;
    this._preFetchImpl = opts.preFetchImpl || null;
    this._cache = new Map(); // rsId -> parsed | null (null = absent/failed)
    this._inflight = new Set();
    this._preCache = new Map(); // rsId -> parsed | null (pre-record twin)
    this._preInflight = new Set();
    // 2026-08-05 — rsId -> the in-flight promise, so a second ask for a record
    // already being fetched JOINS it instead of starting a rival fetch. Retail
    // shares RenderSurfaces across Surfaces (three of the 33 terrain layers
    // alone, and far more among statics) while `MaterialCache._bc7Asked`
    // dedupes by surface DID, so concurrent asks for one rsId are routine.
    // `get()` was already guarded by `_inflight`; `getAsync()` was not, and
    // under P2 each duplicate cost a full xu7 payload fetch AND a ~32 ms/1024²
    // main-thread transcode on top of the wasted bytes.
    this._inflightP = new Map();
    this._preInflightP = new Map();
    // A15-shaped byte budget over BOTH record maps (2026-08-05). They were
    // unbounded and keyed by RenderSurface id, i.e. they grew with route
    // length; the texture census measured 60 MB of hold that no live texture
    // accounts for after six towns.
    this._budgetBytes = opts.budgetBytes != null ? opts.budgetBytes : bc7RecordBudgetBytes();
    this._recordBytes = 0;
    this._evictions = 0;
    this._evictedBytes = 0;
  }

  /** Insert into one of the two record maps, charging bytes and trimming to
   *  budget. Negative entries (`null` = proven absent) are stored but charged
   *  nothing and are NEVER evicted: they are what stops a re-fetch storm
   *  against records the archive does not ship, and they cost a map slot. */
  _put(map, id, parsed) {
    const prev = map.get(id);
    if (prev !== undefined) this._recordBytes -= _parsedBytes(prev);
    map.set(id, parsed);
    this._recordBytes += _parsedBytes(parsed);
    this._trimToBudget();
  }

  /** Bump recency: Map preserves insertion order, so re-inserting moves the
   *  key to the young end. Only for POSITIVE entries — re-inserting a null
   *  would churn the map for no benefit. */
  _touch(map, id) {
    const v = map.get(id);
    if (v) { map.delete(id); map.set(id, v); }
  }

  _trimToBudget() {
    if (!(this._recordBytes > this._budgetBytes)) return;
    // Oldest-first across both maps; the pre-record twin is dropped before the
    // full record of the same age because it is the cheaper one to lose (it is
    // a quarter-res preview whose only job is time-to-textured).
    for (const map of [this._preCache, this._cache]) {
      const isFull = map === this._cache;
      for (const [id, parsed] of map) {
        if (this._recordBytes <= this._budgetBytes) return;
        if (!parsed) continue; // never evict a proven-absent verdict
        const b = _parsedBytes(parsed);
        map.delete(id);
        this._recordBytes -= b;
        this._evictions += 1;
        this._evictedBytes += b;
        // T15R (D-05.7 row 2) — the eviction only FREES anything if the live
        // texture lets go of the same buffer. Release the mirror (way back
        // registered first). No-op on the legacy arm: nothing arms a mirror
        // there, so the map is empty and this costs one `size` read.
        if (isFull && _fullMirrors.size > 0) releaseFullTierMirror(id);
      }
    }
  }

  /** Diag: `{ bytes, budget, evictions, evictedBytes, records, preRecords }`.
   *  `budget` is `-1` when disarmed, matching `shardCacheBudget`'s convention. */
  recordCacheStats() {
    return {
      bytes: this._recordBytes,
      budget: Number.isFinite(this._budgetBytes) ? this._budgetBytes : -1,
      evictions: this._evictions,
      evictedBytes: this._evictedBytes,
      records: this._cache.size,
      preRecords: this._preCache.size,
    };
  }

  get cacheSize() {
    return this._cache.size;
  }

  get inflightSize() {
    return this._inflight.size;
  }

  /** Whether a fetch for this id is still outstanding (the atlas defers
   *  nodes in this state rather than committing them to an RGBA8 bucket). */
  pending(rsId) {
    return this._inflight.has(rsId >>> 0);
  }

  /** True once we have a verdict (payload or proven-absent) for this id. */
  known(rsId) {
    return this._cache.has(rsId >>> 0);
  }

  /**
   * ST5 (`?texCompressedOnly`) — adopt an externally produced parsed
   * record (the lane-T → worker transcode path) into the budgeted cache,
   * so the 128 MB record budget governs full-tier mirrors on that arm
   * (pass 5 D-05.7: "full-tier mirror ≡ the record-cache entry").
   */
  adoptParsed(rsId, parsed) {
    if (!parsed) return;
    this._put(this._cache, rsId >>> 0, parsed);
    _stats.hits += 1;
  }

  /** ST5 — drop one record's cache entry (the demote primitive frees the
   *  full-tier mirror; the preview stays pack-resident). */
  dropRecord(rsId) {
    const id = rsId >>> 0;
    const parsed = this._cache.get(id);
    if (parsed === undefined) return false;
    this._recordBytes -= _parsedBytes(parsed);
    this._cache.delete(id);
    return true;
  }

  /** Sync accessor: parsed payload, or null while loading / absent. */
  get(rsId) {
    const id = rsId >>> 0;
    if (this._cache.has(id)) { this._touch(this._cache, id); return this._cache.get(id); }
    if (!this._inflight.has(id)) this._begin(id);
    return null;
  }

  /** Async accessor: resolves to the parsed payload or null. */
  getAsync(rsId) {
    const id = rsId >>> 0;
    if (this._cache.has(id)) { this._touch(this._cache, id); return Promise.resolve(this._cache.get(id)); }
    return this._begin(id);
  }

  /**
   * P1 — async accessor for the PRE record (quarter-res twin). Resolves to
   * the parsed payload or null (absent / namespace not shipped / flag off /
   * wasm without the export). Never throws; never warns on absence — the pre
   * layer is optional by contract.
   */
  getPreAsync(rsId) {
    const id = rsId >>> 0;
    if (this._preCache.has(id)) { this._touch(this._preCache, id); return Promise.resolve(this._preCache.get(id)); }
    const impl = this._preFetchImpl
      ? this._preFetchImpl
      : this._wasm && typeof this._wasm.bc7_pre_blocks === "function"
        ? (i) => this._wasm.bc7_pre_blocks(i)
        : null;
    if (!impl) {
      this._put(this._preCache, id, null);
      return Promise.resolve(null);
    }
    // 2026-08-05 — this used to be an empty `if (this._preInflight.has(id)) {}`
    // whose comment said "just re-fetch; the store layer dedupes the network
    // hop". The store dedupes the HOP, not the parse or the caller's work, and
    // the block did nothing either way. Join the in-flight promise instead.
    const joined = this._preInflightP.get(id);
    if (joined) return joined;
    this._preInflight.add(id);
    _stats.preFetches += 1;
    const pre = Promise.resolve(impl(id))
      .then((bytes) => {
        if (!bytes || bytes.length === 0) {
          this._put(this._preCache, id, null);
          return null;
        }
        let parsed;
        try {
          parsed = parseHbc7(bytes);
        } catch (e) {
          // A malformed PRE payload is a bake bug like any other — loud.
          _stats.parseErrors += 1;
          _stats.lastError = String(e && e.message ? e.message : e);
          // eslint-disable-next-line no-console
          console.error(`[bc7] 0x${id.toString(16).toUpperCase()} malformed PRE payload:`, e);
          this._put(this._preCache, id, null);
          return null;
        }
        _stats.bytesFetched += bytes.length;
        _stats.preHits += 1;
        this._put(this._preCache, id, parsed);
        return parsed;
      })
      .catch(() => {
        this._put(this._preCache, id, null);
        return null;
      })
      .finally(() => {
        this._preInflight.delete(id);
        this._preInflightP.delete(id);
      });
    this._preInflightP.set(id, pre);
    return pre;
  }

  _begin(id) {
    // Join an ask already in flight (see `_inflightP` in the ctor).
    const joined = this._inflightP.get(id);
    if (joined) return joined;
    this._inflight.add(id);
    _stats.fetches += 1;
    // P2 (2026-08-04): with `?texXu7=on`, try the XUBC7 namespace FIRST —
    // transcoded output is shape-identical to parseHbc7's, so the rest of
    // this chain and every consumer is codec-blind. Any miss/failure falls
    // through to the hbc7 fetch below, which is only kicked on that path
    // (no double bandwidth).
    const tryXu7 = () => {
      if (!texXu7Enabled() || this._fetchImpl || !this._wasm || typeof this._wasm.xu7_blocks !== "function") {
        return Promise.resolve(null);
      }
      // 2026-08-05 — ASK whether the transcoder is up; never AWAIT it. The
      // module is 1.04 MB of lazily-loaded wasm, and awaiting it here put every
      // full-record fetch behind that load: measured ~15 s on localhost with
      // zero surfaces upgrading and every material stuck `__bc7Pending` (so the
      // atlas deferred them too), and a load that never settled would have been
      // permanent AND silent — the catch below only sees a REJECTION, not a
      // pending promise. See `ensureXu7Transcoder`. Until it lands, records take
      // the hbc7 route: the same bytes the tier-off boot would have spent, and
      // no xu7 payload fetched only to be dropped into a stalled await.
      if (!ensureXu7Transcoder()) return Promise.resolve(null);
      return Promise.resolve(this._wasm.xu7_blocks(id))
        .then((b) => {
          if (!b || b.length === 0) return null;
          _stats.bytesFetched += b.length;
          return transcodeXu7(b);
        })
        .catch(() => null);
    };
    const bytesP = () =>
      this._fetchImpl
        ? Promise.resolve(this._fetchImpl(id))
        : this._wasm && typeof this._wasm.bc7_blocks === "function"
          ? Promise.resolve(this._wasm.bc7_blocks(id))
          : Promise.resolve(null);
    const p = tryXu7()
      .then((xu7Parsed) => {
        if (xu7Parsed) {
          this._put(this._cache, id, xu7Parsed);
          _stats.hits += 1;
          return { __shortCircuit: xu7Parsed };
        }
        return bytesP();
      })
      .then((bytesOrDone) => {
        if (bytesOrDone && bytesOrDone.__shortCircuit) return bytesOrDone.__shortCircuit;
        const bytes = bytesOrDone;
        if (!bytes || bytes.length === 0) {
          this._put(this._cache, id, null); // proven-absent OR namespace not shipped
          _stats.absent += 1;
          return null;
        }
        _stats.bytesFetched += bytes.length;
        let parsed;
        try {
          parsed = parseHbc7(bytes);
        } catch (e) {
          _stats.parseErrors += 1;
          _stats.lastError = String(e && e.message ? e.message : e);
          // Loud: a malformed payload is a BAKE bug, not an environment
          // quirk, and silently rendering the retail texture would hide it.
          // eslint-disable-next-line no-console
          console.error(`[bc7] 0x${id.toString(16).toUpperCase()} malformed payload:`, e);
          this._put(this._cache, id, null);
          return null;
        }
        this._put(this._cache, id, parsed);
        _stats.hits += 1;
        return parsed;
      })
      .catch((e) => {
        _stats.errors += 1;
        _stats.lastError = String(e && e.message ? e.message : e);
        this._put(this._cache, id, null); // never re-hammer a broken endpoint
        // eslint-disable-next-line no-console
        console.warn(`[bc7] fetch failed 0x${id.toString(16).toUpperCase()}:`, e);
        return null;
      })
      .finally(() => {
        this._inflight.delete(id);
        this._inflightP.delete(id);
      });
    // Set BEFORE anyone can await: `p` cannot have settled yet (promise
    // callbacks are microtasks), so the `.finally` above never races this.
    this._inflightP.set(id, p);
    return p;
  }
}

let _source = null;

/**
 * Install the process-wide record source. Called once from index.html right
 * after `init_resource_source` (the wasm `bc7_blocks` export reads through the
 * same manifest source every other record goes through).
 *
 * ORDERING NOTE — deliberately NOT gated on `bc7Available()`: the renderer (and
 * therefore the BPTC probe in `initBc7`) is built inside the POST-CONNECT
 * `init3D` arm, which runs LATER than `init_resource_source`. Gating here would
 * make the install a guaranteed no-op. Construction is a bare object + two empty
 * Maps; the capability gate lives in `bc7Source()`, which every consumer calls,
 * so nothing fetches until both the flag and the probe agree.
 */
export function initBc7Source(opts = {}) {
  if (_source) return _source;
  _source = new Bc7RecordSource(opts);
  if (typeof window !== "undefined") {
    window.__bc7Stats = () => bc7Stats();
    window.__xu7Stats = () => xu7Stats();
    // ST5: the merged successor surface (registry: __texWorkerStats
    // retiresAt ST5 → __texStats; the legacy surfaces stay installed
    // through the migration window).
    window.__texStats = () => texStats();
  }
  return _source;
}

/** The installed source, or null when the path is off/unsupported. */
export function bc7Source() {
  return bc7Available() ? _source : null;
}

/**
 * Resident bytes held by the record source's parsed-payload caches — the
 * `bc7Records` row of `__diag.textures()` (2026-08-05).
 *
 * These are `_cache` / `_preCache`, both UNBOUNDED, keyed by RenderSurface id.
 * They matter to the OOM investigation for a reason that is easy to miss: they
 * hold the parsed payload INDEPENDENTLY of any texture built from it, so a
 * census that watches textures die will report those bytes as freed while this
 * map is still holding every one of them. Route-length retention, one layer
 * below the textures.
 *
 * Deduped by underlying `ArrayBuffer`: `parseHbc7` hands out `subarray` views
 * over ONE `Uint8Array` per record, so summing `levels[].data.byteLength` naively
 * counts the same payload once per mip level.
 *
 * Returns `{ records, preRecords, bytes, absent }`; `absent` counts negative
 * entries (a `null` value = "no such record"), which cost a map slot and no bytes.
 */
export function bc7RecordCacheBytes(sharedSeen) {
  const out = { records: 0, preRecords: 0, bytes: 0, absent: 0, shared: !!sharedSeen };
  // When the caller passes the texture census's dedupe set, every buffer a LIVE
  // texture already charged is skipped, so `bytes` becomes the cache's
  // INDEPENDENT retention: payload nothing else is holding. That is the number
  // that matters — `makeBc7Texture` passes `parsed.levels` through with no copy,
  // so a texture and its record share one buffer and naively summing both
  // double-counts the same megabytes.
  const seen = sharedSeen || new Set();
  const sum = (map, key) => {
    if (!map) return;
    for (const parsed of map.values()) {
      if (!parsed) { out.absent += 1; continue; }
      out[key] += 1;
      const levels = parsed.levels || [];
      for (const l of levels) {
        const buf = l?.data?.buffer;
        if (!buf || seen.has(buf)) continue;
        seen.add(buf);
        out.bytes += buf.byteLength;
      }
    }
  };
  try {
    sum(_source?._cache, "records");
    sum(_source?._preCache, "preRecords");
  } catch (_) { /* diagnostic only */ }
  return out;
}

/** Test hook: drop the installed source + stats. */
export function _resetBc7ForTest() {
  _source = null;
  for (const k of Object.keys(_stats)) {
    if (typeof _stats[k] === "number") _stats[k] = 0;
  }
  _stats.lastError = null;
  _stats.lastFullFetchError = null;
  _flag = undefined;
  // 2026-08-05 — `_preFlag` was missing here, so a no-arg `texPreEnabled()`
  // memoised once and then silently decided every later case in the same
  // process regardless of what the test set up.
  _preFlag = undefined;
  _supported = null;
  _detectNote = "not probed";
}

// --------------------------------------------------------------------------
// consumer helper — swap a live material's albedo to BC7
// --------------------------------------------------------------------------

/**
 * Ask for the BC7 replacement of `rsId` and, when it lands, swap it in as
 * `mat.map`, disposing the RGBA8 texture the material was built with.
 *
 * WHY A SWAP AND NOT A BUILD-TIME CHOICE: materials are built on a
 * synchronous path from an already-decoded `SurfacePixels`; the BC7 record
 * is a separate async fetch. Building RGBA8 first and upgrading keeps the
 * first frame correct (retail texels) and makes the whole path fail-soft.
 * The cost is a visible race with the statics atlas — see
 * `static_atlas.js`'s `__bc7Pending` deferral, which holds a node out of an
 * RGBA8 bucket for one LB stream rather than locking it to 32 bpp.
 *
 * P1 (2026-08-04): when `?texPre` is on (default) and the archive ships the
 * `tex-bc7-pre` namespace, the quarter-res pre-record is fetched CONCURRENTLY
 * and, if it lands while the full record is still in flight, swapped in first
 * — the surface goes textured at ~6% of the bytes, then sharpens in place
 * when the full record arrives. Each swap is reported through `onSwap` so the
 * caller can re-point clone families both times; the returned promise still
 * resolves once, after the FULL verdict, preserving v1 semantics.
 *
 * @param {THREE.Material} mat
 * @param {number} rsId RenderSurface (0x06xxxxxx) id
 * @param {(res:{swapped:true,replaced:THREE.Texture|null})=>void} [onSwap]
 *   invoked after EACH swap (pre and/or full) with the texture it replaced.
 * @returns {Promise<boolean|{swapped:true,replaced:*}>} final-phase result
 */
export function upgradeMaterialToBc7(mat, rsId, onSwap) {
  const src = bc7Source();
  if (!src || !mat || !(rsId >>> 0)) return Promise.resolve(false);
  // Mark BEFORE the await so the atlas can see "verdict pending" on the very
  // first feed and defer instead of baking this surface in at 32 bpp.
  const already = src.known(rsId);
  // 2026-08-03 — mutate userData in place, never `{...spread}`: this runs on a
  // possibly-compiled material, and a spread drops the non-enumerable live
  // handles materials.js `_defineLiveUserData` installs.
  // RSID-MARKER: stamp the identity in the SAME breath as the pending state,
  // so no material can ever be in `__bc7Pending` without carrying the key a
  // producer needs to re-offer it (the 363-hold-out class).
  stampRsId(mat, rsId);
  if (!already) {
    mat.userData = mat.userData || {};
    mat.userData.__bc7Pending = true;
  }
  let fullDone = false;
  let preTex = null;
  const buildAndSwap = (parsed, phase) => {
    const old = mat.map;
    const tex = makeBc7Texture(parsed, {
      wrapS: old ? old.wrapS : undefined,
      wrapT: old ? old.wrapT : undefined,
      colorSpace: old && old.colorSpace ? old.colorSpace : undefined,
    });
    mat.map = tex;
    mat.needsUpdate = true;
    _stats.texturesBuilt += 1;
    if (phase === "pre") _stats.preSwaps += 1;
    else _stats.singletonUpgrades += 1;
    return { swapped: true, replaced: old };
  };
  // Pre phase: only worth kicking when the full verdict isn't already cached.
  if (texPreEnabled() && !already) {
    src
      .getPreAsync(rsId)
      .then((parsed) => {
        // Lost the race (or full already landed): the pre texture is never
        // built, so there is nothing to dispose. parsed stays in _preCache
        // for any later asker.
        if (!parsed || fullDone) return;
        if (mat.userData && mat.userData.__bc7) return; // full already swapped
        const res = buildAndSwap(parsed, "pre");
        preTex = mat.map;
        const ud = (mat.userData = mat.userData || {});
        ud.__bc7Pre = true;
        if (onSwap) {
          try {
            onSwap(res);
          } catch (_) {
            /* caller's re-point failed: material itself is still correct */
          }
        }
      })
      .catch(() => {
        /* pre is best-effort by contract */
      });
  }
  return src
    .getAsync(rsId)
    .then((parsed) => {
      fullDone = true;
      const ud = (mat.userData = mat.userData || {});
      delete ud.__bc7Pending;
      if (!parsed) {
        // An ABSENT record is a settled verdict: this material keeps the map
        // it has (RGBA8, or the pre texture) for good, so anything held out
        // on it is now admissible and must be re-offered.
        _rsVerdictResolved(rsId);
        return false;
      }
      const res = buildAndSwap(parsed, "full");
      ud.__bc7 = true;
      delete ud.__bc7Pre;
      ud.__bc7RsId = rsId >>> 0;
      if (onSwap) {
        // The caller's re-point handler owns disposal of `replaced` (RGBA8
        // twin in phase pre, the pre texture here) exactly as in v1.
        try {
          onSwap(res);
        } catch (_) {
          /* caller's re-point failed: material itself is still correct */
        }
      } else if (res.replaced && res.replaced === preTex) {
        // No caller handler: the pre texture was built here and is tracked
        // nowhere else — dispose it or it leaks GPU memory on every upgrade.
        try {
          res.replaced.dispose();
        } catch (_) {
          /* fail-soft */
        }
      }
      // pass-05 S8 point 3: "upgradeMaterialToBc7's full-phase swap calls a
      // new atlasRefeed(rsId) hook". T15 landed that call on the ST5 lane-T
      // upgrade only (materials.js `_upgradeCompressedFull`); this is the
      // same hook on the X6 upgrade — the path that owns `__bc7Pending`, and
      // therefore the path every bc7Pending hold-out is waiting on. LAST,
      // after `onSwap` has re-pointed the clone families, so a producer that
      // re-reads `mat.map` sees the final texture.
      _rsVerdictResolved(rsId);
      return res;
    })
    .catch(() => {
      const ud = (mat.userData = mat.userData || {});
      delete ud.__bc7Pending;
      _rsVerdictResolved(rsId);
      return false;
    });
}

/** Whether a material is waiting on a BC7 verdict (atlas deferral gate). */
export function bc7PendingOn(mat) {
  return !!(mat && mat.userData && mat.userData.__bc7Pending);
}
