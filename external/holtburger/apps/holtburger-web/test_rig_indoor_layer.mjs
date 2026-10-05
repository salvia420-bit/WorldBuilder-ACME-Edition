// test_rig_indoor_layer.mjs — the invisible-local-rig-in-dungeons fix.
//
// Root cause (2026-10-05): the appearance hot-swap and the ReplaceObject hook
// rebuild part meshes in place; a fresh THREE.Mesh sits on layer 0. Indoors
// the default-on `?indoorDepthSplit` renders layer 0, wipes depth full-screen,
// then renders layer 1 (cells + entities) — so a re-dressed rig (any player
// who equipped anything since login) was overpainted by the room shell. This
// pins the re-stamp at every in-place rebuild site and checks the helper.

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
};

const src = readFileSync(new URL("./scene3d/entities.js", import.meta.url), "utf8");

const fnIdx = src.indexOf("function _stampEntityIndoorLayer(scene3d, obj) {");
check("helper _stampEntityIndoorLayer exists", fnIdx > 0);

function bodyOf(sig) {
  const i = src.indexOf(sig);
  if (i < 0) return "";
  // crude: up to the next method/function header at the same indent
  const rest = src.slice(i + sig.length);
  const end = rest.search(/\n  (?:async )?[_a-zA-Z]+\([^)]*\) \{\n/);
  return end > 0 ? rest.slice(0, end) : rest;
}

const hot = bodyOf("async _applyAppearanceHotSwap(inst, newMeta, guid) {");
check("hot-swap re-stamps the rig after rebuilding parts",
  hot.includes("_stampEntityIndoorLayer(this.scene3d, inst.root);"));
check("hot-swap stamp runs AFTER the part rebuild loop",
  hot.indexOf("_stampEntityIndoorLayer(this.scene3d, inst.root);") >
    hot.indexOf("buildPartSurfaceMeshes(THREE, {"));

const replIdx = src.indexOf("_replaced`;");
const replTail = src.slice(replIdx, replIdx + 1500);
check("ReplaceObject re-stamps the swapped part",
  replIdx > 0 && replTail.includes("_stampEntityIndoorLayer(this.scene3d, partGroup);"));

check("selection ring is stamped",
  src.includes("inst.root.add(ring);\n    _stampEntityIndoorLayer(this.scene3d, ring);"));

// Behavioural check of the helper body (extracted, run against mock nodes).
{
  const start = fnIdx;
  const end = src.indexOf("\n}\n", start) + 2;
  const fnSrc = src.slice(start, end);
  // eslint-disable-next-line no-new-func
  const stamp = new Function(`${fnSrc}; return _stampEntityIndoorLayer;`)();
  const mk = () => ({ layers: { mask: 1, set(n) { this.mask = 1 << n; } } });
  const a = mk(), b = mk(), c = mk();
  const root = { traverse(fn) { for (const n of [a, b, c]) fn(n); } };
  stamp({ entitiesGroup: {} }, root);
  check("helper moves every node to layer 1", [a, b, c].every((n) => n.layers.mask === 2));
  const d = mk();
  stamp(null, { traverse(fn) { fn(d); } });
  check("helper is inert without an entitiesGroup (capture/headless paths)", d.layers.mask === 1);
  let threw = false;
  try { stamp({ entitiesGroup: {} }, null); } catch (_) { threw = true; }
  check("helper tolerates a null node", !threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
