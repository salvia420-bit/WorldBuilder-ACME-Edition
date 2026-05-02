using DatReaderWriter;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Enums;
using DatReaderWriter.Lib.IO;
using DatReaderWriter.Options;
using System;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
namespace WorldBuilder.Shared.Lib {
    public class DefaultDatReaderWriter : IDatReaderWriter {
        private object _lock = new object();
        public DatCollection Dats { get; }

        /// <summary>The DAT directory this reader was opened against. Surfaced so callers
        /// can <see cref="Fork"/> a fresh independent reader (per-thread, etc.).</summary>
        public string DatPath { get; }

        /// <summary>Access mode this reader was opened in (Read or ReadWrite).
        /// <see cref="Fork"/> preserves it.</summary>
        public DatAccessType AccessType { get; }

        /// <summary>Caching strategy passed at construction; <see cref="Fork"/> preserves it.</summary>
        public FileCachingStrategy FileCaching { get; }

        /// <summary>Index-caching strategy passed at construction; <see cref="Fork"/> preserves it.</summary>
        public IndexCachingStrategy IndexCaching { get; }

        public DefaultDatReaderWriter(string datPath, DatAccessType accessType)
            : this(datPath, accessType, FileCachingStrategy.Never, IndexCachingStrategy.Never) {
        }

        public DefaultDatReaderWriter(string datPath, DatAccessType accessType,
            FileCachingStrategy fileCaching, IndexCachingStrategy indexCaching) {
            DatPath = datPath;
            AccessType = accessType;
            FileCaching = fileCaching;
            IndexCaching = indexCaching;
            Dats = new DatCollection(new DatCollectionOptions() {
                AccessType = accessType,
                DatDirectory = datPath,
                FileCachingStrategy = fileCaching,
                IndexCachingStrategy = indexCaching
            });
        }

        /// <summary>
        /// Returns a fresh, independent reader pointing at the same DAT directory + access mode.
        /// Forks have independent file streams and an independent internal lock, so concurrent
        /// reads through different forks don't serialize on the parent's lock — used by
        /// per-thread DAT-reader pools (QuickWorld Phase 3, terrain init parallel load, ...).
        /// Caller owns disposal of the fork.
        /// </summary>
        public DefaultDatReaderWriter Fork() =>
            new DefaultDatReaderWriter(DatPath, AccessType, FileCaching, IndexCaching);

        public bool TryGet<T>(uint id, [MaybeNullWhen(false)] out T file) where T : IDBObj, new() {
            lock (_lock) {
                return typeof(T) switch {
                    Type _ when typeof(T) == typeof(LandBlock) => Dats.Cell.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(LandBlockInfo) => Dats.Cell.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(EnvCell) => Dats.Cell.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(Setup) => Dats.Portal.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(GfxObj) => Dats.Portal.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(ParticleEmitter) => Dats.Portal.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(Region) => Dats.Portal.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(Scene) => Dats.Portal.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(Surface) => Dats.Portal.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(Palette) => Dats.Portal.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(RenderTexture) => Dats.Portal.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(RenderSurface) => Dats.Portal.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(SurfaceTexture) => Dats.Portal.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(DatReaderWriter.DBObjs.Environment) => Dats.Portal.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(SpellTable) => Dats.Portal.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(SpellComponentTable) => Dats.Portal.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(ExperienceTable) => Dats.Portal.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(SkillTable) => Dats.Portal.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(VitalTable) => Dats.Portal.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(CharGen) => Dats.Portal.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(ClothingTable) => Dats.Portal.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(PalSet) => Dats.Portal.TryGet(id, out file),
                    Type _ when typeof(T) == typeof(LayoutDesc) => Dats.TryGet(id, out file),
                    _ => throw new NotImplementedException($"DefaultDatReaderWriter does not currently support {typeof(T)}"),
                };
            }
        }

        public bool TrySave<T>(T file, int? iteration = 0) where T : IDBObj, new() {
            lock (_lock) {
                return typeof(T) switch {
                    Type _ when typeof(T) == typeof(LandBlock) => Dats.Cell.TryWriteFile(file, iteration),
                    Type _ when typeof(T) == typeof(LandBlockInfo) => Dats.Cell.TryWriteFile(file, iteration),
                    Type _ when typeof(T) == typeof(EnvCell) => Dats.Cell.TryWriteFile(file, iteration),
                    Type _ when typeof(T) == typeof(Setup) => Dats.Portal.TryWriteFile(file, iteration),
                    Type _ when typeof(T) == typeof(GfxObj) => Dats.Portal.TryWriteFile(file, iteration),
                    Type _ when typeof(T) == typeof(ParticleEmitter) => Dats.Portal.TryWriteFile(file, iteration),
                    Type _ when typeof(T) == typeof(Region) => Dats.Portal.TryWriteFile(file, iteration),
                    Type _ when typeof(T) == typeof(Scene) => Dats.Portal.TryWriteFile(file, iteration),
                    Type _ when typeof(T) == typeof(RenderTexture) => Dats.Portal.TryWriteFile(file, iteration),
                    Type _ when typeof(T) == typeof(Palette) => Dats.Portal.TryWriteFile(file, iteration),
                    Type _ when typeof(T) == typeof(Surface) => Dats.Portal.TryWriteFile(file, iteration),
                    Type _ when typeof(T) == typeof(RenderSurface) => Dats.Portal.TryWriteFile(file, iteration),
                    Type _ when typeof(T) == typeof(SurfaceTexture) => Dats.Portal.TryWriteFile(file, iteration),
                    Type _ when typeof(T) == typeof(DatReaderWriter.DBObjs.Environment) => Dats.Portal.TryWriteFile(file, iteration),
                    Type _ when typeof(T) == typeof(SpellTable) => Dats.Portal.TryWriteFile(file, iteration),
                    Type _ when typeof(T) == typeof(ExperienceTable) => Dats.Portal.TryWriteFile(file, iteration),
                    Type _ when typeof(T) == typeof(SkillTable) => Dats.Portal.TryWriteFile(file, iteration),
                    Type _ when typeof(T) == typeof(VitalTable) => Dats.Portal.TryWriteFile(file, iteration),
                    Type _ when typeof(T) == typeof(CharGen) => Dats.Portal.TryWriteFile(file, iteration),
                    Type _ when typeof(T) == typeof(LayoutDesc) => Dats.TryWriteFile(file, iteration),
                    _ => throw new NotImplementedException($"DefaultDatReaderWriter does not currently support {typeof(T)}"),
                };
            }
        }

        public void Dispose() {
            Dats.Dispose();
        }
    }
}
