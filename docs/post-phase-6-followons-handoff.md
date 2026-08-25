# Post-Phase-6 Follow-ons — Handoff Brief

> Use this doc to brief the next agent (or returning human) picking up
> the `emit-dynamic-site` rail after the 2026-05-09 open-world +
> textures + door-rotation work landed. Phase 6 (buildings / interiors
> / Z-culling) is complete; the "make exploration anywhere actually
> look right" rail is closed. What remains is a mix of stability
> diagnostics, infrastructure-cleanup work, the deferred bandwidth
> rail, and a small set of visual-polish gaps.
>
> Structure: **Context → Validation gates → Open work (priority order)
> → Cross-cutting infrastructure → Recommended Explore-agent prompts.**
> Read in order. Don't start coding before you've finished §Validation
> gates — the live-capture story is broken and the smoke harness is
> the practical signal you have.

---

## Context

`emit-dynamic-site` is the WorldBuilder-ACME-Edition project to run an
Asheron's Call client in the browser, top-down view, against a live
ACE server. The vendored Rust client at `external/holtburger/` is
WASM-ported via `holtburger-web` (cdylib + index.html harness). All
design history lives in [`docs/emit-dynamic-site.md`](emit-dynamic-site.md);
this doc only covers the *remaining* work after Phase 6's follow-ons.

### What just landed (2026-05-09 session, master tip `c755bc8`)

| Commit | Closed |
|---|---|
| `bc71009` | EnvCell surface DIDs threaded via `0x08000000` OR mask — interiors render with real textures instead of flat grey. New `holtburger_dat::file_type::env_cell::surface_did_for_envcell_index` helper + `phase6.C.envcell_surface_did_resolves_via_namespace_or_mask` smoke check. |
| `56af743` | Outdoor terrain/buildings/objects hide on indoor — wraps the outdoor layer in a single `outdoorContainer` that `tickCellVisibility` toggles via `SessionHandle.isCurrentCellIndoor()`. New `phase6.D.outdoor_visibility_signal_pins_indoor_threshold` smoke check. |
| `357e8ed` | Terrain mesh renders for arbitrary landblocks on player entry (open-world step 1/3). `ensureTerrainAroundLandblock` now adds PIXI tiles to `outdoorContainer`, not just the wasm-side height cache. |
| `5587fa0` | Buildings + non-building object sprites render for arbitrary landblocks (open-world step 2-3/3). New `ensureLandblockObjectsForLandblock` helper hooked into `handlePositionUpdate`. |
| `c755bc8` | Per-part door rotation — building's static door part now swings with the door entity sprite. JS-side `findClosestBuildingPart` spatial match (≤5m), cached per door GUID for clean close-rotation. |

### Where the project stands

- **Native:** `cargo test --workspace --lib` 1171 / 0 across 18 crates.
- **WASM:** `wasm-pack build --target {nodejs,web}` clean.
- **Smoke:** `node smoke_test.cjs --fast` 80 OK / 2 SKIP / 0 FAIL.
  The 2 SKIPs are the manifest-fixture bake (~6 min) and live-ACE
  round-trip (always skipped without a real backend).
- **Open-world end-state:** player can portal/walk/respawn anywhere
  in Dereth and see terrain + buildings + signs + EnvCells + door
  swings. Missing visual polish is enumerated below.

---

## Validation gates

**Update 2026-05-09:** the prior "Target crashed" claim was stale.
Re-tested today: chromium runs full login → spawn → @telepoi →
screenshot end-to-end on this host. Two real product regressions
surfaced when the captures *do* run: Phase 6A asserts buildings
have `MIN_PARTS=5` per building but `buildingMap` shows every
building with 1 child + ~150-220 tris (per-part walker fusing
into one mesh, likely after the open-world LB-entry render path
landed); Phase 6C asserts `cellContainers.size ≥ 1` post-walk
but the registry stays at 0. Phase 4 + older `capture_step6_*.cjs`
(12 files) still use the pre-`3954289` `input[name="server_ip"]`
selector — only the 6 Phase 6 captures got the `57de06b` fix.

For day-to-day work `node smoke_test.cjs --fast` (≈1 min) +
`cargo test --workspace --lib` (≈10 min) remain the fast gates;
live captures should be added back once 6A + 6C are fixed.

### Live-server stack (for browser-side validation)

- **Tailscale:** the server is on `<server-ip>`. Phone or laptop
  on the tailnet hits `http://<server-ip>:8765/apps/holtburger-web/index.html`.
- **Login form:** Bridge URL `ws://<server-ip>:8080/`, Server host
  field uses `input[name="server_host"]` (NOT `server_ip` — that's
  stale per memory). Account/password is `<account>`/`<account>`,
  promoted to Developer access level so `@telepoi` and similar
  admin commands work.
- **Tester:** PK (the user). When asking for a live verification,
  frame it as "load the page, do X, watch for Y" with concrete steps
  — PK doesn't have time to debug your test plan.
- **Bake recipe before reload:**
  ```
  cargo run -p holtburger-tools --bin dat-shard --release -- \
    --input dats/assets.hba --output dist/
  ```
  `dist/` symlinks to `/mnt/wbterminal{1,2}` — never to `/` or
  `/tmp` (would fill ~4.7 GB onto the system disk; see
  `project_holtburger_bake_disk_trap` in agent memory).

### What smoke can prove vs not

| Pass smoke proves | Pass smoke does NOT prove |
|---|---|
| Wasm exports compile + return expected sentinel values | DOM / PIXI rendering actually paints |
| `holtburger_test_*` synthetic-state integration is correct | Live ACE round-trip works in steady state |
| Native crate boundaries compile both targets | Browser perf / batch state churn |
| Surface chains parse & decode the 33 retail terrain textures | Position interpolation feels smooth at 60Hz |

For JS-only changes (today's open-world commits, the door rotation),
smoke can only confirm "no crash, wasm exports unchanged." Visual
correctness still needs a browser walk-through.

---

## Open work — priority order

### 1. Wire wasm-side `Scene::register_door_part` to live ObjectCreate

**Status:** Infrastructure exists (`crates/holtburger-world/src/spatial/scene.rs:250` —
`register_door_part(door_guid, building_id, part_index)` and the
matching `door_part_for_guid` lookup), but is only called from the
two synthetic test fixtures at `apps/holtburger-web/src/lib.rs:4233`
and `:4295`. Live ObjectCreate events for door entities never
register; the `door_part_index` HashMap is empty in production.

**Intent.** Replace the JS-side `findClosestBuildingPart` spatial
heuristic (commit `c755bc8`) with the indexed wasm lookup so doors
resolve in O(1) by GUID instead of an O(N parts) scan with a 5m
proximity threshold. The heuristic works for Holtburg's sparse
buildings but will mismatch in dense areas where multiple doors
sit within 5m.

**Why.**
- The 5m heuristic has a known failure mode: tightly-packed doors
  in shops/dungeons. Indexed lookup is correct.
- Sets up the precondition for the **hinge-frame extraction** work
  below — once we know which Setup part is the door, we can pull
  the part's frame from `SetupModel` and rotate around the hinge
  edge instead of the sprite anchor.
- Removes a JS-side closure that has to know about PIXI container
  layout — wasm-side becomes the single source of truth.

**Concrete starting points.**
- Door registration hook: the recv loop's `ObjectCreate` arm in
  `apps/holtburger-web/src/lib.rs::recv_loop` — when an object's
  `public_weenie_desc.ObjectDescriptionFlag` has the DOOR bit set,
  match its setup_id against the containing building's part list
  (already populated by `populate_building_aabbs_for_landblock`)
  and call `scene.register_door_part`.
- Need to extend `BuildingAabbEntry` (or a sibling registry) to
  carry each part's source GfxObj DID so setup_id matching works.
  Today only the AABB + `(building_id, part_index)` are stored.
- New wasm export `SessionHandle.getBuildingPartForDoor(guid) ->
  Option<{buildingKey: String, partIndex: u8}>`. Doc-comment for
  this export at `apps/holtburger-web/src/lib.rs:4408` already
  references it.
- JS swap: in the `kind=15` handler, replace the
  `findClosestBuildingPart(entry)` call with the indexed lookup
  result. Keep the spatial heuristic as fallback for buildings
  loaded before door registration completes.

**Smoke.** Add a `holtburg_test_door_part_registration` fixture that
synthesizes a building + door pair, calls the (new) registration
function via the recv-loop hook, and asserts `door_part_for_guid`
returns the right entry. Mirrors the existing
`holtburg_test_door_open_drops_aabb` shape.

---

### 2. Door hinge-frame extraction from SetupModel

**Status:** Doors currently rotate around the PIXI sprite's anchor
point `(0.5, 0.5)` — see the long doc-comment on
`holtburg_test_door_rotation_keyframe` at `lib.rs:4403`. Real doors
pivot around their hinge edge, not their geometric centre.
Visually approximate but not retail-correct.

**Intent.** Pull the per-part frame (`Frame { origin, orientation }`)
from each `SetupModel` part's metadata, treat the frame's origin as
the hinge pivot, and rotate around that point in the building's
local coord system instead of the sprite anchor.

**Why.**
- Visual fidelity: a Holtburg house door currently swings with its
  centre fixed, so the open-state corner pokes through the wall.
  Hinge rotation matches retail.
- Sets a precedent for other articulated geometry (drawbridges,
  windmill blades, lifestone glow) that also need part-relative
  pivots.

**Concrete starting points.**
- `crates/holtburger-dat/src/file_type/setup_model.rs` — confirm
  the parser exposes `parts: Vec<{frame: Frame, ...}>` per part.
  The current `bakePerPartBuildingTextures` path uses `localOffset`
  + `worldBounds` for the sprite — those derive from the part's
  AABB centre, NOT its frame origin. Need to thread the raw frame
  through to the JS layer.
- New `PerPartBake` field `hingeFrame: [f32; 7]` (origin xyz +
  quat wxyz) so JS can apply it on rotation.
- JS rotation math: PIXI Graphics' `pivot.set(hx, hy)` shifts the
  sprite's rotation centre. Combine with hinge_frame's local→world
  transform.
- Cross-check `external/ACE/Source/ACE.Server/Physics/Animation/`
  for how retail derives door pivot — there may be an
  `AnimDirective` or similar that names the hinge bone explicitly
  (depends on Setup metadata).

**Risk.** Setup parts may not have a hinge frame distinct from the
part origin, in which case rotation around frame origin still
mis-pivots (just less wrongly). Phase 6's
`phase-6-buildings-and-interiors.md` §6 risk #6 calls this out:
"Door hinge frames may not be in Setup metadata. If the Setup
format doesn't expose them, Phase E may need to derive from AABB
local origin."

---

### 3. Integrator overshoot diagnosis

**Status:** Local-pose integrator runs at ~25 m/s effective walk
speed when the MotionTable says 4.5 m/s. Diagnosed via a Playwright
walk-diag script run last week (see commit body of `bbf8aae`).
Suspected dt scaling bug or Playwright-headless rAF artifact.
Doesn't cause death. Cosmetic only.

**Intent.** Determine whether the overshoot manifests in real
browsers (not just Playwright headless). If it does, find and fix
the dt application bug. If it doesn't, document the Playwright
caveat and close.

**Why.**
- Low priority — players don't die from this and movement still
  works. But: any future "smooth pose interpolation" work depends
  on dt being correctly applied, so the answer matters before
  step-2b's interpolation polish lands.
- Distinguishing a real bug from a test-environment artifact is
  a 30-minute task with the right instrumentation; the answer
  unblocks the open question.

**Concrete starting points.**
- The integrator is at `pose.x/y += velocity * dt` in
  `crates/holtburger-world/src/movement/integrator.rs` (or
  similar — confirm via search). `dt` comes from
  `now.saturating_duration_since(prev)` against
  `web_time::Instant`.
- The recv loop's `TickMovement` arm in
  `apps/holtburger-web/src/lib.rs` calls
  `MovementSystemHandle::tick(...)` — instrument both the dt
  passed in and the resulting pose delta.
- Compare Playwright headless rAF rate vs real browser. Chromium
  with `--use-gl=swiftshader` has known rAF irregularities that
  could double-fire ticks.
- Re-read `docs/emit-dynamic-site.md` lines 901-910 for the
  original observation context.

**Smoke.** Hard to write — the existing tests use synthetic dt.
A fixture could call `MovementSystemHandle::tick` with a known dt
sequence and assert the resulting pose delta matches `velocity * Σdt`
within tolerance. Catches double-application bugs but not rAF
artifacts.

---

### 4. caps_ok regression root cause

**Status:** A watchdog re-installs the fallback
`SelfMovementCapabilities` override at every tick when
`resolve_self_movement_capabilities` returns Err (commit `bbf8aae`,
2026-05-08). PlayerDescription handle logs `real_caps_ok=true`, but
tick #60 reads `caps_ok=false`. Some message between the two clears
the player's Run skill or breaks MotionTable resolution. The
watchdog catches it; root cause is unknown.

**Intent.** Identify which message handler mutates
`world.player.skills` (or motion-table state) between
PlayerDescription and tick #60. Once identified, fix it so the
watchdog can be removed.

**Why.**
- Watchdogs are fences against unknown bugs — the bug is still
  there, the watchdog just keeps the player moving. Any future
  work that also depends on caps_ok being correct (combat, skill
  checks, attribute use) could trip the same issue without the
  watchdog catching it in time.
- Reduces complexity: `lib.rs` can drop ~58 lines of watchdog
  bookkeeping (added in `bbf8aae`).

**Risk of inconclusive outcome.** This is the most diagnostic-heavy
item on the list. The investigation could take several iterations
against the live stack and end with "still don't know which
message triggers it." Worth timeboxing to ~4 hours and falling
back to "documented mystery, keep the watchdog" if the trace
doesn't narrow.

**Concrete starting points.**
- Per-tick trace of `world.player.skills.get(Skill::Run)` in the
  recv loop's TickMovement arm. Print on every change, log the
  current message being processed.
- Suspects (in order): `UpdatePropertyInt(SkillRanks)` /
  `UpdatePropertyInt64(SkillExperience)`, `UpdateSkill` if it
  exists, any `RemoveProperty` for the Run skill. The dispatcher
  is at `crates/holtburger-core/src/client/messages.rs::handle_message`.
- `MovementSystemHandle::resolve_self_movement_capabilities` is
  the function that returns Err — read its body to see what it
  reads from `world.player`. Whatever field it reads is what's
  being clobbered.

---

### 5. Phase 5.2 — manifest scale fix (bandwidth rail)

**Status:** Brief written at [`docs/manifest.md`](manifest.md) (1293
lines, commit `5cc08d1`, 2026-05-05). NOT executed. The current
`manifest.json` baked from a real `dats/assets.hba` is **203 MB**
(885k entries × ~230 bytes verbose JSON). At 600 kbps cellular that's
a 46-minute first-paint fetch — worse than the original Phase 5.0
single-bundle cliff that was 605 MB / 2.2 hours.

**Intent.** Replace the single fat `manifest.json` with a 3-layer
index:
1. Top-level `manifest.json` ≈ 2 KB (always fetched).
2. Per-namespace binary catalogs `manifest/<namespace>.bin`
   (~6-8 MB gzipped for `eor/cell`, <1 MB for `eor/portal`,
   lazily fetched per namespace).
3. Convention shard URLs derived from `(namespace, file_id)` —
   no central index needed.

**Why.**
- Required before public CDN deploy or 600 kbps cellular phone
  validation (Phase 5 obj 11, deferred from 5.0).
- NOT required for dev iteration over Tailscale WiFi — current
  setup works fine for everything except the bandwidth-cliff
  story.
- 2 KB top-level + 1.86 MB boot.hba + protocol = <60 s first paint
  at 600 kbps. That's the win.

**Concrete starting points.**
- Read `docs/manifest.md` end-to-end first. The 11 numbered
  objectives + verification gates + "tradeoffs accepted" section
  are the work plan.
- v1 emit path: `apps/holtburger-tools/src/dat_shard.rs::write_manifest`
  (or similar — search for `serde_json::to_writer` in that file).
- v2 schema lives in `holtburger-manifest::v2` (not yet created;
  the brief specifies a binary format with header magic `'HBNS'` /
  trailer magic `'SNBH'`).
- Pragmatic deviation from the brief: `--manifest-version=1|2`
  CLI flag with v2 default + one release cycle of v1 fallback for
  in-flight CDN deploys.

**Validation gates per the brief.**
- Native lib gate 1121 → 1130 (so add ~9 unit tests across the
  v2 schema parser + emit).
- Smoke 56 → ~62 (the brief lists 6 new checks).
- Real-world `manifest.json` <5 KB, per-namespace catalog <20 MB
  raw / <8 MB gzipped.

---

### 6. biota_properties_position lazy persist (likely OUT OF SCOPE)

**Status:** ACE doesn't flush player position to MariaDB during
gameplay — only on save / logout / periodic. Wire round-trip works
(UpdateMotion echoes; server memory tracks correctly); only the
`ace_shard.biota_properties_position` SQL row stays stale.

**Intent.** Make ACE flush position more aggressively (configurable
interval).

**Why this is probably out of scope.**
- Server-side ACE.Server work, not client. Touching upstream ACE
  pulls the maintenance burden out of `external/holtburger/` into
  `external/ACE/Source/`.
- Workaround exists: client-side diag scripts can dump
  `PrivateUpdatePosition` events as they arrive, which gives live
  position without any DB poll.
- No gameplay impact — the game itself works; only diag tooling
  cares about the SQL row.

**Recommendation.** Skip unless a specific diag use case forces
the issue. If the user asks for it, push back with the workaround
first.

---

## Cross-cutting infrastructure notes

### Smoke harness (`apps/holtburger-web/smoke_test.cjs`)

- Runs against `pkg-node/` built by `wasm-pack build --target nodejs --out-dir pkg-node`.
- `--fast` mode skips the manifest fixture bake (~6 min). CI runs
  full by default; local dev uses `--fast`.
- Add new checks via the existing `check(name, ok, detail)` pattern.
  Phase-prefixed names (`phase6.E.X`) are the convention.
- Wasm-bindgen test fixtures named `holtburg_test_*` return `0` on
  pass, nonzero error code on fail — the doc-comment enumerates
  codes.

### Bake pipeline

- `dat-shard` produces ~4.7 GB into `dist/`. **`dist/` MUST symlink
  to `/mnt/wbterminal{1,2}`**, never to `/` or `/tmp` (root disk
  fills, system breaks). See `project_holtburger_bake_disk_trap` in
  agent memory.
- Re-bake required after changes that affect:
  - `holtburger-dat` parsers (the manifest hash changes)
  - The `dat-shard` boot-pack policy (`StripperManifest::boot`)
  - Adding new namespace entries
- NOT required for pure JS / pure wasm-bindgen export changes.

### Live-capture status (re-verified 2026-05-09)

Captures are at `apps/holtburger-web/capture_phase*.cjs`. All use
Playwright + Chromium with `--use-gl=swiftshader`. **Chromium
runs fine on this host.** The prior "Target crashed" claim was
stale.

Real status:
- Phase 6 captures (6 files: `capture_phase6_step_{a..f}_*.cjs`)
  use the post-`3954289` `input[name="server_host"]` selector
  and run end-to-end through login → spawn → @telepoi →
  screenshot. They fail on real product assertions:
  - **Phase 6A** asserts buildings have ≥5 child parts; today
    every building shows 1 child + ~150 tris. Per-part walker
    fusing into a single mesh — likely a regression after the
    open-world LB-entry render landed (357e8ed/5587fa0)
    bypassed `bakePerPartBuildingTextures`.
  - **Phase 6C** asserts `cellContainers.size ≥ 1` after
    walking 3s W toward Holtburg town hall doorway; registry
    stays at 0. Either `ensureCellContainersForLandblock`
    isn't firing on `PlayerTeleport`, or the player
    doesn't walk far enough to cross into an EnvCell.
- Phase 4 + older `capture_step6_*.cjs` (12 files) still use
  the pre-`3954289` `server_ip` selector — only Phase 6
  captures got the `57de06b` fix. Mechanical sweep needed.

If captures DO crash unexpectedly: confirm bare chromium
launches with `chromium --headless --disable-gpu about:blank`,
then capture `page.on('pageerror')` + first 60 console events.
The `playwright` install is in the npx cache at
`/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules` —
set `NODE_PATH` accordingly when running scripts directly via
`node ...cjs`.

### Memory pointers

- `project_emit_dynamic_site.md` — full design history (don't
  re-read in full; it's huge). Use the in-memory "Phase 6" header.
- `project_holtburger_bake_disk_trap.md` — the `/mnt/wbterminal`
  symlink rule.
- `project_holtburger_login_form_picker.md` — `server_host` not
  `server_ip`.
- `project_holtburger_godmode_falldamage.md` — `/god` admin
  command works around the persistent fall-damage bug.
- `feedback_test_fixtures_real_data.md` — prefer real
  `portal.dat` from the installer over synthetic fixtures.
- `feedback_no_partial_demos.md` — push back when a partial demo
  bypasses the load-bearing path; say "I can't fully demonstrate
  this without X" instead.

---

## Recommended Explore-agent prompts

When picking up any of the above, ground first via an Explore agent
before writing code. Each item below is a self-contained prompt you
can hand the agent verbatim. The agent is read-only and surfaces
file:line references — not implementation. Use its output to write
your plan, not your code.

### For item 1 (wasm-side door registration)

```
Map the door entity lifecycle in the holtburger-web wasm bundle,
end-to-end. I'm trying to wire Scene::register_door_part to live
ObjectCreate events instead of the two synthetic test fixtures
that call it today.

Find:
- Every recv-loop arm in apps/holtburger-web/src/lib.rs that
  handles ObjectCreate (kind=1 spawn). Pull the surrounding 30
  lines so I can see what fields are extracted from the wire.
- ObjectDescriptionFlag::DOOR — where is it defined, where is it
  read. Confirm it's surfaced on the EntityUpdate / ClientEvent
  surface today.
- populate_building_aabbs_for_landblock — what gets stored per
  building part. Specifically: does each part keep its source
  GfxObj/Setup-part DID anywhere reachable from BuildingAabbEntry?
- Scene::register_door_part + door_part_for_guid signatures and
  the matching test fixtures at lib.rs:4233 and :4295.

Out of scope: SetupModel hinge frames (that's a separate item).

Report as a punch list of file:line references with one-line
descriptions, under 300 words. I'll write the implementation plan
from your output.
```

### For item 2 (door hinge frames)

```
I need to extract per-part hinge frames from SetupModel records
so doors can rotate around their hinge edge instead of the sprite
anchor (0.5, 0.5). The current state is at apps/holtburger-web/
src/lib.rs:4403 — the holtburg_test_door_rotation_keyframe doc-
comment names this as the deferred work.

Find:
- crates/holtburger-dat/src/file_type/setup_model.rs — what fields
  does the parser expose per part? Specifically a Frame (origin +
  quaternion) per part.
- Any existing consumer of SetupModel parts that uses the per-part
  frame for transform (not just AABB centre). bakePerPartBuilding-
  Textures probably uses localOffset/worldBounds — confirm those
  derive from AABB or from the frame.
- Cross-check external/ACE/Source/ACE.Server/Physics/Animation/
  for how retail derives door hinge bones — search for
  "AnimDirective", "hinge", "pivot", "bone" near door-related
  classes.
- Cross-check WorldBuilder.Shared/ for any C# code that already
  does this (the static-site emitter may have solved it).

Confirm or deny: "Setup parts have a Frame distinct from their
AABB centre, suitable for use as a hinge pivot."

Report under 250 words. If the answer is "no, Setups don't expose
hinge frames," say so explicitly — that changes the implementation
strategy from extraction to derivation.
```

### For item 3 (integrator overshoot)

```
Diagnose where the local-pose integrator's effective walk speed
becomes ~25 m/s when the MotionTable says 4.5 m/s. Suspected dt
scaling bug or Playwright-headless rAF artifact.

Find:
- The integrator function — `pose.x/y += velocity * dt`. Search
  crates/holtburger-world/src/movement/ and any *.rs file with
  "integrator" in the name. Pull the full function with
  surrounding 20 lines.
- Where dt is computed. The recv loop's TickMovement arm in
  apps/holtburger-web/src/lib.rs is one site; the
  MovementSystemHandle::tick body is another. Check if dt could
  be double-applied (passed in AND re-computed inside).
- The web_time::Instant import path. Is there a chance that the
  wasm-side Instant ticks at a different rate than the rAF loop's
  performance.now() reads?
- Any existing diagnostic logging for dt or velocity. The 2026-05-08
  walk_diag4.cjs probe script (referenced in commit bbf8aae) may
  have left instrumentation behind.

Report as a list of file:line refs naming each dt source + each
velocity source, with one-sentence "this could explain the
overshoot if X" hypothesis per pair. Under 350 words.

Out of scope: real-browser-vs-Playwright comparison (that's a
human task with a real browser).
```

### For item 4 (caps_ok regression)

```
I need to identify which message handler clears the player's Run
skill (or breaks MotionTable resolution) between PlayerDescription
and tick #60. The watchdog at commit bbf8aae catches the regression;
removing it requires finding the underlying gap.

Find:
- crates/holtburger-core/src/client/messages.rs::handle_message —
  pull the full match arm list. I want to know every variant that
  could touch player skills.
- Specifically: UpdatePropertyInt with SkillRanks, UpdatePropertyInt64
  with SkillExperience, UpdateSkill (if it exists), RemoveProperty
  for any skill key.
- MovementSystemHandle::resolve_self_movement_capabilities — pull
  the full body. Whatever fields it reads from world.player are
  the suspects.
- Any place that calls `world.player.skills.clear()` or
  `.remove(...)` or assigns over the whole skills collection.

Report a ranked suspect list (most-likely → least-likely) with
file:line refs, under 250 words. Note any handler that's a no-op
in the wasm cfg-gated path so I don't waste time chasing it.
```

### For item 5 (Phase 5.2 manifest scale)

```
I'm picking up Phase 5.2 (the manifest scale fix). The brief is
at docs/manifest.md (1293 lines). Before I implement, I need to
ground in three things:

1. Read docs/manifest.md and report the 11 numbered objectives
   with one-line summaries. I'll use this as my work plan.

2. Map the v1 emit path. Find every place in
   apps/holtburger-tools/ that writes manifest.json — specifically
   the function that serializes the StripperManifest::boot output
   to JSON. Pull the function body so I can see the data flow.

3. Map the v1 read path. Find every place in
   crates/holtburger-resource-http/ that parses manifest.json.
   Specifically ManifestResourceSource::connect — what fields does
   it read, and where would a v2 binary catalog format slot in?

Report under 400 words with file:line refs. Don't summarize
manifest.md beyond the objective list — I'll read the rest myself
when I have the v1 paths in hand.
```

### Generic — when in doubt

```
I'm working on emit-dynamic-site (browser-playable AC client at
external/holtburger/). I need to understand <thing>. The full
design history is in docs/emit-dynamic-site.md but it's huge —
don't re-read it. Memory has a Phase 6 summary I'll provide
separately.

Find: <specific files / symbols / questions>.

Report as a punch list of file:line references with one-line
descriptions, under 300 words. Don't write implementation; I'll
plan from your output.
```

---

## Things NOT in this doc (deliberately)

- **Phase 6 itself.** Already as-built in
  `docs/phase-6-buildings-and-interiors.md`. Don't re-design.
- **The 5 commits from 2026-05-09.** Already in git log + the
  in-memory project entry. Don't re-summarize.
- **Content rail expansions** (NPC dialogue panels, vendor windows,
  combat animations, more entity types). These are real future
  work but not "follow-on" — they're new phases. Will get their
  own briefs when scoped.
- **Server-side ACE work.** Out of scope for this client project.
  Item 6 (biota persist) is the one place that would cross the
  boundary — recommend skipping per that section.

---

## Recommended starting order

1. **Item 1** (wasm-side door registration) → unblocks item 2.
2. **Item 2** (hinge frames) → completes the door rotation story.
3. **Item 3** (integrator overshoot) → small, contained, may be
   a 30-minute close-out if the answer is "Playwright artifact."
4. **Item 4** (caps_ok root cause) → timebox to ~4 hours; document
   and close as "still mysterious, watchdog stays" if the trace
   doesn't narrow.
5. **Item 5** (Phase 5.2 manifest scale) → only if public CDN
   deploy or phone validation is on the near horizon.

Items 3 and 4 are independent of the door rail and can be done in
parallel by different agents if you want to fan out.
