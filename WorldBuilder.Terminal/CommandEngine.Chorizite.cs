using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using ChorCommon = Chorizite.Common.Enums;

namespace WorldBuilder.Terminal;

/// <summary>
/// Commands that absorb the vendored Chorizite C# libraries into WB.Terminal,
/// so the data-extraction work that would otherwise live in our Rust crates
/// can live next to the rest of the AC data oracle. See the porting plan
/// at <c>external/holtburger/apps/holtburger-web/CHORIZITE_PORTING_PLAN.md</c>
/// §12 for the strategic context.
///
/// Commands in this file:
///
///   - <c>chorizite-dump-enum-values</c> — reflect over the
///     <c>Chorizite.Common.Enums</c> namespace; emit int → name JSON for any
///     enum the porting plan flags as "missing from holtburger-common". Use
///     this in CI as a build-time data file so the Rust transcription stays
///     in sync with upstream.
///   - <c>chorizite-dump-world-object-taxonomy</c> — file-system parse the
///     vendored ACPlugin/API/WorldObjects/*.cs. Emit a JSON of the 24-class
///     hierarchy + ItemType/ObjectClass tags. The browser
///     plugins/world-objects/* skeleton consumes this directly.
///   - <c>chorizite-hash-string</c> — the classic AC string-key PJW hash
///     (Windows-1252; <c>result = c + (result &lt;&lt; 4)</c> per sbyte with a
///     conditional high-nibble fold on the 0xF0000000 trigger, masked to
///     28 bits). Used as the DAT EnumMapper / StringTable key. NOT the same
///     as the packet checksum (Hash32). See the DatReaderWriter.Extensions
///     reading guide §5 for why these are distinct, and ChoriziteHashString's
///     doc-comment for the fold-mask divergence from the vendored extension.
///   - <c>chorizite-dump-opcodes</c> — file-system parse the
///     <c>Chorizite.ACProtocol/Enums/{C2S,S2C}MessageType.generated.cs</c> and
///     <c>{GameAction,GameEvent}Type.generated.cs</c> + <c>GameMessageGroup</c>
///     enums. Emit a canonical { enumName: { "0xHEX": "name" } } JSON used by
///     the <c>holtburger-protocol</c> opcode_parity test to gate drift between
///     Chorizite.ACProtocol (upstream protocol oracle) and our Rust
///     <c>GameOpcode</c> / <c>GameActionOpcode</c> / <c>GameEventOpcode</c> enums.
/// </summary>
public partial class CommandEngine {

    /// <summary>
    /// Default path to the vendored chorizite tree. Walks up from the binary
    /// to find the WorldBuilder-ACME-Edition root, then appends
    /// <c>external/chorizite/</c>. Overridable via the <c>sourceRoot</c> arg
    /// on each command, which is useful for CI / containerized builds.
    /// </summary>
    public static string DefaultChoriziteSourceRoot {
        get {
            // Walk up from AppContext.BaseDirectory looking for a directory
            // that contains "external/chorizite". Bin is typically at
            // WorldBuilder-ACME-Edition/WorldBuilder.Terminal/bin/<conf>/net8.0/.
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir != null) {
                var candidate = Path.Combine(dir.FullName, "external", "chorizite");
                if (Directory.Exists(candidate)) return candidate;
                dir = dir.Parent;
            }
            // Fallback to known-good path; commands check existence anyway.
            return "/home/wbterminal/WorldBuilder-ACME-Edition/external/chorizite";
        }
    }

    // ─────────────────────────────────────────────────────────────────
    //  chorizite-dump-enum-values
    // ─────────────────────────────────────────────────────────────────

    public sealed record ChoriziteEnumDump(
        string EnumName,
        string UnderlyingType,
        bool IsFlags,
        IReadOnlyList<ChoriziteEnumMember> Members
    );

    public sealed record ChoriziteEnumMember(string Name, string ValueHex, long ValueDecimal);

    /// <summary>
    /// Curated allowlist of enums emitted by <c>chorizite-dump-enum-values</c>
    /// when called without an explicit <c>enumName</c>. As of Wave 2.C
    /// (2026-05-19) this covers all 65 enums declared in
    /// <c>external/chorizite/Chorizite.Common/Enums/*.cs</c> plus the
    /// ACProtocol-side <c>ObjectDescriptionFlag</c> — i.e. the empty-default
    /// "dump everything Chorizite.Common knows about".
    ///
    /// Names are matched against the Chorizite.Common.Enums namespace via
    /// reflection EXCEPT <c>ObjectDescriptionFlag</c>, which lives in
    /// <c>Chorizite.ACProtocol.Enums</c> and is sourced via regex-parse of
    /// the .generated.cs file (mirrors the ChoriziteDumpOpcodes pattern —
    /// see that method's class-level remarks for why we sourced ACProtocol's
    /// generated enums via regex when the original pattern landed; the
    /// ProjectReference exists now per W1.A0 but the parse path is kept for
    /// the one enum that's referenced from this curated set).
    ///
    /// The previous 11-entry allowlist (kept here for posterity) was:
    ///   AttackHeight, AttackType, ItemType, ObjectClass, SpellType,
    ///   SpellFlags, DamageType, MagicSchool, CombatMode,
    ///   ObjectDescriptionFlag, WeenieHeaderFlag.
    /// </summary>
    private static readonly string[] CuratedEnumAllowlist = new[] {
        "AllegianceOfficerLevel",
        "AmmoType",
        "AttackHeight",
        "AttackType",
        "AttributeId",
        "CharacterOptions1",
        "CharacterOptions2",
        "ClientAction",
        "CombatMode",
        "ContainerProperties",
        "CoverageMask",
        "CreatureType",
        "CurVitalId",
        "DamageType",
        "DatFileType",
        "EmoteCategory",
        "EmoteType",
        "EnchantmentTypeFlags",
        "EquipMask",
        "FriendsUpdateType",
        "Gender",
        "HeritageGroup",
        "HookType",
        "ImbuedEffectType",
        "ItemType",
        "MagicSchool",
        "MaterialType",
        "MotionCommand",
        "MotionStance",
        "ObjectClass",
        "ObjectDescriptionFlag",
        "ParentLocation",
        "PhysicsDescriptionFlag",
        "PhysicsState",
        "PlayScript",
        "Placement",
        "PlayerKillerStatus",
        "PortalBitmask",
        "PropertyAttribute2nd",
        "PropertyBool",
        "PropertyDataId",
        "PropertyFloat",
        "PropertyInstanceId",
        "PropertyInt",
        "PropertyInt64",
        "PropertyPosition",
        "PropertyString",
        "RadarBehavior",
        "RadarColor",
        "RootElementId",
        "SkillAdvancementClass",
        "SkillId",
        "Sound",
        "SpellBookFilterOptions",
        "SpellCategory",
        "SpellComponentType",
        "SpellFlags",
        "SpellType",
        "SummoningMastery",
        "UiEffects",
        "VitalId",
        "WeenieHeaderFlag",
        "WeenieHeaderFlag2",
        "WeenieType",
        "WieldRequirement",
        "WieldType",
    };

    /// <summary>
    /// Dump int → name for one or all enums in the curated set
    /// (<see cref="CuratedEnumAllowlist"/>). If <paramref name="enumName"/>
    /// is null/empty, returns every entry in the allowlist; otherwise
    /// returns the one matching member (case-insensitive). Reflection
    /// pulls from <c>Chorizite.Common.Enums</c>; <c>ObjectDescriptionFlag</c>
    /// is regex-parsed from the vendored ACProtocol .generated.cs source.
    /// </summary>
    public IReadOnlyList<ChoriziteEnumDump> ChoriziteDumpEnumValues(string? enumName) {
        // Find all public enums in the Chorizite.Common assembly.
        var assembly = typeof(ChorCommon.AttackHeight).Assembly;
        var allEnums = assembly.GetTypes()
            .Where(t => t.IsEnum && t.Namespace == "Chorizite.Common.Enums")
            .ToDictionary(t => t.Name, t => t, StringComparer.OrdinalIgnoreCase);

        IEnumerable<string> targetNames;
        if (string.IsNullOrWhiteSpace(enumName)) {
            targetNames = CuratedEnumAllowlist;
        } else {
            targetNames = CuratedEnumAllowlist.Where(n => string.Equals(n, enumName, StringComparison.OrdinalIgnoreCase));
            // Single-enum lookups also accept any Chorizite.Common enum
            // outside the curated allowlist — preserves the original
            // "query any vendored enum by name" affordance.
            if (!targetNames.Any() && allEnums.ContainsKey(enumName!)) {
                targetNames = new[] { allEnums[enumName!].Name };
            }
        }

        var result = new List<ChoriziteEnumDump>();
        foreach (var name in targetNames) {
            if (allEnums.TryGetValue(name, out var t)) {
                var underlying = Enum.GetUnderlyingType(t);
                var isFlags = t.GetCustomAttribute<FlagsAttribute>() != null;
                var members = new List<ChoriziteEnumMember>();
                foreach (var (memberName, value) in Enum.GetNames(t).Zip(Enum.GetValues(t).Cast<object>())) {
                    long longVal = Convert.ToInt64(value);
                    members.Add(new ChoriziteEnumMember(memberName, $"0x{longVal:X8}", longVal));
                }
                members.Sort((a, b) => a.ValueDecimal.CompareTo(b.ValueDecimal));
                result.Add(new ChoriziteEnumDump(t.Name, underlying.Name, isFlags, members));
            } else if (string.Equals(name, "ObjectDescriptionFlag", StringComparison.OrdinalIgnoreCase)) {
                // ACProtocol-sourced enum — regex-parse the .generated.cs.
                var dump = ParseAcProtocolFlagsEnum(
                    enumName: "ObjectDescriptionFlag",
                    relativeSourcePath: Path.Combine("Chorizite.ACProtocol", "Chorizite.ACProtocol", "Enums", "ObjectDescriptionFlag.generated.cs"));
                if (dump != null) result.Add(dump);
            }
        }
        return result;
    }

    /// <summary>
    /// Parse a [Flags] enum out of a Chorizite.ACProtocol .generated.cs file
    /// without taking a ProjectReference on Chorizite.ACProtocol (which
    /// targets netstandard2.0 and pulls non-trivial transitive deps).
    /// Mirrors the regex pattern used by <see cref="ChoriziteDumpOpcodes"/>.
    /// Returns null when the source file is absent so the caller can skip
    /// gracefully (e.g. CI without the ACProtocol clone vendored).
    /// </summary>
    private static ChoriziteEnumDump? ParseAcProtocolFlagsEnum(string enumName, string relativeSourcePath) {
        var sourcePath = Path.Combine(DefaultChoriziteSourceRoot, relativeSourcePath);
        if (!File.Exists(sourcePath)) return null;
        var src = File.ReadAllText(sourcePath);
        var memberRe = new Regex(
            @"^\s*(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*0x(?<hex>[0-9A-Fa-f]+)\s*,?\s*$",
            RegexOptions.Compiled | RegexOptions.Multiline);
        var members = new List<ChoriziteEnumMember>();
        foreach (Match m in memberRe.Matches(src)) {
            var memberName = m.Groups["name"].Value;
            long value = Convert.ToInt64(m.Groups["hex"].Value, 16);
            members.Add(new ChoriziteEnumMember(memberName, $"0x{value:X8}", value));
        }
        if (members.Count == 0) return null;
        members.Sort((a, b) => a.ValueDecimal.CompareTo(b.ValueDecimal));
        // ACProtocol generated enums declare `: uint` underlying type;
        // the source file emit is canonical.
        return new ChoriziteEnumDump(enumName, "UInt32", IsFlags: true, members);
    }

    // ─────────────────────────────────────────────────────────────────
    //  chorizite-dump-world-object-taxonomy
    // ─────────────────────────────────────────────────────────────────

    public sealed record ChoriziteWorldObjectTaxonomy(
        string SourceRoot,
        string VendoredHead,
        IReadOnlyList<ChoriziteWorldObjectClass> Classes
    );

    public sealed record ChoriziteWorldObjectClass(
        string Name,
        string? BaseClass,
        string RelativePath,
        IReadOnlyList<string> ItemTypeTags,
        IReadOnlyList<string> ObjectClassTags
    );

    /// <summary>
    /// Walk <c>external/chorizite/ACPlugin/API/WorldObjects/*.cs</c> and
    /// extract the class hierarchy. Returns name, base class, and any
    /// <c>ItemType</c>/<c>ObjectClass</c> enum members the class mentions
    /// (heuristic — grep the source for known enum tokens).
    ///
    /// This is the load-bearing data structure for the JS
    /// <c>plugins/world-objects/world_object_manager.js</c> skeleton.
    /// </summary>
    public ChoriziteWorldObjectTaxonomy ChoriziteDumpWorldObjectTaxonomy(string? sourceRoot) {
        var root = string.IsNullOrWhiteSpace(sourceRoot) ? DefaultChoriziteSourceRoot : sourceRoot;
        var pluginDir = Path.Combine(root, "ACPlugin");
        var worldObjectsDir = Path.Combine(pluginDir, "API", "WorldObjects");
        if (!Directory.Exists(worldObjectsDir)) {
            throw new DirectoryNotFoundException(
                $"ACPlugin/API/WorldObjects not found at {worldObjectsDir}. Run `git clone --depth 1 https://github.com/Chorizite/ACPlugin.git external/chorizite/ACPlugin` or pass `sourceRoot`.");
        }

        // Look up vendored HEAD via git rev-parse on the ACPlugin .git dir.
        string vendoredHead = "unknown";
        var gitDir = Path.Combine(pluginDir, ".git");
        if (Directory.Exists(gitDir)) {
            var headFile = Path.Combine(gitDir, "HEAD");
            if (File.Exists(headFile)) {
                var content = File.ReadAllText(headFile).Trim();
                if (content.StartsWith("ref:")) {
                    var refPath = Path.Combine(gitDir, content.Substring(4).Trim());
                    if (File.Exists(refPath)) vendoredHead = File.ReadAllText(refPath).Trim().Substring(0, 7);
                } else {
                    vendoredHead = content.Length >= 7 ? content.Substring(0, 7) : content;
                }
            }
        }

        // Also walk the API root for WorldObject.cs (the base) + Container.cs +
        // Character.cs (Container subclass, not under WorldObjects/).
        var rootFiles = new[] {
            Path.Combine(pluginDir, "API", "WorldObject.cs"),
        }.Where(File.Exists);
        var subFiles = Directory.GetFiles(worldObjectsDir, "*.cs");
        var allFiles = rootFiles.Concat(subFiles).OrderBy(f => Path.GetFileNameWithoutExtension(f));

        // Regex for class declarations.
        var classRe = new Regex(
            @"public\s+class\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)(\s*:\s*(?<base>[A-Za-z_][A-Za-z0-9_]*))?",
            RegexOptions.Compiled);

        var classes = new List<ChoriziteWorldObjectClass>();
        foreach (var file in allFiles) {
            var src = File.ReadAllText(file);
            var match = classRe.Match(src);
            if (!match.Success) continue;
            var name = match.Groups["name"].Value;
            var baseName = match.Groups["base"].Success ? match.Groups["base"].Value : null;

            // Heuristic: scan for ItemType.X and ObjectClass.X enum-member refs.
            var itemTypeTags = Regex.Matches(src, @"ItemType\.(?<n>[A-Za-z_][A-Za-z0-9_]*)")
                .Select(m => m.Groups["n"].Value).Distinct().OrderBy(x => x).ToList();
            var objectClassTags = Regex.Matches(src, @"ObjectClass\.(?<n>[A-Za-z_][A-Za-z0-9_]*)")
                .Select(m => m.Groups["n"].Value).Distinct().OrderBy(x => x).ToList();

            // RelativePath relative to repo root (one above sourceRoot).
            var repoRoot = Path.GetFullPath(Path.Combine(root, "..", ".."));
            var rel = Path.GetRelativePath(repoRoot, file).Replace(Path.DirectorySeparatorChar, '/');

            classes.Add(new ChoriziteWorldObjectClass(
                Name: name,
                BaseClass: baseName,
                RelativePath: rel,
                ItemTypeTags: itemTypeTags,
                ObjectClassTags: objectClassTags));
        }

        return new ChoriziteWorldObjectTaxonomy(
            SourceRoot: root,
            VendoredHead: vendoredHead,
            Classes: classes);
    }

    // ─────────────────────────────────────────────────────────────────
    //  chorizite-hash-string
    // ─────────────────────────────────────────────────────────────────

    public sealed record ChoriziteHashResult(string Input, string HashHex, uint HashDecimal);

    /// <summary>
    /// AC string-key hash — the classic PJW string hash used as the key for
    /// StringTable / EnumMapper / DBObj name lookups. Literal port of
    /// <c>Chorizite/DatReaderWriter.Extensions/StringHashExtensions.cs</c>
    /// (<c>ComputeHash</c>): long accumulator, input encoded as Windows-1252,
    /// each <c>sbyte</c> added with <c>result = c + (result &lt;&lt; 4)</c>, with an
    /// in-loop conditional 4-bit fold, and a final <c>(uint)</c> cast.
    ///
    /// DIVERGENCE FROM THE VENDORED SOURCE: the vendored
    /// <c>StringHashExtensions.ComputeHash</c> triggers its fold on
    /// <c>(result &amp; 0xF0000) != 0</c> (bit 16). That is an upstream bug — it
    /// folds far too early and produces hashes that do not match the keys
    /// stored in the DATs. The canonical AC hash (and DRW's own
    /// <c>StringBase.GetHashCode</c>, the documented classic AC PJW form,
    /// complete with the <c>0xFFFFFFFF -&gt; -2</c> guard) triggers on the high
    /// nibble <c>(hash &amp; 0xF0000000) != 0</c> (bit 28). We use the
    /// DAT-validated bit-28 trigger here. The two forms agree for any input
    /// of &lt;= 2 ASCII chars and for typical AC key strings, but diverge once
    /// the accumulator crosses bit 16 short of bit 28. Verified against the
    /// known oracle values: "Strength" -&gt; 0x0B8C4B08, "BootSpot" -&gt;
    /// 0x0669A3F4 (both reproduced by this bit-28 form; the rotate-XOR form
    /// previously here gave the wrong 0x0343802D / 0x09814680), and against
    /// real keys in client_local_English.dat StringTable 0x23000001
    /// (e.g. 0x052BA517 is a 28-bit key, consistent with this fold).
    ///
    /// NOT the same as <c>Hash32::compute</c> in holtburger_protocol::crypto
    /// (that's the packet checksum). See DatReaderWriter.Extensions
    /// READING_GUIDE.md §5 for the distinction.
    /// </summary>
    private static int _codePagesRegistered = 0;

    public ChoriziteHashResult ChoriziteHashString(string input) {
        if (input == null) throw new ArgumentNullException(nameof(input));
        // .NET 5+ doesn't ship Windows-1252 by default; opt in via CodePagesEncodingProvider.
        if (System.Threading.Interlocked.Exchange(ref _codePagesRegistered, 1) == 0) {
            Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        }
        var encoding = Encoding.GetEncoding(1252);
        var bytes = encoding.GetBytes(input);
        // Literal port of StringHashExtensions.ComputeHash, but with the
        // DAT-validated 0xF0000000 fold trigger (see <summary> divergence note).
        long result = 0;
        foreach (var b in bytes) {
            // Windows-1252 byte added as a signed char (mirrors `foreach (sbyte c in str)`).
            sbyte c = (sbyte)b;
            result = c + (result << 4);
            if ((result & 0xF0000000) != 0)
                result = (result ^ ((result & 0xF0000000) >> 24)) & 0x0FFFFFFF;
        }
        uint h = (uint)result;
        return new ChoriziteHashResult(input, $"0x{h:X8}", h);
    }

    // ─────────────────────────────────────────────────────────────────
    //  chorizite-classify (Entity-Completeness E.E — cross-port oracle)
    // ─────────────────────────────────────────────────────────────────

    public sealed record ChoriziteClassifyResult(
        uint ItemType,
        uint ObjDescFlags,
        uint WeenieFlags,
        string ObjectClass
    );

    /// <summary>
    /// C# port of the same algorithm as
    /// <c>plugins/world-objects/canonical_classify.js</c>. Both are 1:1
    /// ports of <c>ACPlugin/API/WorldObject.cs:344-411</c>; this command
    /// exists so the cross_port_parity.sh harness can drive identical
    /// payloads through both ports and assert byte-identical output. If
    /// the two ports ever disagree, ONE of them has drifted from the C#
    /// source — re-read WorldObject.cs to determine which.
    ///
    /// Inputs are bitfields (matching the wasm <c>EntityUpdate</c>'s
    /// <c>itemType</c>, <c>objDescFlags</c>, <c>weenieFlags</c> getters).
    /// Output is an <c>ObjectClass</c> enum-symbol name; <c>"Unknown"</c>
    /// when no algorithm rule matches.
    ///
    /// Per docs/entity-completeness-method.md §3, this is part of the
    /// canonical classification contract — the validator (E.D) relies on
    /// this being byte-identical to the JS port.
    /// </summary>
    public ChoriziteClassifyResult ChoriziteClassify(uint itemType, uint objDescFlags, uint weenieFlags) {
        // Bitflag constants — mirrors plugins/world-objects/canonical_classify.js
        // and Chorizite.Common/Enums/{ItemType,ObjectDescriptionFlag,WeenieHeaderFlag}.cs
        const uint IT_MELEE_WEAPON                  = 0x00000001u;
        const uint IT_ARMOR                         = 0x00000002u;
        const uint IT_CLOTHING                      = 0x00000004u;
        const uint IT_JEWELRY                       = 0x00000008u;
        const uint IT_CREATURE                      = 0x00000010u;
        const uint IT_FOOD                          = 0x00000020u;
        const uint IT_MONEY                         = 0x00000040u;
        const uint IT_MISC                          = 0x00000080u;
        const uint IT_MISSILE_WEAPON                = 0x00000100u;
        const uint IT_CONTAINER                     = 0x00000200u;
        const uint IT_USELESS                       = 0x00000400u;
        const uint IT_GEM                           = 0x00000800u;
        const uint IT_SPELL_COMPONENTS              = 0x00001000u;
        const uint IT_WRITABLE                      = 0x00002000u;
        const uint IT_KEY                           = 0x00004000u;
        const uint IT_CASTER                        = 0x00008000u;
        const uint IT_PORTAL                        = 0x00010000u;
        const uint IT_PROMISSORY_NOTE               = 0x00040000u;
        const uint IT_MANA_STONE                    = 0x00080000u;
        const uint IT_SERVICE                       = 0x00100000u;
        const uint IT_MAGIC_WIELDABLE               = 0x00200000u;
        const uint IT_CRAFT_COOKING_BASE            = 0x00400000u;
        const uint IT_CRAFT_ALCHEMY_BASE            = 0x00800000u;
        const uint IT_CRAFT_FLETCHING_BASE          = 0x02000000u;
        const uint IT_CRAFT_FLETCHING_INTERMEDIATE  = 0x08000000u;
        const uint IT_TINKERING_TOOL                = 0x20000000u;
        const uint IT_TINKERING_MATERIAL            = 0x40000000u;

        const uint ODF_OPENABLE                  = 0x00000001u;
        const uint ODF_INSCRIBABLE               = 0x00000002u;
        const uint ODF_STUCK                     = 0x00000004u;
        const uint ODF_PLAYER                    = 0x00000008u;
        const uint ODF_ATTACKABLE                = 0x00000010u;
        const uint ODF_BOOK                      = 0x00000100u;
        const uint ODF_VENDOR                    = 0x00000200u;
        const uint ODF_DOOR                      = 0x00001000u;
        const uint ODF_CORPSE                    = 0x00002000u;
        const uint ODF_LIFESTONE                 = 0x00004000u;
        const uint ODF_FOOD                      = 0x00008000u;
        const uint ODF_HEALER                    = 0x00010000u;
        const uint ODF_LOCKPICK                  = 0x00020000u;
        const uint ODF_PORTAL                    = 0x00040000u;
        const uint ODF_REQUIRES_PACK_SLOT        = 0x00800000u;
        const uint ODF_INCLUDES_SECOND_HEADER    = 0x04000000u;
        const uint ODF_BIND_STONE                = 0x08000000u;

        const uint WHF_SPELL                     = 0x00100000u;

        string objectClass = "Unknown";

        // PASS 1 — ItemType cascade (WorldObject.cs:347-372)
        if      ((itemType & IT_MELEE_WEAPON) != 0)                    objectClass = "MeleeWeapon";
        else if ((itemType & IT_ARMOR) != 0)                           objectClass = "Armor";
        else if ((itemType & IT_CLOTHING) != 0)                        objectClass = "Clothing";
        else if ((itemType & IT_JEWELRY) != 0)                         objectClass = "Jewelry";
        else if ((itemType & IT_CREATURE) != 0)                        objectClass = "Monster";
        else if ((itemType & IT_FOOD) != 0)                            objectClass = "Food";
        else if ((itemType & IT_MONEY) != 0)                           objectClass = "Money";
        else if ((itemType & IT_MISC) != 0)                            objectClass = "Misc";
        else if ((itemType & IT_MISSILE_WEAPON) != 0)                  objectClass = "MissileWeapon";
        else if ((itemType & IT_CONTAINER) != 0)                       objectClass = "Container";
        else if ((itemType & IT_USELESS) != 0)                         objectClass = "Bundle";
        else if ((itemType & IT_GEM) != 0)                             objectClass = "Gem";
        else if ((itemType & IT_SPELL_COMPONENTS) != 0)                objectClass = "SpellComponent";
        else if ((itemType & IT_KEY) != 0)                             objectClass = "Key";
        else if ((itemType & IT_CASTER) != 0)                          objectClass = "WandStaffOrb";
        else if ((itemType & IT_PORTAL) != 0)                          objectClass = "Portal";
        else if ((itemType & IT_PROMISSORY_NOTE) != 0)                 objectClass = "TradeNote";
        else if ((itemType & IT_MANA_STONE) != 0)                      objectClass = "ManaStone";
        else if ((itemType & IT_SERVICE) != 0)                         objectClass = "Services";
        else if ((itemType & IT_MAGIC_WIELDABLE) != 0)                 objectClass = "Plant";
        else if ((itemType & IT_CRAFT_COOKING_BASE) != 0)              objectClass = "BaseCooking";
        else if ((itemType & IT_CRAFT_ALCHEMY_BASE) != 0)              objectClass = "BaseAlchemy";
        else if ((itemType & IT_CRAFT_FLETCHING_BASE) != 0)            objectClass = "BaseFletching";
        else if ((itemType & IT_CRAFT_FLETCHING_INTERMEDIATE) != 0)    objectClass = "CraftedFletching";
        else if ((itemType & IT_TINKERING_TOOL) != 0)                  objectClass = "Ust";
        else if ((itemType & IT_TINKERING_MATERIAL) != 0)              objectClass = "Salvage";

        // PASS 2 — ObjectDescriptionFlag overrides (WorldObject.cs:375-388)
        if      ((objDescFlags & ODF_PLAYER) != 0)              objectClass = "Player";
        else if ((objDescFlags & ODF_VENDOR) != 0)              objectClass = "Vendor";
        else if ((objDescFlags & ODF_DOOR) != 0)                objectClass = "Door";
        else if ((objDescFlags & ODF_CORPSE) != 0)              objectClass = "Corpse";
        else if ((objDescFlags & ODF_LIFESTONE) != 0)           objectClass = "Lifestone";
        else if ((objDescFlags & ODF_FOOD) != 0)                objectClass = "Food";
        else if ((objDescFlags & ODF_HEALER) != 0)              objectClass = "HealingKit";
        else if ((objDescFlags & ODF_LOCKPICK) != 0)            objectClass = "Lockpick";
        else if ((objDescFlags & ODF_PORTAL) != 0)              objectClass = "Portal";
        else if ((objDescFlags & ODF_REQUIRES_PACK_SLOT) != 0)  objectClass = "Foci";
        else if ((objDescFlags & ODF_OPENABLE) != 0)            objectClass = "Container";
        else if ((objDescFlags & ODF_BIND_STONE) != 0)          objectClass = "Bindstone";

        // PASS 3a — Writable + Book disambiguation (WorldObject.cs:390-394)
        if (objectClass == "Unknown"
            && (itemType & IT_WRITABLE) != 0
            && (objDescFlags & ODF_BOOK) != 0) {
            if      ((objDescFlags & ODF_INSCRIBABLE) != 0) objectClass = "Journal";
            else if ((objDescFlags & ODF_STUCK) != 0)       objectClass = "Sign";
            else                                            objectClass = "Book";
        }

        // PASS 3b — Scroll discrimination (WorldObject.cs:396)
        if ((itemType & IT_WRITABLE) != 0 && (weenieFlags & WHF_SPELL) != 0) {
            objectClass = "Scroll";
        }

        // PASS 3c — Monster → Npc refinement (WorldObject.cs:398-401)
        if (objectClass == "Monster") {
            if ((objDescFlags & ODF_ATTACKABLE) == 0)              objectClass = "Npc";
            if ((objDescFlags & ODF_INCLUDES_SECOND_HEADER) != 0)  objectClass = "Npc";
        }

        // PASS 3d — Misc/Unknown + Stuck → Static (WorldObject.cs:403-407)
        if ((objectClass == "Misc" || objectClass == "Unknown")
            && (objDescFlags & ODF_STUCK) != 0) {
            objectClass = "Static";
        }

        return new ChoriziteClassifyResult(itemType, objDescFlags, weenieFlags, objectClass);
    }

    // ─────────────────────────────────────────────────────────────────
    //  chorizite-dump-opcodes (TASK 2E — ACProtocol vs holtburger parity)
    // ─────────────────────────────────────────────────────────────────

    public sealed record ChoriziteOpcodeDumpResult(
        string SourceRoot,
        string VendoredHead,
        string OutputPath,
        long FileSizeBytes,
        IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>> Enums
    );

    /// <summary>
    /// Parse Chorizite.ACProtocol opcode enums by regex over the .generated.cs
    /// source files. We DO NOT take a hard ProjectReference on
    /// <c>Chorizite.ACProtocol.csproj</c> because its <c>netstandard2.0</c>
    /// target adds non-trivial transitive deps (Medo.PcapRW, System.CodeDom)
    /// to the WB.Terminal binary; the source files themselves are stable
    /// canonical-form generated code from the upstream <c>protocol.xml</c>,
    /// and a regex extractor mirrors the file-walking pattern already in
    /// <see cref="ChoriziteDumpWorldObjectTaxonomy"/>.
    ///
    /// Targets five opcode enums:
    ///   - <c>C2SMessageType</c>     — C2S top-level opcodes
    ///   - <c>S2CMessageType</c>     — S2C top-level opcodes
    ///   - <c>GameActionType</c>     — C2S Ordered (0xF7B1) sub-opcodes
    ///   - <c>GameEventType</c>      — S2C Ordered (0xF7B0) sub-opcodes
    ///   - <c>GameMessageGroup</c>   — protocol fragment-group categories
    ///
    /// The JSON shape is intentionally flatter than
    /// <c>chorizite-dump-enum-values</c> — value-as-hex-string keys, name as
    /// scalar value — because the parity test asserts on (enum, hex, name)
    /// triples and doesn't need the underlyingType/isFlags metadata.
    /// </summary>
    public ChoriziteOpcodeDumpResult ChoriziteDumpOpcodes(string? sourceRoot, string? outputPath) {
        var root = string.IsNullOrWhiteSpace(sourceRoot) ? DefaultChoriziteSourceRoot : sourceRoot;
        var enumsDir = Path.Combine(root, "Chorizite.ACProtocol", "Chorizite.ACProtocol", "Enums");
        if (!Directory.Exists(enumsDir)) {
            throw new DirectoryNotFoundException(
                $"Chorizite.ACProtocol/Enums not found at {enumsDir}. Verify external/chorizite/Chorizite.ACProtocol is vendored.");
        }

        // Look up vendored HEAD via git rev-parse on the ACProtocol .git dir
        // if present, else fall back to the chorizite-root .git.
        string vendoredHead = "unknown";
        var gitDirCandidates = new[] {
            Path.Combine(root, "Chorizite.ACProtocol", ".git"),
            Path.Combine(root, ".git"),
        };
        foreach (var gitDir in gitDirCandidates) {
            if (!Directory.Exists(gitDir)) continue;
            var headFile = Path.Combine(gitDir, "HEAD");
            if (!File.Exists(headFile)) continue;
            var content = File.ReadAllText(headFile).Trim();
            if (content.StartsWith("ref:")) {
                var refPath = Path.Combine(gitDir, content.Substring(4).Trim());
                if (File.Exists(refPath)) {
                    var sha = File.ReadAllText(refPath).Trim();
                    vendoredHead = sha.Length >= 7 ? sha.Substring(0, 7) : sha;
                    break;
                }
            } else {
                vendoredHead = content.Length >= 7 ? content.Substring(0, 7) : content;
                break;
            }
        }

        // Regex: capture "Name = 0xHEX," entries inside an enum body.
        // The .generated.cs files have one entry per stanza separated by
        // blank lines, all of the form:
        //     Identifier_Name = 0xABCD,
        var memberRe = new Regex(
            @"^\s*(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*0x(?<hex>[0-9A-Fa-f]+)\s*,\s*$",
            RegexOptions.Compiled | RegexOptions.Multiline);

        var targetEnums = new[] {
            "C2SMessageType",
            "S2CMessageType",
            "GameActionType",
            "GameEventType",
            "GameMessageGroup",
        };

        // Use OrderedDictionary semantics — preserve target order in output.
        var enums = new Dictionary<string, IReadOnlyDictionary<string, string>>(
            capacity: targetEnums.Length);

        foreach (var enumName in targetEnums) {
            var file = Path.Combine(enumsDir, $"{enumName}.generated.cs");
            if (!File.Exists(file)) {
                throw new FileNotFoundException(
                    $"Expected ACProtocol enum source not found: {file}");
            }
            var src = File.ReadAllText(file);

            // Sort members by numeric value for stable diffing. Note: a few
            // enums (notably GameMessageGroup) have duplicate values — those
            // are folded by JSON key (last write wins on the hex key), which
            // is the correct behavior for an opcode→name lookup table.
            // We capture all values though, then resolve dupes by ordering.
            var captured = memberRe.Matches(src);
            var byHex = new SortedDictionary<long, (string Hex, string Name)>();
            foreach (Match m in captured) {
                var name = m.Groups["name"].Value;
                var hex = m.Groups["hex"].Value;
                long value = Convert.ToInt64(hex, 16);
                // Pad to 4 hex digits for opcodes < 0x10000; 8 for larger.
                // Pick width based on max value range — but the canonical
                // form used elsewhere (canonical_classify.js etc) zero-pads
                // to 4 for game opcodes since they fit in u16 visually.
                // Spec says "4-digit hex string keys" — so use 4-digit form
                // for values <= 0xFFFF, 8-digit for larger (xFFxxxx).
                string hexKey = value <= 0xFFFF
                    ? $"0x{value:X4}"
                    : $"0x{value:X8}";
                // If duplicate value, prefer the first name we saw (matches
                // C# enum reflection: Enum.GetName returns the FIRST member
                // with that value).
                if (!byHex.ContainsKey(value)) {
                    byHex[value] = (hexKey, name);
                }
            }
            if (byHex.Count == 0) {
                throw new InvalidDataException(
                    $"No enum members parsed from {file}. Check regex/sources.");
            }
            var membersByHex = new Dictionary<string, string>(byHex.Count);
            foreach (var kv in byHex.Values) {
                membersByHex[kv.Hex] = kv.Name;
            }
            enums[enumName] = membersByHex;
        }

        // Default output path matches the conventions for other chorizite-* JSON
        // dumps under the holtburger-web/data/chorizite/ tree.
        if (string.IsNullOrWhiteSpace(outputPath)) {
            // Walk up from sourceRoot two parents (external/chorizite/..) to
            // reach the repo root, then join the canonical holtburger data path.
            var repoRoot = Path.GetFullPath(Path.Combine(root, "..", ".."));
            outputPath = Path.Combine(repoRoot,
                "external", "holtburger", "apps", "holtburger-web",
                "data", "chorizite", "chorizite-acprotocol-opcodes.json");
        }

        // Serialize with stable formatting. We hand-write the JSON so the
        // output is deterministic (System.Text.Json reorders dictionary keys
        // alphabetically; we want enums in target order and hex keys in
        // numeric order). Keep it tidy with 2-space indent.
        var sb = new StringBuilder();
        sb.Append("{\n");
        sb.Append("  \"generatedBy\": \"WorldBuilder.Terminal chorizite-dump-opcodes\",\n");
        sb.Append("  \"source\": \"Chorizite.ACProtocol/Enums/*.generated.cs (vendored at external/chorizite/Chorizite.ACProtocol/)\",\n");
        sb.Append("  \"vendoredHead\": \"" + EscapeJson(vendoredHead) + "\",\n");
        sb.Append("  \"enums\": {\n");
        bool firstEnum = true;
        foreach (var enumName in targetEnums) {
            if (!firstEnum) sb.Append(",\n");
            firstEnum = false;
            sb.Append("    \"" + enumName + "\": {");
            var members = enums[enumName];
            // Re-sort the keys numerically for deterministic write order.
            var ordered = members.OrderBy(kv => Convert.ToInt64(kv.Key.Substring(2), 16)).ToList();
            bool firstMember = true;
            foreach (var kv in ordered) {
                if (!firstMember) sb.Append(",");
                firstMember = false;
                sb.Append("\n      \"" + kv.Key + "\": \"" + EscapeJson(kv.Value) + "\"");
            }
            sb.Append("\n    }");
        }
        sb.Append("\n  }\n}\n");

        var jsonText = sb.ToString();
        // Ensure the output directory exists.
        var outDir = Path.GetDirectoryName(outputPath);
        if (!string.IsNullOrEmpty(outDir) && !Directory.Exists(outDir)) {
            Directory.CreateDirectory(outDir);
        }
        File.WriteAllText(outputPath, jsonText);
        var fileSize = new FileInfo(outputPath).Length;

        return new ChoriziteOpcodeDumpResult(
            SourceRoot: root,
            VendoredHead: vendoredHead,
            OutputPath: outputPath,
            FileSizeBytes: fileSize,
            Enums: enums);
    }

    /// <summary>JSON-escape a string. Inputs here are enum-member names and
    /// short git SHAs, so we only need the minimal escapes.</summary>
    private static string EscapeJson(string s) {
        if (s.IndexOfAny(new[] { '\\', '"', '\n', '\r', '\t' }) < 0) return s;
        var sb = new StringBuilder(s.Length + 4);
        foreach (var c in s) {
            switch (c) {
                case '\\': sb.Append("\\\\"); break;
                case '"': sb.Append("\\\""); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default: sb.Append(c); break;
            }
        }
        return sb.ToString();
    }

    // ─────────────────────────────────────────────────────────────────
    //  chorizite-resolve-sound (TASK 1C — SoundTable.resolveSound parity)
    // ─────────────────────────────────────────────────────────────────

    public sealed record ChoriziteResolveSoundResult(
        uint SoundTableDid,
        uint SoundEnumValue,
        string? SoundEnumName,
        uint? WaveDid,
        float? Priority,
        float? Probability,
        float? Volume,
        int EntryCount,
        string Source
    );

    /// <summary>
    /// Deterministic 1:1 port of retail
    /// <c>SoundManager::GetSound</c> (<c>acclient.c:383433</c>) with
    /// <c>rand=0</c>. Resolves a <c>(SoundTable DID, Sound enum)</c> pair
    /// to one Wave DID, or null if the table has no mapping for that
    /// enum (or the entry list is empty / the leading <c>wave_did</c>
    /// is zero — both of which retail treats as "no sound").
    ///
    /// The retail algorithm (paraphrased from acclient.c:383443-383461):
    ///   1. <c>CSoundTable::Lookup(stype, &amp;stdata)</c> — hash-lookup
    ///      the SoundData for this Sound enum. If absent → return null.
    ///   2. <c>idx = (uint64)((num_entries - 1) * Random::RollDice(0, 1))</c>
    ///   3. Pick <c>data_[idx]</c>; final non-zero gate on
    ///      <c>sound_id_</c> or fall to <c>result = 0</c>.
    /// With <c>rand=0</c> the index is always 0, so the deterministic
    /// resolution = first entry's WaveDid.
    ///
    /// This is the canonical oracle the cross-port test harness pipes
    /// every Sound enum value through; the Rust
    /// <c>SoundTable::resolve_sound</c> and JS
    /// <c>resolveSoundFirst</c> (wasm export on <c>SoundTableJs</c>)
    /// must return byte-identical Wave DIDs for every input.
    ///
    /// Parses <paramref name="soundEnumInput"/> as either an integer
    /// (decimal or <c>0x</c>-prefixed hex) or a name from
    /// <c>Chorizite.Common.Enums.Sound</c> (case-insensitive).
    /// </summary>
    public ChoriziteResolveSoundResult ChoriziteResolveSound(
        uint soundTableDid,
        string soundEnumInput,
        string? datPath) {
        // ── Parse the Sound enum input ──
        // Accept integer (dec or 0xHEX), or a Chorizite.Common.Enums.Sound member name.
        uint soundEnumValue;
        string? soundEnumName = null;
        var trimmed = (soundEnumInput ?? "").Trim();
        if (string.IsNullOrEmpty(trimmed)) {
            throw new ArgumentException(
                "soundEnumInput must be an integer (dec or 0xHEX) or a Chorizite Sound enum name");
        }
        // First try parsing as an integer (0x…, decimal).
        bool parsedNum;
        if (trimmed.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) {
            parsedNum = uint.TryParse(
                trimmed.Substring(2),
                System.Globalization.NumberStyles.HexNumber,
                System.Globalization.CultureInfo.InvariantCulture,
                out soundEnumValue);
        } else {
            parsedNum = uint.TryParse(
                trimmed,
                System.Globalization.NumberStyles.Integer,
                System.Globalization.CultureInfo.InvariantCulture,
                out soundEnumValue);
        }
        if (!parsedNum) {
            // Fall back to name lookup on Chorizite.Common.Enums.Sound.
            var soundType = typeof(ChorCommon.Sound);
            if (Enum.TryParse(soundType, trimmed, ignoreCase: true, out var parsedEnum)
                && parsedEnum != null) {
                soundEnumValue = Convert.ToUInt32(parsedEnum);
                soundEnumName = parsedEnum.ToString();
            } else {
                throw new ArgumentException(
                    $"soundEnumInput '{soundEnumInput}' is neither a valid integer nor a Chorizite.Common.Enums.Sound member name");
            }
        }
        // If we parsed numerically, still attach the symbolic name when
        // the value is a known Sound enum member — useful for the JSON output.
        if (soundEnumName == null) {
            var defined = Enum.GetValues(typeof(ChorCommon.Sound))
                .Cast<object>()
                .FirstOrDefault(v => Convert.ToUInt32(v) == soundEnumValue);
            if (defined != null) soundEnumName = defined.ToString();
        }

        // ── Resolve a DAT path ──
        var resolvedDatPath = ResolveDatPath(datPath);

        // ── Open the DAT + load SoundTable + resolve via the retail algorithm ──
        using var dat = new DatReaderWriter.DatDatabase(o => {
            o.FilePath = resolvedDatPath;
            o.AccessType = DatReaderWriter.Options.DatAccessType.Read;
            o.IndexCachingStrategy = DatReaderWriter.Options.IndexCachingStrategy.Never;
        });

        if (!dat.TryGet<DatReaderWriter.DBObjs.SoundTable>(soundTableDid, out var stb) || stb == null) {
            return new ChoriziteResolveSoundResult(
                SoundTableDid: soundTableDid,
                SoundEnumValue: soundEnumValue,
                SoundEnumName: soundEnumName,
                WaveDid: null,
                Priority: null,
                Probability: null,
                Volume: null,
                EntryCount: 0,
                Source: $"acclient.c:383433 SoundManager::GetSound (rand=0); table 0x{soundTableDid:X8} not found in {resolvedDatPath}");
        }

        // The DatReaderWriter Sounds dictionary is keyed by `Sound`
        // (an int-backed enum). Cast our u32 to the strongly-typed key.
        var soundKey = (DatReaderWriter.Enums.Sound)(int)soundEnumValue;
        if (!stb.Sounds.TryGetValue(soundKey, out var soundData) || soundData == null) {
            return new ChoriziteResolveSoundResult(
                SoundTableDid: soundTableDid,
                SoundEnumValue: soundEnumValue,
                SoundEnumName: soundEnumName,
                WaveDid: null,
                Priority: null,
                Probability: null,
                Volume: null,
                EntryCount: 0,
                Source: $"acclient.c:383433 SoundManager::GetSound (rand=0); Sound enum 0x{soundEnumValue:X2} absent from table 0x{soundTableDid:X8}");
        }

        int entryCount = soundData.Entries?.Count ?? 0;
        if (entryCount == 0) {
            return new ChoriziteResolveSoundResult(
                SoundTableDid: soundTableDid,
                SoundEnumValue: soundEnumValue,
                SoundEnumName: soundEnumName,
                WaveDid: null,
                Priority: null,
                Probability: null,
                Volume: null,
                EntryCount: 0,
                Source: "acclient.c:383433 SoundManager::GetSound (rand=0); SoundData.Entries empty");
        }

        // rand=0 → idx 0; first entry. Retail's final non-null gate on
        // `sound_id_` translates to: a zero WaveDid is treated as "no sound"
        // (matches the `else result = 0` branch).
        var first = soundData.Entries!.First();
        if (first.Id == 0) {
            return new ChoriziteResolveSoundResult(
                SoundTableDid: soundTableDid,
                SoundEnumValue: soundEnumValue,
                SoundEnumName: soundEnumName,
                WaveDid: null,
                Priority: first.Priority,
                Probability: first.Probability,
                Volume: first.Volume,
                EntryCount: entryCount,
                Source: "acclient.c:383433 SoundManager::GetSound (rand=0); first entry WaveDid==0 (retail null-gate)");
        }

        return new ChoriziteResolveSoundResult(
            SoundTableDid: soundTableDid,
            SoundEnumValue: soundEnumValue,
            SoundEnumName: soundEnumName,
            WaveDid: first.Id,
            Priority: first.Priority,
            Probability: first.Probability,
            Volume: first.Volume,
            EntryCount: entryCount,
            Source: "acclient.c:383433 SoundManager::GetSound (rand=0); first entry");
    }

    /// <summary>
    /// Resolve a path to a portal DAT. Caller-supplied path wins;
    /// otherwise probe the canonical retail locations memory documents:
    ///   1. <c>~/ac_base_dats/client_portal.dat</c> (base bake oracle)
    ///   2. <c>dats/base/client_portal.dat</c> under the repo root
    /// Throws if nothing's findable so the JSON response reports a
    /// clear blocker instead of a deeper DatDatabase error.
    /// </summary>
    private static string ResolveDatPath(string? datPath) {
        if (!string.IsNullOrWhiteSpace(datPath)) {
            if (!File.Exists(datPath)) {
                throw new FileNotFoundException($"datPath not found: {datPath}");
            }
            return datPath!;
        }
        var candidates = new[] {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                         "ac_base_dats", "client_portal.dat"),
            "/home/wbterminal/ac_base_dats/client_portal.dat",
        };
        foreach (var c in candidates) {
            if (File.Exists(c)) return c;
        }
        throw new FileNotFoundException(
            "No client_portal.dat found. Pass `datPath` or place a base DAT at ~/ac_base_dats/client_portal.dat per memory feedback_base_dats_only_for_bake.");
    }
}
