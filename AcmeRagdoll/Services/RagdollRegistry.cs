using System;
using System.Collections.Generic;
using ACBindings.Internal;
using AcmeRagdoll.Sim;
using Microsoft.Extensions.Logging;

namespace AcmeRagdoll.Services {
    /// <summary>
    /// Owns the set of currently-ragdolling creatures and does the per-frame work: seed a sim from
    /// the live model-space pose the first frame after death, then each subsequent frame step the sim
    /// (or hold the settled pose) and overwrite each owned part's world Frame.
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

        private readonly Dictionary<uint, Entry> _live = new(MaxLive);
        private readonly List<HandoffRecord> _records = new(8);
        private readonly Action<bool> _setUpdatePartsHook;
        private readonly ILogger _log;
        private volatile bool _down;

        /// <param name="setUpdatePartsHook">Enables (true) / disables (false) the UpdateParts detour.
        /// Called only when the live count crosses 0 so the hot-path detour is armed only while at
        /// least one ragdoll is active.</param>
        /// <param name="log">Plugin logger.</param>
        public RagdollRegistry(Action<bool> setUpdatePartsHook, ILogger log) {
            _setUpdatePartsHook = setUpdatePartsHook;
            _log = log;
        }

        public int LiveCount => _live.Count;

        /// <summary>Death signal. Arms a ragdoll for an object whose Dead motion just began/finished.
        /// Classifies the object as either a fresh CREATURE crumple or the CORPSE continuation of a
        /// recently-recorded creature ragdoll.</summary>
        public void OnMotionDone(CPhysicsObj* obj, uint motion) {
            if (_down || obj == null) return;
            if (motion != DeadMotion) {
                // FINDING 1 (event-driven disarm): a ragdoll is armed only on DeadMotion but was never
                // disarmed when the SAME object later leaves the dead state. A player who dies then
                // releases to the lifestone is the same CPhysicsObj/CPartArray, so its entry still
                // matches and WriteParts keeps overwriting the live, running body with the settled
                // corpse pose until the HoldMillis backstop (up to 15 min). Any non-Dead motion on a
                // tracked owner means it is alive again: drop its entry (and its handoff record) so
                // WriteParts stops. A genuine corpse object never plays a live motion, so this leaves
                // the corpse-handoff behaviour untouched; the cap remains only as a backstop.
                uint liveId = ObjIdOf(obj);
                if (liveId != 0 && _live.TryGetValue(liveId, out Entry? le) && le != null && le.Obj == obj) {
                    if (le.Rec != null) _records.Remove(le.Rec);
                    Remove(liveId);
                }
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
                _live[id] = new Entry {
                    ObjId = id, Obj = obj, Parts = null, Seeded = false, Pending = true, IsCorpse = false,
                    ActiveLeft = 0, ArmedTick = now, LastTouchTick = now,
                };
                _log.LogInformation(
                    "ragdoll ARM id=0x{Id:X8} setupDid=0x{Did:X8} nparts={N} cell=0x{Cell:X8} xy=({X:F1},{Y:F1}) " +
                    "posValid=False class=PENDING-nopos (deferred; will classify when positioned)",
                    id, setupDid, numParts, objcell, px, py);
                if (_live.Count == 1) ArmUpdateParts(true);
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
            _live[id] = new Entry {
                ObjId = id, Obj = obj, Parts = null, Seeded = false, IsCorpse = false,
                ActiveLeft = RagdollSim.FallFrames, ArmedTick = now, LastTouchTick = now,
            };
            LogArm("CREATURE-crumple", id, setupDid, numParts, objcell, px, py);
            if (_live.Count == 1) ArmUpdateParts(true);
        }

        /// <summary>Corpse path: rebuild the creature's sim from the record, fast-forward it to the
        /// recorded instant and let it continue/hold. No re-seed, no second topple.</summary>
        private void ArmCorpseHandoff(uint id, CPhysicsObj* obj, CPartArray* pa, HandoffRecord rec, long now,
                                      uint setupDid, uint numParts, uint objcell, float px, float py,
                                      uint parentHash, float matchDist, long matchAge) {
            RagdollSim sim;
            try {
                sim = new RagdollSim(rec.Parent, rec.StartPos0, rec.StartQuats0,
                                     rec.Seed, rec.Direction, rec.FloorZ);
                sim.RestoreState(rec.Pos, rec.Prev, rec.T);   // copies in - no aliasing with rec buffers
            }
            catch (Exception ex) {
                // If the rebuild fails for any reason, fall back to a normal crumple rather than nothing.
                _log.LogError(ex, "ragdoll: corpse handoff rebuild failed id=0x{Id:X8}; falling back to crumple", id);
                _live[id] = new Entry {
                    ObjId = id, Obj = obj, Parts = null, Seeded = false, IsCorpse = false,
                    ActiveLeft = RagdollSim.FallFrames, ArmedTick = now, LastTouchTick = now,
                };
                if (_live.Count == 1) ArmUpdateParts(true);
                return;
            }

            int n = (int)numParts;
            if (n > sim.PartCount) n = sim.PartCount;
            _live[id] = new Entry {
                ObjId = id, Obj = obj, Parts = pa, Sim = sim, Scratch = new Quat[n],
                Seeded = true, IsCorpse = true,
                ActiveLeft = rec.ActiveLeftRemaining, ArmedTick = now, LastTouchTick = now,
                // inherit the creature's world-fall progress; recompute terrain for the corpse's own XY.
                Airborne = rec.Airborne, FallDecided = rec.FallDecided, Landed = rec.Landed,
                FallOffset = rec.FallOffset, FallVel = rec.FallVel, GroundZValid = false,
            };
            _records.Remove(rec);   // one-shot: consume the record so no later object re-matches it

            bool parentMatch = parentHash == rec.ParentHash;
            _log.LogInformation(
                "ragdoll ARM id=0x{Id:X8} setupDid=0x{Did:X8} nparts={N} cell=0x{Cell:X8} xy=({X:F1},{Y:F1}) " +
                "posValid=True class=CORPSE-handoff matched(creatureSetupDid=0x{CDid:X8} dist={Dist:F2} age={Age}ms " +
                "parentHashMatch={PM} activeLeftRemaining={AL})",
                id, setupDid, numParts, objcell, px, py,
                rec.SetupDid, matchDist, matchAge, parentMatch, rec.ActiveLeftRemaining);

            if (_live.Count == 1) ArmUpdateParts(true);
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
                                         rec.Seed, rec.Direction, rec.FloorZ);
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
                _records.Remove(rec);   // one-shot

                bool parentMatch = parentHash == rec.ParentHash;
                _log.LogInformation(
                    "ragdoll ARM id=0x{Id:X8} setupDid=0x{Did:X8} nparts={N} cell=0x{Cell:X8} xy=({X:F1},{Y:F1}) " +
                    "posValid=True deferred=True class=CORPSE-handoff matched(creatureSetupDid=0x{CDid:X8} dist={Dist:F2} " +
                    "age={Age}ms parentHashMatch={PM} activeLeftRemaining={AL})",
                    e.ObjId, setupDid, numParts, objcell, px, py,
                    rec.SetupDid, matchDist, matchAge, parentMatch, rec.ActiveLeftRemaining);
                return true;
            }

            // No matching record: this is a fresh creature death whose position was simply late. Crumple
            // from the (now valid) live pose - Seed() runs below and creates its own handoff record.
            e.Seeded = false; e.IsCorpse = false; e.ActiveLeft = RagdollSim.FallFrames;
            _log.LogInformation(
                "ragdoll ARM id=0x{Id:X8} setupDid=0x{Did:X8} nparts={N} cell=0x{Cell:X8} xy=({X:F1},{Y:F1}) " +
                "posValid=True deferred=True class=CREATURE-crumple",
                e.ObjId, setupDid, numParts, objcell, px, py);
            return true;
        }

        /// <summary>Give up on a deferred entry that never positioned.</summary>
        private void GiveUpPending(Entry e, uint setupDid, uint numParts, string why) {
            _log.LogInformation(
                "ragdoll ARM id=0x{Id:X8} setupDid=0x{Did:X8} nparts={N} posValid=False class=SKIP-nopos (gave up: {Why} after {F} frames)",
                e.ObjId, setupDid, numParts, why, e.PendingFrames);
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
            e.Sim = new RagdollSim(parent, startPos, startQuats, seed, direction, floorZ);
            e.Scratch = new Quat[n];
            e.Parts = pa;
            e.Seeded = true;

            // Create this creature's handoff record now that we have the construction inputs. It will be
            // refreshed every frame (UpdateRecord) with the evolving verlet state.
            if (!e.IsCorpse) e.Rec = CreateRecord(e, pa, setup, parent, startPos, startQuats, seed, direction, floorZ);

            return true;
        }

        // ------------------------------------------------------------------ handoff record management

        private HandoffRecord CreateRecord(Entry e, CPartArray* pa, CSetup* setup,
                                           uint[] parent, float[] startPos, Quat[] startQuats,
                                           uint seed, float direction, float floorZ) {
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

            Quat oq = QMath.Norm(new Quat(objFrame->qw, objFrame->qx, objFrame->qy, objFrame->qz));
            float oox = objFrame->m_fOrigin.BaseClass_Vector3.x;
            float ooy = objFrame->m_fOrigin.BaseClass_Vector3.y;
            float ooz = objFrame->m_fOrigin.BaseClass_Vector3.z;
            float sx = pa->scale.BaseClass_Vector3.x, sy = pa->scale.BaseClass_Vector3.y, sz = pa->scale.BaseClass_Vector3.z;

            // Airborne-death world fall. Returns 0 for a grounded death (output unchanged); for an
            // airborne death it is the growing/settled vertical drop subtracted from every part's world
            // Z so the whole body descends to the terrain. Guarded so a fault in the client terrain call
            // can never escape the native detour (the outer detour also try/catches).
            float fall;
            try { fall = ResolveWorldFall(e, owner, sim, n, parts, oq, ooz, sx, sy, sz); }
            catch (Exception ex) { _log.LogError(ex, "ragdoll: world-fall failed id=0x{Id:X8}", e.ObjId); fall = e.FallOffset; }

            for (int i = 0; i < n; i++) {
                CPhysicsPart* part = parts[i];
                if (part == null) continue;   // never cache/deref a missing part

                sim.GetPos(i, out float mx, out float my, out float mz);
                // world = objOrigin + Rotate(objQuat, scale (x) modelOrigin)   [client scaled combine],
                // then translated straight down by the world-space fall offset (0 for grounded deaths).
                QMath.Rotate(oq, sx * mx, sy * my, sz * mz, out float rx, out float ry, out float rz);
                float wx = oox + rx, wy = ooy + ry, wz = ooz + rz - fall;
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
                    _log.LogInformation(
                        "ragdoll FALL id=0x{Id:X8} class=AIRBORNE restZ={Rz:F2} terrainZ={Tz:F2} drop~={Gap:F2} src=find_terrain_poly corpse={C}",
                        e.ObjId, lowWorldZ, e.GroundZ, gap0, e.IsCorpse);
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
                    _log.LogInformation(
                        "ragdoll FALL id=0x{Id:X8} class=LANDED terrainZ={Tz:F2} drop={Drop:F2} corpse={C}",
                        e.ObjId, e.GroundZ, e.FallOffset, e.IsCorpse);
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
            if (_live.Remove(id) && _live.Count == 0) ArmUpdateParts(false);
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
        }

        // ------------------------------------------------------------------ helpers

        /// <summary>MotionCommand.Dead (Chorizite.Common/Enums/MotionCommand.cs:24).</summary>
        private const uint DeadMotion = 0x40000011;

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

        private void LogArm(string cls, uint id, uint setupDid, uint numParts, uint objcell, float x, float y) {
            _log.LogInformation(
                "ragdoll ARM id=0x{Id:X8} setupDid=0x{Did:X8} nparts={N} cell=0x{Cell:X8} xy=({X:F1},{Y:F1}) posValid=True class={Cls}",
                id, setupDid, numParts, objcell, x, y, cls);
        }

        /// <summary>True once the object's world placement is set: a non-zero cell and a non-origin XY.
        /// Objects arm the Dead motion before m_position is populated (cell 0, origin 0); those are not
        /// yet correlatable and must not arm.</summary>
        private static bool PosValid(uint objcell, float x, float y) =>
            objcell != 0 && (Math.Abs(x) > PosEps || Math.Abs(y) > PosEps);

        private static double Frac(double x) => x - Math.Floor(x);
    }
}
