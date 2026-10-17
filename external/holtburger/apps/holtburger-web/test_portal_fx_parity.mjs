// Portal parity (2026-10-11) — owner: "yellow, green, white etc portals don't
// have the 3dness and such that the purple portals have".
//
// The retail data is symmetric (Setups 0x020001B3 vs 0x020005D2-D6 /
// 0x020006F4 differ only in light colour + default_script; the swirl emitters
// only in GfxObj / surface). Two client-side asymmetries made the coloured
// ones flat:
//   A. the generator's "portal" tag came from the first three weenie NAMES
//      matching /portal/i — red / orange / pillar swirls missed it and lost
//      the portal breathing, the x1.25 swirl distortion and the x1.3 light
//      (fixed in tools/particle-fx/enrich.py: tag by Portal weenie type);
//   B. the showcase disc + ground ring are additive at the swirl colour
//      normalised to max channel 1, so yellow / green / white drew ~3x the
//      luminance of purple over the swirl (`?portalFxLum`, fx_showcase.js).
//
// Run from apps/holtburger-web/:  node test_portal_fx_parity.mjs

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
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};

  const fx = await import("./scene3d/particles/particle_fx.js");
  const prof = await import("./scene3d/particles/particle_fx_profiles.js");
  const catalog = JSON.parse(src("./data/particle-fx-catalog.json"));
  const tier1 = JSON.parse(src("./data/particle-fx-tier1.json"));

  // ---- 1. data: every portal swirl gets the purple swirl's treatment ------------------
  const PURPLE = "0x320002CD";
  const MAIN = {
    yellow: "0x320003B1", green: "0x320003B2", orange: "0x320003B3", red: "0x320003B4",
    blue: "0x320003B5", white: "0x32000437", purpleHorizontal: "0x3200049D",
  };
  const T = (did) => fx.particleFxTier1(prof.FX_DID_ROWS.get(parseInt(did, 16) >>> 0));
  const P = T(PURPLE);
  const same = (a, b, keys) => keys.every((k) => Math.abs((a[k] || 0) - (b[k] || 0)) < 1e-3);
  const t1Keys = ["light", "lightRange", "distort", "distortKind", "kids", "kidKind", "kidLife", "kidSpread", "kidGain"];
  for (const [name, did] of Object.entries(MAIN)) {
    const t = T(did);
    check(`1. ${name} swirl ${did}: purple's light / distortion / inflow motes`, same(t, P, t1Keys),
      `light ${t.light} distort ${t.distort} kids ${t.kids}`);
  }
  for (const [name, did] of Object.entries(MAIN)) {
    const c = catalog.emitters[did];
    check(`1. ${name} swirl ${did}: portal tag + purple's breathing (0.07 @ 0.9 Hz)`,
      (c.tags || []).includes("portal") && c.params.pulse === 0.07 && c.params.pulseHz === 0.9,
      `tags ${JSON.stringify(c.tags)} pulse ${c.params.pulse}@${c.params.pulseHz}`);
  }
  check("1. each keeps its OWN light colour (yellow is yellow, red is red)",
    tier1.emitters[MAIN.yellow].lightColor[2] < 0.2 && tier1.emitters[MAIN.red].lightColor[0] === 1 &&
    tier1.emitters[MAIN.red].lightColor[1] < 0.3 && tier1.emitters[PURPLE].lightColor[1] < 0.1);
  const RIMS = ["0x320002D6", "0x320003B6", "0x320003B7", "0x320003B8", "0x320003B9", "0x320003BA", "0x32000438"];
  check("1. every rim layer is portal-tagged (breathing)", RIMS.every((d) => (catalog.emitters[d].tags || []).includes("portal") &&
    catalog.emitters[d].params.pulse === 0.07), RIMS.filter((d) => !(catalog.emitters[d].tags || []).includes("portal")).join(" "));
  const PILLARS = ["0x3200090D", "0x32000808", "0x3200090A", "0x3200090F", "0x32000915", "0x32000914"];
  const P0 = T(PILLARS[0]);
  check("1. every pillar portal funnel matches the purple pillar (light / distortion / breathing)",
    PILLARS.every((d) => same(T(d), P0, ["light", "distort", "distortKind"]) && catalog.emitters[d].params.pulse === 0.07),
    PILLARS.map((d) => `${d}:${T(d).light.toFixed(1)}/${T(d).distort}`).join(" "));
  const enrich = src("./tools/particle-fx/enrich.py");
  // 2026-10-16: the portal-space colour swirls (green / orange / white, on the
  // ACE-only "Portal Space" weenies and the static dungeon decorations) had no
  // portal tag — enrich.py only counted LSD Portal weenies. A Setup built on
  // the portal quad 0x0100168B is a portal setup now.
  for (const [name, did] of [["portal-space green", "0x32000697"], ["portal-space orange", "0x32000698"], ["portal-space white", "0x3200069A"]]) {
    const c = catalog.emitters[did];
    check(`1. ${name} swirl ${did}: portal tag, purple's breathing, light and distortion`,
      (c.tags || []).includes("portal") && c.params.pulse === 0.07 && c.params.pulseHz === 0.9 && same(T(did), P, ["light", "distort", "distortKind"]),
      `tags ${JSON.stringify(c.tags)} light ${T(did).light}`);
  }
  check("1. the shadow swirls (0x32000877 / 0x32000882 / 0x3200089B) are portal-tagged",
    ["0x32000877", "0x32000882", "0x3200089B"].every((d) => (catalog.emitters[d].tags || []).includes("portal")));
  check("1. the generator tags a Setup built on the portal quad",
    enrich.includes("PORTAL_QUAD = 0x0100168B") && enrich.includes('PORTAL_QUAD in (s.get("parts") or [])'));
  check("1. the Destroyed Portals' sputters glow at their rings' level, not the live portal's 36 / 9 m",
    tier1.emitters["0x320009D7"].light === 12 && tier1.emitters["0x320009DB"].lightRange === 4.5);
  check("1. a creature effect on a setup only ONE in four weenies of which is a portal stays untagged (Quiddity Seed 0x02001770)",
    !(catalog.emitters["0x32000751"].tags || []).includes("portal"));
  check("1. the generator tags by Portal weenie type, not by name",
    enrich.includes('d.get("weenieType") == 7') && enrich.includes("(portal weenie)") && enrich.includes("2 * n >= len(setup_w[sid])"));

  // ---- 2. luminance normalisation ---------------------------------------------------
  const show = await import("./scene3d/vfx/fx_showcase.js");
  const L = show.portalColorLuminance;
  const norm = (c) => { const m = Math.max(...c); return c.map((x) => x / m); };
  const col = (did) => norm(tier1.emitters[did].lightColor);
  check("2. the reference is the purple swirl's light colour (lum ~0.29)",
    Math.abs(show.PORTAL_REF_LUM - 0.293) < 0.002 && show.portalLumScale(col(PURPLE)) === 1);
  for (const name of ["yellow", "green", "white", "orange"]) {
    const c = col(MAIN[name]);
    const k = show.portalLumScale(c);
    check(`2. ${name}: scaled down to purple's luminance (k ${k.toFixed(3)})`, k < 1 && Math.abs(L(c) * k - show.PORTAL_REF_LUM) < 1e-6);
  }
  check("2. a darker portal is never brightened (blue k = 1)", show.portalLumScale(col(MAIN.blue)) === 1);

  // ---- 3. the set piece draws the scaled disc + ring --------------------------------
  const lights = await import("./scene3d/vfx/fx_lights.js");
  const dec = await import("./scene3d/vfx/fx_decals.js");
  const scene = new THREE.Scene();
  // ?portalSetPiece: the yellow portal Setup 0x020005D6, under a worldRoot like
  // the client's (−π/2 about X: AC z-up → THREE y-up)
  const world = new THREE.Group();
  world.rotation.x = -Math.PI / 2;
  scene.add(world);
  const portal = { guid: 0x70000011, root: new THREE.Group(), meta: { objDescFlags: show.ODF_PORTAL, modelId: 0x020005d6 } };
  portal.root.position.set(4, 0, 0);
  world.add(portal.root);
  scene.updateMatrixWorld(true);
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 2000);
  cam.position.set(0, 2, 10);
  cam.updateMatrixWorld(true);
  const s3d = { entityManager: { entityMap: new Map([[portal.guid, portal]]) }, scene, camera: cam, renderer: { toneMappingExposure: 5 } };
  const yellow = col(MAIN.yellow);
  // the set piece's colour is the portal table's (the same tier-1 light colour, 4 decimals)
  const yellowRow = show.portalSetupFor(0x020005d6).color;
  const kY = show.portalLumScale(yellowRow);
  check("3. the portal table carries the yellow swirl's own light colour",
    yellowRow.every((v, i) => Math.abs(v - yellow[i]) < 1e-4), JSON.stringify(yellowRow));
  // the swirl's FX light where the showcase looks for it (no distortion source: root + 1.6 m)
  const lightY = lights.bindEmitterFxLight({ emitter: { numParticles: 3 }, resolvePosition: (o) => { o.set(4, 1.6, 0); return true; },
    intensity: 36, range: 9, color: yellow });
  const read = (now) => {
    show._resetFxShowcaseForTest();
    dec._resetFxDecalsForTest();
    // a piece fades in over 0.6 s (?portalSetPiece) — step past it
    for (const dt of [0, 250, 500, 750]) show.tickFxShowcase(s3d, now + dt);
    const mesh = scene.children.find((o) => o.userData?.isFxShowcase);
    const ring = dec.collectFxDecals({ x: 0, y: 0, z: 0 }, [], now).find((d) => d.persistent);
    return { disc: mesh?.geometry.attributes.aS2.array[3], ring: ring?.intensity, rgb: Array.from(mesh?.geometry.attributes.aS2.array.slice(0, 3) || []),
      deep: mesh?.material.uniforms.uShowDeepHue.value };
  };
  show._setPortalFxLumForTest(true);
  const on = read(30000);
  check("3. ON: a yellow portal's disc + ring at purple's luminance, in yellow",
    Math.abs(on.disc - 0.9 * kY) < 1e-6 && Math.abs(on.ring - 0.9 * kY) < 1e-6 && on.rgb[2] < 0.2 && on.rgb[0] === 1,
    `disc ${on.disc?.toFixed(3)} ring ${on.ring?.toFixed(3)} k ${kY.toFixed(3)}`);
  check("3. ON: the nebula base keeps the portal's hue", on.deep === 1);
  show._setPortalFxLumForTest(false);
  const off = read(31000);
  check("3. ?portalFxLum=off: the legacy 0.9 disc + ring and the violet base", Math.abs(off.disc - 0.9) < 1e-6 && Math.abs(off.ring - 0.9) < 1e-6 && off.deep === 0,
    `disc ${off.disc} ring ${off.ring}`);
  lights.releaseFxLight(lightY);
  lights._resetFxLightsForTest();
  show._setPortalFxLumForTest(true);
  const fb = read(32000);
  check("3. no swirl light (tier-1 off / no pool slot): the yellow portal stays yellow at purple's luminance (the colour is its Setup's)",
    Math.abs(fb.disc - 0.9 * kY) < 1e-6 && Math.abs(fb.ring - 0.9 * kY) < 1e-6 && fb.rgb[0] === 1 && fb.rgb[2] < 0.2, `disc ${fb.disc}`);
  show._setPortalFxLumForTest(null);
  check("3. the URL reader: absent = ON", show.portalFxLumEnabled() === true);
  const glsl = show.FX_SHOWCASE_GLSL.fragment;
  check("3. GLSL: the deep base mixes the hue-keeping and the legacy violet by uShowDeepHue",
    glsl.includes("uniform float uShowDeepHue;") &&
    glsl.includes("vec3 deep = vCol.rgb * ( 0.12 + 0.04 * uShowDeepHue ) + vec3( 0.02, 0.0, 0.05 ) * ( 1.0 - uShowDeepHue );"));
  const flags = src("./docs/url-flags.md");
  check("3. url-flags.md documents ?portalFxLum", /\|\s*`portalFxLum`/.test(flags));
  show._resetFxShowcaseForTest();
  dec._resetFxDecalsForTest();

  console.log(`\n[test_portal_fx_parity] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
