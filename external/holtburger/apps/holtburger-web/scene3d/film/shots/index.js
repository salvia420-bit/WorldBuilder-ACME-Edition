// scene3d/film/shots/index.js — the shot grammar entry point (SPEC §2.9–§2.12).
//
// WHY: one import gives the runtime, the scout and the Node CLI the complete
// shot API — the registry (listTechniques / buildShot / getTechnique /
// registerTechnique), the trajectory value type and its combinators, and the
// framing math — with EVERY shipped technique already registered. Technique
// modules only export arrays of defineTechnique(...) results; this file is the
// one place that registers them, so a malformed or duplicate definition fails
// loudly at import time (and in the film_registry gate test) instead of
// vanishing from the catalog.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm, no clocks.

import { registerTechnique } from "./registry.js";
import { CLASSIC_TECHNIQUES } from "./classic.js";
import { DRONE_TECHNIQUES, FPV_TECHNIQUES } from "./drone.js";

/**
 * Re-exports (documented at their source): the registry API (registerTechnique,
 * getTechnique, listTechniques, buildShot, defineTechnique, ctxDefaults,
 * createRegistry, specSeed, …), the trajectory API (makeTrajectory, timeWarp,
 * withOffset, concatTrajectories, bakeTrajectory, tableChecksum,
 * trajectoryFromTable, validateTrajectory, orientLookAt, aimSubject,
 * clampToEnvelope, subjectCoverage, …), the framing API (FRAMINGS,
 * distanceForFraming, projectToNdc, compositionMetrics, …) and the raw
 * technique definition arrays.
 */
export * from "./registry.js";
export * from "./trajectory.js";
export * from "./framing.js";
export { listTechniques, buildShot, getTechnique, registerTechnique } from "./registry.js";
export { CLASSIC_TECHNIQUES, DRONE_TECHNIQUES, FPV_TECHNIQUES };

/**
 * Register every technique of the given lists (classic, drone, fpv) into the
 * default registry, in order. Any malformed or duplicate definition throws a
 * FilmShotError naming the technique.
 * @param {...Array<Object>} lists
 * @returns {string[]} the registered ids
 */
function registerAll(...lists) {
  const ids = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const def of list) ids.push(registerTechnique(def).id);
  }
  return ids;
}

/**
 * Ids registered by this module at import time, in catalog order
 * (classic, then drone, then fpv).
 * @type {ReadonlyArray<string>}
 */
export const REGISTERED_TECHNIQUE_IDS = Object.freeze(registerAll(CLASSIC_TECHNIQUES, DRONE_TECHNIQUES, FPV_TECHNIQUES));
