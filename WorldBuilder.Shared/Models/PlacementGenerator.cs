using MemoryPack;

namespace WorldBuilder.Shared.Models {
    /// <summary>
    /// One generator profile attached to a placement. Maps 1:1 to ACE's
    /// <c>weenie_properties_generator</c> / <c>biota_properties_generator</c> columns
    /// (<c>WeeniePropertiesGenerator.cs:21-82</c>) — explicit NAMED columns, never an opaque blob.
    /// The SQL column list emitted from this is exactly <c>WeenieSQLWriter.cs:751-753</c>:
    /// <c>object_Id, probability, weenie_Class_Id, delay, init_Create, max_Create, when_Create,
    /// where_Create, stack_Size, palette_Id, shade, obj_Cell_Id, origin_X/Y/Z, angles_W/X/Y/Z</c>.
    ///
    /// A placement may carry MULTIPLE generator profiles (a <c>List&lt;PlacementGenerator&gt;</c>),
    /// one SQL row each.
    /// </summary>
    [MemoryPackable]
    public sealed partial class PlacementGenerator {
        public float Probability { get; set; }

        /// <summary>Weenie Class Id of the object to spawn (the generator's target).</summary>
        public uint WeenieClassId { get; set; }

        public float? Delay { get; set; }

        public int InitCreate { get; set; }

        public int MaxCreate { get; set; }

        /// <summary><c>RegenerationType</c> flags (Destruction=0x1, PickUp=0x2, Death=0x4).</summary>
        public uint WhenCreate { get; set; }

        /// <summary><c>RegenLocationType</c> flags (OnTop=0x01, Scatter=0x02, Specific=0x04, ...).</summary>
        public uint WhereCreate { get; set; }

        public int? StackSize { get; set; }

        /// <summary>
        /// Generator child tint = <c>PaletteTemplate</c> index (decimal, NOT a DID — see SPEC §3.1).
        /// Maps to <c>weenie_properties_generator.palette_Id</c>, emitted as plain decimal.
        /// </summary>
        public int? PaletteTemplate { get; set; }

        public float? Shade { get; set; }

        /// <summary>Optional spawn-location override cell id.</summary>
        public uint? ObjCellId { get; set; }

        public float? OriginX { get; set; }
        public float? OriginY { get; set; }
        public float? OriginZ { get; set; }

        public float? AnglesW { get; set; }
        public float? AnglesX { get; set; }
        public float? AnglesY { get; set; }
        public float? AnglesZ { get; set; }
    }
}
