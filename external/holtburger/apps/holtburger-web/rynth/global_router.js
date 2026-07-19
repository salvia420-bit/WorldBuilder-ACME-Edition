// GlobalRouter — JS client for the RynthNav sidecar (report 09's global
// navmesh router, served by apps/rynthnav-sidecar on :8767). The sidecar
// owns the offline navmesh bake + Detour query + portal Dijkstra; this
// class owns the HTTP contract and the plan->walk->replan loop over the
// in-page leg executor (router.js RynthRouter).
//
// Contract (both sides must match EXACTLY — see rynthnav-sidecar):
//   GET  /health -> {ok, tiles, portals}
//   POST /route {from:{lb,x,y,z}, to:{lb,x,y,z}|{ns,ew}}
//     -> {ok:true, legs:[{lb,x,y,z,portal,label}], estUnits, portalsUsed,
//         coverage} | {ok:false, error} (planning failure is still HTTP 200;
//         from==to yields ok:true + one zero-distance arrival leg). Malformed
//         or out-of-world requests are HTTP 400, an oversized body 413, a
//         non-POST 405 — this client treats any non-200 as {ok:false} (route()).
// Legs are already in router.js's frame (full 32-bit objCellId, landblock-
// local AC Z-up metres) — they feed router.follow() untouched.
//
// goto() lifecycle hardening:
// - ONE goto at a time: a second goto() while one is active returns
//   {ok:false, error:"goto already active"} immediately (no follow()
//   clobber). The latch clears on completion AND on every error/throw
//   path (try/finally) — it can never stick.
// - The pose is null before the host's first tick and for a few ticks
//   mid-teleport (incl. replans right after a portal): goto() waits up to
//   poseTimeoutMs for a pose instead of failing outright.
// - The walk poll carries a stall deadline (stallMs, must exceed the
//   router's per-leg timeout): if the router's observable status stops
//   changing (host stopped ticking / tab killed), goto() cancels the
//   route and returns instead of leaking the poll loop forever. An
//   external cancel()/re-follow (state leaves WALK/PORTAL without a
//   DONE/FAILED) aborts the goto too — no replan on a cancelled route.
// - legsWalked sums router.status.walked (legs actually completed) across
//   re-follows; portal-skipped stale legs don't inflate it.

const DEFAULT_ENDPOINT = "http://127.0.0.1:8767";

export class GlobalRouter {
  /** @param host RynthWebHost (pose source); opts { endpoint, log } */
  constructor(host, { endpoint = DEFAULT_ENDPOINT, log } = {}) {
    this.host = host;
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.log = log || ((m) => console.log(`[gnav] ${m}`));
    this._active = false; // the one-goto-at-a-time busy latch
  }

  /** True while a goto() is planning/walking — a second goto() is refused. */
  get busy() {
    return this._active;
  }

  /** GET /health -> {ok, tiles, portals} (throws on network failure). */
  async health() {
    const r = await fetch(`${this.endpoint}/health`);
    return r.json();
  }

  /**
   * POST /route per the contract. fromPose = host.TryGetPlayerPose() shape
   * ({objCellId,x,y,z}); to = {lb,x,y,z} or {ns,ew} (/loc degrees).
   * Never throws — network/HTTP failures come back as {ok:false, error}.
   */
  async route(fromPose, to) {
    const body = {
      from: { lb: fromPose.objCellId >>> 0, x: fromPose.x, y: fromPose.y, z: fromPose.z },
      to,
    };
    let r;
    try {
      r = await fetch(`${this.endpoint}/route`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // In-page this is usually the sidecar being down (or CORS, if the
      // sidecar ever stops sending its Access-Control-* headers).
      return { ok: false, error: `sidecar unreachable at ${this.endpoint} (${e.message})` };
    }
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    try {
      return await r.json();
    } catch (e) {
      return { ok: false, error: `bad JSON from sidecar (${e.message})` };
    }
  }

  /** Wait up to timeoutMs for the host to produce a pose (null during boot
   *  and for a few ticks mid-teleport). Returns the pose or null. */
  async _awaitPose(timeoutMs, pollMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pose = this.host.TryGetPlayerPose();
      if (pose) return pose;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /**
   * Plan from the CURRENT pose to `to`, walk it via `router` (RynthRouter,
   * already ticked off the host heartbeat), and on a FAILED leg re-query
   * from the current pose (a fresh route, not a resume) up to `retries`
   * times. Resolves {ok, state, legsWalked, replans}; never throws on
   * route failure — returns {ok:false, error, ...} instead.
   *
   * One goto at a time (see header): a concurrent call gets
   * {ok:false, error:"goto already active"}. stallMs must exceed the
   * router's per-leg timeout (default 45s vs the router's 30s).
   */
  async goto(router, to, opts = {}) {
    if (this._active) return { ok: false, error: "goto already active", legsWalked: 0, replans: 0 };
    this._active = true;
    try {
      return await this._goto(router, to, opts);
    } finally {
      this._active = false; // clears on completion AND every error/throw path
    }
  }

  async _goto(router, to, { retries = 2, pollMs = 500, poseTimeoutMs = 15_000, stallMs = 45_000 } = {}) {
    let replans = 0;
    let legsWalked = 0;
    // Route quality of the plan currently being walked, surfaced into every
    // resolution of goto() so the decision layer (W3 journal/mission line)
    // learns WITHOUT a wiki lookup that a fallback is straight-line-through-
    // unbaked-terrain. Null until the first successful plan (no-pose path).
    // `coverage: "straight"` = blind fallback (the soak-14 Arwic-wall class);
    // "mixed" = some walk segments unbaked; "detour" = fully obstacle-aware.
    let coverage = null, estUnits = null, portalsUsed = null;
    for (let attempt = 0; ; attempt++) {
      const pose = await this._awaitPose(poseTimeoutMs, pollMs);
      if (!pose) return { ok: false, error: "no player pose", legsWalked, replans, coverage, estUnits, portalsUsed };
      const res = await this.route(pose, to);
      if (!res || res.ok !== true || !Array.isArray(res.legs) || !res.legs.length) {
        return { ok: false, error: (res && res.error) || "empty route", legsWalked, replans, coverage, estUnits, portalsUsed };
      }
      coverage = res.coverage ?? null;
      estUnits = Number.isFinite(res.estUnits) ? res.estUnits : null;
      portalsUsed = Number.isFinite(res.portalsUsed) ? res.portalsUsed : null;
      // First-class plan state for the W3 mission line (bot.globalRouter.lastPlan);
      // refreshed on the initial plan AND every replan. Read defensively downstream.
      this.lastPlan = {
        estUnits, coverage, portalsUsed,
        legCount: res.legs.length,
        plannedAt: Date.now(),
        replan: replans,
      };
      const straight = coverage === "straight";
      this.log(
        `route: ${res.legs.length} legs, ~${Math.round(res.estUnits)}u, ` +
          `portals=${res.portalsUsed}, coverage=${res.coverage}` +
          (straight ? " — STRAIGHT-LINE (unbaked region), expect obstacles" : "")
      );
      router.follow(res.legs);
      // Walk poll with a stall deadline + external-cancel detection.
      let lastSig = "";
      let lastChangeAt = Date.now();
      for (;;) {
        const st = router.status;
        if (st.state === "DONE" || st.state === "FAILED") break;
        if (st.state !== "WALK" && st.state !== "PORTAL") {
          // cancel()ed or re-follow()ed out from under us — abort, no replan.
          return {
            ok: false,
            state: st.state,
            error: "route cancelled",
            legsWalked: legsWalked + (st.walked ?? 0),
            replans,
            coverage, estUnits, portalsUsed,
          };
        }
        const sig = `${st.state}:${st.leg}:${st.walked}`;
        if (sig !== lastSig) {
          lastSig = sig;
          lastChangeAt = Date.now();
        } else if (Date.now() - lastChangeAt > stallMs) {
          router.cancel();
          return {
            ok: false,
            state: "STALLED",
            error: "walk stalled (host stopped ticking?)",
            legsWalked: legsWalked + (router.status.walked ?? 0),
            replans,
            coverage, estUnits, portalsUsed,
          };
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      legsWalked += router.status.walked ?? router.status.leg;
      if (router.status.state === "DONE") return { ok: true, state: "DONE", legsWalked, replans, coverage, estUnits, portalsUsed };
      if (attempt >= retries) {
        return { ok: false, state: "FAILED", error: "retries exhausted", legsWalked, replans, coverage, estUnits, portalsUsed };
      }
      replans += 1;
      this.log(`leg failed — replanning from current pose (${replans}/${retries})`);
    }
  }
}

export default GlobalRouter;
