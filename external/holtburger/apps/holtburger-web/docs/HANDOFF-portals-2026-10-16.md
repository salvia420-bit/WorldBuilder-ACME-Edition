# Handoff — every portal at the purple-portal standard, and why portals "popped" (2026-10-16)

Owner ask: there are many kinds of portals (destroyed ones, spell / NPC / gem
summoned ones, different colours) — bring all of them up to the new purple
portal graphics, and fix the broken ones: "a glitchy effect where the portal
pops up, likely related to a very old issue we had where a holtburg sign was
stuck in the ground and would pop up as we moved toward or away from it.
fundamental root cause fixes are better."

No GPU box was used (laptop rule: no live sessions; 1070 runs are owner-run).
Everything below is pinned by node suites; the look checks are queued at the
end.

## 1. Every kind of portal (from the base DATs + the live ACE world DB)

A portal's visual is not its mesh: every portal is built on GfxObj
**0x0100168B, an invisible 2.8 m quad**, plus a light and a default-script
swirl. 3,308 Portal weenies (ACE) wear 53 Setups; 17 more portal Setups exist
only as static decorations in dungeon cells. Full inventory (every Setup's
parts, placement frames, lights, script chains, emitters, weenie samples):
session scratch `portal-inventory.{md,json}`; the runtime table is
`data/portal-setups.json` (below).

| kind | Setups | examples | how they appear |
|---|---|---|---|
| disc | 36 | purple 0x020001B3 (1,992 weenies), red / green / yellow / orange / blue 0x020005D2-D6, **white Gateway 0x020006F4**, two-tone 0x02000EF6, Dark Vapor 0x020008FD, portal-space decorations 0x02000C16-C4F | Portal weenies; statics in dungeon cells |
| pillar | 8 | catacomb / temple exits 0x02001206 / 98 / 99 / 9D-9F, Mhoire Castle 0x02001945 (Creature!), Mysterious Portal 0x02001BE3 | eight 0x010001EC anchors stacked 0-3 m + the quad as part 8 |
| dead | 3 | **the 39 Destroyed Portals 0x020019E4**, The Shadows 0x02001A7C, Combat Arena 0x020018C0 | pillar rig, dark funnel + black stars + purple sputters and rings |
| dark | 5 | shadow portals 0x02001582 / 0x020018C2 / 0x020015A5, Spire's Head 0x020015A3 / A4 | quad + dark swirls |

- **Summoned portals are always the white Gateway.** ACE `SummonPortal`
  creates wcid 1955 (Setup 0x020006F4) for all 11 summon spells, the 491 items
  carrying them (484 gems, 6 scrolls, 1 trap) and the 80 NPC emotes that cast
  them (49 on death); only the destination is copied from the linked portal.
  It lives 60/180/300/900 s and is destroyed with no fade (retail too).
- **22 "disguised" Portal weenies draw no portal** (bookcases, cow / rooster /
  golem / virindi statues, gauntlet and arena arches, conveyance rune pads,
  lava tiles, the invisible Great Hall) but carry the PORTAL description bit.
- Retail-inert: every disc portal's second "rim" layer has hwGfxObj 0 and
  never spawns (17 emitters) — their catalog rows are dormant.

## 2. Why portals popped — five root causes, all fixed (each DEFAULT ON, `=off` escape)

1. **The portal light rode the spinning part** — `?lightObjectFrame`
   (lighting.js, entities.js). Every ACE portal carries MotionTable
   0x09000003, whose Ready cycle spins part 0 (the quad, posed 1.415 m up)
   360° every 4 s. Entity lights were parented under `parts[LightInfo key]`,
   so the portal's purple light sat 3.7 m up and orbited a 2.3 m circle that
   dipped ~0.9 m under the ground — and froze at a random phase beyond the
   120 m animation gate, so the glow moved / vanished / came back as the
   player walked toward or away. Retail lights live in the OBJECT frame
   (`LIGHTLIST::set_frame`, acclient.c:325029; `Frame::combine(object,
   LightInfo.offset)`, :380601); the key is never a part. Lights now hang off
   the rig root at the LightInfo offset (unscaled), and an entity's lights are
   attached when it spawns, not at the next landblock rescan (a re-created
   portal stayed unlit until then).
2. **The particle cull sphere sat on the portal's foot** — `?rp6TrueSphere`
   (particle_manager.js `rp6CullSphere`). RP6 culled an emitter whose sphere
   (rig origin, travel radius + hook offset) left the frustum. The swirl rides
   part 0 1.5 m up in 5x-scaled 1.4 m layers; a destroyed portal's sputters
   ride parts up to 3 m up behind a 0.9 m sphere on the ground — so walking up
   to a portal (its foot leaving the frame) hid the swirl and it popped back.
   The sphere is now centred on the part frame and adds one sprite's reach.
3. **Static emitters ignored their part** — `?staticPartAnchor` (statics.js,
   new wasm export `fetchSetupPartPose`). Static default-script anchors had no
   `partFrames`, so every part-anchored hook fell back to the placement
   origin: static portal swirls on the ground, destroyed-rig sputters 3 m low,
   lamp flames at the foot of the post (753 Setups in the DAT; 215 outdoor
   placements + the dungeon portal halls). Anchors now carry the static mesh's
   own part pose.
4. **Static LOD bands lost the Setup pose — the "Holtburg sign" class** —
   `?degradePose` (statics.js, `ModelMesh.degradePartFrame`). A degrade band
   is a GfxObj for the PART (retail `CPhysicsPart::UpdateViewerDistance` /
   `calc_draw_frame`); the statics LOD drew it raw at the Setup origin, so a
   static whose Setup lifts / turns / scales its part sank or slid at every
   band switch and popped back at full detail (180 Setups / 2,234 outdoor
   placements move ≥ 5 cm). The entity path was fixed in 9f105e74; statics
   never were. Bands are now posed by the exact frame the full mesh uses
   (shared `setup_part_frame` in lib.rs); singleton billboard bands pivot on
   the part. Also: band clones now own their `userData` (three's
   `BufferGeometry.clone` shared it, so models citing one band overwrote each
   other's lodDist / cache tag). And the entity fix's part-0 swap is now
   PREPENDED (the wasm part walk is last-match-wins, so a wire part-0 change
   was being overridden by the original model's band).
5. **A re-sent CreateObject rebuilt the portal** — `?portalRecreateInPlace`
   (entities.js `samePortalInstance`). `spawn()` tore down an existing rig on
   every ObjectCreate, so when ACE re-sent a portal the swirl restarted from a
   big faint layer, the set piece faded in again and the light was gone.
   Retail applies a same-instance create in place (`SmartBox::
   HandleCreateObject`, acclient.c:145881). Same portal Setup + place + heading
   + appearance → the live rig is kept. Portals only.

## 3. Every portal at the purple standard — `?portalSetPiece`

The set piece (portal-space nebula disc + ground light ring,
`vfx/fx_showcase.js`) now keys on the portal's **Setup**
(`vfx/portal_setups.js`, generated: `tools/particle-fx/portal_setups.py` →
`data/portal-setups.json` → `node scripts/gen-portal-setups.mjs`):

- every disc / pillar portal gets it — Portal weenies, creatures wearing a
  portal (Mhoire Castle), and static portal decorations (statics.js registers
  the anchors, `vfx/portal_registry.js`); the 22 disguised portals no longer
  grow a violet disc;
- centre from the portal's own geometry (main swirl's part frame + offset, or
  the quad) — the pillar / destroyed portal disc no longer sits on the
  ground-level funnel; colour and radius from the table (no dependence on the
  swirl's light getting a pool slot);
- the nearest 8 within 60 m (was: the first 8 found), fading in / out over
  0.6 s and with distance 48 → 60 m (was: a hard pop at 60 m);
- **dead** portals: a dim, wavering, hollow ember + faint ring; **dark**: a slow
  starless haze.

Particle data (`enrich.py`: a Setup built on the portal quad is a portal
setup): the portal-space green / orange / white swirls 0x32000697/98/9A and
the shadow swirls 0x32000877/82/93/9B gained the portal tag → purple's
breathing (0.07 @ 0.9 Hz), light (36.2) and swirl distortion. The pipeline
was re-run end to end: the catalog / tier-1 diff is exactly those rows (plus
three dormant rims and the Combat Arena star). `tier1_overrides.json` dims the
Destroyed Portals' sputter lights from the live portal's 36 / 9 m (a strobe
every 3.3 s) to their rings' level (12 / 4.5 m) — retail gives them no light.

## 4. Verification

- New suites (registered in `harness/run-js-headless.mjs`):
  `tests/portal_set_piece.test.mjs` (48), `tests/portal_particle_anchor.test.mjs`
  (36), `tests/light_object_frame.test.mjs` (19),
  `tests/portal_recreate_in_place.test.mjs` (17),
  `tests/statics_degrade_pose.test.mjs` (42), `tests/lod_part_swap_order.test.mjs` (3).
- Rust: `degrade_part_frame_poses_bands_like_the_full_mesh` (the band pose ×
  the raw band == the setup walk's full mesh, vertex for vertex) + the whole
  `tests_substitution` module (26).
- Updated: `test_portal_fx_parity.mjs` (39), `test_particle_fx_tier2.mjs` (107),
  `test_particle_fx_tier2_gpu.html`
  — both used to model a portal as "the ODF bit", which is exactly the
  disguised-portal case the new rule refuses.
- Regression reruns green: particle runtime / owner / cull-freeze / cell-gate
  / RP6 authority / blocking / degrade, lighting (phase 7.6, cell lights, light
  guard, spotlight, held FX light), entity pipeline / lifecycle / setup rig,
  static geom cache, retail degrade, LOD collapse, bake transfer,
  particle FX tier 1/2, play-effect resolver / bursts, lifestone FX.
- Full JS gate (`capped-build node harness/run-js-headless.mjs`): **739 passed,
  0 failed**. `capped-build node test_particle_fx_tier2_gpu.cjs` (headless
  SwiftShader, 64x64, no world): **31/31** — the portal disc's new mood code
  compiles and a live and a dead portal disc draw in one program, no GL errors
  (its showcase case now uses real portal Setups).
- Release wasm built (`wasm-pack --release`, 7.56 MB) and installed in `pkg/`;
  the previous build is kept in `pkg-prev-20261017-preportal/`.
- `node ../../scripts/lint-url-flags.mjs`: 0 undocumented readers;
  `node scripts/gen-modulepreload.mjs --check`: up to date (426; the build-shell
  pin moved 402 → 405, one of the three being `scene3d/fx_clock.js`, which the
  3cd36d98 film commit added without a regen).
- **Needs a wasm rebuild** (`pkg/` is gitignored): `fetchSetupPartPose`,
  `ModelMesh.degradePartFrame`. A stale `pkg/` degrades both cleanly to the
  old behaviour.

## 5. Not done / follow-ups

- Instanced static LOD nodes (`buildInstancedNode`, only under
  `?walkInInstance=on` / the unused ring driver) sit at the map origin, so
  three.js picks their deepest band at any distance. Latent (opt-in path).
- The same-instance create rule is applied to portals only; retail applies it
  to every object (players / NPCs would need the motion / state arms).
- Building lights still map the LightInfo key to a building part (buildings
  are almost all raw GfxObjs with no lights).
- Spawn-time ground clamp only; a summoned Gateway lands at the caster's z.

## 6. Queued look checks (next 1070 session — owner-run or owner-requested)

Off-screen, muted, `?nosw=1`, fresh wasm. A/B by reloading with the escape.

1. **Holtburg town portal** (`@telepoi Holtburg`): stand 10 s — the purple
   ground pool holds still (no 4 s orbit, never under the terrain); walk 150 m
   away and back — the glow is there the moment the portal is. A/B
   `?lightObjectFrame=off` (the orbit returns).
2. **Walk up to a portal** until its base leaves the bottom of the screen and
   look up: the swirl never blinks out. `await __diag.portalEmitterState()` →
   `summary.falseCullSuspects === 0`. A/B `?rp6TrueSphere=off`.
3. **Every kind**: a coloured dungeon portal, a pillar portal (catacomb exit),
   a Destroyed Portal (Holtburg's), a summoned portal (Summon Primary Portal /
   a portal gem), the Town Network alcoves: disc at the swirl's height
   (1.57 m; pillar / destroyed 1.65 m), ring on the ground, no disc on gauntlet
   arches or bookcase portals, fades over 48-60 m with no pop; the destroyed
   portal reads as a dim dying ember with a faint light. A/B
   `?portalSetPiece=off`.
4. **Static portal decorations** (a portal-space hall, e.g. landblock 0x526B /
   0x0005): swirls 1.57 m up, not on the floor; each has its disc. A/B
   `?staticPartAnchor=off`.
5. **The sign class**: walk toward / away from props whose Setup lifts or turns
   the part (signs, lamp posts, fence pieces near Holtburg) across 20-55 m —
   no drop or slide at the band switch. A/B `?degradePose=off`.
6. Perf: `__fxShowcase.stats()` (`portals` ≤ 8), fps at the Town Network
   with the defaults vs all six escapes.
