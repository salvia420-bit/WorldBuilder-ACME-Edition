// ?portalRecreateInPlace (scene3d/entities.js, DEFAULT ON, `=off` escape) — a
// re-sent CreateObject for the portal instance the client already draws keeps
// that portal (retail SmartBox::HandleCreateObject, acclient.c:145881: a
// same-instance create is applied in place; only a NEWER instance rebuilds).
// spawn() used to tear the rig down and rebuild it, restarting the swirl from
// nothing and dropping the light — the portal "popped" each time ACE re-sent
// it as the player walked toward / away from it.
//
//   A  samePortalInstance: what counts as the same portal instance
//   B  the REAL EntityManager.spawn(): an identical re-create returns the live
//      rig untouched; a moved / re-dressed / non-portal one rebuilds as before
//   C  `?portalRecreateInPlace=off` rebuilds every time
import * as THREE from "three";

globalThis.window = globalThis.window || {};
globalThis.location = { search: "" };
window.location = globalThis.location;
window.requestAnimationFrame = () => 0;
window.cancelAnimationFrame = () => {};

const ents = await import("../scene3d/entities.js");
const { EntityManager, samePortalInstance, __setPortalRecreateInPlaceForTest, portalRecreateInPlaceEnabled } = ents;

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) pass += 1;
  else { fail += 1; console.error(`FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
}

const PURPLE = 0x020001b3;
const meta = (o = {}) => ({
  guid: 0x7a000001, modelId: PURPLE, setupId: PURPLE, landblockId: 0xa9b40021,
  x: 101.25, y: 35.5, z: 52.004, qw: 0.7071, qx: 0, qy: 0, qz: 0.7071,
  objScale: 1, physicsTranslucency: 0, paletteId: 0,
  modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0), subPalettes: new Uint32Array(0),
  mtableId: 0x09000003, motionCommand: 0, motionStance: 0, objDescFlags: 0x40000, name: "Holtburg", ...o,
});
const cur = (m) => ({ root: new THREE.Group(), meta: m, _disposed: false });

// ── A ─────────────────────────────────────────────────────────────────────
{
  const m = meta();
  check("A: an identical re-create is the same instance", samePortalInstance(cur(m), meta()));
  check("A: q and −q are one heading", samePortalInstance(cur(m), meta({ qw: -0.7071, qz: -0.7071 })));
  check("A: sub-centimetre wire jitter is the same place", samePortalInstance(cur(m), meta({ x: 101.255 })));
  check("A: moved 5 cm → a new instance", !samePortalInstance(cur(m), meta({ x: 101.30 })));
  check("A: turned → a new instance", !samePortalInstance(cur(m), meta({ qw: 1, qz: 0 })));
  check("A: another landblock → a new instance", !samePortalInstance(cur(m), meta({ landblockId: 0xa9b50021 })));
  check("A: another Setup → a new instance", !samePortalInstance(cur(m), meta({ modelId: 0x020005d5, setupId: 0x020005d5 })));
  check("A: rescaled / ghosted → a new instance", !samePortalInstance(cur(m), meta({ objScale: 1.5 })) &&
    !samePortalInstance(cur(m), meta({ physicsTranslucency: 0.5 })));
  check("A: re-dressed (an ObjDesc change) → a new instance",
    !samePortalInstance(cur(m), meta({ modelChanges: Uint32Array.of(0, 0x01000001) })) &&
    !samePortalInstance(cur(m), meta({ paletteId: 0x0400007e })));
  const npc = meta({ modelId: 0x02000001, setupId: 0x02000001 });
  check("A: anything that is not a portal Setup always rebuilds", !samePortalInstance(cur(npc), npc));
  check("A: a disposed rig is never kept", !samePortalInstance({ ...cur(m), _disposed: true }, meta()));
}

// ── B / C — the real spawn() ──────────────────────────────────────────────
function makeManager() {
  const scene3d = { scene: new THREE.Group(), entitiesGroup: new THREE.Group(), quality: { preset: "high" }, materialCache: null, activeLights: [] };
  const em = new EntityManager(scene3d, {});
  em.wasmExports = { fetchEntityAnimationKeyframes: () => {} };
  em.animationCache.get = async () => ({
    partCount: 0, clip: null, resolvedStance: 0, restOrigins: new Float32Array(0),
    restOrientations: new Float32Array(0), partGroups: [], hooks: [],
  });
  return em;
}
{
  __setPortalRecreateInPlaceForTest(true);
  const em = makeManager();
  const a = await em.spawn(meta());
  check("B: the portal spawns", !!a && em.entityMap.get(meta().guid) === a);
  const b = await em.spawn(meta());
  check("B: ACE re-sends it — the SAME rig comes back, nothing torn down", b === a && em.entityMap.get(meta().guid) === a &&
    !a._disposed && a._recreatedInPlace === 1);
  const c = await em.spawn(meta({ x: 140 }));
  check("B: re-created somewhere else → rebuilt", !!c && c !== a && a._disposed === true && em.entityMap.get(meta().guid) === c);
  const npcMeta = meta({ guid: 0x50000009, modelId: 0x02000001, setupId: 0x02000001, objDescFlags: 0 });
  const n1 = await em.spawn(npcMeta);
  const n2 = await em.spawn(npcMeta);
  check("B: a non-portal re-create still rebuilds (unchanged behaviour)", !!n1 && !!n2 && n1 !== n2);

  __setPortalRecreateInPlaceForTest(false);
  const em2 = makeManager();
  const x = await em2.spawn(meta());
  const y = await em2.spawn(meta());
  check("C: =off — every re-create rebuilds", !!x && !!y && x !== y && x._disposed === true);
  __setPortalRecreateInPlaceForTest(undefined);
  check("C: absent → on", portalRecreateInPlaceEnabled() === true);
}

console.log(`portal_recreate_in_place: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
