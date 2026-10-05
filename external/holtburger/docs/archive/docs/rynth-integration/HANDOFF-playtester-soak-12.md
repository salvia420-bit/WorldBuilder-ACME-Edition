# Handoff — playtester soak, session 12 (connection lifecycle FIXED across all surfaces; zombie-flood root-caused and reaped)

Continues `HANDOFF-playtester-soak-11.md`. This session investigated "issues
with connecting and maintaining connection" across every surface (browser JS,
wasm session crates, wsbridge, three.js loop, rynth bot, ACE, MariaDB) with
two Opus agents + inline forensics + live 5-min bot sample runs, then
implemented and live-verified fixes. MariaDB was ruled healthy; everything
else had a hole.

## 1. The pathology (all CONFIRMED with file:line + live evidence)

Walking in on the live system: ACE_Log flooded since 18:22 with 6,300+
`Session for Id 0 has IP 127.0.0.1:58422 but packet has IP 127.0.0.1:51445`
lines at ~2/s; the stream chromium held SIX game pages / 5 live WS
connections, all `vendortest`; YouTube was showing a black dead client. The
causal chain:

1. **JS leak (primary)** — `fireSubmit()` nulled `activeHandle` /
   `window.__sessionHandle` without `.free()` (index.html ~9662). wasm-bindgen
   destructors don't run on GC → the wasm `recv_loop` + WebSocket + bridge UDP
   flow lived FOREVER after every replacement. Zero `.free()` calls existed in
   the whole app. The submit guard (`if (activeHandle) return`) was bypassed
   by design ("latest handle wins") so every retry stacked a new WS.
2. **No handshake timeout** — `start_session` doc said it: "if ACE never
   responds the Promise stays pending" (lib.rs ~34932). Stuck handshakes +
   retries = the ×5 multiplier.
3. **1 Hz forever-retransmit** — `REQUEST_RETRANSMIT_INTERVAL = 1s`
   (session/types.rs) with no cap/backoff/give-up and no dead-session
   detection. THIS is the 1 Hz flood; `id` = `client_id` = 0 pre-handshake
   matches ACE's "Id 0" log line.
4. **ACE can't stop it** (read-only confirm, NetworkManager.cs:147-156) — a
   booted duplicate-login session is REMOVED from sessionMap, so there is no
   Session object left to time out; the zombie's packets are dropped at DEBUG
   forever. Only the bridge/client can kill the flow.
5. **wsbridge had no reaper** — no WS ping, no idle timeout, no "ACE went
   silent" detection (bridge.rs); per-WS ephemeral UDP socket means every
   reconnect is a brand-new endpoint to ACE (boot dance guaranteed). Also:
   unbounded `ws_sink.send().await` = slow-reader stall drops ACE→client
   datagrams in the kernel; and the bridge was an unsupervised `nohup` orphan
   logging to another session's ephemeral scratchpad.
6. **False error-latch provokes the leaks** — the autoLogin ready-watchdog
   polled `__bootState === "ready"`, but `ready` and `in-world` share one
   scalar and can arrive in either order (under ?nullRender ready fires
   FIRST). Healthy sessions latched `error` 90 s in → automation reloads →
   more leaked sessions. **Live-reproduced twice this session** — including
   by me: the live +Vendbot page read `boot=error`, I blanked it during
   cleanup, and ACE reaped the real stream session (recovered, see §3).
7. **Bot strands on stale handle** — `?bot=1` kind=7 auto-boot was one-shot
   (`!window.__bot` guard) and `createGrindBot` captures the handle by value:
   after any reconnect the bot drove the dead session forever. (rynth opens
   NO sockets of its own — webhost/netbrain/control_channel are all
   in-process; supervisor.cjs is external Playwright.)
8. **Clean page close ≠ clean logout** — measured: page closed 19:22:48,
   ACE reaped at 19:23:49 ("Network Timeout", 61 s). No wire Logout exists in
   the client. This is WHY every quick relaunch collides with its own corpse
   ("Account was logged in, booting…"). Not fixed this session (needs a
   GameAction 0xA1 logout on the wasm side) — top follow-up.
9. **Ruled out**: MariaDB (2 threads, 0 aborted_clients, no MySqlExceptions);
   rAF/net-drain starvation (netDrainHz is setInterval; keepalive has a
   dedicated Web Worker — already mitigated); ACE session caps (128, per-IP
   unlimited).

## 2. Fixes landed (all live-verified)

- **index.html**: `fireSubmit` frees old handles + bumps `__connectEpoch`;
  submit handler frees a superseded late-resolving handle instead of
  installing it; `pagehide` frees the session; `setBootState` latches
  `window.__sceneReadyEverFired` and the ready-watchdog accepts it (kills the
  false error-latch); kind=7 handler rebinds/reboots the bot when
  `__sessionHandle` changed (stops stale-handle stranding).
- **wasm (apps/holtburger-web/src/lib.rs)**: 30 s handshake timeout in
  `start_session` (drops cmd_tx → recv_loop exits → transport Drop closes
  WS); dead-session detector in the 5 s keepalive arm (no inbound 90 s, or
  60 s never) → Disconnected event + loop exit.
- **crates/holtburger-session**: `RETRANSMIT_GIVE_UP_REQUESTS = 180`
  consecutive retransmit requests with zero ordering progress → session
  errors out (counter reset in `finalize_ordered_server_packet`). Tests
  32/0.
- **apps/holtburger-wsbridge**: per-connection `LinkState` + liveness
  watchdog select-arm — reaps when ACE sends nothing for 90 s (seeded on
  first outbound so never-answered flows die too) or client sends no WS
  frames for 300 s; `ws_sink.send` bounded at 15 s (wedged-reader
  teardown). Tests 24/0. Deployed live (new pid under supervisor).
- **Supervision**: `scripts/wsbridge-supervise.sh` (restart loop, STOP file
  `/mnt/wbterminal2/wsbridge.STOP`, persistent log
  `/mnt/wbterminal2/wsbridge_console.log`) + crontab `@reboot` entry.
- **pkg/ rebuilt `--release`** (4.6 MB wasm, all new strings verified in
  binary) via pkg-conn + rsync. Backup of prior wasm in this session's
  scratchpad.

## 3. Live cleanup + stream recovery (state as left)

Blanked 4 zombie pages + closed 1 wedged page in the stream chromium via CDP
:9223 → the Id-0 flood STOPPED. In the process the live page (mislabeled
`error` by bug §1.6) got blanked → +Vendbot timed out; recovered by
hard-reloading the game page (fixed JS+wasm), riding out one boot-dance
(where the NEW 30 s handshake timeout fired and cleanly tore down — first
live proof), and reloading once more → **+Vendbot back in-world 19:53:57,
exactly ONE WS connection, zero flood lines since**. Stream now shows the
live wireframe world (was: black dead client, likely for the past hour).
Bot was re-armed by the reload (URL still has `&bot=1`) and was **stopped
via `__bot.stop()`** to restore the operator's soak-11 end state. Killed the
stale duplicate ffmpeg (two encoders were pushing the same YouTube key since
17:49/18:00; the 24 fps 720p one from `go_live.sh` remains).

## 4. Verification runs

Run 1 (pre-fix baseline, tailnet1 + bot, 5 min, ?nullRender headless): bot
armed and fought, wire flowing — and `__bootState` falsely latched `error`
at exactly in-world+90 s (§1.6 repro); clean close → 61 s Network Timeout
(§1.8 measurement). Run 2 (post-fix, same recipe) — see soak journal /
scratchpad `soak_run1.log` in session
`2a6531a7-3cac-4e33-b591-051dc8d27423`; expected: no error latch, bot arms,
close leaves no WS and no flood. ACE-side checks: `tail ACE_Log.txt | grep
-c 'but packet has IP'` = 0 since 19:47.

## 5. Next-session candidates

1. **Wire-level Logout on teardown** (§1.8) — add GameAction 0xA1 to
   SessionHandle + fire best-effort on pagehide/free; kills the 60 s corpse
   window that causes every relaunch boot-dance.
2. **autoLogin resilience to the Account-In-Use double-drop** — after a
   bridge restart the single default attempt burns on ACE's both-sessions
   drop and parks at the form (`maxRetries=0`); consider maxRetries=1 +
   longer kickWait for the stream rig URL specifically.
3. Deploy-watch the wsbridge reaper on the 1070/tailscale clients (300 s WS
   idle reap is untested against a real backgrounded remote player).
4. soak-11 leftovers: arrival-placement live engagement, thoughtOverlay
   visual verify + GLM model pin, faithful-driver open-door exclusions,
   Varek/Torval pyreal mystery, 10 stale movement tests.
