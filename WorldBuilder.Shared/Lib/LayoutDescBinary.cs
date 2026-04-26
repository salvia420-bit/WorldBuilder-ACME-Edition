using DatReaderWriter;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Lib;
using DatReaderWriter.Lib.IO;
using System;

namespace WorldBuilder.Shared.Lib {

    /// <summary>
    /// Deep copy <see cref="LayoutDesc"/> via Pack/Unpack so edits don't mutate DAT reader caches.
    /// Unpack requires a <see cref="DatBinReader"/> bound to a <see cref="DatDatabase"/> that has
    /// <see cref="DatDatabase.DatCollection"/> set (for <c>StateDesc</c> / <c>BaseProperty</c> resolution).
    /// Use <see cref="DatCollection.Local"/> for UI layouts.
    /// </summary>
    public static class LayoutDescBinary {
        const int PackBufferSize = 32 * 1024 * 1024;

        public static LayoutDesc Clone(LayoutDesc source, uint id, DatDatabase unpackContext) {
            ArgumentNullException.ThrowIfNull(unpackContext);

            var buffer = new byte[PackBufferSize];
            var writer = new DatBinWriter(buffer.AsMemory());
            ((IPackable)source).Pack(writer);

            var copy = new LayoutDesc();
            var reader = new DatBinReader(buffer.AsMemory(0, writer.Offset), unpackContext);
            ((IUnpackable)copy).Unpack(reader);
            copy.Id = id;
            return copy;
        }
    }
}
