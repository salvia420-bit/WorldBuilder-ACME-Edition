# Handoff — local rig unresponsive at rest + rig/camera desync (2026-06-27)

## TL;DR
Two player-rig issues surfaced during the B1–B4 movement-fidelity work, observed on the **1070 (real GPU)**:

1. **Combat-mode toggle does nothing while standing still.** At rest, toggling combat mode does not change the local player rig's stance/animation. The moment you **start moving**, the rig snaps to the correct stance and responds. (User-reported, reproduced visually.)
2. **Rig separates from the camera when moving** (rig renders offset from where the camera is centred). Standing still it's coupled (≈0 yd); the gap opens under movement.

Both reproduce in the **normal config (no `agent=1`)**, so they are **not** caused by the experimental B1 flags, and **not** by the shipped B2/B3/B4 work (see "Cleared" below).

The investigation was confounded by a **2–3 fps render stall** in the 1070 test harness (see "FPS confound") which made #2 look much worse than it is and made #1 harder to see — root-cause that too.

---

## Root-cause lead for #1 (combat-mode unresponsive at rest) — HIGH CONFIDENCE
The local player's own motion is **predicted client-side** — ACE does not echo the local player's `UpdateMotion` back (B9 predictor; `FORCE_MOTION_LOCAL_ON`). The local rig's animation/stance is (re)applied only inside `cameraSwitcher._dispatchLocalRigMotion(m)`, which is called **only when the movement signature changes**:

```
scene3d/camera.js:~1857
  if (sig !== this.lastRigMotionSig) {
    this.lastRigMotionSig = sig;
    this._dispatchLocalRigMotion(m);   // reads em.getStance(g) inside
  }
```

`sig` is derived from movement input (forward/strafe/turn/run). **A combat-mode toggle changes the stance but not the movement input → `sig` is unchanged → `_dispatchLocalRigMotion` is never called → the rig keeps its old (peace) idle.** Moving changes `sig` → re-dispatch → `getStance()` now returns the combat stance → rig responds. This matches the symptom exactly.

This gating is **pre-existing** (it lives in `_dispatchMovement`, outside the B2 `localRigCombo` change; the legacy path read `getStance` inside `_dispatchLocalRigMotion` too).

**Suggested fix:** re-dispatch the local rig when the **stance / combat-mode changes**, not only on movement-sig change. e.g. track `lastStance` alongside `lastRigMotionSig` and call `_dispatchLocalRigMotion(currentIntent)` (with `m={forward:0,...}` at rest → resolves to Ready in the new combat stance) whenever the stance changes. Verify the combat-mode toggle path actually updates `em.getStance(g)` synchronously before the re-dispatch.

---

## FPS confound (must root-cause for #2, and it muddied everything)
- The 1070 render ran at **2–3 fps** in every test session.
- Confirmed it is a **genuine render stall, not a window throttle**: `document.visibilityState === "visible"`, `document.hasFocus() === true`, `bringToFront()` → still 2 fps.
- It is **not** loading: 250 resources loaded, 0 pending, 0 in last 5 s.
- Real GPU IS active: `UNMASKED_RENDERER = "ANGLE (NVIDIA GeForce GTX 1070 (0x00001BE1) Direct3D11 ...)"`.
- A **fresh, clean, bare-default** load (original wasm, no experimental flags) was still **3.3 fps with standing desync 0**.
- The 1070 render also showed an **HDR/bloom blow-out** (whole scene washed white) that the laptop's SwiftShader never produced — a real-GPU-path anomaly, a likely lead for the stall (bloom/shader passes).

At 2–3 fps the camera-follow (which predicts/leads) can't track the moving rig, so the **rig/camera desync (#2) is largely an artifact of the low fps under movement** — fix the fps and re-measure #2 before treating it as a separate bug.

**FPS suspects (not yet isolated — was A/B-ing when handed off):**
- `agent=1` in the URL (I had added it from the headless-login recipe; the normal perf-worker config — `drive-perf.sh` — uses `autoLogin&renderer=3d&quality=high` **without** `agent`). Strong suspect; test normal config fps vs `agent=1`.
- The schtasks-`/it`-launched Chrome's GPU present path.
- CDP/Playwright driving overhead.
- A real bloom/shader render-perf regression on the actual GPU.

---

## Cleared (NOT the cause)
- **B2 `localRigCombo` is animation-only.** Direct test: calling `_dispatchLocalRigMotion` with the strafe (`setSidestepLayer`) and backward-combo paths changed the rig's position, heading, AND camera-coupling by **exactly 0** (`transformChanged:false`). It cannot move/rotate the rig or break turning.
- **Shipped B2/B3/B4** (`localRigCombo`/`meleeFaceTarget`/`stickyGroundZ`, commit `d957ec62`, default-on): bare-default standing = 0 desync. Validated objectively on real rigs earlier this session (backward→`motionSign −1`; combo→both slots; mob faces target fwd·dir 1.0; sticky mobs stay grounded on jump, `mobMaxZrise=0`).
- **The experimental B1 compose flags are not the cause** either — #1 and #2 reproduce bare-default. (They DID add measured desync 0→1.77→6.7 yd, but that was all in the 2–3 fps harness and is almost certainly an fps-confound, not a clean flag effect.)

---

## B1 compose flags (`remoteInterp` / `unifiedTick` / `wireStatePacks=stage1` / `stickyRetail`)
- Parsed in **Rust** (`src/lib.rs`: `parse_unified_tick_flag` `== "unifiedTick=on"`, `parse_wire_state_packs_flag` `== "wireStatePacks=stage1"`, `remoteInterp` `== "remoteInterp=on"`) **AND** JS (`entities.js:139`, `loop.js:437`). Strict string matches, default-off.
- Defaulting them on = **Rust + JS edits + a wasm rebuild** (pkg is gitignored), not a one-line JS flip. They are COMPOSE flags (remoteInterp needs unifiedTick + wireStatePacks; stickyRetail needs the triple + `USE_STICKY_MANAGER` Rust const).
- **Status (2026-06-27): FLIPPED DEFAULT-ON per directive** — the 4 Rust parse fns (`src/lib.rs`, now `!… == "X=off"`) + their 3 unit tests + the 2 JS `remoteInterp` readers (`entities.js`/`loop.js`, now `!== "off"`) were changed so all four default-on with a `?flag=off` escape. **Needs a wasm rebuild to take effect** (`pkg/` is gitignored; the committed Rust carries the change). ⚠ **These are UNVALIDATED** — B1 (turn-before-run) was never feel-tested (the 2–3 fps stall blocked the 1070 eye-test) and they showed fps-confounded rig/camera desync. **Eye-test at normal fps ASAP**; revert is `git revert` of this commit or `?remoteInterp=off&unifiedTick=off&wireStatePacks=off&stickyRetail=off`.

---

## 1070 real-GPU test harness (how to drive it next time)
- **Headless-over-SSH does NOT get the GPU** — a process launched in the SSH (session-0) context crash-loops the GPU process (`GPU process exited unexpectedly: exit_code=34`) and WebGL returns `NO-GL-CONTEXT`. You must launch Chrome in the **interactive logged-in session**.
- Working recipe:
  - Tunnel (from laptop): `ssh -N -L 9333:127.0.0.1:9333 -R 7080:127.0.0.1:8765 young@100.127.215.75` (CDP in, serve.py out). Laptop tailscale IP = `100.116.47.66`.
  - Launch Chrome in the interactive session via a scheduled task: `schtasks /create /tn cdpwb /tr C:\Temp\launch.bat /sc once /st 00:00 /it /f` then `/run`, where launch.bat = `"...\chrome.exe" --remote-debugging-port=9333 --remote-debugging-address=127.0.0.1 --user-data-dir=C:\Temp\<fresh> --use-angle=d3d11 --no-first-run about:blank`.
  - Drive from the laptop with Playwright `connectOverCDP('http://127.0.0.1:9333')` (see `scratchpad/drive.cjs`: `goto`/`eval <base64fn>`/`shot`/`front`). playwright-core is at the chrome-devtools-mcp npx install.
  - Load: `http://127.0.0.1:7080/apps/holtburger-web/index.html?nosw=1&bridge_url=ws://100.116.47.66:8080/&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&renderer=3d&quality=high` (NO `agent=1` for representative fps).
- Gotchas: `autoLogin` re-navigates the page → CDP `evaluate` races ("Execution context destroyed"); wait for settle. Single-login account `tailnet1` → ~25 s cooldown between reloads or "Account In Use". `?nosw=1` mandatory under the tunnel. The real rig map is `window.liveScene3d.entityManager.entityMap` (NOT the empty `window.entityMap`); local guid via `window.getLocalPlayerGuid()`; camera follow target via `liveScene3d.cameraSwitcher.getPlayerWorldPos()`; three.js is Y-up (`ac.y = -three.z`, `ac.z = three.y`).
- Kill only the test Chrome surgically: `wmic process where "commandline like '%<profile>%'" call terminate` (leaves the person's Chrome/Roblox running). The 1070 is shared — a person uses it; keep off-screen, never close their session.

---

## Recommended next steps (priority order)
1. **Fix #1** (combat-mode unresponsive at rest): re-dispatch the local rig on stance/combat-mode change in `camera.js` (see root-cause lead). Cheap, high-value, pre-existing bug.
2. **Root-cause the 2–3 fps stall** at normal config: A/B `agent=1` vs not; investigate the HDR/bloom blow-out on the real GPU. Until fps is normal, #2 (desync) can't be judged.
3. **Re-measure #2** (rig/camera desync) at normal fps; if it persists, dig into the camera-follow vs rig-position update phase (the `[sync-tick] camera reads a pre-tick pose` warning is a lead).
4. **Then** eye-test B1 (`remoteInterp`) properly at normal fps (its earlier desync numbers were fps-confounded).
