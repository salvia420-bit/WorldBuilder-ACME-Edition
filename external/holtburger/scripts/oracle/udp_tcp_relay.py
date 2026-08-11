#!/usr/bin/env python3
"""Datagram-preserving UDP<->TCP relay for the retail-client oracle rig.

WHY THIS EXISTS (do not replace with a bare socat pipe):
    ssh port-forwarding only carries TCP.  The retail Asheron's Call client
    speaks UDP, so the buildbox->laptop hop has to ride a TCP tunnel.  The
    obvious `socat UDP4-LISTEN:9000,fork TCP4:127.0.0.1:19000` pair is WRONG
    for this traffic: TCP is a byte stream with no message boundaries, so two
    AC packets written back-to-back coalesce into one TCP segment and the far
    socat re-emits them as a SINGLE UDP datagram.  The AC packet header has no
    self-delimiting total length that a receiver uses to split a coalesced
    datagram, so the second packet is silently swallowed.  At idle this almost
    never fires; under a movement burst (position updates at ~20Hz plus
    fragment trains) it fires constantly, which is exactly the traffic this
    oracle exists to measure.

    So we frame every datagram ourselves: 4-byte big-endian length + payload.
    Boundaries survive the tunnel byte-for-byte.

TOPOLOGY (see WINE-RIG.md):

    wine acclient.exe                                        ACE server
      | UDP :9000/:9001                                        ^ UDP :9000/:9001
      v                                                        |
    [box]  relay --mode box                        relay --mode host  [laptop]
      | TCP 127.0.0.1:19000/19001                               ^
      +--------------- ssh -R 19000:127.0.0.1:19000 ------------+

    `ssh -R` is established FROM the laptop TO the box, so the LISTENER lives
    on the box and forwards into the laptop.  The box-side relay therefore
    CONNECTS to 127.0.0.1:19000 (the ssh listener); the laptop-side relay
    LISTENS on 127.0.0.1:19000.

    box mode : UDP listener  -> one TCP connection per distinct UDP peer
    host mode: TCP listener  -> one UDP socket per accepted connection

    One TCP connection per UDP peer keeps the reply association trivial and
    needs no multiplexing header: whatever comes back on a connection belongs
    to that peer.

Usage:
    # on the buildbox (client side)
    ./udp_tcp_relay.py --mode box  --udp-port 9000 --tcp-port 19000
    # on the laptop (server side)
    ./udp_tcp_relay.py --mode host --tcp-port 19000 --udp-port 9000

Pure stdlib; no deps on either host.
"""

from __future__ import annotations

import argparse
import logging
import socket
import struct
import sys
import threading
import time

# AC datagrams are well under 1 KiB in practice; the client's own receive
# buffer is 0x1E4 (484) bytes of payload plus headers.  8 KiB is slack.
MAX_DGRAM = 8192
LEN_PREFIX = struct.Struct(">I")

log = logging.getLogger("relay")


class Stats:
    """Counters so a run can be shown to have actually carried traffic."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.up_pkts = 0
        self.up_bytes = 0
        self.down_pkts = 0
        self.down_bytes = 0
        self.peers = 0

    def up(self, n: int) -> None:
        with self.lock:
            self.up_pkts += 1
            self.up_bytes += n

    def down(self, n: int) -> None:
        with self.lock:
            self.down_pkts += 1
            self.down_bytes += n

    def peer(self) -> None:
        with self.lock:
            self.peers += 1

    def line(self) -> str:
        with self.lock:
            return (
                f"peers={self.peers} up={self.up_pkts}pkt/{self.up_bytes}B "
                f"down={self.down_pkts}pkt/{self.down_bytes}B"
            )


def send_framed(sock: socket.socket, payload: bytes) -> None:
    sock.sendall(LEN_PREFIX.pack(len(payload)) + payload)


def recv_exact(sock: socket.socket, n: int) -> bytes | None:
    """Read exactly n bytes or return None on clean/abrupt EOF."""
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return bytes(buf)


def recv_framed(sock: socket.socket) -> bytes | None:
    hdr = recv_exact(sock, LEN_PREFIX.size)
    if hdr is None:
        return None
    (length,) = LEN_PREFIX.unpack(hdr)
    if length > MAX_DGRAM:
        raise ValueError(f"framed length {length} exceeds MAX_DGRAM {MAX_DGRAM}")
    if length == 0:
        return b""
    return recv_exact(sock, length)


# --------------------------------------------------------------------------
# box mode: UDP listener, TCP client
# --------------------------------------------------------------------------


class BoxPeer:
    """One retail-client UDP source address, bridged onto its own TCP conn."""

    def __init__(
        self,
        addr: tuple[str, int],
        udp_sock: socket.socket,
        tcp_host: str,
        tcp_port: int,
        stats: Stats,
    ) -> None:
        self.addr = addr
        self.udp_sock = udp_sock
        self.stats = stats
        self.tcp = socket.create_connection((tcp_host, tcp_port), timeout=10)
        self.tcp.settimeout(None)
        self.tcp.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.alive = True
        self.reader = threading.Thread(target=self._pump_down, daemon=True)
        self.reader.start()

    def _pump_down(self) -> None:
        """TCP (server replies) -> UDP back to the client."""
        try:
            while self.alive:
                payload = recv_framed(self.tcp)
                if payload is None:
                    break
                self.udp_sock.sendto(payload, self.addr)
                self.stats.down(len(payload))
        except OSError as exc:
            log.debug("peer %s down-pump closed: %s", self.addr, exc)
        except ValueError as exc:
            log.error("peer %s framing error: %s", self.addr, exc)
        finally:
            self.close()

    def send_up(self, payload: bytes) -> None:
        send_framed(self.tcp, payload)
        self.stats.up(len(payload))

    def close(self) -> None:
        self.alive = False
        try:
            self.tcp.close()
        except OSError:
            pass


def run_box(args: argparse.Namespace, stats: Stats) -> None:
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    udp.bind((args.udp_bind, args.udp_port))
    log.info(
        "box mode: UDP %s:%d -> TCP %s:%d",
        args.udp_bind,
        args.udp_port,
        args.tcp_host,
        args.tcp_port,
    )

    peers: dict[tuple[str, int], BoxPeer] = {}
    while True:
        payload, addr = udp.recvfrom(MAX_DGRAM)
        peer = peers.get(addr)
        if peer is not None and not peer.alive:
            peers.pop(addr, None)
            peer = None
        if peer is None:
            try:
                peer = BoxPeer(addr, udp, args.tcp_host, args.tcp_port, stats)
            except OSError as exc:
                log.error("cannot open tunnel for %s: %s", addr, exc)
                continue
            peers[addr] = peer
            stats.peer()
            log.info("new peer %s:%d (tunnel up)", addr[0], addr[1])
        try:
            peer.send_up(payload)
        except OSError as exc:
            log.warning("peer %s up-pump failed: %s", addr, exc)
            peer.close()
            peers.pop(addr, None)


# --------------------------------------------------------------------------
# host mode: TCP listener, UDP client
# --------------------------------------------------------------------------


def serve_host_conn(
    conn: socket.socket, args: argparse.Namespace, stats: Stats
) -> None:
    """One tunnel connection <-> one ephemeral UDP socket to the real server."""
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp.connect((args.udp_host, args.udp_port))
    alive = threading.Event()
    alive.set()

    def pump_down() -> None:
        """UDP (ACE replies) -> framed TCP."""
        try:
            while alive.is_set():
                payload = udp.recv(MAX_DGRAM)
                send_framed(conn, payload)
                stats.down(len(payload))
        except OSError as exc:
            log.debug("conn down-pump closed: %s", exc)
        finally:
            alive.clear()
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    threading.Thread(target=pump_down, daemon=True).start()
    try:
        while True:
            payload = recv_framed(conn)
            if payload is None:
                break
            udp.send(payload)
            stats.up(len(payload))
    except (OSError, ValueError) as exc:
        log.debug("conn up-pump closed: %s", exc)
    finally:
        alive.clear()
        for s in (udp, conn):
            try:
                s.close()
            except OSError:
                pass


def run_host(args: argparse.Namespace, stats: Stats) -> None:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((args.tcp_bind, args.tcp_port))
    srv.listen(16)
    log.info(
        "host mode: TCP %s:%d -> UDP %s:%d",
        args.tcp_bind,
        args.tcp_port,
        args.udp_host,
        args.udp_port,
    )
    while True:
        conn, peer = srv.accept()
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        stats.peer()
        log.info("tunnel conn from %s:%d", peer[0], peer[1])
        threading.Thread(
            target=serve_host_conn, args=(conn, args, stats), daemon=True
        ).start()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--mode", choices=("box", "host"), required=True)
    ap.add_argument("--udp-port", type=int, default=9000)
    ap.add_argument("--tcp-port", type=int, default=19000)
    ap.add_argument("--udp-bind", default="0.0.0.0", help="box mode: UDP listen addr")
    ap.add_argument("--udp-host", default="127.0.0.1", help="host mode: ACE addr")
    ap.add_argument("--tcp-bind", default="127.0.0.1", help="host mode: TCP listen addr")
    ap.add_argument("--tcp-host", default="127.0.0.1", help="box mode: tunnel addr")
    ap.add_argument("--stats-interval", type=float, default=10.0)
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )
    stats = Stats()

    if args.stats_interval > 0:

        def ticker() -> None:
            while True:
                time.sleep(args.stats_interval)
                log.info("stats %s", stats.line())

        threading.Thread(target=ticker, daemon=True).start()

    try:
        if args.mode == "box":
            run_box(args, stats)
        else:
            run_host(args, stats)
    except KeyboardInterrupt:
        log.info("interrupted; final stats %s", stats.line())
    return 0


if __name__ == "__main__":
    sys.exit(main())
