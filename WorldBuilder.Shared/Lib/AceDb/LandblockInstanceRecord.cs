namespace WorldBuilder.Shared.Lib.AceDb {
    /// <summary>
    /// Lightweight projection of a row from the ACE ace_world.landblock_instance table.
    /// </summary>
    public class LandblockInstanceRecord {
        public uint Guid { get; set; }
        public uint WeenieClassId { get; set; }
        public uint ObjCellId { get; set; }
        public float OriginX { get; set; }
        public float OriginY { get; set; }
        public float OriginZ { get; set; }

        public ushort LandblockId => (ushort)(ObjCellId >> 16);
        public ushort CellId => (ushort)(ObjCellId & 0xFFFF);

        /// <summary>
        /// Outdoor cells are 0x0001-0x0040 (1-64). Interior/dungeon cells start at 0x0100.
        /// </summary>
        public bool IsOutdoor => CellId >= 1 && CellId <= 64;
    }
}
