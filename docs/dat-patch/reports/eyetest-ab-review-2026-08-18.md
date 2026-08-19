# r7 vs r7.1 A/B eye-test review + r7.1 defect root-cause — 2026-08-18 (evening session)

Reviews the unattended A/B capture launched at the HANDOFF-2026-08-18 close
(box ~/eyetest-ab.tgz, retrieved + verified; local copy
/mnt/wbterminal2/eyetest-ab-2026-08-18/, all 24 shots taildropped to the redmi).

## VERDICT — r7.1 FAILS the announce gate, two independent defects

### Defect 1: the r7.1 arm CRASHED at world entry (gallery unusable for colour review)
- r7 arm: all 5 stops rendered correctly, `faults=0` throughout. Holtburg shot
  is a clean baseline (terrain, buildings, NPCs, sky all present).
- r7.1 arm: char-select fine (portal UI/char textures decode), then the client
  page-faulted during the portal-space transition after Enter:
  `Unhandled page fault on read access to D59C0000 at address 00525E70`.
  Every r7.1 "stop" screenshot is the same frozen portal-tunnel frame with the
  wine crash dialog (`faults=1` from the first mark, never grew).
- EIP mapping (acclient.map, VA = RVA+0x401000): 0x00525E70 = RVA 0x124E70 →
  inside `Frame::combine(Frame const&, AFrame const&)` (0x124D80..0x124E8F) —
  animation/physics frame math, NOT texture decode. Wild-pointer read.
- REPRO RUN (same box, same exe, same dat, 2 consecutive solo r7.1 arms):
  arm A ran CLEAN through charsel → world entry → Holtburg → soak, 0 faults.
  → The crash is INTERMITTENT, not content-deterministic. See "crash
  investigation" below for the standing analysis; arm B verdict + the decomp
  investigation report the mechanism candidates.

### Defect 2: r7.1 silently shipped 711 of its 2,192 rebaked textures 4× SMALLER than r7
Record-level cross-audit of the two dats (structure-parse of every changed
record in both, decompressed, header-checked):
- Identical 83,617-record id sets; only the 2,192 rebaked 0x06 RenderSurface
  records differ. EVERY record in both dats is internally consistent (header
  closure exact, payload length matches width×height×format). No corruption.
- BUT 711 of the 2,192 are exactly 4× smaller per side in r7.1 (2048²→512²,
  1024²→256², …). 1 record (0x06007370) flipped DXT1→DXT5 (internally valid).
- Mechanism (fully traced): take5 pointed DATPATCH_REMACRI at the A-arm
  deblock corpus `/mnt/wbterminal2/deblock-ab/out-remacri-full/` (1,630 files)
  replacing the r7 rewrap corpus `/mnt/wbterminal2/upscale-corpus/rewrap-out/out/`
  (4,041 files). The deblock corpus was built from the block-artifact census
  CSV (1,630 rows) — a subset scope, never a full-lane scope. All 711
  regressed ids: corpus png MISSING (0/711 present; the 1,477 dim-preserved
  ids: 1,477/1,481 present). The lanes fell back to a 1× bake from the
  (deblocked) retail-res source. `missing-corpus-triage.json` caught only 95
  of the 711 (98 rows, texture-remacri + creatures lanes only) — the other
  lanes fell back silently. No gate compared shipped dims against r7.
- All 711 have sources in DATPATCH_TEX_BASE and all 711 are covered by the
  old rewrap corpus — nothing is unrecoverable.

## FIX IN FLIGHT (this session) — corpus completion, "delta-711"
1. Deblocked all 711 sources locally (deblock.py batch, passes=2):
   src grid excess mean +26.6% → −0.7%, detail kept mean 102% / p10 98% —
   matches the adopted A-arm quality. Output:
   /mnt/wbterminal2/deblock-ab/in-deblocked-delta711/ (+ ledger).
2. Staged to buildbox ~/delta711/in (sha-verified) + ~/up_delta711.py
   (up_deblock_ab.py clone: Remacri 4×, wrap-pad 16, same weights).
   T4 run launches after the crash-repro run releases the GPU.
3. Merge plan: out → out-remacri-full (disjoint ids, pure add), then re-run
   r7_take5.sh (fresh bake root; cache off) → r7.2 candidate.

## Pipeline hardening this take exposed (to land with the fix)
- take5 needs a DIMS LEDGER gate alongside the colour ledger: after the lanes,
  compare every shipped bake's dims against the previous release's record;
  any downscale = FATAL unless whitelisted. (The colour gate passed while 711
  textures quietly lost 4× resolution — same class of eye-only catch the
  colour ledger was built to kill.)
- Corpus adoption must be coverage-checked: new corpus must cover ≥ the id set
  the old corpus actually served, or the lane must fall back to the OLD corpus
  file (not to a 1× rebake) for the missing ids.

## Crash investigation state
- The dats are structurally clean (above), so the crash is NOT a malformed
  record. Both r7 and r7.1 carry ~20.6k zlib-compressed 0x06 records and the
  r7 arm toured clean, so record-compression per se is field-proven with the
  box-decompress exe.
- Standing hypotheses (decomp investigation running): heap corruption from the
  in-exe decompress path under concurrent texture load (intermittent by heap
  layout/timing), vs a wine/host flake. r7 has 1 clean tour; r7.1 now 1 crash +
  ≥1 clean tour on identical bytes.
- Practical consequence: the announce gate needs N clean r7.2 tours (not 1) and
  the crash mechanism understood or bounded before ship.

## Coverage audit (owner Qs: terrain / building stories / dungeon z) — 2026-08-18 late
Full world-reachability audit (retail cell.dat walk: 805,348 records, 734,976
EnvCells z −324..+654, 0 parse fails; 6,979 building placements / 398 models;
portal graph GfxObj→Surface→SurfaceTexture→RenderSurface; script + JSON in the
session scratchpad, key numbers here):
- **Terrain: 0% by design.** 29 base + 3 detail + 16 blend/road textures — none
  in any lane. Client-side cap (decomp): TexMerge::FillTempTexBuffer composites
  each land cell into a fixed `4·baseTexSize²` buffer (baseTexSize=1024 in the
  EOR Region), CopyAndTile tiles the source into it — ~43 texels/m regardless
  of source res. Dungeon walls render Surfaces directly (source res = screen
  res). Terrain gains need Region baseTexSize (the OOM'd terrain-2x) or the D5
  detail-texture path (EOR Region already carries detailTextureId @ 4× tiling).
- **Buildings: 98.8% portal coverage** (585/592 portal-resident textures in
  corpus; Yaraq 100% on every model). Degrade (0x11) LOD variants add ZERO new
  textures (verified closure). 440 building texture top-levels are
  highres-resident — all 440 present in our r7.1 client_highres.dat; they only
  load once force-mount ships. "Plain second stories" = model design (large
  flat polys tiling near-uniform stucco; Remacri can't invent detail) +
  per-part distance LOD (geometry, untouched by texture takes).
- **Dungeons: 99.4%** (708/712 portal-resident textures across ALL EnvCells —
  enumeration is by record id, so every z level is included by construction).
- **Total genuine gap: 9 textures** (5 small INDEX16, 2 tiny DXT1, and
  0x06006D4B/0x06006D50 512² A8R8G8B8): 0x06003E95, 0x06003FC2, 0x060042CB,
  0x06004463, 0x060044F6, 0x0600485C, 0x06006D4B, 0x06006D50 (+0x06003A24-style
  ids that looked missing were highres-resident chain levels, a counting trap).
  Candidate micro-lane for r8.

## Crash follow-ups (Opus agent + checks)
- B-tree metadata diff r7 vs r7.1: 0 version-word diffs, 0 zero-version
  records (hypothesis "DatCompact broke BTEntry.ver_" REFUTED). 14 compressed
  bit flips are small textures gone incompressible — benign.
- Retail portal already ships 10 DXT records with min-dim ≤16 (down to 8×8) →
  the "sub-4px mip chain" amplifier hypothesis REFUTED (client handles them).
- Remaining candidates are environment/timing (VA pressure near the 32-bit LAA
  ceiling; cross-thread CAnimation pos_frames recycle race) — NOT r7.1-content.
  Wine's reported EIP/fault pair is internally inconsistent (faulting address
  was read earlier in the same call), pointing at a transient unmap. Gate
  consequence: require N clean tours, capture future crashes with backtrace
  (winedbg) not just +seh.
- **SECOND CRASH SAMPLE 2026-08-19 09:32Z — ON THE R7 BASELINE ARM** (the dat
  that toured clean twice): read of D8F90000 at EIP 00525E7E — same
  Frame::combine tail (14 bytes past the first sample's EIP), same
  64KB-aligned 3.3-3.6GB wild-address class, again during world entry, VmSize
  1.82 GB at the crash mark (first data from the new ledger). One c0000005 in
  the whole log (no alloc-failure chatter). **r7.1/r7.2 content definitively
  exonerated** — crash rate ~2/6 world-entries on this box this week,
  dat-independent. Forensics: /mnt/wbterminal2/eyetest-ab-2026-08-18/
  r7-crash-0819/. Capture driver now installs `winedbg --auto` as AeDebug so
  the NEXT crash yields a real backtrace and the tour dies fast instead of
  freezing; per-arm 5s VmSize sampler added.

## r7.2 build — DONE 2026-08-19 09:18Z, ALL GATES GREEN
- Corpus completed: out-remacri-full = 2,341 files (1,630 A-arm + 711 delta;
  delta deblock quality matches A-arm: +26.6%→−0.7%, kept 102%).
- r7_take5.sh full rerun (fresh bake root, ~10h laptop wall-clock):
  colour ledger PASS (6/2169 out of band 0.28%, 0 darker, castDrift p90 0.0034)
  · degrade fold: 1 violation found+fixed (the known shared-chain 0x05000ECE),
  ship gate 0 · **DIMS LEDGER GATE PASS: 0 downscales / 0 upscales / 0 format
  changes / 0 missing vs r7** · strict walk 83,618 OK.
- **r7.2 portal = 1,499,357,184 B (1.397 GiB)**, /mnt/wbterminal2/dat-patch-r7/
  export/client_portal.dat. Spot-verified pre-compact: 711/711 restored to r7
  dims+format (incl. 0x06007370 back to DXT1).
- ANNOUNCE-GATE CAPTURE launched 2026-08-19 ~09:35Z on the box (unattended,
  ~/eyetest-r72.sh, single instance verified): 3 arms — r7 baseline, r7.2 ×2
  (crash-flake statistics) — 5 stops + NEW creature-closeup stop (@attackable
  off + @create 7 + @create 11058) + NEW per-mark VmSize ledger. Tars to
  ~/eyetest-r72.tgz, restores r7 default, powers the box off.
  RETRIEVE: boot box → scp ~/eyetest-r72.tgz{,.sha256} → review gallery
  (deblock + colour before/after, now WITH the 711 at 4×) + VmSize curves.

### CAPTURE RESULT (attempt 2, 2026-08-19 10:30Z) — ALL THREE ARMS CLEAN
- Attempt 1: r7 arm crashed (the second Frame::combine flake sample, above) and
  a SPOT preempt killed r72a — full rerun with the hardened driver.
- Attempt 2: r7, r72a, r72b ALL toured 7 stops (incl. creature closeup: Drudge
  + Olthoi Soldier @create'd at camera) with faults=0, soak VmSize 2.206 /
  2.212 / 2.213 GB — r7.2 ≡ r7 in memory, clean at 2.2 GB (so the 1.82 GB
  crash sample is not a simple VmSize threshold). 42 shots, sha-verified →
  /mnt/wbterminal2/eyetest-r72-2026-08-19/ (full gallery taildropped to the
  redmi for owner review). Box left clean: r7 default restored byte-verified,
  powered off. r7.2 = 2 clean world tours / 2 attempts on the arm content.
- Leftover: per-5s vmsize curves are on the box disk (~/eyetest-r72/*-vmsize.log,
  missed the tar; driver fixed) — grab during the next box session.
- ANNOUNCE STATUS: r7.2 has passed every automated gate + 2 clean tours; the
  gallery is now awaiting the OWNER eye-review (deblock quilting gone at
  0600378C-class walls, Muggy median, colour vs retail, Yaraq 4× restored).
  Next box session batches: F3 gate + force-mount arm-D WORLD tour (with our
  custom highres) + vmsize-log pickup.

## Plan reconciliation vs PLAN-2026-08-18 + HANDOFF-2026-08-17-EOD3 (2026-08-19)
Dat-size expectations: r7 1.52 GiB → r7.1 1.35 GiB (an artifact of the 711 bug)
→ r7.2 ~1.45-1.5 GiB (+337 MB highres prototype) → r8 HIFI split variant B:
portal ~0.9 GiB + highres ~648 MB (ours moved in, superseded retail DELETED
from portal, both compacted) = ~1.52 GB combined, ~2.77 GB total runway.
Phases 0-2 done/decided; Phase 3 (the split) = current queue item 4; Phase 4
"add triangles" (scenery aa+ab finish, 9 degrade-deferred, env re-cut,
creature-subdiv spike) correctly parked behind the split's freed 617 MiB.
RE-PINNED items that had dropped out of the tracked queue:
1. Phase 2.3 fresh-install gate — post-split a kit missing client_highres.dat
   must fail LOUDLY; simulate before r8 ships.
2. VmSize ledger in the eye-test/tour driver (plan: "no lane ships without
   it") — also the VA-pressure telemetry the crash investigation wants.
3. Creature-closeup stop in the tour (1.5 gate spec; current driver lacks it).
4. r8 highres build must route DXT through WBT render-surface-import (the 337MB
   prototype used the scaffolding encoder).
5. NEW from the coverage audit: the 9-texture micro-lane (only genuinely
   unbaked world textures) — cheap r8 passenger.

## Artifacts
- A/B gallery + timelines: /mnt/wbterminal2/eyetest-ab-2026-08-18/
- Repro run: box ~/eyetest-repro/ (charsel/enter20s/enter45s/holtburg/soak
  shots + full WINEDEBUG=+seh wine logs per arm)
- Record audits + downscaled id list: scratchpad downscaled-711.json → copy
  at /mnt/wbterminal2/deblock-ab/in-deblocked-delta711/ (ledger names the set)
