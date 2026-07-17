# Handoff — playtester soak, session 2 (advancement + perception/interaction + memory)

Continues `HANDOFF-playtester-soak.md`. Shipped in commit **`d6a2227d`**
(origin/master). A live soak is **still running** as of this handoff — see §5.

## 0. What this session delivered

The step-3 soak (a fresh L1 character playing from scratch with a real LLM)
surfaced two blockers that were **general-capability gaps, not bugs**, and we
closed them as general faculties (the same category as "the ability to raise
skills" — explicitly NOT game-specific scripting):

1. **Character advancement** (`rynth/ai/tools/advancement.js`) — director
   actions `raise_attribute` / `raise_vital` / `raise_skill` / `train_skill`
   over new `webhost.js` wrappers (`RaiseAttribute/RaiseVital/RaiseSkill/
   TrainSkill` + `TryGetPlayerStats` / `TryGetSkillCredits`) → wasm
   `raiseAttribute/raiseVital/raiseSkill/trainSkill` (GameAction 0x0044–0x0047).
   **Verified end-to-end vs live ACE**: a `raiseAttribute(Endurance,100k)` moved
   End 30→77 and MaxHP 15→39. Constraints coded in: `raiseSkill` needs the skill
   Trained; `trainSkill` only Untrained→Trained and the credit amount must equal
   the DAT `TrainedCost` (table baked from SkillTable 0x0E000004); specialization
   is not reachable via the wasm API. Observation surfaces unspent XP / skill
   credits / raisable+trainable skills (`observe_ext.js probeAdvancement`).

2. **General perception** (`observe_ext.js probeNearbyObjects` + webhost
   `TryGetObjectDescFlags`) — a `nearby:` observation line listing ALL named
   nearby objects/NPCs **typed via `ObjectDescriptionFlag`** (vendor / healer /
   portal / lifestone / door / corpse / npc / monster / sign / food) with guids,
   instead of the old threats-only view. The client already receives these
   flags, so no world-DB lookup is needed. (Classifier order: specific bits win
   over the generic ATTACKABLE bit, else signs/food/NPCs mislabel as monsters.)

3. **General interaction** (`rynth/ai/tools/world.js`) — `use_object` action:
   interact with any nearby object by name or guid (enter a portal, talk to an
   NPC, open a door). Guids in the perception line let it disambiguate
   same-named objects (two "Door"s).

4. **Memory** (`director.js`) — widened the journal tail the director sees from
   10 → 24 entries (~3 → ~8 check-ins) and added a `MEMORY` block to the system
   prompt telling the stateless director to record durable lessons in its `note`
   ("Samuel is an npc not a vendor") and not re-derive them. This directly
   targets observed wheel-reinvention.

All default-on, degrade to `{ok:false}` without host support. Tests green:
`rynth_ai_advancement_test` 23/23, `rynth_ai_world_test` 12/12, and
director/observe/observe_ext/economy/extensions suites unchanged-green.

## 1. The character "Brakis" (fresh L1 glass caster)

Account `playtest_soak` (password same), character **Brakis**, a genuinely fresh
Aluvian, un-plussed, access-level 0. Build (per user spec):
- Attributes **Coord/Quick/Focus 100, Str/End/Self 10** (330-pt allocation, no
  leftover) → **5 max HP** / 10 stam / 10 mana. Deliberately glass; the AI is
  expected to pump End/Health via the advancement tools.
- **Specialized** Finesse Weapons / Melee Defense / Arcane Lore; **Trained**
  Healing / Life Magic; 0 spare skill credits (all 52 spent). 10,000 pyreals +
  Aphus-Lassel starter kit. Level 1, 0 XP.

### ⚠ How it was built — and the ACE cache gotcha (IMPORTANT)

The build was applied by **patching the shard biota directly**
(`biota_properties_attribute` init_Level, `biota_properties_skill` `s_a_c`, etc.)
— because the client's `createTestCharacter` only makes a fixed
Aluvian/Adventurer template. **But ACE's PlayerManager caches player biota in
memory; DB edits do NOT reach the live game until an ACE restart** (logout even
re-saves the stale cache over your edits — EF "affected 0 rows" concurrency
errors in ACE_Log). The `WorldDatabaseWithEntityCache` mod is world-DB only;
this is stock ACE behavior. To apply a DB-built character you **must restart
ACE** (details recorded in `memory/ace-player-biota-cache.md` draft; the durable
FIFO relaunch is `dotnet ACE.Server.dll 0<> ~/ace_stdin.fifo`). ACE was cleanly
restarted this session for exactly this reason and came back in ~12s.

Also: accessLevel ≥ 4 makes chars **plussed** ("+Brakis") and `autoSpawn=Name`
then fails to match — use `autoSpawn=first` or set access 0 + `is_Plussed=0`.

## 2. Findings so far (the actual playtest signal)

- **Perception was threats-only** → the AI was effectively blind to vendors,
  NPCs, portals, signs. This blocked the entire gear→hunt→advance arc. FIXED
  (typed perception). This was the headline finding of the session.
- **No general interaction primitive** → couldn't take portals / talk to NPCs.
  FIXED (`use_object`).
- **Fresh chars start in the newbie Training Academy** (landblock 0x8602: Life
  Stone, Training Master/Samuel/Jonathan/Society Greeter [quest NPCs, weenieType
  10], Academy Shopkeep/Blacksmith/Researcher [the actual vendors], and an "Exit
  to Holtburg" portal). The real Holtburg town vendors (Sedor the Blacksmith,
  Thelnoth the Healer, Ecutha the Tailor, Archmage Cindrue, …) are in 0xA9B4.
- **maxActions=5 truncation**: the director batched 8-action plans; the tail
  (e.g. "…then exit") was dropped, causing it to loop. Worth tuning
  (`actions.js executePlan` default) — plans that end in a nav step lose it.
- **One-off empty completion**: gpt-oss (a reasoning model) returned empty
  content once at `maxTokens=4096` (larger observation squeezes reasoning room).
  Not yet a pattern; if empties recur, bump `config.ai.maxTokens` to ~8000.
- **Post-fix behavior**: the AI now correctly perceives NPCs vs doors, uses its
  memory (cites object guids), and reasons its way toward the exit — but was
  still working out that the labeled "Training Area" [door] object isn't a
  functional exit (the real one is the "Exit to Holtburg" **portal**, out of
  perception range until it moves). Spatial navigation is the current live test.

## 3. Judging the run (unchanged mandate from handoff 1)

Did it read its own state before acting; use perception + oracle to scout; gear
within budget and equip; keep spell components stocked (comps ARE consumed on
this server); **spend earned XP/credits sensibly** (the new advancement surface);
survive on 5 HP via evasion; and file tickets a dev would act on. Artifacts: the
journal + `/mnt/wbterminal2/playtest-tickets/`.

## 4. Open items / next steps

- **Tune maxActions** or teach the director to sequence nav steps so multi-step
  "do X then travel" plans don't lose the travel.
- **Watch for empty completions**; bump `maxTokens` if they recur.
- **Perception range**: `nearbyRangeM` defaults 0; only ~16–22 of the academy's
  104 objects stream near spawn. The AI must move to bring the exit portal /
  Academy Shopkeep into range — confirm it does, or consider whether a wider
  sense radius is warranted (general, not scripting).
- **Advancement in practice**: the char has 0 XP at L1, so advancement can't be
  exercised until it hunts. Confirm, once it has XP, that it raises End/Health
  and later trains Item/Creature/Mana-Conversion with earned credits.
- **`train_skill` can't specialize** (wasm API limit) — fine for the plan
  (magic schools are Trained-tier), but note it if specialization is ever wanted.

## 5. The live run — how to operate it (LEAVE IT RUNNING)

A soak is running **detached** (`nohup node soak_run.cjs`, NOT harness-tracked).
- Runner + artifacts under the session scratchpad:
  `soak_run.cjs`, `soak_status.txt` (45s snapshots), `soak_journal.txt` (journal
  tail, rewritten every ~3 min), `soak_stdout.txt`.
- Config: headless chromium `--disable-gpu`, url `?nosw=1&nullRender=1&
  netDrainHz=30&autoLogin=1&account=playtest_soak&password=playtest_soak&
  autoSpawn=first`; `createGrindBot(sh,{ai:{apiKey,model:"openai/gpt-oss-120b",
  maxTokens:4096,intervalMinutes:4,persona,autoStart:true}})`. OpenRouter key in
  scratchpad `orkey` ($2 / 24h budget; ~$0.04 spent by t+17m — trivial).
- Stack it needs (all up): ACE 9000/9001, serve.py :8765, wsbridge :8080,
  wbt-sidecar :8768 (oracle), rynthnav :8767.
- To stop it: `pkill -f soak_run.cjs`. (Note: chaining `sleep`/`pkill`/`setsid`
  in one harness Bash call gets SIGTERM'd — exit 144; launch with plain
  `nohup node … &` and `run_in_background`.)
- A persistent **Monitor** streams plans/results, new tickets, deaths,
  level-ups; it self-terminates when the node process exits.

Current state at handoff: **level 1, HP 5/5, 10k pyreals, 3 LLM calls, 0 deaths,
2 (baseline) tickets, still navigating out of the academy.**
