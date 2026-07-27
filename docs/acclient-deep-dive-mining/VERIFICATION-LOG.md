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
