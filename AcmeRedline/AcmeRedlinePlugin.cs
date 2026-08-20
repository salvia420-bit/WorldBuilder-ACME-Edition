using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json.Serialization.Metadata;
using AcmeRedline.Lib;
using AcmeRedline.Model;
using AcmeRedline.Services;
using AcmeRedline.UI;
using Chorizite.Core;
using Chorizite.Core.Backend;
using Chorizite.Core.Backend.Client;
using Chorizite.Core.Dats;
using Chorizite.Core.Input;
using Chorizite.Core.Plugins;
using Chorizite.Core.Plugins.AssemblyLoader;
using Microsoft.Extensions.Logging;
using RmlUi;

namespace AcmeRedline {
    /// <summary>
    /// Entry point for the ACME Redline plugin.
    ///
    /// PLUGIN CONTRACT - verified against the framework, not assumed:
    ///  - A plugin is a directory under IPluginManager.PluginDirectory containing a
    ///    manifest.json; PluginManager.LoadPluginManifests enumerates those directories and
    ///    reads "manifest.json" from each
    ///    (external/chorizite/Chorizite/Chorizite.Core/Plugins/PluginManager.cs:290-308).
    ///  - The manifest shape is PluginManifest
    ///    (Chorizite.Core/Plugins/PluginManifest.cs): id, name, author, version, description,
    ///    repo, icon, dependencies, environments, entryfile.
    ///  - The entry type derives from IPluginCore
    ///    (Chorizite.Core/Plugins/AssemblyLoader/IPluginCore.cs) - an abstract CLASS, not an
    ///    interface - with a constructor that takes an AssemblyPluginManifest plus whatever
    ///    services it wants injected, and overrides Initialize() and Dispose().
    ///    The constructor is deliberately protected, matching
    ///    external/chorizite/ACPlugin/ACPlugin.cs.
    ///  - Do the real work in Initialize(), NOT the constructor: IPluginCore's own doc-comment
    ///    says state/settings/views are not ready until then.
    ///  - Settings round-trip through ISerializeSettings&lt;T&gt;
    ///    (Chorizite.Core/Plugins/AssemblyLoader/ISerializeSettings.cs), which needs a
    ///    JsonTypeInfo&lt;T&gt; - supplied here by <see cref="RedlineJsonContext"/>.
    ///
    /// Dependencies (RmlUi for the panel, AC for the account name) are declared in manifest.json
    /// and delivered by constructor injection through the Autofac scope, the same way ACPlugin
    /// receives RmlUiPlugin.
    /// </summary>
    public class AcmeRedlinePlugin : IPluginCore, ISerializeSettings<RedlineSettings> {
        internal static AcmeRedlinePlugin? Instance;

        private readonly IChoriziteBackend _backend;
        private readonly IClientBackend _client;
        private readonly IDatReaderInterface _dat;
        private readonly RmlUiPlugin _rmlUi;
        private readonly AC.ACPlugin _ac;
        private readonly ILogger _log;

        private RedlineSettings _settings = new();

        private QueueWriter? _queue;
        private StatusReader? _status;
        private KitMeta? _kit;
        private SelectionService? _selection;
        private OverlayRenderer? _overlay;
        private CaptureService? _capture;
        private RedlinePanel? _panel;
        private TextureRegistry? _textures;
        private DeviceHooks? _hooks;

        // Input wiring
        private bool _inputHooked;
        private bool _lassoDragging;

        JsonTypeInfo<RedlineSettings> ISerializeSettings<RedlineSettings>.TypeInfo =>
            RedlineJsonContext.Default.RedlineSettings;

        /// <summary>
        /// Constructor injection. Every parameter after the manifest is resolved from the plugin
        /// lifetime scope; the shape mirrors external/chorizite/ACPlugin/ACPlugin.cs's constructor.
        /// </summary>
        protected AcmeRedlinePlugin(AssemblyPluginManifest manifest,
                                    IChoriziteBackend choriziteBackend,
                                    IClientBackend clientBackend,
                                    IDatReaderInterface dat,
                                    RmlUiPlugin rmlUi,
                                    AC.ACPlugin ac,
                                    ILogger log) : base(manifest) {
            Instance = this;
            _backend = choriziteBackend;
            _client = clientBackend;
            _dat = dat;
            _rmlUi = rmlUi;
            _ac = ac;
            _log = log;
        }

        /// <inheritdoc/>
        protected override void Initialize() {
            var queueDir = QueueWriter.ResolveQueueDir(_settings.QueueDir, DataDirectory);
            _queue = new QueueWriter(queueDir, _log);
            _queue.EnsureDirectories();

            _status = new StatusReader(_queue, _log);
            _status.Refresh(force: true);

            _kit = new KitMeta(_log);
            _kit.Load(_settings.KitMetaPath, KitMetaCandidateDirs());

            _selection = new SelectionService(_dat, _client, _backend, _log);
            _capture = new CaptureService(_backend, _queue, _log);

            _textures = new TextureRegistry(_log);

            // World-space highlight via IDirect3DDevice9 vtable hooks (SkunkVision RenderHook
            // method). Client environment only: the detours read client globals that exist
            // nowhere else, and the launcher environment has no acclient to hook.
            // ChoriziteEnvironment is [Flags] (Chorizite.Core/ChoriziteEnvironment.cs), so test the
            // bit rather than comparing for equality.
            if (_backend.Environment.HasFlag(ChoriziteEnvironment.Client)) {
                _hooks = new DeviceHooks(_backend, _textures, _log);
            }
            else {
                _log.LogInformation("redline: not in the client environment; world highlight disabled");
            }

            _overlay = new OverlayRenderer(_backend, _dat, _selection, _status, _queue,
                                           _textures, _hooks, _settings, AuthorName, _log);
            _overlay.Attach();

            _panel = new RedlinePanel(
                _rmlUi, _selection, _status, _queue, _kit, _settings,
                Path.Combine(AssemblyDirectory, "assets", "panels", "Redline.rml"),
                AuthorName, _log);
            _panel.OnSubmitRequested += HandleSubmit;
            _panel.OnStatusOverlayToggled += (_, on) =>
                _log.LogInformation("redline: status overlay {State}", on ? "on" : "off");

            HookInput();

            _log.LogInformation("redline: ready. queue={Queue} kit={Kit}",
                queueDir, _kit.Meta?.KitTag ?? "(none)");
        }

        /// <inheritdoc/>
        protected override void Dispose() {
            UnhookInput();

            if (_panel is not null) _panel.OnSubmitRequested -= HandleSubmit;
            _panel?.Dispose();
            _panel = null;

            _overlay?.Dispose();
            _overlay = null;

            // Order matters: the overlay is detached first so nothing re-arms the hooks, THEN the
            // hooks are torn down. DeviceHooks.Dispose marshals the disarm onto the render thread
            // and blocks until the vtable is clean, because our detours are [UnmanagedCallersOnly]
            // stubs that die with this collectible AssemblyLoadContext.
            _hooks?.Dispose();
            _hooks = null;
            _textures = null;

            _selection = null;
            _capture = null;
            _status = null;
            _kit = null;
            _queue = null;

            Instance = null;
        }

        #region Settings serialization
        RedlineSettings ISerializeSettings<RedlineSettings>.SerializeBeforeUnload() => _settings;

        void ISerializeSettings<RedlineSettings>.DeserializeAfterLoad(RedlineSettings? settings) =>
            _settings = settings ?? new RedlineSettings();
        #endregion

        // ------------------------------------------------------------------
        // Input
        // ------------------------------------------------------------------

        /// <summary>
        /// Wire mouse + keyboard.
        ///
        /// IInputManager (external/chorizite/Chorizite/Chorizite.Core/Input/IInputManager.cs)
        /// gives MouseX/MouseY, OnMouseDown/Up/Move/Wheel, OnKeyDown/Up/Press, IsKeyPressed and
        /// IsMousePressed - which is exactly enough for click-pick, shift-add and drag-lasso.
        /// It is reached from IChoriziteBackend.Input.
        /// </summary>
        private void HookInput() {
            if (_inputHooked) return;
            var input = _backend.Input;
            if (input is null) {
                _log.LogWarning("redline: no IInputManager; picking disabled");
                return;
            }
            input.OnMouseDown += HandleMouseDown;
            input.OnMouseMove += HandleMouseMove;
            input.OnMouseUp += HandleMouseUp;
            input.OnKeyDown += HandleKeyDown;
            _inputHooked = true;
        }

        private void UnhookInput() {
            if (!_inputHooked) return;
            var input = _backend.Input;
            if (input is not null) {
                input.OnMouseDown -= HandleMouseDown;
                input.OnMouseMove -= HandleMouseMove;
                input.OnMouseUp -= HandleMouseUp;
                input.OnKeyDown -= HandleKeyDown;
            }
            _inputHooked = false;
        }

        /// <summary>
        /// Redline picking is modal: it only steals the mouse while the panel is open, so normal
        /// play is untouched when the tool is closed.
        /// </summary>
        private bool PickingActive => _panel is not null && _settings.OverlayEnabled;

        private void HandleMouseDown(object? sender, MouseDownEventArgs e) {
            if (!PickingActive || _selection is null) return;
            var input = _backend.Input;
            if (input is null) return;

            bool shift = input.IsKeyPressed(Key.LSHIFT) || input.IsKeyPressed(Key.RSHIFT);
            bool ctrl = input.IsKeyPressed(Key.LCONTROL) || input.IsKeyPressed(Key.RCONTROL);

            var mods = PickModifiers.None;
            if (shift) mods |= PickModifiers.Add;
            if (ctrl) mods |= PickModifiers.Remove;

            // A drag with shift held starts a lasso; a plain click is a point pick.
            if (shift) {
                _lassoDragging = true;
                _selection.BeginLasso(input.MouseX, input.MouseY);
            }
            _selection.PickAt(input.MouseX, input.MouseY, mods);
        }

        private void HandleMouseMove(object? sender, MouseMoveEventArgs e) {
            if (!PickingActive || _selection is null) return;
            if (!_lassoDragging) return;
            var input = _backend.Input;
            if (input is null) return;
            _selection.AddLassoPoint(input.MouseX, input.MouseY);
        }

        private void HandleMouseUp(object? sender, MouseUpEventArgs e) {
            if (!_lassoDragging || _selection is null) return;
            _lassoDragging = false;
            _selection.EndLasso();
        }

        /// <summary>
        /// F8 toggles the panel.
        ///
        /// TODO(acme-redline): make the hotkey configurable. Chorizite has no keybinding registry
        /// for plugins - searched Chorizite.Core/Input/* (raw key events only),
        /// Chorizite.Core/ChoriziteConfig.cs and IChoriziteConfig.cs (no input section), and
        /// external/chorizite/ACPlugin (binds nothing) - so any binding UI would be this plugin's
        /// own. Hardcoded until then, and only while the client has focus.
        /// </summary>
        private void HandleKeyDown(object? sender, KeyDownEventArgs e) {
            if (e.Key == Key.F8) {
                _panel?.Toggle();
            }
        }

        // ------------------------------------------------------------------
        // Submit
        // ------------------------------------------------------------------

        /// <summary>
        /// Compose a schema-v1 entry from the live selection + captured context and append it.
        /// Everything that cannot be captured yet is emitted as null rather than omitted, so the
        /// pipeline always sees the same shape.
        /// </summary>
        private void HandleSubmit(object? sender, SubmitRequestedEventArgs e) {
            if (_queue is null || _selection is null || _capture is null || _kit is null) return;

            // --- pre-flight: refuse to queue anything the pipeline's schema would reject. ---

            // (a) A selection must actually point at something.
            var live = _selection.Current;
            if (live.IsEmpty) {
                e.RejectReason = "Nothing selected. Click a surface (or shift-click textures) first.";
                return;
            }

            // (b) clientRelease.kitTag and .portalSha256 are REQUIRED and pattern-checked by
            //     schema_v1.json. They come only from acme-meta.json (KitMeta). Without a kit the
            //     entry cannot be valid and the pipeline would drop it, so decline loudly rather
            //     than write a null-stamped line. (See README screenshot/kit-meta notes.)
            var release = _kit.BuildClientRelease();
            if (string.IsNullOrEmpty(release.KitTag) || string.IsNullOrEmpty(release.PortalSha256)) {
                e.RejectReason = "No acme-meta.json found, so this build's release can't be stamped. " +
                                 "Reports need a kit tag + portal hash. Ship acme-meta.json beside the " +
                                 "plugin or set kitMetaPath.";
                _log.LogWarning("redline: submit blocked — no kit meta (kitTag/portalSha256 missing)");
                return;
            }

            var now = DateTime.UtcNow;
            string id = QueueWriter.NewId(now);

            var selection = _selection.BuildSelectionPayload();
            NormalizeKind(selection, id);

            // (c) Double-submit guard: the identical selection + prompt within this session is a
            //     mis-click, not a second report. Signature is the selection's target ids + kind +
            //     the trimmed prompt; if we've queued it already this session, decline quietly.
            string sig = SubmitSignature(selection, e.Prompt);
            if (!_submittedSignatures.Add(sig)) {
                e.RejectReason = "You already submitted this exact selection + note this session.";
                _log.LogInformation("redline: duplicate submit suppressed");
                return;
            }

            var entry = new RedlineEntry {
                Id = id,
                V = 1,
                CreatedAt = QueueWriter.Iso8601(now),
                Author = AuthorName() ?? "unknown",   // schema: author minLength 1
                ClientRelease = release,
                World = _capture.CaptureWorld(),
                Camera = _capture.CaptureCamera(),
                Selection = selection,
                Prompt = e.Prompt,
                Tags = [.. e.Tags],
                Severity = Math.Clamp(e.Severity, 1, 5),
                Attachments = _capture.TryCaptureShots(id, live),
                Guards = _kit.EvaluateGuards(live),
                Status = new StatusBlock { State = RedlineStatus.Queued },
            };

            e.Accepted = _queue.Append(entry);
            if (e.Accepted) {
                _selection.Clear();
            }
            else {
                _submittedSignatures.Remove(sig);   // write failed — allow a retry
                e.RejectReason = "Could not write to the redline queue (see log).";
            }
        }

        // Signatures of entries queued this session, for the double-submit guard. Cleared on unload.
        private readonly HashSet<string> _submittedSignatures = [];

        /// <summary>
        /// A stable signature of what a submission is ABOUT: kind + sorted target ids + the trimmed
        /// prompt. Deliberately excludes timestamp/camera/world so a genuine re-click of the same
        /// spot with the same words is recognised as a duplicate.
        /// </summary>
        private static string SubmitSignature(Model.Selection sel, string prompt) {
            var ids = new List<string>();
            foreach (var o in sel.Objects) if (o.GfxObjId is not null) ids.Add("g" + o.GfxObjId);
            foreach (var rs in sel.RenderSurfaces) if (rs.RsId is not null) ids.Add("r" + rs.RsId);
            if (sel.Triangles?.Indices is { Count: > 0 } ti)
                ids.Add("t" + sel.Triangles.GfxObjId + ":" + string.Join(",", ti));
            ids.Sort(StringComparer.Ordinal);
            return sel.Kind + "|" + string.Join("|", ids) + "|" + prompt.Trim();
        }

        /// <summary>
        /// Make <c>selection.kind</c> agree with what actually survived schema filtering. The kind
        /// the user built can over-promise — e.g. a triangle pick whose footprint could not be
        /// derived leaves no triangles block. Pick the most specific kind the payload can back up:
        /// triangles &gt; texture &gt; object.
        /// </summary>
        private void NormalizeKind(Model.Selection selection, string id) {
            string was = selection.Kind;
            string now =
                selection.Triangles is not null ? SelectionKind.Triangles
                : selection.RenderSurfaces.Count > 0 ? SelectionKind.Texture
                : SelectionKind.Object;
            if (now != was) {
                _log.LogInformation("redline: {Id} kind {Was} -> {Now} (payload could not back {Was})",
                    id, was, now, was);
                selection.Kind = now;
            }
        }

        /// <summary>
        /// Reporter identity. AC.ACPlugin.Game.AccountName
        /// (external/chorizite/ACPlugin/API/Game.cs:30) is the account the client logged in with;
        /// the character name (Game.Character.Name) is a poor key because it changes per alt.
        /// Null when not logged in - the schema allows it.
        /// </summary>
        private string? AuthorName() {
            try {
                var name = _ac.Game?.AccountName;
                return string.IsNullOrWhiteSpace(name) ? null : name;
            }
            catch (Exception) {
                return null;
            }
        }

        /// <summary>
        /// Directories to probe for acme-meta.json.
        ///
        /// TODO(acme-redline): Chorizite does not publish the dat directory to plugins -
        /// IDatReaderInterface (Chorizite.Core/Dats/IDatReaderInterface.cs) hands out
        /// PortalDatabase/CellDatabase objects with no path property, and FSDatReader
        /// (Chorizite.Core/Dats/FSDatReader.cs) keeps its root private. So the probe order is:
        /// the plugin's own directory, then its data directory. A kit that wants the sidecar
        /// found automatically should drop a copy beside the plugin, or set
        /// <see cref="RedlineSettings.KitMetaPath"/>.
        /// </summary>
        private IEnumerable<string> KitMetaCandidateDirs() {
            yield return AssemblyDirectory;
            yield return DataDirectory;
            var parent = Path.GetDirectoryName(AssemblyDirectory);
            if (!string.IsNullOrEmpty(parent)) yield return parent!;
        }
    }
}
