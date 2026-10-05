# Visual checklist — one batched real-GPU session

Changes that pass every headless check but still need human eyes on a real GPU.
Work through them in one sitting; tick each box or note what looked wrong.
Start from the normal tunnel URL with `?nosw=1` (and `clouds=on` where noted).

## Animation
- [x] **Draw/sheathe:** toggle peace ↔ combat (melee, then magic). The draw/sheathe motion plays. Known gap: the very first toggle after spawning still snaps. — **2026-10-05 owner:** very good, but a slight frame freeze. Being fixed.
- [x] **Backwards walk:** hold S. The legs walk backwards instead of freezing on one frame. — **2026-10-05 owner:** perfect.
- [x] **Strafe:** hold Z / C (pure strafe). The legs sidestep, and left is the mirror of right. — **2026-10-05 owner:** perfect.
- [ ] **Walk + strafe diagonal:** note what plays. Retail behaviour here is still an open question.
- [x] **Stop:** run, release. The character returns to idle and doesn't keep running in place. — **2026-10-05 owner:** perfect, retail behaviour.
- [x] **Cast gesture:** cast a spell standing still, and again while moving. The hands-up/down gesture plays. — **2026-10-05 owner:** better, but needs more comparison with OpenAC. Being worked on.
- [x] **Melee:** attack a monster that starts out of reach. The first click swings once you arrive (no second click needed). — **2026-10-05 owner:** swing timing good for now.
- [ ] **Monsters:** running monsters keep their run cycle when they hit you, and don't snap to idle.
- [ ] **Start/stop transitions:** walk↔run↔stop now play their transition clip on the new playback system. Check that responsiveness feels right: an attack or cast pressed during a stop transition now waits for it, as in retail.
- [ ] **Swings on moved entities:** emotes and guessed swings on characters that have walked now play (they went to a dead mixer before).

- [x] **Doors and chests (mixer retired):** open, close, rapid toggle, and a door already open at spawn. Sounds play once, there's no snap-back to the spawn state, and nothing loops between open and closed. — **2026-10-05 owner:** REGRESSION: opens the wrong way, sticks into the building from outside, and projects ~1 m outward on second use. Being fixed.
- [ ] **Idle NPCs that never moved:** breathe on their idle cycle, and their fidgets and emotes play full-body.
- [ ] **Diagonal strafe** (W+D, S+A): feet speed matches, no frozen cycle.
- [ ] **Cast while strafing, and a fizzle mid-windup:** the gesture stops cleanly.
- [ ] **Swing spam:** gestures queue rather than cut each other off.
- [ ] **Jump** arms and legs, and **death collapse** holding into the corpse.
- [ ] **Teleport during an emote:** note whether it's cut. It currently isn't; retail cuts it.
## Sky / atmosphere (`clouds=on`)
- [x] **Clouds drift:** over ~30 s the clouds visibly move and don't loop back every second. — **2026-10-05 owner:** clouds look good.
- [ ] **Fog colour:** follows the horizon at dawn, noon and dusk (the async sky probe changed how it's read).
- [ ] **Swamp ground fog:** hides correctly behind buildings and terrain (now log-depth correct).
- [ ] **Clouds in the main pass (`&clouds=on&cloudsMainPass=on`, opt-in):** A/B against `&clouds=on` alone at noon and dusk. Clouds should look the same or better: same brightness and colour (now tone-mapped and aerial-perspective-hazed in the main chain), hidden behind hills and buildings, nothing painted over the world, no whole-screen dark tint. Walk into a cottage and back out: no clouds indoors and no hitch at the door. If the screen tints dark, try `__cloudOverlay.volume.effect.haze = false` in the console and note it. Read the console for shader compile errors in the post EffectPass.

## Terrain effects (opt-in families)
- [ ] `?terrainDirt=on` / `terrainSnow` / `terrainSand` / `terrainRock`: particles hide behind geometry (log-depth fix). Rock pebbles write depth, so check nothing they overlap is corrupted.

## Portals and interiors (`?punchRetail` is default-on)
- [x] **Interiors through open doors/windows** from outside look right (Holtburg cottages, Yaraq). — **2026-10-05 owner:** looks fine.
- [ ] **Occlusion:** a wall, tree or another building between you and a doorway hides the interior. No see-through.
- [x] **Grass in front of doorways** stays visible and isn't painted over by the interior. — **2026-10-05 owner:** grass blades are off by default (`&terrainGrass=on`), so this is not testable on the default URL.
- [x] **No black box** anywhere, including with anti-aliasing on (`msaa` default). — **2026-10-05 owner:** owner suspects a flickering green light in the distance (late July/early August 'bouncing lights'). Being investigated.
- [ ] **A/B:** if anything is off, compare with `&punchRetail=off`.
- [ ] **Black patches near town buildings (2026-10-05 history research):** at a black spot run `JSON.stringify(__diag.lights().bad)`, `__indoorDepthSplit`, `JSON.stringify(liveScene3d._portalPunchDiag)`. Then try one reload each with `&nanScrub=off`, `&sealLogDepth=off`, `&indoorDepthSplit=off`, `&punchRetail=off`, `&portalPunch=off`, `&msaa=off` and note which one changes it. `nanScrub` is now on by default, so if the patches are gone entirely, the cause was a non-finite shader value.
- [ ] **Indoor seal, retail order (default-on round 2, 2026-10-05; off-screen 1070, noon-pinned, `?nosw=1`):** run each shot twice, bare URL and `&sealLogDepth=off`, and record `JSON.stringify(liveScene3d._portalSealDiag)` + `JSON.stringify(__indoorDepthSplit)` beside each.
  - [ ] **S1 Holtburg cottage, looking out the front door from 2 m inside:** neighbour trees, the well/fountain, other houses and terrain show through the doorway with the same colours as outdoors; nothing from inside (furniture, other rooms) paints over them. `_portalSealDiag.source` = `pview-outside`, `kept` ≥ 1, `remainderDraws` climbing.
  - [ ] **S2 same doorway with an NPC or second character standing 5-10 m outside:** the character is visible through the door (it is drawn before the wall).
  - [ ] **S3 from the back of a two-room building, looking through the inner doorway at the far room's outside door:** outdoor scenery visible through both doorways; the far room's walls are intact around it.
  - [ ] **S4 standing in the doorway itself, then one step in:** no flicker or popping of the room or the scenery as the split arms (`__indoorDepthSplit.armed` flips to true).
  - [ ] **S5 dungeon (e.g. `@telepoi` to any mouthless dungeon, cell like 0x01D90100):** `_portalSealDiag.kept` = 0 and `remainderDraws` does not climb; the dungeon looks identical with and without `&sealLogDepth=off`.
  - [ ] **S6 haze through the doorway:** distant terrain seen through the door has noticeably LESS aerial-perspective haze with the bare URL than with `&sealLogDepth=off` (the old seal read as ~4 km, the new one as the wall distance). Note which looks closer to the same terrain seen from outdoors; the full fix (restore pre-wipe depth under the sealed pixels) is a proposed follow-up.
  - [ ] **S7 transparent shells:** a window or other see-through part of the cottage you are in does not look darker/more opaque than from outside (relayered content draws twice on these frames).
  - [ ] **S8 console:** no shader compile errors on `portal-seal`, no `[portal_punch] render error`.

## Spells / effects
- [x] **Projectiles:** no grey squares. If a spell now looks *missing*, note which one: that's a texture-load bug. — **2026-10-05 owner:** no grey squares. But bolt motion while moving, the trail particles, the light, and visibility along the whole path are all weaker than retail. Being worked on.
- [x] **Portal travel:** the loading curtain never sticks. It hides on arrival or after at most 8 s. — **2026-10-05 owner:** the curtain should go entirely (port OpenAC/retail portal space). Also: after portalling into a dungeon the player rig is invisible while monsters show. Being fixed.

## Remote motion
- [ ] **Remote jump arc** (needs a second character; `?remoteJumpArc` default on, wave 2 — the arc now lives in the wasm remote body): watch another player jump, standing and running, on flat ground, down a slope, and off a bridge or dock. The body rises and falls in a smooth parabola and lands where it came down — no snap back toward the take-off point, no linear rise then pop, no sink into or float above the terrain. The arms-up jump pose comes down on landing. A/B with `&remoteJumpArc=off`.

## Camera / movement feel
- [x] **Running "jut back" — fix landed:** the run cycle drew the body up to 3.25 m ahead of its real position and snapped it back every cycle (measured headless; now 0.18 m of normal bob). Confirm it's gone. If any jut remains, it's a different cause: reproduce with `&moveTelemetry=1`, then paste `__hbWasm.localPoseSnapDiag()` and `__hbWasm.leashEchoDiag()`. — **2026-10-05 owner:** massive improvement, no sign of the jut.
- [ ] **syncPhysicsTick pairing:** every load warns that `?posePublishPostTick` is off. Compare camera smoothness with `&posePublishPostTick=on` to decide whether to make it the default.

## Audio (2026-10-05 retail sound parity — ears only)
- [ ] **UI clicks:** clicking HUD buttons/inventory slots gives the retail UI click, at the same loudness wherever the character stands and whichever way the camera faces (it used to fade out away from the world origin). Moving the effects slider changes it.
- [ ] **Inventory sounds:** wield / unwield / pick up / drop play once (no double-play when the server echo arrives), from the character, at full volume (they used to be halved).
- [ ] **UI error / slider grab-release:** the "can't do that" buzz and slider clicks are centred and use the UI sound set.
- [ ] **Portal whoosh:** entering and leaving portal space plays the enter/exit whoosh, centred. `&portalSound=0x0A000246` still overrides the enter sound.
- [ ] **Server sounds (lifestone, doors, levers, spell sounds):** still heard; a creature's sound is quieter at range and silent beyond about 94 m. Sounds the server sends at volume 0 are now silent instead of loud.
- [ ] **Crowded fights:** with many monsters, spells and footsteps at once, sounds already playing are not cut off; extra sounds beyond 16 at once are dropped (retail's 16-voice limit). Listen for missing important cues.
- [ ] **Environment sounds (admin `@environ`/AdminEnvirons 101-123):** each plays centred; 117 is the squeal and 118-123 are thunder 1-6 (117-123 used to play the wrong sounds); 115 and 116 are silent.
- [ ] **A/B `&audioRetailPan=on`** (owner product call 2026-10-05: HRTF stays the default): retail's flat left/right stereo pan — no front/back or height cue, no pan within 5 m, fixed when the sound starts. Note whether anything sounds wrong compared with the HRTF default.
- [ ] **Terrain ambience (round 2, retail model):** walking from grassland toward water or forest, the background beds cross-fade gradually over ~100 m instead of switching at one spot; birds/crickets come from a direction and distance (not inside your head); the bed is re-triggered every few seconds rather than one endless loop (listen for a gap or a hard restart that sounds wrong). Indoors, outdoor ambience stops unless the room is open to the outside.
- [ ] **Ambient slider:** at 50 % the ambience is clearly quieter than effects at 50 % (retail applies the ambient slider twice).
- [ ] **Background tab:** switch to another tab during a fight — new sounds stop; sounds already playing finish; on return sound resumes. Off-screen ear tests need `&audioWhenInactive=on`.
- [ ] **Saved volumes:** set the volumes in Options → Audio, reload; the levels apply straight away without opening the Audio tab.
- [ ] **Fizzle / bolts (`playEffectSound` now default on):** force a fizzle → one sizzle (not two); Flame Bolt I → launch and impact sounds. A/B `&playEffectSound=off` is silent.
- [ ] **Late-arriving objects:** a door or monster sound sent just before the object appears now plays when it appears.
