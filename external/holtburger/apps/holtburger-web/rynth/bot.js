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
  let globalRouter = null;
  if (config.nav) {
    const gr = await import(`${base}/global_router.js`);
    globalRouter = new gr.GlobalRouter(host, { endpoint: config.nav.endpoint });
  }
  const doGoto = async (to, opts) => {
    if (!globalRouter) return { ok: false, error: "nav not configured (config.nav)" };
    // Refuse BEFORE touching the kernel: a rejected second goto must not
    // stop/restart the kernel out from under the goto that owns it.
    if (globalRouter.busy) return { ok: false, error: "goto already active" };
    // Last command wins over a raw travel() in progress.
    const rs = router.status.state;
    if (rs === "WALK" || rs === "PORTAL") {
      router.cancel();
    }
    const wasRunning = kernel.running === true; // kernel's is-running signal
    kernel.stop();
    try {
      return await globalRouter.goto(router, to, opts);
    } finally {
      if (wasRunning) kernel.start();
    }
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

  const [lc, jn, dr] = await Promise.all([
    import(`${base}/ai/llm_client.js`),
    import(`${base}/ai/journal.js`),
    import(`${base}/ai/director.js`),
  ]);
  const client = new lc.LlmClient({
    apiKey,
    baseUrl: aiCfg?.baseUrl, // undefined -> client defaults (OpenRouter)
    model: aiCfg?.model,
    maxTokens: aiCfg?.maxTokens, // reasoning-tier models need > the 1024 default
    reasoning: aiCfg?.reasoning, // e.g. { effort: "low" } — OpenRouter unified reasoning
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
    ...(ext
      ? ext.directorDeps // observe/validate/execute/systemPrompt
      : typeof aiCfg?.systemPrompt === "string" && aiCfg.systemPrompt
        ? { systemPrompt: aiCfg.systemPrompt }
        : {}),
  });
  bot.ai = { director, client, journal, ...(ext ? { extensions: ext } : {}) };

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
      start: () => director.start(),
      stop: () => director.stop(),
      checkNow: () => director.checkNow(),
      status: () => director.status,
      journal,
      panel: () => openPanel(),
    };
    if (wantPanel) openPanel();
  }

  if (aiCfg?.autoStart !== false) director.start();
}

export default createGrindBot;
