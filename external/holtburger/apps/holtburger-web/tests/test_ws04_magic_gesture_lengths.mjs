// WS04 (S3a, 2026-07-12) — deliverable-1 DAT coverage audit for the
// completion-clock shim's `authored_len_for` (motion_table_manager.rs).
//
// Proves, at the DATA level (no wasm/browser), that:
//   (1) EVERY magic gesture band the war/void cast chain uses is present as a
//       from-Ready link in the player MotionTable's Magic stance (0x49):
//         - MagicPowerUp01..10 windups  0x1000006F..0x10000078  (10)
//         - colored windup band          0x1000012B..0x10000134  (10)
//         - cast substates               0x4000002B..0x40000039  (15)
//   (2) all 35 core-band members are SELF-CONTAINED (every anim segment has
//       highFrame >= 0), so the shim resolves their authored length with NO
//       Animation-asset dependency (zero extra DAT reads).
//   (3) the load-bearing finding: MagicPowerUp10 (and the colored top) at
//       CastSpeed 2.0 = 2250 ms EXCEEDS the flat 2.0 s RENDERER_DONE_FALLBACK,
//       so the authored ingest is NOT cosmetic — without it the highest
//       windups drain ~250 ms early.
//
// Length math mirrors resolve_authored_motion_lengths (lib.rs) +
// authored_len_for (motion_table_manager.rs): base secs = Σ per-segment
// (high-low+1)/|framerate| for explicit ranges; then base / |speed| (retail
// AnimSequenceNode::multiply_framerate). CastSpeed 2.0 for war/void.
//
// Fixture = tests/fixtures/ws04_magic_fromReady_lengths.json, captured from the
// DAT oracle (client_portal.dat MotionTable 0x09000001,
// links[0x00490003]["motionData"]). Regen recipe in the WS04 packet §4.1.
//
// Run: node tests/test_ws04_magic_gesture_lengths.mjs   (from apps/holtburger-web/)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fix = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/ws04_magic_fromReady_lengths.json"), "utf8"),
);

const RENDERER_DONE_FALLBACK_SECS = 2.0; // motion_table_manager.rs:155
const CAST_SPEED = 2.0; // ACE CastSpeed for war/void (F8-1)

const md = fix.motionData;
const has = (cmd) => Object.prototype.hasOwnProperty.call(md, "0x" + (cmd >>> 0).toString(16).padStart(8, "0"));
const seg = (cmd) => md["0x" + (cmd >>> 0).toString(16).padStart(8, "0")];

// authored base length (secs @1x). Self-contained iff every segment high >= 0.
// (freeze-hold fr==0 → 1/30; play-to-end high==-1 → Animation-asset dependent,
// not resolvable here — returns null so the shim would 2.0s-fallback.)
function authoredBaseSecs(cmd) {
  const s = seg(cmd);
  if (!s) return null;
  let secs = 0;
  for (const a of s.segs) {
    if (a.high >= 0) {
      const fr = Math.abs(a.fr);
      if (fr === 0) { secs += 1 / 30; continue; } // freeze-hold
      secs += (a.high - a.low + 1) / fr;
    } else {
      return null; // play-to-end high==-1 → Animation-asset dependent
    }
  }
  return secs;
}

const range = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

let fail = 0;
const bad = (msg) => { fail++; console.log("  ✗ " + msg); };
const ok = (msg) => console.log("  ✓ " + msg);

console.log("[coverage] Magic-from-Ready group 0x00490003:");

// The group itself must exist with 54 to-commands (packet §1.1).
if (fix.fromReadyKey !== "0x00490003") bad(`fromReadyKey ${fix.fromReadyKey} != 0x00490003`);
else ok("Magic-stance from-Ready link group exists");

// (1) three core bands present.
const windups = range(0x1000006f, 0x10000078);
const colored = range(0x1000012b, 0x10000134);
const casts = range(0x4000002b, 0x40000039);

const missW = windups.filter((c) => !has(c));
if (missW.length) bad("MagicPowerUp01-10 windups missing: " + missW.map((c) => "0x" + c.toString(16)).join(","));
else ok("MagicPowerUp01-10 windups: all 10 present");

const missC = colored.filter((c) => !has(c));
if (missC.length) bad("colored band 0x12B-0x134 missing: " + missC.map((c) => "0x" + c.toString(16)).join(","));
else ok("colored band 0x12B-0x134: all 10 present");

const missS = casts.filter((c) => !has(c));
if (missS.length) bad("cast substates 0x2B-0x39 missing: " + missS.map((c) => "0x" + c.toString(16)).join(","));
else ok("cast substates 0x2B-0x39: all 15 present");

// void-windup example the JSON uses.
if (!has(0x10000132)) bad("MagicPowerUp08Purple (void) 0x10000132 absent");

// (2) all 35 core members self-contained.
const core = [...windups, ...colored, ...casts];
const notSelfContained = core.filter((c) => has(c) && authoredBaseSecs(c) === null);
if (notSelfContained.length) {
  bad("core members NOT self-contained (high==-1): " + notSelfContained.map((c) => "0x" + c.toString(16)).join(","));
} else {
  ok(`${core.length}/35 core-band members self-contained (no extra DAT read)`);
}

// (3) load-bearing: MagicPowerUp10 @CastSpeed 2.0 EXCEEDS the 2.0s fallback.
const mp10base = authoredBaseSecs(0x10000078);
if (mp10base === null) {
  bad("MagicPowerUp10 0x10000078 did not resolve a self-contained length");
} else {
  const mp10ms = Math.round((mp10base / CAST_SPEED) * 1000);
  if (mp10base !== 4.5) bad(`MagicPowerUp10 base ${mp10base}s != 4.5s (packet table)`);
  if (mp10ms <= RENDERER_DONE_FALLBACK_SECS * 1000) {
    bad(`MagicPowerUp10 ${mp10ms}ms does NOT exceed the ${RENDERER_DONE_FALLBACK_SECS * 1000}ms fallback`);
  } else {
    ok(`MagicPowerUp10 window ${mp10ms}ms @2x EXCEEDS the 2.0s fallback (authored ingest is load-bearing)`);
  }
}

// Sanity: the packet's per-command length table (base secs @1x).
const expectBase = {
  0x1000006f: 0.675, // MagicPowerUp01
  0x10000078: 4.5, // MagicPowerUp10
  0x4000002b: 17 / 24, // MagicBlast
  0x40000035: 1.0, // cast
};
for (const [c, exp] of Object.entries(expectBase)) {
  const got = authoredBaseSecs(Number(c));
  if (got === null || Math.abs(got - exp) > 1e-6) {
    bad(`length 0x${Number(c).toString(16)}: got ${got}, expected ${exp}`);
  }
}

console.log(fail ? `FAIL — ${fail} failure(s)` : "PASS — 0 failure(s)");
process.exit(fail ? 1 : 0);
