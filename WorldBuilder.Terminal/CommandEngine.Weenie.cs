using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.AceDb;

namespace WorldBuilder.Terminal;

public partial class CommandEngine {
    // ─────────────────────────────────────────────────────────────────
    //  O4: ACE DB Weenie CRUD (insert / save scalars / delete / enum keys)
    // ─────────────────────────────────────────────────────────────────

    public async Task<WeenieSaveScalarsResult> WeenieSaveScalarsAsync(uint classId, string? jsonPath) {
        RequireProject();
        if (string.IsNullOrEmpty(jsonPath))
            throw new ArgumentException("--from-json <path> is required for weenie save.");
        if (!File.Exists(jsonPath))
            throw new FileNotFoundException($"JSON file not found: {jsonPath}", jsonPath);

        var snap = JsonSerializer.Deserialize<AceWeenieSnapshot>(
            File.ReadAllText(jsonPath), JsonOpts.CaseInsensitive)
            ?? throw new InvalidOperationException("Failed to deserialize AceWeenieSnapshot.");
        snap.ClassId = classId;

        using var connector = RequireAceDbConnector();
        var ok = await connector.SaveWeenieScalarsAsync(snap);
        return new WeenieSaveScalarsResult(ok, classId,
            snap.Ints.Count, snap.Int64s.Count, snap.Bools.Count, snap.Floats.Count,
            snap.Strings.Count, snap.DataIds.Count, snap.InstanceIds.Count);
    }

    public async Task<WeenieInsertResult> WeenieInsertAsync(string className, string jsonPath) {
        RequireProject();
        if (string.IsNullOrWhiteSpace(className))
            throw new ArgumentException("className is required.", nameof(className));
        if (string.IsNullOrEmpty(jsonPath))
            throw new ArgumentException("--from-json <path> is required.");
        if (!File.Exists(jsonPath))
            throw new FileNotFoundException($"JSON file not found: {jsonPath}", jsonPath);

        var snap = JsonSerializer.Deserialize<AceWeenieSnapshot>(
            File.ReadAllText(jsonPath), JsonOpts.CaseInsensitive)
            ?? throw new InvalidOperationException("Failed to deserialize AceWeenieSnapshot.");

        using var connector = RequireAceDbConnector();
        var newId = await connector.InsertWeenieAsync(className, snap);
        return new WeenieInsertResult(newId != 0, newId, className,
            snap.Ints.Count + snap.Int64s.Count + snap.Bools.Count + snap.Floats.Count
            + snap.Strings.Count + snap.DataIds.Count + snap.InstanceIds.Count);
    }

    public async Task<WeenieDeleteResult> WeenieDeleteAsync(uint classId) {
        RequireProject();
        using var connector = RequireAceDbConnector();
        var ok = await connector.DeleteWeenieAsync(classId);
        return new WeenieDeleteResult(ok, classId);
    }

    public WeeniePropertyKeysResult WeenieListPropertyKeys(string family) {
        var (kind, names) = family.ToLowerInvariant() switch {
            "int" => ("int",
                Enum.GetValues<AcePropertyInt>()
                    .Select(v => new WeeniePropertyKey((ushort)v, v.ToString())).ToList()),
            "int64" => ("int64",
                Enum.GetValues<AcePropertyInt64>()
                    .Select(v => new WeeniePropertyKey((ushort)v, v.ToString())).ToList()),
            "bool" => ("bool",
                Enum.GetValues<AcePropertyBool>()
                    .Select(v => new WeeniePropertyKey((ushort)v, v.ToString())).ToList()),
            "float" => ("float",
                Enum.GetValues<AcePropertyFloat>()
                    .Select(v => new WeeniePropertyKey((ushort)v, v.ToString())).ToList()),
            "string" => ("string",
                Enum.GetValues<AcePropertyString>()
                    .Select(v => new WeeniePropertyKey((ushort)v, v.ToString())).ToList()),
            "did" or "dataid" => ("did",
                Enum.GetValues<AcePropertyDataId>()
                    .Select(v => new WeeniePropertyKey((ushort)v, v.ToString())).ToList()),
            "iid" or "instanceid" => ("iid",
                Enum.GetValues<AcePropertyInstanceId>()
                    .Select(v => new WeeniePropertyKey((ushort)v, v.ToString())).ToList()),
            _ => throw new ArgumentException($"Unknown property family '{family}'. Expected one of: int, int64, bool, float, string, did, iid.")
        };
        var sorted = names.OrderBy(k => k.Type).ToList();
        return new WeeniePropertyKeysResult(kind, sorted.Count, sorted);
    }
}
