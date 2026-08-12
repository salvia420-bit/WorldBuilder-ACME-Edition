#!/usr/bin/env python3
"""diags.py — pull the per-camera `_portalPunchDiag` series out of an arm console.

arm.mjs truncates each step's value at 400 chars, so the tail of a long diag
(the `gates` block) can be cut. Every field read here sits before that cut.

usage: diags.py <console.log> [...]
"""
import re
import sys

FIELDS = [
    ("offered", r'"offered":(\d+)'),
    ("kept", r'"kept":(\d+)'),
    ("backface", r'"backface":(\d+)'),
    ("straddle", r'"straddle":(\d+)'),
    ("terrain", r'"terrain":(\d+)'),
    ("src", r'"sidednessSource":"([a-z]+)"'),
]

for path in sys.argv[1:]:
    print(f"=== {path}")
    hdr = "tag".ljust(10) + "".join(n.rjust(10) for n, _ in FIELDS)
    print(hdr)
    txt = open(path).read()
    for m in re.finditer(r"diag-([a-z0-9-]+) ok (\{.*)", txt):
        tag, rest = m.group(1), m.group(2)
        row = tag.ljust(10)
        for _, pat in FIELDS:
            g = re.search(pat, rest)
            row += (g.group(1) if g else "-").rjust(10)
        print(row)
    print()
