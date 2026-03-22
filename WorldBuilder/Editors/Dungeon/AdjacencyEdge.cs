namespace WorldBuilder.Editors.Dungeon {

    public class AdjacencyEdge {
        public ushort EnvIdA { get; set; }
        public ushort CellStructA { get; set; }
        public ushort PolyIdA { get; set; }
        public ushort EnvIdB { get; set; }
        public ushort CellStructB { get; set; }
        public ushort PolyIdB { get; set; }
        public int Count { get; set; }
        public float RelOffsetX { get; set; }
        public float RelOffsetY { get; set; }
        public float RelOffsetZ { get; set; }
        public float RelRotX { get; set; }
        public float RelRotY { get; set; }
        public float RelRotZ { get; set; }
        public float RelRotW { get; set; } = 1f;
    }
}
