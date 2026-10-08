# external/holtburger docs index

_Rewritten 2026-10-05. Every path below was checked to exist on that date._

**Start with [`HANDOFF.md`](HANDOFF.md).** It covers what holtburger is, the
repo layout, how to build, serve and play it (locally and remotely), how to
test it, the architecture, the URL-flag rules and the current open issues.

## Still-current references

| Doc | Use it for |
|---|---|
| [`apps/holtburger-web/docs/url-flags.md`](apps/holtburger-web/docs/url-flags.md) | The single canonical list of URL flags: each flag's reader, its default, and §0 (the deliberately off-by-default flags and what would flip them). |
| [`apps/holtburger-web/harness/README.md`](apps/holtburger-web/harness/README.md), [`COVERAGE.md`](apps/holtburger-web/harness/COVERAGE.md) | The test-harness tiers (host JS, cargo, Playwright) and which flag each test covers. |
| [`apps/holtburger-web/docs/HANDOFF-openac-comparison-2026-10-08.md`](apps/holtburger-web/docs/HANDOFF-openac-comparison-2026-10-08.md), [`openac-comparison-2026-10-08/`](apps/holtburger-web/docs/openac-comparison-2026-10-08/) | The latest retail-parity comparison (2026-10-08, rounds 1-4 + follow-ups): 32 behaviour areas, 153 verified findings: 115 shipped, plus 7 deferred findings shipped as follow-ups. Eye-test queue, deferred findings, the resume prompt. |
| [`apps/holtburger-web/docs/openac-comparison-2026-10-04/`](apps/holtburger-web/docs/openac-comparison-2026-10-04/) | The previous retail-parity comparison: collision, doors, combat, remote motion, perf. |
| [`apps/holtburger-web/docs/RETAIL-PORTAL-RENDERER-AND-CELL-TERRAIN-WATER-RELATIONSHIPS.md`](apps/holtburger-web/docs/RETAIL-PORTAL-RENDERER-AND-CELL-TERRAIN-WATER-RELATIONSHIPS.md) | How retail's portal and cell renderer works. Background for the portal punch and seal. |
| [`apps/holtburger-web/docs/reengineering/SPEC.md`](apps/holtburger-web/docs/reengineering/SPEC.md) (and `pass-*.md`, `TRACKING.md`) | The 2026-08 rendering/streaming re-engineering spec. Many of the stage flags (`texWorkers`, `frameWork`, …) come from it. |
| [`docs/motion-table-acclient-audit-2026-05-19.md`](docs/motion-table-acclient-audit-2026-05-19.md) | Audit of all 436 retail motion tables against `acclient.c`. Cited by the `holtburger-dat` tests. |
| [`docs/quality-presets.md`](docs/quality-presets.md) | The quality-preset matrix. Cited by `scene3d/quality.js`. |
| [`dats/README.md`](dats/README.md) | Recipe for generating the HBA fixture. |
| `crates/*/ARCHITECTURE.md`, [`apps/holtburger-wsbridge/ARCHITECTURE.md`](apps/holtburger-wsbridge/ARCHITECTURE.md), [`crates/holtburger-protocol/FIXTURES.md`](crates/holtburger-protocol/FIXTURES.md) | Per-crate design notes. Still accurate for protocol, session, DAT and the bridge. |
| [`VENDORED.md`](VENDORED.md) | Provenance of the fork from `merklejerk/holtburger`. |
| [`apps/holtburger-web/README.md`](apps/holtburger-web/README.md) | Build and verify notes for the wasm crate. |

## Stale but kept

- [`README.md`](README.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md) describe the
  upstream TUI client, as of 2026-05-03. They are accurate for the CLI and the
  crate roles, and say nothing about the web client.
- Dated design and investigation docs under `docs/` and
  `apps/holtburger-web/docs/` are point-in-time records. Many are still cited
  from code comments, so they stay where they are. Check any claim in them
  against the code before acting on it.
- A few handoff documents are still cited by filename from code, so they were
  **not** archived, for example:
  - `apps/holtburger-web/OPTICAL_EFFECTS_HANDOFF.md`
  - `apps/holtburger-web/docs/reengineering/impl/HANDOFF-2026-08-13.md`
  - `apps/holtburger-web/docs/2d-pixi-retirement-HANDOFF.md`

  [`docs/archive/README.md`](docs/archive/README.md) has the full list.

## Archive

[`docs/archive/`](docs/archive/README.md) holds the superseded handoffs, status
logs and `newprompts/` agent prompts. They are historical only.
