// RynthWebHost — the RynthCoreHost seam reimplemented over holtburger-web.
//
// This is the seam artifact from docs/rynth-integration (synthesis §2):
// RynthAi-shaped bot logic calls RynthCoreHost-named members on this class
// and cannot tell it isn't the retail plugin host. Three design rules, all
// from workflow reports 04/05/11:
//
// 1. FROZEN SNAPSHOT — per-tick polls (pose, vitals, gates) are answered
//    from `this.snap`, composed ONCE per tick in a single synchronous
//    block (JS is non-preemptive, so the block is atomic by construction —
//    RynthCore's "fresh for the whole tick" guarantee). Per-decision
//    object reads go straight through to the wasm (cheap RefCell reads).
// 2. Has* CAPABILITY SET — derived at construction by probing which
//    SessionHandle methods actually exist (a stale pkg/ or older build
//    degrades capabilities instead of throwing). Members whose backing is
//    absent return their RynthCoreHost-documented fallback.
// 3. WEB-WORKER HEARTBEAT — the tick rides a worker postMessage loop, not
//    rAF/setInterval, so a backgrounded tab keeps ticking (report 04 §5.4:
//    ?nullRender=1 does NOT escape rAF throttling).
//
// Pursuit note: `pursuitStatus()` is read-clear for completion states. The
// host latches completions into `snap.pursuitLast` — in bot pages the host
// is the sole consumer; don't run it beside the picking.js pursuit monitor.

const CAPABILITY_CANDIDATES = {
  // RynthCoreHost member -> SessionHandle method candidates (first wins).
  GetPlayerId: ["playerGuid"],
  GetServerTime: ["serverTime"],
  IsPlayerReady: ["isPlayerReady"],
  GetCurrentCombatMode: ["combatMode"],
  GetBusyState: ["getBusyState"],
  GetCastBusyState: ["getCastBusyState"],
  GetUseDoneSeq: ["getUseDoneSeq"],
  ForceResetBusyCount: ["forceResetBusyCount"],
  GetPlayerPose: ["getLocalPlayerPose"],
  GetObjectName: ["objectName"],
  GetObjectWcid: ["objectWcid"],
  GetObjectState: ["objectPhysicsState"],
  GetObjectPosition: ["objectPosition"],
  GetTargetHealthFraction: ["objectHealthFraction"],
  GetObjectIntProperty: ["objectIntProperty"],
  GetObjectQuadProperty: ["objectInt64Property"],
  GetObjectBoolProperty: ["objectBoolProperty"],
  GetObjectDoubleProperty: ["objectFloatProperty"],
  GetObjectStringProperty: ["objectStringProperty"],
  GetObjectDataIdProperty: ["objectDataIdProperty"],
  GetObjectInstanceIdProperty: ["objectInstanceIdProperty"],
  HasAppraisalData: ["hasAppraisalData"],
  GetLastIdTime: ["getLastIdTime"],
  GetGroundContainerId: ["groundContainerId"],
  GetContainerContents: ["getContainerContents", "get_container_contents"],
  GetPlayerStats: ["playerStats"],
  GetEnchantments: ["playerEnchantments", "player_enchantments"],
  MeleeAttack: ["attack"],
  ChangeCombatMode: ["setCombatMode"],
  CastSpell: ["castTargetedSpell"],
  CastUntargetedSpell: ["castUntargetedSpell"],
  UseObject: ["useObject"],
  QueryHealth: ["queryHealth"],
  MoveToPosition: ["moveToPosition"],
  PursueObject: ["pursueEntity"],
  TurnToHeading: ["turnToHeading"],
  StickToObject: ["stickToEntity"],
  StopStick: ["stopStick"],
  StopCompletely: ["cancelPursuit"],
  SetAutoRun: ["setAutoRun"],
  WriteToChat: ["sendChat"],
  InvokeChatParser: ["sendChat"],
  GetPursuitStatus: ["pursuitStatus"],
  NoteLocalCastWindow: ["noteLocalCastWindow"],
  RequestId: ["assessEntity", "identifyObject", "requestId"],
};

export class RynthWebHost {
  constructor(sessionHandle, opts = {}) {
    if (!sessionHandle) throw new Error("RynthWebHost: sessionHandle required");
    this.s = sessionHandle;
    this.entityMap = opts.entityMap || (typeof window !== "undefined" ? window.entityMap : null);
    this._m = {}; // resolved capability -> bound method
    this._caps = new Set();
    for (const [cap, candidates] of Object.entries(CAPABILITY_CANDIDATES)) {
      for (const name of candidates) {
        if (typeof sessionHandle[name] === "function") {
          this._m[cap] = sessionHandle[name].bind(sessionHandle);
          this._caps.add(cap);
          break;
        }
      }
    }
    this.snap = null; // frozen per-tick snapshot
    this._tickSeq = 0;
    this._onTick = [];
    this._worker = null;
  }

  // ── capability probes (the RynthCoreHost Has* plane) ───────────────
  has(cap) {
    return this._caps.has(cap);
  }
  get capabilities() {
    return [...this._caps].sort();
  }

  // ── tick adapter ────────────────────────────────────────────────────
  start(hz = 15) {
    this.stop();
    const ms = Math.max(16, Math.round(1000 / hz));
    const src =
      "let t=null;onmessage=(e)=>{if(e.data&&e.data.cmd==='start'){clearInterval(t);" +
      "t=setInterval(()=>postMessage(1),e.data.ms)}else{clearInterval(t)}};";
    this._worker = new Worker(
      URL.createObjectURL(new Blob([src], { type: "text/javascript" }))
    );
    this._worker.onmessage = () => this._tick();
    this._worker.postMessage({ cmd: "start", ms });
  }
  stop() {
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
  }
  onTick(fn) {
    this._onTick.push(fn);
  }

  _tick() {
    // ONE await-free synchronous block: compose + freeze + deliver.
    const c = (cap, ...args) => {
      const f = this._m[cap];
      if (!f) return undefined;
      try {
        return f(...args);
      } catch (_) {
        return undefined;
      }
    };
    const pose = c("GetPlayerPose") || null;
    const pursuitNow = c("GetPursuitStatus"); // read-clear >=2: latch below
    const prev = this.snap;
    const snap = {
      seq: ++this._tickSeq,
      tMs: Date.now(),
      serverTime: c("GetServerTime") ?? 0,
      playerGuid: c("GetPlayerId") ?? 0,
      isPlayerReady: c("IsPlayerReady") ?? false,
      combatMode: c("GetCurrentCombatMode") ?? 1,
      busy: c("GetBusyState") ?? 0,
      castBusy: c("GetCastBusyState") ?? 0,
      useDoneSeq: c("GetUseDoneSeq") ?? 0,
      groundContainerId: c("GetGroundContainerId") ?? 0,
      pose: pose
        ? {
            objCellId: pose.landblockId >>> 0,
            x: pose.x,
            y: pose.y,
            z: pose.z,
            heading: pose.heading ?? null,
          }
        : null,
      pursuitNow: pursuitNow ?? 0,
      // Latched last completion (2=arrived, 3=failed) — survives the
      // read-clear until a new pursuit overwrites it.
      pursuitLast:
        pursuitNow >= 2 ? pursuitNow : prev ? prev.pursuitLast : 0,
      nearby: this._nearbyGuids(),
    };
    Object.freeze(snap.pose);
    Object.freeze(snap.nearby);
    this.snap = Object.freeze(snap);
    for (const fn of this._onTick) {
      try {
        fn(this);
      } catch (e) {
        // A brain exception must never kill the heartbeat.
        (console.warn || console.log)("[RynthWebHost] onTick threw:", e);
      }
    }
  }

  _nearbyGuids() {
    const out = [];
    const em = this.entityMap;
    const self = this.snap ? this.snap.playerGuid : 0;
    if (em && typeof em.forEach === "function") {
      em.forEach((_v, k) => {
        const g = Number(k);
        if (g && g !== self) out.push(g);
      });
    }
    return out;
  }

  // ── RynthCoreHost members: per-tick reads (snapshot-backed) ─────────
  GetPlayerId() {
    return this.snap ? this.snap.playerGuid : 0;
  }
  GetServerTime() {
    return this.snap ? this.snap.serverTime : 0;
  }
  IsPlayerReady() {
    return this.snap ? this.snap.isPlayerReady : false;
  }
  GetCurrentCombatMode() {
    return this.snap ? this.snap.combatMode : 1;
  }
  GetBusyState() {
    return this.snap ? this.snap.busy : 0;
  }
  GetCastBusyState() {
    return this.snap ? this.snap.castBusy : 0;
  }
  get CanCastNow() {
    return this.GetCastBusyState() === 0;
  }
  GetUseDoneSeq() {
    return this.snap ? this.snap.useDoneSeq : 0;
  }
  ForceResetBusyCount() {
    const f = this._m.ForceResetBusyCount;
    if (f) f();
  }
  TryGetPlayerPose() {
    return this.snap ? this.snap.pose : null;
  }
  GetGroundContainerId() {
    return this.snap ? this.snap.groundContainerId : 0;
  }
  GetPursuitStatus() {
    return this.snap ? { now: this.snap.pursuitNow, last: this.snap.pursuitLast } : { now: 0, last: 0 };
  }
  NearbyGuids() {
    return this.snap ? this.snap.nearby : [];
  }

  // ── per-decision object reads (live; cheap RefCell reads) ──────────
  _live(cap, ...args) {
    const f = this._m[cap];
    if (!f) return undefined;
    try {
      return f(...args);
    } catch (_) {
      return undefined;
    }
  }
  TryGetObjectName(guid) {
    return this._live("GetObjectName", guid) ?? null;
  }
  TryGetObjectWcid(guid) {
    return this._live("GetObjectWcid", guid) ?? 0;
  }
  TryGetObjectState(guid) {
    return this._live("GetObjectState", guid) ?? 0;
  }
  TryGetObjectPosition(guid) {
    const v = this._live("GetObjectPosition", guid);
    if (!v || v.length !== 4) return null;
    return { objCellId: v[0] >>> 0, x: v[1], y: v[2], z: v[3] };
  }
  TryGetTargetHealthFraction(guid) {
    return this._live("GetTargetHealthFraction", guid) ?? -1;
  }
  TryGetObjectIntProperty(guid, stype) {
    return this._live("GetObjectIntProperty", guid, stype);
  }
  TryGetObjectQuadProperty(guid, stype) {
    return this._live("GetObjectQuadProperty", guid, stype);
  }
  TryGetObjectBoolProperty(guid, stype) {
    return this._live("GetObjectBoolProperty", guid, stype);
  }
  TryGetObjectDoubleProperty(guid, stype) {
    return this._live("GetObjectDoubleProperty", guid, stype);
  }
  TryGetObjectStringProperty(guid, stype) {
    return this._live("GetObjectStringProperty", guid, stype);
  }
  TryGetObjectDataIdProperty(guid, stype) {
    return this._live("GetObjectDataIdProperty", guid, stype);
  }
  /// Composed ownership read (report 14 #11): container IID 2,
  /// wielder IID 3, CurrentWieldedLocation int 10.
  TryGetObjectOwnershipInfo(guid) {
    const container = this._live("GetObjectInstanceIdProperty", guid, 2) ?? 0;
    const wielder = this._live("GetObjectInstanceIdProperty", guid, 3) ?? 0;
    const location = this._live("GetObjectIntProperty", guid, 10) ?? 0;
    return { container, wielder, location };
  }
  HasAppraisalData(guid) {
    return this._live("HasAppraisalData", guid) ?? false;
  }
  GetLastIdTime(guid) {
    return this._live("GetLastIdTime", guid) ?? 0;
  }
  GetContainerContents(guid) {
    return this._live("GetContainerContents", guid) ?? [];
  }

  // ── actions (fire-and-forget through SessionHandle) ────────────────
  _act(cap, ...args) {
    const f = this._m[cap];
    if (!f) return false;
    try {
      f(...args);
      return true;
    } catch (e) {
      (console.warn || console.log)(`[RynthWebHost] ${cap} failed:`, e);
      return false;
    }
  }
  MeleeAttack(targetGuid, attackHeight = 2, powerLevel = 0.5) {
    return this._act("MeleeAttack", targetGuid, attackHeight, powerLevel);
  }
  ChangeCombatMode(mode) {
    return this._act("ChangeCombatMode", mode);
  }
  CastSpell(targetGuid, spellId) {
    if (!targetGuid) return this._act("CastUntargetedSpell", spellId);
    return this._act("CastSpell", targetGuid, spellId);
  }
  UseObject(guid) {
    return this._act("UseObject", guid);
  }
  QueryHealth(guid) {
    return this._act("QueryHealth", guid);
  }
  MoveToPosition(objCellId, x, y, z, run = true) {
    return this._act("MoveToPosition", objCellId, x, y, z, run);
  }
  PursueObject(guid, radius = 0.6, height = 0, run = true) {
    return this._act("PursueObject", guid, radius, height, run);
  }
  TurnToHeading(headingRad) {
    return this._act("TurnToHeading", headingRad);
  }
  StickToObject(guid) {
    return this._act("StickToObject", guid);
  }
  StopStick() {
    return this._act("StopStick");
  }
  StopCompletely() {
    return this._act("StopCompletely");
  }
  SetAutoRun(on) {
    return this._act("SetAutoRun", !!on);
  }
  WriteToChat(text) {
    return this._act("WriteToChat", text);
  }
  InvokeChatParser(text) {
    return this._act("InvokeChatParser", text);
  }
  RequestId(guid) {
    return this._act("RequestId", guid);
  }
  NoteLocalCastWindow(active) {
    return this._act("NoteLocalCastWindow", !!active);
  }
}

export default RynthWebHost;
