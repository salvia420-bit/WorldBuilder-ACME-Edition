using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Markup.Xaml;
using Avalonia.Threading;
using Silk.NET.OpenGL;
using System;
using System.Numerics;
using WorldBuilder.Lib;
using WorldBuilder.Views;

namespace WorldBuilder.Editors.Dungeon.Views {
    public partial class DungeonViewportControl : Base3DView {
        private DungeonEditorViewModel? _viewModel;
        private bool _didInit;

        public DungeonViewportControl() {
            InitializeComponent();
            InitializeBase3DView();
        }

        private void InitializeComponent() {
            AvaloniaXamlLoader.Load(this);
        }

        protected override void OnDataContextChanged(EventArgs e) {
            base.OnDataContextChanged(e);
            _viewModel = DataContext as DungeonEditorViewModel;
        }

        protected override void OnGlInit(GL gl, PixelSize canvasSize) {
            if (_viewModel != null && Renderer != null) {
                _viewModel.OnRendererReady(Renderer);
                _didInit = true;
            }
        }

        protected override void OnGlRender(double deltaTime) {
            if (!_didInit || _viewModel == null) return;
            _viewModel.RenderFrame(deltaTime, new PixelSize((int)Bounds.Width, (int)Bounds.Height), InputState);
        }

        protected override void OnGlResize(PixelSize canvasSize) { }

        protected override void OnGlDestroy() { }

        protected override void OnGlKeyDown(KeyEventArgs e) {
            _viewModel?.HandleKeyDown(e);
        }

        protected override void OnGlKeyUp(KeyEventArgs e) { }

        protected override void OnGlPointerMoved(PointerEventArgs e, Vector2 mousePositionScaled) {
            UpdateMouseState(e.GetPosition(this), e.GetCurrentPoint(this).Properties);
            _viewModel?.HandlePointerMoved(InputState);
        }

        protected override void OnGlPointerWheelChanged(PointerWheelEventArgs e) {
            _viewModel?.HandlePointerWheel(e);
        }

        protected override void OnGlPointerPressed(PointerPressedEventArgs e) {
            var props = e.GetCurrentPoint(this).Properties;
            UpdateMouseState(e.GetPosition(this), props);

            if (props.IsRightButtonPressed && _viewModel != null) {
                ShowCellContextMenu(e);
                return;
            }

            _viewModel?.HandlePointerPressed(InputState);
            e.Pointer.Capture(this);
        }

        protected override void OnGlPointerReleased(PointerReleasedEventArgs e) {
            UpdateMouseState(e.GetPosition(this), e.GetCurrentPoint(this).Properties);
            _viewModel?.HandlePointerReleased(InputState);
            e.Pointer.Capture(null);
        }

        private void ShowCellContextMenu(PointerPressedEventArgs e) {
            if (_viewModel == null) return;

            var mouse = InputState.MouseState;
            var scene = _viewModel.Scene;
            if (scene?.Camera == null) return;

            float w = scene.Camera.ScreenSize.X, h = scene.Camera.ScreenSize.Y;
            if (w <= 0 || h <= 0) return;

            float ndcX = 2f * mouse.Position.X / w - 1f;
            float ndcY = 2f * mouse.Position.Y / h - 1f;

            var projection = scene.Camera.GetProjectionMatrix();
            var view = scene.Camera.GetViewMatrix();
            if (!Matrix4x4.Invert(view * projection, out var vpInverse)) return;

            var nearW = Vector4.Transform(new Vector4(ndcX, ndcY, -1f, 1f), vpInverse);
            var farW = Vector4.Transform(new Vector4(ndcX, ndcY, 1f, 1f), vpInverse);
            nearW /= nearW.W;
            farW /= farW.W;

            var rayOrigin = new Vector3(nearW.X, nearW.Y, nearW.Z);
            var rayDir = Vector3.Normalize(new Vector3(farW.X, farW.Y, farW.Z) - rayOrigin);

            var items = _viewModel.GetCellContextMenuItems(rayOrigin, rayDir);
            if (items.Count == 0) return;

            var menu = new ContextMenu();
            foreach (var (label, action, isEnabled) in items) {
                var mi = new MenuItem { Header = label, IsEnabled = isEnabled };
                if (isEnabled) {
                    var a = action;
                    mi.Click += (s, args) => a();
                }
                if (label.StartsWith("Delete")) mi.Foreground = Avalonia.Media.Brushes.IndianRed;
                if (label.StartsWith("Disconnect")) mi.Foreground = Avalonia.Media.Brushes.Salmon;
                menu.Items.Add(mi);
            }

            menu.Open(this);
            e.Handled = true;
        }

        protected override void UpdateMouseState(Avalonia.Point position, PointerPointProperties properties) {
            var scale = InputScale;
            if (scale == Vector2.Zero) scale = Vector2.One;

            var width = (int)(Bounds.Width * scale.X);
            var height = (int)(Bounds.Height * scale.Y);
            if (width == 0) width = (int)Bounds.Width;
            if (height == 0) height = (int)Bounds.Height;

            InputState.UpdateMouseStateBasic(position, properties, width, height, scale);
        }
    }
}
