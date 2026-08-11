#!/usr/bin/env python3
"""Loopback proof that udp_tcp_relay preserves datagram boundaries.

Stands up, on one host:

    fake client --UDP--> relay(box) --TCP--> relay(host) --UDP--> echo server

and fires a burst of back-to-back datagrams of varying sizes.  The burst is
the point: it is exactly the pattern (movement updates at ~20Hz) that makes a
plain byte-stream socat pipe coalesce packets.  The test asserts every
datagram arrives at the echo server intact and individually, and that every
reply comes back to the client intact and individually.

Run:  python3 test_udp_tcp_relay.py
"""

from __future__ import annotations

import socket
import sys
import threading
import time

import udp_tcp_relay as relay


class Args:
    """Duck-typed stand-in for argparse.Namespace."""

    def __init__(self, **kw: object) -> None:
        self.__dict__.update(kw)


def start_echo_server(port: int, seen: list[bytes], ready: threading.Event) -> None:
    """UDP echo that records exactly what datagrams it received."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", port))
    ready.set()
    while True:
        data, addr = s.recvfrom(relay.MAX_DGRAM)
        seen.append(data)
        # Echo back with a marker so the reply path is checked too.
        s.sendto(b"R" + data, addr)


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def main() -> int:
    udp_in = free_port()
    tcp_mid = free_port()
    udp_out = free_port()

    seen: list[bytes] = []
    ready = threading.Event()
    threading.Thread(
        target=start_echo_server, args=(udp_out, seen, ready), daemon=True
    ).start()
    ready.wait(5)

    stats = relay.Stats()
    host_args = Args(
        tcp_bind="127.0.0.1",
        tcp_port=tcp_mid,
        udp_host="127.0.0.1",
        udp_port=udp_out,
    )
    threading.Thread(
        target=relay.run_host, args=(host_args, stats), daemon=True
    ).start()

    box_args = Args(
        udp_bind="127.0.0.1",
        udp_port=udp_in,
        tcp_host="127.0.0.1",
        tcp_port=tcp_mid,
    )
    threading.Thread(target=relay.run_box, args=(box_args, stats), daemon=True).start()
    time.sleep(0.4)

    # Burst: 200 datagrams, sizes cycling 1..300 bytes, sent as fast as
    # possible with no pacing.  Distinct content per datagram so that a
    # coalesced pair is detectable as a merged payload rather than two.
    sent: list[bytes] = []
    client = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    client.settimeout(5.0)
    for i in range(200):
        size = 1 + (i * 7) % 300
        payload = bytes([(i % 251)]) * size
        sent.append(payload)
        client.sendto(payload, ("127.0.0.1", udp_in))

    replies: list[bytes] = []
    deadline = time.time() + 8.0
    while len(replies) < len(sent) and time.time() < deadline:
        try:
            replies.append(client.recv(relay.MAX_DGRAM))
        except socket.timeout:
            break

    failures: list[str] = []
    if len(seen) != len(sent):
        failures.append(
            f"echo server saw {len(seen)} datagrams, expected {len(sent)} "
            "(coalescing or loss)"
        )
    else:
        for i, (a, b) in enumerate(zip(sent, seen)):
            if a != b:
                failures.append(f"datagram {i} corrupted: {len(a)}B sent, {len(b)}B seen")
                break

    if len(replies) != len(sent):
        failures.append(f"client got {len(replies)} replies, expected {len(sent)}")
    else:
        for i, (a, b) in enumerate(zip(sent, replies)):
            if b != b"R" + a:
                failures.append(f"reply {i} corrupted ({len(b)}B)")
                break

    print(f"sent={len(sent)} echoed={len(seen)} replies={len(replies)}")
    print(f"relay stats: {stats.line()}")
    if failures:
        for f in failures:
            print(f"FAIL: {f}")
        return 1
    print("PASS: all datagram boundaries preserved in both directions")
    return 0


if __name__ == "__main__":
    sys.exit(main())
