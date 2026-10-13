// rynth/vt/nav/active_nav.js — the VTank ActiveNav runtime (W1-6 NAV, PLAN §3.8).
//
// One loaded route (RouteState) + the active waypoint's executor, driven as a
// KERNEL SLOT ("Navigate") instead of a mover: the kernel keeps running while
// a VT route is walked, so Vitals/Combat/Loot/Buffing preempt navigation and
// it resumes at the same waypoint (VTank: nav is the lowest-priority activity,
// U3 §0 / U7b §5.1). With BoostNavPriority the slot ranks before Combat
// (gentle: yields when attacked; BoostNavStrict: before pinned Combat too) but
// never before buffing (D39).
//
// Ownership rules (V-11):
//   * the router walks ONE leg at a time that ActiveNav issued; ownership is
//     element identity `router.route[0] === issuedLeg` (follow() slices) plus
//     a WALK/PORTAL state check (the router keeps `route` after DONE/IDLE);
//   * leaving the slot (onLeave → yield) cancels OUR leg only, keeps the
//     index and the executor's memory (deadlines, pause remaining time);
//   * a Pause dwell never walks and holds bot.claimMovement("vt-nav") so the
//     unwedge reflex never reads a dwell as a wedge (U3 H8);
//   * `/rs jump` runs through the "JumpNow" slot (rank afterUnwedge) while the
//     kernel runs, or directly under bot.claimMovement("rs-jump") when it does
//     not and nothing else owns the body (critic B10).
//
// All persistent state lives in the injected `state` (session.navState):
// `route`, `exec` {point, mem}, `generation`, `lastResult`, `stuckSkips`,
// `lastChatAt`, `follow` — so a new ActiveNav on the same state (a bot rebind
// on the same page, D6) continues at the same index and executor deadlines.
//
// Never throws: public commands return {ok, …}; the slot tick is wrapped.

import { portalSpaceActive } from "../../portal_gate.js";
import { legToNavPoint, RECALL_SPELL_NAMES } from "../../nav_file.js";
import {
  ROUTE,
  ROUTE_NAMES,
  POINT,
  POINT_NAMES,
  JUMP_DIRECTIONS,
  makeRoute,
  cloneRoute,
  normalizePoint,
  normalizeRouteType,
  normalizeFollowTarget,
  startIndex,
  nearestPointIndex,
  isEmpty as routeIsEmpty,
  advance as routeAdvance,
  skipDense,
  insert as routeInsert,
  removeAt as routeRemoveAt,
  setActive as routeSetActive,
  step as routeStep,
  reverse as routeReverse,
  minDistM,
} from "./route_model.js";
import { parseNavVt, validateNavName } from "./nav_profiles.js";
import { makeExecutor, posWorld, runJob, jumpArgs, NAV_TUNING, BUDGET_ANCHORS } from "./executors.js";

export const FOLLOW_START_M = 8; // CS/NavigationEngine.cs:1344-1345 (Q21: fixed 8/5 m)
export const FOLLOW_STOP_M = 5;
export const FOLLOW_REISSUE_MS = 1_000;
export const MAX_STUCK_SKIPS = 3;
export const EXTERNAL_TELEPORT_TICK_GAP_MS = 1_500;
export const JUMP_QUEUE_MAX_MS = 5_000;

const ODF_PORTAL = 0x40000;
const ODF_VENDOR = 0x200;
const SIGNAL_TYPES = ["vendorOpen", "tell", "useDone", "portalIn", "portalOut", "teleportArrived"];

const msg = (e) => (e && e.message ? e.message : String(e));

function makeLog(log, now) {
  const base = typeof log === "function" ? log : (m) => console.log(`[vt:nav] ${m}`);
  const seen = new Map();
  return (m0) => {
    const m = String(m0);
    const t = now();
    const prev = seen.get(m);
    if (prev !== undefined && t - prev < 10_000) return;
    seen.set(m, t);
    if (seen.size > 256) seen.delete(seen.keys().next().value);
    try {
      base(m);
    } catch (_) {
      /* a logger must never throw into nav */
    }
  };
}

const boolArg = (v) => (v === true || v === "true" ? true : v === false || v === "false" ? false : undefined);

export class ActiveNav {
  constructor({
    host = null,
    router = null,
    bot = null,
    options = null,
    profiles = null,
    state = null,
    subscribe = null,
    runChat = null,
    gotoCompose = null,
    onNpcTell = null,
    onReversed = null,
    onResult = null,
    log,
    now = Date.now,
    print = null,
  } = {}) {
    this.host = host;
    this.router = router;
    this.bot = bot;
    this.options = options;
    this.profiles = profiles;
    this.runChat = typeof runChat === "function" ? runChat : null;
    this.gotoCompose = gotoCompose;
    this.onNpcTell = typeof onNpcTell === "function" ? onNpcTell : null;
    // Meta-visible nav state (PLAN R22 / R9, review guide-3): INT-2 stores
    // them as the session vars `navreversed` (1/0) and `navlastresult`
    // ("DONE:<type>", "WARN:…", "SKIPPED:0:stuck", "FAILED:<type>:<reason>").
    this.onReversed = typeof onReversed === "function" ? onReversed : null;
    this.onResult = typeof onResult === "function" ? onResult : null;
    this.now = typeof now === "function" ? now : Date.now;
    this.log = makeLog(log, () => this.now());
    this._print = typeof print === "function" ? print : null;

    const st = state && typeof state === "object" ? state : {};
    this.state = st;
    if (!st.route || typeof st.route !== "object" || !Array.isArray(st.route.points)) st.route = makeRoute();
    if (!Number.isInteger(st.generation)) st.generation = 0;
    if (st.lastResult === undefined) st.lastResult = null;
    if (!Number.isInteger(st.stuckSkips)) st.stuckSkips = 0;
    if (st.lastChatAt === undefined) st.lastChatAt = null;
    if (!st.follow || typeof st.follow !== "object") st.follow = { moving: false, lastIssueAt: 0 };
    if (st.exec === undefined) st.exec = null;

    this._exec = null;
    this._issuedLeg = null;
    this._disposed = false;
    this._yieldedTo = null;
    this._extTeleport = false;
    this._lastTick = null;
    this._followRelease = null;
    this._followLabel = null;
    this._jumpReq = null;
    this._jumpJob = null;
    this._jumpRelease = null;
    // A Point/Jump executor's attemptJumpLeg job still in flight when that
    // executor was reset (pause/resume/setActive/route edit): it cannot be
    // cancelled and keeps driving input, so no new executor runs and no
    // `/rs jump` starts until it settles (review runtime-2).
    this._orphanJob = null;

    this.signalsLatest = { vendorOpen: null, tell: null, useDone: null, portalIn: null, portalOut: null, teleportArrived: null };
    this._unsubs = [];
    if (typeof subscribe === "function") {
      for (const type of SIGNAL_TYPES) {
        try {
          const u = subscribe(type, (sig) => this._onSignal(type, sig));
          if (typeof u === "function") this._unsubs.push(u);
        } catch (e) {
          this.log(`subscribe(${type}) failed: ${msg(e)}`);
        }
      }
    }

    const self = this;
    /** AuxSlot "Navigate" (PLAN §3.8 / §3.13). */
    this.slot = {
      name: "Navigate",
      rank: () => self._rank(),
      enabled: () => self.enabled && self.hasRoute() && !self.paused,
      wants: (ctx) => self._wants(ctx),
      pinned: () => self._pinned(),
      tick: (ctx) => self._tick(ctx),
      onLeave: (next) => self.yield(next),
      keepsCombatLoop: false,
      get status() {
        return self.status();
      },
    };
    /** AuxSlot "JumpNow" (rank afterUnwedge, pinned only): the `/rs jump` queue. */
    this.jumpSlot = {
      name: "JumpNow",
      rank: "afterUnwedge",
      enabled: () => self._jumpPending(),
      wants: () => self._jumpPending(),
      pinned: () => self._jumpPending(),
      tick: () => self._tickJump(),
      onLeave: (next) => self._onJumpLeave(next),
      keepsCombatLoop: false,
      get status() {
        return self._jumpReq ? { queuedAt: self._jumpReq.at, running: !!self._jumpJob } : null;
      },
    };
  }

  // ── option reads ────────────────────────────────────────────────────────
  _opt(key, dflt) {
    try {
      const v = this.options && typeof this.options.getValue === "function" ? this.options.getValue(key) : undefined;
      return v === undefined || v === null ? dflt : v;
    } catch (_) {
      return dflt;
    }
  }
  /** Leg arrival radius: max(1.5, FollowNavMin) metres (D16). */
  arriveM() {
    const v = Number(this._opt("FollowNavMin", 3));
    return Math.max(NAV_TUNING.minArriveM, Number.isFinite(v) ? v : 3);
  }
  _postPortalDelayMs() {
    const v = Number(this._opt("PostPortalDelaySec", 4));
    return Math.max(0, Number.isFinite(v) ? v : 4) * 1000;
  }
  _rank() {
    if (!this._opt("BoostNavPriority", false)) return "beforeIdle";
    return this._opt("BoostNavStrict", false) ? "beforeCombatPinned" : "beforeCombat";
  }

  // ── enabled / paused ────────────────────────────────────────────────────
  get enabled() {
    if (this.options && typeof this.options.getValue === "function") return this._opt("EnableNavigation", false) === true;
    return this.state.enabledLocal === true;
  }
  set enabled(v) {
    this.setEnabled(v);
  }
  /** EnableNavigation through the settings authority (operator_stop setEnabled path). */
  setEnabled(on) {
    const v = !!on;
    let r = { ok: true };
    try {
      if (this.options && typeof this.options.set === "function") r = this.options.set("EnableNavigation", v, { source: "ui" }) || { ok: true };
      else this.state.enabledLocal = v;
    } catch (e) {
      r = { ok: false, error: msg(e) };
    }
    if (!v) this.yield("disabled");
    return r && r.ok === false ? { ok: false, error: r.error || "could not set EnableNavigation" } : { ok: true, enabled: v };
  }
  get paused() {
    return this.state.route.paused || null;
  }
  /** Clear `paused` (nav start, HUD Nav on). The waypoint is retried fresh. */
  resume() {
    if (this.state.route.paused) {
      this.state.route = { ...this.state.route, paused: null };
      this._resetExec();
    }
    return { ok: true };
  }
  /** Pause navigation (OperatorControl.cancelTravel → "operator cancel", critic B1). */
  pause(reason) {
    const why = reason == null || reason === "" ? "paused" : String(reason);
    this.state.route = { ...this.state.route, paused: { reason: why, at: this.now() } };
    this.yield(why);
    this._resetExec();
    return { ok: true };
  }
  get generation() {
    return this.state.generation;
  }

  // ── reads ───────────────────────────────────────────────────────────────
  hasRoute() {
    return !routeIsEmpty(this.state.route);
  }
  route() {
    return cloneRoute(this.state.route);
  }
  isEmpty() {
    return routeIsEmpty(this.state.route);
  }
  minDistToAnyPointM() {
    return minDistM(this.state.route, posWorld(this._pose()));
  }
  status() {
    const r = this.state.route;
    let exec = this._exec ? safeLabel(this._exec) : null;
    if (!exec && r.routeType === ROUTE.Follow) exec = this._followLabel;
    return {
      name: r.name,
      type: r.routeType,
      typeName: ROUTE_NAMES[r.routeType],
      i: r.activeIndex,
      n: r.points.length,
      exec,
      lastResult: this.state.lastResult,
      reversed: !!r.reversed,
      followTarget: r.followTarget ? { ...r.followTarget } : null,
      enabled: this.enabled,
      paused: r.paused ? { ...r.paused } : null,
      blockedBy: this._blockedBy(),
      finished: !!r.finished,
      dirty: !!r.dirty,
      generation: this.state.generation,
    };
  }
  _blockedBy() {
    const r = this.state.route;
    if (!this.enabled) return "disabled";
    if (routeIsEmpty(r)) return r.finished ? "route finished" : "empty route";
    if (r.paused) return `paused: ${r.paused.reason}`;
    if (portalSpaceActive(this.host)) return "portal space";
    if (this.bot && this.bot.kernel && this.bot.kernel.operatorHeld === true) return "operator hold";
    if (this._orphanBusy()) return "a previous jump is still landing";
    if (this._yieldedTo) return `yielded to ${this._yieldedTo}`;
    return null;
  }

  // ── route edits ─────────────────────────────────────────────────────────
  _replaceRoute(r) {
    this._cancelLeg();
    this._stopFollow();
    this._resetExec();
    const wasReversed = !!(this.state.route && this.state.route.reversed);
    this.state.route = r;
    if (!!r.reversed !== wasReversed) this._notify(this.onReversed, !!r.reversed);
    this.state.generation += 1;
    this.state.stuckSkips = 0;
    this.state.follow = { moving: false, lastIssueAt: 0 };
    this._extTeleport = false;
  }

  /** Load a route (RouteState / NavProfile / {routeType, points, followTarget}).
   *  Synchronous; start index per route type; reversed = false; resets the
   *  executor; never changes EnableNavigation (G:304-306). */
  load(routeLike, { name = null, source = "ui" } = {}) {
    try {
      if (!routeLike || typeof routeLike !== "object") return { ok: false, warnings: [], error: "nothing to load" };
      const warnings = [];
      const pts = Array.isArray(routeLike.points) ? routeLike.points : [];
      const r = makeRoute({
        name: name ?? (typeof routeLike.name === "string" ? routeLike.name : null),
        routeType: routeLike.routeType,
        points: pts,
        followTarget: routeLike.followTarget,
      });
      if (r.points.length < pts.length) warnings.push(`${pts.length - r.points.length} waypoint(s) of unknown type dropped`);
      r.activeIndex = startIndex(r, posWorld(this._pose()));
      this._replaceRoute(r);
      this.log(
        `loaded ${r.name ? `"${r.name}"` : "route"} (${ROUTE_NAMES[r.routeType]}, ${r.points.length} points${
          r.followTarget ? `, following ${r.followTarget.name || r.followTarget.guid}` : ""
        }) at waypoint ${r.points.length ? r.activeIndex + 1 : 0} [${source}]`,
      );
      return { ok: true, warnings };
    } catch (e) {
      return { ok: false, warnings: [], error: msg(e) };
    }
  }

  /** `/rs nav load <name>` — synchronous; updates the profile ref "navProfile". */
  loadByName(name) {
    const v = validateNavName(name);
    if (!v.ok) return { ok: false, error: v.error };
    if (!this.profiles || typeof this.profiles.get !== "function") return { ok: false, error: "no nav profile store" };
    let p = null;
    try {
      p = this.profiles.get(v.name);
    } catch (_) {
      p = null;
    }
    if (!p) return { ok: false, error: `no nav profile named "${v.name}"` };
    const nm = p.name || v.name;
    const r = this.load(p, { name: nm, source: "profile" });
    if (!r.ok) return r;
    try {
      this.options?.setRef?.("navProfile", nm, { source: "ui" });
    } catch (_) {
      /* the ref is a convenience; the load stands */
    }
    return { ok: true, warnings: r.warnings };
  }

  /** Meta "Load Embedded Navroute": an EMPTY route clears the active nav. */
  loadEmbedded(tag, metaNav) {
    try {
      if (!metaNav || typeof metaNav !== "object") return { ok: false, error: `no embedded nav "${tag}"` };
      const text = typeof metaNav.navText === "string" ? metaNav.navText : "";
      const display = metaNav.displayName || (tag != null ? String(tag) : null);
      if (!text.trim()) {
        this.clear();
        this.state.route = { ...this.state.route, name: display, dirty: false };
        return { ok: true, warnings: [] };
      }
      const p = parseNavVt(text);
      if (!p.ok) return { ok: false, error: p.error, warnings: p.warnings };
      let route = p.route;
      const ft = normalizeFollowTarget(metaNav.followTarget);
      if (ft) route = { ...route, routeType: ROUTE.Follow, followTarget: ft };
      const r = this.load(route, { name: display, source: "meta" });
      return r.ok ? { ok: true, warnings: [...p.warnings, ...r.warnings] } : r;
    } catch (e) {
      return { ok: false, error: msg(e) };
    }
  }

  /** Clear Route: no points, same route type. */
  clear() {
    const r = makeRoute({ routeType: this.state.route.routeType });
    r.dirty = true;
    this._replaceRoute(r);
    return { ok: true };
  }

  /** `/rs nav save <name>` — overwrite; saves the on-screen order and clears `reversed` (Q4). */
  save(name) {
    const v = validateNavName(name);
    if (!v.ok) return { ok: false, error: v.error };
    if (!this.profiles || typeof this.profiles.put !== "function") return { ok: false, error: "no nav profile store" };
    let r;
    try {
      r = this.profiles.put(v.name, this.state.route);
    } catch (e) {
      r = { ok: false, error: msg(e) };
    }
    if (!r || r.ok === false) return { ok: false, error: (r && r.error) || "save failed" };
    // Saving stores the on-screen order and clears the flag (Q4); tell the meta var like a load does.
    const wasReversed = !!this.state.route.reversed;
    this.state.route = { ...this.state.route, name: v.name, dirty: false, reversed: false };
    if (wasReversed) this._notify(this.onReversed, false);
    try {
      this.options?.setRef?.("navProfile", v.name, { source: "ui" });
    } catch (_) {
      /* convenience only */
    }
    return { ok: true };
  }

  /** Insert a waypoint (End / Above / Below the selected row). → index, or -1 if invalid. */
  add(point, opts = {}) {
    try {
      const { mode = "end", selected = null } = opts || {};
      const p = normalizePoint(point);
      if (!p) return -1;
      const { route, index } = routeInsert(this.state.route, p, mode, selected);
      this.state.route = route;
      this.state.generation += 1;
      return index;
    } catch (e) {
      this.log(`add threw: ${msg(e)}`);
      return -1;
    }
  }

  /**
   * Add a waypoint at the LIVE pose (Route tab "Add …", `/rs addnav*`).
   * fields: type 0 {targetGuid?} (a selected portal ⇒ Portal/NPC point);
   * 1 {guid|targetGuid}; 2 {spellId}; 3 {pauseMs|seconds}; 4 {chat|text};
   * 5 {vendorId|guid|targetGuid, name?}; 6/7 {guid|targetGuid, name?, objectClass?};
   * 9 {headingDeg?, holdShift?, delayMs?, direction?}; any {ew, ns, z} override.
   * In a Follow route, "Add" with a target sets the follow target (G:199).
   */
  addHere(type, fields = {}, opts = {}) {
    try {
      const { mode = "end", selected = null } = opts || {};
      const f = fields && typeof fields === "object" ? fields : {};
      const t = Number(type);
      const target = Number(f.guid ?? f.targetGuid ?? 0) >>> 0;
      if (this.state.route.routeType === ROUTE.Follow && (t === POINT.Point || !Number.isFinite(t))) {
        if (!target) return { ok: false, error: "select a player to follow" };
        const name = (typeof f.name === "string" && f.name) || this._objName(target) || "";
        this.setFollowTarget({ guid: target, name });
        return { ok: true, follow: { guid: target, name } };
      }
      if (!Number.isInteger(t) || t < 0 || t > 9) return { ok: false, error: `unknown waypoint type ${type}` };
      const pose = this._pose();
      const here = pose ? legToNavPoint(pose.objCellId >>> 0, pose.x, pose.y, pose.z) : null;
      const ew = Number.isFinite(Number(f.ew)) && f.ew !== null && f.ew !== "" ? Number(f.ew) : here ? here.ew : null;
      const ns = Number.isFinite(Number(f.ns)) && f.ns !== null && f.ns !== "" ? Number(f.ns) : here ? here.ns : null;
      const z = Number.isFinite(Number(f.z)) && f.z !== null && f.z !== "" ? Number(f.z) : here ? here.navZ : 0;
      if (ew === null || ns === null) return { ok: false, error: "no player pose" };
      let p = { type: t, ew, ns, z, flag: "0" };
      const objFields = (guid, wantType) => {
        const name = (typeof f.name === "string" && f.name) || this._objName(guid) || "";
        if (!name) return { error: "the object has no name (select it first)" };
        const opos = guid ? this._objPos(guid) : null;
        const o = opos ? legToNavPoint(opos.objCellId >>> 0, opos.x, opos.y, opos.z) : null;
        let objectClass = Number.isFinite(Number(f.objectClass)) && f.objectClass !== null ? Math.trunc(Number(f.objectClass)) : null;
        if (objectClass === null) {
          const flags = guid ? this._objFlags(guid) : null;
          objectClass = wantType === POINT.NpcTalk ? 37 : flags != null && flags & ODF_PORTAL ? 14 : flags != null && flags & ODF_VENDOR ? 12 : 37;
        }
        return { name, objectClass, isTie: false, exitEW: o ? o.ew : 0, exitNS: o ? o.ns : 0, exitZ: o ? o.navZ : 0 };
      };
      switch (t) {
        case POINT.Point: {
          if (target) {
            const flags = this._objFlags(target);
            if (flags != null && flags & ODF_PORTAL) {
              const o = objFields(target, POINT.PortalNPC);
              if (o.error) return { ok: false, error: o.error };
              p = { ...p, type: POINT.PortalNPC, ...o, objectClass: 14 };
            }
          }
          break;
        }
        case POINT.PortalLegacy:
          if (!target) return { ok: false, error: "a Portal waypoint needs a portal guid" };
          p.guid = target;
          break;
        case POINT.Recall: {
          const id = Math.trunc(Number(f.spellId) || 0);
          if (id <= 0) return { ok: false, error: "a Recall waypoint needs a recall spell" };
          p.spellId = id;
          break;
        }
        case POINT.Pause: {
          const ms = f.pauseMs != null ? Number(f.pauseMs) : f.seconds != null ? Number(f.seconds) * 1000 : NaN;
          if (!Number.isFinite(ms) || ms < 0) return { ok: false, error: "a Pause waypoint needs a duration" };
          p.pauseMs = Math.round(ms);
          break;
        }
        case POINT.Chat: {
          const text = String(f.chat ?? f.text ?? "").trim();
          if (!text) return { ok: false, error: "a Chat waypoint needs text" };
          p.chat = text;
          break;
        }
        case POINT.OpenVendor: {
          const g = Number(f.vendorId ?? 0) >>> 0 || target;
          const name = (typeof f.name === "string" && f.name) || (g ? this._objName(g) : "") || "";
          if (!g && !name) return { ok: false, error: "an Open Vendor waypoint needs a vendor (select one or give a name)" };
          p.vendorId = g;
          p.name = name;
          break;
        }
        case POINT.PortalNPC:
        case POINT.NpcTalk: {
          const o = objFields(target, t);
          if (o.error) return { ok: false, error: o.error };
          p = { ...p, ...o };
          break;
        }
        case POINT.Jump: {
          let h = f.headingDeg != null && f.headingDeg !== "" ? Number(f.headingDeg) : this._compassDeg();
          if (!Number.isFinite(h)) h = 0;
          p.headingDeg = ((h % 360) + 360) % 360;
          p.holdShift = f.holdShift === true || f.holdShift === "true" || f.shift === true || f.shift === "true";
          const ms = Number(f.delayMs ?? f.ms ?? f.charge ?? 0);
          p.delayMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
          if (f.direction != null) {
            if (!JUMP_DIRECTIONS.includes(String(f.direction))) return { ok: false, error: `unknown jump direction "${f.direction}"` };
            p.ext = { direction: String(f.direction) };
          }
          break;
        }
        default:
          break; // Checkpoint (8): position only
      }
      const index = this.add(p, { mode, selected });
      return index >= 0 ? { ok: true, index } : { ok: false, error: "invalid waypoint" };
    } catch (e) {
      return { ok: false, error: msg(e) };
    }
  }

  /** Optional editor helper: patch one waypoint's fields (drops its raw .nav lines). */
  updatePoint(i, patch = {}) {
    const r = this.state.route;
    if (!Number.isInteger(i) || i < 0 || i >= r.points.length) return { ok: false, error: `no waypoint ${i}` };
    const merged = { ...r.points[i], ...(patch && typeof patch === "object" ? patch : {}) };
    delete merged.raw;
    const p = normalizePoint(merged);
    if (!p) return { ok: false, error: "invalid waypoint" };
    const points = r.points.slice();
    points[i] = p;
    if (i === r.activeIndex) {
      this._cancelLeg();
      this._resetExec();
    }
    this.state.route = { ...r, points, dirty: true };
    this.state.generation += 1;
    return { ok: true };
  }

  removeAt(i) {
    const r = this.state.route;
    const idx = Math.trunc(Number(i));
    if (!Number.isInteger(idx) || idx < 0 || idx >= r.points.length) return { ok: false, error: `no waypoint ${i}` };
    const wasActive = idx === r.activeIndex;
    if (wasActive) {
      this._cancelLeg();
      this._resetExec();
    }
    this.state.route = routeRemoveAt(r, idx);
    this.state.generation += 1;
    return { ok: true };
  }

  /** The green arrow: make waypoint `i` active (clears `paused`, resets the executor). */
  setActive(i) {
    this._cancelLeg();
    this._resetExec();
    this.state.route = { ...routeSetActive(this.state.route, i), paused: null };
    this.state.stuckSkips = 0;
    return { ok: true, index: this.state.route.activeIndex };
  }

  /** ▲/▼ on the active waypoint (wraps for Circular). */
  step(delta) {
    this._cancelLeg();
    this._resetExec();
    this.state.route = { ...routeStep(this.state.route, delta), paused: null };
    this.state.stuckSkips = 0;
    return { ok: true, index: this.state.route.activeIndex };
  }

  setType(routeType) {
    const rt = normalizeRouteType(routeType);
    this._cancelLeg();
    this._stopFollow();
    this._resetExec();
    this.state.route = { ...this.state.route, routeType: rt, linearDir: 1, finished: false, dirty: true };
    this.state.generation += 1;
    return { ok: true, routeType: rt };
  }

  /** Follow target {guid, name} (route type becomes Follow) or null. */
  setFollowTarget(target) {
    const t = normalizeFollowTarget(target);
    this._stopFollow();
    this._resetExec();
    this.state.route = {
      ...this.state.route,
      followTarget: t,
      routeType: t ? ROUTE.Follow : this.state.route.routeType,
      finished: false,
      dirty: true,
    };
    this.state.follow = { moving: false, lastIssueAt: 0 };
    this.state.generation += 1;
    return { ok: true };
  }

  /** `/rs reverseroute [true|false]` → the new `reversed`. */
  reverse(flag) {
    this.state.route = routeReverse(this.state.route, boolArg(flag));
    const v = !!this.state.route.reversed;
    this._notify(this.onReversed, v);
    return v;
  }

  /** Run a meta-visibility callback; a throwing one is logged, never fatal. */
  _notify(fn, v) {
    if (!fn) return;
    try {
      fn(v);
    } catch (e) {
      this.log(`nav callback threw: ${msg(e)}`);
    }
  }
  _setResult(text) {
    this.state.lastResult = text;
    this._notify(this.onResult, text);
  }

  // ── /rs jump ────────────────────────────────────────────────────────────
  /**
   * `/rs jump` (VTank `<heading> <shift> <ms>` / UB forms, parsed by CMD).
   * Refused while operator-held, in portal space, or — with the kernel not
   * running — while another mover owns the body (critic B10).
   */
  requestJump(args = {}) {
    try {
      const { headingDeg = null, shift = false, ms = 0, direction = "none" } = args || {};
      const kernel = this.bot && this.bot.kernel;
      if (kernel && kernel.operatorHeld === true) return { ok: false, error: "the bot is held by the operator" };
      if (portalSpaceActive(this.host)) return { ok: false, error: "in portal space" };
      if (this._jumpBusy()) return { ok: false, error: "a jump is already in progress" };
      // A nav Jump waypoint (or the Point stuck-ladder jump) is in the air: a
      // second attemptJumpLeg would drive SetMovementInput/Jump concurrently.
      const ex = this._exec;
      if (ex && ex.pinned && (ex.type === POINT.Jump || ex.type === POINT.Point)) return { ok: false, error: "a nav jump is already in progress" };
      if (this._orphanBusy()) return { ok: false, error: "a nav jump is already in progress" };
      const gc = this.gotoCompose;
      if (!gc || typeof gc.attemptJumpLeg !== "function") return { ok: false, error: "jump primitive unavailable" };
      let h = headingDeg === null || headingDeg === undefined || headingDeg === "" ? this._compassDeg() : Number(headingDeg);
      if (headingDeg === null || headingDeg === undefined || headingDeg === "") {
        if (!Number.isFinite(h)) h = 0;
      } else if (!Number.isFinite(h) || h < 0 || h >= 360) {
        return { ok: false, error: "heading must be in [0, 360)" };
      }
      const charge = Number(ms ?? 0);
      if (!Number.isFinite(charge) || charge < 0 || charge > 1000) return { ok: false, error: "charge must be 0-1000 ms" };
      const dir = String(direction ?? "none");
      if (!JUMP_DIRECTIONS.includes(dir)) return { ok: false, error: `unknown jump direction "${direction}"` };
      const req = { ...jumpArgs(gc, { headingDeg: h, holdShift: !!shift, delayMs: charge, direction: dir }), at: this.now() };
      if (kernel && kernel.running === true) {
        this._jumpReq = req;
        return { ok: true, queued: true };
      }
      let claimed = false;
      try {
        claimed = typeof this.bot?.movementClaimed === "function" && this.bot.movementClaimed() === true;
      } catch (_) {
        claimed = false;
      }
      if (claimed) return { ok: false, error: "another mover owns the character (goto/route/travel in progress)" };
      try {
        this._jumpRelease = typeof this.bot?.claimMovement === "function" ? this.bot.claimMovement("rs-jump") : null;
      } catch (_) {
        this._jumpRelease = null;
      }
      this._jumpReq = req;
      this._startJump(req);
      return { ok: true, queued: false };
    } catch (e) {
      return { ok: false, error: msg(e) };
    }
  }

  _startJump(req) {
    const gc = this.gotoCompose;
    this._cancelLeg();
    this._jumpJob = runJob(() => gc.attemptJumpLeg({ host: this.host }, req.leg, req.tune));
    this._jumpJob.promise.then(() => this._reapJump());
  }
  _reapJump() {
    const job = this._jumpJob;
    if (!job || !job.settled) return;
    const r = job.result || {};
    this.log(r.ok ? "jump done" : `jump failed: ${r.error || "?"}`);
    this.state.lastJump = { ok: !!r.ok, error: r.ok ? null : r.error || "jump failed", at: this.now() };
    this._jumpJob = null;
    this._jumpReq = null;
    if (this._jumpRelease) {
      try {
        this._jumpRelease();
      } catch (_) {
        /* idempotent */
      }
      this._jumpRelease = null;
    }
  }
  _jumpBusy() {
    this._reapJump();
    return !!this._jumpReq;
  }
  _jumpPending() {
    this._reapJump();
    return !!this._jumpReq && !this._disposed;
  }
  _tickJump() {
    try {
      this._reapJump();
      const req = this._jumpReq;
      if (!req || this._jumpJob) return;
      if (this.now() - req.at > JUMP_QUEUE_MAX_MS) {
        this.log("queued jump dropped (stale)");
        this._jumpReq = null;
        return;
      }
      if (portalSpaceActive(this.host)) return;
      this._startJump(req);
    } catch (e) {
      this.log(`jump tick threw: ${msg(e)}`);
    }
  }
  _onJumpLeave(next) {
    if (this._jumpReq && !this._jumpJob) {
      this._jumpReq = null;
      this.log(`queued jump dropped (${next})`);
    }
  }

  // ── router ownership ────────────────────────────────────────────────────
  _legState(leg) {
    const r = this.router;
    if (!leg || !r) return null;
    const r0 = Array.isArray(r.route) ? r.route[0] : undefined;
    if (r0 !== leg) return null;
    try {
      return (r.status && r.status.state) || r.state || null;
    } catch (_) {
      return r.state || null;
    }
  }
  _issueLeg(leg) {
    this._issuedLeg = leg;
    try {
      this.router?.follow?.([leg]);
    } catch (e) {
      this.log(`router.follow threw: ${msg(e)}`);
    }
  }
  _cancelLeg(leg) {
    const target = leg || this._issuedLeg;
    const s = this._legState(target);
    if (s === "WALK" || s === "PORTAL") {
      try {
        this.router.cancel();
      } catch (_) {
        /* best-effort */
      }
    }
  }
  /** True while the router is walking (WALK/PORTAL) the leg ActiveNav issued. */
  ownsRouterWalk() {
    const s = this._legState(this._issuedLeg);
    return s === "WALK" || s === "PORTAL";
  }
  /** Leave the slot: cancel OUR router leg only, keep the index + executor memory.
   *  The executor's budget clock stops until it next runs (_resumeClock). */
  yield(reason) {
    try {
      this._yieldedTo = reason == null ? "other" : String(reason);
      const mem = this.state.exec && this.state.exec.mem;
      if (mem && typeof mem === "object" && !Number.isFinite(mem.awayAt)) mem.awayAt = this.now();
      if (this._exec) {
        try {
          this._exec.cancel();
        } catch (_) {
          /* executor cleanup is best-effort */
        }
      }
      this._cancelLeg();
      this._stopFollow();
    } catch (e) {
      this.log(`yield threw: ${msg(e)}`);
    }
  }

  dispose() {
    if (this._disposed) return;
    this.yield("dispose");
    this._exec = null;
    this._disposed = true;
    if (this._jumpReq && !this._jumpJob) this._jumpReq = null;
    for (const u of this._unsubs) {
      try {
        u();
      } catch (_) {
        /* listener already gone */
      }
    }
    this._unsubs = [];
  }

  // ── kernel slot ─────────────────────────────────────────────────────────
  _pinned() {
    // A disabled/paused slot never reads pinned (a recall cast before
    // `nav stop` must not keep the kernel on a slot that will not tick).
    return !!((this._exec && this._exec.pinned) || this._orphanBusy()) && this.slot.enabled();
  }
  /** True while a reset executor's jump job is still in the air. */
  _orphanBusy() {
    const j = this._orphanJob;
    if (j && !j.settled) return true;
    this._orphanJob = null;
    return false;
  }
  /** Keep an executor's unsettled jump job before the executor is dropped. */
  _keepOrphan(ex) {
    const j = ex && ex.job;
    if (j && !j.settled) this._orphanJob = j;
  }
  _wants(ctx) {
    if (this._disposed || !this.slot.enabled()) return false;
    if (this._pinned()) return true;
    if (portalSpaceActive(this.host)) return false;
    const rank = this._rank();
    const c = ctx || {};
    // D39: boost outranks attacking and looting, never buffing. "Looting"
    // means a corpse not yet started: a loot transaction already in flight
    // (lootPinned: APPROACH/OPEN/LOOT) finishes first, bounded by its own
    // approach/open/pickup limits — taking the tick from it would freeze
    // loot.state, which movementClaimed / the unwedge reflex / doFollowRoute
    // read as live (review regress-1).
    if (rank !== "beforeIdle" && (c.buffPinned || c.buffNeeded || c.lootPinned)) return false;
    // Gentle boost fights back: under attack it declines only when the ladder
    // below has a fight (or the after-kill corpse) to run — with nothing to
    // fight it keeps walking instead of falling through to Idle (logic-2).
    if (rank === "beforeCombat" && c.underAttack && (c.threat || c.corpse)) return false;
    return true;
  }
  _tick(ctx) {
    if (this._disposed) return;
    try {
      this._tickInner(ctx);
    } catch (e) {
      this.log(`nav tick threw: ${msg(e)}`);
    }
  }
  _tickInner() {
    const st = this.state;
    const now = this.now();
    this._yieldedTo = null;
    if (!this.enabled || st.route.paused || routeIsEmpty(st.route)) return;
    if (portalSpaceActive(this.host) && !this._pinned()) {
      // The router holds our leg itself; a follow pursuit stops.
      this._stopFollow();
      this._lastTick = null;
      return;
    }
    // A reset executor's jump is still driving input: the new executor (a
    // re-tried jump, a router leg, a cast) waits until it lands.
    if (this._orphanBusy()) return;
    this._detectTeleport(now);
    if (st.route.routeType === ROUTE.Follow) {
      this._tickFollow(now);
      return;
    }
    const exec = this._ensureExec();
    if (!exec) return;
    this._resumeClock(now);
    const gen = st.generation;
    let res;
    try {
      res = exec.step(now);
    } catch (e) {
      exec.failReason = `executor threw: ${msg(e)}`;
      res = "failed";
    }
    // A step that reloaded/edited the route (a Chat point running `/rs nav
    // load x`) must not advance the NEW route (critic C11).
    const active = st.route.points[st.route.activeIndex];
    if (st.generation !== gen || this._exec !== exec || active !== exec.point) return;
    if (res === "done") this._onDone(exec);
    else if (res === "failed") this._onFailed(exec, now);
  }

  _ensureExec() {
    const st = this.state;
    const p = st.route.points[st.route.activeIndex];
    if (!p) return null;
    if (this._exec && this._exec.point === p) return this._exec;
    if (this._exec) {
      this._keepOrphan(this._exec);
      try {
        this._exec.cancel();
      } catch (_) {
        /* best-effort */
      }
    }
    let mem;
    if (st.exec && st.exec.point === p && st.exec.mem && typeof st.exec.mem === "object") mem = st.exec.mem;
    else {
      mem = {};
      st.exec = { point: p, mem };
    }
    this._exec = makeExecutor(p, this._execCtx(mem));
    return this._exec;
  }
  /** The active waypoint runs again after a yield (combat, buffing, an
   *  operator hold, portal space, a rebind): the time away does not count
   *  toward its budgets (executors.js BUDGET_ANCHORS). Deadlines are kept,
   *  not restarted; signal/teleport anchors (tele.at, armedAt) stay real. */
  _resumeClock(now) {
    const mem = this.state.exec && this.state.exec.mem;
    if (!mem || typeof mem !== "object" || !Number.isFinite(mem.awayAt)) return;
    const away = now - mem.awayAt;
    delete mem.awayAt;
    if (!(away > 0)) return;
    for (const k of BUDGET_ANCHORS) if (Number.isFinite(mem[k])) mem[k] += away;
  }
  _resetExec() {
    if (this._exec) {
      this._keepOrphan(this._exec);
      try {
        this._exec.cancel();
      } catch (_) {
        /* best-effort */
      }
    }
    this._exec = null;
    this.state.exec = null;
  }
  _execCtx(mem) {
    const self = this;
    return {
      host: this.host,
      router: this.router,
      bot: this.bot,
      options: this.options,
      runChat: this.runChat,
      gotoCompose: this.gotoCompose,
      onNpcTell: this.onNpcTell,
      signalsLatest: this.signalsLatest,
      log: this.log,
      mem,
      now: () => self.now(),
      pose: () => self._pose(),
      inPortalSpace: () => portalSpaceActive(self.host),
      arriveM: () => self.arriveM(),
      postPortalDelayMs: () => self._postPortalDelayMs(),
      issueLeg: (leg) => self._issueLeg(leg),
      legState: (leg) => self._legState(leg),
      cancelLeg: (leg) => self._cancelLeg(leg),
      ownsRouterWalk: () => self.ownsRouterWalk(),
      claimMovement: (tag) => {
        try {
          return typeof self.bot?.claimMovement === "function" ? self.bot.claimMovement(tag) : null;
        } catch (_) {
          return null;
        }
      },
      lastChatAt: () => self.state.lastChatAt,
      setLastChatAt: (t) => {
        self.state.lastChatAt = t;
      },
      spellName: (id) => self._spellName(id),
    };
  }

  _onDone(exec) {
    const st = this.state;
    this._setResult(exec.warning ? `WARN:${exec.type}:${exec.warning}` : `DONE:${exec.type}`);
    if (exec.warning) this.log(`nav: ${POINT_NAMES[exec.type]} waypoint: ${exec.warning}`);
    st.stuckSkips = 0;
    this._advanceRoute();
  }
  _advanceRoute() {
    const st = this.state;
    this._resetExec();
    let r = routeAdvance(st.route);
    r = skipDense(r, posWorld(this._pose()), this.arriveM()).route;
    st.route = r;
    if (r.finished) this.log(`route ${r.name ? `"${r.name}" ` : ""}finished (navigation stays enabled)`);
  }
  _onFailed(exec, now) {
    const st = this.state;
    const r = st.route;
    const reason = exec.failReason || "failed";
    const where = `waypoint ${r.activeIndex + 1}/${r.points.length}`;
    if (
      exec.type === POINT.Point &&
      reason === "stuck" &&
      (r.routeType === ROUTE.Circular || r.routeType === ROUTE.Linear) &&
      r.points.length > 1 &&
      st.stuckSkips < MAX_STUCK_SKIPS
    ) {
      st.stuckSkips += 1;
      this._setResult("SKIPPED:0:stuck");
      this._alert(`nav: stuck at ${where} — skipping to the next waypoint`);
      this._cancelLeg();
      this._advanceRoute();
      return;
    }
    this._setResult(`FAILED:${exec.type}:${reason}`);
    this._resetExec();
    this._cancelLeg();
    st.route = { ...st.route, paused: { reason, at: now } };
    this._alert(`nav: ${POINT_NAMES[exec.type] || "waypoint"} ${where} failed (${reason}) — navigation paused`);
  }

  // External teleport (a portal walked into, a server move, a recall someone
  // else cast): Circular/Linear re-sync to the nearest Point; Once holds.
  _detectTeleport(now) {
    const pose = this._pose();
    const w = posWorld(pose);
    const prev = this._lastTick;
    if (w) this._lastTick = { wx: w.wx, wy: w.wy, at: now };
    let ext = this._extTeleport;
    if (!ext && prev && w && now - prev.at <= EXTERNAL_TELEPORT_TICK_GAP_MS) {
      ext = Math.hypot(w.wx - prev.wx, w.wy - prev.wy) >= NAV_TUNING.teleportJumpM;
    }
    if (!ext) return;
    if (!w) return; // keep the flag until a pose exists
    this._extTeleport = false;
    if (this._teleportExpected()) return;
    const r = this.state.route;
    if (r.routeType !== ROUTE.Circular && r.routeType !== ROUTE.Linear) {
      this.log(`external teleport: ${ROUTE_NAMES[r.routeType] || "the"} route holds its ${r.routeType === ROUTE.Follow ? "target" : "waypoint"}`);
      return;
    }
    const i = nearestPointIndex(r, w);
    if (i >= 0 && i !== r.activeIndex) {
      this._cancelLeg();
      this._resetExec();
      this.state.route = { ...r, activeIndex: i };
      this.log(`external teleport: re-synced to waypoint ${i + 1}/${r.points.length}`);
    }
  }
  _teleportExpected() {
    return !!(this._exec && this._exec.expectsTeleport) || !!this._jumpJob || this._orphanBusy();
  }

  _onSignal(type, sig) {
    if (this._disposed || !sig) return;
    const at = this.now();
    switch (type) {
      case "vendorOpen":
        this.signalsLatest.vendorOpen = { guid: Number(sig.guid) >>> 0, name: sig.name || "", at };
        break;
      case "tell":
        if (sig.isSelf) return;
        this.signalsLatest.tell = { name: String(sig.name || ""), text: String(sig.text || ""), at };
        break;
      case "useDone":
        this.signalsLatest.useDone = { at };
        break;
      case "portalOut":
        this.signalsLatest.portalOut = { at };
        break;
      case "portalIn":
      case "teleportArrived":
        this.signalsLatest[type] = { at };
        if (!this._teleportExpected() && this.enabled && this.hasRoute()) this._extTeleport = true;
        break;
      default:
        break;
    }
  }

  // ── Follow (route type 3): PursueObject > 8 m, stop < 5 m ───────────────
  _tickFollow(now) {
    const h = this.host;
    const t = this.state.route.followTarget;
    const f = this.state.follow;
    const guid = this._followGuid(t);
    const tpos = guid ? this._objPos(guid) : null;
    const pw = posWorld(this._pose());
    const tw = posWorld(tpos);
    const who = (t && t.name) || (guid ? `0x${guid.toString(16)}` : "?");
    if (!tw || !pw) {
      if (f.moving) this._stopFollow(true);
      this._followLabel = "follow target out of range";
      return;
    }
    const d = Math.hypot(tw.wx - pw.wx, tw.wy - pw.wy);
    if (f.moving) {
      if (!this._followRelease) this._followRelease = this._claim("vt-nav-follow");
      if (d < FOLLOW_STOP_M) {
        this._stopFollow(true);
        this._followLabel = `following ${who}: holding (${d.toFixed(1)} m)`;
        return;
      }
      if (now - (f.lastIssueAt || 0) >= FOLLOW_REISSUE_MS) {
        f.lastIssueAt = now;
        let active = false;
        try {
          const ps = typeof h?.GetPursuitStatus === "function" ? h.GetPursuitStatus() : null;
          active = !!ps && ((Number(ps.now) || 0) & 0xffff) === 1;
        } catch (_) {
          active = false;
        }
        if (!active) this._moveTo(tpos);
      }
      this._followLabel = `following ${who}: ${d.toFixed(1)} m`;
      return;
    }
    if (d > FOLLOW_START_M) {
      this._cancelLeg();
      let sent = false;
      try {
        if (typeof h?.PursueObject === "function") sent = h.PursueObject(guid) !== false;
      } catch (_) {
        sent = false;
      }
      if (!sent) this._moveTo(tpos);
      f.moving = true;
      f.lastIssueAt = now;
      if (!this._followRelease) this._followRelease = this._claim("vt-nav-follow");
      this._followLabel = `following ${who}: ${d.toFixed(1)} m`;
      return;
    }
    this._followLabel = `following ${who}: holding (${d.toFixed(1)} m)`;
  }
  _followGuid(t) {
    if (!t) return 0;
    if (t.guid && this._objPos(t.guid)) return t.guid >>> 0;
    if (t.name) {
      try {
        const hits = typeof this.host?.FindNearbyByName === "function" ? this.host.FindNearbyByName(t.name, { player: true }) : null;
        if (Array.isArray(hits) && hits.length && hits[0].guid) return hits[0].guid >>> 0;
      } catch (_) {
        /* fall through */
      }
    }
    return t.guid >>> 0;
  }
  _moveTo(pos) {
    try {
      this.host?.MoveToPosition?.(pos.objCellId >>> 0, pos.x, pos.y, pos.z, true);
    } catch (_) {
      /* the next issue retries */
    }
  }
  _stopFollow(stopBody = true) {
    const f = this.state.follow;
    if (f && f.moving) {
      f.moving = false;
      if (stopBody) {
        try {
          this.host?.StopCompletely?.();
        } catch (_) {
          /* best-effort */
        }
      }
    }
    if (this._followRelease) {
      try {
        this._followRelease();
      } catch (_) {
        /* idempotent */
      }
      this._followRelease = null;
    }
  }

  // ── host reads ──────────────────────────────────────────────────────────
  _pose() {
    try {
      return this.host && typeof this.host.TryGetPlayerPose === "function" ? this.host.TryGetPlayerPose() : null;
    } catch (_) {
      return null;
    }
  }
  _objPos(guid) {
    try {
      return this.host?.TryGetObjectPosition?.(guid >>> 0) || null;
    } catch (_) {
      return null;
    }
  }
  _objName(guid) {
    try {
      return this.host?.TryGetObjectName?.(guid >>> 0) || null;
    } catch (_) {
      return null;
    }
  }
  _objFlags(guid) {
    try {
      const f = this.host?.TryGetObjectDescFlags?.(guid >>> 0);
      return typeof f === "number" ? f >>> 0 : null;
    } catch (_) {
      return null;
    }
  }
  _compassDeg() {
    try {
      const d = this.host?.TryGetPlayerCompassHeadingDeg?.();
      if (Number.isFinite(d)) return d;
    } catch (_) {
      /* fall back to the pose */
    }
    const pose = this._pose();
    if (pose && Number.isFinite(pose.heading)) return ((((pose.heading * 180) / Math.PI) % 360) + 360) % 360;
    return NaN;
  }
  _spellName(id) {
    if (RECALL_SPELL_NAMES[id]) return RECALL_SPELL_NAMES[id];
    try {
      const rec = this.host?.TryGetSpellRecord?.(id);
      if (rec && rec.name) return rec.name;
    } catch (_) {
      /* id only */
    }
    return `spell ${id}`;
  }
  _claim(tag) {
    try {
      return typeof this.bot?.claimMovement === "function" ? this.bot.claimMovement(tag) : null;
    } catch (_) {
      return null;
    }
  }
  _alert(text) {
    this.log(text);
    const line = `[RynthSuite] ${text}`;
    try {
      if (this._print) this._print(line, 0);
      else this.host?.WriteToChatWindow?.(line);
    } catch (_) {
      /* chat surface absent */
    }
  }
}

function safeLabel(exec) {
  try {
    return exec.label;
  } catch (_) {
    return POINT_NAMES[exec.type] || null;
  }
}

export default ActiveNav;
