using System;
using System.Collections.Generic;
using System.IO;
using AcmeRedline.Lib;
using AcmeRedline.Model;
using Chorizite.Core.Backend;
using Microsoft.Extensions.Logging;

namespace AcmeRedline.Services {
    /// <summary>
    /// Captures the context around a report: where the player and camera were, and a picture of
    /// what the reporter was complaining about.
    ///
    /// Split deliberately into two halves, because they have very different confidence levels:
    ///
    ///   CONTEXT (implemented) - player landblock/position/heading, camera position/lookAt/fov,
    ///   viewport size. All of it is straight reads of client globals through
    ///   <see cref="ClientMemory"/>: Render.player_pos / Render.viewer_pos / Render.fov
    ///   (ACBindings/Generated/Rendering/Render.cs) and
    ///   (*RenderDevice.render_device)->m_viewport{Width,Height}
    ///   (ACBindings/Generated/Rendering/RenderDevice.cs).
    ///
    ///   SCREENSHOTS (stubbed) - see <see cref="TryCaptureShots"/>. Chorizite gives a plugin no
    ///   pixel readback at all, and the client's own screenshot entry point needs unsafe string
    ///   marshalling that has not been validated. Rather than fake it, the capture returns no
    ///   attachments and the entry carries an empty attachments array.
    /// </summary>
    public sealed class CaptureService {
        private readonly IChoriziteBackend _backend;
        private readonly QueueWriter _queue;
        private readonly ILogger _log;

        public CaptureService(IChoriziteBackend backend, QueueWriter queue, ILogger log) {
            _backend = backend;
            _queue = queue;
            _log = log;
        }

        /// <summary>
        /// Player landblock / position / heading.
        ///
        /// Position.objcell_id is the cell id; for an outdoor cell the high 16 bits are the
        /// landblock. The schema's "landblock" field carries the full cell id in hex, which is
        /// what @teleloc and the ACE tooling both take, and is strictly more information than the
        /// landblock alone.
        ///
        /// Returns a block with null members when the client is not in the world.
        /// </summary>
        public WorldContext CaptureWorld() {
            var pose = ClientMemory.TryGetPlayerPose();
            if (pose is null) {
                return new WorldContext { Landblock = null, Pos = null, Heading = null };
            }
            var p = pose.Value;
            return new WorldContext {
                Landblock = Hex.U32(p.CellId),
                Pos = p.PosArray(),
                Heading = p.HeadingDeg(),
            };
        }

        /// <summary>
        /// Camera position, look-at point and vertical FOV in degrees.
        ///
        /// lookAt is synthesised as (camera origin + forward), one metre ahead: the client stores
        /// an orientation quaternion, not a look-at target
        /// (ACBindings/Generated/Frame.cs - qw/qx/qy/qz + m_fOrigin), so a point on the view axis
        /// is the faithful translation into the schema's shape.
        /// </summary>
        public CameraContext CaptureCamera() {
            var pose = ClientMemory.TryGetCameraPose();
            if (pose is null) {
                return new CameraContext { Pos = null, LookAt = null, FovDeg = null };
            }
            var c = pose.Value;
            var fwd = c.ForwardArray();
            return new CameraContext {
                Pos = c.PosArray(),
                LookAt = [c.X + fwd[0], c.Y + fwd[1], c.Z + fwd[2]],
                FovDeg = c.FovDeg,
            };
        }

        /// <summary>
        /// Client graphics settings, if readable.
        ///
        /// TODO(acme-redline): NOT captured, and not in schema v1 anyway - there is no field for
        /// it, so adding one would break the frozen contract. When schema v2 opens, the data is
        /// reachable: Render.m_RenderPrefs = (RenderPrefs*)0x0081FFA0 and
        /// (*RenderDevice.render_device)->m_config / m_caps / m_displayInfo
        /// (ACBindings/Generated/Rendering/{Render.cs,RenderDevice.cs,RenderPrefs.cs,
        /// RenderDeviceConfig.cs}), plus UserPreferences (ACBindings/Generated/UserPreferences.cs).
        /// Recorded here so the next schema revision does not have to re-find it.
        /// </summary>
        public IReadOnlyDictionary<string, string> CaptureGraphicsSettings() =>
            new Dictionary<string, string>();

        /// <summary>
        /// Try to produce the two attachments the schema anticipates:
        ///   shots/&lt;id&gt;-view.png  the frame with the highlight visible
        ///   shots/&lt;id&gt;-mask.png  the highlight alone, as a mask, so the pipeline can find the
        ///                          complained-about pixels without re-deriving the projection
        ///
        /// TODO(acme-redline): NOT IMPLEMENTED. Two independent blockers, both searched:
        ///
        ///  1. No pixel readback in the managed render surface. Chorizite.Core/Render exposes
        ///     ITexture (Width/Height/Format/NativePtr/Bind/SetData/Unbind - SET only, no GET),
        ///     IFramebuffer (Texture + NativeHandle), RenderTarget, and IGraphicsDevice; none has
        ///     a GetData / ReadPixels / Save of any kind. A grep for
        ///     "ReadPixels|GetData|Screenshot|SaveScreenshot|glReadPixels" across
        ///     external/chorizite/Chorizite, RmlUiPlugin and ACPlugin returns nothing usable.
        ///
        ///  2. The client's own path exists but needs unsafe marshalling.
        ///     Device::SaveScreenshot @0x0043A780 (ACBindings/Generated/Input/Device.cs:218) writes
        ///     &lt;prefs dir&gt;ScreenShot%05d.jpg and returns the path through a
        ///     PStringBase&lt;char&gt;* out-param (confirmed against ac-headers/acclient.c,
        ///     Device::SaveScreenshot). The bindings type that parameter as a bare int*, and
        ///     handing the client a buffer it will refcount as a PSRefBufferCharData is a heap
        ///     corruption waiting to happen. See ClientMemory.TrySaveClientScreenshot.
        ///
        ///  When (2) is done, the "view" shot is a copy of what the client wrote (use
        ///  QueueWriter.AdoptAttachment) — and it now shows the in-world DeviceHooks highlight for
        ///  free, since that tint is already in the back buffer SaveScreenshot grabs (no separate
        ///  mask / projection needed any more). An out-param-free variant: after the call, pick up
        ///  the newest ScreenShot*.jpg from the UserPreferences dir.
        ///  EXTERNAL ALTERNATIVE: an OBS / Windows-Graphics-Capture grab of the client window,
        ///  handed to QueueWriter.WriteAttachment as raw bytes.
        ///
        /// DECISION: left empty for now. Both paths need validation on a live Windows client this
        /// repo cannot run, and the schema is satisfied by []. This method only ever returns paths
        /// for files that actually EXIST and are queue-relative — never a fabricated name.
        /// </summary>
        /// <param name="entryId">Entry id, used to name the files.</param>
        /// <param name="selection">Selection (for a future mask render). Unused while empty.</param>
        public List<string> TryCaptureShots(string entryId, SelectionSet selection) {
            var attachments = new List<string>();

            // TrySaveClientScreenshot is a deliberate no-op stub (returns null) until the
            // PStringBase marshalling is validated on a live client. When it returns a real path,
            // this adopts it and only THEN is attachments non-empty. Honest by construction.
            string? clientShot = null;
            _backend.Invoke(() => clientShot = ClientMemory.TrySaveClientScreenshot());

            if (clientShot is not null && File.Exists(clientShot)) {
                var rel = _queue.AdoptAttachment(clientShot, entryId, "view");
                if (rel is not null) attachments.Add(rel);
            }
            else {
                _log.LogDebug("redline: no screenshot for {Id} (client capture path not wired; " +
                              "attachments left empty)", entryId);
            }

            _ = selection;
            return attachments;
        }
    }
}
