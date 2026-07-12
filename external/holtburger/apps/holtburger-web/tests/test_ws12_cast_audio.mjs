// test_ws12_cast_audio.mjs — WS12 (cast audio: windup / cast / fizzle / launch / impact).
//   PART 1 behavioral (7 checks): the windup-hum SoundTweaked hooks drain exactly
//           once each across a simulated cast overlay at CAST_SPEED=2, using the
//           REAL pure planner (scene3d/hook_windows.js). No THREE / no wasm / no
//           browser. Ground truth (DAT raw bytes, anim 0x030005A0 @ 24fps, 60f=2.5s):
//           SoundTweaked wave 0x0A000390 @ frames 0/15/30/53/57,
//           [gid, prob=1.0, prio=0.9, vol 0.2..0.6].
//   PART 2 static: entities.js + url-flags.md carry the WS12 patch shapes —
//           P1 (?castCancelStops, strict `=on`, stop the running cast/swing overlay
//               in cancelCastSequence so trailing hum hooks don't fire post-cancel),
//           P2 (the SoundTable(2) executor backfills the LOCAL player's soundTableDid
//               to the humanoid table 0x20000001 when it's 0 — default-ON, no flag).
// Run: node tests/test_ws12_cast_audio.mjs   (from apps/holtburger-web/)
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { planHookWindows } from "../scene3d/hook_windows.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
let failed = 0, passed = 0;
const check = (n, ok, d) => { console.log(`  [${ok ? "OK" : "FAIL"}] ${n}${d ? " — " + d : ""}`); ok ? passed++ : failed++; };

// ---- PART 1: windup-hum drain against the REAL planner ----
const HUM = [
  { time: 0 / 24,  hookType: 21, direction: 1, soundProbability: 1.0, soundVolume: 0.2, soundWaveId: 0x0a000390 },
  { time: 15 / 24, hookType: 21, direction: 1, soundProbability: 1.0, soundVolume: 0.3, soundWaveId: 0x0a000390 },
  { time: 30 / 24, hookType: 21, direction: 1, soundProbability: 1.0, soundVolume: 0.4, soundWaveId: 0x0a000390 },
  { time: 53 / 24, hookType: 21, direction: 1, soundProbability: 1.0, soundVolume: 0.5, soundWaveId: 0x0a000390 },
  { time: 57 / 24, hookType: 21, direction: 1, soundProbability: 1.0, soundVolume: 0.6, soundWaveId: 0x0a000390 },
];
const CLIP = 60 / 24;
// Replicates entities.js _fireHooksInRange (t <= lowExclusive) + _fireHook type-21
// A-DIR/prob gate (probability >= 1.0 short-circuits; direction === -1 dropped).
function fireRange(tl, low, high, fired, rng) {
  for (const h of tl) {
    if (h.time <= low) continue;
    if (h.time > high) break;
    if ((h.direction | 0) === -1) continue;               // A-DIR gate
    if (!(h.soundProbability >= 1.0 || rng() < h.soundProbability)) continue;
    fired.push(h);
  }
}
// Simulates the LoopOnce overlay drain: advance action.time by dtWall*timeScale
// each rAF, plan the hook windows with the real planner, fire, seed lastTime.
function simulateOverlay(timeScale, dtWall, rng = () => 0) {
  let lastTime = -1, actionTime = 0, running = true; const fired = []; let g = 0;
  while (g++ < 100000) {
    actionTime = Math.min(CLIP, actionTime + dtWall * timeScale);
    running = actionTime < CLIP;
    const plan = planHookWindows({ lastTime, currentTime: actionTime, clipDuration: CLIP, isRunning: running, isLoopOnce: true });
    for (const w of plan.windows) fireRange(HUM, w[0], w[1], fired, rng);
    if (running) lastTime = actionTime; else if (plan.drainedTo !== null) lastTime = plan.drainedTo;
    if (!running) break;
  }
  return fired;
}

console.log("PART 1: windup-hum drain (real hook_windows.js planner)");
{ const f = simulateOverlay(2.0, 1 / 60);
  check("CAST_SPEED=2: all 5 hum hooks fire exactly once", f.length === 5, `fired=${f.length}`);
  check("CAST_SPEED=2: waves are all 0x0A000390", f.every((h) => h.soundWaveId === 0x0a000390));
  check("CAST_SPEED=2: volume ramp preserved 0.2..0.6 in order",
    JSON.stringify(f.map((h) => h.soundVolume)) === JSON.stringify([0.2, 0.3, 0.4, 0.5, 0.6])); }
{ const f = simulateOverlay(2.0, 1 / 60); check("frame-0 hum fires (lastTime=-1 seed)", f.some((h) => h.time === 0)); }
{ const f = simulateOverlay(5.0, 1 / 60); check("timeScale=5 (compressed windup): all 5 fire once", f.length === 5, `fired=${f.length}`); }
{ const f = simulateOverlay(2.0, 1 / 30);
  check("30fps drain: trailing (2.208s,2.375s) hooks still fire",
    f.length === 5 && f.some((h) => Math.abs(h.time - 57 / 24) < 1e-6), `fired=${f.length}`); }
{ const f = simulateOverlay(2.0, 1 / 90); const t = f.map((h) => h.time);
  check("no double-fire across fine 90fps ticks", new Set(t).size === t.length && t.length === 5, `times=${t.length}`); }

// ---- PART 2: static source shape ----
console.log("PART 2: static source shape");
const ent = readFileSync(join(ROOT, "scene3d/entities.js"), "utf8");

// P1 — flag is strict `=== "on"` opt-in (default-OFF; flag footgun).
check("entities.js defines CAST_CANCEL_STOPS (strict =='on' opt-in)",
  /CAST_CANCEL_STOPS[\s\S]{0,400}get\("castCancelStops"\)\s*\?\.\s*toLowerCase\(\)\s*===\s*"on"/.test(ent));
// P1 — cancelCastSequence stops the running cast/swing LoopOnce overlay under the flag,
//      restricted to swing:/link: keys, routed through _completeOverlay then .stop().
check("cancelCastSequence stops cast/swing overlays under CAST_CANCEL_STOPS",
  /cancelCastSequence\(guid, cause\) \{[\s\S]{0,3200}if \(CAST_CANCEL_STOPS && inst\.actions && inst\.mixer\)[\s\S]{0,600}action\.stop\(\)/.test(ent));
check("P1 loop is restricted to swing:/link: overlay keys",
  /CAST_CANCEL_STOPS && inst\.actions && inst\.mixer\)[\s\S]{0,400}key\.startsWith\("swing:"\)\s*\|\|\s*key\.startsWith\("link:"\)/.test(ent));
check("P1 routes the base-restore/cancel-notify through _completeOverlay",
  /CAST_CANCEL_STOPS && inst\.actions && inst\.mixer\)[\s\S]{0,500}this\._completeOverlay\(inst, key, action, false\)/.test(ent));
// P1 — flag-OFF byte-identical: the whole stop loop sits behind the CAST_CANCEL_STOPS gate.
check("P1 stop loop is entirely inside the CAST_CANCEL_STOPS gate (flag-OFF byte-identical)",
  /if \(CAST_CANCEL_STOPS && inst\.actions && inst\.mixer\)\s*\{[\s\S]{0,700}\}\s*\n\s*try \{/.test(ent));

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
check("url-flags.md documents ?castCancelStops with default off",
  /\|\s*`castCancelStops`\s*\|[^|]*\|\s*\*\*off\*\*\s*\|/.test(flags));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
