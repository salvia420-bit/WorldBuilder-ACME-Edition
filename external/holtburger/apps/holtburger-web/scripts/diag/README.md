# scripts/diag/

Wire-agent observation harnesses for the holtburger-web client-side
diagnostic suite. Each harness boots a Playwright + headless chromium
session against a live ACE server, exercises a specific code path,
and asserts that `__diag` reports a known-good (or known-bad)
shape. Companion to the build-side `validate_*.cjs` validators at
`apps/holtburger-web/` and the `WorldBuilder.Terminal/Diagnostics/RunAll.cs`
build-side aggregator.

For the three-layer organization see
[`docs/diagnostic-toolset-method.md`](../../../../../docs/diagnostic-toolset-method.md).

## Running

From `apps/holtburger-web/`:

```bash
# All registered harnesses, with status matrix:
NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
  node scripts/diag/diag-run-all.cjs

# A single harness:
NODE_PATH=… node scripts/diag/run-diag-pvs-holtburg-cottage-inside.cjs
```

Prerequisites:

- Local HTTP server on port 8765 serving the repo (default; override
  with `HOLTBURGER_BASE_URL`).
- Live ACE on standard port with the `acadmp1ge522` Developer-level
  test account (or override the autoLogin URL params in each harness).
- Wasm built (`wasm-pack build --target web --out-dir pkg --release`)
  with current main-branch source.
- Playwright installed somewhere on `NODE_PATH` or
  `PLAYWRIGHT_CACHE` (default fallback: `~/.npm/_npx/…`).

Per-run outputs land in `$HOLTBURGER_DIAG_OUT/`, defaulting to
`/mnt/wbterminal1/tmp/claude-scratch/holtburger-diag-runs/` (per the
`feedback_use_external_drives_for_scratch` convention).

## Harnesses

| Harness | Surface | Documents | Expected today |
|---|---|---|---|
| `run-diag-pvs-holtburg-cottage.cjs` | `__diag.pvs` | LandCell↔EnvCell edge gap (shortfall #3) | FAIL (`missing=17`) — DOC-GAP |
| `run-diag-pvs-holtburg-cottage-inside.cjs` | `__diag.pvs` | Phase 3 visible_cells fix (commit `344d0b6d`) | PASS (17/17) — OK |

## Aggregator semantics

`diag-run-all.cjs` runs all registered harnesses and prints a matrix:

| Expected | Actual | Status | Meaning |
|---|---|---|---|
| PASS | PASS | OK | Healthy |
| FAIL | FAIL | DOC-GAP | Documented broken state — CI-clean |
| PASS | FAIL | UNEXPECTED | Regression on a closed shortfall |
| FAIL | PASS | UNEXPECTED | Unexpected closure — flip `expectsPass: true` and re-run |

Exits non-zero only on UNEXPECTED. Documented gaps don't fail CI —
they're known-broken state stably captured by the test suite. When
a gap closes (someone ships a fix), the harness flips from DOC-GAP
to UNEXPECTED, which signals "go flip the `expectsPass` flag and
re-promote this test to a real assertion."

## Adding a new harness

1. Drop a `run-diag-<name>.cjs` file alongside the existing ones.
   Use one of the two existing harnesses as a template.
2. The harness should exit 0 on PASS, 1 on FAIL, 2 on
   couldn't-reach-the-diff (setup error / helper missing / oracle
   unreadable).
3. Register an entry in `HARNESSES` in `diag-run-all.cjs` with
   `expectsPass` matching the current state of the underlying gap.

## Cross-references

- Canonical contract: [`docs/diagnostic-toolset-method.md`](../../../../../docs/diagnostic-toolset-method.md)
- The 14-surface plan: [`docs/diagnostic-toolset-plan-2026-05-19.md`](../../../../../docs/diagnostic-toolset-plan-2026-05-19.md)
- Cell-portal method: [`docs/cell-portal-method.md`](../../../../../docs/cell-portal-method.md)
- Client-side observation surfaces: [`apps/holtburger-web/scene3d/diag/`](../../scene3d/diag/)
- Build-side aggregator: `WorldBuilder.Terminal/Diagnostics/RunAll.cs`
