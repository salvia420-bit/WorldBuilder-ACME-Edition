# HANDOFF — 1070 real-GPU pass over the 10-08..10-11 commits (2026-10-11 evening)

The owner asked for the 1070 priority list from the last three days of commits and then "work through
everything". This session drove the GTX 1070 off-screen and muted (Chrome 154, ANGLE D3D11, own profile under
`D:\Temp\hbbench\`), with CDP over `ssh -L 9333` and data through the laptop relay (:7093). Perf arms ran against a
frozen code snapshot (`hb-mksnap.sh`, served on :7091) so edits could continue. The owner was at the box from
~19:25 and asked to keep going; perf numbers were taken before that.

Scratch tools (not committed): `/mnt/wbterminal1/tmp/claude-scratch/1070-1011/` — `hb.mjs` (launch / goto with a
boot-time console ring / snap / burst / fps / chat), `bench.mjs` (interleaved fresh-profile A/B with a presence gate),
`wsdecode.mjs` (decodes the game WebSocket frames: 2-byte `#(`/`#)` prefix + AC packet + fragments + GameAction
sub-op), `glprobe-init.js`, `ladderprobe.js`, `corpsetest.js`, `npcface.js`, `FINDINGS.md`, all shots.

## 1. Fixed in this commit (each verified on the 1070 after the change)

| # | What the player saw | Cause | Fix |
|---|---|---|---|
| 1 | Terrain stuck on the blurry t128 tier on default boots since the far ring went default-on (10-08). The ladder reported `t1024, promotions 1, promoteFailures 0` | `far_terrain.js ensureBakeRig` clones the live terrain material; three r184's `cloneUniforms` gives every texture uniform a NEW Texture on the SAME Source. Once the bake drew, that clone held the WebGLTexture, so the ladder's in-place swap (`dispose` + re-spec) reused the old immutable storage: 22× `glCompressedTexSubImage3D` GL errors at the promotion | `shareLiveTextureUniforms` re-points the clone's texture uniforms at the live objects (render-target uniforms stay as before). 1070: GPU storage 128² / 8 levels → 1024² / 11 levels, 0 GL errors, crisp ground (`shots/terrain-before|after-ground.jpg`) |
| 2 | No torch, brazier or lifestone light pool on the ground (tier-1 `?terrainLights`) | `terrain_batch.js _buildBatchMaterial` value-copied every uniform; the FX light feed is three shared typed arrays rewritten in place and bound by identity, so the batch (the terrain that draws) froze its creation snapshot (no lights, the day gain) | the batch shares the three uniform objects. 1070: torch pool now drawn (`shots/night-mid-torch-ab.jpg`) |
| 3 | A melee charge (86c4d11e: ACE's charge replaces the client run-up) intermittently ended in "Action cancelled!" with no swing | `picking.js onSelectionCleared` read `ev.guid` from the bus CustomEvent (payload is `ev.detail`): every selection change counted as a clear and, in a combat stance, sent CancelAttack (since F6-4, 2026-06-10; the deleted run-up re-engage watch had masked it) | read `ev.detail` (as `target-bar.js` does). Wire capture after: 0 CancelAttack during charges, 4/4 clean charges killed |
| 4 | A selected object was rebuilt twice a second (a "Pumpkin Buffer" 11.5 m away: 20 LOD respawns / 10 s), feeding #3 | the spawn-time LOD pick read `lod_prewarm`'s 25 m-bucket memo while the T9 tick used the exact distance; near a band edge they disagreed forever | `_respawnForLod(inst, g, sub)` hands the tick's band to the spawn (`meta._lodForcedSub`, one-shot) and flags the selection release `lodRespawn`; picking ignores that clear. 1070: 0 respawns / 15 s |
| 5 | (spec) shockwave ring `pow(negative, 2.0)` | undefined in GLSL | squared by hand (`fx_distort_effect.js`); the showcase flare got the same fix (#6) |
| 6 | Owner: "a light shaft coming from the lifestone … instead add more of a glowing emanance and make the crystal look more lifelike" | — | `?lifestoneFx` (default on, `=off` = the 10-10 shaft + ring), built by an Opus agent in a sandbox and merged after its GPU smoke: owned crystal material (veins, a moving inner heart, fresnel rim, facet glints, breathing), an aura (showcase kind 4) with motes, one breathing FX light carrier, the crystal in the glow buffer at high/ultra; no shaft, no ring. Retail fact: the Holtburg stone (wcid 509, Setup 0x020002EE) has no emitters and no light; the crystal spins once per 4 s from its own animation. 1070: noon and night shots `shots/ls-new-*` |

Tests added / updated: `tests/far_bake_shared_textures.test.mjs` (4), `test_far_bake_shared_textures_gpu.{cjs,html}`
(SwiftShader BPTC repro, 6/6: a plain clone makes the swap fail with GL_INVALID_VALUE and keeps the old texels; the
fix reads the new ones), `test_terrain_batch.mjs` (+5, 56/56), `tests/lod_respawn_selection.test.mjs` (5),
`tests/held_ledger_wire_spawn.test.mjs` (source pin for the new respawn shape, 9/9), `test_lifestone_fx.mjs` (83),
`test_lifestone_fx_gpu.{cjs,html}` (15/15), `test_particle_fx_tier2.mjs` (102). GPU smokes re-run green: tier1 15/15,
tier2 30/30, lifestone 15/15, far-bake 6/6. Full JS gate (capped): see the commit message.

## 2. Verified on the 1070 (no change needed)

- **P0 smoke.** A bare URL boots the 1070 at `mid` (the GTX string is not in `GPU_HIGH_RE`), ultra with clouds boots too:
  0 errors, 0 exceptions; level-up and Explode drew without NaN specks at mid and ultra. Known noise: 256
  `glBlitFramebuffer` warnings per page (pre-existing).
- **Moons** (`skytime` night): banded brush clouds across the disc, no hollow ring / wash / seam, soft terminator, green
  city on the night side, blue aureole (`shots/moon-mid-night-alb-*`). At a 12° zoom the city glow is a little blocky.
- **Always daylight**: on at login pins noon; off → the real clock; forced night → on again pins noon in 125 ms.
- **Ragdoll → loot**: the server's corpse arrives ~1.1–1.4 s after death; from then the tumbling rig picks as its
  corpse; the body settles ~4.3 s after death (drawn parts).
- **Weapons**: the Slash greatsword reads as steel (no white wash), no aura, never bends; idle spear bend ≤ 0.07°.
- **War bolts**: ribbons per element; impact shell + round soft ground ring, no squares.
- **NPC turn** (#4): the grocer used from behind/east ends within 0.7–7.4° of square (the 90° bug is gone).

## 3. Bench (ultra 1920×1013, adaptiveRes off, skytime=12, Holtburg orbit 70 m; n≈2, ultra-all n=1)

| arm | still fps / ms | moving fps / ms | draws | first turn fps / jank s / frames >100 ms |
|---|---|---|---|---|
| bare-legacy (mid, new FX off) | 34.6 / 28.9 | 34.1 / 29.3 | 1547 | 37.8 / 1.1 / 1 |
| bare (mid, the default) | 32.5 / 30.8 | 31.7 / 31.5 | 1573 | 30.9 / 1.9 / 6 |
| ultra-legacy | 26.7 / 37.5 | 17.1 / 58.5 | 1827 | 13.8 / 5.7 / 15.5 |
| ultra-t1off | 25.9 / 38.6 | 15.8 / 63.3 | 1825 | 8.8 / 8.2 / 34.5 |
| ultra-t2off | 25.8 / 38.8 | 15.9 / 62.9 | 1869 | 10.0 / 7.5 / 35.5 |
| ultra-all | 25.2 / 39.7 | 15.3 / 65.4 | 1885 | 8.4 / 8.4 / 37 |

The 10-10/10-11 FX cost ~2 ms at mid and ~2 ms still / 5–7 ms moving at ultra, and roughly double the first-turn
hitching (FX programs compile on first sight — prewarming them during the login tunnel is the obvious lever). Ultra
in motion is ~16 fps even with every new FX off: the cost there is clouds / grass / SSAO / CSM, not this work.

## 4. Open findings (not fixed)

1. **Spear bend while running** (fixed in §6, `?weaponFlexLoco`; 1070 2026-10-12: mean 0.81°) was ~10× the design: mean 4.8°, max 6.8° at 17.5 m/s (the run animation's arm swing
   drives the spring; design said ~0.5° at a run). Tune `__weaponFx.flexGain` or high-pass the hand motion.
2. **Flaming weapons leave a metres-long trail of big fire puffs** when running fast (same with `__particleFx(false)`;
   the emitter is world-space). Retail-like physics, but loud at god-mode speeds; consider a held-weapon emission cap.
3. **Every war bolt leaves the same orange shell + tan ring** (element marks fixed in §6, `?fxImpactElement`; 1070-verified) (ACE only sends Explode; known). The ring reads as sand,
   not char, in daylight.
4. **The vendor turn snaps** (STILL OPEN: the §6 attempt, `?remoteSpineHeading`, made it worse on the 1070 and is opt-in) (one-frame 102° jump at ~0.7 s, then a 6° correction) instead of turning at the table rate.
5. **A teleport tunnel stuck in state 4 "cells-ready" for 4+ min** after a 3 m `@teleloc` in a `?remoteSpine=off`
   session: `__portalSpace.clock` stayed 0 (the tick never advanced), uses were dropped. Not reproduced with defaults.
6. Two `@create`d shreths at `0xA9B40029 [127 7 95.06]` never reached the client (no ObjectCreate in the wasm).
7. `[far_terrain] RADIUS POLICY VIOLATION` console.error after every teleport tour (eviction lag vs a +1 hysteresis).
8. Weapon auras also land on armor with a Magical UiEffects bit; a "Lightning Nodachi" with a Magical bit glows violet.
9. Pre-existing warnings: `THREE.Texture: Unable to serialize Texture` (Material.copy JSON-clones userData holding
   textures); `UniformsUtils: … cannot be cloned` (the bake clone nulls a render-target uniform — left as before).
10. Owner checks still owed: casting feel (lock-and-revive taps), slowdown (`__diag.slowRun` showed only `collision`
    while pressed against a mob), terrain hop. The scripted kit (`mv.js`, `scen.js`) is ready.

## 5. Not reached this session

P2 at ultra (portal set piece, ambient fields, dungeon / volcano / snow / forest), the OpenAC items that
block code (streaming-teleport-1, camera-1/6, held-1, daytime-2, charopt-5, createobj-2/3/4), the 10-06 flip checks
(`partDegrade`, `cellStaticMerge`, `particleSharedAlpha`, `lightLoops` 3-rep), and the second ultra-all bench rep.

Presence: the watcher reported PRESENT at 18:18 and 18:37 while the owner says nobody was there (idle resets with no
browser of theirs). This session ran its watcher log-only after the owner's word.

## 6. After the commit (`9665230d`): cold-load on the SSD copy, three fixes

The session kept going after the push. It measured the cold loads on the 1070, then stopped before applying the three
fixes it had prepared. A follow-up session on the laptop applied, tested and committed them. They were then checked on the 1070 (2026-10-12, table below): two are fixed, and the vendor-turn one made things worse and is now opt-in.

**Cold load against the SSD-served data** (the 10-09 USB-disk runs, §4.31 of `HANDOFF-charselect-coldload-2026-10-09.md`,
are the comparison). The owner was using the PC during these runs, so the timings are noisy (n = 3). Run JSONs and logs:
`/mnt/wbterminal1/tmp/claude-scratch/1070-1011/runs/coldload/`.

| Academy, after in-world (`academy.mjs --workerspy`) | ssd1 | ssd2 | ssd3 | 10-09 USB (f4s / f5s / f6s) |
|---|---|---|---|---|
| walls (568 cells attached) | 9.9 s | 7.5 s | 22.1 s | 8.6 / 7.9 / 8.2 s |
| furnished (559 statics attached) | 27.4 s | 15.2 s | 26.7 s | 22.5 / 23.6 / 21.8 s |
| statics after the walls | +17.5 s | +7.7 s | +4.6 s | ~+14 s |
| textures done (run clock) | 32.4 s | 26.7 s | 33.8 s | — |

Only ssd2 shows the gain the SSD copy was meant to bring (furnished 15.2 s). ssd1 is slower than on the USB disk, and
ssd3 is an outlier in its walls (portal tunnel ready at 29.1 s). Treat the SSD effect as **not yet shown**; re-run when
the 1070 is idle.

- **Town Network** (`townnet.mjs tnssd1`, from Holtburg): walls 4.6 s after the teleport, first cells 7.4 s, nothing
  pending 8.6 s (10-09 final build: walls 4.0 / 5.0 s). HD textures 67 MB in the walls window, 197 MB over the run;
  the slowest in-view texture took 9.1 s.
- **Warm-up wizard** (`wizwarm.mjs wiz60ssd`, Create Character open 60 s): Enter → in-world and cells in 1.9 s (10-09: 2.1 s).

**The three fixes, and what the 1070 showed** (2026-10-12, off-screen and muted, `watch1070.sh` AWAY throughout; rows in
`docs/url-flags.md`):

| Finding | Cause | Change | 1070 result |
|---|---|---|---|
| §4 item 1, spear over-bend at a run | The run cycle's arm swing drives the pole springs near their 2–3 Hz natural frequency | `?weaponFlexLoco` (default on): full gain for 1.6 s after a swing, then a 0.5 s ramp down to `?weaponFlexLocoGain` (0.12), followed with a 60 ms time constant so a swing started at a run does not pop. Test: `test_weapon_fx.mjs` (+6) | **Fixed.** Flaming Spear at a 17.5 m/s forward run: mean 0.81°, max 1.38° (was 4.82° / 6.84°); backward 0.39° (was 1.29°) |
| §4 item 3, one mark for every element | ACE plays **Explode** for a war bolt's impact, and the Explode cue's mark was a fixed orange scorch. (The session's own diagnosis, a failed element lookup, was only half of it: the lookup now works, but Explode never asked for the element.) | `?fxImpactElement` (default on): the bolt sampler remembers each projectile's element for 5 s, and the Explode mark is `byElement` (`vfx/fx_cues.js`). Tests: `test_particle_fx_tier2.mjs` (+5) | **Fixed.** Flame → fire scorch, frost → frost, acid → acid, lightning → a pale-blue scorch (before: four identical orange scorches) |
| §4 item 4, vendor turn snaps | Spine rows carry the Rust body's rotation but `drainRemotePoses` drops it on non-sticky rows | `?remoteSpineHeading`, now **opt-in (`=on`)**. Test: `tests/remote_spine_heading.test.mjs` | **Made it worse; default off.** The Rust body's heading is stale at rest (not synced to the server's UpdatePosition heading) and each row overwrote the JS heading target: the grocer's first row snapped ~96° and it ended 87° away from the player. Default: 0° off from all four sides, smooth in two uses, snaps (178°, 90°) in two. Real fix: the Rust `RemoteMover` adopting the server's heading at rest (url-flags §0) |

Also checked on the 1070: "Disable distance fog" and "Disable most weather effects" (owner-bugs handoff): during a storm
DayGroup, both on → fog band 10,000 km, storm off; both off → fog 1012–1550 m, storm on (options restored). Console:
0 errors, 0 exceptions over the session.

