# Verification log — orchestrator spot-checks of agent-reported leads

Standing rule: agent findings are hypotheses. Every lead promoted into the work
plan gets its `file:line` re-opened by the orchestrator before it is trusted.
This file records the checks, including the ones that killed a lead.

Result so far: **of the 3 top-ranked wave-1 leads checked, 1 confirmed (with a
corrected count and a bonus finding), 1 killed, 1 severely narrowed.**

---

## PHY-07 — RETRACTED TWICE. Live behaviour is the authority; the symptom is REAL.

**2026-07-26, user report (ground truth): in the live client you can currently
run through doors, trees and rocks.** That contradicts the PARITY-OK verdict
recorded below. The verdict is **withdrawn**; the symptom stands as a real
defect. What follows is the corrected analysis, then the original (wrong)
reasoning kept for the methodology lesson.

### Why code reading said "on" while the client says "off"

This subsystem has **two carriers per feature** (a compile-time const and a
runtime URL-flag carrier), OR'd into an `*_enabled()` predicate, three features
deep, plus data-residency preconditions. Reading any single carrier proves
nothing. Measured state of each:

| Feature | Const carrier | Runtime carrier | Effective default |
|---|---|---|---|
| Faithful transition | `USE_FAITHFUL_TRANSITION = true` (`system.rs:668`) | `?faithfulTransition=on`, exact-`=on` opt-in (`lib.rs:239-242`) | **ON** via the const |
| Faithful outdoor | `USE_FAITHFUL_OUTDOOR = true` (`system.rs:693`) | `?faithfulOutdoor=off` escape | **ON** |
| Entity collision | `USE_FAITHFUL_ENTITY_COLLISION = false` (`system.rs:750`) | default-ON parser (`lib.rs:265-270`) | **ON** via the parser |

So on paper all three layers are active, and `USE_FAITHFUL_OUTDOOR`'s own doc
(`system.rs:686-690`) claims an outdoor pose "floods the sphere-radius land-cell
ring (`add_all_outside_cells_sphere`) and collides against each cell's 2 terrain
triangles → buildings/statics BSP → entities, mirroring decomp
`CLandCell::find_collisions` (acclient.c:354887)". The live client disagrees with
all of that, so **the gap is not in the flags — it is downstream.**

### Leading hypothesis: the collision GEOMETRY never reaches the driver

`SpatialScene::insert_cell_static_physics_bsp` is the only feed for static
collision geometry, it is **keyed by cell id**, and `scene.rs:1607` describes it
as the *indoor* feed. It has exactly **one** production caller,
`apps/holtburger-web/src/lib.rs:15137` (the other four hits are tests and an
example). `faithful_bridge.rs:151-160` frames `statics: Vec<Arc<CellPhysicsBsp>>`
as "the cell's resident STATIC objects' physics BSPs … so static walls/doors/props
stop the mover", again cell-scoped.

Outdoor scenery — trees, rocks — are not env-cell residents. If no outdoor land
cell ever gets a static BSP staged, the faithful outdoor path collides terrain
triangles and nothing else, which matches the report exactly: **terrain holds you
up, scenery does not stop you.** Note also two stale-looking doc lines in
`faithful_bridge.rs:12` ("Static / object collisions are identity (Phase C)") and
`:26` ("OUTDOOR poses delegate to the existing heightfield pipeline") that
contradict the Phase-D const docs — at least one of the two doc sets is lying,
which is itself a finding.

Ruled out: **stale wasm.** `pkg/holtburger_web_bg.wasm` is 2026-07-26 03:33 and
the only newer Rust source is `apps/holtburger-web/src/lib.rs`; the collision
consts live in `holtburger-core`, which is older than the build.

Not yet explained: **doors.** A live functional block at the Holtburg grocer door
`0x7A9B401F` was measured on 2026-07-20 (`lib.rs:250-253`). If doors no longer
block, something regressed in the 07-20 → 07-26 window — which contains the
threads work (`pkg.bak-pre-threads-2026-07-24`) and the shard/stream work
(`pkg-s3w`, `pkg-shards`, `pkg-prof`, 07-23…07-25). That window is the place to
bisect.

### Next step is a measurement, not more reading

Cheapest decisive test: headless with `?nullRender=1` (sim and drain still run)
against the local ACE, walk into a known tree/rock and a known closed door, and
read the static-BSP residency counters — i.e. does
`cell_static_physics_bsp` hold anything for the landblock under the player. That
distinguishes "driver never consulted" from "driver consulted, geometry empty".
Until that runs, PHY-07 is **OPEN, cause unconfirmed**, and must not be filed as
either a flag flip or a parity row.

### Original (wrong) verdict, kept for the lesson

The reasoning below was internally sound and still reached a false conclusion,
because it stopped at the first carrier that explained the const and never asked
whether the feature actually works in the client. **A flag audit is not a
behaviour test.**

## PHY-07 — the withdrawn PARITY-OK reasoning

**Agent claim (ranked #1 of 66):** `USE_FAITHFUL_ENTITY_COLLISION = false`
(`crates/holtburger-core/src/client/movement/system.rs:750`) means the player
walks through closed doors and other players; "code is written, only the flag
flip remains, effort S."

**Verified:** the const is indeed `false` at `system.rs:750`. But the effective
gate is `USE_FAITHFUL_ENTITY_COLLISION || self.faithful_entity_collision_runtime`
(`system.rs:2806`), and the runtime arm was **promoted DEFAULT-ON on 2026-07-20**.
`parse_faithful_entity_collision_flag` (`apps/holtburger-web/src/lib.rs:265-270`)
returns `true` UNLESS the literal `faithfulEntityCollision=off` appears in the
query string. Entity collision is therefore **already on** in every normal boot.

The doc comment at `lib.rs:260-263` states the design explicitly: *"Native
carrier stays `false` (`USE_FAITHFUL_ENTITY_COLLISION`, movement/system.rs) so
this parser is the single default authority and `=off` genuinely disables."*

**Flipping the const would break the `=off` escape**, making the arm
impossible to disable for A/B work. The promotion evidence is already on record
at `lib.rs:246-253`: offline A/B suite (`system/tests.rs mod
faithful_entity_collision` — flag-off walks through a closed door, flag-on stops
at the cylinder, ethereal door passes), hours of live stream soak, and a live
functional block at the Holtburg grocer door `0x7A9B401F` (run-forward stopped
~0.95 m short of the door plane with lateral cylinder slide).

**Disposition: PARITY-OK, not TASK.** Root cause of the error: the agent read
the compile-time const and stopped, without following the `||` to the runtime
arm. Lesson added to later wave prompts: *a `false` const is not evidence a
feature is off — find the effective gate.*

---

## OBJ-20 — SEVERELY NARROWED. Cited line is test code.

**Agent claim (ranked #2 of 66):** CharacterOptions default to `empty()`
(`apps/holtburger-web/src/lib.rs:18100`) instead of retail's
`0x50C4A54A`/`0x948700`/`0x3FFF`, so "every option boots OFF, allegiance chat is
muted and confirmations behave inverted." Effort S.

**Verified:** `lib.rs:18100` is inside
`holtburg_test_player_description_hydrates_run_skill_into_late_world` — a
`#[wasm_bindgen]` **test harness function** building a synthetic
`PlayerDescriptionEventData`. It is not a production default. Of the 9
`CharacterOptions{1,2}::empty()` sites in the tree, 6 are in `*tests.rs`.

The one production site is `PlayerState::new()`
(`crates/holtburger-world/src/player/types.rs:1718-1719`) — and it is
immediately overwritten in real play: `hydrate_from_player_description`
(`crates/holtburger-world/src/player/mutations.rs:415`) assigns
`self.options1 = data.options1; self.options2 = data.options2;` at `:425-426`
from the server's wire message. Against vanilla ACE the character's real options
come from the shard DB, so "allegiance chat is muted" does not describe the
normal path.

**What survives as a real (smaller) task:** the pre-`PlayerDescription` window
reads all-OFF, so any consumer that samples options during boot sees wrong
values; and if our own character-creation path ever mints a character
client-side it should seed retail's documented defaults rather than `empty()`.
Re-scope to **S, low priority**, and re-file under the boot-ordering bucket
rather than the options bucket.

Root cause: cited a grep hit without checking whether the enclosing function was
production or test. This is the second time a wave-1 agent's `lib.rs` citation
misled (the first was dropped leading digits in 5-digit line numbers).

---

## NET-01 — CONFIRMED, with a corrected count and a worse bonus finding.

**Agent claim (ranked #1 of 52):** the optional-header cursor lacks 7 of 20 wire
flags; any packet carrying one mis-offsets everything after it, fails checksum,
and is dropped with only a `log::debug!`.

**Verified against the doc's authority table** (`02-networking.md:64-100`, drawn
from the `COptionalHeaderAllocatorTemplate<MASK,T>` instantiations and
`OptionalHeaderFlags` at acclient.h:4807-4817) **and our cursor**
(`crates/holtburger-session/src/optional_header.rs:59-141`, 12 flags handled)
**and our flag constants** (`crates/holtburger-protocol/src/messages/transport.rs:34-50`,
18 defined).

The cursor handles 12: ServerSwitch `0x100`, NAK list `0x1000`, EmptyAck list
`0x2000`, PAK `0x4000`, LogonHeader `0x10000`, ConnectRequest `0x40000`,
ConnectResponse `0x80000`, ICMD `0x400000`, TimeSync `0x1000000`, EchoRequest
`0x2000000`, EchoResponse `0x4000000`, Flow `0x8000000`.

**Genuinely missing — 5, not 7:**

| Mask | Header | Retail payload | Consequence |
|---|---|---|---|
| `0x200` | LogonServerAddr | `sockaddr_in`, flags 7 | cursor mis-offsets |
| `0x800` | **Referral** | `CReferralStruct`, flags `0x40000062` (signed \| countsAsTouch \| highPriority \| exclusive, acclient.h:41949) | cursor mis-offsets |
| `0x20000` | WorldLoginRequest | `u64` cookie, flags 7 | const IS defined but cursor never advances it |
| `0x100000` | NetError | `CPackObjHeader<NetError,…,7>` | no const at all |
| `0x200000` | **NetError-Disconnect** | `CPackObjHeader<…,2>` | no const at all — see below |

The agent's count of 7 apparently included `RETRANSMISSION 0x1`,
`ENCRYPTED_CHECKSUM 0x2`, `BLOB_FRAGMENTS 0x4` — these are payload-less modifier
bits that correctly do not advance the cursor. Not gaps.

**Bonus finding the agent missed, and it is worse than the original claim.**
Our `DISCONNECT: u32 = 0x00008000` (`transport.rs:41`) is a misnomer. The doc is
explicit: `0x8000` is an unnamed **payload-less header that is never sent or
handled** — it appears only in its two `CreateFromStream` bodies (acclient.c:468686,
468710) and two registrations (801015-801016), and *"earlier drafts named
`0x8000` 'Disconnect'; that name is not supported by anything in the binary."*
The **actual wire disconnect signal is `0x200000` NetError-Disconnect**, handled
at acclient.c:370725 and 372714 — which we do not define at all.

So we are watching a bit that never arrives and are blind to the one that
signals a real server-initiated disconnect. This plausibly relates to NET-03's
in-world-ghost symptom and should be investigated together.

**Disposition: TASK confirmed, promote. Split into NET-01a** (add the 5 missing
headers to the cursor, with sizes from the table above) **and NET-01b** (rename
`DISCONNECT` → the payload-less `0x8000` unnamed header or delete it, and
implement `0x200000` NetError-Disconnect as the real signal). Validation: the
existing `optional_header.rs` unit tests (`:144-186`) already exercise
offset arithmetic — extend them per flag — plus a live packet capture against
ACE. NET-01b needs a live disconnect (server-side kick) to confirm.

---

---

## CONSEQUENCE: 55 of 89 physics PARITY-OK rows are now suspect

Agent A's headline conclusion was that holtburger "already carries a
decomp-faithful `CTransition` port (17.4k lines across 36 files) which is **live
and default-on** for the local player", and it dispositioned most of physics §3
as PARITY-OK on that basis (`wave1-A-physics-objectmodel.md:12`, `:855`). The
const genuinely is `true` — but "the code is default-on" is not the same claim as
"the behaviour is correct in the client", and the live report proves the two came
apart.

**89 PARITY-OK rows exist in that file; 55 mention `transition` or `faithful`.**
Every one of those rows was justified by reading a dormant-or-broken path's
source, so none of them is established. They are not necessarily *wrong* — the
port may be correct and merely starved of geometry — but they are **unproven**.

Action: all 55 are re-dispositioned **VERIFY-LIVE** and excluded from the work
plan's "already at parity" column until a live test covers them. Do not delete
them; the source reading is still useful evidence, it just is not a verdict.

## New disposition for all remaining waves: VERIFY-LIVE

Added to the wave prompt vocabulary alongside TASK / PARITY-OK / N/A-WEB /
REF-ONLY:

> **VERIFY-LIVE** — the holtburger source appears to match retail, but the claim
> is about runtime *behaviour* (collision, movement, rendering output, audio,
> netcode) and has not been observed in a running client. Cite the source, state
> what you would expect to see live, and name the specific check that would
> confirm it. PARITY-OK is reserved for claims provable by reading alone
> (constants, formulas, wire field order, enum values, data layout).

Rationale, in the user's words: *"some of our automated stuff arrives as false
conclusions."* An agent reading source can only ever establish what the code
says. Three of four top-ranked wave-1 leads checked so far were wrong in a way
that source reading could not have caught — two by over-claiming a defect, one by
over-claiming parity.

## Method notes for later waves

- **Ripgrep `-r` footgun bit the orchestrator too.** `rg -rn 'SYMBOL' path`
  makes `-r`/`--replace` substitute matches with the literal `n`, printing
  `const n: bool = false;` for what is actually
  `const USE_FAITHFUL_ENTITY_COLLISION: bool = false;`. Plain `rg -n` only.
  MEMORY.md already warns about this ("never pass `-rln`"); the two-letter form
  `-rn` is the same trap and is easy to type by accident.
- Confirmed-good agent behaviour worth preserving: agent B **self-corrected** a
  false positive on `AtlatlCombat = 0x8000013b` by era-checking the shipped
  `client_portal.dat` and ACE against the 2013 doc's `0x138`. That check is now
  a standing instruction in every wave prompt.

---

## COL-03 — PREMISE REFUTED BY BISECT (2026-07-27). Not a regression; the door block never worked except head-on.

The work plan filed P0.2 as "doors blocked on 07-20 and do not now — bisect the
one-week window." The bisect ran (isolated rig, `/mnt/wbterminal2/door-bisect-2026-07-27/`,
seven pkg builds 07-20 → current, movement-gated probe at the Holtburg grocer
door `0x7A9B401F`): **every arm BLOCKED the head-on approach**, stop-gap
0.80-0.88 m, including the current live build. `?faithfulEntityCollision=off`
passes through (control), so the stop is the door-entity arm. No regression
exists; no era-matched JS was ever needed; no suspect commit.

**The real defect:** the door's collider is a swept **circle at the door's
origin** (`entity_collision.rs:120-126`, explicit `TODO(acclient.h gap)` — the
`has_physics_bsp` arm reduces to circle-vs-circle). Head-on, axis-locked
approach ⇒ slide component exactly 0 ⇒ block holds. Any lateral offset ⇒ the
tangent slide walks around the circle: at ±0.45 m from the door origin the
probe ended **inside the shop** (env-cell `0x16A`) in ~1 s. The 07-20
`d41b9143` "live functional block" measured the one degenerate geometry, as
does the offline A/B in `system/tests.rs` — both pass while the feature is
broken in the general case. The user's COL-03 = NO is the general case.

Two traps for the fixer, verified against DAT `0x020019FF` via
`chorizite-parse-dat-record`: the door Setup's physics sphere is r 0.1 at the
base — letting `setup_collision_radius` populate would *shrink* the block, not
fix it; and the `selectionSphere` (r 0.892) sits at the **hinge** (0, 0.06,
1.35), a live COL-22 lead (far-side leaf clicks miss). Fix = implement the BSP
arm (`StaticPartBsp` machinery already exists and is `any(wasm32, test)` since
`d41b9143`); regression test MUST use a ±0.45 m offset approach, never the
head-on one.

---

## OQ-3 — SETTLED LIVE (2026-07-27). Base run speed is CORRECT; COL-09's premise refuted. The walk defect is real and is COL-10's likely root cause.

Retail formula verified at `acclient.c:713790` (`GetRunRate`), `:296777`
(`LoadMod`), `:343539` (`get_state_velocity`): run speed = `LoadMod·11·s/(s+200) + 4` m/s.
Ours is formula-identical (`holtburger-world/src/context.rs:130-152`). Live,
movement-gated: a fresh run-skill-105 character measures **7.785 m/s median vs
7.78689 expected (0.02%)**. Tier 3 judgements may proceed on this baseline.
Caveat: skill ≥ 800 runs +21% vs retail by *deliberate* ACE-matching
(`RETAIL_RUNRATE_EDGE=false`, retail spikes only at `==800`) — do not "fix"
client-only.

**WALK is broken and self-inconsistent (likely COL-10):** the DAT's WalkForward
cycle derives a body speed of **2.6017 m/s** (anim `0x03000003`: 36 frames, net
+Y 1.4, fps 66.9 — derivation validated by RunForward reproducing exactly 4.0),
and the body uses it (`common.rs:844`), but `stateGroundSpeed` returns retail's
`WalkAnimSpeed 3.1199999` (`lib.rs:6691`), so `cycleTimeScale` plays the walk
clip **1.199× faster than travel** (foot-slide); backstep timescale 0.78 vs
correct 0.65. Measured live: walk = 2.6027 m/s. This is a FORK, not a typo —
either the body adopts retail's 3.12 (matches ACE's server model) or
stateGroundSpeed adopts the DAT-derived base; opposite client/server-skew
implications. Needs a decision before Tier 3's COL-10 work.

Secondary lead: `scene3d/camera.js:1772` uses `FALLBACK_RUN_RATE_SCALAR ?? 4.5`
as a flat camera-prediction *speed* (defined `index.html:5882` "= 4.5; // m/s");
Rust retired exactly this 4.5→1.0 (`lib.rs:36697-36707`), the JS copy did not.

Harness facts: `?renderOnDemand=1` prevents `window.liveScene3d` from ever
being assigned (probed twice) — omit it from headless runs needing wasm
getters; `playerRunRateInputs`/movement-trace getters are absent from the
`init3D` bag (the P5.1-class instrumentation gap, again).

---

## RQ-08 — NOT a flag promotion (2026-07-27). Do not flip surfaceParityV2.

The premise "retail's alpha-test refs are behind the strict opt-in" fails four
ways: (1) every parityV2 branch is called only from `surfaceUnified`-gated
sites, itself default-OFF — flipping parityV2 alone is a no-op; (2) the default
ladder ALREADY alpha-tests foliage at 0.5 (`materials.js:3523-3527`); (3)
retail's paletted ref is 100/255 ≈ **0.392** (`acclient.c:454499-454511`,
constants `:45764-45765`) — *looser* than 0.5, so promotion keeps MORE fringe;
(4) `static_atlas.js:426` hard-resets alphaTest to 0.5 and buckets on a boolean,
so merged props can't carry per-surface refs anyway. The genuinely
unimplemented retail behavior is different: ClipMap sets
`SetAlphaBlendEnable(1)` (src/dst 2/6) *alongside* the test; our default path
sets `transparent = false`. Recommended: split the ClipMap ref+blend piece onto
the legacy ladder + static_atlas (hasPalette census first); leave fog/InvAlpha
behind the flag. `docs/url-flags.md:235` "inert until M3a wasm rebuild" is
stale — `SurfacePixels.hasPalette` is live in shipped pkg.

### COL-03 fix live-validated (2026-07-27, bisect rig, release wasm 4,947,300 B)

- **−0.45 m lateral: BLOCKED** at y 33.09 (was: through the circle into the
  shop at y 37.79). Slide runs along the leaf (endX drifts west), never crosses
  the plane.
- **+0.45 m lateral: no longer enters the shop** — the mover slides NE along
  the leaf, comes off the leaf's NE end (~82.36, 34.30), and continues over
  outdoor terrain to y 67 without ever entering an interior cell. This is the
  **doorframe/building-geometry gap** the implementation report predicted: past
  the leaf's end nothing catches the mover. Separate pre-existing defect, filed
  as follow-up; not the entity-BSP arm.
- Head-on: still blocked (y 32.75 in this run — circle-arm value; the run
  predates full geometry residency, and the lateral runs that followed show the
  BSP arm live).
- `collisionResidencyDiag` confirmed live in probe output (staticAabbs 234,
  cell physics 123/123/123).

---

## camera.js flat prediction speed — FIXED, but the premise's *impact* is refuted: the code is DEAD (2026-07-27)

Handoff task 5. Cited `camera.js:1772`, `index.html:5882`, `lib.rs:36697-36707`.

**Citations re-opened** (two of three were off): `scene3d/camera.js:1772` correct
(`const RUN_SPEED = consts.FALLBACK_RUN_RATE_SCALAR ?? 4.5;`);
`index.html:5882` correct (`const FALLBACK_RUN_RATE_SCALAR = 4.5;  // m/s`);
the Rust retirement is **`src/lib.rs:36846-36903`**, not `:36697-36707`.

**What Rust actually did** — it did *not* neutralize a scalar to 1.0 and stop
there, it **split** the conflated 4.5 into its two real factors:
`FALLBACK_RUN_RATE_SCALAR: f32 = 1.0` (`lib.rs:36856`, retail `my_run_rate`
initial) and the 4.5 **m/s** kept as `base_run_forward_velocity.y` in
`fallback_self_movement_capabilities()` (`lib.rs:36885-36889`). Run speed is
their product — `SelfMovementCapabilities::resolved_manual_run_speed()`
(`crates/holtburger-world/src/state/self_movement.rs:104-107`), consumed by
`forward_axis_speed` (`movement/common.rs:841`).

**The bug is real.** `RUN_SPEED = FALLBACK_RUN_RATE_SCALAR` fed a dimensionless
multiplier into an m/s slot; had anyone synced the JS constant to Rust's
retired 1.0 the camera would have predicted at 1 m/s.

**But it can never fire.** `_advancePrediction` was retired from the runtime on
2026-06-29 — `tick()` (`camera.js:981-995`) calls only `_smoothToIntegrator`,
and the banner at `camera.js:1567-1578` says "DO NOT re-wire them into the
runtime". Only the `.mjs` A/B harnesses still call it. The 2D sprite predictor
it mirrors (`index.html:9604-9703`) is equally unreachable: **`entityMap` has
zero `.set()` callers in `index.html`**, so `entityMap.get(guid)?.sprite` is
always undefined. Both predictors are dead. Fix landed anyway (zero-risk,
kills the cross-read trap of one name meaning 4.5 m/s in JS and 1.0
dimensionless in Rust) — but **no live behaviour changed**, and the sawtooth /
speed items in Tier 3 get no credit from it.

**Changes** (JS only, no wasm rebuild, uncommitted):
- `index.html` — `FALLBACK_RUN_RATE_SCALAR = 4.5 // m/s` renamed
  `BASE_RUN_FORWARD_SPEED = 4.5 // m/s`; `window.__movementConstants` now
  exports `BASE_RUN_FORWARD_SPEED` and **deliberately drops** the old key (a
  stale service-worker-cached reader would otherwise multiply 4.5 × 4.5).
- `scene3d/camera.js` — `RUN_SPEED = BASE_RUN_SPEED × runRateScalar`, the
  scalar read from `SessionHandle.player_run_rate()` (confirmed present in the
  shipped `pkg/`: `holtburger_web.js:10391`, `d.ts:4981`), feature-detected and
  seeded to the same 1.0 Rust uses. Pre-stats this is byte-identical to the old
  flat 4.5, so the `.mjs` harnesses' 4.5 m/s expectations still hold.
- `index.html` 2D predictor — same bug, same fix: `speed = run ?
  BASE_RUN_FORWARD_SPEED * playerRunRate() : WALK_FORWARD_SPEED`. The old line
  used the bare `playerRunRate()` as m/s; that read ~4.5 when Rust's fallback
  was 4.5 and silently became ~1.0 when Rust retired it — a latent 4× under-run
  had the block been reachable.
- Three `.mjs` mocks renamed to the new key (same value, same expectations).

**Pre-existing breakage noticed, NOT touched:** `smoke_test.cjs:4885`'s
`hasTickChain` regex still requires `_reconcilePrediction … _advancePrediction
… _applyPredictionLerp` inside `tick()` — that chain was removed 2026-06-29, so
the "Workstream B" smoke check has been failing since then and is asserting a
contract the codebase deliberately reversed. `test_workstream_b_prediction.mjs`
also fails to run at all (`Cannot use import statement outside a module` from
its `new Function` shim) — verified pre-existing by stashing the edits.
`fixtures/physics/probe-scenario.json:22,58` still describes
`FALLBACK_RUN_RATE_SCALAR=4.5 m/s` with a stale line cite.

---

## RND-08/33 — ClipMap alpha parity LANDED (2026-07-27). Premise half-refuted: the blend is ONE/INVSRCALPHA, not SRCALPHA/INVSRCALPHA.

Handoff task 4, the replacement for the RQ-08 flag flip (see §RQ-08 above).
Cited `acclient.c:454497-454511`, `materials.js:3523-3527`, `static_atlas.js`,
`url-flags.md:235`.

**Citations re-opened.** `D3DPolyRender::SetSurface(CSurface*, bool, bool, bool)`
starts at `acclient.c:454385` (not 454497); the ClipMap arm is
`:454496-454511` and the state flush is `:454541-454550`. The legacy ladder is
`materials.js:3523-3527` — correct. `static_atlas.js:426` — correct. A **third**
legacy ClipMap site the plan did not name: `entities.js:5187-5191`
(`_applyPalettedSurfaceRenderState`, the recoloured/paletted ladder), same
hardcoded 0.5.

**Decomp evidence** (`rg -a`, CRLF-safe; `enum BlendMode` = `acclient.h:5193`,
`enum SurfaceType` = `acclient.h:5820`, `BASE1_CLIPMAP = 0x4`):

```c
  if ( Render::curr_surface_type & 4 && !overrideClipmap )
  {
    if ( !v11 )                       // no earlier bit already enabled blending
    {
      v9 = 2;                         // src = BLEND_ONE      (acclient.h:5196)
      v10 = 6;                        // dst = BLEND_INVSRCALPHA (acclient.h:5200)
    }
    if ( !Render::curr_texture_is_set || (v12 = D3DPolyRender::s_256AlphaTestRef, !curr_texture->m_pPalette) )
      v12 = D3DPolyRender::s_ddsAlphaTestRef;
    v11 = 1;
    testRef = v12;
    surfacea = 1;                     // → SetAlphaBlendEnable(1)
    singlePassDetailinga = 1;         // → SetAlphaTestEnable(1)
  }
  ...
  curr_texturea = singlePassDetailinga || !v11;            // depth-WRITE enable
  RenderDeviceD3D::SetAlphaTestEnable ((RenderDeviceD3D *)v4, singlePassDetailinga);
  RenderDeviceD3D::SetAlphaTestRef    ((RenderDeviceD3D *)v4, testRef);
  RenderDeviceD3D::SetAlphaTestFunction((RenderDeviceD3D *)v4, ALPHATESTFUNC_GREATEREQUAL);
  RenderDeviceD3D::SetBlendFunction   ((RenderDeviceD3D *)v4, v9, v10, BLENDOP_ADD);
  RenderDeviceD3D::SetAlphaBlendEnable((RenderDeviceD3D *)v4, surfacea);
  RenderDeviceD3D::SetDepthBufferMode ((RenderDeviceD3D *)v4, v14, curr_texturea);
```

```c
__int32 D3DPolyRender::s_256AlphaTestRef = 100;   // acclient.c:45764
__int32 D3DPolyRender::s_ddsAlphaTestRef = 200;   // acclient.c:45765
```

**PREMISE REFUTED (the blend factors).** The task and `wave2-C` R52 both read
"src/dst 2/6 = SRCALPHA/INVSRCALPHA". `enum BlendMode` (`acclient.h:5193-5211`)
is **not** D3DBLEND: `BLEND_ZERO = 1, BLEND_ONE = 2, BLEND_SRCCOLOR = 3,
BLEND_INVSRCCOLOR = 4, BLEND_SRCALPHA = 5, BLEND_INVSRCALPHA = 6`. So 2/6 is
**ONE / INVSRCALPHA** — premultiplied-alpha "over", not the classic alpha blend.
Cross-checked against the same function's ALPHA arm (`:454471`: `v9 = 5, v10 = 6`
= SRCALPHA/INVSRCALPHA), which confirms 5 is SRCALPHA and confirms arg order is
(src, dst). Consequence: for the alpha=255 interior the blend is a no-op
(identical to opaque); only bilinear-filtered edge texels composite, and because
the source colour is not premultiplied they read slightly BRIGHTER than a
correct over — which is the retail look.

**Depth writes stay ON** — `SetDepthBufferMode`'s write arg is
`singlePassDetailinga || !v11`, and the ClipMap arm sets alpha-test-enable to 1.
So retail's ClipMap is "blend-enabled but z-writing", not a sorted transparent.

**hasPalette census** (2026-07-27, `~/ac_base_dats/client_portal.dat`, via
WorldBuilder.Terminal `chorizite-list-dat-records` + `chorizite-parse-dat-record`
over Surface → SurfaceTexture → highest-res RenderSurface):

| | count |
|---|---|
| Surface (0x08) records total | 6,152 |
| carrying `Base1ClipMap` (0x4) | **721** |
| … paletted (`PFID_INDEX16`) → ref 100/255 = 0.392 | **518** |
| … non-paletted → ref 200/255 = 0.784 | **203** |

Non-paletted breakdown: DXT5 97, A8R8G8B8 71, DXT1 27, DXT3 5, A4R4G4B4 2,
R8G8B8 1. Zero ClipMap surfaces have `origTextureId == 0`, and every chain
resolved (673 unique SurfaceTextures → 671 unique textures, 0 parse failures).
So the shipped 0.5 was wrong for **both** classes — too tight for the 518
paletted majority (foliage/fences cut MORE than retail) and far too loose for
the 203 DDS ones. By flag combination: 640 pure ClipMap, 27 +Translucent,
22 +Alpha, 19 +Alpha+Additive, 12 +Additive, 1 +Translucent+Alpha+Additive.

**`SurfacePixels.hasPalette` is LIVE** — `src/lib.rs:8824-8825`
(`#[wasm_bindgen(getter, js_name = hasPalette)]`), present in the shipped
`pkg/holtburger_web.d.ts:6681` and `pkg/holtburger_web.js:13400`. The
`url-flags.md` claim that this half was "inert until the M3a wasm rebuild lands"
was stale and has been corrected.

**Changes** (JS only, no wasm rebuild, uncommitted):
- `scene3d/materials.js` — new shared `applyClipMapRenderState(target, hasPalette)`
  + `readClipMapParityMode()` (`?clipMapParity`, DEFAULT-ON; `=ref` takes the ref
    without the blend, `=off` restores the exact pre-RND-08 state). Writes
    `alphaTest` = per-format ref, `CustomBlending` One/OneMinusSrcAlpha/Add,
    `transparent = true`, `depthWrite = true`. `hasPalette` keeps its strict
    boolean-or-undefined fail-soft (stale pkg → 0.5).
- `scene3d/materials.js` — both ladders now call it: the legacy `_materialFromFlags`
  arm (was `alphaTest = 0.5; transparent = false`) and the unified
  `applySurfaceRenderState` arm. The ref thereby **graduated out of
  `?surfaceParityV2`**, which now guards only (b1) additive fog exemption and
  (b3) true INVALPHA blend.
- `scene3d/entities.js` — the third ladder (`_applyPalettedSurfaceRenderState`)
  calls the same helper, so a recoloured clipmap body (dolls, Virindi) decodes
  identically to its un-recoloured twin.
- `scene3d/static_atlas.js` — the bucket key collapsed the members' state to
  `alphaTest > 0 ? 0.5 : 0` and ignored blending, which would have silently
  re-cut every atlased foliage prop at 0.5. Replaced with `_stateKeyOf` /
  `_applyStateKey` (transparent · exact ref · depthWrite · blend factors), in
  both the per-LB and cross-LB paths. Cross-LB buckets keep
  `sortObjects = false` when `alphaTest > 0` so the new `transparent = true`
  does not buy a per-frame instance sort for foliage.
- `scene3d/bake_prewarm.js` — comment only (its `alphaTest ∈ {0, 0.5}` axis still
  covers the USE_ALPHATEST fork; three carries the ref as a uniform).
- `docs/url-flags.md` — stale "inert until M3a" note replaced with the graduation
  note; new `clipMapParity` row.
- `test_f7_8_surface_bitfield.mjs` — Stage 3 + 6.3 updated to the new contract,
  new Stage 7 (mode reader, full/ref/legacy arms, blend factors, depthWrite,
  Translucent-still-wins). **79/79 green**, including the untouched A10-M3b
  regression lens (210/210) and the three-path equality checks.

**Sorting implication (accepted).** `transparent = true` moves clipmap draws into
three's transparent list — rendered after opaque and painter-sorted. Correctness
is unaffected (z-writes stay on; surviving texels are ~opaque), and the atlas
opt-out above removes the only measurable cost found by inspection. A second
consequence: `applyRetailSinglePass` triggers on `transparent && DoubleSide`, so
clipmap surfaces now also take retail's one-draw-per-surface path — which is the
retail behaviour, not a regression.

**Residual, NOT fixed (new finding, needs its own eye-test).** Retail applies the
ClipMap alpha test *on top of* the blend ladder, so `ClipMap+Alpha` (22 surfaces)
and `ClipMap+Additive` (31 incl. +Alpha) also get the alpha test **and keep
depth writes**, whereas our `else if` ladder lets the Alpha/Additive arms swallow
them (no alpha test, `depthWrite = false`). `ClipMap+Translucent` (27) is
correct as-is: retail's Translucent block (`:454512-454522`) fires when
`singlePassDetailinga == 1` and resets to SRCALPHA/INVSRCALPHA with the alpha
test **off**, which is exactly what our Translucent branch does. Adding the test
to the additive arms would clip 31 spell-glow surfaces at 0.392/0.784 — a visible
change that should be measured, not assumed.

**1070 eye-test owed** (queue with handoff task 3b): foliage/fence cutout fringe,
three arms — default (ref+blend) vs `?clipMapParity=ref` vs `?clipMapParity=off`.
Look for (a) the 518 paletted clipmaps cutting LOOSER than before (0.392 < 0.5 —
more fringe kept, e.g. leaf silhouettes fuller), (b) the 203 DDS ones cutting
TIGHTER (0.784), (c) no dark/bright halo box around foliage from the ONE/INVSRCALPHA
edge composite, (d) no draw-order artefacts now that foliage is in the transparent
pass, (e) `window.__atlasStats()` still bucketing (new `stateKey` field) and fps
not regressing from the atlas change.

---

## COL-10 — DECIDED, FIXED, LIVE-VALIDATED (2026-07-27). Option 1: the BODY adopts retail's `WalkAnimSpeed` 3.1199999 m/s.

**Decision (user).** The walk fork opened in §OQ-3 resolves in favour of the
retail/ACE model: the player body walks at the `WalkAnimSpeed` constant, and the
DAT's authored walk-cycle base (2.6017 m/s) is demoted to what it always was —
the *animation's* authored speed, i.e. the `cycleBaseSpeed` denominator of the JS
`cycleTimeScale`.

**Decomp anchor.** `~/ac-headers/acclient.c:343539` `CMotionInterp::get_state_velocity`;
walk arm at `:343561`:

```
if ( v5 == 1157627909 )        // 0x45000005 WalkForward
  v6 = 3.1199999 * this->interpreted_state.forward_speed;
else if ( v5 == 1140850695 )   // 0x44000007 RunForward
  v6 = 4.0 * this->interpreted_state.forward_speed;
```

ACE mirrors it (`MotionInterp.cs:684-685`), so adopting 3.1199999 REMOVES
client/server skew rather than adding it. RUN needed no change: the authored run
cycle base IS 4.000, the same number retail hardcodes (§OQ-3: 7.785 vs 7.787).

### Where the body speed actually came from (all citations re-opened)

The handoff's `common.rs:844` is real but is the **legacy** lane.
`USE_INTERPRETED_VELOCITY = true` (`system.rs:559`), so the LIVE source is
`interpreted_velocity_for_state` (`motion_interp.rs:1800` pre-edit), which passed
`capabilities.base_walk_forward_speed()` as `ground_velocity`'s walk base. That
accessor (`holtburger-world/src/state/self_movement.rs:36,96`) is
`base_walk_forward_velocity.length()`, sourced from the DAT MotionTable's
WalkForward `MotionData.velocity` (`self_movement.rs:261,308-313`). Three call
sites read it: the legacy lane (`common.rs:842,844,847`), the live interpreted
lane (`motion_interp.rs:1801`), and the autonomous MoveTo lane
(`system.rs:4041`).

### Edits (holtburger-core only — the DAT kinematics struct stays honest)

1. `movement/motion_interp.rs:1831` — `interpreted_velocity_for_state` passes the
   existing `pub(crate) WALK_ANIM_SPEED` const (`:205`) as the walk base; the run
   base still comes from the DAT.
2. `movement/common.rs:854-858` — `forward_axis_speed`'s three walk arms
   (walk-forward, walk-backstep, run-backstep) use `WALK_ANIM_SPEED`; imported at
   `common.rs:3`.
3. `movement/system.rs:4047` — autonomous MoveTo Walk arm likewise.
4. Docs/tests re-pinned: const doc `motion_interp.rs:191-204`, `ground_velocity`
   contract `:588-606`, gate doc `system.rs:541-546`,
   `velocity_contract_walk_uses_authored_2_602_base` →
   `..._uses_retail_walk_anim_speed` (`:2085`), diagonal test `common.rs:1093`.

No literal was duplicated — all three sites reference the one const.
`base_walk_forward_velocity` still carries DAT truth, it just no longer drives the
body. (The web crate keeps its own `WALK_ANIM_SPEED` copy at `lib.rs:36840` with
the identical value; unifying it needs cross-crate visibility work, not done.)

### The anim timescale needed NO change — and the handoff's "0.78 vs correct 0.65" inverts

`cycleTimeScale(actual, base)` = `stateGroundSpeed / cycleBaseSpeed`
(`animation.js:355`, fed at `entities.js:12977`). `stateGroundSpeed` already
returned 3.1199999 for walk (`lib.rs:7077`) and `3.1199999 × −0.65 = 2.028` for
backstep; `cycleBaseSpeed` is the authored 2.6017 (`lib.rs:6672-6689`).

| gait | body speed (post-fix) | clip base | timescale |
|---|---|---|---|
| walk fwd | 3.1200 | 2.6017 | 1.199x |
| backstep | 2.0280 | 2.6017 | 0.779x |

Both are now CORRECT: the feet track travel because the body finally moves at the
speed the timescale was already derived from. "Backstep timescale 0.78 vs correct
0.65" was the **option-2** target (body keeps 2.6017 → backstep 1.691 → 0.65x);
under the adopted option 1, 0.78 is right and 0.65 would be the regression.
`BACKWARDS_FACTOR` was already the correct `0.649_999_98`.

### Sidestep — checked, NOT the same bug, unchanged

`sidestep_axis_speed` (`common.rs:870-880`) and the interpreted lane already
derive from the constant: `adjust_motion` scales by
`SIDESTEP_FACTOR × (WALK_ANIM_SPEED / SIDESTEP_ANIM_SPEED) = 0.5 × 3.1199999/1.25
≈ 1.248`, `get_state_velocity` converts via `SidestepAnimSpeed = 1.25` → walk
strafe 1.56 m/s, run strafe `min(1.248 × run_rate, 3.0) × 1.25 ≤ 3.75`. That chain
never touched the DAT walk base (fixed by F1-2, 2026-06-09), so the fork did not
reach it.

### Live validation (release wasm 4,947,030 B, `:8765`, `?nullRender=1`, account `doorbisect1`)

Rig: `/mnt/wbterminal2/col10-speed-2026-07-27/` (`launch.sh` CDP :9336,
`speed_probe.cjs` / `probe2..4.cjs`, `results-*.json`). In-page 50 ms pose
sampler (so CDP round-trip jitter never enters the timebase); speed = LS slope of
cumulative path vs time over a steady window, movement-gated on displacement.

All six arms of the definitive run (`results-probe4c.json`, ONE teleport then
keyboard-only, every arm movement-gated and `__bootState == 'in-world'`):

| arm | keys | fit m/s | path÷t | median | target | pre-fix (§OQ-3) |
|---|---|---|---|---|---|---|
| walk forward | `shift+W` | **3.096** | 2.973 | 3.177 | 3.1200 | 2.6027 |
| walk forward (repeat) | `shift+W` | **3.094** | 2.996 | 3.005 | 3.1200 | 2.6027 |
| walk backstep | `shift+S` | **2.031** | 1.950 | 1.936 | 2.0280 | 1.691 (implied) |
| walk backstep (repeat) | `shift+S` | **2.032** | 1.959 | 2.026 | 2.0280 | 1.691 (implied) |
| run forward | `W` | 16.059 | 14.76 | 14.61 | 4.0 x run_rate | path unchanged |
| run backstep | `S` | 8.908 | 8.34 | 8.18 | 2.028 x run_rate | path unchanged |

**Walk lands within 0.8 % of 3.1199999 and backstep within 0.2 % of 2.0280.**
Earlier independent runs agree: `setMovementInput(1,0,0,false)` gave 3.113
(`results-col10-fixed.json`), `shift+W` gave 3.105 (`results-probe3.json`),
`shift+S` gave 2.044 (`results-probe2.json`). Measured walk / pre-fix walk =
3.096 / 2.6027 = **1.190**, against the predicted 3.1199999/2.6017 = 1.199.
Cross-check on the two derived arms: run_forward/walk_forward = 5.19 implies
run_rate 4.02, and 4.0 x 4.02 = 16.06 = the measured run — i.e. the run lane is
internally consistent and untouched. The walk arms ran DOWNhill (dz −10.8, −6.6 m)
and the backstep arms UPhill (dz +7.1, +5.3 m) yet both hit target, so terrain
slope is not biasing the fit estimator.

**Run control caveat.** Both characters on `doorbisect1` (`Doorbi1`, `Oq3low1`)
carry `biota_properties_skill.init_Level = 5000` for Run (type 54) — the skill-105
character the §OQ-3 7.787 m/s control used no longer exists there, so that exact
control was NOT reproducible. Run measured 16.06–16.58 m/s, consistent with a maxed
run rate near the documented ~18 m/s ceiling and with the deliberate ACE-matching
divergence above skill 800 (`RETAIL_RUNRATE_EDGE=false`). The run path is
untouched by this change (its DAT base 4.000 == retail's `RunAnimSpeed`).

**Harness finding (cost 4 runs, save it).** Two independent ways a probe silently
measures a frozen player, neither COL-10-related (they hit the untouched run lane
too):
1. **A pose is NOT an in-world gate.** `getLocalPlayerPose()` returns finite
   coords while `__bootState == 'ready'`, but input is inert there — an entire
   6-arm run read 0.00 m/s with the player merely sinking (z 96 → 90.1,
   `results-probe4b.json`). Gate on `__bootState === 'in-world'` AND a pose.
2. **`@teleloc` between arms.** With a teleport before every arm, 8 of 16 arms
   froze: `[motion-link]` console lines still fired for
   `0x45000005`/`0x44000007`/`0x45000006` (the motion issues and animates) but
   pose XY never advanced. One teleport per session then W/S only: **6/6 valid**.

Also re-confirmed:
`?renderOnDemand=1` must be omitted, and `window.__wasmExports` does not exist —
the free wasm exports (`playerRunRate`, `stateGroundSpeed`, `cycleBaseSpeed`) are
NOT reachable from `window`, only from the `init3D` bag (the P5.1 instrumentation
gap again).

**Not rebuilt / not run.** `cargo test -p holtburger-core` was not run (8 GB box,
workspace-test rule); the release wasm build is the compile check for non-test
code, and the four test expectations that encoded the old model were re-pinned by
hand. One post-build whitespace-only tidy landed in `system.rs:4047` (identical
codegen).

**Residual, JS side (untouched — index.html/camera.js are another agent's this
session).** `index.html:5893` `WALK_FORWARD_SPEED = 1.0 // m/s — also strafe +
backstep` is exported on `window.__movementConstants` and read by
`camera.js:1774`; it is now wrong three ways (walk 3.12, strafe 1.56, backstep
2.03). Both consumers are the dead predictors documented in
§"camera.js flat prediction speed", so nothing live regresses — but the constant
should be split/retired when that file is next touched.

---

## DAT-01 / P1.1 — PHASE 1 LANDED (2026-07-27). Two plan premises corrected: scenery has **no physics BSP**, and 42% of it must **never** collide.

Design doc: `DAT-01-design.md` (this directory). Bake-side change is
uncommitted in the working tree; nothing client-side was touched.

### Decomp, re-opened and confirmed

The plan's `acclient.c:352708-352718` citation is **correct**.
`CLandBlock::get_land_scenes` (`:352530`) does
`CPhysicsObj::makeObject(obj_id, 0, 0)` → `set_initial_frame` →
`add_obj_to_cell` → `SetScaleStatic(ObjectDesc::ScaleObj(...))` →
`CLandBlock::add_static_object` (`:351857`) — the **same** array
hand-placed `LandblockInfo` statics land in. `bDynamic=0` sets
`STATIC_PS` (`InitObjectBegin`, `:317273`). Lifecycle:
`init_static_objs` (`:352787`, calls `get_land_scenes` at `:352888`
behind `use_scene_files`) / `destroy_static_objects` (`:351931`) from
`CLandBlock::Destroy` (`:351966`) and `notify_change_size` (`:352430`),
all under `LScape::update_block`'s shifting refcounted slot grid
(`:307786`). Filters include `ObjectDesc.weenie_obj == 0` (offset +108) —
weenie-backed scenery is server-spawned, never client-instantiated.

### PREMISE CORRECTION 1 — retail does **not** use a physics BSP for scenery

`CPhysicsObj::FindObjCollisions` (`:316159`) picks a narrow phase by a
four-rung ladder at `:316229-316281`: (1) `HAS_PHYSICS_BSP_PS 0x10000` →
`CPartArray::FindObjCollisions`; (2) else cylsphere →
`CCylSphere::intersects_sphere(cyl, &m_position, m_scale, transition)`;
(3) else sphere; (4) else **no collision**.

Measured against `~/ac_base_dats/client_portal.dat` via
`chorizite-parse-dat-record`: every `GfxObj` part of the three most
common scenery setups (`0x020002D3` → `0x01003AB5/6`, `0x02000258` →
`0x010037A2/A1/9F`, `0x02001063` → `0x010031AE`) reports
`physicsBSP: None, physicsPolygons: 0`. Rung 1 never fires. Trees
collide as a **scaled cylinder** — `0x020002D3` cylsphere r 1.53 h 34.606
at origin z −3.8.

Consequence: the existing `insert_static_physics_bsp` /
`resolve_static_bsp_pushout` machinery (`scene.rs:2731`,
`system.rs:4858`) is the right *shape* but the wrong *feed* for scenery —
there is no BSP to register. A cylsphere narrow phase has to be written
(design §6 phase 2b).

### PREMISE CORRECTION 2 — the bake AABB is a broad phase, never a collider

The plan calls `aabb.rs`'s boxes "a natural starting point". They bound
the **render mesh** (foliage canopy), not the trunk. Measured on the
three test LBs:

| Setup | AABB half-extent | cylsphere radius | ratio |
|---|---|---|---|
| `0x02000258` | 13.52 m | 1.09 m | **12.4×** |
| `0x020002D3` | 6.82 m | 1.53 m | 4.5× |
| `0x020002DB` | 6.94 m | 1.53 m | 4.5× |
| `0x02000246` | 3.82 m | 0.85 m | 4.5× |

An AABB-only feed turns one pine into a 27 m impassable wall.

### PREMISE CORRECTION 3 — 42% of placements must not collide at all

8 of the 16 distinct setups in the sample (`0x02001063`, `0x020007A2/3/4/5`,
`0x020005AC`, `0x02000493/4`) have **no cylsphere, no sphere,
`height = 0`, `radius = 0`** — retail's rung 4, i.e. no collision. By
placement count that is **33 of 79 (42%)**, and the single most common
model (`0x02001063`, 23 of 79) is one of them. A feed without this
per-`CSetup` filter ships solid grass.

### PREMISE CORRECTION 4 — COL-17 is not DAT-01

"Walk/jump up very steep cliffs" is terrain slope handling
(PHY-06/PHY-21, Tier 3). `ObjectDesc::CheckSlope` (`:351355`) only
decides where scenery is *placed*; nothing in the scenery path affects
the player's walkable-slope test. Do not expect DAT-01 to move it.

### Bake-side change (phase 1 of 4)

`Aabb3D` + `transform_mesh_to_aabb3` in
`crates/holtburger-scenery-bake/src/aabb.rs`; `ScenicPlacement.bounds`
carries the box the bake already computed for ACE's `Collision`
rejection and previously discarded; JSONL gains six **appended** `aabb_*`
fields (V3) with a `--no-bounds` opt-out and a `placement-bounds` line
in `bake-source.sha256`.

**Zero placement drift, proven three ways.** (a) The rejection test now
reads `bounds.xy()`, pinned bit-identical to the old 2D builder by
`aabb::tests::transform_mesh_to_aabb3_xy_matches_2d`. (b) A `--no-bounds`
re-bake of `0xA9B3` / `0xAAB4` / `0xA9B4` is **line-for-line identical to
the shipped `dist/scenery/` files** once V2's `stable_id` is stripped
(the live dist predates V2); `0xA9B4` (0 placements) is byte-identical
as-is. (c) `placements-hash` is unchanged between the bounds and
no-bounds runs (`47429a5989dfd626` for `0xA9B3`,
`a4d520dfa64951bb` for `0xAAB4`) — the freeze hash deliberately still
folds only the twelve wire fields, so all 40,197 shipped sidecars stay
valid.

**Validation of the emitted boxes** (79 placements, 3 LBs): 79/79 carry
bounds; 0 inverted; 0 with the placement's XY outside its own box; 0
extending more than 15 m past the landblock edge. Cross-checked against
the DAT: `0x020002DB`'s emitted Z extent 44.42 m vs the `CSetup`'s
declared `height` **44.39 m**. Size cost +46% on a dense LB
(21,884 → 31,862 B for 71 placements).

Tests: `cargo test -p holtburger-scenery-bake --release` 8+9 pass
(including `determinism_repeat`, `placements_fingerprint_is_stable`,
`bake_output_fingerprint_is_stable`); `--bin scenery-bake` 26 pass;
`--test scenery_bake_preflight` 2 pass. **No re-bake of `dist/` was
performed** — scratch outputs only.

---

## Doorframe gap (HANDOFF task 2) — PREMISE REFUTED (2026-07-27). Building collision is intact; the "gap" is a misread of a 45°-rotated footprint.

Rig: `/mnt/wbterminal2/door-bisect-2026-07-27/` on `:8766`, live `pkg/`
(release, 4,947,030 B, includes COL-03 `3f380c50` + COL-10 walk speed).
New probes `doorgap_probe{,2,3,4}.cjs`, results `results/doorgap-{A..E}.json`.
Nine movement-gated walks + 32 static wasm sweeps.

**The venue geometry, derived from the DAT rather than assumed.** LB `0xA9B4`
`LandBlockInfo.buildings[8]` = GfxObj `0x01000BC3` at local (79.5, 37.5, 94),
orientation `(0.92388,0,0,-0.382683)` = **yaw −45°**. Transforming its 47
`physicsPolygons` through that frame (only the polys spanning z 94.3-96, i.e.
player torso height) gives a rectangle rotated 45°, not an axis-aligned box:

| wall | plane | doorway opening in it |
|---|---|---|
| SE | `x − y = 48.01` | **(80.98, 32.97) → (82.33, 34.32)**, 1.909 m — door `0x7A9B401F` |
| SW | `x + y = 109.50` | (75.08, 34.42) → (76.42, 33.08), 1.90 m — door `0x7A9B401E` |
| NW | `x − y = 35.99` | — |
| NE | `x + y = 125.19` | — |

Corners S(78.76, 30.75) E(86.60, 38.59) N(80.59, 44.60) W(72.75, 36.76). The
vertex-array AABB (x 70.07..87.61, y 29.25..46.79) over-bounds this by up to
4.9 m — that AABB is what `cameraSweepCollision` reports, and reading it as the
footprint is what produced the "gap" reading.

**What the +0.45 m lateral actually does.** Walk due north from (82.124, 26.5):
it crosses the SE wall plane at (82.124, 34.11), 0.66 m along the wall from the
door centre — outside the 1.909 m opening's passable band — so it is **deflected
by the doorway's NE jamb at (82.33, 34.32)**, then slides NE along the OUTSIDE
face of the SE wall holding `x − y = 48.70 ± 0.01` for ~5 m (= wall plane 48.01
+ 0.48·√2, i.e. exactly `PLAYER_CAPSULE_RADIUS`), rounds the E corner at
**x = 87.08 = 86.60 + 0.48** (again exactly one radius), and then walks north
over open terrain, downhill z 94 → 77. Nothing should stop it there: north of
the E corner is outside the building. The handoff's "(82.36, 34.30) leaf NE end"
is the **doorframe jamb** (82.33, 34.32) — the frame did catch the mover, which
is why it was deflected.

**No sample, in any run, is inside the building shell.** Across all 9 walks
(offsets −0.45, −0.30, 0, +0.30, +0.45 at the door; x = 73, 77, 79.5 elsewhere;
run and walk speeds; 24.7 m/s peak under `@god`), zero trace samples satisfy
`35.99 < x−y < 48.01 && 109.50 < x+y < 125.19`. The x = 73 run that looked like
a pass-through is the capsule rounding the **W** corner: it is pushed to
x = 72.25 = 72.745 − 0.50 ≈ corner − radius and passes cleanly outside.

**Verdict: none of (a)/(b)/(c) — (d) nothing is missing.** The building's
physics BSP is loaded (`residency: staticBsps 89, cellStaticBsps 535,
buildingAabbs 20`), the live driver consults it, and the mover is stopped by it
at the correct offsets. There is no cell-transition bug either: the mover stays
outdoors because it never crosses a portal — it is deflected outside the doorway.

**Closed-door arithmetic (why every offset is blocked).** Doorway half-width
0.955 m; the door entity's collider is a 0.40 m circle at the door origin, so
with the 0.48 m capsule the mover cannot come within 0.88 m of (81.674, 33.629).
0.955 − 0.88 = 0.075 m of tangent room on each side, less than one capsule
radius ⇒ the closed doorway is fully sealed. Measured: head-on stops at
y 32.746 (0.883 m from the door origin); −0.30 and −0.45 both enter the doorway
reveal, slide west around the circle and wedge at (81.035, 33.023) — again
**0.881 m** from the door origin; +0.30 and +0.45 are deflected outside.

### Head-on 0.88 → 0.69 with BSP resident BEFORE contact: NO. Still 0.88.

Measured with full residency read *before* the run (`staticBsps 89`,
`cellStaticBsps 535`, `cellPhysicsBsps 123`): head-on stop **y 32.746**, gap to
the door plane **0.8826 m** — identical to every 07-27 bisect arm. 0.883 =
0.40 (default entity cyl radius) + 0.48 (`PLAYER_SETUP_SPHERE_RADIUS`). The
predicted 0.69 would be the door-LEAF plane stop (leaf plane `x − y = 48.01`,
capsule at 48.69 ⇒ y 32.985 ⇒ gap 0.64). It does not occur: the head-on stop is
the **circle** arm, and residency is not what gates it.

### Citation correction: the "integrator arm" at `system.rs:4783-4886` is DEAD CODE.

The handoff and the COL-03 addendum both name
`crates/holtburger-core/src/client/movement/system.rs` ~4783-4886 (the
`clamp_delta_against_buildings` → statics-AABB → `resolve_static_bsp_pushout`
chain) as the live collision arm. It is not reachable:
`advance_local_pose_for_manual_drive_slice` (`system.rs:4210`) returns at
`:4221-4224` whenever `unified_transition_enabled()`, and
`USE_UNIFIED_TRANSITION = true` (`:644`). The live path is
`advance_manual_slice_via_transition` →
`find_transitional_position_dispatch` (`system.rs:6629`) with
`USE_FAITHFUL_TRANSITION = true` (`:669`) and `USE_FAITHFUL_OUTDOOR = true`
(`:695`) — the decomp-faithful `CTransition` port, which outdoors floods the
land-cell ring and collides terrain triangles → `cell_static_physics_bsp` →
entities. **Everything from `system.rs:4226` to ~`:4900` — the building-AABB
clamp, the indoor per-poly clamp, the statics-AABB clamp, the static-BSP
push-out and the legacy entity pass — is unreachable legacy.** Future collision
work belongs in `spatial/transition.rs` + `spatial/faithful_bridge.rs`.

Direct proof: `cameraSweepCollision` (the coarse building-AABB sweep, same
`building_aabbs_near_pose` + `sweep_sphere_against_aabbs` the dead clamp uses)
reports a block at local y 28.773 with normal (0,−1,0) on **every** approach
line at the grocer — and no mover ever stops there.

### Retail cross-ref (acclient.c)

- `CLandBlock::init_buildings` (`:352114`): each `BuildInfo` becomes a
  `CBuildingObj::makeBuilding(building_id, num_portals, portals, num_leaves)`
  CPhysicsObj, added to the ONE land cell containing its frame origin
  (`LandDefs::adjust_to_outside`) plus the landblock `stablist`. Our
  `USE_BUILDING_OVERLAP` (register into every overlapped cell) is a deliberate,
  documented widening of exactly this.
- `CBuildingObj::find_building_collisions` (`:719116`): sets
  `sphere_path.bldg_check = 1` and runs `CPhysicsPart::find_obj_collisions`
  over the building's own part array — i.e. the building's GfxObj physics BSP,
  the same data our `cell_static_physics_bsp` bake stages. Retail has **no
  separate doorframe primitive**: the doorway is simply an opening in the
  building's physics mesh, which the DAT confirms (SE-wall polys stop at
  (80.98, 32.97) and resume at (82.33, 34.32)).
- Outdoor dispatch `CLandCell::find_collisions` (`:354887`): terrain
  (`vfptr[5]`) → `CSortCell::find_collisions` → `CObjCell::find_obj_collisions`
  (`:347142`).
- Cell transition: `CEnvCell::check_building_transit` (`:348110`) re-derives
  interior membership from the building portals every frame; our
  `entered_envcell_for_outdoor_pose` / `exited_envcell_to_outdoor`
  (`USE_LOCAL_ENVCELL_ENTRY`) mirror it. Nothing to fix.

### Genuine (out-of-scope) defect found: third-person camera over-clips rotated buildings

`scene3d/camera.js:1353` runs `cameraSweepCollision` — the **coarse per-part
building AABB** — as step 2 of the camera clip chain, ahead of step 3's precise
`sweepSphereAgainstBuildingMesh` over the same building. For a 45°-rotated
building the AABB over-bounds the real footprint by up to 4.9 m, so the camera
pulls in that far short of the grocer's walls (measured: clip at local y 28.77
vs the real wall at y 34.11 on the +0.45 line). Step 3 already covers what step
2 was for. Proposed fix is one flag-gated deletion of the step-2 block
(S-sized), but it is a camera/render change ⇒ needs a 1070 eye test; NOT made
here.

### Harness notes

- `?renderOnDemand=1` is dropped from the rig's launch (`launch2.sh`); the
  handoff's warning is right and `window.liveScene3d` is populated without it.
- `__bootState` reaches `in-world` and is then **overwritten by `ready`** — gate
  on `__bootStateHistory.includes('in-world')`, not on the current value.
  `lib_cdp.cjs`'s pose-based gate happens to be right here but is not a proof.
- `@teleloc … 95.0` sometimes lands the capsule hovering at z ≈ 94.41 with the
  movement gate refusing input for the whole run (`vmax 0`, three occurrences).
  Teleporting to **z 94.06** (just above the 94.005 terrain) fixed it. Always
  check `vmax > 0` before reading a run.
- Multiple `@teleloc` per session works (9 in this session); the freeze
  mentioned in the handoff was the airborne-teleport case above, not teleport
  count.

---

## DAT-01 / P1.1 — PHASE 2 LANDED (2026-07-27). Cylsphere + sphere narrow phase, per-LB batches, live-path integrator arm (DEFAULT-OFF). Two of phase 1's premises refuted at world scale; the arm's first siting was DEAD CODE.

Design doc: `DAT-01-design.md`. Phase 1 (bake-side V3 `aabb_*`) is `c6aaa436`.
Everything below is client-side and NOT committed by this pass.

### What landed

| sub | what | anchor |
|---|---|---|
| 2a | `SceneryColliderBatch` (SoA, one row per PRIMITIVE) + `insert_scenery_colliders` / `clear_scenery_colliders_for_landblock` / `scenery_collider_count` / `..._landblock_count`, and the scenery family wired into the batched `clear_landblocks_collision` | `holtburger-world/src/spatial/scenery.rs`; `spatial/scene.rs` `insert_scenery_colliders` / `clear_landblocks_collision` |
| 2b | `CCylSphere` port (rungs 2) + `CSphere` port (rung 3): `cylsphere_to_world`, `cylsphere_collides_with_sphere`, `cylsphere_z_slab_overlap`, `cylsphere_normal_of_collision`, `sweep_sphere_against_cylsphere`, `cylsphere_pushout_xy`, `sphere_to_world`, `sphere_collides_with_sphere`, `sweep_sphere_against_sphere`, `sphere_pushout_xy` | `spatial/scenery.rs` |
| 2c | `populateSceneryCollidersForLandblock` + `scenery_model_rung` (the exclusive ladder, memoised per DID) + V3 `aabb_*` on `ScenicPlacementJsonRaw`/`CachedRecord` + `scenic_bounds_from_raw` | `apps/holtburger-web/src/lib.rs` |
| 2d | `USE_SCENERY_COLLISION` (**false**) + the arm, sited AFTER `find_transitional_position_dispatch` | `holtburger-core/src/client/movement/system.rs` |
| 2e | JS load hook + `sceneryCollidersPopulatedLbs` evict dedup + 4 new `__diag.collision` counters | `index.html`; `scene3d/diag/collision.js` |

### THE MISTAKE WORTH RECORDING: the obvious home for the arm is dead code

`system.rs:4783-4886` — the outdoor-static AABB sweep plus the static-BSP
push-out — reads exactly like the place a scenery arm belongs. It is
**unreachable**. `advance_local_pose_for_manual_drive_slice` returns at
`:4221` under `USE_UNIFIED_TRANSITION` (`:644`, `true`), so that whole block
and everything down to the legacy entity pass never executes on the live
path. An arm placed there passes its flag-off smoke *and would keep passing
after the flag was flipped on*, because the code simply never runs.

The live path is `find_transitional_position_dispatch` (`transition.rs:985`)
→ `faithful_bridge::faithful_find_transitional_position` (both
`USE_FAITHFUL_TRANSITION` `:669` and `USE_FAITHFUL_OUTDOOR` `:694` are
`true`). The arm now sits immediately after it, in the same
post-transition XY-correction shape the FU-3 entity arm uses
(`system.rs`, `pose.coords.x += clamped.x - lateral.x`).

**Generalised guard, added as a permanent probe:**
`SpatialScene::note_scenery_arm_reached()` is called at the arm's site
**OUTSIDE** the `USE_SCENERY_COLLISION` check, surfacing as
`__diag.collision.residency().sceneryArmEvals`. A counter that only moved
when the flag was ON could not have caught this — "flag off, no effect" and
"flag in dead code" are indistinguishable from outside. Site reached plus a
`const true` gate is a compile-time guarantee that the body runs. **Any
future flag-gated arm in this codebase should ship the same unconditional
reachability bump.**

MEASURED: `sceneryArmEvals` 0 → 38 over a 6 s headless walk on the shipped
wasm (0 → 178 → 239 on the prior build). Zero at the dead site, by
construction.

### PREMISE CORRECTIONS — phase 1's 3-landblock sample was wrong twice

Ground truth: the world-scale census at
`/mnt/wbterminal2/buildbox-2026-07-27/census/census-summary.md` — all 176
scenery DIDs, calibrated against 115,415 real placements from the shipped
bake.

| rung | DIDs | real placements | phase-1 claim |
|---|---:|---:|---|
| 1 `bsp` | 23 | 0.5% | *"there is no BSP to use"* — **REFUTED** |
| 2 `cylsphere` | 85 | 33.7% | correct |
| 3 `sphere` | 19 | 6.1% | not mentioned — would have been staged with no test to run |
| 4 `none` | 49 | **59.7%** (95% CI [58.05, 61.39]) | *"42%"* — **REFUTED, understated** |

Three further corrections now honoured in code:

1. **`CSetup.height == 0 && radius == 0` is NOT a valid "no collider" test.**
   All 49 rung-4 DIDs satisfy it — but so do **19 colliding DIDs** (every
   BSP-only Setup, all 8 BSP bare GfxObjs, incl. `0x020007D9` at ~12k
   placements). Only the ladder itself is correct. `scenery_model_rung`
   classifies by the ladder and nothing else.
2. **The ladder is EXCLUSIVE and ORDERED.** Rung 1 short-circuits, and four
   scenery models carry a BSP *alongside* cylspheres/spheres (`0x020004BF`,
   `0x0200068B`, `0x020003CB`, `0x0200086E`). Testing cylsphere first would
   diverge from retail on all four. Rung 1 is therefore classified FIRST via
   `SetupFlags.HasPhysicsBSP` (`0x8`) — a perfect proxy for the real
   `CPartArray::CacheHasPhysicsBSP` truth, 167/167 Setups, so no part GfxObj
   fetch is needed.
3. **9 of the 176 scenery ObjectIds are bare `0x01XXXXXX` GfxObjs, not
   Setups.** `CSetup::makeSimpleSetup` (`acclient.c:334456`) leaves
   `num_cylsphere == num_sphere == 0`, so they reach only rung 1 or 4 —
   parsing one as a `SetupModel` would fault. They take their own branch on
   `GfxObjFlags.HasPhysics`.
4. **Multi-primitive arrays are real** (cylsphere counts {1:82, 2:3, 3:2};
   sphere counts {1:18, 2:2, 3:1}) and retail walks the whole array
   (`v10 += 20` / `+= 16`). The batch emits **one row per primitive**, not
   per placement.
5. **Cylsphere origins must be SCALED and ROTATED, not just translated** —
   23 of 87 have non-zero XY, 26 have negative Z (`0x020002D3` sits at
   z −3.8). Scale reaches **8.0×** via `ObjectDesc.MaxScale`, so a 3.639 m
   radius becomes 29 m; the tests cover the scaled path.

### The decomp math, and where the port deviates knowingly

`CCylSphere::intersects_sphere(cyl, Position *p, float scale, CTransition *)`
(`acclient.c:362244`) applies `m_scale` uniformly to `radius`, `height` AND
`low_pt` — `low_pt` scaled in MODEL space, *then* transformed by the
placement frame (`:362258-362266`). `cylsphere_to_world` reproduces that.

`CCylSphere::collides_with_sphere` (`:361502`):
`radsum² >= disp.x²+disp.y²` AND
`sphere.r − 2e-4 + h/2 >= |h/2 − disp.z|`. The Z half reads as a puzzle but
reduces to `−r <= disp.z <= height + r` — the cylinder's Z span extended by
the sphere radius at both ends. It is a **slab** test, not a true capsule
test: near a cap rim retail reports a hit the exact corner distance would
not. Preserved deliberately.

Swept solve = the quadratic inside `CCylSphere::collide_with_point`
(`:361824-361840`, `:361896-361918`), including retail's root rule at
`:361832` (near root; far root when the near one is negative, so an
already-overlapping start yields a forward exit rather than a spurious
backward hit) and the `t ∉ [0,1]` rejection at `:361887`.

**One non-obvious constraint, found the hard way.** Re-asserting the full
`collides_with_sphere` at the swept contact point rejects **every true wall
hit**: retail's `radsum` is `radius − 2e-4 + sphere_radius` while the swept
solve uses `radsuma = radius + sphere_radius`, so the exact contact point is
epsilon-*outside* the predicate. Retail never notices because its caller
evaluates the predicate at the *start* pose, before `collide_with_point`
runs. The port therefore applies the **Z half only**
(`cylsphere_z_slab_overlap`) at the contact. This cost two failing tests to
find and is the single easiest place to reintroduce a silent
never-collides bug.

Rung 3: `CSphere::collides_with_sphere` (`:358509`) has its FPU compare
**lost by the decompiler** (`return v5 == 0;` with `v3 = disp->z` dangling),
so the predicate is taken from ACE's verbatim port
(`Physics/Sphere.cs:215-221`, `LengthSquared() <= radsum²`) with
`radsum = mover.r + sphere.r − EPS` (`Sphere.cs:302`). Both rungs treat
exact contact as a hit, consistently.

**Knowing deviations:** `slide_sphere` / `land_on_cylinder` /
`step_sphere_up` / `step_sphere_down` are NOT ported — they are the retail
`CTransition` resolution arms, and our integrator owns resolution
(stop-and-slide + lateral depenetration, exactly like the `USE_STATIC_BSP`
arm). Push-out is lateral-only so the floor-Z snap stays the sole vertical
authority.

### DEFERRED — rung 1 (physics BSP), 0.5% of placements

Classified (so it can never be mis-tested as a cylsphere) and **skipped**,
counted into a `[dat01]` debug log so the omission is visible rather than
silent. TODO recorded on `populate_scenery_colliders_for_landblock_impl`.
NOT staged into the existing `STATIC_BSP_PENDING` machinery for two
blocking reasons:

1. **Scale.** `CellPhysicsBsp.scale` is hard-coded `1.0` at *both* existing
   staging sites (`lib.rs`, with its own pre-existing TODO "plumb the real
   scenery scale when the feed carries it"), and the part-frame composition
   there does not scale `b.offset` either. Scenery scale is 0.2×–8.0×, so a
   unit-scale assumption would place these BSPs visibly wrong — worse than
   no collision.
2. **Gating.** `statics_physics_bsp` feeds the outdoor overlap bake into
   `cell_static_physics_bsp`, which the live faithful driver consults
   **unconditionally**. Staging there would make scenery BSP collision live
   by default, defeating `USE_SCENERY_COLLISION`.

### Validation

Unit: **642** `holtburger-world` lib tests pass (48 scenery-specific), plus
**7** `holtburger-web` native V3 wire tests. Hand-computed cylinder/sphere
times, cap hits, the radsum boundary, the 0.050 m smallest real cylsphere,
scaled-instance proportionality, and the census ground-truth params for
`0x020002D3` / `0x02000258` / `0x02000246` at 8× scale.

Live (headless, `:8765`, ACE on this box, bare defaults + the arm OFF
against the shipped **pre-V3** `dist/`):
- boots to `in-world` in 24 s, **zero console errors**, all five wasm
  collision smokes pass;
- `residency()` returns **17** fields (13 + 4 new), parsed positionally in
  lockstep with `RESIDENCY_FIELDS`;
- `populateSceneryCollidersForLandblock` returns **0** cleanly for every LB
  — the arm is inert on pre-V3 data, by design, with no error path;
- `sceneryArmEvals` 0 → 38 during a 6 s walk (reachability).

Live V3 ingest, against the **real full-world rebake** at
`/mnt/wbterminal2/buildbox-2026-07-27/rebake/staging/` (3 LBs copied under
the served tree, `init_scenery_base_url` repointed, source restored after):

| LB | placements | colliders staged | census-predicted | verdict |
|---|---:|---:|---:|---|
| `0xA9B3` | 71 | **46** | 46 (25 rung-4: `0x02001063`×23, `0x020005AC`×2) | **exact** |
| `0xA9B4` | 0 | 0 | 0 | exact |
| `0xAAB4` | 8 | **0** | 0 (all 8 rung-4) | **exact** |

The 46 drained into the scene (`sceneryColliders` 46, `sceneryColliderLbs`
1). Re-staging the same LB **doubled it to 92** — append semantics are real,
which is precisely why the clear had to be wired — and
`enqueueClearLandblockCollision(0xA9B3)` returned it to **0/0**, proving the
scenery family is live inside the batched `clear_landblocks_collision`.

NOT validated: live movement blocking with the flag ON. That is phase 4 and
needs the lateral-offset approach at a known tree plus the
"can-still-walk-through-grass" negative test. `sceneryNarrowHits` is the
evidence to read.

### Perf note (estimated, not measured — which is why the flag ships OFF)

Flag OFF: one `Cell<u64>` increment per movement slice. Nothing else — the
gate is a `const bool`, so the body is dead-code eliminated.

Flag ON, at measured density: `0xA9B3` is 46 rows, so a 3×3 ring is
~400 rows worst case. The swept path early-outs on an empty index and on a
zero delta, then rejects on one AABB compare per row (a pine's render box
is 4.5–12.4× its trunk, so almost everything rejects). The depenetration
path has **no delta to early-out on** and runs every slice once anything is
resident — it was given the same AABB pre-reject for exactly that reason.
Estimated worst case ~400 AABB compares + a handful of quadratics per
slice. Believed negligible; **unmeasured**, and the whole reason
`USE_SCENERY_COLLISION` deviates from the project's default-on rule.

### pkg/ state

`pkg/holtburger_web_bg.wasm` = **4,906,246 B release**
(sha256 `c51b83a0e6585329…`), containing all of the above.
Pre-change backup: `…/scratchpad/pre-dat01-holtburger_web_bg.wasm`
(4,947,030 B).
