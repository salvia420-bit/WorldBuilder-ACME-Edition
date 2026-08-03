// VFX emissive SET composition — install guards + the vVfxHash declaration
// hazard (2026-08-03, review findings #6 and #7).
//
// #7 THE HAZARD. `emissive.enchantShimmer` and `emissive.glint` patch the SAME
// seam (`#include <emissivemap_fragment>`) and both are family `emissive`, so
// FAMILY_ORDER ties and the id breaks it: enchantShimmer installs FIRST. glint's
// snippet RE-EMITS the seam line, so glint's block lands between the include and
// anything enchantShimmer put after it. When no shared prelude had installed the
// per-instance varying, enchantShimmer declared a LOCAL `float vVfxHash = 0.0;`
// there — which satisfied glint's bare-token probe `/\bvVfxHash\b/`, so glint
// emitted a READ of vVfxHash ABOVE the only declaration of it. That is an
// "undeclared identifier" GLSL compile failure for the whole SET.
//
// #6 THE GUARDS. magicGlow and itemAura were the only two frag components with no
// already-patched guard, so a double install emitted their uniform declarations
// twice = a GLSL redeclaration error.
//
// Both are locked here by COMPILE-ORDER assertions over the composed source, not
// by string presence.

import { glint } from "./scene3d/vfx/components/glint.js";
import { enchantShimmer } from "./scene3d/vfx/components/enchantShimmer.js";
import { magicGlow } from "./scene3d/vfx/components/magicGlow.js";
import { itemAura } from "./scene3d/vfx/components/itemAura.js";
import { ensureVfxHashVarying, VFX_HASH_FRAG_DECL, VFX_HASH_FRAG_FALLBACK_DECL }
  from "./scene3d/vfx/per_instance.js";
import { FAMILY_ORDER } from "./scene3d/vfx/registry.js";

let pass = 0, fail = 0;
const ok = (l, c, x = "") => {
  if (c) { pass++; console.log(`  [OK] ${l}`); }
  else { fail++; console.log(`  [FAIL] ${l} ${x}`); }
};
const count = (hay, needle) => hay.split(needle).length - 1;

/** A three-shaped shader with the seams the emissive family patches. */
function shader() {
  return {
    uniforms: {},
    vertexShader: [
      "#include <common>",
      "void main() {",
      "  #include <begin_vertex>",
      "  gl_Position = vec4(transformed, 1.0);",
      "}",
    ].join("\n"),
    fragmentShader: [
      "#include <common>",
      "void main() {",
      "  vec4 diffuseColor = vec4( diffuse, opacity );",
      "  #include <map_fragment>",
      "  #include <emissivemap_fragment>",
      "}",
    ].join("\n"),
  };
}

/**
 * The order frag_install composes a SET: (FAMILY_ORDER, id). Reproduced rather
 * than hardcoded so the test tracks the real ordering rule.
 */
function setOrder(comps) {
  return [...comps].sort((a, b) => {
    const d = (FAMILY_ORDER[a.family] ?? 99) - (FAMILY_ORDER[b.family] ?? 99);
    return d !== 0 ? d : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

// The single structural rule a GLSL compiler enforces here: every READ of an
// identifier must appear after its DECLARATION.
function declaredBeforeEveryUse(src, decl, ident) {
  const iDecl = src.indexOf(decl);
  if (iDecl < 0) return false;
  // First use of the bare identifier that is not part of the declaration itself.
  const re = new RegExp(`\\b${ident}\\b`, "g");
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index >= iDecl && m.index < iDecl + decl.length) continue; // the decl
    if (m.index < iDecl) return false;                               // a use above it
  }
  return true;
}

// ---------------------------------------------------------------------------
// 1. ★ THE SET WITH NO PRELUDE — the exact configuration that failed to compile.
// ---------------------------------------------------------------------------
{
  const order = setOrder([glint, enchantShimmer]);
  ok("setup: enchantShimmer really does install before glint",
    order[0].id === "emissive.enchantShimmer" && order[1].id === "emissive.glint");

  const s = shader();
  for (const c of order) { c.declareUniforms(s, {}, {}); c.inject(s); }
  const fs = s.fragmentShader;

  ok("★ vVfxHash is DECLARED somewhere in the composed source",
    fs.includes(VFX_HASH_FRAG_DECL) || fs.includes(VFX_HASH_FRAG_FALLBACK_DECL));
  ok("★ COMPILE ORDER: every read of vVfxHash comes AFTER its declaration",
    declaredBeforeEveryUse(fs, VFX_HASH_FRAG_FALLBACK_DECL, "vVfxHash"),
    fs);
  ok("★ the fallback is at GLOBAL scope (before main), not inside main()",
    fs.indexOf(VFX_HASH_FRAG_FALLBACK_DECL) < fs.indexOf("void main() {"));
  ok("vVfxHash is declared exactly ONCE (no redeclaration)",
    count(fs, VFX_HASH_FRAG_FALLBACK_DECL) + count(fs, VFX_HASH_FRAG_DECL) === 1);
  ok("both components actually emitted their work",
    fs.includes("totalEmissiveRadiance *= (1.0 + uEnchantAmp") && fs.includes("VFX_GLINT_BEGIN"));
  ok("glint used the real identifier, not the 0.0 constant, since it IS declared",
    fs.includes("vVfxHash) * 6.2831853") || /_ph = uTime \* 0\.6 \+ \(vVfxHash\)/.test(fs));
}

// ---------------------------------------------------------------------------
// 2. The SAME set WITH the shared prelude — the varying wins, no fallback.
// ---------------------------------------------------------------------------
{
  const s = shader();
  ensureVfxHashVarying(s);                       // what frag_install's prelude does
  for (const c of setOrder([glint, enchantShimmer])) { c.declareUniforms(s, {}, {}); c.inject(s); }
  const fs = s.fragmentShader;
  ok("★ with the prelude: the real VARYING is used and no constant fallback appears",
    fs.includes(VFX_HASH_FRAG_DECL) && !fs.includes(VFX_HASH_FRAG_FALLBACK_DECL));
  ok("★ COMPILE ORDER holds with the varying too",
    declaredBeforeEveryUse(fs, VFX_HASH_FRAG_DECL, "vVfxHash"));
}

// ---------------------------------------------------------------------------
// 3. glint STANDALONE with nothing declaring the hash ⇒ must fall back to 0.0.
// ---------------------------------------------------------------------------
{
  const s = shader();
  glint.declareUniforms(s, {}, {});
  glint.inject(s);
  ok("★ glint alone (no declaration anywhere) degrades to the 0.0 constant",
    !s.fragmentShader.includes("vVfxHash"), "glint referenced an undeclared identifier");
}

// ---------------------------------------------------------------------------
// 4. #6 — the already-patched guards on magicGlow and itemAura.
// ---------------------------------------------------------------------------
for (const [name, comp, decl] of [
  ["magicGlow", magicGlow, "uniform float uGlow;"],
  ["itemAura", itemAura, "uniform float uAuraGlow;"],
]) {
  const s = shader();
  comp.declareUniforms(s, {});
  comp.inject(s);
  comp.inject(s);                    // the double install
  ok(`★ ${name}: double inject declares its uniform exactly ONCE (no GLSL redeclaration)`,
    count(s.fragmentShader, decl) === 1, `count=${count(s.fragmentShader, decl)}`);
  ok(`★ ${name}: double inject emits its accumulate exactly ONCE`,
    count(s.fragmentShader, "totalEmissiveRadiance +=") === 1);
  ok(`${name}: a single inject still works (guard is not over-eager)`,
    s.fragmentShader.includes(decl));
}

// magicGlow + itemAura together must still both land (distinct uniforms).
{
  const s = shader();
  for (const c of setOrder([magicGlow, itemAura])) { c.declareUniforms(s, {}); c.inject(s); }
  ok("magicGlow + itemAura compose: both accumulates present, each declared once",
    count(s.fragmentShader, "uniform float uGlow;") === 1
    && count(s.fragmentShader, "uniform float uAuraGlow;") === 1
    && count(s.fragmentShader, "totalEmissiveRadiance +=") === 2);
}

// ---------------------------------------------------------------------------
// 5. The whole emissive family at once — the realistic worst case.
// ---------------------------------------------------------------------------
{
  const s = shader();
  for (const c of setOrder([glint, enchantShimmer, magicGlow, itemAura])) {
    c.declareUniforms(s, {}, {});
    c.inject(s);
  }
  const fs = s.fragmentShader;
  ok("★ full emissive SET: compile order holds for vVfxHash",
    declaredBeforeEveryUse(fs, VFX_HASH_FRAG_FALLBACK_DECL, "vVfxHash")
      || declaredBeforeEveryUse(fs, VFX_HASH_FRAG_DECL, "vVfxHash"));
  ok("full emissive SET: uTime declared exactly once",
    count(fs, "uniform float uTime;") === 1, `count=${count(fs, "uniform float uTime;")}`);
  for (const d of ["uniform float uGlow;", "uniform float uAuraGlow;",
    "uniform float uGlintStrength;", "uniform float uEnchantAmp;"]) {
    ok(`full emissive SET: ${d} declared exactly once`, count(fs, d) === 1);
  }
}

console.log(`\nVFX emissive SET composition: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
