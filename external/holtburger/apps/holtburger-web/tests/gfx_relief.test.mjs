// gfx_relief.test.mjs — geometry-relief flag resolution + the wasm hand-off.
//
// NEW 2026-08-03. `scene3d/gfx_relief.js` had ZERO test coverage despite owning
// a STRICT `=== "on"` reader that url-flags.md:257 holds up as the model the
// twenty `!== "off"` accidents should have followed — nothing was stopping that
// reader from being "helpfully" widened to accept `1`/`true`/`yes`.
//
// The behavioural lock is §4: `applyGfxReliefToWasm`'s missing-config fallback
// was `GFX_RELIEF_FALLBACK`, which is the PRESET-FLAGS bag
// (`{gfxRelief, gfxSubdivLevel, gfxReliefScale}`) — while every read in the
// function is on the RESOLVER's shape (`{enabled, subdivLevel, scale}`). All
// three reads came back `undefined`, so the wasm was handed a NaN amplitude,
// the stale-`pkg/` error was suppressed, and the `applied` telemetry the
// function calls the only headless witness of "wasm took it" was skipped
// entirely (the constant is frozen).
//
// Pure: `resolveGfxRelief` is called with an explicit preset bag throughout, so
// `getQuality()`'s GPU probe never runs.
//
// Run: node tests/gfx_relief.test.mjs   (from apps/holtburger-web/)

const {
  resolveGfxRelief,
  getGfxRelief,
  _resetGfxReliefForTest,
  applyGfxReliefToWasm,
  GFX_RELIEF_FALLBACK,
  GFX_SUBDIV_MIN,
  GFX_SUBDIV_MAX,
  GFX_RELIEF_SCALE_MIN,
  GFX_RELIEF_SCALE_MAX,
} = await import("../scene3d/gfx_relief.js");

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  FAIL:", msg);
  }
}
function section(n) {
  console.log(`\n— ${n}`);
}

/** Run `fn` with console.{warn,error,log} captured. */
function captured(fn) {
  const real = { warn: console.warn, error: console.error, log: console.log };
  const out = { warn: [], error: [], log: [] };
  console.warn = (...a) => out.warn.push(a.join(" "));
  console.error = (...a) => out.error.push(a.join(" "));
  console.log = (...a) => out.log.push(a.join(" "));
  try {
    out.value = fn();
  } finally {
    Object.assign(console, real);
  }
  return out;
}

const PRESET_ON = { gfxRelief: true, gfxSubdivLevel: 1, gfxReliefScale: 1.0 };
const PRESET_OFF = { gfxRelief: false, gfxSubdivLevel: 0, gfxReliefScale: 0.6 };

/* ── 1. the master flag is a STRICT opt-in ────────────────────────────── */
section("master flag (url-flags.md:257 — STRICT `=== \"on\"`)");
{
  ok(resolveGfxRelief("?gfxRelief=on", PRESET_OFF).enabled === true, "?gfxRelief=on enables");
  ok(resolveGfxRelief("?gfxRelief=off", PRESET_ON).enabled === false, "?gfxRelief=off forces off");
  ok(resolveGfxRelief("", PRESET_ON).enabled === true, "absent ⇒ the preset decides (on)");
  ok(resolveGfxRelief("", PRESET_OFF).enabled === false, "absent ⇒ the preset decides (off)");
  ok(resolveGfxRelief("", PRESET_ON).source.enabled === "preset", "…and says so in `source`");

  // The whole point of the strict form: none of these may read as ON, and each
  // must say so out loud rather than looking like a broken Rust decode.
  for (const v of ["1", "true", "yes", "ON", "On", "enabled", ""]) {
    const r = captured(() => resolveGfxRelief(`?gfxRelief=${v}`, PRESET_OFF));
    ok(r.value.enabled === false, `?gfxRelief=${JSON.stringify(v)} is NOT on`);
    ok(r.warn.some((w) => w.includes("[gfxRelief] ignoring")), `…and warns about ${JSON.stringify(v)}`);
  }
  // An unrecognised value must not silently override a preset that says ON.
  const keep = captured(() => resolveGfxRelief("?gfxRelief=true", PRESET_ON));
  ok(keep.value.enabled === true, "an unrecognised value leaves the PRESET value in place");
}

/* ── 2. the numeric knobs ─────────────────────────────────────────────── */
section("subdivLevel / scale");
{
  ok(GFX_SUBDIV_MIN === 0 && GFX_SUBDIV_MAX === 5,
    `the clamp ceiling is 5 — matching src/lib.rs:239 \`subdiv_level.min(5)\` (got ${GFX_SUBDIV_MAX})`);
  const r = (q, p = PRESET_ON) => resolveGfxRelief(`?gfxRelief=on&${q}`, p);
  ok(r("gfxSubdivLevel=2").subdivLevel === 2, "an in-range level is taken from the URL");
  ok(r("gfxSubdivLevel=5").subdivLevel === 5, "level 5 (32 segments/edge) is reachable, not clamped to 2");
  ok(r("gfxSubdivLevel=9").subdivLevel === GFX_SUBDIV_MAX, "an over-range level clamps to the ceiling");
  ok(r("gfxSubdivLevel=-4").subdivLevel === GFX_SUBDIV_MIN, "a negative level clamps to 0");
  // parseInt TRUNCATES before clampInt's Math.round can see the fraction — so
  // 1.6 is 1, not 2. Asserting the real behaviour rather than the one the
  // helper's name suggests; clampInt's rounding only ever sees preset values.
  ok(r("gfxSubdivLevel=1.6").subdivLevel === 1, "a fractional level truncates (parseInt, not parseFloat)");
  ok(r("gfxSubdivLevel=banana").subdivLevel === 1, "junk falls back to the preset");
  ok(r("gfxSubdivLevel=banana").source.subdivLevel === "preset", "…and says so");
  ok(r("").source.subdivLevel === "preset", "an absent level reads the preset");

  ok(r("gfxReliefScale=1.5").scale === 1.5, "an in-range scale is taken from the URL");
  ok(r("gfxReliefScale=99").scale === GFX_RELIEF_SCALE_MAX, "an over-range scale clamps");
  ok(r("gfxReliefScale=-1").scale === GFX_RELIEF_SCALE_MIN, "a negative scale clamps to 0");
  ok(r("gfxReliefScale=0").scale === 0, "scale 0 is a legal value (tessellate but do not displace)");
  ok(r("gfxReliefScale=0").source.scale === "url", "…and is NOT mistaken for absent");

  // Defence in depth: master off ⇒ the wasm is handed zeros regardless.
  const off = resolveGfxRelief("?gfxSubdivLevel=2&gfxReliefScale=2", PRESET_OFF);
  ok(off.enabled === false && off.subdivLevel === 0 && off.scale === 0,
    "master off zeroes BOTH knobs, so a Rust build that forgets `enabled` still cannot displace");
  ok(off.requestedSubdivLevel === 2 && off.requestedScale === 2,
    "…while `requested*` still reports what was asked for");

  // Omitting `presetFlags` does NOT mean "no preset": the resolver calls
  // getQuality() itself, so the quality ladder answers and `source` says so.
  // (The `fallback` arm is only reachable when getQuality throws.)
  const bare = resolveGfxRelief("?gfxRelief=on", null);
  ok(typeof bare.preset === "string" && bare.preset.length > 0,
    `an omitted preset bag falls through to getQuality() (got preset=${bare.preset})`);
  ok(bare.source.subdivLevel === "preset" && bare.source.scale === "preset",
    "…and `source` attributes both knobs to the preset, not to a URL or a fallback");
  ok(bare.subdivLevel >= GFX_SUBDIV_MIN && bare.subdivLevel <= GFX_SUBDIV_MAX,
    "…and whatever the ladder says is still clamped into range");
  ok(GFX_RELIEF_FALLBACK.gfxRelief === false,
    "the last-resort fallback constant is OFF (a preset-less client renders flat, never accidentally on)");
}

/* ── 3. the memo ──────────────────────────────────────────────────────── */
section("memo");
{
  _resetGfxReliefForTest();
  const a = getGfxRelief("?gfxRelief=on", PRESET_OFF);
  const b = getGfxRelief("?gfxRelief=off", PRESET_OFF);
  ok(a === b, "the page, the worker hand-off and __diag all read ONE resolution");
  const c = getGfxRelief("?gfxRelief=off", PRESET_OFF, true);
  ok(c !== a && c.enabled === false, "`force` re-resolves (tests only)");
  _resetGfxReliefForTest();
}

/* ── 4. REGRESSION: the wasm hand-off never sees a NaN ────────────────── */
section("applyGfxReliefToWasm (2026-08-03 regression lock)");
{
  const spy = () => {
    const calls = [];
    return { calls, ns: { set_gfx_relief: (...a) => calls.push(a) } };
  };

  // (a) a missing config must resolve to a RESOLVED-shape off, not to the
  //     preset bag whose keys this function does not read.
  for (const missing of [null, undefined, 0, "", false]) {
    const { calls, ns } = spy();
    const out = captured(() => applyGfxReliefToWasm(ns, missing, "main"));
    ok(out.value === true, `a missing config (${JSON.stringify(missing)}) still applies cleanly`);
    ok(calls.length === 1 && calls[0][0] === false && calls[0][1] === 0,
      "…as an explicit OFF at level 0");
    ok(Number.isFinite(calls[0][2]) && calls[0][2] === 0,
      `…with a FINITE zero amplitude (pre-fix this was NaN — got ${calls[0][2]})`);
    ok(out.error.length === 0, "…and does not cry stale-pkg for a config nobody supplied");
  }

  // (b) the preset bag passed by hand — the exact shape confusion — must also
  //     never reach the wasm as a NaN.
  {
    const { calls, ns } = spy();
    captured(() => applyGfxReliefToWasm(ns, GFX_RELIEF_FALLBACK, "main"));
    ok(Number.isFinite(calls[0][2]), `a preset-shaped config cannot send a NaN amplitude (got ${calls[0][2]})`);
  }

  // (c) a real config is passed through verbatim and stamps its own telemetry.
  {
    const { calls, ns } = spy();
    const cfg = resolveGfxRelief("?gfxRelief=on&gfxSubdivLevel=2&gfxReliefScale=1.25", PRESET_ON);
    captured(() => applyGfxReliefToWasm(ns, cfg, "main"));
    ok(calls[0][0] === true && calls[0][1] === 2 && calls[0][2] === 1.25, "a resolved config reaches the wasm intact");
    ok(cfg.applied.main.ok === true && cfg.applied.main.wasmExportPresent === true,
      "…and `applied` records that the export existed AND took the values");
  }

  // (d) a stale pkg/ soft-degrades, loudly, without throwing.
  {
    const cfg = resolveGfxRelief("?gfxRelief=on", PRESET_ON);
    const out = captured(() => applyGfxReliefToWasm({}, cfg, "main"));
    ok(out.value === false, "a missing `set_gfx_relief` export returns false");
    ok(out.error.some((e) => e.includes("stale pkg/")), "…and says STALE PKG on the console");
    ok(cfg.applied.main.wasmExportPresent === false && cfg.applied.main.ok === false,
      "…and the telemetry distinguishes 'flag on, stale pkg' from 'flag on, took it'");
  }
  // …and stays quiet when relief was off anyway (a stale pkg is then harmless).
  {
    const cfg = resolveGfxRelief("?gfxRelief=off", PRESET_ON);
    const out = captured(() => applyGfxReliefToWasm({}, cfg, "main"));
    ok(out.error.length === 0, "relief off + no export ⇒ nothing to complain about");
  }

  // (e) a throwing wasm must never take the boot down.
  {
    const ns = { set_gfx_relief: () => { throw new Error("wasm exploded"); } };
    const cfg = resolveGfxRelief("?gfxRelief=on", PRESET_ON);
    const out = captured(() => applyGfxReliefToWasm(ns, cfg, "main"));
    ok(out.value === false, "a throwing export returns false rather than propagating");
    ok(cfg.applied.main.ok === false, "…and the telemetry does not claim success");
  }

  // (f) the frozen fallback constant must survive being handed in.
  ok(Object.isFrozen(GFX_RELIEF_FALLBACK), "GFX_RELIEF_FALLBACK is frozen");
  {
    const { ns } = spy();
    captured(() => applyGfxReliefToWasm(ns, GFX_RELIEF_FALLBACK, "bake-worker"));
    ok(GFX_RELIEF_FALLBACK.applied === undefined,
      "…and stamping telemetry onto it is skipped, not thrown (modules are strict-mode)");
  }
}

console.log(`\ngfx_relief: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
