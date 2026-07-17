# Handoff — playtester soak, session 3 (director thought-chain overhaul)

Continues `HANDOFF-playtester-soak-2.md`. This session researched why the
step-3 soak stalled (LLM-game-agent literature + live-journal forensics +
ACE world-DB ground truth), then shipped a three-tier director overhaul.
A v5 soak is running as of this handoff — see §5.

## 0. The diagnosis (why Brakis never left the academy)

Live-journal forensics on the v3 soak showed the canonical failure of every
LLM-game-agent effort (Claude/Gemini Plays Pokémon, NetHack, Voyager):
**the model wrote predictions into memory as facts and nothing mechanically
contradicted it.** `use_object:ok` means "request sent" (a door opening),
not "outcome achieved"; the bot journaled "Exited training academy via door
0x78602038; should now be near Holtburg" while standing still, then the
MEMORY instruction ("trust your notes, don't re-derive") *preserved the
false belief*. Secondary blockers, all ground-truthed against the ACE world
DB (`ace_world.landblock_instance`, LB 0x8602 = 104 objects):

- The intended fast exit is **Jonathan** (`academyguardexitholtburg`,
  0x78602094, ~10m from spawn): *use* him → receive an Exit Token →
  ***give* the token back** → `TestSuccess` emote sets sanctuary Holtburg
  (A9B40019) + instant-cast teleport out. The director had **no give
  action** (the wasm `giveObject` / GameAction 0x00CD existed, unexposed).
- The walking alternative (`portalnewbieexitholtburg`, (158.6,−149.5,−6))
  is ~180m of dungeon away; rynthnav (:8767) is **outdoor-only** (25 tiles,
  817 portals; rejects dungeon-local negative-y coords), `goto_lb` validates
  x/y into [0,192), and the v3 soak config **never wired `config.nav`** at
  all (`goto:FAIL nav not configured`, observed live).
- The "Central Courtyard" object (0x78602052, wcid 31061,
  `ace31061-centralcourtyard`) carries a portal description flag but **has
  no Destination property** — a fake portal the bot correctly tried twice.
  Ticket material the bot itself should file.
- gpt-oss empty completions: OpenRouter allocates ~50% of `max_tokens` to
  hidden reasoning at medium effort; at 4096 with a 6k observation, content
  comes back empty with `finish_reason:"length"` (observed live at v3
  20:23, "actions: none | next: -m").
- Sanctuary is already Holtburg for fresh chars, so at L1 (no item drop)
  dying is technically a working exit. Noted, not a strategy.

Strategy research (Reflexion, Generative Agents, Voyager, the Pokémon
harness writeups, TITAN MMO-QA, BALROG) distilled to: two-tier memory
(persistent model-edited scratchpad + rolling tail), harness-injected
ground truth over prompt persuasion, mechanical loop detection outside the
model, goal slots re-injected every call, movement at landmark granularity,
and expectation-vs-outcome diffing as the bug oracle.

## 1. What shipped (all default-on, all degrade to {ok:false}; 14 suites /
~750 checks green)

**Tier 1 — unblock:**
- `give_item {item, target, qty}` (`tools/world.js`) over new
  `webhost.GiveObject` → wasm `giveObject` (0x00CD). Resolves item from
  `TryGetPlayerInventory` (economy.js `resolveItem`, now exported), target
  from nearby.
- **Loop detector** (`extensions.js`): movement-intent actions
  (`use_object`/`goto`/`goto_lb`) repeated with <3m movement *since the
  last identical attempt* prepend an authoritative
  `WARNING: <action> attempted Nx with NO position change…` to the next
  observation. Fired live within one cycle on the fake courtyard portal
  (v3 wasted 30+ min on the same shape).
- **GROUND TRUTH prompt block** (`director.js`): ok = sent-not-worked;
  verify against the next observation before journaling success;
  observation beats notes; pass guids not names (the live bot passed a
  bare "Door" while citing the guid in prose — ambiguity error).
- **LLM client** (`llm_client.js`, additive to frozen SPEC): `reasoning`
  ctor passthrough (OpenRouter unified, e.g. `{effort:"low"}`), new error
  kind `"length"` for empty-content/finish_reason=length, retried once at
  doubled `max_tokens` (no backoff — deterministic fix). `bot.js` plumbs
  `config.ai.reasoning`.
- **COST DISCIPLINE prompt**: `none` is for "doing fine", never for
  "stuck" (v4-low-effort produced two consecutive none-turns while
  blocked).

**Tier 2 — thought chain:**
- **Persistent scratchpad** (`tools/memory.js`, `update_scratchpad`
  action): model-editable memory REPLACED wholesale (curation not
  accretion, ≤1500 chars), localStorage-persisted, injected into every
  observation; MEMORY DISCIPLINE prompt mandates a `goals:` line first
  (primary/secondary/tertiary) — goal slots and durable lessons in one
  mechanism. Journal tail stays the recency tier.
- **`goto_object {object}`** (`tools/world.js`): walk to a perceived
  object *without* using it (`webhost.PursueObject`) — approach, scout,
  drag the 60m perception bubble somewhere new.
- **Bearings**: nearby entries now `name [type] 0xguid d=12m NW`
  (`observe_ext.js` compassOctant, world-frame delta).
- **`tried:` / `explored:` lines** (`extensions.js`): harness-tracked
  used-object list (via a `ctx.track` seam in world.js actions) + visited
  cell count — "prefer what you have NOT tried" is now checkable.
- `cfg.maxActions` override; over-cap actions were already per-action
  `plan truncated` errors in the result line (guardPlan), documented.
- **Fixed**: the observe seam returns `{text, data}` — the Tier-1 warning
  prepend was stringifying it to `[object Object]` when it fired. Shape
  now preserved.

**Tier 3 — playtester quality:**
- **`since last check-in:` deltas line** (`extensions.js`): harness-
  verified movement (m), coins/inventory/kills deltas — the
  expectation-vs-outcome raw material (TITAN's oracle pattern, lean form).
- **PLAYTESTER DISCIPLINE prompt** (appended when wbt is on): persistent
  expectation mismatches are BUGS → `file_ticket` with guid/expected/
  actual; coverage is a standing tertiary goal.
- **Ticket dedupe** (`tools/wbt.js`): normalized-title session dedupe —
  re-filing returns `ok:false "already filed"` instead of spamming.

**Deferred** (revisit if the soak shows need): periodic fresh-context
critic/compaction call; same-check-in tool-result round-trip (second LLM
call); indoor-router leg wiring into `router.follow`; the **pose-frame
wrap bug** (v4.0 login reported dungeon (46.9,−20.2)@0x8602 as
(46.9,171.8)@0x8601 outdoor — fake cell, 404 shard-fetch flood, would feed
`goto` garbage; not reproduced on the v4.1 login; client-side, needs a
wasm/webhost look).

## 2. New action surface (extensions catalog additions)

`give_item {item, target, qty?}` · `goto_object {object}` ·
`update_scratchpad {text}` — plus observation sections: `WARNING` (loop),
`SCRATCHPAD`, `since last check-in:`, `tried:`, `explored:`, and bearings
on `nearby`.

## 3. Live behavior deltas observed (v4/v4.1, before the full stack)

- v4: same door-loop start (fresh journal), then found + used the fake
  courtyard portal, **loop WARNING fired, bot abandoned it in one cycle**.
- v4-low-effort: two `none`-turns while stuck → prompt fix + effort medium.
- v4.1 first check-in: chose greeter + sign reading (exploratory) instead
  of `none`. Guid discipline self-corrected after one ambiguity error.

## 4. Verification bar for this run

Same mandate as handoff 1/2 §3, plus: does it use the scratchpad (goals
line maintained, lessons recorded once), react to WARNING/deltas lines,
exit via Jonathan (use → give_item Exit Token) or the long walk, file the
fake-portal ticket, and spend XP once it hunts. Watch
`spend.completionTokens` (medium effort + 8000 cap) and aiErr for length
retries.

## 5. The live run — v5 (LEAVE IT RUNNING)

Runner: session-d4ffeb0f scratchpad `soak_run_v4.cjs` (v4.1 config), 6h,
launched with `NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/
node_modules` (playwright lives there — script-relative resolution fails
from scratchpad). Config vs v3: `nav` endpoint wired, `maxTokens: 8000`,
`reasoning: {effort:"medium"}`, same persona/account, and
**`&bakeWorker=0` on the URL** — the bake worker's second wasm instance
plus the ~1.5GB renderer put available RAM under earlyoom's -m 12
threshold on this 8GB box and the renderer got SIGKILLed at scene init
("FATAL page.evaluate: Target crashed", twice). Main-thread bake = slower
boot, one wasm memory. Swap was near-exhausted (zram 3.8G full + 2.5/3G
disk) — check `free -m` before relaunching anything heavy. Artifacts:
`soak_status.txt` (45s, now includes `pos=`), `soak_journal.txt` (~3min),
`soak_stdout.txt`, same stack prerequisites (ACE 9000/9001, serve.py
:8765, wsbridge :8080, wbt-sidecar :8768, rynthnav :8767).
Stop: `kill $(pgrep -f 'node.*soak_run_v4')` — pkill chained with sleep in
one harness Bash call SIGTERMs itself (exit 144), kill-by-pid is safer.
A persistent Monitor streams boot/plans/results/tickets/deaths/level-ups/
landblock changes. Each fresh browser profile resets journal + scratchpad
(localStorage): intentional this session (poisoned-memory reset), but a
future session may want to persist the scratchpad across restarts (dump to
a file in the runner like the journal, restore on boot).
