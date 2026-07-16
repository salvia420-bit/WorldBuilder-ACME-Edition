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
//     hz: 10,                          // tick rate
//   });
//   // bot.host, bot.kernel, bot.channel, bot.status(); bot.stop()

export async function createGrindBot(sessionHandle, config = {}) {
  const base = "/apps/holtburger-web/rynth";
  const [wh, cl, bl, ll, vt, kn, cc] = await Promise.all([
    import(`${base}/webhost.js`),
    import(`${base}/combat_loop.js`),
    import(`${base}/buff_loop.js`),
    import(`${base}/loot_loop.js`),
    import(`${base}/vitals.js`),
    import(`${base}/kernel.js`),
    import(`${base}/control_channel.js`),
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
  const loot = config.loot === false ? null : new ll.RynthLootLoop(host, config.loot || {});
  const vitals = config.vitals === false ? null : new vt.RynthVitals(host, { thresholds: config.vitals || {} });

  const kernel = new kn.RynthBotKernel(host, { combat, buff, loot, vitals });
  const channel =
    config.control === false
      ? null
      : new cc.RynthControlChannel(host, kernel, config.control || {});

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
    status: () => kernel.status,
    capabilities: () => host.capabilities,
    stop: () => {
      kernel.stop();
      host.stop();
    },
  };
}

export default createGrindBot;
