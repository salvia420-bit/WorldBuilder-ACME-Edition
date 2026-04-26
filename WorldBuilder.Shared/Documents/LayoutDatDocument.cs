using DatReaderWriter;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Lib;
using DatReaderWriter.Lib.IO;
using MemoryPack;
using Microsoft.Extensions.Logging;
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using WorldBuilder.Shared.Lib;

namespace WorldBuilder.Shared.Documents {

    [MemoryPackable]
    public partial class LayoutDatEntry {
        public string TypeName = "";
        public byte[] Data = Array.Empty<byte>();
    }

    [MemoryPackable]
    public partial class LayoutDatData {
        public Dictionary<uint, LayoutDatEntry> Entries = new();
    }

    /// <summary>
    /// Project-side overrides for <see cref="LayoutDesc"/> (client local.dat). Marked dirty when layouts are saved from the UI editor;
    /// <see cref="Project.ExportDats"/> writes them via <see cref="IDatReaderWriter.TrySave{T}"/>.
    /// </summary>
    public partial class LayoutDatDocument : BaseDocument {
        public override string Type => nameof(LayoutDatDocument);

        public const string DocumentId = "ui_layouts";

        private const int PackBufferSize = 32 * 1024 * 1024;

        private LayoutDatData _data = new();
        private readonly Dictionary<uint, object> _objectCache = new();
        private DatDatabase? _localDatForUnpack;

        public LayoutDatDocument(ILogger logger) : base(logger) { }

        public int EntryCount => _data.Entries.Count;

        public bool HasStoredLayout(uint layoutId) => _data.Entries.ContainsKey(layoutId);

        public void SetLayout(uint layoutId, LayoutDesc layout) {
            layout.Id = layoutId;
            _objectCache[layoutId] = layout;

            try {
                var buffer = new byte[PackBufferSize];
                var writer = new DatBinWriter(buffer.AsMemory());
                ((IPackable)layout).Pack(writer);
                _data.Entries[layoutId] = new LayoutDatEntry {
                    TypeName = nameof(LayoutDesc),
                    Data = buffer[..writer.Offset]
                };
            }
            catch (Exception ex) {
                _logger.LogError(ex, "[LayoutDatDoc] Failed to pack layout 0x{Id:X8}", layoutId);
                _data.Entries[layoutId] = new LayoutDatEntry {
                    TypeName = nameof(LayoutDesc),
                    Data = Array.Empty<byte>()
                };
            }

            MarkDirty();
            OnUpdate(new BaseDocumentEvent());
        }

        public bool TryGetLayout(uint layoutId, out LayoutDesc? layout) {
            if (_objectCache.TryGetValue(layoutId, out var cached) && cached is LayoutDesc typed) {
                layout = typed;
                return true;
            }

            if (_data.Entries.TryGetValue(layoutId, out var entry) && entry.Data.Length > 0) {
                if (_localDatForUnpack == null) {
                    _logger.LogError("[LayoutDatDoc] Cannot unpack layout 0x{Id:X8}: local DAT context not initialized", layoutId);
                }
                else {
                    try {
                        var obj = new LayoutDesc();
                        var reader = new DatBinReader(entry.Data.AsMemory(), _localDatForUnpack);
                        ((IUnpackable)obj).Unpack(reader);
                        obj.Id = layoutId;
                        _objectCache[layoutId] = obj;
                        layout = obj;
                        return true;
                    }
                    catch (Exception ex) {
                        _logger.LogError(ex, "[LayoutDatDoc] Failed to unpack layout 0x{Id:X8}", layoutId);
                    }
                }
            }

            layout = default;
            return false;
        }

        public void RemoveLayout(uint layoutId) {
            _data.Entries.Remove(layoutId);
            _objectCache.Remove(layoutId);
            MarkDirty();
            OnUpdate(new BaseDocumentEvent());
        }

        protected override Task<bool> InitInternal(IDatReaderWriter datreader, DocumentManager documentManager) {
            _localDatForUnpack = datreader.Dats.Local;
            ClearDirty();
            return Task.FromResult(true);
        }

        protected override byte[] SaveToProjectionInternal() {
            SyncCacheToData();
            return MemoryPackSerializer.Serialize(_data);
        }

        protected override bool LoadFromProjectionInternal(byte[] projection) {
            try {
                _data = MemoryPackSerializer.Deserialize<LayoutDatData>(projection) ?? new();
                _objectCache.Clear();
                return true;
            }
            catch (MemoryPackSerializationException) {
                _logger.LogWarning("[LayoutDatDoc] Cache schema mismatch; resetting layout overrides");
                _data = new();
                _objectCache.Clear();
                return true;
            }
        }

        protected override Task<bool> SaveToDatsInternal(IDatReaderWriter datwriter, int iteration = 0) {
            SyncCacheToData();

            foreach (var (layoutId, entry) in _data.Entries) {
                bool saved = false;

                if (_objectCache.TryGetValue(layoutId, out var cachedObj) && cachedObj is LayoutDesc live) {
                    live.Id = layoutId;
                    saved = datwriter.TrySave(live, iteration);
                }

                if (!saved && entry.Data.Length > 0) {
                    saved = UnpackAndSave(datwriter, entry.Data, layoutId, iteration);
                }

                if (saved) {
                    _logger.LogInformation("[LayoutDatDoc] Exported layout 0x{Id:X8}", layoutId);
                }
                else if (entry.Data.Length > 0) {
                    _logger.LogError("[LayoutDatDoc] Failed to export layout 0x{Id:X8}", layoutId);
                }
            }

            ClearDirty();
            return Task.FromResult(true);
        }

        private void SyncCacheToData() {
            foreach (var (layoutId, obj) in _objectCache) {
                if (obj is not LayoutDesc live) continue;
                if (!_data.Entries.TryGetValue(layoutId, out var entry)) continue;
                try {
                    var buffer = new byte[PackBufferSize];
                    var writer = new DatBinWriter(buffer.AsMemory());
                    live.Id = layoutId;
                    ((IPackable)live).Pack(writer);
                    entry.Data = buffer[..writer.Offset];
                }
                catch (Exception ex) {
                    _logger.LogError(ex, "[LayoutDatDoc] Re-pack failed for 0x{Id:X8}", layoutId);
                }
            }
        }

        static bool UnpackAndSave(IDatReaderWriter writer, byte[] data, uint layoutId, int iteration) {
            var local = writer.Dats.Local;
            if (local == null) return false;
            var obj = new LayoutDesc();
            var reader = new DatBinReader(data.AsMemory(), local);
            ((IUnpackable)obj).Unpack(reader);
            obj.Id = layoutId;
            return writer.TrySave(obj, iteration);
        }
    }
}
