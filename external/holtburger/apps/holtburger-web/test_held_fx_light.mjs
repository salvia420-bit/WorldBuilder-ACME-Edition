// Held-weapon FX light (2026-10-11, `?heldFxLightSkip`, DEFAULT ON) — owner:
// "light from weapons should not illuminate my armor, its too much".
//
// A flaming / lightning weapon's default_script spawns its emitters on the
// blade, and every lit emitter carries a tier-1 FX light (vfx/fx_lights.js),
// so the light sat a hand's width from the wielder's armour. Retail weapons
// carry no light at all (their Setups have no LightInfo; particles never
// light anything). ON: an emitter light on a HELD item (rig root branded
// `userData.__attachedChildOf`) is suppressed; a dropped weapon keeps it.
//
// Run from apps/holtburger-web/:  node test_held_fx_light.mjs

import * as THREE from "three";
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed++; else failed++;
}
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

async function run() {
  globalThis.window = globalThis.window || {};
  globalThis.location = { search: "" };
  window.location = globalThis.location;

  const lights = await import("./scene3d/vfx/fx_lights.js");
  const fx = await import("./scene3d/particles/particle_fx.js");
  const prof = await import("./scene3d/particles/particle_fx_profiles.js");
  lights._resetFxLightsForTest();

  // ---- 1. the data that made the weapon a lamp ---------------------------------------
  const T = (did) => fx.particleFxTier1(prof.FX_DID_ROWS.get(did >>> 0));
  const flame = T(0x3200026E), crackle = T(0x32000395);
  check("1. a flaming weapon's blade flame and a lightning weapon's crackle carry tier-1 FX lights (the source of the wash)",
    flame.light > 10 && crackle.light > 20, `flame ${flame.light.toFixed(1)} / ${flame.lightRange} m, crackle ${crackle.light.toFixed(1)} / ${crackle.lightRange} m`);

  // ---- 2. held vs dropped vs world ----------------------------------------------------
  // The rigs as entities.js builds them: emitter.parent = the item's rig root;
  // a HELD item's root is mounted under the wielder's part and branded.
  const wielder = new THREE.Group();
  const hand = new THREE.Group();
  wielder.add(hand);
  const heldRoot = new THREE.Group();
  heldRoot.userData.__attachedChildOf = 0x50000001;
  hand.add(heldRoot);
  const droppedRoot = new THREE.Group();
  const brazierRoot = new THREE.Group();
  const scene3d = { activeLights: [], _lightRefPos: new THREE.Vector3(0, 0, 0) };
  const at = (x, y, z) => (out) => { out.set(x, y, z); return true; };
  const eHeld = { numParticles: 4, parent: heldRoot };
  const eDrop = { numParticles: 4, parent: droppedRoot };
  const eWorld = { numParticles: 4, parent: brazierRoot };
  const eNested = { numParticles: 4, parent: { userData: {}, parent: heldRoot } }; // a POJO frame under the held rig
  const lHeld = lights.bindEmitterFxLight({ emitter: eHeld, resolvePosition: at(0.4, 1.1, 0), intensity: flame.light, range: flame.lightRange, color: [1, 0.4, 0.1] });
  const lDrop = lights.bindEmitterFxLight({ emitter: eDrop, resolvePosition: at(6, 0.1, 0), intensity: flame.light, range: flame.lightRange, color: [1, 0.4, 0.1] });
  const lWorld = lights.bindEmitterFxLight({ emitter: eWorld, resolvePosition: at(-6, 1, 0), intensity: 20, range: 5, color: [1, 0.6, 0.2] });
  const lNested = lights.bindEmitterFxLight({ emitter: eNested, resolvePosition: at(12, 1, 0), intensity: 10, range: 4, color: [1, 1, 1] });
  check("2. the held-item test reads the EQUIP-3 mount brand up the parent chain",
    lights.fxEmitterOnHeldItem(eHeld) && lights.fxEmitterOnHeldItem(eNested) &&
    !lights.fxEmitterOnHeldItem(eDrop) && !lights.fxEmitterOnHeldItem(eWorld) && !lights.fxEmitterOnHeldItem(null));
  for (let i = 0; i < 30; i++) lights.tickFxLights(scene3d, 1000 + i * 16);
  check("2. ON (default): the wielded weapon's light never joins the pool",
    lights.heldFxLightSkipEnabled() === true && lHeld.suppressed && !lHeld.registered && !scene3d.activeLights.includes(lHeld) && lHeld.intensity === 0);
  check("2. ON: a light nested under the held rig is skipped too", !scene3d.activeLights.includes(lNested));
  check("2. ON: a dropped weapon and a world emitter still light", scene3d.activeLights.includes(lDrop) && scene3d.activeLights.includes(lWorld) &&
    lDrop.intensity > 10 && lWorld.intensity > 10);
  check("2. diag counts the skipped held lights", lights.fxLightsStats().heldSkipped === 2, JSON.stringify(lights.fxLightsStats().heldSkipped));

  // a held light must not suppress a weaker neighbour (it is never `kept`)
  const eNear = { numParticles: 4, parent: new THREE.Group() };
  const lNear = lights.bindEmitterFxLight({ emitter: eNear, resolvePosition: at(0.9, 1.1, 0), intensity: 5, range: 3, color: [1, 1, 1] });
  for (let i = 0; i < 40; i++) lights.tickFxLights(scene3d, 2000 + i * 16);
  check("2. a skipped held light does not dedupe away an FX light beside it", !lNear.suppressed && scene3d.activeLights.includes(lNear));

  // unmount: the brand comes off (entities.js _unlinkChildRig) → the light returns
  delete heldRoot.userData.__attachedChildOf;
  for (let i = 0; i < 40; i++) lights.tickFxLights(scene3d, 3000 + i * 16);
  check("2. once the item is dropped (brand cleared) its light comes back", scene3d.activeLights.includes(lHeld) && lHeld.intensity > 1);
  heldRoot.userData.__attachedChildOf = 0x50000001;
  for (let i = 0; i < 40; i++) lights.tickFxLights(scene3d, 4000 + i * 16);
  check("2. …and goes again when it is wielded", !scene3d.activeLights.includes(lHeld));

  // ---- 3. the escape ------------------------------------------------------------------
  lights._setHeldFxLightSkipForTest(false);
  for (let i = 0; i < 40; i++) lights.tickFxLights(scene3d, 5000 + i * 16);
  check("3. ?heldFxLightSkip=off: the wielded weapon lights again (pre-2026-10-11 behaviour)",
    scene3d.activeLights.includes(lHeld) && lHeld.intensity > 1 && lights.fxLightsStats().heldSkipped === 0);
  lights._setHeldFxLightSkipForTest(null);
  check("3. the URL reader: absent = ON", lights.heldFxLightSkipEnabled() === true);
  globalThis.location.search = "?heldFxLightSkip=off";
  lights._setHeldFxLightSkipForTest(null);
  check("3. the URL reader: =off", lights.heldFxLightSkipEnabled() === false);
  globalThis.location.search = "";
  lights._setHeldFxLightSkipForTest(null);

  // ---- 4. wiring ------------------------------------------------------------------------
  const ent = src("./scene3d/entities.js");
  check("4. entities.js brands the mounted held-item root and clears it on unmount (the signal this reads)",
    ent.includes("c.root.userData.__attachedChildOf = pGuid;") && ent.includes("delete c.root.userData.__attachedChildOf;"));
  check("4. entity particle emitters are parented to the item's rig root", /parent: inst\.root,/.test(ent) && /parent: rig,/.test(ent));
  const flags = src("./docs/url-flags.md");
  check("4. url-flags.md documents ?heldFxLightSkip", /\|\s*`heldFxLightSkip`/.test(flags));

  lights._resetFxLightsForTest();
  console.log(`\n[test_held_fx_light] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
