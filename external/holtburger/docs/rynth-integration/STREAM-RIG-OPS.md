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
&password=vendortest&autoSpawn=first&kickDance=1&agent=1
&thoughtOverlay=1&bot=1&streamHud=1&botModel=z-ai/glm-5.2&botInterval=1
```

- `botModel=z-ai/glm-5.2` pins the director LLM (operator's GLM choice);
  absent → `DEFAULT_MODEL=openai/gpt-oss-120b` (rynth/ai/llm_client.js:15).
- `thoughtOverlay=1` = stream teleprompter for journal `plan` entries;
  `streamHud=1` = inventory pane + buffs-HUD reposition. Both exact-match `1`.
- Full reference: `apps/holtburger-web/docs/url-flags.md` §1.

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
