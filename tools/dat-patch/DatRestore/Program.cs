// DatRestore — copy raw records verbatim from a source dat (e.g. retail base)
// into a target dat, preserving the source b-tree entry's flags/version/iter.
// Used to undo cross-lane RenderSurface-id collisions (a texture wave that
// overwrote a record another lane depends on — e.g. terrain base textures
// clobbered to 2048^2 DXT that MergeTexture must have as 512^2 A8R8G8B8).
//
// usage: DatRestore <target.dat> <source.dat> <idHex> [<idHex> ...]
using DatReaderWriter;
using DatReaderWriter.Options;
using DatReaderWriter.Lib.IO.DatBTree;

if (args.Length < 3) { Console.Error.WriteLine("usage: DatRestore <target> <source> <idHex>..."); return 2; }
using var target = new PortalDatabase(args[0], DatAccessType.ReadWrite);
using var source = new PortalDatabase(args[1], DatAccessType.Read);
int ok = 0, fail = 0;
foreach (var a in args[2..])
{
    uint id = Convert.ToUInt32(a.Replace("0x", ""), 16);
    if (!source.Tree.TryGetFile(id, out var sEntry) || !source.TryGetFileBytes(id, out var bytes, autoDecompress: true))
    { Console.Error.WriteLine($"  0x{id:X8} not in source"); fail++; continue; }
    var res = target.TryWriteFileBytes(id, bytes, bytes.Length, sEntry);
    if (res) { Console.WriteLine($"  restored 0x{id:X8} ({bytes.Length} bytes)"); ok++; }
    else { Console.Error.WriteLine($"  0x{id:X8} write failed: {res.Error}"); fail++; }
}
Console.WriteLine($"restored={ok} failed={fail}");
return fail > 0 ? 1 : 0;
