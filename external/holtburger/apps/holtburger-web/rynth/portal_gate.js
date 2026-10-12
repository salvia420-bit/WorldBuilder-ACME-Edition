// portal_gate.js — "is the client in portal space right now?" for the rynth
// movers (2026-10-12).
//
// Since 1aedd85c (2026-10-05) a teleport runs retail's portal-space tunnel
// (scene3d/portal_space.js — the gmSmartBoxUI TeleportAnimState machine): from
// the PlayerTeleport through the world fade-in. The destination may not be
// built yet while it runs: 0d06b92e's `?portalHoldBuild` (default on) keeps the
// tunnel up while the destination interior is still building, up to 60 s after
// arrival, on top of the 20 s pre-arrival cap (TUNNEL_HOLD_MAX). The movement
// step keeps ticking underneath, so a MoveToPosition issued in the tunnel walks
// the body through cells whose collision has not landed — the void the hold
// exists to hide. Retail never moves the player in portal space either. So the
// router (and every mover that starts a walk) holds until it ends.
//
// Source of truth: `host.IsPortalSpaceActive()` when the host exposes it, else
// the page global scene3d/portal_space.js publishes
// (`globalThis.__isPortalSpaceActive`, the same read ui/portal_busy.js makes).
// Any absence or throw reads as NOT in portal space, so a page without the 3D
// presentation (nullRender, `?portalSpace=off`, node tests) never holds. The
// login tunnel is already skipped for `?bot=1` pages (portal_space.js
// loginPortalSpaceSkipReason); teleports still run it.
//
// No imports — router.js, unwedge.js, goto_compose.js, global_router.js and
// bot.js all read it.

/** Upper bound on one portal-space hold: 20 s tunnel + 60 s build hold + slack.
 *  The presentation has its own failsafes; this one only stops a stuck flag
 *  (a lost packet, a page that never clears it) from parking the bot forever. */
export const PORTAL_SPACE_MAX_HOLD_MS = 90_000;

/** True while the client shows portal space (tunnel through world fade-in). */
export function portalSpaceActive(host) {
  try {
    if (host && typeof host.IsPortalSpaceActive === "function") return host.IsPortalSpaceActive() === true;
  } catch (_) {
    /* fall through to the page global */
  }
  try {
    const f = typeof globalThis !== "undefined" ? globalThis.__isPortalSpaceActive : undefined;
    return typeof f === "function" && f() === true;
  } catch (_) {
    return false;
  }
}

/** Walk-poll liveness during a router portal-space hold (router.js status):
 *  the router reports `portalHold` and a `ticks` counter that advances on
 *  every tick. A hold the router is still ticking through is progress, not a
 *  stall; a frozen counter (the host stopped ticking) is not. A router without
 *  the fields (stale build, test double) -> false, i.e. the old sig-only rule.
 *  Used by goto_compose.js walkLegs and global_router.js's walk poll. */
export function holdIsAlive(st, lastTicks) {
  return !!st && st.portalHold === true && Number.isFinite(st.ticks) && lastTicks != null && st.ticks !== lastTicks;
}

export default { portalSpaceActive, holdIsAlive, PORTAL_SPACE_MAX_HOLD_MS };
