# task-PORTAL-BLEED — "the sideportalpunch is making windows visible through roofs, walls etc"

Lane B of the s12 two-agent buildbox run. Branch `orch/s12-portal`, cut from
`c53a4448`. Owner's bug, PRIORITY 1.

**VERDICT: reproduced, root-caused, and fixed by a flag that already exists and
is default-OFF. `?punchSidedness=on` is the fix. I did not flip its default
(I7 / PRE §7) — the evidence and the gate it should pass are below.**

All render verdicts here are a **T4 / Linux / EGL arm** and are labelled as such.
The renderer string was asserted from INSIDE the live page on every arm:
`ANGLE (NVIDIA Corporation, Tesla T4/PCIe/SSE2, OpenGL ES 3.2)`.

---

## 1. THE ROOT CAUSE — the punch has no occlusion gate against anything that is not terrain

Read this session, in this order.

**Retail runs THREE rejects before it punches.** `PView::ConstructView`
(acclient.c:462507-462561) reaches its far-punch call at **acclient.c:462557**
(`DrawPortalPolyInternal(v5, portalPolyOrPortalContents == 1)` — `zClear=1` is
the far punch) only after passing all of:

1. **the sidedness reject**, acclient.c:462519-462541 — `v7 = dot(FrameCurrent,
   ppoly->plane.N) + plane.d`, classified into `Sidedness` against the
   `0.00019999999` on-plane band, then `return 0` unless the sign matches
   `outside_portal->portal_side`;
2. **`PView::GetClip` + `if (!ppoly) return 0`**, acclient.c:462542-462544 — the
   portal is clipped against the ACCUMULATED portal-view polygon, and a portal
   that clips away to nothing never reaches the punch;
3. **`CEnvCell::GetVisible(other_cell_id)` + `Render::copy_view`**,
   acclient.c:462545-462554 — `return 0` if the destination cell is not visible
   or the view will not copy.

**Our port has one of the three, and it is default-OFF.**

* wasm selection is **frustum-only**. `visible_portal_apertures_flat`
  (src/lib.rs:35633-35695) filters on the outdoor sentinel
  (`to & 0xFFFF >= 0xFFFE`, :35669), a degeneracy check (:35672) and then
  exactly one visibility test — `frustum.intersects_aabb` on the OWNING cell's
  AABB (**src/lib.rs:35677-35680**). That is a frustum test, not an occlusion
  test.
* the JS gate chain (`clipAperturesForPunch`, scene3d/portal_clip.js:783-993)
  is, in order: sidedness (:877-884) → LandCell-boundary (:887) → viewer-straddle
  (:897) → near-plane clip (:904) → project + area clamp (:912-922) →
  terrain-LOS (:932-969).
* **the only occlusion gate in that chain is `terrainRayBlocked`
  (scene3d/portal_clip.js:323-408), and it samples the terrain HEIGHTFIELD and
  nothing else.** A roof is not terrain. A wall is not terrain. Another building
  is not terrain.
* the punch material is `depthFunc = THREE.AlwaysDepth`
  (**scene3d/portal_punch.js:102**), `colorWrite = false` (:100), writing
  `FAR_DEPTH = 0.99999899` (:38, emitted at :95).

So an aperture standing behind a roof passes every gate we have, and the punch
then **overwrites that roof's depth with far-Z while leaving its colour**. The
cells pass (layer 1) draws the interior into the same buffer immediately after
and wins there. The interior is painted over the roof. That is the bug, and it
is structural — not a tuning error.

The sidedness gate is the one of retail's three we *do* have
(`facesAwayWithSide`, scene3d/portal_clip.js:703-717), and
`docs/url-flags.md:259` already describes it as the gate that "stops a far-side
door being punched through the near wall". It has been **default-OFF** since it
landed. `PORTAL-FLAGS-DECODE` (2026-08-11) replaced the unreliable round-5
AABB-centre inference with retail's real `portal_side` wire bit.

---

## 2. THE REPRO — how to get back to it

Runtime-derived, not from the queue (§-10 B records the queue's Holtburg bench
anchor as ~10 km off where `@telepoi Holtburg` lands):

```
@telepoi Holtburg          →  landblock 0xa9b40019
AC world metres            →  (32532, 34567.1, 94)     [ = lbIndex*192 + local ]
camera                     →  window.__cam.orbit(32532, 34567.1, 94, 52, 180, 52)
```

Both A/B arms landed on that **identical** pose, so the pairs differ only by the
flag. URL (note `bridge_url` — see §6 trap 1):

```
http://127.0.0.1:8772/apps/holtburger-web/index.html?nosw=1&autoLogin=1
  &autoSpawn=first&agent=1&skytime=12&camDebug=on&renderScale=1
  &account=agentp09&password=agentp09
  &bridge_url=ws%3A%2F%2F100.116.47.66%3A8080%2F
```

Harness committed at `docs/reengineering/impl/portal-bleed-harness/`
(`mkjob.mjs` emits an arm; `diags.py`, `diffshots.py`, `cropshot.py`,
`mkpairs.py`, `sidebyside.py` do the reduction).

---

## 3. WHAT THE GATE COUNTERS MEASURED

`liveScene3d._portalPunchDiag`, same seven-camera rig, same anchor, three arms.

| camera | `sidedness=off` (default) | `sidedness=on` (`sidednessSource:"flag"`) |
|---|---|---|
| | offered / kept / backface | offered / kept / backface |
| follow | 36 / 0 / 0 | 86 / 6 / **57** |
| n-low | 8 / 8 / 0 | 8 / 0 / **8** |
| e-low | 3 / 3 / 0 | 6 / 2 / **4** |
| s-low | 44 / 9 / 0 | 86 / 10 / **57** |
| w-low | 20 / 20 / 0 | 32 / 7 / **25** |
| se-mid | **31 / 31 / 0** | 62 / 16 / **46** |
| over-45 | **37 / 36 / 0** | 72 / 20 / **51** |
| over-hi | 4 / 4 / 0 | 8 / 2 / **6** |

The default arm's `se-mid` and `over-45` rows are the bug in one number:
**31 of 31 and 36 of 37 apertures depth-punched with ZERO rejections.** With the
flag on, the sidedness gate rejects 63–75% of offered apertures — matching the
estimate already written at portal_clip.js:869-870 ("in a town it rejects roughly
half the offered apertures").

`offered` differs between arms because more cells were resident on the later
runs; the CAMERA and anchor are identical, which is what the comparison rests on.

---

## 4. THE EYE RESULT, AND THE CONTROL ARM THAT MAKES IT MEAN SOMETHING

A third arm ran with **`?portalPunch=off`** — no punch at all
(`_portalPunchDiag` reads `"<absent>"`, so the pass is not even constructed).
That arm is the artifact-free reference: whatever it shows on a roof is real
geometry.

At the Holtburg building above, `over-45`:

* **`portalPunch=off`** — clean shingle roof.
* **`punchSidedness=off` (today's default)** — a solid tan/orange rectangular
  patch of interior floor drawn ON the roof, plus speckle across the shingles.
* **`punchSidedness=on`** — matches the `portalPunch=off` control.

A wooden gable/truss structure is present in **all three** arms, including
punch-off — so it is **legitimate building geometry, not bleed**. Recording that
explicitly because it is the thing an eye-only pass would have called a residual
bug.

Quantified as *distance from the punch-off control* (`diffshots.py`; `changed%`
= pixels differing by >16/255 luma, `strong%` = >64/255):

| camera | control vs **default** | control vs **sidedness=on** |
|---|---|---|
| over-45 | 2.225% / 0.066% | **0.115% / 0.008%** |
| over-hi | 2.242% / 0.070% | **0.143% / 0.066%** |
| s-low | 4.799% / 0.496% | 1.854% / 0.032% |
| se-mid | 3.361% / 0.464% | 2.155% / 0.403% |
| e-low | 5.726% / 0.735% | 2.745% / 1.012% |

**On the two elevated roof-looking cameras the gate collapses the difference from
the no-punch control by ~16-19x** (over-45: 2.225% → 0.115%). Those are the
cameras where the frame is mostly ROOFS, so *any* difference from punch-off is
artifact — and it very nearly goes to zero.

**The ground-level cameras keep a real difference ON PURPOSE and must not be
read as residue.** The punch exists to reveal interiors through near-side
doorways, so at e-low/s-low/se-mid a correct punch is *supposed* to differ from
punch-off. Driving those to zero would mean the feature had been disabled.

A per-pixel diff overlay (`out/diffmask-over-45.png`) puts every changed pixel
**on building roofs**, with the terrain untouched — which is the owner's report,
localized.

---

## 5. RECOMMENDATION — flip `punchSidedness` to default `on`, and the gate it should pass

Not done here: I7 and PRE §7 reserve default flips to the owner, serialized per
SPEC §3. What the flip has going for it:

* it restores retail's own first reject, verbatim, from the real wire bit —
  not an inference;
* the bit is measured correct over the retail baseline: 15,186/15,186
  outdoor-facing and 1,840,177/1,840,177 cell→cell portals, zero on-plane
  (holtburger-dat `tests/cell_portal_flags_parity.rs`, per docs/url-flags.md:259);
* the round-5 regression that made everyone wary of this gate was the
  **AABB-centre heuristic** (`?punchSidedness=heuristic`), a different arm which
  this does not touch;
* `tests/portal_clip.test.mjs` already locks the truth tables, the on-plane band,
  the strict-`1` wire read, and a case where the heuristic culls a doorway the
  flag keeps — **59 assertion groups, green this session**;
* the OFF arm remains the byte-identical kill path.

**Gate it should pass before the flip (this is the part I could not do):**

1. **an owner-rig eye pass.** Every verdict above is a T4/Linux/EGL arm. §-10 B
   records the Yaraq indoor bleed reproducing on the owner's rig and a
   Mesa/Intel laptop but NOT on the T4 — this box has disagreed with the owner's
   eyes before, so this needs his ratification, not mine.
2. **a doorway-reveal check at ground level**, indoors and out: confirm the gate
   does not cull a near-side doorway the player is looking through. My `e-low`
   row (offered 6 → backface 4 → kept 2) is the row to watch; I have no
   ground-level frame that isolates a single doorway.
3. `_portalPunchDiag.gates.sidednessSource` must read **`"flag"`**. If `pkg/` is
   stale it reads `"unavailable"` and gates NOTHING — the flip would then be a
   no-op that looks like a fix. (It read `"flag"` on every arm here;
   `getVisiblePortalAperturesWithSidedness` is present in this `pkg/`.)

**What the flip does NOT fix, and should not be claimed to.** Retail's other two
rejects (§1: `PView::GetClip`, and the destination-cell-visible test) are still
absent. So an aperture that is on the correct side but occluded by a DIFFERENT
building, or by its own building's roof overhang, can still punch. Sidedness
removes the largest and cheapest class — the far-side aperture seen through the
near wall of its own room — and the numbers in §4 say that class dominates at
Holtburg. A full answer is a PView port, which is a redesign and was not
attempted.

---

## 6. TRAPS THIS COST, recorded so the next session does not pay them again

1. **`bridge_url` is REQUIRED on this box and is in no existing job file.** The
   box reaches ACE directly over Tailscale at `100.116.47.66:8080`; the built-in
   default is `ws://127.0.0.1:8080/` (index.html:644), so the first arm failed
   boot twice with `connect failed … error` before this was added.
   `server_host`/`server_port` stay at `127.0.0.1:9000` (index.html:659-660) —
   the bridge proxies to ACE on the LAPTOP's loopback, which is also why TCP 9000
   reads closed from this box while 8080 reads open.
2. **Two of eight GL captures per arm landed between passes** and came back as
   the flat clear colour (`meanLuma 1.72` vs ~120-148 for a real noon frame;
   `nonBlackPct 0%`). They are byte-identical in size, which is the tell.
   `n-low` and `w-low` hit it. **They are capture artifacts, NOT black worlds** —
   an exit-code or eyeball reader would have called them the 2026-07-06
   whole-world blackout. `mkpairs.py` now refuses any pair with a side under
   luma 4.0.
3. The `follow` camera is **not** a controlled comparison — it trails player
   heading, which is not pinned between arms. Only the `__cam.orbit` rigs are.
4. Same-account relogin inside ~3 min is fatal, as documented: the second arm's
   first login attempt failed `timeout` and succeeded on arm.mjs's 60 s retry.

---

## 7. Tests run

| suite | result |
|---|---|
| `tests/portal_clip.test.mjs` | **59 assertion groups passed** |
| `harness/test_diag_schema.mjs` | **69 passed, 0 failed** (registry 21 surfaces, 19 tags) |
| `harness/test_pack_fetch_controller.mjs` | **100 passed, 0 failed** |
| `harness/test_tex_compressed_only.mjs` | **115 passed, 0 failed** |

All four print real assertion counts, so `node_modules` (a symlink into the main
checkout) genuinely resolved — the false-PASS mode the card warns about (a
`three`-importing suite dying at module resolution *before* asserting, scored
green by an exit-code reader) did not occur.

`test_pack_fetch_region`, `test_xu7_transcode` and `harness/test_build_shell`
were **NOT run**: they need `/mnt/wbterminal2`, which does not exist on this box.
They are not reported green.

**Rust suites were not run and are not claimed.** This task changed no Rust; the
baselines (core 643/0, world 688/0, dat 694/1) are untouched by it and a
`cargo test` on a shared 4-core box was not worth the contention.

---

## 8. Deviations

**None.** No SPEC behaviour was changed. No flag default moved. No client code
was modified by this task at all — the fix is an existing flag, and the finding
is that its default is wrong.

---

## 9. Shipped

| file | what |
|---|---|
| `docs/reengineering/impl/portal-bleed-harness/*` | the A/B rig (6 tools) |
| `docs/reengineering/impl/task-PORTAL-BLEED-report.md` | this report |

Commits are listed in the handoff section `## -12B.`

**Screenshots taildropped to `redmi-note-13-5g`:**

| file | shows |
|---|---|
| `s12-B-holtburg-roof-THREEWAY.png` | punch=off \| sidedness=off \| sidedness=on, same roof — **the headline** |
| `s12-B-holtburg-roof-punchSidedness-AB.png` | the same roof, default vs fixed, 2-up |
| `s12-B-holtburg-over-45-punchSidedness-off-1.png` | full frame, today's default |
| `s12-B-holtburg-over-45-punchSidedness-on-1.png` | full frame, gate on, same camera |
