# HANDOFF — cold-load metrics, the retail character screen, a 1070 eye-test pass (2026-10-09)

One autonomous session, no agents. The 1070 was free (nobody at it for 10+ hours; a Roblox client
idling minimized) and was driven off-screen, muted, with its own Chrome profiles, under a presence
monitor that would have killed only the test Chrome if anyone came back (§2).

## 1. The owner's prompt (verbatim)

The `/goal`:

> see recent commits for holtburger-web and get aquainted. the 1070 might be available for muted vistesting but actively check if anyone is working on it and set up a monitor should they return you will know about it. there are items left to do like packs in chests you need vision for so thats an item you can do. we had 5 rounds over the last 2 days with the mostly nonvisual openac stuff so you can pick through that to see how you can leverage the 1070. i'm open to you constructing the teardown page (character selection) but my concern would be that if someone is playing for the first time there should be some sort of cold loading that kicks off immediately as if they were dumped ingame, because it can take 5+ minutes to cold load (although maybe its faster after all these changes) so get metrics on that. no agents and work autonomously

Mid-session:

> you dont have to use 666 that was a specific scenario. use your raw upload and download

> you dont need to use cloudflare at all

## 2. The 1070 and the presence monitor

- `scripts/perf-worker/box/idlewatch.ps1` runs hidden in the logged-on user's session (schtasks `/it` →
  `wscript idlewatch.vbs`; GetLastInputInfo only sees the calling session, and SSH is another one) and
  writes the keyboard/mouse idle time every 5 s. `hbwho.ps1` adds lock state, desktop browser windows and
  the 3D-engine load of other processes (a gamepad player shows up there, not in idle).
- `scripts/perf-worker/coldboot/watch1070.sh` ran under the Monitor tool the whole session (re-armed every
  30 min) and would have killed only the `D:\Temp\hbbench\` test Chrome on PRESENT. It never fired: the
  box sat at 10–12 h without input, Roblox open and idle (0 % GPU), all session.
- Raw link for every measured run (owner, mid-session): the 1070 fetches straight from the laptop's
  tailnet address (`100.116.47.66`, direct LAN WireGuard, 60–78 Mbit/s single-stream), no Cloudflare, no
  throttle; a counting relay in front of the public front (`proxy.cjs` :7080, bundled shell + `/wsbridge`)
  logs every byte, the game socket included. CDP alone rides an SSH tunnel.

## 3. Cold-load metrics (first visit: fresh Chrome profile, empty cache)

| run | link | spawn | form | in-world | sky `ready` | first statics | first terrain | ring settled | on the wire |
|---|---|---|---|---|---|---|---|---|---|
| 4 | raw tailnet | Holtburg | 3.5 s | 5.9 s | 10.5 s | 5.9 s | 17.6 s | **83 s** | 258 MB |
| 1 | SSH-tunnel LAN | 0x5BA6 (open land) | 3.8 s | 8.0 s | 8.0 s | 11.4 s | 19.2 s | 64 s | 179 MB |
| 2 | 666 kbps + 40 ms (before the owner dropped this scenario) | Holtburg | 112 s | 132 s | 149 s | 149 s | **458 s** | 630 s | 48 MB |

So on a real link a first-time player is in the world in ~6 s, sees ground at ~18 s and a settled
Holtburg at ~1.5 min — not 5+ min. What they see (run 4): sky over a dark void at ~10 s, houses with no
ground at ~20 s, grass + lifestone + NPCs at ~40 s, distant hills/trees/river by ~85 s. Run 2 (unbundled
by accident, §4.1) is the slow-link reference: 7.6 min to the first terrain, which exposed the
regression fixed in §4.2.

Frames: `scratchpad` captures are not committed; rerun with `scripts/perf-worker/coldboot/` (README).

### 3.1 The first-time player's spawn: the Training Academy

Every new character starts inside its start area's academy (Holtburg 0x8602, Shoushi 0x7F03, Yaraq
0x8C04, Sanamar 0x7202; cell 0x01AD). Same rig (1070, fresh profile, raw link, bundled page),
`scripts/perf-worker/coldboot/academy.mjs`:

| run | build | in-world | academy cells visible | notes |
|---|---|---|---|---|
| bundled1 | before | 4.5 s | **75.1 s** | 1,136 cells: the player's 0x8602 AND the 0x8502 copy |
| net1 | before (+ resource timing) | 7.7 s | 74.1 s | the breakdown below |
| skirt1 | + `envcellSkirtWait` (§4.6) | 4.4 s | 70.1 s | one academy (568 cells) |
| seam1 | + decode fix deployed (§4.8) | 9.4 s | 59.7 s | texture phase 24.9 → 12.8 s |
| hold1 | + `interiorHold` (§4.9) | 8.3 s | 51.6 s | 72 MB downloaded by the academy instead of 154 MB |
| link3 | + GPU-probe memo, `farBakeCompileAsync` (§4.10–4.11) | 4.5 s | 50.6 s | blocking shader links 7.4 → 2.9 s |
| final1 / final2 | + `envcellStaticsOverlap` (§4.12) — **today's build** | 4.5 / 8.3 s | **46.7 / 47.9 s** | **42.2 / 39.6 s after in-world** (was 65.7) |
| wiz60 | today's build, Create Character open 60 s first (`wizwarm.mjs`) | 2.1 s after Enter | **2.1 s after Enter** | academy built behind the wizard in ~31 s |
| nodelay1 / 2 | + `serve.py` TCP_NODELAY (§4.14) | 4.4 / 4.3 s | 37.9 / 39.1 s | 33.5 / 34.8 s after in-world |
| allA1 / allA2 | + HD / texchan hold (§4.17) — **final build, 2026-10-09 09:45** | 4.4 / 4.3 s | **35.6 / 36.4 s** | **31.2 / 32.1 s after in-world**; 57 MB by then |

Same-build runs vary by about ±4 s (link3 46.1 s vs prof2 39.3 s after in-world), so compare the
"after in-world" times across several runs. Experiments, not shipped: `?targetFps=10` while loading,
39.4 s (texture step 12.8 → 8.9 s, record fetch unchanged); `?packSource=on`, 47.3 s (cell records
in 12 s instead of 24 s, but the texture step then started 18 s later).

So a first-time player stood in a black void for ~70 s, not a hang (the earlier "stall" resolved
every time it was waited out). Where the time goes (net1/skirt1):

- **~28 s fetching the academy's records** — 568 EnvCells + Environments + statics, one HTTP request
  per record (`/dist/shards/xx/<hash>.bin`; ~3,300 page requests by 35 s). The raw tailnet link is
  plain HTTP/1.1, so they queue behind Chrome's 6 connections per origin (1,154 in flight at 10 s,
  medians 1–5 s each), and ~100 MB of OUTDOOR assets share the pipes during an indoor spawn: terrain
  t1024 promotion (~40 × 1.36 MB at 22 s), terrain macro/normal maps, atmosphere EXRs, moons.
  The public Cloudflare route is HTTP/2, so the queueing part is likely smaller for real players —
  not measured (owner: no Cloudflare).
- **~19 s decoding 232 surfaces in the bake worker** with the network idle: ~92 % of it is
  `holtburger_dat::height_seam` (grey_morph 56 %, gaussian_blur 15 %, relief_height 6 %,
  value_noise 6 %) — a per-tap `wrap()` (two integer `%`) in every separable pass, ~1 µs per texel.
  Main-thread repro: 299 cached surfaces (9.8 Mpx) take 10.5 s of pure decode. Fixed in §4.8
  (built, NOT deployed).
- ~5 s statics + mesh instantiation.

Where today's ~40 s goes (final1/final2, from the start of the interior build):

- **~20 s record fetch** (`fetchEnvCellsInLandblock`): ~2,100 one-record requests at ~100/s, with 20–25
  in flight. That is Chrome's 6 HTTP/1.1 connections on the raw link; the main thread is not the
  limit (capping rendering at 10 fps did not shorten it). Fewer requests (packs, §6.2) is the only
  real lever here, and HTTP/2 on the public route should help.
- ~6 s between the records landing and the texture decode starting (the bake worker's queue).
- ~11 s texture decode + statics + instantiation, competing with the render loop.

## 4. What shipped

### 4.1 The public front served the unbundled page for two days (`scripts/shell_gate.cjs`)
`plugins/lifestone-popup.js` (+ manifest) was deleted on 10-07, but the bundle manifest still listed it.
The gate stamped a missing input as "changed now" on every check, so its quiet-period wait restarted
forever and the rebuild never ran: every first-time player since 10-07 got the unbundled page (~376 JS
requests, ~3.95 MB gzip, vs 15 files / ~1.35 MB). A deleted input now counts as a finished change, and
a failed build backs off 5 min instead of re-running per request (`harness/test_shell_gate.mjs` +4).
The running proxy keeps the old code until it is restarted (owner's call — it drops live sessions); the
bundle was rebuilt by hand at 23:31 and the old gate serves it again since the stale input is gone.

### 4.2 Ground first on low-bandwidth sessions (`scene3d/bandwidth_tier.js`, `terrain_bc7.js`, `terrain.js`)
Run 2 showed the slow-link regression: at 666 kbps the first terrain landed at 7.6 min (10-06: 3.4 min).
With no pack controller the t512 promotion's "converged" signal was the page's `ready` latch, which since
10-06 fires when the sky is up — before any terrain — so ~10.5 MB of promotion payloads (plus the 3.4 MB
moon PNGs) shared the line with the ground's own records. Now `terrain.js` latches
`window.__groundDrawnAt` when the first terrain mesh attaches; on a LOW session the promotion waits for it
(ceiling 300 s, was 120 s) and the moons load after it (`holdForGround`). Fast sessions are unchanged.
Not re-measured at 666 kbps (the owner dropped that scenario); pinned by
`harness/test_terrain_tier_ladder.mjs` (+2) and `test_bandwidth_tier.mjs` (+5).

### 4.3 The retail character screen, the warm-up, `/logout` (the "teardown page")
- `app/character_select.js` — gmCharacterManagementUI / layout 0x21000004 rebuilt from the DAT (art
  0x06007576 as WebP, frame 0x06004D64; `data/ui-sprites/INDEX-charselect-2026-10-09.json`): World,
  Characters (retail order, pending deletions greyed + last, Restore on them), Create Character (the
  wizard), ENTER (drives the hidden developer list → the unchanged spawn flow), Delete (type DELETE,
  sends the wire slot), Exit. Shown on a manual Connect (`?charSelect=off` escape) and on
  `?autoLogin=1&autoSpawn=select`; never for other autoLogin URLs (agents, rigs).
- **Cold load starts on the screen** (`app/spawn_preview.js`, `?spawnPreview=off`): every character's
  spot is remembered per server+account+character (landblock change, every 15 s, page close, `/logout`);
  while the screen is up the selected character's spot streams through the position stream's own
  loaders (`liveScene3d.previewSpawnArea`: fixed-grid terrain ring + 3×3 buildings/statics, or the
  EnvCells indoors) with the camera framing it, and the location-independent terrain chain warms either
  way (`warmTerrainAssets`). A character created on the screen starts with its start area's Training
  Academy as its spot (catalog `starterAreas[].firstLocation`). Pre-spawn the LRU evicts nothing and the
  terrain LOD re-centres on the first real landblock change, so a wrong spot only costs bandwidth.
- `/logout` (`/logoff`): retail gmGamePlayUI Log Out — refused in mid-air, else "Logging off..." +
  0xF653, wait for ACE's CharacterList, end the session with the new **`SessionHandle.disconnect()`**
  (retail DISCONNECT 0x8000; `holtburger-session::Session::send_disconnect`), reload into
  `autoSpawn=select` (password in this tab's sessionStorage, as `?autoLogin` keeps it). Page close sends
  the disconnect too, so ordinary reloads no longer meet ACE's "Account In Use" (it dropped BOTH sessions
  when the old one was still alive).
- The wasm cache stamp is `wasmrev-20261009a` (index.html + the bake/net workers).

### 4.4 The char-gen wizard could not open (two pre-existing bugs, found from the new screen)
- `getCharacterGenCatalog` / `getSkillCostsForHeritage` / `getCharacterGenAppearanceStrips` serialize
  serde_json through serde_wasm_bindgen, which makes every JSON object a JS `Map`; the wizard reads
  plain objects, so `openWizard` saw no heritages and refused ("catalog not loaded"). The rynth host now
  converts (`rynth/webhost.js` `plainFromMaps`; `tests/chargen_catalog_plain.test.mjs`).
- In agent mode (`?autoLogin=1`) the wizard was invisible: its overlay had no `hb-` id, and agent mode
  hides every body child not named that way. It is now `#hb-charcreate`.

### 4.5 Packs inside chests and corpses (extcontainer-5, `?extNestedPacks`)
Retail gmExternalContainerUI's container row: the ground object's cell + its packs above the strip;
a click opens a pack in place; drops follow the open container (a drop on a row cell goes into that
container); Loot all takes the open container's items, then (on the ground object) its packs whole;
an open pack that leaves reopens the ground object (ItemList_OpenFirstContainer). Pure view in
`plugins/ground_container_rules.js` (`externalContainerView`); `tests/inventory_dnd_dom.test.mjs` (+7),
`tests/ground_container_gate.test.mjs` (+2).

## 5. 1070 eye-test pass (rounds 1–5 queue + this session)

All off-screen, muted, fresh profile, bundled shell, raw link. PASS = seen and correct.

| item | result |
|---|---|
| extcontainer-5 nested packs (new, `?extNestedPacks`) | PASS. A real Sack (Ruby / Apple / Health Draught inside) in a real generator chest: the row shows the chest cell (gold open arrow) + the sack cell (icon, 3/24 capacity bar); clicking the sack shows its three items, the count reads "Sack: 3 items" and the arrow moves; a double-click takes an item (ghosted until the server answers); clicking the chest goes back. The nesting itself was simulated in-page — ACE (`Player_Inventory.cs`) only lets a container into a Player or a house Storage, and no test character owns a house. **Queue:** a real house storage chest with a pack in it. |
| pk-5 character panel PKStatus row | PASS ("Player Killer" under the template line; nothing clips). |
| vendor-buy-5 categories | PASS (All Items first, then the 18 retail filters incl. Books, Paper / Keys, Tools / Magic Items). |
| vendor-buy-1 Buy All without the money | PASS ("You don't have enough money" in chat; the list stays; "You need 6,030 more pyreals"). |
| extcontainer-4 locked chest | PASS ("The Storage is locked" as the on-screen notice — retail text type 0x1A is never a chat line; ACE's ChatMessageType notes say so). |
| chargen (round 5) | PASS after two fixes (§4.4): "bob2 SMITH" → "Bob Smith"; Skills page 52/52 with Run, Jump, Magic Defense, Loyalty, Salvaging, Arcane Lore trained and their tier locked; the Summary of a default Bow Hunter; **Create worked against live ACE** ("Eyetest Halvar", the CG_Pack checksum accepted) and the character entered at the Holtburg Training Academy (0x860201AD). |
| the character screen (new) | PASS: retail art, World box, list, Create Character, ENTER, Delete/Restore, Exit; the new character selected after Create; ENTER spawns. |
| `/logout` (new) | PASS for the log-off half (9.9 s from typing it to the reload; spot + selection remembered); the return failed on the first build because ACE dropped both sessions ("Account In Use") — fixed by `disconnect()` (§4.3). |

### 4.6 The interior skirt waits for the player's own interior (`?envcellSkirtWait`, default on)
`scene3d/cells.js` `tickPvsLoadExpansion`: the `envcellRing` radius-1 skirt no longer starts while a
render-set landblock's own EnvCell build is in flight. Inside the academy nothing knows the dungeon is
sealed until its cells are built, so the skirt started the west neighbour 0x8502 — a second 568-cell
academy — beside it. Measured −5 s (skirt1); a failed own build leaves the in-flight set, so it never
blocks for good. `tests/envcell_skirt_wait.test.mjs` (5).

### 4.7 The warm-up covers a first-time player
- An account with **no characters** warms the academy a new character starts in as soon as the
  char-gen catalog has loaded (`app/character_select.js`, `newCharacterSpot` in
  `app/spawn_preview.js`; previously nothing location-specific loaded for an empty account).
- The wizard reports its start area (`ctx.onStartArea`, on open and on each change —
  `plugins/character-creation.js`), and index.html points the warm-up at that area's academy, so the
  academy streams the whole time the player is building the character.
- Tests: `tests/spawn_preview.test.mjs` (+2, real catalog values), `tests/character_select.test.mjs`
  (+1), `tests/character_creation_reopen.test.mjs` (+3).
- **Not yet measured on the 1070** (`coldboot/wizwarm.mjs` is written for it).

### 4.8 Surface decode ~10× less work per texel (`crates/holtburger-dat/src/height_seam.rs`) — DEPLOYED 2026-10-09 07:20
The separable passes now read their windows from a wrap-padded row and a wrapped row table instead of
calling `wrap()` per tap; the chamfer distance transform (now `chamfer_dt_wrapped`), `value_noise`
and `seam_normal_rgb8` use precomputed tables too. Same operands in the same order per element, so
the output is **bit-identical** — pinned by 5 new tests against verbatim copies of the old loops
(`tests::reference`, sizes down to 1×1 and windows wider than the texture). `cargo test -p
holtburger-dat --lib height_seam`: 24/24. Release wasm built to `apps/holtburger-web/pkg-seam/`
(6,962,560 B). Deployed: `pkg-prev-20261009b/` holds the previous `pkg/`, `rsync -a --delete pkg-seam/
pkg/`, stamp `wasmrev-20261009b` (index.html ×6, bake_worker.js ×3, net_worker.js ×2,
net_worker_client.js ×2; `node test_wasm_preload_stamp.mjs` 7/7). On the 1070 the academy's texture
phase went from 24.9 s to 12.8 s (seam1).

### 4.9 Indoor spawns: the interior before the outdoor downloads (`?interiorHold`, default on)
`tickPvsLoadExpansion` (cells.js) publishes `window.__interiorBuildPending` (the player is indoors
and a render-set LB is neither built nor out of retries). The t1024 terrain promotion (68 MB) and the
macro maps (9 MB) wait while it is true, with a 3-minute ceiling (`bandwidth_tier.js`
`interiorBuildPending` / `holdForInterior`, `terrain_bc7.js` `_schedulePromotion`, `terrain.js`
macro load). They had started ~10 s after in-world and shared the six connections with the academy's
records. Diag `__terrainBc7Stats().ladder.interiorHeld`. Tests: `tests/interior_hold.test.mjs` (6) +
PART 11 of `harness/test_terrain_tier_ladder.mjs` (131).

### 4.10 The GPU-tier probe runs once per page (`scene3d/quality.js`)
`getQuality()` ran `detectGpuTier()` on every call, which creates a throwaway WebGL context, and every
surface material calls `getQuality()` (the POM patch): ~290 contexts and 1.4 s of main thread per
academy spawn, plus a `[quality] gpu-probe` log line per material. Memoised, logged once.
`tests/gpu_tier_probe_memo.test.mjs`.

### 4.11 The far-terrain bake program links off the main thread (`?farBakeCompileAsync`, default on)
Found with `coldboot/academy.mjs --linkmap`: one program, `far-terrain-bake`, linked synchronously for
**4,963 ms** ~15 s after in-world (ANGLE/D3D11, fresh profile = no program cache). That one freeze
caused the 20–26 s gap with no record requests. `far_terrain.js` `bakeProgramReady` now runs
`renderer.compile` with the patch's render target bound and a real landblock geometry on the rig mesh,
then polls three's non-blocking `program.isReady()`; bakes wait for it. Trap: compiled over the rig's
empty placeholder geometry, three's key differed in one bit (`vertexNormals`, bit 23), so the first
bake still linked a second program for 3.4 s. Diag `__farTerrainState().ring.stats.bakeCompileMs`
(~10.8 s, now off the main thread). `tests/far_bake_compile_async.test.mjs`.

### 4.12 The statics fetch overlaps the surface decode (`?envcellStaticsOverlap`, default on)
`buildEnvCellsForLandblock` starts Step C's `fetch_model_meshes` (up to 8 sequential discovery
rounds) before awaiting Step B's surface preload, instead of after it. Texture-to-cells step
12.8–13.1 s → 10.6–11.1 s. A failed early fetch is reported exactly as before.
`tests/envcell_statics_overlap.test.mjs`.

### 4.13 Fallout fixed, tooling
- `tests/login_retail_rules.test.mjs` read the first 900 characters of the `pagehide` handler; this
  session's location flush + disconnect pushed `h.free()` past that, so it now reads the whole handler.
- `test_visual_ground.mjs` requires `noteVisualGroundBake` straight after `terrainGroup.add(lbMesh)`;
  the "ground first" latch now sits after it (both synchronous, same behaviour).
- `coldboot/academy.mjs --profile` (main-thread CPU profile → `acad-<label>.cpuprofile`) and
  `--linkmap` (time blocked per GL program, named via `renderer.info.programs`).
- `coldboot/watch1070.sh`: polls every 15 s; PRESENT also on any input since the last poll; a
  browser-only signal needs two polls (07:53:19 false PRESENT: our own Chrome mid-relaunch reported no
  command lines). After PRESENT, AWAY needs 15 min with no input.
- Full gate (`capped-build node harness/run-js-headless.mjs --quiet`): **493 passed, 0 failed**.

### 4.14 `serve.py` answered every keep-alive request ~42 ms late (TCP_NODELAY)
Replaying the academy's 2,138 record requests on the laptop itself (no network, 6 keep-alive
connections, `coldboot/replay.mjs`) took 15 s at a flat 42 ms each — p50 = p90 — and 24 req/s on one
connection, against a 2.4 ms RTT to the 1070. Nagle held each response body until the client ACKed the
headers, which Linux's delayed ACK holds ~40 ms; it began when `serve.py` moved to HTTP/1.1 keep-alive
on 2026-06-11. `Handler.disable_nagle_algorithm = True` (`scripts/serve.py`): 0.7 ms per request, the
same replay in 0.75 s (1.1 s through the proxy). It sits behind the public route too (cloudflared →
proxy.cjs → serve.py). **The live `serve.py` was restarted at 08:43** with its original launch line
(`start-holtburger-stack.sh`), log appended to `/mnt/wbterminal1/tmp/cloudflared-tunnels/serve.log`.

What remains in the academy's ~14 s record fetch is round-trip structure, not bytes: ~130 bursts of
the dependency walk (Setup→GfxObj→Surface→…), each waiting on Chrome's six connections (network p90
0.6 s under a 650-request burst) and then on the main thread to deliver each body (p50 0.19 s, p90
0.70 s after `responseEnd`; `academy.mjs --fetchmap`). Capping rendering at 10 fps saved ~2–3 s. The
real cut is fewer, bigger responses — the pack path (`?packSource=on`): fetch 8–9 s instead of 15–16,
but its texture step then started 7–9 s later (net ~3 s), so it needs that looked at before the
owner-gated flip.

### 4.15 Town Network: portals (and every entity particle indoors) were invisible
`?indoorDepthSplit` arms in every indoor cell: world pass (layer 0) → full depth wipe → cells pass
(layer 1). Entities live on layer 1, but their particle meshes defaulted to layer 0, so the walls and
floor painted over every entity effect in every dungeon. The Town Network's portals are just a
fully-transparent 8×8 quad plus particles, so all 40+ looked like empty alcoves (lit magenta by their
lights). `__diag.portalEmitterState()` reported them live, in frustum, OK_VISIBLE; enabling layer 1 on
the particle buckets made them appear. Entity-anchored emitters (default scripts, hook-13
CreateParticle, PlayEffect VFX) now pass `renderLayer: entityParticleRenderLayer()`
(`scene3d/particles/render_layer.js`; `?indoorParticleLayer=off` keeps them on 0).
`tests/entity_particle_layer.test.mjs`.

### 4.16 Town Network: the portal tunnel dropped the player into a void
Portal space released after a 6 s "cells wait" failsafe, but the Town Network's interior took 16 s
after arrival: ~10 s of portals, signs and paintings hanging in grey nothing in front of the outdoor
mountains around landblock 0x0007 (the "big mountains" report). `?portalHoldBuild` (default on): past
6 s it keeps holding while the destination landblock is in `envCellBuildInFlight`, hard cap 60 s.
`test_portal_space_sequencer.mjs` (41).

### 4.17 Town Network: 263 MB, almost all of it HD textures, now after first paint
`townnet.mjs` + `hbns.py`: entering the Town Network downloaded 1,160 shards = 207 MB — **200 MB of it
151 `tex-xu7` records** (HD upscaled RenderSurfaces, up to 4.1 MB each) — plus 290 texchan sidecars =
98 MB, against ~1 MB of actual DAT records (413 cells, geometry, surfaces). Both are post-build
upgrades (the surface shows its retail albedo first), so `?interiorHold` now also holds the full-tier
record fetch (`bc7_textures.js` `_begin`) and texchan fetches (`suite_assets.js`) while an indoor
player's interior builds. First entry from a settled Holtburg: **walls 17.4 s → 9.4 s, 139 MB → 14.5 MB
downloaded by then**; the HD set still streams in afterwards. A fresh-profile login straight into the
Town Network (allF1): in-world 4.6 s, walls 28.1 s.

### 4.18 Town Network lighting (found, NOT changed)
- The 16 point-light slots are all taken by portal lights (every portal carries a 7.8 m magenta/green
  light; 47 entity lights, zero cell lights as candidates in the hall), so lit areas follow portals.
- Interior ambient follows the outdoor clock: with `?ibl` the environment intensity is the diurnal
  probe value (0.2 floor at night, more by day), so the same hall is bright red by day and dim at night
  (tn1 vs tn4). Retail fixes it for enclosed cells: `SetWorldAmbientLight(0.2, 0xFFFFFFFF)` when the
  player's cell is neither outdoor nor `seen_outside` (acclient.c:146720–146742); the diurnal
  `calc_object_light()` only applies outdoors / SeenOutside. A look change for every dungeon — owner's
  call.
- White textures in the lower level (z −6, cells 0x0100–0x0109) did not reproduce once loaded; on a
  slower link they were most likely surfaces still waiting behind the 263 MB.

## 6. Open items

1. Nothing is committed (no instruction to). `pkg/` is deployed (stamp `wasmrev-20261009b`) and the
   live `serve.py` runs the TCP_NODELAY fix (§4.14).
2. Record-fetch structure (§4.14): the pack path halves the academy's fetch but its texture step then
   starts 7–9 s later — find out why before anyone considers the owner-gated `?packSource` flip.
3. Indoor lighting (§4.18): retail's fixed 0.2 white ambient in enclosed cells, and portal lights
   monopolising the 16-slot pool — owner decisions.
4. The Town Network's HD set (200 MB xu7 + 98 MB texchan) still downloads in full after first paint;
   on a slow link that is minutes of sharpening. The `?bandwidth=low` tier skips it.
5. A no-characters account was not run live (unit-tested); a returning player on a new browser has no
   saved spot (by design).
6. Pre-existing: 512 `glBlitFramebuffer` WebGL errors per page; chargen face swatches show "#N"; a
   house storage chest with a pack in it is unchecked; the running proxy needs a restart to pick up
   the shell_gate fix (§4.1).

## 7. Resume prompt

> Continue the 2026-10-09 cold-load / Town Network work in external/holtburger/apps/holtburger-web.
> Read docs/HANDOFF-charselect-coldload-2026-10-09.md §3.1, §4.14–4.18 and §6 first. On the 1070
> (check presence first: scripts/perf-worker/coldboot/README + watch1070.sh under Monitor; restart
> idlewatch (`schtasks /run /tn hbidle`, delete idlewatch.stop), the relay and the -L 9333 tunnel),
> `townnet.mjs` measures Holtburg → Town Network; `academy.mjs` the new-character spawn (`autoSpawn=first`
> = the most recently played character — log "Eyetest Halvar" in once first). Pick from §6. Run the
> full gate under capped-build after any change. Do not push or commit unless the owner says so.
