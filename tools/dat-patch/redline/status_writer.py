#!/usr/bin/env python3
"""status_writer.py -- append one event to the AcmeRedline status log.

    # an agent picks an item up
    python3 status_writer.py --log redline-status.jsonl \
        --entry rl-20260820-101500-a1c3 --state in-progress \
        --by agent:texture-lane --note "rebaking 0x06003C97 at 512x512 DXT1"

    # ...and finishes it
    python3 status_writer.py --log redline-status.jsonl \
        --entry rl-20260820-101500-a1c3 --state fixed --release acme-r10 \
        --by agent:texture-lane --note "shipped in acme-r10, board attached"

    # what does the plugin currently show?
    python3 status_writer.py --log redline-status.jsonl --derive

redline-status.jsonl is APPEND-ONLY.  Derived current state = the LAST event for
an entryId; nothing rewrites history, so the log doubles as the audit trail of
who touched what and when.  The in-game plugin tails this file.

Every event is validated against schema_v1.json#/definitions/statusEvent BEFORE
it is written -- a malformed line would be invisible to the plugin's reader and
would silently strand the entry at its previous state.

Concurrency: the append is a single O_APPEND write of one line under an
flock(LOCK_EX), so two agents finishing at once cannot interleave.
"""
import argparse
import datetime
import fcntl
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from queue_worker import Validator, derive_status, SCHEMA_PATH   # noqa: E402

STATES = ("queued", "in-progress", "fixed")


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ")


def append_event(log_path, event, schema=SCHEMA_PATH):
    """Validate then append.  Returns the event.  Raises ValueError if invalid."""
    errs = Validator(schema).errors(event, "statusEvent")
    if errs:
        raise ValueError("status event fails schema:\n  " + "\n  ".join(errs))
    line = json.dumps(event, sort_keys=True) + "\n"
    d = os.path.dirname(os.path.abspath(log_path))
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        os.write(fd, line.encode("utf-8"))
        os.fsync(fd)
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
    return event


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--log", required=True, help="redline-status.jsonl")
    ap.add_argument("--entry", help="entry id, rl-YYYYMMDD-HHMMSS-XXXX")
    ap.add_argument("--state", choices=STATES)
    ap.add_argument("--release", default=None,
                    help="kit tag the fix ships in, e.g. acme-r10 "
                         "(required for --state fixed)")
    ap.add_argument("--note", default=None)
    ap.add_argument("--by", default="status_writer.py",
                    help="agent or tool writing the event")
    ap.add_argument("--at", default=None, help="ISO8601 UTC; default now")
    ap.add_argument("--derive", action="store_true",
                    help="print the derived current state per entry and exit")
    ap.add_argument("--schema", default=SCHEMA_PATH)
    a = ap.parse_args(argv)

    if a.derive:
        cur = derive_status(a.log)
        if not cur:
            print("(no events in %s)" % a.log)
            return 0
        for eid in sorted(cur):
            ev = cur[eid]
            print("%-28s %-12s %-9s %s  %s"
                  % (eid, ev.get("state"), ev.get("release") or "-",
                     ev.get("at"), (ev.get("note") or "")[:60]))
        return 0

    if not a.entry or not a.state:
        ap.error("--entry and --state are required unless --derive")
    if a.state == "fixed" and not a.release:
        ap.error("--state fixed needs --release <kit tag>: the plugin shows the "
                 "player WHICH release carries their fix, and 'fixed' with no "
                 "release is unverifiable")

    ev = dict(entryId=a.entry, at=a.at or utcnow(), state=a.state, by=a.by)
    if a.release:
        ev["release"] = a.release
    if a.note:
        ev["note"] = a.note

    prev = derive_status(a.log).get(a.entry)
    if prev and prev.get("state") == a.state and a.state != "queued":
        print("note: %s is already '%s' (since %s) -- appending anyway "
              "(the log is a history, not a set)"
              % (a.entry, a.state, prev.get("at")), file=sys.stderr)

    try:
        append_event(a.log, ev, a.schema)
    except ValueError as ex:
        print(str(ex), file=sys.stderr)
        return 2
    print(json.dumps(ev, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
