// scene3d/sky_game_date.js — daytime-1 (R2 2026-10-08): the synthetic Date that
// drives the takram moon direction + star rotation (atmosphere_sky.js), taken
// from the SAME clock the wasm sky evaluator uses for the AC sun.
//
// The wasm `SessionHandle.getSkyPortalTicks()` returns the sky clock in
// PortalYearTicks seconds: the server's clock once a ConnectRequest/TimeSync
// sample has been adopted (retail GameTime::UseTime reads Timer::cur_time,
// which ClientNet::HandleTimeSynch sets — acclient.c:463395, :371516 → :75365),
// or the legacy 1999-anchored wall clock's equivalent before that / under
// `?skyServerClock=off`. NaN (or a missing export on a stale pkg) means the sky
// is not populated yet: the legacy formula below is used unchanged.
//
// The mapping keeps the relation the old code had between the AC sun and the
// moon/stars: date = launch + ticks × 86400/7620. With the legacy ticks
// (now − launch) that IS the old formula, so pre-sync and `=off` are unchanged.
// Pure (no DOM / three imports) so node tests can import it.

/** AC launch, 1999-11-02 00:00:00 UTC (holtburger-world sky.rs AC_LAUNCH_UNIX_EPOCH). */
export const AC_LAUNCH_UNIX_EPOCH_S = 941_500_800;
export const AC_LAUNCH_UNIX_EPOCH_MS = AC_LAUNCH_UNIX_EPOCH_S * 1000;
/** Retail Dereth GameTime.day_length (real seconds per game day). */
export const AC_DAY_LENGTH_S = 7620;
/** Game seconds per real second (~11.34). */
export const AC_TIME_COMPRESSION = 86400 / AC_DAY_LENGTH_S;

/** Sky-clock ticks (PortalYearTicks domain, seconds) → synthetic Date ms. */
export function skyGameDateMs(ticks) {
  return AC_LAUNCH_UNIX_EPOCH_MS + ticks * 1000 * AC_TIME_COMPRESSION;
}

/** The pre-daytime-1 formula, verbatim: wall clock since AC launch, compressed. */
export function legacyGameDateMs(nowMs) {
  const realElapsedMs = nowMs - AC_LAUNCH_UNIX_EPOCH_MS;
  return AC_LAUNCH_UNIX_EPOCH_MS + realElapsedMs * AC_TIME_COMPRESSION;
}

/** `handle.getSkyPortalTicks()` when the export exists and is finite, else NaN. */
export function readSkyPortalTicks(handle) {
  try {
    if (handle && typeof handle.getSkyPortalTicks === "function") {
      const t = Number(handle.getSkyPortalTicks());
      return Number.isFinite(t) ? t : NaN;
    }
  } catch (_) {
    /* a throwing/stale handle reads as "no sky clock" */
  }
  return NaN;
}

/** The moon/star Date ms right now: the sky clock when available, else legacy. */
export function gameDateMsNow(handle, nowMs) {
  const ticks = readSkyPortalTicks(handle);
  return Number.isFinite(ticks) ? skyGameDateMs(ticks) : legacyGameDateMs(nowMs);
}
