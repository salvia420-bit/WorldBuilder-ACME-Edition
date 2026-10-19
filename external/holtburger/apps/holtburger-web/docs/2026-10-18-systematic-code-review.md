# Systematic code review of holtburger-web — 2026-10-18

The owner asked for a systematic code review of holtburger-web. This one covers every production file once, at HEAD `7ae7667a` (clean tree). The earlier rounds (2026-08-03 rounds 1-10, 2026-10-07) were random spots or diff-driven. Here the ~508,000 production lines were split into 14 areas, and every file was assigned to exactly one area. One reviewer per area used the same hazard checklist. A second agent then tried to refute each finding without seeing the first agent's reasoning. Finally the orchestrator re-traced every high-severity finding and the XSS finding, and ran checks across all areas that no single reviewer could see.

**Fix pass (later the same day):** every finding in §5 has a fix and a test, committed in `b20cdc37`. Status, verification and what was still open are in §10. **Follow-up pass (the same evening):** the §10.5 list and the tractable §7 items, in §11. **Default-on flips (2026-10-19):** the flags held off only for a pending eye test, in §12. The rest of this document describes the code at review time.

**The review itself changed nothing in the code.** This document was its only new file. Nothing ran in a live client, on the 1070 or in a browser. No builds and no JS gate were run, per the laptop rules. The evidence is source reading, `git` history, the vendored three.js 0.184.0 and pmndrs sources, the retail decomp where parity mattered, and a few reviewer scratch scripts (fake-GL repros, a shot fuzzer, a module evaluation-order walker). Each scratch script is noted where it was used.

**Result.** 63 findings: **51 confirmed** (5 high, 18 medium, 28 low), **10 plausible** (logic traced, trigger not provable statically), **2 refuted**. On top of these, the verifiers noted 14 related defects, and the orchestrator's sweeps add the classes in §2 and §3. Each related defect is listed with the finding it belongs to. Nothing reached "critical". The five highs are all on the default path.

## 1. What to fix first

1. **Plugins that subscribe at mount time never hear anything** (PLUGINS-A-1, PLUGINS-A-2, PLUGINSB-1; also PLUGINSB-3, PLUGINSB-4). `app/plugin_bar.js:646` mounts the bar at page load with `client: null`. `window.__pluginClient` only exists after login (`index.html:4714`). Any plugin that takes `ctx?.client ?? window.__pluginClient` in `mount()` and has no `__pluginClientReady` fallback is deaf for the whole session. On a bare URL this means:
   - **Hotbar:** no shared-cooldown sweep is drawn, and a binding is never pruned when its stack runs out (`hotbar.js:1850-1852`).
   - **Barber:** the barber page never opens after a StartBarber (`barber-panel.js:428`). It is the only listener. ACE then consumes the note and leaves BarberActive set.
   - **Salvage:** results never appear (`salvage-panel.js:603`). There is no retail "You obtain …" line in chat and the Results list stays empty.

   Three agents found this independently, and the orchestrator re-traced it. The tests for these plugins (`tests/hotbar_*.test.mjs`, `tests/barber_panel.test.mjs`, `tests/commerce_windows_smoke.test.mjs`) create `window.__pluginClient` before mounting, which is the opposite of the production order, so they cannot catch it. Fix: pass a lazy client getter from the bar, or subscribe in each plugin through `__pluginClientReady`. Then add a guard test that mounts with `{ client: null }` and no global, and resolves the client afterwards.
2. **After a WebGL context restore, new or changed materials stop drawing** (RENDER-1, re-traced). `async_link_guard.js:329` keeps the `renderer.properties` object it saw at install. three's `onContextRestore` → `initGLContext` replaces it (`WebGLRenderer.js:442/490/1103`). From then on the guard reads empty entries from the dead map, so it never sees a program, and its poll never stops it from deferring. The orchestrator found a second effect: any already-stamped material whose `version` moves after the restore (a texture upgrade, `needsUpdate`) also drops out for good. Context loss is documented at about 7 per session on the 1070 at ultra (`docs/2026-08-06-next-gains-speculation.md:132`), and quality.js now sends GTX 10x0/16x0 to ultra. The same restore also breaks `texUnitPin` (RENDER-2: a warning per pinned sampler upload), freezes every occlusion-cull verdict (RENDER-3), and kills the far-fog probe (RENDER-4). The verifier also found that the fog then freezes on its last sample instead of the authored hex, and that `draw_sort_program` keeps a dead `info`. No test exercises a loss/restore against the default-on render patches. The render reviewer's fake-GL repro is a starting point for one. It is not in the repo, and it sits in this session's temporary scratchpad (`/tmp/claude-1000/-home-wbterminal/f6ca1a51-fd22-4ea1-8d0a-1bbd5e022f40/scratchpad/review/render/restore_repro.mjs`), so copy it out if you want it.
3. **FX flashes evicted by the 10-flash cap leak into the light pool** (VFXAUDIO-1, re-traced). `fx_lights.js:288-291` evicts with `_release()`, which neither removes the flash from `scene3d.activeLights` nor queues `_pendingRemoval`. The dead flash keeps `__dynamicPriority`, and `lightSelectionSortKey` (`lighting.js:2502-2506`) sorts it ahead of every static lamp within 48 m. After any burst of 11 or more cue flashes (group combat, a crowd buffing in town), zero-intensity ghosts take the light slots that nearby torches should get, for the rest of the session. One line fixes it: evict through `releaseFxLight`.
4. **Login and character select** (SHELL-1 re-traced, SHELL-2, SHELL-3).
   - **XSS (SHELL-1):** character names go into `loginStatus.innerHTML` unescaped, at `index.html:5184`, the restore branch near `:5150`, and `app/client_events.js:115`. `dataset.name` decodes the attribute escape (the comment at `:4871-4876` says so). The server picker lists public community shards, and the page already escapes ServerName for that reason, so a hostile shard can run script in the client's origin, where the session password sits in sessionStorage.
   - **Hang (SHELL-2):** a CharacterError (for example, "character still in world" after an unclean close) leaves the retail character screen on "Entering game..." with every button disabled and no message.
   - **Logout (SHELL-3):** `/logout` rebuilds the URL without the server and bridge picked in the form, so the auto-login sends the shard account and password to `127.0.0.1:9000`.
5. **A failed HD texture fetch is cached as "absent" for the session** (STREAM-TERRAIN-2). `bc7_blocks` (`src/lib.rs:12420`) discards the prefetch error and returns the same empty Vec it uses for "not in the bake". `bc7_textures.js:1826` then caches `null` with no eviction. One Wi-Fi drop or 5xx while HD records stream leaves those surfaces at retail resolution until reload.
6. **Static emitter radius builds duplicate emitters** (STREAM-STATICS-1). A landblock that crosses a ring boundary during the time-sliced attach ends up `deferred` while some of its anchors still have live emitters. The tick then never tears them down, and on return it rebuilds every anchor, so those effects and their CallPES loops are doubled.
7. **Particles are hazed as if they were as far away as the terrain behind them** at high and ultra (SKY-1). The layered haze pass runs after the late particle pass, and particles do not write depth. A portal swirl or a campfire 30 m away against hills 3 km behind it washes toward blue-grey.

## 2. Recurring bug classes

These are the patterns behind most of the findings. Each would be worth a lint or a guard test, because each is already present in several files.

| Class | Instances (this review) | Systemic guard |
|---|---|---|
| **Subscribing on the mount-time client** before login | hotbar, barber-panel, salvage-panel (high); tinker-panel (dev-only opener), landblock-messages (opt-in); stance-toggle mount hook (minor, activate() re-subscribes); hover-tooltip.js:250 (no consumers yet). Fine: buffs-hud (polls), combat-bar (module-load installers that poll), combat-hud, status-indicators, vendor-ui, vitae-detail, vitals-hud/orbs (`__pluginClientReady`), examine-target (mounted on open). | Give plugins a lazy client from the bar. Add a loader test that mounts every manifest with `client: null`, then resolves the client and checks each plugin's subscriptions. |
| **WebGL context restore** not handled by default-on patches | RENDER-1 (high), RENDER-2/3/4, draw_sort_program (verifier), shadow_caster_list (reviewer risk) | One restore hook that re-installs or invalidates every patch that captured `renderer.properties`, `capabilities`, `info`, `shadowMap` or GL objects. Plus a fake-GL restore test. |
| **Post-await liveness checked with `entityMap.has(guid)`** instead of identity | ENTITIES-3 (`:12664`), ENTITIES-4 (`:16131`), verifier additions `:19726` (emitter parented to a disposed root) and `:12309`. An orchestrator sweep found **18** post-await `.has()` guards in entities.js (6184, 6228, 8685, 10731, 10973, 11459, 12309, 12664, 14276, 14559, 14643, 15238, 15242, 15282, 16131, 19726, 19825, 19845) against 12 identity-form checks. Per-instance tokens next to them (`_motionToken`, `_castSequenceToken`) do not cover a same-guid respawn. The untraced sites are candidates, not confirmed bugs. | Use `_isLiveInstance(inst)` everywhere, plus a lint for `entityMap.has(` after `await`. |
| **A transient failure cached as permanent**, or no retry | STREAM-TERRAIN-2 (HD textures), PLUGINSB-5 (WorldObjectManager queues forever after one failed load), RUSTCORE-1 (a failing record re-walked with 1 s backoff per placement) | Distinguish failure from absence at the wasm boundary (an error or tri-state), never cache a failure without a TTL. Same rule as fix #8 of 2026-10-07. |
| **Work that continues after evict/park/teardown** without a residency or generation re-check | STREAM-TERRAIN-1 (LOD re-bake of a parked landblock), STREAM-TERRAIN-3 (interior collision products land after eviction) plus the verifier's unguarded `finally` at `landblock_stream.js:464`, STREAM-STATICS-1/2 (radius teardown vs time-sliced attach and pending timers) | Check the generation after every await in bake/attach code, as the 2026-08-03 review established for envcells. |
| **Per-guid maps that never shrink** | SHELL-4 (`__diag.remoteSync`, ~8 KB per remote guid, medium), SHELL-5 (`__diag.motion`), RUSTNET-3 (`pending_confirmations`), VFXAUDIO-4 (portal anchors on low preset), SKY-7 (flag-only), rynth loot/unreachable maps (risk) | Prune on despawn (`noteWireRemove` is the natural hook). The always-on diag ledgers need the same caps fix #11 of 2026-10-07 gave the spawn ledger. |
| **Duplicate ES module instances** from `?v=` specifiers | `statics.js` (index.js imports `?v=phase7-par`, while loop.js, cells.js, animated_scenery.js and sky_dome.js use the plain path) and `buildings.js` (`?v=phase-d-batch` vs loop.js). Consequence: STREAM-STATICS-3 (the diag hooks read the wrong instance, so eye tests see zeros). Workarounds already exist for the symptoms (globalThis tally `8b47d32c`, `tickFrame(ts)` dedup, the once-per-frame billboard gate). The esbuild shell bundle merges each pair into one instance (`docs/reengineering/impl/task-T11-report.md` D5), so the dev page and the bundle behave differently. | Drop the two `?v=` suffixes in `scene3d/index.js:49/54`, then remove the workarounds. Add a lint that fails when one module is imported under two specifiers. |
| **Tests that cannot fail for the production order** | the plugin tests above; the hotbar migration that only ever runs before login (`hotbar.js:1067-1099`) | Build the guard tests from the real boot order. |

## 3. Checks across all areas (orchestrator)

These cover things no single area reviewer could see.

- **Duplicate module instances**: an import-specifier sweep of every production JS file. Five modules turn up under two specifiers. Two are real duplicates on the app page: `statics.js` and `buildings.js` (see §2). `pkg/holtburger_web.js` differs only between two diagnostic pages and the app, and `atmosphere_runtime.js` and `scene3d/index.js` were false positives (JSDoc types and comments).
- **URL flags**: `scripts/lint-url-flags.mjs` passes (1,030 documented flags, 610 distinct JS readers, 424 raw findings, all waived or informational). The lint does not sweep `plugins/`, `ui/` or `rynth/`. The `on`/`off` readers there were checked by hand against `docs/url-flags.md`, and all match.
- **JS → wasm boundary**: all 78 distinct `wasmExports.*` members and the session-handle methods JS uses exist in the current `pkg/holtburger_web.d.ts`. Whether `pkg/` matches HEAD's Rust sources could not be checked from mtimes: sources are newer, but the 10-18 batch built in an integration worktree.
- **Plugin event bus**: 53 distinct event names are listened to, and every one has an emitter. `kind:21/23/24` are redundant aliases next to the named events.
- **DOM ids**: no id is assigned in more than one file.
- **wasm cache-bust stamp** (`wasmrev-20261011f`): unchanged since 10-11, although `pkg/` was rebuilt on 10-13, 10-17 and 10-18. That is harmless under `serve.py`, which serves `.js`/`.wasm` as `no-cache`, but it would serve stale wasm behind any cache that honours the URL.
- **Building Setup lights**: on default URLs buildings are flattened into atlas or material batches, so `lighting.js` `recordBuildingTree` finds no placement groups and never attaches building Setup lights. This is latent: building models are almost all raw GfxObjs with no lights (`HANDOFF-portals-2026-10-16.md`).
- **Film mode leaks nothing onto the default path**. Only `scene3d/film/flags.js` is in the boot graph, and it is a pure memoised reader. The runtime loads behind `get("filmMode") === "on"` (`scene3d/index.js:4632`). A fuzz of all 64 shot techniques found no NaN or validation throw.

## 4. Scope, coverage and method

Every production file under `apps/holtburger-web` (excluding tests, harness, tools, docs, data, vendor, legacy, pkg*, dist) was assigned to exactly one area. The workspace crates compiled into the wasm (`crates/holtburger-*`) were reviewed **diff-only** (changes since `b8819698`, 2026-10-07). In the table, "Read in full / in part / swept only" counts the files each reviewer reported. "Swept" means targeted hazard searches (awaits, `innerHTML`, `.free`, `dispose`, unbounded maps, listeners, `unwrap`, flag readers) rather than a read. What each reviewer did not get to is listed per area in §9.

| Area | Files | Lines | Changed since 10-07 | Read in full | Read in part | Swept only | Findings |
|---|---:|---:|---:|---:|---:|---:|---:|
| rust-net | 27 | 18,263 | 5,946 | 13 | 12 | 2 | 3 |
| rust-core | 23 | 71,876 | 12,070 | 8 | 9 | 6 | 2 |
| rust-crates-diff | 122 | 113,550 | 29,480 | 3 | 47 | 20 | 2 |
| stream-terrain | 34 | 34,215 | 5,282 | 4 | 18 | 12 | 4 |
| stream-statics | 24 | 28,242 | 4,631 | 5 | 8 | 7 | 4 |
| render | 40 | 41,577 | 6,814 | 12 | 11 | 12 | 6 |
| sky-shading | 55 | 28,027 | 5,583 | 22 | 14 | 18 | 7 |
| entities | 51 | 46,862 | 8,258 | 10 | 17 | 24 | 5 |
| vfx-audio | 90 | 39,589 | 17,804 | 15 | 18 | 19 | 5 |
| shell | 103 | 41,527 | 9,477 | 32 | 29 | 19 | 7 |
| plugins-a | 35 | 31,687 | 9,009 | 9 | 21 | 4 | 4 |
| plugins-b | 86 | 30,241 | 5,985 | 16 | 24 | 20 | 5 |
| rynth | 128 | 62,798 | 41,106 | 9 | 35 | 7 | 4 |
| film | 44 | 33,165 | 33,165 | 10 | 17 | 7 | 5 |

Totals: 862 files and 621,619 lines (508,069 in the web app, plus 113,550 in the 122 crate files that changed since 10-07). 194,610 lines changed since 10-07. Reviewers reported 168 files read in full, 280 read in part and 177 swept. The other 237 files, mostly small or unchanged since 10-07, got no report.

**Method.**
- **Reviewers.** Each reviewer got:
  - its file list, sorted by lines changed since 10-07;
  - the known hazards of its area;
  - the earlier review docs, so fixed items are not reported again and still-open ones go to §7;
  - the rule to try to refute every candidate before reporting it. That means quoting the real lines, reading callers and guards, and deciding whether the path runs on a bare URL from the flag reader in the code, not from `url-flags.md`.
- **Verifiers.** Each verifier got only the findings and an instruction to refute them. It found every line again by symbol and returned CONFIRMED, PLAUSIBLE or REFUTED with its own severity and reach. Where a verifier changed a severity, the tables use the verifier's.
- **Orchestrator re-trace.** RENDER-1, VFXAUDIO-1, PLUGINS-A-1, PLUGINS-A-2, PLUGINSB-1 and SHELL-1 were traced again against the source, and all six held.
- **Severity.**
  - critical = a crash, boot failure, security hole or data loss on the default path;
  - high = clearly wrong visible behaviour, or an unbounded leak, on the default path;
  - medium = edge cases, bounded leaks, or serious bugs behind a non-default flag;
  - low = minor, diagnostic, dev-only or latent.

**Not done.**
- **No live check.** Nothing was run in a live client, on the 1070 or in a browser (owner rule), so every verdict is static.
- **Uneven depth.** Read depth varies by area (see the table). `src/lib.rs` (63K lines) was reviewed mostly through its 10-07..HEAD diff and its wasm-bindgen entry points.
- **Out of scope.** The crates outside the 10-07 diff, `tests/`, `harness/`, `tools/` and `vendor/` were not reviewed.

**Queued look checks (owner-run, 1070 or any GPU).** Each one shows a §1 item before the fix, and its absence after.

1. **Hotbar / barber / salvage**, bare URL:
   - Bind a healing kit, use it, and watch for a cooldown sweep on the slot.
   - Hand an MMD note to a vanilla ACE barber (or use `@barbershop`). The barber window should open.
   - Salvage two items with an Ust. Chat should show "You obtain … using your knowledge of Salvaging."

   Expected today: none of the three happens.
2. **Context restore**, ultra:
   1. In town, force a loss and restore with the `WEBGL_lose_context` extension (`loseContext()`, then `restoreContext()` a second later).
   2. Walk until new NPCs spawn and HD textures upgrade.

   Expected today: the newly spawned NPCs and the upgraded surfaces do not draw, `texUnitPin` warnings flood the console, and some occlusion-hidden objects stay hidden in view.
3. **FX light leak**, mid or higher: fight in a group, or stand in a crowd that is casting buffs, for a minute. Then inspect the scene's `activeLights` array for `isFxLightSource` entries with `released === true`.

   Expected today: they accumulate, and nearby torches flicker off when those entries win slots.
4. **Login**:
   - From the server picker, log into a non-default shard and `/logout`. Expected today: the reconnect goes to 127.0.0.1.
   - Log in again right after an unclean tab close. Expected today: "Entering game..." hangs.

## 5. All findings, ranked

Refuted findings are left out of this table (see §6). "re-traced" = the orchestrator checked it against the source as well as the verifier.

| ID | Sev. | Verdict | Where | What | Reach |
|---|---|---|---|---|---|
| RENDER-1 | high | confirmed (re-traced) | `scene3d/async_link_guard.js:329` | After a WebGL context restore the async link guard reads a dead renderer.properties: Mesh*Materials first drawn after the restore never draw | default (?asyncLink reader at :45-48 is `!(off\|0\|false\|no)`, so ON when absent). |
| VFXAUDIO-1 | high | confirmed (re-traced) | `scene3d/vfx/fx_lights.js:291` | A flash evicted by the 10-flash cap stays in scene3d.activeLights for the rest of the session, and still takes light-pool slots ahead of every static lamp | default. fxLights is on in the mid/high/ultra presets (fx_tier1.js:36-38, and the fallback … |
| PLUGINS-A-1 | high | confirmed (re-traced) | `plugins/hotbar.js:1762` | Hotbar's inventory, landblock and cooldown bus listeners never attach on a normal boot: the bar mounts before login with client:null | default: every page load. app/plugin_bar.js:646 `mountBar({ client: null, root: document.b … |
| PLUGINS-A-2 | high | confirmed (re-traced) | `plugins/barber-panel.js:425` | The barber page never opens: barber-panel subscribes to startBarber on the mount-time client, which is null | default: barber-panel is in plugins/index.json:5, is not in BAR_SLOT_SUPPRESS, and its mou … |
| PLUGINSB-1 | high | confirmed (re-traced) | `plugins/salvage-panel.js:603` | Salvage results never arrive: the window subscribes to salvageResult on a null client at boot, so the default-on retail result line (crafting-3) and the Results list are dead | default. salvage-panel is a loader-built bar slot (plugins/index.json:37; |
| RUSTNET-1 | medium | confirmed | `scene3d/net_worker_client.js:202` | A netWorker connect attempt that is superseded while waiting for its worker falls back to a direct login 12 s later, and ACE then boots the live session | flag: netWorkerEnabled() (net_worker_client.js:134-145) is ON only for ?netWorker=1\|on\|tru … |
| RUSTCORE-1 | medium | confirmed | `src/lib.rs:26514` | A record that keeps failing makes every placement of the interior static that reads it re-walk with 1 s of backoff, stalling the interior build for N placements × ≥1 s | default path (?interiorStabBatch, ?interiorStabChunk and ?prefetchRetryDelay all read ON w … |
| STREAM-TERRAIN-2 | medium | confirmed | `scene3d/bc7_textures.js:1826` | A failed HD record fetch (tex-bc7 / tex-bc7-pre / CLIP twin) is cached as a permanent 'absent' verdict for the whole session | default: bc7Enabled reads `!flagIsOff(get("texBc7"))` (bc7_textures.js:127-140, plus the B … |
| STREAM-STATICS-1 | medium | confirmed | `scene3d/statics.js:5291` | Static emitter radius: an LB marked deferred while some of its anchors still have emitters is never torn down, then rebuilt wholesale (duplicate emitters) | default. staticScriptRadiusSetting() returns 2 when the param is absent (statics.js:5157-5 … |
| RENDER-2 | medium | confirmed | `scene3d/uniform_bind_patch.js:588` | texUnitPin keeps pinning units 25-31 after a context restore resets capabilities.maxTextures, so three logs a warning on every pinned sampler upload | default (texUnitPinEnabled :139-147 is ON unless off/0/false/no); |
| RENDER-3 | medium | confirmed | `scene3d/occlusion_cull.js:145` | Occlusion culler queries go stale after a context restore: each proxy's visible/hidden verdict is frozen, and objects hidden at the time of the loss stay invisible while they remain in view | default (FLAG :41-48 is ON unless off; armed outdoors by cells.js:3467 `occ.beginFrame(occ … |
| RENDER-4 | medium | confirmed | `scene3d/loop.js:1835` | ?farFogFence keeps its pixel-pack buffer across a context restore: the horizon sky probe fails three times and turns itself off for the session | default (farFogFenceEnabled far_terrain_flags.js:173-183 and farFogSky :150 are both ON by … |
| SKY-1 | medium | confirmed | `scene3d/atmosphere_pipeline.js:1813` | Layered haze runs after the late particle pass, so particles are hazed by the depth of the terrain behind them (hard seam at the horizon) | default at high/ultra. Clouds have been on by default on those tiers since 2026-10-17 (ind … |
| SHELL-1 | medium | confirmed (re-traced) | `index.html:5185` | CharacterList names leave the data-name attribute decoded and go into innerHTML unescaped (XSS from a malicious shard) | default. characterSelectWanted() (app/character_select.js:59-64) returns !isOff(charSelect … |
| SHELL-2 | medium | confirmed | `app/character_select.js:452` | Retail character screen hangs at "Entering game..." on a CharacterError (nothing sets the 'error' boot state) | default: the character screen on a manual Connect and on the /logout return (?autoLogin=1& … |
| SHELL-3 | medium | confirmed | `index.html:4412` | /logout reload drops the server and bridge chosen in the form and auto-logs into the defaults with the old server's password | default /logout (/logoff) path, for any player whose server or bridge came from the picker … |
| SHELL-4 | medium | confirmed | `scene3d/diag/remote_sync.js:137` | Always-on __diag.remoteSync keeps a 64-record ring for every remote guid ever seen, never pruned | default: installDiag() runs in preInit3D (scene3d/index.js:874), attachRemoteSync is in th … |
| PLUGINSB-2 | medium | confirmed | `plugins/vendor-ui.js:1189` | vendor-ui keeps the first session's SessionHandle for its whole life: after an autoLogin kick and retry, vendors never open | non-default only: `?autoLogin=1&maxRetries=N` with N>=1 when a kick, timeout or error foll … |
| RYNTH-1 | medium | confirmed | `rynth/vt/meta/engine.js:684` | Meta setmotion[] keys stay held when the meta is disabled, unloaded or swapped; only an operator hold, portalIn or destroy releases them | flag: EnableMeta (schema.js:89 default false) on a running VT bot (HUD START or ?bot=1), w … |
| RYNTH-2 | medium | confirmed | `rynth/nav_file.js:230` | A truncated .nav silently gets a bogus last waypoint at ns/ew/z = 0 with no warning; the VT nav import accepts it | flag: importing or loading a malformed VTank .nav (NavProfiles import nav_profiles.js:458, … |
| RYNTH-3 | medium | confirmed | `rynth/vt/formats/met.js:177` | .met reader: a zero-column TABLE with a huge row count loops and allocates without bound (tab freeze or OOM from a ~30-byte file) | flag: VT library .met import (vt/index.js:607-612 importMeta to parseMet, via bridge_route … |
| RYNTH-4 | medium | confirmed | `rynth/vt/nav/executors.js:433` | Operator STOP does not abort an in-flight nav jump: attemptJumpLeg keeps turning, holding forward and jumping for up to ~8 s after STOP | flag: EnableNavigation (schema.js:85 default false) with a VT route whose Point leg stalls … |
| FILM-1 | medium | confirmed | `scene3d/film/runtime/camera_owner.js:466` | The wall-exit cell escape added on 10-16 turns a dungeon camera's viewer cell into an outdoor landcell, so cells.js hides the whole dungeon for the rest of the take | flag: ?filmMode=on (reader scene3d/index.js:4632 `get("filmMode") === "on"`, default OFF). … |
| SKY-2 | medium | plausible | `scene3d/ssao.js:101` | SSAO writes a 1.0e6 sky sentinel into an RG16F target (max 65504); drivers that convert overflow to +Inf turn every sky pixel's AO into NaN | default at high/ultra (ssaoEnabled falls back to the preset's ssao:true, ssao.js:33-44). |
| VFXAUDIO-3 | medium | plausible | `scene3d/particles/particle_manager.js:1709` | Interior static FX lights are not cell-scoped, so they skip the RND-05 room filter and light through walls from rooms the player cannot see | default. The interior particle layer reader at statics.js:5343-5353 is coded `!== "off"`, … |
| RUSTNET-3 | low | confirmed | `src/session/messages/game_event.rs:124` | pending_confirmations grows for the whole session in human (non-rynth) sessions, and a server-closed dialog is never removed | default: every GameEvent CharacterConfirmationRequest (0x0274) on any session is pushed. |
| RUSTCORE-2 | low | confirmed | `src/lib.rs:11691` | resolve_degrade_part_frame re-parses Setup, part GfxObj and idle MotionTable/Animation on every fetch_model_meshes call, with no memo | default path: fetch_model_meshes is the statics decode for every LB bake; |
| RUSTCRATES-1 | low | confirmed | `crates/holtburger-world/src/spatial/scene.rs:7052` | Settle falls deeper than ~78 m hit the 4 s arc cap and snap the remaining 0-22 m to the floor in one slice | default path (remoteSettle, remoteInterp and remoteJumpArc are all ON when the param is ab … |
| STREAM-TERRAIN-1 | low | confirmed | `scene3d/terrain.js:5886` | The terrain LOD re-bake queue never re-checks residency, so a landblock parked or evicted after it was queued is re-baked into the scene (duplicate terrain on unpark, a visible batch row for a parked landblock, far landblocks brought back as resident) | default on high/ultra presets (subdivLevel>=4, so halfLevel>=2): LOD_REBAKE_ON at terrain. … |
| STREAM-TERRAIN-4 | low | confirmed | `scene3d/tex_upgrade_queue.js:202` | TexUpgradeQueue's HTTP-version probe cannot see the records it governs, so h2/h3 origins run the HTTP/1.1 in-flight caps | default: texUpgradeQueue (tex_upgrade_queue.js:89-96) and shardFetchWorker (shard_fetch_cl … |
| STREAM-STATICS-3 | low | confirmed | `scene3d/statics.js:445` | statics.js diag hooks (__lodCollapseDup, __degradePose, __retailDegrade, __staticPartAnchor) read the second module instance, whose counters never move | default (the hooks exist on every page). It only affects diagnostics and eye-test readouts … |
| STREAM-STATICS-4 | low | confirmed | `scene3d/cells.js:2603` | ?freezeStaticMatrix (default on) freezes only each cell container's own matrixWorld; three r184 still recomposes every descendant every frame | default. FREEZE_STATIC_MATRIX (cells.js:1444-1450) is false only for ?freezeStaticMatrix=o … |
| RENDER-5 | low | confirmed | `scene3d/interior_shadow_cull.js:106` | requestShadowRaster does nothing under the per-cascade shadow gate (shadowMoverScope is on by default), so interior cast flips wait for the 12-frame ceiling | flag only: needs ?csm=on or ?shadows=on. csm is false in all four presets (quality.js:161, … |
| SKY-3 | low | confirmed | `scene3d/atmosphere_pipeline.js:2368` | The camera-switch path in render() never retargets ssaoPass or layeredHaze (setCamera() has no callers), so in topDown both run with the stale perspective camera | default: CAMERA_MODES = ["follow", "topDown", "orbit"] (camera.js:195), so the first C pre … |
| SKY-4 | low | confirmed | `scene3d/cloud_storm_look.js:136` | ?cloudCoverage (and __setCloudCoverage set before adoption) is overwritten by the cloud look: dead unless ?cloudWeather=off | flag: ?cloudCoverage=<n> without ?cloudWeather=off (readCloudWeatherAutoFlag is ON unless … |
| SKY-5 | low | confirmed | `scene3d/atmosphere_pipeline.js:1765` | With ?nanScrub=off on the split chain, the layered haze output is discarded: fxPostPass reads the late target T, not the buffer the haze wrote | flag: ?nanScrub=off (the reader at :1709-1713 is `!== "off"`, so the scrub is on by defaul … |
| SKY-6 | low | confirmed | `scene3d/color_grade.js:167` | ColorGradeEffect.update allocates about 18 short-lived objects every rendered frame (blendGrade) | default: colorGradeEnabled returns true when ?grade is absent (color_grade.js:38-48). |
| SKY-7 | low | confirmed | `scene3d/terrain_dirt.js:1235` | terrain_dirt footfall rate-limit map (lastStepAt) is keyed by entity guid and never pruned | flag-only, NOT default. initTerrainDirt returns null unless terrainDirtEnabled() (terrain_ … |
| ENTITIES-1 | low | confirmed | `scene3d/entities.js:13880` | Internal respawn of the selected target (appearance fallback, same-guid re-create) reads as a deselect: CancelAttack sent and the attack repeat ended | default. Every remove() of the selected guid emits the clear. |
| ENTITIES-2 | low | confirmed | `scene3d/entities.js:9016` | Re-selecting a target after its same-guid respawn overwrites prevSelectedID with 0 | default. ?targetCycle is on unless =off (entities.js:4149-4153). |
| ENTITIES-3 | low | confirmed | `scene3d/entities.js:12664` | setMotion's post-await liveness check is `.has(guid)`, so a stale motion commits onto a disposed rig after a same-guid respawn | default: any setMotion whose cycle, link or hop bake is pending while the guid is torn dow … |
| VFXAUDIO-4 | low | confirmed | `scene3d/vfx/portal_registry.js:19` | The static portal-anchor registry is pruned only by the fx_showcase scan, so it grows without bound under the low preset and the showcase/set-piece escapes | flag/preset: the low preset (fxShowcase false, fx_tier2.js:47), ?fxShowcase=off, or ?porta … |
| VFXAUDIO-5 | low | confirmed | `scene3d/vfx/fx_distort.js:90` | fx_distort stamps sources with performance.now() but measures ring phase on the film clock, so stepped film takes freeze shockwaves | flag: ?filmMode=on (default off) during a stepped take. |
| SHELL-5 | low | confirmed | `scene3d/diag/motion.js:233` | Always-on __diag.motion.byGuid keeps an entry (with 20 transitions) for every guid that ever changed cycle | default: attachMotion is in the default diag attach list (scene3d/diag.js:633), and entiti … |
| SHELL-7 | low | confirmed | `app/character_select.js:326` | Character-screen preview reads globalThis.localStorage outside a try | default code; only triggers when the browser blocks site data, so the window.localStorage … |
| PLUGINS-A-3 | low | confirmed | `plugins/book-panel.js:512` | The book range watch builds an unfreed BookSnapshotJs, a clone of every page, every 500 ms while a book is open | default: BOOK_RANGE_CLOSE = bookFlagOn("bookRangeClose") (book-panel.js:59-66), true unles … |
| PLUGINS-A-4 | low | confirmed | `plugins/hotbar.js:1624` | Hotbar reconcile and drop paths call playerInventory() and never free the boxes, up to 18 full snapshots per reconcile | default: reconcileWithServer's wcidOf runs only when a merge happens (once per login, per … |
| PLUGINSB-3 | low | confirmed | `plugins/tinker-panel.js:307` | Tinker window stays on 'Working…' and keeps a consumed tool in its slot: its playerInventoryChanged subscription is made on the null boot client | dev-only. No production code calls __openTinkerPanel or __toggleTinkerPanel; |
| PLUGINSB-4 | low | confirmed | `plugins/landblock-messages.js:90` | ?lbMessages=on never subscribes: null boot client, and the disposer expects events.on to return an unsubscribe it never returns | flag:lbMessages=on, strict opt-in. :81 reads `=== "on"`, and :86 makes mount a no-op other … |
| FILM-2 | low | confirmed | `scene3d/film/runtime/take_player.js:3167` | Stepped takes below 10 fps run the world at fps/10 speed: the film clock is floored at 10 fps while the camera, the recording and the time-lapse use 1/fps — and the CLI rehearses every shot at 8 fps | flag: ?filmMode=on, stepped takes or rehearsals with fps < 10. |
| FILM-3 | low | confirmed | `scene3d/film/runtime/recorder.js:625` | recorder.abort() after a grab or output failure never closes the VideoEncoder (a configured hardware encoder stays alive until the next shoot) | flag: ?filmMode=on, recorded shoots where grab() (or the output handler) throws |
| FILM-4 | low | confirmed | `scene3d/film/index.js:1199` | Handing the client back never undoes the take's look: release()/dispose() and the CLI's documented `--release` leave the sky-time pin, the AdminEnvirons fog override, the grade, exposure, bloom, vignette and DoF applied | flag: ?filmMode=on, after any take whose plan carries a look (prepare: index.js:1058 `look … |
| FILM-5 | low | confirmed | `scene3d/film/runtime/clean_frame.js:255` | clean_frame's nameplate hide is undone on the next animation frame by nameplate_sprite's self-managed LOD loop | flag: ?filmMode=on AND ?nameplates=on AND no ?hud=none. |
| RUSTCRATES-2 | low | plausible | `crates/holtburger-core/src/client/simulation.rs:687` | Native server-MoveTo projection reads MoveToObject's desired_heading (an offset) as an absolute compass heading and ignores UseFinalHeading | native CLI only, and only on a fallback. The wasm path skips ClientRuntime, and the only c … |
| STREAM-TERRAIN-3 | low | plausible | `app/landblock_stream.js:446` | An interior build that is evicted mid-way is never cancelled: its remaining per-cell collision products land after the eviction clear, and ensureCellContainersForLandblock re-marks the landblock as populated | default flags (interiorBuildShareEnabled at landblock_stream.js:68-77 is null->true; |
| STREAM-STATICS-2 | low | plausible | `scene3d/statics.js:5794` | Pending start_time>0 CreateParticle timers survive a radius teardown and attach emitters to a deferred anchor | default. STATIC_SCRIPT_HOOK_TIME_ON reads ON unless ?staticScriptHookTime=off/0/false/no ( … |
| RENDER-6 | low | plausible | `scene3d/adaptive_render_scale.js:129` | Adaptive render scale's boot grace never ends if the scene never reports 'ready', so the controller never lowers the resolution | default flags (adaptiveResBootGraceEnabled :112-122 is ON by default), but only on a faile … |
| ENTITIES-4 | low | plausible | `scene3d/entities.js:16131` | Script-sourced CallPES re-queues onto the captured old rig after a same-guid respawn (identity check is `.has`) | default: SCRIPT_QUEUE_ON reader `.get("scriptQueue")?.toLowerCase() !== "off"` (:2305-2310 … |
| ENTITIES-5 | low | plausible | `scene3d/animation.js:1061` | AnimationCache.getLink (new, default ON) never frees the EntityAnimationData box from fetchMotionLinkKeyframes | default: ?linkOnlyBake is on (entities.js:549-559, read at :4312). |
| VFXAUDIO-2 | low | plausible | `scene3d/vfx/fx_lights.js:429` | The 2 Hz FX-light dedupe is O(E^2) over every lit emitter in the whole emitter radius, so it causes a periodic main-thread hitch | default (fxLights on in mid+; _bindTier1 at particle_manager.js:1689-1711 binds every lit … |
| PLUGINSB-5 | low | plausible | `plugins/world-objects/world_object_manager.js:122` | WorldObjectManager queues every spawn and delete forever if load() fails once | default path, but only after a one-time fetch or parse failure of data/chorizite/world-obj … |

## 6. Findings by area

Each finding: location and symbol, severity after verification, verdict, whether the code is new since 10-07, reach (default or flag), the failure, the suggested fix, and an excerpt of the verifier's check. Refuted findings are kept, with the reason, so they are not raised again.

### Rust wasm crate: network and session (`rust-net`)

Default path (direct mode): index.html login submit calls wasm start_session, and the recv_loop in lib.rs owns a LoopSession::Direct(Session). Each inbound SessionEvent goes to session/messages/mod.rs handle_message, which does these steps in order: stamp last_recv_instant; adopt TimeSync; GameMessage::unpack; wire_integrity::observe (diag counters); held-3 object-blob queue (ParentEvent/PickupEvent); last_outside_death + inventory_request observe_response; the remote-enchantment pre-route hook; should_route_message_to_world, which runs the holtburger-world handlers and maps WorldEvents into ClientEvents; bridge-index maintenance; then dispatch_game_message to position/objects/game_event/chat/login/misc. Every module ends in `_ => unreachable!`, and the routing tables were checked to be exhaustive with no guarded top-level arms.

**RUSTNET-1 — A netWorker connect attempt that is superseded while waiting for its worker falls back to a direct login 12 s later, and ACE then boots the live session**  
`scene3d/net_worker_client.js:202` (`startNetWorkerSession`) · medium · CONFIRMED · new since 10-07: no  
Reach: flag: netWorkerEnabled() (net_worker_client.js:134-145) is ON only for ?netWorker=1\|on\|true, or for ?agent=1 / ?bot=1 when netWorker is absent. NET_WORKER_DEFAULT=false, so the bare URL is not affected. The trigger is a second Connect submit while the first attempt is still in its worker ready-wait. A double-click is enough: main-thread init() is already done, so attempt 1 reaches the ready-wait within microtasks, before the second click event runs.

- Failure: Page on ?netWorker=1 (or ?agent=1). The user clicks Connect, then clicks "Connect (retry)" within the worker's wasm init (~1-3 s). Attempt 2 calls terminateActiveWorker() (line 163), which nulls worker1.onmessage and terminates it. Attempt 1's ready promise can then only settle through the 12 s READY_TIMEOUT_MS. At 12 s, `!ready || _activeWorker !== worker` is true, so line 207 runs `return direct()`. That opens a second, main-thread WebSocket and sends a LoginRequest for the same account while attempt 2's session is already at character select or in world. With ACE's default account_login_boots_in_use=true (PropertyManager.cs:501), AuthenticationHandler.cs:186-193 boots the existing session (CharacterError Logon + Terminate) and also refuses the new one. Both sessions die about 12 s after the user connected.
- Fix: Separate the two cases. When `_activeWorker !== worker` (superseded), do not call direct(): throw or reject with a 'superseded' error, which the submit handler already tolerates. Make terminateActiveWorker resolve any pending ready-wait at once (keep a per-worker `cancel` callback and call done(false) with a superseded marker), so the superseded attempt also stops waiting 12 s. Keep the direct() fallback only for a genuine init error or timeout of the CURRENT worker.
- Verifier: I traced the code and it does what the finding says. Line 163 `terminateActiveWorker();` runs on every new attempt. Lines 84-92 null `_activeWorker.onmessage/onerror` and terminate the prior worker. The pending ready-wait's only other resolver is line 187 `const to = setTimeout(() => done(false), READY_TIMEOUT_MS);` (READY_TIMEOUT_MS = 12000, line 43). After 12 s, line 202 `if (!ready || _activeWorker !== worker) {` is true and line 207 `return direct();` runs.

**RUSTNET-3 — pending_confirmations grows for the whole session in human (non-rynth) sessions, and a server-closed dialog is never removed**  
`src/session/messages/game_event.rs:124` (`handle (CharacterConfirmationRequest / CharacterConfirmationDone arms)`) · low · CONFIRMED · new since 10-07: no  
Reach: default: every GameEvent CharacterConfirmationRequest (0x0274) on any session is pushed. The only drain is the rynth host.

- Failure: A player tinkers or crafts all evening on the bare URL. Each ACE confirmation adds a PendingConfirmation (type, context, text clone) to the Vec, and nothing drains it, because the crafting-1 dialog (plugins/server-confirm.js) is fed by the separate kind event. If a rynth/VT bot is enabled later in the same page, its first pendingConfirmations() call returns every stale request, including ones ACE already closed with CharacterConfirmationDone (timeouts/aborts), and the bot may answer dead dialogs. Memory growth is small (on the order of 100 B per request) but has no bound.
- Fix: In the CharacterConfirmationDone arm, retain-out the matching (confirm_type, context). Also cap the Vec (for example, keep the newest 16), or stop queueing when no rynth host is attached.
- Verifier: game_event.rs:117-127, the CharacterConfirmationRequest arm, does `pending_confirmations.borrow_mut().push(PendingConfirmation { confirm_type, context, text: data.text.clone() })`. The CharacterConfirmationDone arm (146-157) only queues CLIENT_EVENT_KIND_CONFIRMATION_DONE and never removes the entry. send_confirmation_response (lib.rs:46425-46443) also leaves the Vec alone, so dialogs the human answers through plugins/server-confirm.js stay queued too.

**RUSTNET-2 — In netWorker mode, a recv loop that ends by itself (AccountBoot, dead-session detector, failed send) leaves the worker connected and pinging ACE forever**  
`src/net_worker.rs:460` (`net_worker_run / RemoteSessionProxy`) · low · REFUTED · new since 10-07: no  
Reach: flag: ?netWorker=1, auto-enabled for ?agent=1 / ?bot=1. Only after the main recv loop exits by itself.

Refuted: The Rust half of the description is accurate. RemoteSessionProxy (net_worker.rs:159-226) has no Drop. The AccountBoot arm (session/messages/login.rs:471-492 `return LoopFlow::Exit;`) and the dead-session detector (lib.rs:52112-52128 `return;`) post nothing to the worker. The worker's keepalive arm (net_worker.rs:510ff) pings whenever `session.isaac_c2s.is_some()`. But the core claim is wrong: the worker does not ping 'forever' on 'a WebSocket the bridge keeps open'. The project's bridge reaps exactly this case. apps/holtburger-wsbridge/src/bridge.rs:36-45 (conn-fix 2026-07-18) has `const ACE_SILENCE_TIMEOUT: Duration = Duration::from_secs(90);` with the comment 'session booted by a duplicate login, server restart ... The bridge is the only party that can reap these'. liveness_watchdog (bridge.rs:102-118, 10 s tick) is select!-ed with both pump halves (bridge.rs:389-401 `res = watchdog =>`). It tears the connection down when nothing has come from ACE for 90 s, measured from the first client send (seed_if_zero at 593), and then end_ace_session sends ACE a Disconnect. Closing the WS fires the transport's onclose (crates/holtburger-transport-ws/src/transport.rs:184-192 `"ws closed (code=..."` pushed as Err).

### Rust wasm crate: core (lib.rs and the decode modules) (`rust-core`)

src/lib.rs is the wasm-bindgen crate root (63K lines): URL-flag parsers (OnceLock per instance over the seeded flag_search(), so the bake worker reads them too), DAT fetch/decode exports (fetch_model_meshes, fetch_surfaces_pixels, fetch_env_cells_in_landblock, fetch_landblock_heightmaps, fetch_entity_degrade_for_distance, fetch_motion_link_keyframes …), cross-call memos (MODEL_TRI_CACHE, DID_DEGRADE_MEMO and the new DEGRADE_BASE_GFX/DEGRADE_LEVELS memos, SURFACE_PIXEL_CACHE, MOTION_LINK_SWING_MEMO; global_source::init_resource_source clears them on re-init), thread_local *_PENDING queues that populate_* / fetchEnvCellsInLandblock fill and the TickMovement arm drains into SpatialScene, and SessionHandle/start_session/recv_loop. The recv_loop's per-message handling lives in session/ (other bucket).

**RUSTCORE-1 — A record that keeps failing makes every placement of the interior static that reads it re-walk with 1 s of backoff, stalling the interior build for N placements × ≥1 s**  
`src/lib.rs:26514` (`interior_stab_memo_entry / fetch_env_cells_in_landblock`) · medium · CONFIRMED · new since 10-07: yes  
Reach: default path (?interiorStabBatch, ?interiorStabChunk and ?prefetchRetryDelay all read ON when absent: lib.rs:1371-1384 and batch_walk.rs:76-87 use `!any(off\|0\|false\|no)`), but it only fires when a shard keeps failing (a catalog-listed shard that 404s, where tolerate_404=false, or a hash mismatch that comes back on every try)

- Failure: Take an interior Setup placed 30 times in a hall, one of whose part records fails every fetch (PartialRound). The landblock batch walk excludes the key and ends unsettled. That turns the stab memo off for the whole build (stab_memo_on=false, 27106). Each placement then calls interior_stab_memo_entry in turn. Its per-stab ensure_walk_prefetched_keyed_batch has its own empty exclusion set, so it rediscovers the bad key and makes 3 attempts with round_retry_backoff 250 + 750 ms before excluding it. The per-cell loop awaits each placement, so fetchEnvCellsInLandblock stays pending at least 30 s longer, and the player stands in an empty or partial interior. Before 10-09/10-13 the same failure cost three back-to-back attempts, about one RTT each. The batch walk already knew the failed keys, but nothing passes them on.
- Fix: Remember failure per build. Keep a HashSet of stab ids whose fallback walk ended with failed>0, and memoise their (partial) InteriorStabMemo for the rest of the build. Another option is to return the batch walk's excluded key set in BatchWalkStats and skip the fallback walk for stabs that read them. Either way a bad key costs one ~1 s retry cycle per build instead of one per placement. Memoising per stab id also when unsettled (just not marking it trusted) would remove the CPU re-parse per placement too.
- Verifier: I traced the whole path. (1) The memo is gated on settled(): lib.rs:27106 `let stab_memo_on = matches!(&stab_batch_stats, Some((_, _, s)) if s.settled());` and batch_walk.rs:162 `self.failed == 0 && matches!(self.end, Complete | Stalled)`. One excluded key in any chunk sets failed>0, and merge_all sums it, so the memo is off for the whole build. (2) With the memo off, every placement recomputes in sequence. lib.rs:27668-27678: `let cached = stab_memo.get(&stab.stab_id).cloned(); ...

**RUSTCORE-2 — resolve_degrade_part_frame re-parses Setup, part GfxObj and idle MotionTable/Animation on every fetch_model_meshes call, with no memo**  
`src/lib.rs:11691` (`resolve_degrade_part_frame (called from fetch_model_meshes / fetch_model_mesh)`) · low · CONFIRMED · new since 10-07: yes  
Reach: default path: fetch_model_meshes is the statics decode for every LB bake; statics.js:2909-2938 fetches every unique model id per LB unless ?statGeomCache=on, and static_geom_cache.js:55-61 is exact-match opt-in, so it is OFF by default. ?degradePose is default-on (statics.js:1463-1466), though the Rust side computes the frame either way. It mostly runs in the bake worker.

- Failure: A town landblock bake asks fetch_model_meshes for every model the landblock places. The triangles come from MODEL_TRI_CACHE and did_degrade from DID_DEGRADE_MEMO. For each single-part 0x02 Setup with a degrade chain (signs, posed props), resolve_degrade_part_frame runs SetupModel::unpack, a full GfxObj::unpack of the part (vertices, polygons, BSPs) only to re-check did_degrade, and try_resolve_idle_anim_frame_with_override (MotionTable + Animation parse) again. That repeats for every landblock bake of every such model, all session. Perf T3's DID_DEGRADE_MEMO doc calls exactly this per-model GfxObj re-parse the last per-re-entry decode on the statics path. The answer depends only on model_id and the immutable DAT.
- Fix: Memoise the 10-float frame by model_id next to DID_DEGRADE_MEMO, with the same MissCountingSource completeness gate. Clear it in model_tri_cache_clear_all. mesh.did_degrade != 0 already proves the single-part-with-chain shape, so the GfxObj re-parse can go.
- Verifier: lib.rs:11691-11734 resolve_degrade_part_frame has no memo. It runs `SetupModel::unpack` (11701), a full `GfxObj::unpack(&mut std::io::Cursor::new(&pbytes))` of part 0 (11710) used only to re-check `did_degrade != 0`, and `try_resolve_idle_anim_frame_with_override(source, &setup, None)` (11714). That function (11038-11089) parses the MotionTable and the Animation again, also with no cache. Callers: fetch_model_meshes at 19248-19251 (`mesh.did_degrade = resolve_did_degrade_cached(...);

### Workspace crates compiled into the wasm (changes since 10-07 only) (`rust-crates-diff`)

Workspace crates compiled into the holtburger-web wasm, reviewed as the diff b8819698..7ae7667a (16 commits, ~20k non-test lines). - holtburger-core client/movement: MovementSystem is the local-player driver. finish_manual_slice_via_transition runs the PositionManager chain, then the faithful transition, then post-transition clamps (FU-3 entities, scenery). After those come the new default-ON clamp replant, the clampAlongGround plane carry, landing bounce, ground-keep / AP gating and the always-on hop_diag observer. command_interpreter.rs (cast lock, emote table) and common.rs (wire builders: TurnLeft enum, retail raw-default omission) feed MoveToState / AutonomousPosition sends. The retail AP gate (no airborne APs, force-position ack) is default ON. - simulation.rs (ClientSimulationSystem::tick) steps the local body, then calls WorldState::step_remote_objects every slice.

**RUSTCRATES-1 — Settle falls deeper than ~78 m hit the 4 s arc cap and snap the remaining 0-22 m to the floor in one slice**  
`crates/holtburger-world/src/spatial/scene.rs:7052` (`SpatialScene::step_remote_inner (arc pass) / start_remote_settles`) · low · CONFIRMED · new since 10-07: yes  
Reach: default path (remoteSettle, remoteInterp and remoteJumpArc are all ON when the param is absent: lib.rs:1792-1796 `!...any(remoteSettle=off\|0\|false)`, lib.rs:1719-1722, lib.rs:1870-1874; thread-local REMOTE_SETTLE defaults true at scene.rs:356). The input that triggers it (an ACE spawn floating 78-100 m above the sampled floor) has not been seen: the live log tops out at 67.3 m (scene.rs:388-391 comment).

- Failure: ACE scatter-spawns a creature 90 m above the terrain (inside the accepted drop window, which ends at REMOTE_SETTLE_MAX_DROP_M = 100). The settle starts a fall from rest. The first slice moves nothing, so after REMOTE_ARC_MAX_S = 4.0 s the body has fallen only about 0.5*9.8*(4-q)^2, roughly 77.7 m. The cap branch then sets z to the floor at once, so the body teleports the last ~12 m instead of finishing the parabola (up to ~22 m for a 100 m drop). The JS rig sees the landing edge mid-air. Not hit in today's log (highest float 67.3 m), but the 100 m cap was chosen above what the 4 s arc can carry.
- Fix: Size the two limits together. Lower REMOTE_SETTLE_MAX_DROP_M to about 0.5*9.8*(REMOTE_ARC_MAX_S - 0.1)^2 (~75 m), or exempt settle arcs from the 4 s cap: carry a `settle: bool` on RemoteArc, or give them a cap of sqrt(2*drop/g) + 0.5 s.
- Verifier: I traced the code and it does what the finding says. The constants are set apart from each other: scene.rs:392 `const REMOTE_SETTLE_MAX_DROP_M: f32 = 100.0;` and scene.rs:443 `const REMOTE_ARC_MAX_S: f32 = 4.0;`. start_remote_settles accepts any drop up to the larger one, scene.rs:7553 `let falls = drop > REMOTE_UNKNOWN_FLOOR_M && drop <= REMOTE_SETTLE_MAX_DROP_M;`, and starts a RemoteArc with elapsed 0.0 and no initial velocity (7570-7574).

**RUSTCRATES-2 — Native server-MoveTo projection reads MoveToObject's desired_heading (an offset) as an absolute compass heading and ignores UseFinalHeading**  
`crates/holtburger-core/src/client/simulation.rs:687` (`ClientSimulationSystem::handle_server_controlled_movement / build_server_controlled_result`) · low · PLAUSIBLE · new since 10-07: no  
Reach: native CLI only, and only on a fallback. The wasm path skips ClientRuntime, and the only caller is client/messages.rs:84. Natively the faithful driver is on (USE_MOVETO_DRIVER = true, holtburger-world motion/move_to.rs:60; USE_SERVER_MOVETO_DRIVER = true, system.rs:602; set_server_moveto_driver is only called from wasm lib.rs:51445 and tests). So a MoveToObject reaches this projection only when `world.get_visible_entity(mto.target)` is None (simulation.rs:732-735). The build_server_controlled_result MoveToObject arm (lines 915-922) is never reached at runtime: handle_server_controlled_movement returns early for every MoveToObject (lines 759 and 774), so only the tests at :1122/:1167 call it. Its MoveToPosition arm (932-933) runs only with the driver off, which cannot happen natively.

- Failure: The server sends the local player a MoveToObject with UseFinalHeading (0x40) and desired_heading = 90 ("face 90 deg right of the object"). Retail turns to heading_to_object + 90 (MoveToObject_Internal, acclient.c:345895-345901). The native projection sets the rotation to Quaternion::from_wire_heading(90), compass East, whatever the object's bearing. It does the same for a non-zero desired_heading without the 0x40 bit, where retail adds no final turn at all. The 2026-10-11 NPC-facing fix changed only the units, from_heading(rad) to from_wire_heading(deg). The semantics stayed wrong, against the offset convention its own math.rs block comment states.
- Fix: For MoveToObject, when params.movement_parameters & 0x40, use from_heading((heading_to_object_deg + desired_heading).to_radians()); otherwise face the object. Gate MoveToPosition's final heading on 0x40 as well.
- Verifier: The mismatch with retail is real. simulation.rs:687-691 is `target_pose.rotation = if mto.params.desired_heading.abs() <= 1e-6 { Quaternion::from_heading(target_pose.coords.heading_to(&mto.origin.position)) } else { Quaternion::from_wire_heading(mto.params.desired_heading) };`. Retail MoveToManager::MoveToObject_Internal (acclient.c:345859) does `if ( v3->movement_params.bitfield & 0x40 ) { v5 = _target_positiona + v3->movement_params.desired_heading; ...

Related defects the verifier noticed while checking (not separately verified):

- crates/holtburger-core/src/client/simulation.rs:915-934 — the build_server_controlled_result MoveToObject and MoveToPosition arms are dead at runtime: handle_server_controlled_movement returns early for every MoveToObject (:759/:774), and the native driver is never switched off, so MoveToPosition always takes the early return at :812. Only the unit tests at :1122/:1167 exercise those arms, so those tests pin code no client runs (latent maintenance trap, not a user-visible bug).

### Streaming, residency and terrain bake (`stream-terrain`)

Boot: index.html runs installShardFetchWorker (?shardFetchWorker, default ON). From then on the MAIN wasm instance's shard records are fetched, read and sha-checked in scene3d/shard_fetch_worker.js. The bake worker (bake_worker.js, default ON) holds its own wasm and fetches its own records directly. bake_worker_client merges queued fetchSurfacesPixels requests (?bakeSurfaceCoalesce, default ON) and gives lane 0 a reserve slot, but only when packs are on. HD textures: the production MaterialCache arms the TexUpgradeQueue (tex_upgrade_queue.js, default ON). Every full/pre/twin/texchan leg in bc7_textures.Bc7RecordSource (_beginQueued/_queuedFetch) is admitted through it in visibility-index order, with in-flight caps and a token bucket. The queue pauses while bandwidth_tier.interiorBuildPending() is true. xu7 transcodes run on the texture worker (?texWorkerEager, default ON).

**STREAM-TERRAIN-2 — A failed HD record fetch (tex-bc7 / tex-bc7-pre / CLIP twin) is cached as a permanent 'absent' verdict for the whole session**  
`scene3d/bc7_textures.js:1826` (`Bc7RecordSource._settleHbc7 / _begin / getPreAsync / hbc7Fallback`) · medium · CONFIRMED · new since 10-07: no  
Reach: default: bc7Enabled reads `!flagIsOff(get("texBc7"))` (bc7_textures.js:127-140, plus the BPTC capability gate), texXu7Enabled likewise (xu7_textures.js:94-105), texUpgradeQueueEnabled is `!flagIsOff` (tex_upgrade_queue.js:89-96). The source is installed with the main wasm exports (index.html:2629). It needs a network or shard failure while an HD record is being fetched.

- Failure: A Wi-Fi drop, tunnel restart, Cloudflare 5xx or a bad cached shard happens while HD records stream (Town Network asks for 151 records of up to 4 MB). The wasm export bc7_blocks discards the prefetch error (`let _ = source.prefetch(...).await`), get_file_by_key returns Err, and the export returns an empty Vec. The JS side treats empty as proven-absent: `_put(this._cache, id, null)`, never evicted. The RenderSurface then stays at retail resolution for the rest of the session. Every later material on it reads `src.known(rsId)` and gets the cached null as an 'absent' verdict. The shard worker's RELOAD RETRY (cache:"reload" after a sha mismatch) never gets the second request it needs. The pre and twin lanes do the same (_preCache null, _hbc7Absent). A rejected fetch also lands in `.catch` and is cached with `_put(null) // never re-hammer a broken endpoint`.
- Fix: Make the wasm export tell the cases apart: return a distinct sentinel or reject when prefetch failed and key_known_absent is false. In Bc7RecordSource, negative-cache only proven absence, and give failures a timed retry (e.g. a failedAt map with a 30 s re-ask, as audio_manager does) instead of a permanent null.
- Verifier: The wasm export cannot tell a failure from absence. In bc7_blocks (src/lib.rs:12420), `let _ = source.prefetch(&[...]).await;` throws away the prefetch error, and `Err(_) => { BC7_MISSES...; return Vec::new(); }` then turns the cache miss from that failed prefetch into the same empty Vec used for absence. That is the only fetch attempt: ManifestResourceSource::prefetch_impl has no per-call retry, and the 3-try round ladders sit in batch_walk.rs/prefetch.rs, which this export does not use.

**STREAM-TERRAIN-1 — The terrain LOD re-bake queue never re-checks residency, so a landblock parked or evicted after it was queued is re-baked into the scene (duplicate terrain on unpark, a visible batch row for a parked landblock, far landblocks brought back as resident)**  
`scene3d/terrain.js:5886` (`drainOneTerrainLodRebake`) · low (reviewer said medium) · CONFIRMED · new since 10-07: no  
Reach: default on high/ultra presets (subdivLevel>=4, so halfLevel>=2): LOD_REBAKE_ON at terrain.js:5740-5745 reads `get("lodRebake") !== "off"`, warmPark is ON (landblock_lru.js:257-266), terrainBatch is ON (terrain_batch.js:98-108), slotGrid is OFF. It only fires after a teleport or portal: when you walk, the LBs that drop out of the 3x3 stay inside the protected wanted ring and are never parked.

- Failure: High preset: the 3x3 around the player bakes at level 2, everything else at level 1. The player portals from A to B. reconcileTerrainLodForCentre queues A's 3x3, which should now be level 1. B's ring fills the stream guard's 6 non-urgent slots, so each re-bake is refused and re-queued every second (refused(), LOD_REBAKE_RETRY_MS). Meanwhile the LRU parks A's landblocks: geometry pressure picks the farthest first, and a second hop adds a count overage. The next drain finds no terrainGroup child for the parked landblock (old = []), deletes its baked mark (line 5886) and bakes a fresh level-1 mesh. terrain_batch absorbs it as a VISIBLE row and removes the landblock from parkedLbs, so the parked landblock paints terrain again and its slot can no longer be stolen. LandblockLRU.track merges the new disposables into the parked copy.
- Fix: In drainOneTerrainLodRebake, drop the key without baking when `old.length === 0` or `scene3d.landblockLru?.isParked?.(lbKey)`: the landblock is no longer resident, and the normal loaders re-bake it at the right level when it returns. Also have the LRU's park/evict hooks delete the key from `scene3d._lodRebakeQueue` and `_lodRebakeBackoff`.
- Verifier: The mechanism is real. drainOneTerrainLodRebake never checks residency. It collects `old` by scanning terrainGroup (5875-5883), runs `if (baked) baked.delete(lbKey);` (5886) and calls `p = scene3d.loadTerrainForLandblock(lbX, lbY);` (5897). park() removes the LB's terrain children from the group (landblock_lru.js:2185-2193) but keeps the baked mark, so for a parked LB `old` is empty.

**STREAM-TERRAIN-3 — An interior build that is evicted mid-way is never cancelled: its remaining per-cell collision products land after the eviction clear, and ensureCellContainersForLandblock re-marks the landblock as populated**  
`app/landblock_stream.js:446` (`ensureCellContainersForLandblock`) · low (reviewer said medium) · PLAUSIBLE · new since 10-07: yes  
Reach: default flags (interiorBuildShareEnabled at landblock_stream.js:68-77 is null->true; parse_interior_stab_batch_flag at src/lib.rs:1374 is ON unless =off). It needs a TRUE eviction while a build is running. Under the default warmPark, the LRU reclaim parks (`_reclaim` landblock_lru.js:1483-1486; the sealed purge also goes through _reclaim), and park does NOT fire onEvictLandblock (2317). A real evict only comes from disposeParked under pool pressure: farthest first, a 30 s use-time floor for byte pressure that is bypassed only under geometry pressure (402-415, 1521-1534). Portalling out alone only parks the LB, which keeps both the collision and the populated mark.

- Failure: The player arrives at the Training Academy and portals out while fetchEnvCellsInLandblock is still building. Since 10-09 the per-cell loop yields every 12 ms and pushes CELL_PHYSICS/BSP/STATIC_BSP/portal products for each cell; TickMovement drains them every frame. The LRU evicts the landblock: enqueueClearLandblockCollision runs at the top of the next TickMovement and removes the cells inserted so far, and __onLandblockEvicted clears the populated sets and calls share.forget(lb). Nothing stops the build, so the rest of the cells' products are inserted after the clear. Then this function's await resolves and re-adds the landblock to cellContainersPopulatedLbs (no residency re-check), so the evicted landblock keeps that orphaned collision. On re-entry, cells.js starts a fresh build (forget), which pushes every cell again.
- Fix: Keep a per-landblock eviction generation in landblock_stream (bump it in __onLandblockEvicted), capture it before the await, and skip the populated mark if it changed. Pass the same generation (or an eviction epoch the wasm can read) into the build, so the per-cell loop stops pushing products once its landblock has been cleared. Alternatively, have the TickMovement clear also drop pending products tagged with a stale generation.
- Verifier: The logic holds. After `const placements = await (share ? share.fetch(...) : fetchEnvCellsInLandblock(lbId));` (389-391), the default 3D path marks the LB populated without condition at 446 (`if (wantRenderer3d || window.liveScene3d) { cellContainersPopulatedLbs.add(lbId); }`). There is no generation or residency check. The eviction hook (344-363) clears the sets and calls envCellsShare.forget(lb), but nothing cancels the build.

**STREAM-TERRAIN-4 — TexUpgradeQueue's HTTP-version probe cannot see the records it governs, so h2/h3 origins run the HTTP/1.1 in-flight caps**  
`scene3d/tex_upgrade_queue.js:202` (`_defaultProtocol / TexUpgradeQueue._protoNow`) · low · CONFIRMED · new since 10-07: yes  
Reach: default: texUpgradeQueue (tex_upgrade_queue.js:89-96) and shardFetchWorker (shard_fetch_client.js:62-70) are both default ON, and the singleton is built with no injected protocol (tex_upgrade_queue.js:1515 `new TexUpgradeQueue()` -> `opts.protocol \|\| _defaultProtocol` at 617). It only matters on an h2/h3 origin served from the unbundled index.html.

- Failure: On an h2/h3 origin the main wasm's xu7/hbc7/pre records are fetched inside the shard-fetch worker, so they appear in that worker's performance timeline, not the page's. Bake-worker fetches are in the bake worker's timeline. The page's resource-timing buffer (Chrome default 250 entries, never resized) is already filled by index.html's 434 modulepreloads plus boot assets. _defaultProtocol therefore never finds a /shards/ or /suite/ entry: `_proto` stays null, the probe re-runs every 5 s for the whole session, and _capNow returns {all:3, big:2} instead of the designed {6, 4}. HD legs are admitted at half the intended concurrency.
- Fix: Have the shard worker report nextHopProtocol from its own resource timing (its results message already carries lag/hash stats) and feed that to the queue, or raise the page buffer with performance.setResourceTimingBufferSize at boot.
- Verifier: _defaultProtocol (202-218) scans only the page's `performance.getEntriesByType("resource")` for names containing /shards/ or /suite/. The manifest's shard_url_template is `shards/{sha256_prefix2}/{sha256}.bin`. Those fetches run in the shard-fetch worker on the main instance (shard_fetch_client.js header: index.html registers fetchShard as the main instance's shard fetcher) and in the bake worker's own instance.

Related defects the verifier noticed while checking (not separately verified):

- app/landblock_stream.js:464: `finally { cellContainersPopulateInFlight.delete(lbId); }` runs without checking which build it belongs to. If the LB is evicted mid-await (the hook at :350 clears the in-flight bit) and the player re-enters, a second call adds the bit again. The orphaned first call's finally then deletes that newer bit, so a third concurrent build can start.
- scene3d/terrain.js:5890: refused() puts the baked mark back only `if (baked && old.length > 0)`. For a parked LB (old is empty), the mark stays deleted while the re-bake retries, so on return the terrain loader's unpark fast path (index.js:4166-4177) is skipped and a fresh bake starts against the parked LB.

### Statics, interiors and buildings (`stream-statics`)

statics.js (6.4K) is the outdoor static/scenery baker: the bakeStaticsForLandblock and bakeStaticsRing bakers decode meshes, build singleton/LOD/instanced nodes, route them through static_batch_x.js (cross-LB region BatchedMesh buckets, value-keyed, default-on) and static_atlas.js (array-texture buckets, default-on ?statAtlas), and attach default_script particle chains to anchors (attachStaticDefaultScripts). New default-on behaviour since b8819698: frozen hidden anchors (?staticAnchorFreeze), the emitter radius (?staticScriptRadius=2, hysteresis n/n+1, run by cells.js tickPvsLoadExpansion through tickStaticScriptRadius), part frames for anchors (?staticPartAnchor), hook start_time timers (?staticScriptHookTime), ?degradePose, ?lodCollapseDup, the cull walk gate (?staticsCullGate) and the billboard tick gate. statics.js loads as TWO module instances.

**STREAM-STATICS-1 — Static emitter radius: an LB marked deferred while some of its anchors still have emitters is never torn down, then rebuilt wholesale (duplicate emitters)**  
`scene3d/statics.js:5291` (`tickStaticScriptRadius / attachStaticDefaultScripts / rebuildStaticScriptEmittersForAnchors`) · medium · CONFIRMED · new since 10-07: yes  
Reach: default. staticScriptRadiusSetting() returns 2 when the param is absent (statics.js:5157-5168) and STATIC_SCRIPT_SLICE_ON is on unless ?staticScriptSlice=off (5069-5080). The race needs the radius state to change while one landblock's attach, unpark rebuild or tick rebuild is still in its time slices. The most realistic case: the player crosses into range (the tick starts a sliced rebuild of L at d=2), then crosses back before it finishes (L at d=3).

- Failure: An LB L at Chebyshev distance 2 from the player is attaching its scripted statics (time-sliced). Anchors 1..k run their chains and get live emitters. The player crosses one landblock boundary, so L is now at d=3 (the hysteresis band, where the tick does nothing). Anchors k+1..N then fail `_staticScriptWanted` and run `rs.deferred.add(pLbKey)`. Anchors 1..k are not re-deferred: their post-chain `deferred.has` check ran before the add. L is now in `deferred` with k live emitter chains (and their CallPES loops). (a) The player moves further away (d>=4): the tick's teardown branch needs `!st.deferred.has(k)`, so it skips L, and those emitters keep ticking for as long as L stays resident. (b) The player comes back (d<=2): the rebuild branch passes ALL of L's anchors to `_rebuildStaticParticlesForAnchors`, which re-runs the chains on anchors 1..k.
- Fix: Keep `deferred` meaning 'every anchor of the LB is torn down'. When an attach or rebuild adds an LB to `deferred`, also tear down the anchors of that LB that already have chains (call `_deferStaticScriptAnchors(scene3d, lbKey, anchorsOf(lbKey))` instead of only marking the current anchor), or track per-anchor `__scriptDeferred` and make the tick rebuild only anchors whose flag is true. Better still: let the tick tear down any anchor with `__scriptDeferred !== true` when d > n+1, even if the LB is already in `deferred`.
- Verifier: I traced the code and it does what the finding says. The tick at statics.js:5291 is `if (d > n + 1 && !st.deferred.has(k)) {` (teardown) and at :5295-5297 it is `} else if (d <= n && st.deferred.has(k)) { st.deferred.delete(k); const anchors = anchorsOf(k);`, which rebuilds every anchor of the landblock. So an LB being in `deferred` is taken to mean that every one of its anchors is already torn down.

**STREAM-STATICS-2 — Pending start_time>0 CreateParticle timers survive a radius teardown and attach emitters to a deferred anchor**  
`scene3d/statics.js:5794` (`_scheduleStaticCreate`) · low · PLAUSIBLE · new since 10-07: yes  
Reach: default. STATIC_SCRIPT_HOOK_TIME_ON reads ON unless ?staticScriptHookTime=off/0/false/no (statics.js:5050-5058), and the radius default is 2. It also needs a static default_script with a CreateParticle hook whose start_time > 0. url-flags.md says 427 of 4,248 PhysicsScripts have start_time > 0 hooks, but that 'the statics-only share is unmeasured'.

- Failure: A static whose default_script has a CreateParticle hook with start_time>0 has a create timer pending; a CallPES loop re-arms one on every pass. The player crosses so the LB goes past N+1, and `_deferStaticScriptAnchors` destroys the anchor's current emitters through `ownerRegistry.destroySome` and bumps `ud.__scriptEpoch`. destroySome does not bump the owner epoch, and the timer checks neither `__scriptEpoch` nor `__scriptDeferred`, so it fires and creates an emitter on the deferred, still-attached anchor. A persistent emitter created this way lives on, and when the player returns the rebuild creates another, so that emitter draws twice.
- Fix: Capture `const aEpoch = anchor.userData.__scriptEpoch | 0` in _scheduleStaticCreate. In the callback, return when `(anchor.userData.__scriptEpoch | 0) !== aEpoch || anchor.userData.__scriptDeferred === true`, mirroring _scheduleStaticCallPes.
- Verifier: The missing guard is real. In _scheduleStaticCreate, :5795 is `const epoch = ownerKey !== null ? ownerRegistry._epoch(ownerKey) : 0;` and the timer checks only :5798 `_spDisposed`, :5799 `if (!anchor || !anchor.parent) return;` and :5800 `if (ownerKey !== null && ownerRegistry._epoch(ownerKey) !== epoch) return;`. The radius teardown (_deferStaticScriptAnchors) sets `ud.__scriptDeferred = true;

**STREAM-STATICS-3 — statics.js diag hooks (__lodCollapseDup, __degradePose, __retailDegrade, __staticPartAnchor) read the second module instance, whose counters never move**  
`scene3d/statics.js:445` (`module-level window hooks (lodCollapseDupStats / degradePoseStats / retailDegradeStats / staticPartAnchorStats)`) · low · CONFIRMED · new since 10-07: yes  
Reach: default (the hooks exist on every page). It only affects diagnostics and eye-test readouts. The readouts named in url-flags.md are `__lodCollapseDup.stats()` levelsDropped > 0, `__degradePose.stats()` modelsPosed > 0 and `__staticPartAnchor.stats().anchors > 0`.

- Failure: index.js line 54 imports the bakers from `./statics.js?v=phase7-par` (instance A). cells.js line 93 (imported at index.js:91) and loop.js import `./statics.js` (instance B), which evaluates after A and overwrites every `window.__*` hook. Every bake runs in A, so `__lodCollapseDup.stats()`, `__degradePose.stats()` and `__retailDegrade.stats()` report 0 for the whole session. `__staticPartAnchor.stats()` counts only interior anchors (attached through B from cells.js) and misses every outdoor anchor. An eye test or 1070 probe reading these concludes the features never ran. This is the bug class 8b47d32c fixed for buildings.js and bf474c67 fixed for the radius stats.
- Fix: Keep the counters on globalThis (`globalThis.__hbLodCollapseStats ??= {...}` etc.), as buildings.js now does. Or assign each hook only when unset (`window.__x ??= …`, so the first evaluated instance, A, wins). Or give loop.js and cells.js the same `?v=phase7-par` specifier so the page has one instance.
- Verifier: I worked out the ES-module evaluation order from scene3d/index.js with a static import-graph walker (scratch evalorder.py). `scene3d/statics.js?v=phase7-par` (instance A, index.js:50-54) evaluates at position 85 and plain `scene3d/statics.js` (instance B, pulled in by cells.js:93 through index.js:91, and by loop.js:79-84) evaluates later, at 97. None of index.html's static imports, and none of its dynamic imports other than scene3d/index.js, load statics.js, so nothing changes that order.

**STREAM-STATICS-4 — ?freezeStaticMatrix (default on) freezes only each cell container's own matrixWorld; three r184 still recomposes every descendant every frame**  
`scene3d/cells.js:2603` (`buildEnvCellsForLandblock (FREEZE_STATIC_MATRIX attach)`) · low · CONFIRMED · new since 10-07: no  
Reach: default. FREEZE_STATIC_MATRIX (cells.js:1444-1450) is false only for ?freezeStaticMatrix=off/0/false; otherwise it is true.

- Failure: At a dense interior hub (the documented case: Town Network, cellsGroup ≈ 1,100 of ~2,900 scene nodes, updateMatrixWorld 7.7% of the frame), each visible cell's walls, floors and props still run updateMatrix() (compose) plus a parent-times-local multiply every frame. Only the container node is skipped, so the per-frame saving the flag was shipped for does not happen. skip_hidden_matrix.js prunes hidden cells only, so every visible cell's subtree is walked in full.
- Fix: Freeze the subtree as _freezeStaticScriptAnchor does: after `updateWorldMatrix(true, true)`, `container.traverse(o => { o.matrixAutoUpdate = false; o.matrixWorldAutoUpdate = false; })`. Exclude legacy-path animated interior props parented to the container (resolveParent), whose parts move each frame. They would need matrixAutoUpdate/matrixWorldAutoUpdate left true on that subtree (three still walks a frozen parent's children, so this works), or a separate parent. Then re-measure the Town Network figure the flag was shipped for.
- Verifier: cells.js:2603-2606 is `if (FREEZE_STATIC_MATRIX) { container.updateWorldMatrix(true, true); container.matrixWorldAutoUpdate = false; }`. cells.js never sets matrixAutoUpdate (no match) and never sets matrixWorldAutoUpdate on children (the only other freeze site, :2713, is a one-off `child.updateWorldMatrix(false, true)`). The page loads three@0.184.0 (index.html:986 importmap; node_modules/three 0.184.0).

### Frame and render pipeline (`render`)

preInit3D (scene3d/index.js ~868-1700) builds the one WebGLRenderer (log depth by default; ?reversedZ=on opt-in via shader_logdepth.js), then installs process-wide three r184 patches in order: light_loops + installLightUboChunks (ShaderChunk edits, before any compile), capabilities.maxTextures raised to MAX_COMBINED (boot only), installUniformBindPatch (texUnitPin / lightUbo / lightUploadOnce, all DEFAULT ON; hooks every WebGLProgram's getUniforms via an own `push` on renderer.info.programs), skip_hidden_matrix, async_link_guard (DEFAULT ON, wraps renderer.renderBufferDirect, captures renderer.properties), shadow_caster_list (wraps renderer.shadowMap.render; hosts ?shadowStaticCache), skip_empty_multidraw, draw_sort_program. quality.js now resolves GTX 10x0/16x0 to ULTRA;

**RENDER-1 — After a WebGL context restore the async link guard reads a dead renderer.properties: Mesh*Materials first drawn after the restore never draw**  
`scene3d/async_link_guard.js:329` (`installAsyncLinkGuard`) · high · CONFIRMED, re-traced by the orchestrator · new since 10-07: no  
Reach: default (?asyncLink reader at :45-48 is `!(off\|0\|false\|no)`, so ON when absent). The trigger is any WebGL context loss followed by a restore. The recovery path is live (index.js:5636 installWebglContextRecovery, which preventDefaults the loss) and url-flags.md:344 records about 7 losses per session on the 1070.

- Failure: The context is lost and restored (VRAM pressure at ultra while opening a vendor or wielding). three's onContextRestore -> initGLContext makes a new WebGLProperties and assigns it to renderer.properties, but the guard still holds the old object. For every material the guard has not stamped yet (a newly spawned NPC's per-entity clone, a surface streamed in later), props.get(material) returns an empty entry from the dead map. linkDecision therefore always sees no currentProgram and returns 1 (defer and compile). poll() reads the same dead map and marks the material ready, so the next frame defers it again. The object is never drawn for the rest of the session, and renderer.compile() runs on it every frame. Materials stamped before the loss take the fast path, so they all relink synchronously at once, which is the freeze the guard exists to prevent.
- Fix: Read `renderer.properties` at each use instead of capturing it (`const props = () => renderer.properties`), or listen for webglcontextrestored and re-bind props, clear the stamps (bump a guard epoch that is compared alongside __hbLinkOk) and reset the slow WeakMap, so restored materials go back through the deferred compile. Do the same in draw_sort_program.makeProgramSort (props and info).
- Verifier: The guard captures the WebGLProperties object once, at :329 `const props = renderer.properties;`. three r184 initGLContext runs `properties = new WebGLProperties();` (WebGLRenderer.js:443) and `_this.properties = properties;` (:490), and onContextRestore calls initGLContext (:1115). After a restore, :497 `const mp = props.get(material);` therefore reads the dead map and gets an empty entry for any material it has not seen before.

**RENDER-2 — texUnitPin keeps pinning units 25-31 after a context restore resets capabilities.maxTextures, so three logs a warning on every pinned sampler upload**  
`scene3d/uniform_bind_patch.js:588` (`installUniformBindPatch / api.tick`) · medium · CONFIRMED · new since 10-07: yes  
Reach: default (texUnitPinEnabled :139-147 is ON unless off/0/false/no); triggered by a context restore

- Failure: index.js raises renderer.capabilities.maxTextures to MAX_COMBINED_TEXTURE_IMAGE_UNITS (32 on the 1070) once at boot, and the pins are computed from that (dfgLUT=31, envMap=30, ...). On restore three builds a new WebGLCapabilities, so maxTextures drops back to MAX_TEXTURE_IMAGE_UNITS (16 on ANGLE/D3D11, 32 on native NVIDIA against 191-185 pins). The pins are never recomputed, so every pinned setter's allocateTextureUnit() hits `textureUnit >= capabilities.maxTextures` and calls console.warn. That warn is not warnOnce. It fires once per pinned sampler per material refresh: dfgLUT and envMap on nearly every lit draw, hundreds per frame and tens of thousands per second, until reload. The 2026-10-07 change fixed the same warning at 80/s because it cost frame time.
- Fix: In api.tick() when the programs array changes, re-apply `renderer.capabilities.maxTextures = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS)` (or move the index.js tweak into a webglcontextrestored listener registered after three's own). Also adopt the new array from a webglcontextrestored listener rather than the render tail, so _uboInit and the hooks are in place before the first restored draw.
- Verifier: The pins are computed once: :579 `const maxTextures = (renderer.capabilities && renderer.capabilities.maxTextures) | 0;` and :588 `pinUnits: pinUnitsFor(maxTextures, ...)`, which give the top units (31..25 at 32). The only place maxTextures is raised is index.js:1288-1289, at boot. On restore three builds `capabilities = new WebGLCapabilities(...)` (WebGLRenderer.js:431), whose maxTextures is MAX_TEXTURE_IMAGE_UNITS (WebGLCapabilities.js:104; 16 on ANGLE/D3D11).

**RENDER-3 — Occlusion culler queries go stale after a context restore: each proxy's visible/hidden verdict is frozen, and objects hidden at the time of the loss stay invisible while they remain in view**  
`scene3d/occlusion_cull.js:145` (`OcclusionCuller.beginFrame / _proxy onBeforeRender`) · medium · CONFIRMED · new since 10-07: no  
Reach: default (FLAG :41-48 is ON unless off; armed outdoors by cells.js:3467 `occ.beginFrame(occCam, !isIndoor && !splitArmed)`); triggered by a context restore

- Failure: The player stands outdoors in Holtburg with the shopkeepers inside buildings occlusion-hidden, and the context is lost and restored. Every proxy keeps its WebGLQuery from the dead context, and the culler is not rebuilt (getOcclusionCuller caches by scene and renderer, which do not change). For a pending query, getQueryParameter(deadQuery, QUERY_RESULT_AVAILABLE) fails Chrome's object validation and returns null without throwing, so avail is falsy and queryPending stays true forever. For a non-pending one, beginQuery and endQuery on the dead query only raise INVALID_OPERATION, queryPending is set, and the same thing follows. want() then sets mesh.visible = !queryPending = false (it never re-queries) and keeps returning the frozen p.visible. Any interior cell or NPC rig that was hidden at loss time is not drawn even when it walks out or comes into view through a door.
- Fix: On webglcontextrestored (or when gl.isContextLost() changed since the last frame) drop every proxy's query (`p.query = null; p.queryPending = false; p.visible = true; p.occludedRun = 0`) and bump _armEpoch. Alternatively treat a null or non-boolean QUERY_RESULT_AVAILABLE as 'reset this proxy' rather than 'still pending'.
- Verifier: Neither the module nor its callers handle loss or restore. The culler is cached by scene and renderer identity (:268), and both survive a restore. A pending proxy calls :145 `avail = gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)` on a WebGLQuery from the dead context. Chrome's object validation fails, synthesizes INVALID_OPERATION and returns null without throwing, so the catch-to-true at :145 never fires and queryPending stays true.

**RENDER-4 — ?farFogFence keeps its pixel-pack buffer across a context restore: the horizon sky probe fails three times and turns itself off for the session**  
`scene3d/loop.js:1835` (`_issueFogFence / _harvestFogFence`) · medium (reviewer said low) · CONFIRMED · new since 10-07: yes  
Reach: default (farFogFenceEnabled far_terrain_flags.js:173-183 and farFogSky :150 are both ON by default); triggered by a context restore

- Failure: After a restore the WebGL context is the same JS object, so `f.gl !== gl` is false and the dead f.buf is reused. A fence pending at loss time returns null from getSyncParameter (failure 1). Each later issue does bindBuffer(dead) (INVALID_OPERATION, nothing bound), then readPixels(..., 0) with no PIXEL_PACK_BUFFER (INVALID_OPERATION), and the fence still signals. getBufferSubData then leaves the 0xFFFF sentinel, so _reduceFogProbe throws (failures 2 and 3). _fogProbeDead latches and distance fog falls back to the authored hex for the rest of the session instead of the sampled sky radiance (the horizon mismatch the 2026-08-03 fix removed). The three readRenderTargetPixelsAsync path this replaced made a fresh buffer per read and survived restores.
- Fix: Recreate the buffer when `!gl.isBuffer(f.buf)`, or clear f.buf/f.sync (and reset _fogProbeFails / _fogProbeDead) on webglcontextrestored. Optionally treat a null SYNC_STATUS after a restore as 'drop and reissue' rather than a failure.
- Verifier: :1835 `if (f.gl !== gl || !f.buf)` cannot see a restore, because the WebGL2RenderingContext object is the same after one, so the dead PBO is kept. A fence pending at loss time returns null from :1874 `getSyncParameter`, and :1876-1879 records failure 1. Each later issue does bindBuffer(dead), which Chrome rejects without throwing, so nothing is bound. bufferSubData and `readPixels(..., 0)` with no PIXEL_PACK_BUFFER raise only INVALID_OPERATION, and the fence still signals.

**RENDER-5 — requestShadowRaster does nothing under the per-cascade shadow gate (shadowMoverScope is on by default), so interior cast flips wait for the 12-frame ceiling**  
`scene3d/interior_shadow_cull.js:106` (`requestShadowRaster`) · low · CONFIRMED · new since 10-07: yes  
Reach: flag only: needs ?csm=on or ?shadows=on. csm is false in all four presets (quality.js:161, :326, :431, :534), and index.js:1521-1526 enables shadowMap only for shadows=on or the csm flag. Inside that, shadowMoverScope (lighting.js:494) is on by default.

- Failure: With ?csm=on the camera crosses a doorway while the CSM frustum does not refit (standing still, camera cell flips). cells.js syncs the interior meshes' castShadow and calls requestShadowRaster, which only sets shadowMap.needsUpdate = true. The mover-scoped gate gives every managed light shadow.autoUpdate = false, and three r184 skips any light whose `shadow.autoUpdate === false && shadow.needsUpdate === false`. So no cascade rasters, and the shadow_caster_list wrapper still pays a full-scene collect() walk for nothing. The interior shadows that should vanish (or appear) stay until that cascade's ?shadowMaxStale ceiling, up to 12 frames. If a rig moves meanwhile, ?shadowStaticCache takes the OVERLAY path, because the cast change left no STATIC or FRUSTUM reason, and blits the cached pre-flip statics back.
- Fix: Have requestShadowRaster mark every managed light: `l.shadow.needsUpdate = true; l.userData.hbShadowReason |= 2 /* STATIC */` (scene3d._shadowScope.lights), plus sm.needsUpdate, so the raster happens and the static cache refreshes instead of overlaying stale statics.
- Verifier: requestShadowRaster (:106-111) only sets `sm.needsUpdate = true`. Under the default mover-scope gate, lighting.js:2313 sets `l.shadow.autoUpdate = false;` on every managed light. three WebGLShadowMap.js:170 `if ( shadow.autoUpdate === false && shadow.needsUpdate === false ) continue;` then skips every cascade, so no light rasters. The shadow_caster_list wrapper (:151) still passes its early-out on sm.needsUpdate and does the collect walk for nothing.

**RENDER-6 — Adaptive render scale's boot grace never ends if the scene never reports 'ready', so the controller never lowers the resolution**  
`scene3d/adaptive_render_scale.js:129` (`bootGraceActive`) · low · PLAUSIBLE · new since 10-07: yes  
Reach: default flags (adaptiveResBootGraceEnabled :112-122 is ON by default), but only on a failed atmosphere or SkyDome init

- Failure: atmospherePipeline construction throws (the caught `[sky-k.2/k.3] atmospherePipeline/lights init failed` path in index.js), so `__setBootState('ready')` never runs. __bootStateHistory then has no 'ready' entry, bootGraceActive returns true forever, and every lower and settle latch is suppressed (bootHolds climbs). A GPU-bound player then stays at full render scale for the whole session even though the controller is on.
- Fix: Bound the grace on an alternative clock as well, for example end it 30 s after the first 'in-world' entry or at a hard cap (120 s after construction) when no 'ready' arrives.
- Verifier: The logic holds: :128-129 `const ready = history.find((e) => e && e.state === "ready"); if (!ready) return true;`, with no other clock or cap. index.js:1426 feeds window.__bootStateHistory, which is never trimmed (index.html:4318-4330). The only 'ready' emitters are index.js:6010 (no atmosphere runtime), :6498 (inside the whenReady().then try, after pipeline construction) and :7904 (wireframe).

Related defects the verifier noticed while checking (not separately verified):

- scene3d/loop.js:2370 — once the horizon probe has latched _fogProbeDead, the fog keeps using the stale `_fogProbeLast` sample (`sampleHorizonSkyRadiance(scene3d) ?? _fogProbeLast`) instead of the authored hex that the :1751 warning promises (`falling back to the authored fog hex`). Any death after at least one success therefore freezes the fog colour for the session.
- scene3d/draw_sort_program.js:56-57 — after a restore, `info` is stale as well as `props`: info.render.frame stops advancing, so the per-frame memo check `material.__dspFrame === frame` always hits and the program keys never refresh (sort quality only, no visual effect).

### Sky, atmosphere and terrain shading (`sky-shading`)

Sky, atmosphere and terrain-shading stack, as it runs by default: - loop.js ticks SkyLightingController about 10 times a second (sky_lighting.js). It snapshots wasm getSkyState() into _lastState and frees the box. Everything else reads that one snapshot: atmosphere_sky (raymarched sky, sun pitch remapped by night_ramp.js), atmosphere_lights, cloud_volume and cloud_night, ac_moons, color_grade, luminous_night, retail_fill, and the terrain light tick (retail_light_tick, shared with terrain_rock's pebbles). - The weather tick (loop.js) calls getSkyObjectStates(), passes the result to daygroup_weather.scanWeatherSkyObjects, then frees the wrappers (sky_object_free.js). ?stormScan now defaults to retail. weather_state takes the storm flag, and cloud_volume.tick applies the storm or fair look from cloud_storm_look on a flag edge, after adoption (invalidateCloudLook), or on drift.

**SKY-1 — Layered haze runs after the late particle pass, so particles are hazed by the depth of the terrain behind them (hard seam at the horizon)**  
`scene3d/atmosphere_pipeline.js:1813` (`createAtmospherePipeline (split-chain pass order)`) · medium · CONFIRMED · new since 10-07: yes  
Reach: default at high/ultra. Clouds have been on by default on those tiers since 2026-10-17 (index.js:5814-5818 cloudsTier). cloudsMainPassEnabled is coded !== "off" (atmosphere_pipeline.js:~744). particlesOverCloudsEnabled returns true when the param is absent. layerHazeStrength defaults to 0.4.

- Failure: Ultra, clouds on. A portal swirl, a campfire or a spell projectile 20-40 m from the camera with a valley or hills 1-3 km behind it. Particles use depthWrite:false, so the composer depth texture still holds the distant terrain at those pixels. LayeredHazePass decodes that distance and mixes up to h ≈ 0.3-0.4 toward the haze colour (e.g. background 3 km at altitude ~0 gives far ≈ 0.86, h ≈ 0.34). The effect is washed out toward blue-grey. Where it overlaps the sky (w >= uSkyM, passed through) it stays crisp, so an effect that straddles the horizon shows a hard line. The particle's own fxGlow halo, composited later, is not hazed, so body and glow disagree. This is the same depth-based mis-composite that ParticlesOverCloudsPass was built to remove for clouds and aerial perspective (particles_over_clouds.js header).
- Fix: Haze the scene before the late particles are drawn into T. Either turn the haze into a DEPTH-attribute Effect appended after aerialPerspective/horizonDissolve in atmosEffects, or have ParticlesOverCloudsPass run the haze quad into T before it draws the particles. Keep the current slot for the unsplit chain.
- Verifier: Pass order, read fresh from atmosphere_pipeline.js:1806-1815: `if (layeredHaze && !particlesOverCloudsPass) composer.addPass(layeredHaze); composer.addPass(fxPass); if (particlesOverCloudsPass) { composer.addPass(particlesOverCloudsPass); if (lateScrubPass) composer.addPass(lateScrubPass); ... if (layeredHaze) composer.addPass(layeredHaze); composer.addPass(fxPostPass); }`. So the haze reads the late scrub's copy of T, which already contains the late-drawn particles.

**SKY-2 — SSAO writes a 1.0e6 sky sentinel into an RG16F target (max 65504); drivers that convert overflow to +Inf turn every sky pixel's AO into NaN**  
`scene3d/ssao.js:101` (`SAO_FRAG / BLUR_FRAG`) · medium · PLAUSIBLE · new since 10-07: yes  
Reach: default at high/ultra (ssaoEnabled falls back to the preset's ssao:true, ssao.js:33-44). Every clear-sky pixel takes the sentinel path, because the world pass clears depth to 1.0 and the sky is drawn by a separate skyScene RenderPass (atmosphere_pipeline.js:1204-1218). Whether it misbehaves depends on the GPU/driver.

- Failure: On an implementation that converts an out-of-range float to half as +Inf (IEEE round-to-nearest; Vulkan/Metal leave this implementation-defined), every sky pixel stores G = +Inf. In the H blur at a sky pixel, abs(q.g - c.g) is abs(Inf - Inf) = NaN. Next to geometry, the term is Inf/Inf = NaN. exp(NaN) is NaN, so s/ws is NaN and the blurred AO for the whole sky is NaN. The composite then computes inputColor.rgb * mix(1, NaN, k) = NaN. The late NanScrub blacks those pixels; without it, bloom smears NaN over the frame. Result: a black sky at ultra on such GPUs. It evidently does not trigger on the owner's GTX 1070 (D3D11 appears to saturate), which is why it went unnoticed.
- Fix: Use a finite sentinel within half range (e.g. 6.0e4), or clamp w to 6.0e4 before writing G. Optionally guard the blur weight with `if (c.g > 5.0e4) { gl_FragColor = vec4(c, 0, 1); return; }`.
- Verifier: The code is as described. ssao.js:98 and :101 write `vec4(1.0, 1.0e6, 0.0, 1.0)` into an RG16F target (:186 `type: THREE.HalfFloatType, format: THREE.RGFormat`, half max 65504). The blur at :159 `float wd = exp(-abs(q.g - c.g) * 12.0 / max(c.g, 1.0));` gives NaN when c.g is +Inf: Inf-Inf at sky neighbours, Inf/Inf at the geometry edge. The composite at :289 `inputColor.rgb * mix(1.0, ao, k)` then propagates it.

**SKY-3 — The camera-switch path in render() never retargets ssaoPass or layeredHaze (setCamera() has no callers), so in topDown both run with the stale perspective camera**  
`scene3d/atmosphere_pipeline.js:2368` (`pipeline.render / setCamera`) · low · CONFIRMED · new since 10-07: yes  
Reach: default: CAMERA_MODES = ["follow", "topDown", "orbit"] (camera.js:195), so the first C press switches activeCamera to the ortho camera (camera.js:1122-1126). index.js:2917 calls atmospherePipeline.render(activeCam, dt).

- Failure: Press C to enter topDown. render(activeCam) retargets the world, cells, AP and fx passes, but SsaoPass.camera and LayeredHazePass.camera stay the perspective camera. The ortho camera writes LINEAR depth (three only writes log depth for perspective cameras). SSAO decodes it with the perspective log formula and that camera's projection, producing AO from bogus positions (w ≈ 0.67 m for ground 300 m below). The guard meant for this case (`!this.camera.isPerspectiveCamera` → skip, haze strength 0) never fires. Even after a correct retarget, SsaoPass's ortho early-return leaves rtA holding the last perspective frame's AO, and SsaoCompositeEffect keeps applying it at full strength. Visual impact is small (mild AO noise in the minimap view); this is the R4#7 retarget class again for the two new passes.
- Fix: In render()'s `cam !== activeCamera` branch add `ssaoPass?.setCamera?.(cam); layeredHaze?.setCamera?.(cam);`, or route both paths through one helper. In SsaoPass, keep a `skipped` flag that the composite reads to drop strength to 0 on frames the AO did not run (ortho, no depth).
- Verifier: render() at atmosphere_pipeline.js:2368-2377 retargets worldRenderPass, cellsRenderPass, aerialPerspective, the three mask passes and retargetFxPass(cam), but not ssaoPass or layeredHaze. setCamera() at :2474-2486 does both (`ssaoPass?.setCamera?.(cam); layeredHaze?.setCamera?.(cam);`), but rg finds no production caller; the only callers are tests/film_hooks.test.mjs:1135/1142 plus a comment in cloud_overlay.js:872.

**SKY-4 — ?cloudCoverage (and __setCloudCoverage set before adoption) is overwritten by the cloud look: dead unless ?cloudWeather=off**  
`scene3d/cloud_storm_look.js:136` (`applyCloudLook`) · low · CONFIRMED · new since 10-07: no  
Reach: flag: ?cloudCoverage=<n> without ?cloudWeather=off (readCloudWeatherAutoFlag is ON unless the param is 'off', cloud_volume.js:62-75). This includes film's `--weather=live --coverage=X` (session.mjs:131-132 emits cloudCoverage without cloudWeather=off; film_cli.test.mjs:394 asserts this). The default film boot (fair weather) adds cloudWeather=off and is unaffected.

- Failure: Boot with ?clouds=on&cloudCoverage=0.8. index.js sets effect.coverage = 0.8 right after the overlay is built. On the first CloudVolume.tick, _stormLookApplied is undefined, so _applyLook(storm,'boot') runs applyCloudLook, which writes effect.coverage = 0.5 (fair) or 0.55 (storm). Since be1a4663 adoptMainPass also calls invalidateCloudLook('adopted'), so a coverage set from devtools before adoption is reset again. The sky renders at 0.5 whatever the URL says. A film take requested with --weather=live --coverage=0.8 gets default coverage. cloudLayersMatchLook's own comment says coverage is deliberately excluded because 'the look must not fight a knob', yet every apply writes it.
- Fix: Keep a coverage override on the volume (set from ?cloudCoverage and __setCloudCoverage) that applyCloudLook honours instead of the look's default, or re-apply the URL coverage after every _applyLook.
- Verifier: Sequence: cloud_overlay.js:194 `applyCloudLook(this.volume.effect, false)` at construct, then index.js:5853 `effect.coverage = Math.max(0, Math.min(1, coverageParam));`. On the first CloudVolume.tick with state (cloud_overlay.js:829 → cloud_volume.js:416-423), `_stormLookApplied` is undefined (initialised at :269), so `_applyLook(storm, 'boot')` runs applyCloudLook.

**SKY-5 — With ?nanScrub=off on the split chain, the layered haze output is discarded: fxPostPass reads the late target T, not the buffer the haze wrote**  
`scene3d/atmosphere_pipeline.js:1765` (`createAtmospherePipeline (split chain, nanScrub off)`) · low · CONFIRMED · new since 10-07: yes  
Reach: flag: ?nanScrub=off (the reader at :1709-1713 is `!== "off"`, so the scrub is on by default), combined with the default split chain at high/ultra.

- Failure: ?nanScrub=off at ultra. fxPostPass is built as PostChainSourcePass(camera, particlesOverCloudsPass, ...), which renders from late.renderTarget (T). LayeredHazePass sits between the particle pass and fxPostPass and reads composer.inputBuffer. That buffer still holds the pre-atmosphere world pass, because fxPass and the particles wrote to T. The haze writes outputBuffer, and fxPostPass ignores it and reads T. The haze silently disappears and still costs a full-screen pass, so an A/B of nanScrub also toggles the haze.
- Fix: When nanScrub is off, build fxPostPass with latePass=null and add a plain copy pass from T, or let LayeredHazePass take the late target as its source (the SKY-1 fix moves the haze into T and resolves this too).
- Verifier: With nanScrub off, :1764-1766 builds `fxPostPass = new PostChainSourcePass(camera, particlesOverCloudsPass, ...postEffects)`. PostChainSourcePass.render (:536) calls `super.render(renderer, late ? late.renderTarget : inputBuffer, ...)`, so it reads T. Buffer trace: there is no first scrub, and ssaoPass (needsSwap=false), fxPass (pinned needsSwap=false, writes T) and the particle pass (needsSwap=false) leave composer.inputBuffer holding the world-pass image.

**SKY-6 — ColorGradeEffect.update allocates about 18 short-lived objects every rendered frame (blendGrade)**  
`scene3d/color_grade.js:167` (`ColorGradeEffect.update / blendGrade`) · low · CONFIRMED · new since 10-07: yes  
Reach: default: colorGradeEnabled returns true when ?grade is absent (color_grade.js:38-48). createColorGradeEffect is in both chains (atmosphere_pipeline.js:1562, 1756, 1792).

- Failure: Each frame blendGrade builds the m3 closure, the `one` array, five `[0,1,2]` literals with five .map results and five callback closures, plus the result object: about 18 allocations per frame, roughly 1-2.6k objects/s at 60-144 fps on the default path. This is the GC-churn class fixed in R4#4/R4#9 elsewhere in the sky stack. The night fraction only moves at dusk and dawn, so almost every frame recomputes identical values.
- Fix: Blend straight into the uniform Vector3s with scalar lerps (no arrays or closures), or skip the blend when _night and the param objects have not changed since the last frame.
- Verifier: color_grade.js:104-118 blendGrade allocates: the m3 closure, `const one = [1, 1, 1]`, and for each of 5 m3 calls a `[0, 1, 2]` literal, a .map result and an arrow callback, plus the returned object. That is about 18 allocations per call. It is called unconditionally from update() at :167 `const p = blendGrade(this.day, this.night, this._night);`.

**SKY-7 — terrain_dirt footfall rate-limit map (lastStepAt) is keyed by entity guid and never pruned**  
`scene3d/terrain_dirt.js:1235` (`terrainFootfall`) · low · CONFIRMED · new since 10-07: no  
Reach: flag-only, NOT default. initTerrainDirt returns null unless terrainDirtEnabled() (terrain_dirt.js:1460). That reader is a strict opt-in that falls back to the preset's terrainDirt = terrainMaster('dirt', tier), and quality.js:54 has TERRAIN_VFX_PROMOTED.dirt: false, so it is false on all four tiers. It needs ?terrainDirt=on, after which terrainFootfall is on at mid+ from the preset.

- Failure: Every distinct guid that ever kicks up a puff near the player adds a permanent lastStepAt entry. Monsters respawn with fresh guids, so a long hunting session keeps growing the map: thousands of entries, with no delete or clear outside teardown. Bounded by guids seen, but it never shrinks.
- Fix: Drop entries older than puffMinIntervalSec during a periodic sweep (e.g. every few seconds), or cap the map size and evict the oldest entries.
- Verifier: terrain_dirt.js:1202 `const last = _dirt.lastStepAt.get(key);` and :1235 `_dirt.lastStepAt.set(key, tSec);`. The map is created at :1485 `lastStepAt: new Map(),` and dropped only on teardown (:1611 `_dirt = null`). rg shows no delete or clear, so the code claim is right. The reviewer's reach is wrong: the dirt family master ships OFF (vfx_flags.js:1040-1050 comment 'false on all four tiers this wave'). Entries are only added for guids whose step produced a kept puff near the player.

### Entity layer (rigs, animation, camera, picking) (`entities`)

EntityManager (scene3d/entities.js, ~20K lines) is the one rig layer. loop.js drains wasm EntityUpdates into spawn / setPose / setMotion / attachChildToParent / leaveWorld / remove (`_armRemove` calls noteWireRemove, then the death hold), and drainRemotePoses feeds applyManagedPose. A row for a guid with no rig is now parked as "managedPose" in the pre-create buffer and replayed by _drainPreCreate at spawn commit (spawnz/remoteSettle, default ON). spawn() is async. It keeps a re-sent portal CreateObject in place (portalRecreateInPlace), otherwise remove() + rebuild. It builds rigs from AnimationCache entries (animation.js). getLink (linkOnlyBake, default ON) bakes a link with no geometry, and every entry now carries exitHooks (hookFrameExit, default ON). Animation is driven by one Rust MotionSequence playhead per rig (_unifiedSeq for one-shots, _unifiedLoco for the cycle).

**ENTITIES-1 — Internal respawn of the selected target (appearance fallback, same-guid re-create) reads as a deselect: CancelAttack sent and the attack repeat ended**  
`scene3d/entities.js:13880` (`releaseSelectionOnServerDelete`) · low · CONFIRMED · new since 10-07: no  
Reach: default. Every remove() of the selected guid emits the clear. The non-LOD triggers are rare: (a) the applyAppearance fallback, which for a creature effectively needs the hot-swap bake to throw, since newMeta keeps the setupId, so a part-count mismatch practically only hits LOD-substituted single-part rigs; (b) a same-guid CreateObject while the guid is still in entityMap. ACE re-sends that through PhysicsObj.enqueue_objs -> Player.TrackObject for a newly-visible, still-known object, with no delete before it.

- Failure: In melee stance with an auto-repeat attack on selected creature X: an ObjDescEvent for X falls back to remove()+spawn() (hot-swap returns false on a part-count mismatch, or its bake throws), or ACE re-sends X's CreateObject for the same guid (spawn() :4551 `this.remove(guid)`). remove() calls releaseSelectionOnServerDelete(X), which emits selectionChanged {guid:0, prevGuid:X, lodRespawn:false}. picking.js onSelectionCleared then treats it as a deliberate deselect: it calls cancelClientMove(), sets attackRepeat.endRepeat() and sends sessionHandle.cancelAttack(). ACE stops the swing loop, yet _tickSelectionRules re-selects X one tick later. The player sees the target stay selected while the swings stop. This is the 2026-10-11 LOD-respawn regression ("Action cancelled!") in a non-LOD path.
- Fix: Generalise `_lodRespawnGuid` into an `_internalRespawnGuid` and set it around the remove() in applyAppearance's fallback and in spawn()'s same-guid rebuild, as _respawnForLod does. Alternatively, emit `lodRespawn:true` (or a new `internalRespawn:true`) whenever a spawn for the same guid starts right after the remove.
- Verifier: Traced end to end. releaseSelectionOnServerDelete (entities.js:13841) emits `lodRespawn: (this._lodRespawnGuid >>> 0) === g` at :13880. Only _respawnForLod sets the marker: :16664 `this._lodRespawnGuid = g;` and :16665 `try { this.remove(g); } finally { this._lodRespawnGuid = 0; }`. applyAppearance's fallback at :13249-13251 (`newMeta._internalRespawn = true; this.remove(g);

**ENTITIES-2 — Re-selecting a target after its same-guid respawn overwrites prevSelectedID with 0**  
`scene3d/entities.js:9016` (`setSelectedTarget / _tickSelectionRules`) · low · CONFIRMED · new since 10-07: yes  
Reach: default. ?targetCycle is on unless =off (entities.js:4149-4153). Select Previous Selection is bound to KeyP (ui/selection_keys.js:90). T9 LOD respawns hit selected single-part props and items (the 10-11 'Pumpkin Buffer' case); internal respawns of any selected guid do the same.

- Failure: Select monster B, then select ground item A (a single-part setup with a degrade chain, the common T9 LOD-swap case). Walk until A crosses a degrade band. _respawnForLod: remove(A) runs releaseSelectionOnServerDelete, which sets _selectedGuid=0 and _prevSelectedGuid=A. The next tick re-selects A through _commitSelection(A) → setSelectedTarget(A). That sees a change from 0 and stores _prevSelectedGuid = 0. Select Previous Selection (0x1000002E, selectPrevious) now does nothing instead of returning to B. If A is later deselected, the SelectNext anchor fallback to prevSelected is lost too. Retail keeps the selection untouched for an object that persists.
- Fix: In releaseSelectionOnServerDelete, remember the pre-release prevSelected (e.g. `this._selRemovedPrev = this._prevSelectedGuid`). In the _tickSelectionRules re-select branch, restore `_prevSelectedGuid` after `_commitSelection(gone)`. Simpler: skip the prev write in setSelectedTarget when `next === this._selRemovedGuid` is being re-selected.
- Verifier: releaseSelectionOnServerDelete at :13850-13858 sets `this._selectedGuid = 0; ... this._prevSelectedGuid = g; this._selRemovedGuid = g;`. _tickSelectionRules :9946 `if (shouldReselectAfterRemoval(this.entityMap.get(gone))) this._commitSelection(gone);` then calls setSelectedTarget(A). Its change branch at :9012-9016 runs `if (((this._selectedGuid >>> 0) || 0) !== next) { this._prevSelectedGuid = (this._selectedGuid >>> 0) || 0;` while _selectedGuid is 0, so prev becomes 0.

**ENTITIES-3 — setMotion's post-await liveness check is `.has(guid)`, so a stale motion commits onto a disposed rig after a same-guid respawn**  
`scene3d/entities.js:12664` (`_setMotionImpl`) · low · CONFIRMED · new since 10-07: no  
Reach: default: any setMotion whose cycle, link or hop bake is pending while the guid is torn down and rebuilt under the same id (spawn() same-guid branch :4549, applyAppearance fallback, T9 LOD swap). The race window is narrow.

- Failure: A setMotion on rig R1 awaits animationCache.get / linkP / hopsP (cold bake). Meanwhile a T9 LOD swap or the appearance fallback runs remove(g) (R1.dispose() frees and nulls _unifiedSeq/_unifiedLoco/_unifiedQueue) and spawn() commits R2 under the same guid. When the bake resolves, `this.entityMap.has(g)` is true (R2) and `inst._motionToken` is R1's own unchanged token, so the commit proceeds on R1. _playLinkEntry / _installUnifiedLoco build new wasm MotionSequence objects and hang them on the disposed R1. Nothing frees them; they wait for the FinalizationRegistry. R1 also gets _committedMotion and onMotionApplied diag calls. This is the hazard form the brief names; `_isLiveInstance` already exists for it.
- Fix: Replace the check with `if (inst._disposed || this.entityMap.get(guid >>> 0) !== inst) return;` (the R2#9 `_isLiveInstance` form), and do the same at :14559 / :14643.
- Verifier: After the awaits at :12658-12660, the only liveness checks are :12664 `if (!this.entityMap.has(guid >>> 0)) return;` and :12665 `if (inst._motionToken !== motionToken) return;`. R2 is a new EntityInstance with its own token, so R1's token still matches and `.has` is true for R2. The commit runs on disposed R1. _playLinkEntry (:14599) and _installUnifiedLoco (:11004) call MS.fromDescriptor and attach new MotionSequences to R1._unifiedQueue / R1._unifiedLoco.

**ENTITIES-4 — Script-sourced CallPES re-queues onto the captured old rig after a same-guid respawn (identity check is `.has`)**  
`scene3d/entities.js:16131` (`_executeScriptHook (hookType 19)`) · low · PLAUSIBLE · new since 10-07: no  
Reach: default: SCRIPT_QUEUE_ON reader `.get("scriptQueue")?.toLowerCase() !== "off"` (:2305-2310), and ?callPesLoop is default on. It needs fetchPhysicsScript(callDid) to stay pending across a whole remove()+spawn() of the owner. For a self-loop the DID is already in the resource source, so the fetch likely resolves within microtasks, while the guid is still absent from entityMap, and gets dropped. Only a cold sub-script DID races a fast respawn.

- Failure: Take a self-looping PhysicsScript, such as a portal swirl or an ambient loop that CallPES-es itself. One iteration's fetchPhysicsScript is still pending (cold DAT) when the owner guid is removed and respawned (LOD swap, appearance fallback, portal rebuild under `?portalRecreateInPlace=off`). It resolves after the new rig commits: `.has(gKey)` is true, so _queuePhysicsScript(gKey, rig, ...) queues the sub-script on the new owner's queue with the OLD, detached root. Its emitters spawn invisibly under the dead root and the loop keeps re-queuing itself there, on top of the new rig's own loop, until the guid despawns again. The hook-19 animation arm got the identity fix on 2026-10-08 (anim-hooks-3, :18609 `this.entityMap.get(guidU) !== inst`); this twin did not.
- Fix: Capture the owning instance when the hook fires and check `this.entityMap.get(gKey) !== ownerInst || ownerInst._disposed` before queuing. Also queue onto `ownerInst.root`, not a captured `rig`.
- Verifier: The guard form is real: :16131 `.then((sub) => { if (!this.entityMap.has(gKey)) return; ... this._queuePhysicsScript(gKey, rig, callDid, subEntries, subDepth, defaultPartIndex, subStart);` (:16136). The fixed animation-hook arm uses `if (this.entityMap.get(guidU) !== inst) return;` (:18609). Its own comment (:18597-18601) says the guid-only check 'attached the old object's effect to it' (the NEW object). The stated failure mechanism is wrong, though.

**ENTITIES-5 — AnimationCache.getLink (new, default ON) never frees the EntityAnimationData box from fetchMotionLinkKeyframes**  
`scene3d/animation.js:1061` (`AnimationCache.getLink`) · low · PLAUSIBLE · new since 10-07: yes  
Reach: default: ?linkOnlyBake is on (entities.js:549-559, read at :4312). _fetchLinkEntry (:14526/:14540) routes every link bake through getLink. It runs once per distinct link key (LRU-cached), not per frame.

- Failure: Each distinct link bake (setup × mtable × stance × from × to) gets an EntityAnimationData wasm-bindgen box. getLink reads it through cloning getters and drains takeHooks(), but never calls animData.free(). The Rust-side keyframe/descriptor vectors stay in wasm linear memory until the JS GC happens to finalize the wrapper, if it ever does. A play session bakes hundreds of links (every swing, cast gesture, stance and missile substate link per creature type), so wasm memory holds dead link payloads. get() has the same omission (pre-existing).
- Fix: After _motionFields (and, in get(), after takePartMeshes/rest-pose reads), call `try { animData.free?.(); } catch (_) {}`. Every field is already copied into plain JS (partFrames/frameTimes getters clone, hooks are snapshotted, rootMotionNet uses Float32Array.from).
- Verifier: True that there is no explicit free. getLink (:1020-1075) gets `animData = await fetchLink(...)` (:1035), reads scalars, calls `_motionFields(animData, ...)` (:1061) and returns a plain entry. animation.js has no animData.free(); the only frees are partMesh.free (:687), h.free (:968) and payload/batch (:1258/:1263). get() (:551-751) has the same omission, and its comment says the design relies on GC ('so the wasm-side EntityAnimationData can be GC'd'). The 'leak' framing overstates it.

Related defects the verifier noticed while checking (not separately verified):

- scene3d/entities.js:19726 _fireCreateParticleHook rechecks `if (!this.entityMap.has(inst.guid >>> 0)) return;` after `await fetchParticleEmitter`, then parents the emitter to the captured `inst.root` (:19752). After a same-guid respawn inside that await (e.g. the hook fired just before a T9 LOD swap or a same-guid CreateObject), the emitter is attached to the disposed R1 root and keeps simulating invisibly until the guid's next removal. This is the ENTITIES-3/4 class and the actual 'emitters under the dead root' case. Blame 27ef80c4 (2026-05-28); the R2#9 identity fix covered play_effect_vfx only.
- scene3d/entities.js:12309 the death-motion bake uses the same `.has(guid)` + token form after `await this.animationCache.get`. Exposure is lower because LOD swaps and re-dresses skip `_deathAt` rigs; only a same-guid CreateObject of a dying creature would reach it.

### VFX, particles and audio (`vfx-audio`)

Particles: ParticleManager (scene3d/particles/particle_manager.js) has two instances, the world/entity one (entities.js) and the static one (statics.js, ticked by the _spLoop rAF through tickFrame). Emitters are added through owner_registry.js, which handles tombstones, epochs and the PLIFECYCLE-3 natural-retire callback. Every emitter carries a particle_fx profile row (particle_fx_profiles.js, generated; 64% of retail emitter DIDs carry a tier-1 light). The instanced buckets (default ON) draw with the particle_fx shader. Two programs, with the tier-1/tier-2 variants latched at the first material. Slot meshes are scene-detached carriers. Tier 1 (fx_tier1.js; mid/high/ultra presets ON, low OFF): _bindTier1 gives each lit emitter a light carrier in fx_lights.js and a distortion source in fx_distort.js.

**VFXAUDIO-1 — A flash evicted by the 10-flash cap stays in scene3d.activeLights for the rest of the session, and still takes light-pool slots ahead of every static lamp**  
`scene3d/vfx/fx_lights.js:291` (`spawnFxFlash`) · high · CONFIRMED, re-traced by the orchestrator · new since 10-07: yes  
Reach: default. fxLights is on in the mid/high/ultra presets (fx_tier1.js:36-38, and the fallback at :86 is the mid preset). _fireTier1Cue (play_effect_vfx.js:3674-3689) fires on every dispatched PlayEffect with no distance gate. Hitting the cap needs 11 flashes live at once (busy group combat or a town), but no flag.

- Failure: Eleven or more cue flashes are live at once (each lasts ~0.1-1.8 s). This happens in group combat, in a town where several players buff, or when a burst of queued PlayEffects lands between two tickFxLights frames. spawnFxFlash then calls _release(oldest). _release only sets released=true and intensity=0 and deletes the flash from _flashes. It never calls _removeFromActive and never queues _pendingRemoval, and tickFxLights only walks _flashes, so the evicted FxLightSource stays in scene3d.activeLights forever. Scratch repro with the real module (10 flashes, tick, an 11th, tick, wait for every envelope to end): activeLights.length is still 1 afterwards, and that entry has {released:true, intensity:0, __dynamicPriority:true}. Each eviction leaks one more. The leaked flashes keep userData.__dynamicPriority.
- Fix: In spawnFxFlash, evict through the same path as expiry: `if (oldest) { _release(oldest); _removeFromActive(oldest); }`, or use releaseFxLight(oldest). Add a node test that spawns FLASH_MAX+1 flashes, ticks past every envelope, and asserts activeLights is empty. Optionally make _removeFromActive tolerate an array that has been replaced.
- Verifier: The eviction at fx_lights.js:288-292 calls only `if (oldest) _release(oldest);`. `_release` (:348-354) sets released=true and intensity=0 and deletes the flash from _flashes/_emitterLights. It never calls _removeFromActive and never adds to _pendingRemoval. Only releaseFxLight (:357-361) queues _pendingRemoval. The per-frame flash loop (:469-478) walks only [..._flashes], so a flash already pushed into activeLights on an earlier tick (:477) is never visited again.

**VFXAUDIO-3 — Interior static FX lights are not cell-scoped, so they skip the RND-05 room filter and light through walls from rooms the player cannot see**  
`scene3d/particles/particle_manager.js:1709` (`ParticleManager._bindTier1`) · medium · PLAUSIBLE · new since 10-07: yes  
Reach: default. The interior particle layer reader at statics.js:5343-5353 is coded `!== "off"`, so it is on when the param is absent, and interior anchors therefore get renderLayer 1 (:5751-5754). cellLights is default on (lighting.js:721-745, enabled: true). fxLights is on in mid+.

- Failure: _bindTier1 marks a light `outdoor` only for render layer 0. Interior static chains are on layer 1 (statics.js derives it from isCellStaticScriptAnchor), so their carrier gets neither __lbKey nor __cellId. lighting.js selectCellScopedSources treats an unstamped source as an entity/dynamic light that is always in scope. The static Setup lamps of the same interior props are stamped __cellId and dropped when their room is not in the render set; that rule exists to stop the through-wall leak and slot theft (RQ-05). The anchor already carries userData.cellId (statics.js 6207-6210), but the light never gets it. An interior emitter light that is not within 1.5 m of a Setup lamp (lava/fire floor emitters, glyphs, swirls) therefore stays a candidate while its room is hidden.
- Fix: In _bindTier1, read `emitter.parent?.userData?.cellId`. When it is set, pass it through and stamp `s.userData.__cellId = cellId >>> 0` in bindEmitterFxLight, so the carrier is scoped exactly like the interior prop's Setup light. Keep entity emitters unstamped.
- Verifier: particle_manager.js:1708-1709 passes `outdoor: (emitter.renderLayer | 0) === 0`. Interior static chains are on layer 1, so bindEmitterFxLight stamps neither __lbKey (fx_lights.js:342) nor __cellId. selectCellScopedSources (lighting.js:2546-2553) only drops a source by __cellId or __lbKey, and an unstamped source is 'always a candidate'.

**VFXAUDIO-2 — The 2 Hz FX-light dedupe is O(E^2) over every lit emitter in the whole emitter radius, so it causes a periodic main-thread hitch**  
`scene3d/vfx/fx_lights.js:429` (`_dedupeAndRegister`) · low (reviewer said medium) · PLAUSIBLE · new since 10-07: yes  
Reach: default (fxLights on in mid+; _bindTier1 at particle_manager.js:1689-1711 binds every lit emitter with no distance gate). The cost only matters when E reaches roughly 1000 or more lit emitters, which I could not establish.

- Failure: In a town, every lit static emitter inside the static-script radius (5x5 to 7x7 landblocks) sits in _emitterLights. Every 500 ms, _dedupeAndRegister does the following for every emitter: resolvePosition (an _emitterOrigin call plus localToWorld, which walks the parent chain), fxEmitterOnHeldItem, a loop over all nearby non-FX lights, and a loop over `kept`, which grows to about E. All of this runs BEFORE the 48/56 m registration-radius test, so lights hundreds of metres away, which can never register, pay the full quadratic dedupe. Measured with the real module on this laptop (plain resolvers, so the real cost is higher): 1.6 ms at E=500, 6.9 ms at E=1000, 28 ms at E=2000, 64 ms at E=3000, per dedupe tick, against 0.02-0.04 ms for a normal tick. The result is a frame spike twice a second in dense towns, and it grows quadratically with town density.
- Fix: Compute d2 to the light reference first. Mark anything beyond REGISTER_RADIUS_OUT plus the dedupe slack as registered=false/suppressed and skip both dedupe loops. Then do the FX-FX and static dedupe with a coarse spatial hash (1.5 m cells) instead of the linear `kept` scan. Do the same in fxEmitterLightNear (cheap distance prefilter on the cached s.position before resolving).
- Verifier: The structure is as described. :407 sorts every _emitterLights entry. For each one, :414 calls resolvePosition, :418 walks the held-item parent chain, :425-428 scans the nearby statics, and :429-431 scans `kept`. The registration-radius test comes only afterwards (:436-439). Far lights are never suppressed by statics, because _staticPos is filtered to within 60 m (:400-403), so they all go into `kept` and the cost is about E^2/2. The magnitude is not established, though.

**VFXAUDIO-4 — The static portal-anchor registry is pruned only by the fx_showcase scan, so it grows without bound under the low preset and the showcase/set-piece escapes**  
`scene3d/vfx/portal_registry.js:19` (`registerStaticPortalAnchor`) · low · CONFIRMED · new since 10-07: yes  
Reach: flag/preset: the low preset (fxShowcase false, fx_tier2.js:47), ?fxShowcase=off, or ?portalSetPiece=off (reader fx_showcase.js:156-163, default on). On the default path (mid preset, setPiece on) the prune runs.

- Failure: statics.js registers every static default-script anchor whose Setup is a portal (outdoor bake, interior bake, unpark), whatever the flags. Only fx_showcase._scan drops detached anchors, and _scan runs only when fxShowcase is on and the setPiece flag is on. On the low preset, with ?fxShowcase=off, or with ?portalSetPiece=off, every landblock re-bake after an LRU eviction adds new anchor Object3Ds to the module-level Map and none are ever removed. Each one pins its detached anchor subtree (part-frame proxy, userData) for the session.
- Fix: Gate registration on portalSetPieceEnabled() && fxTier2Enabled("fxShowcase"), or call unregisterStaticPortalAnchor from the LRU evict / anchor dispose path. Alternatively, prune detached anchors in registerStaticPortalAnchor itself (cheap sweep when the size passes a threshold).
- Verifier: registerStaticPortalAnchor does `_staticPortals.set(anchor, sid)` (:19), and unregisterStaticPortalAnchor has no callers outside the re-export (fx_showcase.js:174). Registration is unconditional at statics.js:6044 (outdoor), :6217 (interior) and :6304 (unpark). The only prune is fx_showcase.js:730-733 (`if (setPiece) { for (const [anchor, sid] of _staticPortals) { if (!anchor.parent) { _staticPortals.delete(anchor); ...`).

**VFXAUDIO-5 — fx_distort stamps sources with performance.now() but measures ring phase on the film clock, so stepped film takes freeze shockwaves**  
`scene3d/vfx/fx_distort.js:90` (`spawnFxShockwave`) · low · CONFIRMED · new since 10-07: yes  
Reach: flag: ?filmMode=on (default off) during a stepped take. film_clock.js installSources (:308-323) calls setFxTimeSource(msFn), and that installs setFxClockSource (particle_fx.js:534-543).

- Failure: During a stepped film take, FxDistortEffect.update passes fxNowMs() (the film clock) to collectFxDistortSources. spawnFxShockwave and addFxDistortSource stamp t0 with their own _now(), which is performance.now(). When the take renders slower than real time, the film clock lags wall time. A cue's ring then gets phase=(film−wall)/dur < 0, which is never pruned (phase>=1 never happens), and the shader clamps it to ph=0. The result is a frozen full-strength distortion pinch at the impact point, instead of an expanding 0.6 s ring. This contradicts particle_fx.js's note that fx_distort reads fxNowMs.
- Fix: Import fxNowMs from ../fx_clock.js and use it in fx_distort.js _now(), as fx_lights/fx_decals/fx_showcase already do.
- Verifier: fx_distort.js:32-34 `function _now() { return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now(); }`. It does not import fx_clock.js, unlike fx_lights.js:42/:210-212. Both spawnFxShockwave (:90) and addFxDistortSource (:52) stamp `t0: _now()` (wall time). FxDistortEffect.update passes `const now = fxNowMs();` (fx_distort_effect.js:143) into collectFxDistortSources (:147), and that computes `phase = (now - s.t0) / dur;

### App shell (index.html, app/, ui/, diag/, service worker) (`shell`)

Boot: index.html (one big inline module) registers service-worker.js (skipped and unregistered with ?nosw=1), initialises the wasm with matching wasmrev-20261011f stamps (the workers use the same stamp), then calls preInit3D, which installs the always-on window.__diag (scene3d/diag.js attaches every scene3d/diag/*.js surface). It then wires the login form. Login: the submit handler runs start_session and renders the dev #character-ul list. On a manual Connect, or ?autoLogin=1&autoSpawn=select, it also opens the retail character screen (app/character_select.js, which drives the hidden dev list). Per-login widget listeners are retired through an AbortController. app/auto_login.js drives agent/bot logins.

**SHELL-1 — CharacterList names leave the data-name attribute decoded and go into innerHTML unescaped (XSS from a malicious shard)**  
`index.html:5185` (`characterUl click handler (spawn branch) / restore branch / client_events PLAYER_SPAWNED arm`) · medium · CONFIRMED, re-traced by the orchestrator · new since 10-07: no  
Reach: default. characterSelectWanted() (app/character_select.js:59-64) returns !isOff(charSelect) on a manual Connect, and enter() (:366-376) calls btn.click() on the dev-list Spawn button handled at index.html:5165-5187. The client_events.js PLAYER_SPAWNED arm runs on every spawn.

- Failure: The player picks a community shard from the server picker. The page already treats these shards as hostile: ServerName and the serverslist hrefs are escaped. The shard sends a CharacterList whose name is `<img src=x onerror=...>`. renderCharacterList escapes it into data-name, but `btn.parentElement.dataset.name` returns the DECODED string. Clicking ENTER or Spawn writes it raw into loginStatus.innerHTML and the script runs in the holtburger origin. That script can, for example, rewrite the localStorage serverslist cache to send other shards' logins to the attacker's host.
- Fix: Wrap each dataset-sourced name in escapeHtml() at the three innerHTML sites (or build them with textContent). Also the wizard onSuccess at :4920-4921 (only self-typed text).
- Verifier: The render escapes the name but the sinks do not. index.html:4877 has `const cName = escapeHtml(c.name ?? "");`, and :4891 puts it into `<li data-name="${cName}" ...>`. The comment at :4874-4876 even says the browser decodes the entities, so `dataset.name` gives back the raw wire name. That raw value then goes straight into innerHTML at three places.

**SHELL-2 — Retail character screen hangs at "Entering game..." on a CharacterError (nothing sets the 'error' boot state)**  
`app/character_select.js:452` (`initCharacterSelect holtburger:state listener / enter()`) · medium · CONFIRMED · new since 10-07: yes  
Reach: default: the character screen on a manual Connect and on the /logout return (?autoLogin=1&autoSpawn=select)

- Failure: The player presses ENTER while ACE still holds the character in the world, which happens after an unclean close or a quick relog. ACE answers CharacterError 0x0D EnterGameCharacterInWorld and keeps the session. client_events.js only stashes __lastCharacterError and writes loginStatus, which sits under the z-index 8000 black overlay. The screen waits for a holtburger:state 'error' that never comes, so it stays on "Entering game..." with ENTER, DELETE and Create disabled and no message. Fatal codes such as 0x15 server full do the same. Retail shows the ID_CHAR_ERROR dialog and stays usable.
- Fix: In the CHARACTER_ERROR arm, when a spawn is pending (D.spawningCharId != null), clear spawningCharId, re-enable the spawn buttons and dispatch the error. Either call setBootState('error', ...) or have character_select listen for a dedicated event and call showError(characterErrorInfo(code).text) with entering=false.
- Verifier: character_select.js:370-376: enter() sets `state.entering = true; window.__lastCharacterError = null; setStatus("Entering game..."); render(); btn.click();`. The only ways out are the holtburger:state listener at :448-459 (`if (st === "in-world") api.hide(); else if (st === "error" && state.entering) {...}`) and show(). The CHARACTER_ERROR arm in app/client_events.js (:589-634) only sets window.__lastCharacterError and writes loginStatus. It never calls setBootState.

**SHELL-3 — /logout reload drops the server and bridge chosen in the form and auto-logs into the defaults with the old server's password**  
`index.html:4412` (`window.__logOutToCharacterSelect`) · medium · CONFIRMED · new since 10-07: yes  
Reach: default /logout (/logoff) path, for any player whose server or bridge came from the picker or from typing in the fields instead of URL params

- Failure: The player picks a community shard in the server picker, logs in, plays, and types /logout. The reload URL keeps only the existing query string plus autoLogin, autoSpawn and account. server_host, server_port and bridge_url are not persisted anywhere except as URL params, so the form comes back with 127.0.0.1:9000 and ws://127.0.0.1:8080/. auto_login submits the shard's account name and the sessionStorage password to that default endpoint. The player ends up connection-refused, or on a different (local) server, instead of back on their character screen. The remembered-spot and selection keys (server:port) no longer match either. The forced ?autoLogin=1 also switches the page into agent-mode CSS and turns PopupString dialogs into chat lines (popup_string.js popupDialogAgentSession).
- Fix: Also set bridge_url, server_host and server_port on `u` from the live session (window.__hbLoginKey already holds host:port; stash the bridge URL next to it), or keep them in sessionStorage next to hbAutoLoginPassword.
- Verifier: index.html:4412-4417 builds the reload URL from the current location: `u.searchParams.set("autoLogin", "1"); u.searchParams.set("autoSpawn", "select"); u.searchParams.delete("password"); ... set("account", ...)`. Nothing adds server_host, server_port or bridge_url. After the reload, the form's only sources for those fields are bootParams (:4484-4497) and the HTML defaults: :661 `value="ws://127.0.0.1:8080/"` and :676-677 `value="127.0.0.1"` / `value="9000"`.

**SHELL-4 — Always-on __diag.remoteSync keeps a 64-record ring for every remote guid ever seen, never pruned**  
`scene3d/diag/remote_sync.js:137` (`createRemoteSync entryFor / onWirePose`) · medium · CONFIRMED · new since 10-07: no  
Reach: default: installDiag() runs in preInit3D (scene3d/index.js:874), attachRemoteSync is in the default attach list (scene3d/diag.js:647) and has no flag, and entities.js:7101-7116 calls rs.onWirePose for every remote KIND_POSITION setPose

- Failure: In a long session (roaming, or a rynth grind bot killing generator respawns, each a fresh guid), every remote entity that moved gets a byGuid entry. Its `recent` ring fills to MAX_PER_GUID=64 records of about 6-11 fields within a minute of movement, roughly 8 KB per guid. Nothing ever deletes an entry. 5,000 creatures and players seen means about 40 MB of JS heap that only grows until reload. The header's 'bounded rings' claim covers each ring, not the map.
- Fix: Cap byGuid as an LRU (for example 256 guids, moving an entry to the end on touch), or delete on entity despawn from EntityManager's remove path.
- Verifier: entryFor (:133-142) creates `{ guid, ..., recent: [], ... }` and `byGuid.set(guid, e)` for every guid that gets a scored update. onWirePose pushes into it at :192-193 (`e.recent.push(rec); if (e.recent.length > MAX_PER_GUID) e.recent.shift();`, MAX_PER_GUID=64). The only removal anywhere is reset() (:298 `byGuid.clear()`). rg finds no byGuid.delete and no despawn hook in scene3d, app or index.html, and default-on maintPrune removes rigs without touching this map.

**SHELL-5 — Always-on __diag.motion.byGuid keeps an entry (with 20 transitions) for every guid that ever changed cycle**  
`scene3d/diag/motion.js:233` (`attachMotion onMotionApplied`) · low · CONFIRMED · new since 10-07: no  
Reach: default: attachMotion is in the default diag attach list (scene3d/diag.js:633), and entities.js:12747 calls `window.__diag?.motion?.onMotionApplied?.(guid, inst)` on every committed unified-loco cycle install

- Failure: The same growth pattern as SHELL-4, smaller per entry: each guid keeps a `current` snapshot plus up to 20 transition objects (about 2-3 KB). It is never removed, so long sessions with respawning monsters grow the heap without bound. This is the same class as the spawn ledger the pre-4.8 review capped (#11).
- Fix: Bound byGuid with an LRU, or prune on despawn, same as SHELL-4.
- Verifier: onMotionApplied (:221-234) does `let entry = motion.byGuid.get(g); if (!entry) { entry = { guid: g, name, current: null, history: [] }; motion.byGuid.set(g, entry); }`. pushPerGuid (:123-126) caps only the per-guid history at MAX_PER_GUID_HISTORY=20. The only clear is reset() at :589 `motion.byGuid.clear()`, and nothing deletes on despawn (rg byGuid.delete only finds audio/retail_sound_rules.js).

**SHELL-7 — Character-screen preview reads globalThis.localStorage outside a try**  
`app/character_select.js:326` (`schedulePreview run`) · low · CONFIRMED · new since 10-07: yes  
Reach: default code; only triggers when the browser blocks site data, so the window.localStorage getter throws SecurityError

- Failure: With cookies and site data blocked, reading `globalThis.localStorage` throws. show() runs schedulePreview(true) after it has already opened the overlay, so show() throws. index.html's catch logs "[charselect] init failed" while the screen stays up without focus. Every later row click throws again from the 1.2 s preview timer (an uncaught error) and no warm-up starts. Every other storage read in this file is wrapped.
- Fix: Resolve storage with `(() => { try { return globalThis.localStorage; } catch (_) { return null; } })()` before calling loadLastLocation.
- Verifier: :326 `const loc = loadLastLocation(globalThis.localStorage, lastLocationKey({ ...k, charId: id }));` evaluates the getter in run(), outside any try. loadLastLocation (app/spawn_preview.js:67-75) only guards storage.getItem. spawnPreviewEnabled() is on by default (:28-34, !isOff). show() (:461-468) sets `root.dataset.open = "1"`, renders, and then calls schedulePreview(true), which runs run() synchronously. So when there is at least one character, show() throws before the focus line.

**SHELL-6 — Character screen is created once per page, so after an in-page relogin it calls the first login's freed handle and stale closures**  
`app/character_select.js:202` (`initCharacterSelect`) · low · REFUTED · new since 10-07: yes  
Reach: unreachable on current code paths. The cached api only goes stale on a second successful login in the same page, and no path allows that after the character screen exists.

Refuted: The caching is real: :201-202 `if (root?._hcs) return root._hcs;` keeps the first deps. The trigger is not reachable, though. initCharacterSelect has exactly one caller, index.html:4960, inside the submit handler after the handle is installed. The submit handler returns early on `if (activeHandle) return;` (index.html:4538). activeHandle is only nulled by auto_login's fireSubmit (app/auto_login.js:176), the only programmatic submit (:180-184). In select mode auto_login returns at the first char-list (:428-430), so it never fires again after the screen is built. waitForConnectOutcome checks `D.activeHandle?.characterList` before any kick signal (:209). The kick-wait branch skips reconnecting when a handle landed during the wait (:373-383). A superseded attempt's late handle is freed and the handler returns before reaching initCharacterSelect (index.html ~:4587-4591 epoch check). A disconnect reloads the page through auto-reload or EXIT (onExit → location.replace). So it is a latent hazard (deps frozen to the first handle), not a reachable bug.

### HUD plugins, first half (`plugins-a`)

Boot: index.html awaits app/plugin_bar.js initPluginBar (index.html:1936) BEFORE any login code. It loads plugins/index.json and mounts every plugin that exports mount() through ui/bar.js mountBar({ client: null }) (plugin_bar.js:646, bar.js:614). That covers hotbar, barber-panel, buffs-hud, combat-hud, chat-panel, examine-floaty, dye-preview, hover-tooltip and examine-target-watcher. window.__pluginClient is created only after login (index.html:4714), and __pluginClientReady resolves then. So any mount-time `ctx.client ?? window.__pluginClient` is undefined unless it is wired late. Main-panel views (inventory.view, character-info.view, examine-target.view, the social pages: allegiance and fellowship) mount when opened, after login, and read window.__pluginClient directly.

**PLUGINS-A-1 — Hotbar's inventory, landblock and cooldown bus listeners never attach on a normal boot: the bar mounts before login with client:null**  
`plugins/hotbar.js:1762` (`mount`) · high · CONFIRMED, re-traced by the orchestrator · new since 10-07: no  
Reach: default: every page load. app/plugin_bar.js:646 `mountBar({ client: null, root: document.body, slots: barSlots })` runs inside `await initPluginBar(...)` (index.html:1936), well before index.html:4714 `window.__pluginClient = pluginClient;`. Only the playerStatsUpdated reconcile hook is wired late.

- Failure: Log in with a potion stack bound to slot 1 and a healing kit bound to slot 2. (a) Use the kit or drink the potion. ACE sends the shared cooldown, and client_events.js:1611-1618 emits sharedCooldownChanged on the bus, but no hotbar listener exists. No cooldown sweep is drawn on any slot: neither the items-5 per-item overlay nor the rec #84 2.5 s fallback. (b) Drink the potion stack to zero. playerInventoryChanged fires, but onInventoryChanged → pruneStaleItemBindings never runs. The slot keeps the potion icon and no RemoveShortCut is sent; this is the owner-reported 2026-10-07 symptom. Pressing 1 then calls activateItem, which returns false (not owned), so the hotbar sends handle.useObject(deadGuid). (c) If PlayerDescription is drained before the items' CreateObjects, the merge renders those item slots blank.
- Fix: Wire the three subscriptions late, like subscribeStats: `const wireBus = (c) => { if (disposed || !c?.events?.on || bus) return; bus = c.events; bus.on("playerInventoryChanged", onInventoryChanged); bus.on("landblockChanged", onLandblockChanged); bus.on("sharedCooldownChanged", onSharedCooldown); }; if (client?.events?.on) wireBus(client); else window.__pluginClientReady?.then?.(wireBus);` In the disposer, unsubscribe from `bus`. Add one hotbar test that mounts with {client:null} and creates __pluginClient afterwards.
- Verifier: Traced the call chain. buildBarSlotsViaLoader copies module.mount into the slot unchanged (plugin_bar.js `if (includeMount) slot.mount = module.mount;`), and ui/bar.js:614 calls `slot.mount({ client, slot, root, bar })` with client null. hotbar.js:1762 `const client = ctx?.client ?? window.__pluginClient;` therefore resolves to undefined at mount. The subscriptions at hotbar.js:1849-1853 are no-ops: `client?.events?.on?.("playerInventoryChanged", onInventoryChanged);

**PLUGINS-A-2 — The barber page never opens: barber-panel subscribes to startBarber on the mount-time client, which is null**  
`plugins/barber-panel.js:425` (`mount`) · high · CONFIRMED, re-traced by the orchestrator · new since 10-07: yes  
Reach: default: barber-panel is in plugins/index.json:5, is not in BAR_SLOT_SUPPRESS, and its mount is appended to the bar slots and called by mountBar({client:null}). `?barber` reader ui/ac_barber.js:42-43 `return !isOff(params(search).get("barber"));` is ON by default. The trigger is a barber NPC + MMD note or @barbershop.

- Failure: In the world, hand an MMD note to a vanilla ACE barber (Ealdred / Nawaf / Haruko / Bertrand), or use the developer command @barbershop. ACE runs EmoteType.StartBarber → GameEventStartBarber. app/client_events.js:1288 emits `startBarber` on window.__pluginClient.events, but nothing is subscribed, so onStartBarber → openPanel never runs. No barber window appears. Per the file header, the note is consumed and ACE's BarberActive stays set, which is exactly the pre-maps-chargen-barber-1 bug this plugin was added (2026-10-13) to fix. The only other entry point is the debug hook window.__openBarberPanel.
- Fix: Subscribe late: `const wire = (c) => { if (!c?.events?.on || state.unsub) return; c.events.on("startBarber", onStartBarber); state.unsub = () => c.events.off?.("startBarber", onStartBarber); }; if (client?.events?.on) wire(client); else window.__pluginClientReady?.then?.(wire);` Add a test that mounts with {client:null}.
- Verifier: barber-panel.js:425-429: `const client = ctx?.client ?? window.__pluginClient ?? null; state.client = client; try { client?.events?.on?.("startBarber", onStartBarber);`. At mount, client is null, for the same reason as PLUGINS-A-1 (plugin_bar.js:646 passes client:null, and __pluginClient is assigned only at index.html:4714 after login). There is no late subscription.

**PLUGINS-A-3 — The book range watch builds an unfreed BookSnapshotJs, a clone of every page, every 500 ms while a book is open**  
`plugins/book-panel.js:512` (`checkBookRange`) · low · CONFIRMED · new since 10-07: yes  
Reach: default: BOOK_RANGE_CLOSE = bookFlagOn("bookRangeClose") (book-panel.js:59-66), true unless off/0/false. startRangeWatch() runs at the end of every rerender (:686) while a book window is open.

- Failure: Open a 20-page book and leave it open while you play or read. Every 500 ms, checkBookRange calls readSnapshot() → handle.playerBook(). That returns a new wasm-bindgen BookSnapshotJs holding a cloned Vec of every page's text (up to about 20 KB). It is never .free()d, so each copy stays in the wasm heap until the FinalizationRegistry gets to it. That is about 2 boxes a second for as long as the book is open, and the wasm high-water mark only grows. The other readSnapshot callers leak too, but only once per user action.
- Fix: In checkBookRange, copy objectGuid out of the snapshot and free it at once: `const snap = readSnapshot(); const guid = snap?.objectGuid >>> 0; if (snap !== _debugSnap) try { snap?.free?.(); } catch {}`. Better: make readSnapshot return a plain copy (guid, maxNumPages, maxCharsPerPage, inscription, authorName, scribeId, pages) and free the box inside it, like house-panel readSnap.
- Verifier: book-panel.js:367-373 readSnapshot returns `handle.playerBook()` directly. checkBookRange (:512-513) `const snap = readSnapshot();` reads snap.objectGuid and never frees it; the early return for owned books (:516 `if (findInventoryItem(guid)) return;`) happens after the snapshot is created. :554 `rangeTimer = setInterval(checkBookRange, 500);`. In Rust, src/lib.rs:46915-46924 player_book builds a fresh #[wasm_bindgen] BookSnapshotJs (struct at lib.rs:36108) with `pages: b.pages.clone()`.

**PLUGINS-A-4 — Hotbar reconcile and drop paths call playerInventory() and never free the boxes, up to 18 full snapshots per reconcile**  
`plugins/hotbar.js:1624` (`reconcileWithServer`) · low · CONFIRMED · new since 10-07: yes  
Reach: default: reconcileWithServer's wcidOf runs only when a merge happens (once per login, per server item slot). The drop path runs once per item dropped on a slot.

- Failure: A character with 18 server item shortcuts logs in. reconcileSlots calls wcidOf once per item slot, and each call runs handle.playerInventory(): one wasm InventoryItem box per owned item (a 150-item inventory gives about 2,700 boxes in one burst). None is freed, so they wait for the FinalizationRegistry and lift the wasm heap high-water mark. Each drop onto a slot does the same once (line 1409). The rest of this file copies and then frees (lines 1095, 1720, 1796).
- Fix: Take one snapshot per reconcile with takeInventoryRows(handle) (inventory_helpers: copy, then free), build a Map guid→wcid and pass `(g) => map.get(g >>> 0)` as wcidOf. In the drop handler, use takeInventoryRows too.
- Verifier: hotbar.js:1624-1627: `const wcidOf = (guid) => { const inv = handle.playerInventory?.() ?? []; return inv.find((x) => (x.guid >>> 0) === (guid >>> 0))?.wcid; };` has no free. It is called per server item slot from reconcileSlots (:409 `wcid = (typeof wcidOf === "function" ? wcidOf(s.itemGuid) >>> 0 : 0) || 0;`), but only after the early `if (flat.length === 0 && !pdReceived) return null;` (:389).

Related defects the verifier noticed while checking (not separately verified):

- plugins/tinker-panel.js:305-308 has the same null-client bug as PLUGINS-A-1/2. mount does `const client = ctx?.client ?? window.__pluginClient ?? null; client?.events?.on?.("playerInventoryChanged", onInventoryChanged)` with bar client:null (tinker-panel is in plugins/index.json:45). onInventoryChanged (:212-223) never runs: a consumed tool stays in its slot and the 'Done — see chat' status never shows. Only the late state.client read at :183 works.

### HUD plugins, second half (`plugins-b`)

Boot: index.html:1936 awaits app/plugin_bar.js initPluginBar(). That function fetches plugins/index.json (50 manifests; the index matches the disk) through loader.js fetchManifestIndex, then loadPlugins() runs the per-plugin imports concurrently and the lifecycle hooks in order. Import and hook errors are caught per plugin. It then calls ui/bar.js mountBar({client: null}), which calls every slot's mount(ctx) ONCE, before login. window.__pluginClient and __sessionHandle do not exist yet at that point. A plugin therefore has to defer its bus subscriptions to window.__pluginClientReady, which createClient resolves at index.html:4714. vendor-ui, vitals-hud/orbs, status-indicators, target-bar, trade-panel, vitae-detail, social-panel and tradeskill do this. salvage-panel, tinker-panel and landblock-messages do not. Default-on surfaces in this bucket: - vitals-orbs.

**PLUGINSB-1 — Salvage results never arrive: the window subscribes to salvageResult on a null client at boot, so the default-on retail result line (crafting-3) and the Results list are dead**  
`plugins/salvage-panel.js:603` (`mount`) · high · CONFIRMED, re-traced by the orchestrator · new since 10-07: no  
Reach: default. salvage-panel is a loader-built bar slot (plugins/index.json:37; not in BAR_SLOT_SUPPRESS). Players reach it through inventory.js:701-703 (`case "salvage": window.__openSalvagePanel(g)` when using an Ust). The salvageResultChat reader at :485 is `!(v === "off" \|\| ...)`, so it is ON when the param is absent.

- Failure: The player uses an Ust and salvages two items. app/client_events.js:1252 emits `window.__pluginClient.events.emit("salvageResult", …)`. No listener is registered, so onSalvageResult never runs. The retail line "You obtain 12 Iron (ws 5.42) … using your knowledge of Salvaging." never reaches chat, and the window's Results section stays empty for the whole session. The only trace is a console.log.
- Fix: Subscribe lazily, as vendor-ui and vitals-hud do: if the client is null, `window.__pluginClientReady?.then((c) => subscribe(c ?? window.__pluginClient))`, and keep the unsubscribe for the disposer. Add a test that mounts with `{client:null}` and no window.__pluginClient, then resolves the ready promise.
- Verifier: mount runs once at boot. app/plugin_bar.js:646 calls `mountBar({ client: null, root: document.body, slots: barSlots })` from `await initPluginBar(...)` at index.html:1936. window.__pluginClient is first assigned at index.html:4714, inside the login handler, after start_session resolves. At mount, salvage-panel.js:595 `const client = ctx?.client ?? window.__pluginClient ?? null;` is null, so :603 `client?.events?.on?.("salvageResult", onResult);` silently does nothing.

**PLUGINSB-2 — vendor-ui keeps the first session's SessionHandle for its whole life: after an autoLogin kick and retry, vendors never open**  
`plugins/vendor-ui.js:1189` (`mount/tryHook`) · medium · CONFIRMED · new since 10-07: no  
Reach: non-default only: `?autoLogin=1&maxRetries=N` with N>=1 when a kick, timeout or error follows the first installed handle, or an agent re-running `window.__runAutonomousLogin()` in the same page. The reviewer's '/logout -> character-select reload' path is wrong. That is a full `window.location.replace` (index.html:4417), which builds a fresh page, and it sets no maxRetries. auto_login.js:87 `const maxRetries = opts.maxRetries ?? 0`, and :355-356 says the default never reconnects.

- Failure: With ?autoLogin=1, connect #1 resolves handle1. createClient(handle1) resolves __pluginClientReady, and vendor-ui's tryHook captures `handle = window.__sessionHandle` (handle1). ACE then kicks with CharacterError Logon. fireSubmit calls handle1.free() and connect #2 installs handle2, and pluginClient.attachHandle(handle2) rebinds the facade. From then on, every vendorOpened event runs `handle.getVendorState(vendorGuid)` on the freed handle1. wasm-bindgen throws ('null pointer passed to rust'), the listener aborts, and the vendor window never opens; the same goes for every onInvChanged re-pull. Bots and agents on autoLogin cannot use vendor windows for that whole page lifetime.
- Fix: Read `window.__sessionHandle` on each call inside onVendorOpened, pullProfile and onInvChanged (`const h = window.__sessionHandle; if (!h?.getVendorState) return;`). Keep the tryHook gate only for the client.
- Verifier: tryHook (:1187-1190) captures `const handle = window.__sessionHandle ?? null;` once. The closures then call it on every event: :1211 `handle.getVendorState(vendorGuid)`, :1214 the retry, :1197 getCurrentVendorProfile, :1228 in onInvChanged. tryHook runs from `window.__pluginClientReady.then(() => { tryHook(); })` (:1352).

**PLUGINSB-3 — Tinker window stays on 'Working…' and keeps a consumed tool in its slot: its playerInventoryChanged subscription is made on the null boot client**  
`plugins/tinker-panel.js:307` (`mount`) · low · CONFIRMED · new since 10-07: no  
Reach: dev-only. No production code calls __openTinkerPanel or __toggleTinkerPanel; rg finds only tests/commerce_windows_smoke.test.mjs:615. inventory.js routes tinkering tools to the salvage panel instead.

- Failure: The window is opened from the console. The player applies a salvage bag to an item: fireTinker sets pendingFire=true and shows 'Working… the outcome appears in chat.' The server consumes the bag, but onInventoryChanged never runs. The status never changes to 'Done', the consumed bag stays in the Use slot, and updateButtons() keeps the stale status. A second Apply sends useWithTarget with a guid that no longer exists.
- Fix: Defer the subscription to __pluginClientReady, the same fix as PLUGINSB-1.
- Verifier: Same boot-ordering defect as PLUGINSB-1. :304 `const client = ctx?.client ?? window.__pluginClient ?? null;` is null when mountBar({client:null}) runs at boot, so :307 `client?.events?.on?.("playerInventoryChanged", onInventoryChanged);` never subscribes. onInventoryChanged (:212-223) is the only path that clears pendingFire after fireTinker (:206 `state.pendingFire = true`) and drops a consumed tool. While pendingFire stays true, updateButtons (:172) never refreshes the status.

**PLUGINSB-4 — ?lbMessages=on never subscribes: null boot client, and the disposer expects events.on to return an unsubscribe it never returns**  
`plugins/landblock-messages.js:90` (`mount`) · low · CONFIRMED · new since 10-07: no  
Reach: flag:lbMessages=on, strict opt-in. :81 reads `=== "on"`, and :86 makes mount a no-op otherwise.

- Failure: With ?lbMessages=on, the 'Entering Landblock 0x…' chat lines never appear. mount runs at bar boot, when ctx.client is null and window.__pluginClient is undefined, so the subscribe is skipped. Even with a client, `_unsub = client.events.on(...)` stores undefined (api.js events.on has no return value), so the disposer could never unsubscribe.
- Fix: Subscribe on __pluginClientReady, and store a closure `() => client.events.off("landblockChanged", onLandblockChanged)` as the unsubscribe.
- Verifier: At boot, :87 `const client = ctx?.client ?? window.__pluginClient ?? null;` is null, so the `typeof client?.events?.on === "function"` guard at :89 skips the subscribe and nothing retries later. Even with a client, plugins/api.js:484-486 `on(name, handler) { bus.addEventListener(name, handler); }` returns undefined, so `_unsub` stays undefined and the disposer at :97-99 is dead.

**PLUGINSB-5 — WorldObjectManager queues every spawn and delete forever if load() fails once**  
`plugins/world-objects/world_object_manager.js:122` (`onObjectCreated / onObjectDeleted / load`) · low · PLAUSIBLE · new since 10-07: no  
Reach: default path, but only after a one-time fetch or parse failure of data/chorizite/world-object-taxonomy.json (7.8 KB) or chorizite-common-enums.json (485 KB). Both are git-tracked same-origin static files, so this is an environmental trigger.

- Failure: The taxonomy fetch returns 404 or 5xx, or the JSON is malformed. load() throws before `this.loaded = true`, and index.html only logs '[wom] load failed'. Nothing retries load(), and loaded stays false for the page lifetime. Every later KIND_SPAWN/REMOVE (app/landblock_stream.js:1273/1285) pushes its event object onto _pendingCreate or _pendingDelete, so the queues grow without bound during a long roam. Typed classification and the plugin world mirror stay empty.
- Fix: On load failure, set a `failed` flag and clear the queues (or cap them, e.g. drop the oldest past N), or retry load with backoff. Don't buffer once failed.
- Verifier: The logic holds. :95-98 `await this.taxonomy.load(...); await this.enums.load(...); this.loaded = true;`, and taxonomy.js / enums.js throw on `!res.ok` or a malformed body. index.html:4757-4772 calls load once with `.catch((e) => console.error("[wom] load failed:", e))`. Later logins only attachClient (:4774) and never retry.

Related defects the verifier noticed while checking (not separately verified):

- plugins/landblock-messages.js:61-62 onLandblockChanged(detail) reads `detail?.lbId` off the CustomEvent instead of ev.detail.lbId. lbId is always 0 and the handler returns early, so ?lbMessages=on stays silent even after the subscription is fixed. This is the same .detail bug salvage-panel fixed on 2026-10-05.
- app/landblock_stream.js:1270 the comment 'Pre-load spawns silently dropped per manager's loaded-guard' is wrong: WorldObjectManager queues them without a bound (world_object_manager.js:122-124).

### rynth (bot and VTank port) (`rynth`)

On a default URL the bot itself does NOT run. rynth/boot.js boots createGrindBot (rynth/bot.js) only on ?bot=1 (app/client_events.js kind=7) or when the player clicks START in the RynthSuite HUD. The HUD path is reachable from default UI with no flag. These pieces DO run by default: - plugins/rynth-hud.js (manifest-loaded plugin; ?rynthHud=off disables it). It mounts a launcher that polls at 1 Hz and a window that refreshes at 4 Hz while open, through rynth/hud_bridge.js (createHudBridge/buildViewModel; playerStats box is freed). - On every mount the HUD lazily imports rynth/vt/rs_entry.js. That installs window.__rynthVt, the /rs /vt /ra /mt /ub page dispatcher (vt/cmd, no timers), and the per-character VtSession registry (vt/settings: ProfileStore/NamedStore on localStorage). - app/slash_commands.js routes those five prefixes into it.

**RYNTH-1 — Meta setmotion[] keys stay held when the meta is disabled, unloaded or swapped; only an operator hold, portalIn or destroy releases them**  
`rynth/vt/meta/engine.js:684` (`MetaEngine.tick / load / unload / set enabled / _disableMeta`) · medium · CONFIRMED · new since 10-07: yes  
Reach: flag: EnableMeta (schema.js:89 default false) on a running VT bot (HUD START or ?bot=1), with a meta that calls setmotion[]

- Failure: A meta runs `DoExpr setmotion[forward,1]` (the character runs forward). The player then turns the meta off with the VT panel Enable Meta toggle (bridge_route_meta.js:681 `engine.enabled = !!on`) or `/vt meta disable` (rs_commands.js:690). The meta can also turn itself off: a Return with an empty call stack runs _disableMeta. Loading another meta (`/vt meta load X`, or a profile switch that runs library.loadMeta → engine.load) has the same effect. The wasm movement-input state still has forward held, so the character keeps running toward walls or cliffs while the bot is still RUNNING. Only a STOP (the hold edge) or a portal entry releases the key; getmotion[forward] keeps reading 1.
- Fix: Call this._releaseHostEffects(...) in load(), unload() and _disableMeta, and on the enabled→disabled edge in tick(): track `wasEnabled` like `wasRunning`, so the release also happens when EnableMeta is turned off through options.set from the panel or /rs opt.
- Verifier: tick() releases host effects only on the running-to-held edge: engine.js:676-678 `if (!run) { if (wasRunning) { ... this._releaseHostEffects("hold"); ...`. The disabled or unloaded gate at :684-686 `if (!this._meta || !this.enabled) { this._closedGate(now); return; }` only calls _closedGate (:702-706: watchdog pause and drop pending events). The only other release calls are portalIn (:634) and destroy (:962).

**RYNTH-2 — A truncated .nav silently gets a bogus last waypoint at ns/ew/z = 0 with no warning; the VT nav import accepts it**  
`rynth/nav_file.js:230` (`parseNav (take) → vt/nav/nav_profiles.js parseNavVt → route_model.normalizePoint`) · medium · CONFIRMED · new since 10-07: no  
Reach: flag: importing or loading a malformed VTank .nav (NavProfiles import nav_profiles.js:458, ActiveNav.loadEmbedded active_nav.js:387, .af NAVDATA nav_profiles.js:249) in the VT layer; needs truncated input

- Failure: A pasted or copied .nav loses its last few lines, e.g. a 2-point Linear route whose 2nd point ends after its type and EW lines. parseNav's take() reads past the end, so parseFloat(undefined) gives NaN. No exception is thrown, so no warning is set. The partial point is pushed, so points.length equals pointCount and nav_profiles adds no 'file ended' warning either. normalizePoint's finite() maps NaN to 0. The route is accepted as ok:true with 0 warnings and a waypoint at 42.2E, 0.0N, z 0. A scratch repro under the review scratchpad (review/rynth/nav_trunc.mjs) printed exactly that. The bot then walks about 8 km south toward the bogus point until the leg times out and fails, or follows it.
- Fix: In parseNav, make take() throw (or stop with a warning) when idx >= lines.length, and drop the partial point. The existing catch already sets `out.warning = parse error ... stopped`. Optionally have normalizePoint reject non-finite ew/ns instead of defaulting them to 0.
- Verifier: nav_file.js:221 `for (let i = 0; i < pc && idx < lines.length; i++)` checks bounds only at the start of each point. :230-233 `const take = () => { p.raw.push(lines[idx]); return lines[idx++]; };` and :235-238 `p.ew = parseFloat(take()); p.ns = parseFloat(take()); p.z = parseFloat(take()); p.flag = take();` read past the end without throwing. The partial point is pushed, so parseNavVt's `else if (parsed.points.length < parsed.pointCount)` warning (nav_profiles.js:94-96) does not fire.

**RYNTH-3 — .met reader: a zero-column TABLE with a huge row count loops and allocates without bound (tab freeze or OOM from a ~30-byte file)**  
`rynth/vt/formats/met.js:177` (`Reader.table`) · medium · CONFIRMED · new since 10-07: yes  
Reach: flag: VT library .met import (vt/index.js:607-612 importMeta to parseMet, via bridge_route_meta.js:663); needs a crafted file with 0 columns

- Failure: The file `1\r\nCondAct\r\n0\r\n999999999999\r\n` passes the column-count check (0 is allowed). The row loop then runs 1e12 times, pushing an empty array each time, before the 'expected 5 columns' check is reached. The same happens for a nested `TABLE` cell. Measured with a scratch script: 3e6 rows took 0.7 s, linear, so a 9- or 10-digit count hangs the tab for minutes and then OOM-kills it, taking the live game session with it. A bare-LF header parses the body twice (the raw-count retry in parseMet), which doubles the cost.
- Fix: Port usd.js's guard: `if (nr < 0 || nr > this.end - this.p) throw new MetError(...)`. Also reject nc === 0 with nr > 0, since a row of zero values can never come from VTank.
- Verifier: met.js:170-171 `const nc = this.int("column count"); if (nc < 0 || nc > 64) throw` accepts nc=0. :176-177 `const nr = this.int("row count"); if (nr < 0) throw` has no upper bound. Reader.int (:93-98) accepts any digit string. With nc=0, the loop at :179-183 consumes no input per row and pushes an empty array per row. The 5-column root check only runs after table() returns (:741-742). usd.js:160-162 has the missing guard `if (nr < 0 || nr > this.end - this.p) throw`.

**RYNTH-4 — Operator STOP does not abort an in-flight nav jump: attemptJumpLeg keeps turning, holding forward and jumping for up to ~8 s after STOP**  
`rynth/vt/nav/executors.js:433` (`pointExecutor stuck-rung / jumpExecutor / ActiveNav._startJump → goto_compose.attemptJumpLeg`) · medium · CONFIRMED · new since 10-07: yes  
Reach: flag: EnableNavigation (schema.js:85 default false) with a VT route whose Point leg stalls twice (stuckReissues=2), a Jump waypoint (:1029), or /rs jump (active_nav.js:717); bot started from the HUD or ?bot=1

- Failure: A VT nav Point leg stalls twice in a dungeon, so the executor starts a directional jump job (executors.js:433). The player presses STOP ('Hands off — you have control'). OperatorControl._haltMovement sends router.cancel, StopStick and StopCompletely, and the kernel hold makes ActiveNav.yield cancel the executor. The job's async body still runs: - the turn loop re-issues TurnToHeading every poll for up to jumpTurnTimeoutMs (6 s), undoing StopCompletely's stop; - it then calls SetMovementInput(forward, run) for up to 1.5 s and fires Jump(power). So after STOP the character still turns, runs forward and jumps, possibly off a ledge. A HUD Restart or takeover is the same: the old bot's job keeps calling the shared session handle.
- Fix: Pass an `isCancelled()` / AbortSignal in the attemptJumpLeg ctx. Check it before every TurnToHeading, SetMovementInput and Jump step, and on cancel release input with SetMovementInput(0,0,0,false). Wire it to the kernel operator hold, bot.stop and ActiveNav.yield/dispose, so STOP ends the jump within one poll.
- Verifier: executors.js:399 `// The stuck-rung jump job (cannot be cancelled)` and :433 `st.job = runJob(() => gc.attemptJumpLeg({ host: ctx.host }, leg, tune));` pass only the host, with no cancel token. ctx.host is the plain RynthWebHost: webhost.js:1491-1500 `_act` has no hold gate. attemptJumpLeg (goto_compose.js:930-1016) never checks a hold or abort. The turn loop :959-969 re-issues `host.TurnToHeading(headingRad)` (:967) until jumpTurnTimeoutMs (6000, :1533).

Related defects the verifier noticed while checking (not separately verified):

- rynth/goto_compose.js:1859 legacy replayRoute awaits the same uncancellable attemptJumpLeg (pre-existing, same STOP-ignoring turn/forward/jump sequence on the old .nav replay path)
- rynth/vt/nav/route_model.js:64 normalizePoint's finite() silently maps NaN ew/ns/z to 0 for every caller (also .af/JSON route imports), so any non-numeric coordinate becomes a waypoint at 0N/0E with no warning

### Film mode (default off) (`film`)

Default URL: no film code runs. Only one film module is in the boot graph: scene3d/film/flags.js, which statics.js imports and index.html modulepreloads. It is a pure memoised reader (`get("filmMode") === "on"`, exact match, try-wrapped), and its only default-path use is statics.js:4692, which turns off the statics cull gate when film is on. Nothing in scene3d/film/** runs anything at import time: no window/document writes, listeners, timers, keybindings or prototype patches. The runtime loads only through scene3d/index.js:4632 `if (get("filmMode") === "on") Promise.all([import("./film/index.js"), import("./particles/particle_manager.js")])`.

**FILM-1 — The wall-exit cell escape added on 10-16 turns a dungeon camera's viewer cell into an outdoor landcell, so cells.js hides the whole dungeon for the rest of the take**  
`scene3d/film/runtime/camera_owner.js:466` (`walk / cellFromLandscape`) · medium · CONFIRMED · new since 10-07: yes  
Reach: flag: ?filmMode=on (reader scene3d/index.js:4632 `get("filmMode") === "on"`, default OFF). Any dungeon take where the walk does not reach the eye: the camera starts 2+ portal hops from the seed cell, or the unclipped film eye crosses a wall or a non-resident neighbour by more than 1 m

- Failure: An indoor dungeon site. The compiler gives the take `cell` = the site anchor cell (compile.mjs:600; SPEC:680 'seed of the film viewer cell on indoor sites'), and the camera starts two or more portal hops from that cell: a corridor dolly, an fpv-corridor route that starts at route.fromCell, or a wide orbit in a hall made of several cells. 1. runStepped sets setCutCell(plan.cell) (take_player.js:3177). carryCell seeds state.cell = the anchor cell without checking that the eye is inside it (camera_owner.js:519). 2. On the first moving frame, walk() calls resolveViewerCell(a, b, 0.3, anchor). In the Rust scene.rs:5825, `resolve(carried, start).is_none()` is true because the eye is neither in the anchor cell nor in a portal neighbour of it, so the call returns the seed unchanged. 3. outsideIndoorCell(anchor, b) is true: the eye is more than 1 m outside the anchor cell's mesh box.
- Fix: Accept the landscape answer only when it is an indoor (building) cell, or when the carried cell can be seen from outside. sessionHandle.isCellSeenOutside(cell), which cells.js already uses, separates building interiors from dungeons. Otherwise keep the walk's cell. In addition, on a cut to an indoor plan cell whose box does not contain the eye, search that cell's resident portal neighbourhood (cellContainers3d boxes) for the cell that contains the eye. For route takes, seed from take.route.fromCell instead of the anchor cell.
- Verifier: I traced the whole chain. camera_owner.js:519 `state.cell = state.pendingCut >>> 0;` seeds the cut cell (plan.cell = `s.cell ?? (site.indoor ? site.cell : null)`, compile.mjs:600) without checking that the eye is in it. walk() at :454-475 runs resolveOnce and then, at :466, `if (outsideIndoorCell(cell, b)) { const o = cellFromLandscape(h, b); if (o !== 0 && o !== cell) { cell = o; ...` with no dungeon or seen-outside check.

**FILM-2 — Stepped takes below 10 fps run the world at fps/10 speed: the film clock is floored at 10 fps while the camera, the recording and the time-lapse use 1/fps — and the CLI rehearses every shot at 8 fps**  
`scene3d/film/runtime/take_player.js:3167` (`runStepped`) · low · CONFIRMED · new since 10-07: yes  
Reach: flag: ?filmMode=on, stepped takes or rehearsals with fps < 10. The CLI rehearses at 8 fps by default (tools/film/film.mjs:1338 `numArg(args, "rehearse-fps", 8, {min:1,...})`, shoot.mjs:1125). The plan schema allows format.fps 1..120 (schema.mjs:1088)

- Failure: rehearse({fps:8}), the CLI default, or a plan with format.fps 5. clockFps = clamp(8, 10, 240) = 10. Each step: tsMs advances 100 ms (film_clock.js:512), so tick dt and the particle, FX, scenery and sky time sources move 0.1 s. Meanwhile the camera progress, the recorded timestamps and t = k/R.fps move 0.125 s (fps 8) or 0.2 s (fps 5). The sky time-lapse uses filmMs = frame * st.interval (100 ms per frame, film_clock.js:510), so it also runs at 0.8× (0.5×). The rehearsal's pilot, obstruction and smoke decisions are made against a world 20% slower than the 30 fps shoot. A --locked shoot then replays a camera table built against the wrong particle and time-lapse timing. A 5 fps recorded take shows the world in half-speed slow motion.
- Fix: For R.fps < FILM_CLOCK_MIN_FPS, step the clock k = ceil(10/R.fps) times per film frame (interval 1000/(k·R.fps)). Arm the grab and run the pilot and sensors only on the last sub-step. Alternatively refuse fps < 10 in prepare/rehearse and raise the CLI's rehearsal default to 10.
- Verifier: take_player.js:3167 `const clockFps = clamp(R.fps, CLOCK_FPS_FLOOR, FILM_CLOCK_MAX_FPS);` (floor 10, film_clock.js:74) and :3173 `const dt = 1 / R.fps;`. Each clock step advances the world by `interval` = 1000/clockFps = 100 ms (film_clock.js:512 `let ts = st.base + (st.n + 1) * st.interval;`), and the sky time-lapse uses `filmMs = frame * st.interval` (:510). The camera/trajectory time `t = k / R.fps` advances 125 ms per frame at 8 fps.

**FILM-3 — recorder.abort() after a grab or output failure never closes the VideoEncoder (a configured hardware encoder stays alive until the next shoot)**  
`scene3d/film/runtime/recorder.js:625` (`abort`) · low · CONFIRMED · new since 10-07: yes  
Reach: flag: ?filmMode=on, recorded shoots where grab() (or the output handler) throws

- Failure: During a stepped shoot the canvas is resized smaller than the recorder's visibleRect, or `new VideoFrame(canvas)` / chunk.copyTo throws. fail('grab', e) sets state = 'failed' but leaves the encoder open (only the WebCodecs error callback closes it). runStepped throws FILM_RECORDER_FAILED, and execute() calls R.recorder.abort(error). abort() skips closeEncoder() because finished() is already true. The configured encoder, an NVENC session on the 1070 with 'prefer-hardware', stays referenced through take_player's recorderRef until the next shoot replaces it. The next shoot then opens a second hardware session while the first is still open.
- Fix: Call closeEncoder() unconditionally in abort(): it is already idempotent and guards state 'closed'. Optionally also close the encoder in fail() when the failure was not the encoder's own error callback.
- Verifier: recorder.js:304-310 fail() only sets `st.state = "failed"` (:308) and closes nothing. grab's catch calls `fail("grab", e)` (:519). The encoder's own error callback is also just `fail("encoder error", e)` (:394); per the WebCodecs spec the UA closes the codec only in that case. runStepped then throws FILM_RECORDER_FAILED (take_player.js:3213-3214), and execute's finally calls `R.recorder.abort(error)` (:3598).

**FILM-4 — Handing the client back never undoes the take's look: release()/dispose() and the CLI's documented `--release` leave the sky-time pin, the AdminEnvirons fog override, the grade, exposure, bloom, vignette and DoF applied**  
`scene3d/film/index.js:1199` (`api.release / dispose`) · low · CONFIRMED · new since 10-07: yes  
Reach: flag: ?filmMode=on, after any take whose plan carries a look (prepare: index.js:1058 `look.apply(take.look)`)

- Failure: A shoot with look {timeOfDay:'night', fog:'white', grade:'night'}. prepare → look.apply sets setSkyTimeOverride(0), assigns window.__environFogOverride and sets __grade. The director then runs `film status --release`, which calls release → clean(false) → world.avatar(true). Its checks pass (camera, HUD and avatar are back), but nothing calls world.restoreLook(). The person who later uses the 1070 Chrome gets a night sky that never advances, white fog and the night grade until a reload. dispose() does not restore the look either. look.js's own header says the look must be 'fully undone afterwards — the same browser plays the next site, and the person on the 1070 may open it later'.
- Fix: In dispose(), call look.restore() (and world.avatar(true)). Have the CLI's `--release` also call world.restoreLook(), or add an opt-in {restoreLook:true} to release().
- Verifier: index.js:1199-1202 `release: safeSync(() => { if (cameraBusy()) throw ...; return { ...cameraOwner.release(), owned: cameraOwner.owned }; })` releases only the camera. dispose() (:1158-1185) calls takePlayer.abort, lensOverlay.dispose, cleanFrame.restore and cameraOwner.release, but not look.restore(). The only restore path is `world.restoreLook` (:1226). Nothing in tools/film calls it: rg finds no restoreLook or world.look calls in tools/film/*.mjs.

**FILM-5 — clean_frame's nameplate hide is undone on the next animation frame by nameplate_sprite's self-managed LOD loop**  
`scene3d/film/runtime/clean_frame.js:255` (`createCleanFrame.apply (nameplates step)`) · low · CONFIRMED · new since 10-07: yes  
Reach: flag: ?filmMode=on AND ?nameplates=on AND no ?hud=none. Nameplates are default OFF (nameplate_sprite.js:311-319 `_NAMEPLATE_DISABLED` is true unless nameplates=on, and true for hud=none). The CLI boot URL (tools/film/lib/session.mjs:126) carries hud=none, so the CLI path never reaches this. Manual boots only

- Failure: A page booted with ?filmMode=on&nameplates=on (no hud=none). clean(true) sets `_nameplateSprite.visible = false` for every entity. nameplate_sprite.js runs tickNameplateLod on its own rAF every frame and rewrites `sprite.visible = want` for the nearest in-range sprites. During a stepped take the film clock yields one rAF per film frame, and the LOD measures range from the film camera (cameraSwitcher.activeCamera). Nameplates near the camera therefore reappear in recorded footage even though the clean frame reports `nameplates: {ok, hidden: n}`.
- Fix: Hide nameplates through a flag the LOD honours instead of writing .visible directly: e.g. a module-level `setNameplatesSuppressed(true)` in nameplate_sprite.js, or a `live._filmHideNameplates` checked at the top of tickNameplateLod. Alternatively hide the sprites' layer.
- Verifier: clean_frame.js:251-256 writes `s.visible = false` straight onto `_nameplateSprite` / `_buffBadgeSprite`. When nameplates are enabled, nameplate_sprite.js:1272-1281 starts a self-managed rAF `_lodLoop` that calls tickNameplateLod(window.liveScene3d) every frame. tickNameplateLod has no film or suppression check (rg 'film' in nameplate_sprite.js finds nothing).

Related defects the verifier noticed while checking (not separately verified):

- scene3d/film/runtime/camera_owner.js:500 — seedCell() also goes through walk(): a reseed with no cut cell (pendingReseed, or a >192 m jump) walks player head → eye in a dungeon, so a head→eye line through a wall gives the same outdoor-landcell escape as FILM-1, even when no plan cell is involved.
- scene3d/film/runtime/camera_owner.js:431 — cellFromLandscape on a dungeon or cellar under a landscape landblock that has buildings nearby can flood those buildings and return an unrelated building cell, or the landcell, for an eye that is really inside an underground EnvCell. Same root cause as FILM-1, different symptom (the wrong building interior is drawn).


## 7. Still open from earlier reviews

Reviewers checked the deferred items of the 2026-08-03 and 2026-10-07 reviews and the recent handoffs. These are still present (one line each, as reported):

**rust-net**

- 2026-10-07 §4 Small: `pending_confirmations` are surfaced only by rynth. The UI gap is now covered by plugins/server-confirm.js via kind events, but the Rust queue is still rynth-only and never pruned (see RUSTNET-3).

**rust-core**

- 2026-10-07 review §4 'Small': MOTION_ACTIONS / MOTION_AXES (lib.rs:50631, :50738) are still drained only by the rAF poll, so a hidden tab builds up a stale burst and replays it on refocus.
- 2026-10-07 review §4 R4: SHADOW_REFRESHED_AT (session/commands/movement.rs:17) is still per thread, not per session (thread_local next to this bucket's lib.rs queues).

**rust-crates-diff**

- The shard record cache is still unbounded by default: configured_shard_budget_bytes() returns usize::MAX when __hbShardBudgetBytes is unset, so the new soft cap is inert (2026-10-07 review item).
- WorldState::water_depth_at (heightfield fallback and the hop detector's depth probe) still uses ACE's `% 24 >= 12` corner pick, state/types.rs:887-893 (2026-10-18 handoff).
- MovementSystem still sends mirrored MoveToState pulses during server-driven turns and MoveTos (retail sends none); only their effect on the glue was removed (2026-10-18 handoff, melee).
- remoteSettle can drop a creature through floors the scene does not hold (scenery rocks, weenie carts); remote_ground_at samples terrain, building triangles and static BSPs only (2026-10-18 handoff, spawnz).
- Scenery is still clamped after the transition rather than collided inside it; clampReplant and clampAlongGround remain stopgaps (2026-10-18 handoff, hop).
- The house-barrier refusal pscript (CanMoveInto :438440-438455) is not ported (documented in house_barrier.rs).

**stream-terrain**

- HANDOFF-1070-session-2026-10-11 §4 item 7: far_terrain `[far_terrain] RADIUS POLICY VIOLATION` console.error is still present (far_terrain.js:1145-1196, assertRadiusPolicy). Root cause is a wrong invariant, not eviction lag: lbCap = 13²+2·13+8 = 203 keeps landblocks at Chebyshev 6-7 resident indefinitely while gate = pvsRingRadius+1 = 6, and farLbKeys (every landblock the far ring ever fetched, :1486) is never pruned, so with farRing and farDiag default ON it fires after any short walk or teleport.
- 2026-08-03 review, far_terrain minor note: the bake-rig material clone (ensureBakeRig) is still never disposed (session-lived).
- webac-comparison streaming-residency-5 (pipelined discovery walks, h2 page cap) is still deferred.

**stream-statics**

- cells.js:2555 — the post-compile cancel path still calls `releasePooledCellsForLb(lbKey)` without a generation check, so an older envcell build losing the race releases the pooled cells a newer build already added (10-07 review §4, ?drawPools only, still default OFF). The new walls-first `dropOwnWalls` (:2649) is gen-guarded.
- static_batch_x.js — 10-07 R5 'smaller first buckets regrow more often' (sizing from the first feed, grow = full copy + re-upload) is unchanged.

**sky-shading**

- #154 (2026-08-03 R5): trail_map.dispose() still has no production caller; it is only invoked from terrain_vfx.js _resetTerrainVfx (test seam).
- 2026-10-07 §4 'getSkyState + getSkyObjectStates evaluate the sky twice per throttled tick and their boxes are not freed': the boxes are now freed (sky_lighting.snapshotSkyState finally-free, sky_object_free.js), but the double wasm sky evaluation per tick remains.

**entities**

- camera.js:1469 `?camDebug` world() still reads `cs.sessionHandle` (the accessor is `_getSessionHandle`). Deferred in the 2026-08-03 review, still present (dev-only).
- picking.js SERVER_SWING reader still treats only `off` as off (`!== "off"`, no 0/false). Noted in HANDOFF-owner-bugs-2026-10-18 §8.
- Targeted casts / missile shots still wait for the client turn-to-face (picking.js turnToFaceThenAct, FACE_TURN_TIMEOUT_MS 800) unless `?serverTurn=on`. 2026-10-07 review §4.
- Legacy chain-walker Sound/SoundTweaked timers are merged into `_soundTimeoutsForGuid` and never self-remove (entities.js ~15448/15851), so long-lived entities' buckets grow per play. 2026-10-07 review §4.
- `_spawnMotionStash` entries for spawns that never commit are deleted only on commit (entities.js:11809). 2026-10-07 review §4.
- blood_decals.js / carnage.js default bus handlers still read the payload off the CustomEvent (never fire on real traffic); fixed only behind strict opt-in `?combatFxBus=on`. lint DETAIL_KNOWN_BUGS.

**vfx-audio**

- particle_manager.js `_materialPool` (keyed by gfxobj\|blend\|baseMaterial.uuid) is never pruned, so keys rotate on every matBudget eviction and strand their parked clones (2026-10-07 §4 'Particle bookkeeping'). Still present; slot carriers (default ON) now limit it mostly to per-mesh emitters.
- owner_registry.js `_epochs` gains one entry per destroyAllForOwner owner key and is never pruned (2026-10-07 §4). Still present. The 'ids removed only on explicit destroy' half is fixed by PLIFECYCLE-3 retire.

**shell**

- R5#13 abandoned-tail sweep: on the kind=4 STOP_PUMP return (index.html:6576), the batch's unvisited ClientEvent boxes are still left to the FinalizationRegistry (deliberately skipped in round 5).
- Pre-4.8 §4: the 2.1 MB cast-table JSON parse still runs on the main thread (client_events.js preloadCastSequenceTable / preloadSpellShapeTable at idle).

**plugins-a**

- 2026-10-07 §4 'Hotbar stale-binding prune is dead for characters with server shortcuts': the reconcileAttempts<30 gate is now reconcileDone, but the prune is still dead on inventory changes for a new reason (PLUGINS-A-1, null client).
- HANDOFF-owner-bugs-2026-10-18 §8 usetarget: target-mode clicks in the corpse / chest window are still not handled. corpse-loot-bar.js has no __useTargeting / resolve path, so a kit or mote awaiting a target only selects there.
- HANDOFF-owner-bugs-2026-10-18 §8 usetarget: clicking the paperdoll figure as yourself is still not done. Only the main pack slot targets the player in inventory.js.

**plugins-b**

- rejection_feedback.js _installProxy KNOWN GAP (documented in code): after a reconnect the new SessionHandle is not re-wrapped, so rejection tracking stops for that session.
- Swept-entity WorldObjectManager entries from the 2026-10-07 review: now FIXED (maintPrune is default-ON since NETSYNC-4). Not open, listed only for completeness.
- pending_confirmations only surfaced by rynth (2026-10-07 review): now FIXED by the new plugins/server-confirm.js. Not open.

**film**

- Internal film review 2026-10-14 (low, index.js dispose): dispose() during a running take still skips cameraOwner.release() (`if (!busy) cameraOwner.release()`, index.js:1159-1186) and removes window.__film, so the camera stays owned with no API left to release it.
- Internal film review skipped item 'seams-0 optional index.js hardening' (no-render cancel for the first step's pre-hold re-arm) is still not implemented; the re-base path covers it.


## 8. Reviewer observations (not verified)

Non-bug risks, design debts, stale comments and hollow tests the reviewers noted. Not verified by a second agent; treat each as a lead.

**rust-net**

- net_worker proxy round-trip: the main thread packs C2S messages and the worker re-parses them with the INBOUND GameMessage::unpack (net_worker_outbound.rs). Today all 96 GameAction variants and 6 GameMessages sent from src/ have unpack arms (checked by script), but no test enforces this. A new outbound action without an unpack arm would be silently dropped in netWorker/agent sessions, with only a log::warn.
- scene3d/net_worker.js maps any exception in its onmessage, including a failing `hb_mem_census()` for the diag census relay, to {t:'error'}. net_worker_client.js turns a post-ready 'error' into net_proxy_push_disconnect, so a diag-only call can end the session.
- Not this bucket: app/client_events.js:110-118 writes `li.dataset.name` (the server-supplied character name) into loginStatus.innerHTML unescaped. The fallback `"<unknown>"` is also parsed as a tag. ACE name validation keeps this mostly theoretical.
- wasm cache-bust stamp is still `wasmrev-20261011f` in every importer, including net_worker.js/net_worker_client.js, although pkg/ was rebuilt on 10-13, 10-17 and 10-18. HANDOFF-owner-bugs-2026-10-18 §5 makes this a deliberate choice that relies on serve.py's no-cache headers. Any deployment without those headers would serve a stale wasm under the same URL.
- Rust URL-flag parsers (`split('&').any(kv == "x=off")`) and their JS twins (URLSearchParams.get = first occurrence) disagree on duplicate params (e.g. `?retailStatusCmds=on&retailStatusCmds=off`). That can double-print or drop the /age line. Edge case only.
- ping_round_trip: one ping lost while others are still answered freezes the RTT reading for the rest of the session. The 10 s stale window never elapses while answers keep arriving every ~1 s from three drivers. This is documented as rare (NAK-retransmitted).
- walk_dedup::get_or_install calls `factory()` while holding the map's borrow_mut. Safe today because the factory only builds a future, but a factory that touched the map synchronously would panic `already borrowed`.

**rust-core**

- Two new chargen/barber caches (barber.rs FACE_TABLE and DAT, plus chargen_colors.rs CLOTHING) are positive DAT caches that init_resource_source does not clear. Every other positive cache is cleared on re-init. Today nothing triggers this (index.html inits once).
- SURFACE_TYPE_BITS (lib.rs:7965) has no size limit and is not cleared on re-init. It is only filled under ?negFace=retail.
- fetch_entity_degrade_for_distance runs on the T9 LOD tick and memoises nothing for a chain or part record that keeps failing. Every tick for such an entity runs a full walk with 3 tries plus 1 s of backoff. Only the success path is memoised.
- populate_building/statics_aabbs_for_landblock mark the ?remoteSettle collision part only on Ok. A populate that fails transiently leaves that landblock's floating creatures unsettled until JS retries the populate, which I did not verify.
- BatchWalkEnd::Stalled counts as settled(). It relies on 'same miss set twice' meaning 'absent from the manifest'. A source quirk that returns Ok without landing the keys would arm the per-build stab memo on missing records.
- The walk-lite parity test (tests_surface_walk_lite) uses a MockSource with only the eor/portal namespace. Pack-served, BC7 or texture-override reads are not checked for parity with the decode.
- fetch_landblock_heightmaps and fetch_subdivided_landblocks now parse the full Region record (resolve_region_land_height_table) on every call, now that the Region is always resident. The cost is per batch, not per frame, and the call existed before.
- global_source::global_source() panics if init_resource_source has not run. Most new exports (fetchRegionDetailSurfaces, entity_degrade_chain_id, fetchSetupPartPose, fetchMotionLinkKeyframes) use it rather than try_global_source. That matches the existing pattern, but an early JS call aborts the instance.

**rust-crates-diff**

- start_remote_settles runs remote_ground_at (a linear scan of its own landblock's building triangles plus its static BSPs) before the cheap neighbour-ready check. A body within 24 m of a landblock edge whose neighbour's collision never becomes ready (outside the 3x3 collision ring, if the app only marks ring landblocks) stays pending and repeats that scan every physics slice while the player stands still. Moving the neighbour check first removes the waste.
- TransitionEnv::house_barrier_overlay rebuilds the overlay on every faithful transition whenever a restricted cell is in the 3x3: a sorted Vec of guids, a HashMap, and two Rc allocations per house. That covers every remote-mover sweep and the clamp-replant retry, even non-player movers, which check_entry_restrictions ignores anyway. In a housing village with many movers that is tens of thousands of allocations per second.
- RawMotionState::pack has a debug_assert_eq that flags and Options agree. Every current builder is consistent, but a future one that is not would panic a --dev wasm on the outbound send path; release builds strip the assert.
- Feature switches are thread_local, not per session: REMOTE_SETTLE, REMOTE_LEASH, REMOTE_REST_HEADING, RETAIL_WATER_QUADRANT, HOUSE_BARRIERS, the raw-default omission flag, SHARD_FETCHER and SHARD_RELOAD. So are the hop_diag and slow_run rings: they are per wasm instance, survive a reconnect in the same page, and the bake worker's instance has its own defaults.
- replant_after_clamp re-runs the transition to the clamped XY without re-applying the scenery clamp. A retry that slides along a wall can end inside a different trunk; the next slice's push-out recovers it.
- A house object the client does not hold (not yet created, or swept) makes check_entry_restrictions refuse its restricted cells. That walls a stranger out of a yard, or pins them inside a restricted EnvCell, until the object arrives (retail behaves the same, but our object table can lag).
- consume_pending_arrival_placement leaves the latch set while the arrival cell's physics BSP is not resident. Under the default retail AP gate (position_event_ready checks it), no AutonomousPosition and no force-position ack goes out until the BSP arrives.
- The remote leash's hold_leash means a remote that receives no accepted MoveOrTeleport slows to a halt within 50 m (20 m indoors) of its last correction. This is retail parity, but walking now depends on ACE's UpdatePosition cadence for every mover.
- Coverage is thin for the 78-100 m settle window (RUSTCRATES-1) and for the hop detector's 'object' classification of building step-ups (statics_on counts only cell static BSPs, so porch step-ups may log as 'unexplained').

**stream-terrain**

- far_terrain.js: farLbKeys grows with every landblock the far ring has ever fetched (up to the world size) and assertRadiusPolicy walks all of it on the default 10 Hz tick. That is O(N) work plus an N-element `beyond` array per tick over a long tour.
- tex_upgrade_queue.js: a leg whose fetch never settles holds its in-flight slot forever (no per-leg timeout). With cap.all = 1 on links under 1 MB/s, one hung leg stalls every HD upgrade. The shard worker's 2 s heartbeat deliberately hides such a hang from the client's stall watchdog.
- xu7_textures.js: the texture worker runs one job at a time with no job timeout. A wedged transcode leaves its tickets unreleased, so TexUpgradeQueue._postRecv rises past WORKER_BACKPRESSURE_DEPTH (8) and blocks every xu7 dispatch for the session.
- tex_upgrade_queue.js _refetch: callers that joined while the xu7 leg was in flight are not in the hbc7 leg's waiter list (addWaiter only merges into queued jobs). That leaves a narrow window where the leg can be dropped while a live joiner is still waiting.
- tex_upgrade_queue.js: parked/held jobs for live cached materials whose holders disappeared stay queued indefinitely and keep a 1 Hz wake + scene-graph index walk running (bounded, but permanent background cost).
- terrain.js bakeTerrainForLandblock adds terrainBakedLbs before building geometry. A throw afterwards leaves the mark set with no mesh, and every retry short-circuits (a permanent terrain hole); no trigger was found.
- app/landblock_stream.js: the building-AABB populate (populateOne) also marks populated after its awaits with no residency re-check. It is consistent today only because those products are pushed in one batch after the last await.
- Tests: nothing exercises a LOD re-bake racing park/evict, or eviction during an interior build (product cancellation).

**stream-statics**

- Two module instances of statics.js (index.js `?v=phase7-par` vs loop.js/cells.js plain) duplicate `_staticCallPesTimeouts`/`_spDisposed` (disposeStaticParticles would cancel only one instance's timers; it has no production caller today), `_staticPartPoses` (the part-pose fetch is cached twice: outdoor anchors in A, interior in B) and `_cullGate`. buildings.js's second instance is inert apart from its window hook, and nothing else relies on it being a singleton.
- landblock_lru.js `_discardStalePoolCopy` (the 'shouldn't happen' re-park path) disposes stashed `p.statics` Batched/InstancedMeshes but not `p.buildings`, so a stale ?buildingMatBatch BatchedMesh would leak its GPU buffers and keep its variant held. disposeParked was updated, this sibling was not. Hand-off to the landblock_lru owner.
- Building batches take receiveShadow from the bake-time preset bool, and loop.js tickShadowReceiveGate walks only Group children with partGroups, so every batched building receives CSM shadows at any distance (documented trade-off, same as the old atlas route).
- lighting.js recordBuildingTree needs placementGroups with partGroups. On default URLs building surfaces are flattened (atlas route since 07-14, now material batches), so building Setup lights are never attached. This predates ?buildingMatBatch and is unchanged by it.
- animated_scenery.js buildOneInstanced: if a bucket promise rejects after earlier slots registered, those slots (and `active` counts) stay in the bucket with no tracked instance. The rejected promise is also cached forever in `_buckets`, so that (setup, anim, part, group) never retries. Pre-existing; rare (materialCache.get rejecting).
- anim_scenery_gpu `_geometryWithPoseRow` writes `__hbAiRow` into userData that BufferGeometry.clone() shares with the source. Harmless today only because each (geometry, row) pair is requested once per cached bucket key.
- statics.js registers static portal anchors in portal_registry unconditionally. Pruning happens only in fx_showcase's set-piece scan, so with ?portalSetPiece=off the map keeps evicted anchors (small, bounded).
- No test covers a landblock crossing during a time-sliced default_script attach or unpark rebuild (tests/static_anchor_radius.test.mjs exercises the tick only).

**render**

- No test exercises a WebGL context loss and restore against the default-on render patches. three's initGLContext replaces properties, capabilities, info, state, renderLists and shadowMap; the scratch repro (/tmp/claude-1000/-home-wbterminal/f6ca1a51-fd22-4ea1-8d0a-1bbd5e022f40/scratchpad/review/render/restore_repro.mjs, fake GL) is a ready template for a gate suite.
- shadow_caster_list's wrapper (and the static cache inside it) lives as an own property on renderer.shadowMap, which three replaces on restore. After a restore both silently stop (output-identical, perf only, ?csm=on only), and lighting.js keeps OR-ing hbShadowReason onto lights with no consumer.
- draw_sort_program.makeProgramSort captures renderer.info and renderer.properties. After a restore its per-frame memo key (old info.render.frame) never advances and program ids come from the dead map, so the program-grouped opaque sort degrades for the session (more program switches; correct pixels).
- quality.js GPU_HIGH_RE now sends every GTX 1060 (including the 3 GB card), 1650 and 1660 to ULTRA (msaa 4, SSAO, default-on clouds raymarch, POM 24, ~120k grass blades). Context loss was already logged 7 times on an 8 GB 1070 at ultra, so VRAM-limited cards will take the fragile restore path more often.
- With csm:false in every preset, all of the 2026-10-17 shadow work (mover scope, static cache, interiorShadowCull rasters, CSM sampler pins) is reachable only through ?csm=on or ?shadows=on, so a bare-URL gate never exercises it.
- texUnitPin and lightUbo exactness is proven only against tests/helpers/fake_webgl2.mjs. ANGLE/D3D11 behaviour for fragment samplers on units 25-31 (above MAX_TEXTURE_IMAGE_UNITS = 16) and for the std140 light blocks depends on a real-GPU smoke (NEEDS-BROWSER).
- IBL refresh assigns a new PMREM texture to scene.environment every 15 s, which forces three's needsProgramChange -> getProgram (parameters + cache key) on every standard material once per refresh. The program cache hits, but the CPU cost scales with the material count (pre-existing).
- The ?waterClouds cube composite re-renders the sky scene into 6 cube faces plus 6 composite quads every second at high/ultra (clouds are now default-on there).

**sky-shading**

- The SSAO composite has EffectAttribute.NONE, and pmndrs EffectPass sorts effects by attributes descending (postprocessing 6.39.1 build line 15551). It therefore runs AFTER clouds, AerialPerspective, horizonDissolve and fxDecals, not first as the ssao.js header and the pipeline comment claim ('distant haze is never darkened'). AO multiplies AP inscatter within its 110 m fade. Visually tiny today, but the documented invariant is false.
- sway_shadow.js shares ONE customDepthMaterial across every swaying caster. three r184 getDepthMaterial copies each caster's map and alphaTest onto it per draw, so alternating cut-out leaves (alphaTest>0) and opaque trunks bump material.version at every zero-crossing. That forces getProgram, cache-key and uniform-list rebuilds per toggling shadow draw. It is CPU cost in the shadow pass, not measured.
- daygroup_weather.js block comment (around lines 120-127) still says the legacy scan is 'still the default' and that ?stormScan=retail is opt-in, while stormScanMode() now defaults to RETAIL (2026-10-17). The doc and the code disagree.
- cloud_overlay.js primeLegacyMarch JSDoc says '?cloudsBootOrder (default "legacy")', but cloudsBootOrder() returns 'off' by default.
- ssao_marker.js claims the canvas is alpha:true/premultiplied. The WebGLRenderer in index.js is built without an alpha option (three's default is false), so the 'page shows through grass' failure it guards against cannot happen; the rationale is stale.
- cloud_night's display-target inversion (night cloud floor solved to display 0x171725 through the tone curve) ignores the default-on ColorGrade that runs after tone mapping, so the night clouds' on-screen colour is the graded one, not the solved target.
- No tests exercise ssao.js (no tests/*ssao*), including the half-float sentinel and the camera-retarget path.
- ac_moons uTime grows without bound. The sparkle and scintillation hashes use sin() of large arguments after hours of play, which degrades on GPUs with poor range reduction. It is cosmetic flicker only; the cloud flow itself is bounded.

**entities**

- missileSubstate (17cc25f2, 2026-10-17) depends on a 50 ms MISSILE_READY_COALESCE_MS window and the _committedMotion/_readyIssue bookkeeping to turn the bridge's synthesized Ready + Reload pair back into Aim→Reload. It is one day old, not eye-tested, and only node-tested; frame hitches above 50 ms between the two drains fall back to the Ready→Reload path.
- remoteSettle JS replay assumes the wasm emits a pose row for every body move. A Rust-side hard snap with no row, after the last parked row, would leave a stale parked pose that _drainPreCreate replays at spawn commit. The managedPose park also re-stamps the bucket's 25 s expiry every frame, so a mover whose rig never commits keeps its whole bucket alive while rows flow.
- portalRecreateInPlace keeps the old rig and copies only `name` from the re-sent CreateObject. A PhysicsState/visibility change carried only by that CreateObject is not applied (retail applies DoSetState in place).
- applyManagedPose calls _localPlayerWorldPose() (one getLocalPlayerPose box create+free) per managed row per frame, not the frame_pose.js per-frame snapshot. This is pre-existing; rows are sparse, but it scales with the number of moving remotes.
- The sphere-pick fallback (default ON) runs on every hover miss and click miss. It computes bounding spheres on shared cache geometries (harmless), and a click near any rig's part spheres now selects it. Selection behaviour changed broadly, but node tests are the only gate.
- The camera-2 viewer step floors only the IDEAL eye against terrain. With a non-default camStiffness, the lerped eye between two floored points can dip under a convex ridge, and the later sweep has no terrain layer.
- nameplate_sprite.js:1119 setInterval(trySubscribe, 500) never stops if the subscribe never succeeds (pre-existing, cheap).

**vfx-audio**

- play_effect_vfx.js _fireTier1Cue fires a flash, shockwave and decal for every resolved PlayEffect at ANY distance, with no range gate. Far-away cues compete for the 10-flash and 8-shockwave caps and can evict the cues next to the player.
- fx_distort.collectFxDistortSources runs every frame over EVERY emitter-bound distortion source in the resident emitter radius (~11% of retail emitter DIDs carry one). It resolves and projects each one and allocates a candidate object per on-screen source. The cost is O(sources) per frame even when nearly all are off-screen or far.
- The emitter-light 'registered' state is only refreshed by the 2 Hz dedupe. A newly bound transient light (a bolt's flame emitter) stays dark for up to 500 ms of a 1-2 s flight.
- particle_fx.js: if patchParticleFxShader fails (three chunk drift), the bucket keeps its FX defines and key, but the instance colour now carries (op, age, row+seed). The stock shader would then multiply diffuse by row+seed (≥1), giving garish particles; only a one-time warn is printed.
- breathFog, sandDevils and swamp bubbles switched 2026-10-10 from the alpha smokePuff to the ADDITIVE softGlowDot. Under ?particleFx=off they render as raw blue-white additive glows, because the tint and desaturation live only in the FX shader.
- fx_glow_effect twins and the glow material (makeParticleFxGlowMaterial) copy the bucket material's `map` once at creation. A later texture re-seat on the bucket material is not followed.
- portal_space.js: nothing outside the module calls endPortalSpace (no logout/disconnect hook). A tunnel interrupted by a disconnect runs to its own failsafe (≤20 s), still playing the drone and showing the notice, and blocks the next login tunnel ('busy'). Not verified live.
- No node test covers the FLASH_MAX eviction path (VFXAUDIO-1) or the dedupe cost at realistic emitter counts (VFXAUDIO-2).

**shell**

- service-worker.js: put-after-purge race. A bake-versioned response fetched in one tab before a re-bake can be cache.put after a second tab's gate purged and stamped the new bake id, leaving a stale catalog served under the new id until the next re-bake (two overlapping loads across a dist activate).
- service-worker.js: /scene3d/assets/ is stale-while-revalidate, including the terrain_bc7/pbr/macro manifest.json files, so the first load after an asset rebake can pair a stale manifest with a mix of refreshed and stale non-content-addressed files.
- ui/escape_action.js: any DOM mutation anywhere in the document during the Escape dispatch counts as 'consumed'. A plugin that repaints on every keydown would silently disable Escape-deselect.
- ui/cast_reject_policy.js shouldCancelOnUseDone: it assumes a success UseDone always arrives after the local chain finished. A slow local chain (low fps, late prediction) would be cut by a success UseDone.
- ui/combat_mode_pending.js: a parked toggle shows no feedback (the stanceLabel 'pending' class is added only in send), and a stuck movementPendingMotionsDiag > 0 delays every combat toggle by the 3 s cap.
- ui/input-funnel.js: the held-key ledger releases keys after a dragstart that never became a drag (cancelled dragstart, then a pointermove with no buttons). A still-held W then stops the runner, and the cmdInterp lane ignores the repeats.
- index.html preInitShare: if the eager preInit3D resolves after the 20 s cap, init3D has already built a second renderer on the same canvas (the pre-flag behaviour).
- ui/camera_settings.js / ui/graphics_settings.js: `typeof localStorage` sits outside the try and throws in storage-blocked browsers (callers mostly wrap it).
- app/frame_pump.js: upd.free() is not in a finally, so a throwing dispatch leaves the rest of the batch to the FinalizationRegistry (pre-existing).
- index.html pagehide always disconnects and frees the session with no pageshow handler. If the page ever enters the bfcache, a restore resumes rAF against a freed handle with no banner.
- Not run: no targeted node tests were executed (static review only).

**plugins-a**

- Design risk: ui/bar.js passes client:null to every plugin mount() for the whole session. Any mount that captures `ctx.client ?? window.__pluginClient` without a __pluginClientReady fallback is silently dead. hover-tooltip.js:250 has the same pattern (its hoverEntity emits go nowhere; it has no consumers today). A loader-level lazy client getter, or a lint, would prevent a third case.
- Hollow tests: tests/hotbar_*.test.mjs and tests/barber_panel.test.mjs create window.__pluginClient BEFORE mounting and pass it as ctx.client, the opposite of production order. Their own comment says the bar mounts at page load, before the bus exists.
- Retail parity: canBindToHotbar refuses containers and sigils on drop (inventory_helpers.js:396-411). Retail gmToolbarUI::IsShortcutEligible (acclient.c:239885) refuses only stuck (BF 4) objects, non-player creatures and vendor stock. The radial 'Add To Hotbar' path (radial-menu.js:470 → hotbar.js:1913 bindItemToSlot) does no check at all, so the two bind paths disagree.
- hotbar.js:1067-1099 migrateClearContainerBindings runs once, 1.5 s after mount, which is always before login on the default boot, so it never acts. Its comment says 'we get re-run on reconcile', but nothing calls it again.
- Target mode: on a side-pack cell or the main pack slot, the second press of a target double-click is not swallowed (only the item grid and paperdoll check justTargeted). The click after a target pick selects or opens that pack. This is cosmetic.
- examine-target.js inscription editing: if the body is torn down while the inscription box has focus, the edit is committed only when `_inscEdit.guid === examineGuid` at unmount. The main-panel and floaty unmount paths handle this, but the module-level _inscEdit is shared by every examine body.

**plugins-b**

- Hollow test: tests/commerce_windows_smoke.test.mjs sets window.__pluginClient BEFORE mounting vendor/salvage/tinker. It cannot catch the boot-order bug class (mountBar runs with client:null before login). A guard test should mount with {client:null} and no global, then resolve __pluginClientReady.
- Recurring bug class: any bar-slot plugin that subscribes from `ctx?.client ?? window.__pluginClient` at mount, without a __pluginClientReady fallback, is dead in production. A lint like the proposed `.detail` event-consumer lint (FINDINGS test-tooling-6) could catch it.
- vitals-orbs.js header comments and its manifest description say 'STRICT opt-in ?vitalsOrbs=on', but isVitalsOrbsActive() is `!== "off"` (default ON since the 2026-08-01 sign-off). The orbs, not vitals-hud, are the default vitals UI, and their continuous rAF driver runs on every default session.
- spellbook spell-bar sync (default-ON ?serverSpellBars) writes the server's favourites: AddSpellFavorite/RemoveSpellFavorite diffs. A never-synced character with empty server lists gets the shared per-browser legacy bars uploaded once, even when another character built them (pruned to known spells). This is by design but can surprise.
- trade-panel attemptToTradeItem / onTradeUpdated and vendor-ui snapshotFromWasm never free the TradeSnapshotJs / VendorStateJs / VendorItemJs boxes. They are event-rate and wasm-bindgen's FinalizationRegistry reclaims them, so the cost is GC backlog only.
- rejection_feedback replaces window.__sessionHandle with a Proxy about 250 ms after login. Identity comparisons against the raw handle must use the RAW_SESSION_HANDLE symbol. spellbook's barSync.handle compare survives this only because the proxy lands before the PlayerDescription.
- tinker-panel has no production opener (only the window.__openTinkerPanel console hook), so the tinker window is effectively dev-only.

**rynth**

- Nothing stops the bot on a session disconnect. After a kind=4 disconnect that does not auto-reload (account boot, or the reload budget is used up), the heartbeat Worker keeps ticking at 10 Hz. _pumpIfStale keeps calling __netFramePump, and the kernel keeps issuing casts and moves into the dead session; every failure is swallowed. The cost is CPU only, but it is invisible.
- combat_loop._onCombatEvent's magic-damage regex `(?:^\|! )You \w+ (.+?) for (\d+) points? with ` and vitals._onGainLine run on kind=2 lines of every chat category. Another player's speech such as `Hey! You smite Drudge for 99999 points with x` feeds the damage/MaxHP model and the contact watch, unlike host_signals, which skips speech categories.
- Some per-guid maps grow slowly over long soaks: loot_loop.looted is never pruned, combat_loop.unreachable is pruned only when the same guid is scanned again, and damageModel is pruned only on a death event.
- Parser robustness is uneven. usd.js and utl.js have row-count and truncation guards that met.js and nav_file.parseNav lack. The fixture corpus appears to be all well-formed files, so truncated or crafted inputs are likely untested.
- attemptJumpLeg (and the VT jump executors built on it) is designed as uncancellable, and the kernel's pinnedFirst policy is built around that. Every new caller inherits the 'STOP does not stop it' behaviour (see RYNTH-4).
- The HUD runs by default. installVtEntry eagerly imports rs_entry.js and with it the whole vt/cmd + vt/settings module graph on every page, even for players who never use the bot.
- control_channel still accepts SYSTEM-category (0) lines as tells and as 'You think' self-tells, for stale-pkg compatibility. That is safe only while no server System-category message can carry player-controlled text that exactly matches those regexes.

**film**

- film_clock.end() waits at most FILM_CLOCK_MAX_HANDBACK_MS (120 s) for wall time to pass the last film timestamp. A long stepped take that renders faster than film time (fast GPU, hidden page with MessageChannel yields) can be more than 120 s ahead. The loop then resumes with a timestamp below lastTs, which gives one negative-dt frame, and emitters stamped in the future freeze until wall time catches up.
- tickStepped awaits JEV for up to 15.5 s per decision with holdLoop set. The net pump runs only once per film frame then. Long JEV latency stretches wall time per frame, but packets are still drained each frame.
- rehearse() never applies the clean frame, so input is not blocked: a keypress on the film page during a rendered rehearsal moves the hidden dolly player.
- abort() is ignored unless a take is already running (run !== null). An abort issued while shoot() awaits ready(), or between prepare and shoot, is dropped.
- In realtime takes, liveSubject() is cached per liveScene3d.frameTime.tsMs. Under ?targetFps pacing the take's own rAF ticks more often than the loop renders, so the live subject reads frozen between rendered frames and then jumps.
- Static node fades restore node.visible = prevVisible unconditionally (take_player restoreStatic). An owner that changed visibility mid-take (park/LOD) gets the stale value back; only the instance and batch paths check ownership.
- With ?drawPools=on, part of an EnvCell's surfaces can be pooled out of its mesh-<cell> group. camera_owner's cellBox then measures a partial box and can trigger the wall-exit escape (FILM-1) inside the room.
- The world's actor moveTo cues keep polling (up to timeoutSec) and the player keeps walking after a take is aborted; cues are fire-and-forget.
- There are no dungeon (non-building) tests for the viewer-cell escape. The commit's C3 tests only model a building with a landscape exit.
- A fuzz of all 64 registered techniques (min/max/enum params, durations 0.05/0.5/default, coincident, micro-segment and reversing paths) built and sampled with no NaN or non-validation throw: the shot math looks robust. Script: /tmp/claude-1000/-home-wbterminal/f6ca1a51-fd22-4ea1-8d0a-1bbd5e022f40/scratchpad/review/film/fuzz_shots2.mjs


## 9. Not reviewed

What each reviewer reported it did not get to:

**rust-net**

- src/session/messages/objects.rs ObjectCreate arm body (lines ~37-754) beyond the diff hunks
- src/session/messages/position.rs PrivateUpdatePosition / PublicUpdatePosition / VectorUpdate arms (~633-846, ~1522-1660) and most of the UpdateMotion arm beyond the diff hunks
- src/session/commands/movement.rs TickMovement body (~600-2100) beyond the 86 changed lines
- src/session/messages/game_event.rs regions ~890-1180 and ~1380-1960 outside the diff hunks (allegiance/friends/contracts/house/titles arms)
- src/session/commands/social.rs remaining arms (fellowship/allegiance/squelch) beyond the diff
- src/walk_dedup.rs test module
- src/session/commands/combat.rs and housing.rs: only arm-list sweep, not read

**rust-core**

- src/lib.rs: about 54K lines unchanged since b8819698. I covered only hazard sweeps (statics/thread_locals, index casts, RefCell guards in async fns) and the areas around the diff hunks.
- src/lib.rs test modules added since 10-07 (tests_pal_part_match_census, the cmotiontable-3 fixtures, wire_state_packs_routing_tests additions, tests_substitution additions): read only lightly.
- src/prefetch.rs: the WalkCacheKey section and the rest of the file below run_batch_walk_loop were not read in full.
- src/decode_admission.rs: lines 330-1078 (pressure sampling, config parsing, tests) were not read.
- src/world_bootstrap_cache.rs, src/surface_overrides.rs, src/texture_overrides.rs, src/decode_source.rs: panic sweep only.
- src/motion_sequence.rs advance/seek and src/vertex_bake.rs light accumulation: not read in depth (both unchanged since 10-07).
- The JS consumers of the new exports (entities.js _gateLodChain/_fetchLinkEntry, statics.js degradePose, cells.js early-bake) are in other buckets and were checked only where the Rust contract needed it.

**rust-crates-diff**

- crates/holtburger-scenery-bake/src/{height.rs, noise.rs, orientation.rs, retail.rs, aabb.rs}: only lib.rs was read (offline baker, Retail mode is opt-in)
- crates/holtburger-core/src/chargen_colors.rs, slow_run_diag.rs, and retail_failure_table.rs contents (only the sort order was checked)
- crates/holtburger-content/src/character_gen.rs
- crates/holtburger-core/src/client/movement/{jump_charge.rs, handle.rs, stall_recovery.rs}, client/{commands.rs, messages.rs, character_info.rs, tick_spine.rs}: skimmed or not read
- crates/holtburger-world/src/{equip.rs, identify.rs, house.rs (beyond IsAllowedIn), player/types.rs, handlers/{fellowship.rs, trade.rs, player.rs}, state/fellowship.rs, motion/movement_types.rs, spatial/obj_collision.rs, spatial/transition.rs (hunks beyond the overlay)}
- crates/holtburger-protocol: per-message field orders beyond the bounds/unwrap sweep (character/types.rs, misc/actions.rs, ui_events/*, friends/events.rs, game_message/unpack.rs, opcodes.rs, crypto.rs)
- crates/holtburger-dat examples (parse_dat_record.rs, survey_cycle_segments.rs) and terrain_subdiv.rs (test-only change)
- All *_tests.rs and tests/ files except remote_settle_tests.rs (read to judge test coverage)

**stream-terrain**

- scene3d/residency_grid.js (fixedGrid slot logic): only swept
- scene3d/terrain_oracle.js, upload_stage.js, tile_plan.js, pre_create_buffer.js, terrain_ring.js, texture_release.js, texture_census.js, bake_prewarm.js, lod_prewarm.js: hazard sweeps only, not read
- scene3d/terrain.js GLSL bodies (the new terrainLights, far-simplify, water and paint-light shader text): diff only skimmed, no GLSL correctness check; resolveTerrainRingOpts beyond the alpha-mask/macro blocks
- scene3d/terrain_bc7.js: ladder/promotion/array swap logic beyond the diff
- scene3d/landblock_lru.js: sealed purge, park-pool pressure, objRadius and the light paths beyond the parts read
- scene3d/texture_worker.js and bake_worker.js message handlers beyond the diff
- scene3d/bc7_textures.js: the CLIP-ALPHA guard body and the full-tier mirror/rehydrate paths beyond the registration sites
- scene3d/pack_fetch_controller.js: everything outside the ?packRingHold diff (flag default OFF)

**stream-statics**

- scene3d/pool_stream.js, pool_class_key.js, pool_prewarm.js, pool_material.js — not read (behind ?drawPools, default OFF)
- scene3d/static_atlas.js body (2,694 lines, unchanged since 10-07) — hazard sweep only
- scene3d/static_array_pool.js body (?statArrayMerge, default OFF) — flag reader only
- scene3d/cells.js regions outside the 10-07..HEAD diff (portal stencil/punch bodies, PVS expansion body, occlusion integration) — not read in depth
- scene3d/statics.js bakeStaticsRing body, buildSingletonNode/buildInstancedNode outside the diff hunks, atlas/batch feed glue — partial
- scene3d/static_batch_x.js outside the value-key diff (bucket growth, memo slots, region reaper) — not re-read
- grass* files named in the bucket focus are not in this bucket's file list (final_buckets.json), so not reviewed here

**render**

- scene3d/materials.js outside the 2026-10-07..HEAD diff (~6.4K lines: POM, detail, surface ladders, MaterialCache re-seat/evict paths)
- scene3d/index.js outside the diff and the preInit3D renderer / render-dispatch regions (~7K lines: init3D wiring, streaming facades, resize handler)
- scene3d/loop.js outside the diff, fog probe and _armMotion (entity drain kinds, ghost-rig sweep, remote pose drain)
- scene3d/lighting.js outside the diff (light pool, single-shadow recentre, per-SetupModel cap)
- scene3d/csm.js body beyond the diff
- scene3d/portal_punch.js, portal_clip.js, portal_pass2.js, portal_stencil.js bodies beyond the diffs
- scene3d/frame_split.js, frame_work.js, stall_probe.js, geom_bundles.js, fixed_grid.js bodies (flag readers only)
- scene3d/indoor_landscape_gate.js body (opt-in ?indoorLandscapeGate=on; only the reader checked)
- scene3d/shader_logdepth.js log-depth helpers (lines 1-200) and reversedZDiagSnapshot
- scene3d/shader_prewarm.js ledger internals (?linkProbe dev-only)
- scene3d/mem_census.js, _ric_shim.js, three_batchedmesh_colortexture_fix.js, wireframe_flag.js, culling.js body, diag.js body, adaptive_render_scale.js controller body

**sky-shading**

- scene3d/atmosphere_pipeline.js: the pre-Oct-7 regions (SkyCapturePass, portal punch/seal slots, indoor split, sky-camera sync) were read only where the diff touched them
- scene3d/sky_dome.js: weather billboard pool build, bird anchor and dispose paths beyond the regions quoted
- scene3d/terrain_dirt.js, terrain_snow.js, terrain_sand.js, terrain_round.js, terrain_volcano.js, terrain_vfx.js, visual_ground.js, terrain_macro.js, terrain_families.js, terrain_hole_audit.js, gfx_relief.js, wind_rig.js, surface_planes.js, tree_wind.js, trail_map.js: hazard sweeps only (0 churn since Oct 7, covered by earlier review rounds)
- scene3d/atmosphere_lights.js, atmosphere_runtime.js, atmosphere_lut_plan.js, weather_state.js: swept or skimmed only (unchanged since the R4 sky review)
- scene3d/cloud_overlay.js: the legacy preRender, renderOverlay and prebaked-noise loader bodies beyond the diff
- scene3d/transcoder/basis_transcoder.js: vendored emscripten blob, not reviewed

**entities**

- entities.js regions outside the b8819698..HEAD diff hunks: most pre-existing spawn/_spawnImpl body, recolor/heal ladders, hot-swap internals, particle chain walker, ragdoll/limb hooks. Only targeted reads.
- entities.js missile-substate state machine not traced end to end (setLocalStance forced-Ready interplay with loop.js).
- weapon_fx interplay (weaponFxOwnedMaterial after an appearance hot-swap of a weapon): vfx/weapon_fx.js is another bucket's file, not read.
- camera.js outside the diff (orbit/topDown, input wiring, retail zoom internals).
- picking.js pre-existing regions (turnToFaceThenAct, missile aim, cast flow) beyond the diff.
- Zero-churn files reviewed only by hazard sweep (listeners/intervals/innerHTML): dismember.js, nameplate_sprite.js, ragdoll_env.js, spawns.js, limbs.js, kill_impulse.js, input.js, speech_bubble.js, object_radius.js, entity_owned_tally.js, setup_rig.js, spell_range.js, motion_queue.js, motion/motion_command_full.js, entity_update_clone.js, pursuit_monitor.js, recolor_flag.js, entity_dispatch.js, motion/motion_sequence.js, rust_pose.js, splatter_decode.js, entity_backlog.js, client_event_dispatch.js, motion_link_diag.js.
- selection_lighting.js and rig_cell_gate.js (both opt-in) only skimmed. ragdoll.js reviewed only in its diff (rest model).

**vfx-audio**

- GLSL bodies: particle_fx.js VERT/FRAG chunks, lifestone_fx.js crystal and glow shaders, fx_showcase.js VERT/FRAG, fx_decal_effect.js box shaders, fx_fields.js shaders, weapon_fx_glsl.js, play_effect_burst_fx.js GLSL
- fx_fields.js runtime (createFxFieldsProvider / resample), high/ultra only
- play_effect_vfx.js outside the 2026-10-07..HEAD diff (~4.5K pre-existing lines)
- portal_space.js outside the diff (ensureTunnel geometry build, advanceAnim, setNotice)
- particle_manager.js pre-existing regions (billboard paths, degrade resolver, instancing seam internals)
- audio: ambient_model.js, baked_ambient_source.js, voice_pool.js, and audio_manager.js _playHrtf / follow-mode
- Unchanged VFX leaf modules: components/foliageAmbient, tipFlex, tarnish, windSwayGpu, wetness, frost, glint, magicGlow, itemAura, windBend, enchantShimmer, flameFlicker, gemSparkle, terrainVolcanoEmbers, weaponAura, weaponFlex; particle_env_gates, particle_env, frag_install, frag_attach, vertex_install, shadow_guard, lint_caps, per_instance, oscillators, weather_inputs, registry, item_fx, config_merge, ui_effects_registry, portal_setups (generated data)
- particles/additive_fog.js, time_rng.js, particles/index.js
- spell_shape_preview.js and vfx_flags.js outside their small diffs

**shell**

- index.html: unchanged regions not read in depth (smoke-check page, renderHoltburg internals beyond the diffs, the full pumpNetFrame body, the virtual keypad, jump-charge UI internals)
- app/client_events.js: unchanged arms (inventory, enchantments, sound, contracts) only partially read
- ui/keymap.js: the retail ActionMap/KeyMap display helpers (qualifiedControlToBinding, joystick) only skimmed
- ui/ac_barber.js BarberPage/applyBarber body and ui/ac_spell_endowment.js rule functions (lines 60-200) not read
- Zero-churn ui rule modules only hazard-swept, not read: ac_layout.js, hud_kit.js, ac_dye_viewport.js, ac_dye_preview.js, ac_attack_type_for_weapon.js, ac_aim_level_for_velocity.js, ac_damage_rating.js, ac_spell_cast_sequence.js, ac_physics_script_table.js, ac_spell_shape.js, ac_combat_maneuver.js, ac_sneak_attack_predict.js, ac_play_script.js, ac_strings.js, attack_power_bar.js, ac_cast_precheck.js, ac_clothing.js, ac_palette.js, ac_lod.js, ac_palette_set.js, ac_combat_mode_intent.js, ac_entity_icon.js, ac_cast_ui_logic.js, enchantment_constants.js, fullscreen_toggle.js, hud_scale.js
- scene3d/diag/{placements,integrity,geometry,collision,pvs,events,entity_types,clothing,palettes,lod,assets,fonts,strings,input,physics}.js only swept for growth
- app/local_auto_motion.js, app/server_picker.js (beyond the meta/href path), app/latency_diag.js (beyond caps)

**plugins-a**

- plugins/gen-index.mjs (not opened)
- plugins/combat-bar.js outside the 2026-10-07..HEAD diff (~2,700 lines: spell strip, attack controls, persistence)
- plugins/chat-panel.js body (only the diff and the timer/listener counts)
- plugins/dye-preview.js, plugins/contracts-panel.js, plugins/debug-overlay.js beyond the timer/listener/innerHTML sweeps
- plugins/inventory.js lines 1-520 (styles, imports, title helpers)
- plugins/character-creation.js outside the diff (page renderers for Summary / Skills other than the changed blocks)
- plugins/buffs-hud.js, plugins/combat-hud.js, plugins/allegiance-panel.js, plugins/fellowship-panel.js bodies outside their diffs
- plugins/house-panel.js and plugins/corpse-loot-bar.js regions outside the diffs (render paths)

**plugins-b**

- plugins/world-objects/character.js, world_object.js, canonical_classify.js, item.js, creature.js, container.js, and the 3-line class stubs: swept only (unchanged since 2026-10-07).
- plugins/vitals-orbs.js rendering, driver and hit-gate (about lines 200-1360): only the mount and hook region was read.
- plugins/social-panel.js, journal-panel.js, lore-panel.js, tradeskill.js, salvage-confirm.js, vitae-detail.js, stance-toggle.js, manastone-confirm.js: listener and timer sweeps only.
- plugins/options-panel.js, map-panel.js, radial-menu.js, target-bar.js, spellbook.js, item_drag.js: only the post-2026-10-07 diffs and nearby regions were read; their unchanged bodies (ghost and tooltip code, map rendering, radial geometry, spellbook list UI) were not.
- plugins/loader.js validate/resolveDependencies/semver internals (lines 140-560): not read.
- plugins/rynth-vt/tab_buffs.js, tab_consumables.js, tab_vitals.js, styles.js: hazard sweep only.

**rynth**

- rynth/vt/support/{consumables,supplies,mana_stones,inventory_mgr,pets,buff_items,idle,index}.js (beyond doors/fellow headers)
- rynth/vt/combat/{attack_planner,monster_list,items,creature_profiles,monster_vars,debuff_ledger,spell_tables,index}.js
- rynth/vt/meta/{conditions,actions,views,meta_fns,index}.js
- rynth/vt/cmd/{actions_lib,compat_commands,quests,index}.js; most of rs_commands.js and stdlib_host.js
- rynth/vt/bridge/{bridge_lists,bridge_options}.js; most of bridge_route_meta.js
- rynth/vt/settings/{schema,cells,options (beyond sweep),index}.js
- rynth/vt/glue/{loot_ctx,meta_context,host_fn_context}.js
- rynth/vt/formats/{utl_eval,meta_schema}.js; most of af.js write path; met.js decode/write (330-700, 765-806)
- rynth/vt/nav/active_nav.js 1-760 (load/add/jump queue); executors.js 140-395, 470-1000 (portal/recall/vendor/NPC/checkpoint executors)
- rynth/webhost.js 1-330 table, 1610-1930 (stats/vendor profile/char plane)
- rynth/combat_loop.js 1000-1619 (tick/war-cast/engagement), buff_loop.js tick/_tickJs/_readRegistry, kernel.js tick body beyond 420
- rynth/goto_compose.js remainder (composeGoto/egress/replayRoute/door/repath changes)
- rynth/{indoor_router,global_router,router,unwedge,route_recorder,nav_guard,nav_frame,route_flags,portal_gate,loot_policy,sweep_probe,netbrain}.js, rynth/suit/suit_solver.js
- rynth/ai/** (director, extensions, tools/*, observe*, explore_memory, combat_memory, heal_reflex, confirm_reflex, journal, safety, providers, thought_overlay, actions, eval/scenarios) beyond llm_client/ui diffs and operator_stop tail
- netbrain/replay_fixtures.mjs

**film**

- scene3d/film/pilot/sense_words.js, questions.js, policy_code.js, scene_state.js, fingerprint.js (pure pilot logic; not read)
- scene3d/film/pilot/mapper.js beyond the speedScale/minSpeedScale clamp
- scene3d/film/scene/solver.js and most of los.js (only the wasm sweep/free chunk read)
- scene3d/film/shots/classic.js, drone.js, framing.js bodies (exercised only through the fuzz script, not read line by line)
- scene3d/film/shots/fpv_tricks.js after buildFpvRun's trick-placement section
- scene3d/film/drone/flight_model.js outside createDrone.step (gimbal limits, flyTrajectory)
- scene3d/film/runtime/look.js apply/restore bodies (only the header and the grep hits)
- scene3d/film/runtime/lens_overlay.js build/layout math (only draw/dispose/configure read)
- scene3d/film/core/gimbal.js, quat.js, easing.js, spring.js, noise.js, rng.js, errors.js (swept only)
- take_player.js: flightCheckOf/searchMinDuration/dryFly (~1040-1300) and liveGimbal/liveDerivs/aheadPoints/senseFrame (~1856-2110) were skimmed, not read in full


## 10. Fix pass (same day)

The owner then asked for the bugs on this list to be fixed. **Every one of the 61 findings in §5 now has a fix in the working tree. Nothing is committed.**

How it ran: ten fixer agents, one per group of files (no file in two groups), each followed by an adversarial reviewer that re-derived the fix and was allowed to correct it. The orchestrator fixed the seven Rust-side findings, RUSTNET-1 and STREAM-TERRAIN-2 itself. It also applied the edits that crossed group lines, built the release wasm once and ran the full gate once. Each new test was run against the HEAD version of the module it covers (through a scratch mirror or a loader hook, never by swapping files in the tree) and fails there.

Reviewer verdicts on the 54 agent fixes: 51 sound, 2 corrected by the reviewer (SHELL-2, RYNTH-4), and 1 sound but inert until a caller outside its group changed (RENDER-5; the orchestrator applied that change).

### 10.1 Status per finding

All 61 are **fixed**. The test column names the suite that covers the fix. "native" = a Rust `#[test]`.

| ID | Fix | Test |
|---|---|---|
| RENDER-1 | async_link_guard reads `renderer.properties` live; a `webglcontextrestored` listener bumps a restore epoch, drops the slow-path map and the in-flight polls | `tests/webgl_restore_render_patches.test.mjs` |
| VFXAUDIO-1 | the 10-flash cap evicts through `releaseFxLight` | `tests/fx_lights_vfxaudio.test.mjs` |
| PLUGINS-A-1 | the hotbar binds its inventory, landblock and cooldown listeners through `__pluginClientReady` (disposed guard) | `tests/hotbar_per_character.test.mjs` [8] |
| PLUGINS-A-2 | barber-panel subscribes late, at most once | `tests/barber_panel.test.mjs` (now mounts with `client: null`) |
| PLUGINSB-1 | salvage-panel subscribes late | `tests/plugins_late_client_bind.test.mjs` [1] |
| RUSTNET-1 | a superseded `?netWorker=1` attempt rejects with `err.superseded` instead of falling back to a direct login; the index.html connect catch ignores it | `tests/net_worker_superseded.test.mjs` |
| RUSTCORE-1 | a stab whose fallback walk failed is remembered for the rest of the build, so its later placements skip the walk | `tests/interior_stab_batch.test.mjs` S3 source pins (the path is wasm32-only, so there is no native test) |
| STREAM-TERRAIN-2 | the bc7/xu7 exports return an error for a failed fetch; JS caches only a real "absent" and retries a failure | `tests/bc7_fetch_failure_retry.test.mjs` |
| STREAM-STATICS-1 | per-anchor `__scriptDeferred` and a `split` set: the tick tears down the chained anchors of a deferred landblock and rebuilds only the deferred ones | `tests/static_script_radius_race.test.mjs` R1-R3, R6-R8; `tests/static_anchor_radius.test.mjs` |
| RENDER-2 | uniform_bind_patch puts `maxTextures` back after a restore and re-plans the pins when the new limit is lower | `tests/webgl_restore_render_patches.test.mjs` |
| RENDER-3 | the occlusion culler resets every proxy on `webglcontextrestored` | `tests/occlusion_cull_restore.test.mjs` |
| RENDER-4 | the far-fog fence drops its pixel-pack buffer and sync on restore | `tests/far_fog_fence_restore.test.mjs` |
| SKY-1 | on the split chain the haze now runs before the late particle pass | `tests/sky_late_haze_camera.test.mjs`; `particles_over_clouds` and `look_pass` updated |
| SHELL-1 | the three `dataset.name` sinks and the wizard's name are escaped | `tests/shell_charselect_spawn.test.mjs` |
| SHELL-2 | a CharacterError releases the spawn latch for the refused character. Reviewer correction: the release also keys on `spawnedPlayerGuid`, because the wasm queues PlayerSpawned before the enter-world request | `tests/shell_charselect_spawn.test.mjs` |
| SHELL-3 | the submit records `window.__hbLoginEndpoint`; `/logout` carries `bridge_url`, `server_host` and `server_port` | `tests/shell_logout_endpoint.test.mjs` |
| SHELL-4 | `__diag.remoteSync` keeps an LRU of remotes (`droppedRemotes` counts the rest) | `tests/shell_diag_guid_caps.test.mjs` |
| PLUGINSB-2 | vendor-ui reads `window.__sessionHandle` on every call | `tests/vendor_ui_handle_reconnect.test.mjs` |
| RYNTH-1 | the meta engine releases its setmotion keys when EnableMeta goes off, and on a meta load or unload | `tests/rynth_meta_disable_release.test.mjs` |
| RYNTH-2 | a truncated or non-numeric point stops the parse with a warning; its lines go to `tail` | `tests/rynth_nav_truncated.test.mjs` |
| RYNTH-3 | rows × columns are bounded by the bytes left; a zero-column table with rows is rejected | `tests/rynth_met_row_bound.test.mjs` |
| RYNTH-4 | `attemptJumpLeg` takes `isAborted`; STOP, a preempt and dispose cancel it. Reviewer correction in executors.js for a rebound ActiveNav. The orchestrator gave the `/rs jump` job the same cancel (active_nav.js) | `tests/rynth_jump_abort.test.mjs`, `tests/rynth_rs_jump_cancel.test.mjs` |
| FILM-1 | `escapeCell` takes the landscape cell only for an indoor answer or a SeenOutside carried cell; otherwise the room box that holds the eye | `tests/film_review_film1_5.test.mjs` |
| SKY-2 | the SSAO sky sentinel is 6.0e4, which fits a half float | `tests/sky2_ssao_sky_sentinel.test.mjs` (reversed_z Z8 re-pinned) |
| VFXAUDIO-3 | interior static FX lights take `__cellId` from their anchor | `tests/fx_lights_vfxaudio.test.mjs` |
| RUSTNET-3 | `push_pending_confirmation` bounds the queue and replaces a resent request; CharacterConfirmationDone and the answer retire it | native `pending_confirmation_tests` (3); the `tests/server_confirm.test.mjs` source pin follows the helper |
| RUSTCORE-2 | `resolve_degrade_part_frame` is memoised per model, only after a complete read | native `degrade_part_frame_is_memoised_only_on_a_complete_read` |
| RUSTCRATES-1 | the arc cap no longer cuts a deep settle short | native `deep_settle_falls_the_whole_parabola` |
| STREAM-TERRAIN-1 | the LOD re-bake drain drops a parked or childless landblock | `tests/terrain_lod_rebake.test.mjs` |
| STREAM-TERRAIN-4 | the HTTP-version probe falls back to the navigation entry's `nextHopProtocol` | `tests/tex_upgrade_queue_proto.test.mjs` |
| STREAM-STATICS-3 | scene3d/index.js imports `./statics.js` and `./buildings.js` without `?v=`, so each loads once; the index.html modulepreload lines were regenerated | `tests/statics_single_instance.test.mjs` |
| STREAM-STATICS-4 | the whole cell-container subtree is frozen | `tests/cell_freeze_subtree.test.mjs` |
| RENDER-5 | `requestShadowRaster(renderer, scene3d)` re-rasters the scoped lights; the cells.js caller now passes `scene3d` | `tests/interior_shadow_raster_scope.test.mjs`; `interior_shadow_cull` pin updated |
| SKY-3 | `render()` and `setCamera()` share one `_switchCamera` pass list | `tests/sky_late_haze_camera.test.mjs` |
| SKY-4 | the cloud look writes coverage only while the effect still holds the look's own last value | `tests/sky4_cloud_coverage_knob.test.mjs` |
| SKY-5 | fixed by the SKY-1 change | `tests/sky_late_haze_camera.test.mjs` |
| SKY-6 | `blendGrade` fills a reused object | `tests/sky6_color_grade_alloc.test.mjs` |
| SKY-7 | `lastStepAt` is swept on insert once it passes 256 entries | `tests/sky7_dirt_footfall_sweep.test.mjs` |
| ENTITIES-1 | the same-guid rebuild and the appearance fallback mark the release as an internal respawn | `tests/same_guid_respawn.test.mjs` |
| ENTITIES-2 | the re-select restores the pre-release `prevSelectedGuid` | `tests/same_guid_respawn.test.mjs` |
| ENTITIES-3 | identity check (`inst._disposed \|\| entityMap.get(guid) !== inst`) after the awaits | `tests/same_guid_respawn.test.mjs` |
| VFXAUDIO-4 | the portal registry sweeps detached anchors each time the map doubles | `tests/portal_registry_sweep.test.mjs` |
| VFXAUDIO-5 | fx_distort reads the fx clock | `tests/fx_distort_film_clock.test.mjs` |
| SHELL-5 | `__diag.motion.byGuid` is an LRU (`maxGuids` 512) | `tests/shell_diag_guid_caps.test.mjs` |
| SHELL-7 | the preview reads `localStorage` inside a try | `tests/shell_charselect_spawn.test.mjs` |
| PLUGINS-A-3 | book-panel copies the snapshot and frees it and every page box | `tests/commerce_windows_smoke.test.mjs` [book] |
| PLUGINS-A-4 | the hotbar reads the inventory once per merge and frees the boxes | `tests/hotbar_per_character.test.mjs` [8] |
| PLUGINSB-3 | tinker-panel subscribes late | `tests/plugins_late_client_bind.test.mjs` [2] |
| PLUGINSB-4 | landblock-messages subscribes late, stores a real unsubscribe and reads `ev.detail` | `tests/plugins_late_client_bind.test.mjs` [3], [5] |
| FILM-2 | below 10 fps the film clock sub-steps, so world time advances 1/fps per frame | `tests/film_review_film1_5.test.mjs`; a `film_runtime_capture` assertion that pinned the bug was updated |
| FILM-3 | `abort()` always closes the encoder | `tests/film_review_film1_5.test.mjs` |
| FILM-4 | `release()` and `dispose()` restore the look | `tests/film_review_film1_5.test.mjs` |
| FILM-5 | clean_frame sets the nameplate and badge sprites' `layers.mask` to 0, which the LOD loop does not touch | `tests/film_review_film1_5.test.mjs` |
| RUSTCRATES-2 | the MoveToObject heading is read as an offset, and UseFinalHeading is honoured | native `move_to_final_heading_follows_use_final_heading` |
| STREAM-TERRAIN-3 | JS: a per-landblock eviction count stops a build evicted mid-way from marking the landblock populated. Rust: a per-landblock eviction epoch stops a stale build from queuing per-cell products, and the eviction purges the ones already queued | `tests/cell_containers_evict.test.mjs`; native `landblock_evict_epoch_tests` (2) |
| STREAM-STATICS-2 | the create timer checks the anchor epoch; a create that lands after a teardown is destroyed | `tests/static_script_radius_race.test.mjs` R4, R5 |
| RENDER-6 | with no 'ready', the boot grace ends 120 s after the first 'in-world' | `tests/adaptive_res_boot_grace_cap.test.mjs` |
| ENTITIES-4 | identity check in the CallPES arm | `tests/same_guid_respawn.test.mjs` |
| ENTITIES-5 | AnimationCache frees the animation box after its last read | `tests/anim_cache_box_free.test.mjs` |
| VFXAUDIO-2 | lights past 60 m skip both dedupe scans | `tests/fx_lights_vfxaudio.test.mjs` |
| PLUGINSB-5 | a failed `load()` stops the buffering; a later good load classifies again | `tests/world_object_manager_load_fail.test.mjs` |

### 10.2 Related defects fixed beyond the list

- **Entities:** 18 more `.has(guid)` liveness checks after an await became identity checks, including `_fireCreateParticleHook` and the death-motion bake. The orchestrator converted the last two (the spawn arm's default-script resolve and `_playDefaultScriptResolved`) and added `test_a11_s5_default_script_spawn.mjs` 4b2.
- **Render:** once the far-fog probe latches dead the fog shows the authored hex, not its last sample; `draw_sort_program` reads `info` and `properties` live; a stamped material whose `version` moves after a restore draws again.
- **Plugins and UI:** hover-tooltip's null mount client; plugin tests that pre-set `__pluginClient` now follow the production order; `ui/ac_entity_icon.js` frees its inventory boxes (`tests/entity_icon_inventory_free.test.mjs`); a target-bar toolbar disposed before login no longer binds (`tests/target_bar_late_bind.test.mjs`); the hotbar's `_itemUiEffects` frees its inventory snapshot.
- **Shell:** a sweep of every `innerHTML` sink in index.html and app/; the bridge URL and server host are escaped in the "Connecting to" line.
- **Film:** the `seedCell` walk and `cellFromLandscape` under a landscape with buildings no longer escape a sealed cell.
- **Rynth:** the legacy `replayRoute` jump aborts on STOP; the `/rs jump` job is cancelled when its slot leaves and on dispose.
- **Statics:** the unpark rebuild no longer applies the emitter radius to interior anchors; a CallPES loop pending from before a park ends on unpark; overlapping rebuilds never both run a chain. A park while an anchor awaits its part frames (park keeps the landblock in `staticsBakedLbs`) used to double that anchor's chain, or freeze it while detached. Unpark's rebuild now owns its chain, in both the outdoor and the interior attach (`tests/static_script_radius_race.test.mjs` R9, R9b, R9c).
- **Streaming:** an evicted build's `finally` no longer clears a newer build's in-flight bit; the LOD re-bake `refused()` path restores the baked mark correctly.

### 10.3 Verification

- **Full JS gate** (`capped-build node harness/run-js-headless.mjs`, run once after every edit): 801 of 802 suites passed. The one failure, `tests/interior_stab_batch.test.mjs`, was a source pin on the `interior_stab_memo_entry` call that the RUSTCORE-1 change had widened by one argument. The pin now matches the new call, and two pins for the RUSTCORE-1 skip were added. The suite passes alone (25/25); the gate was not run a second time for that one test edit.
- `--coverage`: 0 unregistered test files. All new suites are in the 2026-10-18 TIER5 block.
- `scripts/lint-url-flags.mjs`: 0 undocumented readers. `docs/url-flags.md` rows were updated for layerHaze, cloudCoverage, freezeStaticMatrix, staticScriptRadius, staticScriptHookTime, particleTickOnce and adaptiveResBootGrace.
- `scripts/gen-modulepreload.mjs --check`: up to date.
- **Native Rust tests**, one crate at a time under `capped-build`: `holtburger-world --lib` 1113 passed; `holtburger-core` (simulation filter) 21 passed; `holtburger-web --lib` (pending_confirmation, degrade_part_frame, landblock_evict_epoch) 7 passed.
- **Release wasm** built once and installed in `pkg/` (7,596,650 bytes, same export names, so no stamp bump). The pre-fix build is kept in the session scratchpad (`pkg-backup`).
- Not run: any browser, live client or 1070 session; `pkg-node` is stale (May 15) and `smoke_test.cjs` is not in the gate.

### 10.4 Behaviour changes to expect

- **RENDER-1:** after a context restore, world materials re-link off-frame (64 per drain), so the world pops back in over a few drains instead of freezing for one large synchronous relink.
- **VFXAUDIO-3:** static FX lights inside building rooms (hearths, braziers) now follow the RND-05 room rule. While the player is outdoors they no longer light the street through walls or show through a doorway. The vertex bake still lights the room mesh.
- **RYNTH-4:** a Vitals or Unwedge preempt, a pause or a route edit aborts an in-flight nav jump, which is retried fresh. Once the jump has fired it cannot be aborted.
- **FILM-1:** a camera that starts in, or flies out of, a sealed cell keeps that cell, as retail does. Off the CLI's normal flow this means the outdoors stays hidden.
- **STREAM-STATICS-3:** with one statics.js instance, RP6's cull re-check runs every 6 frames (the configured interval, as the bundle always did) instead of the effective 3 under the double tick.
- **STREAM-TERRAIN-4:** dev serve.py now latches to "h1" instead of staying unknown.
- **SHELL-4 / SHELL-5:** the diag summaries count only the kept guids; `droppedRemotes` and `motion.maxGuids` are new.

### 10.5 Still open

None of these are on the list. Each one's status after the follow-up pass is in §11.1.

- **SHELL-3 residual:** the `/logout` return still forces `?autoLogin=1`, which also switches on agent-mode CSS and `popupDialogAgentSession` (app/popup_string.js). This is pre-existing. A fix would exclude `autoSpawn=select` in both readers.
- **SHELL-2 residual:** picking a different character after a refusal still needs a reload or EXIT, because the wasm never reassigns the player guid once the eager world is built.
- **SKY-1:** the unsplit chain (low and mid, `?particlesOverClouds=off`, `?cloudsMainPass=off`) and indoor split frames still haze world-pass particles. That needs a late particle draw on that chain too.
- **SKY-4:** a knob set to exactly the look's current value (0.5 fair, 0.55 storm) is still overwritten at the next storm edge. A robust fix marks the knob in index.js.
- **FILM-5:** a nameplate created mid-take, or a rig re-stamped by an appearance hot-swap (`_stampEntityIndoorLayer`), can show during a clean take. Both need a hook in `nameplate_sprite.js` or `entities.js`, and only matter with `?nameplates=on` and no `hud=none`.
- **Render restore gaps:** `shadow_caster_list` wraps the boot shadow map, so `?shadowCasterList` and `?shadowStaticCache` are off after a restore; with all three uniform_bind_patch flags off, the unit-16 warning returns after a restore.
- **Rynth:** `route_model.normalizePoint` still maps NaN to 0 for `.af nav:` and JSON route imports.
- **Streaming:** the building, static and scenery collider populate in `app/landblock_stream.js` has no eviction re-check (the same pattern as STREAM-TERRAIN-3; short window). The Rust eviction-epoch map gains one entry per evicted landblock.
- **Statics, `?eagerDungeons=on` only:** a second static ParticleManager now freezes, because the single `_spLoop` ticks only the last manager ensured.
- `index.html` never retries `worldObjectManager.load`. The `shell/app-*.js` bundle is stale; rebuild it with `scripts/build-shell.mjs` if it is served.

### 10.6 Eye tests to queue for the 1070

Hotbar prune, cooldown sweep and icons after login; the barber page; salvage results; a context restore at ultra (materials, occlusion, far fog); the static-script radius at Linvak Tukal 0xA21E; interiors after a park and unpark; the haze over particles at high and ultra (SKY-1); a town at night from outdoors (VFXAUDIO-3); the Town Network `updateMatrixWorld` share after STREAM-STATICS-4.

## 11. Follow-up pass (same evening)

The follow-ups were the §10.5 "Still open" list plus the §7 items that could be fixed and tested without a live client. The 1070 was not available, so **nothing here has been eye-tested**. Per the owner's rule (default-on with an `=off` escape, no eye-test gate), every change ships default-on, and the eye tests are queued in §11.6.

How it ran: four fixer lanes on disjoint file groups (shell, sky, render restore, film/rynth/statics/streaming). Each ran only targeted single tests, one at a time. The orchestrator did the Rust work, the SHELL-2 JS side, the §7 items, a review of every lane diff, the harness and doc rows, then the builds and the gate once, one at a time. Each new test was run against the HEAD copy of the module it covers (a scratch mirror or a loader hook, never by swapping files in the tree) and fails there.

### 11.1 §10.5 items

| Item | Fix | Test |
|---|---|---|
| SHELL-3 residual | `?autoLogin=1&autoSpawn=select` is a person's page (no agent-mode CSS, PopupString dialogs on), except that the /logout return keeps the layout of the page that logged out. The desktop shortcut's agent layout stays full-bleed after /logout through sessionStorage `hbLogoutAgentReturn`, which holds exactly the return query; a manual Connect comes back as a person's page. `app/popup_string.js` `agentModeWanted` is the shared rule, mirrored by the inline toggle in index.html. Orchestrator change to the lane fix: the lane dropped agent mode for every select URL, which would have taken full-bleed away from the shortcut after /logout | `tests/shell_agent_mode_select.test.mjs` |
| SHELL-2 residual | A select before PlayerCreate re-arms kind=1 and hands the eager WorldState to the picked guid (`reassign_eager_world_player`: a fresh PlayerState; the scene and the collision already drained stay). It also drops a PlayerDescription cached for another character. JS re-enables every Spawn button after a refusal, and the plugin WorldState drops the refused character's placeholder Character | `tests/shell_charselect_spawn.test.mjs` (+2), `tests/world-state.test.cjs` (+1), native `reassign_eager_world_player_tests` |
| SKY-1 remainder | `?particlesOverHaze` (default on, `=off` escape): on the unsplit chain (low/mid, or no clouds in the post chain) a `ParticlesOverHaze` pass draws the particles right after `LayeredHazePass`, into the buffer the haze wrote, depth-tested against `composer.depthTexture`. It owns no render target and adds no full-screen pass, and each particle is drawn exactly once. Split frames are left alone on both chains: drawing late there would test particles against the final depth instead of the depth each was drawn against (doorway seal, landscape gate, cells-pass occlusion). What it changes on low/mid, not yet eye-tested: the particles draw after, not sorted with, water and glass, and leave the MSAA world target, and the second ping-pong buffer switches its depth attachment every frame | `tests/sky1_particles_over_haze.test.mjs` |
| SKY-4 remainder | `?cloudCoverage` and `__setCloudCoverage` write through `cloud_storm_look.js` `setCloudCoverageKnob`, which marks coverage as knob-owned; the look never writes it again, whatever the value | `tests/sky4_cloud_coverage_knob.test.mjs` (K4-K6) |
| FILM-5 remainder | A sprite carries the mask it returns to in `__filmCleanMask`. `_stampEntityIndoorLayer` and the mount re-stamp write there instead of the live mask, and `nameplate_sprite.js` hides a sprite made during a clean take (`entityManager._filmCleanNameplates`) | `tests/film5_nameplate_take.test.mjs` |
| Render restore gaps | `shadow_caster_list` re-wraps the WebGLShadowMap a restore builds (it carries `__hbShadowDynamicRoot` and starts the wrapper's type at PCF, as three's new map does). The static cache re-checks its first blits. `uniform_bind_patch` keeps the boot texture-unit limit across a restore with all three flags off (`_installUnitLimitKeeper`), and re-plans the pins back up to the boot limit when a later restore allows it | `tests/shadow_caster_list_restore.test.mjs`, `tests/webgl_restore_render_patches.test.mjs` (PART 2b) |
| Rynth NaN | `normalizePoint` refuses a non-numeric ew/ns (and a present non-numeric z; an absent z is 0). Every caller drops the point and reports it. The atlas importer (`rynth/nav_import.js`) now treats a non-numeric position as no position, repositioned like the EW=0,NS=0 sentinel, never the map origin | `tests/rynth_route_point_nan.test.mjs`, `rynth_navimport_test.cjs` SENT4 |
| Streaming | The building / static / scenery collider populate re-checks eviction after every await (JS). The eviction export also drops the products a populate staged before it (`purge_pending_populate_products`), which the next drain would otherwise insert right after its clear. Eviction-epoch entries live only while a build of their landblock is in flight (`LandblockBuildEpoch`). Plus: the "player's landblock first" sort compared a signed int32, so for an x byte >= 0x80 the centre landblock went fifth | `tests/collider_populate_evict.test.mjs` (P0-P7), native `landblock_evict_epoch_tests` (3) |
| Statics, `?eagerDungeons` | Every static ParticleManager is ticked once per frame (`_staticParticleMgrs`), by both the rAF loop and the loop-clock driver. Also on the default path: two landblocks reaching their first scripted attach together each built a manager, and the orphaned one froze its emitters. Concurrent first attaches now share one build | `tests/static_particle_managers_tick.test.mjs` |
| WOM load | index.html retries a failed `worldObjectManager.load` after 2, 5 and 15 s and stops at `pagehide`. The shell bundle is served only by `scripts/proxy.cjs` through `scripts/shell_gate.cjs`, which swaps it in only while every input hash matches the live tree and rebuilds it in the background otherwise, so no manual rebuild is needed | `tests/shell_wom_load_retry.test.mjs` |

### 11.2 §7 items

- **far_terrain `RADIUS POLICY VIOLATION`:** fixed. The invariant is now "a far landblock the player was never within `pvsRingRadius + 1` of" (`notePlayerNear`), since the near ring keeps what it baked after the player moves on. `farLbKeys` drops the landblocks of a retired patch, and a heightmap fetch that lands after its patch retired adds nothing and frees its boxes. `tests/far_radius_policy.test.mjs`.
- **cells.js cancel path (`?drawPools`):** fixed. A build cancelled because a newer build of the landblock started no longer releases the pooled cells the newer build fed (`releaseCancelledBuildPools` releases only when the landblock was evicted, as `dropOwnWalls` already did). `tests/envcell_pool_cancel_gen.test.mjs`.
- **rejection_feedback reconnect gap:** fixed. A boot-state listener re-wraps the SessionHandle a reconnect builds and re-points the facade at the proxy. `tests/rejection_feedback_reconnect.test.mjs`.
- **entities.js `_spawnMotionStash`:** fixed. `remove()` drops the motions stashed for the spawn it invalidates. Before, a spawn that never committed kept its entry, and the next spawn of that guid replayed its stale base motion (only the actions are age-limited). `tests/spawn_motion_stash_remove.test.mjs`.
- **entities.js legacy chain-walker Sound timers:** fixed. The Sound, SoundTable and Scale timers leave the guid's `_soundTimeoutsForGuid` array when they fire (the CallPES timer already did). One that fires before the walk merges its ids is skipped there. `test_phase7_batch9_entity_lifecycle.mjs` #24b.
- **camera.js `?camDebug` `cs.sessionHandle`:** not a bug. camera.js defines a `sessionHandle` getter (`Object.defineProperty` in the constructor) that calls `_getSessionHandle()`.
- **owner_registry `_epochs`:** left as designed. Pruning it was tried and reverted: statics.js `_scheduleStaticCreate` reads the owner epoch for timer-deferred creates, so an entry has to outlive every timer that captured it. It is one number per owner key ever destroyed.
- **picking.js SERVER_SWING reader:** left. Both readers (loop.js and picking.js) and the url-flags row agree on `!== "off"`; changing one would split them.
- **Not attempted** (they need design, a live session or an eye test):
  - rust-core: the MOTION_ACTIONS drain and SHADOW_REFRESHED_AT.
  - rust-crates: the physics-parity items, and the shard budget default.
  - blood_decals / carnage default bus handlers: fixing them turns on decals on real traffic. (Done in §12: `?combatFxBus` is now default-on.)
  - corpse-window target mode and paperdoll self-target (features).
  - particle `_materialPool`.
  - film `dispose()` during a take, the cast-table parse, R5#13, `trail_map.dispose`, the double sky evaluation, static_batch_x sizing, streaming-residency-5, and `ensureBakeRig`.

### 11.3 Related defects found by the lanes

- **Fixed:**
  - `scene3d/frame_split.js` disarm after a restore put the dead map's `render` on the new shadow map, so shadows would never re-raster again (diag only). It now restores onto the map it wrapped (`test_frame_split_probe.mjs` PART 9).
  - The single-shadow path (`?shadows=on` without CSM) kept an empty sun map for up to 12 frames after a restore. The mover-scope gate now keys on the shadow map object (`tests/shadow_mover_scope.test.mjs` R).
- **Not fixed:**
  - three keeps the dead context's dispose listener on reused targets: at most one "object does not belong to this context" log.
  - `NavProfiles.get` drops a stored point with a null coordinate without a warning (it has no warnings channel).
  - The portal exit fields (`exitEW/NS/Z`) still default to 0.

### 11.4 Behaviour changes to expect

- **/logout from a manual Connect:** returns to a person's page (no agent-mode CSS, PopupString dialogs). From the desktop shortcut it is unchanged.
- **After a refused Enter World** (character still in the world, server full): any character can enter, with no reload.
- **Route imports:** a waypoint with a non-numeric position is dropped with a warning instead of becoming a waypoint at 0N 0E. `.af` NAVDATA imports now report their parse stops.
- **Static particle effects:** effects on a manager that an overlapping first attach used to orphan now animate (default path).
- **`?farDiag`:** no longer errors after a walk or a teleport. `farLbsTouched` now counts the far ring's live landblocks, not every landblock it ever fetched.
- **`?particlesOverHaze` (default on):** on low/mid (the unsplit chain), a near spell or campfire is no longer hazed by the distance of the hills behind it. Particles there now draw after, not sorted with, water and glass, and without the world MSAA. `?particlesOverHaze=off` restores the old frame.

### 11.5 Verification

- **Lanes:** targeted single tests only, one at a time, after checking `free -m`. Every new test was run against HEAD copies of the modules it covers and fails there.
  - Method trap: a scratch mirror has to copy `harness/` as well when a test loads modules through `harness/lib/import_edited.mjs`, because that helper resolves the app root from its own location. With `harness/` symlinked, the "HEAD" run silently tests the working tree.
  - Rule slip: the sky lane once started the full gate under plain node, by mistake (a loop over files that mention the cloud modules matched `harness/run-js-headless.mjs`). Its 300 s timeout killed it, available memory stayed at 2.5 GB or more, and its result was discarded.
- **Full JS gate** (`capped-build node harness/run-js-headless.mjs`): the first run passed 813 of 814 suites.
  - The one failure was `harness/test_suite_hygiene.mjs`. It rejected the first version of `tests/envcell_pool_cancel_gen.test.mjs` as a new pure source pin.
  - The decision moved into `cells.js` `releaseCancelledBuildPools`, which the test now executes. The hygiene suite passes (30/30), and so do the 20 suites that load cells.js, each run alone after that edit.
  - Re-run after that fix: 814 of 814 passed.
- **Bare-default boot** (headless Chromium, SwiftShader, one tab, the owner's bar: loads, spawns, 0 console errors): `?nosw=1&autoLogin=1&account=…&autoSpawn=first` and nothing else. In world after 13 s, boot state `ready`, 0 console errors, 0 page errors, 13 warnings. Quality resolved `mid`, so the unsplit chain ran: `ParticlesOverHaze` was built and active (22 drawn frames over the window), and the pass list ended `EffectPass[NanScrub], LayeredHazePass, ParticlesOverHaze, EffectPass[…]`. `__farTerrainState().ring.policyOk` was true.
- **Static checks:**
  - `--coverage`: 0 unregistered (12 new suites in the 2026-10-18 follow-up block; 9 existing suites gained cases).
  - `scripts/lint-url-flags.mjs`: 0 undocumented readers. Rows were added or updated for `particlesOverHaze`, `agent`, `autoSpawn=select`, `popupDialog`, `cloudCoverage`, `layerHaze` and `farDiag`.
  - `scripts/gen-modulepreload.mjs --check`: up to date (434 modules).
- **Native Rust**, under `capped-build`: `holtburger-web --lib` (landblock_evict_epoch, reassign_eager_world_player, pending_confirmation, degrade_part_frame) 9 passed. The wasm-only changes (`lifecycle.rs`, `purge_pending_populate_products`) are compiled by the release build.
- **Release wasm**, built once and installed in `pkg/`: 7,600,576 bytes. The JS export surface is unchanged, so no cache-bust stamp bump. The previous build is kept in the session scratchpad.
- **Outside the gate:** `rynth_navimport_test.cjs` (SENT4) belongs to the 69 root `rynth_*_test.cjs` files the gate does not run. It was run by hand (17/17), together with `rynth_goto_compose_test.cjs` and `rynth_navbatchimport_test.cjs`.
- **Not run:** a live-client eye test or any 1070 session.

### 11.6 Eye tests to queue for the 1070

1. **Login:** manual Connect, play, `/logout`, ENTER. The layout should match a manual Connect, and `@modifystring popup_motd x` should open a dialog. Then the desktop shortcut and `/logout`: still full-bleed.
2. **Refused Enter World:** log a character in from a second tab, then press ENTER on it here (refused), then ENTER on another character. It enters, its nameplate is hidden and it moves as the player.
3. **`?particlesOverHaze` (default on):**
   - At `?quality=mid` and `?quality=low`: a campfire, portal or spell ~30 m away against distant hills, toggled with `__particlesOverClouds.set(false|true)`. Expect no blue-grey wash and no doubled or missing particles. Check particles near water and glass windows, and compare fps with and without the flag.
   - At `?quality=ultra&clouds=off`: the same scene.
   - If it fails, `?particlesOverHaze=off` is the escape; flip the reader back to opt-in.
4. **Context restore at ultra** (`__loseContext()`, then `__restoreContext()`): `__shadowCasterList.stats.reinstalls === 1`, rig shadows track with no smear, and the static cache keeps refreshing. With `?texUnitPin=off&lightUbo=off&lightUploadOnce=off` there should be no "Trying to use 16 texture units" warning. With `?shadows=on` the sun shadow should be back on the first frame.
5. **`?eagerDungeons=on`:** dungeon braziers animate together with the outdoor static effects, and a busy town's fountains and braziers animate on every landblock.
6. **Collision after streaming:** portal out of the Training Academy (0x8602) and back; building and tree collision are still there.
7. **`?filmMode=on&nameplates=on`:** a take in which an NPC spawns into shot and the player re-equips shows no nameplate, and the plates come back after the take.
8. **`?farDiag`:** a teleport tour (`@telepoi` x5) leaves no `RADIUS POLICY VIOLATION` in the console, and `__farTerrainState().ring.policyOk` stays true.
9. **SKY-4:** `?clouds=on&cloudCoverage=0.5`, then `__setWeather({is_storm:true})`. Coverage stays 0.5.

### 11.7 Still open after the follow-up pass

- **SKY-1 on the unsplit chain ships default-on without its eye test** (owner rule), so eye test 3 above is the check. `?particlesOverHaze=off` is the escape.
- **Every eye test in §10.6 and §11.6 is still pending.** No 1070 was available, so every render-visible fix in §10 and §11 is verified only headless.
- **Split frames** (indoors with `?indoorDepthSplit`, and `?punchRetail=off`) still haze particles on both chains (§11.1 SKY-1, reasons given there).
- **§7 items not attempted** and the related defects not fixed: §11.2 and §11.3.
- **Nothing from the follow-up pass is committed.** The fix pass is `b20cdc37`; `pkg/` holds the release build of the working tree.
- The flags flipped after this pass, and what they still owe, are in §12.

## 12. Eye-test-gated flags flipped default-on (2026-10-19)

The owner's instruction after §11: "default on what would be on after a successful eyetest". The 1070 is still unavailable, so every flag below now ships default-on **ahead of** its eye test. Each keeps an `=off` escape (`off`/`0`/`false`/`no`, any case), and its eye test becomes a post-flip A/B against `=off`. That check is still owed.

How the list was made:
- **Sweep.** Four finders searched different sources: url-flags.md rows, JS readers and comments, Rust consts and readers, and handoff and eye-test docs. They returned 125 raw candidates, 44 after merging duplicates.
- **Verification.** For each candidate, a code skeptic and a history skeptic tried to show it was held off for a reason other than the eye test, and a planner wrote out the flip. A flag ships only when no skeptic found such a reason, or, where the run was repeated, when three of the four votes said flip.
- **Flipping.** Eight agent lanes flipped 11 of the 14 flags, and the orchestrator flipped `tweenClock`, `barberMotionTable` and `negFace`. Each flip came with its targeted tests and the two flag audits. The orchestrator reviewed every reader diff, ran the native Rust tests and the release wasm build (`negFace` is read in Rust), the full gate and the bare-default boot.

### 12.1 Flipped

| Flag | What changes on a bare-default page | Escape | Eye test still owed |
|---|---|---|---|
| `particleSharedAlpha` | Static and world alpha particle buckets with the same key share one sorted bucket (fixes one cutting the other through alphaTest depth writes). | `=off` | Chimney + world plume overlap at Holtburg (0x1000fbf), 360° sweep, no missing or flickering smoke. |
| `particleCellGate` | Interior static emitters in cells the walk hides stop drawing (the simulation keeps running), as retail's `CObjCell::IsInView`. | `=off` | Big dungeon: flames in hidden rooms do not draw through walls; a lit hearth seen through a door still draws. |
| `particleDegrade` | Every DAT emitter freezes and hides beyond its authored degrade distance (100 m default) instead of the 220 m RP6 cap. Sky-chain emitters (moon nebula, storm lightning) are exempt. | `=off` | Pop distance of portals, lifestones, braziers, spell effects. |
| `rigCellGate` | Indoors, a rig in a hidden cell, or an outdoor rig while the walk sees no outside, is not drawn or pickable. | `=off`, live `__setRigCellGate(false)` | Populated multi-room dungeon; cottage turn-to-door case. |
| `indoorLandscapeGate` | Indoors with no outside view, the landscape, sky and depth wipe are skipped; cracks show the cleared colour, as retail. A throw in its cell state now fails open instead of disarming `?indoorDepthSplit`. | `=off`, live `__setIndoorLandscapeGate(false)` | Holtburg meeting-hall back room; no missing walls or props on skip frames, no flash on a fast turn. |
| `portalFovFade` | Teleports and the login tunnel use the retail FOV zoom fade instead of the far-plane shrink + black quad. | `=off` | Teleport outdoors; `__adaptiveRenderScale.changes` unchanged across a teleport. |
| `radialFog` | Range (radial) fog on terrain, far ring and statics, as retail `D3DRS_RANGEFOGENABLE`: no fog shift with yaw, a little more haze at the frame sides. | `=off` | Holtburg clear day A/B; re-check `horizonFogNear` 0.62 (0.7 if the mid-field washes out). |
| `combatFxBus` | Blood decals and carnage (limp, sever, finisher) fire from real combat for the first time (both were default-on since 2026-08-02 but their bus handlers read the Event, not its detail). | `=off` (`?blood=off`, `?carnage=off` remain the gore switches) | 3-4 mob melee fight: no fps collapse, decals on the right targets. |
| `terrainRock` (`TERRAIN_VFX_PROMOTED.rock`) | At high / ultra: 18,000 lit pebbles + 600 grit streaks on rock terrain. Low / mid unchanged. | `?terrainRock=off` | R1-R9 look pass and the R-list perf check (<= 1.5 ms at ultra). |
| `tweenClock` | The Scale-hook tween (and the jump-pose tween under `?jumpPose=overlay`) runs on the loop's dt clock with the mixers, so it pauses through DT_RECOVERY instead of jumping to its end. | `=off` / `=wall` | Alt-tab 5 s mid-ramp; induced hitch `?targetFps=5`. |
| `negFace` (Rust) | SidesType-2 polys lose the reversed back tri (retail never shows the back texture from behind); NoPos polys on textured surfaces draw with UV slot 0. The same-winding front copy still needs `?perPolyCull=on`, which stays off, so a two-sided wall shows its front face from behind. | `=off` / `=legacy` | Interior wall with distinct front/back textures, both sides; no shimmer, z-fighting or missing geometry. |
| `barberMotionTable` | An Empyrean barber Apply swaps the local motion table at once (retail `SetMotionTableID`) instead of at the next login. | `=off` | Empyrean `@barbershop` Apply, walk/run/turn; no T-pose or sliding. |
| `surfaceUnified` | Surfaces decode through the single retail `SetSurface`-style decoder on every path. Headless proof: legacy and unified give identical materials on the cache path (70/70 and 210/210 cells). The one real change, entity-owned recolours stop being flat-opaque, is not reached in production today. With it on, `?luminousEmissiveMap=off` and the stamp half of `?skipDeadBatch=off` need `&surfaceUnified=off`; `surfaceParityV2` stays opt-in. | `=off` | Recolored-luminous lifestone or glow gear; a recoloured NPC in a translucent robe. |
| `retailFov` | Retail's aspect-derived camera FOV (acclient.c:144897) and the Field of View slider: vertical 60° becomes ~53.6° at 16:9, ~73° at 4:3, ~40° at 21:9; portrait windows go past 100°, as in retail. Things tuned at 60° shift: the moons read ~12% larger at 16:9, `texUpgradeFullM`'s 32 m acts like ~36.5 m, follow framing changes. | `=off` (60°, no Field of View row) | Camera framing, moons, texture-upgrade pop band, near-plane at high slider values. |

### 12.2 Changed along with the flips

- **`particleDegrade`:** sky-chain emitters (the moon nebula and the storm lightning, which ride an anchor 40 m above the camera) are exempt from the authored degrade distance, so the flip cannot hide the sky glow (`test_a11_s4_particle_degrade.mjs`).
- **`cells.js`:** the landscape gate's cell-state build in `tickCellVisibility3D` has its own try/catch. Before, a throw there fell into the split's outer catch and silently disarmed `?indoorDepthSplit`; now it fails the gate open (`tests/indoor_landscape_gate.test.mjs`, fails against the old code).
- **`rigCellGate`, `indoorLandscapeGate`:** their live toggles (`__setRigCellGate`, `__setIndoorLandscapeGate`) and diag readers install under `=off` too, so either arm of the A/B can switch live.
- **`terrainRock` reader:** `on`/`off` are accepted in any case and with whitespace; `=on` still forces rock on at every tier.
- **`app/popup_string.js` `agentModeWanted`:** restructured with the same logic, so `scripts/audit-flag-defaults.mjs` reads `autoLogin` as the opt-in it is. The §11 version tripped a DEFAULT-POLARITY finding.
- **Docs:** url-flags.md rows for every flipped flag (values, default, reader, eye-test cell as a post-flip A/B), the 2026-10-13 section's flag-policy paragraph, stale cells for `terrainGrass` / `terrainIce` / `terrainVfx` (grass and ice have shipped at high/ultra since 2026-10-07 and 2026-08-01), the `tweenClock` row (it now covers only the Scale-hook tween, plus the jump-pose tween under `?jumpPose=overlay`), and `docs/quality-presets.md` (rock). An entities.js comment that still called `luminousEmissiveMap` "Default OFF" was corrected.

### 12.3 Kept off, with the reason

Each was checked by a code skeptic, and also by a history skeptic when the code skeptic found nothing. Every one is held by something an eye test alone would not settle.

| Flag | Why it stays off |
|---|---|
| `partDegrade` | The 2026-10-13 visuals rule keeps retail's NULL-level hide opt-in ("retail's hide stays behind an opt-in like `?partDegrade`", webac findings render-perf-3), and its flip criteria include a draws/fps A/B nobody has run. Three of four votes against. |
| `cellStaticMerge` | Its fps gain is unmeasured (2026-10-17 re-evaluation, 6422a96b), and the flip criteria ask for a draw-census delta. |
| `reversedZ` | ~~Already ran on the 1070 and failed (4bfde09e), and its perf gain is unmeasured.~~ **Superseded 2026-10-19 (fps review, `docs/2026-10-19-fps-review.md`): flipped DEFAULT ON.** 4bfde09e is the FIX for that failure (cloud-shadow frustum under reversed NDC), d3bd9bb7 fixed the base-Camera bake throw, and `harness/glsl_smoke/reversed_z_smoke.mjs` passes both modes on SwiftShader. Its perf stays unmeasured on the 1070 (`?reversedZ=off` is the A/B arm); the June "no-win" was a CPU-bound measurement. |
| `selectionFlash` | The flash writes through `_getOrCloneEntityMaterial`, whose plain `clone()` drops the default-on `?lightClamp=retail` patch, so every clicked NPC would keep stock PBR lighting until it despawns. Fix the getter first (webac lighting-materials-6 follow-up 1). |
| `envDetailTex` | Its own follow-up requires a detail-aware building bucket before any default flip; without it, the flag disables building batching (worse since `?buildingMatBatch`, 78e89aa5). |
| `negFace` part (2) and `perPolyCull` | `perPolyCull` has a real-GPU regression (R9 290, reverted 2026-07-06); `negFace`'s same-winding front copy needs it. |
| `defaultScriptPartChild` | A type-18 hook census over client_portal.dat was set as a prerequisite and never run. |
| `retailDegrade` | Its pass bar includes a 1070 triangle/fps check at 50-150 m. |
| `aceObjMaint` | A correctness risk ("a predicate bug would drop a live monster mid-fight") that needs a live combat soak, not a look. |
| `missileImpactScript` | Tied to the open "spell explodes right in front of me" env-sweep bug, which this flag makes visible; also needs a check that bolt PhysicsScriptTables carry a 0x5A row. |
| `viewerLight` | Already rendered on the 1070 (2026-10-09 `retail7` arm); the owner has the shots and has not decided. |
| `DEFER_LOGIN_COMPLETE_AFTER_TELEPORT` | A later analysis (openac round 3) found its deferral point is the wrong edge and plans to retire it. |
| `USE_EXHAUSTION_RUN_RATE` | Its prerequisites are unwired (`report_exhaustion` is staged dead code). |
| `USE_ETHEREAL_RECHECK` | Ruled wrong: it models the wrong retail path (openac 2026-10-04 doors F4, "keep it OFF"). |
| `particleClock` | `=sim` freezes particles during the DT_RECOVERY frames, which PROJ-VIS (d17c9b9f) later ruled a bug; and it is an enum whose mode was never chosen. |
| `surfaceParityV2` | Its remaining parts were mostly absorbed by default-on flags, and a verification ruling says not to flip it. It now rides on `surfaceUnified`. |
| `castRangeWarn` | Its eye test ran and failed (the far-leg toast never fired, cast-campaign residual 2026-07-13). |
| `castCamBias` | Does not work even when on: its caller calls `setCastBiasTarget` on the raw camera, not the CameraSwitcher. |
| `castFacing20` | Dormant: its only consumer runs under three face-target flags the owner turned off (2026-10-07). |
| `castVfxDedup` | Its double fire is gone (`?castSyntheticCasterVfx` is off), so it would only add non-retail behaviour. |
| `portalPass2` | An unfinished approximation (24 m building proxy; no `GetClip`, inward flood or `copy_view`). |
| `stableDepthShare` | Tied to the swamp P6 fog adjudication, and the swamp family failed its eye test. |
| `wavePrefetch` | A cold-boot perf A/B, not a look; the instrumentation it needs is missing. |
| `playerDepenetrate` | A deliberate opt-in backstop, only for a regression that has not come back. |
| `indoorDoorways`, `botPortalAvoid` | Bot navigation that needs a live egress soak, not a look. |
| `entityLights` | Not joined to the default Setup-light path, so on it would give lit entities a second set of lights. |
| `sortCenter` | Known inter-object ordering defect (the fixed -100 renderOrder band). |
| `skyWeather` | A non-retail placeholder (random streak texture instead of the DAT GfxObjs). |
| `EMIT_READY_FALLBACK` | Obsolete: the local cast no longer animates, so the question it waited on no longer applies. |
| `statGeomDedup` | Waits for a 1070 perf/memory re-base, not a look. |
| terrain sand, snow, volcano, dirt | Their speculars still catch the sun at night (no `uSunGlint` term; look-pass 2026-10-08 #85). Volcano would also put a second ember system on volcanic ground (fx_fields embers already ship at high/ultra). |
| terrain swamp | Failed its eye test ("not really impressed", 2026-08-01): needs a design pass. |
| terrain trail | Already implied on wherever a writer is on. |
| `sceneryBake` / `BakeMode` | The browser already defaults to retail (owner, 2026-10-17); only the bake CLI's enum default differs. |

### 12.4 Verification

- **Lanes:** targeted single tests only, one at a time, plus `scripts/audit-flag-defaults.mjs` and `scripts/lint-url-flags.mjs` for each flag. Every test that pinned an old default now pins the new default and the escape in both directions, and executes the shipped reader.
- **Native Rust** (`capped-build cargo test -p holtburger-web --lib`, filtered to negFace, substitution, geom_bundles and differ tests): 43 passed. `neg_face_flag_parse_defaults_on` pins the new default and the escapes; the other negFace tests keep the legacy arm as their explicit baseline.
- **Release wasm**, built once for `negFace` and installed in `pkg/`: 7,601,324 bytes. The export surface is unchanged (only a doc comment differs in the `.d.ts`), so no cache-bust stamp bump. The previous build is kept in the session scratchpad.
- **Full JS gate**, run once after every lane merged (`capped-build node harness/run-js-headless.mjs`): 814 of 814 passed.
- **Static checks:** flag audit 0 polarity and 0 comment mismatches; `lint-url-flags` 0 undocumented readers (1031 flags); `lint-event-consumers` 0 findings; `gen-modulepreload --check` up to date (434 modules); `--coverage` 0 unregistered.
- **Boot checks** (headless Chromium, SwiftShader, one tab at a time, the owner's bar: loads, spawns, 0 console errors):
  - Bare default (`?nosw=1` + login automation only; quality resolved `mid`): in world after 22.6 s, 0 console errors, 0 page errors, 11 warnings. Camera fov 53.64° at 16:9 (`retailFov`), 8 shared alpha buckets, `radialFog` installed with both terrain programs patched, the two indoor gates on and unarmed outdoors, far-ring policy ok.
  - `&quality=high`: in world after 18.8 s, 0 console errors, 0 page errors, 6 warnings. The rock pebbles and grit fields were built; the split chain ran (`ParticlesOverClouds`).
  - Indoors: the same boot, then `@teledungeon 0007` (the Town Network) for 80 s, then `@telepoi Holtburg`. 0 console errors, 0 page errors. `rigCellGate` armed (outside count 0); `particleCellGate` hid up to 12 interior emitters. `indoorLandscapeGate` stayed fail-open the whole time (`not-resident`: not every reachable cell was resident under SwiftShader), so its skip frames were not exercised headless.
- **Not run:** any 1070 session or live eye test.

### 12.5 Still open after the flips

- **Every eye test in §12.1 is owed**, now as a post-flip A/B against `=off`. Until it runs, each flag ships on the strength of headless tests and the boot checks above.
- **`indoorLandscapeGate` skip frames** were never seen in a browser (§12.4); the first 1070 dungeon check should confirm them.
- **`surfaceUnified` couples two escapes:** `?luminousEmissiveMap=off` and the stamp half of `?skipDeadBatch=off` need `&surfaceUnified=off` too (documented in their rows).
- **Work that would let more flags flip** (§12.3): fix `_getOrCloneEntityMaterial` so a clone keeps the light-clamp patch (`selectionFlash`); multiply the sand/snow/obsidian/mud speculars by `uSunGlint` and coordinate the volcano embers with fx_fields (sand, snow, volcano, dirt); run the type-18 hook census (`defaultScriptPartChild`); fix the doorway env-sweep false stop (`missileImpactScript`); re-validate `perPolyCull` on a real GPU (`negFace`'s front copy).
- **Stale mentions left alone:** the historical records (HANDOFF-webac-comparison-2026-10-13.md, docs/webac-comparison-2026-10-13/*, the film-mode recon docs) still call these flags opt-in. `harness/perf-walk*.mjs`, `harness/diag-1070.mjs` and the film session URL still pass the old enable values (`=on`, `=retail`), which are now redundant but harmless.
- **Nothing is committed.**
