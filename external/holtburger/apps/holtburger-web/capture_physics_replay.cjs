#!/usr/bin/env node
// capture_physics_replay.cjs — Wave 3.A physics-replay-trace capture.
//
// Drives a Playwright/CDP session through:
//   1. Login as `phaseN_diag_<RUN_ID>` (rotating account per run; per
//      project_wave3_prereq_2026-05-19 the keepalive doesn't fix the
//      account-lock ghost-session quirk on rapid relog — only account
//      rotation does). ACE auto-promotes every fresh account to Developer
//      via Config.js DefaultAccessLevel=4, so no SQL setup needed.
//   2. Spawn first character (auto-create with unique name if account is empty).
//   3. @telepoi Holtburg + @pk pk (FastTick required for client physics echo).
//   4. Run the probe scenario from
//      fixtures/physics/probe-scenario.json — phases of forward/turn/jump
//      inputs at deterministic tick counts.
//   5. Capture per-tick state (pos via getLocalPlayerPose, cellId, isIndoor,
//      input snapshot) into a trace JSON.
//
// Output: writes trace-subject.json to
//   /mnt/wbterminal1/holtburger-validator-reports/physics-replay/<ts>/
// and prints that path on the last line of stdout (the validator
// subprocess-greps for it).
//
// Pre-reqs (per project_wave3_prereq_2026-05-19):
//   - ACE.Server running on 127.0.0.1:9000 (login) / 9001 (world)
//   - holtburger-wsbridge running on ws://127.0.0.1:8080/
//   - python3 -m http.server 8765 from external/holtburger/
//   - dist/ baked (manifest+shards)
//   - Wasm bundle includes the PingRequest keepalive arm (already shipped
//     in apps/holtburger-web/src/lib.rs::recv_loop, ~line 17385).
//
// Run: `node capture_physics_replay.cjs`
//   Env overrides:
//     RUN_ID            — explicit run identifier (default: Date.now().toString(36)).
//                          Tells the validator which account name was used.
//     PHASE4_BRIDGE_URL — ws bridge (default ws://127.0.0.1:8080/).
//     PHASE4_SERVER_IP  — ACE IP (default 127.0.0.1; tailnet 100.116.47.66 also works).
//     PHASE4_SERVER_PORT — ACE login UDP port (default 9000).
//     PHASE4_PAGE_URL   — page URL (default 127.0.0.1:8765/apps/holtburger-web/index.html).
//     PHYSICS_REPLAY_OUT — explicit output dir (default: timestamp-pathed).
//     PHYSICS_REPLAY_SCENARIO — probe scenario JSON (default: bundled fixture).
//     PHYSICS_REPLAY_TICK_BUDGET_MS — wall-clock budget per scenario tick (default 16.667).
//
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// ── Playwright resolve (matches capture_fps_telemetry_probe pattern) ──────
let chromium;
const PLAYWRIGHT_CANDIDATES = [
  process.env.PLAYWRIGHT_CACHE,
  "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright",
  "/home/wbterminal/.npm/node_modules/playwright",
  path.join(os.homedir(), "AppData/Roaming/npm/node_modules/playwright"),
  "playwright",
].filter(Boolean);
for (const candidate of PLAYWRIGHT_CANDIDATES) {
  try {
    chromium = require(candidate).chromium;
    break;
  } catch (_e) { /* try next */ }
}
if (!chromium) {
  console.error("FATAL: playwright not found");
  process.exit(2);
}

// ── Config ──────────────────────────────────────────────────────────────
const RUN_ID = process.env.RUN_ID || `auto_${Date.now().toString(36)}`;
const ACCOUNT = `phaseN_diag_${RUN_ID}`;
const PASSWORD = ACCOUNT;
const CHAR_NAME = `W3a${RUN_ID.slice(-8)}`; // ≤12 chars for ACE name limit
const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL || "ws://127.0.0.1:8080/";
const SERVER_IP = process.env.PHASE4_SERVER_IP || "127.0.0.1";
const SERVER_PORT = process.env.PHASE4_SERVER_PORT || "9000";
const PAGE_URL = process.env.PHASE4_PAGE_URL
  || "http://127.0.0.1:8765/apps/holtburger-web/index.html";

const SCENARIO_PATH = process.env.PHYSICS_REPLAY_SCENARIO
  || path.resolve(__dirname, "fixtures/physics/probe-scenario.json");

const TS_SLUG = new Date().toISOString().replace(/\.[0-9]{3}Z$/, "Z").replace(/:/g, "-");
const OUT_DIR = process.env.PHYSICS_REPLAY_OUT
  || path.join("/mnt/wbterminal1/holtburger-validator-reports/physics-replay", `${TS_SLUG}_${RUN_ID}`);

const SMOKE_TIMEOUT_MS = Number(process.env.PHYSICS_REPLAY_SMOKE_TIMEOUT_MS || 60_000);
const SPAWN_TIMEOUT_MS = Number(process.env.PHYSICS_REPLAY_SPAWN_TIMEOUT_MS || 60_000);
const CREATE_TIMEOUT_MS = Number(process.env.PHYSICS_REPLAY_CREATE_TIMEOUT_MS || 30_000);
const POST_SPAWN_DRAIN_MS = Number(process.env.PHYSICS_REPLAY_POST_SPAWN_DRAIN_MS || 6_000);
const POST_TELEPORT_DRAIN_MS = Number(process.env.PHYSICS_REPLAY_POST_TELEPORT_DRAIN_MS || 6_000);
const TICK_BUDGET_MS = Number(process.env.PHYSICS_REPLAY_TICK_BUDGET_MS || 16.667);

fs.mkdirSync(OUT_DIR, { recursive: true });
console.log(`[w3a-cap] runId=${RUN_ID}`);
console.log(`[w3a-cap] account=${ACCOUNT}`);
console.log(`[w3a-cap] outDir=${OUT_DIR}`);
console.log(`[w3a-cap] scenario=${SCENARIO_PATH}`);

const scenario = JSON.parse(fs.readFileSync(SCENARIO_PATH, "utf8"));

// ── Helpers ─────────────────────────────────────────────────────────────

function expandPhases(phases) {
  // Flatten the phase list into a per-tick input stream: array of
  //   { phaseIdx, phaseKind, input, jumpEdge }
  // length = sum(phase.ticks). For the `jump` phase, the first tick is
  // edge-triggered (jump=true) and the remaining ticks are airborne
  // observation (jump=false).
  const stream = [];
  phases.forEach((phase, idx) => {
    const ticks = phase.ticks ?? 0;
    for (let i = 0; i < ticks; i++) {
      let input = { ...phase.input };
      if (phase.kind === "jump" && i > 0) {
        // Edge-trigger only on the first tick of a jump phase.
        input = { ...input, jump: false };
      }
      stream.push({
        phaseIdx: idx,
        phaseKind: phase.kind,
        input,
        edgeJump: phase.kind === "jump" && i === 0,
      });
    }
  });
  return stream;
}

const tickStream = expandPhases(scenario.phases);
console.log(`[w3a-cap] expanded ${scenario.phases.length} phases → ${tickStream.length} ticks`);

// ── Playwright orchestration ────────────────────────────────────────────

(async () => {
  const browser = await chromium.launch({
    args: [
      `--use-gl=${process.env.PLAYWRIGHT_GL_BACKEND || "swiftshader"}`,
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-gpu-sandbox",
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();

  let consoleErrors = 0;
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") {
      consoleErrors += 1;
      // Truncate noise.
      if (consoleErrors <= 30) console.log(`  [browser err] ${text.slice(0, 200)}`);
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors += 1;
    console.error(`  [pageerror] ${err.message.slice(0, 200)}`);
  });

  // ─── Boot ─────────────────────────────────────────────────────
  console.log(`[w3a-cap] boot ${PAGE_URL}`);
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => /PASS/.test(document.getElementById("results")?.innerHTML || ""),
    { timeout: SMOKE_TIMEOUT_MS }
  );
  console.log(`[w3a-cap] smoke PASS`);

  // ─── Login ────────────────────────────────────────────────────
  await page.fill('input[name="account"]', ACCOUNT);
  await page.fill('input[name="password"]', PASSWORD);
  await page.fill('input[name="bridge_url"]', BRIDGE_URL);
  await page.fill('input[name="server_host"]', SERVER_IP);
  await page.fill('input[name="server_port"]', SERVER_PORT);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector("#selection:not([hidden])", { timeout: 90_000 });
  console.log(`[w3a-cap] login OK (${ACCOUNT})`);

  // ─── Character create + spawn ─────────────────────────────────
  const initialCount = await page.locator('#character-ul button[data-id]').count();
  if (initialCount === 0) {
    await page.fill('#create-form input[name="char_name"]', CHAR_NAME);
    await page.click('#create-button');
    await page.waitForFunction(
      () => /Created\b/.test(document.getElementById("create-status")?.innerText || ""),
      { timeout: CREATE_TIMEOUT_MS }
    );
    await page.waitForFunction(
      () => document.querySelectorAll('#character-ul button[data-id]').length > 0,
      { timeout: 10_000 }
    );
    console.log(`[w3a-cap] character "${CHAR_NAME}" created`);
  }
  await page.locator('#character-ul button[data-id]').first().click();
  await page.waitForFunction(
    () => /InWorld|Spawned/.test(document.getElementById("login-status")?.innerText || ""),
    { timeout: SPAWN_TIMEOUT_MS }
  );
  await page.waitForTimeout(POST_SPAWN_DRAIN_MS);
  console.log(`[w3a-cap] spawned`);

  // ─── @telepoi Holtburg + @pk pk (FastTick) ────────────────────
  await page.evaluate(() => {
    const h = window.__sessionHandle;
    if (h?.sendChat) {
      try { h.sendChat("@telepoi Holtburg"); } catch (_) {}
    }
  });
  console.log(`[w3a-cap] sent @telepoi Holtburg; draining ${POST_TELEPORT_DRAIN_MS}ms`);
  await page.waitForTimeout(POST_TELEPORT_DRAIN_MS);

  await page.evaluate(() => {
    const h = window.__sessionHandle;
    if (h?.sendChat) {
      try { h.sendChat("@pk pk"); } catch (_) {}
    }
  });
  await page.waitForTimeout(2_000);
  console.log(`[w3a-cap] sent @pk pk (FastTick)`);

  // ─── Move focus to canvas so input goes through ───────────────
  await page.evaluate(() => {
    if (document.activeElement && typeof document.activeElement.blur === "function") {
      document.activeElement.blur();
    }
  });
  await page.locator("#canvas").click({ position: { x: 256, y: 256 }, force: true });

  // ─── Confirm getLocalPlayerPose is exposed ────────────────────
  const probePose = await page.evaluate(() => {
    const h = window.__sessionHandle;
    if (!h || typeof h.getLocalPlayerPose !== "function") return null;
    const p = h.getLocalPlayerPose();
    if (!p) return null;
    return { x: p.x, y: p.y, z: p.z, heading: p.heading, lb: p.landblockId };
  });
  if (!probePose) {
    console.error(
      `[w3a-cap] FAIL: window.__sessionHandle.getLocalPlayerPose() returned null. ` +
      `The wasm side has not seeded the local player pose yet (pre-EnteredWorld) ` +
      `OR the SessionHandle binding broke. This is the load-bearing capture path; ` +
      `bailing rather than emitting a trace with NaN positions. ` +
      `Check: window.__sessionHandle in DevTools after spawn.`
    );
    fs.writeFileSync(path.join(OUT_DIR, "trace-subject.json"),
      JSON.stringify({ runId: RUN_ID, error: "no-local-pose", rows: [] }, null, 2));
    await browser.close();
    process.exit(2);
  }
  console.log(`[w3a-cap] initial pose: (${probePose.x.toFixed(2)}, ${probePose.y.toFixed(2)}, ${probePose.z.toFixed(2)}) heading=${probePose.heading.toFixed(3)} lb=0x${probePose.lb.toString(16).toUpperCase()}`);

  // ─── Wave 3.F: confirm setLastClientPrediction/getLastClientPrediction wired ──
  // The wasm bundle has these exports from the lib.rs side. UNDER ?renderer=3d
  // (the default since the 2D-pixi retirement, item 2) the tick-time writer is
  // `scene3d/camera.js::_advancePrediction` (item 9d, 2026-06-18) — the prior
  // 2D rAF writer at index.html:8318 was gated on the now-dead 2D sprite. This
  // capture is renderer-agnostic: it drives the default page + reads the wasm
  // shadow via getLastClientPrediction, so it validates whichever tap is live.
  // If either symbol is missing, the prediction shadow stays null and the
  // validator falls back to the legacy `pos` signal, which structurally cannot
  // pass the 0.10 m bar (W3.A documented gap).
  const w3fProbe = await page.evaluate(() => {
    const h = window.__sessionHandle;
    return {
      hasGetter: !!(h && typeof h.getLastClientPrediction === "function"),
      hasSetter: !!(h && typeof h.setLastClientPrediction === "function"),
    };
  });
  console.log(`[w3a-cap] W3.F shadow exposed: getter=${w3fProbe.hasGetter} setter=${w3fProbe.hasSetter}`);
  if (!w3fProbe.hasGetter || !w3fProbe.hasSetter) {
    console.warn(
      `[w3a-cap] WARNING: Wave 3.F prediction shadow is NOT wired ` +
      `(getter=${w3fProbe.hasGetter}, setter=${w3fProbe.hasSetter}). ` +
      `Validator will fall back to the W3.A legacy 'pos' subject and ` +
      `will report drift against the server-reconciled pose. Rebuild ` +
      `the wasm bundle with the W3.F changes if you intended to gate on ` +
      `pure-prediction parity.`
    );
  }

  // ─── Drive the tick stream ─────────────────────────────────────
  //
  // Strategy:
  //   - Pre-load the tick stream into a window-side queue so the page
  //     can self-pace at rAF.
  //   - Each tick: apply the input via keyboard.down/up; sample the
  //     pose before the next tick. We use page.keyboard.down/up rather
  //     than page.evaluate() to apply keys because the wasm side
  //     listens at document level and the page expects real DOM events.
  //   - The wasm side's __predLastPos updates AFTER its rAF integrator
  //     runs the next frame. We sample via getLocalPlayerPose which is
  //     a synchronous wasm getter that reflects the latest authoritative
  //     pose.
  //
  // The input axes map to keys:
  //   forward=1 → W; forward=-1 → S; strafe=1 → D; strafe=-1 → A;
  //   turn=1 → E; turn=-1 → Q; jump=true → Space (one-shot edge-trigger).
  //
  // We re-evaluate the held key set every tick and emit only the
  // delta to keyboard.down / keyboard.up so we don't re-fire keydown
  // events on every tick.

  console.log(`[w3a-cap] driving ${tickStream.length}-tick scenario`);
  const trace = [];
  const t0 = Date.now();

  let lastHeldKeys = new Set();
  function inputToKeys(input) {
    const keys = new Set();
    if (input.forward > 0) keys.add("w");
    if (input.forward < 0) keys.add("s");
    if (input.strafe > 0) keys.add("d");
    if (input.strafe < 0) keys.add("a");
    if (input.turn > 0) keys.add("e");
    if (input.turn < 0) keys.add("q");
    // Note: jump is edge-triggered separately; we don't hold Space.
    if (input.run === false) keys.add("Shift");
    return keys;
  }

  for (let tickIdx = 0; tickIdx < tickStream.length; tickIdx++) {
    const tickPlan = tickStream[tickIdx];
    const tickStartMs = Date.now();
    const targetKeys = inputToKeys(tickPlan.input);

    // Compute key deltas
    const toRelease = [...lastHeldKeys].filter((k) => !targetKeys.has(k));
    const toPress = [...targetKeys].filter((k) => !lastHeldKeys.has(k));
    for (const k of toRelease) {
      try { await page.keyboard.up(k); } catch (_) {}
    }
    for (const k of toPress) {
      try { await page.keyboard.down(k); } catch (_) {}
    }
    lastHeldKeys = targetKeys;

    // Edge-trigger Space for the jump phase
    if (tickPlan.edgeJump) {
      try {
        await page.keyboard.down("Space");
        await page.keyboard.up("Space");
      } catch (_) {}
    }

    // Sample pose + side state via one page.evaluate() round-trip.
    const sample = await page.evaluate(() => {
      const out = {
        pos: [NaN, NaN, NaN],
        // Wave 3.F (2026-05-19): pure-prediction shadow read via the
        // new wasm getter `getLastClientPrediction`. This is the
        // load-bearing replacement for `pos` as the validator's
        // subject signal — `pos` (sourced from `getLocalPlayerPose`)
        // reflects the SERVER-RECONCILED pose, which surfaced as
        // ~2.8 m max drift vs the 0.10 m bar in the W3.A baseline.
        prediction: null,
        onGround: null,
        cellId: null,
        isIndoor: null,
        predTickCount: null,
        predLastPos: null,
      };
      const h = window.__sessionHandle;
      if (h && typeof h.getLocalPlayerPose === "function") {
        const p = h.getLocalPlayerPose();
        if (p) {
          out.pos = [p.x, p.y, p.z];
        }
      }
      // Wave 3.F: pure-prediction shadow. May be null pre-spawn or if
      // the rAF integrator hasn't ticked yet. Carries position +
      // velocity + on_ground + tick_count + t_ms in the same units as
      // the C# OracleSim integrates.
      if (h && typeof h.getLastClientPrediction === "function") {
        const pred = h.getLastClientPrediction();
        if (pred) {
          out.prediction = {
            position: [pred.position_x, pred.position_y, pred.position_z],
            velocity: [pred.velocity_x, pred.velocity_y, pred.velocity_z],
            onGround: pred.on_ground,
            tickCount: pred.tick_count,
            tMs: pred.t_ms,
          };
        }
      }
      // Cell + indoor state from index.html:5047-5051
      if (typeof window.__currentCellId === "number") out.cellId = window.__currentCellId >>> 0;
      if (typeof window.__isIndoor === "boolean") out.isIndoor = window.__isIndoor;
      // __predLastPos cross-check (planar only; gives us a redundant
      // signal that the JS prediction tick is firing — if pos and
      // predLastPos diverge significantly the server reset us).
      if (window.__predLastPos) {
        out.predLastPos = { x: window.__predLastPos.x, y: window.__predLastPos.y };
      }
      if (typeof window.__predTickCount === "number") out.predTickCount = window.__predTickCount;
      // on_ground predicate now sourced from the prediction shadow when
      // available (Wave 3.F). The W3.A heuristic stays as a fallback so
      // the C# oracle has something to anchor against on the
      // PublicUpdatePosition-pose subject mode.
      return out;
    });

    // Determine on-ground from the C# oracle's perspective: the
    // wasm side doesn't yet expose CPhysicsObj::on_ground (1 bit
    // away from acclient.h's CONTACT_TS|ON_WALKABLE_TS). For W3.A
    // we leave subject.onGround = null and let the C# replay engine
    // count those rows as "subject-missing" — see scope note in
    // CommandEngine.PhysicsParity.cs::PhysicsReplayTrace.
    //
    // Derived heuristic (informational only, not in C# acceptance):
    // we *can* claim on-ground when the player is outdoor and the
    // game-time pose Z hasn't changed appreciably from terrain Z.
    // This is best-effort; the C# oracle's own on_ground state is
    // load-bearing for the on-ground gate, not this heuristic.
    const onGroundHeuristic = sample.isIndoor === false ? true : null;

    trace.push({
      tick: tickIdx,
      timeSec: (Date.now() - t0) / 1000.0,
      pos: sample.pos,
      // Wave 3.F: pure-prediction shadow (preferred subject signal).
      // The C# replay engine reads this when present and falls back to
      // `pos` only if the prediction is null (pre-spawn / handle not
      // wired). Carries the integrator's actual output, not the
      // server-reconciled pose.
      prediction: sample.prediction,
      onGround: onGroundHeuristic, // null → C# treats as SKIP
      cellId: sample.cellId,
      isIndoor: sample.isIndoor,
      predTickCount: sample.predTickCount,
      input: {
        forward: tickPlan.input.forward,
        strafe: tickPlan.input.strafe,
        turn: tickPlan.input.turn,
        jump: tickPlan.edgeJump === true,
        run: tickPlan.input.run !== false,
      },
      phaseKind: tickPlan.phaseKind,
    });

    // Pace at the tick budget (~16.7 ms = 60 Hz). page.evaluate
    // already eats 1-5ms per round-trip; we sleep the remainder.
    const elapsedThisTick = Date.now() - tickStartMs;
    const sleepMs = Math.max(0, TICK_BUDGET_MS - elapsedThisTick);
    if (sleepMs > 0) {
      await page.waitForTimeout(sleepMs);
    }
    // Periodic progress
    if ((tickIdx + 1) % 200 === 0 || tickIdx === tickStream.length - 1) {
      const last = trace[trace.length - 1];
      const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `[w3a-cap] tick ${(tickIdx + 1).toString().padStart(4)}/${tickStream.length} ` +
        `t=${elapsedSec}s ` +
        `pos=(${last.pos[0].toFixed(2)}, ${last.pos[1].toFixed(2)}, ${last.pos[2].toFixed(2)}) ` +
        `cell=${last.cellId !== null ? "0x" + last.cellId.toString(16).padStart(8, "0").toUpperCase() : "-"} ` +
        `phase=${last.phaseKind}`
      );
    }
  }

  // Release any held keys.
  for (const k of lastHeldKeys) {
    try { await page.keyboard.up(k); } catch (_) {}
  }

  // ─── Write the subject trace ──────────────────────────────────
  const totalSec = (Date.now() - t0) / 1000;
  const tracePath = path.join(OUT_DIR, "trace-subject.json");
  const payload = {
    runId: RUN_ID,
    account: ACCOUNT,
    capturedAt: new Date().toISOString(),
    scenarioName: scenario.name,
    scenarioPath: SCENARIO_PATH,
    tickHz: scenario.tickHz,
    totalSec,
    rowCount: trace.length,
    consoleErrors,
    initialPose: probePose,
    rows: trace,
  };
  fs.writeFileSync(tracePath, JSON.stringify(payload, null, 2));
  console.log(`[w3a-cap] wrote ${tracePath} (${(JSON.stringify(payload).length / 1024).toFixed(1)} KB)`);

  await browser.close();

  // Final-line contract: print the trace path so the validator can
  // grep it from stdout.
  console.log(`TRACE_SUBJECT_PATH=${tracePath}`);
  process.exit(0);
})().catch((err) => {
  console.error("[w3a-cap] FATAL:", err?.stack || err?.message || err);
  process.exit(2);
});
