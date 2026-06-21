#!/usr/bin/env bash
# =============================================================================
# Gate-1 runner — offline DATA gate for world completeness (Holtburg ring).
# =============================================================================
#
# Wraps diff-completeness.mjs with the OFFLINE-AVAILABLE legs and the canonical
# Holtburg ring. No browser, no network, no heavy build. Pure Node stdlib +
# pre-baked artifacts already on disk.
#
# Two-gate thesis (see README.md):
#   * Gate-1 (THIS) = offline DATA gate. Diffs every baked placement in the ring
#     against an oracle, one-to-one within retail-derived tolerances. Cheap,
#     deterministic, runnable for all 40,197 LBs with no GPU.
#   * Gate-2 (later) = sampled RENDER smoke. Loads a handful of representative
#     LBs in the real client and eyeballs/automates that they draw. Expensive,
#     so it only samples; Gate-1 carries the exhaustive coverage burden.
#
# Legs run by default (all computable from artifacts already on disk):
#   scenery-regression   bake JSONL        vs  oracle.bakedScenery
#                          provenance: regression-snapshot (drift detection;
#                          the snapshot was COPIED from a prior bake, so this is
#                          NOT independent algorithm verification).
#   statics-independent  oracle.buildings  (LandblockInfo, independent of bake)
#                          provenance: independent. Reports static-object
#                          coverage per LB.
#   spawns-independent   spawn-source JSONL vs oracle.npcs
#                          provenance: independent (ACE landblock_instance +
#                          encounter records, independent of the bake).
#
# The scenery-INDEPENDENT leg (bake vs C# cross-check) is NOT in the default set
# because the C# cross-check output is not pre-generated on disk; generating it
# is a heavy dotnet run. Pass --crosscheck-dir <dir> (after running the C#
# scenery-cross-check tool) to enable it; the runner will add the leg
# automatically when the dir exists.
#
# Usage:
#   scripts/gate1/run-gate1.sh                      # default ring + offline legs
#   scripts/gate1/run-gate1.sh --ring <file|0xLLLL,...>
#   scripts/gate1/run-gate1.sh --legs scenery-regression,statics-independent
#   scripts/gate1/run-gate1.sh --crosscheck-dir <dir>   # also run scenery-independent
#   scripts/gate1/run-gate1.sh --out <reportDir>
#   scripts/gate1/run-gate1.sh --selftest           # exercise the diff engine
#
# Env overrides (all have safe defaults):
#   BAKE_DIR        scenery bake JSONL dir
#   ORACLE_DIR      frozen WB.Terminal oracle snapshot dir
#   SPAWN_SOURCE    ace_spawn_records.jsonl path
#   CROSSCHECK_DIR  C# scenery-cross-check output dir (enables scenery-independent)
#   OUT_DIR         report output dir
# =============================================================================
set -euo pipefail

# --- Resolve our own location so the script works from any CWD. -------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIFF="${SCRIPT_DIR}/diff-completeness.mjs"
DEFAULT_RING="${SCRIPT_DIR}/holtburg-ring.txt"

# --- Defaults (all artifacts already on disk; verified by RECON). -----------
BAKE_DIR="${BAKE_DIR:-/mnt/wbterminal2/holtburger-dist/scenery}"
ORACLE_DIR="${ORACLE_DIR:-/mnt/wbterminal1/tmp/claude-scratch/world-oracles-2026-06-01/oracles}"
SPAWN_SOURCE="${SPAWN_SOURCE:-/home/wbterminal/projects/RetailSmoke/ace_spawn_records.jsonl}"
CROSSCHECK_DIR="${CROSSCHECK_DIR:-}"
OUT_DIR="${OUT_DIR:-/mnt/wbterminal1/tmp/claude-scratch/gate1/report}"

RING="${DEFAULT_RING}"
LEGS=""        # empty -> auto-pick offline legs below
SELFTEST=0

# --- Arg parse (thin; everything else flows to defaults). -------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --ring)           RING="$2"; shift 2 ;;
    --bake-dir)       BAKE_DIR="$2"; shift 2 ;;
    --oracle-dir)     ORACLE_DIR="$2"; shift 2 ;;
    --spawn-source)   SPAWN_SOURCE="$2"; shift 2 ;;
    --crosscheck-dir) CROSSCHECK_DIR="$2"; shift 2 ;;
    --out)            OUT_DIR="$2"; shift 2 ;;
    --legs)           LEGS="$2"; shift 2 ;;
    --selftest)       SELFTEST=1; shift ;;
    -h|--help)
      sed -n '2,60p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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

# --- Decide the leg set if not explicitly given. ----------------------------
# Offline-default legs: regression (bake vs oracle.bakedScenery), statics
# (oracle.buildings), spawns (spawn-source vs oracle.npcs). Add the scenery
# INDEPENDENT leg only when a cross-check dir is available (it is not by
# default; producing it is a heavy dotnet run).
if [ -z "${LEGS}" ]; then
  LEGS="scenery-regression,statics-independent,spawns-independent"
  if [ -n "${CROSSCHECK_DIR}" ] && [ -d "${CROSSCHECK_DIR}" ]; then
    LEGS="scenery-independent,${LEGS}"
    echo "[gate1] cross-check dir present -> adding scenery-independent leg"
  fi
fi

# --- Preflight: warn (don't fail) on any missing input so the report is
#     honest about which legs can actually run. --------------------------------
preflight_warn() {
  local label="$1" pathv="$2"
  if [ ! -e "${pathv}" ]; then
    echo "[gate1] WARNING: ${label} not found: ${pathv} (dependent legs will SKIP)" >&2
  fi
}
preflight_warn "bake-dir"     "${BAKE_DIR}"
preflight_warn "oracle-dir"   "${ORACLE_DIR}"
case ",${LEGS}," in
  *,spawns-independent,*) preflight_warn "spawn-source" "${SPAWN_SOURCE}" ;;
esac

mkdir -p "${OUT_DIR}"

# --- Build the diff-completeness.mjs invocation. ----------------------------
ARGS=(
  --ring "${RING}"
  --bake-dir "${BAKE_DIR}"
  --oracle-dir "${ORACLE_DIR}"
  --out "${OUT_DIR}"
  --legs "${LEGS}"
)
case ",${LEGS}," in
  *,spawns-independent,*) ARGS+=( --spawn-source "${SPAWN_SOURCE}" ) ;;
esac
if [ -n "${CROSSCHECK_DIR}" ] && [ -d "${CROSSCHECK_DIR}" ]; then
  ARGS+=( --crosscheck-dir "${CROSSCHECK_DIR}" )
fi

echo "[gate1] ring        : ${RING}"
echo "[gate1] legs        : ${LEGS}"
echo "[gate1] bake-dir    : ${BAKE_DIR}"
echo "[gate1] oracle-dir  : ${ORACLE_DIR}"
case ",${LEGS}," in
  *,spawns-independent,*) echo "[gate1] spawn-source: ${SPAWN_SOURCE}" ;;
esac
[ -n "${CROSSCHECK_DIR}" ] && echo "[gate1] crosscheck  : ${CROSSCHECK_DIR}"
echo "[gate1] out         : ${OUT_DIR}"
echo

# --- Run. diff-completeness.mjs prints its own summary table + report path. --
node "${DIFF}" "${ARGS[@]}"

REPORT="${OUT_DIR}/gate1-report.json"
echo
echo "[gate1] ============================================================"
echo "[gate1] report JSON : ${REPORT}"

# --- Roll up an overall verdict from the report totals (jq-free; pure node). -
if [ -f "${REPORT}" ]; then
  node -e '
    const fs = require("fs");
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    let drift = 0, refused = 0, pass = 0, skip = 0;
    for (const leg of r.legsEnabled) {
      const t = r.totals[leg];
      drift   += t.drift   || 0;
      refused += t.refused || 0;
      pass    += t.pass    || 0;
      skip    += t.skip    || 0;
    }
    const verdict = refused > 0 ? "REFUSED" : drift > 0 ? "DRIFT" : "PASS";
    console.log(`[gate1] overall     : ${verdict}  (pass=${pass} drift=${drift} skip=${skip} refused=${refused})`);
    console.log("[gate1] browser used: NO");
  ' "${REPORT}"
fi
echo "[gate1] ============================================================"
