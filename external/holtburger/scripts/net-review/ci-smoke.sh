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
echo "L1 url-flag lint (--strict) => $L1"
echo "L2 wire-codec lint => $L2"

if [ "$FULL" != "--full" ]; then
  echo "CI-SMOKE: wasm=$S0 flaglint=$L1 codeclint=$L2 (static only; pass --full for S1–S5 boot chain)"
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
const { page, helpers, inWorld } = await boot.launchAndEnter({ query: { nosw: "1" }, timeoutMs: 90000 });
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
    return { main: r.main, workerNull: r.worker == null, jsMissing: (r.jsMissing ?? []).length };
  } catch (e) { return { err: String(e) }; }
});
if (dd?.err) console.log(`S5=FAIL(${dd.err})`);
else if (dd.main == null) console.log("S5=FAIL(main-diag-null — stale pkg?)");
else if (dd.workerNull) console.log("S5=FAIL(worker-diag-null — bake worker on main-thread fallback?)");
else if (dd.main.parseFail > 0 || dd.main.decodeFail > 0 || dd.jsMissing > 0) console.log(`S5=FAIL(parseFail=${dd.main.parseFail} decodeFail=${dd.main.decodeFail} jsMissing=${dd.jsMissing})`);
else console.log(`S5=PASS(negCacheSize=${dd.main.negCacheSize} misses=${dd.main.decodeMissesTotal})`);
await helpers.close();
' "$HOLT/apps/holtburger-web/harness/lib/boot.mjs" 2>/dev/null)"
S4="$(printf '%s\n' "$S45" | sed -n 's/^S4=//p' | tail -1)"; S4="${S4:-FAIL-no-output}"
S5="$(printf '%s\n' "$S45" | sed -n 's/^S5=//p' | tail -1)"; S5="${S5:-FAIL-no-output}"
case "$S4" in PASS) ;; *) FAIL=1 ;; esac
case "$S5" in PASS*) ;; SKIP) ;; *) FAIL=1 ;; esac

echo "$SUMMARY_LINE"
echo "CI-SMOKE: wasm=$S0 flaglint=$L1 codeclint=$L2 boot=$S1 errors=$S2 white=$S3 keepalive=$S4 datDecode=$S5  (details: $TMP)"
exit "$FAIL"
