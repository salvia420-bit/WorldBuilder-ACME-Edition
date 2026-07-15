// settle.mjs — the ONE settle predicate every net-review probe must share.
//
// WHY THIS EXISTS (2026-07-14). Draw numbers here were confounded for a whole
// session because "settled" was decided by weak predicates. THREE distinct
// causes, each of which silently produced stable-looking, wrong numbers.
// (3) turned out to dominate (1) — do not stop at the ramp fix and assume you
// are done, as the first cut of this file did:
//
//  1. PREMATURE SETTLE. Static default_script emitters attach on a TIME-SLICED
//     ramp (statics.js STATIC_SCRIPT_SLICE_MS yields macrotasks). Measured
//     fresh arrival at Cragstone:
//        t+9s 133 | t+13s 866 | t+17s 2354 | t+25s 2549 | t+34s 2579
//        t+34s..t+104s: FLAT at 2579 (zero drift for 70s)
//     The ramp TAIL moves only +47 then +29 per ~5s, so a "|delta| <= 2 over a
//     few reads" predicate fires mid-ramp. That is how one POI reported
//     213 / 1954 / 2454 emitters and draws of 574.9 / 808.1 / 1574 — all
//     "settled". => require EXACT equality held for >= STABLE_MS, plus a hard
//     MIN_SETTLE_MS floor below which we never believe stability at all.
//
//  2. SESSION HISTORY BLEED. `autoSpawn=first` spawns the character at their
//     SAVED position — which our own @telepoi probes mutate — and
//     `terrainBakedLbs` is CUMULATIVE (measured: 121 -> 242 -> 363 across a
//     tour; it never shrinks, so it is "LBs EVER baked", NOT residency).
//     Travel also REAPS emitters (measured 2582 -> 1577 -> 1108 over a tour),
//     so a run that spawns far and teleports in lands at a LOWER plateau than
//     one that spawns on top of the POI. Same code, same flags, 1100 vs 2579.
//     => normalizeSpawn: teleport, RELOAD, then settle, so every run starts
//     spawned AT the POI with no travel history. Deterministic by construction.
//
//  3. PLAYER POSE — THE DOMINANT ONE. RP6 culls emitters by frustum + a 220m
//     cap, so how many of the ~9500 live particles are VISIBLE (and each
//     visible one is a draw, frustumCulled=false) is set by where the player
//     stands. `@telepoi` does NOT land identically run to run. Measured at one
//     POI, all three runs properly settled by (1):
//        emitters      2451 / 2505 / 2579   (5% spread)
//        liveParticles 9038 / 9261 / 9560   (6% spread)
//        VISIBLE parts  696 /  900 / 1208   (73% spread)  <-- the swing
//        draws          537 /  933 / 1538   (186% spread) <-- the consequence
//     So a settled emitter count is NECESSARY BUT NOT SUFFICIENT. Draw counts
//     are only comparable across page loads with `pinPose` (exact @teleloc).
//     Facing note: the L2 handoff's rule "facing does NOT change draws" holds
//     for STATICS (distance cull) but is FALSE for particles — RP6 is a FRUSTUM
//     test, so yaw changes particle draws. Spin-averaging cancels yaw; it does
//     NOT cancel position.
//
//  4. RESIDUAL STOCHASTICITY — WHY THIS FILE IS NOT ENOUGH. After fixing all
//     of the above, two runs with the SAME pinned pose, same flags, both
//     properly settled (60s floor, 30s hold) STILL disagree:
//        pin-1: draws 1590.3  emitters 2451  liveParticles 9052
//        pin-2: draws 1996    emitters 2505  liveParticles 9260
//     ~25% apart. The emitter plateau is itself stochastic (2451/2502/2505/2579
//     across four settled runs, from a CONSTANT 138 anchors), and emission
//     timing is RNG-driven (time_rng.js). So settling cannot make cross-page-
//     load draw counts reproducible — it can only make the disagreement VISIBLE.
//
// RULE: never compare two arms measured in different page loads without
// pinPose + normalizeSpawn + identical reported state. Report `state` next to
// EVERY number you publish, so a non-comparable run is visible, not silent.
//
// AND: for any number quoted to <25% precision, a cross-page-load A/B is
// INVALID no matter how well settled. Either
//   (a) measure both arms in ONE page load (runtime-switchable gate), or
//   (b) take N>=3 samples per arm and compare DISTRIBUTIONS, never singles.
// A single-sample A/B is only trustworthy when the effect dwarfs the noise —
// e.g. ?particleInstancing (OFF 537-1996 vs ON ~200, a 5-10x effect against
// ~25% noise) is safe to call directionally, but its exact -N was never
// defensible and should not be quoted.

export const SETTLE_DEFAULTS = {
  // The ramp reaches its plateau ~t+34s, but it STALLS on the way: an A/B with
  // a 40s floor + 10s hold still split 2451 vs 2579 emitters (537 vs 1538
  // draws) because the 2451 run sat in a >=10s LULL and read as converged. The
  // time-slice yields macrotasks, so lulls are expected and a short hold can
  // never distinguish "paused" from "done". Both numbers are therefore set well
  // past the observed convergence, not tuned to just barely clear it.
  minSettleMs: 60000, // hard floor; convergence measured at ~t+34s
  stableMs: 20000,    // must hold EXACTLY this long — longer than any observed lull
  pollMs: 2000,
  timeoutMs: 240000,
};

/** Weather is its own camera-following InstancedMesh system (weather/{rain,snow}.js)
 *  that no gameplay flag touches, but it starts/stops between runs and reads as
 *  "the other arm has extra white particles". Force it off for any A/B. */
export const WEATHER_OFF = { rain: "off", snow: "off", lightning: "off" };

/** One snapshot of everything that makes runs (non-)comparable. */
export async function worldState(page) {
  return page.evaluate(() => {
    const ls = window.liveScene3d;
    const mgr = ls && ls._staticParticleManager;
    let liveParticles = 0;
    if (mgr) for (const [, e] of mgr.particleTable) liveParticles += e.numParticles | 0;
    let anchors = 0;
    const g = ls && ls.scene && ls.scene.getObjectByName("statics");
    if (g) g.traverse((o) => { if (o.userData && o.userData.isStaticScriptAnchor) anchors++; });
    // The player's POSE is the dominant driver of particle draw counts: RP6
    // culls emitters by frustum + a 220m cap, so a few metres / a few degrees
    // changes how many of the ~9500 live particles are visible. Measured at one
    // POI with a settled emitter count: emitters varied 5% (2451/2505/2579) and
    // liveParticles 6%, but VISIBLE particle meshes varied 73% (696/900/1208)
    // and draws 186% (537/933/1538). Report it with every number; pin it (see
    // pinPose) before comparing draw counts across page loads.
    let pose = null;
    try {
      const p = window.__sessionHandle.getLocalPlayerPose();
      if (p) { pose = { lb: p.landblockId >>> 0, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), heading: p.heading != null ? +p.heading.toFixed(1) : null }; if (p.free) p.free(); }
    } catch (_) {}
    return {
      pose,
      // NOTE: terrainBakedLbs is CUMULATIVE ("ever baked"), not residency.
      terrEverBaked: (ls && ls.terrainBakedLbs && ls.terrainBakedLbs.size) || 0,
      staticsBaked: (ls && ls.staticsBakedLbs && ls.staticsBakedLbs.size) || 0,
      emitters: (mgr && mgr.particleTable && mgr.particleTable.size) || 0,
      liveParticles, anchors,
      entRoots: (ls && ls.entitiesGroup && ls.entitiesGroup.children.length) || 0,
    };
  }).catch(() => null);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chat = (page, c) =>
  page.evaluate((cmd) => { try { window.__sessionHandle.sendChat(cmd); } catch (_) {} }, c).catch(() => {});

export async function waitInWorld(page, log = () => {}) {
  for (let i = 0; i < 240; i++) {
    const bs = await page.evaluate(() => window.__bootState).catch(() => null);
    if (bs === "in-world" || bs === "ready") break;
    if (bs === "error") { log("boot error"); return false; }
    await sleep(1000);
  }
  for (let i = 0; i < 90; i++) {
    if (await page.evaluate(() => !!(window.liveScene3d && window.liveScene3d.scene)).catch(() => false)) return true;
    await sleep(1000);
  }
  return false;
}

/**
 * Teleport to `poi` and settle HARD. Returns
 * `{ settled, state, elapsedS, plateauAtS }` — check `settled`; a false means
 * the numbers you are about to take are NOT comparable to anything.
 */
export async function settleAt(page, poi, opts = {}) {
  const o = { ...SETTLE_DEFAULTS, ...opts };
  const log = opts.log || (() => {});
  await chat(page, `@telepoi ${poi}`);
  // Pin the exact pose when given: `@telepoi` does NOT land identically run to
  // run (the character settles/slides), and position decides the RP6 cull set,
  // which decides the draw count. `pinPose` is "0xCELL x y z [qw qx qy qz]",
  // passed verbatim to @teleloc (same argument order as @loc).
  if (o.pinPose) { await sleep(4000); await chat(page, `@teleloc ${o.pinPose}`); }
  const t0 = Date.now();
  let prev = null, heldSince = null, plateauAtS = null;
  while (Date.now() - t0 < o.timeoutMs) {
    await sleep(o.pollMs);
    const s = await worldState(page);
    if (!s || s.terrEverBaked === 0) { prev = s; continue; }
    // EXACT equality on the two ramping quantities — not a tolerance. A
    // tolerance is what let the ramp tail (+47, +29) read as "stable".
    const same = prev && s.emitters === prev.emitters && s.terrEverBaked === prev.terrEverBaked;
    if (same) {
      if (heldSince === null) { heldSince = Date.now(); plateauAtS = +((heldSince - t0) / 1000).toFixed(0); }
      const heldMs = Date.now() - heldSince;
      const elapsed = Date.now() - t0;
      if (heldMs >= o.stableMs && elapsed >= o.minSettleMs) {
        const elapsedS = +(elapsed / 1000).toFixed(0);
        log(`SETTLED @${poi} after ${elapsedS}s (plateau from ~t+${plateauAtS}s, held ${(heldMs / 1000) | 0}s): ` +
            `emitters=${s.emitters} anchors=${s.anchors} liveParticles=${s.liveParticles} terrEverBaked=${s.terrEverBaked} entRoots=${s.entRoots} ` +
            `pose=${s.pose ? `0x${s.pose.lb.toString(16)} (${s.pose.x},${s.pose.y},${s.pose.z}) hdg=${s.pose.heading}` : "?"}`);
        if (!o.pinPose) log(`   ^ pose NOT pinned — draw counts are NOT comparable to another page load (pass pinPose)`);
        return { settled: true, state: s, elapsedS, plateauAtS };
      }
    } else {
      heldSince = null; plateauAtS = null;
    }
    prev = s;
  }
  const s = await worldState(page);
  log(`!! NOT SETTLED @${poi} within ${o.timeoutMs / 1000}s — numbers are NOT comparable: ${JSON.stringify(s)}`);
  return { settled: false, state: s, elapsedS: +((Date.now() - t0) / 1000).toFixed(0), plateauAtS };
}

/**
 * Kill session-history bleed: teleport to `poi`, RELOAD so the character's saved
 * spawn IS `poi`, then settle. Every run then starts spawned on the POI with no
 * travel history, so `terrainBakedLbs` (cumulative) and the emitter plateau
 * (travel reaps emitters) are identical by construction rather than by luck.
 * `reload(page)` must re-navigate with the SAME query and return once in-world.
 */
export async function settleNormalized(page, poi, reload, opts = {}) {
  const log = opts.log || (() => {});
  log(`normalizing spawn -> @telepoi ${poi}, reload, then settle`);
  await chat(page, `@telepoi ${poi}`);
  await sleep(8000); // let the server persist the new position before we drop
  await reload(page);
  return settleAt(page, poi, opts);
}
