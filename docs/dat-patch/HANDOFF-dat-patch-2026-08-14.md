# HANDOFF — dat-patch: retail-DAT triangles & textures (session 2026-08-14)

## 0. COURSE CORRECTION 2026-08-15 — texture-driven displacement at 4× (supersedes §3/§4 priorities)

Owner reviewed two Opus 5 concept rounds (reports: `reports/concepts-r1-REPORT.md`,
`reports/concepts-r2-REPORT.md`; boards on `/mnt/wbterminal2/dat-patch-concepts{,-r2}-2026-08-14/`).
Verdict: subdivision without displacement is invisible under Gouraud ("a flat wall is still a
flat wall"); target is now **4× triangles, texture-aware placement** — the (fixed, final)
Remacri textures are the reference for where triangles go, and geometry must synergize with
them. Physics stays untouched.

**The assembled method (round 2, working prototype in `/mnt/wbterminal2/dpc-work/`)**:
surface gate (vetoes → curated class table `/mnt/wbterminal2/gfx-material-agent/table.json`)
→ height field (`seam` operator from `relief_op.py` on the BASE texture — "base for height,
Remacri for pixels"; DeepBump ONNX fallback when seam carves <0.08) → subdivide 12–16 seg/edge,
displace outward along authored normals, boundary-edge clamp (gfx_subdiv.rs doctrine)
→ QEM-decimate to ~4× with original vertices locked → UVs recomputed in the source triangle's
frame (texture registration by construction). Gate-refused objects: PN tessellation
(needs a max-deviation guard — inflated the lifestone 0.18 m) or facet op.
Measured: image delta saturates ~25 grey levels from 2× through 64× — **4× is the knee,
not a compromise**. Spend on dungeons (735k EnvCell instances), architecture, creature PN;
skip the ~10,700-record ≤50-tri long tail.

**Blocking fixes before batch**: (a) seam `PRE_BLUR` must scale with resolution
(`sigma = 0.6·min(w,h)/128`) — fixed constant saturates on 512²/Remacri and carves blank
walls; (b) 6% of GfxObj records ship all-zero SWVertex normals (causeway modules 100%) —
writer must synthesize+store normals; (c) r2 also fixed a CullMode parse bug
(NegUVIndices read on None=1 vs Clockwise=2 — was failing 84/772 Environment records).

**Server-spawn question answered (r1, decomp-verified)**: DAT-side mesh upgrades reach
server-spawned objects automatically (client resolves SetupTableId from its own portal.dat);
deploy patched dats to both client and server, never touch physics/Height/Radius.
⚠ r1 also found both proven patch outputs contain a 1.81 GB `client_cell_1.dat` inflated
5.2× with byte-identical content — export-path bug, must be fixed before bulk patching.

**Next step (in flight)**: PRE_BLUR fix + normal synthesis → pilot batch of Holtburg
buildings through the pipeline into a patched portal.dat via obj-import
overwrite/preservePhysics + A/B gallery; dungeon Environment write path as stretch
(melt datFile tools).

**Mission**: translate holtburger-web's graphics gains (GEOMR relief triangles, Remacri
upscaled textures) into patched retail `.dat` files, so vanilla-ACE servers and the stock
retail client get the improvement with zero client/server code changes. Fable = engineer,
Opus 5 = artist. This doc is the session state + the ordered TODO.

## 1. SHIPPED THIS SESSION (three commits, all on this branch)

- **`1d8d13b4` obj-import in-place replacement** — `overwrite`, `preservePhysics`
  (collision byte-identical: the client/server-divergence invariant), `gfxObjOnly`
  (replace one part of a multi-part Setup), SortCenter + DIDDegrade carryover.
  PLUS a latent-bug fix: **every prior obj-import wrote corrupt records** — DRW 2.1.2's
  `Polygon.Pack` writes no NegUVIndices while every reader (retail/ACE/DRW-Unpack)
  expects `NumPts` of them when `SidesType==Clockwise && !NoNeg`. Rule for ALL future
  polygon construction: **set `Stippling |= NoNeg` or fill NegUVIndices.**
- **`8539e7fc` gfxobj-region-summary** — per-model JSON the artist consumes: coplanar
  regions (material, plane, outward normal), boundary/hole loops, fitted UV affine maps
  with residuals, adjacency (convex/concave dihedrals), isCollisionHull, texture
  thumbnails. 22/22 acceptance asserts vs independently-derived ground truth.
  Format discovery: **openings (doors/windows) are NOT topological holes** — invisible
  `NoPos` portal-filler quads (translucency 1) describe each opening exactly; the
  summary's top-level `openings` array is authoritative. Render meshes are full of
  T-junctions; physics polys ≠ render polys even on simple models (cottage 59 vs 53).
- **`0b94ecb9` relief-plan-apply** — deterministic plan→geometry generator + 18-check
  gate (port of the artist trial's selfcheck2.py). Ops v1: `plinth` (mitred, breaks at
  ground-touching openings), `opening_surround` (T-junction-safe splits, reveals),
  `belt_course` (follows battered planes). Reproduces the artist trial at exactly
  102 added tris, all checks green; `import:true` goes straight onto the retail id.
  Gate failures emit machine-readable `planErrors` for the artist repair loop.

**Proven end-to-end, twice**: patched portal dats at `/mnt/wbterminal2/dat-patch-opus/`
(Opus 5's hand-authored cottage, 90→192 tris) and `/mnt/wbterminal2/dat-patch-reliefgen/`
(generator-built, same plan). Both parse clean, physics preserved (59 polys), iteration
bumped. Also `/mnt/wbterminal2/dat-patch-smoke/` (first wedge proof).

## 2. HARD CONSTRAINTS (all decomp/da­ta-verified — do not relitigate)

- **BC3 (DXT5) is the texture-compression ceiling.** The DAT PixelFormat enum is the
  D3D9 set; BC7 does not exist there and cannot (D3D11 format). Encode Remacri PNGs to
  DXT1 (opaque) / DXT5 (alpha). Paletted textures stay INDEX16 via the t2quant lane —
  converting them to DXT kills dye/recolor.
- **2 GiB − 1 is the hard per-DAT ceiling** (bit 31 of block offsets is a flag; retail
  seeks with signed 32-bit SetFilePointer; oversized dats open and silently misread).
  portal.dat is 927 MB → **~1.1 GiB headroom**. Full receipts:
  `/mnt/wbterminal2/drw-int32-discord/DRW-INT32-DISCORD-FINDINGS.md`.
- **client_highres.dat is dead on vanilla ACE**: client mounts it only when the server's
  DDD interrogation has `ProductID & 4`; ACE hardcodes `ProductID = 1`. Everything goes
  into portal.dat in place. (Our EoR base set has no highres dat anyway.)
- **Per-texture dims**: DX9 compat cap 2048², pow2. Census of all 20,684 portal textures:
  content is 128²–512² (12,852 are 32² icons) → Remacri 4× lands ≤2048². The client
  builds a **full mip chain at load** (ImgTex::CreateD3DTexture), so single-level
  records are fine at any size.
- **Retail renders GfxObjs from the flat polygon list** (CGfxObj::InitLoad discards
  non-portal drawing-BSP nodes, D3DPolyRender::ConstructMesh reads the polygon dict) —
  appended triangles render without a valid drawing BSP. bsp-build exists anyway.
- **Retail lights per-vertex (Gouraud)** — added triangles also improve shading, not
  just silhouette. Flat appliqué is invisible; relief must break silhouette or angle
  faces away from the parent.
- **DRW 2.1.2 (the runtime NuGet) write bugs**: (a) the NegUVIndices Pack bug above;
  (b) 0xCDCDCDCD leaf-slot taint + contiguous-free-region assumption — WB.Terminal's
  export already runs `DatExportFixer` (in-repo pregrow/cdfix equivalent; it patched
  2,010 pre-existing leaves on first export). Bulk writes outside the export path must
  use `/mnt/wbterminal2/tranche2-proto/{pregrow,cdfix}.py`.

## 3. THE ARCHITECTURE (post-course-correction — operator-based, NOT category-based)

portal.dat holds **15,318 GfxObj records** — a long tail of random statics. Nothing
semantic scales. Operators routed by measurable mesh signals only:

| Operator | Fires on | Status |
|---|---|---|
| Edge/material-boundary rails (gfx_remodel OP1+OP3 = GEOMR) | convex edges, material seams — any mesh | proven live in holtburger (83/796 models changed on bounded region; the s12 A/B shots) — **needs the GEOMR→OBJ dump wire (§4.1)** |
| Boundary-clamped Phong tess (`organic_tess`) | regions with smooth shared vertex normals, doubleSided=false | prototyped on real records this session (`session-artifacts/phong_tess.py`, `trunk_phong_ab.png` good / `tree_phong_ab.png` = the billboard failure that mandates the guard); registry integration assessed in the 0b94ecb9 report — boundary-clamp keeps the append-only gate contract |
| Skip | doubleSided flat cards (billboards — foliage, whatever) | region-summary flag; canopy example: 104/104 regions doubleSided vs trunk part 0/16 |
| Texture up-res | everything | Remacri corpus done+approved (2,931 statics + 1,054 t1 + 1,138 t2-INDEX16 already injection-proven); DXT5 for alpha foliage |
| Artist relief plans (Opus 5) | landmark buildings only, optional premium | full loop proven this session |

**Artist verdict (Opus 5 trial)**: can author, but ~11% per-quad winding errors blind →
it emits declarative plans, the generator owns geometry. Its full scale assessment,
brief format, and per-model context wishlist are in the session transcript; the sample
it hand-built is `session-artifacts/cottage_0100082E_opus.obj` (+ `preview_opus.png`).
It independently recovered the cottage's box-projection UV system (u=x/3+off, v=-z/2.8)
to 3e-6 — likely the fix direction for holtburger's rail texture-mismatch too.

## 4. ORDERED TODO

1. **GEOMR→OBJ dump wire** — dump the bake's per-model variant triangles (byte-exact
   pinned by the native differ) to OBJs; batch through relief-plan-apply/obj-import over
   the bounded region's 83 models first, then the full catalog. This is the backbone.
2. **Pilot batch, Holtburg buildings** — summaries → Opus plans → gate → one patched dat
   + A/B preview strips. Measures the semantic-error rate.
3. **Texture lane bring-up** — Remacri → DXT1/5 encoder + budget planner (fit inside
   ~1.1 GiB headroom; 512² default cap, 1024² for hero surfaces; alpha-mip pre-bias for
   foliage — client-generated mips thin alpha-tested leaves at distance) + t2quant
   INDEX16 lane (tooling exists, `/mnt/wbterminal2/tranche2-proto/`).
4. **`organic_tess` op** in the registry (boundary-clamped, alpha 0.5, maxOffset gate).
5. **Batter-following plinth** (house 0x01002232's walls lean 5–7°; gate correctly
   refused — first real refusal diagnostic is `reliefgen` `house_checks.json`).
6. **Eyeball session** (1070/Windows, batched per house rules): retail client + ACE on
   the patched dats. Also check foliage alpha mip behavior there.
7. **Cavity bake (lane 3, later)**: owner reports prior version didn't affect non-sunlit
   areas — for DAT it must be lighting-neutral (fold into albedo unconditionally
   pre-encode).
8. **Bulk-patcher hardening**: carry original surface tables verbatim on overwrite
   (current import drops physics-only/unused surface slots — cottage 11→6), move off
   NuGet DRW 2.1.2 or keep DatExportFixer in every write path.

## 5. TRAPS (this session's tuition)

- `usemtl`-only surface carryover drops unreferenced surface slots on overwrite (§4.8).
- obj-export emits double-sided retail polys as two reversed passes; re-import makes
  them two single-sided polys (cottage "90 tris" = 53 stored). Counts differ; visuals don't.
- Region `outer` loops can be valid-but-self-touching circuits weaving through openings —
  never assume simple polygons; use the `openings` array.
- UV-space authoring is safe only where uvMap residual is tiny (architecture ~1e-6);
  organics hit ≥0.1 — gate refuses, don't override.
- Phong tess without the doubleSided guard destroys billboard geometry (see
  `session-artifacts/tree_phong_ab.png`).
- "street22m" in eyeshot filenames = "street-level, 22 metres" camera spec, not a file.
