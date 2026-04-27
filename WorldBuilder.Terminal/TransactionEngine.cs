using System.Text.Json.Nodes;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib.Validation;

namespace WorldBuilder.Terminal;

/// <summary>
/// Stage / validate / commit-or-rollback wrapper around the existing JSON command surface.
///
/// Composes other commands rather than introducing a parallel mutation alphabet: each op
/// in a transact body re-enters <see cref="JsonCommandProcessor.DispatchInternal"/>. Failure
/// (op throws, op returns success:false, or post-batch validation reports an error) restores
/// the in-memory document projections snapshotted before the batch ran. The DocumentManager
/// flush channel is unaffected — we restore via <see cref="BaseDocument.LoadFromProjection"/>
/// and then call <see cref="BaseDocument.ForceSave"/> so the restored state lands as the last
/// queued update for each touched document.
///
/// v1 invariants (documented in the plan):
///   • The stdin loop is single-threaded; only one transact runs at a time.
///   • DocumentManager batch flushes are NOT paused mid-transaction. Intermediate dirty state
///     may briefly hit SQLite; the post-rollback ForceSave overwrites it on the next batch.
///   • Nesting is rejected — a transact op inside a transact body is refused.
/// </summary>
internal sealed class TransactionEngine {
    // Commands explicitly safe to run inside a transact. Anything else is rejected.
    private static readonly HashSet<string> AllowedOps = new(StringComparer.OrdinalIgnoreCase) {
        "set-landblock-heightmap", "set-landblock-terrain",
        "bulk-place-objects",
        "add-object", "remove-object", "move-object", "rotate-object",
        "clear-objects",
        "raise", "lower", "smooth", "set-height", "paint", "fill",
        "road", "paste-stamp",
        "generate-dungeon",
    };

    // Ops that mutate the singleton TerrainDocument ("terrain").
    private static readonly HashSet<string> TerrainSingletonOps = new(StringComparer.OrdinalIgnoreCase) {
        "set-landblock-heightmap", "set-landblock-terrain",
        "raise", "lower", "smooth", "set-height", "paint", "fill",
        "road", "paste-stamp",
    };

    // Ops that target a specific LandblockDocument identified by lbX/lbY in args.
    private static readonly HashSet<string> LandblockTargetedOps = new(StringComparer.OrdinalIgnoreCase) {
        "bulk-place-objects",
        "add-object", "remove-object", "move-object", "rotate-object",
        "clear-objects",
    };

    // Ops that may create or mutate a DungeonDocument identified by lbX/lbY.
    private static readonly HashSet<string> DungeonTargetedOps = new(StringComparer.OrdinalIgnoreCase) {
        "generate-dungeon",
    };

    // paste-stamp can mutate multiple LandblockDocuments not declared in args. We conservatively
    // snapshot every existing LandblockDocument in ActiveDocs at the start of the batch, and
    // record any new LandblockDocuments that appear after the op runs as created-by-transact.
    private static readonly HashSet<string> WideLandblockOps = new(StringComparer.OrdinalIgnoreCase) {
        "paste-stamp",
    };

    private readonly JsonCommandProcessor _processor;
    private readonly HeadlessProjectManager _projectManager;

    public TransactionEngine(JsonCommandProcessor processor, HeadlessProjectManager projectManager) {
        _processor = processor;
        _projectManager = projectManager;
    }

    public TransactResult Run(JsonArray ops, bool rollbackOnFail, JsonNode? validateNode) {
        var txId = Guid.NewGuid();
        var startedAt = DateTime.UtcNow;

        // ── Validate every op against the allow-list before mutating anything. ──
        // A single rejection aborts the whole batch with no side effects. We run this
        // before the project-loaded check so callers get the most specific error for
        // batches that are also broken (nested transact, unknown op, etc.).
        var preOpRejection = PreflightOps(ops);
        if (preOpRejection != null) {
            return new TransactResult(
                Success: false, Status: "rolled-back", Reason: "rejected",
                Ops: new List<TransactOpOutcome>(),
                Validation: null,
                Journal: new TransactJournal(txId, startedAt, DateTime.UtcNow,
                    new List<string>(), new List<string>(), 0, 0),
                Error: preOpRejection);
        }

        if (_projectManager.CurrentProject == null) {
            return new TransactResult(
                Success: false, Status: "rolled-back", Reason: "rejected",
                Ops: new List<TransactOpOutcome>(),
                Validation: null,
                Journal: new TransactJournal(txId, startedAt, DateTime.UtcNow,
                    new List<string>(), new List<string>(), 0, 0),
                Error: "No project loaded — call 'load' before 'transact'.");
        }

        var dm = _projectManager.CurrentProject.DocumentManager;

        // ── Snapshot scope. ─────────────────────────────────────────────────
        var snapshots = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        var preexistingDocIds = new HashSet<string>(dm.ActiveDocs.Keys, StringComparer.Ordinal);
        var maybeCreatedIds = new HashSet<string>(StringComparer.Ordinal);
        var wideLandblockMode = ops.OfType<JsonNode>()
            .Any(o => WideLandblockOps.Contains(GetCommandName(o)));

        SnapshotScope(ops, dm, snapshots, maybeCreatedIds, wideLandblockMode);

        // ── Run ops sequentially, halting on first failure. ─────────────────
        var outcomes = new List<TransactOpOutcome>(ops.Count);
        bool batchFailure = false;
        string failReason = "ok";
        var touchedLbKeys = new HashSet<ushort>();

        for (int i = 0; i < ops.Count; i++) {
            var opNode = ops[i];
            if (opNode == null) {
                outcomes.Add(new TransactOpOutcome(i, "<null>", false,
                    BuildErrorEnvelope("<null>", "Op is null"), "Op is null"));
                batchFailure = true;
                failReason = "op-threw";
                break;
            }

            var commandName = GetCommandName(opNode);
            // For generate-dungeon, force the inner op's `validate` flag false so the
            // engine doesn't double-validate (transact runs its own validation step).
            if (commandName.Equals("generate-dungeon", StringComparison.OrdinalIgnoreCase)) {
                opNode["validate"] = false;
            }

            // Seed touched-LB candidates from explicit args before the op runs.
            if (TryParseLbKeyFromArgs(opNode, out var preLbKey)) {
                touchedLbKeys.Add(preLbKey);
            }

            string responseJson;
            try {
                responseJson = _processor.DispatchInternal(commandName, opNode);
            } catch (Exception ex) {
                outcomes.Add(new TransactOpOutcome(i, commandName, false,
                    BuildErrorEnvelope(commandName, ex.Message), ex.Message));
                batchFailure = true;
                failReason = "op-threw";
                break;
            }

            bool opOk = ResponseSaysSuccess(responseJson);
            outcomes.Add(new TransactOpOutcome(i, commandName, opOk, responseJson,
                opOk ? null : ExtractError(responseJson)));

            // Pull touched landblocks from the response so brush ops (smooth/raise/etc.)
            // can drive the validation scope even though they take world coords.
            CollectTouchedLbsFromResponse(responseJson, touchedLbKeys);

            if (!opOk) {
                batchFailure = true;
                failReason = "op-returned-failure";
                break;
            }
        }

        // ── Validation step. ────────────────────────────────────────────────
        List<ValidationReport>? validationReports = null;
        if (!batchFailure) {
            validationReports = RunValidation(validateNode, touchedLbKeys, dm);
            if (validationReports != null && validationReports.Any(r => r.ErrorCount > 0)) {
                batchFailure = true;
                failReason = "validation-failure";
            }
        }

        // ── Decide commit / rollback. ───────────────────────────────────────
        bool shouldRollback = batchFailure && rollbackOnFail;
        int opsApplied = outcomes.Count(o => o.Success);
        int opsRolledBack = shouldRollback ? opsApplied : 0;
        var documentsCreated = new List<string>();

        // Identify docs the batch created. Tracked dungeon docs are always candidates;
        // in wideLandblockMode (paste-stamp), any new landblock_* doc also counts.
        var createdNow = dm.ActiveDocs.Keys
            .Where(id => !preexistingDocIds.Contains(id) &&
                (maybeCreatedIds.Contains(id) ||
                 (wideLandblockMode && id.StartsWith("landblock_", StringComparison.Ordinal))))
            .ToList();

        if (shouldRollback) {
            // Restore pre-op projections (in-memory) and force a flush so SQLite catches up.
            foreach (var (docId, bytes) in snapshots) {
                if (dm.ActiveDocs.TryGetValue(docId, out var doc)) {
                    doc.LoadFromProjection(bytes);
                    doc.ForceSave();
                }
                // If the doc isn't in ActiveDocs anymore, there's nothing to restore in
                // memory; the snapshot was effectively orphaned.
            }
            // Delete any docs the batch created.
            foreach (var docId in createdNow) {
                if (dm.ActiveDocs.TryRemove(docId, out var doc)) {
                    doc.IsDirty = false;     // suppress any pending channel write
                }
                try {
                    dm.DocumentStorageService.DeleteDocumentAsync(docId).GetAwaiter().GetResult();
                } catch {
                    // Storage delete may fail if the doc was never persisted yet — ignore.
                }
            }
        } else {
            // Committed — record the docs the batch created so the journal is complete.
            documentsCreated.AddRange(createdNow);
        }

        var finishedAt = DateTime.UtcNow;
        var status = shouldRollback ? "rolled-back" : "committed";
        // When rollback_on_fail is false but validation/op failed, status is still
        // "committed" (the user opted out of rollback) but Success reflects the failure.
        bool overallSuccess = !batchFailure;

        return new TransactResult(
            Success: overallSuccess,
            Status: status,
            Reason: batchFailure ? failReason : "ok",
            Ops: outcomes,
            Validation: validationReports,
            Journal: new TransactJournal(
                TransactionId: txId,
                StartedAt: startedAt,
                FinishedAt: finishedAt,
                DocumentsTouched: snapshots.Keys.ToList(),
                DocumentsCreated: documentsCreated,
                OpsApplied: opsApplied,
                OpsRolledBack: opsRolledBack));
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Preflight: reject the batch with a clear error if any op is unsafe.
    // ─────────────────────────────────────────────────────────────────────
    private static string? PreflightOps(JsonArray ops) {
        if (ops.Count == 0) return "ops array is empty";
        for (int i = 0; i < ops.Count; i++) {
            var node = ops[i];
            if (node == null) return $"ops[{i}] is null";
            var commandName = GetCommandName(node);
            if (string.IsNullOrWhiteSpace(commandName))
                return $"ops[{i}] is missing 'command'";
            if (commandName.Equals("transact", StringComparison.OrdinalIgnoreCase))
                return $"ops[{i}] is a nested transact (not supported in v1)";
            if (!AllowedOps.Contains(commandName))
                return $"ops[{i}] command '{commandName}' is not transactable";
            if (commandName.Equals("clear-objects", StringComparison.OrdinalIgnoreCase) &&
                node["all"]?.GetValue<bool>() == true) {
                return $"ops[{i}] clear-objects with all:true mutates every populated landblock and is not transactable";
            }
        }
        return null;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Snapshot scope inference. Captures projection bytes for documents the
    //  batch will mutate, before any op runs. paste-stamp triggers a wide
    //  LandblockDocument snapshot since it can mutate LBs not declared in args.
    // ─────────────────────────────────────────────────────────────────────
    private static void SnapshotScope(JsonArray ops, DocumentManager dm,
        Dictionary<string, byte[]> snapshots, HashSet<string> maybeCreatedIds, bool wideLandblockMode) {

        bool needsTerrain = false;
        var landblockKeys = new HashSet<ushort>();
        var dungeonKeys = new HashSet<ushort>();

        foreach (var node in ops.OfType<JsonNode>()) {
            var commandName = GetCommandName(node);
            if (TerrainSingletonOps.Contains(commandName)) needsTerrain = true;
            if (LandblockTargetedOps.Contains(commandName) && TryParseLbKeyFromArgs(node, out var lbKey)) {
                landblockKeys.Add(lbKey);
            }
            if (DungeonTargetedOps.Contains(commandName) && TryParseLbKeyFromArgs(node, out var dlbKey)) {
                dungeonKeys.Add(dlbKey);
            }
        }

        if (needsTerrain) TrySnapshot(dm, "terrain", snapshots);

        foreach (var k in landblockKeys) {
            TrySnapshot(dm, $"landblock_{k:X4}", snapshots);
        }

        if (wideLandblockMode) {
            // Snapshot every LandblockDocument that's currently active. Any LB created
            // by paste-stamp during the batch becomes a "delete on rollback" candidate.
            foreach (var (id, doc) in dm.ActiveDocs) {
                if (id.StartsWith("landblock_", StringComparison.Ordinal) && !snapshots.ContainsKey(id)) {
                    snapshots[id] = doc.SaveToProjection();
                }
            }
        }

        foreach (var k in dungeonKeys) {
            var docId = $"dungeon_{k:X4}";
            if (dm.ActiveDocs.TryGetValue(docId, out var doc)) {
                snapshots[docId] = doc.SaveToProjection();
            } else {
                // Doc doesn't exist yet — the op will create it. Track for rollback-deletion.
                maybeCreatedIds.Add(docId);
            }
        }
    }

    private static void TrySnapshot(DocumentManager dm, string docId, Dictionary<string, byte[]> snapshots) {
        if (snapshots.ContainsKey(docId)) return;
        if (dm.ActiveDocs.TryGetValue(docId, out var doc)) {
            snapshots[docId] = doc.SaveToProjection();
        }
        // v1 limitation: if a doc isn't yet loaded into ActiveDocs, we don't snapshot it
        // here. Rollback is best-effort for ops that touch unloaded docs — the realistic
        // agent loop loads landblocks via inspect/validate before mutating, so this case
        // is rare. To get strict restore in that case, the caller should pre-touch the
        // doc (e.g., a list-objects op) before the mutating op.
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Validation scope. "auto" = touched LBs from arg-derived + response-derived
    //  sets. Brush ops contribute via their `landblocks` response field.
    // ─────────────────────────────────────────────────────────────────────
    private List<ValidationReport>? RunValidation(JsonNode? validateNode, HashSet<ushort> touchedLbKeys, DocumentManager dm) {
        var mode = validateNode?.GetValueKind() == System.Text.Json.JsonValueKind.String
            ? validateNode!.GetValue<string>()
            : (validateNode == null ? "auto" : "<object>");

        var reports = new List<ValidationReport>();
        var engine = _processor.Engine;

        if (mode.Equals("none", StringComparison.OrdinalIgnoreCase)) {
            return reports;
        }

        if (mode.Equals("all", StringComparison.OrdinalIgnoreCase)) {
            foreach (var (id, _) in dm.ActiveDocs) {
                if (!id.StartsWith("landblock_", StringComparison.Ordinal)) continue;
                if (!ushort.TryParse(id.Substring("landblock_".Length),
                    System.Globalization.NumberStyles.HexNumber,
                    System.Globalization.CultureInfo.InvariantCulture, out var lbKey)) continue;
                uint lbX = (uint)((lbKey >> 8) & 0xFF);
                uint lbY = (uint)(lbKey & 0xFF);
                reports.Add(engine.ValidateAll(lbX, lbY));
            }
            return reports;
        }

        // Explicit landblock list
        if (validateNode is JsonObject obj && obj["landblocks"] is JsonArray lbArr) {
            foreach (var n in lbArr.OfType<JsonNode>()) {
                var s = n.GetValue<string>();
                if (TryParseHexLbKey(s, out var lbKey)) {
                    reports.Add(engine.ValidateAll((uint)((lbKey >> 8) & 0xFF), (uint)(lbKey & 0xFF)));
                }
            }
            return reports;
        }

        // Default: "auto" — touched LBs (validate-all) + right/top neighbors (terrain only).
        var validatedKeys = new HashSet<ushort>();
        foreach (var lbKey in touchedLbKeys) {
            uint lbX = (uint)((lbKey >> 8) & 0xFF);
            uint lbY = (uint)(lbKey & 0xFF);
            reports.Add(engine.ValidateAll(lbX, lbY));
            validatedKeys.Add(lbKey);
        }
        // Right/top neighbors get terrain-only validation to catch TRN005 edge mismatches
        // without paying the full validate-all cost on landblocks the batch didn't touch.
        foreach (var lbKey in touchedLbKeys) {
            uint lbX = (uint)((lbKey >> 8) & 0xFF);
            uint lbY = (uint)(lbKey & 0xFF);
            foreach (var (nx, ny) in new (uint, uint)[] { (lbX + 1, lbY), (lbX, lbY + 1) }) {
                if (nx > 254 || ny > 254) continue;
                ushort neighborKey = (ushort)((nx << 8) | ny);
                if (validatedKeys.Contains(neighborKey)) continue;
                try {
                    reports.Add(engine.ValidateTerrain(nx, ny));
                } catch {
                    // Neighbor may not have terrain data — skip silently.
                }
            }
        }
        return reports;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Helpers.
    // ─────────────────────────────────────────────────────────────────────
    private static string GetCommandName(JsonNode node) {
        return node["command"]?.GetValue<string>()?.Trim() ?? string.Empty;
    }

    private static bool TryParseLbKeyFromArgs(JsonNode node, out ushort lbKey) {
        lbKey = 0;
        var lbXNode = node["lbX"];
        var lbYNode = node["lbY"];
        if (lbXNode == null || lbYNode == null) return false;
        try {
            uint lbX = lbXNode.GetValue<uint>();
            uint lbY = lbYNode.GetValue<uint>();
            lbKey = (ushort)((lbX << 8) | lbY);
            return true;
        } catch {
            return false;
        }
    }

    private static bool TryParseHexLbKey(string s, out ushort lbKey) {
        lbKey = 0;
        if (string.IsNullOrEmpty(s)) return false;
        var trimmed = s.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? s.Substring(2) : s;
        return ushort.TryParse(trimmed,
            System.Globalization.NumberStyles.HexNumber,
            System.Globalization.CultureInfo.InvariantCulture, out lbKey);
    }

    private static bool ResponseSaysSuccess(string responseJson) {
        try {
            var n = JsonNode.Parse(responseJson);
            return n?["success"]?.GetValue<bool>() ?? false;
        } catch {
            return false;
        }
    }

    private static string? ExtractError(string responseJson) {
        try {
            var n = JsonNode.Parse(responseJson);
            return n?["error"]?.GetValue<string>();
        } catch {
            return null;
        }
    }

    private static void CollectTouchedLbsFromResponse(string responseJson, HashSet<ushort> touched) {
        try {
            var n = JsonNode.Parse(responseJson);
            if (n is null) return;
            // "landblocks": [ "0xXXXX", ... ]
            if (n["landblocks"] is JsonArray arr) {
                foreach (var item in arr.OfType<JsonNode>()) {
                    if (TryParseHexLbKey(item.GetValue<string>(), out var k)) touched.Add(k);
                }
            }
            // "landblock": "0xXXXX"
            if (n["landblock"]?.GetValue<string>() is string singleLb &&
                TryParseHexLbKey(singleLb, out var k2)) {
                touched.Add(k2);
            }
            // "affectedLandblocks": [ "0xXXXX", ... ]
            if (n["affectedLandblocks"] is JsonArray arr2) {
                foreach (var item in arr2.OfType<JsonNode>()) {
                    if (TryParseHexLbKey(item.GetValue<string>(), out var k)) touched.Add(k);
                }
            }
        } catch {
            // Best-effort — response may not have landblock fields.
        }
    }

    private static string BuildErrorEnvelope(string command, string error) {
        var obj = new JsonObject {
            ["success"] = false,
            ["command"] = command,
            ["error"] = error,
        };
        return obj.ToJsonString();
    }
}
