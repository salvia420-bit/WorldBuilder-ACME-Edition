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
    const wasRunning = kernel._running === true; // kernel's is-running signal
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
        });

  host.start(config.hz ?? 10);
  kernel.start();

  return {
    host,
    kernel,
    channel,
    combat,
    buff,
    loot,
    vitals,
    router,
    globalRouter,
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
}

export default createGrindBot;
