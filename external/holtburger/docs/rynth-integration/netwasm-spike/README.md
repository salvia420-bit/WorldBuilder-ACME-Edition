# D1 fork spike — .NET-to-wasm compile (S0.3): RESOLVED PASS (2026-07-16)

The synthesis's load-bearing open question (§1, D1): can the island-excised
RynthAi brain compile to and RUN in browser wasm? If yes, the ~41k debugged
C# lines land in-page (path A′) and the RynthCoreHost mapping becomes the
literal build target; if no, fall to a JS rewrite (path B).

## Result: it compiles AND executes.

`BrainSlice.cs` — a dependency-free slice in the RynthAi target-scoring shape
(report 11 utility-AI score + the P3 face-settle gate), exposed via
`[JSExport]`. Built with `dotnet publish -c Release -r browser-wasm` after
`dotnet workload install wasm-tools` (dotnet 10.0.203, local laptop).

`run.mjs` loaded the AppBundle in Node and called the exports:
```
{"v":"brain-slice-netwasm-1","s1":95,"s2":143,"settle":true}
NETWASM EXEC: PASS
```
s1/s2/settle match the C# arithmetic exactly — the debugged logic ran
unmodified through the mono-wasm runtime.

## The numbers that decide A′ vs B

- Runtime payload: **~4.1 MB** (dotnet.native.wasm ~3.0 MB + System.Private.
  CoreLib ~1.1 MB), roughly the size of the existing holtburger-web release
  wasm — a one-time per-page cost, cacheable, not per-tick.
- `[JSExport]`/`[JSImport]` is the clean seam: C# brain <-> the JS
  RynthWebHost. No Marshal, no threads, no Win32 in the ported logic (the
  ~111 irreducible island lines, report 08, are excised — not compiled).
- Build: `wasm-tools` workload + browser-wasm RID; ~30-60s incremental.

## Verdict for D1

**A′ (.NET-wasm in-page) is viable.** The JS reimplementation built this
session (webhost + combat/buff/loot/kernel loops) is the working bot TODAY
and proves the seam; A′ is now a de-risked option for preserving the full
C# investment rather than porting rule-by-rule. Recommend: keep the JS
brain as the shipping path, and pursue A′ incrementally — compile
RynthAi's pure-tier files (report 15's ~13k Tier-A lines) to wasm behind
the same RynthWebHost seam, largest-value-first (CombatManager scoring,
BuffManager scheduling), each validated against the JS behavior.

Full AppBundle not committed (7.9 MB); reproduce with the two source files
+ the workload install above.

## 2026-07-16 (later session): A′ DELIVERED

Three slices exist (`CombatScoring/`, `BuffScoring/`, `LootScoring/` — each with
fixtures + JS parity + wasm parity) and consolidate into the production bundle
at `apps/holtburger-web/netbrain/` (unified `[JSExport]` surface, ICU-free,
`replay_fixtures.mjs` 269/269 vs native C#), loaded in-page behind the same
seam via `rynth/netbrain.js` + `?netBrain=shadow|on`. The slice SOURCES stay
here with their harnesses; the netbrain csproj `Compile Include`s them.
