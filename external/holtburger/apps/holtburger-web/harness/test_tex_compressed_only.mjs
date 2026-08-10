// harness/test_tex_compressed_only.mjs — T15 (ST5, `?texCompressedOnly`,
// SPEC §3 T15; pass 5 D-05.5/D-05.6/D-05.7/S4/S5) node battery.
//
// What must hold:
//   PART 1 — flag grammar: `texCompressedOnly` EXACT-MATCH opt-in DEFAULT
//            OFF; `atlasPreviewCommit` default-ON `flagIsOff` escape; the
//            `texCompressedOnlyActive()` gate needs flag + BPTC + armed
//            wasm exports + armed controller — any leg missing ⇒ inactive.
//   PART 2 — record budget: 256 MB legacy / 128 MB under the flag
//            (D-05.7); explicit N and `off` grammar unchanged.
//   PART 3 — arrays (D-05.6.1/S5): default allocator byte-identical
//            level-0-only; `mipChain` allocates the complete halving chain
//            + aniso + mipmapped filtering; `writeBc7ArrayLayer` writes
//            EVERY level of a chain array at the right offsets and REFUSES
//            a shallow payload LOUDLY (counted) — level-0-only arrays keep
//            the legacy single-level write.
//   PART 4 — growth (D-05.6.4): ×1.5 step under the flag (M6-compliant:
//            allocated ≤ 1.5× needed at every step), X7 doubling OFF-arm,
//            ceiling clamp both arms.
//   PART 5 — record adoption/drop: `adoptParsed` charges the budget and
//            trims; `dropRecord` refunds bytes (the demote primitive's
//            cache half).
//   PART 6 — atlas preview-commit + re-home (D-05.6.3, F-11.17): a
//            preview-born node commits at preview dims from frame 1;
//            `atlasRefeed(rsId)` re-homes it into the full-dim bucket;
//            the emptied preview bucket GCs on the optimize pass. ESCAPE
//            arm (`?atlasPreviewCommit=off`): hold-out + tracked; refeed
//            commits and removes the scene singleton (nothing can stick).
//   PART 7 — materials vertical (D-05.5/S4): `get()` builds the material
//            from scalars + resident PVW with ZERO pixel decode (the
//            legacy fetch is never called); lane-T upgrade rides the
//            controller (lane "T", component "texFull", expectedHash) +
//            the (mocked) texture worker; swap + NRA attach + refeed fire;
//            `demoteToPreview` restores the preview and drops the record.
//            Failure leg: controller rejection ⇒ material STAYS preview
//            (counted `fullFailed`), never white, never RGBA8.
//   PART 8 — T15R rehydrate v3 (D-05.7 row 2) + the demote rung (H-05.1 R1):
//            the full-tier CPU mirror is armed with a SOURCE-keyed way back
//            at upgrade time; release refuses until three has uploaded;
//            release registers-first-then-drops, leaves the descriptor
//            intact, and reads as "no pixels" to the restore pass; a restore
//            re-fetches the xu7 CAS + re-transcodes and re-adopts; RECORD
//            EVICTION drives the release (the D-05.7 identity: the budget
//            frees real heap now); `demoteFullTierUnderPressure` sheds
//            oldest-first under byte/count targets and unregisters mirrors
//            with the textures it disposes. OFF arm: no mirror exists, so
//            eviction and the registry behave exactly as before.
//
// Run:  cd apps/holtburger-web && node harness/test_tex_compressed_only.mjs

import * as THREE from "three";
import {
  texCompressedOnlyEnabled,
  texCompressedOnlyActive,
  initTexCompressedOnly,
  _resetTexCompressedOnlyForTest,
  _setBc7SupportForTest,
  _resetBc7ForTest,
  initBc7Source,
  bc7Source,
  bc7Stats,
  texStats,
  bc7RecordBudgetBytes,
  bc7LevelBytes,
  makeBc7ArrayTexture,
  writeBc7ArrayLayer,
  makeBc7Texture,
  parseHbc7,
  registerAtlasRefeed,
  atlasRefeed,
  Bc7RecordSource,
  HBC7_HEADER_BYTES,
  registerFullTierMirror,
  releaseFullTierMirror,
  unregisterFullTierMirror,
  fullTierMirrorStats,
  _resetFullTierMirrorsForTest,
} from "../scene3d/bc7_textures.js";
import {
  rehydrateReleasedTextures,
  textureHasPixels,
  releasedTextureCount,
  __resetTextureRehydrateForTests,
} from "../scene3d/texture_rehydrate.js";
import {
  atlasPreviewCommitEnabled,
  _atlasGrowTargetFor,
  _resetStatAtlasForTest,
  _statAtlasBucketsForTest,
  _statAtlasStatsForTest,
  addSingletonsToCrossLbAtlas,
  tickStatAtlasOptimize,
} from "../scene3d/static_atlas.js";
import {
  _setTexWorkerFactoryForTest,
  _resetTexWorkerForTest,
} from "../scene3d/xu7_textures.js";
import { MaterialCache } from "../scene3d/materials.js";

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${ok || !detail ? "" : " — " + detail}`);
  ok ? passed++ : failed++;
}

function setSearch(search) {
  globalThis.window = globalThis.window || {};
  globalThis.window.location = { search };
}

/** Build a valid HBC7 container with a FULL halving chain, deterministic
 *  per-level fill (level index + seed). */
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
  levels.forEach((l, i) => {
    buf.fill((seed + i + 1) & 0xff, off, off + l.bytes);
    off += l.bytes;
  });
  return buf;
}

function quadGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0,0,0, 1,0,0, 1,1,0, 0,1,0]), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0,0, 1,0, 1,1, 0,1]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

// ===========================================================================
console.log("PART 1 — flag grammar + active gate");
// ===========================================================================
{
  for (const [q, want] of [
    ["?texCompressedOnly=on", true], ["?texCompressedOnly=1", true],
    ["?texCompressedOnly=true", true], ["?texCompressedOnly=yes", true],
    ["?texCompressedOnly=off", false], ["?texCompressedOnly=0", false],
    ["?texCompressedOnly=", false], ["?texCompressedOnly=garbage", false],
    ["", false],
  ]) {
    check(`texCompressedOnlyEnabled("${q}") === ${want}`, texCompressedOnlyEnabled(q) === want);
  }
  for (const [q, want] of [
    ["", true], ["?atlasPreviewCommit=on", true],
    ["?atlasPreviewCommit=off", false], ["?atlasPreviewCommit=0", false],
    ["?atlasPreviewCommit=false", false], ["?atlasPreviewCommit=no", false],
  ]) {
    check(`atlasPreviewCommitEnabled("${q}") === ${want}`, atlasPreviewCommitEnabled(q) === want);
  }
  // Active gate: every leg required.
  _resetBc7ForTest();
  _resetTexCompressedOnlyForTest();
  setSearch("?texCompressedOnly=on");
  const ns = { surface_meta_sync: () => "", pack_pvw_blocks: () => new Uint8Array(0), pack_texref: () => -1 };
  check("inactive: flag on, nothing armed", texCompressedOnlyActive() === false);
  _setBc7SupportForTest(true);
  check("inactive: no wasm/controller", texCompressedOnlyActive() === false);
  initTexCompressedOnly({ wasmNs: ns, controller: { armed: false } });
  check("inactive: controller unarmed", texCompressedOnlyActive() === false);
  initTexCompressedOnly({ wasmNs: ns, controller: { armed: true } });
  check("ACTIVE: all legs armed", texCompressedOnlyActive() === true);
  _setBc7SupportForTest(false);
  check("inactive again: BPTC absent", texCompressedOnlyActive() === false);
  setSearch("");
  _setBc7SupportForTest(true);
  check("inactive: flag absent (DEFAULT OFF)", texCompressedOnlyActive() === false);
  _resetBc7ForTest();
  _resetTexCompressedOnlyForTest();
}

// ===========================================================================
console.log("PART 2 — record budget (D-05.7: 256 legacy / 128 compressed-only)");
// ===========================================================================
{
  check("legacy default 256 MB", bc7RecordBudgetBytes("") === 256 * 1024 * 1024);
  check("compressed-only default 128 MB",
    bc7RecordBudgetBytes("?texCompressedOnly=on") === 128 * 1024 * 1024);
  check("explicit N wins both arms",
    bc7RecordBudgetBytes("?texCompressedOnly=on&bc7RecordsMB=64") === 64 * 1024 * 1024);
  check("off disarms", bc7RecordBudgetBytes("?bc7RecordsMB=off") === Infinity);
}

// ===========================================================================
console.log("PART 3 — arrays: chain allocation + per-level writes");
// ===========================================================================
{
  // Default allocator: byte-identical level-0-only shape (the OFF arm).
  const flat = makeBc7ArrayTexture(16, 16, 3);
  check("default: 1 mip level", flat.mipmaps.length === 1);
  check("default: LinearFilter", flat.minFilter === THREE.LinearFilter);
  check("default: level-0 bytes = layerBytes*depth",
    flat.mipmaps[0].data.byteLength === bc7LevelBytes(16, 16) * 3);
  check("default: no aniso claim", (flat.anisotropy ?? 1) === 1);

  // Chain allocator.
  const chain = makeBc7ArrayTexture(16, 16, 3, { mipChain: true, anisotropy: 8 });
  check("chain: 5 levels for 16x16", chain.mipmaps.length === 5);
  check("chain: mipmapped minFilter", chain.minFilter === THREE.LinearMipmapLinearFilter);
  check("chain: aniso applied", chain.anisotropy === 8);
  let sizesOk = true;
  let lw = 16, lh = 16;
  for (const m of chain.mipmaps) {
    if (m.width !== lw || m.height !== lh) sizesOk = false;
    if (m.data.byteLength !== bc7LevelBytes(lw, lh) * 3) sizesOk = false;
    lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1);
  }
  check("chain: per-level dims + depth-multiplied bytes", sizesOk);

  // Full-chain layer write at layer 1.
  const parsed = parseHbc7(makeHbc7(16, 16, 0x40));
  const okWrite = writeBc7ArrayLayer(chain, 1, parsed);
  check("chain write accepted", okWrite === true);
  let bytesOk = true;
  chain.mipmaps.forEach((m, i) => {
    const stride = bc7LevelBytes(m.width, m.height);
    const seg = m.data.subarray(1 * stride, 2 * stride);
    const want = (0x40 + i + 1) & 0xff;
    if (!seg.every((b) => b === want)) bytesOk = false;
    const before = m.data.subarray(0, stride);
    if (!before.every((b) => b === 0)) bytesOk = false; // layer 0 untouched
  });
  check("chain write: every level at layer-1 offsets, layer 0 untouched", bytesOk);
  check("chain write: layer marked", chain.layerUpdates && chain.layerUpdates.has(1));

  // Shallow payload into a chain array: LOUD refusal, counted.
  const before = bc7Stats().chainWriteRejects;
  const shallow = { width: 16, height: 16, levels: [parsed.levels[0]] };
  check("shallow payload refused", writeBc7ArrayLayer(chain, 2, shallow) === false);
  check("refusal counted (chainWriteRejects)", bc7Stats().chainWriteRejects === before + 1);

  // Level-0-only array keeps the legacy single-level write.
  check("legacy single-level write still accepted", writeBc7ArrayLayer(flat, 0, shallow) === true);
}

// ===========================================================================
console.log("PART 4 — growth step (D-05.6.4)");
// ===========================================================================
{
  setSearch("");
  check("OFF arm doubles (4→8, cap 64)", _atlasGrowTargetFor(4, 5, 64) === 8);
  check("OFF arm needed wins (4→9)", _atlasGrowTargetFor(4, 9, 64) === 9);
  setSearch("?texCompressedOnly=on");
  check("ON arm ×1.5 (4→6)", _atlasGrowTargetFor(4, 5, 64) === 6);
  check("ON arm needed wins (4→9)", _atlasGrowTargetFor(4, 9, 64) === 9);
  check("ON arm ceiling clamp (48→64@cap64)", _atlasGrowTargetFor(48, 49, 64) === 64);
  check("at-cap returns alloc", _atlasGrowTargetFor(64, 65, 64) === 64);
  // M6 form: allocated ≤ 1.5× the pre-step allocation whenever the step
  // (not `needed`) decides.
  let m6ok = true;
  for (let a = 1; a <= 128; a += 1) {
    const t = _atlasGrowTargetFor(a, a + 1, 1024);
    if (t > Math.ceil(a * 1.5) && t !== a + 1) m6ok = false;
  }
  check("ON arm M6-bounded across 1..128", m6ok);
  setSearch("");
}

// ===========================================================================
console.log("PART 5 — record adoption / drop (the demote primitive's cache half)");
// ===========================================================================
{
  const src = new Bc7RecordSource({ budgetBytes: 100_000 });
  const p1 = parseHbc7(makeHbc7(32, 32, 1)); // ~5.8 KB payload
  src.adoptParsed(0x06000001, p1);
  const s1 = src.recordCacheStats();
  check("adoptParsed charges bytes", s1.bytes > 0 && s1.records === 1);
  check("dropRecord refunds", src.dropRecord(0x06000001) === true && src.recordCacheStats().bytes === 0);
  check("dropRecord absent → false", src.dropRecord(0x06000009) === false);
  // Over-budget adoption trims oldest-first (each 32x32 chain ≈ 1.4 KB).
  const tiny = new Bc7RecordSource({ budgetBytes: 2_000 });
  tiny.adoptParsed(0x06000001, parseHbc7(makeHbc7(32, 32, 1)));
  tiny.adoptParsed(0x06000002, parseHbc7(makeHbc7(32, 32, 2)));
  const st = tiny.recordCacheStats();
  check("adoption over budget trims (evictions > 0, bytes ≤ budget)",
    st.evictions > 0 && st.bytes <= 2_000, JSON.stringify(st));
}

// ===========================================================================
console.log("PART 6 — atlas preview-commit + atlasRefeed re-home + GC");
// ===========================================================================
{
  const RS = 0x06001111;
  const arm = (search) => {
    _resetBc7ForTest();
    _resetTexCompressedOnlyForTest();
    setSearch(search);
    _setBc7SupportForTest(true);
    initTexCompressedOnly({
      wasmNs: { surface_meta_sync: () => "", pack_pvw_blocks: () => new Uint8Array(0), pack_texref: () => -1 },
      controller: { armed: true },
    });
  };
  const makeNode = (map) => {
    const mat = new THREE.MeshStandardMaterial({ map });
    mat.userData = { __pvwRsId: RS, __texFullPending: true, surfaceDid: 0x08000007 };
    const n = new THREE.Mesh(quadGeometry(), mat);
    n.userData = { landblockId: 0x11223344 };
    return n;
  };
  const scene3d = { staticsGroup: new THREE.Group() };

  // DEFAULT arm: preview-commit.
  arm("?texCompressedOnly=on");
  _resetStatAtlasForTest();
  const pvwTex = makeBc7Texture(parseHbc7(makeHbc7(16, 16, 0x10)));
  const node = makeNode(pvwTex);
  const { passthrough } = addSingletonsToCrossLbAtlas([node], scene3d);
  const stats = _statAtlasStatsForTest();
  check("preview-born node COMMITS (not deferred)", stats.atlased === 1 && passthrough.length === 0);
  const buckets = _statAtlasBucketsForTest();
  const previewKey = [...buckets.keys()].find((k) => k.startsWith("16x16|"));
  check("committed at preview dims (16x16 bucket)", !!previewKey);
  check("bucket is chain-mode", previewKey && buckets.get(previewKey).bm.userData.diffArray.mipmaps.length > 1);

  // Upgrade lands: map re-points to full dims, pending clears, refeed fires.
  node.material.map = makeBc7Texture(parseHbc7(makeHbc7(32, 32, 0x20)));
  delete node.material.userData.__texFullPending;
  node.material.userData.__bc7RsId = RS;
  const n1 = atlasRefeed(RS);
  check("atlasRefeed re-homed 1 member", n1 === 1 && stats.rehomedNodes === 1 && stats.refeeds === 1);
  const fullKey = [...buckets.keys()].find((k) => k.startsWith("32x32|"));
  check("full-dim bucket exists + fed", !!fullKey && stats.atlased === 2);
  const pb = buckets.get(previewKey);
  check("preview bucket emptied", pb.bm.userData.layerOf.size === 0 && pb.bm.userData.gidVerts.size === 0);
  tickStatAtlasOptimize();
  check("empty preview bucket GC'd", !buckets.has(previewKey) && stats.emptyBucketsGCd >= 1);
  check("refeed of unknown rsId is a 0 no-op", atlasRefeed(0x06009999) === 0);

  // ESCAPE arm: hold-out + refeed commits + scene removal.
  arm("?texCompressedOnly=on&atlasPreviewCommit=off");
  _resetStatAtlasForTest();
  const node2 = makeNode(makeBc7Texture(parseHbc7(makeHbc7(16, 16, 0x30))));
  const r2 = addSingletonsToCrossLbAtlas([node2], scene3d);
  const stats2 = _statAtlasStatsForTest();
  check("escape arm holds out (passthrough + tracked)",
    r2.passthrough.length === 1 && stats2.ptFullHoldout === 1 && stats2.atlased === 0);
  scene3d.staticsGroup.add(node2); // the caller's contract for passthrough
  node2.material.map = makeBc7Texture(parseHbc7(makeHbc7(32, 32, 0x31)));
  delete node2.material.userData.__texFullPending;
  node2.material.userData.__bc7RsId = RS;
  check("escape-arm refeed commits the held node", atlasRefeed(RS) === 1 && stats2.atlased === 1);
  check("committed singleton left the scene", node2.parent === null);

  // OFF-arm sanity: flag absent ⇒ defer/commit shape unchanged, no tracking.
  arm("");
  _resetStatAtlasForTest();
  const node3 = makeNode(makeBc7Texture(parseHbc7(makeHbc7(16, 16, 0x50))));
  addSingletonsToCrossLbAtlas([node3], scene3d);
  const stats3 = _statAtlasStatsForTest();
  check("OFF arm: commits (no __bc7Pending), zero ST5 counters",
    stats3.atlased === 1 && stats3.ptFullHoldout === 0 && stats3.refeeds === 0);
  check("OFF arm: bucket is LEVEL-0-ONLY (byte-identical legacy)",
    [..._statAtlasBucketsForTest().values()][0].bm.userData.diffArray.mipmaps.length === 1);
  check("OFF arm: refeed no-ops", atlasRefeed(RS) === 0);
  _resetStatAtlasForTest();
  _resetBc7ForTest();
  _resetTexCompressedOnlyForTest();
}

// ===========================================================================
console.log("PART 7 — materials vertical: PVW build, lane-T upgrade, demote");
// ===========================================================================
{
  const RS = 0x06002222;
  const DID = 0x08000042;
  const pvwPayload = makeHbc7(16, 16, 0x60);
  const fullPayload = makeHbc7(32, 32, 0x70);

  const laneCalls = [];
  const makeNs = () => ({
    surface_meta_sync: (d) =>
      d === DID
        ? JSON.stringify({
            kind: "textured", surfaceType: 0, translucency: 0, luminosity: 0,
            diffuse: 0, rsId: RS, palId: 0, aliased: false, category: null,
            roughnessOverride: null, normalScaleOverride: null,
          })
        : "",
    pack_texref: (rs) => (rs === RS ? ((0b11 << 8) | 0x55) : -1),
    pack_pvw_blocks: (rs) => (rs === RS ? pvwPayload.slice() : new Uint8Array(0)),
    xu7_cas_info: async (rs) =>
      rs === RS ? JSON.stringify({ url: "http://h/shards/ab/abcd1234.bin", sha16: "ab".repeat(16) }) : "",
  });

  // Mock texture worker: answers any xu7 job with the FULL fixture chain
  // (+ NRA rider when asked) — the T14 mock-worker pattern.
  class MockWorker {
    constructor() { this.onmessage = null; }
    postMessage(msg) {
      if (msg.type === "init") {
        queueMicrotask(() => this.onmessage && this.onmessage({ data: { type: "ready" } }));
        return;
      }
      if (msg.type === "job" && msg.kind === "xu7") {
        const parsed = parseHbc7(fullPayload);
        const levelBytes = parsed.levels.map((l) => l.data.length);
        const total = levelBytes.reduce((a, b) => a + b, 0);
        const bc7 = new Uint8Array(total);
        let off = 0;
        for (const l of parsed.levels) { bc7.set(l.data, off); off += l.data.length; }
        const nw = 16, nh = 16;
        const reply = {
          type: "result", seq: msg.seq, ok: true, kind: "xu7",
          width: parsed.width, height: parsed.height, levelBytes,
          bc7: bc7.buffer, transcodeMs: 1,
          nra: msg.want && msg.want.nra ? { width: nw, height: nh, plane: new Uint8Array(nw * nh * 4).fill(128).buffer } : null,
        };
        queueMicrotask(() => this.onmessage && this.onmessage({ data: reply }));
      }
    }
    terminate() {}
  }

  const armAll = () => {
    _resetBc7ForTest();
    _resetTexCompressedOnlyForTest();
    _resetTexWorkerForTest();
    setSearch("?texCompressedOnly=on&texWorkers=on");
    _setBc7SupportForTest(true);
    initBc7Source({});
    _setTexWorkerFactoryForTest(() => new MockWorker());
  };

  // Success leg.
  armAll();
  laneCalls.length = 0;
  const controller = {
    armed: true,
    need: async (url, opts) => {
      laneCalls.push({ url, lane: opts.lane, component: opts.component, hash: opts.expectedHash });
      return new Uint8Array([9, 9, 9]).buffer; // opaque wire bytes (worker is mocked)
    },
  };
  initTexCompressedOnly({ wasmNs: makeNs(), controller });
  let refeedRs = null;
  registerAtlasRefeed((rs) => { refeedRs = rs; return 1; });

  const mc = new MaterialCache();
  mc.normalMapsEnabled = true;
  let legacyCalled = 0;
  const legacyFetch = async () => { legacyCalled += 1; return [null]; };
  const mat = await mc.get(DID, legacyFetch);
  check("material built WITHOUT legacy pixel fetch", legacyCalled === 0);
  check("frame-1 map is the BC7 preview (16x16, full chain)",
    mat.map && mat.map.isCompressedTexture && mat.map.image.width === 16 && mat.map.mipmaps.length === 5);
  check("pvwBuilds counted + rsId stamped",
    bc7Stats().pvwBuilds === 1 && mat.userData.__pvwRsId === RS);
  check("cache-resident (get returns same object)", (await mc.get(DID, legacyFetch)) === mat);

  // Let the async upgrade settle (worker mock answers in microtasks; the
  // controller + JSON hops need a few macrotask turns).
  await new Promise((r) => setTimeout(r, 50));
  check("lane-T fetch went through the controller",
    laneCalls.length === 1 && laneCalls[0].lane === "T" && laneCalls[0].component === "texFull" &&
      laneCalls[0].hash === "ab".repeat(16), JSON.stringify(laneCalls));
  check("full tier swapped in (32x32)", mat.map.image.width === 32 && mat.userData.__bc7 === true);
  check("fullSwaps counted, pending cleared",
    bc7Stats().fullSwaps === 1 && mat.userData.__texFullPending === undefined);
  check("worker NRA attached as normalMap", !!mat.normalMap && bc7Stats().nraAttached === 1);
  check("atlasRefeed fired with the rsId", refeedRs === RS);
  check("record adopted into the budgeted cache", (bc7Source()?.recordCacheStats().records ?? 0) === 1);

  // Demote-to-preview primitive.
  const fullTex = mat.map;
  check("demoteToPreview restores the preview",
    mc.demoteToPreview(DID) === true && mat.map.image.width === 16 && mat.map !== fullTex);
  check("demotion counted + record dropped",
    bc7Stats().demotions === 1 && (bc7Source()?.recordCacheStats().records ?? -1) === 0);
  check("demote is idempotent (already at preview → false)", mc.demoteToPreview(DID) === false);

  // texStats surface shape (pass 5 S8).
  const ts = texStats();
  check("__texStats: tiers + coverage present",
    ts.tiers && ts.tiers.pvwHits === 1 && ts.tiers.fullSwaps === 1 && ts.tiers.demotions === 1 &&
      ts.coverage && ts.coverage.texrefMissingPvw === 0);

  // Failure leg: controller rejects ⇒ stays preview, counted, never white.
  armAll();
  const badController = { armed: true, need: async () => { throw new Error("net down"); } };
  const ns2 = makeNs();
  ns2.xu7_blocks = undefined; // no legacy fallback either
  initTexCompressedOnly({ wasmNs: ns2, controller: badController });
  registerAtlasRefeed(null);
  const mc2 = new MaterialCache();
  const mat2 = await mc2.get(DID, legacyFetch);
  await new Promise((r) => setTimeout(r, 50));
  check("failure leg: material KEPT its preview (16x16, never white)",
    mat2.map && mat2.map.isCompressedTexture && mat2.map.image.width === 16);
  check("failure leg: fullFailed counted, no swap", bc7Stats().fullFailed === 1 && bc7Stats().fullSwaps === 0);

  // Substituted-class + no-TEXREF routing: legacy build is used.
  armAll();
  const ns3 = makeNs();
  ns3.surface_meta_sync = () =>
    JSON.stringify({ kind: "textured", surfaceType: 0, translucency: 0, luminosity: 0, diffuse: 0, rsId: RS, palId: 0x04001234, aliased: false });
  initTexCompressedOnly({ wasmNs: ns3, controller });
  const mc3 = new MaterialCache();
  let legacy3 = 0;
  await mc3.get(DID, async () => { legacy3 += 1; return [null]; });
  check("palette-substituted class routes to the LEGACY decode", legacy3 === 1);

  const ns4 = makeNs();
  ns4.pack_texref = () => -1;
  initTexCompressedOnly({ wasmNs: ns4, controller });
  const mc4 = new MaterialCache();
  let legacy4 = 0;
  await mc4.get(DID, async () => { legacy4 += 1; return [null]; });
  check("no-TEXREF rsId routes to the LEGACY decode", legacy4 === 1);

  // Missing-PVW leg: counted, warned, legacy-routed (T15 deviation D-*).
  armAll();
  const ns5 = makeNs();
  ns5.pack_pvw_blocks = () => new Uint8Array(0);
  initTexCompressedOnly({ wasmNs: ns5, controller });
  const mc5 = new MaterialCache();
  let legacy5 = 0;
  await mc5.get(DID, async () => { legacy5 += 1; return [null]; });
  check("TEXREF'd-but-no-PVW: counted + legacy-routed",
    bc7Stats().texrefMissingPvw === 1 && legacy5 === 1);

  // OFF arm: the branch is never taken (byte-identical legacy).
  _resetBc7ForTest();
  _resetTexCompressedOnlyForTest();
  _resetTexWorkerForTest();
  setSearch("");
  _setBc7SupportForTest(true);
  const mc6 = new MaterialCache();
  let legacy6 = 0;
  await mc6.get(DID, async () => { legacy6 += 1; return [null]; });
  check("OFF arm: legacy fetch is THE path", legacy6 === 1);
  _resetBc7ForTest();
  _resetTexCompressedOnlyForTest();
  _resetTexWorkerForTest();
}

// ===========================================================================
console.log("PART 8 — T15R: rehydrate-v3 full-tier mirror seam + demote rung");
// ===========================================================================
//   D-05.7 row 2: "full-tier mirror ≡ the record-cache entry … freed WITH
//   record eviction via the release seam", rehydrator = re-fetch xu7 CAS →
//   worker re-transcode (SOURCE-keyed, never a pixel-plane decode).
//   H-05.1 R1: demote-first is the texture rung of the pressure ladder.
{
  const RS = 0x06003333;
  const RS2 = 0x06004444;
  const DID = 0x08000055;
  const DID2 = 0x08000056;
  const pvwPayload = makeHbc7(16, 16, 0x10);
  const fullPayload = makeHbc7(64, 64, 0x20);

  class MockWorker {
    constructor() { this.onmessage = null; }
    postMessage(msg) {
      if (msg.type === "init") {
        queueMicrotask(() => this.onmessage && this.onmessage({ data: { type: "ready" } }));
        return;
      }
      if (msg.type === "job" && msg.kind === "xu7") {
        const parsed = parseHbc7(fullPayload);
        const levelBytes = parsed.levels.map((l) => l.data.length);
        const bc7 = new Uint8Array(levelBytes.reduce((a, b) => a + b, 0));
        let off = 0;
        for (const l of parsed.levels) { bc7.set(l.data, off); off += l.data.length; }
        queueMicrotask(() => this.onmessage && this.onmessage({
          data: {
            type: "result", seq: msg.seq, ok: true, kind: "xu7",
            width: parsed.width, height: parsed.height, levelBytes,
            bc7: bc7.buffer, transcodeMs: 1, nra: null,
          },
        }));
      }
    }
    terminate() {}
  }

  const metaFor = (d, rs) => JSON.stringify({
    kind: "textured", surfaceType: 0, translucency: 0, luminosity: 0,
    diffuse: 0, rsId: rs, palId: 0, aliased: false, category: null,
    roughnessOverride: null, normalScaleOverride: null,
  });
  const makeNs = () => ({
    surface_meta_sync: (d) => (d === DID ? metaFor(d, RS) : d === DID2 ? metaFor(d, RS2) : ""),
    pack_texref: (rs) => (rs === RS || rs === RS2 ? ((0b11 << 8) | 0x66) : -1),
    pack_pvw_blocks: (rs) => (rs === RS || rs === RS2 ? pvwPayload.slice() : new Uint8Array(0)),
    xu7_cas_info: async (rs) =>
      rs === RS || rs === RS2
        ? JSON.stringify({ url: `http://h/shards/ab/${rs.toString(16)}.bin`, sha16: "cd".repeat(16) })
        : "",
  });

  let laneNeeds = 0;
  const controller = {
    armed: true,
    need: async () => { laneNeeds += 1; return new Uint8Array([1, 2, 3]).buffer; },
  };
  const armAll = (search = "?texCompressedOnly=on&texWorkers=on") => {
    _resetBc7ForTest();
    _resetTexCompressedOnlyForTest();
    _resetTexWorkerForTest();
    _resetFullTierMirrorsForTest();
    __resetTextureRehydrateForTests();
    registerAtlasRefeed(null);
    setSearch(search);
    _setBc7SupportForTest(true);
    initBc7Source({});
    _setTexWorkerFactoryForTest(() => new MockWorker());
    initTexCompressedOnly({ wasmNs: makeNs(), controller });
  };

  // ---- arming ------------------------------------------------------------
  armAll();
  const mc = new MaterialCache();
  const mat = await mc.get(DID, async () => [null]);
  await new Promise((r) => setTimeout(r, 50));
  check("upgrade landed (precondition for the seam)",
    bc7Stats().fullSwaps === 1 && mat.map.image.width === 64);
  check("full-tier mirror ARMED by the upgrade", fullTierMirrorStats().armed === 1);
  const fullTex = mat.map;
  const fullBytes = fullTex.mipmaps.reduce((a, m) => a + m.data.byteLength, 0);
  check("mirror bytes are the record's bytes (shared buffer)", fullBytes > 0);

  // ---- POST-UPLOAD ONLY --------------------------------------------------
  check("release REFUSES before three has uploaded (counted, never silent)",
    releaseFullTierMirror(RS) === 0 && texStats().mirrors.release.releaseDeferred === 1 &&
      textureHasPixels(fullTex) === true);
  fullTex.onUpdate(fullTex); // three fires this at the end of uploadTexture
  check("upload watcher armed by registerFullTierMirror", fullTex.__hbUploaded === true);

  // ---- release ------------------------------------------------------------
  const freed = releaseFullTierMirror(RS);
  check("release gave the mirror bytes back", freed === fullBytes && freed > 0);
  check("levels are empty but the DESCRIPTOR is intact (re-supply, not re-spec)",
    fullTex.mipmaps.every((m) => m.data.byteLength === 0) &&
      fullTex.mipmaps[0].width === 64 && fullTex.mipmaps.length === 7);
  check("registry now sees NO pixels (the loud-miss predicate)", textureHasPixels(fullTex) === false);
  check("way back registered BEFORE the bytes went (ordering rule)",
    releasedTextureCount() === 1);
  const rel = texStats().mirrors.release;
  check("release counted on __texStats().mirrors.release",
    rel.freed === 1 && rel.bytesFreed === freed && rel.released === 1 && rel.armed === 1);
  check("release is idempotent", releaseFullTierMirror(RS) === 0);

  // ---- rehydrate (source-keyed: re-fetch CAS → re-transcode) -------------
  const needsBefore = laneNeeds;
  const pass = await rehydrateReleasedTextures({ reason: "test", timeoutMs: 5000 });
  check("restore pass rehydrated the released mirror",
    pass.rehydrated === 1 && pass.failed === 0, JSON.stringify(pass));
  check("pixels are back at the right dims", textureHasPixels(fullTex) === true &&
    fullTex.mipmaps[0].data.byteLength === bc7LevelBytes(64, 64));
  check("rehydrator re-fetched the SOURCE (lane-T need fired again)",
    laneNeeds === needsBefore + 1);
  check("restore counted, zero misses",
    texStats().mirrors.release.restores === 1 && texStats().mirrors.release.restoreFailed === 0);
  check("restored mirror re-adopted into the budgeted record cache",
    (bc7Source()?.recordCacheStats().records ?? 0) >= 1);

  // ---- eviction drives the release (the D-05.7 identity) -----------------
  armAll("?texCompressedOnly=on&texWorkers=on&bc7RecordsMB=1");
  const mcE = new MaterialCache();
  const matE = await mcE.get(DID, async () => [null]);
  await new Promise((r) => setTimeout(r, 50));
  matE.map.onUpdate(matE.map); // uploaded
  const src = bc7Source();
  // Push the budget over with an unrelated record: the LRU evicts the full
  // tier first (oldest), and the eviction must free the mirror too.
  src.adoptParsed(0x06009999, parseHbc7(makeHbc7(1024, 1024, 0x40)));
  src.adoptParsed(0x0600999a, parseHbc7(makeHbc7(1024, 1024, 0x41)));
  const relE = texStats().mirrors.release;
  check("record eviction RELEASED the mirror (budget frees real bytes now)",
    relE.freed === 1 && relE.bytesFreed > 0, JSON.stringify(relE));
  check("evicted-and-released texture still has a way back",
    releasedTextureCount() === 1 && textureHasPixels(matE.map) === false);

  // ---- demote rung --------------------------------------------------------
  armAll();
  const mcD = new MaterialCache();
  // Settle the upgrades ONE AT A TIME: `_fullTierDids` order is upgrade
  // order, and two concurrent worker jobs can land in either sequence.
  const matD1 = await mcD.get(DID, async () => [null]);
  await new Promise((r) => setTimeout(r, 50));
  const matD2 = await mcD.get(DID2, async () => [null]);
  await new Promise((r) => setTimeout(r, 50));
  check("two full tiers resident", bc7Stats().fullSwaps === 2 &&
    matD1.map.image.width === 64 && matD2.map.image.width === 64);
  const r1 = mcD.demoteFullTierUnderPressure({ max: 1 });
  check("demote rung sheds OLDEST-first, one at a time",
    r1.demoted === 1 && r1.bytesFreed > 0 && r1.remaining === 1 &&
      matD1.map.image.width === 16 && matD2.map.image.width === 64, JSON.stringify(r1));
  check("demoted surface kept correct pixels (sharpness, never blackness)",
    matD1.map.isCompressedTexture && matD1.map.mipmaps[0].data.byteLength > 0);
  check("demote unregistered the mirror with the disposed texture",
    fullTierMirrorStats().armed === 1);
  const r2 = mcD.demoteFullTierUnderPressure({ bytes: 1 });
  check("byte target stops the walk once met",
    r2.demoted === 1 && r2.remaining === 0 && fullTierMirrorStats().armed === 0);
  check("nothing left to demote ⇒ no-op", mcD.demoteFullTierUnderPressure().demoted === 0);

  // ---- OFF arm ------------------------------------------------------------
  _resetBc7ForTest();
  _resetTexCompressedOnlyForTest();
  _resetTexWorkerForTest();
  _resetFullTierMirrorsForTest();
  __resetTextureRehydrateForTests();
  setSearch("");
  _setBc7SupportForTest(true);
  const legacySrc = new Bc7RecordSource({ fetchImpl: async () => null, budgetBytes: 4096 });
  legacySrc.adoptParsed(0x0600aaaa, parseHbc7(makeHbc7(32, 32, 0x50)));
  legacySrc.adoptParsed(0x0600aaab, parseHbc7(makeHbc7(32, 32, 0x51)));
  legacySrc.adoptParsed(0x0600aaac, parseHbc7(makeHbc7(32, 32, 0x52)));
  const st = legacySrc.recordCacheStats();
  check("OFF arm: eviction behaves exactly as before (no mirrors exist)",
    st.evictions > 0 && bc7Stats().mirrorsFreed === 0 && releasedTextureCount() === 0);
  check("OFF arm: mirror registry stays empty", fullTierMirrorStats().armed === 0);
  check("unregisterFullTierMirror on an unknown rsId is a no-op",
    unregisterFullTierMirror(0x06000001) === false);
  check("registerFullTierMirror refuses a texture with no levels",
    registerFullTierMirror(RS, { mipmaps: [] }, async () => null) === false);

  _resetBc7ForTest();
  _resetTexCompressedOnlyForTest();
  _resetTexWorkerForTest();
  _resetFullTierMirrorsForTest();
  __resetTextureRehydrateForTests();
}

console.log(`\nTEX-COMPRESSED-ONLY ${failed === 0 ? "✅" : "❌"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
