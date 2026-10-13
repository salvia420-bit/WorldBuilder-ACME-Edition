// tests/additive_obj_fog.test.mjs
//
// 2026-10-13 lighting-materials-4 (step 1) — Additive OBJECT surfaces draw
// unfogged, `?additiveObjFog` (DEFAULT ON; `off/0/false/no` escape).
//
// Retail D3DPolyRender::SetSurface ends its blend setup with
//   if ( !GetFFFogEnable() || Render::curr_surface_type & 0x10000 )
//     SetFFFogAlphaDisabled(1);                      // acclient.c:454551-454553
// = SetRenderState(D3DRS_FOGENABLE, FALSE) (acclient.c:460295): every surface
// with the Additive bit is drawn with fog OFF. holtburger had the exemption
// only inside the default-OFF `?surfaceParityV2` arm of the unified decoder,
// written when the default path had no scene.fog; `fogLerp` is default-ON now,
// so additive object surfaces were mixed toward fogColor in the ADD term.
//
//   F1  flag parsing (`additiveObjFogExemptEnabled`).
//   F2  the legacy cache ladder (real materials.js `_materialFromFlags`).
//   F3  the unified decoder (real `applySurfaceRenderState`), incl. the
//       `?surfaceParityV2=on` force past the escape.
//   F4  the recoloured/paletted ladder (real entities.js
//       `_applyPalettedSurfaceRenderState`, spliced), both arms.
//   F5  the three decoders agree on `fog` for every flag, both flag states,
//       and nothing but `fog` moves between the default and the escape.
//   F6  wiring.
//
// Fails on the pre-change code: `additiveObjFogExemptEnabled` does not exist,
// and every additive surface keeps `fog === true` by default.
//
// Run: node tests/additive_obj_fog.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { spliceModule } from "../harness/lib/splice_module.mjs";
import { MATERIALS_JS_STUBS } from "../harness/lib/scene3d_stubs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const src = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

const _prevWindow = globalThis.window;
function setSearch(s) {
  globalThis.window = { location: { search: s } };
}
function clearWindow() {
  delete globalThis.window;
}

const M = new Function(
  "THREE",
  spliceModule(src("scene3d/materials.js"), { stubs: MATERIALS_JS_STUBS, label: "scene3d/materials.js" }) +
    "\n; return { MaterialCache, SURFACE_TYPE, applySurfaceRenderState, readSurfaceUnifiedFlag," +
    " applyClipMapRenderState, applyRetailSinglePass, readLuminousEmissiveMapFlag, additiveObjFogExemptEnabled };",
)(THREE);
const F = M.SURFACE_TYPE;

const ENT = src("scene3d/entities.js");
function method(name) {
  const m = new RegExp(`\\n  ${name}\\([^)]*\\) \\{\\n`).exec(ENT);
  if (!m) throw new Error(`entities.js: method ${name} not found`);
  const start = m.index + 1;
  const end = ENT.indexOf("\n  }\n", start);
  return ENT.slice(start, end + 4);
}
const Pal = new Function(
  "THREE", "SURFACE_TYPE", "readSurfaceUnifiedFlag", "applySurfaceRenderState", "applyClipMapRenderState",
  "readLuminousEmissiveMapFlag", "registerLuminousMaterial", "applyRetailSinglePass", "additiveObjFogExemptEnabled",
  `return class {\n${method("_applyPalettedSurfaceRenderState")}\n};`,
)(THREE, F, M.readSurfaceUnifiedFlag, M.applySurfaceRenderState, M.applyClipMapRenderState,
  M.readLuminousEmissiveMapFlag, () => false, M.applyRetailSinglePass, M.additiveObjFogExemptEnabled);
const pal = new Pal();

const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
const cache = new M.MaterialCache();

function viaCache(flags, floats) {
  return cache._materialFromFlags(flags >>> 0, tex, undefined, undefined, undefined, undefined, floats);
}
function viaUnified(flags, floats) {
  const m = new THREE.MeshStandardMaterial({
    map: tex, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide, transparent: false, alphaTest: 0,
  });
  M.applySurfaceRenderState(m, { flags: flags >>> 0, ...(floats || {}) }, { texture: tex });
  return m;
}
function viaPaletted(flags, floats) {
  const m = new THREE.MeshStandardMaterial({
    map: tex, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide, transparent: false,
  });
  pal._applyPalettedSurfaceRenderState(m, { surfaceType: flags >>> 0, ...(floats || {}) });
  return m;
}

const ADDITIVE = [
  ["Additive 0x10000", F.Additive],
  ["Alpha+Additive 0x10100", F.Additive | F.Alpha],
  ["Translucent+Additive 0x10010", F.Additive | F.Translucent],
  ["ClipMap+Additive 0x10004", F.Additive | F.Base1ClipMap],
  ["Base1Image+Additive 0x10002", F.Additive | F.Base1Image],
];
const PLAIN = [
  ["flags 0", 0],
  ["Base1Image 0x2", F.Base1Image],
  ["ClipMap 0x4", F.Base1ClipMap],
  ["Translucent 0x10", F.Translucent],
  ["Alpha 0x100", F.Alpha],
  ["InvAlpha 0x200", F.InvAlpha],
];
const OFF_FORMS = ["off", "0", "false", "no", "OFF", " off "];

// ---------------------------------------------------------------------------
console.log("\n-- F1 flag -----------------------------------------------------");
clearWindow();
check("node default (no window) -> on", M.additiveObjFogExemptEnabled() === true);
setSearch("");
check("absent -> on", M.additiveObjFogExemptEnabled() === true);
setSearch("?additiveObjFog=on");
check("=on -> on", M.additiveObjFogExemptEnabled() === true);
setSearch("?additiveObjFog=maybe");
check("garbage -> on (never a silent off)", M.additiveObjFogExemptEnabled() === true);
check("off / 0 / false / no / OFF / ' off ' -> off", OFF_FORMS.every((v) => {
  setSearch(`?additiveObjFog=${encodeURIComponent(v)}`);
  return M.additiveObjFogExemptEnabled() === false;
}));
globalThis.window = { get location() { throw new Error("boom"); } };
check("a throwing location -> on (default)", M.additiveObjFogExemptEnabled() === true);

// ---------------------------------------------------------------------------
const DECODERS = [["_materialFromFlags", viaCache], ["applySurfaceRenderState", viaUnified],
  ["_applyPalettedSurfaceRenderState", viaPaletted]];
for (const [dname, decode] of DECODERS) {
  console.log(`\n-- ${dname} ${"-".repeat(Math.max(1, 56 - dname.length))}`);
  setSearch("");
  check(`${dname}: premise — node runs the default (non-unified) arm`, M.readSurfaceUnifiedFlag() === false);
  for (const [label, flags] of ADDITIVE) {
    setSearch("");
    const on = decode(flags);
    setSearch("?additiveObjFog=off");
    const off = decode(flags);
    check(`${dname}: ${label} -> fog === false by default`, on.fog === false, `got ${on.fog}`);
    check(`${dname}: ${label} -> fog === true under ?additiveObjFog=off`, off.fog === true, `got ${off.fog}`);
  }
  for (const [label, flags] of PLAIN) {
    setSearch("");
    const on = decode(flags);
    setSearch("?additiveObjFog=off");
    const off = decode(flags);
    check(`${dname}: ${label} (non-additive) keeps fog === true in both`, on.fog === true && off.fog === true,
      `default=${on.fog} escape=${off.fog}`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- F3b unified arm specifics ----------------------------------");
{
  setSearch("?surfaceParityV2=on&additiveObjFog=off");
  check("?surfaceParityV2=on still forces the exemption past the escape",
    viaUnified(F.Additive).fog === false && viaUnified(F.Additive | F.Alpha).fog === false);
  check("...and never exempts a non-additive surface", viaUnified(F.Translucent).fog === true);
  // The paletted ladder delegates to the unified decoder under ?surfaceUnified=on.
  setSearch("?surfaceUnified=on");
  check("paletted ladder under ?surfaceUnified=on (delegate arm): Additive -> fog false",
    viaPaletted(F.Additive).fog === false && viaPaletted(F.Additive | F.Alpha).fog === false);
  check("cache ladder under ?surfaceUnified=on (delegate arm): Additive -> fog false",
    viaCache(F.Additive).fog === false);
  setSearch("?surfaceUnified=on&additiveObjFog=off");
  check("...both delegate arms honour the escape",
    viaPaletted(F.Additive).fog === true && viaCache(F.Additive).fog === true);
}

// ---------------------------------------------------------------------------
console.log("\n-- F5 cross-decoder agreement + nothing else moves --------------");
{
  const PROPS = ["transparent", "depthWrite", "blending", "blendSrc", "blendDst", "blendEquation",
    "opacity", "alphaTest", "side"];
  const FLOATS = [undefined, { translucency: 0.4 }, { luminosity: 0.5 }, { diffuse: 0.6 }];
  let agreeFails = 0, stableFails = 0, n = 0;
  for (const [, flags] of [...ADDITIVE, ...PLAIN]) {
    for (const floats of FLOATS) {
      for (const search of ["", "?additiveObjFog=off"]) {
        setSearch(search);
        const a = viaCache(flags, floats), b = viaUnified(flags, floats), c = viaPaletted(flags, floats);
        n++;
        if (!(a.fog === b.fog && b.fog === c.fog)) {
          agreeFails++;
          console.log(`    disagree flags=0x${(flags >>> 0).toString(16)} search=${search}: ${a.fog}/${b.fog}/${c.fog}`);
        }
      }
      // Default vs escape: only `fog` may differ, per decoder.
      for (const [, decode] of DECODERS) {
        setSearch("");
        const on = decode(flags, floats);
        setSearch("?additiveObjFog=off");
        const off = decode(flags, floats);
        const moved = PROPS.filter((k) => on[k] !== off[k]);
        if (on.emissive.getHex() !== off.emissive.getHex() || on.emissiveIntensity !== off.emissiveIntensity) moved.push("emissive");
        if (on.color.getHex() !== off.color.getHex()) moved.push("color");
        if (moved.length) {
          stableFails++;
          console.log(`    moved flags=0x${(flags >>> 0).toString(16)}: ${moved.join(",")}`);
        }
      }
    }
  }
  check(`the three decoders agree on fog (${n - agreeFails}/${n})`, agreeFails === 0);
  check("default vs ?additiveObjFog=off changes nothing but fog (blend/depth/opacity/alphaTest/emissive/color)",
    stableFails === 0, `${stableFails} case(s) moved`);
  setSearch("");
  const add = viaCache(F.Additive), alphaAdd = viaCache(F.Additive | F.Alpha);
  check("blend state untouched: pure Additive stays AdditiveBlending, depthWrite off",
    add.blending === THREE.AdditiveBlending && add.depthWrite === false && add.transparent === true);
  check("blend state untouched: Alpha+Additive stays CustomBlending SRCALPHA/ONE",
    alphaAdd.blending === THREE.CustomBlending && alphaAdd.blendSrc === THREE.SrcAlphaFactor &&
      alphaAdd.blendDst === THREE.OneFactor);
}

// ---------------------------------------------------------------------------
console.log("\n-- F6 wiring --------------------------------------------------");
{
  const MAT = src("scene3d/materials.js");
  check("materials.js exports additiveObjFogExemptEnabled",
    /export function additiveObjFogExemptEnabled\(\)/.test(MAT));
  check("the parityV2-only fog line is gone",
    !/if \(parityV2 && isAdditive\) mat\.fog = false;/.test(MAT));
  check("applySurfaceRenderState: bit-based, parityV2 OR the default-ON flag",
    /if \(isAdditive && \(parityV2 \|\| additiveObjFogExemptEnabled\(\)\)\) mat\.fog = false;/.test(MAT));
  check("_materialFromFlags: inline ladder sets opts.fog under the flag",
    /if \(!useUnifiedDecoder && isAdditive && additiveObjFogExemptEnabled\(\)\) \{\s*opts\.fog = false;/.test(MAT));
  check("entities.js imports additiveObjFogExemptEnabled from ./materials.js",
    /import \{[^}]*\badditiveObjFogExemptEnabled\b[^}]*\} from "\.\/materials\.js"/.test(ENT));
  check("entities.js paletted ladder tests the bit BEFORE the reader",
    /if \(isAdditive && additiveObjFogExemptEnabled\(\)\) mat\.fog = false;/.test(method("_applyPalettedSurfaceRenderState")));
}

if (_prevWindow === undefined) delete globalThis.window;
else globalThis.window = _prevWindow;

console.log(`\nadditive object fog: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
