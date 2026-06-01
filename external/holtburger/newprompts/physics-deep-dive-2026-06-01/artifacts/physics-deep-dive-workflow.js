export const meta = {
  name: 'physics-deep-dive',
  description: 'Deep, adversarially-verified comparison of holtburger player-movement physics vs decompiled retail AC / ACE',
  phases: [
    { title: 'Investigate', detail: 'one deep-dive agent per physics dimension, reading OURS + retail/ACE source' },
    { title: 'Verify', detail: 'adversarial skeptic per claim, independently re-reads both sides to refute' },
  ],
}

const OURS = '/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger'
const DECOMP = '/home/wbterminal/ac-headers' // acclient.c (31MB decompiled C), acclient.h (structs/enums), acclient.txt (cvdump)
const ACE = '/home/wbterminal/WorldBuilder-ACME-Edition/external/ACE/Source/ACE.Server/Physics'

const PREAMBLE = `You are doing a DEEP, code-grounded comparison of ONE dimension of PLAYER-MOVEMENT PHYSICS between (A) our Asheron's Call reimplementation and (B) the original decompiled retail AC client.

Paths:
- OURS = ${OURS}  (Rust crates under crates/, browser 3D client under apps/holtburger-web/)
- DECOMP = ${DECOMP}/acclient.c (decompiled C), acclient.h (6936 structs / 348 enums), acclient.txt (82MB cvdump symbols — grep for symbol names/offsets)
- ACE = ${ACE}  (ACE is a FAITHFUL C# 1:1 port of retail physics — use it as the readable proxy and cross-check acclient.c against it)
- Also available: ${OURS}/../DatReaderWriter, ${OURS}/../chorizite, ${OURS}/../melt

CRITICAL CONTEXT: Our system has TWO physics layers — (1) a Rust/wasm AUTHORITATIVE integrator in crates/holtburger-core/src/client/movement/system.rs + crates/holtburger-world/, and (2) a SEPARATE JS dead-reckon predictor in apps/holtburger-web/scene3d/camera.js. Account for both where relevant to your dimension.

METHOD: Read the ACTUAL source on BOTH sides. Quote exact code with file:line. Do NOT trust any prior summary or the hypotheses below — verify each in source; confirm, refute, or refine it. Where acclient.c is obfuscated, cross-check the ACE port and acclient.h structs. Use grep/Read aggressively.

OUTPUT: Return structured findings. Each CLAIM must be a SPECIFIC, CHECKABLE factual statement classified as match | divergence | gap | risk, with code evidence (file, line-range, short snippet) from OURS and from RETAIL/ACE, plus a confidence and an impact rating. Produce 5-8 of the most important, precise claims (not vague ones). Also list genuine open questions you could not resolve from source.`

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dimension', 'summary', 'claims', 'open_questions'],
  properties: {
    dimension: { type: 'string' },
    summary: { type: 'string', description: 'one-paragraph bottom line for this dimension' },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'statement', 'kind', 'ours', 'retail', 'confidence', 'impact'],
        properties: {
          id: { type: 'string', description: 'short slug, e.g. quantum-subdivision' },
          statement: { type: 'string', description: 'specific checkable factual claim' },
          kind: { type: 'string', enum: ['match', 'divergence', 'gap', 'risk'] },
          ours: {
            type: 'object', additionalProperties: false,
            required: ['file', 'lines', 'snippet'],
            properties: { file: { type: 'string' }, lines: { type: 'string' }, snippet: { type: 'string' } },
          },
          retail: {
            type: 'object', additionalProperties: false,
            required: ['file', 'lines', 'snippet'],
            properties: { file: { type: 'string' }, lines: { type: 'string' }, snippet: { type: 'string' } },
          },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          impact: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claim_id', 'verdict', 'reasoning', 'corrections', 'checked'],
  properties: {
    claim_id: { type: 'string' },
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'partially-correct', 'unverifiable'] },
    reasoning: { type: 'string' },
    corrections: { type: 'string', description: 'what the finder got wrong or missed; empty if none' },
    checked: { type: 'string', description: 'file:line you independently opened to verify' },
  },
}

const DIMENSIONS = [
  {
    key: 'integration-loop',
    prompt: `DIMENSION: The integration loop / timestep fidelity.
Read OURS: crates/holtburger-core/src/client/movement/system.rs (focus advance_local_pose_for_manual_drive + the gravity step, roughly lines 580-980) and how the tick is driven from apps/holtburger-web/src/lib.rs (tickMovement / dt source) and the rAF loop in apps/holtburger-web/scene3d/loop.js. Check crates/holtburger-world for any terminal-velocity clamp.
Read RETAIL/ACE: ${ACE}/PhysicsGlobals.cs (Gravity, MinQuantum, MaxQuantum, HugeQuantum, MaxVelocity), ${ACE}/PhysicsObj.cs (update_object, UpdateObjectInternal, UpdatePhysicsInternal — the quantum subdivision while-loop and the position/velocity integration), and cross-check acclient.c (UpdateObjectInternal / UpdatePhysicsInternal / calc_acceleration).
Test these hypotheses (confirm/refute/refine each in source): (a) ours uses a VARIABLE per-frame rAF dt with NO MaxQuantum-style subdivision of large frames; (b) ours integrates gravity with FIRST-ORDER Euler (z += v*dt) and is MISSING the 0.5*a*t^2 position term that retail/ACE use; (c) ours has NO terminal-velocity (50 m/s) clamp; (d) ACE/retail subdivide each frame into <=0.1s quanta with a 1/30 floor and skip frames over HugeQuantum. Quantify the practical consequence (e.g. the documented throttle overshoot).`,
  },
  {
    key: 'collision-transition',
    prompt: `DIMENSION: Collision / transition solver.
Read OURS: crates/holtburger-world/src/spatial/physics.rs (sweep_sphere_against_aabbs, clamp_delta_against_buildings, clamp_delta_against_cell_walls, highest_floor_z_under, capsule constants) and how system.rs applies the lateral clamp + floor-Z snap + cell-AABB net. Note the player capsule radius/height and their source.
Read RETAIL/ACE: ${ACE}/Transition.cs and ${ACE}/Common/Sphere.cs (slide_sphere / collide / step_up / step_down / edge_slide / cliff handling) plus acclient.c CTransition (find_valid_position, find_transitional_position, step_up, step_down, edge_slide, cliff_slide, calc_num_steps) and CSphere::slide_sphere. Find the step-up/step-down heights and the walkable-slope threshold (LandingZ/FloorZ in PhysicsGlobals.cs; ~0.985 cos in acclient.c).
Test: (a) ours uses swept-sphere vs AABB (buildings) + swept-capsule vs triangles (cells) + cylinder vs entities, with NO BSP tree; (b) ours has NO step-up/step-down climbing and NO edge_slide/cliff_slide; (c) ours relies on a cell-AABB rubberband net indoors as a safety fallback. How faithful is the sliding (velocity-component-removal) vs retail? What gameplay-visible behaviors (stairs, ledges, slope-sliding) differ?`,
  },
  {
    key: 'friction-smoothing',
    prompt: `DIMENSION: Friction & grounded velocity smoothing.
Read OURS: crates/holtburger-core/src/client/movement/system.rs grounded branch (the (1-F)^dt scale, accel cap, snap — roughly lines 620-720) and crates/holtburger-core/src/client/movement/common.rs (PLAYER_GROUND_FRICTION_PER_SEC=0.5, PLAYER_LATERAL_ACCELERATION_CAP_M_PER_SEC_SQ=8.0, PLAYER_VELOCITY_SNAP_THRESHOLD=0.25, and the long doc comments citing PhatSDK).
Read RETAIL/ACE: ${ACE}/PhysicsObj.cs calc_friction (contact-plane projection, DefaultFriction=0.95, Sledding branches, the 0.25 angle threshold, the 0.99999536 slope normal) and acclient.c CPhysicsObj::calc_friction. Also PhysicsGlobals.cs DefaultFriction/SmallVelocity.
Test: (a) ours matches retail's friction FORM v*=(1-f)^quantum exactly but uses f=0.5 vs retail 0.95 — a deliberate softening; (b) ours adds an 8 m/s^2 lateral accel cap that retail does NOT have; (c) the 0.25 small-velocity snap matches retail SmallVelocity; (d) does ours replicate retail's contact-plane normal-component removal before damping, or skip it? Assess how different the resulting stop/start feel is.`,
  },
  {
    key: 'jump-fall-statemachine',
    prompt: `DIMENSION: Jump, falling, landing, and fall damage.
Read OURS: crates/holtburger-world/src/player/types.rs (compute_jump_velocity_z, begin_jump/begin_fall/land, is_jumping/is_airborne, LEDGE_FALL_THRESHOLD_M, fall-damage DAMAGE_SCALE ~87.29 and its formula) and the falling/landing motion emission in apps/holtburger-web/src/lib.rs (Falling 0x40000015 / Fallen 0x40000008 edges) and system.rs walked-off-ledge detection.
Read RETAIL/ACE: ${ACE}/Animation/MovementSystem.cs GetJumpHeight, ${ACE}/Common/WeenieObject.cs InqJumpVelocity (v=sqrt(h*19.6)), ${ACE}/Animation/MotionInterp.cs get_jump_v_z/jump, ${ACE}/Common/EncumbranceSystem.cs GetBurdenMod; and acclient.c MovementSystem::GetJumpHeight (~line 713823), CMotionInterp::get_jump_v_z. For fall damage, find ACE's Player fall-damage path (search for fall damage / collision velocity).
Test: (a) our jump height + velocity formula is BIT-IDENTICAL to ACE/retail (burdenMod, /(skill+1300)*22.2+0.05, 0.35 floor, sqrt(h*19.6)); (b) our falling/landing state machine vs retail's (does retail even have a distinct 'Jump' motion clip? Wave audit said cmd_low 0x003B absent from all motion tables); (c) is our fall-damage formula sourced from ACE/retail or invented? Quote both.`,
  },
  {
    key: 'dual-predictor',
    prompt: `DIMENSION: The dual-predictor architecture (JS dead-reckon vs Rust integrator) — an architecture/correctness review.
Read OURS: apps/holtburger-web/scene3d/camera.js (_advancePrediction, _reconcilePrediction, _applyPredictionLerp, predictedPlayerPos, the RUN_SPEED/WALK_SPEED constants and where they come from — window.__movementConstants, the 150ms lerp, the 5m teleport-snap) and apps/holtburger-web/scene3d/loop.js (applyLocalPlayerPoseFromIntegrator — which axes come from predictedPlayerPos vs getLocalPlayerPose, the local-player KIND_POSITION skip). Also the wasm getLocalPlayerPose / get_last_client_prediction / set_last_client_prediction exports.
Read RETAIL/ACE: retail has a SINGLE CPhysicsObj — there is no second predictor. In acclient.c look at how the client predicts locally (CMotionInterp::DoInterpretedMotion) and how server corrections arrive (PositionManager / InterpolationManager). ACE is server-authoritative (${ACE}/PhysicsObj.cs UpdateObjectInternal).
Test: (a) X/Y are driven by the JS predictor while Z+heading come from the Rust integrator — confirm exactly which axis is owned where; (b) the JS predictor uses RUN=4.5/WALK=1.0 constants that may DISAGREE with the Rust integrator's MotionTable-derived speeds — is this a real divergence and can the two visibly fight during the 150ms lerp? (c) is the JS WALK=1.0 a live value or a stale fallback? (d) does having two predictors create any correctness risk retail doesn't have? Be concrete.`,
  },
  {
    key: 'motion-velocity-source',
    prompt: `DIMENSION: Where movement SPEEDS come from (animation-driven motion) + locomotion composition.
Read OURS: crates/holtburger-world/src/state/self_movement.rs (base_walk_forward_velocity / base_run_forward_velocity are derived from the MotionTable via SelfMovementKinematics; resolved_manual_run_speed = base * run_rate_scalar) and crates/holtburger-world/src/state/motion_resolution.rs (how the MotionTable is resolved). Then common.rs forward_axis_speed/sidestep_axis_speed/local_velocity_for_state (diagonal composition of forward+sidestep slots, sidestep ±3.0 cap, walk->run motion-code SWAP at forward_command_for_state, turn-in-place gating).
Read RETAIL/ACE: ${ACE}/Animation/MotionInterp.cs get_state_velocity (RunAnimSpeed=4.0, WalkAnimSpeed=3.12, SidestepAnimSpeed=1.25, MaxSidestepAnimRate=3.0, the maxSpeed=RunAnimSpeed*rate clamp), apply_run_to_command, and InterpretedMotionState (forward/sidestep/turn slots). acclient.c CMotionInterp get_state_velocity / apply_run_to_command (~343463-343506).
Test: (a) ours derives walk/run base speed from the DAT MotionTable whereas retail/ACE multiply HARDCODED anim-speed constants (4.0/3.12/1.25) by the motion-table ForwardSpeed scalar — are the resulting m/s values actually equal, or does our data source diverge? (b) confirm the walk->run motion-code swap matches retail (distinct clips, not speed variants); (c) confirm diagonal = geometric sum of two slots matches retail's independent contributions; (d) is the FALLBACK_RUN_RATE_SCALAR=4.5 ever used when MotionTable is present?`,
  },
  {
    key: 'server-reconciliation',
    prompt: `DIMENSION: Server reconciliation, autonomous position, and forced reposition.
Read OURS: crates/holtburger-core/src/client/movement/system.rs (AUTONOMOUS_POSITION_HEARTBEAT_INTERVAL, the heartbeat send, pending_snap_facing / execute_snap_facing, force-position handling) plus how inbound PositionUpdate / forced reposition is applied (grep for ForcePosition, PlayerTeleport, force_position_sequence, handlePositionUpdate) across holtburger-core/holtburger-world and apps/holtburger-web.
Read RETAIL/ACE: how retail sends autonomous position to the server and how the server force-positions the client. In acclient.c look for CClientNetEvents / Position update opcodes, PositionManager, InterpolationManager, and the autonomous-vs-server position flags. In ACE look at ${ACE}/.. Player physics update + ServerObject position broadcast cadence (PublicUpdatePosition / ForcePosition).
Test: (a) our heartbeat cadence + autonomous-position contract vs retail's; (b) how forced reposition / teleport snaps the local predictor and resets prediction; (c) the documented 'moves a little, snaps back' rubberband history — is the current gating retail-plausible? (d) does our model respect retail's client-authoritative-position-with-server-veto design, or is it more server-push?`,
  },
]

function verifyPrompt(c, dimKey) {
  return `Adversarially verify ONE claim from a deep physics comparison (dimension: ${dimKey}). Your DEFAULT STANCE IS SKEPTICAL — actively try to REFUTE it. Independently re-open the cited code in BOTH our codebase and the retail/ACE source; do NOT trust the finder's quoted snippets — read the files yourself and check the surrounding context for anything the finder missed.

Paths:
- OURS = ${OURS}
- DECOMP = ${DECOMP}/acclient.c, acclient.h, acclient.txt
- ACE = ${ACE}

CLAIM (kind=${c.kind}, finder confidence=${c.confidence}): ${c.statement}
Finder's evidence — OURS: ${c.ours.file}:${c.ours.lines}  |  RETAIL/ACE: ${c.retail.file}:${c.retail.lines}

Decide: Is the claim factually accurate as stated? Are the constants, line refs, and code forms real and current in the source today? Did the finder MISS code that changes the conclusion (e.g. a clamp, a subdivision loop, a term, a fallback that's never hit)? Is the match/divergence/gap/risk classification correct, or overstated/understated?

Return: verdict = confirmed | refuted | partially-correct | unverifiable, with crisp reasoning, explicit corrections (what's wrong or missed; empty string if none), and the exact file:line you independently opened.`
}

phase('Investigate')
log(`Deep-diving ${DIMENSIONS.length} physics dimensions, each reading ours + retail/ACE...`)

const results = await pipeline(
  DIMENSIONS,
  (d) => agent(`${PREAMBLE}\n\n${d.prompt}`, { label: `find:${d.key}`, phase: 'Investigate', schema: FINDING_SCHEMA }),
  (finding, d) => {
    const claims = (finding && Array.isArray(finding.claims)) ? finding.claims : []
    log(`[${d.key}] ${claims.length} claims → adversarial verify`)
    return parallel(
      claims.map((c) => () =>
        agent(verifyPrompt(c, d.key), { label: `verify:${d.key}:${c.id}`, phase: 'Verify', schema: VERDICT_SCHEMA })
          .then((v) => ({ ...c, verdict: v }))
          .catch(() => ({ ...c, verdict: { claim_id: c.id, verdict: 'unverifiable', reasoning: 'verifier errored', corrections: '', checked: '' } }))
      )
    ).then((verifiedClaims) => ({ dimension: d.key, summary: finding.summary, claims: verifiedClaims, open_questions: finding.open_questions || [] }))
  }
)

const clean = results.filter(Boolean)
const allClaims = clean.flatMap((r) => r.claims)
const tally = allClaims.reduce((acc, c) => { const v = c.verdict?.verdict || 'unverifiable'; acc[v] = (acc[v] || 0) + 1; return acc }, {})
log(`Done. ${allClaims.length} claims across ${clean.length} dimensions. Verdicts: ${JSON.stringify(tally)}`)

return { dimensions: clean, tally }
