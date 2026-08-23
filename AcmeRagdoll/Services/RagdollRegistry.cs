using System;
using System.Collections.Generic;
using System.Threading;
using ACBindings.Internal;
using AcmeRagdoll.Lib;
using AcmeRagdoll.Sim;
using Microsoft.Extensions.Logging;

namespace AcmeRagdoll.Services {
    /// <summary>
    /// Owns the set of currently-ragdolling creatures and does the per-frame work: seed a sim from
    /// the live model-space pose the first frame after death, then each subsequent frame step the sim
    /// (or hold the settled pose) and overwrite each owned part's world Frame.
    ///
    /// SINGLE-WRITER OWNERSHIP (2026-08-23).  A dying body must be animated by EXACTLY ONE writer -
    /// the ragdoll armed at the death hit - from the hit through topple, settle and the corpse
    /// handoff.  Three other writers used to fight it, and all three are shut out here:
    ///   * THE LIVE-MOTION LAYER.  The killing blow's splatter arms a <see cref="LiveMotionRegistry"/>
    ///     flinch on the same object, which then ADDS spring/idle/gait offsets on top of the ragdoll
    ///     pose every frame until its pool decays.  Every object id this registry owns is published
    ///     into a lock-free <see cref="IsDeathOwned"/> set that the live layer consults before it
    ///     arms one and before it writes one; a death-owned body is retired from that layer outright.
    ///   * THE CANNED DEAD ANIMATION'S ROOT MOTION.  We deliberately still call the original
    ///     DoInterpretedMotion (the client's Dead state machine and the MotionDone fallback depend on
    ///     it), so the canned animation keeps running underneath and keeps moving/rotating
    ///     <c>m_position.frame</c> - the very frame <see cref="WriteParts"/> composed the sim pose
    ///     onto, which dragged and rotated the whole ragdoll.  The composition basis is now FROZEN at
    ///     seed time (<see cref="ResolveBasis"/>) so root motion cannot move the body; only a
    ///     landblock change rebases it (origins are landblock-local, LandDefs::get_block_offset).
    ///   * THE REVIVE EVICTION.  A non-Dead MotionDone on a tracked owner used to drop the entry
    ///     silently, so any queued motion completing on a dying creature cancelled the ragdoll
    ///     mid-fall and let the canned animation take over (and the corpse then re-crumpled).  That
    ///     eviction is now scoped to a genuinely-alive-again body: locomotion-class only, never a
    ///     corpse, never during the fall window, and it logs.
    ///
    /// CORPSE CONTINUATION (the "one continuous ragdoll" behaviour).  In AC a dying creature is
    /// replaced by a SEPARATE corpse object (its own object id) that spawns at the death location and
    /// plays the same Dead motion.  Left alone that corpse arms its OWN ragdoll from its standing pose
    /// with a different random fall (seed = object id), producing a visible SECOND crumple unrelated to
    /// the death-hit ragdoll.  We stop that: while the creature's death-hit ragdoll runs we keep a
    /// <see cref="HandoffRecord"/> - the evolving verlet state plus the construction inputs that
    /// regenerate its constraints - keyed by a stable correlation key (skeleton signature + landcell +
    /// quantized world XY).  When a NEW object arms a Dead ragdoll and matches a recent record (same
    /// part count, same cell, within <see cref="HandoffMaxDistXY"/> yd, within
    /// <see cref="HandoffWindowMillis"/> ms) we treat it as the CORPSE: rebuild its sim from the record,
    /// fast-forward it to the recorded instant and let it CONTINUE (or hold) - no re-seed, no second
    /// topple impulse, no reset-to-standing.  The record is consumed so it matches once.  With no match
    /// (a normal live creature death) behaviour is exactly as before: crumple from the hit.
    ///
    /// THREADING.  Both entry points (<see cref="OnMotionDone"/> and <see cref="OnUpdateParts"/>) are
    /// called from the client's single simulation thread, from inside the native detours in
    /// <see cref="NativeHooks"/>.  Because they share that one thread, the plain
    /// <see cref="Dictionary{TKey,TValue}"/> / <see cref="List{T}"/> are accessed without locks on the
    /// hot path.  Teardown (<see cref="Shutdown"/>) runs on a different thread but only AFTER
    /// NativeHooks has disabled the detours, and it flips <see cref="_down"/> which both detours check
    /// first.
    ///
    /// LIFETIME + POINTER SAFETY (the traps the research calls out):
    ///   * never cache a CPhysicsPart* across frames - parts are re-resolved from the live CPartArray
    ///     every frame and every parts[i] is null-checked;
    ///   * entries are keyed by the stable object id, and the captured CPhysicsObj*/CPartArray* are
    ///     re-verified each frame so a freed-then-reused id/pointer cannot be written through;
    ///   * despawned corpses stop generating UpdateParts calls, so their entries are swept by
    ///     "not touched recently" during the next death; live corpses are released after a hold cap;
    ///   * a HandoffRecord holds only VALUE data (copied arrays, ids, floats) - never a live client
    ///     pointer - so it is safe to outlive the creature object it was captured from.
    /// </summary>
    internal sealed unsafe class RagdollRegistry {
        private sealed class Entry {
            public uint ObjId;
            public CPhysicsObj* Obj;
            public CPartArray* Parts;      // captured at seed
            public RagdollSim? Sim;
            public Quat[]? Scratch;
            public bool Seeded;
            public bool IsCorpse;          // classified as a corpse-handoff (for logging / no re-record)
            public bool Pending;           // armed Dead but world position not yet valid; classify later
            public int PendingFrames;      // frames spent waiting for a valid position
            public int MatchRetries;       // frames a positioned corpse has waited for a handoff record
            public int SeedAttempts;
            public int ActiveLeft;         // frames of active fall remaining
            public long ArmedTick;         // for the hold cap
            public long LastTouchTick;     // for despawn sweep
            public HandoffRecord? Rec;     // creature entries record their evolving pose here; null for corpses

            // ---- world-space fall (airborne-death fix) ----
            // The verlet sim runs in MODEL space and settles the body onto its own model-space floor,
            // which world-transforms to ~the death height. For a creature that died in the AIR that is
            // floating, not the ground. These fields drive a WORLD-space vertical drop (applied in
            // WriteParts as a Z offset on every part) that grows under gravity until the body's lowest
            // part reaches the real terrain height under its XY, then holds. For a GROUNDED death the
            // gap is ~0, Airborne stays false, FallOffset stays 0 and the output is byte-for-byte the
            // old behaviour. All of this is carried through the corpse handoff (HandoffRecord) so the
            // corpse continues an in-progress fall instead of snapping.
            public bool FallDecided;       // airborne-vs-grounded classification has run
            public bool Airborne;          // true => apply the world-space fall
            public bool Landed;            // lowest part has reached the terrain; hold FallOffset
            public float FallOffset;       // accumulated downward world displacement (yd, >= 0)
            public float FallVel;          // current fall speed (yd/s)
            public float GroundZ;          // terrain Z under the corpse XY (m_position basis)
            public bool GroundZValid;      // GroundZ has been resolved from the client terrain

            // ---- frozen composition basis (single-writer, root-motion neutralisation) ----
            // WriteParts composes the model-space sim pose onto the object frame. Re-reading the LIVE
            // frame every frame let the canned Dead animation's root motion (its per-anim drop, ground
            // travel and rotation sweep - real nonzero values) drag and rotate the entire ragdoll, and
            // did the same to a corpse whose own Dead motion plays under the handoff sim. So the basis
            // is captured ONCE, on the entry's first write, and used for the rest of its life.
            // m_position origins are LANDBLOCK-local (LandDefs::get_block_offset returns 0 whenever the
            // two cells share their high 16 bits), so a cell change inside the landblock needs nothing
            // and a landblock change is rebased by 192 yd per block step.
            public bool BasisFrozen;
            public Quat BasisQ;
            public float BasisX, BasisY, BasisZ;
            public uint BasisCell;
            /// <summary>Corpse handoff only: <see cref="BasisQ"/> was inherited from the creature's
            /// record and must be used instead of the corpse's own spawn orientation (the sim state we
            /// restore was evolved in the creature's rotational frame).</summary>
            public bool BasisQInherited;
            public bool BasisRebasedLogged;
        }

        /// <summary>
        /// A creature's death-hit ragdoll, captured as pure value data so it can be handed to the corpse
        /// that replaces the creature. Holds the construction inputs (which regenerate an identical sim)
        /// plus the evolving verlet state, refreshed every frame while the creature ragdoll lives.
        /// </summary>
        private sealed class HandoffRecord {
            // correlation key
            public uint NumParts;
            public uint ParentHash;
            public uint Objcell;
            public float X, Y;
            public uint SetupDid;          // diagnostic only

            // construction inputs (regenerate identical constraints/braces/give schedule)
            public uint[] Parent = Array.Empty<uint>();
            public float[] StartPos0 = Array.Empty<float>();
            public Quat[] StartQuats0 = Array.Empty<Quat>();
            public uint Seed;
            public float Direction;
            public float FloorZ;
            /// <summary>This death's orientation commit (how hard the sim fights the body's own
            /// center-of-mass bias to fall along <see cref="Direction"/>). Sampled ONCE per creature
            /// death; carried here for exactly the same reason Direction is — the corpse must rebuild
            /// with it or its seeded velocities, and therefore the restored verlet state, would not
            /// match the creature's and the fall would visibly jump at handoff.</summary>
            public float OrientCommit;
            /// <summary>This body's per-setupDid tuning (pure value data, so it is safe here). The
            /// corpse MUST rebuild with the same params or its constraints/give schedule - and hence
            /// the restored verlet state - would not match the creature's.</summary>
            public RagdollParams Params = RagdollParams.Default;

            // evolving verlet state (refreshed each frame from the live sim)
            public float[] Pos = Array.Empty<float>();
            public float[] Prev = Array.Empty<float>();
            public float T;
            public int ActiveLeftRemaining;

            // evolving WORLD-space fall state (so the corpse continues an in-progress airborne fall).
            // GroundZ is NOT carried: the corpse recomputes terrain for its own XY/slope, but it
            // inherits the fall progress (offset/velocity/decision) so there is no snap at handoff.
            public bool Airborne;
            public bool FallDecided;
            public bool Landed;
            public float FallOffset;
            public float FallVel;

            /// <summary>The creature's FROZEN composition orientation. The corpse rebuilds the sim from
            /// this record's verlet state, which was evolved in the creature's rotational frame - so it
            /// must compose with the creature's orientation or the settled pile visibly re-orients at
            /// handoff (a "second animation" in its own right). The ORIGIN is deliberately NOT carried:
            /// records are SHARED between the clustered corpses of a simultaneous death, and giving them
            /// all one origin would stack every body on one spot; each corpse keeps its own.</summary>
            public Quat BasisQ;
            public bool BasisValid;

            // How many corpses have continued this record (shared handoff — see ArmCorpseHandoff). Kept
            // for diagnostics; the record's lifetime is bounded by the window/TTL, not by this count.
            public int MatchCount;

            public long UpdatedTick;
        }

        private const int MaxLive = 64;              // safety cap on concurrent ragdolls
        private const int SeedAttemptsMax = 10;      // give up if the pose never reads clean
        // Hold cap. Previously 30 s, which is why a settled ragdoll "reverted" to the client's canned
        // dead pose after ~30 s while the corpse was still on the ground: once we Remove the entry the
        // UpdateParts detour stops overwriting the parts and the client's own last write (the default
        // Dead animation frame) shows through. AC creature corpses despawn in ~5 min, so hold well past
        // that; a corpse that despawns earlier stops generating UpdateParts and is reclaimed by the
        // despawn sweep, and an id reused by a new object is caught by the e.Obj != owner guard. This is
        // only a runaway safety valve now, not the normal end of a ragdoll.
        private const long HoldMillis = 900_000;     // 15 min safety cap (was 30 s -> caused the revert)
        private const long DespawnMillis = 2_000;    // sweep entries not touched in this long

        // ------------------------------------------------------------------ world-fall tuning
        //   * AirborneEps  - how far (yd) the body's lowest part must sit ABOVE the terrain at death for
        //                    the death to count as airborne. Grounded deaths land ~0 above terrain; a
        //                    hovering wasp is a yard or more up. Raise if grounded deaths on steep slopes
        //                    ever misclassify as airborne (a tiny extra drop); lower if a low hover is
        //                    left floating.
        //   * WorldGravity - fall acceleration in world yards/s^2 (retail terrain gravity is 9.8).
        //   * MaxFallSpeed - terminal fall speed cap (yd/s); stops a very high death tunnelling through
        //                    the ground in a single frame before the per-frame contact clamp catches it.
        private const float AirborneEps = 0.5f;
        //   * FloorMargin  - the anti-sink clamp keeps the lowest part's world origin at least this far
        //                    (yd) ABOVE the surface the body rests on, so no part dips into the floor.
        //                    Small and positive per the "bottom of any part above floor Z" rule; a part's
        //                    mesh hangs a little below its origin, so a hair of margin keeps the visible
        //                    geometry off the floor without the corpse looking like it hovers.
        private const float FloorMargin = 0.03f;
        private const float WorldGravity = 9.8f;
        private const float WorldDt = 1.0f / RagdollSim.FPS;   // one rendered frame
        private const float MaxFallSpeed = 40.0f;

        // ------------------------------------------------------------------ handoff tuning
        // These are the knobs to watch/adjust from the 1070 arm logs (see OnMotionDone logging).
        //   * HandoffMaxDistXY   - max XY distance (yards) between the creature's recorded position and
        //                          the corpse's spawn position for them to be considered the same body.
        //                          The corpse spawns essentially on the death spot, so a few yards is
        //                          generous; loosen if logs show real corpses arriving farther away.
        //   * HandoffWindowMillis - a record is eligible for this long after its last refresh. The
        //                          corpse usually appears within a second or two of death; keep it a few
        //                          seconds so a slow corpse still connects, but short enough that an
        //                          UNRELATED later death of the same creature type nearby does not match.
        //   * HandoffRecordTtl   - a record is discarded outright once it has not been refreshed for this
        //                          long (its creature ragdoll despawned). >= HandoffWindowMillis.
        //   * RequireSameCell    - when true a corpse must be in the SAME objcell as the recorded
        //                          creature (robust: corpses spawn on the death cell). Set false to allow
        //                          a same-landblock match if logs show corpses landing in a neighbour cell.
        private const float HandoffMaxDistXY = 6.0f;
        private const long HandoffWindowMillis = 8_000;
        private const long HandoffRecordTtl = 8_000;
        private static readonly bool RequireSameCell = true;

        // Position-validity gate. Objects arm the Dead motion the instant their object-create is applied,
        // which can be BEFORE m_position is set (cell_id == 0, origin == 0). Such an arm cannot be
        // correlated (zero position matches nothing) and, if armed, spawns a ghost ragdoll at the world
        // origin - the "both bodies present / skipped death-hit" the user saw. We refuse to arm or record
        // from an object whose world position is not yet valid; it re-arms later (its Dead animation's
        // MotionDone, or a subsequent DoInterpretedMotion) once positioned.
        private const float PosEps = 0.01f;   // |x|,|y| below this (with cell 0) reads as "not positioned yet"

        // A deferred (PENDING) arm waits this many UpdateParts frames / this long for its world position
        // to populate before we give up on it (class=SKIP-nopos). Positions normally appear within a
        // frame or two; these are generous so a slow corpse still resolves.
        private const int PendingFramesMax = 30;        // ~1 s at 30 fps
        private const long PendingTimeoutMillis = 2_000;

        // A corpse that positions before its creature's handoff record has been created (a timing race
        // under simultaneous @smite/AoE deaths) finds no record and would re-seed a FRESH ragdoll — the
        // residual "second ragdoll" the shared-handoff change does not cover. Give a positioned entry
        // that found no record this many frames to wait for one to appear before falling back to a fresh
        // crumple. ~6 frames = 0.2 s: invisible for the rare genuinely-fresh nopos creature, ample for
        // the record (created the same tick the creature's own death is processed) to show up.
        private const int MatchRetryMax = 6;

        private readonly Dictionary<uint, Entry> _live = new(MaxLive);
        private readonly List<HandoffRecord> _records = new(8);
        private readonly Action<bool> _setUpdatePartsHook;
        private readonly ILogger _log;
        private volatile bool _down;

        // ------------------------------------------------------------------ ownership publication
        //
        // The set of object ids this registry owns, published so ANOTHER writer can ask "is this body
        // mine?" without touching _live. It exists because _live is a plain Dictionary mutated on the
        // client's sim thread with no lock (see THREADING above), while the live-motion layer's arming
        // path runs from a NET callback whose thread identity is not proven - reading the Dictionary
        // from there would be a genuine data race. A fixed uint[] of slots, written only on the sim
        // thread and read with Volatile.Read, is race-free by construction (a uint write is atomic, so
        // the worst a concurrent reader can see is a one-frame-stale answer, which costs at most one
        // frame of flinch overlay), allocation-free on both sides, and takes NO LOCK AT ALL - so it
        // cannot participate in a lock-ordering cycle with the live layer's own gate.
        private readonly uint[] _ownedIds = new uint[MaxLive];
        /// <summary>Mirror of <see cref="_live"/>.Count, so the overwhelmingly common "nothing is
        /// dying" answer costs one volatile int read instead of a 64-slot scan.</summary>
        private volatile int _ownedCount;

        /// <param name="setUpdatePartsHook">Enables (true) / disables (false) the UpdateParts detour.
        /// Called only when the live count crosses 0 so the hot-path detour is armed only while at
        /// least one ragdoll is active.</param>
        /// <param name="log">Plugin logger.</param>
        public RagdollRegistry(Action<bool> setUpdatePartsHook, ILogger log) {
            _setUpdatePartsHook = setUpdatePartsHook;
            _log = log;
        }

        public int LiveCount => _live.Count;

        /// <summary>
        /// Is this object id currently owned by a death ragdoll (armed, pending, seeding, falling,
        /// settled or handed off to a corpse)? THE SINGLE-WRITER GATE: any other layer that would
        /// animate a body must ask this first and yield.
        ///
        /// Callable from any thread and takes no lock (see <see cref="_ownedIds"/>). Allocation-free,
        /// and pre-JITed by the plugin warmup like every other detour/net-callback-reachable method.
        /// </summary>
        public bool IsDeathOwned(uint id) {
            if (id == 0) return false;
            if (_ownedCount == 0) return false;          // volatile read; the common case
            uint[] ids = _ownedIds;
            for (int i = 0; i < ids.Length; i++)
                if (Volatile.Read(ref ids[i]) == id) return true;
            return false;
        }

        /// <summary>Publish an owned id. Sim thread only, paired with <see cref="OwnRelease"/>.</summary>
        private void OwnPublish(uint id) {
            if (id == 0) return;
            uint[] ids = _ownedIds;
            for (int i = 0; i < ids.Length; i++) {
                if (Volatile.Read(ref ids[i]) == id) return;      // already published
                if (ids[i] == 0) { Volatile.Write(ref ids[i], id); _ownedCount = _ownedCount + 1; return; }
            }
            // No free slot: _live is capped at MaxLive == slot count, so this is unreachable unless the
            // two drift apart. Fail LOUD-ish but harmlessly - the body still ragdolls, it just is not
            // protected from the live layer this death.
            _log.LogWarning("ragdoll: ownership table full; id=0x{Id:X8} unprotected", id);
        }

        /// <summary>Retract an owned id. Sim thread only.</summary>
        private void OwnRelease(uint id) {
            if (id == 0) return;
            uint[] ids = _ownedIds;
            for (int i = 0; i < ids.Length; i++) {
                if (Volatile.Read(ref ids[i]) != id) continue;
                Volatile.Write(ref ids[i], 0u);
                int c = _ownedCount - 1;
                _ownedCount = c < 0 ? 0 : c;
                return;
            }
        }

        /// <summary>The one place an entry enters <see cref="_live"/>: registers it, publishes its
        /// ownership and arms the hot detour on the 0 -&gt; 1 transition.</summary>
        private void AddLive(uint id, Entry e) {
            _live[id] = e;
            OwnPublish(id);
            if (_live.Count == 1) ArmUpdateParts(true);
        }

        /// <summary>Death signal. Arms a ragdoll for an object whose Dead motion just began/finished.
        /// Classifies the object as either a fresh CREATURE crumple or the CORPSE continuation of a
        /// recently-recorded creature ragdoll.</summary>
        public void OnMotionDone(CPhysicsObj* obj, uint motion) {
            if (_down || obj == null) return;
            if (motion != DeadMotion) {
                // FINDING 1 (event-driven disarm), RESCOPED 2026-08-23.
                //
                // The original rule was "ANY non-Dead MotionDone on a tracked owner means it is alive
                // again - drop the entry". Its purpose is real: a player who dies and releases to the
                // lifestone is the same CPhysicsObj/CPartArray, so without a disarm WriteParts keeps
                // overwriting a live, running body with its settled corpse pose until the 15-minute
                // HoldMillis backstop.
                //
                // But it also fired on a body that was merely DYING. A motion queued before the killing
                // blow (an interrupted swing, a hit flinch, a server-sent motion) completes a few frames
                // AFTER the death-start arm, and the old rule cancelled the ragdoll mid-fall: the canned
                // Dead animation visibly took over, the handoff record went with it, and the corpse then
                // matched nothing and crumpled FRESH - i.e. a second death animation. It did all of that
                // with no log line, which is why it was never seen in the ARM logs.
                //
                // Rescoped to a body that is genuinely alive again, and it now LOGS:
                //   * the completed motion must be LOCOMOTION-class (walk/run/turn/sidestep/hover). A
                //     corpse never walks; a resurrected player does within a step or two. Attack-class
                //     is deliberately NOT a trigger - an interrupted attack completing is exactly the
                //     race above.
                //   * never a corpse entry (a corpse object is never alive again),
                //   * never while the entry is still PENDING classification or still actively falling,
                //   * and not until the fall window has demonstrably passed (ReviveGraceMillis).
                uint liveId = ObjIdOf(obj);
                if (liveId != 0 && _live.TryGetValue(liveId, out Entry? le) && le != null && le.Obj == obj
                    && IsReviveMotion(motion) && !le.IsCorpse && !le.Pending && le.ActiveLeft <= 0
                    && Environment.TickCount64 - le.ArmedTick > ReviveGraceMillis) {
                    AsyncLog.Post(
                        "ragdoll RELEASE id=0x" + liveId.ToString("X8") +
                        " motion=0x" + motion.ToString("X8") +
                        " class=REVIVE-locomotion (alive again after " +
                        (Environment.TickCount64 - le.ArmedTick).ToString() +
                        "ms; entry + handoff record dropped)");
                    if (le.Rec != null) _records.Remove(le.Rec);
                    Remove(liveId);
                }
                // HARDENING: SweepStale used to run ONLY on a Dead arm, so if a corpse despawned and
                // nothing else died afterwards its entry (and the hot UpdateParts hook it keeps armed)
                // stayed live indefinitely. Non-Dead MotionDone fires constantly for every animating
                // object, so piggy-back a THROTTLED sweep on it - at most once every SweepThrottleMillis,
                // and skipped outright when there is nothing to sweep, so the common path is a couple of
                // count checks and no allocation.
                MaybeSweepStale();
                return;
            }

            SweepStale();

            CPartArray* pa = obj->part_array;
            if (pa == null) return;
            CSetup* setup = (CSetup*)pa->setup;
            if (setup == null) return;
            if (pa->num_parts < 2) return;                 // single-part = not a skeleton
            if (setup->has_physics_bsp != 0) return;       // per-part BSP => not a render-only creature

            uint id = ObjIdOf(obj);
            if (id == 0 || _live.ContainsKey(id)) return;
            if (_live.Count >= MaxLive) return;

            // correlation key for this arming object (read from m_position, the same source both the
            // creature record and this lookup use, so they compare in one basis).
            uint numParts = pa->num_parts;
            uint parentHash = HashParents(setup, numParts);
            uint setupDid = SetupDidOf(setup);
            ReadPos(obj, out uint objcell, out float px, out float py, out float pheading);

            long now = Environment.TickCount64;

            // An object arms the Dead motion the instant its object-create is applied, which for a
            // CORPSE is BEFORE m_position is set (cell 0, origin 0) - and the corpse's Dead motion fires
            // ONLY then; it never re-arms with a valid position. So we cannot skip it (that drops the
            // corpse -> old canned pose) and we cannot arm/correlate it yet (zero position matches
            // nothing -> origin ghost). Instead DEFER: register a PENDING entry so the always-on
            // UpdateParts hook keeps delivering this object's frames, and classify it on the first frame
            // its position reads valid (a frame or two later). The corpse IS rendered, so its
            // CPartArray::UpdateParts fires every frame. ContainsKey above dedupes the corpse's repeated
            // create-time Dead arms into this single pending entry.
            if (!PosValid(objcell, px, py)) {
                AddLive(id, new Entry {
                    ObjId = id, Obj = obj, Parts = null, Seeded = false, Pending = true, IsCorpse = false,
                    ActiveLeft = 0, ArmedTick = now, LastTouchTick = now,
                });
                AsyncLog.Post(ArmLine(id, setupDid, numParts, objcell, px, py) +
                              " posValid=False class=PENDING-nopos (deferred; will classify when positioned)");
                return;
            }

            HandoffRecord? rec = TryMatchRecord(numParts, parentHash, objcell, px, py, now,
                                                out float matchDist, out long matchAge);
            if (rec != null) {
                ArmCorpseHandoff(id, obj, pa, rec, now,
                                 setupDid, numParts, objcell, px, py, parentHash, matchDist, matchAge);
                return;
            }

            // No match: a fresh creature death. Crumple from the hit exactly as before; the record is
            // created on the first UpdateParts (Seed), where the live model-space pose is available.
            AddLive(id, new Entry {
                ObjId = id, Obj = obj, Parts = null, Seeded = false, IsCorpse = false,
                ActiveLeft = RagdollSim.FallFrames, ArmedTick = now, LastTouchTick = now,
            });
            LogArm("CREATURE-crumple", id, setupDid, numParts, objcell, px, py);
        }

        /// <summary>Corpse path: rebuild the creature's sim from the record, fast-forward it to the
        /// recorded instant and let it continue/hold. No re-seed, no second topple.</summary>
        private void ArmCorpseHandoff(uint id, CPhysicsObj* obj, CPartArray* pa, HandoffRecord rec, long now,
                                      uint setupDid, uint numParts, uint objcell, float px, float py,
                                      uint parentHash, float matchDist, long matchAge) {
            RagdollSim sim;
            try {
                sim = new RagdollSim(rec.Parent, rec.StartPos0, rec.StartQuats0,
                                     rec.Seed, rec.Direction, rec.FloorZ, rec.Params, rec.OrientCommit);
                sim.RestoreState(rec.Pos, rec.Prev, rec.T);   // copies in - no aliasing with rec buffers
            }
            catch (Exception ex) {
                // If the rebuild fails for any reason, fall back to a normal crumple rather than nothing.
                _log.LogError(ex, "ragdoll: corpse handoff rebuild failed id=0x{Id:X8}; falling back to crumple", id);
                AddLive(id, new Entry {
                    ObjId = id, Obj = obj, Parts = null, Seeded = false, IsCorpse = false,
                    ActiveLeft = RagdollSim.FallFrames, ArmedTick = now, LastTouchTick = now,
                });
                return;
            }

            int n = (int)numParts;
            if (n > sim.PartCount) n = sim.PartCount;
            AddLive(id, new Entry {
                ObjId = id, Obj = obj, Parts = pa, Sim = sim, Scratch = new Quat[n],
                Seeded = true, IsCorpse = true,
                ActiveLeft = rec.ActiveLeftRemaining, ArmedTick = now, LastTouchTick = now,
                // inherit the creature's world-fall progress; recompute terrain for the corpse's own XY.
                Airborne = rec.Airborne, FallDecided = rec.FallDecided, Landed = rec.Landed,
                FallOffset = rec.FallOffset, FallVel = rec.FallVel, GroundZValid = false,
                // ...and the creature's composition ORIENTATION (see HandoffRecord.BasisQ): the restored
                // verlet state was evolved in that rotational frame. The origin is the corpse's own,
                // frozen on its first write, so clustered corpses sharing one record stay apart.
                BasisQ = rec.BasisQ, BasisQInherited = rec.BasisValid,
            });
            // SHARED handoff (NOT one-shot). When several identical creatures die together (@smite, an
            // AoE), their corpses spawn clustered and race for records; consuming a record on the first
            // match left the losers with none, so they re-seeded a FRESH ragdoll — the "second ragdoll
            // after it settled" double. Clustered same-signature creatures fall identically, so letting
            // every corpse continue the same nearby record is correct and removes the double. The record
            // still expires on its own (HandoffWindowMillis / HandoffRecordTtl in TryMatchRecord), so it
            // cannot be re-matched indefinitely; a genuinely later same-type death at the same spot would
            // just continue an equivalent fall, which is visually indistinguishable.
            rec.MatchCount++;

            bool parentMatch = parentHash == rec.ParentHash;
            AsyncLog.Post(ArmLine(id, setupDid, numParts, objcell, px, py) +
                          " posValid=True class=CORPSE-handoff matched(creatureSetupDid=0x" +
                          rec.SetupDid.ToString("X8") +
                          " dist=" + matchDist.ToString("F2") +
                          " age=" + matchAge.ToString() + "ms" +
                          " parentHashMatch=" + parentMatch.ToString() +
                          " activeLeftRemaining=" + rec.ActiveLeftRemaining.ToString() + ")");
        }

        /// <summary>
        /// Post-detour of CPartArray::UpdateParts. The original already wrote each part's world Frame;
        /// if this part array's owner is ragdolling we overwrite the parts we own, and (for a live
        /// creature ragdoll) refresh its handoff record with the current settled state.
        /// </summary>
        public void OnUpdateParts(CPartArray* pa, Frame* objFrame) {
            if (_down || pa == null || objFrame == null) return;
            CPhysicsObj* owner = pa->owner;
            if (owner == null) return;

            uint id = ObjIdOf(owner);
            if (id == 0) return;
            if (!_live.TryGetValue(id, out Entry? e) || e == null) return;

            // id-reuse guard: the captured object must still be this owner.
            if (e.Obj != owner) { Remove(id); return; }

            // Deferred arm: classify once the object's world position is valid. Until then (or until we
            // give up) do nothing else this frame.
            if (e.Pending) {
                if (!ResolvePending(e, pa, owner)) return;
                // resolved this frame: e is now either a seeded CORPSE-handoff (falls through to
                // step/write) or a CREATURE-crumple (Seeded=false -> Seed() below).
            }

            if (!e.Seeded) {
                if (!Seed(e, pa, objFrame)) {
                    if (++e.SeedAttempts >= SeedAttemptsMax) Remove(id);
                    return;
                }
            }
            else if (e.Parts != pa) {
                // the object's part array was swapped (morph/reset) - stop touching it.
                Remove(id);
                return;
            }

            long now = Environment.TickCount64;
            e.LastTouchTick = now;

            if (e.ActiveLeft > 0) { e.Sim!.StepFrame(); e.ActiveLeft--; }
            else if (now - e.ArmedTick > HoldMillis) { Remove(id); return; }

            // Write the pose (and, for an airborne death, advance/apply the world-space fall) FIRST so
            // the handoff record below captures this frame's fall progress too.
            WriteParts(e, owner, pa, objFrame);

            // Refresh this creature's handoff record with the pose it now holds, so the corpse that
            // replaces it inherits the exact settled (or in-progress) ragdoll AND its in-progress fall.
            // Corpses (Rec == null) never record.
            if (e.Rec != null) UpdateRecord(e, owner, now);
        }

        // ------------------------------------------------------------------ deferred classification

        /// <summary>
        /// Resolve a PENDING (deferred, position-not-yet-valid) entry. Returns true once the entry is
        /// classified and should proceed this frame (either a seeded CORPSE-handoff, or a CREATURE
        /// entry that <see cref="Seed"/> will handle below); false while still waiting (or after giving
        /// up, in which case the entry has been removed).
        /// </summary>
        private bool ResolvePending(Entry e, CPartArray* pa, CPhysicsObj* owner) {
            CSetup* setup = (CSetup*)pa->setup;
            if (setup == null || pa->num_parts < 2 || setup->has_physics_bsp != 0) {
                GiveUpPending(e, 0, pa->num_parts, "not-a-skeleton");
                return false;
            }

            ReadPos(owner, out uint objcell, out float px, out float py, out float _);
            long now = Environment.TickCount64;

            if (!PosValid(objcell, px, py)) {
                e.PendingFrames++;
                if (e.PendingFrames > PendingFramesMax || now - e.ArmedTick > PendingTimeoutMillis)
                    GiveUpPending(e, SetupDidOf(setup), pa->num_parts, "timeout");
                e.LastTouchTick = now;   // keep the despawn sweep from reaping a still-waiting entry
                return false;
            }

            // Position is valid now - classify exactly as the immediate path does, but on the entry we
            // already hold (keep the same object-id key).
            uint numParts = pa->num_parts;
            uint parentHash = HashParents(setup, numParts);
            uint setupDid = SetupDidOf(setup);
            HandoffRecord? rec = TryMatchRecord(numParts, parentHash, objcell, px, py, now,
                                                out float matchDist, out long matchAge);
            e.Pending = false;

            if (rec != null) {
                RagdollSim sim;
                try {
                    sim = new RagdollSim(rec.Parent, rec.StartPos0, rec.StartQuats0,
                                         rec.Seed, rec.Direction, rec.FloorZ, rec.Params, rec.OrientCommit);
                    sim.RestoreState(rec.Pos, rec.Prev, rec.T);
                }
                catch (Exception ex) {
                    _log.LogError(ex, "ragdoll: deferred corpse handoff rebuild failed id=0x{Id:X8}; falling back to crumple", e.ObjId);
                    e.Seeded = false; e.IsCorpse = false; e.ActiveLeft = RagdollSim.FallFrames;
                    return true;   // Seed() below crumples from the live pose
                }

                int n = (int)numParts;
                if (n > sim.PartCount) n = sim.PartCount;
                e.Sim = sim; e.Scratch = new Quat[n]; e.Parts = pa;
                e.Seeded = true; e.IsCorpse = true; e.ActiveLeft = rec.ActiveLeftRemaining;
                // inherit the creature's world-fall progress; recompute terrain for the corpse's own XY.
                e.Airborne = rec.Airborne; e.FallDecided = rec.FallDecided; e.Landed = rec.Landed;
                e.FallOffset = rec.FallOffset; e.FallVel = rec.FallVel; e.GroundZValid = false;
                // ...and the creature's composition orientation (see ArmCorpseHandoff).
                e.BasisQ = rec.BasisQ; e.BasisQInherited = rec.BasisValid; e.BasisFrozen = false;
                rec.MatchCount++;   // SHARED handoff, not one-shot — see ArmCorpseHandoff for why.

                bool parentMatch = parentHash == rec.ParentHash;
                AsyncLog.Post(ArmLine(e.ObjId, setupDid, numParts, objcell, px, py) +
                              " posValid=True deferred=True class=CORPSE-handoff matched(creatureSetupDid=0x" +
                              rec.SetupDid.ToString("X8") +
                              " dist=" + matchDist.ToString("F2") +
                              " age=" + matchAge.ToString() + "ms" +
                              " parentHashMatch=" + parentMatch.ToString() +
                              " activeLeftRemaining=" + rec.ActiveLeftRemaining.ToString() + ")");
                return true;
            }

            // No record yet. Under simultaneous deaths a corpse can position a few frames BEFORE its
            // creature's record is created; crumpling now would re-seed a fresh ragdoll (a second fall on
            // an already-dead body). Wait a handful of frames for a record to appear before giving up.
            if (e.MatchRetries < MatchRetryMax) {
                e.MatchRetries++;
                e.Pending = true;          // stay pending; ResolvePending retries the match next frame
                e.LastTouchTick = now;     // keep the despawn sweep from reaping a still-waiting entry
                return false;
            }

            // Still nothing after the grace: a genuinely fresh creature death whose position was late.
            // Crumple from the (now valid) live pose - Seed() runs below and creates its own record.
            e.Seeded = false; e.IsCorpse = false; e.ActiveLeft = RagdollSim.FallFrames;
            AsyncLog.Post(ArmLine(e.ObjId, setupDid, numParts, objcell, px, py) +
                          " posValid=True deferred=True class=CREATURE-crumple");
            return true;
        }

        /// <summary>Give up on a deferred entry that never positioned.</summary>
        private void GiveUpPending(Entry e, uint setupDid, uint numParts, string why) {
            AsyncLog.Post(
                "ragdoll ARM id=0x" + e.ObjId.ToString("X8") +
                " setupDid=0x" + setupDid.ToString("X8") +
                " nparts=" + numParts.ToString() +
                " posValid=False class=SKIP-nopos (gave up: " + why +
                " after " + e.PendingFrames.ToString() + " frames)");
            Remove(e.ObjId);
        }

        // ------------------------------------------------------------------ seed

        private bool Seed(Entry e, CPartArray* pa, Frame* objFrame) {
            CSetup* setup = (CSetup*)pa->setup;
            if (setup == null) return false;
            int n = (int)pa->num_parts;
            if (n < 2 || setup->num_parts != pa->num_parts) return false;
            CPhysicsPart** parts = pa->parts;
            if (parts == null) return false;

            // object world frame (the frame param) + part-array scale
            Quat oq = QMath.Norm(new Quat(objFrame->qw, objFrame->qx, objFrame->qy, objFrame->qz));
            float oox = objFrame->m_fOrigin.BaseClass_Vector3.x;
            float ooy = objFrame->m_fOrigin.BaseClass_Vector3.y;
            float ooz = objFrame->m_fOrigin.BaseClass_Vector3.z;
            float sx = pa->scale.BaseClass_Vector3.x, sy = pa->scale.BaseClass_Vector3.y, sz = pa->scale.BaseClass_Vector3.z;
            float isx = Math.Abs(sx) > 1e-6f ? 1f / sx : 1f;
            float isy = Math.Abs(sy) > 1e-6f ? 1f / sy : 1f;
            float isz = Math.Abs(sz) > 1e-6f ? 1f / sz : 1f;

            // PACING (2026-08-23): the only way out of the loop below is a null part ("pose not ready
            // — retry next frame"), and Seed is retried for up to SeedAttemptsMax frames. Allocating
            // three arrays first meant every retry frame produced garbage for the GC to collect
            // during a death. Pre-scan for readiness with pointer reads; then allocate once, for the
            // attempt that will actually succeed. (These arrays are handed to the sim, so unlike the
            // metrics scratch they cannot be reused.)
            for (int i = 0; i < n; i++) if (parts[i] == null) return false;

            var parent = new uint[n];
            var startPos = new float[n * 3];
            var startQuats = new Quat[n];
            uint* pindex = setup->parent_index;
            float floorZ = float.MaxValue;

            for (int i = 0; i < n; i++) {
                CPhysicsPart* part = parts[i];
                if (part == null) return false;   // pose not ready - retry next frame

                parent[i] = pindex != null ? pindex[i] : 0xFFFFFFFF;

                // part world pose -> model space (inverse of the client's scaled combine)
                float wqw = part->pos.frame.qw, wqx = part->pos.frame.qx, wqy = part->pos.frame.qy, wqz = part->pos.frame.qz;
                float wx = part->pos.frame.m_fOrigin.BaseClass_Vector3.x;
                float wy = part->pos.frame.m_fOrigin.BaseClass_Vector3.y;
                float wz = part->pos.frame.m_fOrigin.BaseClass_Vector3.z;

                QMath.RotateInverse(oq, wx - oox, wy - ooy, wz - ooz, out float lx, out float ly, out float lz);
                float mx = lx * isx, my = ly * isy, mz = lz * isz;
                startPos[i * 3] = mx; startPos[i * 3 + 1] = my; startPos[i * 3 + 2] = mz;
                if (mz < floorZ) floorZ = mz;

                startQuats[i] = QMath.Norm(QMath.Mul(QMath.Conjugate(oq), new Quat(wqw, wqx, wqy, wqz)));
            }

            uint seed = e.ObjId != 0 ? e.ObjId : 0x9E3779B9u;
            float direction = (float)(2.0 * Math.PI * Frac(seed * 0.6180339887));

            // PER-BODY TUNING. This creature body's profile (keyed by the Setup DataID) decides how it
            // falls; a body with no profile gets RagdollParams.Default, whose values are exactly the
            // constants the sim shipped with, so its death is unchanged. The table is a plain
            // Dictionary loaded at plugin init on the managed thread - this lookup allocates nothing
            // and loads nothing, which is what makes it legal on the native detour thread.
            RagdollParams prm = RagdollProfiles.For(SetupDidOf(setup));

            // PER-DEATH VARIETY. Sample the PCA "death manifold" (low-discrepancy) so each death of this
            // body differs coherently and in-character, and take a per-death topple azimuth for the
            // killing blow. No-op (returns the profile, leaves direction) when cfg deathvariety=0, so the
            // default death is unchanged. The varied prm+direction flow into BOTH the sim below and the
            // handoff record, so the corpse replays this exact sampled death.
            // ORIENTATION COMMIT. The third output is how hard this death fights the body's own
            // center-of-mass bias so it actually falls along the sampled heading instead of face-planting
            // (a front-heavy body's gravity torque otherwise out-rotates the seeded topple whatever
            // azimuth it drew). It is a seeding-time ANGULAR VELOCITY correction inside the sim, so the
            // body still starts standing and topples over ~0.5-1 s — unlike the rejected pre-lean, which
            // moved the POSE and snapped it flat. 0 when deathvariety is off => the sim skips the block
            // and the death is bit-identical.
            prm = DeathVariety.Perturb(prm, e.ObjId, ref direction, out float orientCommit);

            e.Sim = new RagdollSim(parent, startPos, startQuats, seed, direction, floorZ, prm, orientCommit);
            e.Scratch = new Quat[n];
            e.Parts = pa;
            e.Seeded = true;
            // The profile owns the active-fall length. Seed runs on the FIRST UpdateParts frame of an
            // entry and nothing decrements ActiveLeft before it (OnUpdateParts returns early while
            // !Seeded), so overwriting the arm-time RagdollSim.FallFrames placeholder here loses no
            // frames and is the single spot that needs to know the profile. Corpse entries never reach
            // Seed - they carry ActiveLeftRemaining from the record instead.
            e.ActiveLeft = prm.FallFrames;

            // Create this creature's handoff record now that we have the construction inputs. It will be
            // refreshed every frame (UpdateRecord) with the evolving verlet state.
            if (!e.IsCorpse) e.Rec = CreateRecord(e, pa, setup, parent, startPos, startQuats, seed, direction, floorZ, prm, orientCommit);

            return true;
        }

        // ------------------------------------------------------------------ handoff record management

        private HandoffRecord CreateRecord(Entry e, CPartArray* pa, CSetup* setup,
                                           uint[] parent, float[] startPos, Quat[] startQuats,
                                           uint seed, float direction, float floorZ, RagdollParams prm,
                                           float orientCommit) {
            int n = parent.Length;
            var rec = new HandoffRecord {
                NumParts = (uint)n,
                ParentHash = HashParents(setup, (uint)n),
                SetupDid = SetupDidOf(setup),
                Parent = parent,          // immutable after construction - safe to share
                StartPos0 = startPos,     // immutable
                StartQuats0 = startQuats, // immutable
                Seed = seed,
                Direction = direction,
                FloorZ = floorZ,
                OrientCommit = orientCommit,   // same reason as Direction: the corpse must re-seed identically
                Params = prm,             // value data - the corpse rebuilds with the SAME tuning
                Pos = new float[n * 3],
                Prev = new float[n * 3],
                ActiveLeftRemaining = e.ActiveLeft,
                UpdatedTick = Environment.TickCount64,
            };
            CPhysicsObj* owner = pa->owner;
            if (owner != null) {
                ReadPos(owner, out uint cell, out float x, out float y, out float _);
                if (PosValid(cell, x, y)) { rec.Objcell = cell; rec.X = x; rec.Y = y; }
            }
            _records.Add(rec);
            return rec;
        }

        /// <summary>Refresh a creature's record with the pose it currently holds.</summary>
        private void UpdateRecord(Entry e, CPhysicsObj* owner, long now) {
            HandoffRecord rec = e.Rec!;
            if (e.Sim == null) return;
            e.Sim.ExportState(rec.Pos, rec.Prev, out rec.T);
            rec.ActiveLeftRemaining = e.ActiveLeft;
            // carry the in-progress world fall so the corpse continues it (GroundZ intentionally not
            // carried - the corpse recomputes terrain for its own XY/slope).
            rec.Airborne = e.Airborne;
            rec.FallDecided = e.FallDecided;
            rec.Landed = e.Landed;
            rec.FallOffset = e.FallOffset;
            rec.FallVel = e.FallVel;
            // ...and the frozen composition orientation, so the corpse continues in the same rotational
            // frame the restored verlet state was evolved in (UpdateRecord runs AFTER WriteParts, so by
            // the first refresh the basis is always frozen).
            rec.BasisQ = e.BasisQ;
            rec.BasisValid = e.BasisFrozen;
            ReadPos(owner, out uint cell, out float x, out float y, out float _);
            if (PosValid(cell, x, y)) { rec.Objcell = cell; rec.X = x; rec.Y = y; }   // keep last-good on a transient zero
            rec.UpdatedTick = now;
        }

        /// <summary>Find a record this arming object continues, or null. Also drops expired records.</summary>
        private HandoffRecord? TryMatchRecord(uint numParts, uint parentHash, uint objcell, float x, float y, long now,
                                              out float bestDist, out long bestAge) {
            bestDist = float.MaxValue; bestAge = 0;
            HandoffRecord? best = null;
            for (int i = _records.Count - 1; i >= 0; i--) {
                HandoffRecord r = _records[i];
                long age = now - r.UpdatedTick;
                if (age > HandoffRecordTtl) { _records.RemoveAt(i); continue; }
                if (age > HandoffWindowMillis) continue;
                if (r.NumParts != numParts) continue;
                // FINDING 3 (skeleton-signature match): the handoff record exists to key on the skeleton,
                // but the match previously filtered only on part count + cell + distance + age - never
                // the signature it was built to carry. Two creatures with the same part count dying a few
                // yards apart inside the window would cross records: the second snaps into the first's
                // evolved verlet pose (wrong bones -> contorted limbs) and the first re-crumples with no
                // record (the double-crumple the handoff exists to prevent). Require the ParentIndex-graph
                // hash to agree so only the SAME skeleton continues a record.
                if (r.ParentHash != parentHash) continue;
                if (RequireSameCell) { if (r.Objcell != objcell) continue; }
                else if ((r.Objcell & 0xFFFF0000u) != (objcell & 0xFFFF0000u)) continue;   // same landblock
                float dx = r.X - x, dy = r.Y - y;
                float dist = (float)Math.Sqrt(dx * dx + dy * dy);
                if (dist > HandoffMaxDistXY) continue;
                if (dist < bestDist) { bestDist = dist; bestAge = age; best = r; }
            }
            return best;
        }

        // ------------------------------------------------------------------ write

        private void WriteParts(Entry e, CPhysicsObj* owner, CPartArray* pa, Frame* objFrame) {
            RagdollSim sim = e.Sim!;
            Quat[] q = e.Scratch!;
            sim.DeriveQuats(q);

            int n = (int)pa->num_parts;
            if (n > sim.PartCount) n = sim.PartCount;
            CPhysicsPart** parts = pa->parts;
            if (parts == null) return;

            // SINGLE-WRITER, ROOT LEVEL. Compose against the FROZEN basis, not the live object frame:
            // the canned Dead animation is still running underneath (we deliberately still call the
            // original DoInterpretedMotion) and its root motion would otherwise translate and rotate the
            // whole ragdoll every frame. See ResolveBasis.
            ResolveBasis(e, owner, objFrame, out Quat oq, out float oox, out float ooy, out float ooz);
            float sx = pa->scale.BaseClass_Vector3.x, sy = pa->scale.BaseClass_Vector3.y, sz = pa->scale.BaseClass_Vector3.z;

            // Airborne-death world fall. Returns 0 for a grounded death (output unchanged); for an
            // airborne death it is the growing/settled vertical drop subtracted from every part's world
            // Z so the whole body descends to the terrain. Guarded so a fault in the client terrain call
            // can never escape the native detour (the outer detour also try/catches).
            float fall;
            try { fall = ResolveWorldFall(e, owner, sim, n, parts, oq, ooz, sx, sy, sz); }
            // PACING: this is inside WriteParts, i.e. per ragdoll per frame. An exception that
            // repeats (a bad terrain call on one body) used to mean a synchronous file write EVERY
            // FRAME — a permanent frame-time floor. Throttled to one line per second.
            catch (Exception ex) { LogWorldFallFailed(ex, e.ObjId); fall = e.FallOffset; }

            // ANTI-SINK CLAMP. The verlet sim settles parts onto its own model-space floor, but the
            // scaled world transform + odd rest poses can drop the lowest part BELOW the real surface
            // the body rests on, so corpses visibly sink into the ground (worst on golems/skeletons
            // whose "assembled" rest pose sits low). Guarantee the lowest part's world origin stays a
            // hair ABOVE the floor: pre-scan every part's world Z (with the airborne fall applied),
            // and if the minimum dips below floorZ + FloorMargin, lift the WHOLE body uniformly by the
            // deficit (rigid lift - preserves the settled pose, just raises it). floorZ is the terrain
            // under the corpse when known (outdoor / after an airborne landing), else the object's own
            // ground position ooz (indoor EnvCell floor - the creature died standing on it). This runs
            // every frame so a still-settling body never pops below the floor mid-fall either.
            float floorZ = e.GroundZValid ? e.GroundZ : ooz;
            float minWz = float.MaxValue;
            for (int i = 0; i < n; i++) {
                CPhysicsPart* p2 = parts[i];
                if (p2 == null) continue;
                sim.GetPos(i, out float mx2, out float my2, out float mz2);
                QMath.Rotate(oq, sx * mx2, sy * my2, sz * mz2, out float _, out float _, out float rz2);
                float wz2 = ooz + rz2 - fall;
                if (wz2 < minWz) minWz = wz2;
            }
            float lift = (minWz != float.MaxValue && minWz < floorZ + FloorMargin)
                ? (floorZ + FloorMargin - minWz) : 0f;

            for (int i = 0; i < n; i++) {
                CPhysicsPart* part = parts[i];
                if (part == null) continue;   // never cache/deref a missing part

                sim.GetPos(i, out float mx, out float my, out float mz);
                // world = objOrigin + Rotate(objQuat, scale (x) modelOrigin)   [client scaled combine],
                // then translated straight down by the world-space fall offset (0 for grounded deaths),
                // then lifted by the anti-sink clamp so nothing rests below the floor.
                QMath.Rotate(oq, sx * mx, sy * my, sz * mz, out float rx, out float ry, out float rz);
                float wx = oox + rx, wy = ooy + ry, wz = ooz + rz - fall + lift;
                Quat wq = QMath.Norm(QMath.Mul(oq, q[i]));

                part->pos.frame.qw = wq.W;
                part->pos.frame.qx = wq.X;
                part->pos.frame.qy = wq.Y;
                part->pos.frame.qz = wq.Z;
                part->pos.frame.m_fOrigin.BaseClass_Vector3.x = wx;
                part->pos.frame.m_fOrigin.BaseClass_Vector3.y = wy;
                part->pos.frame.m_fOrigin.BaseClass_Vector3.z = wz;

                // The DRAW path reads the cached 3x3 matrix m_fl2gv, not the quaternion, so recompute
                // it from the quaternion we just wrote (Frame::cache, acclient.c UpdateObjectInternal
                // discipline). Client leaf thiscall via ACBindings.
                part->pos.frame.cache();
            }
        }

        // ------------------------------------------------------------------ frozen composition basis

        /// <summary>
        /// The object frame this entry composes its model-space sim pose onto, FROZEN at the entry's
        /// first write and held for the rest of its life.
        ///
        /// WHY. <c>UpdateParts</c> is handed <c>&amp;CPhysicsObj::m_position.frame</c> (verified:
        /// CPhysicsObj::UpdatePartsInternal -&gt; CPartArray::SetFrame(&amp;this-&gt;m_position.frame)),
        /// and the client's canned Dead animation keeps driving that frame for the whole death sequence
        /// - a per-animation root drop, some ground travel and a rotation sweep, all measurably nonzero.
        /// Re-reading it every frame meant the ragdoll was written in a basis a SECOND animation was
        /// moving: the body slid and turned under its own settled pose, and a corpse got the same
        /// treatment from its own Dead motion arm. Freezing the basis makes the death-hit ragdoll the
        /// only thing that moves the body, which is the whole point of this pass.
        ///
        /// THE CELL CAVEAT. <c>m_position.frame</c> origins are LANDBLOCK-local: the retail
        /// <c>LandDefs::get_block_offset</c> returns the zero vector whenever two cell ids share their
        /// high 16 bits, and 24 yd per cell step * 8 cells = 192 yd per landblock step otherwise. So a
        /// cell change WITHIN the landblock needs nothing at all, and a landblock change - which root
        /// motion can only cause for a body that died within a yard or two of the boundary - is rebased
        /// by that same 192 yd/step so the frozen origin keeps meaning the same world point. Z is
        /// absolute in both bases, which is also why the world-fall/anti-sink comparisons against
        /// terrain Z stay valid.
        /// </summary>
        private void ResolveBasis(Entry e, CPhysicsObj* owner, Frame* objFrame,
                                  out Quat oq, out float oox, out float ooy, out float ooz) {
            uint cell = owner != null ? owner->m_position.objcell_id : 0u;

            if (!e.BasisFrozen) {
                // Creature: this is the frame Seed() just built the model-space pose from, i.e. the
                // death-hit pose. Corpse handoff: its first frame, but with the CREATURE's orientation
                // when the record carried one (the restored verlet state lives in that rotational
                // frame), so the pile does not visibly re-orient at handoff.
                e.BasisQ = e.BasisQInherited
                    ? QMath.Norm(e.BasisQ)
                    : QMath.Norm(new Quat(objFrame->qw, objFrame->qx, objFrame->qy, objFrame->qz));
                e.BasisX = objFrame->m_fOrigin.BaseClass_Vector3.x;
                e.BasisY = objFrame->m_fOrigin.BaseClass_Vector3.y;
                e.BasisZ = objFrame->m_fOrigin.BaseClass_Vector3.z;
                e.BasisCell = cell;
                e.BasisFrozen = true;
            }
            else if (cell != 0 && cell != e.BasisCell) {
                if ((cell >> 16) != (e.BasisCell >> 16) && e.BasisCell != 0) {
                    BlockOffset(cell, e.BasisCell, out float dx, out float dy);
                    e.BasisX += dx;
                    e.BasisY += dy;
                    if (!e.BasisRebasedLogged) {
                        e.BasisRebasedLogged = true;
                        AsyncLog.Post(
                            "ragdoll BASIS id=0x" + e.ObjId.ToString("X8") +
                            " rebased cell 0x" + e.BasisCell.ToString("X8") +
                            " -> 0x" + cell.ToString("X8") +
                            " d=(" + dx.ToString("F1") + "," + dy.ToString("F1") + ")yd");
                    }
                }
                e.BasisCell = cell;
            }

            oq = e.BasisQ;
            oox = e.BasisX;
            ooy = e.BasisY;
            ooz = e.BasisZ;
        }

        /// <summary>
        /// Retail <c>LandDefs::get_block_offset</c> (acclient.c), XY only - the vector that expresses a
        /// point recorded in <paramref name="cellTo"/>'s basis in <paramref name="cellFrom"/>'s basis.
        /// Zero within one landblock; otherwise 192 yd (8 cells * 24 yd) per landblock step, X from
        /// bits 24-31 of the cell id and Y from bits 16-23. Z is never offset.
        /// </summary>
        private static void BlockOffset(uint cellFrom, uint cellTo, out float dx, out float dy) {
            dx = 0f; dy = 0f;
            if (cellFrom == 0 || cellTo == 0) return;
            if ((cellFrom >> 16) == (cellTo >> 16)) return;
            int fx = (int)((cellFrom >> 24) & 0xFFu), fy = (int)((cellFrom >> 16) & 0xFFu);
            int tx = (int)((cellTo >> 24) & 0xFFu), ty = (int)((cellTo >> 16) & 0xFFu);
            dx = (tx - fx) * 192f;
            dy = (ty - fy) * 192f;
        }

        // ------------------------------------------------------------------ world-space fall (airborne)

        /// <summary>
        /// Compute the world-space vertical drop to apply to every part this frame. The verlet sim
        /// settles the body onto its own MODEL-space floor, which world-transforms to the death height;
        /// for a creature that died in the air that floats. We detect that (the body's lowest part sits
        /// meaningfully above the real terrain under its XY) and grow a downward offset under gravity,
        /// clamped so the lowest part rests exactly on the terrain, then hold. Returns 0 for a grounded
        /// death, so its output is byte-for-byte the prior behaviour.
        /// </summary>
        private float ResolveWorldFall(Entry e, CPhysicsObj* owner, RagdollSim sim, int n,
                                       CPhysicsPart** parts, Quat oq,
                                       float ooz, float sx, float sy, float sz) {
            // Already classified as a grounded death: no world fall, output unchanged.
            if (e.FallDecided && !e.Airborne) return 0f;

            // Terrain height under the corpse XY. The dead object does not move in XY, so resolve once
            // from the client and cache it (a corpse-handoff arrives with GroundZValid=false and
            // recomputes for its own XY/slope).
            if (!e.GroundZValid && TryGetTerrainZ(owner, out float gz)) { e.GroundZ = gz; e.GroundZValid = true; }

            // A fresh (undecided) entry cannot classify until the ground is known: apply no fall and try
            // again next frame.
            if (!e.FallDecided && !e.GroundZValid) return 0f;

            // Lowest part world Z this frame (pre-offset).
            float lowWorldZ = float.MaxValue;
            for (int i = 0; i < n; i++) {
                CPhysicsPart* part = parts[i];
                if (part == null) continue;
                sim.GetPos(i, out float mx, out float my, out float mz);
                QMath.Rotate(oq, sx * mx, sy * my, sz * mz, out float _, out float _, out float rz);
                float wz = ooz + rz;
                if (wz < lowWorldZ) lowWorldZ = wz;
            }
            if (lowWorldZ == float.MaxValue) return e.FallOffset;   // no readable parts this frame

            // First-time airborne classification (runs once, on the first frame the ground is known).
            if (!e.FallDecided) {
                float gap0 = lowWorldZ - e.GroundZ;
                e.Airborne = gap0 > AirborneEps;
                e.FallDecided = true;
                if (e.Airborne)
                    AsyncLog.Post(
                        "ragdoll FALL id=0x" + e.ObjId.ToString("X8") +
                        " class=AIRBORNE restZ=" + lowWorldZ.ToString("F2") +
                        " terrainZ=" + e.GroundZ.ToString("F2") +
                        " drop~=" + gap0.ToString("F2") +
                        " src=find_terrain_poly corpse=" + e.IsCorpse.ToString());
                if (!e.Airborne) return 0f;
            }
            if (!e.Airborne) return 0f;

            // Airborne (decided this frame, or carried in from the creature record). We need the terrain
            // to fall onto; if a corpse-handoff hasn't resolved it yet, hold the carried offset (no snap).
            if (!e.GroundZValid) return e.FallOffset;

            if (!e.Landed) {
                e.FallVel += WorldGravity * WorldDt;
                if (e.FallVel > MaxFallSpeed) e.FallVel = MaxFallSpeed;
                e.FallOffset += e.FallVel * WorldDt;

                // Offset that puts the current lowest part exactly on the (possibly sloped) terrain.
                float target = lowWorldZ - e.GroundZ;
                if (target < 0f) target = 0f;
                if (e.FallOffset >= target) {
                    e.FallOffset = target;
                    e.FallVel = 0f;
                    e.Landed = true;
                    AsyncLog.Post(
                        "ragdoll FALL id=0x" + e.ObjId.ToString("X8") +
                        " class=LANDED terrainZ=" + e.GroundZ.ToString("F2") +
                        " drop=" + e.FallOffset.ToString("F2") +
                        " corpse=" + e.IsCorpse.ToString());
                }
            }
            return e.FallOffset;
        }

        /// <summary>
        /// Real terrain height under the object's XY, via the client's own walkable-poly finder
        /// (CLandCell::find_terrain_poly, acclient.c CLandBlock::adjust_scene_obj_height pattern):
        /// find the terrain triangle containing the point, then solve its plane for Z. Result is in the
        /// object's m_position frame basis - the same basis the part world Z is written in. Outdoor land
        /// cells only (indoor/dungeon cells have no terrain plane); returns false otherwise.
        /// </summary>
        private static bool TryGetTerrainZ(CPhysicsObj* owner, out float z) {
            z = 0f;
            if (owner == null) return false;
            CObjCell* cell = owner->cell;
            if (cell == null) return false;
            uint objcell = owner->m_position.objcell_id;
            // Outdoor terrain cells have a low-16 cell index < 0x100; >= 0x100 is an interior EnvCell
            // (dungeon/building) whose CObjCell is NOT a CLandCell - never call find_terrain_poly there.
            if (objcell == 0 || (objcell & 0xFFFFu) >= 0x100u) return false;

            // Copy the origin (find_terrain_poly takes it by const ref - it only reads x,y in 2D).
            ACBindings.Internal.AC1Legacy.Vector3 v = owner->m_position.frame.m_fOrigin;
            CLandCell* lc = (CLandCell*)cell;   // pointer-identical: CLandCell : CSortCell : CObjCell
            ACBindings.Internal.CPolygon* walkable = null;
            int hit = lc->find_terrain_poly(&v, &walkable);
            if (hit == 0 || walkable == null) return false;

            float nx = walkable->plane.N.BaseClass_Vector3.x;
            float ny = walkable->plane.N.BaseClass_Vector3.y;
            float nz = walkable->plane.N.BaseClass_Vector3.z;
            if (Math.Abs(nz) < 2e-4f) return false;   // near-vertical face: no usable Z (matches client)
            float ox = v.BaseClass_Vector3.x, oy = v.BaseClass_Vector3.y;
            z = -((oy * ny + ox * nx + walkable->plane.d) / nz);
            return true;
        }

        // ------------------------------------------------------------------ lifetime

        private void ArmUpdateParts(bool enabled) {
            try { _setUpdatePartsHook(enabled); }
            catch (Exception ex) { _log.LogError(ex, "ragdoll: failed to {S} UpdateParts hook", enabled ? "arm" : "disarm"); }
        }

        private void Remove(uint id) {
            if (!_live.Remove(id)) return;
            OwnRelease(id);   // the body stops being death-owned the instant we stop writing it
            if (_live.Count == 0) ArmUpdateParts(false);
        }

        /// <summary>Rate limiter for the sweep driven off the (very frequent) non-Dead MotionDone
        /// path. Static because the plugin owns exactly one registry per client process; the value is
        /// only ever read/written on the client's single simulation thread.</summary>
        private static long _lastSweepTick;
        private const long SweepThrottleMillis = 5_000;

        /// <summary>Allocation-free early-outs first (nothing to sweep / swept recently), then the
        /// real sweep. Safe to call from the hot non-Dead motion path.</summary>
        private void MaybeSweepStale() {
            if (_live.Count == 0 && _records.Count == 0) return;
            long now = Environment.TickCount64;
            if (now - _lastSweepTick < SweepThrottleMillis) return;
            _lastSweepTick = now;
            SweepStale();
        }

        /// <summary>Drop entries whose corpse has despawned (no UpdateParts touch for a while), and
        /// expire stale handoff records.</summary>
        private void SweepStale() {
            long now = Environment.TickCount64;
            List<uint>? dead = null;
            foreach (var kv in _live) {
                Entry e = kv.Value;
                long since = now - (e.Seeded ? e.LastTouchTick : e.ArmedTick);
                if (since > DespawnMillis) (dead ??= new List<uint>()).Add(kv.Key);
            }
            if (dead != null) foreach (uint id in dead) Remove(id);

            for (int i = _records.Count - 1; i >= 0; i--) {
                if (now - _records[i].UpdatedTick > HandoffRecordTtl) _records.RemoveAt(i);
            }
        }

        /// <summary>Called from the plugin on unload, AFTER the detours have been disabled.</summary>
        public void Shutdown() {
            _down = true;
            _live.Clear();
            _records.Clear();
            Array.Clear(_ownedIds, 0, _ownedIds.Length);
            _ownedCount = 0;
        }

        // ------------------------------------------------------------------ helpers

        /// <summary>MotionCommand.Dead (Chorizite.Common/Enums/MotionCommand.cs:24).</summary>
        private const uint DeadMotion = 0x40000011;

        // ------------------------------------------------------------------ revive classification
        //
        // The eviction trigger for FINDING 1 (see OnMotionDone). LOCOMOTION-class only - the one class
        // a dead body can never produce and a body that is alive again produces within a step or two.
        // The ranges are the low 16 bits of MotionCommand (the high byte is the command class), and are
        // the same set LiveMotionRegistry.LocomotionRanges carries, deliberately DUPLICATED rather than
        // shared: LiveMotionRegistry is never even class-constructed when RagdollSettings.liveMotion is
        // false, and touching it from here would both break that bit-identity guarantee and risk running
        // its class constructor on the native detour thread (the 0x80131509 rule).
        //   0x0001..0x0002  HoldRun / HoldSidestep;
        //   0x0005..0x0007  WalkForward / WalkBackwards / RunForward;
        //   0x000A          Hover;
        //   0x000D..0x0010  TurnRight / TurnLeft / SideStepRight / SideStepLeft.
        private static readonly ushort[] ReviveRanges = {
            0x0001, 0x0002,
            0x0005, 0x0007,
            0x000A, 0x000A,
            0x000D, 0x0010,
        };

        /// <summary>Dense O(1) form of <see cref="ReviveRanges"/>, built by the class constructor (which
        /// the plugin warmup runs on the managed thread, never in a detour).</summary>
        private static readonly bool[] ReviveLow16 = BuildReviveTable();

        private static bool[] BuildReviveTable() {
            int max = 0;
            for (int i = 1; i < ReviveRanges.Length; i += 2) if (ReviveRanges[i] > max) max = ReviveRanges[i];
            var t = new bool[max + 1];
            for (int i = 0; i + 1 < ReviveRanges.Length; i += 2)
                for (int v = ReviveRanges[i]; v <= ReviveRanges[i + 1]; v++) t[v] = true;
            return t;
        }

        private static bool IsReviveMotion(uint motion) {
            uint low = motion & 0xFFFFu;
            return low < (uint)ReviveLow16.Length && ReviveLow16[low];
        }

        /// <summary>A tracked entry is immune to the revive eviction for at least this long after it
        /// armed. The primary guard is <c>ActiveLeft &lt;= 0</c> (the fall is literally still running);
        /// this is the wall-clock backstop for it, set past the longest authored fall - 130 FallFrames
        /// in ragdoll_profiles.json = 4.3 s at 30 fps - plus the corpse handoff. A body that is
        /// genuinely alive again has been dead far longer than this.</summary>
        private const long ReviveGraceMillis = 6_000;

        private static uint ObjIdOf(CPhysicsObj* obj) =>
            obj->BaseClass_LongHashData.BaseClass_HashBaseData.id;

        /// <summary>The setup's DAT DataID (diagnostic + skeleton identity). Reads the DBObj id the
        /// CSetup inherits through SerializeUsingPackDBObj -> DBObj.m_DID.</summary>
        private static uint SetupDidOf(CSetup* setup) {
            if (setup == null) return 0;
            return setup->BaseClass_SerializeUsingPackDBObj.BaseClass_DBObj.m_DID.BaseClass_uint;
        }

        /// <summary>Cheap order-sensitive hash of the Setup's ParentIndex graph - the skeleton signature
        /// used (together with num_parts) to tell whether a corpse shares the creature's skeleton.</summary>
        private static uint HashParents(CSetup* setup, uint n) {
            uint h = 2166136261u;   // FNV-1a
            if (setup == null) return h;
            uint* p = setup->parent_index;
            if (p == null) return h;
            // FINDING 2 (native OOB read): parent_index is allocated for setup->num_parts, but callers
            // pass pa->num_parts, which can be LARGER on a partially-built / mid-morph part array (Seed
            // itself guards on exactly this mismatch: 'pose not ready - retry'). Walking to the caller's
            // n would read past the native allocation -> garbage hash or an uncatchable AccessViolation
            // inside the MotionDone detour. Clamp to the array we are actually indexing (both cited call
            // sites, OnMotionDone and ResolvePending, are covered here).
            uint sn = setup->num_parts;
            if (n > sn) n = sn;
            for (uint i = 0; i < n; i++) {
                uint v = p[i];
                h = (h ^ (v & 0xFF)) * 16777619u;
                h = (h ^ ((v >> 8) & 0xFF)) * 16777619u;
                h = (h ^ ((v >> 16) & 0xFF)) * 16777619u;
                h = (h ^ ((v >> 24) & 0xFF)) * 16777619u;
            }
            return h;
        }

        /// <summary>Read the object's world placement (cell id, XY, heading-qw) from m_position - the
        /// single basis used for correlating a creature record with the corpse that replaces it.</summary>
        private static void ReadPos(CPhysicsObj* obj, out uint objcell, out float x, out float y, out float heading) {
            objcell = obj->m_position.objcell_id;
            x = obj->m_position.frame.m_fOrigin.BaseClass_Vector3.x;
            y = obj->m_position.frame.m_fOrigin.BaseClass_Vector3.y;
            heading = obj->m_position.frame.qw;
        }

        /// <summary>PACING (2026-08-23): every ARM/handoff/RELEASE line fires on the render thread on
        /// the frame a body dies — several per death, and a synchronous ILogger call is a
        /// Console.Write plus a full file open/append/close each. They all go through the async sink
        /// now (same text, same log.txt); <see cref="ArmLine"/> builds the shared prefix once.</summary>
        /// <summary>One line per second at most, for the one error path that can repeat every frame
        /// (see the ResolveWorldFall guard). -1_000_000 rather than long.MinValue: `now - MinValue`
        /// overflows negative and would suppress every line forever.</summary>
        private long _lastWorldFallErr = -1_000_000;
        private void LogWorldFallFailed(Exception ex, uint id) {
            long now = Environment.TickCount64;
            if (now - _lastWorldFallErr < 1000) return;
            _lastWorldFallErr = now;
            try { _log.LogError(ex, "ragdoll: world-fall failed id=0x{Id:X8}", id); } catch { }
        }

        private static string ArmLine(uint id, uint setupDid, uint numParts, uint objcell, float x, float y) =>
            "ragdoll ARM id=0x" + id.ToString("X8") +
            " setupDid=0x" + setupDid.ToString("X8") +
            " nparts=" + numParts.ToString() +
            " cell=0x" + objcell.ToString("X8") +
            " xy=(" + x.ToString("F1") + "," + y.ToString("F1") + ")";

        private void LogArm(string cls, uint id, uint setupDid, uint numParts, uint objcell, float x, float y) {
            AsyncLog.Post(ArmLine(id, setupDid, numParts, objcell, x, y) +
                          " posValid=True class=" + cls);
        }

        /// <summary>True once the object's world placement is set: a non-zero cell and a non-origin XY.
        /// Objects arm the Dead motion before m_position is populated (cell 0, origin 0); those are not
        /// yet correlatable and must not arm.</summary>
        private static bool PosValid(uint objcell, float x, float y) =>
            objcell != 0 && (Math.Abs(x) > PosEps || Math.Abs(y) > PosEps);

        private static double Frac(double x) => x - Math.Floor(x);
    }
}
