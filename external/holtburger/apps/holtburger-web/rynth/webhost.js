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
  GiveObject: ["giveObject"],
  TakeObject: ["putItemInContainer"],
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
  // requestAppraisal is the REAL wasm method (IdentifyObject 0x00C8); the
  // legacy candidates never existed in the d.ts, so RequestId silently
  // no-opped — loot_loop's appraisal gate degraded to judge-on-timeout
  // (2026-07-18 verb audit, gap B2).
  RequestId: ["requestAppraisal", "assessEntity", "identifyObject", "requestId"],
  // appraisal READ side (EX-05): JSON AppraisalSnapshot after a successful
  // requestAppraisal (2026-07-18 verb audit, gap 1 — the LLM appraise verb).
  GetObjectAppraisal: ["getObjectAppraisal"],
  // UseWithTarget 0x0035 — keys on doors/chests, lockpicks, healing kits,
  // tinkering tools (verb audit gap 2).
  UseWithTarget: ["useWithTarget"],
  // container loot: move an item into a container (retail PutItemInContainer
  // marshal; the semantic pickup path TakeObject already rides). Kept
  // separate so container→pack loot of a SPECIFIC item is expressible
  // (verb audit gap 3).
  MoveItem: ["moveItem"],
  // stack surgery (verb audit gap 5).
  SplitStackToContainer: ["splitStackToContainer"],
  MergeStacks: ["mergeStacks"],
  // server confirm dialogs (verb audit gap 5) — an unanswered dialog times
  // out server-side as a decline.
  GetPendingConfirmations: ["pendingConfirmations"],
  SendConfirmationResponse: ["sendConfirmationResponse"],
  NearbyEntityGuids: ["nearbyEntityGuids"],
  GetObjectDescFlags: ["objectDescFlags"],
  GetFellowship: ["playerFellowship"],
  FellowshipCreate: ["fellowshipCreate"],
  FellowshipQuit: ["fellowshipQuit"],
  FellowshipRecruit: ["fellowshipRecruit"],
  // economy plane (2026-07-17): inventory awareness + vendor trade + equip.
  GetPlayerInventory: ["playerInventory"],
  GetVendorState: ["getVendorState"],
  BuyFromVendor: ["buyFromVendor"],
  SellToVendor: ["sellToVendor"],
  WieldFromPack: ["wieldFromPack"],
  UnwieldToPack: ["unwieldToPack"],
  DropItem: ["dropItem"],
  // advancement plane (2026-07-17): spend XP on attrs/vitals/skills + train.
  RaiseAttribute: ["raiseAttribute"],
  RaiseVital: ["raiseVital"],
  RaiseSkill: ["raiseSkill"],
  TrainSkill: ["trainSkill"],
};

const ODF_PLAYER = 0x08;
const ODF_ATTACKABLE = 0x10;

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
    this._onEvent = []; // report 04 push plane
    this._worker = null;
    // Install the push-event tap: the page's pumpNetFrame forwards each
    // drained ClientEvent here (default-off hook in index.html). Events
    // are the PUSH complement to the poll snapshot — chat, kill notices,
    // use-done — that a pure poller would miss or need to reconstruct.
    if (typeof window !== "undefined" && !opts.noEventTap) {
      const prev = window.__rynthOnEvent;
      window.__rynthOnEvent = (evt) => {
        if (prev) { try { prev(evt); } catch (_) {} }
        this._dispatchEvent(evt);
      };
    }
  }

  // ── push-event plane (report 04) ────────────────────────────────────
  onEvent(fn) {
    this._onEvent.push(fn);
  }
  _dispatchEvent(evt) {
    // Normalize the wasm ClientEvent into a plain object once.
    const e = {
      kind: evt.kind,
      text: evt.stringPayload ?? null,
      u32: evt.u32Payload ?? 0,
      u32b: evt.u32Payload2 ?? 0,
    };
    for (const fn of this._onEvent) {
      try {
        fn(e, this);
      } catch (err) {
        (console.warn || console.log)("[RynthWebHost] onEvent threw:", err);
      }
    }
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
    // Wasm world-state enumerator first (spawn-gate independent, sees
    // everything the protocol delivered); JS entityMap as fallback for
    // stale pkg/ builds.
    const f = this._m.NearbyEntityGuids;
    if (f) {
      try {
        const v = f(this.nearbyRangeM ?? 0);
        if (v && typeof v.length === "number") return Array.from(v);
      } catch (_) {
        /* fall through */
      }
    }
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
  /// True iff the object's description flags have actually been received.
  /// The wasm read returns undefined/null (not 0) for an object whose
  /// ObjectDescriptionEvent hasn't landed yet, OR when the host lacks the
  /// GetObjectDescFlags capability at all — either way the flags are
  /// unavailable. This is the web analogue of C#'s `HasObjectIsAttackable`
  /// capability guard (CombatManager.cs:610), which lets attackability
  /// degrade-open rather than fail-closed on missing data.
  HasObjectDescFlags(guid) {
    const flags = this._live("GetObjectDescFlags", guid);
    return flags !== undefined && flags !== null;
  }
  /// Report 11 T2 filter class: attackable per the spawn description flags
  /// (0x10). FAIL-OPEN when the flags are GENUINELY ABSENT (not yet streamed)
  /// — RynthAi's anti-stall discipline: `if (HasObjectIsAttackable &&
  /// !ObjectIsAttackable(id)) continue;` (CombatManager.cs:610) only excludes
  /// a target when the flags ARE present AND the attackable bit is clear; an
  /// object with no desc yet is treated attackable so the bot doesn't "stare
  /// at a monster for 3s" through the post-spawn/post-login window (report 11
  /// T4; b5.md combat T4). The prior code coalesced absent flags to 0 and
  /// failed CLOSED, stalling on any not-yet-described creature. When flags ARE
  /// present (a number, even 0) we still honour a clear attackable bit ->
  /// false, so vendors/NPCs stay excluded.
  ObjectIsAttackable(guid) {
    const flags = this._live("GetObjectDescFlags", guid);
    if (flags === undefined || flags === null) return true; // flags absent -> fail-open
    return (flags & ODF_ATTACKABLE) !== 0;
  }
  ObjectIsPlayer(guid) {
    const flags = this._live("GetObjectDescFlags", guid) ?? 0;
    return (flags & ODF_PLAYER) !== 0;
  }
  /// Raw ObjectDescriptionFlags (u32) for typed perception (vendor/healer/
  /// portal/lifestone/door/corpse/… bits — ObjectDescriptionFlag.generated.cs).
  /// null when not yet streamed (distinguish from a real 0). (observe_ext.js
  /// probeNearbyObjects decodes these into a category.)
  TryGetObjectDescFlags(guid) {
    const flags = this._live("GetObjectDescFlags", guid);
    return typeof flags === "number" ? flags >>> 0 : null;
  }
  /// FellowshipTracker replacement (report 07): the whole 272-line
  /// memory-reader collapses to this adapter over the protocol-fed
  /// snapshot. null when not in a fellowship.
  TryGetFellowship() {
    const snap = this._live("GetFellowship");
    if (!snap) return null;
    const members = [];
    try {
      for (const m of snap.members || []) {
        members.push({
          guid: Number(m.guid ?? 0),
          name: m.name ?? "",
          level: Number(m.level ?? 0),
          health: Number(m.currentHealth ?? m.health ?? 0),
          maxHealth: Number(m.maxHealth ?? 0),
          stamina: Number(m.currentStamina ?? m.stamina ?? 0),
          mana: Number(m.currentMana ?? m.mana ?? 0),
          sharePercent: Number(m.sharePercent ?? 0),
        });
      }
    } catch (_) {
      /* defensive: partial snapshot shapes degrade to fewer fields */
    }
    return {
      name: snap.name ?? "",
      leaderGuid: Number(snap.leaderGuid ?? 0),
      shareXp: !!snap.shareXp,
      open: !!snap.open,
      members,
    };
  }
  HasAppraisalData(guid) {
    return this._live("HasAppraisalData", guid) ?? false;
  }
  GetLastIdTime(guid) {
    return this._live("GetLastIdTime", guid) ?? 0;
  }
  GetContainerContents(guid) {
    const v = this._live("GetContainerContents", guid);
    // Wasm returns a Uint32Array of contained-item guids; normalize to a
    // plain number[] so callers never hold a typed-array view.
    return v && typeof v.length === "number" ? Array.from(v, (g) => g >>> 0) : [];
  }
  /// Parsed AppraisalSnapshot (EX-05 JSON) for an appraised object, or null
  /// pre-appraisal / on parse error. Refreshed wasm-side on every
  /// EntityIdentified, so a repeat RequestId yields fresh data here.
  TryGetObjectAppraisal(guid) {
    const raw = this._live("GetObjectAppraisal", guid);
    if (typeof raw !== "string" || !raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
  /// Pending server confirmation dialogs -> [{confirmType, context, text}]
  /// (plain objects, [] when none). An unanswered dialog declines on a
  /// server-side timeout — see SendConfirmationResponse.
  TryGetPendingConfirmations() {
    const raw = this._live("GetPendingConfirmations");
    if (!raw) return [];
    const out = [];
    try {
      for (const c of raw) {
        out.push({
          confirmType: Number(c.confirmType ?? c.confirm_type ?? 0),
          context: Number(c.context ?? 0),
          text: String(c.text ?? ""),
        });
      }
    } catch (_) {
      /* partial rows degrade to fewer dialogs */
    }
    return out;
  }

  // ── inventory / economy reads (2026-07-17) ──────────────────────────
  /// Plain-object projection of SessionHandle.playerInventory()
  /// (Array<InventoryItem>, src/lib.rs) — wasm-bindgen rows copied field-
  /// by-field so callers never hold wasm handles. [] pre-spawn / on error.
  TryGetPlayerInventory() {
    const raw = this._live("GetPlayerInventory");
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const it of raw) {
      try {
        out.push({
          guid: (it.guid ?? 0) >>> 0,
          name: it.name ?? "",
          wcid: (it.wcid ?? 0) >>> 0,
          value: Number(it.value ?? 0),
          stackSize: Number(it.stackSize ?? 1),
          equipMask: (it.equipMask ?? 0) >>> 0,
          validLocations: (it.validLocations ?? 0) >>> 0,
          itemType: (it.itemType ?? 0) >>> 0,
          containerId: (it.containerId ?? 0) >>> 0,
          itemsCapacity: Number(it.itemsCapacity ?? 0),
          requiresBackpackSlot: !!it.requiresBackpackSlot,
        });
      } catch (_) {
        /* one bad row must not drop the snapshot */
      }
    }
    return out;
  }
  /// Items currently worn/wielded (non-zero equip mask).
  TryGetEquipment() {
    return this.TryGetPlayerInventory().filter((i) => i.equipMask !== 0);
  }
  /// Pyreals: PropertyInt.CoinValue (20) on the player is authoritative;
  /// falls back to summing coin-stack values (wcid 273) from the inventory.
  TryGetCoins() {
    const me = this.GetPlayerId();
    const prop = me ? this._live("GetObjectIntProperty", me, 20) : undefined;
    if (typeof prop === "number" && Number.isFinite(prop)) return prop;
    let sum = 0;
    for (const i of this.TryGetPlayerInventory()) if (i.wcid === 273) sum += i.value;
    return sum;
  }
  /// Burden as an integer PERCENT of capacity. Source is the stats-plane
  /// getter SessionHandle.playerBurden (encumbrance/capacity, 0..N float;
  /// live-probed 2026-07-17: the local player's entity int-store does NOT
  /// answer EncumbranceVal(5), so a property read can never work here).
  /// A 0.0 reading counts only once the inventory has streamed (pre-
  /// hydration playerBurden is 0.0 too). null when unknown.
  /// (observe_ext.js probes this exact name — BURDEN_GETTERS.)
  TryGetBurden() {
    try {
      const b = this.s.playerBurden;
      if (typeof b === "number" && Number.isFinite(b) && (b > 0 || this.TryGetPlayerInventory().length))
        return Math.round(b * 100);
    } catch (_) {}
    const me = this.GetPlayerId();
    const v = me ? this._live("GetObjectIntProperty", me, 5) : undefined;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  /// Free item slots, AGGREGATE across main pack + side packs: capacity
  /// (SessionHandle.playerItemsCapacity, live 102, + unequipped packs'
  /// itemsCapacity) minus unequipped backpack-slot items. Per-container
  /// math is impossible today — every InventoryItem.containerId is 0 in
  /// the current wasm snapshot (live-probed 2026-07-17). null until the
  /// inventory streams. (observe_ext.js probes this exact name —
  /// FREE_SLOT_GETTERS.)
  TryGetFreeSlots() {
    const inv = this.TryGetPlayerInventory();
    if (!inv.length) return null;
    let cap = 0;
    try {
      const c = this.s.playerItemsCapacity;
      if (typeof c === "number" && Number.isFinite(c) && c > 0) cap = c;
    } catch (_) {}
    if (!cap) cap = 102;
    for (const i of inv) if (i.itemsCapacity > 0 && i.equipMask === 0) cap += i.itemsCapacity;
    const used = inv.filter((i) => i.equipMask === 0 && i.requiresBackpackSlot).length;
    return Math.max(0, cap - used);
  }
  /// Vendor stock snapshot (plain objects) — populated after the vendor's
  /// profile lands (UseObject on the vendor triggers it). null until then.
  TryGetVendorState(vendorGuid) {
    const v = this._live("GetVendorState", vendorGuid);
    if (!v) return null;
    const items = [];
    try {
      for (const it of v.items || []) {
        items.push({
          itemGuid: (it.itemGuid ?? 0) >>> 0,
          name: it.name ?? "",
          wcid: (it.wcid ?? 0) >>> 0,
          value: Number(it.value ?? 0),
          stackSize: Number(it.stackSize ?? 1),
          itemType: (it.itemType ?? 0) >>> 0,
        });
      }
    } catch (_) {
      /* partial profile degrades to fewer rows */
    }
    return {
      vendorGuid: (v.vendorGuid ?? vendorGuid) >>> 0,
      vendorName: v.vendorName ?? "",
      buyMultiplier: Number(v.buyMultiplier ?? 1),
      sellMultiplier: Number(v.sellMultiplier ?? 1),
      items,
    };
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
  /// Give a player-owned item to an NPC/player (quest turn-ins). Server
  /// validates; success/failure arrives as InventoryUpdate / WeenieError.
  GiveObject(targetGuid, itemGuid, amount = 1) {
    return this._act("GiveObject", targetGuid, itemGuid, amount);
  }
  /// Pick up a ground item into the player's main pack — retail's
  /// PutItemInContainer (GameAction 0x0019). NOT UseItem: ACE's Use on plain
  /// ground clothing/armor has no ActOnUse and does nothing (the v6.3
  /// armor-quest wall). Server validates range/burden; the result arrives as
  /// an inventory update.
  TakeObject(itemGuid) {
    return this._act("TakeObject", itemGuid, this.GetPlayerId(), 0);
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

  // ── economy actions (2026-07-17) ────────────────────────────────────
  /// items: [{itemGuid, amount}] — typed-array marshal for the wasm ABI
  /// (buyFromVendor(vendor_guid, Uint32Array, Int32Array), src/lib.rs).
  BuyFromVendor(vendorGuid, items) {
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) return false;
    return this._act(
      "BuyFromVendor",
      vendorGuid,
      Uint32Array.from(rows.map((r) => r.itemGuid >>> 0)),
      Int32Array.from(rows.map((r) => Math.max(1, r.amount | 0)))
    );
  }
  SellToVendor(vendorGuid, items) {
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) return false;
    return this._act(
      "SellToVendor",
      vendorGuid,
      Uint32Array.from(rows.map((r) => r.itemGuid >>> 0)),
      Int32Array.from(rows.map((r) => Math.max(1, r.amount | 0)))
    );
  }
  /// equipMask defaults to the item's validLocations (wear it where it fits).
  WieldItem(itemGuid, equipMask) {
    let mask = equipMask >>> 0;
    if (!mask) {
      const row = this.TryGetPlayerInventory().find((i) => i.guid === (itemGuid >>> 0));
      mask = row ? row.validLocations : 0;
    }
    if (!mask) return false;
    return this._act("WieldFromPack", itemGuid, mask);
  }
  UnwieldItem(itemGuid) {
    return this._act("UnwieldToPack", itemGuid);
  }
  DropItem(itemGuid) {
    return this._act("DropItem", itemGuid);
  }
  /// UseWithTarget 0x0035 — apply an inventory item TO a world object:
  /// key on a locked door/chest, lockpick, healing kit, tinkering tool.
  /// Server validates; the verdict lands as UseDone / a kind-13 UseFailed.
  UseItemOnTarget(itemGuid, targetGuid) {
    return this._act("UseWithTarget", itemGuid >>> 0, targetGuid >>> 0);
  }
  /// Move a specific item into a container (chest→pack loot, pack→side-pack).
  /// placement 0 = first free slot.
  MoveItemToContainer(itemGuid, containerGuid, placement = 0) {
    return this._act("MoveItem", itemGuid >>> 0, containerGuid >>> 0, placement | 0);
  }
  /// Split `amount` off a stack into a container (the player's own pack by
  /// default via the caller passing GetPlayerId()).
  SplitStack(stackGuid, containerGuid, amount, placement = 0) {
    return this._act("SplitStackToContainer", stackGuid >>> 0, containerGuid >>> 0, placement | 0, Math.max(1, amount | 0));
  }
  /// Merge `amount` from stack src onto stack dst (same wcid).
  MergeStacks(srcGuid, dstGuid, amount) {
    return this._act("MergeStacks", srcGuid >>> 0, dstGuid >>> 0, Math.max(1, amount | 0));
  }
  /// Answer a pending server confirm dialog — confirmType/context verbatim
  /// from TryGetPendingConfirmations.
  SendConfirmationResponse(confirmType, context, accepted) {
    return this._act("SendConfirmationResponse", confirmType | 0, context | 0, !!accepted);
  }

  // ── advancement plane (2026-07-17) ──────────────────────────────────
  /// Normalized character-advancement snapshot from SessionHandle.playerStats()
  /// (PlayerStatsSnapshot: flat stride arrays). null until the stats plane
  /// hydrates. unspentXp reassembles the levelInfo lo/hi u32 pair into a
  /// Number (XP stays well under MAX_SAFE_INTEGER). (advancement.js/observe_ext
  /// read this exact shape.)
  TryGetPlayerStats() {
    let ps = null;
    try {
      ps = this.s.playerStats();
    } catch (_) {}
    if (!ps) return null;
    const attributes = {};
    const skills = {};
    const vitals = {};
    let level = 0;
    let unspentXp = 0;
    try {
      const a = ps.attributes || [];
      for (let i = 0; i + 3 < a.length; i += 4) attributes[a[i]] = { current: a[i + 1], base: a[i + 2], ranks: a[i + 3] };
    } catch (_) {}
    try {
      const s = ps.skills || [];
      for (let i = 0; i + 5 < s.length; i += 6) skills[s[i]] = { current: s[i + 1], base: s[i + 2], ranks: s[i + 3], training: s[i + 4], nextCost: s[i + 5] };
    } catch (_) {}
    try {
      const v = ps.vitals || [];
      for (let i = 0; i + 3 < v.length; i += 4) vitals[v[i]] = { current: v[i + 1], base: v[i + 2], max: v[i + 3] };
    } catch (_) {}
    try {
      const li = ps.levelInfo || [];
      level = li[0] >>> 0;
      unspentXp = (li[3] >>> 0) + (li[4] >>> 0) * 4294967296;
    } catch (_) {}
    return { level, unspentXp, attributes, skills, vitals };
  }
  /// Available (unspent) skill credits — SessionHandle.playerSkillCredits.
  /// null when the getter is absent/unready. (advancement.js train_skill.)
  TryGetSkillCredits() {
    try {
      const c = this.s.playerSkillCredits;
      if (typeof c === "number" && Number.isFinite(c)) return c;
    } catch (_) {}
    return null;
  }
  RaiseAttribute(attributeId, xpSpent) {
    return this._act("RaiseAttribute", attributeId >>> 0, xpSpent >>> 0);
  }
  RaiseVital(vitalId, xpSpent) {
    return this._act("RaiseVital", vitalId >>> 0, xpSpent >>> 0);
  }
  RaiseSkill(skillId, xpSpent) {
    return this._act("RaiseSkill", skillId >>> 0, xpSpent >>> 0);
  }
  TrainSkill(skillId, credits) {
    return this._act("TrainSkill", skillId >>> 0, credits >>> 0);
  }
}

export default RynthWebHost;
