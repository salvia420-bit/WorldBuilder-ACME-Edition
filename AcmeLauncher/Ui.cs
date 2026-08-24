using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;

namespace AcmeLauncher {
    /// <summary>
    /// The four-tab window, built entirely in code (no XAML — see the csproj note).
    /// Tab order is deliberate: Plugins (daily) · Tune · Fix · Install (once). The tool
    /// does no login and never launches the game — it manages the ACME plugin layer on
    /// clients the player launched themselves, and tunes the plugin cfgs.
    /// Every action delegates to <see cref="Backbone"/> or a file read/write; the
    /// window holds no injection or enumeration logic of its own.
    /// </summary>
    internal static class Ui {
        private static readonly Brush Grey = Brushes.Gray, Green = Brushes.LimeGreen, Amber = Brushes.Orange, Red = Brushes.Red;

        public static Window Build(Settings settings, Backbone back) {
            var win = new Window {
                Title = "z-z patcher",
                // §1.1 rule 5: the Tune preview pane persists expanded/collapsed and wants ~1080 wide.
                Width = settings.PreviewExpanded ? 1080 : 720, Height = 560,
                WindowStartupLocation = WindowStartupLocation.CenterScreen,
            };
            var tabs = new TabControl { Margin = new Thickness(6) };
            tabs.Items.Add(new TabItem { Header = "Plugins", Content = BuildPlugins(settings, back) });
            tabs.Items.Add(new TabItem { Header = "Tune",    Content = BuildTune(settings) });
            tabs.Items.Add(new TabItem { Header = "Fix",     Content = BuildFix(settings, back) });
            tabs.Items.Add(new TabItem { Header = "Install", Content = BuildInstall(settings, back) });
            win.Content = tabs;
            return win;
        }

        // ────────────────────────────── PLUGINS ─────────────────────────────
        private static UIElement BuildPlugins(Settings s, Backbone back) {
            var root = new DockPanel { Margin = new Thickness(8) };

            var intro = new TextBlock {
                Text = "Launch Asheron's Call the way you always do (ThwargLauncher, a shortcut, etc). "
                     + "This tool adds the ACME plugins to a client that's ALREADY running — pick it below and click Enable. "
                     + "It never logs in or launches the game itself.",
                TextWrapping = TextWrapping.Wrap, Margin = new Thickness(2, 0, 2, 8), Foreground = Brushes.DimGray
            };
            DockPanel.SetDock(intro, Dock.Top); root.Children.Add(intro);

            var avail = BuildAvailablePlugins(s);
            DockPanel.SetDock(avail, Dock.Top); root.Children.Add(avail);

            var actions = new WrapPanel { Margin = new Thickness(0, 0, 0, 6) };
            var status = new TextBlock { Margin = new Thickness(2, 4, 2, 4), TextWrapping = TextWrapping.Wrap };
            var list = new StackPanel();
            int selectedPid = 0;
            bool selectedIsPlain = false;
            bool refreshing = false;
            Button btnEnable = null!, btnEnableAll = null!;

            async Task Do(string label, Func<Backbone.RunResult> act) {
                status.Text = label + "…";
                foreach (var b in actions.Children) if (b is Button bb) bb.IsEnabled = false;
                var r = await Task.Run(act);
                foreach (var b in actions.Children) if (b is Button bb) bb.IsEnabled = true;
                status.Text = (r.Ran ? $"[{r.ExitCode}] " : "[failed] ") + r.Message.Trim();
                Refresh();
            }

            btnEnable = Btn("Enable plugins on selected", async (_, __) => {
                if (selectedPid == 0) { status.Text = "Click a running client in the list first."; return; }
                await Do($"Enabling plugins on {selectedPid}", () => back.AttachPid(selectedPid));
            });
            btnEnable.ToolTip = "Injects the ACME plugins into the client you launched (the one selected below).";
            btnEnableAll = Btn("Enable on all", async (_, __) => await Do("Enabling plugins on all clients", () => back.AttachAll()));
            btnEnableAll.ToolTip = "Injects the ACME plugins into every running client that doesn't already have them.";
            actions.Children.Add(btnEnable);
            actions.Children.Add(btnEnableAll);
            actions.Children.Add(Btn("Refresh", (_, __) => Refresh()));
            DockPanel.SetDock(actions, Dock.Top); root.Children.Add(actions);
            DockPanel.SetDock(status, Dock.Top); root.Children.Add(status);

            var lh = new TextBlock { Text = "Running clients (click one to select):", FontWeight = FontWeights.Bold, Margin = new Thickness(2) };
            DockPanel.SetDock(lh, Dock.Top); root.Children.Add(lh);
            root.Children.Add(new ScrollViewer { Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });

            void SyncButtons() { btnEnable.IsEnabled = selectedPid != 0 && selectedIsPlain; }

            async void Refresh() {
                if (refreshing) return;
                refreshing = true;
                try {
                    var gathered = await Task.Run(() => {
                        var cs = back.ListClients();
                        var err = back.LastListError;
                        var rows = new List<(Backbone.Client c, Status.Health h)>();
                        foreach (var c in cs) rows.Add((c, Status.Read(s, c.Pid, c.Injected)));
                        return (rows, err);
                    });
                    list.Children.Clear();
                    selectedIsPlain = false;
                    if (gathered.rows.Count == 0) {
                        list.Children.Add(new TextBlock { Text = gathered.err ?? "  (no clients running — start Asheron's Call first)", Foreground = Brushes.DimGray, Margin = new Thickness(2) });
                        SyncButtons();
                        return;
                    }
                    foreach (var (c, h) in gathered.rows) {
                        if (c.Pid == selectedPid) selectedIsPlain = c.Injected == false;
                        var row = new Border { Padding = new Thickness(4), Margin = new Thickness(1), Background = c.Pid == selectedPid ? Brushes.WhiteSmoke : Brushes.Transparent };
                        var dp = new DockPanel();
                        var dot = MakeDot(h.Light);
                        DockPanel.SetDock(dot, Dock.Left); dp.Children.Add(dot);
                        var title = string.IsNullOrEmpty(c.WindowTitle) ? "(no window)" : c.WindowTitle;
                        dp.Children.Add(new TextBlock { Text = $"pid {c.Pid}  {title}  —  {h.Summary}", Margin = new Thickness(6, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center });
                        row.Child = dp;
                        int pid = c.Pid;
                        row.MouseLeftButtonUp += (_, __) => { selectedPid = pid; Refresh(); };
                        list.Children.Add(row);
                    }
                    SyncButtons();
                }
                finally { refreshing = false; }
            }

            var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
            timer.Tick += (_, __) => Refresh();
            root.Loaded += (_, __) => { Refresh(); timer.Start(); };
            root.Unloaded += (_, __) => timer.Stop();
            return root;
        }

        /// <summary>The "Available Plugins" box: each plugin with an enabled checkbox (ticking moves
        /// its folder between plugins\ and plugins-disabled\), plus Install / Uninstall. Rebuilds
        /// itself after any change.</summary>
        private static UIElement BuildAvailablePlugins(Settings s) {
            var box = new GroupBox { Header = "Available plugins", Margin = new Thickness(0, 0, 0, 6) };
            var outer = new StackPanel();
            box.Content = outer;

            void Rebuild() {
                outer.Children.Clear();
                var dir = string.IsNullOrEmpty(s.ChoriziteDir) ? @"C:\Games\Chorizite" : s.ChoriziteDir!;
                if (!Directory.Exists(dir)) {
                    outer.Children.Add(new TextBlock { Text = "Plugin runtime folder not found — set it on the Install tab.", Foreground = Brushes.DimGray, Margin = new Thickness(2) });
                    return;
                }
                var plugins = PluginMgmt.Enumerate(dir);
                var listPanel = new StackPanel();
                if (plugins.Count == 0) {
                    listPanel.Children.Add(new TextBlock { Text = "No plugins installed yet.", Foreground = Brushes.DimGray, Margin = new Thickness(2) });
                }
                foreach (var p in plugins) {
                    var cap = p;   // capture
                    var cb = new CheckBox {
                        Content = $"{p.Name}" + (p.Enabled ? "" : "  (disabled)") + (p.HasManifest ? "" : "  (no manifest.json — won't load)"),
                        IsChecked = p.Enabled, Margin = new Thickness(2, 1, 2, 1),
                        ToolTip = $"Folder: {p.Folder}. Checked = loaded on next injection; unchecked = held aside. Takes effect the next time you enable plugins on a client (already-running clients keep what they loaded)."
                    };
                    cb.Click += (_, __) => {
                        bool want = cb.IsChecked == true;
                        if (!want && PluginMgmt.IsCrashProtection(cap)) {
                            // Shared wording with the CLI's --disable-plugin stderr warning.
                            if (MessageBox.Show(Actions.LightsDisableWarning + "\n\nDisable anyway?",
                                "Disable crash protection?", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) {
                                cb.IsChecked = true; return;
                            }
                        }
                        try { PluginMgmt.SetEnabled(dir, cap.Folder, want); }
                        catch (Exception ex) { MessageBox.Show(ex.Message, "Couldn't change plugin", MessageBoxButton.OK, MessageBoxImage.Error); }
                        Rebuild();
                    };
                    listPanel.Children.Add(cb);
                }
                outer.Children.Add(listPanel);

                var btns = new WrapPanel { Margin = new Thickness(0, 4, 0, 0) };
                var selName = new ComboBox { Width = 160, Margin = new Thickness(2), IsEditable = false };
                foreach (var p in plugins) selName.Items.Add(p.Folder);
                if (selName.Items.Count > 0) selName.SelectedIndex = 0;
                btns.Children.Add(Btn("Install plugin…", (_, __) => {
                    var dlg = new Microsoft.Win32.OpenFileDialog { Title = "Pick a plugin .zip (or its manifest.json)", Filter = "Plugin zip or manifest|*.zip;manifest.json|all|*.*" };
                    if (dlg.ShowDialog() != true) return;
                    var src = dlg.FileName;
                    if (Path.GetFileName(src).Equals("manifest.json", StringComparison.OrdinalIgnoreCase)) src = Path.GetDirectoryName(src)!;   // folder-install: pick its manifest
                    try { var name = PluginMgmt.Install(dir, src); MessageBox.Show($"Installed '{name}'. Enable plugins on a client to load it.", "Installed"); }
                    catch (Exception ex) { MessageBox.Show(ex.Message, "Install failed", MessageBoxButton.OK, MessageBoxImage.Error); }
                    Rebuild();
                }));
                btns.Children.Add(new TextBlock { Text = "  Uninstall:", VerticalAlignment = VerticalAlignment.Center });
                btns.Children.Add(selName);
                btns.Children.Add(Btn("Uninstall", (_, __) => {
                    if (selName.SelectedItem is not string folder) return;
                    if (folder.Equals("AcmeLights", StringComparison.OrdinalIgnoreCase) &&
                        MessageBox.Show(Actions.LightsUninstallWarning + " Uninstall anyway?",
                            "Remove crash protection?", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
                    if (MessageBox.Show($"Delete the plugin folder '{folder}'? This removes it from disk.", "Uninstall", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
                    try { PluginMgmt.Uninstall(dir, folder); }
                    catch (Exception ex) { MessageBox.Show(ex.Message, "Uninstall failed", MessageBoxButton.OK, MessageBoxImage.Error); }
                    Rebuild();
                }));
                outer.Children.Add(btns);
            }
            Rebuild();
            return box;
        }

        // ─────────────────────────────── TUNE ───────────────────────────────
        private static UIElement BuildTune(Settings s) {
            var root = new DockPanel { Margin = new Thickness(8) };

            string[] cfgNames = { "lights", "sky", "ragdoll" };
            var cfgPath = new Dictionary<string, string>();
            var current = new Dictionary<string, Dictionary<string, string>>();

            string CurRaw(KnobDef k) => current[k.Cfg].TryGetValue(k.Name, out var v) ? v : k.Default;
            // RE-RESOLVE the write path on every reload, not just at window build: the CLI
            // is a co-resident writer now, and a higher-priority candidate file
            // (C:\Temp\acdt\*, skyaxis.txt) appearing while the window is open must not
            // leave the sliders writing a different file than Actions.* does.
            void ReloadCurrent() { foreach (var c in cfgNames) { cfgPath[c] = Cfgs.ResolvePath(c, forWrite: true); current[c] = Cfgs.Read(cfgPath[c]); } }
            ReloadCurrent();
            // The shared preview pane (design §1.1): one host beside the knob list, auto-following
            // the cfg being tuned. Every knob edit funnels through WriteAndCache -> the host.
            var host = new AcmeLauncher.Preview.PreviewHost(s);
            void WriteAndCache(KnobDef k, string val) { Cfgs.WriteKnob(cfgPath[k.Cfg], k.Name, val); current[k.Cfg][k.Name] = val; host.OnKnobTouched(k.Cfg, current[k.Cfg]); }
            var resync = new List<Action>();
            void ResyncAll() { ReloadCurrent(); foreach (var a in resync) a(); foreach (var c in cfgNames) host.Push(c, current[c]); }

            var info = new TextBlock { Text = $"{Cfgs.All.Count} variables, split by the config file that holds them. Edits apply live (~1s). \"Default\" is each plugin's built-in value.", TextWrapping = TextWrapping.Wrap, Foreground = Brushes.DimGray, Margin = new Thickness(2) };
            DockPanel.SetDock(info, Dock.Top); root.Children.Add(info);

            // Global actions (span all three cfgs): recommended profile + profile save/load.
            var buttons = new WrapPanel { Margin = new Thickness(0, 2, 0, 6) };
            // Global actions delegate to Actions.* — the SAME implementations the headless
            // CLI runs (--recommended / --save-profile / --load-profile), so GUI and CLI
            // cannot drift; the GUI's extra job is only dialogs + ResyncAll.
            buttons.Children.Add(Btn("Load Recommended", (_, __) => {
                Actions.LoadRecommended();
                ResyncAll();
            }));
            buttons.Children.Add(Btn("Save profile…", (_, __) => {
                var dlg = new Microsoft.Win32.SaveFileDialog { Filter = "zzpatcher profile|*.zzp", FileName = "profile.zzp" };
                if (dlg.ShowDialog() == true) {
                    try { Actions.SaveProfile(dlg.FileName); }
                    catch (Exception ex) { MessageBox.Show(ex.Message); }
                }
            }));
            buttons.Children.Add(Btn("Load profile…", (_, __) => {
                var dlg = new Microsoft.Win32.OpenFileDialog { Filter = "zzpatcher profile|*.zzp|all|*.*" };
                if (dlg.ShowDialog() == true) {
                    try {
                        var warns = new List<string>();
                        var (applied, skipped) = Actions.LoadProfile(dlg.FileName, warns.Add);
                        if (skipped > 0) MessageBox.Show($"Applied {applied}, skipped {skipped}:\n" + string.Join("\n", warns), "Profile loaded with skips");
                    }
                    catch (Exception ex) { MessageBox.Show(ex.Message); }
                    ResyncAll();
                }
            }));
            DockPanel.SetDock(buttons, Dock.Top); root.Children.Add(buttons);

            // Build one knob row (shared by all three cfg views); registers its reread in `resync`.
            (FrameworkElement grid, string hay) BuildRow(KnobDef k) {
                var g = new Grid { Margin = new Thickness(2, 1, 2, 1) };
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(170) });
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(110) });
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(52) });
                var name = new TextBlock { Text = k.Name, VerticalAlignment = VerticalAlignment.Center, ToolTip = k.Desc.Length > 0 ? k.Desc : null };
                Grid.SetColumn(name, 0); g.Children.Add(name);

                Action reread;
                if (k.Type == KnobType.Toggle) {
                    var cb = new CheckBox { VerticalAlignment = VerticalAlignment.Center, IsChecked = ParseF(CurRaw(k), k.DefaultF) >= 0.5f };
                    // Same re-entrancy guard the slider rows have: without it, a programmatic
                    // reread() flips IsChecked and fires Checked/Unchecked -> a redundant second
                    // write (and a spurious preview auto-follow) per toggle on every resync.
                    bool tguard = false;
                    cb.Checked += (_, __) => { if (!tguard) WriteAndCache(k, "1"); };
                    cb.Unchecked += (_, __) => { if (!tguard) WriteAndCache(k, "0"); };
                    Grid.SetColumn(cb, 1); g.Children.Add(cb);
                    reread = () => { tguard = true; cb.IsChecked = ParseF(CurRaw(k), k.DefaultF) >= 0.5f; tguard = false; };
                }
                else if ((k.Type == KnobType.Float || k.Type == KnobType.Integer) && k.HasRange) {
                    var box = new DockPanel();
                    var num = new TextBox { Width = 64, VerticalAlignment = VerticalAlignment.Center, Text = CurRaw(k), TextAlignment = TextAlignment.Right };
                    var slider = new Slider { Minimum = k.MinF, Maximum = k.MaxF, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(6, 0, 6, 0),
                        TickFrequency = k.Type == KnobType.Integer ? 1 : 0.001, IsSnapToTickEnabled = k.Type == KnobType.Integer,
                        Value = Math.Clamp(ParseF(CurRaw(k), k.DefaultF), k.MinF, k.MaxF) };
                    bool guard = false;
                    slider.ValueChanged += (_, e) => {
                        if (guard) return; guard = true;
                        float v = k.Type == KnobType.Integer ? (float)Math.Round(e.NewValue) : (float)e.NewValue;
                        num.Text = Cfgs.FormatFloat(v); WriteAndCache(k, Cfgs.FormatFloat(v)); guard = false;
                    };
                    void CommitBox() {
                        if (guard) return;
                        if (float.TryParse(num.Text, NumberStyles.Float, CultureInfo.InvariantCulture, out var v)) {
                            v = Math.Clamp(v, k.MinF, k.MaxF); guard = true; slider.Value = v; num.Text = Cfgs.FormatFloat(v); WriteAndCache(k, Cfgs.FormatFloat(v)); guard = false;
                        }
                    }
                    num.LostKeyboardFocus += (_, __) => CommitBox();
                    num.KeyDown += (_, e) => { if (e.Key == System.Windows.Input.Key.Enter) CommitBox(); };
                    DockPanel.SetDock(num, Dock.Right); box.Children.Add(num); box.Children.Add(slider);
                    Grid.SetColumn(box, 1); g.Children.Add(box);
                    reread = () => { guard = true; float v = Math.Clamp(ParseF(CurRaw(k), k.DefaultF), k.MinF, k.MaxF); slider.Value = v; num.Text = Cfgs.FormatFloat(v); guard = false; };
                }
                else {
                    var tb = new TextBox { VerticalAlignment = VerticalAlignment.Center, Text = CurRaw(k) };
                    void Commit() => WriteAndCache(k, tb.Text.Trim());
                    tb.LostKeyboardFocus += (_, __) => Commit();
                    tb.KeyDown += (_, e) => { if (e.Key == System.Windows.Input.Key.Enter) Commit(); };
                    Grid.SetColumn(tb, 1); g.Children.Add(tb);
                    reread = () => tb.Text = CurRaw(k);
                }
                resync.Add(reread);

                var meta = new TextBlock { VerticalAlignment = VerticalAlignment.Center, Foreground = Brushes.Gray, FontSize = 11,
                    Text = (k.HasRange ? $"{k.Min}–{k.Max}  " : "") + (k.Default.Length > 0 ? $"def {k.Default}" : "") };
                Grid.SetColumn(meta, 2); g.Children.Add(meta);

                // Through WriteAndCache, NOT Cfgs.WriteKnob directly — the preview must hear about
                // the reset too (a direct write left the pane lying about the on-disk state).
                var reset = Btn("reset", (_, __) => { WriteAndCache(k, k.Default); reread(); });
                reset.Padding = new Thickness(4, 0, 4, 0); reset.Margin = new Thickness(2, 0, 2, 0);
                Grid.SetColumn(reset, 3); g.Children.Add(reset);

                return (g, (k.Name + " " + k.Desc + " " + k.Group + " " + k.Plugin).ToLowerInvariant());
            }

            // One per-cfg view: its own filter + reset-all, then this cfg's knobs grouped by
            // section. (The old in-view preview seam moved to the shared PreviewHost column.)
            UIElement BuildCfgView(string cfgName) {
                var v = new DockPanel();

                var filterRow = new DockPanel { Margin = new Thickness(2, 0, 2, 4) };
                var flbl = new TextBlock { Text = "Filter:  ", VerticalAlignment = VerticalAlignment.Center };
                var search = new TextBox { };
                var resetAll = Btn($"Reset all to defaults", (_, __) => {
                    Actions.ResetAll(cfgName);   // same implementation as the CLI's --reset-all
                    ResyncAll();
                });
                DockPanel.SetDock(flbl, Dock.Left); DockPanel.SetDock(resetAll, Dock.Right);
                filterRow.Children.Add(flbl); filterRow.Children.Add(resetAll); filterRow.Children.Add(search);
                DockPanel.SetDock(filterRow, Dock.Top); v.Children.Add(filterRow);

                var panel = new StackPanel();
                var rowVis = new List<(FrameworkElement el, string hay)>();
                var sectionHeaders = new List<FrameworkElement>();
                string lastSection = "";
                foreach (var k in Cfgs.All) {
                    if (k.Cfg != cfgName) continue;
                    if (k.Group != lastSection) {
                        lastSection = k.Group;
                        var hdr = new TextBlock { Text = k.Group, FontWeight = FontWeights.Bold, Margin = new Thickness(0, 8, 0, 2), Foreground = Brushes.SteelBlue };
                        sectionHeaders.Add(hdr); panel.Children.Add(hdr);
                    }
                    var (grid, hay) = BuildRow(k);
                    panel.Children.Add(grid);
                    rowVis.Add((grid, hay));
                }
                search.TextChanged += (_, __) => {
                    var q = search.Text.Trim().ToLowerInvariant();
                    foreach (var h in sectionHeaders) h.Visibility = q.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
                    foreach (var (el, hay) in rowVis) el.Visibility = (q.Length == 0 || hay.Contains(q)) ? Visibility.Visible : Visibility.Collapsed;
                };
                v.Children.Add(new ScrollViewer { Content = panel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
                return v;
            }

            var inner = new TabControl { Margin = new Thickness(0) };
            inner.Items.Add(new TabItem { Header = "Lights (lights.cfg)", Content = BuildCfgView("lights") });
            inner.Items.Add(new TabItem { Header = "Sky (sky.cfg)", Content = BuildCfgView("sky") });
            inner.Items.Add(new TabItem { Header = "Ragdoll (ragdoll.cfg)", Content = BuildCfgView("ragdoll") });
            inner.SelectionChanged += (_, e) => {   // auto-follow the active cfg tab (§1.1 rule 1)
                if (!ReferenceEquals(e.OriginalSource, inner)) return;   // knob-row events bubble here too
                if (inner.SelectedIndex >= 0 && inner.SelectedIndex < cfgNames.Length)
                    host.OnCfgTabSelected(cfgNames[inner.SelectedIndex]);
            };
            root.Children.Add(inner);

            // ── the preview column: [knob list | splitter | PreviewHost] (design §1.1) ──
            var ragPrev = new AcmeLauncher.Preview.RagdollPreview();
            var skyPrev = new AcmeLauncher.Preview.SkyPreview();
            host.Register("lights", "Lights", null,
                "Lighting preview coming — the 2.5-D dungeon-corridor lightmap (design §4). Lights knobs are in-game only for now.");
            host.Register("sky", "Sky", skyPrev);
            host.Register("ragdoll", "Ragdoll", ragPrev);
            foreach (var c in cfgNames) host.Push(c, current[c]);

            var outer = new Grid();
            outer.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star), MinWidth = 320 });
            outer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var previewCol = new ColumnDefinition();
            outer.ColumnDefinitions.Add(previewCol);
            Grid.SetColumn(root, 0); outer.Children.Add(root);

            var splitter = new GridSplitter { Width = 5, HorizontalAlignment = HorizontalAlignment.Stretch, VerticalAlignment = VerticalAlignment.Stretch, Background = Brushes.Gainsboro };
            Grid.SetColumn(splitter, 1); outer.Children.Add(splitter);

            var paneDock = new DockPanel();
            var expandBtn = new Button { Padding = new Thickness(2, 6, 2, 6), Margin = new Thickness(2, 2, 0, 2), VerticalAlignment = VerticalAlignment.Top };
            DockPanel.SetDock(expandBtn, Dock.Left);
            var hostView = new ContentControl { Content = host.View };
            paneDock.Children.Add(expandBtn);
            paneDock.Children.Add(hostView);
            Grid.SetColumn(paneDock, 2); outer.Children.Add(paneDock);

            // Remembered per-state window widths, so toggling restores what the user actually had
            // rather than stomping their sizing with hard constants.
            double expandedWidth = 1080, collapsedWidth = 740;
            void ApplyExpanded(bool init) {
                bool exp = s.PreviewExpanded;
                expandBtn.Content = exp ? "▸" : "◂";
                expandBtn.ToolTip = exp ? "Collapse the preview pane" : "Expand the preview pane";
                hostView.Visibility = exp ? Visibility.Visible : Visibility.Collapsed;
                splitter.Visibility = exp ? Visibility.Visible : Visibility.Collapsed;
                previewCol.Width = exp ? new GridLength(380) : GridLength.Auto;
                previewCol.MinWidth = exp ? 340 : 0;    // §1.1: min ~340 px when expanded
                if (init) return;                        // window sizing only on user toggles
                var win = Window.GetWindow(outer);
                if (win == null) return;                 // §1.1 rule 5: widen ~1080 expanded
                if (exp) { collapsedWidth = win.Width; win.Width = Math.Min(Math.Max(expandedWidth, win.Width), SystemParameters.WorkArea.Width); }
                else { expandedWidth = win.Width; win.Width = Math.Min(collapsedWidth, SystemParameters.WorkArea.Width); }
            }
            expandBtn.Click += (_, __) => { host.SetExpanded(!s.PreviewExpanded); ApplyExpanded(init: false); };
            ApplyExpanded(init: true);
            return outer;
        }

        private static float ParseF(string s, float fb) => float.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : fb;

        // ─────────────────────────────── FIX ────────────────────────────────
        private static UIElement BuildFix(Settings s, Backbone back) {
            var root = new DockPanel { Margin = new Thickness(8) };
            var outp = new TextBox { IsReadOnly = true, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, AcceptsReturn = true, FontFamily = new FontFamily("Consolas") };
            void Log(string t) => outp.AppendText(t + "\n");
            void Clear() => outp.Clear();

            var buttons = new WrapPanel { Margin = new Thickness(0, 0, 0, 6) };
            // Wine's powershell.exe is a stub, so the ps1-based verify can't run there —
            // the Wine group below shows the doc's native-Linux command instead.
            if (!Platform.IsWine)
                buttons.Children.Add(Btn("Verify exe patched", (_, __) => { Clear(); FixVerifyExe(s, Log); }));
            buttons.Children.Add(Btn("Check dat sizes", (_, __) => { Clear(); FixDatSizes(s, Log); }));
            buttons.Children.Add(Btn("Check UserPreferences", (_, __) => { Clear(); FixUserPrefs(s, Log); }));
            buttons.Children.Add(Btn("Tail plugin log", (_, __) => { Clear(); FixTailLog(s, Log); }));
            buttons.Children.Add(Btn("Rollback…", (_, __) => { FixRollback(s, Log, Clear); }));
            DockPanel.SetDock(buttons, Dock.Top); root.Children.Add(buttons);

            if (Platform.IsWine) {
                var wine = BuildWineFixes(s, Log, Clear);
                DockPanel.SetDock(wine, Dock.Top); root.Children.Add(wine);
            }

            var explain = new Expander {
                Header = "Explain common errors", IsExpanded = false, Margin = new Thickness(0, 0, 0, 6),
                Content = new TextBlock { Text = CommonErrorsText(), TextWrapping = TextWrapping.Wrap, Foreground = Brushes.DimGray, Margin = new Thickness(6, 4, 2, 2) },
            };
            DockPanel.SetDock(explain, Dock.Top); root.Children.Add(explain);

            root.Children.Add(outp);
            return root;
        }

        /// <summary>The documented dialog/symptom explanations, condensed from the install
        /// guides (INSTALL-WINDOWS.md §11 ladder; INSTALL-LINUX-WINE.md "Troubleshooting
        /// dialogs and errors"). Text only — these are the fixes that are a decision, not a
        /// button.</summary>
        private static string CommonErrorsText() {
            var t =
                "\"DAT files are incomplete\" at login — the SERVER's message, not a client check: " +
                "its dat-version handshake (DDD) doesn't match your dats. Use exactly the dat set " +
                "shipped for your server — all files from the same release, no mixing.\n\n" +
                "\"Cannot have two accounts logged on at the same time\" — you reconnected too fast. " +
                "After a crash or killed client the ghost session lingers ~110–150 s: wait 2–3 minutes " +
                "and retry. After a clean logout a few seconds is enough.\n\n" +
                "Error box mentioning corestrings.dll / message text shows as placeholder IDs — the " +
                "client couldn't load corestrings.dll: you launched from a bare or overlay-only folder. " +
                "Run from your full retail install folder (it supplies corestrings.dll and ~37 other base DLLs).\n\n" +
                "Client exits instantly with no window — usually the wrong working directory; the client " +
                "finds its dats and DLLs by working directory, so start it from the game folder.\n\n" +
                "Game runs but many surfaces are untextured/white — incomplete install reached the world: " +
                "client_highres.dat missing/truncated, exe not patched, or a client \"repair\" restored a " +
                "stock exe. Run play.bat (or the kit check) once — it names which.\n\n" +
                "Exactly ~10 fps, constant — the window-activation throttle: the client deactivated. " +
                "Click in the game window; script launches need a real activation, not just visibility.";
            if (Platform.IsWine) t +=
                "\n\nBlack window / nothing renders but UI or sound works — (Wine) almost always the " +
                "missing 32-bit GL driver: the game is 32-bit and needs your distro's :i386 / lib32 " +
                "driver package. Check the renderer string in a WINEDEBUG=+fps log — llvmpipe/softpipe/" +
                "SWRast means software rendering.";
            return t;
        }

        // ─────────────────────────── FIX: Wine group ────────────────────────
        /// <summary>The Wine-only checklist from INSTALL-LINUX-WINE.md, as check+fix rows —
        /// a thin view over <see cref="WineFixes"/> (the same code the headless
        /// <c>--fix-wine</c> command runs; that CLI is the supported Linux surface, since the
        /// WPF GUI itself does not run under Wine).</summary>
        private static UIElement BuildWineFixes(Settings s, Action<string> log, Action clear) {
            var panel = new StackPanel();
            var rows = new List<(TextBlock status, Func<WineFixes.Row> check)>();

            void AddRow(Func<WineFixes.Row> check, string fixLabel, Func<string?> fix) {
                var row = new DockPanel { Margin = new Thickness(0, 1, 0, 1) };
                var status = new TextBlock { VerticalAlignment = VerticalAlignment.Center, TextWrapping = TextWrapping.Wrap };
                var b = Btn(fixLabel, (_, __) => {
                    var err = fix();
                    if (err != null) MessageBox.Show(err, "Fix failed", MessageBoxButton.OK, MessageBoxImage.Error);
                    RefreshAll();
                });
                DockPanel.SetDock(b, Dock.Right); row.Children.Add(b);
                row.Children.Add(status);
                rows.Add((status, check));
                panel.Children.Add(row);
            }
            void RefreshAll() {
                foreach (var (status, check) in rows) {
                    var r = check();
                    status.Text = r.Ok ? r.Detail + " — ok." : r.Detail;
                    status.Foreground = r.Ok ? Brushes.Green : r.Advisory ? Brushes.Orange : Brushes.Red;
                }
            }

            AddRow(WineFixes.CheckVideoMemory, "Set to 2048", WineFixes.FixVideoMemory);
            AddRow(() => WineFixes.CheckDxvkConf(s), "Create dxvk.conf", () => WineFixes.FixDxvkConf(s));
            AddRow(WineFixes.CheckChoriziteTemp, "Create", WineFixes.FixChoriziteTemp);
            AddRow(WineFixes.CheckLiveSky, "Set live=0", WineFixes.FixLiveSky);

            RefreshAll();

            var crib = new TextBox {
                IsReadOnly = true, FontFamily = new FontFamily("Consolas"), TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 4, 0, 0),
                Text = "# This same checklist, headless (the supported Linux surface — see --help\n" +
                       "# for the FULL command set: knobs, plugins, checks, paths):\n" +
                       "wine zzpatcher.exe --fix-wine          # check\n" +
                       "wine zzpatcher.exe --fix-wine --apply  # fix\n" +
                       "# These run on the LINUX side (a real terminal), not inside the prefix:\n" +
                       "# verify exe patches + dat sizes (KIT-OK = all good):\n" +
                       "python3 acme-patch-client.py --check-kit\n" +
                       "# capture a crash log:\n" +
                       "WINEPREFIX=~/acwine WINEDEBUG=+seh wine acclient.exe -h <server> -p 9000 -a <acct> -v <pw> -rodat > ~/ac-crash.log 2>&1",
            };

            var inner = new StackPanel();
            inner.Children.Add(new TextBlock {
                Text = "Wine " + Platform.WineVersion + " detected. The checks below are the Wine checklist from INSTALL-LINUX-WINE.md. " +
                       "Note: this GUI itself is unsupported under Wine (WPF does not run there) — the headless " +
                       "commands are the supported Linux surface, and they cover the whole GUI (run --help).",
                TextWrapping = TextWrapping.Wrap, Foreground = Brushes.DimGray, Margin = new Thickness(0, 0, 0, 4),
            });
            inner.Children.Add(panel);
            inner.Children.Add(crib);
            var refresh = Btn("Re-check", (_, __) => RefreshAll());
            refresh.HorizontalAlignment = HorizontalAlignment.Left;
            inner.Children.Add(refresh);

            return new GroupBox { Header = "Wine", Content = inner, Margin = new Thickness(0, 0, 0, 6), Padding = new Thickness(4) };
        }


        // The Fix actions live in Actions.* — the SAME implementations the headless CLI
        // runs (--verify-exe / --check-dats / --check-prefs / --tail-log / --rollback), so
        // the two surfaces cannot drift. The GUI adds only dialogs and the output box.
        private static void FixVerifyExe(Settings s, Action<string> log) => Actions.VerifyExe(s, log);

        private static void FixDatSizes(Settings s, Action<string> log) => Actions.CheckDats(s, log);

        private static void FixUserPrefs(Settings s, Action<string> log) => Actions.CheckPrefs(s, log);

        private static void FixTailLog(Settings s, Action<string> log) => Actions.TailLog(s, log, pid: null);

        private static void FixRollback(Settings s, Action<string> log, Action clear) {
            if (MessageBox.Show("Restore your original acclient.exe and stop using the ACME dats?\n\nThis puts back acclient.exe.acme-orig.bak. Restore your own dat backups manually.",
                "Rollback", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
            clear();
            Actions.Rollback(s, log);
        }

        // ────────────────────────────── INSTALL ─────────────────────────────
        private static UIElement BuildInstall(Settings s, Backbone back) {
            var root = new StackPanel { Margin = new Thickness(8) };
            var outp = new TextBox { IsReadOnly = true, Height = 160, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, AcceptsReturn = true, FontFamily = new FontFamily("Consolas"), Margin = new Thickness(0, 6, 0, 0) };
            void Log(string t) => outp.AppendText(t + "\n");

            root.Children.Add(new TextBlock { Text = "One-time setup. Point the launcher at your install, patch your exe, and you're done.", TextWrapping = TextWrapping.Wrap, Margin = new Thickness(2) });

            if (Platform.IsWine) {
                // Honest posture per INSTALL-LINUX-WINE.md: the supported Linux posture is the
                // plain client; plugins are experimental; the exe patcher runs NATIVELY (Wine's
                // powershell is a stub, so the ps1 path can't run here).
                root.Children.Add(new TextBlock {
                    Text = "Running under Wine " + Platform.WineVersion + ". The supported Linux posture is the plain client " +
                           "(see INSTALL-LINUX-WINE.md); plugins are experimental. The exe patcher runs natively, in a real terminal:",
                    TextWrapping = TextWrapping.Wrap, Foreground = Brushes.DarkOrange, Margin = new Thickness(2, 6, 2, 2),
                });
                root.Children.Add(new TextBox {
                    IsReadOnly = true, FontFamily = new FontFamily("Consolas"),
                    Text = "python3 acme-patch-client.py --check-kit", Margin = new Thickness(2, 0, 2, 4),
                });
            }

            // paths
            var grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            for (int i = 0; i < 2; i++) grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var tbInstall = new TextBox { Text = s.InstallDir ?? "", Margin = new Thickness(2) };
            var tbChoriz = new TextBox { Text = s.ChoriziteDir ?? "", Margin = new Thickness(2) };
            AddPathRow(grid, 0, "Install folder (acclient.exe + dats):", tbInstall);
            AddPathRow(grid, 1, "Plugin runtime (Chorizite) folder:", tbChoriz);
            root.Children.Add(grid);

            var b = new WrapPanel { Margin = new Thickness(0, 6, 0, 0) };
            b.Children.Add(Btn("Save paths", (_, __) => {
                // Same rule as the CLI's --set-*-dir (that rationale won): a typo'd path
                // silently saved poisons every later check — validate, refuse, same message.
                foreach (var (label, p) in new[] { ("install", tbInstall.Text.Trim()), ("chorizite", tbChoriz.Text.Trim()) })
                    if (p.Length > 0 && !Directory.Exists(p)) { Log($"no such directory: {p} (not saved)"); return; }
                s.InstallDir = tbInstall.Text.Trim(); s.ChoriziteDir = tbChoriz.Text.Trim(); s.Save();
                Log("Saved. Install: " + s.InstallDir + "  Chorizite: " + s.ChoriziteDir);
            }));
            b.Children.Add(Btn("Verify kit", (_, __) => { s.InstallDir = tbInstall.Text.Trim(); s.Save(); FixDatSizes(s, Log); }));
            // Both of these shell to binaries Wine doesn't have (powershell/dotnet are stubs) —
            // the Wine banner above shows the native command instead.
            if (!Platform.IsWine) {
                b.Children.Add(Btn("Patch my client", (_, __) => {
                    s.InstallDir = tbInstall.Text.Trim(); s.Save();
                    Actions.PatchExe(s, Log);   // same implementation as the CLI's --patch-exe
                }));
                b.Children.Add(Btn("Check .NET runtime", (_, __) => InstallCheckDotnet(Log)));
            }
            root.Children.Add(b);

            root.Children.Add(new TextBlock {
                Text = "The plugin pack bundles the open-source Chorizite runtime (MIT). It injects into the client (as Decal does); some antivirus may block that — see the install guide. Provenance: THIRD-PARTY-PROVENANCE.md.",
                TextWrapping = TextWrapping.Wrap, Foreground = Brushes.DimGray, Margin = new Thickness(2, 8, 2, 0)
            });
            root.Children.Add(outp);
            return root;
        }

        private static void InstallCheckDotnet(Action<string> log) {
            // The report half is Actions.CheckDotnet (shared with the CLI's --check-dotnet;
            // it never downloads). The GUI adds the offer to open the official page.
            if (Actions.CheckDotnet(log) == 0) return;
            if (MessageBox.Show("Open Microsoft's official .NET 8 download page in your browser?\n\n(The launcher never downloads or bundles it for you — you get it from Microsoft directly.)",
                    ".NET runtime", MessageBoxButton.YesNo, MessageBoxImage.Question) == MessageBoxResult.Yes) {
                try { Process.Start(new ProcessStartInfo("https://dotnet.microsoft.com/download/dotnet/8.0") { UseShellExecute = true }); }
                catch (Exception ex) { log("Couldn't open the browser: " + ex.Message); }
            }
        }

        // ─────────────────────────────── helpers ────────────────────────────
        /// <summary>A small colored status dot (Ellipse is sealed, so build one).</summary>
        private static System.Windows.Shapes.Ellipse MakeDot(Status.Light light) => new System.Windows.Shapes.Ellipse {
            Width = 12, Height = 12, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(2, 0, 2, 0),
            Fill = light switch {
                Status.Light.Green => Brushes.LimeGreen,
                Status.Light.Amber => Brushes.Orange,
                Status.Light.Red => Brushes.Red,
                _ => Brushes.Gray,
            },
        };

        private static Button Btn(string label, RoutedEventHandler onClick) {
            var b = new Button { Content = label, Margin = new Thickness(2), Padding = new Thickness(8, 3, 8, 3) };
            b.Click += onClick;
            return b;
        }

        private static void AddPathRow(Grid g, int row, string label, TextBox field) {
            var l = new TextBlock { Text = label, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(2) };
            Grid.SetRow(l, row); Grid.SetColumn(l, 0); g.Children.Add(l);
            Grid.SetRow(field, row); Grid.SetColumn(field, 1); g.Children.Add(field);
            var browse = new Button { Content = "…", Width = 30, Margin = new Thickness(2) };
            browse.Click += (_, __) => {
                var dlg = new Microsoft.Win32.OpenFileDialog { CheckFileExists = false, FileName = "select folder", ValidateNames = false };
                if (dlg.ShowDialog() == true) field.Text = Path.GetDirectoryName(dlg.FileName) ?? field.Text;
            };
            Grid.SetRow(browse, row); Grid.SetColumn(browse, 2); g.Children.Add(browse);
        }

    }

}
