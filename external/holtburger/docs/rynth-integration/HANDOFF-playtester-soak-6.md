# Handoff — playtester soak, session 6 (belief grounding + pose-cell root fix)

Continues `HANDOFF-playtester-soak-5.md`. That session's v6.2 run proved the
indoor routing but exposed a cluster of *belief* failures — the bot acting on
world-state it never observed. This session data-grounded every one of them
against the ACE world/shard DB, fixed them at the source, and launched v6.3.

## 0. v6.2 post-mortem (all shard/world-DB grounded)

- **The bot never ran `inventory` once in 24 min** — and asserted "no token
  in inventory" while the shard DB showed Brakis holding Academy Exit Token
  29335 (from creation) the whole time. One `give_item` from the exit.
- **"Leather Cap/Gauntlets/Leggings are training dummies" was FALSE**
  (handoff-5 §1 got this wrong too). They are REAL ground armor items
  (itemType Armor): gauntlets 13240 in cell 0x01B0, cap 13239 + leggings
  13241 in 0x01B6 (10s linkitemgen respawn). They read as `[monster]`
  because ACE defaults EVERY WorldObject's ODF to Attackable
  (`WorldObject.cs SetEphemeralValues`) and our classifier had no item
  category — a tooling bug, not (only) a cognition one.
- **Training Area door stall (22 min)**: `use_object` on a door opens it and
  nothing else; the bot expected teleport-on-use. Tool desc never said
  otherwise.
- **`pause` skipped on invented if-guard** `"kernel_running"` with 8 golems
  at 5 HP — unknown guards used to skip the action.
- **Exit flow ground truth** (LSD emote tables + live quest registry): all
  four academy Jonathans (29317/24/25/26): Use → QuestFailure branch gives
  token 29335; **Give(29335) → teleport 0xA9B40019 Holtburg + starter kit
  (12711×2, 13210/11, 49563) + 11,000 XP + `ExitAcademy` stamp**. There is
  also a walk-out portal `Exit to Holtburg` (29338) at cell 0x0169. Brakis's
  quest registry still shows only `CallingStoneGiven`.
- Unexplained: a plain wielded `Cap` (wcid 118) appeared at t+18m
  (obj 2147539964). Not from the academy leather set. Low priority.

## 1. What shipped (this session, all tests green)

1. **Pose-cell freeze ROOT FIX** (`crates/holtburger-world/src/spatial/
   faithful_bridge.rs` marshal): the faithful transition pinned the settled
   pose's cell to `input.begin` and only re-derived on outdoor rebucket or
   entry/exit flips — indoor→indoor EnvCell walks kept the login cell
   forever (v5.9: 0x01AD across 60m). Now the else-branch re-derives via
   `scene.current_cell(&pose)` (point-in-AABB, identity fallback).
   Regression test `indoor_walk_rederives_envcell_low_word` (548 crate
   tests pass). NOTE: the physics slice settles ~0.65m per 1.3m request —
   test boundaries must sit inside the settled distance.
   UNVERIFIED (flagged by the root-cause agent): whether the outbound
   AutonomousPosition heartbeat was shipping the stale cell to ACE.
2. **Nearby classifier item category** (`rynth/ai/observe_ext.js`):
   `classifyDesc(flags, itemType)` — non-creature ItemType (PropertyInt 1,
   spawn-hydrated per `entity.rs apply_description`) → `[item]`, beating
   the ATTACKABLE fallback. `[monster]` now requires creature bit or
   unknown itemType.
3. **Inventory line in EVERY check-in** (`observe_ext.js`): full pack list
   (cap 24 + explicit "+N more") + worn split, high truncation priority.
4. **Unknown if-guards fail OPEN** (`rynth/ai/extensions.js`): action runs,
   journal warns, prompt documents it.
5. **Indoor goto refusal** (`rynth/ai/actions.js`): goto/goto_lb from an
   indoor pose (or to an indoor target cell) fail fast with "use
   goto_object" guidance instead of rynthnav HTTP 400 spam.
6. **Door/pickup guidance** in `use_object` desc (doors only open; walk
   through via a target beyond; using ground items picks them up).
7. **Knowledge overlay corpus** (`rynth/ai/tools/knowledge.grounded.json` +
   `FetchKnowledgeProvider overlayUrls` merge, overlay wins on title) —
   world-DB-verified academy entries correcting acpedia (its "Jonathan" is
   the L180 Eldrytch one). **BUT: knowledge is DISABLED in v6.3** — user
   decision 2026-07-18: no lore lookup; the bot must learn novel worlds
   in-world. Overlay stays as opt-in config + dev reference.
8. **Scratchpad persists across runner restarts** (runner-side):
   localStorage seeded from `scratchpad_persist.txt` on boot, mirrored out
   every 45s poll.
9. Release wasm rebuilt (4.8MB, `pkg/`), 19 AI suites + navsim 28 +
   indoorsim 22 + world crate 548 all green.

## 2. The live run — v6.3

Runner: `/mnt/wbterminal2/holtburger-scratch/soak-v63/soak_run_v6_3.cjs`
(durable dir; status/journal/scratchpad_persist alongside). Marker
`bot start (v6.3 fixed-cell no-lore`. Same nemotron-3-ultra-550b, 1-min
cadence, maxActions 8; `knowledge: false`; persona no longer mentions
"your knowledge". Monitor watches plans/results/tickets/inventory/LEVEL/
CELL CHANGE (pose-fix liveness proof)/TELEPORTED TO HOLTBURG/
`ExitAcademy` shard-DB stamp.

Ops (carried + new): wait for ACE `dropped. Account: playtest_soak` + 15s
before relaunch; runner ignores SIGTERM — SIGKILL the exact node pid;
serve.py :8765 + rynthnav :8767 + ACE up before boot; `?nosw=1` mandatory
after JS edits.

## 2.1 v6.3 → v6.3.1 mid-session restart (take_item)

v6.3's first 9 minutes were a leap — cells streaming live, `[item]` labels
informing plans from tick one, and at t+7m the bot spotted the Exit Token
in its own inventory line ("that's the key to leaving") with zero lore.
But its armor pickups silently failed: shard DB showed the SAME 12 items
all run, and the "leather cap (already worn)" belief was the leftover
plain Cap (wcid 118) from v6.2 name-colliding. ROOT CAUSE: ACE's
`HandleActionUseItem` → `TryUseItem` does nothing for plain ground
clothing (Clothing has NO `ActOnUse` override) — retail pickup is
`PutItemInContainer` (0x0019), which the wasm already exposes as
`sessionHandle.putItemInContainer` but rynth never surfaced. Shipped:
`webhost.TakeObject` + `take_item` action (walk-up + PutItemInContainer
into the player pack), `use_object` desc now points [item] pickups at it
(tests: world suite 51 green, adjacent suites re-run green). Restarted as
v6.3.1 (`bot start (v6.3.1 take-item no-lore`) — the persisted scratchpad
carried goals/guids/BLOCKED-notes across the restart on its first live
outing.

## 2.2 Verb-surface audit (2026-07-18, read-verified)

Four-layer diff (LLM actions → webhost → wasm SessionHandle → protocol).
32 LLM action types exist; ~14 are world-acting verbs. Gaps, in the order
the academy→Holtburg run will hit them:

1. **Appraise/identify was silently DEAD** — `webhost.js` RequestId
   candidates (`assessEntity`/`identifyObject`/`requestId`) never existed
   in the wasm; the real method is `requestAppraisal` (d.ts). FIXED this
   session (candidate prepended); loot_loop's appraisal gate un-degrades
   next restart. No LLM appraise verb yet, either.
2. **No key/lock verb**: `useWithTarget(item, target)` (UseWithTarget
   0x0035 — keys, lockpicks, tinkering tools) exists in wasm, unwrapped.
3. **No LLM container-loot verb**: primitives all exist (UseObject +
   GetContainerContents + moveItem; kernel loot_loop uses them) but the
   LLM cannot open a chest/corpse and take a specific item; take_item
   only resolves NearbyGuids, not container contents.
4. **No drop verb**: `DropItem` fully wrapped in webhost, zero callers.
5. **No stack split/merge** (`splitStackToContainer`/`mergeStacks`, wasm,
   unwrapped) and **no confirmation-response verb**
   (`sendConfirmationResponse`/`pendingConfirmations`, wasm, unwrapped) —
   the latter blocks any server confirm dialog.
6. Wasm-absent protocol verbs (rough): `GetAndWieldItem` 0x001A,
   `QueryItemMana`, `BookPageData` page-fetch, `MoveToState` (sit),
   marketplace/mansion recalls. ~63 retail GameActions are commented out
   at the protocol layer entirely (chess, barber, AFK…), none
   playtester-relevant.

Also live-observed: Samuel's Refuse(29335) Tell ("…confused me with
Jonathan…") did NOT surface in the bot's heard section after its
give-to-Samuel guess — yet Tells demonstrably work (v6.2 heard Jonathan's
token Tell; wasm GameEvent::Tell → kind 2 cat TELL ∈ keep-set). Suspect
range/timing on the fire-and-forget give. WATCH, not fixed.

## 2.3 v6.3.1 → v6.3.2 (id-first route endpoint cells)

v6.3.1 looked "deaf" — three NPC uses, zero dialogue — but the journal
walk tags told the real story: **route-failed(0/N) on nearly every leg
computed from the NE rooms** (Jonathan 0/10, Training Master 0/22),
so every Use fired from out of range and no NPC emote ever triggered.
Hearing itself is FINE (Society Greeter's routed(16) walk → its "talk to
the Agent, double-click doors" speech was quoted in the next plan; the
Samuel give-refusal Tell miss earlier fits the same out-of-range shape).
ROOT CAUSE: `indoorLegsTo`'s position-derived endpoint cells — the
workaround for the (now-fixed) pose-cell freeze. `nearestCell`'s
nearest-cell-CENTRE heuristic picks the wrong room near shared walls, so
`from` could resolve to a non-adjacent (or =to) cell and leg 0 aimed
through a wall. FIXED: snapshot ids are PRIMARY again (pose cell is live
post-wasm-fix; NPC entity cells were always server truth), nearestCell
demoted to fallback; regression test "pose cell beats nearest-centre"
(world suite 52 green). Restarted as v6.3.2 (`bot start (v6.3.2
cellfix`); monitor now streams walk tags. Lesson for the file: after
fixing a root cause, hunt down the WORKAROUNDS built on the broken
behavior — they invert into bugs.

## 3. Next-session candidates

1. Watch v6.3: does in-world-only cognition find the exit (token give or
   the 0x0169 portal)? The academy is now fully fair: items labeled,
   inventory visible, doors explained.
2. Verify the AutonomousPosition heartbeat cell (agent caveat, §1.1) and
   add the legacy-slice parity guard (system.rs:5702 path) for the
   pose-cell re-derive.
3. Doors that stand CLOSED mid-route can still block `router.follow()`
   legs (handoff-5 §3.3) — an open-door leg action if v6.3 shows it.
4. Event-driven early check-ins (carried).
5. If the no-lore run stalls hopelessly: consider a "hints" tier (world-DB
   grounded overlay only, no wiki) before re-enabling full lookup.
