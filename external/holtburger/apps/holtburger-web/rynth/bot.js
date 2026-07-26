// createGrindBot — the one-call entrypoint that wires the whole RynthSuite
// port together on a live SessionHandle. This is the capstone over the
// individual modules (webhost / combat_loop / buff_loop / loot_loop /
// vitals / kernel / control_channel), each of which is independently
// live-verified (see the rynth_*_smoke.cjs harnesses + docs/rynth-integration).
//
// Usage (in a booted, in-world holtburger-web page):
//   import { createGrindBot } from "/apps/holtburger-web/rynth/bot.js";
//   const bot = await createGrindBot(window.__sessionHandle, {
//     buffs: [2, 24],                 // self-buff spell ids to maintain
//     priorities: { olthoi: 10 },     // T8 monster-name -> priority
//     loot: { minValue: 0 },          // Value(19) loot threshold
//     control: { prefix: "!bot" },    // in-game tell control ("!bot status")
//     vitals: { healAtCombat: 60 },   // B16 threshold overrides
//     nav: { endpoint: "http://127.0.0.1:8767" }, // RynthNav sidecar -> bot.goto(to)
//     ai: { apiKey: "sk-or-..." },    // LLM director (rynth/ai/README.md) —
//                                     // also key-activated via window.rynthAI.setKey
//     hz: 10,                          // tick rate
//   });
//   // bot.host, bot.kernel, bot.channel, bot.status(); bot.stop()

// World-frame + outdoor-LandCell math — the ONE copy (C3 Stage-0 dedup). A
// static relative import resolves against this module's own URL, so it works
// both from the served page and under file:// (node fixture tests) — the same
// property the runtime `base` gives the dynamic sibling imports below.
import { worldX, worldY, worldToOutdoorCell, normalizeLegWorldFrame } from "./nav_frame.js";

export async function createGrindBot(sessionHandle, config = {}) {
  // Sibling-module base derived from THIS module's URL: identical to the
  // old hardcoded "/apps/holtburger-web/rynth" when served from the page,
  // and additionally resolves under file:// (node fixture tests).
  const base = new URL(".", import.meta.url).href.replace(/\/$/, "");
  const [wh, cl, bl, ll, vt, kn, cc, rt, uw] = await Promise.all([
    import(`${base}/webhost.js`),
    import(`${base}/combat_loop.js`),
    import(`${base}/buff_loop.js`),
    import(`${base}/loot_loop.js`),
    import(`${base}/vitals.js`),
    import(`${base}/kernel.js`),
    import(`${base}/control_channel.js`),
    import(`${base}/router.js`),
    import(`${base}/unwedge.js`),
  ]);

  const host = new wh.RynthWebHost(sessionHandle, config.hostOpts || {});
  host.nearbyRangeM = config.nearbyRangeM ?? 60;

  // Filter desired buffs to the known-spell book so the buff loop never
  // spins on a spell the character can't cast.
  const known = new Set(
    (sessionHandle.playerKnownSpells ? Array.from(sessionHandle.playerKnownSpells() || []) : []).map(Number)
  );
  const buffIds = (config.buffs || []).filter((id) => known.has(id));

  // Persona survival wiring (WP-4, C5-2 + C5-3 / FM-2 + FM-3): an explorer
  // bot boots with combat hunting OFF and looting OFF so it never picks a
  // fight it can't win nor diverts to a corpse while surveying — the director
  // re-arms either at runtime (hunt_start / set_loot_min_value). The grind
  // persona (the default) keeps both on. Persona arrives as config.ai.persona
  // (index.html ?botPersona=explorer, URL-carried across reconnect reboots).
  const isExplorer =
    !!config.ai && typeof config.ai === "object" && config.ai.persona === "explorer";

  const combat = new cl.RynthCombatLoop(host, { priorities: config.priorities || {} });
  if (isExplorer) combat.enabled = false; // hunting OFF at boot (combat_loop _scanTargets gate); hunt_start re-arms
  const buff = buffIds.length ? new bl.RynthBuffLoop(host, buffIds) : null;
  if (buff) bl.loadSpellLadders(); // B4/B5 — preload the family tier table
  // Explicit config.loot.enabled always wins; otherwise explorer -> false,
  // grind -> true. loot_loop's own `enabled` flag makes tick() a no-op (zero
  // MoveToPosition) when off; config.loot === false drops the loop entirely.
  const lootOpts = config.loot || {};
  const loot =
    config.loot === false
      ? null
      : new ll.RynthLootLoop(host, { ...lootOpts, enabled: lootOpts.enabled ?? !isExplorer });
  const vitals = config.vitals === false ? null : new vt.RynthVitals(host, { thresholds: config.vitals || {} });

  // Wedge self-recovery reflex (unwedge.js, 2026-07-24) — general,
  // location-agnostic: detects "movement commanded but the pose isn't
  // translating" anywhere, retreats to a breadcrumb of recently-free poses,
  // escalates to recall. DEFAULT ON (core recovery, not a behavior change
  // for a healthy bot — it only ever acts once wedged); config.unwedge ===
  // false disables, an object passes threshold overrides through.
  const unwedge =
    config.unwedge === false
      ? null
      : new uw.UnwedgeReflex(host, typeof config.unwedge === "object" && config.unwedge ? config.unwedge : {});

  const kernel = new kn.RynthBotKernel(host, { combat, buff, loot, vitals, unwedge });

  // netBrain (D1 path A′): opt-in .NET-wasm brain slices behind the same
  // seam — config.netBrain ("shadow"|"on") wins over the ?netBrain URL flag;
  // anything else stays off with zero cost. The AppBundle loads lazily and
  // attaches when ready; load failure leaves the JS brain untouched.
  const nbModule = await import(`${base}/netbrain.js`);
  const nbMode = config.netBrain ?? nbModule.netBrainModeFromUrl();
  if (nbMode === "shadow" || nbMode === "on") {
    nbModule.diag().mode = nbMode;
    nbModule
      .loadNetBrain(config.netBrainBundleUrl ? { bundleUrl: config.netBrainBundleUrl } : {})
      .then((brain) => {
        if (!brain) return;
        // The buff shadow's C# spine includes the vitals policy — it needs
        // the live vitals config/fractions and the combat lock for InCombat.
        const nbOpts = { vitals, combat };
        for (const loop of [combat, buff, loot, vitals])
          loop?.attachNetBrain?.(brain, nbMode, nbModule, nbOpts);
      });
  }

  // Router is on-demand travel, NOT a kernel priority — the caller drives a
  // route explicitly (pausing the grind while travelling is the caller's
  // choice). Ticked off the same host heartbeat. config.router passes
  // RynthRouter timing overrides through (tests / live tuning).
  const router = new rt.RynthRouter(host, config.router || {});
  host.onTick(() => router.tick());
  // The unwedge reflex ticks off the HOST heartbeat, not the kernel tick —
  // every mover (goto/egress/followRoute/travel/cruise) stops the kernel for
  // the duration of its walk, which is exactly when a wedge happens; a
  // kernel-driven reflex would be blind then. Registered AFTER the router's
  // tick so detection reads this tick's router state.
  if (unwedge) host.onTick(() => unwedge.tick());

  // Explore pressure (task #15, ?explorePressure=1 — index.html bot-param
  // block; exact-match opt-in, default OFF): today the bot is 100% statue
  // between AI-director check-ins — the kernel has no locomotion of its own
  // and router.tick() only advances an ALREADY-loaded route. This adds a
  // cheap (~5s cadence) idle-pressure tick that nudges the bot with ambient
  // motion while the director isn't actively driving it. Lazy: the flag off
  // (the default) imports nothing extra and costs one falsy `if` per boot —
  // see ExplorePressureController below for the full activation contract.
  let explorePressure = null;
  if (config.explorePressure === true) {
    const [irMod, opsMod, townsMod, guardMod] = await Promise.all([
      import(`${base}/indoor_router.js`),
      import(`${base}/ai/operator_stop.js`),
      import(`${base}/ai/tools/towns.js`),
      import(`${base}/nav_guard.js`),
    ]);
    // WP-9 nav shield: fold the pure guard (guardLeg/legalIndoorReroute) into
    // the indoor-router namespace the controller reads as `this.ir`, so leg
    // issuance can gate on this.ir.guardLeg. indoor_router.js itself stays
    // import-free (its tmpdir-copy sim test copies only that one file), so the
    // merge happens here rather than as a re-export inside indoor_router.
    const ir = { ...irMod, guardLeg: guardMod.guardLeg, legalIndoorReroute: guardMod.legalIndoorReroute };
    explorePressure = new ExplorePressureController(host, router, ir, opsMod, {
      log: typeof config.explorePressureLog === "function" ? config.explorePressureLog : undefined,
      towns: townsMod.TOWNS,
    });
    host.onTick(() => explorePressure.tick());
  }

  // Global nav (report 09 sidecar): config.nav = { endpoint } wires a
  // GlobalRouter so bot.goto(to) plans a cross-world route via the RynthNav
  // sidecar and walks it. Unlike travel(), goto() restores the kernel's
  // PRIOR run state when the walk completes (or fails) — a goto issued
  // while the kernel was deliberately stopped must not restart the grind.
  // goto_compose provides both the goto composition (needs nav) and the
  // portal-aware followRoute replay (task #17, independent of nav), so it loads
  // unconditionally.
  const gcMod = await import(`${base}/goto_compose.js`);
  let globalRouter = null;
  let composeGoto = null; // outdoor<->indoor goto composition (goto_compose.js)
  if (config.nav) {
    const gr = await import(`${base}/global_router.js`);
    // Off-mesh frontier gate (2026-07-24, stream-soak diagnosis): when a plan
    // comes back off-mesh (the navmesh can't route to the GOAL — a rooftop /
    // building interior / portal-only cell), avoid-mark that goal so the
    // explorer's frontier() stops re-offering it and grinding a straight-line
    // stitch into a wall. Reuses the existing exploreMemory wedge-avoid set.
    // DEFAULT-ON with an explicit off escape (house footgun rule).
    let offMeshGate = true;
    try {
      const raw = (new URLSearchParams(globalThis.location?.search || "").get("offMeshFrontierGate") || "").toLowerCase();
      offMeshGate = !(raw === "off" || raw === "0" || raw === "false");
    } catch { offMeshGate = true; }
    let _lastOffMeshMark = null; // {wx,wy} — light dedupe so one goal isn't re-marked every replan
    const onPlan = offMeshGate
      ? ({ goalWorld, coverage, stitchedLegs, legCount }) => {
          if (!goalWorld) return;
          const em = bot?.ai?.extensions?.exploreMemory;
          if (!em || typeof em.markWedge !== "function") return;
          if (_lastOffMeshMark && Math.hypot(goalWorld.wx - _lastOffMeshMark.wx, goalWorld.wy - _lastOffMeshMark.wy) < 6) return;
          _lastOffMeshMark = { wx: goalWorld.wx, wy: goalWorld.wy };
          em.markWedge(goalWorld.wx, goalWorld.wy, 10);
          try {
            bot?.ai?.journal?.add?.(
              "note",
              `[offmesh] frontier goal is off the navmesh (coverage=${coverage}, ${stitchedLegs}/${legCount} stitch) — ` +
                `avoid-marked so it stops being re-picked`,
            );
          } catch { /* journal loss is not fatal */ }
        }
      : null;
    globalRouter = new gr.GlobalRouter(host, { endpoint: config.nav.endpoint, onPlan });
    composeGoto = gcMod.composeGoto;
  }
  // Concurrency guard for doGoto that also covers INDOOR-only compositions:
  // globalRouter.busy is only set while an OUTDOOR (sidecar) phase runs, so an
  // indoor exit/enter walk would otherwise leave the latch clear. Set for the
  // whole doGoto duration; a second goto is refused while it is up.
  let composeActive = false;
  // Short human label for a travel target — mission line + journal reasons.
  const gotoLabel = (to) =>
    to && typeof to === "object"
      ? "ns" in to
        ? `${Math.abs(to.ns).toFixed(1)}${to.ns >= 0 ? "N" : "S"} ${Math.abs(to.ew).toFixed(1)}${to.ew >= 0 ? "E" : "W"}`
        : `0x${((to.lb ?? 0) >>> 0).toString(16).toUpperCase()}`
      : "?";

  // doGoto composes outdoor (sidecar) and indoor (EnvCell A*) routing via
  // goto_compose.js: it walks OUT of a building first when the bot starts
  // indoors, walks IN to an EnvCell goal after the outdoor approach, and does a
  // pure indoor A* for a same-landblock indoor->indoor hop. Neither end indoors
  // => the outdoor path is IDENTICAL to before. DROP LIMITATION (carried from
  // indoor_router.js:34-37): indoor A*/exit ROUTE PLANNING still prunes every
  // drop/jump edge (no jump-feasibility test in the graph search — that's
  // Phase 3 of DESIGN-jump-primitive-2026-07-21.md), so a goal or exit
  // reachable only by a drop still fails honestly ({ok:false, error:"indoor
  // graph unavailable"|"...unreachable"}). This is planning-time only now —
  // doFollowRoute below DOES execute corpus-recorded `jmp` legs (Phase 1,
  // goto_compose.js attemptJumpLeg) when replaying an imported .nav route.
  const doGoto = async (to, opts) => {
    if (!globalRouter) return { ok: false, error: "nav not configured (config.nav)" };
    // Refuse BEFORE touching the kernel: a rejected second goto must not
    // stop/restart the kernel out from under the mover that owns it. composeActive
    // covers indoor-only phases where globalRouter.busy is momentarily clear;
    // followBusy covers an in-flight followRoute atlas walk — same tier as a
    // goto, so refused rather than raced (05 C1 / bot.movementClaimed below).
    // NOTE: deliberately NOT the full movementClaimed() predicate here — a
    // bare router WALK/PORTAL left by travel() (which sets none of these
    // latches) is intentionally OVERRIDDEN a few lines down, not refused
    // ("last command wins over a raw travel()", B4 test).
    if (unwedge && unwedge.active()) return { ok: false, error: "unwedge recovery active" };
    if (globalRouter.busy || composeActive || followBusy) return { ok: false, error: "goto already active" };
    // Last command wins over a raw travel() in progress.
    const rs = router.status.state;
    if (rs === "WALK" || rs === "PORTAL") {
      router.cancel();
    }
    const wasRunning = kernel.running === true; // kernel's is-running signal
    kernel.stop();
    // Mission = first-class harness travel state (SPEC-navatlas §3-W3.3):
    // the observation reports it; the AI never has to model-memory "am I
    // walking somewhere". interrupts is bumped by the early-check wiring.
    const label = gotoLabel(to);
    bot.mission = { kind: "goto", label, to, startedAt: Date.now(), interrupts: 0 };
    try { bot._onTravelStart?.({ kind: "goto", label, to }); } catch { /* hook must not break travel */ }
    let r = null;
    composeActive = true;
    try {
      r = await composeGoto(
        {
          host,
          router,
          outdoorGoto: (t, o) => globalRouter.goto(router, t, o),
          // In-page the EnvCell graph builder resolves fetchEnvCellsInLandblock
          // off window.liveScene3d (indoor_router.js); a headless/nullRender bot
          // supplies it via config.nav.fetchEnvCells instead.
          ...(config.nav.fetchEnvCells ? { fetchEnvCells: config.nav.fetchEnvCells } : {}),
          log: (m) => (config.nav.log || (() => {}))(`[gnav-compose] ${m}`),
        },
        to,
        opts,
      );
      return r;
    } finally {
      composeActive = false;
      if (wasRunning) kernel.start();
      const m = bot.mission;
      bot.mission = null;
      if (m) bot.lastMission = { ...m, endedAt: Date.now(), result: r ? { ok: r.ok === true, state: r.state ?? null, coverage: r.coverage ?? null } : null };
      try { bot._onTravelDone?.({ kind: "goto", label, to, result: r, mission: m }); } catch { /* hook must not break travel */ }
      // Loud fallback (SPEC-navatlas §3-W1.2): pure "straight" coverage =
      // the route walked blind through unbaked terrain — the wall-grind
      // class. "mixed" is normal on portal routes (transit hops count as
      // tiny straight segments) and needs no warning.
      try {
        if (r?.coverage === "straight")
          bot.ai?.journal?.add?.(
            "note",
            `route to ${label} was STRAIGHT-LINE (unbaked region) — obstacles were not routed around; treat wall-grinds/stalls here as expected, prefer known routes or other destinations`,
          );
      } catch { /* note loss must not break travel */ }
      // Route events are the check-in triggers (SPEC-navatlas §3-W3.2); the
      // director's debounce/budget still bound the cost.
      try {
        const cov = r?.coverage ? `, coverage ${r.coverage}` : "";
        bot.ai?.director?.requestEarlyCheck(
          r?.ok ? `route arrived: ${label}${cov}` : `route FAILED: ${label} (${r?.state ?? r?.error ?? "?"}${cov})`,
          { minGapSeconds: 10 },
        );
      } catch { /* event wiring must not break travel */ }
    }
  };

  // Awaited indoor EGRESS (2026-07-23, live Holtburg-tavern fix): walk OUT of
  // the current building/dungeon to the nearest outdoor mouth via
  // goto_compose.composeEgress (doorway pre-approach legs, closed-door
  // opening, bounded twice-wedged edge-exclusion retries — exitToOutdoors'
  // ladder). Unlike doGoto this needs NO nav sidecar (indoor-only), and
  // unlike the legacy exit_building path (dungeonNav.exitRoute +
  // fire-and-forget bot.travel) it AWAITS the walk and reports the honest
  // outcome — the old path returned ok the moment the router accepted the
  // legs, so a wedged exit still journaled as a success ("PLAN-DONE
  // exit_building but I only shifted 2m"). Kernel/mission semantics mirror
  // doGoto: pause + prior-state restore, mission {kind:"egress"}, the
  // composeActive latch for the whole duration, last-command-wins over a raw
  // travel().
  const doEgress = async (opts) => {
    if (unwedge && unwedge.active()) return { ok: false, error: "unwedge recovery active" };
    if ((globalRouter && globalRouter.busy) || composeActive || followBusy) {
      return { ok: false, error: "goto already active" };
    }
    const rs0 = router.status.state;
    if (rs0 === "WALK" || rs0 === "PORTAL") router.cancel(); // last command wins over travel()
    const wasRunning = kernel.running === true;
    kernel.stop();
    const label = "exit building";
    bot.mission = { kind: "egress", label, startedAt: Date.now(), interrupts: 0 };
    try { bot._onTravelStart?.({ kind: "egress", label }); } catch { /* hook must not break travel */ }
    let r = null;
    composeActive = true;
    try {
      r = await gcMod.composeEgress(
        {
          host,
          router,
          ...(config.nav?.fetchEnvCells ? { fetchEnvCells: config.nav.fetchEnvCells } : {}),
          log: (m) => (config.nav?.log || config.router?.log || (() => {}))(`[egress] ${m}`),
        },
        opts,
      );
      return r;
    } finally {
      composeActive = false;
      if (wasRunning) kernel.start();
      const m = bot.mission;
      bot.mission = null;
      if (m) bot.lastMission = { ...m, endedAt: Date.now(), result: r ? { ok: r.ok === true, state: r.state ?? null, coverage: "indoor" } : null };
      try { bot._onTravelDone?.({ kind: "egress", label, result: r, mission: m }); } catch { /* hook must not break travel */ }
      try {
        bot.ai?.director?.requestEarlyCheck(
          r?.ok
            ? `egress complete: outdoors${r.attempts > 1 ? ` after ${r.attempts} attempts` : ""}`
            : `egress FAILED (${r?.error ?? "?"})`,
          { minGapSeconds: 10 },
        );
      } catch { /* event wiring must not break travel */ }
    }
  };

  // Blocked-fact probe (SPEC-navatlas §3-W2.5): when a route leg FAILs, a
  // sphere-sweep along the failed leg turns a mystery 30 s wall-grind into a
  // journal fact the director can act on. Lazy; absence/error degrades to no
  // note. (global_router owns the pre-walk probes on straight coverage.)
  const probeFailedLeg = async (legs, legIdx) => {
    try {
      const sp = await import(`${base}/sweep_probe.js`);
      const pose = host.TryGetPlayerPose?.();
      const leg = Array.isArray(legs) ? legs[legIdx] : null;
      if (!sp?.probeFromSession || !sp?.probeSegment || !pose || !leg) return;
      const probe = sp.probeFromSession(host.s);
      const from = { lb: pose.objCellId >>> 0, x: pose.x, y: pose.y, z: pose.z };
      const r = sp.probeSegment(probe, from, leg);
      if (r?.blocked)
        bot.ai?.journal?.add?.(
          "note",
          `route blocked ~${Math.round(r.atMeters)}m ahead by ${r.hitKind}` +
            (r.hitPoint ? ` at (${r.hitPoint.x.toFixed(0)},${r.hitPoint.y.toFixed(0)})` : "") +
            " — do not retry the same line; sidestep or pick another route",
        );
    } catch { /* probing must never break the failure path */ }
  };

  // Atlas-route travel (SPEC-navatlas §3-W3.1): walk pre-planned legs with
  // goto's kernel semantics (pause + prior-state restore) and a completion
  // promise. Last command wins: a goto() cancels this walk (poll sees IDLE).
  let followBusy = false;
  const doFollowRoute = async (legs, { label = "route", pollMs = 500, timeoutMs = 15 * 60_000, reverse = false, fmt } = {}) => {
    // 05 C1 fix: composeActive is added here (globalRouter.busy alone goes
    // false mid-composeGoto indoor phase) — see bot.movementClaimed below,
    // which both this guard and the explore-pressure gates now consult.
    if (bot.movementClaimed()) {
      // Last-command-wins over a pressure CRUISE (movement-utilization fix,
      // 2026-07-23): when the ONLY claim is the router walking the explore-
      // pressure controller's own idle drive (a raw travel it marked via
      // cruising()), cancel it and proceed — the exact treatment doGoto/
      // doEgress already give a raw travel() WALK. Any other claim
      // (goto/compose/followRoute in flight, a loot approach, or a raw
      // travel that is NOT a cruise) still refuses, unchanged.
      const rs = router.status.state;
      const cruiseOnly =
        explorePressure?.cruising?.() === true &&
        !(globalRouter && globalRouter.busy) && !composeActive && !followBusy &&
        !(unwedge && unwedge.active()) &&
        (rs === "WALK" || rs === "PORTAL") &&
        !(loot && loot.state === "APPROACH");
      if (!cruiseOnly) return { ok: false, error: "goto active" };
      router.cancel();
    }
    if (!Array.isArray(legs) || !legs.length) return { ok: false, error: "empty route" };
    // Contract v2 (task #17): derive portal/indoor flags (legacy routes replay
    // without re-recording), re-bucket indoor legs to the walkable frame + stamp
    // their long watchdog. A plain outdoor route gains no flags -> untouched.
    const preparedLegs = gcMod.prepareReplayLegs(legs, { fmt });
    const hasPortals = gcMod.routeHasPortals(preparedLegs);
    // jmp legs (2026-07-21, DESIGN-jump-primitive Phase 1): a jump-only route
    // (no portal legs at all — e.g. a pure vr-bridge-jump-style gap-crossing
    // fixture) still needs replayRoute's recovery branches to fire
    // attemptJumpLeg; routeHasPortals alone would miss it (jmp legs are
    // plain waypoints, never flagged .portal — nav_import.js).
    const hasJumps = typeof gcMod.routeHasJumps === "function" ? gcMod.routeHasJumps(preparedLegs) : false;
    // One-way portals can't be walked backwards.
    if (reverse && hasPortals)
      return { ok: false, error: "route crosses one-way portals — reverse replay unsupported" };
    followBusy = true;
    const wasRunning = kernel.running === true;
    kernel.stop();
    bot.mission = { kind: "route", label, startedAt: Date.now(), interrupts: 0 };
    try { bot._onTravelStart?.({ kind: "route", label, legs: preparedLegs }); } catch { /* hook must not break travel */ }
    let result = { ok: false, state: "UNKNOWN" };
    try {
      if (hasPortals || hasJumps) {
        // Portal and/or jump route: goto_compose owns the router walk (native
        // portal hop + resume, touch assist on a blocked portal, one indoor-
        // wedge re-path, jmp-leg firing on a jump-adjacent stall).
        result = await gcMod.replayRoute(
          { host, router, fetchEnvCells: config.nav?.fetchEnvCells, log: config.router?.log },
          preparedLegs,
          { pollMs, timeoutMs },
        );
      } else {
        router.follow(preparedLegs);
        const t0 = Date.now();
        for (;;) {
          await new Promise((r) => setTimeout(r, pollMs));
          const st = router.status;
          if (st.state === "DONE") { result = { ok: true, state: "DONE", legsWalked: st.legs }; break; }
          if (st.state === "FAILED") {
            result = { ok: false, state: "FAILED", leg: st.leg };
            void probeFailedLeg(preparedLegs, st.leg); // async fact-finding; never awaited into the walk
            break;
          }
          if (st.state === "IDLE") { result = { ok: false, state: "CANCELLED" }; break; }
          if (Date.now() - t0 > timeoutMs) { router.cancel(); result = { ok: false, state: "TIMEOUT" }; break; }
        }
      }
    } finally {
      followBusy = false;
      if (wasRunning) kernel.start();
      const m = bot.mission;
      bot.mission = null;
      if (m) bot.lastMission = { ...m, endedAt: Date.now(), result: { ok: result.ok, state: result.state, coverage: null } };
      try { bot._onTravelDone?.({ kind: "route", label, result, mission: m }); } catch { /* hook must not break travel */ }
      // A recall-unavailable leg (goto_compose.js attemptRecallCast) is a
      // real, actionable prerequisite gap (the character doesn't know/can't
      // cast the route's recall spell) — surface it as a named journal fact
      // rather than a generic route-FAILED state, same spirit as
      // probeFailedLeg's blocked-fact note on the plain-route path above.
      if (!result.ok && result.reason === "recall-unavailable") {
        try { bot.ai?.journal?.add?.("note", `route "${label}" blocked at leg ${result.leg ?? "?"}: ${result.error}`); } catch { /* journal optional */ }
      }
      try {
        bot.ai?.director?.requestEarlyCheck(
          result.ok ? `route arrived: "${label}"` : `route FAILED: "${label}" (${result.state})`,
          { minGapSeconds: 10 },
        );
      } catch { /* event wiring must not break travel */ }
    }
    return result;
  };

  const channel =
    config.control === false
      ? null
      : new cc.RynthControlChannel(host, kernel, {
          ...(config.control || {}),
          ...(globalRouter ? { onGoto: (to) => doGoto(to) } : {}),
          // "come" bypass fix (report 01 C2): control_channel's _comeToSender
          // reuses bot.travel — the lightest existing guarded mover (a
          // single-leg router walk that stops+restores the kernel, item 2's
          // fix) — instead of the old raw host.MoveToPosition with the
          // kernel untouched. Unconditional: bot.travel needs only `router`,
          // not config.nav (unlike onGoto/globalRouter above).
          onCome: (leg) => bot.travel([leg]),
          // Lazy: the AI director is constructed AFTER the bot object below
          // (it observes the whole bot surface); events only pump once the
          // host heartbeat runs, so this closure never fires before `bot`.
          getAi: () => bot.ai?.director,
        });

  host.start(config.hz ?? 10);
  // config.kernel === false: no grind loops at all (combat/loot/buff/vitals
  // stay idle — explorer persona / pure-travel sessions). goto/followRoute
  // key their kernel restore off wasRunning, so it STAYS off across routes.
  if (config.kernel !== false) kernel.start();

  const bot = {
    host,
    kernel,
    channel,
    combat,
    buff,
    loot,
    vitals,
    router,
    globalRouter,
    unwedge, // wedge self-recovery reflex (introspection/testing seam; null when config.unwedge === false)
    startedAt: Date.now(), // uptime anchor — ai/observe.js prefers bot.startedAt
    // One movement-claim predicate (P1 fix, 05 C1 / 17-SYNTHESIS §1 "Character
    // movement" #12): every OTHER actor that must yield while something else
    // owns the character consults THIS instead of re-deriving a subset of it
    // (re-deriving a subset is exactly how the composeGoto-indoor-phase race
    // happened — globalRouter.busy alone goes false mid-indoor-phase while
    // composeActive/followBusy/router are still live). Also sees loot's
    // approach (03 C4 / item 4): kernel.action reads "Loot" for exactly the
    // window loot_loop.js is actively working a corpse (its own SCAN/APPROACH
    // raw MoveToPosition, loot_loop.js:161,191 — kernel.js's own
    // _corpseAvailable/lootPinned gate), which has no busy latch of its own.
    // doGoto is the one exception: it deliberately does NOT call this for its
    // own early-refusal — a bare router WALK/PORTAL left by travel() (which
    // sets none of these latches) is intentionally overridden there, not
    // refused ("last command wins over a raw travel()", B4 test).
    movementClaimed: () => {
      if (unwedge && unwedge.active()) return true; // wedge recovery owns the body until freed
      if (globalRouter && globalRouter.busy) return true;
      if (composeActive) return true;
      if (followBusy) return true;
      const rs = router.status?.state;
      if (rs === "WALK" || rs === "PORTAL") return true;
      if (loot && loot.state === "APPROACH") return true;
      return false;
    },
    /** Travel a raw route ([{lb,x,y,z}]) — pauses the grind, restores its
     *  prior run state when the walk reaches a terminal state (B1 fix, report
     *  01: previously stopped the kernel with no restore at all, so a
     *  kernel-on persona ground dead after exit_building/_escalateOut).
     *  Fire-and-forget by design (callers don't await a walk here, unlike
     *  goto/followRoute) — the restore runs off a background poll instead of
     *  an awaited finally. Refused while a goto/followRoute/composeGoto phase
     *  owns the router (a raw follow would clobber that walk); a later
     *  goto() still cancels a raw travel in progress (last command wins,
     *  unchanged). Returns {ok}. */
    travel: (route) => {
      if (unwedge && unwedge.active()) return { ok: false, error: "unwedge recovery active" };
      if ((globalRouter && globalRouter.busy) || composeActive || followBusy) {
        return { ok: false, error: "goto active" };
      }
      const wasRunning = kernel.running === true;
      kernel.stop();
      router.follow(route);
      if (wasRunning) {
        (async () => {
          try {
            for (;;) {
              await new Promise((r) => setTimeout(r, 500));
              const st = router.status.state;
              if (st === "DONE" || st === "FAILED" || st === "IDLE") break;
            }
            // Handed off mid-walk to a goto/followRoute (cancelled us and took
            // over) — that mover captured its own wasRunning and owns the
            // restore now; restoring here too would race it (05 C1's
            // two-writer class), so yield silently.
            if (composeActive || followBusy || (globalRouter && globalRouter.busy)) return;
            // Tolerant of kernel.js's operator-hold latch (prior-agent change):
            // start() returning false just means the operator/pause authority
            // wins — log it, never loop/retry.
            if (!kernel.start()) kernel.log("travel: restore refused (operator hold active)");
          } catch (e) {
            kernel.log(`travel: restore watcher error: ${(e && e.message) || e}`);
          }
        })();
      }
      return { ok: true };
    },
    /**
     * Sidecar-planned travel to {lb,x,y,z} or {ns,ew} (/loc degrees) —
     * pauses the grind, plans+walks+replans, restores the kernel's prior
     * run state on completion. One goto at a time ({ok:false,
     * error:"goto already active"} while one runs). Resolves
     * {ok, state, legsWalked, replans}.
     */
    goto: (to, opts) => doGoto(to, opts),
    /** Awaited indoor egress to the nearest outdoor mouth (doEgress above —
     *  goto_compose.composeEgress retry ladder). Works WITHOUT config.nav.
     *  Resolves {ok, state, attempts?, legsWalked, exitCell?, outdoorId?,
     *  alreadyOutdoors?, error?}. One mover at a time (refused while a
     *  goto/followRoute runs); cancels a raw travel() (last command wins). */
    egress: (opts) => doEgress(opts),
    /** Walk pre-planned atlas legs with goto's kernel semantics; resolves
     *  {ok, state, legsWalked?}. One at a time; refused while a goto runs. */
    followRoute: (legs, opts) => doFollowRoute(legs, opts),
    mission: null,      // live travel state (SPEC-navatlas §3-W3.3); null when idle
    lastMission: null,  // most recent completed mission {..., endedAt, result}
    status: () => ({ ...kernel.status, router: router.status }),
    capabilities: () => host.capabilities,
    stop: () => {
      kernel.stop();
      router.cancel();
      host.stop();
    },
  };
  // Bind the controller to the real bot object now that it exists — its
  // tick() only fires asynchronously off the host heartbeat, well after this
  // synchronous constructor body finishes (same "capture now, use later"
  // pattern doGoto/doFollowRoute already rely on for `bot.mission` above).
  if (explorePressure) {
    explorePressure.bot = bot;
    bot.explorePressure = explorePressure; // introspection/testing seam
  }
  // Same capture-now-use-later binding as explorePressure: the reflex's
  // tick() only fires off the host heartbeat, after this constructor body.
  if (unwedge) unwedge.bot = bot;

  // AI director (rynth/ai/SPEC.md §Wiring) — opt-in by key presence or an
  // explicit config.ai object; config.ai === false skips even the key probe.
  // Guarded: a broken/stale ai module must never abort bot construction —
  // the bot grinds fine without the director (SPEC invariant).
  if (config.ai !== false) {
    try {
      await wireAiDirector(bot, config.ai, base);
    } catch (e) {
      console.warn("[rynth] AI wiring failed, grinding without director:", e);
    }
  }

  // Console-pasteable VTank/.nav import (nav_import.js wiring, 2026-07-20):
  //   await window.rynthImportNav(pastedText, "my-route-name")
  // Mirrors ai/tools/routes.js's getAtlas() — reuses window.__atlas if the AI
  // routes actions already created one (so follow_route/list_routes see the
  // SAME saved route immediately), otherwise lazily creates+caches it there
  // itself. A broken/missing nav_import.js must never break bot construction,
  // so this is wired best-effort after `bot` exists, same as the AI director.
  if (typeof window !== "undefined") {
    window.rynthImportNav = async (text, name) => {
      try {
        const [ni, atlasMod] = await Promise.all([import(`${base}/nav_import.js`), import(`${base}/atlas.js`)]);
        let atlas = window.__atlas;
        if (!atlas) {
          const Atlas = typeof atlasMod.Atlas === "function" ? atlasMod.Atlas : atlasMod.default;
          atlas = new Atlas({});
          window.__atlas = atlas;
        }
        const isPlainNav = /^\s*uTank2 NAV 1\.2/i.test(String(text).split(/\r\n|\r|\n/, 1)[0] || "");
        if (isPlainNav) {
          const { route, warnings } = ni.importNavText(text, { name, atlas, fileName: name });
          if (!route) {
            console.warn(`[rynthImportNav] no route produced: ${warnings.join("; ")}`);
            return { route: null, warnings };
          }
          console.log(`[rynthImportNav] saved '${route.name}' (${route.legs.length} legs, ${route.portalsUsed} portal hop(s))${warnings.length ? ` — ${warnings.length} warning(s), see .warnings` : ""}`);
          return { route, warnings };
        }
        // Not a plain .nav header: treat as an embedded .af (NAVDATA:/NAV: sections).
        const { routes, warnings } = ni.importAfText(text, { atlas, namePrefix: name, fileName: name });
        if (!routes.length) {
          console.warn(`[rynthImportNav] no NAV sections found: ${warnings.join("; ")}`);
          return { route: null, routes: [], warnings };
        }
        for (const r of routes) {
          if (r.route) console.log(`[rynthImportNav] saved '${r.route.name}' (${r.route.legs.length} legs, ${r.route.portalsUsed} portal hop(s))${r.warnings.length ? ` — ${r.warnings.length} warning(s)` : ""}`);
        }
        // Single-section .af: hand back {route,warnings} directly like the
        // plain-.nav path so `await window.rynthImportNav(...)` is uniform for
        // the common case; multi-section .af additionally exposes `routes`.
        const only = routes.length === 1 ? routes[0] : null;
        return { route: only ? only.route : null, warnings: only ? only.warnings : warnings, routes };
      } catch (e) {
        console.warn(`[rynthImportNav] import failed: ${e.message}`);
        return { route: null, warnings: [String(e.message || e)] };
      }
    };
  }

  return bot;
}

// = ai/llm_client.js KEY_STORAGE, inlined so the no-key/no-config path never
// imports an ai module (SPEC §Wiring "zero cost when unused").
const AI_KEY_STORAGE = "holtburger_ai_key_v1";

// ui.js takes its key ops duck-typed (it does not import llm_client.js).
const aiKeyOps = (LlmClient) => ({
  loadKey: () => LlmClient.loadKey(),
  saveKey: (k) => LlmClient.saveKey(k),
  clearKey: () => LlmClient.clearKey(),
});

async function wireAiDirector(bot, aiConfig, base) {
  let aiCfg = aiConfig && typeof aiConfig === "object" ? aiConfig : null;
  // Persona -> base prompt (URL ?botPersona=..., survives reconnect reboots).
  // Explicit systemPrompt always wins; unknown personas fall through to the
  // default prompt rather than failing the wire-up.
  if (aiCfg && !aiCfg.systemPrompt && aiCfg.persona === "explorer") {
    try {
      const drm = await import(`${base}/ai/director.js`);
      if (typeof drm.EXPLORER_SYSTEM_PROMPT === "string") {
        aiCfg = { ...aiCfg, systemPrompt: drm.EXPLORER_SYSTEM_PROMPT };
      }
    } catch (_) {
      /* persona is best-effort — default prompt on any load failure */
    }
  }
  let storedKey = null;
  try {
    storedKey = globalThis.localStorage?.getItem(AI_KEY_STORAGE) ?? null;
  } catch { /* blocked storage -> treat as no key */ }
  const apiKey = aiCfg?.apiKey ?? storedKey;
  const wantPanel = (() => {
    try {
      return typeof location !== "undefined" && new URLSearchParams(location.search).get("aiPanel") === "1";
    } catch { return false; }
  })();

  if (!apiKey && !aiCfg) {
    // Bootstrap only: let a page user seed the key from the console and
    // reload. No ai module is imported on this path.
    if (typeof window === "undefined") return;
    window.rynthAI = {
      setKey(key) {
        try { localStorage.setItem(AI_KEY_STORAGE, String(key)); } catch { /* blocked */ }
        console.log("[rynthAI] key saved — reload to activate the AI director");
      },
    };
    // ?aiPanel=1 is an explicit UI request: mount the key-entry panel around
    // a null director (ui.js degrades cleanly) so the key can be saved by
    // GUI, then activated by reload.
    if (wantPanel) {
      const [lc, ui] = await Promise.all([import(`${base}/ai/llm_client.js`), import(`${base}/ai/ui.js`)]);
      ui.mountAiPanel(null, { client: aiKeyOps(lc.LlmClient) });
    }
    return;
  }

  const [lc, jn, dr, os] = await Promise.all([
    import(`${base}/ai/llm_client.js`),
    import(`${base}/ai/journal.js`),
    import(`${base}/ai/director.js`),
    import(`${base}/ai/operator_stop.js`),
  ]);
  // Failure log (2026-07-26): both the client and the director default their
  // `log` hook to a no-op, so every LLM failure lived ONLY in the journal —
  // a CDP console listener on the live rig saw nothing, and the 2026-07-26
  // soak's hour of HTTP 401s could not be read off the console at all. These
  // hooks only fire on retry/failure paths (llm_client retry + chat-failed,
  // director _fail, actions.js action-error/truncation), so the added console
  // volume is bounded by the failures themselves.
  const aiLog = (m) => { try { console.warn("[rynthAI]", m); } catch { /* no console */ } };
  const client = new lc.LlmClient({
    log: aiLog,
    apiKey,
    baseUrl: aiCfg?.baseUrl, // undefined -> client defaults (OpenRouter)
    timeoutMs: aiCfg?.timeoutMs, // undefined -> client default (60s); slow fp8 providers need 120s
    model: aiCfg?.model,
    maxTokens: aiCfg?.maxTokens, // reasoning-tier models need > the 1024 default
    reasoning: aiCfg?.reasoning, // e.g. { effort: "low" } — OpenRouter unified reasoning
    provider: aiCfg?.provider, // e.g. { order: ["novita"], allow_fallbacks: false } — OpenRouter provider pin
    referer: "https://holtburger.local",
    title: "holtburger-rynth",
  });
  const journal = new jn.AiJournal();

  // Extension layers (knowledge lookup, dungeon_suggest, safety guardPlan,
  // observation enrichment) compose through the director's injectable deps —
  // ai/extensions.js. Failure here degrades to the plain v1 director;
  // config.ai.extensions === false skips the import entirely.
  let ext = null;
  if (aiCfg?.extensions !== false) {
    try {
      const xm = await import(`${base}/ai/extensions.js`);
      ext = xm.composeAiExtensions(bot, { base, journal, config: aiCfg });
    } catch (e) {
      console.warn("[rynth] AI extensions unavailable, using v1 director:", e);
    }
  }

  const director = new dr.RynthAiDirector(bot, {
    client,
    journal,
    log: aiLog, // see aiLog above — failure paths only
    intervalMinutes: aiCfg?.intervalMinutes, // undefined -> director defaults
    minIntervalMinutes: aiCfg?.minIntervalMinutes,
    maxIntervalMinutes: aiCfg?.maxIntervalMinutes, // caps LLM-supplied next_check_minutes
    dryRun: aiCfg?.dryRun,
    maxCallsPerHour: aiCfg?.maxCallsPerHour, // undefined -> director defaults
    maxSpendPerHourUsd: aiCfg?.maxSpendPerHourUsd, // undefined -> director default ($1/hr)
    // Travel-hold (SPEC-navatlas §3-W3.2): scheduled check-ins are skipped
    // while a mission (goto/followRoute) is in flight — the route-completion
    // early check above carries the decision instead. config.ai.travelHold
    // === false turns it off; holdPollMinutes/maxHoldMinutes pass through.
    ...(aiCfg?.travelHold !== false
      ? {
          holdWhile: () => {
            try {
              return bot.mission
                ? `travelling: ${bot.mission.label}`
                : bot.globalRouter?.busy === true
                  ? "travelling"
                  : null;
            } catch { return null; }
          },
          ...(Number.isFinite(aiCfg?.holdPollMinutes) ? { holdPollMinutes: aiCfg.holdPollMinutes } : {}),
          ...(Number.isFinite(aiCfg?.maxHoldMinutes) ? { maxHoldMinutes: aiCfg.maxHoldMinutes } : {}),
        }
      : {}),
    ...(ext
      ? ext.directorDeps // observe/validate/execute/systemPrompt
      : typeof aiCfg?.systemPrompt === "string" && aiCfg.systemPrompt
        ? { systemPrompt: aiCfg.systemPrompt }
        : {}),
  });
  bot.ai = { director, client, journal, ...(ext ? { extensions: ext } : {}) };

  // Hourly metrics line (SPEC-navatlas §3-W3.5): distance / landblocks /
  // routes / kills / deaths / LLM spend into the journal. config.ai.metrics
  // === false turns it off; failure degrades to no metrics, never a throw.
  if (aiCfg?.metrics !== false) {
    try {
      const mm = await import(`${base}/ai/tools/metrics.js`);
      bot.ai.metrics = mm.createAiMetrics(bot, { journal });
    } catch (e) {
      console.warn("[rynth] AI metrics unavailable:", e);
    }
  }

  // Event-driven early check-ins (handoff-6 §3.4): significant push events
  // pull the next check-in forward instead of waiting out the minute cadence.
  // The director's own debounce + hourly budget bound the cost; a burst of
  // events collapses into one early check. config.ai.earlyCheckins === false
  // turns the wiring off.
  if (aiCfg?.earlyCheckins !== false && typeof bot.host?.onEvent === "function") {
    const KIND_CHAT = 2, KIND_DEATH = 29, KIND_PORTAL_SPACE = 33;
    const CAT_TELL = 2, CAT_POPUP = 10;
    bot.host.onEvent((e) => {
      try {
        let reason = null;
        if (e.kind === KIND_PORTAL_SPACE) reason = "entered portal space (teleporting)";
        // kind 29 fires for EVERY death broadcast; u32 = victim guid — only
        // the local player's own death warrants an early check.
        else if (e.kind === KIND_DEATH && (e.u32 >>> 0) === (bot.host.GetPlayerId() >>> 0)) reason = "you died";
        else if (e.kind === KIND_CHAT && (e.u32b >>> 0) === CAT_TELL && e.text) reason = "received a tell";
        else if (e.kind === KIND_CHAT && (e.u32b >>> 0) === CAT_POPUP && e.text) reason = "server popup message";
        if (reason) {
          // A significant event during a mission is an interrupt — the
          // mission observation line reports the count (§3-W3.3).
          if (bot.mission) bot.mission.interrupts = (bot.mission.interrupts ?? 0) + 1;
          director.requestEarlyCheck(reason);
        }
      } catch { /* an event-tap error must never reach the pump */ }
    });
  }

  if (typeof window !== "undefined") {
    let panel = null; // mount-once: the handle promise is cached; ui.js is imported only here
    const openPanel = () =>
      (panel ??= Promise.all([
        import(`${base}/ai/ui.js`),
        import(`${base}/ai/providers.js`).catch(() => null), // catalog optional — panel works without it
      ]).then(([ui, pv]) =>
        ui.mountAiPanel(director, {
          client: aiKeyOps(lc.LlmClient),
          models: pv ? pv.modelsFor(pv.DEFAULT_PROVIDER).map((m) => m.id) : undefined,
        })));
    window.rynthAI = {
      setKey: (key) => lc.LlmClient.saveKey(key),
      clearKey: () => lc.LlmClient.clearKey(),
      // start/stop carry a DURABLE operator intent (operator_stop.js): stop()
      // latches so the ?bot=1 reconnect reboot won't silently re-arm the
      // director; start() releases it. See operator_stop.js header.
      start: () => { os.clearOperatorStop(); return director.start(); },
      stop: () => { os.latchOperatorStop(); return director.stop(); },
      checkNow: () => director.checkNow(),
      status: () => director.status,
      journal,
      panel: () => openPanel(),
      // One-call honest clean-model wipe (ai/tools/memory.js): journal +
      // scratchpad (RAM+LS) + explore/combat RAM + _usedObjects; keeps the
      // OpenRouter key and nav atlas; WARNS (never clears) an operator-stop
      // latch. Replaces the hand-typed localStorage recipe in STREAM-RIG-OPS.
      wipeForCleanTest: () =>
        import(`${base}/ai/tools/memory.js`).then((m) => m.wipeForCleanTest(bot.ai)),
    };
    if (wantPanel) openPanel();
    // ?thoughtOverlay=1 (2026-07-18) — stream-facing teleprompter: reveals
    // each new journal `plan` entry at a reading pace budgeted to finish
    // before the next check-in (thought_overlay.js). Same failure contract
    // as the panel: broken overlay never takes down the client.
    try {
      if (new URLSearchParams(location.search).get("thoughtOverlay") === "1") {
        import(`${base}/ai/thought_overlay.js`)
          .then((m) => m.mountThoughtOverlay(journal, { intervalMinutes: director.intervalMinutes }))
          .catch((e) => console.warn("[rynthAI] thoughtOverlay mount failed:", e));
      }
    } catch { /* flag parse failure = no overlay */ }
  }

  if (aiCfg?.autoStart !== false) director.start();
}

// worldX / worldY are imported from nav_frame.js at the top of this module
// (C3 Stage-0 dedup) — the ONE copy of the world-frame math.

// Step 5 (hard-loop last resort) hop length — long enough to make real
// progress toward the nearest unvisited town's bearing, short of anything
// that could be mistaken for a teleport: this is ALWAYS one on-foot
// MoveToPosition call, never an @telepoi/portal shortcut (operator directive
// 2026-07-21: teleporting out of a loop defeats autonomous on-foot nav).
const TOWN_HOP_DIST_M = 45;

// Seen-portal ledger cap (change #2, 2026-07-21 training-academy wedge fix
// part 2): _escalatePortal's old NearbyGuids-only scan produces ZERO
// candidates the instant the one known portal drops out of range (live-
// observed: present earlier in the session, absent later) — a dungeon-sized
// number of portals easily fits in memory for a whole session, so remember
// every one ever seen rather than only "right now". LRU-capped (Map
// insertion order) for long-session hygiene, same convention as
// state._usedObjects (extensions.js) / _visitedDoors above.
const SEEN_PORTALS_MAX = 64;

// ── Frontier cruise (2026-07-23, movement-utilization fix) ─────────────────
// Live measurement (stream soak): the bot MOVES ~14% of a rolling minute —
// a pressure "frontier hop" is a single ~10 m MoveToPosition that finishes in
// ~2-3 s, then the 12 s idle + 15 s step gates hold everything until the next
// hop, and the director itself only lands every ~51-116 s (maxCallsPerHour
// spacing floor 3600/70 ≈ 51 s live). Operator direction: size the idle
// movement objective by DISTANCE = (time until the next director check-in) ×
// (walk speed), so one continuous walk bridges the whole director gap
// instead of finishing early and idling. The cruise is a bot.travel() route
// through em.frontierChain() waypoints — raw travel() is deliberately the
// LOWEST-priority mover (doGoto/doEgress cancel a raw WALK: "last command
// wins"), so a director plan takes the character back instantly.
const CRUISE_MAX_M = 220;          // sanity cap — never send the bot ~800 m into the void on one idle drive
const CRUISE_MIN_M = 25;           // below this a chained route buys nothing over the plain single hop
const CRUISE_MAX_LEG_M = 60;       // per-leg cap: keeps every leg well inside router.js's 30 s leg watchdog
const CRUISE_GAP_MIN_MS = 20_000;  // clamp for a mis-read/imminent next-check gap
const CRUISE_GAP_MAX_MS = 150_000; // clamp for a distant next-check (cap × speed also bounded by CRUISE_MAX_M)
// Ground speed = run_rate × 4.0 m/s (atlas.js RUN_SPEED_MS — the client's own
// RunForward anim speed; wasm stateGroundSpeed clamps to run_rate × 4.0).
const CRUISE_SPEED_FALLBACK_MPS = 4.0;
const CRUISE_SPEED_MAX_MPS = 18.0; // retail run-rate plateau (atlas.js derivation)
// Relaxed re-step gates while a cruise window is open (a cruise that lands
// early, or a fresh check-in that claimed no movement, chains the next drive
// in seconds instead of standing through the tuned 12 s/15 s idle gates).
const CRUISE_CHAIN_IDLE_MS = 3_000;
const CRUISE_CHAIN_STEP_MS = 5_000;
const POST_CHECKIN_FAST_MS = 20_000;

// ── Explore pressure (task #15, 2026-07-20; re-engineered as a frontier-
// directed escalation ladder 2026-07-21, DESIGN-surveyor-frontier) ────────
// ?explorePressure=1 (index.html bot-param block; exact-match "=1" opt-in,
// default OFF). Fixes: the bot has NO locomotion outside an explicit
// director tool call — the kernel loops (combat/loot/buff/vitals) only act
// on what's already nearby, and router.tick() only advances a route someone
// already started. Between check-ins (minutes apart) the bot is a statue.
//
// This adds an idle-pressure tick, self-throttled to ~5s off the host's
// heartbeat, that steps the bot with cheap ambient motion ONLY when nothing
// else has a legitimate claim on movement — see _gatesOpen() for the full
// AND of conditions. One compact journal note per step so the director's
// next observation sees the ambient motion. Hard caps: >=12s idle (since the
// last pose change) AND >=15s since the last pressure step, and <=6
// consecutive random/sweep hops before standing down until the next
// director check-in lands.
//
// Step priority (the escalation ladder, DESIGN-surveyor-frontier-2026-07-21
// WS-C + its VALIDATION COROLLARY):
//   1. Re-issue the director's last unreached goto (unchanged — bot.mission/
//      lastMission already carry this; doGoto sets them, no extra hook).
//   2. LOCAL FRONTIER HOP: step toward the nearest unvisited tile from the
//      shared `bot.ai.extensions.exploreMemory` — indoor via the cell graph
//      (nearestCell/toLegs toward the frontier tile), outdoor via a direct
//      MoveToPosition at the frontier's world coords (converted through the
//      same LandCell-index formula the old random-hop code used).
//   3. ESCALATE OUT when the local frontier is exhausted (no frontier inside
//      this landblock AND variation()>=5, OR loopVerdict().severity>=2 while
//      indoors): walk to the building exit via
//      `bot.ai.extensions.dungeonNav.exitRoute(bot)` + `bot.travel(legs)`
//      (the same code path the `exit_building` action uses), falling back to
//      a local `indoor_router.findExitPath` + direct MoveToPosition when
//      dungeonNav/bot.travel are unavailable.
//   4. LANDBLOCK HOP: when the frontier tile itself sits in a different
//      landblock (whole current lb saturated), the same outdoor frontier-hop
//      code carries the bot there directly — it is the same MoveToPosition-
//      toward-frontier action as step 2, just labeled differently in the
//      journal.
//   5. HARD-LOOP LAST RESORT (loopVerdict().severity===3 outdoors, no local
//      frontier left): a DIRECTED, ON-FOOT long walk toward the bearing of
//      the nearest unvisited town (`exploreMemory.townFrontier(TOWNS, pose)`
//      for direction only — NEVER a teleport/`@telepoi`; the operator has
//      explicitly ruled that out as it defeats autonomous on-foot
//      navigation). If wedged against geometry with nothing reachable, this
//      just keeps re-issuing the same directed MoveTo; the existing hop-cap
//      stand-down and the next director check-in are what actually un-stick
//      it.
//
// Every rung is best-effort and independently guarded: a missing/broken
// `exploreMemory` (extensions off, or WS-A not yet landed) makes every
// `_frontierSafe`/`_loopVerdictSafe`/`_variationSafe` helper return an inert
// default, which collapses the whole ladder back to the ORIGINAL pre-frontier
// behavior (revisit-nearest-neighbor indoors, nearest-unvisited-door-or-
// random-hop outdoors) via `_legacyIndoorSweep`/`_legacyOutdoorHop` — kept
// verbatim for exactly this fallback.
//
// Survival invariant (matches the rest of rynth/): every entry point
// degrades to a no-op on any error — a broken pressure step must never touch
// grind/router/director state it doesn't own.
export class ExplorePressureController {
  constructor(host, router, irMod, opsMod, opts = {}) {
    this.host = host;
    this.router = router;
    this.ir = irMod || {}; // indoor_router.js: isEnvCellId/nearestCell/toLegs/buildGraphFromWasm/findExitPath
    this._isOperatorStopLatched = typeof opsMod?.isOperatorStopLatched === "function"
      ? opsMod.isOperatorStopLatched
      : () => false;
    this.now = typeof opts.now === "function" ? opts.now : () => Date.now();
    this.log = typeof opts.log === "function" ? opts.log : () => {};
    this._towns = Array.isArray(opts.towns) ? opts.towns : []; // tools/towns.js TOWNS, for step 5's bearing only
    this.bot = null; // set by createGrindBot once the bot object exists

    this._lastGateAt = 0;           // 5s coarse-cadence throttle for the tick body
    this._lastPoseKey = null;
    this._lastMoveAt = this.now();
    this._lastStepAt = 0;
    this._consecutiveHops = 0;      // random/sweep hops since the last director check-in
    this._standDown = false;        // 3-hop cap tripped; cleared on the next check-in
    this._lastCheckSeen = null;
    this._stepBusy = false;         // step() reentrancy guard (it awaits)
    // Legacy revisit-memory — kept ONLY as the fallback used by
    // _legacyIndoorSweep/_legacyOutdoorHop when exploreMemory is absent or
    // broken (extensions off, or ExploreMemory not yet wired) — see WS-C.
    this._visitedCells = new Map(); // landblock -> Set(cellId) — indoor sweep memory
    this._visitedDoors = new Set(); // outdoor door guids already swept toward
    this._graphCache = null;        // { lb, graph } — indoor graph memo (buildGraphFromWasm)

    // Deterministic portal rung (2026-07-21, training-academy wedge fix):
    // _escalateOut only knows baked CellPortal architecture (dungeonNav /
    // indoor_router findExitPath) and correctly fails forever in a
    // portal-only dungeon (no CellPortal exists at all — the exit is a
    // portal WorldObject). _escalatePortal walks/uses the nearest
    // ODF_PORTAL-flagged object instead; guids that produce no pose change
    // within ~20s are blacklisted so a decorative dead-end portal (this
    // world DB has two: "Central Courtyard"/"Outer Courtyard") is not
    // retried forever.
    this._deadEscapeGuids = new Set(); // portal guids proven dead this session
    this._pendingEscapeGuid = null;    // guid we most recently walked to/used, awaiting pose movement

    // Seen-portal ledger (change #2, 2026-07-21 wedge fix part 2): guid ->
    // { name, wx, wy, z, cell, lastSeenT }, refreshed opportunistically from
    // NearbyGuids each _escalatePortal call so a portal that later drops out
    // of range (rooms away) is still a known, walkable candidate instead of
    // vanishing into "zero candidates forever". See _escalatePortal/
    // _rememberPortal below.
    this._seenPortals = new Map();

    // Movement-dead watchdog (2026-07-21 scope item 3): counts hop attempts
    // (_bumpHop) since the pose last actually changed (_trackMovement). A
    // client-side pose freeze despite repeated escalation attempts is NOT a
    // routing problem — no rung here can fix it — so this stands the
    // pressure controller down rather than hammering MoveToPosition forever.
    this._hopsSincePoseChange = 0;
    this._movementDead = false;

    // Frontier-cruise state (2026-07-23 movement-utilization fix; constants
    // above): _cruiseActive marks "the current raw-travel router walk is OUR
    // idle drive" — it yields to the director (tick()'s _yieldToDirector +
    // bot.js doFollowRoute's last-command-wins cancel) and relaxes the
    // re-step gates while its window (_cruiseUntil) is open so back-to-back
    // drives chain instead of idling 12-15 s between them.
    this._cruiseActive = false;
    this._cruiseUntil = 0;
    this._postCheckinFastUntil = 0;
  }

  // host.onTick driver (~10Hz by default); self-throttles to ~5s and never
  // awaits directly — the step runs fire-and-forget so a slow graph build
  // can't stall the host tick loop the way a blocking tick would.
  tick() {
    try {
      const now = this.now();
      this._trackMovement(now);
      // _yieldToDirector BEFORE _trackCheckIn: a fresh check-in both stamps
      // lastCheckAt (which _trackCheckIn uses to clear the cruise window)
      // AND holds isBusy() for its whole observe->LLM->execute span — the
      // yield must see _cruiseActive still set on the first tick of that
      // span, or the cruise walk would keep walking under the director's
      // plan instead of being cancelled.
      this._yieldToDirector();
      this._trackCheckIn();
      this._trackCruise(now);
      this._checkMovementDead(now);
      if (now - this._lastGateAt < 5000) return;
      this._lastGateAt = now;
      if (this._stepBusy || !this._gatesOpen(now)) return;
      this._stepBusy = true;
      void this._step(now)
        .catch((e) => this.log(`[explore-pressure] step error: ${(e && e.message) || e}`))
        .finally(() => { this._stepBusy = false; });
    } catch (e) {
      this.log(`[explore-pressure] tick error: ${(e && e.message) || e}`);
    }
  }

  _pose() {
    try { return this.host?.TryGetPlayerPose?.() ?? null; } catch { return null; }
  }

  _trackMovement(now) {
    const p = this._pose();
    if (!p || typeof p.objCellId !== "number") return;
    const key = `${p.objCellId >>> 0}|${p.x.toFixed(1)}|${p.y.toFixed(1)}|${p.z.toFixed(1)}`;
    if (this._lastPoseKey == null) { this._lastPoseKey = key; return; }
    if (key !== this._lastPoseKey) {
      this._lastPoseKey = key;
      this._lastMoveAt = now;
      // Real movement — natural recovery for both watchdogs. No reload
      // needed: a pose change is definitive proof the client is not frozen.
      this._hopsSincePoseChange = 0;
      this._movementDead = false;
    }
  }

  // Movement-dead watchdog (scope item 3): fires when hops keep being
  // attempted (_bumpHop) but the pose has not actually changed in a long
  // while — a client-side freeze, not a routing decision (no rung here,
  // including the new portal one, can walk a frozen client anywhere).
  // Unconditional every tick (not gated behind _gatesOpen) so it still
  // catches a freeze even while something else nominally owns movement.
  // Latched (not re-logged every tick) until _trackMovement's real pose
  // change clears it.
  _checkMovementDead(now) {
    if (this._movementDead) {
      // Already latched — keep _standDown enforced every tick (a fresh
      // director check-in's _trackCheckIn() releases the ORDINARY hop-cap
      // stand-down; this re-asserts ours on top so a still-frozen pose
      // can't slip a MoveToPosition through on the very next check-in).
      // _trackMovement's real pose change is the only thing that clears it.
      this._standDown = true;
      return;
    }
    if (this._hopsSincePoseChange >= 4 && now - this._lastMoveAt > 3 * 60_000) {
      this._movementDead = true;
      this._standDown = true;
      this._journalNote(
        `[pressure] MOVEMENT DEAD (pose frozen ~${Math.round((now - this._lastMoveAt) / 60_000)}min despite ${this._hopsSincePoseChange} move attempts) — standing down until it recovers`
      );
    }
  }

  // A fresh director check-in landing releases the random-hop stand-down.
  // director.lastCheckAt is a public accessor (director.js, SPEC §director),
  // still read defensively via optional chaining.
  _trackCheckIn() {
    try {
      const lastCheck = this.bot?.ai?.director?.lastCheckAt ?? null;
      if (lastCheck != null && lastCheck !== this._lastCheckSeen) {
        this._lastCheckSeen = lastCheck;
        this._consecutiveHops = 0;
        this._standDown = false;
        // Fresh director input supersedes any cruise window: the plan (not
        // our idle drive) owns what happens next. Also open the short
        // post-check-in fast-start window — if the plan claims no movement
        // (instant actions / "none"), the next cruise starts within seconds
        // instead of standing through the full 12 s/15 s gates. Every OTHER
        // gate (movementClaimed, director.isBusy, stand-down, operator stop)
        // still applies inside the window.
        this._cruiseActive = false;
        this._postCheckinFastUntil = this.now() + POST_CHECKIN_FAST_MS;
      }
    } catch { /* defensive read only; never blocks the tick */ }
  }

  // Cruise-window bookkeeping (movement-utilization fix). FAILED = the drive
  // hit something physical — drop the window so the retry waits out the
  // NORMAL tuned gates rather than grinding the wall at chain cadence.
  // IDLE = cancelled (a goto/egress/stop took the router) — no longer ours.
  _trackCruise(now) {
    if (!this._cruiseActive) return;
    const rs = this.router?.status?.state;
    if (rs === "FAILED" || rs === "IDLE") { this._cruiseActive = false; return; }
    if (now >= this._cruiseUntil && rs !== "WALK" && rs !== "PORTAL") this._cruiseActive = false;
  }

  /** Public: true while the router walk in flight is this controller's own
   *  idle cruise (raw bot.travel legs). bot.js's doFollowRoute consults this
   *  for last-command-wins: a director route may cancel a cruise walk the
   *  same way doGoto/doEgress already cancel a raw travel(). */
  cruising() {
    return this._cruiseActive === true;
  }

  // The instant a director check-in goes in-flight, hand the character back:
  // cancel our own cruise walk so the observation/plan executes from a
  // settling bot, never contends with an idle drive we started. Only OUR
  // walk is touched — a goto/followRoute/composeGoto walk is never ours
  // (_cruiseActive is only set on a successfully-issued raw travel).
  _yieldToDirector() {
    if (!this._cruiseActive) return;
    let busy = false;
    try { busy = this.bot?.ai?.director?.isBusy?.() === true; } catch { busy = false; }
    if (!busy) return;
    const rs = this.router?.status?.state;
    if (rs === "WALK" || rs === "PORTAL") {
      try { this.router.cancel(); } catch { /* cancel is best-effort; the director's own movers also cancel raw walks */ }
      this.log("[explore-pressure] cruise yielded to director check-in");
    }
    this._cruiseActive = false;
  }

  // All activation conditions (task #15 spec), ANDed; re-checked every ~5s
  // AND again right before any actual MoveToPosition/goto call so a step
  // aborts instantly if something else claims movement mid-step.
  _gatesOpen(now) {
    if (!this.bot) return false;
    const director = this.bot.ai?.director;
    if (!director || director.enabled !== true) return false; // manual bot: never fires
    try {
      if (this._isOperatorStopLatched()) return false;
    } catch { /* treat a broken latch read as "not latched" — matches operator_stop.js's own fail-open */ }
    if (this.bot.globalRouter?.busy) return false;
    const rs = this.router?.status?.state;
    if (rs !== "IDLE" && rs !== "DONE" && rs !== "FAILED") return false; // an active route owns movement
    // 05 C1 fix: the two checks above alone go both "free" during a
    // composeGoto INDOOR phase (globalRouter.busy false, router.state
    // "DONE") and during a live loot approach (kernel-driven, no router
    // involvement at all) — bot.movementClaimed() additionally sees
    // composeActive/followBusy/loot-approaching. Optional chaining: absent
    // on a plain test double (rynth_explore_pressure_test.cjs mocks), which
    // degrades to exactly the checks above (no behavior change for those).
    if (this.bot.movementClaimed?.()) return false;
    if (director.isBusy()) return false; // check-in in flight (director's public busy accessor)
    if (this._standDown) return false;
    // Movement-utilization fix: inside an open cruise-chain window (a sized
    // drive just landed with director-gap time left) or the short post-
    // check-in fast-start, re-step within seconds — a bot that just finished
    // covering ground on purpose shouldn't stand out the full tuned gates
    // before continuing. Everything ABOVE (claims, busy director, stand-down,
    // operator stop) still gates the relaxed path identically.
    const relaxed = this._gatesRelaxed(now);
    if (now - this._lastMoveAt < (relaxed ? CRUISE_CHAIN_IDLE_MS : 12_000)) return false; // tuned 25s->12s 2026-07-20 (stream felt statue-y)
    if (now - this._lastStepAt < (relaxed ? CRUISE_CHAIN_STEP_MS : 15_000)) return false; // tuned 25s->15s; still >= the 1-step/15s spirit of the cap
    return true;
  }

  // Relaxed-gate predicate (cruise chaining): true right after a director
  // check-in lands (fast-start window) or while a cruise window is open AND
  // its route has actually LANDED (state DONE — never FAILED, which
  // _trackCruise clears, so a wall-grind retries at the normal cadence).
  _gatesRelaxed(now) {
    if (now < this._postCheckinFastUntil) return true;
    if (this._cruiseActive && now < this._cruiseUntil) {
      return this.router?.status?.state === "DONE";
    }
    return false;
  }

  // Narrower than _gatesOpen(): only the "something else now owns movement"
  // signals — used for the abort-mid-step re-checks inside _indoorHop /
  // _outdoorHop (after an await, right before the actual MoveToPosition).
  // Deliberately excludes the idle-since-last-move/-step cooldowns: THIS
  // step already claimed that window (_step stamps _lastStepAt up front),
  // so re-running the full gate here would always self-block on its own
  // fresh timestamp. True while claimed/blocked (fail-safe: an unreadable
  // bot/director counts as claimed).
  _routeClaimed() {
    if (!this.bot) return true;
    const director = this.bot.ai?.director;
    if (!director || director.enabled !== true) return true;
    try {
      if (this._isOperatorStopLatched()) return true;
    } catch { /* matches _gatesOpen's fail-open read; not a claim by itself */ }
    if (this.bot.globalRouter?.busy) return true;
    const rs = this.router?.status?.state;
    if (rs !== "IDLE" && rs !== "DONE" && rs !== "FAILED") return true;
    // 05 C1 fix — see _gatesOpen's identical addition above.
    if (this.bot.movementClaimed?.()) return true;
    if (director.isBusy()) return true; // check-in in flight (director's public busy accessor)
    return false;
  }

  _journalNote(text) {
    try { this.bot?.ai?.journal?.add?.("note", text); } catch { /* journal loss is not fatal */ }
  }

  _bumpHop() {
    this._consecutiveHops++;
    if (this._consecutiveHops >= 6) this._standDown = true; // tuned 3->6 hops 2026-07-20
    this._hopsSincePoseChange++; // movement-dead watchdog (scope item 3) — reset only by a REAL pose change
  }

  async _step(now) {
    if (!this._gatesOpen(now)) return; // tick() already checked; defensive re-check
    this._lastStepAt = now;

    // Priority 1: the last director-initiated goto is known and unreached.
    // bot.mission/bot.lastMission already carry exactly this (doGoto sets
    // bot.mission on start, bot.lastMission = {..., result} on completion or
    // failure) — reusing that state avoids adding a second tracking hook
    // that would fight route_recorder's own bot._onTravelStart/_onTravelDone
    // wiring (rynth/ai/extensions.js). Re-issued via bot.goto, once per idle
    // period (the 15s-since-last-step gate above already enforces "once").
    const lm = this.bot.lastMission;
    if (lm && lm.kind === "goto" && lm.to != null && lm.result?.ok !== true && typeof this.bot.goto === "function") {
      this._journalNote(`[pressure] idle — re-issuing last unreached goto (${lm.label ?? "?"})`);
      void this.bot.goto(lm.to).catch(() => {});
      return; // director input, not a random/sweep hop — _consecutiveHops untouched
    }

    const pose = this._pose();
    if (!pose || typeof pose.objCellId !== "number") return;

    // Feed the shared coverage core on the SAME pressure-tick cadence the
    // director check-in also observes on — ExploreMemory owns the de-dupe
    // (DESIGN-surveyor-frontier corollary: "dual-driver double-count"), so a
    // plain best-effort call here is safe and keeps coverage/frontier fresh
    // between check-ins rather than only at check-in time.
    const em = this._exploreMemory();
    if (em) {
      try { em.observe(pose); } catch { /* ExploreMemory owns its own robustness */ }
    }

    if (typeof this.ir.isEnvCellId === "function" && this.ir.isEnvCellId(pose.objCellId >>> 0)) {
      await this._indoorHop(pose, em);
    } else {
      this._outdoorHop(pose, em);
    }
  }

  // Lazy/defensive reach into the shared coverage core — SAME pattern as
  // this.bot.ai?.director elsewhere in this file. Missing/broken -> null,
  // which collapses every ladder rung below back to the legacy fallback.
  _exploreMemory() {
    try {
      const em = this.bot?.ai?.extensions?.exploreMemory;
      if (em && typeof em.frontier === "function") return em;
    } catch { /* defensive read only */ }
    return null;
  }

  _frontierSafe(em) {
    if (!em) return null;
    try { return em.frontier() ?? null; } catch { return null; }
  }

  _loopVerdictSafe(em) {
    if (!em || typeof em.loopVerdict !== "function") return null;
    try { return em.loopVerdict() ?? null; } catch { return null; }
  }

  _variationSafe(em) {
    if (!em || typeof em.variation !== "function") return 0;
    try { const v = em.variation(); return typeof v === "number" ? v : 0; } catch { return 0; }
  }

  // Retail outdoor LandCell index (LandDefs::gid_to_lcoord) from a WORLD-
  // frame point — the same formula dungeon_nav.js's exitRoute() and
  // goto_compose.js's normalizeLegWorldFrame() each independently derive;
  // shared here by every hop kind (frontier/landblock/town/legacy) rather
  // than re-inlined per call site.
  _worldToLandCell(tx, ty, z) {
    return worldToOutdoorCell(tx, ty, z); // the ONE copy (nav_frame.js)
  }

  async _indoorHop(pose, em) {
    if (typeof this.ir.buildGraphFromWasm !== "function" || typeof this.ir.toLegs !== "function") return;
    const cellId = pose.objCellId >>> 0;
    // WP-9 nav shield: an EnvCell pose strictly BELOW the floor plane is
    // un-solved (z AT the plane is a correct faithful settle — see nav_guard.js) —
    // don't path FROM it; hold this tick and let the next tick re-solve. Gated
    // on this.ir.guardLeg so it no-ops for a test double / older indoor_router
    // (degrades to today's behavior). One journal line per hold episode.
    if (typeof this.ir.guardLeg === "function") {
      const v = this.ir.guardLeg({ cellId, z: pose.z }, { cellId, z: pose.z });
      if (v && v.ok === false && v.reason === "unsolved") {
        if (this._navHoldMsg !== v.message) {
          this._navHoldMsg = v.message;
          this._journalNote(`[pressure] ${v.message}`);
        }
        return;
      }
      this._navHoldMsg = null; // solved this tick — let the next hold re-log
    }
    const lb = (cellId >>> 16) >>> 0;
    let graph = this._graphCache && this._graphCache.lb === lb ? this._graphCache.graph : null;
    if (!graph) {
      const handle = this.host?.s;
      if (!handle) return; // no live wasm session (e.g. headless test double) — nothing safe to build from
      try {
        graph = await this.ir.buildGraphFromWasm(handle, 0, {});
      } catch { graph = null; }
      // The build awaited — re-validate before acting on it (a director
      // action or route may have started while we were waiting).
      if (this._routeClaimed()) return;
      if (!graph) return;
      this._graphCache = { lb, graph };
    }
    const nodes = graph instanceof Map ? graph : new Map(Object.entries(graph).map(([k, v]) => [Number(k) >>> 0, v]));
    if (!nodes.size) return;
    const wx = worldX(cellId, pose.x), wy = worldY(cellId, pose.y);
    const cur = (nodes.has(cellId) ? cellId : (this.ir.nearestCell?.(nodes, wx, wy, pose.z) ?? cellId)) >>> 0;

    // Step 3 gate: escalate OUT when the local frontier is exhausted
    // (nothing unvisited left inside THIS landblock and variation()>=5) OR
    // the loop verdict is already severity>=2 while indoors — escalating
    // takes priority over a same-building frontier hop once either fires,
    // since bouncing around one building is exactly the pattern severity>=2
    // detects.
    const frontier = this._frontierSafe(em);
    const verdict = this._loopVerdictSafe(em);
    const variation = this._variationSafe(em);
    const localFrontier = frontier && typeof frontier.worldX === "number" && typeof frontier.worldY === "number"
      && (frontier.lb == null || (frontier.lb >>> 0) === lb);
    const escalateCondition = (!localFrontier && variation >= 5) || (verdict && verdict.severity >= 2);

    if (escalateCondition) {
      const escalated = await this._escalateOut(cur, graph);
      if (this._routeClaimed()) return; // exitRoute() awaits — re-validate before any further rung
      if (escalated) return;
      // dungeonNav + the local findExitPath fallback both came up empty —
      // both only know baked CellPortal architecture, so this is the
      // EXPECTED (correct) failure in a portal-only dungeon (no CellPortal
      // exists at all — training-academy wedge root cause). Try walking to/
      // using an actual portal WorldObject before degrading further.
      if (this._escalatePortal(pose, graph, cur)) return;
    }

    if (localFrontier && this._frontierHopIndoor(pose, graph, nodes, cur, frontier)) return;

    // Step 1 (legacy revisit-neighbor sweep): the extensions-off / broken-
    // ExploreMemory fallback, and the final rung when a frontier exists but
    // sits outside this landblock and escalation couldn't act on it yet.
    this._legacyIndoorSweep(graph, nodes, cur, lb);
  }

  // Step 3: exit_building's own code path, invoked as harness code — mirrors
  // the `exit_building` director action exactly (dungeonNav.exitRoute +
  // bot.travel, NOT bot.goto). Falls back to a local findExitPath + direct
  // MoveToPosition toward the exit cell when dungeonNav/bot.travel aren't
  // available (extensions off, or the advisor declined). Returns true if a
  // move was actually issued.
  async _escalateOut(cur, graph) {
    try {
      const dn = this.bot?.ai?.extensions?.dungeonNav;
      if (dn && typeof dn.exitRoute === "function" && typeof this.bot.travel === "function") {
        const route = await dn.exitRoute(this.bot);
        if (this._routeClaimed()) return true; // claimed mid-await — treat as handled this tick
        if (route && route.ok && Array.isArray(route.legs) && route.legs.length) {
          const res = this.bot.travel(route.legs);
          if (!res || res.ok !== false) {
            this._bumpHop();
            this._journalNote(`[pressure] idle — ESCALATE: exiting the building (dungeonNav, ${route.legs.length} leg(s))`);
            return true;
          }
        }
      }
    } catch { /* fall through to the local fallback below */ }

    try {
      if (typeof this.ir.findExitPath === "function" && typeof this.ir.toLegs === "function") {
        const exit = this.ir.findExitPath(graph, cur, {});
        if (exit && Array.isArray(exit.path) && exit.path.length) {
          let legs = null;
          try { legs = this.ir.toLegs(graph, exit.path); } catch { legs = null; }
          const leg = Array.isArray(legs) ? legs[legs.length - 1] : null;
          if (leg) {
            if (this._routeClaimed()) return true;
            this.host.MoveToPosition(leg.lb, leg.x, leg.y, leg.z, true);
            this._bumpHop();
            this._journalNote(`[pressure] idle — ESCALATE: heading to building exit 0x${(exit.exitCell >>> 0).toString(16).padStart(8, "0")}`);
            return true;
          }
        }
      }
    } catch { /* both escalation paths exhausted — caller degrades further */ }
    return false;
  }

  // Real graph-planned indoor walk (2026-07-21, training-academy wedge fix
  // part 1 — root cause confirmed by reading every 2-node toLegs call site:
  // cur and the target cell were NEVER actually checked for portal adjacency
  // before this fix — toLegs just stamps whatever ids it's handed as
  // consecutive legs, so a naive toLegs(graph, [cur, target]) with a
  // non-adjacent target silently produced a SINGLE straight-line
  // MoveToPosition through whatever wall/doorframe happened to sit between
  // the two rooms; 92 identical "frontier hop" attempts in the 30-min watch
  // were exactly this). BFS/A* the REAL path via indoor_router.js's
  // findPath (portal-adjacency + drop-edge aware — already used correctly by
  // rynth/ai/tools/world.js's approach()/indoorLegsTo, the source of the
  // occasional "walk:routed(4)" successes the researcher noted) and, when it
  // crosses more than one hop, walk it leg-by-leg via bot.travel(legs) — the
  // SAME multi-leg executor _escalateOut already uses for
  // dungeonNav.exitRoute (router.follow under the hood). A genuine
  // single-hop path (2 cells, already portal-adjacent) still issues one
  // MoveToPosition, identical to the pre-existing behavior for an adjacent
  // pair — no regression there.
  //
  // Returns true if this tick is "handled" (a move was issued, OR something
  // else already claimed movement mid-plan) — false ONLY when no real path
  // could be planned (unreachable, or findPath/toLegs unavailable e.g. a test
  // double), so the caller degrades to its own PRE-EXISTING fallback (task
  // directive: "if BFS finds no path, keep current fallback behavior").
  _walkGraphPath(graph, fromCell, toCell, note) {
    if (typeof this.ir.findPath !== "function" || typeof this.ir.toLegs !== "function") return false;
    if (fromCell === toCell) return false; // nothing to route — caller decides
    let path = null;
    try { path = this.ir.findPath(graph, fromCell, toCell, {}); } catch { path = null; }
    if (!Array.isArray(path) || path.length < 2) return false; // unreachable — caller degrades (no straight-line)
    // Doorway pre-approach (WP-10, C1 P2): route through toLegs' doorwayApproach
    // — for each cell transition it emits a 30% line-up waypoint + a 50%
    // through-point before the destination centre (DungeonPathfinder.
    // AddPortalWaypoints), so the walker lines up on the doorway axis instead
    // of cutting the corner into an offset doorframe (the live academy /
    // Town-Network wedge). Even a single portal-adjacent hop now yields >=3
    // legs, so EVERY real indoor route walks the multi-leg executor below
    // rather than a lone corner-cutting MoveToPosition.
    let legs = null;
    try { legs = this.ir.toLegs(graph, path, { doorwayApproach: true }); } catch { legs = null; }
    if (!Array.isArray(legs) || !legs.length) return false;
    // Indoor-leg frame fix (2026-07-24, Town Network no-walk wedge): issue
    // legs in the normalized world frame (nav_frame.js — the goto_compose.js
    // convention, live-proven in this dungeon). Raw EnvCell frames can carry
    // cell-local coords outside [0,192) (Town Network y ≈ −70), the
    // documented MoveToPosition "cell re-derivation garbage" class.
    try { legs = legs.map(normalizeLegWorldFrame); } catch { /* keep raw legs */ }
    if (this._routeClaimed()) return true; // claimed mid-plan -> handled, no further rung
    if (legs.length > 1) {
      // Recovery-capable executor (WP-10, D5+D1): bot.followRoute
      // (doFollowRoute) reuses replayRoute's indoor recovery — touch-assist on
      // a jammed doorway + one bounded indoor-wedge re-path + probeFailedLeg
      // blocked-fact journaling — none of which the raw bot.travel (a bare
      // router.follow) does. Fired fire-and-forget (the ~15s pressure cadence
      // can't await a long walk loop — the same `void this.bot.goto(...)`
      // pattern _step uses for the re-issued goto); the next tick sees the
      // router busy and holds. Falls back to bot.travel only when followRoute
      // is absent (older bot / a test double).
      if (typeof this.bot?.followRoute === "function") {
        void this.bot.followRoute(legs).catch(() => {});
        this._bumpHop();
        this._journalNote(note(legs.length, true));
        return true;
      }
      if (typeof this.bot?.travel === "function") {
        const res = this.bot.travel(legs);
        if (res && res.ok === false) return false; // refused (goto active elsewhere) — caller degrades
        this._bumpHop();
        this._journalNote(note(legs.length, true));
        return true;
      }
      return false; // no executor available — caller degrades
    }
    const leg = legs[legs.length - 1];
    if (!leg) return false;
    this.host.MoveToPosition(leg.lb, leg.x, leg.y, leg.z, true);
    this._bumpHop();
    this._journalNote(note(legs.length, false));
    return true;
  }

  // Deterministic portal rung (2026-07-21, training-academy wedge fix):
  // _escalateOut only ever knows baked CellPortal architecture (dungeonNav /
  // findExitPath) and correctly comes up empty in a portal-only dungeon —
  // there is no CellPortal there at all, the exit is a portal WorldObject
  // (ODF_PORTAL, 0x40000 — observe_ext.js:248/goto_compose.js:102). This
  // walks to, then uses, the nearest live one instead. Not every portal in a
  // dungeon leads anywhere (this world DB has decorative dead ends), so a
  // guid that produced no pose movement in ~20s is blacklisted and the
  // next-nearest candidate is tried. No InvokeChatParser/teleport, no
  // give-item flow (the director owns that) — a plain walk/use, same as
  // every other rung in this ladder. Returns true if it claimed this
  // tick (walked toward, used, or is still waiting on, a portal).
  //
  // graph/cur (2026-07-21, part 2 — seen-portal ledger): passed in from
  // _indoorHop's already-built/cached graph so a remembered candidate can be
  // routed via the SAME real cell-graph pathing as change #1, instead of the
  // old world-frame-only worldToLandCell walk (which only ever worked by
  // coincidence when the portal happened to be reachable in a straight
  // line). Degrades to that old direct walk when the candidate's cell isn't
  // in the (possibly absent/synthetic) graph.
  _escalatePortal(pose, graph, cur) {
    const h = this.host;
    if (typeof h?.NearbyGuids !== "function" || typeof h?.TryGetObjectDescFlags !== "function"
        || typeof h?.TryGetObjectPosition !== "function" || typeof h?.UseObject !== "function") {
      return false;
    }
    const ODF_PORTAL = 0x40000; // ObjectDescriptionFlag.Portal
    const cellId = pose.objCellId >>> 0;
    const wx = worldX(cellId, pose.x), wy = worldY(cellId, pose.y);

    // A prior cycle's escalation that still hasn't moved the pose after
    // ~20s (reusing _trackMovement's own _lastMoveAt telemetry) is a dead
    // end — blacklist it and fall through to pick the next-nearest
    // candidate THIS call rather than idling another cycle on a corpse.
    if (this._pendingEscapeGuid != null) {
      const stalled = this.now() - this._lastMoveAt > 20_000;
      if (stalled) {
        const deadGuid = this._pendingEscapeGuid;
        const deadName = h.TryGetObjectName?.(deadGuid) || "?";
        this._deadEscapeGuids.add(deadGuid);
        this._pendingEscapeGuid = null;
        this._journalNote(`[pressure] portal "${deadName}" appears dead — blacklisting, trying next`);
      } else {
        // Still inside the grace window — claim the tick (nothing new to
        // do while we wait to see if it lands) rather than falling through
        // to the legacy sweep underneath us.
        return true;
      }
    }

    // Opportunistic ledger refresh (change #2): merge every CURRENTLY nearby
    // ODF_PORTAL object into _seenPortals. Root cause this fixes: the old
    // scan only ever looked at THIS tick's NearbyGuids, so a portal that
    // later sat rooms away (live-observed: present earlier in the session,
    // absent later) produced zero candidates forever, even though its
    // position had already been read once and was still perfectly walkable.
    let guids = [];
    try { guids = h.NearbyGuids() || []; } catch { guids = []; }
    const nowT = this.now();
    for (const g of guids) {
      try {
        const guid = g >>> 0;
        const flags = h.TryGetObjectDescFlags(guid);
        if (flags == null || !(flags & ODF_PORTAL)) continue;
        const p = h.TryGetObjectPosition(guid);
        if (!p) continue; // skip objects with no position — nothing to remember/walk toward
        const pwx = worldX(p.objCellId >>> 0, p.x), pwy = worldY(p.objCellId >>> 0, p.y);
        this._rememberPortal(guid, h.TryGetObjectName?.(guid) || "portal", pwx, pwy, p.z, p.objCellId >>> 0, nowT);
      } catch { /* one bad object must not break the scan */ }
    }

    // Candidates = the WHOLE ledger (currently-nearby ones were just merged
    // into it above, so this alone already unions "nearby now" + "remembered
    // from earlier") — nearest first, excluding blacklisted guids AND guids
    // proven generally ineffective (change #3's noEffect memory; kept a
    // DISTINCT set from _deadEscapeGuids — "dead escape" specifically means
    // "no movement during an escape attempt", noEffect is content-agnostic
    // and covers ANY use_object, including the director's own).
    let best = null;
    for (const [guid, rec] of this._seenPortals) {
      if (this._deadEscapeGuids.has(guid)) continue;
      if (this._noEffectOf(guid) >= 2) continue;
      const d = Math.hypot(rec.wx - wx, rec.wy - wy);
      if (!best || d < best.d) best = { guid, name: rec.name, wx: rec.wx, wy: rec.wy, cell: rec.cell, d };
    }
    if (!best) return false; // no known portal (nearby or remembered) — caller degrades further

    if (!this._routeClaimed()) {
      if (best.d > 5) {
        const label = (hops, multi) =>
          `[pressure] idle — ESCALATE: walking to portal "${best.name}" (~${Math.round(best.d)}m)${multi ? ` via ${hops}-leg route` : ""}`;
        // Real cell-graph path when the candidate's cell is known and in the
        // (already-built/cached) graph — change #1's mechanism, reused here
        // rather than the old world-frame-only straight walk. Degrades to
        // that straight walk when the graph doesn't cover it (different
        // landblock, graph unavailable, or no path).
        let moved = false;
        if (graph && best.cell != null) moved = this._walkGraphPath(graph, cur, best.cell >>> 0, label);
        if (!moved) {
          const target = this._worldToLandCell(best.wx, best.wy, pose.z);
          this.host.MoveToPosition(target.lb, target.x, target.y, target.z, true);
          this._bumpHop();
          this._journalNote(label(1, false));
        }
        this._pendingEscapeGuid = best.guid;
      } else {
        this.host.UseObject(best.guid);
        this._pendingEscapeGuid = best.guid;
        this._bumpHop();
        this._journalNote(`[pressure] idle — ESCALATE: using portal "${best.name}"`);
        // Interaction-outcome memory (change #3): record so a decorative
        // dead-end portal that never blacklists via the pose-stall check
        // above (e.g. it DOES move the pose a little, just not anywhere
        // useful) still eventually reads as "no observable change" if
        // nothing else about the world moves either.
        try { this.bot?.ai?.extensions?.interactions?.record?.(this.bot, best.guid, best.name); } catch { /* record loss is not fatal */ }
      }
    }
    return true; // claimed -> handled (no further rung this tick), even if claimed mid-scan
  }

  // Ledger upsert (change #2): LRU via Map insertion order — re-seeing a
  // guid bumps it to the back before the cap check, same convention as
  // extensions.js's state._usedObjects / this._visitedDoors above.
  _rememberPortal(guid, name, wx, wy, z, cell, lastSeenT) {
    const g = guid >>> 0;
    this._seenPortals.delete(g);
    this._seenPortals.set(g, { name, wx, wy, z, cell, lastSeenT });
    if (this._seenPortals.size > SEEN_PORTALS_MAX) {
      this._seenPortals.delete(this._seenPortals.keys().next().value);
    }
  }

  // Lazy/defensive reach into the shared interaction-outcome memory (change
  // #3) — same pattern as _exploreMemory()/dungeonNav elsewhere in this
  // file. Owned by extensions.js (rynth/ai/extensions.js), not here: it must
  // see BOTH UseObject call sites (this controller's own _escalatePortal
  // AND the director's use_object action, tools/world.js), and extensions.js
  // is the one module both already reach through this same
  // bot.ai.extensions.* seam (exploreMemory, dungeonNav). Missing/broken ->
  // 0, which never blocks a candidate (fail-open, matches the rest of the
  // ladder's survival invariant).
  _noEffectOf(guid) {
    try { return this.bot?.ai?.extensions?.interactions?.noEffectOf?.(guid >>> 0) ?? 0; } catch { return 0; }
  }

  // Step 2 (indoor half): step toward the graph cell nearest the frontier's
  // world coordinates. Returns true if a move was issued.
  _frontierHopIndoor(pose, graph, nodes, cur, frontier) {
    try {
      const targetRaw = this.ir.nearestCell?.(nodes, frontier.worldX, frontier.worldY, pose.z);
      if (targetRaw == null) return false;
      const target = targetRaw >>> 0;
      if (!nodes.has(target)) return false;
      const label = (hops, multi) =>
        `[pressure] idle — frontier hop to 0x${target.toString(16).padStart(8, "0")} (~${Math.round(frontier.dist ?? 0)}m, ${Math.round(frontier.bearingDeg ?? 0)}°)${multi ? ` via ${hops}-leg route` : ""}`;
      // Real cell-graph path ONLY (WP-10, C1 P1 — kill the non-adjacency
      // straight-line hop): cur and the frontier's nearest cell are NOT
      // portal-adjacent in general, so the old toLegs(graph,[cur,target])
      // fallback stamped a single MoveToPosition straight THROUGH the
      // intervening walls/doorframes whenever findPath came up empty — the
      // 92-identical-hop academy wedge. When the planner IS present and finds
      // no path, degrade to "no reachable frontier here" (return false) and let
      // _indoorHop fall through to the legacy neighbor sweep / the next tick's
      // escalation, never a wall-crossing hop.
      if (this._walkGraphPath(graph, cur, target, label)) return true;
      if (typeof this.ir.findPath === "function") return false; // planner present + no path -> degrade
      // findPath-less ir (an older indoor_router / a test double that can't
      // plan): keep the pre-existing single direct hop so navigation still
      // degrades to today's behavior rather than freezing.
      let legs = null;
      try { legs = this.ir.toLegs(graph, [cur, target]); } catch { legs = null; }
      const leg = Array.isArray(legs) ? legs[legs.length - 1] : null;
      if (!leg) return false;
      if (this._routeClaimed()) return true; // claimed -> handled (no further rung this tick)
      this.host.MoveToPosition(leg.lb, leg.x, leg.y, leg.z, true);
      this._bumpHop();
      this._journalNote(label(1, false));
      return true;
    } catch { return false; }
  }

  // Legacy indoor sweep (task #15 original behavior): revisit-nearest-
  // neighbor. Used when ExploreMemory is absent/broken, or as the last rung
  // when a frontier exists outside this landblock but escalation couldn't
  // act on it. `target` is always a direct graph neighbor of `cur` by
  // construction, so this was never actually exposed to the non-adjacency
  // bug (BFS trivially returns the same single hop) — routed through
  // _walkGraphPath anyway for uniformity with the other rungs (task
  // directive) and as defense-in-depth against a stale/pruned neighbor edge.
  _legacyIndoorSweep(graph, nodes, cur, lb) {
    const visited = this._visitedCells.get(lb) ?? new Set();
    this._visitedCells.set(lb, visited);
    visited.add(cur);
    const curNode = nodes.get(cur);
    const neighbors = (curNode?.neighbors || []).map((n) => Number(n) >>> 0).filter((id) => nodes.has(id));
    if (!neighbors.length) return;
    const target = neighbors.find((id) => !visited.has(id)) ?? neighbors[0]; // all seen -> revisit nearest neighbor
    // Mark the TARGET visited at attempt time, not on arrival — a hop that
    // never lands (blocked stair, refused MoveToPosition) otherwise re-picks
    // the same cell every tick forever (live 2026-07-20: four consecutive
    // sweeps to 0xa9b4015f). Failed hops now advance through the neighbor
    // list; the ?? revisit arm plus the hop-cap stand-down bound the worst
    // case when every neighbor is unreachable.
    visited.add(target);
    const label = (hops, multi) =>
      `[pressure] idle — indoor sweep to 0x${target.toString(16).padStart(8, "0")}${visited.has(target) ? " (revisit)" : ""}${multi ? ` via ${hops}-leg route` : ""}`;
    // Direct graph neighbor -> _walkGraphPath returns a real 2-cell route with
    // doorway pre-approach. WP-10 (C1 P1): no straight-line fallback when the
    // planner is present but can't plan it (stale/pruned edge, unreachable) —
    // this rung no-ops rather than firing a MoveToPosition straight through a
    // wall; the target is already marked visited so the next tick advances to
    // the next neighbor, and the hop-cap/escalation ladder bounds the rest.
    if (this._walkGraphPath(graph, cur, target, label)) return;
    if (typeof this.ir.findPath === "function") return; // planner present + no path -> no-op (degrade)
    // findPath-less ir (older indoor_router / test double): keep the
    // pre-existing single direct hop so the sweep still degrades to today's
    // behavior rather than freezing.
    let legs = null;
    try { legs = this.ir.toLegs(graph, [cur, target]); } catch { legs = null; }
    const leg = Array.isArray(legs) ? legs[legs.length - 1] : null;
    if (!leg) return;
    if (this._routeClaimed()) return; // final abort check right before moving
    this.host.MoveToPosition(leg.lb, leg.x, leg.y, leg.z, true);
    this._bumpHop();
    this._journalNote(label(1, false));
  }

  _outdoorHop(pose, em) {
    const cellId = pose.objCellId >>> 0;
    const wx = worldX(cellId, pose.x), wy = worldY(cellId, pose.y);
    const lb = cellId >>> 16;

    // Steps 2 & 4 share one code path outdoors: MoveToPosition straight at
    // the frontier's world coordinates. Whether that lands inside this
    // landblock (step 2, "frontier hop") or a different one (step 4,
    // "landblock hop") only changes the journal label — both are "walk
    // toward the nearest unvisited tile."
    const frontier = this._frontierSafe(em);
    if (frontier && typeof frontier.worldX === "number" && typeof frontier.worldY === "number") {
      // Movement-utilization fix: prefer a DISTANCE-SIZED cruise (a multi-leg
      // bot.travel route through chained frontier tiles, sized to cover the
      // remaining director gap at the live ground speed) over the single
      // ~10 m hop — the hop finished in seconds and left the bot standing
      // for the rest of the gap (live-measured ~14% moving). Falls through
      // to the unchanged single hop whenever the cruise can't run (older
      // exploreMemory, no travel executor, refused route, tiny budget).
      if (this._frontierCruise(pose, wx, wy, em, frontier)) return;
      if (this._frontierHopOutdoor(pose, wx, wy, lb, frontier)) return;
    }

    // Step 5: hard-loop last resort. NEVER a teleport — a directed, on-foot
    // long hop toward the bearing of the nearest unvisited town. Only fires
    // at severity 3 (wedged) with no local frontier to chase; if this keeps
    // firing because we're genuinely wedged against geometry, the hop-cap
    // stand-down and the next director check-in are what actually break it.
    const verdict = this._loopVerdictSafe(em);
    if (verdict && verdict.severity >= 3) {
      if (this._townDirectedHop(pose, wx, wy, em)) return;
    }

    this._legacyOutdoorHop(pose, wx, wy);
  }

  // ── Frontier cruise (movement-utilization fix, 2026-07-23) ───────────────
  // Remaining ms until the next director check-in can actually land. Uses the
  // director's public status (nextCheckAt/lastCheckAt) and takes the LATER of
  // the scheduled fire and the maxCallsPerHour spacing floor (09 C3:
  // _schedule may aim sooner than the floor allows; the floor skip then
  // re-schedules — the real gap is the floor). Defensive: any unreadable
  // field degrades to intervalMinutes, then to the clamp minimum.
  _directorGapMs(now) {
    try {
      const d = this.bot?.ai?.director;
      if (!d) return CRUISE_GAP_MIN_MS;
      let remain = null;
      let st = null;
      try { st = d.status ?? null; } catch { st = null; }
      const next = Number(st?.nextCheckAt);
      if (Number.isFinite(next)) remain = next - now;
      const mcph = Number(d.maxCallsPerHour);
      const last = Number(st?.lastCheckAt);
      if (mcph > 0 && Number.isFinite(last)) {
        const floorRemain = last + 3_600_000 / mcph - now;
        if (remain == null || floorRemain > remain) remain = floorRemain;
      }
      if (remain == null || !Number.isFinite(remain)) {
        const im = Number(d.intervalMinutes);
        remain = Number.isFinite(im) && im > 0 ? im * 60_000 : CRUISE_GAP_MIN_MS;
      }
      return Math.max(0, remain);
    } catch { return CRUISE_GAP_MIN_MS; }
  }

  // Live ground speed (m/s) = run_rate × 4.0 — atlas.js's RUN_SPEED_MS
  // derivation (wasm stateGroundSpeed clamps anim speed to run_rate × 4.0);
  // run_rate from the session's playerRunRate getter, same read as
  // ai/tools/routes.js liveRunRate. Falls back to the un-buffed base.
  _walkSpeedMps() {
    try {
      const s = this.host?.s;
      const r = s?.playerRunRate?.() ?? s?.player_run_rate?.();
      if (Number.isFinite(r) && r > 0) {
        return Math.min(CRUISE_SPEED_MAX_MPS, Math.max(1, r * 4.0));
      }
    } catch { /* fall through to the base speed */ }
    return CRUISE_SPEED_FALLBACK_MPS;
  }

  // The sized idle drive: distance budget = clamp(director-gap) × speed
  // (capped at CRUISE_MAX_M), spent on em.frontierChain()'s chained
  // unvisited-tile waypoints and walked as ONE raw bot.travel route — the
  // designated last-command-wins loser (doGoto/doEgress cancel a raw WALK;
  // doFollowRoute + tick()'s _yieldToDirector cancel it for a director route/
  // check-in), so this can never fight a real plan. Long segments (a far
  // first frontier) are subdivided so every router leg stays well inside the
  // 30 s leg watchdog. Returns true when a cruise was issued (or movement
  // was claimed mid-plan); false lets the caller fall through to the
  // pre-existing single frontier hop.
  _frontierCruise(pose, wx, wy, em, frontier) {
    if (!em || typeof em.frontierChain !== "function") return false;
    if (typeof this.bot?.travel !== "function") return false;
    const now = this.now();
    const gapMs = Math.min(CRUISE_GAP_MAX_MS, Math.max(CRUISE_GAP_MIN_MS, this._directorGapMs(now)));
    const speed = this._walkSpeedMps();
    const budgetM = Math.min(CRUISE_MAX_M, (gapMs / 1000) * speed);
    if (budgetM < CRUISE_MIN_M) return false;
    let chain = null;
    try { chain = em.frontierChain({ budgetM, maxLegM: CRUISE_MAX_LEG_M }); } catch { chain = null; }
    const wps = chain && Array.isArray(chain.waypoints) ? chain.waypoints : null;
    // A 1-waypoint "chain" is just the plain frontier hop — let the
    // pre-existing single-hop rung own that case unchanged.
    if (!wps || wps.length < 2) return false;
    const legs = [];
    let px = wx, py = wy;
    for (const w of wps) {
      if (typeof w?.worldX !== "number" || typeof w?.worldY !== "number") return false;
      const d = Math.hypot(w.worldX - px, w.worldY - py);
      const nSub = Math.max(1, Math.ceil(d / CRUISE_MAX_LEG_M));
      for (let i = 1; i <= nSub; i++) {
        const fx = px + ((w.worldX - px) * i) / nSub;
        const fy = py + ((w.worldY - py) * i) / nSub;
        legs.push(this._worldToLandCell(fx, fy, pose.z));
      }
      px = w.worldX;
      py = w.worldY;
    }
    if (legs.length < 2) return false;
    if (this._routeClaimed()) return true; // claimed mid-plan -> handled, no further rung
    const res = this.bot.travel(legs);
    if (!res || res.ok !== true) return false; // refused (mover already active) — caller degrades
    this._cruiseActive = true;
    this._cruiseUntil = now + gapMs;
    this._bumpHop();
    this._journalNote(
      `[pressure] idle — frontier cruise ~${Math.round(chain.totalM)}m / ${legs.length} legs toward ${Math.round(frontier.bearingDeg ?? 0)}° (sized for ~${Math.round(gapMs / 1000)}s director gap @ ${speed.toFixed(1)} m/s)`
    );
    return true;
  }

  // Steps 2/4 (outdoor half): direct MoveToPosition at the frontier's world
  // coordinates, converted through the shared LandCell formula. Returns true
  // if a move was issued.
  _frontierHopOutdoor(pose, wx, wy, lb, frontier) {
    const target = this._worldToLandCell(frontier.worldX, frontier.worldY, pose.z);
    if (this._routeClaimed()) return true; // claimed -> handled (no further rung this tick)
    this.host.MoveToPosition(target.lb, target.x, target.y, target.z, true);
    this._bumpHop();
    const crossesLb = (target.lb >>> 16) !== (lb >>> 0);
    const label = crossesLb ? "landblock hop" : "frontier hop";
    const dist = typeof frontier.dist === "number" ? frontier.dist : Math.hypot(frontier.worldX - wx, frontier.worldY - wy);
    this._journalNote(`[pressure] idle — ${label} toward 0x${target.lb.toString(16).padStart(8, "0")} (~${Math.round(dist)}m, ${Math.round(frontier.bearingDeg ?? 0)}°)`);
    return true;
  }

  // Step 5: ON-FOOT ONLY. Computes a bearing from the current position to
  // the nearest unvisited town (exploreMemory.townFrontier — used strictly
  // for direction, never as a teleport target) and issues one long walking
  // hop along that bearing. Town world coords are the inverse of the
  // ns/ew<-worldXY conversion ExploreMemory itself carries (DESIGN-surveyor-
  // frontier corollary's locDegrees): ns=(wy/24-1019.5)/10, ew=(wx/24-1019.5)/10.
  // Returns true if a move was issued.
  _townDirectedHop(pose, wx, wy, em) {
    if (!em || typeof em.townFrontier !== "function") return false;
    let town = null;
    try { town = em.townFrontier(this._towns, pose); } catch { town = null; }
    if (!town || typeof town.ns !== "number" || typeof town.ew !== "number") return false;
    const townWx = (town.ew * 10 + 1019.5) * 24;
    const townWy = (town.ns * 10 + 1019.5) * 24;
    const dx = townWx - wx, dy = townWy - wy;
    const dist = Math.hypot(dx, dy);
    if (!(dist > 1)) return false; // already at/on the town — nothing directional to walk
    const ux = dx / dist, uy = dy / dist;
    const target = this._worldToLandCell(wx + ux * TOWN_HOP_DIST_M, wy + uy * TOWN_HOP_DIST_M, pose.z);
    if (this._routeClaimed()) return true; // claimed -> handled (no further rung this tick)
    this.host.MoveToPosition(target.lb, target.x, target.y, target.z, true);
    this._bumpHop();
    this._journalNote(`[pressure] idle — ESCALATE: hard loop (severity 3), no local frontier — long walk toward ${town.name} (~${TOWN_HOP_DIST_M}m on foot, ON FOOT ONLY)`);
    return true;
  }

  // Legacy outdoor hop (task #15 original behavior, UNCHANGED): nearest
  // unvisited door, else a random 15-25m bearing hop. Used when ExploreMemory
  // is absent/broken or offers no frontier and the loop isn't yet severe.
  _legacyOutdoorHop(pose, wx, wy) {
    const door = this._nearestUnvisitedDoor(wx, wy);
    let tx, ty, label;
    if (door) {
      tx = door.wx; ty = door.wy;
      label = `door "${door.name}" (0x${door.guid.toString(16)})`;
      this._visitedDoors.add(door.guid);
      if (this._visitedDoors.size > 200) this._visitedDoors.clear(); // long-session hygiene, not a correctness need
    } else {
      const bearing = Math.random() * Math.PI * 2;
      const dist = 15 + Math.random() * 10; // 15-25m
      tx = wx + Math.sin(bearing) * dist;
      ty = wy + Math.cos(bearing) * dist;
      label = `random hop ~${dist.toFixed(0)}m`;
    }
    const target = this._worldToLandCell(tx, ty, pose.z);
    if (this._routeClaimed()) return; // final abort check right before moving
    this.host.MoveToPosition(target.lb, target.x, target.y, target.z, true);
    this._bumpHop();
    this._journalNote(`[pressure] idle — ${label}`);
  }

  // Small LOCAL reimplementation of world.js's closed-door check
  // (rynth/ai/tools/world.js:216-242 nearestClosedDoor) — deliberately not
  // imported (world.js is owned by another wave this pass; also this needs a
  // different query — any not-yet-swept door, no open/closed filter, since
  // this is just an ambient walk-toward target, not a door-open action).
  _nearestUnvisitedDoor(wx, wy) {
    const h = this.host;
    if (typeof h?.NearbyGuids !== "function" || typeof h?.TryGetObjectDescFlags !== "function") return null;
    const ODF_DOOR = 0x1000; // ObjectDescriptionFlag.Door (observe_ext.js ODF map)
    let best = null;
    for (const g of h.NearbyGuids() ?? []) {
      try {
        const guid = g >>> 0;
        if (this._visitedDoors.has(guid)) continue;
        const flags = h.TryGetObjectDescFlags(g);
        if (flags == null || !(flags & ODF_DOOR)) continue;
        const p = h.TryGetObjectPosition?.(g);
        if (!p) continue;
        const pwx = worldX(p.objCellId >>> 0, p.x), pwy = worldY(p.objCellId >>> 0, p.y);
        const d = Math.hypot(pwx - wx, pwy - wy);
        if (!best || d < best.d) best = { guid, name: h.TryGetObjectName?.(guid) || "Door", wx: pwx, wy: pwy, d };
      } catch { /* one bad object must not break the sweep */ }
    }
    return best;
  }
}

export default createGrindBot;
