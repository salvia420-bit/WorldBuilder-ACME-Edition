# HANDOFF — texture legibility lane (COMPLETED autonomous on buildbox, 2026-08-15 PM)

**Read this first when you return.** The lane ran to completion while you were away and
the visual result is VERIFIED (orchestrator eyeballed the A/B boards). BUT there is ONE
real deployment blocker (§BLOCKER) — the combined dat's on-disk structure is validated
only in DRW/WBT, not the retail client, so do NOT ship it until the in-client load passes.

## RESULT (orchestrator-verified, not agent-asserted)
- **Slice gate PASS and full set PASS.** All 768 matched RenderSurfaces encoded (447
  patched GfxObjs → 824 surfaces, 768 with a RenderSurface): 768 written / 0 fail,
  collapse 523 + 245 already-single / 0 fail, **0 skipped** (no palette/format casualties),
  RenderSurface count integrity 20684==20684, round-trip sample 24/24.
- **A/B boards eyeball-confirmed good** (I opened board_0x01000D15.png, the pagoda,
  textures DXT-decoded straight from the patched dat): PATCHED panels are visibly crisper
  — defined shingle-row emboss, textured plaster, sharper base stonework — and **+12.6–13.3%
  brighter**, colors faithful, zero DXT block corruption. The legibility recipe survives
  the DXT round-trip and reads back correctly from the dat.
- portal.dat **1487.8 MiB, under the 2048 MiB ceiling** — BUT ~560 MB of that is dead
  arena space (see §BLOCKER).

## ⚠ BLOCKER before this ships — retail-client load NOT yet proven
The in-place texture import hit DatReaderWriter's contiguous-allocator bug, so the agent
worked around it by **rewriting the dat's free list / appending a zeroed free-arena at
header 0x140** (a reconstruction of the repo's missing `prep_dat.py`). Consequences:
1. The patched dat is read cleanly by **DRW/WBT only**; `datlib`'s b-tree walk chokes on
   the rewritten tree. That means the round-trip validation used the SAME library family
   that wrote it — it is NOT independent proof the RETAIL CLIENT's DiskDev/BTree reader
   accepts the file. The free-list is exactly the delicate area the client-headroom
   dossier flags (bit-31 free-block flag, signed-32 seeks). **The 1070 in-client load is
   now a REQUIRED gate, not an optional eyeball.** The geometry-only world export did NOT
   need this hack and is not implicated.
2. ~560 MB dead arena rides in the shipped file (safe, under ceiling, but wasteful) —
   compact it once the structure is client-validated.
Until the retail client loads `~/texture-run/export/client_portal.dat` (or the pulled
`/mnt/wbterminal2/dat-patch-texture-lane/texture.tgz`) and renders a patched building,
treat this dat as VALIDATED-IN-TOOLING-ONLY.

## Design / how-to (for reference)

## WHAT THIS LANE DOES
Ships the **legibility bake** (the recipe the owner approved on the phone) into the
DAT as re-encoded RenderSurface textures, layered ON TOP of the world geometry tranche
so the final `client_portal.dat` carries BOTH 4× displacement geometry AND embossed,
sharpened, mean-luminance-preserved textures. This is the lane the starkness ladder
proved carries most of the visible win (§0 addendum / §3c of the main handoff).

Per RenderSurface: base PNG → legibility bake (legibility.py: signed two-band emboss,
g_hi 0.35 / g_lo 0.50 / a0 0.15, tanh-limited, shade ±0.60, **1.15× retail mean-luminance
anchor** so it reads brighter not gloomy) → `render-surface-import` at DXT →
`surface-texture-collapse` to the high-detail entry (defeats the client's boot-default
`EnvironmentTextureDetail=2` low-detail selection, dossier §3). Palettized/INDEX16
sources that can't cleanly DXT-round-trip are SKIPPED and counted (the community's known
trap), never corrupted.

Scope: the RenderSurfaces used by the 447 patched architecture GfxObjs (the matched A/B
set), not the whole 2,931 corpus. Base for the patch is a COPY of the geometry world
export (`~/tranche-run/export/client_portal.dat`) so geometry+texture combine.

## SAFETY GATE (why a partial result is still a good result)
The lane validates a SMALL SLICE first (Holtburg surfaces): round-trip re-parse of each
imported RenderSurface + a sunny before/after A/B board (legboards.py) eyeballed for
"sharper/embossed, not corrupt/garish", + portal under the 2 GiB ceiling. It expands to
the full matched set ONLY if the slice passes. So the worst case is a **validated slice
that didn't expand**, not a broken world dat.

## VERIFY ON RETURN (real numbers live here — read these, don't trust prose)
- Laptop: `/mnt/wbterminal2/dat-patch-texture-lane/` — the final A/B boards (Read them:
  after should be visibly sharper/embossed and BRIGHTER than before, not gloomy).
- Box: `~/texture-run/results.json` — surfaces processed / encoded / skipped-palette /
  round-trip pass-fail, portal size before→after vs the 2 GiB ceiling, slice-gate verdict.
  `gcloud compute ssh buildbox --zone us-central1-b --command 'cat ~/texture-run/results.json'`
- Box sentinel `~/TEXTURE_DONE` present ⇒ packaging finished; `~/texture-run/texture.tgz`
  (+ .sha256) is the combined geometry+texture deployable. Pull with
  `gcloud compute scp buildbox:~/texture-run/texture.tgz{,.sha256} /mnt/wbterminal2/dat-patch-texture-lane/ --zone us-central1-b`
  then `sha256sum -c`.
- New tooling committed locally (NOT pushed — review then push): `tools/dat-patch/
  texture_lane.py` (+ a texture driver). `cd repo && git log --oneline origin/integ/all-20260813..HEAD`.

## THE BOX (owner-cost note)
buildbox is TEMPORARILY resized to **n1-standard-16** (16 vCPU) for run speed and is
**SPOT** (preemptible). When you're done pulling deliverables, **shrink it back to save
cost**: `gcloud compute instances stop buildbox --zone us-central1-b` →
`set-machine-type buildbox --machine-type n1-standard-4` → leave stopped (rm the box's
`~/.keep-awake` if set). Zone is **us-central1-b** (runbook says -a — stale). On any
cold boot the box needs `sudo tailscale set --accept-dns=false` or github/pypi won't
resolve (MagicDNS hijack).

## RESUME (if the lane stopped mid-run or the box preempted)
- Box TERMINATED? `gcloud compute instances start buildbox --zone us-central1-b`, wait
  for sshd, `sudo tailscale set --accept-dns=false`, `touch ~/.keep-awake`.
- The texture driver is designed resumable (per-surface state); re-run it and it skips
  encoded surfaces. Read `~/texture-run/results.json` for where it stopped.
- If the SLICE GATE failed (results.json says so): the likely cause is a texture format
  the DXT path mishandles (palette/INDEX16) or a `render-surface-import`/collapse arg
  mismatch — read the A/B board and the box log, fix the encoder path, re-run the slice.
  Do NOT ship a world texture dat that failed its own slice gate.

## NEXT STEPS AFTER THIS LANDS
1. **GATING: retail-client load of the combined dat** (see §BLOCKER) — the free-arena
   rewrite is validated in DRW/WBT only. Load `client_portal.dat` in the retail client
   (1070 pass, main handoff TODO #3) and render a patched building. If it loads: compact
   the ~560 MB dead arena, then it's deployable. If it fails: the free-list workaround is
   the suspect — the durable fix is patching DatReaderWriter's contiguous allocator so the
   arena hack isn't needed (the geometry lane never triggered it). Also REVIEW the agent's
   reconstructed `prep_dat.py` recipe (header 0x140 free-arena, free-list repoint) — it is
   the one unreviewed structural change; commit `e75ca639` carries `texture_lane.py` +
   `texture_driver.sh` (verify the prep step is in there and understood before relying on it).
2. Degrade-record follow-up lane: patch the 5 deferred band objects directly
   (`degrade_deferred.json`) so degrade-carriers get geometry too.
3. Dungeons (Environment 0x0D) and creatures — their own lanes (main handoff TODO #4/#6).
4. If a server ever needs more texture budget: trevis's DAT-compression client patch
   (~50 % portal.dat, author-confirmed) — see client-headroom-dossier.md + the Discord
   cross-check; derive the byte-signature patch, soak-test (paradox's "may be an
   intentional workaround" caveat).
