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

export async function createGrindBot(sessionHandle, config = {}) {
  // Sibling-module base derived from THIS module's URL: identical to the
  // old hardcoded "/apps/holtburger-web/rynth" when served from the page,
  // and additionally resolves under file:// (node fixture tests).
  const base = new URL(".", import.meta.url).href.replace(/\/$/, "");
  const [wh, cl, bl, ll, vt, kn, cc, rt] = await Promise.all([
    import(`${base}/webhost.js`),
    import(`${base}/combat_loop.js`),
    import(`${base}/buff_loop.js`),
    import(`${base}/loot_loop.js`),
    import(`${base}/vitals.js`),
    import(`${base}/kernel.js`),
    import(`${base}/control_channel.js`),
    import(`${base}/router.js`),
  ]);

  const host = new wh.RynthWebHost(sessionHandle, config.hostOpts || {});
  host.nearbyRangeM = config.nearbyRangeM ?? 60;

  // Filter desired buffs to the known-spell book so the buff loop never
  // spins on a spell the character can't cast.
  const known = new Set(
    (sessionHandle.playerKnownSpells ? Array.from(sessionHandle.playerKnownSpells() || []) : []).map(Number)
  );
  const buffIds = (config.buffs || []).filter((id) => known.has(id));

  const combat = new cl.RynthCombatLoop(host, { priorities: config.priorities || {} });
  const buff = buffIds.length ? new bl.RynthBuffLoop(host, buffIds) : null;
  if (buff) bl.loadSpellLadders(); // B4/B5 — preload the family tier table
  const loot = config.loot === false ? null : new ll.RynthLootLoop(host, config.loot || {});
  const vitals = config.vitals === false ? null : new vt.RynthVitals(host, { thresholds: config.vitals || {} });

  const kernel = new kn.RynthBotKernel(host, { combat, buff, loot, vitals });

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
    globalRouter = new gr.GlobalRouter(host, { endpoint: config.nav.endpoint });
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
  // indoor_router.js:34-37): indoor A*/exit routing prunes every drop/jump edge
  // (no jump primitive), so a goal or exit reachable only by a drop fails
  // honestly ({ok:false, error:"indoor graph unavailable"|"...unreachable"}).
  const doGoto = async (to, opts) => {
    if (!globalRouter) return { ok: false, error: "nav not configured (config.nav)" };
    // Refuse BEFORE touching the kernel: a rejected second goto must not
    // stop/restart the kernel out from under the goto that owns it. composeActive
    // covers indoor-only phases where globalRouter.busy is momentarily clear.
    if (globalRouter.busy || composeActive) return { ok: false, error: "goto already active" };
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
    if (globalRouter && globalRouter.busy) return { ok: false, error: "goto active" };
    if (followBusy) return { ok: false, error: "route already active" };
    if (!Array.isArray(legs) || !legs.length) return { ok: false, error: "empty route" };
    // Contract v2 (task #17): derive portal/indoor flags (legacy routes replay
    // without re-recording), re-bucket indoor legs to the walkable frame + stamp
    // their long watchdog. A plain outdoor route gains no flags -> untouched.
    const preparedLegs = gcMod.prepareReplayLegs(legs, { fmt });
    const hasPortals = gcMod.routeHasPortals(preparedLegs);
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
      if (hasPortals) {
        // Portal route: goto_compose owns the router walk (native hop + resume,
        // touch assist on a blocked portal, one indoor-wedge re-path).
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
          // Lazy: the AI director is constructed AFTER the bot object below
          // (it observes the whole bot surface); events only pump once the
          // host heartbeat runs, so this closure never fires before `bot`.
          getAi: () => bot.ai?.director,
        });

  host.start(config.hz ?? 10);
  kernel.start();

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
    startedAt: Date.now(), // uptime anchor — ai/observe.js prefers bot.startedAt
    /** Travel a raw route ([{lb,x,y,z}]) — pauses the grind; caller resumes.
     *  Returns {ok}; refused while a goto() owns the router (a raw follow
     *  would clobber the goto's walk loop). A later goto() cancels a raw
     *  travel in progress (last command wins). */
    travel: (route) => {
      if (globalRouter && globalRouter.busy) return { ok: false, error: "goto active" };
      kernel.stop();
      router.follow(route);
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
  const aiCfg = aiConfig && typeof aiConfig === "object" ? aiConfig : null;
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
  const client = new lc.LlmClient({
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
    intervalMinutes: aiCfg?.intervalMinutes, // undefined -> director defaults
    minIntervalMinutes: aiCfg?.minIntervalMinutes,
    maxIntervalMinutes: aiCfg?.maxIntervalMinutes, // caps LLM-supplied next_check_minutes
    dryRun: aiCfg?.dryRun,
    maxCallsPerHour: aiCfg?.maxCallsPerHour, // undefined -> director defaults
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

export default createGrindBot;
