namespace WorldBuilder.Shared.Lib.AceDb;

/// <summary>
/// One row of the ACE <c>encounter</c> table — the server-side pre-resolved
/// equivalent of the client terrain-byte spawn lookup. UNIQUE(landblock,
/// cell_X, cell_Y) ⇒ exactly one wcid per occupied cell; there is no per-cell
/// spawn-count RNG and no position jitter on this layer. Consumed by
/// <see cref="Spawn.SpawnGazetteerBuilder.BuildFromAceEncounters"/> which clamps
/// <c>cell_X/Y * 24</c> into LB-local coordinates and resolves surface Z.
/// </summary>
/// <param name="Landblock">
/// Owning landblock key (high byte = lbX, low byte = lbY). The DB column is a
/// signed <c>int(5)</c> but every value is &lt; 65,536 (verified MAX 0xFB80),
/// so the reader narrows it with a <c>(ushort)</c> cast.
/// </param>
/// <param name="WeenieClassId">Encounter weenie class id (often a generator).</param>
/// <param name="CellX">Encounter cell column 0..8 (×24 = LB-local X).</param>
/// <param name="CellY">Encounter cell row 0..8 (×24 = LB-local Y).</param>
public readonly record struct EncounterRecord(
    ushort Landblock,
    uint WeenieClassId,
    int CellX,
    int CellY);
