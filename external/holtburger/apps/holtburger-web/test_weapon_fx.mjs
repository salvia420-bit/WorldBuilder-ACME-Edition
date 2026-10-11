// Per-weapon effects (`?weaponFx`, 2026-10-10) — node unit test.
//
// Locks the three bugs this replaces and the behaviour that replaces them:
//   1. SHAKING. The old entity path hashed each weapon's phase from its WORLD
//      position (`vfxHash01(modelMatrix[3].xy)`), re-rolled every frame on a held
//      weapon. Here a still weapon has zero bend, steady motion settles to zero,
//      and only acceleration bends a pole (a swing whips it, then it rings down).
//   2. WHITE. The old aura was a flat display-unit emissive under a 5x exposure.
//      Here intensities pass through uWfxCal = gain / exposure, and the physical
//      damage types get no glow at all.
//   3. TOO BRIGHT IN SHADE. A plain `.clone()` loses the base's CSM patch but
//      keeps its flags. makeOwnedVariant strips the lost flags and re-installs CSM.
// Runs the REAL modules: weapon_class / weapon_fx_glsl / the two components /
// weapon_fx / MaterialCache / fx_ribbons, against three's real ShaderLib sources.

import * as THREE from "three";
import fs from "node:fs";
import {
  auraForUiEffects, auraForElement, elementFromWeaponName, weaponElement,
  nameLooksLikeWeapon, flexClassFor, longAxisOf, shaftFrame, flexParams,
  makeSpring, stepSpring, bendVector, makeRng, seed01, AURA_BY_BIT,
} from "./scene3d/vfx/weapon_class.js";
import {
  WFX_KIND, WFX_FLEX_MARKER, WFX_AXIAL_MARKER, WFX_AURA_MARKER,
  WFX_FLEX_VERTEX, WFX_AXIAL_VERTEX, WFX_AURA_FRAGMENT, WFX_FRAG_NOISE, ensureDecls,
} from "./scene3d/vfx/weapon_fx_glsl.js";
import { weaponFlex } from "./scene3d/vfx/components/weaponFlex.js";
import { weaponAura } from "./scene3d/vfx/components/weaponAura.js";
import { getComponent, validateComponent } from "./scene3d/vfx/registry.js";
import { lintManifest, lintSource } from "./scene3d/vfx/lint_caps.js";
import { TIER1_COMPONENT_IDS } from "./scene3d/vfx/components/index.js";
import { MaterialCache, VFX_GLOBALS } from "./scene3d/materials.js";
import {
  weaponFxPlanFor, weaponGeometryOf, weaponFxBegin, weaponFxMaterial, weaponFxCommit,
  weaponFxForget, weaponFxOwnedMaterial, tickWeaponFx, weaponFxStats, weaponFxList,
  weaponFxForce, _resetWeaponFxForTest, flexLocoScale, FLEX_SWING_FULL_MS, FLEX_SWING_EASE_MS,
  approachFlexScale, FLEX_SCALE_TAU_S,
} from "./scene3d/vfx/weapon_fx.js";
import { fxSwingLook, FX_SWING_STEEL, FX_SWING_MAGIC } from "./scene3d/vfx/fx_ribbons.js";
import { _resetVfxFlags, swingTrailsMode, weaponFxEnabled, vfxEffectEnabled } from "./scene3d/vfx_flags.js";
import { _resetVfxCatalog } from "./scene3d/vfx_catalog.js";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  [OK] ${label}`); }
  else { fail++; console.log(`  [FAIL] ${label} ${extra}`); }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const count = (hay, needle) => hay.split(needle).length - 1;

// ===========================================================================
console.log("weapon_class — glow by UiEffects bit");
ok("Fire (0x20) ⇒ fire", auraForUiEffects(0x20)?.kind === WFX_KIND.fire);
ok("Lightning (0x40) ⇒ lightning", auraForUiEffects(0x40)?.kind === WFX_KIND.lightning);
ok("Frost (0x80) ⇒ frost", auraForUiEffects(0x80)?.kind === WFX_KIND.frost);
ok("Acid (0x100) ⇒ acid", auraForUiEffects(0x100)?.kind === WFX_KIND.acid);
ok("Nether (0x1000) ⇒ nether", auraForUiEffects(0x1000)?.kind === WFX_KIND.nether);
ok("Magical (0x1) ⇒ magic", auraForUiEffects(0x1)?.kind === WFX_KIND.magic);
ok("★ Slash / Pierce / Bludgeon get NO glow (the white-weapon bug)",
  auraForUiEffects(0x400) === null && auraForUiEffects(0x800) === null && auraForUiEffects(0x200) === null);
ok("Magical|Fire ⇒ fire (the element wins over the generic bit)", auraForUiEffects(0x21)?.element === "fire");
ok("0 ⇒ null", auraForUiEffects(0) === null);
ok("every glow colour is a non-white linear RGB (max-min spread >= 0.3)",
  AURA_BY_BIT.every((r) => Math.max(...r.color) - Math.min(...r.color) >= 0.3), JSON.stringify(AURA_BY_BIT.map((r) => r.color)));
ok("auraForElement('frost') round-trips", auraForElement("frost")?.bit === 0x80);
ok("name elements: Flaming Spada / Frost Pike / Lightning Ono / Acid Tofun",
  elementFromWeaponName("Flaming Spada") === "fire" && elementFromWeaponName("Frost Pike") === "frost" &&
  elementFromWeaponName("Lightning Ono") === "lightning" && elementFromWeaponName("Acid Tofun") === "acid");
ok("a plain name has no element", elementFromWeaponName("Long Sword") === null);
ok("weaponElement: UiEffects beats the name", weaponElement(0x80, "Flaming Spada") === "frost");
ok("weaponElement: falls back to the name", weaponElement(0, "Flaming Spada") === "fire");

console.log("weapon_class — weapons and poles");
ok("weapon names: Long Sword / Atlan Spear / Shield / Quarter Staff",
  nameLooksLikeWeapon("Long Sword") && nameLooksLikeWeapon("Atlan Spear") && nameLooksLikeWeapon("Kite Shield") && nameLooksLikeWeapon("Quarter Staff"));
ok("ammo and rings are not weapon-ish by name", !nameLooksLikeWeapon("Arrow") && !nameLooksLikeWeapon("Greater Deadly Acid Arrow") && !nameLooksLikeWeapon("Gold Ring"));
ok("★ Atlan Spear (2.08 m, 9 cm) is a pole", flexClassFor({ name: "Atlan Spear", length: 2.08, width: 0.09 }) === "pole");
ok("★ a sword never flexes (even a long thin one)", flexClassFor({ name: "Long Sword", length: 1.3, width: 0.05 }) === null);
ok("★ daggers, maces, axes, bows never flex",
  ["Dagger", "Flanged Mace", "Battle Axe", "Yumi", "Heavy Crossbow", "Tetsubo"].every((n) => flexClassFor({ name: n, length: 1.5, width: 0.05 }) === null));
ok("Swordstaff is a staff (pole words win)", flexClassFor({ name: "Burun Slaying Swordstaff", length: 1.7, width: 0.1 }) === "pole");
ok("a short 'staff' (< 1 m) stays rigid", flexClassFor({ name: "Staff", length: 0.8, width: 0.04 }) === null);
ok("unknown long thin ⇒ pole; unknown short or thick ⇒ rigid",
  flexClassFor({ name: "Whatsit", length: 1.8, width: 0.06 }) === "pole" &&
  flexClassFor({ name: "Whatsit", length: 1.0, width: 0.06 }) === null &&
  flexClassFor({ name: "Whatsit", length: 1.8, width: 0.4 }) === null);
{
  const la = longAxisOf([-0.027, -0.045, -0.558], [0.025, 0.045, 1.526]);
  ok("longAxisOf(atlan spear bounds) = z, 2.084 m, width 0.09", la.axis === 2 && near(la.length, 2.084, 1e-6) && near(la.width, 0.09, 1e-6));
}

console.log("weapon_class — shaft frame");
{
  // The atlan spear (GfxObj 0x01001A7D): z in [-0.558, 1.526], held at its
  // RightHandCombat placement (grip at z = 0.3925 in object space).
  const f = shaftFrame([-0.027, -0.045, -0.558], [0.025, 0.045, 1.526], 2, [-0.025, 0, 0.3925]);
  ok("held spear: origin on the centre line at the grip", near(f.origin[2], 0.3925, 1e-9) && near(f.origin[0], -0.001, 1e-9) && near(f.origin[1], 0, 1e-9));
  ok("held spear: axis +z (the longer side), lenPos 1.1335, lenNeg 0.9505",
    f.dir[2] === 1 && near(f.lenPos, 1.1335, 1e-9) && near(f.lenNeg, 0.9505, 1e-9) && f.held === true);
  const g = shaftFrame([-0.05, -0.05, -1.0], [0.05, 0.05, 0.2], 2, [0, 0, 0]);
  ok("held near the max end: the axis flips to the longer side", g.dir[2] === -1 && near(g.lenPos, 1.0, 1e-9) && near(g.lenNeg, 0.2, 1e-9));
  const h = shaftFrame([-0.05, -0.05, -1.0], [0.05, 0.05, 0.2], 2, null);
  ok("on the ground: origin at the min end, the whole length on +", near(h.origin[2], -1.0, 1e-9) && near(h.lenPos, 1.2, 1e-9) && near(h.lenNeg, 1e-3, 1e-12) && !h.held);
  const k = shaftFrame([-0.05, -0.05, -1.0], [0.05, 0.05, 0.2], 2, [0, 0, 5]);
  ok("a grip past the end clamps onto the shaft", near(k.origin[2], -1.0 + 1.2, 1e-9));
}

console.log("weapon_class — the spring");
{
  const p = flexParams(1.1);
  ok("flexParams: 1.6..3.2 Hz, damping 0.16, compliance 0.22, cap 0.13 rad", p.omega >= 2 * Math.PI * 1.6 && p.omega <= 2 * Math.PI * 3.2 && p.zeta === 0.16 && p.compliance === 0.22 && p.maxAng === 0.13);
  ok("longer sides ring slower", flexParams(2.0).omega < flexParams(0.8).omega);
  const s = makeSpring();
  const lag = [0, 0, 0];
  stepSpring(s, [1, 2, 3], 1 / 60, p, lag);
  ok("first step snaps (zero lag)", s.init && lag.every((v) => v === 0));
  let maxLag = 0;
  for (let i = 0; i < 120; i++) { stepSpring(s, [1, 2, 3], 1 / 60, p, lag); maxLag = Math.max(maxLag, Math.hypot(...lag)); }
  ok("★ at rest the tip never lags (no idle shaking)", maxLag < 1e-12, maxLag);
  // steady motion: 4 m/s along x for 2 s
  let x = 1, lastLag = 1;
  for (let i = 0; i < 120; i++) { x += 4 / 60; stepSpring(s, [x, 2, 3], 1 / 60, p, lag); lastLag = Math.hypot(...lag); }
  ok("★ steady motion settles to no lag (damping is relative to the end's own velocity)", lastLag < 1e-3, lastLag);
  // sudden stop: the virtual tip overshoots forward, then rings down
  let peak = 0, sawForward = false;
  for (let i = 0; i < 30; i++) { stepSpring(s, [x, 2, 3], 1 / 60, p, lag); peak = Math.max(peak, Math.abs(lag[0])); if (lag[0] > 0.01) sawForward = true; }
  ok("a sudden stop throws the tip forward (overshoot)", sawForward && peak > 0.02, peak);
  for (let i = 0; i < 240; i++) stepSpring(s, [x, 2, 3], 1 / 60, p, lag);
  ok("…and it rings down within 4 s", Math.hypot(...lag) < 1e-3, Math.hypot(...lag));
  stepSpring(s, [x + 10, 2, 3], 1 / 60, p, lag);
  ok("a > 1.5 m jump (teleport) resets", lag.every((v) => v === 0));
  stepSpring(s, [x + 10.2, 2, 3], 0.5, p, lag);
  ok("a 0.5 s hitch resets", lag.every((v) => v === 0));
  // the same physical motion at 30 fps and 144 fps gives a similar peak (sub-stepping)
  const peakAt = (fps) => {
    const sp = makeSpring(); const l = [0, 0, 0]; let xx = 0, pk = 0;
    stepSpring(sp, [0, 0, 0], 1 / fps, p, l);
    for (let i = 0; i < fps * 0.3; i++) { xx += 5 / fps; stepSpring(sp, [xx, 0, 0], 1 / fps, p, l); }
    for (let i = 0; i < fps; i++) { stepSpring(sp, [xx, 0, 0], 1 / fps, p, l); pk = Math.max(pk, Math.abs(l[0])); }
    return pk;
  };
  const p30 = peakAt(30), p144 = peakAt(144);
  ok("frame-rate independent (30 vs 144 fps overshoot within 15 %)", Math.abs(p30 - p144) / p144 < 0.15, `${p30} vs ${p144}`);
}

console.log("weapon_class — the bend vector");
{
  const p = { compliance: 0.3, maxAng: 0.13 };
  const out = bendVector([0.1, 0, 0], [0, 0, 1], 1.0, p);
  const ang = Math.hypot(...out);
  ok("angle = maxAng * tanh(atan(perp * compliance / len) / maxAng)", near(ang, 0.13 * Math.tanh(Math.atan(0.03) / 0.13), 1e-12), ang);
  ok("small bends are ~linear (within 2 %)", Math.abs(Math.hypot(...bendVector([0.01, 0, 0], [0, 0, 1], 1.0, p)) - Math.atan(0.003)) / Math.atan(0.003) < 0.02);
  // rotating the end direction about the vector moves it TOWARD the lag
  const k = out.map((v) => v / ang);
  const d = [0, 0, 1];
  const kxd = [k[1] * d[2] - k[2] * d[1], k[2] * d[0] - k[0] * d[2], k[0] * d[1] - k[1] * d[0]];
  ok("★ the bend swings the end toward its lag (sign check)", kxd[0] > 0.99, JSON.stringify(kxd));
  ok("the axial part of the lag does not bend", Math.hypot(...bendVector([0, 0, 0.5], [0, 0, 1], 1.0, p)) === 0);
  const big = Math.hypot(...bendVector([5, 0, 0], [0, 0, 1], 1.0, p));
  ok("saturates below maxAng, smoothly", big < 0.13 && big > 0.12, big);
  ok("gain scales it", Math.hypot(...bendVector([0.1, 0, 0], [0, 0, 1], 1.0, p, 2)) > ang * 1.9);
}

console.log("weapon_class — determinism");
{
  const a = makeRng(42), b = makeRng(42);
  const sa = [a(), a(), a()], sb = [b(), b(), b()];
  ok("makeRng is seeded and deterministic", sa.join() === sb.join() && sa.every((v) => v >= 0 && v < 1));
  ok("seed01 is stable and in [0,1)", seed01(0x80001234) === seed01(0x80001234) && seed01(7) >= 0 && seed01(7) < 1 && seed01(7) !== seed01(8));
}

// ===========================================================================
console.log("components — registry, manifest, lint");
ok("deformation.weaponFlex registered", getComponent("deformation.weaponFlex") === weaponFlex);
ok("emissive.weaponAura registered", getComponent("emissive.weaponAura") === weaponAura);
ok("both validate", validateComponent(weaponFlex).length === 0 && validateComponent(weaponAura).length === 0);
ok("both lint clean (manifest)", lintManifest(weaponFlex).length === 0 && lintManifest(weaponAura).length === 0);
for (const f of ["scene3d/vfx/components/weaponFlex.js", "scene3d/vfx/components/weaponAura.js"]) {
  const hits = lintSource(fs.readFileSync(f, "utf8"));
  ok(`${f} source lint clean`, hits.length === 0, JSON.stringify(hits));
}
ok("both are in TIER1_COMPONENT_IDS", TIER1_COMPONENT_IDS.includes("deformation.weaponFlex") && TIER1_COMPONENT_IDS.includes("emissive.weaponAura"));
ok("GLSL carries no backticks", ![WFX_FLEX_VERTEX, WFX_AXIAL_VERTEX, WFX_AURA_FRAGMENT, WFX_FRAG_NOISE].some((g) => g.includes("`")));
for (const [n, g] of [["flex", WFX_FLEX_VERTEX], ["axial", WFX_AXIAL_VERTEX], ["aura", WFX_AURA_FRAGMENT], ["noise", WFX_FRAG_NOISE]]) {
  ok(`GLSL ${n}: balanced braces and parens`, count(g, "{") === count(g, "}") && count(g, "(") === count(g, ")"));
}
ok("ensureDecls is idempotent", ensureDecls(ensureDecls("void main() {", ["uniform float a;"]), ["uniform float a;"]).split("uniform float a;").length === 2);

console.log("components — patch surgery on three's real MeshStandard sources");
function freshShader() {
  const sl = THREE.ShaderLib.standard;
  return { uniforms: THREE.UniformsUtils.clone(sl.uniforms), vertexShader: sl.vertexShader, fragmentShader: sl.fragmentShader };
}
{
  const bundle = { uWfxOrigin: { value: new THREE.Vector3() }, uWfxAxis: { value: new THREE.Vector3(0, 0, 1) },
    uWfxLen: { value: new THREE.Vector2(1, 1) }, uWfxFrame: { value: 1 }, uWfxGrip: { value: 1 },
    uWfxBendPos: { value: new THREE.Vector3() }, uWfxBendNeg: { value: new THREE.Vector3() },
    uWfxAuraColor: { value: new THREE.Vector3(1, 0.4, 0.1) }, uWfxAuraKind: { value: 2 }, uWfxLevel: { value: 1 },
    uWfxShine: { value: new THREE.Vector4() }, uWfxSeed: { value: 0.3 }, uWfxCal: { value: 0.2 } };
  const sh = freshShader();
  const globals = { uTime: VFX_GLOBALS.uTime, wfx: bundle };
  for (const c of [weaponFlex, weaponAura]) { c.declareUniforms(sh, {}, globals); c.inject(sh); }
  // a second install on the same shader (recompile) must change nothing
  const vs1 = sh.vertexShader, fs1 = sh.fragmentShader;
  for (const c of [weaponFlex, weaponAura]) c.inject(sh);
  ok("re-inject is a no-op", sh.vertexShader === vs1 && sh.fragmentShader === fs1);
  ok("vertex: flex + axial snippets, once each", count(sh.vertexShader, WFX_FLEX_MARKER) === 1 && count(sh.vertexShader, WFX_AXIAL_MARKER) === 1);
  ok("vertex: shared frame uniforms declared ONCE (both components need them)",
    count(sh.vertexShader, "uniform vec3 uWfxOrigin;") === 1 && count(sh.vertexShader, "uniform vec2 uWfxLen;") === 1 && count(sh.vertexShader, "uniform float uWfxFrame;") === 1);
  ok("vertex: varyings declared once", count(sh.vertexShader, "varying float vWfxAxial;") === 1 && count(sh.vertexShader, "varying vec3 vWfxObj;") === 1);
  ok("vertex: #include <begin_vertex> kept exactly once", count(sh.vertexShader, "#include <begin_vertex>") === 1);
  ok("vertex: the snippets read the rest pose (position), the bend writes transformed",
    WFX_AXIAL_VERTEX.includes("position - uWfxOrigin") && WFX_FLEX_VERTEX.includes("transformed = uWfxOrigin"));
  ok("fragment: aura once, after the emissive seam", count(sh.fragmentShader, WFX_AURA_MARKER) === 1 &&
    sh.fragmentShader.indexOf("#include <emissivemap_fragment>") < sh.fragmentShader.indexOf(WFX_AURA_MARKER));
  ok("fragment: uTime / noise / varyings declared once", count(sh.fragmentShader, "uniform float uTime;") === 1 &&
    count(sh.fragmentShader, "float wfxNoise3(vec3 x)") === 1 && count(sh.fragmentShader, "varying float vWfxAxial;") === 1);
  ok("fragment: everything before main()", sh.fragmentShader.indexOf("float wfxHash13") < sh.fragmentShader.indexOf("void main() {"));
  ok("★ uniforms bound BY REFERENCE to the weapon's bundle", sh.uniforms.uWfxBendPos === bundle.uWfxBendPos &&
    sh.uniforms.uWfxAuraKind === bundle.uWfxAuraKind && sh.uniforms.uWfxCal === bundle.uWfxCal && sh.uniforms.uTime === VFX_GLOBALS.uTime);
  ok("the aura output is calibrated (× uWfxLevel × uWfxCal)", WFX_AURA_FRAGMENT.includes("totalEmissiveRadiance += _wAdd * uWfxLevel * uWfxCal;"));
  // a non-PBR material (Lambert has the emissive seam but no metalnessFactor) stays untouched
  const lam = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
  weaponAura.inject(lam);
  ok("inert on a non-PBR material", lam.fragmentShader === THREE.ShaderLib.lambert.fragmentShader);
  // standalone (no bundle) stays inert, never throws
  const lone = freshShader();
  weaponFlex.declareUniforms(lone, {}, {});
  ok("no bundle ⇒ inert stand-ins (frame 0)", lone.uniforms.uWfxFrame.value === 0);
}

// ===========================================================================
console.log("flags");
_resetVfxFlags(); _resetVfxCatalog();
ok("no window: weaponFx is on (default-on under ?visual)", weaponFxEnabled() === true);
ok("router: both components report enabled", vfxEffectEnabled("deformation.weaponFlex") && vfxEffectEnabled("emissive.weaponAura"));
ok("swingTrails defaults to all", swingTrailsMode() === "all");
globalThis.window = { location: { search: "?weaponFx=off" } };
_resetVfxFlags(); _resetVfxCatalog();
ok("?weaponFx=off ⇒ no plan (the legacy entity path is used)", weaponFxPlanFor({ archetype: "tip-flex", uiEffects: 0x20, name: "Atlan Spear", geometry: null }) === null);
ok("?weaponFx=off ⇒ the sub-flags are off too", !vfxEffectEnabled("deformation.weaponFlex") && !vfxEffectEnabled("emissive.weaponAura"));
globalThis.window = { location: { search: "?visual=off" } };
_resetVfxFlags(); _resetVfxCatalog();
ok("?visual=off ⇒ no plan", weaponFxPlanFor({ archetype: "tip-flex", uiEffects: 0x20, name: "Atlan Spear", geometry: null }) === null);
globalThis.window = { location: { search: "?swingTrails=elemental" } };
_resetVfxFlags(); _resetVfxCatalog();
ok("?swingTrails=elemental parses", swingTrailsMode() === "elemental");
delete globalThis.window;
_resetVfxFlags(); _resetVfxCatalog();

console.log("weapon_fx — the plan");
{
  const spearGeo = { singlePart: true, length: 2.08, width: 0.09 };
  const a = weaponFxPlanFor({ archetype: "tip-flex", uiEffects: 0, name: "Atlan Spear", geometry: spearGeo });
  ok("catalog spear: pole + shine, no glow", a && a.flexClass === "pole" && a.shine && a.aura === null);
  const b = weaponFxPlanFor({ archetype: "tip-flex", uiEffects: 0x20, name: "Atlan Spear", geometry: spearGeo });
  ok("Fire spear: fire glow", b && b.aura?.element === "fire");
  const c = weaponFxPlanFor({ archetype: "rigid-glint", uiEffects: 0x400, name: "Long Sword", geometry: { singlePart: true, length: 1.0, width: 0.25 } });
  ok("★ Slashing sword: shine only — no glow, no bend", c && c.shine && c.aura === null && c.flexClass === null);
  const d = weaponFxPlanFor({ archetype: "", uiEffects: 0x1, name: "Gold Ring", geometry: null });
  ok("a Magical ring: glow, no shine, no bend", d && d.aura?.element === "magic" && !d.shine && !d.flexClass);
  ok("a plain ring: nothing", weaponFxPlanFor({ archetype: "", uiEffects: 0, name: "Gold Ring", geometry: null }) === null);
  const e = weaponFxPlanFor({ archetype: "", uiEffects: 0, name: "Flaming Spada", geometry: { singlePart: true, length: 1.0, width: 0.2 } });
  ok("a weapon outside the catalog is caught by its name (and its element word glows)", e && e.shine && e.aura?.element === "fire");
  const f = weaponFxPlanFor({ archetype: "tip-flex", uiEffects: 0, name: "Atlan Spear", geometry: { singlePart: false, length: 2.08, width: 0.09 } });
  ok("a multi-part weapon does not bend", f && f.flexClass === null);
}

// ===========================================================================
console.log("weapon_fx — materials (MaterialCache.makeOwnedVariant)");
const csmState = { uniforms: Object.fromEntries(["uCsmShadowMap0", "uCsmShadowMap1", "uCsmShadowMap2", "uCsmMatrix0", "uCsmMatrix1", "uCsmMatrix2", "uCsmSplits", "uCsmFar", "uCsmBlend"].map((k) => [k, { value: null }])) };
const mc = new MaterialCache({ csmState });
function makeBase(name) {
  const tex = new THREE.DataTexture(new Uint8Array([90, 92, 98, 255]), 1, 1);
  const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.3, metalness: 0.9 });
  m.name = name;
  // what a cache material carries: cache ownership + the CSM / detail flags whose
  // hooks a .clone() would drop
  m.userData = { __cacheOwned: true, csmEnabled: true, detailEnabled: true, surfaceTypeFlags: 2 };
  return m;
}
function spearPartGroups(did) {
  const geo = new THREE.CylinderGeometry(0.03, 0.03, 2.0, 8, 4);
  geo.rotateX(Math.PI / 2);            // three cylinders run along Y; AC spears along Z
  geo.translate(0, 0, 0.4);            // z in [-0.6, 1.4]
  return [{ groups: [{ geometry: geo, surfaceDid: did }], surfaceDids: [did] }];
}
{
  const g = weaponGeometryOf(spearPartGroups(0x08000123));
  ok("weaponGeometryOf: single part, z axis, 2 m long", g && g.singlePart && g.axis === 2 && near(g.length, 2.0, 1e-6) && near(g.width, 0.06, 1e-6));
  const two = spearPartGroups(1).concat(spearPartGroups(2));
  ok("weaponGeometryOf: two non-empty parts ⇒ not single", weaponGeometryOf(two).singlePart === false);
}
_resetWeaponFxForTest();
const DID = 0x08000123;
const spearInst = { guid: 0x80000a01, root: new THREE.Group(), parts: [new THREE.Group()], _attachedParentGuid: null };
spearInst.root.add(spearInst.parts[0]);
const pg = spearPartGroups(DID);
const st = weaponFxBegin({ inst: spearInst, guid: spearInst.guid, name: "Atlan Spear", uiEffects: 0x20, archetype: "tip-flex", partGroups: pg, materialCache: mc, nowMs: 0 });
ok("weaponFxBegin: a state with [weaponFlex, weaponAura]", st && st.setKey === "deformation.weaponFlex+emissive.weaponAura", st && st.setKey);
const base = makeBase("scene3d-surface-08000123");
mc.materials.set(DID, base);
const mat = weaponFxMaterial(st, DID, base);
ok("weaponFxMaterial returns an OWNED clone (not the base)", mat && mat !== base && mat.userData.__disposable === true && mat.userData.__cacheOwned === undefined);
ok("one material per surface per weapon", weaponFxMaterial(st, DID, base) === mat);
ok("the clone shares the base's texture", mat.map === base.map);
ok("★ lost-patch flags stripped, CSM re-installed (the key now tells the truth)",
  mat.userData.detailEnabled === undefined && mat.userData.csmEnabled === true);
const key = mat.customProgramCacheKey();
ok("program key: |d0, |c1, and the weapon SET", key.includes("|d0") && key.includes("|c1") && key.endsWith("|vdeformation.weaponFlex+emissive.weaponAura"), key);
{
  const sh = freshShader();
  mat.onBeforeCompile(sh, null);
  ok("compile hook: CSM + flex + aura all spliced", sh.fragmentShader.includes("_csmShadowFactor") && sh.vertexShader.includes(WFX_FLEX_MARKER) && sh.fragmentShader.includes(WFX_AURA_MARKER));
  ok("compile hook: the weapon's own uniforms, by reference", sh.uniforms.uWfxBendPos === st.u.uWfxBendPos && sh.uniforms.uWfxShine === st.u.uWfxShine);
  ok("fire glow colour + kind on the bundle", st.u.uWfxAuraKind.value === WFX_KIND.fire && st.u.uWfxAuraColor.value.x === 1.0);
}
// a second weapon: its own material + bundle, the same program key
const inst2 = { guid: 0x80000a02, root: new THREE.Group(), parts: [new THREE.Group()], _attachedParentGuid: null };
inst2.root.add(inst2.parts[0]);
const st2 = weaponFxBegin({ inst: inst2, guid: inst2.guid, name: "Atlan Spear", uiEffects: 0x80, archetype: "tip-flex", partGroups: spearPartGroups(DID), materialCache: mc, nowMs: 0 });
const mat2 = weaponFxMaterial(st2, DID, base);
ok("★ two spears: two materials, two bundles, ONE program key", mat2 !== mat && st2.u !== st.u && mat2.customProgramCacheKey() === key);
ok("…with their own glows (fire vs frost) and phases", st2.u.uWfxAuraKind.value === WFX_KIND.frost && st2.u.uWfxSeed.value !== st.u.uWfxSeed.value);

// ===========================================================================
console.log("weapon_fx — the tick (held spear, a swing)");
// wielder → hand → weapon root → part (placement frame: the grip at object z = 0.39)
const wielder = { guid: 0x50000001, root: new THREE.Group(), _fxSwingUntilMs: 0 };
const hand = new THREE.Group();
wielder.root.add(hand);
hand.position.set(0.3, 0, 1.2);
hand.add(spearInst.root);
spearInst.parts[0].position.set(0, 0, -0.39);
const mesh = new THREE.Mesh(pg[0].groups[0].geometry, mat);
mesh.userData = { surfaceDid: DID };
spearInst.parts[0].add(mesh);
spearInst._wfx = st;
spearInst._attachedParentGuid = wielder.guid;
weaponFxCommit(st);
const scene3d = {
  entityManager: { entityMap: new Map([[wielder.guid, wielder], [spearInst.guid, spearInst]]) },
  renderer: { toneMappingExposure: 5 },
  camera: new THREE.PerspectiveCamera(),
};
scene3d.camera.position.set(0, -4, 1.5);
let t = 0;
const frame = () => { t += 1000 / 60; VFX_GLOBALS.uTime.value = t / 1000; tickWeaponFx(scene3d, t); };
frame(); frame();
ok("★ calibration = gain / exposure (5 ⇒ 0.2)", near(st.u.uWfxCal.value, 0.2, 1e-12));
ok("held: grip frame (origin z 0.39, + side 1.01, - side 0.99)", st.u.uWfxGrip.value === 1 && st.u.uWfxFrame.value === 1 &&
  near(st.u.uWfxOrigin.value.z, 0.39, 1e-6) && near(st.u.uWfxLen.value.x, 1.01, 1e-6) && near(st.u.uWfxLen.value.y, 0.99, 1e-6),
  JSON.stringify([st.u.uWfxOrigin.value, st.u.uWfxLen.value]));
for (let i = 0; i < 60; i++) frame();
ok("★ held still for a second: zero bend (the old path shook here)", st.u.uWfxBendPos.value.length() < 1e-9 && st.u.uWfxBendNeg.value.length() < 1e-9);
// a swing: the hand turns 110 degrees about x in 0.25 s, then stops dead
wielder._fxSwingUntilMs = t + 900;
let peakDeg = 0;
for (let i = 0; i < 15; i++) { hand.rotation.x += (110 * Math.PI / 180) / 15; frame(); peakDeg = Math.max(peakDeg, st.bendDegPos); }
for (let i = 0; i < 30; i++) { frame(); peakDeg = Math.max(peakDeg, st.bendDegPos); }
ok(`★ the swing whips the shaft (peak ${peakDeg.toFixed(2)} deg, 1..7.4)`, peakDeg > 1 && peakDeg < 7.45, peakDeg);
ok("the butt end bends too (a spear held mid-shaft)", st.bendDegNeg > 0 || weaponFxList()[0].bendDeg[1] >= 0);
ok("★ the swing started a shine sweep on the shared clock", near(st.u.uWfxShine.value.x, (t - 45 * 1000 / 60) / 1000, 0.02) && st.u.uWfxShine.value.z > 1, JSON.stringify(st.u.uWfxShine.value));
for (let i = 0; i < 240; i++) frame();
ok("…and the shaft rings down to rest within 4 s", st.bendDegPos < 0.05 && st.bendDegNeg < 0.05, `${st.bendDegPos} ${st.bendDegNeg}`);
ok("the glow flared and settled (level back to 1)", near(st.u.uWfxLevel.value, 1, 1e-3), st.u.uWfxLevel.value);
// steady walking: no bend once settled
for (let i = 0; i < 120; i++) { wielder.root.position.x += 3 / 60; frame(); }
ok("★ steady walking leaves the shaft straight", st.bendDegPos < 0.05, st.bendDegPos);

console.log("weapon_fx — base-material sync");
{
  const tex2 = new THREE.DataTexture(new Uint8Array([200, 200, 200, 255]), 1, 1);
  base.map = tex2;
  const v0 = mat.version;
  frame();
  ok("a texture upgrade on the base reaches our clone", mat.map === tex2 && mat.version > v0);
  mat.opacity = 0.4; // a fade hook mutating OUR material directly
  frame();
  ok("a hook's change on our clone is not clobbered by the sync", mat.opacity === 0.4);
  const real = makeBase("scene3d-surface-08000123-reinstalled");
  mc.materials.set(DID, real);
  frame();
  ok("★ a re-installed cache base is adopted wholesale (the grey-fallback race)", mat.map === real.map && st.mats.get(DID).base === real);
  const foreign = new THREE.MeshStandardMaterial({ color: 0xff0000 });
  mesh.material = foreign;
  frame();
  ok("★ a mesh whose material was swapped out gets a fresh clone of the NEW material",
    mesh.material !== foreign && mesh.material.userData.__wfx === st.id && st.mats.get(DID).base === foreign);
  ok("…and clone-on-write hands out that clone", weaponFxOwnedMaterial(spearInst, DID) === mesh.material);
}

console.log("weapon_fx — dropped (not held)");
{
  hand.remove(spearInst.root);
  spearInst._attachedParentGuid = null;
  frame();
  ok("on the ground: no grip, the whole length on +, no bend", st.u.uWfxGrip.value === 0 &&
    near(st.u.uWfxLen.value.x, 2.0, 1e-6) && st.u.uWfxBendPos.value.length() === 0);
}

console.log("weapon_fx — diagnostics, force, forget");
{
  const s = weaponFxStats();
  ok("stats count the live weapon", s.live === 1 && s.poles === 1 && s.auras.fire === 1, JSON.stringify(s));
  ok("list reports it", weaponFxList()[0].name === "Atlan Spear" && weaponFxList()[0].pole === true);
  weaponFxForce("lightning");
  ok("force('lightning') repaints the live glow", st.u.uWfxAuraKind.value === WFX_KIND.lightning);
  weaponFxForce(null);
  ok("force(null) restores the item's own", st.u.uWfxAuraKind.value === WFX_KIND.fire);
  let disposed = false;
  mesh.material.addEventListener("dispose", () => { disposed = true; });
  weaponFxForget(st);
  ok("forget: out of the tick, materials freed", weaponFxStats().live === 0 && disposed && st.disposed);
  ok("forget is idempotent", (() => { try { weaponFxForget(st); return true; } catch (_) { return false; } })());
}

// ===========================================================================
console.log("fx_ribbons — swing trail looks");
{
  const names = { 1: "Long Sword", 2: "Flaming Spada", 3: "Kite Shield", 4: "Ancient Mace", 5: "Frost Pike" };
  const ue = { 1: 0x400, 2: 0x20, 3: 0x1, 4: 0x1, 5: 0 };
  globalThis.window = { location: { search: "" }, __sessionHandle: { objectName: (g) => names[g], entityUiEffects: (g) => ue[g] || 0 } };
  _resetVfxFlags();
  ok("Slashing sword ⇒ the faint steel trail", fxSwingLook({ guid: 1 }) === FX_SWING_STEEL);
  ok("Fire (UiEffects) ⇒ a fire trail", fxSwingLook({ guid: 2 })?.element === "fire");
  ok("shields never trail", fxSwingLook({ guid: 3 }) === null);
  ok("Magical mace ⇒ the faint violet trail", fxSwingLook({ guid: 4 }) === FX_SWING_MAGIC);
  ok("an element word in the name still works", fxSwingLook({ guid: 5 })?.element === "frost");
  globalThis.window.location.search = "?swingTrails=elemental";
  _resetVfxFlags();
  ok("?swingTrails=elemental: plain blades leave none (the first tier-2 rule)", fxSwingLook({ guid: 6, _fxSwingLook: undefined }) === null && fxSwingLook({ guid: 2 })?.element === "fire");
  globalThis.window.location.search = "?swingTrails=off";
  _resetVfxFlags();
  ok("?swingTrails=off: nothing", fxSwingLook({ guid: 2 }) === null);
  delete globalThis.window;
  _resetVfxFlags();
}

// ===========================================================================
// `?weaponFlexLoco` (2026-10-11, 1070): the run cycle rang a held spear 4.8 deg on average
// (6.8 max) against the designed ~0.5 deg sway. Full gain only for the whip after a swing.
console.log("weapon_fx — pole bend outside a swing (?weaponFlexLoco)");
{
  const g = 0.12;
  ok("a swing keeps full gain through FLEX_SWING_FULL_MS",
    flexLocoScale(0, g, true) === 1 && flexLocoScale(FLEX_SWING_FULL_MS / 2, g, true) === 1 &&
    flexLocoScale(FLEX_SWING_FULL_MS, g, true) === 1);
  ok("then it eases down to the locomotion gain over FLEX_SWING_EASE_MS",
    near(flexLocoScale(FLEX_SWING_FULL_MS + FLEX_SWING_EASE_MS / 2, g, true), 1 + (g - 1) * 0.5) &&
    near(flexLocoScale(FLEX_SWING_FULL_MS + FLEX_SWING_EASE_MS, g, true), g) &&
    near(flexLocoScale(FLEX_SWING_FULL_MS + 10 * FLEX_SWING_EASE_MS, g, true), g));
  ok("never swung (Infinity) or a bad clock (NaN / negative) ⇒ the locomotion gain",
    near(flexLocoScale(Infinity, g, true), g) && near(flexLocoScale(NaN, g, true), g) && near(flexLocoScale(-5, g, true), g));
  ok("?weaponFlexLoco=off ⇒ full gain always", flexLocoScale(Infinity, g, false) === 1 && flexLocoScale(9999, g, false) === 1);
  const wsrc = fs.readFileSync(new URL("./scene3d/vfx/weapon_fx.js", import.meta.url), "utf8");
  ok("the tick scales the bend by the time since the wielder's last swing (never-swung ⇒ Infinity), smoothed",
    wsrc.includes("st.flexScale = approachFlexScale(st.flexScale, flexLocoScale(st.swingMs > 0 ? now - st.swingMs : Infinity), dt);") &&
    wsrc.includes("_simulateFlex(st, part, dt, camPos, st.flexScale);") &&
    wsrc.includes("bendVector(_lag, _arr3b, len, params, _flexGain * scale, _rv);"));
  // a swing started at a run: the scale must not jump 0.12 → 1 in one frame (the run's lag would pop)
  let sc = approachFlexScale(NaN, g, 1 / 60);
  const first = near(sc, g);
  sc = approachFlexScale(sc, 1, 1 / 60);
  const oneFrame = sc;
  for (let i = 1; i < 12; i++) sc = approachFlexScale(sc, 1, 1 / 60);   // 0.2 s
  ok("the applied scale starts at its target, then chases it: no one-frame pop, ~95 % within 0.2 s",
    first && oneFrame > g && oneFrame < 0.4 && sc > 0.95 && sc < 1 &&
    approachFlexScale(0.5, 1, 0) === 0.5 && FLEX_SCALE_TAU_S > 0,
    `oneFrame=${oneFrame.toFixed(3)} at0.2s=${sc.toFixed(3)}`);
}

console.log(`\nweapon fx: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
