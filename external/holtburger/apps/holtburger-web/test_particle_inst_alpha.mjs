// 2026-10-06 — alpha (NormalBlending) particle instancing
// (scene3d/particles/particle_manager.js `?particleInstancingAlpha`).
//
// Run:
//   cd apps/holtburger-web/
//   node test_particle_inst_alpha.mjs

import * as THREE from "three";
import { _configureAlphaBucketMaterial, _sortBucketBackToFront } from "./scene3d/particles/particle_manager.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

console.log("PART 1 — the alpha bucket material");
{
  const base = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.37, alphaTest: 0.1 });
  const m = _configureAlphaBucketMaterial(base.clone());
  check("NormalBlending, transparent", m.blending === THREE.NormalBlending && m.transparent === true);
  check("same alphaTest / depthWrite as the per-mesh alpha branch", m.alphaTest === 0.1 && m.depthWrite === true);
  check("opacity is carried per instance, not on the material", m.opacity === 1);
  check("vertexColors so instanceColor reaches the fragment", m.vertexColors === true);
  check("ONE constant program key for every alpha bucket", m.customProgramCacheKey() === "hbParticleInstAlpha"
    && _configureAlphaBucketMaterial(base.clone()).customProgramCacheKey() === m.customProgramCacheKey());
  const shader = { fragmentShader: "void main(){\n#include <map_fragment>\n#include <color_fragment>\n#include <alphatest_fragment>\n}" };
  m.onBeforeCompile(shader);
  check("<color_fragment> scales ALPHA by vColor.r, rgb untouched",
    /diffuseColor\.a \*= vColor\.r;/.test(shader.fragmentShader) && !/#include <color_fragment>/.test(shader.fragmentShader));
  check("alpha test still runs after the opacity is applied",
    shader.fragmentShader.indexOf("vColor.r") < shader.fragmentShader.indexOf("#include <alphatest_fragment>"));
}

console.log("PART 2 — back-to-front instance sort");
{
  const g = new THREE.PlaneGeometry(1, 1);
  const im = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial(), 8);
  const zs = [5, 1, 9, 3, 7];
  const mm = new THREE.Matrix4(), c = new THREE.Color();
  zs.forEach((z, i) => { im.setMatrixAt(i, mm.makeTranslation(0, 0, z)); im.setColorAt(i, c.setRGB(z / 10, z / 10, z / 10)); });
  _sortBucketBackToFront(im, zs.length, new THREE.Vector3(0, 0, 0));
  const out = [];
  for (let i = 0; i < zs.length; i++) { im.getMatrixAt(i, mm); out.push(mm.elements[14]); }
  check("farthest first", out.join(",") === "9,7,5,3,1", out.join(","));
  const cols = [];
  for (let i = 0; i < zs.length; i++) { im.getColorAt(i, c); cols.push(Math.round(c.r * 10)); }
  check("each instance's colour (its opacity) moves with its matrix", cols.join(",") === "9,7,5,3,1", cols.join(","));
  _sortBucketBackToFront(im, zs.length, new THREE.Vector3(0, 0, 10));
  const out2 = [];
  for (let i = 0; i < zs.length; i++) { im.getMatrixAt(i, mm); out2.push(mm.elements[14]); }
  check("re-sorts for a camera on the other side", out2.join(",") === "1,3,5,7,9", out2.join(","));
  // instances past n are untouched
  im.setMatrixAt(5, mm.makeTranslation(0, 0, 100));
  _sortBucketBackToFront(im, 5, new THREE.Vector3(0, 0, 0));
  im.getMatrixAt(5, mm);
  check("slots past n are not touched", mm.elements[14] === 100);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
