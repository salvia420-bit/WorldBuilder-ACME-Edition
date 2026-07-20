# perf loop — explorer discovery → deterministic A/B → self-improvement

Turns the AI explorer's roaming into a **self-feeding, prompt-proof** performance
loop that hands this Claude Code session a ranked offender to fix each turn, then
judges the fix by measurement — never by the model's word.

Background: `docs/rynth-integration/HANDOFF-explorer-perf-loop-2026-07-19.md`.

## The one design invariant

**The prompt decides only WHICH content gets sampled (coverage). Every verdict —
"this landblock is slow", "this build is faster" — is made deterministically
here.** So a prompt rewrite changes the *sample distribution* and can never change
a *verdict*. The measurement half (`measure`/`gate`) uses `followRoute` replay and
has **no LLM in the path**. Keep that wall intact: any place the loop trusts the
model for a number is a bug.

## Pieces

| file | role | infra |
|---|---|---|
| `perf_sampler.cjs` | in-page collector, emits `[perfsample]` console lines | injected in browser |
| `perf_aggregate.cjs` | pure: parse → rank → gate → tour-slice | none |
| `perf_aggregate.selftest.cjs` | `node perf/perf_aggregate.selftest.cjs` (14 checks) | none |
| `../perf_loop.cjs` | driver CLI: `soak / rank / measure / gate / status` | browser for soak/measure |

Runtime artifacts (`loop-state.json`, `samples-*.jsonl`, `arm-*.json`) are
`.gitignore`d. The generated league (`docs/rynth-integration/perf-league.md`) IS
committed — it's the shareable ranked doc.

## The loop

```
# 0. (once) build release wasm; ls -la pkg/*.wasm  → ~4.5MB, not ~18MB (dev = 4× tax)
PW=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules   # Playwright on NODE_PATH

# 1. SOAK — launch the HEADLESS explorer + sampler (DISCOVERY, prompt-driven).
#    soak_launch.cjs pre-seeds the OpenRouter key and enforces the coverage floor.
NODE_PATH=$PW node perf/soak_launch.cjs --out perf/samples-$(date +%s).jsonl --account phase4demo
#    (perf_loop.cjs soak also exists to tap an already-running page via --url.)

# 2. RANK — jsonl → committed league + loop-state topOffender (pure, no browser)
node perf_loop.cjs rank --in perf/samples-*.jsonl
node perf_loop.cjs status         # ← THIS session reads NEXT here

# 3. TOUR — auto-build a replayable perf tour from the worst bins (fork #1, pure)
node perf_loop.cjs tour --in perf/samples-*.jsonl --top 3 --control 1 --name perf-tour-v1

# 4. FIX — implement the top offender, Rust-first, in a worktree (this session's job)

# 5. MEASURE — replay the tour on OLD then NEW build (fresh profile per run, release wasm).
#    Use the auto-built tour, or the v16 Arwic→Town-Network→Holtburg leg route.
NODE_PATH=$PW node perf_loop.cjs measure --route rynth/testdata/perf-tour-v1.json \
    --runs 3 --render wireframe --out perf/arm-base.json    # on OLD build
#   ... swap in the fix, rebuild release wasm ...
NODE_PATH=$PW node perf_loop.cjs measure --route rynth/testdata/perf-tour-v1.json \
    --runs 3 --render wireframe --out perf/arm-cand.json    # on NEW build

# 6. GATE — ACCEPT / REGRESSION / INCONCLUSIVE; appends to the tried ledger (pure)
node perf_loop.cjs gate --base perf/arm-base.json --cand perf/arm-cand.json
#   ACCEPT → keep the fix, promote arm-cand to the new baseline. else → revert.

# 7. loop.
```

## `loop-state.json` — the cross-session bridge

Read by `status` at the top of each turn; written by `rank` (topOffender/league)
and `gate` (lastVerdict/tried). Shape:

```json
{
  "updatedAt": "...", "league": "docs/rynth-integration/perf-league.md",
  "baselineRoute": "rynth/testdata/v16_arwic_holtburg_route.json",
  "topOffender": { "lb": "0xA9B4", "p95_med": 81, "draw_med": 1200, "tri_med": 1800000, "dwellSec": 25 },
  "lastVerdict": { "cand": "...", "result": { "verdict": "ACCEPT", "improvePct": 10.4 } },
  "tried": [ { "lb": "0xA9B4", "cand": "...", "verdict": "ACCEPT" } ],
  "next": "Profile landblock 0xA9B4 …"
}
```

The `tried` ledger is the loop-until-dry seen-set: don't re-propose a rejected
change. `next` is the plain-language instruction for whoever (human or agent)
owns the fix.

## Measurement rules baked into `measure` (the traps ARE the design)

- **Release wasm only** — refuses a >8MB (dev) `pkg` build.
- **Fresh throwaway profile per run** — separate `chromium.launch()` each run, so
  arm 2's shader cache doesn't warm from arm 1.
- **Real frames** — `nullRender=0` always (nullRender skips `render()`, so it can't
  measure frame time). `--render wireframe` profiles the CPU/submission path
  (sky/composer/CSM/shadows skipped); `--render default` catches shading
  regressions. Run at least one of each before accepting.
- **Uncapped fps** — no `targetFps` cap, so gains show above any ceiling.
- **Timing via console markers, never evaluate round-trips** — `[perftour] start`
  / `done` are stamped on driver arrival; evaluate responses starve for tens of
  seconds on a busy renderer.
- **75s park between runs** — ACE server-side logout after relaunch takes ~40s+
  (Account-In-Use).
- **Stream OFF during measurement** — x11grab+encode steals CPU. Don't run
  `measure` arms while the YouTube soak/ffmpeg is up (`touch /mnt/wbterminal2/stream/STOP`).
- The **laptop SwiftShader** arm measures CPU/submission; the **1070** measures GPU
  (batched, off-screen, per fleet rules). Tag which plane a verdict came from.

## Gate semantics

`ACCEPT` requires BOTH (a) median improvement in the headline metric (`routeMs`,
end-to-end, hard to game) ≥ `--min`% AND (b) distribution non-overlap (candidate's
worst run beats baseline's best). Overlapping noise → `INCONCLUSIVE`; a slowdown →
`REGRESSION` (exit 2). `p95` is reported alongside so a shading-only regression
can't hide behind a route-time win.

## Fork #1 — auto-sliced perf tour (BUILT)

The sampler emits full pose (`pos: {lb,x,y,z}`) per sample; `rank` keeps the pose
of each landblock's **worst frame** as a representative waypoint; `tour` assembles
the top offenders + a healthy control into a `perf-tour-vN.json` (`kind:
"waypoints"`) — no live recording pass needed. `measure` detects a waypoint tour
and drives `window.__bot.goto()` through the waypoints (instead of `followRoute`),
timing the goto-chain. Build one from a soak:

```
node perf_loop.cjs tour --in perf/samples-*.jsonl --top 3 --control 1 --name perf-tour-v1
#   -> rynth/testdata/perf-tour-v1.json ; loop-state baselineRoute set
```

Landblocks sampled before pose emission (or where `TryGetPlayerPose` was null)
have no waypoint and are dropped with a note — soak longer to fill them in.

## Fork #2 — coverage floor / prompt insurance (BUILT, in `soak_launch.cjs`)

The prompt's only job is coverage; a wedged or weak director must not stall the
loop. `soak_launch.cjs` tracks a seen-LB set and, when **no new landblock appears
within `COVERAGE_FLOOR_MS` (4 min)** — or the explorer is fully wedged (no move +
no LLM call ×3) — issues `@telepoi <next POI>` (Developer command; the soak
account is accessLevel 4) to jailbreak to fresh content. The rotation leads with
the two known offenders (Town Network, Marketplace) then cycles diverse towns, so
discovery keeps hitting hard content regardless of what the director chooses. Loop
PROGRESS is thereby decoupled from prompt QUALITY. Health lines show `seen=` and
`coverAge=`; jailbreaks log `JAILBREAK #n -> @telepoi <poi> (<why>)`.
