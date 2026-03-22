using DatReaderWriter.DBObjs;
using DatReaderWriter.Extensions.DBObjs;
using DatReaderWriter.Lib;

namespace DatReaderWriter.Extensions {
    public partial class DatEasyWriter {
        /// <summary>
        /// Get an <see cref="EnumMapper"/> from an <see cref="EnumMapperType"/>.
        /// </summary>
        /// <param name="type"></param>
        /// <returns></returns>
        public Result<EnumMapper, string> GetEnumMapper(EnumMapperType type) {
            var enumMapper = Dats.Get<EnumMapper>((uint)type);
            if (enumMapper is null) return $"Unable to find EnumMapper of type {type} 0x{(uint)type:X8}.";
            return enumMapper;
        }
    }
}