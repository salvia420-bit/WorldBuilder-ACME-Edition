# Handoff — playtester soak, session 11 (seam-transit FIXED both layers; YouTube stream rig stood up; first AI-director thought)

Continues `HANDOFF-playtester-soak-10.md`. This session closed BOTH layers of
the soak-10 §4 seam-transit wall, built a native offline harness for the
grocer seam from real DATs, stood up a complete YouTube livestream rig on the
Dell (VAAPI, GPU chromium, intermission slate, teleprompter overlay), booted
the rynth grind bot in the live stream session via `?bot=1`, and captured the
AI director's first live GLM/LLM thought. Operator stopped the bot at end of
session ("will examine later"); the stream rig stays up.

## 1. Seam transit — FIXED (commit 43cf331c), two distinct layers

Offline harness first (the soak-10 recommendation): NEW
`crates/holtburger-world/src/spatial/env840_seam_tests.rs` loads the 5 real
grocer EnvCells (0xA9B4016A..016E, env 840) from `client_portal.dat` +
`client_cell_1.dat` into a `SpatialScene` mirroring the web ingest, and drives
`CTransition`/`faithful_find_transitional_position` directly. Ground truth
recovered on the way: the vestibule 0x16E is a box only 0.614 m deep (local
x∈[3.636,4.25], y∈[−2.15,−0.25]); the operator repro pose (81,33) is
cell-local (4.243,−2.121) — i.e. EMBEDDED ~0.37 m in the y=−2.15 wall and
0.007 m from the outside portal plane. DAT is clean (physics polys 0..3
disjoint from portal polys 4,5; portal 4→0x16A carries PortalSide only on the
0x16E side).

**Layer 1 — embedded arrival refusal.** Teleports applied the server pose
verbatim; a pose embedded in cell geometry made every sweep substep collide →
`validate_transition` BRANCH-A reset check→curr → `find_valid_position`
returned 1 with 0.00 m realized, and no contact plane ever settled (the
grounded decay). Retail prevents the state at ARRIVAL:
`CPhysicsObj::SetPosition` → `find_placement_position` (acclient.c:313341) →
`find_placement_pos` radial search (:313015). Fix: `pending_arrival_placement`
latch on `PlayerState`, set by `set_player_position_with_sync` on
`AuthoritativeBodySync::{Reset,ForceBlip}`, consumed at the TOP of
`MovementSystem::tick` (NOT the manual-drive slice — the wasm unified tick
spine deliberately skips that pre-integration; first wiring attempt was dead
code live). New bridge fn `faithful_find_placement_position`. Offline-proven:
the repro pose de-embeds 0.891 m through the portal into 0x16A, grounded.
⚠ OPEN: live engagement at `@teleloc` never visually confirmed (no lateral
adjust observed; the success log is `log::info` and the wasm logger caps at
Warn — lib.rs:875). Next session: bump the log to warn / add a `__diag`
counter and re-verify; the failure arm (`placement search failed`, warn) did
NOT appear, so it either engaged silently-and-judged-valid or never latched.

**Layer 2 — run-speed wedge (THE soak bot freeze, ticket uhf1nw).** Live A/B
isolated it: WALK crossed the seam fine; RUN crossed then froze forever at
(81,35.03) with z converged to 1.3 cm above the floor and grounded=false
(airborne ⇒ steering ignored). Root cause: the wedge cycle itself is
retail-faithful (descending sweep → floor adjust → placement re-insert hits
the step riser → COLLIDED → contact AND last_known cleared), but retail's
escape — the persistent `frames_stationary_fall` counter
(acclient.c:312279-312312, :320104-320115, :321862-321918) that synthesizes a
resting floor after 2 stationary falling frames — was never seeded/read back
(bridge passed 0 every frame). Fix threads the counter through
`PlayerState`/`TransitionInput`/`TransitionOutcome` with the velocity-kill on
counter-advance frames (one documented leapfrog adaptation in system.rs).
A/B repro tests (driver-level + real-integrator slice loop) fail-pre/pass-post.
**Live-verified in the stream session: RUN north through the seam crosses
grounded; walk 5.23 m / run 4.38 m from the seam pose, grounded throughout.**

Suites: world 560/0, dat 706/0, core 580 + exactly the 10 known-stale
(handoff-7 §5, untouched). Vendor arc re-verified live end-to-end at walk
speed (`door_repro2`: in-room walks + `vendorState: Fispur Ansel, 7 items`).

## 2. Stream rig (NEW) — /mnt/wbterminal2/stream/

- `launch.sh` — kills prior stream chromes (pkill self-match guard:
  `pgrep -f 'strea[m]/profile-'` — the bracket is LOAD-BEARING, plain
  patterns kill your own compound command, exit 144), PURGES chromium
  tab-restore state (`Default/Sessions`, `Session Storage` — NOT Local
  Storage), then launches the SLATE (kiosk, `slate.html` "Torval has recalled
  to the lifestone") and the GAME window (Debian `/usr/bin/chromium`, kiosk,
  CDP :9223, anti-throttle flags) on :0.
- `go_live.sh` — while-loop ffmpeg: x11grab 1280x720@24 → `h264_vaapi`
  CQP 25 (iHD driver; Skylake supports CQP ONLY — no CBR; i965 crashes) +
  silent AAC → `rtmps://a.rtmps.youtube.com/live2/$KEY`. Stop:
  `touch /mnt/wbterminal2/stream/STOP`. Keys: `/mnt/wbterminal2/stream/.keys/`
  (yt-stream-key, openrouter-key; 0600).
- Game URL flags that matter: `nosw=1&bakeWorker=0&targetFps=20&netDrainHz=30
  &renderScale=1&wireframe=1&rain=off&snow=off&lightning=off&autoLogin=1…
  &agent=1&thoughtOverlay=1` (+`&bot=1` to re-arm the bot — operator-stripped
  at session end).
- X is set to 1280x720 (`xrandr --output eDP-1 --mode 1280x720`) so capture
  is native-size (no scale filter) and chromium renders 2.25× fewer pixels.

**Hard-won ops traps (all live-diagnosed today):**
1. **DPMS**: the panel powering off kills Chrome's vsync source → ~1 fps rAF
   in EVERY window regardless of GPU. `xset s off -dpms` + xfce4-power-manager
   dpms-enabled=false. THE phantom perf killer of the day. xset is
   session-scoped — re-apply if X restarts.
2. **Chromium session-restore tab wars**: a persistent profile restores old
   game tabs on relaunch; N tabs = N clients fighting one account → ACE
   boot-loop ("Account was logged in, booting…" ×58) → nothing can act.
   The launcher's Sessions purge fixes it; verify ONE page on CDP :9223.
3. **Duplicate-login dance**: every relaunch triggers ACE's boot-old/drop-new
   handshake; the client's autoLogin retry gets in ~10 s later. Boot scripts
   must reload-retry (pose-based readiness, NOT `__bootState` — the scene-ready
   90 s watchdog latches `error` on slow boots while the session is fine).
4. **HTTP cache vs edited JS**: `nosw=1` bypasses the service worker but NOT
   the HTTP cache — after editing app JS, reload with CDP
   `Page.reload {ignoreCache:true}` or the page runs stale code.
5. Occlusion throttling: `--disable-backgrounding-occluded-windows
   --disable-renderer-backgrounding` on both windows; never raise the slate
   above the game (`wmctrl -a Intermission` was the mistake).
6. fps expectations (wireframe, 720p, quiet CPU): ~9 fps render at
   `targetFps=20`; any local `cargo`/`rustc` (jobs=2) starves the browser to
   ~1-2 fps — batch builds or push to buildbox while streaming publicly.

## 3. Bot + AI director in the stream session

- `?bot=1` (index.html kind=7 handler) works, BUT a session-takeover
  reconnect skips kind=7 → auto-boot doesn't fire; manual boot via CDP
  (`import rynth/bot.js` → `createGrindBot(window.__sessionHandle, {})`)
  is the reliable path after relaunches.
- OpenRouter key saved in the game profile's localStorage (survives
  relaunches; also in `.keys/openrouter-key`). Director default model is
  `openai/gpt-oss-120b` (llm_client.js DEFAULT_MODEL) — operator wants GLM;
  pin via `?aiPanel=1` model field or bot cfg next session.
- **First live thought** (check-in forced via `rynthAI.checkNow()`):
  "Bot is idle with no monsters nearby. Nearest door (0x7a9b401f) likely
  leads to a new area. Open it to explore and find combat zones." → executed
  `use_object` on the grocer door → `walk:settled, used` → journaled. The
  think→act→journal loop is LIVE.
- NEW `rynth/ai/thought_overlay.js` + hook in bot.js (`?thoughtOverlay=1`):
  stream-facing teleprompter for journal `plan` entries; reveal pace
  `cps = max(17, chars/(0.8·interval))` so even a 1024-token thought finishes
  before the next 5-min check-in. ⚠ NOT yet visually verified (the
  cache-bypass verify run was interrupted by operator stop) — next session:
  hard-reload, boot bot, `checkNow()`, confirm the reveal on stream.

## 4. Housekeeping

- rust-analyzer uninstalled (rustup component removed; ~/.local/bin symlink
  deleted) — it was the recurring 2.4 G OOM hog. `rustup component add
  rust-analyzer` restores.
- Disk: / freed 1.0→~3.7 G (ms-playwright → /mnt/wbterminal2/ms-playwright
  symlink — REMEMBER: home cache is now a symlink; mount down = no browsers;
  npm cache cleaned; apt clean). Playwright module for repro scripts installed
  at soak-v65/repro-2026-07-18/node_modules (+ headless-shell 1228).
- Installed (apt): ffmpeg 7.1.5, intel-media-va-driver, i965-va-driver,
  chromium 150, xdotool. Internal mic muted at ALSA (capture off/0%, boost 0).
- MEMORY.md is over its load budget; trim pending.

## 5. Next-session candidates

1. **Arrival-placement live engagement** (§1 layer 1 OPEN) — make the log
   visible, verify the latch fires on real `@teleloc`/PlayerTeleport, then
   soak-relaunch (v6.5.5) for the economy arc with both seam fixes live.
2. **thoughtOverlay visual verify** + pin the director model to the
   operator's GLM choice; then re-arm `&bot=1` for the stream.
3. Faithful-driver open-door exclusions (soak-10 §4 bullet 2, unchanged).
4. Varek/Torval pyreal-stream mystery (soak-8 §7.2, unchanged).
5. The 10 stale movement tests (handoff-7 §5, unchanged).
