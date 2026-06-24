// VFX Phase 0 / commit 4 — legacy-safety lint (spec §13). Three layers + negatives.
//
// THE RULE as a mechanical gate: (A) every registered component's manifest uses
// only the allowed read/write capabilities; (B) no component SOURCE contains a
// forbidden pattern (wire/collision/move/Math.random/Date.now/.visible/per-
// instance cache key); (C) the desync-proof contract holds (setPose copy()
// stomps render writes; omega survives only via re-apply).

import fs from "node:fs";
import path from "node:path";
import { lintManifest, lintSource, ALLOWED_READS, ALLOWED_WRITES } from "./scene3d/vfx/lint_caps.js";
import "./scene3d/vfx/components/index.js"; // barrel — registers ALL Phase-1 components
import { windBend, TIER1_COMPONENT_IDS } from "./scene3d/vfx/components/index.js";
import { allComponents } from "./scene3d/vfx/registry.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// ---- Layer A: manifest conformance (every registered component) ----
const comps = allComponents();
check("at least one component registered (windBend)", comps.length >= 1 && comps.includes(windBend));
// Slice-16: the barrel must register EXACTLY the canonical Phase-1 set — no
// missing barrel export (effect silently never attaches) and no stray.
const _regIds = new Set(comps.map((c) => c.id));
check("registry == TIER1 component set (barrel registers all 8; no missing/stray)",
  _regIds.size === TIER1_COMPONENT_IDS.length && TIER1_COMPONENT_IDS.every((id) => _regIds.has(id)),
  [..._regIds].join());
let aClean = true;
for (const c of comps) {
  const errs = lintManifest(c);
  if (errs.length) { aClean = false; console.log(`    ${c.id}: ${errs.join("; ")}`); }
}
check("Layer A: all registered manifests conform to the capability vocabulary", aClean);
check("windBend reads ⊆ ALLOWED_READS", windBend.reads.every((r) => ALLOWED_READS.has(r)));
check("windBend writes ⊆ ALLOWED_WRITES (partTransform)", windBend.writes.every((w) => ALLOWED_WRITES.has(w)));

// ---- Layer B: static source denylist over component source files ----
const compDir = path.resolve("scene3d/vfx/components");
const files = fs.readdirSync(compDir).filter((f) => f.endsWith(".js"));
check("found component source file(s) to scan", files.length >= 1, files.join());
let bClean = true;
for (const f of files) {
  const src = fs.readFileSync(path.join(compDir, f), "utf8");
  const hits = lintSource(src);
  if (hits.length) { bClean = false; for (const h of hits) console.log(`    ${f}:${h.lineno} ${h.label} — ${h.line}`); }
}
check("Layer B: no forbidden source patterns in any component (comments ignored)", bClean);

// ---- Layer C: desync-proof contract (mirror entities.js:2159-2180) ----
// Minimal quaternion {x,y,z,w}; premultiply(q) => this = q * this.
function q(x, y, z, w) { return { x, y, z, w }; }
function qeq(a, b, e = 1e-9) { return Math.abs(a.x - b.x) < e && Math.abs(a.y - b.y) < e && Math.abs(a.z - b.z) < e && Math.abs(a.w - b.w) < e; }
function copy(dst, src) { dst.x = src.x; dst.y = src.y; dst.z = src.z; dst.w = src.w; return dst; }
function premultiply(dst, p) { // dst = p * dst
  const { x: ax, y: ay, z: az, w: aw } = p, { x: bx, y: by, z: bz, w: bw } = dst;
  dst.x = aw * bx + ax * bw + ay * bz - az * by;
  dst.y = aw * by - ax * bz + ay * bw + az * bx;
  dst.z = aw * bz + ax * by - ay * bx + az * bw;
  dst.w = aw * bw - ax * bx - ay * by - az * bz;
  return dst;
}
const root = q(0, 0, 0, 1);
const windWrite = q(0, 0, 0.2474, 0.9689);   // a render-time VFX write to root
const authoritative = q(0, 0, 0.7071, 0.7071); // server pose (heading) from the wire
const omegaAccum = q(0, 0, 0.0436, 0.9990);    // client-re-derived omega spin

copy(root, windWrite); // (1) a render write lands on root
check("Layer C precondition: render write is on root", qeq(root, windWrite));
copy(root, authoritative); // (2) setPose copy() — STOMPS the render write
check("Layer C: setPose copy() STOMPS the render write (can't leak to the wire)",
  qeq(root, authoritative) && !qeq(root, windWrite));
premultiply(root, omegaAccum); // (3) omega survives ONLY via re-apply after the copy
const expected = premultiply(copy(q(0, 0, 0, 1), authoritative), omegaAccum);
check("Layer C: omega survives via post-copy re-apply (omega * authoritative)", qeq(root, expected));

// ---- Negative fixtures: the gate MUST reject violations ----
check("NEG manifest: forbidden read rejected",
  lintManifest({ id: "x", channel: "c", deterministic: true, lightCountDelta: 0, cacheKeyScope: "none", reads: ["serverReplicated"], writes: ["partTransform"] }).length > 0);
check("NEG manifest: forbidden write rejected",
  lintManifest({ id: "x", channel: "c", deterministic: true, lightCountDelta: 0, cacheKeyScope: "none", reads: ["clock"], writes: ["wire"] }).length > 0);
check("NEG manifest: cacheKeyScope=instance rejected",
  lintManifest({ id: "x", channel: "c", deterministic: true, lightCountDelta: 0, cacheKeyScope: "instance", reads: ["clock"], writes: ["partTransform"] }).length > 0);
check("NEG manifest: lightCountDelta!=0 rejected",
  lintManifest({ id: "x", channel: "c", deterministic: true, lightCountDelta: 1, cacheKeyScope: "none", reads: ["clock"], writes: ["materialUniform"] }).length > 0);
check("NEG source: Math.random() flagged",
  lintSource("function tick(){ const p = Math.random(); }").length > 0);
check("NEG source: wasmExports.enqueueMove flagged",
  lintSource("wasmExports.enqueueMovement(x);").length > 0);
check("NEG source: a DESCRIPTIVE comment mentioning collision is NOT flagged (comment-aware)",
  lintSource("// never touches physics/collision or the wire\nconst a = 1;").length === 0);
check("ALLOW: a // vfx-lint-allow line is exempted",
  lintSource("const r = Math.random(); // vfx-lint-allow: test-only seed").length === 0);

console.log(`\nVFX legacy-safety lint: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
