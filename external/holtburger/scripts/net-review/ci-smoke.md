# CI smoke — minimal always-run checklist per land (laptop, ~4 min, one boot)

Prereq: `python3 scripts/serve.py` on :8765; local ACE on 127.0.0.1:9000.
All checks JSON-emitting; a land FAILS the smoke if any check fails.

## S0 — wasm build-profile assertion (no boot needed, catches dev-profile ship)
    node external/holtburger/apps/holtburger-web/harness/lib/wasm_profile.mjs \
         external/holtburger/apps/holtburger-web/pkg/holtburger_web_bg.wasm
    # -> {"profile":"release","reason":"no name/.debug_* custom section",...}
  PASS: profile `release`. FAIL (`FAIL-dev-wasm`): the module carries a `name`
  or `.debug_*` custom section — wasm-pack `--dev` (or `--profiling`) keeps
  them, `--release` strips them (check [profile] in Cargo.toml, cross-ref A15).
  Read from the module's own custom sections since 2026-10-13
  (test-tooling-8): the old size band (`< 6,000,000 B`, from the 2026-07-09
  ground truth 4,246,409 B) failed every RELEASE build once the crate grew past
  it (7,182,909 B on 2026-10-12, no `name`/`.debug_*` sections), so a real dev
  ship had become indistinguishable. Size is only the fallback when node
  cannot answer: `> 12 MB` = dev (release ~7.2 MB, dev ~16.6 MB today).
  Also WARNs when the wasm predates the last Rust commit (stale pkg/).

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

## S7 — wire integrity, zero undecodable / unknown (same second boot as S4/S5)
    window.__diag.wire.integrity()   // sync; wasm wire_integrity_json(), null on a stale pkg/
    # -> {"messages":N,"totals":{"undecodable":0,"unknown":0,"shortRead":k,"overrun":0},
    #     "undecodable":{},"unknown":{},"shortRead":{"0x0000F745":{"n":..,"bytes":..,"lastLen":..}},"overrun":{}}
  The recv loop classifies every inbound message after `GameMessage::unpack`
  (src/wire_integrity.rs, test-tooling-3 2026-10-13), log-only — dispatch is
  unchanged. Cumulative since load (login + spawn + 60s idle). Keys are the
  top-level opcode, or `0xF7B0_0000 | event type` for a GameEvent.
  PASS: `totals.undecodable == 0` (no message dropped by unpack, no Qualities
  raw wrap whose codegen read failed) AND `totals.unknown == 0` (no opcode /
  GameEvent type missing from `GameOpcode` / `GameEventOpcode`; ACE's senders
  are fully enumerated per s2c-coverage-2026-07-10.md). The deliberate
  `GameMessage::Unknown` wraps (AccountBanned, the 20 Wave-6.A Qualities
  opcodes) are NOT unknown — the classifier keys off the opcode tables, not
  the variant.
  REPORTED, not gated (yet): `shortRead` (bytes a parser left unread — often
  a trailing alignment pad) and `overrun` (cursor past the end), per opcode.
  `unlistedShort` counts short-read keys missing from the script's
  `SHORT_READ_ALLOW` map; add a key there deliberately, with the reason it is
  benign, before turning short reads into a gate.
  SKIP: stale pkg/ (no `wire_integrity_json` export) or a boot stall.
  Zero-GPU protocol bots (`?nullRender=1`) get the same check for free:
  `__diag.wire.integrity().totals`.

## Cadence & ownership
Run S0 on every commit (1s). Run S1–S7 (`--full`, chained boots, ~8 min) on
every land that touches apps/holtburger-web or crates/holtburger-*. Emit one
line:
    CI-SMOKE: wasm=PASS boot=PASS(42s) errors=0 white=0 keepalive=PASS datDecode=PASS canaries=PASS wire=PASS warmpark=PASS
