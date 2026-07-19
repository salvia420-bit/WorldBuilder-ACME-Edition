// GlobalRouter — JS client for the RynthNav sidecar (report 09's global
// navmesh router, served by apps/rynthnav-sidecar on :8767). The sidecar
// owns the offline navmesh bake + Detour query + portal Dijkstra; this
// class owns the HTTP contract and the plan->walk->replan loop over the
// in-page leg executor (router.js RynthRouter).
//
// Contract (both sides must match EXACTLY — see rynthnav-sidecar):
//   GET  /health -> {ok, tiles, portals}
//   POST /route {from:{lb,x,y,z}, to:{lb,x,y,z}|{ns,ew}, avoid?:[{x,y,r}]}
//     -> {ok:true, legs:[{lb,x,y,z,portal,stitch,label}], estUnits, portalsUsed,
//         coverage, stitchedLegs, partial, avoidApplied} | {ok:false, error}
//         (planning failure is still HTTP 200; from==to yields ok:true + one
//         zero-distance arrival leg). Malformed or out-of-world requests are
//         HTTP 400, an oversized body 413, a non-POST 405 — this client treats
//         any non-200 as {ok:false} (route()). `avoid` is world-frame circles
//         the sidecar routes around; omitted/empty => byte-identical to v1.
//         goto() uses it to replan around a blocked stitch leg (avoidRetries).
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

// World-frame (metres) from a full objCellId + landblock-local x,y — mirror of
// router.js's worldXY (avoid circles are placed at a blocked leg's world pose).
function worldXY(objCellId, x, y) {
  return [((objCellId >>> 24) & 0xff) * 192 + x, ((objCellId >>> 16) & 0xff) * 192 + y];
}

// Two plans are "identical" (=> a v1 sidecar ignored our "avoid") when they have
// the same leg count and each leg's lb + x/y agree within epsilon. Used to abort
// avoid-replanning against a sidecar that can't route around the blockage.
function plansIdentical(a, b, eps = 0.5) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if ((a[i].lb >>> 0) !== (b[i].lb >>> 0)) return false;
    if (Math.abs(a[i].x - b[i].x) > eps || Math.abs(a[i].y - b[i].y) > eps) return false;
  }
  return true;
}

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
   * ({objCellId,x,y,z}); to = {lb,x,y,z} or {ns,ew} (/loc degrees). Optional
   * `avoid` = [{x,y,r}] world-frame circles the sidecar routes around (contract
   * v2). When `avoid` is empty/absent the body carries NO "avoid" key, so the
   * request is byte-identical to the pre-avoid contract.
   * Never throws — network/HTTP failures come back as {ok:false, error}.
   */
  async route(fromPose, to, avoid = null) {
    const body = {
      from: { lb: fromPose.objCellId >>> 0, x: fromPose.x, y: fromPose.y, z: fromPose.z },
      to,
    };
    if (Array.isArray(avoid) && avoid.length) body.avoid = avoid;
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

  async _goto(router, to, { retries = 2, pollMs = 500, poseTimeoutMs = 15_000, stallMs = 45_000, avoidRetries = 1, avoidRadiusM = 6 } = {}) {
    let replans = 0;
    let legsWalked = 0;
    // Avoid-list replanning (task #12): when a stitch leg is physically blocked,
    // push a world-frame circle at the blockage and re-query so the sidecar's
    // Detour routes AROUND it (instead of the terminal fail-fast). Accumulated
    // across the goto and carried out as `avoidTried`. Empty while nothing blocks,
    // so the FIRST plan request is byte-identical to the pre-avoid contract.
    const avoid = [];
    let avoidUsed = 0;
    // Set right after we push an avoid circle: holds the just-failed plan so the
    // next iteration can detect a v1 sidecar that ignored "avoid" (identical plan).
    let pendingAvoid = null;
    // Route quality of the plan currently being walked, surfaced into every
    // resolution of goto() so the decision layer (W3 journal/mission line)
    // learns WITHOUT a wiki lookup that a fallback is straight-line-through-
    // unbaked-terrain. Null until the first successful plan (no-pose path).
    // `coverage: "straight"` = blind fallback (the soak-14 Arwic-wall class);
    // "mixed" = some walk segments unbaked; "detour" = fully obstacle-aware.
    let coverage = null, estUnits = null, portalsUsed = null;
    // Contract v2 (sidecar): per-leg {stitch:true} + top-level stitchedLegs/
    // partial. Absent on a v1 sidecar -> null, all new behavior inert.
    let stitchedLegs = null, partial = null;
    for (let attempt = 0; ; attempt++) {
      const pose = await this._awaitPose(poseTimeoutMs, pollMs);
      if (!pose) return { ok: false, error: "no player pose", legsWalked, replans, coverage, estUnits, portalsUsed, stitchedLegs, partial };
      const res = await this.route(pose, to, avoid);
      if (!res || res.ok !== true || !Array.isArray(res.legs) || !res.legs.length) {
        return { ok: false, error: (res && res.error) || "empty route", legsWalked, replans, coverage, estUnits, portalsUsed, stitchedLegs, partial };
      }
      // v1-ignore guard: if we just added an avoid circle but the fresh plan is
      // identical to the one that failed, the sidecar didn't honor "avoid" —
      // replanning is futile, so surface the blocked error (as the fail-fast did).
      if (pendingAvoid) {
        if (plansIdentical(res.legs, pendingAvoid.legs)) {
          this.log("avoid ignored by sidecar (plan unchanged) — returning blocked error");
          return {
            ok: false,
            state: "FAILED",
            error: "blocked stitch leg",
            blockedLeg: pendingAvoid.blockedLeg,
            avoidTried: avoid.slice(),
            legsWalked, replans, coverage, estUnits, portalsUsed, stitchedLegs, partial,
          };
        }
        pendingAvoid = null; // sidecar honored avoid — walk the detour plan
      }
      coverage = res.coverage ?? null;
      estUnits = Number.isFinite(res.estUnits) ? res.estUnits : null;
      portalsUsed = Number.isFinite(res.portalsUsed) ? res.portalsUsed : null;
      stitchedLegs = Number.isFinite(res.stitchedLegs) ? res.stitchedLegs : null;
      partial = typeof res.partial === "boolean" ? res.partial : null;
      // First-class plan state for the W3 mission line (bot.globalRouter.lastPlan);
      // refreshed on the initial plan AND every replan. Read defensively downstream.
      this.lastPlan = {
        estUnits, coverage, portalsUsed, stitchedLegs, partial,
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
            coverage, estUnits, portalsUsed, stitchedLegs, partial,
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
            coverage, estUnits, portalsUsed, stitchedLegs, partial,
          };
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      legsWalked += router.status.walked ?? router.status.leg;
      if (router.status.state === "DONE") return { ok: true, state: "DONE", legsWalked, replans, coverage, estUnits, portalsUsed, stitchedLegs, partial, avoidTried: avoid.slice() };
      // A FAILED stitch leg is a physical obstacle inside a straight-line fallback
      // segment. A plain replan from the same pose reproduces the same stitch
      // (deterministic plan), so instead push an AVOID circle at the blocked
      // world position and re-query — the sidecar's Detour then routes around it
      // (task #12). Bounded by avoidRetries; a v1 sidecar that ignores "avoid" is
      // caught by the plansIdentical guard above and falls through to the error.
      if (router.status.stitchBlocked) {
        const bl = router.route ? router.route[router.status.leg] : null;
        const blockedLeg = bl ? { index: router.status.leg, lb: bl.lb, x: bl.x, y: bl.y, z: bl.z } : null;
        // No avoid-replan while parked in an EnvCell: the sidecar has no indoor
        // mesh and 400s an EnvCell `from` — replanning would mask the blocked
        // error (goto_compose's portal-transit assist triggers on it) with a
        // raw "HTTP 400". Surface the honest blocked error instead.
        const curPose = this.host.TryGetPlayerPose();
        const indoorNow = !!curPose && ((curPose.objCellId & 0xffff) >= 0x100);
        if (!indoorNow && bl && avoidUsed < avoidRetries) {
          const [bwx, bwy] = worldXY(bl.lb >>> 0, bl.x, bl.y);
          avoid.push({ x: bwx, y: bwy, r: avoidRadiusM });
          avoidUsed += 1;
          pendingAvoid = { legs: router.route.slice(), blockedLeg };
          this.log(
            `stitch leg ${router.status.leg + 1} blocked — replanning AROUND it ` +
              `(avoid ${avoidUsed}/${avoidRetries}, r=${avoidRadiusM}m @ ${bwx.toFixed(0)},${bwy.toFixed(0)})`
          );
          continue; // re-query with the avoid list; the top-of-loop guard vets the result
        }
        this.log(`stitch leg ${router.status.leg + 1} blocked — not replanning (avoid retries exhausted)`);
        return {
          ok: false,
          state: "FAILED",
          error: "blocked stitch leg",
          blockedLeg,
          avoidTried: avoid.slice(),
          legsWalked, replans, coverage, estUnits, portalsUsed, stitchedLegs, partial,
        };
      }
      // Portal leg arrived but the hop never fired (router portalContactMs):
      // deterministic — replanning walks back to the same portal. Surface the
      // blocked leg so goto_compose's portal-touch assist USEs the portal.
      if (router.status.portalBlocked) {
        const pbl = router.route ? router.route[router.status.leg] : null;
        this.log(`portal leg ${router.status.leg + 1} blocked (no hop) — not replanning; touch assist takes over`);
        return {
          ok: false,
          state: "FAILED",
          error: "blocked portal leg",
          blockedLeg: pbl ? { index: router.status.leg, lb: pbl.lb, x: pbl.x, y: pbl.y, z: pbl.z } : null,
          avoidTried: avoid.slice(),
          legsWalked, replans, coverage, estUnits, portalsUsed, stitchedLegs, partial,
        };
      }
      if (attempt >= retries) {
        return { ok: false, state: "FAILED", error: "retries exhausted", legsWalked, replans, coverage, estUnits, portalsUsed, stitchedLegs, partial };
      }
      replans += 1;
      this.log(`leg failed — replanning from current pose (${replans}/${retries})`);
    }
  }
}

export default GlobalRouter;
