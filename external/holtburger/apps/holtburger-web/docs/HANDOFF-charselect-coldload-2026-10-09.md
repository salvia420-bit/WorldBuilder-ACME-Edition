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

## 5b. Cold-load structural pass (ultracode session, 2026-10-09 afternoon)

The owner's brief ("Cold-load structural changes — ultracode brief", Claude Docs) asked to halve what was left of
a cold interior load by changing how records reach the client, each change behind a default-on flag with an
`=off` escape, measured on the 1070 before and after. Run as: baseline on the 1070 → 4 read-only investigation
agents (A+B, C, D, E), each design note adversarially reviewed against the code → implementation agents (A0,
A+B v2, A+B v3, C, D), each diff reviewed by a second agent → one release wasm, full gate, 1070 measurement.
Working notes, reviews and every run's JSON: `/mnt/wbterminal1/tmp/claude-scratch/coldload-1009/` (`RESULTS.md`,
`notes/`, `acad-*.json`, `townnet-*.json`, `E/`). Nothing is committed.

**Final numbers (Phase 4 + round 3 on `wasmrev-20261009e`, 16:14–17:38; all guarded by the presence daemon):**

| Scenario | Baseline | Bar | Final (runs) |
|---|---|---|---|
| Academy walls after in-world (cells attached) | 31.7 / 29.7 s | ≤ 15 s | 10.8, 9.5, 9.6, 13.0, 12.1, 10.3, 8.9 s |
| … visible (tunnel reveal), with the 0.25 s quick fade | — | — | 11.4, 14.7, 12.7, 12.4, 14.3 s |
| Academy record fetch | 16.2 / 14.7 s | ≤ 4 s | median 3.2 s over 7 runs (5.0 / 5.1 s in two runs with slow network rounds) |
| Town Network walls after teleport | 10.5 / 10.4 s | ≤ 5 s | 5.9, 4.1, 4.1, 4.2 s (+ 4.2 / 4.3 with `portalSpaceFps=off`) |
| Town Network MB before the walls | 18.3 / 17.6 | no increase | 1.8–1.9 |
| Linkmap: programs > 100 ms at first draw | 4 (up to 512 ms) | none | 0 / 0 |
| Full JS gate | 494 / 0 | green | 509 passed, 0 failed |

Controls on the same build: all 24 new flags off → academy fetch 10.2 / 12.3 s, walls 30.4 / 31.5 s; Town Network
9.4 / 9.5 s. `interiorWallsFirst=off` → walls 27.1 / 28.2 s. All D flags off → walls 13.9 / 11.4 s (no tunnel).
`retail` tunnel → reveal 17.7 / 16.9 s. Packs on (A2) → walls 12.4 / 9.1 s (was ~30 s before A2). Warm path:
`loginSkip=resident`, Enter → cells 2.1 / 1.1 s. Outdoor Holtburg cold login: first terrain 15.8 / 11.7 s (default)
vs 14.8 / 15.8 s (`loginPortalSpace=off`). B: page hop (worker → wasm) p90 18 / 43 ms meets the 50 ms bar; the
brief's network-end → wasm p90 is 0.15–0.18 s (the worker-side hash block above; `?shardHashSlice` targets it).

**Measured earlier in the day (two runs each; walls = the interior's cell containers attached):**

| Scenario | Baseline (10:11) | Bar | Final build (14:19, `wasmrev-20261009d`) |
|---|---|---|---|
| Academy walls after in-world | 31.7 / 29.7 s | ≤ 15 s | **11.1 / 12.4 s** (tunnel reveal 11.8 / 14.5 s; furniture 22.1 / 26.9 s) |
| Academy record fetch (build start → placements) | 16.2 / 14.7 s | ≤ 4 s | **3.6 / 2.0 s** |
| Town Network walls after the teleport | 10.5 / 10.4 s | ≤ 5 s | **4.0 / 5.0 s** (furniture in at 10.5 / 10.6 s) |
| Town Network MB before the walls | 18.3 / 17.6 | no increase | **1.7 / 1.7** (walls + 10 s: 31 / 35 MB, was 112–124) |
| Full JS gate | 494 / 0 | green | **505 passed, 0 failed** |

Isolation on the final build: all 13 new flags `=off` → fetch 12.0 / 11.3 s, walls 30.5 / 29.4 s, Town Network
9.5 / 10.5 s (the escapes restore today); `interiorWallsFirst=off` → walls 23.1 / 22.4 s;
`shardFetchWorker=off` → walls 11.0 / 10.9 s, fetch 3.1 / 3.4 s, delivery p90 0.60 / 0.48 s (on: 0.20 / 0.27 s).
Steps: A0 alone cut the fetch to 5.4–6.3 s (walls 29 s); + A1-lite/C/D/coalescing/share → walls 24 s; + walls
first → 11–12 s. Every run's JSON is in `coldload-1009/` (`RESULTS.md` has the full ledger).

### 4.19 Interior statics in one walk (`?interiorStabBatch`, default on)
`fetchEnvCellsInLandblock` awaited one urgent keyed walk per first-seen Setup inside its per-cell loop, so each
Setup's parts cost their own network round, back to back. In the academy (0x8602: 568 cells, 200 distinct stabs =
170 Setups + 30 GfxObjs, 215 parts) the parts arrived in ~68 bursts from 10.0 to 23.9 s (baseA1) and ~80 bursts
from 10.05 to 20.4 s (baseA2): 10–14 s of the 12–16 s record fetch (`coldload-1009/ab_fetchrounds.mjs`). Now one
urgent keyed walk over every 0x01/0x02 stab (`walk_setup_parts_with_geom`; key `fetchEnvCellsInLandblock:stab-batch`
+ LB) runs joined with the Environment prefetch and replaces the top-record batch: tops, then parts +
MotionTables, then idle Animations. Same flag:
- Batch-mode walk (`src/batch_walk.rs`, `prefetch::ensure_walk_prefetched_keyed_batch`): keys that still fail after
  a round's 3 tries are excluded and discovery continues (the legacy `run_walk_loop` stopped discovering there, so
  one bad record silently sent the whole landblock back to the ~70-round per-stab path). Same stall guard and
  8-round cap; reports rounds/fetched/failed. The per-stab walks stay as the fallback.
- Per-build stab memo: when the batch settles, each stab id's local AABB, default script, default animation and
  collision BSPs are computed once and reused for every placement. Academy cell loop: ~1.7 s → ~0.1 s CPU.
- Yields: once after the joined stage, then every 12 ms via a MessageChannel post (no nested-setTimeout clamp, no
  hidden-tab throttling; deliberately NOT `scheduler.yield()`, whose continuation jumps ahead of the fetch
  deliveries and worker replies the build yields for); none while the document is hidden.
Console: `[interiorStabBatch] 0x86020000: N stabs, K ms, rounds R, fetched F, failed X, perStabFallback P, loop cpu
C ms / wall W ms, Y yields`. Not changed: the batch is urgent for every build, ring/skirt builds included.
`tests/interior_stab_batch.test.mjs` (19) + `cargo test -p holtburger-web --lib batch_walk` (7, not yet run).

### 4.20 Early interior bake (`?interiorEarlyBake`, `?surfaceWalkLite`, default on)
The bake worker's Step B (cell surfaces) and Step C (cell statics' meshes, then their surfaces) started only after
`fetchEnvCellsInLandblock` resolved, though their inputs are on the EnvCell records.
- `?interiorEarlyBake` (JS, `scene3d/cells.js`): for the player's own landblock, `buildEnvCellsForLandblock` calls
  the new export `fetchEnvCellDepsInLandblock(lb)` in the same turn as its own fetch (only the LandblockInfo and
  EnvCell rounds, same urgent keys, so both calls share every request) and when the deps resolve posts Step B's
  preload and Step C's mesh fetch on the build's lane; the build's Steps B/C join that work. Any failure = the old
  path. index.html threads the export into `init3D` opts through the namespace import (a stale pkg yields no field).
  Trap found on the 1070: the first final-build runs had `__interiorEarlyBake.kicked = 0` because init3D's opts
  object is an explicit list — the export existed but cells.js never saw it.
- `?surfaceWalkLite` (wasm, both instances): `fetch_surfaces_pixels`' discovery rounds walk the surface records only
  (`walk_surface_pixel_records`: alias → Surface → SurfaceTexture → `highest_res` Texture → the Palette for
  P8/Index16, the decode's exact read set) and each DID is decoded once after the walk, instead of a full decode in
  every round. Same output, same requests; decode CPU no longer sits between the worker's discovery rounds.
`tests/interior_early_bake.test.mjs` (10), `tests/surface_walk_lite.test.mjs` (4).

### 4.21 Surface-job coalescing and one interior build per landblock
- `?bakeSurfaceCoalesce` (default on, cap 64 DIDs; `scene3d/bake_worker_client.js`): `MaterialCache.get(did)` posts
  one surface per worker message. Town Network first entry queued ~113 of them (bw.q 117–120, 4 in flight, ~30/s
  from 3.2 to 9.4 s after the teleport) while the walls waited — that, not the records (in by 1.3 s), was the Town
  Network's 10 s. The queue pump now folds every same-lane, same-urgency `fetchSurfacesPixels` still queued into the
  message it posts and splits the reply per caller (repeat DIDs get deep copies, `provenAbsent` partitioned,
  `decodeMisses` = merged total, any worker error rejects every member into its own main-thread fallback). No timers;
  a lone request posts unchanged. Diag `__diag.bakeWorkerStats().queue.coalesce`.
- `?interiorBuildShare` (default on; `app/landblock_stream.js` + one call site in `cells.js`): the collision populate
  and the mesh build each ran `fetchEnvCellsInLandblock` for the same LB — the academy's cell loop twice, and every
  cell static BSP / portal polygon queued twice (`insert_cell_static_physics_bsp` / `insert_cell_portal_polygon`
  APPEND, so collision held doubles until the next eviction). `globalThis.__hbInteriorBuildShare` hands concurrent
  callers one promise; cells.js is the only reader/freer of the handles.
- Also fixed (not flagged): `__onLandblockEvicted` built its key without `>>> 0`, so for every landblock with x ≥ 0x80
  (the academy included) its set clears never matched and a revisit never re-populated collision.
`tests/bake_surface_coalesce.test.mjs` (15), `tests/interior_build_share.test.mjs` (16).

### 4.22 Progressive HD textures (`?texUpgradeQueue`, default on; `?texchanJoin`, `?texWorkerEager`)
- `scene3d/tex_upgrade_queue.js` admits every full/pre/twin/texchan fetch of the production MaterialCache, ordered
  by a scene-graph visibility index: surfaces in the cell render set nearest first; inside `?texUpgradeFullM`
  (32 m) the full record goes straight away, then texchan; pre only beyond 32 m (one in flight); background
  (`?texUpgradeBgShare` 0.3): beyond 32 m, resident, unknown holder; hidden or orphaned holders park.
- Pace: 3 in flight / 2 big on HTTP/1.1 (6/4 on h2/h3, 1 under 1 MB/s); no xu7 dispatch while > 8 transcodes are
  queued; a token bucket only indoors or within 30 s of a resume. Outdoors: order + cap only (work-conserving).
- Pause = `__interiorBuildPending` (pre is now held too). A job is dropped only with no live waiter AND no holder →
  `TEX_DROPPED`, no negative cache. CLIP gate, vetoes, ask-once, re-point-before-dispose, record budget unchanged.
- **pre = retail resolution** (full = 4× retail per axis; pre = its level 2), so `texUpgradeBgShare=0` (the "mid
  tier") means **no HD beyond D_full**, not a quarter-res middle step. Owner decision.
- **Scope deviation (needs sign-off):** "no surface on preview >10 s while in view" is enforced within 32 m
  (`report().inView`); the unscoped `maxWaitMsAll` is reported alongside.
- `?texchanJoin`: `getByKey` + `getByKeyAsync` fetched every texchan stem twice — fixed on both queue arms.
- `?texWorkerEager` (D3-b): the texture worker boots with the production cache; a loading worker is awaited (≤10 s)
  before the main-thread FIFO; the bc7 gate accepts ready/loading.
`tests/tex_upgrade_queue.test.mjs` (22+).

### 4.23 Login portal space and load-time main thread (Workstream D)
- `?loginPortalSpace` (default `quick`; `retail`; `off`): the first EnteredWorld of a login requests the retail
  tunnel (acclient.c:143092); portal_space.js decides on its first tick — spawn cell already resident (char-screen
  warm path) → no tunnel, no sound (`loginSkip=resident`); otherwise the world stays hidden until the spawn cell is
  resident, with the teleport build-aware hold (6 s, then while building / `__interiorBuildPending`, 60 s cap;
  outdoor 6 s). `quick` fades out the tick after ready; `retail` adds CONTINUE 2–5 s. Skipped for `agent=1`,
  `bot=1`, `nullRender=1`, `renderOnDemand=1`, `wireframe`, `portalSpace=off`. Still not ported: LoginComplete
  timing (ACE materialises the player during the tunnel; combat mode is refused while it runs).
- `?portalSpaceFps` (default 30) paces the loop while the tunnel owns the frame (login and teleports);
  tickPerFrame (net pump, PVS, interior builds) keeps running. `?portalSpacePrecompile` links the tunnel +
  fade-overlay ShaderMaterials off-thread against the canvas (black until ready).
- `?asyncLinkKeySig` (D2): the academy's own cell-surface programs (baseline: 5 links, 449–716 ms, 2.8 s, 1.5–4 s
  after the cells attach) were asyncLink's trusted/rate-capped draws of a KEY change: a prewarmed material's
  first-draw deferral counts as a no-op, one HD albedo re-seat makes it trusted, and the texchan sidecar
  (roughness + AO maps) then linked in the draw. The guard now fingerprints the material's key inputs (type
  included); a fingerprint change is compiled off-frame, a fingerprint already linked by another surface draws at once.
- `?alphaMaskSlice`: the 273 ms TexMerge alpha-mask build runs one layer per task (byte-identical).
- Tooling: academy.mjs `--linkmap` (msInRender, draw in flight, stacks, full keys, sibling diff), `--progdump`,
  `--shots`, `ps` rows, `tunnel*` + `wallsVisible` summary, `pageClockSkewMs`; `ltattr.mjs`; wizwarm/sess sample
  `__portalSpace`.
`tests/login_portal_space.test.mjs` (82), `tests/async_link_key_sig.test.mjs` (44), `tests/alpha_mask_slice.test.mjs` (23).

### 4.24 Interior walls first (`?interiorWallsFirst`, default on)
After 4.19–4.21 the academy's record fetch was 3 s, but `buildEnvCellsForLandblock` still attached nothing until
Step C (the 200 statics' meshes, 5.6 s in the bake worker, then their 232 surfaces in one 13.9 s
`fetchSurfacesPixels` call) although the walls only need Step B (41 cell surfaces, decoded by ~13.8 s): walls at
24 s after in-world. Now, for a build with cell statics, Step C runs in the background while Step D builds,
prewarms and attaches the walls/floors/ceilings exactly as before (layer 1, frozen matrices, `cellContainers3d`);
when Step C settles the statics are built into a detached staging group, prewarmed, residency-checked and moved
into the live containers. Only then is the landblock built (`envCellLoadedLbs`, in-flight release, result,
default-script/animated attach), so `__interiorBuildPending`, `interiorHold`, the texture-queue pause, the skirt
wait and the watchdog read "building" as before. The login/teleport tunnel releases on the spawn cell's container
(`destinationCellsReady`), i.e. at the walls; the furniture follows (~10 s at the academy). **Owner trade-off:**
during that gap wasm collision already has the furniture (a player can bump into undrawn statics) and the walls
stay on retail-resolution textures until the statics land; `=off` restores "everything at once". Eviction / park /
a newer build between the stages cancels to today's end state (walls removed from scene, registry and park stash;
geometries disposed); the next build of the LB drops an older build's stashed walls at its own attach (a
park → unpark race found in review). Console `[interiorWallsFirst] envcells 0x…: N cells attached after X ms —
S static models still to come` / `… K statics attached after Y ms`; counters `window.__interiorWallsFirst`.
`tests/interior_walls_first.test.mjs` (12).

### 4.25 Records delivered off the main thread (`?shardFetchWorker`, default on)
With the main thread 90–97 % busy during a load, a finished shard response waited longer for its body to reach
wasm than the network took (final build: network p90 0.34–0.38 s, netEnd→body p90 0.35–0.56 s). Now the main
instance's shard fetches (manifest_source.rs Step D; catalogs and manifests stay direct) go through
`scene3d/shard_fetch_worker.js` (import-free module worker, so no wasm stamp site; in build-shell's
`WORKER_ENTRIES`): `scene3d/shard_fetch_client.js` coalesces one batch message per microtask, the worker fetches
each request at once with its priority, verifies sha256 against the catalog hash (crypto.subtle in a secure
context, else a pure-JS sha256 — the raw tailnet origin is insecure) and returns bodies as transferred buffers
(flush at 64 entries / 4 MB / 8 ms). Rust (`holtburger-resource-http` `fetch_shard_bytes`, `shard_route.rs`;
export `register_shard_fetcher`) skips its own re-hash only for bodies the worker verified for that task's own
request; a mismatch comes back unverified and fails the key as before. Dedup (`urgent:{url}`), permits, priority,
404 tolerance, the tolerant round, the round bracket are unchanged; unregistered = today's path. A worker error,
failed post or 15/30 s of silence rejects everything pending, terminates the worker and unregisters (fetches go
direct; the walk retries). Diag `__diag.shardFetch()` (deliverMs/totalMs p50/p90/max); the client fills
`__fetchMap` in page-clock time and `coldload-1009/fmapsum-b.mjs` reads the worker's resource timing.
`tests/shard_fetch_worker.test.mjs` (27), `cargo test -p holtburger-resource-http --lib` (31, incl. 5 shard_route).

### 4.26 Round 2, from the final-build measurements (wasm `wasmrev-20261009e`)
A stop-hook review of the run found three acceptance gaps; each got a fix, an adversarial review and a 1070 re-run.
- **B (delivery):** on the `…d` build the shard worker's delivery bar (p90 < 50 ms) held in 1 of 3 runs. Profile
  (`acad-diagF`, wasm names via `coldload-1009/wasmnames/optg.wasm`): the walk window's 50–72 ms main-thread tasks
  were future polls stacking synchronous discovery rounds (Setup / part GfxObj parses), main-thread re-hashes and
  boot-pack zstd reads. Fixes: callers that latch onto another caller's in-flight shard fetch no longer re-hash a
  body the worker verified (`?shardFetchWorker`; `__hbShardCache.stepEHashed/Skipped`); `?interiorStabChunk`
  (default 40) runs the stab batch as concurrent paced sub-walks (settled only when every sub-walk settled);
  `?walkPace` yields one turn before a discovery round that follows a prefetch that suspended (main thread only);
  `?shardFetchHigh` sends `{priority:"high"}` for urgent worker fetches. Finding: most of the remaining gap is
  INSIDE the worker (its network end → body in hand p90 0.18–0.25 s, in clumps); diag `workerLag`, `tResp`.
  zstd (boot.hba reads, 31 ms) and `surface_classify::compute_stats` (20 ms) are documented, not changed.
- **D (links):** the login tunnel moved the world's first frame to the reveal, so EffectMaterial (512 ms), the
  sky/stars PMREM programs (314 / 113 ms), far-terrain (202 ms) and the IBL's PMREMGGXConvolution (a 1.1 s task at
  7 s) linked in-frame. `?tunnelWorldWarm` compiles the composer passes, world scene and sky against the target each
  draw uses while the tunnel owns the frame (links start in the background; release held ≤ 1.5 s once, `nohold`
  never); `?pmremPrecompile` pre-allocates the PMREM targets and compiles GGX/blur/background (on a BoxGeometry —
  geometry attributes are key bits) and the sky at construction, a due refresh waits ≤ 2 s; `?asyncLinkFar` puts
  far-terrain patch materials in the async-link guard. `tests/tunnel_world_warm.test.mjs` (96).
- **A2 (pack stall, `?packSource` only):** `?packWorkerFetchShare` keeps the bake worker's 8 fetch permits under
  D-03.10's cap (index.html marks the cap); `?bakeUrgentReserve` lets urgent (lane-0) bake messages post past a
  full queue (1 slot; `all[:N]` for both arms); `?packRingHold` holds lane-R packs while `__interiorBuildPending`
  (own landblock's tile/interior/regionals exempt; 180 s ceiling). The `packSource` default-on flip stays the
  owner's. Tests `pack_worker_fetch_share`, `bake_urgent_reserve`, `pack_ring_hold`.
Gate 509 / 0; native `cargo test -p holtburger-resource-http --lib` 35, `-p holtburger-web --lib` (filters) 20.
Measured: see §5b "Phase 4".

### 4.26b Round 3 (late afternoon): quick fade, shard hash slicing, A/Bs
- `?loginPortalSpace=quick` now fades the tunnel in 0.25 s (`QUICK_FADE_OUT`): the retail 1 s fade runs on the
  sequencer's frame-dt clock and stretched to 2.5–3.2 s under load; tunnel ready → reveal is now 0.3 s. Retail mode
  and teleports keep 1 s. `tests/login_portal_space.test.mjs` PART F.
- `?shardHashSlice` (default on): the shard worker's event loop was blocked up to 604 ms (r5lag `workerLag`) by the
  pure-JS sha256 of multi-MB HD records on the insecure raw-tailnet origin (no `crypto.subtle`; the public HTTPS
  route uses subtle). Bodies > 64 KB now hash incrementally in 64 KB slices, one per event-loop turn (MessageChannel),
  urgent bodies first; digests byte-identical (fuzzed 400 sizes + node:crypto). The page forwards the flag as
  `hashSlice` on each batch. 1070 (r6slice, one run): 104 bodies in 592 slices, longest slice 11 ms; walk-window
  delivery (network end → wasm) p90 0.108 s (was 0.15–0.47), page hop p90 72 ms, record fetch 1.96 s. Still above
  the 50 ms bar: the worker's event loop still stalls up to 914 ms (`workerLag` over100 11) and it is no longer
  hashing — next suspect large-body reads / GC in the worker (profile the worker target over CDP).
- A/Bs on the final build (2 runs each unless noted): `bakeUrgentReserve=all` academy walls 10.0 / 9.6 s vs 9.6 / 13.0,
  Town Network 4.1 / 3.9 s vs 4.1 / 4.2 → within noise, left packs-only (its reviewer could not rule out a default-arm
  regression). `interiorStabChunk=off&walkPace=off` (3 runs each): fetch 2.9 / 2.0 / 4.0 s vs 3.3 / 2.4 / 3.2 → no
  measurable effect either way.

### 4.27 Indoor lighting parity: prepared for the owner, nothing changed (Workstream E)
Side-by-side shots, all rendered by a page-local override (uniform values only; program count constant across arms,
so no relink): `coldload-1009/E/e-tn-{N,S}-{decision1,decision2,summary}.jpg` (Town Network hall) and
`e-acad-{NE,SW}-…` (Holtburg academy). Findings for the decisions:
- Today, enclosed-cell IBL is 0.2 by day and 0.06 at night (the env map itself swings with the sky); retail is a
  fixed white `SetWorldAmbientLight(0.2, 0xFFFFFFFF)` (acclient.c:146742; held because `LScape::release_all`
  stops the light tick).
- Even with retail ambient the shots still differ day vs night: the OUTDOOR distance fog applies inside sealed
  dungeons and follows the clock (day near 120 / far 2235 m, night 0 / 400 m). A third day/night term to decide.
- EnvCell walls receive NO direct light today (`uAcBakedSuppressDirect = 1`), so the 16-slot policy alone cannot
  change how walls look; retail lights walls with every dynamic light (`minimize_envcell_lighting`). Sub-decision W.
- In the Town Network hall all 25 entity lights are in visible cells, so "visible-cell scope" (2a) changes nothing
  there; `retail7` (viewer light + 6 nearest) and `cap4` do. The academy has no entity point lights (decision 2 n/a).
Options per decision (1A retail fixed white / 1B today / 1C retail + floor; 2a / 2b / 2r / 2c; W yes/no) are in
`coldload-1009/notes/note-E.md`.

## 5c. Evening pass (2026-10-09 evening): decode CPU, the early-bake race, the SSD serving copy

Owner: "read the last commits and continue"; mid-session: "make sure to set up monitor on human usage on 1070",
then "we could move the associated files to the C drive. obviously keep them off the repo" and "it should be a
structural change so those files always go there so we can stop worrying about that for all this stuff. and they
get managed appropriates as we do new builds etc". Picked §6 item 6 (the furnished time). The 1070 was driven under
`watch1070.sh` (AWAY the whole time, idle 31 h) until it went offline at ~21:16 (tailscale "last seen"); our test
Chrome had been closed at 20:58. Run JSONs: `/mnt/wbterminal1/tmp/claude-scratch/coldload-1009b/`.

| run (academy, after in-world) | build | walls | furnished | notes |
|---|---|---|---|---|
| e1 / e2 | `…e` (baseline) | 6.2 / 8.7 s | 21.9 / 24.6 s | statics +15.8 / +15.9 s after the walls |
| f1 | `…f` (4.28) | **19.5 s** | 25.0 s | `notPlayerLb 1`: the early bake never ran (4.29) |
| f2 / f3p | `…f` + 4.29 | 7.2 / 7.1 s | 22.9 / 23.5 s | f3p: CPU profile + long tasks (2.65 s over 12–30 s) |
| f4s / f5s / f6s | same, `--workerspy` | 8.6 / 7.9 / 8.2 s | 22.5 / 23.6 / 21.8 s | f6s: `/proc/diskstats` sampled beside it (4.31) |

So the decode pass did not move the furnished time on this rig: the gap is the bake worker's record walk over a
raw HTTP/1.1 link off a USB spinner (4.30, 4.31). The SSD copy went live at 21:37; the box was gone before it could
be measured (§6 evening item 1).

### 4.28 Surface decode: 2.8× less CPU, byte-identical (`crates/holtburger-dat/src/height_seam.rs`, `wasmrev-20261009f`)
Node CPU profile of the deployed wasm decoding the academy's 238 static surfaces (`coldboot/surfbench.mjs` with a named
`wasm-opt -O -g` build): `normal_and_height_pixels` 75% of the decode, `grey_morph` 47%, and `fminf` + `fmaxf` 22% —
on wasm32 `f32::min` / `max` are out-of-line libcalls (their NaN rule has no single instruction), called once per
morphology tap. Changes, all bit-identical: `min_nn` / `max_nn` (compare + select; every operand is finite, and they
pick the operand `fminf` / `fmaxf` pick, equal operands included) in `grey_morph`, the chamfer DT and the seam
strength; `grey_morph` as van Herk / Gil-Werman running extremes (≈3 picks per texel whatever the radius; the
vertical pass runs the blocks on whole rows); `pad_wrapped` as three slice copies (no `%` per element) when the
radius fits the row; `value_noise` hashes its ≤48×48 lattice once instead of four times per texel; `seam_normal_rgb8`
hoists its two per-texel `fminf`s. Result over 313 interior surfaces of six landblocks (13.7 Mpx): decode-only
**8,969 → 3,212 ms** (laptop, node), every plane and scalar field identical by hash (`surfbench.mjs` old vs new);
`cargo test -p holtburger-dat --lib height_seam` 24/24 (the existing per-tap references cover radii up to 21 and
multi-wrap sizes). Deployed: `pkg-prev-20261009f/` = `…e`, stamp `…f` (index.html ×6, bake_worker.js ×3,
net_worker.js ×2, net_worker_client.js ×2; `test_wasm_preload_stamp.mjs` 7/7), shell rebuilt. On the 1070: the
`fetchEntitySurfacesPixels` maximum fell from 12.5 s to 1.2–4.0 s; the statics' 232-surface decode is now one
synchronous 2.5–5.9 s stretch in the worker.

### 4.29 The early bake missed the academy once the rig was placed (`?interiorEarlyBake`)
f1 logged no `deps after` line; `__interiorEarlyBake` read `notPlayerLb 1`. `isNearPlayerLb(…, 0)` reads the rig's
landblock as `floor(position / 192 m)`, and the academy's cells lie south of 0x8602's footprint: a placed rig reads
**0x8601** (probe on the live page: server stamp 0x86020000, rig 0x86010000). Before the rig is placed
`getCurrentLbId` falls back to `initialCentreLbKey` = 0x8602, which is why every earlier run kicked; the server
stamp it also honours had not landed yet. Fix (`scene3d/cells.js` `_earlyBakeOwnLb`): also accept the session's own
cell (`getLocalPlayerPose().landblockId`, else `getCurrentCellId()` — portal_space's `resolveLoginCell` order); a
build that starts before either source knows re-asks every 100 ms until its Step B (`waited` / `waitKicked` /
`waitedOut`; `bySessionCell` counts kicks the session decided). Only this caller uses radius 0 — the 3×3 urgency
callers still pass with 0x8601. `tests/interior_early_bake.test.mjs` 14 (E11–E14 new), url-flags row updated.

### 4.30 Where the walls → furniture gap goes (breadcrumbs, `academy.mjs --workerspy`)
The `[interiorWallsFirst] … statics attached` line now ends `Step C settled X ms, staged Y ms, prewarmed Z ms`
(`window.__interiorWallsFirst.lastStepCMs` / `lastStagedMs` / `lastPrewarmedMs`). `--workerspy` (+ `wspy.py`)
records inside the bake worker every message's arrival / reply and every event-loop block over 50 ms. f5s, walls at
12.1 s page time, statics at 27.8 s:

| phase | page time |
|---|---|
| the statics' meshes reply; their 232-surface request waits in the CLIENT queue (4 urgent entity jobs hold the in-flight cap of 4) | 9.55 → 10.93 s |
| record walk: ~416 requests (Surface → SurfaceTexture → Texture → Palette) at ~40/s, nothing completing 14.0–15.5 s with 185 in flight | 10.93 → ~21 s |
| decode, synchronous in the worker (907 + 2,532 ms blocks) | ~21 → 25.07 s |
| 232 materials installed on the main thread | → 26.0 s |
| statics staged, prewarmed (`guardedCompileAsync`; 1.8 s here, 5.0 s in f6s), attached | → 27.9 s |

Network attribution for the walk window: the page and shard worker are nearly idle; the relay passed 16 KB at 12 s,
28 KB at 14 s, 0 at 16 s while 252-byte records took 9 s. Warm, the same path from the 1070 page does **193 req/s**
(1,500 records, 6 HTTP/1.1 connections, p50 28 ms) and `replay.mjs` through the proxy 2,146 req/s — so the in-run
~40 req/s was the server's disk (4.31).

### 4.31 Baked data served from the SSD (`scripts/dist_ssd.py`, `scripts/serve.py`)
The served dist (`external/holtburger/dist` → `/mnt/wbterminal2/…`) was on a USB WD 8 TB spinner (`sdc`, BOT,
queue depth 1). Before f6s, `fincore` found **1,449 of the academy's 2,989 shard files uncached** ten minutes after
the previous load (8 GB laptop, 2.4 GB page cache, swap in use), and during f6s the drive ran up to ~86% busy (863 ms
of IO per second, ~250 random reads/s) through the interior fetch. Players on the public front read the same disk.

Now (structural, per the owner):
- **Serving root** `~/hb-serve/dist/` on the internal SSD, outside the repo: `<name>/` per staged bake (layer symlinks
  dereferenced), `<name>/.dist-ssd.json` provenance (source, fingerprint, staged_at), `current -> <name>`.
  `serve.py`'s default root is `~/hb-serve/dist/current` (archive bake only when no copy exists); `dist` points there.
- **`scripts/dist_ssd.py`**: `stage [SRC] [--name] [--activate] [--bulk] [--all-shards] [--min-free-gb 6]`,
  `activate NAME`, `prune --keep N` (never `current`), `status`, `check` (exit 1 when `current` is stale). Files
  unchanged since the active copy are hardlinked (`rsync --link-dest`), so a re-bake costs only what changed; a
  re-stage works on a hardlinked clone and swaps it in; a space guard (apparent bytes + one 4 KiB block per new file)
  refuses to go below the floor; `--bulk` pre-copies in inode order with 4 threads (rsync's name order seeks per
  file on the spinner: 250 files/s; inode order 970–2,600 files/s).
- **Only catalog-referenced shards are staged** (894,966 records, 6.1 GB, named by the 1,031 HBNS catalogs under
  `manifest/`). The archive's `shards/` also holds 0.89 M convention-URL aliases (`shards/<namespace>/0x<id>.bin`,
  symlinks to the same records), used only when a namespace has no catalog — none of the 3,250–3,500 shard requests
  of e1/f5s/f6s. **`serve.py` reads any `/dist/` miss through to the copy's archive source** (logged
  `[serve] read-through #N`), so nothing 404s that did before.
- **Freshness**: `serve.py` prints at every start whether `current` matches its source (a cheap fingerprint: top-level
  entries, manifest/ and index/ files, layer and bucket dir mtimes, layer sidecars — 1,583 entries in 0.65 s) and warns
  loudly when it is stale or when the served root is on a rotational disk; `_health.json` carries a `serving` block.
- **After any bake or stager writes to the archive**: `scripts/dist_ssd.py stage --activate` (a different bake:
  `stage <root> --name <n> --activate [--bulk]`, then `prune --keep 1`). A tool that rewrites an existing per-LB file
  in place without touching a dir or sidecar is not seen by the fingerprint — re-stage after it anyway.
- First stage: 1.87 M files in ~20 min (`--bulk`), then the referenced-only re-stage (197 s): 1,305,520 files, ~14 GB
  on disk; the SSD is at 87% (16.5 GB free; cargo's `target/` is already on the archive drive). 400 random files +
  manifest.json + boot.hba byte-compared against the archive; hash / alias / 404 / manifest / index.html served
  correctly through the proxy. `scripts/test_dist_ssd.py` (32 checks on throwaway trees).
- Cold-cache check (22:00, laptop, `echo 3 > /proc/sys/vm/drop_caches` before each cold pass): the academy's 2,989
  shard files in f5s request order, 6 parallel readers (`coldload-1009b/coldread.py`) — USB archive **135 files/s**
  (22.1 s for the set, p50 33 ms per file), SSD copy **1,904 files/s** (1.6 s, p50 2.1 ms), both ~18,000 files/s
  warm; end to end through proxy + serve.py from the SSD, cold: 1,216 req/s. So a cold academy load needed ≥ 22 s of
  disk time from the spinner alone, and the server now outruns the rig link (193 req/s warm from the 1070 page).
- `serve.py` was restarted on it at 21:37 (`setsid nohup python3 scripts/serve.py --bind 127.0.0.1`, log
  `/mnt/wbterminal1/tmp/claude-scratch/serve-8765.log`). Offline validators and stagers still read / write the
  archive paths directly — unchanged, the archive stays the bake of record.

## 6. Open items

**From the 2026-10-09 evening pass (§5c):**
1. **Measure the SSD copy on the 1070** (it went offline before any run): `academy.mjs --label X --workerspy` ×3 plus
   `/proc/diskstats` sampling (expect no `sdc` reads), then Town Network. The question is how much of the ~15 s walls →
   furniture gap was the disk (4.30's record walk).
2. Step C's 232-surface request is ONE worker message: it waits behind the in-flight cap (4 urgent entity jobs) and then
   decodes in one 2.5–5.9 s synchronous stretch during which no other bake message runs. Options: split the statics'
   preload into chunks and attach progressively, give lane 0 more slots for interior builds, or a second decode worker
   (the box has 4 cores).
3. The statics' prewarm takes 1.8–5.0 s (`lastStagedMs` → `lastPrewarmedMs`).
4. MEMORY.md's dist entries still describe `dist → /mnt/wbterminal2` (memory edits are user-directed).

**From the 2026-10-09 afternoon structural pass (§5b) — owner decisions first:**
1. `?loginPortalSpace`: default `quick` (fade as soon as the spawn walls are up); `retail` adds CONTINUE + fades
   (academy: visible walls +3.3 s). Outdoor logins currently skip the tunnel: the tick's scene ref has no
   `terrainBakedLbs`, so `destinationCellsReady` reads "ready" (also true for outdoor teleport arrivals, pre-existing).
   Should outdoor logins hold for terrain? LoginComplete timing is still not retail (ACE materialises the player
   while the tunnel shows).
2. `?interiorWallsFirst`: walls ~11 s earlier, but for ~10 s the furniture is collidable before it is drawn and the
   walls stay on retail-resolution textures until the statics land. Keep, or `=off`?
3. `?texUpgradeBgShare=0` ("mid tier") = no HD beyond 32 m (pre = retail resolution). And sign-off on the 32 m scope
   of the "no surface on preview > 10 s in view" check (`report().inView`; unscoped `maxWaitMsAll` reported).
4. Indoor lighting (§4.27): 1A/1B/1C ambient, 2a/2b/2r/2c slots, W (walls take dynamic lights), plus the outdoor fog
   that also applies inside sealed dungeons. Shots in `coldload-1009/E/`.
5. `?packSource` (A2 diagnosed, not fixed): the bake worker has no pack seam and drops to 2 fetch permits behind a
   4-slot queue under packs; packA1 (old build) fetch 6.6 s but walls unchanged. Fixes listed in
   `coldload-1009/notes/note-AB.md` §A2.

**Engineering follow-ups:**
6. The furnished time (22–27 s) is now the academy's long pole: the statics' `fetch_model_meshes` (5.6 s in the
   bake worker) and one 13.9 s `fetchSurfacesPixels` call for 232 surfaces. A1 proper (a baked per-LB closure —
   design + review in `coldload-1009/notes/note-AB.md` / `review-AB.md`) and splitting that decode would cut it.
7. `?shardFetchWorker` meets its delivery bar in 1 of 2 runs (worker→wasm p90 20 / 93 ms) and did not cut the
   record fetch a further third (−14 %, within noise). Waiters that latch onto another caller's fetch still
   re-hash on the main thread (review note).
8. `pkg/` = `wasmrev-20261009e` (`pkg-prev-20261009e` = `…d`, `pkg-prev-20261009d` = `…c`, `pkg-prev-20261009c` =
   this morning's `…b`). Native tests run: `cargo test -p
   holtburger-resource-http --lib` (31) and `-p holtburger-web --lib -- batch_walk interior_stab_batch_flag
   surface_walk_lite tests_interior_early_bake_deps` (13).

**Earlier items (morning):**


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

> Evening pass (§5c): the served dist is now the SSD copy `~/hb-serve/dist/current` (`scripts/dist_ssd.py status`);
> after ANY bake or stager run, `scripts/dist_ssd.py stage --activate` (serve.py warns at start when the copy is
> stale). First job: §6 evening item 1 — re-measure the academy on the SSD copy with `academy.mjs --workerspy`
> (+ `wspy.py`) under `watch1070.sh`, then pick from items 2–3. Decode changes: verify with `coldboot/surfbench.mjs`
> old pkg vs new pkg (hashes must match) before deploying.

> Afternoon pass (§5b): read §5b's table and §6 items 1–8 first. The run ledger, every agent's design note,
> review and report, and the measurement drivers (`baseline.sh` — Tester must start OUTSIDE the Town Network, so
> it parks the character in Holtburg with `park.mjs`; Eyetest Halvar must be the most recently played character for
> `academy.mjs`; `acadsum.sh`, `tnsum2.py` — walls = the `[interiorWallsFirst] … cells attached` console line,
> townnet's `firstCells` now means "build complete") are in `/mnt/wbterminal1/tmp/claude-scratch/coldload-1009/`.
