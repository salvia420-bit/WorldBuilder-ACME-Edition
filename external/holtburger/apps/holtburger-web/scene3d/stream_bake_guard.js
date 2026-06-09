// stream_bake_guard.js (2026-06-09)
//
// Per-landblock streaming-bake resilience guard. The `index.html`
// position-update handler fires `loadTerrain/Buildings/StaticsForLandblock`
// for the 3×3 ring around the player on EVERY local-player position update,
// trusting each baker's "idempotent via its *BakedLbs Set" claim. But those
// Sets only record SUCCESSFUL bakes — a bake that THROWS on a shard-fetch
// failure (a flaky cloudflared tunnel, or a ServiceWorker that intercepts
// the request and returns a body-read error) is never recorded. Without a
// guard, every subsequent position update re-launches an OVERLAPPING fetch
// for the same failing LB: unbounded in-flight promises + fetch buffers
// (→ the browser OOMs and crashes) plus a flood of SW-intercept console
// errors. This is the "terrain service worker / promises spam until the
// browser crashes" failure.
//
// `guardedStreamBake` wraps a baker call so that, per (kind, lbKey):
//   - at most ONE bake runs at a time (in-flight dedup), and
//   - after a failure the LB is on a cooldown, so a persistently-dead
//     shard retries at most once per cooldown instead of once per update.
// It resolves to `null` when the call is skipped (in-flight or cooling
// down) and on failure (after recording the cooldown). It NEVER rejects,
// so the fire-and-forget `index.html` callers can't leak unhandled
// rejections either.

export const STREAM_BAKE_RETRY_COOLDOWN_MS = 2500;

/** Create the mutable state bag a caller threads through `guardedStreamBake`. */
export function createStreamGuardState() {
  return {
    inFlight: new Set(),
    failUntil: new Map(),
    warnedAt: new Map(),
  };
}

/**
 * @param {ReturnType<typeof createStreamGuardState>} state mutable guard state (caller-owned)
 * @param {string} kind baker label ("terrain" | "buildings" | "statics")
 * @param {number} lbKey landblock key
 * @param {() => Promise<any>} run the baker thunk (returns the bake promise)
 * @param {{cooldownMs?: number, now?: () => number, warn?: (msg: string, err: any) => void}} [opts]
 * @returns {Promise<any>} the bake result, or null when skipped/failed. Never rejects.
 */
export function guardedStreamBake(state, kind, lbKey, run, opts = {}) {
  const cooldownMs = opts.cooldownMs ?? STREAM_BAKE_RETRY_COOLDOWN_MS;
  const now = opts.now ?? (() => performance.now());
  const warn =
    opts.warn ??
    ((msg, err) => {
      // eslint-disable-next-line no-console
      console.warn(msg, err);
    });

  const k = lbKey >>> 0;
  const guardKey = `${kind}:${k}`;

  // In-flight dedup: a bake for this LB is already running — skip.
  if (state.inFlight.has(guardKey)) return Promise.resolve(null);

  // Cooldown: this LB failed recently — skip until the window elapses.
  const until = state.failUntil.get(guardKey);
  if (until != null) {
    if (now() < until) return Promise.resolve(null);
    state.failUntil.delete(guardKey);
  }

  state.inFlight.add(guardKey);
  return Promise.resolve()
    .then(run)
    .then((r) => {
      // Success clears any prior failure backoff for this LB.
      state.failUntil.delete(guardKey);
      return r;
    })
    .catch((err) => {
      state.failUntil.set(guardKey, now() + cooldownMs);
      // The baker already logged the root cause; throttle a single warn
      // per cooldown so the retry can't flood the console.
      const lastWarn = state.warnedAt.get(guardKey) ?? -Infinity;
      if (now() - lastWarn > cooldownMs) {
        state.warnedAt.set(guardKey, now());
        warn(
          `[stream] ${kind} bake for LB 0x${k.toString(16)} failed; backing off ${cooldownMs}ms`,
          err?.message ?? err
        );
      }
      return null;
    })
    .finally(() => {
      state.inFlight.delete(guardKey);
    });
}
