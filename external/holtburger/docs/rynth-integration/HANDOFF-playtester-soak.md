# Handoff — first real playtester soak (step 3)

For the next session (user plans to run this on Opus 4.8). Everything this
handoff depends on is **committed**; STATUS.md's 2026-07-17 entries describe
the deliveries in detail. Prior context chain: `HANDOFF-ai-director.md` →
`HANDOFF-followups.md` → STATUS.md §"Beyond the reports" (WorldBuilder oracle
+ playtester-readiness sessions).

## 0. The goal

Run one AI playtester character for a long session (hours, not minutes) with
a **real LLM** and the **full extension surface**, and judge it on value:
does it gear up sensibly, hunt at the edge of what it can survive, use the
oracle before walking into danger, use its knowledge, and — the point of the
whole exercise — **file useful playtest tickets** when the game misbehaves.
This is the first run against a real LLM with a persona + economy + oracle all
live at once. Speed is explicitly out of scope; functionality and decision
quality are the mandate.

## 1. What is already built and green (do NOT rebuild)

Everything the playtester needs exists, is unit-tested, and is live-smoke
verified. The 2026-07-17 sessions delivered:

- **AI director + extensions** (`rynth/ai/`) — check-in loop, safety governor,
  observation enrichment, knowledge lookup, dungeon-nav advisor, providers.
  Default-on via `ai/extensions.js`.
- **Persona** — `config.ai.persona = {name, background, goals}` prepends a
  WHO-YOU-ARE block (identity + self-awareness duties + "file_ticket when the
  game misbehaves"). `renderPersonaPreamble` in `extensions.js`.
- **WorldBuilder oracle** — `wbt_query` / `wbt_catalog` / `file_ticket`
  director actions (`ai/tools/wbt.js`) over the **wbt-sidecar**
  (`apps/wbt-sidecar`, :8768). Read-only allowlist (59 cmds) + argument
  screening (output-path args refused, DAT-path args pinned under
  `WBT_DAT_ROOTS`). Tickets land in `/mnt/wbterminal2/playtest-tickets/`
  (one JSON each + `tickets.jsonl`), auto-stamped with character position.
- **Economy hands** — `inventory` / `open_vendor` / `buy_items` /
  `sell_items` / `equip_item` / `unequip_item` / `use_item` director actions
  (`ai/tools/economy.js`) over the RynthWebHost economy plane (`webhost.js`).
  Reads coins, burden%, free-slots, worn gear; buys within budget; sells
  loot; wields/uses items. Default-on.
- **Loot appraisal gate** — `loot_loop.js` now holds unappraised items and
  requests an ID before judging them against `minValue` (was: skip forever).
- **Client auto-boot** — `?bot=1` starts the grind bot on the live client at
  first in-world (`index.html` EnteredWorld handler); `?botAi=off` skips the
  director. This is the fix for the "two-speed integration" gap — the bot is
  no longer harness-only.

Test status (all green as of handoff): 16 unit suites (897 checks) incl.
`rynth_ai_economy_test` 33/33, `rynth_ai_wbt_test` 46/46, `rynth_loot_gate_test`
10/10; `apps/wbt-sidecar/wbt_sidecar_test.cjs` 34/34; live smokes
`rynth_bot_boot_smoke` 9/9, `rynth_ai_wbt_smoke` 9/9, `rynth_ai_smoke` 11/11.

## 2. How to launch the playtester

Laptop must have the stack up: ACE (UDP 9000/9001), serve.py (:8765),
wsbridge (:8080), and the **wbt-sidecar** (:8768). Bring the sidecar up with:

```sh
cd external/holtburger
scripts/wbt-sidecar-boot.sh          # idempotent; WBT_PROJECT=<path.wbproj> for project-scoped reads
curl -s localhost:8768/health | python3 -m json.tool
```

Then either (A) URL-flag boot the client bot and configure the director from
the console, or (B) drive `createGrindBot` directly. Option B gives the most
control over the persona:

```js
// in a booted, in-world page console (or a Playwright harness)
window.__bot = await (await import("/apps/holtburger-web/rynth/bot.js")).createGrindBot(
  window.__sessionHandle,
  {
    ai: {
      apiKey: "sk-or-...",            // OpenRouter; or window.rynthAI.setKey + reload
      model: "openai/gpt-oss-120b",   // live-soak baseline; reasoning models need maxTokens>=4096
      intervalMinutes: 3,
      persona: {
        name: "Brakis",
        background: "A fresh arrival in Holtburg with 10,000 pyreals to spend on gear.",
        goals: "Gear up, run the starter quests, hunt at the edge of what you can survive; report anything broken.",
      },
      wbt: { endpoint: "http://127.0.0.1:8768" },  // default; false to disable
      // economy, knowledge, dungeonNav, safety all default-on
    },
  }
);
```

For a level-1 character with 10k pyreals as the user described: create the
character via the guild-moot account flow or a fresh account, teleport it to a
town with a vendor (`@telepoi`, see memory/ace-live.md), and let the director
run. The persona goals steer it; the economy actions let it act.

Cost discipline is built in (5-min default cadence, 12 calls/hr, self-disable
after 5 errors). Watch spend via `window.rynthAI.status().spend`.

## 3. What to watch / likely first failures

- **Coins = 0 on admin chars.** The test character had 0 pyreals. Give the
  playtester a real purse (spawn coins, or an account that starts with them)
  or the economy actions have nothing to spend. `TryGetCoins` reads
  PropertyInt.CoinValue(20) with a coin-stack fallback.
- **Burden is a rough %; free-slots is an aggregate estimate.** Live-probed
  facts (webhost.js comments): the local player's entity int-store does NOT
  answer EncumbranceVal(5)/ItemsCapacity(6) — the wasm stats-plane getters
  `playerBurden`/`playerItemsCapacity` are the working source. And every
  `InventoryItem.containerId` is 0 in the current wasm snapshot, so per-pack
  slot math is impossible; free-slots sums main-pack + side-pack capacities
  minus backpack-slot items. If per-container placement matters later, that's
  a Rust/wasm snapshot change (surface real containerId on InventoryItem).
- **Vendor profile timing.** `open_vendor` calls `UseObject` then polls
  `TryGetVendorState` for up to 5 s. A vendor that's too far, or not actually
  a vendor, times out with an actionable error. The bot must be near the NPC.
- **`file_ticket` volume.** With a persona that's told to report problems, a
  chatty model may file many tickets. Review `GET :8768/tickets` (or the
  jsonl) and tune the persona/prompt if it's noisy vs useful.
- **netBrain is default-on** and drives combat target selection. If combat
  behaves oddly, `?netBrain=shadow` (compare-only) or `?netBrain=off` isolates
  it; watch `window.__diag.netbrain.summary()`.

## 4. Open items this session did NOT close (for after the soak)

- **T8 max-vs-first-match priority ruling** (CombatScoring #6) — only bites
  overlapping substring rules in `opts.priorities`; default `{}` never hits
  it. Ruling deferred; see the reconciliation notes in STATUS §2026-07-17.
- **T5 spell-projectile combat filter** — handoff task #15; needs a live
  war-caster capture to confirm bolts stream as attackable ItemType-16.
- **Real containerId on InventoryItem** — see burden/slots note above; would
  make free-slots exact and enable per-pack organization actions.
- **Vendor-buy confirmation read-back** — `buy_items`/`sell_items` sleep 1.5 s
  then re-read coins; there's no explicit transaction-result event wired.
  Good enough for a soak, worth hardening if trade becomes load-bearing.
- **The nav-depth backlog** (full-map bake, indoor A* wiring) is unchanged
  from `HANDOFF-remaining.md` §2 — the playtester will straight-line-route
  outside the baked Holtburg 5×5.

## 5. Judging the run (what "success" looks like)

Not "did it survive" — admin chars survive trivially. Judge:
1. Did it read its own state (inventory/vitals/burden) before acting?
2. Did it use `wbt_query`/`lookup` to scout before entering danger?
3. Did it gear up within budget, and equip what it bought?
4. Did it file tickets that a developer would actually act on (real bugs,
   blockers, imbalances) vs noise?
5. Spend + cadence sane over the whole run?

Capture the journal (`window.rynthAI.journal.tail(200)`) and the tickets dir
as the run artifacts — those are the deliverable of the soak.
