// VFX legacy-safety lint capabilities (Visual-Behavior Suite, spec §13).
//
// Turns THE RULE (§1.2) into a mechanical gate. registry.js already enforces
// Layer A (manifest conformance) at register time; this module provides the
// frozen capability sets + the source-scan denylist so test_vfx_legacy_safety
// can run all three layers (A manifest / B source / C desync-proof) in CI.
//
// THE RULE: a component READS only static/derived inputs + the client clock;
// WRITES only render-time transforms / cloned-material uniforms the server
// neither stores nor replicates; NEVER the wire value, physics/collision, or a
// server-replicated field. Plus: never change light COUNT, never make
// customProgramCacheKey per-instance, never use Math.random/argless Date.now.

// ALLOWED reads (spec §13.1; the registry's READ_CAPS — spec dotted names noted).
export const ALLOWED_READS = Object.freeze(new Set([
  "geometry",         // dat.geometry      (wind_rig.js partBBox)
  "surface",          // dat.surface       (materials.js surface category)
  "setup",            // dat.setupModel
  "weenieProps",      // weenie.props      (offline classifier)
  "serverPose",       // pose.authoritative (read-only inst.root.position/quaternion)
  "instanceHash",     // hash.instance     (wind_rig.js hash01)
  "clock",            // clock.frame       (scene3d.frameTime.tsSec)
  "drawCastSubstate", // client.substate   (draw/cast, §6)
  "weather",          // derived wind/season state (client-side)
]));

// ALLOWED writes (render-time transforms / cloned-material uniforms only).
export const ALLOWED_WRITES = Object.freeze(new Set([
  "renderTransform",  // render.rootTransform (stomped by setPose)
  "partTransform",    // render.partTransform (animated_scenery template)
  "materialUniform",  // material.clonedUniform
  "emitter",          // synthesized particle emitter
  "lightIntensity",   // mech:"light" — render-time .intensity of a POOLED/cloned
                      // light slot ONLY; NEVER .visible or the light COUNT (the
                      // no-relink rule). lightCountDelta must still be 0.
]));

// FORBIDDEN concepts (documentation; enforced because reads/writes must be a
// SUBSET of ALLOWED and FORBIDDEN ∩ ALLOWED = ∅, plus the source scan below).
export const FORBIDDEN_READS = Object.freeze(new Set(["serverReplicated", "otherEntityState", "wireInbound"]));
export const FORBIDDEN_WRITES = Object.freeze(new Set(["wire", "physics", "collision", "replicatedPose", "lightCount"]));

// Layer B — static source denylist (spec §13.3). Code-targeted (not bare words)
// and scanned over COMMENT-STRIPPED source, so descriptive comments don't
// false-positive. A raw line carrying `// vfx-lint-allow: <reason>` is exempted.
export const FORBIDDEN_SOURCE = Object.freeze([
  { re: /wasmExports\.(?:enqueue|send)\w*/, label: "wire/C2S (wasmExports.enqueue*/send*)" },
  { re: /wasmExports\.\w*[Cc]ollision/, label: "physics/collision (wasmExports.*Collision*)" },
  { re: /\.(?:setPosition|moveTo|teleport)\s*\(/, label: "physics move (setPosition/moveTo/teleport)" },
  { re: /Math\.random\s*\(/, label: "non-determinism (Math.random)" },
  { re: /Date\.now\s*\(\s*\)/, label: "non-determinism (argless Date.now)" },
  { re: /\.visible\s*=\s*[^=]/, label: "visibility/light toggle (use intensity=0, never .visible=)" },
  { re: /customProgramCacheKey[\s\S]{0,80}(?:guid|instanceHash|aVfxHash)/, label: "per-instance cache key (shader-link explosion)" },
]);

const LINT_ALLOW = /\/\/\s*vfx-lint-allow:/;

// Blank // line comments + /* */ block comments, preserving newlines/line count,
// so the denylist scans CODE only.
function _blankComments(src) {
  let out = String(src || "").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  return out;
}

/** Layer A — manifest conformance for one component object. Returns errors[]. */
export function lintManifest(c) {
  const errs = [];
  if (!c || typeof c.id !== "string") { errs.push("missing id"); return errs; }
  if (typeof c.channel !== "string") errs.push("missing channel");
  if (c.deterministic !== true) errs.push("deterministic must be true");
  if (c.lightCountDelta !== 0) errs.push("lightCountDelta must be 0 (never change visible light count)");
  if (c.cacheKeyScope !== "set" && c.cacheKeyScope !== "none") {
    errs.push(`cacheKeyScope must be "set"|"none", never "instance"; got ${c.cacheKeyScope}`);
  }
  if (!Array.isArray(c.reads) || c.reads.length === 0) errs.push("reads[] must be non-empty");
  else for (const r of c.reads) if (!ALLOWED_READS.has(r)) errs.push(`read "${r}" not in ALLOWED_READS`);
  if (!Array.isArray(c.writes) || c.writes.length === 0) errs.push("writes[] must be non-empty");
  else for (const w of c.writes) if (!ALLOWED_WRITES.has(w)) errs.push(`write "${w}" not in ALLOWED_WRITES`);
  return errs;
}

/** Layer B — static source denylist scan. Returns hits[] of {label,line,lineno}. */
export function lintSource(sourceText) {
  const raw = String(sourceText || "").split("\n");
  const code = _blankComments(sourceText).split("\n");
  const hits = [];
  for (let i = 0; i < code.length; i++) {
    if (LINT_ALLOW.test(raw[i] || "")) continue; // explicit allow (logged by the test)
    for (const { re, label } of FORBIDDEN_SOURCE) {
      if (re.test(code[i])) hits.push({ label, line: (raw[i] || "").trim(), lineno: i + 1 });
    }
  }
  return hits;
}
