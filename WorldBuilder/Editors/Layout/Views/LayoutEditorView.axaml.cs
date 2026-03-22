using Avalonia.Controls;
using Avalonia.Markup.Xaml;
using WorldBuilder.Lib;
using System;
using System.ComponentModel;

namespace WorldBuilder.Editors.Layout.Views {
    public partial class LayoutEditorView : UserControl {
        private LayoutEditorViewModel? _viewModel;
        private LayoutPreviewCanvas? _previewCanvas;

        public LayoutEditorView() {
            InitializeComponent();

            if (Design.IsDesignMode) return;

            _viewModel = ProjectManager.Instance.GetProjectService<LayoutEditorViewModel>()
                ?? throw new Exception("Failed to get LayoutEditorViewModel");

            DataContext = _viewModel;

            if (ProjectManager.Instance.CurrentProject != null) {
                _viewModel.Init(ProjectManager.Instance.CurrentProject);
            }

            _previewCanvas = this.FindControl<LayoutPreviewCanvas>("PreviewCanvas");

            _viewModel.PropertyChanged += OnViewModelPropertyChanged;
            UpdatePreview();
        }

        private void OnViewModelPropertyChanged(object? sender, PropertyChangedEventArgs e) {
            if (e.PropertyName == nameof(LayoutEditorViewModel.SelectedDetail)) {
                if (_viewModel?.SelectedDetail != null) {
                    _viewModel.SelectedDetail.PropertyChanged += OnDetailPropertyChanged;
                }
                UpdatePreview();
            }
        }

        private void OnDetailPropertyChanged(object? sender, PropertyChangedEventArgs e) {
            if (e.PropertyName == nameof(LayoutDetailViewModel.SelectedElement)) {
                UpdatePreview();
            }
        }

        private void UpdatePreview() {
            if (_previewCanvas == null) return;
            _previewCanvas.SetLayout(
                _viewModel?.SelectedDetail?.RootElements,
                _viewModel?.SelectedDetail?.Width ?? 0,
                _viewModel?.SelectedDetail?.Height ?? 0,
                _viewModel?.SelectedDetail?.SelectedElement);
        }

        private void InitializeComponent() {
            AvaloniaXamlLoader.Load(this);
        }
    }
}
