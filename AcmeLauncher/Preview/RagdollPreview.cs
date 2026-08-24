using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using System.Windows.Threading;
using AcmeRagdoll.Sim;

namespace AcmeLauncher.Preview {
    /// <summary>
    /// Ragdoll knob preview. Runs the plugin's OWN physics (AcmeRagdoll/Sim/*.cs are compiled into
    /// this assembly unchanged — see AcmeLauncher.csproj), so every mode is the same equations the
    /// plugin runs in-game. Skeletons are baked model-space death-beat poses
    /// (preview_skeletons.json, from tools/gen_preview_skeletons.py). Stick figure on one
    /// DrawingVisual, hand-rolled turntable projection (+Z up, per ragdoll_bake.py). 30 fps.
    ///
    /// DONE: mode strip [Auto|Idle|Hit|Walk|Death]; death fall (real RagdollSim) with death knobs
    /// (deathvariety/deathvarietystrength/deathorientgain via DeathVariety statics), replay-same-seed
    /// + new-seed; hit springs (real SpringMotion: scripted normal + crit hits, energy-pool bar with
    /// the poolgainknee marker, all spring/pool/crit/shaping knobs live); idle micro-motion (real
    /// IdleMotion.Build/Accumulate, archetype branches); gait (real GaitMotion, Olthoi rig only);
    /// per-body metrics derived the registry's way (baked roles/looseness/ground with the depth
    /// heuristic fallback, height span, radius → ampfrac clamp); livemotion/gait master switches
    /// honored; framing auto-fit; body picker (all 7 archetypes baked); honest caption; Start/Stop
    /// 0-CPU lifecycle. REMAINING (design §2.5): Δ-ghost overlay.
    /// </summary>
    internal sealed class RagdollPreview : IKnobPreview {
        // ── baked skeleton ─────────────────────────────────────────────────
        private sealed class Skel {
            public string name { get; set; } = "";
            public string archetype { get; set; } = "";
            public long setupDid { get; set; }
            public int n { get; set; }
            public uint[] parent { get; set; } = Array.Empty<uint>();
            public float[] startPos { get; set; } = Array.Empty<float>();
            public float[] startQuats { get; set; } = Array.Empty<float>();
            // Optional (newer bakes): per-part Tier-0 roles, authored looseness + ground flags.
            public string[]? roles { get; set; }
            public float[]? looseness { get; set; }
            public bool[]? ground { get; set; }
        }
        private sealed class SkelFile { public List<Skel> bodies { get; set; } = new(); }

        /// <summary>A body the launcher can index without bounds faults: every array sized to n
        /// (optional ones may be absent, never short). Malformed bodies are dropped at load with a
        /// caption note — an IndexOutOfRange escaping the DispatcherTimer Tick kills the launcher.</summary>
        private static bool ValidSkel(Skel b) =>
            b.n > 0 &&
            b.parent != null && b.parent.Length == b.n &&
            b.startPos != null && b.startPos.Length == b.n * 3 &&
            b.startQuats != null && b.startQuats.Length == b.n * 4 &&
            (b.roles == null || b.roles.Length == b.n) &&
            (b.looseness == null || b.looseness.Length == b.n) &&
            (b.ground == null || b.ground.Length == b.n);

        private readonly List<Skel> _bodies = new();
        private readonly List<string> _droppedBodies = new();
        private Skel? _body;
        private IReadOnlyDictionary<string, string> _knobs = new Dictionary<string, string>();

        // ── knob access (Generated clamps, so the preview can't drift from the plugin) ──
        private static readonly Dictionary<string, KnobDef> RagKnobs = BuildRagKnobs();
        private static Dictionary<string, KnobDef> BuildRagKnobs() {
            var d = new Dictionary<string, KnobDef>(StringComparer.OrdinalIgnoreCase);
            foreach (var k in GeneratedKnobs.All) if (k.Cfg == "ragdoll") d[k.Name] = k;
            return d;
        }
        private float K(string key) {
            RagKnobs.TryGetValue(key, out var k);
            float v = KnobRead.F(_knobs, key, k?.DefaultF ?? 0f);
            if (k != null && k.HasRange) { if (v < k.MinF) v = k.MinF; else if (v > k.MaxF) v = k.MaxF; }
            return v;
        }
        private bool KB(string key) => K(key) >= 0.5f;

        // ── view ───────────────────────────────────────────────────────────
        private readonly Grid _root = new();
        private readonly SkeletonHost _host = new();
        private readonly TextBlock _caption = new() { TextWrapping = TextWrapping.Wrap, Foreground = Brushes.DimGray, FontSize = 10, Margin = new Thickness(2) };
        private readonly ComboBox _bodyPick = new() { Width = 110 };
        private readonly Slider _yaw = new() { Minimum = 0, Maximum = 360, Value = 35, Width = 100 };
        private readonly List<ToggleButton> _modeBtns = new();
        private ToggleButton? _walkBtn;
        private DispatcherTimer? _timer;

        // ── sim state ──────────────────────────────────────────────────────
        /// <summary>What the strip selects. Auto cycles Idle → Hit → Death → Hold; a manual pick
        /// pins one phase.</summary>
        private enum UserMode { Auto, Idle, Hit, Walk, Death }
        /// <summary>What is actually running this tick.</summary>
        private enum Phase { Idle, Hit, Walk, Death, Hold }
        private UserMode _userMode = UserMode.Auto;
        private Phase _phase = Phase.Idle;
        private int _phaseFrames;

        private RagdollSim? _sim;
        private int _frame;
        private uint _seed = 0x1234;
        private float _floorZ;

        // per-body metrics, derived the way the registry's ComputeBodyMetrics does
        private float[] _loose = Array.Empty<float>();
        private float[] _hgt = Array.Empty<float>();
        private float _radius = 0.5f;
        /// <summary>Depth in the parent chain at (and past) which a part is fully loose — the
        /// registry's structural heuristic constant (LiveMotionRegistry.DepthFullLoose).</summary>
        private const int DepthFullLoose = 3;
        private const float AmplitudeMinYd = 0.004f;   // LiveMotionRegistry absolute clamp guards
        private const float AmplitudeMaxYd = 0.35f;
        private const float WriteEpsilonYd = 0.0008f;  // LiveMotionRegistry write epsilon

        // spring layer state (the real SpringMotion runs on these)
        private float[] _off = Array.Empty<float>();
        private float[] _vel = Array.Empty<float>();
        private float _pool;
        private long _poolDecayTick;
        private long _lastCritTick;
        private int _hitCountdown;          // frames to the next scripted hit
        private bool _nextHitCrit;
        private int _hitsFired;             // Auto stops after two, so the pool visibly drains
        private bool _springZeroed;         // one-shot clear when livemotion is switched off
        private float _hitAzimuth;

        // idle layer state (the real IdleMotion runs on these)
        private float[]? _idleVert, _idleSway;
        private float[] _idleOff = Array.Empty<float>();
        private float _idlePhase, _idleSwayPhase;

        // gait layer state (the real GaitMotion runs on these)
        private float[] _gaitOff = Array.Empty<float>();
        private float _gaitPhase;

        private double _fitScale;           // low-passed auto-fit so the frame doesn't pump

        // ── draw-path resources: allocated once, not per 30 Hz tick ────────
        private double[] _px = Array.Empty<double>();   // grow-only scratch, reused every Redraw
        private double[] _py = Array.Empty<double>();
        private double[] _pz = Array.Empty<double>();
        private FormattedText? _barLabel;
        private string _barLabelStr = "";
        private static Pen FrozenPen(Pen p) { p.Freeze(); return p; }
        private static Brush FrozenBrush(Brush b) { b.Freeze(); return b; }
        private static readonly Pen GroundPen = FrozenPen(new Pen(new SolidColorBrush(Color.FromRgb(210, 210, 210)), 1));
        private static readonly Brush ShadowBrush = FrozenBrush(new SolidColorBrush(Color.FromArgb(40, 0, 0, 0)));
        private static readonly Pen BonePen = FrozenPen(new Pen(new SolidColorBrush(Color.FromRgb(40, 60, 90)), 2.0));
        private static readonly Brush JointBrush = FrozenBrush(new SolidColorBrush(Color.FromRgb(70, 110, 170)));
        private static readonly Brush BarBackBrush = FrozenBrush(new SolidColorBrush(Color.FromRgb(232, 232, 232)));
        private static readonly Brush BarFillBrush = FrozenBrush(new SolidColorBrush(Color.FromRgb(214, 120, 60)));
        private static readonly Pen KneePen = FrozenPen(new Pen(Brushes.DimGray, 1));
        private static readonly Typeface BarTypeface = new("Segoe UI");

        public UIElement View => _root;

        public RagdollPreview() {
            LoadSkeletons();
            BuildView();
            // A resize while the timer is stopped must still refit the frame.
            _host.Resized = Redraw;
        }

        private void LoadSkeletons() {
            try {
                var asm = Assembly.GetExecutingAssembly();
                string? res = null;
                foreach (var n in asm.GetManifestResourceNames())
                    if (n.EndsWith("preview_skeletons.json", StringComparison.OrdinalIgnoreCase)) { res = n; break; }
                if (res == null) return;
                using var s = asm.GetManifestResourceStream(res)!;
                var f = JsonSerializer.Deserialize<SkelFile>(s);
                if (f?.bodies != null)
                    foreach (var b in f.bodies) {
                        if (ValidSkel(b)) _bodies.Add(b);
                        else _droppedBodies.Add(string.IsNullOrEmpty(b.name) ? "?" : b.name);
                    }
            }
            catch { /* no skeletons -> caption explains */ }
            if (_bodies.Count > 0) _body = _bodies[0];
        }

        private void BuildView() {
            _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            _root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            var bar = new WrapPanel { Margin = new Thickness(2) };
            foreach (var b in _bodies) _bodyPick.Items.Add(b.name);
            if (_bodyPick.Items.Count > 0) _bodyPick.SelectedIndex = 0;
            _bodyPick.SelectionChanged += (_, __) => {
                _body = _bodies.Count > 0 && _bodyPick.SelectedIndex >= 0 ? _bodies[_bodyPick.SelectedIndex] : null;
                OnBodyChanged();
            };
            bar.Children.Add(new TextBlock { Text = "Body ", VerticalAlignment = VerticalAlignment.Center });
            bar.Children.Add(_bodyPick);

            foreach (UserMode m in Enum.GetValues<UserMode>()) {
                var tb = new ToggleButton { Content = m.ToString(), Margin = new Thickness(m == UserMode.Auto ? 8 : 2, 0, 0, 0), Padding = new Thickness(6, 1, 6, 1), IsChecked = m == UserMode.Auto };
                UserMode mode = m;
                tb.Click += (_, __) => SelectMode(mode);
                if (m == UserMode.Walk) { _walkBtn = tb; ToolTipService.SetShowOnDisabled(tb, true); }
                _modeBtns.Add(tb);
                bar.Children.Add(tb);
            }

            bar.Children.Add(new TextBlock { Text = "  Spin ", VerticalAlignment = VerticalAlignment.Center });
            bar.Children.Add(_yaw);
            var replay = new Button { Content = "Replay", Margin = new Thickness(6, 0, 0, 0), Padding = new Thickness(6, 1, 6, 1), ToolTip = "Replay the death fall with the same seed" };
            replay.Click += (_, __) => EnterDeath(sameSeed: true);
            var newseed = new Button { Content = "New seed", Margin = new Thickness(4, 0, 0, 0), Padding = new Thickness(6, 1, 6, 1) };
            newseed.Click += (_, __) => { unchecked { _seed = _seed * 1664525u + 1013904223u; } EnterDeath(sameSeed: true); };
            bar.Children.Add(replay); bar.Children.Add(newseed);
            Grid.SetRow(bar, 0); _root.Children.Add(bar);

            Grid.SetRow(_host, 1); _root.Children.Add(_host);
            _caption.Text = _body == null
                ? "No baked skeleton found (preview_skeletons.json missing). Regenerate with tools/gen_preview_skeletons.py."
                : "Same math, canonical scene: hits/idle/gait run the plugin's own SpringMotion/IdleMotion/GaitMotion; the death fall is its own RagdollSim from a canonical death-beat pose. In-game they ride the retail animations and the creature's actual pose.";
            if (_droppedBodies.Count > 0)
                _caption.Text += "  Skipped malformed bake(s): " + string.Join(", ", _droppedBodies) +
                                 " — regenerate preview_skeletons.json.";
            Grid.SetRow(_caption, 2); _root.Children.Add(_caption);

            _yaw.ValueChanged += (_, __) => Redraw();
            OnBodyChanged();
        }

        private void SelectMode(UserMode m) {
            _userMode = m;
            for (int i = 0; i < _modeBtns.Count; i++) _modeBtns[i].IsChecked = (UserMode)i == m;
            switch (m) {
                case UserMode.Auto: EnterIdle(); break;
                case UserMode.Idle: EnterIdle(); break;
                case UserMode.Hit: EnterHit(); break;
                case UserMode.Walk: EnterWalk(); break;
                case UserMode.Death: EnterDeath(sameSeed: true); break;
            }
        }

        private void OnBodyChanged() {
            ComputeMetrics();
            bool demoted = UpdateWalkGate();
            if (!demoted) {
                if (_userMode == UserMode.Death || _userMode == UserMode.Auto) EnterDeath(sameSeed: true);
                else SelectMode(_userMode);
            }
            Redraw();
        }

        /// <summary>Gait targets ONE hard-coded rig (GaitMotion.TargetSetupDid, the Olthoi). The
        /// button lights up whenever the picked body is that rig. Returns true when this body
        /// change demoted a pinned Walk to Auto (which lands in Auto's idle phase, not a death).</summary>
        private bool UpdateWalkGate() {
            if (_walkBtn == null) return false;
            bool ok = _body != null && GaitMotion.Applies((uint)_body.setupDid, _body.n);
            bool anyGaitBody = false;
            foreach (var b in _bodies) if (GaitMotion.Applies((uint)b.setupDid, b.n)) { anyGaitBody = true; break; }
            _walkBtn.IsEnabled = ok;
            _walkBtn.ToolTip = ok ? "Procedural tripod gait (gait/gaitamp/gaitcadence)"
                : anyGaitBody
                    ? "Gait targets the Olthoi rig (setup 0x02000F95) — pick that body to walk"
                    : "Gait targets the Olthoi rig (setup 0x02000F95) — bake it into preview_skeletons.json first";
            if (!ok && _userMode == UserMode.Walk) { SelectMode(UserMode.Auto); return true; }
            return false;
        }

        /// <summary>Per-body metrics, derived exactly the way the registry's ComputeBodyMetrics
        /// does from a live pose — here from the baked rest pose: radius = max part distance from
        /// the part centroid; normalised heights from the pose z-span; looseness = authored array
        /// where the bake carries one, else the parent-chain-depth heuristic (ResolveLooseness).</summary>
        private void ComputeMetrics() {
            var b = _body;
            if (b == null || b.n <= 0) { _loose = _hgt = Array.Empty<float>(); return; }
            int n = b.n;

            float cx = 0f, cy = 0f, cz = 0f;
            for (int i = 0; i < n; i++) { cx += b.startPos[i * 3]; cy += b.startPos[i * 3 + 1]; cz += b.startPos[i * 3 + 2]; }
            float invN = 1f / n;
            cx *= invN; cy *= invN; cz *= invN;
            float r2 = 0f, minZ = float.MaxValue, maxZ = float.MinValue;
            for (int i = 0; i < n; i++) {
                float dx = b.startPos[i * 3] - cx, dy = b.startPos[i * 3 + 1] - cy, dz = b.startPos[i * 3 + 2] - cz;
                float d2 = dx * dx + dy * dy + dz * dz;
                if (d2 > r2) r2 = d2;
                float z = b.startPos[i * 3 + 2];
                if (z < minZ) minZ = z;
                if (z > maxZ) maxZ = z;
            }
            _radius = MathF.Sqrt(r2);
            if (!(_radius > 1e-4f)) _radius = 0.5f;

            _hgt = new float[n];
            float span = maxZ - minZ;
            if (span > 1e-4f) { float inv = 1f / span; for (int i = 0; i < n; i++) _hgt[i] = (b.startPos[i * 3 + 2] - minZ) * inv; }
            else for (int i = 0; i < n; i++) _hgt[i] = 0.5f;

            // looseness: authored where the bake ships it, structural depth heuristic otherwise
            _loose = new float[n];
            for (int i = 0; i < n; i++) {
                int depth = 0, cur = i;
                for (int step = 0; step < DepthFullLoose + 1; step++) {
                    uint par = cur < b.parent.Length ? b.parent[cur] : 0xFFFFFFFFu;
                    if (par == 0xFFFFFFFFu || par >= (uint)n || (int)par == cur) break;
                    cur = (int)par;
                    depth++;
                }
                _loose[i] = depth >= DepthFullLoose ? 1f : (float)depth / DepthFullLoose;
            }
            if (b.looseness != null) {
                int m = Math.Min(b.looseness.Length, n);
                for (int i = 0; i < m; i++) { float v = b.looseness[i]; if (v >= 0f) _loose[i] = v > 1f ? 1f : v; }
            }

            _floorZ = minZ;
            _off = new float[n * 3];
            _vel = new float[n * 3];
            _idleOff = new float[n * 3];
            _gaitOff = new float[n * 3];
            _pool = 0f;
            _poolDecayTick = Environment.TickCount64;
            _lastCritTick = 0;

            // Tier-0 roles from the bake (they drive RoleBreathWeight and the floater sway parts);
            // absent roles fall back to the looseness heuristic per part, exactly like the plugin.
            byte[]? roles = null;
            if (b.roles != null) {
                roles = new byte[n];
                for (int i = 0; i < n; i++) roles[i] = (byte)IdleMotion.ParseRole(b.roles[i]);
            }
            IdleMotion.Build(IdleMotion.ParseArchetype(b.archetype), roles, b.ground, _loose, n,
                             out _idleVert, out _idleSway);
            _idlePhase = IdleMotion.PhaseFor((uint)b.setupDid);
            _idleSwayPhase = 0f;
            _gaitPhase = 0f;
            _fitScale = 0;
        }

        /// <summary>The registry's per-frame amplitude clamp: ampfrac of the body's own radius,
        /// bounded by the compiled-in absolute guards (ClampFor).</summary>
        private float MaxOffset() {
            float clamp = K("ampfrac") * _radius;
            if (!(clamp > AmplitudeMinYd)) return AmplitudeMinYd;
            return clamp > AmplitudeMaxYd ? AmplitudeMaxYd : clamp;
        }

        private SpringMotion.Tuning Tuning() => new SpringMotion.Tuning(
            K("springk"), K("springdamp"), K("corestiffmul"), K("edgestiffmul"), K("coreimpulsefrac"),
            K("energyperdamagepercent"), K("impulsevelperenergy"), K("poolhalflife"), K("poolgainknee"),
            K("critmult"), (long)MathF.Round(K("critrefractoryms")), K("settledown"), K("heightbias"),
            K("attackattenuation"));

        /// <summary>The knobs whose edit means "replay the death with the same seed". Everything
        /// else live-applies per tick with no phase reset — the Ui re-pushes the WHOLE dict on every
        /// slider sample, so replaying on any change would freeze a mid-drag death at frame 0.</summary>
        private static readonly string[] DeathKnobNames = { "deathvariety", "deathvarietystrength", "deathorientgain" };
        private Dictionary<string, string> _prevKnobs = new();

        public void SetKnobs(IReadOnlyDictionary<string, string> raw) {
            var old = _prevKnobs;
            _knobs = raw ?? new Dictionary<string, string>();
            var copy = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var kv in _knobs) copy[kv.Key] = kv.Value;
            _prevKnobs = copy;
            PushDeathStatics();
            bool deathChanged = false;
            foreach (var k in DeathKnobNames) {
                old.TryGetValue(k, out string? a);
                _knobs.TryGetValue(k, out string? b);
                if (!string.Equals(a, b, StringComparison.Ordinal)) { deathChanged = true; break; }
            }
            if (deathChanged && (_phase == Phase.Death || _phase == Phase.Hold)) EnterDeath(sameSeed: true);
        }

        private void PushDeathStatics() {
            // Exactly the fields LiveMotionConfig.ReloadCore pushes (Sim/DeathVariety.cs) — the
            // Enabled gate included: Perturb is a no-op while it is false.
            DeathVariety.Enabled = KB("deathvariety");
            DeathVariety.Strength = K("deathvarietystrength");
            DeathVariety.OrientGain = K("deathorientgain");
        }

        private RagdollParams BaseParams() => RagdollParams.Default;

        // ── phase entries ──────────────────────────────────────────────────
        private void EnterIdle() { _phase = Phase.Idle; _phaseFrames = 0; _sim = null; ClearSpring(); Redraw(); }
        private void EnterHit() { _phase = Phase.Hit; _phaseFrames = 0; _sim = null; ClearSpring(); _hitCountdown = 10; _nextHitCrit = false; _hitsFired = 0; Redraw(); }
        private void EnterWalk() { _phase = Phase.Walk; _phaseFrames = 0; _sim = null; ClearSpring(); Redraw(); }

        private void ClearSpring() {
            Array.Clear(_off, 0, _off.Length);
            Array.Clear(_vel, 0, _vel.Length);
            Array.Clear(_idleOff, 0, _idleOff.Length);
            Array.Clear(_gaitOff, 0, _gaitOff.Length);
            _pool = 0f;
            _poolDecayTick = Environment.TickCount64;
        }

        private void EnterDeath(bool sameSeed) {
            if (_body == null || _body.n <= 0) { _sim = null; Redraw(); return; }
            PushDeathStatics();
            if (!sameSeed) unchecked { _seed = _seed * 1664525u + 1013904223u; }
            var quats = new Quat[_body.n];
            for (int i = 0; i < _body.n; i++)
                quats[i] = new Quat(_body.startQuats[i * 4], _body.startQuats[i * 4 + 1], _body.startQuats[i * 4 + 2], _body.startQuats[i * 4 + 3]);

            float direction = 0f;
            var basep = BaseParams();
            RagdollParams p;
            float orientCommit = 0f;
            if (KB("deathvariety")) {
                p = DeathVariety.Perturb(basep, _seed, ref direction, out orientCommit);
            } else { p = basep; }
            try {
                _sim = new RagdollSim(_body.parent, _body.startPos, quats, _seed, direction, _floorZ, p, orientCommit);
            }
            catch { _sim = null; }
            _frame = 0;
            _phase = Phase.Death;
            _phaseFrames = 0;
            Redraw();
        }

        public void Start() {
            if (_timer != null) return;
            _timer = new DispatcherTimer(DispatcherPriority.Render) { Interval = TimeSpan.FromSeconds(1.0 / 30.0) };
            _timer.Tick += Tick;
            _timer.Start();
        }

        public void Stop() {
            if (_timer == null) return;
            _timer.Stop(); _timer.Tick -= Tick; _timer = null;   // zero timers -> 0% CPU
        }

        private void Tick(object? s, EventArgs e) {
            const float dt = 1f / 30f;
            long now = Environment.TickCount64;
            _phaseFrames++;

            switch (_phase) {
                case Phase.Idle:
                    StepOverlays(now, dt, hits: false, walk: false);
                    if (_userMode == UserMode.Auto && _phaseFrames > 90) EnterHit();   // ~3 s
                    break;

                case Phase.Hit:
                    StepOverlays(now, dt, hits: true, walk: false);
                    // Auto: two hits (normal then crit) have landed by ~1.5 s; let the springs ring
                    // out and the pool drain visibly, then die.
                    if (_userMode == UserMode.Auto && _phaseFrames > 105) EnterDeath(sameSeed: false);
                    break;

                case Phase.Walk:
                    StepOverlays(now, dt, hits: false, walk: true);
                    break;

                case Phase.Death:
                    if (_sim != null && _frame < (_sim.FallFramesParam > 0 ? _sim.FallFramesParam : RagdollSim.FallFrames)) {
                        try { _sim.StepFrame(); } catch { }
                        _frame++;
                    } else { _phase = Phase.Hold; _phaseFrames = 0; }
                    break;

                case Phase.Hold:
                    if (_phaseFrames > 60) {   // ~2 s hold on the settled pose
                        if (_userMode == UserMode.Auto) { unchecked { _seed = _seed * 1664525u + 1013904223u; } EnterIdle(); }
                        else EnterDeath(sameSeed: false);
                    }
                    break;
            }
            Redraw();
        }

        /// <summary>One tick of the standing-pose layers, all through the shipped plugin code:
        /// SpringMotion decay/hits/integrate, IdleMotion breath, GaitMotion stepping.</summary>
        private void StepOverlays(long now, float dt, bool hits, bool walk) {
            if (_body == null) return;
            int n = _body.n;
            var t = Tuning();
            float maxOff = MaxOffset();
            float poolCap = K("poolcap");

            // livemotion is the hit layer's runtime master switch, exactly like the plugin's: with
            // it off no impulse lands and no spring integrates — the overlays below still run.
            if (KB("livemotion")) {
                _springZeroed = false;
                SpringMotion.DecayPool(ref _pool, ref _poolDecayTick, now, in t);

                // scripted hits: one normal at defaultdamagepercent, one crit; the direction walks
                // around the body so successive flinches read separately. Auto stops after the two
                // scripted hits so the pool-bar decay is visible before the death handoff.
                bool mayFire = hits && (_userMode != UserMode.Auto || _hitsFired < 2);
                if (mayFire && --_hitCountdown <= 0) {
                    _hitAzimuth += 2.399963f;   // golden angle
                    SpringMotion.ApplyHit(K("defaultdamagepercent"), _nextHitCrit, now, ref _lastCritTick,
                                          ref _pool, poolCap, ref _poolDecayTick,
                                          MathF.Cos(_hitAzimuth), MathF.Sin(_hitAzimuth), 1 /*Mid*/,
                                          _vel, _loose, _hgt, n, in t, out _);
                    _nextHitCrit = !_nextHitCrit;
                    _hitsFired++;
                    _hitCountdown = 18;         // ~0.6 s between hits
                }

                SpringMotion.Integrate(_off, _vel, _loose, n, dt, maxOff, in t);
            } else if (!_springZeroed) {
                Array.Clear(_off, 0, _off.Length);
                Array.Clear(_vel, 0, _vel.Length);
                _pool = 0f;
                _springZeroed = true;
            }

            bool idle = KB("idlemotion") && _idleVert != null;
            if (idle) {
                _idlePhase = IdleMotion.AdvancePhase(_idlePhase, K("idlehz"), dt);
                if (_idleSway != null)
                    _idleSwayPhase = IdleMotion.AdvancePhase(_idleSwayPhase, K("idlehz") * IdleMotion.SwayHzFrac, dt);
                float amp = K("idleamp") * _radius;
                if (!(amp > 0f)) amp = 0f;
                if (amp > maxOff) amp = maxOff;
                IdleMotion.Accumulate(_idleOff, n, _idleVert!, _idleSway, amp, maxOff, _idlePhase, _idleSwayPhase);
            } else Array.Clear(_idleOff, 0, _idleOff.Length);

            if (walk && KB("gait")) {   // the gait master switch, like the plugin's GaitActive
                float hz = GaitMotion.CadenceHz(K("gaitcadence"), 0f, speedValid: false);
                _gaitPhase = IdleMotion.AdvancePhase(_gaitPhase, hz, dt);
                float amp = K("gaitamp") * _radius;
                if (!(amp > 0f)) amp = 0f;
                if (amp > maxOff) amp = maxOff;
                GaitMotion.Accumulate(_gaitOff, n, amp, maxOff, _gaitPhase);
            } else Array.Clear(_gaitOff, 0, _gaitOff.Length);
        }

        // ── render: stick skeleton, turntable projection, +Z up ────────────
        private void Redraw() {
            var dc = _host.Open();
            try {
                bool laidOut = _host.ActualWidth >= 10 && _host.ActualHeight >= 10;
                double W = Math.Max(50, _host.ActualWidth), H = Math.Max(50, _host.ActualHeight);
                if (_body == null) { _host.Close(dc); return; }

                int n = _body.n;
                if (_px.Length < n) { _px = new double[n]; _py = new double[n]; _pz = new double[n]; }
                double[] px = _px, py = _py, pz = _pz;
                bool deathPose = _phase == Phase.Death || _phase == Phase.Hold;
                if (deathPose && _sim != null) {
                    for (int i = 0; i < n && i < _sim.PartCount; i++) { _sim.GetPos(i, out float x, out float y, out float z); px[i] = x; py[i] = y; pz[i] = z; }
                } else {
                    // standing pose + the live overlays, summed and clamped the plugin's way (one
                    // combine, translation only — WriteOffsets discipline)
                    var t = Tuning();
                    float gain = SpringMotion.VisualGain(_pool, K("poolcap"), attenuateAttack: false, in t);
                    float maxOff = MaxOffset();
                    for (int i = 0; i < n; i++) {
                        int b = i * 3;
                        float ix = _idleOff[b] + _gaitOff[b];
                        float iy = _idleOff[b + 1] + _gaitOff[b + 1];
                        float iz = _idleOff[b + 2] + _gaitOff[b + 2];
                        IdleMotion.Combine(_off[b], _off[b + 1], _off[b + 2], gain, ix, iy, iz, true,
                                           maxOff, WriteEpsilonYd, out float ox, out float oy, out float oz);
                        px[i] = _body.startPos[b] + ox;
                        py[i] = _body.startPos[b + 1] + oy;
                        pz[i] = _body.startPos[b + 2] + oz;
                    }
                }

                // auto-fit: center the pose bounds, anchor the floor, low-pass the scale
                double minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9, minz = 1e9, maxz = -1e9;
                for (int i = 0; i < n; i++) { minx = Math.Min(minx, px[i]); maxx = Math.Max(maxx, px[i]); miny = Math.Min(miny, py[i]); maxy = Math.Max(maxy, py[i]); minz = Math.Min(minz, pz[i]); maxz = Math.Max(maxz, pz[i]); }
                double cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
                double span = Math.Max(0.5, Math.Max(maxx - minx, Math.Max(maxy - miny, maxz - minz)));
                double groundY = H - 26;                       // room for the pool bar below
                double target = Math.Min(W * 0.84, H * 0.8) / span;
                double tallest = maxz - _floorZ;
                if (tallest > 1e-3) target = Math.Min(target, (groundY - 10) / (tallest * 1.06));
                // Never seed the low-pass from the pre-layout 50×50 fallback frame.
                if (laidOut) _fitScale = _fitScale <= 0 ? target : _fitScale + (target - _fitScale) * 0.2;
                double scale = laidOut && _fitScale > 0 ? _fitScale : target;
                double yaw = _yaw.Value * Math.PI / 180.0;
                double cosY = Math.Cos(yaw), sinY = Math.Sin(yaw);

                (double sx, double sy) Proj(double x, double y, double z) {
                    double rx = (x - cx) * cosY - (y - cy) * sinY;   // turntable about +Z
                    double sxp = W / 2 + rx * scale;
                    double syp = groundY - (z - _floorZ) * scale;    // +Z up
                    return (sxp, syp);
                }

                dc.DrawLine(GroundPen, new Point(W * 0.06, groundY), new Point(W * 0.94, groundY));

                for (int i = 0; i < n; i++) {
                    double rx = (px[i] - cx) * cosY - (py[i] - cy) * sinY;
                    dc.DrawEllipse(ShadowBrush, null, new Point(W / 2 + rx * scale, groundY), 3, 1.4);
                }
                for (int i = 0; i < n; i++) {
                    uint par = _body.parent[i];
                    if (par < n && par != i) {
                        var a = Proj(px[i], py[i], pz[i]); var b = Proj(px[par], py[par], pz[par]);
                        dc.DrawLine(BonePen, new Point(a.sx, a.sy), new Point(b.sx, b.sy));
                    }
                }
                for (int i = 0; i < n; i++) { var a = Proj(px[i], py[i], pz[i]); dc.DrawEllipse(JointBrush, null, new Point(a.sx, a.sy), 2.4, 2.4); }

                DrawPoolBar(dc, W, H);
            }
            finally { _host.Close(dc); }
        }

        /// <summary>The energy pool made visible: fill = Pool/PoolCap (the real decayed value), the
        /// tick = poolgainknee (where the smoothstep visual gain saturates). Live in every standing
        /// mode; the death fall does not use the pool.</summary>
        private void DrawPoolBar(DrawingContext dc, double W, double H) {
            if (_phase == Phase.Death || _phase == Phase.Hold) return;
            bool live = KB("livemotion");
            double x0 = W * 0.06, x1 = W * 0.94, y = H - 14, h = 7;
            double w = x1 - x0;
            dc.DrawRoundedRectangle(BarBackBrush, null, new Rect(x0, y, w, h), 2, 2);
            if (live) {
                float cap = K("poolcap");
                double frac = cap > 0f ? Math.Min(1.0, _pool / cap) : 0.0;
                if (frac > 0) dc.DrawRoundedRectangle(BarFillBrush, null, new Rect(x0, y, w * frac, h), 2, 2);
                // knee marker: pool at which the smoothstep gain reaches 1
                double kx = x0 + w * Math.Min(1.0, K("poolgainknee"));
                dc.DrawLine(KneePen, new Point(kx, y - 2), new Point(kx, y + h + 2));
            }
            string text = live ? "energy pool" : "livemotion off — hit springs disabled";
            if (_barLabel == null || _barLabelStr != text) {
                _barLabel = new FormattedText(text, CultureInfo.InvariantCulture, FlowDirection.LeftToRight,
                                              BarTypeface, 9, Brushes.Gray, 1.25);
                _barLabelStr = text;
            }
            dc.DrawText(_barLabel, new Point(x0, y - 12));
        }
    }

    /// <summary>A FrameworkElement hosting one DrawingVisual we redraw per tick.</summary>
    internal sealed class SkeletonHost : FrameworkElement {
        private readonly DrawingVisual _v = new();
        /// <summary>Raised after a layout size change, so the owner refits even while its
        /// animation timer is stopped.</summary>
        public Action? Resized;
        public SkeletonHost() { AddVisualChild(_v); AddLogicalChild(_v); ClipToBounds = true; MinHeight = 150; }
        protected override int VisualChildrenCount => 1;
        protected override Visual GetVisualChild(int index) => _v;
        public DrawingContext Open() => _v.RenderOpen();
        public void Close(DrawingContext dc) => dc.Close();
        protected override void OnRenderSizeChanged(SizeChangedInfo info) { base.OnRenderSizeChanged(info); Resized?.Invoke(); }
    }
}
