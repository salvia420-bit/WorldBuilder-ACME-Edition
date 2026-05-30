// Task 3B — SoA vs AoS wasm-export parity test for the 13x13 Holtburg ring.
//
// Proves that `fetch_landblock_objects_soa`, `fetch_landblock_scenery_soa`,
// and `fetch_landblock_spawns_soa` return byte-equivalent data to their
// per-record (AoS) counterparts when reassembled into AoS form.
//
// For each of 169 LBs in the ring 0xA3AE..0xAFBA (x in 0xA3..0xAF,
// y in 0xAE..0xBA), this test:
//   1. Calls the AoS export once with [cellId] → array of wasm-bindgen
//      class instances (ObjectPlacement / ScenicPlacementJs / EntitySpawnJs).
//   2. Calls the SoA export once with the same [cellId] → a single
//      bulk struct with parallel typed arrays.
//   3. Reassembles the SoA struct into the same per-record JS shape by
//      walking each parallel array index.
//   4. Sorts both arrays canonically + serializes to JSON with sorted
//      keys + sha256-hashes the JSON strings.
//   5. Asserts the two hashes are equal.
//
// All 169 LBs * 3 exports = 507 comparisons must pass.
//
// Run from apps/holtburger-web/:
//   node tests/soa_aos_parity.test.cjs
//
// Exits 0 on full pass, 1 on any mismatch.

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');

const wasm = require('../pkg-node/holtburger_web.js');

// Default to the canonical 1070-machine bake location. Can be overridden
// via the `HOLTBURGER_DIST_V2_MANIFEST` env var which, if set, MUST point
// at the absolute path of a `manifest.json` file inside an alternate
// baked v2 dist tree (the test will use the manifest's parent dir as
// DIST_DIR). When neither the default DIST_DIR nor the env override
// resolves to a present manifest, the test exits 0 with a SKIP message —
// this lets `node tests/soa_aos_parity.test.cjs` run cleanly in a
// standard dev env that hasn't run the `dat-shard` v2 pipeline.
//
// Populate the fixture by running the v2 dist bake (see external dist
// pipeline notes); or point at an alternate bake via:
//   HOLTBURGER_DIST_V2_MANIFEST=/path/to/manifest.json node tests/soa_aos_parity.test.cjs
const DIST_MANIFEST_ENV = process.env.HOLTBURGER_DIST_V2_MANIFEST;
const DIST_DIR = DIST_MANIFEST_ENV
  ? path.dirname(DIST_MANIFEST_ENV)
  : (process.env.HOLTBURGER_DIST || '/mnt/wbterminal2/holtburger-dist');

const RING_MIN_X = 0xA3;
const RING_MAX_X = 0xAF;
const RING_MIN_Y = 0xAE;
const RING_MAX_Y = 0xBA;

function lbCellIdFromXY(lbX, lbY) {
  return (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16) | 0xFFFE) >>> 0;
}

function lbHex(lbX, lbY) {
  return `0x${((lbX << 8) | lbY).toString(16).toUpperCase().padStart(4, '0')}`;
}

function ringLbList() {
  const out = [];
  for (let x = RING_MIN_X; x <= RING_MAX_X; x += 1) {
    for (let y = RING_MIN_Y; y <= RING_MAX_Y; y += 1) {
      out.push({ lbX: x, lbY: y });
    }
  }
  return out;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`non-finite number in canonical JSON: ${value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
  return `{${parts.join(',')}}`;
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function contentTypeFor(p) {
  if (p.endsWith('.json')) return 'application/json; charset=utf-8';
  if (p.endsWith('.jsonl')) return 'application/jsonl; charset=utf-8';
  if (p.endsWith('.sha256')) return 'text/plain; charset=utf-8';
  if (p.endsWith('.bin')) return 'application/octet-stream';
  if (p.endsWith('.hba')) return 'application/octet-stream';
  return 'application/octet-stream';
}

function makeServer() {
  return http.createServer((req, res) => {
    let url;
    try {
      url = decodeURIComponent(req.url.split('?')[0]);
    } catch (_e) {
      res.writeHead(400).end();
      return;
    }
    res.setHeader('Connection', 'close');
    const stripped = url.replace(/^\/+/, '');
    const filePath = path.join(DIST_DIR, stripped);
    if (!filePath.startsWith(DIST_DIR)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'content-type': contentTypeFor(filePath),
        'content-length': data.length,
      });
      res.end(data);
    });
  });
}

// Canonical AoS-vs-SoA equivalence for objects.
//
// Both paths originate from the SAME `LandblockInfo.unpack` output and
// the SAME quaternion → yaw extraction in Rust (`frame_to_placement` for
// AoS, `frame_yaw_quaternion` for SoA — both run the same `atan2`).
// AoS then stores the yaw scalar as f32; SoA then encodes the f32 yaw
// as a f32 yaw-only quaternion `(cos(yaw/2), 0, 0, sin(yaw/2))`.
//
// To compare byte-for-byte we need to put both sides through the SAME
// representational pipeline. We pick the f32 yaw-only quaternion as the
// canonical form (lossless for SoA, requires one trig step for AoS) and
// quantize every floating field to its 4-byte f32 bit pattern hex string
// before hashing. f32 quantization removes JS's f64-vs-Rust-f32 drift
// (e.g. JS `Math.cos(yaw_f32 / 2)` yields f64, but `Math.fround()` round-
// trips to the closest f32 the wasm side actually stored).
function f32HexBytes(v) {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = v;
  const u8 = new Uint8Array(buf);
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

function yawToF32YawQuat(yawF32) {
  // Mirror Rust's `frame_yaw_quaternion`: half = yaw * 0.5; emit
  // (cos(half), 0, 0, sin(half)). Force each step through f32 so the
  // bit-pattern matches what wasm stored in the SoA arrays. Rust runs
  // cos/sin/mul natively on f32; JS runs them on f64 then quantises
  // back via `Math.fround` to the nearest f32.
  const yaw32 = Math.fround(yawF32);
  const half32 = Math.fround(yaw32 * 0.5);
  const qw = Math.fround(Math.cos(half32));
  const qz = Math.fround(Math.sin(half32));
  return { qw, qx: 0, qy: 0, qz };
}

function aosObjectsToCanonical(aos) {
  return aos.map((p) => {
    const q = yawToF32YawQuat(p.rotationZ);
    return {
      landblockId: p.landblockId >>> 0,
      modelId: p.modelId >>> 0,
      x: f32HexBytes(p.x),
      y: f32HexBytes(p.y),
      z: f32HexBytes(p.z),
      qw: f32HexBytes(q.qw),
      qx: f32HexBytes(q.qx),
      qy: f32HexBytes(q.qy),
      qz: f32HexBytes(q.qz),
      isBuilding: !!p.isBuilding,
    };
  });
}

function soaObjectsToCanonical(soa) {
  const out = [];
  const len = soa.len;
  const modelIds = soa.modelIds;
  const landblockIds = soa.landblockIds;
  const positions = soa.positions;
  const quaternions = soa.quaternions;
  const isBuilding = soa.isBuilding;
  for (let i = 0; i < len; i += 1) {
    out.push({
      landblockId: landblockIds[i] >>> 0,
      modelId: modelIds[i] >>> 0,
      x: f32HexBytes(positions[i * 3]),
      y: f32HexBytes(positions[i * 3 + 1]),
      z: f32HexBytes(positions[i * 3 + 2]),
      qw: f32HexBytes(quaternions[i * 4]),
      qx: f32HexBytes(quaternions[i * 4 + 1]),
      qy: f32HexBytes(quaternions[i * 4 + 2]),
      qz: f32HexBytes(quaternions[i * 4 + 3]),
      isBuilding: isBuilding[i] !== 0,
    });
  }
  return out;
}

function aosSceneryToCanonical(aos) {
  return aos.map((p) => ({
    objId: p.objId >>> 0,
    landblockId: p.landblockId >>> 0,
    x: f32HexBytes(p.x),
    y: f32HexBytes(p.y),
    z: f32HexBytes(p.z),
    qw: f32HexBytes(p.qw),
    qx: f32HexBytes(p.qx),
    qy: f32HexBytes(p.qy),
    qz: f32HexBytes(p.qz),
    scale: f32HexBytes(p.scale),
    sourceCellX: p.sourceCellX >>> 0,
    sourceCellY: p.sourceCellY >>> 0,
    sourceObjIdx: p.sourceObjIdx >>> 0,
  }));
}

function soaSceneryToCanonical(soa) {
  const out = [];
  const len = soa.len;
  const objIds = soa.objIds;
  const landblockIds = soa.landblockIds;
  const positions = soa.positions;
  const quaternions = soa.quaternions;
  const scales = soa.scales;
  const sourceCellX = soa.sourceCellX;
  const sourceCellY = soa.sourceCellY;
  const sourceObjIdx = soa.sourceObjIdx;
  for (let i = 0; i < len; i += 1) {
    out.push({
      objId: objIds[i] >>> 0,
      landblockId: landblockIds[i] >>> 0,
      x: f32HexBytes(positions[i * 3]),
      y: f32HexBytes(positions[i * 3 + 1]),
      z: f32HexBytes(positions[i * 3 + 2]),
      qw: f32HexBytes(quaternions[i * 4]),
      qx: f32HexBytes(quaternions[i * 4 + 1]),
      qy: f32HexBytes(quaternions[i * 4 + 2]),
      qz: f32HexBytes(quaternions[i * 4 + 3]),
      scale: f32HexBytes(scales[i]),
      sourceCellX: sourceCellX[i] >>> 0,
      sourceCellY: sourceCellY[i] >>> 0,
      sourceObjIdx: sourceObjIdx[i] >>> 0,
    });
  }
  return out;
}

function aosSpawnsToCanonical(aos) {
  return aos.map((p) => ({
    wcid: p.wcid >>> 0,
    weenieType: p.weenieType >>> 0,
    landblockId: p.landblockId >>> 0,
    cell: p.cell >>> 0,
    x: f32HexBytes(p.x),
    y: f32HexBytes(p.y),
    z: f32HexBytes(p.z),
    qw: f32HexBytes(p.qw),
    qx: f32HexBytes(p.qx),
    qy: f32HexBytes(p.qy),
    qz: f32HexBytes(p.qz),
    isServerManaged: !!p.isServerManaged,
    name: p.name,
  }));
}

function soaSpawnsToCanonical(soa) {
  const out = [];
  const len = soa.len;
  const wcids = soa.wcids;
  const weenieTypes = soa.weenieTypes;
  const landblockIds = soa.landblockIds;
  const cells = soa.cells;
  const positions = soa.positions;
  const quaternions = soa.quaternions;
  const isServerManaged = soa.isServerManaged;
  const names = soa.names;
  for (let i = 0; i < len; i += 1) {
    out.push({
      wcid: wcids[i] >>> 0,
      weenieType: weenieTypes[i] >>> 0,
      landblockId: landblockIds[i] >>> 0,
      cell: cells[i] >>> 0,
      x: f32HexBytes(positions[i * 3]),
      y: f32HexBytes(positions[i * 3 + 1]),
      z: f32HexBytes(positions[i * 3 + 2]),
      qw: f32HexBytes(quaternions[i * 4]),
      qx: f32HexBytes(quaternions[i * 4 + 1]),
      qy: f32HexBytes(quaternions[i * 4 + 2]),
      qz: f32HexBytes(quaternions[i * 4 + 3]),
      isServerManaged: isServerManaged[i] !== 0,
      name: names[i],
    });
  }
  return out;
}

function strCmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortObjects(arr) {
  return arr.slice().sort((a, b) => {
    if (a.modelId !== b.modelId) return a.modelId - b.modelId;
    if (a.isBuilding !== b.isBuilding) return a.isBuilding ? 1 : -1;
    if (a.x !== b.x) return strCmp(a.x, b.x);
    if (a.y !== b.y) return strCmp(a.y, b.y);
    if (a.z !== b.z) return strCmp(a.z, b.z);
    return strCmp(a.qz, b.qz);
  });
}

function sortScenery(arr) {
  return arr.slice().sort((a, b) => {
    if (a.objId !== b.objId) return a.objId - b.objId;
    if (a.x !== b.x) return strCmp(a.x, b.x);
    if (a.y !== b.y) return strCmp(a.y, b.y);
    if (a.z !== b.z) return strCmp(a.z, b.z);
    if (a.sourceCellX !== b.sourceCellX) return a.sourceCellX - b.sourceCellX;
    if (a.sourceCellY !== b.sourceCellY) return a.sourceCellY - b.sourceCellY;
    return a.sourceObjIdx - b.sourceObjIdx;
  });
}

function sortSpawns(arr) {
  return arr.slice().sort((a, b) => {
    if (a.wcid !== b.wcid) return a.wcid - b.wcid;
    if (a.cell !== b.cell) return a.cell - b.cell;
    if (a.x !== b.x) return strCmp(a.x, b.x);
    if (a.y !== b.y) return strCmp(a.y, b.y);
    if (a.z !== b.z) return strCmp(a.z, b.z);
    return strCmp(a.name, b.name);
  });
}

function freeAll(items) {
  for (const it of items) {
    try { it.free(); } catch (_e) { /* tolerated */ }
  }
}

function diffSnippet(aosCanon, soaCanon, limit = 3) {
  const diffs = [];
  const max = Math.max(aosCanon.length, soaCanon.length);
  for (let i = 0; i < max && diffs.length < limit; i += 1) {
    const a = aosCanon[i];
    const s = soaCanon[i];
    const aJ = a === undefined ? '<missing>' : canonicalJson(a);
    const sJ = s === undefined ? '<missing>' : canonicalJson(s);
    if (aJ !== sJ) {
      diffs.push({ index: i, aos: aJ, soa: sJ });
    }
  }
  return diffs;
}

(async () => {
  const t0 = Date.now();
  console.log('==================================================');
  console.log('Task 3B — SoA vs AoS wasm-export parity (169 LBs)');
  console.log('==================================================');

  // Guard on env-file presence: this test depends on a baked v2 dist
  // tree (~4.7 GB) that lives outside the repo. In a standard dev env
  // without the bake, exit 0 with a clear SKIP message instead of
  // failing. CI / 1070 machines that have the bake (or supply the env
  // override) will run the full 169 LB * 3 export comparison normally.
  const manifestPath = path.join(DIST_DIR, 'manifest.json');
  const sceneryPath = path.join(DIST_DIR, 'scenery');
  const spawnsPath = path.join(DIST_DIR, 'spawns');
  const missing = [];
  if (!fs.existsSync(manifestPath)) missing.push(manifestPath);
  if (!fs.existsSync(sceneryPath)) missing.push(`${sceneryPath}/`);
  if (!fs.existsSync(spawnsPath)) missing.push(`${spawnsPath}/`);
  if (missing.length > 0) {
    console.log('--------------------------------------------------');
    console.log(`SKIP: holtburger-dist-v2 not present at ${DIST_DIR}`);
    console.log(`      missing: ${missing.join(', ')}`);
    if (DIST_MANIFEST_ENV) {
      console.log(`      (HOLTBURGER_DIST_V2_MANIFEST=${DIST_MANIFEST_ENV})`);
    } else {
      console.log(`      run the dat-shard v2 pipeline to populate the dist`);
      console.log(`      tree, or point HOLTBURGER_DIST_V2_MANIFEST at an`);
      console.log(`      alternate manifest.json to enable this test.`);
    }
    process.exit(0);
  }

  const server = makeServer();
  server.keepAliveTimeout = 0;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const manifestUrl = `${baseUrl}/manifest.json`;
  const sceneryBaseUrl = `${baseUrl}/scenery/`;
  const spawnsBaseUrl = `${baseUrl}/spawns/`;
  console.log(`dev server: ${baseUrl}`);
  console.log(`manifest:   ${manifestUrl}`);

  try {
    await wasm.init_resource_source(manifestUrl);
    if (!wasm.has_resource_source()) {
      console.error('FAIL: init_resource_source returned but has_resource_source()=false');
      server.close();
      process.exit(1);
    }
    console.log(`manifest_version() = ${wasm.manifest_version()}`);
    wasm.init_scenery_base_url(sceneryBaseUrl);
    wasm.init_spawns_base_url(spawnsBaseUrl);
  } catch (e) {
    console.error('FAIL: wasm init threw:', e?.message ?? e);
    server.close();
    process.exit(1);
  }

  const lbs = ringLbList();
  console.log(`ring: ${lbs.length} LBs (${lbHex(RING_MIN_X, RING_MIN_Y)}..${lbHex(RING_MAX_X, RING_MAX_Y)})`);

  let totalObjects = 0;
  let totalScenery = 0;
  let totalSpawns = 0;
  let totalComparisons = 0;
  let mismatches = 0;
  const firstMismatchDiffs = [];

  for (const { lbX, lbY } of lbs) {
    const cellId = lbCellIdFromXY(lbX, lbY);
    const cellIds = new Uint32Array([cellId]);
    const hex = lbHex(lbX, lbY);

    const aosObjs = await wasm.fetch_landblock_objects(cellIds);
    const soaObjs = await wasm.fetch_landblock_objects_soa(cellIds);
    const aosObjsCanon = sortObjects(aosObjectsToCanonical(aosObjs));
    const soaObjsCanon = sortObjects(soaObjectsToCanonical(soaObjs));
    const aosObjsJson = canonicalJson(aosObjsCanon);
    const soaObjsJson = canonicalJson(soaObjsCanon);
    const aosObjsHash = sha256Hex(aosObjsJson);
    const soaObjsHash = sha256Hex(soaObjsJson);
    totalComparisons += 1;
    totalObjects += aosObjsCanon.length;
    if (aosObjsHash !== soaObjsHash) {
      mismatches += 1;
      if (firstMismatchDiffs.length < 5) {
        firstMismatchDiffs.push({
          lb: hex,
          export: 'objects',
          aosLen: aosObjsCanon.length,
          soaLen: soaObjsCanon.length,
          aosHash: aosObjsHash,
          soaHash: soaObjsHash,
          diffs: diffSnippet(aosObjsCanon, soaObjsCanon),
        });
      }
    }
    freeAll(aosObjs);
    soaObjs.free();

    const aosScn = await wasm.fetch_landblock_scenery(cellIds);
    const soaScn = await wasm.fetch_landblock_scenery_soa(cellIds);
    const aosScnCanon = sortScenery(aosSceneryToCanonical(aosScn));
    const soaScnCanon = sortScenery(soaSceneryToCanonical(soaScn));
    const aosScnJson = canonicalJson(aosScnCanon);
    const soaScnJson = canonicalJson(soaScnCanon);
    const aosScnHash = sha256Hex(aosScnJson);
    const soaScnHash = sha256Hex(soaScnJson);
    totalComparisons += 1;
    totalScenery += aosScnCanon.length;
    if (aosScnHash !== soaScnHash) {
      mismatches += 1;
      if (firstMismatchDiffs.length < 5) {
        firstMismatchDiffs.push({
          lb: hex,
          export: 'scenery',
          aosLen: aosScnCanon.length,
          soaLen: soaScnCanon.length,
          aosHash: aosScnHash,
          soaHash: soaScnHash,
          diffs: diffSnippet(aosScnCanon, soaScnCanon),
        });
      }
    }
    freeAll(aosScn);
    soaScn.free();

    const aosSp = await wasm.fetch_landblock_spawns(cellIds);
    const soaSp = await wasm.fetch_landblock_spawns_soa(cellIds);
    const aosSpCanon = sortSpawns(aosSpawnsToCanonical(aosSp));
    const soaSpCanon = sortSpawns(soaSpawnsToCanonical(soaSp));
    const aosSpJson = canonicalJson(aosSpCanon);
    const soaSpJson = canonicalJson(soaSpCanon);
    const aosSpHash = sha256Hex(aosSpJson);
    const soaSpHash = sha256Hex(soaSpJson);
    totalComparisons += 1;
    totalSpawns += aosSpCanon.length;
    if (aosSpHash !== soaSpHash) {
      mismatches += 1;
      if (firstMismatchDiffs.length < 5) {
        firstMismatchDiffs.push({
          lb: hex,
          export: 'spawns',
          aosLen: aosSpCanon.length,
          soaLen: soaSpCanon.length,
          aosHash: aosSpHash,
          soaHash: soaSpHash,
          diffs: diffSnippet(aosSpCanon, soaSpCanon),
        });
      }
    }
    freeAll(aosSp);
    soaSp.free();
  }

  const elapsedMs = Date.now() - t0;

  console.log('--------------------------------------------------');
  console.log('Summary');
  console.log('--------------------------------------------------');
  console.log(`comparisons:        ${totalComparisons} (169 LBs * 3 exports = ${169 * 3})`);
  console.log(`mismatches:         ${mismatches}`);
  console.log(`total objects:      ${totalObjects}`);
  console.log(`total scenery:      ${totalScenery}`);
  console.log(`total spawns:       ${totalSpawns}`);
  console.log(`elapsed:            ${(elapsedMs / 1000).toFixed(2)} s`);

  if (mismatches > 0) {
    console.log('--------------------------------------------------');
    console.log(`FAIL: ${mismatches} hash mismatch(es). First ${firstMismatchDiffs.length}:`);
    for (const m of firstMismatchDiffs) {
      console.log(`  [${m.lb}/${m.export}] aosLen=${m.aosLen} soaLen=${m.soaLen}`);
      console.log(`    aosHash=${m.aosHash}`);
      console.log(`    soaHash=${m.soaHash}`);
      for (const d of m.diffs) {
        console.log(`    diff @i=${d.index}:`);
        console.log(`      aos: ${d.aos}`);
        console.log(`      soa: ${d.soa}`);
      }
    }
    server.close();
    process.exit(1);
  }

  console.log('--------------------------------------------------');
  console.log('PASS: all SoA/AoS sha256 hashes match across 169 LBs * 3 exports.');
  server.close();
  process.exit(0);
})().catch((e) => {
  console.error('FAIL: uncaught:', e?.stack ?? e?.message ?? e);
  process.exit(1);
});
