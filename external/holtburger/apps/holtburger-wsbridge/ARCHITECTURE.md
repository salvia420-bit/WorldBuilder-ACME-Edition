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

Neither binary parses AC bytes, does crypto, or knows about sessions, players, or login state. Both are pipes.

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

Either task ending (WS close, UDP error, malformed frame) cancels the other and tears down the UDP socket. There is no per-connection state beyond the two sockets.

### Guards

- Reject WS frames smaller than 2 bytes (no port).
- Reject WS frames whose port is not the configured ACE login or world port.
- Drop UDP datagrams whose source IP is not the configured ACE host (avoids the bridge being a reflector for unrelated traffic).
- Drop UDP datagrams whose source port is not login or world.
- Drop WS text frames; binary only.

These guards are belt-and-suspenders, not security. The bridge is meant to run on the same machine or network as ACE; if it's exposed, put a real reverse proxy (TLS, auth) in front.

### CLI

```
holtburger-wsbridge \
    --listen 0.0.0.0:8080 \
    --ace-host 127.0.0.1 \
    --ace-login-port 9000
```

`--ace-world-port` defaults to `--ace-login-port + 1` (matching `auth.rs:41-44`). Override only if the ACE you're testing against has been reconfigured.

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
- **Auth.** The first WS frame is already an AC `LOGIN_REQUEST` carrying account credentials. Anything before that is just TCP/WS handshake. If you need rate-limiting or per-account quotas, do them at a real proxy.
- **AC packet parsing.** Bytes are opaque end-to-end. ISAAC crypto, fragment reassembly, sequence numbers — all live in `holtburger-session`, on whichever side ends up running it (the cli today, the WASM client after Phase 2).
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

# 2. Bridge in front of ACE
RUST_LOG=info cargo run -p holtburger-wsbridge --bin holtburger-wsbridge -- \
    --listen 127.0.0.1:8080 --ace-host 127.0.0.1 --ace-login-port 9000

# 3. Shim in front of cli
RUST_LOG=info cargo run -p holtburger-wsbridge --bin holtburger-wsshim -- \
    --bridge ws://127.0.0.1:8080/ --listen-login-port 9000

# 4. Cli — point it at the shim
holtburger-cli --host 127.0.0.1 --port 9000 --account ACCT --password PWD
```

The cli's `--host`/`--port` should always be the *shim's* listen address, not ACE's address — the whole point of the shim is to look like ACE from the cli's POV.
