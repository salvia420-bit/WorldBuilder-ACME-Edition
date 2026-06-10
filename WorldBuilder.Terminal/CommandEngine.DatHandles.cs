using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using DatReaderWriter;
using DRW = DatReaderWriter;

namespace WorldBuilder.Terminal;

/// <summary>
/// Melt-integration Phase X.1 — secondary DAT handles.
/// See <c>docs/melt-integration-plan-2026-06-10.md</c> §4.1.
///
/// Melt's cross-DAT workflows all start from "open a second DAT and read
/// from it" (<c>cDatFile fromDat</c> parameters throughout
/// <c>datFileManipulation.cs</c>). WB.Terminal historically had exactly one
/// DAT set — the loaded project's. This file adds a registry of named,
/// read-only external DAT handles:
///
///   - <c>dat-open &lt;path&gt; &lt;alias&gt;</c> — open a DAT directory
///     (client_portal/cell_1/local_English/highres set) or a single
///     <c>.dat</c> file read-only and register it under <c>alias</c>.
///   - <c>dat-close &lt;alias&gt;</c> — dispose and unregister.
///   - <c>dat-list</c> — enumerate open handles.
///
/// Consumers: <c>region-diff</c> (Phase R) accepts an alias for
/// <c>otherDat</c>; Phase S <c>scene-diff</c> and Phase X.2 transplant
/// commands resolve their <c>fromDat</c> through this registry.
/// </summary>
public partial class CommandEngine {

    internal sealed class ExternalDatHandle : IDisposable {
        public required string Alias { get; init; }
        public required string Path { get; init; }
        public required string Kind { get; init; } // "collection" | "file"
        public DatCollection? Collection { get; init; }
        public DRW.DatDatabase? Single { get; init; }

        public bool TryGet<T>(uint fileId, out T? value) where T : class, DRW.Lib.IO.IDBObj {
            if (Collection != null) {
                var ok = Collection.TryGet<T>(fileId, out var v);
                value = v;
                return ok;
            }
            if (Single != null) {
                var ok = Single.TryGet<T>(fileId, out var v);
                value = v;
                return ok;
            }
            value = null;
            return false;
        }

        public void Dispose() {
            Collection?.Dispose();
            Single?.Dispose();
        }
    }

    private readonly Dictionary<string, ExternalDatHandle> _externalDats =
        new(StringComparer.OrdinalIgnoreCase);

    internal bool TryGetExternalDat(string alias, out ExternalDatHandle handle) =>
        _externalDats.TryGetValue(alias, out handle!);

    // ─────────────────────────────────────────────────────────────────
    //  Commands
    // ─────────────────────────────────────────────────────────────────

    public DatOpenResult DatOpen(string path, string alias) {
        if (string.IsNullOrWhiteSpace(path))
            throw new ArgumentException("path is required.", nameof(path));
        if (string.IsNullOrWhiteSpace(alias))
            throw new ArgumentException("alias is required.", nameof(alias));
        alias = alias.Trim();
        if (!alias.All(c => char.IsLetterOrDigit(c) || c is '-' or '_'))
            throw new ArgumentException($"alias '{alias}' must be alphanumeric/dash/underscore.");
        if (_externalDats.ContainsKey(alias))
            throw new InvalidOperationException($"alias '{alias}' is already open — dat-close it first.");

        var full = Path.GetFullPath(path.Trim());
        ExternalDatHandle handle;
        var files = new List<string>();

        if (Directory.Exists(full)) {
            // DatCollection requires the four standard EoR filenames.
            var expected = new[] { "client_portal.dat", "client_cell_1.dat", "client_local_English.dat", "client_highres.dat" };
            var missing = expected.Where(f => !File.Exists(Path.Combine(full, f))).ToList();
            if (missing.Count > 0)
                throw new FileNotFoundException(
                    $"Directory {full} is missing: {string.Join(", ", missing)}. " +
                    "For a single .dat file, pass the file path instead.");
            var collection = new DatCollection(full, DRW.Options.DatAccessType.Read);
            handle = new ExternalDatHandle {
                Alias = alias, Path = full, Kind = "collection", Collection = collection,
            };
            files.AddRange(expected);
        }
        else if (File.Exists(full)) {
            var db = new DRW.DatDatabase(o => {
                o.FilePath = full;
                o.AccessType = DRW.Options.DatAccessType.Read;
                o.IndexCachingStrategy = DRW.Options.IndexCachingStrategy.Never;
            });
            handle = new ExternalDatHandle {
                Alias = alias, Path = full, Kind = "file", Single = db,
            };
            files.Add(Path.GetFileName(full));
        }
        else {
            throw new FileNotFoundException($"path not found: {full}");
        }

        _externalDats[alias] = handle;
        return new DatOpenResult(alias, handle.Path, handle.Kind, files);
    }

    public DatCloseResult DatClose(string alias) {
        if (!_externalDats.Remove(alias, out var handle))
            throw new KeyNotFoundException($"No open DAT handle named '{alias}'. Use dat-list.");
        handle.Dispose();
        return new DatCloseResult(alias, handle.Path);
    }

    public DatListResult DatList() {
        var rows = _externalDats.Values
            .OrderBy(h => h.Alias, StringComparer.OrdinalIgnoreCase)
            .Select(h => new DatListRow(h.Alias, h.Path, h.Kind))
            .ToList();
        return new DatListResult(rows.Count, rows);
    }
}

// ── Melt-integration Phase X.1: external DAT handle results ──────────
public record DatOpenResult(string Alias, string Path, string Kind, List<string> Files);
public record DatCloseResult(string Alias, string Path);
public record DatListRow(string Alias, string Path, string Kind);
public record DatListResult(int Count, List<DatListRow> Rows);
