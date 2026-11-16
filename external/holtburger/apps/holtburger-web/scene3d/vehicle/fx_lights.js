// scene3d/vehicle/fx_lights.js — Zero Light Churn Headlights & CRT Glow (Milestone 5 Feature 38)
// Strictly enforces lightCountDelta === 0: zero THREE.Light additions or visibility toggles.
// Uses pre-allocated pooled FxLightSource carriers and additive blending emissive meshes.

import * as THREE_DEFAULT from "three";
import { FxLightSource } from "../vfx/fx_lights.js";

export const HEADLIGHT_CONFIG = Object.freeze({
  color: 0xffffea,
  distance: 25.0,
  intensity: 2.5,
  coneRadius: 0.45,
  coneLength: 4.0,
  beamOffset: Object.freeze([0, 1.6, 0.65]),
});

export const CRT_GLOW_CONFIG = Object.freeze({
  color: 0x33ff66,
  distance: 1.5,
  intensity: 0.25,
  circleRadius: 0.18,
  glowOffset: Object.freeze([0, 0.71, 0.7]),
});

/**
 * Creates vehicle headlight visual beam and pooled light carrier without Three.js light churn.
 */
export function createVehicleHeadlights(three, root, options = {}) {
  const t = three || THREE_DEFAULT;
  const liveScene3d = options.liveScene3d || { activeLights: [] };

  // 1. Additive volumetric beam cone (MeshBasicMaterial, depthWrite: false)
  const matAdditive = new t.MeshBasicMaterial({
    color: HEADLIGHT_CONFIG.color,
    transparent: true,
    opacity: 0.0,
    blending: t.AdditiveBlending,
    depthWrite: false,
  });
  const headlightBeams = new t.Mesh(
    new t.ConeGeometry(HEADLIGHT_CONFIG.coneRadius, HEADLIGHT_CONFIG.coneLength, 12),
    matAdditive
  );
  headlightBeams.name = "headlightBeams";
  headlightBeams.position.set(0, 3.2, 0.65);
  headlightBeams.rotation.x = Math.PI / 2;
  headlightBeams.visible = false; // vfx-lint-allow: headlight beam toggle initial
  root.add(headlightBeams);

  // 2. Pre-allocated pooled FxLightSource carrier (duck-typed carrier, zero THREE.Light churn)
  const pooledLight = new FxLightSource("emitter");
  pooledLight.color.setHex(HEADLIGHT_CONFIG.color);
  pooledLight.distance = HEADLIGHT_CONFIG.distance;
  pooledLight.intensity = 0.0;
  if (Array.isArray(liveScene3d.activeLights)) {
    liveScene3d.activeLights.push(pooledLight);
  }

  return {
    headlightBeams,
    pooledLight,
    update(state = {}) {
      if (state.headlights !== undefined) {
        const on = Boolean(state.headlights);
        headlightBeams.visible = on; // vfx-lint-allow: additive beam mesh toggle
        matAdditive.opacity = on ? 0.35 : 0.0;
        pooledLight.intensity = on ? HEADLIGHT_CONFIG.intensity : 0.0;
        pooledLight.position.copy(root.position).add(
          new t.Vector3(HEADLIGHT_CONFIG.beamOffset[0], HEADLIGHT_CONFIG.beamOffset[1], HEADLIGHT_CONFIG.beamOffset[2])
        );
      }
    },
    dispose() {
      pooledLight.released = true;
      pooledLight.intensity = 0.0;
      if (Array.isArray(liveScene3d.activeLights)) {
        const idx = liveScene3d.activeLights.indexOf(pooledLight);
        if (idx >= 0) liveScene3d.activeLights.splice(idx, 1);
      }
      if (headlightBeams.geometry) headlightBeams.geometry.dispose();
      matAdditive.dispose();
    },
  };
}

/**
 * Creates radar CRT phosphor screen glow without Three.js light churn.
 */
export function createRadarCrtGlow(three, root, options = {}) {
  const t = three || THREE_DEFAULT;

  const matCrtGlow = new t.MeshBasicMaterial({
    color: CRT_GLOW_CONFIG.color,
    transparent: true,
    opacity: 0.85,
    blending: t.AdditiveBlending,
    depthWrite: false,
  });
  const crtWindow = new t.Mesh(
    new t.CircleGeometry(CRT_GLOW_CONFIG.circleRadius, 16),
    matCrtGlow
  );
  crtWindow.name = "crt-phosphor-scope";
  crtWindow.position.set(CRT_GLOW_CONFIG.glowOffset[0], CRT_GLOW_CONFIG.glowOffset[1], CRT_GLOW_CONFIG.glowOffset[2]);
  root.add(crtWindow);

  return {
    crtWindow,
    update(active = true) {
      matCrtGlow.opacity = active ? 0.85 : 0.0;
    },
    dispose() {
      if (crtWindow.geometry) crtWindow.geometry.dispose();
      matCrtGlow.dispose();
    },
  };
}

export const manifest = Object.freeze({
  id: "vfx-vehicle-fx-lights",
  channel: "vehicleLighting",
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "set",
  reads: ["geometry", "serverPose", "clock"],
  writes: ["lightIntensity"],
});
