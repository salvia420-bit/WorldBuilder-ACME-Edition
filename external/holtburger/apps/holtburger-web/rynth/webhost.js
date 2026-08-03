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
//
// ─────────────────────────────────────────────────────────────────────────
// P6.1 PROMOTION (2026-07-28, CORE-07 "promotion, not a rewrite")
// ─────────────────────────────────────────────────────────────────────────
// This class is now THE substrate of the one versioned `client` facade:
// `plugins/api.js::createClient` constructs exactly one RynthWebHost, hangs
// it on `client.host`, and expresses every plugin-facing namespace
// (`client.player/.movement/.chat/.characters/.scene/.sky/.collision`) as a
// delegate over this object's capability table. There is now ONE place that
// resolves a SessionHandle method, ONE degrade-not-throw rule, and ONE
// owner of the raw handle.
//
// FILE LOCATION — deliberate deviation from the design doc, which called for
// moving this file to `plugins/webhost.js`. It stays here because it must
// keep ZERO top-level imports: two anti-drift node harnesses
// (`rynth_host_contract_test.cjs`, `rynth_combatparity_test.cjs`) copy this
// file's bytes to a temp `.mjs` and import it standalone — a re-export stub
// would break both. `plugins/webhost.js` is instead the ALIAS (re-export)
// so the plugins tree still has the canonical import path. Same one
// implementation, alias pointing the other way. For the same reason the
// page-side seams below (chat hooks, chat routing, selection) are read off
// `window.*` lazily rather than imported.
//
// Two capability CLASSES (see `has()`):
//   handle capabilities — probed ONCE at construction against the
//     SessionHandle (design §2.3 semantics, unchanged).
//   environment capabilities — page seams (`window.__chatHooks`,
//     `window.__barInstance`, `window.liveScene3d`) that attach LATE
//     (liveScene3d lands ~35s after in-world), so a construction-time probe
//     would answer `false` forever. These are probed LIVE on each `has()`.
//     Documented deviation; the fallback rule is unchanged — an absent
//     capability's member returns its documented fallback and never throws.

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
  // C1 fix (rynth-review 07 / 17-SYNTHESIS streamline #5, 2026-07-23):
  // honest "is the pose's objCellId genuinely live data?" signal, bypassing
  // the WP-2/WP-3 retention layers that made `objCellId===0` unreachable
  // once a good pose has been seen. Absent on any pkg/ predating this
  // export (graceful-degrade idiom below) — snap.pose.cellResolved is
  // `null` in that case and nav consumers fall back to the legacy
  // `objCellId===0` check.
  GetPlayerPoseCellResolved: ["getLocalPlayerPoseCellResolved"],
  // Indoor-spawn fix (2026-07-23, Town Network no-walk wedge): the cell-scene
  // snapshot's carried cell — the ONE accessor that stays correct when the
  // raw pose's landblockId reads 0 (login/teleport straight into a dungeon
  // where no good pose was ever seen, so the WP-3 shadow has nothing to
  // retain — HANDOFF-surveyor-round2 §OPEN). Used by _tick() to heal
  // snap.pose.objCellId so nav consumers (router worldXY frames, indoor
  // classification, indoorLegsTo) don't run on a garbage lb-0 frame.
  GetCurrentCellId: ["getCurrentCellId"],
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
  // Jump primitive (2026-07-21, DESIGN-jump-primitive Phase 1): the wasm
  // pipeline (SessionHandle.jump/setMovementInput/canJumpNow,
  // holtburger_web.d.ts) already exists and is parity-tested — these three
  // are the FIRST rynth-layer wrappers over it, added for goto_compose.js's
  // jmp-leg executor (attemptJumpLeg). SetMovementInput doubles as the
  // "build horizontal velocity before jumping" primitive: src/lib.rs's
  // SessionCommand::Jump arm reads `local_player_runtime_kinematics()` for
  // the launch velocity's x/y, so a standstill jump() call is a near-
  // vertical hop — the caller must be moving (forward-held) when it fires.
  Jump: ["jump"],
  SetMovementInput: ["setMovementInput"],
  CanJumpNow: ["canJumpNow"],
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

  // ── P6.1 promotion (2026-07-28) ────────────────────────────────────
  // The surface `plugins/api.js`'s namespaces cover that this host had
  // never mapped. Purely ADDITIVE (design §6: additive = minor bump).
  // Every SessionHandle name below was verified present in
  // pkg/holtburger_web.d.ts at promotion time; a stale pkg/ simply
  // degrades the capability, as with every other entry here.
  // player plane
  ToggleCombatMode: ["toggleCombatMode"],
  MissileAttack: ["missileAttack"],
  RecallToLifestone: ["teleToLifestone"],
  ForgetSpell: ["removeSpellFromBook"],
  GetKnownSpells: ["playerKnownSpells"],
  TickMovement: ["tickMovement"],
  // characters plane (retail Begin/EndCharacterSession neighbourhood)
  GetCharacterList: ["characterList"],
  SelectCharacter: ["selectCharacter"],
  CreateTestCharacter: ["createTestCharacter"],
  GetCharacterGenCatalog: ["getCharacterGenCatalog"],
  GetSkillCostsForHeritage: ["getSkillCostsForHeritage"],
  GetCharacterGenAppearanceStrips: ["getCharacterGenAppearanceStrips"],
  CreateCharacter: ["sendCharGenResult"],
  // scene plane (retail GetIsOutdoors was E_NOTIMPL; ours is real)
  IsCurrentCellIndoor: ["isCurrentCellIndoor"],
  GetRenderSet: ["getRenderSet"],
  TerrainHeightAt: ["terrainHeightAt"],
  GetBuildingPartForDoor: ["getBuildingPartForDoor"],
  // sky plane (no retail analogue — browser-side day/night control)
  GetSkyState: ["getSkyState"],
  GetSkyObjectStates: ["getSkyObjectStates"],
  HasSkyDesc: ["hasSkyDesc"],
  SetSkyTimeOverride: ["setSkyTimeOverride"],
  SetGameDayOverride: ["setGameDayOverride"],
  // collision plane (no retail analogue — the client-side physics probe)
  SweepCollision: ["cameraSweepCollision"],
  SweepBuildingMesh: ["sweepSphereAgainstBuildingMesh"],
  SweepCellMesh: ["sweepSphereAgainstCellMesh"],
  SweepStatics: ["sweepSphereAgainstStatics"],
  // plugin-manifest wire (GameEvent 0x02AE -> GameAction 0x02AF); the
  // roster string itself is built by plugins/loader.js::formatPluginList.
  SetPluginList: ["setPluginList"],
  GetPluginList: ["pluginList"],
};

/**
 * Capability names as API surface (design §2.3): additive-only within a
 * major version. Exported so the plugin loader can validate a manifest's
 * declared `capabilities` against something real without constructing a
 * host, and so tests can pin the set.
 * @type {string[]}
 */
export const CAPABILITY_NAMES = Object.freeze(Object.keys(CAPABILITY_CANDIDATES).sort());

/**
 * ENVIRONMENT capabilities — page seams rather than SessionHandle methods.
 * Probed LIVE (see the header note): every backing object here attaches
 * after the host may already have been constructed.
 */
const ENV_CAPABILITY_PROBES = Object.freeze({
  // Selection is owned by the 3D entity manager, which `window.liveScene3d`
  // only exposes once init3D has run (MEMORY: ~35s after in-world).
  SelectObject: () => typeof globalThis.liveScene3d?.entityManager?.setSelectedTarget === "function",
  GetSelectedId: () => typeof globalThis.liveScene3d?.entityManager?.getSelectedTarget === "function",
  // Retail WriteToChat's display half — index.html exposes appendChatLine.
  WriteToChatWindow: () => typeof globalThis.__appendChatLine === "function",
  // Retail IssueChatBarCommand was an E_FAIL stub; ours routes for real.
  RouteChatCommand: () => typeof globalThis.__routeSlashCommand === "function",
  // The two retail eatable chat hooks (plugins/chat-hooks.js).
  ChatHooks: () => !!globalThis.__chatHooks,
  // Retail slot 49 GetScreenDimensions.
  GetScreenDimensions: () => typeof globalThis.innerWidth === "number",
  // client.ui programmatic panel control (ui/bar.js mountBar return).
  OpenPanel: () => typeof globalThis.__barInstance?.openPanel === "function",
});

/**
 * Environment-capability names (see ENV_CAPABILITY_PROBES).
 * @type {string[]}
 */
export const ENV_CAPABILITY_NAMES = Object.freeze(Object.keys(ENV_CAPABILITY_PROBES).sort());

/**
 * Probe an object (a live SessionHandle, or `SessionHandle.prototype` when
 * no session exists yet) for the handle-capability set it would yield.
 *
 * The prototype form is what lets the plugin LOADER enforce manifest
 * `capabilities` at page load — the loader runs long before login, so there
 * is no handle to probe, but wasm-bindgen puts every method on the
 * prototype, so the answer is identical. Only CAPABILITY_CANDIDATES names
 * are touched (all plain methods), never the accessor properties
 * (`accountName`, `playerBurden`, …) whose getters would throw on a
 * pointer-less prototype.
 *
 * @param {object|null|undefined} handleLike
 * @returns {string[]} sorted capability names
 */
export function probeCapabilities(handleLike) {
  if (!handleLike) return [];
  const out = [];
  for (const [cap, candidates] of Object.entries(CAPABILITY_CANDIDATES)) {
    for (const name of candidates) {
      let fn;
      try {
        fn = handleLike[name];
      } catch (_) {
        continue;
      }
      if (typeof fn === "function") {
        out.push(cap);
        break;
      }
    }
  }
  return out.sort();
}

const ODF_PLAYER = 0x08;
const ODF_ATTACKABLE = 0x10;

// Shared cast-token clock (02 C3 / synthesis streamline #6): combat's
// CAST_RESOLUTION_TIMEOUT_MS (combat_loop.js) and buff's
// SELF_BUFF_GIVE_UP_MS (buff_loop.js) were two independent `2500` literals
// that happened to agree. This is the one clock the shared token uses to
// self-clear when UseDoneSeq is unavailable/missed; it does not replace
// either module's own internal bookkeeping (P2 awaitingCast, B8 pending),
// which keep their own timeout literals for their own purposes.
const CAST_TOKEN_TIMEOUT_MS = 2500;

export class RynthWebHost {
  constructor(sessionHandle, opts = {}) {
    if (!sessionHandle) throw new Error("RynthWebHost: sessionHandle required");
    this.entityMap = opts.entityMap || (typeof window !== "undefined" ? window.entityMap : null);
    this._m = {}; // resolved capability -> bound method
    this._caps = new Set();
    this.attach(sessionHandle);
    this.snap = null; // frozen per-tick snapshot
    this._tickSeq = 0;
    this._onTick = [];
    this._onEvent = []; // report 04 push plane
    this._worker = null;
    this._castToken = null; // { owner, issuedAt, useDoneAtIssue } — 02 C3 shared serializer
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

  /**
   * (Re)bind this host to a SessionHandle and re-probe the capability
   * table. Called once from the constructor, and again on every RECONNECT:
   * a reconnect builds a brand-new wasm session, and a host still bound to
   * the old handle would keep calling a freed one (the pre-P6.1 facade did
   * exactly that — `createClient` captured the first handle for the page's
   * lifetime, so after a kick/reconnect every `client.*` call went to a
   * dead session; live-observed 2026-07-28 under `?kickDance=1`).
   *
   * The snapshot is dropped: it described the previous session.
   * @param {object} sessionHandle
   * @returns {this}
   */
  attach(sessionHandle) {
    if (!sessionHandle) throw new Error("RynthWebHost.attach: sessionHandle required");
    if (this.s === sessionHandle) return this;
    this.s = sessionHandle;
    const m = {};
    const caps = new Set();
    for (const [cap, candidates] of Object.entries(CAPABILITY_CANDIDATES)) {
      for (const name of candidates) {
        let fn;
        try {
          fn = sessionHandle[name];
        } catch (_) {
          continue;
        }
        if (typeof fn === "function") {
          m[cap] = fn.bind(sessionHandle);
          caps.add(cap);
          break;
        }
      }
    }
    this._m = m;
    this._caps = caps;
    this.snap = null;
    return this;
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

  // ── shared cast token (02 C3 / synthesis streamline #6) ─────────────
  // combat/buff/vitals each track "cast in flight" their own way, with
  // their own definition of resolved (P2 UseDoneSeq vs B8 registry re-read
  // vs vitals' none-at-all) — see the module headers. That is preserved;
  // this token is an ADDITIONAL cross-module interlock so one module's
  // cast GESTURE finishing (GetCastBusyState()===0) can't be mistaken by
  // a DIFFERENT module for the cast being fully RESOLVED, which used to
  // let a second cast fire inside the first one's still-open UseDone
  // window. Arm it immediately before issuing a CastSpell/
  // CastUntargetedSpell; it self-clears on the next UseDoneSeq advance
  // (the real resolution signal) or after CAST_TOKEN_TIMEOUT_MS (never
  // wedge if UseDone is unavailable/missed).
  _castTokenLive() {
    const t = this._castToken;
    if (!t) return false;
    if (this.has("GetUseDoneSeq") && this.GetUseDoneSeq() !== t.useDoneAtIssue) {
      this._castToken = null;
      return false;
    }
    if (Date.now() - t.issuedAt > CAST_TOKEN_TIMEOUT_MS) {
      this._castToken = null;
      return false;
    }
    return true;
  }
  /** Claim the shared cast token. Call immediately before issuing a cast.
   *  Returns true if the caller may cast now — the token was free, or
   *  already held by this SAME owner (a module re-arming its own still-open
   *  cast doesn't self-block). Returns false when a DIFFERENT owner holds
   *  an unresolved claim; the caller must skip casting this tick. */
  tryClaimCast(owner) {
    if (this._castTokenLive()) return this._castToken.owner === owner;
    this._castToken = {
      owner,
      issuedAt: Date.now(),
      useDoneAtIssue: this.has("GetUseDoneSeq") ? this.GetUseDoneSeq() : 0,
    };
    return true;
  }
  /** Release the token early once the owner's OWN bookkeeping (registry
   *  re-read, health-fraction poll, etc.) confirms resolution before
   *  UseDoneSeq/the timeout would have cleared it. No-op if a different
   *  owner holds it (or nothing does). */
  releaseCast(owner) {
    if (this._castToken && this._castToken.owner === owner) this._castToken = null;
  }
  /** Read-only status snapshot for diagnostics (`__diag`-style callers). */
  get castToken() {
    return this._castToken ? { ...this._castToken } : null;
  }

  // ── capability probes (the RynthCoreHost Has* plane) ───────────────
  /**
   * True iff `cap`'s backing exists. Handle capabilities answer from the
   * construction-time probe (design §2.3); ENVIRONMENT capabilities are
   * probed live because their backing seams attach late (see header).
   * Never throws — an unknown name is simply `false`.
   */
  has(cap) {
    if (this._caps.has(cap)) return true;
    const probe = ENV_CAPABILITY_PROBES[cap];
    if (!probe) return false;
    try {
      return !!probe();
    } catch (_) {
      return false;
    }
  }
  /** Sorted capability names currently backed (handle + live environment). */
  get capabilities() {
    const out = new Set(this._caps);
    for (const name of ENV_CAPABILITY_NAMES) {
      if (this.has(name)) out.add(name);
    }
    return [...out].sort();
  }

  // ── public capability seams (P6.1) ─────────────────────────────────
  // The plugin-facing namespaces in plugins/api.js delegate through these
  // two so capability resolution + degrade-not-throw lives in exactly one
  // place. They are the SAME `_live`/`_act` the host's own members use;
  // the underscore versions stay for the existing rynth call sites.
  /** Live read through a capability. `undefined` when absent or throwing. */
  call(cap, ...args) {
    return this._live(cap, ...args);
  }
  /** Fire-and-forget through a capability. `false` when absent or throwing. */
  act(cap, ...args) {
    return this._act(cap, ...args);
  }
  /**
   * The raw SessionHandle. Named to declare intent — this is the ONLY
   * sanctioned raw access (design §2.1 `client._unsafeHandle`), for the
   * accessor PROPERTIES (`accountName`, `playerBurden`, …) that cannot be
   * expressed as capabilities because they are not methods.
   */
  get unsafeHandle() {
    return this.s;
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
    // Indoor-spawn heal (2026-07-23, Town Network no-walk wedge): a raw pose
    // with landblockId 0 means "no good cell was EVER seen" (the WP-3 shadow
    // retains any prior good cell, so 0 here is the login/teleport-into-
    // dungeon gap, not a transient). The coords are still the spawn cell's
    // landblock-local frame, so pairing them with the cell-scene snapshot's
    // carried cell (`getCurrentCellId` — server-truth, live-verified correct
    // in the 0x00070178 wedge while the raw accessor carried nothing)
    // reconstructs a correct pose. `cellResolved` below stays UNTOUCHED —
    // this heals the frame, it does not fake the honest resolution signal.
    let healedCell = 0;
    if (pose && (pose.landblockId >>> 0) === 0) {
      const cur = c("GetCurrentCellId");
      if (typeof cur === "number" && (cur >>> 0) !== 0) healedCell = cur >>> 0;
    }
    // C1 fix (rynth-review 07, 2026-07-23): `undefined` when the capability
    // is absent (stale pkg/) — normalized to `null` below so
    // `snap.pose.cellResolved` has exactly three JSON-stable states:
    // `true`/`false` (honest signal) or `null` (unknown, caller must fall
    // back to the legacy `objCellId===0` heuristic).
    const poseCellResolved = c("GetPlayerPoseCellResolved");
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
            objCellId: healedCell || (pose.landblockId >>> 0),
            x: pose.x,
            y: pose.y,
            z: pose.z,
            heading: pose.heading ?? null,
            // C1 fix (rynth-review 07/17-SYNTHESIS #9): honest resolved
            // signal — see `GetPlayerPoseCellResolved` doc above.
            cellResolved: poseCellResolved === undefined ? null : poseCellResolved,
          }
        : null,
      pursuitNow: pursuitNow ?? 0,
      // Latched last completion (2=arrived, 3=failed) — survives the
      // read-clear until a new pursuit overwrites it.
      pursuitLast:
        pursuitNow >= 2 ? pursuitNow : prev ? prev.pursuitLast : 0,
      nearby: this._nearbyGuids(),
    };
    // Copy-then-free (2026-08-03 review F6). `GetPlayerPose` maps to the wasm
    // `getLocalPlayerPose` (see the capability table above), which hands back a
    // wasm-bindgen `LocalPlayerPose` box — `pkg/holtburger_web.d.ts` declares
    // `free(): void` on it. Every field the snapshot needs has been read into
    // plain numbers by this point, so the box is dead. It was never freed, and
    // `_tick` runs off a WORKER interval (see `start(hz = 15)`) specifically so
    // a backgrounded tab keeps ticking — ~54k orphaned boxes an hour across a
    // soak, in the module every pose read in bot.js / goto_compose.js goes
    // through. Same invariant as R1#6 / R5#14; `free()` is NOT idempotent, so
    // this is the single owner and it frees exactly once.
    try { pose?.free?.(); } catch (_) { /* box already gone — never break the tick */ }
    this._posesFreed = (this._posesFreed | 0) + 1;
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
    // CoinValue(20) is absent after a relog: ACE computes it lazily and a
    // fresh character's value is never persisted (live soak v6.5.1: DB had
    // NO type-20 row while the pack held a 10000-pyreal stack). Item Value
    // ALSO doesn't ride the login CreateObject stream (it arrives only via
    // SetStackSize/appraisal), so fall back to stackSize — a pyreal is
    // unit-value, stack Value == stack size (shard DB confirms 10000/10000).
    let sum = 0;
    for (const i of this.TryGetPlayerInventory())
      if (i.wcid === 273) sum += i.value || i.stackSize || 0;
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
  /** Fire the jump wire packet (`power` in [0,1]) — fire-and-forget like every
   *  other `_act` action; returns false (not thrown) on a missing capability
   *  or a wasm-side throw. Caller should gate on CanJumpNow() first. */
  Jump(power) {
    return this._act("Jump", power);
  }
  /** Raw WASD-style axes — see the CAPABILITY_CANDIDATES note above: used by
   *  the jump executor to build the launch-time horizontal velocity retail's
   *  jump physics reads (a standstill jump() is a near-vertical hop). */
  SetMovementInput(forward, strafe, turn, run) {
    return this._act("SetMovementInput", forward, strafe, turn, !!run);
  }
  /** Live (not snapshot) gate: true only when jump() would actually fire —
   *  false while airborne (no double-jumps) or in a substate that forbids it.
   *  Fails OPEN (true) when the capability is absent (stale pkg/) so a
   *  missing export never silently blocks the jump executor; the wasm-side
   *  gate in Jump() itself is still authoritative either way. */
  CanJumpNow() {
    const v = this._live("CanJumpNow");
    return typeof v === "boolean" ? v : true;
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
  /**
   * Retail `IAsheronsCall::WriteToChat` — send a line as the player. In
   * retail this was the display-echo slot; here it goes to the wire
   * (`sendChat`), which is what every rynth caller has always meant by it.
   * The DISPLAY-only echo is `WriteToChatWindow` below (client.ui.writeToChat).
   */
  WriteToChat(text) {
    return this._act("WriteToChat", text);
  }
  /**
   * Retail `IAsheronsCall::IssueChatBarCommand` — retail's was an E_FAIL
   * stub, so a plugin that ate a chat line could never re-inject one. Ours
   * is real: the line goes through the SAME slash/`@` router the chat bar
   * uses (`window.__routeSlashCommand`, index.html) and falls through to a
   * plain say. This is the "eat + re-inject" half of the outbound chat hook
   * (design §3: retail's out-param was an eat flag, never a rewrite channel).
   *
   * Deliberately does NOT re-enter `chat.hooks.outgoing` — it is a chat-BAR
   * hook, and re-entering it would be the loop retail's `sendToAPI=false`
   * rule exists to prevent.
   *
   * @returns {boolean} true when the line was routed or sent.
   */
  InvokeChatParser(text) {
    const line = String(text ?? "").trim();
    if (!line) return false;
    const route = typeof globalThis !== "undefined" ? globalThis.__routeSlashCommand : null;
    if (typeof route === "function") {
      try {
        const routed = route(this.s, line);
        if (routed && routed.dispatched) {
          const echo = routed.error ? `[Chat] ${routed.error}` : routed.echo;
          if (echo) this.WriteToChatWindow(echo, routed.error ? 10 : null);
          return true;
        }
      } catch (e) {
        (console.warn || console.log)("[RynthWebHost] InvokeChatParser route failed:", e);
      }
    }
    return this._act("InvokeChatParser", line);
  }
  /**
   * DISPLAY-only chat echo (retail's `WriteToChat` display half / the
   * backing for `client.ui.writeToChat`). Deliberately does NOT traverse
   * `chat.hooks.incoming`: host-originated echoes bypass the hook, which is
   * exactly what makes plugin chat-rewriting loop-free (retail
   * `sendToAPI=false`).
   * @returns {boolean} false when no chat surface is mounted.
   */
  WriteToChatWindow(text, category = null) {
    const append = typeof globalThis !== "undefined" ? globalThis.__appendChatLine : null;
    if (typeof append !== "function") return false;
    try {
      append(String(text), category);
      return true;
    } catch (_) {
      return false;
    }
  }
  /**
   * Retail `IACPlugin::OnChatWindowText` — register an INBOUND chat hook.
   * `fn(ev)` receives `{text, chatType, category, eat()}`; calling `ev.eat()`
   * stops the line reaching any chat surface (and short-circuits the
   * remaining handlers — the loader's eatable bus does the `break`).
   * @returns {() => void} unsubscribe (no-op when the hook module is absent)
   */
  OnChatWindowText(fn) {
    const hooks = typeof globalThis !== "undefined" ? globalThis.__chatHooks : null;
    if (!hooks?.incoming?.on || typeof fn !== "function") return () => {};
    return hooks.incoming.on("chatIncoming", fn);
  }
  /**
   * Retail `IACPlugin::OnChatBarEnter` — register an OUTBOUND chat hook.
   * `fn(ev)` receives `{text, eat()}` for each chat-BAR submission, before
   * any prefix parsing. `ev.eat()` suppresses routing, send and echo; the
   * plugin can then re-inject via `InvokeChatParser`.
   * @returns {() => void} unsubscribe (no-op when the hook module is absent)
   */
  OnChatBarEnter(fn) {
    const hooks = typeof globalThis !== "undefined" ? globalThis.__chatHooks : null;
    if (!hooks?.outgoing?.on || typeof fn !== "function") return () => {};
    return hooks.outgoing.on("chatOutgoing", fn);
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

  // ═══════════════════════════════════════════════════════════════════
  // P6.1 promotion (2026-07-28) — the surface plugins/api.js's namespaces
  // need, so `createClient` can be a pure delegate layer over this host.
  // Every member follows the house rule: absent capability => documented
  // fallback, never a throw.
  // ═══════════════════════════════════════════════════════════════════

  // ── player plane ───────────────────────────────────────────────────
  /** Toggle combat/peace. Retail had `ChangeCombatMode` (an S_OK no-op liar). */
  ToggleCombatMode() {
    return this._act("ToggleCombatMode");
  }
  MissileAttack(targetGuid, attackHeight = 2, accuracyLevel = 1.0) {
    return this._act("MissileAttack", targetGuid, attackHeight, accuracyLevel);
  }
  /** Untargeted cast — the explicit half of CastSpell's target-optional form. */
  CastUntargetedSpell(spellId) {
    return this._act("CastUntargetedSpell", spellId);
  }
  RecallToLifestone() {
    return this._act("RecallToLifestone");
  }
  ForgetSpell(spellId) {
    return this._act("ForgetSpell", spellId);
  }
  /** Known-spell id list; `[]` when the capability or the spellbook is absent. */
  TryGetKnownSpells() {
    const v = this._live("GetKnownSpells");
    return v && typeof v.length === "number" ? Array.from(v) : [];
  }
  TickMovement() {
    return this._act("TickMovement");
  }
  /** LIVE (not snapshot) pose read — the namespaced `client.player.pose`
   *  view keeps retail-client "read it now" semantics; `TryGetPlayerPose()`
   *  is the frozen per-tick read (design §2.4). */
  TryGetPlayerPoseLive() {
    return this._live("GetPlayerPose") ?? null;
  }
  /** Enchantment snapshot for the local player; `[]` on absence/error. */
  TryGetEnchantments() {
    const v = this._live("GetEnchantments");
    return Array.isArray(v) ? v : [];
  }

  // ── characters plane (retail Begin/EndCharacterSession) ────────────
  TryGetCharacterList() {
    const v = this._live("GetCharacterList");
    return v == null ? [] : v;
  }
  SelectCharacter(guid) {
    return this._act("SelectCharacter", guid);
  }
  CreateTestCharacter(name) {
    return this._act("CreateTestCharacter", name);
  }
  TryGetCharacterGenCatalog() {
    return this._live("GetCharacterGenCatalog") ?? null;
  }
  TryGetSkillCostsForHeritage(heritageId, skillId) {
    return this._live("GetSkillCostsForHeritage", heritageId, skillId) ?? null;
  }
  TryGetCharacterGenAppearanceStrips(heritageId, genderId) {
    return this._live("GetCharacterGenAppearanceStrips", heritageId, genderId) ?? null;
  }
  /** Rich char-gen submit. THROWS on wasm-side validation failure — the one
   *  deliberate exception to degrade-not-throw, because the validation
   *  message IS the product surface (the wizard renders it). */
  CreateCharacter(build) {
    const f = this._m.CreateCharacter;
    if (!f) return false;
    f(build);
    return true;
  }

  // ── scene plane ────────────────────────────────────────────────────
  /** Current cell id (live read; the snapshot's healed copy is snap.pose). */
  GetCurrentCellIdLive() {
    return this._live("GetCurrentCellId") ?? 0;
  }
  /** `true` indoors, `false` outdoors, `null` when unknown. */
  IsIndoors() {
    const v = this._live("IsCurrentCellIndoor");
    return typeof v === "boolean" ? v : null;
  }
  /** Retail slot `GetIsOutdoors` (E_NOTIMPL in retail) — the honest inverse. */
  GetIsOutdoors() {
    const v = this.IsIndoors();
    return v === null ? null : !v;
  }
  GetRenderSet(depth = 1) {
    return this._live("GetRenderSet", depth) ?? null;
  }
  TerrainHeightAt(x, y) {
    return this._live("TerrainHeightAt", x, y) ?? null;
  }
  GetBuildingPartForDoor(guid) {
    return this._live("GetBuildingPartForDoor", guid) ?? null;
  }

  // ── sky plane ──────────────────────────────────────────────────────
  GetSkyState() {
    return this._live("GetSkyState") ?? null;
  }
  GetSkyObjectStates() {
    return this._live("GetSkyObjectStates") ?? null;
  }
  HasSkyDesc() {
    return this._live("HasSkyDesc") ?? false;
  }
  SetSkyTimeOverride(t) {
    return this._act("SetSkyTimeOverride", t);
  }
  SetGameDayOverride(day, year) {
    return this._act("SetGameDayOverride", day, year);
  }

  // ── collision plane ────────────────────────────────────────────────
  SweepCollision(fromX, fromY, fromZ, toX, toY, toZ, radius, landblockId) {
    return this._live("SweepCollision", fromX, fromY, fromZ, toX, toY, toZ, radius, landblockId) ?? null;
  }
  SweepBuildingMesh(fromX, fromY, fromZ, toX, toY, toZ, radius, landblockId) {
    return this._live("SweepBuildingMesh", fromX, fromY, fromZ, toX, toY, toZ, radius, landblockId) ?? null;
  }
  SweepCellMesh(fromX, fromY, fromZ, toX, toY, toZ, radius, cellIds) {
    return this._live("SweepCellMesh", fromX, fromY, fromZ, toX, toY, toZ, radius, cellIds) ?? null;
  }
  SweepStatics(fromX, fromY, fromZ, toX, toY, toZ, radius, landblockId) {
    return this._live("SweepStatics", fromX, fromY, fromZ, toX, toY, toZ, radius, landblockId) ?? null;
  }

  // ── selection plane (retail slots Select / GetSelected) ────────────
  // Backed by the 3D entity manager, an ENVIRONMENT capability (attaches
  // late — see the header). Retail's Select was one of the few live slots.
  /** @returns {boolean} false when no 3D scene is mounted yet. */
  SelectObject(guid) {
    const em = typeof globalThis !== "undefined" ? globalThis.liveScene3d?.entityManager : null;
    if (typeof em?.setSelectedTarget !== "function") return false;
    const prev = (em.getSelectedTarget?.() ?? 0) >>> 0;
    const next = (guid ?? 0) >>> 0;
    try {
      em.setSelectedTarget(next);
    } catch (_) {
      return false;
    }
    if (next !== prev) {
      try {
        globalThis.__pluginClient?.events?.emit?.("selectionChanged", { guid: next, prevGuid: prev });
      } catch (_) {}
    }
    return true;
  }
  /** Selected object guid, `0` when nothing is selected / no scene. */
  GetSelectedId() {
    const em = typeof globalThis !== "undefined" ? globalThis.liveScene3d?.entityManager : null;
    if (typeof em?.getSelectedTarget !== "function") return 0;
    try {
      return (em.getSelectedTarget() ?? 0) >>> 0;
    } catch (_) {
      return 0;
    }
  }

  // ── UI plane (retail slot 49 + the bar's programmatic panel API) ───
  /** Retail `GetScreenDimensions`. `null` outside a browser. */
  GetScreenDimensions() {
    if (typeof globalThis === "undefined" || typeof globalThis.innerWidth !== "number") return null;
    return { width: globalThis.innerWidth, height: globalThis.innerHeight };
  }
  OpenPanel(pluginId) {
    try {
      return !!globalThis.__barInstance?.openPanel?.(pluginId);
    } catch (_) {
      return false;
    }
  }
  ClosePanel(pluginId) {
    try {
      return !!globalThis.__barInstance?.closePanel?.(pluginId);
    } catch (_) {
      return false;
    }
  }
  GetOpenPanelId() {
    try {
      return globalThis.__barInstance?.openPanelId?.() ?? null;
    } catch (_) {
      return null;
    }
  }

  // ── plugin-manifest wire (GameEvent 0x02AE -> GameAction 0x02AF) ───
  /** Push the `id@version` roster the wasm session answers 0x02AE with. */
  SetPluginList(list) {
    return this._act("SetPluginList", String(list ?? ""));
  }
  /** Roster currently held wasm-side, or `null` when unavailable. */
  GetPluginList() {
    return this._live("GetPluginList") ?? null;
  }
}

export default RynthWebHost;
