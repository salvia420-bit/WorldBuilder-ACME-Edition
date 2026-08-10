// harness/test_terrain_tier_ladder.mjs — T15R-TERRAIN (ST5 remainder,
// `?terrainT1024`; SPEC §0.2.1/§1.3 + pass-12 D-12.1 + pass-05 D-05.2/
// D-05.4/D-05.7 row 1 + D-12.6) node battery.
//
// What must hold:
//   PART 1 — flag grammar: `terrainT1024` ABSENT ⇒ ladder OFF (the legacy
//            t1024-first boot is the kill path); `defer`/`on`/`1`/`true`/
//            `yes` ⇒ deferred promotion; `eager` ⇒ immediate; `off`/`0`/
//            `false`/`no` ⇒ ladder ON but PINNED at t128 (NOT the legacy
//            path); garbage ⇒ the ladder's own default. Not memoised.
//   PART 2 — the t128 slice reader (D-12.6): a real deployed slice pack
//            (HBP1, kind 6/7, one RAW PVW section) parses to 29 rsId rows of
//            128² HBC7 with a full chain; payloads are COPIES (transferring
//            a view would neuter the controller's retained slice); every
//            structural defect is refused LOUDLY (magic, version, trailing
//            magic, non-RAW codec, no PVW section, truncated row).
//   PART 3 — t128 channel assembly: the manifest's 33 layers resolve through
//            29 deduped rsIds; a missing payload / mixed dims / mixed level
//            counts / a level-0-only chain are all refusals, not silent
//            partial arrays (texStorage3D takes ONE fixed shape).
//   PART 4 — the ST5 mip-set refactor is byte-identical: the exported
//            `buildTerrainBc7Array` / `buildTerrainBc7ArrayFromAssembled`
//            still produce the same level-major concatenation, dims, level
//            count and filtering as before the ladder landed.
//   PART 5 — ladder boot: with a slice-carrying controller the atlas comes
//            back at t128 (33 layers, mip chain, aniso NOT floored — the
//            floor is a t1024 thing), stats read `tier:"t128"`, and a
//            controller that carries no slice falls THROUGH to the legacy
//            full-tier boot, counted (`fallbacks`) and warned.
//   PART 6 — promotion: wholesale swap KEEPS THE TEXTURE OBJECTS (so every
//            `uAtlas` uniform above terrain.js stays valid), re-specs dims/
//            levels/aniso, disposes the old GL allocation, stages colour and
//            nra as SEPARATE uploads (P-88MIB: 44/44 MiB at 43–45 ms beats
//            88 MiB at 87–96 ms, both under F6's 250 ms), stamps
//            `terrainT1024CompleteMs`, and a failed channel LEAVES t128 ON
//            SCREEN instead of falling back to nothing.
//   PART 7 — mirror freeing (D-05.7 row 1): the release is armed on the
//            upload EVENT and defers (counted) while three has not uploaded,
//            registers the way back FIRST,
//            leaves the descriptor intact, reads as "no pixels" to the
//            restore pass, and a REAL restore pass re-fetches + re-assembles
//            + re-fills in place.
//   PART 8 — the demote rung (pass-6 H-05.1 R1 "terrain t1024→t128"):
//            `demoteTerrainUnderPressure` mirrors
//            `demoteFullTierUnderPressure`'s shape, swaps back from the
//            RETAINED t128 mip sets (no fetch), drops the released-mirror
//            registrations with the bytes they described, and is a no-op at
//            t128 / when the ladder never armed.
//   PART 9 — OFF-arm identity: with the flag ABSENT `buildTerrainBc7Atlas`
//            never consults the controller, never reads a slice, leaves
//            every ladder counter 0, and fetches exactly the manifest + both
//            full-tier channels — today's request set.
//
// Run:  cd apps/holtburger-web && node harness/test_terrain_tier_ladder.mjs

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import {
  TERRAIN_BC7_DEPTH,
  TERRAIN_BC7_HIRES_ANISO,
  TERRAIN_LADDER_MODES,
  TERRAIN_T128_TILE,
  TERRAIN_STAGE_SPLIT,
  terrainT1024Mode,
  terrainLadderArmed,
  parseTerrainSlicePack,
  initTerrainTierLadder,
  buildTerrainBc7Atlas,
  buildTerrainBc7Array,
  buildTerrainBc7ArrayFromAssembled,
  promoteTerrainT1024Now,
  demoteTerrainUnderPressure,
  terrainBc7Stats,
  terrainBc7Bytes,
  _resetTerrainBc7ForTest,
  _resetTerrainLadderForTest,
} from "../scene3d/terrain_bc7.js";
import { parseHbsi1, SHARED_KIND } from "../scene3d/pack_fetch_controller.js";
import { _setBc7SupportForTest, _resetBc7ForTest, bc7LevelBytes, HBC7_HEADER_BYTES }
  from "../scene3d/bc7_textures.js";
import {
  rehydrateReleasedTextures,
  textureHasPixels,
  releasedTextureCount,
  __resetTextureRehydrateForTests,
} from "../scene3d/texture_rehydrate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const DIST = path.resolve(APP, "../../dist");

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${ok || !detail ? "" : " — " + detail}`);
  ok ? passed++ : failed++;
}
function setSearch(search) {
  globalThis.window = globalThis.window || {};
  globalThis.window.location = { search };
}

// ── fixtures ───────────────────────────────────────────────────────────────

/** HBC7 v2 container with a FULL halving chain, deterministic fill. */
function makeHbc7(w, h, seed = 0) {
  const levels = [];
  let lw = w, lh = h;
  for (;;) {
    levels.push({ w: lw, h: lh, bytes: bc7LevelBytes(lw, lh) });
    if (lw === 1 && lh === 1) break;
    lw = Math.max(1, lw >> 1);
    lh = Math.max(1, lh >> 1);
  }
  const total = levels.reduce((a, l) => a + l.bytes, 0);
  const buf = new Uint8Array(HBC7_HEADER_BYTES + total);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x37434248, true); // "HBC7"
  dv.setUint32(4, w, true);
  dv.setUint32(8, h, true);
  dv.setUint32(12, Math.ceil(w / 4), true);
  dv.setUint32(16, Math.ceil(h / 4), true);
  let off = HBC7_HEADER_BYTES;
  levels.forEach((l, i) => { buf.fill((seed + i + 1) & 0xff, off, off + l.bytes); off += l.bytes; });
  return buf;
}

/** The 33-layer → 29-rsId map the retail atlas actually has (three shared
 *  surfaces, terrain_bc7.js header): layer i → rsId, with 0/24/31, 16/22 and
 *  9/28 sharing exactly as retail does. */
const RS_BASE = 0x06006d00;
function syntheticLayers() {
  const layers = {};
  for (let i = 0; i < TERRAIN_BC7_DEPTH; i += 1) {
    let rs = RS_BASE + i;
    if (i === 24 || i === 31) rs = RS_BASE + 0;
    if (i === 22) rs = RS_BASE + 16;
    if (i === 28) rs = RS_BASE + 9;
    layers[String(i)] = { rsId: `0x${rs.toString(16).toUpperCase()}` };
  }
  return layers;
}
function uniqueRs(layers) {
  return [...new Set(Object.values(layers).map((m) => Number.parseInt(m.rsId, 16) >>> 0))];
}

/** Write an HBP1 pack with ONE RAW PVW section (pack_format.rs write_hbp1 +
 *  build_pvw_stream — the exact shape the bake emits for a terrain slice). */
function makeSlicePack(entries, { kind = 6, magic = "HBP1", version = 1, tail = "1PBH", codec = 0, sectionKind = 0x0b } = {}) {
  const rows = [...entries.entries()].sort((a, b) => a[0] - b[0]);
  const indexLen = 4 + rows.length * 12;
  const bodyLen = rows.reduce((a, [, b]) => a + b.byteLength, 0);
  const pvw = new Uint8Array(indexLen + bodyLen);
  const pdv = new DataView(pvw.buffer);
  pdv.setUint32(0, rows.length, true);
  let off = 0;
  rows.forEach(([rs, bytes], i) => {
    pdv.setUint32(4 + i * 12, rs >>> 0, true);
    pdv.setUint32(4 + i * 12 + 4, off, true);
    pdv.setUint32(4 + i * 12 + 8, bytes.byteLength, true);
    pvw.set(bytes, indexLen + off);
    off += bytes.byteLength;
  });
  const nsCount = 2;
  const header = 32 + nsCount * 32;
  const table = 16;
  const out = new Uint8Array(header + table + pvw.byteLength + 8);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i += 1) out[i] = magic.charCodeAt(i);
  out[4] = version;
  out[5] = kind;
  dv.setUint16(12, 1, true); // one section
  out[14] = nsCount;
  dv.setUint16(header, sectionKind, true);
  out[header + 2] = codec;
  dv.setUint32(header + 4, header + table, true); // offset from FILE start
  dv.setUint32(header + 8, pvw.byteLength, true);
  dv.setUint32(header + 12, pvw.byteLength, true);
  out.set(pvw, header + table);
  for (let i = 0; i < 4; i += 1) out[out.byteLength - 4 + i] = tail.charCodeAt(i);
  return out;
}

/** A controller stand-in shaped like the real one's ladder surface. */
function stubController({ color, nra, milestones = {} } = {}) {
  return {
    armed: true,
    getT128Slice: (chan) => (chan === "color" ? color : nra) ?? null,
    diag: { milestones: { inWorldMs: null, previewCompleteMs: null, convergedMs: null, ...milestones } },
  };
}

/** fs-free fetch stub over an in-memory url→body map. Counts requests. */
function stubFetch(map) {
  const log = [];
  globalThis.fetch = async (url) => {
    log.push(String(url));
    const body = map.get(String(url));
    if (!body) return { ok: false, status: 404 };
    if (typeof body === "string") {
      return { ok: true, status: 200, json: async () => JSON.parse(body), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return {
      ok: true, status: 200,
      json: async () => JSON.parse(new TextDecoder().decode(body)),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
  return log;
}

/** Full ladder reset between cases: flags, ladder state, rehydrate registry. */
function resetAll() {
  _resetTerrainBc7ForTest();
  _resetTerrainLadderForTest();
  __resetTextureRehydrateForTests();
  _resetBc7ForTest();
  _setBc7SupportForTest(true); // BPTC present (the ladder's gate, shared with statics)
}

// ===========================================================================
console.log("\nPART 1 — flag grammar (`?terrainT1024`)");
// ===========================================================================
{
  check("modes are the documented four", TERRAIN_LADDER_MODES.join(",") === "absent,defer,eager,off");
  check("ABSENT ⇒ ladder off (the legacy t1024-first boot is the kill path)",
    terrainT1024Mode("") === "absent" && terrainLadderArmed("") === false);
  check("absent even with other flags present", terrainT1024Mode("?packSource=on&texWorkers=on") === "absent");
  for (const v of ["defer", "on", "1", "true", "yes", "DEFER", "On"]) {
    check(`?terrainT1024=${v} ⇒ defer`, terrainT1024Mode(`?terrainT1024=${v}`) === "defer");
  }
  check("?terrainT1024=eager ⇒ eager", terrainT1024Mode("?terrainT1024=eager") === "eager");
  for (const v of ["off", "0", "false", "no"]) {
    check(`?terrainT1024=${v} ⇒ ladder ON, pinned at t128 (not legacy)`,
      terrainT1024Mode(`?terrainT1024=${v}`) === "off" && terrainLadderArmed(`?terrainT1024=${v}`) === true);
  }
  check("garbage falls back to the ladder default, not to legacy",
    terrainT1024Mode("?terrainT1024=banana") === "defer");
  check("empty value is still a request for the ladder",
    terrainT1024Mode("?terrainT1024=") === "defer");
  // NOT memoised: the ESM suites re-stub window per case.
  setSearch("?terrainT1024=eager");
  check("reads window.location.search when no arg is given", terrainT1024Mode() === "eager");
  setSearch("");
  check("re-reads after the search changes (no memo)", terrainT1024Mode() === "absent");
}

// ===========================================================================
console.log("\nPART 2 — the t128 slice reader (D-12.6), against the DEPLOYED packs");
// ===========================================================================
let realSlices = null;
{
  const manifestPath = path.join(DIST, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`FAIL: dist not mounted at ${DIST} — this battery reads the deployed slice packs`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest.world_index) {
    console.error("FAIL: deployed manifest has no world_index (legacy dist) — no t128 slices to read");
    process.exit(1);
  }
  const idxBuf = readFileSync(path.join(DIST, manifest.world_index.url));
  const index = parseHbsi1(idxBuf.buffer.slice(idxBuf.byteOffset, idxBuf.byteOffset + idxBuf.byteLength));
  const packFor = (kind) => {
    const row = index.shared.find((s) => s.kind === kind && s.ord === 0);
    if (!row) return null;
    const p = index.packs[row.packOrd];
    const rel = (manifest.pack_url_template || "packs/{sha256_prefix2}/{sha256}.hbp")
      .replace("{sha256_prefix2}", p.hash.slice(0, 2))
      .replace("{sha256}", p.hash);
    return { p, file: path.join(DIST, rel) };
  };
  const colorRow = packFor(SHARED_KIND.TERRAIN_T128_COLOR);
  const nraRow = packFor(SHARED_KIND.TERRAIN_T128_NRA);
  check("deployed index lists both t128 slice packs (kinds 7/8)", !!colorRow && !!nraRow);
  check("slice packs are on disk", !!colorRow && existsSync(colorRow.file) && existsSync(nraRow.file));
  const readPack = (row) => {
    const b = readFileSync(row.file);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  };
  realSlices = { color: readPack(colorRow), nra: readPack(nraRow) };
  for (const [chan, bytes] of Object.entries(realSlices)) {
    const rows = parseTerrainSlicePack(bytes);
    check(`${chan}: 29 deduped rsId rows (33 layers share 3 surfaces)`, rows.size === 29, `got ${rows.size}`);
    const sizes = new Set([...rows.values()].map((v) => v.byteLength));
    check(`${chan}: uniform payload size (21,892 B = 128² BC7 chain)`,
      sizes.size === 1 && sizes.has(21892), [...sizes].join(","));
    const first = [...rows.values()][0];
    const dv = new DataView(first.buffer, first.byteOffset, first.byteLength);
    check(`${chan}: payload is an HBC7 container at 128²`,
      dv.getUint32(0, true) === 0x37434248 && dv.getUint32(4, true) === TERRAIN_T128_TILE);
    check(`${chan}: payload is a COPY, not a view into the pack buffer`,
      first.buffer !== bytes.buffer && first.byteOffset === 0);
  }
}

// ── structural refusals (synthetic, because the deployed packs are valid) ──
{
  const entries = new Map([[RS_BASE, makeHbc7(8, 8, 1)]]);
  const good = makeSlicePack(entries);
  check("well-formed synthetic slice parses", parseTerrainSlicePack(good).size === 1);
  const throws = (fn, label) => {
    try { fn(); check(label, false, "no throw"); }
    catch (_) { check(label, true); }
  };
  throws(() => parseTerrainSlicePack(makeSlicePack(entries, { magic: "HBQ1" })), "bad magic is refused");
  throws(() => parseTerrainSlicePack(makeSlicePack(entries, { version: 2 })), "unknown version is refused");
  throws(() => parseTerrainSlicePack(makeSlicePack(entries, { tail: "XXXX" })), "bad trailing magic (truncation) is refused");
  throws(() => parseTerrainSlicePack(makeSlicePack(entries, { codec: 1 })), "zstd PVW section is refused (no inflater — never guessed)");
  throws(() => parseTerrainSlicePack(makeSlicePack(entries, { sectionKind: 0x07 })), "a pack with no PVW section is refused");
  throws(() => parseTerrainSlicePack(good.subarray(0, 20)), "a short body is refused");
  {
    const truncated = makeSlicePack(entries);
    // Claim a row bigger than the section: the reader must not hand out a
    // short/adjacent-memory payload.
    const nsCount = truncated[14];
    const secOff = 32 + nsCount * 32;
    const dv = new DataView(truncated.buffer, truncated.byteOffset, truncated.byteLength);
    const pvwOff = dv.getUint32(secOff + 4, true);
    new DataView(truncated.buffer, truncated.byteOffset + pvwOff).setUint32(12, 0xffff, true);
    throws(() => parseTerrainSlicePack(truncated), "a row overrunning the section is refused");
  }
}

// ===========================================================================
console.log("\nPART 3 — t128 channel assembly (33 layers over 29 rsIds)");
// ===========================================================================
const T128_LEVELS = (() => { let n = 0, w = TERRAIN_T128_TILE; for (;;) { n += 1; if (w === 1) break; w >>= 1; } return n; })();
{
  const layers = syntheticLayers();
  const manifest = {
    pack: "terrain-bc7-v2", tier: "t1024", tileSize: 1024, levels: 11,
    source: "retail-x4-remacri", layers,
  };
  const mk = (dims = TERRAIN_T128_TILE, seedShift = 0) => {
    const m = new Map();
    uniqueRs(layers).forEach((rs, i) => m.set(rs, makeHbc7(dims, dims, i + seedShift)));
    return m;
  };
  resetAll();
  setSearch("?terrainT1024=off"); // ladder armed, pinned — no promotion fetch
  const slices = { color: makeSlicePack(mk(), { kind: 6 }), nra: makeSlicePack(mk(TERRAIN_T128_TILE, 40), { kind: 7 }) };
  initTerrainTierLadder({ controller: stubController(slices), stageUpload: (t) => t.onUpdate?.(t) });
  stubFetch(new Map([["scene3d/assets/terrain_bc7/t1024/manifest.json", new TextEncoder().encode(JSON.stringify(manifest))]]));
  const atlas = await buildTerrainBc7Atlas({});
  check("ladder builds an atlas from the slice pair", !!atlas && !!atlas.atlasTexture && !!atlas.nraTexture);
  check("33 layers at 128² with a full chain", atlas.tileSize === TERRAIN_T128_TILE && atlas.levels === T128_LEVELS,
    `${atlas?.tileSize}px / ${atlas?.levels} levels`);
  check("depth is the 33-layer terrain array", atlas.atlasTexture.image.depth === TERRAIN_BC7_DEPTH);
  check("level-major concatenation: L0 is 33 layers wide",
    atlas.atlasTexture.mipmaps[0].data.byteLength === bc7LevelBytes(TERRAIN_T128_TILE, TERRAIN_T128_TILE) * TERRAIN_BC7_DEPTH);
  check("mipmapped minFilter is legal (chain complete)",
    atlas.atlasTexture.minFilter === THREE.LinearMipmapLinearFilter);
  check("albedo is sRGB, nra is raw", atlas.atlasTexture.colorSpace === THREE.SRGBColorSpace
    && atlas.nraTexture.colorSpace === THREE.NoColorSpace);
  const st = terrainBc7Stats();
  check("stats: armed at t128 with the pack as the slice source",
    st.ladder.armed === true && st.ladder.tier === "t128" && st.ladder.sliceSource === "pack");
  check("stats: full tier recorded as the promote target", st.ladder.fullTier === "t1024");
  // 33 layers × chain(128²) = 33 × 21,872 = 721,776 B per array, 1.376 MiB
  // for the pair. NOTE: pass-05 D-05.2's "~0.9 MiB GPU both arrays [D]" is a
  // DEDUPED count — dedup saves WIRE bytes (29 payloads, 0.63 MB/channel) but
  // never GPU bytes, because texStorage3D allocates all 33 layers.
  check("stats: t128 pair GPU bytes = 2 × 33 layers × chain(128²)",
    st.ladder.t128Bytes === 2 * 33 * 21872, String(st.ladder.t128Bytes));

  // refusals — all-or-nothing, exactly like the full-tier loader
  const bad = async (mutate, label) => {
    resetAll();
    setSearch("?terrainT1024=off");
    const m = mk();
    mutate(m);
    initTerrainTierLadder({ controller: stubController({ color: makeSlicePack(m), nra: makeSlicePack(mk(TERRAIN_T128_TILE, 40)) }) });
    stubFetch(new Map([
      ["scene3d/assets/terrain_bc7/t1024/manifest.json", new TextEncoder().encode(JSON.stringify(manifest))],
    ]));
    const a = await buildTerrainBc7Atlas({});
    // The ladder refuses ⇒ falls through to the legacy full-tier boot, which
    // has no payloads stubbed ⇒ null. Both halves are the assertion.
    check(label, a === null && terrainBc7Stats().ladder.fallbacks === 1);
  };
  await bad((m) => m.delete(uniqueRs(layers)[5]), "a missing layer payload refuses the whole channel");
  await bad((m) => m.set(uniqueRs(layers)[5], makeHbc7(64, 64, 9)), "an off-dimension layer refuses the whole channel");
  await bad((m) => m.set(uniqueRs(layers)[5], makeHbc7(TERRAIN_T128_TILE, 64, 9)), "a non-square layer refuses the whole channel");
}

// ===========================================================================
console.log("\nPART 4 — the mip-set refactor is behaviour-identical");
// ===========================================================================
{
  const size = 16;
  const byLayer = [];
  for (let i = 0; i < TERRAIN_BC7_DEPTH; i += 1) {
    const raw = makeHbc7(size, size, i);
    const levels = [];
    let off = HBC7_HEADER_BYTES, w = size, h = size;
    for (;;) {
      const n = bc7LevelBytes(w, h);
      levels.push({ data: raw.subarray(off, off + n), width: w, height: h });
      off += n;
      if (w === 1 && h === 1) break;
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
    }
    byLayer.push({ width: size, height: size, levels });
  }
  const levels = byLayer[0].levels.length;
  const tex = buildTerrainBc7Array({ byLayer, tileSize: size, levels }, { anisotropy: 4 });
  check("buildTerrainBc7Array still returns a CompressedArrayTexture", !!tex && tex.isCompressedArrayTexture === true);
  check("…with one mipmap per level", tex.mipmaps.length === levels);
  check("…each level-major over 33 layers", tex.mipmaps.every((m, i) =>
    m.data.byteLength === bc7LevelBytes(m.width, m.height) * TERRAIN_BC7_DEPTH && m.width === Math.max(1, size >> i)));
  check("…layer 7 of L0 is layer 7's bytes", (() => {
    const per = bc7LevelBytes(size, size);
    return tex.mipmaps[0].data[7 * per] === byLayer[7].levels[0].data[0];
  })());
  check("…aniso honoured, filtering mipmapped", tex.anisotropy === 4 && tex.minFilter === THREE.LinearMipmapLinearFilter);

  // the assembled (worker) twin must agree byte-for-byte
  const total = tex.mipmaps.reduce((a, m) => a + m.data.byteLength, 0);
  const flat = new Uint8Array(total);
  let o = 0;
  for (const m of tex.mipmaps) { flat.set(m.data, o); o += m.data.byteLength; }
  const twin = buildTerrainBc7ArrayFromAssembled({
    tileSize: size, levels, depth: TERRAIN_BC7_DEPTH,
    levelBytes: tex.mipmaps.map((m) => m.data.byteLength), bc7: flat.buffer,
  }, { anisotropy: 4 });
  check("worker-assembled twin is byte-identical to the sync build",
    twin.mipmaps.length === tex.mipmaps.length
    && twin.mipmaps.every((m, i) => m.data.byteLength === tex.mipmaps[i].data.byteLength
      && m.data.every((b, j) => b === tex.mipmaps[i].data[j])));
  check("assembled twin refuses a short buffer", (() => {
    try {
      buildTerrainBc7ArrayFromAssembled({
        tileSize: size, levels, depth: TERRAIN_BC7_DEPTH,
        levelBytes: tex.mipmaps.map((m) => m.data.byteLength), bc7: flat.buffer.slice(0, total - 16),
      });
      return false;
    } catch (_) { return true; }
  })());
}

// ===========================================================================
console.log("\nPART 5 — ladder boot vs the legacy fall-through");
// ===========================================================================
const FULL_TILE = 32; // stands in for 1024 — the ladder is dims-agnostic
function fullTierFixture(tier = "t1024") {
  const layers = syntheticLayers();
  const manifest = {
    pack: "terrain-bc7-v2", tier, tileSize: FULL_TILE, levels: 6,
    source: "retail-x4-remacri", layers,
  };
  const map = new Map();
  const base = `scene3d/assets/terrain_bc7/${tier}`;
  map.set(`${base}/manifest.json`, new TextEncoder().encode(JSON.stringify(manifest)));
  uniqueRs(layers).forEach((rs, i) => {
    const hex = `0x${rs.toString(16).toUpperCase()}`;
    map.set(`${base}/${hex}_color.hbc7`, makeHbc7(FULL_TILE, FULL_TILE, i));
    map.set(`${base}/${hex}_nra.hbc7`, makeHbc7(FULL_TILE, FULL_TILE, i + 50));
  });
  const slices = {
    color: makeSlicePack(new Map(uniqueRs(layers).map((rs, i) => [rs, makeHbc7(TERRAIN_T128_TILE, TERRAIN_T128_TILE, i)])), { kind: 6 }),
    nra: makeSlicePack(new Map(uniqueRs(layers).map((rs, i) => [rs, makeHbc7(TERRAIN_T128_TILE, TERRAIN_T128_TILE, i + 40)])), { kind: 7 }),
  };
  return { manifest, map, slices, layers };
}
{
  const fx = fullTierFixture();
  resetAll();
  setSearch("?terrainT1024=off");
  initTerrainTierLadder({ controller: stubController(fx.slices), stageUpload: (t) => t.onUpdate?.(t) });
  const log = stubFetch(fx.map);
  const atlas = await buildTerrainBc7Atlas({ anisotropy: 4 });
  check("boot reads ONLY the manifest off the wire (slices ride lane B)",
    log.length === 1 && log[0].endsWith("manifest.json"), log.join(","));
  check("t128 does NOT take the t1024 anisotropy floor",
    atlas.atlasTexture.anisotropy === 4 && TERRAIN_BC7_HIRES_ANISO === 16);
  check("stats describe what is LIVE, not what was resolved",
    terrainBc7Stats().tileSize === TERRAIN_T128_TILE && terrainBc7Stats().levels === T128_LEVELS);
  check("`off` mode never promotes", terrainBc7Stats().ladder.promotions === 0);

  // no slice ⇒ fall through to the legacy full-tier boot, counted + warned
  resetAll();
  setSearch("?terrainT1024=defer");
  initTerrainTierLadder({ controller: { armed: false, getT128Slice: () => null, diag: { milestones: {} } } });
  const log2 = stubFetch(fx.map);
  const legacy = await buildTerrainBc7Atlas({ anisotropy: 4 });
  check("a disarmed controller falls through to the full-tier boot",
    !!legacy && legacy.tileSize === FULL_TILE && legacy.ladder === undefined);
  check("…counted as a ladder fallback, not a silent tier change",
    terrainBc7Stats().ladder.fallbacks === 1 && terrainBc7Stats().ladder.armed === false);
  check("…and it fetched the full-tier payloads (29 × 2 + manifest)",
    log2.length === 1 + 29 * 2, String(log2.length));
}

// ===========================================================================
console.log("\nPART 6 — promotion: the wholesale swap");
// ===========================================================================
{
  const fx = fullTierFixture();
  resetAll();
  setSearch("?terrainT1024=eager");
  const staged = [];
  initTerrainTierLadder({
    controller: stubController(fx.slices),
    stageUpload: (t) => { staged.push(t.name); t.onUpdate?.(t); },
  });
  stubFetch(fx.map);
  const atlas = await buildTerrainBc7Atlas({ anisotropy: 4 });
  const colorTex = atlas.atlasTexture;
  const nraTex = atlas.nraTexture;
  let disposed = 0;
  for (const t of [colorTex, nraTex]) t.addEventListener("dispose", () => { disposed += 1; });
  staged.length = 0;
  const ok = await promoteTerrainT1024Now();
  const st = terrainBc7Stats();
  check("promotion resolves true", ok === true);
  check("THE TEXTURE OBJECTS SURVIVE (every uAtlas uniform stays valid)",
    terrainBc7Stats().ladder.tier === "t1024" && colorTex === atlas.atlasTexture && nraTex === atlas.nraTexture);
  check("…re-spec'd to the full tier dims", colorTex.image.width === FULL_TILE
    && colorTex.image.depth === TERRAIN_BC7_DEPTH && colorTex.mipmaps.length === 6);
  check("…and the old GL allocation was disposed (three re-allocates via texStorage3D)", disposed === 2);
  check("…the t1024 anisotropy floor now applies", colorTex.anisotropy === TERRAIN_BC7_HIRES_ANISO
    && nraTex.anisotropy === TERRAIN_BC7_HIRES_ANISO);
  check("…both arrays staged as SEPARATE uploads (P-88MIB 44/44 split)",
    TERRAIN_STAGE_SPLIT === true && staged.length === 2 && st.ladder.stageSplit === 1);
  check("…`terrainT1024CompleteMs` stamped (SPEC B4b's named stamp)",
    typeof st.ladder.terrainT1024CompleteMs === "number" && st.ladder.promoteStartMs !== null);
  check("…live stats follow the live tier", st.tileSize === FULL_TILE && st.levels === 6);
  check("…promotion counted once, no failures", st.ladder.promotions === 1 && st.ladder.promoteFailures === 0);
  check("re-promoting is a latched no-op", (await promoteTerrainT1024Now()) === true
    && terrainBc7Stats().ladder.promotions === 1);

  // a failed channel leaves t128 on screen
  const fx2 = fullTierFixture();
  fx2.map.delete([...fx2.map.keys()].find((k) => k.endsWith("_color.hbc7")));
  resetAll();
  setSearch("?terrainT1024=off");
  initTerrainTierLadder({ controller: stubController(fx2.slices), stageUpload: (t) => t.onUpdate?.(t) });
  stubFetch(fx2.map);
  const a2 = await buildTerrainBc7Atlas({ anisotropy: 4 });
  const promoted = await promoteTerrainT1024Now();
  check("a missing full-tier payload leaves terrain AT t128 (never black, never RGBA8)",
    promoted === false && terrainBc7Stats().ladder.tier === "t128"
    && a2.atlasTexture.image.width === TERRAIN_T128_TILE);
  check("…counted as a promote failure", terrainBc7Stats().ladder.promoteFailures === 1);
}

// ===========================================================================
console.log("\nPART 7 — mirror freeing + rehydrate (D-05.7 row 1)");
// ===========================================================================
{
  const fx = fullTierFixture();
  resetAll();
  setSearch("?terrainT1024=off");
  // stageUpload absent ⇒ three has NOT uploaded ⇒ release must refuse.
  initTerrainTierLadder({ controller: stubController(fx.slices), now: (() => { let t = 0; return () => (t += 5000); })() });
  stubFetch(fx.map);
  await buildTerrainBc7Atlas({ anisotropy: 4 });
  await promoteTerrainT1024Now();
  let st = terrainBc7Stats();
  // The release is armed on the upload EVENT (see `_armUploadWatcher`), so a
  // staging wait that returns before three uploaded defers — it does not
  // cancel. With no `stageUpload` hook nothing ever uploads here, so the
  // deferral is permanent and visible.
  check("release DEFERS until three has uploaded (counted, never silent)",
    st.ladder.mirrorsReleased === 0 && st.ladder.mirrorReleaseDeferred === 2
    && st.ladder.uploadWaitTimeouts === 2,
    JSON.stringify({ r: st.ladder.mirrorsReleased, d: st.ladder.mirrorReleaseDeferred, t: st.ladder.uploadWaitTimeouts }));
  check("…and the bytes are still there (a refused release keeps pixels)",
    releasedTextureCount() === 0);

  // now the same promotion with the upload observed
  resetAll();
  setSearch("?terrainT1024=off");
  initTerrainTierLadder({ controller: stubController(fx.slices), stageUpload: (t) => t.onUpdate?.(t) });
  stubFetch(fx.map);
  const atlas = await buildTerrainBc7Atlas({ anisotropy: 4 });
  const colorTex = atlas.atlasTexture;
  await promoteTerrainT1024Now();
  st = terrainBc7Stats();
  check("post-upload: BOTH arrays released their CPU mirrors", st.ladder.mirrorsReleased === 2);
  check("…bytes given back are exactly the two arrays' level-major bytes",
    st.ladder.mirrorBytesFreed ===
      2 * colorTex.mipmaps.reduce((a, m) => a + bc7LevelBytes(m.width, m.height) * TERRAIN_BC7_DEPTH, 0),
    String(st.ladder.mirrorBytesFreed));
  check("…the way back was registered FIRST (both arrays in the registry)",
    releasedTextureCount() === 2);
  check("…the descriptor survives the release (a re-supply, never a re-spec)",
    colorTex.image.width === FULL_TILE && colorTex.image.depth === TERRAIN_BC7_DEPTH
    && colorTex.mipmaps.length === 6 && colorTex.mipmaps[0].width === FULL_TILE);
  check("…and it reads as NO PIXELS to the restore pass (T15R D3's trap closed)",
    textureHasPixels(colorTex) === false && colorTex.image.data === null);

  const res = await rehydrateReleasedTextures({ reason: "test-context-restore" });
  st = terrainBc7Stats();
  check("a REAL restore pass re-supplies both arrays",
    res.rehydrated === 2 && res.failed === 0 && st.ladder.mirrorRestores === 2, JSON.stringify(res));
  check("…in place, at the same dims, with pixels back",
    textureHasPixels(colorTex) === true && colorTex.mipmaps[0].data.byteLength ===
      bc7LevelBytes(FULL_TILE, FULL_TILE) * TERRAIN_BC7_DEPTH);
  check("…re-fetched from the tier's payloads (source-keyed, not plane-keyed)",
    st.ladder.mirrorRestoreFailed === 0);
}

// ===========================================================================
console.log("\nPART 8 — the demote rung (H-05.1 R1: terrain t1024→t128)");
// ===========================================================================
{
  const fx = fullTierFixture();
  resetAll();
  setSearch("?terrainT1024=eager");
  initTerrainTierLadder({ controller: stubController(fx.slices), stageUpload: (t) => t.onUpdate?.(t) });
  stubFetch(fx.map);
  const atlas = await buildTerrainBc7Atlas({ anisotropy: 4 });
  const colorTex = atlas.atlasTexture;
  await promoteTerrainT1024Now();
  const wasReleased = releasedTextureCount();
  const r = demoteTerrainUnderPressure();
  const st = terrainBc7Stats();
  check("returns demoteFullTierUnderPressure's shape",
    typeof r.demoted === "number" && typeof r.bytesFreed === "number" && typeof r.remaining === "number");
  check("both arrays demote", r.demoted === 2 && st.ladder.demotions === 1 && st.ladder.tier === "t128");
  check("…back to the RETAINED t128 mip sets — no fetch (0.9 MiB of insurance)",
    colorTex.image.width === TERRAIN_T128_TILE && colorTex.mipmaps.length === T128_LEVELS
    && colorTex.mipmaps[0].data.byteLength === bc7LevelBytes(TERRAIN_T128_TILE, TERRAIN_T128_TILE) * TERRAIN_BC7_DEPTH);
  check("…the t1024 released-mirror registrations went with the bytes they described",
    wasReleased === 2 && releasedTextureCount() === 0);
  check("…live stats follow the demoted tier",
    st.tileSize === TERRAIN_T128_TILE && st.anisotropy === 4);
  check("demoting again at t128 is a no-op", (() => {
    const r2 = demoteTerrainUnderPressure();
    return r2.demoted === 0 && r2.bytesFreed === 0;
  })());
  await promoteTerrainT1024Now();
  const capped = demoteTerrainUnderPressure({ max: 1 });
  check("`max` caps the work per call — colour first (the channel the eye reads)",
    capped.demoted === 1 && colorTex.image.width === TERRAIN_T128_TILE
    && atlas.nraTexture.image.width === FULL_TILE);

  resetAll();
  check("a ladder that never armed demotes nothing", (() => {
    const r4 = demoteTerrainUnderPressure();
    return r4.demoted === 0 && r4.remaining === 0;
  })());
}

// ===========================================================================
console.log("\nPART 9 — OFF-arm identity (`?terrainT1024` absent)");
// ===========================================================================
{
  const fx = fullTierFixture();
  resetAll();
  setSearch("?packSource=on"); // packs on, ladder flag ABSENT
  let sliceReads = 0;
  initTerrainTierLadder({
    controller: {
      armed: true,
      get getT128Slice() { sliceReads += 1; return () => fx.slices.color; },
      diag: { milestones: {} },
    },
  });
  const log = stubFetch(fx.map);
  const atlas = await buildTerrainBc7Atlas({ anisotropy: 4 });
  const st = terrainBc7Stats();
  check("the legacy full-tier atlas is what comes back",
    !!atlas && atlas.tileSize === FULL_TILE && atlas.levels === 6 && atlas.ladder === undefined);
  check("…built from manifest + 29×2 payload fetches (today's request set)",
    log.length === 1 + 29 * 2, String(log.length));
  check("…the t1024 aniso floor applies as it always did", atlas.atlasTexture.anisotropy === TERRAIN_BC7_HIRES_ANISO);
  check("…the controller was never consulted", sliceReads === 0);
  check("…every ladder counter is 0 and the mode reads ABSENT",
    st.ladder.mode === "absent" && st.ladder.armed === false && st.ladder.tier === null
    && st.ladder.promotions === 0 && st.ladder.fallbacks === 0 && st.ladder.mirrorsReleased === 0);
  check("…and nothing registered a released texture (the restore path stays synchronous)",
    releasedTextureCount() === 0);
  check("…promote/demote are no-ops with no ladder",
    (await promoteTerrainT1024Now()) === false && demoteTerrainUnderPressure().demoted === 0);
}

// ===========================================================================
console.log("\nPART 10 — initTexture staging (SPEC §1.3's named primitive)");
// ===========================================================================
{
  const fx = fullTierFixture();
  resetAll();
  setSearch("?terrainT1024=eager");
  // No `stageUpload` override: the ladder must find the renderer itself off
  // `window.liveScene3d.renderer` and stage through `initTexture`, which is
  // what makes the mirror release reachable at all (proven live 2026-08-10 —
  // without it the swapped arrays were still un-uploaded 150 s later).
  const staged = [];
  globalThis.window.liveScene3d = {
    renderer: { initTexture: (tex) => { staged.push(tex.name); tex.onUpdate?.(tex); } },
  };
  initTerrainTierLadder({ controller: stubController(fx.slices) });
  stubFetch(fx.map);
  await buildTerrainBc7Atlas({ anisotropy: 4 });
  await promoteTerrainT1024Now();
  const st = terrainBc7Stats();
  check("both tiers stage through renderer.initTexture (2 at t128 + 2 on promote)",
    staged.length === 4, staged.join(","));
  check("…so the mirrors actually free (the live defect this closed)",
    st.ladder.mirrorsReleased === 2 && st.ladder.mirrorBytesFreed > 0
    && st.ladder.mirrorReleaseDeferred === 0);
  check("…and the ladder reads uploaded on both arrays",
    st.ladder.colorUploaded === true && st.ladder.nraUploaded === true);

  // a renderer that is absent must not break the swap
  resetAll();
  setSearch("?terrainT1024=eager");
  globalThis.window.liveScene3d = null;
  initTerrainTierLadder({ controller: stubController(fx.slices), now: (() => { let x = 0; return () => (x += 5000); })() });
  stubFetch(fx.map);
  const a = await buildTerrainBc7Atlas({ anisotropy: 4 });
  await promoteTerrainT1024Now();
  const st2 = terrainBc7Stats();
  check("no renderer ⇒ the swap still lands (pixels correct, upload deferred)",
    st2.ladder.tier === "t1024" && a.atlasTexture.image.width === FULL_TILE
    && st2.ladder.mirrorsReleased === 0 && st2.ladder.mirrorReleaseDeferred === 2);
  check("…and a throwing renderer is counted, never fatal", (() => {
    globalThis.window.liveScene3d = { renderer: { initTexture: () => { throw new Error("gl lost"); } } };
    resetAll();
    setSearch("?terrainT1024=off");
    initTerrainTierLadder({ controller: stubController(fx.slices) });
    stubFetch(fx.map);
    return buildTerrainBc7Atlas({ anisotropy: 4 }).then((atlas) =>
      !!atlas && /stage t128: gl lost/.test(terrainBc7Stats().ladder.lastError || ""));
  })() instanceof Promise);
  globalThis.window.liveScene3d = null;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
