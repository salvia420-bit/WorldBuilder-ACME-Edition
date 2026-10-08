// test_ws12_cast_audio.mjs — WS12 (cast audio: windup / cast / fizzle / launch / impact).
//   PART 1 behavioral: the windup-hum SoundTweaked hooks drain exactly once
//           each across a simulated cast one-shot at CAST_SPEED=2, through the
//           SHIPPED playhead hook helpers (scene3d/hook_windows.js: the
//           frame-exit retime, the drain clock + windows, the direction gate).
//           No THREE / no wasm / no browser. Ground truth (DAT raw bytes, anim
//           0x030005A0 @ 24fps, 60f=2.5s): SoundTweaked wave 0x0A000390 @
//           frames 0/15/30/53/57, [gid, prob=1.0, prio=0.9, vol 0.2..0.6].
//           None is on the clip's last frame (59), so retail fires all five.
//   PART 2 static: entities.js + url-flags.md carry the WS12 patch shapes —
//           P1 (cancelCastSequence frees the playhead one-shot so trailing hum
//               hooks don't fire post-cancel; the ?castCancelStops mixer gate
//               was removed with the mixer 2026-10-05),
//           P2 (the SoundTable(2) executor backfills the LOCAL player's soundTableDid
//               to the humanoid table 0x20000001 when it's 0 — default-ON, no flag).
// Run: node tests/test_ws12_cast_audio.mjs   (from apps/holtburger-web/)
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import {
  retimeHooksToFrameExit, unifiedHookTime, drainHookWindows, hookFiresInDirection,
} from "../scene3d/hook_windows.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
let failed = 0, passed = 0;
const check = (n, ok, d) => { console.log(`  [${ok ? "OK" : "FAIL"}] ${n}${d ? " — " + d : ""}`); ok ? passed++ : failed++; };

// ---- PART 1: windup-hum drain through the shipped hook helpers ----
const FPS = 24;
const NF = 60;
const FT = Float32Array.from({ length: NF }, (_, f) => f / FPS); // the bake's frame starts
const HUM = [
  { frame: 0,  soundVolume: 0.2 },
  { frame: 15, soundVolume: 0.3 },
  { frame: 30, soundVolume: 0.4 },
  { frame: 53, soundVolume: 0.5 },
  { frame: 57, soundVolume: 0.6 },
].map((h) => ({ ...h, time: FT[h.frame], hookType: 21, direction: 1, soundProbability: 1.0, soundWaveId: 0x0a000390 }));
const CLIP = NF / FPS;
// A cast one-shot on the playhead: the clip time advances dtWall * timeScale
// and clamps on the last frame (motion_sequence.rs one-shot `done`); each tick
// drains the frame-exit timeline up to the floor frame's start, as
// entities.js `_drainUnifiedHooks` does. probability 1.0 always passes.
function simulateCast(timeScale, dtWall) {
  const { timeline } = retimeHooksToFrameExit(HUM, FT, [0], [NF], NF, FPS);
  const fired = [];
  let cursor = -1;
  let t = 0;
  for (let g = 0; g < 100000 && t < CLIP; g += 1) {
    t = Math.min(CLIP, t + dtWall * timeScale);
    const gf = Math.min(NF - 1, Math.floor(t * FPS + 1e-9));
    cursor = drainHookWindows(cursor, unifiedHookTime(gf, FT, FPS), CLIP, false, -1, (lo, hi) => {
      for (const h of timeline) if (h.time > lo && h.time <= hi && hookFiresInDirection(h, 1)) fired.push(h);
    });
  }
  return fired;
}

console.log("PART 1: windup-hum drain (shipped hook_windows.js helpers)");
{ const f = simulateCast(2.0, 1 / 60);
  check("CAST_SPEED=2: all 5 hum hooks fire exactly once", f.length === 5, `fired=${f.length}`);
  check("CAST_SPEED=2: waves are all 0x0A000390", f.every((h) => h.soundWaveId === 0x0a000390));
  check("CAST_SPEED=2: volume ramp preserved 0.2..0.6 in order",
    JSON.stringify(f.map((h) => h.soundVolume)) === JSON.stringify([0.2, 0.3, 0.4, 0.5, 0.6])); }
{ const f = simulateCast(2.0, 1 / 60); check("frame-0 hum fires (as frame 0 is left)", f.some((h) => h.frame === 0)); }
{ const f = simulateCast(5.0, 1 / 60); check("timeScale=5 (compressed windup): all 5 fire once", f.length === 5, `fired=${f.length}`); }
{ const f = simulateCast(2.0, 1 / 30);
  check("30fps drain: the frame-57 hum still fires before the clamp",
    f.length === 5 && f.some((h) => h.frame === 57), `fired=${f.length}`); }
{ const f = simulateCast(2.0, 1 / 90); const t = f.map((h) => h.frame);
  check("no double-fire across fine 90fps ticks", new Set(t).size === t.length && t.length === 5, `frames=${t.length}`); }

// ---- PART 2: static source shape ----
console.log("PART 2: static source shape");
const ent = readFileSync(join(ROOT, "scene3d/entities.js"), "utf8");

// P1 — since the animation consolidation (2026-10-05) every cast/swing gesture is
// a one-shot on the Rust playhead, and cancelCastSequence FREES it (plus its
// pending queue) so its trailing windup-hum hooks can't fire post-cancel. The
// mixer-overlay stop loop and its `?castCancelStops` gate were removed with the
// mixer (there is nothing else to stop).
check("cancelCastSequence frees the in-flight playhead one-shot (+ pending queue)",
  /cancelCastSequence\(guid, cause\) \{[\s\S]{0,800}if \(inst\._unifiedSeq\?\.clearOnDone\) \{\s*this\._clearUnifiedQueue\(inst\);\s*try \{ inst\._unifiedSeq\.seq\.free\(\);[\s\S]{0,80}inst\._unifiedSeq = null;/.test(ent));
check("CAST_CANCEL_STOPS mixer gate is gone (no second path)",
  !/CAST_CANCEL_STOPS/.test(ent));

// P2 — SoundTable(2) executor: `let stbDid` + local-player 0x20000001 backfill on 0.
check("P2: type-2 executor uses `let stbDid` (rebindable for backfill)",
  /let stbDid = inst\.soundTableDid >>> 0;/.test(ent));
check("P2: local-player soundTableDid backfill to humanoid table 0x20000001",
  /getLocalPlayerGuid[\s\S]{0,300}inst\.guid >>> 0\) === lpg[\s\S]{0,120}inst\.soundTableDid = 0x20000001;[\s\S]{0,60}stbDid = 0x20000001;/.test(ent));
check("P2: backfill is guarded on stbDid === 0 (never regresses a non-zero table)",
  /let stbDid = inst\.soundTableDid >>> 0;[\s\S]{0,1200}if \(stbDid === 0\) \{[\s\S]{0,120}getLocalPlayerGuid/.test(ent));
// P2 ships default-ON with no flag — assert it is NOT gated behind a URL flag.
check("P2 backfill has NO flag gate (zero-risk audio backfill, default-ON)",
  !/if \([A-Z_]+\)[\s\S]{0,120}inst\.soundTableDid = 0x20000001;/.test(ent));

const flags = readFileSync(join(ROOT, "docs/url-flags.md"), "utf8");
check("url-flags.md marks ?castCancelStops REMOVED",
  /\|\s*~~`castCancelStops`~~\s*\|[^\n]*REMOVED/.test(flags));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
