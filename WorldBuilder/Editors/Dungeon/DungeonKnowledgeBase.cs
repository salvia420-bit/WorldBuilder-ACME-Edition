using System;
using System.Collections.Generic;
using System.Numerics;

namespace WorldBuilder.Editors.Dungeon {

    public class DungeonKnowledgeBase {
        /// <summary>Increment when the edge/prefab data format changes to trigger auto-rebuild.</summary>
        public const int CurrentVersion = 2;
        public int Version { get; set; }
        public DateTime AnalyzedAt { get; set; }
        public int DungeonsScanned { get; set; }
        public int TotalEdges { get; set; }
        public int TotalPrefabs { get; set; }
        public int TotalCatalogRooms { get; set; }
        public List<AdjacencyEdge> Edges { get; set; } = new();
        public List<DungeonPrefab> Prefabs { get; set; } = new();
        public List<CatalogRoom> Catalog { get; set; } = new();
    }

    public class CompatibleRoom {
        public ushort EnvId { get; set; }
        public ushort CellStruct { get; set; }
        public ushort PolyId { get; set; }
        public int Count { get; set; }
        public Vector3 RelOffset { get; set; }
        public Quaternion RelRot { get; set; } = Quaternion.Identity;
    }
}
