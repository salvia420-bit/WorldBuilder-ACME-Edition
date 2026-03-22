using CommunityToolkit.Mvvm.ComponentModel;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Types;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using WorldBuilder.Lib.Settings;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Models;
using WorldBuilder.ViewModels;

namespace WorldBuilder.Editors.Layout {
    public partial class LayoutEditorViewModel : ViewModelBase {
        private IDatReaderWriter? _dats;
        private Project? _project;
        private uint[] _allLayoutIds = Array.Empty<uint>();

        [ObservableProperty] private string _statusText = "No layouts loaded";
        [ObservableProperty] private string _searchText = "";
        [ObservableProperty] private ObservableCollection<LayoutListItem> _filteredLayouts = new();
        [ObservableProperty] private LayoutListItem? _selectedLayout;
        [ObservableProperty] private LayoutDetailViewModel? _selectedDetail;

        public WorldBuilderSettings Settings { get; }

        public LayoutEditorViewModel(WorldBuilderSettings settings) {
            Settings = settings;
        }

        internal void Init(Project project) {
            _project = project;
            _dats = project.DocumentManager.Dats;
            LoadLayoutIds();
        }

        private void LoadLayoutIds() {
            if (_dats == null) return;

            try {
                _allLayoutIds = _dats.Dats.GetAllIdsOfType<LayoutDesc>().OrderBy(id => id).ToArray();
                StatusText = $"Found {_allLayoutIds.Length} UI layouts";
            }
            catch (Exception ex) {
                StatusText = $"Failed to load layout IDs: {ex.Message}";
                Console.WriteLine($"[Layout] Error: {ex}");
            }

            ApplyFilter();
        }

        partial void OnSearchTextChanged(string value) {
            ApplyFilter();
        }

        private void ApplyFilter() {
            var query = SearchText?.Trim().ToUpperInvariant() ?? "";
            IEnumerable<uint> results = _allLayoutIds;

            if (!string.IsNullOrEmpty(query)) {
                var hex = query.TrimStart('0', 'X');
                results = results.Where(id => id.ToString("X8").Contains(hex));
            }

            var items = results.Take(500)
                .Select(id => new LayoutListItem(id))
                .ToList();

            FilteredLayouts = new ObservableCollection<LayoutListItem>(items);
        }

        partial void OnSelectedLayoutChanged(LayoutListItem? value) {
            if (value == null || _dats == null) {
                SelectedDetail = null;
                return;
            }

            try {
                if (_dats.TryGet<LayoutDesc>(value.Id, out var layout)) {
                    SelectedDetail = new LayoutDetailViewModel(value.Id, layout);
                    StatusText = $"Layout 0x{value.Id:X8}: {layout.Width}x{layout.Height}, {layout.Elements.Count} elements";
                }
                else {
                    SelectedDetail = null;
                    StatusText = $"Failed to read layout 0x{value.Id:X8}";
                }
            }
            catch (Exception ex) {
                SelectedDetail = null;
                StatusText = $"Error reading layout: {ex.Message}";
                Console.WriteLine($"[Layout] Error reading 0x{value.Id:X8}: {ex}");
            }
        }
    }

    public class LayoutListItem {
        public uint Id { get; }
        public string DisplayId { get; }

        public LayoutListItem(uint id) {
            Id = id;
            DisplayId = $"0x{id:X8}";
        }

        public override string ToString() => DisplayId;
    }

    public partial class LayoutDetailViewModel : ObservableObject {
        public uint LayoutId { get; }
        public string LayoutIdHex { get; }
        public uint Width { get; }
        public uint Height { get; }
        public int ElementCount { get; }

        public ObservableCollection<ElementTreeNode> RootElements { get; } = new();

        [ObservableProperty] private ElementTreeNode? _selectedElement;

        public LayoutDetailViewModel(uint id, LayoutDesc layout) {
            LayoutId = id;
            LayoutIdHex = $"0x{id:X8}";
            Width = layout.Width;
            Height = layout.Height;
            ElementCount = layout.Elements.Count;

            foreach (var kvp in layout.Elements.OrderBy(e => e.Value.ReadOrder)) {
                RootElements.Add(new ElementTreeNode(kvp.Value));
            }
        }
    }

    public class ElementTreeNode {
        public uint ElementId { get; }
        public string DisplayId { get; }
        public uint Type { get; }
        public string TypeHex { get; }
        public uint X { get; }
        public uint Y { get; }
        public uint Width { get; }
        public uint Height { get; }
        public uint ZLevel { get; }
        public uint BaseElement { get; }
        public uint BaseLayoutId { get; }
        public string BaseLayoutHex { get; }
        public uint LeftEdge { get; }
        public uint TopEdge { get; }
        public uint RightEdge { get; }
        public uint BottomEdge { get; }
        public uint ReadOrder { get; }
        public int StatesCount { get; }
        public int ChildrenCount { get; }

        public string Summary { get; }

        public ObservableCollection<ElementTreeNode> Children { get; } = new();

        public ElementTreeNode(ElementDesc element) {
            ElementId = element.ElementId;
            DisplayId = $"0x{element.ElementId:X}";
            Type = element.Type;
            TypeHex = element.Type != 0 ? $"0x{element.Type:X8}" : "inherit";
            X = element.X;
            Y = element.Y;
            Width = element.Width;
            Height = element.Height;
            ZLevel = element.ZLevel;
            BaseElement = element.BaseElement;
            BaseLayoutId = element.BaseLayoutId;
            BaseLayoutHex = element.BaseLayoutId != 0 ? $"0x{element.BaseLayoutId:X8}" : "none";
            LeftEdge = element.LeftEdge;
            TopEdge = element.TopEdge;
            RightEdge = element.RightEdge;
            BottomEdge = element.BottomEdge;
            ReadOrder = element.ReadOrder;
            StatesCount = element.States?.Count ?? 0;
            ChildrenCount = element.Children?.Count ?? 0;

            Summary = $"#{DisplayId} {TypeHex} ({Width}x{Height})";

            if (element.Children != null) {
                foreach (var kvp in element.Children.OrderBy(c => c.Value.ReadOrder)) {
                    Children.Add(new ElementTreeNode(kvp.Value));
                }
            }
        }
    }
}
