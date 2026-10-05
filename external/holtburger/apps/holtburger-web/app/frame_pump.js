// app/frame_pump.js — the second half of the per-frame net pump: drain the
// EntityUpdate channel (with the ?entDrainBudget burst budget, the unified /
// legacy 2D dispatch and the unconditional upd.free()), drive the cli's
// MovementSystem tick (gated by the A1-O3 syncTickOwned claim), run local
// client-side prediction, and send SetMovementInput / local motion+sidestep
// layers on keystate-axis change.
//
// Moved VERBATIM out of index.html's pumpNetFrame() (2026-10-05), which now
// stamps the heartbeat, drains poll_events through app/client_events.js and
// then calls pumpEntityUpdatesAndInput(). Closure state arrives in `D`
// (index.html's __framePumpDeps): consts/functions destructured per call, the
// session `let`s (spawnedPlayerGuid, enteredWorld, lastPredictionTime,
// lastInputSig, lastForwardAxis) through D's live accessors.

import { getInputController as __getInputController, resolveRunModifier as __resolveRunModifier } from "../scene3d/input.js";

export function pumpEntityUpdatesAndInput(D) {
  const { playerRunRate, __inputFunnelOn, entityMap, __UNIFIED_DISPATCH, SPRITE_HEADING_OFFSET,
    handlePositionUpdate, handleEntityRemove, handleEntityMetaRefresh, handleEntityVelocity,
    handleEntityMotion, dispatch2dSpawn, neutralSpawn, neutralRemove, __dispatch2d, handle,
    BASE_RUN_FORWARD_SPEED, WALK_FORWARD_SPEED, RUN_HELD_TURN_SPEED_RAD_PER_SEC,
    NON_RUN_HELD_TURN_SPEED_RAD_PER_SEC, keyState, __axisValue, CAST_MOVE_ON, CMD_INTERP_ON } = D;
  // Phase 4 step 2b: drain the parallel entity-update channel
  // and apply each update to the scene graph by GUID. The
  // channel runs at the same cadence as poll_events but
  // typically carries 100s/sec in a populated zone, so it's
  // kept separate to avoid string-allocation overhead on
  // ClientEvent. Free each EntityUpdate after we're done —
  // wasm-bindgen-allocated structs leak across the boundary
  // until JS releases them.
  // Perf (F-2026-06-29): per-frame drain budget. pollEntityUpdates
  // one-shot-drains the WHOLE wasm queue; processing a catastrophic
  // post-stall burst (1000s of updates) in a single frame is a
  // multi-hundred-ms stall that grows the next backlog -> death
  // spiral (reproduced live: one hitch dropped the headless client
  // to ~3 fps). Stage the drained batch into a cross-frame pending
  // buffer and process at most __budget per frame. Steady state
  // (100s/sec) is far below 256*fps, so the pending buffer empties
  // every frame in normal play (splice takes all) -> byte-identical,
  // zero added latency; the budget only amortizes bursts across a
  // few frames instead of one giant frame. The safety valve drains
  // the whole backlog if it ever exceeds the ceiling (bounds latency
  // + wasm memory under a pathological sustained flood). The
  // hook-forward + for-loop + upd.free() below are UNCHANGED — they
  // just iterate the budgeted slice; deferred items stay alive in
  // the buffer until a later frame frees them. DEFAULT-ON since
  // 2026-07-10 (P4/A03-F4): with `?netWorker=1` the worker ACKs
  // through any main-thread stall (no natural backpressure), so
  // the full post-stall burst always arrives and one-shot-draining
  // it is the documented death-spiral. The <=256 zero-copy fast
  // path below keeps steady state byte-identical (validated inert
  // in normal play — populated Holtburg 59 entities, pendMax 0);
  // the buffered path only engages in exactly the bursts it exists
  // for. `?entDrainBudget=off` (also 0/false) reverts.
  const __budgetOn = (window.__entDrainBudgetOn ??=
    !/[?&]entDrainBudget=(?:off|0|false)(?:&|$)/i.test(location.search || ""));
  const __fresh = handle.pollEntityUpdates();
  let entityUpdates;
  if (!__budgetOn) {
    entityUpdates = __fresh;
  } else {
    // Fast path (the overwhelming common case): nothing pending AND
    // the whole batch fits in one frame's budget -> use it directly,
    // zero copy, byte-identical to the unbudgeted drain. Only a real
    // burst (>256) or an existing backlog takes the buffered path.
    let __pend = window.__entDrainPending;
    if ((!__pend || __pend.length === 0) && __fresh.length <= 256) {
      entityUpdates = __fresh;
    } else {
      __pend = (window.__entDrainPending ||= []);
      for (const __u of __fresh) __pend.push(__u);
      let __budget = 256;
      if (__pend.length > 6000) __budget = __pend.length; // safety valve
      entityUpdates = __pend.splice(0, __budget);
    }
  }
  // Phase 7.5: forward the still-alive (pre-.free()) updates
  // array to the 3D EntityManager when `?renderer=3d` is
  // active. The hook (installed by
  // `scene3d/loop.js#installSharedDrainHook` after init3D
  // resolves) iterates read-only — it does NOT consume / .free()
  // the wasm-bindgen handles; the for-loop below still owns
  // the lifecycle and calls upd.free() unconditionally at its
  // loop tail (A15-Q4 comment-rot fix: was "line ~6062").
  // A15-Q1 (corrected 2026-06-11): the hook is ALWAYS defined
  // — the module-scope buffering stub (`bufferingHook`,
  // ~L4520) is installed unconditionally, before any renderer
  // is chosen. In 3D mode `installSharedDrainHook` later
  // replaces it with the live EntityManager dispatcher; in 2D
  // mode it is NEVER replaced, so this forward just buffers
  // into `__scene3dEntityBacklog` (now ring-capped at
  // ENTITY_BUFFER_CAP — see ~L4520) and nothing drains it.
  try { window.__scene3dEntityHook?.(entityUpdates); } catch (e) { console.warn("[7.5] scene3d hook:", e); }
  // latency (2026-10-05): the 3D hook above already applied the batch, so a
  // local-player KIND_MOTION seen here = the rig was updated (stance /
  // attack / cast hop of __diag.latency). Zero cost unless an action is
  // pending.
  const __lat = window.__latencyDiag;
  const __latTrack = !!(__lat && __lat._pending.length !== 0);
  for (const upd of entityUpdates) {
    if (__latTrack) { try { __lat.onEntityUpdate(upd.kind, upd.guid); } catch (_) {} }
    // A15-Q4 (`?unifiedDispatch=on`): route through the single
    // shared kind table (scene3d/entity_dispatch.js) — neutral
    // hooks (worldStreamer streaming, worldObjectManager feed)
    // run before the quarantined 2D sprite backend; kinds with
    // no 2D backend (6-9) surface as a one-time accounting
    // info instead of falling through silently. Flag-off: the
    // legacy if-chain below, now calling the SAME named pieces
    // (dispatch2dSpawn / neutralSpawn / neutralRemove — no
    // second copy). `upd.free()` stays unconditional at the
    // loop tail in BOTH states; the dispatcher never frees.
    if (__UNIFIED_DISPATCH) {
      __dispatch2d.dispatch(upd);
    }
    else if (upd.kind === 0) handlePositionUpdate(upd);
    else if (upd.kind === 1) {
      // A15-Q4: 2D sprite half (liveScene spawn / deferral
      // ring) then the renderer-neutral Chorizite
      // worldObjectManager feed — same inline order as the
      // pre-Q4 blob; bodies extracted to the named functions
      // defined after handleEntityMotion.
      dispatch2dSpawn(upd);
      neutralSpawn(upd);
    }
    else if (upd.kind === 2) {
      handleEntityRemove(upd);
      neutralRemove(upd);
    }
    // Phase 4 step 6f: kind=3 META_REFRESH carries a
    // delta into an existing entity's metadata (today:
    // portal_destination from the auto-fired
    // IdentifyObject round-trip). Doesn't touch
    // position / sprite / rotation; mutates entry.meta
    // and refreshes any meta-driven affordances (the
    // portal chip).
    else if (upd.kind === 3) handleEntityMetaRefresh(upd);
    // Velocity-extrapolation polish: kind=4 carries
    // ACE's authoritative `(velocity, omega)` from
    // VectorUpdate. handleEntityVelocity stamps
    // velX/velY/velUpdatedMs on the entry; subsequent
    // tickEntityInterpolation frames extrapolate the
    // sprite forward at this velocity past the catch-up
    // lerp's target until the next PUP echo lands.
    else if (upd.kind === 4) handleEntityVelocity(upd);
    // Animation-gate polish: kind=5 carries ACE's
    // authoritative `(forward_command, current_style)`
    // from UpdateMotion. handleEntityMotion stamps
    // motionCommand/motionUpdatedMs on the entry;
    // tickEntityAnimations short-circuits the EMA gate
    // when the stamp is fresh — no more flap from
    // PublicUpdatePosition jitter at low speeds.
    else if (upd.kind === 5) handleEntityMotion(upd);
    upd.free();
  }
  // The 2D deferred-Spawn replay (drain deferredSpawns →
  // handleEntitySpawn once liveScene is ready) was RETIRED
  // 2026-06-18 (item 7b). It was dead under ?renderer=3d
  // (liveScene permanently null); deferredSpawns itself is
  // removed in item 8.
  // Position-interpolation polish: ease non-local
  // entity sprites between authoritative position
  // updates. Must run BEFORE nameplate projection so
  // labels track the interpolated position rather than
  // snapping to the next echo target a frame ahead.
  // The 2D PIXI per-frame tickers (tickEntityInterpolation /
  // updateNameplatePositions / tickEntityAnimations /
  // tickCellVisibility) were RETIRED 2026-06-18 (item 7b) →
  // legacy/entity_2d.js. They were 3D no-ops (each early-returns
  // on !liveScene); the 3D path animates + culls in scene3d/.
  // Phase 4 step 3.6: drive the cli's MovementSystem on
  // every frame. The recv loop pulls the TickMovement cmd
  // and runs `MovementSystemHandle::tick`, which emits the
  // AutonomousPosition heartbeat that was missing pre-3.6
  // (the load-bearing fix for server-side player movement
  // — see docs/phase-4-step-3.6-movement-system.md).
  // Heartbeat scheduling internal to MovementSystem
  // throttles the actual outbound rate; rAF (~60 Hz) just
  // provides scheduling slots, well under the cli's 50 ms
  // (20 Hz) physics tick. Channel-closed errors are
  // discarded because rAF runs after the wasm bundle may
  // have already torn down on disconnect.
  // A1-O3 (?syncPhysicsTick): when the 3D driver owns the tick
  // (phase #0 enqueue at scene3d/index.js tick()), skip this
  // legacy enqueue so the integrator runs once per frame.
  // Recency watchdog: if the 3D driver stalls (hidden tab,
  // renderOnDemand idle without netDrainHz), fall back to this
  // path automatically — degraded mode IS the pre-O3 behavior.
  // Transient double-enqueue during handoff is benign: the
  // second tick integrates ~0 time (retail skips quanta
  // ≤0.2 ms, acclient.c:323120-323124; the spine measures dt
  // between calls) and heartbeat rate is internally throttled.
  const syncOwned = window.__syncTickOwned === true &&
    (performance.now() - (window.__syncTickLastEnqueueMs ?? -1e9)) < 250;
  if (!syncOwned) {
    try { handle.tickMovement(); } catch (_) {}
  } else if (window.__syncTickDiag) {
    window.__syncTickDiag.skipped2d += 1;
  }
  // Phase 4 step 3.5: client-side prediction. ACE doesn't
  // echo position back to the originator (retail AC's
  // protocol is asymmetric — see step 3 doc). Without
  // prediction the local player sprite stays still during
  // W-hold even though ACE has accepted the MoveToState
  // and is broadcasting UpdateMotion to other players.
  //
  // Mirrors the cli's `local_velocity_for_state` +
  // `local_omega_for_state` in
  // `crates/holtburger-core/src/client/movement/common.rs`
  // (lines 203-262). Forward velocity uses
  // `planar_velocity_for_heading(heading, speed) =
  // (-cos(h)*speed, sin(h)*speed)`; backstep uses
  // `heading + PI` and speed=1.0; strafe uses `heading ±
  // π/2` and speed=1.0; turn integrates heading at the
  // walk/run-held angular speed. Forward axis takes
  // priority over strafe (matches the wire format's
  // single-axis `Locomotion`).
  //
  // Reads/writes sprite.x/.y/.rotation directly. Authoritative
  // PrivateUpdatePosition / PublicUpdatePosition events
  // continue to call handlePositionUpdate which overwrites
  // these (rubber-band reconciliation on teleports + periodic
  // ACE corrections).
  if (D.enteredWorld && D.spawnedPlayerGuid !== null) {
    const now = performance.now();
    const localEntry = entityMap.get(D.spawnedPlayerGuid);
    if (localEntry?.sprite) {
      // Wave 3.F: track velocity across ticks so the
      // pure-prediction shadow can carry (vx, vy, vz) — the
      // C# OracleSim integrates v dt, and the validator
      // needs the same v this branch derived. `vz` stays 0
      // here because the JS rAF integrator doesn't yet do a
      // ballistic z-step (jump is server-authoritative); when
      // the server lands a jump-arc update we let the
      // PublicUpdatePosition path overwrite via the
      // local_player_pose shadow, and the prediction shadow
      // gets re-seeded on the next tick that has input.
      let predVx = 0.0, predVy = 0.0, predVz = 0.0;
      if (D.lastPredictionTime !== null) {
        // Cap dt to 100ms — clamps large jumps from rAF
        // throttling on hidden tabs / paused breakpoints
        // so we don't teleport across the world on resume.
        const dt = Math.min((now - D.lastPredictionTime) / 1000, 0.1);
        const forward = __axisValue("w", "s");
        const strafe = __axisValue("d", "a");
        const turn = __axisValue("e", "q");
        if (forward !== 0 || strafe !== 0 || turn !== 0) {
          window.__predTickCount = (window.__predTickCount || 0) + 1;
          if (!window.__predFirstPos) window.__predFirstPos = { x: localEntry.sprite.x, y: localEntry.sprite.y };
          window.__predLastPos = { x: localEntry.sprite.x, y: localEntry.sprite.y };
          // 2026-05-10 academy-rubberband fix: timestamp the
          // last tick we actually advanced the local sprite
          // via JS prediction. `applyEntityUpdate`'s local-
          // player branch reads this to gate idle-time
          // server-pose snaps — we only converge to server
          // after the player has been still for a beat.
          window.__predLastTickMs = now;
          // Run-by-default; Shift = walk modifier. See the
          // setMovementInput dispatch below for the full
          // rationale (matches retail AC, also a UX fix for
          // low-Run-skill new characters). A14-I3
          // (?retailRunKeys=on): Shift XOR ToggleRun option
          // instead; flag-off = legacy !shift.
          const run = __resolveRunModifier(keyState.shift, handle);
          const turnSpeed = run
            ? RUN_HELD_TURN_SPEED_RAD_PER_SEC
            : NON_RUN_HELD_TURN_SPEED_RAD_PER_SEC;
          // Sprite stores -heading + offset per the existing
          // quaternionToYaw → -sprite.rotation convention
          // (see SPRITE_HEADING_OFFSET above for the offset
          // rationale).
          let heading = -localEntry.sprite.rotation + SPRITE_HEADING_OFFSET;
          if (turn !== 0) {
            // Cli convention: right-turn omega.z = +1.5,
            // left-turn omega.z = -1.5. Right (E) → +1
            // → heading increases. Heading→sprite.rotation
            // negation handles the visual flip.
            heading += turn * turnSpeed * dt;
            localEntry.sprite.rotation = -heading + SPRITE_HEADING_OFFSET;
          }
          if (forward !== 0) {
            // Forward in heading direction; backstep flips
            // by PI and uses 1.0 m/s regardless of run.
            let effHeading = heading;
            // B3/D6/PRED-1: predict the local sprite at the SAME
            // skill-derived run rate the wasm body integrates at
            // (`playerRunRate()`), not a hardcoded speed. The two
            // predictors previously diverged (~1.8x), producing the
            // forward-bias sawtooth; feeding the wasm rate keeps the
            // rendered sprite and the authoritative wasm pose in step.
            // 2026-07-27: `playerRunRate()` is the DIMENSIONLESS
            // run-rate scalar, not m/s — and once Rust retired its
            // `FALLBACK_RUN_RATE_SCALAR` 4.5 → 1.0 the bare getter
            // became a ~1.0 "speed". Restore the units the wasm body
            // actually integrates: base run forward speed × scalar
            // (`SelfMovementCapabilities::resolved_manual_run_speed`).
            // NOTE: this is the 2D-sprite predictor; the 3D snapback
            // fix lives in camera.js _advancePrediction (the 3D rig's
            // X/Y comes from cameraSwitcher.predictedPlayerPos).
            let speed = run
              ? BASE_RUN_FORWARD_SPEED * playerRunRate()
              : WALK_FORWARD_SPEED;
            if (forward < 0) {
              effHeading = heading + Math.PI;
              speed = WALK_FORWARD_SPEED;
            }
            const dx = -Math.cos(effHeading) * speed * dt;
            const dy = Math.sin(effHeading) * speed * dt;
            localEntry.sprite.x += dx;
            localEntry.sprite.y += dy;
            // Wave 3.F: record planar velocity for the
            // pure-prediction shadow (m/s, derived from the
            // SAME speed/dt the integrator just consumed).
            predVx = -Math.cos(effHeading) * speed;
            predVy = Math.sin(effHeading) * speed;
          } else if (strafe !== 0) {
            // Strafe right (D, +1) = heading + π/2;
            // strafe left (A, -1) = heading - π/2.
            // Always 1.0 m/s.
            const effHeading = heading + strafe * (Math.PI / 2);
            const dx = -Math.cos(effHeading) * WALK_FORWARD_SPEED * dt;
            const dy = Math.sin(effHeading) * WALK_FORWARD_SPEED * dt;
            localEntry.sprite.x += dx;
            localEntry.sprite.y += dy;
            predVx = -Math.cos(effHeading) * WALK_FORWARD_SPEED;
            predVy = Math.sin(effHeading) * WALK_FORWARD_SPEED;
          }
        }
      }
      // ─── Wave 3.F (physics-replay parity, 2026-05-19) ───
      // Push the pure-prediction frame into the wasm shadow
      // BEFORE the recv-loop's PublicUpdatePosition arm at
      // index.html:4670-4720 can clobber `local_player_pose`
      // (and BEFORE the SetMovementInput dispatch below
      // sends the wire packet that triggers the server's
      // reconciliation broadcast).
      //
      // We always push, even on idle ticks — the C# oracle
      // integrates a "no-input → no-motion" step too, and
      // the validator wants a per-tick row to compare. Both
      // signals come from the SAME sprite the integrator
      // just wrote, so the shadow round-trips exactly what
      // the renderer saw, not what the server sent.
      //
      // Z is read from the latest local_player_pose shadow's
      // z (server-authoritative altitude — the JS integrator
      // doesn't simulate z). on_ground heuristic: server
      // hasn't told us we're airborne (or pre-spawn), so
      // default true. This is intentionally conservative —
      // the C# oracle's own on_ground predicate is the
      // load-bearing signal for the on-ground gate.
      if (typeof handle?.setLastClientPrediction === "function") {
        let zEst = 0.0;
        // Copy-then-free: wasm-bindgen LocalPlayerPose box. This
        // is the PER-FRAME reader (the R1#6 ~60 orphans/s shape),
        // so the free is load-bearing, not hygiene.
        let stashedPose = null;
        try {
          stashedPose = handle.getLocalPlayerPose?.();
          if (stashedPose && Number.isFinite(stashedPose.z)) {
            zEst = stashedPose.z;
          }
        } catch (_) {
        } finally {
          try { stashedPose?.free?.(); } catch (_) {}
        }
        try {
          handle.setLastClientPrediction(
            localEntry.sprite.x,
            localEntry.sprite.y,
            zEst,
            predVx,
            predVy,
            predVz,
            true, // on_ground default; jump arc is server-side today.
            (window.__predTickCount || 0) >>> 0,
            now,
          );
        } catch (_) {
          // Channel-closed on disconnect; safe to swallow.
        }
      }
      D.lastPredictionTime = now;
    }
  }

  // Phase 4 step 3: send a SetMovementInput packet on every
  // change to the keystate-derived axes. Sending on change
  // (rather than every frame) keeps the wire traffic to one
  // packet per keypress / release, matching the cli's
  // `PlayerDriveIntent::ManualHeld` semantics.
  if (D.enteredWorld) {
    const forward = __axisValue("w", "s");
    const strafe = __axisValue("d", "a");
    const turn = __axisValue("e", "q");
    // Run-by-default. Shift = walk modifier (retail AC convention,
    // and a quality-of-life fix because new characters have a
    // low `Run` skill that makes 1.0 m/s walk feel painful at the
    // top-down zoom level — `Run` scales `base_run_forward_speed`
    // through `resolved_manual_run_speed` so even with a fresh
    // `Run=0` skill, the run gait reads as the more responsive
    // animation). Hold Shift to ease into 1 m/s walk if you need
    // precision (e.g. lining up a click target). A14-I3
    // (?retailRunKeys=on): Shift XOR ToggleRun option instead;
    // flag-off = legacy !shift.
    const run = __resolveRunModifier(keyState.shift, handle);
    const sig = `${forward},${strafe},${turn},${run}`;
    window.__lastInputSig = sig;
    // ?cmdInterp=on (wave-1 rows 11-13): the legacy sig-diff
    // dispatcher is SILENCED for movement — raw edges already
    // went to wasm via handleKeyAction, and no movement
    // DECISION may live in JS on the interpreter lane. The
    // W3.1 local forward clip + anim-break cut +
    // setSidestepLayer side-effects inside this block go dark
    // with it (they become interpreter-event consumers at
    // step 5 — PENDING eye-test).
    if (!CMD_INTERP_ON && sig !== D.lastInputSig) {
      try {
        if (__inputFunnelOn) {
          // A14-I1: route through the shared InputController so this
          // dispatcher and the camera dispatcher dedupe against ONE
          // signature (no split-brain double-fire / stomp). The
          // controller applies the camera policy + the gate we
          // registered above; the local-prediction + sidestep/rig
          // side-effects below still fire off `sig` change.
          __getInputController().dispatch(handle, { forward, strafe, turn, run });
        } else {
          handle.setMovementInput(forward, strafe, turn, run);
        }
        window.__smiCallCount++;
        // eslint-disable-next-line no-console
        console.log(`[step 3] setMovementInput(${forward},${strafe},${turn},${run})`);
        D.lastInputSig = sig;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[step 3] setMovementInput rejected: ${String(err?.message ?? err)}`);
      }

      // W3.1 (2026-06-05): client-predict the local forward/run
      // locomotion cycle, mirroring the Jump (~line 8389) and the
      // sidestep block just below. Previously forward was server-
      // authoritative only (waited for ACE's UpdateMotion echo), so
      // the legs lagged one RTT behind the keypress while position was
      // already predicted — the "stuck in idle on move-start" symptom
      // under real latency. Retail is autonomous (acclient.c autonomy=2:
      // apply_interpreted_movement → DoInterpretedMotion plays the clip
      // immediately on input; MoveToState is validation-only; ACE
      // Player_Networking.cs:365 echoes the originator). The echo
      // (loop.js KIND_MOTION → em.setMotion) stays as idempotent
      // reconciliation — setMotion no-ops on an unchanged cacheKey, so
      // we fire the SAME full MotionCommand ACE broadcasts to avoid a
      // redundant re-fade.
      try {
        const em = window.liveScene3d?.entityManager;
        const localGuid =
          typeof window.getLocalPlayerGuid === "function"
            ? window.getLocalPlayerGuid()
            : null;
        if (em && localGuid != null && typeof em.setMotion === "function") {
          const NONCOMBAT_STANCE = 0x8000003D;
          const stance =
            (typeof em.getStance === "function"
              ? em.getStance(localGuid >>> 0) >>> 0
              : 0) || NONCOMBAT_STANCE;
          // Full retail MotionCommand values (Ace.Entity/Enum/
          // MotionCommand): RunForward 0x44000007, WalkForward
          // 0x45000005, WalkBackwards 0x45000006, Ready 0x41000003.
          // Backward is always a walk; `run = !shift` (run-by-default).
          let forwardCmd;
          if (forward > 0) forwardCmd = run ? 0x44000007 : 0x45000005;
          else if (forward < 0) forwardCmd = 0x45000006;
          else forwardCmd = 0x41000003; // stopped → Ready (idle base pose)
          em.setMotion(localGuid >>> 0, forwardCmd >>> 0, stance);
          // castMove anim-break (2026-07-03): a forward-axis
          // PRESS edge mid-cast evicts the gesture from the
          // single forward slot (retail :332890/:332759) — cut
          // the LOCAL cast-gesture chain so the windup visibly
          // breaks on the tap. Local-only (the classic
          // "invisible animation break": the server only
          // rate-checks and observers still watch the full
          // cast). Strafe/turn edges never cut — those slots
          // are independent (slidecast). Guarded by the F8-4
          // busy window so an idle tap can't recoil-stomp an
          // unrelated one-shot.
          if (
            CAST_MOVE_ON &&
            forward !== 0 &&
            forward !== D.lastForwardAxis &&
            typeof em.cancelCastSequence === "function"
          ) {
            const inst = em.entityMap?.get?.(localGuid >>> 0);
            if (
              inst?._castBusyUntilMs &&
              performance.now() < inst._castBusyUntilMs
            ) {
              em.cancelCastSequence(localGuid >>> 0, "anim-break");
            }
          }
          D.lastForwardAxis = forward;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[w3.1] local forward prediction failed:", e);
      }

      // Wave 2 Phase 2.2 (2026-05-26): drive the local rig's
      // sidestep-overlay layer from the JS input keystate.
      // Mirrors the Phase 1.5 Jump local-trigger pattern at
      // line ~7755: send the wire packet AND locally fire the
      // renderer so the rig animates immediately, without
      // waiting for the ACE UpdateMotion roundtrip.
      //
      // Why this is here (not in wasm's KIND_MOTION emit
      // path): `setMotion` plays ONE clip via `crossFadeTo`,
      // replacing the active action. Pre-2.2 the wasm only
      // emitted one motion command per UpdateMotion event,
      // so KIND_MOTION = one-shot dispatch was fine. With
      // diagonal composition the rig needs BOTH the forward
      // cycle (legs+arms walk-forward swing) AND the sidestep
      // cycle (sideways arm motion) blending concurrently;
      // `setSidestepLayer` calls into entities.js's
      // overlay-mixer pattern (see entities.js line ~2843 +
      // method JSDoc) to install a second AnimationAction at
      // weight 0.5 alongside the forward one.
      //
      // The forward base cycle now ALSO fires locally (W3.1
      // block above, 2026-06-05) so the legs animate immediately;
      // ACE's UpdateMotion broadcast (KIND_MOTION) reconciles it
      // idempotently. This sidestep overlay is client-predicted
      // here and blends on top of that forward base.
      try {
        const em = window.liveScene3d?.entityManager;
        const localGuid =
          typeof window.getLocalPlayerGuid === "function"
            ? window.getLocalPlayerGuid()
            : null;
        if (em && localGuid != null && typeof em.setSidestepLayer === "function") {
          const NONCOMBAT_STANCE = 0x8000003D;
          const stance =
            (typeof em.getStance === "function"
              ? em.getStance(localGuid >>> 0) >>> 0
              : 0) || NONCOMBAT_STANCE;
          // Wave 2 Phase 2.5 (2026-05-26): always pass
          // `SideStepRight (0x6500000F)` regardless of A vs D.
          // Retail collapses Left into Right with negated speed
          // (`~/ac-headers/acclient.c:332766-332770`,
          // `external/ACE/Source/ACE.Server/Physics/Animation/
          // MotionInterp.cs:414-417`), and player MT 0x09000001
          // has no `cycles[(stance, SideStepLeft)]` entry — the
          // renderer's cache lookup for `0x65000010` returns
          // null and the rig silently no-ops. The wasm wire-emit
          // (`crates/holtburger-core/src/client/movement/common.rs::
          // sidestep_command_for_state`) now matches: always
          // Right code, sign of `sidestep_speed` communicates
          // direction.
          //
          // Direction is still visible to the player at the
          // position level: the local-prediction velocity
          // integrator (`local_velocity_for_state` in the same
          // file) reads `state.sidestep` (StrafeLeft vs
          // StrafeRight) directly and composes the velocity
          // vector with the appropriate sign. The rig visually
          // plays the Right strafe clip in both directions
          // (retail-accurate asymmetry; same clip is what the
          // retail client played on a SideStepLeft input).
          const sidestepCmd =
            strafe !== 0 ? 0x6500000F /* SideStepRight */ : 0;
          // W4.5 / DIM1-3 (2026-06-05): thread the real wire
          // `sidestep_speed` scalar into the overlay so the rig
          // can velScale the strafe cycle, instead of the renderer
          // hardcoding `_sidestepSpeed = 1.0`. The wasm wire-emit
          // (`crates/holtburger-core/src/client/movement/common.rs:288`
          // `raw_motion_state.sidestep_speed = Some(sign)`) sends the
          // SIGNED unit magnitude — `±1.0`, where the sign carries
          // Left-vs-Right (Phase 2.5 collapses Left into Right with a
          // negated speed). `strafe` here (`d:+1 / a:-1`) is exactly
          // that `sign`; the renderer stores `|speed|` so direction
          // stays in the position integrator, matching retail
          // `MotionInterp.cs:414` / `~/ac-headers/acclient.c:332766`.
          // Harmless until velScale (W0.1/W4.6) is live; logically
          // depends on W0.1 (DONE).
          em.setSidestepLayer(localGuid >>> 0, sidestepCmd, stance, strafe);
        }
      } catch (e) {
        console.warn("[wave2.2] local setSidestepLayer failed:", e);
      }
    }
  }
}
