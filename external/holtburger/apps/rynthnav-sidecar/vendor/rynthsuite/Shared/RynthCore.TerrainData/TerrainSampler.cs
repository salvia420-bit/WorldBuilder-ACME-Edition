// vendored from /mnt/wbterminal1/ac-refs/rynthsuite/Shared/RynthCore.TerrainData/TerrainSampler.cs @ bf1fb52 on 2026-07-16; upstream is read-only reference
using System;
using System.Collections.Generic;
using System.IO;
using RynthCore.Plugin.RynthAi.Raycasting;

namespace RynthCore.TerrainData;

/// <summary>
/// Self-contained terrain-data provider for AC landblocks: opens the client's
/// portal/cell .dat files, parses the 256-entry land-height table from RegionDesc,
/// and exposes per-landblock heights, slope passability, and terrain-type/water
/// lookups. Reuses the shared DatDatabase/LandblockData parsers; the slope math
/// and height-table prefix parse are reimplemented here so this carries no
/// dependency on RynthAi's raycasting engine.
/// </summary>
public sealed class TerrainSampler : IDisposable
{
    // AC's actual walkable threshold from ACE PhysicsGlobals.FloorZ — anything
    // with normal.Z below this value is blocked by is_valid_walkable. The visual
    // overlay must match the game's blocker, not a tuned-for-scatter looser
    // value, or moderate slopes the game blocks render as walkable.
    // (RynthAi's ScatterSystem.FloorZ is intentionally looser to suppress
    // gentle-slope false positives on vegetation placement and is unrelated.)
    public const float FloorZ = 0.66417414618662751f;

    private const float CellLength = 24.0f;

    private readonly DatDatabase _portalDat = new();
    private readonly DatDatabase _cellDat = new();
    private float[]? _landHeightTable;
    private bool _ready;

    private readonly Dictionary<uint, LandblockData?> _cache = new();
    private const int MaxCache = 30;

    public bool IsReady => _ready;
    public string Status { get; private set; } = "uninitialized";

    /// <summary>
    /// Opens the AC .dat files and loads the land-height table. Idempotent. When
    /// acFolderPath is null, uses the running process's directory — inside an
    /// injected plugin that's acclient.exe's folder, where the active client's
    /// .dat files live.
    /// </summary>
    public bool Initialize(string? acFolderPath = null)
    {
        if (_ready) return true;
        try
        {
            string? folder = acFolderPath;
            if (string.IsNullOrEmpty(folder))
            {
                string? exe = Environment.ProcessPath;
                folder = string.IsNullOrEmpty(exe) ? null : Path.GetDirectoryName(exe);
            }
            if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder))
            {
                Status = $"AC folder not found ({folder ?? "null"})";
                return false;
            }

            string? portalPath = FindDat(folder, "client_portal.dat", "portal.dat");
            string? cellPath = FindDat(folder, "client_cell_1.dat", "cell.dat");
            if (portalPath == null || cellPath == null)
            {
                Status = $"portal/cell .dat not found in {folder}";
                return false;
            }

            if (!_portalDat.Open(portalPath) || !_cellDat.Open(cellPath))
            {
                Status = "failed to open .dat files";
                return false;
            }

            if (!LoadLandHeightTable())
            {
                Status = "RegionDesc land-height table parse failed";
                return false;
            }

            _ready = true;
            Status = "ready";
            return true;
        }
        catch (Exception ex)
        {
            Status = ex.Message;
            return false;
        }
    }

    /// <summary>Parsed landblock (heights + terrain words), cached. Null if unavailable.</summary>
    public LandblockData? LoadLandblock(uint landblockKey)
    {
        if (!_ready || _landHeightTable == null) return null;
        if (_cache.TryGetValue(landblockKey, out var cached)) return cached;

        LandblockData? data = LandblockData.Load(_cellDat, landblockKey, _landHeightTable);
        if (_cache.Count >= MaxCache) _cache.Clear();
        _cache[landblockKey] = data;
        return data;
    }

    /// <summary>
    /// AC's per-cell diagonal-split PRNG (ACE LandblockStruct.ConstructPolygons /
    /// FSplitNESW). When true the cell is cut SW→NE (triangles SW-SE-NE and
    /// SW-NE-NW); when false it's cut SE→NW (triangles SW-SE-NW and SE-NE-NW).
    /// Roughly 50/50 across cells. Slope and Z-interpolation queries must agree
    /// with this or they describe the wrong triangle pair.
    ///
    /// The PRNG inputs are the cell's *vertex-grid* coordinates (landblock
    /// index × 8 + cell index within landblock), NOT raw landblock indices —
    /// this matches ACE's <c>blockid_to_lcoord</c>, which shifts the byte
    /// landblock index left by <c>LandblockShift</c> (= 3, i.e. ×8) before
    /// feeding it to the seed multiplications. Getting this wrong gives the
    /// wrong diagonal on most cells and paints the wrong triangle half.
    /// </summary>
    public static bool SwToNeCut(uint landblockKey, int cellX, int cellY)
    {
        int lbX = (int)((landblockKey >> 8) & 0xFF);
        int lbY = (int)(landblockKey & 0xFF);
        int vertexX = (lbX << 3) + cellX; // lbX * 8 + cellX (ACE LandblockShift = 3)
        int vertexY = (lbY << 3) + cellY;
        unchecked
        {
            uint seedA = (uint)vertexX * 214614067u;
            uint seedB = (uint)vertexX * 1109124029u;
            uint magicA = seedA + 1813693831u;
            uint magicB = seedB;
            uint splitDir = (uint)vertexY * magicA - magicB - 1369149221u;
            return (splitDir & 0x80000000u) != 0;
        }
    }

    /// <summary>
    /// Per-triangle walkability for cell (cx,cy) in landblock <paramref name="lb"/>.
    /// The tri1/tri2 identity depends on <paramref name="swToNeCut"/>:
    ///   swToNeCut=true  → tri1 = SE half (SW,SE,NE); tri2 = NW half (SW,NE,NW)
    ///   swToNeCut=false → tri1 = SW half (SW,SE,NW); tri2 = NE half (SE,NE,NW)
    /// <paramref name="floorZ"/> overrides the default walkable-normal threshold
    /// (defaults to <see cref="FloorZ"/>); the visual overlay exposes it as a
    /// slider so the user can match what AC actually blocks in their environment.
    /// </summary>
    public static void GetTrianglePassability(LandblockData lb, int cx, int cy, bool swToNeCut,
        out bool tri1Passable, out bool tri2Passable, float floorZ = FloorZ)
    {
        float h00 = lb.GetVertexZ(cx,     cy);
        float h10 = lb.GetVertexZ(cx + 1, cy);
        float h01 = lb.GetVertexZ(cx,     cy + 1);
        float h11 = lb.GetVertexZ(cx + 1, cy + 1);

        float nzSquare = CellLength * CellLength;

        float n1x, n1y, n2x, n2y;
        if (swToNeCut)
        {
            // tri1 (SE): SW(0,0,h00), SE(24,0,h10), NE(24,24,h11)
            n1x = -CellLength * (h10 - h00);
            n1y = -CellLength * (h11 - h10);
            // tri2 (NW): SW(0,0,h00), NE(24,24,h11), NW(0,24,h01)
            n2x = -CellLength * (h11 - h01);
            n2y = -CellLength * (h01 - h00);
        }
        else
        {
            // tri1 (SW): SW(0,0,h00), SE(24,0,h10), NW(0,24,h01)
            n1x = -CellLength * (h10 - h00);
            n1y = -CellLength * (h01 - h00);
            // tri2 (NE): SE(24,0,h10), NE(24,24,h11), NW(0,24,h01)
            n2x = -CellLength * (h11 - h01);
            n2y = -CellLength * (h11 - h10);
        }

        float z1 = nzSquare / (float)Math.Sqrt(n1x * n1x + n1y * n1y + nzSquare * nzSquare);
        float z2 = nzSquare / (float)Math.Sqrt(n2x * n2x + n2y * n2y + nzSquare * nzSquare);
        tri1Passable = z1 >= floorZ;
        tri2Passable = z2 >= floorZ;
    }

    /// <summary>
    /// Convenience overload that looks up the cell's split direction itself.
    /// </summary>
    public static void GetTrianglePassability(LandblockData lb, int cx, int cy,
        out bool tri1Passable, out bool tri2Passable)
        => GetTrianglePassability(lb, cx, cy, SwToNeCut(lb.LandblockKey, cx, cy),
            out tri1Passable, out tri2Passable);

    /// <summary>
    /// AC terrain-type index (0–31) at vertex (ix,iy), 0–8. Decoded from the
    /// CellLandblock terrain word: bits 0–1 road, 2–10 terrain type, 11+ scene.
    /// Returns -1 if unavailable.
    /// </summary>
    public static int GetTerrainType(LandblockData lb, int ix, int iy)
    {
        var words = lb.TerrainWords;
        if (words == null) return -1;
        int idx = ix * 9 + iy;
        if ((uint)idx >= 81) return -1;
        return (words[idx] >> 2) & 0x1F;
    }

    private static string? FindDat(string folder, params string[] names)
    {
        foreach (var n in names)
        {
            string p = Path.Combine(folder, n);
            if (File.Exists(p)) return p;
        }
        return null;
    }

    private bool LoadLandHeightTable()
    {
        byte[]? data = _portalDat.GetFileData(0x13000000);
        // 12 (header) + >=2 (PString) + 32 (LandDefs prefix) + 256*4 (table)
        if (data == null || data.Length < 12 + 2 + 32 + 256 * 4) return false;

        using var ms = new MemoryStream(data);
        using var r = new BinaryReader(ms);

        r.ReadUInt32(); // id 0x13000000
        r.ReadUInt32(); // regionNumber
        r.ReadUInt32(); // version
        SkipPString(r, ms); // RegionName

        // LandDefs prefix (8 scalar fields) precedes the height table.
        r.ReadInt32();  // NumBlockLength
        r.ReadInt32();  // NumBlockWidth
        r.ReadSingle(); // SquareLength
        r.ReadInt32();  // LBlockLength
        r.ReadInt32();  // VertexPerCell
        r.ReadSingle(); // MaxObjHeight
        r.ReadSingle(); // SkyHeight
        r.ReadSingle(); // RoadWidth

        var table = new float[256];
        for (int i = 0; i < 256; i++) table[i] = r.ReadSingle();
        _landHeightTable = table;
        return true;
    }

    // PString: ushort length, that many bytes, padded to a 4-byte boundary.
    private static void SkipPString(BinaryReader reader, MemoryStream ms)
    {
        ushort len = reader.ReadUInt16();
        if (len > 0 && ms.Position + len <= ms.Length)
            ms.Seek(len, SeekOrigin.Current);
        long aligned = (ms.Position + 3) & ~3L;
        if (aligned <= ms.Length) ms.Position = aligned;
    }

    public void Dispose()
    {
        _portalDat.Dispose();
        _cellDat.Dispose();
        _ready = false;
    }
}
