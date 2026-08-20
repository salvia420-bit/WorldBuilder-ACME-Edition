using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace AcmeRedline.Model {
    /// <summary>
    /// Queue entry schema v1. FROZEN - the redline pipeline agent
    /// (tools/dat-patch/redline/, not part of this plugin) codes against the same text.
    /// Do not rename, reorder-with-meaning, or drop members. Fields that this build
    /// cannot capture yet are still emitted, as null, so the consumer sees a stable shape.
    ///
    /// Serialization note: every payload member is a PROPERTY, not a field, and every
    /// vector is a float[] rather than System.Numerics.Vector3. System.Text.Json silently
    /// drops public *fields* unless IncludeFields is set, and it flattens Vector3 into
    /// {"X":..,"Y":..,"Z":..} rather than the [x,y,z] arrays this schema requires.
    /// </summary>
    public class RedlineEntry {
        /// <summary>rl-&lt;utc yyyymmdd-hhmmss&gt;-&lt;4 hex&gt;</summary>
        [JsonPropertyName("id")]
        public string Id { get; set; } = "";

        /// <summary>Schema version. Always 1 for this build.</summary>
        [JsonPropertyName("v")]
        public int V { get; set; } = 1;

        /// <summary>ISO8601 UTC.</summary>
        [JsonPropertyName("createdAt")]
        public string CreatedAt { get; set; } = "";

        /// <summary>Account name of the reporter.</summary>
        [JsonPropertyName("author")]
        public string? Author { get; set; }

        [JsonPropertyName("clientRelease")]
        public ClientRelease? ClientRelease { get; set; }

        [JsonPropertyName("world")]
        public WorldContext? World { get; set; }

        [JsonPropertyName("camera")]
        public CameraContext? Camera { get; set; }

        [JsonPropertyName("selection")]
        public Selection? Selection { get; set; }

        [JsonPropertyName("prompt")]
        public string Prompt { get; set; } = "";

        [JsonPropertyName("tags")]
        public List<string> Tags { get; set; } = [];

        /// <summary>1..3</summary>
        [JsonPropertyName("severity")]
        public int Severity { get; set; } = 1;

        /// <summary>Queue-relative paths, e.g. "shots/&lt;id&gt;-view.png".</summary>
        [JsonPropertyName("attachments")]
        public List<string> Attachments { get; set; } = [];

        [JsonPropertyName("guards")]
        public Guards? Guards { get; set; }

        [JsonPropertyName("status")]
        public StatusBlock? Status { get; set; }
    }

    /// <summary>Which shipped dat release the reporter was running. Sourced from acme-meta.json.</summary>
    public class ClientRelease {
        [JsonPropertyName("kitTag")]
        public string? KitTag { get; set; }

        [JsonPropertyName("portalSha256")]
        public string? PortalSha256 { get; set; }

        [JsonPropertyName("highresSha256")]
        public string? HighresSha256 { get; set; }
    }

    public class WorldContext {
        /// <summary>Hex landblock / cell id, e.g. "0x016C0107".</summary>
        [JsonPropertyName("landblock")]
        public string? Landblock { get; set; }

        /// <summary>[x, y, z] in landblock-local coordinates.</summary>
        [JsonPropertyName("pos")]
        public float[]? Pos { get; set; }

        /// <summary>Degrees.</summary>
        [JsonPropertyName("heading")]
        public float? Heading { get; set; }
    }

    public class CameraContext {
        [JsonPropertyName("pos")]
        public float[]? Pos { get; set; }

        [JsonPropertyName("lookAt")]
        public float[]? LookAt { get; set; }

        [JsonPropertyName("fovDeg")]
        public float? FovDeg { get; set; }
    }

    public static class SelectionKind {
        public const string Texture = "texture";
        public const string Triangles = "triangles";
        public const string Object = "object";
    }

    public class Selection {
        /// <summary>"texture" | "triangles" | "object" - see <see cref="SelectionKind"/>.</summary>
        [JsonPropertyName("kind")]
        public string Kind { get; set; } = SelectionKind.Object;

        [JsonPropertyName("objects")]
        public List<SelectedObject> Objects { get; set; } = [];

        [JsonPropertyName("renderSurfaces")]
        public List<SelectedRenderSurface> RenderSurfaces { get; set; } = [];

        /// <summary>MANDATORY (with a non-null footprint) when <see cref="Kind"/> is "triangles".</summary>
        [JsonPropertyName("triangles")]
        public TriangleSelection? Triangles { get; set; }

        [JsonPropertyName("screenLasso")]
        public ScreenLasso? ScreenLasso { get; set; }
    }

    public class SelectedObject {
        /// <summary>Runtime client object guid, hex.</summary>
        [JsonPropertyName("objectId")]
        public string? ObjectId { get; set; }

        /// <summary>"0x02......"</summary>
        [JsonPropertyName("setupId")]
        public string? SetupId { get; set; }

        /// <summary>"0x01......"</summary>
        [JsonPropertyName("gfxObjId")]
        public string? GfxObjId { get; set; }

        [JsonPropertyName("worldFrame")]
        public WorldFrame? WorldFrame { get; set; }
    }

    public class WorldFrame {
        [JsonPropertyName("pos")]
        public float[]? Pos { get; set; }

        /// <summary>[w, x, y, z].</summary>
        [JsonPropertyName("quat")]
        public float[]? Quat { get; set; }
    }

    public class SelectedRenderSurface {
        /// <summary>"0x06......" - the RenderSurface (pixel data) the pipeline will actually repaint.</summary>
        [JsonPropertyName("rsId")]
        public string? RsId { get; set; }

        /// <summary>"0x08......"</summary>
        [JsonPropertyName("surfaceId")]
        public string? SurfaceId { get; set; }

        /// <summary>"0x05......"</summary>
        [JsonPropertyName("surfaceTextureId")]
        public string? SurfaceTextureId { get; set; }

        /// <summary>UVs of the hit points, [[u,v], ...]. Tells the pipeline WHERE on the texture the complaint lands.</summary>
        [JsonPropertyName("uvHints")]
        public List<float[]> UvHints { get; set; } = [];
    }

    public class TriangleSelection {
        [JsonPropertyName("gfxObjId")]
        public string? GfxObjId { get; set; }

        /// <summary>Polygon indices into the GfxObj record. Go stale on a mesh reship - see <see cref="Footprint"/>.</summary>
        [JsonPropertyName("indices")]
        public List<int> Indices { get; set; } = [];

        /// <summary>
        /// Object-LOCAL space geometry of the selection. MANDATORY when kind == "triangles":
        /// raw indices go stale when the pipeline reships a rebuilt mesh, the footprint does not.
        /// </summary>
        [JsonPropertyName("footprint")]
        public TriangleFootprint? Footprint { get; set; }

        /// <summary>SHA-256 of the raw GfxObj dat record bytes the selection was made against.</summary>
        [JsonPropertyName("baseRecordSha256")]
        public string? BaseRecordSha256 { get; set; }
    }

    public class TriangleFootprint {
        /// <summary>Per-triangle centroid, object-local, [[x,y,z], ...].</summary>
        [JsonPropertyName("centroids")]
        public List<float[]> Centroids { get; set; } = [];

        /// <summary>Per-triangle unit normal, object-local, [[x,y,z], ...].</summary>
        [JsonPropertyName("normals")]
        public List<float[]> Normals { get; set; } = [];

        /// <summary>Total selected surface area in square meters (AC world units are meters).</summary>
        [JsonPropertyName("areaM2")]
        public float? AreaM2 { get; set; }
    }

    public class ScreenLasso {
        /// <summary>[[x,y], ...] in window pixels.</summary>
        [JsonPropertyName("points")]
        public List<float[]> Points { get; set; } = [];

        /// <summary>[width, height] of the viewport the points were captured in.</summary>
        [JsonPropertyName("viewport")]
        public int[]? Viewport { get; set; }
    }

    public class Guards {
        /// <summary>Selection touches a RenderSurface listed in acme-meta.json terrainProtectedRs.</summary>
        [JsonPropertyName("terrainProtected")]
        public bool TerrainProtected { get; set; }

        /// <summary>Selection touches a RenderSurface listed in acme-meta.json paletteRouteRs.</summary>
        [JsonPropertyName("paletteRoute")]
        public bool PaletteRoute { get; set; }
    }

    public class StatusBlock {
        /// <summary>The plugin only ever writes "queued". Later states come from redline-status.jsonl.</summary>
        [JsonPropertyName("state")]
        public string State { get; set; } = RedlineStatus.Queued;
    }

    /// <summary>
    /// The three status states, matching schema_v1.json's statusEvent + entry status enums exactly.
    /// The plugin only ever writes <see cref="Queued"/> (the entry seed); the pipeline writes the
    /// rest into redline-status.jsonl, carrying the kit tag in the event's <c>release</c> field.
    /// </summary>
    public static class RedlineStatus {
        public const string Queued = "queued";
        public const string InProgress = "in-progress";
        public const string Fixed = "fixed";
    }
}
