# rynth/ai — LLM director for the holtburger-web grind bot (v1 SPEC)

**The idea:** rynthsuite (the `rynth/` grind bot) keeps the character alive,
fighting, looting, buffing and travelling on its own for minutes at a time.
An LLM "director" **checks in every few minutes** — it reads a compact
observation of what's going on, thinks, and adjusts the bot (change hunting
priorities, loot threshold, travel somewhere, pause, leave itself a note) —
then goes away again. The LLM is NEVER in the per-tick decision path and is
NEVER called for small decisions; the bot survives fine if the LLM is
unreachable, wrong, or disabled.

Provider: any OpenAI-compatible chat-completions API. Default **OpenRouter**
(`https://openrouter.ai/api/v1` — browser CORS is supported; auth =
`Authorization: Bearer <key>`, optional `HTTP-Referer`/`X-Title` headers).
`baseUrl` is configurable so a local server / other providers / the test mock
work identically. v1 uses plain chat completions + a strict JSON reply
contract (no provider tool-calling — model-portable).

Future (OUT of v1 scope, do not build): acpedia/quest lookup tools, dungeon
navigation program, multi-bot coordination, long-term goal ladders.

## Files & ownership (one agent per row; do NOT touch files you don't own)

| File | Owns | Test file (same owner) |
|---|---|---|
| `rynth/ai/llm_client.js` | A1 | `rynth_ai_client_test.cjs` |
| `rynth/ai/observe.js` | A2 | `rynth_ai_observe_test.cjs` |
| `rynth/ai/actions.js` | A3 | `rynth_ai_actions_test.cjs` |
| `rynth/ai/director.js` | A4 | `rynth_ai_director_test.cjs` |
| `rynth/ai/journal.js` | A5 | `rynth_ai_journal_test.cjs` |
| `rynth/ai/ui.js` | A6 | `rynth_ai_ui_test.cjs` |
| `rynth_ai_smoke.cjs` + `rynth/ai/mock_llm_server.cjs` | A7 | (is the test) |
| `bot.js` + `control_channel.js` + `docs/url-flags.md` + `rynth/ai/README.md` wiring | A8 (runs LAST) | — |

Test files live in `apps/holtburger-web/` beside the existing `rynth_*_test.cjs`
suite and follow its conventions: `#!/usr/bin/env node`, `"use strict"`, plain
`check(name, ok, detail)` + exit 1 on failure, ESM modules imported via
`pathToFileURL`. No infra needed for unit tests (mock everything); only the A7
smoke uses the live stack and is run on the LAPTOP, not the buildbox.

## Interface contract (FROZEN — implement exactly; stubs already in place)

### llm_client.js
```js
export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_MODEL = "openai/gpt-oss-120b"; // baseline since 2026-07-16 live soak
export const KEY_STORAGE = "holtburger_ai_key_v1";   // localStorage key
export function extractJson(text) // -> object|null; tolerant of ```json fences, prose around the object, trailing commas NOT required to parse
export class LlmClient {
  constructor({ apiKey, baseUrl, model, referer, title, timeoutMs = 60000, maxTokens = 1024, log } = {})
  // maxTokens (additive 2026-07-16): instance default for chat()'s cap —
  // reasoning-tier models (gpt-5-nano etc.) return EMPTY content at 1024
  // because hidden reasoning tokens count against max_tokens; raise via
  // config.ai.maxTokens (bot.js passthrough).
  static loadKey() / static saveKey(key) / static clearKey()   // localStorage, safe under node (no-throw, null)
  async chat(messages, { model, maxTokens = 1024, temperature = 0.4 } = {})
  // -> { text, json, usage: {prompt, completion}, model, ms }
  // POST {baseUrl}/chat/completions with {model, messages, max_tokens, temperature}
  // 1 retry on 429/5xx/network (exponential-ish backoff, <=10s), AbortController timeout.
  // Errors THROW Error with .kind in {"auth","rate","server","network","timeout","bad-response"}.
  get spend() // -> { calls, promptTokens, completionTokens, errors } cumulative
}
```

### observe.js
```js
export function buildObservation(bot, { journalTail = "", maxChars = 6000, now = Date.now() } = {})
// -> { text, data }
```
`text` = the compact prompt block (token-lean, line-oriented, no prose fluff);
`data` = the structured object it was rendered from. MUST include: uptime,
position (landblock hex + local xyz + /loc degrees NS/EW — reuse the math in
`rynth/router.js` if exported, else inline the standard AC conversion),
kernel action + kills + looted counts, vitals % (hp/stam/mana), buff status
(active/desired/parked/pending), combat lock (guid hex, name, hp fraction,
distance) or "none", top-8 nearby attackable threats (name, dist, hp), corpse
count nearby, router/goto state, netbrain one-liner
(`__diag.netbrain.summary()` first line, if present), the journal tail passed
in, and the AI spend counters if given. Degrade gracefully: every field
individually try/caught; missing subsystem -> "n/a". Hard-cap output at
maxChars (truncate threats list first). Pure function of (bot, opts) — mock
bot in tests, deterministic with injected `now`.

### actions.js
```js
export const ACTIONS = { /* type -> { params: {name: "desc"}, desc } */ }
export function renderActionCatalog()          // -> string for the system prompt
export function validateAction(a)              // -> { ok, error? } — shape+bounds only
export async function executeAction(bot, a, { log } = {})  // -> { type, ok, result?|error? }
export async function executePlan(bot, actions, { maxActions = 5, log } = {}) // sequential, stops after maxActions, never throws
```
v1 action types (exact strings): `goto {ns, ew}` (numbers, |deg| <= 102;
via `bot.goto({ns,ew})`), `goto_lb {lb, x, y, z}` (lb = full u32 objCellId as
hex string or number — the executor refuses `lb <= 0xFFFF` (a bare landblock
word would route to the map corner); x/y landblock-local in [0,192)),
`stop_goto` (router.cancel via bot surface), `set_priorities {rules}`
(object name->int 1..99, replaces `bot.combat.priorities`),
`set_loot_min_value {value}` (int >= 0 -> `bot.loot.minValue`), `pause`
(kernel.stop), `resume` (kernel.start), `say {text}` (bot.host.WriteToChat;
REFUSE any text starting with "@" — no admin commands from the LLM — and cap
120 chars), `set_checkin {minutes}` (1..30; returned in result for the
director to apply), `note {text}` (journal note, cap 500 chars), `none {}`.
Unknown type -> validate fails. Executor NEVER throws; every action result
recorded. Missing bot subsystem (loot=null etc.) -> ok:false "unavailable".

### director.js
```js
export const DEFAULT_SYSTEM_PROMPT; // role, the action catalog (renderActionCatalog()), the REPLY CONTRACT below, cost discipline ("you are called every few minutes; be decisive; prefer none over churn")
export class RynthAiDirector {
  constructor(bot, { client, journal, observe = buildObservation,
    intervalMinutes = 5, minIntervalMinutes = 1, maxIntervalMinutes = 30,
    maxCallsPerHour = 12, maxErrorsBeforeDisable = 5,
    systemPrompt = DEFAULT_SYSTEM_PROMPT, dryRun = false, log } = {})
  start() / stop()
  get status() // { enabled, running, lastCheckAt, nextCheckAt, calls, consecutiveErrors, lastSummary, spend }
  async checkNow() // -> { plan, results } — the interval body, also manual trigger; serialized (one in flight)
}
```
REPLY CONTRACT (the LLM must return ONE JSON object, extracted with
`extractJson`): `{ "analysis": "<short>", "actions": [{"type": "...", ...}],
"next_check_minutes": <1..30>, "note": "<optional note-to-self>" }`.
Flow per check-in: buildObservation (with journal.renderTail()) -> client.chat
([system, user]) -> extractJson -> validate each action -> executePlan (unless
dryRun) -> journal plan+results -> apply next_check_minutes (clamped) ->
schedule next via setTimeout chain (NOT setInterval; tab throttling clamps
background timers to >=1/min which is fine at minute cadence). Budget: refuse
to call when calls-in-last-60min >= maxCallsPerHour (journal a "budget" entry,
reschedule); disable entirely (stop()) after maxErrorsBeforeDisable
CONSECUTIVE errors. LLM unreachable/invalid JSON -> journal error, no actions,
next check at intervalMinutes. NEVER touches admin chat; NEVER blocks the bot.
Idle-guard (additive 2026-07-16): if the director self-disables while the
kernel is stopped BY AN EXECUTED AI pause (dryRun never arms it; an AI resume
disarms it), the guard restarts the kernel and journals a note — a dead
director must not leave the bot parked. A user stop() never triggers it.

### journal.js
```js
export class AiJournal {
  constructor({ storageKey = "holtburger_ai_journal_v1", maxEntries = 200 } = {})
  add(kind, text)        // kind in {"plan","result","note","error","budget"}; stamps t
  tail(n = 10)           // -> entries [{t, kind, text}]
  renderTail(n = 10, maxChars = 2000)  // -> compact string for prompts
  export() / import(json) / clear()
}
```
Persists to localStorage when available (same-key rolling array), pure-memory
under node. Never throws on quota/corrupt-JSON — degrade to memory.

### ui.js
```js
export function mountAiPanel(director, { client, models } = {}) // -> { el, destroy() }
// `models` (additive, optional): datalist suggestion ids — bot.js passes the
// providers.js catalog; absent/invalid -> the hardcoded fallback list.
```
Plain DOM, no framework. Small fixed-position panel (bottom-right, dark,
consistent with the app's overlay look): masked API-key input + Save/Clear
(LlmClient.saveKey/clearKey), model text input with a datalist of a few
OpenRouter ids, interval number input, Enable checkbox (start/stop), "Check
now" button, status line (refreshed every 5 s from director.status), last 3
journal lines. Must be constructible/destroyable repeatedly. Unit test with a
minimal DOM shim (no jsdom dependency — a hand-rolled document stub is fine;
keep ui.js's DOM usage narrow: createElement/appendChild/addEventListener/
textContent/value/remove).

### Wiring (A8 — after all others land)
- `bot.js`: after the netBrain block — AI is **opt-in by key presence or
  explicit config**: `config.ai === false` -> skip; else if
  `config.ai?.apiKey || LlmClient.loadKey()` (lazy import `ai/director.js`
  etc.) -> construct client/journal/director (config.ai passes through:
  apiKey, baseUrl, model, intervalMinutes, dryRun, autoStart != false ->
  start()), expose as `bot.ai`, install `window.rynthAI = { setKey, clearKey,
  start, stop, checkNow, status: () => director.status, journal, panel }`.
  Mount the panel only when `?aiPanel=1` (read via URLSearchParams, exact
  "1") or `window.rynthAI.panel()` called. No key + no config.ai -> only
  `window.rynthAI.setKey` is installed (so a user can bootstrap from console)
  — implement that tiny bootstrap inline in bot.js without importing the ai
  modules until a key exists (zero cost when unused).
- **Extensions (post-v1, 2026-07-16):** `ai/extensions.js
  composeAiExtensions(bot, { base, journal, config })` composes the v2
  layers through the director's injectable deps and is wired by default in
  bot.js (`config.ai.extensions === false` skips; wiring failure degrades to
  the v1 director): safety `guardPlan` in front of `executePlan`,
  `enrichObservation` around `buildObservation`, `lookup` (knowledge) +
  `dungeon_suggest` (dungeon-nav) actions appended to the system prompt as an
  EXTRA ACTIONS catalog. Extra `config.ai` passthrough: `systemPrompt`,
  `maxCallsPerHour`, `knowledge: false | { provider|entries|url }`,
  `dungeonNav: false`. The browser knowledge corpus defaults to
  `ai/tools/knowledge.acpedia.json` (baked, gitignored) with
  `knowledge.sample.json` as the fresh-clone fallback.
- `control_channel.js`: add `ai` command — `!bot ai status|on|off|now`
  (status -> one-line summary reply; on/off -> start/stop; now -> checkNow
  fire-and-forget). Register alongside the existing commands; follow the
  existing reply/rate-limit shape.
- `docs/url-flags.md`: add `aiPanel` row (default off) + an `ai` note row.
  PLACEMENT: insert directly AFTER the `agent` row (do NOT touch the
  `netBrain` row — it has pending edits elsewhere).
- `rynth/ai/README.md`: quickstart (get an OpenRouter key, console
  `window.rynthAI.setKey("sk-or-...")`, reload or `?aiPanel=1`), the reply
  contract, cost discipline, roadmap note (acpedia/quest lookup + dungeon nav
  come later).

## Cost & safety discipline (bake into prompts and code)
- Default check-in 5 min; hard bounds 1..30; maxCallsPerHour 12.
- maxTokens 1024 default; observation capped ~6k chars.
- The LLM gets NO admin powers: `say` refuses "@..."; there is no raw-eval action.
- Every director failure path degrades to "bot keeps grinding untouched".

## Verification bar (each agent, before writing its report)
- `node rynth_ai_<yours>_test.cjs` passes on the box (no infra, no network —
  use in-process http servers on 127.0.0.1 where a fetch target is needed).
- `node --check`-clean is not enough: import your module in the test.
- A7: the smoke must be RUNNABLE-shaped but is executed later on the laptop
  (the box has no ACE/serve.py); mock_llm_server.cjs must be independently
  unit-runnable (`node rynth/ai/mock_llm_server.cjs --selftest`) INCLUDING
  CORS handling (OPTIONS preflight + Access-Control-Allow-Origin: *), since
  the page at :8765 will fetch it cross-origin.
- A8: run the whole `rynth_ai_*` set + `rynth_netbrain_test.cjs` +
  `rynth_combatparity_test.cjs` after wiring; all green.

## Addendum — NavAtlas / soak-15 additions (2026-07-18, SPEC-navatlas §3-W3; ADDITIVE to the frozen v1 surface)

### director.js (additive constructor opts + one opt on checkNow)
- `holdWhile?: () => string|null` — travel-hold: when a SCHEDULED fire sees a
  truthy reason, the check-in is skipped (no LLM call, no budget burn) and
  re-polled at `holdPollMinutes` (default 0.5). Journals ONE `budget` entry
  per hold streak. `maxHoldMinutes` (default 20) is a safety cap: past it the
  check proceeds despite the hold. Early checks (`requestEarlyCheck`) and
  `checkNow({force:true})` bypass the hold — route events carry decisions.
- `requestEarlyCheck` refused only for timer-imminence still arms the bypass
  (the imminent fire serves the event through the hold).

### bot.js (additive)
- `bot.followRoute(legs, {label, pollMs, timeoutMs})` — walk pre-planned
  atlas legs with goto's kernel pause/prior-state-restore semantics; resolves
  `{ok, state, legsWalked?}`. One at a time; refused while a goto runs; a
  goto cancels it (last command wins → state CANCELLED).
- `bot.mission` / `bot.lastMission` — first-class travel state
  `{kind:"goto"|"route", label, startedAt, interrupts}` (+ endedAt/result on
  lastMission). Set/cleared by doGoto/followRoute; interrupts bumped by the
  early-check event wiring.
- `bot._onTravelStart` / `bot._onTravelDone` — single-slot hooks the
  extension layer uses for route auto-record; failures are swallowed.
- Route events: goto/followRoute completion fires
  `requestEarlyCheck("route arrived|FAILED: <label>[, coverage X]",
  {minGapSeconds:10})`.
- config.ai additions: `travelHold:false` off (default on when wired),
  `holdPollMinutes`, `maxHoldMinutes`, `metrics:false` off (default on),
  `routes:false|{atlas}` and `routeRecord:false` (extensions.js).

### tools/routes.js (new; registerWorld-shaped)
- Actions `follow_route {name}`, `list_routes {}`, `name_route {route,name}`
  over the W2 atlas (rynth/atlas.js, lazy-imported; missing atlas degrades
  every action to ok:false). Shared page instance exposed as
  `window.__atlas` for atlas_mirror.cjs.
- `renderMissionLine(bot)` — the `mission:` observation line (live: leg/ETA/
  coverage/elapsed/interrupts from router.status + globalRouter.lastPlan +
  playerRunRate×4.0 m/s; last-completion echo for 10 min). Wired into the
  extensions observe() stack.
- Auto-record (extensions.js): successful novel gotos are recorded via
  rynth/route_recorder.js and saved under an auto-name; `name_route`
  promotes keepers. follow_route walks are reuse, not re-saved.

### tools/metrics.js (new)
- `createAiMetrics(bot, {journal})` — hourly journal line (kind `note`):
  walked metres (teleports excluded), unique landblocks, routes
  recorded/reused, kills/deaths, LLM calls + token deltas. Counters live on
  `bot._metrics` for other modules to bump. Wired by bot.js after director
  construction; `config.ai.metrics === false` off.

### Suites
- `rynth_ai_routes_test.cjs` (routes tool + mission line + metrics);
  travel-hold cases appended to `rynth_ai_director_test.cjs`.
