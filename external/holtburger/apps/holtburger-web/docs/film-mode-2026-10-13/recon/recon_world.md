# WORLD CONTROL FOR FILMING: teleport, player visibility, time/weather, actor direction, spawning extras (holtburger-web + vanilla ACE)
VERIFIED MAP. Paths are HB-relative inside apps/holtburger-web. ACE = /home/wbterminal/ace-server/Source/ACE.Server, read only. Everything below can be reached from the page (window.*), so the Claude Code session can drive all world control over CDP Runtime.evaluate with no Anthropic API calls and no wasm rebuild. JEV (OpenRouter) only has to choose among the typed candidate sets listed under dataSources: POI names, SoulEmote tokens, MotionCommand names, EnvironChangeType, DayGroup index, sky time t.

0) SESSION/BOOT
- Boot URL: ?nosw=1&autoLogin=1&account=..&password=..&autoSpawn=first|Name&agent=1&hud=none&camDebug=on.
- Readiness gates: window.__bootState==='ready' (the state is set in index.html:4267; 'ready' comes from scene3d/index.js:5801/6289/7695), then window.__sessionHandle (index.html:4553), window.getLocalPlayerGuid (index.html:3516) and window.liveScene3d (scene3d/index.js:4420; per memory it arrives about 35 s after in-world).
- ACE drops chat sent before EnteredWorld. Gate on isPlayerReady() (d.ts:5028) or kind=7.
- SessionHandle has 288 methods (d.ts lines 3200-6826).

1) TELEPORTS (ACE parses a chat line as a command only when it starts with '@': GameActionTalk.cs:21. sendChat('/x') is spoken aloud even though the sendChat doc at d.ts:6096 says '/' also works. window.__routeSlashCommand(handle,'/x') rewrites an unknown /x to @x, but it resolves soul-emote tokens first.)
- @teleloc (Developer, AdminCommands.cs:912): '@teleloc <cellhex, 0x optional> x y z [qw qx qy qz]'. Brackets are allowed. The cell is the full objcell id (landblock-local x/y). Missing quaternion means identity (facing north). The constructor call is Position(cell,x,y,z,qx,qy,qz,qw).
  - There is NO z or dungeon-cell correction. A float that fails to parse makes the handler return silently (:945-946).
  - Player.Teleport adds 0.005*scale to z (Player_Location.cs:654).
- @tele (Advocate+, AdvocateCommands.cs:156): '@tele [name] <ns>n|s <ew>e|w'. The regex requires N/S first. Decimals are allowed: 0.001 is about 0.24 m.
  - z comes from the server: AdjustMapCoords (PositionExtensions.cs:240) uses the walkable terrain polygon height plus the building's minZ and re-seats the indoor cell.
  - It refuses landblocks that are entirely water. Rotation is identity. Do not use it on dungeon-only landblocks (terrain z is 0, so you land in a void).
  - Conversion from AC world metres: ew = gx/240 - 101.95, ns = gy/240 - 101.95, where gx = lbX*192 + localX (Position.cs:293). Check: Holtburg 42.1N 33.6E gives LB 0xA9B4.
  - The reply chat line prints the resolved cell/offset/facing.
- @telepoi <name>|list (Developer, :875): case-insensitive exact match against ace_world.points_of_interest (WorldDatabaseWithEntityCache.cs:687), then AdjustDungeon.
- @teledungeon <lbhex|name words> (Developer, DeveloperCommands.cs:2068): the first portal Destination into that landblock, then AdjustDungeon. A single token is parsed as hex first.
- @telexyz (Developer, DeveloperCommands.cs:660): all 8 params, cell in DECIMAL, quaternion order qx qy qz qw.
- @teleto / @teletome / @telereturn (Sentinel, :785/:804/:825); @teleallto (Developer, :850); @teledist (DeveloperCommands.cs:1576).
- @nudge (DeveloperCommands.cs:98) re-seats a wrong dungeon cell after landing in black space.
- Cooldowns: none on admin commands and no rate limit in GameActionTalk. Only in-world portal objects have the 3.5 s minTimeSinceLastPortal (Portal.cs:120).
- Server-side sequence:
  - Teleport() sends PlayerTeleport plus a fake UpdatePosition at the destination, and sets Hidden + IgnoreCollisions.
  - If a landblock fog is active and there is no global fog, the teleport is delayed 1 s to clear the fog first.
  - Objects that become visible are sent to the client 1 s late (TeleportCreateObjectDelay, PhysicsObj.cs:2278), so expect pop-in after arrival.
  - LoginComplete leads to OnTeleportComplete (Player_Location.cs:740). It re-polls every 0.1 s until CurrentLandblock.CreateWorldObjectsCompleted, then un-hides the player.
  - If the player stays Teleporting for more than 5 min they are logged off (Player_Tick.cs:107).
- Client-side sequence:
  - The wasm sends LoginComplete immediately on PlayerTeleport (src/session/messages/position.rs:34-195; DEFER_LOGIN_COMPLETE_AFTER_TELEPORT=false in holtburger-core client/mod.rs:90).
  - It queues kind=33 PortalSpaceEntered, then kind=66 TeleportArrived on the destination UpdatePosition.
  - The portal-space tunnel (default ON, ?portalSpace=off) skips world rendering until arrival AND the destination cell is resident. Then it holds for at least 2 s (retail CONTINUE), fades out over 1 s and fades the world in over 1 s. Failsafes: 6 s and 20 s. So every teleport is a cut of at least about 4 s.
  - JS readiness signals:
    - __pluginClient.events 'portalSpaceEntered' / 'portalSpaceExited' (client_events.js:882/:933)
    - globalThis.__isPortalSpaceActive() (portal_space.js:1594)
    - window.__portalSpace {state, arrived, arrivalCell, reason} (:1173)
    - destinationCellsReady (:601): indoor checks liveScene3d.cellContainers3d.has(cell); outdoor checks liveScene3d.terrainBakedLbs.has(cell&0xFFFF0000)
    - window.__interiorBuildPending (cells.js:4622)
    - getLocalPlayerPoseCellResolved() (d.ts:4434)

2) MAKING THE PLAYER UNOBTRUSIVE
- @cloak on (Sentinel, SentinelCommands.cs:29 → Player_Tracking.cs:189):
  - Sets Cloaked, Ethereal and NoDraw, and ReportCollisions=false.
  - Other players get a DeleteObject. Visibility=true means CreateObject goes only to adminvision viewers.
  - Our own client receives the full SetState (WorldObject.cs:640-659). Holtburger should_draw is false for HIDDEN, NO_DRAW or CLOAKED (crates/holtburger-world/src/entity.rs:1420), and a SetState flip emits kind=17 (state/mutations.rs:2124), which reaches EntityManager.setVisibility (entities.js:7092). So the local rig should hide. This chain was read in code but not tested live.
  - NoDraw/Cloaked do not play the pink-bubble Hidden script (play_effect_vfx.js:2277).
  - Cloak persists across teleports.
  - @cloak off runs DeCloak (Player_Tracking.cs:154): delete, create, clear flags, about 1 s.
- Cloak does NOT stop monster aggro. Monster targeting filters only on !Attackable, Teleporting or Hidden (Monster_Awareness.cs:353), so also send '@attackable off' (Advocate+, AdvocateCommands.cs:16).
- Client rig visibility: entities.js _applyEntityVisible (:2972) sets root.visible = _stateVisible (server draw gate via setVisibility :7092, from the kind=17 handler in client_events.js:1532) && !_renderCullHidden (tickEntityRenderVisibility :3093; the local player is never culled).
  - Camera fade: setLocalPlayerCameraOpacity(guid,o) (entities.js:18991) fades the rig and held items hierarchically. It is pushed by camera.js _applyCameraPlayerFade (:2156) under the default-on ?retailCamZoom (in-head at :2041). Transparent materials still cast shadows.
  - There is no dedicated hide-self flag.
- HUD-free output:
  - ?hud=none adds html.no-hud (index.html:614). Its CSS (:536-539) hides every body child except #stage. scene3d/index.js:3203 skips the DOM nameplates and selection brackets.
  - In-canvas speech bubbles (speech_bubble.js, kind=55, always on) are NOT hidden.

3) TIME / WEATHER
- ACE: @time (AdminCommands.cs:965) only displays. There is NO server command to set time or weather.
- ACE environ:
  - @setlbenviron (current landblock + adjacent) and @setglobalenviron (all landblocks), Developer, AdminCommands.cs:4646/4682.
  - EnvironChangeType values: Clear 0; RedFog/BlueFog/WhiteFog/GreenFog/BlackFog/BlackFog2 = 0x01-0x06, continuous; sounds 0x65-0x7B, one-shot, including Thunder1-6 = 0x76-0x7B.
  - The client blends the fog in retail-style over about 20 s (environ_override.js; client_events.js:2083-2140).
- Client-only controls:
  - Sky time: SessionHandle.setSkyTimeOverride(t in 0..1, NaN clears) (d.ts:6366). It returns false until the SkyDesc has loaded.
    - Look-pass values: Dawn 0.21, Morning 0.33, Noon 0.5, Dusk 0.89, Night 0; sunrise about 0.203, sunset about 0.907.
    - ?skytime=<hour or 0-1> pins it at boot (index.html:6332/6495).
  - DayGroup = AC weather (sunny … rain/snow sky objects): setGameDayOverride(day,year) (d.ts:6276) forces it. Pick (day,year) by brute-forcing calc_present_day_group (crates/holtburger-world/src/sky.rs:684). getSkyState().dayGroupIndex reads it back.
  - Facade versions: __pluginClient.sky.setTimeOverride / setDayOverride (plugins/api.js:895).
  - Volumetric clouds: window.__setWeather({is_storm,temperature_C,...}), __getWeather, __clearWeatherOverride (scene3d/weather_state.js:329). They need ?clouds=on, plus ?cloudCoverage=0..1 and ?wxMap=nasa|dereth.
  - Client fog: window.__environFogOverride = environFogFor(n) (environ_override.js:81).
  - The rain/snow/lightning particle systems were REMOVED on 2026-08-01.

4) ACTOR DIRECTION
- Player emotes:
  - __routeSlashCommand(handle,'/wave') (app/slash_commands.js:520/784) runs runSoulEmote (:459): sendSoulEmote(text) (d.ts:6140), broadcastEmoteMotion(motionFull) (d.ts:3416), then predicts the motion locally with em.setMotion for held poses or em.setSwingMotion for one-shots.
  - resolveSoulEmote(token) (d.ts:5974) returns {pose, motionFull, myEmote, otherEmote, held}.
  - ACE BroadcastMovement (Player_Networking.cs:309) sends UpdateMotion to everyone, including us. Its spam guard drops the same soul emote if it arrives within its animation length (:335).
  - The valid emote set (75 MotionCommands with aliases) is in ACE Entity/SoulEmote.cs. It includes SitState, KneelState, DrudgeDanceState, Wave, BowDeepState, PrayState, MeditateState, LeanState, PointState, YMCA and others.
- Any object: '@animation <MotionCommandName> [guidhex]' (Developer, DeveloperCommands.cs:330).
  - Enum.TryParse is case-sensitive. The command uses the object's current stance and broadcasts Motion(stance,cmd), which sets ForwardCommand. Substates (e.g. SitState) hold.
  - Whether our own rig applies this to self is unverified.
- Client-only (film has one viewer, so this is enough): em = liveScene3d.entityManager.
  - setMotion(guid,cmd,stance,speed=1) (entities.js:11576)
  - async setSwingMotion(guid,cmd,opts) (:11107)
  - getStance (:8711)
- Walking and facing:
  - setMovementInput(f,s,t,run) (d.ts:6335): axes -1/0/+1, call on change only; all zeros means stop.
  - moveToPosition(lb,x,y,z,run) (d.ts:5220), then poll pursuitStatus (d.ts:5799; it is read-clear, 2 = arrived, 3 = failed).
  - turnToHeading(rad) (d.ts:6701), turnToEntity (6694), setAutoRun (6232), stickToEntity (6476).
  - Heading convention: yaw is counter-clockwise, 0 = north, compass = -yaw.
  - Speed-ups: @run on (Sentinel, SentinelCommands.cs:212), @fast (DeveloperCommands.cs:2931).
- Extras:
  - Spawn: '@create <wcid|classname> [n] [palette] [shade]' (Developer, AdminCommands.cs:2175). Creatures appear 5 m in front, rotated 180° to face you (:2434). Items appear at max(2, UseRadius). They last until the landblock unloads.
  - Self-cleaning spawn: '@createliveops <wcid> <n> <lifespan_s>' (:2192). Heartbeat deletes it when the lifespan runs out (WorldObject_Tick.cs:103).
  - No guid comes back. Capture new guids via __pluginClient.world 'objectCreated' (plugins/world-state.js:443), or diff nearbyEntityGuids (d.ts:5232) together with objectWcid (5411).
  - Targeting: requestAppraisal(guid) (5943) sets RequestedAppraisalTarget/CurrentAppraisalTarget (Player.cs:296/340); queryHealth(guid) (5824) sets HealthQueryTarget.
  - Commands that act on the target:
    - @turnto: the creature faces the PLAYER (DeveloperCommands.cs:1413).
    - @pscript <PlayScript>: particle effect on the target (:3031).
    - @effect <PlayScript>: particle effect on self (:289).
    - @delete (Envoy, AdminCommands.cs:90): precedence is HealthQueryTarget > ManaQueryTarget > CurrentAppraisalTarget.
    - @smite: kills, leaving a corpse.
  - Keeping extras docile: with @attackable off, monsters stay asleep.
  - Stubs and unusable commands:
    - @freeze/@unfreeze are no-op stubs (:256/:265).
    - @createcreature is commented out (DeveloperCommands.cs:47).
    - @movetome is Admin only (:4730).
    - @morph logs you out.
    - @portalstorm 2 teleports you to 0x7F7F001C.
    - @rotate, @nudge (content version) and @createinst write ace_world SQL (permanent).

5) STREAMING RADIUS / UPDATE RATES
- ACE visible set:
  - Outdoors: the current landblock plus 8 adjacent landblocks' server objects (ObjectMaint.cs:352; LandblockManager.cs:577), excluding objects inside EnvCells that are not SeenOutside.
  - Dungeons (all heights 0 + EnvCells) have no adjacent landblocks (:581). The set is the current cell plus its VisibleCells PVS, plus outdoor objects if the cell is SeenOutside (ObjectMaint.cs:370-385).
  - Objects that leave visibility go to a 25 s DestructionQueue (ObjectMaint.cs:21).
  - Landblocks go dormant after 1 min without players and unload after 5 min (Entity/Landblock.cs:113/118). Spawned extras vanish when that happens.
  - Speech/emote text range is 96 m (WorldObject.cs:1018).
- Client: collision heightmaps for the 3x3 landblock ring around the PLAYER (app/landblock_stream.js:722). Streaming is player-centric (world_stream via the local player's position updates).
- Rates:
  - Awake or returning monsters: SendUpdatePosition every Monster_Tick of 0.2 s (Monster_Tick.cs:10; Monster_Navigation.cs:251-263), plus MoveTo UpdateMotion.
  - Idle creatures and NPCs: no updates.
  - Players: AutonomousPosition heartbeat 1 s with a change gate of 0.05 m / 0.0035 rad (holtburger-core movement/common.rs:27, system.rs:451-462). ACE re-broadcasts if RequestedLocationBroadcast is set or at least 1 s has passed (Player_Tick.cs:403/513).
  - Remote entities are interpolated in wasm (?remoteInterp default ON; loop.js:719 drainRemotePoses → em.applyManagedPose entities.js:6698).
- Tracking shots should follow the rendered root (entityMap.get(guid).root.position, AC world x=lbX*192+lx; acToThree(x,y,z)=[x,z,-y] in adapter.js:1817), not objectPosition (the raw wire pose). Add camera-side damping to absorb correction snaps every 0.2-1 s.

6) SESSIONHANDLE INVENTORY: see apis[] for exact d.ts signatures.

## APIS
- SessionHandle.sendChat [pkg/holtburger_web.d.ts:6096]  sig=sendChat(message: string): void :: Sends a Talk action. Only '@'-prefixed text is an ACE command; a '/' prefix is spoken publicly (the d.ts doc is wrong). Silently dropped before EnteredWorld. The send is async; replies arrive as kind=2 chat.
- window.__routeSlashCommand [app/slash_commands.js:784]  sig=routeSlashCommand(handle, message) -> {dispatched, echo, error, category} (fn at :520) :: Chat-bar router. Soul-emote tokens go to runSoulEmote (:459: sendSoulEmote + broadcastEmoteMotion + local prediction). Tells are /tell name, msg. Any unknown /x is sent as '@x'.
- SessionHandle.resolveSoulEmote [pkg/holtburger_web.d.ts:5974]  sig=resolveSoulEmote(token: string): SoulEmoteResolution | undefined :: Looks up a token in the DAT ChatPoseTable catalog (~303 tokens). Returns {pose, motionFull, myEmote, otherEmote, held}. Call free() after use. Undefined before WorldBootstrap.
- SessionHandle.sendSoulEmote / sendEmote [pkg/holtburger_web.d.ts:6140]  sig=sendSoulEmote(message: string): void; sendEmote(message: string): void (d.ts:6114) :: sendSoulEmote: pose text (0x01E1), re-broadcast as 0x01E2 within 96 m; plays no motion by itself. sendEmote: /me text only.
- SessionHandle.broadcastEmoteMotion [pkg/holtburger_web.d.ts:3416]  sig=broadcastEmoteMotion(motion_full: number): void :: Sends a transient MoveToState pulse. ACE BroadcastMovement (Player_Networking.cs:309) answers with UpdateMotion to all viewers including self. Preserves stance.
- EntityManager.setMotion / setSwingMotion [scene3d/entities.js:11576]  sig=setMotion(guid, motionCommand, motionStance, motionSpeed = 1.0); async setSwingMotion(guid, motionCmd, opts) (:11107); getStance(guid) (:8711) :: Client-only rig animation for any entity: held substate vs one-shot. Reach it through window.liveScene3d.entityManager. A server UpdateMotion for the same guid overrides it.
- SessionHandle.setMovementInput [pkg/holtburger_web.d.ts:6335]  sig=setMovementInput(forward: number, strafe: number, turn: number, run: boolean): void :: Each axis is -1/0/+1 (i8 in wasm). Call only when the input changes; all zeros means stop. Send after EnteredWorld; tickMovement is already pumped every rAF.
- SessionHandle.moveToPosition [pkg/holtburger_web.d.ts:5220]  sig=moveToPosition(landblock_id: number, x: number, y: number, z: number, run: boolean): void :: wasm MoveTo driver (retail MoveToPosition); coordinates are landblock-local AC. A new movement command replaces the one in flight. Poll pursuitStatus for 2 = arrived or 3 = failed.
- SessionHandle.turnToHeading / turnToEntity / pursueEntity / cancelPursuit / pursuitStatus [pkg/holtburger_web.d.ts:6701]  sig=turnToHeading(heading_rad: number): void; turnToEntity(target_guid: number): void (6694); pursueEntity(target_guid, radius_m, height_m, run): void (5786); cancelPursuit(): void (3548); pursuitStatus(): number (5799) :: Rate-limited retail turns and pursuit. pursuitStatus low16 = state 0-3 and high16 = WeenieError. It is READ-CLEAR and shared with the picking.js monitor and RynthWebHost.
- SessionHandle.setAutoRun / stickToEntity / stopStick / jump [pkg/holtburger_web.d.ts:6232]  sig=setAutoRun(on: boolean): void; stickToEntity(target_guid: number): void (6476); stopStick(): void (6481); jump(power: number): void (5042); canJumpNow(): boolean (3522) :: Autorun (cleared automatically when a teleport lands), local sticky follow, and jump.
- SessionHandle.getLocalPlayerPose [pkg/holtburger_web.d.ts:4408]  sig=getLocalPlayerPose(): LocalPlayerPose | undefined  // class d.ts:2329 {heading, isOnGround, landblockId, x, y, z} :: Local runtime pose. landblockId is the full cell id; x/y are landblock-local 0..192; z is world. heading: yaw counter-clockwise, 0 = +Y north, compass = -yaw. Call free() on the box after reading.
- SessionHandle.getLocalPlayerPoseCellResolved / getCurrentCellId / isCurrentCellIndoor / isPlayerReady / playerGuid [pkg/holtburger_web.d.ts:4434]  sig=getLocalPlayerPoseCellResolved(): boolean; getCurrentCellId(): number (4266); isCurrentCellIndoor(): boolean (5011); isPlayerReady(): boolean (5028); playerGuid(): number (5494) :: Honest checks for 'position resolved' and 'in world'. Use them as arrival and readiness gates.
- SessionHandle entity queries [pkg/holtburger_web.d.ts:5232]  sig=nearbyEntityGuids(max_range_m): Uint32Array; objectPosition(guid): Float64Array [landblock_id,x,y,z] (5400); objectName(guid) (5377); objectWcid(guid) (5411); objectPhysicsState(guid) (5392); objectPartDims(guid): [radius,height] (5386); objectDescFlags(guid) (5326); objectHealthFraction(guid) (5339); remoteBodyState(guid): Float32Array (5868) :: Find spawned extras by wcid and read raw wire poses and body dims (for framing, obstruction and orbit radius).
- SessionHandle.requestAppraisal / queryHealth [pkg/holtburger_web.d.ts:5943]  sig=requestAppraisal(guid: number): void; queryHealth(target_guid: number): void (5824) :: Set the ACE targets that the '@' admin verbs use. requestAppraisal sets RequestedAppraisalTarget and CurrentAppraisalTarget (ACE Player.cs:296/340). queryHealth sets HealthQueryTarget; queryHealth(0) clears it.
- SessionHandle sky/time [pkg/holtburger_web.d.ts:6366]  sig=setSkyTimeOverride(time_of_day: number): boolean; setGameDayOverride(day: number, year: number): boolean (6276); getSkyState(): SkyState|undefined (4699; fields incl. dayGroupIndex, timeOfDayNormalized, fogMin/Max, dirHeading/dirPitch); getSkyPortalTicks(): number (4675); hasSkyDesc(): boolean (4964); derethCalendarAt(ticks): any (3779); serverTime(): number (6171) :: Client-only time of day (0..1; NaN clears). Forcing DayGroup = AC weather. Both return false before populateSkyDescFromRegion.
- SessionHandle.terrainHeightAt [pkg/holtburger_web.d.ts:6652]  sig=terrainHeightAt(world_x: number, world_y: number): number | undefined :: Height of the drawn terrain triangle at world-frame x,y (x = lbX*192 + lx). Undefined for landblocks that are not baked, i.e. only near the player. Use it for @teleloc z near the current area.
- SessionHandle camera collision / viewer cell [pkg/holtburger_web.d.ts:3496]  sig=cameraSweepCollision(...8): CollisionHit|undefined; clipCameraToCellSpace(fx,fy,fz,tx,ty,tz,r,start_cell): number|undefined (3621); resolveViewerCell(...,player_cell): number (5983); setViewerCell(cell) (6395); getViewerCell() (4820); sweepSphereAgainst{BuildingMesh 6505, CellMesh 6522, CellStatics 6540, Entities 6565, Objects 6585, Scenery 6598, Statics 6611}; getRenderSet(depth) (4541) :: Sphere sweeps in world metres; CollisionHit (d.ts:752) = {x,y,z,t,normalX/Y/Z}. The Entities sweep skips creatures (retail viewer rule). setViewerCell roots the portal walks at the camera cell; use it for detached dungeon cameras.
- SessionHandle drains (DO NOT CALL) [pkg/holtburger_web.d.ts:5712]  sig=pollEntityUpdates(): EntityUpdate[]; poll_events(): ClientEvent[] (5732); pollRemotePoses(): RemotePoseFrame (5722) :: One-shot drains already owned by scene3d/loop.js:4406, the index.html pump (~6517) and loop.js:726. Film code must observe through events or the entityMap instead.
- EntityManager.setVisibility [scene3d/entities.js:7092]  sig=setVisibility(guid, visible) :: State-visibility producer, fed by the kind=17 handler (client_events.js:1532). It is composed with the cull flag in _applyEntityVisible (:2972), the only writer of root.visible.
- EntityManager.setLocalPlayerCameraOpacity [scene3d/entities.js:18991]  sig=setLocalPlayerCameraOpacity(guid, opacity) :: Hierarchical opacity fade of the local rig and its held children (retail SetTranslucencyHierarchical). camera.js _applyCameraPlayerFade (:2156) drives it while ?retailCamZoom is on (default).
- window.__cam (camDebug) [scene3d/camera.js:1484]  sig=__cam.park()/release()/set(ex,ey,ez,tx,ty,tz)/orbit(x,y,z,dist,azDeg,elDeg)/player(dist,az,el,dz)/fov(v)/info()/world() :: Free shot rig, enabled only with ?camDebug=on (_installCamDebug :1457). Coordinates are AC world metres. set() implies park(), which skips positionCamera. Uses lookAt with up (0,1,0).
- Portal-space readiness signals [scene3d/portal_space.js:1594]  sig=globalThis.__isPortalSpaceActive(); window.__portalSpace {state,arrived,arrivalCell,reason,clock} (:1173); destinationCellsReady(scene3d, cellId) (:601); signalPortalArrived (:1578) :: Teleport-cut timing. State is OFF 0, TUNNEL 3, CONTINUE 4, FADEOUT 5 or FADEIN 6 (TAS at :113).
- __pluginClient.events / world [plugins/api.js:484]  sig=events.on(name, h)/off/once/emit; handler gets a CustomEvent (payload in .detail). world.addEventListener('objectCreated', e => e.detail.object) (plugins/world-state.js:443) :: Bus events: 'portalSpaceEntered' and 'portalSpaceExited' (emitted at client_events.js:882/:933 even though api.js comments still list them as TODO), plus 'landblockChanged' and 'death'. The world events give the guids of spawned extras.
- __pluginClient.sky / .movement / .collision [plugins/api.js:895]  sig=sky.setTimeOverride(t)/setDayOverride(d,y)/state()/objects(); movement.setInput/stop/setAutoRun/turnToHeading (:733); collision.sweep* (:880) :: Versioned facade over RynthWebHost: capability-probed and degrades instead of throwing.
- window.__chatHooks [plugins/chat-hooks.js:120]  sig=__chatHooks.onIncoming(fn(ev:{text,chatType,category,eat()})) -> unsubscribe (:93); onOutgoing (:102) :: Parse ACE command replies (e.g. @tele's resolved Position line, 'not found' errors). ev.eat() hides a line from the chat panel.
- window.__setWeather / __getWeather / __clearWeatherOverride [scene3d/weather_state.js:329]  sig=setWeatherOverride({latitude_deg, longitude_deg, temperature_C, dewpoint_C, surface_pressure_hPa, season, is_storm}) :: Client volumetric-cloud weather state (meaningful with ?clouds=on). Overrides stick until cleared, so DayGroup updates do not overwrite them.
- environFogFor / window.__environFogOverride [scene3d/environ_override.js:81]  sig=environFogFor(option 1..6) -> fresh override object; set window.__environFogOverride (null = clear) :: Client-only retail fog tint with an ~20 s fade, the same path the server AdminEnvirons event drives (client_events.js:2102).
- retailLightTick [scene3d/retail_light_tick.js:154]  sig=export const retailLightTick = createRetailLightTick(); .reset() :: The terrain light refreshes every 15 s. Call reset() after a sky-time jump, otherwise the ground keeps the old light for up to 15 s (this is what always_daylight.js does).
- ACE @teleloc [/home/wbterminal/ace-server/Source/ACE.Server/Command/Handlers/AdminCommands.cs:912]  sig=@teleloc <cellhex> <x> <y> <z> [qw qx qy qz] :: Developer. Exact cell and position: no z or dungeon-cell correction; identity rotation if the quaternion is omitted; silently ignores bad floats.
- ACE @tele [/home/wbterminal/ace-server/Source/ACE.Server/Command/Handlers/AdvocateCommands.cs:156]  sig=@tele [name] <ns>n|s <ew>e|w :: Advocate+. Map coordinates with z from the server (AdjustMapCoords PositionExtensions.cs:240: terrain plus building floor, indoor cell re-seated). Rejects all-water landblocks. Identity rotation.
- ACE @telepoi / @teledungeon / @telexyz / @teleto / @teletome / @nudge [/home/wbterminal/ace-server/Source/ACE.Server/Command/Handlers/AdminCommands.cs:875]  sig=@telepoi <name>|list (Dev); @teledungeon <lbhex|name> (Dev, DeveloperCommands.cs:2068); @telexyz <cellDEC> x y z qx qy qz qw (Dev, :660); @teleto/@teletome/@telereturn <player> (Sentinel, AdminCommands.cs:785/804/825); @nudge (Dev, DeveloperCommands.cs:98) :: Named and dungeon teleports, multi-character staging, and fixing a black-space landing.
- ACE Player.Teleport / OnTeleportComplete [/home/wbterminal/ace-server/Source/ACE.Server/WorldObjects/Player_Location.cs:654]  sig=Teleport(Position, bool fromPortal=false); OnTeleportComplete() (:740) :: Sets Hidden + IgnoreCollisions, sends PlayerTeleport plus a fake UpdatePosition, delays 1 s if a fog colour is active, then waits for the landblock's CreateWorldObjectsCompleted before un-hiding.
- ACE @cloak / @attackable [/home/wbterminal/ace-server/Source/ACE.Server/Command/Handlers/SentinelCommands.cs:29]  sig=@cloak on|off|player|creature (Sentinel); @attackable on|off (Advocate+, AdvocateCommands.cs:16) :: Cloak: invisible to other players, NoDraw on own client, ethereal (passes doors), ReportCollisions off. Attackable off: monsters ignore you. Use both.
- ACE @setlbenviron / @setglobalenviron / @time [/home/wbterminal/ace-server/Source/ACE.Server/Command/Handlers/AdminCommands.cs:4646]  sig=@setlbenviron [EnvironChangeType name|id|list] (Dev); @setglobalenviron (Dev, :4682); @time (Envoy, :965, display only) :: The only server-side 'weather' control: fog tints and environment sounds. Neither time nor DayGroup can be set on the server.
- ACE @create / @createliveops [/home/wbterminal/ace-server/Source/ACE.Server/Command/Handlers/AdminCommands.cs:2175]  sig=@create <wcid|classname> [amount] [palette] [shade]; @createliveops <wcid|classname> [amount] [lifespan_s=3600] [palette] [shade] (:2192) :: Developer. Spawns extras: creatures 5 m ahead facing you (:2434); items at max(2, UseRadius); many at the same spot are spread out by physics placement. createliveops self-deletes after its lifespan (heartbeat, ~5 s granularity).
- ACE @animation / @turnto / @pscript / @effect [/home/wbterminal/ace-server/Source/ACE.Server/Command/Handlers/DeveloperCommands.cs:330]  sig=@animation <MotionCommandName> [guidhex]; @turnto (:1413, last appraised creature faces player); @pscript <PlayScript> (:3031, on last appraised); @effect <PlayScript> [scale ignored] (:289, self) :: Server-side actor direction for NPCs and creatures. Enum names are case-sensitive for @animation.
- ACE @delete / @smite / @movetome [/home/wbterminal/ace-server/Source/ACE.Server/Command/Handlers/AdminCommands.cs:90]  sig=@delete [type] (Envoy); @smite [all|name] (Envoy, :700); @movetome (ADMIN only, :4730) :: Remove extras. @delete target precedence is HealthQueryTarget > ManaQueryTarget > CurrentAppraisalTarget. A Developer account cannot use @movetome.
- ACE @run / @fast / @neversaydie [/home/wbterminal/ace-server/Source/ACE.Server/Command/Handlers/SentinelCommands.cs:212]  sig=@run on|off|toggle|check (Sentinel); @fast (Dev, DeveloperCommands.cs:2931); @neversaydie [on|off] (Sentinel, :107) :: Faster repositioning while walking the cloaked camera carrier, and immortality for safety.
- ACE GameAction AdvocateTeleport 0xD6 [/home/wbterminal/ace-server/Source/ACE.Server/Network/GameAction/Actions/GameActionAdvocateTeleport.cs:14]  sig=Handle(string target, Position pos) -> AdjustMapCoords -> Teleport :: Map-click teleport to an exact cell and x,y with z from the server (building-aware). NOT implemented in holtburger: opcodes.rs:714 is commented out. Adding it would need a wasm change.
- rynth TOWNS gazetteer [rynth/ai/tools/towns.js:5]  sig=export const TOWNS = [{name, ns, ew}, ...] :: Named town coordinates in map units, ready for '@tele <ns>n <ew>e'. Generated from DerethMaps coords.json.
- WbtOracle (WBT sidecar) [rynth/ai/tools/wbt.js:42]  sig=new WbtOracle({endpoint='http://127.0.0.1:8768'}).query({command,...}) / catalog() / health() :: In-page HTTP access to WorldBuilder.Terminal: get-height (JsonCommandProcessor.cs:2070), describe-landblock, ontology queries, dungeon info.
- calc_present_day_group [/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/crates/holtburger-world/src/sky.rs:684]  sig=pub fn calc_present_day_group(day, year, days_per_year, num_groups) -> u32 :: Retail LCG DayGroup selection. Brute-force (day,year) for a target DayGroup index, then call setGameDayOverride.

## SEAMS
- [index.html:4267] Boot plus a gate for the in-page driver => Agent opens ?nosw=1&autoLogin=1&autoSpawn=first&agent=1&hud=none&camDebug=on (plus film flags), waits for __bootState==='ready' and window.liveScene3d, then issues the setup commands '@cloak on' and '@attackable off' (optionally '@run on').
- [plugins/chat-hooks.js:93] Command channel with feedback => filmCmd(line) calls sendChat('@...') and resolves on a matching __chatHooks.onIncoming line (eat it so it never reaches the chat panel). It parses @tele's 'Position: [Cell..|Offset..]' reply to learn the server z.
- [scene3d/portal_space.js:601] Teleport-as-cut primitive => Await, in order: portalSpaceEntered, kind=66 / __portalSpace.arrived, portalSpaceExited (or __isPortalSpaceActive()===false), destinationCellsReady(liveScene3d, cell), __interiorBuildPending===false, getLocalPlayerPoseCellResolved(), then 1-2 s for the 1 s server CreateObject delay and async rig builds. Then turnToHeading. Do not capture frames while the tunnel owns the frame.
- [scene3d/entities.js:2972] Film-owned hide producer in the entity visibility composite => Add an inst._filmHidden term in _applyEntityVisible so kind=17 flips (teleport Hidden on/off) cannot un-hide the local rig. Hiding via root.visible also drops shadows and held items. Keep @cloak as the server half.
- [scene3d/entities.js:7154] Speech-bubble suppression => Gate EntityManager.showSpeechBubble (in-canvas sprites, always on, not covered by ?hud=none) behind a film flag or caption policy.
- [scene3d/entities.js:11576] Client-only actor animation => Footage is rendered by this one client, so em.setMotion/setSwingMotion on any guid (NPC extras included) gives reliable, instant direction. Use server @animation when the pose must persist against server motion updates.
- [plugins/world-state.js:443] Extras lifecycle => Spawn with @createliveops wcid n lifespan, collect guids from __pluginClient.world 'objectCreated' (or a nearbyEntityGuids + objectWcid diff), target with requestAppraisal(guid) + queryHealth(guid), then direct with @animation Cmd guid / @turnto / @pscript and remove with @delete.
- [plugins/api.js:895] Sky/time/weather control => Shot plan sets __pluginClient.sky.setTimeOverride(t) and setDayOverride(d,y) (DayGroup chosen via calc_present_day_group), then calls retailLightTick.reset(). Optional __setWeather({is_storm}) with ?clouds=on, __environFogOverride=environFogFor(n), or server @setlbenviron.
- [rynth/webhost.js:58] Movement for the player-actor and the camera carrier => Walk paths with moveToPosition/turnToHeading/setMovementInput (RynthWebHost capability table already wraps them), keeping the cloaked player within about 1 landblock of the subject so ACE (landblock + 8 adjacent / PVS) and client streaming keep the scene populated.
- [rynth/ai/tools/towns.js:5] Location sources for script-to-site planning => TOWNS ns/ew feed @tele; '@telepoi list' (parse the chat reply) feeds named jumps; WbtOracle (:8768) answers get-height, describe-landblock and ontology queries for @teleloc z and site metadata. rynth/unwedge.js:584 shows the proven @teleloc string format.
- [scene3d/entities.js:6698] Smooth subject tracking => Aim at liveScene3d.entityManager.entityMap.get(guid).root.position (rendered pose, wasm-interpolated through applyManagedPose) and apply critically damped smoothing. Avoid the raw objectPosition, which snaps on 0.2-1 s server updates.
- [pkg/holtburger_web.d.ts:6395] Detached dungeon camera rendering => When the film camera sits in a different EnvCell than the player, call resolveViewerCell then setViewerCell so the portal and render-set walks root at the camera. Use the clipCameraToCellSpace and sweepSphereAgainst* sweeps for obstruction.
- [scene3d/camera.js:1484] Free camera hook => window.__cam.park()/set() already suspends the follow camera, but it uses lookAt with up (0,1,0), which flips near pitch ±90°. Film mode's camera should own the quaternion (slerp) instead.

## HAZARDS
- [/home/wbterminal/ace-server/Source/ACE.Server/Network/GameAction/Actions/GameActionTalk.cs:21] sendChat('/telepoi X') is SPOKEN publicly: ACE parses only '@'. The d.ts doc claims '/' also works. || mitig: Always send '@cmd', or use __routeSlashCommand (which resolves soul emotes first).
- [/home/wbterminal/ace-server/Source/ACE.Server/Command/Handlers/AdminCommands.cs:945] @teleloc does no z or dungeon-cell correction and silently returns on any unparsable float. A wrong z lands you in mid-air or underground; a wrong EnvCell lands you in black space. || mitig: Prefer @tele (server z) outdoors and @telepoi/@teledungeon for dungeons. Take @teleloc tuples from recorded getLocalPlayerPose or terrainHeightAt/WBT get-height; @nudge fixes the cell.
- [/home/wbterminal/ace-server/Source/ACE.Server/Command/Handlers/DeveloperCommands.cs:660] @telexyz takes the cell in DECIMAL with quaternion order qx qy qz qw, unlike @teleloc (hex cell, qw first). || mitig: Standardize on @teleloc.
- [/home/wbterminal/ace-server/Source/ACE.Server/Command/CommandParameterHelpers.cs:227] @tele needs N/S first (regex) and gives identity rotation. In dungeon-only landblocks terrain z is 0, a void. A single-word @teledungeon argument is parsed as a hex landblock first. || mitig: Use '@tele 42.1n 33.6e' style and follow with turnToHeading. Use landblock hex for @teledungeon.
- [scene3d/portal_space.js:1] Every teleport plays the portal-space tunnel, at least ~4 s after arrival (CONTINUE ≥2 s, 1 s fade-out, 1 s fade-in; failsafes 6 s and 20 s). The world is not drawn meanwhile. Server CreateObjects for the destination arrive 1 s after the teleport, so entities pop in. || mitig: Treat teleports as edit cuts. Pause capture from portalSpaceEntered until portalSpaceExited plus a settle delay. ?portalSpace=off keeps the world visible but shows streaming pop-in.
- [/home/wbterminal/ace-server/Source/ACE.Server/WorldObjects/Monster_Awareness.cs:353] @cloak on does NOT stop monster aggro (cloak never clears Attackable). || mitig: Also send @attackable off, and optionally @neversaydie.
- [scene3d/entities.js:2972] Client-side hiding via setVisibility(localGuid,false) is overwritten by the next kind=17 event (each teleport flips Hidden on and off). Opacity fade (setLocalPlayerCameraOpacity 0) still casts shadows, and camera.js pushes opacity 1.0 when it leaves the near band. || mitig: Add a film-owned visibility producer, or re-assert after each portalSpaceExited. Keep @cloak on as the server half.
- [scene3d/entities.js:7128] Hidden player can still emit light from a held light source (pool-fed lights are not tied to root.visible except for projectiles). || mitig: Unwield torches and lights on the film character.
- [scene3d/speech_bubble.js:1] In-canvas speech bubbles (NPC chatter, emote text) appear in footage. They are always on and not gated by ?hud=none; the portal tunnel is in-canvas too. || mitig: Add a film gate in EntityManager.showSpeechBubble. Avoid triggering NPC speech.
- [scene3d/always_daylight.js:36] The 'Always daylight outdoors' option (CharacterOption 0x05) re-pins setSkyTimeOverride(0.5) every 250 ms. A ?skytime URL pin disables that driver. || mitig: Turn the option off on the film character (setCharacterOption(5,false)) or boot with ?skytime=...
- [scene3d/always_daylight.js:21] The sky override is lost on relog (populateSkyDescFromRegion makes a new evaluator at every EnteredWorld). Ground lighting lags up to 15 s after a time jump. || mitig: Re-assert after every EnteredWorld and call retailLightTick.reset() after each time change.
- [/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/src/lib.rs:20994] The moon/star clock (getSkyPortalTicks → sky_game_date.js) ignores setSkyTimeOverride, so night shots may show a moon and stars inconsistent with the pinned sun time. || mitig: Eye-check night shots on the 1070; a film-side date override may be needed (camera/sky agent).
- [docs/url-flags.md:493] No server time or DayGroup control. Rain/snow/lightning particle systems were removed (2026-08-01); 'weather' is DayGroup sky objects plus volumetric clouds plus fog. || mitig: Use setGameDayOverride + __setWeather + ?clouds=on. Note CharacterOption 0x04 (disable weather) drops the rain/snow sky objects.
- [/home/wbterminal/ace-server/Source/ACE.Server/Command/Handlers/AdminCommands.cs:256] Dead or forbidden admin verbs: @freeze/@unfreeze are no-op TODOs, @createcreature is commented out, @location is a stub, @movetome is Admin-only, @morph logs you out, @portalstorm 2 teleports you to 0x7F7F001C. @rotate, @nudge (content version) and @createinst write ace_world SQL (permanent content edits). || mitig: Whitelist film verbs: tele*, cloak, attackable, create/createliveops, animation, turnto, pscript, effect, delete, setlbenviron, run, neversaydie.
- [/home/wbterminal/ace-server/Source/ACE.Server/Command/Handlers/AdminCommands.cs:96] @delete removes HealthQueryTarget first, then ManaQueryTarget, then CurrentAppraisalTarget. A stale selection deletes the wrong object (players are protected). || mitig: Call queryHealth(guid) (or queryHealth(0)) and requestAppraisal(guid) right before @delete, or prefer @createliveops lifespans.
- [/home/wbterminal/ace-server/Source/ACE.Server/Command/Handlers/AdminCommands.cs:2434] @create returns no guid. Multiple spawns go to the same spot (physics placement may drop some). Extras persist until the landblock unloads (5 min with no players); a dormant landblock (1 min) stops ticking. || mitig: Capture guids via objectCreated or a nearbyEntityGuids diff. Use @createliveops lifespans and spawn in batches.
- [scene3d/loop.js:4406] pollEntityUpdates, poll_events and pollRemotePoses are destructive drains; pursuitStatus is read-clear. Film code that calls them steals renderer, nav or bot events. || mitig: Observe via __pluginClient events, entityMap reads or __chatHooks only. Don't run film nav beside the rynth bot or picking monitor.
- [/home/wbterminal/ace-server/Source/ACE.Server/Command/Handlers/DeveloperCommands.cs:330] @animation uses case-sensitive MotionCommand names and sets ForwardCommand. Whether the LOCAL rig applies a server UpdateMotion aimed at self is unverified. The soul-emote spam guard drops a repeat of the same emote within its animation length. || mitig: Direct the player via the soul-emote path (local prediction plus broadcast). Use @animation or client setMotion for NPCs.
- [/home/wbterminal/ace-server/Source/ACE.Server/Physics/Common/ObjectMaint.cs:352] Streaming is player-centric. ACE sends objects only from the player's landblock + 8 adjacent (outdoors) or the PVS (dungeons, no adjacent). The client heightmap ring is 3x3 around the player. A drone camera far from the cloaked player sees an empty or partial world. || mitig: Move the cloaked player with the shot (walk or teleport near the subject). Keep the camera within about 1 landblock of the player, and wait for the 1 s CreateObject delay after a teleport.
- [/home/wbterminal/.claude/projects/-home-wbterminal/memory/fleet-runbooks.md:1] Single-login accounts: relaunch needs a ~25 s gap or both sessions get 'Account In Use' kicks. The stream-soak bot also uses tailnet1. || mitig: Use a dedicated Developer-level film account; account creation is an owner decision.
- [pkg/holtburger_web.d.ts:6652] terrainHeightAt and portal readiness only work for landblocks resident on this client (near the player). || mitig: For distant @teleloc z use WBT get-height via WbtOracle, or @tele's server-derived z.

## DATA
- {'name': 'ACE points of interest', 'location': "MySQL 127.0.0.1:3306 ace_world.points_of_interest (creds in $ACERT/Config.js); in-game '@telepoi list'", 'format': 'SQL table; chat list reply', 'notes': 'Names for @telepoi; matching is exact and case-insensitive (WorldDatabaseWithEntityCache.cs:687).'}
- {'name': 'rynth TOWNS gazetteer', 'location': 'apps/holtburger-web/rynth/ai/tools/towns.js:5', 'format': 'JS array {name, ns, ew} in map units', 'notes': "Feeds '@tele <ns>n|s <ew>e|w' directly. Source is external/DerethMaps/coords.json."}
- {'name': 'ACE SoulEmote catalog', 'location': '/home/wbterminal/ace-server/Source/ACE.Server/Entity/SoulEmote.cs', 'format': 'C# HashSet<MotionCommand> with alias comments (75 entries)', 'notes': 'Valid emote motions (SitState, KneelState, DrudgeDanceState, Wave, ...). The in-client DAT catalog of ~303 tokens is available via resolveSoulEmote.'}
- {'name': 'ACE MotionCommand enum', 'location': '/home/wbterminal/ace-server/Source/ACE.Entity/Enum/MotionCommand.cs', 'format': 'C# enum (names are case-sensitive for @animation)', 'notes': 'For example Sitting=0x41000013, SitState=0x4300013D, Wave=0x13000087, BowDeepState=0x430000EC.'}
- {'name': 'EnvironChangeType', 'location': '/home/wbterminal/ace-server/Source/ACE.Entity/Enum/EnvironChangeType.cs', 'format': 'C# enum', 'notes': 'Fog 0x01-0x06; sounds 0x65-0x7B (Thunder1-6 = 0x76-0x7B); Clear 0. Client colours are in scene3d/environ_override.js:66 ENVIRON_FOG.'}
- {'name': 'LSD weenie summary', 'location': '/home/wbterminal/WorldBuilder-ACME-Edition/external/LSD-Partial-2025-02-23_16-15/weenie_summary.jsonl', 'format': 'JSONL, 19,686 rows {wcid,name,weenieType,setupDid,level,creatureType,itemType}, 2.5 MB, line 1 has a BOM', 'notes': 'For choosing extras: weenieType 10 = Creature. It is a partial dump, so the live ace_world is authoritative.'}
- {'name': 'WorldBuilder.Terminal via sidecar', 'location': 'http://127.0.0.1:8768 (rynth/ai/tools/wbt.js WbtOracle); commands in WorldBuilder.Terminal/JsonCommandProcessor.cs', 'format': 'JSON over HTTP POST /command', 'notes': 'get-height (:2070), describe-landblock, get-dungeon-info, analyze-dungeon-catalog, query-ontology, scan-ontology. Use for teleport z and site metadata.'}
- {'name': 'holtburger url-flags master', 'location': 'apps/holtburger-web/docs/url-flags.md', 'format': 'Markdown table', 'notes': 'Flags: skytime, clouds, cloudCoverage, wxMap, portalSpace, hud, agent, camDebug, retailCamZoom, environRetail, weatherOption. Its index.html line references are stale (index.html is now 6645 lines).'}
- {'name': '1070 look-pass handoff and tools', 'location': 'apps/holtburger-web/docs/HANDOFF-1070-look-pass-2026-10-08.md + docs/2026-10-08-1070-look-pass-tools/g.mjs', 'format': 'Markdown plus playwright-core CDP driver (.mjs)', 'notes': 'Proven CDP driver (status, eval, snap via canvas inside render(); page.screenshot comes back black) and the sky t presets (Dawn 0.21, Morning 0.33, Noon 0.5, Dusk 0.89, Night 0).'}

## RECS
- Build film world-control as a pure in-page JS module behind ?film=on (default OFF). Its only entry points are window.__sessionHandle, __pluginClient (sky, movement, events, world), liveScene3d.entityManager, __chatHooks and __routeSlashCommand. The Claude Code session drives it over CDP Runtime.evaluate with no Anthropic API and no wasm rebuild for v1.
- Film setup sequence after __bootState==='ready': '@cloak on', '@attackable off', '@neversaydie on', optionally '@run on'; setCharacterOption(5,false) (always-daylight off); boot with ?hud=none&agent=1&camDebug=on.
- Teleport policy: outdoor exterior sites use '@tele <ns>n|s <ew>e|w' (server z, building-aware; convert with ew = gx/240-101.95, ns = gy/240-101.95). Towns and dungeon entrances use '@telepoi <name>'. Dungeon starts use '@teledungeon <lbhex>'. Exact re-framing uses '@teleloc 0xCELL x y z qw qx qy qz' with tuples recorded from getLocalPlayerPose. Always follow with the portal-space readiness chain and turnToHeading.
- Treat every teleport as an edit cut and stop capture across the tunnel. For continuous moves (dolly, tracking, dungeon fly-through) walk the cloaked carrier player with moveToPosition/setMovementInput and keep the camera within about 1 landblock of it.
- Add a film-owned visibility term (inst._filmHidden) to _applyEntityVisible (entities.js:2972) and a film gate in showSpeechBubble (entities.js:7154). Both are small JS edits with targeted node tests only.
- Actor direction: the player uses __routeSlashCommand(handle,'/<soul emote token>') (catalog in ACE Entity/SoulEmote.cs). NPC extras use client em.setMotion/setSwingMotion for instant control, or '@animation <MotionCommandName> <guidhex>' for server-persistent poses. Facing: position the player, then requestAppraisal(guid) + '@turnto'.
- Extras: '@createliveops <wcid> <n> <lifespan_s>'; collect guids from __pluginClient.world 'objectCreated'; remove with queryHealth(guid)+requestAppraisal(guid)+'@delete'. Pick wcids from the LSD weenie_summary or the live ace_world.
- Time and weather plan per shot: setSkyTimeOverride(t) plus retailLightTick.reset(); DayGroup via setGameDayOverride(day,year), solving calc_present_day_group offline per target index; optional __setWeather({is_storm}) with ?clouds=on on the 1070; fog via __environFogOverride=environFogFor(n) (client-only) rather than server @setlbenviron (which persists and delays teleports by 1 s).
- Give JEV typed enums only: POI names (from '@telepoi list'), SoulEmote tokens, MotionCommand names, EnvironChangeType ids, DayGroup indices and sky t. The agent turns JEV choices into the commands above.
- Optional later (one orchestrated wasm build): expose GameAction AdvocateTeleport (0xD6) as SessionHandle.advocateTeleport(cell,x,y,z) for exact x,y with server-derived z inside buildings.
- Subject tracking must read entityMap.get(guid).root.position (rendered, interpolated) with critically damped camera smoothing, not objectPosition.
- Do not call pollEntityUpdates, poll_events, pollRemotePoses or pursuitStatus from film code, and do not run film mode alongside the rynth bot (?bot=1).

## OPENQ
- Live check needed: does @cloak on actually hide the LOCAL rig on our client (SetState NoDraw|Cloaked → kind=17 → setVisibility(localGuid,false))? The code chain implies yes.
- Does the local rig play a server UpdateMotion aimed at self (e.g. '@animation SitState' with no guid), or is that path suppressed for the local player?
- What is the film account's real access level? Memory says tailnet1 = Developer. Admin-only verbs such as @movetome would need a set-accountaccess decision by the owner.
- Retail Dereth DayGroup names and order: daygroup_weather.js assumes an inferred 20-entry order. A WBT/DAT Region SkyDesc dump is needed to map 'rainy/snowy/stormy' requests to indices reliably.
- Should film mode keep portal space on (clean black cut) or use ?portalSpace=off (world visible, streaming pop-in) between shots?
- Does the holtburger client cull known objects that left server visibility (ACE expects the client to cull after the 25 s DestructionTime), or do stale extras linger in the entityMap?
- Do monster extras with @attackable off stay put, or do some creature emote scripts make them wander out of frame?
- How far do the takram far-terrain ring and object residency draw around the player? This decides the maximum drone altitude and distance (render/camera agent's area).
