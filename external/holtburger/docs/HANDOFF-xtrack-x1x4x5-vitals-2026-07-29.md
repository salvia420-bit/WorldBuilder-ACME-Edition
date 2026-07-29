# HANDOFF — X-track session 2026-07-29: smear verified, X1 census, X4 upscales, X5 nra arrays, vitals plaques

**Date:** 2026-07-29 · **Prior handoff:** `HANDOFF-xtrack-statics-textures-2026-07-28.md`
**State:** everything below is IN THIS COMMIT except the X4 outputs (stranded on the
offline 1070) and the X1 corpus (lives on `/mnt/wbterminal2`, not in git).

## 1. Smear fix — VERIFIED on the 1070 real GPU ✅

Two-arm Holtburg A/B (MODE2i, renderer asserted `ANGLE NVIDIA GTX 1070 D3D11`,
forced noon, quality=high, account per user: phase4demo): default arm matches
`?statAtlas=off` — crisp stone courses/kiln/thatch, zero non-benign console
warnings. Only delta = flatter thatch on the atlas arm = the documented
albedo-only-v1 normal-map gap, now addressed by X5 (below). Shots:
session scratchpad `shots/holtburg-default.png`, `shots/holtburg-statatlas-off.png`,
`shots/roof-ab.png`.

Recipe gotchas learned (vs the 07-28 runbook): the WS **game bridge :8080 must
also be reverse-tunneled** (`-R 8080:127.0.0.1:8080`) or login strands at
`no CharacterList within 30s`; two arms back-to-back need >30s server-side
session drop — run arms as separate invocations; a concurrent agent editing
scene3d/ breaks live-tree captures — verify against a hermetic worktree of the
target commit on a second port (used `/mnt/wbterminal2/holtburger-verify` on
:8766, since REMOVED; recreate with `git worktree add … <sha>` + symlink `dist`,
copy `pkg/`, symlink `node_modules`).

## 2. X1 census — DONE ✅ (Opus agent)

`/mnt/wbterminal2/pbr-terrain/statics-x1/` — `X1-REPORT.md`, ranked worklists
(`x1-surface-worklist.jsonl` 3,629 rows; exterior-only 1,637), contact sheets
(`sheets/x1-top200-*.png`, `x1-exterior-top100-*.png`), all 20,684 exported
PNGs (`tex/`), reproduction scripts (`scripts/`), and **`x4-input/` — 252
unique RenderSurface PNGs + manifest, the ESRGAN feed**.

Load-bearing findings: top 50 = 54.7% of placements, top 200 = 79.2%, modal
128×128; **729,888 EnvCells reference only ~804 surfaces** (interior re-skin =
best effort/impact in the track); **48% of the full census is PFID_INDEX16**
whose texture carries the runtime recolour hook — RGB replacement destroys it
(only 30/200 in the head; INDEX16 = its own X2 class); 2,104 referenced
RenderSurfaces live in the missing `client_highres.dat`; scenery barely ranks
because retail scatters it procedurally (needs its own area-weighted track).

## 3. X4 ESRGAN baseline — RUN, outputs stranded on the 1070 ⚠

`realesrgan-ncnn-vulkan` portable staged + smoke-tested at `C:\Temp\esrgan\` on
the 1070; **all 252 x4-input PNGs upscaled ×4 (realesrgan-x4plus) to
`C:\Temp\esrgan\x4-output\`** — then the box went offline before retrieval.
NEXT: when the box returns, `ssh young@100.127.215.75 "cd /d C:\Temp\esrgan &&
tar czf x4out.tgz x4-output"`, scp to
`/mnt/wbterminal2/pbr-terrain/statics-x1/`, untar, build before/after contact
sheets (T2 pattern), review. cmd.exe traps: create the output dir in its own
ssh invocation; don't trust `>nul 2>&1 &` chains — run the exe unsuppressed.

## 4. X5 statics-atlas nra arrays — IMPLEMENTED, in this commit ✅

`scene3d/static_atlas.js`: parallel normal/rough/AO `DataArrayTexture` per
bucket behind **`?statNra=on` (default OFF, exact-match reader)**; same layer
indexing as diffuse; normal XY (Z reconstructed) + roughness + AO; normalScale
baked at pack time; per-bucket-class cache-key suffix only; **the two arrays
share the old byte budget** (capacities halved 256/128/32 → 128/64/16 after an
earlyoom kill proved doubling was fatal on 8GB). Dedup census in
`window.__atlasStats()`. Flag-absent arm verified **byte-identical** to
pre-change shaders. Full report: `docs/X5-statics-nra-2026-07-28.md` (§8 has
environment repairs: ACE needs a writer holding `~/ace_stdin.fifo`).
Findings: singleton statics normals = wasm Sobel-from-luminance (100% coverage,
all dropped by v1); roughnessMap/aoMap absent on BOTH paths today, so the B
channel carries the per-material scalar (0.80–0.95) → unlocks T3 env specular.

**Before default-ON:** batched 1070 eyetest (queue with the next 1070 session:
statNra look + reconstructed-Z check), memory re-measure on a non-starved box.

## 5. Vitals orbs v3 — user art direction, in this commit ✅

`plugins/vitals-orbs.js` + `data/orb-sprites/` (still `?vitalsOrbs=on` opt-in):
- **Bael'Zharon dark again** — root cause: sprite shipped with the Setup's raw
  surfaces, no creature palette. Recolour maps sprite luminance onto his real
  DAT palette ramps (`0x04001071` via LSD wcid 36928: body 0..255 black→crimson,
  blood 320..447). A true re-render was impossible (no Setup→PNG in WB.Terminal;
  ClothingTable JSON-serialization unsupported).
- **Removed**: atlan-sword, weeping-wand, both tentacles (sprites deleted,
  layout/CSS/alpha-grids pruned; aureole gone). Kept: Asheron, bow, dark BZ.
- **Readouts**: three matching **brass-plate-on-oak plaques**, digits + `/`
  only, single-paint engraved text (stroke/shadow stack deleted). Pure CSS
  gradients — zero SVG/filters, nothing to bake. Plaque rect joins the
  pointer/drag hit area. Panes stay 3 independent WINDOW_IDs ("joined" =
  matching set; docking rejected as fragile).
- Validated in-world, 0 console errors, low-HP + vitae bands correct, flag-off
  arm byte-clean (no styles/sprites/requests). Tick ~0.66ms unchanged. One
  NON-reproducing tab wedge on a low-HP poke — pre-existing v2 feTurbulence
  refract under SwiftShader, outside this diff; watch for it in-game.
- **Awaiting the user's in-game eye test** (shots: session scratchpad
  `vitals-orbs-v3-*.png`, `shot-lowhp*.png`).

## 6. Suggested next session order

1. 1070 returns → pull X4 outputs (§3) → before/after contact sheets → review.
2. Batched 1070 eyetest: statNra ON look (+reconstructed-Z), vitals v3 in-game.
3. X2 classification (tiling vs painted vs INDEX16) over the X1 head.
4. X3 CC0 substitution using the T2 curation infra, fed by X2.
5. Interior-surface mini-track (§2's ~804-surface jackpot) — consider
   promoting; it's independent of the exterior campaign.
