#!/usr/bin/env bash
# ci-smoke.sh — executable wiring for ci-smoke.md (net-review-20260709 A16 artifact 5).
# S0 always (~1s, no boot). --full adds the boot chain (needs serve.py :8765 + ACE :9000):
#   S1 boot-to-in-world + S2 console.error==0 + S3 whiteNow==0  (one detector boot, 90s Holtburg)
#   S4 keepalive survival                                        (one short second boot, 60s idle)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOLT="$(cd "$HERE/../.." && pwd)"
WASM="$HOLT/apps/holtburger-web/pkg/holtburger_web_bg.wasm"
FULL="${1:-}"
FAIL=0

# ── S0: wasm size + staleness (A15-F1/F2) ──
if [ -f "$WASM" ]; then
  SZ=$(stat -c%s "$WASM"); MT=$(stat -c%Y "$WASM")
  LAST_RUST=$(git -C "$HOLT" log -1 --format=%ct -- apps/holtburger-web/src crates ":(exclude)crates/*/examples/*" 2>/dev/null || echo 0)
  S0="PASS"
  [ "$SZ" -ge 6000000 ] && { S0="FAIL-dev-sized"; FAIL=1; }
  if [ "$LAST_RUST" -gt 0 ] && [ "$MT" -lt "$LAST_RUST" ]; then S0="WARN-stale-predates-rust-commit"; fi
  echo "S0 wasm=${SZ}B mtime=$(date -u -d "@$MT" +%FT%TZ) lastRustCommit=$(date -u -d "@$LAST_RUST" +%FT%TZ) => $S0"
else
  echo "S0 => FAIL no pkg wasm at $WASM (pkg/ is gitignored — rebuild: wasm-pack build --target web --out-dir pkg --release)"
  S0="FAIL-missing"; FAIL=1
fi

# ── L1+L2: static lints (fast, no boot — A16 art.5 fold-in, 2026-07-10) ──
# L1 runs --strict: the 78-row docs backfill landed, so any new undocumented
# flag reader is a regression from here on (the W3 ratchet).
if node "$HOLT/scripts/lint-url-flags.mjs" --strict > /dev/null 2>&1; then L1="PASS"; else L1="FAIL"; FAIL=1; fi
if node "$HERE/lint-wire-codec.mjs" > /dev/null 2>&1; then L2="PASS"; else L2="FAIL"; FAIL=1; fi
# L3 (A10 G1, 2026-07-11 s13): harness-param tripwire — every URL key the
# drivers emit must have a client reader (JS .get / wasm parse / docs row).
# Would have caught the dead kick-dance param.
if node "$HOLT/scripts/lint-harness-params.mjs" > /dev/null 2>&1; then L3="PASS"; else L3="FAIL"; FAIL=1; fi
echo "L1 url-flag lint (--strict) => $L1"
echo "L2 wire-codec lint => $L2"
echo "L3 harness-param lint => $L3"

if [ "$FULL" != "--full" ]; then
  echo "CI-SMOKE: wasm=$S0 flaglint=$L1 codeclint=$L2 harnesslint=$L3 (static only; pass --full for S1–S5 boot chain)"
  exit "$FAIL"
fi

# ── S1+S2+S3: one detector boot, 90s idle at Holtburg ──
TMP="$(mktemp -d)"
node "$HERE/white-texture-detector.mjs" --duration 90 --telepoi "Holtburg" \
  --out "$TMP/detector.json" > "$TMP/detector.log" 2>&1
DET_RC=$?
SUMMARY_LINE="$(grep 'WHITE-TEX SUMMARY' "$TMP/detector.log" || echo 'WHITE-TEX SUMMARY: MISSING')"
if grep -q 'SKIP boot-stalled' "$TMP/detector.log"; then
  S1="FAIL-boot"; S2="SKIP"; S3="SKIP"; FAIL=1
else
  S1="PASS"
  ERRS=$(node -e 'try{const d=require(process.argv[1]);console.log(d.consoleErrorCount??"?")}catch{console.log("?")}' "$TMP/detector.json" 2>/dev/null || echo "?")
  if [ "$ERRS" = "0" ]; then S2="PASS"; else S2="FAIL($ERRS)"; FAIL=1; fi
  if [ "$DET_RC" -eq 0 ]; then S3="PASS"; else S3="FAIL-whiteNow>0"; FAIL=1; fi
fi

# ACE ghost-session window: a boot ~60s after the previous session's close
# reliably stalls at enter-world (reconfirmed 2026-07-10); 130s is the proven
# safe spacing for serial headless boots on the same account.
sleep 130

# ── S4+S5: keepalive survival + dat-decode diag (second short boot, 60s idle) ──
# S5 (A16 art.5 / A07 §3.6, 2026-07-10): __diag.datDecode() ABI liveness on the
# SAME session — main-thread wasm counters non-null, bake-worker relay non-null
# (a silent main-thread fallback FAILS here by design), zero parse/decode
# failures, and the JS missingSurfaces twin empty.
S45="$(node --input-type=module -e '
const BOOT = process.env.BOOT_MJS || process.argv[1];
const boot = await import("file://" + BOOT);
const { page, helpers, inWorld, inWorldMs } = await boot.launchAndEnter({ query: { nosw: "1" }, timeoutMs: 90000 });
// G4 (A10, 2026-07-11 s13): boot wall-clock to in-world (null on stall).
console.log("BOOT=" + (inWorldMs == null ? -1 : inWorldMs));
if (!inWorld) { console.log("S4=FAIL-boot"); console.log("S5=SKIP"); await helpers.close(); process.exit(0); }
await page.waitForTimeout(60000);
const pumpAge = await helpers.evalInPage(() => window.__lastPumpMs != null ? performance.now() - window.__lastPumpMs : null);
const pose = await helpers.evalInPage(() => { try { return !!window.__sessionHandle.getLocalPlayerPose(); } catch { return false; } });
const bad = helpers.consoleErrors().filter(e => /timeout|disconnect|closed/i.test(e.text)).length;
console.log("S4=" + ((bad === 0 && pose && pumpAge != null && pumpAge < 2000) ? "PASS" : `FAIL(pumpAge=${pumpAge} pose=${pose} errs=${bad})`));
const dd = await helpers.evalInPage(async () => {
  try {
    if (typeof window.__diag?.datDecode !== "function") return { err: "no __diag.datDecode" };
    const r = await window.__diag.datDecode();
    return { main: r.main, worker: r.worker, workerNull: r.worker == null, jsMissing: (r.jsMissing ?? []).length };
  } catch (e) { return { err: String(e) }; }
});
if (dd?.err) console.log(`S5=FAIL(${dd.err})`);
else if (dd.main == null) console.log("S5=FAIL(main-diag-null — stale pkg?)");
else if (dd.workerNull) console.log("S5=FAIL(worker-diag-null — bake worker on main-thread fallback?)");
else if (dd.main.parseFail > 0 || dd.main.decodeFail > 0 || dd.jsMissing > 0) console.log(`S5=FAIL(parseFail=${dd.main.parseFail} decodeFail=${dd.main.decodeFail} jsMissing=${dd.jsMissing})`);
else console.log(`S5=PASS(negCacheSize=${dd.main.negCacheSize} misses=${dd.main.decodeMissesTotal})`);
// S5b (A10 G2/G3 + 5b canary, S14): decode-once amp, heightmap batch shape,
// wasm linear-memory report — BOTH wasm instances. Auto-SKIP on a legacy pkg
// (fields absent). Small-sample guards: amp needs ≥20 decodes, hist ≥8 calls.
if (dd?.main || dd?.worker) {
  const AMP_MAX = 1.15, SOLO_MAX = 0.25;
  const judge = (side) => {
    if (!side || side.surfaceDecodeTotal == null) return null; // legacy pkg
    const total = side.surfaceDecodeTotal, dids = side.surfaceDecodeDids;
    const amp = total >= 20 && dids > 0 ? total / dids : null;
    // LB-WEIGHTED solo share (not call-weighted): a healthy boot shape of
    // 1-solo-current-LB + one 8-LB ring batch is 1/9 LBs solo (0.11),
    // while the pre-A4 9-solo storm is 9/9 (1.0). Call-weighting read
    // the healthy shape as 50% solo (first S5b run).
    const hist = side.hmBatchHist ?? [];
    const lbs = hist.reduce((a, [n, c]) => a + n * c, 0);
    const soloLbs = hist.filter(([n]) => n === 1).reduce((a, [, c]) => a + c, 0);
    const soloShare = lbs >= 16 ? soloLbs / lbs : null;
    return { amp, soloShare, memMb: side.wasmMemoryBytes != null ? Math.round(side.wasmMemoryBytes / 1048576) : -1,
             hits: side.surfaceCacheHits, misses: side.surfaceCacheMisses };
  };
  const m = judge(dd.main), w = judge(dd.worker);
  if (!m && !w) console.log("S5b=SKIP(legacy-pkg — no G2/G3 fields)");
  else {
    const bad = [];
    for (const [tag, j] of [["main", m], ["worker", w]]) {
      if (!j) continue;
      if (j.amp != null && j.amp > AMP_MAX) bad.push(`${tag}Amp=${j.amp.toFixed(2)}>${AMP_MAX}`);
      if (j.soloShare != null && j.soloShare > SOLO_MAX) bad.push(`${tag}Solo=${j.soloShare.toFixed(2)}>${SOLO_MAX}`);
    }
    const fmt = (tag, j) => j ? `${tag}[amp=${j.amp == null ? "n/a" : j.amp.toFixed(2)} solo=${j.soloShare == null ? "n/a" : j.soloShare.toFixed(2)} cache=${j.hits}/${j.hits + j.misses} mem=${j.memMb}MB]` : `${tag}[legacy]`;
    console.log((bad.length ? `S5b=FAIL(${bad.join(" ")}) ` : "S5b=PASS ") + fmt("main", m) + " " + fmt("worker", w));
  }
}
await helpers.close();
' "$HOLT/apps/holtburger-web/harness/lib/boot.mjs" 2>/dev/null)"
S4="$(printf '%s\n' "$S45" | sed -n 's/^S4=//p' | tail -1)"; S4="${S4:-FAIL-no-output}"
S5="$(printf '%s\n' "$S45" | sed -n 's/^S5=//p' | tail -1)"; S5="${S5:-FAIL-no-output}"
# S5b (S14): decode-once + batch-shape canaries; SKIP-tolerant (legacy pkg /
# boot-stall path emits nothing → treated as SKIP, mirroring S5's SKIP arm).
S5B="$(printf '%s\n' "$S45" | sed -n 's/^S5b=//p' | tail -1)"; S5B="${S5B:-SKIP}"
case "$S4" in PASS) ;; *) FAIL=1 ;; esac
case "$S5" in PASS*) ;; SKIP) ;; *) FAIL=1 ;; esac
case "$S5B" in PASS*|SKIP*) ;; *) FAIL=1 ;; esac
echo "S5b => $S5B"

# G4 (A10, 2026-07-11 s13): boot-time budget. WARN-only (never FAIL) when the
# in-world wall-clock exceeds CI_BOOT_BUDGET_MS, if that env is set.
BOOT_MS="$(printf '%s\n' "$S45" | sed -n 's/^BOOT=//p' | tail -1)"
if [ -n "$BOOT_MS" ] && [ "$BOOT_MS" != "-1" ]; then
  BOOT_STATUS="boot=PASS(${BOOT_MS}ms)"
  if [ -n "${CI_BOOT_BUDGET_MS:-}" ] && [ "$BOOT_MS" -gt "$CI_BOOT_BUDGET_MS" ]; then
    BOOT_STATUS="boot=WARN(${BOOT_MS}ms>budget ${CI_BOOT_BUDGET_MS}ms)"
  fi
else
  BOOT_STATUS="boot=FAIL-no-inWorldMs"
fi
echo "$BOOT_STATUS"

# ── S6: warm-park functional round-trip (third boot; W4 §3.1 default-ON
# gate, wired 2026-07-10 session 6). Parks the TN backlog, keeps marks,
# unparks + re-attaches on return, 0 non-benign errors. The probe's
# noDisposeStorm threshold is back to the strict +5 (session 7: the
# TN-transition park↔unpark storm is fixed — see the probe's note).
sleep 130
if node "$HERE/warmpark-roundtrip-probe.mjs" > "$TMP/warmpark.log" 2>&1; then
  S6="PASS"
else
  S6="FAIL($(grep -o 'WARMPARK SUMMARY: [A-Z]*' "$TMP/warmpark.log" | tail -1 || echo no-summary))"
  FAIL=1
fi

echo "$SUMMARY_LINE"
echo "CI-SMOKE: wasm=$S0 flaglint=$L1 codeclint=$L2 harnesslint=$L3 boot=$S1 errors=$S2 white=$S3 keepalive=$S4 datDecode=$S5 canaries=$S5B warmpark=$S6 ${BOOT_STATUS}  (details: $TMP)"
exit "$FAIL"
