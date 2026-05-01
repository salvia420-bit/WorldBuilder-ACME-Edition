using DatReaderWriter;
using DatReaderWriter.Enums;
using DatReaderWriter.Options;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.Texture;
using WorldBuilder.Shared.Models;

namespace WorldBuilder.Terminal;

/// <summary>
/// A minimal, UI-free project manager that wires up the same core services
/// (DocumentDbContext → DocumentStorageService → DocumentManager → Project)
/// without any Avalonia, MVVM, or messaging dependencies.
///
/// Accepts an <see cref="ILoggerFactory"/> from the host so that logging
/// configuration (log levels, providers, stdin-mode suppression) is shared
/// with the outer DI container rather than duplicated.
/// </summary>
public sealed class HeadlessProjectManager : IDisposable {
    private ServiceProvider? _serviceProvider;
    private readonly ILoggerFactory _loggerFactory;
    private readonly ILogger<HeadlessProjectManager> _logger;

    public Project? CurrentProject { get; private set; }

    public HeadlessProjectManager(ILoggerFactory loggerFactory) {
        _loggerFactory = loggerFactory;
        _logger = loggerFactory.CreateLogger<HeadlessProjectManager>();
    }

    /// <summary>
    /// Loads a <c>.wbproj</c> file from disk and initialises all shared services
    /// (database, document manager, DAT reader) exactly as the UI does.
    /// Prefer <see cref="LoadProjectAsync"/> when calling from an async context.
    /// </summary>
    public void LoadProject(string projectFilePath) {
        LoadProjectAsync(projectFilePath).GetAwaiter().GetResult();
    }

    /// <summary>
    /// Async version of <see cref="LoadProject"/>. Avoids blocking on the
    /// EF Core database initialisation, making it safe to call from UI threads
    /// or other synchronisation contexts where <c>.GetAwaiter().GetResult()</c>
    /// could deadlock.
    /// </summary>
    public async Task LoadProjectAsync(string projectFilePath) {
        if (!File.Exists(projectFilePath)) {
            throw new FileNotFoundException($"Project file not found: {projectFilePath}");
        }

        // Dispose any previously loaded project
        Dispose();

        // Ensure client_highres.dat exists — the DatReaderWriter library requires
        // all four DAT files but highres is optional for WorldBuilder.  Create a
        // valid empty stub so that projects without it can still load.
        EnsureHighResDatExists(projectFilePath);

        var project = Project.FromDisk(projectFilePath);
        if (project == null) {
            throw new InvalidOperationException($"Failed to deserialise project: {projectFilePath}");
        }

        // Build a minimal DI container with only what the shared layer needs.
        // Logging is shared from the outer host container so that log-level
        // configuration (e.g. stdin-mode suppression) is respected everywhere.
        var services = new ServiceCollection();

        services.AddSingleton(_loggerFactory);
        services.AddSingleton(typeof(ILogger<>), typeof(Logger<>));

        services.AddDbContext<DocumentDbContext>(o => {
            o.UseSqlite($"DataSource={project.DatabasePath}");
        }, ServiceLifetime.Scoped);

        services.AddSingleton<IDocumentStorageService, DocumentStorageService>();
        services.AddSingleton<DocumentManager>();
        services.AddSingleton(project);

        _serviceProvider = services.BuildServiceProvider();

        // Wire up DocumentManager ↔ Project exactly as ProjectManager.InitializeProjectServices does
        var docManager = _serviceProvider.GetRequiredService<DocumentManager>();

        var cacheDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ACME WorldBuilder", "cache", project.Name);
        Directory.CreateDirectory(cacheDir);

        docManager.SetCacheDirectory(cacheDir);
        docManager.Dats = new DefaultDatReaderWriter(project.BaseDatDirectory, DatAccessType.Read);

        project.DocumentManager = docManager;

        // Mirror the GUI's TextureImportService wiring: on export, write all
        // CustomTextureStore entries (RenderSurface replacements, terrain replacements,
        // dungeon surfaces) into the export DAT through the Shared importer.
        project.OnExportCustomTextures = (writer, iteration) => {
            RenderSurfaceImporter.WriteCustomTexturesToDats(writer, project.CustomTextures, iteration);
        };

        // Run EF Core migrations / pragmas
        var dbCtx = _serviceProvider.GetRequiredService<DocumentDbContext>();
        await dbCtx.InitializeSqliteAsync();

        CurrentProject = project;
        _logger.LogInformation("Project loaded: {Name} ({Path})", project.Name, project.FilePath);
    }

    /// <summary>
    /// Exports DATs for the currently loaded project.
    /// </summary>
    public bool ExportDats(string exportDirectory, int? iteration = null) {
        if (CurrentProject == null) {
            throw new InvalidOperationException("No project is loaded. Use 'load' first.");
        }

        var portalIteration = iteration
            ?? CurrentProject.DocumentManager.Dats.Dats.Portal.Iteration.CurrentIteration + 1;

        _logger.LogInformation("Exporting DATs to {Dir} with iteration {Iter}",
            exportDirectory, portalIteration);

        var result = CurrentProject.ExportDats(exportDirectory, portalIteration);

        if (result) {
            _logger.LogInformation("Export completed successfully.");
        } else {
            _logger.LogError("Export returned failure.");
        }

        return result;
    }

    /// <summary>
    /// Creates a minimal valid <c>client_highres.dat</c> stub if the file is
    /// missing from the project's base DAT directory.  The DatReaderWriter
    /// library requires all four DAT files to be present, but the highres file
    /// is optional for WorldBuilder's terrain/object workflows.
    /// </summary>
    private void EnsureHighResDatExists(string projectFilePath) {
        var projectDir = Path.GetDirectoryName(Path.GetFullPath(projectFilePath)) ?? ".";
        var baseDatDir = Path.Combine(projectDir, "dats", "base");
        var highResPath = Path.Combine(baseDatDir, "client_highres.dat");
        if (File.Exists(highResPath)) return;

        _logger.LogInformation("Creating stub client_highres.dat (not present in project base DATs).");
        Directory.CreateDirectory(baseDatDir);
        using var db = new PortalDatabase(o => {
            o.AccessType = DatAccessType.ReadWrite;
            o.FilePath = highResPath;
        });
        db.BlockAllocator.InitNew(DatFileType.Portal, 1766222152);
    }

    public void Dispose() {
        CurrentProject?.Dispose();
        CurrentProject = null;
        _serviceProvider?.Dispose();
        _serviceProvider = null;
    }
}
