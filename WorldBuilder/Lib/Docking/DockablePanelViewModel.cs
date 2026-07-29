using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using System;
using WorldBuilder.ViewModels;

namespace WorldBuilder.Lib.Docking {
    public partial class DockablePanelViewModel : ViewModelBase, IDockable {
        private readonly DockingManager _manager;

        public string Id { get; }

        [ObservableProperty]
        private string _title;

        [ObservableProperty]
        private bool _isVisible = true;

        [ObservableProperty]
        private DockLocation _location;

        public object Content { get; }

        /// <summary>
        /// Optional size hint used ONLY when this panel is torn off into a floating window (the
        /// docked regions are fixed-width by the editor's grid). Null = the floating window's
        /// default 300x400. Panels whose content is genuinely wider — the Texture Picker's candidate
        /// grid, for one — set it so floating does not chop a column off.
        /// </summary>
        public double? FloatWidth { get; set; }

        public double? FloatHeight { get; set; }

        public IRelayCommand MoveUpCommand { get; }
        public IRelayCommand MoveDownCommand { get; }

        public DockablePanelViewModel(string id, string title, object content, DockingManager manager) {
            Id = id;
            Title = title;
            Content = content;
            _manager = manager;
            _location = DockLocation.Left; // Default

            MoveUpCommand = new RelayCommand(() => _manager.MovePanelUp(this));
            MoveDownCommand = new RelayCommand(() => _manager.MovePanelDown(this));
        }

        partial void OnIsVisibleChanged(bool value) {
            _manager.UpdatePanelLocation(this);
        }

        partial void OnLocationChanged(DockLocation value) {
            _manager.UpdatePanelLocation(this);
        }

        [RelayCommand]
        public void Close() {
            IsVisible = false;
        }

        [RelayCommand]
        public void Float() {
            Location = DockLocation.Floating;
        }

        [RelayCommand]
        public void Dock() {
             // Default to Left if previously Floating? Or keep previous?
             // Maybe we need a parameter or just default to Left/Right depending on ID?
             // For now, let's default to Left.
             Location = DockLocation.Left;
        }

        [RelayCommand]
        public void DockTo(object parameter) {
            if (parameter is DockLocation loc) {
                Location = loc;
            }
            else if (parameter is string str && Enum.TryParse<DockLocation>(str, out var parsed)) {
                Location = parsed;
            }
        }
    }
}
