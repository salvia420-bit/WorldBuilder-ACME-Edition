// DatDeleteRepro — minimal, self-contained repro for DatReaderWriter's
// Tree.TryDelete corrupting the b-tree at scale (found 2026-08-19 building the
// r8 HIFI split: 2,412 requested deletes -> 169 landed, 3 innocent records lost,
// 1 phantom id, lookups broken after ~213).
//
// No retail dats needed: it builds a fresh dat, inserts N synthetic entries,
// deletes every STRIDE-th one, and then asserts the three properties a b-tree
// delete must preserve:
//   1. every requested key is gone,
//   2. every OTHER key is still there and still findable by TryGetFile,
//   3. an in-order walk is sorted and contains no ids that were never inserted.
//
// usage: DatDeleteRepro [--count N] [--stride S] [--seed K] [--quiet]
//        DatDeleteRepro --bisect          find the smallest N that corrupts
using DatReaderWriter.Enums;
using DatReaderWriter.Lib.IO.BlockAllocators;
using DatReaderWriter.Lib.IO.DatBTree;
using DatReaderWriter.Options;

int count = 20000, stride = 8, seed = 1;
bool quiet = false, bisect = false, shuffleDeletes = false;
for (int i = 0; i < args.Length; i++) {
    switch (args[i]) {
        case "--count": count = int.Parse(args[++i]); break;
        case "--stride": stride = int.Parse(args[++i]); break;
        case "--seed": seed = int.Parse(args[++i]); break;
        case "--quiet": quiet = true; break;
        case "--bisect": bisect = true; break;
        case "--shuffle-deletes": shuffleDeletes = true; break;
        default: Console.Error.WriteLine($"unknown arg {args[i]}"); return 2;
    }
}

if (bisect) {
    Console.WriteLine("bisecting the smallest entry count that corrupts (stride 8, ascending deletes)");
    int lo = 0;
    foreach (var n in new[] { 62, 100, 200, 400, 800, 1200, 1600, 2000, 3000, 4000, 6000, 8000, 12000, 20000 }) {
        var r = Run(n, stride, seed, quiet: true, shuffleDeletes);
        Console.WriteLine($"  N={n,6} deletes={r.requested,6} refused={r.refused,5} lost={r.lost,4} phantom={r.phantom,4} unordered={r.unordered,4} lookupFail={r.lookupFail,4}  {(r.Clean ? "clean" : "CORRUPT")}");
        if (!r.Clean && lo == 0) lo = n;
    }
    Console.WriteLine(lo == 0 ? "no corruption reproduced in this range" : $"first corrupting size in the probe set: N={lo}");
    return 0;
}

var res = Run(count, stride, seed, quiet, shuffleDeletes);
Console.WriteLine();
Console.WriteLine($"VERDICT: {(res.Clean ? "CLEAN" : "CORRUPT")}");
return res.Clean ? 0 : 1;

static Result Run(int count, int stride, int seed, bool quiet, bool shuffleDeletes = false) {
    var path = Path.Combine(Path.GetTempPath(), $"dat-delete-repro-{count}-{stride}-{seed}.dat");
    if (File.Exists(path)) File.Delete(path);

    var allocator = new MemoryMappedBlockAllocator(new DatDatabaseOptions {
        FilePath = path, AccessType = DatAccessType.ReadWrite
    });
    allocator.InitNew(DatFileType.Portal, 0);
    var tree = new DatBTreeReaderWriter(allocator);

    // ids are sparse and ascending, the way real dat ids are
    var ids = new List<uint>(count);
    for (int i = 0; i < count; i++) ids.Add((uint)(i + 1) * 3);

    // insert in shuffled order (deterministic per seed) — real dats are built
    // in id order, but shuffling proves the defect is in delete, not insert
    var rng = new Random(seed);
    var insertOrder = ids.ToList();
    for (int i = insertOrder.Count - 1; i > 0; i--) {
        int j = rng.Next(i + 1);
        (insertOrder[i], insertOrder[j]) = (insertOrder[j], insertOrder[i]);
    }
    foreach (var id in insertOrder)
        tree.Insert(new DatBTreeFile { Id = id, Size = 16, Version = 2, Iteration = 1 });

    var afterInsert = tree.Select(f => f.Id).ToList();
    if (!quiet) Console.WriteLine($"inserted {count} -> tree holds {afterInsert.Count}");

    // delete every STRIDE-th id, ascending (the r8 split's access pattern)
    var toDelete = ids.Where((_, i) => i % stride == 0).ToList();
    if (shuffleDeletes) {
        for (int i = toDelete.Count - 1; i > 0; i--) {
            int j = rng.Next(i + 1);
            (toDelete[i], toDelete[j]) = (toDelete[j], toDelete[i]);
        }
    }
    var expected = ids.ToHashSet();
    var r = new Result { requested = toDelete.Count };
    int idx = 0;
    foreach (var id in toDelete) {
        if (tree.TryDelete(id, out _)) expected.Remove(id);
        else {
            r.refused++;
            if (r.firstRefusedAt < 0) { r.firstRefusedAt = idx; r.firstRefusedId = id; }
        }
        idx++;
    }
    if (!quiet && r.refused > 0)
        Console.WriteLine($"TryDelete refused {r.refused}/{r.requested}; first refusal at delete #{r.firstRefusedAt} (id 0x{r.firstRefusedId:X8})");

    // --- the three invariants ------------------------------------------------
    var walked = tree.Select(f => f.Id).ToList();
    var walkedSet = walked.ToHashSet();
    var inserted = ids.ToHashSet();

    foreach (var id in expected) if (!walkedSet.Contains(id)) r.lost++;                 // never asked to delete it
    foreach (var id in walked) if (!inserted.Contains(id)) r.phantom++;                 // never inserted it
    foreach (var id in toDelete) if (walkedSet.Contains(id) && !expected.Contains(id)) r.zombie++;
    for (int i = 1; i < walked.Count; i++) if (walked[i] <= walked[i - 1]) r.unordered++;
    foreach (var id in expected) if (!tree.TryGetFile(id, out _)) r.lookupFail++;       // walk finds it, lookup can't

    if (!quiet) {
        Console.WriteLine($"survivors expected {expected.Count}, walk found {walked.Count}");
        Console.WriteLine($"  innocent records LOST : {r.lost}");
        Console.WriteLine($"  phantom ids           : {r.phantom}");
        Console.WriteLine($"  'deleted' still there : {r.zombie}");
        Console.WriteLine($"  out-of-order walk hits: {r.unordered}");
        Console.WriteLine($"  TryGetFile misses     : {r.lookupFail}");
    }

    tree.Dispose();
    allocator.Dispose();
    File.Delete(path);
    return r;
}

class Result {
    public int requested, refused, lost, phantom, zombie, unordered, lookupFail;
    public int firstRefusedAt = -1;
    public uint firstRefusedId;
    public bool Clean => refused == 0 && lost == 0 && phantom == 0 && zombie == 0 && unordered == 0 && lookupFail == 0;
}
