using DatReaderWriter.DBObjs;
using DatReaderWriter.Extensions.DBObjs;
using DatReaderWriter.Lib;

namespace DatReaderWriter.Extensions {
    public partial class DatEasyWriter {
        /// <summary>
        /// Get an <see cref="StringTable"/> from an <see cref="StringTableType"/>.
        /// </summary>
        /// <param name="type"></param>
        /// <returns></returns>
        public Result<StringTable, string> GetStringTable(StringTableType type) {
            if (type == StringTableType.Language || type == StringTableType.Undefined) {
                return "Language and Undefined StringTableTypes are unsupported";
            }
            
            var stringTable = Dats.Get<StringTable>((uint)type);
            if (stringTable is null) return $"Unable to find StringTable of type {type} 0x{(uint)type:X8}.";
            return stringTable;
        }
    }
}