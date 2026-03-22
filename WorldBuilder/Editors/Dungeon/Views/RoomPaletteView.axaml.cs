using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Markup.Xaml;

namespace WorldBuilder.Editors.Dungeon.Views {
    public partial class RoomPaletteView : UserControl {
        public RoomPaletteView() {
            InitializeComponent();
        }

        private void InitializeComponent() {
            AvaloniaXamlLoader.Load(this);
        }

        private void PrefabItem_PointerEntered(object? sender, PointerEventArgs e) {
            if (sender is Control c && c.DataContext is PrefabListEntry entry &&
                DataContext is RoomPaletteViewModel vm) {
                vm.NotifyPrefabHover(entry.Prefab);
            }
        }

        private void PrefabItem_PointerExited(object? sender, PointerEventArgs e) {
            if (DataContext is RoomPaletteViewModel vm) {
                vm.NotifyPrefabHover(null);
            }
        }

        private void FavoriteStar_Click(object? sender, Avalonia.Interactivity.RoutedEventArgs e) {
            System.Console.WriteLine($"[FavStar] Click fired! sender={sender?.GetType().Name}, senderDC={((sender as Control)?.DataContext)?.GetType().Name}, viewDC={DataContext?.GetType().Name}");
            
            // Walk up to find the PrefabListEntry from the DataTemplate context
            PrefabListEntry? entry = null;
            if (sender is Control ctrl) {
                var dc = ctrl.DataContext;
                if (dc is PrefabListEntry ple) entry = ple;
                // If the button's own DC isn't set, walk up the visual tree
                if (entry == null) {
                    var parent = ctrl.Parent;
                    while (parent != null && entry == null) {
                        if (parent.DataContext is PrefabListEntry parentPle) entry = parentPle;
                        parent = parent.Parent;
                    }
                }
            }

            if (entry != null && DataContext is RoomPaletteViewModel vm) {
                vm.TogglePrefabFavorite(entry);
            }
            else {
                System.Console.WriteLine($"[FavStar] Failed: entry={entry != null}, vm={DataContext is RoomPaletteViewModel}");
            }
        }
    }
}
