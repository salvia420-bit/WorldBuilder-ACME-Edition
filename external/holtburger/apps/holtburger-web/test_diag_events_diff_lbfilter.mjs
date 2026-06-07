// Batch 13 / #21 — standalone ESM test for `scene3d/diag/events.js`
// diff() observed-record landblock filtering.
//
// Bug #21: diff(lbId) filtered the EXPECTED events by landblock but the
// OBSERVED records only by the time window — so events fired in any other
// LB the session visited polluted the per-LB diff (wrong `extra`/match
// accounting). The fix derives each record's LB from its AC-frame
// world_pos (floor(ac/192), pure AC arithmetic — NO acToThree) and keeps
// only records whose LB matches the queried one. Records missing a usable
// world_pos are excluded from the per-LB diff.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_diag_events_diff_lbfilter.mjs
//
// events.js has no imports; we load attachEvents via the strip-exports
// factory and drive diff() against a synthetic eventLog tap.

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

function stripExports(src) {
  return src
    .replace(/^\s*export\s+function\s+/gm, "function ")
    .replace(/^\s*export\s+class\s+/gm, "class ")
    .replace(/^\s*export\s+const\s+/gm, "const ");
}

const evPath = resolvePath(__dirname, "scene3d", "diag", "events.js");
const evSrc = stripExports(readFileSync(evPath, "utf8"));

// events.js reads `window`, `performance`, `console`. Provide a fake
// window we can swap liveScene3d on.
const fakeWindow = {};
const factory = new Function(
  "window", "performance", "console",
  `${evSrc}\n; return { attachEvents };`,
);
const { attachEvents } = factory(
  fakeWindow,
  globalThis.performance ?? { now: () => Date.now() },
  console,
);

console.log("Batch 13 / #21 — diag/events.js diff() LB-filter test");
console.log("=========================");

check("attachEvents exported", typeof attachEvents === "function");

// LB geometry: Holtburg LB byte (0xa9, 0xb4) → key 0xa9b40000.
// AC world for a record in this LB: x in [0xa9*192, ...], y in [0xb4*192, ...].
const METERS_PER_LB = 192.0;
const HOLT_BYTE_X = 0xa9, HOLT_BYTE_Y = 0xb4;
const HOLT_KEY = 0xa9b40000 >>> 0;
const holtWorld = (lx, ly, z) => [
  HOLT_BYTE_X * METERS_PER_LB + lx,
  HOLT_BYTE_Y * METERS_PER_LB + ly,
  z ?? 0,
];
// A FOREIGN LB (different bytes) — must be excluded from a Holtburg diff.
const FOR_BYTE_X = 0x12, FOR_BYTE_Y = 0x34;
const foreignWorld = (lx, ly, z) => [
  FOR_BYTE_X * METERS_PER_LB + lx,
  FOR_BYTE_Y * METERS_PER_LB + ly,
  z ?? 0,
];

// Synthetic eventLog records. Each is a "sound" with a wave_did + source.
// Records:
//  - r0: Holtburg, matches an expected event (same wave_did + pos)
//  - r1: Holtburg, NO expected match → should be in `extra`
//  - r2: FOREIGN LB → must be filtered out (NOT in extra, NOT observedCount)
//  - r3: missing world_pos → must be excluded from the per-LB diff
const now = 1000;
const records = [
  { type: "sound", wave_did: 0xAA, source: "AmbientRuntime", world_pos: holtWorld(10, 10, 0), t_wall_ms: now },
  { type: "sound", wave_did: 0xBB, source: "AmbientRuntime", world_pos: holtWorld(20, 20, 0), t_wall_ms: now },
  { type: "sound", wave_did: 0xCC, source: "AmbientRuntime", world_pos: foreignWorld(5, 5, 0), t_wall_ms: now },
  { type: "sound", wave_did: 0xDD, source: "AmbientRuntime", world_pos: null, t_wall_ms: now },
];

fakeWindow.liveScene3d = {
  _pushEventRecord() {},
  snapshotEventLog() { return { records, overflow: 0, capped_at: records.length }; },
};

// Expected oracle: one event in Holtburg matching r0's key+pos.
const diag = {
  expected: {
    events: [
      { type: "sound", wave_did: 0xAA, source: "AmbientRuntime",
        landblockId: HOLT_KEY, world_pos: holtWorld(10, 10, 0) },
    ],
  },
};
attachEvents(diag);
check("diag.events installed", !!diag.events && typeof diag.events.diff === "function");
check("tap reports enabled", diag.events.isEnabled() === true);

// Drive diff with a wide time window so all 4 records pass the time gate;
// the LB filter is what must drop r2 + r3.
const res = diag.events.diff(HOLT_KEY, { t0: 0, t1: 10000 });
check("diff did not error", !res.error, res.error ? String(res.error) : "");
check("diff landblockId is Holtburg", res.landblockId === "0xa9b40000", res.landblockId);

// observedCount must be the in-LB records only (r0 + r1 = 2), NOT all 4.
check(
  "observedCount = this-LB records only (2, not 4)",
  res.observedCount === 2,
  `observedCount=${res.observedCount}`,
);

// matched: r0 pairs the single expected event.
check("matched the expected Holtburg event", res.matched === 1, `matched=${res.matched}`);

// extra: r1 only (Holtburg, unmatched). Foreign r2 + no-pos r3 excluded.
check("extra contains exactly 1 record", res.extra.length === 1, `extra=${res.extra.length}`);
const extraWaveDids = res.extra.map((r) => r.wave_did);
check(
  "extra is the in-LB unmatched record (wave_did 0xBB)",
  res.extra.length === 1 && res.extra[0].wave_did === 0xBB,
  `extra wave_dids=[${extraWaveDids.map((d) => "0x" + d.toString(16)).join(",")}]`,
);
check(
  "foreign-LB record (0xCC) NOT in extra",
  !extraWaveDids.includes(0xCC),
);
check(
  "missing-world_pos record (0xDD) NOT in extra",
  !extraWaveDids.includes(0xDD),
);

console.log("=========================");
if (failed === 0) {
  console.log(`PASS: all ${passed} Batch 13 #21 checks green.`);
  process.exit(0);
} else {
  console.log(`FAIL: ${failed} check(s) failed (${passed} passed).`);
  process.exit(1);
}
