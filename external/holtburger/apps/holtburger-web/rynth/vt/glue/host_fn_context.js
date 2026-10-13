// rynth/vt/glue/host_fn_context.js — the HostFnContext (PLAN §3.7) the meta
// HOST function library (cmd/stdlib_host.js) closes over, built over the live
// bot and the VT layer (INT-2, §3.15). Members are resolved LIVE through
// `layer` (getters), so the registry can be filled before every service
// exists and survives nothing stale.
//
//   host      () => the bot's RynthWebHost
//   actions   the layer's shared VtActions (one item-token owner "vtcmd")
//   options   VtOptions (settings functions + the meta-only bag)
//   print     the layer's local chat output (never the server-sending member)
//   runChat   THE local chain: /rs family → /ls, /ah → host.InvokeChatParser
//   quests    QuestTracker;  creatures  CreatureProfiles;  nav {status, isEmpty}
//   now, log, getRegex (EXPR's .NET-dialect cache)

function safe(fn, dflt = null) {
  try {
    const v = fn();
    return v === undefined ? dflt : v;
  } catch {
    return dflt;
  }
}

/**
 * @param {{ bot: object, host?: object, layer: object, getRegex?: Function }} deps
 */
export function buildHostFnContext({ bot = null, host = null, layer, getRegex = null } = {}) {
  const L = () => layer || {};
  return {
    host: () => safe(() => bot?.host ?? null, null) || host || null,
    get actions() {
      return safe(() => L().actions ?? null, null);
    },
    get options() {
      return safe(() => L().options ?? null, null);
    },
    print: (text, category = 0) => safe(() => L().print?.(text, category)),
    runChat: (line) => safe(() => L().runChat?.(line, { source: "meta" })),
    get quests() {
      return safe(() => L().quests ?? null, null);
    },
    get creatures() {
      return safe(() => L().creatures ?? null, null);
    },
    nav: {
      status: () => safe(() => L().nav?.status?.() ?? null, null),
      isEmpty: () => safe(() => (L().nav ? L().nav.isEmpty() === true : true), true),
    },
    now: () => safe(() => L().now(), Date.now()),
    log: (m) => safe(() => L().log?.(m)),
    getRegex: typeof getRegex === "function" ? (p, f) => getRegex(p, f) : undefined,
  };
}

export default buildHostFnContext;
