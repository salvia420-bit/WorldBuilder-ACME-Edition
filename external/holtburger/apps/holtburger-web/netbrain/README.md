# netbrain — unified RynthBrain .NET-wasm AppBundle (D1 path A′)

The production consolidation of the netwasm lift slices
(`docs/rynth-integration/netwasm-spike/`): one browser-wasm AppBundle exposing
the debugged RynthAi C# scoring/scheduling behind the same `RynthWebHost` seam
the JS brain uses. The slice **sources stay in the spike directories** (with
their fixtures + parity harnesses); this project only compiles them together
and serves them to the page.

| Export (`RynthBrainExports`) | Slice source | Boundary |
|---|---|---|
| `scoreTargets(json)` | `netwasm-spike/CombatScoring/TargetScoring.cs` | `ScoringInput -> ScoringOutput`, one target-selection tick |
| `scheduleBuffs(json)` | `netwasm-spike/BuffScoring/BuffScheduling.cs` | `BuffInput -> BuffOutput`, one buff heartbeat |
| `evaluateLoot(json)` | `netwasm-spike/LootScoring/LootScoring.cs` | `LootInput -> LootOutput`, one item classification |
| `version()` | — | `rynth-netbrain-N` (bump on any export/slice change) |

## Build / verify

```sh
./build.sh                 # dotnet publish -> stages ./AppBundle (gitignored, like pkg/)
node replay_fixtures.mjs   # THE gate: replays every committed spike fixture corpus
                           # through the unified bundle; must be N pass / 0 fail
```

`build.sh` needs the `wasm-tools` workload (installed on this laptop; dotnet at
`~/.local/bin/dotnet`). ~30–60 s incremental. The bundle is ~4.3 MB raw with
all three slices (`InvariantGlobalization=true` drops the ~2.6 MB ICU payload
the per-slice spike bundles still carry — `replay_fixtures.mjs` proves the
invariant build still matches the natively-generated expectations
byte-for-byte: 269/269 = combat 46 + buff 129 + loot 94, 2026-07-16).

Measured on this laptop: AppBundle in-page load ~0.5–1.5 s (lazy, off the
boot path); first boundary call ~270–420 ms (one-time mono warmup); steady
state ~1.4 ms/call in node, ~20 ms/call inside a live headless bot tab —
~8% of main thread at the 4 Hz combat-shadow throttle.

Like `pkg/` for the Rust wasm: **AppBundle/ is gitignored — rebuild after a
pull that touches the slice sources**, or the page serves a stale brain.

## Page wiring

`rynth/netbrain.js` loads the bundle lazily and `rynth/bot.js` attaches it to
the loops when `?netBrain=shadow|on` (or `createGrindBot`'s
`config.netBrain`) opts in — see `docs/url-flags.md` and the loop-side
`attachNetBrain` hooks. Divergence accounting lives on
`window.__diag.netbrain` (`.summary()`).

Load failure or a missing bundle NEVER takes the bot down: the JS brain is
always the fallback (console warn + `__diag.netbrain.loadError`).
