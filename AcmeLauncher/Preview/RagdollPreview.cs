using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using AcmeRagdoll.Sim;

namespace AcmeLauncher.Preview {
    /// <summary>
    /// Ragdoll knob preview. Runs the plugin's OWN physics (AcmeRagdoll/Sim/*.cs are compiled into
    /// this assembly unchanged — see AcmeLauncher.csproj), so the death fall is the same equations
    /// the plugin runs in-game. Skeletons are baked model-space death-beat poses
    /// (preview_skeletons.json, from tools/gen_preview_skeletons.py). Stick figure on one
    /// DrawingVisual, hand-rolled turntable projection (+Z up, per ragdoll_bake.py). 30 fps.
    ///
    /// DONE: death fall (real RagdollSim), death knobs (deathvariety/deathvarietystrength/
    /// deathorientgain via DeathVariety statics), idle bob (idleamp/idlehz), replay-same-seed,
    /// new-seed, yaw, body picker, honest caption, Start/Stop 0-CPU lifecycle.
    /// PARTIAL/REMAINING (needs the transcribed spring layer + GaitMotion wiring): the Hit and Walk
    /// modes and the energy-pool bar — see SpringMotionMirror note. The Death + Idle path is the
    /// visible heart of the feature and is fully live.
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
        }
        private sealed class SkelFile { public List<Skel> bodies { get; set; } = new(); }

        private readonly List<Skel> _bodies = new();
        private Skel? _body;
        private IReadOnlyDictionary<string, string> _knobs = new Dictionary<string, string>();

        // ── view ───────────────────────────────────────────────────────────
        private readonly Grid _root = new();
        private readonly SkeletonHost _host = new();
        private readonly TextBlock _caption = new() { TextWrapping = TextWrapping.Wrap, Foreground = Brushes.DimGray, FontSize = 10, Margin = new Thickness(2) };
        private readonly ComboBox _bodyPick = new() { Width = 110 };
        private readonly Slider _yaw = new() { Minimum = 0, Maximum = 360, Value = 35, Width = 120 };
        private DispatcherTimer? _timer;

        // ── sim state ──────────────────────────────────────────────────────
        private enum Mode { Idle, Death, Hold }
        private Mode _mode = Mode.Idle;
        private RagdollSim? _sim;
        private int _frame;
        private double _idlePhase;
        private uint _seed = 0x1234;
        private float _floorZ;

        public UIElement View => _root;

        public RagdollPreview() {
            LoadSkeletons();
            BuildView();
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
                if (f?.bodies != null) _bodies.AddRange(f.bodies);
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
            _bodyPick.SelectionChanged += (_, __) => { _body = _bodies.Count > 0 && _bodyPick.SelectedIndex >= 0 ? _bodies[_bodyPick.SelectedIndex] : null; StartDeath(sameSeed: true); };
            bar.Children.Add(new TextBlock { Text = "Body ", VerticalAlignment = VerticalAlignment.Center });
            bar.Children.Add(_bodyPick);
            bar.Children.Add(new TextBlock { Text = "  Spin ", VerticalAlignment = VerticalAlignment.Center });
            bar.Children.Add(_yaw);
            var replay = new Button { Content = "Replay", Margin = new Thickness(6, 0, 0, 0), Padding = new Thickness(6, 1, 6, 1) };
            replay.Click += (_, __) => StartDeath(sameSeed: true);
            var newseed = new Button { Content = "New seed", Margin = new Thickness(4, 0, 0, 0), Padding = new Thickness(6, 1, 6, 1) };
            newseed.Click += (_, __) => { unchecked { _seed = _seed * 1664525u + 1013904223u; } StartDeath(sameSeed: true); };
            bar.Children.Add(replay); bar.Children.Add(newseed);
            Grid.SetRow(bar, 0); _root.Children.Add(bar);

            Grid.SetRow(_host, 1); _root.Children.Add(_host);
            _caption.Text = _body == null
                ? "No baked skeleton found (preview_skeletons.json missing). Regenerate with tools/gen_preview_skeletons.py."
                : "Death fall = the plugin's own physics, from a canonical death-beat pose. In-game it seeds from the creature's actual pose; same equations.";
            Grid.SetRow(_caption, 2); _root.Children.Add(_caption);

            _yaw.ValueChanged += (_, __) => Redraw();
            StartDeath(sameSeed: true);
        }

        public void SetKnobs(IReadOnlyDictionary<string, string> raw) {
            _knobs = raw ?? new Dictionary<string, string>();
            PushDeathStatics();
            // A death-shaping knob changed → replay the SAME seed so the difference is the knob, not the dice.
            if (_mode != Mode.Idle) StartDeath(sameSeed: true);
        }

        private void PushDeathStatics() {
            // Exactly the fields LiveMotionConfig.ReloadCore pushes (AcmeRagdoll/Services + Sim/DeathVariety.cs).
            DeathVariety.Strength = KnobRead.F(_knobs, "deathvarietystrength", 0.6f);
            DeathVariety.OrientGain = KnobRead.F(_knobs, "deathorientgain", 1.4f);
        }

        private RagdollParams BaseParams() => RagdollParams.Default;

        private void StartDeath(bool sameSeed) {
            if (_body == null || _body.n <= 0) { _sim = null; Redraw(); return; }
            PushDeathStatics();
            if (!sameSeed) unchecked { _seed = _seed * 1664525u + 1013904223u; }
            // floor = lowest part Z in the start pose.
            _floorZ = float.MaxValue;
            for (int i = 0; i < _body.n; i++) _floorZ = Math.Min(_floorZ, _body.startPos[i * 3 + 2]);
            var quats = new Quat[_body.n];
            for (int i = 0; i < _body.n; i++)
                quats[i] = new Quat(_body.startQuats[i * 4], _body.startQuats[i * 4 + 1], _body.startQuats[i * 4 + 2], _body.startQuats[i * 4 + 3]);

            float direction = 0f;
            var basep = BaseParams();
            RagdollParams p;
            float orientCommit = 0f;
            if (KnobRead.B(_knobs, "deathvariety", true)) {
                p = DeathVariety.Perturb(basep, _seed, ref direction, out orientCommit);
            } else { p = basep; }
            try {
                _sim = new RagdollSim(_body.parent, _body.startPos, quats, _seed, direction, _floorZ, p, orientCommit);
            }
            catch { _sim = null; }
            _frame = 0;
            _mode = Mode.Death;
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
            _idlePhase += 1.0 / 30.0;
            switch (_mode) {
                case Mode.Death:
                    if (_sim != null && _frame < (_sim.FallFramesParam > 0 ? _sim.FallFramesParam : RagdollSim.FallFrames)) {
                        try { _sim.StepFrame(); } catch { }
                        _frame++;
                    } else { _mode = Mode.Hold; _holdFrames = 0; }
                    break;
                case Mode.Hold:
                    if (++_holdFrames > 60) StartDeath(sameSeed: false);   // ~2 s hold then a fresh death
                    break;
                case Mode.Idle:
                    break;
            }
            Redraw();
        }
        private int _holdFrames;

        // ── render: stick skeleton, turntable projection, +Z up ────────────
        private void Redraw() {
            var dc = _host.Open();
            try {
                double W = Math.Max(50, _host.ActualWidth), H = Math.Max(50, _host.ActualHeight);
                if (_body == null) { _host.Close(dc); return; }

                // gather part world positions from the sim (or the rest pose if no sim)
                int n = _body.n;
                var px = new double[n]; var py = new double[n]; var pz = new double[n];
                for (int i = 0; i < n; i++) {
                    if (_sim != null && i < _sim.PartCount) { _sim.GetPos(i, out float x, out float y, out float z); px[i] = x; py[i] = y; pz[i] = z; }
                    else { px[i] = _body.startPos[i * 3]; py[i] = _body.startPos[i * 3 + 1]; pz[i] = _body.startPos[i * 3 + 2]; }
                }
                // idle bob when standing (Idle/Hold at pose) — amplitude/rate from knobs.
                if (_mode != Mode.Death) {
                    float amp = KnobRead.F(_knobs, "idleamp", 0.02f);
                    float hz = KnobRead.F(_knobs, "idlehz", 0.6f);
                    double bob = Math.Sin(_idlePhase * hz * 2 * Math.PI) * amp;
                    for (int i = 0; i < n; i++) pz[i] += bob;
                }

                // model bounds for auto-fit
                double minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9, minz = 1e9, maxz = -1e9;
                for (int i = 0; i < n; i++) { minx = Math.Min(minx, px[i]); maxx = Math.Max(maxx, px[i]); miny = Math.Min(miny, py[i]); maxy = Math.Max(maxy, py[i]); minz = Math.Min(minz, pz[i]); maxz = Math.Max(maxz, pz[i]); }
                double cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
                double span = Math.Max(0.5, Math.Max(maxx - minx, Math.Max(maxy - miny, maxz - minz)));
                double scale = Math.Min(W, H) * 0.62 / span;
                double yaw = _yaw.Value * Math.PI / 180.0;
                double cosY = Math.Cos(yaw), sinY = Math.Sin(yaw);
                double groundY = H * 0.86;

                (double sx, double sy) Proj(double x, double y, double z) {
                    double rx = (x - cx) * cosY - (y - cy) * sinY;   // turntable about +Z
                    double sxp = W / 2 + rx * scale;
                    double syp = groundY - (z - _floorZ) * scale;    // +Z up
                    return (sxp, syp);
                }

                var ground = new Pen(new SolidColorBrush(Color.FromRgb(210, 210, 210)), 1);
                dc.DrawLine(ground, new Point(W * 0.08, groundY), new Point(W * 0.92, groundY));
                var shadow = new SolidColorBrush(Color.FromArgb(40, 0, 0, 0));
                var bone = new Pen(new SolidColorBrush(Color.FromRgb(40, 60, 90)), 2.0);
                var joint = new SolidColorBrush(Color.FromRgb(70, 110, 170));

                for (int i = 0; i < n; i++) {
                    var (gx, _) = Proj(px[i], py[i], _floorZ);
                    double rx = (px[i] - cx) * cosY - (py[i] - cy) * sinY;
                    dc.DrawEllipse(shadow, null, new Point(W / 2 + rx * scale, groundY), 3, 1.4);
                }
                for (int i = 0; i < n; i++) {
                    uint par = _body.parent[i];
                    if (par < n && par != i) {
                        var a = Proj(px[i], py[i], pz[i]); var b = Proj(px[par], py[par], pz[par]);
                        dc.DrawLine(bone, new Point(a.sx, a.sy), new Point(b.sx, b.sy));
                    }
                }
                for (int i = 0; i < n; i++) { var a = Proj(px[i], py[i], pz[i]); dc.DrawEllipse(joint, null, new Point(a.sx, a.sy), 2.4, 2.4); }
            }
            finally { _host.Close(dc); }
        }
    }

    /// <summary>A FrameworkElement hosting one DrawingVisual we redraw per tick.</summary>
    internal sealed class SkeletonHost : FrameworkElement {
        private readonly DrawingVisual _v = new();
        public SkeletonHost() { AddVisualChild(_v); AddLogicalChild(_v); ClipToBounds = true; MinHeight = 150; }
        protected override int VisualChildrenCount => 1;
        protected override Visual GetVisualChild(int index) => _v;
        public DrawingContext Open() => _v.RenderOpen();
        public void Close(DrawingContext dc) => dc.Close();
        protected override void OnRenderSizeChanged(SizeChangedInfo info) { base.OnRenderSizeChanged(info); }
    }
}
