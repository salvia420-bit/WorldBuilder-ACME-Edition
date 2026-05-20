# Diagnostic Toolset Method

**Status:** Draft, 2026-05-20. Owner: open.

Umbrella doc over the 9-11 per-surface `*-method.md` contracts. Each per-surface method doc defines a single retail-correctness axis (wire conformance, DAT parity, enum parity, motion-pose, physics replay, …). This doc sits ABOVE them and covers:

- What the toolset IS — at a glance.
- How to invoke it — `diag-run-all` + flags.
- How to interpret PASS/FAIL/SKIP/INFRA outcomes.
- What to do when the validator output disagrees with the code.
- Per-surface method-doc inventory + links.

Predecessor / parent docs:
- [`diagnostic-toolset-plan-2026-05-19.md`](diagnostic-toolset-plan-2026-05-19.md) — the team agent execution plan.
- [`world-completeness-method.md`](world-completeness-method.md), [`entity-completeness-method.md`](entity-completeness-method.md), [`event-completeness-method.md`](event-completeness-method.md) — the three original completeness contracts that established the validator pattern.

---

## 1. What the toolset IS

A diagnostic-tool suite that proves the `emit-dynamic-site` browser AC client (`external/holtburger/apps/holtburger-web/`) is **retail-correct** along every axis that has a canonical oracle. Each axis is:

- a **method doc** that defines the contract (one of the `*-method.md` files cross-linked in §5),
- a **canonical oracle** (ACE source, Chorizite, `~/ac-headers/acclient.{c,h}`, real base DATs, or live ACE on Tailscale),
- a **C# port** of the oracle inside `WorldBuilder.Terminal`'s JSON command surface (≈one `CommandEngine.<Topic>.cs` partial per surface),
- a **`validate_*.cjs` Node validator** that drives the oracle, captures the runtime's state, diffs, and emits a per-surface `report.json`,
- a **`diag-run-all` aggregator** (this layer) that runs every validator and synthesizes a top-level pass/fail.

The toolset is built incrementally — Waves 1-5 per the plan §6. As of 2026-05-20, **13 of 14 surfaces** have shipped validators (Wave 4 texture/mesh whole-DAT sweep is the remaining gap, deliberately out-of-band).

---

## 2. How to invoke

### 2.1 The single entry point — `diag-run-all`

Once the W5.C dispatch splice is live (`WAVE5C_DISPATCH_PENDING.patch`), the canonical invocation is via WB.Terminal's stdin loop:

```bash
echo '{"command":"diag-run-all"}' \
  | $DOTNET_ROOT/dotnet WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll --stdin
```

Or directly via the Node driver (no need for WB.Terminal):

```bash
cd external/holtburger/apps/holtburger-web
NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
  node run-all-validators.cjs
```

### 2.2 Flags

| Flag | Default | Meaning |
|---|---|---|
| `--wave4-mode=fast\|full` | `fast` | Texture+mesh sweep mode. `fast` = Holtburg 81-model subset (sub-second). `full` = whole-DAT sweep (multi-hour). Wave 4 not yet shipped; both modes currently SKIP. |
| `--report-dir=PATH` | `/mnt/wbterminal1/holtburger-validator-reports/diag-run-all/<ts>/` | Override the aggregate output directory. |
| `--parallel` | off | Run validators concurrently. Default is sequential for log clarity. |
| `--skip=<surface>` | (none) | Repeatable. Skip a validator by surface slug (e.g. `--skip=physics-replay` for an ACE-down run). |
| `--help` / `-h` | — | Print the inventory + usage. |

For the JSON-stdin path, the same flags are passed as fields:

```json
{
  "command": "diag-run-all",
  "wave4Mode": "fast",
  "reportDir": "/tmp/diag/",
  "parallel": false,
  "skipSurfaces": ["physics-replay", "placements"]
}
```

### 2.3 Quick status — `diag-status`

Read-only: find the most recent aggregate and return its parsed shape without running anything.

```bash
echo '{"command":"diag-status"}' \
  | $DOTNET_ROOT/dotnet WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll --stdin
```

Useful for "what's the current state of retail correctness on this box?" without paying the run cost.

### 2.4 Output artifacts

Every `diag-run-all` invocation writes:

- `<ts>/aggregate.json` — the canonical machine-readable rollup
- `<ts>/summary.md` — human-readable, copy-pasteable into a chat thread
- `<ts>/logs/<surface>.log` — per-surface stdout+stderr capture (for failure forensics)

Per-surface validators still write their own `report.json` to their own surface dir (e.g. `/mnt/wbterminal1/holtburger-validator-reports/wire-conformance/<ts>/report.json`); the aggregate just collects the latest reference.

---

## 3. Acceptance interpretation guide

`diag-run-all` exit codes:

| Exit | Meaning |
|---|---|
| 0 | All **required** surfaces PASS. SKIP-not-yet-shipped and SKIP-via-CLI rows are not failures. |
| 1 | At least one **required** surface returned exit 1 (real drift surfaced). |
| 2 | Driver infra error (node crashed, aggregate JSON unreadable, etc). The aggregate may reflect partial state. |

Per-surface statuses (in the `surfaces[].status` field of `aggregate.json`):

| Status | Meaning |
|---|---|
| `PASS` | Validator returned exit 0. The surface's contract is upheld. |
| `FAIL` | Validator returned exit 1. Real drift surfaced — investigate the per-surface `report.json` and `logs/<surface>.log`. |
| `SKIP_CLI` | Operator passed `--skip=<surface>` on the command line. |
| `SKIP_NOT_SHIPPED` | Validator script does not exist on disk. Treat as "not implemented yet" — most likely the surface's wave hasn't landed. |
| `INFRA` | Validator returned a non-{0,1} exit code, timed out, or its `report.json` was malformed. The validator itself is broken. |

The `summary.requiredFailures` field counts only FAIL+INFRA on `required: true` surfaces. **That field drives the gate.**

---

## 4. When validator output disagrees with code

**The validator IS the source of truth.**

Don't change the validator to make the code pass. The validator embeds the canonical oracle — making it pass when it shouldn't is silently making the runtime more wrong while the green check stays green.

Three valid responses to a FAIL row:

1. **Fix the runtime.** The most common path. Find the surface's contract in its per-surface method doc, find what the runtime is doing differently, fix the runtime.

2. **Document the divergence as an allowlist entry.** Each surface's method doc has a "Known divergences" section. Real-world examples that have landed there:
   - `wire-conformance-method.md` "The 4 SKIPs" — Rust-vs-Chorizite wrapper-dispatch + naming-gap divergences that aren't drift, just port-shape differences.
   - `enum-parity-method.md` GAP rows — Chorizite enums that don't have a Rust counterpart (most are `bitflags!` structs).
   - `dat-parity-method.md` Phase-B drift table — DRW property-graph elisions tagged `chorizite-zeroed`.

3. **Find and fix the canonical-oracle bug.** Rare but real. The plan's "oracle ranking" at §2 of [`diagnostic-toolset-plan-2026-05-19.md`](diagnostic-toolset-plan-2026-05-19.md) is ACE first, then retail decomp, then Chorizite — disagreement is resolved by going up the stack. Document the resolution in the per-surface method doc.

What you DON'T do: rewrite the validator to "accept the runtime's output." That's the validator drift mode — the worst possible failure of this discipline, and it makes every other validator suspect.

---

## 5. Surface inventory

The 14 surfaces from plan §3, with their method-doc links and shipping status:

| # | Surface | Method doc | Status |
|---|---|---|---|
| 1 | Placement completeness | [`world-completeness-method.md`](world-completeness-method.md) | ✓ SHIPPED (Wave-1) |
| 2 | Event completeness | [`event-completeness-method.md`](event-completeness-method.md) | ◐ SHIPPED (Wave-1) — F.D-fu probes open |
| 3 | Entity typed-class | [`entity-completeness-method.md`](entity-completeness-method.md) | ✓ SHIPPED (Wave-1) |
| 4 | Wire packet conformance | [`wire-conformance-method.md`](wire-conformance-method.md) | ✓ SHIPPED (W1) |
| 5 | DAT parser parity | [`dat-parity-method.md`](dat-parity-method.md) | ✓ SHIPPED (W2.A+B+D) |
| 6 | Enum parity | [`enum-parity-method.md`](enum-parity-method.md) | ✓ SHIPPED (W2.C) |
| 7 | Render-pose / coordinate-frame | (existing: `compare-render-corners`) | ✓ SHIPPED |
| 8 | Physics parity | [`physics-parity-method.md`](physics-parity-method.md) | ✓ SHIPPED (W3.A+B+F) |
| 9 | Motion / swing-pose parity | [`motion-parity-method.md`](motion-parity-method.md) | ✓ SHIPPED (W3.C+E) |
| 10 | Texture / surface-chain decode | (planned: `texture-parity-method.md`) | ⨯ Wave 4 — deferred |
| 11 | Mesh / triangulation parity | (planned: `mesh-parity-method.md`) | ⨯ Wave 4 — deferred |
| 12 | Cell-portal graph + PVS | (planned: pending sibling W5.A) | ◐ Wave 5.A — landing 2026-05-20 |
| 13 | Skybox / atmosphere | (planned: pending sibling W5.B) | ◐ Wave 5.B — landing 2026-05-20 |
| 14 | DAT integrity (sha256 + modder rejection) | (sidecar in `scenery-bake`) | ✓ SHIPPED |

The `diag-run-all` driver discovers these dynamically — when a sibling agent ships a new `validate_<surface>.cjs`, the driver picks it up via the `VALIDATORS` list at the top of `run-all-validators.cjs`. The driver's per-row `required: true|false` flag controls whether that surface's failure gates the exit code.

---

## 6. Provenance — what landed when

The waves shipped chronologically:

| Wave | Surfaces | Ship date | Memory entry |
|---|---|---|---|
| Pre-Wave-1 | placements, events, entity-class | 2026-05-14 / 2026-05-17 | various `world-completeness-method` etc. |
| Wave 1 | wire-conformance | 2026-05-19 | [[reference_chorizite_acprotocol_dep_graph_2026-05-19]] |
| Wave 2.A+B | dat-parity Phase A | 2026-05-19 | [[project_wave2ab_done_2026-05-19]] |
| Wave 2.C | enum-parity | 2026-05-19 | [[feedback_enum_parity_audit_2026-05-19]] |
| Wave 2.D | dat-parity Phase B | 2026-05-19 | [[project_wave2d_done_2026-05-19]] |
| Wave 3.A+B+F | physics-replay + jump-formula + prediction | 2026-05-19 | [[project_wave3a_done_2026-05-19]], [[project_wave3f_done_2026-05-19]] |
| Wave 3.C | motion-classify-swing | 2026-05-19 | [[project_wave3bc_done_2026-05-19]] |
| Wave 3.E | motion-parity JS-vs-CS | 2026-05-19 | [[project_wave3e_done_2026-05-19]] |
| Wave 5.A | cell-portal-graph + PVS | 2026-05-20 | (in flight) |
| Wave 5.B | region-skybox + day-night | 2026-05-20 | (in flight) |
| **Wave 5.C** | **diag-run-all + diag-status** | **2026-05-20** | **[[project_w5c_done_2026-05-20]]** |
| Wave 4 | texture/mesh whole-DAT sweep | (out-of-band, multi-hour) | deferred |

Key cross-references:
- [[reference_worldbuilder_terminal]] — command catalog (147 commands today; +2 with W5.C)
- [[project_emit_dynamic_site]] — the runtime under test
- [[feedback_three_source_cross_reference]] — the oracle ranking discipline
- [[feedback_base_dats_only_for_bake]] — sha-pinning oracle for the parser surfaces
- [[feedback_use_external_drives_for_scratch]] — why `/mnt/wbterminal1/` for reports

---

## 7. What this method doc does NOT cover

Same scope-honesty as plan §9. The toolset does not validate:

- **Server-authoritative state** (combat resolution, magic resolution, treasure rolls).
- **Per-frame performance budgets** — see Phase A7/C6/C7 telemetry per [[project_fps_perf_validation_2026-05-19]].
- **Network jitter / packet loss recovery** — wire-conformance covers payload correctness, not transport robustness.
- **User-facing UX** — separate review surface.
- **Modder DATs** — sha-pinning rejects them at bake time.
- **Live multiplayer convergence** — two-client agreement is a separate test.

Anything in this list that needs validation gets a new wave + a new method doc, not an extension of an existing one.

---

## 8. How a future agent picks up the toolset

If you're adding a new surface (e.g. shipping Wave 4):

1. Read [`diagnostic-toolset-plan-2026-05-19.md`](diagnostic-toolset-plan-2026-05-19.md) §6 to find your wave.
2. Write the C# port of the canonical oracle as a new `CommandEngine.<Topic>.cs` partial.
3. Write the matching `validate_<surface>.cjs` Node validator.
4. Write the per-surface method doc `<surface>-method.md`.
5. Add a row to the `VALIDATORS` array at the top of `run-all-validators.cjs` so `diag-run-all` picks it up.
6. Update §5 of THIS doc (the surface inventory).
7. Update memory + plan with a `project_<wave>_done_<date>.md` entry.

The toolset is designed so that adding a new surface is roughly four files + one driver-row append. The Wave 1-5 history above is your template.

---

*End of method doc. The plan in `diagnostic-toolset-plan-2026-05-19.md` is the deeper "how" — this doc is the "what" + the "how to read the results."*
