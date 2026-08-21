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
    /// THREADING.  Both entry points (<see cref="OnMotionDone"/> and <see cref="OnUpdateParts"/>) are
    /// called from the client's single simulation thread, from inside the native detours in
    /// <see cref="NativeHooks"/>.  Because they share that one thread, the plain
    /// <see cref="Dictionary{TKey,TValue}"/> is accessed without locks on the hot path.  Teardown
    /// (<see cref="Shutdown"/>) runs on a different thread but only AFTER NativeHooks has disabled the
    /// detours, and it flips <see cref="_down"/> which both detours check first.
    ///
    /// LIFETIME + POINTER SAFETY (the traps the research calls out):
    ///   * never cache a CPhysicsPart* across frames - parts are re-resolved from the live CPartArray
    ///     every frame and every parts[i] is null-checked;
    ///   * entries are keyed by the stable object id, and the captured CPhysicsObj*/CPartArray* are
    ///     re-verified each frame so a freed-then-reused id/pointer cannot be written through;
    ///   * despawned corpses stop generating UpdateParts calls, so their entries are swept by
    ///     "not touched recently" during the next death; live corpses are released after a hold cap.
    /// </summary>
    internal sealed unsafe class RagdollRegistry {
        private sealed class Entry {
            public uint ObjId;
            public CPhysicsObj* Obj;
            public CPartArray* Parts;      // captured at seed
            public RagdollSim? Sim;
            public Quat[]? Scratch;
            public bool Seeded;
            public int SeedAttempts;
            public int ActiveLeft;         // frames of active fall remaining
            public long ArmedTick;         // for the hold cap
            public long LastTouchTick;     // for despawn sweep
        }

        private const int MaxLive = 64;              // safety cap on concurrent ragdolls
        private const int SeedAttemptsMax = 10;      // give up if the pose never reads clean
        private const long HoldMillis = 30_000;      // release a held corpse after this long
        private const long DespawnMillis = 2_000;    // sweep entries not touched in this long

        private readonly Dictionary<uint, Entry> _live = new(MaxLive);
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

        /// <summary>Death signal. Arms a ragdoll for a creature whose Dead motion just finished.</summary>
        public void OnMotionDone(CPhysicsObj* obj, uint motion) {
            if (_down || obj == null) return;
            if (motion != DeadMotion) return;

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

            long now = Environment.TickCount64;
            _live[id] = new Entry {
                ObjId = id, Obj = obj, Parts = null, Seeded = false,
                ActiveLeft = RagdollSim.FallFrames, ArmedTick = now, LastTouchTick = now,
            };
            if (_live.Count == 1) {
                try { _setUpdatePartsHook(true); }
                catch (Exception ex) { _log.LogError(ex, "ragdoll: failed to arm UpdateParts hook"); }
            }
        }

        /// <summary>
        /// Post-detour of CPartArray::UpdateParts. The original already wrote each part's world Frame;
        /// if this part array's owner is ragdolling we overwrite the parts we own.
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

            WriteParts(e, pa, objFrame);
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
            return true;
        }

        // ------------------------------------------------------------------ write

        private void WriteParts(Entry e, CPartArray* pa, Frame* objFrame) {
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

            for (int i = 0; i < n; i++) {
                CPhysicsPart* part = parts[i];
                if (part == null) continue;   // never cache/deref a missing part

                sim.GetPos(i, out float mx, out float my, out float mz);
                // world = objOrigin + Rotate(objQuat, scale (x) modelOrigin)   [client scaled combine]
                QMath.Rotate(oq, sx * mx, sy * my, sz * mz, out float rx, out float ry, out float rz);
                float wx = oox + rx, wy = ooy + ry, wz = ooz + rz;
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

        // ------------------------------------------------------------------ lifetime

        private void Remove(uint id) {
            if (_live.Remove(id) && _live.Count == 0) {
                try { _setUpdatePartsHook(false); }
                catch (Exception ex) { _log.LogError(ex, "ragdoll: failed to disarm UpdateParts hook"); }
            }
        }

        /// <summary>Drop entries whose corpse has despawned (no UpdateParts touch for a while).</summary>
        private void SweepStale() {
            long now = Environment.TickCount64;
            List<uint>? dead = null;
            foreach (var kv in _live) {
                Entry e = kv.Value;
                long since = now - (e.Seeded ? e.LastTouchTick : e.ArmedTick);
                if (since > DespawnMillis) (dead ??= new List<uint>()).Add(kv.Key);
            }
            if (dead != null) foreach (uint id in dead) Remove(id);
        }

        /// <summary>Called from the plugin on unload, AFTER the detours have been disabled.</summary>
        public void Shutdown() {
            _down = true;
            _live.Clear();
        }

        // ------------------------------------------------------------------ helpers

        /// <summary>MotionCommand.Dead (Chorizite.Common/Enums/MotionCommand.cs:24).</summary>
        private const uint DeadMotion = 0x40000011;

        private static uint ObjIdOf(CPhysicsObj* obj) =>
            obj->BaseClass_LongHashData.BaseClass_HashBaseData.id;

        private static double Frac(double x) => x - Math.Floor(x);
    }
}
