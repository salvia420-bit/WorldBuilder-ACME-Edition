using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;

namespace WorldBuilder.Editors.Dungeon {

    public class DungeonPrefab {
        public string Signature { get; set; } = "";
        public int SourceLandblock { get; set; }
        public string SourceDungeonName { get; set; } = "";
        public int UsageCount { get; set; } = 1;
        public List<PrefabCell> Cells { get; set; } = new();
        public List<PrefabPortal> InternalPortals { get; set; } = new();
        public List<PrefabOpenFace> OpenFaces { get; set; } = new();
        public int TotalPortals => Cells.Sum(c => c.PortalCount);
        public int OpenPortalCount => OpenFaces.Count;

        public string DisplayName { get; set; } = "";
        public string Category { get; set; } = "";
        public string Style { get; set; } = "";
        public List<string> Tags { get; set; } = new();

        /// <summary>True when ALL cells in this prefab have ceiling polygons.</summary>
        public bool HasFullRoof { get; set; } = true;
        /// <summary>True when at least one cell is missing ceiling polygons.</summary>
        public bool HasPartialRoof { get; set; }
        /// <summary>True when NO cells have ceiling polygons at all.</summary>
        public bool HasNoRoof { get; set; }

        /// <summary>Cardinal direction labels for each open face (N/S/E/W/Up/Down).</summary>
        public List<string> OpenFaceDirections { get; set; } = new();

        /// <summary>Compact summary of open face directions, e.g. "N+S", "N+E+Down".</summary>
        public string ConnectionDirectionSummary {
            get {
                if (OpenFaceDirections.Count == 0) return "";
                var unique = OpenFaceDirections.Distinct().ToList();
                return string.Join("+", unique);
            }
        }

        /// <summary>Classify the open-face normal into a human-readable cardinal direction.</summary>
        public static string ClassifyDirection(float nx, float ny, float nz) {
            var absX = MathF.Abs(nx);
            var absY = MathF.Abs(ny);
            var absZ = MathF.Abs(nz);

            if (absZ > absX && absZ > absY)
                return nz > 0 ? "Up" : "Down";

            if (absX > absY)
                return nx > 0 ? "E" : "W";

            return ny > 0 ? "N" : "S";
        }
    }

    public class PrefabCell {
        public int LocalIndex { get; set; }
        public ushort EnvId { get; set; }
        public ushort CellStruct { get; set; }
        public int PortalCount { get; set; }
        public float OffsetX { get; set; }
        public float OffsetY { get; set; }
        public float OffsetZ { get; set; }
        public float RotX { get; set; }
        public float RotY { get; set; }
        public float RotZ { get; set; }
        public float RotW { get; set; } = 1f;
        public List<ushort> Surfaces { get; set; } = new();
        /// <summary>True if this cell has at least one ceiling polygon (normal.Z &lt; -0.7).</summary>
        public bool HasCeiling { get; set; } = true;
    }

    public class PrefabPortal {
        public int CellIndexA { get; set; }
        public ushort PolyIdA { get; set; }
        public int CellIndexB { get; set; }
        public ushort PolyIdB { get; set; }
    }

    public class PrefabOpenFace {
        public int CellIndex { get; set; }
        public ushort PolyId { get; set; }
        public ushort EnvId { get; set; }
        public ushort CellStruct { get; set; }
        public float NormalX { get; set; }
        public float NormalY { get; set; }
        public float NormalZ { get; set; }
        /// <summary>Cardinal direction label derived from normal (N/S/E/W/Up/Down).</summary>
        public string DirectionLabel => DungeonPrefab.ClassifyDirection(NormalX, NormalY, NormalZ);
    }

    public class CatalogRoom {
        public ushort EnvId { get; set; }
        public ushort CellStruct { get; set; }
        public string Category { get; set; } = "";
        public string Size { get; set; } = "";
        public string Style { get; set; } = "";
        public string DisplayName { get; set; } = "";
        public int PortalCount { get; set; }
        public int UsageCount { get; set; }
        public float BoundsWidth { get; set; }
        public float BoundsDepth { get; set; }
        public float BoundsHeight { get; set; }
        public List<string> SourceDungeons { get; set; } = new();
        public List<ushort> SampleSurfaces { get; set; } = new();
        /// <summary>True if this room type has ceiling polygons.</summary>
        public bool HasCeiling { get; set; } = true;
    }
}
