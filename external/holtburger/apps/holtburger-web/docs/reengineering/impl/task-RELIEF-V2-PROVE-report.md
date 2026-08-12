# task RELIEF-V2-PROVE — did relief v2 actually fix the 07-30 showcase?

Lane R, session 13, 2026-08-12. Branch `orch/s13-relief`, worktree
`/home/wbterminal/fanout-s12/B`. T4, driver 550.54.15, serve :8772 from
`~/holtburger-dist-v4`.

`HANDOFF-relief-v2-2026-07-31.md` (`509bab3f`) diagnosed four causes and called
all four "fixed or explained". It was a diagnosis; nobody had re-shot it. This
is the re-shoot.

**Verdict in one line: three of the four causes are genuinely fixed and I can
show it; cause 2 is fixed for 139 of 148 textures but NOT for the doc's own
headline example, which is the single worst case in the set.**

---

## Verdicts

| # | symptom | verdict | strongest evidence |
|---|---|---|---|
| 1 | everything low-res | **FIXED — and the doc's stated mechanism was already wrong when written** | `s13-R-BC7-vs-retail-0x06004381-ZOOM.png` |
| 2 | paneling/pagoda/torii vanilla | **MOSTLY FIXED — 139/148, with a real 9-texture tail incl. the named victim** | `s13-R-gate-planks-0x06004376-relief.png`, `s13-R-CAUSE2-residual-still-flat.png` |
| 3 | dents ON the stones, not between | **FIXED, decisively, corpus-wide** | `s13-R-DENTS-stonewall-0x0600436E-CROP.png` |
| 4 | effects seem random | **FIXED** — it was the consequence of 2 and 3, and 3 is the part that produced the randomness | same as 3 |

---

## Cause 1 — "everything low-res"

The doc says the shots missed `?texBc7=on`, "an EXACT-MATCH opt-in", leaving
2,999 BC7 payloads unfetched.

**That premise is false for any build after 2026-07-30.** `texBc7` is
DEFAULT-ON. `bc7_textures.js:114` is `let on = true;` and `:122` is
`on = !flagIsOff(...)`, where `flagIsOff` (`:97-101`) only returns true for
`off|0|false|no`. The docstring immediately above at `:104` still claims
exact-match opt-in — it is stale, and it is what kept this belief alive across
two sessions. Fixed in `a8f69cf5`.

`docs/url-flags.md:648` has it right *today* — and it records why the handoff
did not: the cell says the flag is ON, "flipped 2026-07-30 …
**this cell said 'off' until 2026-08-02**". The handoff was written **07-31**,
inside that two-day window when the docstring *and* the flag table both still
said off. The author had no correct source to read. This was a documentation
lag, not carelessness, and it cost three sessions.

Measured in-page on the T4 (`eyetest-B/out/arm-s13R-bc7.json`):

```
renderer: ANGLE (NVIDIA Corporation, Tesla T4/PCIe/SSE2, OpenGL ES 3.2)
bptc: true
absent: true   on: true   one: true   bogus: true   off: false
```

So the flag was never the mechanism. The doc's *other* clause is the real one:
`bc7-webroot/apps/holtburger-web/dist` was a stale symlink to the plain dist,
so the fetches 404'd. That was a serving fault, not a URL fault.

**On this box the serving path is healthy**, checked before shooting anything
per the doc's own trap:

- `GET /dist/manifest/holtburger-tex-bc7.bin` → **200, 60,126 B** (matches disk)
- manifest parsed independently: magic `HBNS`, v1, **2,999 records**, exact byte
  accounting (60,118 of 60,118 consumed), footer magic `SNBH`
- `0x06004381` → `shards/1d/1db159fb35745d7508459105ee4f500e.bin` → **200, 349,572 B**
- container: magic `HBC7`, 512×512, 128×128 blocks. Full mip chain to 1×1 =
  21,847 blocks × 16 B + 20 B header = **349,572 B exactly**
  (`dat_shard.rs:128-139`)
- decoded **on this T4** via `EXT_texture_compression_bptc`, 0 GL errors,
  74.1 % non-black

Retail is 128×128; BC7 is 512×512 — the ×4 upscale is real and reaching the
GPU. Mean |gradient| at identical 512 output: **1.07 retail → 1.59 BC7**.

> ⚠ Consequence for future briefs: `?texBc7=on` vs *absent* is a **no-op
> comparison** — both are ON. The only meaningful A/B is `?texBc7=off` vs
> default. Shooting "on vs absent" would produce two identical frames and look
> like a settled question when nothing was tested.

## Cause 2 — "paneling/pagoda/torii vanilla"

The classifier table is live. Not assumed — proven at three levels:

1. The v2 table is **in the shipped wasm**. `data/tex-relief-classes.compact.json`
   is `include_str!`'d at `lib.rs:12164`, and its meta string greps out of
   `pkg/holtburger_web_bg.wasm` verbatim:
   `SigLIP kNN, 412 seeds (172 census + 240 visual repair 2026-07-31), seed-override on.`
2. The **key space matches**. Table keys are `0x06…`; the lookup key `rs_id`
   comes from `surf_tex.highest_res()` (`lib.rs:12388`) and is guarded
   `rs_id >> 24 != 0x06` (`lib.rs:10004`). A `0x08`-vs-`0x06` mismatch here
   would have silently killed every lookup; it does not happen.
3. The **live path uses it**. `normal_and_height_pixels` (`lib.rs:12201`) is
   "the choke point for the singleton `normalMap`, the statics atlas `nra`
   R,G channels and POM's height" and calls `relief_height_classed` with the
   class (`lib.rs:12238`).

   Note `lib.rs:232` still calls the *unclassed* `relief_height`. That is the
   per-texel geometric displacement cache, which is dead code in practice —
   `gfxSubdivLevel` is 0 on every preset. Not a defect, but it is a real second
   call site and worth knowing about before someone "fixes" it.

Both named victims escape Flush: `0x06004381` → `Shingle`, `0x06004376` →
`Plank`, both `allows_macro()` (`height_seam.rs:522-531`).

**The gate planks are a dramatic, unambiguous win.** Under `Some(Flush)` the
height field is flat grey; under v2 the plank gaps carve and the frame border
stands proud. That is the fix working exactly as advertised.

### …but the doc's headline example is not fixed

Over all **148** macro-allowed textures in the Shoushi range
(`0x06004200-0x060044FF`), ranked by `face−joint` (mean of top height decile
minus mean of bottom decile, on the macro field):

| macro carve | count |
|---|---|
| strong (≥0.5) | **128** |
| moderate (0.2–0.5) | 11 |
| **weak (<0.2) — still reads vanilla** | **9** |

The 9 weak ones, worst first:

```
0x06004381  Shingle  128px  face-joint=0.051   <- the doc's named victim
0x0600444D  Plank     64px  face-joint=0.072
0x060043CB  Stone    256px  face-joint=0.112
0x0600435B  Stone     64px  face-joint=0.121
0x06004378  Plank     64px  face-joint=0.132
0x060044A4  Stone    128px  face-joint=0.147
0x060043CD  Stone     64px  face-joint=0.162
0x06004383  Plank     64px  face-joint=0.182
0x06004324  Stone    512px  face-joint=0.188
```

`0x06004381` — the Shoushi wall shingle the handoff calls out by name, with
`maxSim=1.0` — is the **worst of all 148**. Correct class, macro allowed, and
the seam operator still finds essentially nothing: 0.051 against ~1.0 for a
stone wall. The frame shows why: it is barrel roof tiles whose boundaries are
smooth shading gradients, and the tophat seam operator keys on narrow dark
joints. There is nothing there for it to carve.

> This matters because it is the exact texture anyone re-shooting the showcase
> will point a camera at. Fixing its *class* did not make the roof read as a
> roof. Classification was necessary but not sufficient.

⚠ Do not read `v2Span` as a health signal. For `0x06004381` it is `[0.000,
0.999]` — full range — while the tile is visually flat, because the span is set
by a handful of outlier texels. `face−joint` (decile means) is the robust
measure and disagrees completely. An earlier version of this analysis would
have passed this texture on span alone.

## Cause 3 — "dents ON the stones instead of between them"

**Fixed, and this is the cleanest result in the session.**

The v2 micro dip follows the texture's own pore-scale dark detail (65 %) blended
with noise (35 %) for macro-allowed classes (`height_seam.rs:743-762`,
`MICRO_DETAIL_MIX = 0.65`). Measured as Pearson r between the micro dip and that
dark-detail field, over all 148 textures:

| | v2 | pre-v2 |
|---|---|---|
| median r on faces | **+0.901** | **−0.001** |
| r ≥ +0.5 | **143 / 148** | **0 / 148** |

Pre-v2 is *statistically indistinguishable from random*, which is precisely the
owner's complaint stated as a number. Mean dent depth on faces also roughly
halves (0.024–0.033 v2 vs 0.043–0.062 pre-v2), so v2 both relocates the dents
and stops over-denting flat stone.

**Measurement caveat, stated because it changes the answer.** Whole-tile r is
confounded and must not be used: in a deep joint the macro is already ~0, so
`(m - dip).clamp(0,1)` (`height_seam.rs:770`) pins the measured dip to 0 exactly
where dark detail peaks, forcing r negative regardless of behaviour. My first
pass reported r = −0.29 to +0.69 and looked like a partial failure; restricting
to the **face** population (upper half of the macro field, where the clamp
cannot bite) is both the unconfounded measurement and literally the owner's
question. Both numbers are in `metrics.json` (`rWhole*` and `rFace*`).

**Control that makes the metric trustworthy.** Cloth `0x060043AC` is a painted
class, which by design keeps the content-blind micro for emblem safety. It
measures **r = −0.100 for v2 and −0.100 for pre-v2 — identical**. The metric is
not simply rewarding whatever is labelled "v2".

## Cause 4 — "effects seem random"

Downstream of 2 and 3. Cause 3 was the part that actually produced *randomness*
(a content-blind noise field dipping at r ≈ 0 with the art), and it is fixed at
r ≈ +0.90. Cause 2's residual is not random — it is uniformly flat, which reads
as "vanilla", not "random".

---

## Frames

All under `eyetest-B/drop/`.

| file | shows |
|---|---|
| `s13-R-BC7-vs-retail-0x06004381-ZOOM.png` | cause 1 settled: retail 128² blocky mush vs BC7 512² decoded on this T4 |
| `s13-R-gate-planks-0x06004376-relief.png` | cause 2 working: flat grey under 07-30 Flush → carved planks under v2 |
| `s13-R-shoushi-wall-shingle-0x06004381-relief.png` | cause 2 **not** working on the named victim |
| `s13-R-CAUSE2-residual-still-flat.png` | the 9-texture tail beside a reference that works |
| `s13-R-DENTS-stonewall-0x0600436E-CROP.png` | cause 3: pre-v2 random craters vs v2 dents tracking the art |
| `s13-R-DENTS-cloth-CONTROL-0x060043AC.png` | control: painted class deliberately unchanged |
| `s13-R-stonewall-0x0600436E-CROP-joints.png` | stone close-up, joints vs faces |
| `s13-R-DENTS-stonewall-0x06004392.png`, `s13-R-stonewall-0x06004392-*.png`, `s13-R-brick-0x060043B2-relief.png`, `s13-R-cloth-CONTROL-0x060043AC-relief.png` | supporting set |

## Method

`crates/holtburger-dat/examples/relief_v2_probe.rs` (committed, `25b9b11a`)
runs the **shipped** chain over real `client_portal.dat` pixels and dumps four
variants of the same texture:

- `flush` — `Some(Flush)`: the 07-30 margin-fallback verdict, macro OFF
- `prev2` — correct class + content-blind `micro_height`; composition mirrors
  `height_seam.rs:767-771`
- `v2` — today's `relief_height_classed`
- `macroonly` — `relief_height`, seam + pillow, no micro

No constant was edited to produce the historical variants; each is reachable
through the public API as shipped.

⚠ The class table is `#[cfg(any(target_arch = "wasm32", test))]`
(`lib.rs:12163`), so a *native* build takes the `class = None` branch
(`lib.rs:12233-12237`). The probe therefore loads the same JSON itself and
passes the class explicitly — otherwise it would have silently measured the
unclassed path and reported "no change from v2".

## What I could not verify

- **No live in-world frames.** ACE on the owner's laptop (`wbterminal`,
  `100.116.47.66:8080`) accepts TCP and then never answers — hung listener, not
  a network fault (`tailscale ping` → pong, 74 ms direct, node active). Retried;
  still dead. It is the owner's machine so I did not restart it. Everything here
  is therefore the texture/height pipeline measured directly, not a screenshot
  of the running world. The pipeline is where the relief is decided, but the
  in-world composite (POM march, lighting, LOD, atlas packing) is unverified.
- **`?texBc7=off` vs default as a live in-world A/B** — needs a booted client.
- `test_pack_fetch_region`, `test_xu7_transcode`, `harness/test_build_shell`
  **cannot run here** — they need `/mnt/wbterminal2`, which does not exist on
  this box. Not run, not green.
- The 07-30 showcase itself was never re-shot frame-for-frame; I compared
  pipeline variants rather than reproducing the original camera set.

## Gates

Run in `apps/holtburger-web/harness/`, assertion **counts** confirmed (not just
exit codes — a missing `node_modules` would kill a `three`-importing suite at
module resolution and read as a pass; these suites use `_three_stub.mjs` and
reported real counts):

```
test_diag_schema            69 passed, 0 failed   DIAG-SCHEMA ✅
test_geom_bundles           91 passed, 0 failed   GEOM-BUNDLES ✅
test_pack_fetch_controller 100 passed, 0 failed   PACK-FETCH-CONTROLLER ✅
test_tex_compressed_only   115 passed, 0 failed   TEX-COMPRESSED-ONLY ✅
test_cell_fusion            20 passed, 0 failed   ALL PASS
```

No shipped code path was modified — the only addition is an example.

## Recommendations (evidence landed, no flag flipped)

1. **Fix the stale docstring** at `bc7_textures.js:104`. It contradicts the code
   4 lines below it and has now misled at least two sessions into believing BC7
   was off by default.
2. **`0x06004381` and the other 8 need art or a second operator, not a
   classifier change.** The seam operator is joint-keyed; smooth-gradient forms
   (barrel tiles, soft-shaded plank gaps) are outside its competence. Raising
   subdiv is not the answer — per-texel displacement is retired at a measured
   5–10× Nyquist gap, and `?gfxSubdivLevel=5` crashes the renderer.
3. **Add `face−joint` as a bake-time gate.** It cleanly separates working from
   vanilla (0.05 vs ~1.0) and would have caught this tail at bake time instead
   of in a showcase. `v2Span` would not have.
4. Nothing here justifies a default flip, so none was made.
