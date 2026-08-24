using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using AcmeSky.Services.LiveSky;

namespace AcmeLauncher.Preview {
    /// <summary>
    /// Sky knob preview (design §3): a schematic sky panorama in a small WriteableBitmap —
    /// day/night gradient from the REAL <see cref="SkySunModel"/> (AcmeSky's shipped file, linked
    /// into this assembly unchanged), sun/moon discs, hashed stars faded by the real
    /// <see cref="SkySunModel.NightFraction"/>, and a thresholded value-noise cloud layer. The
    /// volumetric raymarch is deliberately NOT ported: its quality/perf knobs get an honest COST
    /// METER instead of fake visuals (§3.2.5).
    ///
    /// Mapping: x = heading 0→360° panorama, y = pitch 90° (top) → 0° (horizon), thin ground
    /// silhouette below. Sun at its model heading/pitch; discs at ×4 angular scale (a true 0.03 rad
    /// disc is ~2 px here) — labeled. Weather-class resolution transcribed from
    /// SkyConfig.ResolveWeatherClass (AcmeSky/Services/LiveSky/SkyConfig.cs:138-149); the preview
    /// has no client weather flag, so `auto` reads as fair (the caption says so).
    /// Noise: Hash01/SmoothNoise1 transcribed from AcmeLights/Services/LightManager.cs:161-172
    /// (the plugin file is welded to native pointers, so unlike SkySunModel it cannot be linked),
    /// extended to a 2-D lattice the obvious way.
    ///
    /// Perf: 240×135 back-buffer at ≤10 fps; the cloud field is computed on a half-res lattice and
    /// bilinearly upsampled. Freezes to a static frame after 60 s without interaction (knob edits
    /// still redraw once and re-arm); Stop() drops to zero timers.
    /// </summary>
    internal sealed class SkyPreview : IKnobPreview {
        private const int W = 240, H = 135;
        private const int HorizonY = 124;            // rows below = ground silhouette
        private const double FullDaySec = 90.0;      // scrubber auto-cycle: one 24-h loop / 90 s
        private const double FreezeAfterSec = 60.0;  // §3.2: idle >60 s -> static frame
        private const double Fps = 10.0;

        // ── knob access (Generated clamps, same pattern as RagdollPreview) ──
        private static readonly Dictionary<string, KnobDef> SkyKnobs = BuildSkyKnobs();
        private static Dictionary<string, KnobDef> BuildSkyKnobs() {
            var d = new Dictionary<string, KnobDef>(StringComparer.OrdinalIgnoreCase);
            foreach (var k in GeneratedKnobs.All) if (k.Cfg == "sky") d[k.Name] = k;
            return d;
        }
        private IReadOnlyDictionary<string, string> _knobs = new Dictionary<string, string>();
        private float K(string key) {
            SkyKnobs.TryGetValue(key, out var k);
            float v = KnobRead.F(_knobs, key, k?.DefaultF ?? 0f);
            if (k != null && k.HasRange) { if (v < k.MinF) v = k.MinF; else if (v > k.MaxF) v = k.MaxF; }
            return v;
        }
        private bool KB(string key) => K(key) >= 0.5f;
        private string KS(string key) {
            if (_knobs.TryGetValue(key, out var s)) return s.Trim().ToLowerInvariant();
            SkyKnobs.TryGetValue(key, out var k);
            return k?.Default ?? "";
        }

        // ── view ───────────────────────────────────────────────────────────
        private readonly DockPanel _root = new();
        private readonly Image _image = new() { Stretch = Stretch.Uniform, SnapsToDevicePixels = true };
        private readonly WriteableBitmap _bmp = new(W, H, 96, 96, PixelFormats.Bgr32, null);
        private readonly byte[] _px = new byte[W * H * 4];
        private readonly Slider _scrub = new() { Minimum = 0, Maximum = 1, Value = 0.35, SmallChange = 0.01, LargeChange = 0.1 };
        private readonly ToggleButton _cycle = new() { Content = "▶ cycle", IsChecked = true, Padding = new Thickness(6, 1, 6, 1), Margin = new Thickness(4, 0, 0, 0), ToolTip = "Slowly loop through the 24-hour day (one loop ≈ 90 s)." };
        private readonly TextBlock _timeLbl = new() { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(6, 0, 0, 0), FontSize = 11, Foreground = Brushes.Gray };
        private readonly Border _costFill = new() { Background = Brushes.SteelBlue, HorizontalAlignment = HorizontalAlignment.Left, Height = 8, Width = 0, CornerRadius = new CornerRadius(2) };
        private readonly TextBlock _costLbl = new() { FontSize = 11, Foreground = Brushes.DimGray, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(2, 1, 2, 0) };
        private readonly TextBlock _caption = new() { TextWrapping = TextWrapping.Wrap, Foreground = Brushes.DimGray, FontSize = 10, Margin = new Thickness(2) };
        private DispatcherTimer? _timer;
        private bool _running;                 // Start()ed by the host
        private DateTime _lastInteract = DateTime.UtcNow;
        private bool _scrubGuard;
        // Redraw coalescing: slider drags fire SetKnobs per mouse sample (60-125 Hz); rendering
        // inline per event on the UI thread stutters. Events only mark dirty; the 10 Hz timer
        // renders at most once per tick, and when the timer is dead (stopped/frozen) ONE deferred
        // redraw is queued via the dispatcher.
        private bool _dirty;
        private bool _deferredQueued;
        private bool _cloudKnobsDirty = true;  // forces a lattice refill on the next frame

        // ── star field: static hashed set (positions never change; only alpha does) ──
        private readonly struct Star { public readonly int X, Y; public readonly float Mag;
            public Star(int x, int y, float m) { X = x; Y = y; Mag = m; } }
        private static readonly Star[] Stars = BuildStars();
        private static Star[] BuildStars() {
            var s = new Star[150];
            for (int i = 0; i < s.Length; i++)
                s[i] = new Star((int)(Hash01(i * 3 + 1) * (W - 1)),
                                (int)(Hash01(i * 3 + 2) * (HorizonY - 8)),
                                0.35f + 0.65f * Hash01(i * 3 + 3));
            return s;
        }

        // half-res cloud density lattice, upsampled per pixel (perf: 4× fewer noise evals)
        private const int CW = W / 2 + 2, CH = HorizonY / 2 + 2;
        private readonly float[] _cloud = new float[CW * CH];
        private double _cloudScroll;
        private bool _lastFillTurb;
        private float _lastFillScroll = float.NaN;   // NaN: first frame always fills

        // 1024-entry gamma LUT: the output is 8-bit anyway, and the per-pixel MathF.Pow was the
        // hottest single cost of the frame (~1.4 ms of a ~3.3 ms render at this size).
        private static readonly byte[] GammaLut = BuildGammaLut();
        private static byte[] BuildGammaLut() {
            var l = new byte[1024];
            for (int i = 0; i < 1024; i++)
                l[i] = (byte)(255f * MathF.Pow(i / 1023f, 1f / 2.2f) + 0.5f);
            return l;
        }

        public UIElement View => _root;

        public SkyPreview() {
            _image.Source = _bmp;
            RenderOptions.SetBitmapScalingMode(_image, BitmapScalingMode.Linear);

            var timeRow = new DockPanel { Margin = new Thickness(2, 2, 2, 0) };
            DockPanel.SetDock(_cycle, Dock.Right);
            DockPanel.SetDock(_timeLbl, Dock.Right);
            timeRow.Children.Add(_cycle); timeRow.Children.Add(_timeLbl); timeRow.Children.Add(_scrub);
            var costRow = new Border { Background = Brushes.Gainsboro, CornerRadius = new CornerRadius(2), Height = 8, Margin = new Thickness(2, 4, 2, 0), Child = _costFill };

            DockPanel.SetDock(timeRow, Dock.Bottom);
            DockPanel.SetDock(_caption, Dock.Bottom);
            DockPanel.SetDock(_costLbl, Dock.Bottom);
            DockPanel.SetDock(costRow, Dock.Bottom);
            _root.Children.Add(timeRow);
            _root.Children.Add(_caption);
            _root.Children.Add(_costLbl);
            _root.Children.Add(costRow);
            _root.Children.Add(_image);

            _root.ToolTip = "Not previewed (diagnostic/plumbing knobs): live, testgradient, diag, axis, raymode, "
                          + "output, worldswizzle, lutflipv, wxmap, dump, campitch, cloudtaagamma, cloudtaaalpha — in-game only.";

            _scrub.ValueChanged += (_, __) => { if (!_scrubGuard) RequestRedraw(); };
            _cycle.Checked += (_, __) => { Touch(); ResumeIfRunning(); };
            _cycle.Unchecked += (_, __) => Touch();
            RequestRedraw();
        }

        private string _cls = "clear";   // weather class, resolved once per knob push (not per frame)

        public void SetKnobs(IReadOnlyDictionary<string, string> raw) {
            _knobs = raw ?? new Dictionary<string, string>();
            Touch();
            _cls = WeatherClass();
            UpdateCostMeter();
            // knob-dependent chrome, updated here so the 10 Hz frame loop stays allocation-lean
            bool forced = ForcedTime() >= 0f;
            _scrub.IsEnabled = !forced;
            _scrub.ToolTip = forced ? "Disabled: skytimeoverride/time forces the time of day."
                                    : "Time of day (the preview's stand-in for the game clock).";
            if (forced) { _scrubGuard = true; _scrub.Value = ForcedTime(); _scrubGuard = false; }
            _caption.Text = "Representative preview — real sun/night math (SkySunModel), schematic clouds. "
                          + "Discs ×4 scale. `auto` weather reads as fair here (no client). Volumetric quality knobs → cost meter below.";
            _cloudKnobsDirty = true;
            RequestRedraw();       // §3.2: a knob change redraws (coalesced) even when frozen…
        }                          // …and re-arms the animation if the host has us running

        public void Start() {
            _running = true;
            Touch();
            if (_timer != null) return;
            _timer = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromSeconds(1.0 / Fps) };
            _timer.Tick += Tick;
            _timer.Start();
        }

        public void Stop() {
            _running = false;
            KillTimer();           // zero timers -> 0% CPU; the bitmap keeps the last frame
        }

        private void KillTimer() { if (_timer == null) return; _timer.Stop(); _timer.Tick -= Tick; _timer = null; }
        private void Touch() => _lastInteract = DateTime.UtcNow;
        private void ResumeIfRunning() { if (_running && _timer == null) Start(); }

        /// <summary>Event-side entry: mark dirty, re-arm the freeze clock, revive the timer if the
        /// host has us running — and when the timer is dead (Stop()ed, or frozen with the host
        /// still on), queue exactly ONE deferred render instead of rendering inline per event.</summary>
        private void RequestRedraw() {
            _dirty = true;
            Touch();
            ResumeIfRunning();
            if (_timer != null) return;            // the next tick coalesces
            if (_deferredQueued) return;
            _deferredQueued = true;
            _root.Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => {
                _deferredQueued = false;
                if (_dirty) { _dirty = false; Redraw(); }
            }));
        }

        private void Tick(object? s, EventArgs e) {
            if ((DateTime.UtcNow - _lastInteract).TotalSeconds > FreezeAfterSec) {
                KillTimer();       // freeze-frame; SetKnobs/scrub revives (RequestRedraw)
                return;
            }
            if (_cycle.IsChecked == true && ForcedTime() < 0f) {
                _scrubGuard = true;
                _scrub.Value = (_scrub.Value + 1.0 / (FullDaySec * Fps)) % 1.0;
                _scrubGuard = false;
            }
            _cloudScroll += 1.0 / Fps;
            _dirty = false;        // this render covers any pending event-side request
            Redraw();
        }

        /// <summary>Forced time of day, &gt;= 0 when either alias forces it. CLOSE to the plugin, not
        /// identical: SkyConfig parses `skytimeoverride` and `time` onto ONE field where the LAST
        /// key in file order wins (SkyConfig.cs:283,297); the knob dict has no file order, so the
        /// preview's documented rule is `skytimeoverride` wins when &gt;= 0, else `time`. The scrubber
        /// is the preview's stand-in for the game clock, so `timeofs` shifts the SCRUBBER only
        /// (SkyConfig: "phase shift added to the CLOCK-derived time … not applied to forced
        /// time").</summary>
        private float ForcedTime() {
            float o = K("skytimeoverride");
            if (o >= 0f) return o;
            float t = K("time");
            return t >= 0f ? t : -1f;
        }

        private float EffectiveTime() {
            float forced = ForcedTime();
            if (forced >= 0f) return forced;
            float t = (float)_scrub.Value + K("timeofs");
            t %= 1f; if (t < 0f) t += 1f;
            return t;
        }

        /// <summary>SkyConfig.ResolveWeatherClass (lines 138-149) with clientWeatherFlag = false —
        /// the preview runs with no client, so `auto` is fair.</summary>
        private string WeatherClass() {
            string cls = KS("skyweatheroverride");
            int sp = cls.IndexOfAny(new[] { ' ', '\t' });   // plugin takes only the first token (SkyConfig.cs:288-289)
            if (sp > 0) cls = cls.Substring(0, sp);
            if (Array.IndexOf(SkyConfig_WeatherClasses, cls) >= 0) return cls;
            float storm = K("storm");
            if (storm > 0.5f) return "storm";
            if (storm >= -0.5f) return "clear";
            return "clear";   // clientWeatherFlag == false in the preview
        }
        private static readonly string[] SkyConfig_WeatherClasses = { "clear", "scattered", "broken", "overcast", "rain", "storm" };
        private static bool IsStormClass(string cls) => cls is "overcast" or "rain" or "storm";

        // ─────────────────────────── the frame ───────────────────────────
        private void Redraw() {
            float t = EffectiveTime();
            SkySunModel.SunHeadingPitch(t, out float sunHead, out float sunPitch);
            // elev01 recovered from the LINKED model's own output (pitch is elev01 scaled by the
            // day/night constants), so a future SkySunModel change cannot silently desync the palette.
            float elev01 = sunPitch >= 0f ? sunPitch / SkySunModel.NoonPitchDeg
                                          : sunPitch / SkySunModel.NightFloorDeg;
            float night = SkySunModel.NightFraction(sunPitch);
            string cls = _cls;
            bool storm = IsStormClass(cls);

            float exposure = K("exposure") / 5f;             // 5 = plugin default -> neutral
            bool cloudsOn = KB("clouds");
            float cover = storm ? K("cloudcoverstorm") : K("cloudcover");
            // scattered/broken/rain nudge coverage between the two authored anchors
            if (cls == "scattered") cover = MathF.Min(1f, cover * 0.6f);
            else if (cls == "broken") cover = MathF.Min(1f, cover * 1.35f);
            else if (cls == "rain") cover = MathF.Min(1f, MathF.Max(cover, 0.85f));
            bool turb = KB("cloudturb");
            float haze = KB("cloudhaze") ? (storm ? 1f : 0.45f) : 0f;
            float starGain = MathF.Min(1f, K("stars") * night);

            // per-row gradient (zenith->horizon), keyed off the sun elevation
            Span<float> rowR = stackalloc float[HorizonY + 1];
            Span<float> rowG = stackalloc float[HorizonY + 1];
            Span<float> rowB = stackalloc float[HorizonY + 1];
            PaletteFor(elev01, storm, out var zen, out var hor);
            for (int y = 0; y <= HorizonY; y++) {
                float f = (float)y / HorizonY;               // 0 zenith … 1 horizon
                f = f * f * (3f - 2f * f);
                rowR[y] = zen.r + (hor.r - zen.r) * f;
                rowG[y] = zen.g + (hor.g - zen.g) * f;
                rowB[y] = zen.b + (hor.b - zen.b) * f;
            }

            if (cloudsOn && cover > 0.001f &&
                (_cloudKnobsDirty || turb != _lastFillTurb || (float)_cloudScroll != _lastFillScroll)) {
                FillCloudLattice(turb, (float)_cloudScroll);   // skipped when nothing moved it
                _cloudKnobsDirty = false; _lastFillTurb = turb; _lastFillScroll = (float)_cloudScroll;
            }

            float dayness = 1f - night;
            // cloud litness: white by day, dark by night, grey under storm
            float cloudLum = (0.35f + 0.65f * dayness) * (storm ? 0.45f : 1f);
            float threshold = 1f - cover;                    // §3.2: cover 0 -> clear, 1 -> overcast

            byte[] px = _px;
            for (int y = 0; y < H; y++) {
                int row = y * W * 4;
                if (y > HorizonY) {                   // ground silhouette
                    byte g = (byte)(12 + 20 * dayness);
                    for (int x = 0; x < W; x++) { int o = row + x * 4; px[o] = g; px[o + 1] = g; px[o + 2] = (byte)(g * 0.9f); px[o + 3] = 255; }
                    continue;
                }
                float br = rowR[y], bg = rowG[y], bb = rowB[y];
                // horizon haze band: whitening that thickens toward the horizon
                float hazeF = haze * MathF.Pow((float)y / HorizonY, 3f) * (0.35f + 0.4f * dayness);
                for (int x = 0; x < W; x++) {
                    float r = br, g = bg, b = bb;
                    // clouds (bilinear from the half-res lattice)
                    if (cloudsOn && cover > 0.001f) {
                        float n = SampleCloud(x, y);
                        float d = SmoothStep(threshold, MathF.Min(1f, threshold + 0.25f), n);
                        if (d > 0f) {
                            float cr = cloudLum, cg = cloudLum, cb = cloudLum * (storm ? 1.05f : 1f);
                            float a = d * 0.92f;
                            r += (cr - r) * a; g += (cg - g) * a; b += (cb - b) * a;
                        }
                    }
                    if (hazeF > 0f) { r += (0.85f - r) * hazeF; g += (0.87f - g) * hazeF; b += (0.9f - b) * hazeF; }
                    // exposure + gamma -> 8-bit
                    r *= exposure; g *= exposure; b *= exposure;
                    int o = row + x * 4;
                    px[o + 2] = Gamma(r); px[o + 1] = Gamma(g); px[o] = Gamma(b); px[o + 3] = 255;
                }
            }
            // stars only where the cloud density is low (clouds occlude them honestly)
            if (starGain > 0.003f) {
                foreach (var st in Stars) {
                    if (cloudsOn && cover > 0.001f && SampleCloud(st.X, st.Y) > threshold) continue;
                    int o = st.Y * W * 4 + st.X * 4;
                    byte v = (byte)Math.Min(255f, 255f * st.Mag * starGain);
                    if (px[o + 2] < v) { px[o] = v; px[o + 1] = v; px[o + 2] = v; }
                }
            }
            // sun & moon discs (×4 angular scale — see the caption)
            float pxPerRad = W / (2f * MathF.PI);
            if (sunPitch > 0f)
                DrawDisc(px, sunHead, sunPitch, K("sunang") * 4f * pxPerRad,
                         1f, 0.97f, 0.88f, 0.55f + 0.45f * dayness, exposure);
            // moon: the plugin's own placement — opposite heading, negated pitch
            // (LiveSkyCompositor.cs:980, MoonDirAC = DirAc(headDeg+180, -pitchDeg)); running the
            // sun model at t+0.5 instead would re-apply the asymmetric night floor and hoist the
            // midnight moon to ~67° instead of ~14°.
            float moonHead = sunHead + 180f, moonPitch = -sunPitch;
            if (moonPitch > 0f) {
                float moonB = MathF.Min(1f, 0.28f * K("lunar")) * (0.35f + 0.65f * night);
                DrawDisc(px, moonHead, moonPitch, K("moonang") * 4f * pxPerRad,
                         0.92f, 0.94f, 1f, moonB, exposure);
            }
            _bmp.WritePixels(new Int32Rect(0, 0, W, H), _px, W * 4, 0);

            int hh = (int)(t * 24f), mm = (int)(t * 1440f) % 60;
            if (hh != _lastLblHh || mm != _lastLblMm || cls != _lastLblCls) {
                _lastLblHh = hh; _lastLblMm = mm; _lastLblCls = cls;
                _timeLbl.Text = $"{hh:00}:{mm:00}  {cls}";   // only when the display actually changes
            }
        }
        private int _lastLblHh = -1, _lastLblMm = -1;
        private string? _lastLblCls;

        private static byte Gamma(float v) {
            if (v <= 0f) return 0;
            if (v >= 1f) return 255;
            return GammaLut[(int)(v * 1023f)];
        }

        private static float SmoothStep(float a, float b, float x) {
            if (x <= a) return 0f; if (x >= b) return 1f;
            float u = (x - a) / (b - a);
            return u * u * (3f - 2f * u);
        }

        /// <summary>Palette anchors (zenith, horizon) keyed on sun elevation01: night → dusk →
        /// golden → noon, linearly blended; storm desaturates + darkens.</summary>
        private static void PaletteFor(float elev01, bool storm,
                                       out (float r, float g, float b) zen, out (float r, float g, float b) hor) {
            (float, float, float) zN = (0.015f, 0.025f, 0.07f), hN = (0.04f, 0.055f, 0.12f);     // night
            (float, float, float) zD = (0.12f, 0.14f, 0.28f), hD = (0.95f, 0.48f, 0.28f);        // dusk/dawn
            (float, float, float) zG = (0.30f, 0.48f, 0.75f), hG = (1.00f, 0.72f, 0.45f);        // golden
            (float, float, float) zM = (0.28f, 0.52f, 0.88f), hM = (0.68f, 0.82f, 0.94f);        // noon
            (float, float, float) z, h;
            if (elev01 <= -0.12f) { z = zN; h = hN; }
            else if (elev01 <= 0.04f) { float f = (elev01 + 0.12f) / 0.16f; z = Lerp3(zN, zD, f); h = Lerp3(hN, hD, f); }
            else if (elev01 <= 0.30f) { float f = (elev01 - 0.04f) / 0.26f; z = Lerp3(zD, zG, f); h = Lerp3(hD, hG, f); }
            else { float f = MathF.Min(1f, (elev01 - 0.30f) / 0.45f); z = Lerp3(zG, zM, f); h = Lerp3(hG, hM, f); }
            if (storm) { z = Storm3(z); h = Storm3(h); }
            zen = z; hor = h;
        }
        private static (float, float, float) Lerp3((float r, float g, float b) a, (float r, float g, float b) b2, float f) =>
            (a.r + (b2.r - a.r) * f, a.g + (b2.g - a.g) * f, a.b + (b2.b - a.b) * f);
        private static (float, float, float) Storm3((float r, float g, float b) c) {
            float lum = 0.3f * c.r + 0.5f * c.g + 0.2f * c.b;
            return (0.55f * (c.r + (lum - c.r) * 0.7f), 0.55f * (c.g + (lum - c.g) * 0.7f), 0.6f * (c.b + (lum - c.b) * 0.7f));
        }

        private void DrawDisc(byte[] px, float headDeg, float pitchDeg, float rPx,
                                     float cr, float cg, float cb, float bright, float exposure) {
            if (rPx < 1f) rPx = 1f;
            float cx = headDeg / 360f * W; if (cx >= W) cx -= W;
            float cy = (1f - pitchDeg / 90f) * HorizonY;
            int x0 = (int)MathF.Floor(cx - rPx - 1), x1 = (int)MathF.Ceiling(cx + rPx + 1);
            int y0 = Math.Max(0, (int)MathF.Floor(cy - rPx - 1)), y1 = Math.Min(HorizonY, (int)MathF.Ceiling(cy + rPx + 1));
            for (int y = y0; y <= y1; y++)
                for (int xw = x0; xw <= x1; xw++) {
                    int x = xw; if (x < 0) x += W; else if (x >= W) x -= W;   // panorama wrap
                    float dx = xw - cx, dy = y - cy;
                    float d = MathF.Sqrt(dx * dx + dy * dy);
                    float a = (1f - SmoothStep(rPx * 0.75f, rPx, d)) * bright;
                    if (a <= 0.004f) continue;
                    int o = y * W * 4 + x * 4;
                    AddCh(ref px[o + 2], cr * a * exposure); AddCh(ref px[o + 1], cg * a * exposure); AddCh(ref px[o], cb * a * exposure);
                }
        }
        private static void AddCh(ref byte ch, float add) {
            int v = ch + Gamma(add);
            ch = (byte)Math.Min(255, v);
        }

        // ── clouds: half-res value-noise lattice, scrolled + optionally domain-warped ──
        private void FillCloudLattice(bool turb, float scroll) {
            const float freq = 3.2f;
            float sx = scroll * 0.06f;
            for (int j = 0; j < CH; j++) {
                // squash v toward the horizon for a cheap perspective read
                float v = (float)(j * 2) / HorizonY;
                float vy = v * freq * (0.55f + 0.45f * v);
                for (int i = 0; i < CW; i++) {
                    float u = (float)(i * 2) / W * freq * 2f + sx;
                    float x = u, y2 = vy;
                    if (turb) {   // one domain-warp octave: visibly curlier edges (§3.2.4)
                        x += (Noise2(u * 0.9f + 11.3f + sx * 0.5f, vy * 0.9f) - 0.5f) * 0.9f;
                        y2 += (Noise2(u * 0.9f + 27.1f, vy * 0.9f - sx * 0.3f) - 0.5f) * 0.9f;
                    }
                    float n = Noise2(x, y2) * 0.55f
                            + Noise2(x * 2.13f + 7.3f, y2 * 2.13f + 1.7f) * 0.30f
                            + Noise2(x * 4.31f + 3.1f, y2 * 4.31f + 9.2f) * 0.15f;
                    _cloud[j * CW + i] = n;
                }
            }
        }
        private float SampleCloud(int x, int y) {
            float fx = x * 0.5f, fy = y * 0.5f;
            int i = (int)fx, j = (int)fy;
            if (i >= CW - 1) i = CW - 2;
            if (j >= CH - 1) j = CH - 2;
            float u = fx - i, v = fy - j;
            float a = _cloud[j * CW + i], b = _cloud[j * CW + i + 1];
            float c = _cloud[(j + 1) * CW + i], d = _cloud[(j + 1) * CW + i + 1];
            return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
        }

        // value-noise transcribed from AcmeLights/Services/LightManager.cs:161-172 (Hash01 +
        // SmoothNoise1's smooth lattice interpolation), extended to a 2-D lattice (i + j*57).
        private static float Noise2(float x, float y) {
            int i = (int)MathF.Floor(x), j = (int)MathF.Floor(y);
            float fx = x - i, fy = y - j;
            float u = fx * fx * (3f - 2f * fx), v = fy * fy * (3f - 2f * fy);
            float h00 = Hash01(i + j * 57), h10 = Hash01(i + 1 + j * 57);
            float h01 = Hash01(i + (j + 1) * 57), h11 = Hash01(i + 1 + (j + 1) * 57);
            float t0 = h00 + (h10 - h00) * u, t1 = h01 + (h11 - h01) * u;
            return t0 + (t1 - t0) * v;
        }
        private static float Hash01(int n) {
            uint h = (uint)n * 2654435761u;
            h ^= h >> 15; h *= 2246822519u; h ^= h >> 13;
            return (h & 0xFFFFFF) / (float)0x1000000;
        }

        // ── cost meter (§3.2.5): quality knobs change GPU cost, which a 2-D sketch cannot
        // honestly depict — so it is stated as cost, not faked as visuals. ──
        private void UpdateCostMeter() {
            float res = K("cloudres"), iters = K("clouditers"), minstep = MathF.Max(1f, K("cloudminstep"));
            float sun = K("cloudsunsteps"), ground = K("cloudgroundsteps");
            float cost = res * res * (iters / minstep) * (1f + sun + ground);
            const float defCost = 1f * 1f * (500f / 10f) * (1f + 2f + 3f);   // knob defaults
            float rel = defCost > 0f ? cost / defCost : 0f;
            // log-ish fill so the 0.01×..10× range reads; full bar at ~4× default
            double frac = Math.Clamp(Math.Log10(Math.Max(0.01, rel)) / Math.Log10(4.0) * 0.5 + 0.5, 0, 1);
            _costFill.Width = Math.Max(2, frac * 200);
            string extras = (KB("cloudaccurate") ? " +accurate-light" : "") + (KB("cloudtaa") ? " +TAA" : "");
            _costLbl.Text = $"relative GPU cost ≈ {rel:0.0#}× default{extras} — higher = smoother clouds, more GPU (in-game only)";
        }
    }
}
