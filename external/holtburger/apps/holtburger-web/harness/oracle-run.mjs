// oracle-run.mjs — the holtburger-side scenario driver.
//
// Boots holtburger in a headless browser with `?moveTelemetry=1`, teleports to
// the fixed capture site, replays a scenario's timed input events, drains the
// wasm telemetry ring, and writes the JSONL the differ reads plus a sidecar
// `.meta.json` of run quality. The retail side of the same scenario is driven
// by keystrokes into the Wine client (see docs/reengineering/oracle/WINE-RIG.md).
//
// CONSTRAINTS THIS FILE RESPECTS — read before "simplifying":
//
// * `?nullRender=1` is FORBIDDEN here. It skips render(), and movement needs
//   real ticks; a null-rendered run produces a plausible-looking but wrong
//   curve.
// * MOVEMENT TICKS MUST NOT RIDE rAF ON THIS BOX (session 2). The wasm
//   `TickMovement` arm emits one telemetry record per tick, and JS enqueues
//   one tick per rAF frame — so the sample rate IS the frame rate. Under
//   SwiftShader the laptop renders ~1.9 fps even with `?targetFps=20`, which
//   is why session 1 captured 13 records in 14 s and could not measure a
//   single non-steady metric. `?renderOnDemand=1&netDrainHz=30` moves the
//   tick enqueue onto the net-drain interval (scene3d/index.js `syncTickHop`)
//   and stops rendering entirely. MEASURED on the same box, same scenario:
//   `?targetFps=20` → 2.0 records/s, dt median 290 ms; this URL → 28.0
//   records/s, dt median 33 ms. That is the per-tick cadence the metrics need.
// * ONE headless browser at a time. The laptop has 8 GB and each chromium is
//   ~1.5 GB, so the launcher refuses to start under a free-memory floor
//   rather than triggering the OOM killer mid-capture.
// * `?nosw=1` on every URL. The service worker caches index.html and the
//   shards across reloads, and only `?nosw=1` clears it — without it you can
//   measure a stale build for hours.
//
// THE CAPTURE SITE IS PART OF THE MEASUREMENT. A scenario run from wherever
// the character last logged out is not reproducible and is not comparable to
// the retail side: session 1's holtburger run happened to be inside a dungeon
// with the avatar pinned against a wall, where the integrator reported 7.787
// m/s of intent while the avatar actually travelled ~1.5 m/s. Both sides now
// `@teleloc` to the one site in `scenarios.json.capture_site` first, and the
// driver records the realized-vs-intent ratio so a bad site is visible in the
// meta rather than silently priced into the parity number.
//
// Usage:
//   node harness/oracle-run.mjs --scenario run-hold --out holt.jsonl
//   node harness/oracle-run.mjs --all --out-dir fixtures/oracle/
//   node harness/oracle-run.mjs --list
//   node harness/oracle-run.mjs --selftest        # no browser needed

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execSync } from "node:child_process";
import { poseToGlobalXY } from "./lib/movement_gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS = path.join(HERE, "..", "docs", "reengineering", "oracle", "scenarios.json");

/** Minimum free MiB before we are willing to start a browser. */
export const FREE_MEM_FLOOR_MB = 1700;
/** A capture coarser than this median sample interval cannot carry accel/decel. */
export const MAX_SAMPLE_DT_MS = 60;
/** A single gap this large inside a capture means part of the run was not observed. */
export const MAX_STALL_MS = 500;
/** How many times to re-take a stalled capture before giving up on it. */
export const STALL_RETRIES = 2;

export function freeMemMb() {
  try {
    const out = execSync("free -m", { encoding: "utf8" });
    const line = out.split("\n").find((l) => /^Mem:/.test(l));
    // "available" is the last column and is the honest number (buff/cache is
    // reclaimable); "free" alone would refuse to run on a perfectly fine box.
    return Number(line.trim().split(/\s+/).pop());
  } catch {
    return Infinity;
  }
}

/**
 * Turn a scenario's event list into an ordered plan of
 * `{ atMs, action }` steps, with the settle prologue folded in.
 */
export function buildPlan(scenario, defaults = {}) {
  const settle = scenario.settle_ms ?? defaults.settle_ms ?? 2500;
  const trail = scenario.trail_ms ?? defaults.trail_ms ?? 1500;
  const steps = (scenario.events ?? []).map((e) => ({ atMs: settle + e.t, event: e }));
  steps.sort((a, b) => a.atMs - b.atMs);
  const last = steps.length ? steps[steps.length - 1].atMs : settle;
  return { settle, trail, steps, totalMs: last + trail };
}

/** Map a scenario key name to a DOM key for the holtburger key layout. */
export function domKey(key) {
  const map = {
    w: "w",
    a: "a",
    s: "s",
    d: "d",
    q: "q",
    e: "e",
    shift: "Shift",
    space: " ",
  };
  const k = map[key];
  if (!k) throw new Error(`unmapped scenario key '${key}'`);
  return k;
}

/**
 * The `@teleloc` both sides issue before every scenario. Emitted from the
 * shared `capture_site` block so the retail runbook and this driver can never
 * drift to two different patches of ground.
 *
 * Heading is carried as an explicit quaternion about Z rather than left to
 * wherever the avatar happened to be facing — a run's terrain profile depends
 * entirely on which way it points.
 */
export function telelocCommand(site) {
  const h = ((site.heading_deg ?? 0) * Math.PI) / 360; // deg -> rad, halved
  const qw = Math.cos(h).toFixed(6);
  const qz = Math.sin(h).toFixed(6);
  return `@teleloc ${site.cell} ${site.x} ${site.y} ${site.z} ${qw} 0 0 ${qz}`;
}

/**
 * Map a scenario key to the RETAIL client's keyboard layout.
 *
 * Scenario keys are written in holtburger's layout and mean an AXIS, not a
 * keycap: `a`/`d` are the strafe axis, `q`/`e` the turn axis, `s` backward.
 * Retail binds those axes to different keycaps, so the two sides need
 * different keys to produce the same movement.
 *
 * SOURCE (2026-08-11) — the shipped client's OWN help file,
 * `helpcontent/MOVING WITH THE KEYBOARD.ksml` ("the default motion bindings
 * for Asheron's Call"), read off the rig install:
 *
 * | action | retail default |
 * |---|---|
 * | run forward | UP or **W** (SHIFT+W = walk) |
 * | walk backward | DOWN or **X** |
 * | turn left / right | LEFT/RIGHT or **A** / **D** |
 * | sidestep left / right | **Z** / **C** |
 * | auto-run | **Q** |
 * | jump | SPACE |
 *
 * CORRECTION — session 2 (and WINE-RIG.md §6 before this) claimed retail
 * strafes on `Q`/`E` and walks backward on `S`. Both were wrong, and the
 * error was VISIBLE in the captures without being recognised:
 * `turn-while-run` (holtburger `e` -> retail `d`) turned correctly at 134
 * deg/s, while `strafe-diagonal` (holtburger `d` -> retail `e`) produced no
 * `SIDESTEP_COMMAND` in any raw motion state — because retail `E` is bound to
 * nothing. The turn half of the old swap was right by luck; the strafe half
 * sent the diagonal scenario into an unbound key, which is exactly the
 * "clean-looking report full of axis-swapped garbage" this function exists to
 * prevent. `Q` is especially treacherous: it is not unbound, it TOGGLES
 * AUTO-RUN, so the old map's holtburger-`a` -> retail-`Q` would have started
 * an autorun in the middle of a strafe scenario.
 */
export function retailKey(key) {
  const map = {
    w: "w", // forward — the one key both layouts share
    s: "x", // holtburger backward     -> retail walk-backward
    a: "z", // holtburger strafe-left  -> retail sidestep-left
    d: "c", // holtburger strafe-right -> retail sidestep-right
    q: "a", // holtburger turn-left    -> retail turn-left
    e: "d", // holtburger turn-right   -> retail turn-right
    shift: "shift",
    space: "space",
  };
  const k = map[key];
  if (!k) throw new Error(`unmapped scenario key '${key}'`);
  return k;
}

/**
 * The retail-side plan `box-rig.sh scenario` replays: one directive per line,
 * `<ms> <down|up> <xdotool-keysym>`, prefixed by the shared teleloc. Plain
 * text so the box needs neither node nor a copy of scenarios.json.
 */
export function retailPlan(scenario, spec) {
  const plan = buildPlan(scenario, spec.defaults);
  const lines = [
    `# scenario ${scenario.id}`,
    `# gait_expected ${scenario.gait_expected ?? "-"}`,
    `# total_ms ${plan.totalMs}`,
  ];
  if (spec.capture_site) lines.push(`teleloc ${telelocCommand(spec.capture_site)}`);
  lines.push(`settle ${plan.settle}`);
  for (const s of plan.steps) {
    const e = s.event;
    if (e.type === "keydown") lines.push(`${s.atMs} down ${retailKey(e.key)}`);
    else if (e.type === "keyup") lines.push(`${s.atMs} up ${retailKey(e.key)}`);
    else lines.push(`# ${s.atMs} UNSUPPORTED ${e.type} — no retail driver hook`);
  }
  lines.push(`trail ${plan.trail}`);
  return lines.join("\n") + "\n";
}

/** Median of a numeric array, or null. */
export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Contiguous groups of records with a forward drive installed, split on gaps
 * larger than `gapMs`. Used for the gait assertion: a scenario's
 * `gait_expected` describes its LAST forward hold (walk-hold: the only hold;
 * MOVE-F2: the second, post-shift-release hold that must come back as a run).
 */
export function forwardHolds(records, gapMs = 400) {
  const held = records.filter((r) => r?.movement?.drive_forward === "forward");
  const groups = [];
  let cur = null;
  for (const r of held) {
    if (!cur || r.t - cur[cur.length - 1].t > gapMs) {
      cur = [r];
      groups.push(cur);
    } else cur.push(r);
  }
  return groups;
}

/**
 * Assert a capture is in the gait the scenario asked for.
 *
 * This is the check session 1's report called for and did not have. It is also
 * why `gait` had to stop being the raw `hold_run` latch: under holtburger's
 * run-by-default option `hold_run=false` IS a run, so the session-1 telemetry
 * labelled every run "walk" and the first parity report caveated a
 * gait mismatch that never existed.
 */
export function assertGait(records, scenario) {
  const groups = forwardHolds(records);
  if (!scenario.gait_expected) return { ok: true, reason: "scenario declares no gait" };
  if (!groups.length) return { ok: true, reason: "no forward hold in this scenario", gait: null };
  const last = groups[groups.length - 1];
  const counts = new Map();
  for (const r of last) counts.set(r.gait, (counts.get(r.gait) ?? 0) + 1);
  const observed = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return {
    ok: observed === scenario.gait_expected,
    gait: observed,
    expected: scenario.gait_expected,
    holds: groups.length,
    reason: observed === scenario.gait_expected ? "match" : `expected ${scenario.gait_expected}, observed ${observed}`,
  };
}

/** Sampling + site quality of a capture, for the sidecar meta. */
export function captureQuality(records) {
  const dts = [];
  for (let i = 1; i < records.length; i++) dts.push(records[i].t - records[i - 1].t);
  const withPos = records.filter((r) => r.pos);
  const zs = withPos.map((r) => r.pos.z);
  const lbs = new Set(withPos.map((r) => r.pos.lb));
  // realized vs intent over the fastest half of the capture
  const moving = records.filter((r) => (r.speed ?? 0) > 0.15 && r.pos);
  let realized = null;
  if (moving.length > 4) {
    // Global metres via the shared lift (harness/lib/movement_gate.mjs) —
    // pose x/y are landblock-local and wrap every 192 m.
    const g = (r) => poseToGlobalXY({ lb: Number.parseInt(r.pos.lb, 16), x: r.pos.x, y: r.pos.y });
    const sp = [];
    for (let i = 1; i < moving.length; i++) {
      const a = g(moving[i - 1]);
      const b = g(moving[i]);
      const dt = (moving[i].t - moving[i - 1].t) / 1000;
      if (!a || !b || !(dt > 0)) continue;
      sp.push(Math.hypot(b.gx - a.gx, b.gy - a.gy) / dt);
    }
    realized = median(sp);
  }
  const intent = moving.length ? median(moving.map((r) => r.speed)) : null;
  return {
    records: records.length,
    sample_dt_ms: { min: dts.length ? Math.min(...dts) : null, median: median(dts), max: dts.length ? Math.max(...dts) : null },
    z_range_m: zs.length ? Math.max(...zs) - Math.min(...zs) : null,
    landblocks: [...lbs],
    realized_speed: realized,
    intent_speed: intent,
    realized_over_intent: realized != null && intent ? realized / intent : null,
  };
}

/**
 * `--flags a=b,c=d` — extra URL params appended verbatim, for A/B arms.
 *
 * Added for MOVE-RUNRATE-105 (2026-08-11): the fix ships behind
 * `?serverRunRate=off`, and the honest way to measure a default-on flag is to
 * run BOTH arms in ONE browser session against the SAME capture site, so a
 * difference cannot be a site or a stall. Anything a scenario needs that is
 * not a scenario property belongs here rather than in a forked copy of
 * `buildUrl`.
 */
export function parseExtraFlags(spec) {
  if (!spec || spec === true) return [];
  return String(spec)
    .split(",")
    .map((kv) => kv.trim())
    .filter(Boolean)
    .map((kv) => {
      const i = kv.indexOf("=");
      return i < 0 ? [kv, "1"] : [kv.slice(0, i), kv.slice(i + 1)];
    });
}

function buildUrl(base, account, extraFlags = []) {
  const p = new URLSearchParams();
  p.set("moveTelemetry", "1");
  p.set("nosw", "1");
  p.set("autoLogin", "1");
  p.set("account", account);
  p.set("password", account);
  p.set("autoSpawn", "first");
  p.set("agent", "1");
  // Ticks off the net-drain interval, not rAF — see the cadence note at the
  // top of this file. renderOnDemand stops the SwiftShader render that was
  // eating the frame budget; netDrainHz drives `syncTickHop` (and therefore
  // `handle.tickMovement()`) at a fixed 30 Hz.
  p.set("renderOnDemand", "1");
  p.set("netDrainHz", "30");
  for (const [k, v] of extraFlags) p.set(k, v);
  return `${base}?${p.toString()}`;
}

/**
 * Block until the page is actually ticking at the rate the metrics need.
 *
 * A teleport triggers a streaming + bake burst that parks the main thread for
 * seconds at a time, and the net-drain interval that enqueues `tickMovement`
 * is starved for exactly as long. Session 2's first suite run lost its FIRST
 * scenario to this: 29 records spanning 1.3 s of a 9.5 s window, all of them
 * before the first keystroke, because the bake stall began during the settle.
 *
 * A fixed sleep cannot fix that — the stall length depends on what has to
 * bake. So the gate is the measurement itself: drain the ring, wait a second,
 * drain again, and only start the scenario when the observed rate clears the
 * bar. Returns the rate it settled at (or the best seen), so a capture taken
 * under a still-busy main thread is recorded rather than hidden.
 */
export async function waitForCadence(page, minHz, { tries = 30, streak = 3 } = {}) {
  let best = 0;
  let run = 0;
  for (let i = 0; i < tries; i++) {
    await page.evaluate(() => window.__hbWasm?.moveTelemetryDrain?.());
    await page.waitForTimeout(1000);
    const out = await page.evaluate(() => window.__hbWasm?.moveTelemetryDrain?.() ?? "");
    const hz = out.split("\n").filter(Boolean).length;
    best = Math.max(best, hz);
    // A STREAK, not a single good second. Bakes arrive in bursts: session 2
    // saw a gate clear at 28 Hz and then a 7.1 s stall land squarely on the
    // scenario's keystrokes, so the whole hold went unobserved.
    run = hz >= minHz ? run + 1 : 0;
    if (run >= streak) return { hz, waited_s: i + 1, ok: true };
  }
  return { hz: best, waited_s: tries, ok: false };
}

/**
 * Run the capture corridor once, discarded, before any scenario is measured.
 *
 * The stalls that eat a capture are terrain/scenery streaming for ground the
 * avatar is about to run ONTO — so they cannot be waited out while standing
 * still, only paid for by running there once. One warm lap per site (every
 * scenario shares the corridor) then a teleport back to the start.
 */
export async function warmLap(page, spec, telelocFn) {
  console.error("[oracle-run] warm lap (streaming the run corridor)");
  await page.keyboard.down("w");
  await page.waitForTimeout(3000);
  await page.keyboard.up("w");
  await page.waitForTimeout(2000);
  await telelocFn();
  await page.waitForTimeout(4000);
}

async function runOne(page, scenario, spec, opts) {
  const plan = buildPlan(scenario, spec.defaults);
  const site = spec.capture_site;

  // Fixed capture site. The teleport is a chat admin command, so it goes
  // through the same path a human would use and needs no client support.
  if (site && !opts.noTeleport) {
    const cmd = telelocCommand(site);
    await page.evaluate((c) => window.__sessionHandle?.sendChat?.(c), cmd);
    console.error(`[oracle-run] ${cmd}`);
    // Long enough for the destination landblock to stream and bake; the
    // main-thread stall that streaming causes would otherwise land inside
    // the scenario window and shred the sample cadence.
    await page.waitForTimeout(site.settle_ms ?? 14000);
  }

  // Do not start until the tick rate is back — see `waitForCadence`.
  const cadence = await waitForCadence(page, Math.round((spec.defaults?.sample_hz ?? 30) * 0.8));
  console.error(`[oracle-run] cadence gate: ${cadence.hz} Hz after ${cadence.waited_s}s${cadence.ok ? "" : " (NEVER SETTLED)"}`);

  // The telemetry ring has been filling since boot; drop that history so the
  // capture starts at the scenario, not at login or the teleport.
  await page.evaluate(() => window.__hbWasm?.moveTelemetryDrain?.());

  const t0 = Date.now();
  for (const step of plan.steps) {
    const wait = step.atMs - (Date.now() - t0);
    if (wait > 0) await page.waitForTimeout(wait);
    const e = step.event;
    if (e.type === "keydown") await page.keyboard.down(domKey(e.key));
    else if (e.type === "keyup") await page.keyboard.up(domKey(e.key));
    else if (e.type === "cast") {
      // The SAME hook probe_cast_matrix.cjs drives — a self-cast promotes to
      // targeted-at-own-guid client-side, so one call covers both. The spell
      // is learned once at login (`@addspell`, see `run`).
      await page.evaluate((id) => {
        const g = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
        if (g) window.__sessionHandle?.castTargetedSpell?.(g, id);
      }, spec.cast_spell?.id ?? 1708);
    } else if (e.type === "stance") {
      // Retail's `~` binary toggle; the server derives the actual stance.
      // "combat"/"peace" both map to the toggle because there is no absolute
      // setter — the scenario alternates, so the parity is in the transition.
      await page.evaluate(() => window.__sessionHandle?.toggleCombatMode?.());
    }
    console.error(`  t+${step.atMs}ms ${e.type} ${e.key ?? e.spell ?? e.value ?? ""}`);
  }
  await page.waitForTimeout(plan.trail);

  const out = await page.evaluate(() => window.__hbWasm?.moveTelemetryDrain?.() ?? "");
  const status = await page.evaluate(() => window.__hbWasm?.moveTelemetryStatus?.() ?? 0);
  // The run-rate INPUTS, recorded per capture. Ground speed is
  // `4.0 x run_rate` and run_rate is derived client-side from the wire Run
  // skill + burden, so a steady-speed delta against retail is only
  // interpretable next to the numbers that produced it. `playerRunRate*` is
  // not on `window.__hbWasm`; the entity manager holds the wasm namespace.
  const runRate = await page.evaluate(() => {
    const w = window.liveScene3d?.entityManager?.wasmExports;
    if (!w) return null;
    let inputs = null;
    try { inputs = JSON.parse(w.playerRunRateInputs?.() ?? "null"); } catch (_) {}
    return { rate: w.playerRunRate?.() ?? null, inputs };
  });
  // Release anything still held so the next scenario in an --all run starts
  // from rest rather than inheriting a stuck key.
  for (const k of ["w", "a", "s", "d", "q", "e", "Shift", " "]) {
    await page.keyboard.up(k).catch(() => {});
  }
  if (!out.trim()) {
    throw new Error(
      "telemetry drain was EMPTY — is pkg/ rebuilt with the moveTelemetry " +
        "exports? (a stale pkg/ yields undefined and this reads as '')",
    );
  }
  const records = out
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const quality = captureQuality(records);
  quality.span_ms = records.length ? records[records.length - 1].t - records[0].t : 0;
  quality.expected_span_ms = plan.totalMs;
  const gait = assertGait(records, scenario);
  const meta = {
    scenario: scenario.id,
    generated: new Date().toISOString(),
    account: opts.account,
    url: opts.url,
    capture_site: site ?? null,
    drain_status: status,
    cadence_gate: cadence,
    run_rate: runRate,
    quality,
    gait,
    warnings: [],
  };
  if (quality.sample_dt_ms.median != null && quality.sample_dt_ms.median > MAX_SAMPLE_DT_MS) {
    meta.warnings.push(
      `sample dt median ${quality.sample_dt_ms.median.toFixed(0)} ms > ${MAX_SAMPLE_DT_MS} ms — accel/decel metrics from this capture are not trustworthy`,
    );
  }
  if (!gait.ok) meta.warnings.push(`GAIT MISMATCH: ${gait.reason}`);
  if (!cadence.ok) meta.warnings.push(`cadence never settled (best ${cadence.hz} Hz) — the main thread was still busy when the scenario started`);
  // A capture whose SAMPLES look fine but whose SPAN stops early has missed
  // part of the scenario to a mid-run stall — the failure that slipped through
  // session 2's first suite run: 29 samples at a healthy 33 ms covering the
  // first 1.3 s of a 9.5 s walk-hold, so every per-sample check passed while
  // the keystrokes were never observed at all.
  if (quality.span_ms < 0.8 * plan.totalMs) {
    meta.warnings.push(
      `capture spans ${Math.round(quality.span_ms)} ms of a ${plan.totalMs} ms plan — the tick loop stalled mid-scenario`,
    );
  }
  // THE decisive quality check. A single main-thread stall inside the window
  // is enough to lose the whole scenario while every other statistic still
  // looks healthy: session 2 measured a ~6.8 s block, once per browser
  // session, that landed on the first scenario's hold and left a capture of
  // 54 samples at a perfect 33 ms median with no movement in it at all.
  if (quality.sample_dt_ms.max != null && quality.sample_dt_ms.max > MAX_STALL_MS) {
    meta.warnings.push(
      `a ${Math.round(quality.sample_dt_ms.max)} ms stall fell inside the capture — part of the scenario went unobserved`,
    );
    meta.stalled = true;
  }
  if (quality.realized_over_intent != null && quality.realized_over_intent < 0.95) {
    meta.warnings.push(
      `realized/intent ${quality.realized_over_intent.toFixed(3)} — the avatar did not reach the commanded speed (slope, obstacle or collision at the capture site)`,
    );
  }
  console.error(
    `[oracle-run] ${scenario.id}: ${records.length} records, dt med ${quality.sample_dt_ms.median?.toFixed(0)} ms, gait ${gait.gait ?? "n/a"} (${gait.ok ? "OK" : "MISMATCH"}), realized/intent ${quality.realized_over_intent?.toFixed(3) ?? "n/a"}`,
  );
  for (const w of meta.warnings) console.error(`  [warn] ${w}`);
  return { out, meta };
}

async function run(args) {
  const spec = JSON.parse(readFileSync(SCENARIOS, "utf8"));
  const wanted = args.all
    ? spec.scenarios
    : [spec.scenarios.find((s) => s.id === args.scenario)].filter(Boolean);
  if (!wanted.length) throw new Error(`unknown scenario '${args.scenario}'`);

  const free = freeMemMb();
  if (free < FREE_MEM_FLOOR_MB) {
    throw new Error(
      `only ${free} MiB available; refusing to start a browser under the ` +
        `${FREE_MEM_FLOOR_MB} MiB floor (close the other chromium first)`,
    );
  }

  const pwPath = args.playwright ?? "playwright-core";
  const pw = await import(pwPath);
  const chromium = pw.chromium ?? pw.default?.chromium;
  const account = args.account ?? "agentp09";
  const url = buildUrl(
    args.base ?? "http://127.0.0.1:8765/apps/holtburger-web/index.html",
    account,
    parseExtraFlags(args.flags),
  );
  console.error(`[oracle-run] ${url}`);

  const browser = await chromium.launch({
    headless: true,
    executablePath: args.chrome ?? "/usr/bin/chromium",
    args: ["--use-gl=swiftshader", "--disable-dev-shm-usage", "--no-sandbox"],
  });
  const results = [];
  try {
    const page = await browser.newPage();
    page.on("console", (m) => {
      if (/error/i.test(m.type())) console.error(`  [page:${m.type()}] ${m.text().slice(0, 200)}`);
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });

    // Boot gate. __bootState goes through a documented sequence; 'in-world' is
    // the only state where movement is meaningful. Poll rather than sleep, and
    // surface __bootStateHistory on failure so a timeout is diagnosable.
    await page
      .waitForFunction(() => window.__bootState === "in-world", null, { timeout: 240_000 })
      .catch(async () => {
        const hist = await page.evaluate(() => window.__bootStateHistory ?? window.__bootState);
        throw new Error(`never reached in-world; bootState history: ${JSON.stringify(hist)}`);
      });
    console.error("[oracle-run] in-world");
    await page.waitForTimeout(6000);

    // Cast scenarios need the spell on the character. `@addspell` is
    // idempotent, so it runs unconditionally rather than being conditioned on
    // which scenarios were selected.
    if (spec.cast_spell?.id) {
      await page.evaluate((id) => window.__sessionHandle?.sendChat?.(`@addspell ${id}`), spec.cast_spell.id);
      await page.waitForTimeout(1200);
    }

    // One warm lap over the shared corridor before anything is measured.
    if (spec.capture_site && !args["no-teleport"]) {
      const tele = async () => {
        await page.evaluate((c) => window.__sessionHandle?.sendChat?.(c), telelocCommand(spec.capture_site));
      };
      await tele();
      await page.waitForTimeout(spec.capture_site.settle_ms ?? 14000);
      await warmLap(page, spec, tele);
    }

    for (const scenario of wanted) {
      // Stalls are one-shot-per-session, so a re-take almost always lands
      // clean. Retrying is honest here in a way that dropping the warning
      // would not be: the meta still records how many attempts it took.
      let r = null;
      for (let attempt = 1; attempt <= STALL_RETRIES + 1; attempt++) {
        r = await runOne(page, scenario, spec, { account, url, noTeleport: !!args["no-teleport"] });
        r.meta.attempt = attempt;
        if (!r.meta.stalled) break;
        if (attempt <= STALL_RETRIES) console.error(`[oracle-run] ${scenario.id}: stalled — re-taking (attempt ${attempt + 1})`);
      }
      const dest = args.all
        ? path.join(args["out-dir"] ?? ".", `holt-${scenario.id}.jsonl`)
        : (args.out ?? `holt-${scenario.id}.jsonl`);
      writeFileSync(dest, r.out.endsWith("\n") ? r.out : r.out + "\n");
      writeFileSync(dest.replace(/\.jsonl$/, "") + ".meta.json", JSON.stringify(r.meta, null, 2) + "\n");
      console.error(`[oracle-run] wrote ${dest}`);
      results.push(r.meta);
    }
  } finally {
    await browser.close();
  }
  const bad = results.filter((m) => m.warnings.length);
  if (bad.length) {
    console.error(`\n[oracle-run] ${bad.length}/${results.length} captures carry warnings:`);
    for (const m of bad) console.error(`  ${m.scenario}: ${m.warnings.join("; ")}`);
  } else {
    console.error(`\n[oracle-run] ${results.length}/${results.length} captures clean`);
  }
}

// ---------------------------------------------------------------------------

function selftest() {
  let p = 0;
  let f = 0;
  const check = (n, ok, d) => {
    console.log(`  [${ok ? "OK" : "FAIL"}] ${n}${d ? " — " + d : ""}`);
    ok ? p++ : f++;
  };
  const spec = JSON.parse(readFileSync(SCENARIOS, "utf8"));
  check("scenarios.json parses", Array.isArray(spec.scenarios) && spec.scenarios.length >= 10, `${spec.scenarios.length} scenarios`);
  check("every scenario has an id and events", spec.scenarios.every((s) => s.id && Array.isArray(s.events)));
  check(
    "every scenario key is mappable to a DOM key",
    spec.scenarios.every((s) => s.events.every((e) => !e.key || (() => { try { domKey(e.key); return true; } catch { return false; } })())),
  );
  const plan = buildPlan(spec.scenarios.find((s) => s.id === "run-hold"), spec.defaults);
  check("run-hold plan is ordered and settled", plan.steps[0].atMs === plan.settle, `first step at ${plan.steps[0].atMs}ms`);
  check("run-hold plan has a trailing window", plan.totalMs > plan.steps[plan.steps.length - 1].atMs);
  const f2 = spec.scenarios.find((s) => s.id === "walk-edge-after-manualheld-walk");
  check("F2 scenario ends on a run hold (no shift at the second edge)", f2.gait_expected === "run");
  check("mem floor helper returns a number", Number.isFinite(freeMemMb()) || freeMemMb() === Infinity);

  // --- session 2: capture site + gait assertion --------------------------
  check("scenarios.json declares a capture site", !!spec.capture_site?.cell, `${spec.capture_site?.name} ${spec.capture_site?.cell}`);
  check("scenarios.json declares a cast spell", !!spec.cast_spell?.id, `spell ${spec.cast_spell?.id}`);
  const tl = telelocCommand({ cell: "0x7D64000D", x: 1, y: 2, z: 3, heading_deg: 180 });
  check("teleloc carries the heading quaternion", /^@teleloc 0x7D64000D 1 2 3 0\.000000 0 0 1\.000000$/.test(tl), tl);
  const mk = (t, fwd, gait) => ({ t, gait, speed: 7, pos: { lb: "0x7D64000D", x: 0, y: 0, z: 0 }, movement: { drive_forward: fwd } });
  // MOVE-F2 shape: a walk hold, a gap, then a run hold. The assertion must
  // score the SECOND hold — scoring all samples would call this "walk|run".
  const f2recs = [
    mk(0, "forward", "walk"), mk(100, "forward", "walk"), mk(200, "forward", "walk"),
    mk(2000, "forward", "run"), mk(2100, "forward", "run"), mk(2200, "forward", "run"),
  ];
  check("forwardHolds splits on the release gap", forwardHolds(f2recs).length === 2, `${forwardHolds(f2recs).length} holds`);
  const g = assertGait(f2recs, { gait_expected: "run" });
  check("gait assertion scores the LAST hold", g.ok && g.gait === "run", JSON.stringify(g));
  const gBad = assertGait(f2recs, { gait_expected: "walk" });
  check("gait assertion fails a real mismatch", !gBad.ok, gBad.reason);
  const gNone = assertGait([mk(0, null, "run")], { gait_expected: "run" });
  check("a scenario with no forward hold does not false-fail", gNone.ok && gNone.gait === null);

  // --- session 2: the retail plan + key remap ----------------------------
  // Retail bindings read off the rig install's own
  // `helpcontent/MOVING WITH THE KEYBOARD.ksml` (2026-08-11).
  check("retail strafe axis is Z/C, not Q/E", retailKey("a") === "z" && retailKey("d") === "c", `${retailKey("a")}/${retailKey("d")}`);
  check("retail turn axis is A/D", retailKey("q") === "a" && retailKey("e") === "d", `${retailKey("q")}/${retailKey("e")}`);
  check("retail walks backward on X, not S", retailKey("s") === "x", retailKey("s"));
  check("retail remap leaves the shared keys alone", retailKey("w") === "w" && retailKey("space") === "space");
  // Q toggles AUTO-RUN in retail. No scenario key may ever map onto it — an
  // accidental autorun would keep the avatar moving after every keyup and
  // silently corrupt every metric that follows in the same session.
  check("no scenario key maps onto retail's auto-run toggle",
    ["w", "s", "a", "d", "q", "e", "shift", "space"].every((k) => retailKey(k) !== "q"));
  const f6plan = retailPlan(spec.scenarios.find((s) => s.id === "strafe-diagonal"), spec);
  // MOVE-F6's whole point: the diagonal must STRAFE, not turn. Retail's
  // sidestep-right is C; D would turn, and E (session 2's map) is unbound.
  check("MOVE-F6 plan strafes with retail's C — not D (turn), not E (unbound)",
    / down c$/m.test(f6plan) && !/ down d$/m.test(f6plan) && !/ down e$/m.test(f6plan),
    f6plan.split("\n").filter((l) => /down/.test(l)).join(" | "));
  check("retail plan carries the shared teleloc", f6plan.includes(`teleloc @teleloc ${spec.capture_site.cell}`));
  const turnplan = retailPlan(spec.scenarios.find((s) => s.id === "turn-while-run"), spec);
  check("turn-while-run turns with retail's D", /down d$/m.test(turnplan));

  // --- session 2: capture quality ----------------------------------------
  // A landblock-CROSSING fixture: 4 m/s east from local x=190, so x wraps to
  // ~0 in the next landblock. Without the global lift the realized speed
  // reads ~1900 m/s and every site would look unobstructed.
  const mkq = (n, vps, speed, z0 = 10) =>
    Array.from({ length: n }, (_, i) => {
      const gx = 0x7d * 192 + 190 + vps * (i * 0.1);
      const lbx = Math.floor(gx / 192);
      return {
        t: i * 100,
        speed,
        pos: { lb: `0x${((lbx << 24) | (0x64 << 16) | 0x0d).toString(16)}`, x: gx - lbx * 192, y: 0, z: z0 + (i === n - 1 ? 0.2 : 0) },
      };
    });
  const q = captureQuality(mkq(20, 4, 4));
  check("quality reports the sample cadence", q.sample_dt_ms.median === 100, JSON.stringify(q.sample_dt_ms));
  check("quality reports realized/intent across a landblock edge", Math.abs(q.realized_over_intent - 1) < 0.01, `${q.realized_over_intent?.toFixed(3)}`);
  check("quality reports the z range", Math.abs(q.z_range_m - 0.2) < 1e-6, `${q.z_range_m}`);
  const qPinned = captureQuality(mkq(20, 1.5, 7.8, 0));
  check("a pinned avatar shows up as realized << intent", qPinned.realized_over_intent < 0.25, `${qPinned.realized_over_intent?.toFixed(3)}`);

  // --- `--flags` A/B passthrough (MOVE-RUNRATE-105) ----------------------
  check("no --flags is an empty list", parseExtraFlags(undefined).length === 0);
  check("--flags with no value is an empty list", parseExtraFlags(true).length === 0);
  const ff = parseExtraFlags("serverRunRate=off");
  check("a single k=v parses", ff.length === 1 && ff[0][0] === "serverRunRate" && ff[0][1] === "off", JSON.stringify(ff));
  const ff2 = parseExtraFlags(" a=1 , bare , c=x=y ");
  check("comma list, bare keys default to 1, only the FIRST = splits",
    JSON.stringify(ff2) === JSON.stringify([["a", "1"], ["bare", "1"], ["c", "x=y"]]), JSON.stringify(ff2));
  const u = buildUrl("http://h/i.html", "agentp09", parseExtraFlags("serverRunRate=off"));
  check("extra flags reach the URL", u.includes("serverRunRate=off"), u);
  check("extra flags do not disturb the cadence flags", u.includes("netDrainHz=30") && u.includes("nosw=1"), u);

  console.log(`\n${p} passed, ${f} failed`);
  process.exit(f === 0 ? 0 : 1);
}

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2);
    const n = argv[i + 1];
    if (n && !n.startsWith("--")) {
      args[k] = n;
      i++;
    } else args[k] = true;
  }
}
if (args.selftest) selftest();
else if (args.list) {
  const spec = JSON.parse(readFileSync(SCENARIOS, "utf8"));
  for (const s of spec.scenarios) console.log(`${s.id.padEnd(34)} ${s.description.slice(0, 90)}`);
} else if (args["emit-retail-plan"]) {
  const spec = JSON.parse(readFileSync(SCENARIOS, "utf8"));
  const ids = args["emit-retail-plan"] === true ? spec.scenarios.map((s) => s.id) : [args["emit-retail-plan"]];
  for (const id of ids) {
    const s = spec.scenarios.find((x) => x.id === id);
    if (!s) throw new Error(`unknown scenario '${id}'`);
    const text = retailPlan(s, spec);
    if (args["out-dir"]) {
      const dest = path.join(args["out-dir"], `${id}.plan`);
      writeFileSync(dest, text);
      console.error(`[oracle-run] wrote ${dest}`);
    } else process.stdout.write(text);
  }
} else if (!args.scenario && !args.all) {
  console.error("usage: oracle-run.mjs --scenario <id> [--out f.jsonl] [--account agentp09] [--flags k=v,k2=v2]");
  console.error("       oracle-run.mjs --all [--out-dir DIR]");
  console.error("       oracle-run.mjs --list | --selftest");
  process.exit(2);
} else {
  run(args).catch((e) => {
    console.error(`[oracle-run] FAILED: ${e.message}`);
    process.exit(1);
  });
}
