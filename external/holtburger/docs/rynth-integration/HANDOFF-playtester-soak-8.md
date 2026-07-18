# Handoff — playtester soak, session 8 (no-hints mode + content repair + GLM 5.2)

Continues `HANDOFF-playtester-soak-7.md`. That session's §4 candidates 1–3 were
worked plus a large detour the live runs forced: two root-caused client bugs,
one systemic ACE/content bug (silent item destruction), and the first world-DB
content repairs of the series. Code is committed as `11dafa36` (all suites
green: world 83, economy 45, wbt 54, indoorsim 26, client 61, extensions 37,
chat 19, holtburger-world 551). The v6.4 run readout that motivated most of
this is in §4.

## 1. What shipped (code, commit 11dafa36)

1. **No-hints soak mode** (user decision): `config.ai.wbt = { query: false }`
   registers ONLY `file_ticket` — `wbt_query`/`wbt_catalog` are gone from the
   action map and the prompt. `knowledge: false` (acpedia) as before;
   `dungeonNav` stays ON (user decision: it reads live EnvCell data — in-world
   perception, not an external oracle). The STALLED nudge drops its "knowledge
   lookup" suggestion when knowledge is off. Persona no longer mentions the
   WorldBuilder oracle.
2. **Cross-landblock indoor routing** (soak-7 §4.3): new
   `buildStitchedGraphFromWasm(lbIds, opts)` in `rynth/indoor_router.js`
   merges multiple landblocks' EnvCell graphs — portal ids are full 32-bit,
   so seam doorways connect with no synthetic edges; capped expansion
   (default 8 LBs) chases boundary references. `indoorLegsTo` dropped its
   `pc>>>16 !== tc>>>16` bail; graph cache keyed by LB set. Live-proven:
   routes of 18/32 legs where v6.4 flat-refused (some fail mid-walk — §7.3).
3. **use_item safety pair** (both live-validated in v6.5.x):
   - consumption verdict: after use, poll ~2.5s and journal either
     `item CONSUMED: it is GONE from your inventory` or "still in inventory
     after use" (+ `result.consumed`). Kills the v6.4 stale-token delusion.
   - retail-parity Useable.No guard: `use_item` refuses items whose
     `PropertyInt.ItemUseable` (16) === 1 (Useable.No) BEFORE the wire —
     see §3 for why this matters (ACE destroys them).
4. **System chat audible**: heard-chat default categories now include client
   category 0 (system). ACE answers many failures via System chat (e.g.
   "Portal destination for portal ID N not yet implemented!" — §2); the old
   filter dropped exactly those explanations, so failures looked silent.
5. **lvl=0 root cause, two layers** (Rust, `holtburger-world`): ACE re-sends
   the local player's own ObjectCreate (transitions/visibility);
   `upsert_entity_from_create` replaced the entity wholesale, wiping every
   PlayerDescription-only property (Level first — the v6.4 `lvl=0` watch
   item; XP int64 updates later repopulated around it). Fixes: (a) merge the
   existing entity's properties underneath the create baseline; (b) stash the
   PlayerDescription dump in `WorldState.player_description_properties` and
   re-seed from it when the entity was REMOVED before the re-create (second
   wipe path, observed live in v6.5.0); (c) `get_level_info` derives level
   from TotalExperience vs the xp table as a last resort. Regression tests in
   `state/tests.rs`; release wasm rebuilt (4.8MB).
6. **LLM plumbing**: `llm_client` passes OpenRouter `provider` routing
   verbatim (`{ order: [...], allow_fallbacks: false }`, bot.js passthrough).
   `TryGetCoins` falls back to summing pyreal `stackSize` (item Value does
   NOT ride login CreateObjects; player CoinValue(20) is computed lazily
   server-side and usually absent from the biota). `goto_lb`'s indoor refusal
   now states that object guids are never cell ids.

## 2. World-DB content repairs (MySQL only — NOT in git; re-apply after any DB restore)

Grounded in LSD retail data (`$LSD/weenies/`), applied to `ace_world`
2026-07-18, caches flushed via ACE console `clearcache` (see §6):

```sql
-- Both portals were destination-less ACE stubs (the ONLY two instanced
-- destination-less portals in the whole DB). Retail destinations from LSD
-- 31061 'Central Courtyard' / 29334 'Outer Courtyard' — both into the
-- SHARED academy courtyard complex, landblock 0x7203.
INSERT INTO weenie_properties_position
  (object_Id, position_Type, obj_Cell_Id, origin_X, origin_Y, origin_Z,
   angles_W, angles_X, angles_Y, angles_Z) VALUES
  (31061, 2, 0x7203021F,  50.00951,  -56.59075, 0.005, -0.00627,  0, 0, -0.99998),
  (29334, 2, 0x720302C3, 120.5789,  -142.2359,  0.005,  0.999751, 0, 0, -0.022302);
-- Academy Exit Token 29335: retail weenieType Generic(1)/ItemType Misc(128);
-- this DB had Gem(38)/Gem(2048) — the consume-on-use trap (§3).
UPDATE weenie SET type=1 WHERE class_Id=29335;
UPDATE weenie_properties_int SET value=128 WHERE object_Id=29335 AND type=1;
```

Notes: `Exit to Holtburg` (29338, instanced at cell 0x86020169) already had
its retail destination 0xA9B40019 — the walk-out exit was never broken.
Existing token INSTANCES in shard biotas keep `weenie_Type=38`; the client
guard covers them (they carry Useable.No), and new characters mint correct
ones. Consider exporting these as SQL patch files into the repo.

## 3. The silent item-destruction bug (ticket resolutions)

The bot filed two tickets in v6.5.1; both root-caused, annotated, and
archived to `/mnt/wbterminal2/playtest-tickets/resolved-2026-07-18/` (active
tracker emptied for the current run).

1. *"Central Courtyard portal returns use_object:ok but never teleports"* —
   destination-less stub portal (§2) + the client dropping ACE's System-chat
   explanation (§1.4). Content fixed; explanation now audible.
2. *"Academy Exit Token consumed by use_item with no teleport effect"* — ACE
   `Gem.ActOnUse` (Gem.cs:183-184) never checks the Useable flag (retail
   clients refuse to send Use for Useable.No items, so retail servers never
   validated it) and consumes the gem after a no-op use. **Survey: 473 of
   1,765 Gem-class weenies in ace_world have no spell, no contract, no
   UseCreateItem and no UnlimitedUse(63)** — every one is a silent
   self-destruct on use (quest tokens, plain gemstones like Jet/Black Opal,
   crafting ingots, rare tokens). Both v6.4 (Brakis) and v6.5.1 (Varek)
   destroyed their Academy Exit Tokens this way. Client guard shipped
   (§1.3); the 473-item survey is upstream-ACE / content-fix material.

## 4. Run history this session

- **v6.4 (nemotron, Brakis) final readout**: killed at t+35m (user request,
  cost). Confirmed: armor tutorial completed (the v6.2/v6.3 wall), academy
  progressed, self-care good, zero AI errors, 26 calls ~150k/23k tokens.
  Died on: token consumed at t+8m + 20 min of stale "token in inventory"
  scratchpad belief + cross-LB routing refusals + wbt_query allowlist miss.
  `lvl=0` reproduced (root cause §1.5, NOT the runner's read).
- **v6.5.0 (GLM 5.2, fresh char Varek)**: strong open, lvl=0 second wipe
  path observed live (fix §1.5b), killed to restart with model/provider pin.
- **v6.5.1**: GLM also experimentally consumed the token (persona warning
  alone insufficient → hard guard §1.3b); CONSUMED verdict + both tickets +
  give_item/appraise/open_container/dungeon_suggest all exercised. Killed
  for ticket work. Varek-specific mystery: his 10,000-pyreal stack never
  streams into `playerInventory()` after relog (coins read 0) while control
  chars' stacks do — open, see §7.2.
- **v6.5.2 (fresh char Torval)**: clean early phase, killed for content
  repair (§2).
- **v6.5.3 — LIVE at handoff**: Torval + carried scratchpad (clean: no
  stale portal beliefs), token intact, all guards armed, portals fixed,
  caches flushed, landblock reloaded. Marker
  `bot start (v6.5.3 content-fixed portals glm-5.2)`.

**Model/provider**: `z-ai/glm-5.2` pinned
`{ order: ["streamlake","novita","baidu"], allow_fallbacks: false }` — the
three 75%-off fp8 sale endpoints, fastest first (StreamLake 1.08s/52tps vs
Novita 2.64s/30tps; 30tps flirts with the 60s client timeout at medium
reasoning), never falling through to 4x-price fp4 quants. Live-verified.
GLM runs ~400-800 completion tokens/call (nemotron ~1-2k); ~$0.05/hour at
1-min cadence.

## 5. Reading the live run

Artifacts: `/mnt/wbterminal2/holtburger-scratch/soak-v65/` —
`soak_status.txt` (1 line/45s), `soak_journal.txt` (rewritten every 2 ticks),
`scratchpad_persist.txt` (mirrored every tick), `soak_stdout.txt`; prior
sub-runs archived as `*.v650/v651/v652.txt`. Runner self-terminates at
RUN_MS (default 6h) writing a FINAL journal. `monitor_v65.sh` is a STREAMING
monitor (emits one line per event: death/terminal, leaving LB 0x8602 = the
academy-exit proof, level-up, tickets/confirms/deaths/CONSUMED, AI errors ≥3,
hourly heartbeat) — run it under the Claude Monitor tool or
`nohup ... > monitor.log &`. The success criterion for the content fix is the
`LEFT ACADEMY LB` line (courtyard portals → 0x7203, walk-out → 0xA9B4xxxx).

## 6. Ops (carried + new)

Carried: ACE `dropped. Account: playtest_soak` + 15s before relaunch; runner
ignores SIGTERM — SIGKILL the exact node pid; ACE (UDP 9000/9001) + serve.py
:8765 + wsbridge :8080 + rynthnav :8767 + wbt-sidecar :8768 up before boot;
`?nosw=1` mandatory after JS edits; playwright via
`NODE_PATH=~/.npm/_npx/e41f203b7505f1fb/node_modules`; release wasm ~4.8MB.
New this session:
- ACE console FIFO is now DURABLE: `~/ace_stdin.fifo` (verify with
  `readlink /proc/$(pgrep -f ACE.Server.dll)/fd/0`). `echo clearcache > ~/ace_stdin.fifo`
  flushes weenie/landblock-instance/recipe/spell caches — then the affected
  landblock must UNLOAD (empty ~5-7 min) before instances re-read the DB.
- Character creation: `create_char_v65.cjs <Name>` (boot `autoSpawn=0`,
  `createTestCharacter`, poll char list). Account chars now:
  Brakis (dead token), Varek (dead token, coins mystery), Torval (active).
- Unattended behavior: the runner/services are nohup'd ppid-1 orphans —
  they survive SSH disconnects and keep running with no Claude session;
  they die on reboot, nothing auto-restarts them, and earlyoom PREFERS
  killing chrome/node under memory pressure (an OOM ends the run silently —
  the status file just stops growing).

## 7. Next-session candidates

1. **Read v6.5.3 to its end** (status/journal/FINAL): did the courtyard
   portal fire (`LEFT ACADEMY LB` → 0x7203)? Are the weapon vendors there?
   Does `use_item_on` (keys/locks — the one still-unexercised verb) come up?
   Did the Useable.No guard fire; did system-chat lines land in 'heard'?
2. **Varek pyreal-stream mystery** (task list #8): his coin stack never
   reaches `playerInventory()` on relog; control char fine on same wasm.
   Needs a netbrain packet capture of the login CreateObject sequence
   (suspect equipped-items ordering or the SIGKILL-saved biota shape).
3. **Cross-LB route-failed mid-walk**: stitching produces the route
   (18/32 legs) but some follows die partway — read the failures, check
   closed-door retry reach (10m) vs long routes, and whether nearestCell
   fallback picks far-LB cells when the pose cell is missing from the graph.
4. **holtburger-core: the 10 stale movement tests** (handoff-7 §5 —
   untouched this session; full root-cause + fix sketches there).
5. **Content follow-ups**: export §2 as repo SQL patches; decide whether to
   retail-correct the other 472 consume-on-use gems (LSD has retail typing
   for most; bulk-compare weenieType/ItemType vs LSD before touching).
6. If v6.5.3 exits the academy: Holtburg shopping exercises buy/sell paths —
   watch coins (fallback reads stackSize) and vendor flows for the first
   outdoor + economy soak of the series.
