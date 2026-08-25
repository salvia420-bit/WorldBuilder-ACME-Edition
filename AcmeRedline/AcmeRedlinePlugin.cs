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
    /// DEPENDENCIES — deliberately NOT constructor-injected plugin instances.
    ///  - The stock <c>AC</c> plugin is gone entirely. It was used at exactly one site (the
    ///    reporter's account name) and in exchange it takes over the retail client's own UI:
    ///    ACPlugin.cs:78-93 registers its own CharSelect + DatPatch screens and hooks tooltips,
    ///    and :104-110 claims the client's `Indicators` root element. The account name is now a
    ///    plain setting (<see cref="RedlineSettings.Author"/>).
    ///  - <c>RmlUi</c> is OPTIONAL (manifest.json declares "RmlUi@0.0.10?"; PluginManager.cs:191-193
    ///    is what gives the "?" suffix meaning). It is resolved LATE, in Initialize, through
    ///    IPluginManager.GetPlugin("RmlUi") — never as a constructor parameter, because
    ///    AssemblyPluginInstance.ResolveParameter:236-243 THROWS for an IPluginCore parameter it
    ///    cannot satisfy, which would abort the whole plugin rather than degrade it.
    ///    With no RmlUi installed the plugin runs HUD-only: the IDrawList overlay, picking and
    ///    the queue all still work; only the RML panel is absent.
    /// </summary>
    public class AcmeRedlinePlugin : IPluginCore, ISerializeSettings<RedlineSettings> {
        internal static AcmeRedlinePlugin? Instance;

        private readonly IChoriziteBackend _backend;
        private readonly IClientBackend _client;
        private readonly IDatReaderInterface _dat;
        private readonly IPluginManager _plugins;
        private readonly ILogger _log;

        private RedlineSettings _settings = new();

        private QueueWriter? _queue;
        private StatusReader? _status;
        private KitMeta? _kit;
        private SelectionService? _selection;
        private OverlayRenderer? _overlay;
        private CaptureService? _capture;
        // Held through the interface, never as the concrete RedlinePanel: that type has RmlUi
        // fields, and the CLR resolves a type's field types when it lays the type out, so even
        // `_panel?.Hide()` on a null RedlinePanel would load RmlUi.dll or die. See IRedlinePanel.
        private IRedlinePanel? _panel;
        private TextureRegistry? _textures;
        private DeviceHooks? _hooks;

        // Input wiring
        private bool _inputHooked;
        private bool _chatHooked;
        private bool _lassoDragging;

        /// <summary>
        /// Whether the user currently has the tool "open" for picking. With a panel this tracks
        /// the panel's visibility; with no panel (HUD-only, no RmlUi installed) it IS the state,
        /// which is why picking cannot be gated on the panel any more.
        /// </summary>
        private bool _pickingArmed;

        /// <summary>Log the "no RmlUi" explanation once, not once per attempt.</summary>
        private bool _noRmlUiLogged;

        JsonTypeInfo<RedlineSettings> ISerializeSettings<RedlineSettings>.TypeInfo =>
            RedlineJsonContext.Default.RedlineSettings;

        /// <summary>
        /// Constructor injection. Every parameter after the manifest is resolved from the plugin
        /// lifetime scope.
        ///
        /// NOTE what is NOT here: any other plugin's type. AssemblyPluginInstance.ResolveParameter
        /// (Chorizite.Core/Plugins/AssemblyLoader/AssemblyPluginInstance.cs:236-243) throws
        /// InvalidOperationException for an IPluginCore-derived parameter whose plugin is not
        /// loaded — so a plugin that takes one by constructor can only ever be all-or-nothing.
        /// IPluginManager itself resolves through the plain Autofac fallback on the last line of
        /// that method (it is registered in Chorizite.cs:170-172), which is how RmlUiPlugin's own
        /// constructor gets it.
        /// </summary>
        protected AcmeRedlinePlugin(AssemblyPluginManifest manifest,
                                    IChoriziteBackend choriziteBackend,
                                    IClientBackend clientBackend,
                                    IDatReaderInterface dat,
                                    IPluginManager plugins,
                                    ILogger log) : base(manifest) {
            Instance = this;
            _backend = choriziteBackend;
            _client = clientBackend;
            _dat = dat;
            _plugins = plugins;
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

            _panel = TryCreatePanel();
            if (_panel is not null) {
                _panel.OnSubmitRequested += HandleSubmit;
                _panel.OnStatusOverlayToggled += (_, on) =>
                    _log.LogInformation("redline: status overlay {State}", on ? "on" : "off");
                _panel.OnMasterEnableRequested += (_, on) => SetEnabled(on, "panel");
            }

            // The chat command is hooked UNCONDITIONALLY and is never torn down by SetEnabled.
            // It is the re-entry path: a user who switches the tool off — or who has no RmlUi
            // installed and so has no panel at all — must always be able to type /redline on.
            HookChat();

            // Everything else follows the persisted master switch.
            ApplyEnabled(_settings.OverlayEnabled);

            _log.LogInformation("redline: ready ({State}, {Ui}). queue={Queue} kit={Kit}. F8 or /redline",
                _settings.OverlayEnabled ? "enabled" : "DISABLED",
                _panel is null ? "HUD only, no RmlUi" : "panel",
                queueDir, _kit.Meta?.KitTag ?? "(none)");
        }

        /// <summary>
        /// Build the RML panel if — and only if — the optional RmlUi plugin is actually loaded.
        ///
        /// Two separate things can go wrong and both must degrade rather than throw:
        ///  (a) no RmlUi plugin folder installed at all, so GetPlugin returns null;
        ///  (b) a folder that is present but unloadable/incompatible, in which case the JIT of
        ///      <see cref="RedlinePanelFactory.Create"/> throws when we first call it. That call
        ///      is the ONLY place this assembly mentions an RmlUi type outside RedlinePanel, and
        ///      it is [MethodImpl(NoInlining)] so the failure cannot escape into this frame.
        /// </summary>
        private IRedlinePanel? TryCreatePanel() {
            if (_selection is null || _status is null || _queue is null || _kit is null) return null;

            object? rmlUi = null;
            try {
                // Case-insensitive id match, same as PluginManager.GetPlugin does internally.
                rmlUi = _plugins.GetPlugin("RmlUi")?.Instance;
            }
            catch (Exception ex) {
                _log.LogDebug(ex, "redline: could not query the plugin manager for RmlUi");
            }

            if (rmlUi is null) {
                LogNoRmlUiOnce();
                return null;
            }

            try {
                return RedlinePanelFactory.Create(
                    rmlUi, _selection, _status, _queue, _kit, _settings,
                    Path.Combine(AssemblyDirectory, "assets", "panels", "Redline.rml"),
                    AuthorName, _log);
            }
            catch (Exception ex) {
                _log.LogWarning(ex, "redline: the RmlUi plugin is installed but its panel API could " +
                                    "not be bound; running HUD-only");
                return null;
            }
        }

        private void LogNoRmlUiOnce() {
            if (_noRmlUiLogged) return;
            _noRmlUiLogged = true;
            _log.LogInformation(
                "redline: the optional RmlUi plugin is not loaded, so there is no panel. " +
                "Picking, the HUD overlay and the report queue all still work; use /redline on|off " +
                "to control the tool. Install plugins/RmlUi (and its plugins/Lua dependency) to " +
                "get the panel back.");
        }

        /// <inheritdoc/>
        protected override void Dispose() {
            UnhookInput();
            UnhookChat();

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
        /// Redline picking is modal: it only steals the mouse while the tool is OPEN, so normal
        /// play is untouched the rest of the time.
        ///
        /// FINDING 2 (kept): gating on "a panel object exists" left picking armed for every click
        /// during ordinary play, because the panel is built in Initialize and lives until Dispose.
        ///
        /// It can no longer gate on panel VISIBILITY either: with RmlUi optional there may be no
        /// panel at all, and gating on one would make the HUD-only build permanently unable to
        /// pick anything. <see cref="_pickingArmed"/> is the single source of truth; when a panel
        /// exists <see cref="SetToolOpen"/> keeps the two in step.
        /// </summary>
        private bool PickingActive => _settings.OverlayEnabled && _pickingArmed;

        /// <summary>Is the tool open for picking right now?</summary>
        private bool ToolOpen => _pickingArmed;

        /// <summary>
        /// Open or close the tool. Shows/hides the panel when there is one, and always moves
        /// <see cref="_pickingArmed"/>, which is what actually arms the mouse handlers.
        /// </summary>
        private void SetToolOpen(bool open) {
            if (open && !_settings.OverlayEnabled) {
                // Refuse rather than half-open: a disabled tool has no overlay and no hooks, so
                // an "open" panel over it would be a lie.
                _log.LogInformation("redline: ignoring open request — the tool is disabled (/redline on)");
                return;
            }

            _pickingArmed = open;
            if (open) _panel?.Show();
            else _panel?.Hide();

            if (!open) {
                _lassoDragging = false;
                _selection?.Clear();
            }
        }

        // ------------------------------------------------------------------
        // Master enable / disable
        // ------------------------------------------------------------------

        /// <summary>
        /// The master switch. Writes <see cref="RedlineSettings.OverlayEnabled"/> — which
        /// round-trips through ISerializeSettings, so the choice survives a restart — and then
        /// actually attaches or tears down the machinery.
        /// </summary>
        /// <param name="on">Requested state.</param>
        /// <param name="source">Who asked, for the log line only.</param>
        internal void SetEnabled(bool on, string source) {
            if (_settings.OverlayEnabled == on) return;
            _settings.OverlayEnabled = on;
            ApplyEnabled(on);
            _log.LogInformation("redline: {State} by {Source}", on ? "enabled" : "disabled", source);
        }

        /// <summary>
        /// Make the world match <see cref="RedlineSettings.OverlayEnabled"/>. Idempotent, and
        /// called once at startup so a persisted "off" is honoured from the first frame instead
        /// of being armed and then torn down.
        /// </summary>
        private void ApplyEnabled(bool on) {
            if (on) {
                _overlay?.Attach();
                HookInput();
            }
            else {
                SetToolOpen(false);
                UnhookInput();
                DisarmAndDetach();
            }
            _panel?.RefreshAll();
        }

        /// <summary>
        /// Stop drawing and drop the IDirect3DDevice9 vtable detours.
        ///
        /// ORDER AND THREAD BOTH MATTER. DeviceHooks.Disarm rewrites vtable slots and is render
        /// -thread-only (DeviceHooks.cs:288), and the only thing that would otherwise disarm them
        /// is OverlayRenderer's own per-frame tick — which detaching stops. So the disarm is
        /// marshalled onto the render thread via IChoriziteBackend.Invoke and the detach happens
        /// in the SAME callback, after it: never detach first, or the hooks stay installed with
        /// nothing left to drop them.
        ///
        /// This is NOT DeviceHooks.Dispose: disposing would pin the hooks permanently and make
        /// /redline on unable to re-arm. Disarm is the reversible half.
        /// </summary>
        private void DisarmAndDetach() {
            var overlay = _overlay;
            var hooks = _hooks;
            if (overlay is null) return;

            // Nothing attached and nothing armed => nothing to do. This is the startup case for
            // a persisted "disabled": bouncing a no-op off the render thread before the client
            // has even reached its first frame is pointless and needlessly risky.
            if (!overlay.IsAttached && hooks?.IsArmed != true) return;

            void Teardown() {
                try { hooks?.Disarm("redline disabled"); }
                catch (Exception ex) { _log.LogDebug(ex, "redline: disarm during disable failed"); }
                overlay.Detach();
            }

            try {
                _backend.Invoke(Teardown);
            }
            catch (Exception ex) {
                // No render thread to marshal onto (unloading, or a headless environment). Detach
                // anyway so we at least stop drawing; the hooks are handled by Dispose.
                _log.LogWarning(ex, "redline: could not marshal the disable onto the render thread");
                overlay.Detach();
            }
        }

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
        /// F8 opens and closes the tool — the panel when there is one, and the picking mode
        /// either way. <c>/redline</c> does the same thing and is the discoverable version;
        /// F8 stays because it needs no chat box and no server round trip.
        ///
        /// TODO(acme-redline): make the hotkey configurable. Chorizite has no keybinding registry
        /// for plugins - searched Chorizite.Core/Input/* (raw key events only),
        /// Chorizite.Core/ChoriziteConfig.cs and IChoriziteConfig.cs (no input section), and
        /// external/chorizite/ACPlugin (binds nothing) - so any binding UI would be this plugin's
        /// own. Hardcoded until then, and only while the client has focus.
        /// </summary>
        private void HandleKeyDown(object? sender, KeyDownEventArgs e) {
            if (e.Key == Key.F8) {
                SetToolOpen(!ToolOpen);
            }
        }

        // ------------------------------------------------------------------
        // Chat command  —  /redline
        // ------------------------------------------------------------------

        /// <summary>
        /// The tool's always-available control surface.
        ///
        /// WHY THIS EXISTS. Before it, the only ways to reach AcmeRedline were an undocumented
        /// F8 and the launcher's Plugins tab (AcmeLauncher/Plugins.cs:40-53,67-77), and the
        /// latter only moves folders between plugins\ and plugins-disabled\ — it takes effect on
        /// the NEXT injection, so it is not a control at all once you are in game. Adding a
        /// master off switch without a way back in would have been strictly worse than no
        /// switch, so the way back in is wired first and never torn down.
        ///
        /// IClientBackend.OnChatInput (Chorizite.Core/Backend/Client/IClientBackend.cs:42) fires
        /// for text typed into the client's chat box, with ChatInputEventArgs : EatableEventArgs
        /// — setting Eat stops the client passing it on, which is what keeps "/redline" from
        /// being sent to the server as speech.
        ///
        /// This path never touches RmlUi, so it works identically on a HUD-only install.
        /// </summary>
        private void HookChat() {
            if (_chatHooked) return;
            try {
                _client.OnChatInput += HandleChatInput;
                _chatHooked = true;
            }
            catch (Exception ex) {
                _log.LogWarning(ex, "redline: could not hook chat input; /redline is unavailable");
            }
        }

        private void UnhookChat() {
            if (!_chatHooked) return;
            try { _client.OnChatInput -= HandleChatInput; }
            catch (Exception ex) { _log.LogDebug(ex, "redline: unhooking chat input failed"); }
            _chatHooked = false;
        }

        private const string ChatCommand = "/redline";

        private void HandleChatInput(object? sender, ChatInputEventArgs e) {
            string text = e.Text?.Trim() ?? "";
            if (text.Length < ChatCommand.Length) return;
            if (!text.StartsWith(ChatCommand, StringComparison.OrdinalIgnoreCase)) return;

            // "/redlinefoo" is somebody else's command, not a malformed one of ours. Only a
            // bare "/redline" or "/redline <args>" is claimed.
            string rest = text[ChatCommand.Length..];
            if (rest.Length > 0 && !char.IsWhiteSpace(rest[0])) return;

            e.Eat = true;
            try { RunChatCommand(rest.Trim()); }
            catch (Exception ex) {
                _log.LogWarning(ex, "redline: /redline handler threw");
                Say("redline: that failed — see the Chorizite log.");
            }
        }

        private void RunChatCommand(string args) {
            var parts = args.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries);
            string verb = parts.Length > 0 ? parts[0].ToLowerInvariant() : "";
            string rest = parts.Length > 1 ? parts[1].Trim() : "";

            switch (verb) {
                // Bare "/redline" = the F8 gesture, for anyone who does not know about F8.
                case "":
                    if (!_settings.OverlayEnabled) {
                        Say("redline is disabled. Type /redline on to enable it.");
                        return;
                    }
                    SetToolOpen(!ToolOpen);
                    Say(ToolOpen ? "redline: open." : "redline: closed.");
                    return;

                case "on":
                    SetEnabled(true, "chat");
                    Say("redline: enabled. /redline opens it, or press F8.");
                    return;

                case "off":
                    SetToolOpen(false);
                    SetEnabled(false, "chat");
                    Say("redline: disabled. Type /redline on to bring it back.");
                    return;

                case "toggle":
                    SetEnabled(!_settings.OverlayEnabled, "chat");
                    Say(_settings.OverlayEnabled
                        ? "redline: enabled. /redline opens it, or press F8."
                        : "redline: disabled. Type /redline on to bring it back.");
                    return;

                case "author":
                    if (rest.Length == 0) {
                        Say($"redline: reports are filed as \"{AuthorName() ?? "unknown"}\". " +
                            "Set it with /redline author <name>.");
                        return;
                    }
                    _settings.Author = rest;
                    _panel?.RefreshAll();
                    Say($"redline: reports will be filed as \"{rest}\".");
                    return;

                case "status":
                    Say($"redline: {(_settings.OverlayEnabled ? "enabled" : "disabled")}, " +
                        $"{(ToolOpen ? "open" : "closed")}, " +
                        $"{(_panel is null ? "HUD only (no RmlUi plugin)" : "panel available")}, " +
                        $"author \"{AuthorName() ?? "unknown"}\", " +
                        $"queue {_queue?.QueueDir ?? "(none)"}.");
                    return;

                default:
                    Say("redline: /redline [on|off|toggle|status|author <name>|help] — " +
                        "bare /redline (or F8) opens and closes the panel.");
                    return;
            }
        }

        /// <summary>Reply into the client's chat window. Never throws at the caller.</summary>
        private void Say(string message) {
            try { _client.AddChatText(message, ChatType.Default); }
            catch (Exception ex) { _log.LogDebug(ex, "redline: AddChatText failed: {Message}", message); }
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
        /// Reporter identity, from <see cref="RedlineSettings.Author"/>.
        ///
        /// This used to be AC.ACPlugin.Game.AccountName (external/chorizite/ACPlugin/API/Game.cs:30).
        /// One string is not worth the AC plugin, which replaces the retail client's CharSelect and
        /// DatPatch screens and claims its `Indicators` root element (ACPlugin.cs:78-93,104-110) —
        /// so AcmeRedline no longer depends on it at all. Set the name with /redline author &lt;name&gt;.
        ///
        /// Null when unset, which the schema allows; HandleSubmit substitutes "unknown".
        /// </summary>
        private string? AuthorName() {
            var name = _settings.Author;
            return string.IsNullOrWhiteSpace(name) ? null : name.Trim();
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
