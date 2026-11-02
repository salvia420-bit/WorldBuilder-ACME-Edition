// scene3d/vehicle/fall_model.js — bail-out freefall + parachute (vehicles DESIGN §4.8), the client twin of
// ACE Vehicles/VehicleBailout.cs StepFall (same constants, same operation order). The server owns the falling body;
// the capable client runs this model from the Bail event and re-anchors on the Chute event (position + vertical
// speed); Touchdown ends it with the server's placement.

import { moveToward } from "./flight_model.js";

export const FALL = Object.freeze({
  GRAVITY: 9.8, TERMINAL: 50.0, HORIZONTAL_TAU: 4.0, CHUTE_AGL: 150.0, CHUTE_SINK: 5.0, CHUTE_GLIDE: 8.0, CHUTE_DECEL: 15.0,
});
const WORLD_MIN = 0.5, WORLD_MAX = 255.0 * 192.0 - 0.5; // landblock 0xFF does not exist (= ACE FlightModel.WorldMax)
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** One step IN PLACE: f = {x, y, z, vx, vy, vz, heading, chute}. */
export function stepFall(f, dt) {
  if (!f.chute) {
    f.vz -= FALL.GRAVITY * dt;
    if (f.vz < -FALL.TERMINAL) f.vz = -FALL.TERMINAL;
    const k = Math.exp(-dt / FALL.HORIZONTAL_TAU);
    f.vx *= k;
    f.vy *= k;
  } else {
    f.vz = moveToward(f.vz, -FALL.CHUTE_SINK, FALL.CHUTE_DECEL * dt);
    f.vx = moveToward(f.vx, Math.sin(f.heading) * FALL.CHUTE_GLIDE, FALL.CHUTE_DECEL * 0.5 * dt);
    f.vy = moveToward(f.vy, Math.cos(f.heading) * FALL.CHUTE_GLIDE, FALL.CHUTE_DECEL * 0.5 * dt);
  }
  f.x = clamp(f.x + f.vx * dt, WORLD_MIN, WORLD_MAX);
  f.y = clamp(f.y + f.vy * dt, WORLD_MIN, WORLD_MAX);
  f.z += f.vz * dt;
  return f;
}
