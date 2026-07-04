# HANDOFF — post-flip session 4 work order: 1070 eyetest batch + P14 swirl + research integration (2026-07-04)

Session 8 of the movement-port arc. Session 7 (job 333ff13e, this doc's
author) executed the full postflip3 click-family/shim/Dead-bake work
order: ALL SIX items landed with live headless verification. READ FIRST:

1. This doc.
2. `docs/HANDOFF-postflip3-clickfamily-shim-2026-07-04.md` — the prior
   work order (all items 1-6 DONE; item 7 = P01-P10 integration still
   open, feeds menu item 5).
3. `/mnt/wbterminal2/fleet-wave2/parts/p11..p16.md` only as reference —
   their verdicts are now adjudicated by live evidence below (and one
   fleet cite was WRONG: the portal default_script is 0x3300067A, not
   p14's 0x33000B7A — read-verify rule vindicated).

Commits this session: `f772413f` (click-family JS) → `985f26e5`
(Dead-bake clamp + authored lengths + self-pickup removal + crumbs) →
this doc. Floors at HEAD: core 571/10 (failing set identical to the
pre-change baseline by md5 diff-under-stash — the same pre-existing
10), web 128/1 (pre-existing tests_substitution), world 542/0,
rust_pose.test.cjs 1/0 (as measured via `node --test`; the prior
"13/0" note counted differently), wasm32 check clean; release wasm
(md5 4a0d214d…) deployed to pkg/ (ships the frame clamp +
ingestMotionLengths + both self-pickup KIND_REMOVE lanes).

## What landed (all six work-order items) + live evidence

Evidence JSONs: `~/.claude/jobs/333ff13e/tmp/s7-verify.json` (leg 1),
`s7-leg2.json` … `s7-leg7.json` — real-render wireframe
SwiftShader legs against live ACE (tailnet1/+Tester2, Holtburg).

1. **P11 Dead-bake — ROOT-CAUSED + FIXED (the big one).** The user's
   "most monsters show no dying animation" = **164/296 creature
   MotionTables author Dead as a PAST-END freeze-frame**
   ({low_frame:N, high_frame:-1, framerate:0} over an N-frame anim —
   tusker 0x0900000C over the 40-frame anim 0x0300001A; survey example
   `crates/holtburger-dat/examples/survey_dead_cycles.rs`). Retail
   CLAMPS out-of-range frame refs (AnimSequenceNode::set_animation_id,
   acclient.c:341108-341127: high<0→last, low>=N→last, high>=N→last,
   high<low→low); our exclusive-slice `.min(total)` + `low>=high→skip`
   dropped the whole cycle → the live creature held idle through death
   AND the corpse's spawn-time Dead bake came back frameless. The clamp
   is now ported into `build_concatenated_motion_frames`
   (lib.rs, with the retail cite; native probe test
   `tests_p11_dead_pose_bake` pins tusker Dead = 1-frame prone hold,
   fragment Dead = real 30fps clip). Belt-and-braces: `_spawnImpl`'s
   bake is no longer fatal on a non-idle initial motion — rest-pose
   fallback + `spawnBakeFallbacks` counter + console line
   (entities.js). **Live: "Corpse of Male Tusker" commits with the full
   25-part rig, motionCommand 17, odfCorpse true, zero fallbacks, zero
   spawn errors** (leg 2). The corpse pose = prone frame-40 hold =
   retail-correct snap-slump (many creatures have NO animated collapse
   in the DAT; the fragments' 30fps collapse is the exception).
2. **P15 ground pickup — reroute + classifier landed; arrival problem
   PRECISELY characterized.** picking.js: `entityIsGroundItem`
   (positive ItemType list; ODF exclusions Player|Vendor|Door|Corpse|
   LifeStone|Portal — deliberately NOT Stuck/Attackable: **ACE stamps
   Attackable on loose items** (live dagger ODF=0x12) and
   Stuck|Attackable on creatures) routes double-click →
   `moveItem(guid, player, 0)` = PutItemInContainer 0x0019 (retail:
   DetermineUseResult cat-2 → PlaceInBackpack,
   acclient.c:433157/400454/708849). Double-click feel retained.
   Self-pickup ground-rig removal landed on TWO lanes: a direct
   pre-route arm on GameEvent 0x0022 (ItemServerSaysContainId — the
   only self-pickup signal; PickupEvent/ObjectDelete are the
   other-players lanes) and the canonical
   PropertiesUpdated{Container≠NULL} arm (inert until ?worldLifecycle
   routes mid-session ObjectCreates into state.entities — leg-4 probe
   proved move_entity_into_container bails today).
   **HEADLESS BLOCKER (legs 4-7): the pickup itself never completes
   for the bot — ACE replies UseFailed ActionCancelled (code 54)**:
   CreateMoveToChain[2] (FastTick) cancels its walk-in even at ~2 m
   (position desync REFUTED: @create audit pos [84.31, 9.08] vs client
   pose [84.0, 7.1], same LB). Same MoveToChain family DID succeed for
   the corpse open (leg 3: UseDone success after ~25 s walk), so it is
   state-dependent — THE p02/p03 arrival problem in miniature, exactly
   where the postflip3 order already deferred it. Client-side failures
   now SURFACE (kind-13 UseFailed renders in console + System chat).
3. **P12 corpse loot — carve-out hoisted above the stance dispatch.**
   Retail sends the corpse Use from EVERY stance
   (ItemHolder::UseObject acclient.c:433354); our magic branch had
   none. Now one stance-independent corpse branch (+ shared
   `doubleClickGate` helper replacing 3 inline copies). **Live:
   `ContainerOpened Corpse of Male Tusker items=4` + UseDone(success)
   in a combat stance; peace open also completed after ACE's walk-in**
   (leg 3). Leg-1/2 "failures" were test artifacts: empty chicken
   corpse decayed in seconds; 10s poll window shorter than ACE's
   MoveToChain walk.
4. **P13/P16-H2 completion-clock — REAL authored lengths (session-5 debt
   paid).** `RENDERER_DONE_FALLBACK_SECS=2.0` is now fallback-only:
   `do_interpreted_motion` (the single 1-anim enqueue chokepoint — both
   the DoMotion lattice AND the wire-stomp
   `apply_interpreted_movement`/action-replay funnel through it)
   resolves (stance, motion, |params.speed|) via
   `authored_len_for` — a thread_local table (triangulation-memo
   precedent) the wasm ingests once the local player's MotionTable is
   cached: `SessionHandle.ingestMotionLengths(mtableId)`, fired from
   entities.js at the local spawn commit; resolution walks ALL
   from-Ready links via the lookupMotionLinkForSwing machinery
   (explicit ranges + freeze-frame holds + play-to-end via cached
   Animation frame counts, retail clamp applied). Speed divides like
   retail multiply_framerate; clamps [0.05, 30]. Loop-class cycles stay
   structurally exempt (renderer_num_anims==0). Unit tests pin
   authored-over-fallback + scaling + wholesale replace. **Live:
   `[mtlen] 0x09000001: ingested 119 authored one-shot lengths`**
   (explicit-range links; play-to-end links whose Animation records
   weren't in the page cache at ingest keep the 2.0s fallback — the
   native resolver over the full DAT yields 531; a prefetch pass would
   close the gap, noted below).
5. **P16-H1 kite killer — face-turn yields to held keys.**
   `turnToFaceThenAct` now no-ops to `act()` while a manual movement
   key is held (retail: raw input cancels MoveTo, acclient.c:339240;
   ACE still turns the caster server-side). Input source:
   camera.js `_dispatchMovement` stashes `lastMoveIntent` every tick
   (both cmdInterp modes; null under orbit). Stale "default-off"
   comment at the CAST_FACE_TARGET reader fixed (default-ON since the
   flips). **Live: intent stash reads idle/held-S/released correctly**
   (leg 1). Applies to the missile face-turn too (same helper).
6. **P14 portals — premise RESOLVED, remaining hop identified.** On a
   real render page both Holtburg portals hydrate AND bake
   (entityMap: setup 0x020001B3, mesh child "Group:part_0"), wire
   physicsScriptDid=0x0, and the Track-B setup-default-script arm
   RUNS: `fetchSetupDefaultScript(0x020001B3) = 0x3300067A` (DAT
   ground truth via WBT — the fleet's 0x33000B7A was a miscite) and
   the chain walker logs `fetched PS=0x3300067a entries=4`. So: not
   streaming, not hydration, not the bake, not the script fetch — the
   remaining hop is **emitter attach/visibility** (ScriptManager
   `_queuePhysicsScript` → `_fireHook` type-13 → ownerRegistry), which
   SwiftShader+wireframe cannot judge. 1070 item + trace plan below.
   Crumbs landed: `nullSetupSkips` counter (+`__diag.onSpawnFailed`)
   for the silent setupId=0 skip; spawns.js weenieType-7 = Portal
   relabel; two stale "(default OFF)" flag headers fixed
   (defaultScriptSpawn / setupDefaultScript are default-ON).

## Work order (value order)

1. **1070 eyetest batch (ONE session, bare defaults — no new flags were
   added; everything ships default-on):**
   - Tusker/drudge kill: dying creature snaps to the prone hold (no
     idle statue), corpse renders prone with full rig (P11).
   - Hold-S + click-cast at a target: backward survives the click
     (P16-H1); sanity-compare `?castFaceTarget=off`.
   - Keyboard cast while holding S: gesture completes on the authored
     clock; no ~2s moonwalk-to-idle (P13/P16-H2 via [mtlen]).
   - **Peace S-walk 10s: does the ~2s idle revert still occur?** THE
     discriminator for P13-R3 (ACE echo stomp vs the now-fixed clock).
     If it persists: chase R3 (leg recipe in p13.md §live-verification;
     the R2 edge-trigger amplifier heal — re-assert the gait clip when
     predictor-moving but rig-idle — is the fix shape, camera.js:1874).
   - Dagger/mug double-click pickup with REAL input: walk-over +
     pickup anim + ground mesh vanishes + lands in pack (P15). If the
     1070 ALSO gets "UseFailed ActionCancelled code=54", the arrival
     problem is not bot-specific and the p02/p03 session inherits a
     clean repro (legs 5-7 in jobs-tmp).
   - Magic stance with wand armed: double-click corpse LOOTS instead
     of casting at it (P12's magic arm — headless legs proved the wire
     from HandCombat; the wand-armed branch decision is the same
     hoisted code).
   - Portal: is the 20-poly core visible up close? Is the swirl
     present? (P14 — if swirl absent, run the trace below.)
2. **P14 swirl trace (if 1070 shows no swirl):** the chain is proven to
   `_queuePhysicsScript(guid, rig, 0x3300067a, entries×4, ...)`. Add a
   temporary counter/log in the ScriptManager `_fireHook` CreateParticle
   (13/26) arm + `ownerRegistry.emitterCountForOwner(guid)` probe for
   the portal guid; check the emitter actually constructs (ParticleManager
   world-side) and whether the 4 entries' start_times/durations expire
   instantly (a portal swirl must be a PERSISTENT looper — if the DAT
   emitter is finite-duration, retail re-fires it; check
   `_queuePhysicsScript`'s repeat semantics for setup default scripts).
3. **[mtlen] coverage widening (small):** 119/531 lengths resolve at
   ingest (page cache misses on play-to-end Animation records). Either
   prefetch the from-Ready link anims' headers during ingest (async
   walk, then re-ingest), or accept 2.0s fallback for those (they're
   mostly emotes; casts have explicit ranges and ARE covered). Decide
   by 1070 feel.
4. **P01-P10 research integration** (menu item 5 feed) — unchanged from
   postflip3 item 7; read-verify every cite (see the 0x33000B7A
   miscite above for why).
5. **Chat Enter-to-send** (user-reported, still open) + **mid-session
   nullRender hydration gap** (bot-flags-scoped, still open) — carried
   forward unchanged.

## Traps hit this session (do not re-hit)

- **`rg -rn` struck AGAIN** (this session, twice in one command batch —
  the `-r n` replace silently rewrote match text as "n" and nearly sent
  the investigation down a wrong path). Plain `rg -n`. The trap note
  works only if you read it BEFORE typing.
- **Corpse-decay race in legs:** an EMPTY corpse (chicken) despawns in
  seconds — leg probes against it read as failures. Use a loot-carrying
  creature (tusker) and open FAST, or the poll window straddles decay.
- **ACE MoveToChain time in probes:** useObject on a corpse a few
  meters away = ACE walks the player first; UseDone landed at +29s.
  Poll windows must cover the walk or gate on UseDone, not wall time.
- **@smite (targeted) silently no-ops without a server-side health/query
  target** — requestAppraisal does NOT set it. Use `@smite all` in a
  clear area, or query health first.
- **`?wireframe=1` cannot judge particles/swirls** — scene-graph checks
  only (children lists, ownerRegistry counts). Visibility = 1070.
- **Leg JSONs must carry runId + finishedAt** (stale-stub trap from
  session 6 — respected this session, keep respecting it).

## Infrastructure state (as of session end)

- buildbox: still POWERED OFF (unchanged). OAuth-expiry bot-lore in
  postflip3 doc still applies for any future fleet launch.
- serve.py :8765 up (`--allow-missing`), ACE up (same pid, 9+ days),
  tailnet1/+Tester2 returned to its login spot (leg 1 courtesy
  teleloc; legs 2-4 ended in Holtburg — a pile of smited-creature
  corpses NE of the meeting hall will decay on their own).
- pkg/ carries the session-7 RELEASE wasm (frame clamp +
  ingestMotionLengths + self-pickup KIND_REMOVE; 4,715,862 B). The
  pkg-s7/ staging dir is left in place (gitignored — parallel-build
  clobber protection pattern); pre-session wasm backup at
  `~/.claude/jobs/333ff13e/tmp/wasm-backup-pre-session7.wasm`.
- Leg drivers for reuse: `s7-verify-leg.mjs` (full matrix),
  `s7-leg2/3/4.mjs` (corpse/wire-delta/pickup) — the wire-delta
  bracketing pattern (`__diag.wire.summary()` byKind before/after an
  action) is the new reusable bit; kind map lives in
  scene3d/diag/wire.js:39-46.
