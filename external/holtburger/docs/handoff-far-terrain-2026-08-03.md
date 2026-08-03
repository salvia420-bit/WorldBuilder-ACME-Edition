# HANDOFF — far-terrain wave (fog + Far Composite Ring), 2026-08-03

State of the two-day bug/visual campaign as of commit `edd42cba`. Everything below
is pushed; working tree clean. Prior session context: commits `8ff7dab3` (equipment/
selection), `f05a542f` (physics/input), `1bba6516` (follow-ups), `a346941b`,
`f48ad556` (visual pass 1), `7241932c` (wield orphaning), `c3f9f147` (backlog sweep),
`93f7f8ce` (visual pass 2), `becba0d1` + `edd42cba` (this wave).

## What shipped in the far-terrain wave

- **Retail range fog, default ON** (`?terrainFog`, master `?farTerrain`): the terrain
  shader was the one surface with no fog code. Ranges are the DAT's authored
  `SkyDesc::GetWorldFog` values (day 150→2400m, night 0→400m, time-of-day lerped,
  already exposed by the wasm as `SkyState.fogMin/fogMax/fogColorArgbLerp`).
  Fog COLOR is sampled from the rendered sky's horizon radiance (8×8 HalfFloat probe,
  4Hz, `loop.js` `sampleHorizonSkyRadiance`) because the authored sRGB hex fed into
  the exposure-5 AGX pipeline rendered night fog brighter than the night sky.
  `?farFogTint` blends authored DAT chroma back at preserved luminance (ships 0).
  Clamp: `fogFar = min(authored, 0.95·(R_eff+0.5)·192)`, floor 700m capped at the
  true drawn edge; `R_eff` is MEASURED (near ring from the live batch, far ring from
  baked+visible patches) so fog always hides the real edge during fill and after
  governor collapse.
- **Far Composite Ring** (`?farRing=on`, **default OFF** — see blocker): far LBs baked
  once through a clone of the live terrain material (ortho camera 1000m up, so every
  distance ramp resolves to its far value — ice/BC7/mud/macro bake in with no forked
  logic), 4×4-LB patches with mips+aniso, opaque `depthWrite` + `discard` under the
  measured near radius, heights-only streaming (statics/cells/scenery hard-capped at
  radius 5 with a live policy assertion), Gouraud sun term applied LIVE via a JS port
  of retail `calc_lighting` normals. `window.__farTerrainState()` is the probe.
- **Pass-2 aerial desaturate/cool wash retired** per user verdict (`aerialMax`/
  `aerialDesat` 0.0, dissolve OFF). NOTE: `?farTerrain=off` does NOT restore the wash;
  the full pre-wave arm is `?farTerrain=off&aerialDepth=on&aerialMax=0.62&aerialDesat=0.72`.

## Gate results (FARGATE, 2026-08-03, Intel HD 520 — 1070 was offline all round)

PASS: S0 no-op byte-identity vs a real pre-wave build; fog acceptance at `ov` and at
02:00 (exact, delta ≤0.1); mid-field wash cleaner than the retail-2400 reference;
ring look (RINGNF mountains survive with fog on, deltas −12…−16.5 as predicted);
seam invisible (max row step 1.4–4.1/255, same as ring-off); full-bake telemetry
clean; 4 boots 0 errors.

FAIL (and why it argues FOR the ring): coast/mtn vantages show a +21…+27 glowing band
at 09:00/19:00 — caused by the 1056m drawn edge silhouetting BELOW the true horizon
into the sky's dark sub-horizon band. With `?farRing=on` the same vantages read
−12…−16.5. The ring is the fix for the one failed item.

## THE ONE BLOCKER between `farRing` and default-ON

`assertRadiusPolicy` (far_terrain.js ~:1026) scans `farLbKeys` — every LB the far path
EVER fetched, never pruned — against the near ring's `staticsBakedLbs` LRU, which
legitimately retains recently-visited LBs. After 2 `@teleloc` hops they overlap at
Chebyshev 7 > gate 6 → `policyOk` false, sticky. Almost certainly a diagnostic false
positive (statics count stayed 120 before/after; terrain exactly 121; caps held).

- Fix: prune `farLbKeys` to the live patch set, or skip LBs the near ring currently
  owns (1–3 lines in far_terrain.js).
- Re-check: `node scratchpad/farval/fg-policy.mjs` (boots ring-on, hops 2 LB west,
  polls `policyViolations` 3 min; pass = true throughout). Control: same with
  `?farRing=off` reading `staticsBakedLbs` Chebyshev membership (`fg-probe.mjs`) —
  if ring-off also holds cheb-7 statics, the assertion is confirmed false-positive
  and farRing can flip on that alone.
- Ice condition (pre-declared, CRITIQUE §3(iv), UNREACHED): `ARM=on|off GAP=90 node
  fg-ice.mjs` — `@telepoi Linvak Tukal`, `&quality=high&terrainIce=on` (terrainIce is
  false on EVERY tier; both arms need it explicitly), residency ≥90 LBs, hours 12/9.
  If a frozen vista at ring-on reads flatter than `?pvsRingRadius=10&farRing=off`,
  S6b (baked gloss channel + one broad far-shader lobe) becomes REQUIRED.

## Outstanding queue (ranked)

1. farRing unblock (above) → flip default → re-shoot beauty set on the 1070.
2. 1070 housekeeping when it returns (offline since ~2026-08-03 morning): delete
   scheduled task `WBFAR`, kill Chrome under `C:\Temp\cdpwb-vis3`; then the deferred
   perf numbers (probe-cost A/B `fg-probe.mjs`, ring frame-time, mid-vs-mid+CSM).
3. S5 (array-RT consolidation — the mip trap is documented at the RT creation site)
   and S6a/b (256² + tighter near ring; gloss channel) remain unbuilt.
4. loop.js spawn-drop candidates (documented in scripts/spawn-drop-probe.cjs header).
5. Low-sun CSM eye-test + POM roof A/B (`?pomGraze=off`) — shipped, never eyeballed.
6. `?terrainBc7` (terrain-atlas BC7, default OFF) — unexercised; interacts with the
   macro layer. Daytime `environmentIntensity` still floored at 0.2 by dead arithmetic.
7. Far-terrain contour banding (genuine per-cell type transitions) — macro can't fix;
   forest impostors are the real answer if wanted.
8. Diagonal fog corners (√2 mismatch, retail-faithful, cosmetic).

## Archives

- Design/critique/ground truth/gate evidence: session scratchpad `farterrain/`,
  `farfix/`, `farval/` dirs (temp) — durable copies of pass 1+2 evidence at
  `/mnt/wbterminal2/holtburger-vistest/2026-08-02-visual-{quality,pass2}/`.
  Pre-wave mirror tree for S0 arms: `/mnt/wbterminal2/prewave-holt`.
- Published reports: pass 1 and pass 2 artifact pages (links in the session log).
- Beauty set (10 shots, HD 520): scratchpad `farterrain/beauty/` — re-shoot on the
  1070 after the farRing flip for the definitive set.
