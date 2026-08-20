# HANDOFF — 2026-08-20 EOD (r9 gate crash+fix in flight, AcmeRedline built, roadmap researched)

> **RESOLVED 2026-08-20 late evening — the r9 gate is GREEN, but the fix below
> was NOT sufficient on its own.** The world-only dat this handoff prescribed
> ALSO crashed (same 0x420a0): the "world" tier was classified by SIZE, which
> let 493 large UI surfaces through (320x480 char-gen portraits, banners,
> backgrounds — CPU-blitted like icons). The real rule is REACHABILITY: a 0x06
> may ship re-encoded only if referenced by an 0x05 SurfaceTexture (or in the
> retail EoR highres id set). `tools/dat-patch/surftex_reach.py` is the gate;
> `DatCompact --exclude` cut the 493 by reconstruction. Final highres:
> 1,332,324,352 B, 9,081 records, sha c68fb079… — survived char-select,
> entered the world, stable to the full watcher lifetime on the 1070.
> Corrected story + gates in reports/phase4-fill-RESULTS.md. Kit rebuilt at
> /mnt/wbterminal2/dat-patch-r9/kit-r9b/. The creature-subdiv in-client
> eye-test (step 5 below) is still owed — it needs the scratch portal staged
> on box+ACE plus a chat-capable second client to @create; session-sized.

Continues HANDOFF-2026-08-20-fill.md. Three parallel tracks this session: (1) the
r9 kit's 1070 in-client gate found a client crash and I'm mid-fix; (2) a new
in-game annotation plugin **AcmeRedline** was designed+built end-to-end across 3
agent phases; (3) the remaining Phase-4 lanes were researched and two were
implemented. Everything committed here except the dat artifacts (they live on
/mnt/wbterminal2, not git).

## ⚠ FIRST THING NEXT SESSION — finish the r9 gate

**The shipped r9 kit (commit 3d153372) CRASHES the retail client.** Root-caused
and a fix is landing. Do NOT announce r9 until the gate below is green.

### What crashed and why (fully diagnosed)
- Running the 1070 in-client gate on the r9 kit: DDD interrogation PASSES (dats
  accepted, force-mount works, exe 8/8 patched), then a deterministic 0xC0000005
  at fault offset 0x420a0 at CHARACTER-SELECT, ~5 s in, before world entry.
  0x420a0 ≈ `SurfaceWindow::LegacyBlit` (the CPU-side 2D UI blit).
- **Root cause: DXT-encoded UI/icons.** This session's tier C+D icon fill
  converted 12,664 retail A8R8G8B8 UI surfaces to DXT5. Retail stores icons
  UNCOMPRESSED because the client CPU-blits them (SurfaceWindow) — the 2D blit
  path can't decode DXT → AV the instant char-select loads a UI icon. World
  textures go through the GPU 3D pipeline where DXT is fine, which is why r8
  (world-only, no icons) gated clean and why PLAN-2026-08-18 DEFERRED icons.
  (Independently confirmed by the terrain research: the 2048 texture wall is
  UI-only, `UISurface::CreateSurface`.)
- Bisect proof: r9-portal + r8-highres survives 60 s+; r9-portal + r9-highres
  crashes. Fault is the highres icon fill.
- A red herring en route: 70 records were oversize (>2048, the 4x upscale
  uncapped); capping them changed nothing (same 0x420a0). Real defect, fixed
  anyway.

### The fix (IN FLIGHT at session end)
Ship the highres as **r8 + session-1 WORLD fill only, no icons** = 9,574 records
(4,706 r8 + 1,746 world DXT + 3,122 world palette). Build state:
- `/mnt/wbterminal2/fill-2026-08-20/r9/client_highres.world.dat` — all 9,574
  landed, palettes readback-verified, 5 sneaky oversize records (the 4096 bakes
  that slipped past the manifest substitution) re-capped to ≤2048, large
  multi-block records read-back-verified clean (no corruption).
- A **DatCompact was running at session end** → `client_highres.world.final.dat`.
  CHECK IT FIRST: `tail /tmp/.../tasks/bquwvy8tp.output` or just
  `python3 tools/dat-patch/walk_check.py .../client_highres.world.final.dat`
  (expect entries=9575-ish, free small, OK) and confirm 0 oversize:
  ```
  python3 - <<'PY'
  import sys,struct; sys.path.insert(0,'tools/dat-patch'); import datlib
  d=datlib.Dat('/mnt/wbterminal2/fill-2026-08-20/r9/client_highres.world.final.dat')
  o=sum(1 for i in d.files if (i>>24)==0x06 and (lambda b:struct.unpack_from('<6I',b,0)[2]>2048 or struct.unpack_from('<6I',b,0)[3]>2048)(d.get(i)))
  print('records',len([i for i in d.files if (i>>24)==0x06]),'oversize',o)
  PY
  ```

### Resume the gate (the exact steps)
1. `cp client_highres.world.final.dat` → `/mnt/wbterminal2/dat-patch-r9/ace-r9-dats/client_highres.dat` and restart ACE (see §BOX STATE for the FIFO recipe).
2. `scp` it to the 1070 `D:\ac-dat-test\client_highres.dat` (portal there is already r9; sha-check after).
3. Re-run the gate task `schtasks /run /tn acdtgater9` (off-screen + muted; watcher `C:\Temp\acdt-watch.ps1`). Watch `C:\Temp\acdt\watch.log` — SURVIVING past shot04 (~60 s, no `EXITED code=-107…`) = the icon-drop fixed it. Then char-select-click (`acdtclick1`, coords 150,230) to enter world and eyeball the world-surface fill.
4. **If it enters world:** rebuild the shippable r9 kit from the world-only highres + the r9 portal (`/mnt/wbterminal2/fill-2026-08-20/r9/client_portal_r9.dat`) + r8 cell, via `tools/dat-patch/kit/assemble_kit.sh --tag r9 … --package`, re-hash, update phase4-fill-RESULTS.md (icons dropped, world-only ship, oversize+corruption fixed), commit, push. The current committed RESULTS.md describes the CRASHING kit — correct it.
5. **Also fold in the creature-subdiv POC eye-test** (see §roadmap) on the same 1070 session: `@create` the Banderling and confirm it animates from the scratch portal.

### Coverage reality after the fix
World-only highres = the VALUABLE coverage (world surfaces ≥64px ≈ 100%). The
"99.5% of 20,684 records" number in the committed RESULTS.md was inflated by the
icons and is no longer true — real world-surface record count ≈ 9,574. Icons stay
deferred (they can't ship as DXT, and A8R8G8B8 icons cost ~810 MB for the
least-visible class).

## AcmeRedline — new in-game annotation plugin (built this session, 3 phases)
A Chorizite plugin: select textures/triangles in-game, type feedback, it queues to
JSON; an AI executor walks the queue and fixes each item through our dat lanes;
status flows back and glows in-world. Committed under `AcmeRedline/` (C# plugin)
and `tools/dat-patch/redline/` + `docs/redline/` (pipeline). Build is clean (0/0).
- **Client** (`AcmeRedline/`): SkunkVision-style D3D9 vtable-hook overlay (mutates
  the client's own draw calls — no 3D overlay API exists; method + MIT attribution
  in README), object/triangle/texture picking with a verified world→screen
  projection (reads `m_GState` MVP), lasso + "all instances of a texture in view",
  in-world status tint (queued=yellow/in-progress=blue/fixed=green), my-reports
  panel. Screenshots stubbed (no pixel readback in Chorizite — honest empty
  attachments). Triangle-index convention PINNED: fan-triangle-all-polys.
- **Pipeline** (`tools/dat-patch/redline/`): schema_v1.json (frozen), queue_worker
  (validate→resolve→guard→classify→aggregate), executor (drives lanes as black
  boxes, dry-run default, base-dat write-guard, per-record readback verify),
  status_writer, gen_kit_meta, verify_fix (A/B board), build_kit_with_meta.sh.
- **QA review** (`docs/dat-patch/reports/session-tooling-review-2026-08-20.md`)
  found + I FIXED: F1 executor used the corrupting prep_dat flow (now
  DatCompress-first + readback verify), F2 lost-status, F3 texel_survey 0x0D loop
  was a no-op (now walks dungeon cells), F4 dead prep guard. Deferred verify TODOs
  (large-record executor smoke) are listed in the review + executor DESIGN.md §10.

## Roadmap research — all remaining Phase-4 lanes (docs/dat-patch/research/)
- **4.P4 creature subdiv — GREEN, PROVEN.** AC animation is rigid part-frame, NO
  vertex skinning → subdividing a part can't break animation. POC on Banderling
  body 0x01002C00: 9/9 invariants PASS (Setup byte-identical). Tools
  `creature_enum.py` (2,155 candidates) + `creature_tranche.py`. POC report:
  reports/phase4-P4-creature-subdiv-POC.md. NEXT: the in-client eye-test
  (poke-through on concave parts is the one risk), then scale out (buildbox).
- **4.H2 detail textures — GREEN, SHIPPED to scratch.** 3 records, DXT5,
  `detail_texture_lane.py`, gate PASS. Turnkey; just needs landing into the r9
  highres + a gate.
- **4.H1 creature textures — the plan's framing was HALF-WRONG.** Recolor is an
  index→palette indirection; DXT freezes it. Correct path = stay INDEX16 + upscale
  (already what fill_import does; 3,122 shipped this session). Depalettize only for
  never-recolored statues. First step: read-only check whether the 811 recolor-live
  creatures are already covered at 2×. Doc: creature-texture-4h1-research.md.
- **4.P3 env re-cut — YELLOW.** Orientation veto already wired. Blocker: no
  current-content pre-envgeo portal exists, but r9-portal minus the 3,928 clone
  records reconstructs one. Recipe: PREP-envgeo-recut-lineage-2026-08-20.md.
- **4.H4 selective 4096² — YELLOW.** No 3D texture cap, but a 4-level mip clamp
  limits 4096² to near-field. `texel_survey.py` (now covers dungeon cells too):
  47-surface short list; true view-distance is the missing input.
- **4.H3 terrain-2x — RED.** D4 diagnostic already hard-failed twice (VmSize AV);
  TexMerge allocates 4·baseTexSize² per composite. Dead in current form.
- **Dungeon geometry:** env_geo.py IS the lane; 6,236 wall clusters left unbuilt by
  the old --top=1000 cap, 24.7% of indoor cells never displaced (dungeon_coverage.py).

## BOX STATE
- **ACE**: running on `/mnt/wbterminal2/dat-patch-r9/ace-r9-dats/` (Config.js
  repointed from r7; backup Config.js.bak-r7-20260820). Currently serving the
  WORLD-ONLY highres will need the final.dat copied in + restart. Restart recipe:
  `echo stop-now > ~/ace_stdin.fifo`; wait for exit; a `sleep infinity > ~/ace_stdin.fifo`
  writer must be alive, then `cd $ACERT && setsid nohup dotnet ACE.Server.dll < ~/ace_stdin.fifo >/dev/null 2>&1 & disown`. Confirm `ss -ulpn|grep :9000`.
- **1070**: `D:\ac-dat-test` has the r9 portal + a highres to be replaced by the
  world-only final. The CRASHING r9 highres is parked as `client_highres.dat.r9crash-hold`;
  r8 backups as `.r8-bak`. Kit zip verified on box. Gate scripts in `C:\Temp\acdt-*`,
  watcher enforces off-screen + WASAPI per-PID mute + hidden consoles. User was idle
  40 min throughout; no sound ever reached them. Kill test client by `--user-data-dir`
  / `taskkill /IM acclient.exe` (test-only box copy).
- **buildbox**: powered off (was used earlier for the 117 Remacri upscales). SPOT.
- **laptop OOM lesson**: 4 concurrent heavy dat jobs OOM'd earlyoom and CORRUPTED a
  working dat (header FileSize short-write) — healed via DatCompact. Keep heavy dat
  I/O serialized; research/review agents must be read-only (no WBT, no multi-GB loads).

## THINGS THAT BIT (all fixed)
- WBT typed TryWriteFile 5MB pack buffer overran on 4096-side records → WBT now
  routes >4.5MB through TryWriteFileBytes (committed 3d153372).
- DatCompress leaks freed tail blocks → the ceiling crash; recovered via DatCompact.
- prep_dat zeroed-arena + import silently corrupts records >65 blocks → use
  cp→DatCompress→import (executor F1 fixed).
- `rg -rn` = `--replace n` redacts digits to "n" — two agents + I hit it; use `rg -n`.
