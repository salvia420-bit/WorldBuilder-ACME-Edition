#!/usr/bin/env bash
# ==============================================================================
# run-e2e-deployables.sh — Unified E2E Test Runner for Deployables Ecosystem
#
# Executes the full 6-phase E2E verification suite specified in TEST_INFRA.md:
#   Phase 1: Protocol fixtures validation (gen_fixtures.py --check)
#   Phase 2: Rust protocol test suite (cargo test -p holtburger-protocol vehicle::tests)
#   Phase 3: Client opaque-box test suite (node tests/e2e_deployables_opaque.test.mjs)
#   Phase 4: Client headless harness verification (run-js-headless.mjs --only=e2eDeployablesOpaque)
#   Phase 5: Server deployable ecosystem E2E test suite (dotnet test DeployableEcosystemTests)
#   Phase 6: Server full vehicles test suite regression (dotnet test Vehicles)
#
# Exit status: 0 if and only if all phases succeed; non-zero immediately on failure.
# ==============================================================================

set -euo pipefail

# Repo root resolution
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Text styles & ANSI colors
BOLD="\033[1m"
GREEN="\033[0;32m"
RED="\033[0;31m"
BLUE="\033[0;34m"
CYAN="\033[0;36m"
YELLOW="\033[0;33m"
RESET="\033[0m"

log_ts() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}

SCRIPT_START_SEC=$(date +%s)

echo -e "${BOLD}${CYAN}==============================================================================${RESET}"
echo -e "${BOLD}${CYAN}  UNIFIED E2E TEST RUNNER — 8-UNIT MODULAR DEPLOYABLE ECOSYSTEM${RESET}"
echo -e "${BOLD}${CYAN}==============================================================================${RESET}"
echo -e "  Repo Root    : ${REPO_ROOT}"
echo -e "  Start Time   : $(log_ts)"
echo -e "  Suites       : 6 phases (Protocol Fixtures, Rust, Client Opaque, Harness, Server E2E, Regress)"
echo -e "${BOLD}${CYAN}==============================================================================${RESET}"
echo ""

# Summary records
declare -a PHASE_NAMES=()
declare -a PHASE_STATUSES=()
declare -a PHASE_DURATIONS=()

run_phase() {
    local phase_num="$1"
    local phase_name="$2"
    shift 2
    local cmd=("$@")

    local p_start_ts
    p_start_ts=$(log_ts)
    local p_start_sec
    p_start_sec=$(date +%s)

    echo -e "${BOLD}${BLUE}------------------------------------------------------------------------------${RESET}"
    echo -e "${BOLD}${BLUE}[PHASE ${phase_num}/6] ${phase_name}${RESET}"
    echo -e "  Command    : ${cmd[*]}"
    echo -e "  Start Time : ${p_start_ts}"
    echo -e "${BOLD}${BLUE}------------------------------------------------------------------------------${RESET}"

    local exit_code=0
    "${cmd[@]}" || exit_code=$?

    local p_end_sec
    p_end_sec=$(date +%s)
    local p_duration=$((p_end_sec - p_start_sec))

    PHASE_NAMES+=("[Phase ${phase_num}] ${phase_name}")
    PHASE_DURATIONS+=("${p_duration}s")

    if [ "$exit_code" -eq 0 ]; then
        PHASE_STATUSES+=("PASS")
        echo -e "${BOLD}${GREEN}✓ [PASS] [PHASE ${phase_num}/6] ${phase_name} (${p_duration}s)${RESET}"
        echo ""
    else
        PHASE_STATUSES+=("FAIL")
        echo -e "${BOLD}${RED}✗ [FAIL] [PHASE ${phase_num}/6] ${phase_name} failed with exit code ${exit_code} (${p_duration}s)${RESET}"
        echo ""
        echo -e "${BOLD}${RED}==============================================================================${RESET}"
        echo -e "${BOLD}${RED}  E2E TEST SUITE RUN FAILED AT PHASE ${phase_num} (${phase_name})${RESET}"
        echo -e "${BOLD}${RED}==============================================================================${RESET}"
        exit "$exit_code"
    fi
}

# ------------------------------------------------------------------------------
# Phase 1: Protocol fixtures validation
# ------------------------------------------------------------------------------
run_phase 1 "Protocol Fixtures Validation" \
    python3 external/holtburger/apps/holtburger-web/docs/vehicles-2026-11-01/protocol/gen_fixtures.py --check

# ------------------------------------------------------------------------------
# Phase 2: Rust protocol test suite
# ------------------------------------------------------------------------------
run_phase 2 "Rust Protocol Test Suite" \
    cargo test --manifest-path external/holtburger/Cargo.toml -p holtburger-protocol vehicle::tests

# ------------------------------------------------------------------------------
# Phase 3: Client opaque-box test suite
# ------------------------------------------------------------------------------
run_phase 3 "Client Opaque-Box Test Suite" \
    node external/holtburger/apps/holtburger-web/tests/e2e_deployables_opaque.test.mjs

# ------------------------------------------------------------------------------
# Phase 4: Client headless harness verification
# ------------------------------------------------------------------------------
run_phase 4 "Client Headless Harness Verification" \
    node external/holtburger/apps/holtburger-web/harness/run-js-headless.mjs --only=e2eDeployablesOpaque

# ------------------------------------------------------------------------------
# Phase 5: Server deployable ecosystem E2E test suite
# ------------------------------------------------------------------------------
run_phase 5 "Server Deployable Ecosystem E2E Suite" \
    dotnet test /home/wbterminal/ace-server/Source/ACE.Server.Tests/ACE.Server.Tests.csproj -c Debug --filter FullyQualifiedName~DeployableEcosystemTests

# ------------------------------------------------------------------------------
# Phase 6: Server full vehicles test suite (regression verification)
# ------------------------------------------------------------------------------
run_phase 6 "Server Full Vehicles Regression Suite" \
    dotnet test /home/wbterminal/ace-server/Source/ACE.Server.Tests/ACE.Server.Tests.csproj -c Debug --filter FullyQualifiedName~Vehicles

# ------------------------------------------------------------------------------
# Final Execution Summary
# ------------------------------------------------------------------------------
SCRIPT_END_SEC=$(date +%s)
TOTAL_DURATION=$((SCRIPT_END_SEC - SCRIPT_START_SEC))

echo -e "${BOLD}${GREEN}==============================================================================${RESET}"
echo -e "${BOLD}${GREEN}  UNIFIED E2E TEST RUNNER — ALL PHASES COMPLETED SUCCESSFULLY${RESET}"
echo -e "${BOLD}${GREEN}==============================================================================${RESET}"
echo -e "  Total Elapsed Time: ${TOTAL_DURATION}s"
echo -e "  Finished At       : $(log_ts)"
echo ""
echo -e "${BOLD}Phase Results Summary:${RESET}"
for i in "${!PHASE_NAMES[@]}"; do
    printf "  %-46s : ${GREEN}%-6s${RESET} (%s)\n" "${PHASE_NAMES[$i]}" "${PHASE_STATUSES[$i]}" "${PHASE_DURATIONS[$i]}"
done
echo -e "${BOLD}${GREEN}==============================================================================${RESET}"
echo -e "${BOLD}${GREEN}  E2E STATUS: GREEN (100% Pass across Protocol, Client, and Server)${RESET}"
echo -e "${BOLD}${GREEN}==============================================================================${RESET}"

exit 0
