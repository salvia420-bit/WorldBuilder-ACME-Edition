# HANDOFF — texture legibility lane (staged 2026-08-15 PM, run autonomous on buildbox)

**Read this first when you return.** This lane was launched to build + validate + run
autonomously on the buildbox while the owner was away ~1 h. The design and how-to are
below; the ACTUAL RESULTS are in the run's own files (§VERIFY) — this doc does NOT
pre-invent numbers. If the box preempted or the lane stopped at the safety gate, §RESUME
tells you how to continue; state is resumable.

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
1. 1070 in-client eyeball pass on the combined geometry+texture dat (main handoff TODO #3,
   still outstanding) — confirm portal visibility through openings + the textures in the
   real D3D9 client, not just the software A/B.
2. Degrade-record follow-up lane: patch the 5 deferred band objects directly
   (`degrade_deferred.json`) so degrade-carriers get geometry too.
3. Dungeons (Environment 0x0D) and creatures — their own lanes (main handoff TODO #4/#6).
4. If a server ever needs more texture budget: trevis's DAT-compression client patch
   (~50 % portal.dat, author-confirmed) — see client-headroom-dossier.md + the Discord
   cross-check; derive the byte-signature patch, soak-test (paradox's "may be an
   intentional workaround" caveat).
