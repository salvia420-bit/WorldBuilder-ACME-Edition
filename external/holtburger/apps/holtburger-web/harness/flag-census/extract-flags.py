#!/usr/bin/env python3
"""extract-flags.py — build the night's work list from docs/url-flags.md.

Deliberately conservative. The tree has a documented footgun: a flag coded
`!== "off"` READS ON when the param is absent, even where a comment claims
"default OFF", so the doc's Default column is a hint, not the truth. We
therefore:
  - take the flag NAME and the Values column from the doc,
  - derive the escape token from the Values column (what the flag itself says
    disables it), falling back to "off",
  - and record the doc's claimed default so the run can CONTRADICT it. A flag
    the doc calls default-ON whose =off arm is byte-identical to baseline is
    either dead or mis-documented, and that is a finding either way.

Emits JSON: [{name, escape, claimedDefault, values, owner}]
"""
import json
import re
import sys

DOC = sys.argv[1] if len(sys.argv) > 1 else "docs/url-flags.md"
OUT = sys.argv[2] if len(sys.argv) > 2 else "flags.json"

rows = [l.rstrip("\n") for l in open(DOC, encoding="utf-8") if l.startswith("| `")]

def cells(line):
    # split on unescaped pipes, drop leading/trailing empties
    parts = re.split(r"(?<!\\)\|", line)
    return [p.strip() for p in parts[1:-1]] if len(parts) > 2 else []

def escape_token(values, name):
    """What string turns this flag OFF, per its own Values column."""
    v = values.lower()
    # explicit escape spellings, most specific first
    for tok in ("`off`", "'off'", '"off"', "off"):
        if tok in v:
            return "off"
    if re.search(r"`0`", v):
        return "0"
    if "false" in v:
        return "false"
    # numeric-range flags (e.g. renderScale 0-2): 0 is the natural null arm
    if re.search(r"\d\s*[-–]\s*\d", v) or "int" in v or "float" in v:
        return "0"
    return "off"

out, skipped = [], []
for line in rows:
    c = cells(line)
    if len(c) < 4:
        continue
    m = re.match(r"`([^`]+)`", c[0])
    if not m:
        continue
    name = m.group(1)
    if name.startswith("USE_"):
        skipped.append((name, "compile-time Rust const"))
        continue
    values, default = c[1], c[2]
    # "default-ON" per the doc: a bolded on / number / 'default ON' in col 3
    dl = default.lower()
    claimed_on = bool(
        re.search(r"\*\*(on|default[- ]on)\b", dl)
        or re.search(r"\*\*\s*\d", dl)
        or "default-on" in dl
        or "default on" in dl
    )
    out.append({
        "name": name,
        "escape": escape_token(values, name),
        "claimedDefault": "ON" if claimed_on else "off/opt-in",
        "values": values[:120],
        "owner": c[-1][:100] if c else "",
    })

on = [f for f in out if f["claimedDefault"] == "ON"]
json.dump({"all": out, "defaultOn": on}, open(OUT, "w"), indent=1)
print(f"parsed rows       : {len(rows)}")
print(f"URL flags         : {len(out)}  (skipped {len(skipped)} compile-time)")
print(f"claimed default-ON: {len(on)}   <- night 1 work list")
from collections import Counter
print("escape tokens     :", dict(Counter(f['escape'] for f in on)))
print("\nsample of the work list:")
for f in on[:12]:
    print(f"  {f['name']:26} ?{f['name']}={f['escape']:5}  ({f['values'][:52]})")
