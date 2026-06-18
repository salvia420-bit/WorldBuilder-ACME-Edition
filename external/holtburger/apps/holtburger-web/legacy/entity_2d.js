// ─────────────────────────────────────────────────────────────────────────
// QUARANTINED 2D PIXI entity code — retired 2026-06-18 (item 7b). Reference
// only per RULINGS item 2; NOT wired (references the 2D liveScene/PIXI sprite
// state). The 3D entity path is scene3d/entities.js (EntityManager).
// ─────────────────────────────────────────────────────────────────────────

// ===== handlePositionUpdate's 2D-sprite tail (sprite manipulation, lerp seed,
// velocity sampler, portal-swirl reposition). The shared streaming body ABOVE
// this in handlePositionUpdate stayed in index.html. =====
function handlePositionUpdate_2dTail(upd, guid, isLocal) {
        // 2D-only branch below (sprite manipulation, lerp setup,
        // velocity sampler) — these require a sprite entry that only
        // `liveScene` (and thus only 2D mode) can provide. Return
        // early in 3D mode where ensureEntitySprite returns null.
        const entry = ensureEntitySprite(guid, 0, null);
        if (!entry) return;
        if (entry.guid === undefined) entry.guid = guid;
        const { wx, wy } = landblockToWorldXY(upd.landblockId, upd.x, upd.y);
        // Tier 2: sample velocity from the position delta. Speed in
        // m/s — used by tickEntityAnimations to gate walk-cycle
        // playback (only animate while moving above threshold).
        const now = performance.now();
        if (entry.lastPosT !== undefined) {
          const dt = (now - entry.lastPosT) / 1000;
          if (dt > 0 && dt < 1.0) {  // ignore stale / first-update
            const dx = wx - entry.lastPosX;
            const dy = wy - entry.lastPosY;
            // Exponential moving average so a single
            // PublicUpdatePosition jitter doesn't immediately
            // flip the moving-state.
            const inst = Math.hypot(dx, dy) / dt;
            entry.speedMps = (entry.speedMps ?? 0) * 0.5 + inst * 0.5;
          }
        }
        entry.lastPosX = wx;
        entry.lastPosY = wy;
        entry.lastPosT = now;
        // Position interpolation polish: for non-local entities,
        // lerp from the sprite's current visual position to the
        // new authoritative target over ENTITY_LERP_DURATION_MS.
        // ACE pushes PublicUpdatePosition at ~100-300 ms cadence;
        // snap-rendering looked stuttery in crowded zones. The
        // local player skips this branch — its step 3.5 keystate-
        // driven prediction is what makes WASD feel responsive,
        // and lerping the local sprite would add input lag on top
        // of every PrivateUpdatePosition reconciliation.
        const isLocal =
          localPlayerGuid !== null && guid === (localPlayerGuid >>> 0);
        if (isLocal) {
          // 2026-05-10 academy-rubberband fix: do NOT sync the local
          // sprite to ACE's UpdatePosition broadcast at all. The
          // wasm-side integrator + JS-side step-3.5 prediction
          // together own the sprite's position; the heartbeat carries
          // our predicted pose to the server, and ACE's force-position
          // mechanism (via `force_position_sequence` advances) handles
          // genuine server overrides through the wasm UpdatePosition
          // handler's reconciliation gate, not through this JS branch.
          //
          // Why the snap was wrong: many AC server states leave the
          // server-side player position lagging client prediction —
          // e.g. fresh characters whose Run skill is 0 mean the
          // server-side run speed is effectively walking pace while
          // the JS-side `FALLBACK_RUN_RATE_SCALAR=4.5 m/s` predicts
          // a fast jog. ACE happily accepts our heartbeats (no
          // force_position_sequence advance), but its authoritative
          // pose stays at-or-near spawn. Re-syncing the sprite to
          // that authoritative pose on every UpdatePosition was the
          // user-visible "snaps back to starting spot when I move"
          // symptom. Mirrors how the upstream cli's TUI map renders
          // off `world.local_player_runtime_pose()` (the integrator-
          // owned body.pose) — not off the raw server broadcast.
          //
          // 2026-05-13 teleport-snap follow-on: the no-snap policy is
          // correct for same-LB heartbeats, but a server-issued
          // PlayerTeleport (or @teleloc) crosses to a new landblock
          // and the JS-side step-3.5 prediction has no concept of the
          // teleport — it keeps integrating WASD on top of the OLD
          // sprite position. Detect the LB crossing here (high 16
          // bits of upd.landblockId) and snap sprite to the new
          // (wx, wy), then reset the step-3.5 prediction
          // bookkeeping so it restarts from the new pose. First
          // PrivateUpdatePosition after spawn also snaps because
          // entry.lastLocalLbId is undefined. Same-LB heartbeats
          // leave the rubberband fix above intact.
          const lbHigh = ((upd.landblockId >>> 16) << 16) >>> 0;
          if (entry.lastLocalLbId !== lbHigh) {
            entry.sprite.x = wx;
            entry.sprite.y = wy;
            window.__predLastPos = { x: wx, y: wy };
            window.__predFirstPos = undefined;
            window.__predLastTickMs = undefined;
            entry.lastLocalLbId = lbHigh;
          }
          entry.lerpStartMs = undefined;
          entry.lerpDurationMs = undefined;
        } else {
          entry.lerpFromX = entry.sprite.x;
          entry.lerpFromY = entry.sprite.y;
          entry.lerpToX = wx;
          entry.lerpToY = wy;
          entry.lerpStartMs = now;
        }
        // Rotation handling: trust JS prediction's rotation while the
        // user is actively turning, or if they recently moved/turned
        // (server lags client prediction). Otherwise sync rotation
        // from the server pose. Without this gate the unconditional
        // `entry.sprite.rotation =` snap fights the JS-side step-3.5
        // prediction's heading integration on every server broadcast,
        // and the user sees the sprite jerk to an older heading
        // mid-turn.
        let turningNow = false;
        if (isLocal) {
          const sigParts = (window.__lastInputSig ?? "0,0,0,false").split(",");
          const turnAxis = sigParts[2] || "0";
          turningNow = turnAxis !== "0";
        }
        const recentLocalActivity =
          isLocal
          && window.__predLastTickMs !== undefined
          && (now - window.__predLastTickMs) < 1500;
        if (!turningNow && !recentLocalActivity) {
            entry.sprite.rotation = -quaternionToYaw(upd.qw, upd.qx, upd.qy, upd.qz) + SPRITE_HEADING_OFFSET;
        }
        // Portal swirl tracks the sprite — `tickEntityInterpolation`
        // syncs it along with the lerp so we don't snap the swirl
        // to the target position while the sprite is mid-lerp.
        // For local-player snap and post-lerp finalization, the
        // swirl is repositioned in those branches.
        if (isLocal && entry.portalSwirl) {
          entry.portalSwirl.position.set(wx, wy);
        }
}
