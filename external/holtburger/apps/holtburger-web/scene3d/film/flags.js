// scene3d/film/flags.js — URL opt-ins for AC Film Mode (SPEC §1.1, §5.1).
//
// WHY: film mode takes over the camera, holds the render loop and strips the
// HUD, so it must never switch on by accident. Every flag is an EXACT-MATCH
// opt-ins (`=== "on"`, on the same line as `.get(...)`, the repo's flag-reader
// rule): `?filmMode`, `?filmMode=1`, `?filmMode=true`, `?filmMode=ON` and
// `?filmMode=off` all read OFF. The page query never changes during a session,
// so each answer is read once and memoised; an explicit `search` argument
// (tests, tools) is always re-read and never touches the memo.
//
//   ?filmMode=on  — load scene3d/film/ (installFilmMode → window.__film). DEFAULT OFF.
//   ?filmDof=on   — atmosphere_pipeline builds the DepthOfFieldEffect and
//                   window.__dof (owner decision 2026-10-13: DoF ships in v1;
//                   the film CLI boot URL always adds it). DEFAULT OFF.
//   ?filmProps=on — the FPV props lens overlay (runtime/lens_overlay.js) may
//                   draw: only for takes whose shot asks for it
//                   (`take.overlay.props`), after the composer and right before
//                   the recorder grabs the frame. DEFAULT OFF (2026-10-15).
//
// Page module with no imports; `window` is only read behind a typeof guard and
// every read is try-wrapped (a throwing location getter reads OFF).

let _filmModeMemo = null;
let _filmDofMemo = null;
let _filmPropsMemo = null;

/**
 * The query string to read: the explicit `search`, else the page's
 * `window.location.search`, else "".
 * @param {string|URLSearchParams|undefined} search
 * @returns {string|URLSearchParams}
 */
function querySource(search) {
  if (search !== undefined && search !== null) return search;
  return (typeof window !== "undefined" ? window.location?.search : "") ?? "";
}

/**
 * `?filmMode=on` — exact opt-in (DEFAULT OFF). Read once per page and
 * memoised; an explicit `search` (tests) is always re-read.
 * @param {string|URLSearchParams} [search] a query string such as "?filmMode=on"
 * @returns {boolean}
 */
export function filmModeEnabled(search) {
  const read = (s) => {
    try {
      return new URLSearchParams(querySource(s)).get("filmMode") === "on";
    } catch (_) {
      return false;
    }
  };
  if (search !== undefined) return read(search);
  if (_filmModeMemo === null) _filmModeMemo = read(undefined);
  return _filmModeMemo;
}

/**
 * `?filmDof=on` — exact opt-in (DEFAULT OFF) for the depth-of-field effect and
 * `window.__dof`. Read once per page and memoised; an explicit `search` is
 * always re-read.
 * @param {string|URLSearchParams} [search]
 * @returns {boolean}
 */
export function filmDofEnabled(search) {
  const read = (s) => {
    try {
      return new URLSearchParams(querySource(s)).get("filmDof") === "on";
    } catch (_) {
      return false;
    }
  };
  if (search !== undefined) return read(search);
  if (_filmDofMemo === null) _filmDofMemo = read(undefined);
  return _filmDofMemo;
}

/**
 * `?filmProps=on` — exact opt-in (DEFAULT OFF) for the FPV props lens overlay
 * (runtime/lens_overlay.js). It only draws for a take whose shot carries
 * `overlay.props`; without this flag such a take records clean (the take report
 * says `overlay: {on:false, reason}`). Read once per page and memoised; an
 * explicit `search` is always re-read.
 * @param {string|URLSearchParams} [search]
 * @returns {boolean}
 */
export function filmPropsEnabled(search) {
  const read = (s) => {
    try {
      return new URLSearchParams(querySource(s)).get("filmProps") === "on";
    } catch (_) {
      return false;
    }
  };
  if (search !== undefined) return read(search);
  if (_filmPropsMemo === null) _filmPropsMemo = read(undefined);
  return _filmPropsMemo;
}

/**
 * Tests: pin the page answer of `filmModeEnabled()` (true/false) or drop the
 * memo so the next call re-reads the page (null/undefined).
 * @param {boolean|null} [on]
 */
export function _setFilmModeEnabledForTest(on) {
  _filmModeMemo = on == null ? null : !!on;
}

/**
 * Tests: pin the page answer of `filmDofEnabled()` (true/false) or drop the
 * memo (null/undefined).
 * @param {boolean|null} [on]
 */
export function _setFilmDofEnabledForTest(on) {
  _filmDofMemo = on == null ? null : !!on;
}

/**
 * Tests: pin the page answer of `filmPropsEnabled()` (true/false) or drop the
 * memo (null/undefined).
 * @param {boolean|null} [on]
 */
export function _setFilmPropsEnabledForTest(on) {
  _filmPropsMemo = on == null ? null : !!on;
}
