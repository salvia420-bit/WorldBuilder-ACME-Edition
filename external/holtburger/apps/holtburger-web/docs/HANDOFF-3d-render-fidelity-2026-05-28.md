# Handoff — holtburger-web 3D render fidelity + headless 1070 eye-test

Date: 2026-05-28. Read this first. It gets you back to a working remote-GPU
eye-test loop in one shot and lists every pending / deferred / out-of-scope item.

---

## 0. What we're working on

**holtburger-web** = a browser (Three.js + wasm-bindgen Rust) reimplementation of
the **Asheron's Call** retail client. Path:
`/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/`
- `apps/holtburger-web/scene3d/` — the Three.js renderer (one module per system:
  `index.js` scene wiring + rAF, `terrain.js`, `buildings.js`, `cells.js`,
  `statics.js`, `entities.js`, `animation.js`, `materials.js`, `adapter.js`
  wasm→Three mesh conversion, sky/atmosphere stack).
- `apps/holtburger-web/src/lib.rs` — wasm bindings (huge, ~35k LOC). Mesh/anim/
  palette decode, EntityUpdate, etc.
- `crates/holtburger-dat/` — Rust DAT parsers (region.rs, graphics.rs,
  file_type/{surface,texture,palette,setup_model,motion_table,animation}.rs,
  terrain_merge.rs).

This session's thread: a **fidelity audit vs the canonical AC sources**, fixing
where the renderer diverges from how retail actually rendered. The master doc with
every finding + per-fix status is **`docs/3d-render-fidelity-audit-2026-05-28.md`** —
read it alongside this handoff.

---

## 1. The canonical reference sources (the "truth")

| Name | Where | What it is / how to use |
|---|---|---|
| **acclient.c** | `~/ac-headers/acclient.c` (31 MB) | Hex-Rays decompile of the retail client **with function bodies**. THE behavioral reference. GREP a symbol, then Read that line region — never read the whole file. |
| **acclient.txt** | `~/ac-headers/acclient.txt` (82 MB) | cvdump public-symbol dump. Use to find the exact class/method name, then grep acclient.c for it. |
| **acclient.h** | `~/ac-headers/acclient.h` (1.7 MB) | retail structs + enums (e.g. `SurfaceType`, `CSWVertex`, blend modes). |
| **acclient_2013.bndb_pseudo_c.txt** | `~/ac-headers/` (65 MB) | Binary Ninja cross-decompile (second opinion). |
| **ACE (acemaster)** | `external/ACE/Source/` | C# AC **server** with a partial physics port (`ACE.Server/Physics/Common/TexMerge.cs`, `LandDefs.cs`, `Setup.cs`). ⚠️ This checkout is PARTIAL: `Physics/Animation/` (AnimData/MotionInterp/Sequence) is **absent** — the T4/T11 cites came from a fuller tree. |
| **melt** | `external/melt/Source/` | C# DAT loader (research-only). `ACE.DatLoader/FileTypes/{Surface,SetupModel,MotionTable,Scene,PaletteSet,...}.cs`, `Ace.Entity/Enum/*`, `misc/{DxtUtil,GfxObjTools,SetupModelTools}.cs`. |
| **chorizite** | `external/chorizite/` | C# AC plugin ecosystem. `Chorizite/Chorizite.Core/Render/{TextureMergeInfo,SurfaceInfo,Vertex/VertexLandscape}.cs` are gold for terrain. `ACBindings/Generated/*` = hardcoded acclient offsets (reference only). |
| **DatReaderWriter (acdatreaderwriter)** | `external/DatReaderWriter/` | C# DAT parsers. Authoritative for record shapes, BUT for scalar widths / vector-vs-scalar / counts, **trust acclient.c over DRW** (DRW mislabels — see memory). |

**Precedence rule learned this session:** for the TexMerge index PRNG, ACE uses
64-bit `long` but acclient uses **32-bit unsigned wrap** — acclient is canonical.
General rule: acclient.c > ACE > DRW for exact arithmetic/widths.

---

## 2. Get back to the 1070 headless eye-test in ONE SHOT

The GPU rendering runs on a Windows GTX 1070 Ti box (`young@100.127.215.75`, key
auth, pubkey trusted). We drive a **dedicated off-screen headless Chrome** there
that does NOT touch the user's visible browser.

### Topology / backend (all currently RUNNING; verify, don't blindly restart)
- **Laptop (this shell):** no-cache python server `127.0.0.1:8765` (serves the app,
  `Cache-Control: no-store` so JS edits go live on reload); `holtburger-wsbridge`
  WS `:8080`; **ACE** UDP 9000/9001 launched via a **FIFO stdin** `/tmp/ace_stdin`
  (EOF-loop-safe — drive it with `echo "@cmd" > /tmp/ace_stdin`, read
  `/mnt/wbterminal1/tmp/claude-scratch/k1/ace.log`).
- **Persistent SSH tunnel** (uptime hours): `-R 7080→8765` (app), `-R 8080→8080`
  (wsbridge), `-L 9224→9224` (legacy firefox-driver), and our work is via SSH
  command exec, not the tunnel.
- **Eye-test Chrome:** off-screen, isolated, on the 1070 at `127.0.0.1:9333`.
  Profile `C:\Temp\chrome-eyetest-s1`. Real GPU confirmed:
  `ANGLE (NVIDIA GeForce GTX 1070, D3D11)`.

### Health check (run these first)
```bash
curl -sS -m4 http://127.0.0.1:9224/status                      # firefox-driver (legacy)
curl -sSI -m4 http://127.0.0.1:8765/apps/holtburger-web/index.html | grep -i cache
ss -ltnp | grep :8080 ; ss -lunp | grep -E ':9000|:9001'      # wsbridge + ACE
timeout 20 ssh -o BatchMode=yes young@100.127.215.75 "powershell -NoProfile -Command \"(Get-Process chrome -ErrorAction SilentlyContinue|Measure-Object).Count; netstat -ano|Select-String ':9333.*LISTEN'|Select-Object -First 1\""
```

### If the eye-test Chrome is dead (0 procs / not listening on 9333), relaunch it
**Must** go through Task Scheduler interactive session (SSH-launched Chrome dies in
Session 0 with no GPU). Script is on the box already:
```bash
timeout 25 ssh -o BatchMode=yes young@100.127.215.75 "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Temp\launch_eyetest_s1.ps1"
# (registers + starts task HoltburgerEyetestChrome → off-screen Chrome on :9333)
```
node is at `C:\Program Files\nodejs\node.exe`; Playwright is at `C:\Temp\node_modules`.
Driver scripts run **locally on the 1070** (CDP doesn't survive the SSH tunnel —
Chrome 148 host-header). Connect with `connectOverCDP("http://127.0.0.1:9333")`
(use 127.0.0.1, NOT localhost — Node 18 resolves localhost→::1 and Chrome binds IPv4).

### The capture workflow (scripts in `C:\Temp\` and `/mnt/wbterminal1/tmp/claude-scratch/eyetest/`)
1. **Login + bake:** navigate to
   `http://localhost:7080/apps/holtburger-web/index.html?renderer=3d&quality=high&clouds=on&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&kickDance=1`
   then poll `window.__bootState` until `"ready"` and `window.liveScene3d` exists with
   `terrainBakedLbs.size==169`. (~60–90 s; poll gently, ≥3 s cadence.)
2. **Teleport outdoor:** the spawn is an unrendered dungeon — get to Holtburg via
   `await window.__sessionHandle.sendChat("@telepoi Holtburg")` (the `/telepoi`
   chat-form path does NOT fire; the wasm `sendChat` method does). tailnet1 is a
   Developer (`DefaultAccessLevel:4`, char "+Tester"). Wait ~20 s for re-bake.
3. **Capture a LIT frame:** `page.screenshot` is BLACK (WebGL
   `preserveDrawingBuffer=false`). Instead, in ONE eval:
   `window.__renderOnce(); return liveScene3d.renderer.domElement.toDataURL("image/jpeg",0.85)`.
   `__renderOnce` gives the COMPOSITED (sky+AGX) frame; a direct
   `renderer.render(scene,cam)` is too dark outdoors (no tonemapping). Then base64-
   decode → write JPEG → `scp young@...:C:/Temp/shot.jpg <laptop>`.
   Ready-made: `C:\Temp\tp3.mjs "@telepoi Holtburg" outname` and `full-cull.mjs`
   (login+teleport+shot, takes a URL so you can A/B `?perPolyCull=on` etc.).
4. Read the JPEG with the Read tool (it renders images). A real frame is ~100–155 KB;
   a black/empty one is < 16 KB and uniform.

### Stop the eye-test Chrome when done (frees GPU/RAM)
```bash
ssh young@100.127.215.75 "schtasks /End /TN HoltburgerEyetestChrome & taskkill /F /IM chrome.exe /T"
# (only kills if no other Chrome matters; our profile is isolated)
```

### Wasm rebuild (after any Rust change)
```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web
export PATH=$HOME/.cargo/bin:$PATH
wasm-pack build --target web --out-dir pkg --release            # ~1m30s
# then bump the ?v= in index.html (currently :1050 `?v=fidelity-20260528`)
```
`pkg/` is gitignored. JS edits go live on plain reload (no-cache server).

---

## 3. What's DONE (committed to master, 40f0cf3b + this session's follow-up)

10 test-validated fidelity fixes (full detail in the audit doc):
**T3** sub-palette ×8 + absolute source index (skin/hair/eyes/dye colouring) ·
**T4** multi-AnimData concatenation + reverse-framerate playback ·
**T5** SetupModel per-part default_scale (flag 0x02) ·
**T6** authored per-vertex normals → smooth shading ·
**T10** InvAlpha (0x200) alpha-blend ·
**T12** pickPaletteForShade rounding ·
**T1** TexMerge **selection core** (`crates/holtburger-dat/src/terrain_merge.rs`,
acclient wrap-PRNG; composite NOT done) ·
**T2** per-poly cull — **NOW DEFAULT ON** (eye-test-confirmed winding; `?perPolyCull=off`) ·
**T8** terrain minimap-colour tint → opt-in `?terrainPalette=on` (default off) ·
**T11** `cycleTimeScale` helper only (apply not wired).

Validated headlessly at Holtburg this session (2 screenshots in this dir:
`eyetest-2026-05-28/holtburg-culloff.jpg` and `holtburg-cullon.jpg`): T3 colours
correct, T6 smooth, T8 natural-green terrain, T2 buildings/NPCs/character/lifestone
all solid with cull on. Tests: holtburger-dat 239/239, holtburger-web 73/73, JS
suites green, wasm32 clean.

---

## 4. PENDING work (in scope — now unblocked by the working eye-test loop)

- **T1 composite (biggest visual).** Selection done; need the pixel composite
  (`acclient.c` `TexMerge::FillTempTexBuffer` @305909 → `Merge` @304839 →
  `ImgTex::MergeTexture`; ACE's are server stubs) + wire merged tiles or a
  shader-blend into the atlas with per-cell pcode/alpha-index/rotation, replacing
  the bilinear cross-dissolve in `terrain.js`. Put behind a flag; eye-test.
  Composite math is acclient-only + tiling/rotation conventions are eye-test-tuned.
- **T7 detail texture.** Fetch `GetDetailTex(0)`/`GetDetailTiling(0)` (one landscape
  detail tex; data parsed in `region.rs` `detail_texture_id`/`detail_tex_tiling` but
  never fetched), add a shader sampler + near-camera modulation behind
  `?terrainDetailTex=on`. Cleanest next item — immediate visual payoff.
- **T9 dynamic entity LOD.** ⚠️ NOT a simple `THREE.LOD` mirror of statics: entity
  rigs are driven by an `AnimationMixer` bound to specific per-part meshes, so band-
  swapping needs mixer rebinding — that's why it freezes the band at spawn
  (`entities.js:1291`). Effort-L + eye-test.
- **T11 apply.** Surface `|MotionData.velocity|` to JS as the cycle baseSpeed (same
  pattern as T4's `duration`), wire a per-entity ground speed into the anim tick
  (none exists today — only angular `SetOmega`/projectile speed), then
  `action.setEffectiveTimeScale(cycleTimeScale(actual, base))` on walk/run; eye-test.

---

## 5. DEFERRED (real but architectural / multi-layer — from the internal bug sweep)

From `docs/3d-render-debug-findings-2026-05-28.md` (a SEPARATE internal-leak sweep,
not the fidelity audit). Still open:
- **A2 / K3** — wasm export for motion-table `bitfield` bit 0 `clears_modifiers`
  (11.5% of tables); gates additive-layer clearing. Spans Rust→wasm→JS.
  (`motion_table.rs:132` bitfield, `entities.js:_tryPlayLink`.)
- **A3 / I1** — wasm export for jump-reject signal (telemetry-first; low priority).
- **A8 / B2** — mesh-conversion failure policy (render-empty-stub vs fail-spawn) —
  needs a product call.
- **A9 / N6** — door hinge rotation driver (`buildings.js:380` has the empty
  `userData.doorRotationRad`); multi-day new feature.
- **G7** — HRTF position for moving sources: A4 integrated `updateFollowingPositions`;
  a few callers may still not opt in.

---

## 6. OUT-OF-SCOPE / verified false-positives (do NOT re-litigate)

The internal sweep had a ~45% FP rate. Confirmed NON-bugs (details in that doc):
- Loop dispatch kinds 17/18/16 are owned by the 2D `drainEvents` loop, not the 3D
  `dispatchOne` (architectural split — W1/N5/W2).
- N2 EnvCell "unload race" — single-threaded JS, no await between the lines.
- K1 crossFade double-play, N3 fused multi-material, R1/L3/L6 GC lifecycle, H3/H4/H5/H6
  plugin lifecycle, G6 clamp-already-applied — all verified fine.
- **M1/A7** terrain atlas seams — FALSE: it's a `DataArrayTexture` with per-layer
  ClampToEdge (cross-tile bleed structurally impossible).
- **V2** cloud `cameraHeight` — verified correct via context7 (takram convention).

## 6b. Audit corrections made THIS session (so the next agent doesn't repeat the error)
- TexMerge PRNG: ACE `long` is WRONG; acclient 32-bit unsigned wrap is canonical (T1).
- "PalShiftTerrainPal" does NOT exist — `TerrainTex` has no palette field; real
  per-biome differentiation for shared-base-texture codes is the vertex
  bright/sat/hue modulation (`?terrainMod`, brightness opt-in, sat/hue deferred) (T8).
- T9 is animated-rig LOD (mixer rebinding), not a statics mirror.
- This ACE checkout LACKS `Physics/Animation/` (AnimData/MotionInterp/Sequence).

---

## 7. Gotchas (hard-won, will save you hours)
- `page.screenshot` / firefox `/screenshot` = BLACK for the 3D canvas. Capture via
  `__renderOnce()` + `toDataURL` in one eval.
- SSH-launched Chrome dies (Session 0, no GPU). Use the Task-Scheduler interactive
  launch (`launch_eyetest_s1.ps1`).
- `connectOverCDP` must use `127.0.0.1:9333`, not `localhost` (Node 18 → ::1).
- The spawn point is an unrendered dungeon — always `@telepoi Holtburg` for outdoor.
- ACE EOF-loop (1 TB log!) — keep it on the FIFO stdin; never relaunch with `</dev/null`.
- GLSL comments inside shader template literals: NO backticks (they close the literal;
  V8 tolerates, Firefox/esbuild reject). Bit us this session in terrain.js.
- Scratch (screenshots/logs) → `/mnt/wbterminal1/tmp/claude-scratch/` (system disk 85-96% full).
- Don't `/clear-cache` to pick up JS edits (no-cache server makes it unnecessary +
  it evicts CDN modules → import storm).

## 8. Memory
`MEMORY.md` index + topic files at `~/.claude/projects/-home-wbterminal/memory/`.
Key: `reference_ac_re_artifacts` (acclient), `reference_firefox_driver_workflow`,
`feedback_dat_format_ace_over_drw`, `feedback_dat_parser_mislabels`,
`project_terrain_vertex_modulation_gap_2026-05-28`. Older handoff:
`~/handoff-firefox-driver-2026-05-20.md` (the visible-Firefox driver; this doc
supersedes it for the headless flow).
