# rynth/ai — v1 integration review (commit 3355ca46)

Task-B6 review of the AI director as landed. Scope: `llm_client.js`,
`observe.js`, `actions.js`, `director.js`, `journal.js`, `ui.js`, the
`bot.js` / `control_channel.js` wiring, plus the wasm chat lane the `say`
action ends up on. Verified on the buildbox: the whole v1 unit suite is
green (`client 55, observe 51, actions 99, director 57, journal 45, ui 34;
0 fail`). Untracked in-flight files from the current fan-out
(`providers.js`, `tools/`, `eval/`) are other agents' and are NOT reviewed
here.

**Overall verdict:** v1 is solid. The "executor never throws / bot survives
the LLM being wrong" invariant holds on every path I traced; failure paths
consistently degrade to "bot keeps grinding untouched". The findings below
are (1) one construction-time exception the invariant does NOT cover,
(2) one LLM-facing action that can't be used correctly as documented, and
a tail of small risks.

## 1. Seams the B1–B5 additions should use

These are the extension points that exist TODAY, no v1 edits needed:

- **`RynthAiDirector` injectable deps** (director.js:41-47):
  `{ client, journal, observe, execute, validate, systemPrompt }`. This is
  the composition seam for almost everything:
  - **observation enrichment** (B6): wrap `observe` —
    ```js
    const aiState = {};                       // trend history lives here
    new RynthAiDirector(bot, { ...,
      observe: (b, o) => enrichObservation(b, buildObservation(b, o), { ...o, state: aiState }),
    });
    ```
    `enrichObservation` (observe_ext.js) returns the base result unchanged
    on any error, so the wrap is strictly additive.
  - **new/extended actions**: wrap `validate` + `execute` with functions
    that try an extension table first and fall back to the v1
    `validateAction`/`executePlan`. Keep the v1 shape: validator is
    shape+bounds only, executor never throws, every action gets a
    `{type, ok, ...}` result row.
  - **provider selection / tool loops** (B-providers, B-tools): wrap
    `client` — the director only calls `client.chat(messages)` and reads
    `client.spend` (director.js:147-150, 255), so anything duck-typing
    those two is a drop-in.
  - **prompt extensions** (knowledge blurbs, tool catalogs): pass
    `systemPrompt` (default = `DEFAULT_SYSTEM_PROMPT`, director.js:20-37).
    Prefer `DEFAULT_SYSTEM_PROMPT + "\n\nEXTRA..."` over rewriting it — the
    reply contract and cost-discipline text are load-bearing.
- **`wireAiDirector` in bot.js:183-255** — the ONE place the live stack is
  composed. Extensions that need to be on by default in a page must be
  added here (see next-slice #3). Note the passthrough is deliberately
  narrow (SPEC §Wiring): only `apiKey/baseUrl/model/intervalMinutes/dryRun/
  autoStart` flow from `config.ai`; anything else (systemPrompt,
  maxCallsPerHour, a custom observe) currently requires constructing the
  director yourself.
- **`control_channel.js` `getAi` hook** (control_channel.js:47,137-181) —
  lazy `() => bot.ai?.director`, already try/caught. New chat subcommands
  belong in the `case "ai"` switch; follow the `_reply` rate-limit shape.
- **`window.rynthAI`** (bot.js:241-250) — console surface; add new
  console-facing helpers here, not as new globals.
- **journal `kind` set is closed** (journal.js:5): `plan|result|note|error|
  budget`; unknown kinds are coerced to `"note"` (journal.js:21). A new
  subsystem wanting its own kind must extend `KINDS` (journal owner) or
  accept the coercion.
- **Private-API couplings to know about**: observe.js deliberately reads
  `combat._scanTargets()` (observe.js:129), `vitals._fractions()`
  (observe.js:90) and `kernel.status` — these private members are now
  LOAD-BEARING for the AI; renaming them in the rynth loops will silently
  degrade the observation to "n/a" (it won't throw). Grep `rynth/ai/` when
  refactoring the loops.

## 2. Findings (bugs / risks — cited, NOT fixed here)

**F1 (MED, real): AI wiring failure can abort the whole bot construction.**
`createGrindBot` does `await wireAiDirector(bot, config.ai, base)` with no
try/catch (bot.js:167), and `wireAiDirector` awaits dynamic imports of the
ai modules (bot.js:210, 216-220). A broken/stale deploy of any ai module
(or a failing `ui.js` import on the `?aiPanel=1` bootstrap path) rejects
`createGrindBot` — the bot never exists. This is the one place the "bot
survives the AI being broken" invariant does not hold. One-line fix at the
call site: `try { await wireAiDirector(...) } catch (e) { console.warn(...) }`.

**F2 (MED, real): `goto_lb` misroutes on the natural "landblock" reading.**
The catalog tells the LLM `lb` is a "landblock hex string or number"
(actions.js:18) and the validator accepts 1-8 hex digits (actions.js:56-58).
But the nav sidecar requires a full u32 **objCellId** whose HIGH word
places the point (rynthnav-sidecar/Program.cs:200-209,
DetourRouter.cs:150). An LLM sending the 4-digit landblock word — e.g.
`"A9B4"`, the obvious reading — becomes `0x0000A9B4`, whose high word is
`0x0000`: the route targets the map-corner landblock 0x0000. In practice
the sidecar has no tile there, so the goto fails `ok:false` and journals
(safe degradation), but it means `goto_lb` is effectively unusable as
documented unless the model happens to echo the full 8-digit cell id from
the observation's `pos:` line. Fix for the actions.js owner: normalize
`lb <= 0xFFFF ? lb << 16 : lb` in the executor (actions.js:128) and/or
change the catalog text to "full objCellId, e.g. 0xA9B40015". (x/y are
also unbounded in the validator; the sidecar rejects outside [0,192) —
degrades fine, but bounds in the catalog would save wasted actions.)

**F3 (LOW, stale comment / confirmed-safe design):** control_channel.js:82-84
claims "WriteToChat is display-only" — true for retail RynthCoreHost, but on
the web seam BOTH `WriteToChat` and `InvokeChatParser` alias to
`sessionHandle.sendChat` (webhost.js:67-68), which enqueues
`GameAction::Talk` (src/lib.rs:32207, 44184-44198). Consequences:
(a) the AI `say` action IS world-visible speech, not local display — the
README's description is accurate by luck of the alias; (b) the "@" refusal
(actions.js:93) is load-bearing at ACE's parser, which treats `@`-prefixed
Talk as admin commands — the guard is correct AND sufficient, since
`/`-prefixed text is NOT parsed by GameActionTalk (lib.rs:44189-44196:
slash commands only exist in the JS chat panel's submit path). Update the
stale comment when that file is next touched.

**F4 (LOW): budget-skip journal churn at short intervals.** With
`next_check_minutes: 1` sustained, 12 calls burn in 12 min and then every
1-min check-in writes a `budget` entry (director.js:124-128) — up to ~48
entries/hour rolling the 200-entry journal. Consider rescheduling a
budget-skip at `max(intervalMinutes, time-until-window-frees)` instead of
`intervalMinutes`, or coalescing consecutive budget entries.

**F5 (LOW): panel interval edit doesn't touch the pending timer.**
ui.js:120-127 sets `director.intervalMinutes`, which only applies at the
NEXT reschedule; the currently-armed check keeps its old delay, and the
LLM's `next_check_minutes` overrides it anyway. Cosmetic, but users will
read the input as "takes effect now".

**F6 (LOW): dryRun swallows `set_checkin`.** dryRun synthesizes results
without `result.minutes` (director.js:179), so the set_checkin scan
(director.js:198-204) finds nothing and only `next_check_minutes` applies.
Defensible (dry-run executes nothing) — just document it if anyone builds
eval tooling that asserts interval changes in dryRun.

**F7 (INFO): single-origin storage keys.** Key (`holtburger_ai_key_v1`) and
journal (`holtburger_ai_journal_v1`) are origin-global — two bot tabs /
characters on one browser profile share both. Fine today; a landmine for
the multi-bot roadmap. Also note bot.js:174 intentionally duplicates the
KEY_STORAGE literal (documented at bot.js:172-173) — keep them in sync.

**F8 (INFO): `extractJson` is strict-JSON.** Trailing-comma replies fail to
parse and burn a consecutive-error (llm_client.js:35-42 → director
`_fail("reply")`). SPEC explicitly does not require trailing-comma
tolerance, and the fence/scan fallbacks are good; a strip-trailing-commas
repair pass is cheap hardening if small models get used.

Checked and NOT findings: the `getAi` closure over the later-declared `bot`
(bot.js:121) cannot fire before `bot` exists (worker heartbeat events are
macrotasks; construction to line 163 is synchronous) and is try/caught
anyway (control_channel.js:140-142); budget window counts attempts
pre-flight (director.js:145-146) so a throwing chat can't dodge the budget;
`combat.locked = 0` renders `lock: none` vs missing-combat `n/a`
(observe.js:106-124, 224-230 — subtle but correct); timer chain +
`checkNow` serialization has no lost-reschedule interleaving
(director.js:104-115, 230-240).

## 3. Prioritized next slice

1. **Guard `wireAiDirector`** (F1) — one try/catch in bot.js:167; the only
   invariant hole found. Tiny, do first.
2. **Fix `goto_lb` lb normalization + catalog text** (F2) — makes the one
   currently-broken action usable by the LLM.
3. **Wire `enrichObservation` into `wireAiDirector`** — one-line observe
   wrap + a `state` object next to the director (seam snippet in §1). Gives
   the director kill-rate trend, burden, portals, and the focus hint at
   zero risk (base-unchanged-on-error contract, 45 unit tests).
4. **Budget-skip reschedule/coalesce** (F4).
5. **Recall-spell hints** — observe_ext deliberately omits them: there is no
   verified SpellId table in-repo to map recall spells from (grepped;
   only a MotionCommand reference, plugins/lifestone-popup.js:17). Pair
   with the knowledge/tools track: once a spell-id source lands,
   `host.s.playerKnownSpells()` (bot.js:44, vitals.js:90 pattern) makes the
   probe one line.
6. **Config passthrough widening** (bot.js:229-234) — `systemPrompt`,
   `maxCallsPerHour`, `observe` in `config.ai` once B-extensions need to be
   default-on in pages.
7. **Comment/docs sweep** — F3 stale comment, F6 dryRun note, F5 UX note.

## 4. Integrator / laptop notes

- observe_ext.js is pure and network-free; `node
  rynth_ai_observe_ext_test.cjs` (45 checks) runs anywhere. Nothing in v1
  imports it yet — it is inert until next-slice #3 wires it.
- Live smoke of the enriched observation (real portals/burden surfaces,
  real kill cadence) is **laptop-only** (needs the ACE + serve.py stack,
  same as rynth_ai_smoke.cjs). Suggested probe: run a check-in with the
  wrap installed and eyeball `window.rynthAI.journal.tail()` + the
  `focus:`/`portals:` lines in the logged observation.
- The burden probe will render `burden: n/a | free_slots: n/a` on today's
  web host unless the wasm exposes `objectIntProperty` for the player guid
  (EncumbranceVal=5, Chorizite.Common/Enums/PropertyInt.cs:14) — that's
  expected, not a failure.
