using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Media;
using CommunityToolkit.Mvvm.Input;
using DialogHostAvalonia;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using WorldBuilder.Lib;
using WorldBuilder.Shared.Documents;

namespace WorldBuilder.Editors.Dungeon {

    /// <summary>
    /// All dialog construction for the dungeon editor. Returns parsed results so
    /// the ViewModel never builds UI controls directly.
    /// </summary>
    public class DungeonDialogService {

        public async Task<uint?> ShowNewDungeonDialog() {
            uint? result = null;
            var textBox = new TextBox {
                Text = "",
                Width = 300,
                Watermark = "Landblock hex ID for new dungeon (e.g. FFFF)"
            };
            var errorText = new TextBlock {
                Text = "",
                Foreground = Brushes.Red,
                FontSize = 12,
                IsVisible = false
            };

            await DialogHost.Show(new StackPanel {
                Margin = new Thickness(20),
                Spacing = 10,
                Children = {
                    new TextBlock {
                        Text = "New Dungeon",
                        FontSize = 16,
                        FontWeight = FontWeight.Bold
                    },
                    new TextBlock {
                        Text = "Enter a landblock ID for the new dungeon.",
                        FontSize = 12,
                        Opacity = 0.7
                    },
                    textBox,
                    errorText,
                    new StackPanel {
                        Orientation = Avalonia.Layout.Orientation.Horizontal,
                        HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Right,
                        Spacing = 10,
                        Children = {
                            new Button {
                                Content = "Cancel",
                                Command = new RelayCommand(() => DialogHost.Close("DungeonDialogHost"))
                            },
                            new Button {
                                Content = "Create",
                                Command = new RelayCommand(() => {
                                    var parsed = ParseLandblockInput(textBox.Text);
                                    if (parsed != null) {
                                        result = parsed;
                                        DialogHost.Close("DungeonDialogHost");
                                    }
                                    else {
                                        errorText.Text = "Invalid hex ID.";
                                        errorText.IsVisible = true;
                                    }
                                })
                            }
                        }
                    }
                }
            }, "DungeonDialogHost");

            return result;
        }

        public async Task<uint?> ShowOpenDungeonDialog(string currentLandblockText, Action<string> setLandblockText) {
            uint? result = null;
            var textBox = new TextBox {
                Text = currentLandblockText,
                Width = 400,
                Watermark = "Search dungeon by name or enter hex ID (e.g. 01D9)"
            };
            var errorText = new TextBlock {
                Text = "",
                Foreground = Brushes.Red,
                FontSize = 12,
                IsVisible = false
            };

            var locationList = new ListBox {
                MaxHeight = 300,
                Width = 400,
                IsVisible = false,
                FontSize = 12,
            };

            void UpdateLocationResults(string? query) {
                if (string.IsNullOrWhiteSpace(query) || query.Length < 2) {
                    locationList.IsVisible = false;
                    locationList.ItemsSource = null;
                    return;
                }

                var results = LocationDatabase.Search(query, typeFilter: "Dungeon").Take(50).ToList();
                if (results.Count > 0) {
                    locationList.ItemsSource = results.Select(r => $"{r.Name}  [{r.LandblockHex}]").ToList();
                    locationList.IsVisible = true;
                }
                else {
                    locationList.IsVisible = false;
                    locationList.ItemsSource = null;
                }
            }

            textBox.TextChanged += (s, e) => {
                errorText.IsVisible = false;
                UpdateLocationResults(textBox.Text);
            };

            locationList.SelectionChanged += (s, e) => {
                if (locationList.SelectedIndex < 0) return;
                var query = textBox.Text;
                if (string.IsNullOrWhiteSpace(query)) return;
                var results = LocationDatabase.Search(query, typeFilter: "Dungeon").Take(50).ToList();
                if (locationList.SelectedIndex < results.Count) {
                    var selected = results[locationList.SelectedIndex];
                    setLandblockText(selected.Name);
                    result = selected.CellId;
                    DialogHost.Close("DungeonDialogHost");
                }
            };

            await DialogHost.Show(new StackPanel {
                Margin = new Thickness(20),
                Spacing = 10,
                Children = {
                    new TextBlock {
                        Text = "Open Dungeon",
                        FontSize = 16,
                        FontWeight = FontWeight.Bold
                    },
                    new TextBlock {
                        Text = "Search by dungeon name or enter a\nlandblock ID in hex (e.g. 01D9).",
                        TextWrapping = TextWrapping.Wrap,
                        MaxWidth = 400,
                        FontSize = 12,
                        Opacity = 0.7
                    },
                    textBox,
                    locationList,
                    errorText,
                    new StackPanel {
                        Orientation = Avalonia.Layout.Orientation.Horizontal,
                        HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Right,
                        Spacing = 10,
                        Children = {
                            new Button {
                                Content = "Cancel",
                                Command = new RelayCommand(() => DialogHost.Close("DungeonDialogHost"))
                            },
                            new Button {
                                Content = "Open",
                                Command = new RelayCommand(() => {
                                    if (result != null) {
                                        DialogHost.Close("DungeonDialogHost");
                                        return;
                                    }
                                    var parsed = ParseLandblockInput(textBox.Text);
                                    if (parsed != null) {
                                        setLandblockText(textBox.Text ?? "");
                                        result = parsed;
                                        DialogHost.Close("DungeonDialogHost");
                                    }
                                    else {
                                        errorText.Text = "Invalid input. Try a dungeon name or hex ID.";
                                        errorText.IsVisible = true;
                                    }
                                })
                            }
                        }
                    }
                }
            }, "DungeonDialogHost");

            return result;
        }

        public void ShowValidationDialog(
            List<DungeonDocument.ValidationResult> results,
            Action<ushort> selectCellByNumber,
            Action autoFixPortals,
            Action computeVisibility) {

            var errors = results.Count(r => r.Severity == DungeonDocument.ValidationSeverity.Error);
            var warnings = results.Count(r => r.Severity == DungeonDocument.ValidationSeverity.Warning);
            var title = errors > 0 ? $"Validation: {errors} error(s), {warnings} warning(s)"
                : warnings > 0 ? $"Validation: {warnings} warning(s)"
                : "Validation: All clear";

            var listBox = new ListBox {
                FontSize = 12,
                FontFamily = new FontFamily("Consolas"),
                Background = Brushes.Transparent,
                MaxHeight = 350,
            };
            foreach (var r in results) {
                var color = r.Severity switch {
                    DungeonDocument.ValidationSeverity.Error => "#ff6666",
                    DungeonDocument.ValidationSeverity.Warning => "#ffcc44",
                    _ => "#88cc88"
                };
                var item = new ListBoxItem {
                    Content = new TextBlock {
                        Text = $"{r.Icon} {r.Message}",
                        Foreground = new SolidColorBrush(Color.Parse(color)),
                        TextWrapping = Avalonia.Media.TextWrapping.Wrap,
                        FontSize = 11,
                    },
                    Tag = r.CellNumber,
                };
                listBox.Items.Add(item);
            }

            listBox.SelectionChanged += (s, e) => {
                if (listBox.SelectedItem is ListBoxItem li && li.Tag is ushort cellNum) {
                    selectCellByNumber(cellNum);
                }
            };

            var autoFixBtn = new Button {
                Content = "Auto-Fix One-Way Portals",
                Margin = new Thickness(0, 8, 0, 0),
                Padding = new Thickness(12, 6),
                FontSize = 11,
            };

            var computeVisBtn = new Button {
                Content = "Compute VisibleCells",
                Margin = new Thickness(8, 8, 0, 0),
                Padding = new Thickness(12, 6),
                FontSize = 11,
            };

            var panel = new StackPanel { Width = 550, Margin = new Thickness(16) };
            panel.Children.Add(new TextBlock {
                Text = title,
                FontSize = 14,
                FontWeight = FontWeight.SemiBold,
                Foreground = new SolidColorBrush(Color.Parse("#c0b0d8")),
                Margin = new Thickness(0, 0, 0, 8),
            });
            panel.Children.Add(listBox);

            var btnRow = new StackPanel { Orientation = Avalonia.Layout.Orientation.Horizontal };
            if (results.Any(r => r.Message.Contains("One-way")))
                btnRow.Children.Add(autoFixBtn);
            if (results.Any(r => r.Message.Contains("VisibleCells")))
                btnRow.Children.Add(computeVisBtn);
            if (btnRow.Children.Count > 0)
                panel.Children.Add(btnRow);

            autoFixBtn.Click += (s, e) => {
                autoFixPortals();
                DialogHost.Close("DungeonDialogHost");
            };

            computeVisBtn.Click += (s, e) => {
                computeVisibility();
                DialogHost.Close("DungeonDialogHost");
            };

            DialogHost.Show(panel, "DungeonDialogHost");
        }

        public void ShowErrorDialog(string title, string message) {
            var win = new Window { Title = title, Width = 400, Height = 180, WindowStartupLocation = WindowStartupLocation.CenterOwner };
            var panel = new StackPanel { Spacing = 12, Margin = new Thickness(24) };
            panel.Children.Add(new TextBlock { Text = title, FontWeight = FontWeight.SemiBold, FontSize = 14 });
            panel.Children.Add(new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap });
            var okBtn = new Button { Content = "OK", Width = 80 };
            okBtn.Click += (s, e) => win.Close();
            panel.Children.Add(okBtn);
            win.Content = panel;
            if (Application.Current?.ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop && desktop.MainWindow != null)
                win.Show(desktop.MainWindow);
            else
                win.Show();
        }

        public void ShowAnalysisResultDialog(WorldBuilder.Shared.Lib.Dungeon.DungeonRoomAnalyzer.AnalysisReport report, string outPath) {
            var jsonPath = Path.Combine(Path.GetDirectoryName(outPath) ?? "", Path.GetFileNameWithoutExtension(outPath) + ".json");
            var txtPath = Path.Combine(Path.GetDirectoryName(outPath) ?? "", Path.GetFileNameWithoutExtension(outPath) + ".txt");

            var panel = new StackPanel { Spacing = 12, Margin = new Thickness(24) };
            panel.Children.Add(new TextBlock {
                Text = "Dungeon Room Analysis Complete",
                FontWeight = FontWeight.SemiBold,
                FontSize = 14
            });
            panel.Children.Add(new TextBlock {
                Text = $"Scanned {report.TotalLandblocksScanned} landblocks, {report.TotalCellsScanned} cells.\n" +
                       $"Found {report.UniqueRoomTypes} unique room types.\n\n" +
                       $"Top starter candidates (for preset list):",
                TextWrapping = TextWrapping.Wrap
            });
            var sb = new System.Text.StringBuilder();
            foreach (var r in report.TopStarterCandidates.Take(12)) {
                sb.AppendLine($"  {r.PortalCount}P: 0x{r.EnvFileId:X8} / #{r.CellStructIndex}  (used {r.UsageCount}x)");
            }
            panel.Children.Add(new TextBlock {
                Text = sb.ToString(),
                FontFamily = "Consolas",
                FontSize = 10,
                TextWrapping = TextWrapping.NoWrap
            });
            panel.Children.Add(new TextBlock {
                Text = $"Report saved to:\n{txtPath}\n{jsonPath}",
                FontSize = 10,
                Foreground = new SolidColorBrush(Color.FromArgb(255, 138, 122, 158)),
                TextWrapping = TextWrapping.Wrap
            });
            var win = new Window { Title = "Dungeon Room Analysis", WindowStartupLocation = WindowStartupLocation.CenterOwner };
            var okBtn = new Button { Content = "OK", Width = 80 };
            okBtn.Click += (s, e) => win.Close();
            panel.Children.Add(okBtn);
            win.Content = new ScrollViewer { Content = panel };
            win.Width = 480;
            win.Height = 420;
            if (Application.Current?.ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop && desktop.MainWindow != null) {
                win.Show(desktop.MainWindow);
            }
            else {
                win.Show();
            }
        }

        public async Task<GeneratorParams?> ShowGenerateDialog(DungeonKnowledgeBase kb) {
            GeneratorParams? result = null;

            var styles = new List<string> { "All" };
            var seenStyles = kb.Catalog
                .Select(c => c.Style)
                .Where(s => !string.IsNullOrEmpty(s))
                .Distinct()
                .OrderBy(s => s);
            styles.AddRange(seenStyles);

            var roomCount = new NumericUpDown { Value = 10, Minimum = 3, Maximum = 50, Width = 100, FontSize = 12 };
            var styleCombo = new ComboBox {
                FontSize = 12, Width = 150,
                ItemsSource = styles,
                SelectedIndex = 0,
            };
            var seedBox = new TextBox { Text = "0", Width = 100, FontSize = 12, Watermark = "0 = random" };

            var panel = new StackPanel { Width = 380, Margin = new Thickness(16), Spacing = 8 };
            panel.Children.Add(new TextBlock {
                Text = "Generate Dungeon",
                FontSize = 16, FontWeight = FontWeight.SemiBold,
                Foreground = new SolidColorBrush(Color.Parse("#c0b0d8")),
                Margin = new Thickness(0, 0, 0, 4)
            });
            panel.Children.Add(new TextBlock {
                Text = $"Builds a new dungeon by chaining multi-cell pieces using {kb.TotalEdges:N0} proven connections from {kb.DungeonsScanned:N0} real dungeons. " +
                       "Each piece is 2-5 cells with correct internal geometry. Connection points use portal transforms from original game data.",
                FontSize = 11, Foreground = new SolidColorBrush(Color.Parse("#8a7a9e")),
                TextWrapping = TextWrapping.Wrap, MaxWidth = 350,
                Margin = new Thickness(0, 0, 0, 4)
            });

            void AddRow(string label, Control control) {
                var row = new DockPanel { Margin = new Thickness(0, 2) };
                row.Children.Add(new TextBlock {
                    Text = label, FontSize = 11, Width = 120,
                    Foreground = new SolidColorBrush(Color.Parse("#8a7a9e")),
                    VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center
                });
                row.Children.Add(control);
                panel.Children.Add(row);
            }

            var requireRoofCheck = new CheckBox {
                Content = "Only use roofed pieces", IsChecked = true, FontSize = 11,
                Foreground = new SolidColorBrush(Color.Parse("#c0b0d8"))
            };
            var lockStyleCheck = new CheckBox {
                Content = "Keep consistent style", IsChecked = true, FontSize = 11,
                Foreground = new SolidColorBrush(Color.Parse("#c0b0d8"))
            };
            var allowVerticalCheck = new CheckBox {
                Content = "Allow vertical connections (ramps/stairs)", IsChecked = false, FontSize = 11,
                Foreground = new SolidColorBrush(Color.Parse("#c0b0d8"))
            };

            AddRow("Rooms:", roomCount);
            AddRow("Style:", styleCombo);
            AddRow("Seed:", seedBox);
            panel.Children.Add(new Border { Height = 4 });
            panel.Children.Add(requireRoofCheck);
            panel.Children.Add(lockStyleCheck);
            panel.Children.Add(allowVerticalCheck);

            var btnRow = new StackPanel {
                Orientation = Avalonia.Layout.Orientation.Horizontal, Spacing = 8,
                Margin = new Thickness(0, 12, 0, 0),
                HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Right
            };
            var genBtn = new Button { Content = "Generate", Padding = new Thickness(16, 8), FontSize = 12 };
            var cancelBtn = new Button { Content = "Cancel", Padding = new Thickness(16, 8), FontSize = 12 };

            genBtn.Click += (s, e) => {
                int.TryParse(seedBox.Text, out var seed);
                result = new GeneratorParams {
                    PrefabCount = (int)(roomCount.Value ?? 10),
                    Style = styleCombo.SelectedItem as string ?? "All",
                    Seed = seed,
                    RequireRoof = requireRoofCheck.IsChecked == true,
                    AllowVertical = allowVerticalCheck.IsChecked == true,
                    LockStyle = lockStyleCheck.IsChecked == true,
                };
                DialogHost.Close("DungeonDialogHost");
            };
            cancelBtn.Click += (s, e) => DialogHost.Close("DungeonDialogHost");

            btnRow.Children.Add(cancelBtn);
            btnRow.Children.Add(genBtn);
            panel.Children.Add(btnRow);

            await DialogHost.Show(panel, "DungeonDialogHost");
            return result;
        }

        /// <returns>(sourceLb, targetLb) on success, null if cancelled.</returns>
        public async Task<(ushort sourceLb, ushort targetLb)?> ShowStartFromTemplateDialog(Action<ushort, ushort> copyTemplate) {
            var dungeons = LocationDatabase.Dungeons
                .OrderBy(d => d.Name)
                .Take(200)
                .ToList();

            if (dungeons.Count == 0) return null;

            var listBox = new ListBox {
                MaxHeight = 280,
                Width = 450,
                FontSize = 12,
                ItemsSource = dungeons.Select(d => $"{d.Name}  [LB {d.LandblockHex}]").ToList()
            };
            var targetTextBox = new TextBox {
                Text = "",
                Width = 120,
                Watermark = "e.g. FFFF"
            };
            var errorText = new TextBlock {
                Text = "",
                Foreground = Brushes.Red,
                FontSize = 12,
                IsVisible = false
            };

            await DialogHost.Show(new StackPanel {
                Margin = new Thickness(20),
                Spacing = 10,
                Children = {
                    new TextBlock {
                        Text = "Start from template",
                        FontSize = 16,
                        FontWeight = FontWeight.Bold
                    },
                    new TextBlock {
                        Text = "Pick a dungeon template, then choose the landblock where to create a copy. " +
                            "The structure (rooms, portals, statics) is copied with new locations; portal connections are preserved.",
                        TextWrapping = TextWrapping.Wrap,
                        MaxWidth = 450,
                        FontSize = 12,
                        Opacity = 0.8
                    },
                    listBox,
                    new StackPanel {
                        Orientation = Avalonia.Layout.Orientation.Horizontal,
                        Spacing = 8,
                        VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center,
                        Children = {
                            new TextBlock { Text = "Target landblock:", VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center },
                            targetTextBox,
                            errorText
                        }
                    },
                    new StackPanel {
                        Orientation = Avalonia.Layout.Orientation.Horizontal,
                        HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Right,
                        Spacing = 10,
                        Children = {
                            new Button {
                                Content = "Cancel",
                                Command = new RelayCommand(() => DialogHost.Close("DungeonDialogHost"))
                            },
                            new Button {
                                Content = "Create copy",
                                Command = new RelayCommand(() => {
                                    var idx = listBox.SelectedIndex;
                                    if (idx < 0 || idx >= dungeons.Count) {
                                        errorText.Text = "Select a template.";
                                        errorText.IsVisible = true;
                                        return;
                                    }
                                    var targetParsed = ParseLandblockInput(targetTextBox.Text);
                                    if (targetParsed == null) {
                                        errorText.Text = "Invalid landblock ID.";
                                        errorText.IsVisible = true;
                                        return;
                                    }
                                    var sourceLb = dungeons[idx].LandblockId;
                                    var targetLb = (ushort)(targetParsed.Value >> 16);
                                    if (targetLb == 0) targetLb = (ushort)(targetParsed.Value & 0xFFFF);
                                    if (sourceLb == targetLb) {
                                        errorText.Text = "Target must differ from template.";
                                        errorText.IsVisible = true;
                                        return;
                                    }
                                    copyTemplate(sourceLb, targetLb);
                                    DialogHost.Close("DungeonDialogHost");
                                })
                            }
                        }
                    }
                }
            }, "DungeonDialogHost");

            return null;
        }

        public static uint? ParseLandblockInput(string? input) {
            if (string.IsNullOrWhiteSpace(input)) return null;
            input = input.Trim();

            var hex = input;
            if (hex.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
                hex = hex[2..];

            if (hex.Length > 4 && hex.Length <= 8) {
                if (uint.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var fullId))
                    return fullId;
                return null;
            }

            if (ushort.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var lbId))
                return (uint)(lbId << 16);

            return null;
        }
    }
}
