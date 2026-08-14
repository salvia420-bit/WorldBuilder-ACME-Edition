using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace WorldBuilder.Terminal;

// ═════════════════════════════════════════════════════════════════════
//  relief-plan-apply — engine orchestration.
//
//  summary JSON + plan JSON + obj-export OBJ → validated additive
//  geometry appended to the OBJ (original bytes preserved verbatim as
//  an exact prefix). On gate failure nothing is written except the
//  checks report (success:false with per-check diagnostics the artist
//  model uses to repair its plan). With import:true the result is also
//  imported in-process over the retail GfxObj id (obj-import semantics:
//  overwrite + preservePhysics + gfxObjOnly).
// ═════════════════════════════════════════════════════════════════════

public record ReliefPlanApplyResult(
    bool Success, string GfxObj = "", int AddedTris = 0, int TotalTris = 0,
    int ChecksPassed = 0, int ChecksFailed = 0,
    string? OutObjPath = null, string? ChecksReportPath = null,
    bool Imported = false, int ImportTriCount = 0, bool ImportPreservedPhysics = false,
    List<object>? PlanErrors = null, List<string>? FailedChecks = null,
    List<string>? Warnings = null, string? Error = null);

public partial class CommandEngine {

    public ReliefPlanApplyResult ReliefPlanApply(string summaryPath, string planPath,
            string objPath, string outObjPath, bool import = false, string? checksReportPath = null) {
        if (!File.Exists(summaryPath)) return new(false, Error: $"summary not found: {summaryPath}");
        if (!File.Exists(planPath)) return new(false, Error: $"plan not found: {planPath}");
        if (!File.Exists(objPath)) return new(false, Error: $"OBJ not found: {objPath}");

        ReliefSummary sum;
        ReliefPlan plan;
        try { sum = ReliefSummary.Parse(summaryPath); }
        catch (Exception ex) { return new(false, Error: $"summary parse: {ex.Message}"); }
        try { plan = ReliefPlan.Parse(planPath); }
        catch (Exception ex) { return new(false, Error: $"plan parse: {ex.Message}"); }

        var planErrors = new List<object>();
        void WriteReport(object payload) {
            if (string.IsNullOrEmpty(checksReportPath)) return;
            var dir = Path.GetDirectoryName(checksReportPath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(checksReportPath, JsonSerializer.Serialize(payload,
                new JsonSerializerOptions { WriteIndented = true }));
        }

        if (!string.Equals(plan.GfxObjHex, sum.GfxObjHex, StringComparison.OrdinalIgnoreCase)) {
            planErrors.Add(new { feature = -1, op = "plan", code = "gfxobj-mismatch",
                message = $"plan targets {plan.GfxObjHex} but the summary describes {sum.GfxObjHex}" });
            WriteReport(new { success = false, gfxObj = sum.GfxObjHex, planErrors, checks = Array.Empty<object>() });
            return new(false, sum.GfxObjHex, PlanErrors: planErrors, Error: "plan/summary gfxObj mismatch");
        }
        if (sum.Unstructured) {
            planErrors.Add(new { feature = -1, op = "plan", code = "unstructured-model",
                message = "the summary flags this model as unstructured; relief ops are not defined on it" });
            WriteReport(new { success = false, gfxObj = sum.GfxObjHex, planErrors, checks = Array.Empty<object>() });
            return new(false, sum.GfxObjHex, PlanErrors: planErrors, Error: "unstructured model");
        }

        byte[] origBytes = File.ReadAllBytes(objPath);
        var origModel = ReliefObjModel.Parse(origBytes);
        if (origModel.F.Count == 0)
            return new(false, sum.GfxObjHex, Error: "original OBJ contains no faces");

        // ── generate ────────────────────────────────────────────────
        var gen = new ReliefPlanGenerator(sum, plan);
        bool genOk;
        try { genOk = gen.Run(); }
        catch (Exception ex) {
            return new(false, sum.GfxObjHex, Error: $"generator exception: {ex.Message}");
        }
        if (!genOk) {
            foreach (var e in gen.Errors)
                planErrors.Add(new { feature = e.Feature, op = e.Op, code = e.Code, message = e.Message, data = e.Data });
            WriteReport(new { success = false, gfxObj = sum.GfxObjHex, plan = planPath, planErrors,
                checks = Array.Empty<object>(), warnings = gen.Warnings });
            return new(false, sum.GfxObjHex, PlanErrors: planErrors, Warnings: gen.Warnings,
                Error: $"plan rejected: {gen.Errors.Count} diagnostic(s); see checksReport / planErrors");
        }

        // ── assemble + gate ─────────────────────────────────────────
        var ordered = ReliefObjWriter.GroupOrder(gen.Tris);
        byte[] outBytes = ReliefObjWriter.Append(origBytes, origModel, ordered,
            Path.GetFileNameWithoutExtension(planPath));
        List<GateCheck> checks;
        try { checks = ReliefGate.Run(origBytes, outBytes, sum, plan, ordered); }
        catch (Exception ex) {
            return new(false, sum.GfxObjHex, Error: $"gate exception: {ex.Message}");
        }
        var failed = checks.Where(c => !c.Pass).Select(c => c.Name).ToList();

        WriteReport(new {
            success = failed.Count == 0,
            gfxObj = sum.GfxObjHex,
            plan = planPath,
            addedTris = ordered.Count,
            totalTris = origModel.F.Count + ordered.Count,
            planErrors,
            warnings = gen.Warnings,
            checks = checks.Select(c => new { name = c.Name, pass = c.Pass, detail = c.Detail,
                value = c.Value, limit = c.Limit }).ToArray(),
        });

        if (failed.Count > 0)
            return new(false, sum.GfxObjHex, ordered.Count, origModel.F.Count + ordered.Count,
                checks.Count - failed.Count, failed.Count,
                ChecksReportPath: checksReportPath, FailedChecks: failed, Warnings: gen.Warnings,
                Error: $"validation gate failed: {string.Join(", ", failed)}");

        // ── write + optional import ─────────────────────────────────
        var outDir = Path.GetDirectoryName(outObjPath);
        if (!string.IsNullOrEmpty(outDir)) Directory.CreateDirectory(outDir);
        File.WriteAllBytes(outObjPath, outBytes);

        bool imported = false; int impTris = 0; bool impPhys = false;
        if (import) {
            // fallback surface must resolve; every face names its surface via usemtl anyway
            uint fallbackDid = Convert.ToUInt32(sum.Materials.First().Replace("surface_0x", ""), 16);
            var imp = ObjImport(outObjPath, fallbackDid, gfxObjId: sum.GfxObjId,
                overwrite: true, preservePhysics: true, gfxObjOnly: true);
            if (!imp.Success)
                return new(false, sum.GfxObjHex, ordered.Count, origModel.F.Count + ordered.Count,
                    checks.Count, 0, outObjPath, checksReportPath, Warnings: gen.Warnings,
                    Error: $"gate passed and OBJ written, but obj-import failed: {imp.Error}");
            imported = true; impTris = imp.TriangleCount; impPhys = imp.PreservedPhysics;
        }

        return new(true, sum.GfxObjHex, ordered.Count, origModel.F.Count + ordered.Count,
            checks.Count, 0, outObjPath, checksReportPath, imported, impTris, impPhys,
            Warnings: gen.Warnings);
    }
}
