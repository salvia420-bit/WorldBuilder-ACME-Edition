# BuffScoring — second .NET-wasm lift slice (2026-07-16)

Follow-up to the CombatScoring slice (`../CombatScoring/README.md`): the next
*largest-value-first* lift — **BuffManager self-buff scheduling** (the report-11
B1–B16 contract: login gate, registry-truth expiry, rebuff threshold, tier
ladders/caps, confirm/no-show valves, batch rebuff, periodic re-sync, pacing,
vital policy), extracted as a pure C# slice with host dependencies replaced by
input DTOs, compiled to browser wasm, and parity-tested against the shipped JS
brain (`apps/holtburger-web/rynth/buff_loop.js` + `vitals.js`, composed in
`kernel.js` order).

## Layout

| File | What |
|---|---|
| `BuffScheduling.cs` (750 L) | The pure lift. One buff heartbeat = `ScheduleBuffTick(BuffInput) -> BuffOutput`; single JSON boundary `ScheduleBuffsJson` (source-gen'd `System.Text.Json`, `IncludeFields=true` — the DTOs are fields). Every block cites its `Combat/BuffManager.cs` (or `SpellManager.cs`) source lines. The game clock is an injected `NowMs`. |
| `wasm/` | `[JSExport]` surface (`scheduleBuffs(json) -> json`, `version()`) + browser-wasm csproj. |
| `fixtures/` | Console runner: 28 deterministic multi-tick scenarios (seed 24680, 944 heartbeats, 77 casts) driven through the SAME JSON boundary the wasm export uses, under a landing simulation (casts land at +500 ms with tier-mapped durations; silent casts never land; vital casts resolve via the simulated "ou cast" chat fast-path at +300 ms). Writes `fixtures.json`. |
| `fixtures.json` | Committed corpus: per scenario the sim setup + tick schedule + C#-computed expected event/cast sequences + up to 8 raw boundary input/output pairs (`calls[]`) for wasm replay. Byte-identical across regenerations (verified with `cmp`). |
| `parity_check.cjs` | Rebuilds the SAME tick schedule + landing sim against the real `buff_loop.js`/`vitals.js` (mock host; frozen `Date.now`; kernel.js vitals-first order, optional `_buffNeeded` gate) and classifies agree / agree-latency / DIVERGE per scenario. Exits nonzero if any scenario contradicts its authored expectation. |
| `run_wasm.mjs` | Loads the published AppBundle in Node and replays ALL recorded boundary calls — proves mono-wasm reproduces native C# (129/129). |

## Reproduce

```sh
# fixtures (any net10 SDK)
dotnet build fixtures/BuffScoring.Fixtures.csproj -c Release --artifacts-path /tmp/bs-art
dotnet /tmp/bs-art/bin/BuffScoring.Fixtures/release/BuffScoring.Fixtures.dll fixtures.json

# JS parity (node >= 20)
node parity_check.cjs

# wasm build (needs `dotnet workload install wasm-tools`) + wasm-vs-native parity
dotnet publish wasm/BuffScoring.Wasm.csproj -c Release --artifacts-path /tmp/bs-art
node run_wasm.mjs /tmp/bs-art/bin/BuffScoring.Wasm/release_browser-wasm/AppBundle
```

Verified on buildbox 2026-07-16: fixtures deterministic (byte-identical rerun),
`NETWASM PARITY: 129/129 boundary calls match native C#`. Bundle: 8.2 MB raw /
2.8 MB gzip (dotnet.native.wasm 2.9 MB, CoreLib 1.2 MB, System.Text.Json
200 KB, the slice itself `BuffScoring.Wasm.wasm` **96 KB**). Same
ICU-dead-weight caveat as CombatScoring (`InvariantGlobalization` would drop
~2.6 MB).

## Parity results (2026-07-16, buildbox): 12 agree (1 latency), 15 diverge, 1 C#-only

Divergences are FINDINGS about the JS subset vs the debugged C# semantics, not
test failures. The whole happy path agrees: initial buff-up order+confirm,
batch realign on one expiring family, expiry threshold boundaries (310 s/295 s),
permanent presence-only, busy gate, mode-switch-then-cast, death recovery when
`buff_loop.tick()` is driven directly, and both seeded grinds.

### Genuine findings (not previously documented anywhere)

1. **B11 parked-family batch retrigger loop — JS livelock**
   (`parked-family-batch-retrigger-loop`): C# `AnyBuffBelowThreshold` skips
   fail-cooldown-parked families (`BuffManager.cs:824-827`, the documented
   /god-loop fix) → after a silent buff parks, the batch completes and goes
   idle (3 casts). JS `_anyBelowThreshold` (`buff_loop.js:315-317`) ignores
   parks → the batch retriggers every pass and **recasts the healthy buff
   forever** (9 casts in a 15 s window, unbounded — mana burn + cast spam).
   C# is right; the JS needs the parked-family skip.
2. **Kernel `_buffNeeded` gate starves B13/B3 — JS never rebuffs once
   all-active** (`kernelgate-expiry-starvation`, `b13-death-recovery-kernelgate`):
   `families` entries store a `remainingS` SNAPSHOT updated only inside
   `tick()` (`buff_loop.js:245-269`), and `kernel.js:55-59` only grants the
   buff loop a tick when `status.active < desired`. All-active → no tick → the
   snapshot never decays and the 30 s re-sync never runs → **no rebuff on
   expiry and no recovery after death**. C# stores expiry *timestamps* and
   runs OnHeartbeat unconditionally. Driving `tick()` directly (no gate) the
   same scenarios agree — the bug is the kernel gate + snapshot combination,
   not buff_loop's own logic. Fix candidates: store expiry timestamps, or have
   `_buffNeeded` return true when `now - lastRefreshAt > 30 s`.
3. **B4 tier-upgrade missing in JS** (`b4-upgrade-after-tier-drop`): after a
   family's active enchant drops to a lower tier (dispel + low-tier recast)
   with hours left, C# `IsBuffActive` compares the stored tier against the
   achieved-capped target (`:1211-1214`) and recasts the better tier
   immediately; JS `_isActiveReal` (`buff_loop.js:289-300`) checks family
   presence+remaining only → sits at the lower tier until natural expiry.
4. **B8 confirm matches spell id, not family — phantom no-show on skill-capped
   Incantations** (`b5-incantation-caps-no-flap`): an Incantation landing as
   tier-VI does not confirm the pending Incantation cast in JS
   (`_isActiveReal` consults `spellFamily`, learned only from landings) → one
   phantom no-show strike + one wasted recast before converging. C# confirms
   by FAMILY (`:555-556`) → single cast. One-line JS fix: confirm via
   `_familyForSpell` (which falls back to spell metadata).
5. **B9 tier-walk-down missing in JS** (`cold-snapshot-tier-down`): on a
   silently-dropped cast C# (cold snapshot) blacklists the id and resolves the
   next lower tier (`:572-573` + `SpellManager.cs:342-358`) — casts VII then I,
   ends buffed. JS recasts the same id twice, parks 30 min, and **stays
   unbuffed** (`buff_loop.js:382-398` has no tier-down).
6. **B16 vital order flipped** (`vitals-order-mana-vs-stam`): C# checks mana
   (Stam→Mana, needs stam>15) BEFORE stamina (`:759-760`); `vitals.js:133-146`
   checks stamina first. With both low, C# burns stamina for mana, JS refills
   stamina — different first cast, different equilibrium.
7. **B15 emergency boundary** (`vitals-emergency-boundary-hp30`): C# fires at
   `hp <= 30` (`:733`), JS at `hp < 30` (`vitals.js:122`) — at exactly 30% C#
   converts stamina to health, JS casts a plain heal.
8. **C# pending hold delays emergency heals ~2.5 s**
   (`pending-buff-blocks-vitals`): C#'s pending block (`:599`) precedes
   CheckVitals, so a silent in-flight buff blocks the B15 emergency until the
   2.5 s no-show valve; the kernel's vitals-first order heals immediately.
   Here the JS/kernel shape is arguably the safer design — flag for a ruling
   rather than "fixing" the JS to match.
9. **B8×B3 confirm-vs-threshold pathology, both sides**
   (`confirm-below-threshold`): a buff landing with less remaining than the
   300 s threshold (contrived: 250 s duration) makes C# confirm-then-rebatch
   **forever** (7 casts in 8 s and counting) while JS counts it a no-show and
   parks after 2. Both wrong, differently; C#'s unbounded loop is the worse
   failure mode. Worth a ruling if any real server has sub-300 s buffs.
10. **B2 same-family wire-order quirk** (`registry-same-family-wire-order`):
    two same-family registry rows (VII@3500 s then V@400 s) — C#
    `RefreshFromLiveMemory` keeps the LAST row (`:1374` dict overwrite) → sees
    V → tier-upgrade recast; JS keeps max-remaining (`buff_loop.js:264-267`)
    → sees VII → idle. Here the **C# last-wins overwrite is the latent bug**
    (faithfully preserved in the slice); JS's max-remaining is more defensible.

### Expected by design (documented JS subset choices, now measured)

- **No skill-tier cap** (`maxtier-skill-cap`): C# caps the walk via
  `GetHighestBuffSpellTier`; JS picks the highest *known* tier (casts VII where
  C# casts V). JS relies on the known-spell book as its only ceiling.
- **No health kits** (`vitals-healthkit-before-heal`): C# tries kits before
  Heal Self (`:754-757`); JS casts Heal Self.
- **JS no-progress valve** (`vitals-no-progress-valve`): deliberate web-port
  addition (`vitals.js:46-53`) — parks a vital axis after 6 no-progress casts
  where C# loops forever (the Heal-Self-I-vs-huge-pool livelock). JS is the
  improvement here; confirmed working (7 casts then park vs C#'s 12+).
- **Vitals not login-gated in JS** (`vitals-emergency-stam-floor`): same spell
  both sides, but C# vitals sit behind the B1 login gate (`:493-519`) — no
  heal until the registry stabilizes; JS heals from tick 0. Cuts both ways.
- **Login-read cadence** (`login-gate-streaming-registry`, agree-latency
  1.25 s): C#'s 1 s read throttle is strict-`>` (`:495`) vs JS `>=`
  (`buff_loop.js:347`) — one extra 250 ms beat per read; outcomes identical.

### Out of parity scope

`armor-no-chat-timeout` exercises the C# armor/no-chat arm (B7/B8: cast →
5 s valve → known spell NOT blacklisted → retry → park) — the JS item-enchant
path is a different mechanism (chat-plane confirm via `onEvent`,
`buff_loop.js:100-143`) and is not comparable tick-for-tick. The slice also
does not model chat/`OnEnchantmentAdded` fast-path confirms for self-buffs
(the registry poll is the authoritative fallback and is exactly what JS
ships), nor `EnsureMagicMode`'s wand-swap/backoff machinery (replaced by the
`InMagicMode` input), nor `BuildDynamicBuffList`'s ordering (the `Desired`
input is pre-ordered).

## Recommended NEXT lift slice

**LootEvaluator rule matching** (`Loot/VTankLootEvaluator.cs` +
`Loot/LootEvaluator.cs`, vs `apps/holtburger-web/rynth/loot_loop.js`): pure
rule-predicate evaluation (item properties in → keep/salvage/no-loot verdict +
matched-rule reasons out), no clock at all, and the web side ships a fresh
independent implementation — exactly the profile where this fixture pattern
found 10 findings here and 8 in CombatScoring. Effort: comparable to this
slice (~1 week-equivalent of the same pattern: the DTO surface is wider — item
property bags — but there is no multi-tick state machine, so the harness is
simpler; single-call fixtures like CombatScoring's rather than tick threading).
Runner-up: the cast serializer / face gate (P-rules) from CombatManager, but
it is timer-heavy and lower-value per line.
