# Handoff — playtester soak, session 4 (senses, walking, and the model bake-off)

Continues `HANDOFF-playtester-soak-3.md`. This session ran ~9 soak
iterations (v5 → v5.9) at escalating cadence, found and fixed four
load-bearing client bugs that had silently invalidated every previous
soak's NPC interactions, shipped the contingent-planning surface, and
bake-tested three LLM brains on identical harnesses. A v5.9 run
(nemotron-3-ultra) is live as of this handoff.

## 0. The four root causes (each live-proven, each committed)

1. **The bot was deaf** (`e18ee0b9`). NPC speech/tells/popups ride the
   webhost push-event plane (ClientEvent kind 2); nothing in the AI layer
   subscribed. Every NPC conversation in every prior soak was answered
   into the void. Fixed: category-filtered ring buffer → `heard since
   last check-in:` observation section (repeat-collapse, drained per
   check-in). Chat categories from lib.rs `CHAT_CATEGORY_*`; combat/magic
   spam excluded; kind 13 UseFailed surfaced as `use FAILED: <WeenieError>`.
2. **use_object never walked** (`e18ee0b9`, `09f07fd6`, `ac091078`).
   Bare `GameAction::Use` sends with no client approach; ACE answers a
   far Use with `UseDone(OutOfRange)` and fires no emote (retail contract:
   the CLIENT walks into UseRadius first; ACE's server-commanded fallback
   MoveTo is ignored by our client). Fix evolved twice: pursuitStatus
   polling was worthless — the arrived/failed latch is READ-CLEAR and the
   bot kernel's tick loop consumes it first — final form watches the
   player's own pose and acts when movement settles (`walk:` tag
   settled/no-walk/blind/timeout in every result + journal note).
   Ground-truth proof: Brakis's quest registry was EMPTY after three
   soaks of "using" Jonathan; the greeter's `CallingStoneGiven` stamped
   the moment an in-range use actually happened.
3. **Phantom perception targets** (`fbbf7758`, wasm). `nearbyEntityGuids`
   returned worn/contained child objects (the training dummies' armor)
   as world objects — same display names as the real floor pickups two
   rooms over. Bot chased them for 20+ min. Fixed in wasm: roots only
   (`WorldObjectExt::is_root()` + `physics_parent_id`). pkg/ rebuilt
   --release (4.8MB — dev is ~18MB, always check).
4. **Straight-line pursuit wedges on walls** (OPEN — the next big item).
   Cross-room approaches (`walk:no-walk` at 25m) press into walls and
   settle immediately; same-room interactions all work. This is the
   deferred indoor-router leg wiring from handoff 3, now with a concrete
   reproduction: Jonathan stands in cell 0x01B0, unreachable by pursuit
   from the hub. Any use/give targeting an adjacent room needs
   door-waypoint legs.

## 1. What else shipped

- **1-minute cadence** — `bot.js` plumbs `minIntervalMinutes`/
  `maxIntervalMinutes` (director already accepted them); the model's
  habitual `next: 5m` is clamped mechanically. `maxCallsPerHour` default
  12 silently vetoed anything faster (director skips over-budget
  check-ins) — runner sets 65. `maxActions: 8` (stall responses produce
  batched sweeps; 5 truncated them).
- **STALLED line** (`e18ee0b9`) — landblock unchanged for stallMinutes
  (default 10) + ≥4 object uses → authoritative change-approach-class
  nudge. The loop detector is blind to novelty-dithering (a fresh sign
  every cycle); this catches it. Live-proven on all three brains — each
  quoted it and pivoted.
- **if-guards** (`e18ee0b9`) — any action may carry `if`:
  `inventory_gained` | `moved` | `heard:<text>`, evaluated mid-plan
  (~3s settle poll) against what prior actions changed. Contingent
  chains in ONE check-in. gpt-oss and M3 both adopted it spontaneously
  from a one-paragraph prompt note; M3 misapplied once (guard on a
  scratchpad write) and self-corrected next cycle from the skip message.
- **tried: counts** — `Door 0x…2D (x3)`; kills "not yet used" false
  memories, and Nemotron recites it verbatim when stalled.
- **word-AND knowledge search** (`c101e4d1`) — "Academy Token" can now
  match "Academy Exit Token" (phrase-substring alone never could).
- **embedded-guid refs** (`e18ee0b9`) — "Door 0x7860202d" (name+guid in
  one string, persistent model habit) resolves by the guid.
- 19 suites / 920+ checks green throughout (new `rynth_ai_chat_test.cjs`).

## 2. Academy ground truth (world-DB verified — for the eval, don't feed the bot)

- All hub NPCs are `linkmonstergen 0x78602093` spawns → DYNAMIC guids
  (0x80000314 Jonathan, 0x8000031A Samuel, 0x8000031E Training Master,
  0x80000317 Greeter). The 0x786020xx "instances" are generator slots.
- **Exit fast path**: use Jonathan (wcid 29324, UseRadius 3m) →
  QuestFailure branch of `AcademeyExitTokenGiven` → stamps quest + gives
  Exit Token 29335 + tells "give this token back to me" → give it back →
  teleport to Holtburg. Retail transcript (acpedia "Jonathan") matches
  ACE emote strings verbatim.
- **Intended slow path**: Sparring Golems (wcid 12698,
  `golemsparringtokennewbieacademy`) carry **Academy Token wcid 12709 in
  their corpse create-list** — kill golem → loot token → give to
  Training Master. The v5.4 bot that "got locked onto a Sparring Golem"
  was accidentally on-curriculum.
- Armor quest: floor pickups 0x7860209F–A2 (cells 0x01B0/0x01B6) are
  `linkitemgen 0x7860209E` children; PickUp emotes stamp
  `{Gauntlets,Cap,Leggings}AcademyPickUp`; Samuel InqQuests them and
  REFUSES the items themselves.
- ACE signs are inert on Use (no text events) — Training Master's spoken
  hint says signs grant the token; they don't. Legitimate parity-gap
  ticket the bot may file.
- Shard-DB reads lag in-memory state (periodic saves) — use the runner's
  `inv=`/`pos=` status lines for near-real-time truth; quest registry
  writes land fast, position on save.

## 3. Model bake-off (same harness, same academy)

| brain | style | measured cost | verdict |
|---|---|---|---|
| gpt-oss-120b | format-solid, shallow plans, terse | ~$0.02/h (0.8k compl/call) | fine harness-validator, weak explorer |
| minimax-m3 | quotes dialogue verbatim, hypothesis-tests, heavy CoT | ~$0.33/h (3.5k compl/call), 1 empty completion at 8k cap | best narrator; raise maxTokens |
| nemotron-3-ultra-550b | terse decisive plans, recites tried:/STALLED evidence, fast | ~$0.18/h (160–600 compl/call!) | best value-per-quality so far; maxTokens 16000 set |

`nemotron-3-super-120b` ($0.21/$0.455) is the untested value sleeper.
Output tokens dominate reasoning-model cost — always measure compl/call
before projecting.

## 4. The live run — v5.9 (LEAVE IT RUNNING)

Runner: session-681edab7 scratchpad `soak_run_v5.cjs` — v4.1 config +
`nemotron-3-ultra-550b`, maxTokens 16000, intervalMinutes/max 1,
maxCallsPerHour 65, maxActions 8, effort medium. Same URL flags
(`nosw=1&nullRender=1&bakeWorker=0&netDrainHz=30`), same stack
prerequisites (ACE 9000/9001, serve.py :8765, wbt-sidecar :8768,
rynthnav :8767). Artifacts: `soak_status.txt` (45s), `soak_journal.txt`
(90s), `soak_stdout.txt`. Monitor streams plan/result/budget/warning/
ticket lines (dedup via sort+comm — survives journal rewrites) +
tickets/deaths/level-ups/landblock changes.

### Ops traps re-learned this session (cost us ~4 restarts)
- `pgrep -f <pattern>` matches the harness Bash WRAPPER's own cmdline;
  `| head -1` then kills the wrapper and ORPHANS the node runner (two
  soaks ran concurrently fighting over the account before this was
  caught). Kill by exact node pid: iterate pgrep hits and check
  `readlink /proc/$p/exe` ends in node. Same trap self-killed a build
  via `kill $(pgrep -f rust-analyzer)`.
- cargo/wasm-pack builds alongside the soak on this 8GB box OOM-kill the
  renderer ("Target crashed") — pause-or-accept-restart before building.
- Monitor boot-grep needs a versioned marker (`bot start (v5.9`) or it
  false-arms on the previous run's status lines; journal replay after
  restart re-notifies old lines once (dedup baseline reset — ignore
  pre-boot timestamps).
- OpenRouter usage rows (user-pasted) are the authoritative per-call
  cost; the status line's `spend` only counts what llm_client sees.

## 5. Next session candidates (in rough value order)

1. **Indoor pathing legs** — door-waypoint routing for cross-room
   pursue/use (the one remaining mobility wall; §0.4).
2. Let the combat/loot kernel path run: golem → corpse → Academy Token →
   Training Master (slow path is fully in-data; the bot's kernel already
   engages golems when close).
3. Persist the scratchpad across restarts (dump/restore in runner like
   the journal) — every restart re-learns the academy from zero.
4. Event-driven early check-ins (heard/WARNING/delta triggers) — cheaper
   than uniform fast cadence; discussed and shaped this session.
5. Corpus-from-world knowledge bake via WBT for custom worlds; keep
   acpedia as opt-in "retail veteran" mode. Track solved-with vs
   -without-lookup in the eval.
