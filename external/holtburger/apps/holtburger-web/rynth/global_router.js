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
//         coverage} | {ok:false, error} (still HTTP 200)
// Legs are already in router.js's frame (full 32-bit objCellId, landblock-
// local AC Z-up metres) — they feed router.follow() untouched.

const DEFAULT_ENDPOINT = "http://127.0.0.1:8767";

export class GlobalRouter {
  /** @param host RynthWebHost (pose source); opts { endpoint, log } */
  constructor(host, { endpoint = DEFAULT_ENDPOINT, log } = {}) {
    this.host = host;
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.log = log || ((m) => console.log(`[gnav] ${m}`));
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

  /**
   * Plan from the CURRENT pose to `to`, walk it via `router` (RynthRouter,
   * already ticked off the host heartbeat), and on a FAILED leg re-query
   * from the current pose (a fresh route, not a resume) up to `retries`
   * times. Resolves {ok, state, legsWalked, replans}; never throws on
   * route failure — returns {ok:false, error, ...} instead.
   */
  async goto(router, to, { retries = 2, pollMs = 500 } = {}) {
    let replans = 0;
    let legsWalked = 0;
    for (let attempt = 0; ; attempt++) {
      const pose = this.host.TryGetPlayerPose();
      if (!pose) return { ok: false, error: "no player pose", legsWalked, replans };
      const res = await this.route(pose, to);
      if (!res || res.ok !== true || !Array.isArray(res.legs) || !res.legs.length) {
        return { ok: false, error: (res && res.error) || "empty route", legsWalked, replans };
      }
      this.log(
        `route: ${res.legs.length} legs, ~${Math.round(res.estUnits)}u, ` +
          `portals=${res.portalsUsed}, coverage=${res.coverage}`
      );
      router.follow(res.legs);
      while (!router.done) await new Promise((r) => setTimeout(r, pollMs));
      legsWalked += router.status.leg;
      if (router.status.state === "DONE") return { ok: true, state: "DONE", legsWalked, replans };
      if (attempt >= retries) {
        return { ok: false, state: "FAILED", error: "retries exhausted", legsWalked, replans };
      }
      replans += 1;
      this.log(`leg failed — replanning from current pose (${replans}/${retries})`);
    }
  }
}

export default GlobalRouter;
