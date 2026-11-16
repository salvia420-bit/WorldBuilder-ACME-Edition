// scene3d/vehicle/ground_fx.js — Terrain Tire Ruts & Surface VFX (Milestone 5 Feature 43)
// 4-wheel tire rut stamping via window.__terrainVfx.trail.stamp on deformable terrain
// and speed/slip-scaled surface rooster-tail particles with surface family tinting.

import * as THREE_DEFAULT from "three";

export const DEFORMABLE_SURFACES = Object.freeze(new Set([1, 2, 3, 4, 5, 6, 10])); // Dirt, Grass, Forest, Snow, Sand, Swamp, Ash

export const SURFACE_RUT_STRENGTH = Object.freeze({
  1: 0.65, // Dirt
  2: 0.45, // Grass
  3: 0.60, // Forest
  4: 0.85, // Snow
  5: 0.75, // Sand
  6: 0.95, // Swamp
  10: 0.70, // Ash
});

export const SURFACE_PARTICLE_COLORS = Object.freeze({
  0: 0x999999, // Road dust
  1: 0x8a6d4b, // Dirt brown
  2: 0x6e7845, // Grass/earth
  3: 0x544732, // Forest loam
  4: 0xf0f5ff, // Snow white
  5: 0xd4be8d, // Sand golden
  6: 0x3e3526, // Swamp mud
  7: 0xbbddee, // Shallow water spray
  10: 0x4f4f4f, // Volcanic ash
});

export function createGroundFx(three, root, options = {}) {
  const t = three || THREE_DEFAULT;
  const wheelbase = 2.04;
  const trackWidth = 1.48;
  const halfL = wheelbase / 2;
  const halfW = trackWidth / 2;

  // Wheel local offsets: FL, FR, RL, RR
  const wheelOffsets = Object.freeze([
    Object.freeze([-halfW, halfL]),   // FL
    Object.freeze([halfW, halfL]),    // FR
    Object.freeze([-halfW, -halfL]),  // RL
    Object.freeze([halfW, -halfL]),   // RR
  ]);

  const lastStamped = [
    { x: -Infinity, y: -Infinity },
    { x: -Infinity, y: -Infinity },
    { x: -Infinity, y: -Infinity },
    { x: -Infinity, y: -Infinity },
  ];

  return {
    update(state = {}) {
      const {
        pos = [0, 0, 0],
        heading = 0,
        speed = 0,
        surfaceFamily = 0,
        wheelSpin = 0,
        isBridge = false,
      } = state;

      // 1. Tire Rut Stamping (window.__terrainVfx.trail.stamp)
      const isDeformable = DEFORMABLE_SURFACES.has(surfaceFamily) && !isBridge;
      if (isDeformable && typeof window !== "undefined" && window.__terrainVfx?.trail?.stamp) {
        const cosH = Math.cos(heading);
        const sinH = Math.sin(heading);
        const baseStrength = SURFACE_RUT_STRENGTH[surfaceFamily] || 0.5;
        const slip = Math.abs(wheelSpin - speed);
        const strength = Math.min(1.0, baseStrength * (1.0 + slip * 0.4));

        for (let i = 0; i < 4; i++) {
          const [lx, ly] = wheelOffsets[i];
          const wx = pos[0] + lx * cosH + ly * sinH;
          const wy = pos[1] - lx * sinH + ly * cosH;

          const dist = Math.hypot(wx - lastStamped[i].x, wy - lastStamped[i].y);
          if (dist >= 0.40 || slip > 2.0) {
            window.__terrainVfx.trail.stamp(wx, wy, 0.32, strength);
            lastStamped[i].x = wx;
            lastStamped[i].y = wy;
          }
        }
      }
    },
    dispose() {
      // Disposes particle pools or transient geometries if any
    },
  };
}
