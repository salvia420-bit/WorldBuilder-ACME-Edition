#!/usr/bin/env bash
# =============================================================================
# Gate-1 runner — offline DATA gate for world completeness (Holtburg ring).
#
# Orchestrates all THREE canonical Gate-1 legs in one command, each diffing the
# baked/client placements against an INDEPENDENT oracle, one-to-one within
# retail-derived tolerances. No browser, no network. The three gates:
#
#   scenery  diff-completeness.mjs   bake JSONL vs oracle.bakedScenery
#              (provenance: regression-snapshot by default — the snapshot was
#               COPIED from a prior bake, so it is drift-detection, NOT
#               independent algorithm verification. Pass --crosscheck-dir to add
#               the genuinely-independent scenery-independent leg.)
#   statics  statics-parity.mjs (G2) holtburger-dat (dat-tool --objects-jsonl)
#              vs WB.Terminal list-objects — EVERY LandblockInfo object (loose
#              `objects` + `buildings`), two independent parsers of client_cell.dat.
#              provenance: independent.
#   spawns   spawns-parity.mjs (G3)  live ACE landblock_instance vs staged
#              ace_spawn_records.jsonl — snapshot-free. provenance: independent.
#
# Two-gate thesis (see README.md): Gate-1 (THIS) is the cheap, deterministic,
# all-40,197-LB-without-a-GPU DATA gate; Gate-2 (later) is the expensive sampled
# RENDER smoke. Gate-1 carries the exhaustive coverage burden.
#
# A gate whose prerequisites are missing is SKIPPED (reported honestly), never
# silently dropped and never faked as a PASS.
#
# Usage:
#   scripts/gate1/run-gate1.sh                          # default ring, all 3 gates
#   scripts/gate1/run-gate1.sh --ring <file|0xLLLL,...>
#   scripts/gate1/run-gate1.sh --gates scenery,statics  # subset of gates
#   scripts/gate1/run-gate1.sh --legs scenery-regression,statics-independent
#                                                       # override scenery sub-legs
#   scripts/gate1/run-gate1.sh --crosscheck-dir <dir>   # also run scenery-independent
#   scripts/gate1/run-gate1.sh --out <reportDir>
#   scripts/gate1/run-gate1.sh --selftest               # exercise the diff engine
#
# Prereqs (gate is SKIPPED if its prereqs are absent):
#   scenery  bake-dir + oracle-dir on disk.
#   statics  dat-tool built, WorldBuilder.Terminal built, client_cell.dat,
#            RetailSmoke.wbproj.
#   spawns   ace_spawn_records.jsonl + a reachable ACE world DB (mariadb up).
#
# Env overrides (all have safe defaults):
#   BAKE_DIR        scenery bake JSONL dir
#   ORACLE_DIR      frozen WB.Terminal oracle snapshot dir (scenery-regression)
#   SPAWN_SOURCE    ace_spawn_records.jsonl path (scenery spawns-independent + G3)
#   CROSSCHECK_DIR  C# scenery-cross-check output dir (enables scenery-independent)
#   CELL_DAT        client_cell.dat for statics (G2)
#   PROJECT         RetailSmoke.wbproj for statics (G2)
#   DAT_TOOL        holtburger dat-tool binary
#   DLL             explicit WorldBuilder.Terminal.dll (else newest auto-resolved)
#   TOL             match tolerance (m) for statics/spawns (default 0.02)
#   DB_NAME/DB_USER/DB_PASS/DB_HOST   ACE world DB for spawns (G3)
#   OUT_DIR         report output dir
# =============================================================================
set -euo pipefail

# --- Resolve our own location so the script works from any CWD. -------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIFF="${SCRIPT_DIR}/diff-completeness.mjs"
STATICS="${SCRIPT_DIR}/statics-parity.mjs"
SPAWNS="${SCRIPT_DIR}/spawns-parity.mjs"
DEFAULT_RING="${SCRIPT_DIR}/holtburg-ring.txt"

# --- Defaults (artifacts already on disk; verified by RECON). ---------------
BAKE_DIR="${BAKE_DIR:-/mnt/wbterminal2/holtburger-dist/scenery}"
ORACLE_DIR="${ORACLE_DIR:-/mnt/wbterminal1/tmp/claude-scratch/world-oracles-2026-06-01/oracles}"
SPAWN_SOURCE="${SPAWN_SOURCE:-/home/wbterminal/projects/RetailSmoke/ace_spawn_records.jsonl}"
CROSSCHECK_DIR="${CROSSCHECK_DIR:-}"
OUT_DIR="${OUT_DIR:-/mnt/wbterminal1/tmp/claude-scratch/gate1/report}"
CELL_DAT="${CELL_DAT:-${HOME}/ac_base_dats/client_cell_1.dat}"
PROJECT="${PROJECT:-/home/wbterminal/projects/RetailSmoke/RetailSmoke.wbproj}"
# dat-tool: prefer the release binary (faster DAT parse) when present.
_DT_BASE="/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/target"
if [ -z "${DAT_TOOL:-}" ]; then
  if [ -x "${_DT_BASE}/release/dat-tool" ]; then DAT_TOOL="${_DT_BASE}/release/dat-tool"
  else DAT_TOOL="${_DT_BASE}/debug/dat-tool"; fi
fi
DLL="${DLL:-}"
TOL="${TOL:-0.02}"
DB_NAME="${DB_NAME:-ace_world}"
DB_USER="${DB_USER:-ace}"
DB_PASS="${DB_PASS:-ace}"
DB_HOST="${DB_HOST:-127.0.0.1}"
WBT_RELEASE="/home/wbterminal/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/bin/Release"

RING="${DEFAULT_RING}"
LEGS=""                          # empty -> scenery legs auto-picked below
GATES="scenery,statics,spawns"   # which of the 3 gates to run
SELFTEST=0

# --- Arg parse (thin; everything else flows to defaults). -------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --ring)           RING="$2"; shift 2 ;;
    --gates)          GATES="$2"; shift 2 ;;
    --bake-dir)       BAKE_DIR="$2"; shift 2 ;;
    --oracle-dir)     ORACLE_DIR="$2"; shift 2 ;;
    --spawn-source)   SPAWN_SOURCE="$2"; shift 2 ;;
    --crosscheck-dir) CROSSCHECK_DIR="$2"; shift 2 ;;
    --cell-dat)       CELL_DAT="$2"; shift 2 ;;
    --project)        PROJECT="$2"; shift 2 ;;
    --dat-tool)       DAT_TOOL="$2"; shift 2 ;;
    --dll)            DLL="$2"; shift 2 ;;
    --tol)            TOL="$2"; shift 2 ;;
    --db)             DB_NAME="$2"; shift 2 ;;
    --db-user)        DB_USER="$2"; shift 2 ;;
    --db-pass)        DB_PASS="$2"; shift 2 ;;
    --db-host)        DB_HOST="$2"; shift 2 ;;
    --out)            OUT_DIR="$2"; shift 2 ;;
    --legs)           LEGS="$2"; shift 2 ;;
    --selftest)       SELFTEST=1; shift ;;
    -h|--help)
      awk '/^# ={5,}/{b++; next} b==1{sub(/^# ?/, ""); print} b>=2{exit}' "${BASH_SOURCE[0]}"
      exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "${DIFF}" ]; then
  echo "error: diff-completeness.mjs not found at ${DIFF}" >&2
  exit 1
fi

# --- Self-test short-circuit: exercise the diff engine, no real data. -------
if [ "${SELFTEST}" -eq 1 ]; then
  echo "[gate1] running diff-completeness self-test (synthetic data, no browser)"
  exec node "${DIFF}" --selftest
fi

# --- Helpers. ---------------------------------------------------------------
in_gates() { case ",${GATES}," in *,"$1",*) return 0 ;; *) return 1 ;; esac; }
warn() { echo "[gate1] WARNING: $*" >&2; }
# WB.Terminal is built if an explicit --dll exists, or a net*/...dll is present.
wbt_built() {
  if [ -n "${DLL}" ]; then [ -f "${DLL}" ]; return; fi
  compgen -G "${WBT_RELEASE}/net*/WorldBuilder.Terminal.dll" >/dev/null 2>&1
}

mkdir -p "${OUT_DIR}"
SCENERY_REPORT="${OUT_DIR}/gate1-report.json"
STATICS_REPORT="${OUT_DIR}/statics-report.json"
SPAWNS_REPORT="${OUT_DIR}/spawns-report.json"
SUMMARY="${OUT_DIR}/gate1-summary.json"
SCENERY_STATUS="skipped"
STATICS_STATUS="skipped"
SPAWNS_STATUS="skipped"

echo "[gate1] ring   : ${RING}"
echo "[gate1] gates  : ${GATES}"
echo "[gate1] out    : ${OUT_DIR}"
echo

# ============================================================================
# SCENERY gate — diff-completeness.mjs (bake vs oracle.bakedScenery / cross-check)
# ============================================================================
if in_gates scenery; then
  SCENERY_LEGS="${LEGS}"
  if [ -z "${SCENERY_LEGS}" ]; then
    SCENERY_LEGS="scenery-regression"
    if [ -n "${CROSSCHECK_DIR}" ] && [ -d "${CROSSCHECK_DIR}" ]; then
      SCENERY_LEGS="scenery-independent,scenery-regression"
      echo "[gate1] cross-check dir present -> adding scenery-independent leg"
    fi
  fi
  [ -e "${BAKE_DIR}" ]   || warn "scenery: bake-dir not found: ${BAKE_DIR} (LBs will SKIP)"
  [ -e "${ORACLE_DIR}" ] || warn "scenery: oracle-dir not found: ${ORACLE_DIR} (LBs will SKIP)"
  echo "[gate1] --- SCENERY gate (diff-completeness.mjs)  legs=${SCENERY_LEGS}"
  S_ARGS=( --ring "${RING}" --bake-dir "${BAKE_DIR}" --oracle-dir "${ORACLE_DIR}"
           --out "${OUT_DIR}" --legs "${SCENERY_LEGS}" )
  case ",${SCENERY_LEGS}," in
    *,spawns-independent,*) S_ARGS+=( --spawn-source "${SPAWN_SOURCE}" ) ;;
  esac
  if [ -n "${CROSSCHECK_DIR}" ] && [ -d "${CROSSCHECK_DIR}" ]; then
    S_ARGS+=( --crosscheck-dir "${CROSSCHECK_DIR}" )
  fi
  rm -f "${SCENERY_REPORT}"
  set +e
  node "${DIFF}" "${S_ARGS[@]}"
  set -e
  [ -f "${SCENERY_REPORT}" ] && SCENERY_STATUS="ran" || { SCENERY_STATUS="error"; warn "scenery gate produced no report"; }
  echo
fi

# ============================================================================
# STATICS gate — statics-parity.mjs (G2): dat-tool vs WB.Terminal list-objects
# ============================================================================
if in_gates statics; then
  if [ ! -f "${CELL_DAT}" ]; then
    warn "statics gate SKIPPED — cell-dat not found: ${CELL_DAT}"
  elif [ ! -f "${PROJECT}" ]; then
    warn "statics gate SKIPPED — project not found: ${PROJECT}"
  elif [ ! -x "${DAT_TOOL}" ]; then
    warn "statics gate SKIPPED — dat-tool not built: ${DAT_TOOL}"
  elif ! wbt_built; then
    warn "statics gate SKIPPED — WorldBuilder.Terminal not built (${WBT_RELEASE}/net*/WorldBuilder.Terminal.dll)"
  else
    echo "[gate1] --- STATICS gate (statics-parity.mjs, G2)"
    ST_ARGS=( --ring "${RING}" --cell-dat "${CELL_DAT}" --project "${PROJECT}"
              --dat-tool "${DAT_TOOL}" --tol "${TOL}" --out "${STATICS_REPORT}" )
    [ -n "${DLL}" ] && ST_ARGS+=( --dll "${DLL}" )
    rm -f "${STATICS_REPORT}"
    set +e
    node "${STATICS}" "${ST_ARGS[@]}"
    set -e
    [ -f "${STATICS_REPORT}" ] && STATICS_STATUS="ran" || { STATICS_STATUS="error"; warn "statics gate produced no report"; }
    echo
  fi
fi

# ============================================================================
# SPAWNS gate — spawns-parity.mjs (G3): live ACE landblock_instance vs staged
# ============================================================================
if in_gates spawns; then
  if [ ! -f "${SPAWN_SOURCE}" ]; then
    warn "spawns gate SKIPPED — spawn-source not found: ${SPAWN_SOURCE}"
  elif ! command -v mysql >/dev/null 2>&1; then
    warn "spawns gate SKIPPED — mysql client not on PATH"
  elif ! mysql "-u${DB_USER}" "-p${DB_PASS}" "-h${DB_HOST}" "${DB_NAME}" -N -e "SELECT 1;" >/dev/null 2>&1; then
    warn "spawns gate SKIPPED — cannot reach ACE DB ${DB_USER}@${DB_HOST}/${DB_NAME}"
  else
    echo "[gate1] --- SPAWNS gate (spawns-parity.mjs, G3)"
    rm -f "${SPAWNS_REPORT}"
    set +e
    node "${SPAWNS}" --ring "${RING}" --spawn-source "${SPAWN_SOURCE}" \
      --db "${DB_NAME}" --db-user "${DB_USER}" --db-pass "${DB_PASS}" --db-host "${DB_HOST}" \
      --tol "${TOL}" --out "${SPAWNS_REPORT}"
    set -e
    [ -f "${SPAWNS_REPORT}" ] && SPAWNS_STATUS="ran" || { SPAWNS_STATUS="error"; warn "spawns gate produced no report"; }
    echo
  fi
fi

# ============================================================================
# Combined verdict — roll up each gate's report JSON (jq-free; pure node).
#   scenery report:  { legsEnabled, totals: { <leg>: {pass,drift,skip,refused} } }
#   statics/spawns:  { totals: {pass,drift,skip,missing,extra} }
# diff-completeness ALWAYS exits 0 (verdict lives in the JSON); statics/spawns
# exit 1 on drift (captured above), so the verdict is derived from the reports.
# ============================================================================
echo "[gate1] ============================================================"
echo "[gate1] COMBINED VERDICT"
echo "[gate1] report dir  : ${OUT_DIR}"
set +e
GATE1_SUMMARY="${SUMMARY}" node -e '
const fs = require("fs");
const a = process.argv.slice(1);
const gates = [];
for (let i = 0; i < a.length; i += 3) gates.push({ name: a[i], status: a[i + 1], report: a[i + 2] });
function tally(rep) {
  let pass = 0, drift = 0, skip = 0, refused = 0, missing = 0, extra = 0;
  const add = (t) => { pass += t.pass || 0; drift += t.drift || 0; skip += t.skip || 0; refused += t.refused || 0; missing += t.missing || 0; extra += t.extra || 0; };
  if (Array.isArray(rep.legsEnabled)) { for (const leg of rep.legsEnabled) add(rep.totals[leg] || {}); }
  else add(rep.totals || {});
  return { pass, drift, skip, refused, missing, extra };
}
const summary = { tool: "gate1-run", browserUsed: false, gates: {} };
let anyErr = false, anyRef = false, anyDrift = false, anyPass = false;
for (const g of gates) {
  let verdict, t = null;
  if (g.status === "skipped") verdict = "SKIP(not-run)";
  else if (g.status === "error") { verdict = "ERROR"; anyErr = true; }
  else {
    try { t = tally(JSON.parse(fs.readFileSync(g.report, "utf8"))); }
    catch (e) { verdict = "ERROR"; anyErr = true; }
    if (t) {
      verdict = t.refused > 0 ? "REFUSED" : t.drift > 0 ? "DRIFT" : t.pass > 0 ? "PASS" : "SKIP(empty)";
      if (t.refused > 0) anyRef = true;
      if (t.drift > 0) anyDrift = true;
      if (t.pass > 0) anyPass = true;
    }
  }
  summary.gates[g.name] = { verdict, status: g.status, report: g.report, totals: t };
  const ts = t ? `  pass=${t.pass} drift=${t.drift} skip=${t.skip} refused=${t.refused} missing=${t.missing} extra=${t.extra}` : "";
  console.log(`[gate1]   ${g.name.padEnd(8)}: ${verdict}${ts}`);
}
let overall, code;
if (anyErr) { overall = "ERROR"; code = 2; }
else if (anyRef) { overall = "REFUSED"; code = 3; }
else if (anyDrift) { overall = "DRIFT"; code = 1; }
else if (anyPass) { overall = "PASS"; code = 0; }
else { overall = "INCOMPLETE(all-skipped)"; code = 4; }
summary.overall = overall;
console.log(`[gate1] overall   : ${overall}`);
console.log("[gate1] browser   : NO");
fs.writeFileSync(process.env.GATE1_SUMMARY, JSON.stringify(summary, null, 2));
console.log(`[gate1] summary   : ${process.env.GATE1_SUMMARY}`);
process.exit(code);
' scenery "${SCENERY_STATUS}" "${SCENERY_REPORT}" \
  statics "${STATICS_STATUS}" "${STATICS_REPORT}" \
  spawns  "${SPAWNS_STATUS}"  "${SPAWNS_REPORT}"
RC=$?
set -e
echo "[gate1] ============================================================"
exit "${RC}"
