// Batch 13 / #20 — standalone ESM test for `scene3d/diag.js`
// onSpawnFailed landblock-key hygiene.
//
// Bug #20: the no-pending fallback in onSpawnFailed computed the LB key
// as `(meta?.landblockId >>> 0) & 0xffff0000`. The bitwise-AND runs on
// the (unsigned) result but its OWN result is signed for keys with the
// high bit set (e.g. Holtburg 0xA9B40000), so the recorded landblockId
// came out negative and never matched the byLandblock bucket keyed by
// the unsigned value. The fix routes it through lbKeyOf (which applies
// `>>> 0` LAST), keeping the `pending?.landblockId ??` short-circuit.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_diag_spawnfailed_lbkey.mjs
//
// diag.js imports lbKeyOf + many attach<Name> surface modules; we load
// it via the strip-imports factory pattern, injecting a real lbKeyOf and
// no-op attach stubs. installDiag only needs a `window` + `performance`.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

// Real lbKeyOf (mirror of scene3d/landblock_lru.js — `>>> 0` LAST).
const LB_KEY_MASK = 0xffff_0000 >>> 0;
const lbKeyOf = (id) => (id & LB_KEY_MASK) >>> 0;

function stripImports(src) {
  return src
    // strip every top-of-file import (lbKeyOf + attach<Name> surfaces)
    .replace(/^\s*import\s+.*$/gm, "")
    .replace(/^\s*export\s+function\s+/gm, "function ")
    .replace(/^\s*export\s+class\s+/gm, "class ")
    .replace(/^\s*export\s+const\s+/gm, "const ");
}

const diagPath = resolvePath(__dirname, "scene3d", "diag.js");
const diagSrc = stripImports(readFileSync(diagPath, "utf8"));

// Inject lbKeyOf + no-op attach stubs (the install loop optional-chains
// each fn). performance is a real one; window is our stub.
const noopAttach = () => {};
const factory = new Function(
  "lbKeyOf",
  "_attachPlacements", "_attachEntityTypes", "_attachEvents", "_attachWire",
  "_attachPhysics", "_attachMotion", "_attachPvs", "_attachAssets",
  "_attachIntegrity", "_attachFonts", "_attachStrings", "_attachInput",
  "_attachCombat", "_attachPalettes", "_attachLod", "_attachClothing",
  "window", "performance", "console",
  `${diagSrc}\n; return { installDiag };`,
);

const fakeWindow = {};
const { installDiag } = factory(
  lbKeyOf,
  noopAttach, noopAttach, noopAttach, noopAttach,
  noopAttach, noopAttach, noopAttach, noopAttach,
  noopAttach, noopAttach, noopAttach, noopAttach,
  noopAttach, noopAttach, noopAttach, noopAttach,
  fakeWindow,
  globalThis.performance ?? { now: () => Date.now() },
  console,
);

console.log("Batch 13 / #20 — diag.js onSpawnFailed lb-key hygiene test");
console.log("=========================");

check("installDiag exported", typeof installDiag === "function");

// installDiag attaches diag to fakeWindow.__diag.
const diag = installDiag();
check("installDiag returned a diag object", !!diag && diag === fakeWindow.__diag);

const HOLTBURG_FULL = 0xa9b40123 >>> 0;  // full 32-bit landblock id
const HOLTBURG_KEY = 0xa9b40000 >>> 0;   // expected high-16 packed key
const EXPECTED_KEY = 2847145984;         // = 0xa9b40000 unsigned

// ---- #20 fallback branch (no prior onSpawnAttempted) -----------------
// guid the attempted hook never saw → pending is undefined → the
// fallback lbKeyOf path runs.
const metaNoPending = {
  guid: 0xdeadbeef,
  wcid: 0x4321,
  name: "Ghost",
  landblockId: HOLTBURG_FULL,
};
diag.onSpawnFailed(metaNoPending, new Error("boom"));

const failedRec = diag.spawns.failed[diag.spawns.failed.length - 1];
check(
  "no-pending fallback: landblockId === unsigned 0xA9B40000 (not negative)",
  failedRec.landblockId === EXPECTED_KEY,
  `got ${failedRec.landblockId} (want ${EXPECTED_KEY})`,
);
check(
  "no-pending fallback: landblockId is positive",
  failedRec.landblockId > 0,
  `got ${failedRec.landblockId}`,
);
check(
  "no-pending fallback: lbKeyOf matches the canonical key",
  failedRec.landblockId === HOLTBURG_KEY,
);

// ---- #20 pending branch (attempted first → pending?.landblockId wins) -
// The short-circuit `pending?.landblockId ??` must take precedence.
const metaAttempt = {
  guid: 0x1234abcd,
  wcid: 0x37518,
  name: "Royal Guard",
  landblockId: HOLTBURG_FULL,
  x: 10, y: 20, z: 0,
};
diag.onSpawnAttempted(metaAttempt);
// the attempted record stores the masked-but-unsigned lb (onSpawnAttempted
// uses `((meta.landblockId & 0xffff0000) >>> 0)` which is correct there).
const pendingRec = diag.spawns.pending.get(metaAttempt.guid >>> 0);
check(
  "onSpawnAttempted recorded pending with unsigned lb key",
  pendingRec && pendingRec.landblockId === EXPECTED_KEY,
  pendingRec ? `landblockId=${pendingRec.landblockId}` : "no pending record",
);

diag.onSpawnFailed(metaAttempt, new Error("late fail"));
const failedRec2 = diag.spawns.failed[diag.spawns.failed.length - 1];
check(
  "pending branch: landblockId from pending (unsigned)",
  failedRec2.landblockId === EXPECTED_KEY,
  `got ${failedRec2.landblockId}`,
);

// ---- byLandblock bucket keyed by the unsigned key --------------------
const bucket = diag.spawns.byLandblock.get(EXPECTED_KEY);
check(
  "byLandblock bucket exists under unsigned key 2847145984",
  !!bucket,
  bucket ? `failed=${bucket.failed}` : "missing bucket",
);
check(
  "byLandblock bucket recorded the failed spawn",
  !!bucket && bucket.failed === 1,
  bucket ? `failed=${bucket.failed}` : "missing bucket",
);

console.log("=========================");
if (failed === 0) {
  console.log(`PASS: all ${passed} Batch 13 #20 checks green.`);
  process.exit(0);
} else {
  console.log(`FAIL: ${failed} check(s) failed (${passed} passed).`);
  process.exit(1);
}
