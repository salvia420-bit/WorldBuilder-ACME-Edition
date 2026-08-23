using System;
using System.Collections.Generic;
using ACBindings.Internal;
using AcmeRagdoll.Lib;
using AcmeRagdoll.Sim;
using Chorizite.ACProtocol.Messages.S2C;
using Chorizite.ACProtocol.Messages.S2C.Events;
using Microsoft.Extensions.Logging;

namespace AcmeRagdoll.Services {
    /// <summary>
    /// LIVE-MOTION layer, stage C1: signal plumbing + per-object state skeleton. Sibling of (and
    /// completely independent from) <see cref="RagdollRegistry"/>, which owns DEAD bodies; this one
    /// owns LIVING bodies that have just been hit. Both are dispatched from the same
    /// <c>CPartArray::UpdateParts</c> post-detour and both vote on whether that hot detour is armed
    /// (see <see cref="NativeHooks.SetUpdatePartsEnabledLive"/>).
    ///
    /// C1 SCOPE (landed). This class receives the two network hit signals, correlates them, decides
    /// which object each hit landed on, excludes players, and parks the resulting impulse on a
    /// per-object entry.
    ///
    /// C2 SCOPE (this stage) - the hit-reaction physics, all of it inside
    /// <see cref="OnUpdateParts"/>, running AFTER the client has written the freshly animated pose:
    ///   * IMPULSE INTAKE. Each pending hit becomes an energy quantum
    ///     <c>e = <see cref="LiveMotionTuning.EnergyPerDamagePercent"/> * DamagePercent</c> and a per-part velocity
    ///     kick along the splatter's decoded direction plus a small downward settle. The energy goes
    ///     into a per-body POOL with a hard cap: hits past the cap refresh the (wall-clock,
    ///     exponential, <see cref="LiveMotionTuning.PoolHalfLifeSec"/>-half-life) decay rather than growing it, which
    ///     is what keeps a 10-attacker boss swarm from exploding. A CRIT multiplies the impulse by
    ///     <see cref="LiveMotionTuning.CritImpulseMult"/>, but only the EXTRA is refractory-gated
    ///     (<see cref="LiveMotionTuning.CritRefractoryMillis"/> per body) - the base impulse of a crit always lands.
    ///   * SPRING. Per part, per frame, TRANSLATION ONLY (rotation wobble is a later polish):
    ///     <c>offset += vel*dt; vel += (-k*offset - c*vel)*dt</c>, substepped for stability, with the
    ///     visible amplitude scaled by a smoothstep of the pool so a reaction fades out instead of
    ///     stopping. Quaternions are NEVER touched in C2.
    ///   * PER-PART WEIGHTING. Extremities loose, core stiff. Until the Tier-0 role data ships, the
    ///     weight is STRUCTURAL - parent-chain depth in the Setup's ParentIndex graph - and a body
    ///     whose profile carries the optional <c>"parts"</c> looseness array
    ///     (<see cref="RagdollProfiles.PartWeights"/>) overrides the heuristic per part. That array
    ///     is the one seam the role data plugs into; nothing else in this file changes when it lands.
    ///   * SAFETY. Every part's offset is clamped to <see cref="LiveMotionTuning.AmplitudeFrac"/> of the body's own
    ///     radius (measured from the live part spread, which already includes <c>pa-&gt;scale</c>),
    ///     and the whole layer is attenuated to <see cref="LiveMotionTuning.AttackAttenuation"/> while the body's own
    ///     current motion is attack-class (<see cref="OnMotion"/>), so an attack telegraph stays
    ///     readable under fire.
    ///   * RETIREMENT. Pool below epsilon AND every offset/velocity below epsilon =&gt; the entry is
    ///     removed and the layer's vote drops, so the hot detour disarms as soon as things go quiet.
    ///
    /// C3 SCOPE (this stage) - LIVE TUNING. Every physics number above now comes from an immutable
    /// <see cref="LiveMotionTuning"/> snapshot, re-read from <c>ragdoll.cfg</c> at most once a second
    /// by <see cref="LiveMotionConfig"/> (see that file for the knobs, the defaults and the file
    /// format). Three rules make that safe on this thread:
    ///   * THE POLL LIVES ON PATHS THE LAYER ALREADY RUNS - the top of <see cref="OnUpdateParts"/>
    ///     (i.e. the UpdateParts detour tail, the only per-frame path this plugin owns) and the top of
    ///     the two net handlers. No new thread, no new detour, no timer, and no file IO at all in the
    ///     common case: the 1/s tick only stats the file and re-parses when it actually changed.
    ///   * A FRAME READS THE SNAPSHOT ONCE and threads that one instance through every method that
    ///     needs a number, so an edit landing between two statements can never be half-applied.
    ///   * THE <c>livemotion</c> KNOB IS A RUNTIME SWITCH. Turning it off retires every entry, clears
    ///     the correlation rings and drops the layer's vote (so the hot detour disarms and no part is
    ///     ever touched again); turning it on starts from that clean slate. It is NOT the C1
    ///     bit-identity switch - <c>RagdollSettings.liveMotion</c> still is, and with that false this
    ///     class is never constructed, never subscribed and never polls anything.
    ///
    /// C4 SCOPE (this stage) - IDLE MICRO-MOTION. A second, much smaller oscillation that shares
    /// EVERYTHING with the hit layer: the same per-part offset budget, the same amplitude clamp, the
    /// same epsilon gate and the same single <see cref="WriteOffsets"/> write path. The shape is
    /// archetype-driven (<see cref="AcmeRagdoll.Sim.IdleMotion"/>, which owns all of the math):
    /// breathing for the walking archetypes, a whole-body bob plus a very slow cloak/tentacle sway for
    /// floaters, a looseness-scaled pulse for blobs, and NOTHING AT ALL for props. Three rules bound
    /// it:
    ///   * IT ONLY RUNS WHILE THE BODY'S OWN CURRENT MOTION IS IDLE-CLASS. Same latch the attack
    ///     attenuation uses (<see cref="OnMotion"/>), extended with the idle command set; a body that
    ///     is walking, swinging or casting does not breathe on top of it.
    ///   * IT NEVER ARMS THE HOT DETOUR BY ITSELF. Idle motion is only ever computed for a body that
    ///     the HIT layer already has an entry for. To make that visible rather than theoretical, an
    ///     entry whose springs have settled now LINGERS for <c>idlelingersec</c> (default 30 s) after
    ///     its last hit instead of retiring immediately - so a creature you just fought breathes, and
    ///     then goes quiet and retires normally. World-wide ambient idle motion would mean keeping the
    ///     UpdateParts detour armed for every creature in the world, permanently; that is a 1070
    ///     MEASUREMENT, not a coding decision, and is deliberately not in C4 (README).
    ///   * IT BLENDS UNDER THE HIT SPRINGS ADDITIVELY. The two offsets are summed per part and the SUM
    ///     is clamped to the one amplitude limit, so a body that is being hit while idling never
    ///     exceeds the flinch budget - the breath just rides underneath.
    /// With <c>idlemotion = 0</c> the layer is bit-identical to C3: no idle offset is computed, the
    /// combine collapses to the pre-C4 multiply, and the linger term of the retirement test is false.
    ///
    /// C5 SCOPE (this stage, PROTOTYPE, first-to-cut) - PROCEDURAL TRIPOD GAIT on ONE hexapod body,
    /// behind <c>gait</c> (DEFAULT OFF). A third oscillation, structurally identical to C4's: its own
    /// buffer, the same amplitude clamp, summed into the same one write path. All of the math lives in
    /// <see cref="AcmeRagdoll.Sim.GaitMotion"/> (pure, harness-drivable); this class contributes only
    /// the three things that need the client:
    ///   * WHICH BODY. <see cref="AcmeRagdoll.Sim.GaitMotion.TargetSetupDid"/> is hard-coded, resolved
    ///     once per entry beside the idle shape. Every other body is untouched with <c>gait = 1</c>.
    ///   * WHEN. Only while the body's OWN current motion is LOCOMOTION-class - the same
    ///     <see cref="OnMotion"/> latch as the attack attenuation and the idle breath, third class
    ///     (<see cref="IsLocomotionMotion"/>). A standing, swinging or casting body does not step.
    ///   * HOW FAST. The cadence is scaled by the body's measured ground speed, sampled from
    ///     <c>m_position</c> across frames (<see cref="UpdateGaitSpeed"/>) with a cell-handoff guard,
    ///     falling back to the bare <c>gaitcadence</c> knob whenever no sample is available.
    /// It NEVER ARMS THE HOT DETOUR BY ITSELF - same rule as idle motion, and for the same reason: it
    /// runs only on bodies the HIT layer already tracks, and it deliberately does NOT extend the
    /// retirement linger (that knob stays C4's alone, so this prototype cannot raise the layer's cost).
    /// In practice the overlay is seen on an Olthoi you have just fought, walking away, inside the
    /// <c>idlelingersec</c> window. With <c>gait = 0</c> not one float of it is evaluated.
    ///
    /// THE TWO SIGNALS (C0 report §5, the managed route - no new native detour):
    ///   H1 <c>Effects_PlayScriptType</c> (0xF755) -&gt; {ObjectId, ScriptType, Speed}. The ONLY signal
    ///      that names the object that got hit. <c>ScriptType</c> in 0x5B..0x66 is the PS_Splatter*
    ///      block, and the value itself encodes the geometry of the hit (see
    ///      <see cref="DecodeSplatter"/>). This alone is a complete, damage-blind hit reaction.
    ///   H2 <c>Combat_HandleAttackerNotificationEvent</c> (GameEvent 0x01B1) -&gt; {DefenderName, Type,
    ///      DamagePercent, Damage, Critical, AttackConditions}. The ONLY signal carrying damage and
    ///      the crit flag - and it identifies its target by NAME ONLY, never by GUID (true on the
    ///      wire AND in the retail client's own handler). So it can enrich a hit, never trigger one.
    ///
    /// CORRELATION (C0 report §5.4) is order-agnostic. H1 and H2 travel in different ACE ordered
    /// queues (SmartboxQueue vs UIQueue) and same-packet delivery could not be proven statically, so
    /// neither is allowed to assume it arrives first:
    ///   * H1 publishes its impulse IMMEDIATELY (never delayed waiting for a damage number) with
    ///     <see cref="LiveMotionTuning.DefaultDamagePercent"/>, records itself in <see cref="_splatRing"/>, and looks
    ///     back through <see cref="_dmgRing"/> for an unmatched H2 within +/-<see cref="WindowMillis"/>;
    ///   * H2 looks back through <see cref="_splatRing"/> for an unmatched H1 in the same window and,
    ///     on a hit, re-finds that exact impulse by (objectId, seq) and fills in its damage/crit;
    ///     with no match it parks itself in <see cref="_dmgRing"/> for an H1 that has yet to arrive.
    ///   * Each ring slot is consumed at most once ("Matched"), and ambiguity between simultaneous
    ///     hits is resolved nearest-in-time. A damage number that never finds its splatter is simply
    ///     dropped; a splatter that never finds its damage still produces a visible reaction.
    ///
    /// AUDIENCE CAVEAT (C0 report §4.4, ACE-specific and load-bearing): on the ACE server we run,
    /// PS_Splatter* for MY melee/missile hits is sent privately to me, other players' melee/missile
    /// hits never reach me, monster-vs-player and monster-vs-monster splatters are broadcast, and any
    /// spell's target effect is broadcast. So splatters DO legitimately arrive carrying player object
    /// ids - the <see cref="IsPlayerObject"/> exclusion is required behaviour, not paranoia.
    ///
    /// THREADING. The C0 report shows (high confidence, one open question) that the net handlers and
    /// the UpdateParts detour all run on the client's single sim thread. It is not proven, so this
    /// class is written as if they might not: every mutation of <see cref="_live"/> and of the two
    /// rings happens under <see cref="_gate"/>. The hot path pays that lock only after a lock-free
    /// "is there any work at all" check, and the detour is disarmed entirely when there is none.
    /// <see cref="LogThreadIdOnce"/> emits the one-line evidence (C0 §9 open question 1) that closes
    /// the question live: same managed thread id from both sides =&gt; the lock can be dropped.
    ///
    /// POINTER SAFETY follows RagdollRegistry's rules: entries are keyed by the stable object id, the
    /// captured <c>CPhysicsObj*</c> is re-verified against the live owner every frame, no
    /// <c>CPhysicsPart*</c> is ever cached, and entries that stop receiving frames are swept.
    /// </summary>
    internal sealed unsafe class LiveMotionRegistry {
        // ------------------------------------------------------------------ tuning

        /// <summary>PS_Splatter* block, PDB enum PScriptType (typeid 4c05) and ACE PlayScript.cs:96-107,
        /// byte-identical: SplatterLowLeftBack .. SplatterUpRightFront.</summary>
        private const int SplatterMin = 0x5B;
        private const int SplatterMax = 0x66;

        /// <summary>Correlation window for pairing an H1 splatter with an H2 damage notification, in
        /// either arrival order. C0 §5.4 suggests 250-300 ms; the real distribution is measured live
        /// from the CORR log lines below and this becomes a cfg knob in C3.</summary>
        private const long WindowMillis = 300;

        /// <summary>Cap on concurrently-reacting bodies (mirrors RagdollRegistry.MaxLive).</summary>
        private const int MaxLive = 64;

        /// <summary>Per-entry impulse queue depth. A body hit harder than this inside one frame drops
        /// the oldest pending impulse rather than growing - the same "refresh, don't grow" discipline
        /// the C2 energy pool uses.</summary>
        private const int MaxPendingPerEntry = 4;

        /// <summary>Ring depth for each side of the correlation. A handful of hits per 300 ms window
        /// is already a 6-attacker swarm; 16 leaves headroom without ever allocating.</summary>
        private const int RingSize = 16;

        /// <summary>An entry with no new hit for this long is dropped (and with it the layer's vote to
        /// keep the hot detour armed). Long enough to outlive a C2 spring settle.</summary>
        private const long EntryTtlMillis = 4_000;

        /// <summary>An entry whose object never produced an UpdateParts frame (never rendered, or the
        /// splatter named an object we cannot see) is dropped this soon after creation.</summary>
        private const long UnseenTtlMillis = 1_500;

        /// <summary>Sweep throttle for the upkeep pass driven off the (very hot) UpdateParts path.</summary>
        private const long SweepThrottleMillis = 1_000;

        // ------------------------------------------------------------------ tuning (C2 physics)
        //
        // C3: THE PHYSICS NUMBERS NO LONGER LIVE HERE. Every knob a 1070 tuning session touches -
        // springK, springDamp, ampFrac, the energy pool, the crit, the shaping - is a field on the
        // immutable <see cref="LiveMotionTuning"/> snapshot, defaults and rationale comments and all
        // (Lib/LiveMotionConfig.cs), re-read from ragdoll.cfg at most once a second. A frame reads the
        // snapshot ONCE, at the top of OnUpdateParts, and passes that one instance down, so an edit
        // landing mid-frame can never be half-applied.
        //
        // What REMAINS const below is everything that is NOT a look-and-feel knob: array shapes,
        // lifetime windows, numerical-stability limits and the absolute safety guards. Those are
        // deliberately not editable from a text file - a typo in them is a crash or a hang, not an
        // ugly flinch.

        /// <summary>Parent-chain depth at which the structural heuristic calls a part fully loose.
        /// Depth 0 = root (core), 3+ = extremity. Matches AC creature rigs, which are 3-5 deep.</summary>
        private const int DepthFullLoose = 3;

        /// <summary>Absolute guards on the derived amplitude clamp, yd, for degenerate bodies (one
        /// part, all parts coincident, a nonsense scale). These bound <c>ampfrac</c> in ABSOLUTE terms
        /// no matter what the cfg says, which is why they stay compiled in.</summary>
        private const float AmplitudeMinYd = 0.004f;
        private const float AmplitudeMaxYd = 0.35f;

        /// <summary>Below this the offset is not worth a part write, and a part below it is NOT
        /// written and NOT cached. ~0.8 mm - well under a pixel at any sane camera distance, and ~4%
        /// of a human-scale body's clamp, so "quiet" really is zero client writes.</summary>
        private const float WriteEpsilonYd = 0.0008f;

        /// <summary>Energy floor: the pool snaps to exactly zero below this, so a body that is left
        /// alone ends at a clean 0 rather than an ever-shrinking denormal. It is NOT the retirement
        /// threshold - retirement asks whether the pool can still produce a visible offset (see
        /// <see cref="OnUpdateParts"/>), which is the same question expressed in yards.</summary>
        private const float PoolEpsilon = 0.005f;

        /// <summary>Rest thresholds: a part below both is settled. 0.5 mm and 1 cm/s.</summary>
        private const float OffsetEpsilonYd = 0.0005f;
        private const float VelEpsilonYdS = 0.01f;

        /// <summary>Integrator substep cap, seconds. The explicit-position/implicit-velocity pair used
        /// here is stable for dt &lt; 2/omega_n; the stiffest part we author is omega_n ~ 26.5 rad/s
        /// (dt &lt; 75 ms), so 1/60 s substeps leave a 4.5x margin at any client frame rate.</summary>
        private const float SubstepMaxSec = 1f / 60f;

        /// <summary>Whole-frame dt clamp, seconds. A hitch (alt-tab, zone load) must not be integrated
        /// as one enormous step; 1/15 s caps it at 4 substeps and the reaction simply continues.</summary>
        private const float MaxFrameDtSec = 1f / 15f;

        /// <summary>Fast-path player prefilter. On the ACE server we run, ObjectGuid.PlayerMin/Max is
        /// 0x50000001..0x5FFFFFFF, so a top nibble of 5 is a player and we can skip the object
        /// entirely without ever arming the hot detour. This is a SERVER ALLOCATION CONVENTION, not a
        /// client invariant (C0 report §6 note 3), so it is only ever allowed to skip work - the
        /// authoritative answer is the client's own BF_PLAYER bit in <see cref="IsPlayerObject"/>.
        /// A non-ACE server that hands creatures 0x5xxxxxxx ids would cost us reactions, not
        /// correctness; flip this to false there.</summary>
        private const bool UsePlayerGuidPrefilter = true;

        // ------------------------------------------------------------------ state

        /// <summary>One pending hit impulse. Pure value data; C2 consumes these into the spring layer.</summary>
        internal struct PendingImpulse {
            /// <summary>Correlation identity, so a late H2 can find this exact impulse again.</summary>
            public int Seq;
            /// <summary>Raw PS_Splatter* value (0x5B..0x66) this impulse came from - kept for logging
            /// and for C2's "which part row" hint.</summary>
            public int ScriptType;
            /// <summary>Target-LOCAL unit direction to push the body, decoded from the splatter's
            /// attacker quadrant: the impulse pushes AWAY from where the attacker stood.</summary>
            public float DirX, DirY;
            /// <summary>Splatter height band: 0 = Low, 1 = Mid, 2 = Up. C2 biases the impulse toward
            /// the part rows at that height.</summary>
            public byte Height;
            /// <summary>Speed/intensity multiplier the server sent with the script (Effects_PlayScriptType.Speed).</summary>
            public float Speed;
            /// <summary>Fraction of the target's max health removed (0..1). Seeded to
            /// <see cref="LiveMotionTuning.DefaultDamagePercent"/> and overwritten if an H2 correlates. This, not the
            /// absolute Damage, is the impulse scale (C0 §5.2).</summary>
            public float DamagePercent;
            /// <summary>Absolute damage from H2 (diagnostic only - poor scale across level ranges).</summary>
            public uint Damage;
            /// <summary>H2 crit flag; drives C2's rock-back.</summary>
            public bool Critical;
            /// <summary>H2 DamageType, kept as the raw uint so no enum metadata is touched on the
            /// native-originated handler stack.</summary>
            public uint DamageType;
            /// <summary>True once an H2 damage notification correlated to this impulse.</summary>
            public bool Enriched;
            /// <summary>Environment.TickCount64 at H1 arrival.</summary>
            public long Tick;
        }

        /// <summary>Per-object live-motion state. C1 fills identity/lifetime and parks impulses; every
        /// numeric field below is what C2's spring + energy-pool math reads and writes.</summary>
        internal sealed class LiveEntry {
            // ---- identity / lifetime ----
            public uint ObjId;
            /// <summary>Owner captured the first frame we see it; re-verified against the live
            /// <c>pa-&gt;owner</c> every frame so a freed-then-reused id cannot be written through.</summary>
            public CPhysicsObj* Obj;
            /// <summary>Part array captured with <see cref="Obj"/>; a swap means stop touching it.</summary>
            public CPartArray* Parts;
            public long CreatedTick;
            /// <summary>Last UpdateParts frame that touched this entry; 0 = never seen.</summary>
            public long LastTouchTick;
            public long LastHitTick;
            /// <summary>Total impulses ever delivered to this entry (diagnostics).</summary>
            public int HitCount;

            // ---- player exclusion (C0 report §6) ----
            /// <summary>The BF_PLAYER test has run against a real CPhysicsObj*.</summary>
            public bool PlayerChecked;
            /// <summary>Authoritative BF_PLAYER answer. Never arm, never write, when true.</summary>
            public bool IsPlayer;
            /// <summary>Set only after the player test has PASSED. C2 must apply impulses / write
            /// parts only when this is true: creating an entry is not arming it.</summary>
            public bool Armed;

            // ---- pending impulses (C1 fills, C2 drains) ----
            public PendingImpulse[] Pending = new PendingImpulse[MaxPendingPerEntry];
            public int PendingCount;

            // ---- energy pool (C2 math; C1 only declares and zeroes it) ----
            /// <summary>Current reaction energy. Hits past <see cref="PoolCap"/> REFRESH it, they do
            /// not grow it - that is what keeps a 10-attacker boss swarm from exploding.</summary>
            public float Pool;
            /// <summary>Saturation cap for <see cref="Pool"/>; per-body in C2 (profile-driven).</summary>
            public float PoolCap;
            /// <summary>Last tick <see cref="Pool"/> was decayed, so decay is wall-clock exponential
            /// rather than frame-count dependent.</summary>
            public long PoolDecayTick;
            /// <summary>Last crit rock-back, for the per-body refractory (~1 s).</summary>
            public long LastCritTick;
            /// <summary>True while the body's OWN current motion is attack-class, so C2 can attenuate
            /// (~30%) and keep an attack telegraph readable under fire.</summary>
            public bool AttenuateAttack;

            // ---- per-part spring state (allocated once, on the first armed frame) ----
            public int PartCount;
            /// <summary>Per-part OBJECT-LOCAL offset from the freshly animated pose (3 floats/part).
            /// "Object-local" = the space you reach by un-rotating a part's world origin by the object
            /// frame's quaternion, i.e. post-scale, pre-rotate. Storing offsets there (rather than in
            /// world) means a body that TURNS carries its offsets around with it instead of having
            /// them lag, and the splatter direction - which is already expressed relative to the
            /// target's own facing - drops straight in with no conversion.</summary>
            public float[]? Offsets;
            /// <summary>Per-part offset velocity, same space, yd/s (3 floats/part).</summary>
            public float[]? OffsetVel;
            /// <summary>Per-part looseness 0..1 (0 = core/stiff, 1 = extremity/loose). From the
            /// profile's optional "parts" role array where present, else the parent-chain-depth
            /// heuristic. Resolved once per entry.</summary>
            public float[]? Looseness;
            /// <summary>Per-part normalised height 0..1 in the body's own rest span, for the splatter
            /// height bias. Resolved once per entry, from the pose at first sighting.</summary>
            public float[]? NormHeight;
            /// <summary>True once the one-time body metrics (radius/clamp, looseness, heights) have
            /// been measured from a readable pose.</summary>
            public bool MetricsReady;
            /// <summary>The body's own radius, yd: the largest distance from the part centroid to any
            /// part, measured once in the live (post-scale) pose. Kept so <see cref="MaxOffset"/> can
            /// be re-derived every frame from the CURRENT <c>ampfrac</c> - which is what makes the
            /// amplitude knob live-tunable on a body that is already reacting.</summary>
            public float Radius;
            /// <summary>Max |offset| per part, yd: <see cref="LiveMotionTuning.AmplitudeFrac"/> of
            /// <see cref="Radius"/>, clamped to the absolute guards. Refreshed each frame.</summary>
            public float MaxOffset;
            /// <summary>Wall-clock tick of the last integrated frame, for the frame dt.</summary>
            public long LastFrameTick;
            /// <summary>Diagnostics: one line is logged the first time a body actually writes parts.</summary>
            public bool WroteOnce;

            // ---- idle micro-motion (C4; all resolved once, with the body metrics) ----
            /// <summary>Tier-0 archetype from the profile, or <see cref="BodyArchetype.Unknown"/>.
            /// Picks the oscillation SHAPE (breathe / bob+sway / pulse / nothing).</summary>
            public BodyArchetype Archetype;
            /// <summary>Per-part vertical idle weight, 0..1. Null when the body does not idle.</summary>
            public float[]? IdleVert;
            /// <summary>Per-part sway weight for the floater drift, or null when this archetype has no
            /// sway (every archetype but <see cref="BodyArchetype.Floater"/>).</summary>
            public float[]? IdleSway;
            /// <summary>This frame's idle offsets, object-local, same layout and space as
            /// <see cref="Offsets"/>. Kept SEPARATE from the spring state on purpose: the springs must
            /// integrate and settle around zero, and folding a permanent oscillation into them would
            /// mean a body could never satisfy <see cref="IsAtRest"/>. They are summed at write
            /// time.</summary>
            public float[]? IdleOffsets;
            /// <summary>The body can idle at all: an archetype that produces motion and at least one
            /// part with a non-zero weight. False for every prop. Resolved once.</summary>
            public bool IdleEligible;
            /// <summary>True while the body's OWN current motion is idle-class (the second half of the
            /// <see cref="OnMotion"/> latch). Starts FALSE: a body whose motion we have never observed
            /// does not breathe until it tells us it is idling.</summary>
            public bool MotionIdle;
            /// <summary>Carried oscillator phases, radians, seeded per body from the object id and
            /// advanced per frame (never derived from a clock - see
            /// <see cref="AcmeRagdoll.Sim.IdleMotion.AdvancePhase"/>).</summary>
            public float IdlePhase;
            /// <summary>See <see cref="IdlePhase"/>; the floater sway runs slower and separately.</summary>
            public float IdleSwayPhase;
            /// <summary>Diagnostics: one line the first frame this body actually idles.</summary>
            public bool IdleLoggedOnce;

            // ---- C5: procedural tripod gait (all resolved once, with the body metrics) ----
            /// <summary>This body IS the hard-coded C5 target and its part array is the right shape
            /// (<see cref="AcmeRagdoll.Sim.GaitMotion.Applies"/>). False for every other body, which is
            /// what makes <c>gait = 1</c> a no-op everywhere else. Resolved once.</summary>
            public bool GaitEligible;
            /// <summary>This frame's gait offsets, object-local, same layout and space as
            /// <see cref="Offsets"/> and <see cref="IdleOffsets"/>. Its own buffer for the same reason
            /// the idle buffer is its own: the springs must be able to settle to zero, and every part
            /// that is not a leg stays exactly 0 here.</summary>
            public float[]? GaitOffsets;
            /// <summary>True while the body's OWN current motion is locomotion-class (the third class
            /// of the <see cref="OnMotion"/> latch). Starts FALSE: a body whose motion we have never
            /// observed does not step until it tells us it is walking.</summary>
            public bool MotionLocomotion;
            /// <summary>Carried tripod-A phase, radians, seeded per body from the object id and
            /// advanced per frame at the speed-scaled cadence. Tripod B is this + pi, structurally.</summary>
            public float GaitPhase;
            /// <summary>Smoothed ground speed, yd/s, from the per-frame <c>m_position</c> delta.</summary>
            public float GaitSpeed;
            /// <summary><see cref="GaitSpeed"/> came from at least one real sample. False on the first
            /// frame and after a cell handoff, when the cadence falls back to the bare knob.</summary>
            public bool GaitSpeedValid;
            /// <summary>Previous frame's <c>m_position</c> cell and XY, the basis of the speed sample.
            /// An AC object origin is CELL-LOCAL, so a delta is only meaningful within one cell id.</summary>
            public uint GaitCell;
            public float GaitPosX, GaitPosY;
            /// <summary><see cref="GaitCell"/>/<see cref="GaitPosX"/>/<see cref="GaitPosY"/> hold a real
            /// previous sample.</summary>
            public bool GaitPosValid;
            /// <summary>Diagnostics: one line the first frame this body actually steps.</summary>
            public bool GaitLoggedOnce;
        }

        /// <summary>An H1 splatter awaiting a possible H2 enrichment.</summary>
        private struct SplatRec {
            public uint ObjId;
            public int Seq;
            public long Tick;
            public bool Matched;
            public bool Used;      // slot holds a real record
        }

        /// <summary>An H2 damage notification awaiting its H1 splatter.</summary>
        private struct DmgRec {
            public float DamagePercent;
            public uint Damage;
            public uint DamageType;
            public bool Critical;
            public long Tick;
            public bool Matched;
            public bool Used;
        }

        private readonly Dictionary<uint, LiveEntry> _live = new(MaxLive);
        private readonly SplatRec[] _splatRing = new SplatRec[RingSize];
        private readonly DmgRec[] _dmgRing = new DmgRec[RingSize];
        private int _splatNext;
        private int _dmgNext;
        private int _seq;

        private readonly object _gate = new();
        private readonly Action<bool> _setUpdatePartsHook;
        private readonly ILogger _log;
        private volatile bool _down;

        /// <summary>PACING: reusable per-part scratch for <see cref="ComputeBodyMetrics"/>, which is
        /// retried every frame until a body's pose is fully readable. Only ever touched under
        /// <see cref="_gate"/>, and it only ever grows.</summary>
        private float[] _metricsX = Array.Empty<float>();
        private float[] _metricsY = Array.Empty<float>();
        private float[] _metricsZ = Array.Empty<float>();
        private void EnsureMetricsScratch(int n) {
            if (_metricsX.Length >= n) return;
            _metricsX = new float[n];
            _metricsY = new float[n];
            _metricsZ = new float[n];
        }

        /// <summary>C3: the ragdoll.cfg reader. Polled (never on a timer, never on a thread) from the
        /// three paths this layer already runs on; see the class doc.</summary>
        private readonly LiveMotionConfig _cfg;

        /// <summary>The tuning snapshot in force. Volatile because the sim thread and the net handlers
        /// both read it and either may be the one that swaps it; a reference write is atomic, and the
        /// object behind it is never mutated, which together are the whole "no half-applied edit"
        /// guarantee.</summary>
        private volatile LiveMotionTuning _tuning = LiveMotionTuning.Defaults;

        /// <summary>Lock-free "is there anything to do" hint for the hot path. Mirrors
        /// <c>_live.Count</c>, written under <see cref="_gate"/>, read without it.</summary>
        private volatile int _workCount;

        /// <summary>
        /// SINGLE-WRITER GATE. "Does the DEATH registry own this object id?" - bound once, on the
        /// managed Initialize() thread, to <see cref="RagdollRegistry.IsDeathOwned"/> (null only in the
        /// warmup harness and in unit-style drives).
        ///
        /// A dying body must be animated by exactly ONE writer: the ragdoll armed at the death hit,
        /// from the hit through topple, settle and the corpse handoff. This layer was the other writer -
        /// the killing blow's own splatter (0xF755) arms a flinch entry like any other hit, and its
        /// spring/idle/gait offsets were then ADDED on top of the ragdoll pose every frame until the
        /// pool decayed. The "live layer = LIVING bodies only" contract was documented but unenforced;
        /// this delegate enforces it, at both the arming door and the write door.
        ///
        /// It is a delegate rather than a field/registry reference so this layer stays independent of
        /// the death registry (and so the death registry keeps its no-lock hot path): the callee takes
        /// no lock of its own, which is what makes it safe to call while <see cref="_gate"/> is held.
        /// </summary>
        private Func<uint, bool>? _deathOwns;

        private long _lastSweepTick;
        private int _netThreadId;
        private int _simThreadId;
        private bool _threadIdsLogged;

        /// <param name="setUpdatePartsHook">The live layer's VOTE on the shared UpdateParts detour.
        /// NativeHooks ORs it with the death registry's vote, so this may be called with false while
        /// a ragdoll still holds the detour open.</param>
        /// <param name="log">Plugin logger.</param>
        public LiveMotionRegistry(Action<bool> setUpdatePartsHook, ILogger log) {
            _setUpdatePartsHook = setUpdatePartsHook;
            _log = log;
            _cfg = new LiveMotionConfig(log);   // no file IO here; Prime()/Poll() do that
        }

        /// <summary>Bodies currently tracked by the live layer (armed or awaiting their first frame).
        /// This is the live layer's half of the hot detour's arm/disarm OR.</summary>
        public int LiveCount => _workCount;

        /// <summary>
        /// Bind the single-writer gate (see <see cref="_deathOwns"/>). Called once from the plugin's
        /// Initialize(), on the managed thread, so the delegate object and its generic instantiation
        /// exist before any native-originated stack can reach them.
        /// </summary>
        public void BindDeathOwnership(Func<uint, bool> deathOwns) => _deathOwns = deathOwns;

        /// <summary>The gate itself: true when the death ragdoll owns this body and this layer must not
        /// arm it, must not write it and must retire whatever it is holding for it. Allocation-free and
        /// lock-free on both sides - the callee takes no lock, so calling it under <see cref="_gate"/>
        /// cannot deadlock. Unbound (warmup harness) reads as "not owned", i.e. C4 behaviour.</summary>
        private bool DeathOwns(uint id) {
            Func<uint, bool>? f = _deathOwns;
            return f != null && f(id);
        }

        /// <summary>Yield a body to the death ragdoll: drop the entry (which drops this layer's vote)
        /// and say so once, so a fight between the two writers is visible in the log rather than only
        /// on screen. Caller holds <see cref="_gate"/>.</summary>
        private void RetireForDeath(LiveEntry e, uint id) {
            // PACING: fires on the render thread under _gate for essentially every kill, alongside
            // the death ragdoll's own ARM/handoff lines — the async sink keeps the story without
            // putting three file writes into the frame where a body just started falling.
            AsyncLog.Post(
                "livemotion YIELD id=0x" + id.ToString("X8") +
                " reason=death-owned hits=" + e.HitCount.ToString() +
                " wrote=" + e.WroteOnce.ToString() +
                " (single-writer: the death ragdoll owns this body)");
            Remove(id);
        }

        // ------------------------------------------------------------------ C3: live tuning

        /// <summary>
        /// Read ragdoll.cfg ONCE on the managed <c>Initialize()</c> thread, so the very first hit
        /// already runs on the file's values and so the whole file/parse path is JITed where assembly
        /// loading is legal (the 0x80131509 rule). Called by the plugin right after construction.
        /// </summary>
        public void PrimeConfig() {
            try {
                LiveMotionTuning t = _cfg.Prime();
                _tuning = t;
                _log.LogInformation("livemotion: cfg primed from {Path} (livemotion={On})",
                    _cfg.LoadedFrom ?? "<no file: shipped defaults>", t.Enabled ? 1 : 0);
            }
            catch (Exception ex) { LogSafe(ex, "PrimeConfig"); }
        }

        /// <summary>
        /// The 1/s cfg poll, called from the top of <see cref="OnUpdateParts"/> and of the two net
        /// handlers - i.e. only from paths that were going to run anyway. Returns the snapshot the
        /// caller must use for the WHOLE of its frame/message; never throws (a bad file keeps the last
        /// good snapshot), and MUST NOT be called while holding <see cref="_gate"/> - a
        /// enable/disable transition takes that lock itself.
        /// </summary>
        private LiveMotionTuning PollConfig(long now) {
            LiveMotionTuning cur = _tuning;
            LiveMotionTuning next;
            try { next = _cfg.Poll(now); }
            catch (Exception ex) { LogSafe(ex, "PollConfig"); return cur; }

            if (ReferenceEquals(next, cur)) return cur;
            _tuning = next;
            if (next.Enabled != cur.Enabled) ApplyEnabledTransition(next.Enabled);
            return next;
        }

        /// <summary>
        /// Apply a runtime flip of the <c>livemotion</c> knob. OFF is the load-bearing direction: every
        /// tracked body is dropped and the correlation rings are cleared, which zeroes
        /// <see cref="LiveCount"/> and drops the layer's vote, so the shared UpdateParts detour
        /// disarms and this layer cannot touch a part again until it is switched back on. That leaves
        /// exactly the state a freshly-constructed registry has - which is also what makes ON a clean
        /// start rather than a resume. The network subscriptions are deliberately NOT touched: they
        /// are what lets a poll happen at all while the layer is off (a hit signal is the only traffic
        /// this layer sees when nothing is reacting), and with the switch off both handlers return
        /// before they look at anything.
        /// </summary>
        private void ApplyEnabledTransition(bool enabled) {
            lock (_gate) {
                _live.Clear();
                Array.Clear(_splatRing, 0, RingSize);
                Array.Clear(_dmgRing, 0, RingSize);
                _splatNext = 0;
                _dmgNext = 0;
                _workCount = 0;
                ArmUpdateParts(false);
            }
            _log.LogInformation("livemotion: layer {State} by cfg (livemotion={V}); {What}",
                enabled ? "ENABLED" : "DISABLED", enabled ? 1 : 0,
                enabled ? "starting from a clean slate" : "all entries retired, UpdateParts vote dropped");
        }

        // ------------------------------------------------------------------ H1: the hit signal

        /// <summary>
        /// <c>NetworkParser.S2C.OnEffects_PlayScriptType</c> (0xF755). The only signal that names the
        /// object that got hit. Filters to the PS_Splatter* block, decodes the hit geometry out of the
        /// script value, excludes players, and parks an impulse on that object's entry.
        ///
        /// This is an INSTANCE method on a plugin-lifetime object on purpose: Chorizite's WeakEvent
        /// keeps a strong reference to a handler only through <c>handler.Target</c>, so a static
        /// handler's subscription can be silently collected.
        /// </summary>
        public void OnPlayScriptType(object? sender, Effects_PlayScriptType msg) {
            // WeakEvent.Invoke swallows handler exceptions, so a throw here would be invisible rather
            // than fatal. Catch and log it ourselves, exactly as NativeHooks.LogSafe does.
            try {
                if (_down || msg == null) return;
                LogThreadIdOnce(net: true);

                // C3: the layer's OTHER cfg poll site. A hit signal is the only traffic this layer
                // sees while nothing is reacting (the UpdateParts detour is disarmed then), so this is
                // what makes a cfg edit - including flipping `livemotion` back ON - take effect on an
                // idle client. It runs BEFORE the enable check on purpose: the hit that re-enables the
                // layer is itself reacted to.
                long now = Environment.TickCount64;
                LiveMotionTuning t = PollConfig(now);
                if (!t.Enabled) return;

                int script = msg.ScriptType;
                if (script < SplatterMin || script > SplatterMax) return;   // not a melee/missile impact

                uint objId = msg.ObjectId;
                if (objId == 0) return;
                // Cheap ACE-only prefilter; BF_PLAYER below is the authority.
                if (UsePlayerGuidPrefilter && (objId >> 28) == 5u) return;

                // SINGLE-WRITER, ARMING DOOR. The KILLING BLOW sends a splatter like any other hit, and
                // the same hit arms the death ragdoll - so without this the last swing of every fight
                // put a flinch spring on a body that is already being animated by the death sim, and
                // the two writers fought for the length of the fall. A death-owned body takes no
                // impulses at all: not this one, and not the next one either (a corpse still gets
                // splatters while it is being hacked at).
                if (DeathOwns(objId)) return;

                DecodeSplatter(script, out float dirX, out float dirY, out byte height);

                lock (_gate) {
                    if (_down) return;

                    var imp = new PendingImpulse {
                        Seq = ++_seq,
                        ScriptType = script,
                        DirX = dirX,
                        DirY = dirY,
                        Height = height,
                        Speed = msg.Speed,
                        DamagePercent = t.DefaultDamagePercent,
                        Tick = now,
                    };

                    // Look back for an H2 that arrived FIRST and has not been claimed yet.
                    bool enriched = TryClaimDamage(now, ref imp);

                    if (!Push(objId, imp, now, t)) return;   // at MaxLive: drop the hit, never the client

                    RecordSplat(objId, imp.Seq, now, enriched);
                }
            }
            catch (Exception ex) { LogSafe(ex, "OnPlayScriptType"); }
        }

        // ------------------------------------------------------------------ H2: the magnitude signal

        /// <summary>
        /// <c>NetworkParser.S2C.OnCombat_HandleAttackerNotificationEvent</c> (GameEvent 0x01B1). Carries
        /// the damage magnitude and the crit flag - and identifies its target by NAME ONLY, so it can
        /// never trigger a reaction, only enrich one. <c>DefenderName</c> is deliberately not used to
        /// resolve a target: names are not unique and name-&gt;GUID would cost an AC plugin dependency.
        /// <c>AttackConditions</c> is deliberately not read (C0 §2.2: the generated reader takes 4
        /// bytes of an 8-byte wire field).
        /// </summary>
        public void OnAttackerNotification(object? sender, Combat_HandleAttackerNotificationEvent msg) {
            try {
                if (_down || msg == null) return;
                // Same 1/s poll as H1 (it is throttled across both, so this costs one int compare).
                if (!PollConfig(Environment.TickCount64).Enabled) return;

                // DamagePercent is already normalised 0..1 against the target's max health, which is
                // exactly the scalar a spring impulse wants. Clamp defensively; a malformed packet
                // must not hand C2 a NaN or a 40x impulse.
                double dp = msg.DamagePercent;
                float damagePercent = (dp > 0.0 && dp < 1.0) ? (float)dp : (dp >= 1.0 ? 1f : 0f);

                long now = Environment.TickCount64;
                lock (_gate) {
                    if (_down) return;
                    // An H1 that already arrived and is still unclaimed wins; otherwise park for one.
                    if (!TryEnrichSplat(now, damagePercent, msg.Damage, (uint)msg.Type, msg.Critical))
                        RecordDamage(now, damagePercent, msg.Damage, (uint)msg.Type, msg.Critical);
                }
            }
            catch (Exception ex) { LogSafe(ex, "OnAttackerNotification"); }
        }

        // ------------------------------------------------------------------ correlation rings

        /// <summary>H1 side: claim the nearest-in-time unmatched H2 inside the window, if any.</summary>
        private bool TryClaimDamage(long now, ref PendingImpulse imp) {
            int best = -1;
            long bestDt = long.MaxValue;
            for (int i = 0; i < RingSize; i++) {
                ref DmgRec r = ref _dmgRing[i];
                if (!r.Used || r.Matched) continue;
                long dt = now - r.Tick;
                if (dt < 0) dt = -dt;
                if (dt > WindowMillis) continue;
                if (dt < bestDt) { bestDt = dt; best = i; }
            }
            if (best < 0) return false;

            ref DmgRec m = ref _dmgRing[best];
            m.Matched = true;
            imp.DamagePercent = m.DamagePercent;
            imp.Damage = m.Damage;
            imp.DamageType = m.DamageType;
            imp.Critical = m.Critical;
            imp.Enriched = true;
            return true;
        }

        /// <summary>H2 side: find the nearest-in-time unmatched H1 inside the window and fill its
        /// impulse in place (wherever it now lives - the entry it was pushed onto).</summary>
        private bool TryEnrichSplat(long now, float damagePercent, uint damage, uint damageType, bool critical) {
            int best = -1;
            long bestDt = long.MaxValue;
            for (int i = 0; i < RingSize; i++) {
                ref SplatRec r = ref _splatRing[i];
                if (!r.Used || r.Matched) continue;
                long dt = now - r.Tick;
                if (dt < 0) dt = -dt;
                if (dt > WindowMillis) continue;
                if (dt < bestDt) { bestDt = dt; best = i; }
            }
            if (best < 0) return false;

            ref SplatRec s = ref _splatRing[best];
            s.Matched = true;   // consume the slot even if the impulse has since aged out of the entry

            if (!_live.TryGetValue(s.ObjId, out LiveEntry? e) || e == null) return true;
            for (int i = 0; i < e.PendingCount; i++) {
                if (e.Pending[i].Seq != s.Seq) continue;
                e.Pending[i].DamagePercent = damagePercent;
                e.Pending[i].Damage = damage;
                e.Pending[i].DamageType = damageType;
                e.Pending[i].Critical = critical;
                e.Pending[i].Enriched = true;
                return true;
            }
            return true;
        }

        private void RecordSplat(uint objId, int seq, long now, bool matched) {
            ref SplatRec r = ref _splatRing[_splatNext];
            r.ObjId = objId; r.Seq = seq; r.Tick = now; r.Matched = matched; r.Used = true;
            _splatNext = (_splatNext + 1) % RingSize;
        }

        private void RecordDamage(long now, float damagePercent, uint damage, uint damageType, bool critical) {
            ref DmgRec r = ref _dmgRing[_dmgNext];
            r.DamagePercent = damagePercent; r.Damage = damage; r.DamageType = damageType;
            r.Critical = critical; r.Tick = now; r.Matched = false; r.Used = true;
            _dmgNext = (_dmgNext + 1) % RingSize;
        }

        // ------------------------------------------------------------------ entry management

        /// <summary>Attach an impulse to the target's entry, creating it if needed. Returns false only
        /// when the live cap refuses a NEW body. Caller holds <see cref="_gate"/>.</summary>
        private bool Push(uint objId, in PendingImpulse imp, long now, LiveMotionTuning t) {
            if (!_live.TryGetValue(objId, out LiveEntry? e) || e == null) {
                if (_live.Count >= MaxLive) return false;
                // Every C2 field is explicitly stamped here so entry construction stays the single
                // place that defines a body's starting live-motion state - C2 changes the math that
                // evolves these, not where they come from.
                e = new LiveEntry {
                    ObjId = objId,
                    CreatedTick = now,
                    Pool = 0f,
                    PoolCap = t.PoolCap,
                    PoolDecayTick = now,
                    LastCritTick = 0,
                    AttenuateAttack = false,
                    Offsets = null,        // C2 allocates on first use, sized to PartCount
                    OffsetVel = null,
                    // C4: the idle shape is resolved with the body metrics (ResolveIdle); a body
                    // starts NOT idling - it breathes only once it tells us it is standing there.
                    Archetype = BodyArchetype.Unknown,
                    IdleEligible = false,
                    MotionIdle = false,
                    IdleOffsets = null,
                    // C5: same rule - the gait shape is resolved with the body metrics (ResolveGait)
                    // and a body starts NOT stepping, whatever the cfg says.
                    GaitEligible = false,
                    MotionLocomotion = false,
                    GaitOffsets = null,
                };
                _live[objId] = e;
                _workCount = _live.Count;
                if (_live.Count == 1) ArmUpdateParts(true);
            }

            // A body already known to be a player keeps its entry (so we do not re-test it every
            // swing) but never accumulates impulses.
            if (e.PlayerChecked && e.IsPlayer) { e.LastHitTick = now; return true; }

            if (e.PendingCount < MaxPendingPerEntry) {
                e.Pending[e.PendingCount++] = imp;
            }
            else {
                // Saturated: refresh with the newest hit rather than growing the queue.
                Array.Copy(e.Pending, 1, e.Pending, 0, MaxPendingPerEntry - 1);
                e.Pending[MaxPendingPerEntry - 1] = imp;
            }
            e.LastHitTick = now;
            e.HitCount++;
            return true;
        }

        // ------------------------------------------------------------------ per-frame dispatch

        /// <summary>
        /// Second half of the <c>CPartArray::UpdateParts</c> post-detour, after
        /// <see cref="RagdollRegistry.OnUpdateParts"/> and after the client's own original has written
        /// this frame's animated pose. Resolves the owner, runs the one-time player exclusion, then
        /// (armed entries only) drains impulses, decays the pool, integrates the per-part springs and
        /// ADDS the resulting translation offsets on top of the pose the client just wrote.
        ///
        /// A quiet entry does ZERO part writes and ZERO <c>Frame::cache()</c> calls: the write loop is
        /// gated per part on <see cref="WriteEpsilonYd"/>, and an entry that is quiet everywhere
        /// retires itself, which drops the layer's vote and disarms the hot detour.
        /// </summary>
        public void OnUpdateParts(CPartArray* pa, Frame* objFrame) {
            if (_down || pa == null || objFrame == null) return;

            // C3: THE 1/s CFG POLL LIVES HERE - the top of the UpdateParts detour tail, the only
            // per-frame path this plugin owns. It sits ABOVE the no-work return so a pure DEATH ragdoll
            // (which arms this detour and reaches this dispatched call with no live-motion work of its
            // own) still refreshes the cfg every second - that keeps the death-variety knobs (read at
            // seed time by the death path, which holds no cfg of its own) live-tunable without any
            // combat. The poll is internally throttled to 1/s, so it is an int compare on other frames.
            // It is deliberately OUTSIDE _gate: a flip of `livemotion` takes that lock itself, and file
            // IO must never happen with the sim lock held.
            long now = Environment.TickCount64;
            LiveMotionTuning tune = PollConfig(now);
            if (_workCount == 0) return;   // no live-motion work; the death path is handled elsewhere
            if (!tune.Enabled) return;     // the transition already retired every entry

            CPhysicsObj* owner = pa->owner;
            if (owner == null) return;
            uint id = ObjIdOf(owner);
            if (id == 0) return;

            LogThreadIdOnce(net: false);

            lock (_gate) {
                if (_down) return;
                MaybeSweep(now);

                if (!_live.TryGetValue(id, out LiveEntry? e) || e == null) return;

                // SINGLE-WRITER, WRITE DOOR. The arming door above cannot be the whole answer: an entry
                // can already exist from the hits BEFORE the killing blow, and the death arm happens
                // inside the same frame as this dispatch (NativeHooks calls the death registry first).
                // So re-ask every frame, for the handful of bodies this layer actually tracks, and hand
                // the body over the instant it starts dying - before this frame writes a single part.
                if (DeathOwns(id)) { RetireForDeath(e, id); return; }

                // First sighting: capture the owner/part array and run the player test.
                if (e.Obj == null) {
                    e.Obj = owner;
                    e.Parts = pa;
                    e.PartCount = (int)pa->num_parts;
                }
                else if (e.Obj != owner) { Remove(id); return; }   // id reuse
                else if (e.Parts != pa) { Remove(id); return; }    // part array swapped (morph/reset)

                if (!e.PlayerChecked) {
                    PlayerTest t = IsPlayerObject(owner);
                    if (t == PlayerTest.Unknown) {
                        // Not yet answerable (weenie not streamed, or a layout we do not trust).
                        // Fail CLOSED: stay unarmed and try again next frame.
                        e.LastTouchTick = now;
                        return;
                    }
                    e.PlayerChecked = true;
                    e.IsPlayer = t == PlayerTest.Player;
                    e.Armed = !e.IsPlayer;
                    if (e.IsPlayer) {
                        e.PendingCount = 0;   // never arm on a player object
                        AsyncLog.Post("livemotion SKIP id=0x" + id.ToString("X8") + " reason=BF_PLAYER");
                    }
                }

                e.LastTouchTick = now;
                if (!e.Armed) return;                       // player, or not yet classified

                // A single-part object is not a skeleton (the death registry applies the same test at
                // arm time): a chest, a door or a projectile has nothing to flinch WITH, and shaking
                // its one part would move the whole object. Splatters legitimately name such objects.
                int n = (int)pa->num_parts;
                if (n < 2) { Remove(id); return; }

                // The part array must still be the shape we measured. num_parts can change under a
                // morph; rather than reallocate mid-reaction, drop the entry (the next hit re-arms it).
                if (n != e.PartCount) { Remove(id); return; }

                // One-time per-body measurement (radius -> amplitude clamp, per-part looseness and
                // normalised height). Needs a fully readable pose; retried next frame if it is not.
                if (!e.MetricsReady && !ComputeBodyMetrics(e, pa, objFrame, tune)) return;

                // C3: re-derive the amplitude clamp and the pool cap from the CURRENT snapshot every
                // frame (two multiplies) rather than stamping them once per entry. That is what makes
                // `ampfrac` and `poolcap` tunable on a body that is already mid-reaction, which is the
                // whole point of the 1070 edit-and-watch loop. When per-body profile overrides for
                // these land, they replace the right-hand side here, not the mechanism.
                e.MaxOffset = ClampFor(e.Radius, tune);
                e.PoolCap = tune.PoolCap;

                // Frame dt from the wall clock, so the spring is frame-rate independent. A first frame
                // (or two frames inside the same millisecond) integrates nothing but still writes.
                float dt = 0f;
                if (e.LastFrameTick != 0) {
                    long dms = now - e.LastFrameTick;
                    if (dms > 0) {
                        dt = dms * 0.001f;
                        if (dt > MaxFrameDtSec) dt = MaxFrameDtSec;
                    }
                }
                e.LastFrameTick = now;

                DecayPool(e, now, tune);
                DrainImpulses(e, now, id, tune);

                // C4: this frame's idle micro-motion, into its OWN buffer (the springs must still be
                // able to settle to zero). Computed BEFORE the rest test because a body that is
                // spring-quiet but idling still has something to write.
                bool idle = IdleActive(e, tune);
                if (idle) ComputeIdle(e, dt, tune, id);

                // C5: and this frame's gait overlay, into its OWN buffer for the same reason. The
                // ground-speed sample is taken FIRST (it is what sets this frame's cadence) and only
                // for a body that is actually stepping, so a client with gait=0 reads no position.
                bool gait = GaitActive(e, tune);
                if (gait) {
                    UpdateGaitSpeed(e, owner, dt);
                    ComputeGait(e, dt, tune, id);
                }

                // A body at rest integrates to zero and writes nothing, so skip both outright: the
                // tail of a reaction (springs settled, pool still warm) then costs a dictionary
                // lookup, one exp and one rest scan per frame - no part touched, nothing cached.
                bool atRest = IsAtRest(e);
                if (!atRest || idle || gait) {
                    if (!atRest && dt > 0f) Integrate(e, dt, tune);
                    WriteOffsets(e, pa, objFrame, VisualGain(e, tune), id, idle, gait);
                    atRest = IsAtRest(e);
                }

                // RETIREMENT: every part at rest AND the pool spent. "Spent" is measured against what
                // the pool can still DO rather than against a bare number - PoolGain * MaxOffset is
                // the largest offset this body could still show, so once that is under the write
                // epsilon the entry can never produce another client write and is removed (which
                // drops the layer's vote and disarms the hot detour). Using a fixed pool epsilon here
                // instead would keep an entry nominally alive for ~11 s after a big hit purely
                // because an exponential with a 1.5 s half-life takes that long to reach 0.005 -
                // silent, but pointlessly armed.
                //
                // C4 adds the LINGER term: a body that can idle keeps its entry (and so keeps
                // breathing) for `idlelingersec` after its LAST HIT even once the springs are spent,
                // which is the only reason idle motion is ever seen at all - the layer never arms the
                // hot detour for a body nobody hit. With idlemotion=0, or a prop, or linger 0, the
                // term is false and this is C3's retirement exactly.
                //
                // C5 adds NOTHING here, deliberately: the gait prototype must not be able to keep a
                // body on the hot path one frame longer than C4 already does. It rides the entries
                // the idle linger keeps alive and retires with them.
                if (atRest && PoolGain(e, tune) * e.MaxOffset < WriteEpsilonYd
                    && !IdleMotion.Lingering(now, e.LastHitTick, tune.IdleMotion, e.IdleEligible,
                                             tune.IdleLingerSec))
                    Remove(id);
            }
        }

        // ------------------------------------------------------------------ C2: the hit-reaction physics

        /// <summary>
        /// Wall-clock exponential decay of the reaction energy, half-life
        /// <see cref="LiveMotionTuning.PoolHalfLifeSec"/>. Driven off <see cref="LiveEntry.PoolDecayTick"/> rather than
        /// the frame dt so energy parked between frames (impulses arrive on the net path, not this
        /// one) decays by the right amount, and so a frame-rate change never changes the settle time.
        /// </summary>
        private static void DecayPool(LiveEntry e, long now, LiveMotionTuning t) {
            long dms = now - e.PoolDecayTick;
            e.PoolDecayTick = now;
            if (dms <= 0 || e.Pool <= 0f) return;
            // 0.6931472 = ln 2; pool *= 2^(-dt/halfLife).
            float k = (dms * 0.001f) * (0.6931472f / t.PoolHalfLifeSec);
            e.Pool *= MathF.Exp(-k);
            if (e.Pool < PoolEpsilon) e.Pool = 0f;
        }

        /// <summary>
        /// Turn every pending hit into pool energy and per-part velocity. Runs on the sim thread with
        /// <see cref="_gate"/> held, so the net handlers cannot be appending while we drain.
        ///
        /// ENERGY: <c>e = EnergyPerDamagePercent * DamagePercent * critMul</c>, added to the pool and
        /// HARD CAPPED. A hit that arrives at a full pool therefore adds no energy but still refreshes
        /// the decay (<see cref="DecayPool"/> restarts from this instant at the cap) and still lands
        /// its own velocity kick - "refresh, don't grow", which is what makes a 10-attacker swarm
        /// saturate instead of explode.
        ///
        /// CRIT: the multiplier is applied to the whole impulse, but only ONCE per
        /// <see cref="LiveMotionTuning.CritRefractoryMillis"/> per body. A crit inside the refractory still delivers
        /// its full BASE impulse - the refractory gates the extra, never the hit.
        ///
        /// DIRECTION: the splatter's decoded quadrant (object-local, already "away from the attacker")
        /// plus a small downward settle, normalised. <c>Effects_PlayScriptType.Speed</c> is
        /// deliberately NOT used: it is the particle script's playback rate, not a hit magnitude.
        /// </summary>
        private void DrainImpulses(LiveEntry e, long now, uint id, LiveMotionTuning t) {
            if (e.PendingCount == 0) return;
            float[] vel = e.OffsetVel!;
            float[] loose = e.Looseness!;
            float[] hgt = e.NormHeight!;
            int n = e.PartCount;

            for (int p = 0; p < e.PendingCount; p++) {
                ref PendingImpulse imp = ref e.Pending[p];

                float dp = imp.DamagePercent;
                if (!(dp > 0f)) dp = 0f;             // also rejects NaN
                if (dp > 1f) dp = 1f;

                float mul = 1f;
                if (imp.Critical && now - e.LastCritTick >= t.CritRefractoryMillis) {
                    mul = t.CritImpulseMult;
                    e.LastCritTick = now;
                }

                float energy = t.EnergyPerDamagePercent * dp * mul;
                if (energy <= 0f) continue;

                e.Pool += energy;
                if (e.Pool > e.PoolCap) e.Pool = e.PoolCap;
                e.PoolDecayTick = now;               // the "refresh" half of refresh-don't-grow

                // Unit impulse direction: away from the attacker, sagging slightly downward.
                float dx = imp.DirX, dy = imp.DirY, dz = -t.SettleDown;
                float len = MathF.Sqrt(dx * dx + dy * dy + dz * dz);
                if (len < 1e-6f) continue;
                float inv = 1f / len;
                dx *= inv; dy *= inv; dz *= inv;

                float v0 = t.ImpulseVelPerEnergy * energy;
                float band = HeightBandCenter(imp.Height);

                // The tuning loop's one line per hit (C3 watches these while editing the cfg).
                // PACING (2026-08-23): this used to be an ILogger call — i.e. a Console.Write plus a
                // full file open/append/close — ON THE RENDER THREAD, WHILE HOLDING _gate, once per
                // landed hit per body. A group @smite turned that into a burst of file writes in a
                // single frame. Same line, same content; it now goes to the async sink, and the
                // params-array + 16 boxes of the structured call are gone with it.
                AsyncLog.Post(
                    "livemotion HIT id=0x" + id.ToString("X8") +
                    " script=0x" + imp.ScriptType.ToString("X2") +
                    " h=" + imp.Height.ToString() +
                    " dir=(" + dx.ToString("F2") + "," + dy.ToString("F2") + "," + dz.ToString("F2") + ")" +
                    " dmg%=" + dp.ToString("F3") +
                    " crit=" + imp.Critical.ToString() + "x" + mul.ToString("F1") +
                    " enriched=" + imp.Enriched.ToString() +
                    " energy=" + energy.ToString("F3") +
                    " pool=" + e.Pool.ToString("F3") + "/" + e.PoolCap.ToString("F2") +
                    " v0=" + v0.ToString("F3") + "yd/s" +
                    " latency=" + (now - imp.Tick).ToString() + "ms" +
                    " hits=" + e.HitCount.ToString());

                for (int i = 0; i < n; i++) {
                    // extremities take the whole kick, the core takes coreImpulseFrac of it
                    float w = t.CoreImpulseFrac + (1f - t.CoreImpulseFrac) * loose[i];
                    // ...and parts near the struck height take more of it than the far rows
                    float hw = 1f - t.HeightBias * MathF.Abs(hgt[i] - band);
                    if (hw < 0f) hw = 0f;
                    float s = v0 * w * hw;
                    int b = i * 3;
                    vel[b] += dx * s;
                    vel[b + 1] += dy * s;
                    vel[b + 2] += dz * s;
                }
            }
            e.PendingCount = 0;
        }

        /// <summary>Normalised body height a splatter band refers to: 0 = the body's lowest part,
        /// 1 = its highest. Low/Mid/Up are the attacker's AttackHeight (C0 report §4.3).</summary>
        private static float HeightBandCenter(byte height) => height switch {
            0 => 0.20f,   // Low
            2 => 0.85f,   // Up
            _ => 0.50f,   // Mid (and any value we do not recognise)
        };

        /// <summary>
        /// The PD spring, per part, per axis, exactly as specified:
        /// <c>offset += vel*dt; vel += (-k*offset - c*vel)*dt</c> (position first, so the velocity
        /// update sees the NEW offset - the semi-implicit form, which is stable for
        /// <c>dt &lt; 2/omega_n</c> instead of unconditionally divergent).
        ///
        /// Substepped at <see cref="SubstepMaxSec"/> (a compiled-in stability limit, not a knob) so a
        /// 15 fps client and a 144 fps client integrate
        /// the same trajectory, and the stiffest authored part keeps a 4.5x stability margin.
        /// Per-part stiffness comes from looseness (core stiff, extremity loose) and the damping is
        /// scaled by sqrt(kScale) so every part keeps the SAME damping ratio - a limb rings longer
        /// because it is softer, not because it is less damped.
        ///
        /// The offset is clamped to <see cref="LiveEntry.MaxOffset"/> inside the loop, not just at
        /// write time, so no amount of stacked impulses can leave the state itself unbounded; a
        /// clamped part also loses half its velocity, which is what stops it from sitting pinned
        /// against the clamp.
        /// </summary>
        private static void Integrate(LiveEntry e, float dt, LiveMotionTuning t) {
            int steps = (int)MathF.Ceiling(dt / SubstepMaxSec);
            if (steps < 1) steps = 1;
            float h = dt / steps;

            float[] off = e.Offsets!;
            float[] vel = e.OffsetVel!;
            float[] loose = e.Looseness!;
            int n = e.PartCount;
            float maxOff = e.MaxOffset;
            float maxOff2 = maxOff * maxOff;

            for (int i = 0; i < n; i++) {
                float kScale = t.CoreStiffMul + (t.EdgeStiffMul - t.CoreStiffMul) * loose[i];
                float k = t.SpringK * kScale;
                float c = t.SpringDamp * MathF.Sqrt(kScale);
                int b = i * 3;
                float ox = off[b], oy = off[b + 1], oz = off[b + 2];
                float vx = vel[b], vy = vel[b + 1], vz = vel[b + 2];

                for (int s = 0; s < steps; s++) {
                    ox += vx * h; oy += vy * h; oz += vz * h;
                    vx += (-k * ox - c * vx) * h;
                    vy += (-k * oy - c * vy) * h;
                    vz += (-k * oz - c * vz) * h;

                    float m2 = ox * ox + oy * oy + oz * oz;
                    if (m2 > maxOff2) {
                        float scale = maxOff / MathF.Sqrt(m2);
                        ox *= scale; oy *= scale; oz *= scale;
                        vx *= 0.5f; vy *= 0.5f; vz *= 0.5f;
                    }
                }

                off[b] = ox; off[b + 1] = oy; off[b + 2] = oz;
                vel[b] = vx; vel[b + 1] = vy; vel[b + 2] = vz;
            }
        }

        /// <summary>
        /// The visible amplitude multiplier: a smoothstep of the reaction energy, times the
        /// attack-motion attenuation. Smoothstep (not a linear ramp) so the tail of a reaction eases
        /// out instead of stopping, and the knee is well below the cap so an ordinary hit is shown at
        /// full authored amplitude rather than being double-attenuated for being small.
        /// </summary>
        private static float VisualGain(LiveEntry e, LiveMotionTuning t) =>
            e.AttenuateAttack ? PoolGain(e, t) * t.AttackAttenuation : PoolGain(e, t);

        /// <summary>The energy half of <see cref="VisualGain"/>, without the attack attenuation.
        /// Retirement tests THIS: an entry must not retire early merely because the body happens to be
        /// mid-swing, and it must not be kept alive by an attenuation that will lift next motion.</summary>
        private static float PoolGain(LiveEntry e, LiveMotionTuning t) {
            float cap = e.PoolCap * t.PoolGainKnee;
            if (cap <= 0f) return 0f;
            float x = e.Pool / cap;      // smoothstep parameter
            if (x <= 0f) return 0f;
            if (x > 1f) x = 1f;
            return x * x * (3f - 2f * x);
        }

        /// <summary>
        /// THE ONE WRITE PATH - hit springs, C4 idle micro-motion and the C5 gait overlay ALL land
        /// here, summed per part by <see cref="IdleMotion.Combine"/> and clamped ONCE, together, to the
        /// body's amplitude limit. There is deliberately no second write loop for either additive
        /// layer: one place that touches a <c>CPhysicsPart</c>, one epsilon gate, one clamp, one
        /// <c>Frame::cache()</c> discipline.
        ///
        /// Add this frame's offsets on top of the pose the client's own UpdateParts just wrote.
        ///
        /// TRANSLATION ONLY - the quaternion is never touched, so a part we skip is byte-for-byte
        /// what the client wrote. Every part pointer is re-resolved from the live
        /// <see cref="CPartArray"/> and null-checked (the death registry's discipline: never cache a
        /// <c>CPhysicsPart*</c>). A part whose combined offset is under <see cref="WriteEpsilonYd"/> is
        /// not written AND not cached, which is what makes an armed-but-quiet entry cost the client
        /// literally nothing.
        /// </summary>
        /// <param name="e">The reacting body's entry (offset buffers, clamp, diagnostics).</param>
        /// <param name="pa">The live part array the client just animated.</param>
        /// <param name="objFrame">The object frame, for the object-local -&gt; world rotate.</param>
        /// <param name="gain">The C2 visual gain applied to the SPRING offsets only.</param>
        /// <param name="id">Object id, diagnostics only.</param>
        /// <param name="idle">This frame's idle offsets (<see cref="LiveEntry.IdleOffsets"/>) are to be
        /// blended in. When false the combine is the pre-C4 multiply, instruction for instruction.</param>
        /// <param name="gait">This frame's C5 gait offsets (<see cref="LiveEntry.GaitOffsets"/>) are to
        /// be blended in. When false the sum is the pre-C5 one, term for term - the additive slot is
        /// simply the idle vector (or nothing), which is what makes <c>gait = 0</c> bit-identical.</param>
        private void WriteOffsets(LiveEntry e, CPartArray* pa, Frame* objFrame, float gain, uint id,
                                  bool idle, bool gait) {
            if (gain <= 0f && !idle && !gait) return;   // C4/C5: a spent pool still writes the overlays
            CPhysicsPart** parts = pa->parts;
            if (parts == null) return;

            float[] off = e.Offsets!;
            float[]? idleOff = idle ? e.IdleOffsets : null;
            float[]? gaitOff = gait ? e.GaitOffsets : null;
            int n = e.PartCount;
            if (n > (int)pa->num_parts) n = (int)pa->num_parts;
            // Shape guards; never partial-blend a buffer that is shorter than the part array.
            bool blendIdle = idleOff != null && idleOff.Length >= n * 3;
            bool blendGait = gaitOff != null && gaitOff.Length >= n * 3;
            bool blend = blendIdle || blendGait;

            Quat oq = QMath.Norm(new Quat(objFrame->qw, objFrame->qx, objFrame->qy, objFrame->qz));
            int written = 0;

            for (int i = 0; i < n; i++) {
                int b = i * 3;
                float ix = 0f, iy = 0f, iz = 0f;
                if (blendIdle) { ix = idleOff![b]; iy = idleOff[b + 1]; iz = idleOff[b + 2]; }
                // The gait buffer is zero for every part that is not one of the six leg chains, so
                // this add is a no-op everywhere else - the harness pins that.
                if (blendGait) { ix += gaitOff![b]; iy += gaitOff[b + 1]; iz += gaitOff[b + 2]; }
                if (!IdleMotion.Combine(off[b], off[b + 1], off[b + 2], gain, ix, iy, iz, blend,
                                        e.MaxOffset, WriteEpsilonYd,
                                        out float ox, out float oy, out float oz)) continue;

                CPhysicsPart* part = parts[i];
                if (part == null) continue;

                // object-local -> world: the same rotate the client's scaled combine applies, minus
                // the scale (the offsets already live post-scale; see LiveEntry.Offsets).
                QMath.Rotate(oq, ox, oy, oz, out float wx, out float wy, out float wz);

                part->pos.frame.m_fOrigin.BaseClass_Vector3.x += wx;
                part->pos.frame.m_fOrigin.BaseClass_Vector3.y += wy;
                part->pos.frame.m_fOrigin.BaseClass_Vector3.z += wz;

                // Same Frame::cache() discipline WriteParts follows: the draw path reads the cached
                // matrix, not the raw frame fields.
                part->pos.frame.cache();
                written++;
            }

            if (written > 0 && !e.WroteOnce) {
                e.WroteOnce = true;
                // PACING: once per entry, but that "once" is the FIRST FRAME OF A REACTION — the
                // frame that least wants a synchronous file write. Async sink.
                AsyncLog.Post(
                    "livemotion REACT id=0x" + id.ToString("X8") +
                    " parts=" + written.ToString() + "/" + n.ToString() +
                    " pool=" + e.Pool.ToString("F3") +
                    " gain=" + gain.ToString("F2") +
                    " maxOff=" + e.MaxOffset.ToString("F4") + "yd" +
                    " hits=" + e.HitCount.ToString());
            }
        }

        // ------------------------------------------------------------------ C4: idle micro-motion

        /// <summary>
        /// Should this body idle THIS frame? Five conditions, cheapest first, and every one of them is
        /// load-bearing:
        ///   * the cfg switch is on (with it off C4 is inert and the layer is bit-identical to C3);
        ///   * the body CAN idle - an archetype that produces motion and at least one moving part
        ///     (<see cref="LiveEntry.IdleEligible"/>; false for every prop);
        ///   * its OWN current motion is idle-class (<see cref="OnMotion"/>) - a walking, swinging or
        ///     casting creature does not breathe on top of the animation;
        ///   * the amplitude and the frequency are both non-zero (either at 0 means "off", and a zero
        ///     frequency would freeze the sine at a constant offset rather than stop it);
        ///   * the one-time metrics have run, so a radius, a clamp and the buffers exist.
        /// </summary>
        private static bool IdleActive(LiveEntry e, LiveMotionTuning t) =>
            t.IdleMotion && e.IdleEligible && e.MotionIdle && e.MetricsReady
            && t.IdleAmp > 0f && t.IdleHz > 0f
            && e.IdleOffsets != null && e.IdleVert != null;

        /// <summary>
        /// Advance this body's oscillator phases by one frame and rewrite its idle offsets. The
        /// amplitude is <c>idleamp</c> of the body's own radius - the same "every creature moves by
        /// the same fraction of itself" rule the flinch uses - and is additionally clamped to the
        /// body's <see cref="LiveEntry.MaxOffset"/>, so idle motion can never exceed the hit layer's
        /// safety limit however the two knobs are set.
        /// </summary>
        private void ComputeIdle(LiveEntry e, float dt, LiveMotionTuning t, uint id) {
            e.IdlePhase = IdleMotion.AdvancePhase(e.IdlePhase, t.IdleHz, dt);
            if (e.IdleSway != null)
                e.IdleSwayPhase = IdleMotion.AdvancePhase(e.IdleSwayPhase,
                                                          t.IdleHz * IdleMotion.SwayHzFrac, dt);

            float amp = t.IdleAmp * e.Radius;
            if (!(amp > 0f)) amp = 0f;                      // also rejects NaN
            if (amp > e.MaxOffset) amp = e.MaxOffset;

            IdleMotion.Accumulate(e.IdleOffsets!, e.PartCount, e.IdleVert!, e.IdleSway,
                                  amp, e.MaxOffset, e.IdlePhase, e.IdleSwayPhase);

            if (!e.IdleLoggedOnce) {
                e.IdleLoggedOnce = true;
                AsyncLog.Post(
                    "livemotion IDLE id=0x" + id.ToString("X8") +
                    " archetype=" + e.Archetype.ToString() +
                    " parts=" + e.PartCount.ToString() +
                    " amp=" + amp.ToString("F4") + "yd" +
                    " hz=" + t.IdleHz.ToString("F2") +
                    " sway=" + (e.IdleSway != null).ToString() +
                    " radius=" + e.Radius.ToString("F2") + "yd");
            }
        }

        /// <summary>
        /// Resolve the body's idle SHAPE once, alongside the other one-time metrics: its Tier-0
        /// archetype and per-part role/ground tags from the profile
        /// (<see cref="RagdollProfiles.RolesFor"/>), turned into the two weight arrays by
        /// <see cref="IdleMotion.Build"/>. A body with no profile is <see cref="BodyArchetype.Unknown"/>
        /// and breathes off the structural looseness instead; a PROP is not eligible at all, allocates
        /// no buffer and never lingers.
        ///
        /// This runs regardless of what <c>idlemotion</c> currently says, and deliberately so: the
        /// shape does not depend on the cfg, so flipping the knob on mid-session must not require the
        /// body to be re-measured. It costs two small arrays per REACTING body, once.
        /// </summary>
        private static void ResolveIdle(LiveEntry e, CPartArray* pa, int n) {
            CSetup* setup = (CSetup*)pa->setup;
            BodyRoles? br = setup != null ? RagdollProfiles.RolesFor(SetupDidOf(setup)) : null;
            e.Archetype = br != null ? br.Archetype : BodyArchetype.Unknown;

            e.IdleEligible = IdleMotion.Build(e.Archetype, br?.Roles, br?.Ground, e.Looseness!, n,
                                              out float[]? vert, out float[]? sway);
            e.IdleVert = vert;
            e.IdleSway = sway;
            e.IdleOffsets = e.IdleEligible ? new float[n * 3] : null;

            // Per-body phase, hashed from the object id, so a camp of drudges does not breathe in
            // unison; the sway gets its own seed so a floater's bob and drift are not locked together.
            e.IdlePhase = IdleMotion.PhaseFor(e.ObjId);
            e.IdleSwayPhase = IdleMotion.PhaseFor(e.ObjId ^ 0x9E3779B9u);
        }

        // ------------------------------------------------------------------ C5: procedural gait

        /// <summary>
        /// Should this body step THIS frame? The exact twin of <see cref="IdleActive"/>, cheapest
        /// condition first, and every one of them load-bearing:
        ///   * the cfg switch is on (with <c>gait = 0</c> C5 is inert and the layer is bit-identical
        ///     to C4);
        ///   * the body IS the hard-coded target rig (<see cref="LiveEntry.GaitEligible"/>) - which is
        ///     what makes turning the knob on a no-op for every other creature in the world;
        ///   * its OWN current motion is locomotion-class (<see cref="OnMotion"/>) - a standing,
        ///     swinging or casting body does not step;
        ///   * the amplitude and the cadence are both non-zero (either at 0 means "off", and a zero
        ///     cadence would freeze the sine at a constant offset - a limp, not a stop);
        ///   * the one-time metrics have run, so a radius, a clamp and the buffer exist.
        /// </summary>
        private static bool GaitActive(LiveEntry e, LiveMotionTuning t) =>
            t.Gait && e.GaitEligible && e.MotionLocomotion && e.MetricsReady
            && t.GaitAmp > 0f && t.GaitCadenceHz > 0f
            && e.GaitOffsets != null;

        /// <summary>
        /// Advance this body's tripod phase by one frame at the speed-scaled cadence and rewrite its
        /// gait offsets. The amplitude is <c>gaitamp</c> of the body's own radius - the same "every
        /// creature moves by the same fraction of itself" rule the flinch and the breath use - and is
        /// additionally clamped to the body's <see cref="LiveEntry.MaxOffset"/>, so the gait can never
        /// exceed the hit layer's safety limit however the two knobs are set.
        /// </summary>
        private void ComputeGait(LiveEntry e, float dt, LiveMotionTuning t, uint id) {
            float hz = GaitMotion.CadenceHz(t.GaitCadenceHz, e.GaitSpeed, e.GaitSpeedValid);
            e.GaitPhase = IdleMotion.AdvancePhase(e.GaitPhase, hz, dt);

            float amp = t.GaitAmp * e.Radius;
            if (!(amp > 0f)) amp = 0f;                      // also rejects NaN
            if (amp > e.MaxOffset) amp = e.MaxOffset;

            GaitMotion.Accumulate(e.GaitOffsets!, e.PartCount, amp, e.MaxOffset, e.GaitPhase);

            if (!e.GaitLoggedOnce) {
                e.GaitLoggedOnce = true;
                AsyncLog.Post(
                    "livemotion GAIT id=0x" + id.ToString("X8") +
                    " setupDid=0x" + GaitMotion.TargetSetupDid.ToString("X8") +
                    " parts=" + e.PartCount.ToString() +
                    " amp=" + amp.ToString("F4") + "yd" +
                    " cadence=" + hz.ToString("F2") + "Hz" +
                    " speed=" + e.GaitSpeed.ToString("F2") + "yd/s(" +
                    (e.GaitSpeedValid ? "measured" : "knob") + ")" +
                    " radius=" + e.Radius.ToString("F2") + "yd");
            }
        }

        /// <summary>
        /// Fold this frame's ground-speed sample into the entry, from <c>m_position</c> - the same
        /// field, read the same way, as <c>RagdollRegistry.ReadPos</c>. There is no other speed source
        /// here on purpose: the client's own velocity vector was NOT verified for this stage, and an
        /// unverified native read is not worth a nicer cadence.
        ///
        /// THE CELL GUARD IS THE LOAD-BEARING PART. An AC object origin is CELL-LOCAL, so the delta
        /// across a landblock/cell handoff is a ~200 yd jump that means nothing. On a cell change (and
        /// on the first frame) the sampler RESEEDS and reports no sample, which drops the cadence back
        /// to the bare <c>gaitcadence</c> knob for exactly one step's worth of frames rather than
        /// spiking it. A zero cell or a non-finite origin is treated the same way.
        /// </summary>
        private static void UpdateGaitSpeed(LiveEntry e, CPhysicsObj* obj, float dt) {
            if (obj == null) return;
            uint cell = obj->m_position.objcell_id;
            float x = obj->m_position.frame.m_fOrigin.BaseClass_Vector3.x;
            float y = obj->m_position.frame.m_fOrigin.BaseClass_Vector3.y;

            if (cell == 0 || !IsFinite(x) || !IsFinite(y)) {
                e.GaitPosValid = false;
                e.GaitSpeedValid = false;
                return;
            }

            if (!e.GaitPosValid || cell != e.GaitCell) {
                e.GaitCell = cell; e.GaitPosX = x; e.GaitPosY = y;
                e.GaitPosValid = true;
                e.GaitSpeedValid = false;      // fixed-cadence fallback until a real sample lands
                return;
            }

            float dx = x - e.GaitPosX, dy = y - e.GaitPosY;
            e.GaitPosX = x; e.GaitPosY = y;
            if (!(dt > 0f)) return;            // two frames inside one millisecond: keep the last speed

            e.GaitSpeed = GaitMotion.UpdateSpeed(e.GaitSpeed, dx, dy, dt);
            e.GaitSpeedValid = true;
        }

        /// <summary>
        /// Resolve whether this body is the C5 target, once, alongside the other one-time metrics.
        /// Runs regardless of what <c>gait</c> currently says - for the same reason
        /// <see cref="ResolveIdle"/> does: flipping the knob on mid-session must not require the body
        /// to be re-measured. Costs one uint compare and, for the ONE body that matches, one array.
        /// </summary>
        private static void ResolveGait(LiveEntry e, CPartArray* pa, int n) {
            CSetup* setup = (CSetup*)pa->setup;
            e.GaitEligible = setup != null && GaitMotion.Applies(SetupDidOf(setup), n);
            e.GaitOffsets = e.GaitEligible ? new float[n * 3] : null;
            // Per-body phase, hashed from the object id (its own seed, so a nest of Olthoi does not
            // march in lockstep and the gait is not phase-locked to the breath).
            e.GaitPhase = IdleMotion.PhaseFor(e.ObjId ^ 0x85EBCA6Bu);
            e.GaitSpeed = 0f;
            e.GaitSpeedValid = false;
            e.GaitPosValid = false;
        }

        /// <summary>Mechanical half of the retirement test: nothing pending and every part settled
        /// (offset and velocity both under epsilon). The energy half is the caller's
        /// <c>PoolGain * MaxOffset &lt; WriteEpsilonYd</c> check.</summary>
        private static bool IsAtRest(LiveEntry e) {
            if (e.PendingCount > 0) return false;
            float[]? off = e.Offsets;
            float[]? vel = e.OffsetVel;
            if (off == null || vel == null) return true;   // never armed a spring: nothing to settle
            int n = e.PartCount * 3;
            for (int i = 0; i < n; i++) {
                if (MathF.Abs(off[i]) >= OffsetEpsilonYd) return false;
                if (MathF.Abs(vel[i]) >= VelEpsilonYdS) return false;
            }
            return true;
        }

        // ------------------------------------------------------------------ C2: one-time body metrics

        /// <summary>
        /// Measure everything about this body that the spring layer needs and that does not change
        /// frame to frame: the amplitude clamp, the per-part looseness, and the per-part normalised
        /// height. Runs once per entry, on the first armed frame with a fully readable pose; returns
        /// false (and allocates nothing) when the pose is not ready, so the caller simply retries.
        ///
        /// The AMPLITUDE CLAMP is derived from the body's own size rather than authored per body: the
        /// radius is the largest distance from the part centroid to any part, measured in object-local
        /// space (i.e. AFTER <c>pa-&gt;scale</c> has been applied by the client's combine), so a Golem
        /// and a Wisp both flinch by the same FRACTION of themselves. <c>pa-&gt;scale</c> also supplies
        /// the fallback radius for a degenerate body whose parts are all coincident.
        ///
        /// The LOOSENESS is the Tier-0 seam. Where the body's profile carries a "parts" role array the
        /// authored weight wins per part; everywhere else the structural heuristic applies - depth in
        /// the Setup's ParentIndex chain, 0 (root) = stiff core, <see cref="DepthFullLoose"/>+ = fully
        /// loose extremity. The chain walk is bounded and rejects self/out-of-range parents, and the
        /// index array is clamped to <c>setup-&gt;num_parts</c> (the native OOB read RagdollRegistry
        /// documents as FINDING 2).
        /// </summary>
        private bool ComputeBodyMetrics(LiveEntry e, CPartArray* pa, Frame* objFrame, LiveMotionTuning t) {
            int n = e.PartCount;
            if (n <= 0) return false;
            CPhysicsPart** parts = pa->parts;
            if (parts == null) return false;

            Quat oq = QMath.Norm(new Quat(objFrame->qw, objFrame->qx, objFrame->qy, objFrame->qz));
            float oox = objFrame->m_fOrigin.BaseClass_Vector3.x;
            float ooy = objFrame->m_fOrigin.BaseClass_Vector3.y;
            float ooz = objFrame->m_fOrigin.BaseClass_Vector3.z;

            // PACING (2026-08-23): these were three fresh float[n] per CALL — and the call is retried
            // EVERY FRAME until the pose is readable (the `part == null` / non-finite bails below),
            // so an unready body threw away three arrays per frame for as long as it stayed unready.
            // Reused scratch instead; the whole method runs under _gate on the render thread.
            EnsureMetricsScratch(n);
            float[] lx = _metricsX, ly = _metricsY, lz = _metricsZ;
            float cx = 0f, cy = 0f, cz = 0f;

            for (int i = 0; i < n; i++) {
                CPhysicsPart* part = parts[i];
                if (part == null) return false;      // pose not fully built yet - retry next frame
                float wx = part->pos.frame.m_fOrigin.BaseClass_Vector3.x;
                float wy = part->pos.frame.m_fOrigin.BaseClass_Vector3.y;
                float wz = part->pos.frame.m_fOrigin.BaseClass_Vector3.z;
                QMath.RotateInverse(oq, wx - oox, wy - ooy, wz - ooz,
                                    out float px, out float py, out float pz);
                if (!IsFinite(px) || !IsFinite(py) || !IsFinite(pz)) return false;
                lx[i] = px; ly[i] = py; lz[i] = pz;
                cx += px; cy += py; cz += pz;
            }

            float invN = 1f / n;
            cx *= invN; cy *= invN; cz *= invN;

            float r2 = 0f, minZ = float.MaxValue, maxZ = float.MinValue;
            for (int i = 0; i < n; i++) {
                float dx = lx[i] - cx, dy = ly[i] - cy, dz = lz[i] - cz;
                float d2 = dx * dx + dy * dy + dz * dz;
                if (d2 > r2) r2 = d2;
                if (lz[i] < minZ) minZ = lz[i];
                if (lz[i] > maxZ) maxZ = lz[i];
            }
            float radius = MathF.Sqrt(r2);
            if (!(radius > 1e-4f)) {
                // Degenerate (single part, or every part on the object origin): fall back to the part
                // array's own scale, which is the only size information such a body has.
                float sx = pa->scale.BaseClass_Vector3.x;
                float sy = pa->scale.BaseClass_Vector3.y;
                float sz = pa->scale.BaseClass_Vector3.z;
                float meanScale = (MathF.Abs(sx) + MathF.Abs(sy) + MathF.Abs(sz)) * (1f / 3f);
                radius = IsFinite(meanScale) && meanScale > 1e-4f ? meanScale * 0.5f : 0.5f;
            }

            e.Radius = radius;
            e.MaxOffset = ClampFor(radius, t);

            // normalised heights for the splatter height bias
            var hgt = new float[n];
            float span = maxZ - minZ;
            if (span > 1e-4f) {
                float invSpan = 1f / span;
                for (int i = 0; i < n; i++) hgt[i] = (lz[i] - minZ) * invSpan;
            }
            else for (int i = 0; i < n; i++) hgt[i] = 0.5f;
            e.NormHeight = hgt;

            e.Looseness = ResolveLooseness(pa, n);
            e.Offsets = new float[n * 3];
            e.OffsetVel = new float[n * 3];
            // C4: the idle shape is derived from the SAME looseness plus the Tier-0 roles, so it is
            // resolved here, once, with everything else that does not change frame to frame.
            ResolveIdle(e, pa, n);
            // C5: and whether this body is the one hard-coded gait target - same "resolve everything
            // that does not change frame to frame, once" rule.
            ResolveGait(e, pa, n);
            e.MetricsReady = true;
            return true;
        }

        /// <summary>The amplitude clamp for a body of this radius under the current tuning: the
        /// <c>ampfrac</c> fraction of the body's own size, bounded by the two absolute guards that are
        /// NOT cfg-editable. Re-evaluated every frame (two compares) so the safety knob is live.</summary>
        private static float ClampFor(float radius, LiveMotionTuning t) {
            float clamp = t.AmplitudeFrac * radius;
            if (!(clamp > AmplitudeMinYd)) return AmplitudeMinYd;   // also catches NaN
            return clamp > AmplitudeMaxYd ? AmplitudeMaxYd : clamp;
        }

        /// <summary>Per-part looseness: authored role weights where the body has them, structural
        /// parent-chain depth everywhere else. See <see cref="ComputeBodyMetrics"/>.</summary>
        private static float[] ResolveLooseness(CPartArray* pa, int n) {
            var w = new float[n];
            CSetup* setup = (CSetup*)pa->setup;
            uint* pidx = setup != null ? setup->parent_index : null;
            int safe = setup != null ? (int)setup->num_parts : 0;
            if (safe > n) safe = n;

            // structural default
            for (int i = 0; i < n; i++) {
                int depth = 0;
                if (pidx != null && i < safe) {
                    int cur = i;
                    for (int step = 0; step < DepthFullLoose + 1; step++) {
                        uint par = pidx[cur];
                        if (par == 0xFFFFFFFFu || par >= (uint)safe || (int)par == cur) break;
                        cur = (int)par;
                        depth++;
                    }
                }
                w[i] = depth >= DepthFullLoose ? 1f : (float)depth / DepthFullLoose;
            }

            // authored Tier-0 role weights override, per part, where present
            float[]? role = setup != null ? RagdollProfiles.PartWeights(SetupDidOf(setup)) : null;
            if (role != null) {
                int m = role.Length < n ? role.Length : n;
                for (int i = 0; i < m; i++) {
                    float v = role[i];
                    if (v >= 0f) w[i] = v > 1f ? 1f : v;
                }
            }
            return w;
        }

        // ------------------------------------------------------------------ current-motion tracking

        /// <summary>
        /// Fed from the EXISTING <c>CPhysicsObj::DoInterpretedMotion</c> detour (the universal
        /// motion-initiation choke point AcmeRagdoll already owns for death-start arming) so the layer
        /// knows when a body it is shaking is itself mid-swing, and can attenuate to
        /// <see cref="LiveMotionTuning.AttackAttenuation"/> instead of blurring the telegraph the player must read.
        ///
        /// This fires for EVERY motion of EVERY object, so the cheap outs come first: no live entries
        /// at all (the overwhelmingly common case) costs one volatile read and returns before the
        /// pointer is even dereferenced. Classification is a bounds check plus one array index -
        /// no allocation, no enum metadata, nothing that could lazily load on the native thread.
        ///
        /// It is a LATCH on motion STARTS, so a body that was already mid-swing when the hit landed is
        /// only attenuated from its next motion command. That is the right trade: the alternative -
        /// polling the object's current motion from the hot pose path - costs every frame of every
        /// reacting body to fix a fraction of the first swing.
        /// </summary>
        public void OnMotion(CPhysicsObj* obj, uint motion) {
            if (_down || obj == null) return;
            if (_workCount == 0) return;
            uint id = ObjIdOf(obj);
            if (id == 0) return;
            bool attack = IsAttackMotion(motion);
            // C4: the same latch, second class. Anything that is not idle-class - locomotion, an
            // attack, a cast, an emote - clears it, so idle motion is strictly "this body last told us
            // it was standing there".
            bool idle = !attack && IsIdleMotion(motion);
            // C5: the same latch, third class, and the sets are disjoint by construction (a command is
            // at most one of attack / idle / locomotion in motion_class.py), so the three latches never
            // fight. Anything that is not locomotion-class stops the gait overlay.
            bool loco = !attack && !idle && IsLocomotionMotion(motion);
            lock (_gate) {
                if (_down) return;
                if (_live.TryGetValue(id, out LiveEntry? e) && e != null) {
                    e.AttenuateAttack = attack;
                    e.MotionIdle = idle;
                    e.MotionLocomotion = loco;
                }
            }
        }

        /// <summary>
        /// Attack-class MotionCommand test. Only the low 16 bits identify the command (the high byte
        /// is the command class - 0x10 Action, 0x13 ChatEmote, 0x40 Use, 0x80 Style), so the table is
        /// indexed by <c>motion &amp; 0xFFFF</c>.
        ///
        /// The set is transcribed VERBATIM from the run's semantic classifier,
        /// <c>/mnt/wbterminal2/livemotion/motion_class.py</c> (its ATTACK set: entities.js
        /// ATTACK_COMMANDS minus the airborne one-shots Jump/JumpCharging, plus the four creature
        /// specials HeadThrow/FistSlam/BreatheFlame/SpinAttack that entities.js parks in
        /// EMOTE_COMMANDS only because the render dispatch is identical, plus its
        /// EXTENDED_ATTACK_COMMANDS minus the recall/fishing/skill/PK entries). Transcribed as four
        /// CONTIGUOUS ranges because that is what the set turns out to be - which is also the cheapest
        /// check to audit against the Python.
        /// </summary>
        private static bool IsAttackMotion(uint motion) {
            uint low = motion & 0xFFFFu;
            return low < (uint)AttackLow16.Length && AttackLow16[low];
        }

        /// <summary>The four contiguous low-16 attack ranges, inclusive. See
        /// <see cref="IsAttackMotion"/> for provenance.
        ///   0x0058..0x006E  Thrust/Slash/Backhand low-mid-high, Shoot, unarmed 1..3, and the four
        ///                   creature specials HeadThrow/FistSlam/BreatheFlame/SpinAttack;
        ///   0x00CD..0x00D2  SpecialAttack1..3, MissileAttack1..3;
        ///   0x011F..0x012A  the Double*/Triple* multi-strike chains;
        ///   0x0173..0x019A  offhand slash/thrust/multi-strike/kick, AttackHigh4..AttackLow6,
        ///                   Punch fast/slow and the offhand punches.</summary>
        private static readonly ushort[] AttackRanges = {
            0x0058, 0x006E,
            0x00CD, 0x00D2,
            0x011F, 0x012A,
            0x0173, 0x019A,
        };

        /// <summary>Dense O(1) form of <see cref="AttackRanges"/>. Built once by the class
        /// constructor, which the plugin's warmup runs explicitly on the managed thread.</summary>
        private static readonly bool[] AttackLow16 = BuildRangeTable(AttackRanges);

        /// <summary>
        /// Idle-class MotionCommand test (C4), the twin of <see cref="IsAttackMotion"/> and indexed
        /// the same way (low 16 bits only).
        ///
        /// The set is transcribed VERBATIM from the run's semantic classifier,
        /// <c>/mnt/wbterminal2/livemotion/motion_class.py</c> (its IDLE set: the Ready/Stop base poses
        /// plus entities.js STATIONARY_COMMANDS minus Dead, plus IDLE_AMBIENT_COMMANDS, plus
        /// CYCLE_HELD_COMMANDS - the aim/held/state markers). It is the set of commands that mean "this
        /// body is standing there", which is exactly when a breath is legal.
        /// </summary>
        private static bool IsIdleMotion(uint motion) {
            uint low = motion & 0xFFFFu;
            return low < (uint)IdleLow16.Length && IdleLow16[low];
        }

        /// <summary>The idle low-16 ranges, inclusive, transcribed from motion_class.py's IDLE set.
        ///   0x0003..0x0004  Ready / Stop (the base poses);
        ///   0x0009          Interpolating;
        ///   0x000B..0x000C  On / Off;
        ///   0x0012..0x0014  Crouch / Sitting / Sleeping;
        ///   0x001E..0x002A  AimLevel and AimHigh15..90 / AimLow15..90 (held aim states; 0x002B is
        ///                   MagicBlast and is deliberately NOT in the range);
        ///   0x003A          StopTurning;
        ///   0x009C..0x009F  EnterGame / ExitGame / OnCreation / OnDestruction;
        ///   0x00E2..0x00E3  Blink / Bite (the ambient fidgets);
        ///   0x00EA..0x00F8, 0x00FA..0x00FD, 0x0118, 0x011A..0x011C, 0x013D..0x0149
        ///                   the held "*State" emote variants (ShakeFistState..AtEaseState) - a held
        ///                   pose, not a gesture. 0x0119 is absent from the Python set and so from
        ///                   here; 0x011E (LogOut) is its own single-value range.</summary>
        private static readonly ushort[] IdleRanges = {
            0x0003, 0x0004,
            0x0009, 0x0009,
            0x000B, 0x000C,
            0x0012, 0x0014,
            0x001E, 0x002A,
            0x003A, 0x003A,
            0x009C, 0x009F,
            0x00E2, 0x00E3,
            0x00EA, 0x00F8,
            0x00FA, 0x00FD,
            0x0118, 0x0118,
            0x011A, 0x011C,
            0x011E, 0x011E,
            0x013D, 0x0149,
        };

        /// <summary>Dense O(1) form of <see cref="IdleRanges"/>; see <see cref="AttackLow16"/>.</summary>
        private static readonly bool[] IdleLow16 = BuildRangeTable(IdleRanges);

        /// <summary>
        /// Locomotion-class MotionCommand test (C5), the third twin of <see cref="IsAttackMotion"/>
        /// and <see cref="IsIdleMotion"/>, indexed the same way (low 16 bits only).
        ///
        /// The set is transcribed VERBATIM from the run's semantic classifier,
        /// <c>/mnt/wbterminal2/livemotion/motion_class.py</c> (its LOCOMOTION set, which is the
        /// entities.js walk/run/turn/sidestep cycle commands plus Hover, the floater locomotion
        /// cycle). It is the set of commands that mean "this body is travelling", which is exactly
        /// when a procedural step cycle is legal.
        /// </summary>
        private static bool IsLocomotionMotion(uint motion) {
            uint low = motion & 0xFFFFu;
            return low < (uint)LocomotionLow16.Length && LocomotionLow16[low];
        }

        /// <summary>The locomotion low-16 ranges, inclusive, transcribed from motion_class.py's
        /// LOCOMOTION set.
        ///   0x0001..0x0002  HoldRun / HoldSidestep;
        ///   0x0005..0x0007  WalkForward / WalkBackwards / RunForward;
        ///   0x000A          Hover (the floater locomotion cycle);
        ///   0x000D..0x0010  TurnRight / TurnLeft / SideStepRight / SideStepLeft.
        /// 0x0003/0x0004 (Ready/Stop) and 0x0009 (Interpolating) sit in the IDLE set and are
        /// deliberately absent, as are 0x000B/0x000C (On/Off).</summary>
        private static readonly ushort[] LocomotionRanges = {
            0x0001, 0x0002,
            0x0005, 0x0007,
            0x000A, 0x000A,
            0x000D, 0x0010,
        };

        /// <summary>Dense O(1) form of <see cref="LocomotionRanges"/>; see <see cref="AttackLow16"/>.</summary>
        private static readonly bool[] LocomotionLow16 = BuildRangeTable(LocomotionRanges);

        /// <summary>Dense lookup table from a flat [lo, hi] inclusive-range list. Runs in the class
        /// constructor (which the plugin's warmup forces on the managed thread), never in a
        /// detour.</summary>
        private static bool[] BuildRangeTable(ushort[] ranges) {
            int max = 0;
            for (int i = 1; i < ranges.Length; i += 2) if (ranges[i] > max) max = ranges[i];
            var t = new bool[max + 1];
            for (int i = 0; i + 1 < ranges.Length; i += 2)
                for (int v = ranges[i]; v <= ranges[i + 1]; v++) t[v] = true;
            return t;
        }

        private static bool IsFinite(float v) => !float.IsNaN(v) && !float.IsInfinity(v);

        /// <summary>The setup's DAT DataID, the key the profile table (and hence the Tier-0 role
        /// weights) is stored under. Same walk as <c>RagdollRegistry.SetupDidOf</c>.</summary>
        private static uint SetupDidOf(CSetup* setup) =>
            setup == null ? 0u : setup->BaseClass_SerializeUsingPackDBObj.BaseClass_DBObj.m_DID.BaseClass_uint;

        // ------------------------------------------------------------------ player exclusion

        private enum PlayerTest { Unknown, Player, NotPlayer }

        /// <summary>
        /// The client's OWN answer to "is this a player", read as a field rather than called:
        /// <c>ACCWeenieObject::IsPlayer</c> (shipped VA 0x0058D6C0) is literally
        /// <c>return (this-&gt;pwd._bitfield &gt;&gt; 3) &amp; 1</c>, and bit 3 is
        /// <c>PublicWeenieDesc.BitfieldIndex.BF_PLAYER = 0x8</c> - two independent sources agreeing
        /// byte for byte (C0 report §6). Reached through ACBindings' typed path
        /// <c>CPhysicsObj.weenie_obj -&gt; ACCWeenieObject.pwd._bitfield</c>, which is the same field
        /// walk as the PDB offsets +300 / +152 / +104.
        ///
        /// Deliberately TRI-STATE and fail-closed. <c>weenie_obj</c> is null for objects mid-stream and
        /// for pure-physics props, and the <c>_phys_obj</c> back-pointer is a cheap sanity check that
        /// the thing we are reading really is an ACCWeenieObject. Neither of those is "not a player" -
        /// they are "cannot tell", and the caller must not arm on a body it cannot classify.
        /// </summary>
        private static PlayerTest IsPlayerObject(CPhysicsObj* obj) {
            if (obj == null) return PlayerTest.Unknown;
            var w = (ACCWeenieObject*)obj->weenie_obj;
            if (w == null) return PlayerTest.Unknown;            // not streamed / not a weenie object
            if (w->_phys_obj != obj) return PlayerTest.Unknown;  // failed the cast sanity check
            return (w->pwd._bitfield & 0x8u) != 0 ? PlayerTest.Player : PlayerTest.NotPlayer;
        }

        // ------------------------------------------------------------------ splatter geometry

        /// <summary>
        /// Decode the free geometry the server put in the splatter value. ACE picks the script as
        /// <c>"Splatter" + height + dir</c>, where height is the ATTACKER's AttackHeight (Low/Mid/Up)
        /// and dir is the quadrant of the attacker relative to the TARGET's facing (Left/Right x
        /// Back/Front). The 12 values are ordered Low,Mid,Up x Left,Right x Back,Front
        /// (ACE PlayScript.cs:96-107, byte-identical to the PDB enum), i.e. for
        /// <c>i = script - 0x5B</c>: height = i/4, left = ((i%4)/2)==0, front = (i%2)==1.
        ///
        /// The impulse pushes the target AWAY from where the attacker stood: attacker in FRONT drives
        /// the body along target-local -Y, attacker on the LEFT drives it along target-local +X.
        /// Normalised so a diagonal is not sqrt(2) stronger than an axis hit.
        /// </summary>
        private static void DecodeSplatter(int script, out float dirX, out float dirY, out byte height) {
            int i = script - SplatterMin;      // 0..11, caller has already range-checked
            height = (byte)(i / 4);            // 0 Low, 1 Mid, 2 Up
            int q = i % 4;                     // 0 LeftBack, 1 LeftFront, 2 RightBack, 3 RightFront
            bool left = q < 2;
            bool front = (q & 1) != 0;
            const float Inv = 0.70710678f;     // 1/sqrt(2)
            dirX = left ? Inv : -Inv;          // away from the attacker's side
            dirY = front ? -Inv : Inv;         // away from the attacker's front/back
        }

        // ------------------------------------------------------------------ lifetime

        /// <summary>Drop entries that have gone quiet or were never seen. Caller holds
        /// <see cref="_gate"/>.</summary>
        private void MaybeSweep(long now) {
            if (now - _lastSweepTick < SweepThrottleMillis) return;
            _lastSweepTick = now;
            if (_live.Count == 0) return;

            List<uint>? dead = null;
            foreach (var kv in _live) {
                LiveEntry e = kv.Value;
                bool gone = e.LastTouchTick == 0
                    ? now - e.CreatedTick > UnseenTtlMillis
                    : now - e.LastTouchTick > EntryTtlMillis && now - e.LastHitTick > EntryTtlMillis;
                if (gone) (dead ??= new List<uint>()).Add(kv.Key);
            }
            if (dead != null) foreach (uint id in dead) Remove(id);
        }

        /// <summary>Caller holds <see cref="_gate"/>.</summary>
        private void Remove(uint id) {
            if (!_live.Remove(id)) return;
            _workCount = _live.Count;
            if (_live.Count == 0) ArmUpdateParts(false);
        }

        private void ArmUpdateParts(bool enabled) {
            try { _setUpdatePartsHook(enabled); }
            catch (Exception ex) { _log.LogError(ex, "livemotion: failed to {S} UpdateParts hook", enabled ? "arm" : "disarm"); }
        }

        /// <summary>
        /// WARMUP ONLY (called on the managed Initialize() thread, on a throwaway instance). Runs the
        /// correlation/entry-management internals once with the tuning forced to the shipped defaults.
        ///
        /// Why this exists and the handler-driven warmup is not enough: from C3 both net handlers
        /// return EARLY when the cfg says <c>livemotion=0</c>, so on a machine whose ragdoll.cfg boots
        /// the layer off, driving the handlers would JIT nothing past the switch - and the first hit
        /// after someone flips the knob back on would then be JITing
        /// <c>Dictionary&lt;uint, LiveEntry&gt;</c>'s insert on a native-originated stack, which is
        /// exactly the 0x80131509 failure the whole warmup exists to prevent. Calling the internals
        /// directly makes the warmup independent of what the cfg happens to say.
        /// </summary>
        internal void WarmupJit() {
            long now = Environment.TickCount64;
            LiveMotionTuning t = LiveMotionTuning.Defaults;
            // The single-writer gate is reached from BOTH the net handler and the UpdateParts detour, so
            // it is realised here for real rather than merely PrepareMethod'ed: the Func<uint, bool>
            // instantiation and its Invoke stub must exist before a native-originated stack calls one.
            // (The plugin binds the throwaway harness instance to a real delegate for exactly this.)
            _ = DeathOwns(1u);
            var imp = new PendingImpulse {
                Seq = ++_seq, ScriptType = SplatterMin, DirX = 0.7071f, DirY = -0.7071f,
                Height = 1, Speed = 1f, DamagePercent = t.DefaultDamagePercent, Tick = now,
            };
            lock (_gate) {
                TryClaimDamage(now, ref imp);
                Push(1u, imp, now, t);            // Dictionary insert + the arm vote (a no-op delegate)
                RecordSplat(1u, imp.Seq, now, false);
                RecordDamage(now, 0.5f, 1u, 0u, false);
                TryEnrichSplat(now, 0.5f, 1u, 0u, false);
                MaybeSweep(now);
                Remove(1u);                       // Dictionary remove + the disarm vote
                Array.Clear(_splatRing, 0, RingSize);
                Array.Clear(_dmgRing, 0, RingSize);
                _splatNext = 0;
                _dmgNext = 0;
            }

            // C4: the idle math is reached from the UpdateParts detour too, so it gets the same
            // treatment - RUN it here (PrepareMethod does not prepare callees, and the profile role
            // lookup instantiates a THIRD Dictionary<uint, T>). Two parts, one frame, thrown away.
            _ = IsIdleMotion(0x41000003u);        // Ready: builds IdleLow16 if the cctor has not
            _ = RagdollProfiles.RolesFor(0u);     // Dictionary<uint, BodyRoles> lookup
            var loose = new float[2];
            loose[1] = 1f;
            if (IdleMotion.Build(BodyArchetype.Floater, null, null, loose, 2,
                                 out float[]? wv, out float[]? ws)) {
                var buf = new float[6];
                float ph = IdleMotion.AdvancePhase(IdleMotion.PhaseFor(1u), t.IdleHz, 1f / 30f);
                IdleMotion.Accumulate(buf, 2, wv!, ws, 0.01f, 0.05f, ph, ph);
                IdleMotion.Combine(0f, 0f, 0f, 1f, buf[0], buf[1], buf[2], true, 0.05f, WriteEpsilonYd,
                                   out _, out _, out _);
            }
            _ = IdleMotion.Lingering(now, now, t.IdleMotion, true, t.IdleLingerSec);
            _ = IdleMotion.ParseArchetype("biped");
            _ = IdleMotion.ParseRole("core");

            // C5: the gait math is reached from the same UpdateParts detour, so it gets the same
            // treatment - RUN it, do not merely PrepareMethod it. One throwaway body of the target
            // shape, one frame, thrown away. GaitMotion.Applies is called BOTH ways so the compare
            // and the reject path are both JITed.
            _ = IsLocomotionMotion(0x45000005u);      // WalkForward: builds LocomotionLow16 if needed
            _ = GaitMotion.Applies(0u, GaitMotion.MinPartCount);
            if (GaitMotion.Applies(GaitMotion.TargetSetupDid, GaitMotion.MinPartCount)) {
                var gbuf = new float[GaitMotion.MinPartCount * 3];
                float gspeed = GaitMotion.UpdateSpeed(0f, 0.1f, 0.05f, 1f / 30f);
                float ghz = GaitMotion.CadenceHz(t.GaitCadenceHz, gspeed, true);
                float gph = IdleMotion.AdvancePhase(IdleMotion.PhaseFor(1u ^ 0x85EBCA6Bu), ghz, 1f / 30f);
                GaitMotion.Accumulate(gbuf, GaitMotion.MinPartCount, 0.02f, 0.05f, gph);
                IdleMotion.Combine(0f, 0f, 0f, 1f, gbuf[42], gbuf[43], gbuf[44], true, 0.05f,
                                   WriteEpsilonYd, out _, out _, out _);
            }
        }

        /// <summary>Called from the plugin on unload, AFTER the detours have been disabled and the
        /// network subscriptions have been dropped.</summary>
        public void Shutdown() {
            _down = true;
            lock (_gate) {
                _live.Clear();
                Array.Clear(_splatRing, 0, RingSize);
                Array.Clear(_dmgRing, 0, RingSize);
                _workCount = 0;
            }
        }

        // ------------------------------------------------------------------ helpers

        private static uint ObjIdOf(CPhysicsObj* obj) =>
            obj->BaseClass_LongHashData.BaseClass_HashBaseData.id;

        /// <summary>
        /// C0 report §9, open question 1: is the winsock recv path really on the sim thread? One line
        /// from each side answers it. Same managed thread id =&gt; §7 is confirmed and
        /// <see cref="_gate"/> can be deleted; different ids =&gt; the lock was load-bearing and the
        /// design already handles it. Logs exactly once per session, after BOTH sides have reported.
        /// </summary>
        private void LogThreadIdOnce(bool net) {
            if (_threadIdsLogged) return;
            int tid = Environment.CurrentManagedThreadId;
            if (net) { if (_netThreadId != 0) return; _netThreadId = tid; }
            else { if (_simThreadId != 0) return; _simThreadId = tid; }
            if (_netThreadId == 0 || _simThreadId == 0) return;
            _threadIdsLogged = true;
            _log.LogInformation(
                "livemotion THREADS netHandler={Net} updateParts={Sim} same={Same} " +
                "(same => C0 §7 confirmed, the correlation lock is removable)",
                _netThreadId, _simThreadId, _netThreadId == _simThreadId);
        }

        private void LogSafe(Exception ex, string where) {
            // Chorizite's WeakEvent.Invoke swallows handler exceptions and logs them under its own
            // category; log under ours so a broken handler is attributable here.
            try { _log.LogError(ex, "livemotion: {Where} threw (swallowed)", where); }
            catch { }
        }
    }
}
