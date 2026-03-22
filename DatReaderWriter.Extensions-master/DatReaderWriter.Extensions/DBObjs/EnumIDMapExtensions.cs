#pragma warning disable CS1591 // Missing XML comment for publicly visible type or member
namespace DatReaderWriter.Extensions.DBObjs {
    /// <summary>
    /// Mappings for EnumIDMap file entries
    /// </summary>
    public enum EnumIDMapType : uint {
        Undefined = 0,
        EnumMapper = 0x25000001,
        UniqueDB = 0x25000002,
        QualityFilters = 0x25000003,
        StringTable = 0x25000004,
        UILayout = 0x2500000E,
        UICursor = 0x2500000F,
        UIAsset = 0x25000010,
        ActionMap = 0x25000011,
        Font = 0x25000012,
        KeyMap = 0x25000013,
        Region = 0x25000014,
        WeenieClassId = 0x25000015,
        WeenieCategories = 0x25000005,
        UIAttributeIcons = 0x25000006,
        UIAttribute2ndIcons = 0x25000007,
        UIIconBackgrounds = 0x25000008,
        UIEffectIcons = 0x25000009,
        UISpellBackgrounds = 0x2500000A,
        UISpellOverlays = 0x2500000B,
        CharGenAssets = 0x2500000C,
        VividIndicators = 0x2500000D,
    }
}