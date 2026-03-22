#pragma warning disable CS1591 // Missing XML comment for publicly visible type or member
namespace DatReaderWriter.Extensions.DBObjs {
    /// <summary>
    /// Mappings for EnumMapper file entries. These come from EoR dats 0x25000001 EnumIDMap
    /// </summary>
    public enum EnumMapperType : uint {
        Undefined = 0,
        MeshTypeId = 0x22000014,
        Languages = 0x22000005,
        TextType = 0x2200001F,
        TextTagType = 0x22000020,
        InputActions = 0x22000021,
        InputMap = 0x22000022,
        EtherealType = 0x22000043,
        Gender = 0x2200000A,
        HeritageGroup = 0x2200000B,
        CreatureType = 0x2200000E,
        CharacterTitle = 0x22000041
    }
}