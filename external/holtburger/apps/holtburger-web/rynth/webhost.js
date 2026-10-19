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

  // ── 2026-10-12 RynthSuite update (additive; API_VERSION 1.1.0) ─────
  // Direct tell (TellByName). control_channel replied through
  // InvokeChatParser("/t name, text"), which only works while the page's
  // slash router (app/slash_commands.js) is installed: the sendChat
  // fallback is a plain Talk — src/session/commands/social.rs SendChat arm,
  // "`/`-prefixed slash commands are NOT parsed by GameActionTalk" — so the
  // reply would have been SAID ALOUD in local chat.
  SendTell: ["sendTell"],
  // NoLongerViewingContents (0x0195) — the loot window's own close path
  // (plugins/corpse-loot-bar.js, HUD overhaul 2026-10-05).
  CloseContainer: ["noLongerViewingContents"],
  // Typed vendor profile (Wave F.4): what the vendor will BUY from the
  // player — item-type mask + value window (retail
  // VendorProfile::InqAcceptability) — beyond getVendorState's stock list.
  GetVendorProfile: ["getCurrentVendorProfile"],
  // Session end (2026-10-09): a DISCONNECT packet so ACE drops the session
  // at once; without it the next login meets "Account In Use" and ACE
  // drops BOTH sessions. LogOff = retail CharacterLogOff (0xF653).
  Disconnect: ["disconnect"],
  LogOffCharacter: ["logOffCharacter"],
  // Link health: ms since the last inbound message (u32::MAX = none yet).
  GetLastRecvAgeMs: ["sessionLastRecvAgeMs"],
  // Combat slice (2026-10-12): CancelAttack (0x01B7) ends ACE's
  // auto-repeat swing loop (AutoRepeatAttacks defaults ON — one `attack`
  // swings forever); localStickyTarget = the local sticky (melee lock) guid,
  // 0 = none.
  CancelAttack: ["cancelAttack"],
  GetLocalStickyTarget: ["localStickyTarget"],

  // ── 2026-10-12 VTank layer seam (W1-8; additive; API_VERSION 1.2.0) ──
  // SessionHandle methods the wasm already exports that were never mapped
  // (U4-seam §3). Every name verified in pkg/holtburger_web.d.ts this pass.
  // DAT CSpellBase record (Wave F.1): school, category, bitfield, the
  // SelfTargeted flag, metaSpellType — the untargeted-cast allowlist
  // (CastUntargetedSafe) is decided from it. serde Map-shaped.
  GetSpellRecord: ["getSpellRecord"],
  // Every wielded item of a (remote) wielder — hasshield, offhand.
  GetWieldedItems: ["entityWieldedItems"],
  // Use gates (consumables, kits, lockpicks, stones).
  CanUseObject: ["canUseObject"],
  CanUseWith: ["canUseWith"],
  // Fellowship management beyond create/quit/recruit (sub-opcodes 0x00A4,
  // 0x0291, 0x0290, 0x00A6).
  FellowshipDismiss: ["fellowshipDismiss"],
  FellowshipChangeOpenness: ["fellowshipChangeOpenness"],
  FellowshipAssignNewLeader: ["fellowshipAssignNewLeader"],
  FellowshipUpdateRequest: ["fellowshipUpdateRequest"],
  // Allegiance hometown recall (0x02AB) — a nav Recall waypoint.
  RecallAllegianceHometown: ["recallAllegianceHometown"],
  // The /reply target: the last PLAYER who sent a tell (markers trimmed).
  GetLastTellerName: ["lastTellerName"],
  // Retail TurnToObject (rate-limited face-target; no heading math).
  TurnToObject: ["turnToEntity"],

  // ── 2026-10-19 VTank options made live (additive) ─────────────────
  // The Ust (Salvage / CombineSalvage), and the ammo-slot wield paths the
  // inventory panel already drives (missile-ammo refill).
  CreateTinkeringTool: ["createTinkeringTool"],
  SetWielded: ["setWielded"],
  SplitStackToWield: ["splitStackToWield"],
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
  // Portal-space presentation (scene3d/portal_space.js publishes the read;
  // rynth/portal_gate.js prefers this member — see IsPortalSpaceActive).
  IsPortalSpaceActive: () => typeof globalThis.__isPortalSpaceActive === "function",
  // VTank Items/Consumables "Add selected" (W1-8): the inventory panel's
  // selection (plugins/inventory.js publishes window.__inventory.selectedGuid),
  // then the world selection — see GetSelectedItemId.
  GetSelectedItemId: () =>
    !!globalThis.__inventory || typeof globalThis.liveScene3d?.entityManager?.getSelectedTarget === "function",
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

// ClientEvent kinds the host itself consumes (scene3d/client_event_kinds.js,
// generated from src/lib.rs CLIENT_EVENT_KIND_*; inlined because this file
// must keep zero imports — see the P6.1 note above).
const KIND_CONFIRMATION_DONE = 71; // u32 = confirmation type, u32b = context
// ACE ConfirmationManager.confirmationTimeout is 30 s (it then sends
// ConfirmationDone); retained dialogs outlive it slightly as a backstop.
const CONFIRM_TTL_MS = 35_000;

/**
 * The ONE page-wide push-event tap. app/client_events.js forwards every
 * drained ClientEvent to `window.__rynthOnEvent`; every live host is in
 * `window.__rynthEventHosts` and gets each event once.
 *
 * Before 2026-10-12 each host wrapped the previous `__rynthOnEvent` in a new
 * closure and could never leave it, so a `?bot=1` takeover rebind (which
 * builds a fresh bot on the new session) left the dead bot's host in the
 * chain: its control channel kept answering `!bot` tells through a freed
 * handle, and every reconnect made the chain one closure deeper. A host now
 * leaves the set in `dispose()`. A non-host tap that was installed before the
 * first host is kept and still called first.
 */
function installEventTap(host) {
  const w = window;
  let hosts = w.__rynthEventHosts;
  if (!(hosts instanceof Set)) {
    hosts = new Set();
    const prev = typeof w.__rynthOnEvent === "function" ? w.__rynthOnEvent : null;
    w.__rynthEventHosts = hosts;
    w.__rynthOnEvent = (evt) => {
      if (prev) {
        try { prev(evt); } catch (_) {}
      }
      for (const h of Array.from(hosts)) {
        try { h._dispatchEvent(evt); } catch (_) {}
      }
    };
  }
  hosts.add(host);
}

// Shared cast-token clock (02 C3 / synthesis streamline #6): combat's
// CAST_RESOLUTION_TIMEOUT_MS (combat_loop.js) and buff's
// SELF_BUFF_GIVE_UP_MS (buff_loop.js) were two independent `2500` literals
// that happened to agree. This is the one clock the shared token uses to
// self-clear when UseDoneSeq is unavailable/missed; it does not replace
// either module's own internal bookkeeping (P2 awaitingCast, B8 pending),
// which keep their own timeout literals for their own purposes.
// 2026-10-12 (magic slice B2): 2500 -> 12000. UseDone normally clears the
// token first; at 2.5 s the backstop freed it MID-CAST for half the buffs and
// most level-5+ war spells (2.9-4.4 s windups since the August casting-parity
// windup fix; level-8 Incantations ~7 s), letting a second module's cast land
// inside the first one's still-open window.
const CAST_TOKEN_TIMEOUT_MS = 12_000;
// A cast refusal (kind 13) is dispatched after ACE's UseDone moved the count
// on, so the claim it belongs to has usually cleared already (or its owner
// released it early): castOwner() still names a cleared claim's owner while
// the claim is younger than this — a windup and its refusal (2026-10-19:
// combat took the helper's refusals as its own after a release, and a vitals
// claim that was never released kept naming vitals for good).
const CAST_OWNER_WINDOW_MS = 6000;

// Page net-pump staleness (magic slice B1): see RynthWebHost._pumpIfStale.
// Narrowed 2026-10-12 (review #16): a HIDDEN page (rAF stopped) is pumped
// once its frame pump is 200 ms stale; a VISIBLE page only after its pump has
// stalled for a full second (rAF throttled/blocked). A slow but live visible
// page (SwiftShader, ?targetFps=4) keeps its own cadence instead of getting
// extra full pumpNetFrame passes (net drain, panel flush, input pump) between
// its real frames — the cast it delays is at most one of its own frames.
const PUMP_STALE_MS = 200;
const PUMP_STALE_VISIBLE_MS = 1000;

/**
 * serde_wasm_bindgen's default serializer maps every JSON object to a JS
 * `Map`; deep-convert those to plain objects (arrays kept, other values as
 * they are). An already-plain value comes back unchanged.
 */
export function plainFromMaps(v) {
  if (v instanceof Map) {
    const o = {};
    for (const [k, x] of v) o[k] = plainFromMaps(x);
    return o;
  }
  if (Array.isArray(v)) return v.map(plainFromMaps);
  return v;
}

// ── VTank layer seam constants (W1-8, 2026-10-12; PLAN §3.10) ──────────
// Inlined, not imported: this file keeps ZERO imports (see the P6.1 note).

// Item-action token (A19): the item-side twin of the cast token. ACE answers
// an item action with InventoryUpdate (11), UseFailed (13), UseDone (14),
// InventoryActionFailed (48) or a wield transition (47/49); the timeout is
// the backstop when none of them comes.
const ITEM_TOKEN_TIMEOUT_MS = 8_000;
const ITEM_TOKEN_CLEAR_KINDS = new Set([11, 13, 14, 47, 48, 49]);
// Kinds that change what playerInventory() returns (drops the per-seq memo).
const INVENTORY_MEMO_KINDS = new Set([11, 47, 48, 49]);
// One identical seam warning per 10 s (C3 rate limit).
const VT_WARN_INTERVAL_MS = 10_000;
// Spell records are DAT data (one CSpellBase per id) — cached for the page.
const SPELL_RECORD_CACHE_MAX = 8192;
// ≤ 1 RequestId per creature per minute (TryGetCreatureInfo).
const CREATURE_ID_INTERVAL_MS = 60_000;
// An item whose mana was last read by appraisal more than this ago is stale.
const ITEM_MANA_STALE_MS = 60_000;
// Enchantment rows: ACE's "forever" is duration -1; buff_loop.js treats a
// duration above a year as presence-only too (its B6 sentinel).
const PERMANENT_SENTINEL_S = 86_400 * 365;
const ENCH_TYPE_COOLDOWN = 0x1000000; // EnchantmentTypeFlags.Cooldown
const ENCH_TYPE_BENEFICIAL = 0x2000000; // EnchantmentTypeFlags.Beneficial
const SPELL_ID_VITAE = 666;
// PropertyInt / PropertyFloat ids (ACE.Entity/Enum/Properties).
const PINT_ITEM_TYPE = 1;
const PINT_CREATURE_TYPE = 2;
const PINT_ITEM_CUR_MANA = 107;
const PINT_ITEM_MAX_MANA = 108;
const PFLOAT_MANA_RATE = 5;
const ITEM_TYPE_ARMOR = 0x2;
const EQUIP_MASK_SHIELD = 0x200000; // ACE EquipMask.Shield
const ITEM_TYPE_CREATURE = 0x10;
const PLAYER_GUID_MIN = 0x50000000;
const PLAYER_GUID_MAX = 0x5fffffff;

/**
 * THE heading conversion (A14, U4 H4). Every VT API speaks COMPASS DEGREES
 * (0 = north, clockwise); this is the one place they are turned into the wasm
 * convention and back:
 *
 *   TurnToHeading(rad)  rad = norm360(turnSign * compassDeg + turnOffsetDeg) · π/180
 *   pose.heading (rad)  compassDeg = norm360(poseSign * deg(rad) + poseOffsetDeg)
 *
 * The default is the convention today's live code already uses — compass
 * radians straight into TurnToHeading, pose yaw read as a compass bearing
 * (combat_loop.js `_faceGate`; goto_compose.js `attemptJumpLeg`). The d.ts and
 * holtburger-common math.rs document other conventions (U4 §6), so the live
 * probe L-H1 (PLAN §7.4) confirms or corrects THESE four numbers before any
 * heading-bearing VT feature is trusted. Change it here, nowhere else.
 */
export const HEADING_CONVENTION = Object.freeze({ turnSign: 1, turnOffsetDeg: 0, poseSign: 1, poseOffsetDeg: 0 });

function norm360(deg) {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}
function compassDegToTurnRad(deg) {
  const c = HEADING_CONVENTION;
  return (norm360(c.turnSign * deg + c.turnOffsetDeg) * Math.PI) / 180;
}
function poseRadToCompassDeg(rad) {
  const c = HEADING_CONVENTION;
  return norm360((c.poseSign * rad * 180) / Math.PI + c.poseOffsetDeg);
}

/** Me -> pos offset (dx east, dy north, dz) with the combat_loop.js rule
 *  (`_scanTargets`): same landblock, or both outdoors where landblocks tile
 *  the world (global frame = landblock index * 192 + local). Indoor cells of
 *  different landblocks are not world-contiguous -> null. Cell 0 is "no
 *  cell known" (the login/teleport-into-dungeon gap `_tick` heals when it
 *  can), not landblock 0x0000 — it would read as "outdoors at the map's
 *  corner" and give a ~kilometre distance (a false vendor `range` close) ->
 *  null. */
function vtDelta(me, pos) {
  const a = me.objCellId >>> 0;
  const b = pos.objCellId >>> 0;
  if (!a || !b) return null;
  const sameLb = a >>> 16 === b >>> 16;
  const bothOutdoor = (a & 0xffff) < 0x100 && (b & 0xffff) < 0x100;
  if (!sameLb && !bothOutdoor) return null;
  const dz = (Number(pos.z) || 0) - (Number(me.z) || 0);
  if (sameLb) return { dx: pos.x - me.x, dy: pos.y - me.y, dz };
  return {
    dx: (((b >>> 24) & 0xff) - ((a >>> 24) & 0xff)) * 192 + (pos.x - me.x),
    dy: (((b >>> 16) & 0xff) - ((a >>> 16) & 0xff)) * 192 + (pos.y - me.y),
    dz,
  };
}

/**
 * Page-level selection clock (GetSelectedItemId, INT-2 fix 2026-10-13): which
 * selection the player made LAST — the inventory panel's
 * (`hb-inventory-selection` window event, plugins/inventory.js) or the world's
 * (`selectionChanged` on the plugin bus, scene3d/entities.js / SelectObject).
 * The inventory selection is never cleared by a world click, so preferring it
 * unconditionally sent spells at a stale pack item (impl/cmd-review.md §5.1).
 * One clock per page (`globalThis.__rynthSelClock`), shared by every host
 * instance — listeners are attached once, the bus hook again only when the
 * bus object changes (the plugin client attaches after login). Off-page / no
 * event sources ⇒ null and GetSelectedItemId keeps the old order. Never throws.
 * A dynamic-LOD swap of the selected rig (scene3d/entities.js) releases it
 * (`{guid: 0, lodRespawn: true}`) and re-selects the SAME guid a tick later:
 * the player selected nothing new, so neither half is stamped.
 */
function selectionClock() {
  try {
    const g = globalThis;
    let c = g.__rynthSelClock;
    if (!c || typeof c !== "object") {
      c = { seq: 0, invAt: 0, worldAt: 0, invHooked: false, bus: null, lodGuid: 0 };
      g.__rynthSelClock = c;
    }
    if (!c.invHooked && typeof g.addEventListener === "function") {
      g.addEventListener("hb-inventory-selection", () => {
        c.invAt = ++c.seq;
      });
      c.invHooked = true;
    }
    const bus = g.__pluginClient?.events;
    if (bus && c.bus !== bus && typeof bus.on === "function") {
      bus.on("selectionChanged", (e) => {
        // The bus delivers a CustomEvent: the payload is `e.detail`
        // (plugins/api.js events.emit; picking.js / target-bar.js read it the
        // same way). Reading `e.guid` saw undefined on every event, so the
        // LOD-respawn pair below never matched and stamped the world clock
        // twice. A raw payload (no `.detail`) is still accepted.
        const d = (e && e.detail) ?? e;
        const guid = Number(d && d.guid) >>> 0;
        if (d && d.lodRespawn === true) {
          c.lodGuid = Number(d.prevGuid) >>> 0; // the LOD release half
          return;
        }
        if (c.lodGuid && guid === c.lodGuid) {
          c.lodGuid = 0; // ... and its re-select of the same guid
          return;
        }
        c.lodGuid = 0;
        c.worldAt = ++c.seq;
      });
      c.bus = bus;
    }
    return c;
  } catch (_) {
    return null;
  }
}

const finiteOr = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const firstBool = (...vs) => {
  for (const v of vs) if (typeof v === "boolean") return v;
  return undefined;
};

/** Normalise a (plain) getSpellRecord result (A4). The wasm carries the
 *  SelfTargeted bit three ways — top-level `isSelfTargeted`, `flags.selfTargeted`
 *  (what ui/ac_cast_spell.js reads) and the raw `bitfield & 0x8` — and old
 *  bundles / fakes carry only some of them (U4 row 15 shape drift). */
function normalizeSpellRecord(r, id) {
  const flags = r.flags && typeof r.flags === "object" ? r.flags : null;
  const bitfield = finiteOr(r.bitfield, 0) >>> 0;
  const nctt = r.nonComponentTargetType;
  return Object.freeze({
    id: finiteOr(r.id, id) >>> 0,
    name: typeof r.name === "string" ? r.name : "",
    school: finiteOr(r.school, 0),
    category: finiteOr(r.category, 0),
    bitfield,
    isSelfTargeted: firstBool(r.isSelfTargeted, flags?.selfTargeted) ?? (bitfield & 0x8) !== 0,
    isUntargeted: firstBool(r.isUntargeted) ?? (typeof nctt === "number" ? nctt === 0 : false),
    isBeneficial: firstBool(r.isBeneficial, flags?.beneficial) ?? (bitfield & 0x4) !== 0,
    metaSpellType: finiteOr(r.metaSpellType, 0),
    duration: finiteOr(r.duration, 0),
    roughLevel: finiteOr(r.roughLevel, 0),
    baseRangeConstant: finiteOr(r.baseRangeConstant, 0),
    baseRangeMod: finiteOr(r.baseRangeMod, 0),
    // the spell's difficulty ("power": 1, 50, 100 … 400 for an Incantation;
    // debuffs sit 25 above their tier) — VTank's SpellDiffExcessThreshold
    // and the ReadUnknownScrolls skill check read it (2026-10-19).
    power: finiteOr(r.power, 0),
  });
}

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
    this._workerUrl = null;
    this._castToken = null; // { owner, issuedAt, useDoneAtIssue } — 02 C3 shared serializer
    this._lastCast = null; // { owner, issuedAt } of the last cleared claim — castOwner()
    this._confirms = []; // retained server confirmation dialogs (TryGetPendingConfirmations)
    // Join the push-event tap: the page's dispatchClientEvent forwards each
    // drained ClientEvent here (app/client_events.js). Events are the PUSH
    // complement to the poll snapshot — chat, kill notices, use-done — that
    // a pure poller would miss or need to reconstruct. See installEventTap.
    if (typeof window !== "undefined" && !opts.noEventTap) installEventTap(this);
    // Start the page's selection clock early so selections made before the
    // first GetSelectedItemId() are ordered too (no-op off-page).
    if (typeof window !== "undefined") selectionClock();
  }

  /**
   * Retire this host: stop the heartbeat, leave the page event tap and drop
   * every subscriber. Call it when the bot that owns the host is replaced
   * (a reconnect rebind) — a stopped-but-subscribed host keeps answering
   * events through its dead session. Idempotent.
   */
  dispose() {
    this.stop();
    this._stopped = true;
    try {
      globalThis.__rynthEventHosts?.delete?.(this);
    } catch (_) {}
    this._onEvent = [];
    this._onTick = [];
    this._disposed = true;
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
    // Per-session state: a cast claim or a dialog from the previous session
    // can never resolve on the new one.
    this._castToken = null;
    this._lastCast = null;
    this._confirms = [];
    // VTank seam per-session state (W1-8): an item claim, the per-seq
    // inventory memo, the enchantment receipt book and the appraisal rate
    // limiter all describe the previous session. Spell records are DAT data
    // and survive.
    this._itemToken = null;
    this._itemClaims = new Map();
    this._invMemo = null;
    this._roomMemo = null;
    this._enchReceived = new Map();
    this._creatureIdAt = new Map();
    // A fellow-vitals hold that outlived the old session (the helper, or an
    // open fellowship panel — one shared count) asks the new one again: ACE's
    // FellowshipPanelOpen flag is per session.
    if ((Number(globalThis.__hbFellowUpdateRefs) || 0) > 0) this.FellowshipRequestUpdates(true);
    return this;
  }

  // ── push-event plane (report 04) ────────────────────────────────────
  onEvent(fn) {
    this._onEvent.push(fn);
  }
  _dispatchEvent(evt) {
    // A stopped/disposed bot host hears nothing (its loops would act through
    // a session that is gone or no longer theirs).
    if (this._stopped) return;
    // Normalize the wasm ClientEvent into a plain object once — synchronously:
    // app/client_events.js frees the box right after the taps return.
    const e = {
      kind: evt.kind,
      text: evt.stringPayload ?? null,
      u32: evt.u32Payload ?? 0,
      u32b: evt.u32Payload2 ?? 0,
      f32: evt.f32Payload ?? null,
    };
    // The server closed (answered / timed out) a confirmation dialog.
    if (e.kind === KIND_CONFIRMATION_DONE) this._retireConfirm(e.u32 >>> 0, e.u32b >>> 0);
    // VTank seam (W1-8): resolve the item-action token and drop the per-seq
    // inventory memo BEFORE subscribers run, so a subscriber reacting to this
    // very event can claim the next action / read the new inventory.
    if (ITEM_TOKEN_CLEAR_KINDS.has(e.kind)) this._noteItemActionEvent(e);
    if (INVENTORY_MEMO_KINDS.has(e.kind)) {
      this._invMemo = null;
      this._roomMemo = null;
    }
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
      this._noteCastCleared(t);
      return false;
    }
    if (Date.now() - t.issuedAt > CAST_TOKEN_TIMEOUT_MS) {
      this._noteCastCleared(t);
      return false;
    }
    return true;
  }
  _noteCastCleared(t) {
    this._castToken = null;
    this._lastCast = { owner: t.owner, issuedAt: t.issuedAt };
  }
  /** Claim the shared cast token. Call immediately before issuing a cast.
   *  Returns true if the caller may cast now — the token was free, or
   *  already held by this SAME owner (a module re-arming its own still-open
   *  cast doesn't self-block). Returns false when a DIFFERENT owner holds
   *  an unresolved claim; the caller must skip casting this tick. */
  tryClaimCast(owner) {
    if (this._castTokenLive()) return this._castToken.owner === owner;
    this._lastCast = null; // a new cast owns whatever is refused next
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
    if (this._castToken && this._castToken.owner === owner) this._noteCastCleared(this._castToken);
  }
  /** Read-only status snapshot for diagnostics (`__diag`-style callers) — a
   *  RAW read: a claim lingers until the next tryClaimCast. Refusal
   *  attribution reads castOwner(). */
  get castToken() {
    return this._castToken ? { ...this._castToken } : null;
  }
  /** Who a cast refusal arriving now belongs to: the live claim's owner, else
   *  the owner of the last claim while it is younger than CAST_OWNER_WINDOW_MS
   *  (cleared by its UseDone or released early — the refusal still comes);
   *  null when nobody cast lately. Refusal handlers (combat, vitals, the
   *  planner, the helper, ammo) drop a refusal whose owner isn't theirs. */
  castOwner(now = Date.now()) {
    if (this._castTokenLive()) return this._castToken.owner;
    const last = this._lastCast;
    return last && now - last.issuedAt <= CAST_OWNER_WINDOW_MS ? last.owner : null;
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
    // Kept so stop() can revoke it — every start() used to leak one Blob URL
    // (a reconnect rebind or a HUD stop/start cycle starts the host again).
    this._workerUrl = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    this._worker = new Worker(this._workerUrl);
    this._worker.onmessage = () => this._tick();
    this._worker.postMessage({ cmd: "start", ms });
    this._stopped = false;
  }
  stop() {
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
      // A bot whose heartbeat was stopped (bot.stop(), a takeover rebind)
      // must not keep reacting to the push plane — see _dispatchEvent. Only
      // a heartbeat that actually ran latches it: the plugin facade's host
      // never starts one, and its subscribers stay live.
      this._stopped = true;
    }
    if (this._workerUrl) {
      try { URL.revokeObjectURL(this._workerUrl); } catch (_) {}
      this._workerUrl = null;
    }
  }
  /** True while the heartbeat worker runs (start() called, stop() not). */
  get running() {
    return !!this._worker;
  }
  onTick(fn) {
    this._onTick.push(fn);
  }

  /**
   * Keep the page's net/movement pump alive while the bot runs (magic slice
   * B1, 2026-10-12). Since 457f9de1 / fef31a95 a cast or attack queues a
   * retail stop-completely and the action goes out only after the NEXT
   * movement tick (session/commands/combat.rs → movement/system.rs), and with
   * cmdInterp on by default only the page frame pump drives that tick
   * (app/frame_pump.js; scene3d phase #0) — the wasm loop itself has just a
   * 5 s keepalive. In a hidden/background tab without ?netDrainHz the rAF pump
   * stops, so a bot's casts and attacks were never sent at all. The bot's own
   * heartbeat is a Worker (not throttled), so it pumps whenever the page pump
   * (`window.__lastPumpMs`, performance.now() domain, stamped by
   * pumpNetFrame) is stale — PUMP_STALE_MS on a hidden page,
   * PUMP_STALE_VISIBLE_MS (a stalled rAF) on a visible one:
   * `window.__netFramePump()`, else the bare tickMovement. Not a page (node
   * harness) -> no-op. Never throws.
   */
  _pumpIfStale() {
    if (typeof window === "undefined") return;
    try {
      const now = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
      const last = window.__lastPumpMs;
      const hidden = typeof document !== "undefined" && !!document && document.hidden === true;
      const staleAfter = hidden ? PUMP_STALE_MS : PUMP_STALE_VISIBLE_MS;
      if (typeof last === "number" && now - last < staleAfter) return;
      if (typeof window.__netFramePump === "function") {
        window.__netFramePump();
        this._pumps = (this._pumps | 0) + 1;
        return;
      }
      const tick = this._m.TickMovement;
      if (tick) {
        tick();
        this._pumps = (this._pumps | 0) + 1;
      }
    } catch (_) {
      /* a failing pump must never kill the heartbeat */
    }
  }

  _tick() {
    this._pumpIfStale();
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
    if (this.snap) return this.snap.playerGuid;
    // No heartbeat yet (a host used before start(), or a harness that never
    // ticks it): read the guid live instead of answering 0 — the casters gate
    // on a real guid (no guid = no cast, because an untargeted fallback can
    // crash ACE; see buff_loop._castSelfBuff).
    const v = this._live("GetPlayerId");
    return typeof v === "number" ? v >>> 0 : 0;
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
  /** NOTE (magic slice, 2026-10-12): GetCastBusyState is set only by the
   *  page's JS cast chain (noteLocalCastWindow), never by a bot cast — it is
   *  always 0 for rynth's own casts. Casters gate on GetBusyState() === 0
   *  (the outstanding-request count) and resolve on the registry / UseDone /
   *  a kind=13 refusal, never on this. */
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
  /// The wasm read (`objectDescFlags`, src/lib.rs) is `u32`, `0` for an
  /// UNKNOWN guid (`unwrap_or(0)`) — it never answers undefined — so a 0 only
  /// counts as data when the entity itself is tracked (`objectName` answers
  /// `undefined` for an unknown guid). Absent capability -> false. This is the
  /// web analogue of C#'s `HasObjectIsAttackable` capability guard
  /// (CombatManager.cs:610), which lets attackability degrade-open rather
  /// than fail-closed on missing data. (Corrected 2026-10-12: the old doc
  /// claimed an undefined answer, so this read true for every guid.)
  HasObjectDescFlags(guid) {
    const flags = this._live("GetObjectDescFlags", guid);
    if (typeof flags !== "number") return false;
    if (flags !== 0) return true;
    return this._live("GetObjectName", guid) != null;
  }
  /// Report 11 T2 filter class: attackable per the spawn description flags
  /// (0x10). FAIL-OPEN when the flags are GENUINELY ABSENT (see
  /// HasObjectDescFlags) — RynthAi's anti-stall discipline:
  /// `if (HasObjectIsAttackable && !ObjectIsAttackable(id)) continue;`
  /// (CombatManager.cs:610) only excludes a target when the flags ARE present
  /// AND the attackable bit is clear (report 11 T4; b5.md combat T4). A
  /// tracked object with flags 0 is a real "not attackable" (vendors/NPCs
  /// stay excluded); an untracked guid fails open, as designed.
  ObjectIsAttackable(guid) {
    if (!this.HasObjectDescFlags(guid)) return true; // flags absent -> fail-open
    const flags = this._live("GetObjectDescFlags", guid) >>> 0;
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
          // the helper's percentages need the maxima too (2026-10-19); the
          // vitals only flow while someone asked for them
          // (FellowshipRequestUpdates — ACE Fellowship.cs FellowshipPanelOpen).
          maxStamina: Number(m.maxStamina ?? 0),
          maxMana: Number(m.maxMana ?? 0),
          // ACE's FullUpdate writes a constant here (GameEventFellowshipFullUpdate
          // "TODO: shareLoot"): a hint, never the loot permission itself.
          shareLoot: !!m.shareLoot,
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
  ///
  /// NON-destructive (2026-10-12). The wasm `pendingConfirmations()` is a
  /// DRAIN, and two rynth callers read it: the AI observation
  /// (observe_ext.js probeConfirmations, every check-in) and the director's
  /// `confirm` action (tools/world.js). The observation drained the dialog, so
  /// the `confirm` that followed always found nothing ("no confirmation dialog
  /// is pending"). The host is now the only drainer and RETAINS each dialog
  /// until it is answered here, the server closes it (kind=71
  /// ConfirmationDone, see _dispatchEvent), or CONFIRM_TTL_MS passes.
  TryGetPendingConfirmations() {
    const now = Date.now();
    const raw = plainFromMaps(this._live("GetPendingConfirmations"));
    if (Array.isArray(raw)) {
      for (const c of raw) {
        try {
          const row = {
            confirmType: Number(c.confirmType ?? c.confirm_type ?? 0) >>> 0,
            context: Number(c.context ?? 0) >>> 0,
            text: String(c.text ?? ""),
            receivedAt: now,
          };
          // A re-sent (type, context) replaces the old row rather than doubling it.
          this._retireConfirm(row.confirmType, row.context);
          this._confirms.push(row);
        } catch (_) {
          /* a bad row degrades to fewer dialogs */
        }
      }
    }
    this._confirms = this._confirms.filter((c) => now - c.receivedAt < CONFIRM_TTL_MS);
    return this._confirms.map(({ confirmType, context, text }) => ({ confirmType, context, text }));
  }
  _retireConfirm(confirmType, context) {
    if (!this._confirms.length) return;
    this._confirms = this._confirms.filter((c) => !(c.confirmType === confirmType && c.context === context));
  }

  // ── inventory / economy reads (2026-07-17) ──────────────────────────
  /// Plain-object projection of SessionHandle.playerInventory()
  /// (Array<InventoryItem>, src/lib.rs) — wasm-bindgen rows copied field-
  /// by-field so callers never hold wasm handles. [] pre-spawn / on error.
  ///
  /// `containerId` is 0 for the MAIN pack (and worn items) and the side
  /// pack's guid otherwise — the wasm maps the player's own guid to 0
  /// (src/lib.rs inventory snapshot builder). `requiresBackpackSlot` marks a
  /// CONTAINER-slot item (a pack/focus — retail UseBackpackSlot), not "takes
  /// an item slot". Each InventoryItem box is freed once copied (2026-10-12;
  /// loot's CONFIRM polls this every tick).
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
          maxStackSize: Number(it.maxStackSize ?? 0),
          equipMask: (it.equipMask ?? 0) >>> 0,
          validLocations: (it.validLocations ?? 0) >>> 0,
          itemType: (it.itemType ?? 0) >>> 0,
          containerId: (it.containerId ?? 0) >>> 0,
          placement: Number(it.placement ?? -1),
          itemsCapacity: Number(it.itemsCapacity ?? 0),
          containersCapacity: Number(it.containersCapacity ?? 0),
          requiresBackpackSlot: !!it.requiresBackpackSlot,
          // PropertyInt Attuned (114) / Bonded (33). observe_ext.js's item
          // tags and tools/world.js's drop_item guard read these; they were
          // never projected, so both were dead on live data (2026-10-12).
          attuned: Number(it.attuned ?? 0) | 0,
          bonded: Number(it.bonded ?? 0) | 0,
          // PropertyInt AmmoType (50): a launcher's and its ammo's must match
          // exactly (ACE Player_Inventory.cs) — the missile-ammo refill reads
          // it; weaponSkill tells a bow from a crossbow (2026-10-19).
          ammoType: Number(it.ammoType ?? 0) >>> 0,
          weaponSkill: Number(it.weaponSkill ?? 0) >>> 0,
        });
      } catch (_) {
        /* one bad row must not drop the snapshot */
      }
      try { it?.free?.(); } catch (_) { /* already released */ }
    }
    return out;
  }
  /// Room in the player's own packs, per container — the retail rule the
  /// client's vendor/loot windows use (plugins/inventory_helpers.js
  /// packCapacity): main pack = non-pack items directly on the player vs
  /// SessionHandle.playerItemsCapacity; container slots = top-level packs vs
  /// playerContainersCapacity (retail 102 / 7 until the stats land); each
  /// side pack = its contents vs its own ItemsCapacity. null until the
  /// inventory streams.
  /// -> { main:{used,cap,free}, containers:{used,cap,free},
  ///      packs:[{guid,name,used,cap,free}], freeItemSlots }
  TryGetPackRoom() {
    return this._packRoomFrom(this.TryGetPlayerInventory());
  }
  // The TryGetPackRoom computation over an inventory projection (shared with
  // TryGetPackRoomCached, which feeds it the per-seq memo).
  _packRoomFrom(inv) {
    if (!inv.length) return null;
    const readCap = (prop, dflt) => {
      try {
        const c = this.s[prop];
        if (typeof c === "number" && Number.isFinite(c) && c > 0) return c;
      } catch (_) {}
      return dflt;
    };
    const mainCap = readCap("playerItemsCapacity", 102);
    const contCap = readCap("playerContainersCapacity", 7);
    let mainUsed = 0;
    let contUsed = 0;
    const packs = new Map();
    for (const i of inv) {
      if (i.equipMask !== 0) continue;
      if (i.containerId === 0) {
        if (i.requiresBackpackSlot) {
          contUsed++;
          if (i.itemsCapacity > 0) packs.set(i.guid, { guid: i.guid, name: i.name, used: 0, cap: i.itemsCapacity });
        } else {
          mainUsed++;
        }
      }
    }
    for (const i of inv) {
      const p = i.containerId !== 0 ? packs.get(i.containerId) : null;
      if (p) p.used++;
    }
    const packList = [...packs.values()].map((p) => ({ ...p, free: Math.max(0, p.cap - p.used) }));
    const main = { used: mainUsed, cap: mainCap, free: Math.max(0, mainCap - mainUsed) };
    return {
      main,
      containers: { used: contUsed, cap: contCap, free: Math.max(0, contCap - contUsed) },
      packs: packList,
      freeItemSlots: main.free + packList.reduce((s, p) => s + p.free, 0),
    };
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
  /// Free item slots, AGGREGATE across the main pack + side packs
  /// (TryGetPackRoom().freeItemSlots). null until the inventory streams.
  /// (observe_ext.js probes this exact name — FREE_SLOT_GETTERS; loot_loop
  /// pauses looting at 0.)
  ///
  /// Fixed 2026-10-12: the old formula subtracted the count of
  /// `requiresBackpackSlot` rows — the PACKS, not the items — from a
  /// capacity that included every pack, so it read ~100+ free however full
  /// the character was (the director never saw a full pack, and the loot loop
  /// kept issuing pickups ACE refused). Per-container math works now:
  /// containerId separates main-pack rows (0) from side-pack rows.
  TryGetFreeSlots() {
    const room = this.TryGetPackRoom();
    return room ? room.freeItemSlots : null;
  }
  /// Vendor stock snapshot (plain objects) — populated after the vendor's
  /// profile lands (UseObject on the vendor triggers it). null until then.
  ///
  /// PRICE DIRECTION (plugins/commerce_logic.js "THE DIRECTION TRAP", fixed
  /// in the vendor UI 2026-10-05): `buyMultiplier` is what the VENDOR PAYS
  /// when it buys from the player (~0.5–0.9); `sellMultiplier` is what it
  /// CHARGES the player (~1.35–1.7). A purchase is priced with
  /// sellMultiplier (retail ShopSystem::SellPrice), a sale with buyMultiplier.
  /// The VendorStateJs box and each VendorItemJs box are freed once copied.
  TryGetVendorState(vendorGuid) {
    const v = this._live("GetVendorState", vendorGuid);
    if (!v) return null;
    const items = [];
    let out = null;
    try {
      // `items` is a getter that builds a fresh array of fresh boxes.
      const rows = v.items || [];
      for (const it of rows) {
        try {
          items.push({
            itemGuid: (it.itemGuid ?? 0) >>> 0,
            name: it.name ?? "",
            wcid: (it.wcid ?? 0) >>> 0,
            value: Number(it.value ?? 0),
            stackSize: Number(it.stackSize ?? 1),
            maxStackSize: it.maxStackSize == null ? null : Number(it.maxStackSize),
            itemType: (it.itemType ?? 0) >>> 0,
            // -1 / 0 = unlimited (ACE); a positive count bounds a purchase.
            supply: it.supply == null ? null : Number(it.supply),
            packSlot: typeof it.packSlot === "boolean" ? it.packSlot : null,
          });
        } catch (_) {
          /* partial profile degrades to fewer rows */
        }
        try { it?.free?.(); } catch (_) {}
      }
      out = {
        vendorGuid: (v.vendorGuid ?? vendorGuid) >>> 0,
        vendorName: v.vendorName ?? "",
        buyMultiplier: Number(v.buyMultiplier ?? 1),
        sellMultiplier: Number(v.sellMultiplier ?? 1),
        items,
      };
    } catch (_) {
      out = null;
    }
    try { v?.free?.(); } catch (_) {}
    return out;
  }
  /// Typed vendor profile (SessionHandle.getCurrentVendorProfile, Wave F.4)
  /// as a plain object: {vendorGuid, vendorName, buyAcceptCategories,
  /// buyAcceptCategoryNames, dealsMagic, minValue, maxValue, hasNoMin,
  /// hasNoMax, buyMultiplier, sellMultiplier, stock:[…]}. What the vendor
  /// will BUY (retail VendorProfile::InqAcceptability's inputs). null until
  /// the vendor has been opened / when the capability is absent.
  TryGetVendorProfile(vendorGuid) {
    const p = plainFromMaps(this._live("GetVendorProfile", vendorGuid >>> 0));
    return p && typeof p === "object" ? p : null;
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
  /** Stop ACE's auto-repeat attack loop (CancelAttack 0x01B7). */
  CancelAttack() {
    return this._act("CancelAttack");
  }
  ChangeCombatMode(mode) {
    return this._act("ChangeCombatMode", mode);
  }
  CastSpell(targetGuid, spellId) {
    if (!targetGuid) {
      // A3b (W1-8, U4 H1): a falsy target silently became an UNTARGETED
      // cast, and an untargeted non-SelfTargeted enchantment reaches ACE's
      // CreateEnchantment(null) (WorldObject_Magic.cs:279-285 -> :406) — a
      // server crash. When spell records are available the untargeted form is
      // allowed only for a SelfTargeted spell (ACE substitutes the caster,
      // :261 — every recall/sending spell the bot casts this way is one).
      // A host without the capability (old pkg/, test fakes) keeps today's
      // pass-through.
      if (this.has("GetSpellRecord")) {
        const rec = this.TryGetSpellRecord(spellId);
        if (!rec || !rec.isSelfTargeted) {
          const id = Number(spellId) >>> 0;
          this._vtWarn(
            rec
              ? `refused untargeted cast ${id} (${rec.name}): not SelfTargeted`
              : `refused untargeted cast ${id}: no spell record`
          );
          return false;
        }
      }
      return this._act("CastUntargetedSpell", spellId);
    }
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
  /** The local player's sticky (melee-lock) target guid — 0 when none
   *  (always 0 while the wasm sticky manager is off); null when the
   *  capability is absent. Live read. */
  TryGetLocalStickyTarget() {
    const v = this._live("GetLocalStickyTarget");
    return typeof v === "number" ? v >>> 0 : null;
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
          // R-chat (2026-10-08): a routed echo may carry its chat category
          // (the soul-emote `You …` line is EMOTE); most routes echo nothing.
          if (echo) this.WriteToChatWindow(echo, routed.error ? 10 : (typeof routed.category === "number" ? routed.category : null));
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
  /**
   * Private tell to `name` (TellByName — ACE resolves the name server-wide).
   * Falls back to the routed `/t name, text` chat-bar path, which reaches the
   * same wasm sendTell when the page's slash router is installed. Never falls
   * through to a plain say. @returns {boolean} sent
   */
  SendTell(name, text) {
    const who = String(name ?? "").trim();
    const msg = String(text ?? "");
    if (!who || !msg) return false;
    if (this._m.SendTell) return this._act("SendTell", who, msg);
    const route = typeof globalThis !== "undefined" ? globalThis.__routeSlashCommand : null;
    if (typeof route !== "function") return false;
    try {
      const routed = route(this.s, `/t ${who}, ${msg}`);
      return !!(routed && routed.dispatched && !routed.error);
    } catch (_) {
      return false;
    }
  }
  /** Close a container we were viewing (NoLongerViewingContents). */
  CloseContainer(containerGuid) {
    return this._act("CloseContainer", containerGuid >>> 0);
  }
  /** End the session cleanly (DISCONNECT) — call before a page goes away. */
  Disconnect() {
    return this._act("Disconnect");
  }
  /** Retail log-off (CharacterLogOff): save + leave the world. */
  LogOffCharacter() {
    return this._act("LogOffCharacter");
  }
  /** ms since the last inbound server message; null when unknown/none yet. */
  TryGetLastRecvAgeMs() {
    const v = this._live("GetLastRecvAgeMs");
    return typeof v === "number" && Number.isFinite(v) && v < 0xffffffff ? v : null;
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
  /// from TryGetPendingConfirmations. A sent answer retires the retained row.
  /// NOTE: the player-facing Yes/No modal (plugins/server-confirm.js, default
  /// on since crafting-1 2026-10-08) is driven by the kind=70 event, not this
  /// queue — it stays open until ACE's ConfirmationDone or its own timeout.
  SendConfirmationResponse(confirmType, context, accepted) {
    const ok = this._act("SendConfirmationResponse", confirmType >>> 0, context >>> 0, !!accepted);
    if (ok) this._retireConfirm(confirmType >>> 0, context >>> 0);
    return ok;
  }

  // ── advancement plane (2026-07-17) ──────────────────────────────────
  /// Normalized character-advancement snapshot from SessionHandle.playerStats()
  /// (PlayerStatsSnapshot: flat stride arrays). null until the stats plane
  /// hydrates. unspentXp reassembles the levelInfo lo/hi u32 pair into a
  /// Number (XP stays well under MAX_SAFE_INTEGER). (advancement.js/observe_ext
  /// read this exact shape.)
  ///
  /// `nextCost` (XP to the next rank; 0 = max rank) rides every skill, and —
  /// since training-3 (2026-10-08) added the stride-5 `attributeXp` /
  /// `vitalXp` arrays `[type, ranks, start, spent_xp, next_rank_cost]` —
  /// every attribute and vital too (undefined on an older pkg/). ACE REFUSES
  /// (not caps) a raise larger than the XP left to max rank
  /// (Player_Attributes.cs SpendAttributeXp). The PlayerStatsSnapshot box is
  /// freed once read — its getters return copies (`.slice()`), and the
  /// plugin facade's `client.player.stats` frees it for the same reason.
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
      const ax = ps.attributeXp || [];
      for (let i = 0; i + 4 < ax.length; i += 5) {
        const row = attributes[ax[i]];
        if (row) { row.spentXp = ax[i + 3]; row.nextCost = ax[i + 4]; }
      }
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
      const vx = ps.vitalXp || [];
      for (let i = 0; i + 4 < vx.length; i += 5) {
        const row = vitals[vx[i]];
        if (row) { row.spentXp = vx[i + 3]; row.nextCost = vx[i + 4]; }
      }
    } catch (_) {}
    try {
      const li = ps.levelInfo || [];
      level = li[0] >>> 0;
      unspentXp = (li[3] >>> 0) + (li[4] >>> 0) * 4294967296;
    } catch (_) {}
    try { ps.free?.(); } catch (_) { /* already released */ }
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
   *  is the frozen per-tick read (design §2.4). A plain copy: the
   *  LocalPlayerPose box is freed here (2026-10-12 — it was handed out raw,
   *  and no caller freed it). */
  TryGetPlayerPoseLive() {
    const box = this._live("GetPlayerPose");
    if (!box) return null;
    let pose = null;
    try {
      pose = {
        landblockId: box.landblockId >>> 0,
        x: box.x,
        y: box.y,
        z: box.z,
        heading: box.heading ?? null,
        isOnGround: typeof box.isOnGround === "boolean" ? box.isOnGround : null,
      };
    } catch (_) {
      pose = null;
    }
    try { box.free?.(); } catch (_) {}
    return pose;
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
  // The three char-gen getters serialize a serde_json value through
  // serde_wasm_bindgen, whose default turns every JSON object into a JS
  // `Map`; the wizard reads plain objects (`catalog.heritages`,
  // `area.startAreaId`, …), so with real data `openWizard` saw no heritages
  // and refused to open (2026-10-09, found on the 1070 from the new character
  // screen). Plain objects here; an already-plain value passes through.
  TryGetCharacterGenCatalog() {
    return plainFromMaps(this._live("GetCharacterGenCatalog")) ?? null;
  }
  TryGetSkillCostsForHeritage(heritageId, skillId) {
    return plainFromMaps(this._live("GetSkillCostsForHeritage", heritageId, skillId)) ?? null;
  }
  TryGetCharacterGenAppearanceStrips(heritageId, genderId) {
    return plainFromMaps(this._live("GetCharacterGenAppearanceStrips", heritageId, genderId)) ?? null;
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

  // ── portal space (environment capability, 2026-10-12) ──────────────
  /** True while the client shows portal space — the teleport tunnel through
   *  the world fade-in, including 0d06b92e's destination-build hold
   *  (scene3d/portal_space.js `__isPortalSpaceActive`). Movers hold while it
   *  is up (rynth/portal_gate.js). Absent page seam / throw -> false. */
  IsPortalSpaceActive() {
    try {
      return globalThis.__isPortalSpaceActive?.() === true;
    } catch {
      return false;
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

  // ═══════════════════════════════════════════════════════════════════
  // VTank layer seam (W1-8, 2026-10-12) — PLAN §3.10 A1-A21. Purely
  // additive: no existing member changes meaning except the A3b guard in
  // CastSpell above. Every read degrades to its documented fallback
  // (null / [] / false) and never throws; every wasm box is copied, then
  // freed exactly once.
  // ═══════════════════════════════════════════════════════════════════

  /** One warning per identical text per VT_WARN_INTERVAL_MS. */
  _vtWarn(msg) {
    try {
      const now = Date.now();
      const seen = this._vtWarned || (this._vtWarned = new Map());
      const last = seen.get(msg);
      if (last != null && now - last < VT_WARN_INTERVAL_MS) return;
      if (seen.size >= 256) seen.clear();
      seen.set(msg, now);
      (console.warn || console.log)(`[RynthWebHost] ${msg}`);
    } catch (_) {
      /* logging must never break a caller */
    }
  }

  // ── A1-A3 the cast choke point (C6, V-3) ───────────────────────────
  /**
   * Targeted cast. NEVER falls through to an untargeted cast: a zero/absent
   * target is refused (false + a rate-limited warning), unlike legacy
   * `CastSpell`, whose falsy target meant "untargeted" (U4 H1).
   * @returns {boolean} sent
   */
  CastSpellAt(targetGuid, spellId) {
    const g = Number(targetGuid) >>> 0;
    const id = Number(spellId) >>> 0;
    if (!g) {
      this._vtWarn(`refused targeted cast ${id}: no target guid`);
      return false;
    }
    if (!id) {
      this._vtWarn(`refused targeted cast on ${g}: no spell id`);
      return false;
    }
    return this._act("CastSpell", g, id);
  }
  /** Self cast, targeted at the player's own guid (retail self-cast wire;
   *  the facade's selfTargetGuidFor does the same). No guid -> refused. */
  CastSelf(spellId) {
    const me = Number(this.GetPlayerId()) >>> 0;
    if (!me) {
      this._vtWarn(`refused self cast ${Number(spellId) >>> 0}: player guid unknown`);
      return false;
    }
    return this.CastSpellAt(me, spellId);
  }
  /**
   * The ONLY untargeted cast VT code may issue. Allowed when the DAT record
   * says SelfTargeted (ACE's HandleCastSpell substitutes the caster,
   * WorldObject_Magic.cs:261 — recalls, sendings, self buffs), or — only with
   * `allowRing` — for a War/Void Projectile ring whose formula is untargeted
   * and that is not beneficial. Refused: no record, fellowship meta types
   * 11-14 (SelfTargeted fellowship spells exist, e.g. 2981-2983, and ACE does
   * NOT substitute the caster for them — critic S3), and everything else.
   * @param {number} spellId
   * @param {{allowRing?: boolean}} [opts]
   * @returns {boolean} sent
   */
  CastUntargetedSafe(spellId, opts = {}) {
    const id = Number(spellId) >>> 0;
    if (!id) return false;
    const allowRing = !!(opts && opts.allowRing);
    const rec = this.TryGetSpellRecord(id);
    if (!rec) {
      this._vtWarn(`refused untargeted cast ${id}: no spell record`);
      return false;
    }
    const mst = rec.metaSpellType;
    if (mst >= 11 && mst <= 14) {
      this._vtWarn(`refused untargeted cast ${id} (${rec.name}): fellowship spell`);
      return false;
    }
    if (rec.isSelfTargeted) return this._act("CastUntargetedSpell", id);
    if (allowRing && mst === 2 && rec.isUntargeted && (rec.school === 1 || rec.school === 5) && !rec.isBeneficial) {
      return this._act("CastUntargetedSpell", id);
    }
    this._vtWarn(`refused untargeted cast ${id} (${rec.name}): not SelfTargeted`);
    return false;
  }

  // ── A4 spell records ───────────────────────────────────────────────
  /**
   * Normalised DAT spell record, or null (capability absent, WorldBootstrap
   * not loaded yet, unknown id). Frozen; cached per id — only HITS are cached,
   * because a pre-EnteredWorld miss turns into a hit once the table loads.
   * Shape: {id, name, school, category, bitfield, isSelfTargeted,
   * isUntargeted, isBeneficial, metaSpellType, duration, roughLevel,
   * baseRangeConstant, baseRangeMod}.
   */
  TryGetSpellRecord(spellId) {
    const id = Number(spellId) >>> 0;
    if (!id) return null;
    const cache = this._spellRecords || (this._spellRecords = new Map());
    const hit = cache.get(id);
    if (hit) return hit;
    let raw;
    try {
      raw = plainFromMaps(this._live("GetSpellRecord", id));
    } catch (_) {
      raw = null;
    }
    if (!raw || typeof raw !== "object") return null;
    let rec;
    try {
      rec = normalizeSpellRecord(raw, id);
    } catch (_) {
      return null;
    }
    if (cache.size >= SPELL_RECORD_CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(id, rec);
    return rec;
  }

  // ── A5/A6 self enchantments ────────────────────────────────────────
  /**
   * The local player's enchantments as plain rows, every PlayerEnchantmentJs
   * box freed once copied (TryGetEnchantments keeps its raw-box semantics,
   * Z5). null when the capability is absent or the read throws.
   *
   * Row: {spellId, family, layer, powerLevel, level, durationS, remainingS,
   * permanent, isBeneficial, casterGuid, statKey, statValue, isCooldown}.
   *
   * remainingS — the receivedAt book ported from buff_loop.js `_readRegistry`
   * (no import): wire startTime is RELATIVE and ≤ 0, so remaining =
   * receivedAt + duration + min(0, startTime) − now, where receivedAt is OUR
   * clock when a (spellId, layer) row with that startTime first appeared
   * (carried forward while startTime is unchanged; a recast re-stamps).
   * Expired rows are dropped. Permanent (remainingS = Infinity): duration < 0
   * (ACE's -1), above the one-year sentinel, or 0 on a non-cooldown row (the
   * d.ts: "0 = permanent (cantrip / equipment)").
   */
  TryGetSelfEnchantments() {
    const f = this._m.GetEnchantments;
    if (!f) return null;
    let raw;
    try {
      raw = f();
    } catch (_) {
      return null;
    }
    const copies = [];
    for (const e of Array.isArray(raw) ? raw : []) {
      try {
        copies.push({
          spellId: Number(e.spellId ?? e.spell_id ?? 0) >>> 0,
          family: Number(e.spellCategory ?? e.spell_category ?? 0) >>> 0,
          layer: Number(e.layer ?? 0) || 0,
          powerLevel: Number(e.powerLevel ?? e.power_level ?? 0) || 0,
          start: Number(e.startTime ?? e.start_time ?? 0) || 0,
          duration: Number(e.duration ?? 0) || 0,
          type: Number(e.type ?? 0) >>> 0,
          casterGuid: Number(e.casterGuid ?? e.caster_guid ?? 0) >>> 0,
          statKey: Number(e.statKey ?? e.stat_key ?? 0) || 0,
          statValue: Number(e.statValue ?? e.stat_value ?? 0) || 0,
        });
      } catch (_) {
        /* one bad row must not drop the read */
      }
      try {
        e?.free?.();
      } catch (_) {
        /* already released */
      }
    }
    const book = this._enchReceived || (this._enchReceived = new Map());
    const nowS = Date.now() / 1000;
    const seen = new Set();
    const rows = [];
    for (const c of copies) {
      const isCooldown = (c.type & ENCH_TYPE_COOLDOWN) !== 0 || (c.spellId > 0x7fff && c.spellId <= 0xffff);
      const permanent =
        c.duration < 0 || c.duration > PERMANENT_SENTINEL_S || (c.duration === 0 && !isCooldown);
      let remainingS = Infinity;
      if (!permanent) {
        const key = `${c.spellId}:${c.layer | 0}`;
        seen.add(key);
        const prior = book.get(key);
        const at = prior && prior.start === c.start ? prior.at : nowS;
        book.set(key, { start: c.start, at });
        remainingS = at + c.duration + Math.min(0, c.start) - nowS;
        if (remainingS <= 0) continue;
      }
      const rec = isCooldown ? null : this.TryGetSpellRecord(c.spellId);
      rows.push({
        spellId: c.spellId,
        family: c.family,
        layer: c.layer,
        powerLevel: c.powerLevel,
        level: rec ? rec.roughLevel : 0,
        durationS: c.duration,
        remainingS,
        permanent,
        isBeneficial: c.type ? (c.type & ENCH_TYPE_BENEFICIAL) !== 0 : !!rec?.isBeneficial,
        casterGuid: c.casterGuid,
        statKey: c.statKey,
        statValue: c.statValue,
        isCooldown,
      });
    }
    for (const key of book.keys()) if (!seen.has(key)) book.delete(key);
    return rows;
  }
  /** Vitae multiplier: the statValue of the spell-666 row; null when there is
   *  no vitae row (or enchantments are unreadable). */
  TryGetVitae() {
    const rows = this.TryGetSelfEnchantments();
    if (!rows) return null;
    const v = rows.find((r) => r.spellId === SPELL_ID_VITAE);
    return v ? v.statValue : null;
  }

  // ── A7 instance-id properties ──────────────────────────────────────
  /** Generic PropertyInstanceId read (PetOwner 44, Wielder 3, Container 2…);
   *  `undefined` when unknown / capability absent (as the other Try*Property). */
  TryGetObjectInstanceIdProperty(guid, stype) {
    const v = this._live("GetObjectInstanceIdProperty", Number(guid) >>> 0, Number(stype) >>> 0);
    return typeof v === "number" ? v >>> 0 : undefined;
  }

  // ── A8 wielded items / shield ──────────────────────────────────────
  /** Every wielded item of `guid` as plain rows {guid, wcid, itemType,
   *  equipMask}; each EquippedWeaponJs box freed once copied. null when the
   *  capability is absent or throws; [] for a non-wielder. */
  TryGetWieldedItems(guid) {
    const f = this._m.GetWieldedItems;
    if (!f) return null;
    let raw;
    try {
      raw = f(Number(guid) >>> 0);
    } catch (_) {
      return null;
    }
    const out = [];
    for (const it of Array.isArray(raw) ? raw : []) {
      try {
        out.push({
          guid: (it.guid ?? 0) >>> 0,
          wcid: (it.wcid ?? 0) >>> 0,
          itemType: (it.itemType ?? 0) >>> 0,
          equipMask: (it.equipMask ?? 0) >>> 0,
        });
      } catch (_) {
        /* one bad row must not drop the read */
      }
      try {
        it?.free?.();
      } catch (_) {
        /* already released */
      }
    }
    return out;
  }
  /** VTank `hasshield`: any wielded object of class Armor (ItemType 0x2) —
   *  in the Shield slot when the row's equip mask is known. ACE streams only
   *  Selectable wielded items (weapons, shields, ammo) of OTHER wielders
   *  (Player_Tracking.cs:121), so for them every Armor row is the shield; the
   *  local player's index also lists worn armour (chest, helm …, ItemType
   *  Armor too), which the slot check keeps from reading as a shield.
   *  null when wielded items are unreadable. */
  HasShield(guid) {
    const rows = this.TryGetWieldedItems(guid);
    if (rows === null) return null;
    return rows.some(
      (r) => (r.itemType & ITEM_TYPE_ARMOR) !== 0 && (r.equipMask === 0 || (r.equipMask & EQUIP_MASK_SHIELD) !== 0)
    );
  }

  // ── A9 use gates ───────────────────────────────────────────────────
  /** Is `guid` usable right now (no target)? null when unknown. */
  CanUseObject(guid) {
    const v = this._live("CanUseObject", Number(guid) >>> 0);
    return typeof v === "boolean" ? v : null;
  }
  /** Is applying `item` to `target` legal right now? null when unknown. */
  CanUseWith(itemGuid, targetGuid) {
    const v = this._live("CanUseWith", Number(itemGuid) >>> 0, Number(targetGuid) >>> 0);
    return typeof v === "boolean" ? v : null;
  }

  // ── A10 fellowship ─────────────────────────────────────────────────
  FellowshipRecruit(guid) {
    const g = Number(guid) >>> 0;
    return g ? this._act("FellowshipRecruit", g) : false;
  }
  FellowshipCreate(name, shareXp) {
    const n = String(name ?? "").trim();
    return n ? this._act("FellowshipCreate", n, !!shareXp) : false;
  }
  FellowshipQuit(disband) {
    return this._act("FellowshipQuit", !!disband);
  }
  FellowshipDismiss(guid) {
    const g = Number(guid) >>> 0;
    return g ? this._act("FellowshipDismiss", g) : false;
  }
  FellowshipSetOpen(open) {
    return this._act("FellowshipChangeOpenness", !!open);
  }
  FellowshipAssignLeader(guid) {
    const g = Number(guid) >>> 0;
    return g ? this._act("FellowshipAssignNewLeader", g) : false;
  }
  FellowshipRequestUpdates(want) {
    return this._act("FellowshipUpdateRequest", !!want);
  }
  /// Hold (on=true) / release the fellow-vitals stream: ACE sends fellows'
  /// vitals only while the player said its fellowship panel is open
  /// (Fellowship.cs FellowshipPanelOpen). The page's fellowship panel and the
  /// bot's helper share ONE count (globalThis.__hbFellowUpdateRefs,
  /// plugins/fellowship-panel.js), so closing the panel never stops the
  /// helper's updates. → the new hold count.
  FellowshipHoldUpdates(on) {
    const g = globalThis;
    const before = Math.max(0, Number(g.__hbFellowUpdateRefs) || 0);
    const after = Math.max(0, before + (on ? 1 : -1));
    g.__hbFellowUpdateRefs = after;
    if (before === 0 && after > 0) this.FellowshipRequestUpdates(true);
    else if (before > 0 && after === 0) this.FellowshipRequestUpdates(false);
    return after;
  }
  /// GameActionCreateTinkeringTool (0x027D) — retail's "Salvage" button: the
  /// Ust (wcid 20646) salvages `itemGuids` into bags, and bags given with it
  /// are merged per material (ACE Player_Crafting.cs HandleSalvaging). The
  /// verdict lands as a SalvageOperationsResult (ClientEvent kind 52).
  CreateTinkeringTool(toolGuid, itemGuids) {
    const ids = Uint32Array.from((itemGuids || []).map((g) => Number(g) >>> 0).filter(Boolean));
    if (!ids.length) return false;
    return this._act("CreateTinkeringTool", Number(toolGuid) >>> 0, ids);
  }
  /// Wield `itemGuid` into `slot` (an EquipMask bit, e.g. 0x00800000 Ammo)
  /// — the inventory panel's drag-to-paperdoll path (plugins/item_drag.js).
  SetWielded(itemGuid, slot) {
    return this._act("SetWielded", Number(itemGuid) >>> 0, Number(slot) >>> 0);
  }
  /// Split `amount` off a stack straight into a wield slot (ammo).
  SplitStackToWield(stackGuid, slot, amount) {
    return this._act("SplitStackToWield", Number(stackGuid) >>> 0, Number(slot) >>> 0, Math.max(1, amount | 0));
  }
  /**
   * Plain fellowship view {name, leaderGuid, open, isLocked, evenShare,
   * members:[{guid, name, level}]}; null when not in a fellowship. Unlike
   * TryGetFellowship (kept as is, Z5) the FellowshipSnapshotJs box and every
   * FellowshipMemberJs box (`members` is a cloning getter — read once) are
   * freed.
   */
  TryGetFellowshipInfo() {
    const f = this._m.GetFellowship;
    if (!f) return null;
    let snap;
    try {
      snap = f();
    } catch (_) {
      return null;
    }
    if (!snap) return null;
    let out = null;
    try {
      let rows = [];
      try {
        rows = Array.from(snap.members || []);
      } catch (_) {
        rows = [];
      }
      const members = [];
      for (const m of rows) {
        try {
          members.push({ guid: (m.guid ?? 0) >>> 0, name: String(m.name ?? ""), level: Number(m.level ?? 0) || 0 });
        } catch (_) {
          /* partial member degrades to fewer rows */
        }
        try {
          m?.free?.();
        } catch (_) {
          /* already released */
        }
      }
      out = {
        name: String(snap.name ?? ""),
        leaderGuid: (snap.leaderGuid ?? 0) >>> 0,
        open: !!snap.open,
        isLocked: !!snap.isLocked,
        evenShare: !!snap.evenShare,
        members,
      };
    } catch (_) {
      out = null;
    }
    try {
      snap?.free?.();
    } catch (_) {
      /* already released */
    }
    return out;
  }

  // ── A11 / A13 ──────────────────────────────────────────────────────
  RecallAllegianceHometown() {
    return this._act("RecallAllegianceHometown");
  }
  /** The /reply target (last PLAYER teller, markers trimmed); null when none. */
  GetLastTellerName() {
    const v = this._live("GetLastTellerName");
    return typeof v === "string" && v ? v : null;
  }

  // ── A14 headings (compass degrees at the API; HEADING_CONVENTION) ───
  /** The player's facing as a compass bearing in degrees [0, 360); null when
   *  the pose carries no heading. */
  TryGetPlayerCompassHeadingDeg() {
    const pose = this.TryGetPlayerPose() || this.TryGetPlayerPoseLive();
    const h = pose ? pose.heading : null;
    if (typeof h !== "number" || !Number.isFinite(h)) return null;
    return poseRadToCompassDeg(h);
  }
  /** Turn to a compass bearing (degrees, 0 = N, clockwise) through the ONE
   *  conversion (HEADING_CONVENTION). @returns {boolean} sent */
  TurnToCompassHeading(deg) {
    const d = Number(deg);
    if (!Number.isFinite(d)) return false;
    return this._act("TurnToHeading", compassDegToTurnRad(d));
  }
  /** Face an object: the wasm turnToEntity (retail TurnToObject — no heading
   *  convention involved) when present, else the bearing from the pose
   *  through TurnToCompassHeading. @returns {boolean} sent */
  TurnToObject(guid) {
    const g = Number(guid) >>> 0;
    if (!g) return false;
    if (this._m.TurnToObject) return this._act("TurnToObject", g);
    const me = this._vtSelfPose();
    const pos = this.TryGetObjectPosition(g);
    const d = me && pos ? vtDelta(me, pos) : null;
    if (!d) return false;
    return this.TurnToCompassHeading((Math.atan2(d.dx, d.dy) * 180) / Math.PI);
  }

  // ── A15 / A16 distance and name search ─────────────────────────────
  /** The player's pose in the snapshot frame ({objCellId, x, y, z, heading}),
   *  falling back to a live read (cell healed like `_tick`) before the first
   *  heartbeat, or when the snapshot carried no cell (objCellId 0). null when
   *  unknown. */
  _vtSelfPose() {
    const snapPose = this.TryGetPlayerPose();
    if (snapPose && snapPose.objCellId >>> 0) return snapPose;
    const live = this.TryGetPlayerPoseLive();
    if (!live) return null;
    const cell = live.landblockId >>> 0 || this.GetCurrentCellIdLive() >>> 0;
    if (!cell) return null;
    return { objCellId: cell, x: live.x, y: live.y, z: live.z, heading: live.heading };
  }
  /** Metres from the player to `guid` (3-D), with the combat_loop.js rule:
   *  same landblock, or both outdoors in the global frame. null when the
   *  object or the pose is unknown, or the two are in different indoor
   *  landblocks. */
  TryGetObjectDistance(guid) {
    const g = Number(guid) >>> 0;
    if (!g) return null;
    const me = this._vtSelfPose();
    if (!me) return null;
    const pos = this.TryGetObjectPosition(g);
    if (!pos) return null;
    const d = vtDelta(me, pos);
    if (!d) return null;
    const dist = Math.hypot(d.dx, d.dy, d.dz);
    return Number.isFinite(dist) ? dist : null;
  }
  // Guids within `maxDistM`: the frozen snapshot list when its range covers
  // the request (nearbyRangeM 0 = every tracked entity), else a live query.
  _vtNearbyGuids(maxDistM) {
    const range = Number(this.nearbyRangeM) || 0;
    if (this.snap && (range === 0 || range >= maxDistM)) return this.NearbyGuids();
    const v = this._live("NearbyEntityGuids", maxDistM);
    if (v && typeof v.length === "number") return Array.from(v, (x) => x >>> 0);
    return this.NearbyGuids();
  }
  /**
   * Nearby objects named `name` (case-insensitive; `exact` = whole name, else
   * substring), nearest first: [{guid, name, dist}]. `player` keeps players
   * only (desc flag or the player guid range), `creature` keeps ItemType
   * Creature only. The player itself and objects whose distance is unknown
   * are skipped. Never throws.
   */
  FindNearbyByName(name, opts = {}) {
    const want = String(name ?? "").trim().toLowerCase();
    if (!want) return [];
    const o = opts && typeof opts === "object" ? opts : {};
    const player = !!o.player;
    const creature = !!o.creature;
    const exact = o.exact !== false;
    const maxDistM = typeof o.maxDistM === "number" && o.maxDistM > 0 ? o.maxDistM : 250;
    const me = Number(this.GetPlayerId()) >>> 0;
    const out = [];
    try {
      for (const g0 of this._vtNearbyGuids(maxDistM)) {
        const g = g0 >>> 0;
        if (!g || g === me) continue;
        const n = this.TryGetObjectName(g);
        if (typeof n !== "string" || !n) continue;
        const ln = n.toLowerCase();
        if (exact ? ln !== want : !ln.includes(want)) continue;
        if (player && !(this.ObjectIsPlayer(g) || (g >= PLAYER_GUID_MIN && g <= PLAYER_GUID_MAX))) continue;
        if (creature && ((Number(this.TryGetObjectIntProperty(g, PINT_ITEM_TYPE)) >>> 0) & ITEM_TYPE_CREATURE) === 0) continue;
        const dist = this.TryGetObjectDistance(g);
        if (dist == null || dist > maxDistM) continue;
        out.push({ guid: g, name: n, dist });
      }
    } catch (_) {
      /* degrade to what was found */
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  // ── A17 item mana ──────────────────────────────────────────────────
  /**
   * Item mana from the last appraisal: {cur, max, ratePerSec, lastIdMs,
   * stale}. ACE never pushes ItemCurMana (U4 §7.2), so callers re-appraise
   * (RequestId) when `stale` (never identified, or last identify > 60 s ago).
   * `ratePerSec` is the burn rate as a POSITIVE mana/s (PropertyFloat
   * ManaRate is stored negative); null when unknown. null when the item has
   * no mana data at all (never appraised / not a mana item).
   */
  TryGetItemMana(guid) {
    const g = Number(guid) >>> 0;
    if (!g) return null;
    const cur = this._live("GetObjectIntProperty", g, PINT_ITEM_CUR_MANA);
    const max = this._live("GetObjectIntProperty", g, PINT_ITEM_MAX_MANA);
    const hasCur = typeof cur === "number" && Number.isFinite(cur);
    const hasMax = typeof max === "number" && Number.isFinite(max);
    if (!hasCur && !hasMax) return null;
    const rate = this._live("GetObjectDoubleProperty", g, PFLOAT_MANA_RATE);
    const lastIdMs = Number(this.GetLastIdTime(g)) || 0;
    return {
      cur: hasCur ? cur : null,
      max: hasMax ? max : null,
      ratePerSec: typeof rate === "number" && Number.isFinite(rate) ? Math.abs(rate) : null,
      lastIdMs,
      stale: !lastIdMs || Date.now() - lastIdMs > ITEM_MANA_STALE_MS,
    };
  }

  // ── A19 item-action token (C8, V-13) ───────────────────────────────
  // The cast token's twin for UseObject / UseItemOnTarget / MoveItemToContainer
  // / MergeStacks / SplitStack / WieldItem / UnwieldItem / GiveObject /
  // DropItem: one item action in flight at a time across every VT module.
  // Cleared by the server's answer (kinds 11/13/14/48, and 47/49 when the
  // wielder is us — those two fire for every wielder in view) or after
  // ITEM_TOKEN_TIMEOUT_MS.
  _itemTokenLive(now = Date.now()) {
    const t = this._itemToken;
    if (!t) return false;
    if (now - t.issuedAt > ITEM_TOKEN_TIMEOUT_MS) {
      this._itemToken = null;
      return false;
    }
    return true;
  }
  _noteItemActionEvent(e) {
    try {
      if (!this._itemToken) return;
      if (e.kind === 47 || e.kind === 49) {
        // u32b = the prior (47) / new (49) wielder; only OUR wield transition
        // answers our action. Unknown player guid -> clear (fail open).
        const me = Number(this.GetPlayerId()) >>> 0;
        if (me && (e.u32b >>> 0) !== me) return;
      }
      this._itemToken = null;
    } catch (_) {
      /* never break event dispatch */
    }
  }
  /**
   * Claim the item-action token immediately before issuing an item action.
   * true when the token was free, or already held by this SAME owner (the
   * claim re-arms it: a new action, a fresh timeout). false when a different
   * owner holds a live claim, or — with `minIntervalMs` — when this owner's
   * previous successful claim is younger than that interval (weapon-swap
   * pacing, REF WeaponSwapGate 3 s).
   */
  tryClaimItemAction(owner, opts = {}) {
    const now = Date.now();
    const minIntervalMs = Math.max(0, Number(opts && opts.minIntervalMs) || 0);
    if (this._itemTokenLive(now) && this._itemToken.owner !== owner) return false;
    const claims = this._itemClaims || (this._itemClaims = new Map());
    if (minIntervalMs > 0) {
      const last = claims.get(owner);
      if (last != null && now - last < minIntervalMs) return false;
    }
    this._itemToken = { owner, issuedAt: now };
    if (claims.size >= 64 && !claims.has(owner)) claims.clear();
    claims.set(owner, now);
    return true;
  }
  /** Release early once the owner's own bookkeeping saw the result. No-op
   *  when a different owner (or nobody) holds it. */
  releaseItemAction(owner) {
    if (this._itemToken && this._itemToken.owner === owner) this._itemToken = null;
  }
  /** Read-only status: {owner, issuedAt} or null. */
  get itemActionToken() {
    return this._itemTokenLive() ? { ...this._itemToken } : null;
  }

  // ── A20 per-snapshot inventory memo ────────────────────────────────
  /** TryGetPlayerInventory memoized per `snap.seq`: the wasm read (one
   *  boundary crossing per field + a free per row) happens once per tick,
   *  however many meta/autostack/burden polls ask. Each caller still gets
   *  its OWN array of its own row copies (same contract as
   *  TryGetPlayerInventory — sorting or annotating it cannot leak into
   *  another caller). Dropped early on kinds 11/47/48/49. Before the first
   *  heartbeat (no snapshot) and once the heartbeat has stopped it reads
   *  through (see _vtMemoSeq). */
  TryGetPlayerInventoryCached() {
    const seq = this._vtMemoSeq();
    if (seq == null) return this.TryGetPlayerInventory();
    return this._invRowsForSeq(seq).map((r) => ({ ...r }));
  }
  // The snapshot seq the A20 memos are keyed on, or null = read through: no
  // heartbeat yet, or the heartbeat was stopped / the host disposed. A
  // stopped host's seq never advances and _dispatchEvent no longer drops the
  // memo, so it would otherwise answer with its last tick's inventory forever
  // while TryGetPlayerInventory reads live.
  _vtMemoSeq() {
    return this.snap && !this._stopped ? this.snap.seq : null;
  }
  // The memoized (internal, never handed out) rows for `seq`.
  _invRowsForSeq(seq) {
    let m = this._invMemo;
    if (!m || m.seq !== seq) {
      m = { seq, rows: this.TryGetPlayerInventory() };
      this._invMemo = m;
    }
    return m.rows;
  }
  /** TryGetPackRoom over the memoized inventory, memoized per `snap.seq`;
   *  each caller gets its own copy. */
  TryGetPackRoomCached() {
    const seq = this._vtMemoSeq();
    if (seq == null) return this.TryGetPackRoom();
    let m = this._roomMemo;
    if (!m || m.seq !== seq) {
      m = { seq, room: this._packRoomFrom(this._invRowsForSeq(seq)) };
      this._roomMemo = m;
    }
    const r = m.room;
    return r
      ? {
          main: { ...r.main },
          containers: { ...r.containers },
          packs: r.packs.map((p) => ({ ...p })),
          freeItemSlots: r.freeItemSlots,
        }
      : null;
  }

  // ── A21 creature info ──────────────────────────────────────────────
  /**
   * {guid, name, wcid, creatureType, maxHp, hpFrac, dist, hasShield} for a
   * tracked object, null for an untracked guid. creatureType: PropertyInt 2
   * (merged by a SUCCESSFUL appraisal; not in CreateObject — U4 H13), else
   * the appraisal's ints; maxHp: appraisal creatureProfile.health_max, or the
   * failed-assess failedCreatureProfile.health_max; hpFrac: -1 unknown (as
   * TryGetTargetHealthFraction); unknown fields null. With
   * `requestAppraisal`, a missing maxHp/creatureType issues at most one
   * RequestId per guid per CREATURE_ID_INTERVAL_MS.
   */
  TryGetCreatureInfo(guid, opts = {}) {
    const g = Number(guid) >>> 0;
    if (!g) return null;
    try {
      const name = this.TryGetObjectName(g);
      const wcid = Number(this.TryGetObjectWcid(g)) >>> 0;
      if (name == null && !wcid) return null;
      const appraisal = this.TryGetObjectAppraisal(g);
      let creatureType = this.TryGetObjectIntProperty(g, PINT_CREATURE_TYPE);
      if (typeof creatureType !== "number") {
        const ints = appraisal?.properties?.ints;
        const v = ints ? (ints.CreatureType ?? ints[String(PINT_CREATURE_TYPE)]) : undefined;
        creatureType = typeof v === "number" ? v : null;
      }
      const prof = appraisal?.creatureProfile || appraisal?.failedCreatureProfile || null;
      const hm = prof ? (prof.health_max ?? prof.healthMax) : undefined;
      const maxHp = typeof hm === "number" && hm > 0 ? hm : null;
      if (opts && opts.requestAppraisal && (maxHp == null || creatureType == null)) this._vtRequestCreatureId(g);
      return {
        guid: g,
        name: name ?? "",
        wcid,
        creatureType,
        maxHp,
        hpFrac: Number(this.TryGetTargetHealthFraction(g)),
        dist: this.TryGetObjectDistance(g),
        hasShield: this.HasShield(g),
      };
    } catch (_) {
      return null;
    }
  }
  _vtRequestCreatureId(g) {
    const now = Date.now();
    const book = this._creatureIdAt || (this._creatureIdAt = new Map());
    const last = book.get(g);
    if (last != null && now - last < CREATURE_ID_INTERVAL_MS) return false;
    if (book.size >= 512) {
      for (const [k, at] of book) if (now - at >= CREATURE_ID_INTERVAL_MS) book.delete(k);
    }
    book.set(g, now);
    return this.RequestId(g);
  }

  // ── ENV selection for "Add selected" ───────────────────────────────
  /** The player's most recent selection: the inventory panel's item
   *  (plugins/inventory.js publishes window.__inventory.selectedGuid) or the
   *  world selection, whichever was made LAST (the page selection clock);
   *  without the clock's ordering (off-page / neither event seen) the
   *  inventory selection first, then the world one; 0 = none. */
  GetSelectedItemId() {
    const c = selectionClock(); // attaches the page listeners on first use
    let inv = 0;
    try {
      const v = globalThis.__inventory?.selectedGuid;
      inv = typeof v === "number" ? v >>> 0 : 0;
    } catch (_) {
      inv = 0;
    }
    const world = this.GetSelectedId();
    if (inv && world) return c && c.worldAt > c.invAt ? world : inv;
    return inv || world;
  }
}

export default RynthWebHost;
