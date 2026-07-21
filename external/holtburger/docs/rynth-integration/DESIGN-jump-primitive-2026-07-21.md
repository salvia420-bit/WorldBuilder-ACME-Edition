# DESIGN — the jump primitive for holtburger bot navigation (2026-07-21)

Follow-on to `HANDOFF-metanav-2026-07-20.md`, ranked gap #1: "the structural gap,
now triple-confirmed" — 98 human-authored `jmp` records in the corpus, the offline
oracle failing `vr-bridge-jump` at a literal gap-jump leg, and both the indoor
router (`isDropEdge` prune) and the MoveTo driver lacking a jump/fall path by
design. This is a read-only research + design doc; no code changed.

**Headline finding that reshapes the plan**: holtburger already has a complete,
retail-parity-tested jump *execution* pipeline (wasm physics → wire packet),
built for manual/keyboard play and gated behind a default-off flag. It has zero
callers in the autonomous nav stack. The gap is integration, not physics.

---

## 1. Retail + ACE jump physics (decomp/ACE-cited, all commands actually run)

### 1a. Charge (hold) mechanic
`ClientCombatSystem::CommenceJump` (acclient.c:408033, region 407950-408260)
starts a powerbar build on jump-key-down (`powerBarMode = 3`,
`SendNotice_BeginPowerbar(PBM_JUMM)`). `ClientCombatSystem::DoJump` (acclient.c:
408136) reads the accumulated `GetPowerBarLevel` as `extent`, floored at
`MIN_JUMP_EXTENT = 0.001` (acclient.c:41626). **`extent` (0.001-1.0) is the
hold-duration/charge fraction** — how long the jump key was held, normalized —
not a character stat.

### 1b. `_powera` is the Jump SKILL, not a charge value
Verified directly (`rg -an 'MovementSystem::GetJumpHeight\(' acclient.c | rg -v
';'` → def at 713806; full body read via `sed -n '713806,713826p'`):

```c
double __cdecl MovementSystem::GetJumpHeight(const float load, const int jumpskill,
                                              const float _power, const float scaling)
{
  power = clamp(_power, 0.0, 1.0);
  _powera = (double)jumpskill;
  result = EncumbranceSystem::LoadMod(load)
           * (_powera / (_powera + 1300.0) * 22.200001 + 0.050000001)
           * power / scaling;
  if (result < 0.34999999) result = 0.34999999;
  return result;   // a HEIGHT in yards, not yet a velocity
}
```

So the well-known anchor formula `_powera/(_powera+1300)*22.2` is **Jump skill
composed into a height contribution**, scaled by burden (`LoadMod`), the
0.001-1.0 charge `power`, and floored at 0.35 yd minimum height. This is the
retail source of the handoff's cited formula — now with the missing context:
it is skill × charge × burden, not charge alone.

### 1c. Velocity, gravity, and the horizontal component
`v_z = sqrt(height * 19.6)` (`CACQualities::InqJumpVelocity`, acclient.c:
443841-443843; `19.6 = 2*9.8`, i.e. classic `v = sqrt(2·g·h)`). Gravity magnitude
independently confirmed: `rg -an 'PhysicsGlobals::gravity = '` → acclient.c:45824,
`float PhysicsGlobals::gravity = -9.8000002; // weak`.

STR is **not** an input to jump height; the only body-stat gate is Stamina:
`InqJumpVelocity` zeroes `jumpskill` outright when `stamina == 0` (a hard floor
gate, not a scaler) — an exhausted character's jump collapses to the 0.35 yd
minimum regardless of skill.

Horizontal distance has **no separate jump-distance stat**:
`CMotionInterp::get_leave_ground_velocity` (acclient.c:343800) calls
`get_state_velocity` to fill x/y from whatever forward/sidestep run speed the
character already had at the moment of jump, then overwrites z with the
velocity above. A standing jump (no run velocity) falls back to the object's
raw local velocity vector. `charge_jump` (acclient.c:343845) sets
`standing_longjump=1` when grounded + pure-forward-hold with no sidestep/turn —
this is retail's "standing long jump," matching the `StandingLongJump` motion
(`0x02`, protocol.xml:1949) and this repo's `?longJump=on` parity flag.

### 1d. Landing / airborne detection
`CPhysicsObj::on_ground` (verified directly: `rg -an
'CPhysicsObj::on_ground\('` → def acclient.c:343373; body read via `sed -n
'343369,343378p'`):

```c
BOOL __thiscall CPhysicsObj::on_ground(CPhysicsObj *this) {
  unsigned int v1 = this->transient_state;
  return v1 & 1 && v1 & 2;   // CONTACT_TS (0x1) && ON_WALKABLE_TS (0x2)
}
```

Airborne = NOT(`CONTACT_TS && ON_WALKABLE_TS`); this same bit pair gates
`jump_is_allowed` (denies double-jump with error 36, acclient.c:343922) and
zeroes acceleration in `calc_acceleration` when grounded (else applies gravity
if the `GRAVITY_PS` state bit is set). Tick integration
(`CPhysicsObj::UpdatePhysicsInternal`, acclient.c:317701) is semi-implicit
Euler: `pos += v·dt + 0.5·a·dt²` then `v += a·dt`, driven off wall-clock delta,
capped at 2.0s/tick.

### 1e. Wire opcode reality check — 0xF74E is NOT the jump-initiation signal
The handoff's "0xF74E landing signal" needed correction. Verified in
`external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/protocol.xml`:

- **C2S `Movement_Jump` = 0xF61B** (protocol.xml:431, type def :7392) — the
  actual jump *request*. Payload: `JumpPack` — `float Extent`, `Vector3
  Velocity`, 4×`ushort` sequence fields (protocol.xml:6391-6398), i.e. **the
  client computes and sends its own velocity vector** (client-authoritative
  physics — retail design, not an emulator shortcut).
- **S2C `Movement_VectorUpdate` = 0xF74E** (protocol.xml:158, type def
  :8323-8327, queue `SmartBox`) — "Changes an objects vector, for things like
  jumping." Fields: `ObjectId`, `Vector3 Velocity`, `Vector3 Omega`, 2×`ushort`
  sequences. This is a general velocity/omega broadcast, and on ACE it fires
  **immediately after the server applies the jump**, i.e. at *takeoff*, not at
  landing (`Player.cs:954`, see 1f). There is no distinct wire "you have
  landed" event — landing is a local physics-state transition
  (`on_ground`/`CONTACT_TS`), observed by others only implicitly via subsequent
  position updates.

### 1f. ACE server-side handling — trusts the client, computes stamina only
`ACE.Server.Network.GameAction.Actions.GameActionJump.Handle` (`GameActionJump.cs:
7-22`) constructs a `JumpPack` from the wire payload and calls
`session.Player.HandleActionJump(jumpPack)`
(`WorldObjects/Player.cs:866-958`, both files read directly):

```csharp
var extent = Math.Clamp(jump.Extent, 0.0f, 1.0f);
var staminaCost = MovementSystem.JumpStaminaCost(extent, burden, PKTimerActive);
UpdateVitalDelta(Stamina, -staminaCost);
// TODO: have server verify / scale magnitude          <-- literal comment, Player.cs:902
...
PhysicsObj.set_local_velocity(jump.Velocity, false);    // client's vector, unmodified
...
EnqueueBroadcast(new GameMessageVectorUpdate(this));     // 0xF74E, fired here — at apply time
```

`Physics/Animation/MovementSystem.cs` (read directly) is a byte-faithful C#
port of §1a-1c: `GetJumpHeight` (line-identical formula), `JumpStaminaCost`,
`GetJumpPower` (the stamina→power inverse), `GetRunRate`. **The
stamina-insufficiency rescale block that would clamp `jump.Velocity.Z` down for
an exhausted character is present in source but commented out**
(`Player.cs:883-894`) — ACE never rejects or rescales an under-funded jump; it
only deducts stamina (which can go negative) and applies whatever velocity the
client sent, unclamped. A separate, jump-agnostic sanity check exists
(`Player_Tick.cs:459`: flags `newPosition.Z - LastGroundPos.Z > 10` more than
1s after `LastJumpTime` with `Jump skill < 1000`) but this is a general
anti-teleport heuristic, not a jump-magnitude validator.

**Implication for bot design**: ACE is the actual constraint surface (bots
never touch retail), and ACE's "TODO: verify/scale magnitude" is dead code —
a `JumpActionData` packet with any velocity the bot chooses will be applied
as-is. Getting the wire *shape* right matters far more than getting the
*physics* retail-faithful; retail fidelity is a stated project value here
(this repo already built full parity), not a server requirement.

### 1g. holtburger's existing jump port (independently confirmed, not agent-reported-only)
- `crates/holtburger-world/src/player/types.rs::PlayerState::compute_jump_velocity_z`
  (:1819-1834, read directly) — line-for-line port of §1b/1c against ACE's
  `MovementSystem.cs`, with the exhausted-stamina fold at `exhausted_jump_skill`
  (:1804-1806, cites acclient.c:443838-443839) and `jump_stamina_cost` (:1787-1794).
- `crates/holtburger-core/src/client/movement/jump_charge.rs` (read directly,
  1-60) — the retail charge clock (`MIN_JUMP_EXTENT=0.001`, fast-charge divisor
  for dual-wield stance) and `JumpRefusal` error-code enum (36/71/72/73,
  each cited to an acclient.c line), reached only under `?jumpParity=on`
  (default-off; legacy JS clock is the default path, stated byte-identical).
- `crates/holtburger-protocol/src/messages/movement/actions.rs::JumpActionData`
  (:73-82) matches `JumpPack.cs`'s exact field order **plus** the
  `object_guid`+`spell_id` trailer that `GameActionJump.cs:12-13` reads and
  discards — byte-parity-tested in
  `crates/holtburger-protocol/tests/generated_parity.rs` (:189-273, :2428-2432,
  read directly).
- `opcodes.rs:518` `Jump = 0xF61B` (C2S) confirmed against protocol.xml
  independently (not just cross-referenced): matches.

---

## 2. Client gap analysis — what exists vs. what's missing

### 2a. The manual jump pipeline is COMPLETE and wire-valid today
`apps/holtburger-web/pkg/holtburger_web.d.ts`:
- `SessionHandle.jump(power: number)` (:4402) — full pipeline: charge-clock
  read, stamina deduction, ballistic state, `GameAction::Jump` wire packet.
  Guarded by `canJumpNow()` (:3203, checks airborne + `motion_allows_jump`).
- `jumpChargeBegin/Commence/Level/Release/Cancel/Abort()` (:4407-4498) — the
  `?jumpParity=on`/`?longJump=on` charge-clock family.
- `index.html` wires Space to `CommenceJump`/`DoJump` via
  `handleKeyAction(0x31, down)` with a visible charge-bar UI.

**Verdict: yes, the wasm client can already construct and send a retail-valid,
ACE-parity-tested jump wire message today.** A bot script calling
`session.jump(1.0)` right now would fire a real `0xF61B` packet that ACE
accepts. What's missing is *aiming* it (heading control at takeoff) and
*sequencing* it (deciding when to fire relative to a route leg) autonomously.

### 2b. Zero autonomous callers — confirmed by direct grep, not just agent report
`grep -rin jump apps/holtburger-web/rynth/*.js` (run directly): every hit in
`goto_compose.js`, `bot.js`, `router.js`, `route_recorder.js` is either (a) the
unrelated `SEAM_JUMP_M`/`portalJumpM` teleport-detection vocabulary (a pose
displacement heuristic, nothing to do with the jump action), or (b) an explicit
comment stating the gap:
- `indoor_router.js:34-37, 125-126`: "IsDropEdge prunes ALL drop/jump edges —
  AC needs a jump primitive to take a drop and the executor has none." This
  traces to a pre-existing tracked limitation ID **"J3"** from an earlier
  `Nav_DeepDive_2026-06-15.md` report (`workflow-reports/09.md:52`:
  `IsDropEdge` prunes *all* jump/drop edges) — this is not a new finding, it's
  a carried-forward known gap in this repo's own C#→JS port of
  `DungeonPathfinder.cs`.
- `goto_compose.js:28`: "findExitPath PRUNE every drop/jump edge — the
  executor has no jump primitive."
- `bot.js:137-138`: same statement, applied to indoor A*/exit routing.
- `nav_file.js:46,123,246,319,372-373` / `nav_import.js:138-141`: `jmp` nodes
  parse cleanly (`NavPointType.Jump=9`) into `leg.meta.navType==="jmp"` with
  headingDeg/holdShift/delayMs preserved, but the importer explicitly emits a
  warning: `"Jump record (...) has no bot walk primitive — preserved as meta,
  replay may stall on this leg"` (`nav_import.js:141`). No consumer reads
  `meta.navType === "jmp"` anywhere in `rynth/`.
- `crates/holtburger-world/examples/route_validate.rs::LegKind::JumpSkip`
  (:227,237, docblock :47-52) — the offline oracle **teleports through** `jmp`
  legs (re-anchors position at the target, no physics), counts them as
  `SKIPPED-JUMP`, and never claims a walked leg. This is why `vr-bridge-jump`'s
  failure is NOT on a `jmp`-tagged leg — it's on the ordinary walk leg
  immediately preceding it (see §4).

### 2c. Landmark files (all read directly)
| Landmark | File | Symbol/lines |
|---|---|---|
| MoveTo driver | `crates/holtburger-core/src/client/movement/move_to.rs` | `MoveToManager` — no `Jump` leg-kind variant exists |
| Stall recovery | `crates/holtburger-core/src/client/movement/stall_recovery.rs` | `MoveToStallRecovery::poll` |
| Indoor router prune | `apps/holtburger-web/rynth/indoor_router.js` | `isDropEdge` (:140-149), `DROP_ANGLE_DEG=45`, `SHAFT_HORIZ_M=1.0`, `FLAT_DZ_M=0.5` — purely geometric, zero jump-feasibility awareness |
| Router escape hatch | `apps/holtburger-web/rynth/indoor_router.js` | `walkableOverrides` (:225-257) — corpus-ground-truth override for *misclassified walkable* edges; NOT a jump-routing mechanism (it only turns a false "drop" into "walk," never routes a true drop via jump) |
| Offline oracle | `crates/holtburger-world/examples/route_validate.rs` | `walk_leg` (:474-603, 30fps slice loop w/ gravity — the reusable template), `LegKind` (:224-242), dispatch in `validate_route` (:696-832) |
| Wire jump (server-parity) | `crates/holtburger-protocol/src/messages/movement/actions.rs` | `JumpActionData` (:73-82) |
| Wire jump (physics) | `crates/holtburger-world/src/player/types.rs` | `compute_jump_velocity_z` (:1819-1834), `begin_jump` (:1876) |
| Manual charge clock | `crates/holtburger-core/src/client/movement/jump_charge.rs` | whole file, gated `?jumpParity=on` |
| wasm API | `apps/holtburger-web/pkg/holtburger_web.d.ts` | `SessionHandle.jump`, `jumpCharge*`, `canJumpNow` (:3186-4498) |

### 2d. SessionHandle movement surface (context for where a jump leg-kind sits)
`moveToPosition(lb, x, y, z, run)` (backs MoveTo), `setMovementInput(forward,
strafe, turn, run)` (raw analog/WASD), `turnToHeading`/`turnToEntity`,
`pursueEntity`/`pursuitStatus`/`cancelPursuit`, `stickToEntity`/`stopStick`,
`handleKeyAction(action, down)` (raw retail InputAction injection — the path
Space currently uses), `tickMovement()`, and the collision/terrain probes
(`cameraSweepCollision`, `sweepSphereAgainstBuildingMesh/CellMesh/Statics`,
`terrainHeightAt`) that a jump-feasibility solver would need and that
`rynth/*.js` currently uses NONE of (also independently noted in
`appendix-navatlas-B-physics.md:31`).

---

## 3. Phased plan — recommended first slice and why

### Phase 0 (this doc) — done.

### Phase 1 — RECOMMENDED FIRST SLICE: live jump execution on one corpus leg
**Wire the existing `SessionHandle.jump()`/`jumpChargeCommence/Release()` API
into `goto_compose.js` as a new leg executor for `meta.navType === "jmp"`**:
turn to `headingDeg`, optionally hold run (`holdShift`), charge/release per
`delayMs`, call `session.jump(power)`. Target the `vr-bridge-jump` fixture's
repeated-jump macro (14 attempts at one gap, heading-tuned 120°-200°, delays
400-1200ms — see §4) live against the running ACE instance.

**Why this first, ahead of oracle simulation or router jump-edges:**
1. **Zero new physics code.** §1g/2a show the wasm/wire jump pipeline is
   already built, gated, and parity-tested — this phase is JS glue (turn,
   charge, release, sequence) plus flipping `?jumpParity=on` for bot sessions.
   The two heavier alternatives (oracle arc simulation, router jump-edges)
   both require *new* Rust physics/collision work; this one doesn't.
2. **ACE doesn't validate magnitude (§1f)** — there is no risk of the server
   rejecting an experimental jump, so live iteration is cheap and safe (worst
   case: bot falls short and stalls, the same failure mode already handled by
   existing stall-recovery).
3. **It produces the ground-truth data the other two phases need.** Phase 2
   (oracle jump simulation) needs a calibrated arc model; the cheapest way to
   get real landing-dispersion data for holtburger's own physics build (not
   just retail's decomp formula) is to fire real jumps and record real
   landings — turning this phase's telemetry into Phase 2's test oracle.
4. **Matches this project's own established methodology.** Every prior
   HANDOFF in this directory (portal-use, recall, indoor repath) landed via
   live-replay-first, then hardened offline — this phase is that same pattern
   applied to jump instead of a novel oracle-first approach.
5. **It directly falsifies or confirms the #1 gap.** `vr-bridge-jump` failing
   offline is the cited proof of the gap; making that exact gap-jump succeed
   live is the cleanest, most legible "gap closed" signal for a handoff.

Scope: single fixed leg-kind executor, one fixture, `?jumpParity=on` bots only,
no router changes. Success = the bot clears the ~82m gap (see §4) and lands
within the `chk` leg's tolerance, replicated across a few of the corpus's own
heading/delay variants.

### Phase 2 — offline oracle jump-leg simulation
Extend `route_validate.rs::walk_leg` (currently grounded/airborne-fall slices
only) with a `LegKind::Jump` branch: at leg start, compute `v_z` via
`compute_jump_velocity_z` (already ported, §1g) using the leg's `holdShift` as
a stand-in for full-vs-partial charge (or treat `delayMs` as a charge-power
proxy — needs Phase 1 telemetry to calibrate which), set horizontal velocity
from `headingDeg` + current run speed, then run the SAME 30fps
gravity-integration slice loop `env840_run_seam_wedge_slice_loop` already
proved (`spatial/env840_seam_tests.rs:536`, cited in
`appendix-navatlas-B-physics.md:37` and independently confirmed present) — but
sweeping against terrain/geometry instead of assuming re-grounding. This closes
the loop so future corpus jump routes get pre-validated before spending live
bot minutes, exactly as `route_validate.rs`'s docblock already promises for
every other leg kind.

### Phase 3 — router jump-edges (highest scope, highest value for indoor traversal)
Replace `isDropEdge`'s binary prune with a jump-feasibility test, following the
UB template mined from Discord (§5): edge-walk the navmesh/EnvCell graph
boundary, for each drop edge simulate a jump-down (usually free) and a
jump-up-back (usually the limiting case, needs the Phase 2 arc model +
`sweepSphereAgainstCellMesh`/`terrainHeightAt` collision probes already exposed
on `SessionHandle` but unused by `rynth/*.js`), and prune per-edge only when no
feasible power/heading clears it — instead of pruning all drops unconditionally.
Optionally gate by a per-bot "jump skill" analog once character-stat-aware
routing exists (UB precedent: `run/jump skill combo flag`, discord 2021-11-27,
§5). This is the highest-value phase (unlocks whole dungeon regions currently
unreachable per `isDropEdge`) but also the highest-risk/scope one — sequence it
last, after Phase 1/2 have produced real jump-arc data to route against.

---

## 4. Test plan — concrete fixtures

All coordinates below are corpus-verified (routes-json / raw `.af`/`.nav`,
global AC world-frame metres unless noted).

### Fixture A — `vr-bridge-jump` (primary; the cited failing case)
- Files: `/mnt/wbterminal2/met-corpus/mudzereli-metaf-sample/vr-bridge-jump.{af,nav}`,
  compiled `routes-json/mudzereli-metaf-sample__vr-bridge-jump.{af,nav}.json`
  (73 legs).
- Oracle failure (`validation-reports/validation-report-1784618249.txt`):
  `FAILED-AT-LEG 1 (wall)`, `start=(35051.15,14568.33,116.00)
  end=(35051.23,14568.08,116.00) target=(35075.27,14489.97,117.00)
  achieved=0.27m/required=81.99m` — the walk leg toward the jump takeoff point
  makes 0.27m of progress toward an 81.99m target before blocking on the gap
  edge.
- The file contains **14 repeated jump attempts** at the same target
  `(35075.28, 14489.97, 117.00)`, each `jmp`→`pau(1000ms)`→`chk` (idiom, exact
  text below), heading-tuned across the set: 185°,170°,165°,200°,155°,140°,
  140°,175°,140°,140°,160°,180°,150°,120°; delays 400-1200ms; `holdShift=True`
  for 13/14, `False` for the last (120°, 1200ms). Landings (`chk` records)
  creep progressively closer across attempts — human trial-and-error over one
  gap, good ground truth for calibrating heading/power sensitivity.
- `.af` source (landblock-local coords) for one attempt:
  ```
  cht 0 0 -1000 {/ub mexec $jumpnum=$jumpnum+1}
  pau 0 0 -1000 1000
  jmp 44.1969804128011 -41.5751076698303 0.487501398722331 170 {True} 800
  pau 0 0 -1000 1000
  chk 44.0988755226135 -41.2981847763062 0.487501398722331
  ```
- Live rig: `@teleloc` to the takeoff-side chk position, run the Phase 1
  executor against 2-3 of the 14 heading/delay variants, confirm arrival
  within the `chk` tolerance on at least one.

### Fixture B — `VRTreeJump500Rat` (Viridian Rise tree-jump puzzle; diversity stress)
- Files: `mudzereli-metaf-sample/VRTreeJump500Rat.{af,nav}` (28 `jmp` legs
  each), target fixed at global `(34811.51, 14287.86, 201.20)` (`.af`-local
  `(43.098, -42.417, 0.838)`).
- Heading sweep is near-full-circle (0-358°), unlike vr-bridge-jump's narrow
  120-200° cluster — good for testing heading-control robustness rather than
  raw gap distance. Example records: `jmp 43.0979706923167 -42.4172434171041
  0.838331095377604 340 {True} 1100.00003`, `... 20 {True} 925.00003`, `...
  260 {False} 95.00003` (one of only two `holdShift=False` records in the
  entire corpus — a fast, uncharged hop worth testing separately from the
  charged-jump majority).

### Fixture C — `discord/BGAugGem0-*.af` (single-leg smoke test)
- One `jmp` leg only: heading 90°, `holdShift=True`, `delayMs=200.00003`, at
  global `(8366.10, 3461.82, 48.01)`. Smallest possible fixture — use for
  first end-to-end wire-up smoke test (does `session.jump()` fire at all from
  the executor) before attempting the harder gap fixtures.

### Corpus-wide stats to validate the executor's heading/power mapping against
(n=99 `jmp` records across routes-json/, extracted directly from JSON):
- `headingDeg`: 0-358°, mean 176.9°, 58% clustered 120-209° (bridge-jump-driven).
- `holdShift`: True 90/99 (91%) — charged jump is the default; False is the
  exception (fast/uncharged hop).
- `delayMs`: 95.00003-1200, mean 744.3ms, modal bands 600-699/800-899/1100-1199
  — i.e. human authors tuned in ~100ms steps; the `.00003` suffix is a float
  rounding artifact of the authoring tool, strip it in any schema validation.

### Known corpus trap — do NOT use as jump fixtures
Non-positional nodes (`pau`/`cht`) are stored with sentinel coordinates
`(24468, 24468, -240000)` in the compiled JSON. The oracle's naive
implausible-leg-distance guard already catches most of these
(`IMPLAUSIBLE_LEG_DISTANCE_M=500`, `route_validate.rs:433`), but a couple of
non-jump routes (`aerbax-south-gate.nav` leg 475) fail the SAME way for
unrelated reasons — verify a failing leg is genuinely `jmp`-adjacent before
treating it as jump-primitive evidence.

---

## 5. Discord-mined prior art and risks (UtilityBelt "autonav", trevis, 2021-2024)

Verified directly against `/mnt/wbterminal2/ac-discord-archive/_indextest/ac.db`
(fts5 MATCH over `messages`, channel `utilitybelt` unless noted):

- **Edge-walk jump-connection generator** (trevis, `utilitybelt`, 2023-02-25):
  *"it walks all navmesh edges and finds edges that dont have obstructions in
  front of them, and if the edge is above a certain length it also divides it
  into smaller segments and does multiple jump point checks."* This is the
  literal Phase 3 template.
- **Walk-jump vs run-jump have different arcs** (Immortal Bob, 2021-11-21:
  *"Sidestep jump arc is actually different"*; trevis, 2021-11-21: *"jump arcs
  looking good... green is walk jump, blue is run jump... think i'll add
  backwards walking jumps tomorrow"*) — confirms §1c: horizontal velocity
  inherits whatever gait was active at takeoff, and a jump-feasibility solver
  needs at least walk/run (and ideally backward/sidestep) arc variants, not one
  generic arc.
- **One-way jump connections were a real bug** (trevis, 2021-12-01: *"It has
  the right jump points, but it only ends up making a one way connection from
  top to bottom between those platforms... using 650 jump skill"*) — Phase 3
  must explicitly test bidirectionality (jump-down AND jump-up-back), not
  assume symmetry; matches the handoff's "simulate jump-down then jump-up back"
  note.
- **Per-character jump-skill flags were unreliable/unfinished even in UB**
  (trevis, 2021-11-23/27/28: *"still haven't added jump skill flags (it's
  actually a run/jump skill combo flag, need to find some good numbers)"*, *"For
  near max jump chars, it doesn't do jump skill checks when pathing yet"*) — a
  cautionary precedent: don't scope Phase 3's per-character pruning as
  load-bearing for an initial ship; UB itself shipped without it for a long
  time.
- **Resume-on-land is a REAL, previously-reported bug, not speculation**
  (Alastor, `utilitybelt`, 2022-07-09 10:03-16:44, full thread read directly):
  *"Whenever I use `/ub jump`, it seems to pause VTank nav/combat/etc... but
  once the character lands on the ground, it does not resume... happening very
  consistently for me - I'm running in an olthoi tunnel... without directly
  jumping in a free heading (e.g. the jump is interrupted by an obstacle,
  either an olthoi or a wall)... so then I do `/ub jump 200` and then the char
  is in a frozen state until I move them."* This directly corroborates the
  corpus's `jmp`→`pau(5-10s)`→`chk` idiom and should be treated as a design
  constraint: Phase 1's executor must poll for landing (local `on_ground`/
  `CONTACT_TS` transition, §1d) rather than assume a fixed timer resumes
  cleanly, especially when an obstacle interrupts the arc.
- **PK stamina penalty is a real, documented retail mechanic, not corpus
  noise** (OptimShi, `general`, 2025-01-21, quoting a 2003 patch note): *"PK
  players who were recently engaged in a PK fight will now lose a greater
  amount of stamina when jumping... 100 stamina for a little hop to 200
  stamina for a full-power leap."* Matches `JumpStaminaCost`'s `pk` branch
  (§1f/1g: `(power+1)*100` when `pk=true`) — bots should not assume the
  non-PK stamina formula unconditionally if ever operating in a PK-flagged
  state.
- **Jump/skill terminology confirmed from live players**, not just UB internals
  (jovrtn, 2021-11-20: *"Are the jumping calcs done with a particular jump
  skill in mind?"*; fartwhif, 2023-09-20: *"can't use jump [to] expend stamina
  because they sometimes get too much burden to jump"* — confirms burden can
  make a jump physically fail to clear stamina cost, an edge case worth a
  bot-side pre-check).
- No discord hits for `0xF74E`/`F74E` — the opcode-level detail in §1e came
  from source (protocol.xml/ACE), not community discussion; the "jump landing
  signal" framing in the handoff should be read as informal shorthand for "the
  wire activity around a jump," not a literal landing event.

---

## 6. Risks / unknowns

1. **No live-verified landing dispersion yet.** §1-2 establish the formula and
   the wire path exist and are parity-tested in isolation, but nobody has
   fired `session.jump()` from an autonomous script against the running ACE
   instance and measured where the bot actually lands. Phase 1 exists
   specifically to close this before Phase 2 calibrates an oracle model on it.
2. **Charge-power-to-corpus-field mapping is undetermined.** The corpus
   records `holdShift`(bool) + `delayMs`, not a `[0,1]` extent directly. Does
   `delayMs` map to charge duration 1:1, or was it tuned against a fixed
   1-second `GetPowerBarLevel` divisor (§1a) with `holdShift` selecting
   walk-vs-run gait rather than charge amount? This needs either a source
   reread of the metaf `NJump.cs` exporter/executor semantics or empirical
   Phase 1 data — flagged, not resolved, in this doc.
3. **Resume-on-land reliability is exactly the UB-documented flaky case**
   (§5) — expect the same failure class here; the executor needs a bounded
   poll/retry, and stall-recovery (`stall_recovery.rs`) should be checked for
   whether it already handles a "landed but pose stale" state or needs a
   jump-specific branch.
4. **ACE's un-validated jump magnitude (§1f) is a double-edged sword.** It
   makes Phase 1 cheap and safe to iterate, but a bot that ships with an
   inflated `Extent`/`Velocity` (rather than retail-faithful charge/skill
   composition) would be indistinguishable from cheating server-side — a
   product/ethics decision this doc flags but does not resolve: should bot
   jumps stay strictly retail-formula-faithful (matching this repo's evident
   parity-fidelity culture, §1g) even though the server wouldn't catch a
   shortcut?
5. **Deewain-style server-authored jump geometry** (handoff §"Discord-mined
   execution lore": jump-puzzle rocks are server-side, not DAT statics) means
   Phase 3's navmesh-edge-walk generator will have blind spots the DAT-only
   bake can't see — out of scope for Phases 1-2's fixtures (none involve
   Deewain) but a known Phase-3 limitation to carry forward.
6. **Phase 2's arc-vs-collision model is new code**, unlike Phase 1 (pure
   glue). `env840_run_seam_wedge_slice_loop` is a proven *walking* gravity
   integrator template but has not been used for a ballistic (non-grounded
   launch) arc against arbitrary terrain/building geometry — treat as a
   genuine implementation task, not a copy-paste.
7. **`isDropEdge`'s FLOOR_Z/DROP_ANGLE_DEG thresholds (§2c) already have one
   documented false-positive class** (apartment z-stack, HANDOFF-wedge-closeout
   Track E3/F Venue 2) even before any jump-routing logic is added — Phase 3
   inherits that fragility and should not assume the existing drop/no-drop
   geometric classification is trustworthy ground truth for where a jump edge
   even needs to be generated.

---

## Sources consulted (for reproducibility)

- `/home/wbterminal/ac-headers/acclient.c` (symbols: `MovementSystem::GetJumpHeight`
  713806, `CACQualities::InqJumpVelocity` 443773-443843, `CMotionInterp::
  get_leave_ground_velocity` 343800, `CMotionInterp::charge_jump` 343845,
  `CMotionInterp::get_jump_v_z` 343343, `CPhysicsObj::on_ground` 343373,
  `CPhysicsObj::calc_acceleration` 317787, `CPhysicsObj::UpdatePhysicsInternal`
  317701, `ClientCombatSystem::CommenceJump`/`DoJump` 407950-408260,
  `PhysicsGlobals::gravity` 45824, `MIN_JUMP_EXTENT` 41626)
- `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/protocol.xml`
  (`Movement_Jump`/`JumpPack` 431,6391-6398,7392; `Movement_VectorUpdate`
  158,8323-8327), `Enums/{S2CMessageType,GameActionType}.generated.cs`
- `/home/wbterminal/ace-server/Source/ACE.Server/Network/GameAction/Actions/GameActionJump.cs`,
  `.../Network/Structure/JumpPack.cs`, `.../WorldObjects/Player.cs:866-958`,
  `.../Physics/Animation/MovementSystem.cs`,
  `.../Network/GameMessages/Messages/GameMessageVectorUpdate.cs`
- `apps/holtburger-web/rynth/{indoor_router,goto_compose,bot,nav_file,
  nav_import,router,route_recorder}.js`, `pkg/holtburger_web.d.ts`
- `crates/holtburger-world/{src/player/types.rs,examples/route_validate.rs,
  src/spatial/env840_seam_tests.rs}`, `crates/holtburger-core/src/client/
  movement/{jump_charge.rs,move_to.rs,stall_recovery.rs}`,
  `crates/holtburger-protocol/{src/messages/movement/actions.rs,src/opcodes.rs,
  tests/generated_parity.rs}`
- `docs/rynth-integration/{HANDOFF-metanav-2026-07-20.md,
  appendix-navatlas-{A-navmachinery,B-physics}.md,workflow-reports/09.md,
  HANDOFF-wedge-closeout-phi4-rig-2026-07-20.md}`
- `/mnt/wbterminal2/met-corpus/{mudzereli-metaf-sample/vr-bridge-jump.{af,nav},
  mudzereli-metaf-sample/VRTreeJump500Rat.{af,nav}, discord/BGAugGem0-*.af,
  routes-json/*.json, validation-reports/validation-report-1784618249.txt,
  format-spec-source/metaf-project/Navigation/NavNodes/NJump.cs}`
- `/mnt/wbterminal2/ac-discord-archive/_indextest/ac.db` (fts5 MATCH queries:
  `jump AND skill`, `utilitybelt AND jump`, `autonav`, `jump AND land`,
  `navmesh AND edge`, `jump AND connection`, `stamina AND jump`, `jump AND arc`,
  `resume AND jump`, `F74E`)

---

## Phase 1 results (2026-07-21, implementation + live-fire session)

Implemented, tested, and live-fired against the running ACE instance the same
day this doc was written. All code changes are UNCOMMITTED (left in the
working tree per instructions).

### What landed

- **`attemptJumpLeg`** (`apps/holtburger-web/rynth/goto_compose.js`) — the
  Phase 1 leg executor. Turns to `meta.headingDeg` (rate-limited
  `TurnToHeading`, polled), gates on `CanJumpNow()`, holds forward
  (`SetMovementInput`, walk if `holdShift` else run — retail's launch
  velocity is read from whatever motion is active AT THE MOMENT `jump()`
  fires, confirmed directly in `src/lib.rs`'s `SessionCommand::Jump` arm:
  `local_player_runtime_kinematics()` supplies the x/y, so a standstill call
  is a near-vertical hop), fires `Jump(power)`, holds a beat, releases input,
  polls for re-grounding, then a conservative settle pause. Typed failure
  `{ok:false, reason:"jump-unavailable", error}` on any gate/capability miss —
  never throws.
- **`findUpcomingJumpLeg`** (same file) — recognizes a FAILED walk leg as
  jump-adjacent by scanning forward up to `JUMP_LEG_SEARCH_WINDOW=12` legs for
  a `meta.navType==='jmp'` record. Widened from an initial guess of 4 after
  reading the REAL vr-bridge-jump.nav corpus fixture's own compiled leg list
  (`routes-json/mudzereli-metaf-sample__vr-bridge-jump.nav.json`, read
  directly): the first of the file's 14 jump attempts is preceded by a
  5-leg run (`chk`, two real-position `cht` config commands, a sentinel-fixed
  `cht`, a `chk` back near start, a sentinel-fixed `pau`) before the `jmp`
  record itself — a window of 4 would have missed it. Every later attempt's
  own gap is only 3 legs.
- **`routeHasJumps`** (new export) + **`bot.js` `doFollowRoute`** now checks
  `hasPortals || hasJumps` to decide whether a route needs `replayRoute`'s
  recovery branches — a jump-only route (no portal legs at all, e.g. a pure
  gap-crossing fixture) was previously falling through to the plain
  `router.follow` loop, which has no jmp-leg recovery at all and would have
  reported a raw, unexplained `FAILED` on the very first wall stall.
- **`webhost.js`**: added `Jump`, `SetMovementInput`, `CanJumpNow` capability
  wrappers (first rynth-layer callers of these three wasm exports).
- Marker comments retired/updated at the three cited sites (`bot.js:137-138`,
  `goto_compose.js:28`, `indoor_router.js:34-37`): all three now distinguish
  "no jump-feasibility test in ROUTE PLANNING" (still true, Phase 3) from "no
  jump EXECUTION at all" (no longer true as of this phase).

### Field-mapping decisions (Risk #2 was, and partly remains, open)

The corpus records `headingDeg`/`holdShift`/`delayMs`, not a `[0,1]` extent.
This slice's documented choice: `power = clamp(delayMs/1000, 0.05, 1.0)`
(mirrors retail's ~1.0s charge-to-full curve), `holdShift===true -> run:false`
(retail Shift-held-while-moving is WALK, matching this codebase's own
"Always Run" convention elsewhere), and `delayMs` also sets the pre-jump
forward-hold window (clamped 200-1500ms) and contributes a floor to the
post-landing settle pause. This is Phase 1's own calibratable choice, not a
retail-verified fact — flagged as such in the code comments.

### Design-doc claims checked against source/live behavior

- **`?jumpParity=on` is NOT required for `session.jump()`** — contradicts
  this doc's own headline ("gated behind a default-off flag") and §3 Phase 1
  point 1 ("flipping `?jumpParity=on` for bot sessions"). Two corrections,
  verified directly:
  1. `docs/url-flags.md:12,589` — `jumpParity` is now **default ON** (was
     default-off), an escape-hatched flag (`?jumpParity=off`), not the
     default-off flag this doc described.
  2. More importantly, **`?jumpParity=on/off` never gates `session.jump()`
     at all** — read directly in `src/lib.rs`'s
     `Some(SessionCommand::Jump { power })` arm (~line 47581): it unconditionally
     computes velocity from the passed `power` and fires the wire packet, gated
     only on `!w.player.is_airborne` and `motion_allows_jump`. The flag only
     switches which JS code path the KEYBOARD handler uses
     (`jumpChargeCommence/Release` vs. the legacy hold-math calling
     `jump(power)`) — it has no effect on a script calling `session.jump()`
     directly, which is exactly what this executor does. Live-fired with no
     `jumpParity` flag on the URL at all; worked.
- **The corpus's "82m gap in one jump" framing was a misread of the fixture.**
  Re-reading the compiled leg list directly (routes-json) shows landing
  checkpoints creep CLOSER across the 14 attempts (attempt 1 lands ~5m from
  the start; attempt 13 lands EXACTLY on the recorded target). Only attempt 1
  resets from the true start; attempts 2-14 chain from wherever the PREVIOUS
  attempt left the character. This is a multi-hop "leapfrog" gap crossing —
  14 progressively-refined short jumps, not 14 independent attempts at a
  single 82m leap. No single retail jump could physically cover 82m anyway
  (live-confirmed below); this reframes the fixture as calibration evidence
  of the CHAINED, not the raw, gap distance.

### Live-fire outcome

Gate: polled `chrome-freeze-repro-profile` every notification cycle; it
exited on its own before the 60-minute bound. serve.py (200) and ACE (pid
837996, 3+ days uptime) were live and untouched throughout.

Two live attempts, both against the real running ACE instance, headless
chromium (`?nullRender=1&renderOnDemand=1&netDrainHz=30&nosw=1&autoLogin=1&account=phase4demo&password=phase4demo&autoSpawn=first&agent=1&bot=1&botAi=off`,
no `jumpParity` flag needed — see above), `@teleloc`'d to the fixture's exact
takeoff checkpoint (`0xB64B0001 107.152... 168.332... 116.005...`, world
frame (35051.15,14568.33,116.005) — matches the corpus/oracle exactly), route
imported via `window.rynthImportNav` on the raw `vr-bridge-jump.nav` text
(73 legs, exact `jmp` warnings as expected).

1. **Attempt 1 params (heading=185°, holdShift=true, delayMs=400 ->
   power=0.4, walk gait)**, fresh from the true start (82m from target): the
   ordinary walk leg stalled at the ledge as predicted (~35s to the leg
   watchdog, matching the offline oracle's `FAILED-AT-LEG 1 (wall)`
   `achieved=0.27m/required=81.99m`), then `attemptJumpLeg` fired. Live pose
   telemetry showed a dramatic, fast Z drop (116 -> ~93 -> ~67 -> settling
   near z=10, ~106m below the takeoff ledge) with the object's LandCell
   changing across the fall — consistent with the character going OFF the
   bridge into the canyon below rather than clearing the gap. `replayRoute`
   correctly resumed past the jmp leg and then genuinely failed again several
   legs later trying to walk from the canyon floor toward the recorded
   post-jump waypoints (`{"ok":false,"state":"FAILED","leg":8,"legsWalked":2}`)
   — an honest walk-timeout, not a jump-unavailable typed failure. (Caveat:
   this run's own `session.jump` instrumentation was mis-wired — patched
   `window.__sessionHandle.jump` AFTER `RynthWebHost` had already
   `.bind()`-captured the original function at construction time, so it
   never observed the call. Fixed for attempt 2.)
2. **Attempt 14 params (heading=120°, holdShift=false, delayMs=1200 ->
   power=1.0, run gait) — the strongest recorded jump in the corpus** —
   fired directly from the true start (not chained, unlike the corpus's own
   attempt 14) as a fresh 2-leg route in the SAME live session. With the
   instrumentation fixed (patched `window.__bot.host.Jump`, the actual call
   site `attemptJumpLeg` uses), the wire call was directly observed:
   `{"power":1,"pose":{"x":117.18,"y":185.21,"z":116,...}}` — **confirms
   `Jump()`/the wasm `SessionCommand::Jump` arm/the `0xF61B` wire packet
   fired**, in flight ~19.6m of forward-hold movement after the leg-1 stall
   began. Subsequent pose samples show a genuine ballistic arc — Z rising to
   ~121.97 then settling back to 116 within ~2s, NOT a fall — landing
   ~26.2m from the takeoff point (still well short of the 82m full gap, as
   expected once the chained-attempts framing above is understood).
   `replayRoute` returned `{"ok":true,"state":"DONE","legsWalked":1}` (the
   2-leg test route had nothing left to walk after the jmp leg).

**Verdict: the jump fires (0xF61B confirmed via the actual wasm call site,
not just an inference from movement), a real physics arc executes (rise then
fall, not a teleport or stub), and the executor's find/fire/resume mechanics
work correctly end-to-end live against ACE** — including advancing past the
jmp leg and either continuing the walk (attempt 1) or terminating cleanly
(attempt 14, no legs left). This closes Risk #1 ("nobody has fired
`session.jump()` from an autonomous script... and measured where the bot
actually lands") — both landings were measured, and both are real, physically
plausible outcomes, not aborts or silent no-ops.

**New open finding (heading-mapping, NOT resolved this session):** attempt
14's actual displacement bearing, computed from the raw pose delta
(dx=+13.3, dy=+22.6 -> `atan2(dx,dy)` ~= 30° in this engine's own
`combat_loop.js`-documented convention), diverged by roughly 90° from the
commanded `headingDeg=120°`. Two live samples aren't enough to separate three
candidate explanations: (a) a genuine VTank-vs-engine heading-convention
mismatch (e.g. VTank measuring from a different zero or a different rotation
sense than this engine's compass-bearing `atan2(dx,dy)`), (b) the rate-limited
`TurnToHeading` not fully converging before the forward-hold + jump fired
(the turn loop's own tolerance/timeout weren't independently verified live —
`pose.heading` at fire time wasn't captured in either run's telemetry), or
(c) residual momentum from the pre-jump `MoveToPosition` walk (which was
steering toward the jmp leg's own coordinate, a different bearing) bleeding
into the launch velocity alongside the intended forward-hold. This is flagged
as the load-bearing unknown for Phase 2's arc-calibration work — Risk #2's
"charge-power-to-corpus-field mapping is undetermined" turns out to have a
sibling: the heading mapping is ALSO unverified, not just the power/charge
one. Recommended follow-up: a live probe that logs `pose.heading` at
`TurnToHeading`-loop-exit and at `Jump()`-call time on the SAME line, isolated
from any preceding walk-driven turn.

### Test counts

- `rynth_goto_compose_test.cjs`: 108 -> **127** passing (19 new: 2 `routeHasJumps`
  unit checks + 17 `replayRoute`-level jmp-leg behavior tests, including a
  regression lock built directly from the real vr-bridge-jump.nav corpus leg
  shape, a stale-pkg/missing-capability degrade test, a `canJumpNow()`-false
  typed-failure test, and a "no jmp leg nearby -> unchanged terminal failure"
  control proving zero behavior change for jmp-less routes).
- Full node rynth suite (`rynth_test_all_node.cjs`): **37 passed / 0 failed /
  2 skipped** — unchanged from the pre-session baseline (same 2 pre-existing
  live-only skips: `rynth_arwic_coverage_test.cjs` needs a live sidecar,
  `rynth_router_smoke.cjs` needs playwright installed globally — note
  playwright-core WAS available, just not on the default resolution path;
  found at `~/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core` and
  used via `NODE_PATH` for the live-fire driver itself).
