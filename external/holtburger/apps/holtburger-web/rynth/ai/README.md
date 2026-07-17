# rynth/ai — the AI DIRECTOR (v1)

An LLM that **checks in on the grind bot every few minutes** — reads a compact
observation (position, vitals, combat lock, threats, journal tail), thinks,
adjusts the bot (hunting priorities, loot threshold, travel, pause, notes) —
then goes away again. It is **never** in the per-tick decision path; the bot
grinds on untouched if the LLM is unreachable, wrong, or disabled.

Frozen interfaces + module ownership: [SPEC.md](SPEC.md).

## Quickstart

1. Get an [OpenRouter](https://openrouter.ai/) API key (`sk-or-...`). Any
   OpenAI-compatible `/chat/completions` provider works via `baseUrl`.
2. In a booted, in-world page (the grind bot running via `createGrindBot`),
   open the console:
   ```js
   window.rynthAI.setKey("sk-or-...")   // -> "key saved — reload to activate"
   ```
3. Reload. The director constructs itself from the saved key and starts
   checking in every 5 minutes. `window.rynthAI.status()` shows it live.

Prefer a UI? Load the page with **`?aiPanel=1`** — a small bottom-right panel
with the key input, model picker, interval, Enable checkbox, "Check now" and
the last journal lines. (With no key saved yet it mounts in key-entry mode:
save the key, then reload to activate.)

Deactivate any time: `window.rynthAI.clearKey()` + reload, or pass
`ai: false` to `createGrindBot`.

## config.ai reference

```js
const bot = await createGrindBot(window.__sessionHandle, {
  // ...usual bot config...
  ai: {
    apiKey: "sk-or-...",       // wins over the saved localStorage key
    baseUrl: "https://openrouter.ai/api/v1",  // default; any OpenAI-compatible provider
    model: "openai/gpt-oss-120b",             // default (live-soak baseline)
    intervalMinutes: 5,        // check-in cadence (clamped 1..30 at runtime)
    dryRun: false,             // true = plan + journal but execute nothing
    autoStart: true,           // anything but false -> director.start()
  },
});
```

- `ai: false` — disable entirely (not even the key probe runs).
- No `ai` key + no saved localStorage key — zero cost: no ai module is
  imported; only a bootstrap `window.rynthAI.setKey` is installed.
- A saved key (localStorage `holtburger_ai_key_v1`) **or** an `ai` object
  activates the full stack: `bot.ai = { director, client, journal }` plus
  `window.rynthAI = { setKey, clearKey, start, stop, checkNow, status,
  journal, panel }`.
- In-game chat control (via the control channel): `!bot ai status`,
  `!bot ai on`, `!bot ai off`, `!bot ai now`.

## The reply contract

Each check-in the director sends `[system, user]` — the system prompt embeds
the action catalog below; the user message is the observation. The model must
reply with exactly **one JSON object** (extracted tolerantly — ```json fences
and surrounding prose survive):

```json
{
  "analysis": "<short>",
  "actions": [{"type": "...", "...params": "..."}],
  "next_check_minutes": 7,
  "note": "<optional note-to-self>"
}
```

v1 actions (`rynth/ai/actions.js`):

| type | params | effect |
|---|---|---|
| `goto` | `ns`, `ew` (/loc degrees, \|deg\| ≤ 102) | travel; grind pauses, resumes on arrival |
| `goto_lb` | `lb` (hex string or number), `x`, `y`, `z` | travel to exact landblock-local position |
| `stop_goto` | — | cancel travel in progress |
| `set_priorities` | `rules` (name → int 1..99, **replaces** all) | combat hunting priorities |
| `set_loot_min_value` | `value` (int ≥ 0) | loot Value threshold |
| `pause` / `resume` | — | stop / start the grind kernel |
| `say` | `text` (≤ 120 chars, must NOT start with `@`) | local chat — no admin commands, ever |
| `set_checkin` | `minutes` (int 1..30) | change the check-in interval |
| `note` | `text` (≤ 500 chars) | journal note-to-self |
| `none` | — | do nothing (the model's default when all is well) |

Invalid actions are rejected per-action; the rest of the plan still runs
(max 5 actions per check-in). Plan + results land in the journal
(`window.rynthAI.journal.tail()`).

## Cost discipline (defaults)

| Knob | Default | Bounds |
|---|---|---|
| Check-in interval | **5 min** | 1..30 min (model may retune via `next_check_minutes` / `set_checkin`, always clamped) |
| Calls per hour | **12 max** | rolling 60-min window; over-budget check-ins are skipped + journaled (`budget`), not errored |
| Completion tokens | **1024 max** per call | — |
| Observation | ~**6000 chars** cap | threat lines truncate first |
| Consecutive errors | **5** → director disables itself | re-enable via `window.rynthAI.start()` / `!bot ai on` |

At the default Haiku-class pricing this is on the order of *cents per day*.
Spend counters: `window.rynthAI.status().spend`
(`{calls, promptTokens, completionTokens, errors}`).

## Troubleshooting

- **Key invalid / expired** — every check-in journals an `error` entry with
  `.kind "auth"` (`window.rynthAI.journal.tail()`); after 5 consecutive
  errors the director stops itself. Fix the key (`setKey` + reload, or the
  panel), then `window.rynthAI.start()`.
- **`rate`, `server`, `network`, `timeout` kinds** — provider-side; the client
  retries once per call, the director just skips that check-in. Persistent
  streaks also end in self-disable after 5.
- **`window.rynthAI.status()` shows only `setKey`** — no key was found at bot
  construction: `setKey("sk-or-...")` and reload.
- **Nothing seems to happen** — `!bot ai status` / `window.rynthAI.status()`:
  check `enabled`, `nextCheckAt`, `consecutiveErrors`. Force one with
  `window.rynthAI.checkNow()` (or `!bot ai now`) and read the journal.
- **Local/mock provider** — `config.ai = { baseUrl: "http://127.0.0.1:8899/v1",
  model: "mock", apiKey: "test-key" }` against
  `node rynth/ai/mock_llm_server.cjs` (used by `rynth_ai_smoke.cjs`).

## Extensions (wired by default since 2026-07-16)

The v2 layers compose through `ai/extensions.js` and are ON by default
(`config.ai = { extensions: false }` reverts to the plain v1 director):

- **`lookup` action** — acpedia/quest knowledge search. The browser corpus is
  fetched from `ai/tools/knowledge.acpedia.json` (baked from the acpedia
  wikidump; gitignored) with `knowledge.sample.json` as the fallback. Override
  with `config.ai.knowledge = { url | entries | provider }`, or `false` to
  disable.
- **`dungeon_suggest` action** — advisory indoor-route suggestions over the
  live wasm dungeon graph; never moves the bot.
- **Safety governor** — `guardPlan`/`sanitizeAction` screen every plan before
  execution (control chars, disguised `@`/`/` commands, numeric clamps, max 5
  actions/check-in).
- **Observation enrichment** — kill-rate trend, burden/free-slots, nearby
  portals, and a suggested-focus line appended to each observation.

Still out of scope: multi-bot coordination, long-term goal ladders.
