# emit-dynamic-site — Design

## How to pick up this work

> Read this section first. The rest of this document is the
> long-lived design intent + decision history; this header is
> the snapshot of where we actually are and what's blocking
> what. Last refreshed **2026-05-08** (post-Phase-5.2-obj-8
> landing — smoke harness v2 fixture + 17 new v2 checks +
> `BootPackV2` shrinks the top-level manifest to 541 bytes).

### Where the project is

**Phases done:** 0, 1, 2, 3 (steps 1-6 + step 3.6 terrain
bilinear blend; step 5 partial), 4 (step 1 + 2a + 2a.5 +
2a.6 + 2b + 3 + 3.5 + 3.6 movement-system wiring + 3.7 biota
handler + landblock-crossing rebucket + 4 chat panel + 4
follow-on (vitals + inventory DOM panels) +
**5 interactive entities — `SessionHandle.useObject(guid)`
wasm export + per-sprite `pointerdown` handler on
interactable categories + 3 new `ClientEvent` kinds
(VendorOpened / UseFailed / UseDone OK), landed
2026-05-08; live-validated against a Sparring Golem
returning `kind=14 UseDone`** +
6a + 6b + 6e (realistic-entity metadata + ItemType-keyed
visual dispatch + glyph fallback + per-entity nameplates) +
6 Phase A + B + C (ACE-shipped ClothingTable substitutions +
palette overlays + MotionTable idle pose), 5.0, 5.0b, 5.1a,
5.1b, 5.2 obj 1-8 (ManifestV2 schema + NamespaceCatalog binary
codec + `ManifestResourceSource` v1/v2 enum dispatch + v2
prefetch with lazy catalogs + convention URLs + `dat-shard`
v2 emission with `BootPackV2` + per-namespace catalogs +
2-level-prefix shard layout + convention-URL symlinks + page
diagnostic v2 hint + service-worker `/manifest/*.bin` cache
scope + smoke harness v2 fixture + 17 v2 checks). Native lib
gate **1148 / 0** across 14 workspace crates; integration
test gate **1179 / 0** workspace-wide; **smoke 100 / 100 +
1 SKIP**; v2 top-level `manifest.json` at **541 bytes**.
`cargo check --target wasm32-unknown-unknown` clean for
`holtburger-{dat,session,transport-ws,resource-http,web,
content,core,manifest}`. `wasm-pack build --target {nodejs,
web}` both green. `node smoke_test.cjs` **83 / 83 PASS**
(82 OK + 1 SKIP for live-ACE round-trip; the SKIP is the
symbol-only check — the wire-effect validation runs through
`capture_phase4_step3.cjs` (movement),
`capture_phase4_step4_follow_on.cjs` (vitals + inventory),
`capture_phase4_step5.cjs` (click-to-use), all Playwright-
driven against the live stack).

**What works end-to-end today.** Open
`apps/holtburger-web/index.html` in any browser. The page calls
`init_resource_source("../../dist/manifest.json")` on startup;
every `fetch_*` then reads through the global
`ManifestResourceSource` (no `asset_url` parameter — Phase 5.0b
dropped it). Holtburg renders with real retail textures + roads
+ 239 placed objects, every unique model triangulates and
UV-maps in the browser at runtime via Phase 3 step 6's
per-poly rasterizer. The login form drives the full AC handshake
through `holtburger-wsbridge` to a live ACE: login →
CharacterList → in-browser CharacterCreate → spawn handshake →
`LoginComplete` → `kind=7 EnteredWorld` → "Teleport to
Holtburg" button sends `@telepoi Holtburg` via
`GameAction::Talk`.

**Phase 4 step 2b (2026-05-05):** the local player + every
other live entity ACE pushes (NPCs, monsters, vendors, town
guards) renders on a third PIXI `entityContainer` layer above
the static placements. Position updates land via
`SessionHandle.pollEntityUpdates()` and slide sprites between
world coords as ACE streams `PublicUpdatePosition`. Pushed
2026-05-06 in `fe85008..d01fa73`.

**Phase 4 step 3 + 3.5 (2026-05-06):** WASD / Q / E / Shift
drives outbound `GameAction::MoveToState` packets via
`SessionHandle.setMovementInput`. Wire round-trip validated
against live ACE — `MoveToState send_action OK` → ACE echoes
`UpdateMotion`. JS-side per-rAF prediction integrates the
keystate into the local sprite's world coords (mirrors cli's
`local_velocity_for_state` + `local_omega_for_state`), so the
press-W → sprite-slides loop closes visually. Capture
validates 3 m of in-frame drift over a 3-second W-hold at
the canonical 1.0 m/s walk speed. Critical ACE gotcha:
`OnMoveToState` short-circuits unless `IsPKType`
(`Player_Tick.cs:154` — `FastTick => IsPKType`); the capture
sends `@pk pk` before pressing W to flip PlayerKillerStatus
and engage server-side physics.

**Phase 4 step 3.6 (2026-05-07).** Step 3 + 3.5 produced
visual movement but the server-side player position was
frozen at the `@telepoi` spawn point — discovered when the
user ran south for two minutes and never aggro'd a monster.
Diagnosed via `ace_shard.biota_properties_position`: 18+
test characters all logged out at exact spawn coords
`(84.0, 7.1, 94.0)` in `0xA9B40019` despite ~10 minute
sessions. Root cause: the wasm bundle never sent the
`AutonomousPosition` heartbeat that AC clients use to
report their predicted position back to the server — the
client is authoritative for player position in retail AC,
and ACE's server-side player only moves when these
heartbeats arrive. Step 3 sent `MoveToState` (motion intent)
but no `AutonomousPosition` (position payload). Fix wires
the cli's full `MovementSystem` into the wasm recv loop via
a `MovementSystemHandle` shim in `holtburger-core::client::
movement::handle`; design + 9-step plan at
[`phase-4-step-3.6-movement-system.md`](phase-4-step-3.6-movement-system.md);
shipped in commits `91190e1` (structure) + `274e213` (5
follow-on bugs the original landing missed: silent log
crate, wrong-arm entity seed, missing pose integrator,
RunRateUnavailable fallback, **the load-bearing
`Teleporting=true` PlayerTeleport→LoginComplete loop** —
ACE silently drops AutonomousPosition while Teleporting,
and the cli sends LoginComplete on every PlayerTeleport to
clear it). Validated against live ACE: 15-second walk
advanced server-side position from `(84.0, 7.1, 94.0)` to
`(86.345, 21.908, 94.005)` (14.8 m of Y movement at
~1 m/s). Out-of-scope for 3.6 (now → step 3.7): real
character-biota loading so movement caps come from the
player's actual run-rate / motion-table (3.6 installs a
fallback `SelfMovementCapabilities` override — walk = 1 m/s,
run = 4.5 m/s, turn = 1.5 rad/s — because the player biota
isn't loaded in the wasm bundle and `resolve_self_movement_
capabilities` would otherwise return `RunRateUnavailable`);
landblock-crossing correctness in the local-pose integrator
(currently adds delta to local coords, doesn't re-bucket
into adjacent landblocks — single-walk testing within
Holtburg town's 192m × 192m cell is fine, but step 3.6 lets
you cross into `0xA9B30019` etc. for encounters and the
integrator will produce wrong local coords on the far
side). **Both deferred items closed by step 3.7** (below).

**Phase 4 step 3.7 (2026-05-07).** Closes the two
out-of-scope items 3.6 left open.
- *(a) PlayerDescription biota handler.* Recv loop now
  matches `GameEvent::PlayerDescription` and calls cli's
  `player.hydrate_from_player_description` +
  `world.apply_player_description_world_state` +
  `world.emit_player_derived_stats`, then clears 3.6's
  fallback `SelfMovementCapabilities` override so subsequent
  `resolve_self_movement_capabilities` reads the player's
  real `Run` skill + burden + motion table. Defensive
  re-install of the fallback if real biota fails to resolve.
  Required `pub` lifting on
  `WorldState::{apply_player_description_world_state,
  emit_player_derived_stats}` and on
  `set_self_movement_capabilities_override` /
  `clear_self_movement_capabilities_override` (the latter
  pair were `#[cfg(any(test, feature = "test-support"))]`).
  Verification still pending live confirmation —
  PlayerDescription wasn't observed in the capture harness
  this session (test-fixture state may be sticky); handler
  is correct per cli reference.
- *(b) Landblock-crossing rebucket.* New
  `WorldPosition::rebucket_outdoor_landblock` in
  `holtburger-common::position` walks coords past
  `[0, METERS_PER_LANDBLOCK)` (192 m) and adjusts the high
  word of `landblock_id` (X = bits 24-31, Y = 16-23),
  re-deriving the cell index via `normalize_outdoor_cell`.
  Edge-of-world clamps. Indoor poses no-op. Called from
  `MovementSystem::advance_local_pose_for_manual_drive`
  immediately after velocity integration so the
  AutonomousPosition heartbeat always carries a coherent
  `(landblock, local-coords)` pair after walking through a
  192 m boundary. Five unit tests in
  `holtburger-common::position::tests::test_rebucket_*`
  cover in-bounds no-op, north cross, south-west diagonal
  cross, cell-id recompute, indoor no-op — all green.

**Phase 4 step 4 follow-on (2026-05-08).** Adds the vitals +
inventory DOM panels alongside the chat panel — the third and
fourth tiles in the post-spawn `#panels-row` flex layout above
the canvas. Mechanism:

- **Canonical world-handler dispatcher routed at the top of
  the recv loop.** Stat / inventory / `GameEvent` messages
  go through `holtburger_world::handlers::routing::handle_message`
  BEFORE the recv loop's own match-block runs. The dispatcher
  mutates `WorldState.player.{vitals,attributes,skills}`,
  `state.entities`, and `state.player.{inventory,equipment}`
  per the cli's reference handlers in
  `crates/holtburger-world/src/handlers/{player,inventory,
  login,properties,system}.rs`. Position messages
  (`UpdatePosition`, `PrivateUpdatePosition`,
  `PublicUpdatePosition`, `VectorUpdate`, `UpdateMotion`)
  are intentionally NOT routed — the recv loop's existing
  arms handle them with step 3.6 / 3.5 semantics
  (`entity_seeded` gating, heartbeat arming, JS
  `entity_updates` push) that double-handling would risk
  regressing.
- **PlayerDescription arm simplified.** With routing now
  doing `hydrate_from_player_description` +
  `apply_player_description_world_state` +
  `emit_player_derived_stats` automatically (via
  `player::handle_event` and `login::handle_event`), the
  recv loop's PlayerDescription arm shrinks to just the
  step 3.6 / 3.7 fallback-caps bookkeeping — clear the
  bootstrap-time override, verify real caps resolve, re-
  install the fallback if they don't.
- **Two new ClientEvent kinds — `kind=8 PlayerStatsUpdated`
  and `kind=11 InventoryUpdated`.** Both are coalesced
  signals (one per recv iteration regardless of how many
  underlying world events fired). The recv loop scans the
  dispatcher's `Vec<WorldEvent>` and flips a `stats_changed`
  flag for `Vital`/`Attribute`/`Skill`/`LevelInfo`/
  `DerivedStats`/`PlayerEnchantments` updates, an
  `inventory_changed` flag for `EntitySpawned`/`Replaced`/
  `Identified`/`Despawned`/`PropertiesUpdated`/
  `ContainerOpened`/`ContainerClosed` plus a fast-path on
  the message-type itself for `ObjectCreate`/`ObjectDelete`/
  `InventoryRemoveObject`/`ParentEvent`/`PickupEvent`.
- **Snapshot-on-publish architecture.** When a flag fires,
  the recv loop calls `publish_player_stats_snapshot` /
  `publish_player_inventory_snapshot` to build a flat-typed-
  array snapshot from the now-current `WorldState`, writes
  it into a shared `Rc<RefCell<...>>` cell, and queues the
  marker `ClientEvent`. JS reads via
  `SessionHandle.playerStats()` /
  `SessionHandle.playerInventory()` after each `kind=8` /
  `kind=11` drain. `PlayerStatsSnapshot` carries flat
  `[type, current, base, buffed_max] × 3` for vitals,
  `[type, current, base, ranks] × 6` for attributes,
  `[type, current, base, ranks, training] × N` for skills,
  and a 7-u32 packing for level info (level + 64-bit XP
  values split lo/hi). `InventoryItem` carries
  `{guid, wcid, name, iconId, itemType, value, stackSize,
  equipMask, containerId}`.
- **Vitals panel.** Three colour-keyed progress bars (red
  Health, yellow Stamina, blue Mana) with `current / max`
  numerics. 6-row attribute table (Strength / Endurance /
  Coordination / Quickness / Focus / Self) showing
  `current` + `base` + `ranks`. Collapsible Skills section
  using a `<details>` element — sorted by `SkillType`
  numeric id, with `.untrained` / `.trained` /
  `.specialized` CSS classes for subtle colour cues. Header
  shows player name + level + cumulative XP via `BigInt`
  reassembly.
- **Inventory panel (read-only first cut).** Two
  sub-sections: "Equipped" (items with non-zero
  `equipMask`) above "Pack" (items with `equipMask == 0`).
  Each row shows the item name + meta (stack size if > 1
  else pyreal value if > 0). CSS hints colour weapon names
  blue, armour green, magic violet, money amber via the
  `data-type-bit` attribute. Manipulating items (drop,
  give, use) is step 5 scope (interactive entities via
  `UseObject` + drop / give `GameAction`s).
- **3 new top-level wasm-bindgen helpers.** `skillName(type)`
  / `attributeName(type)` / `vitalName(type)` map a numeric
  enum id to its strum-Display string. JS uses these to
  label the panel rows without re-hosting the AC enum
  vocabulary.
- **Smoke 72 → 82 (+ 9 OK probes).** New checks:
  `SessionHandle.playerStats()` + `playerInventory()`
  prototype methods; `PlayerStatsSnapshot` class + 5
  getters (`vitals`/`attributes`/`skills`/`levelInfo`/
  `name`); `InventoryItem` class + 9 getters
  (`guid`/`wcid`/`name`/`iconId`/`itemType`/`value`/
  `stackSize`/`equipMask`/`containerId`); 3 label-helper
  function-presence-and-known-value checks (`skillName(24)
  === "Run"`, `attributeName(1) === "Strength"`,
  `vitalName(1) === "Health"`).
- **Live wire round-trip pending.** The static smoke
  exercises symbol presence + label-helper return values;
  the live PlayerDescription / Update*Vital / Update*Skill
  / ObjectCreate-for-owned-item flow lives in the capture
  harness against a real ACE backend. Reuse the existing
  `capture_phase4_step3.cjs` Playwright pattern (`@telepoi
  Holtburg` then walk around to trigger ACE's stat /
  vision broadcasts) — the new `kind=8` and `kind=11`
  events fire automatically as soon as the live recv loop
  sees the corresponding wire messages.

**Phase 3 step 3.6 (2026-05-06).** The terrain rendering now
matches `emit-static-site`'s output (the canonical reference).
Algorithm shipped:
- **Bilinear 4-corner blend** in the fragment shader: each
  fragment samples the 4 surrounding vertices' terrain types
  from a 9×9 RGBA8 vertex-types texture per LB and weighted-
  blends 4 atlas tile samples. No more 24m square cell
  artefacts. Mirror of `RenderPreviewRenderer.cs:467-485`.
- **Vector road lines** drawn via `PIXI.Graphics` per LB:
  walks the 9×9 vertex grid, strokes between adjacent
  road=1 vertices in E/N/NE/NW directions. Diagonal road
  runs render as actual diagonal lines, not 24m blocks.
  Mirror of `RenderPreviewRenderer.cs:551-580`.
- **Transpose fix for column-major terrain data**: the wasm
  `terrainCodes` array is laid out `[gridX * 9 + gridY]`
  (column-major, vertex i has gridX = i/9, gridY = i%9 —
  verified empirically by comparing against
  `WorldBuilder.Terminal`'s `get-terrain-data` ground truth
  for Holtburg 0xA9B4). Canvas/GL textures are row-major; the
  data-build transposes on upload so the shader's
  `texelFetch(ivec2(iu, iv))` returns the type at the actual
  physical vertex (gridX=iu, gridY=iv).
- **On-demand entity model fetching**: the static placement
  cache (Phase 3 step 6) covers 80/81 unique Holtburg model
  IDs, but ACE-streamed NPCs use *creature* csetup_ids that
  almost never overlap. New `fetchEntityModelOnDemand(modelId)`
  fires a `fetch_model_meshes` + `fetch_surfaces_pixels` +
  `renderModelTile` round-trip on cache miss; the placeholder
  dot is swapped for the real textured sprite when the fetch
  resolves. At Holtburg town centre, **53/53 entities now
  render as textured sprites** (was 53/53 placeholder dots);
  cache grows from 80 → 98 (18 unique on-demand fetches).
- **TexMerge alpha-mask scaffolding kept in Rust** for any
  future authentic-AC mode (`fetch_terrain_alpha_masks`
  export + 3 retail mask SurfaceTexture ID constants). Not
  used by the bilinear path; available for re-wiring if
  someone wants per-cell hand-tuned patches.

The ground-truth comparison screenshot
[`docs/images/wb-terminal-holtburg-ground-truth.png`](images/
wb-terminal-holtburg-ground-truth.png) was produced by running
`render-preview` on the same 3×3 region through
`WorldBuilder.Terminal`'s stdin agent protocol. Side-by-side
with [`docs/images/phase-3-step-3.6-bilinear-roads.png`](images/
phase-3-step-3.6-bilinear-roads.png) the layouts match: water at
the north LB row, grass dominates the south, stone roads run
through Holtburg's center as diagonal lines.

**Bake recipe (run once after the first clone, again whenever
`dats/assets.hba` changes):**

> **Disk-space trap — read first.** A full bake produces ~4.7 GB
> on disk: 203 MB `manifest.json` + 1.86 MB `boot.hba` + ~1 GB of
> shard content **but ~4.5 GB on-disk** because each of the 885k
> shard files rounds up to a 4 KB block (885k × 4 KB ≈ 3.5 GB of
> tail-block overhead alone). Combined with `external/holtburger/
> target/` (~22 GB cargo build), this **WILL fill the root
> partition** if `dist/` lands on `/` or `/tmp`. On this host the
> root partition is 117 GB and recently sat at 77% full; one
> bake to `/tmp` knocked SSH offline mid-development on
> 2026-05-04 and forced the 2026-05-05 → 2026-05-06 commit gap.
>
> **Set up `dist/` as a symlink to a roomy drive before baking.**
> This host has 6.9 TB free on `/mnt/wbterminal1` (and another
> 6.9 TB on `/mnt/wbterminal2`); aim there. The HTTP server
> serves `external/holtburger/`, so the symlink keeps the
> browser-visible URL `dist/manifest.json` working unchanged.
>
> ```bash
> rm -f external/holtburger/dist  # in case a stale symlink exists
> mkdir -p /mnt/wbterminal1/holtburger-dist
> ln -s /mnt/wbterminal1/holtburger-dist external/holtburger/dist
> ```
>
> Phase 5.2 ([`manifest.md`](manifest.md)) will collapse the
> 203 MB manifest to ~2 KB top-level + per-namespace catalogs;
> the shard count is unchanged and the on-disk overhead remains.

```bash
cd external/holtburger
cargo build -p holtburger-tools --bin dat-shard --release
./target/release/dat-shard --input dats/assets.hba --output dist/
# Produces: dist/manifest.json (203 MB; Phase 5.2 fixes),
#           dist/boot.hba (1.86 MB, Holtburg's transitive closure),
#           dist/shards/{sha256}.bin × 885k (~1 GB content,
#           ~4.5 GB on-disk — see the disk-space trap above).
```

**Live-server stack** (the user keeps this running for
on-device validation; recipe in
[`phase-5-thorough.md`](phase-5-thorough.md) §"Live test info"):

- Python `http.server` on `:8765` from `external/holtburger/`.
- `holtburger-wsbridge` on `:8080` fronting ACE.
- ACE on UDP `127.0.0.1:9000` / `:9001` (built from
  `~/ace-server/`; recipe in
  [`ace-local-setup.md`](ace-local-setup.md)).
- Tailscale at `100.116.47.66`. Phone or laptop hits
  `http://100.116.47.66:8765/apps/holtburger-web/index.html`.
  ACE's `Config.js` ships with `DefaultAccessLevel: 4`, so any
  fresh account gets Developer access on first login — no SQL
  promotion needed for `@telepoi` / `@pk pk` etc.
- **Bind wsbridge externally for tailnet access**: the live
  default is `--listen 0.0.0.0:8080` (NOT `127.0.0.1:8080`),
  otherwise the laptop's browser can't reach it. Login form's
  Bridge URL field is `ws://100.116.47.66:8080/`, Server IP is
  `127.0.0.1` (the bridge resolves ACE locally on this host),
  Server port is `9000`.

### What's open — two parallel rails

Pick one to pull on. The choice is real, not arbitrary.

- **Content rail** — Phase 4 step 3 + 3.5 **landed 2026-05-06**;
  step 4 chat panel + step 3.6 (movement-system wiring; server-
  side player position now actually advances) **landed
  2026-05-07**.
  Step 3: `SessionHandle.setMovementInput` →
  `GameAction::MoveToState` → ACE accepts + broadcasts
  `UpdateMotion`. Step 3.5: per-rAF JS prediction integrates
  the keystate into the local sprite's world coords (mirrors
  cli's `local_velocity_for_state` / `local_omega_for_state`),
  so the press-W → sprite-slides loop closes visually. Step 3.6:
  full cli `MovementSystem` reuse via `MovementSystemHandle` in
  the recv loop; outbound `AutonomousPosition` heartbeats now
  fire (~1 Hz while moving), the WorldState pose advances via a
  thin local-pose integrator, the `PlayerTeleport` →
  `LoginComplete` loop clears ACE's `Teleporting=true` flag
  (which silently dropped AutonomousPosition) — server-side
  position validated to advance 14.8 m on a 15-second walk.
  Step 4 chat: 16 chat-bearing inbound message variants normalised
  through 24 `CHAT_CATEGORY_*` ids, surfaced as
  `kind=2 ChatReceived` events with a new `u32Payload2`
  getter; DOM panel grew a tab bar (All / Local / Tells /
  Channels / Combat / Magic / System) with category-keyed
  colours. Step 3.7: `GameEvent::PlayerDescription` recv arm
  hydrates the player from inbound biota and clears 3.6's
  fallback `SelfMovementCapabilities` override (real `Run`
  skill + burden now drive movement caps); new
  `WorldPosition::rebucket_outdoor_landblock` in the local-pose
  integrator advances the high word of `landblock_id` when
  coords cross 192 m boundaries (5 unit tests cover the
  arithmetic). **Step 4 follow-on (2026-05-08): vitals +
  inventory DOM panels** — every received message routes
  through the canonical world-handler dispatcher
  (`holtburger_world::handlers::routing::handle_message`) so
  `WorldState.player.{vitals,attributes,skills}` +
  `state.entities` + `state.player.{inventory,equipment}` stay
  current; the recv loop scans the resulting `WorldEvent`s
  and queues coalesced `kind=8 PlayerStatsUpdated` /
  `kind=11 InventoryUpdated` markers. Two new
  `SessionHandle` methods (`playerStats()`,
  `playerInventory()`) return flat-typed-array
  `PlayerStatsSnapshot` / `Vec<InventoryItem>` snapshots
  the JS panel renders. **Step 5 (interactive entities,
  2026-05-08):** new `SessionHandle.useObject(guid)` wasm
  export wraps `GameAction::Use(UseActionData { guid })`.
  JS attaches a per-sprite `pointerdown` handler on
  interactable categories (portal / lifestone / creature /
  container / writable) — `cursor: pointer` + hover-tint
  affordance + `stopPropagation` to keep the camera-pan
  handler quiet. Three new `ClientEvent` kinds normalise
  ACE's responses: `kind=12 VendorOpened` from
  `GameEvent::ApproachVendor` (with vendor name + item
  count); `kind=13 UseFailed` from
  `GameEvent::UseDone(error != None)` for explicit use
  errors (locked doors, etc.); `kind=14 UseDone OK` for
  success. Bare `WeenieError` / `WeenieErrorWithString`
  become kind=2 system-chat lines (channel-join
  notifications and similar info-events would otherwise
  false-positive as use failures). Live-validated
  end-to-end against ACE: clicking a Sparring Golem
  (creature, wcid=12698) returned `kind=14 UseDone`. **Next
  **Step 6d (portal swirls + sign inscriptions, landed
  2026-05-08):** writable-category entities (signs / books)
  get an italic + cream-fill / black-stroke nameplate
  variant mirroring
  `WorldBuilder.Terminal/RenderPreviewRenderer.cs:911-938`;
  portals get an animated `PIXI.Graphics` cyan ring sibling
  sprite that pulses radius + alpha on a 1.5 s loop driven
  from `tickEntityAnimations`. Cleanup hooks into
  `handleEntityRemove`. Live-validated: 6/6 writable
  entities visible after @telepoi (Letter From Home,
  VIEW CONTROLS, WIELDING ITEMS, etc.) get the sign-
  styled nameplate; portal swirl path is structurally in
  place — no portals in the immediate spawn radius, will
  exercise on any flow that puts one in vision. 6c was
  already absorbed by step 6 Phase A.
  **Step 6f (portal destination chips, landed
  2026-05-08):** ACE marks
  `PropertyString::AppraisalPortalDestination` with
  `[AssessmentProperty]` (per
  `~/ace-server/Source/ACE.Entity/Enum/Properties/PropertyString.cs:63-64`)
  — sent server → client only in response to
  `GameAction::IdentifyObject`. Recv loop auto-fires the
  identify on every ObjectCreate where the entity's
  `item_type & 0x10000` matches Portal; the response routes
  through the world's `inventory::handle_event` arm
  (`apply_identify_response` populates
  `entity.properties.strings`); the recv-loop scan for
  `WorldEvent::EntityIdentified` then emits a
  `kind=3 ENTITY_UPDATE_KIND_META_REFRESH` EntityUpdate
  with the destination text in a new
  `portal_destination` field. JS handles kind=3 via
  `handleEntityMetaRefresh`, mints a small italic cyan
  PIXI.Text under the portal sprite via `ensurePortalChip`,
  and the chip tracks the sprite per-frame in
  `updateNameplatePositions`. Cleanup hooks into
  `handleEntityRemove`. Live-validated structurally; the
  `/create <wcid>` admin command path for spawning a test
  portal is finicky in the @telepoi spawn radius (no
  portals natively in vision; ACE's slash-prefix admin
  parsing rejects under some conditions). Capture
  soft-passes when no portal is reachable; symbol presence
  + JS dispatch pinned by smoke. Step 5 polish that
  could land in a follow-on: pickup-via-MoveToObject for
  weapons / armor / gems (currently click-only routes
  through `UseObject`, which ACE doesn't honour for
  pickup); vendor-window UI on `kind=12` (today the
  reception is just a chat line in the Trade tab).
- **Bandwidth rail** — Phase 5.2 (manifest scale fix) at
  [`manifest.md`](manifest.md). Real-world bake produces a
  **203 MB** `manifest.json` (885,043 entries × ~230 bytes
  verbose JSON; `eor/cell` envcells dominate). Closes the
  manifest itself as the new bandwidth cliff (Phase 5.0 closed
  the original 605 MB single-bundle cliff). Required before
  public CDN deployment or 600 kbps cellular validation
  (Phase 5 obj 11). NOT required for dev iteration over
  Tailscale WiFi.

**Recommended order: content rail first.** The v1 → v2 manifest
swap proposed in `manifest.md` is contained entirely inside
`ManifestResourceSource::connect`/`prefetch` and the bake-time
emission in `dat-shard`. Every `fetch_*` export keeps the same
shape across both versions (`global_source().prefetch(&keys)
.await + get_file_by_key`), so new exports content work adds
cost effectively zero lines to migrate when 5.2 lands. The
reverse ordering (5.2 first) also works fine; it's just more
infrastructure-before-features. Skip 5.2 entirely until you
need obj-11 phone validation or public CDN deploy.

**Polish backlog** (none gating; what was deferred at each
step's landing, plus what got closed since):

- ✅ ~~Cache-miss entity model upgrades via on-demand
  `fetch_model_meshes`~~ — **closed 2026-05-06**, see step
  3.6 above.
- ⏳ **Camera-follow toggle.** Camera centred on Holtburg
  geometric centre with mouse-wheel zoom + drag-to-pan; a
  "follow the local player sprite" mode would conflict with
  manual pan, so it needs a UI affordance.
- ✅ ~~**Position interpolation between PublicUpdatePosition
  echoes.**~~ **Closed 2026-05-08.** Non-local entities now
  ease between authoritative position updates over a 150 ms
  catch-up lerp instead of snap-rendering to each echo. New
  `ENTITY_LERP_DURATION_MS` constant + `tickEntityInterpolation()`
  per-rAF function in `index.html`; `handlePositionUpdate`
  branches on `localPlayerGuid` so the local player keeps its
  step 3.5 keystate-driven prediction (lerping the local
  sprite would add input lag on top of every
  PrivateUpdatePosition reconciliation). Portal swirl tracks
  the lerping sprite. Pure JS; no wasm-bindgen or Rust
  changes.
- ⏳ **VectorUpdate / UpdateMotion velocity handling.**
  ACE sends these for animation-hint extrapolation; recv loop
  drops them in the catch-all `_` arm. A future step could add
  velocity to `EntityUpdate` and let JS extrapolate position
  for smoother motion at the cost of one frame of lag.
- ⏳ **Entity culling for dense zones.** Every entity ACE
  pushes gets a sprite. Frustum-culling against the camera's
  visible-world rect would matter for mobile and for high-
  population zones beyond Holtburg.
- ⏳ **Local-player visual highlight.** No outline-ring or
  arrow indicator distinguishing the local player from other
  entities yet. Small future polish.
- ⏳ **Mid-session character switching.** `LoopState::InWorld
  { player_guid }` is set once on PlayerCreate and never
  cleared. Switching characters means tearing down the session
  and starting a new one, OR extending the LoopState machine.
- ⏳ **Click-to-move.** Server-initiated pathfinding via
  `MoveToObject` / `MoveToPosition`. Independent path from
  WASD; nice-to-have for the gameplay loop, not blocking.
- ⏳ **Jump (Spacebar).** Needs `MovementParameters` extension
  and resolution of the keymap collision with the chat-window
  toggle most clients use.
- ⏳ **Combat-stance switch / weapon hotkey.** `CURRENT_STYLE`
  flag (`MotionStance::HandCombat` etc.). Step 3 omits the
  bit; ACE preserves whatever stance it last set.
- ⏳ **Snap-smooth reconciliation** for `PrivateUpdatePosition`
  authoritative corrections — currently a hard set; ~100ms
  lerp would feel softer.
- ✅ ~~**Outbound `AutonomousPosition` heartbeat to ACE.**~~
  **Closed 2026-05-07** by Phase 4 step 3.6 — the cli's
  `MovementSystem` is now wired into the wasm recv loop via
  `MovementSystemHandle` and fires `AutonomousPosition`
  packets every `AUTONOMOUS_POSITION_HEARTBEAT_INTERVAL`
  (1 s) while moving. Validated end-to-end via
  `capture_phase4_step3.cjs` + `ace_shard.biota_properties_
  position` query: 14.8 m of server-side Y advancement on a
  15-s walk. Was the load-bearing fix; without it the
  server-side player was frozen at spawn forever and no
  encounter generators in adjacent landblocks ever activated
  via vision. See `docs/phase-4-step-3.6-movement-system.md`
  for the design + the 5 follow-on bugs the original
  structural commit missed (silent `log` crate; entity seed
  on the wrong recv arm; missing local-pose integrator;
  `RunRateUnavailable` fallback caps; `PlayerTeleport` →
  `LoginComplete` loop to clear ACE's silent-drop
  `Teleporting=true` flag).
- ⏳ **Lambert hillshade in the terrain shader.**
  `RenderPreviewRenderer.cs:487-503` adds it on top of the
  bilinear blend (9×9 height texture per LB + finite-difference
  slope in the shader). ~2 hours; deferred at step 3.6 landing.
- ⏳ **Detail textures / road texture fill.**
  `TMTerrainDesc::DetailTexGID` carries small-scale noise; the
  static site uses `RoadType` as a repeating shader fill on
  the road stroke. We use flat stone-grey for roads; switching
  to a textured stroke is a PIXI line-style tweak.
- ✅ ~~**Real character-biota-driven movement caps**~~
  **handler wired 2026-05-07** as Phase 4 step 3.7 (a). The
  recv loop now handles `GameEvent::PlayerDescription` —
  hydrates the player from the inbound description, applies
  world-state changes, emits derived stats, and clears the
  3.6 fallback `SelfMovementCapabilities` override so
  subsequent `resolve_self_movement_capabilities` reads the
  player's real run rate (Run skill + burden) and motion
  table. If the real biota fails to resolve for any reason,
  the fallback is re-installed defensively. Mirrors the cli's
  dual-path handler in `holtburger-world/handlers/{login,
  player}.rs`. Required `pub` lifting on
  `WorldState::{apply_player_description_world_state,
  emit_player_derived_stats}` and on
  `set_self_movement_capabilities_override` (was test-only).
  Verification still pending: the live capture run didn't
  trigger PlayerDescription delivery (capture-script + ACE
  flow specifics — ACE may send it earlier than the recv
  loop's GameEvent arm fires under some session conditions).
  When confirmed, real biota also unblocks per-character
  speed buffs / debuffs / stamina effects, combat damage
  formulas, and skill-checked abilities.
- ✅ ~~**Landblock-crossing correctness in local-pose
  integrator**~~ **landed 2026-05-07** as Phase 4 step 3.7
  (b). New `WorldPosition::rebucket_outdoor_landblock` in
  `holtburger-common::position` walks coords past
  `[0, METERS_PER_LANDBLOCK)` and adjusts the high word of
  `landblock_id` (X = bits 24-31, Y = 16-23) accordingly,
  re-deriving the cell index via `normalize_outdoor_cell`.
  Edge-of-world (X or Y at 0 / 255) clamps. Indoor poses
  no-op. Called from
  `MovementSystem::advance_local_pose_for_manual_drive`
  immediately after the velocity integration so heartbeats
  always carry a coherent (landblock, local coords) pair.
  Five unit tests in `position::tests::test_rebucket_*`:
  in-bounds no-op, north cross, south-west diagonal cross,
  cell-id recompute, indoor no-op. All green.
- ⏳ **Authentic TexMerge mode.** `fetch_terrain_alpha_masks`
  Rust export + 3 retail-mask constant tables stay in the
  bundle as scaffolding; JS-side `decodeCellPalette` +
  per-cell data textures + sequential alpha-blend shader was
  removed but recoverable from git (commit `b78cd56` before
  the revert at `057762e`). Per-cell hand-tuned patches —
  authentic to retail but blockier than the bilinear bake.
- ⏳ **Runtime Region (`0x13000000`) parser.**
  `holtburger-dat::file_type::Region` doesn't exist yet; the
  retail TexMerge data is hard-coded as constants in lib.rs.
  Custom regions (e.g. WorldBuilder-emitted .dat files) would
  need a Rust parser; deferred but not gating.
- ⏳ **Animation state.** Sprites slide as rigid textures; no
  walk-cycle anims. Step 4+ scope.
- ⏳ **Realistic NPC / portal / monster rendering.** Live
  entities currently render as generic textured silhouettes
  with no nameplate, no per-WeenieType tint, no palette
  variant, no portal swirl, no sign inscription, and no
  `obj_scale` propagation. **Promoted to a full step (6) — see
  §8 Phase 4 step 6 for the as-framed brief.** Subsumes the
  "magenta placeholder dot → static-site glyph fallback"
  polish that was loosely tracked here previously.

### What to read next

In order:

1. **This document.** Long-lived design intent, decisions
   (§4 + §5), open questions (§7), phase status (§8),
   reference index (§9).
2. [`phase-4-renderer.md`](phase-4-renderer.md) — Phase 4 step
   1 + 2a + 2a.5 + 2a.6 + 2b as-built. Read before adding any
   wasm-bindgen export or recv-loop branch.
3. [`phase-4-step-3.6-movement-system.md`](phase-4-step-3.6-movement-system.md)
   — Phase 4 step 3.6 plan + as-built notes. Read before
   touching the recv-loop's `world: Option<WorldState>` /
   `MovementSystemHandle` plumbing or the local-pose
   integrator. Also documents the 5 follow-on bugs the
   structural commit missed (PlayerTeleport→LoginComplete is
   the load-bearing one) and the step 3.7 deferred work
   (real character-biota loading + landblock-crossing
   correctness).
4. [`phase-3-renderer.md`](phase-3-renderer.md) — Phase 3
   step 1-6 as-built. Read before touching the renderer
   pipeline (heightmap, terrain shader, sprite atlas, runtime
   per-model render).
5. [`phase-5-thorough.md`](phase-5-thorough.md) — Phase 5.0 /
   5.0b / 5.1a / 5.1b as-built. Read before changing the
   manifest, `ManifestResourceSource`, `dat-shard`,
   `holtburger_dat::walk`, or the smoke harness.
6. [`thorough.md`](thorough.md) — Phase 5.0 framing brief
   (already executed; stays as historical context for the
   delivery-architecture decisions).
7. [`manifest.md`](manifest.md) — Phase 5.2 framing brief
   (**not yet executed**; the next agent on the bandwidth
   rail picks this up).
8. [`ace-local-setup.md`](ace-local-setup.md) — recipe for
   bringing up ACE locally for live-ACE work.
9. [`phase-2-wasm-spike.md`](phase-2-wasm-spike.md) — Phase 2
   wasm32 cross-compile spike record. Read only if rebooting
   the wasm cross-compile floor.
10. `~/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`
    — auto-loaded into Claude's context. Verify it matches
    this document's status section before relying on it.

### Process notes for the next agent (worth reading before renderer work)

These are footguns + workflow patterns the 2026-05-06 session
hit and resolved. Pay the 5 minutes of reading time; each saved
30+ minutes of debugging on first encounter.

1. **`emit-static-site` is the authoritative reference for the
   live client's renderer**, NOT `ACE.Server.Physics.Common.
   TexMerge.cs`. Retail AC's actual client used TexMerge
   (per-cell alpha-mask overlays); the static site uses
   bilinear 4-corner blend + vector roads instead. The first
   pass of step 3.6 ported TexMerge faithfully and produced
   *more* visible blockiness than the previous flat-cell
   shader because the alpha masks fit one 24m cell each. Only
   the static-site approach matches the user's reference
   tile pyramid. **If you're touching terrain rendering, read
   `WorldBuilder.Terminal/RenderPreviewRenderer.cs:349-516`
   first**, not the C# `TexMerge.cs`.

2. **Always ground rendering work in `WorldBuilder.Terminal`'s
   diagnostic commands.** The README's "three observation
   channels" are exactly what you need:
   ```
   $ echo '{"command":"render-preview","lbX":169,"lbY":180,
            "radius":1,"resolution":1024,
            "outputPath":"/tmp/holtburg.png"}' | \
     ~/.dotnet/dotnet WorldBuilder.Terminal.dll --stdin \
       --project ~/projects/RetailSmoke/RetailSmoke.wbproj
   $ echo '{"command":"get-terrain-data","lbX":169,"lbY":180}' | \
     ~/.dotnet/dotnet WorldBuilder.Terminal.dll --stdin --project ...
   ```
   `render-preview` is the visual ground truth (the static
   site's own output for any LB region). `get-terrain-data`
   returns the per-vertex terrain types as JSON. With both
   you can triangulate "wrong shader" vs "wrong data". The
   2026-05-06 transpose bug was found only after diffing the
   wasm `terrainCodes` against `get-terrain-data`'s grid — it
   would have been invisible without the comparison. The WB
   ground truth screenshot is committed at
   `docs/images/wb-terminal-holtburg-ground-truth.png`.

3. **Wasm terrain data is column-major.** `mesh.terrainCodes`
   from `fetch_landblock_heightmaps` is laid out
   `[gridX * 9 + gridY]`, NOT row-major. Vertex `i` has
   `gridX = i/9, gridY = i%9` — verifiable from
   `mesh.positions[i*3..]`. Canvas/GL textures are row-major.
   Any new code that uploads vertex data to a 9×9 texture
   must transpose: `bytes[(row*9+col)*4] = terrainCodes[col*9+row]`.
   Same applies to `roadCodes`. The shader's `texelFetch
   (ivec2(iu, iv))` then returns the value at the physical
   vertex (gridX=iu, gridY=iv) — which is what
   `vGridUv = aPosition / 24` computes from world coords.

4. **Canvas → PIXI texture upload premultiplies alpha.** Any
   data texture (cell-data, vertex-types, masks) must have
   A=255 on every byte. A=0 silently zeroes the RGB on upload
   and the shader reads (0, 0, 0) for that texel. The 2026-
   05-06 cellBase texture had `A=0` for non-allRoad cells and
   every cell read primary=0 (BarrenRock) — fixed by encoding
   the allRoad flag as a `primary == 255` sentinel instead.
   Encode flags in the channels you're already using or use
   sentinel values; never depend on the alpha channel for
   non-rendering data.

5. **PIXI 8 minifies class names.** `entry.sprite.constructor
   .name` returns `"me"` for `PIXI.Sprite` after the bundle
   ships. Don't probe rendering type via `constructor.name`;
   tag entries with explicit string fields instead (e.g.
   `entry.kind = "sprite" | "placeholder" | "invisible"`).

6. **Backticks inside GLSL template literals terminate the JS
   parser.** `const TERRAIN_FRAGMENT_GLSL = \`...comment with
   \`backticked\` reference...\`` breaks at the inner
   backtick. Use single-quotes or no quotes inside GLSL
   comments. `node --check <module.mjs>` catches this; pre-
   reload syntax-check after editing GLSL strings.

7. **The wsbridge needs `--listen 0.0.0.0:8080`** for
   tailnet-laptop browsers to reach it. The default is
   localhost-only. The user's flow is: laptop on Tailscale →
   `http://100.116.47.66:8765/...` → page → `ws://100.116.47.66
   :8080/` → wsbridge (running on the dev box) → ACE on UDP
   `127.0.0.1:9000`. Bind external on the WS hop or the page
   gets stuck at "connecting…".

8. **ACE's `OnMoveToState` short-circuits unless `IsPKType`.**
   `Player_Tick.cs:154` — `FastTick => IsPKType`. For
   client-driven movement to invoke server-side physics
   simulation, the player must be PK. The capture sends
   `@pk pk` after teleport; manual testing on a fresh dev
   account works the same way. ACE's `Config.js:
   DefaultAccessLevel: 4` ensures auto-created accounts have
   Developer access for the `@pk` command.

### Decisions settled (do not re-litigate)

§7.1 external WS proxy over ACE patch, §7.2 single namespaced
HBA-of-HBAs **superseded by Phase 5.0 manifest+shards
delivery** (§7.2 below has the supersedence note), §7.3
Leaflet replaced by PixiJS-only, §7.4 wasm-pack over trunk.
The §4.5 direct-DAT rendering rail (replaced the static-site
tile pyramid as live-client basemap) is settled. §5.2 records
the wasm cross-compile sweep; §5.5 records the RC4 vs ISAAC
audit. The Phase 5.0 architecture (sync `ResourceSource` +
async `prefetch`, content-addressable shards, transitive boot
walk) is settled — see [`phase-5-thorough.md`](phase-5-thorough.md)
"Decisions to NOT re-litigate" for the full list.

**Step 3.6 settled (2026-05-06):** terrain rendering is
**bilinear 4-corner blend + vector road lines**, NOT TexMerge
alpha-masked overlays. The TexMerge port was tried and rolled
back — see "Process notes" #1 above. The bilinear path matches
the `emit-static-site` tile pyramid exactly; the user's
reference output is `docs/sample-dist/projects/vanilla/tiles/
exterior/8/*` and the live client renders to that look. Don't
re-litigate per-cell alpha-mask compositing without a
specific authentic-AC-mode use case. **Cache-miss entity
models are fetched on-demand**, NOT batched at neighbourhood-
load time; the pendingModelFetches dedup keeps multiple-spawn
storms cheap. **The wasm `terrainCodes` layout is column-
major**; any data-texture upload code transposes on the way
in. **Canvas → PIXI alpha is premultiplied**; data textures
force A=255 always.

### Audience

Anyone picking up the next phase. Read this header end-to-end,
then descend to the section that matches the rail you're
pulling. Several seams below the abstract pretty-doc layer are
not what they appear at a glance — §3.1 in particular still
lists "two patches needed" against `ResourceSource` (the
async-trait refactor) that were *deliberately rejected* in
Phase 5.0 in favor of explicit `prefetch()`. Read §5.2 + the
Phase 5 ledger before drawing conclusions from §3.1's
groundwork-pass language.

---

---

## 1. TL;DR

`emit-dynamic-site` turns the static, snapshot-style Leaflet world map produced by
`emit-static-site` into a *playable* one: the browser becomes a real Asheron's
Call client, connected to a live ACE server, with player movement, chat, combat,
and creature/NPC behavior visible in real time. The view stays top-down — this
is not a 3D-engine port — but the entities under that view are alive.

Three vendored stacks meet here:

```
       ┌─────────────────────────────────────────────────────┐
       │                       browser                       │
       │  ┌────────────────────┐    ┌────────────────────┐   │
       │  │ holtburger (WASM)  │    │ PixiJS / WebGL +   │   │
       │  │  – session         │◄──►│ Leaflet basemap    │   │
       │  │  – world authority │    │ – terrain tiles    │   │
       │  │  – ClientView ev.  │    │ – live entities    │   │
       │  └────────┬───────────┘    └────────────────────┘   │
       └───────────┼─────────────────────────────────────────┘
                   │ WebSocket (one frame == one AC packet)
       ┌───────────▼─────────────────────────────────────────┐
       │                UDP ↔ WS bridge (TBD)                │
       └───────────┬─────────────────────────────────────────┘
                   │ UDP
       ┌───────────▼─────────────────────────────────────────┐
       │                ACE — :9000 / :9001                  │
       └─────────────────────────────────────────────────────┘
```

Plus an HTTP origin serving DAT/HBA assets to holtburger via a custom
`ResourceSource` impl that does range requests over `fetch()`.

## 2. Goals and non-goals

### Goals

- A browser URL where a player logs in and plays AC against a live ACE server.
- Top-down view (Leaflet-style pan/zoom for terrain; WebGL overlay for entities).
- Multi-project: vanilla AC and AI-generated worlds coexist via the existing
  emit-static-site project picker.
- The retail UI surfaces holtburger already implements (chat, vitals, inventory,
  spellbook, vendors) ride along, rendered in DOM panels next to the map.
- Reuse `emit-static-site`'s coordinate system, tile pyramid, and project
  manifest. Drift is a load-time error (`coordSystem` assertion already exists).

### Non-goals

- 3D rendering. (Holtburger's own roadmap pushes a Tauri 3D client as Phase 4;
  that is a different project. We ship the 2D top-down view first.)
- GDLE compatibility. Holtburger is ACE-only; we are too.
- Replacing the static site. emit-static-site keeps shipping and remains the
  zero-dependency, file://-friendly *snapshot* tool. emit-dynamic-site is the
  live-server *cousin*, not a replacement.
- Hosting. We design the stack so a deployment is possible; running a public
  server is a separate concern (and triggers AGPL §13 obligations — see §6.4).

## 3. Surfaces

### 3.1 holtburger — `external/holtburger/`

Hard-forked from upstream commit `629695a2` on 2026-04-23. AGPL v3.

Holtburger is a Rust workspace. The crates relevant to us:

| Crate | Role | Why we care |
|---|---|---|
| `holtburger-protocol` | AC packet structs, opcodes, pack/unpack | Transport-agnostic. We can run it as-is. |
| `holtburger-session` | UDP socket + fragment reassembly + crypto | This is the swap site. |
| `holtburger-content` | HBA discovery, `ContentRepository`, asset access | This is where DAT-over-HTTP plugs in. |
| `holtburger-world` | Authoritative world state | Runs unchanged. |
| `holtburger-core` | Orchestrator; emits `ClientViewEvent` deltas | Runs unchanged; this is the seam our renderer consumes. |

The README's architectural claim is real, not aspirational:

- **`Transport` trait** at `external/holtburger/crates/holtburger-session/src/session/types.rs:17-21`:
  ```rust
  #[async_trait]
  pub trait Transport: Send + Sync {
      async fn send_to(&self, buf: &[u8], addr: SocketAddr) -> Result<usize>;
      async fn recv_from(&self, buf: &mut [u8]) -> Result<(usize, SocketAddr)>;
  }
  ```
  `Session` already holds `transport: Box<dyn Transport>`. The catch: `Session::new()`
  hardcodes a `UdpSocket`; there is no public builder for injecting a custom
  transport. **Patch needed:** add `Session::new_with_transport(...)`.
- **`ResourceSource` trait** at `external/holtburger/crates/holtburger-dat/src/lib.rs:138-148`.
  Three methods (`get_file_by_key`, `get_metadata_by_key`, `has_namespace`),
  return type `Vec<u8>`. The original groundwork pass said "two
  patches needed: make it async + add a streaming variant"; **both
  were deliberately rejected** in Phase 5.0 (see §5.2 for the
  reasoning). The trait stays sync; `ManifestResourceSource`
  serves cached records sync from `Arc<Mutex<HashMap>>` and exposes
  a separate explicit `prefetch(&[ResourceKey<'_>]) -> impl Future`
  async method that each `fetch_*` export calls before any sync
  read. The "200MB+ landscape blob" framing was answered by the
  shift to per-record sha256-keyed shards (Phase 5.0); records
  are now ≤ a few KB each, fetched lazily on demand.
- **Fragment reassembly** at `external/holtburger/crates/holtburger-session/src/session/receive.rs:405-423`
  assumes one transport-layer message == one complete AC packet (with N fragments
  embedded). This is fine over WebSocket as long as the bridge sends one WS
  frame per AC packet — not one frame per fragment. Document that contract.

### 3.2 ACE — `external/ACE/`

AGPL v3. Listens on UDP `:9000` and `:9001` (login + world replies). The
network/session layer (the `ACE.Adapter` assembly with `SocketManager` and
`Session`) is referenced from the vendored source but the assembly itself is
not present in this tree — the project links it as a NuGet/DLL dependency.
That is *fine* for our purposes: we only need the public game-logic seam, not
the socket internals. Game code talks to `Session.Network.EnqueueSend(...)`,
not raw bytes.

For `emit-dynamic-site` ACE is a black box. We do not patch it. We put a
bridge in front.

### 3.3 emit-static-site — `WorldBuilder.Terminal/StaticSiteEmitter.cs`

Already understood — see the existing emit-static-site section in the top-level
README. Two facts that matter for `emit-dynamic-site`:

1. **The frontend has a forward-compatibility hook for live overlays**:
   `app.js:85-90` calls `loadScript('overlays/dynamic_players.js')` and
   silently no-ops if the file is missing. This is the documented seam we
   *would* use if we kept Leaflet for entities. We are not (see §4.2), but it
   confirms the static-site author considered this future.
2. **`coordSystem` is asserted at boot** (`app.js:387-412`). The dynamic
   client inherits the same constants — `worldExtentWu = 49152`,
   `tilePx = 256`, `lbWu = 192`, `pxPerWuAtZ0 = 256/49152`. The current
   live-client bundle does NOT yet assert them programmatically (TODO; see
   §4.5). The constant `METERS_PER_LANDBLOCK = 192.0` lives in
   `holtburger-common::position` and is the load-bearing source for the
   wasm side; both the live and static stacks have to agree on the 49152 m
   world extent (256 landblocks × 192 m).

**Sprite atlas — yes; tile pyramid — no.** The original draft of this doc
treated the static-site tile pyramid (`projects/<slug>/tiles/{terrain,
objects,object,floor}/z{N}/...`) as the live-client basemap. Phase 3
walks away from that — see §4.5 for the rationale. What we DO reuse is
the static-site **sprite atlas** at `projects/<slug>/sprites/atlas.{png,
js}`: hand-tuned, top-down-baked object art with world-bounds metadata,
already in PixiJS-ready shape. That gives visual continuity between the
static gallery and the live client without re-baking pyramids on every
WorldBuilder world change.

### 3.4 The new layer — UDP↔WS bridge (and shim)

This layer landed in Phase 1 (see §8). Two binaries in
`external/holtburger/apps/holtburger-wsbridge/`:

- **`holtburger-wsbridge`** — server-side. One process, listens on a WebSocket
  port (default `:8080`). Per WS connection, opens an ephemeral UDP socket
  toward the configured ACE host (login + world ports). One WS binary frame
  == one AC packet, both directions. Stateless w.r.t. game logic; stateful
  only for the WS↔UDP socket pairing.
- **`holtburger-wsshim`** — client-side mirror, optional. Binds the UDP ports
  an unmodified `holtburger-cli` already dials and tunnels them to a remote
  bridge. Only needed for the native cli; the WASM client (Phase 2) skips
  this binary and speaks WS to the bridge directly.

Neither knows AC encryption — bytes are passed through. Holtburger's session
layer does crypto on whichever side it ends up running.

**Why an external proxy** rather than patching ACE: the Explore agent verified
the network layer is fully abstracted (`Session.Network.EnqueueSend`, no
direct socket calls in game code) — a proxy is transparent. ACE patches mean
forking AGPL code, taking on permanent merge debt, and re-implementing fragment
reassembly inside ACE. The proxy is 1–2 weeks; the patch is multi-month.

The decision is provisional. See open questions §7.

## 4. Decisions taken in this pass

These are the answers we committed to in groundwork. Each is rebuttable, but
each is what the rest of the plan assumes.

### 4.1 Holtburger compiles to WASM and runs in the browser

The other path was "server-side holtburger per player": each session is a
backend process or task, the browser holds only renderer + input. That is
cheaper to build (no WASM port) and equivalent in latency, but pushes server
cost up linearly with concurrent players and concentrates AGPL §13 exposure on
the operator.

Picking WASM means **the browser is the AC client** — same posture as a
desktop install, same AGPL §13 footprint as serving any other browser app, no
per-player backend session brain. The cost is the port:

- **Tokio:** Holtburger's `Cargo.toml` line 33 sets `tokio = { ..., features = ["full"] }`.
  `full` includes native I/O (epoll/kqueue/IOCP). On WASM we need
  `wasm-bindgen-futures` + a feature-trimmed Tokio (`rt`, `sync`, `macros`,
  `time`) or a swap to a different async executor. Audit and rework every
  Tokio call site.
- **`socket2`:** `external/holtburger/crates/holtburger-session/src/session/api.rs:11`
  uses `socket2` to set UDP receive buffer size. Not portable. Either
  feature-gate it off WASM, or reconsider whether the buffer tuning matters
  for a WS-fronted Transport (probably not — flow control is different).
- **`std::fs`:** `holtburger-dat` opens DAT files via `File::open()`. On WASM,
  there is no filesystem. Replace with `ResourceSource` everywhere — which is
  the abstraction holtburger already exposes; the work is making sure no
  internal helper bypasses it.
- **`getrandom`:** crypto needs entropy. `getrandom` has a `js` feature that
  routes to `crypto.getRandomValues` in browsers. Add the feature; verify the
  RC4/ISAAC seed flow doesn't assume `/dev/urandom`.
- **No `wasm32` story today:** the codebase has zero `cfg(target_arch =
  "wasm32")` guards. We add them as we go; the discipline is *fail-stop on
  WASM* for any code path that doesn't yet have a WASM impl, not silent
  best-effort.

This is real work — call it a quarter of engineering effort, not a weekend.
The payoff is a single deployment artifact: a static bundle (HTML + JS + WASM)
behind a CDN.

### 4.2 PixiJS / WebGL renderer, not Leaflet markers

The Explore agent confirmed: at z=11–12 the static site bakes objects into
*tiles*, not markers. There is no marker layer at all today. Leaflet's marker
performance ceiling (DOM-element-per-entity, hitbox per pan/zoom) tops out
around 1k entities; AC has thousands of dynamic creatures and players in a
populated zone. Leaflet markers are a non-starter.

The chosen path: **PixiJS over WebGL for the live entity layer, plus a separate
2D tile basemap** (we keep Leaflet *only* if it earns its keep as the tile
pan/zoom plumbing; otherwise reach for a thinner tile renderer or write our
own — open question §7.3).

PixiJS gets us:

- 10k+ sprites at 60fps under one draw call's worth of overhead.
- The same `coordSystem` math we already have (world-units → tile-pixels →
  screen-pixels is a linear transform; PixiJS containers invert cleanly).
- A clean entity buffer abstraction: each `ClientViewEvent` mutates a flat
  array of {id, x, y, rot, modelKey, animFrame}; render reads the array each
  frame; no per-entity DOM.

The static-site sprite atlas (`projects/<slug>/sprites/atlas.{png,js}`) is
already in the right shape for PixiJS — top-down baked sprites with world
bounds metadata. We reuse it.

### 4.3 Holtburger hard-forked into `external/holtburger`

The submodule path was discarded because §4.1 and §3.1 require non-trivial
patches (Transport builder, async ResourceSource, WASM cfg gates). Submodule
+ patch directory is more ceremony than benefit when we already plan to
upstream nothing for several months. `external/holtburger/VENDORED.md` records
the upstream commit and the resync procedure.

### 4.4 The bridge is external (provisional)

Both Explore agents converged. The patch path is open if a specific need
forces it (e.g., we end up needing ACE-side awareness of WS clients for tick
batching). Default: external proxy.

### 4.5 Direct-DAT rendering — terrain live, sprite atlas reused (NEW, 2026-05-04)

The original draft framed Phase 3 as "Leaflet basemap built from the
emit-static-site tile pyramid + PixiJS entity overlay on top". Phase 3
step 1 walked away from that and rendered terrain *directly* from the
AC `eor/cell:XXYYFFFF` `CellLandblock` records via WASM. Phase 3 step 2
extended that to a 3×3 neighbourhood with PixiJS-owned pan/zoom — no
Leaflet anywhere in the live client.

**Why direct-DAT for terrain:**

- **WorldBuilder workflow.** Re-baking the tile pyramid every time
  WorldBuilder edits a world is the cumbersome part of the static
  pipeline. Direct-DAT means: change the world in WorldBuilder →
  HBA regenerates → reload the browser → terrain re-renders. Zero
  bake step in the inner loop.
- **One source of truth.** AC's DATs already contain heightmap +
  surface-tile-types + textures + object placements. The static
  site's tile pyramid is itself a pre-bake of the same data via the
  WorldBuilder pipeline. Reading the DATs directly removes a layer
  of indirection.
- **Live-only wins are reachable.** Time-of-day, dynamic lighting,
  entity animation — things the pre-baked tile pyramid structurally
  cannot do — become natural extensions of a live render path. They
  are awkward bolt-ons to a Leaflet basemap.

**Why we keep the sprite atlas:**

- The static-site `projects/<slug>/sprites/atlas.{png,js}` is
  hand-tuned, top-down-baked object art with world-bounds metadata,
  already in PixiJS-ready shape. Re-baking it from 3D models at
  runtime in WASM is theoretically possible but slow + complex.
- Visual continuity. The live client and the static gallery should
  read as the same game; sharing the sprite atlas is the cheapest
  way to guarantee that.
- WorldBuilder regenerates the sprite atlas in the same pipeline
  step as the rest of the project's assets, so the "edit world →
  reload browser" loop covers it without extra bake work.

**Practical quality ladder** for the live client to reach
static-site visual fidelity, in order of impact:

| Step | Visual jump | Status |
|---|---|---|
| Heightmap render | topographic relief, recognisable shapes | ✅ landed (step 1+2) |
| Texture atlas + surface table | recognisable AC terrain — biggest delta | ✅ landed (step 3 placeholder, step 3.5 real retail tiles) |
| Sprite atlas consumption | buildings/trees/decorations in the right spots | ✅ landed (step 4 silhouettes → step 4.5 per-model real colours from Surface chain → step 4.5c production atlas swap) |
| Live runtime per-poly rendering | stone walls + wood beams + roof tiles per pixel; custom-model-import-ready | ✅ landed (step 6) — every unique placed model triangulates + UV-maps in the browser at runtime |
| Road overlays + atmospheric polish | matches the README static screenshot | ✅ landed partial (step 5: roads only; atmospherics still open) |

Step 3 first shipped 32 placeholder solid colours per the brief's
scope-reducer guidance, getting the shader pipeline in place. Step
3.5 followed up with **real retail AC textures** by porting the
Palette (`0x04`), SurfaceTexture (`0x05`), and Texture (`0x06`)
parsers from upstream ACE and signature-scanning the Region binary
to extract the canonical 33-entry terrain → SurfaceTexture mapping
(skipping a runtime Region parser as multi-week scope). Each cell
now tiles a 256×256 sample of its real AC tile across its 24m face.

**Step 6 — live runtime per-model rendering** is the most recent
shift in the rail. The original assumption (recorded earlier in
this section) was "reuse the static-site sprite atlas at runtime."
That works for shipped retail content where the atlas already
covers the model, but fails the project's whole purpose for *custom*
models — users importing new content would need to re-bake the
atlas every change. Step 6 walks the same chain the static-site
emitter walks (`GfxObj/SetupModel → polygons → Surface →
SurfaceTexture → RenderSurface → RGBA8`), triangulates the model in
Rust, and rasterizes top-down via a per-poly UV-mapped fragment
shader in PIXI — at runtime, in the browser. Output goes to a
PIXI.RenderTexture cached by model_id. The static atlas remains as
a warm-start fallback for models the live walk fails on (rare —
Phase 3 step 6 reports 80 of 81 unique Holtburg models live-render;
the 1 outlier is an engine-internal light-source anchor with
NoPos-stippled geometry, correctly invisible). Custom models now
render immediately on the next page load with no rebake step,
which unblocks the WorldBuilder edit-and-reload loop §4.5 was
designed around.

**What's deliberately NOT in this rail:**

- Leaflet, MapLibre, or any 2D tile renderer (§7.3 answered:
  PixiJS-only).
- The `dist/projects/<slug>/tiles/` pyramid as live-client input
  (the bake-once cost is the cumbersome part being avoided).
- A separate "basemap vs. entity layer" architecture; everything is
  PixiJS scene-graph children, separable but unified.

This decision is recorded here so future readers don't re-litigate
"shouldn't we just use Leaflet" without an explicit reason.

## 5. Critical assessment

### 5.1 Leaflet at scale — what we're not using it for

Leaflet is excellent at three things: a tile pan/zoom UI, a tile cache, and
projection math. It is bad at a fourth: rendering many moving DOM elements.

The static site uses Leaflet at strengths #1 and #3 and works around #4 by
*pre-rendering entities into tiles*. The dynamic site cannot pre-render moving
entities, so we cannot use Leaflet for them. That is a structural fact, not
an optimization tradeoff.

The remaining question is whether we keep Leaflet for the basemap and overlay
PixiJS, or replace Leaflet entirely. Open question §7.3.

### 5.2 WASM-porting holtburger — eyes-open

The user picked the WASM path knowing it is harder than the server-side
alternative. The original cost-of-the-port checklist below was speculative;
**the empirical inventory now lives at
[`phase-2-wasm-spike.md`](phase-2-wasm-spike.md)** and replaces it as the
authoritative starting point. Read that first. Highlights:

- `holtburger-protocol` and `holtburger-common` already cross-compile to
  `wasm32-unknown-unknown` clean. The AC packet codec, opcode tables, and
  ISAAC crypto are WASM-portable as-is.
- The two real blockers are `tokio = ["full"]` (pulls in `mio`) and
  `zstd-sys` (pulls in a C compiler). Everything else cascades from these.
- The `Session::new_with_transport` constructor that the WS transport will
  plug into has landed (`crates/holtburger-session/src/session/api.rs`).
  Backwards-compatible with all existing call sites.
- The RC4 doc lie called out in §5.5 has been corrected.

The original speculative checklist, all closed:

- [x] `holtburger-session::Session::new`: split into `new(addr)` (native) and
      `new_with_transport(transport, addr)` (any-transport). Done as
      `new` + `new_with_transport`; backwards-compatible. (`f3d9a1c`)
- [x] Audit RC4 vs ISAAC (§5.5). Code was always ISAAC; the two stale doc
      references at `external/holtburger/ARCHITECTURE.md:75` and
      `crates/holtburger-session/ARCHITECTURE.md:19` are corrected.
      (`f3d9a1c`)
- [x] `Cargo.toml`: workspace `tokio = { default-features = false }`, with
      per-crate feature opt-ins. Native-only crates pick `["full"]`;
      WASM-target crates pick `["rt", "sync", "macros", "time"]`. Landed
      in the Phase 2 floor commits `50003ae`..`868c3ac`.
- [x] Cfg-gate the UDP path in `holtburger-session` to
      `cfg(not(target_arch = "wasm32"))`; cfg-gate `socket2` likewise.
      Landed in the same Phase 2 floor range.
- [x] `holtburger-dat`: replace `zstd-sys` with `ruzstd` for wasm32 (kept
      `zstd` natively for the dat2hba tool). `decompress_zstd(buffer,
      expected_size)` cfg-split helper in `archive.rs`. Phase 2 floor.
- [x] **Reversed:** `ResourceSource` stays sync. `HttpResourceSource::connect`
      `await`s the bytes once at construction time and serves them sync from
      in-memory state. The async-trait refactor would have propagated `.await`
      through ~6 call sites in 4 crates plus a `#[async_trait(?Send)]`
      cfg-split mirroring `Transport`; not worth the spike cost. `Vec<u8>`-
      backed `HbaReader` is `Send + Sync`, so `LayeredResourceResolver`'s
      `Vec<Arc<dyn ResourceSource>>` storage accepts `HttpResourceSource`
      without trait-level changes. Reconsider only if memory pressure forces
      streaming. (`b4da651`, `ac7f92d`)
- [x] `WsTransport: Transport` for browsers — landed in
      `crates/holtburger-transport-ws`, wasm32-gated so native graphs don't
      pull `web-sys`. (`e151003`, `2364277`)
- [x] `HttpResourceSource: ResourceSource` — landed in
      `crates/holtburger-resource-http`. Three cascaded fetch paths
      (`Window`, `WorkerGlobalScope`, `Reflect::get(globalThis, "fetch")`)
      so the same bundle works in browser tabs, workers, and Node ≥ 18.
      (`ac7f92d`)
- [x] `tokio::spawn` Send audit — handled implicitly by the `Transport`
      trait cfg-split: native trait keeps `Send + Sync` + `#[async_trait]`,
      wasm32 trait drops them + uses `#[async_trait(?Send)]`. Survey of
      session/core call sites confirmed nothing actually spawns a `Session`
      across threads today. (`e151003`)
- [x] Build pipeline: `wasm-pack` picked over `trunk` (we're "Rust crate
      consumed by JS"). New crate `apps/holtburger-web` is the cdylib bundle.
      Two verification paths: `node smoke_test.cjs` against the
      `--target nodejs` build and a real browser against `--target web`.
      (`3025834`)

The empirical record is in `docs/phase-2-wasm-spike.md` and the as-built
crate matrix at §3 of that file. The auto-memory entry
`project_emit_dynamic_site.md` carries the same information for future
sessions.

### 5.3 DAT-over-HTTP — feasible, but thoughtful — RESOLVED

The `ResourceSource` trait makes this trivial *to wire up* and non-trivial *to
do well*. The three open questions below all landed in Phase 5.0 (see
[`phase-5-thorough.md`](phase-5-thorough.md) for the as-built reference):

1. **Granularity. — RESOLVED:** content-addressable per-record
   shards. `dat-shard` (commit `0d81554`) slices the source HBA
   into one file per unique sha256, plus a small precompiled
   `boot.hba` (Phase 5.1's transitive walk; commit `5fb0919`)
   covering everything reachable from the spawn-area landblock.
   `ManifestResourceSource` (commit `f760981`) fetches the boot
   pack at construction time and lazy-fetches individual shards
   via the explicit `prefetch(&[ResourceKey<'_>])` async surface.
   The original Phase 2 single-bundle answer (§7.2) was
   superseded by this shift — see §7.2 supersedence note. The
   *manifest itself* is now the size cliff (203 MB on a real
   bake); Phase 5.2 closes that — see
   [`manifest.md`](manifest.md).
2. **Caching. — RESOLVED:** service-worker-backed Cache Storage.
   `apps/holtburger-web/service-worker.js` (commit `78c6924`)
   intercepts `/shards/*.bin` requests, serves from the
   persistent Cache Storage if present, falls through to network
   on miss, stashes successful responses for next visit. Cache
   Storage gets the IndexedDB durability guarantee with
   `Request`-keyed lookup. The wasm bundle's in-memory shard
   cache (`Arc<Mutex<HashMap>>` in `ManifestResourceSource`)
   layers on top for per-session warm hits.
3. **Security/integrity. — RESOLVED at the architecture layer;
   operator-driven at deployment.** Sha256-keyed shards mean
   tampered shards fail to verify against the manifest's hash;
   `ManifestResourceSource::prefetch` rejects mismatched bytes
   with `PrefetchError::HashMismatch` (commit `f760981`). The
   AGPL §13 / AC asset distribution concern is operator-side;
   flag it in deployment docs (Phase 6 hosting brief, still
   open).

### 5.4 AGPL v3 §13 — a real obligation, not a footnote

AGPL §13 ("Remote Network Interaction") says: if a hosted service lets users
interact with our modified version, we must offer the source. For
`emit-dynamic-site`, this means an operator running the dynamic site at, say,
`example.com/play` has to:

- Publish their fork (including patches to holtburger, the WS bridge, the
  PixiJS frontend, the WASM build pipeline) at a URL the running service
  points users to.
- Keep that URL in sync as patches roll forward.

This is not a problem for the project itself — we publish under AGPL. It *is*
a problem for some downstream operators who may not realize they have a
publication obligation. We document it in the README's License section and
in the deployment docs (when those exist).

### 5.5 Encryption: a discrepancy worth chasing — RESOLVED

> Resolved in the Phase 2 opener (commit `f3d9a1c`). The Explore-agent
> verdict during the groundwork pass was: holtburger crypto is **ISAAC
> only**, used as a per-packet keyed checksum (not a stream cipher over
> the body — see `session/receive.rs` and `session/reliability.rs`).
> The two stale "RC4" doc references were corrected. No RSA either —
> the substring `*ServerSave*` was the only `RSA` grep hit and it is
> coincidental.

## 6. Holtburger's modular network/session stack — a closer look

Restating the README claim with citations so future work can move directly:

> "Asheron's Call clients require a UDP↔WebSocket bridge and holtburger's
> network/session stack is modular so it technically can be swapped out for a
> WS layer if needed."

Verified, with one footnote:

- `Transport` trait: `external/holtburger/crates/holtburger-session/src/session/types.rs:17-21`.
- `Session` field: `transport: Box<dyn Transport>` at `types.rs:90`.
- Construction site that hardcodes UDP: `external/holtburger/crates/holtburger-session/src/session/api.rs:9-11`.
- Test transport (`MockTransport`) implementation already exists, proving the
  abstraction has more than one implementer.

**The footnote:** the trait exists; the *constructor that injects an
arbitrary transport* does not. Adding `Session::new_with_transport(...)` is a
small, contained patch. It is not a "no swap is possible" finding — but
neither is this a "one-line change."

## 7. Open questions

Each is a real fork in the road. Items 7.1-7.4 have been answered as
of 2026-05-04 and are kept here annotated; items 7.5-7.6 are still
genuinely open.

### 7.1 WS bridge: external proxy or ACE patch? — ANSWERED: external proxy

> Resolved by Phase 1 (2026-05-03 + 2026-05-04). The
> `holtburger-wsbridge` + `holtburger-wsshim` pair landed; 21 tests
> green including a full `cli ↔ shim ↔ bridge ↔ echo` loop with login
> + world traffic interleaved (`d00770a`, `0945b7f`). Validates the
> proxy is transparent: an unmodified `holtburger-cli` reaches the
> echo server entirely over WebSocket. Live-ACE round-trip is the
> only Phase 1 follow-on, blocked on three MySQL DBs + ACE DAT files.
>
> The patch path stays open if ACE-side awareness of WS clients ever
> becomes load-bearing, but no force has appeared yet.

### 7.2 DAT delivery format: per-asset, or pre-sharded HBA? — ANSWERED twice: Phase 2 single-bundle, then Phase 5.0 manifest+shards

> **Phase 2 answer (commit `ac7f92d`):** ship a single
> namespaced HBA-of-HBAs bundle. `dats/assets.hba` (~230 MB at
> `--profile pruned`, 605 MB at `--profile full`); the wasm
> bundle's `HttpResourceSource::connect(url)` fetches it once
> at session start and serves entries sync. Worked for desktop
> + LAN; failed for cellular and corporate firewalls (the
> bundle's pre-load cost became the UX problem the answer
> deferred).
>
> **Phase 5.0 supersedence (commits `0578cb7..688550d`):**
> content-addressable manifest + per-record shards.
> `dat-shard` (separate from `dat2hba`) slices the source HBA
> into one file per unique sha256, plus a precompiled
> `boot.hba` covering the spawn-area transitive closure
> (Phase 5.1, commit `5fb0919`). `ManifestResourceSource`
> replaces `HttpResourceSource` as the browser's resource
> source. First-paint cost for Holtburg drops from 605 MB →
> 1.86 MB (boot pack) + a few hundred KB of catalog records;
> per-landblock cost becomes a few KB per record fetched
> lazily as the camera pans. Brief:
> [`thorough.md`](thorough.md). As-built:
> [`phase-5-thorough.md`](phase-5-thorough.md).
>
> **Phase 5.2 follow-on (NOT YET EXECUTED, brief at
> [`manifest.md`](manifest.md)):** the *manifest itself* is
> the new size cliff. A real-world bake produces a 203 MB
> `manifest.json` because every shard listing costs ~230 bytes
> of verbose JSON × 885k records. Phase 5.2 introduces a v2
> manifest format: tiny top-level (~2 KB) + lazy-fetched
> per-namespace binary catalogs (~6-8 MB gzipped each) +
> convention-derived shard URLs. Pulls the architecture out
> of "linear-with-world-content" into "constant-with-world-
> content" at the top level.
>
> See [`phase-2-wasm-spike.md`](phase-2-wasm-spike.md) §8.4
> for the original Phase 2 single-bundle rationale, and
> [`thorough.md`](thorough.md) §Context for why Phase 5.0
> superseded it.

### 7.3 Tile basemap: keep Leaflet, or replace? — ANSWERED: replaced (PixiJS-only)

> Resolved by Phase 3 step 2 (commit `f04b1f5`). The current bundle
> has no Leaflet — PixiJS owns pan, zoom, and the camera container.
> The third option (MapLibre GL) was not pursued; we are not doing
> tilt or 3D, so MapLibre's strengths don't apply.
>
> The deeper rationale lives in §4.5 — direct-DAT terrain rendering
> walks away from the static-site tile pyramid (the "cumbersome to
> re-bake on every WorldBuilder world change" part) while keeping
> the sprite atlas as visual continuity. PixiJS-only is the simplest
> way to express that: one rendering pipeline, one scene graph, one
> set of input handlers.
>
> The "spike Leaflet first, fall back to WebGL if event coordination
> becomes painful" plan from the original draft was overtaken by
> the Phase 3 step 1 work, where the simplest path turned out to be
> "just use PixiJS for everything from the start".

### 7.4 WASM build pipeline: `wasm-pack` or `trunk`? — ANSWERED: wasm-pack

> Resolved by Phase 2 §8 step 1 (commit `3025834`). `wasm-pack 0.14.0`
> picked over `trunk` because we are "Rust crate consumed by JS"
> rather than "the whole app is Rust" (PixiJS owns the renderer
> JS-side). Two verification paths land alongside the bundle: `node
> smoke_test.cjs` against the `--target nodejs` build (currently 17
> checks) and a real browser against the `--target web` build via
> Playwright + Chromium with `--use-gl=swiftshader`.

### 7.5 Login flow: real ACE accounts, or a transient guest path?

ACE expects username + password. The browser-playable client must collect
them. UX question: do we proxy directly (browser sends creds over WS, bridge
forwards UDP login packets), or does emit-dynamic-site sit behind an OAuth
gate that maps web identities to ACE accounts? Defer; the proxy path works
for the spike.

### 7.6 Server count: where does the bridge live?

One bridge per ACE world (operator-deployed alongside ACE) is the obvious
shape, but a single bridge could front many ACE worlds (multi-server picker
in the browser). Defer; either works.

## 8. Phased plan

Phase 0 — **Groundwork (DONE in this pass).**
- LICENSE.md (AGPL v3) at project root.
- holtburger hard-forked into `external/holtburger/`.
- README License + emit-dynamic-site sections.
- This design doc.

Phase 1 — **WS↔UDP loop spike.** ~1–2 weeks.
- Two standalone Rust binaries in `external/holtburger/apps/holtburger-wsbridge/`:
  the **bridge** (WS-side, in front of ACE) and the **shim** (UDP-side, in
  front of an unmodified cli). Together they let an existing
  `holtburger-cli` reach a real ACE entirely over WebSocket.
- Proves the proxy is transparent: the cli can log in, walk around, and
  chat against ACE without modification.
- No browser involvement yet. This is the "is the architecture even right"
  test, validated in software before the WASM port is attempted.

**Phase 1 status (2026-05-03):**
- ✅ Bridge binary `holtburger-wsbridge` at
  `external/holtburger/apps/holtburger-wsbridge/` (registered in workspace; AGPL).
- ✅ Client-side shim binary `holtburger-wsshim` in the same crate
  (`src/bin/wsshim.rs`). Mirror of the bridge: binds the UDP ports an
  unmodified `holtburger-cli` already dials and tunnels them over WS.
- ✅ Shared library (`src/lib.rs`) exposes the frame codec to both binaries
  so the wire-format contract changes in lockstep.
- ✅ WS frame protocol: `[port:u16 BE][ac_packet]` — see the crate's
  [`ARCHITECTURE.md`](../external/holtburger/apps/holtburger-wsbridge/ARCHITECTURE.md)
  for the rationale (login + world multiplex on one WS connection).
- ✅ End-to-end smoke tests cover both halves on their own *and* the full
  loop: `cli ↔ shim ↔ bridge ↔ echo` with login and world traffic
  interleaved. 21 tests total; all green.
- ✅ Allowlist guards on both binaries: only the configured login / world
  ports are forwarded; datagrams from other source IPs/ports are dropped.
- ✅ Listen-vs-ACE port split on the shim, so ACE-on-non-standard-ports
  works without retraining `holtburger-cli`.
- ✅ **Live-ACE round-trip — DONE (2026-05-04).** ACE brought up locally
  (`~/ace-server/` clone of upstream `ACEmulator/ACE`, MariaDB +
  three-DB provisioning, .NET 10.0.203 SDK, `Config.js` drop-in,
  `ACE_NONINTERACTIVE_CONSOLE=true` headless launch). Two validation
  paths both reached the cli's Selection page on a real ACE instance:
  (a) `holtburger-cli → UDP 9000 → ACE` direct, (b) full Phase 1 loop
  `cli → wsshim → wsbridge → ACE`. Login + handshake + DddInterrogation
  response + CharacterList + ServerName "ACEmulator-local" all received.
  See `docs/ace-local-setup.md` for the recipe + lessons learned.

Phase 2 — **WASM port spike (DONE, 2026-05-04).** ~3–4 weeks budgeted; landed
inside that window.
- ✅ `holtburger-session` cfg-gates UDP-native code; adds
  `Session::new_with_transport` (`f3d9a1c`).
- ✅ All seven library crates cross-compile to `wasm32-unknown-unknown`
  (`50003ae`..`868c3ac`). Native invariant held: 1086 lib tests across 13
  crates pass at every commit boundary.
- ✅ New crate `holtburger-transport-ws` with `WsTransport: Transport`,
  wasm32-only (`e151003`, `2364277`).
- ✅ `holtburger-dat::ResourceSource` stays sync (the async refactor was
  deliberately rejected — see §5.2). `HttpResourceSource::connect` does
  one async fetch at construction time and serves entries sync from
  in-memory state.
- ✅ New `HttpResourceSource` impl in `holtburger-resource-http`,
  wasm32-only, with three cascaded fetch resolution paths covering
  browser tabs, Web Workers, and Node ≥ 18 (`ac7f92d`, `5b6fefd`).
- ✅ `wasm-pack`-built bundle (`apps/holtburger-web`) loads in browser +
  Node smoke test; deterministic checks 17/17 PASS.
- ⏳ End-to-end bundle handshake against ACE through the bridge —
  blocked on the same Phase 1 follow-on (live ACE backend). The bundle
  has all the wiring (`try_ws_handshake_smoke`); the round-trip waits on
  the ACE backend unblock.

The "deepest-risk phase" framing held — Phase 2 was where the cross-
compile floor decisions could have caved. They didn't; the rest is now
product work.

Phase 3 — **Renderer scaffold (in flight, on direct-DAT rail; see §4.5).**
The original "Leaflet basemap + PixiJS entity overlay + reuse 95% of
emit-static-site's tile pyramid" framing was replaced in Phase 3 step 1.
The current rail is: render terrain directly from `eor/cell` HBA records
in WASM, keep the static-site **sprite atlas** for object art, walk away
from the tile pyramid. See §4.5 for the rationale and quality ladder.

Step ledger:
- ✅ **Step 1** (`a5e0a91`..`590fc95`) — `fetch_landblock_heightmap`
  wasm-bindgen export + PixiJS Mesh render of one Holtburg landblock.
  256×1 height-ramp gradient texture, wireframe overlay, single static
  view. Smoke test 8 → 14 checks. Deliverable:
  [`docs/images/phase-3-step-1-landblock.png`](images/phase-3-step-1-landblock.png).
- ✅ **Step 2** (`38afb1c`..`79818ac`) — 3×3 Holtburg neighbourhood,
  batch-fetched via `fetch_landblock_heightmaps`. PixiJS-only camera
  (mouse-wheel zoom around the cursor, drag-to-pan). Coordinate-unit
  fix landed on the way in (vertices are 24 m apart, not 3 m;
  landblock is 192 m, not 24 m — see the correction note in
  `docs/phase-3-renderer.md`). Smoke test 14 → 17 checks. Deliverable:
  [`docs/images/phase-3-step-2-multi-landblock.png`](images/phase-3-step-2-multi-landblock.png).
- ✅ **Step 3** (`06597eb`..`471d02a`) — per-vertex `terrainCodes` +
  custom GLSL ES 3.00 Mesh shader + 32-colour placeholder atlas.
  `flat in int vTerrainCode` from the SW provoking vertex so each
  cell shades as one terrain type. Shipped placeholder colours per
  the brief's scope-reducer; real retail tiles followed in step 3.5.
  Smoke test 17 → 20 checks. Deliverable:
  [`docs/images/phase-3-step-3-textured.png`](images/phase-3-step-3-textured.png).
- ✅ **Step 5 (partial — roads)** (`0a2e0a3`..`166bc2c`) — per-vertex
  `roadCodes` + road-overlay layer. Holtburg's stone-road network
  now renders as light-grey paths through the centre, matching the
  static-site z=12 reference. Atmospherics (fog, day/night) still
  open. Smoke 20 → 24 checks. Deliverable:
  [`docs/images/phase-3-step-5-roads.png`](images/phase-3-step-5-roads.png).
- ✅ **Step 3.5** (`0e47306`..`6fbc15f`) — Palette (0x04),
  SurfaceTexture (0x05), Texture (0x06) parsers landed in
  `holtburger-dat`. New `fetch_terrain_textures` wasm export decodes
  all 33 retail terrain tiles (signature-scanned from the
  `eor/portal:0x13000000` Region binary at bake time, not parsed at
  runtime — multi-week scope deferred). JS atlas builder downscales
  512×512 source → 256×256 atlas, custom shader switches from a
  32-column lookup to per-region UV math. Bumped fixture profile
  from `pruned` to `full` (605 MB) since pruned excludes the texture
  pipeline. Smoke 24 → 28 checks. Deliverable:
  [`docs/images/phase-3-step-3.5-real-textures.png`](images/phase-3-step-3.5-real-textures.png).
- ✅ **Step 4** (`5eb5736`..`19c4727`) — `fetch_landblock_objects`
  wasm export reads `LandblockInfo` Stab + BuildInfo lists, returns
  239 placements for Holtburg's 3×3. Static-site sprite atlas reused
  via PIXI sprite-tinting (atlas tiles were greyscale silhouettes at
  this point — see step 4.5c for the production-atlas correction).
  Drive-by fix: `BuildInfo.num_portals` was `u16` but ACE writes
  `u32`; mismatch only triggered when buildings had any portals
  (Holtburg's first interior building hits it). Smoke 28 → 32 checks.
  Deliverable:
  [`docs/images/phase-3-step-4-objects.png`](images/phase-3-step-4-objects.png).
- ✅ **Step 4.5** (`6d1b9e8`..`bcf4d2f`) — Surface (0x08) parser +
  `fetch_object_colours` wasm export. Walks each placed model's
  GfxObj/SetupModel surface chain in Rust, returns one ARGB per
  unique model_id. Two key footguns surfaced: Surface (0x08)
  records have **no leading `id` field** (unlike Texture / Palette /
  SurfaceTexture); `Surface.OrigTextureId` actually holds a
  **SurfaceTexture (0x05) ID**, not a Texture (0x06) ID — the walk
  needs an extra `SurfaceTexture::highest_res()` hop, mirroring the
  chain `WorldBuilder.Shared/Lib/Texture/RenderSurfaceImporter.cs`'s
  `CreateSurface` builder uses. Smoke 32 → 36 checks. After step
  4.5b's DXT decoder + step 4.5c's atlas swap, the resolve rate is
  **81/81 Holtburg unique models with 54 distinct ARGB values**.
- ✅ **Step 4.5b** (`5842d5a`..`9afb1d7`) — DXT1/DXT3/DXT5 decoder
  ported from upstream ACE `DxtUtil.cs` (Ms-PL, notice retained).
  Closes the last 27 of 81 Holtburg models that bottomed out at
  `Texture::to_rgba8: UnsupportedFormat(Dxt1|Dxt5)` in step 4.5.
  6 new unit tests (workspace lib total 1100 → 1106).
- ✅ **Step 4.5c** (`197369a`) — production atlas swap. The atlas
  step 4 copied from `docs/sample-dist/projects/vanilla/sprites/`
  was a 4096×1296 greyscale-silhouette build (R=G=B for every
  pixel verified across 3.7M opaque samples). Swapped in the
  fresh production atlas from `~/dist-regen/projects/vanilla/sprites/`:
  8192×4088 with 169 model entries and full per-pixel chroma
  (stone, wood, roof tiles in real AC colours). Removed the
  runtime sprite tint (it was destroying per-poly variety on a
  greyscale silhouette but multiplied destructively against
  colour-baked atlas tiles); fallback dot still uses the resolved
  per-model ARGB.
- ✅ **Step 6** (`8c41045`..`bce626a`) — **live runtime per-model
  rendering**. `fetch_model_meshes` + `fetch_surfaces_pixels` wasm
  exports (port of the static-site emitter's `TriangulateModel` +
  `AppendGfxTris` to Rust). JS-side rasterizer
  (`buildLiveSpriteMap` + `renderModelTile` + custom textured GLSL
  fragment shader) renders each unique model to a
  PIXI.RenderTexture cached by model_id. Mirrors
  `ObjectSpriteGenerator.cs::DrawTriangle` (per-poly UV-mapped
  texture sampling × per-vertex Lambert shade) at runtime —
  **custom models now render without a re-bake step**, which is
  the design's whole point per §4.5. Prereq fix: GfxObj polygon
  parser stipple/cull bit-mask bug (`0x01`/`0x02` should have been
  `0x04`/`0x08`; CullMode `1`/`None` should have been `2`/Clockwise)
  — was silently failing on ~50% of retail records, causing
  `failed to fill whole buffer` deeper in the parse. After the fix:
  15,318 / 15,318 retail GfxObjs parse successfully across the
  full bundle. **80 of 81 unique Holtburg models live-render**;
  the 1 outlier is `0x02000364`, an engine-internal light-source
  anchor (single 8cm × 6cm vertical triangle with NoPos stippling,
  no weenie binding across 43,911 retail weenies, correctly
  invisible — fallback dot suppressed via `bce626a`). Smoke 36 →
  41 checks. Deliverable:
  [`docs/images/phase-3-step-6-live-render-zoomed.png`](images/phase-3-step-6-live-render-zoomed.png)
  (3× zoom on Holtburg town centre showing wooden doors, reddish
  roof tile, plank-textured cart, stone walls + paths).
- ✅ **Step 3.6 — bilinear blend + vector roads + on-demand
  entity model fetching** (landed 2026-05-06; multi-commit
  range `b78cd56..29a358e` including a TexMerge detour at
  `b78cd56` reverted at `057762e`, the bilinear ship at
  `057762e`, the `38095b0` transpose fix, and the on-demand
  entity fetch at `29a358e`). Replaces step 3's per-cell flat
  shader with bilinear 4-corner blend reading from a 9×9
  vertex-types texture per LB (mirrors `RenderPreviewRenderer
  .cs:467-485`). Roads draw as vector PIXI.Graphics lines
  between adjacent road=1 vertices in E/N/NE/NW directions
  (mirrors `RenderPreviewRenderer.cs:551-580`), so diagonal
  road runs render as actual diagonal lines, not 24m blocks.
  On-demand entity model fetch closes the Phase 4 step 2b
  cache-miss-dot regression: ACE-streamed NPC csetup_ids
  that aren't in the static-placement cache trigger a one-
  off `fetch_model_meshes` + `fetch_surfaces_pixels` round-
  trip, with `pendingModelFetches` deduping concurrent
  requests, and the placeholder dot upgrades to a real
  textured sprite when the fetch resolves. At Holtburg
  53/53 entities textured (was 53/53 placeholder); cache
  grows from 80 → 98. Validated against
  `WorldBuilder.Terminal`'s `render-preview` ground truth at
  `docs/images/wb-terminal-holtburg-ground-truth.png`. The
  TexMerge alpha-mask Rust scaffolding stays exported in the
  bundle for any future authentic-AC mode (see "Process
  notes" #1). See
  [`phase-3-renderer.md`](phase-3-renderer.md) step 3.6 for
  the as-built reference. Step 5+ scope items in this section
  remain open below.
- ⏳ **Atmospherics (rest of step 5)** — fog of war, day/night
  gradient, post-process bloom on water tiles. Independent polish;
  not gating Phase 4.
- ⏳ **TexMerge alpha-masked overlays (authentic-AC mode)** —
  step 3.6 chose bilinear over TexMerge per the
  emit-static-site reference; the Rust
  `fetch_terrain_alpha_masks` + retail mask constants stay
  available for any future per-cell hand-tuned look. Recover
  the JS palette decoder + cell-data textures + sequential
  alpha-blend shader from commit `b78cd56` if rewiring.
- ⏳ **Multi-landblock streaming** — extend beyond the 3×3
  hardcode to N×N visible landblocks driven by the camera. Needs
  a landblock-id → `LandblockMesh` cache, camera-driven prefetch,
  eviction, LOD/culling. Step 5+ scope.
- ⏳ **Renderer-profile bake (asset-bundle size)** — step 3.5
  forced `dat2hba --profile full` because the existing `pruned`
  profile excludes Texture / SurfaceTexture / Palette types via
  `is_essential()`. Bundle grew 233 MB → 605 MB. A new `renderer`
  profile that's `pruned` + the texture-pipeline types would land
  in the ~280 MB range. Mechanical change in
  `crates/holtburger-dat/src/file_type/mod.rs` (extend
  `is_essential` or add a parallel filter). Step 5+ scope.
- ⏳ **`coordSystem` assertion** — the live bundle should assert
  `worldExtentWu = 49152, tilePx = 256, lbWu = 192, pxPerWuAtZ0 =
  256/49152` against the project's coord block at boot, mirroring
  `app.js:387-412`. Currently the wasm side reads
  `holtburger-common::position::METERS_PER_LANDBLOCK = 192.0` directly;
  the JS side hard-codes the same constant. Lift this to an explicit
  load-time check before Phase 4 wiring depends on it.

Phase 4 — **Wiring.** ~2 weeks. Gated on the live ACE backend unblock.

Step ledger:
- ✅ **Step 1 — wasm-driven AC login → CharacterList in browser.**
  Landed 2026-05-04 (see
  [`docs/phase-4-renderer.md`](phase-4-renderer.md) for the as-built;
  briefing at [`docs/phase-4-step-1-handoff.md`](phase-4-step-1-handoff.md)).
  Adds `start_session` + `SessionHandle` (with `poll_events()` /
  `characterList()` / `accountName`) + `ClientEvent` (kind=0
  CharacterListReceived) + `CharacterSummary` exports to
  `apps/holtburger-web/src/lib.rs`. JS-side login form gates the
  renderer; Selection screen renders the account's characters as a
  `<ul>` with a placeholder Spawn button (logs to console — step 2
  wires the actual `ClientCommand::SelectCharacter` flow). Side
  fix: `tokio::time::sleep` on wasm32 swapped for
  `gloo_timers::future::TimeoutFuture` in
  `crates/holtburger-session/src/session/receive.rs` — without it,
  the receive loop's CONNECT_RESPONSE deadline panics on
  `wasm32-unknown-unknown` ("time not implemented on this
  platform"). Smoke 41 → 44 checks. Manual live-ACE validation
  against `~/ace-server/` per `docs/ace-local-setup.md`; Playwright
  capture at `apps/holtburger-web/capture_phase4_step1.cjs`,
  deliverable at `docs/images/phase-4-step-1-character-list.png`.
- ✅ **Step 2a — spawn handshake → "Spawned" status.** Landed
  2026-05-04 (see [`docs/phase-4-renderer.md`](phase-4-renderer.md)
  step 2a section). Refactors `SessionHandle` to spawn a persistent
  recv loop via `wasm_bindgen_futures::spawn_local`; the loop
  `tokio::select!`s between `session.recv_message()` and an
  `mpsc::UnboundedReceiver<SessionCommand>` driven by JS. Adds
  `SessionHandle.selectCharacter(guid)` which sends
  `CharacterEnterWorldRequest`, auto-chains `CharacterEnterWorld`
  on receiving `CharacterEnterWorldServerReady`, and surfaces
  `PlayerCreate(guid)` as a `kind=1 PlayerSpawned` event. JS-side
  Spawn button click → `requestAnimationFrame` event drain → status
  flips to "Spawned <name> (GUID 0xN)". `kind=4 Disconnected` lands
  on session error. Smoke 44 → 45 (selectCharacter symbol).
  Playwright capture at
  `apps/holtburger-web/capture_phase4_step2a.cjs`. Position
  rendering of the local player + multi-entity buffer landed
  in step 2b (below).
- ✅ **Step 2a.5 — character creation in the browser.** Landed
  2026-05-04 (see [`docs/phase-4-renderer.md`](phase-4-renderer.md)
  step 2a.5 section). Closes the empty-list gap that step 2a's
  screenshot demo hit by exposing character creation through the
  wasm bundle. `start_session` now takes an `asset_url` 6th param,
  fetches the HBA via `HttpResourceSource`, parses `CharGen`
  (`0x0E000002`) + `SkillTable` (`0x0E000004`), and builds a
  `holtburger_content::CharacterGenCatalog` for offline validation.
  Adds `SessionHandle.createTestCharacter(name)` which constructs
  an Aluvian / Male / Adventurer / Holtburg
  `CharacterCreateRequestData` via
  `holtburger_core::CharacterGenBuilder::build_request`, and
  `SessionHandle.canCreateCharacter` getter for JS feature
  detection. Recv loop handles `SessionCommand::CreateCharacter`
  outbound + `GameMessage::CharacterCreateResponse` inbound;
  on Ok, locally pushes the new entry into `character_list`
  (mirrors cli's `handle_create_response` since ACE doesn't
  re-fire CharacterList after Create) and queues a `kind=5
  CharacterCreated` event. JS-side Create form auto-shows when
  the catalog loaded; submit → `kind=5` drain → list re-render
  with Spawn button. Smoke 45 → 47 (createTestCharacter +
  canCreateCharacter symbols).
- ✅ **Step 2a.6 — chat / admin commands + Teleport-to-Holtburg.**
  Landed 2026-05-04 (see
  [`docs/phase-4-renderer.md`](phase-4-renderer.md) step 2a.6
  section). Adds `SessionHandle.sendChat(message)` which dispatches
  `GameAction::Talk` to the server. `@`/`/`-prefixed messages
  route to ACE's command parser; access-level enforcement is
  server-side (Developer = 4 needed for `@telepoi`, Advocate = 1
  for `/tele`). Recv loop's `PlayerCreate` handler now also sends
  `GameAction::LoginComplete` back (mirrors cli's
  `messages.rs:464` path — empirically `GameEvent::PlayerDescription`
  / `StartGame` never arrive in our flow; PlayerCreate IS the
  InWorld signal) and queues `kind=7 EnteredWorld`. JS-side
  Teleport-to-Holtburg button unhides on kind=7; click sends
  `@telepoi Holtburg` to skip the Training Academy tutorial. Dev
  recipe documented: `UPDATE ace_auth.account SET accessLevel = 4
  WHERE accountName LIKE 'phase4demo%'` to promote test accounts.
  Smoke 47 → 48 (sendChat symbol). Deliverable at
  `docs/images/phase-4-step-2a-spawned.png` re-captured with
  Teleport button + post-teleport status.
- ✅ **Step 2b — `ClientViewEvent` → PIXI entity buffer.**
  Landed 2026-05-05, commits `fe85008..d01fa73` pushed
  2026-05-06 (see
  [`docs/phase-4-renderer.md`](phase-4-renderer.md) step 2b
  section). Five new match arms in
  `apps/holtburger-web/src/lib.rs::recv_loop` for
  `UpdatePosition` / `PrivateUpdatePosition` /
  `PublicUpdatePosition` / `ObjectCreate` / `ObjectDelete`,
  pushing into a new high-frequency `EntityUpdate` buffer
  (separate from `ClientEvent` — position updates fire 100s/sec
  in a populated zone, so a typed-getter struct beats the
  tagged-payload shape). New `SessionHandle.pollEntityUpdates()`
  drain method paired with the existing `poll_events()`. JS-side
  `entityMap = Map<guid, { sprite, modelId }>`, a third
  `entityContainer` PIXI layer above static placements, and 6
  helper functions (`quaternionToYaw`, `landblockToWorldXY`,
  `ensureEntitySprite`, `handleEntitySpawn`,
  `handlePositionUpdate`, `handleEntityRemove`). Reuses Phase 3
  step 6's per-model render cache for entity sprites; cache-miss
  entities render as magenta placeholder dots. Coordinate frame
  matches `ObjectPlacement`: landblock-local on the wire,
  `(landblock_x_byte * 192) + local_x` to world metres on the
  JS side. Quaternion → yaw via the same formula as the static
  placement renderer. Smoke 56 → 58 (pollEntityUpdates +
  EntityUpdate symbols). Capture script at
  `apps/holtburger-web/capture_phase4_step2b.cjs`; deliverable at
  `docs/images/phase-4-step-2b-entities.png`. The doc-text design
  intent of `kind=8/9/10` ClientEvent kinds was superseded during
  implementation by the parallel-channel approach (rationale in
  the `EntityUpdate` doc comment). Reference cli handlers:
  `external/holtburger/crates/holtburger-world/src/handlers/player.rs:33-46`
  + `handlers/movement.rs:41-46` + `handlers/inventory.rs:19-56`.
- ✅ **Step 3 — input (WASD / Q / E / Shift) → AC movement
  packets.** Landed 2026-05-06 (see
  [`docs/phase-4-renderer.md`](phase-4-renderer.md) step 3
  section). Adds `SessionCommand::SetMovementInput` variant +
  `LocalPlayerSnapshot` recv-loop state (position + 4
  sequences from inbound `UpdatePosition`) + motion-command
  constants + `build_raw_motion_state_for_input` helper +
  `SessionHandle.setMovementInput(forward, strafe, turn, run)`
  wasm-bindgen export. Recv-loop arm wraps the
  `RawMotionState` in `MoveToStateActionData` and dispatches
  via `session.send_action`. JS-side adds keystate tracking,
  document keydown/keyup listeners (gated on `enteredWorld`
  + form-input awareness), window blur handler (Chrome stuck-
  modifier mitigation), and per-rAF `setMovementInput` dispatch
  on keystate change. Click-to-move and the
  `UpdateMotion`/`server_control_sequence` tracking are scope
  deferred. Smoke 58 → 60 (setMovementInput symbol).
  **Wire round-trip validated against live ACE 2026-05-06**:
  `capture_phase4_step3.cjs` Playwright harness drives login
  → spawn → `@telepoi Holtburg` → `@pk pk` (engage server-
  side physics) → press W; recv_loop traces `MoveToState
  send_action OK` → ACE echoes `UpdateMotion` for the local
  player's guid. PASS, 2 packets sent / 4-9 echoes received
  per run. Critical ACE gotcha discovered: `OnMoveToState`
  short-circuits unless `IsPKType` (see "Process notes" #8).
- ✅ **Step 3.5 — client-side prediction.** Landed
  2026-05-06 (commits `e77e7e6..d65ea6e`). Per-rAF JS
  integration of the keystate into the local sprite's world
  coords; mirrors cli's `local_velocity_for_state` +
  `local_omega_for_state`. Press-W now slides the local
  sprite at 1.0 m/s walk / 4.5 m/s run; Q/E rotates; A/D
  strafes; S backsteps. Capture validates 3.0 m of in-frame
  drift over a 3-second W-hold. JS-only, no Rust changes; no
  new wasm-bindgen exports. Authoritative `PrivateUpdatePosition`
  events still snap-rubber-band the local sprite via the
  existing handlePositionUpdate path. See
  [`phase-4-renderer.md`](phase-4-renderer.md) step 3.5
  section for the as-built reference.
- ✅ **Step 3.6 — wire cli's `MovementSystem` into the wasm
  bundle (server-side player position actually advances).**
  Landed 2026-05-07 (commits `91190e1` structure + `274e213`
  fix-up). The bug: step 3 + 3.5 produced visual movement
  but server-side player position was frozen at the
  `@telepoi` spawn point — the wasm bundle never sent the
  `AutonomousPosition` heartbeat that AC clients use to
  report their predicted position back to the server. Step 3
  sent `MoveToState` (motion intent) but no `AutonomousPosition`
  (position payload). Fix: wire the cli's full `MovementSystem`
  into the wasm recv loop via a new `MovementSystemHandle`
  shim (`crates/holtburger-core/src/client/movement/handle.rs`
  — 4-method facade: `new` / `enqueue_drive_intent` /
  `arm_heartbeat_schedule` / `tick`). Recv loop on
  `kind=7 EnteredWorld` constructs a real `WorldState` from a
  parallel-loaded `WorldBootstrap` (the 5 game-data tables
  loaded via `ContentRepository::from_mounts` from the
  existing manifest source); `SetMovementInput` enqueues
  `PlayerDriveIntent::ManualHeld(MotionState)` instead of
  building `MoveToStateActionData` directly; new
  `SessionCommand::TickMovement` cmd fires from the JS rAF
  `drainEvents` loop and drives `MovementSystem::tick(now,
  &mut world, &mut session)` which emits MoveToState on
  motion-state edges AND the AutonomousPosition heartbeat.
  Design + 9-step plan at
  [`phase-4-step-3.6-movement-system.md`](phase-4-step-3.6-movement-system.md).
  Five follow-on bugs the structural commit missed, all
  fixed in `274e213`: (1) `log::info!` was silent — the wasm
  bundle has no log backend registered; switched all 3.6
  diagnostics to `console_log_str`. (2) Entity-seed logic
  on the wrong recv arm — local player position arrives via
  `UpdatePosition` with guid match, not `PrivateUpdatePosition`;
  added the seed/heartbeat-arm path to both arms. (3) The
  WorldState pose never advanced — the cli's tick wires
  movement → world → simulation, and the SIMULATION tick is
  what physically moves the player; wasm bundle skipped it;
  added a thin local-pose integrator in `handle.rs::tick`
  that calls a new `MovementSystem::advance_local_pose_for_
  manual_drive` mirroring the cli's
  `current_local_solve_body_input` velocity path without the
  full physics solver. (4) `resolve_self_movement_capabilities`
  returned `Err(RunRateUnavailable)` because the player's
  character biota isn't loaded; install a fallback override
  (1 m/s walk, 4.5 m/s run, 1.5 rad/s turn — matches
  retail / JS-prediction defaults) right after
  `WorldState::new`; required removing the `#[cfg(test,
  feature = "test-support")]` gate on
  `set_self_movement_capabilities_override`. (5) **The
  load-bearing one: ACE silently drops AutonomousPosition
  while `Player.Teleporting=true`** (`Player_Tick.cs:
  UpdatePlayerPosition` returns false). The flag is set on
  every `Player.Teleport()` call (initial spawn +
  `@telepoi`) and cleared only via `OnTeleportComplete`
  which is invoked from `GameActionLoginComplete.Handle`.
  We sent `LoginComplete` once on PlayerCreate but never on
  subsequent `PlayerTeleport` packets — so post-`@telepoi`
  the player was perpetually `Teleporting=true` and 23
  AutonomousPosition heartbeats during a 15-s walk were
  silently dropped server-side. Cli does this in its
  `PlayerTeleport` handler at `messages.rs:592`; mirrored in
  the wasm recv loop. Validated end-to-end against live ACE:
  position advanced from `(84.0, 7.1, 94.0)` to
  `(86.345, 21.908, 94.005)` — 14.8 m of Y movement at
  ~1 m/s on a 15-s walk. Per-tick diagnostic kept (every 60
  ticks): `[step 3.6 tick #N] pose=(...) cell=0x... caps_ok=...
  heartbeats_sent=...`. Out of scope (now Phase 4 step 3.7):
  real character-biota loading; landblock-crossing
  correctness — see polish backlog above.
- ✅ **Step 3.7 — character-biota loading + landblock-crossing
  correctness.** Landed 2026-05-07. Two pieces, both unblocked
  by 3.6's `WorldState` infrastructure, kept out of 3.6 for
  scope: **(a) PlayerDescription biota handler.** Recv loop
  matches `GameEvent::PlayerDescription` and calls
  `world.player.hydrate_from_player_description` +
  `world.apply_player_description_world_state` +
  `world.emit_player_derived_stats` (cli pattern from
  `holtburger-world/handlers/{login,player}.rs`), then clears
  the 3.6 fallback `SelfMovementCapabilities` override so
  `resolve_self_movement_capabilities` reads the real Run
  skill + burden + motion table. Defensive re-install of the
  fallback if the real biota doesn't resolve (skills not yet
  populated, etc.). Required `pub` lifting on
  `apply_player_description_world_state`,
  `emit_player_derived_stats`, and the (was-test-only)
  `set_self_movement_capabilities_override` /
  `clear_self_movement_capabilities_override` setters. Live
  PlayerDescription delivery wasn't observed in the capture
  harness — possibly because ACE sends it earlier in the
  session than the GameEvent arm fires under some session
  conditions, possibly because the test fixture's player
  state is sticky across sessions. Handler is correct per
  cli reference; will validate once a clean fresh-character
  session lands. **(b) Landblock-crossing rebucket.** New
  `WorldPosition::rebucket_outdoor_landblock` in
  `holtburger-common::position` walks coords past
  `[0, METERS_PER_LANDBLOCK)` and adjusts the high word of
  `landblock_id` (X = bits 24-31, Y = 16-23), re-deriving the
  cell index via `normalize_outdoor_cell`. Edge-of-world
  clamps. Indoor poses no-op. Called from
  `MovementSystem::advance_local_pose_for_manual_drive`
  immediately after velocity integration, so the
  AutonomousPosition heartbeat always carries a coherent
  `(landblock, local-coords)` pair when the player walks
  through a 192 m boundary. Five unit tests
  (`position::tests::test_rebucket_*`) cover: in-bounds no-op,
  north cross, south-west diagonal cross, cell-id recompute,
  indoor no-op. All green.
- ✅ **Step 4 (chat panel) — full chat-type coverage with
  category tabs.** Landed 2026-05-07. Brings the browser
  chat surface to parity with the cli's chat panel
  (`apps/holtburger-cli/src/pages/game/panels/chat.rs`) by
  routing every chat-bearing AC packet through one
  normalised `kind=2 ChatReceived` event tagged with a
  `CHAT_CATEGORY_*` id (24 categories: System / Local /
  Tell / Channel / Emote / Combat / Death / Magic /
  Advancement / Transient / Popup / Help / Trade / LFG /
  Roleplay / General / Fellowship / Allegiance / Recall /
  Craft / Appraisal / Broadcast / Society / Olthoi).
  ClientEvent grew a second u32 payload getter
  (`u32Payload2`) carrying the category; the legacy
  `u32Payload` keeps its raw `ChatMessageType` /
  `ChatChannel` / `TurbineChatType` semantic for
  debugging.
  - **New recv-loop arms** (`apps/holtburger-web/src/lib.rs`
    GameMessage match): `PlayerKilled` (death broadcast +
    `victim_id`/`killer_id`), `TurbineChat` (modern
    Allegiance / General / Trade / LFG / Roleplay / Society
    / Olthoi channel chat — `EventSendToRoom` payload only;
    RPC echoes silenced).
  - **New GameEvent arms**: `AttackerNotification`,
    `DefenderNotification`, `EvasionAttackerNotification`,
    `EvasionDefenderNotification`, `VictimNotification`,
    `KillerNotification`. Damage lines mirror the cli's
    format (`"You hit Drudge Ravener for 37 slash damage
    (25.0%). Critical hit. [Recklessness, Sneak attack]"`)
    via three new helpers (`damage_type_label`,
    `damage_location_label`, `attack_conditions_suffix`)
    that wrap the same `iter_display_names()` paths the
    cli uses.
  - **Existing arms upgraded**: `ServerMessage` /
    `HearSpeech` / `HearRangedSpeech` now derive their
    category from `data.chat_type` via the new
    `chat_category_for_message_type()` helper (mirrors
    cli's `chat_message_tags()` switch — Combat → COMBAT,
    Magic → MAGIC, Advancement → ADVANCEMENT, Recall →
    RECALL, Allegiance → ALLEGIANCE, Fellowship →
    FELLOWSHIP, etc., not just LOCAL). `EmoteText` /
    `SoulEmote` → EMOTE; `Tell` → TELL with chat-type
    routing for AdminTell; `ChannelBroadcast` derives
    category from the legacy `ChatChannel` bitmask via
    `chat_category_for_channel()` (Allegiance ranks fold
    into ALLEGIANCE, Fellow / FellowBroadcast → FELLOWSHIP,
    admin / advocate / sentinel → SYSTEM).
  - **DOM panel rewrite** (`apps/holtburger-web/index.html`):
    24 category-keyed CSS colours; tab bar above
    `#chat-log` (All / Local / Tells / Channels / Combat /
    Magic / System); `data-tab` attribute on `#chat-log`
    drives `:not(.cat-N)` filter chains so tab switching
    is layout-only (no per-message reflow). The legacy
    prefix-string `classifyChat()` heuristic is gone — JS
    routes purely on `evt.u32Payload2`. `appendChatLine`
    now takes a numeric category (or `null` for outbound
    user echo, which routes to `.echo` neutral and is
    visible across every tab). `CHAT_LOG_LIMIT` raised
    200 → 400 to keep more backscroll across tabs.
  - **Smoke 60 → 61** — added a check that
    `ClientEvent.prototype.u32Payload2` is exposed (the
    new wire contract for chat category). Live ACE chat
    round-trip remains a capture-harness exercise.
  - **Reference**: cli's `chat_message_tags()` and
    `channel_tags()` in `chat.rs:609-660` — every
    category mapping mirrors them so any in-game line
    looks the same in both clients. The cli's
    `log_combat_feedback()` (`chat.rs:238-315`) is the
    other rosetta stone — combat / death format strings
    are byte-identical.
- ⏳ **Step 4 follow-on — vitals + inventory panels.** The
  chat panel is the largest piece of step 4 by surface
  area; vitals (UpdateHealth / UpdateAttribute /
  UpdateSkill) and inventory (OpenContainer +
  ApproachVendor) round it out. Same pattern: DOM panels
  next to the PIXI canvas, recv loop normalises into typed
  ClientEvent kinds.
- ⏳ **Step 5 — interactive entities (doors, portals, vendors).**
  Adds `SessionHandle.useObject(guid)` wasm export →
  `GameAction::UseObject(guid)` outbound. Server-side ACE
  handles the rest (door open/close animation, portal teleport
  via `PrivateUpdatePosition`, vendor inventory via
  `GameMessage::OpenContainer`). The page just dispatches the
  click + handles the response events. Parallel to step 4.
- ⏳ **Step 6 — realistic entity rendering (NPCs, portals,
  monsters, vendors, signs).** Today every live entity ACE
  pushes renders as a *generic* textured sprite keyed only on
  `csetup_id`: the local Drudge, the Holtburg portal, Ulgrim,
  and a wandering Crier all read as anonymous brown-ish
  silhouettes in the entity layer. `emit-static-site` already
  solves this — it switches on `WeenieType` for category
  glyph + tint, applies `PaletteTemplate` / `ClothingBaseDid`
  for NPC variants, and prints inscriptions under signs at
  z≥11 (`WorldBuilder.Terminal/ObjectSpriteGenerator.cs:683-694`
  + `RenderPreviewRenderer.cs:911-938`). Step 6 mirrors that
  approach in the live client so live entities look like the
  static atlas's z≥11 sprites instead of like placeholder dots
  with textures.

  **Sub-step landing log:**

  *2026-05-06 evening session — initial cut:*
  - ✅ **6a — surface weenie metadata to JS.** `EntityUpdate`
    extended with `wcid`, `itemType`, `name`, `objScale`,
    `iconId`, `paletteId`, `mtableId`. The ObjectCreate recv-
    loop arm stops discarding `PublicWeenieDescription` /
    `ObjectDescriptionData` fields.
  - ✅ **6b — ItemType-keyed visual dispatch + glyph
    fallback.** ITEM_TYPE constants mirror
    `external/ACE/Source/ACE.Entity/Enum/ItemType.cs:6`;
    Portal=cyan ring, Creature=red diamond, Container=brown
    square, Writable=orange triangle (mirrors
    `RenderPreviewRenderer.cs:230-299`). `objScale`
    multiplies `worldBounds`.
  - ✅ **6e — per-entity nameplates.** `PIXI.Text` per named
    entity in a non-camera-scaled `nameplateContainer`;
    constant 12-13px screen-space. Colour-coded by category.
    Local player skipped.

  *2026-05-07 — re-scoped after discovering ACE pre-computes
  ClothingTable substitutions in `Creature.CalculateObjDesc()`
  and ships them on the wire as `model_data`:*
  - ✅ **Phase A — apply ACE-shipped per-part substitutions
    (commit `8062509`).** `EntityUpdate` plumbs
    `model_changes` + `texture_changes` + `sub_palettes`
    Vec<u32> from `ObjectDescriptionData.model_data`. New
    wasm export `fetchEntityModelRender(setup_id,
    model_changes, texture_changes)` triangulates with per-
    part GfxObj swaps + texture-DID rewrites. JS
    `addEntityRenderToLiveSpriteMap` routes substituted
    entities through it; composite cache key
    (`computeEntitySpriteKey`) stops two NPCs sharing
    csetup_id but different equipped armor from aliasing in
    the cache. **Replaces the deferred 6c "palette-tinted
    creature variants" plan** — the simpler answer was that
    ACE already does the work; we just consume the output.
    3 native unit tests cover tex-swap, part-swap, and
    composition. NO ClothingTable parser added to
    holtburger-dat (not needed).
  - ✅ **Phase B — apply ACE-shipped palette overlays
    (commit `ba87dfd`).** New wasm export
    `fetchEntitySurfacesPixels(surface_dids, base_palette_id,
    sub_palettes)` composes the decode-time palette as
    `base_palette_id` (entity's `PaletteBaseDID`) override
    over the texture's intrinsic palette, then splices each
    `(sub_palette_id, offset, length)` overlay on top, then
    feeds the composed palette to `Texture::to_rgba8`. Mirrors
    C# at `WorldObject_Networking.cs:1017` +
    `Creature_Networking.cs:218`. JS routes through it when
    `meta.paletteId !== 0` OR `meta.subPalettes` is non-empty.
    Composite cache key folds in palette state. 4 native
    unit tests (intrinsic / override / overlay-splice /
    out-of-range clamp).
  - ✅ **Phase C — MotionTable idle pose
    (commit `347f6ca`).** `try_resolve_idle_anim_frame`
    walks `setup.default_motion_table` →
    `cycles[(default_style << 16) | idleSubstate]` →
    `motion_data.anims[0].anim_id` → `Animation.part_frames[0]`,
    falls through to `setup.default_animation` (path 2),
    falls through to placement frame, falls through to
    identity. Mirrors C# `TryResolveIdleAnimFrame` at
    `ObjectSpriteGenerator.cs:921-950`. NPCs in their actual
    idle stance (knees flexed, arms at hip) instead of T-pose.
    1 regression test guards against the helper matching
    naked setups.

  *Open polish (cosmetic, not blocking the "looks realistic" bar):*
  - ⏳ **6d — portal swirl + sign inscription label.**
  - ⏳ **6f — portal destination chips.** Portal `LinkedPortalOne`/
    `Two`/`OriginalPortal` DataIds aren't on `Entity` today.
  - ⏳ **Animation loops / walk-cycles.** Phase C uses one
    keyframe (idle pose); a true walk-cycle anim during
    movement would need per-frame ticking.

  **Validation gates after Phase C:** 1138/0 native lib,
  71/71 + 1 SKIP smoke, wasm32 + wasm-pack {nodejs,web} clean,
  page module body parses clean. **Live-ACE visual sign-off
  is the user's call** — log in via the browser, walk Holtburg,
  confirm NPCs look like NPCs (clothing on, right skin tone,
  not T-posed). The Tailscale stack on this host has ACE +
  wsbridge running for the 2026-05-07 session.

  Reference paths for the *original* sub-plan + grounding
  notes are kept below for future agents picking up 6d/6f.

  **Why it's not free.** The `EntityUpdate` struct surfaced to
  JS exposes `{ kind, guid, modelId, landblockId, x, y, z, qw,
  qx, qy, qz }` and nothing else
  (`apps/holtburger-web/src/lib.rs:2076-2098`). The recv-loop
  `ObjectCreate` arm at `apps/holtburger-web/src/lib.rs:3343-3378`
  parses the inbound `PublicWeenieDescription` (which carries
  `wcid`, `name`, `item_type`, `icon_id`, `obj_scale`, palette
  indices — `crates/holtburger-protocol/src/messages/object/
  messages/description.rs:183-230`) and **discards every field
  except `csetup_id`** before pushing into the entity buffer.
  Step 6a is the data-plumbing change; the rest of the step is
  consumer-side.

  Step 6 sub-plan:

  - **6a — surface weenie metadata to JS.** Extend `EntityUpdate`
    with `wcid`, `itemType` (the wire ItemType bitmask —
    `ItemType::Portal = 0x00010000`, see
    `external/ACE/Source/ACE.Entity/Enum/ItemType.cs:25`),
    `name`, `objScale`, `armorColor`, `weaponColor`,
    `armorHighlight`, `weaponHighlight`. Sources are already
    on the client side: the holtburger-world `Entity` struct
    carries them at
    `external/holtburger/crates/holtburger-world/src/entity.rs:246-283`
    (`wcid`, `gfx_id`, `csetup_id`, `mtable_id`, `obj_scale`,
    `armor_color`, `weapon_color`, `armor_highlight`,
    `weapon_highlight`, `creature_profile`, `health_fraction`).
    The recv-loop arm just stops discarding. JS-side: the
    existing `entityMap = Map<guid, { sprite, modelId }>` gains
    a `meta` slot populated on `kind=1 Spawn`. WeenieType per se
    is **not** on the wire — derive category from `item_type`
    (Portal vs Creature vs Container vs MeleeWeapon etc.) for
    the visual dispatch, since static-site's `WeenieType`-keyed
    switch maps cleanly to `ItemType` flags for the categories
    that drive rendering.

  - **6b — category-keyed visual dispatch.** Mirror
    `ObjectSpriteGenerator.cs:683-694` and the glyph table at
    `RenderPreviewRenderer.cs:230-299`:
    - `ItemType::Portal` → cyan tint (`0x6EC8E0`); HousePortal
      (wcid lookup; not in ItemType) → purple (`0xA06ED4`).
    - `ItemType::Creature` → red nameplate (hostile) or yellow
      (friendly) keyed off `creature_profile.faction` /
      `health_fraction == 1.0 && level == 0` heuristic.
    - `ItemType::Vendor` → green nameplate. (Holtburger may
      collapse Vendor into Creature; if so, gate on a future
      `vendor: bool` propagated from ACE's
      `Creature_BuyPrice`/`SellPrice` properties.)
    - Doors → cyan ring fallback when model isn't cached.
    - Signs (`ItemType::Sign` if exposed; otherwise wcid-based)
      → orange tint + inscription label (see 6d).
    - Apply tint via PIXI `Sprite.tint` (cheap; multiplicative
      over the rasterized texture). For the placeholder-dot
      fallback while a model fetch is in flight, draw the
      static-site glyph shape (cyan ring / brown square / red
      diamond / yellow diamond) instead of the magenta dot at
      `apps/holtburger-web/index.html:1669` — gives the user
      legible feedback even pre-rasterization.

  - **6c — palette-tinted creature/NPC variants.** Apply
    `armor_color` / `weapon_color` / `armor_highlight` /
    `weapon_highlight` palette indices when the live rasterizer
    bakes a model. Static-site reference:
    `WorldBuilder.Terminal/ObjectSpriteGenerator.cs:773-790`
    (PaletteTemplate substitution). The browser rasterizer
    lives at `apps/holtburger-web/index.html:777-820` and
    already does Lambert shading + UV sampling — the palette
    substitution slots in before the per-poly RGBA sample. The
    palette LUTs reach via the existing `Surface →
    SurfaceTexture → Texture → Palette` walk
    (`holtburger_dat::walk::collect_model_dependencies`); add a
    `fetch_palette_pixels(palette_did) -> Promise<Vec<u32>>`
    export if one isn't already exposed and substitute by
    palette-template offset. **Don't fabricate palettes** — read
    real DAT data, per the auto-memory note "Test fixtures —
    prefer real game data over synthetic" (the rule applies to
    runtime palette tables for the same reason it applies to
    fixtures: synthetic colours diverge from retail in
    impossible-to-debug ways).

  - **6d — portal swirls + sign inscriptions.** Two
    type-specific embellishments worth the polish:
    - **Portals**: tint isn't enough at zoom-out — the static
      site's `ObjectSpriteGenerator` falls back to a circular
      billboard-disk render for portals
      (`ObjectSpriteGenerator.cs:188-200`). For the live
      client, overlay a small animated PIXI swirl sprite (or a
      `Graphics.alpha` ring pulse on a 1.5 s loop) on top of
      the model sprite. Cheap: one extra sprite per portal,
      portals are rare.
    - **Signs**: pull `name` (the sign's inscription string is
      the weenie's display name in retail data) from
      `EntityUpdate.name` and render a small italic
      `PIXI.Text` below the sprite at zoom ≥ ~10. Mirrors
      `RenderPreviewRenderer.cs:911-938`. Use a pooled-text
      strategy — re-use `PIXI.Text` instances across signs as
      they enter/leave the viewport rather than allocating per
      entity, since `PIXI.Text` allocates a canvas per
      instance.

  - **6e — nameplates.** `PIXI.Text` per entity, anchored above
    the sprite, font sized to ~12px screen-space (so it stays
    readable at all zooms — apply inverse worldContainer scale).
    Pull from `EntityUpdate.name`. Colour:
    hostile creature = red, friendly NPC = yellow, vendor =
    green, dead = grey, local player = hidden (or render a
    small chevron / "you" instead). No retail-screenshot match
    is possible from the static atlas (it doesn't draw
    nameplates) — match retail in-game screenshots, not the
    static site. Pool `PIXI.Text` instances; clear on
    `kind=2 Remove`.

  - **6f — portal destinations (deferred polish).** Portals
    carry `LinkedPortalOne` / `LinkedPortalTwo` /
    `OriginalPortal` DataId properties
    (`crates/holtburger-common/src/properties/property_keys/
    data_ids.rs:39, 56`). These aren't in the `Entity` view
    event today; surfacing them would let the browser draw a
    destination chip ("→ Holtburg") under the portal sprite.
    Out of scope for v1 of step 6. The bar for "done" is
    *"looks like a portal, has a name above it"*.

  **Grounding & gotchas.**

  - **`WorldBuilder.Terminal` is the visual ground truth**, same
    as for terrain (Process notes #1+#2 above). For a populated
    landblock — Holtburg town centre at LB 0xA9B4 has 53 live
    entities at peak — run `render-preview` and diff against
    the live client. Static-site sprite-mode tiles at z≥11
    (`projects/<slug>/tiles/object/...`) are the canonical
    reference for what a creature/NPC looks like in our
    top-down view.
  - **`WeenieType` lives in two places** — ACE
    (`external/ACE/Source/ACE.Entity/Enum/WeenieType.cs:6`)
    and holtburger
    (`external/holtburger/crates/holtburger-common/src/properties/
    object.rs:183-209`). They agree numerically (`Portal=7`,
    `Creature=10`, `Vendor=12`, `Door=19`, `HousePortal=60`).
    But `Entity` does **not** carry WeenieType — only `wcid`
    and the `item_type` bitmask from `PublicWeenieDescription`.
    Use `item_type` for the wire-fed dispatch; reach for
    WeenieType only if you decide to plumb a wcid → weenie
    ontology client-side.
  - **`obj_scale` is currently invisible** to the live client.
    Identical models render at identical sprite size whether
    ACE spawned a juvenile Tumerok or an Olthoi Eviscerator.
    6a fixes this: the rasterizer multiplies its `worldBounds`
    output by `EntityUpdate.objScale` before placement.
  - **Sprite atlas vs on-demand**: the static atlas at
    `apps/holtburger-web/sprites/atlas.png` covers ~108
    placement models; entity csetup_ids almost never overlap
    (Phase 3 step 3.6 closing note). Step 6's per-category
    tint applies to *both* atlas-cached sprites (set `tint` at
    `ensureEntitySprite`) and on-demand-rasterized sprites (set
    `tint` after the `addModelsToLiveSpriteMap` resolve).
  - **PIXI 8 minified-class trap (Process notes #5)**: don't
    branch on `sprite.constructor.name`. Tag entries with
    `entry.kind = "sprite" | "placeholder" | "glyph"` if the
    nameplate / tint logic needs to differentiate.

  Smoke target: +N symbols for the new EntityUpdate fields and
  whatever new exports 6c needs (probably +1 for
  `fetch_palette_pixels`). Capture target: a Holtburg-town-
  centre screenshot showing portal (cyan-tinted with swirl) +
  Town Crier NPC (yellow nameplate + inscription label) + a
  wandering Drudge creature (red nameplate, scaled to its
  `obj_scale`). Validation: side-by-side with
  `WorldBuilder.Terminal`'s `render-preview` of the same LB.

  Order-of-attack within step 6: **6a first** (data plumbing
  unblocks everything), then 6b (cheapest visual win — tints
  + glyph fallback), then 6e (nameplates — high user-facing
  payoff), then 6c (palette tinting — most code, hardest to
  validate), then 6d (portal swirl + sign inscription —
  pure polish), then 6f if anyone still cares. 6a-6b is the
  minimum viable "looks realistic" cut.

Phase 5 — **Hardening.** In flight.

Step ledger:
- ✅ **Phase 5.0 — production-grade asset delivery (2026-05-04,
  commits `0578cb7..688550d`).** Single-bundle pre-load (605 MB
  HBA) was a UX cliff for cellular / corporate-firewall users.
  Closed by a content-addressable manifest + per-record shard
  model with a precompiled bootstrap pack and a service-worker
  cache. Brief: [`thorough.md`](thorough.md). As-built:
  [`phase-5-thorough.md`](phase-5-thorough.md). Landed:
  `holtburger-manifest` schema crate, `dat-shard` tool,
  `ManifestResourceSource` (wasm32 consumer), thread-local
  `init_resource_source` page-init export, `index.html`
  manifest-mode wiring (opt-in), `service-worker.js`
  IndexedDB cache, `dat2hba --profile boot` (minimum-viable;
  catalog tables + 9-cell spawn neighborhood). Smoke 48 → 55,
  native lib 1106 → 1116.
- ✅ **Phase 5.0b — per-export refactor (2026-05-04, commit
  `8afb423`).** Drops `asset_url: String` from every
  wasm-bindgen `fetch_*` export; routes them all through the
  global `ManifestResourceSource` + explicit `prefetch()` async
  surface. Smoke harness pre-bakes a manifest+shard fixture
  via the dat-shard binary. Manifest mode is now the only path
  on the live page; legacy `HttpResourceSource::connect(url)`
  stays available for native callers / fixtures only. New
  `RecordingSource` wrapper in
  `holtburger-resource-http` drives iterative shard discovery
  for unbounded-depth walks (`fetch_object_colours`,
  `fetch_model_mesh`, `fetch_surface_pixels`). Smoke 55 → 56,
  native lib 1116 / 0.
- ✅ **Phase 5.1a — `holtburger_dat::walk` extraction
  (2026-05-04, commit `7224359`).** New
  `crates/holtburger-dat/src/walk.rs` module. Public
  `collect_model_dependencies(source, model_id, out)` walks the
  GfxObj/SetupModel → Surface → SurfaceTexture → Texture →
  Palette chain and accumulates every reachable record's
  `(namespace, file_id)` into a `HashSet`. Public
  `read_gfx_obj_surfaces(bytes) -> Option<Vec<u32>>` minimal
  GfxObj header parser (avoids the BSP / vertex-array
  regressions that crashed the full parser on ~50% of retail
  records). 4 unit tests; native lib 1116 → 1120.
- ✅ **Phase 5.1b — transitive boot pack walk (2026-05-04,
  commit `5fb0919`).** New `compute_boot_keep_set(bundle,
  boot_landblock)` in `holtburger_tools::dat_shard` calls
  `collect_model_dependencies` for every placement in each
  spawn-area LandblockInfo's `objects` Stab + `buildings`
  BuildInfo lists. Boot pack expands from "essentials + 9
  cells" (14 covers, 346 KB on Holtburg) to
  "essentials + 9 cells + everything visible at spawn"
  (635 covers, 1.86 MB). Bug fix folded in: `--boot-landblock`
  default was scrambling 0xA9B4 → 0x43444 because clap's
  `default_value_t` Display'd the u32 as decimal then
  re-parsed via `parse_hex_u32` as hex. Switched to
  `default_value = "0xA9B4"` so the default flows through the
  parser once. Same fix in `dat2hba --profile boot`.
  1 new unit test; native lib 1120 → 1121.
- ⏳ **Phase 5.2 — manifest scale fix (BRIEF AT
  [`manifest.md`](manifest.md), IN FLIGHT).** Real-world bake
  produces a 203 MB `manifest.json` (885,043 entries × ~230
  bytes verbose JSON; `eor/cell` envcells dominate). The
  manifest is the new cliff. Phase 5.2 introduces a v2 format:
  tiny top-level (~2 KB; just version, source provenance,
  boot pack metadata, namespaces, URL templates) + lazy-fetched
  per-namespace binary catalogs (`manifest/<namespace>.bin`,
  ~19 bytes/entry × namespace size, gzipped at HTTP layer) +
  convention shard URLs derived from `(namespace, file_id)` or
  sha256. v1 stays one release cycle for in-flight CDN deploy
  drain, then removed. Required before public CDN deployment
  or 600 kbps cellular validation (Phase 5 obj 11); not
  required for dev iteration over Tailscale WiFi.

  Sub-step ledger:
  - ✅ **obj 1-3 (audit + ManifestV2 schema + NamespaceCatalog
    binary codec)** — landed at 1121 → 1130 native lib gate.
    `holtburger-manifest::v2::{ManifestV2, ManifestVersionProbe,
    namespace_slug, render_shard_url_full, render_catalog_url}`
    and `holtburger-manifest::catalog::{NamespaceCatalog,
    CatalogEntry, CatalogError}` with full ULEB128 + CRC32 IEEE
    + magic/version/flags codec. 9 cross-platform tests.
  - ✅ **obj 4 (ManifestResourceSource v2 dispatch)** —
    landed 2026-05-08. v1 path moved to
    `crates/holtburger-resource-http/src/manifest_source_v1.rs`
    as `ManifestResourceSourceV1`; the public
    `ManifestResourceSource` is now an enum that wraps either
    `ManifestResourceSourceV1` (v1) or a new `V2Source` (v2).
    `connect()` fetches manifest bytes once, sniffs the
    `version` field via `ManifestVersionProbe`, logs a
    deprecation warning + dispatches to v1 OR parses
    `ManifestV2` + dispatches to v2. Both halves implement
    `ResourceSource` so callers don't care which wire format
    is loaded; `manifest_version()` + `loaded_catalog_count()`
    accessors expose the variant. v2 `prefetch()` walks the
    full obj 4 spec: skip boot-served + cached; lazy-fetch any
    needed per-namespace `NamespaceCatalog` bins (parallel via
    `try_join_all`, 404 on a declared namespace's catalog
    falls through to convention-URL mode); for each key,
    look up in catalog (silent skip on miss; verify sha256 on
    fetch) OR derive convention URL via
    `{namespace_slug}/{file_id_hex}.bin` (404 = silent skip,
    no verify). New `PrefetchError` variants: `CatalogFetch`,
    `CatalogParse`. New `ManifestConnectError::UnsupportedVersion`.
    2 new cross-platform tests in `holtburger-manifest::v2`
    covering version probe across v1/v2/v99/malformed +
    convention-URL helper round-trip. Native lib gate
    1146 → 1148 / 0; wasm32 check clean; `wasm-pack build
    --target {nodejs, web}` both green. End-to-end smoke
    fixture exercise deferred to obj 8 (which builds a v2
    manifest.json fixture via `dat-shard --manifest-version=2`
    in the smoke harness).
  - ✅ **obj 5 (dat-shard v2 emission)** — landed 2026-05-08.
    New `--manifest-version=1|2` clap flag with default 2;
    `DatShardOptions.manifest_version` field threads through.
    `shard_bundle_dispatch()` routes to v1 OR v2; new
    `shard_bundle_v2()` orchestrator calls `write_shards_v2`
    (2-level prefix dir keyed by truncated 16-byte sha256 at
    `shards/{first2}/{trunc32}.bin`, dedupe by truncated path),
    `write_namespace_catalogs` (per-namespace
    `NamespaceCatalog::write_to` → `manifest/{namespace_slug}.bin`),
    `write_convention_symlinks` (unix symlinks at
    `shards/{namespace_slug}/0x{file_id:08X}.bin` →
    `../{prefix2}/{trunc32}.bin`), reuses Phase 5.1's
    `write_boot_pack` unchanged, and writes a ≈2 KB
    `ManifestV2` JSON with `shard_url_template =
    DEFAULT_SHARD_URL_TEMPLATE_PREFIXED` +
    `catalog_url_template = Some(DEFAULT_CATALOG_URL_TEMPLATE)`.
    New `BakeOutput { V1(Manifest), V2(V2BakeResult) }` enum
    + `V2BakeResult { manifest, total_records,
    unique_shard_count, catalog_count, boot_covers_count }`.
    Binary main() routes via dispatcher, prints version-aware
    summary. Existing 4 sharding tests updated to pass
    `manifest_version: 1`; 5 new v2 tests cover (a) <5 KB
    top-level, (b) per-namespace catalogs exist, (c) catalog
    `read_from` round-trip, (d) symlinks resolve to canonical
    sha256-keyed shards, (e) every source record reachable
    via boot-or-catalog. `cargo test --workspace` 1179 / 0;
    workspace lib still 1148 / 0; release binary builds clean.
  - ✅ **obj 6 (page hint update)** — landed 2026-05-08.
    `index.html`'s init block + manifest-fetch-failed
    diagnostic now mention v2 (the new default) and call out
    the `--manifest-version=1` opt-out for in-flight CDN
    deploys. The "fetching manifest" hint distinguishes
    v2's ~2 KB top-level + lazy catalogs from v1's ~200 MB.
    The DOM error message tells the user to re-bake with
    `dat-shard --output dist/`.
  - ✅ **obj 7 (service worker scope)** — landed 2026-05-08.
    `service-worker.js` cache scope extended from `/shards/*`
    to `/shards/* OR /manifest/<namespace>.bin` via a new
    `isCacheable(url)` helper (specifically excludes
    `/manifest.json` so the top-level pointer re-fetches
    each load). Renamed cache `holtburger-shards-v1` →
    `holtburger-content-v1`; activate-step GC sweeps both
    `holtburger-shards-` and `holtburger-content-` prefixes
    so legacy v0 caches don't accumulate. SW LOC 92
    (under brief's ≤120 target). `node --check` clean.
  - ✅ **obj 8 (smoke harness v2 fixture + checks)** — landed
    2026-05-08. `smoke_test.cjs` now bakes both v1 and v2
    variants of `dats/assets.hba` into sibling subdirs of the
    smoke dist tree, with a third "convention-URL" variant
    that reuses v2's shards/boot/manifest tree but ships a
    rewritten top-level `manifest.json` (`catalog_url_template
    = null` + `shard_url_template =
    "shards/{namespace_slug}/{file_id_hex}.bin"`) — avoids a
    4 GB cpSync of the 885k shard files by URL-prefix routing.
    Single http.Server with prefix routing (`/v1/...`,
    `/v2/...`, `/v2conv/...`) tracks per-path request counts
    for the catalog-fetch invariants. New wasm-bindgen
    exports `manifest_version()`, `loaded_catalog_count()`,
    `manifest_v2_version_const()` let JS verify the dispatch
    decisions. Surfaced a sub-fix: v1's `BootPack.covers:
    Vec<String>` (635 entries × ~30 bytes = ~19 KB) blew the
    top-level v2 manifest past the brief's 2 KB target —
    introduced `holtburger_manifest::v2::BootPackV2` (no
    `covers`); runtime boot-pack hit-tests now go through
    `HbaReader::exists_by_key` (already O(1) over hash-mapped
    namespace spans, same semantics). Real-world v2
    `manifest.json` lands at **541 bytes**. Smoke 83 → 100
    checks: 5 symbol-presence (3 export + 2 pre-init=0
    sanity), 2 v1 dispatch (`manifest_version()=1`,
    `loaded_catalog_count()=0`), 7 v2 catalog mode (init +
    version + manifest <5 KB at 541 bytes + boot round-trip +
    per-namespace catalog ≤1 HTTP fetch + loaded count
    matches distinct HTTP paths), 3 v2 conv mode (init under
    `catalog_url_template=null` + zero catalog reqs +
    loaded_catalog_count=0). Final smoke: **100 / 100 + 1
    SKIP**.
  - ⏳ **obj 9 (workspace check)** — verify native lib gate +
    smoke + wasm-pack stay green.
  - ⏳ **obj 10 (live-ACE phone validation)** — bake v2 dist/,
    serve over Tailscale, demonstrate <60s first paint + <5s
    re-load on 600 kbps cellular.
  - ⏳ **obj 11 (docs)** — `phase-5.2-manifest-fix.md` as-built
    + bumps to `phase-5-thorough.md` + this section + auto-memory.
- ⏳ **Phase 5.3 — boot pack adaptive sizing (no brief yet).**
  5.1b's transitive walk is "include everything reachable from
  spawn placements" — for Holtburg that's 1.86 MB. For dense
  areas (Mountain Sea, Yaraq, capital cities) the boot pack
  may exceed the bandwidth target. 5.3 would add an adaptive
  policy: smaller surround radius for high-density areas, or
  an "essential rendering" heuristic that drops some surface
  chains in favor of category-tint fallback. Cell-density
  histogram per landblock could drive the policy. Not blocking
  current dev; surfaces if/when validation against dense areas
  on real cellular shows the pack is too big.

Open follow-ons (no specific brief yet):
- Login flow UX (§7.5).
- Performance: 100 concurrent entities, 1000, 5000.
- Multi-project / multi-world picker.
- Phase 6 — CDN deployment (CloudFront / Cloudflare R2 /
  Fastly / self-hosted nginx; Brotli vs gzip vs zstd;
  `X-Content-SHA256` integrity headers; AGPL §13 source
  publication URL).

Each phase ends with a working artifact. We do not start the next phase until
the current one demonstrably works against ACE.

## 9. Reference index

File:line citations from the groundwork exploration + as-built docs from
later phases, kept here so future work can jump directly without
re-discovering them.

### Holtburger source seams (groundwork-pass citations)

| What | Where |
|---|---|
| `Transport` trait definition | `external/holtburger/crates/holtburger-session/src/session/types.rs:17-21` |
| `Session.transport` field | `external/holtburger/crates/holtburger-session/src/session/types.rs:90` |
| Hardcoded `UdpSocket::bind` (the patch site) | `external/holtburger/crates/holtburger-session/src/session/api.rs:9-11` |
| `Session::new_with_transport` (the seam that landed) | `external/holtburger/crates/holtburger-session/src/session/api.rs` |
| Fragment reassembly (assumes whole-packet recv) | `external/holtburger/crates/holtburger-session/src/session/receive.rs:405-423` |
| `ResourceSource` trait | `external/holtburger/crates/holtburger-dat/src/lib.rs:138-148` |
| `ContentRepository::from_mounts` | `external/holtburger/crates/holtburger-content/src/repository.rs:75-80` |
| ClientRuntime asset loading | `external/holtburger/crates/holtburger-core/src/client/builder.rs:54-80` |
| `METERS_PER_LANDBLOCK = 192.0` (canonical AC constant) | `external/holtburger/crates/holtburger-common/src/position.rs:5` |
| `WeenieType` enum (Portal=7, Creature=10, Vendor=12, Door=19, HousePortal=60) | `external/holtburger/crates/holtburger-common/src/properties/object.rs:183-209` |
| `WeenieType` enum (ACE mirror) | `external/ACE/Source/ACE.Entity/Enum/WeenieType.cs:6` |
| `ItemType` bitmask on the wire (Portal = `0x00010000`, Creature, etc.) | `external/ACE/Source/ACE.Entity/Enum/ItemType.cs:25` |
| `Entity` struct — wcid, gfx_id, csetup_id, obj_scale, armor/weapon palette indices, creature_profile | `external/holtburger/crates/holtburger-world/src/entity.rs:246-283` |
| `PublicWeenieDescription` (carries name, item_type, palette indices on the wire) | `external/holtburger/crates/holtburger-protocol/src/messages/object/messages/description.rs:183-230` |
| Recv-loop arm that **discards** every PublicWeenieDescription field except `csetup_id` | `external/holtburger/apps/holtburger-web/src/lib.rs:3343-3378` |
| `EntityUpdate` wasm-bindgen struct (today: kind, guid, modelId, landblockId, xyz, quaternion only) | `external/holtburger/apps/holtburger-web/src/lib.rs:2076-2098` |
| Portal-destination DataIds (`LinkedPortalOne` / `LinkedPortalTwo` / `OriginalPortal`) | `external/holtburger/crates/holtburger-common/src/properties/property_keys/data_ids.rs:39, 56` |

### emit-static-site seams

| What | Where |
|---|---|
| `emit-static-site` orchestrator | `WorldBuilder.Terminal/StaticSiteEmitter.cs:41-128` |
| `coordSystem` emission | `WorldBuilder.Terminal/StaticSiteEmitter.cs:741-746` |
| `coordSystem` boot assertion | (emitted) `app.js:387-412` |
| Forward-compat live overlay hook (unused on current rail) | (emitted) `app.js:85-90` |
| Tile pyramid emitter (NOT consumed by the live client; see §4.5) | `WorldBuilder.Terminal/TilePyramidEmitter.cs:54-91, 101-134` |
| Sprite atlas (consumed by the live client at Phase 3 step 4) | `projects/<slug>/sprites/atlas.{png,js}` |
| Static-site WeenieType visual switch (Portal=cyan, HousePortal=purple, Sign=orange, fallthrough = category palette) — **Step 6b reference** | `WorldBuilder.Terminal/ObjectSpriteGenerator.cs:683-694` |
| Static-site glyph table (shape + colour by category) — **Step 6b reference** | `WorldBuilder.Terminal/RenderPreviewRenderer.cs:230-299` |
| Static-site portal billboard-disk fallback — **Step 6d reference** | `WorldBuilder.Terminal/ObjectSpriteGenerator.cs:188-200` |
| Static-site PaletteTemplate substitution — **Step 6c reference** | `WorldBuilder.Terminal/ObjectSpriteGenerator.cs:773-790` |
| Static-site sign inscription label rendering — **Step 6d reference** | `WorldBuilder.Terminal/RenderPreviewRenderer.cs:911-938` |
| Live-client entity sprite creation + magenta placeholder dot fallback — **Step 6b call site** | `external/holtburger/apps/holtburger-web/index.html:1640-1672` (placeholder at `:1669`) |
| Live-client per-poly rasterizer (where palette tinting slots in) — **Step 6c call site** | `external/holtburger/apps/holtburger-web/index.html:777-820` |
| `fetchEntityModelOnDemand` (cache-miss model fetch path) | `external/holtburger/apps/holtburger-web/index.html:1572-1599` |

### ACE seams

| What | Where |
|---|---|
| ACE network port config | `external/ACE/Source/ACE.Server/Config.js.example:5-26` |
| ACE socket initialization | `external/ACE/Source/ACE.Server/Program.cs:311-312` |
| ACE game-logic seam (`Session.Network.EnqueueSend`) | `external/ACE/Source/ACE.Server/WorldObjects/Player.cs:43, 114-117` |

### As-built docs from later phases

| Doc | Covers |
|---|---|
| [`phase-2-wasm-spike.md`](phase-2-wasm-spike.md) | Phase 2 §3 per-crate cross-compile matrix, §8 step ledger, status banner |
| [`phase-3-renderer.md`](phase-3-renderer.md) | Phase 3 steps 1, 2, 3, 3.5, 4, 4.5, 4.5b, 4.5c, 5 partial, 6 as-built reference + screenshots |
| [`phase-4-renderer.md`](phase-4-renderer.md) | Phase 4 step 1 + 2a + 2a.5 + 2a.6 + 2b + 3 + 3.5 + 4 (chat) as-built (login → CharacterList → CharacterCreate → spawn handshake → chat / `@telepoi` → live entity buffer with position rendering → WASD movement + prediction → DOM chat panel with category tabs covering all 16 chat-bearing AC packet types) |
| [`phase-5-thorough.md`](phase-5-thorough.md) | Phase 5.0 + 5.0b + 5.1a + 5.1b as-built (manifest+shards delivery, per-export refactor, transitive boot walk) |
| [`thorough.md`](thorough.md) | Phase 5.0 framing brief (already executed; historical reference for the delivery-architecture decisions) |
| [`manifest.md`](manifest.md) | Phase 5.2 framing brief (NOT YET EXECUTED; the manifest scale fix at the v2 schema layer) |
| [`ace-local-setup.md`](ace-local-setup.md) | Recipe for bringing up ACE locally (MariaDB + 3 DBs + .NET 10 SDK + upstream ACE clone) |
| Per-step handoff briefs (`phase-3-step-{1,2,3,4.5}-handoff.md`, `phase-4-step-1-handoff.md`) | Original framing briefs for individual steps. Deletable once the as-built docs above subsume their content. |

### Live-client wasm-bindgen surface (`apps/holtburger-web`)

> Signatures shown reflect the post-Phase-5.0b API: every
> `fetch_*` reads through the global `ManifestResourceSource`
> populated by `init_resource_source()` at page-init time, so
> none of them carry the `asset_url` parameter the original
> Phase 2 / 3 versions had. The internal flow is
> `global_source().prefetch(&keys).await` → sync
> `get_file_by_key(key)` per record → existing parse + tessellate
> logic.

| Export | Phase | Purpose |
|---|---|---|
| `build_info() -> String` | 2 | Bundle identification |
| `hash32(&[u8]) -> u32` | 2 | Deterministic AC packet checksum (smoke) |
| `session_smoke_test_packet_sequence() -> u32` | 2 | `Session::new_test` runs on wasm32 |
| `try_ws_handshake_smoke(bridge_url, ip, port) -> Promise<u32>` | 2 §8.2 | WsTransport ↔ Session wiring (browser-only validation needs live bridge) |
| `init_resource_source(manifest_url) -> Promise<()>` | 5.0 obj 5 | Page-init hook. Fetches `manifest.json` + boot pack, verifies sha256, populates the thread-local `ManifestResourceSource` every `fetch_*` reads from. Must be called once before any `fetch_*` or `start_session`. |
| `has_resource_source() -> bool` | 5.0 obj 5 | Introspection: did `init_resource_source` resolve? |
| `cached_shard_count() -> usize` | 5.0 obj 5 | Introspection: how many records are in the per-session shard cache (excludes boot pack). Smoke tests pin this as a "did `prefetch` populate the cache" probe. |
| `try_http_resource_source_smoke(namespace, file_id) -> Promise<u32>` | 2 §8.4 + 5.0b | Smoke-only round-trip through the global manifest source. Returns byte length of the named entry. |
| `fetch_landblock_heightmap(cell_id) -> Promise<LandblockMesh>` | 3 step 1 | Single-landblock terrain mesh (one-line wrapper around the plural form). |
| `fetch_landblock_heightmaps(cell_ids) -> Promise<Vec<LandblockMesh>>` | 3 step 2 | Batch terrain meshes + per-vertex `terrainCodes` + `roadCodes`. Pre-fetches the `eor/cell:XXYYFFFF` keys via the global source. |
| `fetch_terrain_textures() -> Promise<Vec<TerrainTexture>>` | 3 step 3.5 | All 33 retail terrain textures decoded to RGBA8. Explicit per-level prefetch (33 SurfaceTextures → up to 33 Textures → up to 33 Palettes). |
| `fetch_terrain_alpha_masks() -> Promise<TerrainAlphaMasks>` | 3 step 3.6 | Retail TexMerge alpha-mask scaffolding (4 corner + 1 side + 3 road masks decoded as PFID_A8 → RGBA8 with R=alpha). Available for any future authentic-TexMerge mode; the bilinear-blend path in step 3.6 doesn't use it. Container exposes `takeCorner` / `takeSide` / `takeRoad` getters for one-round-trip batched fetch. |
| `fetch_landblock_objects(cell_ids) -> Promise<Vec<ObjectPlacement>>` | 3 step 4 | LandblockInfo Stab + BuildInfo lists — `(model_id, x, y, z, rotation_z)` per placement. Tolerant of missing LBI records (ocean cells silently skipped). |
| `fetch_object_colours(model_ids) -> Promise<Vec<u32>>` | 3 step 4.5 | Per-model representative ARGB from each model's GfxObj/SetupModel → Surface chain. Iterative discovery via `RecordingSource` (Phase 5.0b). |
| `fetch_model_mesh(model_id) -> Promise<ModelMesh>` | 3 step 6 | Single-model triangulation (positions, uvs, normals, surfaceIndices, surfaces, bbox, worldBounds). Iterative discovery via `RecordingSource`. |
| `fetch_model_meshes(model_ids) -> Promise<Vec<ModelMesh>>` | 3 step 6 | Batch model triangulation. |
| `fetch_surface_pixels(surface_did) -> Promise<SurfacePixels>` | 3 step 6 | Single surface decoded to RGBA8 (Surface → SurfaceTexture → Texture chain). Solid-colour surfaces synthesize a 1×1 ARGB tile. |
| `fetch_surfaces_pixels(surface_dids) -> Promise<Vec<SurfacePixels>>` | 3 step 6 | Batch surface decode — feeds the in-browser per-poly rasterizer. |
| `start_session(bridge_url, ip, port, username, password) -> Promise<SessionHandle>` | 4 step 1 + 2a.5 + 5.0b | Drive AC login → CharacterList. Background-loads `CharGen` + `SkillTable` via the global source if `has_resource_source()` is true (Phase 5.0b dropped the legacy `asset_url` 6th param). |
| `SessionHandle.poll_events() -> Vec<ClientEvent>` | 4 step 1 + 4 | Pull-style event drain — JS calls per animation frame. Event kinds: 0 CharacterList, 1 PlayerSpawned, 2 ChatReceived (step 4 expansion: 16 source variants normalised through 24 `CHAT_CATEGORY_*` ids surfaced via `evt.u32Payload2` — covers system / local / tells / channels / emotes / combat / death / magic / advancement / transient / popup / help / trade / lfg / roleplay / general / fellowship / allegiance / recall / craft / appraisal / broadcast / society / olthoi), 4 Disconnected, 5 CharacterCreated, 6 CharacterCreateFailed, 7 EnteredWorld. |
| `SessionHandle.characterList() -> Vec<CharacterSummary>` | 4 step 1 | Account's characters once login resolves. |
| `SessionHandle.accountName() -> String` | 4 step 1 | Account name carried in the `CharacterList` packet. |
| `SessionHandle.canCreateCharacter() -> bool` | 4 step 2a.5 | Getter: did the catalog (`CharGen` + `SkillTable`) load? |
| `SessionHandle.selectCharacter(guid) -> Result<()>` | 4 step 2a | Drive `CharacterEnterWorldRequest` → spawn handshake. |
| `SessionHandle.createTestCharacter(name) -> Result<()>` | 4 step 2a.5 | Build an Aluvian / Male / Adventurer / Holtburg `CharacterCreateRequestData` via `holtburger_core::CharacterGenBuilder` and dispatch. |
| `SessionHandle.sendChat(message) -> Result<()>` | 4 step 2a.6 | Dispatch `GameAction::Talk(message)`. `@`/`/`-prefixed messages route to ACE's command parser; access-level enforced server-side. |
| `SessionHandle.pollEntityUpdates() -> Vec<EntityUpdate>` | 4 step 2b | Drain the high-frequency entity stream. Separate from `poll_events` — see the `EntityUpdate` doc comment for the rationale (position updates fire 100s/sec, dedicated typed-getter struct beats string-allocation in the hot path). Drained on every rAF tick alongside `poll_events`. |
| `SessionHandle.setMovementInput(forward, strafe, turn, run) -> Result<()>` | 4 step 3 | Forward a tristate-axis keystate snapshot (-1/0/+1 axes + run-modifier) to the recv loop, which builds and dispatches a `GameAction::MoveToState` packet. JS calls this on every change in keystate (one packet per key down/up transition or modifier flip), not on every animation frame — matches the cli's `PlayerDriveIntent::ManualHeld` semantics. Forward axis takes priority over strafe; turn rides on independent flag bits; run selects `HoldKey::Run` + run-rate speed/turn-speed scalars. The recv loop drops the cmd if no inbound `PrivateUpdatePosition` has landed yet (gate JS calls on `kind=7 EnteredWorld` to avoid the race). |
| `EntityUpdate { kind, guid, modelId, landblockId, x, y, z, qw, qx, qy, qz }` | 4 step 2b | Typed wasm-bindgen struct surfaced to JS. `kind`: 0=Position, 1=Spawn, 2=Remove. Source messages: `UpdatePosition`, `Public`/`PrivateUpdatePosition` → kind=0; `ObjectCreate` → kind=1 (with `modelId` = `csetup_id`); `ObjectDelete` → kind=2. Coords are landblock-local; JS converts via `(landblock_x_byte * 192) + local_x`. |

---

*Maintainers: when you change one of the decisions in §4, update §8 and §9 in
the same change. The as-built status of §5.2 and §7.1-7.4 lives inline in
those sections; the step-by-step record for Phase 2 lives in
`phase-2-wasm-spike.md`, Phase 3 in `phase-3-renderer.md`, Phase 4 in
`phase-4-renderer.md`, Phase 5 in `phase-5-thorough.md`. The framing
briefs for not-yet-executed phases (Phase 5.2 at `manifest.md`) sit
alongside; once executed, an as-built doc spawns next to them. This
file is the long-lived design intent; the spike + renderer docs are
the short-lived as-built
records, and the per-step handoff briefs at `phase-{N}-step-{M}-handoff.md`
are the per-step framing briefs (deletable once their step is closed and
captured in the as-built doc).*
