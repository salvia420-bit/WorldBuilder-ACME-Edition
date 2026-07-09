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

## Cadence & ownership
Run S0 on every commit (1s). Run S1–S4 (one chained boot, ~3.5 min) on every
land that touches apps/holtburger-web or crates/holtburger-*. Emit one line:
    CI-SMOKE: wasm=PASS boot=PASS(42s) errors=0 white=0 greyFallback=3 keepalive=PASS
