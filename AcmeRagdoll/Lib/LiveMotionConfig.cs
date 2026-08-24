using System;
using System.Globalization;
using System.IO;
using System.Threading;
using Microsoft.Extensions.Logging;

namespace AcmeRagdoll.Lib {
    /// <summary>
    /// IMMUTABLE snapshot of the live-motion layer's tuning knobs - the object
    /// <see cref="AcmeRagdoll.Services.LiveMotionRegistry"/> reads its physics constants out of.
    ///
    /// THE CONTRACT, and the whole reason this is a class rather than a bag of fields on the config:
    /// an instance is filled ONCE, by <see cref="LiveMotionConfig"/>, BEFORE it is published, and is
    /// never mutated again. A new file version produces a NEW instance, swapped into
    /// <see cref="LiveMotionConfig.Current"/> by a single volatile reference write. The sim thread
    /// reads that reference once at the top of a frame and uses the same instance for the whole
    /// frame, so it can never observe a half-applied edit (e.g. a new springK against the old
    /// springDamp) - which a set of individually-updated fields absolutely would allow, and which
    /// would show up as a one-frame instability rather than as an obvious bug.
    ///
    /// The fields are public and writable ONLY so the parser can fill them by <c>ref</c>. Nothing
    /// outside <see cref="LiveMotionConfig.ReloadCore"/> may write one.
    ///
    /// EVERY DEFAULT BELOW IS THE C2 SHIPPED CONSTANT, with its original rationale comment moved
    /// here verbatim: this file is now the single place a number and the reason for it live.
    /// </summary>
    internal sealed class LiveMotionTuning {
        // ---------------------------------------------------------------- master switch

        /// <summary><c>livemotion</c>. Runtime master switch for the hit-reaction layer. DEFAULT ON
        /// (runbook owner call). Turning it off retires every reacting body, drops the layer's vote on
        /// the shared UpdateParts detour and makes both net handlers no-ops; turning it back on starts
        /// from a clean slate. This is the RUNTIME switch - <c>RagdollSettings.liveMotion</c> is still
        /// the boot switch, and with THAT false the layer is never constructed at all (the C1
        /// bit-identity invariant) and this knob has nothing to switch.</summary>
        public bool Enabled = true;

        // ---------------------------------------------------------------- spring

        /// <summary><c>springk</c>. Base spring stiffness, 1/s^2. omega_n = sqrt(320) ~ 17.9 rad/s,
        /// i.e. a ~0.35 s natural period: one readable flinch per hit at any frame rate we render at.
        /// One of the three knobs that actually decide how the layer LOOKS - tune it first.</summary>
        public float SpringK = 320f;

        /// <summary><c>springdamp</c>. Base spring damping, 1/s. zeta = c / (2*sqrt(k)) ~ 0.25 -
        /// underdamped enough to read as a recoil rather than a slide, with the amplitude envelope
        /// down to ~10% in 0.5 s.</summary>
        public float SpringDamp = 9.0f;

        /// <summary><c>corestiffmul</c> / <c>edgestiffmul</c>. Stiffness multiplier at looseness 0 (a
        /// root/core part) and at looseness 1 (an extremity). 2.2 vs 0.55 is a 4x stiffness ratio = 2x
        /// frequency ratio: the core barely shifts and recovers immediately while a limb whips and
        /// rings once.</summary>
        public float CoreStiffMul = 2.2f;
        /// <summary>See <see cref="CoreStiffMul"/>.</summary>
        public float EdgeStiffMul = 0.55f;

        /// <summary><c>coreimpulsefrac</c>. Share of the impulse a perfectly stiff (looseness 0) part
        /// still receives, so a hit moves the WHOLE body a little rather than only its
        /// extremities.</summary>
        public float CoreImpulseFrac = 0.35f;

        // ---------------------------------------------------------------- energy

        /// <summary><c>energyperdamagepercent</c>. Reaction energy per unit of DamagePercent. 3.0 means
        /// a hit taking a third of the target's health saturates <see cref="PoolCap"/> - i.e. "a third
        /// of your life in one blow" is as hard as the layer ever reacts.</summary>
        public float EnergyPerDamagePercent = 3.0f;

        /// <summary><c>impulsevelperenergy</c>. Peak per-part velocity kick, yd/s, per unit of pool
        /// energy. With the default spring a unit-energy hit peaks at v0/omega_d ~ 0.12 yd, so the
        /// amplitude clamp (not this) is what bounds a big hit; this sets how hard a SMALL hit
        /// reads.</summary>
        public float ImpulseVelPerEnergy = 2.2f;

        /// <summary><c>poolcap</c>. Saturation cap on a body's reaction energy. Hits past the cap
        /// REFRESH the decay rather than growing the pool - that is what keeps a 10-attacker boss swarm
        /// from exploding. 1.0 == "one full-health-bar hit's worth of reaction energy". Applied to every
        /// live body each frame, so an edit is visible mid-fight.</summary>
        public float PoolCap = 1.0f;

        /// <summary><c>poolhalflife</c>. Pool half-life, seconds (wall clock, so it is frame-rate
        /// independent). 1.5 s is long enough that sustained melee keeps a body visibly rattled and
        /// short enough that a body left alone is fully quiet - and retired - inside ~4 s.</summary>
        public float PoolHalfLifeSec = 1.5f;

        /// <summary><c>poolgainknee</c>. Fraction of <see cref="PoolCap"/> at which the smoothstep
        /// visual gain reaches 1. Below the knee the gain rolls off smoothly, which is what makes a
        /// reaction FADE rather than stop; above it, every ordinary hit is shown at full authored
        /// amplitude.</summary>
        public float PoolGainKnee = 0.35f;

        // ---------------------------------------------------------------- crit

        /// <summary><c>critmult</c>. Crit impulse multiplier. Only the EXTRA (the 1.5x above the base)
        /// is gated by the refractory; the base impulse of a crit is never suppressed.</summary>
        public float CritImpulseMult = 2.5f;

        /// <summary><c>critrefractoryms</c>. Per-body refractory on the crit EXTRA, milliseconds. A
        /// crit chain inside one second reads as one big rock-back plus normal hits, not as a body
        /// being thrown repeatedly.</summary>
        public long CritRefractoryMillis = 1_000;

        // ---------------------------------------------------------------- shaping

        /// <summary><c>settledown</c>. Downward-settle share mixed into every impulse direction, before
        /// normalisation. A hit should sag the body slightly, not shove it purely sideways; 0.35 is a
        /// ~19 degree downward tilt, visible as weight without looking like the body is being driven
        /// into the ground.</summary>
        public float SettleDown = 0.35f;

        /// <summary><c>heightbias</c>. How much the splatter's height band biases which part rows move.
        /// Parts at the hit height get the full kick, the farthest rows get (1 - this). 0.45 makes a
        /// head hit rock the head without freezing the legs.</summary>
        public float HeightBias = 0.45f;

        /// <summary><c>ampfrac</c>. THE AMPLITUDE SAFETY KNOB. Max |offset| for any part, as a fraction
        /// of the body's own radius (max part distance from the part centroid, measured in the live
        /// pose so it already includes <c>pa-&gt;scale</c>). 5% keeps the layer firmly a flinch: a
        /// human-scale body moves ~4 cm, a Golem proportionally more, and nothing ever separates
        /// visibly from its skeleton. Clamped to 0.25 here NO MATTER WHAT THE FILE SAYS - a typo in a
        /// tuning file must not be able to tear a body apart.</summary>
        public float AmplitudeFrac = 0.05f;

        /// <summary><c>attackattenuation</c>. Layer gain while the body's OWN motion is attack-class.
        /// 30% keeps the reaction present but never fights the attack animation the player has to read
        /// to block/dodge.</summary>
        public float AttackAttenuation = 0.30f;

        /// <summary><c>defaultdamagepercent</c>. Magnitude used when a splatter never finds its damage
        /// notification - the COMMON case (monster-vs-monster, and other players' spells, carry no
        /// damage number to us at all). C0 §5.4: never let a missing damage number cost a visible
        /// reaction.</summary>
        public float DefaultDamagePercent = 0.10f;

        // ---------------------------------------------------------------- C4: idle micro-motion

        /// <summary><c>idlemotion</c>. Master switch for the archetype-driven idle micro-motion
        /// (breathing / floater bob+sway / blob pulse; props never move). DEFAULT ON, matching the
        /// runbook's "idle micro-motion KEPT" owner call. With it off the layer is BIT-IDENTICAL to
        /// C3: no idle offset is computed, the combine collapses to the pre-C4 multiply, and entries
        /// retire the moment their springs settle (no linger).</summary>
        public bool IdleMotion = true;

        /// <summary><c>idleamp</c>. Idle oscillation amplitude as a fraction of the body radius - the
        /// same unit as <see cref="AmplitudeFrac"/>, and deliberately ~6x smaller: breathing must sit
        /// an order of magnitude below a flinch. The result is additionally clamped to the body's own
        /// <c>ampfrac</c> maximum offset, so this can never exceed the hit layer's safety limit no
        /// matter what the file says.</summary>
        public float IdleAmp = 0.008f;

        /// <summary><c>idlehz</c>. Idle oscillation frequency, Hz. 0.35 Hz is a ~3 s breath cycle. The
        /// floater sway runs at <c>IdleMotion.SwayHzFrac</c> (0.23) of this. Phase is carried per
        /// body, not derived from a clock, so retuning this mid-breath changes the rate without
        /// moving the body.</summary>
        public float IdleHz = 0.35f;

        /// <summary><c>idlelingersec</c>. How long a body keeps its live-motion entry - and so keeps
        /// breathing - AFTER its last hit, once its hit springs have settled. This is the whole of
        /// C4's visibility mechanism: idle motion never arms the hot UpdateParts detour by itself
        /// (that would put every creature in the world on the hot path permanently), so it is only
        /// ever seen on a body the HIT layer already created an entry for. 30 s is long enough to
        /// watch a creature you just fought breathe, short enough that a camp goes fully quiet - and
        /// the detour disarms - well before you have walked away. 0 disables the linger, which
        /// restores C3's "retire the instant the springs settle" exactly.</summary>
        public float IdleLingerSec = 30f;

        // ---------------------------------------------------------------- C5: procedural gait

        /// <summary><c>gait</c>. The hexapod procedural-tripod-gait prototype
        /// (<see cref="AcmeRagdoll.Sim.GaitMotion"/>), on ONE hard-coded body
        /// (<see cref="AcmeRagdoll.Sim.GaitMotion.TargetSetupDid"/>). DEFAULT OFF: the runbook has it
        /// behind a cfg flag and first-to-cut. With it off no gait offset is computed, the write-time
        /// combine sees the pre-C5 blend exactly, and this stage is bit-identical to C4.</summary>
        public bool Gait = false;

        /// <summary><c>gaitamp</c>. Gait amplitude as a fraction of the body radius - the same unit as
        /// <see cref="AmplitudeFrac"/> and <see cref="IdleAmp"/>. 0.02 sits between the breath (0.008)
        /// and the flinch (0.05): this is a TEXTURE over the retail walk animation, not a replacement
        /// for it. Additionally clamped to the body's own <c>ampfrac</c> maximum offset, so it can
        /// never exceed the hit layer's safety limit whatever the file says.</summary>
        public float GaitAmp = 0.02f;

        /// <summary><c>gaitcadence</c>. Step frequency, Hz, at the reference ground speed
        /// (<see cref="AcmeRagdoll.Sim.GaitMotion.RefSpeedYdS"/>). 1.6 Hz is a ~0.6 s tripod cycle -
        /// an insect trot. The ACTUAL frequency is this scaled by the body's measured ground speed
        /// (<see cref="AcmeRagdoll.Sim.GaitMotion.CadenceHz"/>); when no speed sample is available the
        /// cadence is exactly this value. Phase is carried per body, so retuning mid-step changes the
        /// rate without jumping the legs.</summary>
        public float GaitCadenceHz = 1.6f;

        /// <summary><c>deathvariety</c>. Per-death parameter variety: sample the PCA death-manifold so
        /// each death of a body differs coherently and in-character (see
        /// <see cref="AcmeRagdoll.Sim.DeathVariety"/>). DEFAULT OFF: a death is exactly its authored
        /// profile until this is switched on. Read at seed time; pushed to the DeathVariety statics.</summary>
        public bool DeathVariety = false;

        /// <summary><c>deathvarietystrength</c>. How far a death may wander along the manifold, in
        /// eigen-sigmas. 0 = none, ~0.6 = tasteful, &gt;1 = wild. Clamped [0,1.5].</summary>
        public float DeathVarietyStrength = 0.6f;

        /// <summary><c>deathorientgain</c>. Gain on the death-fall ORIENTATION commit: how hard a death
        /// cancels the body's own centre-of-mass bias so it lands along its sampled heading
        /// (prone/supine/on-side) instead of face-planting. Multiplied by
        /// <see cref="DeathVarietyStrength"/>; 1.0 cancels the measured bias once, 1.4 (default) is what
        /// gives a drudge a roughly even prone/supine mix at strength 0.7. 0 = orientation untouched
        /// (parameter variety still applies). Clamped [0,4]; the sim's own rate ceilings bound the
        /// outcome, so a large value cannot launch a body — it just saturates.</summary>
        public float DeathOrientGain = 1.4f;

        // ---------------------------------------------------------------- plumbing

        /// <summary>The shipped defaults. Published as <see cref="LiveMotionConfig.Current"/> whenever
        /// no cfg file exists, which is the normal case on a machine nobody is tuning on.</summary>
        public static readonly LiveMotionTuning Defaults = new();

        /// <summary>A writable copy to fill from a freshly-read file. The ONLY way a new instance is
        /// made outside the defaults.</summary>
        public LiveMotionTuning Copy() => (LiveMotionTuning)MemberwiseClone();
    }

    /// <summary>
    /// Live tuning for the hit-reaction layer: a plain-text <c>key = value</c> file, re-read at most
    /// ONCE PER SECOND from paths the layer already runs on, so the 1070 tuning loop is
    /// edit-cfg-and-watch with no rebuild, no reinject and no client restart.
    ///
    /// This is the AcmeLights <c>LightsConfig</c> pattern (<c>AcmeLights/Lib/LightsConfig.cs</c>,
    /// proven in-client) with three deliberate differences, all of them because this config is polled
    /// from a NATIVE DETOUR STACK rather than from a render callback:
    ///   1. IT PUBLISHES AN IMMUTABLE SNAPSHOT (<see cref="LiveMotionTuning"/>) instead of mutating
    ///      live fields, so the sim thread cannot read a half-applied edit mid-frame;
    ///   2. IT STATS BEFORE IT READS. The 1/s tick only compares path + mtime + length; the file is
    ///      opened, parsed and a snapshot allocated ONLY when it actually changed. Steady state is one
    ///      stat per second and ZERO allocation, which is what makes it acceptable to poll from the
    ///      UpdateParts tail at all;
    ///   3. IT IS SINGLE-FLIGHT AND TOTAL. Two threads (the net handlers and the sim thread) poll it;
    ///      a second concurrent poll returns the current snapshot instead of blocking, and every path
    ///      in here is wrapped so a locked, truncated, half-written or unreadable file can never
    ///      unwind into the detour - it just keeps the last good snapshot.
    ///
    /// FILE: first existing of <c>%ACMERAGDOLL_CONFIG%</c> · <c>C:\Temp\acdt\ragdoll.cfg</c> ·
    /// <c>%USERPROFILE%\.acdt\ragdoll.cfg</c>. Format <c>key = value</c>, one per line, <c>#</c> and
    /// <c>;</c> comments, case-insensitive keys, unknown keys ignored. Missing file = all defaults.
    /// A value that does not parse (or is not finite) keeps the LAST GOOD value for that key and logs
    /// ONCE per key per session; out-of-range values are clamped silently to the documented range.
    /// Deleting a key from the file reverts THAT key to its default on the next read.
    /// </summary>
    internal sealed class LiveMotionConfig {
        /// <summary>Poll interval. Nothing touches the disk more often than this, from any path.</summary>
        private const int CheckIntervalMs = 1_000;

        private static readonly string[] CandidatePaths = BuildCandidatePaths();

        private readonly ILogger _log;

        /// <summary>The published snapshot. Volatile: written by whichever thread reloads, read by the
        /// sim thread and the net handlers without a lock.</summary>
        private volatile LiveMotionTuning _current = LiveMotionTuning.Defaults;

        /// <summary>Throttle stamp, as a 32-bit tick count. INT, not long, on purpose: this process is
        /// 32-bit x86, where a long read/write is not atomic and two polling threads could tear one.
        /// Unsigned-safe subtraction handles the ~24.9-day wrap.</summary>
        private int _lastCheckTick;
        private bool _checkedOnce;

        /// <summary>Single-flight guard (0 idle, 1 reloading). A concurrent poller returns the current
        /// snapshot rather than blocking on file IO - a detour must never wait on a disk.</summary>
        private int _reloading;

        // What the currently-loaded snapshot was parsed from; the "did it change" test.
        /// <summary>How often the FULL candidate list is walked (a newly created higher-priority cfg
        /// appears within this long); in between, only the loaded file is re-stat'd. See ReloadCore.</summary>
        private const int FullScanIntervalMs = 10_000;
        private long _lastFullScanMs = -FullScanIntervalMs;

        private string? _stampPath;
        private DateTime _stampUtc;
        private long _stampLen = -1;

        /// <summary>One-bit-per-key "already complained about this one" set, so a bad value logs once
        /// per session instead of once per second. Bits are <see cref="KeyBit"/> ordinals.</summary>
        private uint _badLogged;
        private bool _ioFailLogged;

        /// <summary>The file the live snapshot came from, or null when no cfg file exists (defaults).
        /// Diagnostics only.</summary>
        public string? LoadedFrom { get; private set; }

        public LiveMotionConfig(ILogger log) { _log = log; }

        /// <summary>The current tuning snapshot. Never null.</summary>
        public LiveMotionTuning Current => _current;

        /// <summary>
        /// THE ONE ENTRY POINT the hot paths call. Returns the current snapshot, having re-read the
        /// file first if (and only if) at least <see cref="CheckIntervalMs"/> has elapsed AND the file
        /// changed. Costs one int compare in the common case, one stat once a second, and a parse only
        /// on a real edit. NEVER throws.
        /// </summary>
        /// <param name="nowMs"><c>Environment.TickCount64</c> from the caller (which already has it).</param>
        public LiveMotionTuning Poll(long nowMs) {
            int now = (int)nowMs;
            if (_checkedOnce && now - _lastCheckTick < CheckIntervalMs) return _current;
            _lastCheckTick = now;
            _checkedOnce = true;

            // Single-flight: if the other thread is already reloading, use what we have.
            if (Interlocked.CompareExchange(ref _reloading, 1, 0) != 0) return _current;
            try { ReloadCore(); }
            catch (Exception ex) { LogIoFailOnce(ex); }
            finally { Volatile.Write(ref _reloading, 0); }
            return _current;
        }

        /// <summary>
        /// Force a read regardless of the throttle. Called ONCE from the plugin's managed
        /// <c>Initialize()</c> so the first frame already runs on the file's values, and so the whole
        /// parse path is JITed on a load-legal thread (the 0x80131509 rule - see
        /// <c>AcmeRagdollPlugin.WarmupAcBindings</c>).
        /// </summary>
        public LiveMotionTuning Prime() {
            _checkedOnce = false;
            return Poll(Environment.TickCount64);
        }

        private static string[] BuildCandidatePaths() {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return new[] {
                Environment.GetEnvironmentVariable("ACMERAGDOLL_CONFIG") ?? "",
                @"C:\Temp\acdt\ragdoll.cfg",
                Path.Combine(home, ".acdt", "ragdoll.cfg"),
            };
        }

        /// <summary>Stat, and only on a real change read + parse + publish. Caller owns the try/catch
        /// and the single-flight guard.</summary>
        private void ReloadCore() {
            string? path = null;
            DateTime utc = default;
            long len = 0;

            // PACING (2026-08-23): this runs on the RENDER THREAD once a second (Poll is called from
            // the top of OnUpdateParts). Re-stat only the file we are already loaded from — one stat
            // instead of up to three, and one FileInfo instead of three — and fall back to the full
            // candidate walk only every FullScanIntervalMs, which is what would notice a
            // higher-priority candidate appearing mid-session.
            long nowMs = Environment.TickCount64;
            if (_stampPath != null && nowMs - _lastFullScanMs < FullScanIntervalMs) {
                try {
                    var known = new FileInfo(_stampPath);
                    if (known.Exists && known.LastWriteTimeUtc == _stampUtc && known.Length == _stampLen)
                        return;                                  // unchanged — no read, no parse
                }
                catch { /* fall through to the full scan */ }
            }
            _lastFullScanMs = nowMs;

            foreach (string candidate in CandidatePaths) {
                if (string.IsNullOrEmpty(candidate)) continue;
                var fi = new FileInfo(candidate);   // one stat; Exists/Length/LastWriteTimeUtc all cached
                if (!fi.Exists) continue;
                path = candidate; utc = fi.LastWriteTimeUtc; len = fi.Length;
                break;
            }

            if (path == null) {
                // No file at all. Revert to defaults if we were previously loaded from one.
                if (_stampPath != null) {
                    _stampPath = null; _stampLen = -1; LoadedFrom = null;
                    _current = LiveMotionTuning.Defaults;
                    AcmeRagdoll.Sim.DeathVariety.Enabled = _current.DeathVariety;
                    AcmeRagdoll.Sim.DeathVariety.Strength = _current.DeathVarietyStrength;
                    AcmeRagdoll.Sim.DeathVariety.OrientGain = _current.DeathOrientGain;
                    _log.LogInformation("livemotion cfg: file gone; reverted to shipped defaults");
                }
                return;
            }

            if (path == _stampPath && utc == _stampUtc && len == _stampLen) return;   // unchanged

            LiveMotionTuning next = Parse(path);

            _stampPath = path; _stampUtc = utc; _stampLen = len;
            LoadedFrom = path;
            LiveMotionTuning prev = _current;
            _current = next;                                   // <- the atomic publish
            // Push the death-variety knobs to their statics (the death path reads DeathVariety.Enabled/
            // Strength at seed time; it does not hold a cfg reference of its own).
            AcmeRagdoll.Sim.DeathVariety.Enabled = next.DeathVariety;
            AcmeRagdoll.Sim.DeathVariety.Strength = next.DeathVarietyStrength;
            AcmeRagdoll.Sim.DeathVariety.OrientGain = next.DeathOrientGain;

            _log.LogInformation(
                "livemotion cfg: loaded {Path} (livemotion={On} springK={K:F0} damp={C:F1} ampFrac={A:F3} " +
                "poolCap={P:F2} halfLife={H:F2}s knee={N:F2} crit={X:F1}x/{R}ms atk={T:F2} " +
                "idle={I}/amp={IA:F4}/hz={IH:F2}/linger={IL:F0}s gait={G}/amp={GA:F3}/cad={GC:F2}Hz " +
                "deathvariety={DV}/str={DS:F2}/orientgain={DO:F2})",
                path, next.Enabled ? 1 : 0, next.SpringK, next.SpringDamp, next.AmplitudeFrac,
                next.PoolCap, next.PoolHalfLifeSec, next.PoolGainKnee, next.CritImpulseMult,
                next.CritRefractoryMillis, next.AttackAttenuation,
                next.IdleMotion ? 1 : 0, next.IdleAmp, next.IdleHz, next.IdleLingerSec,
                next.Gait ? 1 : 0, next.GaitAmp, next.GaitCadenceHz,
                next.DeathVariety ? 1 : 0, next.DeathVarietyStrength, next.DeathOrientGain);
            if (prev.Enabled != next.Enabled)
                _log.LogInformation("livemotion cfg: layer {State} by cfg", next.Enabled ? "ENABLED" : "DISABLED");
        }

        /// <summary>
        /// Read the file into a fresh snapshot. Starts from the DEFAULTS (so deleting a key reverts it)
        /// and falls back per key to the LAST GOOD value when a value is unparseable. FileShare.ReadWrite
        /// so an editor holding the file open cannot make the client's read fail; a torn half-written
        /// read simply parses to whatever it can and is superseded on the next mtime change.
        /// </summary>
        private LiveMotionTuning Parse(string path) {
            LiveMotionTuning t = LiveMotionTuning.Defaults.Copy();
            LiveMotionTuning last = _current;

            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var sr = new StreamReader(fs);
            string? line;
            while ((line = sr.ReadLine()) != null) {
                string s = line.Trim();
                if (s.Length == 0 || s[0] == '#' || s[0] == ';') continue;
                int eq = s.IndexOf('=');
                if (eq <= 0) continue;
                Apply(t, last, s.Substring(0, eq).Trim().ToLowerInvariant(), StripInlineComment(s.Substring(eq + 1)));
            }
            return t;
        }

        /// <summary>Bit ordinals for <see cref="_badLogged"/>. One per key, so "log once per bad key"
        /// costs a shift and an OR instead of a set.</summary>
        private static class KeyBit {
            public const int LiveMotion = 0, SpringK = 1, SpringDamp = 2, CoreStiff = 3, EdgeStiff = 4,
                CoreImpulse = 5, EnergyPerDmg = 6, ImpulseVel = 7, PoolCap = 8, PoolHalfLife = 9,
                PoolKnee = 10, CritMult = 11, CritRefractory = 12, SettleDown = 13, HeightBias = 14,
                AmpFrac = 15, AttackAtten = 16, DefaultDmg = 17,
                IdleMotion = 18, IdleAmp = 19, IdleHz = 20, Gait = 21, IdleLinger = 22,
                GaitAmp = 23, GaitCadence = 24, DeathVariety = 25, DeathVarietyStr = 26,
                DeathOrientGain = 27;
        }

        /// <summary>One key. Ranges are the documented clamps; <c>ampfrac</c>'s upper bound is a real
        /// safety limit, not a preference.</summary>
        private void Apply(LiveMotionTuning t, LiveMotionTuning last, string key, string val) {
            switch (key) {
                // ---- master switch ----
                case "livemotion": SetB(ref t.Enabled, val, last.Enabled, KeyBit.LiveMotion, key); break;

                // ---- spring ----
                case "springk": SetF(ref t.SpringK, val, last.SpringK, 1f, 5000f, KeyBit.SpringK, key); break;
                case "springdamp": SetF(ref t.SpringDamp, val, last.SpringDamp, 0f, 200f, KeyBit.SpringDamp, key); break;
                case "corestiffmul": SetF(ref t.CoreStiffMul, val, last.CoreStiffMul, 0.01f, 20f, KeyBit.CoreStiff, key); break;
                case "edgestiffmul": SetF(ref t.EdgeStiffMul, val, last.EdgeStiffMul, 0.01f, 20f, KeyBit.EdgeStiff, key); break;
                case "coreimpulsefrac": SetF(ref t.CoreImpulseFrac, val, last.CoreImpulseFrac, 0f, 1f, KeyBit.CoreImpulse, key); break;

                // ---- energy ----
                case "energyperdamagepercent": SetF(ref t.EnergyPerDamagePercent, val, last.EnergyPerDamagePercent, 0f, 50f, KeyBit.EnergyPerDmg, key); break;
                case "impulsevelperenergy": SetF(ref t.ImpulseVelPerEnergy, val, last.ImpulseVelPerEnergy, 0f, 50f, KeyBit.ImpulseVel, key); break;
                case "poolcap": SetF(ref t.PoolCap, val, last.PoolCap, 0.01f, 20f, KeyBit.PoolCap, key); break;
                case "poolhalflife": SetF(ref t.PoolHalfLifeSec, val, last.PoolHalfLifeSec, 0.05f, 30f, KeyBit.PoolHalfLife, key); break;
                case "poolgainknee": SetF(ref t.PoolGainKnee, val, last.PoolGainKnee, 0.01f, 1f, KeyBit.PoolKnee, key); break;

                // ---- crit ----
                case "critmult": SetF(ref t.CritImpulseMult, val, last.CritImpulseMult, 1f, 10f, KeyBit.CritMult, key); break;
                case "critrefractoryms": SetMs(ref t.CritRefractoryMillis, val, last.CritRefractoryMillis, 0, 10_000, KeyBit.CritRefractory, key); break;

                // ---- shaping ----
                case "settledown": SetF(ref t.SettleDown, val, last.SettleDown, 0f, 4f, KeyBit.SettleDown, key); break;
                case "heightbias": SetF(ref t.HeightBias, val, last.HeightBias, 0f, 1f, KeyBit.HeightBias, key); break;
                case "ampfrac": SetF(ref t.AmplitudeFrac, val, last.AmplitudeFrac, 0f, 0.25f, KeyBit.AmpFrac, key); break;
                case "attackattenuation": SetF(ref t.AttackAttenuation, val, last.AttackAttenuation, 0f, 1f, KeyBit.AttackAtten, key); break;
                case "defaultdamagepercent": SetF(ref t.DefaultDamagePercent, val, last.DefaultDamagePercent, 0f, 1f, KeyBit.DefaultDmg, key); break;

                // ---- C4: idle micro-motion ----
                case "idlemotion": SetB(ref t.IdleMotion, val, last.IdleMotion, KeyBit.IdleMotion, key); break;
                case "idleamp": SetF(ref t.IdleAmp, val, last.IdleAmp, 0f, 0.25f, KeyBit.IdleAmp, key); break;
                case "idlehz": SetF(ref t.IdleHz, val, last.IdleHz, 0f, 10f, KeyBit.IdleHz, key); break;
                // 0 = no linger (C3 behaviour); 600 s is an absurd-but-survivable upper bound - a typo
                // here costs an armed detour, never a crash, so it is clamped rather than rejected.
                case "idlelingersec": SetF(ref t.IdleLingerSec, val, last.IdleLingerSec, 0f, 600f, KeyBit.IdleLinger, key); break;

                // ---- C5: procedural tripod gait (one hard-coded hexapod body) ----
                case "gait": SetB(ref t.Gait, val, last.Gait, KeyBit.Gait, key); break;
                case "gaitamp": SetF(ref t.GaitAmp, val, last.GaitAmp, 0f, 0.25f, KeyBit.GaitAmp, key); break;
                // 0 freezes the sine at a constant offset rather than stopping it, so GaitActive
                // treats 0 as "off" - the same rule idlehz follows.
                case "gaitcadence": SetF(ref t.GaitCadenceHz, val, last.GaitCadenceHz, 0f, 10f, KeyBit.GaitCadence, key); break;

                // ---- per-death variety (PCA death-manifold sampler) ----
                case "deathvariety": SetB(ref t.DeathVariety, val, last.DeathVariety, KeyBit.DeathVariety, key); break;
                case "deathvarietystrength": SetF(ref t.DeathVarietyStrength, val, last.DeathVarietyStrength, 0f, 1.5f, KeyBit.DeathVarietyStr, key); break;
                case "deathorientgain": SetF(ref t.DeathOrientGain, val, last.DeathOrientGain, 0f, 4f, KeyBit.DeathOrientGain, key); break;

                // unknown key: ignored, deliberately and silently (a cfg written for a later stage
                // must not spam a client running an earlier one).
            }
        }

        private void SetF(ref float dst, string val, float lastGood, float min, float max, int bit, string key) {
            if (float.TryParse(val, NumberStyles.Float, CultureInfo.InvariantCulture, out float v)
                && !float.IsNaN(v) && !float.IsInfinity(v)) {
                dst = v < min ? min : (v > max ? max : v);
                return;
            }
            dst = lastGood;
            LogBadOnce(bit, key, val);
        }

        private void SetMs(ref long dst, string val, long lastGood, long min, long max, int bit, string key) {
            if (float.TryParse(val, NumberStyles.Float, CultureInfo.InvariantCulture, out float v)
                && !float.IsNaN(v) && !float.IsInfinity(v)) {
                long ms = (long)MathF.Round(v);
                dst = ms < min ? min : (ms > max ? max : ms);
                return;
            }
            dst = lastGood;
            LogBadOnce(bit, key, val);
        }

        /// <summary>Tolerant boolean: 1/0, true/false, on/off, yes/no, enabled/disabled - anything a
        /// person editing a tuning file on a 1070 might reasonably type.</summary>
        private void SetB(ref bool dst, string val, bool lastGood, int bit, string key) {
            switch (val.ToLowerInvariant()) {
                case "1": case "true": case "on": case "yes": case "enabled": dst = true; return;
                case "0": case "false": case "off": case "no": case "disabled": dst = false; return;
            }
            if (float.TryParse(val, NumberStyles.Float, CultureInfo.InvariantCulture, out float v)
                && !float.IsNaN(v) && !float.IsInfinity(v)) {
                dst = v >= 0.5f;
                return;
            }
            dst = lastGood;
            LogBadOnce(bit, key, val);
        }

        private void LogBadOnce(int bit, string key, string val) {
            uint mask = 1u << bit;
            if ((_badLogged & mask) != 0) return;
            _badLogged |= mask;
            try {
                _log.LogWarning("livemotion cfg: bad value for '{Key}' ({Val}); keeping last good value", key, val);
            }
            catch { }
        }

        private void LogIoFailOnce(Exception ex) {
            if (_ioFailLogged) return;
            _ioFailLogged = true;
            try { _log.LogWarning(ex, "livemotion cfg: unreadable; keeping the current tuning"); }
            catch { }
        }

        /// <summary>Strip a trailing `# ...` / `; ...` comment from a value — ported verbatim
        /// from AcmeSky's SkyConfig (the 2026-08-23 fix: an inline comment made float.TryParse
        /// fail and the key was silently DROPPED, so a cfg copied from the example file had
        /// every commented key ignored while looking perfectly configured).</summary>
        private static string StripInlineComment(string raw) {
            int c = raw.IndexOfAny(CommentChars);
            return (c >= 0 ? raw.Substring(0, c) : raw).Trim();
        }
        private static readonly char[] CommentChars = { '#', ';' };
    }
}
