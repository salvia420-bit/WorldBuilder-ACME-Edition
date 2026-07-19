// tools/routes.js — route-level actions over the W2 route atlas
// (SPEC-navatlas §3-W3.1): follow_route / list_routes / name_route, plus the
// mission observation line (§3-W3.3). The atlas itself (rynth/atlas.js) is
// Agent-B-owned and dependency-free; this module is the AI-layer consumer.
//
// Atlas resolution is lazy and duck-typed: an injected atlas wins (tests);
// otherwise `${base}/atlas.js` is imported on first use. A missing/broken
// atlas degrades every action to { ok:false, error } — the survival
// invariant, never a throw into the check-in.

const NAME_MAX = 60;

// One shared instance per page: the auto-record wiring and the actions must
// see the same dirty state, not two localStorage-racing copies.
const _atlasCache = new Map(); // base -> Promise<atlas|null>
export function getAtlas(base, injected = null) {
  if (injected) return Promise.resolve(injected);
  if (typeof base !== "string" || !base) return Promise.resolve(null);
  if (!_atlasCache.has(base)) {
    _atlasCache.set(
      base,
      import(`${base}/atlas.js`)
        .then((m) => {
          const Atlas = typeof m.Atlas === "function" ? m.Atlas : typeof m.default === "function" ? m.default : null;
          if (!Atlas) return null;
          const at = new Atlas({});
          // The atlas mirror (atlas_mirror.cjs) reads window.__atlas — the
          // page-side handle to THE shared instance.
          try { if (typeof window !== "undefined" && !window.__atlas) window.__atlas = at; } catch { /* no window */ }
          return at;
        })
        .catch(() => null),
    );
  }
  return _atlasCache.get(base);
}

/** Live run-rate scalar from the wasm surface; 1.0 when unavailable. */
export function liveRunRate(bot) {
  try {
    const r = bot?.host?.s?.playerRunRate?.();
    return Number.isFinite(r) && r > 0 ? r : 1;
  } catch {
    return 1;
  }
}

const fmtS = (ms) => `${Math.max(0, Math.round(ms / 1000))}s`;

/**
 * The mission observation line (§3-W3.3) — first-class harness state, not
 * model memory. Empty string when idle and nothing recent to report.
 *   mission: goto 33.3N 56.6E | leg 3/7 | ETA 40s | coverage detour | elapsed 52s | interrupts: 1
 *   mission: (last) route "arwic-run" -> ARRIVED in 96s
 */
export function renderMissionLine(bot, { now = Date.now() } = {}) {
  try {
    const m = bot?.mission;
    if (!m) {
      const lm = bot?.lastMission;
      // Recent-completion echo: the post-route check-in reads the outcome
      // here even if the journal tail scrolled.
      if (lm && Number.isFinite(lm.endedAt) && now - lm.endedAt < 10 * 60_000) {
        const verdict = lm.result?.ok ? "ARRIVED" : `FAILED (${lm.result?.state ?? "?"})`;
        return `mission: (last) ${lm.kind} ${lm.label} -> ${verdict} in ${fmtS(lm.endedAt - lm.startedAt)}`;
      }
      return "";
    }
    const parts = [`mission: ${m.kind} ${m.label}`];
    const st = bot?.router?.status;
    if (st && (st.state === "WALK" || st.state === "PORTAL"))
      parts.push(`leg ${st.leg + 1}/${st.legs}`);
    const plan = bot?.globalRouter?.lastPlan;
    const walked = Number.isFinite(st?.walked) ? st.walked : null;
    if (plan && Number.isFinite(plan.estUnits) && walked != null) {
      const speed = liveRunRate(bot) * 4.0; // integrator ground cap: run_rate × 4 m/s
      const remain = Math.max(0, plan.estUnits - walked);
      parts.push(`ETA ${fmtS((remain / speed) * 1000)}`);
    }
    // "mixed" is normal on portal routes (portal transits count as tiny
    // straight segments); pure "straight" means the walk is through UNBAKED
    // terrain — the wall-grind class of route.
    if (plan?.coverage) parts.push(`coverage ${plan.coverage}${plan.coverage === "straight" ? " (UNBAKED — obstacles possible)" : ""}`);
    parts.push(`elapsed ${fmtS(now - m.startedAt)}`);
    parts.push(`interrupts: ${m.interrupts ?? 0}`);
    return parts.join(" | ");
  } catch {
    return "";
  }
}

const failFor = (type, ctx) => (error) => {
  try { ctx?.log && ctx.log(`[ai] action ${type}: ${error}`); } catch { /* log loss is fine */ }
  return { type, ok: false, error: String(error) };
};

/** Integrator seam, registerWorld-shaped. opts: { base, atlas? (test seam) }. */
export function registerRoutes(extActions, { base, atlas = null } = {}) {
  const resolve = () => getAtlas(base, atlas);

  const followRoute = {
    type: "follow_route",
    params: { name: "atlas route name (or id) from list_routes" },
    desc: "walk a recorded atlas route by name — the harness follows the legs, restores the grind on arrival, and reports est vs actual time; you are checked in when it arrives or fails",
    validate(a) {
      if (!a || typeof a !== "object" || Array.isArray(a)) return { ok: false, error: "action must be an object" };
      if (typeof a.name !== "string" || !a.name.trim()) return { ok: false, error: "name must be a non-empty string" };
      return { ok: true };
    },
  };
  followRoute.apply = async function apply(bot, a, ctx = {}) {
    const fail = failFor(followRoute.type, ctx);
    try {
      const v = followRoute.validate(a);
      if (!v.ok) return fail(v.error);
      if (typeof bot?.followRoute !== "function") return fail("unavailable");
      const at = await resolve();
      if (!at) return fail("route atlas unavailable");
      const route = at.getRoute(a.name.trim());
      if (!route) return fail(`no such route ${JSON.stringify(a.name)} — use list_routes`);
      const rr = liveRunRate(bot);
      let estMs = null;
      try { estMs = at.estimateMs?.(route, { runRate: rr }) ?? null; } catch { estMs = null; }
      const t0 = Date.now();
      const r = await bot.followRoute(route.legs, { label: route.name ?? a.name.trim() });
      const actualMs = Date.now() - t0;
      if (r?.ok && bot._metrics) bot._metrics.routesReused++;
      try { at.recordResult?.(route.name ?? route.id, { ok: r?.ok === true, actualMs, reason: r?.state }); } catch { /* atlas bookkeeping must not fail the walk */ }
      try {
        ctx.journal?.add?.(
          "note",
          `route "${route.name ?? a.name}" ${r?.ok ? "ARRIVED" : `FAILED (${r?.state ?? "?"})`} — est ${estMs != null ? fmtS(estMs) : "?"} actual ${fmtS(actualMs)}${route.suspect ? " (route was marked suspect)" : ""}`,
        );
      } catch { /* note loss must not fail the action */ }
      return r?.ok
        ? { type: followRoute.type, ok: true, result: { state: r.state, estMs, actualMs } }
        : fail(`route ${r?.state ?? "failed"}${r?.error ? `: ${r.error}` : ""}`);
    } catch (e) {
      return fail((e && e.message) || e);
    }
  };

  const listRoutes = {
    type: "list_routes",
    params: {},
    desc: "list the recorded atlas routes (name, endpoints, length, ETA quality) — routes are earned by walking: successful novel gotos are auto-recorded",
    validate(a) {
      if (!a || typeof a !== "object" || Array.isArray(a)) return { ok: false, error: "action must be an object" };
      return { ok: true };
    },
  };
  listRoutes.apply = async function apply(_bot, a, ctx = {}) {
    const fail = failFor(listRoutes.type, ctx);
    try {
      const v = listRoutes.validate(a);
      if (!v.ok) return fail(v.error);
      const at = await resolve();
      if (!at) return fail("route atlas unavailable");
      const rows = (at.summaries?.() ?? []).slice(0, 20);
      const lines = rows.map((r) => {
        const loc = (p) => (p && Number.isFinite(p.ns) ? `${p.ns.toFixed(1)},${p.ew.toFixed(1)}` : "?");
        return `${r.name}: ${loc(r.from)} -> ${loc(r.to)} | ${r.legs ?? "?"} legs | ${r.estUnits != null ? Math.round(r.estUnits) + "u" : "?"} | ok x${r.successCount ?? 0}${r.suspect ? " SUSPECT" : ""}${r.validated ? " validated" : ""}`;
      });
      return { type: listRoutes.type, ok: true, result: { count: rows.length, routes: lines } };
    } catch (e) {
      return fail((e && e.message) || e);
    }
  };

  const nameRoute = {
    type: "name_route",
    params: {
      route: "current (auto-generated) route name or id from list_routes",
      name: `new durable name, <= ${NAME_MAX} chars (e.g. "holtburg-to-arwic")`,
    },
    desc: "rename an auto-recorded route worth keeping — named routes are your earned travel library",
    validate(a) {
      if (!a || typeof a !== "object" || Array.isArray(a)) return { ok: false, error: "action must be an object" };
      if (typeof a.route !== "string" || !a.route.trim()) return { ok: false, error: "route must be a non-empty string" };
      if (typeof a.name !== "string" || !a.name.trim()) return { ok: false, error: "name must be a non-empty string" };
      if (a.name.length > NAME_MAX) return { ok: false, error: `name must be <= ${NAME_MAX} chars` };
      return { ok: true };
    },
  };
  nameRoute.apply = async function apply(_bot, a, ctx = {}) {
    const fail = failFor(nameRoute.type, ctx);
    try {
      const v = nameRoute.validate(a);
      if (!v.ok) return fail(v.error);
      const at = await resolve();
      if (!at) return fail("route atlas unavailable");
      const r = at.nameRoute?.(a.route.trim(), a.name.trim());
      if (!r) return fail(`no such route ${JSON.stringify(a.route)} — use list_routes`);
      return { type: nameRoute.type, ok: true, result: { name: r.name ?? a.name.trim() } };
    } catch (e) {
      return fail((e && e.message) || e);
    }
  };

  for (const def of [followRoute, listRoutes, nameRoute]) {
    if (Object.prototype.hasOwnProperty.call(extActions, def.type))
      throw new Error(`registerRoutes: action type already registered: ${def.type}`);
    extActions[def.type] = def;
  }
  return { getAtlas: resolve };
}
