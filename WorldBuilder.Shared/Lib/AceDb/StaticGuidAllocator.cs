using System;
using System.Collections.Generic;

namespace WorldBuilder.Shared.Lib.AceDb {
    /// <summary>
    /// E1 (wave-2) PR3 — canonical STATIC landblock-instance guid allocation, mirroring ACE's
    /// own static-guid policy (HARD CONSTRAINT 3 — respect the <c>0x70000xxx</c> range).
    ///
    /// <para>ACE allocates a static placement guid as
    /// <c>0x70000000 | (landblock &lt;&lt; 12) | seq</c> where <c>landblock</c> is the full 16-bit
    /// landblock id (the high 16 bits of <c>obj_Cell_Id</c>) and <c>seq</c> is a per-landblock
    /// sequence in <c>0x000..0xFFF</c> (4096 statics max per landblock). Verified against
    /// <c>ACE.Server/Command/Handlers/DeveloperContentCommands.cs:1246, 1503-1519</c>
    /// (<c>GetNextStaticGuid</c>) and the static loader
    /// <c>ACE.Database/ShardDatabase.cs:506-529</c> (<c>GetStaticObjectsByLandblock</c>:
    /// <c>min = (0x70000 | landblockId) &lt;&lt; 12</c>, <c>max = min | 0xFFF</c>) — algebraically the
    /// same window. The range constant matches <c>ACE.Entity/ObjectGuid.cs:29-30</c>
    /// (<c>StaticObjectMin=0x70000000</c>, <c>StaticObjectMax=0x7FFFFFFF</c>).</para>
    ///
    /// <para>WHY THIS MATTERS for Option B: the server only consults a per-placement biota when its
    /// <c>biota.id == landblock_instance.guid</c> AND that guid is in the static range
    /// (<c>WorldObjectFactory.cs</c> branch, SPEC §2.4). A WB-minted placement guid that is NOT
    /// static would never have its biota override read — the override would be a silent no-op. So
    /// Option B guids MUST be minted here.</para>
    /// </summary>
    public static class StaticGuidAllocator {
        /// <summary><c>ObjectGuid.StaticObjectMin</c> (ACE.Entity/ObjectGuid.cs:29).</summary>
        public const uint StaticObjectMin = 0x70000000u;
        /// <summary><c>ObjectGuid.StaticObjectMax</c> (ACE.Entity/ObjectGuid.cs:30).</summary>
        public const uint StaticObjectMax = 0x7FFFFFFFu;

        /// <summary>ACE <c>ObjectGuid.IsStatic</c> (ObjectGuid.cs:37).</summary>
        public static bool IsStatic(uint guid) => guid >= StaticObjectMin && guid <= StaticObjectMax;

        /// <summary>
        /// The first static guid for a landblock: <c>0x70000000 | (landblock &lt;&lt; 12)</c>
        /// (DeveloperContentCommands.cs:1246).
        /// </summary>
        public static uint FirstStaticGuid(ushort landblock) => StaticObjectMin | ((uint)landblock << 12);

        /// <summary>
        /// The last static guid for a landblock: <c>FirstStaticGuid | 0xFFF</c>
        /// (DeveloperContentCommands.cs:1330).
        /// </summary>
        public static uint MaxStaticGuid(ushort landblock) => FirstStaticGuid(landblock) | 0xFFFu;

        /// <summary>
        /// True when <paramref name="guid"/> is a valid static guid for <paramref name="landblock"/>
        /// (within that landblock's [first..max] window). This is the addressability check Option B
        /// needs: a biota whose id falls outside its landblock's static window will not be loaded by
        /// <c>ShardDatabase.GetStaticObjectsByLandblock</c>.
        /// </summary>
        public static bool IsInLandblockStaticRange(ushort landblock, uint guid) =>
            guid >= FirstStaticGuid(landblock) && guid <= MaxStaticGuid(landblock);

        /// <summary>
        /// Mint the next unused static guid for <paramref name="landblock"/>, skipping any guid in
        /// <paramref name="used"/>. Mirrors ACE's gap-finder (DeveloperContentCommands.cs:1503-1540):
        /// scan the per-landblock static window ascending and return the first free slot.
        /// Throws <see cref="InvalidOperationException"/> when the landblock's 4096-slot window is
        /// full (matching ACE's "reached the maximum # of static guids" guard).
        /// </summary>
        public static uint Allocate(ushort landblock, ISet<uint> used) {
            uint first = FirstStaticGuid(landblock);
            uint max = MaxStaticGuid(landblock);
            for (uint g = first; g <= max; g++) {
                if (!used.Contains(g)) {
                    used.Add(g);
                    return g;
                }
            }
            throw new InvalidOperationException(
                $"Landblock 0x{landblock:X4} has reached the maximum # of static guids (window 0x{first:X8}..0x{max:X8} full).");
        }
    }
}
