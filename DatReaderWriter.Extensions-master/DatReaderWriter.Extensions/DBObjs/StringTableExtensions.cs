#pragma warning disable CS1591 // Missing XML comment for publicly visible type or member
namespace DatReaderWriter.Extensions.DBObjs {
    /// <summary>
    /// Mappings for StringTable file entries
    /// </summary>
    public enum StringTableType : uint {
        Undefined = 0x00000000,
        Language = 0x41000000,
        Options = 0x2300000D,
        Calendar = 0x23000006,
        CharacterTitle = 0x2300000E,
        KeyMap = 0x23000007,
        KeyNameOverride = 0x2300000A,
        MetakeyNameOverride = 0x2300000B,
        CommandSetup = 0x2300000C,
        ActionDescription = 0x23000005,
        ServerEngine = 0x23000010,
        UI = 0x23000001,
        UI_Pregame = 0x23000002,
        Preference = 0x23000003,
        UI_Options = 0x23000004,
    }
}