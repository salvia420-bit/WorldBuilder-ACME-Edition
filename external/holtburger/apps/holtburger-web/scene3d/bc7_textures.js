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
import { texXu7Enabled, transcodeXu7, xu7Stats, ensureXu7Transcoder, texWorkerStats, xu7TranscoderUp } from "./xu7_textures.js";
import { holdForInterior } from "./bandwidth_tier.js";
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
/** `?texBc7=off` — DEFAULT-ON opt-OUT. Only `off`/`0`/`false`/`no` disable it;
 *  absent, empty, and every other value (including `on`) read ON. Pass
 *  `search` explicitly in worker context; defaults to the page's own query
 *  string.
 *
 *  This docstring used to say "EXACT-MATCH opt-in ... absent reads OFF",
 *  describing the pre-2026-07-30 behaviour — it was left stale by the
 *  default-on flip below and contradicted the code 10 lines under it.
 *  HANDOFF-relief-v2-2026-07-31 §1 then built its "everything low-res"
 *  diagnosis on the stale text, blaming a missing `?texBc7=on` for unfetched
 *  BC7 payloads, and two later investigations inherited the error. Measured
 *  2026-08-12 on a T4 in the real page: absent=ON, `on`=ON, `1`=ON,
 *  `banana`=ON, `off`=OFF. The 07-30 shots were starved by the stale
 *  `bc7-webroot/.../dist` symlink 404ing every shard, which is a SERVING
 *  fault; the URL never had anything to do with it. */
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
// BC7 alpha floor — the payload half of the CLIP-ALPHA guard (2026-10-07)
// --------------------------------------------------------------------------
//
// The lowest alpha any texel of a BC7 block CAN decode to, read from the
// block's alpha ENDPOINTS without decoding a single index.
//
// WHY ENDPOINTS AND NOT A MODE SCAN: modes 0-3 carry no alpha field (alpha is
// 255), so an all-0..3 payload is provably opaque — but the converse is not
// available. Encoders put OPAQUE content in the alpha-capable modes too: the
// served tex-xu7 reed record (rs 0x0600385A, transcoded) is 9,341 mode-5 /
// 6,060 mode-6 / 132 mode-4 / 5 mode-7 / 846 mode-0..3 blocks at level 0 and
// decodes to alpha 240..255 everywhere (Pillow's BC7 decoder agrees). A mode
// histogram calls that "undetermined" (exactly what
// `apps/holtburger-tools/src/alpha_audit.rs::probe_hbc7` would say). The
// endpoints settle it: BC7 interpolates
// `((64 - w) * e0 + w * e1 + 32) >> 6`, so every texel's alpha lies in
// [min(e0, e1), max(e0, e1)] of its subset, and the block's floor is the min
// over its alpha endpoints. That is a LOWER BOUND — a block whose low endpoint
// no index selects reads lower than its true minimum — which only ever makes
// the guard below decline to veto, never veto wrongly.
//
// Layouts (BC7 spec / KHR_DF, bits LSB-first from byte 0):
//   mode 4: rot@5(2) idx@7 R0..B1@8(5 each) A0@38(6) A1@44(6)
//   mode 5: rot@6(2) R0..B1@8(7 each) A0@50(8) A1@58(8)
//   mode 6: R0..B1,A0,A1 @7(7 each) -> A0@49 A1@56, P0@63 P1@64 (unique p-bits)
//   mode 7: part@8(6) R/G/B 4 endpoints @14(5 each) A0..A3@74(5 each) P0..P3@94
// Modes 4/5 ROTATION swaps alpha with R/G/B after interpolation, so a rotated
// block's alpha comes from that colour channel's endpoints. A block with no
// mode bit set (byte 0 == 0) is reserved and decodes to all-zero texels.

function _bits(d, o, pos, n) {
  const byte = pos >>> 3;
  const lo = d[o + byte];
  const hi = byte + 1 < BC7_BLOCK_BYTES ? d[o + byte + 1] : 0;
  return ((lo | (hi << 8)) >>> (pos & 7)) & ((1 << n) - 1);
}

/** Alpha floor (0-255) of the 16-byte BC7 block at `data[off]`. */
export function bc7BlockAlphaFloor(data, off = 0) {
  const m0 = data[off];
  if (m0 === 0) return 0; // reserved mode: decodes to (0,0,0,0)
  if (m0 & 0x0f) return 255; // modes 0-3: no alpha field
  if (m0 & 0x10) {
    // mode 4
    const rot = _bits(data, off, 5, 2);
    if (rot === 0) {
      const a0 = _bits(data, off, 38, 6), a1 = _bits(data, off, 44, 6);
      const a = a0 < a1 ? a0 : a1;
      return (a << 2) | (a >> 4);
    }
    const c = rot - 1;
    const e0 = _bits(data, off, 8 + 10 * c, 5), e1 = _bits(data, off, 13 + 10 * c, 5);
    const e = e0 < e1 ? e0 : e1;
    return (e << 3) | (e >> 2);
  }
  if (m0 & 0x20) {
    // mode 5
    const rot = _bits(data, off, 6, 2);
    if (rot === 0) {
      const a0 = _bits(data, off, 50, 8), a1 = _bits(data, off, 58, 8);
      return a0 < a1 ? a0 : a1;
    }
    const c = rot - 1;
    const e0 = _bits(data, off, 8 + 14 * c, 7), e1 = _bits(data, off, 15 + 14 * c, 7);
    const e = e0 < e1 ? e0 : e1;
    return (e << 1) | (e >> 6);
  }
  if (m0 & 0x40) {
    // mode 6
    const a0 = (_bits(data, off, 49, 7) << 1) | _bits(data, off, 63, 1);
    const a1 = (_bits(data, off, 56, 7) << 1) | _bits(data, off, 64, 1);
    return a0 < a1 ? a0 : a1;
  }
  // mode 7
  let min = 63;
  for (let i = 0; i < 4; i += 1) {
    const a = (_bits(data, off, 74 + 5 * i, 5) << 1) | _bits(data, off, 94 + i, 1);
    if (a < min) min = a;
  }
  return (min << 2) | (min >> 4);
}

/**
 * Alpha floor of a parsed HBC7 (or transcoded xu7) payload's LEVEL 0 — the
 * level that carries the authored cutout; a thin mask can average away in
 * the smaller levels. Stops early once the floor drops below `stopBelow`
 * (the caller only needs "can anything here fall under the alpha-test ref").
 *
 * @param {{levels:Array<{data:Uint8Array}>}} parsed
 * @param {number} [stopBelow=0]
 * @returns {number} 0-255, or -1 when the payload has no readable level 0.
 */
export function bc7AlphaFloor(parsed, stopBelow = 0) {
  const lvl = parsed && Array.isArray(parsed.levels) ? parsed.levels[0] : null;
  const d = lvl && lvl.data;
  if (!d || typeof d.length !== "number" || d.length < BC7_BLOCK_BYTES) return -1;
  let floor = 255;
  for (let o = 0; o + BC7_BLOCK_BYTES <= d.length; o += BC7_BLOCK_BYTES) {
    const f = bc7BlockAlphaFloor(d, o);
    if (f < floor) {
      floor = f;
      if (floor < stopBelow || floor === 0) return floor;
    }
  }
  return floor;
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
  // ── ?texUpgradeQueue (2026-10-09) — queue-arm outcomes (0 on `=off`) ───
  upgradesDropped: 0,        // full asks the queue dropped (no live waiter, no holder)
  preDropped: 0,             // pre asks dropped or cancelled (full dispatched first)
  twinsDropped: 0,           // CLIP twins dropped before their fetch
};

// --------------------------------------------------------------------------
// ?texUpgradeQueue (2026-10-09) — the DROPPED verdict + the HD byte log
// --------------------------------------------------------------------------

/**
 * What `getAsync` / `getPreAsync` / `hbc7Fallback` resolve when the upgrade
 * queue (scene3d/tex_upgrade_queue.js, injected through `qctx`) dropped the
 * ask: nobody holds the surface any more. NOT a verdict — nothing is cached
 * (no `_put(null)`, no `_preCache` null, no `_hbc7Absent`), nothing is counted
 * absent, and `upgradeMaterialToBc7` only clears `__bc7Pending` (no gate
 * settle, no refeed). A material re-installed later asks again (eviction
 * clears the MaterialCache ask-once set). Never produced without a queue.
 */
export const TEX_DROPPED = Object.freeze({ texDropped: true });

// HD byte log — BOTH arms, diag only (`window.__texUpgradeQueue.report()`
// reads it): every full-tier network byte this module counts into
// `bytesFetched`, stamped with epoch ms, plus the per-rsId full-phase verdict
// time (`_verdictAt`) for the "starting room first" order metric.
const _HD_LOG_MAX = 8192;
const _hdLog = [];
const _verdictAt = new Map(); // rsId -> { at, outcome }
function _hdNote(kind, rs, bytes) {
  _hdLog.push({ kind, rs: rs >>> 0, bytes, at: Date.now() });
  if (_hdLog.length > _HD_LOG_MAX) _hdLog.splice(0, _hdLog.length - _HD_LOG_MAX);
}
function _verdictNote(rs, outcome) {
  const id = rs >>> 0;
  _verdictAt.delete(id); // re-insert: Map order = verdict order
  _verdictAt.set(id, { at: Date.now(), outcome });
  if (_verdictAt.size > _HD_LOG_MAX) _verdictAt.delete(_verdictAt.keys().next().value);
}

/** Diag: `{ bytes: [{kind:"pre"|"xu7"|"hbc7"|"twin", rs, bytes, at}],
 *  verdicts: [{rs, at, outcome:"swapped"|"absent"|"kept"|"failed"}] }`. */
export function bc7HdLog() {
  return {
    bytes: _hdLog.slice(),
    verdicts: Array.from(_verdictAt, ([rs, v]) => ({ rs, at: v.at, outcome: v.outcome })),
  };
}

// CLIP-ALPHA guard tallies (2026-10-07) — read via `window.__bc7ClipGuard.stats()`.
// Declared here, beside `_stats`, because `Bc7RecordSource.hbc7Fallback`
// counts into it; the guard itself lives at the end of the file.
const _clipStats = {
  asked: 0,             // surfaces offered to the guard (one per DID ask)
  notAlphaSampled: 0,   // material ignores map alpha (no alphaTest, opaque)
  unreadable: 0,        // albedo plane not readable (compressed / released)
  albedoScans: 0,       // RGBA8 alpha scans actually run (cache misses)
  albedoCacheHits: 0,   // ... answered from the per-RenderSurface cache
  albedoClean: 0,       // albedo has no texel under the cut — guard stands down
  albedoKeyed: 0,       // albedo HAS texels the material discards — gate armed
  payloadChecks: 0,     // payload alpha-floor checks run (pre + full + twin)
  admitted: 0,          // ... that passed (payload can reproduce the cutout)
  vetoedPre: 0,         // pre-record swaps refused
  vetoedFull: 0,        // full-record swaps refused
  hbc7Fallbacks: 0,     // vetoed xu7 records that asked for their tex-bc7 twin
  hbc7Rescued: 0,       // ... whose twin passed and was swapped in instead
  keptAlbedo: 0,        // final verdict vetoed: the material kept what it had
};

/** Parsed records produced by the `tex-xu7` lane (WeakSet: no retention). */
const _xu7Records = new WeakSet();

/** Which lane produced a parsed record: "xu7", "hbc7", or null. */
export function bc7RecordLane(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  return _xu7Records.has(parsed) ? "xu7" : "hbc7";
}

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
    // CLIP-ALPHA (2026-10-07) — rsIds whose `tex-xu7` record was proven to
    // have dropped the alpha key (`hbc7Fallback`). `_begin` skips xu7 for them
    // and goes straight to `tex-bc7`, so a later re-fetch (record evicted, LB
    // re-streamed) never re-downloads and re-transcodes the payload the guard
    // already refused. `_hbc7Absent` memoises a NEGATIVE twin verdict only
    // (a positive one lives in the budgeted `_cache`, so it stays evictable),
    // and `_hbc7InflightP` joins concurrent asks.
    this._xu7Rejected = new Set();
    this._hbc7Absent = new Set();
    this._hbc7InflightP = new Map();
    // Test seam (the twin of `fetchImpl`): resolves an ALREADY-TRANSCODED xu7
    // record (`{width,height,blocksX,blocksY,levels}`) or null, standing in for
    // `wasm.xu7_blocks` + the basisu transcoder. Production never sets it.
    this._xu7ParsedImpl = opts.xu7ParsedImpl || null;
  }

  /** The hbc7 (`holtburger/tex-bc7`) fetch, shared by `_begin` and
   *  `hbc7Fallback`. Resolves bytes, or null when no source is wired. */
  _fetchHbc7Bytes(id) {
    return this._fetchImpl
      ? Promise.resolve(this._fetchImpl(id))
      : this._wasm && typeof this._wasm.bc7_blocks === "function"
        ? Promise.resolve(this._wasm.bc7_blocks(id))
        : Promise.resolve(null);
  }

  /**
   * CLIP-ALPHA (2026-10-07) — the `tex-xu7` record for `rsId` dropped the
   * alpha key its RenderSurface carries (the guard in `bc7ClipAlphaGateFor`
   * proved it against the decoded albedo), so fetch the `tex-bc7` twin
   * directly. This is the xu7 lane's own documented contract — "any
   * miss/failure falls back to tex-bc7" — applied to a payload that arrived
   * intact but wrong.
   *
   * On success the twin REPLACES the xu7 record in the budgeted cache, so the
   * next Surface sharing this RenderSurface gets the good record straight
   * away; textures already built from the xu7 record keep their own
   * reference. Resolves the parsed twin, or null (absent / malformed /
   * fetch failed — the caller keeps the albedo it has). Never rejects.
   */
  hbc7Fallback(rsId, qctx) {
    const id = rsId >>> 0;
    this._xu7Rejected.add(id);
    const cur = this._cache.get(id);
    if (cur && !_xu7Records.has(cur)) return Promise.resolve(cur); // already swapped
    if (this._hbc7Absent.has(id)) return Promise.resolve(null);
    const joined = this._hbc7InflightP.get(id);
    if (joined) {
      // ?texUpgradeQueue: the joiner's liveness keeps a queued twin alive (a
      // dropped twin resolves TEX_DROPPED to EVERY joiner, and the ask-once
      // set means a live joiner would never ask again).
      if (qctx && qctx.queue) {
        try { qctx.queue.addWaiter("twin", id, qctx.hint); } catch (_) { /* diag-grade */ }
      }
      return joined;
    }
    _clipStats.hbc7Fallbacks += 1;
    // ?texUpgradeQueue: the twin is admitted like its full job (same band, at
    // the head) — on the already-cached leg too, since qctx is passed in.
    const bytesP = qctx && qctx.queue
      ? this._queuedFetch(qctx, "twin", id, () => this._fetchHbc7Bytes(id))
      : this._fetchHbc7Bytes(id);
    const p = bytesP
      .then((bytes) => {
        if (bytes === TEX_DROPPED) return TEX_DROPPED;
        if (!bytes || bytes.length === 0) return null;
        _stats.bytesFetched += bytes.length;
        _hdNote("twin", id, bytes.length);
        const parsed = parseHbc7(bytes);
        this._put(this._cache, id, parsed);
        return parsed;
      })
      .catch((e) => {
        _stats.lastError = String(e && e.message ? e.message : e);
        return null;
      })
      .then((parsed) => {
        if (parsed === TEX_DROPPED) _stats.twinsDropped += 1; // no negative verdict
        else if (!parsed) this._hbc7Absent.add(id);
        this._hbc7InflightP.delete(id);
        return parsed;
      });
    this._hbc7InflightP.set(id, p);
    return p;
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

  /** Diag (`?texUpgradeQueue` in-view tracker, both arms): the full-tier
   *  upgrade is still outstanding — queued/held, fetching, transcoding, or
   *  fetching its CLIP twin. */
  upgradePending(rsId) {
    const id = rsId >>> 0;
    return this._inflight.has(id) || this._hbc7InflightP.has(id);
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

  /** Async accessor: resolves to the parsed payload or null. With a `qctx`
   *  (`{queue, hint}`, `?texUpgradeQueue`) the fetch is admitted by the
   *  upgrade queue and may resolve `TEX_DROPPED`. */
  getAsync(rsId, qctx) {
    const id = rsId >>> 0;
    if (this._cache.has(id)) { this._touch(this._cache, id); return Promise.resolve(this._cache.get(id)); }
    return this._begin(id, qctx);
  }

  /**
   * P1 — async accessor for the PRE record (quarter-res twin). Resolves to
   * the parsed payload or null (absent / namespace not shipped / flag off /
   * wasm without the export). Never throws; never warns on absence — the pre
   * layer is optional by contract.
   */
  getPreAsync(rsId, qctx) {
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
    if (joined) {
      if (qctx && qctx.queue) {
        try { qctx.queue.addWaiter("pre", id, qctx.hint); } catch (_) { /* diag-grade */ }
      }
      return joined;
    }
    this._preInflight.add(id);
    _stats.preFetches += 1;
    // ?texUpgradeQueue: the pre record is admitted (held until the interior is
    // built; dispatched only for an in-view surface beyond D_full; cancelled
    // when the full record dispatches). Without a queue: today's direct fetch.
    const bytesP = qctx && qctx.queue
      ? this._queuedFetch(qctx, "pre", id, () => impl(id))
      : Promise.resolve(impl(id));
    const pre = bytesP
      .then((bytes) => {
        if (bytes === TEX_DROPPED) {
          _stats.preDropped += 1;
          return TEX_DROPPED; // no `_preCache` entry: not a verdict
        }
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
        _hdNote("pre", id, bytes.length);
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

  _begin(id, qctx) {
    // Join an ask already in flight (see `_inflightP` in the ctor).
    const joined = this._inflightP.get(id);
    if (joined) {
      // ?texUpgradeQueue: the joiner's liveness keeps a queued job alive.
      if (qctx && qctx.queue) {
        try { qctx.queue.addWaiter("full", id, qctx.hint); } catch (_) { /* diag-grade */ }
      }
      return joined;
    }
    if (qctx && qctx.queue) return this._beginQueued(id, qctx);
    this._inflight.add(id);
    _stats.fetches += 1;
    // P2 (2026-08-04): with `?texXu7=on`, try the XUBC7 namespace FIRST —
    // transcoded output is shape-identical to parseHbc7's, so the rest of
    // this chain and every consumer is codec-blind. Any miss/failure falls
    // through to the hbc7 fetch below, which is only kicked on that path
    // (no double bandwidth).
    const tryXu7 = () => {
      // CLIP-ALPHA (2026-10-07): an rsId whose xu7 record the guard already
      // refused goes straight to tex-bc7 (see `hbc7Fallback`).
      if (!texXu7Enabled() || this._xu7Rejected.has(id)) return Promise.resolve(null);
      if (this._xu7ParsedImpl) {
        return Promise.resolve(this._xu7ParsedImpl(id))
          .then((parsed) => {
            if (parsed) _xu7Records.add(parsed);
            return parsed || null;
          })
          .catch(() => null);
      }
      if (this._fetchImpl || !this._wasm || typeof this._wasm.xu7_blocks !== "function") {
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
      // `?texWorkerEager` (D3-b): a ready or loading texture worker counts as
      // up (`xu7TranscoderUp`); with that flag off this IS ensureXu7Transcoder.
      if (!xu7TranscoderUp()) return Promise.resolve(null);
      return Promise.resolve(this._wasm.xu7_blocks(id))
        .then((b) => {
          if (!b || b.length === 0) return null;
          _stats.bytesFetched += b.length;
          _hdNote("xu7", id, b.length);
          return transcodeXu7(b);
        })
        .then((parsed) => {
          // CLIP-ALPHA: remember which lane produced the record, so a vetoed
          // xu7 payload can fall back to its tex-bc7 twin (`bc7RecordLane`).
          if (parsed) _xu7Records.add(parsed);
          return parsed;
        })
        .catch(() => null);
    };
    const bytesP = () => this._fetchHbc7Bytes(id);
    // `?interiorHold` (2026-10-09): while an indoor player's interior is still
    // building, the full-tier record (xu7, then tex-bc7) waits — the surface
    // shows its retail albedo meanwhile, as it already does until the upgrade
    // lands. Entering the Town Network fetched 151 xu7 records (200 MB, up to
    // 4 MB each) alongside its ~1 MB of DAT records (1070, 2026-10-09).
    const p = holdForInterior()
      .then(() => tryXu7())
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
        _hdNote("hbc7", id, bytes.length);
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

  // ------------------------------------------------------------------------
  // ?texUpgradeQueue (2026-10-09) — the queued twin of `_begin`. Same chain,
  // same caches, same verdicts; the differences are WHEN each network leg
  // starts (the queue's admission replaces `holdForInterior`) and the DROPPED
  // outcome. Ticket protocol (scene3d/tex_upgrade_queue.js): `received(n)` as
  // the bytes arrive (before the transcode), every second leg through
  // `refetch("hbc7")`, `release()` when the chain ends.
  // ------------------------------------------------------------------------

  _beginQueued(id, qctx) {
    const q = qctx.queue;
    this._inflight.add(id);
    _stats.fetches += 1;
    // Will an xu7 leg be tried at all? (The transcoder gate is asked at
    // dispatch time, inside `_queuedXu7`.)
    const xu7Possible = texXu7Enabled() && !this._xu7Rejected.has(id) && (
      !!this._xu7ParsedImpl ||
      (!this._fetchImpl && !!this._wasm && typeof this._wasm.xu7_blocks === "function")
    );
    let ticket = null;
    const hbc7Leg = (t) => {
      ticket = t;
      return this._fetchHbc7Bytes(id).then((bytes) => {
        t.received(bytes ? bytes.length : 0);
        return this._settleHbc7(id, bytes);
      });
    };
    const p = Promise.resolve(q.admit("full", id, qctx.hint, { net: xu7Possible ? "xu7" : "hbc7" }))
      .then((t) => {
        if (!t) return TEX_DROPPED;
        ticket = t;
        if (!xu7Possible) return hbc7Leg(t);
        return this._queuedXu7(id, t).then((xu7Parsed) => {
          if (xu7Parsed) {
            this._put(this._cache, id, xu7Parsed);
            _stats.hits += 1;
            return xu7Parsed;
          }
          // xu7 absent / transcoder not up / transcode failed: the tex-bc7
          // leg is a NEW network leg, re-admitted at the head of its band.
          return Promise.resolve(t.refetch("hbc7")).then((t2) => (t2 ? hbc7Leg(t2) : TEX_DROPPED));
        });
      })
      .then((r) => {
        if (r === TEX_DROPPED) _stats.upgradesDropped += 1; // no `_put(null)`, no `absent`
        return r;
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
        if (ticket) {
          try { ticket.release(); } catch (_) { /* fail-soft */ }
        }
        this._inflight.delete(id);
        this._inflightP.delete(id);
      });
    this._inflightP.set(id, p);
    return p;
  }

  /** The xu7 leg under a ticket: `received` as soon as the payload is in
   *  (the slot frees before the transcode). Resolves parsed or null. */
  _queuedXu7(id, t) {
    if (this._xu7ParsedImpl) {
      return Promise.resolve(this._xu7ParsedImpl(id))
        .then((parsed) => {
          t.received(parsed ? _parsedBytes(parsed) : 0);
          if (parsed) _xu7Records.add(parsed);
          return parsed || null;
        })
        .catch(() => null);
    }
    // Same ask-don't-await gate as `_begin` (D3-b aware).
    if (!xu7TranscoderUp()) return Promise.resolve(null);
    return Promise.resolve(this._wasm.xu7_blocks(id))
      .then((b) => {
        t.received(b ? b.length : 0);
        if (!b || b.length === 0) return null;
        _stats.bytesFetched += b.length;
        _hdNote("xu7", id, b.length);
        return transcodeXu7(b);
      })
      .then((parsed) => {
        if (parsed) _xu7Records.add(parsed);
        return parsed || null;
      })
      .catch(() => null);
  }

  /** `_begin`'s hbc7 verdict step, verbatim, for the queued path. */
  _settleHbc7(id, bytes) {
    if (!bytes || bytes.length === 0) {
      this._put(this._cache, id, null); // proven-absent OR namespace not shipped
      _stats.absent += 1;
      return null;
    }
    _stats.bytesFetched += bytes.length;
    _hdNote("hbc7", id, bytes.length);
    let parsed;
    try {
      parsed = parseHbc7(bytes);
    } catch (e) {
      _stats.parseErrors += 1;
      _stats.lastError = String(e && e.message ? e.message : e);
      // eslint-disable-next-line no-console
      console.error(`[bc7] 0x${id.toString(16).toUpperCase()} malformed payload:`, e);
      this._put(this._cache, id, null);
      return null;
    }
    this._put(this._cache, id, parsed);
    _stats.hits += 1;
    return parsed;
  }

  /** One admitted fetch: resolves the bytes, or `TEX_DROPPED`. */
  _queuedFetch(qctx, kind, id, fetchFn) {
    return Promise.resolve(qctx.queue.admit(kind, id, qctx.hint)).then((t) => {
      if (!t) return TEX_DROPPED;
      let out;
      try {
        out = Promise.resolve(fetchFn());
      } catch (e) {
        t.release();
        return Promise.reject(e);
      }
      return out.then(
        (bytes) => {
          t.received(bytes ? bytes.length : 0);
          t.release();
          return bytes;
        },
        (e) => {
          t.release();
          throw e;
        },
      );
    });
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
    // CLIP-ALPHA (2026-10-07): the transparency guard's surface. `stats()`
    // tallies, `surface(did)` one Surface's verdict + its live map kind,
    // `refusals()` every surface whose gate refused a payload.
    window.__bc7ClipGuard = {
      stats: () => clipAlphaGuardStats(),
      surface: (did) => clipAlphaGuardSurface(did),
      refusals: () => clipAlphaGuardRefusals(),
    };
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
  _hdLog.length = 0;
  _verdictAt.clear();
  _resetClipAlphaGuardForTest();
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
 * CLIP-ALPHA (2026-10-07): `opts.gate` (from `bc7ClipAlphaGateFor`) is asked
 * before EVERY swap — pre, full, and the tex-bc7 twin — whether the payload
 * can reproduce the cutout its decoded albedo carries. A refused pre is simply
 * not swapped. A refused FULL record from the xu7 lane asks
 * `src.hbc7Fallback(rsId)` for its tex-bc7 twin (with `__bc7Pending` held, so
 * the atlas keeps deferring) and swaps that in if it passes. Otherwise the
 * verdict SETTLES exactly like an absent record: `__bc7Pending` cleared,
 * `__bc7Vetoed` stamped, the atlas refeed fired, and the material keeps the
 * map it has (the RGBA8 twin, or an admitted pre texture). No gate = the
 * pre-2026-10-07 behaviour byte for byte (`?bc7ClipAlphaGuard=off`).
 *
 * @param {(res:{swapped:true,replaced:THREE.Texture|null})=>void} [onSwap]
 *   invoked after EACH swap (pre and/or full) with the texture it replaced.
 * `?texUpgradeQueue` (2026-10-09): `opts.queue` (the TexUpgradeQueue) and
 * `opts.hint` (`{did, rs, w, h, live}`) are passed down as `qctx` to the pre,
 * full and twin fetches, which the queue admits in visibility order. A DROPPED
 * ask (no live waiter, no holder) clears `__bc7Pending` only — no gate
 * settle, no refeed, nothing cached. No queue = every line as before.
 *
 * @param {{gate?:{admit:(parsed:object, phase:string)=>boolean,
 *          settle?:(outcome:string)=>void}, queue?:object, hint?:object}} [opts]
 * @returns {Promise<boolean|{swapped:true,replaced:*}>} final-phase result
 */
export function upgradeMaterialToBc7(mat, rsId, onSwap, opts) {
  const src = bc7Source();
  const gate = opts && opts.gate && typeof opts.gate.admit === "function" ? opts.gate : null;
  const qctx = opts && opts.queue && typeof opts.queue.admit === "function"
    ? { queue: opts.queue, hint: opts.hint || null }
    : undefined;
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
      .getPreAsync(rsId, qctx)
      .then((parsed) => {
        // Lost the race (or full already landed): the pre texture is never
        // built, so there is nothing to dispose. parsed stays in _preCache
        // for any later asker. (TEX_DROPPED: the queue cancelled the pre.)
        if (!parsed || parsed === TEX_DROPPED || fullDone) return;
        if (mat.userData && mat.userData.__bc7) return; // full already swapped
        // CLIP-ALPHA: a pre record that cannot reproduce the cutout is never
        // swapped in; the full phase still decides the final texture.
        if (gate && !_gateAdmits(gate, parsed, "pre")) return;
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
    .getAsync(rsId, qctx)
    .then((parsed) => (gate && parsed && parsed !== TEX_DROPPED ? _gateFull(gate, src, rsId, parsed, mat, qctx) : parsed))
    .then((parsed) => {
      fullDone = true;
      const ud = (mat.userData = mat.userData || {});
      delete ud.__bc7Pending;
      if (parsed === TEX_DROPPED) {
        // ?texUpgradeQueue: nobody holds this surface any more — not a
        // verdict, so no gate settle and no refeed. A re-install asks again.
        return false;
      }
      if (parsed === _CLIP_VETOED) {
        // CLIP-ALPHA: a refused record is a SETTLED negative verdict, exactly
        // like an absent one — the material keeps the map it has for good,
        // so every producer holding members out on this rsId re-offers them.
        ud.__bc7Vetoed = "clip-alpha";
        _clipStats.keptAlbedo += 1;
        _gateSettle(gate, "kept");
        _verdictNote(rsId, "kept");
        _rsVerdictResolved(rsId);
        return false;
      }
      if (!parsed) {
        // An ABSENT record is a settled verdict: this material keeps the map
        // it has (RGBA8, or the pre texture) for good, so anything held out
        // on it is now admissible and must be re-offered.
        if (gate) _gateSettle(gate, "absent");
        _verdictNote(rsId, "absent");
        _rsVerdictResolved(rsId);
        return false;
      }
      const res = buildAndSwap(parsed, "full");
      _verdictNote(rsId, "swapped");
      if (gate) _gateSettle(gate, "swapped");
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
      _verdictNote(rsId, "failed");
      _rsVerdictResolved(rsId);
      return false;
    });
}

/** Sentinel: the gate refused every candidate record for this material. */
const _CLIP_VETOED = Object.freeze({ clipVetoed: true });

/** Ask the gate; a gate that throws ADMITS (the guard may only ever refuse
 *  an upgrade it has evidence against, never break one). */
function _gateAdmits(gate, parsed, phase) {
  try {
    return gate.admit(parsed, phase) !== false;
  } catch (_) {
    return true;
  }
}

function _gateSettle(gate, outcome) {
  if (!gate || typeof gate.settle !== "function") return;
  try {
    gate.settle(outcome);
  } catch (_) {
    /* diagnostic only */
  }
}

/**
 * Full-phase gate: the record itself, else (xu7 lane only) its tex-bc7 twin,
 * else `_CLIP_VETOED`. Holds `__bc7Pending` while the twin is in flight — on
 * the already-cached leg the marker was never set, and without it the atlas
 * could commit this node to an RGBA8 bucket a moment before the twin swaps.
 */
function _gateFull(gate, src, rsId, parsed, mat, qctx) {
  if (_gateAdmits(gate, parsed, "full")) return parsed;
  if (bc7RecordLane(parsed) !== "xu7" || typeof src.hbc7Fallback !== "function") {
    return _CLIP_VETOED;
  }
  const ud = (mat.userData = mat.userData || {});
  ud.__bc7Pending = true;
  // `qctx` (?texUpgradeQueue) is passed explicitly, so the twin is admitted
  // on the already-cached leg too (no `_begin` ran for it).
  return src.hbc7Fallback(rsId, qctx).then((twin) => {
    if (twin === TEX_DROPPED) return TEX_DROPPED;
    if (twin && _gateAdmits(gate, twin, "hbc7")) {
      _clipStats.hbc7Rescued += 1;
      return twin;
    }
    return _CLIP_VETOED;
  });
}

/** Whether a material is waiting on a BC7 verdict (atlas deferral gate). */
export function bc7PendingOn(mat) {
  return !!(mat && mat.userData && mat.userData.__bc7Pending);
}

// ==========================================================================
// CLIP-ALPHA guard (2026-10-07) — `?bc7ClipAlphaGuard`, DEFAULT ON
// ==========================================================================
//
// THE DEFECT. Owner report from the 1070: "grass isnt transparent and has
// black background" — reed clumps at the waterline (Surface 0x080000A1,
// `Base1ClipMap` over RenderSurface 0x0600385A, PFID_INDEX16 128x128) drawn
// as solid quads with black backgrounds, next to a grass tuft (0x0800007D,
// DXT5) that was fine. Retail `ImgTex::CopyIntoData` (acclient.c:365907)
// writes a ClipMap paletted texel whose index is < 8 as DWORD 0; our RGBA8
// decoder does the same (holtburger-dat texture.rs), so the retail-res
// albedo is right: 9,516 of its 16,384 texels are alpha 0.
//
// The upgrade replaces it. With `?texXu7` default-ON the record source asks
// `holtburger/tex-xu7` first, and the served dist's xu7 record for 0x0600385A
// (512x512, baked 2026-08-05 from the Remacri corpus, which was exported
// before the exporter learned the index<8 rule in 494b1aea) decodes to alpha
// >= 240 EVERYWHERE — 0 of 262,144 texels under the 100/255 alpha test,
// checked with Pillow's BC7 decoder. The key's RGB was palette colour 0
// (black), so the quad renders opaque black. The `tex-bc7` twin of the same
// record is correct (152,256 = 16 x 9,516 texels under the test; that lane
// was re-encoded 2026-07-31, after the exporter fix). The xu7 CORPUS was
// re-encoded on 2026-08-09 (texfix-fringe) but never re-ingested into the
// dist, so the served xu7 records are still the pre-fix encodes.
//
// Measured on the served dist (holtburger-dist-hires-bc7m-xu7t2): 254 Surface
// rows / 224 RenderSurfaces get an xu7 record that cannot reproduce their
// decoded cutout (244 INDEX16 index<8 keys + 10 DXT1 punch-through; 239
// alpha-tested ClipMap rows + 15 blended ClipMap rows; 9 of them fully
// transparent, which the PORTAL-BLACKBOX veto in materials.js already
// caught); every one of them has a tex-bc7 twin that can. The tex-bc7 and
// tex-bc7-pre lanes have ZERO such rows. `tools/clip-alpha-gate.mjs` is the
// bake-side twin of this rule and reproduces those numbers.
//
// THE RULE. A material samples its map's alpha when it alpha-tests
// (`alphaTest > 0`, cut = alphaTest * 255: a texel below it is discarded) or
// blends (`transparent`, cut = 128: "mostly see-through"). If the decoded
// albedo has ANY texel below the cut and the payload has NONE — its BC7 alpha
// floor (`bc7AlphaFloor`, an exact lower bound from the block endpoints) is
// >= the cut — the payload has lost the cutout and is refused. Refused xu7
// records fall back to their tex-bc7 twin (`Bc7RecordSource.hbc7Fallback`);
// if that fails too the material keeps the albedo it has.
//
// It can only REFUSE. Unreadable albedo (compressed, CPU plane released),
// a material that ignores alpha, an unreadable payload, a throwing check:
// every one of those admits, i.e. behaves exactly like `=off`.
//
// COST. One RGBA8 alpha scan per (RenderSurface, cut, dims), cached, and only
// for alpha-sampling materials; it stops at the first texel under the cut.
// The payload scan reads one byte + a few endpoint bits per level-0 block and
// stops at the first block whose floor is under the cut, so a payload that
// does carry the cutout costs a handful of blocks. Only a refused payload is
// walked to the end.

/**
 * `?bc7ClipAlphaGuard` — DEFAULT ON; `off`/`0`/`false`/`no` (the `flagIsOff`
 * family predicate) restores the pre-2026-10-07 swap byte for byte. Not
 * memoised: one read per surface ask, and the ESM suites re-stub `window`.
 */
export function bc7ClipAlphaGuardEnabled(search) {
  try {
    const s =
      search !== undefined
        ? search
        : typeof window !== "undefined" && window.location
          ? window.location.search
          : "";
    return !flagIsOff(new URLSearchParams(s).get("bc7ClipAlphaGuard"));
  } catch (_) {
    return true;
  }
}

/** (rs|clipBit|cut|WxH) -> boolean keyed. One scan per RenderSurface. */
const _clipAlbedoKeyed = new Map();
/** rsIds already logged (one console line per RenderSurface). */
const _clipLogged = new Set();
/** did -> diagnostic entry; bounded so a long route cannot grow it forever. */
const _clipSurfaces = new Map();
const _CLIP_SURFACES_MAX = 2048;
const _BASE1_CLIPMAP = 0x4;

function _hex8(v) {
  return "0x" + (v >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

/** The alpha value below which this material treats a texel as see-through,
 *  or 0 when the material never samples map alpha. */
export function clipAlphaCutOf(mat) {
  if (!mat) return 0;
  const at = +mat.alphaTest || 0;
  // Rounded to 1e-3 so 100/255 * 255 is exactly 100: the GPU discards
  // `a < alphaTest`, so a texel AT the ref survives and must not count.
  if (at > 0) return Math.round(at * 255 * 1000) / 1000;
  if (mat.transparent === true) return 128;
  return 0;
}

/**
 * Does the decoded RGBA8 albedo have a texel under `cut`? `null` when the
 * plane cannot be read (compressed map, released CPU mirror, bad dims) —
 * which makes the guard stand down.
 */
function _albedoKeyed(tex, cut, cacheKeyPrefix) {
  if (!tex || tex.isCompressedTexture) return null;
  const img = tex.image;
  const data = img && img.data;
  const w = img ? img.width | 0 : 0;
  const h = img ? img.height | 0 : 0;
  if (!data || !w || !h || typeof data.length !== "number" || data.length < w * h * 4) return null;
  const key = `${cacheKeyPrefix}|${cut}|${w}x${h}`;
  if (_clipAlbedoKeyed.has(key)) {
    _clipStats.albedoCacheHits += 1;
    return _clipAlbedoKeyed.get(key);
  }
  _clipStats.albedoScans += 1;
  let keyed = false;
  const n = w * h * 4;
  for (let i = 3; i < n; i += 4) {
    if (data[i] < cut) {
      keyed = true;
      break;
    }
  }
  _clipAlbedoKeyed.set(key, keyed);
  return keyed;
}

/**
 * Build the swap gate for one surface's BC7 upgrade, or `null` when the guard
 * has nothing to protect (flag off, material ignores alpha, albedo unreadable,
 * albedo has no cutout). Pass the result to `upgradeMaterialToBc7(…, { gate })`.
 *
 * @param {THREE.Material} mat cache-resident material, map = the RGBA8 albedo
 * @param {number} rsId RenderSurface id the albedo was decoded from
 * @param {number} [did] Surface id (diagnostics only)
 */
export function bc7ClipAlphaGateFor(mat, rsId, did = 0) {
  if (!bc7ClipAlphaGuardEnabled() || !mat) return null;
  _clipStats.asked += 1;
  const cut = clipAlphaCutOf(mat);
  if (!(cut > 0)) {
    _clipStats.notAlphaSampled += 1;
    return null;
  }
  const rs = rsId >>> 0;
  const flags = mat.userData && typeof mat.userData.surfaceTypeFlags === "number" ? mat.userData.surfaceTypeFlags >>> 0 : 0;
  const keyed = _albedoKeyed(mat.map, cut, `${rs}|${(flags & _BASE1_CLIPMAP) ? 1 : 0}`);
  if (keyed === null) {
    _clipStats.unreadable += 1;
    return null;
  }
  if (!keyed) {
    _clipStats.albedoClean += 1;
    return null;
  }
  _clipStats.albedoKeyed += 1;
  const d = did >>> 0;
  const entry = {
    did: _hex8(d),
    rs: _hex8(rs),
    cut,
    verdict: "pending",
    checks: [], // [{phase, lane, floor, w, h, admitted}]
    _mat: typeof WeakRef === "function" ? new WeakRef(mat) : null,
  };
  if (_clipSurfaces.size >= _CLIP_SURFACES_MAX) {
    _clipSurfaces.delete(_clipSurfaces.keys().next().value);
  }
  _clipSurfaces.set(d, entry);
  return {
    admit(parsed, phase) {
      _clipStats.payloadChecks += 1;
      const floor = bc7AlphaFloor(parsed, cut);
      const lane = phase === "pre" ? "pre" : bc7RecordLane(parsed);
      const ok = floor < 0 || floor < cut; // unreadable payload: admit
      entry.checks.push({ phase, lane, floor, w: parsed && parsed.width, h: parsed && parsed.height, admitted: ok });
      if (ok) {
        _clipStats.admitted += 1;
        return true;
      }
      if (phase === "pre") _clipStats.vetoedPre += 1;
      else _clipStats.vetoedFull += 1;
      return false;
    },
    settle(outcome) {
      const refused = entry.checks.filter((c) => !c.admitted);
      entry.verdict = outcome;
      if (refused.length === 0 || _clipLogged.has(rs)) return;
      _clipLogged.add(rs);
      const r = refused[0];
      const won = entry.checks.filter((c) => c.admitted).pop();
      let tail;
      if (outcome === "swapped") {
        tail = won && won.phase === "hbc7"
          ? "swapped in its tex-bc7 twin, which keeps the cutout"
          : "swapped in the full record, which keeps the cutout";
      } else if (won && won.phase === "pre") {
        tail = "keeping the admitted preview record";
      } else {
        tail = "keeping the decoded albedo";
      }
      // One line per RenderSurface, like the PORTAL-BLACKBOX veto above.
      // eslint-disable-next-line no-console
      console.warn(
        `[materials/bc7] refused the ${r.lane || r.phase} BC7 payload for surface ${entry.did} (rs ${entry.rs}):` +
          ` its alpha never drops below ${r.floor} but the decoded albedo has texels under the` +
          ` ${cut}/255 cut — the payload lost the transparency; ${tail} (?bc7ClipAlphaGuard=off restores the swap)`
      );
    },
  };
}

function _clipEntryView(e) {
  if (!e) return null;
  const mat = e._mat && typeof e._mat.deref === "function" ? e._mat.deref() : null;
  const map = mat && mat.map;
  return {
    did: e.did,
    rs: e.rs,
    cut: e.cut,
    verdict: e.verdict,
    checks: e.checks.map((c) => ({ ...c })),
    map: map
      ? {
          kind: map.isCompressedTexture ? "bc7" : "rgba8",
          w: map.image ? map.image.width : null,
          h: map.image ? map.image.height : null,
        }
      : null,
    vetoed: !!(mat && mat.userData && mat.userData.__bc7Vetoed),
  };
}

/** `window.__bc7ClipGuard.stats()` */
export function clipAlphaGuardStats() {
  let vetoedSurfaces = 0;
  let rescuedSurfaces = 0;
  for (const e of _clipSurfaces.values()) {
    if (e.checks.some((c) => !c.admitted)) {
      if (e.verdict === "swapped") rescuedSurfaces += 1;
      else vetoedSurfaces += 1;
    }
  }
  return {
    enabled: bc7ClipAlphaGuardEnabled(),
    ..._clipStats,
    armedSurfaces: _clipSurfaces.size,
    vetoedSurfaces,
    rescuedSurfaces,
    loggedRenderSurfaces: _clipLogged.size,
    albedoCacheSize: _clipAlbedoKeyed.size,
  };
}

/** The guard's record for one Surface DID (null when the gate never armed:
 *  flag off, material ignores alpha, or its albedo has no cutout). */
export function clipAlphaGuardSurface(did) {
  return _clipEntryView(_clipSurfaces.get(did >>> 0));
}

/** Every armed surface whose gate refused at least one payload. */
export function clipAlphaGuardRefusals() {
  const out = [];
  for (const e of _clipSurfaces.values()) {
    if (e.checks.some((c) => !c.admitted)) out.push(_clipEntryView(e));
  }
  return out;
}

/** Test hook — `_resetBc7ForTest` calls it too. */
export function _resetClipAlphaGuardForTest() {
  for (const k of Object.keys(_clipStats)) _clipStats[k] = 0;
  _clipAlbedoKeyed.clear();
  _clipLogged.clear();
  _clipSurfaces.clear();
}
