using System;

namespace AcmeRedline.UI {
    /// <summary>
    /// The plugin's view of its panel, with NO RmlUi type anywhere in the signature.
    ///
    /// WHY THIS INTERFACE EXISTS — it is not architecture for its own sake.
    /// <see cref="RedlinePanel"/> has fields typed <c>RmlUi.RmlUiPlugin</c> and
    /// <c>RmlUi.Lib.Panel</c>. The CLR resolves a type's field types when it lays that type
    /// out, so merely JIT-ing a method that mentions <c>RedlinePanel</c> — even
    /// <c>_panel?.Hide()</c> on a null reference — loads <c>RmlUi.dll</c> or dies with a
    /// <see cref="System.IO.FileNotFoundException"/>. Since the RmlUi dependency is now
    /// OPTIONAL (manifest.json: <c>RmlUi@0.0.10?</c>), the plugin must be able to run its
    /// HUD-only path on an install that has no RmlUi plugin folder at all, so
    /// <see cref="AcmeRedlinePlugin"/> holds the panel through this interface and never
    /// names the concrete type outside <see cref="RedlinePanelFactory"/>.
    ///
    /// Corollary: nothing here may expose an RmlUi type, not even indirectly.
    /// </summary>
    public interface IRedlinePanel : IDisposable {
        /// <summary>True only while the panel exists AND is actually shown.</summary>
        bool IsOpen { get; }

        /// <summary>Create (or re-show) the panel.</summary>
        void Show();

        /// <summary>Hide the panel without destroying it.</summary>
        void Hide();

        /// <summary>Refresh every part of the panel from live state.</summary>
        void RefreshAll();

        /// <summary>Raised when the user hits submit. The plugin owns what happens next.</summary>
        event EventHandler<SubmitRequestedEventArgs>? OnSubmitRequested;

        /// <summary>Raised when the user toggles the status-tint overlay.</summary>
        event EventHandler<bool>? OnStatusOverlayToggled;

        /// <summary>
        /// Raised when the user clicks the panel's master enable/disable control. The argument
        /// is the state the user asked for. The panel does NOT apply it: turning the tool off
        /// tears down input and D3D device hooks, which only the plugin can do.
        /// </summary>
        event EventHandler<bool>? OnMasterEnableRequested;
    }
}
