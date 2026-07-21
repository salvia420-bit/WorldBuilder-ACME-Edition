# DESIGN — The Surveyor: deterministic coverage / frontier / loop core (2026-07-21)

> The agent knows where it is at all times. It knows this because it knows where
> it has been — by subtracting where it is from where it hasn't been (or where it
> hasn't been from where it was, whichever revisit is greater), it obtains a
> **deviation**, or a **redundancy**. The planner uses deviations to drive the
> agent from a tile where it is toward a tile where it hasn't been; arriving at a
> tile where it wasn't, it now is. Consequently the tile where it is is now the
> tile it wasn't, and the tile where it was is a tile it must not re-enter. If the
> tile it is in is a tile it already was, the system has detected a **variation** —
> the difference between where it is and where it has already been. If the
> variation exceeds a threshold, the **loop is real**, and it too is corrected by
> the planner.

This is a spec, not poetry. Every clause maps to a concrete requirement below.

## Problem (live evidence, 2026-07-21 stream, phi-4 explorer)

The bot is wedged in the Renald shop in Holtburg (landblock `0xA9B4`), and:
- The director LLM repeatedly "looks up Qalaba'r" — a town at (ns −74.6, ew 19.6),
  the opposite corner of the map from Holtburg (ns 42.1, ew 33.6). It fixates on a
  place it cannot see and will never walk to. (`towns.js`)
- It re-poked the same NPCs (Scribe Renald the Younger, Shopkeeper Renald the
  Elder) and the same chest across many check-ins.
- `ExplorePressureController` exhausted the building's cell-graph and emitted
  `[pressure] idle — indoor sweep to 0xa9b40144 (revisit)` on repeat: once every
  neighbor cell is marked visited, it revisits forever (`bot.js:861`), never
  escalating out of the landblock.
- The persistent scratchpad was empty (`_scratchpad: null`) — the model's fragile
  note-memory is the only "where have I been" signal, and it failed.

**Root cause:** four independent, incomplete visit-trackers, none of which own a
frontier or force an escape:
| system | file | tracks | gap |
|---|---|---|---|
| `loopWarning` | extensions.js:307 | repeated *actions* w/ no move | action-fingerprint, not spatial |
| `coverageLines` | extensions.js:385 | `_visitedCells` count | passive count; no frontier, no "go here" |
| `stallLine` | extensions.js:409 | landblock unchanged N min | detects; does not steer |
| `ExplorePressureController` | bot.js:682 | per-lb cell sweep | revisits forever; never leaves lb |

The LLM is asked to *remember* where it has been (via note/scratchpad) and *decide*
where to go. It is bad at both. The harness must own both, deterministically, and
the LLM's job shrinks to narration + coarse goal selection under harness direction.

## The re-engineering — one coverage core, four consumers

### WS-A — `rynth/ai/explore_memory.js` (NEW): the coverage/frontier/loop core

A single source of truth, pure JS (no wasm, fully unit-testable), fed the pose on
every tick and every check-in. Replaces the four scattered `_visitedCells`.

**Tile model.** Quantize world position to a fixed grid so indoor and outdoor
coverage share one space. Resolution ≈ one indoor cell (~10 m) — call it
`TILE_M = 12`. Tile key = `(floor(worldX/TILE_M), floor(worldY/TILE_M))`, plus a
coarse `z-band` (floor(z / 6)) so a stacked upper floor is a *different* tile than
the ground floor beneath it (verticality is scored — see EXPLORER prompt).

**State per tile:** `{ visits, firstT, lastT, cell, lb }`.

**Public API (frozen shape — implementers must not change signatures):**
```js
export class ExploreMemory {
  observe(pose)            // record current tile; bumps visits; updates was/is
  get current()            // {tileKey, worldX, worldY, z, cell, lb, visits}
  get previous()           // the tile it was on before the current one (the "was")
  get here() / get was()   // aliases, for readability at call sites
  variation()              // revisit count of the CURRENT tile (the "redundancy")
  frontier(opts)           // nearest UNVISITED tile → {worldX, worldY, dist, bearingDeg, lb} | null
  loopVerdict()            // {looping:bool, severity:0..3, reason, correction} — see thresholds
  coverage()               // {tiles, landblocks, thisLbTiles, sinceLbChangeMs}
  townFrontier(towns, pose)// nearest town with 0 visited tiles → {name, ns, ew, dist} (escalation target)
}
```

**Deviation vs variation (the directive, precisely):**
- **deviation** = `frontier()` — the vector from `here` to the nearest tile it
  hasn't been. This is what *drives* the planner.
- **variation / redundancy** = `variation()` — how many times it has already been
  on `here`. High variation on `here`, especially when `here === was` back-and-forth,
  is the loop signal.
- **loopVerdict thresholds** (tunable consts): severity 1 at `variation ≥ 3`;
  severity 2 at `variation ≥ 5` OR a 2-tile A↔B oscillation detected over the last
  6 observations; severity 3 at `variation ≥ 8` OR `sinceLbChangeMs > STALL_MIN`
  with frontier still local. Each severity carries a `correction` string the
  planner block and ExplorePressure both consume.

### WS-B — `extensions.js` observe(): the LOCATION block (planner grounding)

Collapse `loopWarning` + `coverageLines` + `stallLine` into ONE authoritative,
deterministic block sourced from `ExploreMemory`, injected first (highest
authority) in the observe assembly (extensions.js:490-512). Shape:
```
LOCATION (harness ground truth — trust this over your own memory):
  Here: Holtburg, indoor cell 0xA9B40129 (tile 41,-3, floor 0). Been here 7×.
  Was: cell 0xA9B40144 (you keep bouncing between these two — THIS IS A LOOP).
  Covered: 41 tiles / 3 landblocks this session; 9 tiles in this landblock.
  Frontier: nearest UNVISITED ground is ~34 m NE (landblock 0xA9B5).
  CORRECTION: you are looping in one building. Leave it and head NE toward the
  frontier. Do NOT re-enter a visited tile or re-poke an NPC you have tried.
```
- `Frontier` line is always present when a frontier exists — it is the *deviation*,
  and it makes "go somewhere new" checkable rather than vibes.
- `CORRECTION` appears only at `loopVerdict().looping`, with escalating firmness by
  severity. This is the planner-side correction.
- Keep the existing `tried:` object list (it is good and orthogonal), folded under
  "already tried here".
- Preserve the `{text,data}` observation shape and the mission/scratchpad/heard/
  deltas lines (do not regress those).

### WS-C — `bot.js` ExplorePressureController: frontier-directed escalation

Delete the controller's private `_visitedCells`/`_visitedDoors`; consume the shared
`ExploreMemory`. New step priority when idle:
1. Re-issue last unreached director goto (unchanged, bot.js:818).
2. **Local frontier hop:** step toward the nearest unvisited cell/tile from
   `ExploreMemory.frontier()` — indoor via cell graph, outdoor via bearing.
3. **Escalation when local frontier exhausted** (all reachable neighbors visited AND
   `variation ≥ 5`): walk to the nearest building exit / unvisited door leading OUT
   of the current landblock (reuse `exit_building` / door-toward-frontier), not a
   revisit.
4. **Landblock hop** when the whole landblock is saturated: MoveTo toward the
   frontier tile in the adjacent unvisited landblock.
5. **Hard-loop last resort** (severity 3, wedged > STALL_MIN, no reachable
   frontier): `@telepoi <nearest unvisited town>` via `ExploreMemory.townFrontier`
   + `sendChat`. This is the operator un-stick made autonomous. Rate-limited (≤1 per
   N minutes) and journal-logged loudly so the stream shows the correction.

Escalation must obey all existing survival invariants (degrade to no-op on error;
never touch router/director state it doesn't own; respect operator-stop).

### WS-D — `director.js` prompt + personality rewrite

**EXPLORER_SYSTEM_PROMPT** changes:
- Add a "LOCATION IS GROUND TRUTH" section: the LOCATION block is authoritative;
  obey its Frontier and CORRECTION directives; you do NOT need to remember where
  you have been — the harness knows.
- Kill the far-town hallucination: "Never name, plan toward, or look up a place you
  cannot see in the observation or reach on foot from here. You are in ONE town;
  finish it before naming another. If you catch yourself fixating on a distant
  place, that is a hallucination — return to the Frontier line." (Directly targets
  the Qalaba'r loop.)
- Recast MEMORY around the deterministic coverage, demote the note to "color +
  findings," not the primary map.
- On a CORRECTION line, the reply MUST be a movement action toward the frontier,
  never another NPC/knowledge poke.

**Personality (the Surveyor).** Rewrite the persona/analysis voice to match the
ethos: a self-aware, deadpan surveyor narrating its own position and coverage —
"I know where I am because I know where I've been." Analysis lines (shown live on
the stream overlay) describe the room AND the coverage state in that voice. Keep it
brief; it is a teleprompter, not a novel.

### WS-E — tests (node `rynth` suite, currently 37/0/2)

- `explore_memory` unit tests: tile quantization, visits, deviation (frontier
  direction/dist), variation, A↔B oscillation → loopVerdict severity ladder,
  townFrontier selection, z-band verticality.
- observe() LOCATION-block tests: block present, Frontier line format, CORRECTION
  gated on loopVerdict, shape/`{text,data}` preserved, old lines not regressed.
- ExplorePressure escalation tests: frontier hop vs revisit, exit-on-exhaustion,
  landblock hop, telepoi last-resort rate-limit, no-op-on-error invariant.
- Keep `cargo holtburger-world` untouched (this is JS-only).

## Non-goals / guardrails
- Do NOT touch the oracle (`route_validate.rs`) or wasm — JS harness only.
- Do NOT start a second soak; the live stream bot IS the soak. Relaunch ONCE, after
  the suite is green and a headless smoke test passes.
- Preserve every survival invariant and the frozen director interface
  (`{observe,validate,execute,systemPrompt}`).
- All long chromium launches keep the anti-backgrounding flags (HANDOFF §3).

## Orchestration plan
1. Validation research agent (Sonnet) → confirm exact APIs (observe.js town
   resolver, indoor_router graph API, host pose accessors, global_router, @telepoi
   issue path, node test layout) and flag any wrong assumption above.
2. Implementers (Sonnet, no subagents), coordinated by orchestrator:
   - I: WS-A core + WS-E core tests (self-contained; lands first).
   - II: WS-B observe block + tests (depends on I's API).
   - III: WS-C ExplorePressure escalation + tests (depends on I's API).
   - IV: WS-D prompt/personality (independent; can land parallel).
3. Orchestrator integrates, runs `node rynth`, headless smoke, single stream
   relaunch.

---

## VALIDATION COROLLARY (2026-07-21, post-research — these OVERRIDE the body above)

Confirmed live-verified baseline: from `apps/holtburger-web/`,
`node rynth_test_all_node.cjs` → **37 passed / 0 failed / 2 skipped**. All new
tests must keep this green.

**Pose & world frame (WS-A).** Canonical pose is the RAW `{objCellId,x,y,z}`
(landblock-local metres, Z-up) — `ExploreMemory.observe()` takes THAT, not
extensions.js's renamed `{cell,...}`. Duplicate these inline per house convention
(do NOT import): `worldX(id,x)=((id>>>24)&0xff)*192+x`, `worldY(id,y)=((id>>>16)&0xff)*192+y`.
Landblock = `id>>>16`. Indoor EnvCell iff `(id&0xffff) >= 0x0100 && <= 0xfffd`.

**ns/ew converter (WS-A townFrontier).** There is NO exported town resolver — the
logic is inlined at `observe.js:234-249` over a private `locDegrees` at
`observe.js:30-34`. `ExploreMemory` carries its OWN copy:
`locDegrees(id,x,y){ const wx=((id>>>24)&0xff)*192+x, wy=((id>>>16)&0xff)*192+y; return { ns:(wy/24-1019.5)/10, ew:(wx/24-1019.5)/10 }; }`
Nearest town = min Euclidean over `TOWNS` `{ns,ew}`.

**frontier() output must be converted before movement (WS-B/WS-C).** `frontier()`
returns world coords `{worldX,worldY,...}`; `bot.goto`/`host.MoveToPosition` need
`{lb,x,y,z}` (full/EnvCell objCellId + lb-local x/y) OR `{ns,ew}`. Provide a helper
that converts a world point → `{lb,x,y,z}` (outdoor LandCell index per the
`bot.js:896-904` formula) so callers don't re-derive it.

**Indoor graph API (confirmed).** `indoor_router.js`: `isEnvCellId(id)`;
`buildGraphFromWasm(handle,depth=0,opts={})→Promise<Map<cellId,{pos,neighbors,exits,floorZMin?,floorZMax?}>|null>`
(neighbors are PORTAL-adjacent — walls respected); `nearestCell(graph,wx,wy,z)`;
`toLegs(graph,path)→[{lb,x,y,z}]` where `lb` = full EnvCell objCellId;
**`findExitPath(graph,fromCell,opts)→{path,exitCell,outdoorId}|null`** (:418) — use
this for WS-C escalation step 3, not a hand-rolled exit.

**exit_building reuse (WS-C step 3).** No bare `exitBuildingAction()` is callable.
Reach the advisor directly: `this.bot.ai?.extensions?.dungeonNav?.exitRoute(this.bot)`
→ then `this.bot.travel(route.legs)` (NOT `bot.goto`). Same code path `exit_building`
uses, invoked as harness code.

**NO TELEPORT (WS-C — operator constraint 2026-07-21).** This bot must NEVER use
`@telepoi` or any portal/teleport shortcut to escape a loop — teleport-cheating
defeats the whole point (autonomous on-foot navigation) and reads as cheating on the
stream. WS-C step 5 is therefore NAVIGATIONAL, not a teleport: the hard-loop last
resort is a directed long on-foot walk toward the nearest unvisited-town BEARING.
`townFrontier(towns,pose)` is kept ONLY to supply that bearing (direction from the
current ns/ew to the nearest unvisited town's ns/ew); the controller then issues a
frontier-directed `MoveToPosition` hop that way. If truly wedged against geometry,
re-issue the frontier-directed MoveTo and let the existing hop-cap stand-down, the
±45° stall-recovery, and the next director check-in resolve it. No
`InvokeChatParser("@telepoi …")`, no alias table, nowhere in the harness.

**Shared-instance wiring (WS-A/WS-B/WS-C).** Create the single `ExploreMemory` inside
`composeAiExtensions()` (extensions.js:269-ish) and RETURN it as `exploreMemory` in
the composition result (alongside `knowledge`/`dungeonNav`/`state`, ~:710-722) so it
lands at `bot.ai.extensions.exploreMemory`. extensions.js `observe()` closes over it
directly. `ExplorePressureController` reaches it via the SAME lazy/defensive pattern
it uses for `this.bot.ai?.director`: `this.bot.ai?.extensions?.exploreMemory`, with a
graceful fallback to today's revisit-neighbor behavior when extensions are off/broken.

**Dual-driver double-count (WS-A).** `.observe(pose)` is called from TWO cadences
(director check-in AND ~5-15s pressure tick) on the same instance. It MUST de-dupe:
skip a call whose tile+quantized-pose equals the previous `.observe()` within a small
window, so `variation()` reflects REAL revisits, not double-polling. State this as an
internal invariant with a test.

**Personality injection (WS-D).** Do NOT use `cfg.ai.persona = {…}` — it collides
with the string `botPersona=explorer` selector and is silently dropped
(`renderPersonaPreamble` returns "" for non-objects). Bake the Surveyor voice
directly into the `EXPLORER_SYSTEM_PROMPT` text constant (director.js:91-162).

**Test harness (WS-E).** Files live at `apps/holtburger-web/rynth_*_test.cjs` (ONE
level ABOVE `rynth/`). Run from `apps/holtburger-web/`: whole suite
`node rynth_test_all_node.cjs`; single file `node rynth_<name>_test.cjs`. Templates:
`rynth_explore_pressure_test.cjs`, `rynth_ai_observe_test.cjs` (CommonJS, dynamic
`import()` via `pathToFileURL`, local `check()` counter, injected `opts.now` clock,
mock host/router/bot, `process.exitCode`).
