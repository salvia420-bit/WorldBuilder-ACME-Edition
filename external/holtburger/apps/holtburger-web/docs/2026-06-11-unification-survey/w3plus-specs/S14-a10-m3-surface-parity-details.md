# S14 — A10-M3 surface parity details (M3a getter + M3b JS), on top of `?surfaceUnified`

Agent: S14 · Item: A10-M3 (M3a + M3b) · Date: 2026-06-11 · READ-ONLY spec, no code changed.

---

## 1. Read-HEAD + W2 assumptions

**Read HEAD:** `61bea82f` ("holtburger: W2/Batch-R2 buildbox dispatch manifest").

**Already-landed prerequisites verified at this HEAD (NOT assumptions):**
- A10-M1 + M2 (`?surfaceUnified`) landed at `619fc20f` with the flags=0 fixup at `7963f202`.
  The single decoder `applySurfaceRenderState` exists at materials.js:1052, the flag reader
  `readSurfaceUnifiedFlag` at materials.js:1152, and all three decode sites delegate to it
  (cache: materials.js:2141; entity-owned: materials.js:2827; paletted: entities.js:3511).
- url-flags.md:126 documents `surfaceUnified` (default-off, JS-live).

**In-flight W2 assumptions (this spec's exposure is merge-order only, not behavior):**
- None of A4-Q1 / A3-D2 / A2-P1 / A7-R1/R2/R3/R6 / A9-Stage1 touch materials.js,
  entities.js, or the `SurfacePixels` region of lib.rs. M3 has zero functional dependency
  on any W2 item.
- EXCEPTION (merge order, not behavior): lib.rs is the "hottest file" (ROADMAP §3, line 138)
  and A9-Stage1 (W2, in-flight) edits it. M3a is explicitly assigned to **Batch R4**
  ("small bridge getters/exports: A10-M3a `hasPalette` …", ROADMAP §5 line 174) — M3a must
  rebase/queue behind whatever W2 lands in lib.rs. Line numbers cited below for lib.rs were
  read at `61bea82f` and may drift a few lines by implementation time; all anchors are
  symbol names, so re-grep before editing.

---

## 2. Current-state map (post-W0/W1)

A10-M1/M2 collapsed the three Surface(0x08) flag→material decode sites into one exported
function, gated by `?surfaceUnified` (default-off):

| piece | where (ours) |
|---|---|
| Single decoder `applySurfaceRenderState(mat, state, opts)` | materials.js:1052–1117 |
| Float-driven lum/diffuse half `applyFloatLumDiffuse` | materials.js:1126–1146 |
| Flag reader `readSurfaceUnifiedFlag()` | materials.js:1152–1163 |
| Cache path delegate (inside `_materialFromFlags`) | materials.js:2048 (gate), 2141–2145 (call) |
| Cache path legacy inline ladder (flag OFF) | materials.js:2050–2114 (`opts.alphaTest = 0.5` at 2094) |
| Entity-owned (F.41 recolour) delegate | materials.js:2827–2838 (in `_buildEntityOwnedFromPixels`, 2748) |
| Paletted/dyed delegate | entities.js:3493 (`_applyPalettedSurfaceRenderState`), gate+call 3511–3518 |
| Paletted legacy inline ladder (flag OFF) | entities.js:3520–3596 (`mat.alphaTest = 0.5` at 3567) |
| `SurfacePixels` wasm struct + getters | lib.rs:6601–6672 (struct), 6664–6726 (getters) |
| `SurfacePixels` constructors (all literal sites) | lib.rs:6781, 6823, 6883 (plain); 7917, 8010 (dye preview); 8217, 8247, 8320 (entity palette-overrides) |
| Texture palette knowledge | crates/holtburger-dat/src/file_type/texture.rs:96 (`default_palette_id`), :105 (`format()`), :76 (`needs_palette()` ⇔ P8/Index16) |
| OFF-vs-ON parity proof | test_f7_8_surface_bitfield.mjs (Stage-4b legacy-cache == unified-cache 70/70 matrix; window stub at line 449) |

The three remaining **in-scope divergences** (A10 report §3 rows 4, 5, 6) — all currently
identical under `?surfaceUnified` on AND off:

**Row 4 — ClipMap alpha-test ref.** Retail: `testRef = s_256AlphaTestRef(100)` only when a
texture is set AND `curr_texture->m_pPalette` is non-null, else `s_ddsAlphaTestRef(200)`
(acclient.c:454506–454509; constants acclient.c:45764–45765; `m_pPalette` field
acclient.h:31982), compared `ALPHATESTFUNC_GREATEREQUAL` (acclient.c:454546). Ours hardcodes
`alphaTest = 0.5` everywhere: unified decoder materials.js:1113, legacy cache ladder
materials.js:2094, legacy paletted ladder entities.js:3567. Our JS has no way to know
whether the source texture was paletted — `SurfacePixels` (lib.rs:6601) carries no such
field. That is the M3a getter.

**Row 5 — additive surfaces exempt from fog.** Retail: when fog is globally off OR the
surface has `ADDITIVE 0x10000`, `SetFFFogAlphaDisabled(1)` (acclient.c:454551–454553).
The body of `RenderDeviceD3D::SetFFFogAlphaDisabled` (acclient.c:460295–460302) writes
device vtable slot 57 (= `IDirect3DDevice9::SetRenderState`; IDA renders it
`vfptr[19].QueryInterface`, 19×3 slots) with render state **28 = D3DRS_FOGENABLE** and value
`(_bValue == 0)` — i.e. "FogAlphaDisabled(1)" **turns fixed-function fog fully OFF for that
draw**. This resolves the A10 §6 open question: it is fog-SKIP, not fog-to-black, so the
three.js per-material `fog: false` is the exact analogue. Ours: neither the unified decoder
(materials.js:1085–1101, the two additive branches) nor any legacy ladder sets a `fog` key;
three.js `MeshStandardMaterial.fog` defaults to `true`.

**Row 6 — true INVALPHA blend.** Retail: `INVALPHA 0x200` (BYTE1 & 2) → src=INVSRCALPHA(6),
dst = ONE(2) if ADDITIVE else SRCALPHA(5) (acclient.c:454478–454484; BlendMode enum
acclient.h:5193–5204). Ours routes InvAlpha through the standard SRCALPHA/INVSRCALPHA branch
(unified: materials.js:1102–1111 `isTranslucent || isAlpha || isInvAlpha`; legacy mirrors at
materials.js:2079 and entities.js:3545). Census-zero in the retail base DAT (A10 §3 row 6 /
unsurfaced-render-audit 2026-06-09) — "do only if free".

**Branch-order parity already correct (no work):** retail checks ALPHA (acclient.c:454470)
before INVALPHA (454478); ClipMap+Translucent together ends with alpha-test OFF and
SRCALPHA/INVSRCALPHA blending (the Translucent branch resets `singlePassDetailinga = 0`
when the ClipMap branch had set it 1, acclient.c:454513–454522) ↔ our else-if chain tests
`isTranslucent || isAlpha || isInvAlpha` before `isClipMap` (materials.js:1102, 1112), so
ClipMap+Translucent takes the blend branch with no alphaTest. Same outcome.

---

## 3. Staged implementation plan

Target: a new default-off flag **`surfaceParityV2`** whose branches live ONLY inside the
unified decoder. The decoder is only ever invoked when `?surfaceUnified=on`
(materials.js:2048/2141, 2827, entities.js:3511), so **`surfaceParityV2` is inert unless
`surfaceUnified` is also on** — document this dependency in url-flags.md; do NOT add
cross-flag enforcement logic (no judgment call: the three legacy ladders are never touched
by M3).

Ship order: **M3b first** (JS-live; the alphaTest half fail-softs to legacy 0.5 until the
getter exists), **M3a second** (wasm-rebuild, Batch R4). This decouples the JS work from the
W2-congested lib.rs.

### Stage M3b — JS half (JS-live, no rebuild, no manifest bump)

Files: `apps/holtburger-web/scene3d/materials.js`, `apps/holtburger-web/scene3d/entities.js`,
`apps/holtburger-web/docs/url-flags.md`, `apps/holtburger-web/test_f7_8_surface_bitfield.mjs`.

1. **`readSurfaceParityV2Flag()`** — new export in materials.js, byte-for-byte the
   `readSurfaceUnifiedFlag` pattern (materials.js:1152–1163): param `surfaceParityV2`,
   accepted values `on|1|true` case-insensitive, try/catch'd `window.location` read,
   NOT cached (the existing test harness re-stubs `globalThis.window` per case,
   test_f7_8_surface_bitfield.mjs:449). Export it next to `readSurfaceUnifiedFlag` and add
   it to the entities.js import list (entities.js:373–374) only if entities.js ends up
   needing it (it should not — see (5)).

2. **(b1) Fog exemption for additive** — in `applySurfaceRenderState`, in BOTH additive
   branches (Alpha+Additive, materials.js:1085–1094; pure-Additive, materials.js:1095–1100):
   ```js
   if (parityV2) mat.fog = false;
   ```
   where `const parityV2 = readSurfaceParityV2Flag();` is read once at the top of the
   function. Retail truth: acclient.c:454551–454553 (ADDITIVE → FFFogAlphaDisabled(1)) +
   acclient.c:460295–460302 (body = SetRenderState(28 = D3DRS_FOGENABLE, !value) → fog OFF
   for the draw). `material.fog = false` is a shader-program-affecting property; the
   function's existing trailing `mat.needsUpdate = true` (materials.js:1116) already forces
   the recompile — keep the fog write ABOVE that line. Note in the code comment the known
   residual: `material.fog` only exempts from `scene.fog`, which exists on the wireframe
   path (FogExp2, index.js:585) and the `?fogLerp=on` path (linear THREE.Fog,
   index.js:2962); the default 3D path's Bruneton aerial-perspective post pass
   (index.js:2976; atmosphere_pipeline.js) is screen-space and cannot honour a per-material
   exemption (see §5 risks / §6 OQ-2). Do not touch the retail "fog globally off" half of
   the condition (acclient.c:454551 `!GetFFFogEnable`) — with no scene.fog three.js applies
   no fog anyway; it is vacuously parity.

3. **(b2) ClipMap alpha-test ref 100/200** — in the `isClipMap` branch
   (materials.js:1112–1115), replace the hardcoded `mat.alphaTest = 0.5` with:
   ```js
   mat.alphaTest =
     parityV2 && typeof state.hasPalette === "boolean"
       ? (state.hasPalette ? 100 / 255 : 200 / 255)
       : 0.5;
   ```
   Retail truth: acclient.c:454499–454511 (ClipMap branch sets
   `testRef = m_pPalette ? 100 : 200`, with no-texture also → 200 via
   `!Render::curr_texture_is_set`, acclient.c:454506; constants acclient.c:45764–45765) and
   acclient.c:454546 (`ALPHATESTFUNC_GREATEREQUAL`). Mapping is exact: retail keeps
   `a*255 >= ref`; three.js keeps `a >= alphaTest` (discards `a < alphaTest`), so
   `alphaTest = ref/255` preserves the >=-with-equality boundary. 100/255 ≈ 0.392 (paletted),
   200/255 ≈ 0.784 (DDS / solid / no-texture).
   **Fail-soft rule (load-bearing, no judgment call):** `state.hasPalette` strictly
   `boolean`; `undefined` (stale pkg without the M3a getter, or an unmigrated caller) keeps
   legacy 0.5 — flipping `surfaceParityV2` on a stale pkg must not silently change foliage
   to the wrong 0.784-everywhere.

4. **(b3) True INVALPHA blend** — restructure the third branch (materials.js:1102–1111).
   Current condition `isTranslucent || isAlpha || isInvAlpha`. Under parityV2, InvAlpha
   WITHOUT Alpha and WITHOUT Translucent gets its own arm (retail checks ALPHA first,
   acclient.c:454470, so Alpha wins when both bits are set; Translucent (0x10) is evaluated
   AFTER the A/IA ladder at acclient.c:454513 and would not override an already-blending
   surface — `!v11` is false — so keeping our existing precedence for
   Translucent+InvAlpha is parity):
   ```js
   } else if (parityV2 && isInvAlpha && !isAlpha && !isTranslucent) {
     // retail acclient.c:454478-454484: src=INVSRCALPHA(6),
     // dst = ADDITIVE? ONE(2) : SRCALPHA(5)
     mat.blending = THREE.CustomBlending;
     mat.blendSrc = THREE.OneMinusSrcAlphaFactor;
     mat.blendDst = isAdditive ? THREE.OneFactor : THREE.SrcAlphaFactor;
     mat.blendEquation = THREE.AddEquation;
     mat.transparent = true;
     mat.depthWrite = false;
   } else if (isTranslucent || isAlpha || isInvAlpha) { …unchanged… }
   ```
   Branch placement: AFTER the two additive branches is WRONG for InvAlpha+Additive (the
   pure-additive branch at materials.js:1095 would swallow it: `isAdditive` true, `isAlpha`
   false). Retail evaluates INVALPHA before the pure-ADDITIVE fallthrough
   (acclient.c:454478 before 454486–454489), so the new arm must be inserted BEFORE the
   `} else if (isAdditive) {` arm, and the pure-additive arm condition stays as-is (it is
   then only reachable for Additive without Alpha/InvAlpha — matching retail
   acclient.c:454486–454489). Census-zero in the base DAT, so this re-ordering changes
   nothing observable today; it exists so the decoder is the complete SetSurface ladder.

5. **Thread `hasPalette` through the five snapshot sites** (all read it fail-soft,
   `typeof sp.hasPalette === "boolean" ? sp.hasPalette : undefined`, mirroring the
   existing missing-getter idiom at materials.js:2337/2893):
   - cache `get()` path: add to the `surfaceFloats` snapshot (materials.js:2371–2375) and
     pass through `_materialFromFlags`'s unified-decoder call as `state.hasPalette`
     (materials.js:2141–2145). `_materialFromFlags` itself needs only to forward
     `surfaceFloats?.hasPalette` — no signature change (it already receives
     `surfaceFloats`, materials.js:1960).
   - `_installFromPixels`: snapshot block materials.js:2888–2907 + `surfaceFloats` literal
     materials.js:2924–2928.
   - `_buildEntityOwnedFromPixels`: snapshot block materials.js:2761–2773 (before
     `sp.free()`) + the decoder call's `state` literal materials.js:2829–2836.
   - entities.js spawn paletted path: `palSurfaceState` literal entities.js:2686–2692.
   - entities.js hot-swap paletted path: `palSurfaceState` literal entities.js:6815–6820.
     `_applyPalettedSurfaceRenderState` forwards it inside its delegate call
     (entities.js:3512–3516) as `hasPalette: state.hasPalette` — note its state object uses
     key `surfaceType`, not `flags` (entities.js:3495); keep that asymmetry, only add the
     new key.
   The three legacy ladders (materials.js:2050–2114, entities.js:3520–3596, and the
   entity-owned plain-opaque construction materials.js:2786–2798) are NOT touched.

6. **url-flags.md** — new row `surfaceParityV2` (default **off**): states (a) requires
   `?surfaceUnified=on` to have any effect; (b) the three sub-behaviours (clipmap ref
   100/255 vs 200/255, additive `fog:false`, true InvAlpha blend); (c) alphaTest half is
   inert until the M3a wasm getter ships (stale-pkg graceful fallback to 0.5); (d) JS-live;
   (e) 1070-gated eye-tests (foliage fringe, foggy-night flame). Cite A10 §3 rows 4–6.

Classification: **JS-live** (reload to toggle). No wasm rebuild, no manifest bump.

### Stage M3a — Rust getter half (wasm-rebuild, **Batch R4**)

Files: `apps/holtburger-web/src/lib.rs` only (the holtburger-dat crate already exposes
everything needed: `Texture::format()` texture.rs:105, `SurfacePixelFormat::needs_palette()`
texture.rs:76 ⇔ P8/Index16, the same condition that gates the parsed `default_palette_id`
field, texture.rs:95–96).

1. Add field to `SurfacePixels` (lib.rs:6601):
   ```rust
   /// A10-M3a — whether the source Texture is palette-indexed (P8/Index16).
   /// Retail analogue: ImgTex::m_pPalette non-null (acclient.h:31982), the
   /// discriminator for the ClipMap alpha-test ref 100-vs-200
   /// (acclient.c:454506-454509). false for solid 1x1 surfaces (retail:
   /// no texture -> curr_texture_is_set false -> ddsRef 200) and for the
   /// empty fallback.
   has_palette: bool,
   ```
2. Getter in the wasm `impl SurfacePixels` block (lib.rs:6664):
   ```rust
   #[wasm_bindgen(getter, js_name = hasPalette)]
   pub fn has_palette(&self) -> bool { self.has_palette }
   ```
3. Set at ALL EIGHT struct literals (compiler-enforced; symbols, current lines):
   - `fetch_surface_pixels_impl`: `empty` lib.rs:6781 → `false`; solid 1×1 lib.rs:6823 →
     `false`; textured lib.rs:6883 → `tex.format().needs_palette()`.
   - `fetch_dye_preview_pixels`: `empty` lib.rs:7917 → `false`; textured lib.rs:8010 →
     `tex.format().needs_palette()`.
   - `fetch_entity_surface_pixels_impl`: `empty` lib.rs:8217 → `false`; solid lib.rs:8247 →
     `false`; textured lib.rs:8320 → `tex.format().needs_palette()`.
   Rationale for solid=false: retail reaches the ref pick with
   `Render::curr_texture_is_set = (GetTextureMap != 0)` (acclient.c:454411) and
   `!curr_texture_is_set` short-circuits to the 200 ref (acclient.c:454506–454507).
4. Native unit test (see §4) — the struct/impl is `cfg(any(target_arch="wasm32", test))`
   (lib.rs:6600/6770), so the field is visible to the native test target; the existing
   synthetic-source test modules (`tests_substitution` lib.rs:40878,
   `tests_entity_surfaces_pixels_batch` lib.rs:43495) show the harness pattern.

Classification: **wasm-rebuild**, batched per ROADMAP §5 line 174 (Batch R4, alongside
A11-S4 degradeDistance / A5-P3 metadata / A9-Stage1 placement-id etc.). **Manifest-bump
note:** NOT required — additive, non-load-bearing getter with a graceful JS fallback
(`undefined` → legacy 0.5), the exact precedent of the `fullPlacementQuat` getters
(url-flags.md:166: "new getters; non-load-bearing so no manifest bump — graceful
fallback"). NO builds are to be run by this spec's author; Batch R4's owner runs the
rebuild after the W2 wave releases `target/`.

Flag names summary: `surfaceParityV2` (new, default-off, JS) layered on `surfaceUnified`
(existing, default-off). No Rust-side flag — `has_palette` is unconditional data.

---

## 4. Test plan

### Headless-now (buildbox, no wasm rebuild, no GPU)

Extend `test_f7_8_surface_bitfield.mjs` (harness already stubs
`globalThis.window = { location: { search } }` per case, line 449, and locates a real
`three` build, lines 56–80). New section "Stage-6 A10-M3b":

1. **Flag reader:** `?surfaceParityV2=on` → true; absent/other → false; combined
   `?surfaceUnified=on&surfaceParityV2=on` parses both.
2. **Regression lens (load-bearing):** with `surfaceUnified=on` and `surfaceParityV2` OFF,
   re-run the FULL existing 70-combo flag×float matrix — every material prop byte-identical
   to the current Stage-4b goldens (proves M3b is invisible when its flag is off, including
   the branch-reorder in (b3): InvAlpha-only and InvAlpha+Additive combos must still take
   their legacy arms).
3. **(b2) alphaTest:** both flags on, ClipMap bit set: `state.hasPalette === true` →
   `alphaTest ≈ 100/255`; `false` → `≈ 200/255`; `undefined` (stale-pkg simulation) → `0.5`.
   ClipMap+Translucent → blend branch, alphaTest stays 0 (parity with
   acclient.c:454513–454522).
4. **(b1) fog:** both flags on: Additive-only and Alpha+Additive → `mat.fog === false`;
   every non-additive combo → `mat.fog === true` (three default); parityV2 off → always
   `true`.
5. **(b3) InvAlpha:** both flags on: InvAlpha-only → CustomBlending with
   `OneMinusSrcAlphaFactor`/`SrcAlphaFactor`; InvAlpha+Additive → dst `OneFactor`;
   Alpha+InvAlpha → Alpha precedence (the plain alpha-blend branch, NOT custom inverse);
   Translucent+InvAlpha → plain alpha-blend branch.
6. **Three-path prop-equality:** for a representative {ClipMap+hasPalette:false,
   Additive, InvAlpha} set, the cache path (`_materialFromFlags`), the paletted delegate
   (`_applyPalettedSurfaceRenderState`), and the entity-owned path
   (`_buildEntityOwnedFromPixels`, stub `sp` object with `free()`) emit identical
   {alphaTest, fog, blending, blendSrc, blendDst, transparent, depthWrite}.
7. **Idempotency / clone-re-apply (A10 §5 seam):** run `applySurfaceRenderState` twice on
   the same material and once on a `mat.clone()` — same props (the hook-ramp
   clone-on-write strip re-applies the decoder to cloned materials).

Runner: `THREE_PATH=… node test_f7_8_surface_bitfield.mjs` — pure JS, runs today.

### Rust-native (Batch R4 owner runs; NOT now — W2 owns target/)

`cargo test -p holtburger-web` new module `tests_a10_m3a_has_palette`: synthetic source with
(a) a P8 texture + palette → `has_palette == true`; (b) a non-paletted (e.g. RGB/DXT-class)
texture → `false`; (c) a solid-color surface → `false`; (d) missing DID (empty fallback) →
`false`. Pattern: `tests_substitution` (lib.rs:40878) already fabricates
Surface→SurfaceTexture→Texture chains.

### 1070-gated (parked, per ROADMAP §4 Lane B "A10 dyed-luminous/fog/foliage")

- Foliage/fence cutout fringe A/B: `?surfaceUnified=on&surfaceParityV2=on` vs off — DDS
  clipmaps should cut noticeably tighter (0.784 vs 0.5), paletted slightly looser (0.392).
- Foggy-night flame/spell-glow under `?fogLerp=on&surfaceUnified=on&surfaceParityV2=on`:
  distant additive surfaces no longer haze toward fog color (scene.fog path).
- Default (Bruneton) path: same scene — record whether the aerial-perspective residual
  (§6 OQ-2) is visible; verdict feeds the default-on decision.

---

## 5. Risks + rollback

- **Rollback:** drop `surfaceParityV2` from the URL (JS-live, reload). One flag guards all
  three behaviours. M3a's getter is dead data when the flag is off — no Rust rollback
  needed. The legacy ladders and the parityV2-off unified decoder are untouched
  (regression-lens test §4.2 enforces byte-identity).
- **Stale-pkg skew:** JS with M3b + old wasm without `hasPalette` → alphaTest half inert
  (0.5), fog/InvAlpha halves active. Acceptable and documented; no manifest bump needed.
- **Visual delta is the point:** 200/255 on DDS clipmaps will visibly thin foliage edges —
  that IS retail parity; it's why the flag stays default-off until the 1070 eye-test.
- **Shadow interaction:** three.js copies `material.alphaTest` (+map) into the shadow depth
  material when alphaTest > 0, and our shadow gate `materialCanCastShadow`
  (materials.js:93–103) already lets ClipMap surfaces cast — shadow cutouts shift fringe
  width consistently with the visual change. No code work; eye-test covers it.
- **`mat.fog` recompile:** program-affecting; covered by the existing
  `mat.needsUpdate = true` at materials.js:1116. Keep all parityV2 writes above it.
- **Aerial-perspective residual:** on the default 3D path additive surfaces remain inside
  the screen-space aerial perspective (index.js:2976) — M3b only fixes the scene.fog paths.
  Documented limitation, not a regression (today NEITHER path exempts them).
- **Branch-reorder hazard (b3):** the new InvAlpha arm must sit before the pure-`isAdditive`
  arm or InvAlpha+Additive is mis-routed; the §4.5 combos pin this.
- **Merge order:** M3a queues in Batch R4 behind W2's lib.rs traffic; lib.rs line anchors
  re-greppable by symbol (`struct SurfacePixels`, `fetch_surface_pixels_impl`,
  `fetch_dye_preview_pixels`, `fetch_entity_surface_pixels_impl`).

---

## 6. OPEN QUESTIONS

1. **ClipMap blend-enable (out of M3 scope — needs a ruling whether to add as M3c/M5).**
   Retail's ClipMap branch ALSO turns blending ON (ONE/INVSRCALPHA when not already
   blending: acclient.c:454501–454505 `v9=2; v10=6`, plus `surfacea = 1` at 454510), i.e.
   retail clipmaps are alpha-tested AND alpha-blended; ours keeps `transparent = false`
   (materials.js:1113–1114). The A10 report row 4 scoped only the ref values into M3.
   Dual-citable divergence, but enabling `transparent` on foliage would move it into
   three.js' sorted transparent pass — perf + sort-order consequences exceed "parity
   details". Recommend: separate item, not silently folded into `surfaceParityV2`.
2. **Aerial-perspective fog exemption** (default 3D path): is the additive-haze residual
   visible enough to justify per-material aerial-perspective masking (stencil or
   material-flag buffer)? No retail analogue exists for a post-pass fog — needs the 1070
   A/B verdict before any design.
3. **`overrideClipmap` call-site values:** SetSurface's 4th param forces the ALPHA blend
   path and skips the ClipMap branch (acclient.c:454470, 454499). The mesh-subset draw call
   at acclient.c:454676 passes the stipple mask; I did not locate a call site passing
   `overrideClipmap = true`, so whether any retail content path needs a JS analogue is
   unverified.
4. **`skipChk` global** in the Translucent branch (acclient.c:454515) — semantics and
   setter untraced; if it is ever true, retail forces Translucent surfaces into
   SRCALPHA/INVSRCALPHA even when already blending. Our decoder has no analogue.
5. **Stippled screen-door rendering** — carried from A10 §6 unchanged: beyond the wrap-mode
   switch (acclient.c:454437, parity at materials.js:2110–2113/2835-area), no additional
   stipple pattern was located in acclient.c.
6. **Alpha-test ref staleness in retail:** `testRef` is a global (acclient.c:45773,
   init 20) written only in the ClipMap branch but fed to `SetAlphaTestRef` on every
   SetSurface (acclient.c:454545) — harmless in retail because `SetAlphaTestEnable` is
   false for non-clipmap surfaces (acclient.c:454544), and harmless for us (we set
   alphaTest only in the ClipMap branch). Recorded so nobody "fixes" it.
