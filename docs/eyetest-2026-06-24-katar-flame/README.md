# Eye-test — Burning Sands Katar default_script flame (Track B) — 2026-06-24

Real-GPU visual validation of the `?setupDefaultScript=on` feature (honor `SetupModel.default_script`
on dynamic-entity spawn). Run on the **GTX 1070** (headless, off-screen) against the laptop's live
`serve.py` over the reverse tunnel, with the rebuilt wasm (`fetchSetupDefaultScript`) + index.html wiring.

## Result: PASS (chain attaches + renders on real GPU)
- **renderer:** `ANGLE (NVIDIA GeForce GTX 1070 ... Direct3D11)` — real GPU, not software.
- in-world in ~7s (outdoor Holtburg `0xa9b40019`), `@create 44265` → katar `0x800041d7`.
- **`chainAttached: true`** — the Track B spawn arm fired end-to-end: `fetchSetupDefaultScript(0x0200051C)`
  → `0x33000347` → `_attachParticleChainForEntity` attached the emitters (`0x3200026E`/`0x32000270`).
  This is the runtime proof of the whole pipeline.

## Images
- `katar-flame-a.png`, `katar-flame-b.png` — two frames ~2.5 s apart (the effect animates between them →
  live particles). Camera framed on the katar node (cameraSwitcher.tick wrapped to re-aim each frame).

## Open question for review (FIDELITY, not function)
The rendered effect reads **blue/cyan, not fire-orange**. It is NOT the white-box null-material bug (it
renders a real material). It is either (a) the emitter's actual data color, or (b) a particle
color/material resolution deviation. Resolving needs a parse of emitter `0x3200026E`'s gfxobj→surface
chain (no dat-tool 0x32 specialist yet). The framing is also a bit wide/cluttered (background Holtburg
buildings) — a tighter re-shot is easy if wanted.

See `katar-flame-report.json` for the full run record + console tail.
Feature: `docs/PLAN-item-magic-effect-visuals-2026-06-24.md` · `docs/RESULTS-item-magic-effect-visuals-2026-06-24.md`.
