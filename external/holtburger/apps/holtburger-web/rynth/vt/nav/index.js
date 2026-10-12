// rynth/vt/nav/index.js — barrel for the VTank navigation package (W1-6 NAV).
// Consumers (INT-2 composition) import from here; nothing here has side effects.

export {
  ROUTE,
  ROUTE_NAMES,
  POINT,
  POINT_NAMES,
  JUMP_DIRECTIONS,
  makeRoute,
  cloneRoute,
  normalizePoint,
  normalizeRouteType,
  normalizeFollowTarget,
  isSentinel,
  pointWorld,
  nearestPointIndex,
  startIndex,
  advance,
  skipDense,
  isEmpty,
  insert,
  removeAt,
  setActive,
  step,
  reverse,
  minDistM,
} from "./route_model.js";
export { parseNavVt, retypeAfPoint, parseAfNavsVt, writeNavVt, validateNavName, NavProfiles } from "./nav_profiles.js";
export { ActiveNav, FOLLOW_START_M, FOLLOW_STOP_M } from "./active_nav.js";
export { makeExecutor, NAV_TUNING, legTimeoutMs, pointLeg, jumpArgs } from "./executors.js";
