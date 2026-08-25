# World/building screenshots — 2026-06-21 (PARTIAL — real-GPU pipeline proof)

These 8 PNGs are real-GPU captures of holtburger-web rendered on the **GTX 1070**
(`ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 … Direct3D11)`), driven by Playwright on
the 1070, launched inside the interactive console session via `schtasks` (SSH-
launched processes are walled off from the GPU by Windows session isolation —
headless falls back to SwiftShader, headed-over-SSH gets no WebGL context).

## ⚠ These are NOT the 20-shot tour that was requested

All 8 frames are the **same landblock cell `0x7d64010e`** (a Shoushi building
interior) at different camera angles. The intended tour — Holtburg / Shoushi /
Mayoi-area / mountain-town interiors+exteriors, then 10 scattered world points
from a mountain peak (z=206) to the coast (z=0) — did **not** happen because:

1. **`@teleloc` never relocated the player.** Every teleport this run was a no-op
   (the player stayed at `0x7d64010e` for all 20 stages; cross-landblock teleports
   reported `landed=false`). Cause TBD — likely the GM `@teleloc` cell/coord frame
   or an account/access issue (`<test-account>` is accessLevel 4). The academy capture
   moved the player only *within* one landblock, so cross-landblock `@teleloc` is
   unproven here.
2. **Interior camera framing** sits too close in the small EnvCell (followDistance
   ~3), so it frames walls/floor rather than furniture.

## What they DO prove

- The full chain works end-to-end on the real GPU: reverse SSH tunnel → serve.py →
  wsbridge → ACE login (`in-world` in 13s) → 3D world bake → real-GPU render →
  screenshot. Textures, normal-maps, and lighting are genuine D3D11 output.

## Next

Fix `@teleloc` cross-landblock teleport (or switch to a working navigation method)
and widen the interior camera, then re-run for the real multi-town + world set.
