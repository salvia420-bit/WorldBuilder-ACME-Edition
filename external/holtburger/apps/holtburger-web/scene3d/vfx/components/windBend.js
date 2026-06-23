// deformation.windBend — the first VFX component (Phase 0, 2026-06-23).
//
// MECH-A: per-part hinge keyframes, played by the existing animated_scenery.js
// shared-mixer player. Wraps the shipped tree-wind math (buildBboxRig +
// buildTreeWindClip) UNCHANGED, so ?treeWind=on remains byte-identical. This is
// archetype #1's component (trunk-canopy).
//
// buildClip passes `config` straight through to buildTreeWindClip (which owns
// the parameter defaults), exactly mirroring the live runtime call in
// animated_scenery.js getOrCreateWindGroup — so there is a SINGLE source of
// defaults and no drift. `defaults` below is metadata for the classifier/config
// layer, not re-applied here.

import { buildBboxRig, buildTreeWindClip } from "../../wind_rig.js";
import { registerComponent } from "../registry.js";

export const windBend = {
  id: "deformation.windBend",
  family: "deformation",
  mech: "A",
  channel: "transform",
  linkVariant() { return ""; }, // MECH-A: no shader link
  cacheKeyScope: "none",
  deterministic: true,
  lightCountDelta: 0,
  // Legacy-safety manifest (spec §1.2): reads geometry + per-instance hash +
  // wind state + the client clock; writes ONLY the per-part render transform on
  // the non-rendered template the player copies onto instances. Never touches
  // the wire, physics/collision, or any server-replicated field.
  reads: ["geometry", "instanceHash", "clock", "weather"],
  writes: ["partTransform"],
  defaults: { fps: 30, loopSeconds: 4, ampDeg: 7, dirDeg: 135, strength: 1, cycles1: 3, cycles2: 11, flutter: 0.3 },

  /**
   * Build the per-part keyframe clip for one (setup, phase-bucket).
   * @param {{numParts:number, partBoxes:object[], hingeFrames:(object|null)[]}} ctx
   *        partBoxes[p] = partBBox(part geometry positions); hingeFrames[p] = rest frame or null.
   * @param {object} config  runtime wind params (dirDeg, strength, phaseOffset, ...);
   *        missing keys fall back to buildTreeWindClip's internal defaults.
   * @returns {{frames:Float32Array, numParts:number, numFrames:number, fps:number}}
   *          the flat clip for buildSceneryAnimationClip — byte-identical to today's inline call.
   */
  buildClip(ctx, config) {
    const rig = buildBboxRig(ctx.partBoxes, ctx.hingeFrames).rigs;
    return buildTreeWindClip(ctx.numParts, rig, config || {});
  },
};

registerComponent(windBend);
export default windBend;
