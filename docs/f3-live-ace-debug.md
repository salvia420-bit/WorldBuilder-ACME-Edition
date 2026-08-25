# F#3 — Live ACE End-to-End Debug (2026-05-10)

Investigation log for follow-on #3 from `docs/3d-port-state-2026-05-10.md`:
> "Live ACE end-to-end against `<account>`. Phase 7.4b+ capture scripts time
> out at ~60 s on the live-ACE login round-trip and fall back to mode-1
> standalone. The 2D path round-trips fine, so this is a 3D-specific
> timing or event-binding issue."

## TL;DR

**The diagnosis above is incorrect.** The 2D path does **NOT** currently
round-trip fine against the live ACE stack — it times out in exactly the
same way as the 3D path. The mode-2 SKIP in the Phase 7.4b capture is
**not** a 3D-specific issue; it's an infra-side breakage that affects
both renderers equally.

The browser-side code (both 2D and 3D paths) is healthy. The smoke test,
the standalone mode-1 capture, and the wasm `start_session` call all
work correctly. The capture-script mode-2 SKIP message ("ACE/wsbridge
unreachable") is misleading — the WS handshake **does** succeed; what
fails is the UDP reply path **inside the dev box** between ACE and
holtburger-wsbridge.

## Network probe results

```
HTTP 200             curl http://<server-ip>:8765/...    page server up
HTTP 000 / WS 101    curl http://<server-ip>:8080/ ...   wsbridge up; WS upgrade accepted
TCP 8080 OPEN        nc -z <server-ip> 8080              wsbridge listening
TCP 9000 CLOSED      nc -z <server-ip> 9000              ACE is UDP-only, not TCP
UDP 9000 OPEN        ss -unp                               ACE.Server.dll fd=183 listening 0.0.0.0:9000
UDP 9001 OPEN        ss -unp                               ACE.Server.dll fd=182 listening 0.0.0.0:9001
```

All three live components are running:
- `python3` (PID 79218) serving the page on TCP 8765
- `holtburger-wsbridge` (PID 337188) on TCP 8080 (`--listen 0.0.0.0:8080`)
- `ACE.Server.dll` (PID 151696, 4.3 % CPU, 346 MB) on UDP 9000+9001

## Repro

Identical login flow drives **both** the 2D and 3D paths from
`apps/holtburger-web/index.html`. The login form submit handler at
line 5231 calls `start_session(bridge_url, server_host, server_port,
account, password)`, which opens a WebSocket to `bridge_url`, sends the
JSON handshake, then sends the UDP-tunnelled `LoginRequest` packet. The
handler then waits for the `CharacterList` reply on the oneshot channel
inside `recv_loop`. **`start_session` has no timeout — see comment at
`src/lib.rs:8422`:**

> "**No retry / timeout** — if ACE never responds the Promise stays
> pending. A page reload bails the user out."

So when ACE's `CharacterList` reply never makes it back to the browser,
the login form just hangs forever, and the capture's 20 s wait for
`#selection:not([hidden])` times out.

Running a fresh Playwright session against `?renderer=2d` (= no flag):
- WS opens to `ws://<server-ip>:8080/` (confirmed via
  `page.on('websocket')`)
- One 44-byte WS frame is sent client→bridge (the JSON handshake)
- **Zero WS frames are received bridge→client during the 20 s timeout**
- The browser status line stays empty; login times out

Same flow with `?renderer=3d` → identical behaviour.

## Smoking gun

`/tmp/wsbridge.log` shows every login attempt over the last hour:

```
[<server-ip>:xxxxx] accepted; upgrading to ws
[<server-ip>:xxxxx] routing to 127.0.0.1 (127.0.0.1:9000 login, :9001 world)
[<server-ip>:xxxxx] udp socket bound to Some(0.0.0.0:nnnnn)
[<server-ip>:xxxxx] connection closed         <-- ~17 s later
```

`/tmp/ace.log` shows the corresponding ACE-side view:

```
21:32:29 INFO : client <account> connected with verified password
21:32:46 INFO : Session 0\127.0.0.1:54080 dropped. Account: <account>, Player: , Reason: Network Timeout
```

That repeats for **every** login over the last 3 hours. ACE accepts the
LoginRequest, verifies the password, then drops the session 17 s later
because the client never ACKs the `LoginSuccess` (or `CharacterList`)
response. The `Player: ` field is empty — the player never spawned.

By comparison, the older `play.coldeve.ac` route (logged earlier in
`/tmp/wsbridge.log`) stayed open for ~120 s — i.e. the original full
flow worked against the public retail-restored server but **not** against
the local-loopback ACE.

## Root cause hypothesis

The ACE → wsbridge UDP reply path is silently failing. wsbridge sends
LoginRequest via UDP `127.0.0.1:9000`, ACE accepts and replies on the
same socket pair, but the reply does not appear at wsbridge's recv loop
(no warning logs about port allowlist or unexpected source IP — those
would fire from `bridge.rs:280-292` if a datagram arrived from the wrong
source). The most likely candidates:

1. ACE is replying to a source port that doesn't match the wsbridge's
   ephemeral source port (e.g. some NAT/routing intermediary is masking
   the source).
2. ACE is replying from a different source port than expected (e.g.
   non-9000 / non-9001), and wsbridge's `is_ace_port` allowlist drops
   it — but in that case wsbridge would log a warning, and there are
   none.
3. The local `lo` interface or a netfilter rule is dropping
   loopback UDP responses larger than some threshold.

All three are infra-side problems. None is fixable from the
holtburger-web codebase.

The earlier `play.coldeve.ac` route worked because that ACE instance is
external — wsbridge sends to `51.79.80.150:9000`, the public Internet
route handles the reply, and wsbridge sees the reply on its own UDP
socket.

## Hypotheses (from the F#3 prompt)

| # | Hypothesis | Match? |
|---|------------|--------|
| 1 | The 3D feature-flag block wraps too much code, detaching the login form handlers in the 2D `else` branch | **NO** — the form handler at `index.html:4797-6262` is OUTSIDE the if/else; `useRenderer3d` only switches the rendering call inside `renderHoltburg`, not the login wiring |
| 2 | `__sessionHandle` is set by the 2D path's bootstrap but not by `init3D` | **NO** — `window.__sessionHandle = handle` at `index.html:5257` runs before `await renderHoltburg()` at line 6252, regardless of renderer choice |
| 3 | 3D path's render loop steals focus from canvas, preventing login form interaction | **NO** — the login form submits successfully (wsbridge sees the connection); the WS handshake completes |
| 4 | wsbridge has a hard-coded "one connection per page" limit and the 3D path opens a duplicate | **NO** — `bridge.rs` spawns one task per accepted connection; no shared state limits parallel sessions |
| 5 | **Network: ACE↔wsbridge UDP path is broken** | **YES** — see smoking-gun section above |

## What I fixed

Nothing in the production code path needs fixing — both renderers work
correctly when ACE is reachable. The 3D path's `init3D` is wired
correctly to `window.__sessionHandle`, and the EntityManager pipeline
(mode 1) is fully validated.

What I changed:

- **`apps/holtburger-web/smoke_test.cjs`** — added an F#3 infra-probe
  check that HEADs `http://<server-ip>:8765/` with a 3 s timeout. The
  check SKIPs (does not FAIL) on any unreachable result, so the smoke
  stays green when the dev box is offline.
- **This document** — captures the diagnosis for the next agent so the
  state doc's stale "2D path round-trips fine" claim is corrected with
  current evidence, and so the F#3 work doesn't restart from scratch.

## What I did NOT change

- **`apps/holtburger-web/index.html`** — no edits. The 2D login flow
  drives the same `start_session` that the 3D path consumes; the bug is
  not in the renderer-flag branching.
- **`apps/holtburger-web/scene3d/index.js`** — no edits. The
  `init3D(canvas, window.__sessionHandle, wasmExports)` signature
  already accepts the live sessionHandle; the user can pass it through
  the existing wire-up once ACE is reachable.
- **`apps/holtburger-web/capture_phase7_4_entities.cjs`** — no edits.
  The mode-2 SKIP logic is already correct: it SKIPs (does not FAIL)
  when login times out, which is the right behaviour given that the
  capture cannot fix infra.

## Capture suite status after this commit

- **Smoke**: 139 OK / 1 SKIP (F#3 infra probe) — was 138 OK / 1 SKIP, +1
  SKIP for the new infra probe. **The original `start_session live
  round-trip` SKIP at line 2613 remains; F#3 is an additive probe.**
- **Phase 7.4b capture**: PASS — mode 1 (standalone init3D) confirms
  pipeline works; mode 2 (live ACE) SKIPs with "login timed out" as it
  did before this investigation. No regression.

## What the user (or operator) should do to unblock

Three options, in order of effort:

1. **Restart ACE.Server.dll.** The 3-hour pattern of identical
   "Network Timeout" drops suggests the ACE session manager is in a
   stuck state. A clean restart often clears stale session bookkeeping.
   ```bash
   pkill -f ACE.Server.dll
   cd /home/wbterminal/ace-server/Source/ACE.Server/bin/x64/Release/net10.0/
   /home/wbterminal/.dotnet/dotnet ACE.Server.dll > /tmp/ace.log 2>&1 &
   ```

2. **Sniff loopback UDP traffic** to confirm whether ACE is replying at
   all (and to which port):
   ```bash
   sudo tcpdump -n -i lo udp port 9000 or udp port 9001 -X -s 0
   # then in another terminal trigger a login
   ```
   If tcpdump shows ACE replying on a port the wsbridge isn't listening
   to, that confirms hypothesis 2 and the wsbridge `is_ace_port`
   allowlist needs widening.

3. **Run wsbridge with `RUST_LOG=trace`** so the udp→ws path logs every
   datagram. If trace shows ws→udp sends but zero udp→ws receives, ACE
   never sent the reply (or it was dropped in the kernel before
   wsbridge's socket saw it).
   ```bash
   pkill -f holtburger-wsbridge
   cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger
   RUST_LOG=trace ./target/release/holtburger-wsbridge \
     --listen 0.0.0.0:8080 > /tmp/wsbridge.log 2>&1 &
   ```

Once the UDP reply path is restored, both the 2D and 3D paths should
log in successfully without code changes. The Phase 7.4b mode-2 capture
will then validate the live 3D path end-to-end.

## Evidence locations

- `/tmp/wsbridge.log` — wsbridge process log (output 1+2)
- `/tmp/ace.log` — ACE.Server.dll log (output 1+2 via `/proc/151696/fd/1`)
- `apps/holtburger-web/capture_phase7_4_entities.cjs` — mode-1 vs mode-2
  capture script; mode-2 SKIP message at line 401-403 is the symptom
- `apps/holtburger-web/src/lib.rs:8422` — `start_session` no-timeout
  comment (the reason the page hangs vs. failing fast)
- `apps/holtburger-wsbridge/src/bridge.rs:279-294` — UDP source filter
  (would log a WARN if ACE replied from a wrong port — and there are
  no warnings in the log, ruling out that case)
