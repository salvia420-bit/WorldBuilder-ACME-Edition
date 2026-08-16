using System;
using System.Collections.Generic;
using System.Linq;
using ACE.DatLoader;

// usage: AceDatWalk <dat> [<baseDatForDiff>]
// exit 0 = every entry read; nonzero = any failure.
class Program {
    static int Main(string[] args) {
        if (args.Length < 1) { Console.Error.WriteLine("usage: AceDatWalk <dat> [baseDat]"); return 2; }
        var dat = new DatDatabase(args[0]);
        int fail = 0, read = 0;
        var bytesOf = new Dictionary<uint, byte[]>();
        foreach (var kv in dat.AllFiles.OrderBy(k => k.Key)) {
            try {
                var r = dat.GetReaderForFile(kv.Key);
                if (r?.Buffer == null || r.Buffer.Length == 0) { fail++; Console.WriteLine($"EMPTY 0x{kv.Key:X8}"); continue; }
                read++;
                if (args.Length > 1) bytesOf[kv.Key] = r.Buffer;
            } catch (Exception e) { fail++; Console.WriteLine($"FAIL 0x{kv.Key:X8} {e.Message}"); }
        }
        Console.WriteLine($"walk: {dat.AllFiles.Count} entries, {read} read, {fail} fail");
        if (args.Length > 1) {
            var b = new DatDatabase(args[1]);
            int changed = 0, missing = 0, added = 0;
            foreach (var kv in b.AllFiles.OrderBy(k => k.Key)) {
                if (!bytesOf.TryGetValue(kv.Key, out var cur)) { missing++; Console.WriteLine($"MISSING 0x{kv.Key:X8}"); continue; }
                var br = b.GetReaderForFile(kv.Key);
                if (br?.Buffer == null || !br.Buffer.AsSpan().SequenceEqual(cur)) changed++;
            }
            added = bytesOf.Count - (b.AllFiles.Count - missing);
            Console.WriteLine($"diff vs base: {changed} changed, {missing} missing, {added} added");
        }
        return fail == 0 ? 0 : 1;
    }
}
