using CommunityToolkit.Mvvm.ComponentModel;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using System.Linq;

namespace WorldBuilder.Editors.Dungeon {
    public partial class CellSurfaceSlot : ObservableObject {
        public int SlotIndex { get; }
        public ushort SurfaceId { get; }
        public string DisplayText { get; }

        [ObservableProperty]
        private WriteableBitmap? _thumbnail;

        public CellSurfaceSlot(int slotIndex, ushort surfaceId, string displayText) {
            SlotIndex = slotIndex;
            SurfaceId = surfaceId;
            DisplayText = displayText;
        }
    }

    public partial class PrefabListEntry : ObservableObject {
        public DungeonPrefab Prefab { get; }
        public string DisplayName { get; }
        public string DetailText => DetailOverride ?? $"{Prefab.Cells.Count} rooms, {Prefab.OpenPortalCount} open, used {Prefab.UsageCount}x";
        public string? DetailOverride { get; set; }
        public int CellCount => Prefab.Cells.Count;
        public int OpenPortals => Prefab.OpenPortalCount;

        /// <summary>Compact cell count badge text like "3c".</summary>
        public string CellCountBadge => $"{Prefab.Cells.Count}c";

        /// <summary>Open doorway count badge like "2d".</summary>
        public string DoorCountBadge => $"{Prefab.OpenPortalCount}d";

        /// <summary>Connection directions summary, e.g. "N+S" or "N+E+Down".</summary>
        public string DirectionSummary => Prefab.ConnectionDirectionSummary;

        /// <summary>True when this prefab is compatible with currently open portals.</summary>
        public bool IsCompatible { get; set; }

        /// <summary>Roof status for display: "Roofed", "Partial Roof", "No Roof".</summary>
        public string RoofStatus {
            get {
                if (Prefab.HasNoRoof) return "No Roof";
                if (Prefab.HasPartialRoof) return "Partial Roof";
                return "";
            }
        }

        public bool ShowRoofWarning => Prefab.HasNoRoof || Prefab.HasPartialRoof;

        /// <summary>Color for the roof status indicator.</summary>
        public IBrush RoofStatusBrush {
            get {
                if (Prefab.HasNoRoof) return new SolidColorBrush(Color.FromRgb(204, 102, 102));
                if (Prefab.HasPartialRoof) return new SolidColorBrush(Color.FromRgb(189, 151, 77));
                return new SolidColorBrush(Color.FromRgb(110, 192, 122));
            }
        }

        /// <summary>Color for the compatible indicator.</summary>
        public IBrush CompatibleBrush => IsCompatible
            ? new SolidColorBrush(Color.FromRgb(110, 192, 122))
            : new SolidColorBrush(Color.FromRgb(90, 74, 110));

        /// <summary>Style tag (e.g. "Sewer", "Cave", "Crypt").</summary>
        public string StyleTag => Prefab.Style;

        /// <summary>Usage count formatted: "17k" or "342".</summary>
        public string UsageText {
            get {
                var u = Prefab.UsageCount;
                return u >= 1000 ? $"{u / 1000}k" : u.ToString();
            }
        }

        [ObservableProperty]
        private Avalonia.Media.Imaging.WriteableBitmap? _thumbnail;

        [ObservableProperty]
        private bool _isFavorite;

        /// <summary>True when this is a user-created custom prefab (from "Save Selection as Prefab").</summary>
        public bool IsCustom => Prefab.Signature.StartsWith("custom_");

        public PrefabListEntry(DungeonPrefab prefab, string displayName) {
            Prefab = prefab;
            DisplayName = displayName;
        }
    }

    public class PortalListEntry {
        public int Index { get; }
        public ushort PolygonId { get; }
        public ushort OtherCellId { get; }
        public bool IsConnected { get; }
        public string DisplayText { get; }

        public PortalListEntry(int index, ushort polygonId, ushort otherCellId, bool isConnected, string? connectedRoomName = null) {
            Index = index;
            PolygonId = polygonId;
            OtherCellId = otherCellId;
            IsConnected = isConnected;
            if (isConnected) {
                var target = !string.IsNullOrEmpty(connectedRoomName) ? connectedRoomName : $"Room 0x{otherCellId:X4}";
                DisplayText = $"Door {index + 1} → {target}";
            }
            else {
                DisplayText = $"Door (open)";
            }
        }
    }
}
