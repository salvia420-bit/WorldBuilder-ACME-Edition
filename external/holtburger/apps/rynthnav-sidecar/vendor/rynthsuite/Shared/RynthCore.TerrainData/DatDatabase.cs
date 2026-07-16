// vendored from /mnt/wbterminal1/ac-refs/rynthsuite/Shared/RynthCore.TerrainData/DatDatabase.cs @ bf1fb52 on 2026-07-16; upstream is read-only reference
using System;
using System.Collections.Generic;
using System.IO;

namespace RynthCore.Plugin.RynthAi.Raycasting
{
    /// <summary>
    /// AC .dat file reader — ported directly from ACEmulator's DatLoader.
    /// 
    /// Key format details (from ACE source):
    ///   - Header at file offset 0x140
    ///   - Block chain: FIRST 4 bytes of each block = next block address (byte offset)
    ///                  Remaining (BlockSize - 4) bytes = data
    ///   - B-tree node (DatDirectoryHeader): 62 branches, entry count, 61 entries × 24 bytes = 1716 total
    ///   - All pointers (BTree root, chain pointers, file offsets) are byte offsets
    /// </summary>
    public class DatDatabase : IDisposable
    {
        private FileStream _stream;
        private readonly object _lock = new object();

        private const uint DAT_HEADER_OFFSET = 0x140;

        // B-tree geometry (from ACE DatDirectoryHeader.cs):
        //   0x3E (62) branches, 0x3D (61) max entries, each entry = 6 × uint32 = 24 bytes
        //   ObjectSize = (4 * 62) + 4 + (24 * 61) = 248 + 4 + 1464 = 1716
        private const int BTREE_BRANCH_COUNT = 0x3E; // 62
        private const int BTREE_MAX_ENTRIES = 0x3D;   // 61
        private const int BTREE_ENTRY_SIZE = 24;      // 6 × uint32
        private const int BTREE_NODE_SIZE = (4 * BTREE_BRANCH_COUNT) + 4 + (BTREE_ENTRY_SIZE * BTREE_MAX_ENTRIES); // 1716

        // Header fields
        public uint FileType { get; private set; }
        public uint BlockSize { get; private set; }
        public uint FileSize { get; private set; }
        public uint DataSet { get; private set; }
        public uint BTreeRoot { get; private set; } // Byte offset

        public bool IsLoaded { get; private set; }
        public string FilePath { get; private set; }
        public int RecordCount { get; private set; }

        // All files indexed by ObjectId (populated during Open)
        private readonly Dictionary<uint, DatBTreeEntry> _allFiles = new Dictionary<uint, DatBTreeEntry>();

        public List<string> DiagLog { get; } = new List<string>();

        public bool Open(string path)
        {
            try
            {
                if (!File.Exists(path))
                {
                    Log($"File not found: {path}");
                    return false;
                }

                FilePath = path;
                // Plugin init runs *before* acclient.exe opens its own DAT files,
                // so our handle is the first one Windows sees on the file. Our
                // share-mode dictates what AC's subsequent open can request — if
                // we omit FileShare.Delete, AC's open (which needs delete-rename
                // semantics for DDD/patcher) fails with a sharing violation and
                // the AC client errors out with "cannot access the data files."
                //
                // FileShare.ReadWrite | FileShare.Delete = permit other openers
                // to read, write, and delete-mark the file. RandomAccess hint +
                // 4 KB buffer keeps the .dat B-tree reads efficient.
                _stream = new FileStream(
                    path,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete,
                    bufferSize: 4096,
                    options: FileOptions.RandomAccess);

                Log($"File: {Path.GetFileName(path)}, Size: {_stream.Length:N0} bytes");

                if (!ReadHeader())
                {
                    Close();
                    return false;
                }

                // Read the entire B-tree directory and index all files
                ReadDirectory(BTreeRoot);

                RecordCount = _allFiles.Count;
                IsLoaded = true;

                Log($"SUCCESS: {RecordCount} files indexed, BlockSize={BlockSize}, Root=0x{BTreeRoot:X8}");

                return true;
            }
            catch (Exception ex)
            {
                Log($"Error: {ex.Message}");
                Close();
                return false;
            }
        }

        /// <summary>
        /// Reads the dat header from offset 0x140.
        /// Format matches ACE's DatDatabaseHeader.Unpack().
        /// </summary>
        private bool ReadHeader()
        {
            if (_stream.Length < DAT_HEADER_OFFSET + 64)
            {
                Log("File too small");
                return false;
            }

            _stream.Seek(DAT_HEADER_OFFSET, SeekOrigin.Begin);
            using (var reader = new BinaryReader(_stream, System.Text.Encoding.Default, true))
            {
                FileType = reader.ReadUInt32();
                BlockSize = reader.ReadUInt32();
                FileSize = reader.ReadUInt32();
                DataSet = reader.ReadUInt32();
                uint dataSubset = reader.ReadUInt32();

                uint freeHead = reader.ReadUInt32();
                uint freeTail = reader.ReadUInt32();
                uint freeCount = reader.ReadUInt32();
                BTreeRoot = reader.ReadUInt32();
            }

            Log($"FileType=0x{FileType:X8}, BlockSize={BlockSize}, DataSet={DataSet}, BTree=0x{BTreeRoot:X8}");

            if (BlockSize == 0 || BTreeRoot == 0 || BTreeRoot >= (uint)_stream.Length)
            {
                Log("Invalid header values");
                return false;
            }

            return true;
        }

        /// <summary>
        /// Reads data from the dat file following the block chain.
        /// Matches ACE's DatReader.ReadDat() exactly.
        /// 
        /// Block format:
        ///   [4 bytes: next block address] [BlockSize - 4 bytes: data]
        ///   
        /// The FIRST 4 bytes of each block are the chain pointer (next block address).
        /// If 0, this is the last block.
        /// </summary>
        private byte[] ReadDatData(uint offset, int size)
        {
            if (offset + BlockSize > (uint)_stream.Length || size <= 0)
                return null;

            byte[] buffer = new byte[size];

            _stream.Seek(offset, SeekOrigin.Begin);

            // Read first 4 bytes = next block address
            byte[] addrBuf = new byte[4];
            _stream.Read(addrBuf, 0, 4);
            uint nextAddress = BitConverter.ToUInt32(addrBuf, 0);

            int bufferOffset = 0;
            int remaining = size;

            while (remaining > 0)
            {
                if (nextAddress == 0)
                {
                    // Last block — read remaining data directly
                    int toRead = Math.Min(remaining, (int)(_stream.Length - _stream.Position));
                    if (toRead <= 0) break;
                    _stream.Read(buffer, bufferOffset, toRead);
                    remaining = 0;
                }
                else
                {
                    // Read data portion of this block (BlockSize - 4 bytes)
                    int dataInBlock = (int)BlockSize - 4;
                    int toRead = Math.Min(dataInBlock, remaining);
                    _stream.Read(buffer, bufferOffset, toRead);
                    bufferOffset += toRead;
                    remaining -= toRead;

                    if (remaining > 0)
                    {
                        // Follow chain to next block
                        if (nextAddress >= (uint)_stream.Length) break;
                        _stream.Seek(nextAddress, SeekOrigin.Begin);

                        // Read next block's chain pointer
                        _stream.Read(addrBuf, 0, 4);
                        nextAddress = BitConverter.ToUInt32(addrBuf, 0);
                    }
                }
            }

            return buffer;
        }

        /// <summary>
        /// Recursively reads the B-tree directory and indexes all files.
        /// Matches ACE's DatDirectory.Read() + AddFilesToList().
        /// </summary>
        private void ReadDirectory(uint sectorOffset)
        {
            if (sectorOffset == 0 || sectorOffset >= (uint)_stream.Length)
                return;

            // Read the directory header (B-tree node)
            byte[] nodeData;
            lock (_lock)
            {
                nodeData = ReadDatData(sectorOffset, BTREE_NODE_SIZE);
            }

            if (nodeData == null || nodeData.Length < BTREE_NODE_SIZE)
                return;

            // Parse branches (62 × uint32)
            uint[] branches = new uint[BTREE_BRANCH_COUNT];
            for (int i = 0; i < BTREE_BRANCH_COUNT; i++)
                branches[i] = BitConverter.ToUInt32(nodeData, i * 4);

            // Parse entry count
            int countOffset = BTREE_BRANCH_COUNT * 4; // 248
            uint entryCount = BitConverter.ToUInt32(nodeData, countOffset);

            if (entryCount > BTREE_MAX_ENTRIES)
                return; // Invalid node

            // Parse entries
            int entriesOffset = countOffset + 4; // 252
            var entries = new DatBTreeEntry[entryCount];

            for (int i = 0; i < entryCount; i++)
            {
                int eOff = entriesOffset + i * BTREE_ENTRY_SIZE;
                entries[i] = new DatBTreeEntry
                {
                    BitFlags = BitConverter.ToUInt32(nodeData, eOff),
                    ObjectId = BitConverter.ToUInt32(nodeData, eOff + 4),
                    FileOffset = BitConverter.ToUInt32(nodeData, eOff + 8),
                    FileSize = BitConverter.ToUInt32(nodeData, eOff + 12)
                };
            }

            // Recurse into child directories (if branches[0] != 0, node has children)
            if (branches[0] != 0)
            {
                for (int i = 0; i < entryCount + 1 && i < BTREE_BRANCH_COUNT; i++)
                {
                    if (branches[i] != 0)
                        ReadDirectory(branches[i]);
                }
            }

            // Add entries to the file index
            for (int i = 0; i < entryCount; i++)
            {
                if (entries[i].ObjectId != 0)
                    _allFiles[entries[i].ObjectId] = entries[i];
            }
        }

        /// <summary>
        /// Finds a file by ID. O(1) lookup from the pre-built index.
        /// </summary>
        public DatBTreeEntry FindFile(uint fileId)
        {
            if (!IsLoaded) return null;
            _allFiles.TryGetValue(fileId, out var entry);
            return entry;
        }

        /// <summary>
        /// Reads file data for a given entry.
        /// </summary>
        public byte[] ReadFileData(DatBTreeEntry entry)
        {
            if (!IsLoaded || entry == null || entry.FileSize == 0 || _stream == null)
                return null;

            lock (_lock)
            {
                return ReadDatData(entry.FileOffset, (int)entry.FileSize);
            }
        }

        public byte[] GetFileData(uint fileId)
        {
            var entry = FindFile(fileId);
            return entry != null ? ReadFileData(entry) : null;
        }

        /// <summary>
        /// Returns all interior cell IDs (0x0100–0xFFFD) for a given landblock from the dat index.
        /// This avoids the sequential scan gap cutoff that misses cells in large dungeons.
        /// </summary>
        public List<uint> GetLandblockCellIds(uint landblockKey)
        {
            var cellIds = new List<uint>();
            if (!IsLoaded) return cellIds;

            uint prefix = landblockKey << 16;
            foreach (var id in _allFiles.Keys)
            {
                if ((id & 0xFFFF0000) != prefix) continue;
                uint cell = id & 0xFFFF;
                if (cell >= 0x0100 && cell <= 0xFFFD)
                    cellIds.Add(id);
            }
            return cellIds;
        }

        /// <summary>
        /// Returns sample file IDs from the index for diagnostics.
        /// </summary>
        public List<uint> GetSampleIds(int maxCount = 20)
        {
            var ids = new List<uint>();
            foreach (var kvp in _allFiles)
            {
                ids.Add(kvp.Key);
                if (ids.Count >= maxCount) break;
            }
            return ids;
        }

        public void Close()
        {
            _stream?.Dispose();
            _stream = null;
            IsLoaded = false;
            _allFiles.Clear();
        }

        public void Dispose() { Close(); }

        private void Log(string msg)
        {
            string line = $"[DatDB] {msg}";
            System.Diagnostics.Debug.WriteLine(line);
            if (DiagLog.Count < 100) DiagLog.Add(line);
        }
    }

    public class DatBTreeEntry
    {
        public uint BitFlags;
        public uint ObjectId;
        public uint FileOffset;  // Byte offset into file
        public uint FileSize;
    }
}
