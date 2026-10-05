# Archive: historical handoffs and status logs

**Everything in this directory is history. Don't treat any of it as
instructions.** For the current entry point, read
[`../../HANDOFF.md`](../../HANDOFF.md).

On 2026-10-05, 82 documents were moved here with `git mv`, so `git log --follow`
still shows their history. They are:

- dated agent handoffs (`HANDOFF-*`, `*handoff*`)
- session status and progress logs (`2026-06-16-hud-fixes-loop-progress.md`,
  `2d-pixi-retirement-PROGRESS.md`)
- three of the four `newprompts/` entries

Each file keeps its path relative to `external/holtburger/`. For example,
`apps/holtburger-web/docs/HANDOFF-portalpunch-indoor-render-2026-07-06.md` now
lives at
`docs/archive/apps/holtburger-web/docs/HANDOFF-portalpunch-indoor-render-2026-07-06.md`.
Markdown links between archived files may be broken. Links from archived files
to live files are relative to the old location.

These documents describe the state of the code on the day they were written.
Many of their "open issues" have since been fixed, and many of their flag
defaults have flipped. Before relying on any claim, check it against the code
and [`apps/holtburger-web/docs/url-flags.md`](../../apps/holtburger-web/docs/url-flags.md).

## Left in place on purpose

These handoffs are cited by filename from code (`.js` / `.rs` / `.mjs` /
`.cjs` / `.py` / `.sh` / `.html`), so moving them would break those comments
and tests. They are just as historical as the files here.

- `apps/holtburger-web/DISMEMBERMENT_HANDOFF.md`
- `apps/holtburger-web/OPTICAL_EFFECTS_HANDOFF.md`
- `apps/holtburger-web/docs/2026-06-28-cross-lb-atlas-feedbug-handoff.md`
- `apps/holtburger-web/docs/2026-08-05-1070-black-flicker-and-renderer-oom-handoff.md`
- `apps/holtburger-web/docs/2d-pixi-retirement-HANDOFF.md`
- `apps/holtburger-web/docs/reengineering/impl/HANDOFF-2026-08-13.md`
- `docs/HANDOFF-1070-vistest-2026-08-01.md`
- `docs/HANDOFF-relief-v2-2026-07-31.md`
- `docs/HANDOFF-texture-pipeline-2026-08-04.md`
- `docs/rynth-integration/HANDOFF-metanav-2026-07-20.md`
- `docs/rynth-integration/HANDOFF-playtester-soak.md`
- `docs/rynth-integration/HANDOFF-playtester-soak-4.md`
- `docs/rynth-integration/HANDOFF-playtester-soak-8.md`
- `docs/rynth-integration/HANDOFF-playtester-soak-11.md`
- `docs/rynth-integration/HANDOFF-remediation-2026-07-23.md`
- `docs/rynth-integration/HANDOFF-surveyor-round2-2026-07-21.md`
- `docs/rynth-integration/HANDOFF-wasm-threads-SAB-2026-07-20.md`
- `docs/rynth-integration/HANDOFF-wasm-threads-SAB-2026-07-24.md`
- `docs/rynth-integration/HANDOFF-wedge-closeout-phi4-rig-2026-07-20.md`
- `scripts/net-review/HANDOFF-perf-particles-rp6-leak-2026-07-15.md`
- `scripts/net-review/HANDOFF-perf-particles-second-pass-2026-07-15.md`
- `newprompts/physics-deep-dive-2026-06-01/`: kept as a whole, because
  `test_pure_smooth_prediction.mjs` cites its `verified-comparison-report.md`.
