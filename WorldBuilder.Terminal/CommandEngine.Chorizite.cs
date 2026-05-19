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
/// Three classes of command live here:
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
///   - <c>chorizite-hash-string</c> — the AC string-key hash (4-bit shift-fold,
///     Windows-1252, 28-bit accumulator). Used as DAT EnumMapper / StringTable
///     key. NOT the same as the packet checksum (Hash32). See the
///     DatReaderWriter.Extensions reading guide §5 for why these are distinct.
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
    /// Dump int → name for one or all enums in <c>Chorizite.Common.Enums</c>.
    /// If <paramref name="enumName"/> is null/empty, returns all enums.
    /// </summary>
    public IReadOnlyList<ChoriziteEnumDump> ChoriziteDumpEnumValues(string? enumName) {
        // Find all public enums in the Chorizite.Common assembly.
        var assembly = typeof(ChorCommon.AttackHeight).Assembly;
        var allEnums = assembly.GetTypes()
            .Where(t => t.IsEnum && t.Namespace == "Chorizite.Common.Enums")
            .OrderBy(t => t.Name)
            .ToList();

        IEnumerable<Type> targets;
        if (string.IsNullOrWhiteSpace(enumName)) {
            targets = allEnums;
        } else {
            targets = allEnums.Where(t => string.Equals(t.Name, enumName, StringComparison.OrdinalIgnoreCase));
        }

        var result = new List<ChoriziteEnumDump>();
        foreach (var t in targets) {
            var underlying = Enum.GetUnderlyingType(t);
            var isFlags = t.GetCustomAttribute<FlagsAttribute>() != null;
            var members = new List<ChoriziteEnumMember>();
            foreach (var (name, value) in Enum.GetNames(t).Zip(Enum.GetValues(t).Cast<object>())) {
                long longVal = Convert.ToInt64(value);
                members.Add(new ChoriziteEnumMember(name, $"0x{longVal:X8}", longVal));
            }
            // Sort by numeric value for stable diffing
            members.Sort((a, b) => a.ValueDecimal.CompareTo(b.ValueDecimal));
            result.Add(new ChoriziteEnumDump(t.Name, underlying.Name, isFlags, members));
        }
        return result;
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
    /// AC string-key hash (per
    /// <c>Chorizite/DatReaderWriter.Extensions/StringHashExtensions.cs</c>).
    /// Used as the key for StringTable / EnumMapper / DBObj name lookups.
    /// Input is treated as Windows-1252; each byte XORs into a 28-bit
    /// accumulator with a 4-bit rotate-fold.
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
        uint h = 0;
        foreach (var b in bytes) {
            // Sign-extend the byte to int (mirrors the C# `sbyte` cast behavior).
            int signed = (sbyte)b;
            h = (uint)(((h << 4) | (h >> 28)) ^ (uint)signed);
        }
        h &= 0x0FFFFFFF;
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
}
