using DatReaderWriter;
using DatReaderWriter.Enums;
using DatReaderWriter.Options;

namespace DatReaderWriter.Extensions.Tests.Helpers;

/// <summary>
/// A disposable helper class that creates a temporary directory with initialized dat files
/// for testing DatEasyWriter and related functionality.
/// </summary>
public sealed class TempDatDirectory : IDisposable {
    private bool _disposed;

    /// <summary>
    /// The path to the temporary directory containing the dat files.
    /// </summary>
    public string DirectoryPath { get; }

    /// <summary>
    /// Path to the cell dat file (client_cell_1.dat)
    /// </summary>
    public string CellDatPath => Path.Combine(DirectoryPath, "client_cell_1.dat");

    /// <summary>
    /// Path to the portal dat file (client_portal.dat)
    /// </summary>
    public string PortalDatPath => Path.Combine(DirectoryPath, "client_portal.dat");

    /// <summary>
    /// Path to the highres dat file (client_highres.dat)
    /// </summary>
    public string HighResDatPath => Path.Combine(DirectoryPath, "client_highres.dat");

    /// <summary>
    /// Path to the local dat file (client_local_English.dat)
    /// </summary>
    public string LocalDatPath => Path.Combine(DirectoryPath, "client_local_English.dat");

    /// <summary>
    /// Creates a new temporary directory and initializes all 4 dat files.
    /// </summary>
    public TempDatDirectory() {
        DirectoryPath = Path.Combine(Path.GetTempPath(), $"DatTest_{Guid.NewGuid():N}");
        Directory.CreateDirectory(DirectoryPath);

        InitializeDatFiles();
    }

    private void InitializeDatFiles() {
        // Initialize Cell dat (subset: 1)
        using (var cellDb = new CellDatabase(o => {
            o.AccessType = DatAccessType.ReadWrite;
            o.FilePath = CellDatPath;
        })) {
            cellDb.BlockAllocator.InitNew(DatFileType.Cell, 1);
        }

        // Initialize Portal dat (subset: 0)
        using (var portalDb = new PortalDatabase(o => {
            o.AccessType = DatAccessType.ReadWrite;
            o.FilePath = PortalDatPath;
        })) {
            portalDb.BlockAllocator.InitNew(DatFileType.Portal, 0);
        }

        // Initialize HighRes dat (subset: 1766222152 - highres magic value)
        using (var highResDb = new PortalDatabase(o => {
            o.AccessType = DatAccessType.ReadWrite;
            o.FilePath = HighResDatPath;
        })) {
            highResDb.BlockAllocator.InitNew(DatFileType.Portal, 1766222152);
        }

        // Initialize Local dat (subset: 1)
        using (var localDb = new LocalDatabase(o => {
            o.AccessType = DatAccessType.ReadWrite;
            o.FilePath = LocalDatPath;
        })) {
            localDb.BlockAllocator.InitNew(DatFileType.Local, 1);
        }
    }

    /// <summary>
    /// Creates a DatCollection from this temporary directory opened in ReadWrite mode.
    /// The caller is responsible for disposing the returned DatCollection.
    /// </summary>
    public DatCollection CreateDatCollection(DatAccessType accessType = DatAccessType.ReadWrite) {
        return new DatCollection(DirectoryPath, accessType);
    }

    /// <summary>
    /// Disposes the temporary directory and all files within it.
    /// </summary>
    public void Dispose() {
        if (_disposed) return;
        _disposed = true;

        try {
            if (Directory.Exists(DirectoryPath)) {
                Directory.Delete(DirectoryPath, recursive: true);
            }
        }
        catch {
            // Ignore cleanup errors in tests
        }
    }
}
