# HANDOFF — Surveyor rounds 1+2: death/cell-0 fix, escape ladder, z-flatten wedge (2026-07-21, session 6)

Follow-on to `HANDOFF-surveyor-frontier-2026-07-21.md`. Orchestrated session (Opus + Sonnet agents).
Suite stays **39 passed / 0 failed / 2 skipped** (`node rynth_test_all_node.cjs` from `apps/holtburger-web`).
Nothing committed yet — all round-1+2 work is uncommitted in the working tree (14+ files; `git status`).

## What landed (all live on the stream rig since ~13:34 relaunch)

**Wasm (release build 4.84MB, pkg mtime Jul 21 12:06; laptop capped-build):**
- (a) `handlers/player.rs`: same-teleport-epoch reconcile backstop — any accepted self
  UpdatePosition hard-reconciles (Snapshot) when the runtime body is MISSING or null-celled.
  ACE sends TWO UpdatePositions per teleport epoch (posA pre-settle at Player_Location.cs:690,
  posB settled via Player_Tick.cs UpdatePlayerPosition); old code consumed only posA — a null
  posA RETIRED the body outright and posB fell into bookkeeping-only. Test: state/tests.rs
  `post_teleport_posa_null_cell_then_posb_valid_cell_heals_via_body_cell_null_backstop`.
- (b) `holtburger-core movement/system.rs`: 3s stale-null watchdog (`CELL_NULL_STALE_TIMEOUT`),
  force-adopts healed pose via `AuthoritativeBodySync::Reset` (re-arms arrival placement).
  Tests in system/tests.rs `mod stale_null_cell_watchdog`. world 576/0, core 603/0.

**Harness JS round 1 (Surveyor follow-ups):**
- director.js: CORRECTION-turn carve-out — use_object on portal/exit-NPC counts as movement in
  portal-only dungeons (the old flat ban caused the exit_building-forever loop). Persona: hunting
  is now agency ("hunt_start/hunt_stop"), not prohibition.
- extensions.js: Exit-hint line when kind==='dungeon' (nearest portal/NPC + dead-end caution);
  "Hunting: ON/OFF" line; MOVEMENT-frozen line.
- bot.js: `_escalatePortal` rung (walk-to/use nearest ODF_PORTAL 0x40000 object, `_deadEscapeGuids`
  blacklist on no-pose-change ~20s); movement-dead watchdog (`_hopsSincePoseChange>=4` &&
  `now-_lastMoveAt>3min` → `_movementDead`+`_standDown`, self-resets on real movement).
- combat_loop.js `enabled` flag + world.js `hunt_start`/`hunt_stop` actions (kernel boot default unchanged).
- explore_memory.js: tile.kind tagging via classifyPlace; frontier() restricted to same-lb inside
  dungeons; outdoor frontier excludes `_dungeonLandblocks`.

**Harness JS round 2 (from the 30-min observation, report in agent transcripts):**
- bot.js `_walkGraphPath`: REAL pathing — indoor_router `findPath` (already exported, previously
  unused by the controller!) + toLegs + multi-leg `bot.travel`. Wired into _frontierHopIndoor,
  _legacyIndoorSweep, _escalatePortal. Root cause of the 92× unreached "frontier hop to 0x860201b0":
  `toLegs(graph,[cur,target])` with no adjacency = straight line into doorframes. (The director's
  own use_object approach() path already routed correctly — "walk:routed(N)".)
- bot.js `_seenPortals` LRU(64) ledger — portals drop out of NearbyGuids when rooms away (verified
  live: Central Courtyard 0x78602052 absent from nearby set at the lifestone rooms); rung now
  walks back to remembered portals via graph path.
- extensions.js `interactionMemory` (`ext.interactions`) — general no-effect tracking: use_object
  with no observable change twice → rung skips guid + LOCATION renders
  'no-effect: you have used "<name>" N× — try something else.' (kills the 29× Society Greeter class
  generically; operator explicitly rejected any academy/content-specific logic).

## Key operator decisions this session
- NO teleport escapes by the bot ever (walking into / using in-world portal objects IS legitimate).
- Combat kernel = director-togglable, boot default unchanged.
- General-purpose only: no hardcoded names/cells/wcids in production harness code.
- Embeddings (gte-base) considered for repetition detection → deferred; cheap lexical
  (trigram/Jaccard plan-similarity) first if wanted; embeddings only if paraphrase loops appear.

## Lifestone/Sanctuary root (confirmed vanilla-ACE mechanics)
Creation: Sanctuary=academy start cell (PlayerFactory.cs:393), Instantiation=starter town.
ONLY re-binds via Lifestone use or emote 63 SetSanctuaryPosition — carried by
`portalnewbieexitholtburg` (wcid 29338, instance cell 0x86020169) and `academyguardexitholtburg`
(29324, cell 0x860201B0), firing on collide OR use (Portal.cs OnCollideObject→ActOnUse→OnPortal).
Central Courtyard (31061) + Outer Courtyard (29334) portals are DEAD in this world DB (no teleport
emote — "destination not yet implemented"). Vendbot's Sanctuary is STILL the academy → every death
re-anchors it there next to the sparring golems. One real exit through 29338 fixes it permanently.
Jonathan token flow (knowledge.grounded.json): guard gives Academy Exit Token; give it back →
teleport. use_object alone does NOT teleport (verified live).

## OPEN — the z-flatten wedge (current blocker, live right now)
ACE log smoking gun (1s after 13:34:09 login):
`failed transition from 0x860201B0 [20.849 -19.655 0.005] to 0x860201B0 [20.849 -19.655 0]` —
only z differs. Client flattens z to EXACTLY 0 right after any placement into these EnvCells;
z=0 is fractionally below the walkable plane → server rejects ALL subsequent transitions →
hard movement wedge. Every frozen pose observed today had z=0. ACE relocates spawns to z=0.005.
Operator `@teleloc ... 0.05` test: client flattened z back to 0 within seconds, raw cell → 0x0,
movement stayed dead. Intermittent: some sessions move fine for ~40min (12:15 relogin) before
wedging; 13:34 boot wedged instantly.
Also: raw `getLocalPlayerPose()` cell stays 0x0 after ANY teleport-ish arrival all session even
while movement works (host.TryGetPlayerPose heals JS-side) — the raw accessor reads something
other than the runtime body; and wasm fix (b) does NOT revive the 13:34 wedge — suspect the body
is absent entirely (retired) so `runtime_body_id_for_guid` returns None and the watchdog never
arms (fix (a) covers missing-body only on the UpdatePosition receive path).
CONFIRMED before the investigation was wrapped up: suspicion (2) is literal — the watchdog's
body-lookup match has `None => false` at movement/system.rs:6070, so a fully-retired body never
arms it.
NEXT: wasm-side investigation — (1) where does the client z-flatten to 0 on arrival placement
(floor solve epsilon? kickDance? arrival placement writing z=0?); (2) make fix (b) arm when the
body is MISSING, not just null-celled; (3) the raw-pose accessor gap. Reference: my probes +
ACE Physics transition acceptance (OnWalkable/contact plane epsilon) + retail decomp z handling.

## Ops notes (this session)
- serve.py logs ONLY 4xx/5xx (log_message override) — absence of .js/.wasm GET lines is normal;
  .js/.wasm are served no-cache (revalidate each request). Don't re-diagnose "stale wasm" from
  the quiet log. pkg wasm release-shaped 4.84MB.
- Deploy recipe that works: wipe `holtburger_ai_journal_v1` + `holtburger_ai_scratchpad_v1` from
  Local Storage via CDP (keep `holtburger_ai_key_v1`, `rynth.atlas.v1`), kill stream/profile-game
  chromium, rm profile-game/Default/{Cache,"Code Cache",GPUCache}, `bash launch.sh` (already synced
  with phi-4/0.5s/explorer/explorePressure flags), expect ONE error-boot → reload → in-world.
- Raw CDP without daemon: scratchpad `cdp_eval.py` (stdin JS → Runtime.evaluate on :9223 page).
- Vendbot = char 1342177603, account vendortest, ADMIN. Shard DB positions:
  `biota_properties_position WHERE object_Id=1342177603` (type 1 Location / 4 Sanctuary).
- Deaths today: 09:46 Shivver (0x96D9003C), 10:35+10:42+11:05 Sparring Golems (in-academy).
  Movement survived the first two respawns, wedged after 11:05 → that's the intermittent race.
