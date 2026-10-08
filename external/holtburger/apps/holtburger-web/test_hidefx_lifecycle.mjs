// HIDEFX (2026-10-07) — `?playEffectLifecycle` regression test: the portal
// "pink bubbles" that never went away.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_hidefx_lifecycle.mjs
//
// Exits non-zero on any failure. Targeted single test (no browser, no wasm,
// no gate) — it drives the SHIPPED `scene3d/play_effect_vfx.js` resolver and
// the REAL `scene3d/particles/owner_registry.js` singleton.
//
// THE BUG (owner, GTX 1070, Coldeve): after portalling out of the Holtburg
// academy (cell 0x860201AD) the local player kept a pink/violet sparkle TRAIL
// for the rest of the session. The log showed PlayScript 0x74 (Hide →
// PhysicsScript 0x33000332, 14 emitters), 0x10 (AttribUpPurple) and 0x8A
// (LevelUp) resolving on the player (0x5006C651, table 0x34000004).
//
// FIXTURES ARE REAL RETAIL BYTES. Every record below was read this session
// straight out of `~/ac_base_dats/client_portal.dat` (btree walk; header at
// 0x140, 62-branch/61-entry nodes, block chains of `blockSize - 4` bytes). If
// that DAT is present on the box this suite re-reads each record and checks it
// is byte-identical to the embedded copy. Record layouts:
//   PhysicsScript (0x33): [u32 id][u32 n]{f64 start_time, u32 hook_type,
//     i32 direction, payload} — payload widths per
//     crates/holtburger-dat/src/file_type/setup_model.rs `AnimationHook::read`
//     (13/26 CreateParticle = 40: emitter_info u32, part u32, Frame origin 3f +
//     quat wxyz 4f, emitter_id u32; 14/15 Destroy/StopParticle = 4: emitter_id;
//     20 Transparent = 12; 2 SoundTable = 4; 21 SoundTweaked = 16).
//   ParticleEmitter (0x32): ACE `ParticleEmitterInfo.Unpack` order (176 bytes).
//
// WHAT IS PROVEN
//   §1 the data: Hide/Hidden create 14 INFINITE emitters (total_particles = 0
//      AND total_seconds = 0) on handles 1000-1013; UnHide is 14 StopParticle
//      hooks on exactly those handles; AttribUpPurple / LevelUp emitters are
//      finite parent-local bursts (cannot be the stuck trail).
//   §2 legacy arm (`?playEffectLifecycle=off`) REPRODUCES the leak: an
//      addEmitter slower than the 2.5 s one-shot reaper attaches after the
//      reaper ran and the 14 infinite emitters run forever (600 s simulated).
//   §3 fixed arm, the owner's sequence: wire Hide → SetState{Hidden} → arrive
//      → SetState{!Hidden}: bubbles persist while hidden (retail pink-bubble
//      state), then the client-local PS_UnHide (retail set_hidden(0)) stops all
//      14 by handle and they drain to ZERO within their lifespan.
//   §4 the reaper hole is closed for non-held one-shots too.
//   §5-§9 backstops + edge cases (aborted teleport, hard cap, NoDraw-only,
//      batched hide+unhide racing the resolve, despawn while held).
//   §10 AttribUpPurple / LevelUp drain on their own through the real resolver.
//   §11 a script handle never stops an unrelated emitter (`scopedOnly`).
//   §12 PLIFECYCLE-1 (`?oneShotDrain`): the one-shot reaper no longer hard-
//      destroys a FINITE emitter (LevelUp's 3.0±0.25 s tail drains past the
//      2.5 s budget), drops the bookkeeping once it is gone, and the `=off`
//      arm reproduces the cut-off; the pure policy + backstop formula.
//   §13 the same policy on the legacy `?particleOwner=off` bookkeeping.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath, join } from "node:path";
import { register } from "node:module";
import { existsSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- "three" → stub (same loader the resolver suite uses) ----------------
const STUB_LOADER_PATH = resolvePath(__dirname, "_three_stub_loader.mjs");
if (!existsSync(STUB_LOADER_PATH) || !existsSync(resolvePath(__dirname, "_three_stub.mjs"))) {
  console.error("missing _three_stub_loader.mjs / _three_stub.mjs (written by test_play_effect_resolver.mjs) — run that suite once first");
  process.exit(1);
}
register(pathToFileURL(STUB_LOADER_PATH).href);

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// Real DAT fixtures
// ===========================================================================
const RECORDS = new Map([
  // 0x33000332: 820 bytes, sha256[0..16]=0c5c2ef0f31ff40f
  [0x33000332, 820, "0c5c2ef0f31ff40f", [
    "320300330f00000000000000000000000d000000000000008c0200320c0000000000000000000000000000000000803f",
    "000000800000000000000000f503000000000000000000000d000000000000008c0200320b0000000000000000000000",
    "000000000000803f000000800000000000000000ee03000000000000000000001400000000000000000000000000803f",
    "0000403f00000000000000000d000000000000008c0200320d0000000000000000000000000000000000803f00000080",
    "0000000000000000ef03000000000000000000000d000000000000008c02003201000000000000000000000000000000",
    "0000803f000000800000000000000000e903000000000000000000000d000000000000008c0200320e00000000000000",
    "00000000000000000000803f000000800000000000000000f003000000000000000000000d000000000000008c020032",
    "050000000000000000000000000000000000803f000000800000000000000000eb03000000000000000000000d000000",
    "000000008c020032100000000000000000000000cdcc4c3e0000803f000000800000000000000000f103000000000000",
    "000000000d000000000000008c020032020000000000000000000000000000000000803f000000800000000000000000",
    "ea03000000000000000000000d000000000000008c020032060000000000000000000000000000000000803f00000080",
    "0000000000000000ec03000000000000000000000d000000000000008b02003200000000000000000000000000000000",
    "0000803f000000800000000000000000e803000000000000000000000d000000000000008c0200320f00000000000000",
    "00000000000000000000803f000000800000000000000000f203000000000000000000000d000000000000008c020032",
    "070000000000000000000000000000000000803f000000800000000000000000f303000000000000000000000d000000",
    "000000008c020032030000000000000000000000000000000000803f000000800000000000000000f403000000000000",
    "000000000d000000000000008c0200320a0000000000000000000000000000000000803f000000800000000000000000",
    "ed030000"
  ].join("")],
  // 0x3300032F: 316 bytes, sha256[0..16]=8de6e25ee2cf4440
  [0x3300032F, 316, "8de6e25ee2cf4440", [
    "2f0300330f00000000000000000000000f00000000000000f503000000000000000000000f00000000000000ee030000",
    "000000000000000014000000000000000000803f000000000000403f00000000000000000f00000000000000ef030000",
    "00000000000000000f00000000000000e903000000000000000000000f00000000000000f00300000000000000000000",
    "0f00000000000000eb03000000000000000000000f00000000000000f103000000000000000000000f00000000000000",
    "ea03000000000000000000000f00000000000000ec03000000000000000000000f00000000000000e803000000000000",
    "000000000f00000000000000f203000000000000000000000f00000000000000f303000000000000000000000f000000",
    "00000000f403000000000000000000000f00000000000000ed030000"
  ].join("")],
  // 0x33000331: 820 bytes, sha256[0..16]=555ee78b5e90a582
  [0x33000331, 820, "555ee78b5e90a582", [
    "310300330f00000000000000000000000d000000000000008c0200320c0000000000000000000000000000000000803f",
    "000000800000000000000000f503000000000000000000000d000000000000008c0200320b0000000000000000000000",
    "000000000000803f000000800000000000000000ee030000000000000000000014000000000000000000803f0000803f",
    "0000000000000000000000000d000000000000008c0200320d0000000000000000000000000000000000803f00000080",
    "0000000000000000ef03000000000000000000000d000000000000008c02003201000000000000000000000000000000",
    "0000803f000000800000000000000000e903000000000000000000000d000000000000008c0200320e00000000000000",
    "00000000000000000000803f000000800000000000000000f003000000000000000000000d000000000000008c020032",
    "050000000000000000000000000000000000803f000000800000000000000000eb03000000000000000000000d000000",
    "000000008c020032100000000000000000000000cdcc4c3e0000803f000000800000000000000000f103000000000000",
    "000000000d000000000000008c020032020000000000000000000000000000000000803f000000800000000000000000",
    "ea03000000000000000000000d000000000000008c020032060000000000000000000000000000000000803f00000080",
    "0000000000000000ec03000000000000000000000d000000000000008b02003200000000000000000000000000000000",
    "0000803f000000800000000000000000e803000000000000000000000d000000000000008c0200320f00000000000000",
    "00000000000000000000803f000000800000000000000000f203000000000000000000000d000000000000008c020032",
    "070000000000000000000000000000000000803f000000800000000000000000f303000000000000000000000d000000",
    "000000008c020032030000000000000000000000000000000000803f000000800000000000000000f403000000000000",
    "000000000d000000000000008c0200320a0000000000000000000000000000000000803f000000800000000000000000",
    "ed030000"
  ].join("")],
  // 0x33000040: 84 bytes, sha256[0..16]=66875c87a88dee33
  [0x33000040, 84, "66875c87a88dee33", [
    "400000330200000000000000000000000d0000000000000048000032ffffffff0000000000000000000000000000803f",
    "000000800000000000000000010000000000000000000000020000000000000052000000"
  ].join("")],
  // 0x330006F7: 208 bytes, sha256[0..16]=a6acb5cad2e75a22
  [0x330006F7, 208, "a6acb5cad2e75a22", [
    "f70600330400000000000000000000000d00000000000000b0030032ffffffff0000000000000000000000000000803f",
    "0000008000000000000000000000000000000000000000000d00000000000000af030032ffffffff0000000000000000",
    "0000c03f0000803f0000008000000000000000000000000000000000000000000d00000000000000ae030032ffffffff",
    "00000000000000000000403f0000803f0000008000000000000000000000000000000000000000001500000000000000",
    "7102000a0000803f000000000000803f"
  ].join("")],
  // 0x3200028C: 176 bytes, sha256[0..16]=1de1a429ffacfdce
  [0x3200028C, 176, "1de1a429ffacfdce", [
    "8c0200320000000001000000020000002c1600012d1600019a9999999999a93f0a000000000000000000000000000000",
    "00000000000000000000e03f000000000000000000000000000000000000803fcdcc4c3dcdcc4c3d0000000000000000",
    "000080bf9a99193fcdcccc3f0000000000000000000000000000003f0000c03f0000000000000000000000000000003f",
    "0000c03f0000803fcdcccc3dcdcccc3d000000000000803f0000803e00000000"
  ].join("")],
  // 0x3200028B: 176 bytes, sha256[0..16]=897a20a49d05fd94
  [0x3200028B, 176, "897a20a49d05fd94", [
    "8b0200320000000001000000020000002c1600012d1600019a9999999999a93f0f000000000000000000000000000000",
    "00000000000000000000e83f0000000000000000000000000000000000000000cdcc4c3dcdcc4c3d0000000000000000",
    "0000803f9a99193fcdcccc3f0000000000000000000000000000003f0000c03f0000000000000000000000000000003f",
    "0000c03f0000803fcdcccc3dcdcccc3d000000000000803f0000803e00000000"
  ].join("")],
  // 0x32000048: 176 bytes, sha256[0..16]=8c009426262d16f3
  [0x32000048, 176, "8c009426262d16f3", [
    "4800003200000000010000000500000074100001731000019a9999999999a93f3c0000003c0000003c00000000000000",
    "000000000000000000000440000000000000e03f000000000000803f0000000000000000000000000000000000000000",
    "0000403f0000003f0000004000008040000080400000003f0000003f000000400000403f0000403f000000000000403f",
    "0000803f0000e03fcdcccc3dcdcccc3d0000803f000000000000000001000000"
  ].join("")],
  // 0x320003AE: 176 bytes, sha256[0..16]=310bb36dcaaccb37
  [0x320003AE, 176, "310bb36dcaaccb37", [
    "ae030032000000000100000002000000a1100001a21000019a9999999999a93f28000000280000002800000000000000",
    "000000000000000000000840000000000000d03f00000000000000000000803fcdcc4c3fcdcc4c3f0000000000000000",
    "0000003f0000003f0000004000008040000080400000003f0000003f000000400000803f0000803f000000000000403f",
    "0000803f00008040cdcccc3dcdcccc3d0000803f000000000000000001000000"
  ].join("")],
  // 0x320003AF: 176 bytes, sha256[0..16]=a7ddebc1ebddac2b
  [0x320003AF, 176, "a7ddebc1ebddac2b", [
    "af03003200000000010000000200000061100001671000019a9999999999a93f28000000280000002800000000000000",
    "000000000000000000000840000000000000d03f00000000000000000000803fcdcc4c3fcdcc4c3f0000000000000000",
    "0000003f0000003f0000004000008040000080400000003f0000003f000000400000803f0000803f000000000000403f",
    "0000803f00008040cdcccc3dcdcccc3d0000803f000000000000000001000000"
  ].join("")],
  // 0x320003B0: 176 bytes, sha256[0..16]=d88d6da9f18937df
  [0x320003B0, 176, "d88d6da9f18937df", [
    "b00300320000000001000000020000005a100001621000019a9999999999a93f28000000280000002800000000000000",
    "000000000000000000000840000000000000d03f00000000000000000000803fcdcc4c3fcdcc4c3f0000000000000000",
    "0000003f0000003f0000004000008040000080400000003f0000003f000000400000803f0000803f000000000000403f",
    "0000803f00008040cdcccc3dcdcccc3d0000803f000000000000000001000000"
  ].join("")],
].map(([did, len, sha, hex]) => [did >>> 0, { len, sha, bytes: Uint8Array.from(Buffer.from(hex, "hex")) }]));

// Player PhysicsScriptTable 0x34000004 rows for the five scripts in the log /
// the set_hidden trio (read from the same DAT: key → [(mod, scriptDid)]).
const TABLE_0x34000004 = {
  id: 0x34000004,
  scripts: {
    [String(0x74)]: [{ mod: 1.0, scriptDid: 0x33000332 }], // Hide
    [String(0x75)]: [{ mod: 1.0, scriptDid: 0x3300032F }], // UnHide
    [String(0x76)]: [{ mod: 1.0, scriptDid: 0x33000331 }], // Hidden
    [String(0x10)]: [ // AttribUpPurple (log: speed 0.400 → mod 0.5 row)
      { mod: 0.0, scriptDid: 0x33000079 },
      { mod: 0.5, scriptDid: 0x33000040 },
      { mod: 1.0, scriptDid: 0x33000041 },
    ],
    [String(0x8A)]: [{ mod: 1.0, scriptDid: 0x330006F7 }], // LevelUp
  },
};
// §4 only: a SYNTHETIC table routing PlayScript 0x04 (Launch — a NON-held,
// one-shot script id) to the real Hide bytes, to exercise the reaper hole with
// an infinite emitter outside the set_hidden trio.
const TABLE_SYNTH_LAUNCH = {
  id: 0x3400FFF0,
  scripts: { [String(0x04)]: [{ mod: 1.0, scriptDid: 0x33000332 }] },
};

const HOOK_PAYLOAD = {
  0: 0, 1: 4, 2: 4, 3: 28, 4: 0, 6: 4, 7: 16, 8: 12, 9: 16, 10: 12, 11: 16, 12: 8,
  13: 40, 14: 4, 15: 4, 16: 4, 17: 0, 18: 4, 19: 8, 20: 12, 21: 16, 22: 12, 23: 8,
  24: 12, 25: 4, 26: 40,
};

/** Parse a 0x33 record into `PhysicsScriptEntryJs`-shaped objects (the
 *  getters lib.rs exposes, computed the same way from `hook_data`). */
function parseScript(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const id = dv.getUint32(0, true);
  const n = dv.getUint32(4, true);
  let p = 8;
  const entries = [];
  for (let i = 0; i < n; i++) {
    const startTime = dv.getFloat64(p, true);
    const hookType = dv.getUint32(p + 8, true);
    const direction = dv.getInt32(p + 12, true);
    p += 16;
    const len = HOOK_PAYLOAD[hookType];
    if (len === undefined) throw new Error(`unhandled hook type ${hookType}`);
    const hookData = bytes.slice(p, p + len);
    p += len;
    const hd = new DataView(hookData.buffer, hookData.byteOffset, hookData.byteLength);
    const isCreate = (hookType === 13 || hookType === 26) && len === 40;
    entries.push({
      startTime, hookType, direction, hookData,
      createParticleEmitterId: isCreate ? hd.getUint32(0, true) : 0,
      createParticlePartIndex: isCreate ? hd.getUint32(4, true) : 0,
      createParticleOffsetX: isCreate ? hd.getFloat32(8, true) : 0,
      createParticleOffsetY: isCreate ? hd.getFloat32(12, true) : 0,
      createParticleOffsetZ: isCreate ? hd.getFloat32(16, true) : 0,
      createParticleOffsetQW: isCreate ? hd.getFloat32(20, true) : 1,
      createParticleOffsetQX: isCreate ? hd.getFloat32(24, true) : 0,
      createParticleOffsetQY: isCreate ? hd.getFloat32(28, true) : 0,
      createParticleOffsetQZ: isCreate ? hd.getFloat32(32, true) : 0,
      createParticleEmitterInstanceId: isCreate ? hd.getUint32(36, true) : 0,
      soundWaveId: (hookType === 1 || hookType === 21) ? hd.getUint32(0, true) : 0,
      soundProbability: hookType === 21 ? hd.getFloat32(4, true) : (hookType === 1 ? 1 : 0),
      soundVolume: hookType === 21 ? hd.getFloat32(12, true) : (hookType === 1 ? 1 : 0),
    });
  }
  if (p !== bytes.byteLength) throw new Error(`script 0x${id.toString(16)}: consumed ${p}/${bytes.byteLength}`);
  return { id, entries };
}

/** Parse a 0x32 record (ACE ParticleEmitterInfo.Unpack order). */
function parseEmitter(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const r = {
    id: dv.getUint32(0, true),
    emitterType: dv.getInt32(8, true),
    particleType: dv.getInt32(12, true),
    gfxObjId: dv.getUint32(16, true),
    hwGfxObjId: dv.getUint32(20, true),
    birthrate: dv.getFloat64(24, true),
    maxParticles: dv.getInt32(32, true),
    initialParticles: dv.getInt32(36, true),
    totalParticles: dv.getInt32(40, true),
    totalSeconds: dv.getFloat64(44, true),
    lifespan: dv.getFloat64(52, true),
    lifespanRand: dv.getFloat64(60, true),
    isParentLocal: dv.getInt32(172, true),
  };
  if (bytes.byteLength !== 176) throw new Error(`emitter 0x${r.id.toString(16)}: ${bytes.byteLength} bytes`);
  return r;
}

// ---- optional: re-read every embedded record from the real DAT -----------
function readDatRecord(fd, blockSize, root, did) {
  const buf4 = Buffer.alloc(4);
  const readChain = (off, size) => {
    const out = Buffer.alloc(size);
    let got = 0;
    let cur = off;
    while (got < size && cur !== 0) {
      readSync(fd, buf4, 0, 4, cur);
      const next = buf4.readUInt32LE(0) & 0x7fffffff;
      const n = Math.min(blockSize - 4, size - got);
      readSync(fd, out, got, n, cur + 4);
      got += n;
      cur = next;
    }
    return out;
  };
  let off = root;
  for (let depth = 0; depth < 32; depth++) {
    const node = readChain(off, 62 * 4 + 4 + 61 * 24);
    const count = node.readUInt32LE(248);
    let lo = 0;
    let hi = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const at = 252 + 24 * mid;
      const id = node.readUInt32LE(at + 4);
      if (id === did) return readChain(node.readInt32LE(at + 8), node.readUInt32LE(at + 12));
      if (id < did) lo = mid + 1; else hi = mid - 1;
    }
    if (node.readUInt32LE(0) === 0) return null; // leaf
    off = node.readUInt32LE(lo * 4);
  }
  return null;
}

console.log("===========================================================");
console.log("HIDEFX — Hide/Hidden/UnHide emitter lifecycle (real DAT bytes)");
console.log("===========================================================");

{
  const datPath = join(homedir(), "ac_base_dats", "client_portal.dat");
  if (existsSync(datPath)) {
    const fd = openSync(datPath, "r");
    try {
      const hdr = Buffer.alloc(40);
      readSync(fd, hdr, 0, 40, 0x140);
      const blockSize = hdr.readInt32LE(4);
      const root = hdr.readInt32LE(32);
      for (const [did, rec] of RECORDS) {
        const live = readDatRecord(fd, blockSize, root, did);
        check(`dat: 0x${did.toString(16)} embedded bytes == client_portal.dat`,
          !!live && Buffer.compare(live, Buffer.from(rec.bytes)) === 0,
          live ? `${live.length} bytes` : "record not found");
      }
    } finally {
      closeSync(fd);
    }
  } else {
    console.log(`  [info] DAT cross-check not run (${datPath} absent) — embedded copies only`);
  }
  for (const [did, rec] of RECORDS) {
    if (rec.bytes.byteLength !== rec.len) {
      check(`fixture: 0x${did.toString(16)} length`, false, `${rec.bytes.byteLength} != ${rec.len}`);
    }
  }
}

const SCRIPTS = new Map();
const EMITTERS = new Map();
for (const [did, rec] of RECORDS) {
  if ((did >>> 24) === 0x33) SCRIPTS.set(did, parseScript(rec.bytes));
  else EMITTERS.set(did, parseEmitter(rec.bytes));
}
const HANDLES = Array.from({ length: 14 }, (_, i) => 1000 + i);
const creates = (did) => SCRIPTS.get(did).entries.filter((e) => e.hookType === 13 || e.hookType === 26);
const isInfinite = (em) => em.totalParticles === 0 && em.totalSeconds === 0;

// ===========================================================================
// §1 — the data says what retail does
// ===========================================================================
{
  const hide = creates(0x33000332);
  const hidden = creates(0x33000331);
  const unhide = SCRIPTS.get(0x3300032F).entries;
  const handleSet = (list) => list.map((e) => e.createParticleEmitterInstanceId).sort((a, b) => a - b);
  check("§1 Hide 0x33000332: 14 CreateParticle hooks", hide.length === 14, `${hide.length}`);
  check("§1 Hide: explicit handles are exactly 1000-1013",
    JSON.stringify(handleSet(hide)) === JSON.stringify(HANDLES));
  const hideDids = new Set(hide.map((e) => e.createParticleEmitterId));
  check("§1 Hide: emitters are 0x3200028C + 0x3200028B",
    hideDids.size === 2 && hideDids.has(0x3200028C) && hideDids.has(0x3200028B));
  for (const did of hideDids) {
    const em = EMITTERS.get(did);
    check(`§1 Hide emitter 0x${did.toString(16)} is INFINITE (total_particles=0, total_seconds=0)`,
      isInfinite(em), `total=${em.totalParticles} secs=${em.totalSeconds}`);
    check(`§1 Hide emitter 0x${did.toString(16)} is world-space (is_parent_local=0 → a trail)`,
      em.isParentLocal === 0);
  }
  check("§1 Hidden 0x33000331: the same 14 creates on the same handles",
    hidden.length === 14 && JSON.stringify(handleSet(hidden)) === JSON.stringify(HANDLES));
  const stops = unhide.filter((e) => e.hookType === 15);
  const stopHandles = stops.map((e) => new DataView(e.hookData.buffer, e.hookData.byteOffset, 4).getUint32(0, true))
    .sort((a, b) => a - b);
  check("§1 UnHide 0x3300032F: 14 StopParticle hooks, no creates",
    stops.length === 14 && unhide.every((e) => e.hookType === 15 || e.hookType === 20));
  check("§1 UnHide stops EXACTLY Hide's handles 1000-1013",
    JSON.stringify(stopHandles) === JSON.stringify(HANDLES));
  for (const [scriptDid, label] of [[0x33000040, "AttribUpPurple"], [0x330006F7, "LevelUp"]]) {
    for (const e of creates(scriptDid)) {
      const em = EMITTERS.get(e.createParticleEmitterId);
      check(`§1 ${label} emitter 0x${em.id.toString(16)} is a FINITE parent-local burst`,
        em.totalParticles > 0 && em.initialParticles === em.totalParticles && em.isParentLocal === 1,
        `init=${em.initialParticles} total=${em.totalParticles} life=${em.lifespan}±${em.lifespanRand}`);
    }
  }
}

// ===========================================================================
// Harness: window scaffold, a retail-semantics particle simulator, wasm stubs
// ===========================================================================
const bus = { on() {}, off() {}, emit() {} };
globalThis.location = { search: "" };
globalThis.window = {
  location: globalThis.location,
  __pluginClient: { events: bus },
  __playEffectVfxBound: false,
  __hbWasm: null,
  liveScene3d: null,
  __sessionHandle: null,
};

/**
 * Retail emitter lifecycle on a VIRTUAL clock (seconds):
 * `ParticleEmitter::UpdateParticles` emits every `birthrate` while not
 * stopped and under `max_particles`; `StopEmitter` (acclient.c:330295-330309)
 * stops ONLY on an elapsed total_seconds or a reached total_particles;
 * `StopParticleEmitter` flags stopped; a stopped emitter with no live
 * particles is removed (`ParticleManager::UpdateParticles`). Particles die at
 * birth + lifespan + lifespan_rand (the deterministic worst case).
 */
class SimParticleManager {
  constructor() {
    this.t = 0;
    this.particleTable = new Map();
    this.nextEmitterId = 1;
    this.addDelayMs = 0;
  }
  async addEmitter(req) {
    if (this.addDelayMs > 0) await sleep(this.addDelayMs);
    const info = req.emitterInfo;
    if (!info || (info.hwGfxObjId >>> 0) === 0) return 0;
    const id = (req.emitterId >>> 0) || this.nextEmitterId++;
    if (this.particleTable.has(id)) this.destroyParticleEmitter(id);
    const e = {
      id, info, parent: req.parent, createdAt: this.t, cursor: this.t,
      births: [], totalEmitted: 0, stopped: false,
    };
    const init = Math.min(info.initialParticles | 0, info.maxParticles | 0);
    for (let i = 0; i < init; i++) { e.births.push(this.t); e.totalEmitted += 1; }
    this.particleTable.set(id, e);
    return id;
  }
  stopParticleEmitter(id) {
    const e = this.particleTable.get(id);
    if (!e) return false;
    e.stopped = true;
    return true;
  }
  destroyParticleEmitter(id) {
    return this.particleTable.delete(id);
  }
  _stopCheck(e, t) {
    const i = e.info;
    if (i.totalSeconds > 0 && e.createdAt + i.totalSeconds < t) e.stopped = true;
    if (i.totalParticles > 0 && e.totalEmitted >= i.totalParticles) e.stopped = true;
  }
  advance(dtSec) {
    const t = this.t + dtSec;
    for (const [id, e] of [...this.particleTable]) {
      const i = e.info;
      const life = i.lifespan + i.lifespanRand;
      const br = i.birthrate > 0 ? i.birthrate : Infinity;
      while (!e.stopped && e.cursor + br <= t) {
        e.cursor += br;
        e.births = e.births.filter((b) => b + life > e.cursor);
        if (e.births.length < i.maxParticles
            && (i.totalParticles === 0 || e.totalEmitted < i.totalParticles)) {
          e.births.push(e.cursor);
          e.totalEmitted += 1;
        }
        this._stopCheck(e, e.cursor);
      }
      if (!e.stopped) this._stopCheck(e, t);
      e.cursor = Math.max(e.cursor, e.stopped ? t : e.cursor);
      e.births = e.births.filter((b) => b + life > t);
      if (e.stopped && e.births.length === 0) this.particleTable.delete(id);
    }
    this.t = t;
  }
  liveFor(root) {
    return [...this.particleTable.values()].filter((e) => e.parent === root);
  }
}

const sim = new SimParticleManager();
const session = { state: new Map(), objectPhysicsState(g) { return this.state.get(g >>> 0) ?? 0; } };
globalThis.window.__sessionHandle = session;

const tables = new Map([[0x34000004, TABLE_0x34000004], [0x3400FFF0, TABLE_SYNTH_LAUNCH]]);
const tableForGuid = new Map();
let scriptFetchDelayMs = 0;
const wasmExports = {
  fetchPhysicsScriptTable: async (did) => JSON.stringify(tables.get(did >>> 0) ?? null),
  fetchPhysicsScript: async (did) => {
    if (scriptFetchDelayMs > 0) await sleep(scriptFetchDelayMs);
    const s = SCRIPTS.get(did >>> 0);
    if (!s) throw new Error(`no fixture for script 0x${(did >>> 0).toString(16)}`);
    return { takeEntries: () => parseScript(RECORDS.get(did >>> 0).bytes).entries };
  },
  fetchParticleEmitter: async (did) => {
    const em = EMITTERS.get(did >>> 0);
    if (!em) throw new Error(`no fixture for emitter 0x${(did >>> 0).toString(16)}`);
    return { ...em };
  },
};
globalThis.window.__hbWasm = wasmExports;

const entityMap = new Map();
function spawn(guid, tableDid = 0x34000004) {
  const root = { guid, position: { x: 0, y: 0, z: 0 }, children: [], add() {}, remove() {} };
  entityMap.set(guid >>> 0, { root, guid });
  tableForGuid.set(guid >>> 0, tableDid);
  return root;
}
globalThis.window.liveScene3d = {
  entityManager: {
    entityMap,
    wasmExports,
    materialCache: null,
    _worldParticleManager: sim,
    _particleEmittersForGuid: new Map(),
    _firePlayEffectSoundHook() {},
    getPhysicsScriptTableDid: (g) => tableForGuid.get(g >>> 0) ?? 0,
  },
};

// ---- import BOTH arms (flags are read once at module evaluation) --------
const OWNER_URL = pathToFileURL(resolvePath(__dirname, "scene3d/particles/owner_registry.js")).href;
const VFX_URL = pathToFileURL(resolvePath(__dirname, "scene3d/play_effect_vfx.js")).href;
globalThis.location.search = "?playEffectLifecycle=off";
const OFF = (await import(`${VFX_URL}?arm=off`)).__test;
globalThis.location.search = "?oneShotDrain=off";
const DRAIN_OFF = (await import(`${VFX_URL}?arm=drainoff`)).__test;
globalThis.location.search = "";
const ON = (await import(VFX_URL)).__test;
const { ownerRegistry, particleOwnerOn, _resetParticleOwnerFlagForTests } = await import(OWNER_URL);
const { _clearPhysicsScriptTableCache } = await import(
  pathToFileURL(resolvePath(__dirname, "ui/ac_physics_script_table.js")).href);

check("flag: bare URL ⇒ ?playEffectLifecycle ON", ON.playEffectLifecycleOn === true);
check("flag: ?playEffectLifecycle=off ⇒ OFF", OFF.playEffectLifecycleOn === false);
check("flag: owner registry path is on (production default)", particleOwnerOn() === true);
check("flag: bare URL ⇒ ?oneShotDrain ON (independent of ?playEffectLifecycle)",
  ON.oneShotDrainOn === true && OFF.oneShotDrainOn === true);
check("flag: ?oneShotDrain=off ⇒ OFF", DRAIN_OFF.oneShotDrainOn === false);

// Short real-time schedule; the particle clock is virtual (`sim.advance`).
const TIMING = { oneShotBase: 40, holdGrace: 800, holdCheck: 60, holdMax: 20000, drain: 150 };
OFF.setLifecycleTiming(TIMING);
DRAIN_OFF.setLifecycleTiming(TIMING);
ON.setLifecycleTiming(TIMING);

const PS = { Hide: 0x74, UnHide: 0x75, Hidden: 0x76, AttribUpPurple: 0x10, LevelUp: 0x8A, Launch: 0x04 };
const HIDDEN = 0x4000;
const NO_DRAW = 0x20;
const emitting = (root) => sim.liveFor(root).filter((e) => !e.stopped);
/** What EntityManager.setVisibility does for a kind=17 flip. */
function setVisibility(arm, guid, visible, physicsState) {
  session.state.set(guid >>> 0, physicsState >>> 0);
  arm.noteEntityVisibility(guid, visible);
}

// ===========================================================================
// §2 — LEGACY arm reproduces the stuck trail
// ===========================================================================
{
  _clearPhysicsScriptTableCache();
  const G = 0x5006C651; // the owner's player guid, from the log
  const root = spawn(G);
  sim.addDelayMs = 120; // GfxObj mesh + texture still loading past the 40 ms reaper
  const r = await OFF.tryResolveRealVfx(G, PS.Hide, 1.0);
  check("§2 legacy: wire Hide resolves", r === true);
  await sleep(260);
  setVisibility(OFF, G, false, HIDDEN);
  setVisibility(OFF, G, true, 0);
  await sleep(40);
  sim.advance(600);
  check("§2 legacy REPRO: 14 Hide emitters attached after the reaper ran and are still EMITTING after 600 s",
    emitting(root).length === 14, `${emitting(root).length} emitting`);
  check("§2 legacy REPRO: no UnHide is ever played (nothing maps the HIDDEN flip)",
    OFF.realVfxStats().hiddenStateScriptsPlayed === 0 && OFF.realVfxStats().stopHooksFired === 0);
  ownerRegistry.destroyAllForOwner(G);
  for (const e of sim.liveFor(root)) sim.destroyParticleEmitter(e.id);
  entityMap.delete(G);
}

// ===========================================================================
// §3 — FIXED arm: the owner's portal sequence
// ===========================================================================
{
  _clearPhysicsScriptTableCache();
  const G = 0x5006C652;
  const root = spawn(G);
  sim.addDelayMs = 120; // same slow attach that leaked in §2
  const before = ON.realVfxStats();

  // 1. the wire Hide (ACE DoPreTeleportHide)
  const r = await ON.tryResolveRealVfx(G, PS.Hide, 1.0);
  check("§3 wire Hide resolves", r === true);
  await sleep(260);
  check("§3 Hide: 14 emitters attached despite the slow attach", sim.liveFor(root).length === 14,
    `${sim.liveFor(root).length}`);
  const rec = ownerRegistry._owners.get(G);
  const scoped = rec ? [...rec.scoped.entries()].filter(([, v]) => typeof v === "number") : [];
  check("§3 Hide: registered on the OBJECT-SCOPED handles 1000-1013 (retail per-object table)",
    JSON.stringify(scoped.map(([h]) => h).sort((a, b) => a - b)) === JSON.stringify(HANDLES));
  check("§3 Hide: held — survives the one-shot reaper", ON.hiddenState(G).holdGroups === 1);
  sim.advance(5);
  check("§3 Hide: still emitting 5 s later (pink bubbles while portalling)", emitting(root).length === 14);

  // 2. SetState{Hidden} (ACE DoTeleportPhysicsStateChanges) → retail PS_Hidden
  setVisibility(ON, G, false, HIDDEN | 0x10 /* IgnoreCollisions */);
  check("§3 HIDDEN flip tracked", ON.hiddenState(G).hidden === true);
  await sleep(260);
  check("§3 PS_Hidden replaced the 14 handles (still exactly 14 live, not 28)",
    sim.liveFor(root).length === 14, `${sim.liveFor(root).length}`);
  await sleep(TIMING.holdGrace + 2 * TIMING.holdCheck);
  sim.advance(20);
  check("§3 still hidden past the grace window ⇒ still held + emitting (retail pink-bubble state)",
    emitting(root).length === 14 && ON.hiddenState(G).holdGroups >= 1);

  // 3. arrival: SetState{!Hidden} (ACE OnTeleportComplete) → retail PS_UnHide
  const origStop = ownerRegistry.stopEmitter.bind(ownerRegistry);
  let handleStopsLive = 0;
  ownerRegistry.stopEmitter = (owner, h, opts) => {
    const ok = origStop(owner, h, opts);
    if (ok && (owner >>> 0) === G && h >= 1000 && h <= 1013 && opts?.scopedOnly === true) {
      handleStopsLive += 1;
    }
    return ok;
  };
  setVisibility(ON, G, true, 0x8 /* ReportCollisions */);
  await sleep(40);
  ownerRegistry.stopEmitter = origStop;
  const after = ON.realVfxStats();
  check("§3 unhide played PS_Hidden then PS_UnHide (client-local, like set_hidden)",
    after.hiddenStateScriptsPlayed - before.hiddenStateScriptsPlayed === 2);
  check("§3 UnHide's 14 real StopParticle hooks fired", after.stopHooksFired - before.stopHooksFired === 14,
    `${after.stopHooksFired - before.stopHooksFired}`);
  check("§3 every StopParticle resolved its OBJECT-SCOPED handle (scopedOnly) to a live emitter", handleStopsLive === 14,
    `${handleStopsLive}`);
  check("§3 all 14 emitters stopped", emitting(root).length === 0 && sim.liveFor(root).length === 14);
  sim.advance(0.76);
  check("§3 bubbles drain to ZERO within the 0.75 s lifespan", sim.liveFor(root).length === 0,
    `${sim.liveFor(root).length} left`);
  await sleep(TIMING.drain + 30);
  check("§3 owner record emptied after the drain reap", ownerRegistry.emitterCountForOwner(G) === 0,
    `${ownerRegistry.emitterCountForOwner(G)}`);
  check("§3 hold + hidden state cleared",
    ON.hiddenState(G).holdGroups === 0 && ON.hiddenState(G).hidden === false);
  sim.advance(600);
  check("§3 nothing re-emits later", sim.liveFor(root).length === 0);
  entityMap.delete(G);
  ownerRegistry.destroyAllForOwner(G);
  ON.forgetEntityHiddenState(G);
}

// ===========================================================================
// §4 — reaper hole closed for NON-held one-shots (infinite emitter, late attach)
// ===========================================================================
{
  _clearPhysicsScriptTableCache();
  const G = 0x50000004;
  const root = spawn(G, 0x3400FFF0);
  sim.addDelayMs = 300;
  const prev = ON.setLifecycleTiming({ oneShotBase: 150, drain: 400 });
  const before = ON.realVfxStats().lateAttachReaped;
  const r = await ON.tryResolveRealVfx(G, PS.Launch, 1.0);
  check("§4 synthetic Launch→Hide-bytes resolves (non-held path)", r === true && ON.hiddenState(G).holdGroups === 0);
  await sleep(360);
  check("§4 14 emitters attached AFTER the 150 ms reaper had run", sim.liveFor(root).length === 14,
    `${sim.liveFor(root).length}`);
  check("§4 each late attach scheduled its own reap", ON.realVfxStats().lateAttachReaped - before === 14);
  await sleep(150 + 40);
  // PLIFECYCLE-1: an infinite (0/0) emitter is STOPPED at its reap, so its
  // live particles fade out, then reaped after the drain window.
  check("§4 late infinite emitters STOPPED one base-lifetime after attaching (not hard-destroyed)",
    sim.liveFor(root).length === 14 && emitting(root).length === 0,
    `${sim.liveFor(root).length} live, ${emitting(root).length} emitting`);
  await sleep(400);
  ON.setLifecycleTiming(prev);
  check("§4 ...and gone after the drain window, owner record emptied",
    sim.liveFor(root).length === 0 && ownerRegistry.emitterCountForOwner(G) === 0,
    `${sim.liveFor(root).length} left`);
  entityMap.delete(G);
}

// ===========================================================================
// §5 — backstop: Hide with no teleport (never hidden) is released after grace
// ===========================================================================
{
  _clearPhysicsScriptTableCache();
  const G = 0x50000005;
  const root = spawn(G);
  sim.addDelayMs = 0;
  await ON.tryResolveRealVfx(G, PS.Hide, 1.0);
  await sleep(20);
  check("§5 Hide held", emitting(root).length === 14 && ON.hiddenState(G).holdGroups === 1);
  await sleep(TIMING.holdGrace + 2 * TIMING.holdCheck);
  check("§5 never hidden ⇒ released after the grace window", emitting(root).length === 0
    && ON.hiddenState(G).holdGroups === 0);
  sim.advance(1);
  check("§5 drained to zero", sim.liveFor(root).length === 0);
  entityMap.delete(G);
  ownerRegistry.destroyAllForOwner(G);
}

// ===========================================================================
// §6 — hard cap: hidden forever (lost unhide) is still bounded
// ===========================================================================
{
  _clearPhysicsScriptTableCache();
  const G = 0x50000006;
  const root = spawn(G);
  sim.addDelayMs = 0;
  const prev = ON.setLifecycleTiming({ holdGrace: 100, holdCheck: 50, holdMax: 500 });
  await ON.tryResolveRealVfx(G, PS.Hide, 1.0);
  setVisibility(ON, G, false, HIDDEN);
  await sleep(250);
  check("§6 hidden: held + emitting", emitting(root).length === 14);
  await sleep(400);
  check("§6 hard cap releases a hold whose unhide never came", emitting(root).length === 0
    && ON.hiddenState(G).holdGroups === 0);
  ON.setLifecycleTiming(prev);
  sim.advance(1);
  check("§6 drained to zero", sim.liveFor(root).length === 0);
  entityMap.delete(G);
  ownerRegistry.destroyAllForOwner(G);
  ON.forgetEntityHiddenState(G);
}

// ===========================================================================
// §7 — a NoDraw-only flip is not set_hidden: no scripts
// ===========================================================================
{
  const G = 0x50000007;
  spawn(G);
  const before = ON.realVfxStats().hiddenStateScriptsPlayed;
  setVisibility(ON, G, false, NO_DRAW);
  setVisibility(ON, G, true, 0);
  check("§7 NoDraw flip plays neither PS_Hidden nor PS_UnHide",
    ON.realVfxStats().hiddenStateScriptsPlayed === before && ON.hiddenState(G).hidden === false);
  entityMap.delete(G);
}

// ===========================================================================
// §8 — batched hide+unhide racing the Hidden resolve (epoch)
// ===========================================================================
{
  _clearPhysicsScriptTableCache();
  const G = 0x50000008;
  const root = spawn(G);
  sim.addDelayMs = 80;
  scriptFetchDelayMs = 60; // keep PS_Hidden's resolve in flight across the unhide
  // Both kind=17 events drain together: the state already reads cleared.
  setVisibility(ON, G, false, 0);
  setVisibility(ON, G, true, 0);
  await sleep(300);
  scriptFetchDelayMs = 0;
  check("§8 batched flip still pairs PS_Hidden with PS_UnHide (state read already cleared)",
    ON.hiddenState(G).hidden === false && ON.hiddenState(G).epoch === 1);
  check("§8 the in-flight Hidden group was released on arrival — nothing emitting",
    emitting(root).length === 0, `${emitting(root).length} emitting`);
  sim.advance(1);
  check("§8 drained to zero", sim.liveFor(root).length === 0);
  entityMap.delete(G);
  ownerRegistry.destroyAllForOwner(G);
}

// ===========================================================================
// §9 — despawn while held
// ===========================================================================
{
  _clearPhysicsScriptTableCache();
  const G = 0x50000009;
  const root = spawn(G);
  sim.addDelayMs = 0;
  await ON.tryResolveRealVfx(G, PS.Hide, 1.0);
  setVisibility(ON, G, false, HIDDEN);
  await sleep(30);
  // EntityManager.remove → destroyAllForOwner + forgetEntityHiddenState
  entityMap.delete(G);
  ownerRegistry.destroyAllForOwner(G);
  for (const e of sim.liveFor(root)) {
    // the real manager drops them via destroyParticleEmitter from the facade
    if (sim.particleTable.has(e.id)) sim.destroyParticleEmitter(e.id);
  }
  ON.forgetEntityHiddenState(G);
  await sleep(30);
  check("§9 despawn: no emitters, no hold, no hidden state",
    sim.liveFor(root).length === 0 && ON.hiddenState(G).holdGroups === 0 && ON.hiddenState(G).hidden === false);
}

// ===========================================================================
// §10 — AttribUpPurple / LevelUp terminate on their own (not the stuck one)
// ===========================================================================
{
  _clearPhysicsScriptTableCache();
  const G = 0x5000000A;
  const root = spawn(G);
  sim.addDelayMs = 0;
  const prev = ON.setLifecycleTiming({ oneShotBase: 5000 }); // keep the reaper out of it
  const a = await ON.tryResolveRealVfx(G, PS.AttribUpPurple, 0.4);
  const b = await ON.tryResolveRealVfx(G, PS.LevelUp, 1.0);
  await sleep(20);
  check("§10 AttribUpPurple (speed 0.4 → 0x33000040) + LevelUp resolve, not held",
    a === true && b === true && ON.hiddenState(G).holdGroups === 0);
  check("§10 4 finite emitters attached (1 + 3)", sim.liveFor(root).length === 4, `${sim.liveFor(root).length}`);
  sim.advance(3.3);
  check("§10 all drained by max lifespan (3.0 + 0.25 s) with NO reaper and NO stop",
    sim.liveFor(root).length === 0, `${sim.liveFor(root).length} left`);
  ON.setLifecycleTiming(prev);
  entityMap.delete(G);
  ownerRegistry.destroyAllForOwner(G);
}

// ===========================================================================
// §11 — a script handle never hits an unrelated emitter whose GLOBAL facade id
// equals it (`scopedOnly`): UnHide's StopParticle(1005) on an owner that has
// no handle 1005 but does own underlying emitter #1005 (e.g. a buff sparkle).
// ===========================================================================
{
  _clearPhysicsScriptTableCache();
  const G = 0x5000000B;
  const root = spawn(G);
  sim.addDelayMs = 0;
  const savedNext = sim.nextEmitterId;
  sim.nextEmitterId = 1005;
  const unrelated = await ownerRegistry.addEmitter(G, sim, {
    emitterInfo: { ...EMITTERS.get(0x3200028C) }, parent: root, partIndex: -1,
  });
  sim.nextEmitterId = Math.max(savedNext, 1006);
  check("§11 setup: an unrelated anonymous emitter got global id 1005", unrelated === 1005);
  const r = await ON.tryResolveRealVfx(G, PS.UnHide, 1.0);
  await sleep(20);
  check("§11 wire UnHide resolves as a stop-only script", r === true);
  check("§11 StopParticle(1005) did NOT stop the unrelated emitter #1005",
    sim.particleTable.get(1005)?.stopped === false);
  check("§11 scopedOnly unit: stopEmitter / destroyEmitter refuse a raw id",
    ownerRegistry.stopEmitter(G, 1005, { scopedOnly: true }) === false
    && ownerRegistry.destroyEmitter(G, 1005, { scopedOnly: true }) === false
    && sim.particleTable.has(1005));
  check("§11 legacy callers (no opts) keep the raw-id fallback",
    ownerRegistry.stopEmitter(G, 1005) === true);
  entityMap.delete(G);
  ownerRegistry.destroyAllForOwner(G);
}

// ===========================================================================
// §12 — PLIFECYCLE-1 (`?oneShotDrain`): the one-shot reaper lets a FINITE
// emitter drain. Retail removes an emitter only at stopped && num_particles == 0
// (ParticleManager::UpdateParticles, acclient.c:329482-329525); there is no
// timer-based destroy. LevelUp 0x320003AE/AF/B0 live 3.0 ± 0.25 s, past the
// 2.5 s one-shot budget.
// ===========================================================================
{
  // The pure policy first.
  const table = new Map([
    [1, { info: { emitterType: 1, birthrate: 0.05, totalParticles: 40, totalSeconds: 0, lifespan: 3.0, lifespanRand: 0.25 } }],
    [2, { info: { emitterType: 1, birthrate: 0.1, totalParticles: 0, totalSeconds: 2.0, lifespan: 1.0, lifespanRand: 0 } }],
    [3, { info: { emitterType: 2, birthrate: 0.05, totalParticles: 30, totalSeconds: 0, lifespan: 0.5, lifespanRand: 0 } }],
    [4, { info: { emitterType: 1, birthrate: 0.05, totalParticles: 0, totalSeconds: 0, lifespan: 0.75, lifespanRand: 0 } }],
    [6, {}],
  ]);
  const c = ON.classifyOneShotReap(table, [1, 2, 3, 4, 5, 6]);
  check("§12 policy: finite = total_particles>0 || total_seconds>0",
    JSON.stringify(c.finite) === "[1,2,3]", JSON.stringify(c.finite));
  check("§12 policy: persistent 0/0 → stop-then-reap", JSON.stringify(c.persistent) === "[4]");
  check("§12 policy: absent from the table → gone (finished)", JSON.stringify(c.gone) === "[5]");
  check("§12 policy: no info → unknown (legacy destroy)", JSON.stringify(c.unknown) === "[6]");
  check("§12 policy: no table → every id unknown",
    JSON.stringify(ON.classifyOneShotReap(null, [7, 8]).unknown) === "[7,8]");
  const bs = ON.oneShotFiniteBackstopSec;
  check("§12 backstop: BirthratePerSec count emitter = total × birthrate + life + rand + 1 (LevelUp 6.25 s)",
    Math.abs(bs(table.get(1).info) - 6.25) < 1e-9, `${bs(table.get(1).info)}`);
  check("§12 backstop: total_seconds emitter = total_seconds + life + 1",
    Math.abs(bs(table.get(2).info) - 4.0) < 1e-9);
  check("§12 backstop: BirthratePerMeter count emitter gets a fixed 10 s (birthrate is metres)",
    Math.abs(bs(table.get(3).info) - 11.5) < 1e-9);
  check("§12 backstop: group backstop = max over its finite ids", Math.abs(c.backstopSec - 11.5) < 1e-9);

  // The real resolver: LevelUp on a fresh guid with a 40 ms reaper.
  _clearPhysicsScriptTableCache();
  const G = 0x5000000C;
  const root = spawn(G);
  sim.addDelayMs = 0;
  const prev = ON.setLifecycleTiming({ oneShotBase: 40, drain: 150, emitterSecondMs: 40 });
  const before = ON.realVfxStats();
  const r = await ON.tryResolveRealVfx(G, PS.LevelUp, 1.0);
  await sleep(80);
  check("§12 LevelUp resolves; its 40 ms one-shot reaper has run",
    r === true && ON.realVfxStats().oneShotFiniteDrained > before.oneShotFiniteDrained);
  check("§12 the 3 FINITE LevelUp emitters survive the reaper and keep emitting",
    sim.liveFor(root).length === 3 && emitting(root).length === 3,
    `${sim.liveFor(root).length} live, ${emitting(root).length} emitting`);
  check("§12 the reaper counted them as left to drain",
    ON.realVfxStats().oneShotFiniteDrained - before.oneShotFiniteDrained === 3);
  sim.advance(3.3);
  check("§12 they drain on their own by max lifespan (3.0 + 0.25 s)", sim.liveFor(root).length === 0,
    `${sim.liveFor(root).length} left`);
  await sleep(6.25 * 40 + 80);
  check("§12 the far backstop drops the finished ids from the owner record",
    ownerRegistry.emitterCountForOwner(G) === 0, `${ownerRegistry.emitterCountForOwner(G)}`);
  check("§12 the backstop stopped nothing (they had already finished)",
    ON.realVfxStats().oneShotStopped === before.oneShotStopped);
  ON.setLifecycleTiming(prev);
  entityMap.delete(G);
  ownerRegistry.destroyAllForOwner(G);
}
{
  // `?oneShotDrain=off` REPRODUCES the cut-off: the 2.5 s budget destroys them.
  _clearPhysicsScriptTableCache();
  const G = 0x5000000D;
  const root = spawn(G);
  sim.addDelayMs = 0;
  const prev = DRAIN_OFF.setLifecycleTiming({ oneShotBase: 40 });
  await DRAIN_OFF.tryResolveRealVfx(G, PS.LevelUp, 1.0);
  await sleep(10);
  sim.advance(2.5); // the real 2.5 s budget, on the virtual clock
  const livingAtBudget = sim.liveFor(root).length;
  await sleep(70);
  check("§12 `=off` REPRO: LevelUp still had live particles at the budget, and the reaper hard-destroyed them",
    livingAtBudget === 3 && sim.liveFor(root).length === 0,
    `${livingAtBudget} live at 2.5 s → ${sim.liveFor(root).length} after the reaper`);
  DRAIN_OFF.setLifecycleTiming(prev);
  entityMap.delete(G);
  ownerRegistry.destroyAllForOwner(G);
}

// ===========================================================================
// §13 — the same policy on the legacy `?particleOwner=off` bookkeeping
// (per-guid `_particleEmittersForGuid` map + direct manager calls).
// ===========================================================================
{
  globalThis.location.search = "?particleOwner=off";
  _resetParticleOwnerFlagForTests();
  try {
    check("§13 setup: owner registry path off", particleOwnerOn() === false);
    _clearPhysicsScriptTableCache();
    const em = globalThis.window.liveScene3d.entityManager;
    const G = 0x5000000E;
    const root = spawn(G);
    const L = 0x5000000F;
    const rootL = spawn(L, 0x3400FFF0); // Launch → the infinite Hide bytes
    sim.addDelayMs = 0;
    const prev = ON.setLifecycleTiming({ oneShotBase: 40, drain: 150, emitterSecondMs: 40 });
    await ON.tryResolveRealVfx(G, PS.LevelUp, 1.0);
    await ON.tryResolveRealVfx(L, PS.Launch, 1.0);
    await sleep(80);
    check("§13 legacy: finite LevelUp emitters left running by the reaper",
      emitting(root).length === 3 && (em._particleEmittersForGuid.get(G)?.length ?? 0) === 3);
    check("§13 legacy: infinite emitters STOPPED, still draining",
      sim.liveFor(rootL).length === 14 && emitting(rootL).length === 0);
    await sleep(150 + 40);
    check("§13 legacy: infinite emitters destroyed after the drain window, map pruned",
      sim.liveFor(rootL).length === 0 && !em._particleEmittersForGuid.has(L));
    sim.advance(3.3);
    await sleep(6.25 * 40);
    check("§13 legacy: finished LevelUp ids pruned from the per-guid map by the backstop",
      sim.liveFor(root).length === 0 && !em._particleEmittersForGuid.has(G));
    ON.setLifecycleTiming(prev);
    entityMap.delete(G);
    entityMap.delete(L);
  } finally {
    globalThis.location.search = "";
    _resetParticleOwnerFlagForTests();
  }
}

console.log(`\n[test_hidefx_lifecycle] ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
