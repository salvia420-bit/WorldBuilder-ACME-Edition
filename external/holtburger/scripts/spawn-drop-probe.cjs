#!/usr/bin/env node
/*
 * scripts/spawn-drop-probe.cjs — 2026-08-02
 *
 * Does every KIND_SPAWN the wasm drain emits actually reach `em.spawn()`?
 *
 * WHY: one `?wireframe=1&renderOnDemand=1` run reported 3 of 6 wielded children
 * never getting `em.spawn` called. A wielded child arrives as its OWN
 * ObjectCreate (KIND_SPAWN) carrying `PhysicsDesc.Parent`, so a dropped spawn
 * means a permanently missing held item — not a late one. "Deferred is fine,
 * dropped is not" is the invariant this probe measures.
 *
 * WHAT IT MEASURES (both sides of the seam, per guid):
 *   emitted  — guids the shared drain hook saw with `kind === KIND_SPAWN`
 *              (wrapped at `window.__scene3dEntityHook`, the single funnel every
 *              spawn route passes through: live array hook, single hook,
 *              pre-init3D backlog replay, spawns.js injector, standalone drain)
 *   spawned  — guids `EntityManager.prototype.spawn` was actually invoked for
 *   dropped  = emitted \ spawned, sampled after a quiet period
 *
 * The interesting seam between them is loop.js's spawn TIME-SLICE
 * (`_deferredSpawns`, default ON, `_SPAWN_PER_TICK = 6`, pumped on
 * `setTimeout(0)`). Two structural drop candidates live there, both silent:
 *
 *   1. `_pumpDeferredSpawns` skips `_doSpawn` when
 *      `entry.scene3d.entityManager !== entry.em` (EntityManager swapped
 *      between enqueue and pump) but STILL does `done.push(guid)` — the entry
 *      is deleted either way, so the spawn is dropped with no counter and no
 *      warn. Intended for renderer hot-swap; indistinguishable from a bug.
 *   2. `_enqueueDeferredSpawn` keys `_deferredSpawns` by `meta.guid >>> 0`. Any
 *      meta arriving with a falsy/undefined guid collapses onto key 0, so N
 *      such spawns supersede each other and only the last survives.
 *
 * ARMS (run both; the difference is the point):
 *   nullRender  — sim/drain run, render() skipped. The control.
 *   wireframe   — the arm the original report used.
 * Both also take `?renderOnDemand=1`, which is what starves rAF and lets the
 * pending buffer actually build up.
 *
 * USAGE
 *   node scripts/spawn-drop-probe.cjs --account X --password Y [--arm both]
 *        [--port 8765] [--seconds 90] [--chrome /path/to/chrome]
 *
 * Requires puppeteer-core (or CHROME env) and a running serve.py. Prints a
 * per-arm table and exits 1 if any arm dropped a spawn. If puppeteer-core is
 * absent, the INSTRUMENT() body is still the deliverable: pass it as an
 * `initScript` (chrome-devtools-mcp `navigate_page`) or paste it into the
 * console before login, then read `window.__spawnProbeReport()`.
 *
 * ── RESULTS SO FAR (2026-08-02, local SwiftShader, Holtburg login) ──────────
 *   nullRender arm  `?nullRender=1&renderOnDemand=1&netDrainHz=30`
 *     hookInstalls 2 (stub + live dispatcher) · emPatched 1
 *     emitted 30 · spawned 30 · DROPPED 0 · zeroGuidSightings 0 · pendingLeft 0
 *   wireframe arm — NOT YET RUN (see the operational note below).
 *
 *   So the probe is wired correctly end-to-end (both counters move, and the
 *   guid sets match exactly) and the light-load nullRender arm is CLEAN. The
 *   original 3-of-6 report was under heavier load, so the open question is
 *   specifically whether a BURST (the >256 buffered path in index.html's
 *   `__entDrainPending`, or a town-load spawn flood) is what loses spawns.
 *   Drive load with `@telepoi` hops into a populated town once in-world.
 *
 * ── OPERATIONAL NOTE: how to get a test account (learn from this) ───────────
 * Create one on the live ACE server's console FIFO:
 *   echo 'accountcreate <name> <pass> 5' > ~/ace_stdin.fifo
 * then make its character THROUGH THE CLIENT's character creation.
 *
 * Do NOT reassign an existing character between accounts with
 * `UPDATE ace_shard.character SET account_Id=...` while the server is running:
 * ACE caches account→character in memory, and the stale cache took down
 * `WorldManager.UpdateWorld()` with an unhandled
 * `KeyNotFoundException: The given key '<accountId>' was not present in the
 * dictionary` the moment the reassigned character's session was re-logged.
 * That kills the whole world server. (Observed 2026-08-02; recovered by
 * restoring `account_Id` and restarting via the documented FIFO recipe.)
 */
"use strict";

const path = require("node:path");

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const ACCOUNT = arg("account", "backlog1");
const PASSWORD = arg("password", "backlog1");
const PORT = arg("port", "8765");
const SECONDS = parseInt(arg("seconds", "90"), 10);
const ARM = arg("arm", "both");
const CHROME = arg("chrome", process.env.CHROME || "/usr/bin/chromium");

const ARMS = {
  nullRender: "nullRender=1&renderOnDemand=1",
  wireframe: "wireframe=1&renderOnDemand=1",
};

// ── the in-page instrumentation ────────────────────────────────────────────
// Installed BEFORE any app script runs. It must not change timing materially:
// every wrapper is a Set.add plus a pass-through call.
function INSTRUMENT() {
  const S = (window.__spawnProbe = {
    emitted: new Map(),   // guid → count of KIND_SPAWN sightings
    spawned: new Set(),   // guid → em.spawn actually called
    emCtorSeen: 0,
    hookInstalls: 0,
    firstEmittedMs: 0,
    lastEmittedMs: 0,
    lastSpawnedMs: 0,
  });

  // KIND_SPAWN is 1 in the shared kind table (scene3d/entity_dispatch.js KIND).
  const KIND_SPAWN = 1;

  // 1) Wrap the single drain funnel. `__scene3dEntityHook` is (re)assigned at
  //    least twice — the module-scope buffering stub, then the live
  //    EntityManager dispatcher — so intercept the PROPERTY, not one value.
  // Late-injection safe: if a hook is already installed (the module-scope
  // buffering stub, or the live dispatcher when this is pasted in after boot),
  // capture it and push it back through the setter so it gets wrapped too.
  let _hook;
  const _preexisting = window.__scene3dEntityHook;
  Object.defineProperty(window, "__scene3dEntityHook", {
    configurable: true,
    get() { return _hook; },
    set(fn) {
      S.hookInstalls += 1;
      if (typeof fn !== "function") { _hook = fn; return; }
      _hook = function wrapped(updates) {
        try {
          for (const u of updates || []) {
            if (u && u.kind === KIND_SPAWN) {
              const g = (u.guid ?? 0) >>> 0;
              S.emitted.set(g, (S.emitted.get(g) || 0) + 1);
              if (!S.firstEmittedMs) S.firstEmittedMs = performance.now();
              S.lastEmittedMs = performance.now();
            }
          }
        } catch (_) { /* never perturb the drain */ }
        return fn.apply(this, arguments);
      };
    },
  });
  if (_preexisting !== undefined) window.__scene3dEntityHook = _preexisting;

  // 2) Wrap EntityManager.prototype.spawn. The class is an ES module export, so
  //    reach it off the first live instance rather than importing.
  const tryPatch = () => {
    const em = window.liveScene3d?.entityManager;
    if (!em) return false;
    const proto = Object.getPrototypeOf(em);
    if (!proto || proto.__spawnProbePatched) return true;
    const orig = proto.spawn;
    if (typeof orig !== "function") return false;
    proto.spawn = function patched(meta) {
      try {
        S.spawned.add(((meta && meta.guid) ?? 0) >>> 0);
        S.lastSpawnedMs = performance.now();
      } catch (_) {}
      return orig.apply(this, arguments);
    };
    proto.__spawnProbePatched = true;
    S.emCtorSeen += 1;
    return true;
  };
  const iv = setInterval(() => { if (tryPatch()) clearInterval(iv); }, 50);

  // 3) Report helper — read from the driver after the quiet period.
  window.__spawnProbeReport = () => {
    const emitted = [...S.emitted.keys()];
    const dropped = emitted.filter((g) => !S.spawned.has(g));
    return {
      hookInstalls: S.hookInstalls,
      emPatched: S.emCtorSeen,
      emittedCount: emitted.length,
      emittedTotalSightings: [...S.emitted.values()].reduce((a, b) => a + b, 0),
      spawnedCount: S.spawned.size,
      droppedCount: dropped.length,
      dropped: dropped.slice(0, 40).map((g) => "0x" + g.toString(16)),
      zeroGuidSightings: S.emitted.get(0) || 0,
      pendingLeft: (window.__entDrainPending || []).length,
      bootState: window.__bootState,
      quietMs: Math.round(performance.now() - Math.max(S.lastEmittedMs, S.lastSpawnedMs)),
    };
  };
}

async function runArm(puppeteer, name, flags) {
  const url =
    `http://127.0.0.1:${PORT}/apps/holtburger-web/index.html` +
    `?nosw=1&${flags}&netDrainHz=30&autoLogin=1&agent=1` +
    `&account=${encodeURIComponent(ACCOUNT)}&password=${encodeURIComponent(PASSWORD)}` +
    `&autoSpawn=first&kickDance=1`;

  // A FRESH profile per arm — a warm shader/module cache changes drain timing,
  // which is exactly the variable under test.
  const userDataDir = path.join(
    process.env.TMPDIR || "/tmp",
    `spawn-probe-${name}-${Date.now()}`,
  );
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    userDataDir,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=swiftshader"],
  });
  try {
    const page = await browser.newPage();
    page.on("console", (m) => {
      const t = m.text();
      if (/\[loop\] deferred spawn threw|spawn|drain/i.test(t)) {
        console.log(`  [${name}:console] ${t.slice(0, 200)}`);
      }
    });
    await page.evaluateOnNewDocument(INSTRUMENT);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });

    // Wait for in-world, then a quiet period so every deferred pump lands.
    const deadline = Date.now() + SECONDS * 1000;
    let report = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      report = await page.evaluate(() => window.__spawnProbeReport?.() ?? null);
      if (!report) continue;
      // Settled: we saw spawns and nothing new for 8s.
      if (report.emittedCount > 0 && report.quietMs > 8000) break;
    }
    return report;
  } finally {
    await browser.close();
  }
}

(async () => {
  let puppeteer;
  try {
    puppeteer = require("puppeteer-core");
  } catch (_) {
    console.error(
      "spawn-drop-probe: puppeteer-core not installed.\n" +
        "The in-page instrumentation is still the deliverable — paste the body of\n" +
        "INSTRUMENT() into the devtools console BEFORE login, then read\n" +
        "`window.__spawnProbeReport()` once the world settles.",
    );
    process.exit(2);
  }
  const arms = ARM === "both" ? Object.keys(ARMS) : [ARM];
  let bad = false;
  for (const a of arms) {
    if (!ARMS[a]) { console.error(`unknown arm ${a}`); process.exit(2); }
    console.log(`\n=== arm: ${a} (${ARMS[a]}) ===`);
    const r = await runArm(puppeteer, a, ARMS[a]);
    if (!r) { console.log("  no report (never booted)"); bad = true; continue; }
    console.log(JSON.stringify(r, null, 2));
    if (r.droppedCount > 0) bad = true;
    if (r.zeroGuidSightings > 0) {
      console.log(`  !! ${r.zeroGuidSightings} KIND_SPAWN with guid 0 — these all` +
        " collapse onto key 0 in loop.js `_deferredSpawns` and supersede each other.");
    }
  }
  console.log(bad ? "\nRESULT: spawns were dropped (or an arm failed)." : "\nRESULT: no dropped spawns.");
  process.exit(bad ? 1 : 0);
})();
