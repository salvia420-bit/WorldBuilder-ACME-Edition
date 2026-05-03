# holtburger-wsbridge — Architecture

> Phase 1 deliverable of [`emit-dynamic-site`](../../../../docs/emit-dynamic-site.md).
> A standalone Rust binary that proxies WebSocket binary frames to/from an
> Asheron's Call ACE server's UDP ports, transparently.

## What it is

One process. Listens on a TCP port for WebSocket upgrades. Per accepted WS
connection, opens one ephemeral UDP socket and forwards bytes between the WS
peer and a configured ACE host (UDP `:9000` login + `:9001` world by default).

It does not parse AC protocol bytes. It does not do crypto. It does not know
about sessions, players, or login state. It is a pipe.

## Why it exists

Browsers cannot speak UDP. The next phase (emit-dynamic-site Phase 2) compiles
the holtburger client to WASM so it runs in a browser. The WASM client needs a
`Transport` that speaks WebSocket; the ACE server only speaks UDP. This bridge
is the seam between them.

## Frame protocol

Each WebSocket binary frame is one AC packet, prefixed by a 2-byte big-endian
port number:

```
┌────────┬────────────────────────────┐
│ port   │ ac_packet_bytes …          │
│ u16 BE │ (one full AC packet)       │
└────────┴────────────────────────────┘
   2 B          1..65533 B
```

**Browser → Bridge.** `port` is the *destination* — which ACE port to send to.
Bridge sends `ac_packet_bytes` via UDP to `(ace_host, port)`. Frames whose port
is not on the configured allowlist (login or world) are rejected and the
connection is closed.

**Bridge → Browser.** `port` is the *source* — which ACE port the datagram
came from. Browser-side `Transport::recv_from` returns `(buf, src_addr)` where
`src_addr.port() == port`. (The IP is stable per session — it's whatever the
bridge resolved at connect time — so the browser-side Transport synthesises a
SocketAddr from a fixed IP + this port.)

### Why prefix the port?

The AC handshake at [`auth.rs:33-66`](../../crates/holtburger-session/src/session/auth.rs)
moves the client mid-session from talking to ACE's login port (configured) to
its world port (login + 1). The receive path at
[`receive.rs:13-81`](../../crates/holtburger-session/src/session/receive.rs)
accepts datagrams from *either* address during the transition, then atomically
switches.

This means a single WS connection's outbound traffic targets two distinct UDP
ports over its lifetime, and inbound traffic arrives from two distinct source
ports. The bridge must convey which. The 2-byte port prefix is the smallest
honest framing that does so without inventing a control channel.

Other shapes considered:

- **No prefix, one bridge per ACE port.** Browser opens two WS connections
  (one for login, one for world). Costs: two TCP handshakes, more
  half-open-connection edge cases, the browser's `Transport` has to multiplex
  across two WS sockets to satisfy a single `recv_from` call. Rejected.
- **Out-of-band control channel.** Browser sends a JSON "switch destination
  port" message; bridge re-aims its UDP socket. Costs: stateful bridge, race
  conditions during the handshake window when both ports are simultaneously
  active. Rejected — the design doc explicitly wants a stateless bridge.
- **Embed full SocketAddr.** Prefix is `[ip:4][port:2]` instead of just port.
  Costs: 4 extra bytes per packet for no value (the bridge resolves the IP at
  startup; the browser doesn't pick it). Deferred to a multi-server future
  (open question §7.6 in the design doc).

## Connection lifecycle

```
                        ┌──────────────┐
                        │ WS listener  │  bind(0.0.0.0:8080)
                        └──────┬───────┘
                               │ accept
                  ┌────────────▼────────────┐
                  │   per-conn handler      │
                  │  · upgrade WS           │
                  │  · UdpSocket::bind 0:0  │
                  │  · spawn ws_to_udp      │
                  │  · spawn udp_to_ws      │
                  │  · join either; cancel  │
                  └─────────────────────────┘
```

Either task ending (WS close, UDP error, malformed frame) cancels the other
and tears down the UDP socket. There is no per-connection state beyond the
two sockets.

## Acceptance & guards

- Reject WS frames smaller than 2 bytes (no port).
- Reject WS frames whose port is not the configured login or world port.
- Drop UDP datagrams whose source IP is not the configured ACE host (avoids
  the bridge being a reflector/amplifier for unrelated traffic).
- Drop UDP datagrams whose source port is not login or world.
- Drop WS text frames; only binary is the protocol.

These guards are belt-and-suspenders, not security. The bridge is meant to
run on the same machine or network as ACE; if it's exposed, the operator
should put a real reverse proxy (TLS, auth) in front.

## What this bridge does not do

- **TLS.** Add `nginx`/`caddy`/`traefik` in front for `wss://`. The bridge
  speaks plain `ws://` so it stays minimal and testable. (For browsers loaded
  over `https://`, `wss://` is mandatory — that's deployment, not bridge.)
- **Auth.** The first WS frame is already an AC `LOGIN_REQUEST` carrying
  account credentials. Anything before that is just a TCP/WS handshake. If
  rate-limiting or per-account quotas are needed, do them at the proxy.
- **AC packet parsing.** Bytes are opaque. RC4 vs ISAAC, fragment
  reassembly, sequence numbers — all live in `holtburger-session`, both on
  the browser side (post-WASM-port) and inside the ACE server.
- **Session::new\_with\_transport patch.** The design doc puts that under
  Phase 2 (the WASM port). The bridge does not link `holtburger-session` —
  it just moves bytes. When Phase 2 lands, the WASM `Transport` impl will
  speak this same WS frame protocol.

## CLI surface

```
holtburger-wsbridge \
    --listen 0.0.0.0:8080 \
    --ace-host 127.0.0.1 \
    --ace-login-port 9000
```

`--ace-world-port` defaults to `--ace-login-port + 1` (matching auth.rs:41-44).
Override only if the ACE you're testing against has been reconfigured.

## Phase 1 exit criterion

Per the design doc:

> Proves the proxy is transparent: a *native* holtburger TUI client routed
> through the bridge can log in, walk around, and chat against a real ACE.

Native holtburger-cli speaks UDP, not WebSocket. To complete the exit
criterion against an unmodified `tui` binary, a small UDP↔WS shim on the
client side is needed (planned but not in this initial commit). What this
commit ships is half of that loop: the WS↔UDP bridge in front of ACE,
testable today with `wscat` + a UDP echo, and ready to consume the WASM
client in Phase 2.

The shim, when it lands, is a few hundred lines: bind UDP locally, dial WS
upstream, prefix outgoing datagrams with their dest port, strip the prefix
on incoming WS frames before handing the bytes to UDP `send_to`. It's the
mirror of this bridge.
