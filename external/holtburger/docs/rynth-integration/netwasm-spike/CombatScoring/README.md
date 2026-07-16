# CombatScoring — first real .NET-wasm lift slice (2026-07-16)

Follow-up to the netwasm-spike D1 PASS (`../README.md`): the first
*largest-value-first* lift per report 15 — **CombatManager target
scoring/selection** (the T2 filter chain + T7/T8 utility scoring + T9/T10 lock
rules), extracted as a pure C# slice with host dependencies replaced by input
DTOs, compiled to browser wasm, and parity-tested against the shipped JS brain
(`apps/holtburger-web/rynth/combat_loop.js`).

## Layout

| File | What |
|---|---|
| `TargetScoring.cs` (355 L) | The pure lift. One selection tick = `SelectTargetTick(ScoringInput) -> ScoringOutput`; single JSON boundary `ScoreTargetsJson` (source-gen'd `System.Text.Json`, `IncludeFields=true` — the DTOs are fields). Every block cites its `Combat/CombatManager.cs` source lines. |
| `wasm/` | `[JSExport]` surface (`scoreTargets(json) -> json`, `version()`) + browser-wasm csproj. |
| `fixtures/` | Console runner: 46 deterministic scenarios (seed 12345) → `fixtures.json` with C#-computed expectations. Runs through the SAME JSON boundary the wasm export uses. |
| `fixtures.json` | Committed fixture corpus (inputs + expected C# outputs). Byte-identical across regenerations. |
| `parity_check.cjs` | Replays fixture inputs against the real `combat_loop.js` (mock RynthWebHost mirroring `webhost.js` contracts incl. its fail-closed `ObjectIsAttackable`) and classifies agree / agree-after-1-tick / DIVERGE per contract rule. |
| `run_wasm.mjs` | Loads the published AppBundle in Node and replays ALL fixtures through wasm — proves mono-wasm reproduces native C# (46/46). |

## Reproduce

```sh
# fixtures (any net10 SDK)
dotnet build fixtures/CombatScoring.Fixtures.csproj -c Release --artifacts-path /tmp/cs-art
dotnet /tmp/cs-art/bin/CombatScoring.Fixtures/release/CombatScoring.Fixtures.dll fixtures.json

# JS parity (node ≥20)
node parity_check.cjs

# wasm build (needs `dotnet workload install wasm-tools`) + wasm-vs-native parity
dotnet publish wasm/CombatScoring.Wasm.csproj -c Release --artifacts-path /tmp/cs-art
node run_wasm.mjs /tmp/cs-art/bin/CombatScoring.Wasm/release_browser-wasm/AppBundle
```

Verified on buildbox 2026-07-16: fixtures deterministic (byte-identical rerun),
`NETWASM PARITY: 46/46 scenarios match native C#`. Bundle: 8.3 MB raw /
2.9 MB gzip (dotnet.native.wasm 2.8 MB, CoreLib 1.2 MB, System.Text.Json
205 KB, the slice itself `CombatScoring.Wasm.wasm` **63 KB**). ICU data
(~2.6 MB of the raw size) is dead weight for this slice —
`<InvariantGlobalization>true</InvariantGlobalization>` would drop it; left in
to keep the bundle representative of a multi-slice future.

## Parity results (2026-07-16, buildbox): 23 agree, 2 agree-after-1-tick, 21 diverge

Divergences are FINDINGS about the JS subset vs the debugged C# semantics,
not test failures. Classified:

### Expected by design (JS is a documented "faithful minimal subset")
- **T7 scoring formula** — C# `dist(0-100 over range) + hp(0-50) + threat(30) +
  facing(0-10)`; JS `100 - d`. Diverges whenever hp/facing/threat decide
  (`wounded-far-vs-healthy-near`, `facing-behind-vs-ahead`, 4/10 shared-domain
  grind randoms).
- **T2 range constants** — JS hardcodes 40 yd + same-landblock; C# uses
  `MonsterRange` 50, cross-LB global distance, and T3 disengage hysteresis
  (`distance-45`, `cross-landblock-neighbor`, `engaged-hysteresis-55-with-alt`).
- **JS input gaps** — no blacklist, no user never-attack list, no T5
  spell-projectile name filter (`blacklisted-mob`, `user-never-attack`,
  `spell-projectile-excluded`).

### Genuine findings (not previously documented anywhere)
1. **T9 stickiness scale mismatch** (`stickiness-switch`): the tuned
   `TARGET_SWITCH_STICKINESS=25` assumed C#'s 2-pts-per-yard distance score;
   `combat_loop.js:179` scores 1 pt/yd, so the JS lock is ~2× stickier in
   distance terms — a 23-yd-closer alternative switches in C#, holds in JS.
   C# is the tuned/debugged behavior.
2. **T10 grace vs immediate re-lock** (`scan-grace-with-alternative`): C#'s
   grace only *retains* the lock when nothing else is scanned — with an
   alternative visible, `HandleCombatTrigger` re-locks immediately (the absent
   lock gets no +25). `combat_loop.js:204-210` returns the locked id
   unconditionally through the full 1500 ms grace. C# behavior is what T10 was
   tuned for (grace prevents *nav handoff*, not target switching).
3. **T12 vanished-entity false kill** (`scan-grace-hold-no-alternative`):
   `combat_loop.js:308-321` kill-confirms when `TryGetObjectPosition` returns
   null — a transient entityMap miss counts a phantom kill and 30 s-suppresses
   a live mob. C# treats world-filter null as a transient miss and holds
   through grace.
4. **T4 attackable fail-open vs fail-closed** (`attackable-unknown-t4`):
   RynthAi's hard-won ruling is weenie-null → attackable (Review §1.2-1.3);
   `webhost.js:346-349` deliberately fails closed on unknown desc flags. On
   web the flags are protocol-fed so the window is small, but a fresh-spawn
   flags race reproduces the exact "stares at a monster" bug T4 fixed.
5. **T13 kill-suppression TTL** (`recently-killed-6s`): C# 4000 ms
   (`RECENTLY_KILLED_SUPPRESS_MS`), JS 30 000 ms (`RECENTLY_KILLED_TTL_MS`,
   `combat_loop.js:17`) — a mob that respawns/survives inside 4-30 s is
   re-engageable in C#, ignored by JS.
6. **T8 first-match vs max** (`priority-first-match-vs-max`): C# takes the
   FIRST matching monster rule in list order (`FirstOrDefault`,
   `CombatManager.cs:2228`); JS takes the max across all matching keys
   (`combat_loop.js:185-194`). Overlapping rules ("olthoi" + "olthoi soldier")
   pick different targets.
7. **T7 unknown-HP bonus quirk** (`unknown-hp-full-bonus`): C#
   `GetHealthRatio` returns −1 before any health update
   (`WorldObjectCache.cs:206`); `ScoreCandidate` clamps −1→0, granting an
   unknown-HP mob the FULL 50-pt wounded bonus. Preserved faithfully in the
   lift; arguably a latent C# bug worth a ruling.
8. **T9 exact-tie semantics** (`stickiness-exact-tie`): at exactly
   locked+25, C#'s argmax lets the earlier-in-scan-order (nearer) candidate
   win → switch; JS's strict `>` holds. Edge-case only.

### Agree-after-1-tick (cadence, not outcome)
C# validation drops a dead/corpsed lock and re-locks the alternative in the
SAME tick; JS needs its `tick()` kill-check plus one more `_selectTarget`
(`locked-validation-corpse`, `locked-died-hp0-with-alt`).

## Caveat — what this parity harness is NOT

It drives `_scanTargets`/`_selectTarget` (plus a faithful one-check emulation
of `tick()`'s kill branch) against a mock host under a frozen `Date.now`. It
does not exercise the cast serializer, face gate, mode transitions, or the
event-fed damage learning — those are pacing (P-rules), not selection, and
belong to later slices/fixtures.
