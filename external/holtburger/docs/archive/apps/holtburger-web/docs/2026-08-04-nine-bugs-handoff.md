# 2026-08-04 — Nine-bug session handoff (R9 290/cloudflared live-tested; 1070 pass owed)

One day, one user live-testing on an R9 290 over cloudflared, five Opus agents + orchestrator.
Everything below is **committed and default-ON unless marked otherwise**. Tomorrow's task: the
proper 1070 pass (§4). Tester note: the R9 290 arm was explicitly "hard to truly test" — treat
today's PASS/partial verdicts as provisional until the 1070 confirms them.

## 1. Scoreboard — the nine reported bugs

| # | Bug | Status | Mechanism |
|---|---|---|---|
| 1 | Camera clips doors / interior stab objects (dressing screen, forge) | **FIXED, user-verified** | New wasm camera sweeps vs EnvCell stab statics + solid entities (`camIndoorObjects`, default-ON); retail `SmartBox::update_viewer` transit, viewer sphere 0.3, creature exemption (acclient.c:316195) |
| 2 | Portals not appearing | **five real bugs fixed; final confirm owed** | (a) CallPES self-loop died at depth 3 (`callPesLoop`); (b) ACE dropped retail's `Particle::Init` fallthroughs → types 3/4/9/10/11 had zero velocity, frozen in spawn disc (`particleInitAce`; 481/2051 emitters affected); (c) slow-lane fetches; (d) interior layer compositing; (e) stale SW bundles during testing. RP6 culling was suspected and **exonerated** by headless repro. If still invisible while LOOKING at one: `await window.__diag.portalEmitterState()` → `summary.falseCullSuspects` |
| 3 | Player pushes doors/NPCs/corpses | **FIXED, user-verified** | Anchor-bound rejection (`immovableEntities`); retail: mover stops, target never moves (`handle_all_collisions` writes only `this`) |
| 3b | (follow-on) Doors didn't block at all off-center; stuck-in-door lock; click→auto-walk | **FIXED** | COL-03 entity BSP arm was structurally dead (`gfx_id` never written + key mismatch — every entity collided as a 0.4 m circle at its origin). Repaired (keyed by setup DID, `obj_scale` per ACE `GetPhysicsRadius`, 0.48 fallback). Stuck-lock: `USE_PENETRATION_ESCAPE` — embedded movers may always move outward, never deeper. Click→walk was a stale server-echo latch downstream of the lock; expected dead with it. `[col03] … entity BSP arm live` console line = proof |
| 3c | NPC walk-through | **fix landed; confirm owed** | radius×scale + gather proven live via doors; if it persists: `?fu3Diag=on` one-line/second (`colliders=N nearest_d=…`) — wire-vs-render pose divergence is the ranked hypothesis; `?playerDepenetrate=on` is a render-side backstop (default-OFF) |
| 4 | Vendor closes too far (24 m) | **FIXED, user-verified** | Real value: UseRadius 3.0 (94% of 1179 vendors) + 0.96 cylinder allowance ≈ 4 m. Old citation was fabricated; close is 100% client-side (`gmVendorUI::OpenVendor` acclient.c:246660) |
| 5 | Interior cells load minutes late | **FIXED, user-verified** | EnvCell bake was the only per-LB baker without the urgent-lane hint (`envcellUrgent`, default-ON) |
| 6 | Sky disappears inside buildings | **FIXED, user-verified** | Sky gates on `indoor && !isCurrentCellSeenOutside()` (`skySeenOutside`, default-ON); retail rule acclient.c:146721/146746; dungeons keep blackout |
| 7 | Swamp-gas particle hitches (Sawato) | **OPEN — needs 1070 profiling** | 24 longtasks/15 s measured headless; suspects: un-instanced static emitters (`?particleInstancing=on` A/B exists, `window.__setParticleInstancing`); `scripts/multi-agent/_swamp-measure.mjs` is the ready probe. NOTE: the `particleInitAce` velocity fix changed swamp emitters too — re-observe before profiling |
| 8 | Spell FX / armor delay | **armor FIXED (user: "near instant"); spell FX: one paste owed** | Armor: urgent hint was on the wrong branch (hot-swap is the live path). Spell FX: batching fixed (2+N)×RTT→3×RTT; prewarm un-broken (was 1 script/0.4 s); ACE **does** send 0xF755 for vendor buffs (Blackmoor's = targetEffect 55); remaining suspects are miss-branches not latency → `&castLat=on`, buy the spell, paste `[castlat]`. Protocol fact: ACE sends enchantment updates ONLY to the affected session — other-creature debuff badges are impossible on vanilla ACE |
| 9 | Terrain draws over building interiors (Yaraq etc.) | **inside: FIXED user-verified; outside: restored, confirm owed** | Camera-inside: `indoorDepthSplit` (7 rounds; retail PView split: world → Z-wipe → portal-plane depth SEAL → narrowed cells pass). Camera-outside: `portalPunch` rebuilt with retail clip gates; r5 sidedness gate caused a regression (AABB-centre sign unreliable) → parked behind `?punchSidedness=on` with confidence guard + truth-table tests; r4 gate set restored |

## 2. Flag state after this commit

Default-ON (all with `=off` escapes): `callPesLoop` · `skySeenOutside` · `immovableEntities` ·
`camIndoorObjects` · `envcellUrgent` · `appearanceUrgent` · `castVfxUrgent` · `castVfxBatch` ·
`particleInitAce`(reader `?particleInitAce=on` REVERTS to legacy) · `indoorParticleLayer` ·
`indoorDepthSplit` (`=retail`/`=strict` arm-gate variants) · `portalPunch`.
Opt-in (deliberate): `punchSidedness` (guarded retry of the r5 sidedness gate) ·
`playerDepenetrate` (render backstop) · `castPlaceholder=off` (kills the synthetic burst; scoped so
no-table projectile cues survive) · diagnostics: `castLat`, `fu3Diag`.
Test-only: `statAtlas=off&buildingBatch=off` — required ONLY to demo sunken-interior shell
hoisting; costs the ~5,400-singleton draw wall. Do not daily-drive.

## 3. Console diagnostics (all self-reporting; `undefined` now only ever means stale bundle or flag off)

```js
// boot banners — absence = stale SW bundle, add ?nosw=1 (Ctrl+Shift+R does NOT clear it)
[indoorDepthSplit] build=2026-08-04-r5 …
[portalPunch] build=2026-08-04-r5 enabled=true sidedness=false
[col03] N SetupModel physics geometries resident … — entity BSP arm live

window.__indoorDepthSplit        // {build, mode, armed, reason, relayerDiag:{hoisted,skipped,already,force}}
window.__portalPunch             // {build, enabled, sidedness}
liveScene3d._punchDiag           // named reason on EVERY path + gates + dropped:{backface,nearPlane,terrain,straddle,oversize} + rect
liveScene3d._portalSealDiag      // {kept, dropped}
await window.__diag.portalEmitterState()   // per-emitter verdicts + frustum inputs + falseCullSuspects
window.__diag.probeNearestParticle()       // nearest particle scale/opacity/blending/projHalfWidthPx
__creatureSeparationStats()      // {evals, resolved, pushed, immovable, moverResolved}
```

## 4. Tomorrow's 1070 pass (batch, per 1070-eyetests rules)

Bare URL (everything is default-ON now) + `?nosw=1`. Confirm both banners, then:
1. **Portal**: stand outdoors looking at a purple portal ≥60 s — continuous stream of additive
   purple sheets, never fades. If nothing: `portalEmitterState()` paste (falseCullSuspects).
2. **Yaraq sunken shop**: outside → entry level → inside → out. No terrain over interiors from any
   vantage; no doors through walls; fountain visible through doorway from outside AND from inside;
   torches must NOT bleed through doorways.
3. **Doors**: off-center block, slide along leaf, open→pass, get wedged→walk out (no lock),
   click after unsticking must not auto-walk.
4. **NPC/corpse**: walk into them (stopped, no displacement, no interpenetration); Tusker charge
   still stops short (regression check); scaled creatures (Shadow Child 0.5×) standoff ~0.28 m closer.
5. **Cast**: `&castLat=on`, buy Blackmoor's Favor → paste `[castlat]`. A/B `castPlaceholder=off`.
6. **Swamp (bug 7)**: Sawato swamp; `_swamp-measure.mjs` A/B `?particleInstancing=on`; watch hitches.
7. **Perf regression check**: settle time at Yaraq/Holtburg vs pre-session memory; the punch/split
   passes are supposed to be near-free after the perf round (persistent VBO, LOS cache ~1/33 calls).
8. **Optional arms**: `&punchSidedness=on` (far-side doors through terrain-LOS edge cases);
   `&indoorDepthSplit=strict` (r4 below-terrain arm gate); `&statAtlas=off&buildingBatch=off`
   (sunken-shell hoist demo).

## 5. Known gaps / next work (ranked)

1. **Sunken-interior shell hoist under default batching** — cross-LB atlas buckets carry no
   per-LB identity; agreed ship vehicle is a **scissor/stencil-bounded depth clear** (retail
   `PView::GetClip` bounds by screen region, batching-agnostic, subsumes punch; `portal_clip.js`
   gates already produce the screen rects). Factor as a shared helper for BOTH render paths
   (composer + direct fallback — the direct path also still lacks the r6 seal).
2. **Spell-FX final mile** — pending the `[castlat]` paste; expected `miss reason=…` (metadata),
   not latency.
3. **NPC pass-through confirm** — `fu3Diag` paste if it survives; then wire-vs-render pose gap
   (clamp against interpolated pose) is the designed fix.
4. **Bug 7 swamp profiling** on the 1070.
5. **Rust perf follow-up**: `get_visible_portal_apertures_with_cell_center` does a linear
   `aabb_for` scan per portal per frame (lib.rs ~34820) — wants a per-snapshot HashMap.
6. **Autonomous movement lane** (server MoveTo/click-to-move) has NO entity clamp at all —
   separate real gap, flagged by the collision agent.
7. **Retail C++ sources backlog** (from `/mnt/wbterminal2/retail-cpp-drop-20260804/`:
   CEnvCell/CBuildingObj/CCellStruct/CellManager/CELLARRAY/CELLINFO/CellListType): export
   `portal_side` (replaces the LOS stand-in — likely the gate before `punchSidedness` ships);
   back-to-front cells pass; per-view draw + `DrawnThisFrame` dedup; `CellManager::ChangePosition`
   as the residency state machine (5 s `CheckPrefetchStatus`); sealed-interior ambient = hard 0.2
   white (not sky-derived); `calc_cross_cells_static` for doorway props; `CCellStruct` Pack/UnPack
   as DAT-parity oracle; audit `current_cell` ladder vs `find_visible_child_cell`;
   `do_not_load_cells` speculative-transit guard.

## 6. Engineering notes (hard-won today)

- **wasm-bindgen copies `///` docs into the JS glue**: a `/* */` inside a doc comment on an
  exported item breaks the ENTIRE bundle parse. Took the client down once; fixed.
- **`node --check` validates syntax, not references** — two silently no-op'd anchored edits left
  undeclared constants that would have thrown at module load. On a shared live tree: assert every
  anchored edit, grep declarations after.
- **The SW cache eats test rounds**: `holtburger-content-v2` survives Ctrl+Shift+R; only `?nosw=1`
  clears. Boot banners now make staleness self-diagnosing.
- **ACE ported retail switch fallthroughs as `break`s** (`Particle::Init`) — check every ACE port
  of a retail `switch` for this class of bug.
- **`Entity.gfx_id` was a trap** (never assigned at runtime) — the 2026-07-28 audit note existed;
  two readers were missed. Greps for "TRAP" comments pay off.
- **Retail discards birth overshoot** (`last_emit_time = curr_time`, acclient.c:330607) — particle
  density legitimately degrades at low fps (linear; zero only at 0.5 fps). A catch-up loop would be
  a deviation from retail; if low-fps density parity is ever wanted, label it non-retail.
- Pre-existing red tests (NOT from this session, verified at HEAD): `test_ws03_cast_overlay_guard`
  (stale source-regex), `test_play_effect_resolver`, `test_sky_birds` (source-text asserts vs
  in-flight files), `test_envcell_guard` (harness stub list lacks `nodeInLandblock` from the new
  `portal_clip.js`). Also 2 pre-existing PRESENCE-GUARD lint findings (`fogRingCap`,
  `stableDepthShare`) — one-line unwraps, but they change bare-URL defaults; decide deliberately.

## 7. Build/test state at commit

wasm `pkg/` = release build with ALL session Rust (camera sweeps, collision repairs incl.
penetration escape + fu3Diag, urgent lanes, aperture cell-center export). Native:
`cargo test -p holtburger-world -p holtburger-core --release` → **674 + 623, 0 failed**.
JS: `test_particles` 87/87, `portal_clip` 44/44, `indoor_nav_no_pose` 17/17, `buffs_hud` 34/34,
ws09 7/7, blocking-particle 48/48 + 12 more particle/statics/cells suites green.
`audit-flag-defaults --mismatch` 0 · `lint-url-flags --strict` 0 undocumented (593 rows).

## 8. Final orchestrator message to the tester (verbatim, pre-default-flip — flags named there are now defaults)

> Everything's landed and the final smoke is clean: zero errors, both boot banners print, and the
> diags now name their states instead of going `undefined`. Ready for you, one reload:
> **Same URL as before** (`...&indoorDepthSplit=on&portalPunch=on` — batching flags optional: add
> `&statAtlas=off&buildingBatch=off` only if you want the sunken-interior hoist demo, at a perf cost).
> **On load, confirm both banners:** `[indoorDepthSplit] build=2026-08-04-r5` and
> `[portalPunch] build=2026-08-04-r5 enabled=true`.
> **Then just two looks:**
> 1. **Outdoors at a sunken interior** — the punch is restored to your known-good round-4 gate set
> (my r5 sidedness gate was the regression: its "which way is outward" sign was garbage for
> doorways in long walls, so it culled exactly the doorways you looked at; it's parked behind
> `&punchSidedness=on` with a confidence guard and truth-table tests). If terrain still covers
> interiors from outside: `liveScene3d._punchDiag` — the `reason` and `dropped` breakdown now name
> the gate.
> 2. **At a portal, looking straight at it** — velocities, birth, layers, and compositing are all
> proven good now; RP6 was exonerated by a rigorous repro (my earlier "conviction" was wrong — the
> culled emitters were legitimately outside your third-person view cone). If a portal you're
> *looking directly at* still shows nothing: `await window.__diag.portalEmitterState()` —
> `summary.falseCullSuspects > 0` is a genuine bug with the rejecting plane named; `0` sends us to
> the next layer with data instead of guesses.
> Also still armed whenever you care to: `&castLat=on` for the spell-FX stage trace, `&fu3Diag=on`
> if NPCs still let you through. Today's tally: seven of your nine originals fixed and confirmed,
> the eighth (terrain) fixed from inside with the outdoor half restored pending your look, and the
> ninth (portals) stripped of five real bugs (dead loop, frozen velocities, wrong lanes, layer
> compositing, stale bundles) with a decisive instrument waiting if anything remains.
