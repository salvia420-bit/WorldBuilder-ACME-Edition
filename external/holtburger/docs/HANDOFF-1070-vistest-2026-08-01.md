# HANDOFF — 1070 in-person vistest session (2026-08-01)

Owner is AT the 1070. Everything below is on `origin/master` and being served
LIVE from the laptop — no build step, no tunnels needed. Laptop tailscale IP:
`100.116.47.66`. ACE is up (UDP 9000), wsbridge up (0.0.0.0:8080).

## 0. Quickstart (box browser, on-screen is fine — you're the user)

Two serve arms, both bind-all (started this session; if dead, laptop:
`python3 scripts/serve.py --port 8766 --bind 0.0.0.0` from external/holtburger,
and the BC7 one from /mnt/wbterminal2/bc7-webroot with
`HOLTBURGER_DIST=/mnt/wbterminal2/holtburger-dist-hires-bc7m ... --port 8769`):

- **Live-source arm:**
  `http://100.116.47.66:8766/apps/holtburger-web/index.html?nosw=1&bridge_url=ws://100.116.47.66:8080/&autoLogin=1&account=smoketest1&password=smoketest1&autoSpawn=first`
- **BC7 look arm (colour/tuning judgements happen HERE):** same URL on **:8769**
  plus `&texBc7=on&terrainBc7=on`.

`?nosw=1` on EVERY URL (SW cache survives restarts). smoketest1 = accessLevel 5
(`@telepoi <POI|list>`, `@teleloc <cell> <x> <y> <z>`). Single-login: wait ~25 s
between reconnects or both sessions get booted. Console = F12; helpers attach at
`__bootState==='ready'` (NOT 'in-world'). Weather: `__setWeather({is_storm:false})`;
day: `?skytime=accel`. Indoor test cell (Holtburg building interior):
`@teleloc 0xA9B40127 54.14 136.12 66.005`.

If you'd rather have the laptop Claude drive probes while you watch: power the
box, start its chrome normally, and just tell the session "box is up" — the CDP
recipes and the ready-made driver
(`scripts/perf-worker/indoor-outdoor-fps.cjs`) are staged.

## 1. What landed TODAY (all pushed) — i.e. what's new to look at

1. **Mage cast fixes** (`148141f8..73425922`): local cast gesture survives
   strafe (`?castOverlayGuard` now default-ON); the never-executed
   `?multiAction`/`?castAxes` drains now run (remote wind-ups + remote strafe
   footwork); level-8 wind-up chain pinned by tests.
2. **flameFlicker actually ON at bare default** (was silently dead);
   bloom luminance prepass at half res; dead sky depth blit removed; wasm pose
   leak plugged (camera sites); `hero` checkbox removed.
3. **Statics atlas per-layer uploads** (walk-stall fix — 16-32 MiB per-LB
   re-upload → per-layer).
4. **Residency fixes** (earlier today): animated scenery survives warm-park
   (trees no longer vanish from revisited LBs); park-pool per-frame scan gone.
5. **All 7 terrain-VFX families code-complete, ship-OFF** (waves 2–4A).

## 1b. Landed LATER the same day (afternoon session, all pushed) — deltas to
##     the lists below. Live-source arm (:8766) picks these up on a `?nosw=1`
##     reload; the BC7 arm (:8769) serves a separate webroot and does NOT.
##     The local pkg/ wasm was rebuilt --release (5.5 MB, scarab fix included).

1. **Multi-scarab wind-up order FIXED** (`crates/holtburger-world` +
   `lib.rs`): §A6 below should now show **first→last** raises (was
   last-first; the main path claimed the newest-sequence scarab). Pinned by
   3 Rust tests; single-action motions bit-identical. If §A6 still shows
   last-first, the wasm is stale — reload with `?nosw=1`.
2. **`?shaderPrewarm=on` + `?linkProbe=on`** (ship-OFF): every shader warm
   was compiling the CANVAS program variant; the composer path uses the RT
   variant — the 43 mid-walk 172-849 ms links are those re-links. Adds a
   §E item: run `walk-stall-attrib.mjs` baseline with `&linkProbe=on`, then
   the same walk `+&shaderPrewarm=on`; score = `__linkProbe.summary()`
   LINK_STATUS forced-wait ms + longTasks. Win → flip default-ON. Cold-load
   ~22 s freeze should also collapse under the flag.
3. **Terrain-VFX promotion is now ONE LINE per family**
   (`quality.js::TERRAIN_VFX_PROMOTED` switchboard, gate × {high,ultra}
   ladder): when a §D family passes, say so — the laptop session flips one
   boolean. Trail auto-implies when a writer family (grass stomp / snow
   prints / mud prints) is on (explicit `&terrainTrail=off` still wins),
   and fades resolve per-family automatically (snow 300 s, mud 30 s,
   longest-wins co-tenancy). The §D recipes below still work unchanged;
   `&terrainTrail=on` in them is now redundant but harmless. New caveat for
   §D judging: the family eye-test arm now INCLUDES its implied trail RT —
   that is what will ship.
4. **`?statGeomDedup=on`** (ship-OFF): content-key geometry dedup inside
   the persistent 3×3-LB statics buckets (census: 17,774 instances over
   324 distinct geometries). Adds a §E item: pinned pose, A/B via
   `__statBatchXStats()` (Σgids vs ΣdedupGids, ΣusedVerts) +
   `renderer.info.memory.geometries`; `_multiDrawCount` must be UNCHANGED.
   Memory/upload/bake-CPU win only — the range-merge stays gated on §E.1.
5. **Canvas MSAA no longer requested at mid+** (it only multisampled the
   canvas, which draws nothing but fullscreen quads; composer RTs were
   never multisampled). Adds one §B glance: edges at mid+ should look
   IDENTICAL to yesterday; `?canvasMsaa=on` restores the old request if
   anything looks aliased.
6. **`?stableDepthShare=on`** (ship-OFF): drops the duplicate bespoke depth
   texture and feeds cloud/fog pmndrs' stable blitted copy — which also
   removes the ground-fog read-while-attached feedback hazard. §D P6 (the
   fog depth-read adjudication) should be run with this flag OFF and ON —
   it is the deciding evidence for which depth source ships.
7. Housekeeping (no eye-test needed): 1K-atlas tier now follows the
   RESOLVED quality preset (gpu-probe high boots were stuck at 512 — the
   1070 resolves mid, so invisible there); dead `shadows` preset key
   removed; `retailSun`/`terrainGouraud` documented. Five new node suites
   pin all of today: shader_prewarm 32 · synthesis4_leftovers 16 ·
   terrain_vfx_promotion 100 · stat_geom_dedup 40 · quality_preset 32
   (was stale-red since the 07-30 pom flip).

## 2. Vistest list, in priority order

### A. Mage combat (the thing you asked for) — live-source arm, Magic stance
1. Cast a **level-8 war Incantation while HOLDING STRAFE**: arms stay up
   through the wind-up while legs sidestep, then the cast gesture — **two
   raises total**. Zero console errors.
2. Same cast holding W (run): gesture rides over the run. A **W tap**
   mid-wind-up still cuts the gesture and the spell still fires (retail
   fastcast — intended).
3. After a cast that started while walking: **legs must keep animating**
   (the ordering fix; pre-fix they froze).
4. `&castOverlayGuard=off`: reproduce the OLD strafe-break (rollback proof).
5. Second client (tailnet1) watching you: remote perception unchanged.
6. You watching the second client cast a **multi-scarab** spell (4-wind-up
   ring/self): expect one raise per scarab now (order may be last-first —
   known Rust follow-up). Remote strafe footwork should render.
7. `&multiAction=off&castAxes=off`: falls back to exactly the old behaviour.

### B. Quick default-boot checks (bare URL, no flags beyond quickstart)
- Braziers/torches **flicker** now (that's the fix, not a bug);
  `&flameFlicker=off` to compare.
- Bloom: one glance at sun/lava/lit windows — should look unchanged.
- Trees: run 2+ LBs away and back — swaying trees must still be there
  (anim-scenery park fix).
- Settings panel: "Hero models" checkbox gone (intended).

### C. The FPS task (indoor vs outdoor + ring pullback)
1. Indoor: `@teleloc 0xA9B40127 54.14 136.12 66.005`, let it settle ~1 min,
   note fps (F12: `renderer.info` via `window.liveScene3d`; or just the feel).
2. Outdoor: `@telepoi Holtburg`, settle until streaming quiets (several min
   first time), note fps.
3. Sweep: reload with `&pvsRingRadius=4`, then `=3`, then `=2` (default is 5 =
   11×11). Judge: fps vs how bad the nearer horizon looks. `&horizonFade=on`
   softens the edge (live-tune `__horizonFade.start/.end` in console —
   CAUTION: it's GPU-unvalidated and may band at a wrong distance; that's a
   known suspected bug, just note it).
4. Tell the laptop session the winning radius → it ships the new default.
   (Walking smoothness should ALSO already be better from fixes 3/4 — judge
   hitches-while-running separately from steady fps.)

### D. Terrain-VFX eye-test batch (BC7 arm :8769) — the big queue
Full per-item scripts live in `TRACK-terrain-vfx-2026-08-01.md` + wave
handoffs (`HANDOFF-terrain-vfx-wave{1,2,3}-*.md` §4/§5 + agent checklists).
Short form — one boot per family, all `&quality=high` unless noted:
- **W1/W2 water** (sheen streaks real? code-22 flows?), **G1 grass**
  (`&terrainGrass=on&terrainTrail=on&terrainGrassStomp=on`),
  **S1 sand** (`&terrainSand=on`, needs a desert).
- **N1–N10 snow/ice** (`&terrainSnow=on&terrainSnowSparkle=on…` + `&terrainIce=on`
  on codes 2/27) — sparkle must twinkle with CAMERA motion; prints test at
  `&terrainSnowPrints=on&terrainTrail=on&terrainTrailFade=300`.
- **V1–V7 volcano** (`&terrainVolcano=on&terrainHaze=on&terrainCrackGlow=on&terrainEmbers=on`)
  — haze must never warp sky/foreground; `__heatHaze.strength` live-tunes.
- **P1–P10 swamp** (`&terrainSwamp=on…`) — P6 = the fog depth-read adjudication.
- **D1–D9 dirt/mud** (`&terrainDirt=on&terrainFootfall=on…`) — puffs at night
  must not glow; rain print depth test.
- **R1–R9 rock** (`&terrainRock=on`) — pebbles grounded + hash-stable;
  olthoi glow on code 30.
If a family looks right, say so → laptop session flips its high/ultra preset
defaults ON (with `terrainTrail` + fade caveats already documented).

### E. If the laptop session gets to drive (needs box chrome + a "box is up")
1. **Statics ceiling probe** (one page load, pre-registered decision rule) —
   `PERF-SYNTHESIS-bigwin-2026-08-01.md` §3.
2. **walk-stall-attrib re-run** (is it still shader links? → loading-screen
   prewarm decision) — synthesis §1.
3. Pinned-pose frame re-base + `__atlasStats()` before/after a walk.
4. Residency live checks: `__landblockLru.getStats()` +
   `animatedSceneryDiag()` across park/unpark.

## 3. Fallback / hygiene
- If a page misbehaves: full reload with `?nosw=1` FIRST before debugging.
- ACE alive check (laptop): `ss -ulpn | grep 9000`; restart recipe in
  memory/ace-live.md. Serve logs: scratchpad serve-8766/8769.log.
- The laptop session this doc came from is still open — anything found, just
  tell it; it has full context on every item above.
