# Network adapter: analysis, Wi-Fi vs wired, and care (2026-10-23)

The "network adapter" is the pair that carries the AC protocol between the browser and ACE:
`holtburger-transport-ws` (`WsTransport`, in the wasm session) and `holtburger-wsbridge` (WS↔UDP, on the
laptop next to ACE). This note covers how it interacts with ACE and holtburger-web, the measured cost of the
laptop's far-corner Wi-Fi, the calculated difference once the laptop is cabled to the modem, and what was
changed.

## Summary

- **The adapter code is not the problem.** TCP_NODELAY is set on both ends (be09034a), every frame is flushed
  as its own write, there is no WebSocket compression, and the client sends straight from the session to
  `WebSocket.send`. What hurt on 2026-10-21 was the transport underneath: one thin TCP stream over a weak,
  loaded Wi-Fi link (−74 dBm), where a single late or lost segment holds back everything behind it.
- **Wired, calculated:** AP→echo p50 277–721 ms → about 15–20 ms, p90 0.9–2.9 s → about 30 ms. Leash
  incidents ~18 per 30 s → none. Latency added by bulk traffic +25–180 ms → about 0. Asset throughput out of
  the laptop 83–95 Mbit/s → about 940 Mbit/s. This assumes the 1070 is on a cable too; that is not known yet
  (§7).
- **Care given:** the live bridge was a 2026-10-08 build missing the 10-13 fixes, so it was rebuilt, tested
  and redeployed. The ACE session now ends ~2 s after a browser dies instead of after 60 s; this was checked
  live. The bridge now measures and logs its own link to the browser. `scripts/net-health.sh` records a
  repeatable before/after probe, and the Wi-Fi baseline is saved.
- **ACE side (§9):** ACE's DAT files moved from the USB hard drive to the SSD (0.92 GB). ACE's physics reads
  them on its world thread, and cold reads on the USB drive are what most likely froze the server for up to
  2.7 s.

## 1. The path

```
1070 Chrome ── holtburger-web (wasm session, holtburger-session)
   └─ WsTransport: one WebSocket; binary frame = [port u16 BE][one AC packet]
        └─ tailscale (WireGuard, UDP 41641)   or   the SSH tunnel's -R 8080
             └─ 1070 192.168.2.200 ⇄ BELL815 Home Hub ⇄ laptop Wi-Fi (5 GHz ch 44, 80 MHz)
                  └─ holtburger-wsbridge :8080, one UDP socket per connection
                       └─ ACE UDP :9000 (login) / :9001 (world), same laptop (loopback)
```

The page and its assets (`serve.py` :8765) and CDP reach the 1070 over the same Wi-Fi, through the SSH tunnel.

- **The AC protocol runs end to end.** The bridge never parses or alters relayed bytes: ISAAC, sequence
  numbers, ACKs and NAK/retransmit live in the wasm session and in ACE. Over TCP that reliability layer stays
  idle (10-21: no NAKs, no client retransmits), because TCP already delivers everything. It delivers in order,
  though, so a lost segment stalls every packet behind it.
- **The game stream is a thin stream:** a few small packets per tick. TCP cannot fast-retransmit with so few
  packets in flight, so recovery waits for the tail-loss probe or the retransmission timer (≥ 200 ms on
  Linux, 394 ms as measured on 10-21).

## 2. One position echo, hop by hop

The leash (`ConstraintManager`, `crates/holtburger-world/src/spatial/position_manager.rs` `adjust_offset`)
scales the run by `(50 − d)/(50 − 10)` once `d`, the distance since the last echoed position, passes 10 m
outdoors (5/20 m indoors). At ACE's run cap of 18 m/s, slowdown starts when the echo is 0.56 s stale and the
player stops at 2.8 s. The client sends an AutonomousPosition every 2.5 m (`AP_TRAVEL_RESEND_M`), which is
every 139 ms at 18 m/s.

| Hop | Mechanism | Wired | Wi-Fi, 10-21 |
|---|---|---|---|
| Client send | AP built in the frame pump, `ws.send` immediately | ~0 | ~0 |
| Browser → laptop | TCP over tailscale | ~0.3 ms | HOL stalls, bunching |
| Bridge | `ws_stream.next()` → `udp.send_to` | µs | µs |
| ACE inbound | I/O thread → `InboundMessageQueue`, drained every world-loop pass (`Thread.Sleep(1)`) | ~1 ms | same |
| ACE apply | `SetRequestedLocation` **overwrites**; applied on the 60 Hz physics tick (`Player.UpdateObjectPhysics`) | 0–16.7 ms | APs arriving together collapse into one tick |
| ACE send | echo bundled, ≥ 5 ms between bundles (`NetworkSession.minimumTimeBetweenBundles`) | 0–5 ms | same |
| Laptop → browser | TCP back | ~0.3 ms | HOL stalls; echoes arrive in bursts 0.3 ms apart |
| Client drain | next frame pump (12.5 ms at 80 fps) | 0–12.5 ms | same |
| **AP→echo** | | **~2–37 ms, p50 ≈ 15–20, p90 ≈ 30** | **p50 277–721 ms, p90 0.9–2.9 s, max 4 s** |

The overwrite in `SetRequestedLocation` explains the 10-21 symptom that 32–50 % of APs were "never echoed":
they reached ACE several at a time and only the last one in each tick was applied. With APs 139 ms apart and
a 16.7 ms tick, that rate falls to about 0 % on a clean link.

## 3. Measurements

### 3.1 2026-10-21, owner playing on the 1070 (HANDOFF-owner-bugs-2026-10-11.md §7 follow-up)

- **Signal:** −74 dBm, 5 GHz.
- **Bridge socket** (`ss -tin`): srtt 132 ms, min 4 ms, rto 394 ms, 20 retransmits, 19 of them spurious
  (DSACK: the original arrived, later than the RTO).
- **AP→echo:** p50 277–721 ms, p90 0.9–2.9 s, max 4 s. 109 `cause=leash` incidents (ratio 0.40–0.80, echo
  age 0.7–2.1 s), about 18 per 30 s even with `?apTravelResend`.
- **Correction to that write-up:** the bridge's srtt is measured data→ACK, and Windows delays its ACK by up to
  200 ms when it has nothing to send, so part of the 132 ms is the peer's ACK timer, not the path. The
  spurious retransmits and the AP→echo times are the solid evidence: ACKs later than 394 ms need a real path
  delay, and the echo times are measured in the page.
- **Bridge log** (`/mnt/wbterminal2/wsbridge_console.log`): over the SSH tunnel 20:06–21:57Z, direct over
  tailscale 21:57–22:17Z.
- **tailscale** (`/var/log/tailscaled.log`, the 1070 is `[CSUMh]`): direct over the LAN to
  192.168.2.200:41641, but about once a minute it re-picked a path through the hub's public-IP hairpin
  (142.68.244.245:11812) and back. Twice (18:32–18:38 and 19:01 local) it also used the New York DERP relay,
  about 100 ms per round trip. Those fallbacks mean disco pings went unanswered on the Wi-Fi.

### 3.2 2026-10-23, laptop in the same spot (the 1070 offline)

From `scripts/net-health.sh --load` (`/mnt/wbterminal2/net-health/20261023T111347Z-wifi-baseline.txt`; a
manual run earlier the same morning agreed).

| | Result |
|---|---|
| Link | BELL815, 5220 MHz, 80 MHz, −72 dBm (beacon −66). PHY tx 195–260 Mbit/s (MCS 2–4, falling to MCS 2 under load), rx 195–263. Power save off. |
| MAC tx retries | 6.9 % of frames over 2.6 days; rx drop misc ~1 % |
| Gateway, idle | p50 1.0, p90 1.8, p99 2.8, max 6.5 ms, 0 % loss |
| Gateway during a download (210 Mbit/s) | p50 36, p90 103, p99 157, max 180 ms, 0.6 % loss |
| Gateway during an upload (83–95 Mbit/s) | p50 26–29, p90 45–50, p99 72–90, max 88–131 ms, 0.2–0.8 % loss |

- **At idle the Wi-Fi is fine.** Under bulk load it adds tens to ~180 ms and starts dropping packets.
- **Running in-game is bulk load:** the client streams landblock assets from the laptop while the game
  socket shares the link, and through tailscale everything is a single UDP flow, so the per-flow queues
  (mac80211 FQ-CoDel, the hub) cannot keep the game's small packets ahead of the asset bytes.
- **10-21 was worse than this probe** (delays past the 394 ms RTO): two-way bulk (assets out; CDP screenshots
  and profiles in), a weaker signal, and household traffic on the same radio.

## 4. The difference, calculated

| | Wi-Fi (measured) | Wired (expected) | Factor |
|---|---|---|---|
| AP→echo p50 | 277–721 ms | ~15–20 ms | 15–40× |
| AP→echo p90 | 0.9–2.9 s | ~30 ms | 30–100× |
| Leash distance at echo time, `18 m/s × (AP→echo + 0.139 s)`, p50 | 7.5–15.5 m (start is 10 m) | ~2.8–3.2 m | — |
| Leash distance, p90 | 19–55 m (stop at 50 m) | ~3 m | — |
| Leash incidents | ~18 per 30 s | 0 (needs a stall over ~0.38 s) | — |
| APs collapsed in one ACE tick | 32–50 % | ~0 % | — |
| Extra latency while assets stream | +25–40 ms p50, +45–100 ms p90, up to 180 ms; ~1 % loss | ~0 (switched gigabit LAN) | — |
| Asset throughput out of the laptop | 83–95 Mbit/s | ~940 Mbit/s | ~10× |
| Time to send 5 MB of assets (an example; serve.py does not log sizes) | ~0.45 s | ~0.04 s | ~10× |
| Gateway RTT, idle | 1.0 ms p50, 2.8 ms p99 | ~0.3 ms, flat | ~3× |

- **Wired estimate:** the sum of §2's hops with a ~1 ms network round trip.
- **Wi-Fi leash rows:** computed from the 10-21 echo times. The measured leash ratios (0.40–0.80 = 18–34 m)
  fall inside those ranges.
- **After cabling, only client or server hitches can trip the leash:** stalls over ~0.38 s, such as a long
  frame on the 1070 or an ACE pause.

## 5. What was changed

### 5.1 The live bridge was two weeks stale (fixed)

- **Evidence:** the supervised bridge had run since 2026-10-08 16:30 from a build of that afternoon. It had no
  `admission:` startup line and no `Disconnect for session` string in the binary. The 2026-10-13 work
  (net-transport-2: Disconnect on teardown; net-transport-5: target allowlist, Origin check, connection caps)
  had never run.
- **What that cost, from the ACE log since 2026-08-02:** 1,004 sessions ended by `Network Timeout` (the
  character left in the world for 60 s after its socket was gone) against 311 clean `PacketHeader Disconnect`
  endings, plus 280 `Account was logged in, booting…` collisions. Overnight probe sessions on 10-23 showed the
  pattern: ACE dropped each one ~61 s after the bridge saw the socket close.
- **Deploy:**
  - Rebuilt and tested with `capped-build cargo test --release -p holtburger-wsbridge`: 71 passed.
  - Canary on 127.0.0.1:18080: the allowed origin worked and a foreign origin got 403.
  - Swapped the idle live bridge through the supervisor (11:10Z) and smoke-tested it over loopback, the
    tailscale IP and the LAN IP.
  - The previous binary is at `/mnt/wbterminal2/holtburger-scratch/holtburger-wsbridge.20261008-pre-nethealth`.
- **Verified live:** a headless Chrome (`agentp10`, `?nullRender=1`) logged in through the bridge and was then
  SIGKILLed, so the client sent no Disconnect. The bridge logged `sent ACE a Disconnect for session id 0` at
  11:13:08Z and ACE dropped the session with `Reason: PacketHeader Disconnect` at 11:13:10Z, instead of a
  `Network Timeout` a minute later. This covers tabs that crash or get killed and links that drop. A clean
  relog (`page.goto('about:blank')`) already sent the client's own Disconnect on 10-21, so the runbook's 25 s
  relog gap is unchanged.

### 5.2 The bridge now reports its link (new)

`apps/holtburger-wsbridge/src/link_health.rs` (net-health), documented in the bridge's ARCHITECTURE.md
"Link health":

- **WebSocket ping round trip:** the bridge sends a Ping every 1 s (`--ws-ping-ms`, 0 = off) and the browser
  answers from its network stack. This is the honest latency of the hop, head-of-line stalls included. Pongs
  do not reset the 300 s idle reaper.
- **`TCP_INFO`:** min_rtt, srtt (with the delayed-ACK caveat above), rto, retransmits with dsack, RTO
  timeouts and the time spent recovering from them.
- **Frame and byte counts** each way.
- **Output:** a `link:` line per connection per minute and a `link summary` line at the end, in
  `/mnt/wbterminal2/wsbridge_console.log`. The 10-21 diagnosis no longer needs `ss -tin` by hand during play.
- **First real-Chrome reading** (headless, same host): ws rtt p50 0.2 ms, 72/72 pings answered, 0
  retransmits. The p99 of 62 ms came from the test browser booting at nice 15 under capped-build, not from a
  network.

### 5.3 A repeatable probe (new)

- `scripts/net-health.sh [--load] [--label NAME]` records:
  - the link (Wi-Fi signal, rates, retries; or Ethernet speed);
  - idle and loaded gateway RTT;
  - tailscale's path to the 1070;
  - live bridge sockets.
- It writes the result to `/mnt/wbterminal2/net-health/`. `--load` saturates the link for ~20 s, so don't run
  it while someone plays.
- The Wi-Fi baseline is the 20261023T111347Z file.

## 6. Reviewed and left alone

- **Bridge:**
  - NODELAY.
  - One flush per frame. Coalescing a burst into fewer segments would save Wi-Fi airtime but nothing on a
    cable.
  - 2 MiB UDP receive buffer; 15 s bound on a stalled send; 64 KiB message cap.
- **Client** (`crates/holtburger-transport-ws`): sends without batching; inbound goes to an unbounded channel
  drained by the frame pump. `?netWorker` stays off for human sessions, by design (url-flags.md).
- **ACE:** vanilla; its 60 Hz apply and 5 ms bundle pacing are the wired floor in §2.
- **TCP on the laptop:** BBR, fq_codel, TLP on. Thin-stream tuning (linear timeouts, a lower rto_min) only
  matters on a lossy link.

## 7. After the cable goes in

1. **Plug in.** Connect eth0 (Intel e1000e, gigabit) to a Home Hub LAN port. NetworkManager's "Wired
   connection 1" autoconnects with DHCP, and its route metric (100) beats the Wi-Fi's (600). Check with
   `ip route show default` (expect `dev eth0`) and `cat /sys/class/net/eth0/speed` (expect 1000).
2. **Decide on Wi-Fi.** Leave it as a fallback, or turn it off (`nmcli radio wifi off`) for a single path.
   With both up, the laptop holds two 192.168.2.x addresses and tailscale can still pick the Wi-Fi one.
   Only turn Wi-Fi off once the cable is confirmed up, or a remote session is cut.
3. **Re-run the probe.** `scripts/net-health.sh --load --label wired`, then diff it against the Wi-Fi baseline.
   Expect an idle gateway RTT around 0.3 ms that stays flat under load (the internet uplink becomes the
   bottleneck for those transfers, not the LAN), with no loss.
4. **Check the 1070 when it's back.**
   - `tailscale ping 100.127.215.75` should answer via 192.168.2.200:41641 in about 1 ms.
   - Check its own adapter (PowerShell `Get-NetAdapter | ? Status -eq 'Up'`). If the 1070 is on Wi-Fi, it
     becomes the remaining weak hop and is worth a cable too.
5. **First play session.**
   - The bridge's `link:` lines should read ws rtt around 1 ms with 0 timeouts. A few retransmits that are
     all dsack are fine: they are tail-loss probes beating the browser's delayed ACK, seen even on loopback.
   - `__diag.slowRun.summary()` should show no `cause=leash`.
   - For MODE P, prefer `bridge_url=ws://100.116.47.66:8080/`. The SSH tunnel carries assets, CDP and the
     game in one TCP connection, where a large asset response delays the game frames queued behind it. On
     the cable this matters less, but the direct socket has one fewer shared queue.

## 8. Not done

- **Not committed:** the bridge changes, the script and this note are in the working tree.
- **WebTransport datagrams** (QUIC, no head-of-line blocking) would be the structural fix for players on lossy
  links; a cabled LAN doesn't need it.
- **Clippy** is not installed for the toolchain, so it wasn't run. The build was warning-free.
- **Wired numbers in §4 are a calculation** until the cable is in and §7.3–7.5 confirm them.
- **ACE's OOM priority:** ACE runs at `oom_score_adj` 300, the class `oom-protect.sh` gives builds and Chrome.
  It is started from a Claude tool shell and inherits that score, and an unprivileged process can't lower a
  score root set. Under memory pressure it can be killed before the workload it serves. Starting it outside
  a Claude session (from cron it would sit at 0) avoids that; the 2026-10-23 restart kept the old behaviour.

## 9. ACE's DAT files moved to the SSD

- **Why:**
  - ACE logs every object whose physics update takes 10 ms or more. Since 08-02, 67 distinct player updates
    took over 100 ms, 13 over 0.38 s (enough to trip the leash at 18 m/s on a clean link) and 6 over a
    second (worst 2.7 s). The 10-21 session had four of 116–252 ms.
  - ACE's physics reads cell and portal data on first use, synchronously on the world thread
    (`ACE.Server/Physics/Common/DBObj.cs` → `ReadFromDat`), and `DatFilesDirectory` pointed at the USB hard
    drive. Landblock database loads already run in a `Task.Run`; these reads do not.
- **Measured:**
  - A cold 4 KiB random read costs 6.5 ms median and 21 ms worst on the USB drive while it spins, and 0.36 ms
    median and 0.72 ms worst on the SSD.
  - One DAT lookup takes several such reads. The worst stalls (2.1–2.9 s) match a USB drive spinning up from
    standby.
- **Cost:** 920.7 MB of SSD (`/` free 7.60 → 6.68 GB, 94 % → 95 %). The 1.3 GB `client_highres.dat` stays on
  the USB drive behind a symlink (ACE: "not required for ACE operation").
- **What changed:**
  - `/home/wbterminal/ace-dats-ssd/ace-r10-dats/`: cmp-identical copies of `client_cell_1.dat`,
    `client_portal.dat` and `client_local_English.dat`, plus the highres symlink. A `README.txt` sits in
    `/home/wbterminal/ace-dats-ssd/`.
  - ACE's `Config.js` `DatFilesDirectory` now points at that folder. Only that line changed; the backup is
    `Config.js.bak-20261023-pre-ssd-dats` in the ACE bin dir.
  - ACE was restarted at 09:05 local (`stop-now`, ~20 s to "World is now open"). Nobody was in-world.
- **Verified:**
  - ACE logged all four DATs opened from the new path with the same iterations as before (cell 982, portal
    2074), and its open handles point at the SSD copies.
  - A headless login through the bridge reached `ready` in 5.2 s and left cleanly.
- **Not yet shown:** that the stalls are gone. The new copies were still in the page cache, so a quick test
  can't tell; real sessions will. Compare distinct player stalls of 100 ms or more per play-hour, before and
  after 2026-10-23 09:05, in `ACE_Log.txt` (`[PERFORMANCE][PHYSICS]` lines; one stall can log twice, as
  `UpdatePlayerPosition` and `UpdateObjectPhysics`).
- **Keep in sync:** if the server's DAT set changes (a new dat-patch release), copy the new files into the SSD
  folder too, or ACE keeps serving the old ones (the README there has the command).
- **Roll back:** restore the Config.js backup and restart ACE. The USB originals were not touched.
