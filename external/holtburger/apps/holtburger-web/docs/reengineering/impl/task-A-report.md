# LANE A — PORTAL-GATE — 2026-08-14

branch `lane/portal-gate-20260814` · worktree `/mnt/wbterminal2/lanes/a-portal-gate`
commit `14289248` "holtburger: the portal occlusion gate gets its own flag, and finally punches"

Task (handoff O-P1, first step): `?portalStencil=on` armed the punch's occlusion gate but
left the punch feed inert — `_portalPunchDiag` `offered/kept 0/0`. "The gate is reachable
but does nothing." Find why, make it punch a correct subset, keep `?portalStencil` default
OFF, state the gate's allocation cost on the default path, and queue the daylight
town-distance pair. The architectural fix is lane D's, not mine.

---

## 1. Root cause — the flag was doing two jobs, and the second one cancelled the first

The feed is not broken. Nothing in `tickPortalPunch`, `clipAperturesForPunch` or
`visible_portal_apertures_flat` reads `portalStencil`; the wasm selector is a pure function
of the MVP and the cell snapshot. The conflict is one layer up:

* Until this commit, the ONLY way to get a stencil attachment on the composer was
  `?portalStencil=on` (`atmosphere_pipeline.js`, `stencilBuffer: !!portalStencil`), and
  `PortalPunchPass`'s occlusion gate arms only when it reads a real stencil attachment back
  off `composer.inputBuffer.stencilBuffer`. So `?portalStencil=on` was also the only way to
  arm the gate.
* `?portalStencil=on` ALSO constructs the retired `PortalStencilPass`. Its per-frame feed
  `tickPortalStencil` (`cells.js`) **parks every visible interior cell container on
  `RENDER_LAYER_PORTAL_CELL` (layer 2)** — `_setCellLayer(container, RENDER_LAYER_PORTAL_CELL)`
  — and draws them itself, flat-shaded, through its own MARK/RESET punch.
* The punch's entire mechanism is the world/cells layer split armed in
  `preFrameSkySync` (`punchActive`): world pass `WORLD_ONLY` (layer 0) → punch → cells pass
  `INDOOR_ONLY` (**layer 1**). The scaffold has just emptied layer 1.

Two mechanisms for the same pixels, mutually exclusive, arriving on one flag. In that arm the
punch can arm, be fed and draw and still change nothing anyone can see, because its consumer
has no geometry left. That is the "reachable but does nothing" — as a structural claim.
**Read §5 before quoting it as a measured one:** the reported `0/0` did not reproduce on this
box, and I never caught the scaffold parking a cell in the act. What is not in doubt is that
one flag arms two competing mechanisms, which is reason enough for the gate to have its own.

### Fix

`?punchOcclusion=on` — DEFAULT OFF — is the gate's own flag: it allocates the stencil
attachment and arms `PortalPunchPass`'s MARK/PUNCH pair, and constructs **no** scaffold, so
interior cells stay on layer 1 where the punch needs them.

`?portalStencil` keeps its historical behaviour and its default OFF. It now logs a warning
naming the conflict, so nobody spends another day judging the punch in the one arm that
cannot show it.

Files: `scene3d/atmosphere_pipeline.js` (opt + `stencilBuffer` + packed-depth branch +
scaffold warning), `scene3d/index.js` (flag reader), `scene3d/cells.js` (one line —
`gates.occlusionGated` in the punch diag, read off the PASS not the flag).

---

## 2. Measured, live, on this box

`harness/portal-gate-probe.mjs` (new): boots the real client per arm on the lane's own
`serve.py` (port 8771), account `agentp07`, `@telepoi Holtburg`, samples
`_portalPunchDiag` + each pass's internal state every 2 s. `?nullRender=1`: the punch FEED
runs in the tick — which is the subject — and only the GPU submission is skipped. The
full-render arm starved the client's 30 s login handshake on this 8 GB laptop, and an arm
that never reaches in-world is not an arm.

Same landblock (`0xA9B60019` = 2847146009), same camera, steady state:

| arm | offered / kept | `dropped.terrain` | `gates.occlusionGated` | composer `stencilBuffer` | `pass._errored` |
|---|---|---|---|---|---|
| default (no flag) | **42 / 6** | 36 | false | **false** | false |
| `?punchOcclusion=on` | **42 / 6** | 36 | **true** | **true** | false |
| `?portalStencil=on` | **84 / 12** | 72 | true | true | false |

(The `portalStencil` arm booted only on the 4th attempt — see §5 — and by then more of the
town had streamed in, which is why its absolute counts are higher; it is a later session
state, not a flag effect. What matters is that it is not 0/0.)

The gate is armed AND the feed is live, with the same surviving subset — which is what "the
gate punches a correct subset" has to look like at the FEED. What the gate then does
per PIXEL is a real-GPU question; it is queued (§4), not claimed here.

Raw: `probe2.json` / `probe3.json` in the session scratchpad (not committed — they are
machine-local paths, and the numbers that matter are in this table and in the commit).

---

## 3. ALLOCATION COST OF THE GATE ON THE DEFAULT PATH — **zero**

Mandatory check (PRE.md), after 2026-08-13, when a correctly default-OFF gate still made the
DEFAULT composer ask for a stencil attachment, which flips the shared scene depth texture to
the packed `DepthStencilFormat`/`UnsignedInt248Type` pair; some depth consumer cannot read
it and distant town views went black (mean luma 2.3 vs 62 at orbit d=80). That reached
master for 20 minutes.

With `?punchOcclusion` absent (and `?portalStencil` absent — the default):

* `stencilBuffer: !!portalStencil || !!punchOcclusion` → **false**. No stencil attachment on
  either ping-pong buffer. *Live-verified: `stencilBuffer:false` on the default probe arm.*
* the bespoke scene depth texture stays `DepthFormat` / `UnsignedIntType` — the packed pair
  is behind the same disjunction, so the depth consumers (aerial perspective, cloud overlay,
  ground fog) read exactly the texture they read before.
* the composer's pass list is **unchanged** — nothing added, nothing removed, no
  `PortalStencilPass`.
* `PortalPunchPass` is constructed with `stencil:false` → no MARK material is allocated
  (`_markMat === null`), no `clearStencil()`, one draw per frame as before: the legacy
  unconditional punch, byte-identical to the pre-gate pipeline.
* the only cost is one `URLSearchParams.get` at boot and one boolean in the options object.

Locked by `tests/portal_punch_occlusion_flag.test.mjs`, which fails if the `stencilBuffer`
expression or the packed-depth branch ever mentions `portalPunch` again (that flag is
DEFAULT-ON) or becomes unconditional, and if the reader is ever written `!== "off"`.

I did **not** flip any existing default. `?portalPunch` stays default-ON, `?portalStencil`
and `?punchOcclusion` stay default-OFF.

---

## 4. GPU evidence queued

One pair appended to `/mnt/wbterminal2/eyeq/queue.jsonl`:

**`A-punchocclusion-holtburg-daylight`** — arms `on` (`&punchOcclusion=on`) / `off`
(default), Holtburg, `cam {fov 60, player 80 35 18 0}`, sky pinned to 13:00 by the runner —
i.e. the never-shot DAYLIGHT town-distance before/after (the best existing pair is a NIGHT
pair). Its assertion is self-selecting per arm: it voids an arm whose
`gates.occlusionGated` / `composer.inputBuffer.stencilBuffer` do not match what that arm's
URL claims, and requires `offered > 0` in both — so an unarmed or empty run cannot be read
as evidence. The pair also asks whether the 2026-08-13 distant-view blackout reproduces on
the ON arm, which is now the only arm that pays the packed-depth allocation.

---

## 5. What I could NOT prove

* **`offered/kept 0/0` under `?portalStencil=on` did NOT reproduce here, and I am not going
  to pretend it did.** That arm needed four attempts to reach in-world (three died on
  `start_session: no CharacterList within 30s (handshake timeout)`, a boot-cost/handshake
  race this 8 GB laptop shows on other arms too — the default arm lost one the same way). On
  the run that did boot, the feed was **84 offered / 12 kept**, gate armed,
  `pass._errored=false`. So on this box, under `?nullRender=1`, the feed is NOT inert in that
  arm. `0/0` also appears transiently in EVERY arm during the first ~8 s of streaming
  (`off` and `punchOcclusion` both read 0/0 before the first cells arrive), which is the most
  likely reading of ba2d371b's observation — a sample taken before the feed warmed. I cannot
  prove that is what happened, and I have not seen the 1070 session it came from.
* **The cell-stealing hazard is a code-reading result, not a measured one.** In the
  `portalStencil` run that booted, `cellContainers3d` was empty the whole window
  (`cellCount: 0`, `movedCells: 0`, stencil pass `cells: 0`), so the scaffold never actually
  parked anything and `PortalStencilPass.hasWork` was false. The layer-2 parking in
  `tickPortalStencil` is unambiguous in source and is a real reason the two mechanisms cannot
  be judged in one arm — but I did not catch it in the act, and the honest claim is
  "structurally incompatible" rather than "observed stealing the punch's cells".
* **No pixels.** SwiftShader cannot judge stencil/depth fidelity and this box has no GPU.
  Whether the gate closes the see-through-the-wall doorways, and whether it wrongly closes a
  SUNKEN/half-buried interior (the failure mode this gate would announce), is exactly what
  the queued pair decides. Nothing here claims the leak is fixed.
* **The 2026-08-13 blackout is still not root-caused.** I did not identify the depth consumer
  that cannot read the packed depth-stencil texture. I only kept the default off that path
  and made the paying arm explicit and nameable.
* **Frame cost of the gate** (a second draw of the aperture mesh + a scissored
  `clearStencil` per frame) is unmeasured. It is bounded by the punch scissor rect, which the
  2026-08-12 session measured at ~1.4 % of the screen, but that is an inherited number, not
  one I took.

---

## 6. Tests

Baseline on `origin/master`: **243 passed / 12 failed / 1 missing (of 258)**.
After, in this worktree: **246 passed / 12 failed / 1 missing (of 261)**.

The 12 FAILs are byte-identical to the baseline list — `test_move_telemetry.mjs`,
`test_a14_i3_run_keys.mjs`, `test_a5_p3_root_motion.mjs`, `test_a14_i2_pursuit_monitor.mjs`,
`test_motion_sequence.mjs`, `test_a11_s5_default_script_spawn.mjs`,
`test_materials_paletted_lru.mjs`, `test_sky_birds.mjs`,
`test_visfid_c4_program_cache_key.mjs`, `test_visfid_p02_detail_material.mjs`,
`test_visfid_p11_normal_gate.mjs`, `test_visfid_p33_csm.mjs` — and the MISSING is the
unchanged `test_p1_alias_split.mjs`. **Zero new failures.**

The +3 passed / +3 run is three suites that existed and which NO runner invoked, now
registered in `harness/run-js-headless.mjs` (they were on the runner's own UNREGISTERED
list at baseline):

* `tests/portal_punch_occlusion_gate.test.mjs` — 10 groups. The gate's own invariants. It was
  protecting nothing while its default was being argued about for two days.
* `tests/portal_clip.test.mjs` — 59 groups. The clip the punch feed calls every frame.
* `tests/portal_punch_occlusion_flag.test.mjs` — 6 groups, NEW. The wiring: the default path's
  zero allocation, `punchOcclusion` not raising the retired scaffold, the strict `=== "on"`
  reader, and the diag reading the gate off the pass.

`node scripts/lint-url-flags.mjs` — clean for the new flag (0 undocumented readers owed docs
rows); `docs/url-flags.md` carries a full `punchOcclusion` row including the allocation
statement above.

---

## 7. Note for lane D at integration

I touched exactly one line inside `tickPortalPunch` (`gates.occlusionGated` in the diag
object) as declared in ACTIVE-LANES. Everything else is in `atmosphere_pipeline.js` /
`index.js` / new files. If D's pass-2 punch feed replaces that diag block, keep the
`occlusionGated` field — it is what tells a paste whether the composer really handed the
pass a stencil attachment, as opposed to whether someone typed the flag.
