// Atlas — the named route library (NavAtlas W2.2). Routes are experience:
// each one came from a walk that actually completed (RouteRecorder), an
// imported player-authored nav file (nav_file.js), or offline physics
// pre-validation — never a server query (SPEC §0). The atlas names them,
// persists them (localStorage in-page, in-memory under node), estimates
// honest ETAs, and demotes routes that rot.
//
// Dependency-free by design (SPEC + main's confirmation): no imports from
// rynth/ai/**, no host/session handle. runRate is INJECTED into the ETA
// helpers by the caller (bot.js reads host.s.playerRunRate()); the atlas
// never reaches for it. This keeps the whole module node-testable.
//
// ── ETA model (SPEC §3-W2.3, calibrated — no magic constant) ───────────────
// Ground run speed (m/s) = runRate × RUN_SPEED_MS. RUN_SPEED_MS is NOT invented
// here: it is the client's own RunForward MotionTable anim speed, RUN_ANIM_SPEED
// = 4.0, verified from source this session (W2 deliverable #3):
//   • apps/holtburger-web/src/lib.rs:35765  const RUN_ANIM_SPEED: f32 = 4.0;
//     (== crates/holtburger-core/.../motion_interp.rs:189).
//   • state_ground_speed_inner (lib.rs:6902) — the wasm `stateGroundSpeed`
//     export JS already uses for foot-planting: RunForward magnitude = 4.0 ×
//     forward_speed, then clamp to `run_rate × 4.0`. For a straight run
//     forward_speed carries run_rate, so ground speed = run_rate × 4.0.
//   • run_rate itself = run_rate_from_skill_and_burden (context.rs:130-153):
//     (load_mod·(skill/(skill+200)·11)+4)/4, range [1.0 (base) .. 4.5 (skill
//     ==800 plateau, 18.0/4)] → 4.0 .. 18.0 m/s. Injected here (NOT re-scaled:
//     the getter already returns run_rate). The wiring reads it from the live
//     session handle — the SERVED pkg exposes it snake_case as
//     `player_run_rate()` (the d.ts `playerRunRate` is a newer/unbuilt pkg), so
//     wiring should try both spellings. This module never reaches for it.
//   • The "4.5" in core movement tests (system/tests.rs:1863) is a SEEDED
//     base_run_forward_velocity override to isolate the integrator, not the
//     canonical anim constant — do not confuse it for RUN_ANIM_SPEED.
// The env840 offline harness (appendix B §4) uses RUN_SPEED=4.0 = this value at
// run_rate 1; the W2.6 Rust route-validator re-measures displacement per frame
// and asserts ≈ run_rate × 4.0, closing the loop empirically.
// estMs = groundUnits / (runRate×4.0) × 1000 + 4 s/portal + 10 s/vendor-waypoint.

export const RUN_SPEED_MS = 4.0; // RUN_ANIM_SPEED (retail RunForward anim speed); see derivation above
const PORTAL_DWELL_MS = 4000; // router PORTAL_SETTLE_MS
const VENDOR_DWELL_MS = 10000; // ~vendor open+read
const OVERRUN_FACTOR = 2.0; // actual > this × est counts as an overrun strike
const SUSPECT_STRIKES = 2; // this many overrun strikes -> suspect
const STORAGE_KEY = "rynth.atlas.v1";
const SCHEMA_VERSION = 1;

function worldXY(objCellId, x, y) {
  return [((objCellId >>> 24) & 0xff) * 192 + x, ((objCellId >>> 16) & 0xff) * 192 + y];
}

// /loc degrees from a full objCellId + landblock-local x,y (observe.js frame),
// for compact human-readable summaries only.
function locDeg(lb, x, y) {
  const [wx, wy] = worldXY(lb, x, y);
  return { ns: +(wy / 24 - 1019.5).toFixed(1) / 10, ew: +(wx / 24 - 1019.5).toFixed(1) / 10 };
}

/** Pure ETA helper. runRate is injected (default 1 = un-buffed base). Returns
 *  milliseconds. A route with no legs is 0. */
export function estimateRouteMs(route, { runRate = 1, portalMs = PORTAL_DWELL_MS, vendorMs = VENDOR_DWELL_MS } = {}) {
  const legs = (route && route.legs) || [];
  // Portal-flag convention differs by recorded-format version: fmt>=2 flags the
  // DEPARTURE leg of a hop (leg[i-1]), legacy/imported routes flag the arrival
  // leg (leg[i]). A hop segment crosses no ground either way — pick the skip
  // predicate by fmt so both estimate correctly.
  const fmt2 = ((route && route.fmt) || 0) >= 2;
  const speed = Math.max(0.1, runRate * RUN_SPEED_MS); // guard div-by-zero
  let ground = 0;
  let portals = 0;
  let vendors = 0;
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i];
    if (l.portal) portals += 1;
    if (l.label && /vendor|shop|merchant/i.test(l.label)) vendors += 1;
    if (i === 0) continue;
    // fmt>=2: the hop is the segment leaving a departure-flagged leg (legs[i-1]).
    // legacy: the arrival-flagged portal leg swallows the ground on BOTH sides
    // (preserves the pre-v2 estimate exactly).
    const hop = fmt2 ? !!legs[i - 1].portal : (!!legs[i - 1].portal || !!l.portal);
    if (hop) continue; // a hop crosses no ground
    const [awx, awy] = worldXY(legs[i - 1].lb, legs[i - 1].x, legs[i - 1].y);
    const [bwx, bwy] = worldXY(l.lb, l.x, l.y);
    ground += Math.hypot(bwx - awx, bwy - awy);
  }
  return Math.round((ground / speed) * 1000 + portals * portalMs + vendors * vendorMs);
}

// Minimal storage shim: real localStorage in-browser, a Map under node so the
// suites need no DOM. Callers may inject their own {getItem,setItem}.
function defaultStorage() {
  if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

export class Atlas {
  /** opts: { storage, mirrorDir, log, key }. storage defaults per environment. */
  constructor(opts = {}) {
    this.storage = opts.storage || defaultStorage();
    this.key = opts.key || STORAGE_KEY;
    this.mirrorDir = opts.mirrorDir || null; // read by atlas_mirror.cjs, not here
    this.log = opts.log || ((m) => console.log(`[atlas] ${m}`));
    this._routes = new Map(); // id -> route
    this._load();
  }

  _load() {
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) for (const r of arr) if (r && r.id) this._routes.set(r.id, r);
    } catch (e) {
      this.log(`load failed: ${e.message}`);
    }
  }

  _persist() {
    try {
      this.storage.setItem(this.key, JSON.stringify(Array.from(this._routes.values())));
    } catch (e) {
      this.log(`persist failed: ${e.message}`);
    }
  }

  // Resolve a route by id first, then by name (case-insensitive).
  _resolve(nameOrId) {
    if (nameOrId == null) return null;
    if (this._routes.has(nameOrId)) return this._routes.get(nameOrId);
    const want = String(nameOrId).toLowerCase();
    for (const r of this._routes.values()) if (r.name && r.name.toLowerCase() === want) return r;
    return null;
  }

  listRoutes() {
    return Array.from(this._routes.values());
  }

  getRoute(nameOrId) {
    return this._resolve(nameOrId);
  }

  /** Persist a route (from RouteRecorder.finish or nav_file import). Fills in
   *  id, name, counters, schemaVersion, recordedAt if absent. Returns the
   *  stored route. */
  saveRoute(route) {
    if (!route || !Array.isArray(route.legs) || !route.legs.length) {
      throw new Error("saveRoute: route needs a non-empty legs array");
    }
    const r = { ...route };
    r.schemaVersion = SCHEMA_VERSION;
    if (!r.id) r.id = this._mkId(r);
    if (!r.name) r.name = this._autoName(r);
    else r.name = this._uniqueName(r.name, r.id);
    r.portalsUsed = r.portalsUsed ?? r.legs.filter((l) => l.portal).length;
    r.estUnits = r.estUnits ?? this._pathUnits(r);
    r.walkedMs = r.walkedMs ?? 0;
    r.runSkillAtRecord = r.runSkillAtRecord ?? null;
    r.runRateAtRecord = r.runRateAtRecord ?? null;
    r.successCount = r.successCount ?? 0;
    r.failCount = r.failCount ?? 0;
    r.lastResult = r.lastResult ?? null;
    r.overrunStrikes = r.overrunStrikes ?? 0;
    r.suspect = r.suspect ?? false;
    r.validated = r.validated ?? null;
    r.source = r.source || "walk";
    r.recordedAt = r.recordedAt || Date.now();
    this._routes.set(r.id, r);
    this._persist();
    this.log(`saved '${r.name}' (${r.legs.length} legs, ${r.estUnits}u)`);
    return r;
  }

  /** Rename an auto-named route. Returns the route or null if not found. */
  nameRoute(autoNameOrId, newName) {
    const r = this._resolve(autoNameOrId);
    if (!r) return null;
    r.name = this._uniqueName(newName, r.id);
    this._persist();
    this.log(`renamed -> '${r.name}'`);
    return r;
  }

  /** Record the outcome of a followed route. Accepts id OR name. Updates
   *  success/fail counts, lastResult, and overrun bookkeeping: an actualMs
   *  beyond OVERRUN_FACTOR × est (using the route's record-time runRate) is a
   *  strike; SUSPECT_STRIKES strikes marks the route suspect (rotten/blocked/
   *  lagged) so the director can demote it to re-record. Returns the route or
   *  null. */
  recordResult(nameOrId, { ok, actualMs, reason } = {}) {
    const r = this._resolve(nameOrId);
    if (!r) return null;
    r.lastResult = { ok: !!ok, actualMs: actualMs ?? null, reason: reason || null, at: Date.now() };
    if (ok) r.successCount = (r.successCount || 0) + 1;
    else r.failCount = (r.failCount || 0) + 1;
    if (ok && typeof actualMs === "number" && actualMs > 0) {
      const est = estimateRouteMs(r, { runRate: r.runRateAtRecord || 1 });
      if (est > 0 && actualMs > OVERRUN_FACTOR * est) {
        r.overrunStrikes = (r.overrunStrikes || 0) + 1;
        if (r.overrunStrikes >= SUSPECT_STRIKES) r.suspect = true;
        this.log(`'${r.name}' overrun ${Math.round(actualMs)}ms vs est ${est}ms (strike ${r.overrunStrikes})`);
      }
    }
    this._persist();
    return r;
  }

  /** Mark offline physics pre-validation (W2.6). failedLeg is the 0-based leg
   *  index that STALLED, or null on success. */
  markValidated(nameOrId, { ok, failedLeg, method } = {}) {
    const r = this._resolve(nameOrId);
    if (!r) return null;
    r.validated = { ok: !!ok, failedLeg: failedLeg ?? null, method: method || "offline-sim", at: Date.now() };
    this._persist();
    return r;
  }

  remove(nameOrId) {
    const r = this._resolve(nameOrId);
    if (!r) return false;
    this._routes.delete(r.id);
    this._persist();
    return true;
  }

  /** Compact journal-ready rows (SPEC W3 list_routes). runRate optional -> live
   *  ETA per route; omit for the record-time estimate. */
  summaries({ runRate } = {}) {
    return this.listRoutes().map((r) => ({
      id: r.id,
      name: r.name,
      from: locDeg(r.from.lb, r.from.x, r.from.y),
      to: locDeg(r.to.lb, r.to.x, r.to.y),
      legs: r.legs.length,
      portalsUsed: r.portalsUsed,
      estUnits: r.estUnits,
      etaMs: estimateRouteMs(r, { runRate: runRate ?? r.runRateAtRecord ?? 1 }),
      successCount: r.successCount,
      failCount: r.failCount,
      lastResult: r.lastResult,
      suspect: r.suspect,
      validated: r.validated ? r.validated.ok : null,
    }));
  }

  /** Live ETA in ms for one route; runRate injected by the caller. */
  estimateMs(nameOrIdOrRoute, { runRate = 1 } = {}) {
    const r = typeof nameOrIdOrRoute === "object" ? nameOrIdOrRoute : this._resolve(nameOrIdOrRoute);
    if (!r) return null;
    return estimateRouteMs(r, { runRate });
  }

  // ── mirror bridge (atlas_mirror.cjs pulls these via page.evaluate) ─────────
  exportAll() {
    return JSON.stringify({ key: this.key, version: SCHEMA_VERSION, routes: this.listRoutes() });
  }

  importAll(json) {
    try {
      const obj = typeof json === "string" ? JSON.parse(json) : json;
      const routes = (obj && obj.routes) || (Array.isArray(obj) ? obj : []);
      let n = 0;
      for (const r of routes) if (r && r.id) (this._routes.set(r.id, r), n++);
      this._persist();
      return n;
    } catch (e) {
      this.log(`importAll failed: ${e.message}`);
      return 0;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────
  _pathUnits(r) {
    const fmt2 = (r.fmt || 0) >= 2;
    let u = 0;
    for (let i = 1; i < r.legs.length; i++) {
      const hop = fmt2 ? !!r.legs[i - 1].portal : (!!r.legs[i - 1].portal || !!r.legs[i].portal);
      if (hop) continue;
      const [awx, awy] = worldXY(r.legs[i - 1].lb, r.legs[i - 1].x, r.legs[i - 1].y);
      const [bwx, bwy] = worldXY(r.legs[i].lb, r.legs[i].x, r.legs[i].y);
      u += Math.hypot(bwx - awx, bwy - awy);
    }
    return Math.round(u);
  }

  _mkId(r) {
    // Stable-ish id from endpoints + a short random tail (avoids collisions on
    // two recordings of the same corridor).
    const a = `${r.from.lb >>> 0}.${Math.round(r.from.x)}.${Math.round(r.from.y)}`;
    const b = `${r.to.lb >>> 0}.${Math.round(r.to.x)}.${Math.round(r.to.y)}`;
    const tail = Math.random().toString(36).slice(2, 6);
    return `r_${a}_${b}_${tail}`;
  }

  _autoName(r) {
    const f = locDeg(r.from.lb, r.from.x, r.from.y);
    const t = locDeg(r.to.lb, r.to.x, r.to.y);
    const fmt = (d) => `${Math.abs(d.ns).toFixed(1)}${d.ns >= 0 ? "N" : "S"}${Math.abs(d.ew).toFixed(1)}${d.ew >= 0 ? "E" : "W"}`;
    return this._uniqueName(`${fmt(f)}->${fmt(t)}`, r.id);
  }

  _uniqueName(base, selfId) {
    let name = base;
    let n = 1;
    const taken = (nm) => {
      for (const r of this._routes.values()) if (r.id !== selfId && r.name && r.name.toLowerCase() === nm.toLowerCase()) return true;
      return false;
    };
    while (taken(name)) name = `${base}#${++n}`;
    return name;
  }
}

export default Atlas;
