// test_shader_prewarm.mjs (2026-08-01) — `?shaderPrewarm` / `?linkProbe`.
//
// The claim under test (shader_prewarm.js): three keys shader-program
// variants on the render target bound AT COMPILE TIME (null → tone-mapped
// sRGB canvas variant; non-null → the composer-path variant the world
// actually renders with). With `?shaderPrewarm=on`, every warm site must
// compile WITH the 1×1 HalfFloat warm target bound and restore the previous
// target on every exit path; with the flag absent (or any value but the
// exact string "on") behaviour must be byte-identical legacy.
//
//   PART 1 — flag readers are exact-match opt-ins ("on" only; "1" ≠ on)
//   PART 2 — withWarmTarget bind/restore semantics (mock renderer)
//   PART 3 — guardedCompileAsync compiles while the warm target is bound
//   PART 4 — link probe bucketing (LINK_STATUS vs COMPLETION_STATUS_KHR)
//   PART 5 — wiring + docs source-text checks
//
// Runs under plain node (no GPU): `node test_shader_prewarm.mjs`.

import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`);
  }
}

// Flags are read once at module load from globalThis.location, so each arm
// re-imports the module with a cache-busting query (the world_stream.mjs
// test pattern).

// ── PART 1: exact-match opt-in ──────────────────────────────────────────────
globalThis.location = { search: "?shaderPrewarm=1&linkProbe=true" };
{
  const m = await import("./scene3d/shader_prewarm.js?arm=notOn");
  check("PART1: shaderPrewarm=1 is NOT on (exact-match idiom)", m.SHADER_PREWARM_ON === false);
  check("PART1: linkProbe=true is NOT on (exact-match idiom)", m.LINK_PROBE_ON === false);
}

// ── PART 2 (off half): flag absent → passthrough, no target churn ──────────
globalThis.location = { search: "" };
{
  const m = await import("./scene3d/shader_prewarm.js?arm=off");
  check("PART2: flag absent resolves OFF", m.SHADER_PREWARM_ON === false);
  const calls = [];
  const renderer = {
    getRenderTarget: () => null,
    setRenderTarget: (t) => calls.push(t),
  };
  const out = m.withWarmTarget(renderer, () => "ret");
  check("PART2: OFF — fn return value propagated", out === "ret");
  check("PART2: OFF — setRenderTarget never called", calls.length === 0);
  check("PART2: OFF — installLinkProbe returns null", m.installLinkProbe({ getContext: () => ({ getProgramParameter() {} }) }) === null);
}

// ── PART 2/3/4 (on arm) ────────────────────────────────────────────────────
globalThis.location = { search: "?shaderPrewarm=on&linkProbe=on" };
const sp = await import("./scene3d/shader_prewarm.js");
const bp = await import("./scene3d/bake_prewarm.js");
check("PART2: shaderPrewarm=on resolves ON", sp.SHADER_PREWARM_ON === true);

function mockRenderer() {
  const state = { current: null, calls: [] };
  return {
    state,
    getRenderTarget: () => state.current,
    setRenderTarget(t) {
      state.calls.push(t);
      state.current = t;
    },
  };
}

{
  const r = mockRenderer();
  let seenDuring = "unset";
  const out = sp.withWarmTarget(r, () => {
    seenDuring = r.state.current;
    return 42;
  });
  check("PART2: ON — fn return value propagated", out === 42);
  check(
    "PART2: ON — warm target bound during fn (1×1 named RT)",
    !!seenDuring && seenDuring.texture?.name === "shader-prewarm-warm-target"
  );
  check("PART2: ON — previous target restored after fn", r.state.current === null);
  check("PART2: ON — exactly bind + restore, no extra churn", r.state.calls.length === 2);

  // Same shared target across calls (programs must land in one variant, and
  // the RT must never be disposed while its programs live).
  let second = null;
  sp.withWarmTarget(r, () => {
    second = r.state.current;
  });
  check("PART2: ON — warm target is a shared singleton", second === seenDuring);

  // Throw path: error propagates, target still restored.
  let threw = false;
  try {
    sp.withWarmTarget(r, () => {
      throw new Error("boom");
    });
  } catch (e) {
    threw = e.message === "boom";
  }
  check("PART2: ON — fn throw propagates", threw);
  check("PART2: ON — target restored on the throw path", r.state.current === null);

  // Unusable renderer → plain passthrough, no crash.
  check("PART2: ON — null renderer falls through to fn()", sp.withWarmTarget(null, () => "ok") === "ok");
}

{
  // PART 3: guardedCompileAsync must run renderer.compile UNDER the warm
  // target (the actual wiring the flag exists for).
  const r = mockRenderer();
  let compiledUnder = "unset";
  r.compile = () => {
    compiledUnder = r.state.current;
    return new Set(); // no materials → resolves immediately
  };
  await bp.guardedCompileAsync(r, {}, {}, {});
  check(
    "PART3: guardedCompileAsync compiles with the warm target bound",
    !!compiledUnder && compiledUnder.texture?.name === "shader-prewarm-warm-target"
  );
  check("PART3: guardedCompileAsync restores the previous target", r.state.current === null);

  // Ready-poll still works with a material that reports ready.
  const mat = {};
  const r2 = mockRenderer();
  r2.compile = () => new Set([mat]);
  r2.properties = { get: () => ({ currentProgram: { isReady: () => true } }) };
  let resolved = false;
  await bp.guardedCompileAsync(r2, {}, {}, {}).then(() => {
    resolved = true;
  });
  check("PART3: ready-poll resolves for a linked program", resolved);
}

{
  // PART 4: link probe bucketing on a fake GL context.
  const LINK_STATUS = 0x8b82;
  const COMPLETION = 0x91b1;
  const gl = {
    LINK_STATUS,
    getExtension: (n) => (n === "KHR_parallel_shader_compile" ? { COMPLETION_STATUS_KHR: COMPLETION } : null),
    linkProgram() {},
    getProgramParameter() {
      return true;
    },
  };
  const renderer = { getContext: () => gl };
  const probe = sp.installLinkProbe(renderer);
  check("PART4: probe installs with linkProbe=on", !!probe);
  gl.linkProgram({});
  gl.linkProgram({});
  gl.getProgramParameter({}, LINK_STATUS);
  gl.getProgramParameter({}, COMPLETION);
  gl.getProgramParameter({}, COMPLETION);
  gl.getProgramParameter({}, 0x1234);
  const s = probe.stats;
  check("PART4: linkProgram calls counted", s.linkProgramCalls === 2);
  check("PART4: LINK_STATUS reads bucketed", s.linkStatus.calls === 1);
  check("PART4: COMPLETION_STATUS_KHR reads bucketed", s.completion.calls === 2);
  check("PART4: other pnames bucketed", s.other.calls === 1);
  check("PART4: wrapped getProgramParameter preserves return", gl.getProgramParameter({}, LINK_STATUS) === true);
  check("PART4: summary() reports all buckets", /linkProgram=2 .*LINK_STATUS 2 reads.*COMPLETION_STATUS_KHR 2 reads/.test(probe.summary()));
  probe.reset();
  check("PART4: reset() zeroes stats", probe.stats.linkProgramCalls === 0 && probe.stats.linkStatus.calls === 0);
  check("PART4: install is idempotent per context", sp.installLinkProbe(renderer) === probe);
}

// ── PART 5: wiring + docs ──────────────────────────────────────────────────
{
  const indexJs = readFileSync(joinPath(__dirname, "scene3d", "index.js"), "utf8");
  check(
    "PART5: index.js doCompile routes through withWarmTarget",
    indexJs.includes("withWarmTarget(renderer, () => renderer.compile(scene, camera))")
  );
  check("PART5: index.js installs the link probe after renderer creation", indexJs.includes("installLinkProbe(renderer)"));

  const bpSrc = readFileSync(joinPath(__dirname, "scene3d", "bake_prewarm.js"), "utf8");
  check(
    "PART5: guardedCompileAsync routes through withWarmTarget",
    /materials = withWarmTarget\(renderer, \(\) => renderer\.compile\(object, camera, targetScene\)\)/.test(bpSrc)
  );

  const urlFlags = readFileSync(joinPath(__dirname, "docs", "url-flags.md"), "utf8");
  check("PART5: docs/url-flags.md documents shaderPrewarm", urlFlags.includes("`shaderPrewarm`"));
  check("PART5: docs/url-flags.md documents linkProbe", urlFlags.includes("`linkProbe`"));
}

console.log("");
console.log(`shader_prewarm: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
