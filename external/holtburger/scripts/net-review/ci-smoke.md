# CI smoke — minimal always-run checklist per land (laptop, ~4 min, one boot)

Prereq: `python3 scripts/serve.py` on :8765; local ACE on 127.0.0.1:9000.
All checks JSON-emitting; a land FAILS the smoke if any check fails.

## S0 — wasm size assertion (no boot needed, catches dev-profile ship)
    SZ=$(stat -c%s external/holtburger/apps/holtburger-web/pkg/holtburger_web_bg.wasm)
    [ "$SZ" -lt 6000000 ] && echo "PASS wasm=${SZ}B" || echo "FAIL wasm=${SZ}B (release ~4.25MB; dev ~18MB — check [profile] in Cargo.toml, cross-ref A15)"
    # measured ground truth 2026-07-09: 4,246,409 bytes

## S1 — boot-to-in-world under nullRender (< 90s)
    node -e '
    import("file:///home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/harness/lib/boot.mjs")
    .then(async (boot) => {
      const t0 = Date.now();
      const { helpers, inWorld } = await boot.launchAndEnter({ query: { nosw: "1" }, timeoutMs: 90000 });
      console.log(JSON.stringify({ check: "boot", pass: inWorld, ms: Date.now() - t0 }));
      await helpers.close(); process.exit(inWorld ? 0 : 1);
    });'
  PASS: inWorld true. (SERVER_DOWN → SKIP the land, don't FAIL — boot.mjs contract.)

## S2 — zero console.error, boot + 90s town idle
  Within the same boot as S3 (below): after 90s idle, `helpers.consoleErrors()`
  must be length 0. Known-benign entries: none — an allowlist must be added
  deliberately, not inherited silently.

## S3 — white-material count == 0 after 90s idle in a town
    node white-texture-detector.mjs --duration 90 --telepoi "Holtburg"
  PASS: exit 0 (whiteNow==0 — states no-map-white + map-white-texels +
  emissive-white all zero). Grey `shared-fallback` > 0 after 90s idle is a WARN
  (decode backlog), not a FAIL — track the count trend per land.
  This also provides S2's console-error window (the script reports both).

## S4 — session keepalive survival (60s idle)
  In the same boot: idle 60s, then assert (a) no console error matching
  /timeout|disconnect|closed/i, (b) `window.__lastPumpMs` age < 2000ms,
  (c) `__sessionHandle.getLocalPlayerPose() != null`. Guards the e8e21042
  keepalive fix and the netWorker fallback path staying healthy.

## S5 / S5b — dat-decode ABI + decode-once/mem canaries (same second boot)
  S5: `__diag.datDecode()` liveness — main-thread wasm counters non-null,
  bake-worker relay non-null (a silent main-thread fallback FAILS by design),
  zero parse/decode failures, JS `missingSurfaces` twin empty.
  S5b: decode-once amp (`total/dids` ≤ 1.15), heightmap-batch shape, and
  wasm linear-memory ceilings — BOTH instances. Batch-shape gate (S16
  2026-07-11): soloShare > 0.25 FAILs only when `multiBatch == 0` (NO multi-LB
  ring batch at all = the pre-A4 9-solo N+1 storm). Since the fixedGrid
  default-ON flip, soloShare rises legitimately (fixedGrid drops the redundant
  per-packet ring re-runs, collapsing the batched denominator — solo LB COUNT
  unchanged; batchshape-ab: ON [[1,114],[9,5]]=0.72 vs off [[1,114],[9,238]]=0.05,
  same 114 solo LBs), so the ratio alone is no longer a storm proxy; gating on
  batching-present keeps the N+1 protection without misfiring on the efficient
  shape.
  Auto-SKIP on a legacy pkg (fields absent). The wasm-mem gate (S16
  2026-07-11, docs/1123.md §5.3) FAILs only on egregious runaway —
  **main > 600 MB or worker > 300 MB at smoke time** (one Holtburg boot +
  60s idle; smoke baseline main 382 / worker 104 MB, headroom clear of the
  21-stop soak worker med 180/206 MB). Additive + fail-soft: legacy pkg with
  no `wasmMemoryBytes` (memMb=-1) is skipped, never FAILs.

## S6 — warm-park functional round-trip (third boot)
  Parks the Town Network backlog, keeps marks, unparks + re-attaches on
  return, 0 non-benign errors (W4 §3.1 default-ON gate).

## Cadence & ownership
Run S0 on every commit (1s). Run S1–S6 (`--full`, chained boots, ~8 min) on
every land that touches apps/holtburger-web or crates/holtburger-*. Emit one
line:
    CI-SMOKE: wasm=PASS boot=PASS(42s) errors=0 white=0 keepalive=PASS datDecode=PASS canaries=PASS warmpark=PASS
