# Visual-fidelity push — hand-off to PK (2026-05-13)

**Audience:** PK on live-ACE box (Tailscale `100.116.47.66`, Developer account, phone for mobile perf).

**State:** 12 of 14 phases shipped to `origin/master`. The renderer compiles and ships clean (cargo 1352/0/1, all Node tests green). What remains is **on-hardware visual validation, perf measurement, and Phase 2.3 (hand-authored hero PBR maps)** which an agent cannot do.

This doc consolidates everything you need to: (a) deploy, (b) eye-test the cumulative result, (c) measure FPS, (d) pick up the open follow-ons.

---

## 1. What shipped

| Phase | What it does | Status | Visible win |
|---|---|---|---|
| **X.1** Quality presets | `?quality=low\|mid\|high\|ultra` URL gate + mobile UA downgrade | ✅ Mechanically validated | Infra — no visual change |
| **X.2** Visual regression infra | `scripts/visual-regression/{views.json,capture-all.cjs,diff-vs-golden.cjs}` | ✅ Infra + 2 sample goldens at quality=low | Infra — for future goldens |
| **0.1** Shadow maps | Sun directional `castShadow`, ortho frustum recentred per-frame, `?shadows=on/off` | ✅ Wired | **Building shadows on terrain — needs your eye-test** (terrain shader is a no-op for `receiveShadow`; see §5) |
| **0.2** Detail flag | `DetailMaterial` via `onBeforeCompile`; 5 grayscale tiles | ✅ Wired; **retail data never sets the bit** | Validate via `?forceDetail=on` URL |
| **1.1** Procedural normals | Sobel-luminance → normal map per surface at decode time | ✅ Wired; ~85/89 Holtburg surfaces get real gradient | **Per-pixel bump shading on buildings — needs your eye-test under moving sun** |
| **1.2** Terrain detail normal | Tiled normal maps per terrain category, RNM blend | ✅ Wired | **Per-pixel grass/dirt/stone/snow detail at player feet** |
| **1.3** Triplanar mapping | Slope-gated triplanar (smoothstep 0.2-0.5) on detail layer | ✅ Wired; **only 33% blend on Holtburg's mildest slope** | Goes visible in Yanshi/Arwic/AC (steeper terrain) |
| **1.4** Surface classifier | 13-cat heuristic (Stone/Wood/Metal/Sand/Lava/etc) | ✅ 82% acc on 50-surface audit | Drives roughness/metalness — visible as PBR fidelity |
| **1.5** Override JSON | 10 per-DID overrides (5 from 1.4 misclassifications + 5 own) | ✅ Wired; `worldbuilder-terminal surface --dump`/`--hero-survey` CLIs | Infra — accumulate more overrides as needed |
| **2.1** Terrain subdivision | Catmull-Rom + clamped value-noise, LOD ramp (centre full, outer half) | ✅ Wired; **road z-fight cosmetic bug at subdiv=4 partially fixed in 2.2 (lift 0.1→0.4m)** | **Smooth hillsides at subdiv=4 — needs eye-test at oblique angle (not top-down)** |
| **2.2** Animated water/lava | World-frame XY wavelets for water; lava branch present but unused | ✅ Wired; **Holtburg has zero water terrain — validated on synthetic codes only** | Goes visible in Yaraq/Direlands water LBs |
| **3.1** POM (parallax) | Heightmap-derived ray-march for category=Stone | ✅ Wired; gate `quality=high + category∈{Stone,Brick,Tile} + dist<10m` | **Only 2 Stone surfaces in Holtburg — needs Asheron's Castle or `?forcePom=on` to see** |
| **3.2** SSAO | EffectComposer + SSAOPass, AC-scale tuning (radius=3m, kernel=16) | ✅ Wired; **color-management gotcha makes SSAO-on slightly brighter overall** | Building corner darkening — visible but subtle |
| **3.3** CSM | Hand-rolled 3-cascade (30m/100m/300m), "one sun + three shadow-only" pattern | ✅ Wired; **terrain shadow inherits 0.1 limitation (custom GLSL3 shader doesn't sample shadow map)** | Crisp distant shadows on buildings at quality=high |

⏳ **Not shipped: Phase 2.3** (50 hand-authored hero PBR maps). See §7 — this needs you with art tools.

---

## 2. Deploy

Master is at `origin/master` HEAD. Last commit: `ede4122`. Fresh `wasm-pack` build sits in `external/holtburger/apps/holtburger-web/pkg/` (committed via JS imports; the .wasm bytes need a rebuild on your side).

### Steps

```bash
# On live-ACE box
ssh tailnet1@100.116.47.66
cd /path/to/holtburger
git pull origin master

# Rebuild wasm
export CARGO_TARGET_DIR=/mnt/wbterminal1/build-caches/visual-fidelity/cargo-target  # or your equivalent
cd apps/holtburger-web
wasm-pack build --target web --dev   # or --release for prod perf testing

# Restart whatever serves the live-ACE bundle
# (existing deploy steps for the manifest/shards at /mnt/wbterminal1/holtburger-dist-v2 still apply)
```

### Verify the deploy

Load `http://100.116.47.66:<port>/apps/holtburger-web/index.html?renderer=3d&quality=high` in a desktop browser. Check `window.__quality` in devtools — should show `{ preset: 'high', flags: { shadows: true, csm: true, ssao: true, pom: true, terrainDetailNormal: true, triplanar: true, subdivLevel: 4, ... } }`.

---

## 3. Eye-test plan — what to look for

**Quality preset matrix.** Visit each:

### `?quality=low`
- All visual-fidelity features OFF
- Should look identical to the wave-0 baseline (pre-shadows, pre-normals)
- **Confirm:** no shadows, no per-pixel bump, no terrain detail normal, no triplanar, no subdivision (subdivLevel=1), no SSAO, no CSM, no POM
- **FPS baseline:** measure this on phone — sets the headroom for everything else

### `?quality=mid`
- Shadows on (single map, not CSM)
- Procedural normals on
- Terrain detail normal on
- Triplanar on
- Subdivision level 2 (17×17 per LB)
- POM off, SSAO off, CSM off
- **Compare to low:** building walls should show per-pixel detail under moving sun
- **FPS on phone:** target ≥40 fps in Holtburg

### `?quality=high`
- All wave-1+2+3 + CSM + SSAO + POM
- Subdivision level 4 (33×33 per LB)
- **Compare to mid:** crisp distant shadows (CSM), AO at building corners, recessed bricks on Stone walls (POM)
- **FPS on phone:** target ≥30 fps in Holtburg

### `?quality=ultra`
- All `high` features + subdivision level 8 (65×65 per LB)
- Desktop-only; don't bother on phone
- **FPS on desktop:** target ≥55 fps

### Camera framing matters

The headless captures I produced were top-down on Holtburg's hilltop. From that angle:
- Building shadows fall behind buildings → **invisible**
- Hilltop ridge is too flat → subdivision smoothing **invisible**
- No oblique view of cliff face → triplanar contribution **invisible**

**You need to walk around at player eye height** to see most of these. The acceptance criteria in the plan doc reference views like "Academy hilltop looking south at Holtburg" — those need a Developer account and free camera, not a mockSession capture.

### Honest known gaps (visible)

1. **`subdiv=4` road overlay z-fight** — bright blue/white lines through the cliff face. Phase 2.2 raised lift from 0.1m to 0.4m which clears the wave displacement budget; subdivision noise can still poke through where it overshoots. Cosmetic only. Real fix: route road overlay through subdivided heights. (See `docs/visual-fidelity-eval-2026-05-13/holtburg_hillside_subdiv_4.png`.)
2. **SSAO at quality=high makes the scene slightly brighter overall** by ~30 levels on dark mid-tones (water especially). The SSAO mask itself is correct (darkening at corners) — issue is linear/sRGB book-keeping mismatch between direct render path and EffectComposer. See §5.
3. **Terrain doesn't receive shadows** (any quality). Terrain shader is a custom GLSL3 ShaderMaterial that doesn't sample three.js's shadow map. Building shadows on terrain would require extending `TERRAIN_FRAGMENT_GLSL` with `THREE.UniformsLib.shadowmap` + standard chunks, or migrating to `MeshStandardMaterial.onBeforeCompile`. Multi-day rework. See §5.

---

## 4. Perf measurement

Run on **your phone** and a desktop with a real GPU. Capture FPS at each preset.

### Phone (target hardware: anything ≥2022)

For each preset in `low|mid|high`, walk around Holtburg town centre for ~30 seconds. Note:
- Average FPS
- Worst-case FPS during walking (turning camera, transitioning into a building)
- Battery drain rate if you can measure

### Desktop

Same drill on `low|mid|high|ultra`. Plus:
- Profiler timeline showing fragment vs vertex shader cost
- Triangle count + draw call count at each preset

### Files to drop output in

Save FPS reports as `/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/perf-pk-<date>/` with whatever format you prefer. Then update `docs/visual-fidelity-perf-pk-<date>.md` with the numbers.

### Hard-rule reminders

- **Never run `quality=ultra` + the full Dereth bake on a phone.** That's the OOM case.
- The plan's §7 hard rule applies: heavy perf measurement = live-ACE box, not laptop.

---

## 5. Open follow-ons (concrete bugs / refinements)

Listed in roughly priority order. Each is a small focused PR.

### High-priority

1. **Terrain shadow shader rework** — terrain.js is custom GLSL3; doesn't sample shadow maps. Building shadows cast onto terrain currently render as no-op. Fix options:
   - Add `THREE.UniformsLib.shadowmap` + the standard chunks (`<shadowmap_pars_fragment>`, `<shadowmap_fragment>`) to `TERRAIN_FRAGMENT_GLSL`
   - OR migrate terrain to `MeshStandardMaterial.onBeforeCompile`
   - Either way: terrain.js currently composes detail-normal + triplanar + subdivision uniforms; you'd be extending that.
   - Effort: 1-2 days.

2. **SSAO color-management** — linear-space `MeshStandardMaterial` lighting + OutputPass linear→sRGB encode aren't synchronised across the direct + composer paths. SSAO-on makes scene ~30 levels brighter on dark mid-tones. Fix: walk `renderer.outputColorSpace` + `toneMapping` through both paths. Effort: 1 day with eye-tests.

3. **Road overlay through subdivided heights** — currently the road walks the 9×9 control grid at +0.4m lift. Subdivided terrain can still overshoot. Route the road's per-segment elevation through the subdivided mesh height at each road sample point. Effort: 2-3 days (touches both Rust subdivision + JS road builder).

### Medium-priority

4. **CSM attenuates `gl_FragColor.rgb` directly** with a 0.45 floor, rather than only the sun term. Refinement: move the multiplier inside `<lights_fragment_end>` to attenuate ONLY the sun's contribution — ambient + per-SetupModel point lights don't double-darken in shadow. Effort: 1-2 days.

5. **POM tangent-space sun direction** — current self-shadowing uses negated tangent view direction as sun proxy. Proper fix: pass the sun direction as a tangent-space varying (or compute it in the fragment via TBN matrix). Effort: 1 day.

6. **Adjacent-LB-loaded wiring through wasm** — Phase 2.1's `subdivide_landblock` accepts adjacent-LB heights for proper bicubic continuity, but the wasm export always passes mirror. Wiring this fixes the visible seam at the loaded-ring edge. Effort: 1-2 days.

### Low-priority / nice-to-have

7. **`shadowsEnabled` URL param collapse** — Phase 0.1's `?shadows=on/off` is independent of the Phase X.1 quality preset. Collapse into `quality.flags.shadows`. Effort: 30 mins.

8. **Phase 1.4 classifier accuracy boost** — currently 82%; the 5-DID seed list in `surface_overrides.json` covers the wave-1 audit miscategorizations. Audit another 50 surfaces from across Dereth (not just Holtburg), expand the override JSON. Effort: 2-4 hours per audit batch.

9. **Phase X.2 visual regression — bake real goldens.** The infra ships with 2 sample goldens at quality=low. Once the live-ACE deploy is up, bake the full 40-shot suite (10 views × 4 quality presets) at high settings. Then wire `npm run visual-regression` as a release gate. Effort: 1 day initial + ongoing maintenance.

### Infrastructure

10. **`.github/workflows/visual-regression.yml`** — Claude Code's OAuth token can't push workflow files. Template lives at `external/holtburger/scripts/visual-regression/ci-workflow.example.yml`. You copy + commit + push from a desktop with `workflow` scope. Effort: 5 mins once you're at desktop.

---

## 6. Phase 2.3 — Hand-authored hero PBR maps (the remaining phase)

The plan calls for **50 hand-authored PBR maps** (normal, roughness, optional AO, optional emissive) for the top-50 most-referenced surfaces in Holtburg + Academy + the noob path. This needs **Substance Painter, Blender, or hand-painted** — agent tooling can't produce hand-quality maps.

### Batch workflow

1. Run hero-survey CLI to get the top-50: 
   ```bash
   worldbuilder-terminal surface --hero-survey --landblock 0xA9B4
   worldbuilder-terminal surface --hero-survey --landblock 0x8602
   # Merge + dedupe
   ```
   Output: list of 50 DIDs sorted by polygon reference count.

2. For each DID, export the diffuse:
   ```bash
   worldbuilder-terminal surface --did 0x06XXXXXX --dump
   # Outputs diffuse PNG to scratch dir
   ```

3. In Substance Painter / Blender / Photoshop, author:
   - `_normal.png` — proper height-derived (not Sobel-on-luminance)
   - `_roughness.png` — per-pixel variation (mortar high, brick face mid)
   - `_ao.png` (optional) — baked ambient occlusion
   - `_emissive.png` (optional) — for Luminous surfaces (lifestones, lava floors, magic crystals)

4. Save under `external/holtburger/data/surface_authored/{did}/{normal,roughness,ao,emissive}.png`.

5. Extend `data/surface_overrides.json` per Phase 1.5 schema:
   ```json
   "0x06001234": {
     "category": "Stone",
     "authored": {
       "normal": "data/surface_authored/0x06001234/normal.png",
       "roughness": "data/surface_authored/0x06001234/roughness.png",
       "ao": "data/surface_authored/0x06001234/ao.png"
     }
   }
   ```

6. Rebuild bake (`bake-dist` script, per `docs/phase-5.2-manifest-fix.md`) — authored assets ship alongside DAT-derived assets.

### Batches

The plan suggests batches of 10 — pick a thematic batch each session (all forge metals, all cottage stones, all door woods, all banner cloths, all lifestones). One session per batch = 5 sessions of art work total.

### Authoring guide

Write `data/surface_authored/AUTHORING_GUIDE.md` covering:
- Normal map convention (DirectX vs OpenGL Y)
- Roughness scale (0=mirror, 1=perfectly diffuse — AC's "matte" baseline is ~0.9)
- AO darkness range (typical 0.3-1.0)
- Consistency across batches

### Budget concern

50 authored surfaces × 3 maps × 512² each = ~150 MB texture memory. Gate authored-asset loading behind `quality=high`; `quality=mid` falls through to procedural Phase 1.1 normals. This is already noted in Phase 2.3's spec.

---

## 7. Where things live

- **Plan doc:** `docs/visual-fidelity-push-prompt-2026-05-13.md`
- **This hand-off:** `docs/visual-fidelity-handoff-pk-2026-05-13.md`
- **Eval screenshots:** `docs/visual-fidelity-eval-2026-05-13/` (13 PNGs + README)
- **Per-wave memory notes:** `~/.claude/projects/-home-wbterminal/memory/project_visual_fidelity_wave{1,2,3,4,5,6}_done_2026-05-13.md`
- **Scratch / agent dumps:** `/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave{1,2,3,4,5,6}-*/`
- **Build cache:** `/mnt/wbterminal1/build-caches/visual-fidelity/cargo-target`
- **Capture scripts:** `external/holtburger/apps/holtburger-web/capture_visfid_p*.cjs`
- **Visual regression infra:** `external/holtburger/scripts/visual-regression/`

---

## 8. Quick sanity-check commands

```bash
# Cargo tests should be 1352/0/1
cd external/holtburger
export PATH=$HOME/.cargo/bin:$PATH CARGO_TARGET_DIR=/mnt/wbterminal1/build-caches/visual-fidelity/cargo-target
cargo test --workspace

# Node regressions
cd apps/holtburger-web
THREE_PATH=/tmp/three.module.js node test_phase7_6_lighting.mjs        # 17/17
THREE_PATH=/tmp/three.module.js node test_visfid_p33_csm.mjs           # 30/30
THREE_PATH=/tmp/three.module.js node test_visfid_p31_pom.mjs           # 29/29
THREE_PATH=/tmp/three.module.js node test_visfid_p32_ssao.mjs          # 20/0
THREE_PATH=/tmp/three.module.js node test_visfid_p02_detail_material.mjs  # all
node test_quality_preset.mjs                                            # 32/32

# Wasm rebuild
wasm-pack build --target web --dev
```

---

## 9. Tone-setting for future agent waves

If you point another agent at this work, the recurring honest findings worth surfacing in any brief:

- **Holtburg can't fully showcase the renderer.** Mild slopes (max 46.9°), only 2 Stone surfaces, no water, no sand, no lava terrain. Real visual win lives in Yanshi (steep), Asheron's Castle (lava + stone), Yaraq (sand + water), Direlands (varied). Brief agents to test against those, not Holtburg, for any phase that touches stone/water/sand/lava paths.

- **The plan-doc audit drifts.** Line numbers in `materials.js`, `lib.rs`, `terrain.js` have moved 50-100+ lines each wave. Always grep-verify before editing.

- **Three.js APIs have evolved.** `DataTexture2DArray` → `DataArrayTexture`. `PCFSoftShadowMap` is deprecated. `cascades` API doesn't exist (hand-roll CSM). Future Three.js upgrades may surface more — agents should be told to verify against r184's docs.

- **`_chainBeforeCompile` is the shader-patch composition primitive.** Anywhere a phase adds shader logic to `MeshStandardMaterial`, it must use `_chainBeforeCompile` in `materials.js` — not direct `onBeforeCompile` assignment, which clobbers prior patches.

- **OAuth limits.** Claude Code's token has no `workflow` scope. Any `.github/workflows/*.yml` files need to be templates that you copy into place yourself.

---

**End of hand-off.** Ping back with any FPS numbers or eye-test results once you've had a session on hardware.
