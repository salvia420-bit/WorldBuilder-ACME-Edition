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
    /// Tab order is deliberate: Play (daily) · Tune (live) · Fix · Install (once).
    /// Every action delegates to <see cref="Backbone"/> or a file read/write; the
    /// window holds no injection or enumeration logic of its own.
    /// </summary>
    internal static class Ui {
        private static readonly Brush Grey = Brushes.Gray, Green = Brushes.LimeGreen, Amber = Brushes.Orange, Red = Brushes.Red;

        public static Window Build(Settings settings, Backbone back) {
            var win = new Window {
                Title = "ACME Launcher",
                Width = 720, Height = 560,
                WindowStartupLocation = WindowStartupLocation.CenterScreen,
            };
            var tabs = new TabControl { Margin = new Thickness(6) };
            tabs.Items.Add(new TabItem { Header = "Play",    Content = BuildPlay(settings, back) });
            tabs.Items.Add(new TabItem { Header = "Tune",    Content = BuildTune(settings) });
            tabs.Items.Add(new TabItem { Header = "Fix",     Content = BuildFix(settings, back) });
            tabs.Items.Add(new TabItem { Header = "Install", Content = BuildInstall(settings, back) });
            win.Content = tabs;
            return win;
        }

        // ─────────────────────────────── PLAY ───────────────────────────────
        private static UIElement BuildPlay(Settings s, Backbone back) {
            var root = new DockPanel { Margin = new Thickness(8) };

            // connection fields (top)
            var top = new Grid();
            for (int i = 0; i < 2; i++) top.ColumnDefinitions.Add(new ColumnDefinition { Width = i == 0 ? GridLength.Auto : new GridLength(1, GridUnitType.Star) });
            for (int i = 0; i < 3; i++) top.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var tbServer = new TextBox { Text = s.Server ?? "", Margin = new Thickness(2) };
            var tbAccount = new TextBox { Text = s.Account ?? "", Margin = new Thickness(2) };
            var cbRodat = new CheckBox { Content = "Read-only dats (-rodat on) — keep this on", IsChecked = s.Rodat, Margin = new Thickness(2) };
            AddRow(top, 0, "Server:", tbServer);
            AddRow(top, 1, "Account:", tbAccount);
            Grid.SetRow(cbRodat, 2); Grid.SetColumn(cbRodat, 1); top.Children.Add(cbRodat);
            DockPanel.SetDock(top, Dock.Top); root.Children.Add(top);

            void Persist() {
                s.Server = tbServer.Text.Trim(); s.Account = tbAccount.Text.Trim(); s.Rodat = cbRodat.IsChecked == true; s.Save();
            }

            // action buttons
            var actions = new WrapPanel { Margin = new Thickness(0, 6, 0, 6) };
            var status = new TextBlock { Margin = new Thickness(2, 4, 2, 4), TextWrapping = TextWrapping.Wrap };
            var list = new StackPanel();
            int selectedPid = 0;

            async Task Do(string label, Func<Backbone.RunResult> act) {
                Persist();
                status.Text = label + "…";
                foreach (var b in actions.Children) if (b is Button bb) bb.IsEnabled = false;
                var r = await Task.Run(act);
                foreach (var b in actions.Children) if (b is Button bb) bb.IsEnabled = true;
                status.Text = (r.Ran ? $"[{r.ExitCode}] " : "[failed] ") + r.Message.Trim();
            }

            var btnPlay = Btn("Play", async (_, __) => {
                var exe = App.AcclientPath(s);
                if (exe == null) { status.Text = "Set your install folder on the Install tab first."; return; }
                await Do("Launching", () => back.PlayPlain(exe, App.ClientArgs(s)));
            });
            var btnPlugins = Btn("Play with plugins", async (_, __) => {
                var exe = App.AcclientPath(s);
                if (exe == null) { status.Text = "Set your install folder on the Install tab first."; return; }
                await Do("Launching with plugins", () => back.PlayWithPlugins(exe, App.ClientArgs(s)));
            });
            var btnAttach = Btn("Attach selected", async (_, __) => {
                if (selectedPid == 0) { status.Text = "Select a running client below first."; return; }
                await Do($"Attaching to {selectedPid}", () => back.AttachPid(selectedPid));
            });
            var btnAttachAll = Btn("Attach all", async (_, __) => await Do("Attaching all", () => back.AttachAll()));
            foreach (var b in new[] { btnPlay, btnPlugins, btnAttach, btnAttachAll }) actions.Children.Add(b);
            DockPanel.SetDock(actions, Dock.Top); root.Children.Add(actions);
            DockPanel.SetDock(status, Dock.Top); root.Children.Add(status);

            // plugin presence
            var plug = new TextBlock { Margin = new Thickness(2, 0, 2, 6), Foreground = Brushes.DimGray };
            plug.Text = "Plugins: " + PluginPresence(s);
            DockPanel.SetDock(plug, Dock.Top); root.Children.Add(plug);

            // client list header
            var lh = new TextBlock { Text = "Running clients (click to select):", FontWeight = FontWeights.Bold, Margin = new Thickness(2) };
            DockPanel.SetDock(lh, Dock.Top); root.Children.Add(lh);
            root.Children.Add(new ScrollViewer { Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });

            bool refreshing = false;
            async void Refresh() {
                if (refreshing) return;   // don't pile up if a tick fires mid-gather
                refreshing = true;
                try {
                    // Gather OFF the UI thread: --list spawns AcmeInject and Status.Read opens a
                    // log file per client. Doing this on the UI thread hitches every tick and would
                    // freeze the whole window if AcmeInject ever stalled.
                    var gathered = await System.Threading.Tasks.Task.Run(() => {
                        var cs = back.ListClients();
                        var err = back.LastListError;
                        var rows = new System.Collections.Generic.List<(Backbone.Client c, Status.Health h)>();
                        foreach (var c in cs) rows.Add((c, Status.Read(s, c.Pid, c.Injected)));
                        return (rows, err);
                    });
                    // Build WPF controls ON the UI thread (we're back on it after the await).
                    list.Children.Clear();
                    if (gathered.rows.Count == 0) {
                        list.Children.Add(new TextBlock { Text = gathered.err ?? "  (none running)", Foreground = Brushes.DimGray, Margin = new Thickness(2) });
                        return;
                    }
                    foreach (var (c, h) in gathered.rows) {
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
                }
                finally { refreshing = false; }
            }
            actions.Children.Add(Btn("Refresh", (_, __) => Refresh()));

            var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
            timer.Tick += (_, __) => Refresh();
            root.Loaded += (_, __) => { Refresh(); timer.Start(); };
            root.Unloaded += (_, __) => timer.Stop();
            return root;
        }

        private static string PluginPresence(Settings s) {
            var dir = string.IsNullOrEmpty(s.ChoriziteDir) ? @"C:\Games\Chorizite" : s.ChoriziteDir!;
            var plugins = Path.Combine(dir, "plugins");
            var found = new List<string>();
            foreach (var name in new[] { "AcmeLights", "AcmeSky", "AcmeRagdoll" })
                if (Directory.Exists(Path.Combine(plugins, name))) found.Add(name);
            return found.Count == 0 ? "none found (plugin pack not installed)" : string.Join(", ", found);
        }

        // ─────────────────────────────── TUNE ───────────────────────────────
        private static UIElement BuildTune(Settings s) {
            var root = new DockPanel { Margin = new Thickness(8) };
            string cfgPath = Knobs.ResolveCfgPath(forWrite: true);
            var pathLabel = new TextBlock { Text = "lights.cfg: " + cfgPath, Foreground = Brushes.DimGray, Margin = new Thickness(2) };
            DockPanel.SetDock(pathLabel, Dock.Top); root.Children.Add(pathLabel);

            var note = new TextBlock { Text = "Changes apply live (~1 second) — no restart. Numbers are clamped to the plugin's own ranges.", TextWrapping = TextWrapping.Wrap, Margin = new Thickness(2, 0, 2, 6) };
            DockPanel.SetDock(note, Dock.Top); root.Children.Add(note);

            var buttons = new WrapPanel { Margin = new Thickness(0, 0, 0, 6) };
            var panel = new StackPanel();

            var current = Knobs.Read(cfgPath);
            var controls = new Dictionary<string, Action>();   // re-sync from file/defaults

            void SetKnob(Knob k, float v) {
                v = Math.Clamp(v, k.Min, k.Max);
                Knobs.WriteKnob(cfgPath, k.Name, v);
            }

            string lastGroup = "";
            foreach (var k in Knobs.All) {
                if (k.Group != lastGroup) {
                    lastGroup = k.Group;
                    panel.Children.Add(new TextBlock { Text = k.Group, FontWeight = FontWeights.Bold, Margin = new Thickness(0, 8, 0, 2) });
                }
                float val = current.TryGetValue(k.Name, out var cv) ? cv : k.Default;
                val = Math.Clamp(val, k.Min, k.Max);

                var rowGrid = new Grid { Margin = new Thickness(2, 1, 2, 1) };
                rowGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(200) });
                rowGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                rowGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(70) });
                var lbl = new TextBlock { Text = k.Label, VerticalAlignment = VerticalAlignment.Center, ToolTip = k.Help.Length > 0 ? k.Help : null };
                Grid.SetColumn(lbl, 0); rowGrid.Children.Add(lbl);

                if (k.Toggle) {
                    var cb = new CheckBox { IsChecked = val >= 0.5f, VerticalAlignment = VerticalAlignment.Center };
                    cb.Checked += (_, __) => SetKnob(k, 1f);
                    cb.Unchecked += (_, __) => SetKnob(k, 0f);
                    Grid.SetColumn(cb, 1); rowGrid.Children.Add(cb);
                    controls[k.Name] = () => { var c = Knobs.Read(cfgPath); cb.IsChecked = (c.TryGetValue(k.Name, out var x) ? x : k.Default) >= 0.5f; };
                }
                else {
                    var slider = new Slider { Minimum = k.Min, Maximum = k.Max, Value = val, VerticalAlignment = VerticalAlignment.Center, TickFrequency = k.Integer ? 1 : 0.01, IsSnapToTickEnabled = k.Integer };
                    var valTxt = new TextBlock { Text = Knobs.FormatValue(val), VerticalAlignment = VerticalAlignment.Center, TextAlignment = TextAlignment.Right };
                    slider.ValueChanged += (_, e) => {
                        float v = k.Integer ? (float)Math.Round(e.NewValue) : (float)e.NewValue;
                        valTxt.Text = Knobs.FormatValue(v);
                        SetKnob(k, v);
                    };
                    Grid.SetColumn(slider, 1); rowGrid.Children.Add(slider);
                    Grid.SetColumn(valTxt, 2); rowGrid.Children.Add(valTxt);
                    controls[k.Name] = () => { var c = Knobs.Read(cfgPath); slider.Value = Math.Clamp(c.TryGetValue(k.Name, out var x) ? x : k.Default, k.Min, k.Max); };
                }
                panel.Children.Add(rowGrid);
            }

            void ResyncAll() { foreach (var a in controls.Values) a(); }

            buttons.Children.Add(Btn("Shipped defaults", (_, __) => {
                foreach (var k in Knobs.All) SetKnob(k, k.Default);
                // ship diet=3 + memlog defaults are the deployed posture; diet default here is 0
                // (LightsConfig field), so nudge the two the reference machine ships on:
                Knobs.WriteKnob(cfgPath, "diet", 3f);
                ResyncAll();
            }));
            buttons.Children.Add(Btn("Stock (all off)", (_, __) => {
                foreach (var k in Knobs.All) if (k.Toggle || k.Name == "diet") SetKnob(k, 0f);
                ResyncAll();
            }));
            buttons.Children.Add(Btn("Save profile…", (_, __) => {
                var dlg = new Microsoft.Win32.SaveFileDialog { Filter = "cfg|*.cfg", FileName = "profile.cfg" };
                if (dlg.ShowDialog() == true) try { File.Copy(cfgPath, dlg.FileName, true); } catch (Exception ex) { MessageBox.Show(ex.Message); }
            }));
            buttons.Children.Add(Btn("Load profile…", (_, __) => {
                var dlg = new Microsoft.Win32.OpenFileDialog { Filter = "cfg|*.cfg" };
                if (dlg.ShowDialog() == true) { try { File.Copy(dlg.FileName, cfgPath, true); } catch (Exception ex) { MessageBox.Show(ex.Message); } ResyncAll(); }
            }));
            DockPanel.SetDock(buttons, Dock.Top); root.Children.Add(buttons);
            root.Children.Add(new ScrollViewer { Content = panel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
            return root;
        }

        // ─────────────────────────────── FIX ────────────────────────────────
        private static UIElement BuildFix(Settings s, Backbone back) {
            var root = new DockPanel { Margin = new Thickness(8) };
            var outp = new TextBox { IsReadOnly = true, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, AcceptsReturn = true, FontFamily = new FontFamily("Consolas") };
            void Log(string t) => outp.AppendText(t + "\n");
            void Clear() => outp.Clear();

            var buttons = new WrapPanel { Margin = new Thickness(0, 0, 0, 6) };
            buttons.Children.Add(Btn("Verify exe patched", (_, __) => { Clear(); FixVerifyExe(s, Log); }));
            buttons.Children.Add(Btn("Check dat sizes", (_, __) => { Clear(); FixDatSizes(s, Log); }));
            buttons.Children.Add(Btn("Check texture-detail", (_, __) => { Clear(); FixTextureDetail(s, Log); }));
            buttons.Children.Add(Btn("Tail plugin log", (_, __) => { Clear(); FixTailLog(s, Log); }));
            buttons.Children.Add(Btn("Rollback…", (_, __) => { FixRollback(s, Log, Clear); }));
            DockPanel.SetDock(buttons, Dock.Top); root.Children.Add(buttons);
            root.Children.Add(outp);
            return root;
        }

        private static void FixVerifyExe(Settings s, Action<string> log) {
            var dir = s.InstallDir;
            if (string.IsNullOrEmpty(dir)) { log("Install folder not set (Install tab)."); return; }
            var ps1 = Path.Combine(dir!, "acme-patch-client.ps1");
            if (!File.Exists(ps1)) { log("acme-patch-client.ps1 not in the install folder — copy the kit files there."); return; }
            var r = RunCapture("powershell", $"-NoProfile -ExecutionPolicy Bypass -File \"{ps1}\" -Verify -Exe \"{Path.Combine(dir!, "acclient.exe")}\"", dir);
            log(r.output.Trim());
            log(r.code == 0 ? "\nOK: exe is fully patched." : "\nNOT fully patched — run the patcher on the Install tab. Without it, most textures won't load.");
        }

        private static void FixDatSizes(Settings s, Action<string> log) {
            var dir = s.InstallDir;
            if (string.IsNullOrEmpty(dir)) { log("Install folder not set (Install tab)."); return; }
            var manifest = Path.Combine(dir!, "kit-manifest.txt");
            if (!File.Exists(manifest)) { log("kit-manifest.txt not found — can't verify dat sizes."); return; }
            bool ok = true;
            foreach (var raw in File.ReadAllLines(manifest)) {
                var line = raw.Trim(); if (line.Length == 0) continue;
                var parts = line.Split('|');
                if (parts.Length < 2) continue;
                var name = parts[0]; var want = parts[1];
                var p = Path.Combine(dir!, name);
                if (!File.Exists(p)) { log($"MISSING  {name}"); ok = false; continue; }
                var have = new FileInfo(p).Length.ToString(CultureInfo.InvariantCulture);
                if (have != want) { log($"WRONG    {name}  have {have}  want {want}"); ok = false; }
                else log($"ok       {name}  {have}");
            }
            log(ok ? "\nAll dats present at their manifest sizes." : "\nSome dats are wrong/missing — re-copy the kit. A missing highres silently renders untextured surfaces.");
        }

        private static void FixTextureDetail(Settings s, Action<string> log) {
            var dir = s.InstallDir;
            string? ini = null;
            if (!string.IsNullOrEmpty(dir) && File.Exists(Path.Combine(dir!, "UserPreferences.ini"))) ini = Path.Combine(dir!, "UserPreferences.ini");
            else {
                var docs = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Asheron's Call", "UserPreferences.ini");
                if (File.Exists(docs)) ini = docs;
            }
            if (ini == null) { log("UserPreferences.ini not found (install folder or Documents\\Asheron's Call)."); return; }
            log("ini: " + ini);
            bool warned = false;
            foreach (var raw in File.ReadAllLines(ini)) {
                var line = raw.Trim();
                foreach (var key in new[] { "EnvironmentTextureDetail", "LandscapeTextureDetail" }) {
                    if (line.StartsWith(key, StringComparison.OrdinalIgnoreCase) && line.Contains('=')) {
                        var v = line.Substring(line.IndexOf('=') + 1).Trim();
                        bool numeric = float.TryParse(v, out _);
                        if (numeric) { log($"⚠ {key}={v} — NUMERIC values are a worst-first index; =0 means VeryLow (quarter detail). Use =VeryHigh."); warned = true; }
                        else log($"ok {key}={v}");
                    }
                }
            }
            if (!warned) log("\nTexture-detail lines look fine (spelled-out names). VeryHigh = full detail.");
        }

        private static void FixTailLog(Settings s, Action<string> log) {
            var back = new Backbone(s);
            var clients = back.ListClients();
            if (clients.Count == 0) { log("No running clients to read a log from."); return; }
            foreach (var c in clients) {
                if (c.Injected != true) continue;   // only confirmed-injected clients have a plugin log
                var path = Status.LogPath(s, c.Pid);
                log($"── pid {c.Pid}: {path} ──");
                try {
                    using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                    using var sr = new StreamReader(fs);
                    var all = sr.ReadToEnd().Split('\n');
                    int start = Math.Max(0, all.Length - 40);
                    for (int i = start; i < all.Length; i++) {
                        var l = all[i].TrimEnd('\r');
                        if (l.Length == 0) continue;
                        if (l.Contains("FAULT") || l.Contains("Error") || l.Contains("CRITICAL")) log("!! " + l);
                        else log("   " + l);
                    }
                }
                catch (Exception ex) { log("  (unreadable: " + ex.Message + ")"); }
            }
        }

        private static void FixRollback(Settings s, Action<string> log, Action clear) {
            if (MessageBox.Show("Restore your original acclient.exe and stop using the ACME dats?\n\nThis puts back acclient.exe.acme-orig.bak. Restore your own dat backups manually.",
                "Rollback", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
            clear();
            var dir = s.InstallDir;
            if (string.IsNullOrEmpty(dir)) { log("Install folder not set."); return; }
            var bak = Path.Combine(dir!, "acclient.exe.acme-orig.bak");
            if (!File.Exists(bak)) { log("No acclient.exe.acme-orig.bak found — nothing to restore."); return; }
            try { File.Copy(bak, Path.Combine(dir!, "acclient.exe"), true); log("Restored original acclient.exe. Restore your backed-up dats manually to go fully stock."); }
            catch (Exception ex) { log("Restore failed: " + ex.Message); }
        }

        // ────────────────────────────── INSTALL ─────────────────────────────
        private static UIElement BuildInstall(Settings s, Backbone back) {
            var root = new StackPanel { Margin = new Thickness(8) };
            var outp = new TextBox { IsReadOnly = true, Height = 160, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, AcceptsReturn = true, FontFamily = new FontFamily("Consolas"), Margin = new Thickness(0, 6, 0, 0) };
            void Log(string t) => outp.AppendText(t + "\n");

            root.Children.Add(new TextBlock { Text = "One-time setup. Point the launcher at your install, patch your exe, and you're done.", TextWrapping = TextWrapping.Wrap, Margin = new Thickness(2) });

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
                s.InstallDir = tbInstall.Text.Trim(); s.ChoriziteDir = tbChoriz.Text.Trim(); s.Save();
                Log("Saved. Install: " + s.InstallDir + "  Chorizite: " + s.ChoriziteDir);
            }));
            b.Children.Add(Btn("Verify kit", (_, __) => { s.InstallDir = tbInstall.Text.Trim(); s.Save(); FixDatSizes(s, Log); }));
            b.Children.Add(Btn("Patch my client", (_, __) => {
                s.InstallDir = tbInstall.Text.Trim(); s.Save();
                var dir = s.InstallDir;
                var ps1 = string.IsNullOrEmpty(dir) ? null : Path.Combine(dir!, "acme-patch-client.ps1");
                if (ps1 == null || !File.Exists(ps1)) { Log("acme-patch-client.ps1 not in the install folder."); return; }
                var r = RunCapture("powershell", $"-NoProfile -ExecutionPolicy Bypass -File \"{ps1}\" -Exe \"{Path.Combine(dir!, "acclient.exe")}\"", dir);
                Log(r.output.Trim());
                Log(r.code == 0 ? "Patched." : "Patcher refused — see message above.");
            }));
            b.Children.Add(Btn("Check .NET runtime", (_, __) => InstallCheckDotnet(Log)));
            root.Children.Add(b);

            root.Children.Add(new TextBlock {
                Text = "The plugin pack bundles the open-source Chorizite runtime (MIT). It injects into the client (as Decal does); some antivirus may block that — see the install guide. Provenance: THIRD-PARTY-PROVENANCE.md.",
                TextWrapping = TextWrapping.Wrap, Foreground = Brushes.DimGray, Margin = new Thickness(2, 8, 2, 0)
            });
            root.Children.Add(outp);
            return root;
        }

        private static void InstallCheckDotnet(Action<string> log) {
            // The plugin pack (Chorizite) is managed .NET; the injected CLR needs a
            // .NET desktop runtime present. Report, and OFFER the official source —
            // never fetch/bundle silently.
            var r = RunCapture("dotnet", "--list-runtimes", null);
            if (r.code == 0 && r.output.Contains("Microsoft.WindowsDesktop.App")) {
                log("Found a .NET desktop runtime:\n" + r.output.Trim());
                return;
            }
            log(".NET desktop runtime not detected.");
            log("The plugin pack needs the .NET 8 Desktop Runtime.");
            log("Download it from Microsoft's official page:");
            log("  https://dotnet.microsoft.com/download/dotnet/8.0");
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

        private static void AddRow(Grid g, int row, string label, UIElement field) {
            var l = new TextBlock { Text = label, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(2) };
            Grid.SetRow(l, row); Grid.SetColumn(l, 0); g.Children.Add(l);
            Grid.SetRow(field, row); Grid.SetColumn(field, 1); g.Children.Add(field);
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

        private static (int code, string output) RunCapture(string exe, string args, string? workDir) {
            try {
                var psi = new ProcessStartInfo {
                    FileName = exe, Arguments = args, UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardOutput = true, RedirectStandardError = true,
                    WorkingDirectory = workDir ?? Environment.CurrentDirectory,
                };
                using var p = Process.Start(psi);
                if (p == null) return (-1, "could not start " + exe);
                // Async concurrent reads — avoids the both-streams-ReadToEnd deadlock (the patcher
                // can be chatty on both stdout and stderr).
                var oT = p.StandardOutput.ReadToEndAsync();
                var eT = p.StandardError.ReadToEndAsync();
                p.WaitForExit(120_000);
                string o = oT.GetAwaiter().GetResult() + eT.GetAwaiter().GetResult();
                return (p.ExitCode, o);
            }
            catch (Exception ex) { return (-1, ex.Message); }
        }
    }

}
