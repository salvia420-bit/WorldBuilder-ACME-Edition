# Stream rig — operator runbook

The YouTube livestream rig on the Dell (`:0`, VAAPI GPU chromium, intermission
slate, rynth AI-director bot). Consolidates the hard-won ops traps from
soak-11 §2 (where they were first diagnosed) so they don't re-cost a session.
See `HANDOFF-playtester-soak-11.md` §2 (rig stand-up) and
`HANDOFF-playtester-soak-12.md` (connection-lifecycle fixes that reduced the
boot-loop churn this runbook fights).

## Rig file map — `/mnt/wbterminal2/stream/`

| File | Role |
|---|---|
| `launch.sh` | Launches slate (bottom) + GPU game window (top) on `:0`. Purges chromium Sessions, disables DPMS, boots the bot via URL flags. |
| `go_live.sh` | While-loop ffmpeg: x11grab 1280x720@24 → `h264_vaapi` CQP 25 → `rtmps://…youtube…/$KEY`. Auto-reconnects. |
| `slate.html` | Kiosk intermission slate ("Torval has recalled to the lifestone"). |
| `.keys/` | `yt-stream-key`, `openrouter-key` (mode 0600). Re-read each ffmpeg iteration. |
| `STOP` | `touch` it to stop `go_live.sh`; `launch.sh` and `go_live.sh` remove it on start. |
| `profile-game/` `profile-slate/` | Persistent chromium profiles (CDP :9223 = game). |

## Start / stop

1. X must be 1280x720: `xrandr --output eDP-1 --mode 1280x720` (native capture,
   no scale filter, 2.25× fewer pixels rendered).
2. `bash /mnt/wbterminal2/stream/launch.sh` — slate first, then game window.
3. `bash /mnt/wbterminal2/stream/go_live.sh &` — starts the YouTube push.
4. Stop stream: `touch /mnt/wbterminal2/stream/STOP`.

## Game URL flag set (baked into `launch.sh`)

```
nosw=1&bakeWorker=0&targetFps=20&netDrainHz=30&renderScale=1&wireframe=1
&rain=off&snow=off&lightning=off&autoLogin=1&account=vendortest
&password=vendortest&autoSpawn=first&agent=1
&thoughtOverlay=1&bot=1&streamHud=1&botModel=minimax/minimax-m3
&botInterval=0.5&botPersona=explorer
&explorePressure=1
```

*(2026-07-23, rynth-review 13 D1 / 15 B2 / 16 S3: this block now shows the
POST-removal shape — `kickDance=1` dropped (dead param, no reader since
2026-06-14, see the `kickDance` row in url-flags.md) and
`faithfulEntityCollision=on` dropped (the reader only ever tests `=off`; the
feature has been default-ON since FU-3's 2026-07-20 promotion, so `=on` was a
no-op relic of the pre-promotion opt-in string. A concurrent remediation pass
is removing both from the live `launch.sh` — if you're reading this before
that lands, `launch.sh` may still carry one or both; they do nothing either
way.)*

- `botModel=minimax/minimax-m3` pins the director LLM (2026-07-21 trial:
  within 6 min of a clean journal+scratchpad it routed to and used the
  Training Area door and grew coverage — where phi-4 spent a full 30-min soak
  in the start apartment; launch.sh synced same day). Absent →
  `DEFAULT_MODEL=openai/gpt-oss-120b` (rynth/ai/llm_client.js:15). History:
  z-ai/glm-5.2 → microsoft/phi-4 (2026-07-20, via live location.href) →
  minimax-m3. Setting botModel forces **maxTokens:1280** (2026-07-20 latency
  fix — corrected here 2026-07-23; this line previously said 4096, which was
  the pre-fix value and the axis this rig's cadence math actually depends on)
  + reasoning effort low (url-flags.md §botModel).
- `thoughtOverlay=1` = stream teleprompter for journal `plan` entries;
  `streamHud=1` = inventory pane + buffs-HUD reposition. Both exact-match `1`.
- `botCtlOwner=<name>` (new 2026-07-23, P0 fix — rynth-review 13 #1): sets the
  in-game control-channel sender allowlist (`!bot ...` tells). Not yet in the
  baked flag block above — the channel's own default (the logged-in
  character, refuse-all if unresolvable) already closes the P0 hole even
  without it, but an operator running a second "trusted" character should add
  it explicitly (comma-separated for more than one name). See url-flags.md
  §botCtlOwner.
- Full reference: `apps/holtburger-web/docs/url-flags.md` §1.
- launch.sh and the live page are IN SYNC as of 2026-07-21 (the 2026-07-20
  drift is resolved). If you retune via `location.href` on the live page,
  re-sync launch.sh or a relaunch reverts it.
- Cadence math: effective check-in ≈ (model asks max = 2×interval) + 15-20s
  call latency ≈ 78s at 0.5; the 70-calls/hr cap floors sustained cadence at
  ~51s no matter how low the interval — `rynth/ai/director.js` now ALSO
  enforces this as a real minimum inter-call spacing floor (`3600/
  maxCallsPerHour` seconds, not just a rolling-window count), so a burst of
  early check-ins can no longer front-load the hour. The GLM fast-provider
  pin is z-ai/*-only; minimax/* gets its own (less battle-tested) pin as of
  2026-07-23 — see the `PROVIDER_PIN_TABLE` note in url-flags.md §botModel.

## Six hard-won traps (soak-11 §2 — all live-diagnosed)

1. **DPMS = the phantom perf killer.** Panel powering off kills Chrome's vsync
   source → ~1 fps rAF in EVERY window regardless of GPU. `launch.sh` runs
   `xset s off -dpms` + disables xfce4-power-manager DPMS. `xset` is
   session-scoped — RE-APPLY after any X restart (re-run `launch.sh`).
2. **Chromium session-restore tab wars.** A persistent profile restores old
   game tabs on relaunch; N tabs = N clients fighting one account → ACE
   boot-loop ("Account was logged in, booting…" ×58) → nothing can act.
   `launch.sh` purges `profile-game/Default/{Sessions,Session Storage}` (NOT
   Local Storage — the OpenRouter key lives there). Verify ONE page on CDP
   :9223 after launch.
3. **Duplicate-login boot dance.** Every relaunch triggers ACE's
   boot-old/drop-new handshake; the client's autoLogin retry lands ~10 s later.
   Boot scripts must reload-retry on **pose-based readiness**, NOT
   `__bootState` — the scene-ready 90 s watchdog latches `error` on slow boots
   while the session is actually fine.
4. **HTTP cache vs edited JS.** `nosw=1` bypasses the service worker but NOT
   the HTTP cache. After editing app JS, reload via CDP
   `Page.reload {ignoreCache:true}` or the page runs stale code. `nosw=1` alone
   does NOT cover this.
5. **Occlusion throttling / window stacking.** Both windows carry
   `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding`.
   Never raise the slate above the game (`wmctrl -a Intermission` was the
   mistake — it throttled the game renderer).
6. **fps expectations.** ~9 fps render at `targetFps=20` (wireframe, 720p,
   quiet CPU). Any local `cargo`/`rustc` (jobs=2) starves the browser to
   ~1–2 fps → batch builds or push to buildbox while streaming publicly.

## ffmpeg / VAAPI notes (see `go_live.sh` comments)

- Skylake iHD driver supports rate-control **CQP only** — no CBR (unsupported),
  and the older i965 driver crashes outright. Hence `-rc_mode CQP -qp 25`.
- **PATH trap:** bare `ffmpeg` resolves to `/home/wbterminal/bin/ffmpeg`
  (static 7.0.2, built WITHOUT VAAPI) which shadows apt's `/usr/bin/ffmpeg`
  (7.1.5, has `h264_vaapi`). `go_live.sh` pins the absolute `/usr/bin/ffmpeg` —
  keep it; bare `ffmpeg` fails with no VAAPI encoder.

## Bot boot notes

- `?bot=1` auto-boots on the kind=7 EnteredWorld handler, BUT a session-takeover
  reconnect skips kind=7 → no auto-boot. Reliable path after a relaunch: CDP
  `import rynth/bot.js` → `createGrindBot(window.__sessionHandle, {})`.
- Force a director check-in: `window.rynthAI.checkNow()`.

## Driving the rig from a Claude session (added 2026-07-20)

- **CDP attach without ws libs**: `chrome-devtools start --browserUrl
  http://127.0.0.1:9223` (the chrome-devtools-mcp CLI daemon in
  `~/.local/bin`), then `chrome-devtools evaluate_script "() => …"` /
  `list_console_messages` / `take_screenshot`. ⚠ The daemon TIMES OUT on
  evals that run >~5s and can wedge (restart: `chrome-devtools stop && start
  --browserUrl …`). For long in-page work use fire-and-forget: start an async
  loop that writes to a `window.__x` global, return immediately, poll the
  global from a later eval.
- **Reload/boot loop**: every reload corpse-collides (~60s ACE reap) —
  expect `__bootState==='error'` once, reload again, then in-world. Two
  reloads is normal, not a failure.
- **YouTube URL rolls**: page reloads are harmless (ffmpeg keeps the push),
  but if ffmpeg itself stalls/restarts long enough YouTube ends the broadcast
  and the resumed push gets a NEW watch URL — check YT Studio, don't trust an
  old link. Bounce the push cleanly: `kill <ffmpeg-pid>` (go_live.sh wrapper
  auto-restarts in 5s).
- **Window stacking check**: `DISPLAY=:0 xprop -root _NET_CLIENT_LIST_STACKING`
  — last id = topmost; the game window (0x32…) must be above the slate.
- **Bot memory wipe** (fresh-context / clean model test — no reload needed):
  the old hand-typed one-liner only ever cleared journal+scratchpad
  *localStorage* and silently left several RAM survivors alive (stale
  scratchpad RAM mirror, exploreMemory coverage/frontier, `_usedObjects`) —
  those kept contaminating every "clean model" run. Use the one-call wipe
  instead, which clears all of it and tells you exactly what it did:
  ```js
  const { wipeForCleanTest } = await import(new URL('rynth/ai/tools/memory.js', location.href).href);
  console.log(wipeForCleanTest(window.__bot.ai));
  ```
  (Pending wiring: this isn't yet exposed as `window.rynthAI.wipeForCleanTest`
  — that needs a one-line addition to bot.js's `window.rynthAI = {...}`
  object; until then, import `rynth/ai/tools/memory.js` directly as above.)
  Clears: journal entries (RAM array) + its localStorage key; the scratchpad
  (RAM mirror + localStorage key — the old leak: the RAM mirror used to
  survive a plain `localStorage.removeItem`, contaminating the next
  check-in); `exploreMemory` coverage/frontier/history RAM (so the LOCATION
  block stops showing the prior run's Covered/Frontier); `_usedObjects` /
  `_triedTotal` (the "already tried here" tracker); `combatMemory` RAM if a
  live instance is ever wired (dark/unattached today, so normally a no-op);
  `director._lastSummary` (display-only, cosmetic).
  Deliberately KEEPS untouched: `holtburger_ai_key_v1` (OpenRouter key) and
  `rynth.atlas.v1` (nav atlas). Also deliberately does **not** clear the
  `rynthAiOperatorStop` latch — a durable operator-stop must survive a
  "clean model" wipe by design — it only warns you if the latch is set (via
  the returned `warnings`); clear it separately with `window.rynthAI.start()`
  if that's not what you want. Read the returned `{cleared, warnings}` — it
  reports exactly what ran, so "was this actually clean?" has an answer.
- **Un-stick tool**: `window.__sessionHandle.sendChat('@telepoi <town>')` /
  `@teleloc <cell> <x> <y> <z>` (landblock-frame — confirmed 2026-07-20).
  Since the same date the MoveTo driver also self-recovers from wall wedges
  (±45° stall recovery, holtburger-core stall_recovery.rs). **Updated
  2026-07-23 (rynth-review 16 D4/07 — this diagnostic went stale the day
  after it was written):** the ">30s = a NEW bug, not the old wedge" reading
  is no longer safe on its own — `ea2cc7c3` ("settle-land", 2026-07-22, one
  day after this line was written) fixed a DIFFERENT freeze mode: an outdoor
  airborne latch that froze velocity into an unbreakable slide, which also
  presents as "standing still against/near geometry for a long time." So a
  >30s stall today is either (a) a genuinely new bug, or (b) a settle-land-
  class freeze if you're on a build predating `ea2cc7c3` — check the commit
  first before treating every long stall as novel. The general lesson
  (cross-cutting smell, 17-SYNTHESIS): this exact wording — "the mover is
  fixed now" — has been written and then quietly falsified four times
  (soak-9→10→11→STREAM-RIG-OPS→`ea2cc7c3`); treat any "self-recovers" claim
  about movement as "this leaf is fixed," not "movement freezes are solved."
- **Live-state probes**: pose `window.__sessionHandle.getLocalPlayerPose()`
  (`.free()` it); route `window.__bot.router.status`; director
  `window.__bot.ai.director` (`client.model`, `_callTimes`, `journal`);
  placement diag `window.__hbWasm.arrivalPlacementDiag()` (lo16 engaged /
  hi16 failed).
