# Handoff — netBrain default-on + AI director (2026-07-16, evening session)

> **EXECUTED 2026-07-16 (late session).** §4's residuals and next-slices 1-3
> are done and live-verified:
> - **F1 fixed** — `wireAiDirector` call is try/caught in bot.js; a broken ai
>   module warns and grinds on.
> - **F2 fixed** — `goto_lb` catalog says full objCellId with a pos-line
>   example; executor refuses `lb <= 0xFFFF` with an actionable error; x/y
>   bounded to [0,192) in the validator (actions test 100/100, safety 128/128).
> - **Extensions wired default-on** — new `rynth/ai/extensions.js`
>   (`composeAiExtensions`) plugs safety `guardPlan`, `enrichObservation`,
>   knowledge `lookup`, dungeon `dungeon_suggest` and the providers→ui model
>   datalist into the director's injectable deps; `config.ai.extensions =
>   false` reverts to plain v1; wiring failure degrades to v1. New unit suite
>   `rynth_ai_extensions_test.cjs` (27 checks).
> - **Real acpedia provider** — `rynth/ai/tools/bake_knowledge_acpedia.py`
>   streams the 1.4 GB wikidump into `knowledge.acpedia.json` (24,488
>   articles, 6.0 MB, gitignored; infobox stats + prose; rebake ~3 min);
>   `FetchKnowledgeProvider` (extensions.js) lazy-fetches it in-page with
>   `knowledge.sample.json` as fallback. knowledge.js gained an exact-title
>   ranking tier.
> - **Verified live** — all 13 unit suites green (724 checks);
>   `rynth_ai_smoke.cjs` 11/11 with extensions active, 0 console errors; a
>   live probe confirmed the extended prompt on the director, a real corpus
>   `lookup` (Olthoi Soldier w/ stats), and `dungeon_suggest` degrading
>   cleanly outdoors.
> Remaining from §4: real-LLM live soak (needs a real key) and the netBrain
> buff/loot shadow soak — both unchanged below.

Continuation of `HANDOFF-followups.md`. This session finished the netBrain
(.NET-wasm) work and built a new layer on top of the rynth grind bot: an **LLM
director** that checks in every few minutes and steers the bot. Everything
below is **committed and pushed to origin/master**.

Repo: `WorldBuilder-ACME-Edition`, submodule `external/holtburger`, branch **master**.
Head at handoff: **`5bd7d337`**. This session's commits (newest first):
- `5bd7d337` AI director extensions 6/6 — dungeon-nav, safety, observe-ext
- `98e2b6a1` AI director extensions 3/6 — knowledge, providers, eval
- `f6c4941b` AI director live smoke 11/11 (assertion fix)
- `3355ca46` **AI director v1** — the whole feature (8-agent fan-out)
- `1ab1ebc7` AI director v1 scaffold + SPEC
- `1aa21980` **netBrain DEFAULT-ON** — 30-min soak validated
- `4d5503a4` netbrain review round 2 — 6 findings fixed
- (earlier today: `3b41eb39` netbrain item B delivered, `4ec0d90f` handoff stamp)

The **GCE buildbox VM is STOPPED (TERMINATED, disk kept)** — the two fan-outs
that ran on it (8-agent v1, 6-agent extensions) are collected, applied, tested,
pushed. Nothing is running on it.

---

## 1. netBrain — DONE, shipped, default-ON

The `.NET-wasm` rynth brain (D1 path A′) is **default-on and soak-validated**.
- `?netBrain` absent ⇒ mode **`on`** (C# TargetScoring drives the combat lock;
  buff/loot shadow-compare). `?netBrain=off` escapes; `shadow` compares only;
  node harnesses (no `location`) stay off. Missing/stale AppBundle degrades to
  the JS brain (version gate + warn) so a fresh clone boots clean.
- **AppBundle is gitignored** (`apps/holtburger-web/netbrain/AppBundle/`) — like
  `pkg/`, **rebuild after a pull that touches the slices**:
  `cd apps/holtburger-web/netbrain && ./build.sh` (needs the wasm-tools
  workload; dotnet at `~/.local/bin/dotnet`). Gate: `node replay_fixtures.mjs`
  = 269/269 vs native C#.
- Soak: `rynth_netbrain_soak.cjs` — 30 min live, 25 kills, 2500 combat
  adoptions (2491 agree, 0 errors, 0 lock flip-backs), loot 94/94, 2.6 ms/call.
- Two review rounds already applied (round 2 = commit `4d5503a4`: mode-"on"
  authority, global-frame distance, positionless-row absence, buff/loot classify,
  version-gated replay). No open netbrain items.

## 2. AI director v1 — DONE, shipped (feature complete for v1)

**What it is:** an OpenAI-compatible LLM (OpenRouter default) that reads a
compact observation of the bot every few minutes, returns a JSON plan, and the
plan is validated + executed against the live bot. It is **never** in the
per-tick path; the bot grinds fine if the LLM is absent, wrong, or disabled.

**Files** (`apps/holtburger-web/rynth/ai/`): `llm_client.js` (typed errors, 1
retry, spend), `observe.js` (compact world snapshot), `actions.js` (11 typed
actions + never-throws executor), `director.js` (setTimeout-chain check-ins,
hourly budget, self-disable), `journal.js` (bounded, localStorage), `ui.js`
(key panel). Wiring in `bot.js` + `control_channel.js`. Full contract in
`rynth/ai/SPEC.md`; user quickstart in `rynth/ai/README.md`.

**How to turn it on** (as a user):
- Console: `window.rynthAI.setKey("sk-or-...")` then reload; or pass
  `createGrindBot(sh, { ai: { apiKey: "sk-or-..." } })`; or `?aiPanel=1` for the
  DOM panel. In-game: `!bot ai status|on|off|now`.
- No key + no `config.ai` ⇒ only `window.rynthAI.setKey` is installed (zero
  ai-module cost). `config.ai === false` skips even the key probe.

**Verified:** fan-out unit suite (client 55, observe 51, actions 99, director
57, journal 45, ui 34) + **live smoke `rynth_ai_smoke.cjs` 11/11** (mock LLM +
real ACE: the director drove the live bot, applied `loot.minValue=4321`,
journaled plan+result, 2 check-ins, 0 errors).

## 3. AI director extensions — DONE (the SPEC's "later" list, mostly built)

Six additive layers (6-agent fan-out), **zero v1-file edits**, each a
registerable/injectable module the integrator wires when wanted:
- `ai/tools/knowledge.js` (+`knowledge.sample.json`) — **the acpedia/quest hook**:
  provider-agnostic `KnowledgeBase`; `FileKnowledgeProvider` now, SQL/wiki
  drop-in later (implement `{ search(query,limit)->Promise<rows> }`). Exposes a
  `lookup` director action via `registerKnowledge(actionsMap, kb)`.
- `ai/tools/dungeon_nav.js` — `DungeonNavAdvisor` over the existing
  `indoor_router` A*; `describeSurroundings` + `suggestRoute`, advisory-only,
  as a `dungeon_suggest` action.
- `ai/providers.js` — provider/model catalog + `estimateCost`/`estimateTokens`.
- `ai/eval/scenarios.js` — offline deterministic director eval harness.
- `ai/safety.js` — governor: `sanitizeAction` (admin-cmd/control-char/length +
  numeric clamp), `RateGovernor`, `guardPlan` — slot in front of `executePlan`.
- `ai/observe_ext.js` — additive `enrichObservation` (kills/min, burden,
  suggested-focus).
Tests: knowledge 51, providers 32, eval 34, dungeon-nav 65, safety 128,
observe-ext 45 — **all green here**. These modules are **not yet wired into
`bot.js`/`director.js`** (they register through passed-in maps / injected deps);
that wiring is the obvious next slice.

## 4. RESIDUAL / open work (nothing blocking; ordered by value)

From `rynth/ai/INTEGRATION-NOTES.md` (B6's v1 review — read it, 8 findings):
- **F1 (MED) — not fixed.** `createGrindBot` does `await wireAiDirector(...)`
  with **no try/catch** (`bot.js:167`). A broken/stale AI-module import would
  reject `createGrindBot` → the bot never exists, violating the "bot survives
  the AI being broken" invariant. **One-line fix:** wrap that call:
  `try { await wireAiDirector(...) } catch (e) { console.warn("[rynth] AI wiring failed, grinding without director:", e); }`.
  I was mid-fix when this handoff was cut — DO THIS FIRST next session.
- **F2 (MED) — not fixed.** `goto_lb` catalog says `lb` = "landblock hex string
  or number" (`actions.js:18`) but the sidecar needs the **full u32 objCellId**
  (high word places the point). An LLM sending the bare landblock word `"A9B4"`
  → `0x0000A9B4` → routes to map-corner landblock `0x0000`. Degrades safely
  (`ok:false`, journaled) but makes `goto_lb` unusable as documented. **Fix:**
  the observation's `pos:` line already prints the full 8-digit objCellId
  (`0xA9B40015`) — update the catalog text to "full objCellId from the pos
  line, e.g. 0xA9B40015", and in the executor reject `lb <= 0xFFFF` with an
  actionable error instead of silently routing to the corner. (x/y also
  unbounded in the validator; sidecar wants [0,192).)
- F3–F8 (LOW/INFO): stale `WriteToChat` "display-only" comment
  (control_channel.js:82 — it IS world-visible speech; the "@" refusal is
  load-bearing and correct); budget-skip journal churn at 1-min intervals;
  panel interval edit doesn't touch the armed timer; dryRun swallows
  set_checkin; origin-global storage keys (multi-bot landmine); extractJson is
  strict-JSON (no trailing-comma tolerance). All documented in INTEGRATION-NOTES.

**Next slices (from the reports + SPEC roadmap):**
1. Fix F1 + F2 (above).
2. Wire the extension modules into `bot.js`/`director.js` (knowledge `lookup`,
   dungeon `dungeon_suggest`, safety `guardPlan` before executePlan, observe-ext
   into the observation, providers into ui.js model picker). Each report's "For
   the integrator" section has the one-liner.
3. Real acpedia provider: implement `{search}` against the wikidump SQL
   (`$DDB`-style / the acpedia index) as a drop-in for `FileKnowledgeProvider`.
4. Live soak of the AI director against a **real** LLM (only the mock has run
   live); watch spend + decision quality over a long grind.
5. netBrain buff/loot shadow live soak (their shadows are node-pinned + rode
   the 30-min combat soak but saw little kernel routing to Buffing/Loot).

## 5. How to run / verify (all local on this laptop; ACE + serve.py + wsbridge up)

- AI unit suite (no infra): from `apps/holtburger-web/`, `for t in rynth_ai_*_test.cjs; do node $t; done`
  (12 files, ~696 checks) + `node rynth/ai/mock_llm_server.cjs --selftest`.
- AI live smoke: `NODE_PATH=<playwright> node rynth_ai_smoke.cjs` (boots a page,
  mock LLM on :8899, real ACE — needs the stack up; port 8899 free).
- netBrain: `node netbrain/replay_fixtures.mjs` (269/269), `node rynth_netbrain_test.cjs`,
  soak `NODE_PATH=<pw> node rynth_netbrain_soak.cjs --minutes=N`.
- Playwright NODE_PATH: `/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules`.

## 6. Fleet notes (cost real time this session)
- **buildbox OAuth token was revoked** since the last session → first fan-out
  attempt 401'd instantly. Fix: `gcloud compute scp ~/.claude/.credentials.json
  buildbox:~/.claude/.credentials.json` then `chmod 600` on box; verify with a
  one-shot `claude -p "reply AUTH-OK"` BEFORE launching a fan-out.
- **Transient HTTP 529 "overloaded"** killed 3 of 6 agents (they die without
  retry). The retry-wrapper pattern (`~/aiwork2/retry3.sh` on box, or re-run the
  named agents) recovered all 3 first-try. Bake a 529-retry loop into future
  driver scripts.
- Driver collected patches **restricted to the app dir** (`git diff --cached
  -- <files>`), never a bare repo-wide `add -A`, to avoid sweeping stray files.
- VM stopped with `gcloud compute instances stop buildbox --zone us-central1-a`
  after `rm ~/.keep-awake`. Confirmed **TERMINATED**.

## 7. Laptop state (LEFT RUNNING — do not kill)
ACE (UDP 9000/9001), serve.py (:8765), wsbridge (:8080), rynthnav sidecar
(:8767) are all up. The netBrain AppBundle is built and served. No background
soak/fan-out is running (all completed). The laptop must stay on.
