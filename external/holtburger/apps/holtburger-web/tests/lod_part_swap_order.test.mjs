// The spawn-time LOD band of a single-part Setup rides as a part-0 model change
// (entities.js `lodPartSwap`, the 9f105e74 "sinking town sign" fix). The wasm
// part walk takes the LAST change per part index (lib.rs walk_setup_parts), so
// the band must come FIRST: a wire-commanded part-0 swap then still wins. It
// was appended, so the ORIGINAL model's band replaced a wire-swapped part 0.
//
//   A  no wire change: the band is the only part-0 change
//   B  a wire part-0 change: band first, wire last (the wire wins)
//   C  out of every band (no substitute): the wire changes pass unchanged
import * as THREE from "three";

globalThis.window = globalThis.window || {};
globalThis.location = { search: "" };
window.location = globalThis.location;
window.requestAnimationFrame = () => 0;
window.cancelAnimationFrame = () => {};

const { EntityManager } = await import("../scene3d/entities.js");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) pass += 1;
  else { fail += 1; console.error(`FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
}

const SIGN = 0x0200ab01, BAND = 0x0100ab02, WIRE = 0x0100ab03;
function manager(sub) {
  window.liveScene3d = { camera: { position: new THREE.Vector3(0, 2, 0) } };
  const em = new EntityManager({ scene: new THREE.Group(), entitiesGroup: new THREE.Group(), quality: { preset: "high" }, materialCache: null, activeLights: [] }, {});
  em.wasmExports = {
    fetchEntityAnimationKeyframes: () => {},
    fetch_entity_degrade_for_distance: async () => sub,
  };
  const seen = [];
  em.animationCache.get = async (_setup, _mt, _m, _s, _f, opts) => {
    seen.push(Array.from(opts?.modelChanges ?? []));
    return { partCount: 0, clip: null, resolvedStance: 0, restOrigins: new Float32Array(0), restOrientations: new Float32Array(0), partGroups: [], hooks: [] };
  };
  return { em, seen };
}
const meta = (guid, wire, setup = SIGN) => ({
  guid, modelId: setup, setupId: setup, landblockId: 0x00000001, x: 40, y: 0, z: 0, qw: 1, qx: 0, qy: 0, qz: 0,
  mtableId: 0, motionCommand: 0, motionStance: 0, modelChanges: Uint32Array.from(wire),
});

{
  const { em, seen } = manager(BAND);
  await em.spawn(meta(0x7b000001, []));
  check("A: the band rides as the one part-0 change", JSON.stringify(seen[0]) === JSON.stringify([0, BAND]), JSON.stringify(seen[0]));
}
{
  const { em, seen } = manager(BAND);
  await em.spawn(meta(0x7b000002, [0, WIRE]));
  const mc = seen[0];
  check("B: band first, the wire's part-0 swap last — the wire model draws", JSON.stringify(mc) === JSON.stringify([0, BAND, 0, WIRE]), JSON.stringify(mc));
}
{
  const { em, seen } = manager(0);
  // another Setup: the spawn memo (lod_prewarm, per Setup x 25 m bucket) keeps A/B's band
  await em.spawn(meta(0x7b000003, [0, WIRE], 0x0200ab09));
  check("C: no band → the wire changes as sent", JSON.stringify(seen[0]) === JSON.stringify([0, WIRE]), JSON.stringify(seen[0]));
}

console.log(`lod_part_swap_order: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
