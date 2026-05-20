using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using DatReaderWriter;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Options;
using DatReaderWriter.Types;
using ChorEnum = Chorizite.Common.Enums;

namespace WorldBuilder.Terminal;

/// <summary>
/// Wave 3.C diagnostic surface — port of the swing-pose classifier spec
/// at
/// <c>external/holtburger/docs/swing-classification-spec-2026-05-19.md</c>.
///
/// <para>
/// **Validated foundation:** the spec is empirically validated against
/// all 436 retail motion tables via
/// <c>crates/holtburger-dat/tests/motion_table_monsters.rs</c>; 5,455
/// link entries across 436 tables show 0 violations of the three
/// load-bearing invariants:
/// <list type="number">
///   <item>"swings live in <c>links</c>, not <c>cycles</c>"</item>
///   <item>"<c>Ready = 0x0003</c> is the only <c>from_substate</c>"</item>
///   <item>"each swing link carries exactly 1 anim"</item>
/// </list>
/// See <c>project_motion_table_audit_2026-05-19</c> +
/// <c>project_swing_classification_spec_2026-05-19</c> memory.
/// </para>
///
/// <para>
/// **Key encoding** (per spec §3.2 + the inspect probe at
/// <c>motion_table_inspect.rs:88-95</c>): <c>Links</c> is a
/// <c>Dictionary&lt;int, MotionCommandData&gt;</c> where the outer key
/// is <c>(stance &amp; 0xFFFF) &lt;&lt; 16 | (from_substate &amp; 0xFFFF)</c>.
/// The inner <c>MotionCommandData.MotionData</c> dictionary is keyed by
/// the <c>to_substate</c> (LOW 16 bits of the destination command).
/// </para>
///
/// <para>
/// **Reference encoding from retail:** see
/// <c>~/ac-headers/acclient.c::CMotionTable::GetObjectSequence</c> at
/// <c>acclient.c:337641</c> for the canonical sequence-assembly:
/// <c>(pre_link, link MotionData, cycle anim)</c>. The link's
/// <c>MotionData</c> carries the swing keyframes; the cycle is just
/// the return-to-Ready hold.
/// </para>
///
/// Commands:
///   - <c>motion-classify-swing</c> — classify a single
///     <c>(motionTableId, stance, attackHeight)</c> triple, returning
///     the resolved swing motion command + its anim spec, or a
///     diagnostic "no link" / "no anim" / "wrong height" failure.
/// </summary>
public partial class CommandEngine {

    /// <summary>
    /// Compact identifier for the resolved swing class — High / Medium /
    /// Low for melee; Cast for magic; Aim for the missile stances; Unknown
    /// for everything else.
    /// </summary>
    public enum SwingLinkClass {
        Melee_High,
        Melee_Medium,
        Melee_Low,
        Magic_Cast,
        Aim,
        Unknown,
    }

    /// <summary>
    /// Result of a single swing classification.
    ///
    /// <para>
    /// <see cref="ResolvedMotionCmd"/> is the full 32-bit retail
    /// MotionCommand resolved from the (stance, attackHeight) input —
    /// e.g. for <c>(SwordCombat, High)</c> the classifier returns
    /// <see cref="ChorEnum.MotionCommand.SlashHigh"/> = 0x1000005b. When
    /// <see cref="FailureReason"/> is non-null, this is null and the
    /// caller should treat it as "no swing in this stance at this height".
    /// </para>
    ///
    /// <para>
    /// <see cref="AnimId"/>, <see cref="LowFrame"/>, <see cref="HighFrame"/>,
    /// <see cref="Framerate"/> mirror the wasm-side
    /// <c>MotionLinkAnimJs</c> struct (per spec §3.2). The C# oracle
    /// reads them from <c>MotionTable.Links[outerKey].MotionData[toSub].Anims[0]</c>
    /// — invariant "always exactly 1 anim" per the 5,455-entry audit.
    /// </para>
    /// </summary>
    public sealed record SwingClassifyResult(
        uint MotionTableId,
        uint Stance,
        uint AttackHeight,
        uint? ResolvedMotionCmd,
        SwingLinkClass LinkClass,
        uint? AnimId,
        int? LowFrame,
        int? HighFrame,
        float? Framerate,
        int OuterLinkCount,
        int InnerLinkCount,
        string? FailureReason,
        string Source);

    /// <summary>
    /// Default candidates a melee swing classifier consults for a given
    /// attackHeight. Order matters — we walk it and pick the first
    /// MotionCommand that resolves to a link in the loaded motion table.
    ///
    /// <para>
    /// Per spec §2.1, retail stances put the canonical AttackHi/Med/Lo
    /// commands at the head of each stance's swing list. For HandCombat
    /// these are <c>AttackHigh1/Med1/Low1</c>; for the named-weapon
    /// stances these are <c>SlashHigh/Med/Low</c> (with Thrust as a
    /// secondary). Per spec §8.2 monsters may also use the bare AttackHi
    /// commands in NonCombat stance.
    /// </para>
    /// </summary>
    private static readonly Dictionary<uint, uint[]> CandidatesByHeight = new() {
        // AttackHeight.High = 1
        [(uint)ChorEnum.AttackHeight.High] = new uint[] {
            (uint)ChorEnum.MotionCommand.AttackHigh1,
            (uint)ChorEnum.MotionCommand.SlashHigh,
            (uint)ChorEnum.MotionCommand.ThrustHigh,
            (uint)ChorEnum.MotionCommand.AttackHigh2,
            (uint)ChorEnum.MotionCommand.AttackHigh3,
            (uint)ChorEnum.MotionCommand.DoubleSlashHigh,
            (uint)ChorEnum.MotionCommand.DoubleThrustHigh,
            (uint)ChorEnum.MotionCommand.TripleSlashHigh,
            (uint)ChorEnum.MotionCommand.TripleThrustHigh,
            (uint)ChorEnum.MotionCommand.OffhandSlashHigh,
            (uint)ChorEnum.MotionCommand.OffhandThrustHigh,
        },
        // AttackHeight.Medium = 2
        [(uint)ChorEnum.AttackHeight.Medium] = new uint[] {
            (uint)ChorEnum.MotionCommand.AttackMed1,
            (uint)ChorEnum.MotionCommand.SlashMed,
            (uint)ChorEnum.MotionCommand.ThrustMed,
            (uint)ChorEnum.MotionCommand.AttackMed2,
            (uint)ChorEnum.MotionCommand.AttackMed3,
            (uint)ChorEnum.MotionCommand.DoubleSlashMed,
            (uint)ChorEnum.MotionCommand.DoubleThrustMed,
            (uint)ChorEnum.MotionCommand.TripleSlashMed,
            (uint)ChorEnum.MotionCommand.TripleThrustMed,
            (uint)ChorEnum.MotionCommand.OffhandSlashMed,
            (uint)ChorEnum.MotionCommand.OffhandThrustMed,
        },
        // AttackHeight.Low = 3
        [(uint)ChorEnum.AttackHeight.Low] = new uint[] {
            (uint)ChorEnum.MotionCommand.AttackLow1,
            (uint)ChorEnum.MotionCommand.SlashLow,
            (uint)ChorEnum.MotionCommand.ThrustLow,
            (uint)ChorEnum.MotionCommand.AttackLow2,
            (uint)ChorEnum.MotionCommand.AttackLow3,
            (uint)ChorEnum.MotionCommand.DoubleSlashLow,
            (uint)ChorEnum.MotionCommand.DoubleThrustLow,
            (uint)ChorEnum.MotionCommand.TripleSlashLow,
            (uint)ChorEnum.MotionCommand.TripleThrustLow,
            (uint)ChorEnum.MotionCommand.OffhandSlashLow,
            (uint)ChorEnum.MotionCommand.OffhandThrustLow,
        },
    };

    /// <summary>
    /// Magic-stance gesture candidates. attackHeight is meaningless for
    /// the Magic stance per spec §2.2 — every cast resolves to
    /// MagicBlast (the iconic gesture). The validator may pass a
    /// distinguishing input to widen the search.
    /// </summary>
    private static readonly uint[] MagicCandidates = new uint[] {
        (uint)ChorEnum.MotionCommand.MagicBlast,
        (uint)ChorEnum.MotionCommand.MagicSelfHead,
        (uint)ChorEnum.MotionCommand.MagicSelfHeart,
    };

    /// <summary>
    /// Port of the swing classifier per
    /// <c>swing-classification-spec-2026-05-19.md</c>.
    ///
    /// <para>
    /// Algorithm:
    /// <list type="number">
    ///   <item>Load <see cref="MotionTable"/> via <see cref="DatDatabase"/>
    ///     against the canonical <c>~/ac_base_dats/client_portal.dat</c>
    ///     per memory <c>feedback_base_dats_only_for_bake</c>.</item>
    ///   <item>Build the outer link key as
    ///     <c>(stance &amp; 0xFFFF) &lt;&lt; 16 | (Ready &amp; 0xFFFF)</c>,
    ///     where <c>Ready = 0x41000003</c>; LOW 16 bits = <c>0x0003</c>.</item>
    ///   <item>Lookup <c>MotionTable.Links[outerKey]</c>. If missing →
    ///     return <c>FailureReason = "no-link-for-stance"</c>.</item>
    ///   <item>Walk the candidate list for the given attackHeight (or
    ///     the magic candidates if the stance is Magic). For each
    ///     candidate full MotionCommand, look up
    ///     <c>linkData.MotionData[candidate &amp; 0xFFFF]</c>. The first
    ///     hit is the resolved swing.</item>
    ///   <item>Return the anim spec (id + low + high + framerate) from
    ///     <c>resolvedData.Anims[0]</c>. Invariant: always exactly 1
    ///     anim per spec §1.</item>
    /// </list>
    /// </para>
    ///
    /// <para>
    /// **Stance-agnostic invariant** (spec §8.2 Finding A): monster
    /// motion tables put swings in <c>NonCombat</c> stance, not just
    /// the named-weapon stances. The classifier MUST NOT switch
    /// behavior based on stance name — it just consults
    /// <c>Links[outerKey]</c> and the link either resolves or it
    /// doesn't.
    /// </para>
    /// </summary>
    public SwingClassifyResult MotionClassifySwing(
        uint motionTableId, uint stance, uint attackHeight, string? datPath = null) {

        const uint READY_SUBSTATE = 0x0003u; // Ready = 0x41000003, LOW 16 = 0x0003
        const string SPEC_REF =
            "external/holtburger/docs/swing-classification-spec-2026-05-19.md §3 + " +
            "~/ac-headers/acclient.c:337641 CMotionTable::GetObjectSequence";

        var resolvedDatPath = ResolveDatPath(datPath);
        using var dat = new DatDatabase(o => {
            o.FilePath = resolvedDatPath;
            o.AccessType = DatAccessType.Read;
            o.IndexCachingStrategy = IndexCachingStrategy.Never;
        });

        if (!dat.TryGet<MotionTable>(motionTableId, out var mt) || mt == null) {
            return new SwingClassifyResult(
                MotionTableId: motionTableId,
                Stance: stance,
                AttackHeight: attackHeight,
                ResolvedMotionCmd: null,
                LinkClass: SwingLinkClass.Unknown,
                AnimId: null,
                LowFrame: null,
                HighFrame: null,
                Framerate: null,
                OuterLinkCount: 0,
                InnerLinkCount: 0,
                FailureReason: $"motion-table-not-in-dat ({resolvedDatPath} has no 0x{motionTableId:X8})",
                Source: SPEC_REF);
        }

        int outerCount = mt.Links?.Count ?? 0;

        // Build the outer key per spec §3.2 (mirrors
        // motion_table_inspect.rs:88-95).
        int outerKey = (int)((stance & 0xFFFFu) << 16 | (READY_SUBSTATE & 0xFFFFu));

        if (mt.Links == null || !mt.Links.TryGetValue(outerKey, out var linkData) || linkData == null) {
            return new SwingClassifyResult(
                MotionTableId: motionTableId,
                Stance: stance,
                AttackHeight: attackHeight,
                ResolvedMotionCmd: null,
                LinkClass: SwingLinkClass.Unknown,
                AnimId: null,
                LowFrame: null,
                HighFrame: null,
                Framerate: null,
                OuterLinkCount: outerCount,
                InnerLinkCount: 0,
                FailureReason: $"no-link-for-stance-ready (outerKey=0x{outerKey:X8} not in Links)",
                Source: SPEC_REF);
        }

        int innerCount = linkData.MotionData?.Count ?? 0;

        // Decide which candidate set to consult based on the stance.
        // Magic stance gets the gesture candidates; everything else
        // gets the height-keyed melee list. This is "stance-aware
        // candidate selection", NOT "stance-aware behavior" — the
        // classifier remains stance-agnostic per spec §8.2.
        bool isMagicStance = stance == (uint)ChorEnum.MotionStance.Magic ||
                             (stance & 0xFFFFu) == (uint)ChorEnum.MotionStance.Magic;
        uint[] candidates;
        SwingLinkClass expectedClass;
        if (isMagicStance) {
            candidates = MagicCandidates;
            expectedClass = SwingLinkClass.Magic_Cast;
        } else if (CandidatesByHeight.TryGetValue(attackHeight, out var heightCands)) {
            candidates = heightCands;
            expectedClass = attackHeight switch {
                (uint)ChorEnum.AttackHeight.High => SwingLinkClass.Melee_High,
                (uint)ChorEnum.AttackHeight.Medium => SwingLinkClass.Melee_Medium,
                (uint)ChorEnum.AttackHeight.Low => SwingLinkClass.Melee_Low,
                _ => SwingLinkClass.Unknown,
            };
        } else {
            return new SwingClassifyResult(
                MotionTableId: motionTableId,
                Stance: stance,
                AttackHeight: attackHeight,
                ResolvedMotionCmd: null,
                LinkClass: SwingLinkClass.Unknown,
                AnimId: null,
                LowFrame: null,
                HighFrame: null,
                Framerate: null,
                OuterLinkCount: outerCount,
                InnerLinkCount: innerCount,
                FailureReason: $"unknown-attack-height (got {attackHeight}; expected 1/2/3 per ChorEnum.AttackHeight)",
                Source: SPEC_REF);
        }

        // Walk candidates, first hit wins. The inner dictionary key is the
        // FULL 32-bit retail MotionCommand (e.g. SlashHigh = 0x1000005B —
        // NOT just its LOW-16 substate 0x005B). Verified empirically: the
        // 0x09000001 SwordCombat link entry has inner keys including
        // 0x10000111, 0x10000110, 0x44000007 — values that only make sense
        // as full commands, not 16-bit substates. dats.xml schema declares
        // the dict key as `int` which the DRW C# library reads as the raw
        // little-endian uint cast to int.
        foreach (var candidate in candidates) {
            int innerKey = (int)candidate;
            if (linkData.MotionData != null && linkData.MotionData.TryGetValue(innerKey, out var md) && md != null) {
                // Invariant: anims.length == 1 per spec §1 (validated
                // across 5,455 retail entries).
                if (md.Anims == null || md.Anims.Count == 0) {
                    continue; // empty anim list — try next candidate
                }
                var anim = md.Anims[0];
                return new SwingClassifyResult(
                    MotionTableId: motionTableId,
                    Stance: stance,
                    AttackHeight: attackHeight,
                    ResolvedMotionCmd: candidate,
                    LinkClass: expectedClass,
                    AnimId: anim.AnimId.DataId,
                    LowFrame: anim.LowFrame,
                    HighFrame: anim.HighFrame,
                    Framerate: anim.Framerate,
                    OuterLinkCount: outerCount,
                    InnerLinkCount: innerCount,
                    FailureReason: null,
                    Source: SPEC_REF);
            }
        }

        // No candidate matched. Report the surface area for debugging.
        var availableInners = linkData.MotionData?.Keys.Select(k => $"0x{k:X8}").Take(8).ToList()
                              ?? new List<string>();
        return new SwingClassifyResult(
            MotionTableId: motionTableId,
            Stance: stance,
            AttackHeight: attackHeight,
            ResolvedMotionCmd: null,
            LinkClass: SwingLinkClass.Unknown,
            AnimId: null,
            LowFrame: null,
            HighFrame: null,
            Framerate: null,
            OuterLinkCount: outerCount,
            InnerLinkCount: innerCount,
            FailureReason:
                $"no-candidate-matched (checked {candidates.Length} cands; " +
                $"sample inner keys: [{string.Join(", ", availableInners)}])",
            Source: SPEC_REF);
    }

    /// <summary>
    /// Helper: walk every motion table in the loaded DAT and return the
    /// list of IDs whose <c>Links</c> dict is non-empty. The validator
    /// uses this as the basis for its 30-table deterministic sample.
    ///
    /// <para>
    /// This is a list-mode helper, not a parity check itself — the
    /// classifier is invoked per-table from the validator side.
    /// </para>
    /// </summary>
    public sealed record MotionTableInventoryEntry(
        uint Id, int CycleCount, int LinkCount, int ModifierCount);

    public List<MotionTableInventoryEntry> MotionInventory(string? datPath = null) {
        var resolvedDatPath = ResolveDatPath(datPath);
        using var dat = new DatDatabase(o => {
            o.FilePath = resolvedDatPath;
            o.AccessType = DatAccessType.Read;
            o.IndexCachingStrategy = IndexCachingStrategy.Never;
        });
        var result = new List<MotionTableInventoryEntry>();
        // MotionTable ID range: 0x09000000 - 0x0900FFFF per
        // dats.xml:3713-3716.
        for (uint id = 0x09000000u; id <= 0x0900FFFFu; id++) {
            if (!dat.TryGet<MotionTable>(id, out var mt) || mt == null) continue;
            result.Add(new MotionTableInventoryEntry(
                Id: mt.Id,
                CycleCount: mt.Cycles?.Count ?? 0,
                LinkCount: mt.Links?.Count ?? 0,
                ModifierCount: mt.Modifiers?.Count ?? 0));
        }
        return result;
    }
}
