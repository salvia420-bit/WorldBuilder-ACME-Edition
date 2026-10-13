# holtburger-wsbridge — Architecture

> Phase 1 deliverable of [`emit-dynamic-site`](../../../../docs/emit-dynamic-site.md).
> Two Rust binaries that, together, tunnel an Asheron's Call ACE session
> over WebSocket — transparently, with neither binary parsing AC bytes.

## What's in this crate

Two binaries, one wire format, one shared library (`src/lib.rs`):

| Binary                | Source                  | Sits in front of            | Role                                                                                       |
|-----------------------|-------------------------|-----------------------------|--------------------------------------------------------------------------------------------|
| `holtburger-wsbridge` | `src/main.rs`           | ACE server (UDP)            | Accepts WS, forwards each frame to ACE's UDP login/world ports.                            |
| `holtburger-wsshim`   | `src/bin/wsshim.rs`     | unmodified `holtburger-cli` | Listens on UDP where the cli expects ACE; forwards each datagram over WS to a remote bridge. |

The full Phase-1 loop:

```text
  holtburger-cli ─udp─▶ wsshim ─ws─▶ wsbridge ─udp─▶ ACE
                ◀─udp─        ◀─ws─          ◀─udp─
```

Neither binary does crypto or knows about players or login state, and both relay every AC datagram unchanged. The shim is a pure pipe. The bridge reads AC packet headers in exactly two places, neither of which alters a relayed datagram: the opt-in capture's LoginRequest redaction, and the session id it keeps so it can send ACE a Disconnect when a connection ends (see [Ending the ACE session](#ending-the-ace-session-disconnect-on-teardown)).

## Why both halves exist

Browsers cannot speak UDP, but ACE only speaks UDP. The bridge is the seam between the two transports for the future browser client (Phase 2; the bridge is its WS counterpart on the server side, ready before the WASM port lands).

The shim is the seam for *today's* native cli. Useful before the WASM port lands as a way to validate the bridge end-to-end against a real client; useful afterwards as a fast iteration loop for any AC tooling that speaks UDP.

## Frame protocol

Each WebSocket binary frame is one AC packet, prefixed by a 2-byte big-endian port number:

```
┌────────┬────────────────────────────┐
│ port   │ ac_packet_bytes …          │
│ u16 BE │ (one full AC packet)       │
└────────┴────────────────────────────┘
   2 B          1..65533 B
```

**Browser/shim → bridge.** `port` is the *destination* — which ACE port to send to. Bridge sends `ac_packet_bytes` via UDP to `(ace_host, port)`. Frames whose port is not on the configured allowlist (login or world) are rejected and the connection is closed.

**Bridge → browser/shim.** `port` is the *source* — which ACE port the datagram came from. The receiver synthesises a `SocketAddr` from a fixed IP (the bridge endpoint, stable per session) plus this port.

### Why prefix the port?

The AC handshake at [`auth.rs:33-66`](../../crates/holtburger-session/src/session/auth.rs) moves the client mid-session from talking to ACE's login port to its world port (`login + 1`). The receive path at [`receive.rs:13-81`](../../crates/holtburger-session/src/session/receive.rs) accepts datagrams from *either* address during the transition, then atomically switches.

That means a single WS connection's outbound traffic targets two distinct UDP ports over its lifetime, and inbound traffic arrives from two distinct source ports. The frame must convey which. The 2-byte port prefix is the smallest honest framing that does so without inventing a control channel.

Other shapes considered:

- **No prefix, one bridge per ACE port.** Browser opens two WS connections (one for login, one for world). Costs: two TCP handshakes, more half-open-connection edge cases, the receiver has to multiplex across two WS sockets to satisfy a single `recv_from` call. Rejected.
- **Out-of-band control channel.** Browser sends a JSON "switch destination port" message; bridge re-aims its UDP socket. Costs: stateful bridge, race conditions during the handshake window when both ports are simultaneously active. Rejected — the design doc explicitly wants a stateless bridge.
- **Embed full SocketAddr.** Prefix is `[ip:4][port:2]` instead of just port. Costs: 4 extra bytes per packet for no value (the bridge resolves the IP at startup; the receiver doesn't pick it). Deferred to a multi-server future (open question §7.6 in the design doc).

## holtburger-wsbridge (server-side)

### Connection lifecycle

```
                        ┌──────────────┐
                        │ WS listener  │  bind(0.0.0.0:8080)
                        └──────┬───────┘
                               │ accept (connection caps)
                  ┌────────────▼────────────┐
                  │   per-conn handler      │
                  │  · upgrade WS (Origin)  │
                  │  · JSON hello (targets) │
                  │  · UdpSocket::bind 0:0  │
                  │  · spawn ws_to_udp      │
                  │  · spawn udp_to_ws      │
                  │  · join either; cancel  │
                  └─────────────────────────┘
```

[Admission](#admission) runs at the three steps marked in parentheses. Either task ending (WS close, UDP error, malformed frame), or the liveness watchdog reaping a silent flow, cancels the others. The bridge then sends ACE one Disconnect for the session the connection carried (next section) and tears down the UDP socket. Per-connection state is the two sockets, the watchdog's liveness clocks, and that session id.

### Ending the ACE session (Disconnect on teardown)

ACE routes a client packet by its header Id and accepts it only from the session's C2S endpoint (`NetworkManager.ProcessPacket`: `session.EndPointC2S.Equals(endPoint)`). For a bridged client that endpoint is the bridge's per-connection UDP socket, so once the WebSocket is gone nothing else can end the session. A clean client sends its own retail Disconnect first (`holtburger-session` `send_disconnect`, in direct and `?netWorker` mode alike), but a crashed or killed tab, a closed laptop lid, a dropped browser-to-bridge link, or a watchdog reap never does. Without a Disconnect ACE keeps the session for its 60 s network timeout: the character stays in the world, and a relogin inside that window boots the old session and is itself rejected (`AuthenticationHandler`, `account_login_boots_in_use`).

So whenever a connection ends, however it ends, the bridge sends one 20-byte cleartext packet from that connection's UDP socket to ACE's **login** port (ACE's world-port listener accepts only ConnectResponse and CICMD): sequence 0, flags `DISCONNECT` (0x8000), the session id, time/size/iteration 0, and checksum = Hash32 of the header with `0xBADD70DD` in the checksum field. ACE checks that checksum and terminates the session before it orders packets (`NetworkSession.ProcessPacket`). The send is bounded (500 ms) and best-effort.

The session id is the low word of `CConnectHeader.NetID` in ACE's S2C ConnectRequest, the value retail keeps as its net id (acclient.c `ClientNet::HandleConnectionRequest`). The bridge reads it from every accepted S2C datagram that is a ConnectRequest; a later one (a fresh handshake on the same socket) replaces it. C2S header Ids are not used: ACE numbers sessions from 0, and the LoginRequest and holtburger's ConnectResponse also carry Id 0, so a C2S Id of 0 does not say whether a session exists. A connection that never got a ConnectRequest sends nothing. A Disconnect for a session the client already ended matches no live session from this socket, so ACE only logs it. The same packet is what WebAC's bridge sends on close. Implementation and tests: `src/disconnect.rs`.

### Admission

The bridge listens on every interface by default, and the destination is chosen by the client, so without limits any web page that a browser on the LAN, the tailnet or the public cloudflared tunnel (`scripts/proxy.cjs`) can load could use it as a UDP relay to any host and port, and an unbounded number of connections could exhaust its file descriptors. Admission runs in three steps (`src/admission.rs`, modelled on WebAC's bridge `admit()`):

1. **Connection caps, at accept.** `--max-conns` (default 256; each connection holds two file descriptors) and `--max-conns-per-ip` (default 16). Loopback peers count only toward `--max-conns`: behind proxy.cjs, cloudflared or an SSH tunnel every peer is 127.0.0.1, so a per-IP cap there would throttle the whole tunnel as one client. A refused socket is closed without a reply. The slot frees when the connection's handler exits, however it exits.
2. **Origin, during the HTTP upgrade.** Refused with `403 Forbidden`. Always accepted: no `Origin` header (native clients such as `holtburger-wsshim`; a browser always sends one), an `http(s)` origin on a loopback or private-network address (the page is on this machine or this network, whose peers can reach the bridge without a browser anyway: `http://127.0.0.1:8765`, `http://localhost:8765`, a tailnet `100.x` page), and an origin whose host is the request's `Host` header (same host: proxy.cjs serves the page and `/wsbridge` under one origin, including the tunnel's rotating `*.trycloudflare.com` host). Anything else needs `--allow-origin ORIGIN` (`*` accepts every origin).
3. **Target allowlist, after the JSON handshake.** The bridge resolves the handshake's host, then requires the resolved address and both ports to match an `--allow-target` entry; otherwise it replies `{"ok":false,"error":"… --allow-target …"}` and closes. Ports are checked before resolving, so a disallowed pair costs no DNS lookup. The default list is `localhost:9000:9001` (any loopback address: the login form's default `server_host=127.0.0.1`, the tunnel recipe, the multi-agent drivers and the Rynth supervisor) and `play.coldeve.ac:9000:9001` (the public server played through this bridge). This is the guard that matters behind the tunnel, where the Origin is the tunnel's own host and every peer is loopback, and against a DNS-rebinding page, which passes the same-host Origin rule.

The WebSocket upgrade and the JSON handshake are each bounded (15 s; every client sends its hello as soon as the socket opens), so a socket that never says hello cannot hold a slot, and a WebSocket message or frame is capped at 64 KiB (one AC packet is at most 4 KiB). `--max-frames-per-sec N` is an opt-in per-connection rate (bursts to 2N): frames over it are dropped and logged, and the connection stays up. Implementation and unit tests: `src/admission.rs`; end to end: `src/admission_smoke_test.rs`. The library's `bridge::accept_loop` / `accept_loop_with_capture` test seams run with no admission control, as the bridge did before.

### Guards

- Admission, above: connection caps, Origin, target allowlist.
- Reject WS frames smaller than 2 bytes (no port).
- Reject WS frames whose port is not the handshake's ACE login or world port.
- Drop UDP datagrams whose source IP is not the handshake's resolved ACE address (avoids the bridge being a reflector for unrelated traffic).
- Drop UDP datagrams whose source port is not login or world.
- Drop WS text frames after the handshake; binary only.

Admission keeps the bridge from being a general relay; it is not authentication. Anyone who can reach the bridge with an allowed origin can still play through it on an allowed server. For a public deployment put a real reverse proxy (TLS, auth) in front.

### CLI

```
# The defaults: local ACE and play.coldeve.ac; local-network and same-host origins.
holtburger-wsbridge --listen 0.0.0.0:8080

# Only an ACE elsewhere on the LAN, and also accept a hosted page's origin.
holtburger-wsbridge \
    --allow-target 192.168.1.10:9000:9001 \
    --allow-origin https://play.example.org
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--listen HOST:PORT` | `0.0.0.0:8080` | WS listen address. |
| `--default-world-port-offset N` | `1` | World port for a handshake that omits `world_port`: login + N. |
| `--allow-target HOST[:LOGIN[:WORLD]]` | `localhost:9000:9001`, `play.coldeve.ac:9000:9001` | Repeatable; replaces the default list. LOGIN defaults to 9000 and WORLD to LOGIN + 1. `localhost` is any loopback address; an IPv6 literal with ports is bracketed (`[::1]:9000:9001`); a name matches the address it resolves to. |
| `--allow-any-target` | off | Dev opt-in: relay to any host and ports a handshake names (the bridge before 2026-10-13). |
| `--allow-origin ORIGIN` | none | Repeatable. Exact origin (`https://play.example.org`) to accept in addition to the always-accepted ones; `*` accepts every origin. |
| `--max-conns N` | `256` | Concurrent WebSocket connections; 0 = no cap. |
| `--max-conns-per-ip N` | `16` | Concurrent connections from one non-loopback peer IP; 0 = no cap. |
| `--max-frames-per-sec N` | `0` (off) | Per-connection rate of frames relayed to ACE, bursting to 2N; frames over it are dropped. |
| `--capture FILE.pcap` | off | See below. |

The startup log prints the policy in force (`admission: targets …; origins …; max conns …`).

### Opt-in capture (`--capture` / `HB_BRIDGE_CAPTURE`)

`--capture session.pcap` (or `HB_BRIDGE_CAPTURE=session.pcap`; the flag wins) appends every datagram the bridge exchanges with ACE to a classic pcap file (`LINKTYPE_RAW`: synthetic IPv4 + UDP headers with the real ports, AC bytes verbatim). It is the sudo-free alternative to `tcpdump -i lo` for recording a protocol replay corpus: `pcap2jsonl --input session.pcap --summary` (holtburger-tools `oracle_pcap`) decodes it unchanged and reports per-opcode `decoded_ok` / `short_read` / `undecodable` / `unknown` counts. Off by default; without it the relay path is unchanged. The one exception to "bytes are opaque" lives here: a client→server datagram whose packet header carries `LOGIN_REQUEST` has its body (account name + password) zeroed in the file. Everything else is kept, so use a throwaway account for a capture you intend to commit. Implementation: `src/capture.rs`.

## holtburger-wsshim (client-side)

The mirror of the bridge: instead of WS-listener + UDP-dialer, it's UDP-listener + WS-dialer.

```text
              ┌─────────┐
              │   cli   │  binds 0.0.0.0:0 ephemeral
              └────┬────┘
                   │ udp to (listen-host, listen-login-port)
                   │ udp to (listen-host, listen-world-port)
              ┌────▼─────────────────────────┐
              │           wsshim             │
              │  · bind both UDP sockets     │
              │  · dial ws upstream          │
              │  · select! over both UDP +   │
              │    one ws stream             │
              └────┬─────────────────────────┘
                   │ ws frame [ace-{login,world}-port][bytes]
                   ▼
              wsbridge → ACE
```

### Single-tenancy

The shim tracks one cli source address. Whichever UDP socket gets a packet first latches the source addr; later packets on either port overwrite it. That's correct because `holtburger-session::Session::new` at [`api.rs:9-10`](../../crates/holtburger-session/src/session/api.rs) binds exactly one `0.0.0.0:0` socket and reuses it for both login and world traffic — one cli, one source addr, both ports use it.

Multi-cli sharing of one shim is *not* supported. Run one shim per cli.

### Guards

- Reject WS frames smaller than 2 bytes.
- Reject WS frames whose port is not the configured `ace-login-port` or `ace-world-port`.
- Drop WS frames that arrive before any UDP source has been seen (no cli to send to yet).
- Drop WS text frames; binary only.

The shim does *not* validate the cli's UDP source IP. It is meant to run on the same host as the cli, listening on a loopback address. If you expose it to a wider network, run it behind a real proxy.

### Why the listen-vs-ace port split

The shim has two pairs of ports:

- `--listen-{login,world}-port` — where the shim binds locally. The cli dials these. Default `9000`/`9001` to match `holtburger-cli`'s default.
- `--ace-{login,world}-port` — what gets stamped into outgoing WS frames (so the bridge knows which ACE port to forward to) and what the bridge will use as the `port` field on inbound frames. Default to the listen ports.

In the standard case (ACE on `9000`/`9001`, cli told to dial `9000`/`9001`), both pairs are equal and you only need `--bridge`. The split exists for the case where ACE has been moved off the standard ports: the operator sets `--ace-login-port` on both bridge and shim while keeping `--listen-login-port 9000` so unmodified `holtburger-cli` still works.

### CLI

```
holtburger-wsshim \
    --bridge ws://1.2.3.4:8080/ \
    --listen-login-port 9000        # default
    --ace-login-port   9000         # default = --listen-login-port
```

## What neither binary does

- **TLS.** Add `nginx`/`caddy`/`traefik` in front for `wss://`. Both binaries speak plain `ws://` so they stay minimal and testable. (For browsers loaded over `https://`, `wss://` between browser and bridge is mandatory — that's deployment, not bridge.)
- **Auth.** After the JSON hello, the first relayed frame is already an AC `LOGIN_REQUEST` carrying account credentials; ACE authenticates, the bridge does not. [Admission](#admission) bounds who may connect, how many, and to which servers; per-account quotas belong at a real proxy.
- **AC packet parsing.** Relayed bytes are never altered. ISAAC crypto, fragment reassembly, sequence numbers — all live in `holtburger-session`, on whichever side ends up running it (the cli today, the WASM client after Phase 2). The bridge's only reads of AC headers are the capture's LoginRequest redaction and the session id it keeps for the teardown Disconnect.
- **`Session::new_with_transport` patch.** That's Phase 2 (the WASM port). Neither binary links `holtburger-session` — they just move bytes. When Phase 2 lands, the WASM `Transport` impl will speak this same WS frame protocol *instead of* needing the shim.

## Phase 1 exit criterion

Per the design doc:

> Proves the proxy is transparent: a *native* holtburger TUI client routed through the bridge can log in, walk around, and chat against a real ACE.

The full local loop is wired end-to-end and is exercised on every test run by [`src/shim_smoke_test.rs`](src/shim_smoke_test.rs):

```text
fake cli ─udp─▶ wsshim ─ws─▶ wsbridge ─udp─▶ echo servers (login + world)
         ◀────         ◀───           ◀────
```

The bridge-only smoke test ([`src/smoke_test.rs`](src/smoke_test.rs)) drives the bridge with a `wscat`-style WS client, providing belt-and-suspenders coverage of the bridge half on its own.

What's still pending for the *real* proof against ACE:

1. **Live ACE round-trip** — blocked on standing up an ACE locally (three MySQL DBs + AC client DAT files). The local loop exercises the framing and routing that ACE would touch, but a real ACE will exercise the actual handshake/crypto/sequence behaviour for the first time end-to-end.

When (1) lands, Phase 1 closes and Phase 2 (WASM port) opens.

## Running the local loop

Three terminals (plus the cli):

```sh
# 1. ACE (or, for a dry-run loop, anything that responds to UDP on 9000/9001)
#    Real: start ACE per its README. Dry-run: a small UDP echo on 9000+9001.

# 2. Bridge in front of ACE (the default --allow-target list covers a
#    loopback ACE on 9000/9001; the shim names the target in its hello)
RUST_LOG=info cargo run -p holtburger-wsbridge --bin holtburger-wsbridge -- \
    --listen 127.0.0.1:8080

# 3. Shim in front of cli
RUST_LOG=info cargo run -p holtburger-wsbridge --bin holtburger-wsshim -- \
    --bridge ws://127.0.0.1:8080/ --upstream-host 127.0.0.1 --listen-login-port 9000

# 4. Cli — point it at the shim
holtburger-cli --host 127.0.0.1 --port 9000 --account ACCT --password PWD
```

The cli's `--host`/`--port` should always be the *shim's* listen address, not ACE's address — the whole point of the shim is to look like ACE from the cli's POV.
