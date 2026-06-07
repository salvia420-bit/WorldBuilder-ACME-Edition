namespace WorldBuilder.Shared.Lib.AceDb {
    /// <summary>
    /// WB.Terminal-local mirror of ACE's <c>ACE.Entity.Enum.Properties.PositionType</c>
    /// (<c>ACE.Entity/Enum/Properties/PositionType.cs:12-186</c>). Values match the ACE
    /// enum 1:1 so the underlying <see cref="ushort"/> can be written directly to the ACE
    /// <c>weenie_properties_position.position_Type</c> / <c>biota_properties_position.position_Type</c>
    /// column without any translation.
    ///
    /// Defined here (rather than referencing the ACE assembly) so WorldBuilder.Shared keeps
    /// zero dependency on the ACE server binaries; the values are the canonical contract.
    /// </summary>
    public enum PositionType : ushort {
        Undef = 0,
        Location = 1,
        Destination = 2,
        Instantiation = 3,
        Sanctuary = 4,
        /// <summary>[Ephemeral in ACE] home/base position an object first spawned at.</summary>
        Home = 5,
        ActivationMove = 6,
        Target = 7,
        LinkedPortalOne = 8,
        LastPortal = 9,
        PortalStorm = 10,
        CrashAndTurn = 11,
        PortalSummonLoc = 12,
        HouseBoot = 13,
        LastOutsideDeath = 14,
        LinkedLifestone = 15,
        LinkedPortalTwo = 16,
        Save1 = 17,
        Save2 = 18,
        Save3 = 19,
        Save4 = 20,
        Save5 = 21,
        Save6 = 22,
        Save7 = 23,
        Save8 = 24,
        Save9 = 25,
        RelativeDestination = 26,
        TeleportedCharacter = 27,
        PCAPRecordedLocation = 8040
    }
}
