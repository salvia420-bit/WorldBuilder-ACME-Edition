// test_shader_logdepth.mjs — the shared log-depth patch (scene3d/shader_logdepth.js)
// and a source scan that keeps every depth-testing custom ShaderMaterial honest.
//
// WHY: the renderer runs `logarithmicDepthBuffer: true`. A bespoke
// ShaderMaterial without the logdepthbuf chunk writes PERSPECTIVE depth into a
// LOG depth buffer — the "invisible blood" / "buildings through terrain" bug
// class. No GPU is needed to catch it: it is visible in the source.
//
//   L1  withLogDepthVertex: declarations before main, writes are the LAST
//       statements of main (after gl_Position), guarded, balanced, idempotent.
//   L2  withLogDepthFragment: gl_FragDepth is the FIRST statement of main.
//   L3  every patched offender GLSL (dirt puffs/haze, snow spindrift, sand
//       streamers, rock pebbles/grit, ground fog) carries the patch through a
//       real THREE.ShaderMaterial, with uniforms passed BY REFERENCE.
//   L4  SCAN: every `new THREE.ShaderMaterial(` / `RawShaderMaterial(` in
//       scene3d/*.js either has depthTest false, carries log-depth handling, or
//       is ALLOWLISTED below with a reason.
//   L5  the portal SEAL fix is gated: `?sealLogDepth=on` opt-in, default OFF.
//
// Run: node test_shader_logdepth.mjs

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as THREE from "three";
import {
  withLogDepth, withLogDepthVertex, withLogDepthFragment, hasLogDepth, LOGDEPTH_GUARD,
} from "./scene3d/shader_logdepth.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENE3D = path.join(HERE, "scene3d");

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  [ok] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name} ${detail}`); }
}

function mainBody(src) {
  const m = /\bvoid\s+main\s*\(\s*\)\s*\{/.exec(src);
  if (!m) return null;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(m.index + m[0].length, i);
  }
  return null;
}
const count = (s, re) => (s.match(re) || []).length;
function guardsBalanced(s) {
  return count(s, /^\s*#if\b/gm) === count(s, /^\s*#endif\b/gm);
}

function checkVertex(label, src) {
  const out = withLogDepthVertex(src);
  const body = mainBody(out);
  const pre = out.slice(0, out.search(/\bvoid\s+main\s*\(/));
  check(`${label}: vertex declares vFragDepth/vIsPerspective before main`,
    /varying float vFragDepth;/.test(pre) && /varying float vIsPerspective;/.test(pre));
  const lastPos = body ? body.lastIndexOf("gl_Position") : -1;
  const write = body ? body.indexOf("vFragDepth = 1.0 + gl_Position.w;") : -1;
  check(`${label}: vertex write comes after the last gl_Position assignment`,
    lastPos >= 0 && write > 0 && body.slice(write).replace(/vFragDepth = 1\.0 \+ gl_Position\.w;/, "").indexOf("gl_Position =") < 0
      && body.lastIndexOf("gl_Position =") < write);
  check(`${label}: vertex inlines isPerspectiveMatrix (no <common> dependency)`,
    body && body.includes("projectionMatrix[2][3] == -1.0") && !/isPerspectiveMatrix\s*\(/.test(out));
  check(`${label}: vertex guards balanced + idempotent`,
    guardsBalanced(out) && withLogDepthVertex(out) === out && out.includes(LOGDEPTH_GUARD));
  return out;
}

function checkFragment(label, src) {
  const out = withLogDepthFragment(src);
  const body = mainBody(out);
  const pre = out.slice(0, out.search(/\bvoid\s+main\s*\(/));
  check(`${label}: fragment declares logDepthBufFC + varyings before main`,
    /uniform float logDepthBufFC;/.test(pre) && /varying float vFragDepth;/.test(pre));
  // First real statement of main is the guarded gl_FragDepth write.
  const firstStmt = body ? body.replace(/^\s*(\/\/[^\n]*\n|\s)*/, "") : "";
  check(`${label}: fragment gl_FragDepth write is the FIRST statement of main`,
    firstStmt.startsWith(LOGDEPTH_GUARD) &&
      /^[^;]*?gl_FragDepth = vIsPerspective == 0\.0 \? gl_FragCoord\.z : log2\( vFragDepth \) \* logDepthBufFC \* 0\.5;/s
        .test(firstStmt.slice(LOGDEPTH_GUARD.length)));
  check(`${label}: fragment guards balanced + idempotent`,
    guardsBalanced(out) && withLogDepthFragment(out) === out);
  check(`${label}: original body survives verbatim`,
    body && body.includes(mainBody(src).trim()));
  return out;
}

// ---------------------------------------------------------------------------
console.log("-- L1/L2 helper on synthetic shaders ---------------------------------");
const V = `precision highp float;
varying vec2 vUv;
float f(float x) { return x * 2.0; } // a { brace in a comment }
void main() {
  vUv = uv;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  if (p.w > 0.0) { p.x += 0.0; }
  gl_Position = p;
}
`;
const F = `precision highp float;
varying vec2 vUv;
void main() {
  if (vUv.x < 0.0) discard;
  gl_FragColor = vec4(1.0);
}
`;
checkVertex("synthetic", V);
checkFragment("synthetic", F);
check("hasLogDepth recognises #include <logdepthbuf_…> and vFragDepth",
  hasLogDepth("#include <logdepthbuf_fragment>") && hasLogDepth("out float vFragDepth;") && !hasLogDepth(V));
let threw = false;
try { withLogDepthVertex("float x;"); } catch (_) { threw = true; }
check("a shader with no main() is a loud error, not a silent no-op", threw);

// ---------------------------------------------------------------------------
console.log("\n-- L3 the patched offenders ---------------------------------------");
const dirt = await import("./scene3d/terrain_dirt.js");
const snow = await import("./scene3d/terrain_snow.js");
const sand = await import("./scene3d/terrain_sand.js");
const rock = await import("./scene3d/terrain_rock.js");
const fog = await import("./scene3d/ground_fog.js");
const PAIRS = [
  ["dirt puff", dirt.DIRT_PUFF_VERTEX_GLSL, dirt.DIRT_PUFF_FRAGMENT_GLSL],
  ["dirt haze", dirt.DIRT_HAZE_VERTEX_GLSL, dirt.DIRT_HAZE_FRAGMENT_GLSL],
  ["snow spindrift", snow.SNOW_SPINDRIFT_VERTEX_GLSL, snow.SNOW_SPINDRIFT_FRAGMENT_GLSL],
  ["sand streamer", sand.SAND_STREAMER_VERTEX_GLSL, sand.SAND_STREAMER_FRAGMENT_GLSL],
  ["rock pebble", rock.ROCK_PEBBLE_VERTEX_GLSL, rock.ROCK_PEBBLE_FRAGMENT_GLSL],
  ["rock grit", rock.ROCK_GRIT_VERTEX_GLSL, rock.ROCK_GRIT_FRAGMENT_GLSL],
  ["ground fog", fog.GROUND_FOG_VERTEX_GLSL, fog.GROUND_FOG_FRAGMENT_GLSL],
];
for (const [label, vs, fs] of PAIRS) {
  check(`${label}: exported GLSL present and still UNPATCHED at the source (patched at material build)`,
    typeof vs === "string" && typeof fs === "string" && !hasLogDepth(vs) && !hasLogDepth(fs));
  check(`${label}: vertex main has no early return (the append-at-end contract)`,
    !/\breturn\b/.test(mainBody(vs) || "return"));
  checkVertex(label, vs);
  checkFragment(label, fs);
}
const uniforms = { uTime: { value: 0 } };
const mat = new THREE.ShaderMaterial(withLogDepth({
  vertexShader: dirt.DIRT_PUFF_VERTEX_GLSL,
  fragmentShader: dirt.DIRT_PUFF_FRAGMENT_GLSL,
  uniforms, depthTest: true, depthWrite: false, transparent: true,
}));
check("a real THREE.ShaderMaterial keeps the uniforms bag BY REFERENCE",
  mat.uniforms === uniforms && mat.depthTest === true && mat.transparent === true);
check("…and carries the patched shaders", hasLogDepth(mat.vertexShader) && hasLogDepth(mat.fragmentShader));

// ---------------------------------------------------------------------------
console.log("\n-- L4 scan scene3d/*.js -------------------------------------------");
// key = "file#n" (n = 1-based index of the ShaderMaterial construction in that
// file). Every entry needs a reason; a stale entry (no such site, or the site
// is now compliant) fails so the list cannot rot.
const ALLOW = {
  "portal_punch.js#1": "SEAL — log-depth gated behind ?sealLogDepth=on (default OFF, needs a real-GPU look); see L5",
  "portal_punch.js#2": "PUNCH — depthFunc Always + constant gl_FragDepth FAR_DEPTH: endpoint-preserving under both encodings",
  "portal_stencil.js#1": "RESET — depthFunc Always + constant gl_FragDepth FAR_DEPTH: endpoint-preserving under both encodings",
  "terrain_batch.js#1": "clones terrain.js's TERRAIN_*_GLSL (glsl.vertexShader/fragmentShader), which carries the hand-rolled chunk",
  "shader_logdepth.js#1": "doc-comment usage example, not a construction",
};
const CTOR = /new\s+THREE\.(Raw)?ShaderMaterial\(/g;
function callText(src, at) {
  const open = src.indexOf("(", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}
function templateOf(src, ident) {
  const m = new RegExp(`(?:const|let|var)\\s+${ident}\\s*=\\s*(?:/\\*[^*]*\\*/\\s*)?\``).exec(src);
  if (!m) return "";
  const end = src.indexOf("`;", m.index + m[0].length);
  return src.slice(m.index, end < 0 ? undefined : end);
}
const seen = new Set();
const files = readdirSync(SCENE3D).filter((f) => f.endsWith(".js")).sort();
for (const f of files) {
  const src = readFileSync(path.join(SCENE3D, f), "utf8");
  let n = 0;
  for (const m of src.matchAll(CTOR)) {
    n++;
    const key = `${f}#${n}`;
    const call = callText(src, m.index);
    const tail = src.slice(m.index, m.index + call.length + 800);
    const depthOff = /depthTest\s*[:=]\s*false/.test(tail);
    const refs = [...call.matchAll(/(?:vertexShader|fragmentShader)\s*:\s*([A-Z_][A-Z0-9_]*)\b/g)].map((r) => r[1]);
    const handled = /withLogDepth\(/.test(call) || hasLogDepth(call) ||
      (refs.length > 0 && refs.every((id) => hasLogDepth(templateOf(src, id))));
    const compliant = depthOff || handled;
    if (ALLOW[key]) {
      seen.add(key);
      check(`${key} allowlisted (${ALLOW[key]}) and not already compliant`, !compliant || f === "shader_logdepth.js");
    } else {
      check(`${key} ${m[1] ? "RawShaderMaterial" : "ShaderMaterial"} is depthTest:false or log-depth aware`
        + (depthOff ? " [depthTest false]" : handled ? " [log-depth]" : ""), compliant,
        "— wrap the params in withLogDepth() from shader_logdepth.js, or allowlist with a reason");
    }
  }
}
for (const key of Object.keys(ALLOW)) {
  check(`allowlist entry ${key} still names a real construction site`, seen.has(key));
}

// ---------------------------------------------------------------------------
console.log("\n-- L5 the SEAL gate -----------------------------------------------");
const punchSrc = readFileSync(path.join(SCENE3D, "portal_punch.js"), "utf8");
check("sealLogDepthEnabled reads ?sealLogDepth with a strict === \"on\" opt-in",
  /get\("sealLogDepth"\)\s*===\s*"on"/.test(punchSrc));
check("makeSealMaterial defaults its logDepth arm from the flag",
  /function makeSealMaterial\(logDepth = sealLogDepthEnabled\(\)\)/.test(punchSrc));
check("the seal routes BOTH stages through the helper only when armed",
  /logDepth \? withLogDepthVertex\(vertexShader\) : vertexShader/.test(punchSrc) &&
  /logDepth \? withLogDepthFragment\(fragmentShader\) : fragmentShader/.test(punchSrc));
const { sealLogDepthEnabled } = await import("./scene3d/portal_punch.js");
check("default OFF with no window (node)", sealLogDepthEnabled() === false);
globalThis.window = { location: { search: "?sealLogDepth=on" } };
check("?sealLogDepth=on arms it", sealLogDepthEnabled() === true);
globalThis.window = { location: { search: "?sealLogDepth=1" } };
check("?sealLogDepth=1 does NOT arm it (strict opt-in)", sealLogDepthEnabled() === false);
delete globalThis.window;
const doc = readFileSync(path.join(HERE, "docs", "url-flags.md"), "utf8");
check("docs/url-flags.md documents sealLogDepth (§2 row + §0 default-OFF row)",
  /^\| `sealLogDepth` \|/m.test(doc) && /^> \| `sealLogDepth` \|/m.test(doc));

console.log(`\nshader logdepth: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
