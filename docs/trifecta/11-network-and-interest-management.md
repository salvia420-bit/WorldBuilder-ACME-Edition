# 11 — Network, protocol and interest management

Status: **draft v0.1** (2026-11-03).
Depends on: [02 scale model](02-scale-model-and-budgets.md), [04 architecture](04-target-architecture.md).
Feeds: [12 client](12-client-holtburger-web.md), [13 retail compatibility](13-retail-compatibility.md),
[14 security](14-security-integrity-griefing.md).
Sources: the network survey of 2026-11-03. `S/` = `~/ace-server/Source/ACE.Server/`,
`BR/` = `external/holtburger/apps/holtburger-wsbridge/`.

## 1. Today

### 1.1 The AC protocol in ACE (1999 design, unmodified transport)
- **Sockets**: UDP 9000 (client → server) and 9001 (server → client), one receive outstanding per socket
  (`S/Network/Managers/SocketManager.cs:37-48`).
- **Packets**: datagrams ≤ 484 B (20 B header + 464 B body). Every game message is its own fragment (16 B header,
  ≤ 448 B data). Small messages pack together; large ones split (`ServerPacket.cs:11`, `PacketFragment.cs:7`,
  `NetworkSession.cs:821-903`).
- **Reliability**: sequence numbers, ACK every 2 s, NAK on gaps (≤ 115 ids, at most 1/s), retransmit cache of 120 s.
  A gap above 256 kills the session.
- **ISAAC** keys the checksum only (payloads are not encrypted). Its CPU cost is small; the real costs are
  allocations and one syscall per packet.
- **Pacing**: 12 message groups (queues) per session; at most one group flushed per session every 5 ms
  (`NetworkSession.cs:30,190-246`).
- **Threads**: inbound closures run on the world thread. Outbound runs `Parallel.ForEach` over sessions with
  `max(1, cores × 0.34)` threads.

### 1.2 Interest management (`S/Physics/Common/ObjectMaint.cs`)
- **First sight**: 112.5 m, 2D. Candidates are the current landblock plus its 8 neighbours; known objects are
  therefore kept across a 576 m square.
- **Forgetting**: an object leaving view goes into a 25 s destruction queue and is then dropped **silently** (the
  client culls on its own).
- **Re-evaluation**: on each 24 m cell crossing of a mover. Players do a full 3×3 rescan.
- **Fork additions** (vehicles): a per-observer sight radius, a 5×5 gather, 3D sight above the high band, and
  admission tiers. Beyond 112.5 m only creatures, players, vehicles, portals, lifestones and doors are admitted
  (`ObjectMaint.cs:440-469,514-535`).

### 1.3 Fan-out
- `EnqueueBroadcast` sends to the sender plus every known player (`WorldObject_Networking.cs:1413-1443`).
- Every AutonomousPosition becomes an UpdatePosition to all observers at the next 60 Hz tick, **even if unchanged**.
- holtburger-web sends an AutonomousPosition every 2.5 m (up to 10/s); retail sends ~1/s. Chasing monsters
  broadcast at 5 Hz.
- There is no distance-based rate reduction. Crowds cost O(N²).

### 1.4 The browser path
- `holtburger-transport-ws` in wasm talks to `holtburger-wsbridge` (Rust, tokio). The frame is `[u16 port][one AC packet]`;
  there is one WebSocket message per datagram, one UDP socket per connection and ~3 fds per connection.
- Limits: 256 connections and 16 per IP by default (`BR/src/admission.rs:53-66`).
- ACE sees every bridged user as `127.0.0.1:port`.
- **TCP head-of-line blocking** is the documented weakness on lossy links: one lost segment stalls every packet
  behind it. The AC protocol's own reliability layer sits idle over TCP (`D/network-adapter-2026-10-23.md` §1–3).

### 1.5 The extension pattern (vehicles, HBV1) — the template for everything new
- An unused opcode block (0x0900–0x09FF, checked against ACE, Chorizite, holtburger and the community archive).
- Every payload starts with a namespaced, versioned header: tag `"HBV1"`, version u16, reserved u16. Receivers drop
  payloads without the tag; versions only append fields.
- A capability handshake after entering the world: a per-session bitmask; the server never sends an extension
  message to a session that did not ask (`S/Vehicles/VehicleWire.cs:28-58`, `VehicleManager.cs:104,622-674,857-871`).
- One wire spec (`vehicles.protocol.xml`) generates C# and Rust codecs, with byte fixtures produced by a **third**
  implementation (Python) and hostile-input tests.
- A retail-compatible fallback: standard CreateObject / UpdatePosition for a stand-in object.

## 2. Requirements

| # | Requirement |
|---|---|
| N1 | 1,000+ concurrent sessions, browser and retail mixed |
| N2 | Game traffic never waits behind bulk overlay data (no HOL between them) |
| N3 | Overlay state (structures, factories, ecology) streamed by interest, cached by version on the client |
| N4 | Retail clients unaffected: no new messages unless they ask; walls still visible and collidable for them |
| N5 | Lossy-link resilience for browsers (Wi-Fi was measured at p90 0.9–2.9 s echo over TCP) |
| N6 | Bandwidth: ≤ 6 kB/s AC + ≤ 2 kB/s overlay per player on average ([02 §6.3](02-scale-model-and-budgets.md)) |
| N7 | Every decoder hardened (bounded counts, truncation, versioning), every message rate-limited |

## 3. Transport: the gateway

The **gateway** is the evolution of `holtburger-wsbridge`. It is a Rust (tokio) process that terminates browser
connections.

```
 browser ──WebTransport (HTTP/3, QUIC)──► GATEWAY ──UDP (AC protocol, unchanged)──► ACE :9000/9001
           │ datagrams: AC packets (both ways)        │
           │ stream 0: control (auth, subscriptions)  ◄──── internal: overlay deltas ──── WSS
           │ streams 1..n: overlay chunks / flows      │
         (WebSocket fallback: today's framing)
```

- **AC packets ride QUIC datagrams.** The AC protocol was designed for UDP: sequence numbers, NAK, retransmit.
  Carried unreliably, its own reliability works as it does for retail clients, and there is no **transport-level**
  head-of-line blocking. AC datagrams are ≤ 484 B, well inside a QUIC datagram's ~1,200 B. This is the "structural
  fix" the network-adapter analysis names.
  - **Caveat, verified in code: the protocol's own recovery is slow.** ACE holds an out-of-order client packet until
    the gap fills, and asks for a resend only when the gap is ≥ 2 packets and at most once per second
    (`S/Network/NetworkSession.cs:349-360`). For a sparse client→server stream (inputs, a few packets per second) a
    lost packet can therefore stall **longer than TCP would**.
  - Fix, as part of the gateway work:
    - ACE NAKs on the first gap after a short delay (~2× RTT, not 1 s), on both sides;
    - the wasm session applies the same policy;
    - the gateway may **duplicate small client→server packets** (inputs are tiny), as the vehicle input already does
      with 3× redundancy.
  - Gate: a **packet-loss test in both directions** (1–5 % loss, 50–200 ms RTT) in P1.4 and CL-9. Game-packet
    latency p99 must beat today's TCP path.
- **Overlay data rides reliable QUIC streams**, separate from the game datagrams (N2). A 100 KB chunk snapshot never
  delays a combat packet.
- **ACE is unchanged** by the transport. It still sees one UDP endpoint per user.
- **WebSocket fallback** keeps today's framing for environments without HTTP/3 (corporate proxies).
- **Auth binding**:
  1. After login, ACE's adapter issues a short-lived **overlay token** to the session over the in-band extension
     channel, and to the WSS over the bus.
  2. The client presents the token on the gateway's control stream.
  3. The gateway subscribes on the client's behalf.
  4. The token is tied to account, character and capability bits.
- **Scale**: one gateway handles thousands of connections (tokio, one task per connection). Run 2+ behind a UDP or
  QUIC-aware load balancer, and raise fd limits (≥ 3 per connection today).
- **Why not WebRTC data channels?** They also give unreliable delivery, but need ICE/STUN signalling and a heavier
  server stack. WebTransport is the client-server primitive, and Chrome (the only target) has shipped it since 2022.
  **Server-side Rust options** (checked 2026-11-03):
  - [`wtransport`](https://docs.rs/wtransport/) (0.7.x): built on `quinn`, has a datagram API;
  - [`web-transport-quinn`](https://docs.rs/web-transport-quinn/), from the Media-over-QUIC project
    ([doc.moq.dev](https://doc.moq.dev/rs/crate/web-transport)): one WebTransport session per QUIC connection, and
    defers to `h3-webtransport` when HTTP/3 must share the port.
  - Both are **pre-1.0**. P1.4 starts with a spike measuring connections, datagram rate and CPU before committing;
    WebSocket stays the fallback either way.

## 4. Interest management, per data type

| Data | Range rule | Rate | Channel | Client cache |
|---|---|---|---|---|
| Players, monsters, NPCs, items | ACE `ObjectMaint` (112.5 m first sight; 576 m known), plus **H8 rate tiers** ([10 §3](10-server-runtime-and-scaling.md)) | on change; positions by distance tier | AC (datagrams) | none |
| Vehicles | Vehicle sight (existing tiers; 3D in the high band) | 20 Hz pilot; observers **10 Hz < 500 m, 2 Hz < 2 km**, blips beyond ([09 §4.4](09-vehicles-airpower-ordnance.md)) | AC in-band HBV | none |
| Distant aircraft (later) | ~5 km, "radar blips" | 0.5–1 Hz | overlay stream |
| **Aircraft sensor footprint** | The bombsight cone below the aircraft plus an ahead-of-track strip, derived **server-side** from the vehicle pose (D14.5 holds) | 1 Hz; coarse markers (nests, raids, enemy structures) | overlay stream | none |
| **Overlay structures** | Landblock rings around the camera's ground point: radius 4 (9×9) on foot, shrinking with altitude like the client's `objRadiusForAgl` | snapshot on entry, then deltas | overlay stream | **by chunk version** (OPFS / IndexedDB) |
| Piece bindings (pieceId ↔ ACE GUID) | When the materialized piece first becomes known to the session | on materialization | AC in-band HBW (ordered with ACE's own messages) | none |
| **Factory flows** (belt descriptors, machine states) | Detail within ~2 landblocks; beyond, an activity summary per site | on change (descriptors are closed-form) | overlay stream | by version |
| Machine panel (open UI) | The one machine the player has open | on change, ≤ 4 Hz | overlay stream | none |
| **Ecology threat map** | Whole world, coarse (1 B per zone) | ≤ 1/min, delta + zstd (65 KB raw) | overlay stream | by version |
| Fronts, nests (known) | Within ~10 landblocks; scouting reveals more | on change | overlay stream | by version |
| **Raid warnings** | Owners and allegiance of the target claim (anywhere), plus players within ~3 landblocks of the route | event | AC in-band HBE (chat-like) + overlay | none |

Rule: **ACE's interest management stays authoritative for the character plane**, and the WSS publishes the overlay by
its own rules. The two must agree only where an object exists in both: a materialized piece. That is handled by the
piece binding plus suppression of the piece's ACE CreateObject for capable sessions (§5).

## 5. Protocol families (extension namespaces)

All families follow the HBV1 template (§1.5): tag, version, append-only, a capability bit, generated codecs, third-party
fixtures and hostile tests.

| Tag | Family | Opcodes (in-band) | Out-of-band (gateway streams) |
|---|---|---|---|
| `HBV1` | Vehicles (exists) | 0x0900–0x090F | — |
| `HBC2` | Capabilities v2 (generalizes HBV1's handshake: bits per family + overlay token) | 0x0910–0x0911 | control stream |
| `HBW1` | World overlay | 0x0912–0x091F (PieceBinding, PieceState for materialized pieces, PlaceResult, ClaimNotice) | ChunkSnapshot, ChunkDelta, ClaimMap |
| `HBF1` | Factory | 0x0920–0x092F (MachineUse → panel open, small commands) | FlowDescriptors, MachineState, PanelState, PowerGrid |
| `HBE1` | Ecology | 0x0930–0x093F (RaidWarning, ThreatChange near you) | ThreatMap, FrontLines, NestIntel |

**Capability bits (HBC2):**

| Bit | Meaning |
|---|---|
| 0 / 1 / 2 | Vehicles observe / pilot / vehicle DAT patch (HBV1 semantics kept) |
| 3 | **World overlay** (receives HBW and overlay streams; ACE then suppresses CreateObject for structure pieces to this session) |
| 4 | Factory UI |
| 5 | Ecology map |
| 6 | Builder (may send placement / deconstruct commands) |

### 5.1 Chunk encoding (v0)
- A chunk is one landblock of overlay state, at version *v*.
- Piece record (~12 B raw):
  - landblock-local position quantized to ~3 mm (u16, u16, i16);
  - yaw u16 (pitch and roll only for a few catalog classes);
  - catalog id u16;
  - state u8 (HP tier, damage variant, under construction);
  - owner index u8 into a per-chunk owner palette;
  - flags u8.
- A 2,000-piece chunk is ~24 KB raw, ~8–12 KB with zstd.
- Deltas: add / remove / state-change records against version *v* → *v+1*.
- The client applies deltas only to the exact base version and otherwise requests a snapshot.
- Belt descriptor (~16–24 B per segment): path id, speed, spacing, item pattern (RLE of item catalog ids), time
  origin. Machines: state u8 + progress phase + buffers as small varints.

## 6. Bandwidth (derived; checked against [02 §6.3](02-scale-model-and-budgets.md))

| Situation | AC protocol down | Overlay down | Notes |
|---|---|---|---|
| Idle in field | ~0.14 kB/s (measured) | ~0.05 kB/s | Threat-map deltas |
| Walking into a dense guild base | ~2–8 kB/s | ~10–20 KB burst once, then ~0.2 kB/s | Snapshot cached thereafter |
| Busy town (50 players), after H8 | ~4–7 kB/s | ~0 | H8 cuts the browser-cadence penalty |
| Base under a 100-monster raid | ~8–15 kB/s | ~0.5 kB/s (damage deltas) | Monster positions by distance tier |
| Piloting | 3.4 kB/s (measured on the bridge; session attributed to a pilot) | ~0.1 kB/s | |

## 7. Security in the protocol
- Every decoder enforces bounds (list counts, string lengths, total size), as HBV1's hostile-count fixtures do.
- Per-session rate limits per opcode family. Placement commands are additionally limited per claim and globally.
- The overlay token is short-lived, bound to the session and revocable. The gateway drops subscriptions on ACE logout.
- Servers ignore malformed and unexpected messages and never crash on them. The client keeps unknown events as
  `Unknown` (HBV1 decision 1).

## 8. Decisions proposed
- **D11.1** A gateway (the evolution of wsbridge) with WebTransport: AC packets on datagrams, overlay on reliable
  streams. WebSocket as fallback.
- **D11.2** Overlay data never passes through ACE. Only small, lifecycle-ordered extension messages ride in-band.
- **D11.3** All new message families follow the HBV1 template: namespaced, versioned, capability-gated, generated
  codecs, third-party fixtures.
- **D11.4** A capabilities-v2 handshake (HBC2) with an overlay token binds browser sessions to overlay subscriptions.
- **D11.5** ACE suppresses structure-piece CreateObjects for overlay-capable sessions.
- **D11.6** Interest rules are defined per data type, with client caches keyed by chunk version.

## 9. Open questions
- **Q11.1** Do the extension families stay in the raw 0x09xx block, or move to the community's
  "one opcode + plugin-name header" convention (vehicles DESIGN §5)? Payloads would not change either way.
- **Q11.2** = Q10.3 (session resume across ACE restarts), tracked there.
- **Q11.3** Should retail clients with the Chorizite plugin (representation tier 2) receive the overlay streams?
  They could only through an in-band path, since the plugin speaks the AC protocol only.
