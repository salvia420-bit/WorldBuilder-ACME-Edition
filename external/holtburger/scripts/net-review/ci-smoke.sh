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

if [ "$FULL" != "--full" ]; then
  echo "CI-SMOKE: wasm=$S0 (S0 only; pass --full for S1–S4 boot chain)"
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

# ── S4: keepalive survival (second short boot, 60s idle) ──
S4="$(node --input-type=module -e '
const BOOT = process.env.BOOT_MJS || process.argv[1];
const boot = await import("file://" + BOOT);
const { page, helpers, inWorld } = await boot.launchAndEnter({ query: { nosw: "1" }, timeoutMs: 90000 });
if (!inWorld) { console.log("FAIL-boot"); await helpers.close(); process.exit(0); }
await page.waitForTimeout(60000);
const pumpAge = await helpers.evalInPage(() => window.__lastPumpMs != null ? performance.now() - window.__lastPumpMs : null);
const pose = await helpers.evalInPage(() => { try { return !!window.__sessionHandle.getLocalPlayerPose(); } catch { return false; } });
const bad = helpers.consoleErrors().filter(e => /timeout|disconnect|closed/i.test(e.text)).length;
console.log((bad === 0 && pose && pumpAge != null && pumpAge < 2000) ? "PASS" : `FAIL(pumpAge=${pumpAge} pose=${pose} errs=${bad})`);
await helpers.close();
' "$HOLT/apps/holtburger-web/harness/lib/boot.mjs" 2>/dev/null | tail -1)"
case "$S4" in PASS) ;; *) FAIL=1 ;; esac

echo "$SUMMARY_LINE"
echo "CI-SMOKE: wasm=$S0 boot=$S1 errors=$S2 white=$S3 keepalive=$S4  (details: $TMP)"
exit "$FAIL"
