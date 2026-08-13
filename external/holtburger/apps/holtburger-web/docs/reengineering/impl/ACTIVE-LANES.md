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

<<<<<<< HEAD
### LANE A (PORTAL-GATE) — 2026-08-14 — branch `lane/portal-gate-20260814`
files: scene3d/atmosphere_pipeline.js, scene3d/index.js, scene3d/cells.js,
       tests/portal_punch_occlusion_gate.test.mjs, harness/portal-gate-probe.mjs,
       docs/url-flags.md, docs/reengineering/impl/task-A-report.md
note: declared overlap with lane D at the punch-feed call site (cells.js `tickPortalPunch`).
      I keep my cells.js edits to that one function; D keeps to new files + one call site;
      hand-merge at integration, never revert.
=======
### LANE D (PORTAL-PASS2) — 2026-08-14 — branch `lane/portal-pass2-20260814`
files: scene3d/portal_pass2.js (NEW), tests/portal_pass2.test.mjs (NEW),
       harness/run-js-headless.mjs (one registration line),
       docs/url-flags.md (one new `portalPass2` row),
       scene3d/cells.js (SHARED — 4 small hunks, all inside/around `tickPortalPunch`)
note: declared overlap with LANE A, which is fixing the inert `?portalStencil` occlusion gate in
      the SAME punch path. My cells.js hunks are listed line-by-line in
      `task-D-report.md` §"Shared lines touched" for hand-merge. I touch neither
      scene3d/portal_punch.js nor atmosphere_pipeline.js (Lane A's surface), and neither
      src/lib.rs nor pkg/ (Lane B's).
>>>>>>> lane/portal-pass2-20260814
