// scene3d/flight_view_flag.js — the `?flightView` flag grammar in ONE place.
//
// altitude_policy.js (the policy), world_terrain.js (the world tier), far_forest.js (the far forests) and
// lb_presence.js (the presence field) all read it; this is a leaf module so none of them has to import another
// (altitude_policy imports world_terrain and far_forest).
//
// DEFAULT ON since 2026-11-01 (flight experience Phase 5: validated on the 1070, arms D-H —
// docs/flight-experience-2026-11-01/HANDOFF.md). `?flightView=off` (or 0 / false / no) restores the pre-flight-view
// client: no world tier, no far forests, no presence field unless asked for one by one, today's fog / far plane.
// On foot the policy is inert either way (its weight is 0 unless an aircraft flies or the player is high above
// the ground).

/** True unless `?flightView` is off / 0 / false / no. */
export function flightViewFlag(search) {
  let s = "";
  try {
    s = search !== undefined ? search : (globalThis.location?.search || "");
  } catch (_) {
    s = "";
  }
  let v = "";
  try {
    v = (new URLSearchParams(s).get("flightView") || "").trim().toLowerCase();
  } catch (_) {
    v = "";
  }
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}
