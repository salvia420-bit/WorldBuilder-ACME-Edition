# ACTIVE LANES — who is editing what, right now

**Append-only, one block per agent, newest at the bottom. Add yours BEFORE you start editing.**

Why: `~/WorldBuilder-ACME-Edition` is ONE working tree shared by several concurrent agents, and
cross-agent messaging is unreliable (three of seven agents on 2026-08-13 had no `ListAgents`
and their `SendMessage` calls bounced silently). This file is the cheap substitute: it lets you
tell, at a glance, which dirty files in `git status` are NOT yours — so you leave them alone.

It is a courtesy note, **not a lock**. Nothing enforces it. If two lanes overlap, say so in
your block and hand-merge; don't revert the other lane.

Rules:
* Add a block when you start. Strike it (`~~...~~ DONE <sha>`) when your branch is committed.
* Never delete someone else's block; never edit one you didn't write.
* Stale blocks are worse than none — if you are reading a block from a previous day, treat it
  as history, not as a live claim. Sessions are dated for exactly that reason.
* Full shared-tree rules (including the banned tree-global git commands) live in
  `PARITY-LEDGER.md` §L4b.

Template:

```
### <AGENT NAME> — <date> — branch `<branch>`
files: <paths you will touch>
note: <overlaps you know about, or "disjoint">
```

---

### PARITY-B / PARITY-C / PARITY-D — 2026-08-13 — branches `parity-{b,c,d}-*-20260813`
files: scene3d/entities.js, combat/cast paths, PARITY-LEDGER.md
note: ~~active~~ DONE — pushed to origin, linear chain, d is the head. Immutable.

### HARDEN — 2026-08-13 — branch `harden/shared-tree-20260813`
files: docs/reengineering/impl/PARITY-LEDGER.md (§L2/P1 + §L4b only),
       docs/reengineering/impl/ACTIVE-LANES.md, scripts/parity-ab.sh
note: §L4b overlaps the INTEGRATOR's L4b baseline refresh — my edit replaces only the prose
      above the baseline bullets and leaves every measured number untouched, so the two
      should merge cleanly.
