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

## Terrain effects (opt-in families)
- [ ] `?terrainDirt=on` / `terrainSnow` / `terrainSand` / `terrainRock`: particles hide behind geometry (log-depth fix). Rock pebbles write depth, so check nothing they overlap is corrupted.

## Portals and interiors (`?punchRetail` is default-on)
- [x] **Interiors through open doors/windows** from outside look right (Holtburg cottages, Yaraq). — **2026-10-05 owner:** looks fine.
- [ ] **Occlusion:** a wall, tree or another building between you and a doorway hides the interior. No see-through.
- [x] **Grass in front of doorways** stays visible and isn't painted over by the interior. — **2026-10-05 owner:** grass blades are off by default (`&terrainGrass=on`), so this is not testable on the default URL.
- [x] **No black box** anywhere, including with anti-aliasing on (`msaa` default). — **2026-10-05 owner:** owner suspects a flickering green light in the distance (late July/early August 'bouncing lights'). Being investigated.
- [ ] **A/B:** if anything is off, compare with `&punchRetail=off`.
- [ ] **Black patches near town buildings (2026-10-05 history research):** at a black spot run `JSON.stringify(__diag.lights().bad)`, `__indoorDepthSplit`, `JSON.stringify(liveScene3d._portalPunchDiag)`. Then try one reload each with `&nanScrub=off`, `&sealLogDepth=on`, `&indoorDepthSplit=off`, `&punchRetail=off`, `&portalPunch=off`, `&msaa=off` and note which one changes it. `nanScrub` is now on by default, so if the patches are gone entirely, the cause was a non-finite shader value.
- [ ] **Indoor seal:** standing inside, compare `&sealLogDepth=on` against the bare URL at a doorway. Outdoor particles and terrain seen through the door should sort correctly with `=on`.

## Spells / effects
- [x] **Projectiles:** no grey squares. If a spell now looks *missing*, note which one: that's a texture-load bug. — **2026-10-05 owner:** no grey squares. But bolt motion while moving, the trail particles, the light, and visibility along the whole path are all weaker than retail. Being worked on.
- [x] **Portal travel:** the loading curtain never sticks. It hides on arrival or after at most 8 s. — **2026-10-05 owner:** the curtain should go entirely (port OpenAC/retail portal space). Also: after portalling into a dungeon the player rig is invisible while monsters show. Being fixed.

## Remote motion
- [ ] **Remote jump arc** (needs a second character; `?remoteJumpArc` default on): watch another player jump, standing and running, on flat ground and down a slope. The body rises and falls in a smooth parabola and lands on the ground, with no linear rise followed by a pop, and no sink into or float above the terrain at landing. A/B with `&remoteJumpArc=off`. Note: the arms-up jump pose can stay up for several seconds after landing; that is a known, separate animation issue.

## Camera / movement feel
- [x] **Running "jut back" — fix landed:** the run cycle drew the body up to 3.25 m ahead of its real position and snapped it back every cycle (measured headless; now 0.18 m of normal bob). Confirm it's gone. If any jut remains, it's a different cause: reproduce with `&moveTelemetry=1`, then paste `__hbWasm.localPoseSnapDiag()` and `__hbWasm.leashEchoDiag()`. — **2026-10-05 owner:** massive improvement, no sign of the jut.
- [ ] **syncPhysicsTick pairing:** every load warns that `?posePublishPostTick` is off. Compare camera smoothness with `&posePublishPostTick=on` to decide whether to make it the default.
