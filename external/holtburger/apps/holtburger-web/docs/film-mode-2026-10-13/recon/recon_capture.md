# VIDEO CAPTURE, FRAME STEPPING, HEADLESS CHROME DRIVING (holtburger-web film mode)
Verified map, all read in code. Paths are relative to HB=external/holtburger/apps/holtburger-web unless given in full. PW = /home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules.

Q1. How scripts connect to Chrome
- Every in-repo driver uses Playwright. No in-repo script speaks raw CDP over its own WebSocket.
- playwright and playwright-core 1.59.1 exist only in the npx cache PW. HB/package.json devDeps are only three, postprocessing and takram.
- HB/node_modules/playwright-core is a symlink into PW. So an ESM `import {chromium} from "playwright-core"` only resolves for scripts under apps/holtburger-web (vistest-1070-round1-7.mjs:25, moving-bench.mjs:449, flag-census/bootab.mjs:9). ESM ignores NODE_PATH (fleet-runbooks:49).
- Scripts elsewhere load it differently:
  - createRequire with the absolute PW path: scripts/perf-worker/hbprobe.mjs:15, coldboot/*.mjs, flag-bench.mjs (env PLAYWRIGHT_CORE).
  - Absolute ESM import: cmdinterp-1070.mjs:5.
  - CJS `require("playwright")` with a PLAYWRIGHT_CACHE fallback: capture_canvas_video.cjs:18-24. harness/lib/boot.mjs loadChromium() (:90-111) also falls back to playwright-core.
- Two connection modes exist:
  - **launch (laptop):** boot.mjs:203-227 starts headless `--use-gl=swiftshader` with anti-throttle flags and `--enable-precise-memory-info`, viewport 1280x1024, holding heavy_lock until close.
  - **connectOverCDP('http://127.0.0.1:9333') (1070):** reached through `ssh -fN -L 9333:127.0.0.1:9333 young@100.127.215.75`.
- Raw-CDP clients existed only in session scratchpads (cdp_eval.cjs/.py: GET /json → page ws → Runtime.evaluate awaitPromise, per memory stream-soak-runbook.md:21). Node v20.20.2 has no global WebSocket unless run with --experimental-websocket (checked); fetch is global.
- Raw CDP inside the repo goes through `ctx.newCDPSession(page)`: Profiler in hbprobe.mjs:280, Page.startScreencast in scripts/visual-regression/capture-all.cjs:337.
- Reusable connection layers:
  - **scripts/perf-worker/coldboot/pw1070/playwright.js.** Used with NODE_PATH=that dir. Its `chromium.launch()` runs gate1070.sh, ensures the -L 9333 tunnel, starts a fresh-profile test Chrome via the schtasks 'hbprobe' task, then connectOverCDP. It rewrites http://127.0.0.1:8765 to the laptop tailnet front http://100.116.47.66:7080 (scripts/proxy.cjs: serve.py plus /wsbridge) and adds bridge_url/server_host/server_port/nosw. close() closes only its own pages.
  - **coldboot/sess.mjs** boots a persistent session. Separate tiny clients then drive it: probe.mjs, shot.mjs, camset.mjs, teleshot.mjs, enterchar.mjs, click.mjs. Each finds the page by url.includes('holtburger-web').
- Box launch is box/hbprobe-launch.bat:10:
  - Flags: `--remote-debugging-port=9333 --use-angle=d3d11 --ignore-gpu-blocklist --mute-audio --user-data-dir=D:\Temp\hbbench\%PROF% --window-position=-32000,-32000 --window-size=%WS%`, plus `--disable-features=CalculateNativeWinOcclusion` and the background/renderer-backgrounding flags. Window size comes from winsize.txt (default 1280,720).
  - It must run in the INTERACTIVE session via schtasks /it; SSH-launched Chrome has no GL.
  - hbgate.ps1 refuses to launch while a person is present. Cleanup is hbbench-kill.ps1, which matches the profile dir only.

Q2. Boot recipe
- Canonical URLs:
  - moving-bench buildUrl (:198-210): `index.html?nosw=1&quality=mid&adaptiveRes=off&renderScale=1&renderDiag=on&camDebug=on&vfxGauge=on&autoLogin=1&account=A&password=A&autoSpawn=first&agent=1[&renderOnDemand=1&netDrainHz=30]`.
  - hbprobe :222 is similar, with camDebug=on and adaptiveRes=off.
  - sess.mjs:29 goes through the relay/front with `bridge_url=ws://100.116.47.66:7093/wsbridge&server_host=127.0.0.1&server_port=9000`.
- agent=1 or autoLogin=1 adds html.agent-mode (index.html:611), and the canvas fills the viewport (CSS :456-516).
- Since 2026-10-05, `hb-*` HUD roots are EXEMPT from agent-mode hiding (:474-484). Only `?hud=none` (:614, CSS :527-539) strips them. hud=none also forces sprite nameplates off; they are default OFF anyway (scene3d/nameplate_sprite.js:311-320).
- Boot state machine (index.html:4265-4281):
  - Surfaces: `__bootState`, `__bootStateHistory` as [{state,message,ts}], a `holtburger:state` CustomEvent, and console `[boot-state] X`.
  - Order: init → form-shown → connecting → kicking → reconnecting → char-list-ready → spawning → in-world.
  - 'ready' means the atmosphere composer is wired (scene3d/index.js:6288-6292; the wire-agent variants are at :5800 and :7694). It can arrive before or after in-world. `__sceneReadyEverFired` latches it.
- Gates in use:
  - **boot.mjs (nullRender protocol only):** in-world (scalar or history) plus getLocalPlayerPose()!=null; never gates on 'ready'.
  - **vistest:** waits for 'ready' (atmosphere and `__set*` helpers attach after in-world), then 8 s.
  - **moving-bench classifyBoot (:246-266):** go on in-world, ready or sceneReadyEverFired. A later ready-watchdog 'error' is ignored. A pre-in-world error triggers `window.__runAutonomousLogin({autoSpawn:'first',maxRetries:1})` after a 9 s cooldown. Defaults in app/auto_login.js:87-130 are maxRetries 0, connect 25 s, spawn 20 s.
  - **sess.mjs:35-43:** liveScene3d && __sessionHandle && __sceneReadyEverFired && terrainBakedLbs.size>=9, then `__isPortalSpaceActive()===false`. The login tunnel can hide the world AFTER in-world; it is skipped by agent=1, bot, nullRender, renderOnDemand, wireframe, loginPortalSpace=off and portalSpace=off (scene3d/portal_space.js:187-205).
  - **cmdinterp:** in-world or ready, then scene mesh count >100.
- Settle check: hbprobe settle() waits until `__landblockLru.entries.size|renderer.info.memory.geometries` is unchanged for 12 s.
- Measured on the 1070, 2026-10-06, mid, fresh profile: boot to ready 8.4-11.2 s. The settle after `@teleloc Holtburg` took 98.6 s (flagbench-r1 summary).
- window.liveScene3d is assigned at the end of init3D (scene3d/index.js:4420); poll for non-null.
- Accounts:
  - tailnet1 is Developer, but on the 1070 it is the HUMAN's account; moving-bench.mjs:111 says use a bot such as agentp07.
  - phase4demo is the spare.
  - Passwords: see the repo harness scripts (deliberately not copied here).
- Single-login gaps in use:
  - 26 s (vistest:151).
  - 65 s after an abrupt close (boot.mjs:49-61: the WS↔UDP bridge never says goodbye, so ACE waits for its 60 s network-timeout reap).
  - 90-100 s (cmdinterp).
  - Tailing ACE_Log.txt for `[LOGOUT] Account X` (hbprobe:60-79).
- Since 2026-10-09, `SessionHandle.disconnect()` sends DISCONNECT 0x8000 so a reload can log straight back in. The pagehide handler (index.html:4369-4385) does it best-effort; call it explicitly and wait about 400 ms.

Q3. Recording
- The renderer is created at scene3d/index.js:1159-1163: `new THREE.WebGLRenderer({canvas, antialias: q.antialias && (wireframe||canvasMsaa), logarithmicDepthBuffer:true})`. So preserveDrawingBuffer is false; no override exists anywhere in scene3d.
- The final image IS drawn to the default framebuffer: with the composer active, the canvas receives only fullscreen quads (:1131-1136). Per frame:
  1. atmospherePipeline.render(cam,dt): pmndrs EffectComposer, HalfFloat render targets plus MSAA, last pass to screen (atmosphere_pipeline.js:939-969, 2131-2163).
  2. cloudOverlay.renderOverlay: setRenderTarget(null) then render.
  3. renderPortalSpaceOverlay (index.js:2763-2788).
- Before 'ready' (atmosphere bake about 8 s on the 1070), or with atmosphere=off or wireframe, the direct path renders a different look (:2795-2811).
- **capture_canvas_video.cjs is the only recorder, and it is stale:**
  - It records captureStream(30) into MediaRecorder (vp9 → vp8 → webm fallback, 8 Mbps, 1 s timeslice) collecting `window.__recChunks` (:216-282).
  - It exports through an `<a download>` blob click, `page.waitForEvent('download')` and `dl.saveAs` (:314-327), because big blobs don't fit through evaluate.
  - It logs in through the form and pins/hides the DOM.
  - It runs `setInterval(renderer.render(scene,cam),33)`, which BYPASSES the composer (wrong look, flicker).
  - It pitches the camera with lookAt straight up, which is degenerate.
  - It must run headed (headless gave a blank 77 KB webm), and it notes that an off-screen canvas produces empty captureStream frames.
- **Proven HUD-free still frame (shot/camset/teleshot/academy/townnet):** wrap liveScene3d.renderer.render; after each call where getRenderTarget()===null, call canvas.toDataURL inside the same task. Resolve after 3 rAFs or 4 s, then restore. Cost on the 1070 is 20-60 ms of main thread per 1280x633 JPEG (academy.mjs:13-14); a 1280x633 PNG is about 0.95 MB.
- **page.screenshot (Page.captureScreenshot) is unreliable for WebGL.** It returned a stale near-black frame for over 10 min on the 1070 (capture-all.cjs:310-335), and was black on the T4. It also includes DOM HUD.
- **Page.startScreencast** (png, everyNthFrame:1, ack each frame; capture-all.cjs:337-364) returns presented frames. It includes the DOM, is base64 and is not deterministic: good for preview only.
- **Stepping already exists:**
  - ?renderOnDemand=1 (index.js:972-985) makes scheduleNext return without re-arming (:2407).
  - `window.__renderOnce()` calls tick(performance.now()) (:3007-3017).
  - moving_rig.step() (:176-187) calls __renderOnce, awaits a rAF, then up to 3 more rAFs until `__diag.vfxGauge.frames` moves. This is needed because ?syncPhysicsTick is DEFAULT ON (index.js:1091-1097, `!== "off"`), which makes tick async, so __renderOnce returns before the frame renders (:3002-3006).
  - Pair it with ?netDrainHz=30, a setInterval tickPerFrame that keeps net, PVS, streaming and entity drain running (:3031-3067). Without netDrainHz, the 2D loop stays the net driver (:1031-1035).
- CDP base64 throughput over the 1070 tunnel has never been measured.

Q4. Determinism
- **No fixed-dt, timescale or freeze hook exists.** There is no Emulation.setVirtualTimePolicy or beginFrame usage anywhere.
- dt is min((ts-lastFrameTs)/1000, 0.1) (:2497-2512). dt-recovery is disabled under renderOnDemand (:2337-2339). So a stepped frame that takes more than 100 ms advances sim 0.1 s, about 3x too fast for 30 fps output.
- **Clocks that must be virtualized:**
  - performance.now:
    - tick and __renderOnce.
    - The RP3 throttle clock (loop.js:2828-2843).
    - The particle default clock (particles/time_rng.js:15-21).
    - animated_scenery _nowMs.
    - moons tick(ts).
    - skytime=accel.
  - Date.now: the legacy sky date.
  - rAF timestamps, plus the PRIVATE rAF loops that keep running in wall time while stepped:
    - statics.js `_bbLoop` billboards (:4637-4647), which also causes a 1-frame billboard lag.
    - statics.js `_spLoop` static particles (:5768-5781; only when particleClock=off).
    - animated_scenery `_ensureRaf` (:1205-1288, wall-clock dt clamped to 0.1).
    - play_effect_vfx bursts, spell_shape_preview, nameplate LOD, speech-bubble fade.
  - **wasm:** web_time::Instant goes through the glue as `arg0.now()` on globalThis.performance and as `Date.now()` (pkg/holtburger_web.js:20897-20927). wasm physics self-measures elapsed time (loop.js:2808-2816), so a JS shim on performance.now/Date.now virtualizes wasm too.
- **Partial seams already in place:**
  - ?particleClock=sim (index.js:5430-5433; loop.js:3345-3363): the particle/script clock advances by the clamped dt, but never past wall time.
  - time_rng setCurrentTime(fn) and setRng(fn): module-scoped, not on window.
  - ?skytime=<h> pin, or `SessionHandle.setSkyTimeOverride(t)` called per frame (index.html:6318-6340, 6487-6513).
- Workers (bake, texture, shard, keepalive) keep real clocks, which is fine.
- **NOT controllable:** server-driven motion (NPCs, players, projectiles) arrives from ACE in real time.
- **1070 real-time speed (verified, Holtburg, quality=mid, 1280x633):** 22-31 fps, p50 33-42 ms. So real-time 1080p high/ultra at 30/60 fps is not achievable; stepped capture is required for smooth camera moves.

Q5. Resolution
- The agent-mode canvas is min(innerWidth,4096) x min(innerHeight,2160) (index.js:879-897).
- pixelRatio is min(DPR,2) x renderScale, with renderScale in (0,2]. An explicit renderScale pins the value and disables adaptiveRes (:1235-1262).
- `__setRenderScale(n)` changes it live and also resizes the pipeline and clouds (:1268-1286).
- adaptiveRes is off under renderOnDemand, nullRender, an explicit renderScale (:1298-1333) or ?adaptiveRes=off. The debounced resize handler is at :1869.
- **Verified trap:** a 1280,720 window produced a 1280x633 canvas at pr 1 (hbprobe result.json). Use a larger winsize or a viewport override.
- quality:
  - The 1070 does not match GPU_HIGH_RE (quality.js:826), so it auto-selects 'mid'.
  - 'ultra' is never auto-selected. It adds POM 24, statPom, gfxRelief, SSAO, bloom, vignette, aniso 16 and subdiv 8 (:510-543).
- ?msaa defaults to 2 on the composer render targets; 4 or 8 raise it (index.js:817-830).
- clouds=on, and ultra+CSM, have caused context loss 7 times on the 1070 (:5436-5444).
- Live look knobs, after 'ready': `__setExposure`, `__setWorldLightScale`, `__setBloomIntensity`/`Threshold`, `__setVignetteDarkness`/`Offset` (:6323-6362), `__setCloudCoverage`/`Quality`, `__setLightShafts`, `__setSunSize`/`MoonSize`, `__setGameFov`, `__cam.fov(n)`.

Encoders on the laptop
- ~/bin/ffmpeg is a copy of the static 7.0.2 build: libx264, x265, vpx-vp9, aom, prores_ks, ffv1, png. It has no VAAPI.
- /usr/bin/ffmpeg 7.1.5 has libx264, libsvtav1, h264/hevc_vaapi and prores_ks.
- / is 88% full (15 G free). /mnt/wbterminal1 and /mnt/wbterminal2 each have 6.3 T free.

## APIS
- window.__renderOnce [scene3d/index.js:3007]  sig=window.__renderOnce(): boolean  // calls tick(performance.now()); only meaningful with ?renderOnDemand=1 :: Advance exactly one sim+render tick. Async under default syncPhysicsTick, so the frame finishes in a trailing microtask.
- render cadence URL flags [scene3d/index.js:964]  sig=?targetFps=N (<=240, setTimeout-paced rAF) · ?renderOnDemand=1 (no rAF re-arm) · ?netDrainHz=N (<=60, setInterval tickPerFrame) · ?nullRender=1 (skip GPU submit) :: Frame pacing and stepping controls (parsers at :964-1071; scheduleNext at :2403-2432).
- window.__stopNetDrain [scene3d/index.js:3076]  sig=window.__stopNetDrain(): void; window.__netDrainInterval :: Stops the ?netDrainHz interval.
- window.__setRenderScale [scene3d/index.js:1268]  sig=window.__setRenderScale(scale: (0,2]): void :: Live resolution multiplier. Sets pixelRatio=min(DPR,2)*scale and resizes the renderer, atmospherePipeline and cloudOverlay.
- window.__cam (camDebug) [scene3d/camera.js:1484]  sig=__cam.set(ex,ey,ez,tx,ty,tz) [implies park] · .orbit(tx,ty,tz,dist,azDeg,elDeg) · .player(dist,azDeg,elDeg,dz) · .fov(v) · .park() · .release() · .world() · .info() :: Free camera shot rig in AC-world metres (x east, y north incl. landblock origin, z up). Needs ?camDebug=on (exact). set() uses up=(0,1,0)+lookAt, so it has no roll and degenerates at ±90° pitch.
- acToThree [scene3d/adapter.js:1817]  sig=acToThree(ax,ay,az) => [ax, az, -ay] :: Converts AC world coordinates to three.js; the inverse is [x,-z,y].
- boot-state surface [index.html:4265]  sig=window.__bootState; window.__bootStateHistory: {state,message,ts}[]; window.__sceneReadyEverFired; window.__setBootState(state,msg); event 'holtburger:state'; console '[boot-state] X' :: Boot gating. 'ready' means the atmosphere composer is wired (scene3d/index.js:6288-6292).
- window.__runAutonomousLogin / __autoLoginInFlight [app/auto_login.js:535]  sig=__runAutonomousLogin({autoSpawn:'first'|Name|'0'|'select', maxRetries, connectTimeoutMs=25000, spawnTimeoutMs=20000}); __autoLoginInFlight(): boolean :: In-page relogin entry point used by the moving-bench boot gate. Only one run can be in flight.
- window.__isPortalSpaceActive / __portalSpace [scene3d/portal_space.js:1594]  sig=globalThis.__isPortalSpaceActive(): boolean; window.__portalSpace {state,reason,login,loginSkip} :: True while the login/teleport tunnel owns the frame and the world is not drawn.
- SessionHandle.disconnect [pkg/holtburger_web.d.ts:3787]  sig=window.__sessionHandle.disconnect(): void :: Sends retail DISCONNECT 0x8000 so ACE drops the session at once and the next login is not 'Account In Use'. Fire-and-forget; wait about 400 ms.
- SessionHandle.setSkyTimeOverride + ?skytime [index.html:6332]  sig=handle.setSkyTimeOverride(t0to1): boolean; URL ?skytime=<hour 0-24 | 0-1 | accel> :: Pins or drives the sky/sun clock deterministically. Returns false until the SkyDesc is populated. The pin is sticky.
- particle clock hooks [scene3d/particles/time_rng.js:54]  sig=setCurrentTime(fn|null); setRng(fn|null); particleClockMode(): 'off'|'loop'|'sim'  (?particleClock=sim installs liveScene3d._particleSimNowS, index.js:5430) :: Deterministic particle time and RNG seam. Module-scoped, not exposed on window.
- look/grade knobs [scene3d/index.js:6323]  sig=__setExposure(v) __setWorldLightScale(v) __setBloomIntensity(v) __setBloomThreshold(v) __setVignetteDarkness(v) __setVignetteOffset(v) __setCloudCoverage(v) __setCloudQuality(p) __setLightShafts(on) __setSunSize(rad) __setMoonSize(rad) __setGameFov(deg) :: Live post-'ready' look controls for per-shot grading.
- launchAndEnter [harness/lib/boot.mjs:185]  sig=launchAndEnter({query, timeoutMs=60000}) -> {browser,page,helpers:{evalInPage,readGetter(method,args),readDiag(name),entityCount(),consoleErrors(),waitMs(ms),close()},url,inWorld,inWorldMs} :: Laptop headless SwiftShader boot with BASE_QUERY nullRender=1, autoLogin, tailnet1 and a 65 s inter-arm gap. Protocol checks only, never real rendering.
- loadChromium / probeServer [harness/lib/boot.mjs:90]  sig=loadChromium() -> chromium (playwright|PW cache|playwright-core); probeServer(url=SERVER_BASE, timeoutMs=2500): Promise<boolean> :: Playwright resolution fallback and a serve.py reachability probe.
- acquireHeavyLock [harness/lib/heavy_lock.mjs:366]  sig=acquireHeavyLock({label,dir,minFreeMb=2560,memWaitMin=10,lockWaitMin}) -> {dir,bypassed,waitedMs,release()}; acquireHeavyLockSync (:357) :: One-heavy-job-per-machine mkdir lock at /tmp/hb-heavy.lock plus a MemAvailable gate. Re-entrant within a process.
- classifyBoot / readBootSnapshot / formatBootHistory / splitBootErrors / judge [harness/moving-bench.mjs:246]  sig=classifyBoot(snap,{attempt=0,maxAttempts=2}) -> {action:'go'|'wait'|'relogin'|'fatal',reason}; formatBootHistory(snap); splitBootErrors(all,cut); judge(rep,{churnMax,drawSpreadMax}) :: Pure exported boot-gate and run-rejection policy. Importable; main() runs only when argv[1] ends with moving-bench.mjs.
- poseTable / cellToWorld / tableChecksum [harness/lib/moving_path.mjs:128]  sig=poseTable({mode:'orbit'|'dolly'|'hop',frames,anchor:{x,y,z},dist,el,elAmp,elPeriod,az0,laps,dz,hops,dwell}) -> {spec,rows:[[ex,ey,ez,tx,ty,tz]],events,checksum} :: Builds a frame-indexed camera path in node (no clock) with an FNV-1a 1 mm checksum. The template for film camera tables.
- movingRigSource / window.__mbench [harness/lib/moving_rig.mjs:51]  sig=page.evaluate(movingRigSource()); __mbench.install({spec,rows,events,warmFrames,drive:'ondemand'|'raf'}); applyPose(k); step(); run() -> {realisedChecksum,cpuMs[],rafMs[],draws[],ktris[],lb:{churnFrames,...},...} :: In-page stepper. Per frame: __cam.set(row k), then __renderOnce, then rAF waits. Includes a warm lap, a measure lap, a realised-pose hash and a resident-landblock churn hash.
- pw1070 chromium shim [external/holtburger/scripts/perf-worker/coldboot/pw1070/playwright.js:71]  sig=NODE_PATH=<dir> node x.cjs; require('playwright').chromium.launch() -> {newPage,newContext,contexts,close}; rewriteUrl(u) :: Makes existing playwright scripts run on the 1070: presence gate, tunnel, fresh test Chrome, connectOverCDP, URL rewrite to the tailnet front.
- coldboot drive scripts [external/holtburger/scripts/perf-worker/coldboot/shot.mjs:9]  sig=node sess.mjs boot [--flags a=b] [--window W,H] [--spawn first|select]; node shot.mjs out.png [dom|3d] [sel]; node camset.mjs ex ey ez tx ty tz out.jpg [keep]; node teleshot.mjs '<@cmd>' out.jpg [waitMs]; node probe.mjs snippet.js; node enterchar.mjs Name :: Persistent 1070 session plus one-shot CDP clients. The '3d' mode is the HUD-free toDataURL-inside-render capture.
- screencastFrames / captureVerified [external/holtburger/scripts/visual-regression/capture-all.cjs:337]  sig=screencastFrames(page,count,gapMs) -> Buffer[]; captureVerified(page,target,fpath) -> {via,stale} :: Page.startScreencast PNG frames via newCDPSession with ack. Used as the fallback when Page.captureScreenshot is stale.
- gate1070.sh / hbbench-kill.ps1 / hbprobe-launch.bat [external/holtburger/scripts/perf-worker/coldboot/gate1070.sh:1]  sig=./gate1070.sh (exit 0 only if watch1070 polled <60s and state=AWAY); ssh box 'powershell -File D:\Temp\hbbench\hbbench-kill.ps1'; schtasks /create /tn hbprobe /tr D:\Temp\hbbench\hbprobe-launch.bat /sc once /st 00:00 /it /f & schtasks /run /tn hbprobe :: Owner-presence gate and the 1070 test-Chrome lifecycle. Profile name comes from D:\Temp\hbbench\profile.txt, size from winsize.txt.
- window.__loseContext / __restoreContext [scene3d/webgl_context_recovery.js:337]  sig=window.__loseContext(); window.__restoreContext() :: Simulates WebGL context loss and restore; the recovery pauses the loop.
- ffmpeg binaries [/home/wbterminal/bin/ffmpeg:]  sig=~/bin/ffmpeg = static 7.0.2 (libx264/libx265/libvpx-vp9/libaom/prores_ks/ffv1/png, no VAAPI); /usr/bin/ffmpeg 7.1.5 (libx264/libsvtav1/h264_vaapi/hevc_vaapi/prores_ks) :: Laptop-side encode and mux.

## SEAMS
- [harness/lib/moving_rig.mjs:176] renderOnDemand + __renderOnce + netDrainHz frame stepper => Film frame loop: set the virtual clock, apply pose k, __renderOnce(), wait for the gauge or a rAF, grab the frame. Frame k always gets pose k regardless of render time.
- [external/holtburger/scripts/perf-worker/coldboot/camset.mjs:13] renderer.render hook capture (getRenderTarget()===null then toDataURL in the same task) => HUD-free frame grabber. Use it once per frame after the last default-framebuffer draw (composer final pass, cloud overlay, portal overlay); for example queueMicrotask, then new VideoFrame(canvas,{timestamp:k*1e6/fps}) or canvas.toBlob.
- [harness/lib/moving_path.mjs:128] node-built frame-indexed pose table plus realised-pose checksum => Template for film camera paths (dolly, orbit, crane, drone splines). Compute in node, ship rows, verify that the realised checksum matches the intended one.
- [harness/moving-bench.mjs:402] warm lap plus resident-landblock churn judge => Pre-stream the exact shot path, then reject takes whose terrainBakedLbs hash changed mid-take (pop-in) or whose realised path diverged.
- [scene3d/camera.js:1457] __cam.park + direct camera write => park() suspends positionCamera, so film mode can write cam.position plus cam.quaternion directly (acToThree) for gimbal-free ±90° pitch and roll, instead of set()'s lookAt with up=(0,1,0).
- [harness/moving-bench.mjs:246] boot gate policy plus relogin entry point => Reuse classifyBoot, readBootSnapshot and __runAutonomousLogin for unattended film-session boots. Add __isPortalSpaceActive()===false and a settle wait.
- [external/holtburger/scripts/perf-worker/coldboot/pw1070/playwright.js:56] pw1070 shim and sess.mjs 1070 lifecycle => Start, attach to and tear down the off-screen muted 1070 Chrome behind the presence gate; URL rewrite to the tailnet front.
- [index.html:6495] skytime pin / setSkyTimeOverride => Fixed lighting per shot, or a deterministic time-lapse by calling setSkyTimeOverride(t0+k*dt) each stepped frame.
- [scene3d/index.js:5430] particleClock=sim plus time_rng setCurrentTime/setRng => Single sim clock for particles and scripts; a seeded RNG would make particle FX repeatable across takes (needs a window-exposed hook or a dynamic import of the same module URL).
- [scene3d/index.js:6323] live grade knobs (__setExposure, __setBloom*, __setVignette*, __setCloudCoverage, __cam.fov) => Per-shot look and focal length (including dolly-zoom via fov plus a dolly) set by the director plan.
- [index.html:4279] holtburger:state CustomEvent and [boot-state] console lines => Event-driven gating via page console events instead of polling Runtime.evaluate, which can starve on a busy page.
- [external/holtburger/scripts/perf-worker/coldboot/teleshot.mjs:10] sendChat admin teleports => Move the camera-person character to the shot site (@teleloc cell x y z / @telepoi). Use ?portalSpace=off or wait for __isPortalSpaceActive()===false before stepping.
- [external/holtburger/scripts/visual-regression/capture-all.cjs:337] Page.startScreencast via newCDPSession => Low-cost live preview for the directing Claude session or JEV shot scoring (includes DOM, so use hud=none); never the final footage.
- [external/holtburger/scripts/perf-worker/hbprobe.mjs:60] ACE log account release checks => Wait for '[LOGOUT] Account X' in ACE_Log.txt before relaunching, or call disconnect() first.
- [harness/lib/heavy_lock.mjs:366] heavy_lock for laptop encodes => Serialize the ffmpeg encode or mux on the 8 GB laptop with other heavy jobs (run under capped-build).

## HAZARDS
- [external/holtburger/docs/archive/docs/HANDOFF-terrain-vfx-wave1-2026-07-31.md:115] Policy: the laptop must not host live client sessions. A quality=high SwiftShader session wedged Chrome's shared GPU process, every GL call then blocked, and Runtime.evaluate timed out browser-wide. Agent-driven live sessions are allowed only when the owner requests that run. || mitig: Render film only on the 1070 (MODE2i). Get owner consent per session (memory no-agent-eyetests.md). Parallel agents never start browsers (CLAUDE.md).
- [external/holtburger/scripts/perf-worker/coldboot/watch1070.sh:1] Owner presence: watch1070 kills our test Chrome as soon as a person is present, and hbgate.ps1 refuses launches. Test Chrome has also died mid-run on its own. A results file written only at the end (vistest) loses everything. || mitig: Write each frame to disk immediately, keep a per-shot manifest, and resume at frame k after relaunch. Run gate1070.sh before every launch and between long steps.
- [external/holtburger/scripts/visual-regression/capture-all.cjs:310] page.screenshot (Page.captureScreenshot) returns stale or black WebGL frames on GPU-composited targets (1070 >10 min stale; T4 black). It also includes DOM HUD. || mitig: Capture in-canvas inside the render hook (toDataURL, toBlob or VideoFrame). Use screencast only as a staleness check or preview.
- [scene3d/index.js:1159] preserveDrawingBuffer=false: canvas pixels are valid only within the task that rendered. A later readback gives zeros or stale data. || mitig: Snapshot inside the renderer.render wrapper or a queueMicrotask in the same task. Never read after awaiting a macrotask.
- [scene3d/index.js:2497] No fixed-dt hook. Stepped frames get dt = min(wall delta, 0.1), so slow captures run the sim up to 3x fast. Private rAF loops (billboards, animated scenery, static particles, VFX bursts) run in wall time between steps, and billboards lag one frame behind the camera. || mitig: Install a virtual clock via page.addInitScript before goto (performance.now, Date.now, requestAnimationFrame queue flushed per step; wasm follows through the glue), or add __renderOnce(dt) and clock hooks in code. Never let virtual time run ahead of real time, so web_time liveness and ping logic stay sane.
- [/mnt/wbterminal1/tmp/claude-scratch/perf/hbprobe-base-mid-2026-10-06T14-48-22-044Z/result.json:] Server-driven motion (NPCs, players, projectiles, server teleports) arrives from ACE in real time and cannot be stepped. Stepped capture compresses it, because the 1070 renders at about 22-31 fps at mid 1280x633. || mitig: Classify shots: stepped for scenery, drone and dungeon fly-throughs; real-time (?targetFps=N plus captureStream/WebCodecs with real timestamps, lower res) for action. Use @attackable off for crowds.
- [scene3d/index.js:1091] ?syncPhysicsTick is DEFAULT ON (`!== "off"`), so tick is async and __renderOnce returns before the frame has rendered. || mitig: Wait as moving_rig.step does (rAF plus vfxGauge.frames change), or capture from the render hook; or pass syncPhysicsTick=off for parked-camera shots.
- [app/client_events.js:1580] In-canvas overlays are NOT removed by hud=none: speech bubbles are always on and drawn into the WebGL canvas; the portal tunnel and WORLD_FADEIN overlay are also drawn into the canvas. hb-* DOM HUD is visible in agent-mode since 2026-10-05, so the memory claim that a canvas-element screenshot is HUD-free is stale. || mitig: Stub liveScene3d.entityManager.showSpeechBubble during takes. Keep nameplates off (the default). Use ?hud=none for any DOM capture. Use ?portalSpace=off and wait for __isPortalSpaceActive()===false.
- [docs/url-flags.md:368] Teleport portal space is default ON. The world is not drawn until the destination is ready plus a fade. Under renderOnDemand the tunnel advances only when frames are driven, and stepped capture would record it. || mitig: Add ?portalSpace=off to film URLs, or drive __renderOnce until portal space is inactive, then run the settle wait and warm lap.
- [scene3d/index.js:2800] Before 'ready' (atmosphere bake about 8 s on the 1070) frames use the direct render path (no AP, tone mapping or composer), a different look. Entity lazy compiles finish about 4 s after 'ready'. || mitig: Gate on __sceneReadyEverFired, terrainBakedLbs.size>=9 and a settle quiet window (hbprobe settle), then a warm lap.
- [scene3d/camera.js:1496] __cam.set uses lookAt with a fixed up=(0,1,0): gimbal degenerate at ±90° pitch and no roll. capture_canvas_video's pitch-up also looks straight up. || mitig: Drive position and quaternion directly while parked (slerp/squad in node), or add a __cam.setQuat seam.
- [capture_canvas_video.cjs:197] capture_canvas_video.cjs's forced setInterval(renderer.render(scene,cam),33) bypasses the composer: wrong look and frames interleaved with composer frames. The script also uses a stale form login and DOM pinning. || mitig: Do not reuse its render loop. Reuse only the MediaRecorder and chunk-export ideas.
- [scene3d/index.js:886] Window size is not the viewport: a 1280,720 test window produced a 1280x633 canvas. Agent canvas size is capped at 4096x2160. renderScale is capped at 2. adaptiveRes changes resolution unless pinned. || mitig: Pin renderScale and adaptiveRes=off. Size the viewport explicitly (page.setViewportSize / Emulation.setDeviceMetricsOverride, unverified on the box) or enlarge winsize.txt. Assert canvas.width/height before a take.
- [scene3d/index.js:5436] WebGL context loss under VRAM pressure (ultra+clouds+CSM; observed 7x on the 1070). The recovery pauses the loop. || mitig: Listen for webglcontextlost and re-shoot from the last checkpoint. Be careful with renderScale=2, msaa>2 and clouds=on together.
- [harness/lib/boot.mjs:49] Single-login: an overlapping login makes ACE drop BOTH sessions. An abrupt close holds the account until the 60 s reap. || mitig: Call __sessionHandle.disconnect() in-page and wait about 400 ms before closing, check the ACE_Log LOGOUT line, or alternate accounts. Don't use tailnet1 unattended on the 1070 (it is the human's account).
- [harness/flag-census/bootab.mjs:28] Hung or starved CDP: one hung page.evaluate cost 6 hours. Runtime.evaluate responses can starve for tens of seconds while the page is busy. Playwright keeps the node event loop alive. || mitig: Wrap every evaluate in a watchdog timeout. Timestamp via console events. Always process.exit() at the end. Check `curl :9333/json/version` before blaming the page.
- [harness/flag-census/bootab.mjs:3] Reusing one Chrome degrades it 2.44x over about 100 minutes, and geometries accumulate within a session. || mitig: Relaunch a fresh-profile Chrome between long shot batches (about 60-90 min).
- [index.html:2363] Service worker: without ?nosw=1, stale JS and shards are served. With nosw on a profile that had a SW, the page reloads once, destroying evaluate contexts and injected hooks. || mitig: Use fresh profiles (hbprobe-launch does) plus nosw=1. Inject hooks with addInitScript and tolerate the navigation.
- [external/holtburger/scripts/perf-worker/box/hbprobe-launch.bat:10] Audio: the portal tunnel and game play sounds; no sound may reach the 1070's user, and the box must never be OS-muted. || mitig: Keep --mute-audio (already in the launch bats). Footage is video-only; add the soundtrack in post.
- [/home/wbterminal/.claude/plugins/cache/claude-plugins-official/chrome-devtools-mcp/1.9.0/.claude-plugin/plugin.json:] The chrome-devtools MCP plugin in this Claude session launches its OWN local Chrome (npx chrome-devtools-mcp@1.9.0, no --browserUrl). That would be a live world on the 8 GB laptop. || mitig: The film agent drives through node scripts against :9333, or reconfigures the MCP with --browserUrl http://127.0.0.1:9333 (tunnel).
- [external/holtburger/docs/rynth-integration/RESULTS-navatlas-soak-15-pickup-2026-07-19.md:123] Page-side AI auto-restarted from URL params on every reconnect and drained OpenRouter credit overnight. || mitig: Keep JEV/OpenRouter calls in the laptop-side orchestrator, never in page code or URL params.
- [docs/url-flags.md:511] url-flags.md rows for renderOnDemand ('Render only on scene change'), netDrainHz ('Throttle network message drain') and nullRender/targetFps are inaccurate and carry stale line refs. || mitig: Trust the scene3d/index.js parsers (:955-1071) and *Enabled() readers.
- [/mnt/wbterminal2/stream/go_live-window.sh:18] Disk and memory: / is 88% full (15 G free). An encode on the 8 GB laptop alongside other jobs can OOM. ~/bin static ffmpeg has no VAAPI. || mitig: Write frames to /mnt/wbterminal1 or 2. Run ffmpeg under capped-build plus acquireHeavyLock. Use /usr/bin/ffmpeg for VAAPI or svtav1.

## DATA
- {'name': 'playwright + playwright-core 1.59.1 (npx cache)', 'location': '/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/{playwright,playwright-core}', 'format': 'node packages', 'notes': 'Only install. HB/node_modules/playwright-core is a symlink to it (ESM resolution for scripts under apps/holtburger-web). Browsers in ~/.cache/ms-playwright: chromium-1217/1223, headless_shell-1217/1223/1228, ffmpeg-1011.'}
- {'name': '1070 perf/probe results', 'location': '/mnt/wbterminal1/tmp/claude-scratch/perf/ (hbprobe-base-mid-2026-10-06T14-48-22-044Z/result.json, flagbench-r1/summary.json, hbbench-ll1/*.json)', 'format': 'JSON + PNG + cpuprofile', 'notes': 'Ground-truth 1070 numbers: mid 1280x633 22-31 fps, boot 8.4-11.2 s, Holtburg settle 98.6 s, canvas {w:1280,h:633,pr:1}.'}
- {'name': '1070 box staging', 'location': 'D:\\Temp\\hbbench\\ (profile.txt, winsize.txt, logs\\<prof>.log, gate.log, idle.txt) on young@100.127.215.75', 'format': 'Windows files', 'notes': 'Owner says D:\\Temp is the scratch area. Launch/kill/gate scripts are mirrored in external/holtburger/scripts/perf-worker/box/.'}
- {'name': 'watch1070 state', 'location': '/mnt/wbterminal1/tmp/claude-scratch/perf/watch1070.{poll,events,state,lock}', 'format': 'text', 'notes': 'gate1070.sh reads watch1070.poll (`<epoch> <state> <hbwho line>`).'}
- {'name': 'ACE server log', 'location': '/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0/ACE_Log.txt', 'format': 'text log', 'notes': '`[LOGIN]/[LOGOUT] Account X` and `entered/exited the world` lines gate account reuse. Keep ACE vanilla.'}
- {'name': 'ffmpeg builds', 'location': '/home/wbterminal/bin/ffmpeg (= /home/wbterminal/src/ffmpeg-7.0.2-amd64-static/ffmpeg), /usr/bin/ffmpeg 7.1.5', 'format': 'binaries', 'notes': 'Static build: x264/x265/vp9/aom/prores_ks/ffv1, no VAAPI. System build: svtav1, h264/hevc_vaapi.'}
- {'name': 'scratch volumes', 'location': '/mnt/wbterminal1, /mnt/wbterminal2 (6.3T free each); existing capture dirs /mnt/wbterminal1/holtburger-captures, /mnt/wbterminal1/holtburger-goldens', 'format': 'ext disks', 'notes': 'System disk / is 88% full. wbterminal2 is a USB HDD (slow seeks).'}
- {'name': 'prior YouTube stream rig (retired)', 'location': '/mnt/wbterminal2/stream/ (go_live-window.sh, launch.sh, probe.cjs)', 'format': 'bash + cjs', 'notes': 'Laptop x11grab of the chromium window plus h264_vaapi to RTMPS. Proven pipeline, but laptop-hosted (now disallowed). probe.cjs is a connectOverCDP probe with an 8 s eval watchdog.'}
- {'name': 'puppeteer-core 25.10.0 + ws (plugin cache)', 'location': '/home/wbterminal/.claude/plugins/cache/claude-plugins-official/chrome-devtools-mcp/1.9.0/node_modules/', 'format': 'node packages', 'notes': 'Alternative CDP client libs that exist on disk but are not repo-owned; the path is brittle.'}

## RECS
- Driver: write the film driver as an ESM script under apps/holtburger-web/ (for example tools/film/) importing 'playwright-core'. Reuse the pw1070 ensureChrome sequence (gate1070.sh, -L 9333 tunnel, schtasks hbprobe fresh profile with winsize.txt), then connectOverCDP. Open only your own page, never close someone else's Chrome, kill only via hbbench-kill.ps1, and always process.exit().
- Film boot URL (candidate): ?autoLogin=1&account=<bot>&password=<bot>&autoSpawn=first&agent=1&hud=none&nosw=1&camDebug=on&quality=high|ultra&msaa=4&adaptiveRes=off&renderScale=1&skytime=<h>&portalSpace=off&particleClock=sim&renderOnDemand=1&netDrainHz=30, plus bridge_url/server_host/server_port for the tailnet front. Gate with classifyBoot, then __sceneReadyEverFired, __isPortalSpaceActive()===false, terrainBakedLbs.size>=9 and the hbprobe-style settle (LRU entries|geometries quiet 12 s), plus 4 s.
- Determinism: inject a virtual clock with page.addInitScript before goto (performance.now, Date.now, requestAnimationFrame callback queue flushed with virtual timestamps each step). Advance exactly 1/fps per step; clamp to never exceed real elapsed time. Drive the sky with setSkyTimeOverride per frame or a pin. Alternatively land a small code seam: __renderOnce(dtOverride) plus a window-exposed time_rng setCurrentTime/setRng.
- Frame grab: wrap liveScene3d.renderer.render once. On the first default-framebuffer render of a stepped frame, schedule one queueMicrotask capture so the cloud and portal overlays are included. Prefer new VideoFrame(canvas,{timestamp:k*1e6/fps}) into an in-page WebCodecs VideoEncoder (H.264/HEVC/VP9, hardware if isConfigSupported says so, high bitrate) for deterministic timestamps. Fall back to canvas.toBlob('image/png'|'image/webp').
- Transport: avoid per-frame base64 through page.evaluate where possible. Have the page POST binary chunks with fetch to a small laptop HTTP sink (CORS on, reachable via the tailnet front or a -R reverse forward), or batch chunks through evaluate as base64 slices. Mux on the laptop (Annex-B .h264 or IVF to mp4/webm with ffmpeg -c copy), or encode PNG sequences with x264/svtav1/prores under capped-build plus acquireHeavyLock, with output on /mnt/wbterminal1.
- Shot QA: reuse moving_path's frame-indexed pose table (extend it to splines, quaternions and fov tracks) and moving_rig's warm lap, realised-pose checksum and landblock churn hash. Reject takes with pop-in or a diverged path. Pre-stream every take with a warm lap.
- Camera: bypass __cam.set's lookAt for drone and 90° moves. While parked, write cam.position = acToThree(eye) and cam.quaternion from node-computed slerp/squad (roll allowed); set fov per frame for zooms.
- Clean frames: stub entityManager.showSpeechBubble during takes, keep nameplates off, never select a target, use portalSpace=off, and @attackable off on the camera-person character. Use DOM screenshots only for debugging, with hud=none.
- Action shots: when server-driven motion matters, record in real time instead: ?targetFps=N (or none), lower renderScale or quality, canvas.captureStream(N) + MediaRecorder at a high bitrate, or WebCodecs with real timestamps. Retime or interpolate in ffmpeg afterwards.
- Resilience: checkpoint every frame to disk with a per-shot manifest. Re-check gate1070.sh between shots. Use a watchdog timeout on every evaluate. Relaunch Chrome every ~60-90 min. Call __sessionHandle.disconnect() and wait about 400 ms before closing, and verify the ACE LOGOUT line before relogin.
- Live preview for the directing agent or JEV scoring: Page.startScreencast (jpeg, maxWidth ~640, everyNthFrame N) via newCDPSession. It is cheap, includes the DOM (use hud=none), and is never the final footage.
- Keep JEV/OpenRouter calls on the laptop orchestrator side only; nothing AI-related goes in page code or URL params (OpenRouter drain precedent).

## OPENQ
- Which WebCodecs VideoEncoder configs (avc1 High, hvc1, vp09, av01) are hardware-accelerated in Chrome on the 1070 (VideoEncoder.isConfigSupported with hardwareAcceleration:'prefer-hardware')? Does Chrome there support MediaRecorder 'video/mp4;codecs=avc1'?
- Do canvas.captureStream / new VideoFrame(canvas) / toBlob produce real frames from the off-screen (-32000,-32000) MODE2i window? capture_canvas_video noted empty frames when the compositor skips an off-screen canvas.
- What is the throughput of the SSH -L 9333 tunnel and the 1070→laptop tailnet link? This decides CDP base64 transfer vs page fetch POST to a laptop sink vs saving on D:\Temp and scp. It has never been measured.
- Are Node and ffmpeg available and current on the 1070 box? MODE2 once ran node on the box; ffmpeg is unknown. Encoding there would avoid shipping frames.
- Which non-human bot account has Developer/Admin rights for @teleloc/@telepoi/@attackable (agentp07? phase4demo?) so film runs don't use tailnet1, the human's account on the 1070?
- Does page.setViewportSize / Emulation.setDeviceMetricsOverride on a connectOverCDP page in headful Chrome on the box give an exact 1920x1080 (or 3840x2160) canvas regardless of window size?
- Does Playwright download.saveAs work over connectOverCDP to the remote 1070 Chrome (capture_canvas_video's export path), or must blobs be chunked out?
- Is an init-script virtual clock acceptable for wasm session liveness, ping RTT and the remote-entity interpolation that read performance.now through web_time? Is a code-level __renderOnce(dt) seam preferred over a global shim?
- How should film mode get the owner's per-run consent required by no-agent-eyetests.md for agent-driven 1070 sessions, given the presence gate already exists?
- Is there any client hook to hide the local player rig (the camera person) during takes? None found by grep; @invisible or a client-side visibility toggle may be needed (camera agent's area).
