using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using System;
using System.Collections.ObjectModel;
using System.Linq;
using System.Numerics;
using WorldBuilder.Editors.Landscape;
using WorldBuilder.Shared.Models;
using WorldBuilder.ViewModels;
using ViewModels = WorldBuilder.Editors.Landscape.ViewModels;

namespace WorldBuilder.Editors.Landscape {
    /// <summary>
    /// Display item for one outdoor instance placement in the ACE Instances panel list.
    /// </summary>
    public class OutdoorPlacementItemViewModel : ObservableObject {
        public int Index { get; }
        public OutdoorInstancePlacement Placement { get; }
        public string DisplayText => $"LB {Placement.LandblockId:X4} cell {Placement.CellNumber} — WCID {Placement.WeenieClassId} at ({Placement.OriginX:F1}, {Placement.OriginY:F1}, {Placement.OriginZ:F1})";

        public OutdoorPlacementItemViewModel(int index, OutdoorInstancePlacement placement) {
            Index = index;
            Placement = placement;
        }
    }

    /// <summary>
    /// Panel ViewModel for placing ACE DB instances (generators/items/portals) in the world from the Terrain editor.
    /// Uses Settings → ACE Database for connection; placements are stored on Project and exported to landblock_instances.sql.
    /// </summary>
    public partial class AceInstancesPanelViewModel : ViewModelBase {
        private readonly ViewModels.LandscapeEditorViewModel _editor;

        public WeeniePickerViewModel? WeeniePicker { get; }

        public ObservableCollection<OutdoorPlacementItemViewModel> Placements { get; } = new();

        public AceInstancesPanelViewModel(ViewModels.LandscapeEditorViewModel editor) {
            _editor = editor;
            WeeniePicker = new WeeniePickerViewModel(editor.Settings);
            RefreshPlacements();
        }

        public void RefreshPlacements() {
            Placements.Clear();
            var project = _editor.Project;
            if (project?.OutdoorInstancePlacements == null) return;
            for (int i = 0; i < project.OutdoorInstancePlacements.Count; i++)
                Placements.Add(new OutdoorPlacementItemViewModel(i, project.OutdoorInstancePlacements[i]));
        }

        [RelayCommand]
        private void PlaceAtCurrentPosition() {
            var project = _editor.Project;
            var ts = _editor.TerrainSystem;
            if (project == null || ts?.Scene?.PerspectiveCamera == null) {
                WeeniePicker!.StatusMessage = "No project or camera.";
                return;
            }
            if (WeeniePicker?.SelectedWeenie == null) {
                WeeniePicker!.StatusMessage = "Select a weenie from the list first (Load weenies, then select).";
                return;
            }

            var cam = ts.Scene.PerspectiveCamera.Position;
            float len = TerrainDataManager.LandblockLength;
            int lbX = Math.Clamp((int)(cam.X / len), 0, (int)TerrainDataManager.MapSize - 1);
            int lbY = Math.Clamp((int)(cam.Y / len), 0, (int)TerrainDataManager.MapSize - 1);
            ushort landblockId = (ushort)((lbX << 8) | lbY);
            float baseX = lbX * len;
            float baseY = lbY * len;
            var placement = new OutdoorInstancePlacement {
                LandblockId = landblockId,
                WeenieClassId = WeeniePicker.SelectedWeenie.ClassId,
                CellNumber = 1,
                OriginX = cam.X - baseX,
                OriginY = cam.Y - baseY,
                OriginZ = cam.Z,
                AnglesW = 1f,
                AnglesX = 0f,
                AnglesY = 0f,
                AnglesZ = 0f,
            };
            project.OutdoorInstancePlacements.Add(placement);
            project.Save();
            RefreshPlacements();
            WeeniePicker.StatusMessage = $"Placed at LB {landblockId:X4}.";
        }

        [RelayCommand]
        private void RemovePlacement(int index) {
            var project = _editor.Project;
            if (project?.OutdoorInstancePlacements == null || index < 0 || index >= project.OutdoorInstancePlacements.Count)
                return;
            project.OutdoorInstancePlacements.RemoveAt(index);
            project.Save();
            RefreshPlacements();
        }
    }
}
